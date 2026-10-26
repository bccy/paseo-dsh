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
 *   `{anchorSeq, captureSeq, callId, path, backup, mode}`. `anchorSeq` is the
 *   delegated turn's dispatch anchor or, for the root session, the newest human
 *   user message seq at execution time. `captureSeq` is the process-local
 *   capture order, so concurrent parent/child edits of one path restore the
 *   state before the *first* touch, not the first *commit*.
 * - A rewind marks restore actions: for each path, the earliest capture after T
 *   decides — restore that `before` content, or delete the file if it did not
 *   exist yet. A file touched several times after T is still restored once.
 * - Before overwriting a file during restore, the current content is copied into
 *   `rescue/` so a failed or regretted restore can be recovered by hand; the
 *   rescue path is reported in the receipt and the plugin log. That copy is the
 *   content the rewind is about to replace (already including agent edits), not
 *   the pre-edit backup — the backup stays in the journal until a rewind with no
 *   failures prunes it.
 *
 * Trust boundaries: the journal is local state, but a rewind writes and deletes
 * paths it names, so `readJournal` only accepts absolute paths and content
 * hashes, and `restore` refuses symlinks and non-regular files instead of
 * following them out of the workspace.
 *
 * Deliberately out of scope (documented): bash/pwsh side effects, edits made by
 * the user or another process, symlinked targets, and files above the size cap.
 *
 * @module dsh-bridge/file-snapshots
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { appendFile, chmod, copyFile, lstat, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

/**
 * Tools whose file mutations are checkpointed.
 *
 * These two are DSH's own filesystem tools and name the file with `file_path`.
 * A profile may also compose a third one, `str_replace_editor`, which is
 * tracked separately below because it names the file differently.
 */
const TRACKED_TOOLS = new Set(['write', 'edit']);

/**
 * `@deepseek-ai/dsh-tool-str-replace-editor`'s model-facing tool.
 *
 * A first-party 0.2.1-rc.2 package: the base/web bundles do not mount it, but a
 * deployment can, and its tool name is `str_replace_editor` (not a client-UI
 * artifact — an earlier comment here claimed DSH had no such tool and dropped
 * tracking, which would have let a `both` rewind report success while leaving
 * every file that tool touched modified). Its commands name the file with
 * `path`, never `file_path`, which is why it cannot share {@link TRACKED_TOOLS}.
 */
const STR_REPLACE_EDITOR = 'str_replace_editor';

/**
 * The `str_replace_editor` commands that write.
 *
 * `view` is read-only: journaling it would record a read as "the edit that
 * announces this file's latest state", so a rewind could rewrite a file that
 * nothing had changed. An unknown command is treated the same way (not a write).
 */
const STR_REPLACE_EDITOR_WRITES = new Set(['create', 'str_replace', 'insert']);

/** Default cap for one snapshot; larger files are skipped and reported. */
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Hard cap on distinct journal anchors.
 *
 * It is a safety bound, not the semantic cutoff: `trim` already drops entries
 * that no future rewind can reach (below the oldest rewindable human message).
 * A session that exceeds this many *reachable* anchors keeps the newest ones and
 * warns — the trimmed range becomes unrecoverable, which is loudly reported
 * rather than silently losing a restore.
 */
const MAX_ANCHORS = 1000;

/**
 * Minimum age before an unreferenced object may be garbage-collected.
 *
 * A capture writes its object before the tool commits the journal line, so a
 * rewind racing a still-running edit could GC an object whose journal line does
 * not exist yet. The grace period (plus excluding pending snapshots) closes that
 * window; five minutes is far longer than any capture-to-commit gap.
 */
const GC_GRACE_MS = 5 * 60 * 1000;

/**
 * Process-wide monotonic counter that keeps rescue copy names unique.
 *
 * A rescue copy is the *manual-recovery material*: it holds the content the rewind
 * is about to replace, and nothing else on disk keeps it. A later rewind that
 * overwrote it would destroy the only copy of what the user had — silently, since
 * the receipt only reports the directory. The name therefore has to be unique per
 * copy, and `Date.now()` alone is not enough: two rewinds of one path inside the
 * same millisecond get the same stamp. A counter *inside* `restore` does not fix
 * it either — it restarts at 1 on every call, so the two names come out identical
 * (this is what the old code did while its comment claimed the opposite).
 *
 * This counter is module-level, so it is strictly increasing for the whole
 * process and the second field differs even when the stamp repeats. The stamp
 * stays in the name so a human can still tell *when* the copy was taken; the
 * sequence tells the copies of one millisecond apart.
 *
 * Why not `copyFile` with `COPYFILE_EXCL` + retry: that replaces a naming
 * invariant with an extra failure path inside the one copy whose purpose is not
 * to lose data — a rescue that throws is reported as a failed restore. A counter
 * that cannot repeat is the simpler contract, and it leaves the `COPYFILE_FICLONE`
 * fast path untouched.
 *
 * Known boundary (accepted): uniqueness *across processes* still rests on the
 * timestamp, because a restarted bridge starts this counter at 1 again. Reusing a
 * name that way needs a restart **and** a backwards clock step landing in the same
 * millisecond, and a rescue directory belongs to one session, which one bridge
 * process owns at a time.
 */
let rescueSeq = 0;

/**
 * The path a tracked tool is about to mutate.
 *
 * DSH's `write`/`edit` take `file_path`; `str_replace_editor` takes `path` and
 * only its three writing commands count — a `view` (or an unknown command) is not
 * a mutation this module can checkpoint, and journaling it would let a rewind
 * treat a read as an edit. Anything else returns `undefined`, which the caller
 * treats as "nothing to snapshot".
 *
 * @param {{name?: string, arguments?: unknown}} exec
 * @returns {string | undefined}
 */
export function mutationPathOf(exec) {
  const args = exec?.arguments;
  if (typeof args !== 'object' || args === null) return undefined;
  if (exec?.name === STR_REPLACE_EDITOR) {
    const command = /** @type {{command?: unknown}} */ (args).command;
    if (typeof command !== 'string' || !STR_REPLACE_EDITOR_WRITES.has(command)) return undefined;
    const editorPath = /** @type {{path?: unknown}} */ (args).path;
    return typeof editorPath === 'string' && editorPath !== '' ? editorPath : undefined;
  }
  if (!TRACKED_TOOLS.has(exec?.name)) return undefined;
  const path = /** @type {{file_path?: unknown}} */ (args).file_path;
  return typeof path === 'string' && path !== '' ? path : undefined;
}

/**
 * Whether one tool *name* is one whose mutations a rewind restores.
 *
 * Name-level only: the argument-level check (which command of
 * `str_replace_editor`, whether the path is present at all) lives in
 * {@link mutationPathOf}, and a tracked name with no usable path simply yields
 * no snapshot.
 *
 * @param {{name?: string}} exec
 * @returns {boolean}
 */
export function isTrackedTool(exec) {
  return TRACKED_TOOLS.has(exec?.name) || exec?.name === STR_REPLACE_EDITOR;
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

/**
 * The in-memory key of one pending snapshot.
 *
 * The key must identify the *executing* session, not the session whose journal
 * receives the entry: a parent and a delegated child both journal into the root
 * session while the same callId namespace is provider-minted, so keying by the
 * owner alone would let one capture overwrite the other's pending state.
 *
 * @param {{sessionId: string, callId: string, pendingKey?: string}} input
 * @returns {string}
 */
function pendingKeyOf(input) {
  return typeof input?.pendingKey === 'string' && input.pendingKey !== ''
    ? input.pendingKey
    : pendingKey(input.sessionId, input.callId);
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
   * Monotonic capture order for journal entries.
   *
   * Journal lines are appended in *commit* order, which a parallel parent/child
   * edit can invert: both capture the same path, the child commits first. The
   * rewind wants the state before the earliest *capture* after the target, so
   * the order has to travel with the entry.
   */
  #captureSequence = 0;

  /**
   * @param {object} [options]
   * @param {string} [options.rootDir] - override for tests.
   * @param {number} [options.maxFileBytes] - override for tests.
   * @param {number} [options.gcGraceMs] - override for tests.
   * @param {(line: string) => void} [options.warn] - override for tests.
   */
  constructor(options = {}) {
    // Follow DSH_HOME like the rest of the plugin/bootstrap chain: a deployment
    // that relocates its DSH home must not have rewind state written to the
    // default one (possibly unwritable, possibly another user's).
    this.rootDir = options.rootDir
      ?? process.env.DSH_PASEO_REWIND_DIR
      ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'paseo-rewind');
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.gcGraceMs = options.gcGraceMs ?? GC_GRACE_MS;
    /** Pending key (see `pendingKeyOf`) -> snapshot entry between execute and post-execute. */
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
   * @param {{sessionId: string, anchorSeq: number, callId: string, path: string, pendingKey?: string}} input
   * @returns {Promise<{ok: true, skipped?: string} | {ok: false, error: string}>}
   */
  async capture(input) {
    const key = pendingKeyOf(input);
    const captureSeq = (this.#captureSequence += 1);
    try {
      let info;
      try {
        info = await stat(input.path);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          // The tool is about to create the file: the rewind deletes it.
          this.pending.set(key, {
            anchorSeq: input.anchorSeq,
            captureSeq,
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
        this.pending.set(key, { skip: 'not-a-regular-file', path: input.path, captureSeq });
        return { ok: true, skipped: 'not-a-regular-file' };
      }
      if (info.size > this.maxFileBytes) {
        this.pending.set(key, { skip: `larger than ${this.maxFileBytes} bytes`, path: input.path, captureSeq });
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
        captureSeq,
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
   * @param {{sessionId: string, callId: string, pendingKey?: string}} input
   * @param {{isError?: boolean}} [result]
   * @returns {Promise<void>}
   */
  async commit(input, result) {
    const key = pendingKeyOf(input);
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
          ...(typeof pending.captureSeq === 'number' ? { captureSeq: pending.captureSeq } : {}),
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
   * @param {{sessionId: string, callId: string, pendingKey?: string}} input
   */
  discard(input) {
    const key = pendingKeyOf(input);
    const pending = this.pending.get(key);
    this.pending.delete(key);
    return pending;
  }

  /**
   * Read one session's journal, skipping (and reporting) unusable lines.
   *
   * The journal is local state, but a rewind writes and deletes every path it
   * names, so a line is only accepted when it is an absolute path and carries a
   * content hash (or an explicit `null` for "did not exist"). Anything else — a
   * relative path, a traversal-prone `backup`, a truncated tail — is skipped and
   * counted, never acted on.
   *
   * @param {string} sessionId
   * @returns {Promise<{entries: Array<{anchorSeq: number, captureSeq?: number, callId?: string, path: string, backup: string | null, mode?: number | null}>, skippedLines: number}>}
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
      const backupValid = parsed?.backup === null
        || (typeof parsed?.backup === 'string' && /^[0-9a-f]{64}$/.test(parsed.backup));
      if (typeof parsed?.anchorSeq !== 'number'
        || typeof parsed?.path !== 'string'
        || !isAbsolute(parsed.path)
        || !backupValid) {
        skippedLines += 1;
        continue;
      }
      entries.push({
        anchorSeq: parsed.anchorSeq,
        captureSeq: typeof parsed.captureSeq === 'number' ? parsed.captureSeq : undefined,
        callId: typeof parsed.callId === 'string' ? parsed.callId : undefined,
        path: parsed.path,
        backup: parsed.backup,
        mode: typeof parsed.mode === 'number' ? parsed.mode : null,
      });
    }
    return { entries, skippedLines };
  }

  /**
   * Compute the files a rewind to `targetSeq` must restore or delete.
   *
   * Per path the earliest *capture* at or after `targetSeq` decides. Journal
   * lines are appended in commit order, and a parallel parent/child edit can
   * commit in the opposite order from its captures, so the recorded
   * `captureSeq` is authoritative; legacy lines without one keep the old
   * first-in-file behavior (they predate the sequence and are effectively
   * earlier than any numbered capture).
   *
   * @param {string} sessionId
   * @param {number} targetSeq
   * @returns {Promise<{actions: Array<{path: string, backup: string | null, mode: number | null}>, skippedLines: number}>}
   */
  async planRestore(sessionId, targetSeq) {
    const { entries, skippedLines } = await this.readJournal(sessionId);
    /** @type {Map<string, {path: string, backup: string | null, mode: number | null, rank: number}>} */
    const byPath = new Map();
    for (const entry of entries) {
      if (entry.anchorSeq < targetSeq) continue;
      // Legacy lines have no capture order; they are older than any numbered
      // capture written by this build, so they rank first.
      const rank = typeof entry.captureSeq === 'number' ? entry.captureSeq : Number.NEGATIVE_INFINITY;
      const current = byPath.get(entry.path);
      if (current !== undefined && current.rank <= rank) continue;
      byPath.set(entry.path, {
        path: entry.path,
        backup: entry.backup,
        mode: entry.mode ?? null,
        rank,
      });
    }
    return {
      actions: [...byPath.values()].map(({ path, backup, mode }) => ({ path, backup, mode })),
      skippedLines,
    };
  }

  /**
   * Apply restore actions, keeping a rescue copy of every file about to change.
   *
   * A single failed path does not stop the others; the caller reports the whole
   * outcome (the conversation rewind already happened).
   *
   * A rewind must not be a way around the sandbox: a symlink or special file is
   * skipped, never followed, so a journal entry (or the tool path it recorded)
   * cannot make the restore write through a link into something else.
   *
   * @param {string} sessionId
   * @param {Array<{path: string, backup: string | null, mode: number | null}>} actions
   * @returns {Promise<{restored: string[], deleted: string[], skipped: string[], failed: Array<{path: string, error: string}>, rescue: string[], rescueDir: string}>}
   */
  async restore(sessionId, actions) {
    const rescueDir = this.rescueDir(sessionId);
    const outcome = { restored: [], deleted: [], skipped: [], failed: [], rescue: [], rescueDir };
    for (const action of actions) {
      try {
        let info;
        try {
          info = await lstat(action.path);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          info = undefined;
        }
        if (info !== undefined && !info.isFile()) {
          // Symlink (lstat never follows), directory, socket …: the rewind does
          // not touch it. Reported so the receipt is not a silent claim.
          outcome.skipped.push(action.path);
          continue;
        }
        const exists = info !== undefined;
        if (action.backup === null) {
          if (!exists) {
            outcome.skipped.push(action.path);
            continue;
          }
          outcome.rescue.push(await this.#rescue(rescueDir, action.path));
          await unlink(action.path);
          outcome.deleted.push(action.path);
          continue;
        }
        const objectPath = join(this.objectsDir(sessionId), action.backup);
        const bytes = await readFile(objectPath);
        if (exists) outcome.rescue.push(await this.#rescue(rescueDir, action.path));
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
   * The name is bounded on purpose. It used to be the URI-encoded absolute path,
   * which for any path over roughly 240 characters produced a file name past
   * NAME_MAX (255 bytes on Linux/macOS): `copyFile` then failed with
   * ENAMETOOLONG and took the restore of that path down with it (the file stayed
   * modified and the receipt reported the whole path as failed). A sha256 prefix
   * keeps the name short and unique per path; a truncated, sanitised basename
   * keeps it recognisable by eye.
   *
   * This only changes how recovery copies are *named*: rescue files are
   * write-only material (nothing reads them back, and the journal/objects
   * formats are untouched), so journals written by earlier builds still restore
   * unchanged.
   *
   * @param {string} rescueDir
   * @param {string} path
   * @returns {Promise<string>} the rescue file's path.
   */
  async #rescue(rescueDir, path) {
    await mkdir(rescueDir, { recursive: true });
    // Timestamp + process-wide sequence: two rewinds restoring the same path must
    // not overwrite the earlier rescue copy (it is the manual-recovery material).
    // The sequence is module-level on purpose — a counter local to `restore()`
    // restarts at 1 per call, so two rewinds in the same millisecond produced the
    // same name and the second `copyFile` silently replaced the first copy.
    const digest = createHash('sha256').update(path).digest('hex').slice(0, 16);
    const readable = basename(path).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'file';
    const name = `${Date.now()}-${++rescueSeq}-${digest}-${readable}`;
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
        ...(entry.captureSeq === undefined ? {} : { captureSeq: entry.captureSeq }),
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
   * Trim journal entries no future rewind can reach, with a hard safety cap.
   *
   * A rewind to target T restores entries anchored at or after T, and T is always
   * a visible non-first human message. Entries anchored below the oldest such
   * message can therefore never be selected again — dropping them is lossless.
   * When no such message exists (the session was rewound down to its first
   * message), nothing currently visible is rewindable and future targets are
   * newer messages, so every existing entry is equally unreachable.
   *
   * `MAX_ANCHORS` is a hard bound on the reachable set, not the semantic cutoff:
   * beyond it the oldest reachable entries are dropped **and warned about**, so a
   * later rewind that would have needed them is loudly limited instead of
   * silently missing part of its restore.
   *
   * @param {string} sessionId
   * @param {number} [keepFromAnchor] - oldest seq a future rewind can target;
   *   omitted preserves the legacy cap-only behavior (bridge callers pass it).
   * @returns {Promise<{dropped: number, capped: boolean}>}
   */
  async trim(sessionId, keepFromAnchor) {
    return this.#enqueue(async () => {
      const { entries } = await this.readJournal(sessionId);
      // A caller may pass `Infinity` (no future rewind target exists), which must
      // drop everything; only a missing/NaN argument falls back to legacy keep-all.
      const reachableFloor = typeof keepFromAnchor === 'number' && !Number.isNaN(keepFromAnchor)
        ? keepFromAnchor
        : Number.NEGATIVE_INFINITY;
      const reachable = entries.filter((entry) => entry.anchorSeq >= reachableFloor);
      const anchors = [...new Set(reachable.map((entry) => entry.anchorSeq))].sort((left, right) => left - right);
      let kept = reachable;
      let capped = false;
      if (anchors.length > MAX_ANCHORS) {
        const cutoff = anchors[anchors.length - MAX_ANCHORS];
        kept = reachable.filter((entry) => entry.anchorSeq >= cutoff);
        capped = true;
        this.warn(
          `file-snapshot journal capped at ${MAX_ANCHORS} anchors; entries anchored below ${cutoff} are no longer restorable`,
        );
      }
      const dropped = entries.length - kept.length;
      if (dropped === 0) return { dropped: 0, capped: false };
      const lines = kept.map((entry) => `${JSON.stringify({
        anchorSeq: entry.anchorSeq,
        ...(entry.captureSeq === undefined ? {} : { captureSeq: entry.captureSeq }),
        ...(entry.callId === undefined ? {} : { callId: entry.callId }),
        path: entry.path,
        backup: entry.backup,
        mode: entry.mode,
        time: new Date().toISOString(),
      })}\n`).join('');
      await mkdir(this.sessionDir(sessionId), { recursive: true });
      await writeFile(this.journalPath(sessionId), lines, 'utf8');
      return { dropped, capped };
    });
  }

  /**
   * Delete content objects the journal no longer references.
   *
   * Pruning/trimming only rewrites the index; without this the `objects/`
   * directory grew forever (each edit stored a full before-image).
   *
   * Two guards keep a concurrent capture alive: an object whose hash is in the
   * in-memory pending map is never removed (its journal line may still be on its
   * way), and objects younger than `GC_GRACE_MS` are kept (covers the window
   * between writing the object and registering the pending entry).
   *
   * @param {string} sessionId
   * @returns {Promise<{removed: number, keptRecent: number}>}
   */
  async collectGarbage(sessionId) {
    return this.#enqueue(async () => {
      const { entries } = await this.readJournal(sessionId);
      const referenced = new Set(entries.map((entry) => entry.backup).filter((backup) => typeof backup === 'string'));
      // Captures that have not committed yet: the object is written before the
      // journal line exists, so a rewind racing a still-running edit would
      // otherwise delete a backup the tool is about to reference.
      for (const pending of this.pending.values()) {
        if (typeof pending?.backup === 'string') referenced.add(pending.backup);
      }
      let names;
      try {
        names = await readdir(this.objectsDir(sessionId));
      } catch (error) {
        if (error?.code === 'ENOENT') return { removed: 0, keptRecent: 0 };
        throw error;
      }
      let removed = 0;
      let keptRecent = 0;
      for (const name of names) {
        if (referenced.has(name)) continue;
        const target = join(this.objectsDir(sessionId), name);
        try {
          const info = await stat(target);
          if (Date.now() - info.mtimeMs < this.gcGraceMs) {
            keptRecent += 1;
            continue;
          }
          await unlink(target);
          removed += 1;
        } catch (error) {
          this.warn(`could not remove unreferenced snapshot object ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { removed, keptRecent };
    });
  }
}
