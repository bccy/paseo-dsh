/**
 * Stamp DSH's image attachments with the host path Paseo's markdown renderer
 * needs, on the way out to the plugin.
 *
 * DSH hands a picture to a model as an attachment *reference*
 * (`{attachmentId: "sha256:…", mediaType, bytes, width, height, name}`). Paseo's
 * provider items have no field for binary content: a provider renders a picture
 * by emitting an `assistant_message` whose text is
 * `![alt](file:///absolute/path)`, and the host fetches the bytes over its own
 * file RPC. Only this process holds DSH's `ctx`, so only this process can turn a
 * reference into the durable absolute path that survives the source file being
 * deleted (`attachments.imageHostPath(ref)` -> `<DSH_HOME>/attachments/v1/
 * objects/<xx>/<sha256>`); the plugin half cannot resolve it at all.
 *
 * The reference's own fields are left exactly as they are — `hostPath` is
 * appended, nothing is removed or rewritten. A picture that cannot be resolved
 * (no attachment store, a throwing `imageHostPath`, a non-string answer) keeps
 * its block untouched and the event is still delivered: a picture the host
 * cannot fetch is a missing row, never a lost tool result.
 *
 * ### Why an extension-bearing copy exists at all
 *
 * The host's file explorer classifies a file as an image by its *extension* and
 * never sniffs the bytes — `IMAGE_MIME_TYPES` is keyed by `.png/.jpg/.jpeg/
 * .gif/.webp/.svg`, and anything else that is not valid UTF-8 falls through to
 * `kind: "binary"` (`@getpaseo/server/dist/server/server/file-explorer/
 * service.js`). DSH's store is content addressed and writes the digest *alone*:
 * `<DSH_HOME>/attachments/v1/objects/<xx>/<sha256>`, no extension. A JPEG
 * therefore resolves to `kind: "binary"`, the host's picture row throws
 * `"image" !== kind` **after** the bytes have crossed the wire, and the user
 * sees "Image preview unavailable" — a row that looks like a rendering bug and
 * is really a naming one.
 *
 * So an extensionless path is replaced by a copy named `<sha256><ext>`, the
 * extension taken from the attachment's `mediaType` and never from its `name`
 * (DSH re-encodes on the way in, so a file called `tool-rows.png` can be
 * `image/jpeg`, and `name` would write the wrong extension). The copy name is
 * deterministic because the plugin's replay dedup depends on it: the same stored
 * log has to rebuild byte-identical markdown, and a random name would emit a
 * second picture row on every reopen.
 *
 * **The official answer wins.** The moment `imageHostPath()` returns a path that
 * already carries an extension, nothing is copied and the store's own path is
 * stamped. That branch is the point of the shim rather than a detail of it: the
 * copy is a compatibility bridge for today's extensionless store, and it must
 * retire itself silently once the store starts naming its own files.
 *
 * This lives in its own dependency-free module, beside `archived-lineage.js`,
 * because `server.js` imports profile-only packages (`@deepseek-ai/dsh-brand`,
 * `dsh-llm`, …) and so cannot be loaded by an offline check. Server tests
 * require this file directly.
 *
 * @module dsh-paseo-bridge/image-host-path
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

/**
 * The media types the host classifies as an image, mapped to the extension it
 * needs to see. The host's own table is keyed by extension, so this is its
 * inverse and has to be kept in step with it.
 */
const EXTENSION_BY_MEDIA_TYPE = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/svg+xml', '.svg'],
]);

/**
 * Where the compatibility copies live. Under the OS temp dir on purpose: DSH's
 * attachment store is content addressed and read-only to us, and a copy beside
 * it would be collected by nothing.
 *
 * Named per uid because `tmpdir()` is world-writable on Linux: a fixed name
 * there is a directory another local user can create first, then read (the
 * digests enumerate every picture this user has looked at) and write into. The
 * atomic rename below already stops a pre-placed symlink from being written
 * through; owning the directory stops the rest.
 */
const COPY_DIRECTORY = join(
  tmpdir(),
  `paseo-dsh-attachments-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
);

/**
 * The extension one media type needs, or `undefined` when the host has no image
 * entry for it. Parameters are dropped (`image/svg+xml; charset=utf-8`).
 *
 * @param {unknown} mediaType - the attachment's own media type.
 * @returns {string | undefined} e.g. `.jpg`, or `undefined`.
 */
function extensionFor(mediaType) {
  if (typeof mediaType !== 'string') return undefined;
  return EXTENSION_BY_MEDIA_TYPE.get(mediaType.split(';')[0].trim().toLowerCase());
}

/**
 * Copy one attachment beside its extension, reusing an existing copy.
 *
 * The copy lands by `rename`, never by writing the target in place: a reader can
 * then never catch a half-written file, and a copy interrupted by a kill or a
 * full disk is retried on the next event instead of being served truncated
 * forever.
 *
 * Every failure is a `undefined` answer rather than a throw: this runs on the
 * event path, and the caller's contract is that a picture which cannot be made
 * renderable still delivers its tool result. The alternative — throwing — would
 * turn a cosmetic gap into a lost tool row.
 *
 * @param {string} source - the store's own absolute path.
 * @param {string} extension - the extension the host needs, with its dot.
 * @returns {string | undefined} the copy's absolute path, or `undefined`.
 */
function copyBeside(source, extension) {
  const name = basename(source);
  if (name === '') return undefined;
  const target = join(COPY_DIRECTORY, `${name}${extension}`);
  const staging = `${target}.${process.pid}.tmp`;
  try {
    // Reuse only a copy that is the same size as the source: a truncated one
    // left by an interrupted write is not an answer, and neither is a foreign
    // file that happens to sit at this name. (A same-size substitution would
    // still pass; that is the residual, and hashing every hit would cost a full
    // read on the hot path.)
    const sourceSize = statSync(source).size;
    if (sourceSize > 0 && existsSync(target) && statSync(target).size === sourceSize) return target;
    mkdirSync(COPY_DIRECTORY, { recursive: true, mode: 0o700 });
    // Stage beside the target, then rename into place. `rename` is atomic within
    // one filesystem, and that is what makes the cache safe on both counts:
    //   - the daemon runs several sessions, and two of them can replay the same
    //     attachment at once; writing straight to `target` lets one read a
    //     half-written file;
    //   - a copy interrupted by a kill or a full disk would leave a *partial*
    //     file at `target`, and the size guard above would then serve that
    //     truncated image forever instead of retrying.
    copyFileSync(source, staging);
    renameSync(staging, target);
    return target;
  } catch {
    // A leftover `.tmp` is untidy, never wrong — and the caller's answer below
    // is the store's own path either way.
    try {
      unlinkSync(staging);
    } catch {
      // Nothing staged, or nothing we can do about it.
    }
    return undefined;
  }
}

/**
 * The path the host should fetch for one resolved attachment.
 *
 * The store's own path is returned whenever it already carries an extension —
 * the official answer always wins, and no copy is made. Only an extensionless
 * path is replaced by a copy carrying the extension its `mediaType` implies.
 * When no copy can be made (an unknown media type, a source that is gone, an
 * unwritable temp dir) the store's path comes back unchanged, so the worst case
 * is exactly the row that failed before this shim existed.
 *
 * @param {string} hostPath - what `attachments.imageHostPath()` answered.
 * @param {unknown} mediaType - the attachment's own media type.
 * @returns {string} an absolute path, never empty.
 */
export function hostImagePath(hostPath, mediaType) {
  if (extname(hostPath) !== '') return hostPath;
  const extension = extensionFor(mediaType);
  if (extension === undefined) return hostPath;
  return copyBeside(hostPath, extension) ?? hostPath;
}

/**
 * One event, with `hostPath` appended to each image block of a tool result that
 * can be resolved.
 *
 * Only `tool/result` is touched — that is where DSH puts a tool's content blocks
 * — and only when `data.message.content` really is an array. Every other shape
 * is returned as-is, which is the common case.
 *
 * @param {{get(name: string): unknown}} ctx - the DSH profile context.
 * @param {unknown} event - one session event, `{type, seq?, time?, data}`.
 * @returns {unknown} the same object, or a copy carrying the extra fields. The
 *   original is returned when nothing changed, so callers copy only when there
 *   is something to copy.
 */
export function withImageHostPaths(ctx, event) {
  if (event === null || typeof event !== 'object') return event;
  if (event.type !== 'tool/result') return event;
  const data = event.data;
  if (data === null || typeof data !== 'object') return event;
  const message = data.message;
  if (message === null || typeof message !== 'object') return event;
  const content = message.content;
  if (!Array.isArray(content)) return event;

  let attachments;
  try {
    attachments = ctx?.get?.('attachments');
  } catch {
    // A context that refuses the lookup is the same case as one without the
    // service: no path, no picture, event intact.
    return event;
  }
  if (attachments === null || typeof attachments !== 'object') return event;
  if (typeof attachments.imageHostPath !== 'function') return event;

  let changed = false;
  const next = content.map((block) => {
    if (block === null || typeof block !== 'object') return block;
    if (block.type !== 'image') return block;
    const attachment = block.attachment;
    if (attachment === null || typeof attachment !== 'object') return block;
    // A held child frame is stamped when it is finally flushed, but a frame that
    // was already stamped is never recomputed: the first answer is the one the
    // block keeps.
    if (typeof block.hostPath === 'string' && block.hostPath !== '') return block;
    let hostPath;
    try {
      hostPath = attachments.imageHostPath(attachment);
    } catch {
      // An invalid reference throws DSH's `AttachmentError`; the block keeps its
      // reference and the tool result still reaches Paseo.
      return block;
    }
    if (typeof hostPath !== 'string' || hostPath === '') return block;
    changed = true;
    return { ...block, hostPath: hostImagePath(hostPath, attachment.mediaType) };
  });
  if (!changed) return event;
  return { ...event, data: { ...data, message: { ...message, content: next } } };
}

/**
 * One event's `data`, without the streaming-typing record DSH keeps on an
 * assistant message.
 *
 * `data.stream` is DSH's own transcript of how the message arrived: one entry
 * per streamed frame (`{type: "chunk" | "reasoning-chunks" | "text" |
 * "tool-call", dt: [...]}`), which the typing animation replays. Nothing on the
 * Paseo side reads it — the plugin's `#assistantMessage` builds its row from
 * `data.message.content`, `data.turn` and `data.step` only — and it is not small:
 * on a real 9802-event session it is 22.7 MB of a 43.4 MB `paseo/history`
 * response, 52.3% of the whole replay. A rewind re-reads that response in full
 * (Paseo's adapter is append-only, so a rewind is a close + reopen), which is
 * most of why a rewind took seconds.
 *
 * **Only the replay projection drops it, never the log.** The event handed here
 * is a throwaway projection of one stored event; DSH's own persisted record
 * keeps `stream` intact, because it is DSH's data and other readers (the live
 * typing stream, a future exporter) are entitled to it. The original object is
 * never mutated: a new `data` is built by rest-spread, and an event without
 * `stream` is returned as-is rather than gaining a `stream: undefined` key.
 *
 * @param {{type?: string, data?: unknown}} event - one stored event.
 * @returns {unknown} the same `data` reference, or a copy without `stream`.
 */
export function withoutAssistantStream(event) {
  if (event === null || typeof event !== 'object') return event;
  if (event.type !== 'assistant/message') return event.data;
  const data = event.data;
  if (data === null || typeof data !== 'object') return data;
  // `in` rather than `!== undefined`: a present-but-undefined key would still be
  // a key this projection invented, and a log written by another producer may
  // legitimately carry `stream: null`. Both are "has no stream chunks".
  if (!('stream' in data)) return data;
  const { stream: _stream, ...rest } = data;
  return rest;
}

/**
 * Project a stored session log onto the `paseo/history` wire shape, with every
 * image attachment stamped (see {@link withImageHostPaths}) and the assistant
 * typing record dropped (see {@link withoutAssistantStream}).
 *
 * Reopening a session replays through here, and that is the path an image
 * matters most on: `data.meta.path` is the *source* file, which is typically
 * long gone, while the attachment copy is the durable one. The field projection
 * (`type`, `seq?`, `time?`, `ignorable?`, `data`) is exactly what `history()`
 * used to inline; it lives beside the injection rule so the replay path can be
 * asserted without a DSH profile.
 *
 * `ignorable` rides along even though nothing here reads it: DSH's contract is
 * that an event *without* the marker MUST make a reader refuse to reconstruct
 * the session rather than drop it silently, so stripping the marker removes the
 * only thing that tells a future event type apart from a skippable one.
 *
 * The trimming happens **after** the caller's surface fold, which is a
 * requirement rather than an ordering accident: `visibleEvents()` resolves a
 * rewind's shadowed range against the log's surface node list, and it needs the
 * events' own `seq`/`surfaceOp` fields — not this wire shape. `history()` already
 * nests it as `historyEvents(ctx, visibleEvents(...))`, so the fold still sees
 * every event exactly once and a rewind range still collapses.
 *
 * @param {{get(name: string): unknown}} ctx - the DSH profile context.
 * @param {unknown} events - the stored events read from session persistence.
 * @returns {Array<object>} wire frames, image blocks stamped where resolvable.
 */
export function historyEvents(ctx, events) {
  if (!Array.isArray(events)) return [];
  return events.map((event) =>
    withImageHostPaths(ctx, {
      type: event.type,
      ...(event.seq === undefined ? {} : { seq: event.seq }),
      ...(event.time === undefined ? {} : { time: event.time }),
      ...(event.ignorable === undefined ? {} : { ignorable: event.ignorable }),
      data: withoutAssistantStream(event),
    }),
  );
}
