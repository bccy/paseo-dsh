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

/** Left soft-dissolve width (px) on collapsed thinking marquee once scrolling left. */
export const MARQUEE_LEFT_FADE_PX = 36;
/** Right soft-dissolve width (px) + trailing spacer so incoming glyphs never hard-cut. */
export const MARQUEE_RIGHT_FADE_PX = 28;

/**
 * Build a multi-stop cubic Hermite smoothstep (`t^2 * (3 - 2t)`) CSS `mask-image`
 * for the collapsed thinking marquee's left and right edges, eliminating both
 * hard `overflow: hidden` cuts and 2-stop `linear-gradient` Mach-band creases.
 */
export function buildSmoothMarqueeMask(leftFadePx: number, rightFadePx: number): string {
  const L = Number.isFinite(leftFadePx) && leftFadePx >= 1 ? Math.round(leftFadePx * 2) / 2 : 0;
  const R = Number.isFinite(rightFadePx) && rightFadePx >= 1 ? Math.round(rightFadePx * 2) / 2 : 0;
  if (L <= 0 && R <= 0) return "";

  const fmt = (v: number) => (Number.isInteger(v) ? `${v}px` : `${v.toFixed(1)}px`);
  const leftStops =
    L > 0
      ? [
          "transparent 0px",
          `rgba(0, 0, 0, 0.16) ${fmt(L * 0.25)}`,
          `rgba(0, 0, 0, 0.5) ${fmt(L * 0.5)}`,
          `rgba(0, 0, 0, 0.84) ${fmt(L * 0.75)}`,
          `black ${fmt(L)}`,
        ].join(", ")
      : "black 0px";

  const rightStops =
    R > 0
      ? [
          `black calc(100% - ${fmt(R)})`,
          `rgba(0, 0, 0, 0.84) calc(100% - ${fmt(R * 0.75)})`,
          `rgba(0, 0, 0, 0.5) calc(100% - ${fmt(R * 0.5)})`,
          `rgba(0, 0, 0, 0.16) calc(100% - ${fmt(R * 0.25)})`,
          "transparent 100%",
        ].join(", ")
      : "black 100%";

  return `linear-gradient(to right, ${leftStops}, ${rightStops})`;
}

/**
 * Sample cubic Hermite smoothstep (`u^2 * (3 - 2u)`) strip opacities (`2pt`/strip)
 * for native iOS/Android `surface0` marquee edge curtains.
 */
export function buildHermiteEdgeFadeAlphas(
  steps = 14,
  edge: "left" | "right" = "left",
): number[] {
  const count = Math.max(2, Math.floor(steps));
  const out: number[] = [];
  for (let k = 0; k < count; k += 1) {
    const u = edge === "left" ? 1 - (k + 0.5) / count : (k + 0.5) / count;
    const smooth = u * u * (3 - 2 * u);
    out.push(Number(smooth.toFixed(3)));
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

/**
 * Width (code points) of the left-to-right `rgba` ink-fade trail on live
 * assistant replies — matched directly to `TOOL_BLOOM_TRAIL_WIDTH` (`9`) on
 * `InlineToolCall` so assistant prose and tool calls share one visual bloom.
 */
export const ASSISTANT_INK_TRAIL_WIDTH = 15;
/**
 * Alpha quantization steps across the active ink-fade trail so adjacent glyphs
 * sharing a band merge into one `<Text>` span (`<= 15` spans per active block).
 */
export const ASSISTANT_INK_ALPHA_STEPS = 15;
/**
 * Maximum intra-word ASCII transparent lookahead characters so an English token
 * wraps onto the next line from its first letter without mid-word jumping,
 * while CJK characters, spaces, and newlines never pre-expand vertical height.
 */
export const ASSISTANT_WORD_LOOKAHEAD_MAX = 16;

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
 * Returns true when a completed live reply whose ink-trail cursor has settled
 * should double-buffer swap into a single unified `<Markdown>{text}</Markdown>`
 * (restoring full syntax highlighting, code copy buttons, tables, clickable
 * workspace links, and cross-paragraph selection with zero row-ID swap).
 */
export function shouldMergeToUnifiedMarkdown(input: {
  readonly phase: "streaming" | "complete";
  readonly tailSettling: boolean;
  readonly blockCount: number;
}): boolean {
  return input.phase === "complete" && !input.tailSettling && input.blockCount >= 1;
}

export interface AssistantInkCursorStep {
  readonly cursor: number;
  readonly velocity: number;
  readonly settled: boolean;
}

/**
 * Continuous velocity-smoothed character cursor for assistant ink-trail bloom.
 *
 * - Paces at `~32–45 chars/sec` on short phrases (matching `InlineToolCall`'s
 *   `calcStreamDurationMs` CJK/ASCII rhythm) and uses a gentle `sqrt(unread)`
 *   sub-linear curve (`~55–90 chars/sec` on 40–200 char bursts, `< 1.5` chars
 *   per 60Hz frame) so fast model bursts still dissolve calmly character-by-
 *   character instead of rushing across the screen.
 * - Keeps the same calm curve after `phase === "complete"` (matching tool calls'
 *   `snapOnSettle: false`), only adding a mild overflow slope above 250 unread
 *   chars (hard-capped at `220 chars/sec`) so multi-page code dumps never stall.
 */
export function advanceAssistantInkCursor(input: {
  readonly current: number;
  readonly target: number;
  readonly velocity: number;
  readonly dtMs: number;
  readonly phase?: "streaming" | "complete";
  readonly speedBoost?: number;
  readonly trailWidth?: number;
}): AssistantInkCursorStep {
  const trailWidth = input.trailWidth ?? ASSISTANT_INK_TRAIL_WIDTH;
  if (!Number.isFinite(input.target) || input.target <= 0) {
    return { cursor: 0, velocity: 0, settled: false };
  }
  const settledTarget = input.target + trailWidth;
  const start = Number.isFinite(input.current) && input.current > 0 ? input.current : 0;
  if (start >= settledTarget - 0.02) {
    return { cursor: settledTarget, velocity: 0, settled: true };
  }
  if (!Number.isFinite(input.dtMs) || input.dtMs <= 0) {
    return {
      cursor: start,
      velocity: Number.isFinite(input.velocity) && input.velocity > 0 ? input.velocity : 0,
      settled: false,
    };
  }

  const clampedDt = Math.min(input.dtMs, 64);
  const boost =
    input.speedBoost !== undefined && Number.isFinite(input.speedBoost) && input.speedBoost > 0
      ? input.speedBoost
      : 1;
  const prevVel = Number.isFinite(input.velocity) && input.velocity > 0 ? input.velocity : 0;
  const unread = Math.max(0, input.target - start);

  let nextVelocity: number;
  if (unread > 0) {
    const coreCps = 28 + Math.sqrt(unread) * 4.2;
    const overflowCps = unread > 250 ? (unread - 250) * 0.28 : 0;
    const baseCps = Math.min(220, coreCps + overflowCps);
    const desiredCps = baseCps * boost;
    if (prevVel <= 1) {
      nextVelocity = desiredCps;
    } else {
      const alphaV = 1 - Math.exp(-clampedDt / 65);
      nextVelocity = prevVel + (desiredCps - prevVel) * alphaV;
    }
  } else {
    const tailTargetCps = Math.max(34, trailWidth / 0.28) * boost;
    if (prevVel <= tailTargetCps) {
      nextVelocity = tailTargetCps;
    } else {
      const alphaV = 1 - Math.exp(-clampedDt / 75);
      nextVelocity = Math.max(tailTargetCps, prevVel + (tailTargetCps - prevVel) * alphaV);
    }
  }

  const next = Math.min(settledTarget, start + (nextVelocity * clampedDt) / 1000);
  if (next >= settledTarget - 0.02) {
    return { cursor: settledTarget, velocity: 0, settled: true };
  }
  return { cursor: next, velocity: nextVelocity, settled: false };
}

export type InlineBloomKind =
  | "plain"
  | "bold"
  | "italic"
  | "boldItalic"
  | "code"
  | "link"
  | "strike";

export interface IndexedInlineRun {
  readonly text: string;
  readonly kind: InlineBloomKind;
  readonly startCp: number;
  readonly cpCount: number;
  /** Cumulative UTF-16 code-unit offsets per code point (`length === cpCount + 1`). */
  readonly cpOffsets: readonly number[];
}

export interface StyledInkTrailSegment {
  readonly text: string;
  readonly kind: InlineBloomKind;
  /** Alpha in `[0, 1]`: `0` = intra-word ASCII wrap lookahead, `[0.04, 1]` = ink trail. */
  readonly alpha: number;
  /** Leading edge highlight tier matching `stream-reveal.ts` (`2` = tip, `1` = mid, `0` = settled). */
  readonly highlight: 0 | 1 | 2;
}

export interface AssistantBloomListItem {
  readonly indent: number;
  readonly marker: string;
  readonly markerStartCp: number;
  readonly markerCpCount: number;
  readonly runs: readonly IndexedInlineRun[];
  readonly bodyStartCp: number;
  readonly bodyCpCount: number;
}

export type AssistantBloomBlockPlan =
  | {
      readonly kind: "paragraph" | "blockquote";
      readonly raw: string;
      readonly cpCount: number;
      readonly runs: readonly IndexedInlineRun[];
    }
  | {
      readonly kind: "heading";
      readonly raw: string;
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly cpCount: number;
      readonly runs: readonly IndexedInlineRun[];
    }
  | {
      readonly kind: "list";
      readonly raw: string;
      readonly cpCount: number;
      readonly items: readonly AssistantBloomListItem[];
    }
  | {
      readonly kind: "code" | "table";
      readonly raw: string;
      readonly lang: string;
      readonly cpCount: number;
      readonly runs: readonly IndexedInlineRun[];
    }
  | {
      readonly kind: "hr";
      readonly raw: string;
      readonly cpCount: number;
    };

function buildCpOffsets(text: string): number[] {
  const offsets: number[] = [0];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 2;
        offsets.push(i);
        continue;
      }
    }
    i += 1;
    offsets.push(i);
  }
  return offsets;
}

function indexInlineRuns(rawRuns: ReadonlyArray<{ text: string; kind: InlineBloomKind }>): {
  readonly runs: IndexedInlineRun[];
  readonly cpCount: number;
} {
  const runs: IndexedInlineRun[] = [];
  let offset = 0;
  for (const r of rawRuns) {
    if (!r.text) continue;
    const prev = runs[runs.length - 1];
    if (prev !== undefined && prev.kind === r.kind) {
      const mergedText = prev.text + r.text;
      const cpOffsets = buildCpOffsets(mergedText);
      const cpCount = cpOffsets.length - 1;
      offset = prev.startCp + cpCount;
      runs[runs.length - 1] = {
        text: mergedText,
        kind: prev.kind,
        startCp: prev.startCp,
        cpCount,
        cpOffsets,
      };
      continue;
    }
    const cpOffsets = buildCpOffsets(r.text);
    const cpCount = cpOffsets.length - 1;
    if (cpCount === 0) continue;
    runs.push({
      text: r.text,
      kind: r.kind,
      startCp: offset,
      cpCount,
      cpOffsets,
    });
    offset += cpCount;
  }
  return { runs, cpCount: offset };
}

/**
 * Streaming-safe inline Markdown tokenizer (`**bold**`, `*italic*`, `***both***`,
 * `` `code` ``, `[label](url)`, `~~strike~~`). Handles still-unclosed trailing
 * markers during live token streaming so raw `**`, `` ` ``, or `(https://...`
 * URLs never flash before closing delimiters arrive.
 */
export function parseInlineMarkdownRuns(text: string): IndexedInlineRun[] {
  if (!text) return [];
  const raw: Array<{ text: string; kind: InlineBloomKind }> = [];
  let buf = "";
  const flushBuf = () => {
    if (buf !== "") {
      raw.push({ text: buf, kind: "plain" });
      buf = "";
    }
  };

  const lines = text.split(/\r?\n/);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    if (lineIdx > 0) buf += "\n";
    const line = lines[lineIdx]!;
    let i = 0;
    while (i < line.length) {
      const ch = line[i]!;

      if (ch === "\\" && i + 1 < line.length && /[\\`*_{}[\]()#+\-.!~|>]/.test(line[i + 1]!)) {
        buf += line[i + 1]!;
        i += 2;
        continue;
      }

      if (ch === "`") {
        let tickEnd = i + 1;
        while (tickEnd < line.length && line[tickEnd] === "`") tickEnd += 1;
        const ticks = line.slice(i, tickEnd);
        const closeIdx = line.indexOf(ticks, tickEnd);
        flushBuf();
        if (closeIdx !== -1) {
          const inner = line.slice(tickEnd, closeIdx);
          if (inner !== "") raw.push({ text: inner, kind: "code" });
          i = closeIdx + ticks.length;
        } else {
          const inner = line.slice(tickEnd);
          if (inner !== "") raw.push({ text: inner, kind: "code" });
          i = line.length;
        }
        continue;
      }

      if (ch === "*" && line[i + 1] === "*" && line[i + 2] === "*") {
        const closeIdx = line.indexOf("***", i + 3);
        flushBuf();
        if (closeIdx !== -1) {
          if (closeIdx > i + 3) raw.push({ text: line.slice(i + 3, closeIdx), kind: "boldItalic" });
          i = closeIdx + 3;
        } else {
          if (i + 3 < line.length) raw.push({ text: line.slice(i + 3), kind: "boldItalic" });
          i = line.length;
        }
        continue;
      }

      if (ch === "*" && line[i + 1] === "*") {
        const closeIdx = line.indexOf("**", i + 2);
        flushBuf();
        if (closeIdx !== -1) {
          if (closeIdx > i + 2) raw.push({ text: line.slice(i + 2, closeIdx), kind: "bold" });
          i = closeIdx + 2;
        } else {
          if (i + 2 < line.length) raw.push({ text: line.slice(i + 2), kind: "bold" });
          i = line.length;
        }
        continue;
      }

      if (ch === "~" && line[i + 1] === "~") {
        const closeIdx = line.indexOf("~~", i + 2);
        flushBuf();
        if (closeIdx !== -1) {
          if (closeIdx > i + 2) raw.push({ text: line.slice(i + 2, closeIdx), kind: "strike" });
          i = closeIdx + 2;
        } else {
          if (i + 2 < line.length) raw.push({ text: line.slice(i + 2), kind: "strike" });
          i = line.length;
        }
        continue;
      }

      if (
        ch === "*" &&
        i + 1 < line.length &&
        !/[\s*]/.test(line[i + 1]!) &&
        (i === 0 || /[\s([{"'‘“，。：；！？、]/.test(line[i - 1]!))
      ) {
        const closeIdx = line.indexOf("*", i + 1);
        if (closeIdx > i + 1 && !/\s/.test(line[closeIdx - 1]!)) {
          flushBuf();
          raw.push({ text: line.slice(i + 1, closeIdx), kind: "italic" });
          i = closeIdx + 1;
          continue;
        }
      }

      if (ch === "[") {
        const closeBracket = line.indexOf("]", i + 1);
        if (closeBracket !== -1 && line[closeBracket + 1] === "(") {
          const label = line.slice(i + 1, closeBracket);
          const closeParen = line.indexOf(")", closeBracket + 2);
          flushBuf();
          if (label !== "") raw.push({ text: label, kind: "link" });
          i = closeParen !== -1 ? closeParen + 1 : line.length;
          continue;
        }
      }

      buf += ch;
      i += 1;
    }
    flushBuf();
  }

  return indexInlineRuns(raw).runs;
}

/**
 * Tokenize a single top-level Markdown block into a cached `AssistantBloomBlockPlan`
 * so active streaming frames never invoke `<Markdown>` AST parsing and settled
 * blocks freeze with zero mid-stream layout shift.
 */
export function parseAssistantBloomBlock(raw: string): AssistantBloomBlockPlan {
  const rawLines = raw.split(/\r?\n/);
  const firstTrimmedStart = (rawLines[0] ?? "").trimStart();
  const trimmed = raw.trim();

  // Horizontal rule
  const compactHr = trimmed.replace(/\s+/g, "");
  if (rawLines.length === 1 && /^(?:-{3,}|\*{3,}|_{3,})$/.test(compactHr)) {
    return { kind: "hr", raw, cpCount: 1 };
  }

  // Fenced code block (` ``` ` or `~~~`)
  const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(firstTrimmedStart);
  if (
    fenceMatch !== null &&
    !(fenceMatch[1]![0] === "`" && fenceMatch[2]!.includes("`"))
  ) {
    const fenceMarker = fenceMatch[1]!;
    const info = fenceMatch[2]!.trim();
    const lang = info.split(/\s+/)[0] ?? "";
    let endIdx = rawLines.length;
    if (
      rawLines.length >= 2 &&
      isClosingFenceLine(rawLines[rawLines.length - 1]!.trimStart(), fenceMarker)
    ) {
      endIdx = rawLines.length - 1;
    }
    const codeBody = rawLines.slice(1, endIdx).join("\n");
    const indexed = indexInlineRuns(codeBody ? [{ text: codeBody, kind: "plain" }] : []);
    return {
      kind: "code",
      raw,
      lang,
      cpCount: indexed.cpCount,
      runs: indexed.runs,
    };
  }

  // 4-space / tab indented code block
  if (
    rawLines.length > 0 &&
    rawLines.every((l) => l.trim() === "" || /^(?: {4}|\t)/.test(l)) &&
    rawLines.some((l) => /^(?: {4}|\t)\S/.test(l))
  ) {
    const dedented = rawLines
      .map((l) => (l.startsWith("    ") ? l.slice(4) : l.startsWith("\t") ? l.slice(1) : l))
      .join("\n")
      .trimEnd();
    const indexed = indexInlineRuns(dedented ? [{ text: dedented, kind: "plain" }] : []);
    return {
      kind: "code",
      raw,
      lang: "",
      cpCount: indexed.cpCount,
      runs: indexed.runs,
    };
  }

  // ATX heading (`#`..`######`)
  const atxMatch = /^(#{1,6})(?:\s+(.*))?$/.exec(trimmed);
  if (rawLines.length === 1 && atxMatch !== null) {
    const level = Math.min(6, Math.max(1, atxMatch[1]!.length)) as 1 | 2 | 3 | 4 | 5 | 6;
    const headingBody = (atxMatch[2] ?? "").replace(/\s+#+\s*$/, "").trim();
    const runs = parseInlineMarkdownRuns(headingBody);
    const cpCount = runs.length > 0 ? runs[runs.length - 1]!.startCp + runs[runs.length - 1]!.cpCount : 0;
    return { kind: "heading", raw, level, cpCount, runs };
  }

  // Setext heading (`Title\n===` or `Title\n---`)
  if (rawLines.length >= 2) {
    const lastTrimmed = rawLines[rawLines.length - 1]!.trim();
    if (/^(?:={2,}|-{2,})$/.test(lastTrimmed)) {
      const level = lastTrimmed.startsWith("=") ? 1 : 2;
      const headingBody = rawLines.slice(0, -1).join("\n").trim();
      const runs = parseInlineMarkdownRuns(headingBody);
      const cpCount = runs.length > 0 ? runs[runs.length - 1]!.startCp + runs[runs.length - 1]!.cpCount : 0;
      return { kind: "heading", raw, level, cpCount, runs };
    }
  }

  // Pipe table
  let pipeLines = 0;
  for (const l of rawLines) {
    const t = l.trim();
    if (t.startsWith("|") && t.includes("|", 1)) pipeLines += 1;
  }
  if (pipeLines >= 2 || (rawLines.length === 1 && trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2)) {
    const indexed = indexInlineRuns([{ text: raw.trimEnd(), kind: "plain" }]);
    return {
      kind: "table",
      raw,
      lang: "",
      cpCount: indexed.cpCount,
      runs: indexed.runs,
    };
  }

  // Blockquote (`> ...`)
  if (rawLines.every((l) => l.trimStart().startsWith(">") || l.trim() === "")) {
    const stripped = rawLines
      .map((l) => l.trimStart().replace(/^>\s?/, ""))
      .join("\n")
      .trimEnd();
    const runs = parseInlineMarkdownRuns(stripped);
    const cpCount = runs.length > 0 ? runs[runs.length - 1]!.startCp + runs[runs.length - 1]!.cpCount : 0;
    return { kind: "blockquote", raw, cpCount, runs };
  }

  // Tight / indented bullet or ordered list
  const firstTrimmed = rawLines[0]?.trimStart() ?? "";
  if (/^(?:[-*+]|\d+[.)])\s+/.test(firstTrimmed)) {
    const parsedItems: Array<{ indent: number; marker: string; bodyLines: string[] }> = [];
    for (const line of rawLines) {
      const t = line.trimStart();
      const leading = line.length - t.length;
      const ul = /^([-*+])\s+(.*)$/.exec(t);
      const ol = /^(\d+[.)])\s+(.*)$/.exec(t);
      if (ul !== null) {
        parsedItems.push({
          indent: Math.min(4, Math.floor(leading / 2)),
          marker: "•",
          bodyLines: [ul[2]!],
        });
      } else if (ol !== null) {
        parsedItems.push({
          indent: Math.min(4, Math.floor(leading / 2)),
          marker: ol[1]!,
          bodyLines: [ol[2]!],
        });
      } else if (parsedItems.length > 0) {
        parsedItems[parsedItems.length - 1]!.bodyLines.push(t);
      }
    }
    if (parsedItems.length > 0) {
      const items: AssistantBloomListItem[] = [];
      let cpCursor = 0;
      for (const item of parsedItems) {
        const markerCpCount = countCodePoints(item.marker);
        const markerStartCp = cpCursor;
        cpCursor += markerCpCount;
        const runs = parseInlineMarkdownRuns(item.bodyLines.join("\n"));
        const bodyCpCount =
          runs.length > 0 ? runs[runs.length - 1]!.startCp + runs[runs.length - 1]!.cpCount : 0;
        const bodyStartCp = cpCursor;
        cpCursor += bodyCpCount;
        items.push({
          indent: item.indent,
          marker: item.marker,
          markerStartCp,
          markerCpCount,
          runs,
          bodyStartCp,
          bodyCpCount,
        });
      }
      return { kind: "list", raw, cpCount: cpCursor, items };
    }
  }

  // Standard prose paragraph
  const runs = parseInlineMarkdownRuns(raw);
  const cpCount = runs.length > 0 ? runs[runs.length - 1]!.startCp + runs[runs.length - 1]!.cpCount : 0;
  return { kind: "paragraph", raw, cpCount, runs };
}

function isAsciiWordGlyph(ch: string): boolean {
  if (ch.length !== 1) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f || // _
    c === 0x2d || // -
    c === 0x2e || // .
    c === 0x2f    // /
  );
}

/**
 * Slice pre-indexed inline runs at `progressChars` using the exact same Hermite
 * `rgba` ink-fade trail curve as `InlineToolCall` (`buildInkTrailSegments` +
 * `renderInkTrailText`), in O(trailWidth) time with zero `Array.from` per frame.
 */
export function buildStyledInkTrailSegments(
  runs: readonly IndexedInlineRun[],
  progressChars: number,
  trailWidth = ASSISTANT_INK_TRAIL_WIDTH,
  settledFloor = 0,
  wordLookaheadMax = ASSISTANT_WORD_LOOKAHEAD_MAX,
): StyledInkTrailSegment[] {
  if (runs.length === 0 || progressChars <= 0) return [];
  const lastRun = runs[runs.length - 1]!;
  const totalCp = lastRun.startCp + lastRun.cpCount;
  if (totalCp <= 0) return [];

  if (!Number.isFinite(progressChars) || progressChars >= totalCp + trailWidth) {
    return runs.map((r) => ({ text: r.text, kind: r.kind, alpha: 1, highlight: 0 }));
  }

  const floorEnd = Number.isFinite(settledFloor)
    ? Math.max(0, Math.min(totalCp, Math.floor(settledFloor)))
    : 0;
  const headEnd = Math.min(totalCp, Math.max(floorEnd, Math.ceil(progressChars)));
  const settledEnd = Math.min(
    headEnd,
    Math.max(floorEnd, Math.floor(progressChars - trailWidth)),
  );

  const out: StyledInkTrailSegment[] = [];
  const pushSeg = (
    text: string,
    kind: InlineBloomKind,
    alpha: number,
    highlight: 0 | 1 | 2,
  ) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.kind === kind &&
      prev.alpha === alpha &&
      prev.highlight === highlight
    ) {
      out[out.length - 1] = { text: prev.text + text, kind, alpha, highlight };
    } else {
      out.push({ text, kind, alpha, highlight });
    }
  };

  let runIdx = 0;
  // 1. Settled prefix `[0, settledEnd)` via direct O(1) UTF-16 offset slicing
  while (runIdx < runs.length && runs[runIdx]!.startCp < settledEnd) {
    const r = runs[runIdx]!;
    const runEnd = r.startCp + r.cpCount;
    if (runEnd <= settledEnd) {
      pushSeg(r.text, r.kind, 1, 0);
      runIdx += 1;
    } else {
      const localTake = settledEnd - r.startCp;
      pushSeg(r.text.slice(0, r.cpOffsets[localTake]!), r.kind, 1, 0);
      break;
    }
  }

  // 2. Active ink-fade trail `[settledEnd, headEnd)` (at most `trailWidth` iterations)
  let lastRevealedChar = "";
  for (let cp = settledEnd; cp < headEnd; cp += 1) {
    while (runIdx < runs.length && runs[runIdx]!.startCp + runs[runIdx]!.cpCount <= cp) {
      runIdx += 1;
    }
    const r = runs[runIdx];
    if (!r) break;
    const localIdx = cp - r.startCp;
    const ch = r.text.slice(r.cpOffsets[localIdx]!, r.cpOffsets[localIdx + 1]!);
    lastRevealedChar = ch;

    const age = progressChars - cp;
    const t = Math.max(0, Math.min(1, age / trailWidth));
    const smooth = t * t * (3 - 2 * t);
    const visualAlpha = 0.04 + 0.96 * smooth;
    const quantized =
      visualAlpha >= 0.995
        ? 1
        : Math.max(
            0.04,
            Math.round(visualAlpha * ASSISTANT_INK_ALPHA_STEPS) / ASSISTANT_INK_ALPHA_STEPS,
          );
    const alpha = Number(quantized.toFixed(3));
    const highlight: 0 | 1 | 2 = alpha >= 1 ? 0 : t < 0.45 ? 2 : t < 0.78 ? 1 : 0;
    pushSeg(ch, r.kind, alpha, highlight);
  }

  // If settledEnd === headEnd (e.g. settledFloor clamped right at headEnd), read last settled char
  if (lastRevealedChar === "" && headEnd > 0) {
    let probeIdx = runIdx;
    while (probeIdx > 0 && runs[probeIdx]!.startCp >= headEnd) probeIdx -= 1;
    const pr = runs[probeIdx];
    if (pr && headEnd - 1 >= pr.startCp && headEnd - 1 < pr.startCp + pr.cpCount) {
      const li = headEnd - 1 - pr.startCp;
      lastRevealedChar = pr.text.slice(pr.cpOffsets[li]!, pr.cpOffsets[li + 1]!);
    }
  }

  // 3. Intra-word ASCII wrap lookahead (`<= 16` chars, `alpha: 0`, never crosses space/CJK/newline)
  if (wordLookaheadMax > 0 && headEnd > 0 && headEnd < totalCp && isAsciiWordGlyph(lastRevealedChar)) {
    const maxCp = Math.min(totalCp, headEnd + wordLookaheadMax);
    for (let cp = headEnd; cp < maxCp; cp += 1) {
      while (runIdx < runs.length && runs[runIdx]!.startCp + runs[runIdx]!.cpCount <= cp) {
        runIdx += 1;
      }
      const r = runs[runIdx];
      if (!r) break;
      const localIdx = cp - r.startCp;
      const ch = r.text.slice(r.cpOffsets[localIdx]!, r.cpOffsets[localIdx + 1]!);
      if (!isAsciiWordGlyph(ch)) break;
      pushSeg(ch, r.kind, 0, 0);
    }
  }

  return out;
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
