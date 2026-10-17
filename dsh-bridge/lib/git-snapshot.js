import { execFileSync } from 'node:child_process';

/**
 * Git snapshots for the rewind's file rollback.
 *
 * A rewind has to put the working tree back the way it was when the withdrawn
 * message was sent, and the only durable record of that is a git commit. We take
 * one snapshot per user message, before the message reaches the agent:
 *
 * - `HEAD` is always recorded — it is the committed baseline.
 * - `git stash create` records the dirty state as a commit object without
 *   touching the working tree or the stash list. On a clean tree it prints
 *   nothing, so `stash` stays null and restoring is just `reset --hard`.
 *
 * Restoring is `reset --hard <head>` followed by `stash apply <stash>`; the
 * second step only runs when a stash exists. Both run through an injectable
 * runner so the module is testable without a repository.
 *
 * Deliberately out of scope: untracked files (`stash create` does not capture
 * them; `-u` would, at a cost and with murkier restore semantics) and untracked
 * directories. The docs say so rather than leaving it to be discovered.
 */

/** The one command runner this module needs; injected for tests. */
function defaultRun(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Read the working tree state.
 *
 * @param {string} cwd - directory that may be a git worktree.
 * @param {(cwd: string, args: string[]) => string} [run] - command runner.
 * @returns {{repo: boolean, dirty: string[]}} `dirty` holds `git status --porcelain` lines.
 */
function worktreeState(cwd, run = defaultRun) {
  try {
    run(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return { repo: false, dirty: [] };
  }
  const status = run(cwd, ['status', '--porcelain']);
  return {
    repo: true,
    dirty: status.split('\n').filter((line) => line.trim() !== ''),
  };
}

/**
 * Snapshot the worktree as it is right now.
 *
 * Never mutates the tree. A clean tree yields `stash: null` (nothing to restore
 * beyond `HEAD`); a dirty one yields a dangling commit holding the changes.
 *
 * @param {string} cwd - git worktree.
 * @param {(cwd: string, args: string[]) => string} [run] - command runner.
 * @returns {{head: string, stash: string | null}}
 */
function snapshot(cwd, run = defaultRun) {
  const head = run(cwd, ['rev-parse', 'HEAD']).trim();
  if (head === '') throw new Error('cannot snapshot a repository without commits');
  const stash = run(cwd, ['stash', 'create']).trim();
  return { head, stash: stash === '' ? null : stash };
}

/**
 * Put the worktree back at a snapshot.
 *
 * `reset --hard` drops everything uncommitted, then `stash apply` replays what
 * was dirty at snapshot time. A failure in either step is thrown verbatim: the
 * caller must stop and report rather than continue with a half-restored tree.
 *
 * @param {string} cwd - git worktree.
 * @param {{head: string, stash: string | null}} snap - from {@link snapshot}.
 * @param {(cwd: string, args: string[]) => string} [run] - command runner.
 */
function restore(cwd, snap, run = defaultRun) {
  run(cwd, ['reset', '--hard', snap.head]);
  if (snap.stash !== null) run(cwd, ['stash', 'apply', '--index', snap.stash]);
}

/**
 * Pick the snapshot that belongs to one withdrawn message.
 *
 * The ledger is append-only JSON lines, one per user message. Rewinding past a
 * message means restoring *its* snapshot — the state before that message — so the
 * match is by message id, and the newest matching line wins (ids are unique, but
 * a resumed session may append the same id again after a replay).
 *
 * @param {string} text - ledger file contents.
 * @param {string} messageId - the withdrawn user message.
 * @returns {{head: string, stash: string | null} | undefined}
 */
function snapshotFor(text, messageId) {
  let found;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // A truncated tail must not invalidate every earlier snapshot.
    }
    if (entry?.messageId !== messageId) continue;
    if (typeof entry.head !== 'string' || entry.head === '') continue;
    found = { head: entry.head, stash: typeof entry.stash === 'string' && entry.stash !== '' ? entry.stash : null };
  }
  return found;
}

/**
 * Serialise one ledger line.
 *
 * @param {{seq: number, messageId: string, head: string, stash: string | null}} entry
 * @returns {string} a single JSON line, newline-terminated.
 */
function ledgerLine(entry) {
  return `${JSON.stringify({ seq: entry.seq, messageId: entry.messageId, head: entry.head, stash: entry.stash, time: new Date().toISOString() })}\n`;
}

export { worktreeState, snapshot, restore, snapshotFor, ledgerLine, defaultRun };
