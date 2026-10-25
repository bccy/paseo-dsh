/**
 * Which root human message "dispatched" each delegated (subagent) session.
 *
 * A rewind withdraws a range of the root conversation. A subagent started by a
 * message inside that range has to be stopped too — otherwise it keeps working
 * on instructions the user just withdrew, and the files it writes afterwards
 * anchor to an older message, becoming impossible to revert. A subagent started
 * by an earlier, still-visible message must keep running.
 *
 * The anchor is the root session's newest human-message seq at the moment the
 * child's own turn starts:
 *
 * - a fresh delegation: that message is the turn whose `subagent` tool call
 *   created the child;
 * - a continuable child resumed with `send_message`: that message is the turn
 *   whose instruction the child is now running (the anchor is refreshed on every
 *   `turn/start`).
 *
 * Anchors are scoped by ROOT session. One bridge process serves many Paseo
 * sessions, so a child's anchor seq is only meaningful against the root that
 * dispatched it: `12` under root A and `12` under root B are different human
 * messages, and a rewind in A must not touch B's children. `record` therefore
 * stores the owning root alongside the seq, and `withdrawnSince` filters by it.
 *
 * Recording is fail-open: a child whose turn started before this process could
 * observe it has no anchor, and callers must not guess (a wrong cancel kills
 * work the user kept).
 *
 * Pure (no DSH imports) so the rules are assertable offline.
 *
 * @module dsh-bridge/child-anchors
 */

export class ChildAnchors {
  /**
   * child session id -> { rootSessionId, anchorSeq }.
   *
   * @type {Map<string, {rootSessionId: string | undefined, anchorSeq: number}>}
   */
  #byChild = new Map();

  /**
   * Record (or refresh) one child's dispatch anchor.
   *
   * @param {unknown} childId - the child session id.
   * @param {unknown} anchorSeq - the root human-message seq at its turn start.
   * @param {unknown} [rootSessionId] - the root session that dispatched it. The
   *   bridge always passes it; omitting it records an unscoped anchor, which only
   *   `withdrawnSince` without a root can see.
   * @returns {boolean} whether the anchor was accepted.
   */
  record(childId, anchorSeq, rootSessionId) {
    const id = String(childId);
    if (id === '' || id === 'undefined') return false;
    if (!Number.isSafeInteger(anchorSeq) || anchorSeq < 0) return false;
    const root = rootSessionId === undefined || rootSessionId === null ? undefined : String(rootSessionId);
    this.#byChild.set(id, {
      rootSessionId: root === '' || root === 'undefined' ? undefined : root,
      anchorSeq,
    });
    return true;
  }

  /**
   * The recorded anchor of one child, if any.
   *
   * @param {unknown} childId
   * @returns {number | undefined}
   */
  anchorFor(childId) {
    return this.#byChild.get(String(childId))?.anchorSeq;
  }

  /**
   * Child sessions whose current turn was dispatched at or after `targetSeq` —
   * i.e. every child whose dispatch message a rewind to `targetSeq` withdraws.
   * Unknown anchors are deliberately excluded.
   *
   * @param {unknown} targetSeq
   * @param {unknown} [rootSessionId] - only return children dispatched by this
   *   root. **Omitted means every session in the process**, which is only kept
   *   for old callers (`harness/rewind-merge-check.mjs`); production paths must
   *   pass it. Without the filter a rewind in one session kills the children of
   *   every other session whose dispatch seq happens to be in range.
   * @returns {string[]}
   */
  withdrawnSince(targetSeq, rootSessionId) {
    if (!Number.isSafeInteger(targetSeq)) return [];
    const scoped = rootSessionId === undefined || rootSessionId === null
      ? undefined
      : String(rootSessionId);
    const ids = [];
    for (const [id, entry] of this.#byChild) {
      if (entry.anchorSeq < targetSeq) continue;
      if (scoped !== undefined && entry.rootSessionId !== scoped) continue;
      ids.push(id);
    }
    return ids;
  }

  /**
   * Forget every child dispatched by one root, for a closing session.
   *
   * Idempotent, and cheap enough to call for a session that recorded nothing:
   * without it the anchors of a closed session outlive it and a later rewind in
   * a different root could still match them.
   *
   * @param {unknown} rootSessionId
   * @returns {number} how many anchors were dropped.
   */
  delete(rootSessionId) {
    const root = rootSessionId === undefined || rootSessionId === null ? undefined : String(rootSessionId);
    if (root === undefined || root === '' || root === 'undefined') return 0;
    let dropped = 0;
    for (const [id, entry] of this.#byChild) {
      if (entry.rootSessionId !== root) continue;
      this.#byChild.delete(id);
      dropped += 1;
    }
    return dropped;
  }

  /**
   * Drop one child's anchor by its own id.
   *
   * @param {unknown} childId
   * @returns {boolean} whether an anchor existed.
   */
  deleteChild(childId) {
    return this.#byChild.delete(String(childId));
  }
}
