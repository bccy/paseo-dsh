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
 * Recording is fail-open: a child whose turn started before this process could
 * observe it has no anchor, and callers must not guess (a wrong cancel kills
 * work the user kept).
 *
 * Pure (no DSH imports) so the rules are assertable offline.
 *
 * @module dsh-bridge/child-anchors
 */

export class ChildAnchors {
  /** @type {Map<string, number>} child session id -> root human-message seq. */
  #byChild = new Map();

  /**
   * Record (or refresh) one child's dispatch anchor.
   *
   * @param {unknown} childId - the child session id.
   * @param {unknown} anchorSeq - the root human-message seq at its turn start.
   * @returns {boolean} whether the anchor was accepted.
   */
  record(childId, anchorSeq) {
    const id = String(childId);
    if (id === '' || id === 'undefined') return false;
    if (!Number.isSafeInteger(anchorSeq) || anchorSeq < 0) return false;
    this.#byChild.set(id, anchorSeq);
    return true;
  }

  /**
   * The recorded anchor of one child, if any.
   *
   * @param {unknown} childId
   * @returns {number | undefined}
   */
  anchorFor(childId) {
    return this.#byChild.get(String(childId));
  }

  /**
   * Child sessions whose current turn was dispatched at or after `targetSeq` —
   * i.e. every child whose dispatch message a rewind to `targetSeq` withdraws.
   * Unknown anchors are deliberately excluded.
   *
   * @param {unknown} targetSeq
   * @returns {string[]}
   */
  withdrawnSince(targetSeq) {
    if (!Number.isSafeInteger(targetSeq)) return [];
    const ids = [];
    for (const [id, anchor] of this.#byChild) {
      if (anchor >= targetSeq) ids.push(id);
    }
    return ids;
  }

  /** Number of recorded children (diagnostics/tests). */
  get size() {
    return this.#byChild.size;
  }
}
