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
 * one entry rather than collapsing to a bare field because the TTL sweep, the cap
 * and the dying-process bookkeeping are all written in terms of a keyed entry, and
 * a bare field would have to reinvent them — and because a key that cannot vary
 * per session is the invariant that makes "one process" checkable in the code
 * instead of only in a comment.
 *
 * Anything that *does* vary per session — cwd, route, MCP servers — is applied per
 * session by `DshProcess.attachSession`, never by the pool.
 */
const POOL_KEY = "default";

/**
 * One process waiting for its next provider session.
 *
 * The session-derived fields describe the session that *last* left the process in
 * the pool. They are diagnostics only: they no longer take part in reuse, because
 * one process serves every cwd and route.
 */
export interface ParkedEntry {
  process: DshProcess;
  /** Provider session id that owned the process before parking. */
  sessionId: string;
  /** DSH native session id of the session that parked it (diagnostics only). */
  dshSessionId: string;
  cwd: string;
  /** `provider/model` the parking session had opened with (diagnostics only). */
  routeKey: string;
  parkedAt: number;
}

/**
 * What a caller expects to find when it asks the pool for a process.
 *
 * Kept because {@link ParkedSessions.quiesce} still takes it — the caller that is
 * about to open a session names that session's cwd and route so the log can say
 * what the open was for. It never decides reuse: the pool holds one process for
 * every configuration.
 */
export interface ParkedExpectation {
  cwd: string;
  routeKey: string;
}

/** Pool configuration; the defaults are the shipped values. */
export interface ParkedSessionsOptions {
  ttlMs?: number;
  max?: number;
  log?: (line: string) => void;
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;
/**
 * Cap on parked processes.
 *
 * A shared pool holds one process, so this can never be reached through the
 * normal path — it stays as the bound that keeps a bug (two processes parked by
 * accident) from turning into unbounded memory, and `#evictOverflow` refuses to
 * evict an entry any session still holds.
 */
const DEFAULT_MAX = 3;
const SWEEP_INTERVAL_MS = 5_000;
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
function parkedSessionHandlers(onExit: () => void) {
  return {
    onEvent: () => {},
    onStatus: () => {},
    onQuestion: async () => ({ answers: [] as never[] }),
    onExit: () => onExit(),
  };
}

export class ParkedSessions {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #pool = new Map<string, ParkedEntry>();
  /** Killed entries, kept until they are observed gone (see {@link quiesce}). */
  #dying: DyingEntry[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  /**
   * How many live sessions hold the pooled process.
   *
   * The pool now holds at most one long-lived process shared by every session
   * (see the module comment), so "may this entry be dropped?" is no longer
   * answered by the pool alone: killing the process ends every conversation in
   * it. While this is above zero, {@link discard} refuses to kill and
   * {@link sweep} / {@link #evictOverflow} leave the entry alone. The provider
   * maintains it through {@link hold} / {@link release}.
   */
  #holds = 0;

  constructor(options: ParkedSessionsOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#max = options.max ?? DEFAULT_MAX;
    this.#log = options.log ?? ((line) => process.stderr.write(`[paseo-dsh] ${line}\n`));
    this.#now = options.now ?? (() => Date.now());
  }

  /** Number of processes currently parked (diagnostics/tests). */
  get size(): number {
    return this.#pool.size;
  }

  /**
   * Whether killing the pooled process would strand a live session.
   *
   * True between the first {@link hold} and the last {@link release}. Everything
   * that would kill or drop an entry consults it: the process is shared, so one
   * session's cleanup must never end another's conversation.
   */
  get busy(): boolean {
    return this.#holds > 0;
  }

  /** Record that one more live session is using the pooled process. */
  hold(): void {
    this.#holds += 1;
  }

  /** Record that one session stopped using the pooled process. */
  release(): void {
    if (this.#holds > 0) this.#holds -= 1;
  }

  /** Start the TTL sweep. Idempotent. */
  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.#timer.unref?.();
  }

  /**
   * Stop the sweep and kill everything still parked (provider shutdown/reload).
   */
  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    for (const entry of this.#pool.values()) {
      this.#log(`parked:kill ${entry.dshSessionId} (provider shutting down)`);
      entry.process.kill();
    }
    this.#pool.clear();
    // The pool is gone: no session can still be holding its process through it.
    this.#holds = 0;
  }

  /**
   * Offer the process for reuse.
   *
   * **Refuses while any session still holds it.** Parking used to mean "silence
   * this idle child and keep it for the next session"; with one shared child that
   * would silence every other conversation in it, so the operation is now only
   * legal once nothing holds the process (`busy === false`). A refusal is logged
   * and returns `false` — the caller keeps the process rather than parking it.
   *
   * A dead process is refused too, and an existing parked entry for the same
   * process is replaced (there is one slot, so the entry is the same process).
   *
   * @returns whether the process was accepted.
   */
  park(entry: Omit<ParkedEntry, "parkedAt">): boolean {
    if (this.#holds > 0) {
      this.#log(
        `parked:refuse ${entry.dshSessionId} (${this.#holds} session(s) still hold the shared process)`,
      );
      return false;
    }
    if (!entry.process.running) return false;
    const existing = this.#pool.get(POOL_KEY);
    if (existing !== undefined && existing.process !== entry.process) {
      this.#log(`parked:replace ${existing.dshSessionId} with ${entry.dshSessionId}`);
      existing.process.kill();
      this.#markDying(existing.dshSessionId, existing.process);
    }
    const stored: ParkedEntry = { ...entry, parkedAt: this.#now() };
    // The handlers are installed on the *session*, not the child. A process that
    // is truly unowned (nothing holds it) still needs its frames dropped rather
    // than thrown at a closed session, and `setHandlers` is exactly right for
    // that: no session is attached, so there is no other conversation to mute.
    try {
      entry.process.setHandlers({
        ...parkedSessionHandlers(() => this.forget(POOL_KEY)),
        onLog: () => {},
        onProtocolError: (message: string) => this.#log(`parked process protocol error: ${message}`),
      });
    } catch (error) {
      // Deliberately loud: a parked child that cannot be silenced would spray
      // frames at a closed session, and the old version swallowed this into a log
      // line while reporting success. The process is still killed — a refusal to
      // park must not leak a child — but the caller learns about it.
      this.#log(
        `parked:handlers ${entry.dshSessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      entry.process.kill();
      this.#markDying(entry.dshSessionId, entry.process);
      return false;
    }
    this.#pool.set(POOL_KEY, stored);
    this.#log(`parked:park ${entry.dshSessionId} (size ${this.#pool.size})`);
    this.#evictOverflow();
    return true;
  }

  /**
   * Take the parked process, if there is one and it is usable.
   *
   * The expectation is reported, not enforced: one process serves every cwd and
   * route, so a "mismatch" is not a reason to kill a healthy child any more. It
   * is only logged, because a caller whose route differs from the parked entry's
   * is still served correctly by `attachSession` pinning the route per session.
   *
   * @param dshSessionId - the session about to open (for the log line).
   * @param expected - that session's cwd and route (for the log line).
   * @returns the entry when one is usable, else undefined (cold start).
   */
  take(dshSessionId: string, expected: ParkedExpectation): ParkedEntry | undefined {
    const entry = this.#pool.get(POOL_KEY);
    if (entry === undefined) return undefined;
    this.#pool.delete(POOL_KEY);
    if (!entry.process.running) {
      this.#log(`parked:miss ${dshSessionId} (process gone)`);
      return undefined;
    }
    if (entry.cwd !== expected.cwd || entry.routeKey !== expected.routeKey) {
      // Informational only — the session's own attach pins its cwd and route, so
      // the difference cannot leak. Logged because a large divergence usually
      // means a session opened in a project it was not configured for.
      this.#log(
        `parked:take ${dshSessionId} (parked by a session in ${entry.cwd} on ${entry.routeKey}; this one uses ${expected.cwd} on ${expected.routeKey})`,
      );
    } else {
      this.#log(`parked:take ${dshSessionId}`);
    }
    return entry;
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

  /** Forget the parked entry whose process exited while parked. */
  forget(_dshSessionId?: string): void {
    const entry = this.#pool.get(POOL_KEY);
    if (entry === undefined) return;
    this.#pool.delete(POOL_KEY);
    this.#log(`parked:gone ${entry.dshSessionId}`);
  }

  /**
   * Drop an expired entry.
   *
   * An entry any session still holds is never expired: the TTL exists to bound a
   * child nobody adopted, and under one shared process "nobody adopted it" means
   * `busy === false`. Killing it otherwise would end live conversations.
   *
   * @returns how many were killed.
   */
  sweep(): number {
    const now = this.#now();
    let expired = 0;
    for (const [key, entry] of this.#pool) {
      if (now - entry.parkedAt < this.#ttlMs) continue;
      if (this.#holds > 0) {
        // Keep it: the pool's process is in use, and the TTL is about unused
        // children. Re-stamp so the check does not run on every sweep tick.
        entry.parkedAt = now;
        this.#log(`parked:keep ${entry.dshSessionId} (still held by ${this.#holds} session(s))`);
        continue;
      }
      this.#pool.delete(key);
      entry.process.kill();
      this.#markDying(entry.dshSessionId, entry.process);
      expired += 1;
      this.#log(`parked:expire ${entry.dshSessionId}`);
    }
    return expired;
  }

  /** Whether a process is currently parked (tests/diagnostics). */
  has(_dshSessionId?: string): boolean {
    return this.#pool.has(POOL_KEY);
  }

  /**
   * Kill and forget a parked process whose in-memory archive set is stale.
   *
   * DSH's `archived-session-gate` decides from `workspaceRegistry
   * .archivedSessionIds`, and that list only changes in the process that ran the
   * archive call — there is no cross-process invalidation. A parked process that
   * did not carry the change therefore keeps rejecting every turn of the session
   * it is about to be adopted for: the turn ends as `blocked` with no model
   * request, which reads in Paseo as "the turn ended with blocked".
   *
   * **Under one shared process this is a last resort, not a cleanup step.** The
   * pooled child is the process every open session is using, so dropping it would
   * end all of them. It therefore refuses while `busy` — the archive path must
   * write through the process that is actually serving the sessions instead (see
   * `provider.ts`'s holder-first ordering). A refusal is logged with its reason so
   * the caller can tell "nothing to drop" from "refused because in use".
   *
   * @param dshSessionId - DSH native session id (log only; there is one slot).
   * @param reason - why it is being dropped (goes to the log).
   * @returns whether an entry was dropped (a miss is not an error).
   */
  discard(dshSessionId: string, reason: string): boolean {
    const entry = this.#pool.get(POOL_KEY);
    if (entry === undefined) return false;
    if (this.#holds > 0) {
      this.#log(
        `parked:discard refused for ${dshSessionId} (${reason}): ${this.#holds} session(s) still hold the shared process`,
      );
      return false;
    }
    this.#pool.delete(POOL_KEY);
    entry.process.kill();
    this.#markDying(entry.dshSessionId, entry.process);
    this.#log(`parked:discard ${entry.dshSessionId} (${reason})`);
    return true;
  }

  /**
   * Remember a killed process until it is observed gone.
   *
   * Only used so {@link quiesce} can wait for the session lock's release; the list
   * is bounded because a process that never exits (a wedged child) must not grow it
   * without limit — the entry is dropped from the front when the cap is exceeded,
   * which only means a later open will not wait for that one.
   */
  #markDying(dshSessionId: string, process: DshProcess): void {
    this.#dying.push({ dshSessionId, process, gone: false });
    if (this.#dying.length > DYING_TRACK_LIMIT) {
      this.#dying.splice(0, this.#dying.length - DYING_TRACK_LIMIT);
    }
  }

  /**
   * Kill entries over the cap.
   *
   * A shared pool holds one process, so this is unreachable through the normal
   * path; it stays as the bound that keeps a bug (two processes parked by
   * accident) from becoming unbounded memory. It never evicts while any session
   * holds the process — that would kill conversations, which is exactly the
   * failure a per-session key used to cause here.
   */
  #evictOverflow(): void {
    while (this.#pool.size > this.#max) {
      if (this.#holds > 0) {
        this.#log(`parked:evict refused (${this.#holds} session(s) still hold the shared process)`);
        return;
      }
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.#pool) {
        if (entry.parkedAt < oldestAt) {
          oldestAt = entry.parkedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      const entry = this.#pool.get(oldestKey);
      this.#pool.delete(oldestKey);
      entry?.process.kill();
      if (entry !== undefined) this.#markDying(entry.dshSessionId, entry.process);
      this.#log(`parked:evict ${entry?.dshSessionId ?? oldestKey} (over cap ${this.#max})`);
    }
  }
}

export { DEFAULT_MAX, DEFAULT_TTL_MS, SWEEP_INTERVAL_MS };
