/**
 * The one contract both halves of the team pill share.
 *
 * Like `shared/goal.ts`, this lives in `shared/` because it is the only
 * directory both sides may import; defining it twice would let the halves drift
 * into a Zod error at runtime instead of a type error here.
 *
 * **What the team is.** DSH keeps a durable `agentTeam` session projection on
 * the Lead's session: whether the team is selected plus a shared task board.
 * Two generations of the wire view exist and **both must parse** (npm `latest`
 * is still the older one; `MINIMUM_DSH` is `0.2.1`):
 *
 * - `dsh-experimental-agent-team` (DSH ≤ 0.2.1): `TeamProjection` is
 *   `{members, tasks, failure?}` — a roster (Lead plus teammates) and the board.
 *   The wire type lives in that package's `lib/types/types.d.ts`.
 * - `dsh-agent-team` (DSH 0.2.2-rc.2+): `{enabled, tasks, failure?}`. The
 *   roster is gone; the package's own projection comment says "Current
 *   subagents are supplied separately by the existing `subagentCatalog`
 *   projection" (`lib/types/projection.d.ts`, `teamProjectionDefinition`). The
 *   roster therefore comes from the Lead's `subagentCatalog` rows, which the
 *   plugin's server half reads through the bridge's `paseo/subagents` and
 *   narrows to continuable direct children — the model's own member rule
 *   (`dsh-tool-subagent-control/src/list-agents.ts`: only `mode !==
 *   'continuable'` rows are omitted from the messageable tree).
 *
 * {@link teamProjectionSchema} is that union, kept strict on each arm so a
 * hybrid or third shape is a loud `rpc_failed` rather than an accepted object
 * with dropped fields. {@link teamViewSchema} is the **normalized** view both
 * halves draw: `enabled` is always present (`true` for the older generation,
 * whose projection only existed when a team did), and `members` is always an
 * array (empty for "the roster could not name anyone", never `undefined`).
 *
 * **One field is not DSH's.** The projection is durable state only; whether a
 * member is *running right now* is runtime state (DSH's own Web UI overlays it
 * from session state). The plugin's server half adds `running` from the child
 * sessions it hosts, and **omits it when it does not know** — the client must
 * then not say 运行中/空闲 (docs/TEAM.md). Showing a durable `active` as
 * "running" is the silent degradation this field exists to prevent. The newer
 * generation has no `phase` for current subagents at all (`TeamMemberPhase` is
 * kept there for historical roster records only), so `phase` is optional here
 * and its absence is "this generation does not express it", not `active`.
 *
 * @module dsh-paseo/shared/team
 */
import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * DSH's historical member phases (`TeamMemberSnapshot.phase`), written out so a
 * new one fails the parse. Only the older generation's projection carries them;
 * the newer one records them for historical roster events only, so a current
 * subagent-derived member has no phase at all.
 */
export const TEAM_MEMBER_PHASES = ["provisioning", "active", "failed"] as const;
export type TeamMemberPhase = (typeof TEAM_MEMBER_PHASES)[number];

/** DSH's wire task statuses. `deleted` never reaches the wire (the view filters tombstones). */
export const TEAM_TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

/** One roster row: DSH's `TeamMemberSnapshot` plus the server-added `running`. */
export const teamMemberSchema = z.object({
  /** The member's DSH session id (the older generation's Lead row carries the root session id). */
  id: z.string(),
  name: z.string(),
  role: z.enum(["lead", "teammate"]),
  /**
   * Present only when the older generation's projection (`{members, tasks}`)
   * supplied it. The newer generation has no phase for current subagents, so a
   * roster derived from its `subagentCatalog` omits the key — that is "DSH does
   * not express this", not `active`.
   */
  phase: z.enum(TEAM_MEMBER_PHASES).optional(),
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

/** One shared task: DSH's `TeamTaskView` (`projectTaskView`), field for field. */
export const teamTaskSchema = z.object({
  id: z.string(),
  revision: z.number(),
  subject: z.string(),
  description: z.string(),
  status: z.enum(TEAM_TASK_STATUSES),
  blockedBy: z.array(z.string()),
  writeScopes: z.array(z.string()),
  /**
   * The newer generation's assignment identity (DSH 0.2.2-rc.2+,
   * `TeamTaskView.ownerId`): the owner's `SessionId`. Optional in both
   * generations; the older one had no such key, so it stays absent there.
   */
  ownerId: z.string().optional(),
  /**
   * The owner's agent **path** captured at assignment (`TeamTaskView.ownerName`;
   * `team_task_*` tool results rename it to `owner`). Absent on historical
   * owners recorded before names existed.
   */
  ownerName: z.string().optional(),
  /** DSH's own readiness: pending and every blocker completed. Never recomputed here. */
  ready: z.boolean(),
  /** DSH's advisory overlap sentences (`write scopes overlap with task-N`), verbatim. */
  writeScopeWarnings: z.array(z.string()),
});
export type TeamTask = z.infer<typeof teamTaskSchema>;

/** The shared task fields both generations carry; the arms add their own keys. */
const teamProjectionFields = {
  tasks: z.array(teamTaskSchema),
  failure: z.string().optional(),
} as const;

/**
 * DSH ≤ 0.2.1's wire view (`dsh-experimental-agent-team`): `{members, tasks,
 * failure?}`. `strict()` so `enabled` (and anything else) on this arm is a
 * shape error instead of a silently stripped field.
 */
export const teamRosterProjectionSchema = z
  .object({ members: z.array(teamMemberSchema), ...teamProjectionFields })
  .strict();

/**
 * DSH 0.2.2-rc.2+'s wire view (`dsh-agent-team`): `{enabled, tasks, failure?}`.
 * The roster is deliberately absent — it comes from the `subagentCatalog`
 * projection (see this module's comment). `strict()` for the same reason.
 */
export const teamModeProjectionSchema = z
  .object({ enabled: z.boolean(), ...teamProjectionFields })
  .strict();

/**
 * The `agentTeam` wire view of either generation.
 *
 * A union with two strict arms, not one loosened object: a hybrid
 * (`{members, enabled, …}`) or a third shape fails both arms and is reported as
 * a transient `rpc_failed` with Zod's reason — never accepted with unknown keys
 * dropped, which is how a changed upstream shape silently degrades a UI.
 */
export const teamProjectionSchema = z.union([teamRosterProjectionSchema, teamModeProjectionSchema]);
export type TeamProjection = z.infer<typeof teamProjectionSchema>;

/** The board as the pill draws it — the normalized view both generations map to. */
export const teamViewSchema = z.object({
  /** Whether this session has the Team selected. Older-generation boards are always `true`. */
  enabled: z.boolean(),
  /** The teammate roster; the Lead is the main session and is never listed here. */
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
