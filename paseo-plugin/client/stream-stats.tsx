import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { DEFAULT_STREAM_STATS, streamStatsSettings } from "../shared/settings";
import { measureFooterLift, watchFooter } from "./web";

export const streamStatsSchema = z.object({
  firstTokenMs: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  outputTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  contextUsed: z.number().optional(),
  contextMax: z.number().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thinkingOption: z.string().optional(),
  toolCalls: z.number().optional(),
  toolMs: z.number().optional(),
  turns: z.number().optional(),
  steps: z.number().optional(),
  sessionTokens: z.number().optional(),
  cacheHit: z.number().optional(),
  /** Last stats row of a turn: Paseo puts its completed-turn footer above it. */
  final: z.boolean().optional(),
});

type StreamStats = z.infer<typeof streamStatsSchema>;

/**
 * Paseo draws the completed-turn footer — copy / model / time — directly under
 * the answer and keeps its own bottom padding free under it, while this row is
 * an ordinary timeline item spaced by the host's item gap. Neither number is
 * ours to rely on: a theme plugin restyles that footer, and the same footer is
 * also drawn under turns that are no longer the newest, where the host's
 * margins differ (the row sits 35px under the footer while its turn is latest,
 * 23px once a newer turn arrives).
 *
 * On web the row measures the footer actually painted above it (in `./web`,
 * the only client file allowed to touch the DOM) and lifts itself to the gap
 * the user chose in Settings → Plugins. Native has no DOM to measure; it keeps
 * the geometry the host's footer was tuned for.
 */
/** Paseo's `SPACING[8]` (`TURN_FOOTER_BOTTOM_SPACING`): the footer's bottom padding. */
const TURN_FOOTER_BOTTOM_PADDING = 32;
/** The furthest the row may pull up: the footer's own reserved padding. */
const MAX_ROW_LIFT = -TURN_FOOTER_BOTTOM_PADDING;
/** Paseo's footer sets its text in a 18px line box at 13px. */
const LINE_HEIGHT_RATIO = 18 / 13;

function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatNumber(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function contextRatio(data: StreamStats): number | undefined {
  if (data.contextUsed === undefined || data.contextMax === undefined || data.contextMax <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(1, data.contextUsed / data.contextMax));
}

function contextLine(data: StreamStats): string | undefined {
  const ratio = contextRatio(data);
  if (ratio === undefined) return undefined;
  const filled = Math.round(ratio * 10);
  const bar = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  return `上下文  ${formatNumber(data.contextUsed ?? 0)} / ${formatNumber(data.contextMax ?? 0)}  ${bar}  ${Math.round(ratio * 100)}%`;
}

function tokensLine(data: StreamStats): string | undefined {
  const parts: string[] = [];
  if (data.inputTokens !== undefined) parts.push(`输入 ${formatNumber(data.inputTokens)}`);
  if (data.cachedInputTokens !== undefined) parts.push(`缓存 ${formatNumber(data.cachedInputTokens)}`);
  if (data.outputTokens !== undefined) parts.push(`输出 ${formatNumber(data.outputTokens)}`);
  return parts.length === 0 ? undefined : `Tokens  ${parts.join(" · ")}`;
}

function routeLine(data: StreamStats): string | undefined {
  if (data.provider === undefined && data.model === undefined) return undefined;
  const route = [data.provider, data.model].filter((part) => part !== undefined).join(" / ");
  return `路由  ${route}${data.thinkingOption === undefined ? "" : ` · 思考 ${data.thinkingOption}`}`;
}

function toolsLine(data: StreamStats): string | undefined {
  if (data.toolCalls === undefined || data.toolCalls <= 0) return undefined;
  const duration = data.toolMs === undefined ? "" : ` · ${formatLatency(data.toolMs)}`;
  return `工具  ${data.toolCalls} 次${duration}`;
}

/** One compact line under an answer; tap to expand the full picture. */
function StreamStatsRow({ item, theme, layout }: PluginTimelineItemProps<StreamStats>) {
  const [open, setOpen] = useState(false);
  const [lift, setLift] = useState(0);
  const rowRef = useRef<unknown>(null);
  /** The lift currently in the DOM, which the next measurement has to discount. */
  const appliedLift = useRef(0);
  const settings = useSettings(streamStatsSettings);
  const gap = settings.status === "ready" ? settings.values.gapPx : DEFAULT_STREAM_STATS.gapPx;
  const fontSize = settings.status === "ready" ? settings.values.fontSize : DEFAULT_STREAM_STATS.fontSize;
  const data = item.data;

  const applyLift = (next: number) => {
    if (appliedLift.current === next) return;
    appliedLift.current = next;
    setLift(next);
  };

  // The footer above this row is the host's markup and, with a theme plugin
  // installed, that plugin's restyling of it — so its height and padding are
  // measured instead of assumed. Everything DOM lives in `./web`; off web it
  // reports nothing, the row keeps the host's own gap, and native falls back to
  // the constant `nativeLift` below.
  useLayoutEffect(() => {
    if (data.final !== true) {
      applyLift(0);
      return;
    }
    const measure = () => {
      const next = measureFooterLift(rowRef.current, {
        appliedLift: appliedLift.current,
        gap,
        maxLift: MAX_ROW_LIFT,
      });
      applyLift(next ?? 0);
    };
    measure();
    const stop = watchFooter(rowRef.current, measure);
    return stop ?? undefined;
    // `applyLift` only reads refs and a state setter, so the values that can
    // change what is measured are the only dependencies.
  }, [data.final, gap]);

  const muted = theme.colors.foregroundMuted;
  const base = {
    color: muted,
    fontSize,
    lineHeight: Math.round(fontSize * LINE_HEIGHT_RATIO),
    fontVariant: ["tabular-nums"] as const,
  };

  const ratio = contextRatio(data);
  const segments: Array<{ text: string; color: string }> = [];
  if (data.turns !== undefined && data.steps !== undefined) {
    segments.push({ text: `${data.turns} 轮 ${data.steps} 步`, color: muted });
  }
  if (data.firstTokenMs !== undefined) {
    segments.push({ text: `首字 ${formatLatency(data.firstTokenMs)}`, color: muted });
  }
  if (data.tokensPerSecond !== undefined) {
    segments.push({ text: `${Math.round(data.tokensPerSecond)} tok/s`, color: muted });
  }
  if (ratio !== undefined) {
    segments.push({ text: `上下文 ${Math.round(ratio * 100)}%`, color: muted });
  }
  if (data.cacheHit !== undefined) {
    segments.push({ text: `缓存命中 ${Math.round(data.cacheHit * 100)}%`, color: muted });
  }
  if (segments.length === 0) return null;

  const details = [contextLine(data), tokensLine(data), routeLine(data), toolsLine(data)].filter(
    (line): line is string => line !== undefined,
  );
  const nativeLift = gap - TURN_FOOTER_BOTTOM_PADDING;

  return (
    <Pressable
      ref={rowRef}
      accessibilityRole="button"
      accessibilityLabel={open ? "收起回答统计" : "展开回答统计"}
      onPress={() => setOpen((value) => !value)}
      style={{
        alignSelf: "flex-start",
        marginTop: data.final === true ? (layout.platform === "web" ? lift : nativeLift) : 0,
        marginBottom: 0,
        paddingLeft: 2,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
        {segments.map((segment, index) => (
          <Fragment key={segment.text}>
            {index > 0 ? <Text style={base}> · </Text> : null}
            <Text style={{ ...base, color: segment.color }}>{segment.text}</Text>
          </Fragment>
        ))}
        <Text style={base}>{open ? " ▴" : " ▾"}</Text>
      </View>
      {open ? (
        <View style={{ marginTop: 2, gap: 1 }}>
          {details.map((line) => (
            <Text key={line} style={base}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

export function contributeStreamStats(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: "dsh-stream-stats",
    version: 1,
    schema: streamStatsSchema,
    Component: StreamStatsRow,
  });
  return () => {};
}
