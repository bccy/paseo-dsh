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
import { historyEvents, withImageHostPaths } from '../dsh-bridge/lib/image-host-path.js';

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

// ---- a resolvable reference gets its host path ---------------------------
{
  const event = toolResult(imageBlock());
  const out = withImageHostPaths(ctxWith(resolvingStore('/tmp/dsh/attachments/v1/objects/0f/0f1e2d')), event);
  check(
    'a resolvable image block gains hostPath',
    out.data.message.content[1].hostPath === '/tmp/dsh/attachments/v1/objects/0f/0f1e2d',
    JSON.stringify(out.data.message.content[1]),
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
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
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
  check('a stored event without seq/time gains neither key', !('seq' in out[2]) && !('time' in out[2]));
  check(
    'a history whose image cannot be resolved is projected unchanged',
    historyEvents(ctxWith(undefined), log)[1].data.message.content[1].hostPath === undefined,
  );
  check('a non-array history is an empty list', historyEvents(ctxWith(resolvingStore('/x.png')), undefined).length === 0);
}

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
