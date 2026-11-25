/**
 * Persistent dual-currency pricing store (`$DSH_HOME/.cache/paseo-dsh-pricing-v1.json`)
 * and RPC handler registration for `dsh.pricing.get` / `dsh.pricing.update`.
 *
 * Uses atomic `tmp + rename` writes serialized through an internal promise queue
 * so concurrent RPC mutations never race or leave a half-written config file.
 *
 * @module dsh-paseo/server/pricing
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  PRICING_SCHEMA_VERSION,
  REFERENCE_PRICING,
  createPricingResolver,
  defaultPricingConfig,
  matchReferenceEntry,
  modelRatesSchema,
  normalizeModelKey,
  pricingConfigSchema,
  pricingGetRpc,
  pricingStateSchema,
  pricingUpdateInputSchema,
  pricingUpdateRpc,
  resolvePricingKey,
  type ModelRates,
  type PricingConfig,
  type PricingModelRow,
  type PricingResolver,
  type PricingState,
  type PricingUpdateInput,
} from "../shared/pricing";
import { dshHome } from "./bootstrap";

export const PRICING_CACHE_FILENAME = "paseo-dsh-pricing-v1.json";

export interface PricingPathOptions {
  /** Override `$DSH_HOME` (useful in tests and isolated runs). */
  dshHome?: string;
  /** Override the exact config file path (takes precedence over `dshHome`). */
  pricingPath?: string;
  /** Environment used to resolve `$DSH_HOME` when neither `pricingPath` nor `dshHome` is given. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface PricingStoreOptions extends PricingPathOptions {
  /** Optional warning sink when an unreadable or malformed config file falls back to defaults. */
  onWarning?: (message: string, error: unknown) => void;
}

export type SeenModelsInput = ReadonlyMap<string, string> | ReadonlyArray<string>;

export interface RegisterPricingRpcOptions {
  /** Supplies models observed in local DSH session logs (`pricingKey -> label` or model IDs). */
  getSeenModels?: () => Promise<SeenModelsInput> | SeenModelsInput;
  /** Optional callback run on every RPC invocation (for example to capture `context.paseo`). */
  onContext?: (context: PluginHandlerContext) => void;
}

/** Resolves the on-disk pricing config path (`$DSH_HOME/.cache/paseo-dsh-pricing-v1.json`). */
export function pricingFilePath(options: PricingPathOptions = {}): string {
  if (options.pricingPath !== undefined && options.pricingPath.trim() !== "") {
    return resolve(options.pricingPath);
  }
  const home =
    options.dshHome !== undefined && options.dshHome.trim() !== ""
      ? resolve(options.dshHome)
      : dshHome(options.env);
  return join(home, ".cache", PRICING_CACHE_FILENAME);
}

function normalizeOverridesRecord(
  overrides: Readonly<Record<string, ModelRates>>,
): Record<string, ModelRates> {
  const normalized: Record<string, ModelRates> = {};
  for (const [rawKey, rates] of Object.entries(overrides)) {
    const key = normalizeModelKey(rawKey);
    if (!key) continue;
    normalized[key] = modelRatesSchema.parse(rates);
  }
  return normalized;
}

function defaultWarn(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[dsh-paseo] ${message}: ${detail}\n`);
}

/**
 * Manages persisted display currency, USD/CNY exchange rate, and per-model rate
 * overrides on top of the built-in generic public model family reference table.
 */
export class PricingStore {
  readonly filePath: string;
  private readonly warn: (message: string, error: unknown) => void;
  private config: PricingConfig = defaultPricingConfig();
  private loaded: Promise<PricingConfig> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  constructor(options: PricingStoreOptions = {}) {
    this.filePath = pricingFilePath(options);
    this.warn = options.onWarning ?? defaultWarn;
  }

  /** Loads the persisted config once (concurrent callers share the same read). */
  async load(): Promise<PricingConfig> {
    this.loaded ??= this.readFromDisk();
    return this.loaded;
  }

  /** Forces a fresh read from disk after any pending write settles. */
  async reload(): Promise<PricingConfig> {
    await this.writing;
    this.loaded = null;
    return this.load();
  }

  /** Synchronous deep copy of the currently loaded configuration. */
  snapshot(): PricingConfig {
    return structuredClone(this.config);
  }

  hasCustomOverrides(): boolean {
    return Object.keys(this.config.overrides).length > 0;
  }

  /** Builds a synchronous {@link PricingResolver} (`UsagePricer`) from the loaded config. */
  createResolver(): PricingResolver {
    return createPricingResolver(this.config);
  }

  /** Ensures config is loaded from disk and returns a ready {@link PricingResolver}. */
  async resolver(): Promise<PricingResolver> {
    await this.load();
    return this.createResolver();
  }

  /**
   * Validates and applies a pricing update atomically on disk (`tmp + rename`).
   * Rejects invalid exchange rates, negative/non-finite prices, or empty updates
   * without mutating in-memory or on-disk state.
   */
  async update(input: PricingUpdateInput): Promise<PricingConfig> {
    const parsed = pricingUpdateInputSchema.parse(input);
    await this.load();

    const run = this.writing.then(async () => {
      const next: PricingConfig = parsed.resetAll
        ? defaultPricingConfig()
        : structuredClone(this.config);

      if (parsed.resetOverrides) {
        next.overrides = {};
      }
      if (parsed.displayCurrency !== undefined) {
        next.displayCurrency = parsed.displayCurrency;
      }
      if (parsed.usdToCnyRate !== undefined) {
        next.usdToCnyRate = parsed.usdToCnyRate;
      }
      if (parsed.key !== undefined) {
        const normalizedKey = normalizeModelKey(parsed.key);
        if (!normalizedKey) {
          throw new Error("Model key must not be empty.");
        }
        if (parsed.rates === null) {
          delete next.overrides[normalizedKey];
        } else if (parsed.rates !== undefined) {
          next.overrides[normalizedKey] = modelRatesSchema.parse(parsed.rates);
        }
      }

      const validated = pricingConfigSchema.parse({
        version: PRICING_SCHEMA_VERSION,
        displayCurrency: next.displayCurrency,
        usdToCnyRate: next.usdToCnyRate,
        overrides: normalizeOverridesRecord(next.overrides),
      });

      await this.writeAtomic(validated);
      this.config = validated;
      return structuredClone(this.config);
    });

    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Builds the full UI/RPC pricing table combining built-in public reference
   * families, user custom overrides, and models observed in local session logs.
   */
  async state(seenModels?: SeenModelsInput): Promise<PricingState> {
    await this.load();
    const overrides = this.config.overrides;
    const seenByKey = this.normalizeSeenModels(seenModels);

    const rows: PricingModelRow[] = [];
    const listed = new Set<string>();

    for (const entry of REFERENCE_PRICING) {
      listed.add(entry.key);
      const custom = overrides[entry.key] ?? null;
      rows.push({
        key: entry.key,
        label: entry.label,
        family: entry.family,
        prefixes: [...entry.prefixes],
        reference: { ...entry.rates },
        custom: custom ? { ...custom } : null,
        effective: custom ? { ...custom } : { ...entry.rates },
        note: entry.note ?? null,
        seenLocally: seenByKey.has(entry.key),
      });
    }

    const extras = new Set<string>([...Object.keys(overrides), ...seenByKey.keys()]);
    for (const key of [...extras].sort((left, right) => left.localeCompare(right))) {
      if (listed.has(key)) continue;
      const custom = overrides[key] ?? null;
      const matchedRef = matchReferenceEntry(key);
      rows.push({
        key,
        label: seenByKey.get(key) ?? key,
        family: matchedRef?.family ?? null,
        prefixes: [],
        reference: matchedRef ? { ...matchedRef.rates } : null,
        custom: custom ? { ...custom } : null,
        effective: custom ? { ...custom } : matchedRef ? { ...matchedRef.rates } : null,
        note: matchedRef?.note ?? null,
        seenLocally: seenByKey.has(key),
      });
    }

    // Surface locally observed and user-customized rows first, keeping catalog order within groups.
    rows.sort((left, right) => {
      const leftRank = left.seenLocally || left.custom !== null ? 0 : 1;
      const rightRank = right.seenLocally || right.custom !== null ? 0 : 1;
      return leftRank - rightRank;
    });

    return pricingStateSchema.parse({
      version: PRICING_SCHEMA_VERSION,
      displayCurrency: this.config.displayCurrency,
      usdToCnyRate: this.config.usdToCnyRate,
      models: rows,
      overrides: structuredClone(overrides),
      hasCustomOverrides: this.hasCustomOverrides(),
    });
  }

  private normalizeSeenModels(seenModels?: SeenModelsInput): Map<string, string> {
    const result = new Map<string, string>();
    if (!seenModels) return result;
    const overrides = this.config.overrides;

    if (Array.isArray(seenModels)) {
      const list: ReadonlyArray<string> = seenModels;
      for (const rawModel of list) {
        const trimmed = rawModel.trim();
        if (!trimmed) continue;
        const key = resolvePricingKey(trimmed, undefined, overrides);
        if (!key || key === "unknown" || key.length > 160) continue;
        if (!result.has(key)) result.set(key, trimmed.slice(0, 160));
      }
      return result;
    }

    const map = seenModels as ReadonlyMap<string, string>;
    for (const [rawModel, rawLabel] of map.entries()) {
      const trimmed = rawModel.trim();
      if (!trimmed) continue;
      const key = resolvePricingKey(trimmed, undefined, overrides);
      if (!key || key === "unknown" || key.length > 160) continue;
      if (!result.has(key)) {
        const label = (rawLabel.trim() || trimmed).slice(0, 160);
        result.set(key, label);
      }
    }
    return result;
  }

  private async readFromDisk(): Promise<PricingConfig> {
    try {
      const rawText = await readFile(this.filePath, "utf8");
      const rawJson = JSON.parse(rawText) as unknown;
      const parsed = pricingConfigSchema.parse(rawJson);
      this.config = pricingConfigSchema.parse({
        version: parsed.version,
        displayCurrency: parsed.displayCurrency,
        usdToCnyRate: parsed.usdToCnyRate,
        overrides: normalizeOverridesRecord(parsed.overrides),
      });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== "ENOENT") {
        this.warn(`could not read pricing config at ${this.filePath}, using defaults`, error);
      }
      this.config = defaultPricingConfig();
    }
    return structuredClone(this.config);
  }

  private async writeAtomic(config: PricingConfig): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${String(process.pid)}.${String(Date.now())}.${String(++this.writeSeq)}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temp, this.filePath);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Registers the `dsh.pricing.get` and `dsh.pricing.update` RPC handlers on the
 * plugin server context.
 */
export function registerPricingRpc(
  server: PluginServerContext,
  store: PricingStore,
  options: RegisterPricingRpcOptions = {},
): () => void {
  const readSeenModels = async (): Promise<SeenModelsInput> => {
    if (!options.getSeenModels) return new Map<string, string>();
    try {
      return await options.getSeenModels();
    } catch {
      return new Map<string, string>();
    }
  };

  server.handle(pricingGetRpc, async (_input, context) => {
    options.onContext?.(context);
    return store.state(await readSeenModels());
  });

  server.handle(pricingUpdateRpc, async (input, context) => {
    options.onContext?.(context);
    await store.update(input);
    return store.state(await readSeenModels());
  });

  return () => {
    // Store holds no timers or open descriptors between RPC calls.
  };
}
