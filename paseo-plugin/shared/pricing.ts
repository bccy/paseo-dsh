/**
 * Dual-currency API pricing reference catalog, official registry parser
 * (`models.dev`), rate resolution, cost calculation, and shared RPC contracts
 * (`dsh.pricing.get` / `dsh.pricing.update` / `dsh.pricing.sync`).
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
import {
  ANTIGRAVITY_DEFAULT_PRICING,
  defaultPricingEntry as getAntigravityDefaultPricingEntry,
  officialRatesAt as antigravityOfficialRatesAt,
  resolvePricingKey as resolveAntigravityPricingKey,
  toUsdDualCurrencyRates,
  type AntigravityDefaultPricingEntry,
} from "./antigravity/pricing-defaults";

export const PRICING_SCHEMA_VERSION = 1 as const;
export const PRICING_CATALOG_SCHEMA_VERSION = 1 as const;

export const CURRENCIES = ["USD", "CNY"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const currencySchema = z.enum(CURRENCIES);

export const MODEL_FAMILIES = ["DeepSeek", "Claude", "OpenAI", "Gemini"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export const modelFamilySchema = z.enum(MODEL_FAMILIES);

export const PRICING_RATE_SOURCES = ["override", "synced", "reference"] as const;
export type PricingRateSource = (typeof PRICING_RATE_SOURCES)[number];
export const pricingRateSourceSchema = z.enum(PRICING_RATE_SOURCES);

export const DEFAULT_DISPLAY_CURRENCY: Currency = "USD";
export const DEFAULT_USD_TO_CNY_RATE = 7.2;
export const DEFAULT_PRICING_AUTO_SYNC = true;
export const DEFAULT_PRICING_SYNC_SOURCE = "models.dev" as const;
export const DEFAULT_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_USD_TO_CNY_RATE = 0.01;
export const MAX_USD_TO_CNY_RATE = 1_000;
export const MAX_RATE_PER_MILLION = 100_000;
export const MAX_LONG_CONTEXT_THRESHOLD = 10_000_000;

/**
 * Curated official first-party API providers parsed from `models.dev/api.json`,
 * ordered by priority so official vendor pricing always wins over resellers,
 * aggregators, and flat-rate subscription/coding plans.
 */
export const OFFICIAL_PROVIDER_PRIORITY: readonly string[] = [
  "deepseek",
  "anthropic",
  "openai",
  "google",
  "xai",
  "moonshotai",
  "moonshotai-cn",
  "zhipuai",
  "zai",
  "alibaba",
  "alibaba-cn",
  "minimax",
  "minimax-cn",
  "mistral",
  "cohere",
  "perplexity",
  "stepfun",
  "stepfun-ai",
  "xiaomi",
  "volcengine",
  "groq",
  "togetherai",
];

const OFFICIAL_PROVIDER_RANK = new Map<string, number>(
  OFFICIAL_PROVIDER_PRIORITY.map((provider, index) => [provider, index]),
);

const ONE_MILLION = 1_000_000;
const MODEL_KEY_MAX_LENGTH = 160;
const PROVIDER_KEY_MAX_LENGTH = 80;
const PREFIX_BOUNDARY_CHARS = new Set(["-", ".", "_", ":", "@", " "]);

/**
 * First-party vendor namespace ownership rules. When an official provider
 * (such as `alibaba-cn`, `mistral`, `groq`, or `togetherai`) also re-hosts
 * another first-party vendor's model, that listing is still recorded under
 * `providerModels["<host>/<model>"]` for exact provider routing, but does not
 * overwrite the canonical bare model price belonging to the originating vendor.
 */
const VENDOR_OWNERSHIP_RULES: ReadonlyArray<{
  readonly owners: ReadonlySet<string>;
  readonly prefixes: readonly string[];
  readonly boundaryPrefixes?: readonly string[];
}> = [
  { owners: new Set(["deepseek"]), prefixes: ["deepseek-"] },
  { owners: new Set(["anthropic"]), prefixes: ["claude-"] },
  {
    owners: new Set(["openai"]),
    prefixes: ["gpt-3", "gpt-4", "gpt-5", "gpt-6", "chatgpt-", "text-embedding-"],
    boundaryPrefixes: ["o1", "o3", "o4"],
  },
  { owners: new Set(["google"]), prefixes: ["gemini-", "gemma-"] },
  { owners: new Set(["xai"]), prefixes: ["grok-"] },
  { owners: new Set(["moonshotai", "moonshotai-cn"]), prefixes: ["kimi-", "moonshot-"] },
  { owners: new Set(["zhipuai", "zai"]), prefixes: ["glm-", "zai-glm-"] },
  { owners: new Set(["alibaba", "alibaba-cn"]), prefixes: ["qwen"] },
  { owners: new Set(["minimax", "minimax-cn"]), prefixes: ["minimax-"] },
  {
    owners: new Set(["mistral"]),
    prefixes: [
      "mistral-",
      "ministral-",
      "codestral-",
      "pixtral-",
      "devstral-",
      "magistral-",
      "voxtral-",
    ],
  },
  { owners: new Set(["cohere"]), prefixes: ["command-", "c4ai-", "tiny-aya-"] },
  { owners: new Set(["perplexity"]), prefixes: [], boundaryPrefixes: ["sonar"] },
];

/**
 * Distinct model-tier / modality qualifiers that must not be folded onto a
 * shorter base model prefix during fuzzy synced lookup (for example `o3-mini`
 * must never fall onto `o3`, and `gpt-4.1-nano` must never fall onto `gpt-4.1`).
 */
const DISTINCT_MODEL_QUALIFIERS = new Set([
  "mini",
  "nano",
  "pro",
  "ultra",
  "flash",
  "lite",
  "air",
  "max",
  "plus",
  "turbo",
  "haiku",
  "sonnet",
  "opus",
  "coder",
  "codex",
  "image",
  "audio",
  "tts",
  "video",
  "embed",
  "embedding",
  "realtime",
  "search",
  "research",
  "highspeed",
  "fast",
  "spot",
  "reasoning",
  "thinking",
  "vision",
  "vl",
  "omni",
  "live",
  "translate",
  "prime",
  "flashx",
]);

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
    autoSync: z.boolean().default(DEFAULT_PRICING_AUTO_SYNC),
    overrides: z
      .record(z.string().trim().min(1).max(MODEL_KEY_MAX_LENGTH), modelRatesSchema)
      .default({}),
    /** Set to true once legacy `antigravity-accounts/pricing.json` overrides have been imported. */
    legacyAntigravityImported: z.boolean().optional(),
  })
  .strict();

export type PricingConfig = z.infer<typeof pricingConfigSchema>;

export const syncedCatalogEntrySchema = z
  .object({
    /** Normalized canonical bare model ID (e.g. `"claude-sonnet-4-5"`, `"deepseek-v4-pro"`). */
    id: z.string().min(1).max(MODEL_KEY_MAX_LENGTH),
    /** Human-readable official model display name. */
    name: z.string().min(1).max(MODEL_KEY_MAX_LENGTH),
    /** Official first-party provider ID from the upstream registry (e.g. `"deepseek"`). */
    provider: z.string().min(1).max(PROVIDER_KEY_MAX_LENGTH),
    /** Official API rates in USD per 1M tokens. */
    rates: modelRatesSchema,
  })
  .strict();

export type SyncedCatalogEntry = z.infer<typeof syncedCatalogEntrySchema>;

export const syncedPricingCatalogSchema = z
  .object({
    version: z.literal(PRICING_CATALOG_SCHEMA_VERSION),
    source: z.string().min(1).max(PROVIDER_KEY_MAX_LENGTH),
    /** ISO timestamp when this catalog was synced. */
    syncedAt: z.string().min(1),
    /** Canonical bare model entries keyed by normalized bare model ID (first-party priority). */
    models: z.record(z.string().min(1).max(MODEL_KEY_MAX_LENGTH), syncedCatalogEntrySchema),
    /** Provider-scoped entries keyed by `${provider}/${bareModelId}` for exact provider routing. */
    providerModels: z
      .record(z.string().min(1).max(MODEL_KEY_MAX_LENGTH), syncedCatalogEntrySchema)
      .default({}),
  })
  .strict();

export type SyncedPricingCatalog = z.infer<typeof syncedPricingCatalogSchema>;

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
  /** Whether this entry is included in closest-official suggestions (defaults to `true`). */
  readonly suggestable?: boolean;
}

/**
 * Built-in generic public model family reference catalog (per 1M tokens in each
 * family's native published currency). Always available offline as a fallback.
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

function antigravityProviderToFamily(provider: AntigravityDefaultPricingEntry["provider"]): ModelFamily {
  if (provider === "Anthropic") return "Claude";
  if (provider === "OpenAI") return "OpenAI";
  return "Gemini";
}

function antigravityPrefixesForKey(key: string): string[] {
  const prefixes = [key];
  const dotsToHyphens = key.replace(/(\d)\.(\d)/g, "$1-$2");
  if (dotsToHyphens !== key) prefixes.push(dotsToHyphens);
  const hyphensToDots = key.replace(/(\d)-(\d)/g, "$1.$2");
  if (hyphensToDots !== key && !prefixes.includes(hyphensToDots)) prefixes.push(hyphensToDots);
  return prefixes;
}

function toReferenceEntryFromAntigravity(
  entry: AntigravityDefaultPricingEntry,
  at?: number,
): ReferencePricingEntry {
  const activeRates = at !== undefined ? antigravityOfficialRatesAt(entry, at) : entry.rates;
  return {
    key: entry.key,
    label: entry.label,
    family: antigravityProviderToFamily(entry.provider),
    prefixes: antigravityPrefixesForKey(entry.key),
    rates: toUsdDualCurrencyRates(activeRates),
    ...(entry.note !== undefined ? { note: entry.note } : {}),
    suggestable: false,
  };
}

/**
 * Antigravity built-in reference entries converted to dual-currency USD
 * {@link ReferencePricingEntry} shape (sourced from `shared/antigravity/pricing-defaults.ts`).
 */
export const ANTIGRAVITY_REFERENCE_PRICING: readonly ReferencePricingEntry[] =
  ANTIGRAVITY_DEFAULT_PRICING.map((entry) => toReferenceEntryFromAntigravity(entry));

/**
 * Keys that remain exclusively in the Antigravity reference layer so existing
 * DSH non-standard model matching (`gemini-3.8-flash` proxy/relay fixture and
 * `gemini-3.1-pro` -> `gemini-3-pro` canonical family key) stays unchanged.
 */
const ANTIGRAVITY_SCOPED_ONLY_KEYS = new Set<string>([
  "gemini-3.1-pro",
  "gemini-3.8-flash",
]);

const BASE_REFERENCE_KEYS = new Set<string>(REFERENCE_PRICING.map((entry) => entry.key));

/**
 * Extra Antigravity built-in models incorporated directly into the unified
 * reference catalog (`gemini-4-neon/carbon/argon/hydrogen`, `claude-opus-5-5`,
 * `claude-sonnet-5-5`, `gpt-oss-120b`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`,
 * `gemini-3.1-flash-lite`).
 */
const EXTRA_ANTIGRAVITY_REFERENCE_ENTRIES: readonly ReferencePricingEntry[] =
  ANTIGRAVITY_REFERENCE_PRICING.filter(
    (entry) => !BASE_REFERENCE_KEYS.has(entry.key) && !ANTIGRAVITY_SCOPED_ONLY_KEYS.has(entry.key),
  );

// Append non-conflicting Antigravity entries into the unified reference table.
(REFERENCE_PRICING as ReferencePricingEntry[]).push(...EXTRA_ANTIGRAVITY_REFERENCE_ENTRIES);

const REFERENCE_BY_KEY = new Map<string, ReferencePricingEntry>(
  REFERENCE_PRICING.map((entry) => [entry.key, entry]),
);

const ANTIGRAVITY_REFERENCE_BY_KEY = new Map<string, AntigravityDefaultPricingEntry>(
  ANTIGRAVITY_DEFAULT_PRICING.map((entry) => [entry.key, entry]),
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
    autoSync: DEFAULT_PRICING_AUTO_SYNC,
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

function extractEmbeddedProvider(normModel: string): string {
  const cleaned = normModel.replace(/\/+$/, "");
  const slash = cleaned.lastIndexOf("/");
  if (slash <= 0) return "";
  const before = cleaned.slice(0, slash);
  const prevSlash = before.lastIndexOf("/");
  return (prevSlash === -1 ? before : before.slice(prevSlash + 1)).trim();
}

function matchesPrefixWithBoundary(candidate: string, prefix: string): boolean {
  if (candidate === prefix) return true;
  if (!candidate.startsWith(prefix)) return false;
  if (PREFIX_BOUNDARY_CHARS.has(prefix[prefix.length - 1] ?? "")) return true;
  return PREFIX_BOUNDARY_CHARS.has(candidate[prefix.length] ?? "");
}

/**
 * Matches an Antigravity model ID, display label, or orchestrator/worker alias
 * against `ANTIGRAVITY_DEFAULT_PRICING`, evaluating scheduled rate changes at
 * timestamp `at` when provided.
 */
export function matchAntigravityReferenceEntry(
  model: string,
  at?: number,
): ReferencePricingEntry | null {
  const trimmed = model.trim();
  if (!trimmed) return null;
  const canonicalKey = resolveAntigravityPricingKey(trimmed);
  const rawEntry = ANTIGRAVITY_REFERENCE_BY_KEY.get(canonicalKey) ?? getAntigravityDefaultPricingEntry(canonicalKey);
  if (!rawEntry) return null;
  return toReferenceEntryFromAntigravity(rawEntry, at);
}

/**
 * Matches a raw model ID (with or without `provider/` prefix) against the built-in
 * generic public model family reference table. Longest boundary-aligned prefix wins.
 */
export function matchReferenceEntry(model: string, at?: number): ReferencePricingEntry | null {
  const bare = stripProviderPrefix(model);
  if (!bare) return null;
  for (const item of SORTED_PREFIX_INDEX) {
    if (matchesPrefixWithBoundary(bare, item.prefix)) {
      if (at !== undefined) {
        const scheduledSource = ANTIGRAVITY_REFERENCE_BY_KEY.get(item.entry.key);
        if (scheduledSource?.scheduled?.length) {
          return toReferenceEntryFromAntigravity(scheduledSource, at);
        }
      }
      return item.entry;
    }
  }
  return null;
}

function matchReferencePrefixLength(bare: string): number {
  if (!bare) return 0;
  for (const item of SORTED_PREFIX_INDEX) {
    if (matchesPrefixWithBoundary(bare, item.prefix)) {
      return item.prefix.length;
    }
  }
  return 0;
}

/** Infers a coarse UI family grouping for known public model families. */
export function inferModelFamily(model: string, provider?: string | null): ModelFamily | null {
  const ref = matchReferenceEntry(model);
  if (ref) return ref.family;
  const bare = stripProviderPrefix(model);
  const prov = provider ? normalizeModelKey(provider) : "";
  if (prov === "deepseek" || bare.startsWith("deepseek-")) return "DeepSeek";
  if (prov === "anthropic" || bare.startsWith("claude-")) return "Claude";
  if (
    prov === "openai" ||
    bare.startsWith("gpt-") ||
    matchesPrefixWithBoundary(bare, "o1") ||
    matchesPrefixWithBoundary(bare, "o3") ||
    matchesPrefixWithBoundary(bare, "o4")
  ) {
    return "OpenAI";
  }
  if (prov === "google" || bare.startsWith("gemini-")) return "Gemini";
  return null;
}

/** Returns official provider priority rank (`0` highest, `Infinity` for unknown providers). */
export function officialProviderRank(provider: string | null | undefined): number {
  if (!provider) return Number.POSITIVE_INFINITY;
  return OFFICIAL_PROVIDER_RANK.get(normalizeModelKey(provider)) ?? Number.POSITIVE_INFINITY;
}

/** Formats a concise long-context tier note (e.g. `">200K prompts: $2.5/$15 ($0.25 cached)"`). */
export function formatLongContextNote(rates: ModelRates): string | null {
  if (
    typeof rates.longContextThreshold !== "number" ||
    rates.longContextThreshold <= 0 ||
    rates.longInput === undefined ||
    rates.longOutput === undefined
  ) {
    return null;
  }
  const sym = rates.currency === "CNY" ? "¥" : "$";
  const fmtRate = (value: number): string => String(Number(value.toFixed(4)));
  const threshold =
    rates.longContextThreshold >= 1_000_000 && rates.longContextThreshold % 1_000_000 === 0
      ? `${rates.longContextThreshold / 1_000_000}M`
      : rates.longContextThreshold >= 1_000
        ? `${Math.round(rates.longContextThreshold / 1_000)}K`
        : String(rates.longContextThreshold);
  const cachedPart =
    rates.longCached !== undefined ? ` (${sym}${fmtRate(rates.longCached)} cached)` : "";
  return `>${threshold} prompts: ${sym}${fmtRate(rates.longInput)}/${sym}${fmtRate(rates.longOutput)}${cachedPart}`;
}

// ---- Official Registry (`models.dev`) Parsing & Indexing -----------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalRateNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > MAX_RATE_PER_MILLION) return undefined;
  return value;
}

function canPopulateCanonicalModel(bareId: string, providerId: string): boolean {
  for (const rule of VENDOR_OWNERSHIP_RULES) {
    const matchedPrefix = rule.prefixes.some((prefix) => bareId.startsWith(prefix));
    const matchedBoundary =
      rule.boundaryPrefixes?.some((prefix) => matchesPrefixWithBoundary(bareId, prefix)) ?? false;
    if (matchedPrefix || matchedBoundary) {
      return rule.owners.has(providerId);
    }
  }
  return true;
}

function extractContextTier(
  cost: Record<string, unknown>,
): {
  readonly longContextThreshold: number;
  readonly longInput: number;
  readonly longCached: number;
  readonly longCacheWrite?: number;
  readonly longOutput: number;
} | null {
  if (Array.isArray(cost.tiers)) {
    const candidates: Array<{
      threshold: number;
      input: number;
      cached: number;
      cacheWrite?: number;
      output: number;
    }> = [];

    for (const rawTier of cost.tiers) {
      if (!isPlainRecord(rawTier)) continue;
      const tierMeta = rawTier.tier;
      if (!isPlainRecord(tierMeta) || tierMeta.type !== "context") continue;
      const size = tierMeta.size;
      if (
        typeof size !== "number" ||
        !Number.isFinite(size) ||
        !Number.isInteger(size) ||
        size <= 0 ||
        size > MAX_LONG_CONTEXT_THRESHOLD
      ) {
        continue;
      }
      const tierInput = parseOptionalRateNumber(rawTier.input);
      const tierOutput = parseOptionalRateNumber(rawTier.output);
      if (tierInput === undefined || tierOutput === undefined) continue;
      const tierCached = parseOptionalRateNumber(rawTier.cache_read) ?? tierInput;
      const tierCacheWrite = parseOptionalRateNumber(rawTier.cache_write);
      candidates.push({
        threshold: size,
        input: tierInput,
        cached: tierCached,
        ...(tierCacheWrite !== undefined ? { cacheWrite: tierCacheWrite } : {}),
        output: tierOutput,
      });
    }

    if (candidates.length > 0) {
      candidates.sort((left, right) => left.threshold - right.threshold);
      const picked = candidates[0]!;
      return {
        longContextThreshold: picked.threshold,
        longInput: picked.input,
        longCached: picked.cached,
        ...(picked.cacheWrite !== undefined ? { longCacheWrite: picked.cacheWrite } : {}),
        longOutput: picked.output,
      };
    }
  }

  const over200k = cost.context_over_200k;
  if (isPlainRecord(over200k)) {
    const tierInput = parseOptionalRateNumber(over200k.input);
    const tierOutput = parseOptionalRateNumber(over200k.output);
    if (tierInput !== undefined && tierOutput !== undefined) {
      const tierCached = parseOptionalRateNumber(over200k.cache_read) ?? tierInput;
      const tierCacheWrite = parseOptionalRateNumber(over200k.cache_write);
      return {
        longContextThreshold: 200_000,
        longInput: tierInput,
        longCached: tierCached,
        ...(tierCacheWrite !== undefined ? { longCacheWrite: tierCacheWrite } : {}),
        longOutput: tierOutput,
      };
    }
  }

  return null;
}

function extractModelsDevRates(rawCost: unknown): ModelRates | null {
  if (!isPlainRecord(rawCost)) return null;
  const input = parseOptionalRateNumber(rawCost.input);
  const output = parseOptionalRateNumber(rawCost.output);
  if (input === undefined || output === undefined) return null;

  // When a model does not advertise a cache-read discount, bill cache reads at
  // the uncached input rate rather than assuming free ($0) reads.
  const cached = parseOptionalRateNumber(rawCost.cache_read) ?? input;
  const cacheWrite = parseOptionalRateNumber(rawCost.cache_write);
  const tier = extractContextTier(rawCost);

  const candidate: ModelRates = {
    currency: "USD",
    input,
    cached,
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    output,
    ...(tier ?? {}),
  };

  const checked = modelRatesSchema.safeParse(candidate);
  return checked.success ? checked.data : null;
}

/**
 * Parses a raw `https://models.dev/api.json` payload into a normalized,
 * validated {@link SyncedPricingCatalog}, ingesting only curated official
 * first-party providers in {@link OFFICIAL_PROVIDER_PRIORITY} order so
 * third-party resellers and subscription plans never override official rates.
 */
export function parseModelsDevCatalog(
  rawPayload: unknown,
  syncedAt: string = new Date().toISOString(),
  source: string = DEFAULT_PRICING_SYNC_SOURCE,
): SyncedPricingCatalog {
  if (!isPlainRecord(rawPayload)) {
    throw new Error("Invalid models.dev payload: expected a top-level JSON object.");
  }

  const models: Record<string, SyncedCatalogEntry> = {};
  const providerModels: Record<string, SyncedCatalogEntry> = {};

  for (const providerId of OFFICIAL_PROVIDER_PRIORITY) {
    const providerNode = rawPayload[providerId];
    if (!isPlainRecord(providerNode) || !isPlainRecord(providerNode.models)) continue;

    const modelEntries = Object.entries(providerNode.models).sort(([a], [b]) => a.localeCompare(b));
    for (const [rawModelId, rawModel] of modelEntries) {
      if (!isPlainRecord(rawModel)) continue;
      const rates = extractModelsDevRates(rawModel.cost);
      if (!rates) continue;

      const bareId = stripProviderPrefix(rawModelId);
      if (!bareId || bareId.length > MODEL_KEY_MAX_LENGTH) continue;

      const rawName = typeof rawModel.name === "string" ? rawModel.name.trim() : "";
      const name = (rawName || rawModelId.trim() || bareId).slice(0, MODEL_KEY_MAX_LENGTH);

      const entry: SyncedCatalogEntry = {
        id: bareId,
        name,
        provider: providerId,
        rates,
      };

      const scopedKey = `${providerId}/${bareId}`;
      if (scopedKey.length <= MODEL_KEY_MAX_LENGTH && !(scopedKey in providerModels)) {
        providerModels[scopedKey] = entry;
      }

      if (!(bareId in models) && canPopulateCanonicalModel(bareId, providerId)) {
        models[bareId] = entry;
      }
    }
  }

  if (Object.keys(models).length === 0) {
    throw new Error("models.dev payload contained no usable official model pricing entries.");
  }

  return syncedPricingCatalogSchema.parse({
    version: PRICING_CATALOG_SCHEMA_VERSION,
    source,
    syncedAt,
    models,
    providerModels,
  });
}

interface SyncedCatalogIndex {
  readonly byBare: ReadonlyMap<string, SyncedCatalogEntry>;
  readonly byProviderModel: ReadonlyMap<string, SyncedCatalogEntry>;
  readonly sortedBareEntries: readonly { readonly id: string; readonly entry: SyncedCatalogEntry }[];
}

const EMPTY_SYNCED_INDEX: SyncedCatalogIndex = {
  byBare: new Map(),
  byProviderModel: new Map(),
  sortedBareEntries: [],
};

function buildSyncedCatalogIndex(catalog?: SyncedPricingCatalog | null): SyncedCatalogIndex {
  if (!catalog) return EMPTY_SYNCED_INDEX;
  const byBare = new Map<string, SyncedCatalogEntry>();
  const byProviderModel = new Map<string, SyncedCatalogEntry>();

  for (const [rawKey, entry] of Object.entries(catalog.models)) {
    const key = normalizeModelKey(rawKey);
    if (key) byBare.set(key, entry);
  }
  for (const [rawKey, entry] of Object.entries(catalog.providerModels ?? {})) {
    const key = normalizeModelKey(rawKey);
    if (key) byProviderModel.set(key, entry);
  }

  const sortedBareEntries = Array.from(byBare.entries())
    .map(([id, entry]) => ({ id, entry }))
    .sort((left, right) => right.id.length - left.id.length || left.id.localeCompare(right.id));

  return { byBare, byProviderModel, sortedBareEntries };
}

/**
 * Generates exact version-separator aliases (e.g. `claude-sonnet-4.5` <-> `claude-sonnet-4-5`,
 * `gpt-4-1` <-> `gpt-4.1`) without mutating non-version tokens.
 */
function versionSeparatorAliases(bare: string): string[] {
  const aliases: string[] = [];
  const dotsToHyphens = bare.replace(/(\d)\.(\d)/g, "$1-$2");
  if (dotsToHyphens !== bare) aliases.push(dotsToHyphens);
  const hyphensToDots = bare.replace(/(\d)-(\d)/g, "$1.$2");
  if (hyphensToDots !== bare && !aliases.includes(hyphensToDots)) aliases.push(hyphensToDots);
  return aliases;
}

/**
 * Strips trailing release-date / snapshot / channel suffixes (e.g. `-20250929`,
 * `-2025-08-07`, `-preview-06-05`, `-latest`, `-exp`, `-001`, `@20250929`) while
 * preserving tier/size qualifiers like `-mini`, `-nano`, `-pro`, `-flash`.
 */
function stripReleaseSuffixes(bare: string): string {
  let current = bare;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current
      .replace(/[@:]\d{4,8}$/, "")
      .replace(/-\d{4}-\d{2}-\d{2}$/, "")
      .replace(/-\d{8}$/, "")
      .replace(/-\d{4}$/, "")
      .replace(/-\d{2}-\d{2}$/, "")
      .replace(/-\d{3}$/, "")
      .replace(/-(?:latest|preview|exp|experimental|beta|alpha|stable)$/, "");
    if (next === current || !next) break;
    current = next;
  }
  return current;
}

function lookupExactInSynced(
  candidate: string,
  normProvider: string,
  embeddedProvider: string,
  index: SyncedCatalogIndex,
): SyncedCatalogEntry | null {
  if (!candidate) return null;
  if (normProvider) {
    const scoped = index.byProviderModel.get(`${normProvider}/${candidate}`);
    if (scoped) return scoped;
  }
  if (embeddedProvider && embeddedProvider !== normProvider) {
    const scoped = index.byProviderModel.get(`${embeddedProvider}/${candidate}`);
    if (scoped) return scoped;
  }
  return index.byBare.get(candidate) ?? null;
}

function suffixHasDistinctQualifier(suffix: string): boolean {
  const cleaned = suffix.replace(/^[-._:@ ]+/, "");
  if (!cleaned) return false;
  const segments = cleaned.split(/[-._:@ ]+/);
  for (const segment of segments) {
    if (DISTINCT_MODEL_QUALIFIERS.has(segment)) return true;
  }
  return false;
}

function matchSyncedWithIndex(
  model: string,
  provider: string | null | undefined,
  index: SyncedCatalogIndex,
): SyncedCatalogEntry | null {
  if (index.byBare.size === 0 && index.byProviderModel.size === 0) return null;

  const normModel = normalizeModelKey(model);
  if (!normModel) return null;
  const bare = stripProviderPrefix(normModel);
  if (!bare) return null;
  const normProvider = provider ? normalizeModelKey(provider) : "";
  const embeddedProvider = extractEmbeddedProvider(normModel);

  // 1. Exact `(provider, model)` or canonical `model` match.
  const direct = lookupExactInSynced(bare, normProvider, embeddedProvider, index);
  if (direct) return direct;

  // 2. Exact version-separator alias (`claude-sonnet-4.5` <-> `claude-sonnet-4-5`).
  for (const alias of versionSeparatorAliases(bare)) {
    const hit = lookupExactInSynced(alias, normProvider, embeddedProvider, index);
    if (hit) return hit;
  }

  // 3. Release/date/preview suffix stripping (`gpt-5-2025-08-07` -> `gpt-5`, `gemini-2.5-pro-preview-06-05` -> `gemini-2.5-pro`).
  const stripped = stripReleaseSuffixes(bare);
  if (stripped && stripped !== bare) {
    const strippedHit = lookupExactInSynced(stripped, normProvider, embeddedProvider, index);
    if (strippedHit) return strippedHit;
    for (const alias of versionSeparatorAliases(stripped)) {
      const hit = lookupExactInSynced(alias, normProvider, embeddedProvider, index);
      if (hit) return hit;
    }
  }

  // 4. Conservative longest boundary-aligned prefix match, guarding against
  // distinct tier/modality suffixes (e.g. `o3-mini` != `o3`) and against
  // shadowing a more specific built-in reference family.
  const refPrefixLen = matchReferencePrefixLength(bare);
  for (const item of index.sortedBareEntries) {
    if (!matchesPrefixWithBoundary(bare, item.id)) continue;
    if (item.id.length < refPrefixLen) continue;
    const remainder = bare.slice(item.id.length);
    if (suffixHasDistinctQualifier(remainder)) continue;
    return item.entry;
  }

  return null;
}

/**
 * Matches a raw model ID (with optional provider hint) against a synced
 * official catalog, preferring exact `(provider, model)` and canonical official
 * IDs before version-alias, date-stripped, or safe prefix matches.
 */
export function matchSyncedCatalogEntry(
  model: string,
  catalog?: SyncedPricingCatalog | null,
  provider?: string | null,
): SyncedCatalogEntry | null {
  if (!catalog) return null;
  return matchSyncedWithIndex(model, provider, buildSyncedCatalogIndex(catalog));
}

// ---- Closest Official Pricing Suggestions --------------------------------------------------

export const pricingSuggestionSchema = z
  .object({
    /** Canonical model ID or built-in reference key of the suggested official model. */
    id: z.string().min(1).max(MODEL_KEY_MAX_LENGTH),
    /** Human-readable official model display name. */
    label: z.string().min(1).max(MODEL_KEY_MAX_LENGTH),
    /** Official provider ID if from synced catalog, or null if from built-in reference. */
    provider: z.string().nullable(),
    /** Source of the suggested rate ("synced" from models.dev or "reference" built-in). */
    source: z.enum(["synced", "reference"]),
    /** Suggested native per-1M token rates. */
    rates: modelRatesSchema,
    /** Optional short long-context / pricing note. */
    note: z.string().nullable(),
    /** Normalized match score in [0, 1] used for deterministic ranking. */
    score: z.number().min(0).max(1),
  })
  .strict();

export type PricingSuggestion = z.infer<typeof pricingSuggestionSchema>;

type GenericFamilyAnchor =
  | "deepseek"
  | "claude"
  | "gpt"
  | "openai-o"
  | "gemini"
  | "gemma"
  | "grok"
  | "moonshot"
  | "glm"
  | "qwen"
  | "minimax"
  | "mistral"
  | "command"
  | "sonar"
  | "llama"
  | "step";

const GLUED_FAMILY_RE =
  /^(deepseek|claude|gpt|gemini|gemma|grok|kimi|moonshot|glm|qwen|minimax|mistral|ministral|codestral|devstral|pixtral|magistral|voxtral|command|sonar|llama|step)(v?\d.*)$/;

const SPECIALIZED_MODALITY_MAP: Readonly<Record<string, string>> = {
  image: "image",
  imagen: "image",
  audio: "audio",
  tts: "tts",
  speech: "tts",
  transcribe: "transcribe",
  video: "video",
  embed: "embed",
  embedding: "embed",
  realtime: "realtime",
  live: "live",
  translate: "translate",
  moderation: "moderation",
  rerank: "rerank",
  ocr: "ocr",
};

const TIER_GROUP_MAP: Readonly<Record<string, string>> = {
  flash: "flash",
  flashx: "flash",
  pro: "pro",
  mini: "mini",
  nano: "nano",
  lite: "lite",
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  coder: "coder",
  codex: "coder",
  reasoner: "reasoner",
  r1: "reasoner",
  thinking: "reasoner",
  reasoning: "reasoner",
  chat: "chat",
  fast: "fast",
  turbo: "turbo",
  air: "air",
  ultra: "ultra",
  max: "max",
  plus: "plus",
  small: "small",
  medium: "medium",
  large: "large",
  highspeed: "fast",
  spot: "spot",
  search: "search",
  research: "research",
};

const FAST_LIGHT_QUERY_TIERS = new Set([
  "flash",
  "fast",
  "turbo",
  "lite",
  "mini",
  "nano",
  "air",
  "haiku",
  "small",
]);

const FAST_CHAT_COMPAT_TIERS = new Set([
  "chat",
  "flash",
  "mini",
  "lite",
  "nano",
  "haiku",
  "fast",
  "turbo",
  "air",
  "small",
]);

const FLAGSHIP_TIERS = new Set(["pro", "opus", "sonnet", "ultra", "max", "plus", "large"]);

const GENERAL_FLAGSHIP_TIERS = new Set(["pro", "sonnet", "chat", "opus", "plus", "large"]);

const HEAVY_TIERS = new Set(["pro", "opus", "ultra", "max", "reasoner", "coder"]);

const NOISE_TOKENS = new Set([
  "latest",
  "preview",
  "exp",
  "experimental",
  "beta",
  "alpha",
  "stable",
  "custom",
  "default",
  "official",
  "instruct",
  "it",
  "free",
]);

const SUGGESTION_NO_ANCHOR_MIN_SCORE = 0.35;
const SUGGESTION_WITHIN_FAMILY_MIN_SCORE = 0.15;

interface ParsedModelFeatures {
  readonly bare: string;
  readonly cleanedBare: string;
  readonly normalizedText: string;
  readonly tokens: readonly string[];
  readonly meaningfulTokens: ReadonlySet<string>;
  readonly family: GenericFamilyAnchor | null;
  readonly version: number | null;
  readonly tiers: ReadonlySet<string>;
  readonly modalities: ReadonlySet<string>;
}

interface CandidatePoolItem {
  readonly id: string;
  readonly label: string;
  readonly provider: string | null;
  readonly source: "synced" | "reference";
  readonly rates: ModelRates;
  readonly note: string | null;
  readonly features: ParsedModelFeatures;
}

function extractBareModelForMatching(raw: string): string {
  const normalized = normalizeModelKey(raw);
  if (!normalized) return "";
  const segments = normalized
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : "";
}

function tokenizeModelString(bare: string): string[] {
  const rawSegments = bare.split(/[-_:@/+\s]+/).filter((part) => part.length > 0);
  const tokens: string[] = [];
  for (const segment of rawSegments) {
    const glued = GLUED_FAMILY_RE.exec(segment);
    if (glued) {
      tokens.push(glued[1]!, glued[2]!);
    } else {
      tokens.push(segment);
    }
  }
  return tokens;
}

function detectFamilyAnchor(tokens: readonly string[]): GenericFamilyAnchor | null {
  for (const token of tokens) {
    if (token === "deepseek") return "deepseek";
    if (token === "claude") return "claude";
    if (token === "gpt" || token === "chatgpt") return "gpt";
    if (/^o[134](?:\.\d+)?$/.test(token)) return "openai-o";
    if (token === "gemini") return "gemini";
    if (token === "gemma") return "gemma";
    if (token === "grok") return "grok";
    if (token === "kimi" || token === "moonshot") return "moonshot";
    if (token === "glm" || token === "chatglm") return "glm";
    if (token === "qwen") return "qwen";
    if (token === "minimax") return "minimax";
    if (
      token === "mistral" ||
      token === "ministral" ||
      token === "codestral" ||
      token === "devstral" ||
      token === "pixtral" ||
      token === "magistral" ||
      token === "voxtral"
    ) {
      return "mistral";
    }
    if (token === "command") return "command";
    if (token === "sonar") return "sonar";
    if (token === "llama") return "llama";
    if (token === "step" || token === "stepfun") return "step";
  }
  return null;
}

function extractPrimaryVersion(tokens: readonly string[]): number | null {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    // Plain numeric version (e.g. `3.8`, `4`, `5.4`, or hyphenated `4` + `5` -> `4.5`).
    // Skip zero-padded tokens like `001` or `05` and large numbers like `70`, `128`, `2025`.
    if (!/^0\d/.test(token)) {
      const plain = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(token);
      if (plain) {
        const major = Number(plain[1]);
        if (major >= 1 && major <= 20) {
          if (plain[2] !== undefined) {
            return Number(`${major}.${plain[2]}`);
          }
          const next = tokens[i + 1];
          if (next !== undefined && /^\d$/.test(next)) {
            return Number(`${major}.${next}`);
          }
          return major;
        }
      }
    }

    // Letter-prefixed series version (`v3.2`, `v4`, `k3.1`, `m3`).
    const prefixed = /^[vkm](\d{1,2})(?:\.(\d{1,2}))?$/.exec(token);
    if (prefixed) {
      const major = Number(prefixed[1]);
      if (major >= 1 && major <= 20) {
        return prefixed[2] !== undefined ? Number(`${major}.${prefixed[2]}`) : major;
      }
    }

    // OpenAI o-series (`o1`, `o3`, `o4`) and DeepSeek r-series (`r1`, `r2`).
    const series = /^[or]([1-9])(?:\.(\d{1,2}))?$/.exec(token);
    if (series) {
      return series[2] !== undefined ? Number(`${series[1]}.${series[2]}`) : Number(series[1]);
    }

    // Omni suffix (`4o` -> `4`).
    const omni = /^(\d{1,2})o$/.exec(token);
    if (omni) {
      const major = Number(omni[1]);
      if (major >= 1 && major <= 20) return major;
    }
  }
  return null;
}

function parseModelFeatures(rawModel: string): ParsedModelFeatures {
  const bare = extractBareModelForMatching(rawModel);
  const cleanedBare = stripReleaseSuffixes(bare) || bare;
  const rawTokens = tokenizeModelString(bare);
  const cleanedTokens = tokenizeModelString(cleanedBare);

  const family = detectFamilyAnchor(cleanedTokens) ?? detectFamilyAnchor(rawTokens);
  const version = extractPrimaryVersion(cleanedTokens);

  const tiers = new Set<string>();
  for (const token of cleanedTokens) {
    const group = TIER_GROUP_MAP[token];
    if (group) tiers.add(group);
  }

  // Inspect raw tokens for modalities so trailing release/preview suffixes never hide them.
  const modalities = new Set<string>();
  for (const token of rawTokens) {
    const modality = SPECIALIZED_MODALITY_MAP[token];
    if (modality) modalities.add(modality);
  }

  const normalizedText = cleanedBare.replace(/(\d)-(\d)/g, "$1.$2");
  const meaningfulTokens = new Set<string>();
  for (const token of tokenizeModelString(normalizedText)) {
    if (!NOISE_TOKENS.has(token)) {
      meaningfulTokens.add(token);
    }
  }

  return {
    bare,
    cleanedBare,
    normalizedText,
    tokens: cleanedTokens,
    meaningfulTokens,
    family,
    version,
    tiers,
    modalities,
  };
}

function tokenJaccardSimilarity(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  const union = left.size + right.size - shared;
  return union > 0 ? shared / union : 0;
}

function charBigramDiceSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const leftCounts = new Map<string, number>();
  const leftTotal = left.length - 1;
  for (let i = 0; i < leftTotal; i += 1) {
    const gram = left.slice(i, i + 2);
    leftCounts.set(gram, (leftCounts.get(gram) ?? 0) + 1);
  }

  let shared = 0;
  const rightTotal = right.length - 1;
  for (let i = 0; i < rightTotal; i += 1) {
    const gram = right.slice(i, i + 2);
    const remaining = leftCounts.get(gram) ?? 0;
    if (remaining > 0) {
      shared += 1;
      leftCounts.set(gram, remaining - 1);
    }
  }

  return (2 * shared) / (leftTotal + rightTotal);
}

function buildSuggestionCandidatePool(
  syncedCatalog?: SyncedPricingCatalog | null,
): CandidatePoolItem[] {
  const pool: CandidatePoolItem[] = [];
  const seenIds = new Set<string>();

  if (syncedCatalog?.models) {
    for (const entry of Object.values(syncedCatalog.models)) {
      const id = normalizeModelKey(entry.id);
      if (!id || id.length > MODEL_KEY_MAX_LENGTH || seenIds.has(id)) continue;
      seenIds.add(id);
      const label = (entry.name.trim() || id).slice(0, MODEL_KEY_MAX_LENGTH);
      pool.push({
        id,
        label,
        provider: entry.provider,
        source: "synced",
        rates: { ...entry.rates },
        note: formatLongContextNote(entry.rates),
        features: parseModelFeatures(id),
      });
    }
  }

  for (const entry of REFERENCE_PRICING) {
    if (entry.suggestable === false) continue;
    const id = normalizeModelKey(entry.key);
    if (!id || id.length > MODEL_KEY_MAX_LENGTH || seenIds.has(id)) continue;
    seenIds.add(id);
    pool.push({
      id,
      label: entry.label.slice(0, MODEL_KEY_MAX_LENGTH),
      provider: null,
      source: "reference",
      rates: { ...entry.rates },
      note: entry.note ?? formatLongContextNote(entry.rates),
      features: parseModelFeatures(id),
    });
  }

  return pool;
}

function hasAnyTier(tiers: ReadonlySet<string>, target: ReadonlySet<string>): boolean {
  for (const tier of tiers) {
    if (target.has(tier)) return true;
  }
  return false;
}

function scoreWithinFamilyTier(
  queryTiers: ReadonlySet<string>,
  candTiers: ReadonlySet<string>,
): number {
  if (queryTiers.size === 0) {
    if (candTiers.size === 0) return 0.12;
    if (hasAnyTier(candTiers, GENERAL_FLAGSHIP_TIERS)) return 0.09;
    if (candTiers.has("flash")) return 0.06;
    if (candTiers.has("reasoner")) return 0.02;
    return -0.05;
  }

  let overlap = 0;
  for (const tier of queryTiers) {
    if (candTiers.has(tier)) overlap += 1;
  }

  if (overlap > 0) {
    const extraCand = candTiers.size - overlap;
    const missingQuery = queryTiers.size - overlap;
    if (extraCand === 0 && missingQuery === 0) return 0.28;
    return 0.28 * (overlap / (overlap + 0.5 * extraCand + 0.7 * missingQuery));
  }

  // No exact tier overlap: apply soft compatibility rules.
  if (hasAnyTier(queryTiers, FAST_LIGHT_QUERY_TIERS)) {
    if (hasAnyTier(candTiers, FAST_CHAT_COMPAT_TIERS)) return 0.1;
    if (candTiers.size === 0) return 0.02;
    if (hasAnyTier(candTiers, HEAVY_TIERS)) return -0.08;
    return -0.04;
  }

  if (hasAnyTier(queryTiers, FLAGSHIP_TIERS)) {
    if (candTiers.size === 0 || hasAnyTier(candTiers, FLAGSHIP_TIERS)) return 0.05;
    if (hasAnyTier(candTiers, FAST_LIGHT_QUERY_TIERS)) return -0.08;
    return -0.04;
  }

  if (queryTiers.has("reasoner") || queryTiers.has("coder")) {
    if (candTiers.size === 0 || hasAnyTier(candTiers, GENERAL_FLAGSHIP_TIERS)) return 0.02;
    return -0.08;
  }

  return candTiers.size === 0 ? 0 : -0.08;
}

function scoreWithinFamilyVersion(
  queryVersion: number | null,
  candVersion: number | null,
  maxFamilyVersion: number | null,
): number {
  const weight = 0.24;
  if (queryVersion !== null && candVersion !== null) {
    if (maxFamilyVersion !== null && queryVersion > maxFamilyVersion) {
      // Query is newer than every known official model in this family: strongly prefer the newest ones.
      const gapFromTop = Math.max(0, maxFamilyVersion - candVersion);
      return weight * (1 / (1 + gapFromTop * 1.1));
    }
    const diff = Math.abs(queryVersion - candVersion);
    if (diff === 0) return weight;
    const proximity = 1 / (1 + diff * 1.25);
    const newerNudge = candVersion > queryVersion ? 0.01 : 0;
    return weight * Math.min(1, proximity + newerNudge);
  }
  if (queryVersion !== null && candVersion === null) {
    return weight * 0.35;
  }
  if (queryVersion === null && candVersion !== null) {
    if (maxFamilyVersion !== null) {
      const gapFromTop = Math.max(0, maxFamilyVersion - candVersion);
      return weight * 0.5 * (1 / (1 + gapFromTop * 0.8));
    }
    return weight * 0.5;
  }
  return weight * 0.5;
}

function scoreModalityAlignment(
  queryModalities: ReadonlySet<string>,
  candModalities: ReadonlySet<string>,
): number {
  let candExtra = 0;
  for (const mod of candModalities) {
    if (!queryModalities.has(mod)) candExtra += 1;
  }
  if (candExtra > 0) return -0.55;

  if (queryModalities.size === 0) return 0;

  let matched = 0;
  for (const mod of queryModalities) {
    if (candModalities.has(mod)) matched += 1;
  }
  if (matched === queryModalities.size) return 0.15;
  if (matched > 0) return 0.06;
  return -0.22;
}

function clampAndRoundScore(raw: number): number {
  const clamped = Math.max(0, Math.min(1, raw));
  return Math.round(clamped * 1000) / 1000;
}

function compareSuggestions(left: PricingSuggestion, right: PricingSuggestion): number {
  if (left.score !== right.score) return right.score - left.score;
  const leftSourceRank = left.source === "synced" ? 0 : 1;
  const rightSourceRank = right.source === "synced" ? 0 : 1;
  if (leftSourceRank !== rightSourceRank) return leftSourceRank - rightSourceRank;

  const leftProviderRank = officialProviderRank(left.provider);
  const rightProviderRank = officialProviderRank(right.provider);
  if (leftProviderRank !== rightProviderRank) {
    return leftProviderRank < rightProviderRank ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Computes the closest matching official pricing candidates for non-standard
 * or relay-prefixed model names (e.g. `proxy/sub/gemini-3.8-flash` -> Gemini
 * Flash official models), combining synced `models.dev` entries (preferred on
 * duplicate IDs) with built-in generic reference entries.
 *
 * Strictly generic & runtime-neutral (Hermes-safe, zero `node:*`, zero regex
 * lookbehind).
 */
export function suggestClosestPricing(
  model: string,
  syncedCatalog?: SyncedPricingCatalog | null,
  maxSuggestions: number = 3,
): PricingSuggestion[] {
  const limit = Math.floor(maxSuggestions);
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const query = parseModelFeatures(model);
  if (!query.bare) return [];

  const pool = buildSuggestionCandidatePool(syncedCatalog);
  if (pool.length === 0) return [];

  const scored: PricingSuggestion[] = [];

  if (query.family !== null) {
    const familyCandidates = pool.filter((item) => item.features.family === query.family);
    if (familyCandidates.length === 0) return [];

    // Compute highest known version among non-specialized-modality models in this family
    // (falling back to all family candidates if every candidate is specialized).
    let maxFamilyVersion: number | null = null;
    for (const item of familyCandidates) {
      if (item.features.version === null) continue;
      if (query.modalities.size === 0 && item.features.modalities.size > 0) continue;
      if (maxFamilyVersion === null || item.features.version > maxFamilyVersion) {
        maxFamilyVersion = item.features.version;
      }
    }
    if (maxFamilyVersion === null) {
      for (const item of familyCandidates) {
        if (item.features.version === null) continue;
        if (maxFamilyVersion === null || item.features.version > maxFamilyVersion) {
          maxFamilyVersion = item.features.version;
        }
      }
    }

    for (const item of familyCandidates) {
      const tierScore = scoreWithinFamilyTier(query.tiers, item.features.tiers);
      const versionScore = scoreWithinFamilyVersion(
        query.version,
        item.features.version,
        maxFamilyVersion,
      );
      const modalityScore = scoreModalityAlignment(query.modalities, item.features.modalities);
      const lexical =
        0.5 * tokenJaccardSimilarity(query.meaningfulTokens, item.features.meaningfulTokens) +
        0.5 * charBigramDiceSimilarity(query.normalizedText, item.features.normalizedText);

      const rawScore = 0.32 + tierScore + versionScore + modalityScore + 0.14 * lexical;
      if (rawScore < SUGGESTION_WITHIN_FAMILY_MIN_SCORE) continue;

      scored.push({
        id: item.id,
        label: item.label,
        provider: item.provider,
        source: item.source,
        rates: { ...item.rates },
        note: item.note,
        score: clampAndRoundScore(rawScore),
      });
    }
  } else {
    for (const item of pool) {
      const tokenOverlap = tokenJaccardSimilarity(
        query.meaningfulTokens,
        item.features.meaningfulTokens,
      );
      const bigramDice = charBigramDiceSimilarity(
        query.normalizedText,
        item.features.normalizedText,
      );
      let rawScore = 0.55 * tokenOverlap + 0.45 * bigramDice;

      // Guard against suggesting specialized modality rates for generic text names.
      for (const mod of item.features.modalities) {
        if (!query.modalities.has(mod)) {
          rawScore -= 0.4;
          break;
        }
      }

      const finalScore = clampAndRoundScore(rawScore);
      if (finalScore < SUGGESTION_NO_ANCHOR_MIN_SCORE) continue;

      scored.push({
        id: item.id,
        label: item.label,
        provider: item.provider,
        source: item.source,
        rates: { ...item.rates },
        note: item.note,
        score: finalScore,
      });
    }
  }

  scored.sort(compareSuggestions);
  return scored.slice(0, limit);
}

// ---- Rate Resolution & Cost Calculation ----------------------------------------------------

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
  /** Canonical pricing key (matched override key, synced model ID, or built-in family key). */
  pricingKey: string;
  /** Effective rates used for cost calculation. */
  rates: ModelRates;
  /** Whether the rates came from a user override, synced official catalog, or built-in reference. */
  source: PricingRateSource;
  /** Matched built-in reference entry, if any (retained even when overridden or synced). */
  reference: ReferencePricingEntry | null;
  /** Matched synced official catalog entry, if any (retained even when overridden). */
  synced: SyncedCatalogEntry | null;
}

export interface PricingCallInput {
  model: string;
  provider?: string | null;
  tokens: TokenUsageInput;
  /** Optional call timestamp (ms since epoch) used for scheduled official rate changes. */
  at?: number;
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
  /** Canonical pricing key (override key, synced model ID, matched family key, or stripped model ID). */
  pricingKey: string;
  /** True when long-context tier rates were applied. */
  longContext: boolean;
  /** Rate provenance, or null when unpriced. */
  source: PricingRateSource | null;
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
 * so usage aggregation can price calls in one pass with pre-normalized overrides
 * and synced official catalog entries.
 */
export interface PricingResolver {
  readonly displayCurrency: Currency;
  readonly usdToCnyRate: number;
  readonly hasCustomPricing: boolean;
  resolveKey(model: string, provider?: string | null): string;
  resolveRates(model: string, provider?: string | null, at?: number): ResolvedModelRates | null;
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

function isAntigravityRequest(normModel: string, normProvider: string): boolean {
  return normProvider === "antigravity" || normModel.startsWith("antigravity/");
}

function candidateOverrideKeys(
  normModel: string,
  bare: string,
  normProvider: string,
  synced: SyncedCatalogEntry | null,
  ref: ReferencePricingEntry | null,
  extraCanonicalKeys?: readonly string[],
): string[] {
  const keys: string[] = [];
  const push = (candidate: string): void => {
    if (candidate && !keys.includes(candidate)) keys.push(candidate);
  };

  if (normProvider && !normModel.startsWith(`${normProvider}/`)) {
    push(`${normProvider}/${normModel}`);
  }
  if (normProvider && bare && bare !== normModel) {
    push(`${normProvider}/${bare}`);
  }
  push(normModel);
  if (bare && bare !== normModel) {
    push(bare);
  }
  if (extraCanonicalKeys) {
    for (const extra of extraCanonicalKeys) {
      push(extra);
    }
  }
  if (synced) {
    push(synced.id);
  }
  if (ref) {
    push(ref.key);
  }
  return keys;
}

function resolveWithIndexes(
  model: string,
  provider: string | null | undefined,
  overrideMap: ReadonlyMap<string, ModelRates>,
  syncedIndex: SyncedCatalogIndex,
  at?: number,
): ResolvedModelRates | null {
  const normModel = normalizeModelKey(model);
  if (!normModel) return null;
  const normProvider = provider ? normalizeModelKey(provider) : "";
  const bare = stripProviderPrefix(normModel);
  const antigravity = isAntigravityRequest(normModel, normProvider);
  const agRef = antigravity ? matchAntigravityReferenceEntry(normModel, at) : null;
  const genericRef = matchReferenceEntry(bare, at);
  const ref = agRef ?? genericRef;
  const synced = matchSyncedWithIndex(agRef ? agRef.key : normModel, normProvider, syncedIndex);
  const extraKeys: string[] = [];
  if (agRef) extraKeys.push(agRef.key);
  if (genericRef && genericRef.key !== agRef?.key) extraKeys.push(genericRef.key);

  for (const key of candidateOverrideKeys(normModel, bare, normProvider, synced, ref, extraKeys)) {
    const override = overrideMap.get(key);
    if (override) {
      return {
        pricingKey: key,
        rates: override,
        source: "override",
        reference: ref,
        synced,
      };
    }
  }
  if (synced) {
    return {
      pricingKey: synced.id,
      rates: synced.rates,
      source: "synced",
      reference: ref,
      synced,
    };
  }
  if (ref) {
    return {
      pricingKey: ref.key,
      rates: ref.rates,
      source: "reference",
      reference: ref,
      synced: null,
    };
  }
  return null;
}

function resolveKeyWithIndexes(
  model: string,
  provider: string | null | undefined,
  overrideMap: ReadonlyMap<string, ModelRates>,
  syncedIndex: SyncedCatalogIndex,
): string {
  const normModel = normalizeModelKey(model);
  if (!normModel) return "unknown";
  const normProvider = provider ? normalizeModelKey(provider) : "";
  const bare = stripProviderPrefix(normModel);
  const antigravity = isAntigravityRequest(normModel, normProvider);
  const agRef = antigravity ? matchAntigravityReferenceEntry(normModel) : null;
  const genericRef = matchReferenceEntry(bare);
  const ref = agRef ?? genericRef;
  const synced = matchSyncedWithIndex(agRef ? agRef.key : normModel, normProvider, syncedIndex);
  const extraKeys: string[] = [];
  if (agRef) extraKeys.push(agRef.key);
  if (genericRef && genericRef.key !== agRef?.key) extraKeys.push(genericRef.key);

  for (const key of candidateOverrideKeys(normModel, bare, normProvider, synced, ref, extraKeys)) {
    if (overrideMap.has(key)) return key;
  }
  if (synced) return synced.id;
  if (ref) return ref.key;
  if (antigravity) {
    const fallbackKey = resolveAntigravityPricingKey(normModel);
    if (fallbackKey && fallbackKey !== "unknown") return fallbackKey;
  }
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
  syncedCatalog?: SyncedPricingCatalog | null,
): string {
  return resolveKeyWithIndexes(
    model,
    provider,
    buildOverrideMap(overrides),
    buildSyncedCatalogIndex(syncedCatalog),
  );
}

/**
 * Resolves effective rates for a model: user overrides win first, followed by
 * the synced official API catalog, followed by built-in family references,
 * followed by `null` (unpriced).
 */
export function resolveModelRates(
  model: string,
  overrides?: Readonly<Record<string, ModelRates>>,
  provider?: string | null,
  syncedCatalog?: SyncedPricingCatalog | null,
  at?: number,
): ResolvedModelRates | null {
  return resolveWithIndexes(
    model,
    provider,
    buildOverrideMap(overrides),
    buildSyncedCatalogIndex(syncedCatalog),
    at,
  );
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

function priceCallWithIndexes(
  input: PricingCallInput,
  displayCurrency: Currency,
  usdToCnyRate: number,
  overrideMap: ReadonlyMap<string, ModelRates>,
  syncedIndex: SyncedCatalogIndex,
): CallCostResult {
  const resolved = resolveWithIndexes(input.model, input.provider, overrideMap, syncedIndex, input.at);
  if (!resolved) {
    return {
      priced: false,
      nativeCost: null,
      nativeCurrency: null,
      cost: null,
      displayCurrency,
      pricingKey: resolveKeyWithIndexes(input.model, input.provider, overrideMap, syncedIndex),
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
 * no override or synced rate return `{ priced: false, cost: null, nativeCost: null, ... }`.
 */
export function calculateCallCost(
  input: PricingCallInput,
  config: Pick<PricingConfig, "displayCurrency" | "usdToCnyRate" | "overrides"> = defaultPricingConfig(),
  syncedCatalog?: SyncedPricingCatalog | null,
): CallCostResult {
  const displayCurrency = currencySchema.parse(config.displayCurrency);
  const rate = exchangeRateSchema.parse(config.usdToCnyRate);
  const overrideMap = buildOverrideMap(config.overrides);
  const syncedIndex = buildSyncedCatalogIndex(syncedCatalog);
  return priceCallWithIndexes(input, displayCurrency, rate, overrideMap, syncedIndex);
}

/**
 * Builds a reusable, pre-indexed {@link PricingResolver} (`UsagePricer`) suitable for
 * pricing thousands of calls in one aggregation pass.
 */
export function createPricingResolver(
  config: Partial<Pick<PricingConfig, "displayCurrency" | "usdToCnyRate" | "overrides">> = {},
  syncedCatalog?: SyncedPricingCatalog | null,
): PricingResolver {
  const displayCurrency = currencySchema.parse(config.displayCurrency ?? DEFAULT_DISPLAY_CURRENCY);
  const usdToCnyRate = exchangeRateSchema.parse(config.usdToCnyRate ?? DEFAULT_USD_TO_CNY_RATE);
  const overrideMap = buildOverrideMap(config.overrides);
  const syncedIndex = buildSyncedCatalogIndex(syncedCatalog);
  const hasCustomPricing = overrideMap.size > 0;

  return {
    displayCurrency,
    usdToCnyRate,
    hasCustomPricing,
    resolveKey(model: string, provider?: string | null): string {
      return resolveKeyWithIndexes(model, provider, overrideMap, syncedIndex);
    },
    resolveRates(model: string, provider?: string | null, at?: number): ResolvedModelRates | null {
      return resolveWithIndexes(model, provider, overrideMap, syncedIndex, at);
    },
    priceCall(input: PricingCallInput): CallCostResult {
      return priceCallWithIndexes(input, displayCurrency, usdToCnyRate, overrideMap, syncedIndex);
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
  syncedCatalog?: SyncedPricingCatalog | null,
): CostAggregation {
  const resolver = isPricingResolver(resolverOrConfig)
    ? resolverOrConfig
    : createPricingResolver(resolverOrConfig, syncedCatalog);
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

export const pricingSyncStatusSchema = z.object({
  autoSync: z.boolean(),
  source: z.string().min(1).max(PROVIDER_KEY_MAX_LENGTH),
  /** ISO timestamp of the last successful sync, or null when never synced. */
  syncedAt: z.string().nullable(),
  /** Number of canonical official models currently loaded from the synced catalog. */
  modelCount: z.number().int().nonnegative(),
  /** True while a catalog sync request is currently in flight. */
  syncing: z.boolean(),
  /** Error summary from the most recent failed sync attempt, or null if healthy. */
  lastError: z.string().nullable(),
});

export type PricingSyncStatus = z.infer<typeof pricingSyncStatusSchema>;

export const pricingModelRowSchema = z.object({
  key: z.string().min(1).max(MODEL_KEY_MAX_LENGTH),
  label: z.string().min(1).max(MODEL_KEY_MAX_LENGTH),
  family: modelFamilySchema.nullable(),
  prefixes: z.array(z.string()),
  /** Built-in family reference rates, or null for custom/synced-only/unrecognized models. */
  reference: modelRatesSchema.nullable(),
  /** Synced official API rates from `models.dev`, or null when unavailable. */
  synced: modelRatesSchema.nullable(),
  /** Official provider ID for `synced` rates (e.g. `"deepseek"`, `"anthropic"`), or null. */
  syncedProvider: z.string().nullable(),
  /** User-configured override rates, or null when not overridden. */
  custom: modelRatesSchema.nullable(),
  /** Effective rates currently applied (`custom ?? synced ?? reference`), or null when unpriced. */
  effective: modelRatesSchema.nullable(),
  /** Provenance of `effective` (`"override" | "synced" | "reference"`), or null when unpriced. */
  source: pricingRateSourceSchema.nullable(),
  /** Optional short note describing reference or synced long-context tiers. */
  note: z.string().nullable(),
  /** True when this model appeared in local DSH session logs. */
  seenLocally: z.boolean(),
  /** True when this model is currently configured in the user's active DSH profile. */
  configured: z.boolean().optional(),
  /** Closest official pricing candidates for non-standard/unmatched model names (best first). */
  suggestions: z.array(pricingSuggestionSchema).optional(),
});

export type PricingModelRow = z.infer<typeof pricingModelRowSchema>;

export const pricingStateSchema = z.object({
  version: z.literal(PRICING_SCHEMA_VERSION),
  displayCurrency: currencySchema,
  usdToCnyRate: exchangeRateSchema,
  autoSync: z.boolean(),
  sync: pricingSyncStatusSchema,
  models: z.array(pricingModelRowSchema),
  overrides: z.record(z.string(), modelRatesSchema),
  hasCustomOverrides: z.boolean(),
  /**
   * Summary of the persisted-config read failure that forced built-in defaults
   * in this session, or null when the config loaded cleanly (or was simply absent).
   */
  readError: z.string().nullable(),
  /**
   * True when the persisted config file was unreadable (corrupt JSON,
   * schema-invalid, or I/O failure) and built-in defaults were applied. Stays
   * true after a successful rewrite so `corruptBackupPath` remains discoverable.
   */
  recoveredFromCorruption: z.boolean(),
  /**
   * Absolute path of the `.corrupt-<timestamp>` backup kept when the persisted
   * config could not be read, or null when no backup was made.
   */
  corruptBackupPath: z.string().nullable(),
});

export type PricingState = z.infer<typeof pricingStateSchema>;

export const pricingUpdateInputSchema = z
  .object({
    displayCurrency: currencySchema.optional(),
    usdToCnyRate: exchangeRateSchema.optional(),
    autoSync: z.boolean().optional(),
    /** Model key to set or clear an override for. Must be paired with `rates`. */
    key: z.string().trim().min(1).max(MODEL_KEY_MAX_LENGTH).optional(),
    /** Custom rates for `key`, or `null` to delete the override for `key`. */
    rates: modelRatesSchema.nullable().optional(),
    /** Clear all custom overrides while keeping `displayCurrency`, `usdToCnyRate`, and `autoSync`. */
    resetOverrides: z.boolean().optional(),
    /** Reset overrides, `displayCurrency`, `usdToCnyRate`, and `autoSync` back to built-in defaults. */
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
      value.autoSync === undefined &&
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

export const pricingSyncInputSchema = z
  .object({
    /** Force a network sync even when the disk cache is still fresh (defaults to `true`). */
    force: z.boolean().optional(),
  })
  .strict();

export type PricingSyncInput = z.infer<typeof pricingSyncInputSchema>;

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

export const pricingSyncRpc = defineRpc({
  name: "dsh.pricing.sync",
  input: pricingSyncInputSchema,
  output: pricingStateSchema,
});
