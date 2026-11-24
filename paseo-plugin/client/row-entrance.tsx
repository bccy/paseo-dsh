/**
 * Subtle one-shot entrance motion for live timeline rows, plus the shared
 * `overscroll-behavior: contain` hook for expanded scroll regions on Web.
 *
 * Live rows fade and lift in (`opacity: 0 -> 1`, `translateY: 5px -> 0`,
 * 220ms ease-out). Replayed history and virtual-list scroll-backs render
 * immediately with no animation (`shouldEnterLive` in `./newest`).
 *
 * Platform split:
 * - **Web**: injects one `<style id="dsh-paseo-row-entrance">` sheet using
 *   `[data-testid]` selectors (matching `./shimmer-css`), honoring
 *   `prefers-reduced-motion: reduce`.
 * - **Native**: runs a single `Animated.parallel` timing on the native driver
 *   and stops it on unmount.
 * - **Offline harnesses**: safely guards `Platform` / `Animated` / `Easing`
 *   with optional chaining so minimal `react-native` stubs never throw.
 *
 * @module dsh-paseo/client/row-entrance
 */
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, Text, View } from "react-native";
import { markRowAnimated, normalizeRowTimestamp, shouldEnterLive } from "./newest";
import {
  STREAM_FRAME_INTERVAL_MS,
  STREAM_LEAD_DELAY_MS,
  STREAM_MAX_VISIBLE_CHARS,
  STREAM_TAIL_SETTLE_MS,
  STREAM_TRAIL_WIDTH,
  buildInkTrailSegments,
  calcStreamDurationMs,
  splitRowStreamProgress,
  streamCursorAt,
} from "./stream-reveal";

/** `testID` hook that triggers the CSS entrance animation on Web. */
export const ROW_ENTER_TEST_ID = "dsh-row-enter";
/** `testID` hook that enables `overscroll-behavior: contain` on Web scroll boxes. */
export const SCROLL_BOX_TEST_ID = "dsh-scroll-box";

/**
 * Whether a tap inside an expanded scroll/body region should collapse the row.
 *
 * Skips collapsing on Web when the user just finished dragging a text selection
 * or clicked an interactive anchor/button (`<a>` / `<button>`). On Native,
 * scroll drags and long-press selection do not fire `onPress`, and child
 * controls stop propagation, so short taps collapse cleanly.
 */
export function shouldCollapseOnBodyPress(event?: unknown): boolean {
  const win = (globalThis as {
    window?: { getSelection?: () => { toString(): string } | null };
  }).window;
  if (typeof win?.getSelection === "function") {
    const selected = win.getSelection()?.toString() ?? "";
    if (selected.length > 0) return false;
  }
  const target = (event as {
    target?: { closest?: (selector: string) => unknown };
  } | null | undefined)?.target;
  if (typeof target?.closest === "function" && target.closest("a, button") !== null) {
    return false;
  }
  return true;
}

const STYLE_ID = "dsh-paseo-row-entrance";
const ENTRANCE_DURATION_MS = 220;
const ENTRANCE_OFFSET_Y = 5;

/** Minimal DOM surface to inject one stylesheet without pulling in the DOM lib. */
interface WebStyleElement {
  id: string;
  textContent: string;
}
interface WebDocument {
  getElementById(id: string): unknown;
  createElement(tag: string): WebStyleElement;
  head: { appendChild(node: WebStyleElement): void } | null;
}

const ROW_ENTRANCE_CSS = `
[data-testid="${ROW_ENTER_TEST_ID}"] {
  animation: dsh-row-enter ${ENTRANCE_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
  will-change: opacity, transform;
}

@keyframes dsh-row-enter {
  from {
    opacity: 0;
    transform: translateY(${ENTRANCE_OFFSET_Y}px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

[data-testid="${SCROLL_BOX_TEST_ID}"] {
  overscroll-behavior: contain;
}

@media (prefers-reduced-motion: reduce) {
  [data-testid="${ROW_ENTER_TEST_ID}"] {
    animation: none !important;
    will-change: auto !important;
  }
}
`;

function isWebPlatform(): boolean {
  return Platform?.OS === "web";
}

function webDocument(): WebDocument | null {
  return (globalThis as { document?: WebDocument }).document ?? null;
}

/** Inject the entrance & scroll-containment stylesheet once. No-op off Web. */
export function ensureRowEntranceStyles(): void {
  if (!isWebPlatform()) return;
  const doc = webDocument();
  if (doc === null || doc.head === null || doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = ROW_ENTRANCE_CSS;
  doc.head.appendChild(style);
}

export interface RowEntranceProps {
  agentId?: string;
  timestamp?: Date | string | number;
  rowKey?: string;
  liveHint?: boolean;
  children: ReactNode;
}

/**
 * Wrap a timeline row so live arrivals enter smoothly once, while replayed or
 * recycled rows render statically.
 */
export function RowEntrance({
  agentId,
  timestamp,
  rowKey,
  liveHint,
  children,
}: RowEntranceProps): ReactElement {
  const at = normalizeRowTimestamp(timestamp);
  // Evaluated once on mount so later re-renders of the same row never replay
  // the entrance motion. `shouldEnterLive` is strictly read-only, so React 18
  // StrictMode double-invocations observe the same answer.
  const [animate] = useState(() =>
    shouldEnterLive(
      agentId ?? "",
      at,
      liveHint ?? false,
      rowKey,
    ),
  );

  // Record the row after commit regardless of whether it animated so scrolled-
  // out history rows never animate when virtualized back into view.
  useEffect(() => {
    if (agentId !== undefined && agentId !== "") {
      markRowAnimated(agentId, at, rowKey);
    }
  }, [agentId, at, rowKey]);

  const web = isWebPlatform();
  const canNativeAnimate =
    !web &&
    animate &&
    typeof Animated?.View !== "undefined" &&
    typeof Animated?.Value === "function" &&
    typeof Animated?.timing === "function" &&
    typeof Animated?.parallel === "function";

  const valuesRef = useRef<{
    opacity: InstanceType<typeof Animated.Value>;
    translateY: InstanceType<typeof Animated.Value>;
  } | null>(null);

  if (canNativeAnimate && valuesRef.current === null) {
    valuesRef.current = {
      opacity: new Animated.Value(0),
      translateY: new Animated.Value(ENTRANCE_OFFSET_Y),
    };
  }

  useEffect(() => {
    if (web) {
      ensureRowEntranceStyles();
      return;
    }
    if (!canNativeAnimate || valuesRef.current === null) return;
    const { opacity, translateY } = valuesRef.current;
    const easing =
      typeof Easing?.out === "function" && Easing?.cubic ? Easing.out(Easing.cubic) : undefined;
    const timingBase = {
      duration: ENTRANCE_DURATION_MS,
      useNativeDriver: true,
      ...(easing !== undefined ? { easing } : {}),
    };
    const anim = Animated.parallel(
      [
        Animated.timing(opacity, { ...timingBase, toValue: 1 }),
        Animated.timing(translateY, { ...timingBase, toValue: 0 }),
      ],
      { stopTogether: true },
    );
    anim.start();
    return () => {
      anim.stop();
    };
  }, []);

  if (web) {
    return animate ? <View testID={ROW_ENTER_TEST_ID}>{children}</View> : <View>{children}</View>;
  }

  if (canNativeAnimate && valuesRef.current !== null) {
    const AnimatedView = Animated.View;
    return (
      <AnimatedView
        style={{
          opacity: valuesRef.current.opacity,
          transform: [{ translateY: valuesRef.current.translateY }],
        }}
      >
        {children}
      </AnimatedView>
    );
  }

  return <View>{children}</View>;
}

/* -------------------------------------------------------------------------- */
/* Ink-trail character streaming (Plan A: soft trailing fade)                 */
/* -------------------------------------------------------------------------- */

function prefersReducedMotion(): boolean {
  const win = (globalThis as {
    window?: { matchMedia?: (query: string) => { matches?: boolean } | null };
  }).window;
  try {
    return win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

export interface InkStreamOptions {
  agentId?: string;
  timestamp?: Date | string | number;
  rowKey?: string;
  liveHint?: boolean;
  label: string;
  summary: string;
  /** When false, only the left action label streams while summary renders live as-is. */
  streamSummary?: boolean;
  /** When false, bypasses entrance/rAF timers completely (e.g. non-classic thinking styles). */
  enabled?: boolean;
}

export interface InkStreamState {
  readonly active: boolean;
  readonly labelProgress: number;
  readonly summaryProgress: number;
  readonly showSeparator: boolean;
  readonly showStat: boolean;
}

/**
 * One-shot character-by-character "ink fade trail" stream for live timeline rows.
 *
 * Replayed history, bulk-load bursts, scroll-back remounts, and reduced-motion
 * sessions immediately return settled progress (`Infinity`) and schedule zero
 * timers or animation frames.
 */
export function useInkStreamReveal({
  agentId,
  timestamp,
  rowKey,
  liveHint,
  label,
  summary,
  streamSummary = true,
  enabled = true,
}: InkStreamOptions): InkStreamState {
  const at = normalizeRowTimestamp(timestamp);
  const [animate] = useState(
    () =>
      enabled &&
      !prefersReducedMotion() &&
      shouldEnterLive(agentId ?? "", at, liveHint ?? false, rowKey),
  );
  const [cursor, setCursor] = useState<number>(() =>
    animate ? 0 : Number.POSITIVE_INFINITY,
  );
  const targetRef = useRef({ label, summary, streamSummary });
  targetRef.current = { label, summary, streamSummary };

  useEffect(() => {
    if (!animate || !enabled) return;
    let cancelled = false;
    let rafId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const startAt = nowMs() + STREAM_LEAD_DELAY_MS;
    let lastEmitAt = 0;

    const raf = (globalThis as {
      requestAnimationFrame?: (cb: (t: number) => void) => number;
    }).requestAnimationFrame;
    const cancelRaf = (globalThis as {
      cancelAnimationFrame?: (id: number) => void;
    }).cancelAnimationFrame;

    const scheduleNext = (fn: () => void): void => {
      if (typeof raf === "function") {
        rafId = raf(fn);
      } else {
        timerId = setTimeout(fn, STREAM_FRAME_INTERVAL_MS);
      }
    };

    const tick = (): void => {
      if (cancelled) return;
      const now = nowMs();
      const elapsed = now - startAt;
      if (elapsed < 0) {
        scheduleNext(tick);
        return;
      }

      const current = targetRef.current;
      const labelChars = Array.from(current.label);
      const summaryChars = current.streamSummary
        ? Array.from(current.summary).slice(0, STREAM_MAX_VISIBLE_CHARS)
        : [];
      const totalChars = labelChars.length + summaryChars.length;
      if (totalChars === 0) {
        setCursor(Number.POSITIVE_INFINITY);
        return;
      }

      const streamMs = calcStreamDurationMs(
        labelChars.join("") + summaryChars.join(""),
      );
      if (elapsed >= streamMs + STREAM_TAIL_SETTLE_MS) {
        setCursor(Number.POSITIVE_INFINITY);
        return;
      }

      if (lastEmitAt === 0 || now - lastEmitAt >= STREAM_FRAME_INTERVAL_MS) {
        lastEmitAt = now;
        setCursor(
          streamCursorAt(
            elapsed,
            streamMs,
            totalChars,
            STREAM_TAIL_SETTLE_MS,
            STREAM_TRAIL_WIDTH,
          ),
        );
      }
      scheduleNext(tick);
    };

    scheduleNext(tick);

    return () => {
      cancelled = true;
      if (rafId !== null && typeof cancelRaf === "function") cancelRaf(rafId);
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [animate, enabled]);

  const effectiveCursor = enabled ? cursor : Number.POSITIVE_INFINITY;
  const split = splitRowStreamProgress(label, summary, effectiveCursor, streamSummary);
  return {
    active: Number.isFinite(effectiveCursor),
    labelProgress: split.labelProgress,
    summaryProgress: split.summaryProgress,
    showSeparator: split.showSeparator,
    showStat: split.showStat,
  };
}

/**
 * Render `text` with a soft 5–6 character fade-in trail while `progress` is
 * finite, or return the plain `text` string once settled.
 *
 * Uses nested `<Text>` spans so the effect is 100% identical on iOS React
 * Native and Web, with zero hardcoded colours (highlights with the theme's
 * `highlightColor`, or preserves `overrideColor` when painted inside a shimmer).
 */
export function renderInkTrailText(
  text: string,
  progress: number,
  highlightColor: string,
  overrideColor: string | null,
): ReactNode {
  if (!Number.isFinite(progress)) return text;
  const segments = buildInkTrailSegments(text, progress);
  if (segments.length === 0) return "";
  if (
    segments.length === 1 &&
    segments[0].opacity >= 1 &&
    segments[0].highlight === 0
  ) {
    return segments[0].text;
  }
  return segments.map((seg, idx) => {
    if (seg.opacity >= 1 && seg.highlight === 0) {
      return seg.text;
    }
    const segOpacity =
      seg.highlight === 1
        ? Number((seg.opacity * 0.88).toFixed(3))
        : seg.opacity;
    const segColor =
      overrideColor !== null
        ? overrideColor
        : seg.highlight > 0
          ? highlightColor
          : undefined;
    return (
      <Text
        key={idx}
        style={
          segColor !== undefined
            ? { opacity: segOpacity, color: segColor }
            : { opacity: segOpacity }
        }
      >
        {seg.text}
      </Text>
    );
  });
}
