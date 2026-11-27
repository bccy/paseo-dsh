/**
 * Zero-flash, native-GPU soft-mist renderer for live streaming assistant replies.
 *
 * Architecture:
 * 1. **100% real Paseo `<Markdown>`**: every block renders through Paseo's host
 *    `<Markdown>` component, automatically inheriting the user's Appearance
 *    font size, font family, `density.blockGap`, `accentBright`, workspace file
 *    links, tables, code blocks, and native text selection.
 * 2. **Stable-index block freezing + double-buffered unified merge**:
 *    - During streaming, `splitStableMarkdownBlocks` splits the stream into
 *      `settledBlocks` (frozen behind `React.memo` at stable indices so earlier
 *      blocks NEVER re-parse when new tokens arrive) plus one trailing
 *      `activeBlock` throttled to `64ms` (~15 Hz) with immediate synchronous
 *      flush on new block boundaries or `phase === "complete"`.
 *    - Once `phase === "complete"` and the 280ms mist settle window finishes on
 *      a multi-block reply, a single unified `<Markdown>{text}</Markdown>` is
 *      pre-warmed off-flow at `opacity: 0` inside the exact same plugin row.
 *      Only after its `onLayout(height > 0)` (or 120ms safety fallback) confirms
 *      iOS `EnrichedMarkdown` AST parsing has landed does it swap in at
 *      `opacity: 1` and unmount the split blocks — restoring full Markdown
 *      fidelity (reference links `[x][1]`, cross-paragraph selection, loose
 *      lists) with 0 flash and 0 LegendList ID swap.
 * 3. **120Hz native GPU mist veil (zero JS `requestAnimationFrame` loops)**:
 *    - Newly appearing blocks wait for `onLayout(height > 0)` (masking iOS
 *      `EnrichedMarkdown` async AST first-frame blank) before running a 280ms
 *      ease-out cubic `opacity: 0 -> 1` native-driver fade (with 55ms batch
 *      stagger capped at 275ms).
 *    - While streaming (and for a 280ms settle window on completion), a 5-band
 *      `theme.colors.surface0` soft mist curtain overlays the active block's
 *      bottom ~56px (`pointerEvents="none"`) and glides smoothly away via
 *      `Animated.parallel` (`useNativeDriver: true`) whenever new lines arrive,
 *      then unmounts completely when idle (0 extra GPU layers at rest).
 * 4. **Native Paseo >= 0.18.1 Turn Footer**: Paseo automatically attaches its
 *    native Copy Result / Fork / Turn Timing footer to this plugin row via
 *    `source: item`, so we draw zero duplicate footer chrome.
 *
 * @module dsh-paseo/client/assistant-bloom
 */
import { useAgent, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Animated,
  Easing,
  Platform,
  View,
  type LayoutChangeEvent,
} from "react-native";
import {
  readLiveBloomState,
  writeLiveBloomState,
  type LiveBloomState,
} from "./assistant-bloom-handoff";
import { normalizeRowTimestamp, yieldRowPulse } from "./newest";
import {
  clearActiveBloom,
  markAgentLiveActivity,
  reportActiveBloom,
} from "./row-cascade";
import {
  ACTIVE_BLOCK_THROTTLE_MS,
  countCodePoints,
  shouldFlushActiveBlockImmediately,
  shouldMergeToUnifiedMarkdown,
  shouldStartAssistantBloomFromZero,
  splitStableMarkdownBlocks,
} from "./thinking-text";
import { withAlpha } from "./tokens";

export interface AssistantBloomData {
  text: string;
  phase: "streaming" | "complete";
  bloomKey?: string;
}

const BLOCK_ENTRANCE_DURATION_MS = 280;
const BLOCK_STAGGER_STEP_MS = 55;
const BLOCK_STAGGER_MAX_MS = 275;
const BLOCK_LAYOUT_FALLBACK_MS = 120;
const UNIFIED_MERGE_FALLBACK_MS = 120;
const MIST_VEIL_HEIGHT_PX = 56;
const MIST_VEIL_DURATION_MS = 300;
const MIST_TAIL_SETTLE_MS = 280;
const MIST_TEXT_GROWTH_THRESHOLD = 14;
const MIST_RETRIGGER_COOLDOWN_MS = 140;
/** Throttle interval (ms) for publishing active-bloom handoff hints to `row-cascade`. */
const CASCADE_REPORT_THROTTLE_MS = 120;
const CASCADE_REPORT_REMAINING_MS = 200;
/** Heartbeat interval (ms) to keep `row-cascade`'s 15s live-activity window fresh on long streams. */
const LIVE_ACTIVITY_HEARTBEAT_MS = 5_000;

/** 5 stepped horizontal bands (top -> bottom) forming a wide ~56px mist curtain. */
const MIST_BAND_ALPHAS = [0.08, 0.24, 0.48, 0.76, 0.96] as const;

const WEB_BLOOM_STYLE_ID = "dsh-assistant-bloom-styles";
const WEB_BLOCK_ENTER_TEST_ID = "dsh-bloom-block-enter";
const WEB_MIST_SWEEP_TEST_ID = "dsh-bloom-mist-sweep";

const ROOT_STYLE = { position: "relative" as const, paddingTop: 4, paddingBottom: 4 };
const UNIFIED_PREWARM_STYLE = {
  position: "absolute" as const,
  top: 4,
  left: 0,
  right: 0,
  opacity: 0,
};

interface WebStyleElement {
  id: string;
  textContent: string | null;
}

interface WebStyleDocument {
  getElementById?: (id: string) => unknown;
  createElement?: (tag: string) => WebStyleElement;
  head?: { appendChild?: (el: WebStyleElement) => void };
  documentElement?: { appendChild?: (el: WebStyleElement) => void };
}

function isWebPlatform(): boolean {
  return Platform?.OS === "web";
}

function canUseNativeAnimated(): boolean {
  return (
    !isWebPlatform() &&
    typeof Animated?.View !== "undefined" &&
    typeof Animated?.Value === "function" &&
    typeof Animated?.timing === "function"
  );
}

function easeOutCubic() {
  return typeof Easing?.out === "function" && Easing?.cubic
    ? Easing.out(Easing.cubic)
    : undefined;
}

function ensureWebBloomStyles(): void {
  const doc = (globalThis as { document?: WebStyleDocument }).document;
  if (!doc || typeof doc.getElementById !== "function" || doc.getElementById(WEB_BLOOM_STYLE_ID)) {
    return;
  }
  const head = doc.head ?? doc.documentElement;
  if (!head || typeof head.appendChild !== "function" || typeof doc.createElement !== "function") {
    return;
  }
  const style = doc.createElement("style");
  style.id = WEB_BLOOM_STYLE_ID;
  style.textContent = [
    `@keyframes dsh-bloom-fade-in{from{opacity:0}to{opacity:1}}`,
    `@keyframes dsh-bloom-mist-sweep{0%{opacity:0.95;transform:translateY(-10px)}100%{opacity:0;transform:translateY(12px)}}`,
    `[data-testid="${WEB_BLOCK_ENTER_TEST_ID}"]{animation:dsh-bloom-fade-in ${BLOCK_ENTRANCE_DURATION_MS}ms cubic-bezier(0.215,0.61,0.355,1) both}`,
    `[data-testid="${WEB_MIST_SWEEP_TEST_ID}"]{animation:dsh-bloom-mist-sweep ${MIST_VEIL_DURATION_MS}ms cubic-bezier(0.215,0.61,0.355,1) forwards}`,
  ].join("\n");
  head.appendChild(style);
}

// Eagerly inject Web CSS keyframes at module load so the very first mounted
// block never flashes unstyled for one frame before effects commit.
if (
  isWebPlatform() &&
  typeof (globalThis as { document?: WebStyleDocument }).document !== "undefined"
) {
  ensureWebBloomStyles();
}

const useIsomorphicLayoutEffect =
  typeof (globalThis as { document?: unknown }).document !== "undefined"
    ? useLayoutEffect
    : useEffect;

/**
 * Throttles active trailing-block updates to `ACTIVE_BLOCK_THROTTLE_MS` (~15 Hz)
 * while streaming, and flushes synchronously with zero latency whenever a new
 * settled block closes or `phase` reaches `"complete"`.
 */
function useThrottledActiveBlock(
  activeBlock: string,
  settledCount: number,
  phase: "streaming" | "complete",
  active: boolean,
): string {
  const [committed, setCommitted] = useState<string>(activeBlock);
  const lastCommitAtRef = useRef<number>(Date.now());
  const prevSettledCountRef = useRef<number>(settledCount);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const immediate =
    !active ||
    shouldFlushActiveBlockImmediately({
      prevSettledCount: prevSettledCountRef.current,
      nextSettledCount: settledCount,
      phase,
      hasCommittedText: committed.length > 0,
      nextActiveText: activeBlock,
    });

  useEffect(() => {
    prevSettledCountRef.current = settledCount;
    if (immediate) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      lastCommitAtRef.current = Date.now();
      setCommitted(activeBlock);
      return;
    }

    if (activeBlock === committed) return;

    const now = Date.now();
    const elapsed = now - lastCommitAtRef.current;
    if (elapsed >= ACTIVE_BLOCK_THROTTLE_MS) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      lastCommitAtRef.current = now;
      setCommitted(activeBlock);
      return;
    }

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    const waitMs = Math.max(1, ACTIVE_BLOCK_THROTTLE_MS - elapsed);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastCommitAtRef.current = Date.now();
      setCommitted(activeBlock);
    }, waitMs);
  }, [activeBlock, settledCount, immediate, committed]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return immediate ? activeBlock : committed;
}

interface MistVeilOverlayProps {
  readonly surfaceColor: string;
  readonly pulseId: number;
  readonly intensity: number;
}

/**
 * Wide (~56px) 5-band stepped soft-mist frontier built strictly from host
 * `theme.colors.surface0` `View` bands (no SVG/MaskedView required).
 * Animated purely on the native GPU driver (or Web CSS keyframes) and unmounted
 * completely once streaming settles.
 */
const MistVeilOverlay = memo(function MistVeilOverlay({
  surfaceColor,
  pulseId,
  intensity,
}: MistVeilOverlayProps) {
  const web = isWebPlatform();
  const nativeAnim = canUseNativeAnimated();
  const opacityRef = useRef<InstanceType<typeof Animated.Value> | null>(null);
  const translateYRef = useRef<InstanceType<typeof Animated.Value> | null>(null);
  const runningRef = useRef<Animated.CompositeAnimation | null>(null);

  if (nativeAnim) {
    if (opacityRef.current === null) opacityRef.current = new Animated.Value(0);
    if (translateYRef.current === null) translateYRef.current = new Animated.Value(0);
  }

  useIsomorphicLayoutEffect(() => {
    if (web) ensureWebBloomStyles();
  }, [web]);

  useEffect(() => {
    if (!nativeAnim || pulseId <= 0 || !opacityRef.current || !translateYRef.current) return;
    runningRef.current?.stop();
    const startOpacity = Math.max(0.45, Math.min(0.95, intensity));
    opacityRef.current.setValue(startOpacity);
    translateYRef.current.setValue(-10);
    const easing = easeOutCubic();
    const anim = Animated.parallel([
      Animated.timing(opacityRef.current, {
        toValue: 0,
        duration: MIST_VEIL_DURATION_MS,
        useNativeDriver: true,
        ...(easing !== undefined ? { easing } : {}),
      }),
      Animated.timing(translateYRef.current, {
        toValue: 12,
        duration: MIST_VEIL_DURATION_MS,
        useNativeDriver: true,
        ...(easing !== undefined ? { easing } : {}),
      }),
    ]);
    runningRef.current = anim;
    anim.start(({ finished }) => {
      if (finished && runningRef.current === anim) {
        runningRef.current = null;
      }
    });
    return () => {
      anim.stop();
    };
  }, [nativeAnim, pulseId, intensity]);

  const bands = useMemo(
    () =>
      MIST_BAND_ALPHAS.map((alpha, idx) => {
        const tinted = withAlpha(surfaceColor, alpha);
        const style =
          tinted !== "transparent"
            ? { flex: 1 as const, backgroundColor: tinted }
            : { flex: 1 as const, backgroundColor: surfaceColor, opacity: alpha };
        return <View key={idx} style={style} />;
      }),
    [surfaceColor],
  );

  if (pulseId <= 0) return null;

  if (web) {
    return (
      <View
        key={pulseId}
        testID={WEB_MIST_SWEEP_TEST_ID}
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: MIST_VEIL_HEIGHT_PX,
        }}
      >
        {bands}
      </View>
    );
  }

  if (nativeAnim && opacityRef.current && translateYRef.current) {
    const AnimatedView = Animated.View;
    return (
      <AnimatedView
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: MIST_VEIL_HEIGHT_PX,
          opacity: opacityRef.current,
          transform: [{ translateY: translateYRef.current }],
        }}
      >
        {bands}
      </AnimatedView>
    );
  }

  return null;
});

interface MarkdownBlockItemProps {
  readonly content: string;
  readonly animateEntrance: boolean;
  readonly staggerDelayMs: number;
  readonly mistActive: boolean;
  readonly streaming: boolean;
  readonly surfaceColor: string;
}

/**
 * Stable-key Markdown block wrapper.
 *
 * - Settled blocks keep identical props and stay frozen behind `React.memo`
 *   (zero re-renders and zero Markdown re-parsing as later tokens stream in).
 * - Newly mounted live blocks stay at `opacity: 0` until `onLayout` reports
 *   `height > 0` (covering iOS `EnrichedMarkdown` async first-frame blank),
 *   then glide in on the native GPU driver in 280ms.
 * - The trailing active block stays mounted on the exact same component type
 *   and key when it transitions from active -> settled or streaming -> complete,
 *   guaranteeing zero unmount/remount flicker.
 */
const MarkdownBlockItem = memo(function MarkdownBlockItem({
  content,
  animateEntrance,
  staggerDelayMs,
  mistActive,
  streaming,
  surfaceColor,
}: MarkdownBlockItemProps) {
  const web = isWebPlatform();
  const nativeAnim = canUseNativeAnimated();
  const initialAnimateRef = useRef<boolean>(animateEntrance);
  const initialDelayRef = useRef<number>(staggerDelayMs);
  const entranceStartedRef = useRef<boolean>(!initialAnimateRef.current);
  const entranceAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const opacityRef = useRef<InstanceType<typeof Animated.Value> | null>(null);

  if (nativeAnim && initialAnimateRef.current && opacityRef.current === null) {
    opacityRef.current = new Animated.Value(0);
  }

  const prevHeightRef = useRef<number>(0);
  const prevLenRef = useRef<number>(content.length);
  const lastPulseAtRef = useRef<number>(0);
  const [mistPulse, setMistPulse] = useState<{ id: number; intensity: number }>({
    id: 0,
    intensity: 0.95,
  });

  const triggerEntrance = useCallback(() => {
    if (entranceStartedRef.current) return;
    entranceStartedRef.current = true;
    if (!nativeAnim || !opacityRef.current) return;
    const easing = easeOutCubic();
    const anim = Animated.timing(opacityRef.current, {
      toValue: 1,
      duration: BLOCK_ENTRANCE_DURATION_MS,
      delay: initialDelayRef.current,
      useNativeDriver: true,
      ...(easing !== undefined ? { easing } : {}),
    });
    entranceAnimRef.current = anim;
    anim.start();
  }, [nativeAnim]);

  useIsomorphicLayoutEffect(() => {
    if (web && initialAnimateRef.current) {
      ensureWebBloomStyles();
    }
  }, [web]);

  // Unconditional unmount cleanup so an entrance animation started directly from
  // `onLayout` (before the fallback effect ran) is always stopped on unmount.
  useEffect(() => {
    return () => {
      entranceAnimRef.current?.stop();
    };
  }, []);

  // Safety net: ensure a newly mounted block can never stay invisible if a host
  // or zero-height divider omits `onLayout`.
  useEffect(() => {
    if (!nativeAnim || !initialAnimateRef.current || entranceStartedRef.current) return;
    const fallback = setTimeout(
      triggerEntrance,
      BLOCK_LAYOUT_FALLBACK_MS + initialDelayRef.current,
    );
    return () => {
      clearTimeout(fallback);
    };
  }, [nativeAnim, triggerEntrance]);

  const fireMistPulse = useCallback((intensity: number, force: boolean) => {
    const now = Date.now();
    if (!force && now - lastPulseAtRef.current < MIST_RETRIGGER_COOLDOWN_MS) return;
    lastPulseAtRef.current = now;
    setMistPulse((prev) => ({ id: prev.id + 1, intensity }));
  }, []);

  // Trigger a gentle mist pulse when active text grows meaningfully within a line.
  useEffect(() => {
    const delta = content.length - prevLenRef.current;
    prevLenRef.current = content.length;
    if (!mistActive || !streaming || delta < MIST_TEXT_GROWTH_THRESHOLD) return;
    fireMistPulse(0.68, false);
  }, [content.length, mistActive, streaming, fireMistPulse]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextHeight = event?.nativeEvent?.layout?.height ?? 0;
      if (nextHeight > 0 && !entranceStartedRef.current) {
        triggerEntrance();
      }
      const prevHeight = prevHeightRef.current;
      prevHeightRef.current = nextHeight;
      if (mistActive && streaming && prevHeight > 0 && nextHeight > prevHeight + 2) {
        fireMistPulse(0.95, true);
      }
    },
    [triggerEntrance, mistActive, streaming, fireMistPulse],
  );

  const inner = (
    <View style={mistActive ? { position: "relative", overflow: "hidden" } : undefined}>
      <Markdown>{content}</Markdown>
      {mistActive ? (
        <MistVeilOverlay
          surfaceColor={surfaceColor}
          pulseId={mistPulse.id}
          intensity={mistPulse.intensity}
        />
      ) : null}
    </View>
  );

  if (nativeAnim && initialAnimateRef.current && opacityRef.current) {
    const AnimatedView = Animated.View;
    return (
      <AnimatedView onLayout={handleLayout} style={{ opacity: opacityRef.current }}>
        {inner}
      </AnimatedView>
    );
  }

  if (web && initialAnimateRef.current) {
    const webDelayStyle =
      initialDelayRef.current > 0
        ? ({ animationDelay: `${initialDelayRef.current}ms` } as unknown as Record<string, string>)
        : undefined;
    return (
      <View onLayout={handleLayout} testID={WEB_BLOCK_ENTER_TEST_ID} style={webDelayStyle}>
        {inner}
      </View>
    );
  }

  return <View onLayout={mistActive ? handleLayout : undefined}>{inner}</View>;
});

export function AssistantMessageBloom({
  theme,
  layout,
  agentId,
  timestamp,
  item,
}: PluginTimelineItemProps<AssistantBloomData>) {
  const { text, phase, bloomKey } = item.data;
  // Match Paseo `density.blockGap = { xs: 12, md: 16 }` (`styles/density.ts:33`).
  const blockGap = layout.compact ? 12 : 16;
  const agentStatus = useAgent(agentId ?? "", (snapshot) => snapshot.status);
  const rowAt = normalizeRowTimestamp(timestamp);
  const rowIdentity = bloomKey ? `${agentId ?? ""}\0${bloomKey}` : `${agentId ?? ""}\0${rowAt}`;

  const totalCp = useMemo(() => countCodePoints(text), [text]);
  const persisted = readLiveBloomState(bloomKey);
  const initialEverStreamed =
    persisted !== undefined
      ? persisted.everStreamed
      : shouldStartAssistantBloomFromZero({
          phase,
          totalCp,
          agentStatus,
        });

  const prevIdentityRef = useRef<string>(rowIdentity);
  const instanceEpochRef = useRef<number>(0);
  const prevTextRef = useRef<string>(text);
  const everStreamedRef = useRef<boolean>(initialEverStreamed);
  const revealedBlocksRef = useRef<Set<number>>(
    persisted !== undefined ? persisted.revealedBlocks : new Set<number>(),
  );
  // Stable per-block entrance config so `React.memo` never invalidates settled blocks.
  const blockEntranceMapRef = useRef<Map<number, { animate: boolean; delayMs: number }>>(
    new Map(),
  );
  const lastCascadeReportAtRef = useRef<number>(0);
  const lastLiveActivityAtRef = useRef<number>(0);

  const [tailSettling, setTailSettling] = useState<boolean>(false);
  const [unifiedReady, setUnifiedReady] = useState<boolean>(false);

  if (prevIdentityRef.current !== rowIdentity) {
    const isContinuation =
      everStreamedRef.current &&
      prevTextRef.current.length > 0 &&
      text.startsWith(prevTextRef.current);
    prevIdentityRef.current = rowIdentity;
    if (!isContinuation) {
      instanceEpochRef.current += 1;
      const nextPersisted = readLiveBloomState(bloomKey);
      blockEntranceMapRef.current.clear();
      if (nextPersisted !== undefined) {
        everStreamedRef.current = nextPersisted.everStreamed;
        revealedBlocksRef.current = nextPersisted.revealedBlocks;
      } else {
        const fresh = shouldStartAssistantBloomFromZero({
          phase,
          totalCp,
          agentStatus,
        });
        everStreamedRef.current = fresh;
        revealedBlocksRef.current = new Set<number>();
      }
    }
  } else if (
    text !== prevTextRef.current &&
    (phase === "streaming" || text.length > prevTextRef.current.length)
  ) {
    if (!everStreamedRef.current) {
      everStreamedRef.current = true;
    }
  }
  prevTextRef.current = text;
  const everStreamed = everStreamedRef.current;

  const syncState = useCallback(() => {
    if (!bloomKey) return;
    const state: LiveBloomState = {
      everStreamed: everStreamedRef.current,
      revealedBlocks: revealedBlocksRef.current,
    };
    writeLiveBloomState(bloomKey, state);
  }, [bloomKey]);

  const yieldedPulseRowRef = useRef<string | null>(null);

  useEffect(() => {
    if (phase === "streaming" && everStreamed) {
      const now = Date.now();
      lastLiveActivityAtRef.current = now;
      markAgentLiveActivity(agentId, now);
      if (yieldedPulseRowRef.current !== rowIdentity) {
        yieldedPulseRowRef.current = rowIdentity;
        yieldRowPulse(agentId);
      }
      setTailSettling(true);
      setUnifiedReady(false);
      return;
    }
    clearActiveBloom(agentId);
    if (!everStreamed) {
      setTailSettling(false);
      return;
    }
    const timer = setTimeout(() => {
      setTailSettling(false);
    }, MIST_TAIL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [agentId, phase, rowIdentity, everStreamed]);

  useEffect(() => {
    syncState();
  }, [syncState, phase, text]);

  useEffect(() => {
    return () => {
      clearActiveBloom(agentId);
      syncState();
    };
  }, [agentId, syncState]);

  const rawSplit = useMemo(() => splitStableMarkdownBlocks(text), [text]);
  const committedActiveBlock = useThrottledActiveBlock(
    rawSplit.activeBlock,
    rawSplit.settledBlocks.length,
    phase,
    everStreamed,
  );

  // Throttled cascade handoff hint (A-3) + 5s live-activity heartbeat (A-4)
  // while streaming so downstream tool rows cascade smoothly even on >15s replies.
  useEffect(() => {
    if (phase !== "streaming" || !everStreamed) return;
    const now = Date.now();
    if (now - lastCascadeReportAtRef.current >= CASCADE_REPORT_THROTTLE_MS) {
      lastCascadeReportAtRef.current = now;
      reportActiveBloom(agentId, CASCADE_REPORT_REMAINING_MS, undefined, now);
    }
    if (now - lastLiveActivityAtRef.current >= LIVE_ACTIVITY_HEARTBEAT_MS) {
      lastLiveActivityAtRef.current = now;
      markAgentLiveActivity(agentId, now);
    }
  }, [agentId, phase, everStreamed, rawSplit.settledBlocks.length, committedActiveBlock]);

  const totalBlocks = rawSplit.settledBlocks.length + (committedActiveBlock !== "" ? 1 : 0);
  const needsUnifiedMerge =
    everStreamed &&
    shouldMergeToUnifiedMarkdown({
      phase,
      tailSettling,
      blockCount: totalBlocks,
    });

  useEffect(() => {
    setUnifiedReady(false);
  }, [rowIdentity]);

  // Reset double-buffer readiness whenever merge preconditions change (e.g. row
  // identity changes, text updates, or streaming resumes).
  useEffect(() => {
    if (!needsUnifiedMerge) {
      setUnifiedReady(false);
      return;
    }
    if (unifiedReady) return;
    const fallback = setTimeout(() => {
      setUnifiedReady(true);
    }, UNIFIED_MERGE_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [needsUnifiedMerge, unifiedReady, rowIdentity, text]);

  const handleUnifiedLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event?.nativeEvent?.layout?.height ?? 0;
    if (height > 0) {
      setUnifiedReady(true);
    }
  }, []);

  // Idle / reopened / non-live row: render a single native `<Markdown>` on frame 0
  // with zero animation wrappers and zero timers.
  if (!everStreamed) {
    return (
      <View style={ROOT_STYLE}>
        <Markdown>{text}</Markdown>
      </View>
    );
  }

  if (totalBlocks === 0) {
    return <View style={ROOT_STYLE} />;
  }

  const showMist = phase === "streaming" || tailSettling;
  const epoch = instanceEpochRef.current;

  let batchNewIdx = 0;
  const entranceConfigFor = (index: number): { animate: boolean; delayMs: number } => {
    const existing = blockEntranceMapRef.current.get(index);
    if (existing !== undefined) return existing;
    const alreadyRevealed = revealedBlocksRef.current.has(index);
    const config = alreadyRevealed
      ? { animate: false, delayMs: 0 }
      : {
          animate: true,
          delayMs: Math.min(BLOCK_STAGGER_MAX_MS, batchNewIdx * BLOCK_STAGGER_STEP_MS),
        };
    if (!alreadyRevealed) {
      batchNewIdx += 1;
      revealedBlocksRef.current.add(index);
    }
    blockEntranceMapRef.current.set(index, config);
    return config;
  };

  const renderedBlocks = !unifiedReady
    ? (() => {
        const list = [];
        for (let i = 0; i < rawSplit.settledBlocks.length; i += 1) {
          const cfg = entranceConfigFor(i);
          list.push(
            <MarkdownBlockItem
              key={`${epoch}:${i}`}
              content={rawSplit.settledBlocks[i]!}
              animateEntrance={cfg.animate}
              staggerDelayMs={cfg.delayMs}
              mistActive={false}
              streaming={false}
              surfaceColor={theme.colors.surface0}
            />,
          );
        }
        if (committedActiveBlock !== "") {
          const activeIndex = rawSplit.settledBlocks.length;
          const cfg = entranceConfigFor(activeIndex);
          list.push(
            <MarkdownBlockItem
              key={`${epoch}:${activeIndex}`}
              content={committedActiveBlock}
              animateEntrance={cfg.animate}
              staggerDelayMs={cfg.delayMs}
              mistActive={showMist}
              streaming={phase === "streaming"}
              surfaceColor={theme.colors.surface0}
            />,
          );
        }
        return list;
      })()
    : null;

  return (
    <View style={ROOT_STYLE}>
      {renderedBlocks !== null ? (
        <View key={`${epoch}:blocks`} style={{ gap: blockGap }}>
          {renderedBlocks}
        </View>
      ) : null}
      {needsUnifiedMerge ? (
        <View
          key={`${epoch}:unified`}
          onLayout={unifiedReady ? undefined : handleUnifiedLayout}
          pointerEvents={unifiedReady ? "auto" : "none"}
          style={unifiedReady ? undefined : UNIFIED_PREWARM_STYLE}
        >
          <Markdown>{text}</Markdown>
        </View>
      ) : null}
    </View>
  );
}
