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
 * Seqs that a replace operation removed from the surface.
 *
 * @param {readonly {seq?: number, surfaceOp?: unknown}[]} events - persisted events.
 * @returns {Set<number>}
 */
export function shadowedSeqs(events) {
  /** @type {number[]} */
  const nodes = [];
  const shadowed = new Set();
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
    // whatever it shadowed, so leave the nodes alone rather than guess.
    if (from === -1 || to === -1 || to < from) continue;
    for (let index = from; index <= to; index += 1) shadowed.add(nodes[index]);
    nodes.splice(from, to - from + 1, seq);
  }
  return shadowed;
}

/**
 * The log with the shadowed events removed, in log order.
 *
 * Only the shadowed events are dropped: log-only events (`turn/end`,
 * `command/*`, compaction markers) carry no surface marker and are still what
 * the timeline builder folds a replayed conversation from — filtering them out
 * would rebuild a session with no settled tools and no compaction row.
 *
 * @param {readonly {seq?: number}[]} events
 * @returns {{seq?: number}[]}
 */
export function visibleEvents(events) {
  const shadowed = shadowedSeqs(events);
  if (shadowed.size === 0) return [...events];
  return events.filter((event) => !shadowed.has(event?.seq));
}
