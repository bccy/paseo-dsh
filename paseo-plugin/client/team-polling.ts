/**
 * The team pill's pure rules and its poll adapter (T3).
 *
 * Everything the pill and the panel decide lives here as plain functions, so
 * `harness/team-pill-check.cjs` can assert it without React or a host: whether
 * the pill shows, which icon it wears, the member word (and the rule that a
 * member with no live state is never called 运行中/空闲), the task mark and the
 * direction-B grouping, and the facts lines.
 *
 * Polling is `./agent-polling`'s controller, unchanged: this module only adapts
 * the `team.read` answer to it, like `./goal-polling` does for the goal.
 *
 * @module dsh-paseo/client/team-polling
 */
import { isTerminalTeamErrorCode, type TeamMember, type TeamTask, type TeamView } from "../shared/team";
import {
  createAgentPoller,
  type AgentPoller,
  type AgentPollerHost,
  type PollAgent,
  type PollAgentPage,
  type PollRemoveReason,
  type PollViewState,
} from "./agent-polling";
import type { TeamText } from "./locale";

/** One read's answer, mirroring the `team.read` contract. */
export interface TeamReadResult {
  available: boolean;
  team?: TeamView | null;
  error?: { message: string; code?: string };
}

/* -------------------------------------------------------------------------- */
/* The pill                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether there is a team to show: more than the Lead, or any task.
 *
 * DSH always synthesises the Lead row, so "one member and no task" is a session
 * that has never used the team tools — no pill (T1 §6.1), the same shape as the
 * jobs pill hiding with nothing live and the goal pill hiding with no goal.
 */
export function teamPillVisible(team: TeamView | null | undefined): boolean {
  if (team === null || team === undefined) return false;
  return team.members.length > 1 || team.tasks.length > 0;
}

/** The pill's icon state. The label is always the noun. */
export type TeamPillIcon = "running" | "failed" | "idle";

/**
 * Which mark the pill wears.
 *
 * - `failed`: the projection recorded a failure, or a member failed to start.
 *   Red `Users`.
 * - `running`: a teammate is executing a turn **and the server said so**
 *   (`running === true`). The host's running ring.
 * - `idle`: everything else, including "we do not know". Muted `Users`.
 */
export function teamPillIcon(team: TeamView): TeamPillIcon {
  if (team.failure !== undefined || team.members.some((member) => member.phase === "failed")) return "failed";
  return team.members.some((member) => member.role === "teammate" && member.running === true) ? "running" : "idle";
}

/* -------------------------------------------------------------------------- */
/* Members                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The member's live word.
 *
 * `unknown` is a real state: DSH's projection says `active`, and the server half
 * could not see the member's session (it is not hosted here). It must not read
 * as 空闲 — that would claim the member stopped — nor as 运行中.
 */
export type TeamMemberState = "running" | "idle" | "provisioning" | "failed" | "unknown";

export function teamMemberState(member: TeamMember): TeamMemberState {
  if (member.phase === "failed") return "failed";
  if (member.phase === "provisioning") return "provisioning";
  if (member.running === true) return "running";
  if (member.running === false) return "idle";
  return "unknown";
}

/** The member's state word, from the locale table. */
export function teamMemberWord(member: TeamMember, text: TeamText): string {
  const state = teamMemberState(member);
  return state === "unknown" ? text.memberActive : text.memberStates[state];
}

/** A member row's facts line: the Lead's role and state, or a teammate's state and description (or error). */
export function teamMemberFacts(member: TeamMember, text: TeamText): string {
  const word = teamMemberWord(member, text);
  const parts =
    member.role === "lead"
      ? [text.lead, teamMemberState(member) === "unknown" ? undefined : word]
      : [word, member.phase === "failed" ? member.error : member.description];
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" · ");
}

/** Lead first; then running, starting, failed, unknown, idle — "who is working" first. Stable otherwise. */
export function teamMemberOrder(members: readonly TeamMember[]): TeamMember[] {
  const rank: Record<TeamMemberState, number> = { running: 0, provisioning: 1, failed: 2, unknown: 3, idle: 4 };
  return members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => {
      if (a.member.role !== b.member.role) return a.member.role === "lead" ? -1 : 1;
      const delta = rank[teamMemberState(a.member)] - rank[teamMemberState(b.member)];
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map(({ member }) => member);
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The task's mark: the host task-list row's three (`CircleDot` / `Circle` /
 * `CircleCheck`) plus "waiting on blockers".
 *
 * Readiness is **DSH's** `ready`, never recomputed: a pending task that is not
 * ready is blocked, whatever this client thinks of its blockers.
 */
export type TeamTaskMark = "doing" | "ready" | "blocked" | "done";

export function teamTaskMark(task: TeamTask): TeamTaskMark {
  if (task.status === "completed") return "done";
  if (task.status === "in_progress") return "doing";
  return task.ready ? "ready" : "blocked";
}

/** Lucide glyph per mark. */
export const TEAM_TASK_ICONS: Readonly<Record<TeamTaskMark, "CircleDot" | "Circle" | "CircleDashed" | "CircleCheck">> = {
  doing: "CircleDot",
  ready: "Circle",
  blocked: "CircleDashed",
  done: "CircleCheck",
};

/** Direction B's group order. `done` is the folded section at the bottom. */
export const TEAM_GROUP_ORDER: readonly TeamTaskMark[] = ["doing", "ready", "blocked", "done"];

/** Tasks grouped by mark in {@link TEAM_GROUP_ORDER}, DSH's order within a group; empty groups dropped. */
export function teamTaskGroups(tasks: readonly TeamTask[]): Array<{ mark: TeamTaskMark; tasks: TeamTask[] }> {
  return TEAM_GROUP_ORDER.map((mark) => ({ mark, tasks: tasks.filter((task) => teamTaskMark(task) === mark) })).filter(
    (group) => group.tasks.length > 0,
  );
}

/** One write-scope list on one line: the first, then `+N`. */
function scopesLine(scopes: readonly string[]): string | undefined {
  if (scopes.length === 0) return undefined;
  return scopes.length === 1 ? scopes[0] : `${scopes[0]} +${String(scopes.length - 1)}`;
}

/**
 * A task row's facts line: id · owner · blockers · scopes.
 *
 * The owner falls back to 未分配 except on a done task (an unowned completed
 * task has nothing to assign). Blockers show only while they block (pending,
 * not ready). The mark word is not repeated: the group header says it.
 */
export function teamTaskFacts(task: TeamTask, text: TeamText): string {
  const blocking = task.status === "pending" && !task.ready && task.blockedBy.length > 0;
  const parts = [
    task.id,
    task.ownerName ?? (task.status === "completed" ? undefined : text.unowned),
    blocking ? text.blockedBy(task.blockedBy.join(text.listSeparator)) : undefined,
    scopesLine(task.writeScopes),
  ];
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" · ");
}

/** DSH's overlap sentence in the panel's language, verbatim when unknown. */
export function teamWarningText(raw: string, text: TeamText): string {
  return text.translateWarning(raw) ?? raw;
}

/** The detail page's field list for one task (label, value). Empty fields are left out; the owner never is. */
export function teamTaskFields(task: TeamTask, text: TeamText): Array<{ label: string; value: string; tone?: "warning" }> {
  const fields: Array<{ label: string; value: string; tone?: "warning" }> = [
    { label: text.fields.status, value: text.marks[teamTaskMark(task)] },
    { label: text.fields.owner, value: task.ownerName ?? text.unowned },
  ];
  if (task.blockedBy.length > 0) fields.push({ label: text.fields.blockedBy, value: task.blockedBy.join(text.listSeparator) });
  if (task.writeScopes.length > 0) fields.push({ label: text.fields.writeScopes, value: task.writeScopes.join("\n") });
  for (const warning of task.writeScopeWarnings) {
    fields.push({ label: text.fields.warnings, value: teamWarningText(warning, text), tone: "warning" });
  }
  fields.push({ label: text.fields.revision, value: String(task.revision) });
  return fields;
}

/* -------------------------------------------------------------------------- */
/* Polling                                                                     */
/* -------------------------------------------------------------------------- */

/** The team pill's host half, the goal adapter's shape. */
export interface TeamPollerHost {
  readTeam(agentId: string): Promise<TeamReadResult>;
  listAgentPage(cursor: string): Promise<PollAgentPage>;
  addAgent(agent: PollAgent): void;
  removeAgent(agentId: string, reason: PollRemoveReason, error?: TeamReadResult["error"]): void;
  publishState(agentId: string, team: TeamView | null): void;
  onError(message: string, error?: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  random?: () => number;
}

/**
 * The per-agent poll controller: `createAgentPoller` with the team payload.
 *
 * Like the goal pill, a transient read error **keeps the last board** (one bad
 * poll must not make a team vanish), and a terminal code removes the pill (a
 * profile without the agent-team bundle looks like a profile without teams).
 */
export function createTeamPoller(host: TeamPollerHost): AgentPoller {
  const adapter: AgentPollerHost<TeamView | null> = {
    read: async (agentId) => {
      const result = await host.readTeam(agentId);
      if (!result.available) return { available: false, error: result.error };
      return { available: true, data: result.team ?? null };
    },
    listAgentPage: (cursor) => host.listAgentPage(cursor),
    addAgent: (agent) => host.addAgent(agent),
    removeAgent: (agentId, reason, error) => host.removeAgent(agentId, reason, error),
    publishState: (agentId, state: PollViewState<TeamView | null>) => {
      if (!state.available) return;
      host.publishState(agentId, state.data);
    },
    onError: (message, error) => host.onError(message, error),
    setTimeout: (callback, delayMs) => host.setTimeout(callback, delayMs),
    clearTimeout: (handle) => host.clearTimeout(handle),
    ...(host.random === undefined ? {} : { random: host.random }),
    isTerminalErrorCode: isTerminalTeamErrorCode,
    initialData: null,
    fallbackErrorMessage: "the DSH runtime could not read this agent's team",
    pillLabel: "team pill",
    publishOnTransientError: false,
  };
  return createAgentPoller(adapter);
}
