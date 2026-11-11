/**
 * A small on-disk cache for the runtime catalog, so a cold plugin process does
 * not have to boot a whole second `dsh` just to list models.
 *
 * The cost this removes (measured on the real profile): the first `session.open`
 * of a fresh provider connection awaits `loadCatalog()`, and that call spawns a
 * throwaway `dsh` ("catalog probe") because DSH only exposes the model list from
 * a live runtime. That probe boots the whole profile — measured **4.2 s** here —
 * and it is paid again after every reload (a reload is a new process, so the
 * in-memory cache starts empty). It is pure read-only metadata: models, thinking
 * options, the profile's fallback route. Persisting it across processes removes
 * the second boot.
 *
 * The two rules that keep this from becoming a stale-data cache (the lesson in
 * FIELD-NOTES 58: DSH materializes the catalog asynchronously, so an early read
 * answers **zero models** — a success that must never be stored):
 *
 * 1. **An empty model list is never written.** A catalog with no models is a
 *    probe that ran before the adapters registered, not a fact about the profile;
 *    caching it would turn a transient startup state into a permanent empty
 *    model picker.
 * 2. **Every read re-validates a fingerprint.** The cache is only used when the
 *    DSH binary (size + mtime), the profile's composition files
 *    (`cordis.yml`, `cordis.patch.yml`, `package.json`, the pnpm lock/workspace)
 *    — by **content hash** — and the credentials files are the same ones the entry
 *    was written against. The credentials files are only ever `stat`ed: size +
 *    mtime, their contents are never read into this process. An upgrade, a
 *    `dsh plugin` install, a profile edit or a new API key therefore invalidates
 *    it. A TTL caps staleness for changes that leave every stat untouched.
 *
 * A corrupt, truncated, half-written or differently-versioned file answers
 * "no cache": the caller probes, which is exactly what it would have done
 * without this module.
 *
 * @module dsh-paseo/server/catalog-cache
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Format version of the on-disk entry; another version is read as "no cache". */
const ENTRY_VERSION = 1;

/**
 * How long an entry may be used when its fingerprint still matches.
 *
 * The fingerprint is what makes this correct; the TTL only bounds the case where
 * nothing that is fingerprinted changed but the models did (a provider list served
 * from the network, a remote-side model retirement).
 */
export const CATALOG_DISK_TTL_MS = 24 * 60 * 60 * 1000;

/** Files of the profile whose contents decide the catalog, and so the fingerprint. */
const PROFILE_FILES = ["cordis.yml", "cordis.patch.yml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

/** Credential files: adding or rotating a provider key changes the model list. */
const CREDENTIAL_FILES = [".credentials.yaml", ".credentials.yml", "credentials.json"];

/** One file's identity in the fingerprint; `absent` keeps that distinguishable from empty. */
function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${String(stat.size)}:${String(stat.mtimeMs)}`;
  } catch {
    return "absent";
  }
}

/**
 * A small file's identity by **content**, not by modification time.
 *
 * The profile files cannot be fingerprinted by mtime: the plugin's own
 * `ensurePaseoProfile()` rewrites `cordis.yml` on every load — deliberately, so an
 * updated plugin carries its bridge — which would invalidate the cache in exactly
 * the case it exists for (the next process). Hashing them is cheap (a few tens of
 * KB) and exact.
 */
function contentStamp(path: string): string {
  let data;
  try {
    data = readFileSync(path);
  } catch {
    return "absent";
  }
  return `sha256:${createHash("sha256").update(data).digest("hex").slice(0, 32)}:${String(data.length)}`;
}

/**
 * The `dsh --version` string, memoized per process.
 *
 * The binary's own stat is not always resolvable (a bare `dsh` on PATH), and an
 * upgrade is the one input that changes the model list wholesale. It costs one
 * short process launch on the first cold catalog read of a process — against the
 * whole-profile boot the cache replaces.
 */
let memoizedVersion: string | undefined;
function dshVersionStamp(binary: string): string {
  if (memoizedVersion !== undefined) return memoizedVersion;
  try {
    const out = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    memoizedVersion = `version:${out.trim()}`;
  } catch {
    memoizedVersion = "version:unknown";
  }
  return memoizedVersion;
}

/**
 * Identify everything the catalog is a function of.
 *
 * Synchronous and cheap (a handful of `stat`s): it runs on the open path, so it
 * must never spawn anything or read file contents. The DSH binary is resolved
 * through `realpath` so an upgrade behind a symlink still changes the stamp.
 *
 * @param options.home - absolute `$DSH_HOME`.
 * @param options.profile - profile name the catalog is for.
 * @param options.binary - resolved `dsh` executable path.
 * @returns a stable string; equality means "same inputs, the entry is usable".
 */
export function catalogFingerprint(options: { home: string; profile: string; binary: string }): string {
  const profileDir = join(options.home, "profiles", options.profile);
  let binaryPath = options.binary;
  try {
    binaryPath = realpathSync(binaryPath);
  } catch {
    /* a bare name on PATH: the stamp below is then `absent`, which invalidates */
  }
  const parts = [
    `binary=${fileStamp(binaryPath)}`,
    `dsh=${dshVersionStamp(options.binary)}`,
    ...PROFILE_FILES.map((name) => `profile:${name}=${contentStamp(join(profileDir, name))}`),
    ...CREDENTIAL_FILES.map((name) => `cred:${name}=${fileStamp(join(options.home, name))}`),
  ];
  return parts.join("|");
}

/**
 * Where one (home, profile, cwd) cache entry lives.
 *
 * Keyed by cwd as well as the profile, matching the in-memory cache: the catalog
 * is profile-level today, but keying it the same way as memory means the two
 * layers can never disagree about which catalog a workspace gets.
 *
 * @param options.home - absolute `$DSH_HOME` (the cache lives under it, never /tmp).
 * @param options.profile - profile name.
 * @param options.cwd - workspace the catalog was read for.
 */
export function catalogCachePath(options: { home: string; profile: string; cwd: string }): string {
  const digest = createHash("sha256")
    .update(`${options.home}\u0000${options.profile}\u0000${options.cwd}`)
    .digest("hex")
    .slice(0, 24);
  return join(options.home, "paseo", "catalog", `${digest}.json`);
}

/** Shape of the on-disk entry. `catalog` is opaque here: the caller owns its type. */
interface CatalogCacheEntry<T> {
  version: number;
  writtenAt: number;
  fingerprint: string;
  catalog: T;
}

/** Whether `catalog` carries a non-empty model list (the FIELD-NOTES 58 rule). */
function hasModels(catalog: unknown): boolean {
  if (typeof catalog !== "object" || catalog === null) return false;
  const models = (catalog as { models?: unknown }).models;
  return Array.isArray(models) && models.length > 0;
}

/**
 * Read one entry, validating version, age, fingerprint and the non-empty rule.
 *
 * @param options.path - cache file path.
 * @param options.fingerprint - fingerprint from {@link catalogFingerprint}.
 * @param options.now - clock (injected by checks).
 * @returns the cached catalog, or undefined when the entry must not be used.
 */
export function readCatalogCache<T>(options: {
  path: string;
  fingerprint: string;
  now?: number;
}): T | undefined {
  let text: string;
  try {
    text = readFileSync(options.path, "utf8");
  } catch {
    return undefined;
  }
  let entry: Partial<CatalogCacheEntry<T>>;
  try {
    entry = JSON.parse(text) as Partial<CatalogCacheEntry<T>>;
  } catch {
    return undefined;
  }
  if (typeof entry !== "object" || entry === null) return undefined;
  if (entry.version !== ENTRY_VERSION) return undefined;
  if (typeof entry.writtenAt !== "number" || typeof entry.fingerprint !== "string") return undefined;
  const now = options.now ?? Date.now();
  if (now - entry.writtenAt >= CATALOG_DISK_TTL_MS) return undefined;
  if (entry.fingerprint !== options.fingerprint) return undefined;
  if (!hasModels(entry.catalog)) return undefined;
  return entry.catalog;
}

/**
 * Write one entry atomically (temp file + rename in the cache directory).
 *
 * Refuses an empty model list: that is the startup race, not an answer. A write
 * failure is reported through the return value and never thrown — the catalog is
 * already in hand, and a read-only `$DSH_HOME` must not fail the open.
 *
 * @param options.path - cache file path.
 * @param options.fingerprint - fingerprint from {@link catalogFingerprint}.
 * @param options.catalog - the catalog that was just read.
 * @param options.now - clock (injected by checks).
 * @returns whether an entry was written.
 */
export function writeCatalogCache<T>(options: {
  path: string;
  fingerprint: string;
  catalog: T;
  now?: number;
}): boolean {
  if (!hasModels(options.catalog)) return false;
  const entry: CatalogCacheEntry<T> = {
    version: ENTRY_VERSION,
    writtenAt: options.now ?? Date.now(),
    fingerprint: options.fingerprint,
    catalog: options.catalog,
  };
  try {
    mkdirSync(dirname(options.path), { recursive: true });
  } catch {
    return false;
  }
  const temp = `${options.path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(entry)}\n`, "utf8");
    renameSync(temp, options.path);
    return true;
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}