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
import { shadowedSeqs, visibleEvents } from '../dsh-bridge/lib/surface.js';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

const append = (seq) => ({ seq, surfaceOp: 'append' });
const replace = (seq, start, end) => ({ seq, surfaceOp: { op: 'replace', startSeq: start, endSeq: end } });
const logOnly = (seq) => ({ seq });

console.log('shadowed seqs');
{
  const append = (seq) => ({ seq, surfaceOp: 'append' });
  const replace = (seq, start, end) => ({ seq, surfaceOp: { op: 'replace', startSeq: start, endSeq: end } });
  const logOnly = (seq) => ({ seq });
  check('appends are never shadowed', shadowedSeqs([append(0), append(1)]).size === 0);
  check('a whole range is shadowed', JSON.stringify([...shadowedSeqs([append(0), append(1), append(2), append(3), replace(4, 1, 3)])]) === '[1,2,3]');
  check('a single node is shadowed', JSON.stringify([...shadowedSeqs([append(0), append(1), append(2), replace(3, 2, 2)])]) === '[2]');
  check('an unknown range shadows nothing', shadowedSeqs([append(0), append(1), replace(2, 9, 1)]).size === 0);
  check('a reversed range shadows nothing', shadowedSeqs([append(0), append(1), append(2), replace(3, 2, 0)]).size === 0);
}

console.log('visible events keep the log-only ones');
{
  const append = (seq, type) => ({ seq, surfaceOp: 'append', type });
  const logOnly = (seq, type) => ({ seq, type });
  const replace = (seq, start, end) => ({ seq, surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, type: 'assistant/message' });
  const events = [
    append(0, 'system/message'),
    append(1, 'user/message'),
    append(2, 'assistant/message'),
    logOnly(3, 'turn/end'),
    append(4, 'tool/result'),
    replace(5, 1, 4),
    logOnly(6, 'command/done'),
    append(7, 'user/message'),
  ];
  const kept = visibleEvents(events).map((event) => event.seq);
  check('the shadowed messages are gone', kept.includes(1) === false && kept.includes(2) === false && kept.includes(4) === false, JSON.stringify(kept));
  check('log-only events survive the fold', kept.includes(3) === true && kept.includes(6) === true, JSON.stringify(kept));
  check('the replacement itself is kept', kept.includes(5) === true);
  check('later appends survive', kept.includes(7) === true);
  check('nothing is reordered', JSON.stringify(kept) === JSON.stringify([...kept].sort((a, b) => a - b)), JSON.stringify(kept));
  check('an empty log folds to nothing', visibleEvents([]).length === 0);
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
