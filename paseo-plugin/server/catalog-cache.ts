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
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { BRIDGE_PACKAGE_NAME } from "./bridge-assets";
import { resolveDshCommand } from "./dsh-command.mjs";

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

/**
 * Fingerprint input schema revision baked into the digest.
 *
 * Bumping this invalidates older disk entries without changing `ENTRY_VERSION`
 * (existing harnesses construct `version: 1` fixtures directly).
 */
const FINGERPRINT_SCHEMA = "v2";

/** Credential files: adding or rotating a provider key changes the model list. */
const CREDENTIAL_FILES = [".credentials.yaml", ".credentials.yml", "credentials.json"];

/**
 * Environment keys that vary per session or shell invocation without shaping the
 * DSH profile catalog.
 *
 * Excluding these keeps cross-process disk cache hits stable across daemon
 * restarts and agent opens while hashing every key that can affect DSH's
 * binary resolution, home/profile selection, proxy, TLS, or provider keys.
 */
const VOLATILE_ENV_KEYS = new Set([
  "PASEO_AGENT_ID",
  "PASEO_AGENT_CWD",
  "PASEO_WORKSPACE_ID",
  "DSH_PASEO_AGENT_ID",
  "DSH_PASEO_AGENT_CWD",
  "DSH_PASEO_WORKSPACE_ID",
  "_",
  "SHLVL",
  "PWD",
  "OLDPWD",
  // systemd / service-manager per-invocation keys that rotate on daemon restart
  // without changing DSH's catalog.
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "SYSTEMD_EXEC_PID",
  "LISTEN_PID",
  "LISTEN_FDS",
  "LISTEN_FDNAMES",
  "NOTIFY_SOCKET",
]);

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One file's metadata-only identity (`size`, nanosecond `mtime`/`ctime`, `ino`).
 *
 * `absent` stays distinguishable from an empty file. Using bigint nanosecond
 * timestamps catches same-millisecond equal-length overwrites (e.g. rotating a
 * key of the same byte length) without ever reading the file's contents.
 */
function fileStamp(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${String(stat.size)}:${String(stat.mtimeNs)}:${String(stat.ctimeNs)}:${String(stat.ino)}`;
  } catch {
    return "absent";
  }
}

/**
 * A small file's identity by **content**, not by modification time.
 *
 * The profile files cannot be fingerprinted by mtime: the plugin's own
 * `ensurePaseoProfile()` rewrites files on load, which would invalidate the
 * cache in exactly the case it exists for (the next process). Hashing them is
 * cheap (a few tens of KB) and exact.
 */
function contentStamp(path: string): string {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return "absent";
  }
  return `sha256:${createHash("sha256").update(data).digest("hex").slice(0, 32)}:${String(data.length)}`;
}

/**
 * Regular files under `dir` in deterministic name order; a missing directory
 * yields none. Symlinks are followed with cycle protection so a symlinked bridge
 * (e.g. from `install.sh`) is fingerprinted just like a copied one.
 */
function filesIn(dir: string, recursive: boolean, visited = new Set<string>()): string[] {
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return [];
  }
  if (visited.has(realDir)) return [];
  visited.add(realDir);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => byName(a.name, b.name))) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile()) {
      files.push(fullPath);
    } else if (recursive && entry.isDirectory()) {
      files.push(...filesIn(fullPath, true, visited));
    } else if (entry.isSymbolicLink()) {
      try {
        const target = statSync(fullPath);
        if (target.isFile()) files.push(fullPath);
        else if (recursive && target.isDirectory()) files.push(...filesIn(fullPath, true, visited));
      } catch {
        // Record dangling symlinks so removing/repointing them invalidates too.
        try {
          lstatSync(fullPath);
          files.push(fullPath);
        } catch {
          /* vanished between readdir and lstat */
        }
      }
    }
  }
  return files;
}

/**
 * Resolve a bare command name (e.g. `"dsh"` or `"node.exe"`) along `env.PATH`
 * (plus `PATHEXT` on Windows), or resolve a path containing separators against
 * `baseDir`. Returns the first executable match, or `command` unchanged when no
 * candidate can be found.
 */
function resolveExecutableOnPath(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  baseDir: string,
): string {
  if (command === "") return command;
  if (command.includes("/") || command.includes("\\")) {
    return resolve(baseDir, command);
  }
  const pathKey = Object.keys(env).sort(byName).find((key) => key.toLowerCase() === "path");
  const rawPath = pathKey === undefined ? "" : (env[pathKey] ?? "");
  if (rawPath === "") return command;

  const isWin = process.platform === "win32";
  const dirs = rawPath.split(delimiter).map((entry) => {
    const cleaned = entry.replace(/^"|"$/g, "");
    return cleaned === "" ? baseDir : resolve(baseDir, cleaned);
  });

  let exts: string[] = [""];
  if (isWin) {
    const pathextKey = Object.keys(env).sort(byName).find((key) => key.toLowerCase() === "pathext");
    const rawExt = pathextKey === undefined ? "" : (env[pathextKey] ?? "");
    const configured = (rawExt || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((ext) => ext.trim())
      .filter((ext) => ext !== "");
    exts = extname(command) !== "" ? ["", ...configured] : configured;
  }

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${command}${ext}`);
      try {
        const stat = statSync(candidate);
        if (!stat.isFile()) continue;
        if (!isWin) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* continue searching PATH */
      }
    }
  }
  return command;
}

/**
 * Resolve `launch.args[0]` to a local file path when the launcher wraps a
 * script entrypoint (for example Windows npm shim resolution returning
 * `{ command: "node.exe", args: [".../dsh/bin/dsh.js"] }`).
 */
function launchEntryStamp(launch: { command: string; args: string[] }, baseDir: string): string {
  const firstArg = launch.args[0];
  if (firstArg === undefined || firstArg === "" || firstArg.startsWith("-")) return "none";
  const resolved = realpathOrRaw(resolve(baseDir, firstArg));
  return fileStamp(resolved);
}

/**
 * The `dsh --version` string, memoized per resolved launcher + binary/entry stat.
 *
 * Keying on the resolved executable path, arguments, binary stamp, and script
 * entry stamp keeps the hot path at one short launch per binary while noticing
 * upgrades behind symlinks, bare PATH shims, or Windows `.cmd` → `node.exe`
 * script entrypoints. Transient failures (`version:unknown`) are never cached.
 */
const memoizedVersions = new Map<string, string>();
function dshVersionStamp(
  launch: { command: string; args: string[] },
  resolvedCommandPath: string,
  launchStamp: string,
  entryStamp: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const key = JSON.stringify([resolvedCommandPath, launch.args, launchStamp, entryStamp]);
  const cached = memoizedVersions.get(key);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync(launch.command, [...launch.args, "--version"], {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: env as NodeJS.ProcessEnv,
    });
    const version = `version:${out.trim()}`;
    memoizedVersions.set(key, version);
    return version;
  } catch {
    // Do not memoize failures so a transient timeout/error never poisons the
    // process forever.
    return "version:unknown";
  }
}

/**
 * Normalize environment entries deterministically for hashing.
 *
 * Raw values are fed only into a one-way SHA-256 hash and never written to the
 * on-disk cache file, so provider API keys and tokens cannot leak through the
 * persisted fingerprint.
 */
function normalizedEnvEntries(env: Readonly<Record<string, string | undefined>>): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (VOLATILE_ENV_KEYS.has(key)) continue;
    // Test-harness fake-bridge control knobs are never read by real DSH.
    if (key.startsWith("DSH_FAKE_")) continue;
    entries.push([key, value]);
  }
  entries.sort(([a], [b]) => byName(a, b));
  return entries;
}

/** Resolve symlinks best-effort for binary stat checks. */
function realpathOrRaw(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Identify everything the catalog is a function of as a single SHA-256 digest.
 *
 * Covers:
 * - resolved DSH command (`resolveDshCommand`, executable `stat`, `--version`);
 * - profile name;
 * - normalized process environment (hashed one-way, never persisted in clear);
 * - home-level `$DSH_HOME/cordis.patch.yml` (content hash);
 * - credential files under `$DSH_HOME` (`stat` only — contents are never read);
 * - regular files in `$DSH_HOME/profiles/<profile>` (content hash);
 * - installed bridge files under `$DSH_HOME/profiles/node_modules/dsh-paseo-bridge`
 *   (and legacy `<profile>/node_modules/dsh-paseo-bridge` if present, content hash).
 *
 * Synchronous and cheap: runs on both the catalog read path and `prewarmRoute`.
 *
 * @param options.home - absolute `$DSH_HOME`.
 * @param options.profile - profile name the catalog is for.
 * @param options.binary - resolved `dsh` executable path.
 * @param options.env - environment to fingerprint (defaults to `process.env`).
 * @param options.cwd - base directory for resolving relative DSH launch paths.
 * @returns a stable opaque digest; equality means "same inputs, entry is usable".
 */
export function catalogFingerprint(options: {
  home: string;
  profile: string;
  binary: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}): string {
  const env = options.env ?? process.env;
  const baseDir = options.cwd ?? process.cwd();
  const launch = resolveDshCommand(options.binary, env, baseDir);
  const binaryPath = realpathOrRaw(resolveExecutableOnPath(options.binary, env, baseDir));
  const launchPath = realpathOrRaw(resolveExecutableOnPath(launch.command, env, baseDir));
  const binaryStamp = fileStamp(binaryPath);
  const launchStamp = launchPath === binaryPath ? binaryStamp : fileStamp(launchPath);
  const entryStamp = launchEntryStamp(launch, baseDir);
  const versionStamp = dshVersionStamp(launch, launchPath, launchStamp, entryStamp, env);

  const profileDir = join(options.home, "profiles", options.profile);
  const sharedBridgeDir = join(options.home, "profiles", "node_modules", BRIDGE_PACKAGE_NAME);
  const legacyBridgeDir = join(profileDir, "node_modules", BRIDGE_PACKAGE_NAME);

  const hash = createHash("sha256");
  const feed = (tag: string, value: string): void => {
    hash.update(`${tag}\u0000${String(Buffer.byteLength(value, "utf8"))}\u0000${value}\u0000`);
  };

  feed("schema", FINGERPRINT_SCHEMA);
  feed("home", options.home);
  feed("profile", options.profile);
  feed("binary", options.binary);
  feed("binaryPath", binaryPath);
  feed("binaryStamp", binaryStamp);
  feed("launch", JSON.stringify(launch));
  feed("launchPath", launchPath);
  feed("launchStamp", launchStamp);
  feed("launchEntryStamp", entryStamp);
  feed("version", versionStamp);

  for (const [key, value] of normalizedEnvEntries(env)) {
    feed(`env:${key}`, value);
  }

  // Home-level patch (content hash).
  const homePatch = join(options.home, "cordis.patch.yml");
  feed(`home-patch:${homePatch}`, contentStamp(homePatch));

  // Credentials (metadata-only stat; never read secret contents into memory).
  for (const name of CREDENTIAL_FILES) {
    feed(`cred:${name}`, fileStamp(join(options.home, name)));
  }

  // Profile root files (content hash, deterministic name order). Any file named
  // like a credential file is still stat-only so secret bytes are never read.
  const credentialNames = new Set(CREDENTIAL_FILES);
  for (const file of filesIn(profileDir, false)) {
    const stamp = credentialNames.has(basename(file)) ? fileStamp(file) : contentStamp(file);
    feed(`profile-file:${file}`, stamp);
  }

  // Provisioned bridge at the shared anchor, plus any legacy copy inside the profile.
  for (const file of filesIn(sharedBridgeDir, true)) {
    feed(`shared-bridge:${file}`, contentStamp(file));
  }
  for (const file of filesIn(legacyBridgeDir, true)) {
    feed(`legacy-bridge:${file}`, contentStamp(file));
  }

  return `sha256:${hash.digest("hex")}`;
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
  return join(catalogCacheDir({ home: options.home }), `${digest}.json`);
}

/**
 * The directory every (home, profile, cwd) entry lives in.
 *
 * @param options.home - absolute `$DSH_HOME`.
 */
export function catalogCacheDir(options: { home: string }): string {
  return join(options.home, "paseo", "catalog");
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
  const entry = parseCatalogEntry<T>(options);
  return entry === undefined ? undefined : entry.catalog;
}

/**
 * Validate one entry's raw file against every rule the cache promises.
 *
 * Shared by the single-path read and the whole-directory scan so the two cannot
 * disagree about what a usable entry is (version, age, fingerprint, non-empty
 * models).
 *
 * @param options - path, fingerprint and clock, as {@link readCatalogCache} takes.
 * @returns the entry's catalog and write time, or undefined when it must not be used.
 */
function parseCatalogEntry<T>(options: {
  path: string;
  fingerprint: string;
  now?: number;
}): CatalogCacheEntry<T> | undefined {
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
  return entry as CatalogCacheEntry<T>;
}

/**
 * Read the newest usable entry for this runtime, whichever workspace wrote it.
 *
 * Exists for the pool prewarm (`provider.ts#prewarmRoute`): the plugin wants the
 * profile's default route **before** any session exists, so it has no cwd to key
 * the cache by — and the catalog is profile-level anyway, so every entry carries
 * the same profile default. Scanning is one `readdir` plus a few file reads, none
 * of which may spawn anything: a probe here would boot a whole `dsh`, which is the
 * cost the prewarm exists to move, not to double.
 *
 * **Why there is no `profile` argument.** The fingerprint is what scopes an entry
 * to a profile: it hashes that profile's composition files under
 * `profiles/<profile>/` (plus the DSH binary and the credentials files), so an
 * entry written for another profile does not match. A second profile-shaped check
 * here would have to be built from something the directory does not offer: the
 * file name is a digest of `(home, profile, cwd)` and cannot be re-derived without
 * the cwd the entry was written for, so scanning and matching the fingerprint is
 * the only check available. (The catalog itself is profile-level, so an entry for
 * another workspace of the **same** profile is the same catalog.) Two profiles
 * with byte-identical composition files would share a fingerprint by construction
 * — that is a limitation of the fingerprint's inputs, which do not include the
 * profile's installed packages, and it predates this scan.
 *
 * @param options - `$DSH_HOME`, fingerprint and clock.
 * @returns the catalog of the newest matching entry, or undefined when none is usable.
 */
export function readAnyCatalogCache<T>(options: {
  home: string;
  fingerprint: string;
  now?: number;
}): T | undefined {
  const dir = catalogCacheDir({ home: options.home });
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let newest: CatalogCacheEntry<T> | undefined;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const entry = parseCatalogEntry<T>({
      path: join(dir, name),
      fingerprint: options.fingerprint,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (entry === undefined) continue;
    if (newest === undefined || entry.writtenAt > newest.writtenAt) newest = entry;
  }
  return newest === undefined ? undefined : newest.catalog;
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