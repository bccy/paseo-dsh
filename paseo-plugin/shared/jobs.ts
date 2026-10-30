/**
 * The one contract both halves of the jobs pill share.
 *
 * It lives in `shared/` because that is the only directory Paseo's compiler lets
 * both sides import. Defining the contract twice would let the halves drift, and
 * the mismatch would surface as a Zod error at runtime rather than here.
 *
 * `defineRpc` comes from the package root: the only entry the client bundle's
 * allow-list accepts *and* the server can load.
 *
 * @module dsh-paseo/shared/jobs
 */
import { defineRpc } from "@getpaseo/plugin";
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
  startedAt: z.number(),
  progress: z.string().optional(),
  detail: z.string().optional(),
  finishedAt: z.number().optional(),
});

export type Job = z.infer<typeof jobSchema>;

/**
 * List one agent's background jobs.
 *
 * Keyed by Paseo's **agent** id, not the provider session id: a plugin reload mints
 * a new session id for the same agent, and the server half never guesses one.
 *
 * The `available` contract, stated once:
 *
 * - **`true` with an empty list** means "we looked and this agent has none" —
 *   including an agent whose DSH session has not been opened yet, which is an
 *   accurate empty answer rather than a failed read.
 * - **`false`** is reserved for "we could not read the registry", and always
 *   carries a message. The pill stays visible and prints it; collapsing the two
 *   would present an unreadable registry as a quiet "no background jobs".
 */
export const jobsList = defineRpc({
  name: "jobs.list",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    available: z.boolean(),
    jobs: z.array(jobSchema),
    error: z.object({ message: z.string() }).optional(),
  }),
});
