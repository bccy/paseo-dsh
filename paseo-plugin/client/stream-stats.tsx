import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { z } from "zod";

export const streamStatsSchema = z.object({
  firstTokenMs: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  outputTokens: z.number().optional(),
});

type StreamStats = z.infer<typeof streamStatsSchema>;

function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** One muted line under an answer: first-token latency and output speed. */
function StreamStatsRow({ item, theme, layout }: PluginTimelineItemProps<StreamStats>) {
  const parts: string[] = [];
  if (item.data.firstTokenMs !== undefined) parts.push(`首字 ${formatLatency(item.data.firstTokenMs)}`);
  if (item.data.tokensPerSecond !== undefined) parts.push(`${item.data.tokensPerSecond.toFixed(1)} tok/s`);
  if (parts.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginTop: 2, marginBottom: layout.compact ? 6 : 10 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: layout.compact ? 10 : 11 }}>
        {parts.join(" · ")}
      </Text>
    </View>
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
