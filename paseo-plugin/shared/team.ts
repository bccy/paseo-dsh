/**
 * The one contract both halves of the team pill share.
 *
 * Like `shared/goal.ts`, this lives in `shared/` because it is the only
 * directory both sides may import; defining it twice would let the halves drift
 * into a Zod error at runtime instead of a type error here.
 *
 * **What the team is.** DSH's `dsh-experimental-agent-team` keeps a durable
 * `agentTeam` session projection on the Lead's session: a roster (the Lead plus
 * every teammate) and a shared task board. The wire view is DSH's
 * `TeamProjection` (`lib/types/types.d.ts`: `{members, tasks, failure?}`, with
 * deleted tasks already filtered out). The plugin reads it cold through the
 * bridge's existing `paseo/projections` method — no bridge change, no Paseo
 * capability bit, no invented event.
 *
 * **One field is not DSH's.** The projection is durable state only; whether a
 * member is *running right now* is runtime state (DSH's own Web UI overlays it
 * from session state). The plugin's server half adds `running` from the child
 * sessions it hosts, and **omits it when it does not know** — the client must
 * then not say 运行中/空闲 (docs/TEAM.md). Showing a durable `active` as
 * "running" is the silent degradation this field exists to prevent.
 *
 * @module dsh-paseo/shared/team
 */
import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/** DSH's member phases (`TeamMemberProjection.phase`), written out so a new one fails the parse. */
export const TEAM_MEMBER_PHASES = ["provisioning", "active", "failed"] as const;
export type TeamMemberPhase = (typeof TEAM_MEMBER_PHASES)[number];

/** DSH's wire task statuses. `deleted` never reaches the wire (the view filters tombstones). */
export const TEAM_TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

/** One roster row: DSH's `TeamMemberProjection` plus the server-added `running`. */
export const teamMemberSchema = z.object({
  /** The member's DSH session id (the Lead's is the root session id). */
  id: z.string(),
  name: z.string(),
  role: z.enum(["lead", "teammate"]),
  phase: z.enum(TEAM_MEMBER_PHASES),
  /** DSH's failure sentence for a `failed` member, verbatim. */
  error: z.string().optional(),
  /** The one-line description the Lead gave at spawn, when DSH recorded one. */
  description: z.string().optional(),
  /**
   * Whether the member's session is executing a turn now, computed by the
   * plugin's server half from the session it hosts. **Absent = unknown**, never
   * "idle".
   */
  running: z.boolean().optional(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

/** One shared task: DSH's `TeamTaskView` (`TASK_VIEW_SCHEMA`), field for field. */
export const teamTaskSchema = z.object({
  id: z.string(),
  revision: z.number(),
  subject: z.string(),
  description: z.string(),
  status: z.enum(TEAM_TASK_STATUSES),
  blockedBy: z.array(z.string()),
  writeScopes: z.array(z.string()),
  ownerName: z.string().optional(),
  /** DSH's own readiness: pending and every blocker completed. Never recomputed here. */
  ready: z.boolean(),
  /** DSH's advisory overlap sentences (`write scopes overlap with task-N`), verbatim. */
  writeScopeWarnings: z.array(z.string()),
});
export type TeamTask = z.infer<typeof teamTaskSchema>;

/** The board as the pill draws it. `failure` is DSH's terminal projection failure, verbatim. */
export const teamViewSchema = z.object({
  members: z.array(teamMemberSchema),
  tasks: z.array(teamTaskSchema),
  failure: z.string().optional(),
});
export type TeamView = z.infer<typeof teamViewSchema>;

/**
 * The machine-readable codes a `team.read` error may carry (the goal contract's
 * split, `shared/goal.ts`):
 *
 * - `bridge_too_old`: the bridge has no `paseo/projections`. Terminal.
 * - `team_unavailable`: the profile composes no `agentTeam` projection (no
 *   agent-team bundle). Terminal — "this profile has no teams", not "no team".
 * - `session_missing`: the DSH session is not open (yet, or anymore). Transient.
 * - `rpc_failed`: the read itself failed, or the answer was not DSH's shape.
 *   Transient.
 */
export const TEAM_ERROR_CODES = ["bridge_too_old", "team_unavailable", "session_missing", "rpc_failed"] as const;
export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];

/** The subset retrying cannot fix. */
export const TERMINAL_TEAM_ERROR_CODES = [
  "bridge_too_old",
  "team_unavailable",
] as const satisfies readonly TeamErrorCode[];

/** Whether an error code means "retrying cannot help". A missing code is transient. */
export function isTerminalTeamErrorCode(code: string | undefined): boolean {
  return code !== undefined && (TERMINAL_TEAM_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * One agent's team answer: the complete snapshot one subscription event carries.
 *
 * `available: true` + `team: null` = "we looked and there is no team" (no stored
 * log yet, no team events, or no session for the agent in this process).
 * `available: false` always carries a message and, when known, a code. The two
 * are never collapsed (the goal/jobs rule).
 *
 * Replaced the `team.read` RPC in the 0.16 port: the pill used to poll it every
 * four seconds per agent, and the server now shares one read between every client
 * watching the same agent (`server/pill-feed`), pushing this snapshot only when
 * it changes.
 */
export const teamAnswerSchema = z.object({
  available: z.boolean(),
  team: teamViewSchema.nullable(),
  error: z
    .object({
      message: z.string(),
      code: z.enum(TEAM_ERROR_CODES).optional(),
    })
    .optional(),
});

/** One agent's team answer, as the server pushes it and the client stores it. */
export type TeamAnswer = z.infer<typeof teamAnswerSchema>;

/** Watch one agent's team board. */
export const teamSnapshot = defineSubscription({
  name: "team.snapshot",
  input: z.object({ agentId: z.string().min(1) }),
  event: teamAnswerSchema,
});
