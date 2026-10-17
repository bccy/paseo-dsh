/**
 * A short-lived pool of idle DSH processes, so a rewind's agent reload does not
 * pay for a cold start.
 *
 * Paseo's documented refresh semantics are "close the current provider session
 * and open it again with persistence". A naive implementation kills the `dsh`
 * child on close and spawns a new one on open: that spawn + profile load is the
 * 1.5–2.7 s half of the refresh latency. The bridge's protocol state and the
 * agent's session log do not need a new process, though — an idle child can be
 * handed to the next provider session unchanged.
 *
 * The pool is deliberately small and short-lived:
 *
 * - only idle sessions are parked (a running turn would keep emitting into a
 *   timeline nobody is showing);
 * - a parked entry is reused only from the same cwd and route, so a reload with
 *   a different configuration still cold-starts;
 * - TTL (30 s) bounds an entry that is never adopted (the daemon crashed, the
 *   agent was closed for real); the cap (3) bounds memory;
 * - adoption is keyed by DSH's native session id, which persistence preserves
 *   across a reload and across imported sessions.
 *
 * A miss is never an error: the caller cold-starts, exactly as before.
 *
 * @module dsh-paseo/server/parked-sessions
 */

import type { DshProcess } from "./dsh-process";

/** One idle process waiting for its next provider session. */
export interface ParkedEntry {
  process: DshProcess;
  /** Provider session id that owned the process before parking. */
  sessionId: string;
  /** DSH native session id, the pool key. */
  dshSessionId: string;
  cwd: string;
  /** `provider/model/reasoningEffort`, to refuse reuse under a different route. */
  routeKey: string;
  parkedAt: number;
}

/** What a caller expects to find when it asks the pool for a process. */
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
const DEFAULT_MAX = 3;
const SWEEP_INTERVAL_MS = 5_000;

/** The no-op handler set a parked (unowned) process reports to. */
function silentHandlers(entry: { forget: () => void }, log: (line: string) => void) {
  return {
    onEvent: () => {},
    onStatus: () => {},
    onQuestion: async () => ({ answers: [] as never[] }),
    onLog: () => {},
    onExit: () => entry.forget(),
    onProtocolError: (message: string) => log(`parked process protocol error: ${message}`),
  };
}

export class ParkedSessions {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #pool = new Map<string, ParkedEntry>();
  #timer: ReturnType<typeof setInterval> | undefined;

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
  }

  /**
   * Offer one idle process for reuse.
   *
   * The process is silenced (stray frames are dropped) and reports its own exit
   * to this pool, so a crashed parked child is never handed out. Re-parking the
   * same native session replaces the older entry (and kills it).
   *
   * @returns whether the process was accepted.
   */
  park(entry: Omit<ParkedEntry, "parkedAt">): boolean {
    const existing = this.#pool.get(entry.dshSessionId);
    if (existing !== undefined) {
      this.#log(`parked:replace ${entry.dshSessionId}`);
      existing.process.kill();
      this.#pool.delete(entry.dshSessionId);
    }
    if (!entry.process.running) return false;
    const stored: ParkedEntry = { ...entry, parkedAt: this.#now() };
    try {
      entry.process.setHandlers(
        silentHandlers(
          { forget: () => this.forget(entry.dshSessionId) },
          this.#log,
        ),
      );
    } catch (error) {
      this.#log(`parked:handlers ${entry.dshSessionId}: ${error instanceof Error ? error.message : String(error)}`);
      entry.process.kill();
      return false;
    }
    this.#pool.set(entry.dshSessionId, stored);
    this.#log(`parked:park ${entry.dshSessionId} (size ${this.#pool.size})`);
    this.#evictOverflow();
    return true;
  }

  /**
   * Take a parked process for one native session id.
   *
   * A process parked under a different cwd/route is killed instead of reused:
   * a reload normally keeps the configuration, and reusing a process initialized
   * for another route would silently serve the old one.
   *
   * @param dshSessionId - DSH native session id.
   * @param expected - the cwd and route the new session is about to use.
   * @returns the process when one is usable, else undefined (cold start).
   */
  take(dshSessionId: string, expected: ParkedExpectation): ParkedEntry | undefined {
    const entry = this.#pool.get(dshSessionId);
    if (entry === undefined) return undefined;
    this.#pool.delete(dshSessionId);
    if (!entry.process.running) {
      this.#log(`parked:miss ${dshSessionId} (process gone)`);
      return undefined;
    }
    if (entry.cwd !== expected.cwd || entry.routeKey !== expected.routeKey) {
      this.#log(
        `parked:mismatch ${dshSessionId} (cwd ${entry.cwd === expected.cwd ? "same" : "different"}, route ${entry.routeKey} -> ${expected.routeKey}), killing`,
      );
      entry.process.kill();
      return undefined;
    }
    this.#log(`parked:take ${dshSessionId}`);
    return entry;
  }

  /** Forget an entry whose process exited while parked. */
  forget(dshSessionId: string): void {
    const entry = this.#pool.get(dshSessionId);
    if (entry === undefined) return;
    this.#pool.delete(dshSessionId);
    this.#log(`parked:gone ${dshSessionId}`);
  }

  /** Drop expired entries. @returns how many were killed. */
  sweep(): number {
    const now = this.#now();
    let expired = 0;
    for (const [key, entry] of this.#pool) {
      if (now - entry.parkedAt < this.#ttlMs) continue;
      this.#pool.delete(key);
      entry.process.kill();
      expired += 1;
      this.#log(`parked:expire ${key}`);
    }
    return expired;
  }

  /** Whether one native session id is currently parked (tests/diagnostics). */
  has(dshSessionId: string): boolean {
    return this.#pool.has(dshSessionId);
  }

  /** Kill the oldest entries over the cap. */
  #evictOverflow(): void {
    while (this.#pool.size > this.#max) {
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
      this.#log(`parked:evict ${oldestKey} (over cap ${this.#max})`);
    }
  }
}

export { DEFAULT_MAX, DEFAULT_TTL_MS, SWEEP_INTERVAL_MS };
