/**
 * What a reasoning row previews while collapsed.
 *
 * Copied from DSH's `ReasoningRow`, which is the authority here:
 *
 * ```js
 * const summaryText = running ? latestCompletedParagraphFirstLine(text) : firstLine(text);
 * const summary = summaryText.replaceAll("**", "");
 * ```
 *
 * So a settled row previews its **first** line — not the last one it happened to
 * end on — and a streaming row previews the first line of the latest *completed*
 * paragraph, so the text advances a paragraph at a time instead of flickering on
 * every token. The row's own title is always "思考" (`message.think`); the
 * "已思考" string DSH has is for its collapsed whole-turn summary, a different
 * element.
 *
 * Pure functions, so the behaviour can be asserted without a device.
 *
 * @module dsh-paseo/client/thinking-text
 */

/** DSH's `firstLine`: everything before the first newline. */
export function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

/** DSH's `latestCompletedParagraphFirstLine`. */
export function latestCompletedParagraphFirstLine(text: string): string {
  let summary = "";
  let paragraphStart = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  for (;;) {
    const nextParagraph = separator.exec(text);
    const paragraphEnd =
      nextParagraph === null
        ? text.length
        : nextParagraph.index + nextParagraph[0].indexOf("\n");
    const newline = text.indexOf("\n", paragraphStart);
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim();
      if (candidate !== "") summary = candidate;
    }
    if (nextParagraph === null) return summary;
    paragraphStart = nextParagraph.index + nextParagraph[0].length;
  }
}

/**
 * The collapsed preview for one reasoning row.
 *
 * `running` means "this block is the streaming tail", which for us is the same
 * signal the shimmer uses (`growing`).
 */
export function reasoningPreview(text: string, running: boolean): string {
  const summary = running ? latestCompletedParagraphFirstLine(text) : firstLine(text);
  return summary.replaceAll("**", "");
}
