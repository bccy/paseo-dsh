/**
 * The running-ring decision as a hook: `goalRunningMark` plus the 1.5s hold.
 *
 * The pure rule lives in `goal-polling.ts` (the harness asserts its truth
 * table); this hook only supplies the two things the rule cannot see from
 * outside — the live agent status (`useAgent(agentId, a => a.status)`, host
 * session store, no polling) and the moment the agent last went idle. When the
 * agent leaves `running` for `idle` while the goal is still armed, the ring
 * keeps turning for {@link GOAL_RUNNING_HOLD_MS} so the round gap does not blink
 * it; a timer re-renders once when the hold expires.
 *
 * The hook is deliberately small and shared: the pill's icon and the panel's
 * whale must turn together, and two copies of the hold would drift.
 *
 * @module dsh-paseo/client/goal-running
 */
import { useAgent } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { GOAL_RUNNING_HOLD_MS, goalRunningMark, type GoalAgentStatus } from "./goal-polling";
import type { GoalState } from "../shared/goal";

/**
 * Whether the running ring should turn for this goal right now.
 *
 * @param phase - the goal's durable phase.
 * @param activation - armed or disarmed.
 * @param agentStatus - the live agent status, or null when the host has none.
 */
export function useGoalRunningMark(
  phase: GoalState["phase"],
  activation: GoalState["activation"],
  agentStatus: GoalAgentStatus | null | undefined,
): boolean {
  const [holdUntil, setHoldUntil] = useState<number | undefined>(undefined);
  const previous = useRef<GoalAgentStatus | null | undefined>(agentStatus);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const before = previous.current;
    previous.current = agentStatus;
    if (agentStatus === "running") {
      // Running again: no hold to remember.
      setHoldUntil(undefined);
      return;
    }
    if (before === "running" && agentStatus === "idle") {
      setHoldUntil(Date.now() + GOAL_RUNNING_HOLD_MS);
    }
  }, [agentStatus]);

  const running = goalRunningMark({ phase, activation, agentStatus, holdUntil, now });

  useEffect(() => {
    if (!running || holdUntil === undefined) return;
    const remaining = holdUntil - Date.now();
    if (remaining <= 0) return;
    // One re-render when the hold expires; the rule then answers false.
    const timer = setTimeout(() => setNow(Date.now()), remaining + 16);
    return () => clearTimeout(timer);
  }, [running, holdUntil]);

  return running;
}

/** Re-exported so the pill's icon can read the status without a second hook. */
export { useAgent };
