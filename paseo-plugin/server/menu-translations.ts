/**
 * Automatic localization of `/` menu descriptions the built-in tables do not know.
 *
 * `locale.ts` translates the commands and skills this repo has seen. Anything
 * else — a skill installed later, a command a new DSH version registers — would
 * keep its author's English. This module closes that gap with two layers:
 *
 * 1. **The user's own file**, `$DSH_HOME/paseo/locale/<locale>.json`: a flat
 *    `{ "<name>": "<description>" }` object. It wins over everything, including
 *    the built-in tables, so a wording the user dislikes can always be fixed
 *    without a release. It is never written by this module.
 * 2. **An automatic cache**, `$DSH_HOME/paseo/locale/<locale>.auto.json`: a line
 *    the session's model translated once (`paseo/translate` on the bridge),
 *    stored with the source text it was made from. A changed source text is a
 *    cache miss, so an updated skill is re-translated instead of showing the old
 *    meaning.
 *
 * Precedence for one entry: user file > built-in table > automatic cache >
 * original text. Only display copy is affected; the name (what DSH dispatches)
 * and the description the model reads when it picks a skill stay the author's.
 *
 * Failure handling (no silent degradation): a corrupt user file is reported once
 * in the log and ignored; a failed translation is logged with its cause, the
 * original text stays, and that source is not retried until the plugin process
 * restarts, so a broken route is not re-billed on every session open. Nothing
 * is ever cached that the model did not return — an omitted name stays missing.
 *
 * English hosts (`LOCALE === "en"`) never translate: their text already is the
 * source language.
 *
 * @module dsh-paseo/server/menu-translations
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locale } from "./locale";

/** Format version of the automatic cache; another version reads as empty. */
const CACHE_VERSION = 1;

/** Items per bridge request; the bridge refuses more than 40. */
export const TRANSLATE_BATCH = 40;

/** One menu entry as the runtime describes it. */
export interface MenuSource {
  name: string;
  description: string;
}

/** One cached line and the source it translated. */
interface CacheEntry {
  source: string;
  text: string;
}

/** Runs one batch on the bridge; answers only the names it translated. */
export type TranslateBatch = (items: Array<{ name: string; text: string }>) => Promise<Record<string, string>>;

/**
 * Whether a description is already in the target language.
 *
 * Only Chinese is a target today, and "contains Han characters" is the test: a
 * skill whose author already wrote Chinese (or mixed Chinese with code names) is
 * not sent to the model.
 */
export function alreadyLocalized(locale: Locale, text: string): boolean {
  if (locale !== "zh-CN") return true;
  return /\p{Script=Han}/u.test(text);
}

/** Where the user file and the cache live for one locale. */
export function localePaths(home: string, locale: Locale): { dir: string; user: string; cache: string } {
  const dir = join(home, "paseo", "locale");
  return { dir, user: join(dir, `${locale}.json`), cache: join(dir, `${locale}.auto.json`) };
}

export class MenuTranslations {
  readonly #locale: Locale;
  readonly #paths: { dir: string; user: string; cache: string };
  readonly #log: (line: string) => void;
  /** Built-in table membership, from `locale.ts`. */
  readonly #builtin: (name: string) => boolean;

  #user: Record<string, string> = {};
  /** `size:mtime` of the user file the map above was read from. */
  #userStamp = "";
  #cache = new Map<string, CacheEntry>();
  #cacheLoaded = false;
  /** `name\0source` pairs that failed or came back missing this process. */
  readonly #failed = new Set<string>();
  /** `name\0source` pairs currently being translated. */
  readonly #inflight = new Set<string>();
  /** Serializes batches so two sessions opening together do not pay twice. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    home: string;
    locale: Locale;
    log: (line: string) => void;
    builtin: (name: string) => boolean;
  }) {
    this.#locale = options.locale;
    this.#paths = localePaths(options.home, options.locale);
    this.#log = options.log;
    this.#builtin = options.builtin;
  }

  /** The user's own line for a name, when the user file has one. */
  userLine(name: string): string | undefined {
    this.#refreshUser();
    const line = this.#user[name];
    return line === undefined || line === "" ? undefined : line;
  }

  /** The cached automatic line for a name, valid only for this exact source. */
  autoLine(name: string, source: string): string | undefined {
    this.#loadCache();
    const entry = this.#cache.get(name);
    return entry !== undefined && entry.source === source ? entry.text : undefined;
  }

  /**
   * The entries that still show their source text and are worth one model call:
   * no user line, no built-in entry, no valid cache entry, not already in the
   * target language, not failed and not in flight in this process.
   */
  missing(entries: readonly MenuSource[]): MenuSource[] {
    if (this.#locale === "en") return [];
    const out: MenuSource[] = [];
    const names = new Set<string>();
    for (const entry of entries) {
      const source = entry.description.trim();
      if (source === "" || names.has(entry.name)) continue;
      if (alreadyLocalized(this.#locale, source)) continue;
      if (this.userLine(entry.name) !== undefined || this.#builtin(entry.name)) continue;
      if (this.autoLine(entry.name, entry.description) !== undefined) continue;
      const key = `${entry.name}\u0000${entry.description}`;
      if (this.#failed.has(key) || this.#inflight.has(key)) continue;
      names.add(entry.name);
      out.push(entry);
    }
    return out;
  }

  /**
   * Translate `entries` (from {@link missing}) and cache what comes back.
   *
   * @returns how many new lines were cached; 0 when everything failed.
   */
  translate(entries: readonly MenuSource[], run: TranslateBatch): Promise<number> {
    if (entries.length === 0) return Promise.resolve(0);
    const keys = entries.map((entry) => `${entry.name}\u0000${entry.description}`);
    for (const key of keys) this.#inflight.add(key);
    const job = this.#queue.then(() => this.#translateNow(entries, run));
    this.#queue = job.catch(() => undefined);
    return job.finally(() => {
      for (const key of keys) this.#inflight.delete(key);
    });
  }

  async #translateNow(entries: readonly MenuSource[], run: TranslateBatch): Promise<number> {
    let added = 0;
    for (let start = 0; start < entries.length; start += TRANSLATE_BATCH) {
      const batch = entries.slice(start, start + TRANSLATE_BATCH);
      let answer: Record<string, string>;
      try {
        answer = await run(batch.map((entry) => ({ name: entry.name, text: entry.description })));
      } catch (error) {
        for (const entry of batch) this.#failed.add(`${entry.name}\u0000${entry.description}`);
        this.#log(
          `menu translation failed for ${batch.map((entry) => entry.name).join(", ")}; ` +
            `keeping the original text until the plugin restarts: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const fresh: Array<[string, CacheEntry]> = [];
      const left: string[] = [];
      for (const entry of batch) {
        const text = answer[entry.name];
        if (typeof text === "string" && text.trim() !== "") {
          fresh.push([entry.name, { source: entry.description, text: text.trim() }]);
        } else {
          this.#failed.add(`${entry.name}\u0000${entry.description}`);
          left.push(entry.name);
        }
      }
      if (left.length > 0) {
        this.#log(`menu translation returned nothing for ${left.join(", ")}; keeping the original text`);
      }
      if (fresh.length > 0) {
        this.#store(fresh);
        added += fresh.length;
      }
    }
    return added;
  }

  /** Re-read the user file when its size or mtime changed; report a bad file once per version. */
  #refreshUser(): void {
    let stamp: string;
    try {
      const stat = statSync(this.#paths.user);
      stamp = `${String(stat.size)}:${String(stat.mtimeMs)}`;
    } catch {
      this.#user = {};
      this.#userStamp = "";
      return;
    }
    if (stamp === this.#userStamp) return;
    this.#userStamp = stamp;
    this.#user = {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#paths.user, "utf8"));
    } catch (error) {
      this.#log(
        `ignoring ${this.#paths.user}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.#log(`ignoring ${this.#paths.user}: expected an object of "name": "description"`);
      return;
    }
    const bad: string[] = [];
    const user: Record<string, string> = {};
    for (const [name, line] of Object.entries(parsed)) {
      if (typeof line === "string" && line.trim() !== "") user[name] = line.trim();
      else bad.push(name);
    }
    if (bad.length > 0) this.#log(`${this.#paths.user}: ignoring non-string entries ${bad.join(", ")}`);
    this.#user = user;
  }

  #readCacheFile(): Map<string, CacheEntry> {
    const out = new Map<string, CacheEntry>();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#paths.cache, "utf8"));
    } catch {
      return out; // absent or half-written: an empty cache, re-translated on demand
    }
    if (typeof parsed !== "object" || parsed === null) return out;
    const { version, entries } = parsed as { version?: unknown; entries?: unknown };
    if (version !== CACHE_VERSION || typeof entries !== "object" || entries === null) return out;
    for (const [name, value] of Object.entries(entries)) {
      if (typeof value !== "object" || value === null) continue;
      const { source, text } = value as { source?: unknown; text?: unknown };
      if (typeof source === "string" && typeof text === "string" && text !== "") out.set(name, { source, text });
    }
    return out;
  }

  #loadCache(): void {
    if (this.#cacheLoaded) return;
    this.#cacheLoaded = true;
    this.#cache = this.#readCacheFile();
  }

  /**
   * Merge new lines into the on-disk cache: re-read first so another plugin
   * process's lines survive, then write a temp file and rename it into place.
   * A write failure is logged; the lines still apply to this process.
   */
  #store(fresh: ReadonlyArray<[string, CacheEntry]>): void {
    this.#loadCache();
    const merged = this.#readCacheFile();
    for (const [name, entry] of this.#cache) if (!merged.has(name)) merged.set(name, entry);
    for (const [name, entry] of fresh) merged.set(name, entry);
    this.#cache = merged;
    try {
      mkdirSync(this.#paths.dir, { recursive: true });
      const tmp = `${this.#paths.cache}.${String(process.pid)}.tmp`;
      const body = { version: CACHE_VERSION, entries: Object.fromEntries(merged) };
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
      renameSync(tmp, this.#paths.cache);
    } catch (error) {
      this.#log(
        `could not write ${this.#paths.cache}; translations apply to this process only: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
