/**
 * The jobs pill's poll policy, its presentation rule, and the adapter that
 * binds both to the shared poll controller.
 *
 * `jobs-pill.tsx` imports the host runtime (React, React Native, the plugin
 * component library), so plain `node` cannot load it and its behaviour could
 * only be asserted through source regexes — which is exactly how a rule that
 * hid every finished job passed review. The controller lives in
 * `client/agent-polling.ts` (shared with the goal pill, whose polling policy is
 * this one); this module keeps the two jobs-specific halves:
 *
 * - {@link jobsPillPresentation}: when the pill is visible, what it counts, and
 *   which mark sits in its icon slot. By the product rule (route 2 of CJ-01) it
 *   is a **live indicator**: a running or stopping job makes the trigger
 *   visible and counts live rows; the moment the last job settles the pill
 *   hides. The registry keeps settled history for the popover, but the pill
 *   itself never advertises an idle total. The icon is the turning ring for
 *   every readable answer; the static mark is reserved for `available: false`,
 *   matching baseline 2f71225.
 * - {@link createJobsPoller}: the jobs payload adapter. A jobs answer is a
 *   list, a goal answer is one object; the controller is generic over that
 *   payload, so this adapter is what keeps the pill's `{jobs, available, error,
 *   code}` state shape unchanged.
 *
 * The terminal-code predicate is `isTerminalJobsErrorCode`; the codes come from
 * the shared contract so server and client cannot disagree about which are
 * terminal. The polling cadence, backoff, jitter and answer-signature rules are
 * re-exported from `client/agent-polling.ts` so existing call sites and
 * `harness/jobs-poll-check.cjs` keep reading them from here.
 *
 * @module dsh-paseo/client/jobs-polling
 */
import {
  createAgentPoller,
  initialPollDelayMs,
  nextPollDelayMs,
  type AgentPoller,
  type AgentPollerHost,
  type PollAgent,
  type PollAgentPage,
  type PollRemoveReason,
  type PollViewState,
} from "./agent-polling";
import { LIVE_JOB_STATUSES, TERMINAL_JOB_ERROR_CODES } from "../shared/jobs";

export {
  INITIAL_POLL_JITTER_MS,
  LIVE_POLL_MS,
  MAX_AGENT_DIRECTORY_PAGES,
  MAX_POLL_JITTER_MS,
  MAX_POLL_MS,
  POLL_JITTER_RATIO,
  initialPollDelayMs,
  nextPollDelayMs,
} from "./agent-polling";

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
export type JobsAgent = PollAgent;

/** One page of the agent directory, structurally. */
export type JobsAgentPage = PollAgentPage;

/** Why an agent's pill was torn down; the host decides what to log. */
export type JobsRemoveReason = PollRemoveReason;

/**
 * What the pill should show for one answer.
 *
 * A discriminated union rather than a count plus a boolean: the title case has
 * no number at all, and a `count: undefined` that a call site forgot to check
 * would render "undefined background".
 */
export type PillLabel =
  | { readonly kind: "title" }
  | { readonly kind: "live"; readonly count: number };

/** The mark the pill's icon slot carries for one answer. */
export type PillIcon = "spinner" | "static";

/** The pill's visibility, icon mark and label key for one answer. */
export interface PillPresentation {
  visible: boolean;
  icon: PillIcon;
  label: PillLabel;
}

/**
 * The jobs pill's label for one presentation.
 *
 * The composer trigger reads the bare noun 「后台」/「Background」 in **every**
 * visible state — running, stopping, an unreadable registry: the user decided
 * (2026-11-05) that the pill never carries a count or a status word. The ring
 * on the icon says it is working; the popover says how many. The presentation
 * is taken so the rule is stated (and checked) per presentation; by design the
 * label does not read it.
 *
 * The text is passed in (structurally) so this module keeps no locale import.
 */
export function jobsPillCopy(
  _presentation: { readonly label: PillLabel },
  text: { readonly pillLabel: string },
): { label: string } {
  return { label: text.pillLabel };
}

/**
 * When the pill is visible, what it counts, and which mark its icon carries.
 *
 * **The pill is a live indicator.** A running or stopping job makes it visible
 * and the label counts those live rows. With no live job it is hidden, however
 * many settled rows the registry still remembers — the finished history belongs
 * to the popover, not to the composer's trigger. This is the product rule the
 * user set for this surface; it is route 2 of CJ-01.
 *
 * **The icon is the turning ring on every readable answer**, visible or hidden.
 * Tracking one constant for the whole readable half means `update()` never
 * swaps a static mark into the slot; the ring is this UI's word for a job
 * surface, and a static icon here would read as "nothing works". The one
 * exception is `available: false`: the pill stays visible so the popover can
 * explain the broken registry, and it keeps baseline 2f71225's static mark
 * because a turning ring would claim progress that is not happening.
 */
export function jobsPillPresentation(answer: {
  available: boolean;
  jobs?: readonly JobLike[];
}): PillPresentation {
  const jobs = answer.jobs ?? [];
  if (!answer.available) return { visible: true, icon: "static", label: { kind: "title" } };
  const live = jobs.filter((job) => isLive(job.status)).length;
  if (live > 0) return { visible: true, icon: "spinner", label: { kind: "live", count: live } };
  return { visible: false, icon: "spinner", label: { kind: "title" } };
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
 * Whether an error code means "retrying cannot help".
 *
 * Both terminal codes need a human action — rewrite the embedded bridge, or fix
 * a profile that composes no job registry — so the caller stops the timer and
 * hides the pill instead of retrying every few seconds.
 */
export function isTerminalJobsErrorCode(code: string | undefined): boolean {
  return code !== undefined && (TERMINAL_JOB_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * The host half the jobs pill's poller needs.
 *
 * Same shape as before the controller was shared: the jobs adapter owns the
 * `{jobs}` payload and the pill module owns the React store and the host
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

/** The controller `jobs-pill.tsx` drives from its agent subscription. */
export type JobsPoller = AgentPoller;

/**
 * Create the per-agent jobs poll controller.
 *
 * A thin adapter over {@link createAgentPoller}: it maps the jobs answer to the
 * controller's generic payload and back, and hands it the jobs terminal-code
 * predicate. Behaviour is the controller's, so a rule fixed there is fixed for
 * both pills.
 */
export function createJobsPoller<J extends JobLike>(host: JobsPollerHost<J>): JobsPoller {
  const adapter: AgentPollerHost<readonly J[]> = {
    read: async (agentId) => {
      const result = await host.readJobs(agentId);
      if (!result.available) return { available: false, error: result.error };
      return { available: true, data: result.jobs ?? [] };
    },
    listAgentPage: (cursor) => host.listAgentPage(cursor),
    addAgent: (agent) => host.addAgent(agent),
    removeAgent: (agentId, reason, error) => host.removeAgent(agentId, reason, error),
    publishState: (agentId, state: PollViewState<readonly J[]>) => {
      host.publishState(agentId, {
        jobs: state.data,
        available: state.available,
        ...(state.error === undefined ? {} : { error: state.error }),
        ...(state.code === undefined ? {} : { code: state.code }),
      });
    },
    onError: (message, error) => host.onError(message, error),
    setTimeout: (callback, delayMs) => host.setTimeout(callback, delayMs),
    clearTimeout: (handle) => host.clearTimeout(handle),
    ...(host.random === undefined ? {} : { random: host.random }),
    isTerminalErrorCode: isTerminalJobsErrorCode,
    initialData: [],
    // The jobs pill's own copy, unchanged from before the controller was shared:
    // the trigger, the popover and these two log lines are the surface the user
    // already knows, and a genericised sentence would be a silent copy change.
    fallbackErrorMessage: "the DSH runtime could not list this session's jobs",
    pillLabel: "jobs pill",
  };
  return createAgentPoller(adapter);
}
