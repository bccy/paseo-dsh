/**
 * Daemon-side Environment Overview and On-Demand Doctor service.
 *
 * Delegates all profile, bridge, route, composition, and credential validation
 * to the shared core in `lib/doctor.mjs` (zero duplicated validation logic).
 *
 * - `dsh.diagnostics.overview`: fast read-only file inspection + lightweight
 *   in-memory DSH version cache (reads `@deepseek-ai/dsh/package.json` when
 *   available with zero subprocesses, falling back to a single cached bounded
 *   `--version` probe for wrappers/shims).
 * - `dsh.diagnostics.run-doctor` (`diagnosticsRunDoctorRpc`): on-demand full
 *   doctor execution (including `dsh --profile <p> --dump-config`), protected
 *   by a server-side single-flight mutex and a 20s timeout with clean
 *   subprocess teardown.
 *
 * Security redline: raw `.credentials.yaml` contents, API key values, provider
 * auth headers, URL credentials/queries, and YAML parser error snippets for
 * `.credentials.yaml` are NEVER returned by any method or error path.
 *
 * @module dsh-paseo/server/diagnostics
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  diagnosticsOverviewRpc,
  diagnosticsRunDoctorRpc,
  type DiagnosticsOverview,
  type DiagnosticsOverviewInput,
  type DoctorCheckItem,
  type DoctorReport,
  type RunDoctorInput,
} from "../shared/diagnostics";
import { BRIDGE_FILES } from "./bridge-assets";
import { resolveDshCommand } from "./dsh-command.mjs";

export const DEFAULT_DOCTOR_TIMEOUT_MS = 20_000;
export const DEFAULT_VERSION_CACHE_TTL_MS = 5 * 60_000;
const VERSION_PROBE_TIMEOUT_MS = 3_000;
const MIN_RPC_TIMEOUT_MS = 1_000;
const MAX_RPC_TIMEOUT_MS = 60_000;

/** Runtime shape of `lib/doctor.mjs` exports consumed by this module. */
export interface DoctorModule {
  MINIMUM_DSH: string;
  MINIMUM_PASEO: string;
  parseVersion(value: unknown): { major: number; minor: number; patch: number; prerelease?: string } | undefined;
  compareCore(
    a: { major: number; minor: number; patch: number },
    b: { major: number; minor: number; patch: number },
  ): number;
  resolveDshHome(env?: Readonly<Record<string, string | undefined>>, cwd?: string): string;
  redactBaseUrlHost(rawUrl: unknown): string | undefined;
  inspectInstallFiles(options?: Record<string, unknown>): DoctorFileInspection;
  runDoctorChecksAsync(options?: Record<string, unknown>): Promise<RawDoctorReport>;
}

export interface DoctorRunner {
  exec?: (
    cmd: string,
    args: string[],
    opts?: {
      env?: Readonly<Record<string, string | undefined>>;
      cwd?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ) => string | undefined | Promise<string | undefined>;
  dumpProfile?: (
    profile: string,
    launcher: { command: string; args: string[] },
    opts?: {
      env?: Readonly<Record<string, string | undefined>>;
      cwd?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ) =>
    | { status: number | null; stderr: string; error?: Error; timedOut?: boolean }
    | Promise<{ status: number | null; stderr: string; error?: Error; timedOut?: boolean }>;
}

interface DoctorFileInspection {
  dshHome: string;
  profile: string;
  profileFromEnv: boolean;
  profileDir: string;
  binary: string;
  launcher: { command: string; args: string[] };
  dshPath?: string;
  platform: string;
  profileExists: boolean;
  profileBundle: {
    ok: boolean;
    bundles: string[];
    label?: string;
    detail?: string;
    fixHint?: string;
  };
  bridge: {
    status: "provisioned" | "shadowed" | "incomplete" | "missing" | "unverified";
    location: "shared" | "local" | "both" | "none";
    activeDir: string;
    localDir: string;
    sharedDir: string;
    shadowed: boolean;
    fileListError?: string;
    expectedFiles: number;
    presentFiles: number;
    missingFiles: string[];
  };
  yamlAvailable: boolean;
  patch: {
    path: string;
    exists: boolean;
    readError?: string;
    yamlError?: string;
    listError?: string;
    status:
      | "configured"
      | "missing-patch"
      | "invalid-yaml"
      | "invalid-patch"
      | "missing-default"
      | "disabled"
      | "incomplete"
      | "unknown-provider"
      | "unverified";
    defaultProvider?: string;
    defaultModel?: string;
    defaultReasoningEffort?: string;
    label?: string;
    detail?: string;
    fixHint?: string;
  };
  providers: Array<{
    id: string;
    displayName?: string;
    api?: string;
    baseUrlHost?: string;
    apiKeyEnv?: string;
    credentialReady?: boolean;
    isDefault: boolean;
    models: Array<{ id: string; name?: string }>;
  }>;
  credentials: {
    path: string;
    exists: boolean;
    readable: boolean;
    readError?: string;
    modeOctal?: string;
    ownerOnly?: boolean;
    formatValid?: boolean;
    legacy: boolean;
    contractProblems: Array<{ label: string; detail: string; fixHint?: string }>;
    referencedRefs: Array<{ name: string; present: boolean }>;
    missingRefs: string[];
    status:
      | "ready"
      | "missing-file"
      | "unreadable"
      | "bad-permissions"
      | "invalid-yaml"
      | "invalid-contract"
      | "missing-refs"
      | "no-refs-needed"
      | "unverified";
    fixHint?: string;
  };
}

interface RawDoctorReport {
  fatalError?: string;
  pluginVersion?: string;
  dshHome: string;
  profile: string;
  profileFromEnv: boolean;
  profileDir: string;
  binary: string;
  dshPath?: string;
  dshVersion?: string;
  paseoVersion?: string;
  checks: DoctorCheckItem[];
  summary: {
    ok: number;
    warn: number;
    fail: number;
    total: number;
    blocking: boolean;
    exitCode: number;
  };
  timedOut: boolean;
}

export interface DiagnosticsServiceOptions {
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  platform?: NodeJS.Platform;
  dshHome?: string;
  profile?: string;
  binary?: string;
  pluginVersion?: string;
  pluginDir?: string;
  bridgeFiles?: string[] | { keys?: string[]; error?: string };
  doctorModule?: DoctorModule;
  doctorModulePath?: string;
  yamlParser?: { name: "yaml" | "js-yaml"; module: { parse?: (s: string) => unknown; load?: (s: string) => unknown } } | null;
  runner?: DoctorRunner;
  versionCacheTtlMs?: number;
  doctorTimeoutMs?: number;
  probeVersionOnCacheMiss?: boolean;
  checkBundledPaseo?: boolean;
  now?: () => number;
}

interface CachedVersionEntry {
  version: string;
  cachedAt: number;
}

// Keep native `import()` untouched when TypeScript compiles to CommonJS
// (`register-typescript.cjs` and `harness/plugin-build.cjs`).
const nativeDynamicImport = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<unknown>;

/**
 * Defense-in-depth secret redaction applied to free-text diagnostic messages.
 *
 * Credential values are never read into diagnostics in the first place; this
 * additionally strips accidental inline secrets (e.g., Bearer tokens, API keys,
 * URL userinfo, or key=value pairs) from any surfaced diagnostic string.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>")
    .replace(/\b((?:sk|pk|ak|rk|ghp|gho|ghu|github_pat|xox[a-z]|AIza)[-_])[A-Za-z0-9._-]{6,}/gi, "$1<redacted>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@:]+):([^/\s@]+)@/gi, "$1<redacted>@")
    .replace(/([?&](?:api[_-]?key|token|key|secret|password)=)([^&\s#]+)/gi, "$1<redacted>")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)([^\s,"'\]}]+)/gi, "$1<redacted>");
}

/**
 * Redact a baseURL to `scheme://host` only (strips userinfo, path, query, and fragment).
 */
export function redactBaseUrlHost(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return undefined;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

function shortPath(target: string): string {
  const home = homedir();
  if (target === home) return "~";
  if (target.startsWith(`${home}/`) || target.startsWith(`${home}\\`)) {
    return `~${target.slice(home.length)}`;
  }
  return target;
}

function fileStamp(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${String(stat.size)}:${String(stat.mtimeNs)}:${String(stat.ctimeNs)}:${String(stat.ino)}`;
  } catch {
    return "absent";
  }
}

function realpathOrRaw(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function resolveExecutable(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  platform: NodeJS.Platform,
): { resolvedPath?: string; error?: string } {
  if (command === "") return { error: "DSH binary name is empty" };
  const isWin = platform === "win32";
  if (command.includes("/") || command.includes("\\")) {
    const abs = resolve(cwd, command);
    try {
      const stat = statSync(abs);
      if (!stat.isFile()) return { error: `configured DSH binary "${command}" is not a regular file` };
      if (!isWin) accessSync(abs, constants.X_OK);
      return { resolvedPath: abs };
    } catch {
      return { error: `configured DSH binary "${command}" does not exist or is not executable` };
    }
  }

  const pathKey = Object.keys(env).sort(byName).find((key) => key.toLowerCase() === "path");
  const rawPath = pathKey === undefined ? "" : (env[pathKey] ?? "");
  if (rawPath === "") return {};

  const pathSep = isWin ? ";" : delimiter;
  const dirs = rawPath
    .split(pathSep)
    .map((entry) => entry.replace(/^"|"$/g, ""))
    .filter((entry) => entry !== "")
    .map((entry) => resolve(cwd, entry));

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
        return { resolvedPath: candidate };
      } catch {
        /* keep searching PATH */
      }
    }
  }
  return {};
}

/**
 * Fast 0-subprocess version lookup for an official `@deepseek-ai/dsh` install:
 * walks up from the resolved binary's realpath to `@deepseek-ai/dsh/package.json`.
 */
function readDshPackageVersion(entryPath: string): string | undefined {
  let real: string;
  try {
    real = realpathSync(entryPath);
  } catch {
    return undefined;
  }
  let dir = dirname(real);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, "package.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { name?: unknown }).name === "@deepseek-ai/dsh" &&
        typeof (parsed as { version?: unknown }).version === "string"
      ) {
        const version = ((parsed as { version: string }).version).trim();
        if (version !== "") return version;
      }
    } catch {
      /* keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function probeVersionAsync(
  cmd: string,
  args: string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolveProbe) => {
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "ignore"],
        env: env as NodeJS.ProcessEnv,
        cwd,
      });
    } catch {
      resolveProbe(undefined);
      return;
    }
    let settled = false;
    let out = "";
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const force = setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 300);
      force.unref?.();
      finish(undefined);
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (out.length < 4096) out += chunk;
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(undefined);
        return;
      }
      const first = out
        .trim()
        .split("\n")
        .find((line) => line.trim() !== "");
      finish(first?.trim() || undefined);
    });
  });
}

function walkAncestorsForDoctor(startDir: string, maxDepth: number, requireManifest: boolean): string | undefined {
  let dir = resolve(startDir);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = join(dir, "lib", "doctor.mjs");
    if (existsSync(candidate) && (!requireManifest || existsSync(join(dir, "paseo-plugin.json")))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function stackFrameDirs(): string[] {
  const stack = new Error().stack ?? "";
  const dirs = new Set<string>();
  for (const match of stack.matchAll(/file:\/\/\/[^\s):]+/g)) {
    try {
      dirs.add(dirname(fileURLToPath(match[0])));
    } catch {
      /* ignore malformed frame */
    }
  }
  return [...dirs];
}

/**
 * Locate `lib/doctor.mjs` across all execution environments:
 * source checkout (`paseo-plugin/server`), compiled harness trees
 * (`paseo-plugin/.dbg-xxx/server`), Paseo plugin-process, and explicit overrides.
 */
export function resolveDoctorModulePath(options?: {
  doctorModulePath?: string;
  pluginDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}): string | undefined {
  if (options?.doctorModulePath !== undefined) {
    return existsSync(options.doctorModulePath) ? resolve(options.doctorModulePath) : undefined;
  }
  if (options?.pluginDir !== undefined) {
    const candidate = join(resolve(options.pluginDir), "lib", "doctor.mjs");
    if (existsSync(candidate)) return candidate;
  }
  const envDir = (options?.env ?? process.env)["PASEO_PLUGIN_DIR"];
  if (typeof envDir === "string" && envDir.trim() !== "") {
    const candidate = join(resolve(envDir), "lib", "doctor.mjs");
    if (existsSync(candidate)) return candidate;
  }
  if (typeof __dirname === "string" && __dirname !== "") {
    const found = walkAncestorsForDoctor(__dirname, 6, false);
    if (found !== undefined) return found;
  }
  const cwd = options?.cwd ?? process.cwd();
  const directFromCwd = join(cwd, "lib", "doctor.mjs");
  if (existsSync(directFromCwd)) return directFromCwd;
  const subFromCwd = join(cwd, "paseo-plugin", "lib", "doctor.mjs");
  if (existsSync(subFromCwd)) return subFromCwd;
  const fromCwdAncestors = walkAncestorsForDoctor(cwd, 4, true);
  if (fromCwdAncestors !== undefined) return fromCwdAncestors;

  if (typeof process.argv[1] === "string" && process.argv[1] !== "") {
    const fromArgv = walkAncestorsForDoctor(dirname(resolve(process.argv[1])), 6, true);
    if (fromArgv !== undefined) return fromArgv;
  }
  for (const dir of stackFrameDirs()) {
    const fromStack = walkAncestorsForDoctor(dir, 6, true);
    if (fromStack !== undefined) return fromStack;
  }
  return undefined;
}

function readPluginVersionNear(doctorPath?: string): string | undefined {
  if (doctorPath === undefined) return undefined;
  const pkgPath = join(dirname(doctorPath), "..", "package.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { version?: unknown }).version === "string"
    ) {
      const version = (parsed as { version: string }).version.trim();
      return version === "" ? undefined : version;
    }
  } catch {
    /* optional metadata */
  }
  return undefined;
}

function sanitizeCheckItem(item: DoctorCheckItem): DoctorCheckItem {
  return {
    id: item.id,
    category: item.category,
    level: item.level,
    label: redactSecrets(item.label),
    ...(item.detail === undefined ? {} : { detail: redactSecrets(item.detail) }),
    ...(item.fixHint === undefined ? {} : { fixHint: redactSecrets(item.fixHint) }),
  };
}

export class DiagnosticsService {
  readonly #options: DiagnosticsServiceOptions;
  readonly #versionCache = new Map<string, CachedVersionEntry>();
  readonly #versionProbes = new Map<string, Promise<string | undefined>>();
  #doctorModulePromise: Promise<DoctorModule> | undefined;
  #doctorModulePath: string | undefined;
  #cachedPluginVersion: string | undefined;
  #inFlightDoctor: Promise<DoctorReport> | undefined;
  #activeAbort: AbortController | undefined;
  #disposed = false;

  constructor(options: DiagnosticsServiceOptions = {}) {
    this.#options = options;
    if (options.pluginVersion !== undefined) {
      this.#cachedPluginVersion = options.pluginVersion;
    }
  }

  #env(): Readonly<Record<string, string | undefined>> {
    return this.#options.env ?? process.env;
  }

  #cwd(): string {
    return this.#options.cwd ?? process.cwd();
  }

  #platform(): NodeJS.Platform {
    return this.#options.platform ?? process.platform;
  }

  #now(): number {
    return this.#options.now ? this.#options.now() : Date.now();
  }

  #bridgeFiles(): string[] | { keys?: string[]; error?: string } {
    return this.#options.bridgeFiles ?? Object.keys(BRIDGE_FILES);
  }

  async #loadDoctor(): Promise<DoctorModule> {
    if (this.#options.doctorModule !== undefined) {
      return this.#options.doctorModule;
    }
    if (this.#doctorModulePromise !== undefined) {
      return this.#doctorModulePromise;
    }
    const resolved = resolveDoctorModulePath({
      doctorModulePath: this.#options.doctorModulePath,
      pluginDir: this.#options.pluginDir,
      env: this.#env(),
      cwd: this.#cwd(),
    });
    if (resolved === undefined) {
      throw new Error(
        "could not locate lib/doctor.mjs; reinstall the dsh-paseo plugin from a complete package or checkout",
      );
    }
    this.#doctorModulePath = resolved;
    const loading = nativeDynamicImport(pathToFileURL(resolved).href).then((mod) => {
      const candidate = mod as Partial<DoctorModule>;
      if (
        typeof candidate.inspectInstallFiles !== "function" ||
        typeof candidate.runDoctorChecksAsync !== "function"
      ) {
        throw new Error(`lib/doctor.mjs at ${resolved} does not export inspectInstallFiles/runDoctorChecksAsync`);
      }
      return candidate as DoctorModule;
    });
    this.#doctorModulePromise = loading.catch((error) => {
      this.#doctorModulePromise = undefined;
      throw error;
    });
    return this.#doctorModulePromise;
  }

  #pluginVersion(): string | undefined {
    if (this.#cachedPluginVersion !== undefined) return this.#cachedPluginVersion;
    const version = readPluginVersionNear(this.#doctorModulePath);
    if (version !== undefined) this.#cachedPluginVersion = version;
    return version;
  }

  #versionCacheKey(
    configuredBinary: string,
    resolvedPath: string | undefined,
    launch: { command: string; args: string[] },
    cwd: string,
  ): { key: string; entryPath?: string } {
    const realBinary = resolvedPath === undefined ? configuredBinary : realpathOrRaw(resolvedPath);
    const binaryStamp = resolvedPath === undefined ? "absent" : fileStamp(realBinary);
    const firstArg = launch.args[0];
    const entryPath =
      firstArg !== undefined && firstArg !== "" && !firstArg.startsWith("-")
        ? realpathOrRaw(resolve(cwd, firstArg))
        : undefined;
    const entryStamp = entryPath === undefined ? "none" : fileStamp(entryPath);
    const key = JSON.stringify([realBinary, launch.args, binaryStamp, entryStamp]);
    return { key, entryPath };
  }

  #seedVersionCache(
    configuredBinary: string,
    resolvedPath: string | undefined,
    launch: { command: string; args: string[] },
    cwd: string,
    version: string | undefined,
  ): void {
    if (version === undefined || version.trim() === "") return;
    const { key } = this.#versionCacheKey(configuredBinary, resolvedPath, launch, cwd);
    this.#versionCache.set(key, { version: version.trim(), cachedAt: this.#now() });
  }

  async #resolveCachedDshVersion(
    doctor: DoctorModule,
    configuredBinary: string,
    env: Readonly<Record<string, string | undefined>>,
    cwd: string,
    platform: NodeJS.Platform,
    refreshVersion: boolean,
  ): Promise<DiagnosticsOverview["dsh"]> {
    const launch = resolveDshCommand(configuredBinary, env, cwd);
    const execCheck = resolveExecutable(configuredBinary, env, cwd, platform);
    const resolvedPath = execCheck.resolvedPath ?? (launch.args.length > 0 ? resolve(cwd, launch.args[0]) : undefined);

    const buildResult = (
      version: string | undefined,
      cached: boolean,
      error?: string,
    ): DiagnosticsOverview["dsh"] => {
      let versionOk: boolean | undefined;
      if (version !== undefined) {
        const got = doctor.parseVersion(version);
        const min = doctor.parseVersion(doctor.MINIMUM_DSH);
        if (got !== undefined && min !== undefined) {
          versionOk = doctor.compareCore(got, min) >= 0;
        }
      }
      return {
        configuredBinary,
        ...(resolvedPath === undefined ? {} : { resolvedPath }),
        ...(version === undefined ? {} : { version }),
        minimumVersion: doctor.MINIMUM_DSH,
        ...(versionOk === undefined ? {} : { versionOk }),
        cached,
        ...(error === undefined ? {} : { error: redactSecrets(error) }),
      };
    };

    if (execCheck.error !== undefined) {
      return buildResult(undefined, false, execCheck.error);
    }

    const { key, entryPath } = this.#versionCacheKey(configuredBinary, resolvedPath, launch, cwd);
    const ttlMs = this.#options.versionCacheTtlMs ?? DEFAULT_VERSION_CACHE_TTL_MS;
    if (!refreshVersion) {
      const hit = this.#versionCache.get(key);
      if (hit !== undefined && this.#now() - hit.cachedAt < ttlMs) {
        return buildResult(hit.version, true);
      }
    }

    // Fast path (0 subprocesses): read version directly from `@deepseek-ai/dsh/package.json`.
    const pkgAnchor = entryPath ?? resolvedPath;
    if (pkgAnchor !== undefined) {
      const fromPkg = readDshPackageVersion(pkgAnchor);
      if (fromPkg !== undefined) {
        this.#versionCache.set(key, { version: fromPkg, cachedAt: this.#now() });
        return buildResult(fromPkg, false);
      }
    }

    // Fallback for custom wrappers/shims: bounded, deduplicated `--version` probe cached in memory.
    if (this.#options.probeVersionOnCacheMiss === false) {
      return buildResult(undefined, false, resolvedPath === undefined ? "dsh not found on PATH" : undefined);
    }
    if (resolvedPath === undefined && this.#options.runner?.exec === undefined) {
      return buildResult(undefined, false, "dsh not found on PATH");
    }

    let inFlight = this.#versionProbes.get(key);
    if (inFlight === undefined) {
      const execFn = this.#options.runner?.exec;
      inFlight = (
        execFn !== undefined
          ? Promise.resolve(
              execFn(launch.command, [...launch.args, "--version"], {
                env,
                cwd,
                timeoutMs: VERSION_PROBE_TIMEOUT_MS,
              }),
            )
          : probeVersionAsync(launch.command, [...launch.args, "--version"], env, cwd, VERSION_PROBE_TIMEOUT_MS)
      )
        .then((raw) => {
          const clean = raw
            ?.trim()
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.trim();
          if (clean !== undefined && clean !== "") {
            this.#versionCache.set(key, { version: clean, cachedAt: this.#now() });
            return clean;
          }
          return undefined;
        })
        .catch(() => undefined)
        .finally(() => {
          if (this.#versionProbes.get(key) === inFlight) {
            this.#versionProbes.delete(key);
          }
        });
      this.#versionProbes.set(key, inFlight);
    }

    const version = await inFlight;
    return buildResult(
      version,
      false,
      version === undefined && resolvedPath === undefined ? "dsh not found on PATH" : undefined,
    );
  }

  /**
   * Fast read-only environment overview (`dsh.diagnostics.overview`).
   * Never spawns `dsh --dump-config` or `paseo plugin ls`, and never returns
   * raw `.credentials.yaml` contents, key values, or secret snippets.
   */
  async overview(input: DiagnosticsOverviewInput = {}): Promise<DiagnosticsOverview> {
    const doctor = await this.#loadDoctor();
    const env = this.#env();
    const cwd = this.#cwd();
    const platform = this.#platform();
    const binary = this.#options.binary ?? env["DSH_BINARY"] ?? "dsh";

    const files = doctor.inspectInstallFiles({
      env,
      cwd,
      platform,
      ...(this.#options.dshHome === undefined ? {} : { dshHome: this.#options.dshHome }),
      ...(this.#options.profile === undefined ? {} : { profile: this.#options.profile }),
      binary,
      bridgeFiles: this.#bridgeFiles(),
      ...(this.#options.yamlParser === undefined ? {} : { yamlParser: this.#options.yamlParser }),
    });

    const dsh = await this.#resolveCachedDshVersion(
      doctor,
      binary,
      env,
      cwd,
      platform,
      input.refreshVersion === true,
    );

    const profileIssue = files.profileBundle.ok ? undefined : files.profileBundle.label;
    const bridgeIssue =
      files.bridge.status === "provisioned"
        ? undefined
        : files.bridge.status === "shadowed"
          ? `legacy bridge copy at ${shortPath(files.bridge.localDir)} shadows ${shortPath(files.bridge.sharedDir)}`
          : files.bridge.status === "unverified"
            ? (files.bridge.fileListError ?? "bridge contents not verified")
            : files.bridge.status === "missing"
              ? "bridge bundle missing"
              : `${files.bridge.missingFiles.length} of ${files.bridge.expectedFiles} bridge files missing`;

    const routeIssue = files.patch.status === "configured" ? undefined : files.patch.label;
    const contractIssues = files.credentials.contractProblems.map((problem) => redactSecrets(problem.label));

    const hasIssues =
      dsh.error !== undefined ||
      dsh.versionOk === false ||
      !files.profileExists ||
      !files.profileBundle.ok ||
      files.bridge.status === "incomplete" ||
      files.bridge.status === "missing" ||
      files.bridge.status === "unverified" ||
      files.patch.status !== "configured" ||
      (files.credentials.status !== "ready" && files.credentials.status !== "no-refs-needed");

    const pluginVersion = this.#pluginVersion();

    return {
      collectedAt: this.#now(),
      ...(pluginVersion === undefined ? {} : { pluginVersion }),
      dsh,
      profile: {
        name: files.profile,
        fromEnv: files.profileFromEnv,
        dshHome: files.dshHome,
        displayDshHome: shortPath(files.dshHome),
        dir: files.profileDir,
        displayDir: shortPath(files.profileDir),
        exists: files.profileExists,
        manifestValid: files.profileBundle.ok,
        loadsBridgeBundle: files.profileBundle.ok,
        bundles: files.profileBundle.bundles,
        ...(profileIssue === undefined ? {} : { issue: redactSecrets(profileIssue) }),
      },
      bridge: {
        status: files.bridge.status,
        location: files.bridge.location,
        activeDir: files.bridge.activeDir,
        displayActiveDir: shortPath(files.bridge.activeDir),
        shadowed: files.bridge.shadowed,
        localDir: files.bridge.localDir,
        sharedDir: files.bridge.sharedDir,
        expectedFiles: files.bridge.expectedFiles,
        presentFiles: files.bridge.presentFiles,
        missingFiles: files.bridge.missingFiles.slice(0, 10),
        ...(bridgeIssue === undefined ? {} : { issue: redactSecrets(bridgeIssue) }),
      },
      route: {
        status: files.patch.status,
        patchPath: files.patch.path,
        displayPatchPath: shortPath(files.patch.path),
        ...(files.patch.defaultProvider === undefined ? {} : { provider: files.patch.defaultProvider }),
        ...(files.patch.defaultModel === undefined ? {} : { model: files.patch.defaultModel }),
        ...(files.patch.defaultReasoningEffort === undefined
          ? {}
          : { reasoningEffort: files.patch.defaultReasoningEffort }),
        ...(routeIssue === undefined ? {} : { issue: redactSecrets(routeIssue) }),
      },
      providers: files.providers,
      credentials: {
        status: files.credentials.status,
        path: files.credentials.path,
        displayPath: shortPath(files.credentials.path),
        exists: files.credentials.exists,
        readable: files.credentials.readable,
        ...(files.credentials.modeOctal === undefined ? {} : { mode: files.credentials.modeOctal }),
        ...(files.credentials.ownerOnly === undefined ? {} : { ownerOnly: files.credentials.ownerOnly }),
        ...(files.credentials.formatValid === undefined ? {} : { formatValid: files.credentials.formatValid }),
        legacyFlatLayout: files.credentials.legacy,
        contractIssues,
        referencedRefs: files.credentials.referencedRefs,
        missingRefs: files.credentials.missingRefs,
        ...(files.credentials.fixHint === undefined ? {} : { fixHint: redactSecrets(files.credentials.fixHint) }),
      },
      hasIssues,
    };
  }

  /**
   * On-demand full doctor execution (`dsh.diagnostics.run-doctor`).
   *
   * Single-flight mutex: concurrent calls share one in-flight run (the caller
   * that started it gets `sharedInFlight: false`; joined callers get
   * `sharedInFlight: true`). Bounded by a 20s timeout (default).
   */
  async runDoctor(input: RunDoctorInput = {}): Promise<DoctorReport> {
    if (this.#inFlightDoctor !== undefined) {
      const shared = await this.#inFlightDoctor;
      return { ...shared, sharedInFlight: true };
    }

    const effectiveTimeoutMs =
      input.timeoutMs !== undefined
        ? Math.min(MAX_RPC_TIMEOUT_MS, Math.max(MIN_RPC_TIMEOUT_MS, Math.trunc(input.timeoutMs)))
        : (this.#options.doctorTimeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS);

    const task = this.#executeDoctor(effectiveTimeoutMs);
    this.#inFlightDoctor = task;
    try {
      const result = await task;
      return { ...result, sharedInFlight: false };
    } finally {
      if (this.#inFlightDoctor === task) {
        this.#inFlightDoctor = undefined;
      }
    }
  }

  async #executeDoctor(timeoutMs: number): Promise<DoctorReport> {
    const startedAt = this.#now();
    const env = this.#env();
    const cwd = this.#cwd();
    const platform = this.#platform();
    const profile = this.#options.profile ?? env["DSH_PASEO_PROFILE"] ?? "paseo";
    const binary = this.#options.binary ?? env["DSH_BINARY"] ?? "dsh";

    let doctor: DoctorModule;
    try {
      doctor = await this.#loadDoctor();
    } catch (error) {
      const dshHome = this.#options.dshHome ?? join(homedir(), ".dsh");
      const profileDir = join(dshHome, "profiles", profile);
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        ranAt: startedAt,
        durationMs: Math.max(0, this.#now() - startedAt),
        timedOut: false,
        sharedInFlight: false,
        ...(this.#pluginVersion() === undefined ? {} : { pluginVersion: this.#pluginVersion() }),
        profile,
        profileDir,
        displayProfileDir: shortPath(profileDir),
        checks: [
          {
            id: "doctor-loader",
            category: "plugin",
            level: "fail",
            label: "Could not load doctor module",
            detail: message,
            fixHint: "Reinstall the dsh-paseo plugin from a complete package or checkout and restart the Paseo daemon.",
          },
        ],
        summary: { ok: 0, warn: 0, fail: 1, total: 1, blocking: true },
        error: message,
      };
    }

    const dshHome = this.#options.dshHome ?? doctor.resolveDshHome(env, cwd);
    const profileDir = join(dshHome, "profiles", profile);
    const pluginVersion = this.#pluginVersion();
    const controller = new AbortController();
    this.#activeAbort = controller;

    let timedOutByOuterGuard = false;
    let outerTimer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<null>((resolveTimeout) => {
      outerTimer = setTimeout(() => {
        timedOutByOuterGuard = true;
        controller.abort();
        resolveTimeout(null);
      }, timeoutMs);
      outerTimer.unref?.();
    });

    const runPromise: Promise<RawDoctorReport> = doctor.runDoctorChecksAsync({
      env,
      cwd,
      platform,
      dshHome,
      profile,
      binary,
      ...(pluginVersion === undefined ? {} : { pluginVersion }),
      bridgeFiles: this.#bridgeFiles(),
      ...(this.#options.yamlParser === undefined ? {} : { yamlParser: this.#options.yamlParser }),
      ...(this.#options.runner === undefined ? {} : { runner: this.#options.runner }),
      ...(this.#options.checkBundledPaseo === undefined ? {} : { checkBundledPaseo: this.#options.checkBundledPaseo }),
      timeoutMs,
      dumpTimeoutMs: timeoutMs,
      signal: controller.signal,
    });
    // Prevent unhandled rejection if outer timeout wins the race and runPromise rejects later.
    runPromise.catch(() => undefined);

    try {
      const winner = await Promise.race([runPromise, timeoutPromise]);
      const durationMs = Math.max(0, this.#now() - startedAt);
      const timeoutSec = Math.max(1, Math.round(timeoutMs / 1000));

      if (winner === null || timedOutByOuterGuard) {
        const timeoutLabel = `Doctor check timed out after ${timeoutSec}s`;
        const timeoutDetail = `The diagnostic run exceeded its ${timeoutSec}s limit (commonly caused by a slow or stuck \`dsh --profile ${profile} --dump-config\`).`;
        const timeoutHint = `Run "dsh --profile ${profile} --dump-config" in a terminal to see why DSH hung or took longer than ${timeoutSec}s, then retry.`;
        return {
          ok: false,
          ranAt: startedAt,
          durationMs,
          timedOut: true,
          sharedInFlight: false,
          ...(pluginVersion === undefined ? {} : { pluginVersion }),
          profile,
          profileDir,
          displayProfileDir: shortPath(profileDir),
          checks: [
            {
              id: "doctor-timeout",
              category: "composition",
              level: "fail",
              label: timeoutLabel,
              detail: timeoutDetail,
              fixHint: timeoutHint,
            },
          ],
          summary: { ok: 0, warn: 0, fail: 1, total: 1, blocking: true },
          error: timeoutLabel,
        };
      }

      const checks = winner.checks.map(sanitizeCheckItem);
      const summary = {
        ok: winner.summary.ok,
        warn: winner.summary.warn,
        fail: winner.summary.fail,
        total: winner.summary.total,
        blocking: winner.summary.blocking,
      };

      // Warm the lightweight overview version cache from the real doctor probe.
      if (winner.dshVersion !== undefined) {
        const launch = resolveDshCommand(binary, env, cwd);
        const execCheck = resolveExecutable(binary, env, cwd, platform);
        const resolvedPath =
          execCheck.resolvedPath ?? (launch.args.length > 0 ? resolve(cwd, launch.args[0]) : undefined);
        this.#seedVersionCache(binary, resolvedPath, launch, cwd, winner.dshVersion);
      }

      const timedOut = winner.timedOut === true;
      const error =
        winner.fatalError !== undefined
          ? redactSecrets(winner.fatalError)
          : timedOut
            ? `Doctor check timed out after ${timeoutSec}s`
            : undefined;

      return {
        ok: !summary.blocking && !timedOut && error === undefined,
        ranAt: startedAt,
        durationMs,
        timedOut,
        sharedInFlight: false,
        ...(winner.pluginVersion === undefined ? {} : { pluginVersion: winner.pluginVersion }),
        profile: winner.profile,
        profileDir: winner.profileDir,
        displayProfileDir: shortPath(winner.profileDir),
        ...(winner.dshVersion === undefined ? {} : { dshVersion: winner.dshVersion }),
        ...(winner.paseoVersion === undefined ? {} : { paseoVersion: winner.paseoVersion }),
        checks,
        summary,
        ...(error === undefined ? {} : { error }),
      };
    } catch (error) {
      const durationMs = Math.max(0, this.#now() - startedAt);
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        ranAt: startedAt,
        durationMs,
        timedOut: false,
        sharedInFlight: false,
        ...(pluginVersion === undefined ? {} : { pluginVersion }),
        profile,
        profileDir,
        displayProfileDir: shortPath(profileDir),
        checks: [
          {
            id: "doctor-error",
            category: "plugin",
            level: "fail",
            label: "Doctor execution failed",
            detail: message,
            fixHint: `Run "node <plugin-dir>/bin/paseo-dsh.mjs doctor" in a terminal to inspect the full diagnostic output.`,
          },
        ],
        summary: { ok: 0, warn: 0, fail: 1, total: 1, blocking: true },
        error: message,
      };
    } finally {
      if (outerTimer !== undefined) clearTimeout(outerTimer);
      if (this.#activeAbort === controller) {
        this.#activeAbort = undefined;
      }
      if (this.#disposed) {
        controller.abort();
      }
    }
  }

  clearVersionCache(): void {
    this.#versionCache.clear();
  }

  dispose(): void {
    this.#disposed = true;
    this.#activeAbort?.abort();
    this.#activeAbort = undefined;
    this.#versionCache.clear();
    this.#versionProbes.clear();
  }
}

/**
 * Register `dsh.diagnostics.overview` and `dsh.diagnostics.run-doctor` RPC
 * handlers on a Paseo plugin server context.
 */
export function registerDiagnosticsRpc(
  server: PluginServerContext,
  service: DiagnosticsService = new DiagnosticsService(),
  options?: { onCall?: (context: PluginHandlerContext) => void },
): () => void {
  server.handle(diagnosticsOverviewRpc, async (input, context) => {
    options?.onCall?.(context);
    return await service.overview(input);
  });
  server.handle(diagnosticsRunDoctorRpc, async (input, context) => {
    options?.onCall?.(context);
    return await service.runDoctor(input);
  });
  return () => service.dispose();
}
