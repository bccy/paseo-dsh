/**
 * Shared dual-currency model pricing & exchange-rate dialog for the DSH console
 * (used by both Tab 1 Usage and Tab 3 Settings).
 *
 * Loads live `PricingState` via `dsh.pricing.get`, updates display currency,
 * `USD -> CNY` exchange rate, auto-sync preference, and per-model overrides via
 * `dsh.pricing.update`, syncs official API prices via `dsh.pricing.sync`, and
 * auto-expands/promotes `focusModel` (even when unpriced/unmatched).
 *
 * Pure React Native + Paseo UI primitives (with graceful guards for Paseo
 * `>= 0.16.0`), zero browser-only APIs, Hermes-safe, and fully bilingual
 * (`zh-CN` / `en`) via `useCurrentLocale()`.
 *
 * @module dsh-paseo/client/console-pricing
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  Icon as HostIcon,
  Modal as HostModal,
  ScrollView as HostScrollView,
  TextInput as HostTextInput,
  useToast as hostUseToast,
  type ToastApi,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  ActivityIndicator,
  Modal as RNModal,
  Platform,
  Pressable,
  ScrollView as RNScrollView,
  Text,
  TextInput as RNTextInput,
  View,
  type ScrollView as NativeScrollView,
} from "react-native";
import {
  DEFAULT_PRICING_SYNC_SOURCE,
  DEFAULT_USD_TO_CNY_RATE,
  MAX_LONG_CONTEXT_THRESHOLD,
  MAX_RATE_PER_MILLION,
  MAX_USD_TO_CNY_RATE,
  MIN_USD_TO_CNY_RATE,
  convertCurrency,
  exchangeRateSchema,
  matchReferenceEntry,
  modelRatesSchema,
  normalizeModelKey,
  pricingGetRpc,
  pricingSyncRpc,
  pricingUpdateRpc,
  resolvePricingKey,
  stripProviderPrefix,
  type Currency,
  type ModelRates,
  type PricingModelRow,
  type PricingState,
  type PricingUpdateInput,
} from "../shared/pricing";
import { currencySymbol, integer, money, relative, tokens } from "./console-format";
import { font, mono, radius, space, tabular, tint, type Colors } from "./console-theme";
import { Badge, Button, Callout, Card, Divider, Muted, SegmentedControl } from "./console-ui";
import { useCurrentLocale } from "./use-locale";

/** Delay (ms) before re-presenting a native modal after a prior modal closes. */
export const MODAL_TRANSITION_MS = 180;

const DEFAULT_LONG_CONTEXT_THRESHOLD = 200_000;
const MAX_MODEL_KEY_LENGTH = 160;
const NARROW_WIDTH_PX = 480;
const INITIAL_VISIBLE_ROWS = 50;
const BACKGROUND_SYNC_POLL_MS = 1_500;

export interface PricingDialogProps {
  visible: boolean;
  onClose: () => void;
  client: PluginClientContext;
  colors: Colors;
  /** When opened from a `ModelTable` cost cell, auto-expand and surface this model row. */
  focusModel?: string | null;
  /** Notifies parent (Usage / Settings) when currency, exchange rate, or overrides change. */
  onUpdated?: (state: PricingState) => void;
}

type StatusFilter = "all" | "active" | "synced" | "unpriced";

interface CopyTable {
  title: string;
  subtitle: string;
  loading: string;
  loadFailed: string;
  retry: string;
  refresh: string;
  close: string;
  cancel: string;
  save: string;
  syncTitle: string;
  syncAction: string;
  syncingAction: string;
  syncAutoLabel: string;
  syncAutoHint: string;
  syncBadgeSynced: string;
  syncBadgeSyncing: string;
  syncBadgeNever: string;
  syncBadgeCachedError: string;
  syncBadgeError: string;
  syncSummarySynced: (source: string, count: string, when: string) => string;
  syncSummaryNever: (source: string) => string;
  syncErrorFallbackNote: (error: string) => string;
  syncSuccessToast: (count: string) => string;
  syncFailedToast: (error: string) => string;
  autoSyncSavedToast: (enabled: boolean) => string;
  displayCurrency: string;
  displayCurrencyHint: string;
  exchangeRate: string;
  exchangeRateUnitPrefix: string;
  exchangeRateUnitSuffix: string;
  saveRate: string;
  resetRate: (rate: number) => string;
  invalidExchangeRate: (min: number, max: number) => string;
  exchangeRatePreview: (usdOne: string, cnyTen: string) => string;
  exchangeRateSaved: string;
  currencySaved: (currency: Currency) => string;
  modelsHeading: string;
  modelsCount: (total: number, syncedCount: number, customCount: number) => string;
  searchPlaceholder: string;
  clearSearch: string;
  filterAll: string;
  filterActive: string;
  filterSynced: string;
  filterUnpriced: string;
  showAllModels: (total: number) => string;
  emptyMatches: string;
  badgeFocused: string;
  badgeCustom: string;
  badgeSynced: string;
  badgeReference: string;
  badgeUnpriced: string;
  badgeSeen: string;
  perMillionShort: string;
  unpricedSummary: string;
  rateCurrency: string;
  inputLabel: string;
  cachedLabel: string;
  cacheWriteLabel: string;
  outputLabel: string;
  optionalPlaceholder: string;
  longContextToggle: string;
  longThresholdLabel: string;
  longThresholdHint: (formatted: string) => string;
  longInputLabel: string;
  longCachedLabel: string;
  longCacheWriteLabel: string;
  longOutputLabel: string;
  syncedSummary: (provider: string | null, summary: string) => string;
  referenceSummary: (summary: string) => string;
  convertedPreview: (summary: string, rate: number) => string;
  prefixesLabel: (prefixes: string) => string;
  resetToSynced: string;
  resetToReference: string;
  removeCustom: string;
  addModel: string;
  addModelTitle: string;
  modelKeyLabel: string;
  modelKeyPlaceholder: string;
  resetAllOverrides: string;
  resetAllConfirmTitle: string;
  resetAllConfirmBody: (count: number) => string;
  confirmReset: string;
  invalidModelKey: string;
  invalidRate: (max: number) => string;
  invalidOptionalRate: (max: number) => string;
  invalidThreshold: (max: number) => string;
  savedToast: string;
  resetOneToast: string;
  resetAllToast: string;
  saveFailed: string;
  expandRowLabel: (label: string) => string;
  collapseRowLabel: (label: string) => string;
}

const COPY: Record<"en" | "zh-CN", CopyTable> = {
  en: {
    title: "Model Pricing & Exchange Rate",
    subtitle:
      "Rates are stored per 1M tokens in each model's native currency and converted into your display currency.",
    loading: "Loading pricing configuration…",
    loadFailed: "Could not load pricing configuration.",
    retry: "Retry",
    refresh: "Refresh",
    close: "Close",
    cancel: "Cancel",
    save: "Save",
    syncTitle: "Official API Pricing Sync",
    syncAction: "Sync Official Prices",
    syncingAction: "Syncing…",
    syncAutoLabel: "Auto-sync",
    syncAutoHint: "Refresh every 24h in background",
    syncBadgeSynced: "Synced",
    syncBadgeSyncing: "Syncing…",
    syncBadgeNever: "Not synced",
    syncBadgeCachedError: "Cached · sync error",
    syncBadgeError: "Sync failed",
    syncSummarySynced: (source, count, when) =>
      `Source: ${source} · ${count} official models · Updated ${when}`,
    syncSummaryNever: (source) =>
      `Source: ${source} · Never synced — using built-in reference rates`,
    syncErrorFallbackNote: (error) => `Last sync failed (${error}). Cached & built-in rates remain active.`,
    syncSuccessToast: (count) => `Synced official prices for ${count} models.`,
    syncFailedToast: (error) => `Official pricing sync failed: ${error}`,
    autoSyncSavedToast: (enabled) =>
      enabled ? "Automatic official price sync enabled." : "Automatic official price sync disabled.",
    displayCurrency: "Display currency",
    displayCurrencyHint: "Usage charts, totals, and tables convert costs into this currency.",
    exchangeRate: "USD → CNY rate",
    exchangeRateUnitPrefix: "1 USD =",
    exchangeRateUnitSuffix: "CNY",
    saveRate: "Save rate",
    resetRate: (rate) => `Reset ${rate}`,
    invalidExchangeRate: (min, max) => `Enter an exchange rate between ${min} and ${max}.`,
    exchangeRatePreview: (usdOne, cnyTen) => `1 USD ≈ ${usdOne} · ¥10 ≈ ${cnyTen}`,
    exchangeRateSaved: "Exchange rate saved.",
    currencySaved: (currency) => `Display currency switched to ${currency}.`,
    modelsHeading: "Model rates (per 1M tokens)",
    modelsCount: (total, syncedCount, customCount) => {
      const parts = [`${total} entries`];
      if (syncedCount > 0) parts.push(`${syncedCount} synced`);
      if (customCount > 0) parts.push(`${customCount} custom`);
      return parts.join(" · ");
    },
    searchPlaceholder: "Filter by model ID, provider, or family…",
    clearSearch: "Clear filter",
    filterAll: "All",
    filterActive: "Used & custom",
    filterSynced: "Synced",
    filterUnpriced: "Unpriced",
    showAllModels: (total) => `Show all ${total} models`,
    emptyMatches: "No matching model entries.",
    badgeFocused: "Selected",
    badgeCustom: "Custom",
    badgeSynced: "Synced",
    badgeReference: "Built-in",
    badgeUnpriced: "Unpriced",
    badgeSeen: "Used",
    perMillionShort: "/ 1M",
    unpricedSummary: "Unpriced — tap to set",
    rateCurrency: "Rate currency",
    inputLabel: "Input",
    cachedLabel: "Cached read",
    cacheWriteLabel: "Cache write (opt.)",
    outputLabel: "Output",
    optionalPlaceholder: "Fallback: input",
    longContextToggle: "Enable long-context tier pricing",
    longThresholdLabel: "Prompt threshold (tokens)",
    longThresholdHint: (formatted) => `Applies above ${formatted} prompt tokens`,
    longInputLabel: "Long input",
    longCachedLabel: "Long cached",
    longCacheWriteLabel: "Long cache write (opt.)",
    longOutputLabel: "Long output",
    syncedSummary: (provider, summary) =>
      provider ? `Official (${provider}): ${summary}` : `Official synced: ${summary}`,
    referenceSummary: (summary) => `Built-in reference: ${summary}`,
    convertedPreview: (summary, rate) => `Display equivalent (1 USD = ¥${rate}): ${summary}`,
    prefixesLabel: (prefixes) => `Matches: ${prefixes}`,
    resetToSynced: "Reset to synced",
    resetToReference: "Reset to built-in",
    removeCustom: "Remove override",
    addModel: "Add custom model",
    addModelTitle: "Add custom model rates",
    modelKeyLabel: "Model ID or prefix key",
    modelKeyPlaceholder: "e.g. model-id or provider/model-id",
    resetAllOverrides: "Reset all overrides",
    resetAllConfirmTitle: "Reset all custom overrides?",
    resetAllConfirmBody: (count) =>
      `Clears ${count} custom override(s) while keeping your display currency and exchange rate.`,
    confirmReset: "Reset overrides",
    invalidModelKey: "Enter a model key (1–160 characters).",
    invalidRate: (max) => `Enter non-negative rates up to ${max} per 1M tokens.`,
    invalidOptionalRate: (max) => `Optional cache write must be empty or between 0 and ${max}.`,
    invalidThreshold: (max) => `Enter a whole-number token threshold between 1 and ${max}.`,
    savedToast: "Pricing saved.",
    resetOneToast: "Override removed.",
    resetAllToast: "All custom overrides reset.",
    saveFailed: "Could not save pricing changes.",
    expandRowLabel: (label) => `Edit pricing for ${label}`,
    collapseRowLabel: (label) => `Collapse pricing editor for ${label}`,
  },
  "zh-CN": {
    title: "模型单价与汇率设置",
    subtitle: "每个模型按自身原生币种配置每 1M token 单价，汇总展示时自动按汇率折算为显示币种。",
    loading: "正在加载单价配置…",
    loadFailed: "无法加载单价配置。",
    retry: "重试",
    refresh: "刷新",
    close: "关闭",
    cancel: "取消",
    save: "保存",
    syncTitle: "官方 API 价格同步",
    syncAction: "同步官方价格",
    syncingAction: "正在同步…",
    syncAutoLabel: "自动同步",
    syncAutoHint: "每 24 小时后台自动刷新",
    syncBadgeSynced: "已同步",
    syncBadgeSyncing: "同步中…",
    syncBadgeNever: "未同步",
    syncBadgeCachedError: "使用缓存 · 同步失败",
    syncBadgeError: "同步失败",
    syncSummarySynced: (source, count, when) =>
      `来源：${source} · 已同步 ${count} 个官方模型 · 上次同步：${when}`,
    syncSummaryNever: (source) => `来源：${source} · 尚未同步，当前使用内置参考价`,
    syncErrorFallbackNote: (error) => `上次同步失败（${error}），已回退到缓存与内置参考价。`,
    syncSuccessToast: (count) => `已同步 ${count} 个官方模型价格。`,
    syncFailedToast: (error) => `同步官方价格失败：${error}`,
    autoSyncSavedToast: (enabled) =>
      enabled ? "已开启官方价格自动同步。" : "已关闭官方价格自动同步。",
    displayCurrency: "显示币种",
    displayCurrencyHint: "用量图表、汇总卡片与模型表均折算为此币种展示。",
    exchangeRate: "USD → CNY 汇率",
    exchangeRateUnitPrefix: "1 USD =",
    exchangeRateUnitSuffix: "CNY",
    saveRate: "保存汇率",
    resetRate: (rate) => `恢复 ${rate}`,
    invalidExchangeRate: (min, max) => `请输入 ${min} 到 ${max} 之间的有效正数汇率。`,
    exchangeRatePreview: (usdOne, cnyTen) => `1 USD ≈ ${usdOne} · ¥10 ≈ ${cnyTen}`,
    exchangeRateSaved: "汇率已保存。",
    currencySaved: (currency) => `已切换显示币种为 ${currency}。`,
    modelsHeading: "模型单价（每 1M token）",
    modelsCount: (total, syncedCount, customCount) => {
      const parts = [`共 ${total} 项`];
      if (syncedCount > 0) parts.push(`${syncedCount} 项官方同步`);
      if (customCount > 0) parts.push(`${customCount} 项自定义`);
      return parts.join(" · ");
    },
    searchPlaceholder: "搜索模型 ID、官方提供方或模型族…",
    clearSearch: "清空筛选",
    filterAll: "全部",
    filterActive: "已用 / 自定义",
    filterSynced: "官方同步",
    filterUnpriced: "未定价",
    showAllModels: (total) => `展开全部 ${total} 个模型`,
    emptyMatches: "没有匹配的模型条目。",
    badgeFocused: "当前选中",
    badgeCustom: "自定义",
    badgeSynced: "官方同步",
    badgeReference: "内置参考",
    badgeUnpriced: "未定价",
    badgeSeen: "已使用",
    perMillionShort: "/ 1M",
    unpricedSummary: "未定价 · 点击填写",
    rateCurrency: "单价币种",
    inputLabel: "输入",
    cachedLabel: "缓存读取",
    cacheWriteLabel: "缓存写入（可选）",
    outputLabel: "输出",
    optionalPlaceholder: "留空同输入",
    longContextToggle: "启用长上下文阶梯单价",
    longThresholdLabel: "提示词阈值（token）",
    longThresholdHint: (formatted) => `单次提示词超过 ${formatted} token 时生效`,
    longInputLabel: "长上下文输入",
    longCachedLabel: "长上下文缓存读",
    longCacheWriteLabel: "长上下文缓存写（可选）",
    longOutputLabel: "长上下文输出",
    syncedSummary: (provider, summary) =>
      provider ? `官方同步价（${provider}）：${summary}` : `官方同步价：${summary}`,
    referenceSummary: (summary) => `内置参考价：${summary}`,
    convertedPreview: (summary, rate) => `按 1 USD = ¥${rate} 折算：${summary}`,
    prefixesLabel: (prefixes) => `匹配前缀：${prefixes}`,
    resetToSynced: "恢复官方价",
    resetToReference: "恢复内置价",
    removeCustom: "删除自定义价",
    addModel: "添加自定义模型",
    addModelTitle: "新增模型单价",
    modelKeyLabel: "模型 ID 或匹配键",
    modelKeyPlaceholder: "例如 model-id 或 provider/model-id",
    resetAllOverrides: "重置全部自定义",
    resetAllConfirmTitle: "确认清除全部自定义单价？",
    resetAllConfirmBody: (count) =>
      `将清除全部 ${count} 项自定义单价，保留当前的显示币种与汇率设置。`,
    confirmReset: "确认重置",
    invalidModelKey: "请输入 1–160 字符的模型标识。",
    invalidRate: (max) => `请输入 0 到 ${max} 之间的有效单价（每 1M token）。`,
    invalidOptionalRate: (max) => `可选缓存写入单价须留空或填写 0 到 ${max} 之间的数字。`,
    invalidThreshold: (max) => `请输入 1 到 ${max} 之间的正整数 token 阈值。`,
    savedToast: "单价已保存。",
    resetOneToast: "已移除自定义单价。",
    resetAllToast: "已重置全部自定义单价。",
    saveFailed: "保存单价配置失败。",
    expandRowLabel: (label) => `编辑 ${label} 的单价`,
    collapseRowLabel: (label) => `收起 ${label} 的单价编辑`,
  },
};

const CURRENCY_OPTIONS: ReadonlyArray<{ readonly value: Currency; readonly label: string }> = [
  { value: "USD", label: "USD $" },
  { value: "CNY", label: "CNY ¥" },
];

function isRenderableComponent(value: unknown): value is ComponentType<Record<string, unknown>> {
  return typeof value === "function" || (typeof value === "object" && value !== null);
}

const SafeTextInput = isRenderableComponent(HostTextInput) ? HostTextInput : RNTextInput;
const SafeScrollView = isRenderableComponent(HostScrollView) ? HostScrollView : RNScrollView;
const HAS_HOST_MODAL =
  isRenderableComponent(HostModal) &&
  isRenderableComponent((HostModal as { Content?: unknown }).Content);

function SafeIcon({ name, size, color }: { name: string; size: number; color: string }) {
  if (!isRenderableComponent(HostIcon)) return null;
  return <HostIcon name={name} size={size} color={color} />;
}

/**
 * Guards `@getpaseo/plugin/client/ui`'s `useToast()` for Paseo `>= 0.16.0` hosts
 * or isolated test renders where the toast hook or provider may be absent.
 */
function useSafeToast(): ToastApi {
  let raw: ToastApi | undefined;
  if (typeof hostUseToast === "function") {
    try {
      raw = hostUseToast();
    } catch {
      raw = undefined;
    }
  }
  return useMemo<ToastApi>(
    () => ({
      show(message, options) {
        try {
          raw?.show?.(message, options);
        } catch {
          // Ignore toast transport errors so dialogs never fail on notification delivery.
        }
      },
      error(message) {
        try {
          if (typeof raw?.error === "function") {
            raw.error(message);
          } else {
            raw?.show?.(message, { variant: "error" });
          }
        } catch {
          // Ignore toast transport errors.
        }
      },
    }),
    [raw],
  );
}

function numericKeyboardType(): "default" | "decimal-pad" {
  return Platform.OS === "web" ? "default" : "decimal-pad";
}

function integerKeyboardType(): "default" | "numeric" {
  return Platform.OS === "web" ? "default" : "numeric";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return fallback;
}

function fmtInputNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return String(value);
}

function fmtCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Number(value.toFixed(4));
  return String(rounded);
}

/** Compact single-line summary of native per-1M rates (`"$3 / $0.3 / $15"`). */
export function formatRatesSummary(rates: ModelRates): string {
  const sym = currencySymbol(rates.currency);
  const parts = [
    `${sym}${fmtCompactNumber(rates.input)}`,
    `${sym}${fmtCompactNumber(rates.cached)}`,
    `${sym}${fmtCompactNumber(rates.output)}`,
  ];
  return parts.join(" / ");
}

type ParsedOptionalRate =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly value: number };

function parseOptionalRate(raw: string): ParsedOptionalRate {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "empty" };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_RATE_PER_MILLION) {
    return { kind: "invalid" };
  }
  return { kind: "ok", value: parsed };
}

function parseRequiredRate(raw: string): number | null {
  const result = parseOptionalRate(raw);
  return result.kind === "ok" ? result.value : null;
}

function parseThreshold(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_LONG_CONTEXT_THRESHOLD
  ) {
    return null;
  }
  return parsed;
}

function parseExchangeRateInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  const checked = exchangeRateSchema.safeParse(parsed);
  return checked.success ? checked.data : null;
}

interface RateDraft {
  currency: Currency;
  input: string;
  cached: string;
  cacheWrite: string;
  output: string;
  hasLongTier: boolean;
  longThreshold: string;
  longInput: string;
  longCached: string;
  longCacheWrite: string;
  longOutput: string;
}

function draftFromRates(rates: ModelRates | null, fallbackCurrency: Currency): RateDraft {
  return {
    currency: rates?.currency ?? fallbackCurrency,
    input: fmtInputNumber(rates?.input),
    cached: fmtInputNumber(rates?.cached),
    cacheWrite: fmtInputNumber(rates?.cacheWrite),
    output: fmtInputNumber(rates?.output),
    hasLongTier: Boolean(rates?.longContextThreshold),
    longThreshold: fmtInputNumber(rates?.longContextThreshold),
    longInput: fmtInputNumber(rates?.longInput),
    longCached: fmtInputNumber(rates?.longCached),
    longCacheWrite: fmtInputNumber(rates?.longCacheWrite),
    longOutput: fmtInputNumber(rates?.longOutput),
  };
}

function validateRateDraft(
  draft: RateDraft,
  copy: CopyTable,
): { readonly ok: true; readonly rates: ModelRates } | { readonly ok: false; readonly error: string } {
  const input = parseRequiredRate(draft.input);
  const cached = parseRequiredRate(draft.cached);
  const output = parseRequiredRate(draft.output);
  if (input === null || cached === null || output === null) {
    return { ok: false, error: copy.invalidRate(MAX_RATE_PER_MILLION) };
  }

  const cacheWrite = parseOptionalRate(draft.cacheWrite);
  if (cacheWrite.kind === "invalid") {
    return { ok: false, error: copy.invalidOptionalRate(MAX_RATE_PER_MILLION) };
  }

  const candidate: ModelRates = {
    currency: draft.currency,
    input,
    cached,
    ...(cacheWrite.kind === "ok" ? { cacheWrite: cacheWrite.value } : {}),
    output,
  };

  if (draft.hasLongTier) {
    const threshold = parseThreshold(draft.longThreshold);
    if (threshold === null) {
      return { ok: false, error: copy.invalidThreshold(MAX_LONG_CONTEXT_THRESHOLD) };
    }
    const longInput = parseRequiredRate(draft.longInput);
    const longCached = parseRequiredRate(draft.longCached);
    const longOutput = parseRequiredRate(draft.longOutput);
    if (longInput === null || longCached === null || longOutput === null) {
      return { ok: false, error: copy.invalidRate(MAX_RATE_PER_MILLION) };
    }
    const longCacheWrite = parseOptionalRate(draft.longCacheWrite);
    if (longCacheWrite.kind === "invalid") {
      return { ok: false, error: copy.invalidOptionalRate(MAX_RATE_PER_MILLION) };
    }
    candidate.longContextThreshold = threshold;
    candidate.longInput = longInput;
    candidate.longCached = longCached;
    if (longCacheWrite.kind === "ok") {
      candidate.longCacheWrite = longCacheWrite.value;
    }
    candidate.longOutput = longOutput;
  }

  const parsed = modelRatesSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? copy.saveFailed };
  }
  return { ok: true, rates: parsed.data };
}

function buildConvertedRatesPreview(
  draft: RateDraft,
  displayCurrency: Currency,
  usdToCnyRate: number,
  locale: string,
): string | null {
  if (draft.currency === displayCurrency) return null;
  const input = parseRequiredRate(draft.input);
  const cached = parseRequiredRate(draft.cached);
  const output = parseRequiredRate(draft.output);
  if (input === null || cached === null || output === null) return null;
  try {
    const cInput = convertCurrency(input, draft.currency, displayCurrency, usdToCnyRate);
    const cCached = convertCurrency(cached, draft.currency, displayCurrency, usdToCnyRate);
    const cOutput = convertCurrency(output, draft.currency, displayCurrency, usdToCnyRate);
    return `${money(cInput, displayCurrency, locale)} / ${money(cCached, displayCurrency, locale)} / ${money(cOutput, displayCurrency, locale)}`;
  } catch {
    return null;
  }
}

function resolveFocusTarget(
  focusModel: string | null | undefined,
  state: PricingState | null,
): { readonly key: string | null; readonly syntheticRow: PricingModelRow | null } {
  const raw = focusModel?.trim() ?? "";
  if (!raw || !state) return { key: null, syntheticRow: null };

  const normalized = normalizeModelKey(raw);
  if (!normalized) return { key: null, syntheticRow: null };

  const exactMatch = state.models.find((row) => normalizeModelKey(row.key) === normalized);
  if (exactMatch) return { key: exactMatch.key, syntheticRow: null };

  const bare = stripProviderPrefix(normalized);
  if (bare && bare !== normalized) {
    const bareMatch = state.models.find((row) => normalizeModelKey(row.key) === bare);
    if (bareMatch) return { key: bareMatch.key, syntheticRow: null };
  }

  const resolvedKey = resolvePricingKey(raw, undefined, state.overrides);
  const resolvedMatch = state.models.find((row) => normalizeModelKey(row.key) === resolvedKey);
  if (resolvedMatch) return { key: resolvedMatch.key, syntheticRow: null };

  const syntheticKey = (
    resolvedKey && resolvedKey !== "unknown" ? resolvedKey : normalized
  ).slice(0, MAX_MODEL_KEY_LENGTH);
  if (!syntheticKey) return { key: null, syntheticRow: null };

  const matchedRef = matchReferenceEntry(raw);
  const syntheticRow: PricingModelRow = {
    key: syntheticKey,
    label: raw.slice(0, MAX_MODEL_KEY_LENGTH),
    family: matchedRef?.family ?? null,
    prefixes: [],
    reference: matchedRef ? { ...matchedRef.rates } : null,
    synced: null,
    syncedProvider: null,
    custom: null,
    effective: matchedRef ? { ...matchedRef.rates } : null,
    source: matchedRef ? "reference" : null,
    note: matchedRef?.note ?? null,
    seenLocally: true,
  };
  return { key: syntheticRow.key, syntheticRow };
}

function matchesSearch(row: PricingModelRow, query: string): boolean {
  if (!query) return true;
  if (row.key.toLowerCase().includes(query)) return true;
  if (row.label.toLowerCase().includes(query)) return true;
  if (row.family && row.family.toLowerCase().includes(query)) return true;
  if (row.syncedProvider && row.syncedProvider.toLowerCase().includes(query)) return true;
  return row.prefixes.some((prefix) => prefix.toLowerCase().includes(query));
}

function RateInputField({
  colors,
  label,
  prefix,
  value,
  placeholder,
  editable,
  narrow,
  integerOnly = false,
  onChangeText,
}: {
  colors: Colors;
  label: string;
  prefix?: string;
  value: string;
  placeholder: string;
  editable: boolean;
  narrow: boolean;
  integerOnly?: boolean;
  onChangeText(text: string): void;
}) {
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: narrow ? "45%" : "22%",
        minWidth: narrow ? 112 : 104,
        gap: space.xs,
      }}
    >
      <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
        {label}
      </Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: colors.surface0,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.sm,
          paddingHorizontal: space.sm,
          minHeight: 34,
        }}
      >
        {prefix ? (
          <Text style={{ ...font.small, color: colors.foregroundMuted, marginRight: 3 }}>
            {prefix}
          </Text>
        ) : null}
        <SafeTextInput
          accessibilityLabel={label}
          keyboardType={integerOnly ? integerKeyboardType() : numericKeyboardType()}
          autoCapitalize="none"
          autoCorrect={false}
          value={value}
          editable={editable}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={tint(colors.foregroundMuted, 0.55)}
          style={{
            ...font.small,
            ...tabular,
            flex: 1,
            minWidth: 0,
            color: colors.foreground,
            paddingVertical: 6,
          }}
        />
      </View>
    </View>
  );
}

function RateFieldsEditor({
  colors,
  copy,
  locale,
  draft,
  displayCurrency,
  usdToCnyRate,
  defaultLongThreshold,
  disabled,
  narrow,
  onChange,
}: {
  colors: Colors;
  copy: CopyTable;
  locale: string;
  draft: RateDraft;
  displayCurrency: Currency;
  usdToCnyRate: number;
  defaultLongThreshold: number;
  disabled: boolean;
  narrow: boolean;
  onChange(next: RateDraft): void;
}) {
  const sym = currencySymbol(draft.currency);
  const convertedPreview = buildConvertedRatesPreview(draft, displayCurrency, usdToCnyRate, locale);
  const parsedThreshold = parseThreshold(draft.longThreshold);

  const toggleLongTier = () => {
    if (disabled) return;
    const nextEnabled = !draft.hasLongTier;
    if (nextEnabled && !draft.longThreshold && !draft.longInput && !draft.longOutput) {
      const baseInput = parseRequiredRate(draft.input) ?? 0;
      const baseCached = parseRequiredRate(draft.cached) ?? 0;
      const baseOutput = parseRequiredRate(draft.output) ?? 0;
      const baseCacheWrite = parseOptionalRate(draft.cacheWrite);
      onChange({
        ...draft,
        hasLongTier: true,
        longThreshold: String(defaultLongThreshold),
        longInput: fmtCompactNumber(baseInput * 2),
        longCached: fmtCompactNumber(baseCached * 2),
        longCacheWrite:
          baseCacheWrite.kind === "ok" ? fmtCompactNumber(baseCacheWrite.value * 2) : "",
        longOutput: fmtCompactNumber(baseOutput * 1.5),
      });
      return;
    }
    onChange({
      ...draft,
      hasLongTier: nextEnabled,
      ...(nextEnabled && !draft.longThreshold
        ? { longThreshold: String(defaultLongThreshold) }
        : {}),
    });
  };

  const currencyOptions = useMemo(
    () => CURRENCY_OPTIONS.map((option) => ({ ...option, disabled })),
    [disabled],
  );

  return (
    <View style={{ gap: space.md }}>
      <View
        style={{
          flexDirection: narrow ? "column" : "row",
          alignItems: narrow ? "flex-start" : "center",
          justifyContent: "space-between",
          gap: space.sm,
        }}
      >
        <Text style={{ ...font.caption, fontWeight: "600", color: colors.foregroundMuted }}>
          {copy.rateCurrency}
        </Text>
        <SegmentedControl<Currency>
          colors={colors}
          value={draft.currency}
          options={currencyOptions}
          onChange={(currency) => {
            if (!disabled) onChange({ ...draft, currency });
          }}
        />
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <RateInputField
          colors={colors}
          label={copy.inputLabel}
          prefix={sym}
          value={draft.input}
          placeholder="0"
          editable={!disabled}
          narrow={narrow}
          onChangeText={(input) => onChange({ ...draft, input })}
        />
        <RateInputField
          colors={colors}
          label={copy.cachedLabel}
          prefix={sym}
          value={draft.cached}
          placeholder="0"
          editable={!disabled}
          narrow={narrow}
          onChangeText={(cached) => onChange({ ...draft, cached })}
        />
        <RateInputField
          colors={colors}
          label={copy.cacheWriteLabel}
          prefix={sym}
          value={draft.cacheWrite}
          placeholder={copy.optionalPlaceholder}
          editable={!disabled}
          narrow={narrow}
          onChangeText={(cacheWrite) => onChange({ ...draft, cacheWrite })}
        />
        <RateInputField
          colors={colors}
          label={copy.outputLabel}
          prefix={sym}
          value={draft.output}
          placeholder="0"
          editable={!disabled}
          narrow={narrow}
          onChangeText={(output) => onChange({ ...draft, output })}
        />
      </View>

      {convertedPreview ? (
        <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
          {copy.convertedPreview(convertedPreview, usdToCnyRate)}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: draft.hasLongTier, disabled }}
        disabled={disabled}
        onPress={toggleLongTier}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs + 2,
          alignSelf: "flex-start",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <SafeIcon
          name={draft.hasLongTier ? "CheckSquare" : "Square"}
          size={15}
          color={draft.hasLongTier ? colors.accent : colors.foregroundMuted}
        />
        <Text style={{ ...font.caption, color: colors.foreground }}>{copy.longContextToggle}</Text>
      </Pressable>

      {draft.hasLongTier ? (
        <View
          style={{
            gap: space.sm,
            padding: space.sm + 2,
            borderRadius: radius.sm,
            backgroundColor: tint(colors.foreground, 0.03),
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <View
            style={{
              flexDirection: narrow ? "column" : "row",
              alignItems: narrow ? "stretch" : "flex-end",
              gap: space.sm,
            }}
          >
            <RateInputField
              colors={colors}
              label={copy.longThresholdLabel}
              value={draft.longThreshold}
              placeholder={String(defaultLongThreshold)}
              editable={!disabled}
              narrow={narrow}
              integerOnly
              onChangeText={(longThreshold) => onChange({ ...draft, longThreshold })}
            />
            {parsedThreshold !== null ? (
              <Text
                style={{
                  ...font.caption,
                  ...tabular,
                  color: colors.foregroundMuted,
                  paddingBottom: narrow ? 0 : 8,
                }}
              >
                {copy.longThresholdHint(tokens(parsedThreshold))}
              </Text>
            ) : null}
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            <RateInputField
              colors={colors}
              label={copy.longInputLabel}
              prefix={sym}
              value={draft.longInput}
              placeholder="0"
              editable={!disabled}
              narrow={narrow}
              onChangeText={(longInput) => onChange({ ...draft, longInput })}
            />
            <RateInputField
              colors={colors}
              label={copy.longCachedLabel}
              prefix={sym}
              value={draft.longCached}
              placeholder="0"
              editable={!disabled}
              narrow={narrow}
              onChangeText={(longCached) => onChange({ ...draft, longCached })}
            />
            <RateInputField
              colors={colors}
              label={copy.longCacheWriteLabel}
              prefix={sym}
              value={draft.longCacheWrite}
              placeholder={copy.optionalPlaceholder}
              editable={!disabled}
              narrow={narrow}
              onChangeText={(longCacheWrite) => onChange({ ...draft, longCacheWrite })}
            />
            <RateInputField
              colors={colors}
              label={copy.longOutputLabel}
              prefix={sym}
              value={draft.longOutput}
              placeholder="0"
              editable={!disabled}
              narrow={narrow}
              onChangeText={(longOutput) => onChange({ ...draft, longOutput })}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function PricingModelRowCard({
  colors,
  copy,
  locale,
  row,
  displayCurrency,
  usdToCnyRate,
  expanded,
  focused,
  narrow,
  globalBusy,
  onToggle,
  onSave,
  onReset,
}: {
  colors: Colors;
  copy: CopyTable;
  locale: string;
  row: PricingModelRow;
  displayCurrency: Currency;
  usdToCnyRate: number;
  expanded: boolean;
  focused: boolean;
  narrow: boolean;
  globalBusy: boolean;
  onToggle(): void;
  onSave(rates: ModelRates): Promise<void>;
  onReset(): Promise<void>;
}) {
  const [draft, setDraft] = useState<RateDraft>(() =>
    draftFromRates(row.effective, displayCurrency),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlightRef = useRef(false);

  const effectiveFingerprint = JSON.stringify(row.effective ?? null);
  useEffect(() => {
    setDraft(draftFromRates(row.effective, displayCurrency));
    setError("");
  }, [effectiveFingerprint, displayCurrency, row.key]);

  const disabled = busy || globalBusy;
  const sourceBadge =
    row.source === "override" || row.custom
      ? { label: copy.badgeCustom, tone: "accent" as const }
      : row.source === "synced" || row.synced
        ? { label: copy.badgeSynced, tone: "success" as const }
        : row.source === "reference" || row.reference
          ? { label: copy.badgeReference, tone: "neutral" as const }
          : { label: copy.badgeUnpriced, tone: "warning" as const };

  const summaryText = row.effective
    ? `${formatRatesSummary(row.effective)} ${copy.perMillionShort}`
    : copy.unpricedSummary;

  const showKeySubtitle = normalizeModelKey(row.label) !== normalizeModelKey(row.key);

  const handleSave = async () => {
    if (disabled || inFlightRef.current) return;
    const validated = validateRateDraft(draft, copy);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    inFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(validated.rates);
    } catch (reason) {
      setError(errorMessage(reason, copy.saveFailed));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (disabled || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onReset();
    } catch (reason) {
      setError(errorMessage(reason, copy.saveFailed));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const handleCancel = () => {
    setDraft(draftFromRates(row.effective, displayCurrency));
    setError("");
    onToggle();
  };

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: expanded || focused ? tint(colors.accent, 0.5) : colors.border,
        borderRadius: radius.md,
        backgroundColor: colors.surface1,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? copy.collapseRowLabel(row.label) : copy.expandRowLabel(row.label)}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={(state) => ({
          paddingHorizontal: space.md,
          paddingVertical: space.sm + 2,
          gap: space.xs + 2,
          backgroundColor: (state as { hovered?: boolean }).hovered
            ? tint(colors.foreground, 0.04)
            : focused && !expanded
              ? tint(colors.accent, 0.05)
              : "transparent",
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}>
              <Text
                numberOfLines={1}
                style={{ ...font.small, fontWeight: "600", color: colors.foreground, flexShrink: 1 }}
              >
                {row.label}
              </Text>
              {focused ? <Badge colors={colors} label={copy.badgeFocused} tone="accent" /> : null}
              {row.effective ? (
                <Badge colors={colors} label={row.effective.currency} tone="neutral" />
              ) : null}
              <Badge colors={colors} label={sourceBadge.label} tone={sourceBadge.tone} />
              {row.seenLocally ? (
                <Badge colors={colors} label={copy.badgeSeen} tone="success" dot />
              ) : null}
            </View>
            {showKeySubtitle ? (
              <Text
                numberOfLines={1}
                style={{ ...font.caption, fontFamily: mono, color: colors.foregroundMuted }}
              >
                {row.key}
              </Text>
            ) : null}
          </View>

          {!narrow ? (
            <Text
              numberOfLines={1}
              style={{
                ...font.caption,
                ...tabular,
                color: row.effective ? colors.foreground : colors.statusWarning,
                fontWeight: row.effective ? "500" : "600",
              }}
            >
              {summaryText}
            </Text>
          ) : null}

          <SafeIcon
            name={expanded ? "ChevronDown" : "ChevronRight"}
            size={15}
            color={colors.foregroundMuted}
          />
        </View>

        {narrow ? (
          <Text
            numberOfLines={1}
            style={{
              ...font.caption,
              ...tabular,
              color: row.effective ? colors.foregroundMuted : colors.statusWarning,
              fontWeight: row.effective ? "500" : "600",
            }}
          >
            {summaryText}
          </Text>
        ) : null}
      </Pressable>

      {expanded ? (
        <View
          style={{
            padding: space.md,
            gap: space.md,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          {row.synced || row.reference ? (
            <View style={{ gap: 2 }}>
              {row.synced ? (
                <Muted colors={colors} small>
                  {copy.syncedSummary(
                    row.syncedProvider,
                    `${formatRatesSummary(row.synced)} ${copy.perMillionShort}${
                      row.synced.cacheWrite !== undefined
                        ? ` · CW ${currencySymbol(row.synced.currency)}${fmtCompactNumber(row.synced.cacheWrite)}`
                        : ""
                    }`,
                  )}
                  {row.note ? ` · ${row.note}` : ""}
                </Muted>
              ) : null}
              {row.reference ? (
                <Muted colors={colors} small>
                  {copy.referenceSummary(
                    `${formatRatesSummary(row.reference)} ${copy.perMillionShort}${
                      row.reference.cacheWrite !== undefined
                        ? ` · CW ${currencySymbol(row.reference.currency)}${fmtCompactNumber(row.reference.cacheWrite)}`
                        : ""
                    }`,
                  )}
                  {!row.synced && row.note ? ` · ${row.note}` : ""}
                </Muted>
              ) : null}
              {row.prefixes.length > 0 ? (
                <Text
                  numberOfLines={2}
                  style={{ ...font.caption, fontFamily: mono, color: colors.foregroundMuted }}
                >
                  {copy.prefixesLabel(row.prefixes.join(", "))}
                </Text>
              ) : null}
            </View>
          ) : null}

          <RateFieldsEditor
            colors={colors}
            copy={copy}
            locale={locale}
            draft={draft}
            displayCurrency={displayCurrency}
            usdToCnyRate={usdToCnyRate}
            defaultLongThreshold={
              row.synced?.longContextThreshold ??
              row.reference?.longContextThreshold ??
              DEFAULT_LONG_CONTEXT_THRESHOLD
            }
            disabled={disabled}
            narrow={narrow}
            onChange={(next) => {
              setDraft(next);
              if (error) setError("");
            }}
          />

          {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}

          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: space.sm,
            }}
          >
            {row.custom ? (
              <Button
                colors={colors}
                size="sm"
                variant="ghost"
                icon="RotateCcw"
                label={
                  row.synced
                    ? copy.resetToSynced
                    : row.reference
                      ? copy.resetToReference
                      : copy.removeCustom
                }
                disabled={disabled}
                onPress={() => void handleReset()}
              />
            ) : null}
            <Button
              colors={colors}
              size="sm"
              variant="ghost"
              label={copy.cancel}
              disabled={disabled}
              onPress={handleCancel}
            />
            <Button
              colors={colors}
              size="sm"
              variant="primary"
              icon="Check"
              label={copy.save}
              loading={busy}
              disabled={globalBusy && !busy}
              onPress={() => void handleSave()}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Dual-currency model pricing & exchange rate dialog shared by Tab 1 (Usage)
 * and Tab 3 (Settings).
 */
export function PricingDialog({
  visible,
  onClose,
  client,
  colors,
  focusModel = null,
  onUpdated,
}: PricingDialogProps) {
  const locale = useCurrentLocale();
  const copy = COPY[locale === "zh-CN" ? "zh-CN" : "en"];
  const toast = useSafeToast();

  // Keep native modal presentation 180ms-safe if closed and reopened back-to-back.
  const [modalOpen, setModalOpen] = useState(visible);
  const wasVisibleRef = useRef(visible);
  const lastClosedAtRef = useRef(0);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openSessionRef = useRef(0);
  const appliedFocusTokenRef = useRef<string | null>(null);
  const loadRequestIdRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const fallbackScrollRef = useRef<NativeScrollView | null>(null);

  const [state, setState] = useState<PricingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [mutating, setMutating] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  const [rateInput, setRateInput] = useState(String(DEFAULT_USD_TO_CNY_RATE));
  const [rateError, setRateError] = useState("");
  const [rateBusy, setRateBusy] = useState(false);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showAllRows, setShowAllRows] = useState(false);

  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newDraft, setNewDraft] = useState<RateDraft>(() => draftFromRates(null, "USD"));
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");

  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [resetAllBusy, setResetAllBusy] = useState(false);

  const [bodyWidth, setBodyWidth] = useState(0);
  const narrow = bodyWidth > 0 && bodyWidth < NARROW_WIDTH_PX;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (openTimerRef.current) {
        clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }

    if (visible) {
      if (!wasVisibleRef.current) {
        openSessionRef.current += 1;
        appliedFocusTokenRef.current = null;
        setSearchQuery("");
        setStatusFilter("all");
        setShowAllRows(false);
        setAdding(false);
        setAddError("");
        setConfirmResetAll(false);
        setRateError("");
      }
      wasVisibleRef.current = true;

      const elapsed = Date.now() - lastClosedAtRef.current;
      if (Platform.OS !== "web" && lastClosedAtRef.current > 0 && elapsed < MODAL_TRANSITION_MS) {
        openTimerRef.current = setTimeout(() => {
          openTimerRef.current = null;
          setModalOpen(true);
        }, MODAL_TRANSITION_MS - elapsed);
      } else {
        setModalOpen(true);
      }
    } else {
      if (wasVisibleRef.current) {
        lastClosedAtRef.current = Date.now();
      }
      wasVisibleRef.current = false;
      setModalOpen(false);
      setExpandedKey(null);
      setConfirmResetAll(false);
      setAdding(false);
    }
  }, [visible]);

  const loadState = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setLoadError("");
    try {
      const next = await client.rpc(pricingGetRpc, {});
      if (loadRequestIdRef.current !== requestId) return;
      setState(next);
      setRateInput(String(next.usdToCnyRate));
      setRateError("");
    } catch (reason) {
      if (loadRequestIdRef.current !== requestId) return;
      setLoadError(errorMessage(reason, copy.loadFailed));
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [client, copy.loadFailed]);

  useEffect(() => {
    if (!visible) {
      loadRequestIdRef.current += 1;
      return;
    }
    void loadState();
  }, [visible, loadState]);

  // If a background auto-sync was in progress when the dialog loaded, refresh once shortly after.
  useEffect(() => {
    if (!visible || !state?.sync.syncing || syncBusy) return;
    const timer = setTimeout(() => {
      if (mountedRef.current && !mutationInFlightRef.current) {
        void loadState();
      }
    }, BACKGROUND_SYNC_POLL_MS);
    return () => clearTimeout(timer);
  }, [visible, state?.sync.syncing, syncBusy, loadState]);

  const applyUpdate = useCallback(
    async (payload: PricingUpdateInput): Promise<PricingState> => {
      if (mutationInFlightRef.current) {
        throw new Error(copy.saveFailed);
      }
      mutationInFlightRef.current = true;
      setMutating(true);
      try {
        const next = await client.rpc(pricingUpdateRpc, payload);
        if (mountedRef.current) {
          setState(next);
          setRateInput(String(next.usdToCnyRate));
          setRateError("");
        }
        onUpdated?.(next);
        return next;
      } finally {
        mutationInFlightRef.current = false;
        if (mountedRef.current) {
          setMutating(false);
        }
      }
    },
    [client, copy.saveFailed, onUpdated],
  );

  const focusTarget = useMemo(() => resolveFocusTarget(focusModel, state), [focusModel, state]);

  useEffect(() => {
    if (!visible || !state) return;
    const token = `${openSessionRef.current}:${focusModel ?? ""}`;
    if (appliedFocusTokenRef.current === token) return;
    appliedFocusTokenRef.current = token;
    if (focusTarget.key) {
      setExpandedKey(focusTarget.key);
      setStatusFilter("all");
      setSearchQuery("");
      fallbackScrollRef.current?.scrollTo({ y: 0, animated: false });
    }
  }, [visible, state, focusModel, focusTarget.key]);

  const displayCurrency: Currency = state?.displayCurrency ?? "USD";
  const currentRate = state?.usdToCnyRate ?? DEFAULT_USD_TO_CNY_RATE;
  const parsedDraftRate = parseExchangeRateInput(rateInput);
  const rateDirty = state !== null && rateInput.trim() !== String(state.usdToCnyRate);
  const previewRate = parsedDraftRate ?? currentRate;

  const allRows = useMemo(() => {
    if (!state) return [];
    const base = focusTarget.syntheticRow
      ? [focusTarget.syntheticRow, ...state.models]
      : [...state.models];

    if (!focusTarget.key) return base;

    // Promote the focused model to the top of the list so it is immediately in view.
    const index = base.findIndex((row) => row.key === focusTarget.key);
    if (index <= 0) return base;
    const [focused] = base.splice(index, 1);
    return focused ? [focused, ...base] : base;
  }, [state, focusTarget]);

  const customCount = useMemo(
    () => (state ? Object.keys(state.overrides).length : 0),
    [state],
  );
  const syncedCount = useMemo(
    () => allRows.filter((row) => row.synced !== null).length,
    [allRows],
  );
  const hasActiveRows = useMemo(
    () => allRows.some((row) => row.seenLocally || row.custom !== null),
    [allRows],
  );
  const hasSyncedRows = useMemo(
    () => allRows.some((row) => row.source === "synced" || row.synced !== null),
    [allRows],
  );
  const hasUnpricedRows = useMemo(
    () => allRows.some((row) => row.effective === null),
    [allRows],
  );

  const displayCurrencyOptions = useMemo(
    () => CURRENCY_OPTIONS.map((option) => ({ ...option, disabled: !state || mutating })),
    [state, mutating],
  );

  const filterOptions = useMemo(() => {
    const opts: { readonly value: StatusFilter; readonly label: string }[] = [
      { value: "all", label: copy.filterAll },
    ];
    if (hasActiveRows) opts.push({ value: "active", label: copy.filterActive });
    if (hasSyncedRows) opts.push({ value: "synced", label: copy.filterSynced });
    if (hasUnpricedRows) opts.push({ value: "unpriced", label: copy.filterUnpriced });
    return opts;
  }, [
    copy.filterActive,
    copy.filterAll,
    copy.filterSynced,
    copy.filterUnpriced,
    hasActiveRows,
    hasSyncedRows,
    hasUnpricedRows,
  ]);

  const effectiveFilter: StatusFilter = filterOptions.some((opt) => opt.value === statusFilter)
    ? statusFilter
    : "all";

  const visibleRows = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return allRows.filter((row) => {
      if (effectiveFilter === "active" && !row.seenLocally && row.custom === null) return false;
      if (effectiveFilter === "synced" && row.synced === null) return false;
      if (effectiveFilter === "unpriced" && row.effective !== null) return false;
      return matchesSearch(row, normalizedQuery);
    });
  }, [allRows, effectiveFilter, searchQuery]);

  const trimmedSearch = searchQuery.trim();
  const canCollapseList =
    trimmedSearch.length === 0 && !showAllRows && visibleRows.length > INITIAL_VISIBLE_ROWS;
  const renderedRows = canCollapseList ? visibleRows.slice(0, INITIAL_VISIBLE_ROWS) : visibleRows;

  const handleSyncNow = async () => {
    if (!state || mutating || syncBusy || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setMutating(true);
    setSyncBusy(true);
    try {
      const next = await client.rpc(pricingSyncRpc, { force: true });
      if (mountedRef.current) {
        setState(next);
        setRateInput(String(next.usdToCnyRate));
        setRateError("");
      }
      onUpdated?.(next);
      if (next.sync.lastError) {
        toast.error(copy.syncFailedToast(next.sync.lastError));
      } else {
        toast.show(copy.syncSuccessToast(integer(next.sync.modelCount, locale)), {
          variant: "success",
        });
      }
    } catch (reason) {
      toast.error(copy.syncFailedToast(errorMessage(reason, copy.saveFailed)));
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) {
        setSyncBusy(false);
        setMutating(false);
      }
    }
  };

  const handleToggleAutoSync = async () => {
    if (!state || mutating || syncBusy) return;
    const nextEnabled = !state.autoSync;
    try {
      await applyUpdate({ autoSync: nextEnabled });
      toast.show(copy.autoSyncSavedToast(nextEnabled), { variant: "success" });
    } catch (reason) {
      toast.error(errorMessage(reason, copy.saveFailed));
    }
  };

  const handleCurrencyChange = async (nextCurrency: Currency) => {
    if (!state || nextCurrency === state.displayCurrency || mutating) return;
    setRateError("");
    try {
      await applyUpdate({ displayCurrency: nextCurrency });
      toast.show(copy.currencySaved(nextCurrency), { variant: "success" });
    } catch (reason) {
      const msg = errorMessage(reason, copy.saveFailed);
      setRateError(msg);
      toast.error(msg);
    }
  };

  const handleSaveRate = async (overrideRate?: number) => {
    if (!state || mutating) return;
    const candidate = overrideRate ?? parseExchangeRateInput(rateInput);
    if (candidate === null) {
      setRateError(copy.invalidExchangeRate(MIN_USD_TO_CNY_RATE, MAX_USD_TO_CNY_RATE));
      return;
    }
    setRateBusy(true);
    setRateError("");
    try {
      await applyUpdate({ usdToCnyRate: candidate });
      toast.show(copy.exchangeRateSaved, { variant: "success" });
    } catch (reason) {
      const msg = errorMessage(reason, copy.saveFailed);
      setRateError(msg);
      toast.error(msg);
    } finally {
      setRateBusy(false);
    }
  };

  const handleOpenAddForm = () => {
    setNewKey("");
    setNewDraft(draftFromRates(null, displayCurrency));
    setAddError("");
    setConfirmResetAll(false);
    setAdding(true);
  };

  const handleSubmitNew = async () => {
    if (mutating) return;
    const key = normalizeModelKey(newKey);
    if (!key || key.length > MAX_MODEL_KEY_LENGTH) {
      setAddError(copy.invalidModelKey);
      return;
    }
    const validated = validateRateDraft(newDraft, copy);
    if (!validated.ok) {
      setAddError(validated.error);
      return;
    }
    setAddBusy(true);
    setAddError("");
    try {
      await applyUpdate({ key, rates: validated.rates });
      setAdding(false);
      setNewKey("");
      setExpandedKey(null);
      toast.show(copy.savedToast, { variant: "success" });
    } catch (reason) {
      setAddError(errorMessage(reason, copy.saveFailed));
    } finally {
      setAddBusy(false);
    }
  };

  const handleResetAllOverrides = async () => {
    if (mutating) return;
    setResetAllBusy(true);
    try {
      await applyUpdate({ resetOverrides: true });
      setConfirmResetAll(false);
      setExpandedKey(null);
      toast.show(copy.resetAllToast, { variant: "success" });
    } catch (reason) {
      toast.error(errorMessage(reason, copy.saveFailed));
    } finally {
      setResetAllBusy(false);
    }
  };

  if (!modalOpen) return null;

  const usdOnePreview = money(previewRate, "CNY", locale);
  const cnyTenPreview = money(10 / previewRate, "USD", locale);
  const syncStatus = state?.sync ?? null;
  const syncActive = syncBusy || Boolean(syncStatus?.syncing);
  const syncBadge = syncActive
    ? { label: copy.syncBadgeSyncing, tone: "accent" as const, dot: true }
    : syncStatus?.lastError
      ? syncStatus.syncedAt
        ? { label: copy.syncBadgeCachedError, tone: "warning" as const, dot: true }
        : { label: copy.syncBadgeError, tone: "danger" as const, dot: true }
      : syncStatus?.syncedAt && syncStatus.modelCount > 0
        ? { label: copy.syncBadgeSynced, tone: "success" as const, dot: true }
        : { label: copy.syncBadgeNever, tone: "neutral" as const, dot: false };
  const syncRelativeTime = syncStatus?.syncedAt
    ? relative(syncStatus.syncedAt, Date.now(), locale) || syncStatus.syncedAt
    : "";
  const syncCaption = syncStatus
    ? syncStatus.syncedAt && syncStatus.modelCount > 0
      ? copy.syncSummarySynced(
          syncStatus.source,
          integer(syncStatus.modelCount, locale),
          syncRelativeTime,
        )
      : copy.syncSummaryNever(syncStatus.source)
    : copy.syncSummaryNever(DEFAULT_PRICING_SYNC_SOURCE);

  const body = (
    <View
      onLayout={(event) => {
        const measured = event.nativeEvent.layout.width;
        setBodyWidth((prev) => (Math.abs(prev - measured) < 1 ? prev : measured));
      }}
      style={{ gap: space.lg }}
    >
      <Muted colors={colors}>{copy.subtitle}</Muted>

      {/* Official API Pricing Sync strip (models.dev) */}
      <Card colors={colors} style={{ padding: space.md, gap: space.sm + 2 }}>
        <View
          style={{
            flexDirection: narrow ? "column" : "row",
            alignItems: narrow ? "flex-start" : "center",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexWrap: "wrap",
                gap: space.xs + 2,
              }}
            >
              <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>
                {copy.syncTitle}
              </Text>
              <Badge
                colors={colors}
                tone={syncBadge.tone}
                dot={syncBadge.dot}
                label={syncBadge.label}
              />
            </View>
            <Muted colors={colors} small>
              {syncCaption}
            </Muted>
          </View>

          <Button
            colors={colors}
            size="sm"
            variant="secondary"
            icon="RefreshCw"
            label={syncActive ? copy.syncingAction : copy.syncAction}
            loading={syncActive}
            disabled={!state || mutating || syncActive}
            onPress={() => void handleSyncNow()}
          />
        </View>

        {syncStatus?.lastError ? (
          <Callout
            colors={colors}
            tone={syncStatus.syncedAt ? "warning" : "danger"}
            icon="CircleAlert"
            title={copy.syncErrorFallbackNote(syncStatus.lastError)}
          />
        ) : null}

        <Divider colors={colors} />

        <Pressable
          accessibilityRole="switch"
          accessibilityState={{
            checked: Boolean(state?.autoSync ?? true),
            disabled: !state || mutating || syncActive,
          }}
          accessibilityLabel={copy.syncAutoLabel}
          disabled={!state || mutating || syncActive}
          onPress={() => void handleToggleAutoSync()}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
            opacity: !state || mutating || syncActive ? 0.55 : 1,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>
              {copy.syncAutoLabel}
            </Text>
            <Muted colors={colors} small>
              {copy.syncAutoHint}
            </Muted>
          </View>
          <View
            style={{
              width: 36,
              height: 20,
              borderRadius: radius.pill,
              padding: 2,
              justifyContent: "center",
              backgroundColor:
                (state?.autoSync ?? true) ? colors.accent : tint(colors.foreground, 0.18),
              alignItems: (state?.autoSync ?? true) ? "flex-end" : "flex-start",
            }}
          >
            <View
              style={{
                width: 16,
                height: 16,
                borderRadius: radius.pill,
                backgroundColor: colors.surface0,
              }}
            />
          </View>
        </Pressable>
      </Card>

      {/* Currency & USD -> CNY exchange rate controls */}
      <Card colors={colors} style={{ padding: space.md, gap: space.md }}>
        <View
          style={{
            flexDirection: narrow ? "column" : "row",
            alignItems: narrow ? "flex-start" : "center",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>
              {copy.displayCurrency}
            </Text>
            <Muted colors={colors} small>
              {copy.displayCurrencyHint}
            </Muted>
          </View>
          <SegmentedControl<Currency>
            colors={colors}
            value={displayCurrency}
            options={displayCurrencyOptions}
            onChange={(next) => void handleCurrencyChange(next)}
          />
        </View>

        <Divider colors={colors} />

        <View style={{ gap: space.sm }}>
          <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>
            {copy.exchangeRate}
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: space.sm,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.xs + 2,
              }}
            >
              <Text style={{ ...font.small, ...tabular, color: colors.foregroundMuted }}>
                {copy.exchangeRateUnitPrefix}
              </Text>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  backgroundColor: colors.surface0,
                  borderWidth: 1,
                  borderColor: rateError ? colors.statusDanger : colors.border,
                  borderRadius: radius.sm,
                  paddingHorizontal: space.sm,
                  width: 96,
                  minHeight: 32,
                }}
              >
                <Text style={{ ...font.small, color: colors.foregroundMuted, marginRight: 2 }}>
                  ¥
                </Text>
                <SafeTextInput
                  accessibilityLabel={copy.exchangeRate}
                  keyboardType={numericKeyboardType()}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={rateInput}
                  editable={!mutating && state !== null}
                  onChangeText={(text) => {
                    setRateInput(text);
                    if (rateError) setRateError("");
                  }}
                  onSubmitEditing={() => {
                    if (rateDirty) void handleSaveRate();
                  }}
                  placeholder={String(DEFAULT_USD_TO_CNY_RATE)}
                  placeholderTextColor={tint(colors.foregroundMuted, 0.55)}
                  style={{
                    ...font.small,
                    ...tabular,
                    flex: 1,
                    minWidth: 0,
                    color: colors.foreground,
                    paddingVertical: 4,
                  }}
                />
              </View>
              <Text style={{ ...font.small, color: colors.foregroundMuted }}>
                {copy.exchangeRateUnitSuffix}
              </Text>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
              <Button
                colors={colors}
                size="sm"
                variant="primary"
                label={copy.saveRate}
                loading={rateBusy}
                disabled={!rateDirty || (mutating && !rateBusy)}
                onPress={() => void handleSaveRate()}
              />
              {state && state.usdToCnyRate !== DEFAULT_USD_TO_CNY_RATE ? (
                <Button
                  colors={colors}
                  size="sm"
                  variant="ghost"
                  label={copy.resetRate(DEFAULT_USD_TO_CNY_RATE)}
                  disabled={mutating}
                  onPress={() => void handleSaveRate(DEFAULT_USD_TO_CNY_RATE)}
                />
              ) : null}
            </View>
          </View>

          <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
            {copy.exchangeRatePreview(usdOnePreview, cnyTenPreview)}
          </Text>

          {rateError ? (
            <Callout colors={colors} tone="danger" icon="CircleAlert" title={rateError} />
          ) : null}
        </View>
      </Card>

      {/* Model list header + filter controls */}
      <View style={{ gap: space.sm }}>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.xs,
          }}
        >
          <View style={{ gap: 2 }}>
            <Text style={{ ...font.heading, color: colors.foreground }}>{copy.modelsHeading}</Text>
            {state ? (
              <Muted colors={colors} small>
                {copy.modelsCount(allRows.length, syncedCount, customCount)}
              </Muted>
            ) : null}
          </View>
          <Button
            colors={colors}
            size="sm"
            variant="ghost"
            icon="RefreshCw"
            label={copy.refresh}
            loading={loading && state !== null}
            disabled={loading || mutating}
            onPress={() => void loadState()}
          />
        </View>

        {state ? (
          <View
            style={{
              flexDirection: narrow ? "column" : "row",
              alignItems: narrow ? "stretch" : "center",
              gap: space.sm,
            }}
          >
            <View
              style={{
                flex: narrow ? undefined : 1,
                flexDirection: "row",
                alignItems: "center",
                gap: space.xs,
                backgroundColor: colors.surface0,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.md,
                paddingHorizontal: space.sm,
                minHeight: 34,
              }}
            >
              <SafeIcon name="Search" size={14} color={colors.foregroundMuted} />
              <SafeTextInput
                accessibilityLabel={copy.searchPlaceholder}
                autoCapitalize="none"
                autoCorrect={false}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={copy.searchPlaceholder}
                placeholderTextColor={tint(colors.foregroundMuted, 0.6)}
                style={{
                  ...font.small,
                  flex: 1,
                  minWidth: 0,
                  color: colors.foreground,
                  paddingVertical: 5,
                }}
              />
              {searchQuery ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.clearSearch}
                  hitSlop={6}
                  onPress={() => setSearchQuery("")}
                >
                  <SafeIcon name="X" size={14} color={colors.foregroundMuted} />
                </Pressable>
              ) : null}
            </View>

            {filterOptions.length > 1 ? (
              <SegmentedControl<StatusFilter>
                colors={colors}
                value={effectiveFilter}
                options={filterOptions}
                onChange={(next) => setStatusFilter(next)}
              />
            ) : null}
          </View>
        ) : null}

        {loading && !state ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: space.sm,
              paddingVertical: space.xl,
            }}
          >
            <ActivityIndicator size="small" color={colors.accent} />
            <Muted colors={colors}>{copy.loading}</Muted>
          </View>
        ) : loadError && !state ? (
          <Callout
            colors={colors}
            tone="danger"
            icon="CircleAlert"
            title={loadError}
            action={
              <Button
                colors={colors}
                size="sm"
                variant="secondary"
                icon="RefreshCw"
                label={copy.retry}
                onPress={() => void loadState()}
              />
            }
          />
        ) : visibleRows.length === 0 ? (
          <Muted colors={colors} style={{ paddingVertical: space.md }}>
            {copy.emptyMatches}
          </Muted>
        ) : (
          <View style={{ gap: space.sm }}>
            {loadError ? (
              <Callout colors={colors} tone="danger" icon="CircleAlert" title={loadError} />
            ) : null}
            {renderedRows.map((row) => (
              <PricingModelRowCard
                key={row.key}
                colors={colors}
                copy={copy}
                locale={locale}
                row={row}
                displayCurrency={displayCurrency}
                usdToCnyRate={currentRate}
                expanded={expandedKey === row.key}
                focused={focusTarget.key === row.key}
                narrow={narrow}
                globalBusy={mutating}
                onToggle={() =>
                  setExpandedKey((current) => (current === row.key ? null : row.key))
                }
                onSave={async (rates) => {
                  await applyUpdate({ key: row.key, rates });
                  setExpandedKey(null);
                  toast.show(copy.savedToast, { variant: "success" });
                }}
                onReset={async () => {
                  await applyUpdate({ key: row.key, rates: null });
                  setExpandedKey(null);
                  toast.show(copy.resetOneToast, { variant: "success" });
                }}
              />
            ))}
            {canCollapseList ? (
              <View style={{ alignItems: "center", paddingTop: space.xs }}>
                <Button
                  colors={colors}
                  size="sm"
                  variant="secondary"
                  label={copy.showAllModels(visibleRows.length)}
                  onPress={() => setShowAllRows(true)}
                />
              </View>
            ) : null}
          </View>
        )}
      </View>

      <Divider colors={colors} />

      {/* Inline confirmation for resetting all custom overrides (avoids nested native modals) */}
      {confirmResetAll ? (
        <Callout
          colors={colors}
          tone="warning"
          icon="TriangleAlert"
          title={copy.resetAllConfirmTitle}
          action={
            <>
              <Button
                colors={colors}
                size="sm"
                variant="ghost"
                label={copy.cancel}
                disabled={resetAllBusy}
                onPress={() => setConfirmResetAll(false)}
              />
              <Button
                colors={colors}
                size="sm"
                variant="danger"
                icon="RotateCcw"
                label={copy.confirmReset}
                loading={resetAllBusy}
                onPress={() => void handleResetAllOverrides()}
              />
            </>
          }
        >
          <Muted colors={colors} small>
            {copy.resetAllConfirmBody(customCount)}
          </Muted>
        </Callout>
      ) : null}

      {/* Add custom model form or default footer actions */}
      {adding ? (
        <Card colors={colors} style={{ padding: space.md, gap: space.md }}>
          <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>
            {copy.addModelTitle}
          </Text>
          <View style={{ gap: space.xs }}>
            <Text style={{ ...font.caption, color: colors.foregroundMuted }}>
              {copy.modelKeyLabel}
            </Text>
            <SafeTextInput
              accessibilityLabel={copy.modelKeyLabel}
              autoCapitalize="none"
              autoCorrect={false}
              value={newKey}
              editable={!addBusy && !mutating}
              onChangeText={(text) => {
                setNewKey(text);
                if (addError) setAddError("");
              }}
              placeholder={copy.modelKeyPlaceholder}
              placeholderTextColor={tint(colors.foregroundMuted, 0.6)}
              style={{
                ...font.small,
                fontFamily: mono,
                color: colors.foreground,
                backgroundColor: colors.surface0,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.sm,
                paddingHorizontal: space.sm,
                paddingVertical: 7,
              }}
            />
          </View>

          <RateFieldsEditor
            colors={colors}
            copy={copy}
            locale={locale}
            draft={newDraft}
            displayCurrency={displayCurrency}
            usdToCnyRate={currentRate}
            defaultLongThreshold={DEFAULT_LONG_CONTEXT_THRESHOLD}
            disabled={addBusy || mutating}
            narrow={narrow}
            onChange={(next) => {
              setNewDraft(next);
              if (addError) setAddError("");
            }}
          />

          {addError ? (
            <Callout colors={colors} tone="danger" icon="CircleAlert" title={addError} />
          ) : null}

          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
            <Button
              colors={colors}
              size="sm"
              variant="ghost"
              label={copy.cancel}
              disabled={addBusy}
              onPress={() => {
                setAdding(false);
                setAddError("");
              }}
            />
            <Button
              colors={colors}
              size="sm"
              variant="primary"
              icon="Check"
              label={copy.save}
              loading={addBusy}
              disabled={mutating && !addBusy}
              onPress={() => void handleSubmitNew()}
            />
          </View>
        </Card>
      ) : (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: space.sm,
          }}
        >
          <Button
            colors={colors}
            size="sm"
            variant="secondary"
            icon="Plus"
            label={copy.addModel}
            disabled={!state || mutating}
            onPress={handleOpenAddForm}
          />
          {state?.hasCustomOverrides ? (
            <Button
              colors={colors}
              size="sm"
              variant="ghost"
              icon="RotateCcw"
              label={copy.resetAllOverrides}
              disabled={mutating || confirmResetAll}
              onPress={() => setConfirmResetAll(true)}
            />
          ) : null}
          <View style={{ flex: 1, minWidth: space.sm }} />
          <Button
            colors={colors}
            size="sm"
            variant="ghost"
            label={copy.close}
            disabled={mutating}
            onPress={onClose}
          />
        </View>
      )}
    </View>
  );

  if (HAS_HOST_MODAL) {
    return (
      <HostModal
        open={modalOpen}
        title={copy.title}
        icon={<SafeIcon name="Coins" size={18} color={colors.accent} />}
        onOpenChange={(open) => {
          if (!open && !mutating) onClose();
        }}
      >
        <HostModal.Content>{body}</HostModal.Content>
      </HostModal>
    );
  }

  // Fallback presentation for Paseo 0.16.x hosts without `@getpaseo/plugin/client/ui` `Modal`.
  return (
    <RNModal
      visible={modalOpen}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!mutating) onClose();
      }}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: "rgba(0, 0, 0, 0.48)",
          justifyContent: "center",
          alignItems: "center",
          padding: space.lg,
        }}
      >
        <Card
          colors={colors}
          elevated
          style={{
            width: "100%",
            maxWidth: 680,
            maxHeight: "88%",
            backgroundColor: colors.surface0,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.sm,
              paddingHorizontal: space.lg,
              paddingVertical: space.md,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flex: 1, minWidth: 0 }}>
              <SafeIcon name="Coins" size={18} color={colors.accent} />
              <Text
                numberOfLines={1}
                style={{ ...font.heading, color: colors.foreground, flexShrink: 1 }}
              >
                {copy.title}
              </Text>
            </View>
            <Button
              colors={colors}
              size="sm"
              variant="ghost"
              icon="X"
              accessibilityLabel={copy.close}
              disabled={mutating}
              onPress={onClose}
            />
          </View>
          <SafeScrollView
            ref={fallbackScrollRef}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: space.lg }}
          >
            {body}
          </SafeScrollView>
        </Card>
      </View>
    </RNModal>
  );
}
