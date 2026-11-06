/**
 * The team pill's pure rules and its poll adapter (T3).
 *
 * Everything the pill and the panel decide lives here as plain functions, so
 * `harness/team-pill-check.cjs` can assert it without React or a host: whether
 * the pill shows, which icon it wears, the roster headline's chips (T7) and the owner's ring / 已停止 tag (T5: a
 * member with no live state is never counted as running, and no idle word is
 * ever drawn), the owner's running ring, the task mark and the direction-B
 * grouping, and the facts lines.
 *
 * Which popover unmount is a *user close* (UI-v7) is not decided here: the host
 * remounts the body once when it opens, so an unmount alone means nothing —
 * that rule is `./seen-close-gate`, shared with the goal pill.
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
 * Whether there is a team to show: **any task**, and nothing else.
 *
 * The user decided on 2026-11-06 that starting teammates is not a reason to
 * light the pill: a team of running members with no shared task only shows
 * 「N 名成员 / 暂无共享任务」, so the pill must stay hidden for exactly that
 * case. The teammate count no longer takes part — a task is the board's point,
 * and it shows the pill even when no member row exists yet.
 *
 * A board whose tasks are **all completed** is shown once more and then hidden
 * once the user has seen it (UI-v7, the user's 2026-11-06 decision): `seen` is
 * the remembered {@link teamAllDoneKey} for this agent, and an all-done board
 * whose key equals it is hidden. A new task or a revision change makes a new
 * key, so the pill shows once more.
 *
 * A board that is `null`/`undefined` — no team, or one the session never used
 * — stays hidden, the same shape as the jobs pill hiding with nothing live and
 * the goal pill with no goal. A profile without the team bundle is **not** this
 * case: it is the terminal `team_unavailable`, which removes the pill.
 */
export function teamPillVisible(team: TeamView | null | undefined, seen?: string): boolean {
  if (team === null || team === undefined) return false;
  if (team.tasks.length === 0) return false;
  const key = teamAllDoneKey(team);
  if (key !== undefined && key === seen) return false;
  return true;
}

/** How many teammates the board has — the Lead (the main session) is not one. */
export function teamMateCount(team: TeamView): number {
  return team.members.filter((member) => member.role === "teammate").length;
}

/* -------------------------------------------------------------------------- */
/* An all-done board's "seen" state (UI-v7)                                    */
/* -------------------------------------------------------------------------- */

/**
 * The key an all-done board's "seen" state is remembered under: the tasks
 * sorted by id, each as `id:revision`, joined with `,`.
 *
 * `undefined` while the board is empty or any task is not `completed` — a
 * working board is always visible and has nothing to remember. A new task, a
 * revision change or a different set of ids is a new key, so the pill shows
 * once more.
 */
export function teamAllDoneKey(team: TeamView): string | undefined {
  if (team.tasks.length === 0) return undefined;
  if (!team.tasks.every((task) => task.status === "completed")) return undefined;
  return [...team.tasks]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((task) => `${task.id}:${String(task.revision)}`)
    .join(",");
}

/**
 * Per-agent progress towards "the user has moved on from this all-done board".
 *
 * - `watching`: an all-done board with this key was observed; the turn that
 *   completed it may still be running (the model writes its closing summary
 *   after the last `team_task_update`), so a `running` here proves nothing.
 * - `idleSeen`: the agent went idle after the completion. The **next**
 *   `running` is a new turn — the user's next message, as far as the client can
 *   tell (the plugin API has no composer-submit signal) — and marks it seen.
 */
export interface TeamCompleteWatch {
  readonly key: string;
  readonly stage: "watching" | "idleSeen";
}

/** One input to {@link teamCompleteSeenStep}. */
export type TeamSeenEvent =
  /**
   * A poll answer: the board now (null when there is none), and the agent's last
   * known status. Polls are seconds apart, so the completing turn may already
   * have ended when "all done" is first observed; an idle agent at that moment
   * starts the watch at `idleSeen`, or the user's next message would be missed.
   */
  | { readonly kind: "board"; readonly team: TeamView | null; readonly agentStatus?: string }
  /** The agent's status, from the agent directory subscription. */
  | { readonly kind: "agent"; readonly status: string | undefined }
  /**
   * The all-done panel was opened and then **really** closed: the popover body's
   * unmount survived the confirmation window in `./seen-close-gate`.
   */
  | { readonly kind: "closed"; readonly team: TeamView | null };

/** The machine's state: the remembered seen key and the watch in progress. */
export interface TeamSeenState {
  readonly seen?: string;
  readonly watch?: TeamCompleteWatch;
}

/**
 * Advance one agent's "seen" state.
 *
 * Seen means: the panel of that all-done board was closed after being opened,
 * or a turn started after the completing turn had ended (idle, then running).
 * The completing turn's own `running → idle` only moves the watch to
 * `idleSeen`; a completion first observed while the agent is already idle
 * starts there. A board that is no longer all done (a task reopened, a new one
 * added) drops the watch; the remembered key stays, so the same
 * `id:revision` set cannot reappear, and any new key is shown again.
 */
export function teamCompleteSeenStep(state: TeamSeenState, event: TeamSeenEvent): TeamSeenState {
  switch (event.kind) {
    case "board": {
      const team = event.team;
      const key = team === null ? undefined : teamAllDoneKey(team);
      if (key === undefined) {
        return state.seen === undefined ? {} : { seen: state.seen };
      }
      if (state.seen === key) return { seen: key };
      if (state.watch?.key === key) return state;
      const stage = event.agentStatus === "idle" ? "idleSeen" : "watching";
      return { ...(state.seen === undefined ? {} : { seen: state.seen }), watch: { key, stage } };
    }
    case "agent": {
      const watch = state.watch;
      if (watch === undefined) return state;
      if (event.status === "idle" && watch.stage === "watching") {
        return { ...state, watch: { key: watch.key, stage: "idleSeen" } };
      }
      if (event.status === "running" && watch.stage === "idleSeen") return { seen: watch.key };
      return state;
    }
    case "closed": {
      const team = event.team;
      const key = team === null ? undefined : teamAllDoneKey(team);
      if (key === undefined) return state;
      return { seen: key };
    }
  }
}

/** The pill's icon state. The label is always the noun. */
export type TeamPillIcon = "running" | "failed" | "complete" | "idle";

/**
 * Which mark the pill wears.
 *
 * - `failed`: the projection recorded a failure, or a member failed to start.
 *   Red `Users`. **Outranks everything**: an error must not be painted over by a
 *   finished board.
 * - `complete`: **every task is `completed`** (UI-v8, the user's 2026-11-06
 *   decision) — the green `CircleCheck`, the goal pill's complete mark. Only a
 *   board with at least one task can be complete: `tasks.length > 0` is part of
 *   the rule, because an empty board has no work to finish (and the pill is
 *   hidden for it anyway — {@link teamPillVisible}).
 * - `running`: a teammate is executing a turn **and the server said so**
 *   (`running === true`). The host's running ring.
 * - `idle`: everything else, including "we do not know". Muted `Users`.
 *
 * Priority: `failed` > `complete` > `running` > `idle`.
 */
export function teamPillIcon(team: TeamView): TeamPillIcon {
  if (team.failure !== undefined || team.members.some((member) => member.phase === "failed")) return "failed";
  if (team.tasks.length > 0 && team.tasks.every((task) => task.status === "completed")) return "complete";
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
 * The roster headline's status chips (T7, direction 2): 「DeepSeek」 +
 * 「N 名成员」, then one chip per non-zero count — 创建失败, 运行中, 已停止,
 * 任务完成 N/M — in that order.
 *
 * **Only teammates are counted** (the Lead is the main session the user is
 * already looking at): `running` / `stopped` come only from the server's own
 * run state and are left out entirely when no teammate carries `running`
 * (unknown is not idle and not busy); `running` counts teammates with
 * `running === true` (the pill's ring rule), `stopped` teammates with
 * `running === false`, `failed` teammates that failed to start. `done` is the
 * board's task completion: members have no done state. A count of zero never
 * becomes a chip.
 */
export type TeamHeadKey = "failed" | "running" | "stopped" | "done";

export interface TeamHeadItem {
  key: TeamHeadKey;
  /** `2`, or `5/8` for the task count. */
  count: string;
}

export function teamHeadItems(team: TeamView): TeamHeadItem[] {
  const mates = team.members.filter((member) => member.role === "teammate");
  const known = mates.some((member) => member.running !== undefined);
  const states = mates.map((member) => teamMemberState(member));
  const failed = states.filter((state) => state === "failed").length;
  const running = states.filter((state) => state === "running").length;
  const stopped = states.filter((state) => state === "idle").length;
  const done = team.tasks.filter((task) => task.status === "completed").length;
  const items: TeamHeadItem[] = [];
  if (failed > 0) items.push({ key: "failed", count: String(failed) });
  if (known && running > 0) items.push({ key: "running", count: String(running) });
  if (known && stopped > 0) items.push({ key: "stopped", count: String(stopped) });
  if (done > 0) items.push({ key: "done", count: `${String(done)}/${String(team.tasks.length)}` });
  return items;
}

/**
 * The narrow-width ladder. The chips must stay on the headline's one line;
 * each level is laid out (invisibly) and the first that fits is shown:
 * full words → short words → drop 已停止 (the 进行中 header already says
 * 「N 个负责人已停止」) → drop 任务完成 (the 已完成 group keeps its count).
 * 创建失败 and 运行中 are never dropped and never lose their word.
 */
export interface TeamHeadLevel {
  short: boolean;
  drop: readonly TeamHeadKey[];
}
export const TEAM_HEAD_LEVELS: readonly TeamHeadLevel[] = [
  { short: false, drop: [] },
  { short: true, drop: [] },
  { short: true, drop: ["stopped"] },
  { short: true, drop: ["stopped", "done"] },
];

/** The chips one level keeps. */
export function teamHeadAt(items: readonly TeamHeadItem[], level: TeamHeadLevel): TeamHeadItem[] {
  return items.filter((item) => !level.drop.includes(item.key));
}

/**
 * Which level to show: the first whose measured width fits `room`. Before
 * anything is measured the full level is drawn; when nothing fits, the last
 * (which still keeps 失败 and 运行中 with their words).
 */
export function teamHeadLevel(widths: readonly (number | undefined)[], room: number | undefined): number {
  if (room === undefined) return 0;
  for (let index = 0; index < TEAM_HEAD_LEVELS.length; index += 1) {
    const width = widths[index];
    if (width === undefined) return index === 0 ? 0 : index - 1;
    if (width <= room) return index;
  }
  return TEAM_HEAD_LEVELS.length - 1;
}

/** One chip's text: 「2 运行中」 / short 「2 运行」. */
export function teamHeadLabel(item: TeamHeadItem, text: TeamText, short: boolean): string {
  const words = short ? text.head.short : text.head.words;
  return `${item.count} ${words[item.key]}`;
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
