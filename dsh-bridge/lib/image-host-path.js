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
 * This lives in its own dependency-free module, beside `archived-lineage.js`,
 * because `server.js` imports profile-only packages (`@deepseek-ai/dsh-brand`,
 * `dsh-llm`, …) and so cannot be loaded by an offline check. Server tests
 * require this file directly.
 *
 * @module dsh-paseo-bridge/image-host-path
 */

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
    return { ...block, hostPath };
  });
  if (!changed) return event;
  return { ...event, data: { ...data, message: { ...message, content: next } } };
}

/**
 * Project a stored session log onto the `paseo/history` wire shape, with every
 * image attachment stamped (see {@link withImageHostPaths}).
 *
 * Reopening a session replays through here, and that is the path an image
 * matters most on: `data.meta.path` is the *source* file, which is typically
 * long gone, while the attachment copy is the durable one. The field projection
 * (`type`, `seq?`, `time?`, `data`) is exactly what `history()` used to inline;
 * it lives beside the injection rule so the replay path can be asserted without
 * a DSH profile.
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
      data: event.data,
    }),
  );
}
