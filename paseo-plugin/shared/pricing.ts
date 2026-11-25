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
  synced: SyncedCatalogEntry | null,
  ref: ReferencePricingEntry | null,
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
): ResolvedModelRates | null {
  const normModel = normalizeModelKey(model);
  if (!normModel) return null;
  const normProvider = provider ? normalizeModelKey(provider) : "";
  const bare = stripProviderPrefix(normModel);
  const synced = matchSyncedWithIndex(normModel, normProvider, syncedIndex);
  const ref = matchReferenceEntry(bare);

  for (const key of candidateOverrideKeys(normModel, bare, normProvider, synced, ref)) {
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
  const synced = matchSyncedWithIndex(normModel, normProvider, syncedIndex);
  const ref = matchReferenceEntry(bare);

  for (const key of candidateOverrideKeys(normModel, bare, normProvider, synced, ref)) {
    if (overrideMap.has(key)) return key;
  }
  if (synced) return synced.id;
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
): ResolvedModelRates | null {
  return resolveWithIndexes(
    model,
    provider,
    buildOverrideMap(overrides),
    buildSyncedCatalogIndex(syncedCatalog),
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
  const resolved = resolveWithIndexes(input.model, input.provider, overrideMap, syncedIndex);
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
    resolveRates(model: string, provider?: string | null): ResolvedModelRates | null {
      return resolveWithIndexes(model, provider, overrideMap, syncedIndex);
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
