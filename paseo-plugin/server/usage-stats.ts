/**
 * DSH session usage indexing, incremental disk cache, and analytics aggregation.
 *
 * Scans `$DSH_HOME/sessions/**\/*.v4.jsonl.zstd` (and uncompressed `*.jsonl`),
 * extracts per-call token counts, provider/model routing, TTFT, and decode
 * throughput using DSH's own first-token rules (`server/first-token.ts`), and
 * caches parsed call records per file at
 * `$DSH_HOME/.cache/paseo-dsh-usage-v1.json` with atomic `tmp + rename` writes.
 *
 * Zero external runtime dependencies: decompresses zstd via Node's built-in
 * `zlib.zstdDecompress` (Node >= 22.15) with a streaming `zstd -d -c` CLI
 * fallback for older runtimes.
 *
 * @module dsh-paseo/server/usage-stats
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  DAILY_HISTORY_DAYS,
  DEFAULT_USD_TO_CNY_RATE,
  UNPRICED_PRICER,
  USAGE_MAX_TPS,
  USAGE_MAX_TTFT_SECONDS,
  convertUsageCurrency,
  deriveUsageMetrics,
  emptyUsageTotals,
  normalizeUsagePricingKey,
  usageDailyRpc,
  usageStatsRpc,
  type UsageBin,
  type UsageCurrency,
  type UsageDaily,
  type UsageDailyInput,
  type UsageDailyMaxDay,
  type UsageDay,
  type UsageIndexingStatus,
  type UsageModelPricedState,
  type UsageModelRow,
  type UsagePricer,
  type UsagePricerSource,
  type UsageProviderRow,
  type UsageRange,
  type UsageScope,
  type UsageSparklines,
  type UsageStats,
  type UsageStatsInput,
  type UsageTotals,
} from "../shared/usage";
import { dshHome } from "./bootstrap";
import { assistantStreamFirstTokenTime } from "./first-token";

// v2: seeded/fork sessions no longer re-count their fork-inherited event prefix.
const CACHE_VERSION = 2 as const;
const DEFAULT_CACHE_FILENAME = "paseo-dsh-usage-v1.json";
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_PREWARM_DELAY_MS = 3_000;
const DEFAULT_RPC_WAIT_MS = 250;
const DAY_MS = 86_400_000;
/** Corrupt files modified within this window are not cached as empty (may still be mid-write). */
const RECENT_CORRUPT_GRACE_MS = 10_000;

const RANGES: Record<UsageRange, { binMs: number; bins: number }> = {
  today: { binMs: 3_600_000, bins: 24 },
  "7d": { binMs: 6 * 3_600_000, bins: 28 },
  "30d": { binMs: DAY_MS, bins: 30 },
};

/** One parsed LLM call extracted from a DSH session log file. */
export interface CachedCallRecord {
  /** Call completion timestamp (ms since epoch). */
  at: number;
  provider: string;
  model: string;
  /** Fresh uncached input tokens. */
  input: number;
  /** Cache-read input tokens. */
  cached: number;
  /** Cache-write input tokens (omitted when 0). */
  cacheWrite?: number;
  /** Output tokens including reasoning and tool-call arguments. */
  output: number;
  /** Model context window recorded by `request/context`, when present. */
  contextWindow?: number;
  /** Time to first token in seconds, clamped to `0..300s`, omitted if unmeasured. */
  firstTokenSec?: number;
  /** Decode window in seconds, omitted when invalid or speed > `3000 tok/s`. */
  generationSec?: number;
}

/** One file's cached parse output stored in `paseo-dsh-usage-v1.json`. */
export interface CachedSessionEntry {
  mtimeMs: number;
  size: number;
  isSubagent: boolean;
  calls: CachedCallRecord[];
  corrupt?: boolean;
}

export interface UsageCacheFile {
  version: typeof CACHE_VERSION;
  files: Record<string, CachedSessionEntry>;
}

export interface UsageRefreshReport {
  scanned: number;
  parsed: number;
  pruned: number;
  corrupt: number;
}

export interface UsageStatsEngineOptions {
  /** Override `$DSH_HOME` (primarily for tests and benchmarks). */
  dshHome?: string;
  /** Override the sessions root directory (defaults to `<dshHome>/sessions`). */
  sessionsDir?: string;
  /** Override the cache JSON file path (defaults to `<dshHome>/.cache/paseo-dsh-usage-v1.json`). */
  cachePath?: string;
  /** Structural pricer, factory, or `PricingStore` for dual-currency cost aggregation (defaults to unpriced). */
  pricer?: UsagePricerSource;
  /** Files processed concurrently per async batch during indexing (clamped 1..32, default 8). */
  concurrency?: number;
  /** Delay before background prewarm starts (ms, default 3000). */
  prewarmDelayMs?: number;
  /** Max time RPC handlers wait for an in-flight/cold scan before returning live progress (ms, default 250). */
  rpcWaitMs?: number;
  /** Injectable wall clock for deterministic unit tests (defaults to `Date.now`). */
  now?: () => number;
}

export interface UsageQueryOptions {
  /**
   * Maximum time (ms) to wait for a refresh scan before returning the current
   * in-memory snapshot alongside live `indexing` status. Omit to await the full
   * scan (deterministic for tests and direct callers).
   */
  waitMs?: number;
}

interface DiscoveredFile {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  isZstd: boolean;
}

interface ZlibWithZstd {
  zstdDecompress?: (
    buffer: zlib.InputType,
    callback: (error: Error | null, result: Buffer) => void,
  ) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function roundMillis(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Default path of the incremental usage cache under `$DSH_HOME`. */
export function usageCachePath(home: string = dshHome()): string {
  return path.join(home, ".cache", DEFAULT_CACHE_FILENAME);
}

/**
 * Decompress a zstd payload using Node's built-in `zlib.zstdDecompress` when
 * available, falling back to streaming `zstd -d -c` on older Node versions.
 */
export function decompressZstd(buffer: Buffer, filePath?: string): Promise<Buffer> {
  const zstdFn = (zlib as unknown as ZlibWithZstd).zstdDecompress;
  if (typeof zstdFn === "function") {
    return new Promise<Buffer>((resolve, reject) => {
      zstdFn(buffer, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  }
  return decompressZstdViaCli(buffer, filePath);
}

function decompressZstdViaCli(buffer: Buffer, filePath?: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const args = filePath ? ["-d", "-c", "--", filePath] : ["-d", "-c"];
    const child = spawn("zstd", args, { stdio: [filePath ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.on("error", fail);
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
      } else {
        const msg = Buffer.concat(stderrChunks).toString("utf8").trim() || `zstd exited with code ${String(code)}`;
        reject(new Error(msg));
      }
    });

    if (!filePath && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(buffer);
    }
  });
}

const TYPE_PREFIX = '{"type":"';
const RELEVANT_PREFIXES = [
  '{"type":"assistant/message"',
  '{"type":"step/start"',
  '{"type":"request/context"',
  '{"type":"model/selection"',
] as const;

/**
 * Fast line pre-filter fallback for non-canonical JSONL (reordered keys or
 * leading whitespace). Canonical DSH lines hit the O(1) prefix check first.
 */
function lineMayBeRelevant(line: string): boolean {
  return (
    line.indexOf('"assistant/message"') !== -1 ||
    line.indexOf('"step/start"') !== -1 ||
    line.indexOf('"request/context"') !== -1 ||
    line.indexOf('"model/selection"') !== -1
  );
}

/** Canonical row prefix of a DSH v4 `session/end-seed` event (fast pre-scan). */
const END_SEED_ROW_PREFIX = '{"type":"session/end-seed"';
/** Substring form for non-canonical rows whose keys are reordered. */
const END_SEED_TYPE_TOKEN = '"session/end-seed"';

/**
 * Locate the fork-inherited cut of a seeded DSH v4 session file: the `seq` of
 * the final `session/end-seed` event carrying `data.inherited === true`.
 * DSH's own v4 decoder derives `inheritedEventCount` from exactly that event
 * (a seeded header must carry one and no inherited marker may follow it), so
 * every event at `seq <= cut` belongs to the fork parent and the child file
 * must not count it again.
 *
 * Only rows that can be a marker event are JSON-parsed; quoted copies of the
 * marker text inside messages/tool results carry escaped quotes and are skipped.
 *
 * @returns the cut seq, or `undefined` when the file has no inherited marker.
 */
function findInheritedSeedCut(content: string): number | undefined {
  let cut: number | undefined;
  let from = 0;
  for (;;) {
    const hit = content.indexOf(END_SEED_TYPE_TOKEN, from);
    if (hit === -1) return cut;
    const lineStart = content.lastIndexOf("\n", hit) + 1;
    let lineEnd = content.indexOf("\n", hit + END_SEED_TYPE_TOKEN.length);
    if (lineEnd === -1) lineEnd = content.length;
    const line = content.slice(lineStart, lineEnd);
    // Canonical rows are O(1)-classified; reordered keys also surface as `"inherited"`.
    if (line.startsWith(END_SEED_ROW_PREFIX) || line.includes('"inherited"')) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        event = undefined;
      }
      if (
        isRecord(event) &&
        event.type === "session/end-seed" &&
        isRecord(event.data) &&
        event.data.inherited === true &&
        typeof event.seq === "number" &&
        Number.isSafeInteger(event.seq) &&
        event.seq >= 0
      ) {
        cut = event.seq;
      }
    }
    from = lineEnd + 1;
  }
}

/**
 * Parse the decompressed JSONL text of one DSH v4 session file into subagent
 * classification and metered LLM call records.
 *
 * Tolerates trailing/mid-file corrupt JSON lines without throwing so partially
 * flushed or damaged logs yield all valid calls they contain.
 *
 * For seeded (fork) sessions — whose log begins with a copy of the parent's
 * event prefix — only events after the inherited cut are counted, so parent
 * usage is not double-counted in the child file. A seeded file without an
 * inherited `session/end-seed` marker is structurally corrupt and throws (the
 * caller records it via the existing corrupt-file path).
 */
export function parseSessionJsonl(
  content: string,
  fallbackTimeMs?: number,
): { isSubagent: boolean; calls: CachedCallRecord[] } {
  let isSubagent = false;
  /** Last inherited `session/end-seed` seq; only events after it are child-owned. */
  let inheritedCut: number | undefined;
  const calls: CachedCallRecord[] = [];
  const stepStarts = new Map<string, number>();
  let lastContext: { provider?: string; model?: string; contextWindow?: number } | null = null;
  let lastSelection: { provider?: string; model?: string } | null = null;

  let lineStart = 0;
  let sawFirstLine = false;
  const len = content.length;

  while (lineStart < len) {
    let lineEnd = content.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = len;
    const trimmedEnd =
      lineEnd > lineStart && content.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    const start = lineStart;
    lineStart = lineEnd + 1;

    if (trimmedEnd <= start) continue;

    if (!sawFirstLine) {
      sawFirstLine = true;
      let header: unknown;
      try {
        header = JSON.parse(content.slice(start, trimmedEnd));
      } catch {
        continue;
      }
      if (isRecord(header) && header.type === "session") {
        isSubagent =
          header.origin === "subagent" ||
          (typeof header.delegationDepth === "number" && header.delegationDepth > 0);
        if (header.isSeeded === true) {
          inheritedCut = findInheritedSeedCut(content);
          if (inheritedCut === undefined) {
            throw new Error("seeded session is missing its inherited session/end-seed marker");
          }
        }
        continue;
      }
      // If line 0 wasn't a session header (e.g. truncated/headless log), process it normally below.
      if (isRecord(header)) {
        processEvent(header);
      }
      continue;
    }

    // O(1) zero-allocation skip for canonical DSH events (tool/result, user/message, etc.).
    let rawLine: string;
    if (content.startsWith(TYPE_PREFIX, start)) {
      let matched = false;
      for (let i = 0; i < RELEVANT_PREFIXES.length; i += 1) {
        if (content.startsWith(RELEVANT_PREFIXES[i]!, start)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      rawLine = content.slice(start, trimmedEnd);
    } else {
      rawLine = content.slice(start, trimmedEnd);
      if (!lineMayBeRelevant(rawLine)) continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (isRecord(event)) {
      // Seeded sessions: everything at or before the inherited cut is the fork
      // parent's history, already counted in the parent file.
      if (inheritedCut !== undefined && !(typeof event.seq === "number" && event.seq > inheritedCut)) {
        continue;
      }
      processEvent(event);
    }
  }

  function processEvent(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === "step/start") {
      const data = isRecord(event.data) ? event.data : null;
      if (
        data &&
        typeof event.time === "number" &&
        Number.isFinite(event.time) &&
        typeof data.turn === "number" &&
        typeof data.step === "number"
      ) {
        stepStarts.set(`${data.turn}:${data.step}`, event.time);
      }
      return;
    }

    if (type === "request/context") {
      const data = isRecord(event.data) ? event.data : null;
      if (!data) return;
      const provider = nonEmptyString(data.provider) ?? lastContext?.provider;
      const model = nonEmptyString(data.model) ?? lastContext?.model;
      const cwRaw = data.contextWindow;
      const contextWindow =
        typeof cwRaw === "number" && Number.isFinite(cwRaw) && cwRaw > 0
          ? cwRaw
          : lastContext?.contextWindow;
      lastContext = { provider, model, contextWindow };
      return;
    }

    if (type === "model/selection") {
      const data = isRecord(event.data) ? event.data : null;
      if (!data) return;
      const provider = nonEmptyString(data.provider) ?? lastSelection?.provider;
      const model = nonEmptyString(data.model) ?? lastSelection?.model;
      lastSelection = { provider, model };
      return;
    }

    if (type !== "assistant/message") return;

    const data = isRecord(event.data) ? event.data : null;
    if (!data) return;
    const usage = isRecord(data.usage) ? data.usage : null;
    if (!usage) return;

    const input = nonNegNumber(usage.inputTokens);
    const cached = nonNegNumber(usage.cacheReadTokens);
    const cacheWrite = nonNegNumber(usage.cacheWriteTokens);
    const output = nonNegNumber(usage.outputTokens);
    if (input + cached + cacheWrite + output <= 0) return;

    // Extract first-token time (using DSH's own reader) and final `finish` chunk metadata.
    const stream = Array.isArray(data.stream) ? data.stream : undefined;
    const firstTokenMs = stream ? assistantStreamFirstTokenTime(stream) : undefined;

    let finishTimeMs: number | undefined;
    let finishProvider: string | undefined;
    let finishModel: string | undefined;

    if (stream) {
      for (let i = stream.length - 1; i >= 0; i -= 1) {
        const rec = stream[i];
        if (!isRecord(rec) || rec.type !== "chunk" || !isRecord(rec.chunk)) continue;
        if (rec.chunk.type !== "finish") continue;
        if (typeof rec.time === "number" && Number.isFinite(rec.time)) {
          finishTimeMs = rec.time;
        }
        const replayState = isRecord(rec.chunk.replayState) ? rec.chunk.replayState : undefined;
        const response = replayState && isRecord(replayState.response) ? replayState.response : undefined;
        if (response) {
          finishProvider = nonEmptyString(response.provider);
          finishModel = nonEmptyString(response.model);
        }
        break;
      }
    }

    const provider = finishProvider ?? lastContext?.provider ?? lastSelection?.provider ?? "unknown";
    const model = finishModel ?? lastContext?.model ?? lastSelection?.model ?? "unknown";

    const eventTimeMs = typeof event.time === "number" && Number.isFinite(event.time) ? event.time : undefined;
    const at = eventTimeMs ?? finishTimeMs ?? firstTokenMs ?? fallbackTimeMs;
    if (at === undefined || !Number.isFinite(at) || at <= 0) return;

    // TTFT: `firstChunk.time - stepStart.time` matched by same (turn, step), clamped 0..300s.
    let firstTokenSec: number | undefined;
    if (typeof data.turn === "number" && typeof data.step === "number" && firstTokenMs !== undefined) {
      const stepStartMs = stepStarts.get(`${data.turn}:${data.step}`);
      if (stepStartMs !== undefined) {
        const rawSec = (firstTokenMs - stepStartMs) / 1000;
        firstTokenSec = roundMillis(Math.min(USAGE_MAX_TTFT_SECONDS, Math.max(0, rawSec)));
      }
    }

    // Generation duration: `finish.time - firstChunk.time` (fallback to event.time), excluding speed > 3000 tok/s.
    let generationSec: number | undefined;
    const decodeEndMs = finishTimeMs ?? eventTimeMs;
    if (decodeEndMs !== undefined && firstTokenMs !== undefined && output > 0) {
      const rawGenSec = (decodeEndMs - firstTokenMs) / 1000;
      if (rawGenSec > 0) {
        const tps = output / rawGenSec;
        if (tps <= USAGE_MAX_TPS) {
          generationSec = roundMillis(rawGenSec);
        }
      }
    }

    const record: CachedCallRecord = {
      at,
      provider,
      model,
      input,
      cached,
      output,
    };
    if (cacheWrite > 0) record.cacheWrite = cacheWrite;
    if (lastContext?.contextWindow !== undefined) record.contextWindow = lastContext.contextWindow;
    if (firstTokenSec !== undefined) record.firstTokenSec = firstTokenSec;
    if (generationSec !== undefined) record.generationSec = generationSec;

    calls.push(record);
  }

  return { isSubagent, calls };
}

/**
 * Local-calendar-aligned bin windows (hourly bins from local midnight 00:00 for
 * `today`, 6-hour slots for `7d`, and calendar days for `30d`).
 */
export function buildCalendarBins(now: number, range: UsageRange): Array<{ start: number; end: number }> {
  const { bins: count } = RANGES[range];
  const anchor = new Date(now);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const day = anchor.getDate();
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
  return Array.from({ length: count }, (_, hour) => {
    const start = new Date(year, month, day, hour, 0, 0, 0).getTime();
    const end = new Date(year, month, day, hour + 1, 0, 0, 0).getTime();
    return { start, end };
  });
}

/** Local calendar day key `"YYYY-MM-DD"`. */
export function localDayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayNumberFromKey(key: string): number {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

function findBinIndex(bins: readonly { start: number; end: number }[], at: number): number {
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

function accumulateCall(totals: UsageTotals, call: CachedCallRecord, cost: number | null): void {
  const cacheWrite = call.cacheWrite ?? 0;
  totals.requests += 1;
  totals.input += call.input;
  totals.cached += call.cached;
  totals.cacheWrite += cacheWrite;
  totals.output += call.output;
  totals.totalTokens += call.input + call.cached + cacheWrite + call.output;
  if (call.generationSec !== undefined && call.generationSec > 0) {
    totals.generationSeconds += call.generationSec;
    totals.generationOutput += call.output;
  }
  if (call.firstTokenSec !== undefined) {
    totals.firstTokenSeconds += call.firstTokenSec;
    totals.firstTokenRequests += 1;
  }
  if (cost !== null) {
    totals.cost += cost;
    totals.pricedRequests += 1;
  }
}

function matchesModelFilter(provider: string, model: string, filterModel: string): boolean {
  return model === filterModel || `${provider}/${model}` === filterModel;
}

function isSupportedSessionFile(name: string): { supported: boolean; isZstd: boolean } {
  if (name.endsWith(".v4.jsonl.zstd")) return { supported: true, isZstd: true };
  if (name.endsWith(".jsonl")) return { supported: true, isZstd: false };
  return { supported: false, isZstd: false };
}

async function discoverSessionFiles(sessionsDir: string): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];

  async function walk(dir: string, relPrefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const subdirs: Array<{ abs: string; rel: string }> = [];
    const fileCandidates: Array<{ abs: string; rel: string; isZstd: boolean }> = [];

    for (const ent of entries) {
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        subdirs.push({ abs, rel });
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        const check = isSupportedSessionFile(ent.name);
        if (check.supported) {
          fileCandidates.push({ abs, rel, isZstd: check.isZstd });
        }
      }
    }

    if (fileCandidates.length > 0) {
      await Promise.all(
        fileCandidates.map(async (item) => {
          const stat = await fs.stat(item.abs).catch(() => null);
          if (!stat || !stat.isFile()) return;
          found.push({
            relPath: item.rel,
            absPath: item.abs,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            isZstd: item.isZstd,
          });
        }),
      );
    }

    // Walk subdirectories in modest parallel chunks so huge trees stay fast without fd exhaustion.
    const DIR_BATCH = 16;
    for (let i = 0; i < subdirs.length; i += DIR_BATCH) {
      const slice = subdirs.slice(i, i + DIR_BATCH);
      await Promise.all(slice.map((sub) => walk(sub.abs, sub.rel)));
    }
  }

  await walk(sessionsDir, "");
  return found;
}

function sanitizeCachedEntry(raw: unknown): CachedSessionEntry | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.mtimeMs !== "number" ||
    !Number.isFinite(raw.mtimeMs) ||
    typeof raw.size !== "number" ||
    !Number.isFinite(raw.size) ||
    typeof raw.isSubagent !== "boolean" ||
    !Array.isArray(raw.calls)
  ) {
    return null;
  }

  const calls: CachedCallRecord[] = [];
  for (const item of raw.calls) {
    if (!isRecord(item)) continue;
    if (
      typeof item.at !== "number" ||
      !Number.isFinite(item.at) ||
      typeof item.provider !== "string" ||
      typeof item.model !== "string" ||
      typeof item.input !== "number" ||
      typeof item.cached !== "number" ||
      typeof item.output !== "number"
    ) {
      continue;
    }
    const rec: CachedCallRecord = {
      at: item.at,
      provider: item.provider,
      model: item.model,
      input: item.input,
      cached: item.cached,
      output: item.output,
    };
    if (typeof item.cacheWrite === "number" && item.cacheWrite > 0) rec.cacheWrite = item.cacheWrite;
    if (typeof item.contextWindow === "number" && item.contextWindow > 0) rec.contextWindow = item.contextWindow;
    if (typeof item.firstTokenSec === "number" && Number.isFinite(item.firstTokenSec)) {
      rec.firstTokenSec = item.firstTokenSec;
    }
    if (typeof item.generationSec === "number" && Number.isFinite(item.generationSec) && item.generationSec > 0) {
      rec.generationSec = item.generationSec;
    }
    calls.push(rec);
  }

  const entry: CachedSessionEntry = {
    mtimeMs: raw.mtimeMs,
    size: raw.size,
    isSubagent: raw.isSubagent,
    calls,
  };
  if (raw.corrupt === true) entry.corrupt = true;
  return entry;
}

function raceWithTimeout(promise: Promise<unknown>, waitMs: number): Promise<void> {
  if (waitMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    timer.unref?.();
    void promise.then(done, done);
  });
}

async function resolvePricer(source: UsagePricerSource): Promise<UsagePricer> {
  if (typeof source === "function") return await source();
  if ("resolver" in source && typeof source.resolver === "function") return await source.resolver();
  return source as UsagePricer;
}

function priceCallInCurrency(
  pricer: UsagePricer,
  call: CachedCallRecord,
  targetCurrency: UsageCurrency,
  usdToCnyRate: number,
): { pricingKey: string; cost: number | null } {
  const result = pricer.priceCall({
    model: call.model,
    provider: call.provider,
    tokens: {
      input: call.input,
      cached: call.cached,
      cacheWrite: call.cacheWrite ?? 0,
      output: call.output,
    },
  });
  if (!result.priced) {
    return { pricingKey: result.pricingKey, cost: null };
  }
  if (result.displayCurrency === targetCurrency && result.cost !== null && Number.isFinite(result.cost)) {
    return { pricingKey: result.pricingKey, cost: result.cost };
  }
  if (result.nativeCost !== null && result.nativeCurrency !== null && Number.isFinite(result.nativeCost)) {
    return {
      pricingKey: result.pricingKey,
      cost: convertUsageCurrency(result.nativeCost, result.nativeCurrency, targetCurrency, usdToCnyRate),
    };
  }
  if (result.cost !== null && Number.isFinite(result.cost)) {
    return {
      pricingKey: result.pricingKey,
      cost: convertUsageCurrency(result.cost, result.displayCurrency, targetCurrency, usdToCnyRate),
    };
  }
  return { pricingKey: result.pricingKey, cost: null };
}

/**
 * Stateful incremental usage indexer and analytics engine.
 *
 * Keeps parsed call entries in memory backed by an atomic JSON disk cache.
 * Supports background prewarming, single-flight incremental refreshes, and
 * non-blocking live indexing progress reporting for RPC clients.
 */
export class UsageStatsEngine {
  readonly sessionsDir: string;
  readonly cachePath: string;
  readonly concurrency: number;
  readonly prewarmDelayMs: number;
  readonly rpcWaitMs: number;

  private readonly now: () => number;
  private pricer: UsagePricerSource;
  private readonly entries = new Map<string, CachedSessionEntry>();
  private diskCacheLoaded: Promise<void> | null = null;
  private activeRefresh: Promise<UsageRefreshReport> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  private prewarmTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private indexing: UsageIndexingStatus = { active: false, done: 0, total: 0 };

  constructor(options: UsageStatsEngineOptions = {}) {
    const resolvedHome = options.dshHome ?? dshHome();
    this.sessionsDir = options.sessionsDir ?? path.join(resolvedHome, "sessions");
    this.cachePath = options.cachePath ?? usageCachePath(resolvedHome);
    this.pricer = options.pricer ?? UNPRICED_PRICER;
    const rawConc = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.concurrency = Math.min(32, Math.max(1, Math.floor(rawConc)));
    this.prewarmDelayMs = Math.max(0, options.prewarmDelayMs ?? DEFAULT_PREWARM_DELAY_MS);
    this.rpcWaitMs = Math.max(0, options.rpcWaitMs ?? DEFAULT_RPC_WAIT_MS);
    this.now = options.now ?? Date.now;
  }

  setPricer(pricer: UsagePricerSource): void {
    this.pricer = pricer;
  }

  getIndexingStatus(): UsageIndexingStatus {
    return { ...this.indexing };
  }

  /**
   * Schedule a delayed background prewarm (default 3s) so cold indexing runs
   * off the startup critical path without keeping Node alive on shutdown.
   */
  startBackgroundPrewarm(delayMs: number = this.prewarmDelayMs): void {
    if (this.disposed || this.prewarmTimer !== null) return;
    const delay = Math.max(0, delayMs);
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = null;
      if (this.disposed) return;
      void this.refresh().catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[dsh-paseo] usage background prewarm failed: ${msg}\n`);
      });
    }, delay);
    this.prewarmTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.prewarmTimer !== null) {
      clearTimeout(this.prewarmTimer);
      this.prewarmTimer = null;
    }
  }

  private loadDiskCache(): Promise<void> {
    this.diskCacheLoaded ??= (async () => {
      try {
        const raw = await fs.readFile(this.cachePath, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.files)) {
          return;
        }
        for (const [relPath, rawEntry] of Object.entries(parsed.files)) {
          const entry = sanitizeCachedEntry(rawEntry);
          if (entry) this.entries.set(relPath, entry);
        }
        this.indexing = {
          active: this.indexing.active,
          done: this.entries.size,
          total: Math.max(this.indexing.total, this.entries.size),
        };
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code !== "ENOENT") {
          const msg = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[dsh-paseo] usage cache ignored (will rebuild): ${msg}\n`);
        }
      }
    })();
    return this.diskCacheLoaded;
  }

  private persistDiskCache(): Promise<void> {
    const files: Record<string, CachedSessionEntry> = {};
    for (const [relPath, entry] of this.entries) {
      files[relPath] = entry;
    }
    const payload: UsageCacheFile = { version: CACHE_VERSION, files };
    const serialized = JSON.stringify(payload);

    const run = this.writeChain.then(async () => {
      if (this.disposed) return;
      const dir = path.dirname(this.cachePath);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = `${this.cachePath}.${process.pid}.${Date.now()}.${++this.writeSeq}.tmp`;
      try {
        await fs.writeFile(temp, serialized, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temp, this.cachePath);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async parseOneFile(file: DiscoveredFile): Promise<{ entry: CachedSessionEntry | null; corrupt: boolean }> {
    try {
      let text: string;
      if (file.isZstd) {
        const compressed = await fs.readFile(file.absPath);
        const decompressed = await decompressZstd(compressed, file.absPath);
        text = decompressed.toString("utf8");
      } else {
        text = await fs.readFile(file.absPath, "utf8");
      }
      const parsed = parseSessionJsonl(text, file.mtimeMs);
      return {
        entry: {
          mtimeMs: file.mtimeMs,
          size: file.size,
          isSubagent: parsed.isSubagent,
          calls: parsed.calls,
        },
        corrupt: false,
      };
    } catch {
      // Gracefully tolerate corrupt/truncated zstd or unreadable files.
      // If the file was modified very recently, skip caching so an active writer is retried.
      const ageMs = this.now() - file.mtimeMs;
      if (ageMs >= 0 && ageMs < RECENT_CORRUPT_GRACE_MS) {
        return { entry: null, corrupt: true };
      }
      return {
        entry: {
          mtimeMs: file.mtimeMs,
          size: file.size,
          isSubagent: false,
          calls: [],
          corrupt: true,
        },
        corrupt: true,
      };
    }
  }

  /**
   * Incrementally synchronize the in-memory and disk cache with `$DSH_HOME/sessions`.
   * Concurrent callers share one single-flight scan.
   */
  refresh(): Promise<UsageRefreshReport> {
    if (this.activeRefresh) return this.activeRefresh;
    const run = this.runRefresh().finally(() => {
      this.activeRefresh = null;
    });
    this.activeRefresh = run;
    return run;
  }

  private async runRefresh(): Promise<UsageRefreshReport> {
    if (this.prewarmTimer !== null) {
      clearTimeout(this.prewarmTimer);
      this.prewarmTimer = null;
    }

    if (this.disposed) {
      return { scanned: 0, parsed: 0, pruned: 0, corrupt: 0 };
    }

    this.indexing = { active: true, done: this.entries.size, total: this.entries.size };

    try {
      await this.loadDiskCache();
      if (this.disposed) {
        return { scanned: 0, parsed: 0, pruned: 0, corrupt: 0 };
      }

      const discovered = await discoverSessionFiles(this.sessionsDir);
      const seen = new Set<string>();
      const dirty: DiscoveredFile[] = [];

      for (const file of discovered) {
        seen.add(file.relPath);
        const cached = this.entries.get(file.relPath);
        if (!cached || cached.mtimeMs !== file.mtimeMs || cached.size !== file.size) {
          dirty.push(file);
        }
      }

      // Auto-prune deleted session files from cache.
      let pruned = 0;
      for (const relPath of this.entries.keys()) {
        if (!seen.has(relPath)) {
          this.entries.delete(relPath);
          pruned += 1;
        }
      }

      const total = discovered.length;
      const unchanged = total - dirty.length;
      let done = unchanged;
      let parsedCount = 0;
      let corruptCount = 0;
      let cacheMutated = pruned > 0;

      this.indexing = { active: true, done, total };

      if (dirty.length > 0) {
        for (let offset = 0; offset < dirty.length; offset += this.concurrency) {
          if (this.disposed) break;
          const batch = dirty.slice(offset, offset + this.concurrency);
          await Promise.all(
            batch.map(async (file) => {
              const result = await this.parseOneFile(file);
              if (result.corrupt) corruptCount += 1;
              if (result.entry) {
                this.entries.set(file.relPath, result.entry);
                cacheMutated = true;
              }
              parsedCount += 1;
              done += 1;
              this.indexing = { active: true, done, total };
            }),
          );
          if (offset + this.concurrency < dirty.length) {
            await yieldToEventLoop();
          }
        }
      }

      if (cacheMutated && !this.disposed) {
        await this.persistDiskCache().catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[dsh-paseo] could not save usage cache: ${msg}\n`);
        });
      }

      return { scanned: total, parsed: parsedCount, pruned, corrupt: corruptCount };
    } finally {
      this.indexing = { active: false, done: this.entries.size, total: this.entries.size };
    }
  }

  private async prepareSnapshot(options?: UsageQueryOptions): Promise<void> {
    await this.loadDiskCache();
    const waitMs = options?.waitMs;
    if (this.activeRefresh) {
      if (waitMs === undefined) {
        await this.activeRefresh;
      } else {
        await raceWithTimeout(this.activeRefresh, waitMs);
      }
      return;
    }

    const scan = this.refresh();
    if (waitMs === undefined) {
      await scan;
    } else {
      await raceWithTimeout(scan, waitMs);
    }
  }

  /**
   * List distinct models observed across indexed sessions (useful for seeding
   * the pricing dialog with locally seen models).
   */
  async seenModels(options?: UsageQueryOptions): Promise<Array<{ provider: string; model: string; pricingKey: string }>> {
    await this.prepareSnapshot(options);
    const pricerSnapshot = await resolvePricer(this.pricer);
    const seen = new Map<string, { provider: string; model: string; pricingKey: string }>();
    for (const entry of this.entries.values()) {
      for (const call of entry.calls) {
        const key = `${call.provider}/${call.model}`;
        if (seen.has(key)) continue;
        const pricingKey = pricerSnapshot.resolveKey
          ? pricerSnapshot.resolveKey(call.model, call.provider)
          : pricerSnapshot.priceCall({
              model: call.model,
              provider: call.provider,
              tokens: { input: 0, cached: 0, cacheWrite: 0, output: 0 },
            }).pricingKey || normalizeUsagePricingKey(call.model);
        seen.set(key, { provider: call.provider, model: call.model, pricingKey });
      }
    }
    return [...seen.values()].sort((a, b) => a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider));
  }

  /** Map of `pricingKey -> display model label` compatible with `PricingStore.state(seenModels)`. */
  async seenPricingModels(options?: UsageQueryOptions): Promise<Map<string, string>> {
    const list = await this.seenModels(options);
    const map = new Map<string, string>();
    for (const item of list) {
      if (!map.has(item.pricingKey)) {
        map.set(item.pricingKey, item.model);
      }
    }
    return map;
  }

  /** Compute time-windowed usage analytics (`dsh.usage.stats`). */
  async stats(input: UsageStatsInput, options?: UsageQueryOptions): Promise<UsageStats> {
    await this.prepareSnapshot(options);
    const pricerSnapshot = await resolvePricer(this.pricer);
    const displayCurrency: UsageCurrency = input.currency ?? pricerSnapshot.displayCurrency;
    const usdToCnyRate =
      Number.isFinite(pricerSnapshot.usdToCnyRate) && pricerSnapshot.usdToCnyRate > 0
        ? pricerSnapshot.usdToCnyRate
        : DEFAULT_USD_TO_CNY_RATE;

    const range: UsageRange = (input.range as string) === "24h" ? "today" : input.range;
    const scope: UsageScope = input.scope ?? "all";
    const filterProvider = input.provider;
    const filterModel = input.model;
    const { binMs } = RANGES[range];
    const now = this.now();
    const windows = buildCalendarBins(now, range);
    const firstStart = windows[0]!.start;
    const windowEnd = windows[windows.length - 1]!.end;
    const lastEnd = Math.max(windowEnd, now + 60_000);

    // Also inspect the 371-day window for `hasSubagents` so the scope switcher stays visible
    // when subagent activity appears in the 53-week heatmap even if today's window is quiet.
    const anchor = new Date(now);
    const dailyStart = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() - (DAILY_HISTORY_DAYS - 1),
    ).getTime();

    const bins: UsageBin[] = windows.map((win) => ({
      start: win.start,
      end: win.end,
      ...emptyUsageTotals(),
    }));
    const totals = emptyUsageTotals();
    const breakdown = { main: emptyUsageTotals(), subagent: emptyUsageTotals() };
    const providerMap = new Map<string, { totals: UsageTotals; sessions: Set<string> }>();
    const modelMap = new Map<
      string,
      {
        provider: string;
        model: string;
        pricingKey: string;
        totals: UsageTotals;
        sessions: Set<string>;
      }
    >();
    const sessionSet = new Set<string>();
    let hasSubagents = false;

    for (const [sessionKey, entry] of this.entries) {
      for (const call of entry.calls) {
        if (entry.isSubagent && call.at >= dailyStart && call.at <= lastEnd) {
          hasSubagents = true;
        }
        if (range === "today") {
          if (call.at < firstStart || call.at >= windowEnd) continue;
        } else if (call.at < firstStart || call.at > lastEnd) {
          continue;
        }

        const { pricingKey, cost: callCost } = priceCallInCurrency(
          pricerSnapshot,
          call,
          displayCurrency,
          usdToCnyRate,
        );

        // Provider chips: scoped by range + scope, BEFORE provider/model filters so users can switch freely.
        if (scope === "all" || (scope === "subagent") === entry.isSubagent) {
          let prov = providerMap.get(call.provider);
          if (!prov) {
            prov = { totals: emptyUsageTotals(), sessions: new Set() };
            providerMap.set(call.provider, prov);
          }
          accumulateCall(prov.totals, call, callCost);
          prov.sessions.add(sessionKey);
        }

        if (filterProvider && call.provider !== filterProvider) continue;

        // Main vs subagent split within selected range & provider (before scope/model filter).
        accumulateCall(entry.isSubagent ? breakdown.subagent : breakdown.main, call, callCost);

        if (scope === "main" && entry.isSubagent) continue;
        if (scope === "subagent" && !entry.isSubagent) continue;

        // Model table: scoped by range + provider + scope, BEFORE model filter so clicking a row cross-filters cleanly.
        const modelKey = `${call.provider}/${call.model}`;
        let modelEntry = modelMap.get(modelKey);
        if (!modelEntry) {
          modelEntry = {
            provider: call.provider,
            model: call.model,
            pricingKey,
            totals: emptyUsageTotals(),
            sessions: new Set(),
          };
          modelMap.set(modelKey, modelEntry);
        }
        accumulateCall(modelEntry.totals, call, callCost);
        modelEntry.sessions.add(sessionKey);

        if (filterModel && !matchesModelFilter(call.provider, call.model, filterModel)) continue;

        const binIdx = findBinIndex(windows, call.at);
        if (binIdx >= 0) {
          accumulateCall(bins[binIdx]!, call, callCost);
        } else if (call.at >= windows[windows.length - 1]!.start) {
          accumulateCall(bins[bins.length - 1]!, call, callCost);
        }

        accumulateCall(totals, call, callCost);
        sessionSet.add(sessionKey);
      }
    }

    const sparklines: UsageSparklines = {
      tokens: [],
      cost: [],
      requests: [],
      tps: [],
      cacheHitRate: [],
      firstTokenSec: [],
    };
    for (const bin of bins) {
      const derived = deriveUsageMetrics(bin);
      sparklines.tokens.push(derived.totalTokens);
      sparklines.cost.push(derived.cost);
      sparklines.requests.push(bin.requests);
      sparklines.tps.push(derived.tps);
      sparklines.cacheHitRate.push(derived.cacheHitRate);
      sparklines.firstTokenSec.push(derived.firstTokenSec);
    }

    let modelTableTotalTokens = 0;
    for (const item of modelMap.values()) {
      modelTableTotalTokens += item.totals.totalTokens;
    }

    const models: UsageModelRow[] = [...modelMap.entries()]
      .map(([id, item]) => {
        const derived = deriveUsageMetrics(item.totals);
        const priced: UsageModelPricedState =
          item.totals.pricedRequests === 0
            ? "none"
            : item.totals.pricedRequests >= item.totals.requests
              ? "full"
              : "partial";
        return {
          id,
          provider: item.provider,
          model: item.model,
          label: item.model,
          pricingKey: item.pricingKey,
          sessions: item.sessions.size,
          share: modelTableTotalTokens > 0 ? item.totals.totalTokens / modelTableTotalTokens : 0,
          priced,
          tps: derived.tps,
          cacheHitRate: derived.cacheHitRate,
          firstTokenSec: derived.firstTokenSec,
          ...item.totals,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests || a.id.localeCompare(b.id));

    const providers: UsageProviderRow[] = [...providerMap.entries()]
      .map(([provider, item]) => ({
        provider,
        sessions: item.sessions.size,
        ...item.totals,
      }))
      .sort((a, b) => b.requests - a.requests || b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider));

    return {
      range,
      scope,
      binMs,
      bins,
      sparklines,
      totals,
      breakdown,
      hasSubagents: hasSubagents || breakdown.subagent.requests > 0,
      providers,
      models,
      sessions: sessionSet.size,
      displayCurrency,
      usdToCnyRate,
      hasCustomPricing: pricerSnapshot.hasCustomPricing,
      indexing: this.getIndexingStatus(),
      generatedAt: new Date(now).toISOString(),
    };
  }

  /** Compute 53-week (371-day) daily rollup (`dsh.usage.daily`). */
  async daily(input: UsageDailyInput = {}, options?: UsageQueryOptions): Promise<UsageDaily> {
    await this.prepareSnapshot(options);
    const pricerSnapshot = await resolvePricer(this.pricer);
    const displayCurrency: UsageCurrency = input.currency ?? pricerSnapshot.displayCurrency;
    const usdToCnyRate =
      Number.isFinite(pricerSnapshot.usdToCnyRate) && pricerSnapshot.usdToCnyRate > 0
        ? pricerSnapshot.usdToCnyRate
        : DEFAULT_USD_TO_CNY_RATE;

    const scope: UsageScope = input.scope ?? "all";
    const filterProvider = input.provider;
    const filterModel = input.model;
    const now = this.now();
    const anchor = new Date(now);
    const firstStart = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() - (DAILY_HISTORY_DAYS - 1),
    ).getTime();
    const tomorrowStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 1).getTime();
    const lastEnd = Math.max(tomorrowStart, now + 60_000);

    const dayMap = new Map<string, UsageTotals>();
    let hasSubagents = false;

    for (const entry of this.entries.values()) {
      for (const call of entry.calls) {
        if (call.at < firstStart || call.at > lastEnd) continue;
        if (entry.isSubagent) hasSubagents = true;
        if (filterProvider && call.provider !== filterProvider) continue;
        if (scope === "main" && entry.isSubagent) continue;
        if (scope === "subagent" && !entry.isSubagent) continue;
        if (filterModel && !matchesModelFilter(call.provider, call.model, filterModel)) continue;

        const { cost: callCost } = priceCallInCurrency(
          pricerSnapshot,
          call,
          displayCurrency,
          usdToCnyRate,
        );

        const key = localDayKey(Math.min(call.at, tomorrowStart - 1));
        let totals = dayMap.get(key);
        if (!totals) {
          totals = emptyUsageTotals();
          dayMap.set(key, totals);
        }
        accumulateCall(totals, call, callCost);
      }
    }

    const days: UsageDay[] = [...dayMap.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([date, totals]) => ({ date, ...totals }));

    const today = localDayKey(now);
    const todayNum = dayNumberFromKey(today);
    const tokensByDayNum = new Map<number, number>();

    let totalTokens = 0;
    let totalRequests = 0;
    let totalCostSum = 0;
    let pricedRequests = 0;
    let activeDays = 0;
    let maxDay: UsageDailyMaxDay | null = null;

    for (const day of days) {
      totalTokens += day.totalTokens;
      totalRequests += day.requests;
      totalCostSum += day.cost;
      pricedRequests += day.pricedRequests;
      if (day.totalTokens > 0) {
        activeDays += 1;
        tokensByDayNum.set(dayNumberFromKey(day.date), day.totalTokens);
        if (!maxDay || day.totalTokens > maxDay.tokens) {
          maxDay = {
            date: day.date,
            tokens: day.totalTokens,
            requests: day.requests,
            cost: day.pricedRequests > 0 ? day.cost : null,
          };
        }
      }
    }

    // Active streak continues while today has no calls yet (starts at yesterday if today is 0).
    let streak = 0;
    const streakStart = (tokensByDayNum.get(todayNum) ?? 0) > 0 ? todayNum : todayNum - 1;
    for (let cursor = streakStart; (tokensByDayNum.get(cursor) ?? 0) > 0; cursor -= 1) {
      streak += 1;
    }

    return {
      today,
      days,
      summary: {
        totalTokens,
        totalRequests,
        totalCost: pricedRequests > 0 ? totalCostSum : null,
        pricedRequests,
        activeDays,
        maxDay,
        activeDailyAvgTokens: activeDays > 0 ? totalTokens / activeDays : 0,
        streak,
      },
      hasSubagents,
      displayCurrency,
      usdToCnyRate,
      indexing: this.getIndexingStatus(),
      generatedAt: new Date(now).toISOString(),
    };
  }
}

export interface RegisterUsageStatsRpcOptions {
  /** Schedule delayed background prewarm on registration (default true). */
  startPrewarm?: boolean;
  /** Override prewarm delay in ms (defaults to engine.prewarmDelayMs). */
  prewarmDelayMs?: number;
  /** Optional callback invoked on every RPC call (e.g. to capture Paseo API handle). */
  onContext?: (context: PluginHandlerContext) => void;
}

/**
 * Wire `dsh.usage.stats` and `dsh.usage.daily` RPC handlers onto a Paseo plugin
 * server context and start the delayed background prewarm.
 */
export function registerUsageStatsRpc(
  server: PluginServerContext,
  engine: UsageStatsEngine,
  options: RegisterUsageStatsRpcOptions = {},
): () => void {
  server.handle(usageStatsRpc, async (input, context) => {
    options.onContext?.(context);
    return engine.stats(input, { waitMs: engine.rpcWaitMs });
  });
  server.handle(usageDailyRpc, async (input, context) => {
    options.onContext?.(context);
    return engine.daily(input, { waitMs: engine.rpcWaitMs });
  });

  if (options.startPrewarm !== false) {
    engine.startBackgroundPrewarm(options.prewarmDelayMs);
  }

  return () => engine.dispose();
}
