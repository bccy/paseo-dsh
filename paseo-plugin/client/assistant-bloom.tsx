/**
 * Global continuous front-to-back soft emergence renderer for live streaming
 * assistant replies across all providers (DSH, Antigravity, Codex, Claude).
 *
 * - Historical / already-complete replies render Paseo's native `<Markdown>`
 *   directly on frame 0 with zero animations and zero timers.
 * - Live streaming replies emerge continuously from front to back through the
 *   same wide 24-char `rgba` soft mist wave (`14–42 chars/sec`, zero vertical
 *   jumping, zero block-by-block popping) with lightweight inline Markdown
 *   styling (bold, inline code, headings, list bullets, link labels).
 * - Fenced code blocks and Markdown tables render in-place via Paseo's
 *   `<Markdown>` with a soft pure-opacity fade (no vertical hop).
 * - Once the reply completes and the emergence wave finishes, it hands off
 *   cleanly to a single Paseo `<Markdown>{text}</Markdown>` for full native
 *   links, tables, code copy buttons, and cross-paragraph selection.
 *
 * @module dsh-paseo/client/assistant-bloom
 */
import { useSettings, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Text, View, type TextStyle } from "react-native";
import { TIMELINE_STYLE_DEFAULTS, timelineStyleSettings } from "../shared/settings";
import { normalizeRowTimestamp, yieldRowPulse } from "./newest";
import {
  BLOOM_HANDOFF_SPEED_BOOST,
  clearActiveBloom,
  markAgentLiveActivity,
  reportActiveBloom,
} from "./row-cascade";
import { AnimatedBodyParagraph } from "./row-entrance";
import { STREAM_FRAME_INTERVAL_MS } from "./stream-reveal";
import {
  ASSISTANT_BLOOM_WAVE_WIDTH,
  type InlineBloomKind,
  type InlineBloomRun,
  advanceAssistantBloomCursor,
  buildStyledBloomRuns,
  countCodePoints,
  isRichMarkdownBlock,
  parseInlineMarkdownRuns,
  shouldStartAssistantBloomFromZero,
  splitAssistantMarkdownBlocks,
} from "./thinking-text";
import { withAlpha } from "./tokens";

export interface AssistantBloomData {
  text: string;
  phase: "streaming" | "complete";
}

/** Brief debounce for Paseo's flickering `phase` between live chunks. */
const ASSISTANT_PHASE_SETTLE_MS = 320;
const MONO_FONT = Platform?.OS === "ios" ? "Menlo" : Platform?.OS === "android" ? "monospace" : "monospace";

interface BlockPlan {
  readonly raw: string;
  readonly rich: boolean;
  readonly runs: readonly InlineBloomRun[];
  readonly startCp: number;
  readonly cpCount: number;
}

function buildBlockPlans(blocks: readonly string[]): { plans: BlockPlan[]; totalCp: number } {
  const plans: BlockPlan[] = [];
  let offset = 0;
  for (const raw of blocks) {
    const rich = isRichMarkdownBlock(raw);
    if (rich) {
      // Rich blocks (fenced code / tables) fade smoothly as a single unit over ~18 cp budget.
      const budget = 18;
      plans.push({ raw, rich: true, runs: [], startCp: offset, cpCount: budget });
      offset += budget;
    } else {
      const runs = parseInlineMarkdownRuns(raw);
      let cp = 0;
      for (const r of runs) cp += countCodePoints(r.text);
      plans.push({ raw, rich: false, runs, startCp: offset, cpCount: cp });
      offset += cp;
    }
  }
  return { plans, totalCp: offset };
}

interface BloomColors {
  readonly foreground: string;
  readonly accent: string;
  readonly codeBg: string;
}

function kindBaseColor(kind: InlineBloomKind, colors: BloomColors): string {
  return kind === "link" ? colors.accent : colors.foreground;
}

function kindTextStyle(kind: InlineBloomKind, baseFontSize: number): TextStyle | undefined {
  if (kind === "bold") return { fontWeight: "600" };
  if (kind === "heading") {
    return {
      fontWeight: "700",
      fontSize: Math.round(baseFontSize * 1.2),
      lineHeight: Math.round(baseFontSize * 1.2 * 1.3),
    };
  }
  if (kind === "code") return { fontFamily: MONO_FONT, fontSize: 12 };
  return undefined;
}

function renderStaticProseRuns(
  runs: readonly InlineBloomRun[],
  baseStyle: TextStyle,
  colors: BloomColors,
  baseFontSize: number,
) {
  return (
    <Text style={baseStyle} selectable>
      {runs.map((run, idx) => {
        if (run.kind === "plain") return run.text;
        const extra = kindTextStyle(run.kind, baseFontSize);
        const color = run.kind === "link" ? colors.accent : undefined;
        const backgroundColor = run.kind === "code" ? colors.codeBg : undefined;
        return (
          <Text
            key={idx}
            style={[
              extra,
              color !== undefined ? { color } : undefined,
              backgroundColor !== undefined ? { backgroundColor } : undefined,
            ]}
          >
            {run.text}
          </Text>
        );
      })}
    </Text>
  );
}

function renderBloomingProseRuns(
  runs: readonly InlineBloomRun[],
  localProgress: number,
  localSettledFloor: number,
  baseStyle: TextStyle,
  colors: BloomColors,
  baseFontSize: number,
) {
  const segments = buildStyledBloomRuns(
    runs,
    localProgress,
    ASSISTANT_BLOOM_WAVE_WIDTH,
    localSettledFloor,
  );
  if (segments.length === 0) return null;
  return (
    <Text style={baseStyle} selectable>
      {segments.map((seg, idx) => {
        const extra = kindTextStyle(seg.kind, baseFontSize);
        if (seg.alpha >= 0.995) {
          if (seg.kind === "plain") return seg.text;
          const color = seg.kind === "link" ? colors.accent : undefined;
          const backgroundColor = seg.kind === "code" ? colors.codeBg : undefined;
          return (
            <Text
              key={idx}
              style={[
                extra,
                color !== undefined ? { color } : undefined,
                backgroundColor !== undefined ? { backgroundColor } : undefined,
              ]}
            >
              {seg.text}
            </Text>
          );
        }
        if (seg.alpha <= 0.005) {
          return (
            <Text key={idx} style={[extra, { color: "transparent" }]}>
              {seg.text}
            </Text>
          );
        }
        const tinted = withAlpha(kindBaseColor(seg.kind, colors), seg.alpha);
        const codeBgTinted =
          seg.kind === "code" ? withAlpha(colors.codeBg, seg.alpha) : undefined;
        return (
          <Text
            key={idx}
            style={[
              extra,
              tinted !== "transparent" ? { color: tinted } : { opacity: seg.alpha },
              codeBgTinted && codeBgTinted !== "transparent"
                ? { backgroundColor: codeBgTinted }
                : undefined,
            ]}
          >
            {seg.text}
          </Text>
        );
      })}
    </Text>
  );
}

export function AssistantMessageBloom({
  theme,
  layout,
  agentId,
  timestamp,
  item,
}: PluginTimelineItemProps<AssistantBloomData>) {
  const { text, phase } = item.data;
  const styleState = useSettings(timelineStyleSettings);
  const timelineStyle = styleState.status === "ready" ? styleState.values : TIMELINE_STYLE_DEFAULTS;
  const blockGap = Math.max(6, Math.min(14, 10 + Math.round(timelineStyle.rowMarginY * 0.5)));
  const hasRaf =
    typeof globalThis.requestAnimationFrame === "function" &&
    typeof globalThis.cancelAnimationFrame === "function";

  const rowAt = normalizeRowTimestamp(timestamp);
  const rowIdentity = `${agentId ?? ""}\0${rowAt}`;

  const blocks = useMemo(() => splitAssistantMarkdownBlocks(text), [text]);
  const { plans, totalCp } = useMemo(() => buildBlockPlans(blocks), [blocks]);

  const initialBloomFromZero =
    hasRaf &&
    shouldStartAssistantBloomFromZero({
      phase,
      totalCp,
      rowTimestampMs: rowAt,
    });

  const prevIdentityRef = useRef<string>(rowIdentity);
  const prevTextRef = useRef<string>(text);
  const everStreamedRef = useRef<boolean>(initialBloomFromZero);
  const [growing, setGrowing] = useState<boolean>(initialBloomFromZero);

  const totalCpRef = useRef<number>(totalCp);
  const cursorRef = useRef<number>(
    initialBloomFromZero ? 0 : totalCp + ASSISTANT_BLOOM_WAVE_WIDTH,
  );
  const settledFloorRef = useRef<number>(initialBloomFromZero ? 0 : totalCp);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const handoffBoostRef = useRef<boolean>(false);
  const [, setTick] = useState(0);

  if (prevIdentityRef.current !== rowIdentity) {
    const isContinuation =
      everStreamedRef.current &&
      prevTextRef.current.length > 0 &&
      text.startsWith(prevTextRef.current);
    prevIdentityRef.current = rowIdentity;
    if (!isContinuation) {
      const freshFromZero =
        hasRaf &&
        shouldStartAssistantBloomFromZero({
          phase,
          totalCp,
          rowTimestampMs: rowAt,
        });
      everStreamedRef.current = freshFromZero;
      handoffBoostRef.current = false;
      totalCpRef.current = totalCp;
      if (freshFromZero) {
        cursorRef.current = 0;
        settledFloorRef.current = 0;
      } else {
        cursorRef.current = totalCp + ASSISTANT_BLOOM_WAVE_WIDTH;
        settledFloorRef.current = totalCp;
      }
    }
  } else if (text !== prevTextRef.current) {
    const prevTotal = totalCpRef.current;
    totalCpRef.current = totalCp;
    if (phase === "streaming" || text.length > prevTextRef.current.length) {
      if (!everStreamedRef.current) {
        settledFloorRef.current = prevTotal;
        cursorRef.current = prevTotal;
      } else if (cursorRef.current > prevTotal) {
        settledFloorRef.current = Math.max(settledFloorRef.current, prevTotal);
        cursorRef.current = prevTotal;
      }
      everStreamedRef.current = true;
    } else if (!everStreamedRef.current) {
      cursorRef.current = totalCp + ASSISTANT_BLOOM_WAVE_WIDTH;
      settledFloorRef.current = totalCp;
    }
  }
  prevTextRef.current = text;
  totalCpRef.current = totalCp;

  const yieldedPulseRowRef = useRef<string | null>(null);

  useEffect(() => {
    if (phase === "streaming" && everStreamedRef.current) {
      markAgentLiveActivity(agentId);
      if (yieldedPulseRowRef.current !== rowIdentity) {
        yieldedPulseRowRef.current = rowIdentity;
        yieldRowPulse(agentId);
      }
      setGrowing(true);
      return;
    }
    if (!everStreamedRef.current) {
      setGrowing(false);
      return;
    }
    const timer = setTimeout(() => {
      setGrowing(false);
    }, ASSISTANT_PHASE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [agentId, phase, text, rowIdentity]);

  const settledTarget = totalCp + ASSISTANT_BLOOM_WAVE_WIDTH;
  const needsAnim =
    hasRaf &&
    everStreamedRef.current &&
    totalCp > 0 &&
    cursorRef.current < settledTarget - 0.05;
  const activeLive = needsAnim || (hasRaf && everStreamedRef.current && (growing || phase === "streaming"));

  const needsAnimRef = useRef<boolean>(needsAnim);
  needsAnimRef.current = needsAnim;

  useEffect(() => {
    return () => {
      if (rafRef.current !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = 0;
      handoffBoostRef.current = false;
      clearActiveBloom(agentId);
    };
  }, [agentId, rowIdentity]);

  useEffect(() => {
    if (!needsAnim) {
      if (rafRef.current !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = 0;
      handoffBoostRef.current = false;
      clearActiveBloom(agentId);
      return;
    }

    const onSuccessorWaiting = () => {
      handoffBoostRef.current = true;
    };
    const publishRemaining = () => {
      const remChars = Math.max(0, totalCpRef.current + ASSISTANT_BLOOM_WAVE_WIDTH - cursorRef.current);
      // Estimate remaining bloom duration against our responsive assistant wave pace.
      const estMs = (remChars / 120) * 1000;
      reportActiveBloom(agentId, estMs, onSuccessorWaiting);
    };
    publishRemaining();

    if (rafRef.current !== null) return;

    let lastEmitAt = 0;
    const tick = (now: number) => {
      rafRef.current = null;
      if (!needsAnimRef.current) {
        lastFrameRef.current = 0;
        clearActiveBloom(agentId);
        return;
      }
      const rawDt =
        lastFrameRef.current === 0 ? STREAM_FRAME_INTERVAL_MS : Math.max(1, now - lastFrameRef.current);
      lastFrameRef.current = now;
      const dt = handoffBoostRef.current ? rawDt * BLOOM_HANDOFF_SPEED_BOOST : rawDt;
      const target = totalCpRef.current;
      const next = advanceAssistantBloomCursor(cursorRef.current, target, dt, ASSISTANT_BLOOM_WAVE_WIDTH);
      cursorRef.current = next;
      const done = next >= target + ASSISTANT_BLOOM_WAVE_WIDTH - 0.05;
      if (done) {
        cursorRef.current = target + ASSISTANT_BLOOM_WAVE_WIDTH;
        settledFloorRef.current = target;
        lastFrameRef.current = 0;
        handoffBoostRef.current = false;
        clearActiveBloom(agentId);
        setTick((v) => (v + 1) & 0x7fffffff);
        return;
      }
      publishRemaining();
      if (lastEmitAt === 0 || now - lastEmitAt >= STREAM_FRAME_INTERVAL_MS) {
        lastEmitAt = now;
        setTick((v) => (v + 1) & 0x7fffffff);
      }
      rafRef.current = globalThis.requestAnimationFrame(tick);
    };

    lastFrameRef.current = 0;
    rafRef.current = globalThis.requestAnimationFrame(tick);
  }, [agentId, needsAnim, text, rowIdentity]);

  const baseFontSize = layout.compact ? 14 : 15;
  const baseLineHeight = Math.round(baseFontSize * 1.4);
  const proseStyle = useMemo<TextStyle>(
    () => ({
      color: theme.colors.foreground,
      fontSize: baseFontSize,
      lineHeight: baseLineHeight,
    }),
    [theme.colors.foreground, baseFontSize, baseLineHeight],
  );

  // Cache completely settled earlier prose/rich blocks so only the actively
  // emerging block re-renders at 60fps.
  const settledCacheRef = useRef<
    Map<number, { raw: string; node: ReturnType<typeof renderStaticProseRuns> }>
  >(new Map());
  if (!activeLive && settledCacheRef.current.size > 0) {
    settledCacheRef.current.clear();
  }

  if (!activeLive || plans.length === 0) {
    return <Markdown>{text}</Markdown>;
  }

  const cursor = cursorRef.current;
  const settledFloor = settledFloorRef.current;
  const colors: BloomColors = {
    foreground: theme.colors.foreground,
    accent: theme.colors.accent,
    codeBg: theme.colors.surface2,
  };
  const rendered: Array<ReturnType<typeof renderStaticProseRuns>> = [];

  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i]!;
    // Don't mount blocks far beyond the lookahead window yet.
    if (plan.startCp > cursor + 1 && i > 0) break;

    if (plan.rich) {
      const node = (
        <AnimatedBodyParagraph key={`rich:${i}`} animate fromOpacity={0} durationMs={320}>
          <Markdown>{plan.raw}</Markdown>
        </AnimatedBodyParagraph>
      );
      rendered.push(node);
      continue;
    }

    const blockEnd = plan.startCp + plan.cpCount;
    const isBlockSettled =
      cursor >= blockEnd + ASSISTANT_BLOOM_WAVE_WIDTH || settledFloor >= blockEnd;
    if (isBlockSettled) {
      const hit = settledCacheRef.current.get(i);
      if (hit !== undefined && hit.raw === plan.raw) {
        rendered.push(hit.node);
      } else {
        const node = (
          <View key={`prose:${i}`}>
            {renderStaticProseRuns(plan.runs, proseStyle, colors, baseFontSize)}
          </View>
        );
        settledCacheRef.current.set(i, { raw: plan.raw, node });
        rendered.push(node);
      }
      continue;
    }

    const localProgress = Math.max(0, cursor - plan.startCp);
    const localSettledFloor = Math.max(0, settledFloor - plan.startCp);
    const blooming = renderBloomingProseRuns(
      plan.runs,
      localProgress,
      localSettledFloor,
      proseStyle,
      colors,
      baseFontSize,
    );
    if (blooming !== null) {
      rendered.push(<View key={`prose:${i}`}>{blooming}</View>);
    }
  }

  return <View style={{ gap: blockGap }}>{rendered}</View>;
}
