import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Shared wire contracts, schemas, and pure aggregation helpers for DSH usage
 * analytics (`dsh.usage.stats` and `dsh.usage.daily`).
 *
 * Kept strictly dependency-free (only `@getpaseo/plugin` + `zod`) so both the
 * server engine (`server/usage-stats.ts`) and React Native / Hermes client
 * components can import it without pulling Node built-ins into the client bundle.
 */

/** Local calendar days covered by the activity heatmap: 53 full weeks. */
export const DAILY_HISTORY_DAYS = 371;

/** Upper clamp for time-to-first-token (seconds) to exclude stalled/idle pauses. */
export const USAGE_MAX_TTFT_SECONDS = 300;

/** Upper output speed threshold (tok/s) matching `server/session.ts` burst filter. */
export const USAGE_MAX_TPS = 3000;

/** Fallback USD -> CNY exchange rate when no pricer config overrides it. */
export const DEFAULT_USD_TO_CNY_RATE = 7.2;

export const USAGE_RANGES = ["today", "7d", "30d"] as const;
export const usageRangeSchema = z.enum(USAGE_RANGES);
export type UsageRange = z.infer<typeof usageRangeSchema>;

export const USAGE_SCOPES = ["all", "main", "subagent"] as const;
export const usageScopeSchema = z.enum(USAGE_SCOPES);
export type UsageScope = z.infer<typeof usageScopeSchema>;

export const USAGE_CURRENCIES = ["USD", "CNY"] as const;
export const usageCurrencySchema = z.enum(USAGE_CURRENCIES);
export type UsageCurrency = z.infer<typeof usageCurrencySchema>;

export const usageIndexingSchema = z.object({
  active: z.boolean(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type UsageIndexingStatus = z.infer<typeof usageIndexingSchema>;

/**
 * Raw token, timing, and converted cost sums for a bucket, model, provider, or
 * total window. Ratios (TPS, cache hit rate, average TTFT) are derived cleanly
 * from these additive sums via {@link deriveUsageMetrics}.
 */
export const usageTotalsSchema = z.object({
  requests: z.number().int().nonnegative(),
  /** Fresh non-cached input tokens (`usage.inputTokens`). */
  input: z.number().nonnegative(),
  /** Cache-read input tokens (`usage.cacheReadTokens`). */
  cached: z.number().nonnegative(),
  /** Cache-write input tokens (`usage.cacheWriteTokens`). */
  cacheWrite: z.number().nonnegative(),
  /** Output tokens including reasoning and tool-call arguments (`usage.outputTokens`). */
  output: z.number().nonnegative(),
  /** Total tokens (`input + cached + cacheWrite + output`). */
  totalTokens: z.number().nonnegative(),
  /** Sum of valid generation durations in seconds (bursts > 3000 tok/s excluded). */
  generationSeconds: z.number().nonnegative(),
  /** Output tokens belonging to calls with valid `generationSeconds` (TPS = generationOutput / generationSeconds). */
  generationOutput: z.number().nonnegative(),
  /** Sum of clamped TTFT latencies in seconds (`0..300s`) across measured calls. */
  firstTokenSeconds: z.number().nonnegative(),
  /** Count of calls with a measured TTFT (average TTFT = firstTokenSeconds / firstTokenRequests). */
  firstTokenRequests: z.number().int().nonnegative(),
  /** Estimated cost converted into `displayCurrency` across `pricedRequests`. */
  cost: z.number().nonnegative(),
  /** Number of requests that matched an effective price (custom override or built-in reference). */
  pricedRequests: z.number().int().nonnegative(),
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;

export const usageBinSchema = usageTotalsSchema.extend({
  /** Inclusive bucket start timestamp (ms since epoch). */
  start: z.number(),
  /** Exclusive bucket end timestamp (ms since epoch). */
  end: z.number(),
});
export type UsageBin = z.infer<typeof usageBinSchema>;

/** Pre-aligned per-bucket sparkline series for each of the 6 KPI tiles. */
export const usageSparklinesSchema = z.object({
  tokens: z.array(z.number().nonnegative()),
  cost: z.array(z.number().nonnegative().nullable()),
  requests: z.array(z.number().int().nonnegative()),
  tps: z.array(z.number().nonnegative().nullable()),
  cacheHitRate: z.array(z.number().min(0).max(1).nullable()),
  firstTokenSec: z.array(z.number().nonnegative().nullable()),
});
export type UsageSparklines = z.infer<typeof usageSparklinesSchema>;

/** Provider routing chip entry (requests, tokens, and converted cost per provider). */
export const usageProviderRowSchema = usageTotalsSchema.extend({
  provider: z.string(),
  sessions: z.number().int().nonnegative(),
});
export type UsageProviderRow = z.infer<typeof usageProviderRowSchema>;

export const usageModelPricedStateSchema = z.enum(["full", "partial", "none"]);
export type UsageModelPricedState = z.infer<typeof usageModelPricedStateSchema>;

/** One row in the 8-column sortable model breakdown table. */
export const usageModelRowSchema = usageTotalsSchema.extend({
  /** Stable composite key (`${provider}/${model}`). */
  id: z.string(),
  provider: z.string(),
  model: z.string(),
  /** Display label (`model` name; pair with `provider` in UI when multiple providers exist). */
  label: z.string(),
  /** Canonical pricing lookup key used to open or focus the pricing editor. */
  pricingKey: z.string(),
  sessions: z.number().int().nonnegative(),
  /** Token share `0..1` relative to the current model breakdown table. */
  share: z.number().min(0).max(1),
  /** Whether all, some, or none of this row's requests had an effective price. */
  priced: usageModelPricedStateSchema,
  /** Derived output speed (tok/s), or null when no valid decode window was recorded. */
  tps: z.number().nonnegative().nullable(),
  /** Derived prompt cache hit ratio (`0..1`), or null when prompt tokens are 0. */
  cacheHitRate: z.number().min(0).max(1).nullable(),
  /** Derived mean time-to-first-token (seconds), or null when unmeasured. */
  firstTokenSec: z.number().nonnegative().nullable(),
});
export type UsageModelRow = z.infer<typeof usageModelRowSchema>;

/**
 * Accept legacy `"24h"` on RPC input during live plugin reload transitions and
 * normalize it to `"today"`, while keeping `UsageRange` strictly `"today" | "7d" | "30d"`.
 */
const usageStatsRangeInputSchema = z.preprocess(
  (value) => (value === "24h" ? "today" : value),
  usageRangeSchema,
);

export const usageStatsInputSchema = z
  .object({
    range: usageStatsRangeInputSchema,
    scope: usageScopeSchema.optional(),
    provider: z.string().min(1).max(120).optional(),
    model: z.string().min(1).max(240).optional(),
    currency: usageCurrencySchema.optional(),
  })
  .strict();
export type UsageStatsInput = z.infer<typeof usageStatsInputSchema>;

export const usageStatsSchema = z.object({
  range: usageRangeSchema,
  scope: usageScopeSchema,
  /** Nominal bin duration in ms (DST days can be 23h or 25h; each bin carries exact start/end). */
  binMs: z.number().int().positive(),
  /** Time-bucketed full-metric series for the interactive chart and hover tooltips. */
  bins: z.array(usageBinSchema),
  /** Aligned sparkline values for the 6 KPI tiles. */
  sparklines: usageSparklinesSchema,
  totals: usageTotalsSchema,
  /** Main vs subagent split within the selected range and provider (before scope/model filter). */
  breakdown: z.object({
    main: usageTotalsSchema,
    subagent: usageTotalsSchema,
  }),
  /** True when subagent calls exist in indexed history so the UI should render the scope selector. */
  hasSubagents: z.boolean(),
  /** Provider routing chips within the selected range and scope (before provider/model filter). */
  providers: z.array(usageProviderRowSchema),
  /** Per-(provider, model) rows within the selected range, provider, and scope (before model filter). */
  models: z.array(usageModelRowSchema),
  /** Distinct session count matching the active filters. */
  sessions: z.number().int().nonnegative(),
  displayCurrency: usageCurrencySchema,
  usdToCnyRate: z.number().positive(),
  hasCustomPricing: z.boolean(),
  indexing: usageIndexingSchema,
  generatedAt: z.string(),
});
export type UsageStats = z.infer<typeof usageStatsSchema>;

export const usageDayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type UsageDayKey = z.infer<typeof usageDayKeySchema>;

export const usageDaySchema = usageTotalsSchema.extend({
  date: usageDayKeySchema,
});
export type UsageDay = z.infer<typeof usageDaySchema>;

export const usageDailyMaxDaySchema = z.object({
  date: usageDayKeySchema,
  tokens: z.number().nonnegative(),
  requests: z.number().int().nonnegative(),
  cost: z.number().nonnegative().nullable(),
});
export type UsageDailyMaxDay = z.infer<typeof usageDailyMaxDaySchema>;

export const usageDailySummarySchema = z.object({
  totalTokens: z.number().nonnegative(),
  totalRequests: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative().nullable(),
  pricedRequests: z.number().int().nonnegative(),
  activeDays: z.number().int().nonnegative(),
  maxDay: usageDailyMaxDaySchema.nullable(),
  activeDailyAvgTokens: z.number().nonnegative(),
  streak: z.number().int().nonnegative(),
});
export type UsageDailySummary = z.infer<typeof usageDailySummarySchema>;

export const usageDailyInputSchema = z
  .object({
    scope: usageScopeSchema.optional(),
    provider: z.string().min(1).max(120).optional(),
    model: z.string().min(1).max(240).optional(),
    currency: usageCurrencySchema.optional(),
  })
  .strict();
export type UsageDailyInput = z.infer<typeof usageDailyInputSchema>;

export const usageDailySchema = z.object({
  /** Today in the daemon's local calendar (`YYYY-MM-DD`). */
  today: usageDayKeySchema,
  /** Sparse active days in the last `DAILY_HISTORY_DAYS` (371) days, oldest first. */
  days: z.array(usageDaySchema),
  /** Full-window heatmap summary (active days, busiest day, active daily average, streak). */
  summary: usageDailySummarySchema,
  hasSubagents: z.boolean(),
  displayCurrency: usageCurrencySchema,
  usdToCnyRate: z.number().positive(),
  indexing: usageIndexingSchema,
  generatedAt: z.string(),
});
export type UsageDaily = z.infer<typeof usageDailySchema>;

/** Time-windowed usage analytics RPC (`today` / `7d` / `30d`). */
export const usageStatsRpc = defineRpc({
  name: "dsh.usage.stats",
  input: usageStatsInputSchema,
  output: usageStatsSchema,
});

/** 53-week (371-day) daily rollup RPC for the activity heatmap. */
export const usageDailyRpc = defineRpc({
  name: "dsh.usage.daily",
  input: usageDailyInputSchema,
  output: usageDailySchema,
});

// ---- Structural Pricing Interface ------------------------------------------

/** Token counts for one model call; structurally identical to `shared/pricing.ts`'s `TokenUsageInput`. */
export interface UsageTokenInput {
  input: number;
  cached: number;
  cacheWrite?: number;
  output: number;
}

/** Input to `UsagePricer.priceCall`; structurally identical to `shared/pricing.ts`'s `PricingCallInput`. */
export interface UsagePriceCallInput {
  model: string;
  provider?: string | null;
  tokens: UsageTokenInput;
}

/** Result of `UsagePricer.priceCall`; structurally compatible with `shared/pricing.ts`'s `CallCostResult`. */
export interface UsagePriceResult {
  /** True when the call matched an effective rate (override or reference table). */
  priced: boolean;
  /** Cost in the matched rate's native currency, or null when unpriced. */
  nativeCost: number | null;
  /** Native currency of the matched rate, or null when unpriced. */
  nativeCurrency: UsageCurrency | null;
  /** Cost converted into `displayCurrency`, or null when unpriced. */
  cost: number | null;
  /** Currency that `cost` is denominated in. */
  displayCurrency: UsageCurrency;
  /** Canonical pricing lookup key for this model. */
  pricingKey: string;
}

/**
 * Structural pricing resolver consumed by `UsageStatsEngine`.
 *
 * Matches `PricingResolver` from `shared/pricing.ts` 1:1 so `server/pricing.ts`
 * plugs directly in without wrapper boilerplate or circular imports.
 */
export interface UsagePricer {
  readonly displayCurrency: UsageCurrency;
  readonly usdToCnyRate: number;
  readonly hasCustomPricing: boolean;
  resolveKey?(model: string, provider?: string | null): string;
  priceCall(input: UsagePriceCallInput): UsagePriceResult;
}

/**
 * Any pricing source accepted by `UsageStatsEngine`:
 * - a static `UsagePricer` (`PricingResolver`),
 * - an async/sync factory `() => UsagePricer | Promise<UsagePricer>`, or
 * - a store exposing `resolver(): UsagePricer | Promise<UsagePricer>` (matches `PricingStore` in `server/pricing.ts`).
 */
export type UsagePricerSource =
  | UsagePricer
  | (() => UsagePricer | Promise<UsagePricer>)
  | { resolver(): UsagePricer | Promise<UsagePricer> };

/** Normalize a raw model identifier into a fallback pricing key. */
export function normalizeUsagePricingKey(model: string): string {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return "unknown";
  const slash = trimmed.lastIndexOf("/");
  const stripped = slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
  return stripped || trimmed;
}

/** Convert an amount between USD and CNY using `usdToCnyRate`. */
export function convertUsageCurrency(
  amount: number,
  from: UsageCurrency,
  to: UsageCurrency,
  usdToCnyRate: number,
): number {
  if (from === to) return amount;
  const rate = Number.isFinite(usdToCnyRate) && usdToCnyRate > 0 ? usdToCnyRate : DEFAULT_USD_TO_CNY_RATE;
  return from === "USD" ? amount * rate : amount / rate;
}

/** Default pricer used when no pricing engine is attached: marks every call unpriced. */
export const UNPRICED_PRICER: UsagePricer = {
  displayCurrency: "USD",
  usdToCnyRate: DEFAULT_USD_TO_CNY_RATE,
  hasCustomPricing: false,
  resolveKey(model: string): string {
    return normalizeUsagePricingKey(model);
  },
  priceCall(input: UsagePriceCallInput): UsagePriceResult {
    return {
      priced: false,
      nativeCost: null,
      nativeCurrency: null,
      cost: null,
      displayCurrency: "USD",
      pricingKey: normalizeUsagePricingKey(input.model),
    };
  },
};

// ---- Pure Aggregation Helpers ----------------------------------------------

export function emptyUsageTotals(): UsageTotals {
  return {
    requests: 0,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    totalTokens: 0,
    generationSeconds: 0,
    generationOutput: 0,
    firstTokenSeconds: 0,
    firstTokenRequests: 0,
    cost: 0,
    pricedRequests: 0,
  };
}

export interface DerivedUsageMetrics {
  requests: number;
  promptTokens: number;
  totalTokens: number;
  cost: number | null;
  costPerRequest: number | null;
  tps: number | null;
  cacheHitRate: number | null;
  firstTokenSec: number | null;
  avgContextTokens: number | null;
  avgOutputTokens: number | null;
}

/**
 * Derive display ratios and nullable metrics from additive {@link UsageTotals}.
 * Matches DSH's `UsagePill` prompt definition (`input + cached + cacheWrite`).
 */
export function deriveUsageMetrics(totals: UsageTotals): DerivedUsageMetrics {
  const promptTokens = totals.input + totals.cached + totals.cacheWrite;
  const totalTokens = promptTokens + totals.output;
  return {
    requests: totals.requests,
    promptTokens,
    totalTokens,
    cost: totals.pricedRequests > 0 ? totals.cost : null,
    costPerRequest: totals.pricedRequests > 0 ? totals.cost / totals.pricedRequests : null,
    tps: totals.generationSeconds > 0 ? totals.generationOutput / totals.generationSeconds : null,
    cacheHitRate: promptTokens > 0 ? Math.min(1, totals.cached / promptTokens) : null,
    firstTokenSec: totals.firstTokenRequests > 0 ? totals.firstTokenSeconds / totals.firstTokenRequests : null,
    avgContextTokens: totals.requests > 0 ? promptTokens / totals.requests : null,
    avgOutputTokens: totals.requests > 0 ? totals.output / totals.requests : null,
  };
}
