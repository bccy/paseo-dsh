/**
 * Tool-call-aligned left-to-right `rgba` ink-trail bloom renderer for live
 * streaming assistant replies (`InlineToolCall` visual signature, zero jank).
 *
 * Architecture:
 * 1. **1:1 ink-trail bloom with `InlineToolCall`**:
 *    - Uses the exact same left-to-right character ink-fade curve (`10` code
 *      points, Hermite smoothstep `0.04 -> 1.0` `rgba(...)` text alpha + subtle
 *      leading edge sheen) as `renderInkTrailText` on tool rows — replacing the
 *      old bottom-rectangle fog overlay and `64ms` chunk-throttled `<Markdown>`.
 *    - Works identically on iOS `NSAttributedString`, Android, Desktop, and Web
 *      using pure React Native `<Text>` / `<View>` primitives (zero DOM globals).
 * 2. **Zero word-skipping & zero fast-output stutter (`O(1)` per frame)**:
 *    - `advanceAssistantInkCursor` smooths velocity exponentially (`~45ms` tau)
 *      over a `~180ms` proportional catch-up horizon so bursty/fast network
 *      chunks (`50–600+ chars/sec`) glide continuously frame-by-frame without
 *      skipping words or stalling between chunks.
 *    - Zero `<Markdown>` AST / syntax-highlight parses run during active
 *      streaming: blocks are tokenized incrementally once per block change with
 *      pre-computed UTF-16 code-point offsets, settled blocks freeze behind
 *      `React.memo` with `0.0px` mid-stream layout shift, and each active frame
 *      slices at most `10` trail glyphs.
 * 3. **Zero-flash double-buffered `<Markdown>` handoff on completion**:
 *    - Once `phase === "complete"` and the ink-trail cursor finishes settling,
 *      a single unified `<Markdown>{text}</Markdown>` pre-warms off-flow at
 *      `opacity: 0` inside the same `dsh-assistant-bloom` row and swaps in only
 *      after `onLayout(height > 0)` (or `120ms` fallback), preserving Paseo's
 *      native Copy / Fork / Turn Timing footer with zero `LegendList` ID swap.
 *
 * @module dsh-paseo/client/assistant-bloom
 */
import { useAgent, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type TextStyle,
} from "react-native";
import {
  readLiveBloomState,
  writeLiveBloomState,
  type LiveBloomState,
} from "./assistant-bloom-handoff";
import { normalizeRowTimestamp, yieldRowPulse } from "./newest";
import {
  BLOOM_HANDOFF_SPEED_BOOST,
  clearActiveBloom,
  markAgentLiveActivity,
  reportActiveBloom,
} from "./row-cascade";
import { STREAM_FRAME_INTERVAL_MS, buildInkTrailSegments } from "./stream-reveal";
import {
  ASSISTANT_INK_TRAIL_WIDTH,
  type AssistantBloomBlockPlan,
  type AssistantBloomListItem,
  type IndexedInlineRun,
  type InlineBloomKind,
  advanceAssistantInkCursor,
  buildStyledInkTrailSegments,
  countCodePoints,
  parseAssistantBloomBlock,
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

const ROW_ENTRANCE_DURATION_MS = 220;
const UNIFIED_MERGE_FALLBACK_MS = 120;
const CASCADE_REPORT_THROTTLE_MS = 100;
const LIVE_ACTIVITY_HEARTBEAT_MS = 5_000;
/** ~60fps VSync emit interval (14ms avoids 15.9ms<16ms 60Hz jitter skips while capping 120Hz cleanly). */
const INK_EMIT_INTERVAL_MS = 14;
/** Number of settled lines per frozen `<StaticCodeChunk>` inside long streaming code blocks. */
const CODE_CHUNK_LINES = 16;

const ROOT_STYLE = { position: "relative" as const, paddingTop: 4, paddingBottom: 4 };
const UNIFIED_PREWARM_STYLE = {
  position: "absolute" as const,
  top: 4,
  left: 0,
  right: 0,
  opacity: 0,
};

const MONO_FONT =
  Platform?.OS === "ios" ? "Menlo" : Platform?.OS === "android" ? "monospace" : "monospace";
const HAIRLINE_WIDTH =
  typeof StyleSheet?.hairlineWidth === "number" && StyleSheet.hairlineWidth > 0
    ? StyleSheet.hairlineWidth
    : 0.5;

interface BloomPalette {
  readonly foreground: string;
  readonly foregroundMuted: string;
  readonly accent: string;
  readonly surface1: string;
  readonly surface2: string;
  readonly border: string;
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

function prefersReducedMotion(): boolean {
  const win = (globalThis as Record<string, unknown>)["window"] as
    | { matchMedia?: (query: string) => { matches?: boolean } | null }
    | undefined;
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

/**
 * Apply true `rgba(...)` alpha multiplication so nested `<Text>` spans dissolve
 * natively on iOS `NSAttributedString` (where `style.opacity` is ignored),
 * Android, and Web — matching `renderInkTrailText` in `row-entrance.tsx`.
 */
function tintInkColor(color: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const rgbaMatch =
    /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/i.exec(color.trim());
  if (rgbaMatch !== null) {
    const baseA = Number.parseFloat(rgbaMatch[4]!);
    const nextA = Number.isFinite(baseA) ? Math.max(0, Math.min(1, baseA * clamped)) : clamped;
    return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${Number(nextA.toFixed(3))})`;
  }
  return withAlpha(color, Number(clamped.toFixed(3)));
}

function inlineKindStyle(kind: InlineBloomKind, baseFontSize: number): TextStyle | undefined {
  switch (kind) {
    case "bold":
      return { fontWeight: "600" };
    case "italic":
      return { fontStyle: "italic" };
    case "boldItalic":
      return { fontWeight: "600", fontStyle: "italic" };
    case "code":
      return {
        fontFamily: MONO_FONT,
        fontSize: Math.max(12, baseFontSize - 1.5),
      };
    case "strike":
      return { textDecorationLine: "line-through" };
    case "link":
    case "plain":
    default:
      return undefined;
  }
}

function headingMetrics(
  level: 1 | 2 | 3 | 4 | 5 | 6,
  baseFontSize: number,
): { fontSize: number; lineHeight: number } {
  const scale =
    level === 1 ? 1.32 : level === 2 ? 1.2 : level === 3 ? 1.1 : level === 4 ? 1.04 : 1.0;
  const fontSize = Math.round(baseFontSize * scale);
  const lineHeight = Math.round(fontSize * 1.38);
  return { fontSize, lineHeight };
}

function renderInlineRuns(
  runs: readonly IndexedInlineRun[],
  progressChars: number,
  settledFloor: number,
  palette: BloomPalette,
  baseFontSize: number,
  defaultColor: string,
  highlightColor: string,
): ReactNode {
  if (runs.length === 0) return null;
  const segments = buildStyledInkTrailSegments(
    runs,
    progressChars,
    ASSISTANT_INK_TRAIL_WIDTH,
    settledFloor,
  );
  if (segments.length === 0) return null;
  if (
    segments.length === 1 &&
    segments[0]!.alpha >= 1 &&
    segments[0]!.kind === "plain"
  ) {
    return segments[0]!.text;
  }

  return segments.map((seg, idx) => {
    const extra = inlineKindStyle(seg.kind, baseFontSize);
    const targetColor = seg.kind === "link" ? palette.accent : defaultColor;

    if (seg.alpha >= 1) {
      if (seg.kind === "plain" && targetColor === defaultColor) {
        return seg.text;
      }
      return (
        <Text
          key={idx}
          style={[
            extra,
            seg.kind === "link" ? { color: palette.accent } : undefined,
            seg.kind === "code" ? { backgroundColor: palette.surface2 } : undefined,
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

    const rawColor =
      seg.kind === "link"
        ? palette.accent
        : seg.highlight > 0
          ? highlightColor
          : targetColor;
    const segAlpha =
      seg.highlight === 1 && highlightColor !== targetColor
        ? Number((seg.alpha * 0.92).toFixed(3))
        : seg.alpha;
    const tinted = tintInkColor(rawColor, segAlpha);
    const codeBg =
      seg.kind === "code" ? tintInkColor(palette.surface2, segAlpha) : undefined;

    return (
      <Text
        key={idx}
        style={[
          extra,
          tinted !== "transparent" ? { color: tinted } : { opacity: segAlpha, color: rawColor },
          codeBg && codeBg !== "transparent" ? { backgroundColor: codeBg } : undefined,
        ]}
      >
        {seg.text}
      </Text>
    );
  });
}

function renderListMarkerTrail(
  marker: string,
  progressChars: number,
  settledFloor: number,
  palette: BloomPalette,
): ReactNode {
  if (!Number.isFinite(progressChars) || progressChars >= marker.length + ASSISTANT_INK_TRAIL_WIDTH) {
    return marker;
  }
  const segs = buildInkTrailSegments(
    marker,
    progressChars,
    ASSISTANT_INK_TRAIL_WIDTH,
    settledFloor,
  );
  if (segs.length === 0) return "";
  if (segs.length === 1 && segs[0]!.opacity >= 1 && segs[0]!.highlight === 0) {
    return segs[0]!.text;
  }
  return segs.map((seg, idx) => {
    if (seg.opacity >= 1 && seg.highlight === 0) return seg.text;
    const visualAlpha = Math.max(0.04, Math.min(1, (seg.opacity - 0.14) / 0.86));
    const rawColor = seg.highlight > 0 ? palette.foreground : palette.foregroundMuted;
    const tinted = tintInkColor(rawColor, visualAlpha);
    return (
      <Text
        key={idx}
        style={tinted !== "transparent" ? { color: tinted } : { opacity: visualAlpha }}
      >
        {seg.text}
      </Text>
    );
  });
}

interface StaticListItemProps {
  readonly item: AssistantBloomListItem;
  readonly palette: BloomPalette;
  readonly baseFontSize: number;
  readonly baseLineHeight: number;
}

const StaticListItem = memo(
  function StaticListItem({
    item,
    palette,
    baseFontSize,
    baseLineHeight,
  }: StaticListItemProps) {
    const bodyNode = renderInlineRuns(
      item.runs,
      Number.POSITIVE_INFINITY,
      item.bodyCpCount,
      palette,
      baseFontSize,
      palette.foreground,
      palette.foreground,
    );
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          paddingLeft: item.indent * 14,
        }}
      >
        <Text
          style={{
            color: palette.foregroundMuted,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            marginRight: 8,
            minWidth: item.marker === "•" ? 10 : 18,
          }}
        >
          {item.marker}
        </Text>
        <Text
          selectable
          style={{
            color: palette.foreground,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            flex: 1,
          }}
        >
          {bodyNode}
        </Text>
      </View>
    );
  },
  (prev, next) => {
    if (
      prev.palette !== next.palette ||
      prev.baseFontSize !== next.baseFontSize ||
      prev.baseLineHeight !== next.baseLineHeight ||
      prev.item.indent !== next.item.indent ||
      prev.item.marker !== next.item.marker ||
      prev.item.bodyCpCount !== next.item.bodyCpCount ||
      prev.item.runs.length !== next.item.runs.length
    ) {
      return false;
    }
    const len = prev.item.runs.length;
    if (len === 0) return true;
    return prev.item.runs[len - 1]!.text === next.item.runs[len - 1]!.text;
  },
);

interface StaticCodeChunkProps {
  readonly text: string;
  readonly color: string;
  readonly fontSize: number;
  readonly lineHeight: number;
}

const StaticCodeChunk = memo(function StaticCodeChunk({
  text,
  color,
  fontSize,
  lineHeight,
}: StaticCodeChunkProps) {
  return (
    <Text
      selectable
      style={{
        color,
        fontFamily: MONO_FONT,
        fontSize,
        lineHeight,
      }}
    >
      {text}
    </Text>
  );
});

function findExactCpIndex(cpOffsets: readonly number[], utf16Pos: number): number {
  let lo = 0;
  let hi = cpOffsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const val = cpOffsets[mid]!;
    if (val === utf16Pos) return mid;
    if (val < utf16Pos) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo;
}

interface BlockRenderProps {
  readonly plan: AssistantBloomBlockPlan;
  readonly localProgress: number;
  readonly localSettledFloor: number;
  readonly palette: BloomPalette;
  readonly baseFontSize: number;
  readonly baseLineHeight: number;
}

function renderBloomBlockContent({
  plan,
  localProgress,
  localSettledFloor,
  palette,
  baseFontSize,
  baseLineHeight,
}: BlockRenderProps): ReactNode {
  const proseBase: TextStyle = {
    color: palette.foreground,
    fontSize: baseFontSize,
    lineHeight: baseLineHeight,
  };

  switch (plan.kind) {
    case "hr": {
      const hrAlpha = Number.isFinite(localProgress)
        ? Math.max(0.08, Math.min(1, localProgress / Math.max(1, ASSISTANT_INK_TRAIL_WIDTH * 0.5)))
        : 1;
      const borderTint = tintInkColor(palette.border, hrAlpha);
      return (
        <View
          style={{
            height: HAIRLINE_WIDTH,
            backgroundColor: borderTint !== "transparent" ? borderTint : palette.border,
            opacity: borderTint !== "transparent" ? 1 : hrAlpha,
            marginVertical: 4,
          }}
        />
      );
    }

    case "heading": {
      if (plan.cpCount === 0) return null;
      const { fontSize, lineHeight } = headingMetrics(plan.level, baseFontSize);
      const content = renderInlineRuns(
        plan.runs,
        localProgress,
        localSettledFloor,
        palette,
        fontSize,
        palette.foreground,
        palette.foreground,
      );
      if (content === null) return null;
      return (
        <Text
          selectable
          style={{
            color: palette.foreground,
            fontSize,
            lineHeight,
            fontWeight: "700",
          }}
        >
          {content}
        </Text>
      );
    }

    case "blockquote": {
      if (plan.cpCount === 0) return null;
      const content = renderInlineRuns(
        plan.runs,
        localProgress,
        localSettledFloor,
        palette,
        baseFontSize,
        palette.foregroundMuted,
        palette.foreground,
      );
      if (content === null) return null;
      return (
        <View
          style={{
            borderLeftWidth: 2.5,
            borderLeftColor: palette.border,
            paddingLeft: 10,
          }}
        >
          <Text
            selectable
            style={{
              color: palette.foregroundMuted,
              fontSize: baseFontSize,
              lineHeight: baseLineHeight,
            }}
          >
            {content}
          </Text>
        </View>
      );
    }

    case "list": {
      const rows: ReactNode[] = [];
      for (let idx = 0; idx < plan.items.length; idx += 1) {
        const item = plan.items[idx]!;
        if (Number.isFinite(localProgress) && localProgress <= item.markerStartCp && idx > 0) {
          break;
        }
        const itemEndCp = item.bodyStartCp + item.bodyCpCount;
        const itemSettled =
          !Number.isFinite(localProgress) ||
          localProgress >= itemEndCp + ASSISTANT_INK_TRAIL_WIDTH ||
          localSettledFloor >= itemEndCp;
        if (itemSettled) {
          rows.push(
            <StaticListItem
              key={idx}
              item={item}
              palette={palette}
              baseFontSize={baseFontSize}
              baseLineHeight={baseLineHeight}
            />,
          );
          continue;
        }
        const markerProg = localProgress - item.markerStartCp;
        if (markerProg <= 0) continue;
        const markerFloor = Math.max(0, localSettledFloor - item.markerStartCp);
        const bodyProg = localProgress - item.bodyStartCp;
        const bodyFloor = Math.max(0, localSettledFloor - item.bodyStartCp);

        const bodyNode =
          bodyProg > 0
            ? renderInlineRuns(
                item.runs,
                bodyProg,
                bodyFloor,
                palette,
                baseFontSize,
                palette.foreground,
                palette.foreground,
              )
            : null;

        rows.push(
          <View
            key={idx}
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              paddingLeft: item.indent * 14,
            }}
          >
            <Text
              style={{
                color: palette.foregroundMuted,
                fontSize: baseFontSize,
                lineHeight: baseLineHeight,
                marginRight: 8,
                minWidth: item.marker === "•" ? 10 : 18,
              }}
            >
              {renderListMarkerTrail(item.marker, markerProg, markerFloor, palette)}
            </Text>
            <Text selectable style={[proseBase, { flex: 1 }]}>
              {bodyNode}
            </Text>
          </View>,
        );
      }
      if (rows.length === 0) return null;
      return <View style={{ gap: 4 }}>{rows}</View>;
    }

    case "code":
    case "table": {
      const codeFontSize = Math.max(12, baseFontSize - 2);
      const codeLineHeight = Math.round(codeFontSize * 1.5);
      const singleRun = plan.runs.length === 1 ? plan.runs[0]! : undefined;
      const frozenChunks: string[] = [];
      let tailRuns: readonly IndexedInlineRun[] = plan.runs;
      let tailProgress = localProgress;
      let tailFloor = localSettledFloor;

      if (
        singleRun !== undefined &&
        Number.isFinite(localProgress) &&
        singleRun.cpCount > 240
      ) {
        const settledCp = Math.min(
          singleRun.cpCount,
          Math.max(localSettledFloor, Math.floor(localProgress - ASSISTANT_INK_TRAIL_WIDTH)),
        );
        if (settledCp > 160) {
          const settledUtf16 = singleRun.cpOffsets[settledCp]!;
          let lineCount = 0;
          let chunkStart = 0;
          let nl = singleRun.text.indexOf("\n", 0);
          while (nl !== -1 && nl < settledUtf16) {
            lineCount += 1;
            if (lineCount === CODE_CHUNK_LINES) {
              frozenChunks.push(singleRun.text.slice(chunkStart, nl));
              chunkStart = nl + 1;
              lineCount = 0;
            }
            nl = singleRun.text.indexOf("\n", nl + 1);
          }
          if (frozenChunks.length > 0) {
            const cutCp = findExactCpIndex(singleRun.cpOffsets, chunkStart);
            const remText = singleRun.text.slice(chunkStart);
            const remOffsets = singleRun.cpOffsets.slice(cutCp).map((v) => v - chunkStart);
            tailRuns =
              remOffsets.length > 1
                ? [
                    {
                      text: remText,
                      kind: singleRun.kind,
                      startCp: 0,
                      cpCount: remOffsets.length - 1,
                      cpOffsets: remOffsets,
                    },
                  ]
                : [];
            tailProgress = Math.max(0, localProgress - cutCp);
            tailFloor = Math.max(0, localSettledFloor - cutCp);
          }
        }
      }

      const content =
        tailRuns.length > 0
          ? renderInlineRuns(
              tailRuns,
              tailProgress,
              tailFloor,
              palette,
              codeFontSize,
              palette.foreground,
              palette.foreground,
            )
          : null;
      if (frozenChunks.length === 0 && content === null && plan.lang === "") return null;
      return (
        <View
          style={{
            backgroundColor: palette.surface1,
            borderColor: palette.border,
            borderWidth: HAIRLINE_WIDTH,
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          {plan.kind === "code" && plan.lang !== "" ? (
            <Text
              style={{
                color: palette.foregroundMuted,
                fontFamily: MONO_FONT,
                fontSize: 11,
                lineHeight: 15,
                marginBottom: frozenChunks.length > 0 || content !== null ? 6 : 0,
              }}
            >
              {plan.lang}
            </Text>
          ) : null}
          {frozenChunks.map((chunk, cIdx) => (
            <StaticCodeChunk
              key={cIdx}
              text={chunk}
              color={palette.foreground}
              fontSize={codeFontSize}
              lineHeight={codeLineHeight}
            />
          ))}
          {content !== null ? (
            <Text
              selectable
              style={{
                color: palette.foreground,
                fontFamily: MONO_FONT,
                fontSize: codeFontSize,
                lineHeight: codeLineHeight,
              }}
            >
              {content}
            </Text>
          ) : null}
        </View>
      );
    }

    case "paragraph":
    default: {
      if (plan.cpCount === 0) return null;
      const content = renderInlineRuns(
        plan.runs,
        localProgress,
        localSettledFloor,
        palette,
        baseFontSize,
        palette.foreground,
        palette.foreground,
      );
      if (content === null) return null;
      return (
        <Text selectable style={proseBase}>
          {content}
        </Text>
      );
    }
  }
}

interface StaticAssistantBlockProps {
  readonly plan: AssistantBloomBlockPlan;
  readonly palette: BloomPalette;
  readonly baseFontSize: number;
  readonly baseLineHeight: number;
}

/**
 * Memoized settled block during streaming: shares the exact layout & typography
 * of `renderBloomBlockContent` (`0.0px` mid-stream shift) and never re-renders
 * on 60fps cursor frames as subsequent blocks stream below it.
 */
const StaticAssistantBlock = memo(function StaticAssistantBlock({
  plan,
  palette,
  baseFontSize,
  baseLineHeight,
}: StaticAssistantBlockProps) {
  return (
    <View>
      {renderBloomBlockContent({
        plan,
        localProgress: Number.POSITIVE_INFINITY,
        localSettledFloor: plan.cpCount,
        palette,
        baseFontSize,
        baseLineHeight,
      })}
    </View>
  );
});

interface IndexedBlockPlan {
  readonly raw: string;
  readonly plan: AssistantBloomBlockPlan;
  readonly startCp: number;
  readonly cpCount: number;
}

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
  const baseFontSize = isWebPlatform() ? 14 : 15;
  const baseLineHeight = 22;

  const agentStatus = useAgent(agentId ?? "", (snapshot) => snapshot.status);
  const hasRaf =
    typeof globalThis.requestAnimationFrame === "function" &&
    typeof globalThis.cancelAnimationFrame === "function";
  const reducedMotion = prefersReducedMotion();

  const rowAt = normalizeRowTimestamp(timestamp);
  const rowIdentity = bloomKey ? `${agentId ?? ""}\0${bloomKey}` : `${agentId ?? ""}\0${rowAt}`;

  // Incremental per-index block plan cache so already-closed leading blocks
  // are never re-tokenized when new tokens append at the tail.
  const blockCacheRef = useRef<Map<number, { raw: string; plan: AssistantBloomBlockPlan }>>(
    new Map(),
  );

  const rawSplit = useMemo(() => splitStableMarkdownBlocks(text), [text]);
  const { indexedPlans, totalCp } = useMemo(() => {
    const cache = blockCacheRef.current;
    const allRaws =
      rawSplit.activeBlock !== ""
        ? [...rawSplit.settledBlocks, rawSplit.activeBlock]
        : [...rawSplit.settledBlocks];
    const out: IndexedBlockPlan[] = [];
    let cpOffset = 0;
    for (let i = 0; i < allRaws.length; i += 1) {
      const raw = allRaws[i]!;
      const hit = cache.get(i);
      let plan: AssistantBloomBlockPlan;
      if (hit !== undefined && hit.raw === raw) {
        plan = hit.plan;
      } else {
        plan = parseAssistantBloomBlock(raw);
        cache.set(i, { raw, plan });
      }
      out.push({ raw, plan, startCp: cpOffset, cpCount: plan.cpCount });
      cpOffset += plan.cpCount;
    }
    if (cache.size > allRaws.length + 4) {
      for (const k of cache.keys()) {
        if (k >= allRaws.length) cache.delete(k);
      }
    }
    return { indexedPlans: out, totalCp: cpOffset };
  }, [rawSplit]);

  const persisted = readLiveBloomState(bloomKey);
  const initialCanBloom =
    hasRaf &&
    !reducedMotion &&
    (persisted !== undefined
      ? persisted.everStreamed
      : shouldStartAssistantBloomFromZero({
          phase,
          totalCp: totalCp > 0 ? totalCp : countCodePoints(text),
          agentStatus,
        }));

  const prevIdentityRef = useRef<string>(rowIdentity);
  const instanceEpochRef = useRef<number>(0);
  const prevTextRef = useRef<string>(text);
  const everStreamedRef = useRef<boolean>(initialCanBloom);
  const totalCpRef = useRef<number>(totalCp);
  const cursorRef = useRef<number>(
    persisted !== undefined
      ? persisted.cursor
      : initialCanBloom
        ? 0
        : totalCp + ASSISTANT_INK_TRAIL_WIDTH,
  );
  const settledFloorRef = useRef<number>(
    persisted !== undefined ? persisted.settledFloor : initialCanBloom ? 0 : totalCp,
  );
  const velocityRef = useRef<number>(persisted !== undefined ? persisted.velocity : 0);
  const revealedBlocksRef = useRef<Set<number>>(
    persisted !== undefined ? persisted.revealedBlocks : new Set<number>(),
  );
  const unifiedSettledRef = useRef<boolean>(
    persisted !== undefined ? persisted.unifiedSettled : false,
  );
  const [unifiedReady, setUnifiedReady] = useState<boolean>(unifiedSettledRef.current);

  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const handoffBoostRef = useRef<boolean>(false);
  const lastCascadeReportAtRef = useRef<number>(0);
  const lastLiveActivityAtRef = useRef<number>(0);
  const [, setTick] = useState<number>(0);

  // Gentle native-driver container fade-in on fresh live mount (matching `RowEntrance`).
  const nativeAnim = canUseNativeAnimated();
  const mountFadeRef = useRef<InstanceType<typeof Animated.Value> | null>(null);
  const shouldFadeContainerRef = useRef<boolean>(
    initialCanBloom && persisted === undefined && cursorRef.current === 0,
  );
  if (nativeAnim && shouldFadeContainerRef.current && mountFadeRef.current === null) {
    mountFadeRef.current = new Animated.Value(0);
  }

  useEffect(() => {
    if (!nativeAnim || !shouldFadeContainerRef.current || !mountFadeRef.current) return;
    const easing =
      typeof Easing?.out === "function" && Easing?.cubic ? Easing.out(Easing.cubic) : undefined;
    const anim = Animated.timing(mountFadeRef.current, {
      toValue: 1,
      duration: ROW_ENTRANCE_DURATION_MS,
      useNativeDriver: true,
      ...(easing !== undefined ? { easing } : {}),
    });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [nativeAnim]);

  const syncState = useCallback(() => {
    if (!bloomKey) return;
    const state: LiveBloomState = {
      everStreamed: everStreamedRef.current,
      cursor: cursorRef.current,
      settledFloor: settledFloorRef.current,
      velocity: velocityRef.current,
      unifiedSettled: unifiedSettledRef.current,
      revealedBlocks: revealedBlocksRef.current,
    };
    writeLiveBloomState(bloomKey, state);
  }, [bloomKey]);

  if (prevIdentityRef.current !== rowIdentity) {
    const isContinuation =
      everStreamedRef.current &&
      prevTextRef.current.length > 0 &&
      text.startsWith(prevTextRef.current);
    prevIdentityRef.current = rowIdentity;
    if (!isContinuation) {
      instanceEpochRef.current += 1;
      blockCacheRef.current.clear();
      handoffBoostRef.current = false;
      const nextPersisted = readLiveBloomState(bloomKey);
      if (nextPersisted !== undefined) {
        everStreamedRef.current = nextPersisted.everStreamed && hasRaf && !reducedMotion;
        cursorRef.current = nextPersisted.cursor;
        settledFloorRef.current = nextPersisted.settledFloor;
        velocityRef.current = nextPersisted.velocity;
        revealedBlocksRef.current = nextPersisted.revealedBlocks;
        unifiedSettledRef.current = nextPersisted.unifiedSettled;
      } else {
        const fresh =
          hasRaf &&
          !reducedMotion &&
          shouldStartAssistantBloomFromZero({
            phase,
            totalCp: totalCp > 0 ? totalCp : countCodePoints(text),
            agentStatus,
          });
        everStreamedRef.current = fresh;
        cursorRef.current = fresh ? 0 : totalCp + ASSISTANT_INK_TRAIL_WIDTH;
        settledFloorRef.current = fresh ? 0 : totalCp;
        velocityRef.current = 0;
        revealedBlocksRef.current = new Set<number>();
        unifiedSettledRef.current = false;
      }
    }
  } else if (text !== prevTextRef.current) {
    const prevText = prevTextRef.current;
    const prevTotal = totalCpRef.current;
    if (hasRaf && !reducedMotion && (phase === "streaming" || text.length > prevText.length)) {
      if (!everStreamedRef.current) {
        everStreamedRef.current = true;
        settledFloorRef.current = prevTotal;
        cursorRef.current = prevTotal;
        velocityRef.current = 0;
      } else if (text.startsWith(prevText)) {
        // Pull cursor back to `prevTotal` if it had glided into the settle tail
        // during a network pause so newly arrived characters always bloom from
        // alpha 0.04 without skipping, while locking already-visible chars at 1.
        if (cursorRef.current > prevTotal) {
          settledFloorRef.current = Math.max(settledFloorRef.current, prevTotal);
          cursorRef.current = prevTotal;
        }
      } else {
        const commonUtf16 = commonUtf16PrefixLength(prevText, text);
        const commonCp = countCodePoints(text.slice(0, commonUtf16));
        settledFloorRef.current = Math.min(settledFloorRef.current, commonCp);
        if (cursorRef.current > commonCp) {
          settledFloorRef.current = Math.max(settledFloorRef.current, commonCp);
          cursorRef.current = commonCp;
        }
      }
      if (unifiedSettledRef.current) {
        unifiedSettledRef.current = false;
      }
    } else if (!everStreamedRef.current) {
      cursorRef.current = totalCp + ASSISTANT_INK_TRAIL_WIDTH;
      settledFloorRef.current = totalCp;
    }
  }
  prevTextRef.current = text;
  totalCpRef.current = totalCp;

  const everStreamed = everStreamedRef.current;
  const settledTarget = totalCp + ASSISTANT_INK_TRAIL_WIDTH;
  const needsAnim =
    hasRaf &&
    !reducedMotion &&
    everStreamed &&
    totalCp > 0 &&
    cursorRef.current < settledTarget - 0.02;

  const needsAnimRef = useRef<boolean>(needsAnim);
  needsAnimRef.current = needsAnim;
  const phaseRef = useRef<"streaming" | "complete">(phase);
  phaseRef.current = phase;
  const agentIdRef = useRef<string | undefined>(agentId);
  agentIdRef.current = agentId;

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
      if (unifiedReady) {
        unifiedSettledRef.current = false;
        setUnifiedReady(false);
      }
      return;
    }
    if (!needsAnim) {
      clearActiveBloom(agentId);
    }
  }, [agentId, phase, rowIdentity, everStreamed, needsAnim, unifiedReady]);

  // Continuous 60/120Hz `requestAnimationFrame` ink-trail loop.
  useEffect(() => {
    if (!needsAnim) {
      if (rafRef.current !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = 0;
      handoffBoostRef.current = false;
      if (phaseRef.current !== "streaming") {
        clearActiveBloom(agentIdRef.current);
      }
      syncState();
      return;
    }

    const onSuccessorWaiting = () => {
      handoffBoostRef.current = true;
    };

    const publishCascade = (wallNow: number) => {
      if (wallNow - lastCascadeReportAtRef.current >= CASCADE_REPORT_THROTTLE_MS) {
        lastCascadeReportAtRef.current = wallNow;
        const remCp = Math.max(
          0,
          totalCpRef.current + ASSISTANT_INK_TRAIL_WIDTH - cursorRef.current,
        );
        const speed = Math.max(55, velocityRef.current);
        const estMs = Math.min(400, Math.max(80, (remCp / speed) * 1000));
        reportActiveBloom(agentIdRef.current, estMs, onSuccessorWaiting, wallNow);
      }
      if (wallNow - lastLiveActivityAtRef.current >= LIVE_ACTIVITY_HEARTBEAT_MS) {
        lastLiveActivityAtRef.current = wallNow;
        markAgentLiveActivity(agentIdRef.current, wallNow);
      }
    };

    publishCascade(Date.now());
    if (rafRef.current !== null) return;

    let lastEmitAt = 0;
    const tick = (frameNow: number) => {
      rafRef.current = null;
      if (!needsAnimRef.current) {
        lastFrameRef.current = 0;
        return;
      }
      const now = frameNow > 0 ? frameNow : nowMs();
      const rawDt =
        lastFrameRef.current === 0
          ? STREAM_FRAME_INTERVAL_MS
          : Math.max(1, now - lastFrameRef.current);
      lastFrameRef.current = now;

      const step = advanceAssistantInkCursor({
        current: cursorRef.current,
        target: totalCpRef.current,
        velocity: velocityRef.current,
        dtMs: rawDt,
        phase: phaseRef.current,
        speedBoost: handoffBoostRef.current ? BLOOM_HANDOFF_SPEED_BOOST : 1,
        trailWidth: ASSISTANT_INK_TRAIL_WIDTH,
      });
      cursorRef.current = step.cursor;
      velocityRef.current = step.velocity;

      if (step.settled) {
        settledFloorRef.current = totalCpRef.current;
        lastFrameRef.current = 0;
        handoffBoostRef.current = false;
        if (phaseRef.current !== "streaming") {
          clearActiveBloom(agentIdRef.current);
        }
        syncState();
        setTick((v) => (v + 1) & 0x7fffffff);
        return;
      }

      publishCascade(Date.now());
      syncState();
      if (lastEmitAt === 0 || now - lastEmitAt >= INK_EMIT_INTERVAL_MS) {
        lastEmitAt = now;
        setTick((v) => (v + 1) & 0x7fffffff);
      }
      rafRef.current = globalThis.requestAnimationFrame(tick);
    };

    lastFrameRef.current = 0;
    rafRef.current = globalThis.requestAnimationFrame(tick);
  }, [needsAnim, syncState, rowIdentity]);

  useEffect(() => {
    syncState();
  }, [syncState, phase, text]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      clearActiveBloom(agentIdRef.current);
      syncState();
    };
  }, [syncState]);

  const tailSettling = phase === "streaming" || needsAnim;
  const needsUnifiedMerge =
    everStreamed &&
    shouldMergeToUnifiedMarkdown({
      phase,
      tailSettling,
      blockCount: indexedPlans.length,
    });

  useEffect(() => {
    setUnifiedReady(unifiedSettledRef.current);
  }, [rowIdentity]);

  useEffect(() => {
    if (!needsUnifiedMerge) {
      if (unifiedReady && phase === "streaming") {
        unifiedSettledRef.current = false;
        setUnifiedReady(false);
      }
      return;
    }
    if (unifiedReady) return;
    const fallback = setTimeout(() => {
      unifiedSettledRef.current = true;
      syncState();
      setUnifiedReady(true);
    }, UNIFIED_MERGE_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [needsUnifiedMerge, unifiedReady, phase, rowIdentity, text, syncState]);

  const handleUnifiedLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event?.nativeEvent?.layout?.height ?? 0;
      if (height > 0) {
        unifiedSettledRef.current = true;
        syncState();
        setUnifiedReady(true);
      }
    },
    [syncState],
  );

  const palette = useMemo<BloomPalette>(
    () => ({
      foreground: theme.colors.foreground,
      foregroundMuted: theme.colors.foregroundMuted,
      accent: theme.colors.accent,
      surface1: theme.colors.surface1,
      surface2: theme.colors.surface2,
      border: theme.colors.border,
    }),
    [
      theme.colors.foreground,
      theme.colors.foregroundMuted,
      theme.colors.accent,
      theme.colors.surface1,
      theme.colors.surface2,
      theme.colors.border,
    ],
  );

  // Idle / reopened / reduced-motion / already-unified row: render a single
  // native `<Markdown>` on frame 0 with zero animation wrappers or timers.
  if (!everStreamed || (unifiedReady && phase === "complete" && !needsAnim)) {
    return (
      <View style={ROOT_STYLE}>
        <Markdown>{text}</Markdown>
      </View>
    );
  }

  if (indexedPlans.length === 0) {
    return <View style={ROOT_STYLE} />;
  }

  const cursor = cursorRef.current;
  const settledFloor = settledFloorRef.current;
  const epoch = instanceEpochRef.current;
  const closedCount = rawSplit.settledBlocks.length;

  const renderedBlocks: ReactNode[] = [];
  for (let i = 0; i < indexedPlans.length; i += 1) {
    const entry = indexedPlans[i]!;
    if (entry.startCp > cursor && i > 0) break;

    const blockEnd = entry.startCp + entry.cpCount;
    const blockFullySettled =
      i < closedCount &&
      (cursor >= blockEnd + ASSISTANT_INK_TRAIL_WIDTH || settledFloor >= blockEnd);

    if (blockFullySettled) {
      revealedBlocksRef.current.add(i);
      renderedBlocks.push(
        <StaticAssistantBlock
          key={`${epoch}:${i}`}
          plan={entry.plan}
          palette={palette}
          baseFontSize={baseFontSize}
          baseLineHeight={baseLineHeight}
        />,
      );
      continue;
    }

    const localProgress = Math.max(0, cursor - entry.startCp);
    const localSettledFloor = Math.max(0, settledFloor - entry.startCp);
    const content = renderBloomBlockContent({
      plan: entry.plan,
      localProgress,
      localSettledFloor,
      palette,
      baseFontSize,
      baseLineHeight,
    });
    if (content !== null) {
      renderedBlocks.push(<View key={`${epoch}:${i}`}>{content}</View>);
    }
  }

  const body = (
    <View style={ROOT_STYLE}>
      <View key={`${epoch}:blocks`} style={{ gap: blockGap }}>
        {renderedBlocks}
      </View>
      {needsUnifiedMerge ? (
        <View
          key={`${epoch}:unified`}
          onLayout={handleUnifiedLayout}
          pointerEvents="none"
          style={UNIFIED_PREWARM_STYLE}
        >
          <Markdown>{text}</Markdown>
        </View>
      ) : null}
    </View>
  );

  if (nativeAnim && shouldFadeContainerRef.current && mountFadeRef.current) {
    const AnimatedView = Animated.View;
    return <AnimatedView style={{ opacity: mountFadeRef.current }}>{body}</AnimatedView>;
  }

  return body;
}
