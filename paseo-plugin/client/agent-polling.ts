/**
 * The poll controller both composer pills drive: one timer per agent, one RPC per
 * timer, terminal errors stop it, a changed answer publishes and an unchanged one
 * does not.
 *
 * `jobs-pill.tsx` and `goal-pill.tsx` import the host runtime (React, React
 * Native, the plugin component library), so plain `node` cannot load them and
 * their behaviour could only be asserted through source regexes — which is
 * exactly how a rule that hid every finished job passed review. The state
 * machine lives here instead: no React, no host types, every dependency
 * injected.
 *
 * **Why this module is generic rather than jobs-specific.** The goal pill's
 * polling policy is the jobs pill's, verbatim (DESIGN §2: "节奏与 jobs 相同"):
 * a readable answer at the base rate with jitter, exponential backoff on
 * failure, a terminal error code that stops the timer, and an answer signature
 * so an unchanged poll does not repaint the composer. Copying that controller
 * would let the two drift — one fixes a stale-answer race and the other keeps
 * it — so the controller takes the payload as a type parameter and the terminal
 * code predicate as an injected function. `client/jobs-polling.ts` and
 * `client/goal-polling.ts` are thin adapters that keep their own payload shape
 * (a job list, a single goal) and their own presentation rules.
 *
 * **Why the timers are not `setInterval`s.** Every agent registered from one
 * snapshot used to create its interval in the same synchronous loop, so every
 * four seconds the daemon received a burst of identical requests. Each poll now
 * schedules the next one after it settles, with a per-agent random jitter: two
 * agents that started together drift apart and stay apart. Initial delays are
 * jittered too, so the first poll of a reconnect does not arrive as one batch.
 *
 * **The publish guard.** A successful poll that returns the same answer as the
 * previous one does not call `host.publishState`. That callback is what rebuilds
 * the popover's store row and calls `registration.update()`, and the host
 * republishes the button on every update. With the pills hidden whenever there
 * is nothing to show, "nothing to show" is the normal answer, so publishing it
 * every four seconds was a periodic repaint of the composer and the open popover
 * for no change at all. The comparison is a signature of the whole answer (see
 * `answerSignature`), so any real change still reaches the host.
 *
 * @module dsh-paseo/client/agent-polling
 */
import { PROVIDER_ID } from "../shared/provider";
import { isPermissionDeniedError } from "./jobs-popover-layout";
import { createPollSequence } from "./poll-sequence";

/**
 * Base interval for any readable answer, visible or hidden. The pill is hidden
 * whenever there is nothing to show, which is its normal state, so the hidden
 * probe must stay at the same rate: the old fifteen-second hidden interval
 * delayed a new job's appearance by up to four times the baseline's four
 * seconds.
 */
export const LIVE_POLL_MS = 4000;

/** Ceiling for the exponential backoff after consecutive failed reads. */
export const MAX_POLL_MS = 30_000;

/** Fraction of the base interval added as jitter, so agents do not fire together. */
export const POLL_JITTER_RATIO = 0.2;

/** Absolute cap on jitter, so a long backoff does not grow a second phase. */
export const MAX_POLL_JITTER_MS = 2000;

/** Upper bound of the random first delay; keeps a reconnect's first polls apart. */
export const INITIAL_POLL_JITTER_MS = 1000;

/** Safety cap on directory pagination (200 agents per page → 10,000 agents). */
export const MAX_AGENT_DIRECTORY_PAGES = 50;

/** One read's answer. `data` is absent on a failed read, never defaulted. */
export interface PollReadResult<D> {
  available: boolean;
  data?: D;
  error?: { message: string; code?: string };
}

/** One agent's state as the popover store keeps it. */
export interface PollViewState<D> {
  data: D;
  available: boolean;
  error?: string;
  code?: string;
}

/**
 * A poll answer as one comparable string.
 *
 * The host's `publishState` is not free: it replaces the popover's store row
 * (waking every listener, including an open popover) and calls
 * `registration.update()`, which the host republishes unconditionally. Under
 * the "hidden unless there is something to show" rule the normal answer is the
 * empty one, so an idle session would repaint the composer and an open popover
 * every four seconds. Both payloads are Zod-parsed, flat data (an array of
 * jobs, one goal object or `null`), so `JSON.stringify` is exact here: two
 * answers that render the same stringify the same.
 */
function answerSignature<D>(state: PollViewState<D>): string {
  return JSON.stringify([state.available, state.error ?? "", state.code ?? "", state.data]);
}

/** The fields of an agent a pill cares about. */
export interface PollAgent {
  id: string;
  workspaceId?: string | null;
  provider?: string;
  status?: string;
}

/** One page of the agent directory, structurally. */
export interface PollAgentPage {
  entries: readonly { agent: PollAgent }[];
  pageInfo?: { hasMore: boolean; nextCursor: string | null } | undefined;
}

/** Why an agent's pill was torn down; the host decides what to log. */
export type PollRemoveReason = "gone" | "unauthorized" | "terminal";

/**
 * How long to wait before the next poll.
 *
 * Every readable answer polls at {@link LIVE_POLL_MS}, hidden or visible — the
 * "hidden is normal" rule makes a slower hidden probe delay the next job's
 * appearance for no benefit. Failures back off exponentially from the base rate
 * (4 s → 8 s → 16 s → 30 s) and reset on the next readable answer. The jitter is
 * added, never subtracted, so the jittered interval is still at least the
 * policy's floor — the point is de-synchronisation, not a faster loop.
 *
 * `random` is injected so the rule is assertable without a clock.
 */
export function nextPollDelayMs(failures: number, random: () => number = Math.random): number {
  const base = failures > 0 ? Math.min(LIVE_POLL_MS * 2 ** failures, MAX_POLL_MS) : LIVE_POLL_MS;
  const jitter = Math.floor(random() * Math.min(base * POLL_JITTER_RATIO, MAX_POLL_JITTER_MS));
  return base + jitter;
}

/** The random delay before an agent's first poll, so a snapshot's batch spreads out. */
export function initialPollDelayMs(random: () => number = Math.random): number {
  return Math.floor(random() * INITIAL_POLL_JITTER_MS);
}

/**
 * The host half the poller needs.
 *
 * `setTimeout`/`clearTimeout` are injected so the controller can be driven by a
 * fake clock; `random` so jitter is deterministic in tests. Everything else is a
 * callback into the pill module, which owns the React store and the host
 * registration.
 */
export interface AgentPollerHost<D> {
  /** One point-in-time read; `available: false` means "could not look". */
  read(agentId: string): Promise<PollReadResult<D>>;
  /** One more directory page, only when the first snapshot said there is one. */
  listAgentPage(cursor: string): Promise<PollAgentPage>;
  addAgent(agent: PollAgent): void;
  removeAgent(agentId: string, reason: PollRemoveReason, error?: PollReadResult<D>["error"]): void;
  publishState(agentId: string, state: PollViewState<D>): void;
  onError(message: string, error?: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  random?: () => number;
  /**
   * Which error codes mean "retrying cannot help".
   *
   * Injected rather than imported: the two pills have their own terminal sets
   * (`TERMINAL_JOB_ERROR_CODES`, `TERMINAL_GOAL_ERROR_CODES`), and the controller
   * must not know either. A missing code is never terminal — a server half that
   * predates the codes keeps its normal retry.
   */
  isTerminalErrorCode(code: string | undefined): boolean;
  /**
   * The payload a failed read reports while it retries.
   *
   * A failed read carries the previous payload forward rather than a fabricated
   * one: the jobs pill keeps its last list, the goal pill keeps its last goal.
   */
  initialData: D;
  /**
   * Whether a transient (non-terminal) failure publishes its own state.
   *
   * `true` is the jobs behaviour: the pill stays visible and its popover says
   * "could not read". The goal pill passes `false` because DESIGN §2 says a
   * transient read error **keeps the last state** — a goal pill that flipped to
   * "could not read" for one bad poll would look like the goal changed, and a
   * goal that is still active would seem to have gone away. Terminal codes are
   * unaffected: they always remove the pill.
   */
  publishOnTransientError?: boolean;
  /**
   * The sentence a failed read reports when the runtime supplied none.
   *
   * Injected rather than composed here because it is user-visible copy that
   * predates this module: the jobs pill has always said "could not list this
   * session's jobs", and the generic wording this controller would otherwise
   * pick is a silent copy change for a surface the user already knows. Each
   * adapter passes its own sentence; `harness/jobs-poll-check.cjs` pins the jobs
   * one.
   */
  fallbackErrorMessage: string;
  /**
   * What this pill calls itself in diagnostics, e.g. `"jobs pill"`.
   *
   * Used only in `onError` lines, which reach the console and nothing else —
   * but they are how a user (or a later reader of the log) tells the two pills
   * apart, so the jobs wording is preserved verbatim rather than genericised.
   */
  pillLabel: string;
}

/** One agent's complete poll state. */
interface Entry<D> {
  readonly agentId: string;
  agent: PollAgent;
  timer: unknown;
  hasTimer: boolean;
  /** A read is awaiting the daemon; the next tick is skipped, not stacked. */
  inFlight: boolean;
  /** Consecutive failed reads, driving the backoff and reset by a success. */
  failures: number;
  lastData: D;
  /**
   * The last answer handed to the host, as {@link answerSignature}; `undefined`
   * before the first answer, so a fresh registration always publishes once.
   */
  lastPublished: string | undefined;
  /** A terminal contract error; this agent is not polled again until re-registered. */
  terminal: boolean;
}

/** The controller a pill drives from its agent subscription. */
export interface AgentPoller {
  /** The first page of an agent-directory snapshot; fetches the rest itself. */
  applySnapshot(page: PollAgentPage): Promise<void>;
  upsert(agent: PollAgent): void;
  drop(agentId: string): void;
  /**
   * Poll one agent right now, out of band.
   *
   * The goal popover uses this after a control action so the pill reflects the
   * new phase immediately instead of up to four seconds later. It goes through
   * the same tick as a scheduled poll, so the in-flight guard, the sequence
   * guard and the publish signature all still apply.
   */
  pollNow(agentId: string): Promise<void>;
  dispose(): void;
}

/**
 * Create the per-agent poll controller.
 *
 * The sequence guard is {@link createPollSequence} — the same global, monotonic
 * counter both pills use, so the teardown and stale-answer rules are shared.
 * Entry identity is implicit: every callback names the agent, and a removed
 * agent is absent from `agents`, so a late answer cannot write into a
 * re-registered entry.
 */
export function createAgentPoller<D>(host: AgentPollerHost<D>): AgentPoller {
  const random = host.random ?? Math.random;
  const sequence = createPollSequence();
  const agents = new Map<string, Entry<D>>();
  /**
   * Agents removed by an `agent_update` while a snapshot is still paginating.
   * The same `agent_update` could be followed by a later page that still lists
   * the agent; skipping tombstones keeps the removal from being undone by a
   * page that was already in flight when it happened.
   */
  const tombstones = new Set<string>();
  let generation = 0;
  let disposed = false;

  const clearTimer = (entry: Entry<D>): void => {
    if (!entry.hasTimer) return;
    host.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.hasTimer = false;
  };

  const schedule = (entry: Entry<D>, delayMs: number): void => {
    if (disposed || entry.terminal) return;
    clearTimer(entry);
    entry.timer = host.setTimeout(() => {
      void tick(entry).catch((error) => {
        if (!disposed) host.onError(`${host.pillLabel} poll failed for ${entry.agentId}`, error);
      });
    }, delayMs);
    entry.hasTimer = true;
  };

  const remove = (
    agentId: string,
    reason: PollRemoveReason,
    error?: PollReadResult<D>["error"],
  ): void => {
    const entry = agents.get(agentId);
    if (entry === undefined) return;
    agents.delete(agentId);
    clearTimer(entry);
    sequence.invalidate(agentId);
    host.removeAgent(agentId, reason, error);
  };

  const removeAll = (): void => {
    for (const agentId of [...agents.keys()]) remove(agentId, "gone");
  };

  /**
   * Hand one answer to the host, unless it is the same answer it already has.
   *
   * A poll that found nothing new must not publish: `publishState` rebuilds the
   * popover store row (waking its listeners) and updates the composer
   * registration, which the host republishes unconditionally. The signature
   * covers the whole answer, so any change — a job appearing or settling, a goal
   * changing phase — still goes through. The first answer always publishes:
   * there is no previous snapshot to compare against.
   */
  const publishIfChanged = (entry: Entry<D>, state: PollViewState<D>): void => {
    const signature = answerSignature(state);
    if (entry.lastPublished === signature) return;
    entry.lastPublished = signature;
    host.publishState(entry.agentId, state);
  };

  /**
   * Report a transient failure, unless the adapter asked to keep the last state.
   *
   * Skipping the publish also leaves `lastPublished` untouched, so the next
   * successful answer is compared against the last *published* one: an
   * unchanged goal after a flaky poll publishes nothing at all.
   */
  const publishTransient = (entry: Entry<D>, state: PollViewState<D>): void => {
    if (host.publishOnTransientError === false) return;
    publishIfChanged(entry, state);
  };

  /**
   * One poll. Every branch either schedules exactly one next poll or stops the
   * agent for good; there is no path that leaves an entry with no timer while
   * claiming to be active.
   */
  const tick = async (entry: Entry<D>): Promise<void> => {
    if (disposed || entry.terminal || entry.inFlight) return;
    entry.inFlight = true;
    const seq = sequence.issue(entry.agentId);
    /** Still the newest poll for this agent, and still the same live entry. */
    const current = (): boolean =>
      !disposed && agents.get(entry.agentId) === entry && sequence.isCurrent(entry.agentId, seq);
    try {
      const result = await host.read(entry.agentId);
      if (!current()) return;
      if (!result.available) {
        const error = result.error ?? { message: host.fallbackErrorMessage };
        if (host.isTerminalErrorCode(error.code)) {
          entry.terminal = true;
          clearTimer(entry);
          host.removeAgent(entry.agentId, "terminal", error);
          return;
        }
        entry.failures += 1;
        publishTransient(entry, {
          data: entry.lastData,
          available: false,
          error: error.message,
          ...(error.code === undefined ? {} : { code: error.code }),
        });
        schedule(entry, nextPollDelayMs(entry.failures, random));
        return;
      }
      const data = result.data ?? host.initialData;
      entry.failures = 0;
      entry.lastData = data;
      publishIfChanged(entry, { data, available: true });
      schedule(entry, nextPollDelayMs(0, random));
    } catch (error) {
      if (!current()) return;
      if (isPermissionDeniedError(error)) {
        /**
         * Terminal for this registration, not for the agent: a reconnect can
         * come back with wider permissions. Drop the entry (and with it the
         * pill) so the next upsert creates a fresh one and polls again; keeping
         * a hidden entry would leave a registration nobody re-shows.
         */
        remove(entry.agentId, "unauthorized");
        return;
      }
      entry.failures += 1;
      publishTransient(entry, {
        data: entry.lastData,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      });
      schedule(entry, nextPollDelayMs(entry.failures, random));
    } finally {
      // Only the newest poll may clear the flag, or a removal/re-registration
      // could let two requests overlap.
      if (sequence.isCurrent(entry.agentId, seq)) entry.inFlight = false;
    }
  };

  const register = (agent: PollAgent): void => {
    if (disposed) return;
    // Only this provider's agents have DSH jobs/goals. Registering for every
    // agent would put a pill on Claude/Codex composers that can only ever be
    // empty. Both pills serve the same provider, so the filter is here rather
    // than repeated in each adapter.
    if (agent.provider !== undefined && agent.provider !== PROVIDER_ID) return;
    if ((agent.workspaceId ?? "") === "") return;
    if (agent.status === "closed") {
      remove(agent.id, "gone");
      return;
    }
    const existing = agents.get(agent.id);
    if (existing !== undefined) {
      existing.agent = agent;
      return;
    }
    const entry: Entry<D> = {
      agentId: agent.id,
      agent,
      timer: undefined,
      hasTimer: false,
      inFlight: false,
      failures: 0,
      lastData: host.initialData,
      lastPublished: undefined,
      terminal: false,
    };
    agents.set(agent.id, entry);
    host.addAgent(agent);
    schedule(entry, initialPollDelayMs(random));
  };

  const registerPage = (page: PollAgentPage): void => {
    for (const { agent } of page.entries) {
      if (!tombstones.has(agent.id)) register(agent);
    }
  };

  return {
    async applySnapshot(page: PollAgentPage): Promise<void> {
      if (disposed) return;
      const mine = ++generation;
      tombstones.clear();
      removeAll();
      registerPage(page);
      let hasMore = page.pageInfo?.hasMore === true;
      let cursor = page.pageInfo?.nextCursor ?? null;
      let pages = 0;
      while (hasMore && cursor !== null) {
        if (disposed || mine !== generation) return;
        if (pages >= MAX_AGENT_DIRECTORY_PAGES) {
          host.onError(`agent directory pagination did not terminate; the ${host.pillLabel} sees only the first pages`);
          return;
        }
        let nextPage: PollAgentPage;
        try {
          nextPage = await host.listAgentPage(cursor);
        } catch (error) {
          if (!disposed && mine === generation) host.onError("could not read the next page of agents", error);
          return;
        }
        if (disposed || mine !== generation) return;
        registerPage(nextPage);
        hasMore = nextPage.pageInfo?.hasMore === true;
        cursor = nextPage.pageInfo?.nextCursor ?? null;
        pages += 1;
      }
      if (hasMore && cursor === null && !disposed && mine === generation) {
        host.onError("agent directory reported more pages without a next cursor");
      }
    },

    upsert(agent: PollAgent): void {
      register(agent);
    },

    drop(agentId: string): void {
      tombstones.add(agentId);
      remove(agentId, "gone");
    },

    async pollNow(agentId: string): Promise<void> {
      const entry = agents.get(agentId);
      if (entry === undefined || disposed || entry.terminal) return;
      // The tick keeps its own in-flight guard: a refresh that lands while a
      // scheduled poll is still awaiting the daemon is a no-op rather than a
      // second request. Its result arrives with that poll's publish.
      await tick(entry);
    },

    dispose(): void {
      disposed = true;
      removeAll();
    },
  };
}
