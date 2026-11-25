/**
 * Dual-currency API pricing reference catalog, rate resolution, cost calculation,
 * and shared RPC contracts (`dsh.pricing.get` / `dsh.pricing.update`).
 *
 * Kept strictly runtime-neutral (no `node:*` imports, no `structuredClone`) so
 * both the Node server and the Hermes/React Native client can import it.
 *
 * Built-in entries cover generic public model families only (`deepseek-*`,
 * `claude-*`, `gpt-*`, `o1-*`/`o3-*`/`o4-*`, `gemini-*`). Personal providers,
 * private model IDs, base URLs, and credentials never belong here.
 *
 * @module dsh-paseo/shared/pricing
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PRICING_SCHEMA_VERSION = 1 as const;

export const CURRENCIES = ["USD", "CNY"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const currencySchema = z.enum(CURRENCIES);

export const MODEL_FAMILIES = ["DeepSeek", "Claude", "OpenAI", "Gemini"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export const modelFamilySchema = z.enum(MODEL_FAMILIES);

export const DEFAULT_DISPLAY_CURRENCY: Currency = "USD";
export const DEFAULT_USD_TO_CNY_RATE = 7.2;
export const MIN_USD_TO_CNY_RATE = 0.01;
export const MAX_USD_TO_CNY_RATE = 1_000;
export const MAX_RATE_PER_MILLION = 100_000;
export const MAX_LONG_CONTEXT_THRESHOLD = 10_000_000;

const ONE_MILLION = 1_000_000;
const MODEL_KEY_MAX_LENGTH = 160;
const PREFIX_BOUNDARY_CHARS = new Set(["-", ".", "_", ":", "@", " "]);

const rateNumberSchema = z.number().finite().min(0).max(MAX_RATE_PER_MILLION);

export const exchangeRateSchema = z
  .number()
  .finite()
  .min(MIN_USD_TO_CNY_RATE)
  .max(MAX_USD_TO_CNY_RATE);

export const modelRatesSchema = z
  .object({
    /** Native currency for all rates in this entry. */
    currency: currencySchema,
    /** Uncached input tokens, native currency per 1M tokens. */
    input: rateNumberSchema,
    /** Context-cache read tokens, native currency per 1M tokens. */
    cached: rateNumberSchema,
    /** Optional context-cache write tokens, native currency per 1M tokens (falls back to `input`). */
    cacheWrite: rateNumberSchema.optional(),
    /** Output tokens (including thinking/reasoning tokens), native currency per 1M tokens. */
    output: rateNumberSchema,
    /** Optional prompt-token threshold above which long-context tier rates apply. */
    longContextThreshold: z.number().int().positive().max(MAX_LONG_CONTEXT_THRESHOLD).optional(),
    longInput: rateNumberSchema.optional(),
    longCached: rateNumberSchema.optional(),
    longCacheWrite: rateNumberSchema.optional(),
    longOutput: rateNumberSchema.optional(),
  })
  .strict();

export type ModelRates = z.infer<typeof modelRatesSchema>;

export const pricingConfigSchema = z
  .object({
    version: z.literal(PRICING_SCHEMA_VERSION).default(PRICING_SCHEMA_VERSION),
    displayCurrency: currencySchema.default(DEFAULT_DISPLAY_CURRENCY),
    usdToCnyRate: exchangeRateSchema.default(DEFAULT_USD_TO_CNY_RATE),
    overrides: z
      .record(z.string().trim().min(1).max(MODEL_KEY_MAX_LENGTH), modelRatesSchema)
      .default({}),
  })
  .strict();

export type PricingConfig = z.infer<typeof pricingConfigSchema>;

export interface ReferencePricingEntry {
  /** Canonical family key (e.g. `"deepseek-chat"`, `"claude-sonnet-4"`, `"gpt-4.1"`). */
  readonly key: string;
  /** Human-readable display label. */
  readonly label: string;
  /** Generic public model family grouping. */
  readonly family: ModelFamily;
  /** Lowercase prefixes matched against the stripped model ID (longest boundary match wins). */
  readonly prefixes: readonly string[];
  /** Reference rates in their native currency (per 1M tokens). */
  readonly rates: ModelRates;
  /** Optional short note (for example long-context tier pricing). */
  readonly note?: string;
}

/**
 * Built-in generic public model family reference catalog (per 1M tokens in each
 * family's native published currency).
 */
export const REFERENCE_PRICING: readonly ReferencePricingEntry[] = [
  // DeepSeek (CNY per 1M tokens)
  {
    key: "deepseek-chat",
    label: "DeepSeek Chat / V3",
    family: "DeepSeek",
    prefixes: ["deepseek-chat", "deepseek-v3"],
    rates: { currency: "CNY", input: 2, cached: 0.2, output: 3 },
  },
  {
    key: "deepseek-reasoner",
    label: "DeepSeek Reasoner / R1",
    family: "DeepSeek",
    prefixes: ["deepseek-reasoner", "deepseek-r1"],
    rates: { currency: "CNY", input: 4, cached: 1, output: 16 },
  },

  // Anthropic Claude (USD per 1M tokens)
  {
    key: "claude-opus-4.5",
    label: "Claude Opus 4.5 / 4.6",
    family: "Claude",
    prefixes: ["claude-opus-4-6", "claude-opus-4.6", "claude-opus-4-5", "claude-opus-4.5"],
    rates: { currency: "USD", input: 5, cached: 0.5, cacheWrite: 6.25, output: 25 },
  },
  {
    key: "claude-opus-4",
    label: "Claude Opus 4",
    family: "Claude",
    prefixes: ["claude-opus-4", "claude-4-opus"],
    rates: { currency: "USD", input: 15, cached: 1.5, cacheWrite: 18.75, output: 75 },
  },
  {
    key: "claude-sonnet-4",
    label: "Claude Sonnet 4",
    family: "Claude",
    prefixes: ["claude-sonnet-4", "claude-4-sonnet"],
    rates: {
      currency: "USD",
      input: 3,
      cached: 0.3,
      cacheWrite: 3.75,
      output: 15,
      longContextThreshold: 200_000,
      longInput: 6,
      longCached: 0.6,
      longCacheWrite: 7.5,
      longOutput: 22.5,
    },
    note: ">200K prompts: $6/$22.50 ($0.60 cached)",
  },
  {
    key: "claude-haiku-4",
    label: "Claude Haiku 4",
    family: "Claude",
    prefixes: ["claude-haiku-4", "claude-4-haiku"],
    rates: { currency: "USD", input: 1, cached: 0.1, cacheWrite: 1.25, output: 5 },
  },
  {
    key: "claude-3.5-sonnet",
    label: "Claude 3.5 / 3.7 Sonnet",
    family: "Claude",
    prefixes: ["claude-3-7-sonnet", "claude-3.7-sonnet", "claude-3-5-sonnet", "claude-3.5-sonnet"],
    rates: { currency: "USD", input: 3, cached: 0.3, cacheWrite: 3.75, output: 15 },
  },
  {
    key: "claude-3.5-haiku",
    label: "Claude 3.5 Haiku",
    family: "Claude",
    prefixes: ["claude-3-5-haiku", "claude-3.5-haiku"],
    rates: { currency: "USD", input: 0.8, cached: 0.08, cacheWrite: 1, output: 4 },
  },

  // OpenAI GPT & o-series (USD per 1M tokens)
  {
    key: "gpt-5",
    label: "GPT-5",
    family: "OpenAI",
    prefixes: ["gpt-5"],
    rates: { currency: "USD", input: 1.25, cached: 0.125, output: 10 },
  },
  {
    key: "gpt-5-mini",
    label: "GPT-5 Mini",
    family: "OpenAI",
    prefixes: ["gpt-5-mini"],
    rates: { currency: "USD", input: 0.25, cached: 0.025, output: 2 },
  },
  {
    key: "gpt-5-nano",
    label: "GPT-5 Nano",
    family: "OpenAI",
    prefixes: ["gpt-5-nano"],
    rates: { currency: "USD", input: 0.05, cached: 0.005, output: 0.4 },
  },
  {
    key: "gpt-4.1",
    label: "GPT-4.1",
    family: "OpenAI",
    prefixes: ["gpt-4.1", "gpt-4-1"],
    rates: { currency: "USD", input: 2, cached: 0.5, output: 8 },
  },
  {
    key: "gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    family: "OpenAI",
    prefixes: ["gpt-4.1-mini", "gpt-4-1-mini"],
    rates: { currency: "USD", input: 0.4, cached: 0.1, output: 1.6 },
  },
  {
    key: "gpt-4.1-nano",
    label: "GPT-4.1 Nano",
    family: "OpenAI",
    prefixes: ["gpt-4.1-nano", "gpt-4-1-nano"],
    rates: { currency: "USD", input: 0.1, cached: 0.025, output: 0.4 },
  },
  {
    key: "gpt-4o",
    label: "GPT-4o",
    family: "OpenAI",
    prefixes: ["gpt-4o"],
    rates: { currency: "USD", input: 2.5, cached: 1.25, output: 10 },
  },
  {
    key: "gpt-4o-mini",
    label: "GPT-4o Mini",
    family: "OpenAI",
    prefixes: ["gpt-4o-mini"],
    rates: { currency: "USD", input: 0.15, cached: 0.075, output: 0.6 },
  },
  {
    key: "o1",
    label: "o1",
    family: "OpenAI",
    prefixes: ["o1"],
    rates: { currency: "USD", input: 15, cached: 7.5, output: 60 },
  },
  {
    key: "o1-mini",
    label: "o1-mini",
    family: "OpenAI",
    prefixes: ["o1-mini"],
    rates: { currency: "USD", input: 1.1, cached: 0.55, output: 4.4 },
  },
  {
    key: "o3",
    label: "o3",
    family: "OpenAI",
    prefixes: ["o3"],
    rates: { currency: "USD", input: 2, cached: 0.5, output: 8 },
  },
  {
    key: "o3-mini",
    label: "o3-mini",
    family: "OpenAI",
    prefixes: ["o3-mini"],
    rates: { currency: "USD", input: 1.1, cached: 0.55, output: 4.4 },
  },
  {
    key: "o4-mini",
    label: "o4-mini",
    family: "OpenAI",
    prefixes: ["o4-mini"],
    rates: { currency: "USD", input: 1.1, cached: 0.275, output: 4.4 },
  },

  // Google Gemini (USD per 1M tokens)
  {
    key: "gemini-3-pro",
    label: "Gemini 3 Pro",
    family: "Gemini",
    prefixes: ["gemini-3.1-pro", "gemini-3-1-pro", "gemini-3-pro"],
    rates: {
      currency: "USD",
      input: 2,
      cached: 0.2,
      output: 12,
      longContextThreshold: 200_000,
      longInput: 4,
      longCached: 0.4,
      longOutput: 18,
    },
    note: ">200K prompts: $4/$18 ($0.40 cached)",
  },
  {
    key: "gemini-3-flash",
    label: "Gemini 3 Flash",
    family: "Gemini",
    prefixes: ["gemini-3.1-flash", "gemini-3-1-flash", "gemini-3-flash"],
    rates: { currency: "USD", input: 0.5, cached: 0.05, output: 3 },
  },
  {
    key: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    family: "Gemini",
    prefixes: ["gemini-2.5-pro", "gemini-2-5-pro"],
    rates: {
      currency: "USD",
      input: 1.25,
      cached: 0.125,
      output: 10,
      longContextThreshold: 200_000,
      longInput: 2.5,
      longCached: 0.25,
      longOutput: 15,
    },
    note: ">200K prompts: $2.50/$15 ($0.25 cached)",
  },
  {
    key: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    family: "Gemini",
    prefixes: ["gemini-2.5-flash-lite", "gemini-2-5-flash-lite"],
    rates: { currency: "USD", input: 0.1, cached: 0.01, output: 0.4 },
  },
  {
    key: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    family: "Gemini",
    prefixes: ["gemini-2.5-flash", "gemini-2-5-flash"],
    rates: { currency: "USD", input: 0.3, cached: 0.03, output: 2.5 },
  },
  {
    key: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    family: "Gemini",
    prefixes: ["gemini-2.0-flash", "gemini-2-0-flash"],
    rates: { currency: "USD", input: 0.1, cached: 0.025, output: 0.4 },
  },
];

const REFERENCE_BY_KEY = new Map<string, ReferencePricingEntry>(
  REFERENCE_PRICING.map((entry) => [entry.key, entry]),
);

/** Flattened `(prefix, entry)` list sorted longest-prefix-first for unambiguous matching. */
const SORTED_PREFIX_INDEX: readonly { readonly prefix: string; readonly entry: ReferencePricingEntry }[] =
  REFERENCE_PRICING.flatMap((entry) =>
    entry.prefixes.map((prefix) => ({ prefix: prefix.toLowerCase(), entry })),
  ).sort((left, right) => right.prefix.length - left.prefix.length);

export function defaultPricingConfig(): PricingConfig {
  return {
    version: PRICING_SCHEMA_VERSION,
    displayCurrency: DEFAULT_DISPLAY_CURRENCY,
    usdToCnyRate: DEFAULT_USD_TO_CNY_RATE,
    overrides: {},
  };
}

export function getReferencePricingEntry(key: string): ReferencePricingEntry | undefined {
  return REFERENCE_BY_KEY.get(normalizeModelKey(key));
}

export function normalizeModelKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Strips leading `provider/` or `org/provider/` namespaces from a normalized model ID
 * (for example `"openrouter/anthropic/claude-sonnet-4-5"` -> `"claude-sonnet-4-5"`).
 */
export function stripProviderPrefix(modelKey: string): string {
  const normalized = normalizeModelKey(modelKey);
  if (!normalized) return "";
  const cleaned = normalized.replace(/\/+$/, "");
  const slash = cleaned.lastIndexOf("/");
  if (slash === -1) return cleaned;
  const tail = cleaned.slice(slash + 1).trim();
  return tail || cleaned;
}

function matchesPrefixWithBoundary(candidate: string, prefix: string): boolean {
  if (candidate === prefix) return true;
  if (!candidate.startsWith(prefix)) return false;
  if (PREFIX_BOUNDARY_CHARS.has(prefix[prefix.length - 1] ?? "")) return true;
  return PREFIX_BOUNDARY_CHARS.has(candidate[prefix.length] ?? "");
}

/**
 * Matches a raw model ID (with or without `provider/` prefix) against the built-in
 * generic public model family reference table. Longest boundary-aligned prefix wins.
 */
export function matchReferenceEntry(model: string): ReferencePricingEntry | null {
  const bare = stripProviderPrefix(model);
  if (!bare) return null;
  for (const item of SORTED_PREFIX_INDEX) {
    if (matchesPrefixWithBoundary(bare, item.prefix)) {
      return item.entry;
    }
  }
  return null;
}

export interface TokenUsageInput {
  /** Uncached input tokens. */
  input: number;
  /** Context-cache read tokens. */
  cached: number;
  /** Optional context-cache write tokens. */
  cacheWrite?: number;
  /** Output tokens (including thinking/reasoning tokens). */
  output: number;
}

export interface ResolvedModelRates {
  /** Canonical pricing key (matched override key or matched family key). */
  pricingKey: string;
  /** Effective rates used for cost calculation. */
  rates: ModelRates;
  /** Whether the rates came from a user override or the built-in reference catalog. */
  source: "override" | "reference";
  /** Matched built-in reference entry, if any (retained even when overridden). */
  reference: ReferencePricingEntry | null;
}

export interface PricingCallInput {
  model: string;
  provider?: string | null;
  tokens: TokenUsageInput;
}

export interface CallCostResult {
  /** True when a rate was found; false when unmatched with no override. */
  priced: boolean;
  /** Cost in the matched rate's native currency, or null when unpriced. */
  nativeCost: number | null;
  /** Native currency of the matched rate, or null when unpriced. */
  nativeCurrency: Currency | null;
  /** Cost converted into `displayCurrency`, or null when unpriced. */
  cost: number | null;
  /** Target display currency used for `cost`. */
  displayCurrency: Currency;
  /** Canonical pricing key (override key, matched family key, or stripped model ID). */
  pricingKey: string;
  /** True when long-context tier rates were applied. */
  longContext: boolean;
  /** Rate provenance, or null when unpriced. */
  source: "override" | "reference" | null;
}

export interface CostAggregation {
  displayCurrency: Currency;
  /** Total converted cost across priced calls, or null when `pricedRequests === 0`. */
  cost: number | null;
  /** Numeric sum across priced calls (`0` when none are priced). */
  totalCost: number;
  pricedRequests: number;
  unpricedRequests: number;
  totalRequests: number;
}

/**
 * Structural pricing interface shared with `server/usage-stats.ts` (`UsagePricer`)
 * so usage aggregation can price calls in one pass with pre-normalized overrides.
 */
export interface PricingResolver {
  readonly displayCurrency: Currency;
  readonly usdToCnyRate: number;
  readonly hasCustomPricing: boolean;
  resolveKey(model: string, provider?: string | null): string;
  resolveRates(model: string, provider?: string | null): ResolvedModelRates | null;
  priceCall(input: PricingCallInput): CallCostResult;
}

/** Alias matching the structural `UsagePricer` adapter contract used by usage aggregation. */
export type UsagePricer = PricingResolver;

function buildOverrideMap(
  overrides?: Readonly<Record<string, ModelRates>>,
): Map<string, ModelRates> {
  const map = new Map<string, ModelRates>();
  if (!overrides) return map;
  for (const [rawKey, rates] of Object.entries(overrides)) {
    const key = normalizeModelKey(rawKey);
    if (key) map.set(key, rates);
  }
  return map;
}

function candidateOverrideKeys(
  normModel: string,
  bare: string,
  normProvider: string,
  ref: ReferencePricingEntry | null,
): string[] {
  const keys: string[] = [];
  if (normProvider && !normModel.startsWith(`${normProvider}/`)) {
    keys.push(`${normProvider}/${normModel}`);
  }
  keys.push(normModel);
  if (bare && bare !== normModel) {
    keys.push(bare);
  }
  if (ref && !keys.includes(ref.key)) {
    keys.push(ref.key);
  }
  return keys;
}

function resolveWithMap(
  model: string,
  provider: string | null | undefined,
  overrideMap: ReadonlyMap<string, ModelRates>,
): ResolvedModelRates | null {
  const normModel = normalizeModelKey(model);
  if (!normModel) return null;
  const normProvider = provider ? normalizeModelKey(provider) : "";
  const bare = stripProviderPrefix(normModel);
  const ref = matchReferenceEntry(bare);

  for (const key of candidateOverrideKeys(normModel, bare, normProvider, ref)) {
    const override = overrideMap.get(key);
    if (override) {
      return { pricingKey: key, rates: override, source: "override", reference: ref };
    }
  }
  if (ref) {
    return { pricingKey: ref.key, rates: ref.rates, source: "reference", reference: ref };
  }
  return null;
}

function resolveKeyWithMap(
  model: string,
  provider: string | null | undefined,
  overrideMap: ReadonlyMap<string, ModelRates>,
): string {
  const normModel = normalizeModelKey(model);
  if (!normModel) return "unknown";
  const normProvider = provider ? normalizeModelKey(provider) : "";
  const bare = stripProviderPrefix(normModel);
  const ref = matchReferenceEntry(bare);

  for (const key of candidateOverrideKeys(normModel, bare, normProvider, ref)) {
    if (overrideMap.has(key)) return key;
  }
  if (ref) return ref.key;
  return bare || normModel;
}

/**
 * Resolves the canonical pricing key for a `(model, provider?)` pair so usage rows
 * and the pricing editor always point at the same override key.
 */
export function resolvePricingKey(
  model: string,
  provider?: string | null,
  overrides?: Readonly<Record<string, ModelRates>>,
): string {
  return resolveKeyWithMap(model, provider, buildOverrideMap(overrides));
}

/**
 * Resolves effective rates for a model: user overrides win over built-in family
 * reference entries, checking `provider/model` -> exact `model` -> stripped `model`
 * -> matched reference family key -> built-in reference rates -> `null`.
 */
export function resolveModelRates(
  model: string,
  overrides?: Readonly<Record<string, ModelRates>>,
  provider?: string | null,
): ResolvedModelRates | null {
  return resolveWithMap(model, provider, buildOverrideMap(overrides));
}

/**
 * Converts a monetary amount between `USD` and `CNY` using `usdToCnyRate`
 * (CNY per 1 USD). Same-currency conversion returns the input unchanged.
 */
export function convertCurrency(
  amount: number,
  from: Currency,
  to: Currency,
  usdToCnyRate: number,
): number {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`Invalid monetary amount: ${String(amount)}`);
  }
  if (!Number.isFinite(usdToCnyRate) || usdToCnyRate <= 0) {
    throw new RangeError(`Invalid USD/CNY exchange rate: ${String(usdToCnyRate)}`);
  }
  if (from === to) return amount;
  if (from === "USD" && to === "CNY") return amount * usdToCnyRate;
  if (from === "CNY" && to === "USD") return amount / usdToCnyRate;
  throw new RangeError(`Unsupported currency conversion: ${String(from)} -> ${String(to)}`);
}

function sanitizeTokens(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/**
 * Calculates one call's cost in the rate's own native currency, applying long-context
 * tier rates when total prompt tokens (`input + cached + cacheWrite`) exceed
 * `rates.longContextThreshold`.
 */
export function calculateNativeCost(
  tokens: TokenUsageInput,
  rates: ModelRates,
): { cost: number; longContext: boolean } {
  const input = sanitizeTokens(tokens.input);
  const cached = sanitizeTokens(tokens.cached);
  const cacheWrite = sanitizeTokens(tokens.cacheWrite);
  const output = sanitizeTokens(tokens.output);

  const promptTokens = input + cached + cacheWrite;
  const longContext =
    typeof rates.longContextThreshold === "number" &&
    rates.longContextThreshold > 0 &&
    promptTokens > rates.longContextThreshold;

  const inputRate = longContext && rates.longInput !== undefined ? rates.longInput : rates.input;
  const cachedRate = longContext && rates.longCached !== undefined ? rates.longCached : rates.cached;
  const cacheWriteRate =
    longContext && rates.longCacheWrite !== undefined
      ? rates.longCacheWrite
      : rates.cacheWrite !== undefined
        ? rates.cacheWrite
        : inputRate;
  const outputRate = longContext && rates.longOutput !== undefined ? rates.longOutput : rates.output;

  const cost =
    (input * inputRate + cached * cachedRate + cacheWrite * cacheWriteRate + output * outputRate) /
    ONE_MILLION;

  return { cost, longContext };
}

function priceCallWithMap(
  input: PricingCallInput,
  displayCurrency: Currency,
  usdToCnyRate: number,
  overrideMap: ReadonlyMap<string, ModelRates>,
): CallCostResult {
  const resolved = resolveWithMap(input.model, input.provider, overrideMap);
  if (!resolved) {
    return {
      priced: false,
      nativeCost: null,
      nativeCurrency: null,
      cost: null,
      displayCurrency,
      pricingKey: resolveKeyWithMap(input.model, input.provider, overrideMap),
      longContext: false,
      source: null,
    };
  }
  const { cost: nativeCost, longContext } = calculateNativeCost(input.tokens, resolved.rates);
  const cost = convertCurrency(nativeCost, resolved.rates.currency, displayCurrency, usdToCnyRate);
  return {
    priced: true,
    nativeCost,
    nativeCurrency: resolved.rates.currency,
    cost,
    displayCurrency,
    pricingKey: resolved.pricingKey,
    longContext,
    source: resolved.source,
  };
}

/**
 * Prices one model call in its native currency and converts the result into
 * `config.displayCurrency` using `config.usdToCnyRate`. Unmatched models with
 * no override return `{ priced: false, cost: null, nativeCost: null, ... }`.
 */
export function calculateCallCost(
  input: PricingCallInput,
  config: Pick<PricingConfig, "displayCurrency" | "usdToCnyRate" | "overrides"> = defaultPricingConfig(),
): CallCostResult {
  const displayCurrency = currencySchema.parse(config.displayCurrency);
  const rate = exchangeRateSchema.parse(config.usdToCnyRate);
  const overrideMap = buildOverrideMap(config.overrides);
  return priceCallWithMap(input, displayCurrency, rate, overrideMap);
}

/**
 * Builds a reusable, pre-indexed {@link PricingResolver} (`UsagePricer`) suitable for
 * pricing thousands of calls in one aggregation pass.
 */
export function createPricingResolver(
  config: Partial<Pick<PricingConfig, "displayCurrency" | "usdToCnyRate" | "overrides">> = {},
): PricingResolver {
  const displayCurrency = currencySchema.parse(config.displayCurrency ?? DEFAULT_DISPLAY_CURRENCY);
  const usdToCnyRate = exchangeRateSchema.parse(config.usdToCnyRate ?? DEFAULT_USD_TO_CNY_RATE);
  const overrideMap = buildOverrideMap(config.overrides);
  const hasCustomPricing = overrideMap.size > 0;

  return {
    displayCurrency,
    usdToCnyRate,
    hasCustomPricing,
    resolveKey(model: string, provider?: string | null): string {
      return resolveKeyWithMap(model, provider, overrideMap);
    },
    resolveRates(model: string, provider?: string | null): ResolvedModelRates | null {
      return resolveWithMap(model, provider, overrideMap);
    },
    priceCall(input: PricingCallInput): CallCostResult {
      return priceCallWithMap(input, displayCurrency, usdToCnyRate, overrideMap);
    },
  };
}

function isPricingResolver(value: unknown): value is PricingResolver {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PricingResolver).priceCall === "function"
  );
}

/**
 * Aggregates converted costs across a sequence of calls. Unpriced calls are
 * excluded from `pricedRequests` and contribute nothing to `totalCost`.
 */
export function aggregateCallCosts(
  calls: Iterable<PricingCallInput>,
  resolverOrConfig:
    | PricingResolver
    | Pick<PricingConfig, "displayCurrency" | "usdToCnyRate" | "overrides"> = defaultPricingConfig(),
): CostAggregation {
  const resolver = isPricingResolver(resolverOrConfig)
    ? resolverOrConfig
    : createPricingResolver(resolverOrConfig);
  let totalCost = 0;
  let pricedRequests = 0;
  let unpricedRequests = 0;

  for (const call of calls) {
    const result = resolver.priceCall(call);
    if (result.priced && result.cost !== null) {
      totalCost += result.cost;
      pricedRequests += 1;
    } else {
      unpricedRequests += 1;
    }
  }

  return {
    displayCurrency: resolver.displayCurrency,
    cost: pricedRequests > 0 ? totalCost : null,
    totalCost,
    pricedRequests,
    unpricedRequests,
    totalRequests: pricedRequests + unpricedRequests,
  };
}

// ---- RPC Contracts -------------------------------------------------------------------------

export const pricingModelRowSchema = z.object({
  key: z.string().min(1).max(MODEL_KEY_MAX_LENGTH),
  label: z.string().min(1).max(MODEL_KEY_MAX_LENGTH),
  family: modelFamilySchema.nullable(),
  prefixes: z.array(z.string()),
  /** Built-in family reference rates, or null for custom/unrecognized models. */
  reference: modelRatesSchema.nullable(),
  /** User-configured override rates, or null when not overridden. */
  custom: modelRatesSchema.nullable(),
  /** Effective rates currently applied (`custom ?? reference`), or null when unpriced. */
  effective: modelRatesSchema.nullable(),
  /** Optional short note describing reference tiers. */
  note: z.string().nullable(),
  /** True when this model appeared in local DSH session logs. */
  seenLocally: z.boolean(),
});

export type PricingModelRow = z.infer<typeof pricingModelRowSchema>;

export const pricingStateSchema = z.object({
  version: z.literal(PRICING_SCHEMA_VERSION),
  displayCurrency: currencySchema,
  usdToCnyRate: exchangeRateSchema,
  models: z.array(pricingModelRowSchema),
  overrides: z.record(z.string(), modelRatesSchema),
  hasCustomOverrides: z.boolean(),
});

export type PricingState = z.infer<typeof pricingStateSchema>;

export const pricingUpdateInputSchema = z
  .object({
    displayCurrency: currencySchema.optional(),
    usdToCnyRate: exchangeRateSchema.optional(),
    /** Model key to set or clear an override for. Must be paired with `rates`. */
    key: z.string().trim().min(1).max(MODEL_KEY_MAX_LENGTH).optional(),
    /** Custom rates for `key`, or `null` to delete the override for `key`. */
    rates: modelRatesSchema.nullable().optional(),
    /** Clear all custom overrides while keeping `displayCurrency` and `usdToCnyRate`. */
    resetOverrides: z.boolean().optional(),
    /** Reset overrides, `displayCurrency`, and `usdToCnyRate` back to built-in defaults. */
    resetAll: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasKey = value.key !== undefined;
    const hasRates = value.rates !== undefined;
    if (hasKey && !hasRates) {
      ctx.addIssue({
        code: "custom",
        path: ["rates"],
        message: "Provide `rates` (rates object to set, or null to delete) when `key` is set.",
      });
    }
    if (!hasKey && hasRates) {
      ctx.addIssue({
        code: "custom",
        path: ["key"],
        message: "Provide `key` when `rates` is set.",
      });
    }
    if (
      value.displayCurrency === undefined &&
      value.usdToCnyRate === undefined &&
      !hasKey &&
      !value.resetOverrides &&
      !value.resetAll
    ) {
      ctx.addIssue({
        code: "custom",
        message: "At least one pricing update field must be provided.",
      });
    }
  });

export type PricingUpdateInput = z.infer<typeof pricingUpdateInputSchema>;

export const pricingGetRpc = defineRpc({
  name: "dsh.pricing.get",
  input: z.object({}).strict(),
  output: pricingStateSchema,
});

export const pricingUpdateRpc = defineRpc({
  name: "dsh.pricing.update",
  input: pricingUpdateInputSchema,
  output: pricingStateSchema,
});
