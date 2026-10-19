/**
 * Interrupt the delegated agents a rewind withdraws.
 *
 * A rewind to `targetSeq` withdraws that human message and everything after it,
 * so a subagent whose *current turn* was dispatched at or after `targetSeq` is
 * working on instructions the user just removed: it has to stop. A subagent
 * dispatched by an earlier, still-visible turn must keep running.
 *
 * The interrupt itself is injected (`interrupt(childId)`, normally DSH's
 * `subagents.interrupt(childId, {kind:'ancestor', agent})`) so the policy is
 * assertable offline: which children are signalled, in what order, and that one
 * refused interrupt does not abort the rest.
 *
 * Failure policy: an interrupt error is recorded and reported through `onError`
 * but never thrown — the withdrawable conversation is already gone, and a
 * rewind must not fail because one child could not be told to stop. The child
 * then simply keeps running (documented limitation).
 *
 * @module dsh-bridge/delegated-cancel
 */

/**
 * @param {import('./child-anchors.js').ChildAnchors} anchors
 * @param {number} targetSeq
 * @param {(childId: string) => void} interrupt - fire-and-return cancel.
 * @param {(childId: string, error: unknown) => void} [onError]
 * @returns {{signalled: string[], failed: Array<{childId: string, error: string}>}}
 */
export function cancelWithdrawnDelegations(anchors, targetSeq, interrupt, onError) {
  const signalled = [];
  const failed = [];
  for (const childId of anchors.withdrawnSince(targetSeq)) {
    try {
      interrupt(childId);
      signalled.push(childId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ childId, error: message });
      if (onError !== undefined) onError(childId, error);
    }
  }
  return { signalled, failed };
}
