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

/**
 * Flatten a live thinking stream (either raw DSH text or accumulated Chinese
 * translation) into one clean single-line string for character-by-character
 * leftward scrolling.
 */
export function normalizeLeftScrollStream(text: string): string {
  return text
    .replaceAll("**", "")
    .replace(/…+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Adaptive character-by-character cursor advancement for calm, readable
 * leftward marquee scrolling across both DSH chunks and Antigravity
 * translated sentences.
 *
 * - Base reading pace: ~13 chars/sec (~77ms/char) — comfortable Chinese scan speed.
 * - Gentle catch-up under backlog: caps at ~26 chars/sec (~38ms/char) and <=1 char/frame
 *   so text never turns into an unreadable blur.
 */
export function advanceLeftScrollCursor(
  current: number,
  target: number,
  dtMs: number,
): number {
  if (!Number.isFinite(target) || target <= 0) return 0;
  if (!Number.isFinite(current) || current < 0) return 0;
  if (target <= current) return target;
  if (!Number.isFinite(dtMs) || dtMs <= 0) return current;
  const clampedDt = Math.min(dtMs, 50);
  const backlog = target - current;
  const charsPerSec = Math.min(26, 13 + backlog * 0.12);
  const step = Math.min(1.0, (charsPerSec * clampedDt) / 1000);
  return Math.min(target, current + step);
}

/** Base glide speed (px/s) shared by Web CSS and iOS/Android native marquee. */
export const SMOOTH_MARQUEE_BASE_PX_PER_SEC = 145;
/** Upper speed cap (px/s) under burst backlog so scrolling stays calm & legible. */
export const SMOOTH_MARQUEE_MAX_PX_PER_SEC = 300;
/** Extra px/s per pixel of unread backlog. */
export const SMOOTH_MARQUEE_BACKLOG_GAIN = 0.35;

/**
 * Continuous sub-pixel advancement (in CSS pixels) for 60/120fps GPU-composited
 * leftward marquee scrolling on Web/Safari.
 *
 * - Base glide velocity: ~145 px/sec (~11 Chinese chars/sec, calm & readable).
 * - Gentle catch-up under backlog: caps smoothly at ~300 px/sec so text glides
 *   like silk without ever snapping by whole characters or turning into a blur.
 */
export function advanceSmoothPixelOffset(
  currentPx: number,
  targetPx: number,
  dtMs: number,
): number {
  if (!Number.isFinite(targetPx) || targetPx <= 0) return 0;
  if (!Number.isFinite(currentPx) || currentPx < 0) return 0;
  if (targetPx <= currentPx) return targetPx;
  if (!Number.isFinite(dtMs) || dtMs <= 0) return currentPx;
  const clampedDt = Math.min(dtMs, 40);
  const backlogPx = targetPx - currentPx;
  const pxPerSec = Math.min(
    SMOOTH_MARQUEE_MAX_PX_PER_SEC,
    SMOOTH_MARQUEE_BASE_PX_PER_SEC + backlogPx * SMOOTH_MARQUEE_BACKLOG_GAIN,
  );
  return Math.min(targetPx, currentPx + (pxPerSec * clampedDt) / 1000);
}

/**
 * Computes the `Animated.timing` duration (ms) for iOS/Android native-driver
 * smooth leftward marquee scrolling using the exact same velocity curve as
 * {@link advanceSmoothPixelOffset}.
 */
export function computeSmoothMarqueeDurationMs(distancePx: number): number {
  if (!Number.isFinite(distancePx) || distancePx <= 0) return 0;
  const pxPerSec = Math.min(
    SMOOTH_MARQUEE_MAX_PX_PER_SEC,
    SMOOTH_MARQUEE_BASE_PX_PER_SEC + distancePx * SMOOTH_MARQUEE_BACKLOG_GAIN,
  );
  return Math.max(16, Math.round((distancePx / pxPerSec) * 1000));
}

/**
 * Splits a flattened marquee stream into code-point-safe fixed-size chunks so
 * native iOS `UILabel` backing textures stay tiny (avoiding the `@3x` 5461pt
 * Metal texture ceiling) and off-screen chunks can retire cleanly into a spacer.
 */
export function splitNativeMarqueeChunks(text: string, chunkChars = 24): string[] {
  if (!text) return [];
  const size = Math.max(1, Math.floor(chunkChars));
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    out.push(chars.slice(i, i + size).join(""));
  }
  return out;
}

/** Count Unicode code points without allocating a full character array. */
export function countCodePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

/** Width (code points) of the soft front-to-back emergence wave in expanded thinking body. */
export const EXPANDED_BLOOM_WAVE_WIDTH = 24;
/** Transparent lookahead characters pre-placed in layout so whole sentences/paragraphs emerge without wrap jitter. */
export const EXPANDED_BLOOM_LOOKAHEAD_CHARS = 48;

/**
 * Decides whether a mounting `AssistantMessageBloom` row should animate live
 * GPU emergence versus render settled immediately (reloaded or reopened
 * idle/initializing conversation whose trailing reply briefly lands in Paseo's
 * `head` with `phase: "streaming"`).
 *
 * Intentionally does NOT gate on initial text length or timestamp age: live
 * ACP/Antigravity replies often arrive as a 150–400 char first burst or after
 * a multi-second tool/thinking turn, and must still get the full mist bloom.
 */
export function shouldStartAssistantBloomFromZero(input: {
  readonly phase: "streaming" | "complete";
  readonly totalCp: number;
  readonly agentStatus?: string | null;
}): boolean {
  if (input.phase !== "streaming" || input.totalCp <= 0) return false;
  if (
    input.agentStatus !== undefined &&
    input.agentStatus !== null &&
    input.agentStatus !== "running"
  ) {
    return false;
  }
  return true;
}

/**
 * Advance the floating-point code-point wave front for expanded thinking body
 * emergence at a deliberately unhurried reading pace (~14–42 chars/sec) so each
 * glyph takes ~0.6–1.1s to slowly materialize from its front half to its tail.
 */
export function advanceExpandedInkCursor(
  current: number,
  target: number,
  dtMs: number,
  waveWidth = EXPANDED_BLOOM_WAVE_WIDTH,
): number {
  if (!Number.isFinite(target) || target <= 0) return 0;
  const settledTarget = target + waveWidth;
  if (!Number.isFinite(current) || current < 0) return 0;
  if (current >= settledTarget) return settledTarget;
  if (!Number.isFinite(dtMs) || dtMs <= 0) return current;
  const clampedDt = Math.min(dtMs, 40);
  const unread = Math.max(0, target - current);
  const charsPerSec =
    unread > 0
      ? Math.min(42, 14 + unread * 0.28)
      : Math.max(18, waveWidth / 0.78);
  return Math.min(settledTarget, current + (charsPerSec * clampedDt) / 1000);
}

export interface ExpandedBloomSegment {
  readonly text: string;
  /** Smooth alpha in `[0, 1]`; `0` means pre-laid-out invisible lookahead, `1` means settled. */
  readonly alpha: number;
}

/**
 * Build soft front-to-back emergence runs for an expanded thinking tail.
 *
 * Unlike `buildInkTrailSegments` (which slices at `ceil(progress)` and uses
 * nested `opacity` + leading highlight), this keeps upcoming characters
 * pre-placed at `alpha: 0` (within a bounded lookahead window) and ramps a
 * wide 16-char smoothstep wave from `0 -> 1` so iOS `NSAttributedString`
 * `rgba(...)` text surfaces smoothly from the front half with zero popping.
 */
export function buildExpandedBloomSegments(
  text: string,
  waveProgress: number,
  waveWidth = EXPANDED_BLOOM_WAVE_WIDTH,
  settledFloor = 0,
  lookaheadChars = EXPANDED_BLOOM_LOOKAHEAD_CHARS,
): ExpandedBloomSegment[] {
  if (text.length === 0) return [];
  if (!Number.isFinite(waveProgress)) {
    return [{ text, alpha: 1 }];
  }
  const chars = Array.from(text);
  const len = chars.length;
  if (waveProgress >= len + waveWidth) {
    return [{ text, alpha: 1 }];
  }

  const floorEnd = Number.isFinite(settledFloor) ? Math.max(0, Math.floor(settledFloor)) : 0;
  const waveEnd = Math.min(len, Math.max(floorEnd, Math.ceil(waveProgress)));
  const settledEnd = Math.min(
    waveEnd,
    Math.max(floorEnd, Math.floor(waveProgress - waveWidth)),
  );
  const segments: ExpandedBloomSegment[] = [];

  if (settledEnd > 0) {
    segments.push({ text: chars.slice(0, settledEnd).join(""), alpha: 1 });
  }

  let transparentStart = waveEnd;
  for (let i = settledEnd; i < waveEnd; i += 1) {
    const age = waveProgress - i;
    const t = Math.max(0, Math.min(1, age / waveWidth));
    const smooth = t * t * (3 - 2 * t);
    const alpha = Number(smooth.toFixed(3));
    if (alpha <= 0.005) {
      transparentStart = i;
      break;
    }
    segments.push({ text: chars[i]!, alpha });
  }

  if (transparentStart < len && lookaheadChars > 0) {
    // Pre-lay out a bounded lookahead window invisibly so line wrapping stays
    // rock-steady while the wave emerges, without pushing a huge burst off-screen.
    let lookEnd = Math.min(len, Math.max(waveEnd, transparentStart) + lookaheadChars);
    const maxSnap = Math.min(len, lookEnd + 8);
    while (lookEnd < maxSnap && !/[\s\n.,!?;:，。！？；：]/.test(chars[lookEnd]!)) {
      lookEnd += 1;
    }
    if (lookEnd > transparentStart) {
      segments.push({ text: chars.slice(transparentStart, lookEnd).join(""), alpha: 0 });
    }
  }

  return segments;
}

export interface SettledBodySplitAdvance {
  /** Settled text before the newline run (no trailing newline). */
  readonly frozenDelta: string;
  /** UTF-16 offset in `activeText` where the remaining active tail begins. */
  readonly nextActiveStart: number;
  /** Number of code points consumed from `activeText` (including the newline run). */
  readonly consumedCodePoints: number;
  /** Extra blank lines (`newlineCount - 1`) to preserve as top margin on the active block. */
  readonly gapLines: number;
}

/**
 * Find the furthest newline boundary inside `activeText` that lies strictly
 * before `settledLocalCodePoints` (and leaves non-empty remaining text) so
 * completed paragraphs can freeze into a memoized static `<Text>` while only
 * the live tail paragraph runs ink-bloom rendering.
 */
export function findSettledBodySplit(
  activeText: string,
  settledLocalCodePoints: number,
): SettledBodySplitAdvance | null {
  if (!activeText || settledLocalCodePoints <= 0) return null;
  let cp = 0;
  let maxUtf16 = 0;
  while (maxUtf16 < activeText.length && cp < settledLocalCodePoints) {
    const code = activeText.charCodeAt(maxUtf16);
    if (code >= 0xd800 && code <= 0xdbff && maxUtf16 + 1 < activeText.length) {
      const next = activeText.charCodeAt(maxUtf16 + 1);
      if (next >= 0xdc00 && next <= 0xdfff) maxUtf16 += 1;
    }
    maxUtf16 += 1;
    cp += 1;
  }
  if (maxUtf16 <= 0 || maxUtf16 >= activeText.length) return null;

  const nlRunRe = /(?:\r?\n)+/g;
  let bestStart = -1;
  let bestEnd = -1;
  let bestGapLines = 0;
  let match: RegExpExecArray | null;
  while ((match = nlRunRe.exec(activeText)) !== null) {
    const runStart = match.index;
    const runEnd = runStart + match[0].length;
    if (runEnd > maxUtf16) break;
    if (runStart > 0 && runEnd < activeText.length) {
      bestStart = runStart;
      bestEnd = runEnd;
      const nlCount = (match[0].match(/\n/g) ?? []).length;
      bestGapLines = Math.max(0, nlCount - 1);
    }
  }
  if (bestStart < 0 || bestEnd < 0) return null;
  return {
    frozenDelta: activeText.slice(0, bestStart),
    nextActiveStart: bestEnd,
    consumedCodePoints: countCodePoints(activeText.slice(0, bestEnd)),
    gapLines: bestGapLines,
  };
}

/**
 * Returns true when an `assistant_message` contains only a standalone Markdown
 * image (e.g. tool-emitted image rows verified by `harness/image-check.cjs`),
 * so our bloom transformer hands it untouched to Paseo's stock image renderer.
 */
export function isStandaloneMarkdownImage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("![")) return false;
  return /^!\[[^\]]*\]\([^)\n]+\)$/.test(trimmed);
}

/** Throttle interval (ms) for active trailing Markdown block updates (~15 Hz). */
export const ACTIVE_BLOCK_THROTTLE_MS = 64;

export interface StableMarkdownSplit {
  /** Already-closed leading blocks whose Markdown source is frozen at stable indices. */
  readonly settledBlocks: readonly string[];
  /** Single trailing block currently growing, or `""` when text ends on a closed boundary. */
  readonly activeBlock: string;
}

function isClosingFenceLine(trimmed: string, fenceMarker: string): boolean {
  if (!trimmed.startsWith(fenceMarker)) return false;
  const fenceChar = fenceMarker[0]!;
  const stripped = trimmed.trimEnd();
  for (let i = fenceMarker.length; i < stripped.length; i += 1) {
    if (stripped[i] !== fenceChar) return false;
  }
  return true;
}

function parseMarkdownBlocksWithState(text: string): {
  readonly blocks: string[];
  readonly inOpenFence: boolean;
} {
  if (!text) return { blocks: [], inOpenFence: false };
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  let fenceMarker: string | null = null;

  const flush = () => {
    // Preserve leading indentation (e.g. 4-space indented code blocks); only
    // trim trailing blank lines / whitespace.
    const joined = current.join("\n").trimEnd();
    if (joined.trim() !== "") blocks.push(joined);
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (fenceMarker !== null) {
      current.push(line);
      if (isClosingFenceLine(trimmed, fenceMarker)) {
        fenceMarker = null;
        flush();
      }
      continue;
    }

    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    // CommonMark §4.5: info strings for backtick code fences cannot contain
    // backtick characters (e.g. an inline triple-backtick span like ```foo```).
    if (
      fenceMatch !== null &&
      !(fenceMatch[1]![0] === "`" && fenceMatch[2]!.includes("`"))
    ) {
      if (current.length > 0) flush();
      fenceMarker = fenceMatch[1]!;
      current.push(line);
      continue;
    }

    if (trimmed === "") {
      if (current.length > 0) flush();
      continue;
    }

    if (/^#{1,6}\s/.test(trimmed)) {
      if (current.length > 0) flush();
      current.push(line);
      flush();
      continue;
    }

    const leadingSpaces = line.length - trimmed.length;
    const prevTrimmed = current.length > 0 ? (current[0] ?? "").trimStart() : "";
    const prevIsList = current.length > 0 && /^(?:[-*+]|\d+\.)\s+/.test(prevTrimmed);
    const prevIsQuote = current.length > 0 && prevTrimmed.startsWith(">");
    const prevIsTable = current.length > 0 && prevTrimmed.startsWith("|");
    const currentIsPlainParagraph =
      current.length > 0 && !prevIsList && !prevIsQuote && !prevIsTable;

    // Setext heading underline (`---` or `===`) directly beneath a plain paragraph
    // belongs to that heading block rather than being split as a standalone `<hr>`.
    if (
      currentIsPlainParagraph &&
      leadingSpaces <= 3 &&
      /^(?:-{2,}|={2,})\s*$/.test(trimmed)
    ) {
      current.push(line);
      flush();
      continue;
    }

    if (/^(?:[-*_])(?:\s*[-*_]){2,}\s*$/.test(trimmed)) {
      const compactHr = trimmed.replace(/\s+/g, "");
      if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(compactHr)) {
        if (current.length > 0) flush();
        current.push(compactHr);
        flush();
        continue;
      }
    }

    const isListLine = /^(?:[-*+]|\d+\.)\s+/.test(trimmed);
    const isQuoteLine = trimmed.startsWith(">");
    const isIndentedContinuation = /^(?: {2,}|\t)\S/.test(line);
    if (current.length > 0) {
      if (
        (isListLine && !prevIsList) ||
        (!isListLine && prevIsList && !isIndentedContinuation) ||
        (isQuoteLine && !prevIsQuote) ||
        (!isQuoteLine && prevIsQuote)
      ) {
        flush();
      }
    }

    current.push(line);
  }

  if (current.length > 0) flush();
  return { blocks, inOpenFence: fenceMarker !== null };
}

/**
 * Splits a streaming Markdown assistant reply into top-level render-safe blocks
 * (paragraphs, headings, Setext headings, lists, tables, blockquotes, and fenced
 * code blocks) without ever tearing apart an open/closed code fence or table.
 */
export function splitAssistantMarkdownBlocks(text: string): string[] {
  return parseMarkdownBlocksWithState(text).blocks;
}

/**
 * Splits streaming Markdown into frozen `settledBlocks` (keyed by stable block
 * index behind `React.memo`) and the single growing trailing `activeBlock`.
 */
export function splitStableMarkdownBlocks(text: string): StableMarkdownSplit {
  const { blocks, inOpenFence } = parseMarkdownBlocksWithState(text);
  if (blocks.length === 0) {
    return { settledBlocks: [], activeBlock: "" };
  }
  if (!inOpenFence && /(?:\r?\n[\t ]*){2,}$/.test(text)) {
    return { settledBlocks: blocks, activeBlock: "" };
  }
  return {
    settledBlocks: blocks.slice(0, -1),
    activeBlock: blocks[blocks.length - 1]!,
  };
}

/**
 * Returns true when the trailing active block must commit synchronously without
 * waiting for the 64ms streaming throttle window (completion, newly closed
 * leading block, or first non-empty content).
 */
export function shouldFlushActiveBlockImmediately(input: {
  readonly prevSettledCount: number;
  readonly nextSettledCount: number;
  readonly phase: "streaming" | "complete";
  readonly hasCommittedText: boolean;
  readonly nextActiveText: string;
}): boolean {
  if (input.phase === "complete") return true;
  if (input.nextSettledCount !== input.prevSettledCount) return true;
  if (!input.hasCommittedText && input.nextActiveText.length > 0) return true;
  if (input.nextActiveText.length === 0) return true;
  return false;
}

/**
 * Returns true when a completed multi-block live reply should double-buffer
 * merge into a single unified `<Markdown>{text}</Markdown>` (restoring
 * reference-style links `[x][1]`, loose lists, and cross-paragraph selection
 * without remounting the plugin row).
 */
export function shouldMergeToUnifiedMarkdown(input: {
  readonly phase: "streaming" | "complete";
  readonly tailSettling: boolean;
  readonly blockCount: number;
}): boolean {
  return input.phase === "complete" && !input.tailSettling && input.blockCount > 1;
}

/**
 * Format an observed thinking duration in milliseconds for the right-aligned
 * thinking-row timer.
 *
 * Returns `""` below 100ms (or for non-finite values) so instant or replayed
 * rows never show a noisy `0.0s` badge. Rounds tenths before checking the 60s
 * boundary so `59_950ms`–`59_999ms` formats as `"1m 0s"` rather than `"60.0s"`.
 */
export function formatThinkingDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 100) return "";
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const totalSec = Math.floor(tenths / 10);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${secs}s`;
}
