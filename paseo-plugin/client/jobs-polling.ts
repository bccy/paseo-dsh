/**
 * The jobs pill's presentation rule, its pushed-answer projection, and the stop
 * button's state machine.
 *
 * `jobs-pill.tsx` imports the host runtime (React, React Native, the plugin
 * component library), so plain `node` cannot load it and its behaviour could
 * only be asserted through source regexes — which is exactly how a rule that
 * hid every finished job passed review. The controller lives in
 * `client/agent-subscriptions.ts` (shared with the goal and team pills); this
 * module keeps the jobs-specific rules:
 *
 * - {@link jobsPillPresentation}: when the pill is visible, what it counts, and
 *   which mark sits in its icon slot. By the product rule (route 2 of CJ-01) it
 *   is a **live indicator**: a running or stopping job makes the trigger
 *   visible and counts live rows; the moment the last job settles the pill
 *   hides. The registry keeps settled history for the popover, but the pill
 *   itself never advertises an idle total. The icon is the turning ring for
 *   every readable answer; the static mark is reserved for `available: false`,
 *   matching baseline 2f71225.
 * - {@link createJobsProjection}: the answer → pill-payload projection. A jobs
 *   answer is a list, a goal answer is one object; the controller is generic over
 *   that payload, so this projection is what keeps the pill's `{jobs, available,
 *   error, code}` state shape unchanged. It also applies {@link settleDownJobs} — a
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
 * the failure, the projection writes exactly one console line when an agent enters
 * the unreadable state (and one when it recovers) — see {@link createJobsProjection}
 * and FIELD-NOTES #97. Without that line, "could not read" would look exactly like
 * "nothing is running", the silent degradation this repo keeps finding.
 *
 * The stop button's rules are the `jobStop*` functions in the same file: the state
 * machine per job row (pending, refusal notes, the 5 s window) and the geometry
 * the popover draws it with.
 *
 * The terminal-code predicate is `isTerminalJobsErrorCode`; the codes come from
 * the shared contract so server and client cannot disagree about which are
 * terminal; it is re-exported here so call sites and `harness/jobs-poll-check.cjs`
 * keep reading it from the pill's own module.
 *
 * @module dsh-paseo/client/jobs-polling
 */
import type { PillReadResult, PillViewState } from "./agent-subscriptions";
import {
  LIVE_JOB_STATUSES,
  isTerminalJobsErrorCode,
  settleDownJobs,
  type Job,
  type JobsAnswer,
} from "../shared/jobs";


/** The slice of a job the pill's presentation rule needs. */
export interface JobLike {
  status: string;
}

/** One agent's state as the popover store keeps it. */
export interface JobsViewState<J extends JobLike = JobLike> {
  jobs: readonly J[];
  available: boolean;
  error?: string;
  code?: string;
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
 * a profile that composes no job registry — so the stream stops and the pill is
 * removed instead of waiting for an answer that cannot change. Re-exported from
 * `../shared/jobs`, where the server's feed reads the same predicate.
 */
export { isTerminalJobsErrorCode };

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
 * The pill's store row from the controller's payload.
 *
 * The controller (`client/agent-subscriptions`) speaks one generic payload —
 * `{data, available, error?, code?}` — while this pill's store and its popover
 * name the payload `jobs`. The mapping is pure and lives here (not in the
 * `.tsx`) so the offline harness drives the **real** conversion instead of a
 * hand-written copy of it; `jobs-pill.tsx` only wires it to `registration.update`.
 */
export function jobsPillViewState(state: PillViewState<readonly Job[]>): JobsViewState<Job> {
  return {
    jobs: state.data,
    available: state.available,
    ...(state.error === undefined ? {} : { error: state.error }),
    ...(state.code === undefined ? {} : { code: state.code }),
  };
}

/* -------------------------------------------------------------------------- */
/* Stopping a running job                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The stop control's geometry (ratified design, 2026-11-11).
 *
 * **Why the numbers live in this module.** They belong beside the row geometry in
 * `client/jobs-popover-layout.ts`, which this round's write scope does not cover;
 * they are pure constants with no React Native import, so the offline check drives
 * them and the JSX reads them from here. A later pass may move them to the layout
 * module unchanged — nothing else in this file depends on where they sit.
 */
export const JOB_STOP_BOX = 28;

/** The popover's small-button radius (the goal pill's icon buttons are 6). */
export const JOB_STOP_RADIUS = 6;

/** The glyph is the `JobMark`'s box, so the button's icon matches the row's mark. */
export const JOB_STOP_GLYPH = 14;

/**
 * `hitSlop` per side: the box is 28, so the effective target is 44×44 — the
 * phone/tablet minimum the design asks for.
 */
export const JOB_STOP_HIT_SLOP = 8;

/**
 * How long a "requested" stop may take before the row says so.
 *
 * `kill()` is synchronous but the producer settles asynchronously (DSH writes the
 * terminal row later), and the subscription that carries that settlement reads on
 * a 4-second base with jitter. 5 s therefore covers one push in the common case and
 * is short enough to tell the user something is wrong instead of leaving a spinner
 * forever.
 */
export const JOB_STOP_TIMEOUT_MS = 5000;

/** One row's note under a job: a neutral tip, or the runtime's own error. */
export interface JobStopNote {
  /**
   * `refusal` notes clear on the next push (the design's "下次推送…清除");
   * `timeout` notes stay while the job is still stoppable, because a push that
   * still reports `running` is exactly the condition they describe.
   */
  readonly kind: "refusal" | "timeout";
  /**
   * `neutral` is a tip, not an error: "it already finished" and "it is already
   * stopping" are answers to the user's click, not failures.
   */
  readonly tone: "neutral" | "error";
  readonly message: string;
}

/** What the popover keeps for one job row's stop attempt. */
export interface JobStopRowState {
  /** The request is in flight and the row waits for the push that ends it. */
  readonly pending: boolean;
  readonly note?: JobStopNote;
}

/** The stop state of every row of one agent, keyed by job id. */
export type JobStopStates = Readonly<Record<string, JobStopRowState>>;

/** What this module's rules need from the locale table's `jobs` block. */
export interface JobStopText {
  readonly stopAlreadyFinished: string;
  readonly stopAlreadyStopping: string;
  readonly stopGone: string;
  readonly stopSentStillRunning: string;
}

/**
 * Whether the runtime says this job can be stopped **right now**.
 *
 * `canStop` is the bridge's derivation (`status === "running"`), not a guess made
 * here: `stopping` means a cancellation is already in flight, and every terminal
 * status is settled. A missing field (an older bridge, a fixture) is not
 * stoppable — the button must not promise what the runtime cannot do.
 */
export function jobStoppable(job: { readonly canStop?: boolean }): boolean {
  return job.canStop === true;
}

/**
 * The row's title: the model's own description when it has one, else the raw
 * command — the rule `JobRow` draws and this module's accessibility label must
 * agree with, so it is stated once here and both read it.
 */
export function jobRowTitle(job: { readonly label: string; readonly description?: string }): string {
  const description = job.description;
  return description !== undefined && description !== "" ? description : job.label;
}

/**
 * The row's accessibility name for the stop button.
 *
 * The locale string carries `{title}`; the title is inserted with a **function**
 * replacement so a `$` in a command (`awk '{print $1}'`) cannot be read as a
 * `String.replace` pattern.
 */
export function jobStopA11yLabel(text: { readonly stop: string }, title: string): string {
  return text.stop.replace("{title}", () => title);
}

/**
 * A refusal as a note — or nothing when the answer says it was requested.
 *
 * Two refusals are **neutral tips**, not errors: the job already finished (the
 * button was drawn for a row that settled a moment ago) and the job is already
 * stopping (a second click, or another window's). "No such job" and "no session"
 * are neutral too: the row is stale and the list will refresh. Everything else —
 * a bridge without the method, a missing registry, a transport failure, a
 * producer whose cancel threw — is an **error**, shown with the runtime's own
 * sentence, because the user's click may have done nothing.
 */
export function jobStopRefusalNote(
  error: { readonly message: string; readonly code?: string } | undefined,
  text: JobStopText,
): JobStopNote | undefined {
  if (error === undefined) return undefined;
  switch (error.code) {
    case "job_finished":
      return { kind: "refusal", tone: "neutral", message: text.stopAlreadyFinished };
    case "job_not_stoppable":
      return { kind: "refusal", tone: "neutral", message: text.stopAlreadyStopping };
    case "job_not_found":
    case "session_missing":
      return { kind: "refusal", tone: "neutral", message: text.stopGone };
    default:
      return { kind: "refusal", tone: "error", message: error.message };
  }
}

/**
 * One click: pending, and any stale note cleared.
 *
 * Two no-ops, both by design: a row the runtime will not stop (`canStop: false`)
 * and a row that is already pending (the design's "同一行 pending 期间重复点击无效").
 * Returning the same object lets the popover skip a repaint.
 */
export function jobStopStart(
  states: JobStopStates,
  job: { readonly id: string; readonly canStop?: boolean },
): JobStopStates {
  if (!jobStoppable(job)) return states;
  if (states[job.id]?.pending === true) return states;
  return { ...states, [job.id]: { pending: true } };
}

/**
 * The `jobs.stop` answer for one row.
 *
 * `ok: true` changes nothing visible: the row keeps its pending spinner and waits
 * for the subscription to report the new status — the client never fabricates a
 * "stopped" row (design, 2026-11-11). A refusal restores the button and carries
 * its note.
 */
export function jobStopAnswer(
  states: JobStopStates,
  jobId: string,
  result: { readonly ok: boolean; readonly error?: { readonly message: string; readonly code?: string } },
  text: JobStopText,
): JobStopStates {
  const current = states[jobId];
  if (current === undefined) return states;
  if (result.ok) {
    return current.pending ? states : { ...states, [jobId]: { pending: true } };
  }
  const note = jobStopRefusalNote(result.error, text);
  return { ...states, [jobId]: { pending: false, ...(note === undefined ? {} : { note }) } };
}

/** Drop one row's state (a helper so every branch removes the key the same way). */
function withoutRow(states: JobStopStates, jobId: string): JobStopStates {
  if (states[jobId] === undefined) return states;
  const next: Record<string, JobStopRowState> = {};
  let changed = false;
  for (const [id, state] of Object.entries(states)) {
    if (id !== jobId) next[id] = state;
    else changed = true;
  }
  return changed ? next : states;
}

/**
 * A pushed snapshot arrived: the rows it describes are the truth.
 *
 * - a job that left the list or is no longer stoppable drops its state (the
 *   button is gone, so a pending flag or a note would be a ghost);
 * - a **refusal** note clears on the next push (the design says so: the world
 *   moved on, the tip has been read);
 * - a `timeout` note stays while the job is still stoppable — that push is
 *   exactly the "still running" evidence the note reports;
 * - a pending row keeps waiting, however many pushes arrive before that one
 *   ends it.
 */
export function jobStopPushed(
  states: JobStopStates,
  jobs: readonly { readonly id: string; readonly canStop?: boolean }[],
): JobStopStates {
  let next = states;
  const byId = new Map(jobs.map((job) => [job.id, job] as const));
  for (const [jobId, state] of Object.entries(states)) {
    const job = byId.get(jobId);
    if (job === undefined || !jobStoppable(job)) {
      next = withoutRow(next, jobId);
      continue;
    }
    if (state.note?.kind === "refusal") {
      next = { ...next, [jobId]: { pending: state.pending } };
    }
  }
  return next;
}

/**
 * The 5-second timer fired.
 *
 * A no-op unless the row is still pending **and** the job is still stoppable:
 * a push that already moved the job to `stopping`/settled made the question moot,
 * and that row's state is dropped instead of replaced. Otherwise the button comes
 * back and the row says the request was sent but the job is still running — the
 * one user-visible answer to "I pressed stop and nothing happened".
 */
export function jobStopTimedOut(
  states: JobStopStates,
  job: { readonly id: string; readonly canStop?: boolean },
  text: JobStopText,
): JobStopStates {
  if (states[job.id]?.pending !== true) return states;
  if (!jobStoppable(job)) return withoutRow(states, job.id);
  return {
    ...states,
    [job.id]: {
      pending: false,
      note: { kind: "timeout", tone: "neutral", message: text.stopSentStillRunning },
    },
  };
}

/**
 * The rows whose stop state a push **removed**.
 *
 * `jobStopPushed` drops the state of a job that left the list or stopped being
 * stoppable, but the popover's 5-second timer is keyed by job id outside the
 * state map — a timer nobody cancelled would fire later and re-enter a row the
 * push already settled. The caller cancels exactly these ids.
 */
export function jobStopDroppedIds(before: JobStopStates, after: JobStopStates): string[] {
  return Object.keys(before).filter((jobId) => after[jobId] === undefined);
}

/** The note under one row, if any. */
export function jobStopNoteOf(states: JobStopStates, jobId: string): JobStopNote | undefined {
  return states[jobId]?.note;
}

/** Whether one row's stop request is in flight. */
export function jobStopPendingOf(states: JobStopStates, jobId: string): boolean {
  return states[jobId]?.pending === true;
}

/**
 * The jobs pill's per-agent projection state.
 *
 * Two maps, as long-lived as the contribution: the settle latch must survive a
 * re-registration of the same agent (a reconnect re-registers it, and the
 * settlement it saw is still a fact), while a torn-down pill drops its entry so a
 * long-lived client does not grow one per agent it ever saw.
 */
export interface JobsProjection {
  /** One pushed answer, with settlements latched and the failure line managed. */
  project(agentId: string, answer: JobsAnswer): PillReadResult<readonly Job[]>;
  /** The pill was removed: forget both per-agent maps. */
  forget(agentId: string): void;
}

/**
 * Create the jobs projection for one pill contribution.
 *
 * **One published answer, with settlements latched.** {@link settleDownJobs} is
 * applied to every readable answer before it leaves this module, so the pill, its
 * count and the popover all read the same corrected list. The latch is
 * **defensive**: DSH settles a job once and the server pushes only changed
 * snapshots, so no observed answer has reported a settled job as running. It
 * covers the paths those guards cannot see (a bridge replaying a long session's
 * open window, a second connection answering for the same agent after a
 * reconnect). A failed answer does not touch the latch: it carries the previous
 * payload forward.
 *
 * **A failed read is logged, once per entry into the failed state.** The pill no
 * longer shows itself for a failed read (see {@link jobsPillPresentation}), so the
 * console line is the only thing that keeps the failure loud — without it, "the
 * runtime cannot answer" would be indistinguishable from "nothing is running".
 * The line fires on the transition, not on every pushed answer; a successful
 * answer logs one recovery line; a terminal code logs nothing here because the
 * pill's removal already logs exactly one line.
 *
 * The latch's row is the shared contract's `Job` — {@link settleDownJobs} only
 * needs an id, a status and a finish time, and the pill's store carries exactly
 * that row.
 */
export function createJobsProjection(host: {
  onError(message: string, error?: unknown): void;
}): JobsProjection {
  const settled = new Map<string, ReadonlyMap<string, Job>>();
  const unreadable = new Set<string>();

  return {
    project(agentId: string, answer: JobsAnswer): PillReadResult<readonly Job[]> {
      if (!answer.available) {
        // A terminal code is the pill-removal path, which logs its own line.
        if (!isTerminalJobsErrorCode(answer.error?.code)) {
          if (!unreadable.has(agentId)) {
            unreadable.add(agentId);
            host.onError(
              `jobs pill: could not read this session's jobs for ${agentId}; keeping the last known answer until a read succeeds`,
              answer.error?.message,
            );
          }
        }
        return { available: false, ...(answer.error === undefined ? {} : { error: answer.error }) };
      }
      if (unreadable.delete(agentId)) {
        host.onError(`jobs pill: this session's jobs are readable again for ${agentId}`);
      }
      const projection = settleDownJobs(answer.jobs, settled.get(agentId) ?? new Map());
      settled.set(agentId, projection.settled);
      return { available: true, data: projection.jobs };
    },
    forget(agentId: string): void {
      settled.delete(agentId);
      unreadable.delete(agentId);
    },
  };
}
