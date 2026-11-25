/**
 * Persistent dual-currency pricing store (`$DSH_HOME/.cache/paseo-dsh-pricing-v1.json`),
 * official API pricing catalog cache (`$DSH_HOME/.cache/paseo-dsh-pricing-catalog-v1.json`),
 * single-flight background/manual sync from `https://models.dev/api.json`, and
 * RPC handlers for `dsh.pricing.get` / `dsh.pricing.update` / `dsh.pricing.sync`.
 *
 * Uses atomic `tmp + rename` writes (`0o600`) serialized through per-file promise
 * queues so concurrent mutations or syncs never race or leave half-written files.
 * Network or parse failures never crash RPCs or wipe a valid existing disk cache.
 * Unreadable (non-ENOENT) files are first quarantined as `<path>.corrupt-<timestamp>`
 * so their contents stay recoverable; the config recovery is surfaced through the
 * `readError` / `recoveredFromCorruption` / `corruptBackupPath` state fields, and
 * `update()` refuses to overwrite a file that could not be quarantined.
 *
 * @module dsh-paseo/server/pricing
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  DEFAULT_CATALOG_TTL_MS,
  DEFAULT_PRICING_SYNC_SOURCE,
  PRICING_SCHEMA_VERSION,
  REFERENCE_PRICING,
  createPricingResolver,
  defaultPricingConfig,
  formatLongContextNote,
  inferModelFamily,
  matchReferenceEntry,
  matchSyncedCatalogEntry,
  modelRatesSchema,
  normalizeModelKey,
  officialProviderRank,
  parseModelsDevCatalog,
  pricingConfigSchema,
  pricingGetRpc,
  pricingStateSchema,
  pricingSyncRpc,
  pricingUpdateInputSchema,
  pricingUpdateRpc,
  resolvePricingKey,
  suggestClosestPricing,
  syncedPricingCatalogSchema,
  type ModelRates,
  type PricingConfig,
  type PricingModelRow,
  type PricingRateSource,
  type PricingResolver,
  type PricingState,
  type PricingSyncStatus,
  type PricingUpdateInput,
  type SyncedPricingCatalog,
} from "../shared/pricing";
import { dshHome } from "./bootstrap";

export const PRICING_CACHE_FILENAME = "paseo-dsh-pricing-v1.json";
export const PRICING_CATALOG_CACHE_FILENAME = "paseo-dsh-pricing-catalog-v1.json";
export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";
export const DEFAULT_SYNC_TIMEOUT_MS = 10_000;
export const DEFAULT_STARTUP_SYNC_DELAY_MS = 4_000;
export const MAX_CATALOG_RESPONSE_BYTES = 32 * 1024 * 1024;
const LAZY_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_ERROR_LENGTH = 240;

export interface PricingPathOptions {
  /** Override `$DSH_HOME` (useful in tests and isolated runs). */
  dshHome?: string;
  /** Override the exact config file path (takes precedence over `dshHome`). */
  pricingPath?: string;
  /** Override the exact synced catalog cache path (takes precedence over `dshHome`). */
  catalogPath?: string;
  /** Environment used to resolve `$DSH_HOME` when explicit paths are omitted. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface PricingStoreOptions extends PricingPathOptions {
  /** Override remote official catalog URL (defaults to `https://models.dev/api.json`). */
  catalogUrl?: string;
  /** Catalog freshness TTL in ms (defaults to 24 hours). */
  catalogTtlMs?: number;
  /** Fetch timeout in ms (defaults to 10_000ms). */
  syncTimeoutMs?: number;
  /** Max accepted remote payload size in bytes (defaults to 32 MiB). */
  maxResponseBytes?: number;
  /** Injectable fetch function for deterministic offline tests. */
  fetchImpl?: typeof fetch;
  /** Injectable wall clock for deterministic TTL tests (defaults to `Date.now`). */
  now?: () => number;
  /** Optional warning sink when an unreadable/malformed file or failed sync falls back safely. */
  onWarning?: (message: string, error: unknown) => void;
}

export interface SyncOfficialCatalogOptions {
  /** Force a remote sync even when the disk cache is within TTL (default `false`). */
  force?: boolean;
}

export interface SyncOfficialCatalogResult {
  readonly ok: boolean;
  readonly skipped: boolean;
  readonly error: string | null;
  readonly status: PricingSyncStatus;
}

export type SeenModelsInput = ReadonlyMap<string, string> | ReadonlyArray<string>;

export interface RegisterPricingRpcOptions {
  /** Supplies models observed in local DSH session logs (`pricingKey -> label` or model IDs). */
  getSeenModels?: () => Promise<SeenModelsInput> | SeenModelsInput;
  /** Supplies models configured in the user's active DSH profile (`pricingKey -> label` or model IDs). */
  getConfiguredModels?: () => Promise<SeenModelsInput> | SeenModelsInput;
  /** Schedule delayed non-blocking startup auto-sync when cache is missing or stale (default `false`). */
  startAutoSync?: boolean;
  /** Trigger non-blocking lazy sync on `dsh.pricing.get` / `autoSync: true` when stale (defaults to `startAutoSync === true`). */
  lazySyncOnGet?: boolean;
  /** Delay before startup auto-sync runs in ms (default `4_000`). */
  autoSyncDelayMs?: number;
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

/** Resolves the on-disk synced official catalog path (`$DSH_HOME/.cache/paseo-dsh-pricing-catalog-v1.json`). */
export function pricingCatalogFilePath(options: PricingPathOptions = {}): string {
  if (options.catalogPath !== undefined && options.catalogPath.trim() !== "") {
    return resolve(options.catalogPath);
  }
  const home =
    options.dshHome !== undefined && options.dshHome.trim() !== ""
      ? resolve(options.dshHome)
      : dshHome(options.env);
  return join(home, ".cache", PRICING_CATALOG_CACHE_FILENAME);
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

function compactError(error: unknown): string {
  const raw =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : String(error || "Unknown error").trim();
  return raw.length > MAX_ERROR_LENGTH ? `${raw.slice(0, MAX_ERROR_LENGTH - 1)}…` : raw;
}

async function readResponseTextCapped(
  response: Response,
  maxBytes: number,
  abortController: AbortController,
): Promise<string> {
  const rawLength = response.headers?.get?.("content-length");
  if (rawLength) {
    const declared = Number(rawLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      abortController.abort();
      throw new Error(`Catalog response exceeds size cap (${declared} > ${maxBytes} bytes).`);
    }
  }

  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          abortController.abort();
          throw new Error(`Catalog response exceeds size cap (${maxBytes} bytes).`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }

  const text = await response.text();
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > maxBytes) {
    throw new Error(`Catalog response exceeds size cap (${byteLength} > ${maxBytes} bytes).`);
  }
  return text;
}

/**
 * Manages persisted display currency, USD/CNY exchange rate, auto-sync
 * preference, per-model overrides, and the cached official API pricing catalog
 * (`models.dev`) on top of the built-in generic public model reference table.
 */
export class PricingStore {
  readonly filePath: string;
  readonly catalogPath: string;
  readonly catalogUrl: string;
  readonly catalogTtlMs: number;
  readonly syncTimeoutMs: number;
  readonly maxResponseBytes: number;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly warn: (message: string, error: unknown) => void;

  private config: PricingConfig = defaultPricingConfig();
  private catalog: SyncedPricingCatalog | null = null;
  private loaded: Promise<PricingConfig> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private catalogWriting: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  private inFlightSync: Promise<SyncOfficialCatalogResult> | null = null;
  private syncing = false;
  private activeSyncController: AbortController | null = null;
  private autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSyncError: string | null = null;
  private lastFailedAttemptAt = 0;
  private disposed = false;

  /** Compact error from the persisted-config read that forced defaults, or null. */
  private readError: string | null = null;
  /** True when the persisted config was unreadable and built-in defaults were applied. */
  private recoveredFromCorruption = false;
  /** Where the unreadable config file was moved, or null when no backup could be made. */
  private corruptBackupPath: string | null = null;
  /** True once the pre-overwrite warning for a recovered config has been emitted. */
  private overwriteWarningEmitted = false;

  constructor(options: PricingStoreOptions = {}) {
    this.filePath = pricingFilePath(options);
    this.catalogPath = pricingCatalogFilePath(options);
    this.catalogUrl = options.catalogUrl ?? DEFAULT_MODELS_DEV_URL;
    this.catalogTtlMs = Math.max(1_000, options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS);
    this.syncTimeoutMs = Math.max(50, options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS);
    this.maxResponseBytes = Math.max(1_024, options.maxResponseBytes ?? MAX_CATALOG_RESPONSE_BYTES);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.warn = options.onWarning ?? defaultWarn;
  }

  /** Loads persisted config and synced disk catalog once (concurrent callers share the read). */
  async load(): Promise<PricingConfig> {
    this.loaded ??= this.loadAllFromDisk();
    return this.loaded;
  }

  /** Forces a fresh read of config and synced catalog from disk after pending writes settle. */
  async reload(): Promise<PricingConfig> {
    await Promise.all([this.writing, this.catalogWriting]);
    this.loaded = null;
    return this.load();
  }

  /** Synchronous deep copy of the currently loaded user pricing configuration. */
  snapshot(): PricingConfig {
    return structuredClone(this.config);
  }

  /** Synchronous deep copy of the currently loaded official synced catalog, if any. */
  catalogSnapshot(): SyncedPricingCatalog | null {
    return this.catalog ? structuredClone(this.catalog) : null;
  }

  hasCustomOverrides(): boolean {
    return Object.keys(this.config.overrides).length > 0;
  }

  /** Returns current official catalog sync status metadata. */
  syncStatus(): PricingSyncStatus {
    return {
      autoSync: this.config.autoSync,
      source: this.catalog?.source ?? DEFAULT_PRICING_SYNC_SOURCE,
      syncedAt: this.catalog?.syncedAt ?? null,
      modelCount: this.catalog ? Object.keys(this.catalog.models).length : 0,
      syncing: this.syncing,
      lastError: this.lastSyncError,
    };
  }

  /** True when no synced catalog is loaded or its `syncedAt` is older than `catalogTtlMs`. */
  isCatalogStale(): boolean {
    if (!this.catalog) return true;
    const syncedMs = Date.parse(this.catalog.syncedAt);
    if (!Number.isFinite(syncedMs)) return true;
    return this.now() - syncedMs >= this.catalogTtlMs;
  }

  /** Builds a synchronous {@link PricingResolver} (`UsagePricer`) from loaded config + synced catalog. */
  createResolver(): PricingResolver {
    return createPricingResolver(this.config, this.catalog);
  }

  /** Ensures config and disk catalog are loaded and returns a ready {@link PricingResolver}. */
  async resolver(): Promise<PricingResolver> {
    await this.load();
    return this.createResolver();
  }

  /**
   * Schedules a delayed non-blocking background auto-sync when `autoSync` is
   * enabled and the disk catalog is missing or older than TTL. Cleared cleanly
   * by {@link dispose}.
   */
  startBackgroundAutoSync(delayMs: number = DEFAULT_STARTUP_SYNC_DELAY_MS): void {
    if (this.disposed || this.autoSyncTimer !== null) return;
    const delay = Math.max(0, delayMs);
    this.autoSyncTimer = setTimeout(() => {
      this.autoSyncTimer = null;
      if (this.disposed) return;
      void this.runBackgroundAutoSync();
    }, delay);
    this.autoSyncTimer.unref?.();
  }

  /**
   * Triggers a non-blocking background refresh if `autoSync` is enabled, the
   * disk catalog is missing or stale, no sync is in flight, and we are outside
   * the short failure retry cooldown.
   */
  maybeTriggerLazySync(): void {
    if (this.disposed || !this.config.autoSync || this.inFlightSync !== null) return;
    if (!this.isCatalogStale()) return;
    if (this.lastFailedAttemptAt > 0 && this.now() - this.lastFailedAttemptAt < LAZY_RETRY_COOLDOWN_MS) {
      return;
    }
    void this.syncOfficialCatalog({ force: false });
  }

  /**
   * Single-flight sync of official API prices from `models.dev`.
   *
   * Never throws on network/parse/size/timeout errors and never wipes an
   * existing valid disk catalog; instead records `lastError` and preserves the
   * cached catalog + built-in fallback.
   */
  async syncOfficialCatalog(
    options: SyncOfficialCatalogOptions = {},
  ): Promise<SyncOfficialCatalogResult> {
    await this.load();
    if (this.disposed) {
      return { ok: false, skipped: true, error: null, status: this.syncStatus() };
    }

    const force = options.force === true;
    if (!force && !this.isCatalogStale()) {
      return { ok: true, skipped: true, error: null, status: this.syncStatus() };
    }

    if (this.inFlightSync) {
      return this.inFlightSync;
    }

    const run = this.executeOfficialSync().finally(() => {
      if (this.inFlightSync === run) {
        this.inFlightSync = null;
      }
    });
    this.inFlightSync = run;
    return run;
  }

  /** Cancels any pending startup auto-sync timer and aborts any in-flight sync fetch. */
  dispose(): void {
    this.disposed = true;
    if (this.autoSyncTimer !== null) {
      clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    if (this.activeSyncController !== null) {
      this.activeSyncController.abort();
      this.activeSyncController = null;
    }
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
      if (parsed.autoSync !== undefined) {
        next.autoSync = parsed.autoSync;
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
        autoSync: next.autoSync,
        overrides: normalizeOverridesRecord(next.overrides),
      });

      // A config recovered from an unreadable file must never be replaced silently:
      // either its original content is preserved in a `.corrupt-*` backup, or we
      // refuse to write at all (the only copy would be destroyed).
      if (this.recoveredFromCorruption) {
        if (this.corruptBackupPath === null) {
          throw new Error(
            `Refusing to overwrite pricing config at ${this.filePath}: the unreadable existing file could not be quarantined, so writing would discard it. Repair or move that file, then retry.`,
          );
        }
        if (!this.overwriteWarningEmitted) {
          this.overwriteWarningEmitted = true;
          this.warn(
            `overwriting unreadable pricing config at ${this.filePath} with a validated config; original preserved at ${this.corruptBackupPath}`,
            new Error("pricing config was recovered from a corrupt file"),
          );
        }
      }

      await this.writeAtomicFile(this.filePath, validated);
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
   * Builds the full UI/RPC pricing table combining locally observed models,
   * DSH-configured models, user overrides, built-in reference families, and
   * synced official models.
   */
  async state(seenModels?: SeenModelsInput, configuredModels?: SeenModelsInput): Promise<PricingState> {
    await this.load();
    const overrides = this.config.overrides;
    const catalog = this.catalog;
    const seenByKey = this.normalizeSeenModels(seenModels);
    const configuredByKey = this.normalizeSeenModels(configuredModels);

    const rows: PricingModelRow[] = [];
    const listed = new Set<string>();
    const rankByKey = new Map<string, number>();

    // 1. Built-in generic public reference families (overlaid with exact synced rates when available).
    for (const entry of REFERENCE_PRICING) {
      listed.add(entry.key);
      const custom = overrides[entry.key] ?? null;
      const syncedEntry = catalog?.models[entry.key] ?? null;
      const effective: ModelRates = custom
        ? { ...custom }
        : syncedEntry
          ? { ...syncedEntry.rates }
          : { ...entry.rates };
      const source: PricingRateSource = custom ? "override" : syncedEntry ? "synced" : "reference";
      const seenLocally = seenByKey.has(entry.key);
      const configured = configuredByKey.has(entry.key);

      rankByKey.set(entry.key, seenLocally || configured || custom !== null ? 0 : 1);
      rows.push({
        key: entry.key,
        label: entry.label,
        family: entry.family,
        prefixes: [...entry.prefixes],
        reference: { ...entry.rates },
        synced: syncedEntry ? { ...syncedEntry.rates } : null,
        syncedProvider: syncedEntry?.provider ?? null,
        custom: custom ? { ...custom } : null,
        effective,
        source,
        note: syncedEntry ? formatLongContextNote(syncedEntry.rates) : (entry.note ?? null),
        seenLocally,
        configured,
      });
    }

    // 2. Locally observed, DSH-configured, and user-overridden models not covered by a listed reference key.
    const extras = new Set<string>([
      ...Object.keys(overrides),
      ...seenByKey.keys(),
      ...configuredByKey.keys(),
    ]);
    for (const key of [...extras].sort((left, right) => left.localeCompare(right))) {
      if (listed.has(key)) continue;
      listed.add(key);
      const custom = overrides[key] ?? null;
      const syncedEntry = matchSyncedCatalogEntry(key, catalog);
      const matchedRef = matchReferenceEntry(key);
      const effective = custom
        ? { ...custom }
        : syncedEntry
          ? { ...syncedEntry.rates }
          : matchedRef
            ? { ...matchedRef.rates }
            : null;
      const source: PricingRateSource | null = custom
        ? "override"
        : syncedEntry
          ? "synced"
          : matchedRef
            ? "reference"
            : null;
      const seenLocally = seenByKey.has(key);
      const configured = configuredByKey.has(key);
      const suggestions =
        !syncedEntry && !matchedRef ? suggestClosestPricing(key, catalog, 3) : undefined;

      rankByKey.set(key, 0);
      rows.push({
        key,
        label: seenByKey.get(key) ?? configuredByKey.get(key) ?? syncedEntry?.name ?? key,
        family: matchedRef?.family ?? inferModelFamily(key, syncedEntry?.provider),
        prefixes: [],
        reference: matchedRef ? { ...matchedRef.rates } : null,
        synced: syncedEntry ? { ...syncedEntry.rates } : null,
        syncedProvider: syncedEntry?.provider ?? null,
        custom: custom ? { ...custom } : null,
        effective,
        source,
        note: syncedEntry ? formatLongContextNote(syncedEntry.rates) : (matchedRef?.note ?? null),
        seenLocally,
        configured,
        ...(suggestions !== undefined ? { suggestions } : {}),
      });
    }

    // 3. Remaining synced official catalog models, ordered by official provider priority then ID.
    if (catalog) {
      const remainingSynced = Object.values(catalog.models)
        .filter((entry) => !listed.has(entry.id))
        .sort(
          (left, right) =>
            officialProviderRank(left.provider) - officialProviderRank(right.provider) ||
            left.id.localeCompare(right.id),
        );

      for (const entry of remainingSynced) {
        listed.add(entry.id);
        const matchedRef = matchReferenceEntry(entry.id);
        rankByKey.set(entry.id, 2);
        rows.push({
          key: entry.id,
          label: entry.name,
          family: inferModelFamily(entry.id, entry.provider),
          prefixes: [],
          reference: matchedRef ? { ...matchedRef.rates } : null,
          synced: { ...entry.rates },
          syncedProvider: entry.provider,
          custom: null,
          effective: { ...entry.rates },
          source: "synced",
          note: formatLongContextNote(entry.rates),
          seenLocally: false,
          configured: false,
        });
      }
    }

    // Surface locally observed, DSH-configured, and user-customized rows first, then built-in families, then synced-only rows.
    rows.sort((left, right) => (rankByKey.get(left.key) ?? 2) - (rankByKey.get(right.key) ?? 2));

    return pricingStateSchema.parse({
      version: PRICING_SCHEMA_VERSION,
      displayCurrency: this.config.displayCurrency,
      usdToCnyRate: this.config.usdToCnyRate,
      autoSync: this.config.autoSync,
      sync: this.syncStatus(),
      models: rows,
      overrides: structuredClone(overrides),
      hasCustomOverrides: this.hasCustomOverrides(),
      readError: this.readError,
      recoveredFromCorruption: this.recoveredFromCorruption,
      corruptBackupPath: this.corruptBackupPath,
    });
  }

  private async runBackgroundAutoSync(): Promise<void> {
    try {
      await this.load();
      if (this.disposed || !this.config.autoSync || !this.isCatalogStale()) return;
      await this.syncOfficialCatalog({ force: false });
    } catch (error) {
      this.warn("pricing background auto-sync failed", error);
    }
  }

  private async executeOfficialSync(): Promise<SyncOfficialCatalogResult> {
    const controller = new AbortController();
    this.syncing = true;
    this.activeSyncController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.syncTimeoutMs);
    timeout.unref?.();

    try {
      if (typeof this.fetchImpl !== "function") {
        throw new Error("Global fetch API is unavailable in this runtime.");
      }

      const response = await this.fetchImpl(this.catalogUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Official pricing registry returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
        );
      }

      const rawText = await readResponseTextCapped(response, this.maxResponseBytes, controller);
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(rawText);
      } catch (parseError) {
        throw new Error(`Invalid JSON from official pricing registry: ${compactError(parseError)}`);
      }

      const syncedAt = new Date(this.now()).toISOString();
      const parsedCatalog = parseModelsDevCatalog(rawJson, syncedAt, DEFAULT_PRICING_SYNC_SOURCE);

      if (this.disposed) {
        this.syncing = false;
        return { ok: false, skipped: true, error: null, status: this.syncStatus() };
      }

      await this.persistCatalog(parsedCatalog);
      this.catalog = parsedCatalog;
      this.lastSyncError = null;
      this.lastFailedAttemptAt = 0;
      this.syncing = false;

      return { ok: true, skipped: false, error: null, status: this.syncStatus() };
    } catch (error) {
      this.syncing = false;
      if (this.disposed) {
        return { ok: false, skipped: true, error: null, status: this.syncStatus() };
      }
      const message = timedOut
        ? `Request timed out after ${this.syncTimeoutMs}ms`
        : compactError(error);
      this.lastSyncError = message;
      this.lastFailedAttemptAt = this.now();
      this.warn(`official pricing sync from ${this.catalogUrl} failed`, error);
      return { ok: false, skipped: false, error: message, status: this.syncStatus() };
    } finally {
      this.syncing = false;
      clearTimeout(timeout);
      if (this.activeSyncController === controller) {
        this.activeSyncController = null;
      }
    }
  }

  private normalizeSeenModels(seenModels?: SeenModelsInput): Map<string, string> {
    const result = new Map<string, string>();
    if (!seenModels) return result;
    const overrides = this.config.overrides;
    const catalog = this.catalog;

    if (Array.isArray(seenModels)) {
      const list: ReadonlyArray<string> = seenModels;
      for (const rawModel of list) {
        const trimmed = rawModel.trim();
        if (!trimmed) continue;
        const key = resolvePricingKey(trimmed, undefined, overrides, catalog);
        if (!key || key === "unknown" || key.length > 160) continue;
        if (!result.has(key)) result.set(key, trimmed.slice(0, 160));
      }
      return result;
    }

    const map = seenModels as ReadonlyMap<string, string>;
    for (const [rawModel, rawLabel] of map.entries()) {
      const trimmed = rawModel.trim();
      if (!trimmed) continue;
      const key = resolvePricingKey(trimmed, undefined, overrides, catalog);
      if (!key || key === "unknown" || key.length > 160) continue;
      if (!result.has(key)) {
        const label = (rawLabel.trim() || trimmed).slice(0, 160);
        result.set(key, label);
      }
    }
    return result;
  }

  private async loadAllFromDisk(): Promise<PricingConfig> {
    const [config] = await Promise.all([this.readConfigFromDisk(), this.readCatalogFromDisk()]);
    return config;
  }

  private async readConfigFromDisk(): Promise<PricingConfig> {
    try {
      const rawText = await readFile(this.filePath, "utf8");
      const rawJson = JSON.parse(rawText) as unknown;
      const parsed = pricingConfigSchema.parse(rawJson);
      this.config = pricingConfigSchema.parse({
        version: parsed.version,
        displayCurrency: parsed.displayCurrency,
        usdToCnyRate: parsed.usdToCnyRate,
        autoSync: parsed.autoSync,
        overrides: normalizeOverridesRecord(parsed.overrides),
      });
      this.readError = null;
      this.recoveredFromCorruption = false;
      this.corruptBackupPath = null;
      this.overwriteWarningEmitted = false;
    } catch (error) {
      this.config = defaultPricingConfig();
      const code = (error as { code?: string } | null)?.code;
      if (code === "ENOENT") {
        this.readError = null;
        this.recoveredFromCorruption = false;
        this.corruptBackupPath = null;
        this.overwriteWarningEmitted = false;
        return structuredClone(this.config);
      }
      // Preserve the unreadable file instead of letting the next `update()` overwrite it.
      const backupPath = await this.quarantineUnreadableFile(this.filePath);
      this.readError = compactError(error);
      this.recoveredFromCorruption = true;
      this.corruptBackupPath = backupPath;
      this.overwriteWarningEmitted = false;
      this.warn(
        backupPath !== null
          ? `could not read pricing config at ${this.filePath}, moved it to ${backupPath} and using built-in defaults`
          : `could not read pricing config at ${this.filePath} and could not quarantine it; using built-in defaults without touching the existing file`,
        error,
      );
    }
    return structuredClone(this.config);
  }

  private async readCatalogFromDisk(): Promise<SyncedPricingCatalog | null> {
    try {
      const rawText = await readFile(this.catalogPath, "utf8");
      const rawJson = JSON.parse(rawText) as unknown;
      this.catalog = syncedPricingCatalogSchema.parse(rawJson);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "ENOENT") {
        this.catalog = null;
        return this.catalog;
      }
      // The synced catalog is a re-fetchable cache, but keep the bad copy around
      // for diagnostics instead of leaving it for the next sync to overwrite.
      const backupPath = await this.quarantineUnreadableFile(this.catalogPath);
      this.catalog = null;
      this.warn(
        backupPath !== null
          ? `could not read synced pricing catalog at ${this.catalogPath}, moved it to ${backupPath} and falling back to built-in reference`
          : `could not read synced pricing catalog at ${this.catalogPath} and could not quarantine it; falling back to built-in reference without touching the existing file`,
        error,
      );
    }
    return this.catalog;
  }

  /**
   * Moves an unreadable (corrupt/schema-invalid/unreadable) file aside as
   * `<path>.corrupt-<timestamp>` in the same directory so its contents remain
   * recoverable and a later write cannot silently discard them. Returns the
   * backup path, or `null` when the file could not be moved.
   */
  private async quarantineUnreadableFile(targetPath: string): Promise<string | null> {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/gu, "-");
    const backupPath = `${targetPath}.corrupt-${stamp}`;
    try {
      await rename(targetPath, backupPath);
      return backupPath;
    } catch (error) {
      this.warn(`could not move unreadable pricing file at ${targetPath} aside`, error);
      return null;
    }
  }

  private persistCatalog(catalog: SyncedPricingCatalog): Promise<void> {
    const run = this.catalogWriting.then(async () => {
      if (this.disposed) return;
      await this.writeAtomicFile(this.catalogPath, catalog);
    });
    this.catalogWriting = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeAtomicFile(targetPath: string, payload: unknown): Promise<void> {
    const dir = dirname(targetPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${targetPath}.${String(process.pid)}.${String(Date.now())}.${String(++this.writeSeq)}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temp, targetPath);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Registers the `dsh.pricing.get`, `dsh.pricing.update`, and `dsh.pricing.sync`
 * RPC handlers on the plugin server context, and optionally schedules a delayed
 * non-blocking startup auto-sync.
 */
export function registerPricingRpc(
  server: PluginServerContext,
  store: PricingStore,
  options: RegisterPricingRpcOptions = {},
): () => void {
  const lazySync = options.lazySyncOnGet ?? options.startAutoSync === true;
  const readSeenModels = async (): Promise<SeenModelsInput> => {
    if (!options.getSeenModels) return new Map<string, string>();
    try {
      return await options.getSeenModels();
    } catch {
      return new Map<string, string>();
    }
  };

  const readConfiguredModels = async (): Promise<SeenModelsInput> => {
    if (!options.getConfiguredModels) return new Map<string, string>();
    try {
      return await options.getConfiguredModels();
    } catch {
      return new Map<string, string>();
    }
  };

  const readState = async (): Promise<PricingState> => {
    const [seenModels, configuredModels] = await Promise.all([
      readSeenModels(),
      readConfiguredModels(),
    ]);
    return store.state(seenModels, configuredModels);
  };

  server.handle(pricingGetRpc, async (_input, context) => {
    options.onContext?.(context);
    await store.load();
    if (lazySync) {
      store.maybeTriggerLazySync();
    }
    return readState();
  });

  server.handle(pricingUpdateRpc, async (input, context) => {
    options.onContext?.(context);
    await store.update(input);
    if (lazySync && input.autoSync === true) {
      store.maybeTriggerLazySync();
    }
    return readState();
  });

  server.handle(pricingSyncRpc, async (input, context) => {
    options.onContext?.(context);
    await store.syncOfficialCatalog({ force: input.force ?? true });
    return readState();
  });

  if (options.startAutoSync === true) {
    store.startBackgroundAutoSync(options.autoSyncDelayMs);
  }

  return () => {
    store.dispose();
  };
}
