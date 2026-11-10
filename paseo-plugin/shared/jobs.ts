/**
 * The one contract both halves of the jobs pill share.
 *
 * It lives in `shared/` because that is the only directory Paseo's compiler lets
 * both sides import. Defining the contract twice would let the halves drift, and
 * the mismatch would surface as a Zod error at runtime rather than here.
 *
 * `defineRpc` (the stop request) and `defineSubscription` (the snapshot feed)
 * both come from the package root: the only entry the client bundle's allow-list
 * accepts *and* the server can load.
 *
 * @module dsh-paseo/shared/jobs
 */
import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The job statuses DSH's `JobView` can carry.
 *
 * `running` and `stopping` are live, the rest terminal. The visibility rule is
 * derived from this split rather than a second list, so a status DSH adds later
 * fails the Zod parse on the wire instead of silently counting as "settled".
 */
export const JOB_STATUSES = ["running", "stopping", "completed", "killed", "failed"] as const;

/** One status a `JobView` can carry. */
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * The machine-readable codes a `jobs.snapshot` error may carry.
 *
 * Added for the 2026-11-02 audit's CJ-04: the old contract's `error` had only a
 * message, so the client could not tell "the read failed, ask again" from "this
 * profile's bridge predates the method, retrying cannot help". `bridge_too_old`
 * and `registry_missing` are **terminal** — the user's next step is to rewrite
 * the embedded bridge or fix the profile — while `rpc_failed` is transient and
 * keeps its backoff. The list is the single source both halves read, so a code
 * the client treats as terminal cannot drift from the code the server sends.
 */
export const JOB_ERROR_CODES = ["bridge_too_old", "registry_missing", "rpc_failed"] as const;

/** One machine-readable `jobs.snapshot` error code. */
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

/** The subset of error codes that retrying cannot fix. */
export const TERMINAL_JOB_ERROR_CODES = [
  "bridge_too_old",
  "registry_missing",
] as const satisfies readonly JobErrorCode[];

/**
 * Whether an error code means "waiting cannot help".
 *
 * Lives here rather than in the client's pill module because both halves read it
 * now: the server's feed stops reading on a terminal answer, and the client
 * removes the pill on the same answer. One list, one predicate, no drift.
 */
export function isTerminalJobsErrorCode(code: string | undefined): boolean {
  return code !== undefined && (TERMINAL_JOB_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * The statuses that mean "this job is still doing work".
 *
 * Typed as the literal tuple rather than `readonly string[]`: with the wider
 * type, `LIVE_JOB_STATUSES.includes(job.status)` widened `job.status` to `string`
 * and lost the check — deleting a status from this list would silently start
 * counting it as settled, with nothing to notice. The split stays derived from
 * `JOB_STATUSES` through the `satisfies` clause, so a name that is not a real
 * status is a type error here instead of a member that can never match.
 */
export const LIVE_JOB_STATUSES = ["running", "stopping"] as const satisfies readonly JobStatus[];

/** The statuses that mean the job has settled. */
export type SettledJobStatus = Exclude<JobStatus, (typeof LIVE_JOB_STATUSES)[number]>;

/**
 * Whether a status means "this job is still doing work".
 *
 * The predicate is the only supported way to ask: it keeps the literal types on
 * both sides, so a call site cannot pass an arbitrary `string` and get a silent
 * `false`. `LIVE_JOB_STATUSES` remains exported for the harness, which asserts it
 * against `JOB_STATUSES` as a list.
 */
export function isLiveStatus(status: JobStatus): status is (typeof LIVE_JOB_STATUSES)[number] {
  return (LIVE_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

/**
 * The order the pill draws jobs in.
 *
 * **Copied from DSH's own job list** (`dsh-client-ui-jobs/lib/client.js`'s
 * `ordered()`), not invented here: a running job is what the user opened the
 * popover to look at, so live rows come first in start order, then the settled
 * ones newest-first. Two rows that settled in the same millisecond fall back to
 * start order, which is what keeps the result independent of the registry's map
 * iteration — the registry only promises *registration* order, and a settled
 * row's position in that order says nothing about when it finished.
 *
 * Pure and dependency-free so the offline harness can drive it directly.
 */
export function orderJobs<T extends Pick<Job, "status" | "startedAt" | "finishedAt">>(
  jobs: readonly T[],
): T[] {
  return [...jobs].sort((left, right) => {
    const liveLeft = isLiveStatus(left.status);
    if (liveLeft !== isLiveStatus(right.status)) return liveLeft ? -1 : 1;
    if (liveLeft) return left.startedAt - right.startedAt;
    const finished =
      (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt);
    return finished !== 0 ? finished : left.startedAt - right.startedAt;
  });
}

/**
 * The popover's two groups: what is running, and what already finished.
 *
 * Split after {@link orderJobs}, so each half keeps that order (live by start
 * time, settled newest-first) without a second sort.
 *
 * **Why split at all.** A session that runs a dozen commands leaves a dozen
 * finished rows behind — the registry keeps a settled record until its owner is
 * disposed — and a flat list turns into a wall of history the user has to scroll
 * past to see the one row that matters. DSH's own job list splits the same way
 * (`settledExpanded = settledOpen ?? liveRows.length === 0`), so this is its
 * behaviour rather than an invention.
 *
 * Pure and dependency-free so the offline harness can drive it directly.
 */
export function splitJobs<T extends Pick<Job, "status" | "startedAt" | "finishedAt">>(
  jobs: readonly T[],
): { live: T[]; settled: T[] } {
  const ordered = orderJobs(jobs);
  return {
    live: ordered.filter((job) => isLiveStatus(job.status)),
    settled: ordered.filter((job) => !isLiveStatus(job.status)),
  };
}

/**
 * A job row's identity and the two fields that decide whether it is still work.
 *
 * The minimum {@link settleDownJobs} needs: an id to remember it by, the status
 * that says live/settled, and the finish time a settled row sorts its history by.
 */
export interface SettledJobLike {
  readonly id: string;
  readonly status: string;
  readonly finishedAt?: number;
}

/**
 * Whether a status string is one of the live statuses.
 *
 * A widened copy of {@link isLiveStatus} for callers that hold a plain `string`
 * (a job projected from a type that is not `Job`); it reads the same shared list,
 * so the two cannot disagree about which statuses are live.
 */
function isLiveStatusText(status: string): boolean {
  return (LIVE_JOB_STATUSES as readonly string[]).includes(status);
}

/**
 * Keep a settled job settled.
 *
 * **A defensive monotonicity guard, not a diagnosed root cause.** DSH mints one
 * job id per call (`bash-<hex>`) and settles it exactly once, and the poll
 * controller already rejects an answer a newer poll superseded (in-flight and
 * global sequence guards). So the common "old answer arrives late" case is
 * handled there; **no observed answer has reported a settled job as running**
 * (2026-11-10 logs show 49/49 settled jobs, all `producer`). The projection
 * covers the paths those guards cannot see — a bridge replaying a long session's
 * open window, or a second connection answering for the same agent after a
 * reconnect — and is kept because the cost is four lines while the symptom it
 * would produce (the pill coming back after the user watched the job finish) is
 * exactly the kind of state divergence this pill has already shown once.
 *
 * If an already-settled id does come back as `running`, the projection carries
 * the **settled row** forward: the count cannot go back up, the popover keeps the
 * real outcome (`completed`/`killed`/`failed` and its finish time), and a
 * genuinely new job — a new id — still appears immediately. Only a *live* claim
 * is corrected; a later settled word passes through.
 *
 * Pure and dependency-free: the adapter owns the latch, the offline harness drives
 * the rule.
 *
 * @param jobs - one jobs answer, in whatever shape the caller's rows have.
 * @param settled - the rows this caller has already observed settled, by id. A
 *   row without a string id is passed through unlatched (fixtures and foreign
 *   payloads have no identity to remember).
 */
export function settleDownJobs<T extends SettledJobLike>(
  jobs: readonly T[],
  settled: ReadonlyMap<string, T>,
): { jobs: T[]; settled: ReadonlyMap<string, T> } {
  if (jobs.length === 0) return { jobs: [], settled };
  let next: Map<string, T> | undefined;
  const projected = jobs.map((job) => {
    if (typeof job.id !== "string") return job;
    const known = settled.get(job.id);
    if (known !== undefined) return isLiveStatusText(job.status) ? known : job;
    if (isLiveStatusText(job.status)) return job;
    (next ??= new Map(settled)).set(job.id, job);
    return job;
  });
  return { jobs: projected, settled: next ?? settled };
}

/**
 * One job as the pill draws it.
 *
 * `.strip()` is deliberate: Paseo parses both sides, so an undeclared key would be
 * dropped on the client — the silent-loss shape this repo keeps finding.
 */
export const jobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  status: z.enum(JOB_STATUSES),
  /**
   * Whether a stop request can do anything for this job **now**.
   *
   * Decided by the bridge from DSH's own lifecycle, never assumed: DSH's
   * `JobRegistry.kill()` answers `already-finished` for a settled job and
   * refuses a foreign one, and a job already `stopping` has its cancellation
   * requested. So only `running` is stoppable, and the row draws a stop control
   * exactly when this is true — a button on a settled row would be a promise the
   * runtime cannot keep. A profile whose bridge predates this field sends no
   * jobs at all (the parse fails and the pill reports "could not read"), which is
   * the same terminal state as a bridge without the jobs RPC.
   */
  canStop: z.boolean(),
  startedAt: z.number(),
  /**
   * The model's own one-line summary of what this job's command does.
   *
   * A bash job's `label` is the raw command, so the pill printed shell source
   * while the tool row above it already read in Chinese. DSH requires a
   * `description` on every bash call and titles its own row with it; the bridge
   * carries that same sentence here. **Absent means "no better title than the
   * command"** — never a placeholder, so the row can fall back without guessing.
   */
  description: z.string().optional(),
  progress: z.string().optional(),
  detail: z.string().optional(),
  finishedAt: z.number().optional(),
});

export type Job = z.infer<typeof jobSchema>;

/**
 * One agent's jobs answer: the complete snapshot one subscription event carries.
 *
 * Keyed by Paseo's **agent** id, not the provider session id: a plugin reload
 * mints a new session id for the same agent, and the server half never guesses
 * one.
 *
 * **A snapshot, never a delta.** The whole pill state is this object, so a
 * subscriber that missed an event (a reconnect, a dropped frame) recovers from
 * the next one without any replay protocol. The server pushes only when the
 * answer changes (`server/pill-feed`), so "only what changed" and "every event is
 * complete" both hold at once.
 *
 * The `available` contract, stated once — it used to be a request-response RPC's,
 * and the client's rules were written against exactly this wording:
 *
 * - **`true` with an empty list** means "we looked and this agent has none" —
 *   including an agent whose DSH session has not been opened yet, which is an
 *   accurate empty answer rather than a failed read.
 * - **`false`** is reserved for "we could not read the registry", and always
 *   carries a message. It is a fact about the *read*, not about jobs: it never
 *   creates or keeps the pill (2026-11-10 — a failure used to be drawn as a
 *   visible error pill, which is how a flaky read produced "不消失 / 消失后重复
 *   出现"). The client carries the last readable list forward, keeps the popover
 *   note, and logs one line per entry into the failed state. Collapsing `false`
 *   into an empty list would present an unreadable registry as a quiet "no
 *   background jobs"; that is still forbidden.
 *
 * When `available` is false, `error.code` tells the client whether waiting can
 * help. It is optional so a server half that predates the codes keeps working: a
 * missing code is treated as transient, never as terminal.
 */
export const jobsAnswerSchema = z.object({
  available: z.boolean(),
  jobs: z.array(jobSchema),
  error: z
    .object({
      message: z.string(),
      code: z.enum(JOB_ERROR_CODES).optional(),
    })
    .optional(),
});

/** One agent's jobs answer, as the server pushes it and the client stores it. */
export type JobsAnswer = z.infer<typeof jobsAnswerSchema>;

/**
 * Watch one agent's background jobs.
 *
 * Replaced the `jobs.list` RPC in the 0.16 port: the client used to poll that
 * RPC every four seconds per agent, which put a steady stream of identical reads
 * on the daemon and a repaint risk on the composer. The subscription pushes the
 * same answer type whenever it changes, and the server shares one read between
 * every client watching the same agent (`server/pill-feed`).
 *
 * `name` is the wire name, so it must stay unique across this plugin's
 * contracts.
 */
export const jobsSnapshot = defineSubscription({
  name: "jobs.snapshot",
  input: z.object({ agentId: z.string().min(1) }),
  event: jobsAnswerSchema,
});

/**
 * The machine-readable codes a `jobs.stop` refusal may carry.
 *
 * Separate from {@link JOB_ERROR_CODES} because a *read* failure and a *control*
 * failure are different facts: `bridge_too_old` is shared, but "the job already
 * finished" has no meaning for a poll while "the registry could not be read" has
 * no meaning for a stop of a job the poll just showed. Both lists are the single
 * source each half reads, so a code one half sends and the other never expects
 * cannot drift silently.
 *
 * Only `bridge_too_old` is terminal for the pill's poll. A stop has no poll to
 * retry: the client shows the code's sentence next to the row and re-lists.
 */
export const JOB_STOP_ERROR_CODES = [
  /** The profile's bridge has no `paseo/jobs/stop` (reload rewrites it). */
  "bridge_too_old",
  /** The profile composes no job registry — this runtime cannot stop anything. */
  "registry_missing",
  /** No open DSH session serves this agent, or the bridge lost it. */
  "session_missing",
  /** No such job belongs to this session (unknown, or another session's). */
  "job_not_found",
  /** The job already settled; there was nothing left to stop. */
  "job_finished",
  /** The job is already `stopping` — its cancellation is in flight. */
  "job_not_stoppable",
  /** The producer's cancel threw; DSH left the job running. */
  "cancel_failed",
  /** No answer from the bridge (timeout) or a transport failure. */
  "rpc_failed",
] as const;

/** One machine-readable `jobs.stop` error code. */
export type JobStopErrorCode = (typeof JOB_STOP_ERROR_CODES)[number];

/**
 * Stop one background job of one agent — the control the jobs popover's row
 * button asks for.
 *
 * **The answer is a value, not a throw**, like `goal.control`: the popover shows
 * the refusal in place, and a throw would reach it as a generic failed request
 * with no code to act on. `ok: false` is never a success with a quiet message —
 * a click that could not stop anything must say so.
 *
 * `job` travels on success (the projection right after the request, whose status
 * is `stopping`) and on the "already finished / already stopping" refusals (the
 * current one), so the client can update that row without waiting for a poll.
 * It is absent for every failure DSH never let us project (no session, no such
 * job, a dead bridge).
 *
 * `outcome: "requested"` is DSH's own word for "cancellation was asked of the
 * producer"; the job settles later, which the poll reports. This RPC does **not**
 * wait for settlement — a producer may take seconds to stop, and a button that
 * blocks a popover for that long would be worse than a row that turns
 * `stopping`.
 */
export const jobsStop = defineRpc({
  name: "jobs.stop",
  input: z.object({
    agentId: z.string().min(1),
    jobId: z.string().min(1),
  }),
  output: z.object({
    ok: z.boolean(),
    /** DSH's `kill()` outcome on success; absent on every refusal. */
    outcome: z.literal("requested").optional(),
    /** The job's projection after the attempt, when DSH could project it. */
    job: jobSchema.optional(),
    /** The refusal: the runtime's sentence plus the code the client acts on. */
    error: z
      .object({
        message: z.string(),
        code: z.enum(JOB_STOP_ERROR_CODES),
      })
      .optional(),
  }),
});

/**
 * What `jobs.stop` answers, as both halves see it.
 *
 * Derived from the contract rather than declared twice: the client's popover and
 * the server's handler then cannot disagree about the field set.
 */
export type JobStopResult = z.infer<typeof jobsStop.output>;
