/**
 * Cross-pill visibility coordination for the composer's three DSH pills.
 *
 * The goal pill and the team pill each decide their own visibility; when both
 * are visible for the same agent the jobs pill steps aside, so the composer
 * keeps at most two of these three surfaces at a time. Each pill is a separate
 * module with its own poller, so this tiny per-client coordinator is the only
 * shared state: the goal and team pills report their final visibility here, and
 * the jobs pill subscribes to recompute without waiting for its next poll.
 *
 * State is per agent and starts at goal=false / team=false. `blocksJobs` is
 * true while both are true. This module is plain TypeScript — no React, no
 * host runtime — so the rule can be driven by a fake clock in `harness/`.
 *
 * @module dsh-paseo/client/pill-deference
 */

/** The two pills that can make the jobs pill defer. */
export type PillDeferenceKind = "goal" | "team";

/** Per-client coordinator shared by the three composer pill contributions. */
export interface PillDeference {
  /** Publish one pill's final visibility; only a real change notifies listeners. */
  report(kind: PillDeferenceKind, agentId: string, visible: boolean): void;
  /** True while the goal and the team pill are both visible for this agent. */
  blocksJobs(agentId: string): boolean;
  /** Listen for a visibility change of either blocking pill for one agent. */
  subscribe(agentId: string, listener: () => void): () => void;
  /** Drop one side's state for an agent, e.g. when its pill is removed. */
  forget(kind: PillDeferenceKind, agentId: string): void;
  /** Release every agent's state and listener. */
  dispose(): void;
}

/** One agent's two blocking-pill flags; absent means both false. */
interface AgentFlags {
  goal: boolean;
  team: boolean;
}

/** Create the coordinator one client (and one `contribute()` call) shares. */
export function createPillDeference(): PillDeference {
  const states = new Map<string, AgentFlags>();
  const listeners = new Map<string, Set<() => void>>();
  let disposed = false;

  const notify = (agentId: string): void => {
    const set = listeners.get(agentId);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        listener();
      } catch (error) {
        // One pill's repaint must not stop the others, but a silent swallow
        // would hide real breakage in the client bundle.
        console.error(
          `[dsh-paseo] pill deference listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  return {
    report(kind, agentId, visible) {
      if (disposed) return;
      const state = states.get(agentId);
      if (state === undefined) {
        // Both sides start false, so reporting false is not a change — and it
        // must not create an empty state entry for an agent nothing blocks.
        if (!visible) return;
        states.set(agentId, { goal: kind === "goal", team: kind === "team" });
        notify(agentId);
        return;
      }
      if (state[kind] === visible) return;
      state[kind] = visible;
      if (!state.goal && !state.team) states.delete(agentId);
      notify(agentId);
    },
    blocksJobs(agentId) {
      if (disposed) return false;
      const state = states.get(agentId);
      return state !== undefined && state.goal && state.team;
    },
    subscribe(agentId, listener) {
      if (disposed) return () => {};
      let set = listeners.get(agentId);
      if (set === undefined) {
        set = new Set();
        listeners.set(agentId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(agentId);
      };
    },
    forget(kind, agentId) {
      if (disposed) return;
      const state = states.get(agentId);
      if (state === undefined) return;
      const changed = state[kind];
      state[kind] = false;
      if (!state.goal && !state.team) {
        states.delete(agentId);
        if (changed) notify(agentId);
        return;
      }
      if (changed) notify(agentId);
    },
    dispose() {
      disposed = true;
      states.clear();
      listeners.clear();
    },
  };
}
