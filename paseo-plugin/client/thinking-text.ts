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

/**
 * Rough advance width of one character, in ems.
 *
 * CJK and emoji are about one em wide; Latin letters, digits and punctuation
 * about 0.55. Good enough to fill a preview line — this is a window, not a
 * layout pass.
 */
export function advanceEm(ch: string): number {
  return (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.55;
}

/**
 * The **tail** of a thought, windowed to the `width` a single line has.
 *
 * This deliberately replaces `latestCompletedParagraphFirstLine` for the running
 * state. That rule only advances once the newest paragraph *contains a newline*,
 * so one long paragraph froze the preview while the expanded view kept growing.
 *
 * The window is measured in ems, not characters: counting every character as one
 * em left an all-Latin tail at ~58% of the line and a mixed one at ~65%, which
 * read as "the line got shorter". Only the tail is read — flattening the whole
 * thought on every frame would be O(n) per render. The trailing `…` marks that
 * more is still arriving (and that the line was cut) and costs one em.
 */
export function streamingTail(text: string, width: number, fontSize: number): string {
  if (!(width > 0) || !(fontSize > 0)) return "";
  const budget = width / fontSize;
  // Enough of the tail that even an all-narrow stretch can fill the budget.
  const from = Math.max(0, text.length - Math.ceil(budget / 0.55) - 2);
  const chars = [...text.slice(from).replaceAll("**", "").replace(/\s+/gu, " ").trim()];
  if (chars.length === 0) return "";
  /** Index of the first character that fits `limit` ems, walking from the end. */
  const firstFitting = (limit: number): number => {
    let used = 0;
    let start = chars.length;
    while (start > 0) {
      const em = advanceEm(chars[start - 1]);
      if (used + em > limit) break;
      used += em;
      start -= 1;
    }
    return start;
  };
  if (firstFitting(budget) === 0) return chars.join("");
  return `${chars.slice(firstFitting(Math.max(0.55, budget - 1))).join("")}…`;
}
