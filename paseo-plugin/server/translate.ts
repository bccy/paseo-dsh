/**
 * Server-side thinking translator:
 * 1. Primary: dynamically resolves an `openai-completions` fast model from the
 *    local DSH profile (`$DSH_HOME/profiles/<profile>/cordis.patch.yml` +
 *    `$DSH_HOME/.credentials.yaml`), never hardcoding any provider/model/URL/key.
 * 2. Optional Fallback: MyMemory public REST API ONLY when explicitly opted in
 *    (`allowPublicFallback: true` or `PASEO_DSH_ALLOW_PUBLIC_TRANSLATE=1`).
 *    Disabled by default so private reasoning text is never silently sent to
 *    third-party public GET endpoints.
 *
 * Includes in-memory + persistent JSON caching, in-flight deduplication, and
 * bounded concurrency + wait queue so repeated renders or session reopens cost
 * zero quota and cannot starve live preview translations.
 *
 * Security invariant: raw `.credentials.yaml` contents, API keys, and private
 * base URLs are NEVER logged or returned in any error message or response.
 *
 * @module dsh-paseo/server/translate
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { paseoHome } from "./antigravity/paths";
import { dshHome } from "./bootstrap";
import { needsChineseTranslation, splitTranslationChunks } from "../shared/translate-text";

const MAX_CACHE_ENTRIES = 600;
const MAX_CONCURRENT_REQUESTS = 6;
const MAX_QUEUE_SIZE = 64;
const QUEUE_WAIT_TIMEOUT_MS = 15_000;
const DSH_TIMEOUT_MS = 12_000;
const DSH_SINGLE_SHOT_MAX_CHARS = 3_000;
const DSH_CHUNK_MAX_CHARS = 2_400;
const MYMEMORY_TIMEOUT_MS = 8_000;
const MYMEMORY_TOTAL_BUDGET_MS = 25_000;
const SAVE_DEBOUNCE_MS = 500;
const ENDPOINT_CACHE_TTL_MS = 30_000;
const CACHE_VERSION = "v2";
const MYMEMORY_WARNING_RE = /MYMEMORY WARNING/i;
const FAST_MODEL_RE = /(?:flash|mini|lite|haiku|small|fast)/i;

const SYSTEM_PROMPT =
  "将用户给出的英文思考内容翻译成简洁自然的简体中文。保留原有分段、代码标识符、文件路径、命令和专有名词不翻译，只输出译文，不要加任何解释或前缀。";

function defaultCacheFile(): string {
  return path.join(paseoHome(), "plugin-data", "dsh-paseo", "thinking-translations.json");
}

export interface TranslateResult {
  translated: string;
  cached: boolean;
  provider: string;
}

export interface DshEndpoint {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface ThinkingTranslatorOptions {
  cacheFile?: string;
  fetchImpl?: typeof fetch;
  /** Override `$DSH_HOME` (mainly for offline tests). Pass `null` to disable DSH discovery. */
  dshHomeDir?: string | null;
  profile?: string;
  /**
   * Explicitly allow falling back to the public MyMemory GET endpoint when no
   * local DSH OpenAI-compatible endpoint is available or when DSH fails.
   * Defaults to `false` unless `PASEO_DSH_ALLOW_PUBLIC_TRANSLATE=1`.
   */
  allowPublicFallback?: boolean;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function hashText(target: string, text: string): string {
  return crypto
    .createHash("sha256")
    .update(`${CACHE_VERSION}\0${target}\0${text}`)
    .digest("hex")
    .slice(0, 32);
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  // Strip trailing inline comment (`value # comment`).
  const commentIdx = trimmed.indexOf(" #");
  return (commentIdx >= 0 ? trimmed.slice(0, commentIdx) : trimmed).trim();
}

function parseCredentialsYaml(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    const val = unquoteYamlScalar(match[2]!);
    if (val) map.set(match[1]!, val);
  }
  return map;
}

interface ParsedProviderBlock {
  api: string;
  baseURL: string;
  apiKeyEnv: string;
  apiKey: string;
  models: string[];
}

function parseProvidersFromPatchYaml(raw: string): ParsedProviderBlock[] {
  const lines = raw.split(/\r?\n/);
  const providers: ParsedProviderBlock[] = [];
  let inProviders = false;
  let providersIndent = -1;
  let currentIndent = -1;
  let current: ParsedProviderBlock | null = null;
  let inModels = false;
  let modelsIndent = -1;

  const flush = () => {
    if (current) {
      providers.push(current);
      current = null;
    }
    inModels = false;
    modelsIndent = -1;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (!inProviders) {
      if (trimmed === "providers:") {
        inProviders = true;
        providersIndent = indent;
      }
      continue;
    }

    if (indent <= providersIndent) {
      flush();
      inProviders = false;
      providersIndent = -1;
      if (trimmed === "providers:") {
        inProviders = true;
        providersIndent = indent;
      }
      continue;
    }

    if (current !== null && indent <= currentIndent) {
      flush();
    }

    if (current === null) {
      const header = /^([A-Za-z0-9._-]+):\s*$/.exec(trimmed);
      if (header) {
        currentIndent = indent;
        current = { api: "", baseURL: "", apiKeyEnv: "", apiKey: "", models: [] };
      }
      continue;
    }

    if (inModels && indent <= modelsIndent && !trimmed.startsWith("-")) {
      inModels = false;
      modelsIndent = -1;
    }

    if (!inModels && trimmed === "models:") {
      inModels = true;
      modelsIndent = indent;
      continue;
    }

    if (inModels) {
      const idMatch = /^-\s+id:\s*(.+)$/.exec(trimmed) ?? /^id:\s*(.+)$/.exec(trimmed);
      if (idMatch) {
        const modelId = unquoteYamlScalar(idMatch[1]!);
        if (modelId) current.models.push(modelId);
      }
      continue;
    }

    const kv = /^([A-Za-z0-9_]+):\s*(.+)$/.exec(trimmed);
    if (!kv) continue;
    const field = kv[1]!;
    const value = unquoteYamlScalar(kv[2]!);
    if (field === "api") current.api = value;
    else if (field === "baseURL") current.baseURL = value;
    else if (field === "apiKeyEnv") current.apiKeyEnv = value;
    else if (field === "apiKey") current.apiKey = value;
  }
  flush();
  return providers;
}

/**
 * Resolves the lightest configured `openai-completions` endpoint from the local
 * DSH profile without hardcoding any provider name, model id, URL, or secret.
 */
export async function resolveDshTranslationEndpoint(
  homeDir: string,
  profile: string,
): Promise<DshEndpoint | null> {
  const patchPaths = [
    path.join(homeDir, "profiles", profile, "cordis.patch.yml"),
    path.join(homeDir, "cordis.patch.yml"),
  ];
  const parsedProviders: ParsedProviderBlock[] = [];
  for (const patchPath of patchPaths) {
    const raw = await fs.readFile(patchPath, "utf8").catch(() => null);
    if (raw) parsedProviders.push(...parseProvidersFromPatchYaml(raw));
  }
  if (parsedProviders.length === 0) return null;

  let creds: Map<string, string> | null = null;
  const loadCreds = async (): Promise<Map<string, string>> => {
    if (creds !== null) return creds;
    const raw = await fs.readFile(path.join(homeDir, ".credentials.yaml"), "utf8").catch(() => "");
    creds = parseCredentialsYaml(raw);
    return creds;
  };

  let fallbackCandidate: DshEndpoint | null = null;

  for (const provider of parsedProviders) {
    if (provider.api !== "openai-completions") continue;
    if (!/^https?:\/\//i.test(provider.baseURL)) continue;
    const directModels = provider.models.filter((id) => !id.startsWith("agy-acp/"));
    if (directModels.length === 0) continue;

    let apiKey = provider.apiKey && !provider.apiKey.startsWith("${") ? provider.apiKey : "";
    if (!apiKey && provider.apiKeyEnv) {
      apiKey = process.env[provider.apiKeyEnv]?.trim() || (await loadCreds()).get(provider.apiKeyEnv) || "";
    }
    if (!apiKey) continue;

    const fastModel = directModels.find((id) => FAST_MODEL_RE.test(id));
    if (fastModel) {
      return { baseURL: provider.baseURL.replace(/\/+$/, ""), apiKey, model: fastModel };
    }
    if (fallbackCandidate === null) {
      fallbackCandidate = { baseURL: provider.baseURL.replace(/\/+$/, ""), apiKey, model: directModels[0]! };
    }
  }

  return fallbackCandidate;
}

interface QueuedTranslationWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  priority: boolean;
}

export class ThinkingTranslator {
  private readonly cacheFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly dshHomeDir: string | null;
  private readonly profile: string;
  private readonly allowPublicFallback: boolean;
  private readonly cache = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<TranslateResult>>();
  private readonly queue: QueuedTranslationWaiter[] = [];
  private activeRequests = 0;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private flushSeq = 0;
  private endpointCache: { at: number; value: DshEndpoint | null } | null = null;
  private disposed = false;

  constructor(options: ThinkingTranslatorOptions = {}) {
    this.cacheFile = options.cacheFile ?? defaultCacheFile();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dshHomeDir = options.dshHomeDir === undefined ? dshHome() : options.dshHomeDir;
    this.profile = options.profile ?? (process.env.DSH_PROFILE?.trim() || "paseo");
    this.allowPublicFallback =
      options.allowPublicFallback ?? process.env.PASEO_DSH_ALLOW_PUBLIC_TRANSLATE === "1";
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = fs
        .readFile(this.cacheFile, "utf8")
        .then((raw) => {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [entryHash, value] of Object.entries(parsed as Record<string, unknown>)) {
              if (typeof value === "string" && value.trim() && !MYMEMORY_WARNING_RE.test(value)) {
                this.cache.set(entryHash, value);
              }
            }
            while (this.cache.size > MAX_CACHE_ENTRIES) {
              const oldest = this.cache.keys().next().value;
              if (oldest === undefined) break;
              this.cache.delete(oldest);
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.loaded = true;
          this.loadPromise = null;
        });
    }
    await this.loadPromise;
  }

  private remember(entryHash: string, translated: string): void {
    this.cache.delete(entryHash);
    this.cache.set(entryHash, translated);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.disposed) return;
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushCache().catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  async flushCache(): Promise<void> {
    const dir = path.dirname(this.cacheFile);
    await fs.mkdir(dir, { recursive: true });
    const payload = JSON.stringify(Object.fromEntries(this.cache.entries()));
    this.flushSeq += 1;
    const tmp = `${this.cacheFile}.${process.pid}.${Date.now()}.${this.flushSeq}.tmp`;
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, this.cacheFile);
  }

  private async runWithSlot<T>(task: () => Promise<T>, priority = false): Promise<T> {
    if (this.disposed) {
      throw new Error("ThinkingTranslator disposed");
    }
    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        if (priority) {
          let evictIndex = -1;
          for (let i = this.queue.length - 1; i >= 0; i -= 1) {
            if (!this.queue[i]!.priority) {
              evictIndex = i;
              break;
            }
          }
          if (evictIndex >= 0) {
            const [evicted] = this.queue.splice(evictIndex, 1);
            if (evicted) {
              clearTimeout(evicted.timer);
              evicted.reject(new Error("Translation queue full"));
            }
          } else {
            throw new Error("Translation queue full");
          }
        } else {
          throw new Error("Translation queue full");
        }
      }
      await new Promise<void>((resolve, reject) => {
        const waiter: QueuedTranslationWaiter = {
          resolve,
          reject,
          priority,
          timer: setTimeout(() => {
            const idx = this.queue.indexOf(waiter);
            if (idx >= 0) this.queue.splice(idx, 1);
            reject(new Error("Translation queue wait timed out"));
          }, QUEUE_WAIT_TIMEOUT_MS),
        };
        waiter.timer.unref?.();
        if (priority) {
          const insertIdx = this.queue.findIndex((item) => !item.priority);
          if (insertIdx >= 0) {
            this.queue.splice(insertIdx, 0, waiter);
          } else {
            this.queue.push(waiter);
          }
        } else {
          this.queue.push(waiter);
        }
      });
    }
    this.activeRequests += 1;
    try {
      return await task();
    } finally {
      this.activeRequests -= 1;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      }
    }
  }

  private async getDshEndpoint(): Promise<DshEndpoint | null> {
    if (this.dshHomeDir === null) return null;
    const now = Date.now();
    if (this.endpointCache && now - this.endpointCache.at < ENDPOINT_CACHE_TTL_MS) {
      return this.endpointCache.value;
    }
    const value = await resolveDshTranslationEndpoint(this.dshHomeDir, this.profile).catch(() => null);
    this.endpointCache = { at: now, value };
    return value;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async translateChunkWithDsh(
    endpoint: DshEndpoint,
    text: string,
  ): Promise<{ translated: string; truncated: boolean }> {
    const response = await this.fetchWithTimeout(
      `${endpoint.baseURL}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${endpoint.apiKey}`,
        },
        body: JSON.stringify({
          model: endpoint.model,
          temperature: 0.1,
          max_tokens:
            text.length <= 240
              ? Math.min(320, Math.max(96, Math.ceil(text.length * 1.6)))
              : Math.min(4096, Math.max(512, Math.ceil(text.length * 1.8))),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: text },
          ],
        }),
      },
      DSH_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new Error(`DSH translation HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{
        finish_reason?: unknown;
        message?: { content?: unknown };
      }>;
    };
    const choice = payload?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("DSH translation returned empty content");
    }
    return {
      translated: content.trim(),
      truncated: choice?.finish_reason === "length",
    };
  }

  private async translateChunkedWithDsh(endpoint: DshEndpoint, text: string): Promise<string> {
    const { pieces, seps } = splitTranslationChunks(text, DSH_CHUNK_MAX_CHARS);
    if (pieces.length === 0) return text;
    const translatedPieces: string[] = [];
    for (const piece of pieces) {
      if (!needsChineseTranslation(piece)) {
        translatedPieces.push(piece);
        continue;
      }
      const chunkResult = await this.translateChunkWithDsh(endpoint, piece);
      if (chunkResult.truncated) {
        throw new Error("DSH translation output truncated");
      }
      translatedPieces.push(chunkResult.translated);
    }
    let combined = "";
    for (let i = 0; i < translatedPieces.length; i += 1) {
      combined += translatedPieces[i]! + (seps[i] ?? "");
    }
    const result = combined.trim();
    if (!result) {
      throw new Error("DSH chunked translation returned empty content");
    }
    return result;
  }

  private async translateWithDsh(endpoint: DshEndpoint, text: string): Promise<string> {
    if (text.length > DSH_SINGLE_SHOT_MAX_CHARS) {
      return this.translateChunkedWithDsh(endpoint, text);
    }
    const single = await this.translateChunkWithDsh(endpoint, text);
    if (!single.truncated) {
      return single.translated;
    }
    // Never cache a length-truncated single-shot response; retry via smaller chunks
    // if splitting actually produces multiple pieces, otherwise fail cleanly.
    const plan = splitTranslationChunks(text, Math.min(DSH_CHUNK_MAX_CHARS, Math.max(400, Math.floor(text.length / 2))));
    if (plan.pieces.length > 1) {
      const translatedPieces: string[] = [];
      for (const piece of plan.pieces) {
        if (!needsChineseTranslation(piece)) {
          translatedPieces.push(piece);
          continue;
        }
        const chunkResult = await this.translateChunkWithDsh(endpoint, piece);
        if (chunkResult.truncated) {
          throw new Error("DSH translation output truncated");
        }
        translatedPieces.push(chunkResult.translated);
      }
      let combined = "";
      for (let i = 0; i < translatedPieces.length; i += 1) {
        combined += translatedPieces[i]! + (plan.seps[i] ?? "");
      }
      const result = combined.trim();
      if (result) return result;
    }
    throw new Error("DSH translation output truncated");
  }

  private async translateChunkMyMemory(
    chunk: string,
    target: "zh-CN",
    timeoutMs: number = MYMEMORY_TIMEOUT_MS,
  ): Promise<string> {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|${encodeURIComponent(target)}`;
    const response = await this.fetchWithTimeout(
      url,
      { headers: { Accept: "application/json" } },
      timeoutMs,
    );
    if (!response.ok) {
      throw new Error(`MyMemory HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      responseStatus?: unknown;
      responseData?: { translatedText?: unknown };
    };
    const status = Number(payload?.responseStatus);
    const raw = payload?.responseData?.translatedText;
    if (status !== 200 || typeof raw !== "string") {
      throw new Error(`MyMemory status ${String(payload?.responseStatus ?? "unknown")}`);
    }
    const decoded = decodeHtmlEntities(raw).trim();
    if (!decoded || MYMEMORY_WARNING_RE.test(decoded)) {
      throw new Error("MyMemory quota warning or empty translation");
    }
    return decoded;
  }

  private async translateWithMyMemory(text: string, target: "zh-CN"): Promise<string> {
    const { pieces, seps } = splitTranslationChunks(text, 420);
    if (pieces.length === 0) return text;
    const deadline = Date.now() + MYMEMORY_TOTAL_BUDGET_MS;
    const translatedPieces: string[] = [];
    for (const piece of pieces) {
      if (!needsChineseTranslation(piece)) {
        translatedPieces.push(piece);
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("MyMemory translation budget exceeded");
      }
      const chunkTimeout = Math.max(100, Math.min(MYMEMORY_TIMEOUT_MS, remaining));
      translatedPieces.push(await this.translateChunkMyMemory(piece, target, chunkTimeout));
    }
    let combined = "";
    for (let i = 0; i < translatedPieces.length; i += 1) {
      combined += translatedPieces[i]! + (seps[i] ?? "");
    }
    return combined.trim() || text;
  }

  async translate(text: string, target: "zh-CN" = "zh-CN"): Promise<TranslateResult> {
    if (!needsChineseTranslation(text)) {
      return { translated: text, cached: true, provider: "skip" };
    }
    await this.ensureLoaded();
    const entryHash = hashText(target, text);
    const hit = this.cache.get(entryHash);
    if (hit !== undefined) {
      this.cache.delete(entryHash);
      this.cache.set(entryHash, hit);
      return { translated: hit, cached: true, provider: "cache" };
    }

    const pending = this.inflight.get(entryHash);
    if (pending) return pending;

    const isPreviewPriority = text.length <= 240;
    const promise = this.runWithSlot(async () => {
      const endpoint = await this.getDshEndpoint();
      if (endpoint !== null) {
        try {
          const translated = await this.translateWithDsh(endpoint, text);
          this.remember(entryHash, translated);
          return { translated, cached: false, provider: "dsh" };
        } catch (error) {
          if (!this.allowPublicFallback) {
            throw error instanceof Error ? error : new Error("DSH translation failed");
          }
          // Explicitly opted-in fallback to MyMemory when the DSH endpoint fails.
        }
      } else if (!this.allowPublicFallback) {
        throw new Error("No local DSH translation endpoint configured");
      }
      const translated = await this.translateWithMyMemory(text, target);
      this.remember(entryHash, translated);
      return { translated, cached: false, provider: "mymemory" };
    }, isPreviewPriority).finally(() => {
      this.inflight.delete(entryHash);
    });

    this.inflight.set(entryHash, promise);
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    while (this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("ThinkingTranslator disposed"));
      }
    }
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.flushCache().catch(() => undefined);
    }
  }
}
