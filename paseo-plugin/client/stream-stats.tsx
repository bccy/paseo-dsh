import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";

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
 * 23px once a newer turn arrives). A fixed negative margin therefore leaves
 * either a hole or an overlap, depending on the theme and on the row's place in
 * the timeline.
 *
 * On web the row measures the footer actually painted above it and lifts itself
 * to `DESIRED_GAP_ABOVE_STATS`, so every theme and both states get one gap.
 * Native has no DOM to measure; it keeps the geometry the host's footer was
 * originally tuned for.
 */
const DESIRED_GAP_ABOVE_STATS = 6;
/** Paseo's `SPACING[8]` (`TURN_FOOTER_BOTTOM_SPACING`): the footer's bottom padding. */
const TURN_FOOTER_BOTTOM_PADDING = 32;
const FINAL_ROW_LIFT = DESIRED_GAP_ABOVE_STATS - TURN_FOOTER_BOTTOM_PADDING;
/** The furthest the row may pull up: the footer's own reserved padding. */
const MAX_ROW_LIFT = -TURN_FOOTER_BOTTOM_PADDING;
/**
 * Paseo's completed-turn footer draws at `STREAM_METADATA_FONT_SIZE` (13px) in
 * every theme. A row set smaller reads as unrelated metadata next to it.
 */
const FOOTER_FONT_SIZE = 13;
const FOOTER_LINE_HEIGHT = 18;

/** The DOM shape this file reads on web; `tsconfig` has no DOM typings. */
interface MeasuredNode {
  parentElement: MeasuredNode | null;
  previousElementSibling: MeasuredNode | null;
  children: ArrayLike<MeasuredNode>;
  textContent: string | null;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
  querySelectorAll(selector: string): ArrayLike<MeasuredNode>;
}

type ResizeObserverConstructor = new (callback: () => void) => {
  observe(target: unknown): void;
  disconnect(): void;
};

/**
 * The element this item was laid out in, found from the row rendered inside it:
 * wrapper frames that hold nothing but this row are stepped over until a
 * sibling with height appears above.
 */
function itemFrame(row: MeasuredNode): MeasuredNode | null {
  let frame: MeasuredNode | null = row;
  for (let depth = 0; depth < 8 && frame !== null; depth += 1) {
    const above = frame.previousElementSibling;
    if (above !== null && above.getBoundingClientRect().height > 0) return frame;
    frame = frame.parentElement;
  }
  return null;
}

/**
 * Bottom edge of the last visible line of text inside `node` — the footer's
 * line, or the answer's when a theme draws no footer at all.
 */
function lastTextBottom(node: MeasuredNode): number | null {
  let bottom: number | null = null;
  const lines = node.querySelectorAll("*");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.children.length > 0) continue;
    if (line.textContent === null || line.textContent.trim() === "") continue;
    const rect = line.getBoundingClientRect();
    if (rect.height <= 0) continue;
    bottom = bottom === null ? rect.bottom : Math.max(bottom, rect.bottom);
  }
  return bottom;
}

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
  const rowRef = useRef<MeasuredNode | null>(null);
  /** The lift currently in the DOM, which the next measurement has to discount. */
  const appliedLift = useRef(0);
  const data = item.data;

  const applyLift = (next: number) => {
    if (appliedLift.current === next) return;
    appliedLift.current = next;
    setLift(next);
  };

  // The footer above this row is the host's markup and, with a theme plugin
  // installed, that plugin's restyling of it — so its height and padding are
  // measured instead of assumed. This component's negative margin moves the
  // content inside its frame; the frame's own top is what gets measured, with
  // the applied lift taken back out.
  useLayoutEffect(() => {
    if (layout.platform !== "web" || data.final !== true) {
      applyLift(0);
      return;
    }
    const row = rowRef.current;
    const frame = row === null ? null : itemFrame(row);
    const above = frame?.previousElementSibling ?? null;
    if (frame === null || above === null) {
      applyLift(0);
      return;
    }
    const measure = () => {
      const footerBottom = lastTextBottom(above);
      if (footerBottom === null) {
        applyLift(0);
        return;
      }
      // `frame.top` already carries the lift applied last render. Comparing it
      // to the footer as-is would chase its own tail and bounce the row between
      // two positions; discount it to get the natural top.
      const naturalTop = frame.getBoundingClientRect().top - appliedLift.current;
      const gap = naturalTop - footerBottom;
      applyLift(Math.max(MAX_ROW_LIFT, Math.min(0, Math.round(DESIRED_GAP_ABOVE_STATS - gap))));
    };
    measure();
    const Observer = (globalThis as { ResizeObserver?: ResizeObserverConstructor }).ResizeObserver;
    if (Observer === undefined) return;
    const observer = new Observer(measure);
    observer.observe(above);
    return () => observer.disconnect();
    // `applyLift` only reads refs and a state setter, so the two values that can
    // change the layout this effect measures are the only dependencies.
  }, [data.final, layout.platform]);

  const muted = theme.colors.foregroundMuted;
  const base = {
    color: muted,
    fontSize: FOOTER_FONT_SIZE,
    lineHeight: FOOTER_LINE_HEIGHT,
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

  return (
    <Pressable
      ref={rowRef}
      accessibilityRole="button"
      accessibilityLabel={open ? "收起回答统计" : "展开回答统计"}
      onPress={() => setOpen((value) => !value)}
      style={{
        alignSelf: "flex-start",
        marginTop: data.final === true ? (layout.platform === "web" ? lift : FINAL_ROW_LIFT) : 0,
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
