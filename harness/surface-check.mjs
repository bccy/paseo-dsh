/**
 * Offline check for the bridge's replay fold (`dsh-bridge/lib/surface.js`).
 *
 * A rewind appends a replace operation instead of deleting events, so replaying
 * the raw log after a rewind resurrects exactly what the user just removed —
 * which is what Paseo's post-rewind re-hydrate was showing. But DSH's surface is
 * the *model-visible* surface, not the human transcript: folding compaction
 * ranges as well would delete conversation the user already read (measured on a
 * real session: 205 user messages would replay as 60). The contract pinned here:
 *
 * - this bridge's rewind seam (empty `system/message` replacement over content)
 *   drops its whole span, including the withdrawn turn's trailing log events;
 * - compaction checkpoints (`user/message` replacements) drop nothing;
 * - DSH's own system-prompt maintenance (single system node -> system node)
 *   drops nothing;
 * - a replacement that cannot be resolved against the current surface changes
 *   nothing (never guess).
 *
 * Usage: node harness/surface-check.mjs
 */
import { isEmptySystemMessage, isRewindSeam, visibleEvents } from '../dsh-bridge/lib/surface.js';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

const userMessage = (seq, sourceKind = 'user') => ({ seq, type: 'user/message', surfaceOp: 'append', data: { id: `u${seq}`, source: { kind: sourceKind }, content: [{ type: 'text', text: `u${seq}` }] } });
const assistantMessage = (seq) => ({ seq, type: 'assistant/message', surfaceOp: 'append', data: { message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text: `a${seq}` }] } } });
const systemMessage = (seq, text = 'SYS') => ({ seq, type: 'system/message', surfaceOp: 'append', data: { message: { id: `s${seq}`, role: 'system', content: text === '' ? [] : [{ type: 'text', text }], source: { kind: 'system-prompt' } } } });
const logOnly = (seq, type) => ({ seq, type, data: {} });

/** The rewind marker this bridge appends. */
const rewindSeam = (seq, start, end, shadowed) => ({
  seq,
  type: 'system/message',
  surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
  sourceEventSeqs: shadowed,
  data: { message: { id: `mark${seq}`, role: 'system', content: [], source: { kind: 'system-prompt' } } },
});

/** A compaction checkpoint (DSH's own replacement carrier). */
const compactionCheckpoint = (seq, start, end, shadowed) => ({
  seq,
  type: 'user/message',
  surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
  sourceEventSeqs: shadowed,
  data: { id: `cp${seq}`, source: { kind: 'model' }, content: [{ type: 'text', text: 'summary' }] },
});

const seqs = (events) => events.map((event) => event.seq);

console.log('marker recognition');
{
  check('an empty system message is a marker', isEmptySystemMessage(systemMessage(1, '')));
  check('a system message with text is not', isEmptySystemMessage(systemMessage(1, 'SYS')) === false);
  check('a user message is not', isEmptySystemMessage(userMessage(1)) === false);
}

console.log('a rewind seam drops its whole span (trailing log events included)');
{
  const events = [
    systemMessage(0),
    userMessage(1),
    assistantMessage(2),
    userMessage(3),
    assistantMessage(4),
    logOnly(5, 'step/end'),
    logOnly(6, 'turn/end'),
    rewindSeam(7, 3, 4, [3, 4]),
    // A later, kept turn:
    userMessage(8),
    assistantMessage(9),
    logOnly(10, 'turn/end'),
  ];
  const kept = visibleEvents(events);
  check('the withdrawn span is gone', JSON.stringify(seqs(kept)) === JSON.stringify([0, 1, 2, 7, 8, 9, 10]), JSON.stringify(seqs(kept)));
  check('the withdrawn turn footer is gone too', seqs(kept).includes(5) === false && seqs(kept).includes(6) === false);
  check('the marker itself is still in the log (surface node)', seqs(kept).includes(7));
}

console.log('a compaction replacement keeps the conversation it hid from the model');
{
  const events = [
    systemMessage(0),
    userMessage(1),
    assistantMessage(2),
    userMessage(3),
    assistantMessage(4),
    logOnly(5, 'compaction/start'),
    logOnly(6, 'compaction/summary'),
    compactionCheckpoint(7, 1, 4, [1, 2, 3, 4]),
    userMessage(8),
    assistantMessage(9),
  ];
  const kept = visibleEvents(events);
  check('every event survives a compaction fold', kept.length === events.length, `${kept.length}/${events.length}`);
  check('the pre-compaction user messages still replay', seqs(kept).includes(1) && seqs(kept).includes(3));
}

console.log('DSH system-prompt maintenance is not a rewind');
{
  const events = [
    systemMessage(0),
    systemMessage(1, 'extra'),
    userMessage(2),
    assistantMessage(3),
    // Replace one non-head system node with an empty system message: DSH's own
    // SystemPromptProjection does this, and it must not fold the transcript.
    rewindSeam(4, 1, 1, [1]),
  ];
  const kept = visibleEvents(events);
  check('a single system->system replacement drops nothing', kept.length === events.length, `${kept.length}/${events.length}`);
}

console.log('rewind after compaction folds only the rewind span');
{
  const events = [
    systemMessage(0),
    userMessage(1),
    assistantMessage(2),
    compactionCheckpoint(3, 1, 2, [1, 2]),
    userMessage(4),
    assistantMessage(5),
    logOnly(6, 'turn/end'),
    rewindSeam(7, 4, 5, [4, 5]),
  ];
  const kept = visibleEvents(events);
  check('the pre-compaction history survives', seqs(kept).includes(1) && seqs(kept).includes(2));
  check('the rewind span is gone', seqs(kept).includes(4) === false && seqs(kept).includes(5) === false && seqs(kept).includes(6) === false);
  check('the compaction checkpoint stays', seqs(kept).includes(3) && seqs(kept).includes(7));
}

console.log('multiple rewinds');
{
  const events = [
    systemMessage(0),
    userMessage(1),
    assistantMessage(2),
    rewindSeam(3, 1, 2, [1, 2]),
    userMessage(4),
    assistantMessage(5),
    rewindSeam(6, 4, 5, [4, 5]),
  ];
  const kept = visibleEvents(events);
  check('each rewind drops its own span', JSON.stringify(seqs(kept)) === JSON.stringify([0, 3, 6]), JSON.stringify(seqs(kept)));
}

console.log('unresolvable replacements never guess');
{
  const events = [
    systemMessage(0),
    userMessage(1),
    // The start seq is not a current surface node: a corrupt/partial log.
    rewindSeam(2, 99, 1, [99, 1]),
  ];
  const kept = visibleEvents(events);
  check('the log is left untouched', kept.length === events.length, `${kept.length}/${events.length}`);
}

console.log('a non-bridge user/message replacement is not a rewind seam');
{
  const events = [
    systemMessage(0),
    userMessage(1),
    assistantMessage(2),
    // dsh-rewind-plugin's own marker from older sessions.
    { seq: 3, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2], data: { id: 'm', source: { kind: 'dsh-rewind' }, content: [{ type: 'text', text: '(empty message)' }] } },
  ];
  const kept = visibleEvents(events);
  check('legacy markers do not fold the transcript', kept.length === events.length, `${kept.length}/${events.length}`);
}

console.log('isRewindSeam needs content in the shadowed range');
{
  check('system content under the range is not a rewind seam', isRewindSeam(rewindSeam(1, 0, 0, [0]), [systemMessage(0, '')]) === false);
  check('user content under the range is', isRewindSeam(rewindSeam(1, 0, 0, [0]), [userMessage(0)]) === true);
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
