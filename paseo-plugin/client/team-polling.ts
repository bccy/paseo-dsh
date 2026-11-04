/**
 * The team pill's pure rules and its poll adapter (T3).
 *
 * Everything the pill and the panel decide lives here as plain functions, so
 * `harness/team-pill-check.cjs` can assert it without React or a host: whether
 * the pill shows, which icon it wears, the roster's one-line summary and the owner's ring / 已停止 tag (T5: a
 * member with no live state is never counted as running, and no idle word is
 * ever drawn), the owner's running ring, the task mark and the direction-B
 * grouping, and the facts lines.
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
 * The member's live state.
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

/**
 * The roster's one-line summary (T5): 「10 名成员 · 2 个运行中 · 1 个创建失败」.
 *
 * The member rows are gone — Paseo's own subagent panel lists the members and
 * opens them — so the panel keeps only this line. `running` counts members the
 * server *said* run (`running === true`) and is shown only when there is at
 * least one: a count of zero, or any idle word, would claim knowledge the
 * server half may not have (an unhosted member carries no `running`). Failed
 * members are counted separately so the line can tint that part red.
 */
export interface TeamMemberSummary {
  total: number;
  running: number;
  failed: number;
}

export function teamMemberSummary(members: readonly TeamMember[]): TeamMemberSummary {
  return {
    total: members.length,
    running: members.filter((member) => teamMemberState(member) === "running").length,
    failed: members.filter((member) => teamMemberState(member) === "failed").length,
  };
}

/** The summary's plain half (count, then the running count when positive) and its red half (or ""). */
export function teamMemberSummaryText(summary: TeamMemberSummary, text: TeamText): { plain: string; failed: string } {
  const plain = [text.memberCount(summary.total), summary.running > 0 ? text.runningCount(summary.running) : undefined]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  return { plain, failed: summary.failed > 0 ? text.failedCount(summary.failed) : "" };
}

/**
 * What the panel says about a task's owner (T5): `running` (the host ring),
 * `stopped` (a grey 已停止 tag), or `undefined` (nothing).
 *
 * Both marks come only from the server's own knowledge of that member:
 * `running === true` → running, `running === false` → stopped. A member with no
 * `running` (not hosted here), a failed or starting member, an owner not on the
 * roster, and an unowned task all get **no** mark — "stopped" claims the
 * server saw it stop, and an unknown member was not seen at all.
 *
 * Marks are drawn on unfinished tasks only. A completed task's owner being idle
 * is the normal end; the case the stopped tag exists for is an `in_progress`
 * task whose owner finished without completing or releasing it (DSH does not
 * release on exit). Status and grouping stay DSH's — nothing here re-judges a
 * task as done.
 */
export type TeamOwnerState = "running" | "stopped";

export function teamOwnerState(task: TeamTask, members: readonly TeamMember[]): TeamOwnerState | undefined {
  if (task.ownerName === undefined || task.status === "completed") return undefined;
  const owner = members.find((member) => member.name === task.ownerName);
  if (owner === undefined) return undefined;
  const state = teamMemberState(owner);
  return state === "running" ? "running" : state === "idle" ? "stopped" : undefined;
}

/** Whether a task's owner is running right now (the ring). */
export function teamOwnerRunning(task: TeamTask, members: readonly TeamMember[]): boolean {
  return teamOwnerState(task, members) === "running";
}

/** How many tasks in a group have an owner the server saw stop (the 进行中 header's trailing note). */
export function teamStoppedOwnerCount(tasks: readonly TeamTask[], members: readonly TeamMember[]): number {
  return tasks.filter((task) => teamOwnerState(task, members) === "stopped").length;
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
 * A task row's facts line, in three pieces so the owner's running ring can sit
 * right after the owner's name: `lead` (id · owner), `trail` (· blockers ·
 * scopes, with its leading separator) and whether `lead` ends with an owner.
 *
 * The owner falls back to 未分配 except on a done task (an unowned completed
 * task has nothing to assign). Blockers show only while they block (pending,
 * not ready). The mark word is not repeated: the group header says it.
 */
export function teamTaskFactsParts(task: TeamTask, text: TeamText): { lead: string; owner: boolean; trail: string } {
  const blocking = task.status === "pending" && !task.ready && task.blockedBy.length > 0;
  const head = [task.id, task.ownerName ?? (task.status === "completed" ? undefined : text.unowned)].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  const rest = [blocking ? text.blockedBy(task.blockedBy.join(text.listSeparator)) : undefined, scopesLine(task.writeScopes)].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return { lead: head.join(" · "), owner: task.ownerName !== undefined, trail: rest.length === 0 ? "" : ` · ${rest.join(" · ")}` };
}

/** The same facts as one string (accessibility names, tests). */
export function teamTaskFacts(task: TeamTask, text: TeamText): string {
  const parts = teamTaskFactsParts(task, text);
  return `${parts.lead}${parts.trail}`;
}

/** DSH's overlap sentence in the panel's language, verbatim when unknown. */
export function teamWarningText(raw: string, text: TeamText): string {
  return text.translateWarning(raw) ?? raw;
}

/** The detail page's field list for one task (label, value). Empty fields are left out; the owner never is. */
export function teamTaskFields(
  task: TeamTask,
  text: TeamText,
  /** The board's roster, for the owner's running ring; omitted (the timeline card) → never running. */
  members: readonly TeamMember[] = [],
): Array<{ label: string; value: string; tone?: "warning"; owner?: TeamOwnerState }> {
  const owner: { label: string; value: string; owner?: TeamOwnerState } = { label: text.fields.owner, value: task.ownerName ?? text.unowned };
  const state = teamOwnerState(task, members);
  if (state !== undefined) owner.owner = state;
  const fields: Array<{ label: string; value: string; tone?: "warning"; owner?: TeamOwnerState }> = [
    { label: text.fields.status, value: text.marks[teamTaskMark(task)] },
    owner,
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
