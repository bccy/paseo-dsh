/**
 * Fold a session's persisted log down to the transcript Paseo should replay.
 *
 * Two different things write surface replacements into a DSH log, and a replay
 * must treat them differently:
 *
 * - **A rewind** withdraws turns the user already saw. It must disappear from
 *   the replayed transcript, together with the log-only events of the withdrawn
 *   turn (`step/end`, `turn/end`, command rows) — otherwise the row set Paseo
 *   rebuilds after a rewind still contains what was just withdrawn.
 * - **A compaction** hides messages from the *model*, not from the human
 *   transcript. DSH's own source is explicit that the surface is "the
 *   model-visible surface, deliberately not the human transcript" and that
 *   append-origin events are the transcript's durable source material. Folding
 *   compaction ranges here would silently delete the conversation the user
 *   already read (measured on a real session: 205 user messages would replay as
 *   60). So compaction replacements are left alone.
 *
 * The two are distinguished by the replacement's source kind, which the log
 * format keeps durable: this bridge's rewind marker is a `user/message` whose
 * `source.kind` is `paseo-rewind`. Compaction checkpoints use
 * `compact-checkpoint`, and other producers keep their own kinds, so no
 * heuristic (empty content, range shape) has to be guessed from the payload.
 *
 * Shadowed rewind events are dropped through `seamSeq - 1`, which covers the
 * log-only tail of the withdrawn turn (the last surface node's seq comes before
 * them; nothing after the marker existed when it was appended).
 *
 * Pure: events in, events out, so it can be asserted offline and on real logs.
 *
 * @module dsh-bridge/surface
 */

/** The event types that can join the model-visible surface. */
const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);

/** The `source.kind` this bridge claims for its own rewind marker. */
export const REWIND_MARKER_SOURCE_KIND = 'paseo-rewind';

/**
 * Whether one event is this bridge's rewind marker.
 *
 * The source kind is part of the durable record (the v4 log format preserves
 * message sources), so replay after a restart can tell this bridge's marker from
 * a compaction checkpoint or another plugin's marker without inspecting payload
 * shapes.
 *
 * @param {{type?: string, data?: {source?: {kind?: string}}}} event
 * @returns {boolean}
 */
export function isRewindMarker(event) {
  return event?.type === 'user/message' && event?.data?.source?.kind === REWIND_MARKER_SOURCE_KIND;
}

/**
 * The replayed log: every event except the ranges a rewind withdrew.
 *
 * Walks the log once, maintaining the surface node list so each replacement's
 * shadowed range can be resolved the same way DSH resolves it, and records the
 * seq spans to drop. Compaction replacements update the node list but drop
 * nothing.
 *
 * @param {readonly {seq?: number, type?: string, surfaceOp?: unknown, data?: unknown}[]} events
 * @returns {{seq?: number, type?: string, surfaceOp?: unknown, data?: unknown}[]}
 */
export function visibleEvents(events) {
  /** @type {number[]} */
  const nodes = [];
  const dropped = new Set();
  for (const event of events) {
    const seq = event?.seq;
    if (typeof seq !== 'number') continue;
    if (!SURFACE_EVENT_TYPES.has(event.type)) continue; // log-only event: never a node
    const op = event.surfaceOp;
    if (op === 'append') {
      nodes.push(seq);
      continue;
    }
    if (op === undefined || typeof op !== 'object' || op === null || op.op !== 'replace') continue;
    const start = op.startSeq;
    const end = op.endSeq;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    const from = nodes.indexOf(start);
    const to = nodes.indexOf(end);
    if (from === -1 || to === -1 || to < from) continue; // cannot honour; leave nodes alone
    nodes.splice(from, to - from + 1, seq);
    if (!isRewindMarker(event)) continue; // compaction / system maintenance / another plugin
    // Drop the whole span the rewind replaced, including the log-only tail that
    // sits between the last shadowed node and the marker itself.
    for (let droppedSeq = start; droppedSeq <= seq - 1; droppedSeq += 1) dropped.add(droppedSeq);
  }
  if (dropped.size === 0) return [...events];
  return events.filter((event) => !dropped.has(event?.seq));
}
