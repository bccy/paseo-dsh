import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Fragment, useState } from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";
import { z } from "zod";
import { duration, integer, percent, tokens } from "./console-format";
import { font, space, tabular, tint, toneColor, usedTone, type Colors } from "./console-theme";
import { Bar, TokenBar, type TokenBarLabels } from "./console-ui";
import type { Locale } from "./locale";
import { useCurrentLocale } from "./use-locale";

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

interface StreamStatsCopy {
  readonly turnsSteps: (turns: string, steps: string, turnCount: number, stepCount: number) => string;
  readonly firstToken: (latency: string) => string;
  readonly contextShort: (pct: string) => string;
  readonly cacheHit: (pct: string) => string;
  readonly expandLabel: string;
  readonly collapseLabel: string;
  readonly contextLabel: string;
  readonly tokensLabel: string;
  readonly tokenLabels: TokenBarLabels;
  readonly routeLabel: string;
  readonly thinking: (option: string) => string;
  readonly toolsLabel: string;
  readonly toolCalls: (formattedCount: string, count: number) => string;
}

const STREAM_STATS_COPY: Readonly<Record<Locale, StreamStatsCopy>> = {
  "zh-CN": {
    turnsSteps: (turns, steps) => `${turns} 轮 ${steps} 步`,
    firstToken: (latency) => `首字 ${latency}`,
    contextShort: (pct) => `上下文 ${pct}`,
    cacheHit: (pct) => `缓存命中 ${pct}`,
    expandLabel: "展开回答统计",
    collapseLabel: "收起回答统计",
    contextLabel: "上下文",
    tokensLabel: "Tokens",
    tokenLabels: { cached: "缓存", input: "输入", output: "输出" },
    routeLabel: "路由",
    thinking: (option) => `思考 ${option}`,
    toolsLabel: "工具",
    toolCalls: (count) => `${count} 次`,
  },
  en: {
    turnsSteps: (turns, steps, turnCount, stepCount) =>
      `${turns} ${turnCount === 1 ? "turn" : "turns"}, ${steps} ${stepCount === 1 ? "step" : "steps"}`,
    firstToken: (latency) => `First token ${latency}`,
    contextShort: (pct) => `Context ${pct}`,
    cacheHit: (pct) => `Cache ${pct}`,
    expandLabel: "Expand response stats",
    collapseLabel: "Collapse response stats",
    contextLabel: "Context",
    tokensLabel: "Tokens",
    tokenLabels: { cached: "Cached", input: "Input", output: "Output" },
    routeLabel: "Route",
    thinking: (option) => `Thinking ${option}`,
    toolsLabel: "Tools",
    toolCalls: (formattedCount, count) => `${formattedCount} ${count === 1 ? "call" : "calls"}`,
  },
};

function contextRatio(data: StreamStats): number | undefined {
  if (
    data.contextUsed === undefined ||
    data.contextMax === undefined ||
    !Number.isFinite(data.contextUsed) ||
    !Number.isFinite(data.contextMax) ||
    data.contextMax <= 0
  ) {
    return undefined;
  }
  return Math.max(0, Math.min(1, data.contextUsed / data.contextMax));
}

function positiveFinite(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function MetaRow({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: Pick<Colors, "foreground" | "foregroundMuted">;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
      <Text style={{ ...font.caption, color: colors.foregroundMuted, flexShrink: 0 }}>{label}</Text>
      <Text
        selectable
        style={{
          ...font.caption,
          ...tabular,
          color: colors.foreground,
          flex: 1,
          minWidth: 0,
          textAlign: "right",
        }}
      >
        {value}
      </Text>
    </View>
  );
}

/** One compact line under an answer; tap to expand the full picture. */
function StreamStatsRow({ item, theme, layout }: PluginTimelineItemProps<StreamStats>) {
  const [open, setOpen] = useState(false);
  const locale = useCurrentLocale();
  const copy = STREAM_STATS_COPY[locale];
  const data = item.data;
  const colors = theme.colors;
  const fontSize = layout.compact ? 10 : 11;
  const muted = colors.foregroundMuted;
  const base: TextStyle = { color: muted, fontSize, ...tabular };

  const ratio = contextRatio(data);
  const segments: Array<{ key: string; text: string; color: string }> = [];
  if (
    data.turns !== undefined &&
    data.steps !== undefined &&
    Number.isFinite(data.turns) &&
    Number.isFinite(data.steps)
  ) {
    segments.push({
      key: "turns",
      text: copy.turnsSteps(
        integer(data.turns, locale),
        integer(data.steps, locale),
        Math.round(data.turns),
        Math.round(data.steps),
      ),
      color: muted,
    });
  }
  if (data.firstTokenMs !== undefined && Number.isFinite(data.firstTokenMs) && data.firstTokenMs >= 0) {
    const latency = duration(data.firstTokenMs, locale);
    if (latency !== "") {
      segments.push({ key: "ttft", text: copy.firstToken(latency), color: muted });
    }
  }
  if (data.tokensPerSecond !== undefined && Number.isFinite(data.tokensPerSecond)) {
    segments.push({
      key: "tps",
      text: `${integer(Math.round(data.tokensPerSecond), locale)} tok/s`,
      color: muted,
    });
  }
  if (ratio !== undefined) {
    segments.push({ key: "context", text: copy.contextShort(percent(ratio, locale)), color: muted });
  }
  if (data.cacheHit !== undefined && Number.isFinite(data.cacheHit)) {
    segments.push({ key: "cache", text: copy.cacheHit(percent(data.cacheHit, locale)), color: muted });
  }
  if (segments.length === 0) return null;

  const cachedTokens = positiveFinite(data.cachedInputTokens);
  const freshInputTokens = positiveFinite(data.inputTokens);
  const outputTokens = positiveFinite(data.outputTokens);
  const tokenTotal = cachedTokens + freshInputTokens + outputTokens;
  const hasTokenBar = tokenTotal > 0;

  const routeValue =
    data.provider !== undefined || data.model !== undefined
      ? `${[data.provider, data.model].filter((part): part is string => part !== undefined).join(" / ")}${
          data.thinkingOption === undefined ? "" : ` · ${copy.thinking(data.thinkingOption)}`
        }`
      : undefined;

  const toolCallsCount =
    data.toolCalls !== undefined && Number.isFinite(data.toolCalls) && data.toolCalls > 0
      ? Math.round(data.toolCalls)
      : undefined;
  const toolDuration =
    data.toolMs !== undefined && Number.isFinite(data.toolMs) && data.toolMs >= 0
      ? duration(data.toolMs, locale)
      : "";
  const toolsValue =
    toolCallsCount !== undefined
      ? `${copy.toolCalls(integer(toolCallsCount, locale), toolCallsCount)}${
          toolDuration !== "" ? ` · ${toolDuration}` : ""
        }`
      : undefined;

  const hasVisualSection = ratio !== undefined || hasTokenBar;
  const hasMetaSection = routeValue !== undefined || toolsValue !== undefined;
  const hasDetails = hasVisualSection || hasMetaSection;
  const contextTone = usedTone(ratio);

  return (
    <View style={{ marginTop: 0, marginBottom: 0, paddingLeft: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open && hasDetails }}
        accessibilityLabel={open ? copy.collapseLabel : copy.expandLabel}
        onPress={() => {
          if (hasDetails) setOpen((value) => !value);
        }}
        style={{ alignSelf: "flex-start" }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
          {segments.map((segment, index) => (
            <Fragment key={segment.key}>
              {index > 0 ? <Text style={base}> · </Text> : null}
              <Text style={{ ...base, color: segment.color }}>{segment.text}</Text>
            </Fragment>
          ))}
          {hasDetails ? <Text style={base}>{open ? " ▴" : " ▾"}</Text> : null}
        </View>
      </Pressable>
      {open && hasDetails ? (
        <View
          style={{
            marginTop: space.xs + 2,
            width: "100%",
            maxWidth: 460,
            borderRadius: 10,
            paddingVertical: 10,
            paddingHorizontal: 12,
            backgroundColor: colors.surface1,
            borderWidth: 1,
            borderColor: colors.border,
            gap: space.sm,
          }}
        >
          {ratio !== undefined ? (
            <View style={{ gap: space.xs }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: space.sm,
                }}
              >
                <Text style={{ ...font.caption, color: colors.foregroundMuted }}>
                  {copy.contextLabel}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
                  <Text style={{ ...font.caption, ...tabular, color: colors.foreground }}>
                    {`${tokens(data.contextUsed ?? 0)} / ${tokens(data.contextMax ?? 0)}`}
                  </Text>
                  <Text
                    style={{
                      ...font.caption,
                      ...tabular,
                      fontWeight: "600",
                      color: toneColor(colors, contextTone),
                    }}
                  >
                    {percent(ratio, locale)}
                  </Text>
                </View>
              </View>
              <Bar colors={colors} fraction={ratio} tone={contextTone} height={6} />
            </View>
          ) : null}

          {hasTokenBar ? (
            <View style={{ gap: space.xs }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: space.sm,
                }}
              >
                <Text style={{ ...font.caption, color: colors.foregroundMuted }}>
                  {copy.tokensLabel}
                </Text>
                <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                  {tokens(tokenTotal)}
                </Text>
              </View>
              <TokenBar
                colors={colors}
                cached={cachedTokens}
                input={freshInputTokens}
                output={outputTokens}
                labels={copy.tokenLabels}
                height={6}
              />
            </View>
          ) : null}

          {hasMetaSection ? (
            <View
              style={
                hasVisualSection
                  ? {
                      gap: space.xs,
                      paddingTop: space.sm,
                      borderTopWidth: 1,
                      borderTopColor: tint(colors.foreground, 0.08),
                    }
                  : { gap: space.xs }
              }
            >
              {routeValue !== undefined ? (
                <MetaRow label={copy.routeLabel} value={routeValue} colors={colors} />
              ) : null}
              {toolsValue !== undefined ? (
                <MetaRow label={copy.toolsLabel} value={toolsValue} colors={colors} />
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
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
