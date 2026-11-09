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
 *   code}` state shape unchanged. It also applies {@link settleDownJobs} — a
 *   **defensive** monotonicity guard, not a proven root cause: the controller's
 *   in-flight/sequence guards already reject superseded answers, and DSH settles
 *   a job once, so the guard covers only the paths those guards cannot see (a
 *   bridge replaying a long open window, a second connection for the same agent).
 *
 * **Visibility is a statement about jobs, never about a read.** The failure half
 * of the contract (`available: false`) says the registry could not be read; it
 * cannot say how many jobs there are. It therefore never creates a pill on its
 * own — see {@link jobsPillPresentation} and `docs/FIELD-NOTES.md` #95, whose
 * "no tasks but always a 后台 pill" was the same mistake in a terminal form.
 *
 * **A failed read is loud in the log instead.** With the pill no longer carrying
 * the failure, the adapter writes exactly one console line when an agent enters
 * the unreadable state (and one when it recovers) — see `createJobsPoller` and
 * FIELD-NOTES #97. Without that line, "could not read" would look exactly like
 * "nothing is running", the silent degradation this repo keeps finding.
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
import { isPermissionDeniedError } from "./jobs-popover-layout";
import {
  LIVE_JOB_STATUSES,
  TERMINAL_JOB_ERROR_CODES,
  settleDownJobs,
} from "../shared/jobs";

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

/**
 * The shape this module's adapter needs from a job: it must be identifiable and
 * carry a finish time, or {@link settleDownJobs} cannot keep it settled.
 */
export interface JobsJobLike extends JobLike {
  readonly id: string;
  readonly finishedAt?: number;
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
 * **Visibility is a statement about jobs, never about a read** (2026-11-10). A
 * failed read is a fact about the transport, and the answer it carries is the
 * *last known* job list; it must not invent a pill on its own. Before this rule,
 * any `available: false` whose code was not `bridge_too_old` was drawn visible,
 * so a flaky RPC made the pill appear after it had legitimately hidden, and kept
 * it up while the failure persisted — the two halves of the user's "不消失 /
 * 消失后重复出现". Counting the carried rows instead means: a failure while
 * nothing is live hides the pill exactly as a readable empty answer would, and a
 * failure while a job is live keeps showing that job. The popover (which reads
 * the same answer) says the read failed and keeps the last known rows below that
 * note — "could not read" stays loud without pretending to be a job.
 *
 * **The icon is the turning ring on every readable answer**, visible or hidden.
 * Tracking one constant for the whole readable half means `update()` never
 * swaps a static mark into the slot; the ring is this UI's word for a job
 * surface, and a static icon here would read as "nothing works". The one
 * exception is an unreadable registry with no known live job: the pill is hidden
 * anyway, and if that answer were ever published the static mark keeps baseline
 * 2f71225's "no progress is happening" claim. An unreadable registry that *does*
 * carry a live row keeps the ring — the job is still running, whatever happened
 * to the read.
 *
 * **Environment-level terminal errors stay hidden.** `bridge_too_old` means the
 * profile's bridge cannot serve `paseo/jobs` at all (an old or unresponsive
 * process); there is no registry to explain to the user and no job to watch, and
 * the poller has already stopped. Leaving an error pill there is the "no tasks
 * but always a red pill" bug (FIELD-NOTES #95): hide it and let the one console
 * line say what to do. The predicate stays exported so the rule is checkable on
 * its own, independent of which answer carries the code.
 */
export function jobsPillPresentation(answer: {
  available: boolean;
  jobs?: readonly JobLike[];
  code?: string;
}): PillPresentation {
  if (!answer.available && isBridgeEnvironmentJobsError(answer.code)) {
    return { visible: false, icon: "static", label: { kind: "title" } };
  }
  const jobs = answer.jobs ?? [];
  const live = jobs.filter((job) => isLive(job.status)).length;
  const icon: PillIcon = answer.available || live > 0 ? "spinner" : "static";
  if (live > 0) return { visible: true, icon, label: { kind: "live", count: live } };
  return { visible: false, icon, label: { kind: "title" } };
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
 * The terminal codes that mean the *environment* cannot serve jobs — the bridge
 * is too old or unresponsive — as opposed to a registry read that failed while
 * the environment is fine.
 *
 * Only codes whose only remedy is a plugin reload belong here. Both halves read
 * the shared terminal list; this narrower predicate decides the pill's
 * presentation for the environment case.
 */
const BRIDGE_ENVIRONMENT_JOB_ERROR_CODES = ["bridge_too_old"] as const;

/**
 * Whether a terminal jobs code is an environment (bridge) error.
 *
 * The pill hides for these: the poller has already stopped (terminal), and a
 * permanent per-agent error pill would be the exact "no tasks but always a red
 * pill" complaint. `registry_missing` is deliberately **not** here — it is a
 * runtime answer worth one console line, but it is still a failed read: it does
 * not create a pill either (2026-11-10, see {@link jobsPillPresentation}). The
 * predicate only says which terminal code the *poller* must stop on.
 *
 * @param code - `error.code` from a jobs answer.
 */
export function isBridgeEnvironmentJobsError(code: string | undefined): boolean {
  return code !== undefined && (BRIDGE_ENVIRONMENT_JOB_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * The host half the jobs pill's poller needs.
 *
 * Same shape as before the controller was shared: the jobs adapter owns the
 * `{jobs}` payload and the pill module owns the React store and the host
 * registration.
 */
export interface JobsPollerHost<J extends JobsJobLike = JobsJobLike> {
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
 *
 * **One published answer, with settlements latched.** {@link settleDownJobs} is
 * applied to every readable answer before it leaves this adapter, so the pill,
 * its count and the popover all read the same corrected list. The latch is
 * **defensive**: DSH settles a job once and the controller's in-flight and
 * sequence guards already reject an answer a newer poll superseded, so no
 * observed answer has reported a settled job as running. It covers the paths the
 * guards cannot see (a bridge replaying a long session's open window, a second
 * connection answering for the same agent after a reconnect). A failed read does
 * not touch the latch: it carries the previous `data` forward.
 *
 * **A failed read is logged, once per entry into the failed state.** The pill
 * no longer shows itself for a failed read (see {@link jobsPillPresentation}),
 * so the console line is the only thing that keeps the failure loud — without
 * it, "the runtime cannot answer" would be indistinguishable from "nothing is
 * running", which is the silent-degradation shape this repo keeps finding. The
 * line fires on the transition, not on every 4-second poll; a successful read
 * logs one recovery line; a terminal code logs nothing here because the pill's
 * removal already logs exactly one line.
 */
export function createJobsPoller<J extends JobsJobLike>(host: JobsPollerHost<J>): JobsPoller {
  /**
   * Per agent, the rows this client has already seen settled.
   *
   * Kept for the contribution's lifetime, not per registration: a reconnect
   * re-registers the same agent, and the settlement it saw is still a fact. A
   * new job is a new id, so the latch cannot hide it. Dropped when the pill is
   * torn down, so a long-lived client does not accumulate an entry per agent it
   * ever saw.
   */
  const settled = new Map<string, ReadonlyMap<string, J>>();
  /**
   * Agents whose current read state is "could not read".
   *
   * The set is what makes the failure line **one per transition** instead of one
   * per poll, and its `delete` is the recovery edge. Cleared with the pill.
   */
  const unreadable = new Set<string>();
  const noteUnreadable = (agentId: string, error?: unknown): void => {
    if (unreadable.has(agentId)) return;
    unreadable.add(agentId);
    host.onError(
      `jobs pill: could not read this session's jobs for ${agentId}; keeping the last known answer until a read succeeds`,
      error,
    );
  };
  const adapter: AgentPollerHost<readonly J[]> = {
    read: async (agentId) => {
      let result: JobsReadResult<J>;
      try {
        result = await host.readJobs(agentId);
      } catch (error) {
        // The RPC itself failed (transport, daemon restart, a host-side "stream
        // ended"): still a failed read, still exactly one line. A permission
        // refusal is excluded — the pill's own teardown logs that line, and two
        // lines for one event is noise. Rethrown so the controller keeps its
        // transient backoff and permission handling.
        if (!isPermissionDeniedError(error)) noteUnreadable(agentId, error);
        throw error;
      }
      if (!result.available) {
        // A terminal code is the pill-removal path, which logs its own line.
        if (!isTerminalJobsErrorCode(result.error?.code)) noteUnreadable(agentId, result.error?.message);
        return { available: false, error: result.error };
      }
      if (unreadable.delete(agentId)) {
        host.onError(`jobs pill: this session's jobs are readable again for ${agentId}`);
      }
      const projection = settleDownJobs(result.jobs ?? [], settled.get(agentId) ?? new Map());
      settled.set(agentId, projection.settled);
      return { available: true, data: projection.jobs };
    },
    listAgentPage: (cursor) => host.listAgentPage(cursor),
    addAgent: (agent) => host.addAgent(agent),
    removeAgent: (agentId, reason, error) => {
      // The pill is gone: forget both per-agent maps. A later re-registration
      // starts clean, and a long session cannot grow one latch per agent ever
      // seen.
      settled.delete(agentId);
      unreadable.delete(agentId);
      host.removeAgent(agentId, reason, error);
    },
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
