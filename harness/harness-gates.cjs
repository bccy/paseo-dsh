/**
 * Shared judgement helpers for the harness's own gates.
 *
 * These used to live (in slightly different copies) inside the scripts that
 * consume them, which made every judgement impossible to test without a real
 * profile and a real model. Keeping them here lets `harness-gates-check.mjs`
 * drive the exact predicate the entry scripts use, while the entry script stays
 * a thin protocol driver.
 *
 * No I/O and no DSH imports: pure functions only.
 */

/**
 * Paseo's own two fold rules, replayed over timeline items.
 *
 * `plugin-provider.js` turns a same-id snapshot into the prefix delta (dropping
 * an empty one), and `timeline-projection.js` concatenates only adjacent
 * same-type rows of one turn — refusing to merge two assistant rows with
 * different `messageId`s. A caller that filters rows out before calling this
 * can hide the very interruption that fragments an answer, so this helper
 * expects the **complete** item sequence.
 *
 * @param {Array<{id: string, type: string, text?: string, turnId?: string, messageId?: string}>} items
 * @param {string} [defaultTurnId] - used when an item carries no `turnId`.
 * @returns {Array<{type: string, text: string, turnId: string, id: string, messageId?: string}>}
 */
function projectTimelineLikePaseo(items, defaultTurnId = "turn:any") {
  const snapshots = new Map();
  const rows = [];
  for (const item of items) {
    const previous = snapshots.get(item.id);
    snapshots.set(item.id, item);
    const itemText = typeof item.text === "string" ? item.text : "";
    const previousText =
      previous !== undefined && previous.type === item.type && typeof previous.text === "string"
        ? previous.text
        : "";
    const delta = itemText.startsWith(previousText) ? itemText.slice(previousText.length) : itemText;
    // A same-id snapshot with no growth is not a new row. A *first* row that has
    // no text (a tool call's detail-only item) still exists in Paseo's timeline
    // and must break adjacency — dropping it would hide fragmentation.
    if (delta.length === 0 && previous !== undefined) continue;
    if (delta.length === 0 && item.type === "assistant_message") continue;
    const turnId = item.turnId ?? defaultTurnId;
    const last = rows[rows.length - 1];
    const sameType = last && last.type === item.type && last.turnId === turnId;
    const sameId =
      item.type !== "assistant_message" || item.messageId === undefined || last?.messageId === item.messageId;
    if (sameType && sameId) {
      last.text += delta;
      if (last.messageId === undefined && item.type === "assistant_message") last.messageId = item.messageId;
    } else {
      rows.push({
        type: item.type,
        text: delta,
        turnId,
        id: item.id,
        ...(item.type === "assistant_message" ? { messageId: item.messageId } : {}),
      });
    }
  }
  return rows;
}

/**
 * Flatten plugin-check's `timeline.item` event stream, attributing each item to
 * the `session.turn` bracket that was open when it was emitted.
 *
 * The plugin emits turn brackets (`session.turn` started / terminal) around its
 * rows; Paseo's host uses that same bracket to set `turnId` on the projected
 * row. Without this attribution a check cannot tell "two assistant messages in
 * two turns" from "one message fragmented across turns".
 *
 * @param {Array<Record<string, unknown>>} events
 * @returns {Array<Record<string, unknown>>} items carrying `turnId`
 */
function timelineItemsWithTurns(events) {
  const items = [];
  let currentTurnId;
  for (const event of events) {
    if (event.type === "session.turn" && event.state === "started") {
      currentTurnId = typeof event.turnId === "string" ? event.turnId : currentTurnId;
      continue;
    }
    if (event.type !== "timeline.item") continue;
    const item = event.item ?? {};
    items.push({
      ...item,
      turnId: item.turnId ?? event.turnId ?? currentTurnId ?? "turn:unknown",
    });
  }
  return items;
}

/**
 * Count projected rows per assistant `messageId`.
 *
 * A live step must project to exactly one row per item id; more than one means
 * the answer was fragmented (a reasoning, tool or stats row landed between two
 * of its snapshots). The caller must pass the complete item sequence.
 *
 * @param {Array<Record<string, unknown>>} items - with `turnId` from {@link timelineItemsWithTurns}.
 * @returns {{assistantIds: string[], fragmented: string[], rows: Array<Record<string, unknown>>}}
 */
function assistantFragmentation(items) {
  const projected = projectTimelineLikePaseo(items);
  const assistantIds = [
    ...new Set(
      items
        .filter((item) => item.type === "assistant_message")
        .map((item) => item.messageId ?? item.id)
        .filter((id) => id !== undefined),
    ),
  ];
  const fragmented = assistantIds.filter((id) => {
    const rows = projected.filter(
      (row) => row.type === "assistant_message" && (row.messageId ?? row.id) === id,
    );
    return rows.length !== 1;
  });
  return { assistantIds, fragmented, rows: projected };
}

/**
 * Classify one route-test observation.
 *
 * The old predicate was `text !== "" ? "WORKS" : "FAILS"`, which reported a
 * route that streamed an answer prefix before failing as usable. A failed turn
 * is a failure no matter how much text escaped before it; a turn that never
 * reached a terminal is a timeout, and a cancellation is its own outcome.
 *
 * @param {{text?: string, failure?: string|null, turnEnd?: string|null, timedOut?: boolean, rpcError?: string|null}} observation
 * @returns {{status: 'works'|'failed'|'timeout'|'canceled'|'empty'|'unknown', works: boolean, answer: string, error: string|null}}
 */
function classifyRouteOutcome({ text = "", failure = null, turnEnd = null, timedOut = false, rpcError = null } = {}) {
  const answer = typeof text === "string" ? text.trim() : "";
  const error = typeof failure === "string" && failure !== "" ? failure : null;
  if (error !== null || (typeof rpcError === "string" && rpcError !== "")) {
    return { status: "failed", works: false, answer, error: error ?? rpcError };
  }
  if (timedOut === true) return { status: "timeout", works: false, answer, error: null };
  if (turnEnd === "canceled" || turnEnd === "aborted") {
    return { status: "canceled", works: false, answer, error: null };
  }
  if (turnEnd === "completed") {
    if (answer === "") return { status: "empty", works: false, answer, error: null };
    return { status: "works", works: true, answer, error: null };
  }
  return { status: "unknown", works: false, answer, error: null };
}

/**
 * Exit code for a completed route sweep.
 *
 * `0` only when there was at least one route and every one of them works. An
 * empty sweep is `2` (nothing was measured), everything else is `1`.
 *
 * @param {Array<{works: boolean}>} outcomes
 * @returns {number}
 */
function routeExitCode(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return 2;
  return outcomes.every((outcome) => outcome.works === true) ? 0 : 1;
}

/**
 * Whether a prompt frame carries the exact image block a caller sent.
 *
 * This is protocol evidence: the block has to exist in the frame the plugin
 * hands to DSH, with the same bytes and media type. Model output cannot satisfy
 * it, and a text placeholder such as `IMAGE-SEEN` cannot either.
 *
 * @param {unknown} contentBlocks - `prompt` frame's `contentBlocks`.
 * @param {string} data - base64 image payload the prompt carried.
 * @param {string} [mimeType] - declared media type, when it must match.
 * @returns {boolean}
 */
function contentBlocksIncludeImage(contentBlocks, data, mimeType) {
  if (!Array.isArray(contentBlocks)) return false;
  return contentBlocks.some(
    (block) =>
      block !== null &&
      typeof block === "object" &&
      block.type === "image" &&
      block.data === data &&
      (mimeType === undefined || block.mimeType === mimeType),
  );
}

/**
 * The text blocks of one message's content array, joined.
 *
 * `assistant/message` carries its blocks under `data.message.content`; a
 * `user/message` carries them under `data.content` (verified against a real v4
 * log). Non-text blocks (reasoning, tool-call, image) contribute nothing.
 *
 * @param {unknown} content
 * @returns {string}
 */
function textOfContentBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) =>
        block !== null &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * The assistant text of the **last turn** in a bridge event stream.
 *
 * The predicate this replaces took `.at(-1)` across the whole stream, which two
 * ways goes wrong. It is not scoped to a turn, so a turn that emits only tool
 * calls silently inherits the previous turn's text as its "answer" (the same
 * stale-event trap that once made a waiting check match the canceled turn);
 * and an empty answer then reads as "the model did not know the withdrawn
 * secret", which is the fake green this helper exists to stop. Here "no turn
 * boundary seen" and "no assistant text in the turn" both return `""`, so the
 * caller's non-empty assertion decides, rather than defaulting to a pass.
 *
 * Text is joined across the turn's assistant messages (empty ones dropped): a
 * turn may emit an empty snapshot before its final message, and a turn whose
 * *last* frame happens to be empty still answered.
 *
 * @param {Array<{type?: string, data?: {message?: {content?: unknown}}}>} events - DSH session events, in arrival order.
 * @returns {string} the turn's answer text, `""` when it produced none.
 */
function lastTurnAnswer(events) {
  if (!Array.isArray(events)) return "";
  let start = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.type === "turn/start") start = index;
  }
  // No boundary at all: the stream cannot be attributed to a turn, so there is
  // no answer to judge. Returning the stream's tail here would restore the bug.
  if (start < 0) return "";
  const texts = [];
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const text = textOfContentBlocks(event.data?.message?.content);
    if (text.trim() !== "") texts.push(text);
  }
  return texts.join("\n");
}

/**
 * Every `user/message` in a replayed surface that a **plugin** injected.
 *
 * A plugin (for example a memory/recall plugin) injects its own message before
 * the human's, carrying `source.kind` such as `plugin:memory`; those rows are
 * ordinary `user/message` events in the durable log and in `paseo/history`, so
 * a rewind that folds the transcript does not fold them. Reading them back is
 * how a check can tell "the model forgot" from "a plugin handed it back".
 *
 * Content is read tolerantly (`data.content`, then `data.message.content`)
 * because a shape change must not turn this predicate into a silent pass; a
 * broken reader yields no rows, and a check that only looks for absence would
 * never notice. Callers that need certainty should pair it with a positive
 * observation (see `--with-memory` in `rewind-e2e.mjs`).
 *
 * @param {Array<{type?: string, data?: {source?: {kind?: string}, content?: unknown, message?: {content?: unknown}}}>} events
 * @returns {Array<{kind: string, text: string}>}
 */
function pluginInjectedUserTexts(events) {
  if (!Array.isArray(events)) return [];
  const rows = [];
  for (const event of events) {
    if (event?.type !== "user/message") continue;
    const kind = event.data?.source?.kind;
    if (typeof kind !== "string" || kind.startsWith("plugin:") === false) continue;
    rows.push({
      kind,
      text: textOfContentBlocks(event.data?.content ?? event.data?.message?.content),
    });
  }
  return rows;
}

/**
 * Pick the prompt frames that carried an image, from a recorder's list.
 *
 * @param {Array<{sessionId?: string, contentBlocks?: unknown}>} prompts
 * @param {{sessionId?: string, data: string, mimeType?: string}} wanted
 * @returns {number} matching frame count
 */
function countPromptFramesWithImage(prompts, wanted) {
  if (!Array.isArray(prompts)) return 0;
  return prompts.filter(
    (prompt) =>
      (wanted.sessionId === undefined || prompt.sessionId === wanted.sessionId) &&
      contentBlocksIncludeImage(prompt.contentBlocks, wanted.data, wanted.mimeType),
  ).length;
}

module.exports = {
  assistantFragmentation,
  classifyRouteOutcome,
  contentBlocksIncludeImage,
  countPromptFramesWithImage,
  lastTurnAnswer,
  pluginInjectedUserTexts,
  projectTimelineLikePaseo,
  routeExitCode,
  timelineItemsWithTurns,
};
