/**
 * The jobs pill's poll controller and its presentation rule.
 *
 * `jobs-pill.tsx` imports the host runtime (React, React Native, the plugin
 * component library), so plain `node` cannot load it and its behaviour could
 * only be asserted through source regexes — which is exactly how a rule that
 * hid every finished job passed review. The state machine lives here instead:
 * no React, no host types, every dependency injected. The JSX file keeps the
 * rendering, the registration and the store the popover subscribes to.
 *
 * **Three policies live here, one reason each.**
 *
 * - {@link jobsPillPresentation}: when the pill is visible, what it counts, and
 *   whether the icon spins. It mirrors DSH's own job list — any job (live or
 *   settled) makes the trigger visible, a live job makes it count live rows,
 *   and an idle trigger counts the retained history (`count.idle.*` in
 *   `dsh-client-ui-jobs/lib/client.js`). Counting only live rows made the
 *   finished section unreachable: the last job settling hid the pill, so the
 *   group the popover draws history into could never be opened.
 * - {@link nextPollDelayMs}: one timer per agent is also one RPC per agent, so
 *   the interval follows what the answer is worth. A hidden pill polls slowly,
 *   a visible one at the base rate, and a failing read backs off so a broken
 *   runtime is not asked the same question every four seconds forever.
 * - {@link isTerminalJobsErrorCode}: a bridge that predates `paseo/jobs` will
 *   not grow the method while the process lives. Retrying is not a slow path to
 *   success, it is a permanent error pill; the codes come from the shared
 *   contract so server and client cannot disagree about which are terminal.
 *
 * **Why the timers are not `setInterval`s.** Every agent registered from one
 * snapshot used to create its interval in the same synchronous loop, so every
 * four seconds the daemon received a burst of identical requests. Each poll now
 * schedules the next one after it settles, with a per-agent random jitter: two
 * agents that started together drift apart and stay apart. Initial delays are
 * jittered too, so the first poll of a reconnect does not arrive as one batch.
 *
 * @module dsh-paseo/client/jobs-polling
 */
import { LIVE_JOB_STATUSES, TERMINAL_JOB_ERROR_CODES } from "../shared/jobs";
import { PROVIDER_ID } from "../shared/provider";
import { isPermissionDeniedError } from "./jobs-popover-layout";
import { createPollSequence } from "./poll-sequence";

/**
 * Base interval while the pill is visible: fast enough that a job the user just
 * started appears on it, slow enough that a screen full of agents is not a
 * steady stream of IPC.
 */
export const LIVE_POLL_MS = 4000;

/**
 * Interval while the pill is hidden (no job at all). The pill has nothing to
 * show, so a slower probe is enough to notice the next job; fifteen seconds is
 * the low end of the range the 2026-10-31 audit suggested for `count === 0`.
 */
export const HIDDEN_POLL_MS = 15_000;

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

/** The slice of a job the pill's presentation rule needs. */
export interface JobLike {
  status: string;
}

/** One read's answer, mirroring the `jobsList` contract. */
export interface JobsReadResult<J extends JobLike = JobLike> {
  available: boolean;
  jobs?: readonly J[];
  error?: { message: string; code?: string };
}

/** One agent's state as the popover store keeps it. */
export interface JobsViewState<J extends JobLike = JobLike> {
  jobs: readonly J[];
  available: boolean;
  error?: string;
  code?: string;
}

/** The fields of an agent the pill cares about. */
export interface JobsAgent {
  id: string;
  workspaceId?: string | null;
  provider?: string;
  status?: string;
}

/** One page of the agent directory, structurally. */
export interface JobsAgentPage {
  entries: readonly { agent: JobsAgent }[];
  pageInfo?: { hasMore: boolean; nextCursor: string | null } | undefined;
}

/**
 * What the pill should show for one answer.
 *
 * A discriminated union rather than a count plus a boolean: the title case has
 * no number at all, and a `count: undefined` that a call site forgot to check
 * would render "undefined background".
 */
export type PillLabel =
  | { readonly kind: "title" }
  | { readonly kind: "live"; readonly count: number }
  | { readonly kind: "idle"; readonly count: number };

/** The pill's visibility, icon state and label key for one answer. */
export interface PillPresentation {
  visible: boolean;
  spinning: boolean;
  label: PillLabel;
}

/**
 * When the pill is visible and what it counts.
 *
 * `available: false` keeps the pill visible: an unreadable registry is not
 * "nothing running", and a pill that silently disappears when the runtime is
 * broken is the failure this repo keeps finding. With a readable answer the
 * pill appears for **any** job — the finished ones included, which is what
 * makes the popover's finished section reachable after the last job settles.
 *
 * The spinner means work is happening, so only live rows turn it; an idle pill
 * carries the static mark. The label still says the total, matching DSH's
 * `count.idle.*` phrases.
 */
export function jobsPillPresentation(answer: {
  available: boolean;
  jobs?: readonly JobLike[];
}): PillPresentation {
  const jobs = answer.jobs ?? [];
  if (!answer.available) return { visible: true, spinning: false, label: { kind: "title" } };
  const live = jobs.filter((job) => isLive(job.status)).length;
  if (live > 0) return { visible: true, spinning: true, label: { kind: "live", count: live } };
  if (jobs.length === 0) return { visible: false, spinning: false, label: { kind: "title" } };
  return { visible: true, spinning: false, label: { kind: "idle", count: jobs.length } };
}

/**
 * Whether a status belongs to the live half.
 *
 * Read from the shared list rather than spelled again: the visibility rule and
 * the popover's split must agree on which statuses are still doing work, and a
 * second literal pair is exactly the drift `LIVE_JOB_STATUSES` exists to stop.
 */
function isLive(status: string): boolean {
  return (LIVE_JOB_STATUSES as readonly string[]).includes(status);
}

/**
 * How long to wait before the next poll.
 *
 * Failures back off exponentially from the base rate (4 s → 8 s → 16 s → 30 s)
 * and reset on the next readable answer. A visible pill polls at the base rate;
 * a hidden one at {@link HIDDEN_POLL_MS}. The jitter is added, never subtracted,
 * so the jittered interval is still at least the policy's floor — the point is
 * de-synchronisation, not a faster loop.
 *
 * `random` is injected so the rule is assertable without a clock.
 */
export function nextPollDelayMs(
  state: { visible: boolean; failures: number },
  random: () => number = Math.random,
): number {
  const base =
    state.failures > 0
      ? Math.min(LIVE_POLL_MS * 2 ** state.failures, MAX_POLL_MS)
      : state.visible
        ? LIVE_POLL_MS
        : HIDDEN_POLL_MS;
  const jitter = Math.floor(random() * Math.min(base * POLL_JITTER_RATIO, MAX_POLL_JITTER_MS));
  return base + jitter;
}

/** The random delay before an agent's first poll, so a snapshot's batch spreads out. */
export function initialPollDelayMs(random: () => number = Math.random): number {
  return Math.floor(random() * INITIAL_POLL_JITTER_MS);
}

/**
 * Whether an error code means "retrying cannot help".
 *
 * Both terminal codes need a human action — rewrite the embedded bridge, or fix
 * a profile that composes no job registry — so the caller stops the timer and
 * hides the pill instead of retrying every few seconds.
 */
export function isTerminalJobsErrorCode(code: string | undefined): boolean {
  return code !== undefined && (TERMINAL_JOB_ERROR_CODES as readonly string[]).includes(code);
}

/** Why an agent's pill was torn down; the host decides what to log. */
export type JobsRemoveReason = "gone" | "unauthorized" | "terminal";

/**
 * The host half the poller needs.
 *
 * `setTimeout`/`clearTimeout` are injected so the controller can be driven by a
 * fake clock; `random` so jitter is deterministic in tests. Everything else is
 * a callback into `jobs-pill.tsx`, which owns the React store and the host
 * registration.
 */
export interface JobsPollerHost<J extends JobLike = JobLike> {
  readJobs(agentId: string): Promise<JobsReadResult<J>>;
  /** One more directory page, only when the first snapshot said there is one. */
  listAgentPage(cursor: string): Promise<JobsAgentPage>;
  addAgent(agent: JobsAgent): void;
  removeAgent(agentId: string, reason: JobsRemoveReason, error?: JobsReadResult["error"]): void;
  publishState(agentId: string, state: JobsViewState<J>): void;
  onError(message: string, error?: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  random?: () => number;
}

/** One agent's complete poll state. */
interface Entry<J extends JobLike> {
  readonly agentId: string;
  agent: JobsAgent;
  timer: unknown;
  hasTimer: boolean;
  /** A read is awaiting the daemon; the next tick is skipped, not stacked. */
  inFlight: boolean;
  /** Consecutive failed reads, driving the backoff and reset by a success. */
  failures: number;
  lastJobs: readonly J[];
  /** Whether the last readable answer carried at least one job. */
  lastVisible: boolean;
  /** A terminal contract error; this agent is not polled again until re-registered. */
  terminal: boolean;
}

/** The controller `jobs-pill.tsx` drives from its agent subscription. */
export interface JobsPoller {
  /** The first page of an agent-directory snapshot; fetches the rest itself. */
  applySnapshot(page: JobsAgentPage): Promise<void>;
  upsert(agent: JobsAgent): void;
  drop(agentId: string): void;
  dispose(): void;
}

/**
 * Create the per-agent poll controller.
 *
 * The sequence guard is {@link createPollSequence} — the same global, monotonic
 * counter the pill used before this refactor, so the teardown and stale-answer
 * rules are unchanged. Entry identity is implicit: every callback names the
 * agent, and a removed agent is absent from `agents`, so a late answer cannot
 * write into a re-registered entry.
 */
export function createJobsPoller<J extends JobLike>(
  host: JobsPollerHost<J>,
): JobsPoller {
  const random = host.random ?? Math.random;
  const sequence = createPollSequence();
  const agents = new Map<string, Entry<J>>();
  /**
   * Agents removed by an `agent_update` while a snapshot is still paginating.
   * The same `agent_update` could be followed by a later page that still lists
   * the agent; skipping tombstones keeps the removal from being undone by a
   * page that was already in flight when it happened.
   */
  const tombstones = new Set<string>();
  let generation = 0;
  let disposed = false;

  const clearTimer = (entry: Entry<J>): void => {
    if (!entry.hasTimer) return;
    host.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.hasTimer = false;
  };

  const schedule = (entry: Entry<J>, delayMs: number): void => {
    if (disposed || entry.terminal) return;
    clearTimer(entry);
    entry.timer = host.setTimeout(() => {
      void tick(entry).catch((error) => {
        if (!disposed) host.onError(`jobs pill poll failed for ${entry.agentId}`, error);
      });
    }, delayMs);
    entry.hasTimer = true;
  };

  const remove = (agentId: string, reason: JobsRemoveReason, error?: JobsReadResult["error"]): void => {
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
   * One poll. Every branch either schedules exactly one next poll or stops the
   * agent for good; there is no path that leaves an entry with no timer while
   * claiming to be active.
   */
  const tick = async (entry: Entry<J>): Promise<void> => {
    if (disposed || entry.terminal || entry.inFlight) return;
    entry.inFlight = true;
    const seq = sequence.issue(entry.agentId);
    /** Still the newest poll for this agent, and still the same live entry. */
    const current = (): boolean =>
      !disposed && agents.get(entry.agentId) === entry && sequence.isCurrent(entry.agentId, seq);
    try {
      const result = await host.readJobs(entry.agentId);
      if (!current()) return;
      if (!result.available) {
        const error = result.error ?? { message: "the DSH runtime could not list this session's jobs" };
        if (isTerminalJobsErrorCode(error.code)) {
          entry.terminal = true;
          clearTimer(entry);
          host.removeAgent(entry.agentId, "terminal", error);
          return;
        }
        entry.failures += 1;
        host.publishState(entry.agentId, {
          jobs: entry.lastJobs,
          available: false,
          error: error.message,
          ...(error.code === undefined ? {} : { code: error.code }),
        });
        schedule(entry, nextPollDelayMs({ visible: entry.lastVisible, failures: entry.failures }, random));
        return;
      }
      const jobs = result.jobs ?? [];
      entry.failures = 0;
      entry.lastJobs = jobs;
      entry.lastVisible = jobs.length > 0;
      host.publishState(entry.agentId, { jobs, available: true });
      schedule(entry, nextPollDelayMs({ visible: entry.lastVisible, failures: 0 }, random));
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
      host.publishState(entry.agentId, {
        jobs: entry.lastJobs,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      });
      schedule(entry, nextPollDelayMs({ visible: entry.lastVisible, failures: entry.failures }, random));
    } finally {
      // Only the newest poll may clear the flag, or a removal/re-registration
      // could let two requests overlap.
      if (sequence.isCurrent(entry.agentId, seq)) entry.inFlight = false;
    }
  };

  const register = (agent: JobsAgent): void => {
    if (disposed) return;
    // Only this provider's agents have DSH jobs. Registering for every agent
    // would put a pill on Claude/Codex composers that can only ever be empty.
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
    const entry: Entry<J> = {
      agentId: agent.id,
      agent,
      timer: undefined,
      hasTimer: false,
      inFlight: false,
      failures: 0,
      lastJobs: [],
      lastVisible: false,
      terminal: false,
    };
    agents.set(agent.id, entry);
    host.addAgent(agent);
    schedule(entry, initialPollDelayMs(random));
  };

  const registerPage = (page: JobsAgentPage): void => {
    for (const { agent } of page.entries) {
      if (!tombstones.has(agent.id)) register(agent);
    }
  };

  return {
    async applySnapshot(page: JobsAgentPage): Promise<void> {
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
          host.onError("agent directory pagination did not terminate; the jobs pill sees only the first pages");
          return;
        }
        let nextPage: JobsAgentPage;
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

    upsert(agent: JobsAgent): void {
      register(agent);
    },

    drop(agentId: string): void {
      tombstones.add(agentId);
      remove(agentId, "gone");
    },

    dispose(): void {
      disposed = true;
      removeAll();
    },
  };
}
