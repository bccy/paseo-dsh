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
 *   `{anchorSeq, captureSeq, captureOrderVersion, callId, path, backup, mode,
 *   dirPath, dirReal}`. `anchorSeq` is the delegated turn's dispatch anchor or,
 *   for the root session, the newest human user message seq at execution time.
 *   `captureSeq` resumes the retained journal's high-water mark, so concurrent
 *   parent/child edits of one path restore the state before the *first* touch,
 *   not the first *commit*, and the order survives a restart. Allocation is
 *   serialized per path and happens after the bytes are read: the number ranks
 *   the state that was actually observed, so a capture whose read is delayed
 *   cannot outrank a later one that read the file first (BF-02).
 * - A capture that cannot be taken (non-regular file, over the cap, an I/O
 *   failure) commits a line carrying `skip` instead of `backup`. A rewind that
 *   selects it cannot restore that path, so it reports the path as
 *   `unrecoverable` instead of silently claiming the tree came back.
 *
 *   The order is only provable **per path**: a line written before this build
 *   carries no `captureOrderVersion`, and a process-local counter that restarted
 *   from zero is indistinguishable from a valid reverse commit within one path.
 *   `planRestore` therefore refuses a journal whose old lines cannot be ordered
 *   *for that path*, and keeps the journal and its backups as evidence. Two
 *   different paths that disagree are not evidence of a reset — their relative
 *   order was never recorded and no restore decision depends on it — so they are
 *   not refused. That boundary is what the code proves, not "no old journal can
 *   ever be ambiguous".
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
 * following them out of the workspace. It also records the canonical identity
 * (`dirPath`/`dirReal`) of the deepest directory that existed when the file was
 * captured and re-checks it before writing: a parent directory that was moved
 * and replaced by a symlink no longer matches, so the path is skipped instead
 * of writing through the link into another tree. Journals written before that
 * field existed carry no identity and keep the old leaf-only check — the
 * recorded path is all they have to go on.
 *
 * Deliberately out of scope (documented): bash/pwsh side effects, edits made by
 * the user or another process, symlinked targets, and files above the size cap.
 *
 * @module dsh-bridge/file-snapshots
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { appendFile, chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

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
 * Marker written on every journal line whose `captureSeq` was allocated above
 * the durable high water.
 *
 * A line without it was written by a build whose counter started at 0 in every
 * process, so its number cannot be compared with this build's numbers — see
 * `planRestore`, which refuses to guess between different pre-images.
 */
const CAPTURE_ORDER_VERSION = 1;

/**
 * Bound on journals whose high water this process has already folded in.
 *
 * The counter never decreases, so an evicted journal only costs one re-read; the
 * bound exists so a long-lived process serving hundreds of sessions does not
 * keep a growing set of ids.
 */
const SEQUENCE_ROOTS_MAX = 512;

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

/** One-line text for a caught value, without repeating the ternary everywhere. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Serialise one journal entry, preserving every field the reader understands. */
function journalLine(entry) {
  return `${JSON.stringify({
    anchorSeq: entry.anchorSeq,
    ...(entry.captureSeq === undefined ? {} : { captureSeq: entry.captureSeq }),
    ...(entry.captureOrderVersion === undefined ? {} : { captureOrderVersion: entry.captureOrderVersion }),
    ...(entry.callId === undefined ? {} : { callId: entry.callId }),
    path: entry.path,
    ...(entry.skip === undefined
      ? {
          backup: entry.backup,
          mode: entry.mode,
          ...(entry.dirPath === undefined ? {} : { dirPath: entry.dirPath, dirReal: entry.dirReal }),
        }
      : { skip: entry.skip }),
    time: new Date().toISOString(),
  })}\n`;
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
   * Path -> tail of the chain that serialises captures of that one path.
   *
   * Capture order has to rank the state each capture *observed*, and reading a
   * file is asynchronous: two captures of one path must not interleave
   * stat/read with sequence allocation, or an early number can carry a later
   * read (the parent/child race behind BF-02). Serialising per path closes that
   * window without serialising unrelated files or journal commits.
   *
   * Entries are deleted when the chain drains, so the map stays bounded by the
   * captures currently in flight rather than by every path ever edited.
   */
  #pathQueues = new Map();

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
   * Journals already folded into {@link #captureSequence} in this process.
   *
   * Bounded: the high water only ever moves forward, so a journal folded once
   * never needs folding again until a new writer epoch begins
   * ({@link beginOwner}). Evicting the oldest entry only costs a re-read.
   */
  #sequenceRoots = new Set();

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

  /** Run one capture of `path` after the previous capture of the same path. */
  #serializeOnPath(path, task) {
    const previous = this.#pathQueues.get(path) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#pathQueues.set(path, tail);
    return run.finally(() => {
      if (this.#pathQueues.get(path) === tail) this.#pathQueues.delete(path);
    });
  }

  /**
   * Allocate the next capture order, resuming the durable high water first.
   *
   * `captureSeq` used to be a plain process-local counter starting at 0, so a
   * restart rewound it: the second process's captures looked *earlier* than the
   * first process's, `planRestore` picked the wrong pre-image for a path touched
   * in both, and a rewind could restore an intermediate version while reporting
   * success.
   *
   * The retained journal is the only durable record of what was already handed
   * out, so it is read once per session per writer epoch and its highest
   * `captureSeq` becomes the floor. Two things make that sound:
   *
   * - DSH's session write lease admits one bridge writer per session at a time,
   *   so no other process is allocating for this journal while this one reads it.
   * - The read happens **inside** the journal-write queue, so it cannot interleave
   *   with this process's own appends, and it counts pending captures too
   *   (their numbers are already allocated, only not yet written).
   *
   * @param {string} sessionId
   * @returns {Promise<number>}
   */
  #nextCaptureSequence(sessionId) {
    return this.#enqueue(async () => {
      if (!this.#sequenceRoots.has(sessionId)) {
        const { entries, skippedLines } = await this.readJournal(sessionId);
        if (skippedLines > 0) {
          this.warn(`capture order read skipped ${skippedLines} damaged journal line(s) for ${sessionId}`);
        }
        for (const entry of entries) {
          if (entry.captureSeq !== undefined) {
            this.#captureSequence = Math.max(this.#captureSequence, entry.captureSeq);
          }
        }
        if (this.#sequenceRoots.size >= SEQUENCE_ROOTS_MAX) {
          this.#sequenceRoots.delete(this.#sequenceRoots.values().next().value);
        }
        this.#sequenceRoots.add(sessionId);
      }
      if (!Number.isSafeInteger(this.#captureSequence + 1)) {
        throw new Error('file snapshot capture order exhausted');
      }
      return ++this.#captureSequence;
    });
  }

  /**
   * Await journal writes already submitted by tools that have settled.
   *
   * A restore plan must see the lines of every tool that has finished. Without
   * this, a commit still queued behind a slow append would be missing from the
   * plan — the file it names would not be restored, and its entry would then be
   * pruned as if it had been.
   */
  async settle() {
    await this.#writeQueue;
  }

  /**
   * Forget this session's cached high water because a new writer epoch began.
   *
   * The next capture re-reads the journal, which is what lets a process that
   * lost and regained ownership follow another process's allocations. Called
   * from the agent factory's setup hook: at that point this process holds the
   * session's write lease and no capture can have run for it yet.
   *
   * @param {string} sessionId
   */
  beginOwner(sessionId) {
    this.#sequenceRoots.delete(sessionId);
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
    try {
      // Serialised per path, and the number is allocated *after* the bytes were
      // read: two captures of one path must rank the state each actually
      // observed. Allocating before the read let a delayed read carry an early
      // number, so `planRestore` picked a pre-image that was newer than the one
      // it claimed to restore (BF-02).
      return await this.#serializeOnPath(input.path, async () => {
        let info;
        try {
          info = await stat(input.path);
        } catch (error) {
          if (error?.code === 'ENOENT') {
            // The tool is about to create the file: the rewind deletes it. The
            // parent identity is recorded too, so the delete cannot be
            // redirected through an ancestor symlink.
            const captureSeq = await this.#nextCaptureSequence(input.sessionId);
            this.pending.set(key, {
              anchorSeq: input.anchorSeq,
              captureSeq,
              callId: input.callId,
              path: input.path,
              backup: null,
              mode: null,
              ...(await this.#captureIdentity(input.path)),
            });
            return { ok: true };
          }
          return await this.#recordSkippedCapture(key, input, `stat failed: ${errorMessage(error)}`);
        }
        if (!info.isFile()) {
          return await this.#recordSkippedCapture(key, input, 'not-a-regular-file');
        }
        if (info.size > this.maxFileBytes) {
          return await this.#recordSkippedCapture(key, input, `larger than ${this.maxFileBytes} bytes`);
        }
        let bytes;
        try {
          bytes = await readFile(input.path);
        } catch (error) {
          return await this.#recordSkippedCapture(key, input, `read failed: ${errorMessage(error)}`);
        }
        const captureSeq = await this.#nextCaptureSequence(input.sessionId);
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
          ...(await this.#captureIdentity(input.path)),
        });
        return { ok: true };
      });
    } catch (error) {
      this.pending.delete(key);
      return { ok: false, error: errorMessage(error) };
    }
  }

  /**
   * Remember a capture that could not be taken, so a later rewind can say so.
   *
   * The tool may still succeed and change the file; without a line in the
   * journal the rewind would plan nothing for that path and report a clean
   * success while the file stays modified (BF-03). `commit` turns this pending
   * entry into a `skip` line only when the tool actually succeeded.
   *
   * @param {string} key
   * @param {{sessionId: string, anchorSeq: number, callId: string, path: string}} input
   * @param {string} reason
   * @returns {Promise<{ok: true, skipped: string}>}
   */
  async #recordSkippedCapture(key, input, reason) {
    const captureSeq = await this.#nextCaptureSequence(input.sessionId);
    this.pending.set(key, {
      anchorSeq: input.anchorSeq,
      captureSeq,
      callId: input.callId,
      path: input.path,
      skip: reason,
    });
    return { ok: true, skipped: reason };
  }

  /**
   * The canonical identity of the deepest directory that exists above `path`.
   *
   * `path` itself may not exist yet (a creation), so the nearest existing
   * ancestor is recorded. `dirPath` is the lexical path at capture time and
   * `dirReal` its resolved canonical path; re-running this at restore and
   * comparing both detects an ancestor that was moved or replaced by a symlink.
   * Two different lexical paths can resolve to the same directory, which is why
   * both halves are recorded.
   *
   * @param {string} path
   * @returns {Promise<{dirPath: string, dirReal: string} | undefined>}
   */
  async #captureIdentity(path) {
    let dir = dirname(path);
    for (;;) {
      try {
        const real = await realpath(dir);
        const info = await stat(dir);
        if (!info.isDirectory()) return undefined;
        return { dirPath: dir, dirReal: real };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
    }
  }

  /**
   * Whether the path's directory identity no longer matches the captured one.
   *
   * The recorded anchor is the deepest directory that existed at capture time.
   * It must still resolve to the same canonical path (`realpath(anchor) ===
   * dirReal`), and no component that was created below it since then may be a
   * symlink: the normal case is directories the tool created laying out a new
   * file, which are real directories. A parent that was moved and replaced by a
   * symlink fails the canonical comparison; a symlink inserted halfway down
   * fails the component walk.
   *
   * Legacy lines carry no identity and return `false` (the leaf `lstat` check
   * is all they support). A failure to resolve the identity counts as a
   * mismatch: the restore cannot prove it would write the object it captured.
   *
   * @param {{path: string, dirPath?: string, dirReal?: string}} action
   * @returns {Promise<boolean>}
   */
  async #pathIdentityChanged(action) {
    if (action.dirPath === undefined || action.dirReal === undefined) return false;
    try {
      const real = await realpath(action.dirPath);
      if (real !== action.dirReal) {
        this.warn(
          `file restore skipped: the parent directory of ${action.path} was moved or replaced since the file was captured`,
        );
        return true;
      }
      const info = await stat(action.dirPath);
      if (!info.isDirectory()) {
        this.warn(`file restore skipped: the captured parent of ${action.path} is no longer a directory`);
        return true;
      }
      const parent = dirname(action.path);
      const below = relative(action.dirPath, parent);
      if (below !== '' && below !== '.' && !below.startsWith('..') && !isAbsolute(below)) {
        let cursor = action.dirPath;
        for (const part of below.split(sep)) {
          if (part === '') continue;
          cursor = join(cursor, part);
          let entry;
          try {
            entry = await lstat(cursor);
          } catch (error) {
            if (error?.code === 'ENOENT') break; // the tool may create it later; mkdir does the rest
            throw error;
          }
          if (!entry.isDirectory() || entry.isSymbolicLink()) {
            this.warn(
              `file restore skipped: a component below the captured parent of ${action.path} is not a real directory`,
            );
            return true;
          }
        }
      }
    } catch (error) {
      this.warn(`file restore skipped: cannot verify the parent directory of ${action.path}: ${errorMessage(error)}`);
      return true;
    }
    return false;
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
      // The tool still succeeded, so the file may have changed. Keep the reason
      // in the durable journal: a later rewind has to be able to report that it
      // cannot restore this path (BF-03), and an in-memory log line would be
      // gone by then.
      this.warn(`file snapshot skipped for ${String(pending.path ?? '')}: ${pending.skip}`);
    }
    try {
      await this.#enqueue(async () => {
        await mkdir(this.sessionDir(input.sessionId), { recursive: true });
        // Every line this build writes carries the version marker, also when it
        // is a `skip`: the capture order in it is comparable with this build's.
        const line = journalLine({ ...pending, captureOrderVersion: CAPTURE_ORDER_VERSION });
        await appendFile(this.journalPath(input.sessionId), line, 'utf8');
      });
    } catch (error) {
      this.warn(`could not record a file snapshot for ${input.sessionId}: ${errorMessage(error)}`);
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
   * names, so a line is only accepted when it is an absolute path and carries
   * either a content hash (or an explicit `null` for "did not exist") or a
   * `skip` reason recorded when no backup could be taken. Anything else — a
   * relative path, a traversal-prone `backup`, a truncated tail — is skipped and
   * counted, never acted on.
   *
   * @param {string} sessionId
   * @returns {Promise<{entries: Array<{anchorSeq: number, captureSeq?: number, callId?: string, path: string, backup?: string | null, mode?: number | null, skip?: string, dirPath?: string, dirReal?: string}>, skippedLines: number}>}
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
      const skipValid = typeof parsed?.skip === 'string' && parsed.skip !== '';
      // Exactly one of the two: a line is either a backup to restore or a
      // recorded reason it could not be taken. A made-up shape is skipped, not
      // guessed at.
      const kindValid = backupValid !== skipValid;
      const hasDirPath = parsed?.dirPath !== undefined;
      const hasDirReal = parsed?.dirReal !== undefined;
      const dirValid = hasDirPath === hasDirReal
        && (!hasDirPath
          || (typeof parsed.dirPath === 'string' && isAbsolute(parsed.dirPath)
            && typeof parsed.dirReal === 'string' && isAbsolute(parsed.dirReal)));
      if (typeof parsed?.anchorSeq !== 'number'
        || !Number.isSafeInteger(parsed.anchorSeq) || parsed.anchorSeq < 0
        || typeof parsed?.path !== 'string'
        || !isAbsolute(parsed.path)
        || !kindValid
        || !dirValid
        || (parsed.captureSeq !== undefined
          && (!Number.isSafeInteger(parsed.captureSeq) || parsed.captureSeq <= 0))) {
        skippedLines += 1;
        continue;
      }
      entries.push({
        anchorSeq: parsed.anchorSeq,
        captureSeq: typeof parsed.captureSeq === 'number' ? parsed.captureSeq : undefined,
        captureOrderVersion: parsed.captureOrderVersion === CAPTURE_ORDER_VERSION
          ? CAPTURE_ORDER_VERSION
          : undefined,
        callId: typeof parsed.callId === 'string' ? parsed.callId : undefined,
        path: parsed.path,
        ...(skipValid
          ? { skip: parsed.skip }
          : { backup: parsed.backup, mode: typeof parsed.mode === 'number' ? parsed.mode : null }),
        ...(hasDirPath ? { dirPath: parsed.dirPath, dirReal: parsed.dirReal } : {}),
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
   * A path whose earliest post-target capture is a `skip` line cannot be
   * restored to its true pre-target state; it is returned in `unrecoverable`
   * (with the recorded reason) instead of `actions`, so the caller can tell the
   * user rather than prune the only evidence away.
   *
   * @param {string} sessionId
   * @param {number} targetSeq
   * @returns {Promise<{actions: Array<{path: string, backup: string | null, mode: number | null, dirPath?: string, dirReal?: string}>, unrecoverable: Array<{path: string, reason: string}>, skippedLines: number}>}
   */
  async planRestore(sessionId, targetSeq) {
    // A tool that has settled may still have its journal line queued behind a
    // slow append. Planning without it would silently drop that path from the
    // restore and then prune its entry as if it had been handled.
    await this.settle();
    const { entries, skippedLines } = await this.readJournal(sessionId);
    /** @type {Map<string, {path: string, backup?: string | null, mode?: number | null, skip?: string, dirPath?: string, dirReal?: string, rank: number}>} */
    const byPath = new Map();
    /** Per path, the distinct pre-images recorded by numbered (post-migration) lines. */
    const orderedPreimages = new Map();
    /** Per path, the single pre-image recorded by pre-migration lines. */
    const legacyPreimages = new Map();
    for (const entry of entries) {
      if (entry.anchorSeq < targetSeq) continue;
      const identity = `${String(entry.backup)}:${String(entry.mode)}`;
      // `skip` lines carry no pre-image, so they cannot make an old journal's
      // ordering ambiguous; only real backups participate in that judgement.
      if (entry.captureOrderVersion === CAPTURE_ORDER_VERSION && entry.skip === undefined) {
        const images = orderedPreimages.get(entry.path) ?? new Set();
        images.add(identity);
        orderedPreimages.set(entry.path, images);
      }
      if (entry.captureOrderVersion === undefined && entry.skip === undefined) {
        // A pre-migration line carries a number from a counter that started at 0
        // in every process, so within one path it is indistinguishable from a
        // valid reverse commit. Refuse to guess between different pre-images and
        // keep the journal plus its backups so the operator can recover them.
        //
        // The judgement is per path on purpose: only one path's restore decision
        // depends on one path's order, so two paths whose numbers disagree are
        // not evidence of a reset. A single old pre-image for a path stays
        // usable — there is nothing to choose between.
        const numberedAfter = orderedPreimages.get(entry.path);
        const followsNewWriter = numberedAfter !== undefined && [...numberedAfter].some((image) => image !== identity);
        const previous = legacyPreimages.get(entry.path);
        if (followsNewWriter || (previous !== undefined && previous !== identity)) {
          throw new Error(
            `cannot prove file snapshot capture order for ${entry.path}; journal and backups retained`,
          );
        }
        legacyPreimages.set(entry.path, identity);
      }
      // Legacy lines have no capture order; they are older than any numbered
      // capture written by this build, so they rank first.
      const rank = typeof entry.captureSeq === 'number' ? entry.captureSeq : Number.NEGATIVE_INFINITY;
      const current = byPath.get(entry.path);
      if (current !== undefined && current.rank <= rank) continue;
      byPath.set(entry.path, {
        path: entry.path,
        ...(entry.skip === undefined
          ? { backup: entry.backup, mode: entry.mode ?? null }
          : { skip: entry.skip }),
        ...(entry.dirPath === undefined ? {} : { dirPath: entry.dirPath, dirReal: entry.dirReal }),
        rank,
      });
    }
    const actions = [];
    const unrecoverable = [];
    for (const entry of byPath.values()) {
      if (entry.skip !== undefined) {
        // The earliest capture after the target could not be taken, so there is
        // no pre-image that would be correct to write. Report it instead of
        // restoring a later (wrong) one or silently succeeding (BF-03).
        unrecoverable.push({ path: entry.path, reason: entry.skip });
        continue;
      }
      actions.push({
        path: entry.path,
        backup: entry.backup,
        mode: entry.mode,
        ...(entry.dirPath === undefined ? {} : { dirPath: entry.dirPath, dirReal: entry.dirReal }),
      });
    }
    return { actions, unrecoverable, skippedLines };
  }

  /**
   * Apply restore actions, keeping a rescue copy of every file about to change.
   *
   * A single failed path does not stop the others; the caller reports the whole
   * outcome (the conversation rewind already happened).
   *
   * A rewind must not be a way around the sandbox: a symlink or special file is
   * skipped, never followed, so a journal entry (or the tool path it recorded)
   * cannot make the restore write through a link into something else. When the
   * journal recorded the parent's canonical identity, it is re-checked first: a
   * parent that was moved and replaced by a symlink points at a different
   * directory now, and the path is skipped instead of writing into it.
   *
   * @param {string} sessionId
   * @param {Array<{path: string, backup: string | null, mode: number | null, dirPath?: string, dirReal?: string}>} actions
   * @returns {Promise<{restored: string[], deleted: string[], skipped: string[], alreadyAbsent: string[], failed: Array<{path: string, error: string}>, rescue: string[], rescueDir: string}>}
   */
  async restore(sessionId, actions) {
    const rescueDir = this.rescueDir(sessionId);
    const outcome = { restored: [], deleted: [], skipped: [], alreadyAbsent: [], failed: [], rescue: [], rescueDir };
    for (const action of actions) {
      try {
        if (await this.#pathIdentityChanged(action)) {
          outcome.skipped.push(action.path);
          continue;
        }
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
            // Nothing to delete: the file the tool was about to create never
            // appeared, or was already removed. This is not a partial restore
            // and must not be reported as one.
            outcome.alreadyAbsent.push(action.path);
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
      const lines = kept.map(journalLine).join('');
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
      const lines = kept.map(journalLine).join('');
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
