import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
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

function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatNumber(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}K`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(Math.round(value));
}

function contextLine(data: StreamStats): string | undefined {
  if (data.contextUsed === undefined || data.contextMax === undefined || data.contextMax <= 0) {
    return undefined;
  }
  const ratio = Math.max(0, Math.min(1, data.contextUsed / data.contextMax));
  const filled = Math.round(ratio * 10);
  const bar = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  return `上下文  ${formatNumber(data.contextUsed)} / ${formatNumber(data.contextMax)}  ${bar}  ${Math.round(ratio * 100)}%`;
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

/** One muted line under an answer; tap to expand the full picture. */
function StreamStatsRow({ item, theme, layout }: PluginTimelineItemProps<StreamStats>) {
  const [open, setOpen] = useState(false);
  const data = item.data;
  const summary: string[] = [];
  if (data.turns !== undefined && data.steps !== undefined) {
    summary.push(`${data.turns} 轮 ${data.steps} 步`);
  }
  if (data.tokensPerSecond !== undefined) summary.push(`${Math.round(data.tokensPerSecond)} tok/s`);
  if (data.sessionTokens !== undefined) summary.push(`${formatCompact(data.sessionTokens)} tok`);
  if (data.cacheHit !== undefined) summary.push(`缓存命中 ${Math.round(data.cacheHit * 100)}%`);
  if (summary.length === 0 && data.firstTokenMs !== undefined) {
    summary.push(`首字 ${formatLatency(data.firstTokenMs)}`);
  }
  if (summary.length === 0) return null;

  const latencyLine =
    data.firstTokenMs === undefined ? undefined : `首字  ${formatLatency(data.firstTokenMs)}`;
  const details = [latencyLine, contextLine(data), tokensLine(data), routeLine(data), toolsLine(data)].filter(
    (line): line is string => line !== undefined,
  );
  const fontSize = layout.compact ? 10 : 11;
  const muted = { color: theme.colors.foregroundMuted, fontSize };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open ? "收起回答统计" : "展开回答统计"}
      onPress={() => setOpen((value) => !value)}
      style={{ alignSelf: "flex-start", marginTop: 0, marginBottom: 0, paddingLeft: 2 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={muted}>{summary.join(" · ")}</Text>
        <Text style={muted}>{open ? "▴" : "▾"}</Text>
      </View>
      {open ? (
        <View style={{ marginTop: 2, gap: 1 }}>
          {details.map((line) => (
            <Text key={line} style={muted}>
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
