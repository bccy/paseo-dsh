/** Workspace summaries of the existing pill streams; this store performs no reads. */
import type { GoalState } from "../shared/goal";
import { isLiveStatus, type Job } from "../shared/jobs";
import type { TeamView } from "../shared/team";
import type { PillAgent, PillObserver, PillViewState } from "./agent-subscriptions";
import { PROVIDER_ID } from "../shared/provider";

export type WorkspaceBadgeKind = "goal" | "team" | "jobs";
export type WorkspaceBadgeTone = "danger" | "warning" | "success" | "info";
export const BADGE_PRIORITY: readonly WorkspaceBadgeTone[] = ["danger", "warning", "success", "info"];
export interface WorkspaceBadgeState {
  tone: WorkspaceBadgeTone;
  counts: Readonly<Record<WorkspaceBadgeTone, number>>;
  /** Part of danger: distinguish an unreadable state from an execution failure. */
  readFailures: number;
}
export interface WorkspaceStatus {
  goal: WorkspaceBadgeState | null;
  team: WorkspaceBadgeState | null;
  jobs: WorkspaceBadgeState | null;
}
interface Payloads { goal: GoalState | null; team: TeamView | null; jobs: readonly Job[] }
type AgentState = { [K in WorkspaceBadgeKind]?: PillViewState<Payloads[K]> };
export interface WorkspaceAgentStatus {
  agent: PillAgent;
  state: AgentState;
}
const EMPTY: WorkspaceStatus = Object.freeze({ goal: null, team: null, jobs: null });

/** Background agents only contribute observed running work, never attention or unread state. */
export function aggregateWorkspaceStatus(entries: readonly WorkspaceAgentStatus[]): WorkspaceStatus {
  const totals = {
    goal: { danger: 0, warning: 0, success: 0, info: 0 },
    team: { danger: 0, warning: 0, success: 0, info: 0 },
    jobs: { danger: 0, warning: 0, success: 0, info: 0 },
  };
  const readFailures = { goal: 0, team: 0, jobs: 0 };
  for (const { agent, state } of entries) {
    if (agent.status === "closed" || (agent.provider !== undefined && agent.provider !== PROVIDER_ID)) continue;
    const background = agent.background === true;
    const goal = state.goal;
    if (goal !== undefined) {
      if (!goal.available) {
        if (!background && goal.code !== "session_missing" && goal.code !== "goal_unavailable") { totals.goal.danger++; readFailures.goal++; }
      } else if (goal.data?.phase === "active" && goal.data.activation === "armed" && agent.status === "running") {
        totals.goal.info++;
      } else if (!background && goal.data !== null) {
        if (goal.data.phase === "complete") {
          // The pill owns the durable seen decision; absence is not evidence of unread.
          if (goal.visible === true) totals.goal.success++;
        } else totals.goal.warning++;
      }
    }
    const team = state.team;
    if (team !== undefined) {
      if (!team.available) {
        if (!background && team.code !== "session_missing" && team.code !== "team_unavailable") { totals.team.danger++; readFailures.team++; }
      } else if (team.data?.enabled) {
        const failed = Boolean(team.data.failure) || team.data.members.some((m) => m.role !== "lead" && m.phase === "failed");
        if (failed && !background) totals.team.danger++;
        // Only explicit runtime activity counts; durable active or task progress is not running.
        totals.team.info += team.data.members.filter((m) => m.role !== "lead" && m.running === true).length;
      }
    }
    // A failed read says nothing about which jobs still run; never turn it into a failure badge.
    if (state.jobs?.available) totals.jobs.info += state.jobs.data.filter((job) => isLiveStatus(job.status)).length;
  }
  const badge = (kind: WorkspaceBadgeKind): WorkspaceBadgeState | null => {
    const tone = BADGE_PRIORITY.find((candidate) => totals[kind][candidate] > 0);
    return tone === undefined ? null : { tone, counts: totals[kind], readFailures: readFailures[kind] };
  };
  const result = { goal: badge("goal"), team: badge("team"), jobs: badge("jobs") };
  return result.goal === null && result.team === null && result.jobs === null ? EMPTY : result;
}

export interface WorkspaceStatusStore {
  observer<K extends WorkspaceBadgeKind>(kind: K): PillObserver<Payloads[K]>;
  getSnapshot(workspaceId: string): WorkspaceStatus;
  subscribe(workspaceId: string, listener: () => void): () => void;
  dispose(): void;
}

/** A host-local store. Unchanged workspace snapshots retain identity for useSyncExternalStore. */
export function createWorkspaceStatusStore(): WorkspaceStatusStore {
  const entries = new Map<string, WorkspaceAgentStatus & { sources: Set<WorkspaceBadgeKind> }>();
  const snapshots = new Map<string, WorkspaceStatus>();
  const listeners = new Map<string, Set<() => void>>();
  let disposed = false;
  const refresh = (workspaceId: string | null | undefined): void => {
    if (!workspaceId || disposed) return;
    const next = aggregateWorkspaceStatus([...entries.values()].filter((entry) => entry.agent.workspaceId === workspaceId));
    const previous = snapshots.get(workspaceId) ?? EMPTY;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    if (next !== EMPTY) {
      // A jobs update must not repaint the goal/team badge on the same row.
      for (const kind of ["goal", "team", "jobs"] as const) {
        if (JSON.stringify(previous[kind]) === JSON.stringify(next[kind])) next[kind] = previous[kind];
      }
    }
    if (next === EMPTY) snapshots.delete(workspaceId);
    else snapshots.set(workspaceId, next);
    for (const listener of listeners.get(workspaceId) ?? []) listener();
  };
  return {
    observer(kind) {
      return {
        agent(agent) {
          if (disposed) return;
          const previous = entries.get(agent.id);
          const oldWorkspace = previous?.agent.workspaceId;
          if (!agent.workspaceId || agent.status === "closed" || (agent.provider !== undefined && agent.provider !== PROVIDER_ID)) {
            entries.delete(agent.id);
          } else if (previous !== undefined) {
            previous.agent = agent;
            previous.sources.add(kind);
          } else entries.set(agent.id, { agent, state: {}, sources: new Set([kind]) });
          refresh(oldWorkspace);
          refresh(agent.workspaceId);
        },
        state(agentId, state) {
          if (disposed) return;
          const entry = entries.get(agentId);
          // A late answer cannot recreate an agent whose directory registration was removed.
          if (entry === undefined || !entry.sources.has(kind)) return;
          Object.assign(entry.state, { [kind]: state });
          refresh(entry.agent.workspaceId);
        },
        remove(agentId) {
          if (disposed) return;
          const entry = entries.get(agentId);
          if (entry === undefined) return;
          delete entry.state[kind];
          entry.sources.delete(kind);
          if (entry.sources.size === 0) entries.delete(agentId);
          refresh(entry.agent.workspaceId);
        },
      };
    },
    getSnapshot: (workspaceId) => snapshots.get(workspaceId) ?? EMPTY,
    subscribe(workspaceId, listener) {
      if (disposed) return () => {};
      const set = listeners.get(workspaceId) ?? new Set();
      set.add(listener);
      listeners.set(workspaceId, set);
      return () => { set.delete(listener); if (set.size === 0) listeners.delete(workspaceId); };
    },
    dispose() {
      if (disposed) return;
      entries.clear();
      snapshots.clear();
      disposed = true;
      for (const set of listeners.values()) for (const listener of set) listener();
      listeners.clear();
    },
  };
}
