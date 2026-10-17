/**
 * Offline check for the bridge's surface fold.
 *
 * A rewind appends a replace operation instead of deleting events, so replaying
 * the raw log after a rewind resurrects exactly what the user just removed —
 * which is what Paseo's post-rewind re-hydrate was showing. `surfaceNodes` is the
 * fold that keeps replay honest, so its replace semantics are pinned here.
 *
 * Pure-module check: no DSH profile, no daemon, no model.
 *
 * Usage: node harness/surface-check.mjs
 */
import { surfaceEvents, surfaceNodes } from '../dsh-bridge/lib/surface.js';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

const append = (seq) => ({ seq, surfaceOp: 'append' });
const replace = (seq, start, end) => ({ seq, surfaceOp: { op: 'replace', startSeq: start, endSeq: end } });
const logOnly = (seq) => ({ seq });

console.log('append and log-only events');
{
  check('appends become nodes', JSON.stringify(surfaceNodes([append(0), append(1)])) === '[0,1]');
  check('log-only events never become nodes', JSON.stringify(surfaceNodes([append(0), logOnly(1), append(2)])) === '[0,2]');
  check('an empty log has no surface', surfaceNodes([]).length === 0);
  check('a seq-less event is ignored', surfaceNodes([{ surfaceOp: 'append' }]).length === 0);
}

console.log('replace operations (what a rewind appends)');
{
  // A rewind over [1..3] appends seq 4 carrying that range.
  const events = [append(0), append(1), append(2), append(3), replace(4, 1, 3)];
  check('the whole range collapses to the replacement', JSON.stringify(surfaceNodes(events)) === '[0,4]', JSON.stringify(surfaceNodes(events)));
  // A rewind of only the tail.
  const tail = [append(0), append(1), append(2), replace(3, 2, 2)];
  check('a single-node range collapses to that node', JSON.stringify(surfaceNodes(tail)) === '[0,1,3]', JSON.stringify(surfaceNodes(tail)));
  // Events after the replacement still append normally.
  const after = [append(0), append(1), replace(2, 1, 1), append(3)];
  check('later appends follow the replacement', JSON.stringify(surfaceNodes(after)) === '[0,2,3]', JSON.stringify(surfaceNodes(after)));
}

console.log('bad ranges do not resurrect anything');
{
  const missingStart = [append(0), append(1), replace(2, 9, 1)];
  check('an unknown start keeps the surface intact', JSON.stringify(surfaceNodes(missingStart)) === '[0,1]');
  const reversed = [append(0), append(1), append(2), replace(3, 2, 0)];
  check('a reversed range keeps the surface intact', JSON.stringify(surfaceNodes(reversed)) === '[0,1,2]');
  const badOp = [append(0), { seq: 1, surfaceOp: { op: 'nope', startSeq: 0, endSeq: 0 } }];
  check('an unknown op is not a node', JSON.stringify(surfaceNodes(badOp)) === '[0]');
}

console.log('events reduced to the surface');
{
  const events = [
    { seq: 0, surfaceOp: 'append', type: 'system/message' },
    { seq: 1, surfaceOp: 'append', type: 'user/message' },
    { seq: 2, surfaceOp: 'append', type: 'assistant/message' },
    { seq: 3, surfaceOp: 'append', type: 'tool/result' },
    { seq: 4, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 }, type: 'assistant/message' },
    { seq: 5, surfaceOp: 'append', type: 'user/message' },
  ];
  const kept = surfaceEvents(events).map((event) => event.seq);
  check('the shadowed messages are gone', JSON.stringify(kept) === '[0,4,5]', JSON.stringify(kept));
  check('the replacement event itself is kept', surfaceEvents(events)[1]?.type === 'assistant/message');
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
