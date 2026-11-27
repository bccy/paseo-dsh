/**
 * Usage analytics tab for the DSH console.
 *
 * Consumes `dsh.usage.stats` and `dsh.usage.daily` via `PluginClientContext.rpc`
 * and updates display currency via `dsh.pricing.update`. Pure React Native
 * (`View` + `Pressable`), zero SVG charting libraries, zero browser-only APIs,
 * Hermes-safe, dark/light theme friendly, and fully bilingual (`zh-CN` / `en`).
 *
 * @module dsh-paseo/client/console-usage
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { pricingUpdateRpc } from "../shared/pricing";
import type { CapabilitiesSnapshot } from "../shared/capabilities";
import {
  deriveUsageMetrics,
  emptyUsageTotals,
  usageDailyRpc,
  usageStatsRpc,
  type UsageAccountRow,
  type UsageBin,
  type UsageDaily,
  type UsageIndexingStatus,
  type UsageModelRow,
  type UsageRange,
  type UsageScope,
  type UsageSource,
  type UsageStats,
  type UsageTotals,
} from "../shared/usage";
import {
  clockTime,
  currencySymbol,
  dayLabel,
  integer,
  money,
  moneyFixed,
  moneyShort,
  percent,
  tokens,
  type Currency,
} from "./console-format";
import { ConsoleHeatmap } from "./console-heatmap";
import { font, radius, space, tabular, tint, type Colors } from "./console-theme";
import { Bar, Button, Callout, Card, Muted, SegmentedControl } from "./console-ui";
import { useCurrentLocale } from "./use-locale";

type PressState = { pressed: boolean; hovered?: boolean };
type ChartMetric = "tokens" | "cost" | "requests" | "tps" | "cache" | "firstToken";
type TableSortKey = "model" | "requests" | "input" | "cached" | "cache" | "output" | "speed" | "cost";
type ShareSourceKey = "tokens" | "requests" | "input" | "cached" | "output" | "cost";

interface SelectedModelFilter {
  /** Composite key (`provider/model`) matched by `server/usage-stats.ts`. */
  id: string;
  label: string;
  provider: string;
}

const NARROW_BREAKPOINT = 560;
const WIDE_TABLE_BREAKPOINT = 740;
const INDEXING_POLL_MS = 1_200;
const BACKGROUND_REFRESH_MS = 60_000;

const METRICS: readonly ChartMetric[] = [
  "tokens",
  "cost",
  "requests",
  "tps",
  "cache",
  "firstToken",
];

interface UsageCopy {
  title: string;
  refreshButton: string;
  pricingButton: string;
  switchCurrencyLabel(currency: Currency, symbol: string): string;
  scopeAll: string;
  scopeMain: string;
  scopeSubagent: string;
  sourceAll: string;
  sourceDsh: string;
  sourceAntigravity: string;
  sourceAntigravityShort: string;
  rangeToday: string;
  range7d: string;
  range30d: string;
  allProviders: string;
  allAccounts: string;
  filterModel(model: string): string;
  clearFilter: string;
  clearFilters: string;
  indexingScanning: string;
  indexingProgress(done: string, total: string): string;
  retry: string;
  loadErrorTitle: string;
  emptyRange: string;
  emptyFiltered: string;
  windowSince(start: string): string;
  perHour: string;
  perSixHours: string;
  perDay: string;
  noRequests: string;
  metric: Record<ChartMetric, string>;
  readoutTokens(value: string): string;
  readoutRequests(count: number, formatted: string): string;
  tokensSplit(input: string, output: string): string;
  costUnpricedAll: string;
  costAvg(avg: string): string;
  costAvgCustom(avg: string): string;
  costPartial(priced: string, total: string, avg: string): string;
  splitSummary(main: string, subagent: string): string;
  sessionsCount(count: number, formatted: string): string;
  avgOutput(value: string): string;
  cachedTokens(value: string): string;
  avgContext(value: string): string;
  modelsTitle: string;
  modelsHint: string;
  sortLabel: string;
  sortBy(column: string): string;
  editPricingFor(model: string): string;
  totalRow: string;
  partialPriceHint: string;
  unpricedHint: string;
  setPriceCta: string;
  setPriceShort: string;
  unpricedBanner(count: number): string;
  configureNow: string;
  col: Record<TableSortKey, string>;
}

const COPY_EN: UsageCopy = {
  title: "Usage",
  refreshButton: "Refresh usage",
  pricingButton: "Pricing",
  switchCurrencyLabel: (currency, symbol) =>
    `Switch display currency, currently ${currency} ${symbol}`,
  scopeAll: "All",
  scopeMain: "Main",
  scopeSubagent: "Subagent",
  sourceAll: "All",
  sourceDsh: "DSH",
  sourceAntigravity: "Antigravity",
  sourceAntigravityShort: "AGY",
  rangeToday: "Today",
  range7d: "7d",
  range30d: "30d",
  allProviders: "All providers",
  allAccounts: "All accounts",
  filterModel: (model) => `Model: ${model}`,
  clearFilter: "Clear filter",
  clearFilters: "Clear filters",
  indexingScanning: "Scanning session logs…",
  indexingProgress: (done, total) => `Indexing session logs (${done} / ${total})`,
  retry: "Retry",
  loadErrorTitle: "Could not load usage statistics",
  emptyRange: "No usage recorded in this window.",
  emptyFiltered: "No usage matches the active filters in this window.",
  windowSince: (start) => `${start} – now`,
  perHour: "per hour",
  perSixHours: "per 6 hours",
  perDay: "per day",
  noRequests: "No requests",
  metric: {
    tokens: "Tokens",
    cost: "Estimated cost",
    requests: "Requests",
    tps: "Output speed",
    cache: "Cache hit rate",
    firstToken: "First token",
  },
  readoutTokens: (value) => `${value} tokens`,
  readoutRequests: (count, formatted) => `${formatted} ${count === 1 ? "request" : "requests"}`,
  tokensSplit: (input, output) => `In ${input} · Out ${output}`,
  costUnpricedAll: "No rates set — click Pricing",
  costAvg: (avg) => `Avg ${avg}/req`,
  costAvgCustom: (avg) => `Avg ${avg}/req · Custom`,
  costPartial: (priced, total, avg) => `${priced}/${total} priced · Avg ${avg}`,
  splitSummary: (main, subagent) => `Main ${main} · Subagent ${subagent}`,
  sessionsCount: (count, formatted) => `${formatted} ${count === 1 ? "session" : "sessions"}`,
  avgOutput: (value) => `Avg ${value} out/req`,
  cachedTokens: (value) => `${value} cached`,
  avgContext: (value) => `Avg ${value} prompt`,
  modelsTitle: "Models",
  modelsHint: "Click a row to filter · Click cost to edit rates",
  sortLabel: "Sort",
  sortBy: (column) => `Sort by ${column}`,
  editPricingFor: (model) => `Edit pricing for ${model}`,
  totalRow: "Total",
  partialPriceHint: "Partially priced — click to set rates",
  unpricedHint: "Unpriced — click to set rates",
  setPriceCta: "Set price",
  setPriceShort: "Set rate",
  unpricedBanner: (count) =>
    `${count} ${count === 1 ? "model has" : "models have"} no price configured`,
  configureNow: "Configure",
  col: {
    model: "Model",
    requests: "Reqs",
    input: "Input",
    cached: "Cached",
    cache: "Cache %",
    output: "Output",
    speed: "Speed",
    cost: "Cost",
  },
};

const COPY_ZH: UsageCopy = {
  title: "用量统计",
  refreshButton: "刷新用量",
  pricingButton: "单价设置",
  switchCurrencyLabel: (currency, symbol) => `切换显示币种，当前 ${currency} ${symbol}`,
  scopeAll: "全部",
  scopeMain: "主对话",
  scopeSubagent: "子代理",
  sourceAll: "全部",
  sourceDsh: "DSH",
  sourceAntigravity: "Antigravity",
  sourceAntigravityShort: "AGY",
  rangeToday: "今天",
  range7d: "7天",
  range30d: "30天",
  allProviders: "全部路由",
  allAccounts: "全部账号",
  filterModel: (model) => `模型：${model}`,
  clearFilter: "清除筛选",
  clearFilters: "清除全部筛选",
  indexingScanning: "正在扫描会话日志…",
  indexingProgress: (done, total) => `正在索引会话日志（${done} / ${total}）`,
  retry: "重试",
  loadErrorTitle: "无法加载用量统计",
  emptyRange: "当前时间范围内暂无用量记录。",
  emptyFiltered: "当前筛选条件下暂无用量记录。",
  windowSince: (start) => `${start} – 现在`,
  perHour: "按小时",
  perSixHours: "按 6 小时",
  perDay: "按天",
  noRequests: "无请求",
  metric: {
    tokens: "Token 总量",
    cost: "估算费用",
    requests: "请求数",
    tps: "输出速度",
    cache: "缓存命中",
    firstToken: "首字延迟",
  },
  readoutTokens: (value) => `${value} tokens`,
  readoutRequests: (_count, formatted) => `${formatted} 次请求`,
  tokensSplit: (input, output) => `输入 ${input} · 输出 ${output}`,
  costUnpricedAll: "未配置单价，点右上角设置",
  costAvg: (avg) => `均 ${avg}/次`,
  costAvgCustom: (avg) => `均 ${avg}/次 · 自定义单价`,
  costPartial: (priced, total, avg) => `已计价 ${priced}/${total} · 均 ${avg}`,
  splitSummary: (main, subagent) => `主对话 ${main} · 子代理 ${subagent}`,
  sessionsCount: (_count, formatted) => `${formatted} 个会话`,
  avgOutput: (value) => `均输出 ${value}/次`,
  cachedTokens: (value) => `命中缓存 ${value}`,
  avgContext: (value) => `均上下文 ${value}`,
  modelsTitle: "模型明细",
  modelsHint: "点行交叉筛选 · 点费用编辑单价",
  sortLabel: "排序",
  sortBy: (column) => `按${column}排序`,
  editPricingFor: (model) => `编辑 ${model} 的单价`,
  totalRow: "合计",
  partialPriceHint: "部分未计价，点击设置单价",
  unpricedHint: "未计价，点击设置单价",
  setPriceCta: "配置单价",
  setPriceShort: "未定价",
  unpricedBanner: (count) => `${count} 个模型尚未配置单价`,
  configureNow: "去配置",
  col: {
    model: "模型",
    requests: "请求",
    input: "输入",
    cached: "缓存",
    cache: "命中率",
    output: "输出",
    speed: "速度",
    cost: "费用",
  },
};

function formatSecondsCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} s`;
}

function formatSecondsValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

function formatTps(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return String(Math.round(value));
}

/** Smallest tidy ceiling >= `value` so axis ticks stay readable and halves stay clean. */
function niceCeiling(value: number, allowFraction = false): number {
  if (!Number.isFinite(value) || value <= 0) return allowFraction ? 1 : 2;
  if (allowFraction && value < 0.01) {
    const exp = Math.floor(Math.log10(value));
    const base = 10 ** exp;
    for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
      if (step * base >= value) return step * base;
    }
    return 10 * base;
  }
  if (!allowFraction && value <= 2) return 2;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * base;
    if (candidate >= value && (allowFraction || Number.isInteger(candidate / 2))) {
      return candidate;
    }
  }
  return 10 * base;
}

function binMetricValue(bin: UsageTotals, metric: ChartMetric): number {
  const derived = deriveUsageMetrics(bin);
  switch (metric) {
    case "tokens":
      return derived.totalTokens;
    case "cost":
      return derived.cost ?? 0;
    case "requests":
      return bin.requests;
    case "tps":
      return derived.tps ?? 0;
    case "cache":
      return derived.cacheHitRate ?? 0;
    case "firstToken":
      return derived.firstTokenSec ?? 0;
  }
}

function formatAxisTick(
  value: number,
  metric: ChartMetric,
  currency: Currency,
  locale: string,
): string {
  switch (metric) {
    case "requests":
      return integer(Math.round(value), locale);
    case "cost":
      return moneyShort(value, currency);
    case "tokens":
      return tokens(Math.round(value));
    case "tps":
      return String(Math.round(value));
    case "cache":
      return percent(value, locale);
    case "firstToken":
      return value === 0 ? "0" : `${value < 10 ? value.toFixed(1) : Math.round(value)}s`;
  }
}

function formatMetricReadout(
  bin: UsageTotals,
  metric: ChartMetric,
  currency: Currency,
  locale: string,
  copy: UsageCopy,
): string {
  const derived = deriveUsageMetrics(bin);
  switch (metric) {
    case "tokens":
      return copy.readoutTokens(tokens(derived.totalTokens));
    case "cost":
      return derived.cost === null ? "—" : money(derived.cost, currency, locale);
    case "requests":
      return copy.readoutRequests(bin.requests, integer(bin.requests, locale));
    case "tps":
      return derived.tps === null ? "—" : `${formatTps(derived.tps)} tok/s`;
    case "cache":
      return derived.cacheHitRate === null ? "—" : percent(derived.cacheHitRate, locale);
    case "firstToken":
      return formatSecondsCompact(derived.firstTokenSec);
  }
}

function formatTooltipMetric(
  bin: UsageTotals,
  metric: ChartMetric,
  currency: Currency,
  locale: string,
): string {
  const derived = deriveUsageMetrics(bin);
  switch (metric) {
    case "tokens":
      return tokens(derived.totalTokens);
    case "cost":
      return derived.cost === null ? "—" : money(derived.cost, currency, locale);
    case "requests":
      return integer(bin.requests, locale);
    case "tps":
      return derived.tps === null ? "—" : `${formatTps(derived.tps)} tok/s`;
    case "cache":
      return derived.cacheHitRate === null ? "—" : percent(derived.cacheHitRate, locale);
    case "firstToken":
      return formatSecondsCompact(derived.firstTokenSec);
  }
}

function sumModelTotals(rows: readonly UsageModelRow[]): UsageTotals {
  const sum = emptyUsageTotals();
  for (const row of rows) {
    sum.requests += row.requests;
    sum.input += row.input;
    sum.cached += row.cached;
    sum.cacheWrite += row.cacheWrite;
    sum.output += row.output;
    sum.totalTokens += row.totalTokens;
    sum.generationSeconds += row.generationSeconds;
    sum.generationOutput += row.generationOutput;
    sum.firstTokenSeconds += row.firstTokenSeconds;
    sum.firstTokenRequests += row.firstTokenRequests;
    sum.cost += row.cost;
    sum.pricedRequests += row.pricedRequests;
  }
  return sum;
}

function binTimeLabel(start: number, end: number, binMs: number, locale: string): string {
  const day = dayLabel(new Date(start), locale);
  if (binMs >= 86_400_000) return day;
  return `${day} ${clockTime(start, locale)}–${clockTime(end, locale)}`;
}

function tickTimeLabel(start: number, binMs: number, locale: string): string {
  if (binMs >= 6 * 3_600_000) {
    return dayLabel(new Date(start), locale);
  }
  return clockTime(start, locale);
}

function shouldShowTick(start: number, binMs: number, index: number, total: number): boolean {
  if (index === 0 || index === total - 1) return false;
  const date = new Date(start);
  if (binMs >= 86_400_000) return index % 5 === 0;
  if (binMs >= 6 * 3_600_000) return date.getHours() === 0;
  return date.getHours() % 6 === 0;
}

function windowLabel(stats: UsageStats, locale: string, copy: UsageCopy): string {
  const first = stats.bins[0];
  const last = stats.bins[stats.bins.length - 1];
  if (!first || !last) return "";
  if (stats.binMs >= 86_400_000) {
    return `${dayLabel(new Date(first.start), locale)} – ${dayLabel(new Date(last.end - 1), locale)}`;
  }
  return copy.windowSince(`${dayLabel(new Date(first.start), locale)} ${clockTime(first.start, locale)}`);
}

function activeIndexingOf(
  stats: UsageStats | null,
  daily: UsageDaily | null,
): UsageIndexingStatus | null {
  const a = stats?.indexing;
  const b = daily?.indexing;
  if (a?.active && b?.active) {
    return a.total >= b.total ? a : b;
  }
  if (a?.active) return a;
  if (b?.active) return b;
  return a ?? b ?? null;
}

/** Tiny embedded column sparkline; emphasizes the latest active bin in accent. */
function MiniColumns({
  colors,
  values,
  height = 26,
}: {
  colors: Colors;
  values: ReadonlyArray<number | null>;
  height?: number;
}) {
  const peak = Math.max(0, ...values.map((value) => (value && Number.isFinite(value) ? value : 0)));
  let lastActiveIndex = -1;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null && value !== undefined && Number.isFinite(value) && value > 0) {
      lastActiveIndex = index;
      break;
    }
  }
  const maxBarHeight = Math.max(4, height - 2);
  return (
    <View
      style={{
        height,
        flexDirection: "row",
        alignItems: "flex-end",
        gap: 2,
        borderBottomWidth: 1,
        borderBottomColor: tint(colors.foreground, 0.1),
      }}
    >
      {values.map((value, index) => (
        <View key={index} style={{ flex: 1, height: "100%", justifyContent: "flex-end" }}>
          {value && peak > 0 ? (
            <View
              style={{
                height: Math.max(2, (value / peak) * maxBarHeight),
                borderTopLeftRadius: 2,
                borderTopRightRadius: 2,
                backgroundColor:
                  index === lastActiveIndex ? colors.accent : tint(colors.foreground, 0.2),
              }}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** Clickable KPI tile that selects the main chart metric. */
function StatTile({
  colors,
  label,
  value,
  unit,
  foot,
  width,
  selected,
  compact,
  onPress,
  children,
}: {
  colors: Colors;
  label: string;
  value: string;
  unit?: string;
  foot: string;
  width: number | "100%";
  selected: boolean;
  compact: boolean;
  onPress(): void;
  children: ReactNode;
}) {
  const edge = selected ? 2 : 1;
  const basePad = compact ? space.md : space.lg;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}: ${value}${unit ? ` ${unit}` : ""}. ${foot}`}
      onPress={onPress}
      style={(state) => ({
        width,
        padding: basePad - edge + 1,
        gap: space.xs,
        borderRadius: radius.lg,
        borderWidth: edge,
        borderColor: selected
          ? colors.accent
          : (state as PressState).hovered
            ? tint(colors.foreground, 0.24)
            : colors.border,
        backgroundColor: colors.surface1,
      })}
    >
      <Text
        numberOfLines={1}
        style={{ ...font.small, color: selected ? colors.foreground : colors.foregroundMuted }}
      >
        {label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.xs }}>
        {/* Big KPI figure stays proportional; tabular digits look overly spaced at display size. */}
        <Text
          numberOfLines={1}
          style={{
            fontSize: compact ? 22 : 26,
            lineHeight: compact ? 28 : 32,
            fontWeight: "600",
            color: colors.foreground,
            flexShrink: 1,
          }}
        >
          {value}
        </Text>
        {unit ? (
          <Text numberOfLines={1} style={{ ...font.small, color: colors.foregroundMuted }}>
            {unit}
          </Text>
        ) : null}
      </View>
      <Text
        numberOfLines={2}
        style={{ ...font.caption, ...tabular, color: colors.foregroundMuted, minHeight: 16 }}
      >
        {foot}
      </Text>
      <View style={{ height: 32, justifyContent: "flex-end", marginTop: "auto", paddingTop: space.xs }}>
        {children}
      </View>
    </Pressable>
  );
}

/** Pure-RN interactive bar chart with edge-avoiding all-6-metric tooltip on hover and tap. */
function MetricChart({
  colors,
  stats,
  metric,
  currency,
  locale,
  compact,
  copy,
}: {
  colors: Colors;
  stats: UsageStats;
  metric: ChartMetric;
  currency: Currency;
  locale: string;
  compact: boolean;
  copy: UsageCopy;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [plotWidth, setPlotWidth] = useState(0);
  const pointerActive = useRef(false);
  const bins = stats.bins;

  useEffect(() => {
    setHovered(null);
    setPinned(null);
    pointerActive.current = false;
  }, [stats.range, bins.length]);

  const lastActive = useMemo(() => {
    for (let index = bins.length - 1; index >= 0; index -= 1) {
      if (bins[index]!.requests > 0) return index;
    }
    return Math.max(0, bins.length - 1);
  }, [bins]);

  const pointerIndex = hovered !== null ? hovered : pinned;
  const selectedIndex =
    pointerIndex !== null && pointerIndex < bins.length ? pointerIndex : lastActive;

  const rawValues = useMemo(() => bins.map((bin) => binMetricValue(bin, metric)), [bins, metric]);
  const maxVal = Math.max(0, ...rawValues);
  const peak =
    metric === "cache"
      ? 1
      : niceCeiling(maxVal, metric === "firstToken" || metric === "cost");

  const chartHeight = 144;
  const plotTop = 8;
  const plotHeight = chartHeight - plotTop - 4;
  const topLabel = formatAxisTick(peak, metric, currency, locale);
  const axisWidth = Math.max(32, topLabel.length * 7.5);
  const activeBin: UsageBin | undefined = bins[selectedIndex];
  const periodLabel =
    stats.binMs >= 86_400_000
      ? copy.perDay
      : stats.binMs >= 6 * 3_600_000
        ? copy.perSixHours
        : copy.perHour;

  const columnWidth = bins.length > 0 && plotWidth > 0 ? plotWidth / bins.length : 0;
  const tooltipBin =
    pointerIndex !== null && pointerIndex < bins.length ? bins[pointerIndex] : undefined;
  const tooltipCenter = pointerIndex === null ? 0 : (pointerIndex + 0.5) * columnWidth;
  const tooltipWidth = Math.min(212, Math.max(150, plotWidth));
  const rightOfBar = tooltipCenter + columnWidth / 2 + 6;
  const leftOfBar = tooltipCenter - columnWidth / 2 - 6 - tooltipWidth;
  const fitsRight = rightOfBar + tooltipWidth <= plotWidth;
  const fitsLeft = leftOfBar >= 0;
  const centered = Math.min(
    Math.max(tooltipCenter - tooltipWidth / 2, 0),
    Math.max(0, plotWidth - tooltipWidth),
  );
  const tooltipLeft =
    tooltipCenter < plotWidth / 2
      ? fitsRight
        ? rightOfBar
        : fitsLeft
          ? leftOfBar
          : centered
      : fitsLeft
        ? leftOfBar
        : fitsRight
          ? rightOfBar
          : centered;

  return (
    <Card colors={colors} style={{ padding: compact ? space.md : space.lg, gap: space.md, zIndex: 1 }}>
      <View
        style={{
          flexDirection: compact ? "column" : "row",
          alignItems: compact ? "flex-start" : "baseline",
          gap: compact ? 2 : space.md,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "baseline",
            gap: space.sm,
            flex: compact ? undefined : 1,
            minWidth: 0,
          }}
        >
          <Text numberOfLines={1} style={{ ...font.heading, color: colors.foreground, flexShrink: 1 }}>
            {copy.metric[metric]}
          </Text>
          <Text numberOfLines={1} style={{ ...font.small, color: colors.foregroundMuted }}>
            {periodLabel}
          </Text>
        </View>
        {activeBin ? (
          <Text numberOfLines={1} style={{ ...font.small, ...tabular, color: colors.foregroundMuted }}>
            {`${binTimeLabel(activeBin.start, activeBin.end, stats.binMs, locale)}   `}
            <Text style={{ color: colors.foreground, fontWeight: "600", ...tabular }}>
              {activeBin.requests === 0
                ? copy.noRequests
                : formatMetricReadout(activeBin, metric, currency, locale, copy)}
            </Text>
          </Text>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", gap: space.sm, zIndex: 2 }}>
        <View style={{ width: axisWidth, height: chartHeight }}>
          {[peak, peak / 2, 0].map((tick, index) => (
            <Text
              key={index}
              numberOfLines={1}
              style={{
                ...font.caption,
                ...tabular,
                color: colors.foregroundMuted,
                position: "absolute",
                right: 0,
                top: plotTop + (index * plotHeight) / 2 - 8,
                lineHeight: 16,
              }}
            >
              {formatAxisTick(tick, metric, currency, locale)}
            </Text>
          ))}
        </View>

        <View
          style={{ flex: 1 }}
          onLayout={(event) => {
            const next = event.nativeEvent.layout.width;
            setPlotWidth((prev) => (Math.abs(prev - next) <= 0.5 ? prev : next));
          }}
        >
          <Pressable
            accessible={false}
            focusable={false}
            onPress={() => setPinned(null)}
            style={{ height: chartHeight }}
          >
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: plotTop,
                height: 1,
                backgroundColor: tint(colors.foreground, 0.07),
              }}
            />
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: plotTop + plotHeight / 2,
                height: 1,
                backgroundColor: tint(colors.foreground, 0.07),
              }}
            />
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: plotTop + plotHeight,
                height: 1,
                backgroundColor: tint(colors.foreground, 0.18),
              }}
            />

            <View
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                bottom: chartHeight - plotTop - plotHeight,
                flexDirection: "row",
              }}
            >
              {bins.map((entry, index) => {
                const active = index === selectedIndex;
                const val = rawValues[index] ?? 0;
                const barHeight =
                  val > 0 && peak > 0 ? Math.max(3, Math.min(1, val / peak) * plotHeight) : 0;
                return (
                  <Pressable
                    key={entry.start}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`${binTimeLabel(entry.start, entry.end, stats.binMs, locale)}: ${
                      entry.requests === 0
                        ? copy.noRequests
                        : formatMetricReadout(entry, metric, currency, locale, copy)
                    }`}
                    onHoverIn={() => {
                      pointerActive.current = true;
                      setHovered(index);
                    }}
                    onHoverOut={() => {
                      pointerActive.current = false;
                      setHovered((current) => (current === index ? null : current));
                    }}
                    onPress={(event) => {
                      event.stopPropagation?.();
                      setPinned((current) => (current === index ? null : index));
                    }}
                    style={(state) => ({
                      flex: 1,
                      height: "100%",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      backgroundColor:
                        (state as PressState).hovered || pinned === index
                          ? tint(colors.foreground, 0.04)
                          : "transparent",
                    })}
                  >
                    {barHeight > 0 ? (
                      <View
                        style={{
                          width: "62%",
                          maxWidth: 24,
                          height: barHeight,
                          borderTopLeftRadius: 4,
                          borderTopRightRadius: 4,
                          backgroundColor: active ? colors.accent : tint(colors.accent, 0.35),
                        }}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </Pressable>

          <View style={{ flexDirection: "row", marginTop: space.xs, height: 16 }}>
            {bins.map((entry, index) => (
              <View key={entry.start} style={{ flex: 1, alignItems: "center" }}>
                {shouldShowTick(entry.start, stats.binMs, index, bins.length) ? (
                  <View
                    pointerEvents="none"
                    style={{ position: "absolute", width: 72, alignItems: "center" }}
                  >
                    <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                      {tickTimeLabel(entry.start, stats.binMs, locale)}
                    </Text>
                  </View>
                ) : null}
              </View>
            ))}
          </View>

          {tooltipBin && columnWidth > 0 ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                zIndex: 10,
                top: 0,
                left: tooltipLeft,
                width: tooltipWidth,
                padding: space.sm + 2,
                gap: 3,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface0,
                shadowColor: "#000",
                shadowOpacity: 0.14,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 4 },
                elevation: 4,
              }}
            >
              <Text
                numberOfLines={1}
                style={{ ...font.caption, ...tabular, color: colors.foregroundMuted, marginBottom: 2 }}
              >
                {binTimeLabel(tooltipBin.start, tooltipBin.end, stats.binMs, locale)}
              </Text>
              {tooltipBin.requests === 0 ? (
                <Text style={{ ...font.small, color: colors.foreground }}>{copy.noRequests}</Text>
              ) : (
                METRICS.map((item) => (
                  <View
                    key={item}
                    style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{ ...font.caption, color: colors.foregroundMuted, flex: 1 }}
                    >
                      {copy.metric[item]}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{
                        ...font.caption,
                        ...tabular,
                        color: colors.foreground,
                        fontWeight: item === metric ? "700" : "500",
                      }}
                    >
                      {formatTooltipMetric(tooltipBin, item, currency, locale)}
                    </Text>
                  </View>
                ))
              )}
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

/** Uncached input tokens (`input + cacheWrite`), so `Input + Cached + Output === totalTokens`. */
function rowUncachedInput(totals: Pick<UsageTotals, "input" | "cacheWrite">): number {
  return totals.input + totals.cacheWrite;
}

function rowNumericSortValue(row: UsageModelRow, key: Exclude<TableSortKey, "model">): number | null {
  switch (key) {
    case "requests":
      return row.requests;
    case "input":
      return rowUncachedInput(row);
    case "cached":
      return row.cached;
    case "cache":
      return row.cacheHitRate;
    case "output":
      return row.output;
    case "speed":
      return row.tps;
    case "cost":
      return row.priced === "none" ? null : row.cost;
  }
}

function rowShareMetric(row: UsageModelRow, key: ShareSourceKey): number {
  switch (key) {
    case "requests":
      return row.requests;
    case "input":
      return rowUncachedInput(row);
    case "cached":
      return row.cached;
    case "output":
      return row.output;
    case "cost":
      return row.priced === "none" ? 0 : row.cost;
    case "tokens":
      return row.totalTokens;
  }
}

function shareKeyForSort(sortKey: TableSortKey | null): ShareSourceKey {
  if (
    sortKey === "requests" ||
    sortKey === "input" ||
    sortKey === "cached" ||
    sortKey === "output" ||
    sortKey === "cost"
  ) {
    return sortKey;
  }
  return "tokens";
}

const NUMERIC_COLUMNS: readonly Exclude<TableSortKey, "model">[] = [
  "requests",
  "input",
  "cached",
  "cache",
  "output",
  "speed",
  "cost",
];

/** 8-column sortable model breakdown table that collapses to 2-row compact cards below 560px. */
function ModelTable({
  colors,
  stats,
  currency,
  locale,
  width,
  selectedModelId,
  onToggleModel,
  onOpenPricing,
  copy,
}: {
  colors: Colors;
  stats: UsageStats;
  currency: Currency;
  locale: string;
  width: number;
  selectedModelId: string | null;
  onToggleModel(row: UsageModelRow): void;
  onOpenPricing(pricingKey: string): void;
  copy: UsageCopy;
}) {
  const isCardLayout = width < NARROW_BREAKPOINT;
  const roomyColumns = width >= WIDE_TABLE_BREAKPOINT;
  // Default `null` keeps the engine's total-token share order; clicking any of the 8 headers sorts explicitly.
  const [sort, setSort] = useState<{ key: TableSortKey | null; descending: boolean }>({
    key: null,
    descending: true,
  });

  const showProviderSublabel = useMemo(() => {
    const distinctProviders = new Set(stats.models.map((row) => row.provider));
    return distinctProviders.size > 1;
  }, [stats.models]);

  const shareKey = shareKeyForSort(sort.key);

  const sortedRows = useMemo(() => {
    const list = [...stats.models];
    if (sort.key === null) {
      return list;
    }
    if (sort.key === "model") {
      list.sort((left, right) => {
        const cmp = left.label.localeCompare(right.label) || left.provider.localeCompare(right.provider);
        return sort.descending ? -cmp : cmp;
      });
      return list;
    }
    const key = sort.key;
    list.sort((left, right) => {
      const a = rowNumericSortValue(left, key);
      const b = rowNumericSortValue(right, key);
      // Missing figures (e.g. unpriced model cost or unmeasured speed) always sink to the bottom.
      if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
      return sort.descending ? b - a : a - b;
    });
    return list;
  }, [stats.models, sort]);

  const shareTotal = useMemo(
    () => sortedRows.reduce((sum, row) => sum + rowShareMetric(row, shareKey), 0),
    [sortedRows, shareKey],
  );

  const totals = useMemo(() => sumModelTotals(stats.models), [stats.models]);
  const derivedTotals = useMemo(() => deriveUsageMetrics(totals), [totals]);

  const columnWidths: Record<Exclude<TableSortKey, "model">, number> = roomyColumns
    ? { requests: 64, input: 68, cached: 68, cache: 62, output: 68, speed: 78, cost: 80 }
    : { requests: 50, input: 54, cached: 54, cache: 50, output: 54, speed: 64, cost: 68 };

  const toggleSort = (key: TableSortKey) => {
    setSort((current) => {
      if (current.key === key) {
        return { key, descending: !current.descending };
      }
      return { key, descending: key !== "model" };
    });
  };

  const formatRowCells = (
    item: UsageTotals & { tps: number | null; cacheHitRate: number | null; priced: "full" | "partial" | "none" },
  ): Record<Exclude<TableSortKey, "model">, string> => ({
    requests: integer(item.requests, locale),
    input: tokens(rowUncachedInput(item)),
    cached: tokens(item.cached),
    cache: item.cacheHitRate === null ? "—" : percent(item.cacheHitRate, locale),
    output: tokens(item.output),
    speed: item.tps === null ? "—" : `${formatTps(item.tps)} tok/s`,
    cost: item.priced === "none" ? "—" : moneyFixed(item.cost, currency, locale),
  });

  const totalsPricedState: "full" | "partial" | "none" =
    totals.pricedRequests === 0
      ? "none"
      : totals.pricedRequests >= totals.requests
        ? "full"
        : "partial";

  const totalCells = formatRowCells({
    ...totals,
    tps: derivedTotals.tps,
    cacheHitRate: derivedTotals.cacheHitRate,
    priced: totalsPricedState,
  });

  const rowFrame = {
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
    borderRadius: radius.md,
  } as const;

  const renderNameCell = (row: UsageModelRow, share: number | null) => (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        alignSelf: "stretch",
        justifyContent: "center",
        marginRight: isCardLayout ? space.sm : space.md,
        paddingVertical: 6,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.xs + 2 }}>
        <Text
          numberOfLines={1}
          style={{ ...font.small, fontWeight: "600", color: colors.foreground, flexShrink: 1 }}
        >
          {row.label}
        </Text>
        <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
          {share === null
            ? "—"
            : share > 0 && share < 0.001
              ? `<${percent(0.001, locale)}`
              : percent(share, locale)}
        </Text>
      </View>
      {showProviderSublabel ? (
        <Text
          numberOfLines={1}
          style={{ fontSize: 11, lineHeight: 14, color: colors.foregroundMuted }}
        >
          {row.provider}
        </Text>
      ) : null}
      {/* Thin share bar below model name; omit <1% slivers since the percentage readout carries them. */}
      <View
        style={{
          marginTop: 4,
          height: 3,
          borderRadius: 1.5,
          backgroundColor: tint(colors.foreground, 0.06),
          overflow: "hidden",
        }}
      >
        {share !== null && share >= 0.01 ? (
          <View
            style={{
              width: `${Math.min(1, share) * 100}%`,
              height: 3,
              borderRadius: 1.5,
              backgroundColor: colors.accent,
            }}
          />
        ) : null}
      </View>
    </View>
  );

  const unpricedModels = useMemo(
    () => stats.models.filter((row) => row.priced === "none"),
    [stats.models],
  );

  const renderCostCell = (row: UsageModelRow, text: string, cellWidth?: number) => {
    const isUnpriced = row.priced === "none";
    const isPartial = row.priced === "partial";
    const costColor = isUnpriced || isPartial ? colors.statusWarning : colors.foreground;
    return (
      <Pressable
        key="cost"
        accessibilityRole="button"
        accessibilityLabel={`${copy.editPricingFor(row.label)}${
          isUnpriced ? ` (${copy.unpricedHint})` : isPartial ? ` (${copy.partialPriceHint})` : ""
        }`}
        hitSlop={6}
        onPress={(event) => {
          event.stopPropagation?.();
          onOpenPricing(row.pricingKey);
        }}
        style={(state) => ({
          width: cellWidth,
          alignItems: "flex-end",
          justifyContent: "center",
          flexShrink: 0,
          opacity: (state as PressState).hovered || (state as PressState).pressed ? 0.7 : 1,
        })}
      >
        {isUnpriced ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              paddingHorizontal: isCardLayout ? space.sm : 6,
              height: isCardLayout ? 24 : 22,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: tint(colors.statusWarning, 0.35),
              backgroundColor: tint(colors.statusWarning, 0.12),
            }}
          >
            <Text
              numberOfLines={1}
              style={{ ...font.caption, fontWeight: "600", color: colors.statusWarning }}
            >
              {isCardLayout ? copy.setPriceCta : copy.setPriceShort}
            </Text>
            {isCardLayout ? (
              <Icon name="ArrowRight" size={11} color={colors.statusWarning} />
            ) : null}
          </View>
        ) : (
          <Text
            numberOfLines={1}
            style={{
              ...font.small,
              ...tabular,
              color: costColor,
              fontWeight: isPartial ? "600" : "500",
            }}
          >
            {text}
          </Text>
        )}
      </Pressable>
    );
  };

  const compactSortOptions: readonly TableSortKey[] = [
    "requests",
    "input",
    "cached",
    "cache",
    "output",
    "speed",
    "cost",
    "model",
  ];

  return (
    <Card colors={colors} style={{ padding: isCardLayout ? space.md : space.lg, gap: space.sm }}>
      <View
        style={{
          flexDirection: isCardLayout ? "column" : "row",
          alignItems: isCardLayout ? "flex-start" : "baseline",
          gap: isCardLayout ? 2 : space.sm,
          marginBottom: space.xs,
        }}
      >
        <Text style={{ ...font.heading, color: colors.foreground, flex: isCardLayout ? undefined : 1 }}>
          {copy.modelsTitle}
        </Text>
        <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{copy.modelsHint}</Text>
      </View>

      {unpricedModels.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.editPricingFor(unpricedModels[0]!.label)}
          onPress={() => onOpenPricing(unpricedModels[0]!.pricingKey)}
          style={(state) => ({
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
            paddingHorizontal: space.sm + 2,
            paddingVertical: space.xs + 2,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: tint(colors.statusWarning, 0.25),
            backgroundColor: tint(colors.statusWarning, 0.08),
            opacity: (state as PressState).pressed || (state as PressState).hovered ? 0.78 : 1,
          })}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, flex: 1, minWidth: 0 }}>
            <Icon name="DollarSign" size={13} color={colors.statusWarning} />
            <Text
              numberOfLines={1}
              style={{ ...font.caption, color: colors.foreground, flexShrink: 1 }}
            >
              {copy.unpricedBanner(unpricedModels.length)}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <Text style={{ ...font.caption, fontWeight: "600", color: colors.statusWarning }}>
              {copy.configureNow}
            </Text>
            <Icon name="ArrowRight" size={11} color={colors.statusWarning} />
          </View>
        </Pressable>
      ) : null}

      {isCardLayout ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2 }}>
          <Text style={{ ...font.caption, color: colors.foregroundMuted, flexShrink: 0 }}>
            {copy.sortLabel}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flex: 1 }}
            contentContainerStyle={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs,
              paddingRight: space.xs,
            }}
          >
            {compactSortOptions.map((key) => {
              const active = sort.key === key;
              return (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  accessibilityLabel={copy.sortBy(copy.col[key])}
                  accessibilityState={{ selected: active }}
                  onPress={() => toggleSort(key)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 2,
                    paddingHorizontal: space.sm,
                    height: 24,
                    borderRadius: radius.pill,
                    borderWidth: 1,
                    borderColor: active ? tint(colors.accent, 0.35) : colors.border,
                    backgroundColor: active ? tint(colors.accent, 0.14) : colors.surface0,
                  }}
                >
                  <Text
                    style={{
                      ...font.caption,
                      fontWeight: active ? "600" : "400",
                      color: active ? colors.accent : colors.foregroundMuted,
                    }}
                  >
                    {copy.col[key]}
                  </Text>
                  {active ? (
                    <Icon
                      name={sort.descending ? "ArrowDown" : "ArrowUp"}
                      size={10}
                      color={colors.accent}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : (
        <View
          style={{
            ...rowFrame,
            flexDirection: "row",
            alignItems: "flex-end",
            paddingBottom: space.sm,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            borderRadius: 0,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.sortBy(copy.col.model)}
            accessibilityState={{ selected: sort.key === "model" }}
            onPress={() => toggleSort("model")}
            style={(state) => ({
              flex: 1,
              minWidth: 0,
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              opacity: (state as PressState).hovered && sort.key !== "model" ? 0.75 : 1,
            })}
          >
            <Text
              numberOfLines={1}
              style={{
                ...font.caption,
                color: sort.key === "model" ? colors.foreground : colors.foregroundMuted,
                fontWeight: sort.key === "model" ? "600" : "400",
              }}
            >
              {copy.col.model}
            </Text>
            {sort.key === "model" ? (
              <Icon
                name={sort.descending ? "ArrowDown" : "ArrowUp"}
                size={11}
                color={colors.foreground}
              />
            ) : null}
          </Pressable>

          {NUMERIC_COLUMNS.map((key) => {
            const active = sort.key === key;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityLabel={copy.sortBy(copy.col[key])}
                accessibilityState={{ selected: active }}
                onPress={() => toggleSort(key)}
                style={(state) => ({
                  width: columnWidths[key],
                  flexDirection: "row",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  gap: 2,
                  opacity: (state as PressState).hovered && !active ? 0.75 : 1,
                })}
              >
                {active ? (
                  <Icon
                    name={sort.descending ? "ArrowDown" : "ArrowUp"}
                    size={11}
                    color={colors.foreground}
                  />
                ) : null}
                <Text
                  numberOfLines={1}
                  style={{
                    ...font.caption,
                    color: active ? colors.foreground : colors.foregroundMuted,
                    fontWeight: active ? "600" : "400",
                  }}
                >
                  {copy.col[key]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <View>
        {sortedRows.map((row, index) => {
          const share =
            shareKey === "cost" && row.priced === "none"
              ? null
              : shareTotal > 0
                ? rowShareMetric(row, shareKey) / shareTotal
                : 0;
          const active = selectedModelId === row.id;
          const dimmed = selectedModelId !== null && !active;
          const cells = formatRowCells(row);

          return (
            <Pressable
              key={row.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onToggleModel(row)}
              style={(state) => ({
                ...rowFrame,
                minHeight: isCardLayout ? undefined : 46,
                paddingVertical: isCardLayout ? space.sm : 0,
                flexDirection: isCardLayout ? "column" : "row",
                alignItems: isCardLayout ? "stretch" : "center",
                gap: isCardLayout ? space.xs : 0,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: tint(colors.foreground, 0.06),
                opacity: dimmed ? 0.5 : 1,
                backgroundColor: active
                  ? tint(colors.accent, 0.08)
                  : (state as PressState).hovered
                    ? tint(colors.foreground, 0.04)
                    : "transparent",
              })}
            >
              {isCardLayout ? (
                <>
                  {/* Compact 2-row card on narrow screens (<560px). */}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                    {renderNameCell(row, share)}
                    {renderCostCell(row, cells.cost)}
                  </View>
                  <Text
                    style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}
                  >
                    {[
                      `${copy.col.requests} ${cells.requests}`,
                      `${copy.col.input} ${cells.input}`,
                      `${copy.col.cached} ${cells.cached} (${cells.cache})`,
                      `${copy.col.output} ${cells.output}`,
                      cells.speed !== "—" ? cells.speed : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </>
              ) : (
                <>
                  {renderNameCell(row, share)}
                  {NUMERIC_COLUMNS.map((key) =>
                    key === "cost" ? (
                      renderCostCell(row, cells.cost, columnWidths.cost)
                    ) : (
                      <Text
                        key={key}
                        numberOfLines={1}
                        style={{
                          ...font.small,
                          ...tabular,
                          color: colors.foreground,
                          width: columnWidths[key],
                          textAlign: "right",
                        }}
                      >
                        {cells[key]}
                      </Text>
                    ),
                  )}
                </>
              )}
            </Pressable>
          );
        })}

        {/* Totals summary row */}
        {sortedRows.length > 0 ? (
          <View
            style={{
              ...rowFrame,
              flexDirection: isCardLayout ? "column" : "row",
              alignItems: isCardLayout ? "stretch" : "center",
              minHeight: isCardLayout ? undefined : 44,
              paddingVertical: isCardLayout ? space.sm : 0,
              gap: isCardLayout ? space.xs : 0,
              borderTopWidth: 1,
              borderTopColor: colors.border,
              borderRadius: 0,
            }}
          >
            {isCardLayout ? (
              <>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                  <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>
                    {copy.totalRow}
                  </Text>
                  <Text
                    style={{
                      ...font.small,
                      ...tabular,
                      fontWeight: "600",
                      color: totalsPricedState === "none" ? colors.statusWarning : colors.foreground,
                    }}
                  >
                    {totalCells.cost}
                  </Text>
                </View>
                <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                  {[
                    `${copy.col.requests} ${totalCells.requests}`,
                    `${copy.col.input} ${totalCells.input}`,
                    `${copy.col.cached} ${totalCells.cached} (${totalCells.cache})`,
                    `${copy.col.output} ${totalCells.output}`,
                    totalCells.speed !== "—" ? totalCells.speed : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </>
            ) : (
              <>
                <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground, flex: 1 }}>
                  {copy.totalRow}
                </Text>
                {NUMERIC_COLUMNS.map((key) => (
                  <Text
                    key={key}
                    numberOfLines={1}
                    style={{
                      ...font.small,
                      ...tabular,
                      fontWeight: "600",
                      color:
                        key === "cost" && totalsPricedState === "none"
                          ? colors.statusWarning
                          : colors.foreground,
                      width: columnWidths[key],
                      textAlign: "right",
                    }}
                  >
                    {totalCells[key]}
                  </Text>
                ))}
              </>
            )}
          </View>
        ) : null}
      </View>
    </Card>
  );
}

export interface ConsoleUsageTabProps {
  client: PluginClientContext;
  colors: Colors;
  capabilities?: CapabilitiesSnapshot;
  displayCurrency?: Currency;
  pricingRevision?: number; // bumped when PricingDialog updates rates/currency
  onCurrencyChange?: (currency: Currency) => void;
  onOpenPricing?: (focusModel?: string | null) => void;
}

export function ConsoleUsageTab({
  client,
  colors,
  capabilities,
  displayCurrency,
  pricingRevision = 0,
  onCurrencyChange,
  onOpenPricing,
}: ConsoleUsageTabProps) {
  const locale = useCurrentLocale();
  const copy = locale === "zh-CN" ? COPY_ZH : COPY_EN;
  const windowDims = useWindowDimensions();

  const dshVisible = capabilities ? capabilities.dshVisible : true;
  const antigravityVisible = capabilities ? capabilities.antigravityVisible : false;
  const bothVisible = dshVisible && antigravityVisible;

  const [measuredWidth, setMeasuredWidth] = useState(0);
  const [selectedSource, setSelectedSource] = useState<UsageSource>("all");
  const [range, setRange] = useState<UsageRange>("today");
  const [scope, setScope] = useState<UsageScope>("all");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<SelectedModelFilter | null>(null);
  const [metric, setMetric] = useState<ChartMetric>("tokens");

  const effectiveSource: UsageSource = bothVisible
    ? selectedSource
    : antigravityVisible && !dshVisible
      ? "antigravity"
      : "dsh";

  // Reset source-specific filters when effective source changes (e.g. switcher tap or capability resolution).
  const prevSourceRef = useRef<UsageSource>(effectiveSource);
  useEffect(() => {
    if (prevSourceRef.current !== effectiveSource) {
      prevSourceRef.current = effectiveSource;
      setSelectedProvider(null);
      setSelectedAccount(null);
      setSelectedModel(null);
    }
  }, [effectiveSource]);

  // Local currency override lets the toggle respond immediately and survive a failed pricingUpdateRpc.
  const [localCurrency, setLocalCurrency] = useState<Currency | undefined>(displayCurrency);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [stats, setStats] = useState<UsageStats | null>(null);
  const [daily, setDaily] = useState<UsageDaily | null>(null);
  const [statsTransitioning, setStatsTransitioning] = useState(false);
  const [dailyTransitioning, setDailyTransitioning] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [dailyError, setDailyError] = useState<string | null>(null);

  const statsSeqRef = useRef(0);
  const dailySeqRef = useRef(0);
  const hasStatsRef = useRef(false);
  const hasDailyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Sync external currency updates (e.g. from Settings tab or PricingDialog).
  useEffect(() => {
    if (displayCurrency !== undefined) {
      setLocalCurrency(displayCurrency);
    }
  }, [displayCurrency]);

  // When PricingDialog updates rates/currency, clear stale local override unless parent controls it.
  const prevRevisionRef = useRef(pricingRevision);
  useEffect(() => {
    if (prevRevisionRef.current !== pricingRevision) {
      prevRevisionRef.current = pricingRevision;
      setLocalCurrency(displayCurrency);
    }
  }, [pricingRevision, displayCurrency]);

  const requestedCurrency = localCurrency ?? displayCurrency;
  const effectiveCurrency: Currency =
    requestedCurrency ?? stats?.displayCurrency ?? daily?.displayCurrency ?? "USD";

  const activeProviderFilter = effectiveSource === "dsh" ? selectedProvider : null;
  const activeAccountFilter = effectiveSource === "antigravity" ? selectedAccount : null;

  const isTransientTransportError = (error: unknown): boolean => {
    const msg = error instanceof Error ? error.message : String(error ?? "");
    return /stream end encountered|socket|connection closed|not connected|network|timed?\s*out|aborted|econn|eof/i.test(
      msg,
    );
  };

  const fetchStats = useCallback(
    async (silent: boolean): Promise<UsageStats | null> => {
      const seq = ++statsSeqRef.current;
      if (!silent) setStatsTransitioning(true);
      const callOnce = () =>
        client.rpc(usageStatsRpc, {
          range,
          scope,
          source: effectiveSource,
          ...(activeProviderFilter ? { provider: activeProviderFilter } : {}),
          ...(activeAccountFilter ? { account: activeAccountFilter } : {}),
          ...(selectedModel ? { model: selectedModel.id } : {}),
          ...(requestedCurrency ? { currency: requestedCurrency } : {}),
        });
      try {
        let result: UsageStats;
        try {
          result = await callOnce();
        } catch (firstError) {
          // Paseo iOS relay sockets briefly raise "Stream end encountered" on wake/reconnect;
          // retry once automatically before surfacing a red error banner.
          if (!isTransientTransportError(firstError)) throw firstError;
          await new Promise((resolve) => setTimeout(resolve, 650));
          if (!mountedRef.current || seq !== statsSeqRef.current) return null;
          result = await callOnce();
        }
        if (!mountedRef.current || seq !== statsSeqRef.current) return null;
        hasStatsRef.current = true;
        setStats(result);
        setStatsError(null);
        return result;
      } catch (error) {
        if (!mountedRef.current || seq !== statsSeqRef.current) return null;
        if (silent && hasStatsRef.current && isTransientTransportError(error)) {
          return null;
        }
        setStatsError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        if (mountedRef.current && seq === statsSeqRef.current) {
          setStatsTransitioning(false);
        }
      }
    },
    [client, range, scope, effectiveSource, activeProviderFilter, activeAccountFilter, selectedModel, requestedCurrency],
  );

  const fetchDaily = useCallback(
    async (silent: boolean): Promise<UsageDaily | null> => {
      const seq = ++dailySeqRef.current;
      if (!silent) setDailyTransitioning(true);
      const callOnce = () =>
        client.rpc(usageDailyRpc, {
          scope,
          source: effectiveSource,
          ...(activeProviderFilter ? { provider: activeProviderFilter } : {}),
          ...(activeAccountFilter ? { account: activeAccountFilter } : {}),
          ...(selectedModel ? { model: selectedModel.id } : {}),
          ...(requestedCurrency ? { currency: requestedCurrency } : {}),
        });
      try {
        let result: UsageDaily;
        try {
          result = await callOnce();
        } catch (firstError) {
          if (!isTransientTransportError(firstError)) throw firstError;
          await new Promise((resolve) => setTimeout(resolve, 650));
          if (!mountedRef.current || seq !== dailySeqRef.current) return null;
          result = await callOnce();
        }
        if (!mountedRef.current || seq !== dailySeqRef.current) return null;
        hasDailyRef.current = true;
        setDaily(result);
        setDailyError(null);
        return result;
      } catch (error) {
        if (!mountedRef.current || seq !== dailySeqRef.current) return null;
        if (silent && hasDailyRef.current && isTransientTransportError(error)) {
          return null;
        }
        setDailyError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        if (mountedRef.current && seq === dailySeqRef.current) {
          setDailyTransitioning(false);
        }
      }
    },
    [client, scope, effectiveSource, activeProviderFilter, activeAccountFilter, selectedModel, requestedCurrency],
  );

  const handleManualRefresh = useCallback(() => {
    setManualRefreshing(true);
    void Promise.all([fetchStats(false), fetchDaily(false)]).finally(() => {
      if (mountedRef.current) setManualRefreshing(false);
    });
  }, [fetchStats, fetchDaily]);

  // Trigger stats fetch on filter/range/currency/pricing changes (retains previous data at opacity 0.6).
  useEffect(() => {
    void fetchStats(false);
  }, [fetchStats, pricingRevision, refreshNonce]);

  // Trigger daily heatmap fetch on scope/provider/model/currency/pricing changes.
  useEffect(() => {
    void fetchDaily(false);
  }, [fetchDaily, pricingRevision, refreshNonce]);

  // Smooth non-overlapping polling while cold indexing is active, then gentle 60s refresh.
  const indexing = activeIndexingOf(stats, daily);
  const isIndexingActive = Boolean(indexing?.active);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(
        () => {
          void Promise.all([fetchStats(true), fetchDaily(true)]).then(() => {
            schedule();
          });
        },
        isIndexingActive ? INDEXING_POLL_MS : BACKGROUND_REFRESH_MS,
      );
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [isIndexingActive, fetchStats, fetchDaily]);

  const handleCurrencyToggle = useCallback(
    (next: Currency) => {
      if (next === effectiveCurrency) return;
      setLocalCurrency(next);
      onCurrencyChange?.(next);
      void client.rpc(pricingUpdateRpc, { displayCurrency: next }).catch(() => {
        // Keep local override active gracefully if pricing persistence fails.
      });
    },
    [client, effectiveCurrency, onCurrencyChange],
  );

  const handleToggleModel = useCallback((row: UsageModelRow) => {
    setSelectedModel((current) =>
      current?.id === row.id
        ? null
        : { id: row.id, label: row.label, provider: row.provider },
    );
  }, []);

  const clearAllFilters = useCallback(() => {
    setScope("all");
    setSelectedProvider(null);
    setSelectedAccount(null);
    setSelectedModel(null);
  }, []);

  const width =
    measuredWidth > 0
      ? measuredWidth
      : Math.max(300, Math.min(windowDims.width - space.lg * 2, 960));
  const isNarrow = width < NARROW_BREAKPOINT;
  const tileGap = isNarrow ? space.sm : space.md;
  const tileColumns = isNarrow ? 2 : 3;
  const tileWidth: number | "100%" =
    width >= 240
      ? Math.max(1, Math.floor((width - tileGap * (tileColumns - 1)) / tileColumns))
      : "100%";

  const totals = useMemo(() => (stats ? deriveUsageMetrics(stats.totals) : null), [stats]);
  const hasSubagents = Boolean(stats?.hasSubagents);
  const showScopeControl = hasSubagents || scope !== "all";
  const providerRows = effectiveSource === "dsh" ? (stats?.providers ?? []) : [];
  const accountRows: readonly UsageAccountRow[] =
    effectiveSource === "antigravity" ? (stats?.accounts ?? []) : [];
  const showProviderChips =
    effectiveSource === "dsh" && (providerRows.length > 1 || selectedProvider !== null);
  const showAccountChips =
    effectiveSource === "antigravity" && (accountRows.length > 1 || selectedAccount !== null);
  const showFilterRow = showProviderChips || showAccountChips || selectedModel !== null;
  const unpricedCount = stats ? Math.max(0, stats.totals.requests - stats.totals.pricedRequests) : 0;
  const hasActiveFilter =
    scope !== "all" ||
    activeProviderFilter !== null ||
    activeAccountFilter !== null ||
    selectedModel !== null;

  const indexingFraction =
    indexing && indexing.total > 0 ? Math.min(1, indexing.done / indexing.total) : 0;

  const tileProps = (key: ChartMetric) => ({
    colors,
    width: tileWidth,
    compact: isNarrow,
    label: copy.metric[key],
    selected: metric === key,
    onPress: () => setMetric(key),
  });

  const costFoot = useMemo(() => {
    if (!stats || !totals) return " ";
    if (stats.totals.requests === 0) return " ";
    if (stats.totals.pricedRequests === 0) return copy.costUnpricedAll;
    const avg = totals.costPerRequest !== null ? money(totals.costPerRequest, effectiveCurrency, locale) : "—";
    if (unpricedCount > 0) {
      return copy.costPartial(
        integer(stats.totals.pricedRequests, locale),
        integer(stats.totals.requests, locale),
        avg,
      );
    }
    return stats.hasCustomPricing ? copy.costAvgCustom(avg) : copy.costAvg(avg);
  }, [stats, totals, copy, effectiveCurrency, locale, unpricedCount]);

  const requestsFoot = useMemo(() => {
    if (!stats) return " ";
    if (
      hasSubagents &&
      scope === "all" &&
      !selectedModel &&
      stats.breakdown.subagent.requests > 0
    ) {
      return copy.splitSummary(
        integer(stats.breakdown.main.requests, locale),
        integer(stats.breakdown.subagent.requests, locale),
      );
    }
    return copy.sessionsCount(stats.sessions, integer(stats.sessions, locale));
  }, [stats, hasSubagents, scope, selectedModel, copy, locale]);

  const currencySym = currencySymbol(effectiveCurrency);

  const sourceControl = bothVisible ? (
    <SegmentedControl<UsageSource>
      colors={colors}
      value={selectedSource}
      size="sm"
      options={[
        { value: "all", label: copy.sourceAll },
        { value: "dsh", label: copy.sourceDsh },
        {
          value: "antigravity",
          label: isNarrow ? copy.sourceAntigravityShort : copy.sourceAntigravity,
        },
      ]}
      onChange={(next) => {
        setSelectedSource(next);
        setSelectedProvider(null);
        setSelectedAccount(null);
        setSelectedModel(null);
      }}
    />
  ) : null;

  const scopeControl = (
    <SegmentedControl<UsageScope>
      colors={colors}
      value={scope}
      size="sm"
      options={[
        { value: "all", label: copy.scopeAll },
        { value: "main", label: copy.scopeMain },
        { value: "subagent", label: copy.scopeSubagent },
      ]}
      onChange={(next) => {
        setScope(next);
        setSelectedModel(null);
      }}
    />
  );

  const compactTopControls = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.refreshButton}
        disabled={manualRefreshing}
        hitSlop={4}
        onPress={handleManualRefresh}
        style={(state) => {
          const active =
            !manualRefreshing &&
            ((state as PressState).pressed || Boolean((state as PressState).hovered));
          return {
            width: 30,
            height: 30,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: active ? tint(colors.foreground, 0.06) : colors.surface1,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            opacity: manualRefreshing ? 0.65 : 1,
          };
        }}
      >
        {manualRefreshing ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Icon name="RefreshCw" size={14} color={colors.foreground} />
        )}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.switchCurrencyLabel(effectiveCurrency, currencySym)}
        hitSlop={4}
        onPress={() => handleCurrencyToggle(effectiveCurrency === "USD" ? "CNY" : "USD")}
        style={(state) => {
          const active =
            (state as PressState).pressed || Boolean((state as PressState).hovered);
          return {
            height: 30,
            paddingHorizontal: space.sm + 2,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: active ? tint(colors.foreground, 0.06) : colors.surface1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 5,
            flexShrink: 0,
          };
        }}
      >
        <Text
          numberOfLines={1}
          style={{ ...font.small, ...tabular, fontWeight: "600", color: colors.accent }}
        >
          {currencySym}
        </Text>
        <Text
          numberOfLines={1}
          style={{ ...font.small, ...tabular, fontWeight: "600", color: colors.foreground }}
        >
          {effectiveCurrency}
        </Text>
        <Icon name="ArrowLeftRight" size={12} color={colors.foregroundMuted} />
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.pricingButton}
        hitSlop={4}
        onPress={() => onOpenPricing?.(null)}
        style={(state) => {
          const active =
            (state as PressState).pressed || Boolean((state as PressState).hovered);
          return {
            width: 30,
            height: 30,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: active ? tint(colors.foreground, 0.06) : colors.surface1,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          };
        }}
      >
        <Icon name="Coins" size={15} color={colors.foreground} />
      </Pressable>
    </>
  );

  const providerScrollView = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs + 2,
        paddingRight: space.xs,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: selectedProvider === null }}
        onPress={() => {
          setSelectedProvider(null);
          setSelectedModel(null);
        }}
        style={(state) => ({
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.sm + 2,
          height: 28,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor:
            selectedProvider === null ? tint(colors.accent, 0.35) : colors.border,
          backgroundColor:
            selectedProvider === null
              ? tint(colors.accent, 0.14)
              : colors.surface1,
          opacity: (state as PressState).pressed ? 0.75 : 1,
        })}
      >
        <Text
          numberOfLines={1}
          style={{
            ...font.caption,
            fontWeight: selectedProvider === null ? "600" : "500",
            color: selectedProvider === null ? colors.accent : colors.foregroundMuted,
          }}
        >
          {copy.allProviders}
        </Text>
      </Pressable>

      {providerRows.map((row) => {
        const active = selectedProvider === row.provider;
        const costText =
          row.pricedRequests > 0
            ? ` · ${money(row.cost, effectiveCurrency, locale)}`
            : "";
        return (
          <Pressable
            key={row.provider}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => {
              setSelectedProvider(active ? null : row.provider);
              setSelectedModel(null);
            }}
            style={(state) => ({
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: space.sm + 2,
              height: 28,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: active ? tint(colors.accent, 0.35) : colors.border,
              backgroundColor: active ? tint(colors.accent, 0.14) : colors.surface1,
              opacity: (state as PressState).pressed ? 0.75 : 1,
            })}
          >
            <Text
              numberOfLines={1}
              style={{
                ...font.caption,
                ...tabular,
                fontWeight: active ? "600" : "500",
                color: active ? colors.accent : colors.foregroundMuted,
              }}
            >
              {`${row.provider} · ${integer(row.requests, locale)}${costText}`}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  const singleProviderChip =
    providerRows.length <= 1 && selectedProvider !== null ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${copy.clearFilter}: ${selectedProvider}`}
        onPress={() => {
          setSelectedProvider(null);
          setSelectedModel(null);
        }}
        style={(state) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: space.sm + 2,
          height: 28,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: tint(colors.accent, 0.35),
          backgroundColor: tint(colors.accent, 0.14),
          opacity: (state as PressState).pressed ? 0.75 : 1,
        })}
      >
        <Text numberOfLines={1} style={{ ...font.caption, fontWeight: "600", color: colors.accent }}>
          {selectedProvider}
        </Text>
        <Icon name="X" size={12} color={colors.accent} />
      </Pressable>
    ) : null;

  const selectedAccountLabel = useMemo(() => {
    if (!selectedAccount) return null;
    return accountRows.find((row) => row.id === selectedAccount)?.label ?? selectedAccount;
  }, [accountRows, selectedAccount]);

  const accountScrollView = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs + 2,
        paddingRight: space.xs,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: selectedAccount === null }}
        onPress={() => {
          setSelectedAccount(null);
          setSelectedModel(null);
        }}
        style={(state) => ({
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.sm + 2,
          height: 28,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor:
            selectedAccount === null ? tint(colors.accent, 0.35) : colors.border,
          backgroundColor:
            selectedAccount === null
              ? tint(colors.accent, 0.14)
              : colors.surface1,
          opacity: (state as PressState).pressed ? 0.75 : 1,
        })}
      >
        <Text
          numberOfLines={1}
          style={{
            ...font.caption,
            fontWeight: selectedAccount === null ? "600" : "500",
            color: selectedAccount === null ? colors.accent : colors.foregroundMuted,
          }}
        >
          {copy.allAccounts}
        </Text>
      </Pressable>

      {accountRows.map((row) => {
        const active = selectedAccount === row.id;
        const costText =
          row.pricedRequests > 0
            ? ` · ${money(row.cost, effectiveCurrency, locale)}`
            : "";
        return (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => {
              setSelectedAccount(active ? null : row.id);
              setSelectedModel(null);
            }}
            style={(state) => ({
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: space.sm + 2,
              height: 28,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: active ? tint(colors.accent, 0.35) : colors.border,
              backgroundColor: active ? tint(colors.accent, 0.14) : colors.surface1,
              opacity: (state as PressState).pressed ? 0.75 : 1,
            })}
          >
            <Text
              numberOfLines={1}
              style={{
                ...font.caption,
                ...tabular,
                fontWeight: active ? "600" : "500",
                color: active ? colors.accent : colors.foregroundMuted,
              }}
            >
              {`${row.label} · ${integer(row.requests, locale)}${costText}`}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  const singleAccountChip =
    effectiveSource === "antigravity" && accountRows.length <= 1 && selectedAccount !== null ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${copy.clearFilter}: ${selectedAccountLabel ?? selectedAccount}`}
        onPress={() => {
          setSelectedAccount(null);
          setSelectedModel(null);
        }}
        style={(state) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: space.sm + 2,
          height: 28,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: tint(colors.accent, 0.35),
          backgroundColor: tint(colors.accent, 0.14),
          opacity: (state as PressState).pressed ? 0.75 : 1,
        })}
      >
        <Text numberOfLines={1} style={{ ...font.caption, fontWeight: "600", color: colors.accent }}>
          {selectedAccountLabel ?? selectedAccount}
        </Text>
        <Icon name="X" size={12} color={colors.accent} />
      </Pressable>
    ) : null;

  const activeModelChip = selectedModel ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${copy.clearFilter}: ${selectedModel.label}`}
      onPress={() => setSelectedModel(null)}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: space.sm + 2,
        height: 28,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: tint(colors.accent, 0.35),
        backgroundColor: tint(colors.accent, 0.14),
        opacity: (state as PressState).pressed ? 0.75 : 1,
      })}
    >
      <Text numberOfLines={1} style={{ ...font.caption, fontWeight: "600", color: colors.accent }}>
        {copy.filterModel(
          (effectiveSource === "all" || (providerRows.length > 1 && selectedProvider === null)) &&
            selectedModel.provider
            ? `${selectedModel.label} (${selectedModel.provider})`
            : selectedModel.label,
        )}
      </Text>
      <Icon name="X" size={12} color={colors.accent} />
    </Pressable>
  ) : null;

  return (
    <View
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setMeasuredWidth((prev) => (Math.abs(prev - next) <= 1 ? prev : next));
      }}
      style={{ gap: space.md, width: "100%" }}
    >
      {/* Top control bar */}
      {isNarrow ? (
        <View style={{ gap: space.sm }}>
          {/* Row 1: Title + Refresh + Currency + Pricing */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.sm,
            }}
          >
            <Text
              numberOfLines={1}
              style={{ ...font.heading, color: colors.foreground, flexShrink: 1 }}
            >
              {copy.title}
            </Text>

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.xs + 2,
                flexShrink: 0,
              }}
            >
              {compactTopControls}
            </View>
          </View>

          {/* Row 2: Compact inline Source (left) & Scope (right) on one clean row */}
          {sourceControl || showScopeControl ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: sourceControl && showScopeControl ? "space-between" : "flex-start",
                gap: space.sm,
              }}
            >
              {sourceControl}
              {showScopeControl ? scopeControl : null}
            </View>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: space.sm }}>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.sm,
            }}
          >
            <Text
              numberOfLines={1}
              style={{ ...font.heading, color: colors.foreground, flexShrink: 0 }}
            >
              {copy.title}
            </Text>

            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: space.sm,
                flexShrink: 1,
                minWidth: 0,
              }}
            >
              {sourceControl}
              {showScopeControl ? scopeControl : null}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.xs + 2,
                  flexShrink: 0,
                }}
              >
                {compactTopControls}
              </View>
            </View>
          </View>
        </View>
      )}

      {/* Cold-indexing progress bar */}
      {isIndexingActive && indexing ? (
        <View
          style={{
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: tint(colors.accent, 0.25),
            backgroundColor: tint(colors.accent, 0.06),
            gap: space.xs + 2,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text
              numberOfLines={1}
              style={{ ...font.caption, ...tabular, color: colors.foreground, flex: 1 }}
            >
              {indexing.total > 0
                ? copy.indexingProgress(
                    integer(indexing.done, locale),
                    integer(indexing.total, locale),
                  )
                : copy.indexingScanning}
            </Text>
            {indexing.total > 0 ? (
              <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                {percent(indexingFraction, locale)}
              </Text>
            ) : null}
          </View>
          <Bar
            colors={colors}
            fraction={indexing.total > 0 ? indexingFraction : 0.12}
            tone="accent"
            height={4}
          />
        </View>
      ) : null}

      {/* Adaptive filter chips: DSH providers, Antigravity Google accounts, + active model chip */}
      {showFilterRow ? (
        <View style={{ gap: space.xs + 2 }}>
          {effectiveSource === "dsh" && providerRows.length > 1 ? providerScrollView : null}
          {effectiveSource === "antigravity" && accountRows.length > 1 ? accountScrollView : null}

          {singleProviderChip || singleAccountChip || activeModelChip ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: space.xs + 2,
              }}
            >
              {effectiveSource === "dsh" ? singleProviderChip : null}
              {effectiveSource === "antigravity" ? singleAccountChip : null}
              {activeModelChip}
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Initial error callout when no stats snapshot exists yet */}
      {statsError && !stats ? (
        <Callout
          colors={colors}
          tone="danger"
          title={copy.loadErrorTitle}
          action={
            <Button
              colors={colors}
              size="sm"
              variant="secondary"
              icon="RefreshCw"
              label={copy.retry}
              onPress={() => setRefreshNonce((value) => value + 1)}
            />
          }
        >
          <Muted colors={colors}>{statsError}</Muted>
        </Callout>
      ) : null}

      {/* 53-week activity heatmap */}
      <ConsoleHeatmap
        data={daily}
        currency={effectiveCurrency}
        locale={locale}
        colors={colors}
        width={width}
        dimmed={dailyTransitioning && daily !== null}
        error={dailyError}
      />

      {/* Range switcher row (scopes KPIs, chart, and model table below) */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: width < 310 ? "wrap" : "nowrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
          marginTop: space.xs,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            ...(isNarrow ? font.caption : font.small),
            ...tabular,
            color: colors.foregroundMuted,
            flex: 1,
            minWidth: 0,
          }}
        >
          {stats ? windowLabel(stats, locale, copy) : ""}
        </Text>
        <SegmentedControl<UsageRange>
          colors={colors}
          value={range}
          size="sm"
          options={[
            { value: "today", label: copy.rangeToday },
            { value: "7d", label: copy.range7d },
            { value: "30d", label: copy.range30d },
          ]}
          onChange={setRange}
        />
      </View>

      {statsError && stats ? (
        <Text style={{ ...font.caption, color: colors.statusDanger }}>{statsError}</Text>
      ) : null}

      {/* KPI tiles + interactive chart + sortable model breakdown (dimmed during transitions, zero flash) */}
      <View style={{ gap: space.md, opacity: statsTransitioning && stats !== null ? 0.6 : 1 }}>
        <View
          accessibilityRole="tablist"
          style={{ flexDirection: "row", flexWrap: "wrap", gap: tileGap }}
        >
          {/* 1. Tokens */}
          <StatTile
            {...tileProps("tokens")}
            value={totals ? tokens(totals.totalTokens) : "—"}
            foot={
              totals && stats
                ? copy.tokensSplit(tokens(totals.promptTokens), tokens(stats.totals.output))
                : " "
            }
          >
            <MiniColumns colors={colors} values={stats?.sparklines.tokens ?? []} />
          </StatTile>

          {/* 2. Estimated Cost */}
          <StatTile
            {...tileProps("cost")}
            value={
              totals?.cost !== null && totals?.cost !== undefined
                ? money(totals.cost, effectiveCurrency, locale)
                : "—"
            }
            foot={costFoot}
          >
            <MiniColumns colors={colors} values={stats?.sparklines.cost ?? []} />
          </StatTile>

          {/* 3. Requests */}
          <StatTile
            {...tileProps("requests")}
            value={totals ? integer(totals.requests, locale) : "—"}
            foot={requestsFoot}
          >
            <MiniColumns colors={colors} values={stats?.sparklines.requests ?? []} />
          </StatTile>

          {/* 4. Output Speed */}
          <StatTile
            {...tileProps("tps")}
            value={formatTps(totals?.tps ?? null)}
            unit="tok/s"
            foot={
              totals?.avgOutputTokens !== null && totals?.avgOutputTokens !== undefined
                ? copy.avgOutput(tokens(Math.round(totals.avgOutputTokens)))
                : " "
            }
          >
            <MiniColumns colors={colors} values={stats?.sparklines.tps ?? []} />
          </StatTile>

          {/* 5. Cache Hit Rate (Bar progress bar + embedded sparkline) */}
          <StatTile
            {...tileProps("cache")}
            value={
              totals?.cacheHitRate !== null && totals?.cacheHitRate !== undefined
                ? percent(totals.cacheHitRate, locale)
                : "—"
            }
            foot={stats ? copy.cachedTokens(tokens(stats.totals.cached)) : " "}
          >
            <View style={{ gap: 4 }}>
              <Bar
                colors={colors}
                fraction={totals?.cacheHitRate ?? 0}
                tone={totals?.cacheHitRate === null ? "neutral" : "accent"}
                height={5}
              />
              <MiniColumns
                colors={colors}
                values={stats?.sparklines.cacheHitRate ?? []}
                height={18}
              />
            </View>
          </StatTile>

          {/* 6. First Token Latency / TTFT */}
          <StatTile
            {...tileProps("firstToken")}
            value={formatSecondsValue(totals?.firstTokenSec ?? null)}
            unit="s"
            foot={
              totals?.avgContextTokens !== null && totals?.avgContextTokens !== undefined
                ? copy.avgContext(tokens(Math.round(totals.avgContextTokens)))
                : " "
            }
          >
            <MiniColumns colors={colors} values={stats?.sparklines.firstTokenSec ?? []} />
          </StatTile>
        </View>

        {stats && stats.totals.requests === 0 ? (
          <Card colors={colors} style={{ padding: space.xl, alignItems: "center", gap: space.sm }}>
            <Muted colors={colors}>{hasActiveFilter ? copy.emptyFiltered : copy.emptyRange}</Muted>
            {hasActiveFilter ? (
              <Button
                colors={colors}
                size="sm"
                variant="secondary"
                label={copy.clearFilters}
                onPress={clearAllFilters}
              />
            ) : null}
          </Card>
        ) : null}

        {stats && stats.totals.requests > 0 ? (
          <>
            <MetricChart
              colors={colors}
              stats={stats}
              metric={metric}
              currency={effectiveCurrency}
              locale={locale}
              compact={isNarrow}
              copy={copy}
            />

            {stats.models.length > 0 ? (
              <ModelTable
                colors={colors}
                stats={stats}
                currency={effectiveCurrency}
                locale={locale}
                width={width}
                selectedModelId={selectedModel?.id ?? null}
                onToggleModel={handleToggleModel}
                onOpenPricing={(pricingKey) => onOpenPricing?.(pricingKey)}
                copy={copy}
              />
            ) : null}
          </>
        ) : null}
      </View>
    </View>
  );
}
