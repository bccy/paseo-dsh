/**
 * File snapshots for a rewind's file rollback: write-ahead backups of the files
 * the agent's **editing tools** touch.
 *
 * The rewind contract here is "undo what the agent changed in the workspace",
 * not "restore the whole working tree": the user's own edits, bash side effects
 * and files nobody touched must stay exactly as they are. That is the same
 * semantic Claude Code checkpointing and `dsh-rewind-plugin` use, and it works in
 * non-git directories and on dirty worktrees (where a git snapshot approach
 * would either refuse or destroy uncommitted work).
 *
 * How it works:
 *
 * - Before a tracked tool (`write`, `edit`) executes, the current file content is
 *   read and stored by content hash under the session's `objects/` directory. A
 *   missing file is recorded as `backup: null` (the rewind deletes it).
 * - After the tool succeeds, one line is appended to the session journal:
 *   `{anchorSeq, callId, path, backup, mode}`. `anchorSeq` is the newest human
 *   user message seq at execution time, so a rewind to seq T restores every path
 *   whose first post-T touch has a pre-touch state.
 * - A rewind marks restore actions: for each path, the *earliest* touch after T
 *   decides — restore that `before` content, or delete the file if it did not
 *   exist yet. A file touched several times after T is still restored once.
 * - Before overwriting a file during restore, the current content is copied into
 *   `rescue/` so a failed or regretted restore can be recovered by hand; the
 *   rescue path is reported in the receipt and the plugin log.
 *
 * Deliberately out of scope (documented): bash/pwsh side effects, edits made by
 * the user or another process, symlinks, and files above the size cap.
 *
 * @module dsh-bridge/file-snapshots
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { appendFile, chmod, copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

/** Tools whose file mutations are checkpointed. */
const TRACKED_TOOLS = new Set(['write', 'edit']);

/** Default cap for one snapshot; larger files are skipped and reported. */
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** How many journal lines are kept when a rewind prunes a session's history. */
const MAX_ANCHORS = 100;

/**
 * The path a tracked tool is about to mutate.
 *
 * DSH's `write`/`edit` tools take `file_path` (resolved by the filesystem
 * backend). Anything else is not a file mutation this module can checkpoint.
 * (`str_replace_editor` only exists in the legacy client UI vocabulary; DSH
 * core has no such tool, so tracking it here was dead code.)
 *
 * @param {{name?: string, arguments?: unknown}} exec
 * @returns {string | undefined}
 */
export function mutationPathOf(exec) {
  if (!TRACKED_TOOLS.has(exec?.name)) return undefined;
  const args = exec?.arguments;
  if (typeof args !== 'object' || args === null) return undefined;
  const path = /** @type {{file_path?: unknown}} */ (args).file_path;
  return typeof path === 'string' && path !== '' ? path : undefined;
}

/**
 * Whether one tool call is one whose mutations a rewind restores.
 *
 * @param {{name?: string}} exec
 * @returns {boolean}
 */
export function isTrackedTool(exec) {
  return TRACKED_TOOLS.has(exec?.name);
}

/**
 * Resolve a tool's `file_path` against the session cwd.
 *
 * @param {string} cwd
 * @param {string} filePath
 * @returns {string}
 */
export function resolveMutationPath(cwd, filePath) {
  return isAbsolute(filePath) ? resolvePath(filePath) : resolvePath(cwd, filePath);
}

/** @returns {string} the per-tool-operation pending key. */
function pendingKey(sessionId, callId) {
  return `${sessionId}:${callId}`;
}

/** Content-addressed object name, so identical snapshots share one file. */
function objectKey(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Write-ahead backups for one bridge process.
 *
 * All sessions of one bridge share one root; each session owns a directory with
 * a journal, content-addressed objects and rescue copies.
 */
export class FileSnapshots {
  /** Tail of the serialised journal-write chain. */
  #writeQueue;

  /**
   * @param {object} [options]
   * @param {string} [options.rootDir] - override for tests.
   * @param {number} [options.maxFileBytes] - override for tests.
   */
  constructor(options = {}) {
    this.rootDir = options.rootDir
      ?? process.env.DSH_PASEO_REWIND_DIR
      ?? join(homedir(), '.dsh', 'paseo-rewind');
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    /** `${sessionId}:${callId}` -> pending entry, between tools/execute and post-execute. */
    this.pending = new Map();
    /**
     * Serialises journal read-modify-write operations. Editing tools can run in
     * parallel inside one turn; two `appendFile`/rewrite operations interleaving
     * would corrupt the JSONL (the reader skips bad lines, i.e. silently loses
     * snapshots).
     */
    this.#writeQueue = Promise.resolve();
    this.warn = options.warn ?? ((line) => process.stderr.write(`[bridge] ${line}\n`));
  }

  /** Run one journal mutation after the previous one has settled. */
  #enqueue(task) {
    const run = this.#writeQueue.then(task, task);
    this.#writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** @param {string} sessionId */
  sessionDir(sessionId) {
    return join(this.rootDir, encodeURIComponent(sessionId));
  }

  /** @param {string} sessionId */
  journalPath(sessionId) {
    return join(this.sessionDir(sessionId), 'journal.jsonl');
  }

  /** @param {string} sessionId */
  objectsDir(sessionId) {
    return join(this.sessionDir(sessionId), 'objects');
  }

  /** @param {string} sessionId */
  rescueDir(sessionId) {
    return join(this.sessionDir(sessionId), 'rescue');
  }

  /**
   * Snapshot one file before the tool mutates it.
   *
   * Never throws: a rewind must not break the agent's turn. Failures and skips
   * are returned so the caller can log them; a skipped file simply will not be
   * restored (and the bridge says so in the receipt).
   *
   * @param {{sessionId: string, anchorSeq: number, callId: string, path: string}} input
   * @returns {Promise<{ok: true, skipped?: string} | {ok: false, error: string}>}
   */
  async capture(input) {
    const key = pendingKey(input.sessionId, input.callId);
    try {
      let info;
      try {
        info = await stat(input.path);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          // The tool is about to create the file: the rewind deletes it.
          this.pending.set(key, {
            anchorSeq: input.anchorSeq,
            callId: input.callId,
            path: input.path,
            backup: null,
            mode: null,
          });
          return { ok: true };
        }
        throw error;
      }
      if (!info.isFile()) {
        this.pending.set(key, { skip: 'not-a-regular-file', path: input.path });
        return { ok: true, skipped: 'not-a-regular-file' };
      }
      if (info.size > this.maxFileBytes) {
        this.pending.set(key, { skip: `larger than ${this.maxFileBytes} bytes`, path: input.path });
        return { ok: true, skipped: `larger than ${this.maxFileBytes} bytes` };
      }
      const bytes = await readFile(input.path);
      const backup = objectKey(bytes);
      const objects = this.objectsDir(input.sessionId);
      await mkdir(objects, { recursive: true });
      const target = join(objects, backup);
      try {
        await stat(target);
      } catch {
        await writeFile(target, bytes, { flag: 'wx' }).catch(async (error) => {
          // A concurrent capture of identical content may have won the race.
          if (error?.code !== 'EEXIST') throw error;
        });
      }
      this.pending.set(key, {
        anchorSeq: input.anchorSeq,
        callId: input.callId,
        path: input.path,
        backup,
        mode: info.mode & 0o777,
      });
      return { ok: true };
    } catch (error) {
      this.pending.delete(key);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Turn a successful tool call's pending snapshot into a durable journal line.
   *
   * Failures are logged and dropped: a failed write did not change the file.
   *
   * @param {{sessionId: string, callId: string}} input
   * @param {{isError?: boolean}} [result]
   * @returns {Promise<void>}
   */
  async commit(input, result) {
    const key = pendingKey(input.sessionId, input.callId);
    const pending = this.pending.get(key);
    this.pending.delete(key);
    if (pending === undefined) return;
    if (result?.isError === true) return;
    if (pending.skip !== undefined) {
      this.warn(`file snapshot skipped for ${String(pending.path ?? '')}: ${pending.skip}`);
      return;
    }
    try {
      await this.#enqueue(async () => {
        await mkdir(this.sessionDir(input.sessionId), { recursive: true });
        const line = `${JSON.stringify({
          anchorSeq: pending.anchorSeq,
          callId: pending.callId,
          path: pending.path,
          backup: pending.backup,
          mode: pending.mode,
          time: new Date().toISOString(),
        })}\n`;
        await appendFile(this.journalPath(input.sessionId), line, 'utf8');
      });
    } catch (error) {
      this.warn(`could not record a file snapshot for ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Drop a pending snapshot (tool failed, was cancelled, or never committed).
   *
   * @param {{sessionId: string, callId: string}} input
   */
  discard(input) {
    const key = pendingKey(input.sessionId, input.callId);
    const pending = this.pending.get(key);
    this.pending.delete(key);
    return pending;
  }

  /**
   * Read one session's journal, skipping (and reporting) unreadable lines.
   *
   * @param {string} sessionId
   * @returns {Promise<{entries: Array<{anchorSeq: number, callId?: string, path: string, backup: string | null, mode?: number | null}>, skippedLines: number}>}
   */
  async readJournal(sessionId) {
    let text;
    try {
      text = await readFile(this.journalPath(sessionId), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { entries: [], skippedLines: 0 };
      throw error;
    }
    const entries = [];
    let skippedLines = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        skippedLines += 1; // a truncated tail must not invalidate earlier snapshots
        continue;
      }
      if (typeof parsed?.anchorSeq !== 'number' || typeof parsed?.path !== 'string') {
        skippedLines += 1;
        continue;
      }
      entries.push({
        anchorSeq: parsed.anchorSeq,
        callId: typeof parsed.callId === 'string' ? parsed.callId : undefined,
        path: parsed.path,
        backup: typeof parsed.backup === 'string' ? parsed.backup : null,
        mode: typeof parsed.mode === 'number' ? parsed.mode : null,
      });
    }
    return { entries, skippedLines };
  }

  /**
   * Compute the files a rewind to `targetSeq` must restore or delete.
   *
   * Per path the *earliest* touch at or after `targetSeq` wins: a tool runs
   * after its user message was appended, so the anchor equals the message seq
   * of the turn that changed the file. A path whose first touch created the file
   * is deleted; a path last touched by an earlier turn is left alone.
   *
   * @param {string} sessionId
   * @param {number} targetSeq
   * @returns {Promise<{actions: Array<{path: string, backup: string | null, mode: number | null}>, skippedLines: number}>}
   */
  async planRestore(sessionId, targetSeq) {
    const { entries, skippedLines } = await this.readJournal(sessionId);
    /** @type {Map<string, {path: string, backup: string | null, mode: number | null}>} */
    const byPath = new Map();
    for (const entry of entries) {
      if (entry.anchorSeq < targetSeq) continue;
      if (byPath.has(entry.path)) continue;
      byPath.set(entry.path, { path: entry.path, backup: entry.backup, mode: entry.mode ?? null });
    }
    return { actions: [...byPath.values()], skippedLines };
  }

  /**
   * Apply restore actions, keeping a rescue copy of every file about to change.
   *
   * A single failed path does not stop the others; the caller reports the whole
   * outcome (the conversation rewind already happened).
   *
   * @param {string} sessionId
   * @param {Array<{path: string, backup: string | null, mode: number | null}>} actions
   * @returns {Promise<{restored: string[], deleted: string[], skipped: string[], failed: Array<{path: string, error: string}>, rescue: string[], rescueDir: string}>}
   */
  async restore(sessionId, actions) {
    const rescueDir = this.rescueDir(sessionId);
    const outcome = { restored: [], deleted: [], skipped: [], failed: [], rescue: [], rescueDir };
    let rescueCounter = 0;
    for (const action of actions) {
      try {
        const exists = await stat(action.path).then(() => true).catch((error) => {
          if (error?.code === 'ENOENT') return false;
          throw error;
        });
        if (action.backup === null) {
          if (!exists) {
            outcome.skipped.push(action.path);
            continue;
          }
          outcome.rescue.push(await this.#rescue(rescueDir, action.path, rescueCounter += 1));
          await unlink(action.path);
          outcome.deleted.push(action.path);
          continue;
        }
        const objectPath = join(this.objectsDir(sessionId), action.backup);
        const bytes = await readFile(objectPath);
        if (exists) outcome.rescue.push(await this.#rescue(rescueDir, action.path, rescueCounter += 1));
        await mkdir(dirname(action.path), { recursive: true });
        await writeFile(action.path, bytes);
        if (action.mode !== null) {
          try {
            await chmod(action.path, action.mode);
          } catch (error) {
            // The bytes are back; only the permission bits failed. Reporting the
            // path as failed would claim the content was not restored.
            this.warn(
              `file content restored but chmod failed for ${action.path}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        outcome.restored.push(action.path);
      } catch (error) {
        outcome.failed.push({ path: action.path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcome;
  }

  /**
   * Copy a file's current content into the rescue directory.
   *
   * @param {string} rescueDir
   * @param {string} path
   * @param {number} counter
   * @returns {Promise<string>} the rescue file's path.
   */
  async #rescue(rescueDir, path, counter) {
    await mkdir(rescueDir, { recursive: true });
    // Timestamp + counter: two rewinds restoring the same path must not
    // overwrite the earlier rescue copy (it is the manual-recovery material).
    const name = `${Date.now()}-${counter}-${encodeURIComponent(path)}`;
    const target = join(rescueDir, name);
    await copyFile(path, target, fsConstants.COPYFILE_FICLONE ?? 0);
    return target;
  }

  /**
   * Keep journal entries that can still matter for a future rewind.
   *
   * Entries **after** the target belong to turns that were just withdrawn and
   * are dropped. Entries at the target stay: their backup is the state before
   * the target turn, which a later rewind to an earlier message may still need
   * as the earliest post-target state for that path (`file-snapshot-check`
   * asserts this cutoff explicitly). Rewriting the journal is serialised with
   * the appends so a concurrent tool commit cannot interleave.
   *
   * @param {string} sessionId
   * @param {number} targetSeq
   * @returns {Promise<{kept: number, dropped: number}>}
   */
  async prune(sessionId, targetSeq) {
    return this.#enqueue(async () => {
      const { entries } = await this.readJournal(sessionId);
      const kept = entries.filter((entry) => entry.anchorSeq <= targetSeq);
      const dropped = entries.length - kept.length;
      if (dropped === 0) return { kept: kept.length, dropped: 0 };
      const lines = kept.map((entry) => `${JSON.stringify({
        anchorSeq: entry.anchorSeq,
        ...(entry.callId === undefined ? {} : { callId: entry.callId }),
        path: entry.path,
        backup: entry.backup,
        mode: entry.mode,
        time: new Date().toISOString(),
      })}\n`).join('');
      await mkdir(this.sessionDir(sessionId), { recursive: true });
      await writeFile(this.journalPath(sessionId), lines, 'utf8');
      return { kept: kept.length, dropped };
    });
  }

  /**
   * Trim a session's journal to the newest `MAX_ANCHORS` anchors (unbounded
   * growth would otherwise make every prompt append forever).
   *
   * @param {string} sessionId
   * @returns {Promise<{dropped: number}>}
   */
  async trim(sessionId) {
    return this.#enqueue(async () => {
      const { entries } = await this.readJournal(sessionId);
      const anchors = [...new Set(entries.map((entry) => entry.anchorSeq))].sort((left, right) => left - right);
      if (anchors.length <= MAX_ANCHORS) return { dropped: 0 };
      const cutoff = anchors[anchors.length - MAX_ANCHORS];
      const kept = entries.filter((entry) => entry.anchorSeq >= cutoff);
      const lines = kept.map((entry) => `${JSON.stringify({
        anchorSeq: entry.anchorSeq,
        ...(entry.callId === undefined ? {} : { callId: entry.callId }),
        path: entry.path,
        backup: entry.backup,
        mode: entry.mode,
        time: new Date().toISOString(),
      })}\n`).join('');
      await writeFile(this.journalPath(sessionId), lines, 'utf8');
      return { dropped: entries.length - kept.length };
    });
  }

  /**
   * Delete content objects the journal no longer references.
   *
   * Pruning/trimming only rewrites the index; without this the `objects/`
   * directory grew forever (each edit stored a full before-image). Only hashes
   * referenced by the current journal are kept, so this is safe after
   * prune/trim and cheap: one journal read plus one directory listing.
   *
   * @param {string} sessionId
   * @returns {Promise<{removed: number}>}
   */
  async collectGarbage(sessionId) {
    return this.#enqueue(async () => {
      const { entries } = await this.readJournal(sessionId);
      const referenced = new Set(entries.map((entry) => entry.backup).filter((backup) => typeof backup === 'string'));
      let names;
      try {
        names = await readdir(this.objectsDir(sessionId));
      } catch (error) {
        if (error?.code === 'ENOENT') return { removed: 0 };
        throw error;
      }
      let removed = 0;
      for (const name of names) {
        if (referenced.has(name)) continue;
        try {
          await unlink(join(this.objectsDir(sessionId), name));
          removed += 1;
        } catch (error) {
          this.warn(`could not remove unreferenced snapshot object ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { removed };
    });
  }
}

export { DEFAULT_MAX_FILE_BYTES, MAX_ANCHORS, TRACKED_TOOLS };
