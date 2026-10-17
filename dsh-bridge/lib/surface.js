/**
 * Fold a session's persisted events down to its visible surface.
 *
 * DSH marks every surface-eligible event with an append marker or a replace
 * operation; replaying `history()` without folding means a rewind (or a
 * compaction) looks like it never happened — Paseo re-hydrates the timeline from
 * exactly this read after a rewind, so the reverted rows came back and the
 * button appeared to do nothing. Folding here, once, keeps every replay path
 * (root, child, import) honest.
 *
 * Pure: a seq list in, a seq list out, so it can be asserted offline.
 *
 * @module dsh-bridge/surface
 */

/**
 * Visible seqs in surface order.
 *
 * Events without a surface marker are not surface-eligible and never become
 * nodes; log-only events (`command/run`, `turn/end`, …) are exactly that.
 *
 * @param {readonly {seq?: number, surfaceOp?: unknown}[]} events - persisted events. A
 *   replace op carries `startSeq`/`endSeq` (DSH's own spelling), not `start`/`end`.
 * @returns {number[]} visible seqs, oldest first.
 */
export function surfaceNodes(events) {
  /** @type {number[]} */
  const nodes = [];
  for (const event of events) {
    const seq = event?.seq;
    if (typeof seq !== 'number') continue;
    const op = event?.surfaceOp;
    if (op === undefined) continue;
    if (op === 'append') {
      nodes.push(seq);
      continue;
    }
    if (typeof op !== 'object' || op === null || op.op !== 'replace') continue;
    const start = op.startSeq;
    const end = op.endSeq;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    const from = nodes.indexOf(start);
    const to = nodes.indexOf(end);
    // A range that is not (or no longer) contiguous in the surface is a log the
    // replay cannot honour; dropping the replacement would silently resurrect
    // whatever it shadowed, so keep the nodes as they are and let the event sort
    // itself out — DSH's own replay rejects such a log.
    if (from === -1 || to === -1 || to < from) continue;
    nodes.splice(from, to - from + 1, seq);
  }
  return nodes;
}

/**
 * The events of a log, reduced to the visible surface and ordered by it.
 *
 * @param {readonly {seq?: number, surfaceOp?: unknown}[]} events
 * @returns {{seq?: number, surfaceOp?: unknown}[]}
 */
export function surfaceEvents(events) {
  const bySeq = new Map();
  for (const event of events) {
    if (typeof event?.seq === 'number') bySeq.set(event.seq, event);
  }
  return surfaceNodes(events)
    .map((seq) => bySeq.get(seq))
    .filter((event) => event !== undefined);
}
