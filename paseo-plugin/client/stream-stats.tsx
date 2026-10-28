import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Fragment, useState } from "react";
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
});

type StreamStats = z.infer<typeof streamStatsSchema>;

/** Readable on both themes; the theme exposes no semantic warning colours. */
const WARNING = "#d97706";
const DANGER = "#dc2626";

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

function contextColor(ratio: number | undefined, muted: string): string {
  if (ratio === undefined) return muted;
  if (ratio >= 0.9) return DANGER;
  if (ratio >= 0.7) return WARNING;
  return muted;
}

function contextLine(data: StreamStats, muted: string): { text: string; color: string } | undefined {
  const ratio = contextRatio(data);
  if (ratio === undefined) return undefined;
  const filled = Math.round(ratio * 10);
  const bar = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  return {
    text: `上下文  ${formatNumber(data.contextUsed ?? 0)} / ${formatNumber(data.contextMax ?? 0)}  ${bar}  ${Math.round(ratio * 100)}%`,
    color: contextColor(ratio, muted),
  };
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
  const data = item.data;
  const fontSize = layout.compact ? 10 : 11;
  const muted = theme.colors.foregroundMuted;
  const base = { color: muted, fontSize, fontVariant: ["tabular-nums"] as const };

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
    segments.push({ text: `上下文 ${Math.round(ratio * 100)}%`, color: contextColor(ratio, muted) });
  }
  if (data.cacheHit !== undefined) {
    segments.push({ text: `缓存命中 ${Math.round(data.cacheHit * 100)}%`, color: muted });
  }
  if (segments.length === 0) return null;

  const context = contextLine(data, muted);
  const details = [context?.text, tokensLine(data), routeLine(data), toolsLine(data)].filter(
    (line): line is string => line !== undefined,
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open ? "收起回答统计" : "展开回答统计"}
      onPress={() => setOpen((value) => !value)}
      style={{ alignSelf: "flex-start", marginTop: -6, marginBottom: 0, paddingLeft: 2 }}
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
          {details.map((line, index) => (
            <Text
              key={line}
              style={{ ...base, ...(index === 0 ? { color: contextColor(ratio, muted) } : {}) }}
            >
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
