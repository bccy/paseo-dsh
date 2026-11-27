/**
 * Pure character-by-character "ink fade trail" streaming math for live
 * timeline rows (Plan A: soft trailing fade + subtle leading highlight).
 *
 * Kept free of React and React Native imports so offline harnesses can test
 * the cadence, Unicode code-point slicing, and trail gradients directly under
 * plain Node (`harness/newest-check.cjs`).
 *
 * @module dsh-paseo/client/stream-reveal
 */

/** Number of characters spanned by the soft fade-in trail at the active edge. */
export const STREAM_TRAIL_WIDTH = 5.5;
/** Brief lead-in delay (ms) so the row and leading icon soften in first. */
export const STREAM_LEAD_DELAY_MS = 45;
/** Extra settle time (ms) after the last char appears so its trail finishes. */
export const STREAM_TAIL_SETTLE_MS = 170;
/** Minimum active character-stream duration (ms) at standard pace. */
export const STREAM_MIN_DURATION_MS = 420;
/** Maximum active character-stream duration (ms) at standard pace. */
export const STREAM_MAX_DURATION_MS = 760;
/**
 * Maximum summary code points animated before handing off to native single-line
 * ellipsis. Prevents wasting frames on characters clipped past a phone screen.
 */
export const STREAM_MAX_VISIBLE_CHARS = 48;
/** Minimum interval between rendered stream ticks (~60fps cap). */
export const STREAM_FRAME_INTERVAL_MS = 16;

export interface InkTrailSegment {
  readonly text: string;
  /** Smoothly ramped opacity in `[0.14, 1]`. */
  readonly opacity: number;
  /** Leading edge highlight tier: `2` = brightest edge, `1` = mid fade, `0` = settled. */
  readonly highlight: 0 | 1 | 2;
}

export interface RowStreamProgress {
  readonly labelProgress: number;
  readonly summaryProgress: number;
  readonly showSeparator: boolean;
  readonly showStat: boolean;
  readonly totalChars: number;
}

/**
 * Compute the character-streaming duration for a line at standard pace.
 *
 * CJK and other non-ASCII glyphs carry higher visual density so they get a
 * slightly slower rhythm than ASCII paths/flags; total duration stays clamped
 * within `[420, 760]` ms so short lines feel deliberate and long lines stay crisp.
 */
export function calcStreamDurationMs(text: string): number {
  if (text.length === 0) return 0;
  let units = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    units += cp > 127 ? 1.45 : 0.65;
  }
  return Math.round(
    Math.max(STREAM_MIN_DURATION_MS, Math.min(STREAM_MAX_DURATION_MS, units * 21)),
  );
}

/**
 * Compute the floating-point character cursor at `elapsedMs` past the lead-in.
 *
 * Uses a mostly uniform reading cadence (`82%` linear + `18%` gentle ease-out)
 * followed by a tail-settle tail so the final characters fade all the way to 1.
 */
export function streamCursorAt(
  elapsedMs: number,
  streamMs: number,
  totalChars: number,
  tailSettleMs = STREAM_TAIL_SETTLE_MS,
  trailWidth = STREAM_TRAIL_WIDTH,
): number {
  if (totalChars <= 0) return Number.POSITIVE_INFINITY;
  if (elapsedMs < 0) return 0;
  const rawP = streamMs <= 0 ? 1 : Math.min(1, elapsedMs / streamMs);
  const easedP = 0.82 * rawP + 0.18 * (1 - (1 - rawP) * (1 - rawP));
  const tailExtra =
    elapsedMs > streamMs && tailSettleMs > 0
      ? Math.min(trailWidth + 0.5, ((elapsedMs - streamMs) / tailSettleMs) * (trailWidth + 0.5))
      : elapsedMs > streamMs
        ? trailWidth + 0.5
        : 0;
  return easedP * totalChars + tailExtra;
}

/**
 * Split `text` into a settled prefix plus trailing per-character ink-fade
 * segments at the current floating-point `progressChars` cursor.
 *
 * Splits by Unicode code points (`Array.from`) so surrogate pairs and emoji
 * are never torn in half. Once `progressChars >= chars.length + trailWidth`,
 * returns a single settled segment with the full text.
 */
export function buildInkTrailSegments(
  text: string,
  progressChars: number,
  trailWidth = STREAM_TRAIL_WIDTH,
  settledFloor = 0,
): InkTrailSegment[] {
  if (text.length === 0 || progressChars <= 0) return [];
  if (!Number.isFinite(progressChars)) {
    return [{ text, opacity: 1, highlight: 0 }];
  }
  const chars = Array.from(text);
  const len = chars.length;
  if (progressChars >= len + trailWidth) {
    return [{ text, opacity: 1, highlight: 0 }];
  }

  const headEnd = Math.min(len, Math.ceil(progressChars));
  const floorEnd = Number.isFinite(settledFloor) ? Math.max(0, Math.floor(settledFloor)) : 0;
  const settledEnd = Math.min(
    headEnd,
    Math.max(floorEnd, Math.floor(progressChars - trailWidth)),
  );
  const segments: InkTrailSegment[] = [];

  if (settledEnd > 0) {
    segments.push({
      text: chars.slice(0, settledEnd).join(""),
      opacity: 1,
      highlight: 0,
    });
  }

  for (let i = settledEnd; i < headEnd; i += 1) {
    const age = progressChars - i;
    const t = Math.max(0, Math.min(1, age / trailWidth));
    const smooth = t * t * (3 - 2 * t);
    const alpha = 0.14 + 0.86 * smooth;
    const highlight: 0 | 1 | 2 = t < 0.5 ? 2 : t < 0.8 ? 1 : 0;
    segments.push({
      text: chars[i],
      opacity: Number(alpha.toFixed(3)),
      highlight,
    });
  }

  return segments;
}

/**
 * Derive label & summary cursors and separator/stat visibility for one row.
 *
 * Streaming starts from the left action label ("运行命令" / "思考") and flows
 * continuously into the summary. Once the visible summary budget has settled,
 * `summaryProgress` switches to `Infinity` so the complete original summary
 * renders natively (preserving `numberOfLines={1}` truncation).
 */
export function splitRowStreamProgress(
  label: string,
  summary: string,
  cursor: number,
  streamSummary = true,
  maxSummaryChars = STREAM_MAX_VISIBLE_CHARS,
  trailWidth = STREAM_TRAIL_WIDTH,
): RowStreamProgress {
  const labelLen = Array.from(label).length;
  const rawSummaryLen = streamSummary ? Array.from(summary).length : 0;
  const effectiveSummaryLen = Math.min(rawSummaryLen, maxSummaryChars);
  const totalChars = labelLen + effectiveSummaryLen;

  if (!Number.isFinite(cursor)) {
    return {
      labelProgress: Number.POSITIVE_INFINITY,
      summaryProgress: Number.POSITIVE_INFINITY,
      showSeparator: true,
      showStat: true,
      totalChars,
    };
  }

  const labelProgress = cursor;
  const rawSummaryProgress = cursor - labelLen;
  const summaryProgress = !streamSummary
    ? Number.POSITIVE_INFINITY
    : rawSummaryProgress >= effectiveSummaryLen + trailWidth
      ? Number.POSITIVE_INFINITY
      : rawSummaryProgress;

  return {
    labelProgress,
    summaryProgress,
    showSeparator: !streamSummary ? cursor >= labelLen - 0.2 : rawSummaryProgress > -0.2,
    showStat: totalChars === 0 || cursor >= totalChars * 0.88,
    totalChars,
  };
}
