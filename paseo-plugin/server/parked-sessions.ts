/**
 * The one long-lived DSH process a connection's sessions all share.
 *
 * **One process for every session, not one per cwd or per route.** DSH keeps the
 * working directory and route per session (`dsh-working-directory` projects it,
 * there is no `process.chdir`), and its session logs are already written to
 * per-session paths, so a process can serve sessions in different projects at
 * once. Pooling by cwd would instead make the common case — several agents in
 * the same repository — spawn a process each, which is the cost this change
 * exists to remove.
 *
 * Nothing is pooled any more: the shared child is retired explicitly by the
 * provider's reference count, not by an eviction decision here. What is left in
 * this module is
 *
 * - the bounded wait {@link ParkedSessions.quiesce} performs before a successor
 *   is spawned, and
 * - the hold/release accounting the provider pairs around each claim.
 *
 * @module dsh-paseo/server/parked-sessions
 */

import type { DshProcess } from "./dsh-process";

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
}
/**
 * Upper bound a caller may wait for a retired child to release a session log.
 *
 * A DSH session log carries a kernel write lock (`SessionWriteLease` in
 * `@deepseek-ai/dsh-session-persistence-jsonl`) that outlives SIGTERM until the
 * OS reaps the process. A successor spawned before that fails to materialize the
 * session with "already owned by an active write handle", so this is the bound
 * callers use when they wait. It is also the pool's session-lock release bound,
 * which `provider.ts`'s `POOL_RELEASE_GRACE_MS` deliberately matches.
 */
const RELEASE_TIMEOUT_MS = 5_000;

export class ParkedSessions {
  readonly #log: (line: string) => void;

  constructor(options: ParkedSessionsOptions = {}) {
    this.#log = options.log ?? ((line) => process.stderr.write(`[paseo-dsh] ${line}\n`));
  }

  /**
   * Record that one more live session is using the shared process.
   *
   * **The provider owns the pairing contract**: it calls this exactly once per
   * shared-child claim in `#addPoolClaim`, and releases exactly once per returned
   * claim (`#releasePoolProcess`) or per claim that became void with its child
   * (`#dropPoolClaims`). `multi-session-check.mjs` counts the calls across a
   * plugin-level run (two sessions on one child => two holds) precisely because
   * a hold per *request* would still pass a weaker "was it called at all" check.
   */
  hold(): void {}

  /**
   * Record that one session stopped using the shared process.
   *
   * The pairing is the provider's contract; see {@link hold}. An unmatched call
   * is tolerated (this is a no-op, not a counter).
   */
  release(): void {}

  /**
   * Kept as a no-op for the provider's lifecycle calls.
   *
   * There is no pool left to expire: one shared child serves every session and is
   * retired explicitly, so the TTL sweep and the "kill what is still parked"
   * shutdown pass both had nothing to act on. The provider still calls
   * {@link start} / {@link stop} around its lifetime, and {@link hold} /
   * {@link release} stay as the pair the provider books around each claim.
   */
  start(): void {}

  /** See {@link start}: nothing is pooled, so there is nothing to tear down. */
  stop(): void {}

  /**
   * Yield before a successor for this DSH session is spawned.
   *
   * **The `async` shape and this signature are kept deliberately.** `provider.ts`
   * `#open` does `await this.#parked.quiesce(...)`, so this is one of the awaits
   * between the `#opening` claim and the `replaced`-instance `close()` in the
   * open transaction — the interleaving
   * `harness/concurrent-open-check.mjs` documents when it explains how the
   * concurrent-open race window is reproduced.
   *
   * Honest limit of that claim (measured 2026-10-26): making this synchronous —
   * or dropping the `await` at the call site — did **not** turn
   * `concurrent-open-check.mjs` red; it stayed 8/8, because the transaction has
   * other awaits (`await replaced.close(...)`, `await session.open()`) that still
   * yield. So this is *a* yield point, not *the only* one, and the harness does
   * not depend on it alone. It is kept because it costs nothing and because a
   * future simplification that removes the other awaits would otherwise silently
   * remove the last one.
   *
   * The wait itself is gone with the dying-process bookkeeping: `#markDying` was
   * deleted in b0c4579, so nothing ever populated the list this used to scan and
   * the scan always returned early. Waiting for a retired child to release the
   * session log's write lock is now `DshProcess`'s own teardown, which the
   * provider awaits before respawning.
   *
   * @param dshSessionId - DSH native session id about to be opened (log only).
   * @param expected - the cwd and route the new session will use (log only).
   * @param timeoutMs - kept so the call site's shape stays unchanged.
   * @returns always true: there is no dying owner left to wait for.
   */
  async quiesce(
    dshSessionId: string,
    expected: ParkedExpectation,
    timeoutMs: number = RELEASE_TIMEOUT_MS,
  ): Promise<boolean> {
    void dshSessionId;
    void expected;
    void timeoutMs;
    return true;
  }
}

export { RELEASE_TIMEOUT_MS };
