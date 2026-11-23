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

/** One logical section of a thought (explicit `**Heading**` or plain paragraph). */
export interface ThinkingSection {
  readonly title: string;
  readonly body: string;
  readonly explicitTitle: boolean;
}

/** One inline formatting run inside a thinking paragraph. */
export interface InlineRun {
  readonly kind: "text" | "code" | "bold";
  readonly text: string;
}

const IMPLICIT_TITLE_MAX_CHARS = 26;

function truncateCodePoints(value: string, maxChars: number): string {
  const chars = [...value];
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars).join("")}…`;
}

/**
 * Split a thought into paragraphs/sections for structured prose and stepper views.
 *
 * A paragraph whose first line is a standalone `**Heading**` becomes an explicit
 * titled section (`explicitTitle: true`); other paragraphs keep their original
 * text in `body` (so inline `` `code` `` and `**emphasis**` still render) while
 * deriving a concise headline from their first line.
 */
export function parseThinkingSections(text: string): ThinkingSection[] {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const blocks = normalized
    .split(/\n(?:[\t ]*\n)+/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const sections: ThinkingSection[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const first = lines[0].trim();
    const heading = /^\*\*(.+?)\*\*$/u.exec(first);
    if (heading !== null && heading[1].trim().length > 0) {
      sections.push({
        title: heading[1].trim(),
        body: lines.slice(1).join("\n").trim(),
        explicitTitle: true,
      });
    } else {
      const cleaned = first.replaceAll("**", "").trim();
      sections.push({
        title: truncateCodePoints(cleaned, IMPLICIT_TITLE_MAX_CHARS),
        body: block,
        explicitTitle: false,
      });
    }
  }
  return sections;
}

/**
 * Single-pass O(n) inline parser for `` `code` `` and `**bold**` runs.
 *
 * Never drops characters and never backtracks: unclosed delimiters stay plain
 * text, and neither construct crosses a newline.
 */
export function parseInlineRuns(text: string): InlineRun[] {
  if (text.length === 0) return [];
  const runs: InlineRun[] = [];
  let plainStart = 0;
  let i = 0;

  const flushPlain = (end: number): void => {
    if (end > plainStart) {
      const chunk = text.slice(plainStart, end);
      const last = runs[runs.length - 1];
      if (last !== undefined && last.kind === "text") {
        runs[runs.length - 1] = { kind: "text", text: last.text + chunk };
      } else {
        runs.push({ kind: "text", text: chunk });
      }
    }
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      const newline = text.indexOf("\n", i + 1);
      const close = text.indexOf("`", i + 1);
      if (close !== -1 && close > i + 1 && (newline === -1 || close < newline)) {
        flushPlain(i);
        runs.push({ kind: "code", text: text.slice(i + 1, close) });
        i = close + 1;
        plainStart = i;
        continue;
      }
    } else if (ch === "*" && text[i + 1] === "*") {
      const newline = text.indexOf("\n", i + 2);
      const close = text.indexOf("**", i + 2);
      if (close !== -1 && close > i + 2 && (newline === -1 || close < newline)) {
        flushPlain(i);
        runs.push({ kind: "bold", text: text.slice(i + 2, close) });
        i = close + 2;
        plainStart = i;
        continue;
      }
    }
    i += 1;
  }

  flushPlain(text.length);
  return runs;
}

/**
 * Calm single-line headline for the enhanced thinking-row styles.
 *
 * - Settled (`running === false`): first non-empty line, stripped of `**`.
 * - Running (`running === true`): latest section's explicit heading, or the
 *   latest non-empty clause in the newest paragraph. Returns `""` when the
 *   thought has no readable text yet so the caller can show localized fallback.
 */
export function thinkingHeadline(text: string, running: boolean): string {
  if (!running) {
    const firstNonEmpty = text
      .replace(/\r\n?/gu, "\n")
      .split("\n")
      .find((line) => line.trim().length > 0);
    return (firstNonEmpty ?? "").replaceAll("**", "").trim();
  }
  const sections = parseThinkingSections(text);
  if (sections.length === 0) return "";
  const last = sections[sections.length - 1];
  if (last.explicitTitle) return last.title;
  const clauses = last.body
    .replaceAll("**", "")
    .split(/[。；！？\n]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return clauses[clauses.length - 1] ?? last.title;
}

/**
 * Flattened tail window for multi-line streaming peek boxes (Rail / Capsule / Editorial).
 *
 * Slices by Unicode code points so CJK characters and emoji are never split.
 */
export function thinkingPeekTail(text: string, maxChars: number): string {
  if (!(maxChars > 0)) return "";
  const clean = text.replaceAll("**", "").replace(/\s+/gu, " ").trim();
  if (clean.length === 0) return "";
  const chars = [...clean];
  if (chars.length <= maxChars) return clean;
  return `…${chars.slice(chars.length - maxChars).join("")}`;
}

/**
 * Format an observed streaming duration in milliseconds for tabular metadata.
 *
 * Returns `""` below 100ms (or for non-finite values) so instant/replayed rows
 * never show noisy `0.0s` badges.
 */
export function formatThinkingDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 100) return "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${secs}s`;
}
