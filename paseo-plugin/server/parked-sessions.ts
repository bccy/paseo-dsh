/**
 * The one long-lived DSH process a connection's sessions all share.
 *
 * Paseo's documented refresh semantics are "close the current provider session
 * and open it again with persistence". A naive implementation kills the `dsh`
 * child on close and spawns a new one on open: that spawn + profile load is the
 * 1.5–2.7 s half of the refresh latency. The bridge's protocol state and the
 * agent's session log do not need a new process, though — the child keeps
 * serving the sessions that are still open.
 *
 * **One process for every session, not one per cwd or per route.** DSH keeps the
 * working directory and route per session (`dsh-working-directory` projects it,
 * there is no `process.chdir`), and its session logs are already written to
 * per-session paths, so a process can serve sessions in different projects at
 * once. Pooling by cwd would instead make the common case — several agents in
 * the same repository — spawn a process each, which is the cost this change
 * exists to remove. The pool key is therefore a single constant
 * ({@link POOL_KEY}), and the pool holds at most one process.
 *
 * The pool is still deliberately small and short-lived:
 *
 * - an entry is only parked once nothing holds it (a running turn would keep
 *   emitting into a timeline nobody is showing);
 * - TTL (30 s) bounds an entry that is never adopted (the daemon crashed, the
 *   agent was closed for real); the cap bounds memory;
 * - a *stale* entry is dropped rather than handed on (see {@link discard}).
 *
 * A miss is never an error: the caller cold-starts, exactly as before.
 *
 * @module dsh-paseo/server/parked-sessions
 */

import type { DshProcess } from "./dsh-process";

/**
 * The single pool key.
 *
 * Every session shares one process (see the module comment), so the slot carries
 * no session- or configuration-derived identity at all. It stays a *keyed* map of
 * Nothing is pooled any more: one child serves every session, so what is left
 * here is the dying-process bookkeeping that {@link ParkedSessions.quiesce} needs
 * and the hold/release accounting the provider pairs around each claim.
 */

/**
 * What a caller expects when it opens a session.
 *
 * {@link ParkedSessions.quiesce} takes it only to name the session's cwd and route
 * in its log line; it never decides anything.
 */
export interface ParkedExpectation {
  cwd: string;
  routeKey: string;
}

/** Configuration; the defaults are the shipped values. */
export interface ParkedSessionsOptions {
  log?: (line: string) => void;
  now?: () => number;
}
/**
 * Upper bound on waiting for a killed parked child to really exit.
 *
 * A DSH session log carries a kernel write lock (`SessionWriteLease` in
 * `@deepseek-ai/dsh-session-persistence-jsonl`) that outlives SIGTERM until the
 * OS reaps the process. A successor spawned before that fails to materialize the
 * session with "already owned by an active write handle". `kill()` also arms a
 * 4 s SIGKILL fallback, so 5 s covers the worst case; a timeout is logged and the
 * caller cold-starts anyway rather than blocking the open forever.
 */
const RELEASE_TIMEOUT_MS = 5_000;
/** Bound on remembered dying processes, so a pathological sequence cannot grow the pool. */
const DYING_TRACK_LIMIT = 64;

/** One parked process that was killed and may still be releasing its session lock. */
interface DyingEntry {
  dshSessionId: string;
  process: DshProcess;
  gone: boolean;
}

/**
 * The handler set a *parked session* reports to, leaving every other session on
 * the same process untouched.
 *
 * A parked process used to be silenced with `setHandlers`, which re-pointed the
 * whole child: correct when one process served one session, catastrophic once
 * several sessions share it — parking one conversation would have muted the
 * events of every other conversation still running in that child. {@link
 * ParkedSessions.park} therefore refuses outright while any session still holds
 * the process (see `busy`), and a caller that needs to detach one idle session
 * from a shared child uses `DshProcess.detachSession` / `closeSession` instead.
 *
 * Kept as a named module-level function so a missing definition is a compile
 * error rather than a runtime `ReferenceError` swallowed by a `try` — the failure
 * mode that made every `park()` silently return false.
 *
 * @param onExit - called when the whole child exits (the pool forgets its entry).
 */
export class ParkedSessions {
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  /** Killed entries, kept until they are observed gone (see {@link quiesce}). */
  #dying: DyingEntry[] = [];
  /**
   * How many live sessions hold the shared process.
   *
   * Nothing is pooled any more (one child serves every session), so this no
   * longer guards an eviction decision — it exists so {@link quiesce} and the
   * provider's claim accounting agree on how many conversations are still using
   * that child. The provider maintains it through {@link hold} / {@link release}.
   */
  #holds = 0;

  constructor(options: ParkedSessionsOptions = {}) {
    this.#log = options.log ?? ((line) => process.stderr.write(`[paseo-dsh] ${line}\n`));
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Record that one more live session is using the pooled process.
   *
   * **The provider owns the pairing contract**: it calls this exactly once per
   * shared-child claim in `#addPoolClaim`, and releases exactly once per returned
   * claim (`#releasePoolProcess`) or per claim that became void with its child
   * (`#dropPoolClaims`). Every guard below assumes that invariant; a hold
   * without a release turns the pool permanently busy, a release without a hold
   * silently reopens the "kill a live session's process" hole.
   */
  hold(): void {
    this.#holds += 1;
  }

  /**
   * Record that one session stopped using the pooled process.
   *
   * Tolerates an unmatched call (`#holds` never goes negative) so shutdown paths
   * cannot corrupt the count, but the provider is expected to pair it with
   * {@link hold} — see the contract there.
   */
  release(): void {
    if (this.#holds > 0) this.#holds -= 1;
  }

  /**
   * Kept as a no-op for the provider's lifecycle calls.
   *
   * There is no pool left to expire: one shared child serves every session and is
   * retired explicitly, so the TTL sweep and the "kill what is still parked"
   * shutdown pass both had nothing to act on. The provider still calls
   * {@link start} / {@link stop} around its lifetime, and {@link hold} /
   * {@link release} still track live claims for {@link quiesce}.
   */
  start(): void {}

  /** See {@link start}: nothing is pooled, so shutdown only resets the counter. */
  stop(): void {
    // No session can still be holding a pooled process that no longer exists.
    this.#holds = 0;
  }



  /**
   * Wait (bounded) until every killed owner of this DSH session has really exited.
   *
   * A DSH session log carries a kernel write lock that outlives SIGTERM until the
   * OS reaps the process, and a successor spawned into that window fails to
   * materialize the session ("already owned by an active write handle"). This is
   * the gate that closes that hole, and it still matters under one shared
   * process: the shared child itself can be retired and respawned, and a session
   * opened across that boundary must wait for the old child to release the lock.
   *
   * It no longer kills anything: the process it would have killed is now the
   * process other sessions are using, so the decision to retire it belongs to the
   * provider's reference count, not to an open.
   *
   * @param dshSessionId - DSH native session id about to be opened.
   * @param expected - the cwd and route the new session will use (log only).
   * @param timeoutMs - bound on the total wait (defaults to the shipped value).
   * @returns whether every killed owner is gone; a timeout is logged, not thrown.
   */
  async quiesce(
    dshSessionId: string,
    expected: ParkedExpectation,
    timeoutMs: number = RELEASE_TIMEOUT_MS,
  ): Promise<boolean> {
    const pending = this.#dying.filter((item) => !item.gone && item.dshSessionId === dshSessionId);
    if (pending.length === 0) return true;
    this.#log(
      `parked:release ${dshSessionId} waiting for ${pending.length} dying owner(s) (open for ${expected.cwd} on ${expected.routeKey})`,
    );
    const deadline = this.#now() + timeoutMs;
    let allGone = true;
    for (const item of pending) {
      const remaining = Math.max(0, deadline - this.#now());
      item.gone = (await item.process.waitForExit(remaining)) === true;
      if (!item.gone) allGone = false;
    }
    this.#dying = this.#dying.filter((item) => !item.gone);
    if (!allGone) {
      this.#log(
        `parked:release ${dshSessionId} timed out after ${timeoutMs}ms; the previous owner may still hold the session log`,
      );
    }
    return allGone;
  }






}

export { RELEASE_TIMEOUT_MS };
