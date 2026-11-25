/**
 * The running-ring decision as a hold machine: `goalRunningMark` plus the 1.5s
 * idle hold, driven by the **pushed** agent status (the agent directory
 * upsert), not by a `useAgent` hook.
 *
 * The pure rule lives in `goal-polling.ts` (the offline harness asserts its
 * truth table); this module owns the one thing the rule cannot see — the moment
 * the agent last went `running → idle`. The round driver only schedules the
 * next goal round after the agent settles (`dsh-goal-round-driver`), so an armed
 * goal really does go `running → idle → running` between rounds; without a hold
 * the ring would blink off and on every round. A return to `running` clears the
 * hold, and only the running → idle edge opens a new one.
 *
 * **Why it is framework-free.** F-01 (2026-11-26): the pill's icon used to read
 * the host status with `useAgent(agentId, a => a.status)` from inside the icon
 * component. That second reader never repainted the composer pill, while the
 * panel's own read did — so the trigger's ring stayed still while the goal was
 * working. The controller now folds the directory status (which already carries
 * `PillAgent.status`, `client/agent-subscriptions.ts`) through this machine and
 * repaints the registration, the same way the team pill turns its icon from its
 * pushed board. The popover reads the resulting flag from the same store, so the
 * trigger and the panel cannot disagree.
 *
 * @module dsh-paseo/client/goal-running
 */
import {
  GOAL_RUNNING_HOLD_MS,
  goalRunningMark,
  type GoalAgentStatus,
} from "./goal-polling";
import type { GoalState } from "../shared/goal";

/** One agent's pushed status plus the hold its last running → idle edge opened. */
export interface GoalRunningState {
  readonly agentStatus: GoalAgentStatus | null | undefined;
  /** ms epoch until which a just-idled agent still counts as running. */
  readonly holdUntil: number | undefined;
}

/** The state before any status has been pushed (or for an unknown agent). */
export function initialGoalRunningState(
  agentStatus: GoalAgentStatus | null | undefined,
): GoalRunningState {
  return { agentStatus, holdUntil: undefined };
}

/**
 * Fold one pushed agent status into the hold state.
 *
 * @param state - the agent's previous state.
 * @param agentStatus - the status from the agent directory snapshot/upsert.
 * @param now - ms epoch; injected so a test can drive the window.
 */
export function goalRunningStep(
  state: GoalRunningState,
  agentStatus: GoalAgentStatus | null | undefined,
  now: number,
): GoalRunningState {
  if (agentStatus === "running") {
    // Running again: no hold to remember.
    return { agentStatus, holdUntil: undefined };
  }
  if (state.agentStatus === "running" && agentStatus === "idle") {
    return { agentStatus, holdUntil: now + GOAL_RUNNING_HOLD_MS };
  }
  return { agentStatus, holdUntil: state.holdUntil };
}

/** Whether the ring turns for one goal under this status state. */
export function goalRunningStateMark(
  state: GoalRunningState,
  phase: GoalState["phase"],
  activation: GoalState["activation"],
  now: number,
): boolean {
  return goalRunningMark({
    phase,
    activation,
    agentStatus: state.agentStatus,
    holdUntil: state.holdUntil,
    now,
  });
}

/**
 * How long the ring can stay on with no new status push, or `undefined`.
 *
 * The controller schedules one re-present at the end of the hold: without it a
 * goal whose agent went idle would keep the ring forever, because nothing else
 * pushes afterwards. A real `running` status has no deadline (the next push will
 * clear it), and a stopped hold is already off.
 */
export function goalRunningHoldRemaining(
  state: GoalRunningState,
  phase: GoalState["phase"],
  activation: GoalState["activation"],
  now: number,
): number | undefined {
  if (!goalRunningStateMark(state, phase, activation, now)) return undefined;
  if (state.holdUntil === undefined || state.holdUntil <= now) return undefined;
  return state.holdUntil - now;
}
