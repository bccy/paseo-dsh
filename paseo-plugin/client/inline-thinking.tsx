/**
 * Inline reasoning row for the Paseo timeline, shaped like dsh web's.
 *
 * dsh web shows a thought as one line: a small label and the current line of
 * the thought together, scrolling while the model thinks, expanding to the
 * full text only when clicked. Paseo's stock reasoning row is a collapsed
 * tool-like row labelled "Thinking".
 *
 * The host's transformer `phase` is not a reliable "still streaming" signal:
 * a thought is `streaming` only while its render-model status is `loading`, so
 * it flips back and forth as chunks settle and would make this row open and
 * close repeatedly. Instead the row watches the text itself grow: while it grows
 * the row stays in its scrolling state, and it settles once the text has stopped
 * arriving and `complete` has held for a short window (`useGrowing`).
 *
 * The text is used **as it arrives**, never through the host's paced reveal
 * (`useRevealedText`). That hook re-plays the reasoning at a rate it owns — its
 * signature takes no speed — so the collapsed preview trailed the expanded one,
 * which always read the raw text. dsh web applies the same preview rule to the
 * live text; this row now does too.
 *
 * @module dsh-paseo/client/inline-thinking
 */
import { useSettings, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from "react-native";
import {
  EXPANDED_MAX_HEIGHT_DEFAULT,
  TIMELINE_STYLE_DEFAULTS,
  timelineStyleSettings,
} from "../shared/settings";
import { normalizeRowTimestamp, noteRender, useIsPulseOwner } from "./newest";
import {
  RowEntrance,
  SCROLL_BOX_TEST_ID,
  renderInkTrailText,
  shouldCollapseOnBodyPress,
  useInkStreamReveal,
} from "./row-entrance";
import { RowStatusIcon, resolveThinkingIconStatus } from "./row-status-icon";
import { TextShimmer } from "./text-shimmer";
import { currentLocale } from "./locale";
import {
  EAGER_FULL_TRANSLATE_MAX_CHARS,
  prefetchThinkingTranslation,
  useStreamingTranslatedThinking,
  useTranslatedThinking,
} from "./thinking-translate";
import { isPreviewReadyForTranslation } from "../shared/translate-text";
import {
  EXPANDED_BLOOM_WAVE_WIDTH,
  MARQUEE_LEFT_FADE_PX,
  MARQUEE_RIGHT_FADE_PX,
  advanceExpandedInkCursor,
  advanceLeftScrollCursor,
  advanceSmoothPixelOffset,
  buildExpandedBloomSegments,
  buildHermiteEdgeFadeAlphas,
  buildSmoothMarqueeMask,
  computeSmoothMarqueeDurationMs,
  countCodePoints,
  findSettledBodySplit,
  formatThinkingDuration,
  normalizeLeftScrollStream,
  reasoningPreview,
  splitNativeMarqueeChunks,
  streamingTail,
} from "./thinking-text";
import { STREAM_FRAME_INTERVAL_MS } from "./stream-reveal";
import { BODY_INDENT, ROW_FONT_SIZE, ROW_GAP, ROW_LINE_HEIGHT, withAlpha } from "./tokens";
import { useLocaleText } from "./use-locale";

/**
 * DSH's thinking icon (`PROCESS_ICONS.thinking` = `IconThinkOutlineRegular`:
 * two petals crossed on the diagonal plus a filled centre dot, `viewBox 16`,
 * 1px stroke, drawn at 16). Rasterized at exactly 4x and shown at 16 so the
 * stroke lands on whole pixels; `tintColor` replaces `currentColor`.
 */
const THINK_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAIVUlEQVR4nOxbe5COVRh/JCnjUkREucWEyCSFmtKs2RQ2urikxpZmkqaZYlaUqVQyUVNRqZFGUaJdy5CIbrpglEs2xnXEooTUZlUq/X7e85l3n+/9vnPOu+qPvv3NPHP2Pec8l/N85z3nOc959xTJcJwiGY4KB0iGo8IBkuGocIBkOE6VcuLYsWMXo2gPagg6CDoA2lupUqXP5SQCeq5E0QBUB1QbtBu0Bnq+kXKgksQAjMlC8SSoU5puh0CFoAIY+Z7E09MLxU2gPqCaabquAI2Enk/FE14OgEG1UDwPyhU/7Ae9CJoII3+y6OAvfB/oXtDZ4mEe6DVQHnT87Mrk7AAYVh/FagmmYVz8BpoKmgAjv1Pym6EYDroTdLrEB1+NDpD/g0tnHwcsRHFdRNM2CRzDsr4hvhpnWkS+BHrU2MDX6W5Lf86claDvQXtALUAdQM0i+i6AA3qJA5wcgMEPQTFZVS8BDYei9Sl4uE7w3e0LqivROGLKM1K0/wiaBSqEno9S6GmH4llQN9V0F3imigWuDtiBonGoKh/Cb3HkrYriNtADoDbihiLQC6Dp0PO7CwP0zJHA4QlsBW8LG5/VAebd3xuqKgVdAOF7xROQda0EM6lpii58jYZC9gfiL5vb8BYpO5vqQtb+dHwugVBX9bw85uC5JnB1b5qmW3PQPehbUzwBm7j4rVLVV9v4XBygV/014gkM6AoUG0A9VNPfhsLoDSoyPL7QttW3Mbg4oFQ9/yoewED6oVgmyY7cKcEqTtqt2s4jD3hvFT9o247YGOI4oKE4AgNgMDMzQs9SUFtM27Uk/m3qtG0zzA7kCm1bqY0hjgPOFQfA8McliP7CCy2nO/f+bAz8l0SliQ6zQY9J2VeCvJMha7S4QdtmdYDLLsCtqyhUtQ8Gn2PheUaCqE6jD3jnWngZ++dHNDF6HGHh5YpfJ1TVEjxb0vFYZwAEfItiX6iqHhRdLqmNGCXJgy8BdbYN3ugrQHEN6LBqyoPskZJaL0+L4cEX2wZPuOYD3lfPN0i0EYNQPKWqGc11gjErxBHo+wkKDmifahoHHQNTsGmbFokDXB2wRD3frjvAMG5f01Q1B89ffoN4wiyO3Aq1E7gw5kSw9FfPTsGUqwMWq+dGMOJEKIy/u0pw9g+DW1I3DGSbxAR4t0qwOOrtbZ6Z8gn9HHwj1edDcYCTA0w4+baqvt8o58qrB89jb3Z5szVG9zoU3UF/qKb5JvwlRqm2GeA7KA7wyQlOUM9dYACDGC5s4aPvX6AcGLBcThIg6wsUNxvZCVDnHBMxtlMs48URvhkhGtIlVMWkRmPVbRgMfk7ssngmYGj8J2ipme42njxJHlyxlJ3+yyDLegZIwNcBfO9np+kyH8pzxC4nF8UroKqmikfeIeCd5sDLHal7mi7WWCMM76QoDOA72S6iibOhDZQftvDzl98syRnpo6ALwb/dws+8JHeIJhHNX4G/o3ggzr3A4Ig6TuNetsEbMIiKSsdXAV1m4RWT8OSer0+RTIreIZ6I44ADEcopp6r8d6gmwYDD4LNzNjiBOA6YEsHH57mYnrUd+Lk/l0TUl4jD3m108B2vHGHDy+IJLwdA+VUoslI0c0/Ot8nAFGZ0OFSChS8B/j3UtKXTzzWLZ4VUh7Ge6HOpeMB3F1ggZbM6OyR5MXoEA3lC7LKYzmaUx/VgoW3xMzxjKF9V6614HmT1Fkf43Asww7pJ8fBekBFiONvL9aE3jJgvJxHQz0BottLPMwazRmvDXSXYTTY7iPV6BR5Wyj82oS69Xapk5sfM6UUCsng8nqn0U2eOCZU/C9WzzwhxhJMDYADv6Aap6knHtQURXF/VdhpoEfjaSzkBGZeg4Kunt84bQwetSaptsLljtMJ1BmSr5z1QfuIAZG5/dQKzugROaCYxYXh5rq+mmvpB5+KQ/ncluC4Lo5s4IK4D3tIdYASnqE5gcrVejoFcJJ4AT2sJrr31tVoudEWF49qmbHGAqwOuV88LozrBsFcleZWuB/oSA+oijkBfXq5GDX40dLyRgk1ngHqKA+IkRUtgRE0LD09seRFNObbdwWSWCiOaxoP3QQsvg6nqoSruBpvS8bjMgNbqeZ2NwWRvoxxQCCMfiuJhkAPi7CmIaB5pG7yBvqluZWNwcUB19bzTgYdOYGqcO0f43MDwdSy/NQjf/+HvsyTI4Y1RNjEBMhCynhY37JL0tifB5SOpGurZyQEEDH8Tg+Phib9q+LDEDy3Wo62HsYHbnL7VYVqtJ2Q45fZS2FbDxuAyA7QQr1Of2SK5qGnjzpcggvtakgfPvh09Bx9lm3UGuDigWD23FU+kuf+rHGEDMz68NywSf2jbim0MLrsAt6Jwbp6Zm+YwcJd4ArKaSPCup/pyg/F7FmRbDY+QzUwTV/wqoepa4TvIKLhcjfGIujFURQUTxREwrDK/9zOfsHCA6T5baQnajr4FXB/IK+6YImUHv842eML1GyFeR81Q1Yz8eIY/lIKHeQOmrnhOSHuZmgb8Ioxh7tw0H0kxPc5EyADV1B88s8QCn+PwPBQ5EQYy/884nI7gYub6mRyzOowXOAt552D7rC38mdxuI5/6Okuyg50/4vJxAE+EDIKcvg9Ig3ckuOpereQzmztMku/4fMEfox3kH3Dp7JwPMNdjjAqniT/IOxbUAHIG6MEb+avYJsGvOk6C5KsvXqeNroM/rldiwFyGTpfkC8kEeI/Hwwz3cb67K2HUUfHTwQWNKfQsQ3ytqqTozrRYrrlW90IsByRgtjV+2saVnaEtP6bYDkM2yr8A6Gtl9PGAxhT4ZqNvh8REuRzwf0DFv8xIhqPCAZLhqHCAZDgy3gH/AAAA//8ppP2oAAAABklEQVQDAGWdwCsoF2nyAAAAAElFTkSuQmCC";

/** The row icon is drawn at 16, matching every other row head. */
const THINK_ICON_SIZE = 16;

export interface InlineThinkingData {
  text: string;
  phase: "streaming" | "complete";
}



/**
 * How long `complete` has to hold before the row stops scrolling.
 *
 * `phase` is derived from a per-item status that flips between loading and
 * ready as chunks settle (`docs/FIELD-NOTES.md` #26), so a **single** complete
 * frame is not proof the thought is over: settling on it makes the sweep stop
 * and restart while the model is still thinking. A short stable window is the
 * middle ground — a further frame clears it, and once the text really has
 * stopped the timer itself settles the row, without needing one more host
 * update (which is the defect this replaced: the effect deps only change when
 * text or phase changes, so a `grew && complete` last frame latched the row on
 * forever).
 */
const SETTLE_WINDOW_MS = 300;

/**
 * Track "still producing text" without trusting the flickering `phase`.
 *
 * Any growth latches the row on. It settles when the text stopped growing and
 * `complete` has held for {@link SETTLE_WINDOW_MS}; every new frame re-runs the
 * effect, which cancels the pending settle and demands the window again.
 */
interface GrowingState {
  identity: string | undefined;
  hostId: string;
  agentId: string | undefined;
  rowAt: number;
  text: string;
  growing: boolean;
  lastActivityAt: number;
}

interface GrowingResult {
  growing: boolean;
  lastActivityAt: number;
  continuedKeyShift: boolean;
}

/**
 * Distinguish a host merge-timestamp advance on the *same* live thought from a
 * virtual-list in-place recycle onto a different row.
 *
 * Paseo's timeline projection can overwrite a merged row's `timestamp` with the
 * latest chunk's record time (`docs/FIELD-NOTES.md` #26 / `client/newest.ts`).
 * When that happens mid-stream, on the final `complete` frame, or after a brief
 * >300ms pause that already settled the previous key, the same mounted
 * component sees a newer timestamp for the same host/agent with monotonic
 * prefix growth and an unseen key — carry the timer forward instead of
 * resetting to 0 or dropping the duration.
 */
function isSameThoughtKeyShift(
  prev: {
    identity: string | undefined;
    hostId: string;
    agentId: string | undefined;
    rowAt: number;
    text: string;
    growing: boolean;
  },
  next: {
    identity: string | undefined;
    hostId: string;
    agentId: string | undefined;
    rowAt: number;
    text: string;
    phase: "streaming" | "complete";
  },
): boolean {
  if (prev.identity === next.identity) return false;
  const prevTracked =
    prev.growing || (prev.identity !== undefined && durationRecords.has(prev.identity));
  if (!prevTracked) return false;
  if (prev.hostId !== next.hostId) return false;
  if (prev.agentId !== next.agentId) return false;
  if (next.rowAt < prev.rowAt) return false;
  if (next.identity !== undefined && durationRecords.has(next.identity)) return false;
  if (prev.growing) {
    return prev.text.length > 0 ? next.text.startsWith(prev.text) : next.phase === "streaming";
  }
  if (prev.text.length > 0) {
    return (
      next.text.startsWith(prev.text) &&
      (next.text.length > prev.text.length || next.phase === "streaming")
    );
  }
  return next.phase === "streaming";
}

function useGrowing(
  text: string,
  phase: "streaming" | "complete",
  rowIdentity: string | undefined,
  hostId: string,
  agentId: string | undefined,
  rowAt: number,
): GrowingResult {
  const [state, setState] = useState<GrowingState>(() => ({
    identity: rowIdentity,
    hostId,
    agentId,
    rowAt,
    text,
    growing: phase === "streaming",
    lastActivityAt: Date.now(),
  }));
  const prevIdentity = useRef<string | undefined>(rowIdentity);
  const prevHostId = useRef<string>(hostId);
  const prevAgentId = useRef<string | undefined>(agentId);
  const prevRowAt = useRef<number>(rowAt);
  const prevText = useRef<string>(text);
  const prevPhase = useRef<"streaming" | "complete">(phase);
  const prevGrowing = useRef<boolean>(phase === "streaming");
  const lastActivityAtRef = useRef<number>(state.lastActivityAt);

  const continuedKeyShift = isSameThoughtKeyShift(state, {
    identity: rowIdentity,
    hostId,
    agentId,
    rowAt,
    text,
    phase,
  });

  useEffect(() => {
    const switched = prevIdentity.current !== rowIdentity;
    const isContinuation =
      switched &&
      isSameThoughtKeyShift(
        {
          identity: prevIdentity.current,
          hostId: prevHostId.current,
          agentId: prevAgentId.current,
          rowAt: prevRowAt.current,
          text: prevText.current,
          growing: prevGrowing.current,
        },
        { identity: rowIdentity, hostId, agentId, rowAt, text, phase },
      );

    if (switched && !isContinuation) {
      const now = Date.now();
      prevIdentity.current = rowIdentity;
      prevHostId.current = hostId;
      prevAgentId.current = agentId;
      prevRowAt.current = rowAt;
      prevText.current = text;
      prevPhase.current = phase;
      prevGrowing.current = phase === "streaming";
      lastActivityAtRef.current = now;
      setState({
        identity: rowIdentity,
        hostId,
        agentId,
        rowAt,
        text,
        growing: phase === "streaming",
        lastActivityAt: now,
      });
      return;
    }

    const grew = text.length > prevText.current.length;
    const becameComplete = prevPhase.current === "streaming" && phase === "complete";
    const nextActivityAt =
      phase === "streaming" || grew || becameComplete ? Date.now() : lastActivityAtRef.current;

    prevIdentity.current = rowIdentity;
    prevHostId.current = hostId;
    prevAgentId.current = agentId;
    prevRowAt.current = rowAt;
    prevText.current = text;
    prevPhase.current = phase;
    lastActivityAtRef.current = nextActivityAt;

    const nextGrowing = grew || phase === "streaming" ? true : prevGrowing.current;
    prevGrowing.current = nextGrowing;

    setState((prev) =>
      prev.identity === rowIdentity &&
      prev.hostId === hostId &&
      prev.agentId === agentId &&
      prev.rowAt === rowAt &&
      prev.text === text &&
      prev.growing === nextGrowing &&
      prev.lastActivityAt === nextActivityAt
        ? prev
        : {
            identity: rowIdentity,
            hostId,
            agentId,
            rowAt,
            text,
            growing: nextGrowing,
            lastActivityAt: nextActivityAt,
          },
    );

    if (phase !== "complete") return;
    const timer = setTimeout(() => {
      prevGrowing.current = false;
      setState((prev) =>
        prev.identity === rowIdentity && !prev.growing ? prev : { ...prev, growing: false },
      );
    }, SETTLE_WINDOW_MS);
    // Runs on unmount and before the next frame's effect, so a timer never
    // outlives the row and a stream that continues never settles.
    return () => clearTimeout(timer);
  }, [text, phase, rowIdentity, hostId, agentId, rowAt]);

  const sameOrContinued = state.identity === rowIdentity || continuedKeyShift;
  const resumedOnRender =
    sameOrContinued &&
    !state.growing &&
    (phase === "streaming" || text.length > state.text.length);
  return {
    growing: sameOrContinued ? state.growing || resumedOnRender : phase === "streaming",
    lastActivityAt:
      sameOrContinued && !resumedOnRender ? state.lastActivityAt : Date.now(),
    continuedKeyShift,
  };
}

const useCommitLayoutEffect =
  typeof useLayoutEffect === "function" ? useLayoutEffect : useEffect;

/** Maximum trailing characters kept in Native fallback / Web marquee text node. */
const LEFT_SCROLL_DOM_WINDOW_CHARS = 180;
const WEB_MARQUEE_MAX_CHARS = 4000;
const NATIVE_LEFT_FADE_ALPHAS = buildHermiteEdgeFadeAlphas(16, "left");
const NATIVE_RIGHT_FADE_ALPHAS = buildHermiteEdgeFadeAlphas(14, "right");

interface WebMarqueeDomNode {
  clientWidth?: number;
  scrollWidth?: number;
  style?: {
    width?: string;
    transform?: string;
    maskImage?: string;
    webkitMaskImage?: string;
  };
}

interface WebMarqueeSlot {
  outer: WebMarqueeDomNode | null;
  clip: WebMarqueeDomNode | null;
  inner: WebMarqueeDomNode | null;
}

interface SmoothMarqueeController {
  readonly text: string;
  readonly active: boolean;
  readonly lineWidth: number;
  readonly register: (slot: WebMarqueeSlot) => () => void;
}

function setDomMask(node: WebMarqueeDomNode, mask: string): void {
  if (!node.style) return;
  if ((node.style.maskImage ?? "") !== mask) {
    node.style.maskImage = mask;
    node.style.webkitMaskImage = mask;
  }
}

/**
 * Drives 60/120fps sub-pixel GPU `translate3d` leftward marquee scrolling on
 * Web/Safari with ZERO React re-renders per frame. Both layers rendered by
 * `TextShimmer` register their DOM refs here and stay sub-pixel synchronized.
 */
function useSmoothWebMarquee(
  source: string,
  active: boolean,
  keepAlive: boolean,
  lineWidth: number,
  resetKey: string | number,
): SmoothMarqueeController {
  const isWeb =
    Platform?.OS === "web" &&
    typeof globalThis.requestAnimationFrame === "function" &&
    typeof globalThis.cancelAnimationFrame === "function";
  const normalized = isWeb && keepAlive ? normalizeLeftScrollStream(source) : "";
  const text =
    normalized.length > WEB_MARQUEE_MAX_CHARS
      ? normalized.slice(normalized.length - WEB_MARQUEE_MAX_CHARS)
      : normalized;

  const slotsRef = useRef<Set<WebMarqueeSlot>>(new Set());
  const revealedPxRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const lineWidthRef = useRef<number>(lineWidth);
  lineWidthRef.current = lineWidth;
  const activeRef = useRef<boolean>(isWeb && active && text !== "");
  const prevResetKeyRef = useRef<string | number>(resetKey);
  const prevKeepAliveRef = useRef<boolean>(keepAlive);

  if (prevResetKeyRef.current !== resetKey || (!keepAlive && prevKeepAliveRef.current)) {
    prevResetKeyRef.current = resetKey;
    prevKeepAliveRef.current = keepAlive;
    revealedPxRef.current = 0;
    lastFrameRef.current = 0;
  } else {
    prevKeepAliveRef.current = keepAlive;
  }

  const effectiveActive = isWeb && active && text !== "";
  activeRef.current = effectiveActive;

  const applyToSlot = (slot: WebMarqueeSlot, revealedPx: number) => {
    const outer = slot.outer;
    const clip = slot.clip;
    const inner = slot.inner;
    if (!outer || !clip || !inner || !clip.style || !inner.style || !outer.style) return;
    const containerW =
      lineWidthRef.current > 0 ? lineWidthRef.current : (outer.clientWidth ?? 0);
    const contentW = inner.scrollWidth ?? 0;
    if (containerW <= 0 || contentW <= 0) return;

    const maxLeft = Math.min(MARQUEE_LEFT_FADE_PX, Math.max(12, Math.floor(containerW * 0.28)));
    const maxRight = Math.min(MARQUEE_RIGHT_FADE_PX, Math.max(12, Math.floor(containerW * 0.24)));
    const clampedRevealed = Math.min(contentW, Math.max(0, revealedPx));

    if (clampedRevealed <= containerW) {
      clip.style.width = `${clampedRevealed.toFixed(2)}px`;
      inner.style.transform = "translate3d(0px, 0, 0)";
      setDomMask(outer, "");
      const revealRightFade = Math.min(maxRight, clampedRevealed * 0.72);
      setDomMask(clip, buildSmoothMarqueeMask(0, revealRightFade));
    } else {
      const offsetPx = clampedRevealed - containerW;
      clip.style.width = "100%";
      inner.style.transform = `translate3d(${(-offsetPx).toFixed(2)}px, 0, 0)`;
      setDomMask(clip, "");
      const leftFade = Math.min(maxLeft, offsetPx);
      setDomMask(outer, buildSmoothMarqueeMask(leftFade, maxRight));
    }
  };

  const measureMaxContentW = (): number => {
    let maxW = 0;
    for (const slot of slotsRef.current) {
      const w = slot.inner?.scrollWidth ?? 0;
      if (w > maxW) maxW = w;
    }
    return maxW;
  };

  const startLoopRef = useRef<() => void>(() => undefined);
  startLoopRef.current = () => {
    if (!activeRef.current || rafRef.current !== null) return;
    const targetW = measureMaxContentW();
    if (targetW > 0 && revealedPxRef.current > targetW) {
      revealedPxRef.current = targetW;
    }
    for (const slot of slotsRef.current) {
      applyToSlot(slot, revealedPxRef.current);
    }
    if (targetW <= 0 || revealedPxRef.current >= targetW) {
      lastFrameRef.current = 0;
      return;
    }
    const tick = (now: number) => {
      rafRef.current = null;
      if (!activeRef.current) {
        lastFrameRef.current = 0;
        return;
      }
      const curTargetW = measureMaxContentW();
      if (curTargetW <= 0) {
        lastFrameRef.current = 0;
        return;
      }
      if (revealedPxRef.current > curTargetW) {
        revealedPxRef.current = curTargetW;
      }
      const dt = lastFrameRef.current === 0 ? 16 : Math.max(1, now - lastFrameRef.current);
      lastFrameRef.current = now;
      revealedPxRef.current = advanceSmoothPixelOffset(revealedPxRef.current, curTargetW, dt);
      for (const slot of slotsRef.current) {
        applyToSlot(slot, revealedPxRef.current);
      }
      if (revealedPxRef.current < curTargetW - 0.25) {
        rafRef.current = globalThis.requestAnimationFrame(tick);
      } else {
        revealedPxRef.current = curTargetW;
        for (const slot of slotsRef.current) {
          applyToSlot(slot, curTargetW);
        }
        lastFrameRef.current = 0;
      }
    };
    lastFrameRef.current = 0;
    rafRef.current = globalThis.requestAnimationFrame(tick);
  };

  // Cancel running rAF only on unmount or row switch.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = 0;
    };
  }, [resetKey]);

  // Synchronously sync newly measured text width before paint and wake rAF if needed.
  useCommitLayoutEffect(() => {
    if (!effectiveActive) {
      if (rafRef.current !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = 0;
      if (!keepAlive) {
        revealedPxRef.current = 0;
      }
      return;
    }
    startLoopRef.current();
  }, [effectiveActive, keepAlive, text, lineWidth, resetKey]);

  const register = useMemo(
    () => (slot: WebMarqueeSlot) => {
      slotsRef.current.add(slot);
      if (activeRef.current) {
        startLoopRef.current();
      }
      return () => {
        slotsRef.current.delete(slot);
      };
    },
    [],
  );

  return { text, active: effectiveActive, lineWidth, register };
}

function SmoothMarqueeLine({
  controller,
  style,
}: {
  controller: SmoothMarqueeController;
  style: StyleProp<TextStyle>;
}) {
  const slotRef = useRef<WebMarqueeSlot>({ outer: null, clip: null, inner: null });

  useCommitLayoutEffect(() => {
    return controller.register(slotRef.current);
  }, [controller.register]);

  return (
    <View
      ref={(node) => {
        slotRef.current.outer = node as unknown as WebMarqueeDomNode | null;
      }}
      style={{
        ...(controller.lineWidth > 0
          ? { width: controller.lineWidth, flexShrink: 0 }
          : { flex: 1, minWidth: 0 }),
        overflow: "hidden",
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      <View
        ref={(node) => {
          slotRef.current.clip = node as unknown as WebMarqueeDomNode | null;
        }}
        style={{
          overflow: "hidden",
          flexDirection: "row",
          alignItems: "center",
          maxWidth: "100%",
        }}
      >
        <Text
          ref={(node) => {
            slotRef.current.inner = node as unknown as WebMarqueeDomNode | null;
          }}
          style={[
            style,
            {
              flex: 0,
              flexShrink: 0,
              paddingRight: MARQUEE_RIGHT_FADE_PX,
              whiteSpace: "nowrap",
              willChange: "transform",
            } as unknown as TextStyle,
          ]}
        >
          {controller.text}
        </Text>
      </View>
    </View>
  );
}

const NATIVE_MARQUEE_CHUNK_CHARS = 24;
/** 4 chunks (~96 chars ≈ 1200pt) is >4x an iPhone width while cutting shimmer overlay nodes in half. */
const NATIVE_MARQUEE_MAX_MOUNTED_CHUNKS = 4;
const NATIVE_MARQUEE_RETIRE_MARGIN_PX = 48;

interface NativeMarqueeController {
  readonly active: boolean;
  readonly lineWidth: number;
  readonly rowLineHeight: number;
  readonly retiredCount: number;
  readonly retiredWidth: number;
  readonly mountedChunks: readonly string[];
  readonly hasTailPad: boolean;
  readonly trackWidth: number;
  readonly clipX: Animated.AnimatedInterpolation<number> | null;
  readonly innerX: Animated.AnimatedInterpolation<number> | null;
  readonly leftFadeOpacity: Animated.AnimatedInterpolation<number> | null;
  readonly rightFadeOpacity: Animated.AnimatedInterpolation<number> | null;
  readonly onChunkLayout: (chunkIndex: number, width: number) => void;
}

/**
 * Drives 60/120fps CoreAnimation/GPU leftward marquee scrolling on native
 * iOS/Android via a single shared `Animated.Value` with `useNativeDriver: true`.
 *
 * Uses the same double-counter-translate clip trick as `SweepNative` so both
 * the initial left-to-right reveal (`0..lineWidth`) and the continuous leftward
 * glide (`> lineWidth`) run purely on GPU transforms with ZERO per-frame JS
 * thread callbacks, ZERO React re-renders during motion, and bounded small
 * `<Text>` chunks so iOS `UILabel` backing textures never overflow.
 */
function useNativeSmoothMarquee(
  source: string,
  active: boolean,
  keepAlive: boolean,
  lineWidth: number,
  rowLineHeight: number,
  resetKey: string | number,
): NativeMarqueeController {
  const canUseNative =
    typeof Platform?.OS === "string" &&
    Platform.OS !== "web" &&
    typeof Animated?.Value === "function" &&
    typeof Animated?.timing === "function" &&
    typeof Animated?.View !== "undefined" &&
    typeof Easing?.linear === "function";

  const normalized = canUseNative && keepAlive ? normalizeLeftScrollStream(source) : "";
  // Incremental O(delta) chunk cache so 15k-char DSH thinking streams never
  // re-split the entire string on every arriving token.
  const chunkCacheRef = useRef<{
    source: string;
    chunks: string[];
    lastChunkStart: number;
  }>({ source: "", chunks: [], lastChunkStart: 0 });
  const allChunks = useMemo(() => {
    if (!normalized) {
      chunkCacheRef.current = { source: "", chunks: [], lastChunkStart: 0 };
      return [] as string[];
    }
    const prev = chunkCacheRef.current;
    if (prev.source === normalized) return prev.chunks;
    if (prev.source !== "" && normalized.startsWith(prev.source) && prev.chunks.length > 0) {
      const tail = normalized.slice(prev.lastChunkStart);
      const tailChunks = splitNativeMarqueeChunks(tail, NATIVE_MARQUEE_CHUNK_CHARS);
      const nextChunks = prev.chunks.slice(0, -1).concat(tailChunks);
      const lastChunkLen = tailChunks.length > 0 ? tailChunks[tailChunks.length - 1]!.length : 0;
      const nextLastStart = normalized.length - lastChunkLen;
      chunkCacheRef.current = {
        source: normalized,
        chunks: nextChunks,
        lastChunkStart: nextLastStart,
      };
      return nextChunks;
    }
    const fresh = splitNativeMarqueeChunks(normalized, NATIVE_MARQUEE_CHUNK_CHARS);
    const lastLen = fresh.length > 0 ? fresh[fresh.length - 1]!.length : 0;
    chunkCacheRef.current = {
      source: normalized,
      chunks: fresh,
      lastChunkStart: normalized.length - lastLen,
    };
    return fresh;
  }, [normalized]);
  const effectiveActive = canUseNative && active && lineWidth > 0 && allChunks.length > 0;

  const revealedRef = useRef<Animated.Value | null>(null);
  if (canUseNative && revealedRef.current === null) {
    revealedRef.current = new Animated.Value(0);
  }

  const chunkWidthsRef = useRef<number[]>([]);
  const animStateRef = useRef({
    fromPx: 0,
    toPx: 0,
    startedAt: 0,
    durationMs: 0,
    running: false,
  });
  const [retireState, setRetireState] = useState<{
    epoch: string | number;
    retiredCount: number;
    retiredWidth: number;
  }>({ epoch: resetKey, retiredCount: 0, retiredWidth: 0 });
  const retireStateRef = useRef({ retiredCount: 0, retiredWidth: 0 });
  const retireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevResetKeyRef = useRef<string | number>(resetKey);
  const prevKeepAliveRef = useRef<boolean>(keepAlive);

  const resetKeyRef = useRef<string | number>(resetKey);
  resetKeyRef.current = resetKey;
  const lineWidthRef = useRef<number>(lineWidth);
  lineWidthRef.current = lineWidth;
  const allChunksLenRef = useRef<number>(allChunks.length);
  allChunksLenRef.current = allChunks.length;
  const effectiveActiveRef = useRef<boolean>(effectiveActive);
  effectiveActiveRef.current = effectiveActive;

  const needsReset =
    prevResetKeyRef.current !== resetKey || (!keepAlive && prevKeepAliveRef.current);
  if (needsReset) {
    prevResetKeyRef.current = resetKey;
    prevKeepAliveRef.current = keepAlive;
    chunkWidthsRef.current = [];
    retireStateRef.current = { retiredCount: 0, retiredWidth: 0 };
    animStateRef.current = { fromPx: 0, toPx: 0, startedAt: 0, durationMs: 0, running: false };
  } else {
    prevKeepAliveRef.current = keepAlive;
    if (chunkWidthsRef.current.length > allChunks.length) {
      chunkWidthsRef.current.length = allChunks.length;
    }
  }

  const effectiveRetiredCount =
    !needsReset && keepAlive && retireState.epoch === resetKey
      ? Math.min(retireState.retiredCount, Math.max(0, allChunks.length - 1))
      : 0;
  const effectiveRetiredWidth =
    !needsReset && keepAlive && retireState.epoch === resetKey && effectiveRetiredCount > 0
      ? retireState.retiredWidth
      : 0;
  retireStateRef.current = {
    retiredCount: effectiveRetiredCount,
    retiredWidth: effectiveRetiredWidth,
  };

  const clearRetireTimer = () => {
    if (retireTimerRef.current !== null) {
      clearTimeout(retireTimerRef.current);
      retireTimerRef.current = null;
    }
  };

  const estimateRevealedPx = (): number => {
    const st = animStateRef.current;
    if (!st.running) return st.toPx;
    const elapsed = Math.max(0, Date.now() - st.startedAt);
    const frac = st.durationMs > 0 ? Math.min(1, elapsed / st.durationMs) : 1;
    return st.fromPx + (st.toPx - st.fromPx) * frac;
  };

  const computeMeasuredTotalWidth = (): number => {
    const { retiredCount: rCount, retiredWidth: rWidth } = retireStateRef.current;
    const endIdx = Math.min(allChunksLenRef.current, rCount + NATIVE_MARQUEE_MAX_MOUNTED_CHUNKS);
    let sum = rWidth;
    let measuredCount = 0;
    for (let i = rCount; i < endIdx; i += 1) {
      const w = chunkWidthsRef.current[i];
      if (typeof w === "number" && w > 0) {
        sum += w;
        measuredCount += 1;
      }
    }
    if (measuredCount > 0 && endIdx >= allChunksLenRef.current) {
      sum += MARQUEE_RIGHT_FADE_PX;
    }
    return sum;
  };

  const tryRetireRef = useRef<() => void>(() => undefined);
  const scheduleRetireRef = useRef<() => void>(() => undefined);

  tryRetireRef.current = () => {
    if (!effectiveActiveRef.current) return;
    const { retiredCount: rCount, retiredWidth: rWidth } = retireStateRef.current;
    const maxRetirable = Math.max(0, allChunksLenRef.current - 2);
    if (rCount >= maxRetirable) return;

    const currentPx = estimateRevealedPx();
    const viewportLeftWorldPx = currentPx - lineWidthRef.current - NATIVE_MARQUEE_RETIRE_MARGIN_PX;
    let nextCount = rCount;
    let nextWidth = rWidth;
    while (nextCount < maxRetirable) {
      const w = chunkWidthsRef.current[nextCount];
      if (!(typeof w === "number" && w > 0)) break;
      if (nextWidth + w <= viewportLeftWorldPx) {
        nextWidth += w;
        nextCount += 1;
      } else {
        break;
      }
    }
    if (nextCount > rCount) {
      retireStateRef.current = { retiredCount: nextCount, retiredWidth: nextWidth };
      setRetireState({
        epoch: resetKeyRef.current,
        retiredCount: nextCount,
        retiredWidth: nextWidth,
      });
    } else {
      scheduleRetireRef.current();
    }
  };

  scheduleRetireRef.current = () => {
    clearRetireTimer();
    if (!effectiveActiveRef.current) return;
    const { retiredCount: rCount, retiredWidth: rWidth } = retireStateRef.current;
    const totalChunks = allChunksLenRef.current;
    // Only schedule periodic retirement when mounted window is filling up or has queued tail chunks.
    if (totalChunks - rCount <= 4) return;
    const maxRetirable = Math.max(0, totalChunks - 2);
    if (rCount >= maxRetirable) return;
    const oldestW = chunkWidthsRef.current[rCount];
    if (!(typeof oldestW === "number" && oldestW > 0)) return;

    const thresholdPx = rWidth + oldestW + lineWidthRef.current + NATIVE_MARQUEE_RETIRE_MARGIN_PX;
    const currentPx = estimateRevealedPx();
    if (currentPx >= thresholdPx) {
      tryRetireRef.current();
      return;
    }
    const st = animStateRef.current;
    if (!st.running || st.toPx < thresholdPx) return;
    const speedPxPerMs =
      st.durationMs > 0 ? Math.max(0.05, (st.toPx - st.fromPx) / st.durationMs) : 0.145;
    const etaMs = Math.min(2000, Math.max(120, Math.ceil((thresholdPx - currentPx) / speedPxPerMs)));
    retireTimerRef.current = setTimeout(() => {
      retireTimerRef.current = null;
      tryRetireRef.current();
    }, etaMs);
  };

  const kickAnimationRef = useRef<() => void>(() => undefined);
  kickAnimationRef.current = () => {
    const revealed = revealedRef.current;
    if (!revealed || !effectiveActiveRef.current) return;
    const targetW = computeMeasuredTotalWidth();
    if (targetW <= 0) return;

    const currentPx = estimateRevealedPx();
    if (targetW < currentPx - 0.5) {
      revealed.stopAnimation();
      revealed.setValue(targetW);
      animStateRef.current = {
        fromPx: targetW,
        toPx: targetW,
        startedAt: Date.now(),
        durationMs: 0,
        running: false,
      };
      return;
    }

    const remainingPx = targetW - currentPx;
    if (remainingPx < 0.5) return;
    if (animStateRef.current.running && Math.abs(animStateRef.current.toPx - targetW) < 0.5) {
      scheduleRetireRef.current();
      return;
    }

    const durationMs = computeSmoothMarqueeDurationMs(remainingPx);
    const startedAt = Date.now();
    animStateRef.current = {
      fromPx: currentPx,
      toPx: targetW,
      startedAt,
      durationMs,
      running: true,
    };
    Animated.timing(revealed, {
      toValue: targetW,
      duration: durationMs,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && animStateRef.current.startedAt === startedAt) {
        animStateRef.current = {
          fromPx: targetW,
          toPx: targetW,
          startedAt: Date.now(),
          durationMs: 0,
          running: false,
        };
        tryRetireRef.current();
      }
    });
    scheduleRetireRef.current();
  };

  // Stop native animation and clear timer on unmount or row switch.
  useEffect(() => {
    return () => {
      clearRetireTimer();
      revealedRef.current?.stopAnimation();
      animStateRef.current = { fromPx: 0, toPx: 0, startedAt: 0, durationMs: 0, running: false };
    };
  }, [resetKey]);

  // Sync activation / settle / reset transitions.
  useEffect(() => {
    if (!canUseNative) return;
    const revealed = revealedRef.current;
    if (!keepAlive) {
      clearRetireTimer();
      revealed?.stopAnimation();
      revealed?.setValue(0);
      chunkWidthsRef.current = [];
      animStateRef.current = { fromPx: 0, toPx: 0, startedAt: 0, durationMs: 0, running: false };
      setRetireState((prev) =>
        prev.epoch === resetKey && prev.retiredCount === 0 && prev.retiredWidth === 0
          ? prev
          : { epoch: resetKey, retiredCount: 0, retiredWidth: 0 },
      );
      return;
    }
    if (!effectiveActive) {
      clearRetireTimer();
      if (animStateRef.current.running) {
        const pausedPx = estimateRevealedPx();
        revealed?.stopAnimation();
        animStateRef.current = {
          fromPx: pausedPx,
          toPx: pausedPx,
          startedAt: Date.now(),
          durationMs: 0,
          running: false,
        };
      }
      return;
    }
    if (retireState.epoch !== resetKey) {
      setRetireState({ epoch: resetKey, retiredCount: 0, retiredWidth: 0 });
    }
    kickAnimationRef.current();
  }, [canUseNative, effectiveActive, keepAlive, allChunks.length, lineWidth, resetKey]);

  const onChunkLayout = useMemo(
    () => (chunkIndex: number, width: number) => {
      if (!Number.isFinite(width) || width <= 0) return;
      const prev = chunkWidthsRef.current[chunkIndex];
      if (typeof prev === "number" && Math.abs(prev - width) < 0.25) return;
      chunkWidthsRef.current[chunkIndex] = width;
      kickAnimationRef.current();
    },
    [],
  );

  const interpolations = useMemo(() => {
    const revealed = revealedRef.current;
    if (!canUseNative || !revealed || lineWidth <= 0) {
      return {
        clipX: null,
        innerX: null,
        leftFadeOpacity: null,
        rightFadeOpacity: null,
      };
    }
    const leftEdgeW = Math.min(MARQUEE_LEFT_FADE_PX, Math.max(12, Math.floor(lineWidth * 0.28)));
    const rightEdgeW = Math.min(MARQUEE_RIGHT_FADE_PX, Math.max(12, Math.floor(lineWidth * 0.24)));
    const clipX = revealed.interpolate({
      inputRange: [0, lineWidth],
      outputRange: [-lineWidth, 0],
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const innerX = revealed.interpolate({
      inputRange: [0, lineWidth],
      outputRange: [lineWidth, 0],
      extrapolateLeft: "extend",
      extrapolateRight: "extend",
    });
    const leftFadeOpacity = revealed.interpolate({
      inputRange: [lineWidth, lineWidth + leftEdgeW],
      outputRange: [0, 1],
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const rightFadeOpacity = revealed.interpolate({
      inputRange: [0, rightEdgeW],
      outputRange: [0, 1],
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    return { clipX, innerX, leftFadeOpacity, rightFadeOpacity };
  }, [canUseNative, lineWidth]);

  const mountedChunks = useMemo(() => {
    if (!effectiveActive) return [];
    return allChunks.slice(
      effectiveRetiredCount,
      effectiveRetiredCount + NATIVE_MARQUEE_MAX_MOUNTED_CHUNKS,
    );
  }, [effectiveActive, allChunks, effectiveRetiredCount]);

  const hasTailPad =
    effectiveActive &&
    mountedChunks.length > 0 &&
    effectiveRetiredCount + mountedChunks.length >= allChunks.length;

  let activeCharCount = 0;
  for (const chunk of mountedChunks) activeCharCount += chunk.length;
  const trackWidth = Math.ceil(
    effectiveRetiredWidth +
      activeCharCount * ROW_FONT_SIZE * 1.6 +
      lineWidth +
      MARQUEE_RIGHT_FADE_PX +
      200,
  );

  return {
    active: effectiveActive && interpolations.clipX !== null && interpolations.innerX !== null,
    lineWidth,
    rowLineHeight,
    retiredCount: effectiveRetiredCount,
    retiredWidth: effectiveRetiredWidth,
    mountedChunks,
    hasTailPad,
    trackWidth,
    clipX: interpolations.clipX,
    innerX: interpolations.innerX,
    leftFadeOpacity: interpolations.leftFadeOpacity,
    rightFadeOpacity: interpolations.rightFadeOpacity,
    onChunkLayout,
  };
}

/**
 * Smoothly reveals a growing single-line stream character-by-character so that
 * once the text fills the row width, older characters glide smoothly leftward
 * one character at a time — identical physics for both DSH native chunks and
 * Antigravity translated sentences.
 *
 * Never resets the cursor mid-thought on markdown/tail revisions (eliminating
 * flash-backs to char 1) and never tears down rAF on chunk arrivals.
 *
 * Falls back synchronously to `source` in headless environments without
 * `requestAnimationFrame` (e.g. Node unit harnesses).
 */
function useLeftScrollText(
  source: string,
  active: boolean,
  keepAlive: boolean,
  resetKey: string | number,
): { text: string; active: boolean } {
  const hasRaf =
    typeof globalThis.requestAnimationFrame === "function" &&
    typeof globalThis.cancelAnimationFrame === "function";
  const normalized = keepAlive ? normalizeLeftScrollStream(source) : "";
  const chars = useMemo(() => (normalized ? Array.from(normalized) : []), [normalized]);
  const targetLen = chars.length;

  const cursorRef = useRef<number>(0);
  const targetRef = useRef<number>(targetLen);
  const activeRef = useRef<boolean>(active);
  const lastFrameRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const prevResetKeyRef = useRef<string | number>(resetKey);
  const prevKeepAliveRef = useRef<boolean>(keepAlive);

  const [shownLen, setShownLen] = useState<number>(0);

  if (prevResetKeyRef.current !== resetKey || (!keepAlive && prevKeepAliveRef.current)) {
    prevResetKeyRef.current = resetKey;
    prevKeepAliveRef.current = keepAlive;
    cursorRef.current = 0;
    lastFrameRef.current = 0;
  } else {
    prevKeepAliveRef.current = keepAlive;
    // Never rewind to 0 mid-thought when markdown markers (`**`) or liveTail
    // wording shift slightly — only clamp down if the string shrank.
    if (targetLen < cursorRef.current) {
      cursorRef.current = targetLen;
    }
  }
  targetRef.current = targetLen;
  activeRef.current = active;

  // Effect 1: Cancel any running rAF only on unmount or row switch (never on chunk arrival!).
  useEffect(() => {
    return () => {
      if (rafRef.current !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = 0;
    };
  }, [resetKey]);

  // Effect 2: Start or pause the persistent rAF loop without tearing it down on new chunks.
  useEffect(() => {
    if (!hasRaf || !active || targetLen === 0) {
      if (rafRef.current !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = 0;
      if (!keepAlive || targetLen === 0) {
        cursorRef.current = 0;
        setShownLen(0);
      }
      return;
    }

    // Seed at least 1 char immediately so the line never flashes empty on frame 1.
    if (cursorRef.current < 1 && targetLen >= 1) {
      cursorRef.current = 1;
      setShownLen(1);
    }

    const tick = (now: number) => {
      rafRef.current = null;
      if (!activeRef.current) {
        lastFrameRef.current = 0;
        return;
      }
      const dt = lastFrameRef.current === 0 ? 16 : Math.max(1, now - lastFrameRef.current);
      lastFrameRef.current = now;

      const nextCursor = advanceLeftScrollCursor(cursorRef.current, targetRef.current, dt);
      cursorRef.current = nextCursor;
      const nextInt = Math.min(targetRef.current, Math.max(1, Math.floor(nextCursor)));
      setShownLen((prev) => (prev === nextInt ? prev : nextInt));

      if (cursorRef.current < targetRef.current) {
        rafRef.current = globalThis.requestAnimationFrame(tick);
      } else {
        lastFrameRef.current = 0;
      }
    };

    if (cursorRef.current < targetRef.current && rafRef.current === null) {
      lastFrameRef.current = 0;
      rafRef.current = globalThis.requestAnimationFrame(tick);
    } else if (cursorRef.current >= targetRef.current) {
      const clamped = Math.min(targetLen, Math.max(1, Math.floor(cursorRef.current)));
      setShownLen((prev) => (prev === clamped ? prev : clamped));
    }
  }, [hasRaf, active, keepAlive, targetLen, normalized, resetKey]);

  if (!active || targetLen === 0) {
    return { text: "", active: false };
  }
  if (!hasRaf) {
    return { text: source, active: false };
  }
  const visibleCount = Math.min(targetLen, Math.max(1, shownLen || Math.floor(cursorRef.current) || 1));
  const sliceStart = Math.max(0, visibleCount - LEFT_SCROLL_DOM_WINDOW_CHARS);
  return { text: chars.slice(sliceStart, visibleCount).join(""), active: true };
}

/** Max unbroken single-paragraph tail size before bypassing per-frame ink-trail splits. */
const EXPANDED_INK_MAX_ACTIVE_CHARS = 1600;

interface ExpandedBodyInkState {
  readonly active: boolean;
  readonly frozenText: string;
  readonly activeText: string;
  readonly localProgress: number;
  readonly localSettledFloor: number;
  readonly gapLines: number;
  /** Increments each time a brand-new paragraph begins so it can gently float up as a whole block. */
  readonly paragraphIndex: number;
}

function commonUtf16PrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  if (i > 0 && i < max) {
    const prev = a.charCodeAt(i - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) i -= 1;
  }
  return i;
}

/** Emit cadence (~30fps) for expanded thinking body ink reveal. */
const EXPANDED_INK_FRAME_INTERVAL_MS = 33;

/**
 * Streams newly arriving text inside an expanded thinking box with the same
 * 5.5-character soft ink-bloom trail used on the timeline (`renderInkTrailText`).
 *
 * - Text already present when the user expands appears immediately (0ms).
 * - Completed paragraphs above the active ink tail freeze into a memoized
 *   static `<Text>` so even 30k+ character thoughts only re-layout the active
 *   trailing paragraph (~50–250 chars) at ~30fps (33ms).
 * - `settledFloor` guarantees already-settled trailing characters stay at
 *   opacity 1.0 when a new chunk arrives while new characters bloom cleanly
 *   from the very first appended glyph.
 * - Automatically snaps to plain selectable text when settled, collapsed,
 *   toggled between original/translation, or in headless Node harnesses.
 */
function useExpandedBodyInkReveal(
  text: string,
  open: boolean,
  growing: boolean,
  isPlaceholder: boolean,
  resetKey: string | number,
): ExpandedBodyInkState {
  const hasRaf =
    typeof globalThis.requestAnimationFrame === "function" &&
    typeof globalThis.cancelAnimationFrame === "function";

  const prevOpenRef = useRef<boolean>(open);
  const prevResetKeyRef = useRef<string | number>(resetKey);
  const prevTextRef = useRef<string>(text);
  const prevPlaceholderRef = useRef<boolean>(isPlaceholder);
  const totalCpRef = useRef<number>(countCodePoints(text));
  const cursorRef = useRef<number>(totalCpRef.current + EXPANDED_BLOOM_WAVE_WIDTH);
  const settledFloorRef = useRef<number>(totalCpRef.current);
  const frozenRef = useRef<{
    text: string;
    activeStartUtf16: number;
    activeCpOffset: number;
    gapLines: number;
    paragraphIndex: number;
  }>({ text: "", activeStartUtf16: 0, activeCpOffset: 0, gapLines: 0, paragraphIndex: 0 });
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const [, setTick] = useState(0);

  const snapSettled = (nextText: string) => {
    const total = countCodePoints(nextText);
    totalCpRef.current = total;
    cursorRef.current = total + EXPANDED_BLOOM_WAVE_WIDTH;
    settledFloorRef.current = total;
    frozenRef.current = {
      text: "",
      activeStartUtf16: 0,
      activeCpOffset: 0,
      gapLines: 0,
      paragraphIndex: 0,
    };
  };

  if (prevResetKeyRef.current !== resetKey) {
    prevResetKeyRef.current = resetKey;
    prevOpenRef.current = open;
    prevTextRef.current = text;
    prevPlaceholderRef.current = isPlaceholder;
    snapSettled(text);
  } else if (!open) {
    prevOpenRef.current = false;
    prevTextRef.current = text;
    prevPlaceholderRef.current = isPlaceholder;
    snapSettled(text);
  } else if (!prevOpenRef.current && open) {
    prevOpenRef.current = true;
    prevTextRef.current = text;
    prevPlaceholderRef.current = isPlaceholder;
    snapSettled(text);
  } else if (text !== prevTextRef.current) {
    const prevText = prevTextRef.current;
    const wasPlaceholder = prevPlaceholderRef.current;
    prevTextRef.current = text;
    prevPlaceholderRef.current = isPlaceholder;

    if (!hasRaf || isPlaceholder || (!growing && cursorRef.current >= totalCpRef.current + EXPANDED_BLOOM_WAVE_WIDTH)) {
      snapSettled(text);
    } else if (wasPlaceholder && !isPlaceholder) {
      totalCpRef.current = countCodePoints(text);
      cursorRef.current = 0;
      settledFloorRef.current = 0;
      frozenRef.current = {
        text: "",
        activeStartUtf16: 0,
        activeCpOffset: 0,
        gapLines: 0,
        paragraphIndex: 1,
      };
    } else if (text.startsWith(prevText)) {
      const prevTotal = totalCpRef.current;
      totalCpRef.current += countCodePoints(text.slice(prevText.length));
      if (cursorRef.current > prevTotal) {
        settledFloorRef.current = Math.max(settledFloorRef.current, prevTotal);
        cursorRef.current = prevTotal;
      }
    } else if (prevText.endsWith("…") && text.startsWith(prevText.slice(0, -1))) {
      const commonUtf16 = prevText.length - 1;
      const commonCp = Math.max(0, totalCpRef.current - 1);
      totalCpRef.current = commonCp + countCodePoints(text.slice(commonUtf16));
      if (cursorRef.current > commonCp) {
        settledFloorRef.current = Math.min(commonCp, Math.max(settledFloorRef.current, commonCp));
        cursorRef.current = commonCp;
      } else {
        settledFloorRef.current = Math.min(settledFloorRef.current, commonCp);
      }
      if (frozenRef.current.activeStartUtf16 > commonUtf16) {
        frozenRef.current = {
          text: "",
          activeStartUtf16: 0,
          activeCpOffset: 0,
          gapLines: 0,
          paragraphIndex: frozenRef.current.paragraphIndex,
        };
      }
    } else {
      const commonUtf16 = commonUtf16PrefixLength(prevText, text);
      const commonCp = countCodePoints(text.slice(0, commonUtf16));
      totalCpRef.current = commonCp + countCodePoints(text.slice(commonUtf16));
      if (cursorRef.current > commonCp) {
        settledFloorRef.current = Math.min(commonCp, Math.max(settledFloorRef.current, commonCp));
        cursorRef.current = commonCp;
      } else {
        settledFloorRef.current = Math.min(settledFloorRef.current, commonCp);
      }
      if (frozenRef.current.activeStartUtf16 > commonUtf16) {
        frozenRef.current = {
          text: "",
          activeStartUtf16: 0,
          activeCpOffset: 0,
          gapLines: 0,
          paragraphIndex: frozenRef.current.paragraphIndex,
        };
      }
    }
  } else {
    prevPlaceholderRef.current = isPlaceholder;
  }

  if (open && hasRaf && !isPlaceholder && cursorRef.current < totalCpRef.current + EXPANDED_BLOOM_WAVE_WIDTH) {
    const f = frozenRef.current;
    const currentActive = text.slice(f.activeStartUtf16);
    const settledGlobalCp = Math.max(
      settledFloorRef.current,
      Math.floor(cursorRef.current - EXPANDED_BLOOM_WAVE_WIDTH) - 1,
    );
    const settledLocalCp = settledGlobalCp - f.activeCpOffset;
    if (settledLocalCp > 0) {
      const advance = findSettledBodySplit(currentActive, settledLocalCp);
      if (advance !== null) {
        const prefixSep = f.text !== "" ? "\n".repeat(f.gapLines + 1) : "";
        frozenRef.current = {
          text: f.text + prefixSep + advance.frozenDelta,
          activeStartUtf16: f.activeStartUtf16 + advance.nextActiveStart,
          activeCpOffset: f.activeCpOffset + advance.consumedCodePoints,
          gapLines: advance.gapLines,
          paragraphIndex: f.paragraphIndex + 1,
        };
      }
    }
  }

  const f = frozenRef.current;
  const activeText = open ? text.slice(f.activeStartUtf16) : "";
  const settledTarget = totalCpRef.current + EXPANDED_BLOOM_WAVE_WIDTH;
  const needsAnim =
    open &&
    hasRaf &&
    !isPlaceholder &&
    text.length > 0 &&
    cursorRef.current < settledTarget - 0.05 &&
    activeText.length <= EXPANDED_INK_MAX_ACTIVE_CHARS;

  if (!needsAnim && open && cursorRef.current < settledTarget) {
    cursorRef.current = settledTarget;
    settledFloorRef.current = totalCpRef.current;
    frozenRef.current = {
      text: "",
      activeStartUtf16: 0,
      activeCpOffset: 0,
      gapLines: 0,
      paragraphIndex: 0,
    };
  }

  const needsAnimRef = useRef<boolean>(needsAnim);
  needsAnimRef.current = needsAnim;

  useEffect(() => {
    return () => {
      if (rafRef.current !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = 0;
    };
  }, [resetKey]);

  useEffect(() => {
    if (!needsAnim) {
      if (rafRef.current !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = 0;
      return;
    }
    if (rafRef.current !== null) return;

    let lastEmitAt = 0;
    const tick = (now: number) => {
      rafRef.current = null;
      if (!needsAnimRef.current) {
        lastFrameRef.current = 0;
        return;
      }
      const dt = lastFrameRef.current === 0 ? STREAM_FRAME_INTERVAL_MS : Math.max(1, now - lastFrameRef.current);
      lastFrameRef.current = now;
      const target = totalCpRef.current;
      const next = advanceExpandedInkCursor(cursorRef.current, target, dt, EXPANDED_BLOOM_WAVE_WIDTH);
      cursorRef.current = next;
      const done = next >= target + EXPANDED_BLOOM_WAVE_WIDTH - 0.05;
      if (done) {
        cursorRef.current = target + EXPANDED_BLOOM_WAVE_WIDTH;
        settledFloorRef.current = target;
        frozenRef.current = {
          text: "",
          activeStartUtf16: 0,
          activeCpOffset: 0,
          gapLines: 0,
          paragraphIndex: 0,
        };
        lastFrameRef.current = 0;
        setTick((v) => (v + 1) & 0x7fffffff);
        return;
      }
      // Thinking text streams slowly (14–42 chars/sec), so 30fps (~33ms) stays
      // visually smooth while halving JS/CoreText layout wakeups on mobile.
      if (lastEmitAt === 0 || now - lastEmitAt >= EXPANDED_INK_FRAME_INTERVAL_MS) {
        lastEmitAt = now;
        setTick((v) => (v + 1) & 0x7fffffff);
      }
      rafRef.current = globalThis.requestAnimationFrame(tick);
    };

    lastFrameRef.current = 0;
    rafRef.current = globalThis.requestAnimationFrame(tick);
  }, [needsAnim, text, resetKey]);

  if (!needsAnim) {
    return {
      active: false,
      frozenText: "",
      activeText: "",
      localProgress: Number.POSITIVE_INFINITY,
      localSettledFloor: 0,
      gapLines: 0,
      paragraphIndex: 0,
    };
  }

  return {
    active: true,
    frozenText: frozenRef.current.text,
    activeText,
    localProgress: Math.max(0, cursorRef.current - frozenRef.current.activeCpOffset),
    localSettledFloor: Math.max(0, settledFloorRef.current - frozenRef.current.activeCpOffset),
    gapLines: frozenRef.current.gapLines,
    paragraphIndex: frozenRef.current.paragraphIndex,
  };
}

/**
 * Render an expanded thinking tail using true `rgba(...)` text colors so iOS
 * React Native `NSAttributedString` (which ignores `opacity` on nested `<Text>`)
 * fades newly arrived phrases smoothly from their front half to their tail.
 */
function renderExpandedBloomText(
  text: string,
  progress: number,
  baseColor: string,
  settledFloor: number,
) {
  const segments = buildExpandedBloomSegments(
    text,
    progress,
    EXPANDED_BLOOM_WAVE_WIDTH,
    settledFloor,
  );
  if (segments.length === 0) return "";
  if (segments.length === 1 && segments[0]!.alpha >= 0.995) {
    return segments[0]!.text;
  }
  return segments.map((seg, idx) => {
    if (seg.alpha >= 0.995) return seg.text;
    if (seg.alpha <= 0.005) {
      return (
        <Text key={idx} style={{ color: "transparent" }}>
          {seg.text}
        </Text>
      );
    }
    const tinted = withAlpha(baseColor, seg.alpha);
    return (
      <Text
        key={idx}
        style={tinted !== "transparent" ? { color: tinted } : { opacity: seg.alpha }}
      >
        {seg.text}
      </Text>
    );
  });
}

/** Distance (px) from the bottom edge that still counts as following the tail. */
const STICK_TO_BOTTOM_THRESHOLD = 24;

interface BodyScrollTracker {
  stickToBottom: boolean;
  lastScrollY: number | null;
  lastMaxReachableY: number | null;
  stickyAnchorY: number | null;
  /** Pre-growth bottom edge preserved across multi-frame iOS bottom overscroll bounces. */
  overscrollReturnFloorY: number | null;
  userDragging: boolean;
  userMomentum: boolean;
  awaitingMomentum: boolean;
  endDragTimer: ReturnType<typeof setTimeout> | null;
  pendingFollow: boolean;
}

function createBodyScrollTracker(): BodyScrollTracker {
  return {
    stickToBottom: true,
    lastScrollY: null,
    lastMaxReachableY: null,
    stickyAnchorY: null,
    overscrollReturnFloorY: null,
    userDragging: false,
    userMomentum: false,
    awaitingMomentum: false,
    endDragTimer: null,
    pendingFollow: false,
  };
}

function clearEndDragTimer(tracker: BodyScrollTracker): void {
  if (tracker.endDragTimer !== null) {
    clearTimeout(tracker.endDragTimer);
    tracker.endDragTimer = null;
  }
}

/** Polling cadence for the live thinking timer (matches 0.1s display granularity). */
const DURATION_TICK_MS = 100;

/** Bounded cache so virtual-list recycles keep an observed thought's duration. */
const MAX_DURATION_RECORDS = 500;

/** Test ID for the right-aligned thinking duration text. */
export const THINKING_DURATION_TEST_ID = "dsh-thinking-duration";

interface DurationRecord {
  elapsedMs: number;
  settled: boolean;
  text: string;
}

const durationRecords = new Map<string, DurationRecord>();
const collisionSlotsByBaseKey = new Map<string, Set<string>>();
const collisionSlotToBaseKey = new Map<string, string>();

function mergeAnchorText(existingText: string | undefined, nextText: string): string {
  if (existingText === undefined || existingText === "") return nextText;
  if (nextText === "") return existingText;
  return nextText.length >= existingText.length ? nextText : existingText;
}

function isCompatibleThoughtText(
  record: DurationRecord,
  currentText: string,
  currentPhase: "streaming" | "complete",
): boolean {
  const cachedText = record.text;
  if (cachedText === currentText) return true;
  if (cachedText === "") return currentPhase === "streaming" || !record.settled;
  if (currentText === "") return !record.settled;
  if (record.settled && currentPhase === "complete") return false;
  if (record.settled) return currentText.startsWith(cachedText);
  return currentText.startsWith(cachedText) || cachedText.startsWith(currentText);
}

function deleteDurationRecord(key: string): void {
  durationRecords.delete(key);
  const baseKey = collisionSlotToBaseKey.get(key);
  if (baseKey !== undefined) {
    collisionSlotToBaseKey.delete(key);
    const slots = collisionSlotsByBaseKey.get(baseKey);
    if (slots !== undefined) {
      slots.delete(key);
      if (slots.size === 0) collisionSlotsByBaseKey.delete(baseKey);
    }
  }
}

function rememberDuration(key: string, record: DurationRecord, baseKey?: string): void {
  if (!durationRecords.has(key) && durationRecords.size >= MAX_DURATION_RECORDS) {
    const oldest = durationRecords.keys().next().value;
    if (oldest !== undefined) deleteDurationRecord(oldest);
  }
  durationRecords.set(key, record);
  if (baseKey !== undefined && baseKey !== key) {
    collisionSlotToBaseKey.set(key, baseKey);
    let slots = collisionSlotsByBaseKey.get(baseKey);
    if (slots === undefined) {
      slots = new Set<string>();
      collisionSlotsByBaseKey.set(baseKey, slots);
    }
    slots.add(key);
  }
}

/**
 * Resolve the storage slot for `(baseKey, text)` so two unrelated thoughts
 * sharing the exact same millisecond timestamp never collide or reuse each
 * other's cached duration.
 */
function resolveDurationKey(
  baseKey: string | undefined,
  text: string,
  phase: "streaming" | "complete",
): string | undefined {
  if (baseKey === undefined) return undefined;
  const primary = durationRecords.get(baseKey);
  if (primary !== undefined && isCompatibleThoughtText(primary, text, phase)) {
    return baseKey;
  }
  const slots = collisionSlotsByBaseKey.get(baseKey);
  if (slots !== undefined) {
    for (const slotKey of slots) {
      const record = durationRecords.get(slotKey);
      if (record !== undefined && isCompatibleThoughtText(record, text, phase)) {
        return slotKey;
      }
    }
  }
  if (primary === undefined) return baseKey;
  let slotIndex = 1;
  while (durationRecords.has(`${baseKey}\0#${slotIndex}`)) {
    slotIndex += 1;
  }
  return `${baseKey}\0#${slotIndex}`;
}

/** Clear cached thinking durations; test-only helper. */
export function resetThinkingDurationsForTests(): void {
  durationRecords.clear();
  collisionSlotsByBaseKey.clear();
  collisionSlotToBaseKey.clear();
}

/**
 * Observe live elapsed duration strictly when the row is seen streaming.
 *
 * Historic / replayed rows that mount already settled keep `0` so the UI never
 * invents a fake elapsed time. Active duration is accumulated as
 * `baseElapsedMs + (now - segmentStartedAt)` so unmounting or pausing past the
 * 300ms settle window never inflates elapsed time with idle/unmounted gaps,
 * resuming a stream continues monotonically from the saved total, and system
 * clock rollbacks never move the reading backwards.
 */
function useThinkingDuration(
  growing: boolean,
  phase: "streaming" | "complete",
  cacheKey: string | undefined,
  baseKey: string | undefined,
  text: string,
  lastActivityAt: number,
  continuedKeyShift: boolean,
): number {
  const cached = cacheKey === undefined ? undefined : durationRecords.get(cacheKey);
  const prevKeyRef = useRef<string | undefined>(cacheKey);
  const baseElapsedRef = useRef<number>(cached?.elapsedMs ?? 0);
  const segmentStartedAtRef = useRef<number | null>(null);
  const maxElapsedRef = useRef<number>(cached?.elapsedMs ?? 0);
  const wasGrowingRef = useRef<boolean>(false);
  const boundKeyRef = useRef<string | undefined>(cacheKey);
  const boundTextRef = useRef<string>(text);
  if (boundKeyRef.current === cacheKey) {
    boundTextRef.current = text;
  }
  const [state, setState] = useState<{ key: string | undefined; elapsedMs: number }>(() => ({
    key: cacheKey,
    elapsedMs: cached?.elapsedMs ?? 0,
  }));

  useEffect(() => {
    if (cacheKey === undefined) return;
    const existing = durationRecords.get(cacheKey);
    if (existing === undefined) return;
    const merged = mergeAnchorText(existing.text, text);
    if (merged !== existing.text) {
      rememberDuration(cacheKey, { ...existing, text: merged }, baseKey);
    }
  }, [cacheKey, baseKey, text]);

  useEffect(() => {
    boundKeyRef.current = cacheKey;
    boundTextRef.current = text;

    const commit = (nextElapsed: number) => {
      setState((prev) =>
        prev.key === cacheKey && prev.elapsedMs === nextElapsed
          ? prev
          : { key: cacheKey, elapsedMs: nextElapsed },
      );
    };

    const computeElapsedAt = (sampleAt: number): number => {
      if (segmentStartedAtRef.current === null) return maxElapsedRef.current;
      const delta = Math.max(0, sampleAt - segmentStartedAtRef.current);
      return Math.max(maxElapsedRef.current, baseElapsedRef.current + delta);
    };

    const flushSegmentAt = (sampleAt: number): number => {
      const total = computeElapsedAt(sampleAt);
      maxElapsedRef.current = total;
      baseElapsedRef.current = total;
      segmentStartedAtRef.current = null;
      return total;
    };

    if (prevKeyRef.current !== cacheKey) {
      const oldKey = prevKeyRef.current;
      prevKeyRef.current = cacheKey;
      if (continuedKeyShift) {
        const oldCached = oldKey === undefined ? undefined : durationRecords.get(oldKey);
        const carried = Math.max(flushSegmentAt(Date.now()), oldCached?.elapsedMs ?? 0);
        baseElapsedRef.current = carried;
        maxElapsedRef.current = carried;
        segmentStartedAtRef.current = null;
        if (oldKey !== undefined) {
          deleteDurationRecord(oldKey);
        }
        if (cacheKey !== undefined) {
          rememberDuration(
            cacheKey,
            {
              elapsedMs: carried,
              settled: false,
              text: mergeAnchorText(oldCached?.text, boundTextRef.current),
            },
            baseKey,
          );
        }
        commit(carried);
      } else {
        wasGrowingRef.current = false;
        segmentStartedAtRef.current = null;
        const keyCached = cacheKey === undefined ? undefined : durationRecords.get(cacheKey);
        baseElapsedRef.current = keyCached?.elapsedMs ?? 0;
        maxElapsedRef.current = keyCached?.elapsedMs ?? 0;
        commit(maxElapsedRef.current);
      }
    }

    const currentCached = cacheKey === undefined ? undefined : durationRecords.get(cacheKey);

    if (growing) {
      wasGrowingRef.current = true;
      const resumeBase = Math.max(maxElapsedRef.current, currentCached?.elapsedMs ?? 0);
      if (segmentStartedAtRef.current === null) {
        baseElapsedRef.current = resumeBase;
        maxElapsedRef.current = resumeBase;
      } else if (resumeBase > maxElapsedRef.current) {
        maxElapsedRef.current = resumeBase;
      }

      const recordSample = (sampleAt: number) => {
        const next = computeElapsedAt(sampleAt);
        maxElapsedRef.current = next;
        if (cacheKey !== undefined) {
          const existing = durationRecords.get(cacheKey);
          rememberDuration(
            cacheKey,
            {
              elapsedMs: next,
              settled: false,
              text: mergeAnchorText(existing?.text, boundTextRef.current),
            },
            baseKey,
          );
        }
        commit(next);
      };

      if (phase === "streaming") {
        if (segmentStartedAtRef.current === null) {
          segmentStartedAtRef.current = Date.now();
        }
        const tick = () => recordSample(Date.now());
        tick();
        const id = setInterval(tick, DURATION_TICK_MS);
        return () => {
          clearInterval(id);
          if (segmentStartedAtRef.current !== null) {
            const flushed = flushSegmentAt(Date.now());
            if (cacheKey !== undefined) {
              const existing = durationRecords.get(cacheKey);
              if (existing === undefined || !existing.settled) {
                rememberDuration(
                  cacheKey,
                  {
                    elapsedMs: flushed,
                    settled: false,
                    text: mergeAnchorText(existing?.text, boundTextRef.current),
                  },
                  baseKey,
                );
              }
            }
          }
        };
      }

      // Inside the settle debounce window (`phase === "complete"`): anchor to
      // the last real activity moment rather than ticking through the 300ms wait.
      const settledSample = flushSegmentAt(lastActivityAt);
      if (cacheKey !== undefined) {
        const existing = durationRecords.get(cacheKey);
        rememberDuration(
          cacheKey,
          {
            elapsedMs: settledSample,
            settled: false,
            text: mergeAnchorText(existing?.text, boundTextRef.current),
          },
          baseKey,
        );
      }
      commit(settledSample);
      return undefined;
    }

    if (wasGrowingRef.current) {
      wasGrowingRef.current = false;
      const finalMs = flushSegmentAt(lastActivityAt);
      if (cacheKey !== undefined) {
        const existing = durationRecords.get(cacheKey);
        rememberDuration(
          cacheKey,
          {
            elapsedMs: finalMs,
            settled: true,
            text: mergeAnchorText(existing?.text, boundTextRef.current),
          },
          baseKey,
        );
      }
      commit(finalMs);
      return undefined;
    }

    if (currentCached?.settled) {
      segmentStartedAtRef.current = null;
      baseElapsedRef.current = currentCached.elapsedMs;
      maxElapsedRef.current = currentCached.elapsedMs;
      commit(currentCached.elapsedMs);
      return undefined;
    }

    if (cacheKey !== undefined && currentCached !== undefined && !currentCached.settled) {
      rememberDuration(
        cacheKey,
        {
          elapsedMs: currentCached.elapsedMs,
          settled: true,
          text: mergeAnchorText(currentCached.text, boundTextRef.current),
        },
        baseKey,
      );
      baseElapsedRef.current = currentCached.elapsedMs;
      maxElapsedRef.current = currentCached.elapsedMs;
      commit(currentCached.elapsedMs);
    }
    return undefined;
  }, [growing, phase, cacheKey, baseKey, lastActivityAt, continuedKeyShift]);

  if (state.key === cacheKey || continuedKeyShift) return state.elapsedMs;
  return cached?.elapsedMs ?? 0;
}

export function InlineThinking({
  theme,
  host,
  layout,
  agentId,
  timestamp,
  item,
}: PluginTimelineItemProps<InlineThinkingData>) {
  const { text, phase } = item.data;
  const rowAt = normalizeRowTimestamp(timestamp);
  const hostId = typeof host?.id === "string" ? host.id : "";
  const rowKey = rowAt !== 0 ? `thinking:${rowAt}` : undefined;
  const baseDurationKey =
    typeof agentId === "string" && agentId !== "" && rowKey !== undefined
      ? `${hostId}\0${agentId}\0${rowKey}`
      : undefined;
  const durationKey = resolveDurationKey(baseDurationKey, text, phase);
  const hasCommittedRenderRef = useRef(false);
  const renderIdentityRef = useRef<object | null>(null);
  if (renderIdentityRef.current === null) {
    renderIdentityRef.current = {};
  }
  useEffect(() => {
    hasCommittedRenderRef.current = true;
  }, []);
  if (typeof agentId === "string" && agentId !== "" && rowAt !== 0) {
    noteRender(
      agentId,
      rowAt,
      !hasCommittedRenderRef.current,
      renderIdentityRef.current,
    );
  }
  const { growing, lastActivityAt, continuedKeyShift } = useGrowing(
    text,
    phase,
    durationKey,
    hostId,
    agentId,
    rowAt,
  );
  const elapsedMs = useThinkingDuration(
    growing,
    phase,
    durationKey,
    baseDurationKey,
    text,
    lastActivityAt,
    continuedKeyShift,
  );
  const durationText = formatThinkingDuration(elapsedMs);
  // The width the preview line has to work with, derived from its ancestors.
  //
  // Measuring the line itself does not work: the sweep container is
  // content-sized (the web build pins `width: max-content` on it, the native
  // sweep is sized by its content), so a `flex: 1` child inside it has no
  // definite basis and reports its own content width — a feedback loop that
  // collapsed the window to a couple of characters on the desktop client while
  // the settled row (which needs no width) looked fine. The row, the label, and
  // the trailing duration box are all definite, so the line is what is left over.
  const styleState = useSettings(timelineStyleSettings);
  const style = styleState.status === "ready" ? styleState.values : TIMELINE_STYLE_DEFAULTS;
  const expandedMaxHeight =
    "expandedMaxHeight" in style &&
    typeof (style as { expandedMaxHeight?: unknown }).expandedMaxHeight === "number"
      ? (style as { expandedMaxHeight: number }).expandedMaxHeight
      : EXPANDED_MAX_HEIGHT_DEFAULT;
  const [rowWidth, setRowWidth] = useState(0);
  const [labelWidth, setLabelWidth] = useState(0);
  const [durationWidth, setDurationWidth] = useState(0);
  const reservedDurationWidth = durationText !== "" ? durationWidth + style.toolRowGap : 0;
  const lineWidth = Math.max(
    0,
    rowWidth -
      THINK_ICON_SIZE -
      style.toolRowGap -
      labelWidth -
      style.toolRowGap -
      reservedDurationWidth,
  );
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? false;
  const collapseBody = (event?: unknown) => {
    if (shouldCollapseOnBodyPress(event)) setManual(false);
  };
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollTrackerRef = useRef<BodyScrollTracker>(createBodyScrollTracker());
  const prevOpenRef = useRef<boolean>(open);
  const prevScrollKeyRef = useRef<string | undefined>(durationKey);
  const continuedKeyShiftRef = useRef<boolean>(continuedKeyShift);
  continuedKeyShiftRef.current = continuedKeyShift;

  const scrollBodyToBottom = () => {
    const tracker = scrollTrackerRef.current;
    if (!tracker.stickToBottom) {
      tracker.pendingFollow = false;
      return;
    }
    if (tracker.userDragging || tracker.userMomentum || tracker.awaitingMomentum) {
      tracker.pendingFollow = true;
      return;
    }
    const node = scrollRef.current;
    if (node === null || typeof node.scrollToEnd !== "function") return;
    tracker.pendingFollow = false;
    tracker.overscrollReturnFloorY = null;
    if (tracker.lastScrollY !== null) {
      tracker.stickyAnchorY =
        tracker.stickyAnchorY === null
          ? tracker.lastScrollY
          : Math.max(tracker.stickyAnchorY, tracker.lastScrollY);
    }
    node.scrollToEnd({ animated: false });
  };

  const flushPendingFollow = () => {
    const tracker = scrollTrackerRef.current;
    if (
      !tracker.userDragging &&
      !tracker.userMomentum &&
      !tracker.awaitingMomentum &&
      tracker.pendingFollow &&
      tracker.stickToBottom
    ) {
      tracker.pendingFollow = false;
      scrollBodyToBottom();
    }
  };

  // Opening an expanded thought starts at the latest (bottom) content; live
  // follow during streaming is driven by `onContentSizeChange`/`onLayout` so we
  // do not fire duplicate pre-layout `scrollToEnd` calls per chunk. Only reset
  // on expand/collapse or a genuine row switch (never on a merge-timestamp shift).
  useEffect(() => {
    const openChanged = prevOpenRef.current !== open;
    const keySwitched = prevScrollKeyRef.current !== durationKey && !continuedKeyShiftRef.current;
    prevOpenRef.current = open;
    prevScrollKeyRef.current = durationKey;

    if (openChanged || keySwitched) {
      clearEndDragTimer(scrollTrackerRef.current);
      scrollTrackerRef.current = createBodyScrollTracker();
      if (open) {
        scrollBodyToBottom();
      }
    }
  }, [open, durationKey]);

  useEffect(() => () => clearEndDragTimer(scrollTrackerRef.current), []);

  const handleScrollLayout = () => {
    scrollBodyToBottom();
  };

  const handleContentSizeChange = () => {
    scrollBodyToBottom();
  };

  const handleScrollBeginDrag = () => {
    const tracker = scrollTrackerRef.current;
    clearEndDragTimer(tracker);
    tracker.awaitingMomentum = false;
    tracker.userDragging = true;
    tracker.userMomentum = false;
  };

  const handleScrollEndDrag = (event?: {
    nativeEvent?: {
      velocity?: { y?: number };
      contentOffset?: { y?: number };
      targetContentOffset?: { y?: number };
    };
  }) => {
    const tracker = scrollTrackerRef.current;
    tracker.userDragging = false;
    clearEndDragTimer(tracker);
    if (tracker.userMomentum) {
      tracker.awaitingMomentum = false;
      return;
    }

    const velocityY = event?.nativeEvent?.velocity?.y;
    const hasVelocity = typeof velocityY === "number" && Number.isFinite(velocityY);
    const offsetY = event?.nativeEvent?.contentOffset?.y;
    const targetY = event?.nativeEvent?.targetContentOffset?.y;
    const hasTargetOffset =
      typeof offsetY === "number" &&
      Number.isFinite(offsetY) &&
      typeof targetY === "number" &&
      Number.isFinite(targetY);
    const expectsMomentum =
      (hasVelocity && Math.abs(velocityY) > 0.01) ||
      (hasTargetOffset && Math.abs(targetY - offsetY) > 1);
    const confirmedStationary =
      hasVelocity &&
      Math.abs(velocityY) <= 0.01 &&
      (!hasTargetOffset || Math.abs(targetY - offsetY) <= 1);

    if (confirmedStationary) {
      tracker.awaitingMomentum = false;
      flushPendingFollow();
      return;
    }

    tracker.awaitingMomentum = true;
    const delayMs = expectsMomentum ? 120 : 0;
    tracker.endDragTimer = setTimeout(() => {
      tracker.endDragTimer = null;
      if (scrollTrackerRef.current !== tracker) return;
      tracker.awaitingMomentum = false;
      flushPendingFollow();
    }, delayMs);
  };

  const handleMomentumScrollBegin = () => {
    const tracker = scrollTrackerRef.current;
    clearEndDragTimer(tracker);
    tracker.awaitingMomentum = false;
    tracker.userMomentum = true;
  };

  const handleMomentumScrollEnd = () => {
    const tracker = scrollTrackerRef.current;
    clearEndDragTimer(tracker);
    tracker.awaitingMomentum = false;
    tracker.userMomentum = false;
    tracker.overscrollReturnFloorY = null;
    flushPendingFollow();
  };

  const handleBodyScroll = (event: {
    nativeEvent?: {
      contentOffset?: { y?: number };
      layoutMeasurement?: { height?: number };
      contentSize?: { height?: number };
    };
  }) => {
    const native = event?.nativeEvent;
    const y = native?.contentOffset?.y;
    const viewportH = native?.layoutMeasurement?.height;
    const contentH = native?.contentSize?.height;
    if (
      typeof y !== "number" ||
      !Number.isFinite(y) ||
      typeof viewportH !== "number" ||
      !Number.isFinite(viewportH) ||
      typeof contentH !== "number" ||
      !Number.isFinite(contentH)
    ) {
      return;
    }

    const tracker = scrollTrackerRef.current;
    const distanceFromBottom = contentH - (y + viewportH);
    const atBottom = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD;
    const maxReachableY = Math.max(0, contentH - viewportH);
    const overscrolledBottomNow = y > maxReachableY + 1;
    if (overscrolledBottomNow) {
      tracker.overscrollReturnFloorY =
        tracker.overscrollReturnFloorY === null
          ? maxReachableY
          : Math.min(tracker.overscrollReturnFloorY, maxReachableY);
    }
    const activeOverscrollFloor = tracker.overscrollReturnFloorY;
    const movedDown = tracker.lastScrollY !== null && y > tracker.lastScrollY;
    const inOverscrollBounce =
      activeOverscrollFloor !== null && !movedDown && y >= activeOverscrollFloor - 1;
    const effectiveY =
      overscrolledBottomNow || inOverscrollBounce
        ? Math.min(y, maxReachableY, activeOverscrollFloor ?? maxReachableY)
        : Math.min(y, maxReachableY);
    const scrolledUp = inOverscrollBounce
      ? false
      : tracker.lastScrollY !== null &&
        (y < tracker.lastScrollY - 1 ||
          (!movedDown && tracker.stickyAnchorY !== null && y < tracker.stickyAnchorY - 1));

    if (scrolledUp && distanceFromBottom > 1) {
      // Any explicit upward movement off the bottom edge — including repeated
      // small (-1px) wheel ticks — disengages auto-follow immediately, while
      // iOS overscroll bounce back to `distanceFromBottom <= 1` stays sticky.
      tracker.stickToBottom = false;
      tracker.pendingFollow = false;
      tracker.stickyAnchorY = null;
      tracker.overscrollReturnFloorY = null;
    } else if (atBottom && (tracker.stickToBottom || movedDown || distanceFromBottom <= 1)) {
      if (!tracker.stickToBottom) {
        tracker.stickyAnchorY = effectiveY;
      } else {
        tracker.stickyAnchorY =
          tracker.stickyAnchorY === null
            ? effectiveY
            : Math.max(tracker.stickyAnchorY, effectiveY);
      }
      tracker.stickToBottom = true;
    } else if (tracker.stickToBottom) {
      tracker.stickyAnchorY =
        tracker.stickyAnchorY === null
          ? effectiveY
          : Math.max(tracker.stickyAnchorY, effectiveY);
      if (tracker.userDragging || tracker.userMomentum || tracker.awaitingMomentum) {
        tracker.pendingFollow = true;
      }
    }

    if (
      !overscrolledBottomNow &&
      tracker.overscrollReturnFloorY !== null &&
      (y <= tracker.overscrollReturnFloorY + 1 || movedDown || scrolledUp)
    ) {
      tracker.overscrollReturnFloorY = null;
    }

    tracker.lastScrollY = y;
    tracker.lastMaxReachableY = maxReachableY;
  };
  // Subscribe via `useLocaleText()` so host-relayed or settings-driven locale
  // changes re-render the label and screen-reader strings live.
  const copy = useLocaleText();
  const isZhLocale = currentLocale() === "zh-CN";
  const settledPreview = reasoningPreview(text, false);
  const isSingleLineThought = text.trim() === settledPreview.trim();
  const effectivePhase: "streaming" | "complete" = growing ? "streaming" : phase;
  const wasStreamingTranslateRef = useRef<boolean>(phase === "streaming" || effectivePhase === "streaming");
  const prevTranslateKeyRef = useRef<string | undefined>(durationKey);
  const translateRowEpochRef = useRef<number>(0);
  if (prevTranslateKeyRef.current !== durationKey) {
    if (!continuedKeyShift) {
      wasStreamingTranslateRef.current = phase === "streaming" || effectivePhase === "streaming";
      translateRowEpochRef.current += 1;
    }
    prevTranslateKeyRef.current = durationKey;
  }
  if (phase === "streaming" || effectivePhase === "streaming") {
    wasStreamingTranslateRef.current = true;
  }
  const translateRowEpoch = translateRowEpochRef.current;
  const translateRowKey = durationKey !== undefined ? `${translateRowEpoch}` : undefined;
  // Translate short/medium settled thoughts (<=1500 chars) in full while collapsed
  // so clicking to expand renders Chinese in 0ms instead of showing a loading placeholder.
  const eagerFullEligible =
    phase === "complete" && text.length <= EAGER_FULL_TRANSLATE_MAX_CHARS;
  const streamingTranslateEnabled =
    isZhLocale &&
    (phase === "streaming" ||
      open ||
      wasStreamingTranslateRef.current ||
      eagerFullEligible);
  const {
    translated: liveTranslatedFull,
    latestTranslatedLine,
    pending: translationPending,
  } = useStreamingTranslatedThinking(
    text,
    phase,
    streamingTranslateEnabled,
    translateRowKey,
  );
  const previewReady =
    isZhLocale &&
    !streamingTranslateEnabled &&
    isPreviewReadyForTranslation(text, settledPreview, phase);
  const fallbackTranslatedPreview = useTranslatedThinking(settledPreview, previewReady);
  const translatedPreview =
    liveTranslatedFull !== ""
      ? reasoningPreview(liveTranslatedFull, false)
      : fallbackTranslatedPreview;
  const effectiveFullTranslation =
    liveTranslatedFull !== ""
      ? liveTranslatedFull
      : isSingleLineThought
        ? fallbackTranslatedPreview
        : "";
  const [showOriginal, setShowOriginal] = useState(false);
  useEffect(() => {
    setShowOriginal(false);
  }, [translateRowEpoch]);
  const pendingPlaceholder =
    translationPending && !showOriginal
      ? effectivePhase === "streaming"
        ? "推理中…"
        : "正在加载译文…"
      : "";
  const displayText =
    effectiveFullTranslation !== "" && !showOriginal
      ? effectiveFullTranslation
      : pendingPlaceholder !== ""
        ? fallbackTranslatedPreview !== ""
          ? `${fallbackTranslatedPreview}\n\n…`
          : pendingPlaceholder
        : text;
  const isBodyPlaceholder =
    effectiveFullTranslation === "" &&
    pendingPlaceholder !== "" &&
    fallbackTranslatedPreview === "";
  const bodyInk = useExpandedBodyInkReveal(
    displayText,
    open,
    growing,
    isBodyPlaceholder,
    `${translateRowEpoch}:${showOriginal ? "orig" : "zh"}`,
  );


  // While streaming the collapsed line is a **tail window** advancing character
  // by character to the left — identical for both DSH native streams and
  // Antigravity translated Chinese streams. Keyed on `growing` (not the host's
  // flickering `phase`) on real devices so brief chunk-settle `complete` frames
  // never reset the scroll cursor or skip mid-thought characters.
  const hasRaf = typeof globalThis.requestAnimationFrame === "function";
  const isWebSmoothMarquee = Platform?.OS === "web" && hasRaf;
  const isNativeSmoothMarquee =
    typeof Platform?.OS === "string" &&
    Platform.OS !== "web" &&
    typeof Animated?.Value === "function" &&
    typeof Animated?.timing === "function" &&
    typeof Animated?.View !== "undefined" &&
    typeof Easing?.linear === "function";
  const hasLiveMarquee = hasRaf || isNativeSmoothMarquee;
  const isLiveCollapsedStream =
    growing && (hasLiveMarquee ? true : phase === "streaming") && !open && lineWidth > 0;
  const rowLineHeight = Math.min(ROW_LINE_HEIGHT, style.toolRowMinHeight);
  const scrollSource =
    liveTranslatedFull !== "" && !showOriginal
      ? liveTranslatedFull
      : pendingPlaceholder !== ""
        ? ""
        : text;
  const webMarquee = useSmoothWebMarquee(
    scrollSource,
    isLiveCollapsedStream && scrollSource !== "",
    growing,
    lineWidth,
    translateRowEpoch,
  );
  const nativeMarquee = useNativeSmoothMarquee(
    scrollSource,
    isLiveCollapsedStream && scrollSource !== "",
    growing,
    lineWidth,
    rowLineHeight,
    translateRowEpoch,
  );
  const useFallbackLeftScroll = !isWebSmoothMarquee && !isNativeSmoothMarquee;
  const pacedStream = useLeftScrollText(
    scrollSource,
    useFallbackLeftScroll && isLiveCollapsedStream && scrollSource !== "",
    useFallbackLeftScroll && growing,
    translateRowEpoch,
  );
  const rawLine =
    growing && phase === "streaming" && lineWidth > 0
      ? streamingTail(text, lineWidth, ROW_FONT_SIZE)
      : reasoningPreview(text, growing && phase === "streaming");
  const streamingScrolledLine =
    isLiveCollapsedStream && pacedStream.text !== ""
      ? streamingTail(pacedStream.text, lineWidth, ROW_FONT_SIZE)
      : "";
  const streamingTranslatedFallback =
    growing && phase === "streaming" && !showOriginal && latestTranslatedLine !== ""
      ? latestTranslatedLine
      : "";
  const line =
    streamingScrolledLine !== ""
      ? streamingScrolledLine
      : streamingTranslatedFallback !== ""
        ? streamingTranslatedFallback
        : !(growing && phase === "streaming") && translatedPreview !== "" && !showOriginal
          ? translatedPreview
          : pendingPlaceholder !== ""
            ? pendingPlaceholder
            : rawLine;
  const tailSliding =
    growing &&
    lineWidth > 0 &&
    (webMarquee.active ||
      nativeMarquee.active ||
      pacedStream.active ||
      (phase === "streaming" && line.endsWith("…")));
  const stream = useInkStreamReveal({
    agentId,
    timestamp,
    rowKey,
    liveHint: phase === "streaming",
    label: copy.thinking,
    summary: !open && !tailSliding ? line : "",
    streamSummary: !open && !tailSliding,
  });

  const styles = useMemo(() => {
    return {
      // DSH renders a thought and a tool call through the same DisclosureRow, so
      // the two rows must not disagree about their rhythm: same 24px line, same
      // head gap, no vertical padding of their own (overridable via settings).
      root: {
        gap: ROW_GAP,
        marginVertical: style.rowMarginY,
        paddingVertical: style.toolRowPaddingY,
      },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: style.toolRowGap,
        minHeight: style.toolRowMinHeight,
      },
      main: {
        position: "relative" as const,
        flex: 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
      },
      textRow: {
        flex: 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: style.toolRowGap,
      },
      label: {
        flexShrink: 0,
        color: theme.colors.foregroundMuted,
        fontSize: ROW_FONT_SIZE,
        lineHeight: rowLineHeight,
        opacity: growing ? 0.9 : 0.6,
      },
      line: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.foregroundMuted,
        fontSize: ROW_FONT_SIZE,
        lineHeight: rowLineHeight,
        opacity: growing ? 0.95 : 0.7,
      },
      durationBox: {
        flexShrink: 0,
      },
      duration: {
        color: theme.colors.foregroundMuted,
        fontSize: ROW_FONT_SIZE - 1,
        lineHeight: rowLineHeight,
        opacity: growing ? 0.85 : 0.55,
        fontVariant: ["tabular-nums" as const],
      },
      fullScroll: {
        maxHeight: expandedMaxHeight,
      },
      full: {
        marginLeft: BODY_INDENT,
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 13 : 14,
        lineHeight: layout.compact ? 19 : 21,
        opacity: 0.8,
      },
    };
  }, [theme, layout.compact, growing, style, expandedMaxHeight]);

  const bodyLineHeight = layout.compact ? 19 : 21;
  const frozenBodyElement = useMemo(
    () =>
      bodyInk.active && bodyInk.frozenText !== "" ? (
        <Text style={styles.full} selectable>
          {bodyInk.frozenText}
        </Text>
      ) : null,
    [bodyInk.active, bodyInk.frozenText, styles.full],
  );

  const thinkingPulseOwner = useIsPulseOwner(agentId, growing && !open);
  const thinkingIconStatus = resolveThinkingIconStatus(growing);
  const thinkingStatusLabel =
    thinkingIconStatus === "idle" ? "" : copy.rowStatus[thinkingIconStatus];

  return (
    <RowEntrance
      agentId={agentId}
      timestamp={timestamp}
      rowKey={rowKey}
      liveHint={phase === "streaming" || growing}
    >
      <View style={styles.root}>
        {/* The head row toggles open/closed; the expanded body sits beside it in
            its own bounded ScrollView so scrolling long thoughts never competes
            with tapping the toggle or pushes the timeline off screen. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            thinkingStatusLabel === ""
              ? open ? copy.collapseThinking : copy.expandThinking
              : `${open ? copy.collapseThinking : copy.expandThinking} · ${thinkingStatusLabel}`
          }
          onPress={() => setManual((value) => !(value ?? false))}
          onPressIn={() => {
            if (isZhLocale && !open && effectiveFullTranslation === "") {
              prefetchThinkingTranslation(text);
            }
          }}
          onHoverIn={() => {
            if (isZhLocale && !open && effectiveFullTranslation === "") {
              prefetchThinkingTranslation(text);
            }
          }}
          style={styles.row}
          onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
        >
          <RowStatusIcon
            status={resolveThinkingIconStatus(growing)}
            size={THINK_ICON_SIZE}
            colors={theme.colors}
            spinBase
            accessibilityLabel={thinkingStatusLabel || undefined}
          >
            <Image
              source={{ uri: THINK_ICON }}
              style={{ width: THINK_ICON_SIZE, height: THINK_ICON_SIZE }}
              tintColor={theme.colors.foregroundMuted}
            />
          </RowStatusIcon>
          <View style={styles.main}>
            <TextShimmer
              active={growing && !open && thinkingPulseOwner}
              contentStyle={styles.textRow}
              highlightColor={theme.colors.foreground}
              surfaceColor={theme.colors.surface0}
            >
              {(color) => (
                <>
                  {/* DSH titles every reasoning row "思考" (its English table says
                      "Thinking") and never swaps it for a finished form; the
                      "已思考" string it ships belongs to its collapsed whole-turn
                      summary, not to this row. */}
                  <Text
                    style={[styles.label, color === null ? null : { color }]}
                    onLayout={(event) => setLabelWidth(event.nativeEvent.layout.width)}
                  >
                    {renderInkTrailText(
                      copy.thinking,
                      stream.labelProgress,
                      theme.colors.foreground,
                      color,
                      0,
                      theme.colors.foregroundMuted,
                    )}
                  </Text>
                  {!open ? (
                    webMarquee.active ? (
                      <SmoothMarqueeLine
                        controller={webMarquee}
                        style={[styles.line, color === null ? null : { color }]}
                      />
                    ) : nativeMarquee.active ? (
                      <NativeSmoothMarqueeLine
                        controller={nativeMarquee}
                        style={[styles.line, color === null ? null : { color }]}
                        measure={color === null}
                      />
                    ) : (
                      <Text
                        style={[styles.line, color === null ? null : { color }]}
                        numberOfLines={1}
                      >
                        {renderInkTrailText(
                          line,
                          stream.summaryProgress,
                          theme.colors.foreground,
                          color,
                          0,
                          theme.colors.foregroundMuted,
                        )}
                      </Text>
                    )
                  ) : null}
                </>
              )}
            </TextShimmer>
            {!open && nativeMarquee.active ? (
              <NativeMarqueeEdgeVeil
                controller={nativeMarquee}
                surfaceColor={theme.colors.surface0}
                offsetLeft={labelWidth + style.toolRowGap}
              />
            ) : null}
          </View>
          {open && (effectiveFullTranslation !== "" || translationPending) ? (
            <Pressable
              accessibilityRole="button"
              onPress={(event: { stopPropagation?: () => void }) => {
                event?.stopPropagation?.();
                setShowOriginal((prev) => !prev);
              }}
              style={{ flexShrink: 0, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 }}
            >
              <Text style={styles.duration} numberOfLines={1}>
                {showOriginal ? "查看译文" : "查看原文"}
              </Text>
            </Pressable>
          ) : null}
          {durationText !== "" ? (
            <View
              style={styles.durationBox}
              onLayout={(event) => setDurationWidth(event.nativeEvent.layout.width)}
            >
              <Text style={styles.duration} numberOfLines={1} testID={THINKING_DURATION_TEST_ID}>
                {durationText}
              </Text>
            </View>
          ) : null}
        </Pressable>
        {open ? (
          // Render the raw source, not the paced reveal: a per-frame re-render of
          // a very long thought is what froze the app before. Wrapping the inner
          // content in a Pressable lets short taps collapse the scroll box while
          // scroll gestures still pan smoothly on iOS/Android/Web.
          <ScrollView
            ref={scrollRef}
            style={styles.fullScroll}
            nestedScrollEnabled
            scrollEventThrottle={16}
            onLayout={handleScrollLayout}
            onContentSizeChange={handleContentSizeChange}
            onScroll={handleBodyScroll}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScrollEndDrag={handleScrollEndDrag}
            onMomentumScrollBegin={handleMomentumScrollBegin}
            onMomentumScrollEnd={handleMomentumScrollEnd}
            testID={SCROLL_BOX_TEST_ID}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.collapseThinking}
              onPress={collapseBody}
            >
              {bodyInk.active ? (
                <>
                  {frozenBodyElement}
                  <Text
                    style={
                      bodyInk.frozenText !== "" && bodyInk.gapLines > 0
                        ? [styles.full, { marginTop: bodyInk.gapLines * bodyLineHeight }]
                        : styles.full
                    }
                    selectable
                  >
                    {renderExpandedBloomText(
                      bodyInk.activeText,
                      bodyInk.localProgress,
                      theme.colors.foregroundMuted,
                      bodyInk.localSettledFloor,
                    )}
                  </Text>
                </>
              ) : (
                <Text style={styles.full} selectable>
                  {displayText}
                </Text>
              )}
            </Pressable>
          </ScrollView>
        ) : null}
      </View>
    </RowEntrance>
  );
}

function NativeSmoothMarqueeLine({
  controller,
  style,
  measure,
}: {
  controller: NativeMarqueeController;
  style: StyleProp<TextStyle>;
  measure: boolean;
}) {
  if (!controller.clipX || !controller.innerX) return null;
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        height: controller.rowLineHeight,
        overflow: "hidden",
      }}
    >
      <Animated.View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: controller.lineWidth,
          overflow: "hidden",
          transform: [{ translateX: controller.clipX }],
        }}
      >
        <Animated.View
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: controller.trackWidth,
            flexDirection: "row",
            alignItems: "center",
            transform: [{ translateX: controller.innerX }],
          }}
        >
          {controller.retiredWidth > 0 ? (
            <View
              style={{
                width: controller.retiredWidth,
                height: 1,
                flexShrink: 0,
              }}
            />
          ) : null}
          {controller.mountedChunks.map((chunk, localIdx) => {
            const chunkIndex = controller.retiredCount + localIdx;
            return (
              <Text
                key={chunkIndex}
                style={[style, { flex: 0, flexGrow: 0, flexShrink: 0 }]}
                onLayout={
                  measure
                    ? (event) =>
                        controller.onChunkLayout(
                          chunkIndex,
                          event.nativeEvent.layout.width,
                        )
                    : undefined
                }
              >
                {chunk}
              </Text>
            );
          })}
          {controller.hasTailPad ? (
            <View
              style={{
                width: MARQUEE_RIGHT_FADE_PX,
                height: 1,
                flexShrink: 0,
              }}
            />
          ) : null}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/**
 * GPU-driven (`useNativeDriver: true`) dual-edge Hermite `surface0` curtains
 * mounted above `TextShimmer` on iOS/Android so both base scrolling text and
 * `SweepNative`'s shimmer slices dissolve smoothly with zero cut line.
 */
function NativeMarqueeEdgeVeil({
  controller,
  surfaceColor,
  offsetLeft,
}: {
  controller: NativeMarqueeController;
  surfaceColor: string;
  offsetLeft: number;
}) {
  const leftWidth = Math.min(
    MARQUEE_LEFT_FADE_PX,
    Math.max(12, Math.floor(controller.lineWidth * 0.28)),
  );
  const rightWidth = Math.min(
    MARQUEE_RIGHT_FADE_PX,
    Math.max(12, Math.floor(controller.lineWidth * 0.24)),
  );

  const leftBands = useMemo(
    () =>
      NATIVE_LEFT_FADE_ALPHAS.map((alpha, idx) => {
        const tinted = withAlpha(surfaceColor, alpha);
        return (
          <View
            key={idx}
            style={
              tinted !== "transparent"
                ? { flex: 1, backgroundColor: tinted }
                : { flex: 1, backgroundColor: surfaceColor, opacity: alpha }
            }
          />
        );
      }),
    [surfaceColor],
  );

  const rightBands = useMemo(
    () =>
      NATIVE_RIGHT_FADE_ALPHAS.map((alpha, idx) => {
        const tinted = withAlpha(surfaceColor, alpha);
        return (
          <View
            key={idx}
            style={
              tinted !== "transparent"
                ? { flex: 1, backgroundColor: tinted }
                : { flex: 1, backgroundColor: surfaceColor, opacity: alpha }
            }
          />
        );
      }),
    [surfaceColor],
  );

  if (
    !controller.clipX ||
    !controller.leftFadeOpacity ||
    !controller.rightFadeOpacity ||
    controller.lineWidth <= 0
  ) {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      aria-hidden
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: offsetLeft,
        width: controller.lineWidth,
        overflow: "hidden",
      }}
    >
      <Animated.View
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: leftWidth,
          flexDirection: "row",
          opacity: controller.leftFadeOpacity,
        }}
      >
        {leftBands}
      </Animated.View>
      <Animated.View
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: controller.lineWidth,
          transform: [{ translateX: controller.clipX }],
        }}
      >
        <Animated.View
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: rightWidth,
            flexDirection: "row",
            opacity: controller.rightFadeOpacity,
          }}
        >
          {rightBands}
        </Animated.View>
      </Animated.View>
    </View>
  );
}
