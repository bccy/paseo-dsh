/**
 * The server half of the three composer pills: one read per agent, pushed to
 * every subscriber that wants it.
 *
 * The client used to poll `jobs.list` / `goal.current` / `team.read` every four
 * seconds **per agent per client**. Paseo 0.16 lets the plugin serve the same
 * data as a subscription (`defineSubscription` + `server.handle` with `push` and
 * `signal`), so the reads moved here:
 *
 * - **One read per agent, however many clients watch it.** A subscriber joins an
 *   existing feed instead of starting its own; the second app window on the same
 *   host costs one extra push, not one extra read loop.
 * - **Nothing runs without a subscriber.** The feed starts on the first
 *   subscription and stops when the last one aborts: no timer, no read, no
 *   entry left behind. That is the rule the client poller enforced per agent
 *   (`clearTimer` + delete), now enforced once, on the side that owns the data.
 * - **Only changes are pushed.** Every event is a complete snapshot (see the
 *   contracts in `shared/`), so a dropped frame costs nothing more than waiting
 *   for the next one — and a snapshot that did not change is not pushed at all.
 *   That keeps the composer's button and an open popover from being rebuilt
 *   every few seconds, which is exactly why the client poller compared answers
 *   before publishing.
 * - **Failure is loud, never silent.** A read that reports `available: false` is
 *   pushed like any other answer (the client decides what a failed read means for
 *   its pill); a read that *throws* is reported on every failed attempt (one
 *   line each, no per-failure-streak dedup) and retried with backoff, because
 *   there is no answer to hand the client.
 * - **A terminal code stops the feed.** `bridge_too_old`, `goal_unavailable`,
 *   `team_unavailable`, `registry_missing` say retrying cannot help; the answer
 *   is pushed once and the timer stops (the client removes its pill on it). A new
 *   subscription is the fresh attempt — that is the host re-describing the world
 *   after a reconnect, when a plugin reload may have rewritten the bridge.
 *
 * The timing policy is the client poller's, kept deliberately: four seconds at
 * rest, exponential backoff on failure (4 → 8 → 16 → 30 s), jitter added so
 * agents that started together drift apart. What is gone is the *initial* jitter:
 * it existed to spread a burst of polls, and a subscription's first answer is
 * the state the user is waiting to see.
 *
 * Generic over the answer so the three contracts stay in their own modules; the
 * timer and the clock are injected so `harness/pill-feed-check.cjs` drives it
 * with a fake clock and no dsh at all.
 *
 * @module dsh-paseo/server/pill-feed
 */

/** Interval between two reads of one agent while subscribers are attached. */
export const FEED_INTERVAL_MS = 4000;

/** Ceiling for the exponential backoff after consecutive failed reads. */
export const FEED_MAX_INTERVAL_MS = 30_000;

/** Fraction of the base interval added as jitter, so agents do not fire together. */
export const FEED_JITTER_RATIO = 0.2;

/** Absolute cap on jitter, so a long backoff does not grow a second phase. */
export const FEED_MAX_JITTER_MS = 2000;

/** How long to wait before the next read; `failures` counts consecutive throws. */
export function nextFeedDelayMs(
  failures: number,
  random: () => number = Math.random,
  intervalMs: number = FEED_INTERVAL_MS,
  maxIntervalMs: number = FEED_MAX_INTERVAL_MS,
): number {
  const base = failures > 0 ? Math.min(intervalMs * 2 ** failures, maxIntervalMs) : intervalMs;
  const jitter = Math.floor(random() * Math.min(base * FEED_JITTER_RATIO, FEED_MAX_JITTER_MS));
  return base + jitter;
}

/** What one feed needs from its contract's module and from the host. */
export interface PillFeedHost<Answer> {
  /** Read one agent's answer — the existing `readAgentJobs`/`Goal`/`Team`. */
  read(agentId: string): Promise<Answer>;
  /**
   * Whether this answer's code means the feed should stop reading.
   *
   * Injected rather than imported so each contract keeps its own terminal set
   * (`TERMINAL_JOB_ERROR_CODES`, …) as the single source the client also reads.
   */
  isTerminal(answer: Answer): boolean;
  /**
   * Diagnostics: only a read that **threw** reaches this (a returned failure is
   * an answer and is pushed). `undefined` error means "recovered".
   */
  onError?(message: string, error?: unknown): void;
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** Injected so the harness can make the jitter deterministic. */
  random?(): number;
  /** Overrides for the harness; production uses the constants above. */
  intervalMs?: number;
  maxIntervalMs?: number;
}

/** The subscribers one agent currently has. */
type Listener<Answer> = {
  push(answer: Answer): void | Promise<void>;
  signal: AbortSignal;
  /** The abort listener, removed when the subscription ends for another reason. */
  onAbort: () => void;
};

/** One agent's shared read state. */
interface Entry<Answer> {
  readonly agentId: string;
  readonly listeners: Set<Listener<Answer>>;
  timer: unknown;
  hasTimer: boolean;
  /** A read is awaiting the daemon; a tick and a refresh both skip, not stack. */
  inFlight: boolean;
  /** A refresh asked for while a read was in flight; one more read costs nothing. */
  refreshAfterFlight: boolean;
  /** Consecutive reads that threw, driving the backoff and reset by a success. */
  failures: number;
  /**
   * The last answer handed to subscribers, and the one a late subscriber gets
   * immediately. `undefined` only before the first read settles.
   */
  lastAnswer: Answer | undefined;
  /** The signature of `lastAnswer`, so an unchanged read is not pushed twice. */
  lastSignature: string | undefined;
  /** A terminal answer: nothing more will be read until a new subscription. */
  terminal: boolean;
  /**
   * A push already failed for this entry.
   *
   * The failure line is written **once per transition into the failed state**, not
   * per push: a host whose subscriber is spent would otherwise print one line per
   * answer (every four seconds, per agent) — the same noise rule the client's
   * unreadable latch follows. A successful push resets it, so a later failure is
   * reported again.
   */
  pushFailed: boolean;
}

/** The feed the three subscription handlers in `index.server.ts` serve. */
export interface PillFeed<Answer> {
  /**
   * Attach one subscriber.
   *
   * The current snapshot is pushed immediately when there is one; otherwise the
   * first read starts now and pushes when it settles. `signal` aborting removes
   * the subscriber and stops the feed when it was the last one.
   */
  subscribe(agentId: string, push: Listener<Answer>["push"], signal: AbortSignal): void;
  /**
   * Re-read one agent now (after a control action that changed its data).
   *
   * Goes through the same in-flight guard, so pressing two buttons in a row
   * costs at most two reads; the unanswered second request is remembered and run
   * as soon as the first read settles.
   */
  refresh(agentId: string): void;
  /** Stop everything (plugin teardown). */
  dispose(): void;
}

/**
 * Create one feed. `index.server.ts` instantiates it once per contract.
 *
 * Entry identity is the agent id: the map owns the timer, the last answer and the
 * subscriber set, and every callback re-reads the map before acting, so a
 * removed agent's late read cannot schedule a timer for an entry nobody holds.
 */
export function createPillFeed<Answer>(host: PillFeedHost<Answer>): PillFeed<Answer> {
  const random = host.random ?? Math.random;
  const intervalMs = host.intervalMs ?? FEED_INTERVAL_MS;
  const maxIntervalMs = host.maxIntervalMs ?? FEED_MAX_INTERVAL_MS;
  const setTimer =
    host.setTimeout ??
    ((callback: () => void, delayMs: number): unknown => {
      const timer = setTimeout(callback, delayMs);
      // Node keeps the process alive for a pending timer; a plugin must not be
      // the reason the daemon never exits.
      (timer as unknown as { unref?: () => void }).unref?.();
      return timer;
    });
  const clearTimer =
    host.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const agents = new Map<string, Entry<Answer>>();
  let disposed = false;

  const report = (message: string, error?: unknown): void => {
    try {
      host.onError?.(message, error);
    } catch {
      /* a logging sink that throws must not break the feed */
    }
  };

  const clear = (entry: Entry<Answer>): void => {
    if (!entry.hasTimer) return;
    clearTimer(entry.timer);
    entry.timer = undefined;
    entry.hasTimer = false;
  };

  /** Drop one agent's whole entry, timer included. */
  const forget = (entry: Entry<Answer>): void => {
    clear(entry);
    agents.delete(entry.agentId);
  };

  const schedule = (entry: Entry<Answer>): void => {
    if (disposed || entry.terminal || entry.listeners.size === 0) return;
    clear(entry);
    entry.timer = setTimer(() => {
      void tick(entry);
    }, nextFeedDelayMs(entry.failures, random, intervalMs, maxIntervalMs));
    entry.hasTimer = true;
  };

  /**
   * A subscriber that cannot take an answer is gone — and **says so**.
   *
   * The host parses the event against the contract before delivering it
   * (`context.push` → `contract.event.parse`), so a shape mismatch is rejected
   * there, not thrown here. Without this line the only trace was a subscriber
   * silently disappearing: when it was the last one the feed stopped and the pill
   * froze with an empty log. One line per entry per transition (see
   * `Entry.pushFailed`), never one per answer.
   */
  const failPush = (entry: Entry<Answer>, listener: Listener<Answer>, error: unknown): void => {
    if (!entry.pushFailed) {
      entry.pushFailed = true;
      report("pill feed: pushing to a subscriber failed", error);
    }
    detach(entry, listener);
  };

  /**
   * Hand one answer to one subscriber; a subscriber that cannot take it is gone.
   *
   * @returns whether this push left the entry's state clean: `false` only for a
   * **synchronous** failure, because an async push's outcome is not known yet (the
   * rejection handler reports it, and `broadcast` re-arms the line on a clean
   * round). Aborting is a release, not a failure.
   */
  const deliver = (entry: Entry<Answer>, listener: Listener<Answer>, answer: Answer): boolean => {
    if (listener.signal.aborted) {
      detach(entry, listener);
      return true;
    }
    try {
      // `void | Promise<void>`: a synchronous push (a Paseo `context.push` is a
      // promise, a test double may be either) tells us nothing, an async one
      // rejects when the subscriber is gone.
      const pending = listener.push(answer) as Promise<void> | undefined;
      if (pending !== undefined) {
        void pending.catch((error: unknown) => {
          failPush(entry, listener, error);
        });
      }
      return true;
    } catch (error) {
      // The push itself threw synchronously (a closed surface): the subscriber is
      // spent, and the rest of the subscribers still get the answer.
      failPush(entry, listener, error);
      return false;
    }
  };

  /**
   * Hand one answer to every subscriber.
   *
   * A **clean** round re-arms the failure line (`pushFailed = false`), which is
   * what makes the line per *transition* rather than per entry lifetime — and a
   * round that had a failure keeps it armed, so two subscribers refusing the same
   * answer (one synchronous, one asynchronous) produce one line, not two.
   */
  const broadcast = (entry: Entry<Answer>, answer: Answer): void => {
    let clean = true;
    for (const listener of [...entry.listeners]) {
      if (!deliver(entry, listener, answer)) clean = false;
    }
    if (clean) entry.pushFailed = false;
  };

  /** Remove one subscriber; the last one takes the feed down with it. */
  function detach(entry: Entry<Answer>, listener: Listener<Answer>): void {
    if (!entry.listeners.delete(listener)) return;
    listener.signal.removeEventListener("abort", listener.onAbort);
    if (entry.listeners.size === 0) forget(entry);
  }

  /**
   * One read.
   *
   * Every branch either schedules exactly one next read or leaves the entry
   * stopped; there is no path that keeps an entry alive with no timer.
   */
  const tick = async (entry: Entry<Answer>): Promise<void> => {
    if (disposed || entry.terminal || entry.inFlight) return;
    if (entry.listeners.size === 0) {
      forget(entry);
      return;
    }
    entry.inFlight = true;
    entry.refreshAfterFlight = false;
    let answer: Answer;
    try {
      answer = await host.read(entry.agentId);
    } catch (error) {
      entry.inFlight = false;
      // Nobody left while we were reading: the entry is already gone.
      if (!agents.has(entry.agentId)) return;
      entry.failures += 1;
      report(`pill feed: reading ${entry.agentId} threw; retrying`, error);
      schedule(entry);
      return;
    }
    entry.inFlight = false;
    // A subscriber may have released while the read was in flight; the entry is
    // then already out of the map, and its timer must not be re-armed.
    if (!agents.has(entry.agentId)) return;
    entry.failures = 0;
    const signature = JSON.stringify(answer);
    if (signature !== entry.lastSignature) {
      entry.lastSignature = signature;
      entry.lastAnswer = answer;
      broadcast(entry, answer);
    }
    if (host.isTerminal(answer)) {
      // Push once, then stop: a terminal code cannot become a different answer by
      // waiting, and the client removes its pill on it. A later subscription
      // restarts the feed — that is the fresh attempt after a reload.
      entry.terminal = true;
      clear(entry);
      return;
    }
    if (entry.refreshAfterFlight) {
      entry.refreshAfterFlight = false;
      void tick(entry);
      return;
    }
    schedule(entry);
  };

  return {
    subscribe(agentId, push, signal): void {
      if (disposed || signal.aborted) return;
      const existing = agents.get(agentId);
      if (existing !== undefined && existing.terminal) {
        // A terminal answer is the truth until someone looks again. Push it to
        // the new subscriber (so it can remove its pill) and read nothing.
        const listener: Listener<Answer> = {
          push,
          signal,
          onAbort: () => detach(existing, listener),
        };
        existing.listeners.add(listener);
        signal.addEventListener("abort", listener.onAbort, { once: true });
        if (existing.lastAnswer !== undefined) deliver(existing, listener, existing.lastAnswer);
        return;
      }
      const entry = existing ?? {
        agentId,
        listeners: new Set<Listener<Answer>>(),
        timer: undefined,
        hasTimer: false,
        inFlight: false,
        refreshAfterFlight: false,
        failures: 0,
        lastAnswer: undefined,
        lastSignature: undefined,
        terminal: false,
        pushFailed: false,
      };
      const listener: Listener<Answer> = {
        push,
        signal,
        onAbort: () => detach(entry, listener),
      };
      entry.listeners.add(listener);
      signal.addEventListener("abort", listener.onAbort, { once: true });
      if (existing === undefined) {
        agents.set(agentId, entry);
        // The first subscriber is the reason the read exists; the snapshot is
        // pushed as soon as it settles, not on the next interval.
        void tick(entry);
        return;
      }
      // A second subscriber gets the answer this feed already has — no read.
      if (entry.lastAnswer !== undefined) deliver(entry, listener, entry.lastAnswer);
    },

    refresh(agentId): void {
      if (disposed) return;
      const entry = agents.get(agentId);
      if (entry === undefined || entry.terminal) return;
      if (entry.inFlight) {
        entry.refreshAfterFlight = true;
        return;
      }
      clear(entry);
      void tick(entry);
    },

    dispose(): void {
      disposed = true;
      for (const entry of [...agents.values()]) {
        clear(entry);
        for (const listener of [...entry.listeners]) {
          listener.signal.removeEventListener("abort", listener.onAbort);
        }
        entry.listeners.clear();
        agents.delete(entry.agentId);
      }
    },
  };
}