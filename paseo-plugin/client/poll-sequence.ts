/**
 * The poll sequence: which answer is allowed to publish.
 *
 * The pill polls one RPC per agent, and two answers can be in flight for the same
 * agent when its registration is torn down and rebuilt underneath one of them. The
 * slower answer then lands last and the count steps backwards — a settled job
 * reappearing as running.
 *
 * **Why the counter is global and never resets.** The first version kept one
 * counter per agent in a map that `removeAll()` cleared, and it was wrong twice:
 * clearing the map let a new poll take the same number an in-flight one held, and
 * `remove()` never advanced the number at all, so an answer still published into a
 * deleted entry. One counter that only goes up makes both impossible instead of
 * relying on the two sides not meeting.
 *
 * A module of its own, with no imports, so the rule is testable without React —
 * the same reason `jobs-popover-layout.ts` exists.
 *
 * @module dsh-paseo/client/poll-sequence
 */

export interface PollSequence {
  /** Take the next number for this agent, globally unique and monotonic. */
  issue(agentId: string): number;
  /** This agent's newest issued number, or `undefined` if it has none. */
  latest(agentId: string): number | undefined;
  /** Whether `seq` is still the newest number issued for this agent. */
  isCurrent(agentId: string, seq: number): boolean;
  /** Invalidate whatever is in flight for one agent, on its removal. */
  invalidate(agentId: string): void;
  /**
   * Invalidate every agent, on a fresh snapshot. The counter is **not** reset —
   * that is the point of it being global.
   */
  invalidateAll(): void;
}

export function createPollSequence(): PollSequence {
  /** The last number handed out. Never reset — see the module note. */
  let last = 0;
  /** agentId -> that agent's newest issued number. */
  const newest = new Map<string, number>();

  const issue = (agentId: string): number => {
    last += 1;
    newest.set(agentId, last);
    return last;
  };

  return {
    issue,
    latest(agentId: string): number | undefined {
      return newest.get(agentId);
    },
    isCurrent(agentId: string, seq: number): boolean {
      // `undefined === seq` is false for any `seq` a caller can hold, so an
      // invalidated agent rejects its in-flight answers without a second flag.
      return newest.get(agentId) === seq;
    },
    invalidate(agentId: string): void {
      // Forgetting the number is enough: `last` keeps rising, so the old number
      // can never be re-issued.
      newest.delete(agentId);
    },
    invalidateAll(): void {
      newest.clear();
    },
  };
}
