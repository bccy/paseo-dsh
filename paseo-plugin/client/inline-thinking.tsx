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
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import {
  EXPANDED_MAX_HEIGHT_DEFAULT,
  TIMELINE_STYLE_DEFAULTS,
  timelineStyleSettings,
} from "../shared/settings";
import { normalizeRowTimestamp, noteRender } from "./newest";
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
import { useTranslatedThinking } from "./thinking-translate";
import { isPreviewReadyForTranslation } from "../shared/translate-text";
import { formatThinkingDuration, reasoningPreview, streamingTail } from "./thinking-text";
import { BODY_INDENT, ROW_FONT_SIZE, ROW_GAP, ROW_LINE_HEIGHT } from "./tokens";
import { useLocaleText } from "./use-locale";

/**
 * DSH's thinking icon (`PROCESS_ICONS.thinking` = `IconThinkOutlineRegular`:
 * two petals crossed on the diagonal plus a filled centre dot, `viewBox 16`,
 * 1px stroke, drawn at 16). Rasterized at exactly 4x and shown at 16 so the
 * stroke lands on whole pixels; `tintColor` replaces `currentColor`.
 */
const THINK_ICON = "data:image/png;base64,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";

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
  const previewReady = isZhLocale && isPreviewReadyForTranslation(text, settledPreview, phase);
  const translatedPreview = useTranslatedThinking(settledPreview, previewReady);
  const isSingleLineThought = text.trim() === settledPreview.trim();
  const fullReady = isZhLocale && open && phase === "complete" && !isSingleLineThought;
  const translatedFull = useTranslatedThinking(text, fullReady);
  const effectiveFullTranslation = isSingleLineThought ? translatedPreview : translatedFull;
  const [showOriginal, setShowOriginal] = useState(false);
  const displayText = effectiveFullTranslation !== "" && !showOriginal ? effectiveFullTranslation : text;


  // While streaming the collapsed line is a **tail window**: it advances with
  // every arrived character instead of waiting for a paragraph to finish, which
  // is what made it lag the expanded view. Once `phase` flips to `"complete"`
  // the collapsed summary snaps immediately to DSH's completed first-line rule
  // (avoiding a 300ms tail hold or an empty first frame on short unmeasured
  // thoughts), while the status icon, shimmer, and duration still keep the
  // 300ms `growing` debounce.
  const rawLine =
    growing && phase === "streaming" && lineWidth > 0
      ? streamingTail(text, lineWidth, ROW_FONT_SIZE)
      : reasoningPreview(text, growing && phase === "streaming");
  const line =
    !(growing && phase === "streaming") && translatedPreview !== "" && !showOriginal
      ? translatedPreview
      : rawLine;
  const tailSliding = growing && phase === "streaming" && lineWidth > 0 && line.endsWith("…");
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
    const rowLineHeight = Math.min(ROW_LINE_HEIGHT, style.toolRowMinHeight);
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
              active={growing && !open}
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
                    {renderInkTrailText(copy.thinking, stream.labelProgress, theme.colors.foreground, color)}
                  </Text>
                  {!open ? (
                    <Text
                      style={[styles.line, color === null ? null : { color }]}
                      numberOfLines={1}
                    >
                      {renderInkTrailText(line, stream.summaryProgress, theme.colors.foreground, color)}
                    </Text>
                  ) : null}
                </>
              )}
            </TextShimmer>
          </View>
          {open && effectiveFullTranslation !== "" ? (
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
              <Text style={styles.full} selectable>
                {displayText}
              </Text>
            </Pressable>
          </ScrollView>
        ) : null}
      </View>
    </RowEntrance>
  );
}
