import fs from "node:fs/promises";
import path from "node:path";
import { SYSTEM_ACCOUNT_ID } from "../../shared/antigravity/contracts";
import { resolvePricingKey } from "../../shared/antigravity/pricing-defaults";
import { DAILY_HISTORY_DAYS } from "../../shared/usage";
import { REAL_CLI_DIR, SHARED_CLI_DIRS, dataDir } from "./paths";
import { decode, int, message, seconds, text } from "./protobuf";

/**
 * Aggregates model calls from agy's conversation databases. Each generation record
 * (`gen_metadata`) carries usage (1.4: 2 input, 3 output, 5 cache reads, 7 response id),
 * time to first token (1.11) and streaming time (1.12) as Durations, the model id (1.19),
 * and the display label (1.21). The step that issued the call (`steps.metadata`,
 * 9.7 = response id) carries its start time (1).
 */

interface Generation {
  responseId: string | null;
  modelId: string | null;
  label: string;
  pricingKey: string;
  input: number;
  cached: number;
  output: number;
  firstToken: number;
  generation: number;
}

export interface AntigravityCallRecord {
  at: number;
  conversationId: string;
  isSubagent: boolean;
  accountId: string | null;
  modelId: string | null;
  label: string;
  pricingKey: string;
  input: number;
  cached: number;
  output: number;
  firstToken: number;
  generation: number;
}

export type AntigravityPricerCallback = (
  modelId: string,
  input: number,
  cached: number,
  output: number,
) => { cost: number; priced: boolean } | null;

export type AntigravityRange = "today" | "24h" | "7d" | "30d";
export type AntigravityScope = "all" | "main" | "subagent";

export interface AntigravityUsageTotals {
  requests: number;
  input: number;
  cached: number;
  output: number;
  generationSeconds: number;
  firstTokenSeconds: number;
  cost: number;
  pricedRequests: number;
}

export interface AntigravityUsageBin extends AntigravityUsageTotals {
  start: number;
  end: number;
}

export interface AntigravityUsageModelRow extends AntigravityUsageTotals {
  label: string;
  pricingKey: string;
}

export interface AntigravityUsageAccountRow extends AntigravityUsageTotals {
  accountId: string;
  label: string;
  conversations: number;
}

export interface AntigravityUsageSummary {
  range: AntigravityRange;
  binMs: number;
  bins: AntigravityUsageBin[];
  totals: AntigravityUsageTotals;
  breakdown: {
    main: AntigravityUsageTotals;
    subagent: AntigravityUsageTotals;
  };
  models: AntigravityUsageModelRow[];
  accounts: AntigravityUsageAccountRow[];
  conversations: number;
  generatedAt: string;
}

export interface AntigravityUsageDay extends AntigravityUsageTotals {
  date: string;
}

export interface AntigravityUsageDaily {
  today: string;
  days: AntigravityUsageDay[];
  generatedAt: string;
}

export interface AntigravitySummaryFilter {
  range: AntigravityRange;
  scope?: AntigravityScope;
  accountId?: string;
  model?: string;
}

export interface AntigravityDailyFilter {
  scope?: AntigravityScope;
  accountId?: string;
  model?: string;
}

export interface UsageStatsReaderOptions {
  /** Override `~/.gemini/antigravity-cli` (primarily for tests). */
  cliDir?: string;
  /** Override `conversation-accounts.json` path (primarily for tests). */
  attributionPath?: string;
  /** Live lookup for all known Antigravity account labels (from AccountService). */
  getAccountLabels?: () => Record<string, string>;
  /** Injectable wall clock for tests (defaults to `Date.now`). */
  now?: () => number;
}

interface FileCache {
  conversationId: string;
  signature: string;
  lastGenIndex: number;
  generations: Generation[];
  started: Map<string, number>;
  fallback: number;
}

interface BinWindow {
  start: number;
  end: number;
}

const RANGES: Record<AntigravityRange, { binMs: number; bins: number }> = {
  today: { binMs: 3_600_000, bins: 24 },
  "24h": { binMs: 3_600_000, bins: 24 },
  "7d": { binMs: 6 * 3_600_000, bins: 28 },
  "30d": { binMs: 86_400_000, bins: 30 },
};

const SUBAGENT_MARKER = /sender=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type SqliteModule = typeof import("node:sqlite");
let sqlite: Promise<SqliteModule | null> | null = null;

function loadSqlite(): Promise<SqliteModule | null> {
  sqlite ??= import("node:sqlite").catch(() => null);
  return sqlite;
}

function parseGeneration(data: Uint8Array): Generation | null {
  const root = decode(data);
  const request = message(root, [1]);
  const usage = message(request, [4]);
  if (!usage) return null;
  const input = int(usage, 2);
  const output = int(usage, 3);
  const cached = int(usage, 5);
  if (input + output + cached === 0) return null;
  const modelId = text(request, 19)?.trim() || text(message(root, [3]), 28)?.trim() || null;
  const rawLabel =
    text(request, 21) ?? text(message(root, [3]), 28) ?? text(request, 19) ?? "Unknown model";
  const label = rawLabel.trim() || "Unknown model";
  return {
    responseId: text(usage, 7),
    modelId,
    label,
    pricingKey: resolvePricingKey(modelId, label),
    input,
    cached,
    output,
    firstToken: seconds(message(request, [11])),
    generation: seconds(message(request, [12])),
  };
}

function emptyTotals(): AntigravityUsageTotals {
  return {
    requests: 0,
    input: 0,
    cached: 0,
    output: 0,
    generationSeconds: 0,
    firstTokenSeconds: 0,
    cost: 0,
    pricedRequests: 0,
  };
}

function add(
  totals: AntigravityUsageTotals,
  record: AntigravityCallRecord,
  priced: { cost: number; priced: boolean } | null,
): void {
  totals.requests += 1;
  totals.input += record.input;
  totals.cached += record.cached;
  totals.output += record.output;
  totals.generationSeconds += record.generation;
  totals.firstTokenSeconds += record.firstToken;
  if (priced?.priced) {
    totals.cost += priced.cost;
    totals.pricedRequests += 1;
  }
}

/**
 * Builds local-calendar-aligned bins so daylight-saving transitions never shift midnight/6-hour
 * boundaries to 01:00 or 23:00 (which otherwise breaks day labels and hides X-axis ticks).
 */
export function buildCalendarBins(now: number, range: AntigravityRange): BinWindow[] {
  const { binMs, bins: count } = RANGES[range];
  const anchor = new Date(now);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const day = anchor.getDate();

  if (range === "today") {
    return Array.from({ length: count }, (_, hour) => {
      const start = new Date(year, month, day, hour, 0, 0, 0).getTime();
      const end = new Date(year, month, day, hour + 1, 0, 0, 0).getTime();
      return { start, end };
    });
  }
  if (range === "30d") {
    return Array.from({ length: count }, (_, index) => {
      const offset = index - (count - 1);
      const start = new Date(year, month, day + offset, 0, 0, 0, 0).getTime();
      const end = new Date(year, month, day + offset + 1, 0, 0, 0, 0).getTime();
      return { start, end };
    });
  }
  if (range === "7d") {
    const slot = Math.floor(anchor.getHours() / 6);
    const currentIndex = day * 4 + slot;
    return Array.from({ length: count }, (_, index) => {
      const target = currentIndex - (count - 1 - index);
      const targetDay = Math.floor(target / 4);
      const targetSlot = ((target % 4) + 4) % 4;
      const next = target + 1;
      const nextDay = Math.floor(next / 4);
      const nextSlot = ((next % 4) + 4) % 4;
      const start = new Date(year, month, targetDay, targetSlot * 6, 0, 0, 0).getTime();
      const end = new Date(year, month, nextDay, nextSlot * 6, 0, 0, 0).getTime();
      return { start, end };
    });
  }
  // 24h: walk back 24 real hours from the current hour start so spring/fall DST hours stay monotonic.
  const currentHour = new Date(year, month, day, anchor.getHours(), 0, 0, 0).getTime();
  return Array.from({ length: count }, (_, index) => {
    const start = currentHour - (count - 1 - index) * binMs;
    return { start, end: start + binMs };
  });
}

/** "2026-11-23" in the daemon's local calendar. */
function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function findBinIndex(bins: readonly BinWindow[], at: number): number {
  let lo = 0;
  let hi = bins.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bin = bins[mid]!;
    if (at < bin.start) hi = mid - 1;
    else if (at >= bin.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Reads the first 4 KB of a conversation's transcript to detect whether it was started as a subagent. */
async function detectSubagent(cliDir: string, conversationId: string): Promise<boolean> {
  const file = path.join(cliDir, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return false;
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) return false;
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const firstLine = head.split("\n", 1)[0] ?? "";
    return SUBAGENT_MARKER.test(firstLine);
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class UsageStatsReader {
  private readonly cliDir: string;
  private readonly attributionPathOverride: string | null;
  private readonly getAccountLabels?: () => Record<string, string>;
  private readonly now: () => number;

  private readonly files = new Map<string, FileCache>();
  private readonly subagentFlags = new Map<string, boolean>();
  private readonly conversationAccounts = new Map<string, string>();
  private running: Promise<AntigravityCallRecord[]> | null = null;
  private loadedAttribution: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private saveSeq = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(options?: UsageStatsReaderOptions) {
    this.cliDir = options?.cliDir ?? REAL_CLI_DIR;
    this.attributionPathOverride = options?.attributionPath ?? null;
    this.getAccountLabels = options?.getAccountLabels;
    this.now = options?.now ?? Date.now;
  }

  private attributionFile(): string {
    return this.attributionPathOverride ?? path.join(dataDir(), "conversation-accounts.json");
  }

  private loadAttribution(): Promise<void> {
    this.loadedAttribution ??= (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(this.attributionFile(), "utf8")) as Record<string, unknown>;
        for (const [conversationId, accountId] of Object.entries(raw)) {
          if (typeof accountId === "string" && accountId) this.conversationAccounts.set(conversationId, accountId);
        }
      } catch {
        // No attribution file yet.
      }
    })();
    return this.loadedAttribution;
  }

  /** Associates a conversation id with the account that ran it, for per-account usage breakdowns. */
  recordConversationAccount(conversationId: string, accountId: string): void {
    void this.loadAttribution().then(() => {
      if (this.conversationAccounts.get(conversationId) === accountId) return;
      this.conversationAccounts.set(conversationId, accountId);
      // Keep the map bounded to the most recent 2000 conversations.
      if (this.conversationAccounts.size > 2000) {
        const oldest = this.conversationAccounts.keys().next().value;
        if (oldest) this.conversationAccounts.delete(oldest);
      }
      this.scheduleSaveAttribution();
    });
  }

  private scheduleSaveAttribution(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const body = JSON.stringify(Object.fromEntries(this.conversationAccounts));
      const file = this.attributionFile();
      const temp = `${file}.${process.pid}.${Date.now()}.${++this.saveSeq}.tmp`;
      this.writing = this.writing
        .then(async () => {
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fs.writeFile(temp, body, { mode: 0o600 });
          await fs.rename(temp, file);
        })
        .catch(async (error: unknown) => {
          await fs.rm(temp, { force: true }).catch(() => undefined);
          console.error("dsh-paseo/antigravity: could not save conversation attribution", error);
        });
    }, 2000);
  }

  private async isSubagent(conversationId: string): Promise<boolean> {
    const cached = this.subagentFlags.get(conversationId);
    if (cached !== undefined) return cached;
    const detected = await detectSubagent(this.cliDir, conversationId);
    this.subagentFlags.set(conversationId, detected);
    return detected;
  }

  private async readFile(
    file: string,
    conversationId: string,
    signature: string,
    birth: number,
  ): Promise<FileCache | null> {
    const module = await loadSqlite();
    if (!module) return null;
    const previous = this.files.get(file);
    // Work on a copy so a mid-read error (e.g. SQLITE_BUSY on `steps`) never corrupts `previous`.
    const nextGenerations = previous ? [...previous.generations] : [];
    let nextLastGenIndex = previous ? previous.lastGenIndex : -1;
    let db: InstanceType<SqliteModule["DatabaseSync"]> | null = null;
    try {
      db = new module.DatabaseSync(file, { timeout: 1000 });
      db.exec("PRAGMA query_only = ON");
      // Generation records are written once per call, so only new rows need reading.
      const rows = db
        .prepare("SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx")
        .all(nextLastGenIndex) as Array<{ idx: number; data: Uint8Array | null }>;
      for (const row of rows) {
        nextLastGenIndex = Math.max(nextLastGenIndex, row.idx);
        if (!row.data) continue;
        const generation = parseGeneration(new Uint8Array(row.data));
        if (generation) nextGenerations.push(generation);
      }
      // Steps change state while they run; their metadata is small, so re-read it all.
      const steps = db.prepare("SELECT metadata FROM steps WHERE metadata IS NOT NULL").all() as Array<{
        metadata: Uint8Array | null;
      }>;
      const started = new Map<string, number>();
      for (const step of steps) {
        const meta = decode(step.metadata ? new Uint8Array(step.metadata) : null);
        const responseId = text(message(meta, [9]), 7);
        if (!responseId) continue;
        const at = seconds(message(meta, [1]));
        if (at > 0) started.set(responseId, at * 1000);
      }
      const next: FileCache = {
        conversationId,
        signature,
        lastGenIndex: nextLastGenIndex,
        generations: nextGenerations,
        started,
        fallback: previous?.fallback ?? birth,
      };
      this.files.set(file, next);
      return next;
    } catch (error) {
      console.error(`dsh-paseo/antigravity: could not read usage from ${path.basename(file)}`, error);
      return previous ?? null;
    } finally {
      try {
        db?.close();
      } catch {
        // Already closed.
      }
    }
  }

  private async collect(): Promise<AntigravityCallRecord[]> {
    await this.loadAttribution();
    const dir = path.join(this.cliDir, SHARED_CLI_DIRS[0]);
    let names: string[] = [];
    try {
      names = (await fs.readdir(dir)).filter((name) => /^[0-9a-f-]{36}\.db$/i.test(name));
    } catch {
      return [];
    }
    const records: AntigravityCallRecord[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const conversationId = name.slice(0, -3);
      const file = path.join(dir, name);
      seen.add(file);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      const wal = await fs.stat(`${file}-wal`).catch(() => null);
      const signature = `${stat.mtimeMs}:${stat.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;
      let cache = this.files.get(file);
      if (!cache || cache.signature !== signature) {
        cache = (await this.readFile(file, conversationId, signature, stat.birthtimeMs || stat.mtimeMs)) ?? undefined;
      }
      if (!cache) continue;
      const isSubagent = await this.isSubagent(conversationId);
      const accountId = this.conversationAccounts.get(conversationId) ?? null;
      // A call whose step is missing takes the time of the call before it.
      let last = cache.fallback;
      for (const generation of cache.generations) {
        const at = (generation.responseId && cache.started.get(generation.responseId)) || last;
        last = at;
        records.push({
          at,
          conversationId,
          isSubagent,
          accountId,
          modelId: generation.modelId,
          label: generation.label,
          pricingKey: generation.pricingKey,
          input: generation.input,
          cached: generation.cached,
          output: generation.output,
          firstToken: generation.firstToken,
          generation: generation.generation,
        });
      }
    }
    for (const file of this.files.keys()) {
      if (!seen.has(file)) {
        const removed = this.files.get(file);
        if (removed) this.subagentFlags.delete(removed.conversationId);
        this.files.delete(file);
      }
    }
    return records;
  }

  /** Normalized per-call records across all local Antigravity conversation databases. */
  allRecords(): Promise<AntigravityCallRecord[]> {
    // Concurrent requests share one scan.
    this.running ??= this.collect().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Map of accountId -> display label (including `"default"` -> System sign-in). */
  accountLabels(): Record<string, string> {
    const labels: Record<string, string> = {
      [SYSTEM_ACCOUNT_ID]: "System sign-in",
      ...(this.getAccountLabels ? this.getAccountLabels() : {}),
    };
    for (const accountId of this.conversationAccounts.values()) {
      if (!(accountId in labels)) {
        labels[accountId] = accountId;
      }
    }
    return labels;
  }

  /** Map of pricingKey → display label for models observed in local conversation databases. */
  async seenPricingModels(): Promise<Map<string, string>> {
    const records = await this.allRecords();
    const seen = new Map<string, string>();
    for (const record of records) {
      if (!seen.has(record.pricingKey)) {
        seen.set(record.pricingKey, record.label.replace(/\s*\([^()]+\)\s*$/, "").trim() || record.label);
      }
    }
    return seen;
  }

  /** Time-windowed Antigravity usage summary priced via an injected dual-currency pricer callback. */
  async querySummary(
    filter: AntigravitySummaryFilter,
    pricer?: AntigravityPricerCallback,
    labelOf?: (accountId: string) => string,
  ): Promise<AntigravityUsageSummary> {
    const { range, scope = "all", accountId, model } = filter;
    const { binMs } = RANGES[range];
    const now = this.now();
    const windows = buildCalendarBins(now, range);
    const firstStart = windows[0]!.start;
    const windowEnd = windows[windows.length - 1]!.end;
    const lastEnd = Math.max(windowEnd, now + 60_000);
    const bins: AntigravityUsageBin[] = windows.map((window) => ({
      start: window.start,
      end: window.end,
      ...emptyTotals(),
    }));
    const totals = emptyTotals();
    const breakdown = { main: emptyTotals(), subagent: emptyTotals() };
    const models = new Map<string, { totals: AntigravityUsageTotals; pricingKey: string }>();
    const accounts = new Map<string, { totals: AntigravityUsageTotals; conversations: Set<string> }>();
    const conversationSet = new Set<string>();
    const knownLabels = this.accountLabels();
    const resolveLabel = labelOf ?? ((id: string) => knownLabels[id] ?? id);

    const records = await this.allRecords();
    for (const record of records) {
      if (range === "today") {
        if (record.at < firstStart || record.at >= windowEnd) continue;
      } else if (record.at < firstStart || record.at > lastEnd) {
        continue;
      }

      const priced = pricer
        ? pricer(record.pricingKey, record.input, record.cached, record.output)
        : null;

      // Track per-account totals across the time range (before account/model filters so selectors stay complete).
      if (record.accountId && (scope === "all" || (scope === "subagent") === record.isSubagent)) {
        let entry = accounts.get(record.accountId);
        if (!entry) {
          entry = { totals: emptyTotals(), conversations: new Set() };
          accounts.set(record.accountId, entry);
        }
        add(entry.totals, record, priced);
        entry.conversations.add(record.conversationId);
      }

      if (accountId && record.accountId !== accountId) continue;

      // Track main vs subagent split within the selected range & account.
      add(record.isSubagent ? breakdown.subagent : breakdown.main, record, priced);

      if (scope === "main" && record.isSubagent) continue;
      if (scope === "subagent" && !record.isSubagent) continue;

      // Keep full per-model table within range/account/scope so clicking a model row can toggle filtering.
      let modelEntry = models.get(record.label);
      if (!modelEntry) {
        modelEntry = { totals: emptyTotals(), pricingKey: record.pricingKey };
        models.set(record.label, modelEntry);
      }
      add(modelEntry.totals, record, priced);

      if (model && record.label !== model && record.pricingKey !== model && record.modelId !== model) continue;

      const index = findBinIndex(windows, record.at);
      if (index >= 0) add(bins[index]!, record, priced);
      else if (record.at >= windows[windows.length - 1]!.start) add(bins[bins.length - 1]!, record, priced);
      add(totals, record, priced);
      conversationSet.add(record.conversationId);
    }

    return {
      range,
      binMs,
      bins,
      totals,
      breakdown,
      models: [...models.entries()]
        .map(([label, entry]) => ({ label, pricingKey: entry.pricingKey, ...entry.totals }))
        .sort((left, right) => right.requests - left.requests),
      accounts: [...accounts.entries()]
        .map(([id, value]) => ({
          accountId: id,
          label: resolveLabel(id),
          conversations: value.conversations.size,
          ...value.totals,
        }))
        .sort((left, right) => right.requests - left.requests),
      conversations: conversationSet.size,
      generatedAt: new Date(now).toISOString(),
    };
  }

  /** Per-day totals over the last DAILY_HISTORY_DAYS local days, priced via an injected callback. */
  async queryDaily(
    filter: AntigravityDailyFilter = {},
    pricer?: AntigravityPricerCallback,
  ): Promise<AntigravityUsageDaily> {
    const { scope = "all", accountId, model } = filter;
    const now = this.now();
    const anchor = new Date(now);
    const firstStart = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() - (DAILY_HISTORY_DAYS - 1),
    ).getTime();
    const tomorrowStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 1).getTime();
    const lastEnd = Math.max(tomorrowStart, now + 60_000);
    const days = new Map<string, AntigravityUsageTotals>();

    for (const record of await this.allRecords()) {
      if (record.at < firstStart || record.at > lastEnd) continue;
      if (accountId && record.accountId !== accountId) continue;
      if (scope === "main" && record.isSubagent) continue;
      if (scope === "subagent" && !record.isSubagent) continue;
      if (model && record.label !== model && record.pricingKey !== model && record.modelId !== model) continue;
      const priced = pricer
        ? pricer(record.pricingKey, record.input, record.cached, record.output)
        : null;
      const key = dayKey(Math.min(record.at, tomorrowStart - 1));
      let totals = days.get(key);
      if (!totals) {
        totals = emptyTotals();
        days.set(key, totals);
      }
      add(totals, record, priced);
    }

    return {
      today: dayKey(now),
      days: [...days.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([date, totals]) => ({ date, ...totals })),
      generatedAt: new Date(now).toISOString(),
    };
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }
}
