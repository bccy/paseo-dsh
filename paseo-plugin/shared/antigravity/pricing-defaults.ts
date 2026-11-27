/**
 * Built-in Antigravity model pricing reference table, canonical pricing-key
 * normalization helpers, and legacy `antigravity-accounts/pricing.json`
 * override parser.
 *
 * Kept strictly runtime-neutral (`zod` only; zero `node:*` imports,
 * Hermes/React Native safe) so both the daemon server and client bundles can
 * import it directly.
 *
 * Rates are official published USD per 1M tokens. Output rates include
 * thinking/reasoning tokens, matching `agy`'s `usage.output` field.
 *
 * @module dsh-paseo/shared/antigravity/pricing-defaults
 */
import { z } from "zod";

export interface AntigravityModelRates {
  /** Uncached input tokens, USD per 1M tokens. */
  input: number;
  /** Context-cache read tokens, USD per 1M tokens. */
  cached: number;
  /** Output tokens (including thinking tokens), USD per 1M tokens. */
  output: number;
  /** Optional prompt token threshold (e.g. 200,000) above which long-context rates apply. */
  longContextThreshold?: number;
  longInput?: number;
  longCached?: number;
  longOutput?: number;
}

/** Compatibility alias for Antigravity modules expecting `ModelRates`. */
export type ModelRates = AntigravityModelRates;

export interface ScheduledRate {
  /** ISO timestamp from which this rate takes effect. */
  effectiveFrom: string;
  rates: AntigravityModelRates;
}

export type AntigravityPricingProvider = "Google" | "Anthropic" | "OpenAI";

export interface AntigravityDefaultPricingEntry {
  key: string;
  label: string;
  provider: AntigravityPricingProvider;
  rates: AntigravityModelRates;
  /** Optional scheduled official rate changes (e.g. post-introductory pricing). */
  scheduled?: readonly ScheduledRate[];
  note?: string;
}

/** Compatibility alias for Antigravity modules expecting `DefaultPricingEntry`. */
export type DefaultPricingEntry = AntigravityDefaultPricingEntry;

/** USD rate object shaped for `dsh-paseo`'s dual-currency `PricingStore`. */
export interface UsdDualCurrencyModelRates extends AntigravityModelRates {
  currency: "USD";
}

const ONE_MILLION = 1_000_000;
const LEGACY_MAX_RATE_PER_MILLION = 10_000;
const LEGACY_MAX_LONG_CONTEXT_THRESHOLD = 10_000_000;
const LEGACY_MODEL_KEY_MAX_LENGTH = 160;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Built-in official API pricing catalog (USD / 1M tokens) for models exposed
 * by Antigravity (`agy`).
 * Checked against https://ai.google.dev/gemini-api/docs/pricing (2026-11).
 */
export const ANTIGRAVITY_DEFAULT_PRICING: readonly AntigravityDefaultPricingEntry[] = [
  {
    key: "gemini-4-neon",
    label: "Gemini 4 Neon",
    provider: "Google",
    rates: { input: 3.0, cached: 0.15, output: 15.0 },
  },
  {
    key: "gemini-4-carbon",
    label: "Gemini 4 Carbon",
    provider: "Google",
    rates: { input: 2.0, cached: 0.1, output: 10.0 },
    scheduled: [
      {
        effectiveFrom: "2026-12-01T00:00:00Z",
        rates: { input: 4.0, cached: 0.2, output: 20.0 },
      },
    ],
    note: "$2/$10 through 2026-11-30; $4/$20 from 2026-12-01",
  },
  {
    key: "gemini-4-argon",
    label: "Gemini 4 Argon",
    provider: "Google",
    rates: { input: 2.0, cached: 0.1, output: 10.0 },
    scheduled: [
      {
        effectiveFrom: "2026-12-01T00:00:00Z",
        rates: { input: 4.0, cached: 0.2, output: 20.0 },
      },
    ],
    note: "$2/$10 through 2026-11-30; $4/$20 from 2026-12-01",
  },
  {
    key: "gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen",
    provider: "Google",
    rates: { input: 1.5, cached: 0.075, output: 7.5 },
  },
  {
    key: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    provider: "Google",
    rates: { input: 0.75, cached: 0.075, output: 3.75 },
    scheduled: [
      {
        effectiveFrom: "2027-01-01T00:00:00Z",
        rates: { input: 1.5, cached: 0.15, output: 7.5 },
      },
    ],
    note: "$0.75/$3.75 through 2026-12-31; $1.50/$7.50 from 2027-01-01",
  },
  {
    key: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    provider: "Google",
    rates: { input: 0.75, cached: 0.075, output: 3.75 },
    scheduled: [
      {
        effectiveFrom: "2027-01-01T00:00:00Z",
        rates: { input: 1.5, cached: 0.15, output: 7.5 },
      },
    ],
    note: "$0.75/$3.75 through 2026-12-31; $1.50/$7.50 from 2027-01-01",
  },
  {
    key: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    provider: "Google",
    rates: { input: 0.3, cached: 0.03, output: 2.5 },
  },
  {
    key: "gemini-3.1-pro",
    label: "Gemini 3.1 Pro",
    provider: "Google",
    rates: {
      input: 2.0,
      cached: 0.2,
      output: 12.0,
      longContextThreshold: 200_000,
      longInput: 4.0,
      longCached: 0.4,
      longOutput: 18.0,
    },
    note: ">200K prompts: $4/$18 ($0.40 cached)",
  },
  {
    key: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    provider: "Google",
    rates: { input: 0.25, cached: 0.025, output: 1.5 },
  },
  {
    key: "gemini-3-flash",
    label: "Gemini 3 Flash",
    provider: "Google",
    rates: { input: 0.5, cached: 0.05, output: 3.0 },
  },
  {
    key: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "Google",
    rates: {
      input: 1.25,
      cached: 0.125,
      output: 10.0,
      longContextThreshold: 200_000,
      longInput: 2.5,
      longCached: 0.25,
      longOutput: 15.0,
    },
    note: ">200K prompts: $2.50/$15 ($0.25 cached)",
  },
  {
    key: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "Google",
    rates: { input: 0.3, cached: 0.03, output: 2.5 },
  },
  {
    key: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    provider: "Google",
    rates: { input: 0.1, cached: 0.01, output: 0.4 },
  },
  {
    key: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    provider: "Anthropic",
    rates: { input: 4.0, cached: 0.2, output: 20.0 },
  },
  {
    key: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    provider: "Anthropic",
    rates: { input: 2.0, cached: 0.1, output: 10.0 },
  },
  {
    key: "gpt-oss-120b",
    label: "GPT-OSS 120B",
    provider: "OpenAI",
    rates: { input: 0.15, cached: 0.075, output: 0.6 },
  },
];

const BY_KEY = new Map<string, AntigravityDefaultPricingEntry>(
  ANTIGRAVITY_DEFAULT_PRICING.map((entry) => [entry.key, entry]),
);

export function defaultPricingEntry(key: string): AntigravityDefaultPricingEntry | undefined {
  return BY_KEY.get(key.trim().toLowerCase());
}

/**
 * Resolves an `agy` model id and/or display label to its canonical pricing family key.
 * Strips effort suffixes (`-low`/`-xhigh`, `(High)`), maps Orchestrator / worker aliases to their
 * underlying model family, and falls back to a normalized id/label so unknown models can still be
 * priced by user overrides.
 */
export function resolvePricingKey(
  modelId: string | null | undefined,
  label?: string | null | undefined,
): string {
  const candidates = [modelId, label]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase().replace(/^antigravity\//, ""));

  for (const raw of candidates) {
    // Exact canonical match first.
    if (BY_KEY.has(raw)) return raw;

    // Orchestrator & worker aliases.
    if (raw === "gemini-flash-worker-agy" || raw.includes("hydrogen")) return "gemini-4-hydrogen";
    if (raw.includes("orchestrator-neon") || (raw.includes("orchestrator") && raw.includes("neon"))) {
      return "gemini-4-neon";
    }
    if (raw.includes("orchestrator-argon") || (raw.includes("orchestrator") && raw.includes("argon"))) {
      return "gemini-4-argon";
    }
    if (raw === "gemini-pro-orchestrator" || (raw.includes("orchestrator") && raw.includes("carbon"))) {
      return "gemini-4-carbon";
    }

    // Known Gemini / 3P families by id or display label.
    if (/gemini[- ]4[- ]neon/.test(raw)) return "gemini-4-neon";
    if (/gemini[- ]4[- ]carbon/.test(raw)) return "gemini-4-carbon";
    if (/gemini[- ]4[- ]argon/.test(raw)) return "gemini-4-argon";
    if (/gemini[- ]4[- ]hydrogen/.test(raw)) return "gemini-4-hydrogen";
    if (/gemini[- ]3\.8[- ]flash/.test(raw)) return "gemini-3.8-flash";
    if (/gemini[- ]3\.6[- ]flash/.test(raw)) return "gemini-3.6-flash";
    if (/gemini[- ]3\.5[- ]flash[- ]lite/.test(raw)) return "gemini-3.5-flash-lite";
    if (/gemini[- ]3\.1[- ]pro/.test(raw)) return "gemini-3.1-pro";
    if (/gemini[- ]3\.1[- ]flash[- ]lite/.test(raw)) return "gemini-3.1-flash-lite";
    if (/gemini[- ]3[- ]flash/.test(raw)) return "gemini-3-flash";
    if (/gemini[- ]2\.5[- ]pro/.test(raw)) return "gemini-2.5-pro";
    if (/gemini[- ]2\.5[- ]flash[- ]lite/.test(raw)) return "gemini-2.5-flash-lite";
    if (/gemini[- ]2\.5[- ]flash/.test(raw)) return "gemini-2.5-flash";
    if (/claude[- ]opus[- ]5[.-]5/.test(raw)) return "claude-opus-5-5";
    if (/claude[- ]sonnet[- ]5[.-]5/.test(raw)) return "claude-sonnet-5-5";
    if (/gpt[- ]oss[- ]120b/.test(raw)) return "gpt-oss-120b";
  }

  // Fallback for unknown models: strip effort suffix so all efforts share one pricing key.
  const base = candidates[0] ?? "unknown";
  return (
    base
      .replace(/\s*\([^()]+\)\s*$/, "")
      .replace(/-(low|medium|high|xhigh|max)$/, "")
      .replace(/\s+/g, "-")
      .trim() || "unknown"
  );
}

/** Returns the official rate applicable at timestamp `at` (ms since epoch, defaults to now). */
export function officialRatesAt(
  entry: AntigravityDefaultPricingEntry,
  at: number = Date.now(),
): AntigravityModelRates {
  let active = entry.rates;
  for (const change of entry.scheduled ?? []) {
    const start = Date.parse(change.effectiveFrom);
    if (Number.isFinite(start) && at >= start) active = change.rates;
  }
  return active;
}

/**
 * Resolves the effective rates for a request: user custom overrides take precedence over official
 * rates (including scheduled official price changes). Returns null when no rate is defined.
 */
export function resolveEffectiveRates(
  pricingKey: string,
  at: number,
  custom: Readonly<Record<string, AntigravityModelRates>>,
): AntigravityModelRates | null {
  const override = custom[pricingKey];
  if (override) return override;
  const entry = BY_KEY.get(pricingKey);
  if (!entry) return null;
  return officialRatesAt(entry, at);
}

/**
 * Computes the USD cost of a single model request using its exact token counts and prompt tier.
 * `input` is uncached input tokens, `cached` is cache-read tokens, `output` includes thinking tokens.
 */
export function estimateRequestCost(
  tokens: { input: number; cached: number; output: number },
  rates: AntigravityModelRates,
): number {
  const promptTokens = tokens.input + tokens.cached;
  const isLong =
    typeof rates.longContextThreshold === "number" &&
    rates.longContextThreshold > 0 &&
    promptTokens > rates.longContextThreshold;
  const inputRate = isLong && rates.longInput !== undefined ? rates.longInput : rates.input;
  const cachedRate = isLong && rates.longCached !== undefined ? rates.longCached : rates.cached;
  const outputRate = isLong && rates.longOutput !== undefined ? rates.longOutput : rates.output;
  return (
    (tokens.input * inputRate + tokens.cached * cachedRate + tokens.output * outputRate) /
    ONE_MILLION
  );
}

/** Converts an Antigravity USD rate object into `dsh-paseo`'s dual-currency `ModelRates` shape. */
export function toUsdDualCurrencyRates(rates: AntigravityModelRates): UsdDualCurrencyModelRates {
  const result: UsdDualCurrencyModelRates = {
    currency: "USD",
    input: rates.input,
    cached: rates.cached,
    output: rates.output,
  };
  if (rates.longContextThreshold !== undefined) {
    result.longContextThreshold = rates.longContextThreshold;
  }
  if (rates.longInput !== undefined) result.longInput = rates.longInput;
  if (rates.longCached !== undefined) result.longCached = rates.longCached;
  if (rates.longOutput !== undefined) result.longOutput = rates.longOutput;
  return result;
}

// ---- Legacy `antigravity-accounts/pricing.json` override parser ----------------------------

const legacyRateNumberSchema = z.number().finite().min(0).max(LEGACY_MAX_RATE_PER_MILLION);

export const legacyAntigravityModelRatesSchema = z.object({
  input: legacyRateNumberSchema,
  cached: legacyRateNumberSchema,
  output: legacyRateNumberSchema,
  longContextThreshold: z
    .number()
    .int()
    .positive()
    .max(LEGACY_MAX_LONG_CONTEXT_THRESHOLD)
    .optional(),
  longInput: legacyRateNumberSchema.optional(),
  longCached: legacyRateNumberSchema.optional(),
  longOutput: legacyRateNumberSchema.optional(),
});

export interface ParsedLegacyAntigravityPricing {
  readonly version: 1;
  /** Normalized lowercase pricing keys mapped to USD dual-currency rates. */
  readonly overrides: Record<string, UsdDualCurrencyModelRates>;
  /** Keys skipped due to malformed keys or invalid rate payloads (non-fatal). */
  readonly skippedKeys: readonly string[];
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a legacy `antigravity-accounts/pricing.json` payload (either raw JSON
 * text or an already-parsed object) into validated USD dual-currency overrides
 * suitable for merging into `dsh-paseo`'s `PricingStore`.
 *
 * Returns `null` when the payload is not valid JSON or does not match the
 * legacy v1 file structure. Malformed individual model entries are skipped and
 * reported in `skippedKeys` so valid overrides still import cleanly.
 */
export function parseLegacyAntigravityPricing(
  raw: unknown,
): ParsedLegacyAntigravityPricing | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!isPlainRecord(parsed)) return null;

  if (parsed.version !== undefined && parsed.version !== 1) {
    return null;
  }

  const rawOverrides = parsed.overrides;
  if (rawOverrides !== undefined && !isPlainRecord(rawOverrides)) {
    return null;
  }

  const overrides: Record<string, UsdDualCurrencyModelRates> = Object.create(null);
  const skippedKeys: string[] = [];

  if (rawOverrides) {
    for (const [rawKey, rawValue] of Object.entries(rawOverrides)) {
      const key = rawKey.trim().toLowerCase();
      if (!key || key.length > LEGACY_MODEL_KEY_MAX_LENGTH || FORBIDDEN_KEYS.has(key)) {
        skippedKeys.push(rawKey);
        continue;
      }
      const checked = legacyAntigravityModelRatesSchema.safeParse(rawValue);
      if (!checked.success) {
        skippedKeys.push(rawKey);
        continue;
      }
      overrides[key] = toUsdDualCurrencyRates(checked.data);
    }
  }

  return {
    version: 1,
    overrides: { ...overrides },
    skippedKeys,
  };
}
