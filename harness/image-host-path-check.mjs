/**
 * Offline check for the bridge's image `hostPath` injection.
 *
 * A Paseo provider item has no field for binary content: a picture is rendered
 * from markdown (`![alt](file:///absolute/path)`), and the host fetches the bytes
 * over its own file RPC. DSH only gives the bridge an attachment *reference*
 * (`{attachmentId:"sha256:…", mediaType, bytes, …}`), and only the bridge
 * process holds the `ctx` that turns it into the durable absolute path
 * (`attachments.imageHostPath(ref)`). So `dsh-bridge/lib/image-host-path.js`
 * appends `hostPath` to each image block of a `tool/result`, on the live channel
 * and on the `paseo/history` replay channel alike.
 *
 * This is a pure-module check: no DSH profile, no daemon, no model. The rule
 * lives in its own dependency-free module for exactly that reason — `server.js`
 * imports profile-only packages, so it cannot be required offline.
 *
 * What is asserted:
 *   - a resolvable reference gets `hostPath`; every original field survives
 *   - an extensionless store path (today's DSH) is replaced by a deterministic
 *     copy carrying the extension its `mediaType` implies, byte for byte, and
 *     the extension comes from `mediaType` rather than the file's `name`
 *   - a store path that already carries an extension is stamped untouched: the
 *     official answer wins and nothing is copied
 *   - an unknown media type, or a source that has gone, falls back to the
 *     store's own path — the shim can never do worse than no shim
 *   - a missing attachment store, a throwing `imageHostPath` (an invalid
 *     reference throws DSH's `AttachmentError`) and a non-string answer all
 *     leave the event untouched — a lost tool result is never the price of a
 *     missing picture
 *   - anything that is not a `tool/result` with an array `content` is untouched
 *   - the original object is returned when nothing changed, so the hot path
 *     copies nothing
 *   - `historyEvents` projects stored events to the wire shape and stamps them
 *     too, without mutating the log it was given
 *
 * Usage: node harness/image-host-path-check.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  historyEvents,
  isReplayedEventType,
  REPLAYED_EVENT_TYPES,
  withImageHostPaths,
} from '../dsh-bridge/lib/image-host-path.js';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

/** A context exposing the attachment store under test. */
const ctxWith = (attachments) => ({ get: (name) => (name === 'attachments' ? attachments : undefined) });

/** A store that resolves any reference to a fixed absolute path. */
const resolvingStore = (path) => ({ imageHostPath: () => path });

const REF = { attachmentId: 'sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0', mediaType: 'image/png', bytes: 12344, name: 'paseo-01.png' };

/** A DSH-shaped `tool/result` with a text block and one image block. */
const toolResult = (imageBlock) => ({
  type: 'tool/result',
  seq: 440,
  time: 1700000000000,
  data: {
    toolCallId: 'call_x',
    message: {
      role: 'tool',
      content: [{ type: 'text', text: '<type>image</type>' }, imageBlock],
    },
    meta: { path: '/tmp/paseo-01.png' },
  },
});

const imageBlock = (attachment = REF) => ({ type: 'image', attachment });

// ---- the extensionless store path is the one the shim exists for ----------
// The bytes are real files on purpose: the copy is the thing under test, and a
// check against a path that does not exist would silently assert the fallback
// branch instead — green, and measuring nothing.
const WORK = mkdtempSync(join(tmpdir(), 'image-host-path-check-'));
const BYTES = Buffer.from('the bytes are the point, not the format');
const DIGEST = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const STORE_PATH = join(WORK, DIGEST);
writeFileSync(STORE_PATH, BYTES);
/** Where the deterministic copy lands, derived the way the module derives it. */
const copyFor = (extension) =>
  join(
    tmpdir(),
    `paseo-dsh-attachments-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
    `${DIGEST}${extension}`,
  );
const copyHolds = (extension) => {
  try {
    return readFileSync(copyFor(extension)).equals(BYTES);
  } catch {
    return false;
  }
};

{
  const event = toolResult(imageBlock());
  const out = withImageHostPaths(ctxWith(resolvingStore(STORE_PATH)), event);
  check(
    'an extensionless store path is replaced by a copy carrying the media type’s extension',
    out.data.message.content[1].hostPath === copyFor('.png'),
    `${out.data.message.content[1].hostPath} (expected ${copyFor('.png')})`,
  );
  check('the copy holds the very bytes the store handed us', copyHolds('.png'));
  // An interrupted write leaves a short file. The old `size > 0` guard served it
  // forever, so the picture stayed broken with nothing to recover it.
  writeFileSync(copyFor('.png'), BYTES.subarray(0, 5));
  const repaired = withImageHostPaths(ctxWith(resolvingStore(STORE_PATH)), toolResult(imageBlock()));
  check(
    'a copy that is not the size of its source is rewritten, not served',
    repaired.data.message.content[1].hostPath === copyFor('.png') && copyHolds('.png'),
  );
  check(
    'the reference itself is untouched (nothing removed or rewritten)',
    JSON.stringify(out.data.message.content[1].attachment) === JSON.stringify(REF) &&
      out.data.message.content[1].type === 'image',
    JSON.stringify(out.data.message.content[1].attachment),
  );
  check(
    'the text block and the event envelope are preserved',
    out.data.message.content[0].text === '<type>image</type>' &&
      out.type === 'tool/result' &&
      out.seq === 440 &&
      out.time === 1700000000000 &&
      out.data.toolCallId === 'call_x' &&
      JSON.stringify(out.data.meta) === JSON.stringify({ path: '/tmp/paseo-01.png' }),
  );
  check('the caller’s original object is not mutated', event.data.message.content[1].hostPath === undefined);
  check('a changed event is a new object (the original is left alone)', out !== event);
}

// ---- the extension comes from mediaType, never from the name --------------
// DSH re-encodes on the way in, so a file called `tool-rows.png` can be a JPEG.
// Writing `.png` over JPEG bytes is the mismatch this shim must not add itself.
{
  const event = toolResult(imageBlock({ ...REF, mediaType: 'image/jpeg', name: 'tool-rows.png' }));
  const out = withImageHostPaths(ctxWith(resolvingStore(STORE_PATH)), event);
  check(
    'a JPEG media type under a .png name is written .jpg',
    out.data.message.content[1].hostPath === copyFor('.jpg') && copyHolds('.jpg'),
    out.data.message.content[1].hostPath,
  );
}

// ---- the official answer wins the moment it carries an extension ----------
{
  const official = join(WORK, 'already-named.png');
  writeFileSync(official, BYTES);
  const event = toolResult(imageBlock());
  const out = withImageHostPaths(ctxWith(resolvingStore(official)), event);
  check(
    'a store path that already has an extension is stamped untouched (no copy)',
    out.data.message.content[1].hostPath === official,
    out.data.message.content[1].hostPath,
  );
}

// ---- the fallbacks: the shim is never worse than no shim ------------------
{
  const gone = join(WORK, 'not-on-disk');
  const missing = withImageHostPaths(ctxWith(resolvingStore(gone)), toolResult(imageBlock()));
  check(
    'a source that has gone falls back to the store’s own path',
    missing.data.message.content[1].hostPath === gone,
    missing.data.message.content[1].hostPath,
  );
  const unknown = withImageHostPaths(
    ctxWith(resolvingStore(STORE_PATH)),
    toolResult(imageBlock({ ...REF, mediaType: 'image/tiff' })),
  );
  check(
    'a media type the host has no image entry for falls back to the store’s own path',
    unknown.data.message.content[1].hostPath === STORE_PATH,
    unknown.data.message.content[1].hostPath,
  );
}

// ---- an already-stamped block is not recomputed ---------------------------
{
  const event = toolResult({ type: 'image', attachment: REF, hostPath: '/already/there.png' });
  const out = withImageHostPaths(ctxWith(resolvingStore('/other.png')), event);
  check('an already-stamped block keeps its first host path', out === event);
}

// ---- no attachment store --------------------------------------------------
{
  const event = toolResult(imageBlock());
  check('a missing attachment store returns the original event', withImageHostPaths(ctxWith(undefined), event) === event);
  check('a context with no get() returns the original event', withImageHostPaths({}, event) === event);
  check(
    'a context whose get() throws returns the original event',
    withImageHostPaths({ get: () => { throw new Error('no such service'); } }, event) === event,
  );
  check(
    'a store without imageHostPath() returns the original event',
    withImageHostPaths(ctxWith({ fileHostPath: () => '/x' }), event) === event,
  );
}

// ---- a reference the store refuses ---------------------------------------
{
  const event = toolResult(imageBlock());
  const throwing = ctxWith({ imageHostPath: () => { throw new Error('Attachment reference is invalid.'); } });
  check('a throwing imageHostPath returns the original event', withImageHostPaths(throwing, event) === event);
  check(
    'a non-string answer returns the original event',
    withImageHostPaths(ctxWith({ imageHostPath: () => undefined }), event) === event &&
      withImageHostPaths(ctxWith({ imageHostPath: () => 42 }), event) === event &&
      withImageHostPaths(ctxWith({ imageHostPath: () => '' }), event) === event,
  );
}

// ---- shapes that are not an image-bearing tool result --------------------
{
  const event = toolResult(imageBlock());
  const nonTool = { ...event, type: 'assistant/message' };
  check('a non-tool/result event returns the original event', withImageHostPaths(ctxWith(resolvingStore('/x.png')), nonTool) === nonTool);
  const nonArray = { type: 'tool/result', data: { message: { content: 'not an array' } } };
  check('a tool result whose content is not an array returns the original event', withImageHostPaths(ctxWith(resolvingStore('/x.png')), nonArray) === nonArray);
  const noMessage = { type: 'tool/result', data: { toolCallId: 'c' } };
  check('a tool result without a message returns the original event', withImageHostPaths(ctxWith(resolvingStore('/x.png')), noMessage) === noMessage);
  const noAttachment = toolResult({ type: 'image' });
  check('an image block without a reference returns the original event', withImageHostPaths(ctxWith(resolvingStore('/x.png')), noAttachment) === noAttachment);
  const textOnly = toolResult({ type: 'text', text: 'no picture' });
  check('a result with no image block returns the original event', withImageHostPaths(ctxWith(resolvingStore('/x.png')), textOnly) === textOnly);
  check('null and primitive events are passed through', withImageHostPaths(ctxWith(resolvingStore('/x.png')), null) === null);
}

// ---- one resolvable image beside an unresolvable one ---------------------
{
  const event = {
    type: 'tool/result',
    seq: 7,
    data: {
      message: {
        content: [
          imageBlock(),
          { type: 'image', attachment: { attachmentId: 'not-a-ref', mediaType: 'image/png' } },
          { type: 'text', text: 'tail' },
        ],
      },
    },
  };
  const store = {
    imageHostPath: (ref) => {
      if (ref.attachmentId === 'not-a-ref') throw new Error('Attachment reference is invalid.');
      return '/ok.png';
    },
  };
  const out = withImageHostPaths(ctxWith(store), event);
  check(
    'only the resolvable image is stamped',
    out.data.message.content[0].hostPath === '/ok.png' && out.data.message.content[1].hostPath === undefined,
    JSON.stringify(out.data.message.content),
  );
  check(
    'the untouched blocks keep their own shape and position',
    out.data.message.content[1].attachment.attachmentId === 'not-a-ref' &&
      out.data.message.content[2].text === 'tail' &&
      out.data.message.content.length === 3,
  );
}

// ---- the history() replay path -------------------------------------------
{
  const log = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
    {
      type: 'tool/result',
      seq: 2,
      time: 1700000000000,
      data: { toolCallId: 'call_x', message: { content: [{ type: 'text', text: 't' }, imageBlock()] } },
    },
    { type: 'turn/end', ignorable: true, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const before = JSON.stringify(log);
  const out = historyEvents(ctxWith(resolvingStore('/history/object.png')), log);
  check(
    'historyEvents projects every event to the wire shape',
    out.length === 3 &&
      out[0].type === 'user/message' &&
      out[0].seq === 1 &&
      out[1].seq === 2 &&
      out[1].time === 1700000000000 &&
      out[2].type === 'turn/end',
    JSON.stringify(out.map((event) => ({ type: event.type, seq: event.seq, time: event.time }))),
  );
  check(
    'historyEvents stamps the image block too (the reopen path)',
    out[1].data.message.content[1].hostPath === '/history/object.png',
    JSON.stringify(out[1].data.message.content[1]),
  );
  check('historyEvents does not mutate the stored log', JSON.stringify(log) === before);
  // DSH's contract: an event *without* this marker MUST make a reader refuse to
  // reconstruct rather than drop it silently. Stripping it here left both halves
  // unable to honour that for any event type added later.
  check('the ignorable marker survives the projection', out[2].ignorable === true);
  check('a stored event without seq/time gains neither key', !('seq' in out[2]) && !('time' in out[2]));
  check(
    'a history whose image cannot be resolved is projected unchanged',
    historyEvents(ctxWith(undefined), log)[1].data.message.content[1].hostPath === undefined,
  );
  check('a non-array history is an empty list', historyEvents(ctxWith(resolvingStore('/x.png')), undefined).length === 0);
}

// ---- the replay whitelist is a contract, not an implementation detail -----
// The list is "derived from the consumers": each entry exists because the
// plugin reads it back after a reopen. A missing entry is a row that silently
// disappears from a replayed session — `turn/start` is how a killed child's open
// turn is known to be open (without it the child replays as `completed`),
// `subagent/descriptor` is the child's only durable title (without it the child
// sits on "加载中…" forever). An extra entry is a payload regression that costs
// size and hides the day a new type starts mattering.
//
// Before this block existed, deleting any single member left the whole file
// green: the only fixture types were `user/message`, `tool/result` and
// `turn/end`, so nothing but emptying the list outright changed an outcome. The
// list is written out here as the EXPECTED value, so changing it now requires
// changing this line too — which is exactly the question "why does the plugin
// read this type back?" being asked.
{
  const expected = [
    'tool-workflow/run-start', 'tool-workflow/agent-start',
    'tool-workflow/agent-end', 'tool-workflow/run-end', 'goal/change',
    'assistant/message',
    'command/done',
    'command/run',
    'compaction/end',
    'compaction/start',
    'compaction/summary',
    'subagent/descriptor',
    'tool/call',
    'tool/result',
    'turn/end',
    'turn/start',
    'user/message',
  ].sort();
  const actual = [...REPLAYED_EVENT_TYPES].sort();
  check(
    'the replay whitelist is exactly the set of types the plugin reads back',
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual),
  );

  // The predicate is what the filter actually calls, so it is asserted on its
  // own: an event with no `type` (a corrupt line) must be dropped rather than
  // crash the filter, and membership must be the only criterion.
  check(
    'isReplayedEventType answers membership, and drops a type-less event',
    isReplayedEventType({ type: 'turn/start' }) === true &&
      isReplayedEventType({ type: 'request/header' }) === false &&
      isReplayedEventType({}) === false &&
      isReplayedEventType(null) === false,
  );

  // Dropping is the behaviour that matters: a whitelist that lets everything
  // through would pass every size claim in the module docs above while shipping
  // the 4.54 MiB the filter exists to remove. These are the biggest real
  // offenders plus the two the fold itself needs but no consumer reads back.
  const keep = [
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
    { type: 'turn/start', seq: 2, data: { turn: 1 } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const mixed = [
    ...keep,
    { type: 'request/header', seq: 9, data: { header: { tools: [] } } },
    { type: 'agent/inbox/spliced', seq: 10, data: { inserted: [] } },
    { type: 'step/start', seq: 11, data: {} },
    { type: 'system/message', seq: 12, data: { message: { role: 'system', content: [] } } },
  ];
  const filtered = historyEvents(ctxWith(resolvingStore('/history/object.png')), mixed);
  check(
    'events the plugin never reads back are dropped, not projected',
    filtered.length === keep.length &&
      filtered.every((event, i) => event.type === keep[i].type && event.seq === keep[i].seq),
    `${filtered.length} of ${mixed.length} kept: ${filtered.map((event) => event.type).join(', ')}`,
  );
}

// ---- withoutAssistantStream: strip one key, keep every other field --------
// `data.stream` is DSH's own typing record (22.7 MB of a 43.4 MB replay on a
// real session), and nothing on the Paseo side reads it. Two ways to break this
// were unasserted before: returning `event` instead of `event.data` (the whole
// timeline goes blank) and over-stripping (the row loses its content). Both are
// pinned here, on a projection and on the original object.
{
  const typing = [{ type: 'text', text: 'x', dt: [1, 2] }];
  const withStream = [
    {
      type: 'assistant/message',
      seq: 3,
      time: 1700000000000,
      data: {
        turn: 1,
        step: 2,
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
        usage: { inputTokens: 10 },
        stream: typing,
      },
    },
  ];
  const original = JSON.stringify(withStream);
  const projected = historyEvents(ctxWith(undefined), withStream);
  check(
    'the assistant typing record is dropped',
    projected.length === 1 && !('stream' in projected[0].data),
    JSON.stringify(Object.keys(projected[0]?.data ?? {})),
  );
  check(
    'stripping the typing record leaves every other field untouched',
    projected[0].data.turn === 1 &&
      projected[0].data.step === 2 &&
      projected[0].data.message.role === 'assistant' &&
      projected[0].data.message.content[0].text === 'the answer' &&
      projected[0].data.usage.inputTokens === 10,
    JSON.stringify(projected[0]?.data),
  );
  check('the projection returns data, not the event envelope', projected[0].type === 'assistant/message' && projected[0].seq === 3);
  check('the stored event keeps its typing record (only the projection drops it)', JSON.stringify(withStream) === original);
  // A present-but-undefined key and an explicit null are both "has no chunks";
  // neither may be re-invented as a key by the projection.
  check(
    'an event without a stream is projected unchanged',
    JSON.stringify(historyEvents(ctxWith(undefined), [{ type: 'turn/end', seq: 4, data: { turn: 1 } }])[0].data)
      === JSON.stringify({ turn: 1 }),
  );
  check(
    'a null stream is dropped like a missing one',
    (() => {
      const out = historyEvents(ctxWith(undefined), [
        { type: 'assistant/message', seq: 5, data: { turn: 1, message: { content: [] }, stream: null } },
      ]);
      return !('stream' in out[0].data) && out[0].data.turn === 1;
    })(),
  );
}

// The copies are a cache the module reuses, so clear only what this run wrote.
rmSync(WORK, { recursive: true, force: true });
for (const extension of ['.png', '.jpg']) rmSync(copyFor(extension), { force: true });

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
