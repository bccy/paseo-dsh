/**
 * Bundle management for the DSH profile the Paseo provider drives.
 *
 * The heavy lifting (compatibility preflight, pnpm, rollback, bundle
 * activation) belongs to `dsh plugin`; this module only reads the profile,
 * exposes the bundle inventory, and shells out to that command. The one direct
 * write is enabling/disabling an already-installed bundle, which is a
 * `dsh.profile.bundles` edit under the same lock protocol DSH itself uses. That
 * keeps this page from inventing a second package manager.
 *
 * The protocol was read from the DSH this plugin ships against, not assumed:
 *
 * - `dsh plugin --profile <name> <pnpm args>` (DSH 0.2.2-rc.3) forwards to
 *   `runPluginCommand` in `@deepseek-ai/dsh-plugin-manager`: it takes
 *   `withFileLock(<profile>/package.json, { waitMs: 120_000 })` around the
 *   operation, reconciles the manifest, and appends a newly installed bundle to
 *   `dsh.profile.bundles` (`activateNewBundles` defaults to true). A package
 *   without a `dsh.bundle` manifest stays a plain dependency and is warned
 *   about on stderr.
 * - The lock is `@deepseek-ai/dsh-atomic-write`'s `<file>.lock` sibling: created
 *   with `wx`, content `` `${pid}\n` ``, ABANDONED only when a signal probe says
 *   that pid is gone. A dead-holder lock is what an **abnormally terminated**
 *   holder leaves behind (SIGKILL, exit 137); a normal `dsh plugin` run always
 *   releases it in `finally` — verified on 0.2.2-rc.3 over six fresh homes
 *   (`/tmp/paseo-dsh-orch/verify-D.md` V4), where a plain `view` left no lock.
 *   DSH itself releases unconditionally in `finally`; this module is stricter
 *   on purpose (see `withPackageLock`).
 * - `dsh plugin view <spec> --json` and `dsh plugin view <name> version --json`
 *   pass through to pnpm's `view`, which answers a registry document and a JSON
 *   string respectively; both are parsed leniently (pnpm may print progress
 *   lines around the JSON).
 * - **A bundle's files are not in one place.** DSH resolves a selected bundle
 *   from the **dsh installation first**, then from `<profile>/package.json`
 *   whose Node lookup covers the profile's own `node_modules`, the shared
 *   `$DSH_HOME/profiles/node_modules` anchor, and any ancestor node_modules
 *   (`@deepseek-ai/dsh-app-boot/src/profile.ts:629-637` `packageDirFromAnchor`
 *   and `:651-662` `resolveBundleDir`; the installation-first order is the
 *   stated contract, so an in-box bundle always comes from the running
 *   installation). The page therefore resolves with the same two anchors and
 *   marks anything found under the installation as official: it shows that
 *   copy's version and is neither removable nor updatable, because it follows
 *   the DSH upgrade rather than the profile.
 *
 * @module dsh-paseo/server/dsh-plugins
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type {
  BundleInfo,
  BundleRow,
  FailureCode,
  JobKind,
  JobState,
  InspectSpecOutput,
  JobStatus,
  PluginsSnapshot,
  SetEnabledOutput,
  StartJobInput,
  StartJobOutput,
  UpdateOutcome,
  UpdateTarget,
} from "../shared/dsh-plugins-api";
import { dshHome, profileDir, profileName } from "./bootstrap";
import { resolveDshCommand } from "./dsh-command.mjs";
import { resolveDshBinary } from "./dsh-process";

const BASE_BUNDLE = "@deepseek-ai/dsh-base";
const BRIDGE_BUNDLE = "dsh-paseo-bridge";
const PROTECTED_BUNDLES = new Set([BASE_BUNDLE, BRIDGE_BUNDLE]);

const OUTPUT_LIMIT = 16 * 1024;
const CAPTURE_LIMIT = 2 * 1024 * 1024;
const VIEW_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
/**
 * DSH's own `dsh plugin` path waits 120 s for the profile writer lock
 * (`@deepseek-ai/dsh-plugin-manager` passes `waitMs: 12e4`). Matching it means
 * one page action can queue behind a DSH-side install instead of failing a
 * fraction of a second before that install finishes.
 */
export const LOCK_WAIT_MS = 120_000;
const MAX_RETAINED_JOBS = 20;

interface ProfileManifest {
  dependencies?: Record<string, string>;
  dsh?: {
    profile?: { bundles?: string[] };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RunResult {
  code: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  output: string;
}

interface Job {
  id: string;
  kind: JobKind;
  state: JobState;
  output: string;
  errorCode?: FailureCode;
  errorDetail?: string;
  updates?: Record<string, string>;
  /** Per-target outcomes, set by the batch update path. */
  updateResults?: UpdateOutcome[];
  startedAt: number;
  finishedAt?: number;
  child?: ChildProcess;
}

export class ManagerError extends Error {
  readonly code: FailureCode;
  readonly detail?: string;

  constructor(code: FailureCode, detail?: string) {
    super(code);
    this.name = "ManagerError";
    this.code = code;
    this.detail = detail;
  }
}

export function failureOf(error: unknown): { errorCode: FailureCode; errorDetail?: string } {
  if (error instanceof ManagerError) {
    return {
      errorCode: error.code,
      ...(error.detail === undefined ? {} : { errorDetail: error.detail }),
    };
  }
  const detail = errorMessage(error);
  return {
    errorCode: "command-failed",
    ...(detail === "" ? {} : { errorDetail: detail }),
  };
}

export interface DshPluginsOptions {
  profile?: string;
  dir?: string;
  dshHome?: string;
  /**
   * The running dsh installation's `package.json`, used as the **first** bundle
   * anchor (see {@link DshPlugins.resolveBundlePackage}).
   *
   * Omitted: derived from the `dsh` executable this page would spawn
   * ({@link resolveInstallAnchor}), cached once per plugin process.
   * `null`: installation resolution disabled, so only the profile anchor is
   * consulted. Tests pass `null` (or their own fixture path) so they never read
   * the real global installation.
   */
  installAnchor?: string | null;
  /**
   * @internal Test seam: spawn one `dsh` invocation (`cwd`/`env`/`detached` are
   * the launcher inputs). Defaults to {@link spawnDshCommand}.
   *
   * The batch-update regression uses it to script exit codes and count commands
   * without a real dsh, pnpm, registry, or network — and without a shell, which
   * is also what keeps it portable to Windows CI.
   */
  spawn?: (args: readonly string[], options: SpawnDshOptions) => ChildProcess;
}

/** The launch inputs {@link spawnDshCommand} hands to a spawner. */
export interface SpawnDshOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortDir(dir: string): string {
  const home = homedir();
  if (dir === home) return "~";
  if (dir.startsWith(`${home}/`)) return `~${dir.slice(home.length)}`;
  return dir;
}

function parseProfileManifest(path: string, text: string): ProfileManifest {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed as ProfileManifest;
  } catch {
    throw new ManagerError("profile-invalid", path);
  }
}

function readProfileManifest(dir: string): ProfileManifest {
  const path = join(dir, "package.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ManagerError("profile-unreadable", path);
  }
  return parseProfileManifest(path, text);
}

/**
 * The manifest when the profile has one, `undefined` when it does not exist yet.
 *
 * A profile this plugin has never provisioned has no `package.json`, and
 * `dsh plugin` initializes it on first use. Treating that state like an
 * unreadable file made the first install fail on a profile the page could have
 * created. A file that exists but cannot be read or parsed still fails loudly:
 * that one hides real damage.
 *
 * Exported for `paseo-plugin/test/dsh-plugins.test.cjs`, which suppresses
 * the "first install on a fresh profile" regression this rule exists for.
 *
 * @internal
 */
export function readProfileManifestIfPresent(dir: string): ProfileManifest | undefined {
  const path = join(dir, "package.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ManagerError("profile-unreadable", path);
  }
  return parseProfileManifest(path, text);
}

function writeProfileManifest(dir: string, manifest: ProfileManifest): void {
  const path = join(dir, "package.json");
  const temporary = join(dir, `.package.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function selectedBundles(manifest: ProfileManifest): string[] {
  const bundles = manifest.dsh?.profile?.bundles;
  return Array.isArray(bundles)
    ? bundles.filter((name): name is string => typeof name === "string")
    : [];
}

function dependencies(manifest: ProfileManifest): Record<string, string> {
  const value = manifest.dependencies;
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === "string") result[name] = spec;
  }
  return result;
}

/** Where a resolved bundle's files live, in DSH's own resolution order. */
export type PackageOrigin = "installation" | "profile";

export interface ResolvedBundlePackage {
  /** Absolute package directory (the one holding `package.json`). */
  dir: string;
  /** The package's own manifest. */
  manifest: Record<string, unknown>;
  /** Which anchor resolved it; `installation` is what the page calls official. */
  origin: PackageOrigin;
}

/**
 * Node's own `node_modules` lookup from one anchor file, exactly as DSH
 * resolves a bundle (`@deepseek-ai/dsh-app-boot` `src/profile.ts:629-637`):
 * probe `createRequire(anchor).resolve.paths(name)` for the first directory
 * that holds the named package's `package.json`. `existsSync` follows the
 * symlinks pnpm's isolated layout uses, which is why this matches what the
 * Loader imports from the same anchor.
 *
 * Reimplemented rather than imported: `dsh-app-boot` is not a dependency of
 * this plugin, and reaching into the daemon's install tree for an internal
 * function would be a new internal-service dependency that
 * `harness/dsh-api-contract-check.mjs` must pin. The *order* is the contract,
 * not the implementation.
 *
 * @param anchor - absolute file inside the tree to resolve from (a
 *   `package.json`), like DSH's own anchors.
 * @param name - the package name.
 * @returns the package directory, or `undefined` when no lookup path has it.
 */
function packageDirFromAnchor(anchor: string, name: string): string | undefined {
  let searchPaths: readonly string[] | null;
  try {
    searchPaths = createRequire(anchor).resolve.paths(name);
  } catch {
    return undefined;
  }
  for (const searchPath of searchPaths ?? []) {
    const candidate = join(searchPath, name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return undefined;
}

/**
 * Candidate absolute paths for the configured `dsh` command, in PATH order.
 *
 * Mirrors what `spawn` would execute: a path is used as given; a bare name is
 * looked up in `PATH` (with `PATHEXT` on Windows). Every candidate is only a
 * starting point for {@link installationAnchorFromEntry} — a candidate that is
 * not actually inside the dsh package simply does not yield an anchor.
 */
function executableCandidates(binary: string, env: NodeJS.ProcessEnv): string[] {
  if (binary.includes("/") || binary.includes("\\")) return [resolve(binary)];
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((value) => value !== "")
    : [""];
  const candidates: string[] = [];
  for (const directory of pathValue.split(delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${binary}${extension}`);
      if (existsSync(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * Walk up from a launcher entry point to the dsh package's own `package.json`.
 *
 * DSH's own launcher takes its installation anchor from
 * `new URL("../package.json", import.meta.url)` inside the running package
 * (`dsh/lib/profile-boot-*.js`), so the entry file sits one level below the
 * package root. npm's global install on POSIX makes the `dsh` on PATH a symlink
 * into that same tree (`.../node_modules/@deepseek-ai/dsh/lib/bin.js`), which is
 * why `realpathSync` is enough there; on Windows the launcher resolution in
 * `server/dsh-command.mjs` already hands over the in-package entry.
 *
 * @param entry - absolute path of the launcher file to start from.
 * @returns the package's manifest path, or `undefined` when no ancestor is dsh.
 */
function installationAnchorFromEntry(entry: string): string | undefined {
  let real: string;
  try {
    real = realpathSync(entry);
  } catch {
    return undefined;
  }
  let directory = dirname(real);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, "package.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (isRecord(parsed) && parsed.name === "@deepseek-ai/dsh") return candidate;
    } catch {
      // The entry lives in `bin/`/`lib/`: keep walking towards the package root.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * The running dsh installation's manifest, derived from the binary this page
 * would spawn. `undefined` when that binary is not recognisably inside a dsh
 * package (a hand-written wrapper, a renamed launcher): the page then degrades
 * to profile-only resolution instead of guessing at another installation tree.
 */
function resolveInstallAnchor(): string | undefined {
  let binary: string;
  try {
    binary = resolveDshBinary();
  } catch {
    return undefined;
  }
  const env = process.env;
  const launch = resolveDshCommand(binary, env, process.cwd());
  const candidates = launch.args.length > 0
    ? [resolve(launch.args[0] as string)]
    : executableCandidates(binary, env);
  for (const candidate of candidates) {
    const anchor = installationAnchorFromEntry(candidate);
    if (anchor !== undefined) return anchor;
  }
  return undefined;
}

/** Derivation is filesystem-only but not free; one answer per plugin process. */
let derivedInstallAnchor: { value: string | undefined } | undefined;

/** The cached {@link resolveInstallAnchor} result. */
function defaultInstallAnchor(): string | undefined {
  derivedInstallAnchor ??= { value: resolveInstallAnchor() };
  return derivedInstallAnchor.value;
}

function packageDsh(pkg: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(pkg.dsh) ? pkg.dsh : undefined;
}

function hasBundleManifest(pkg: Record<string, unknown>): boolean {
  const dsh = packageDsh(pkg);
  return isRecord(dsh?.bundle);
}

function hasClientUi(pkg: Record<string, unknown>): boolean {
  const dsh = packageDsh(pkg);
  return isRecord(dsh?.client);
}

const NODE_PLATFORMS = new Set([
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
]);

/** Whether this host may load the bundle's optional `dsh.bundle.platforms` list. */
function bundlePlatformSupport(
  pkg: Record<string, unknown>,
): { supported: true } | { supported: false; reason: string } {
  const bundle = packageDsh(pkg)?.bundle;
  if (!isRecord(bundle) || bundle.platforms === undefined) return { supported: true };
  const platforms = bundle.platforms;
  if (
    !Array.isArray(platforms)
    || platforms.length === 0
    || !platforms.every((value) => typeof value === "string" && NODE_PLATFORMS.has(value))
  ) {
    return { supported: false, reason: "" };
  }
  if (!platforms.includes(process.platform)) {
    return { supported: false, reason: platforms.join(", ") };
  }
  return { supported: true };
}

/** Best-effort row ids from a bundle's patch file; a parse failure yields []. */
function readRows(packageDir: string, pkg: Record<string, unknown>): BundleRow[] {
  const bundle = packageDsh(pkg)?.bundle;
  if (!isRecord(bundle)) return [];
  const patch = bundle.patch;
  const paths = typeof patch === "string"
    ? [patch]
    : Array.isArray(patch)
      ? patch.filter((entry): entry is string => typeof entry === "string")
      : [];
  const rows: BundleRow[] = [];
  const seen = new Set<string>();
  for (const relativePath of paths) {
    try {
      const text = readFileSync(join(packageDir, relativePath), "utf8");
      const pattern = /^\s*-\s+id:\s*["']?([A-Za-z0-9._:@/-]+)["']?\s*$/gm;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const id = match[1];
        if (!seen.has(id)) {
          seen.add(id);
          rows.push({ id });
        }
      }
    } catch {
      // The patch may be generated or absent; rows are display-only here.
    }
  }
  return rows;
}

function isRegistrySpec(spec: string): boolean {
  const value = spec.trim();
  if (value === "" || value.length > 214) return false;
  if (value.startsWith(".") || value.startsWith("/") || value.startsWith("~")) return false;
  if (value.includes("\\") || value.includes(":") || value.includes("..")) return false;
  if (/\s/.test(value)) return false;
  return /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[a-z0-9^~<>=.*+|-]+)?$/i.test(value);
}

/**
 * Dependency specs are version ranges, not package names. Keep this separate
 * from `isRegistrySpec`, which validates the spec typed into the install box.
 */
function isRegistryDependencySpec(spec: string): boolean {
  const value = spec.trim();
  if (value === "" || value.length > 214) return false;
  if (/^(?:file|link|git|github|https?|ssh|workspace|portal|npm):/i.test(value)) return false;
  if (value.includes("\\") || value.includes("/") || value.includes("..")) return false;
  if (/\s/.test(value)) return false;
  if (value === "latest" || value === "next" || value === "*") return true;
  return /^[\^~<>=v]?\d/.test(value);
}

function registryName(spec: string): string {
  const value = spec.trim();
  const at = value.lastIndexOf("@");
  return at > 0 ? value.slice(0, at) : value;
}

function versionParts(version: string): { numbers: number[]; prerelease?: string } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4],
  };
}

function isNewer(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const previous = versionParts(current);
  if (!next || !previous) return candidate !== current;
  for (let index = 0; index < 3; index += 1) {
    if (next.numbers[index] !== previous.numbers[index]) {
      return next.numbers[index] > previous.numbers[index];
    }
  }
  if (next.prerelease === previous.prerelease) return false;
  if (next.prerelease === undefined) return true;
  if (previous.prerelease === undefined) return false;
  return next.prerelease > previous.prerelease;
}

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("empty JSON");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const startObject = trimmed.indexOf("{");
    const startArray = trimmed.indexOf("[");
    const start = startObject < 0
      ? startArray
      : startArray < 0
        ? startObject
        : Math.min(startObject, startArray);
    if (start < 0) throw new Error("no JSON value");
    const endObject = trimmed.lastIndexOf("}");
    const endArray = trimmed.lastIndexOf("]");
    const end = Math.max(endObject, endArray);
    if (end <= start) throw new Error("no complete JSON value");
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-count).join("\n").trim();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hold the profile's writer lock around one read-modify-write.
 *
 * The lock is DSH's own (`<profile>/package.json.lock`, a `wx`-created sibling
 * recording `<pid>\n`), so this page serializes with DSH's plugin manager
 * instead of inventing a second protocol. Two deliberate differences from
 * `@deepseek-ai/dsh-atomic-write`'s helper, both about ownership:
 *
 * 1. A dead holder's lock is reclaimed directly (DSH does the same through a
 *    claim file; this module has one writer, the page, so the extra file buys
 *    nothing here). Such a lock only appears when the holder was **killed**
 *    mid-operation (e.g. SIGKILL); a normal `dsh plugin` run releases it in
 *    `finally`, so the normal path never leaves one. A lock whose holder is
 *    alive or unreadable is waited for.
 * 2. Release checks the recorded pid first. DSH's own `finally` unlinks
 *    unconditionally, which is safe only because its holders never outlive the
 *    lock. This module's holder can be killed mid-write while a successor —
 *    DSH itself — has already reclaimed the lock; an unconditional unlink would
 *    then delete the new owner's lock and let two writers into the manifest.
 *
 * Exported for `paseo-plugin/test/dsh-plugins.test.cjs`, which asserts both the
 * timeout and the "only release what you still hold" rule; `waitMs` exists for
 * that test.
 *
 * @internal
 */
export async function withPackageLock<T>(
  dir: string,
  action: () => Promise<T> | T,
  waitMs: number = LOCK_WAIT_MS,
): Promise<T> {
  const lockPath = join(dir, "package.json.lock");
  const deadline = Date.now() + waitMs;
  let acquired = false;
  while (!acquired) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLockPid(lockPath);
      if (holder !== undefined && holder !== process.pid && !isProcessAlive(holder)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ManagerError("lock-timeout", `package.json.lock (${Math.round(waitMs / 1000)}s)`);
      }
      await sleep(100);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  try {
    return await action();
  } finally {
    // Release only a lock this process still holds. DSH takes a dead holder's
    // lock over, so an unconditional unlink could delete the lock its new
    // owner had just created and let two writers into the manifest.
    const holder = readLockPid(lockPath);
    if (holder === undefined || holder === process.pid) rmSync(lockPath, { force: true });
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const pid = child.pid;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        // The process may already be gone.
      }
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 3_000);
  timer.unref();
}

/** The command name for a spawn diagnostic; never throws. */
function dshCommandLabel(): string {
  try {
    return resolveDshBinary();
  } catch {
    return "dsh";
  }
}

/**
 * Spawn one `dsh` invocation for the page.
 *
 * **The one place this module starts a process.** It uses the same launcher
 * resolution as `dsh-process.ts`: on Windows an npm-installed `dsh` is a
 * `.cmd` shim that `spawn` cannot execute, so `resolveDshCommand` (from
 * `server/dsh-command.mjs`) rewrites it to `node.exe <package>/<bin entry>`;
 * POSIX and native executables pass through unchanged, so the spawn is exactly
 * the previous one there. Keeping this shared with the plugin's own launch path
 * means the page and the provider cannot drift apart on Windows.
 *
 * @param args - arguments after the binary, e.g. `["plugin", "--profile", "paseo", "view", …]`.
 * @param options - cwd, environment, and whether to lead a process group.
 * @returns the running child.
 */
function spawnDshCommand(
  args: readonly string[],
  options: SpawnDshOptions,
): ChildProcess {
  const launch = resolveDshCommand(resolveDshBinary(), options.env, options.cwd);
  return spawn(launch.command, [...launch.args, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: options.detached,
  });
}

export class DshPlugins {
  readonly profile: string;
  readonly dir: string;
  readonly dshHome: string;
  /**
   * The installation anchor this instance resolves official bundles from;
   * `undefined` when installation resolution is disabled or the launcher is not
   * recognisably inside a dsh package.
   */
  readonly installAnchor: string | undefined;

  /** One spawn point; overridable only by the test seam in the options. */
  readonly #spawnDsh: (args: readonly string[], options: SpawnDshOptions) => ChildProcess;

  #jobs = new Map<string, Job>();
  #activeJobId: string | undefined;
  #updates = new Map<string, string>();
  #dshVersionPromise: Promise<string | undefined> | undefined;
  #children = new Set<ChildProcess>();
  #disposed = false;

  constructor(options: DshPluginsOptions = {}) {
    this.profile = options.profile ?? profileName();
    this.dshHome = options.dshHome ?? dshHome();
    this.dir = options.dir ?? profileDir(this.profile, this.dshHome);
    this.installAnchor = options.installAnchor === null
      ? undefined
      : options.installAnchor ?? defaultInstallAnchor();
    this.#spawnDsh = options.spawn ?? spawnDshCommand;
  }

  /**
   * Resolve one package the way DSH resolves a profile bundle.
   *
   * Order is DSH's own (`@deepseek-ai/dsh-app-boot/src/profile.ts:651-662`,
   * `resolveBundleDir`): the **installation anchor first**, then
   * `<profile>/package.json`. The installation-first rule is a stated DSH
   * contract — an in-box bundle always comes from the same installation as the
   * running dsh, never from a profile-local copy — so a package the installation
   * also ships is reported from there even when the profile depends on it.
   *
   * The profile anchor covers three layouts at once because it is Node's normal
   * lookup: `<profile>/node_modules` (pnpm dependencies), the shared
   * `$DSH_HOME/profiles/node_modules` anchor the bridge lives in, and any
   * ancestor `node_modules`. A package none of them holds is the only one that
   * may be reported missing.
   *
   * A candidate whose `package.json` exists but cannot be parsed is skipped and
   * the next anchor is tried: a damaged package copy is an inventory state, and
   * the whole list must not fail over it. Only when every anchor misses does the
   * row read missing, so a broken copy does not turn into "not installed".
   *
   * Public beyond this module on purpose: the regression tests and the read-only
   * real-profile evidence call it per row to show which anchor answered. Within
   * the page it serves `list()`/`setEnabled()` and the package jobs.
   *
   * @param name - package name, as it appears in `dsh.profile.bundles`.
   * @returns the resolved package and its origin, or `undefined` when absent.
   */
  resolveBundlePackage(name: string): ResolvedBundlePackage | undefined {
    const anchors: Array<readonly [PackageOrigin, string | undefined]> = [
      ["installation", this.installAnchor],
      ["profile", join(this.dir, "package.json")],
    ];
    for (const [origin, anchor] of anchors) {
      if (anchor === undefined) continue;
      const dir = packageDirFromAnchor(anchor, name);
      if (dir === undefined) continue;
      let manifest: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        manifest = isRecord(parsed) ? parsed : undefined;
      } catch {
        continue;
      }
      if (manifest !== undefined) return { dir, manifest, origin };
    }
    return undefined;
  }

  /** Read the profile inventory. Never starts a package operation. */
  async list(): Promise<PluginsSnapshot> {
    try {
      return await this.#snapshot();
    } catch (error) {
      const failure = failureOf(error);
      return {
        profile: this.profile,
        dir: this.dir,
        displayDir: shortDir(this.dir),
        bundles: [],
        busy: false,
        ...failure,
      };
    }
  }

  async #snapshot(): Promise<PluginsSnapshot> {
    const manifest = readProfileManifest(this.dir);
    const deps = dependencies(manifest);
    const selected = selectedBundles(manifest);
    const names: string[] = [];
    const add = (name: string) => {
      if (!names.includes(name)) names.push(name);
    };
    add(BASE_BUNDLE);
    add(BRIDGE_BUNDLE);
    selected.forEach(add);
    Object.keys(deps).forEach(add);

    // `dsh --version` is only the base row's fallback: when the installation's
    // base package resolves, its own manifest is authoritative and the page
    // needs no child process for a plain list (the page refreshes often).
    const dshVersion = this.resolveBundlePackage(BASE_BUNDLE) === undefined
      ? await this.#getDshVersion()
      : undefined;
    const bundles = names.map((name) => this.#describe(name, deps[name], selected, dshVersion));
    const activeJob = this.#activeJobId === undefined ? undefined : this.#jobs.get(this.#activeJobId);
    return {
      profile: this.profile,
      dir: this.dir,
      displayDir: shortDir(this.dir),
      bundles,
      busy: activeJob !== undefined,
      ...(activeJob === undefined ? {} : {
        activeJobId: activeJob.id,
        activeJobKind: activeJob.kind,
      }),
    };
  }

  /**
   * Enable or disable an installed bundle by editing only the ordered
   * `dsh.profile.bundles` list. Dependencies stay installed, so disabling is
   * reversible without a download.
   */
  async setEnabled(name: string, enabled: boolean): Promise<SetEnabledOutput> {
    const bundleName = name.trim();
    if (bundleName === "") throw new ManagerError("invalid-name");
    if (PROTECTED_BUNDLES.has(bundleName)) {
      throw new ManagerError("protected", bundleName);
    }

    return withPackageLock(this.dir, () => {
      const manifest = readProfileManifest(this.dir);
      const current = selectedBundles(manifest);
      if (enabled) {
        // Enabling used to require a profile dependency; that rejected an
        // installation-supplied bundle (deselect then reselect) even though DSH
        // loads it. Resolve the same way DSH does instead.
        const resolved = this.resolveBundlePackage(bundleName);
        if (resolved === undefined) {
          throw new ManagerError("not-installed", bundleName);
        }
        if (!hasBundleManifest(resolved.manifest)) {
          throw new ManagerError("not-a-bundle", bundleName);
        }
        const platform = bundlePlatformSupport(resolved.manifest);
        if (!platform.supported) throw new ManagerError("invalid-platform", platform.reason);
        if (current.includes(bundleName)) {
          return { ok: true, changed: false, enabled: true };
        }
        current.push(bundleName);
      } else {
        if (!current.includes(bundleName)) {
          return { ok: true, changed: false, enabled: false };
        }
        const index = current.indexOf(bundleName);
        current.splice(index, 1);
      }

      const dsh = isRecord(manifest.dsh) ? manifest.dsh : {};
      const profile = isRecord(dsh.profile) ? dsh.profile : {};
      manifest.dsh = { ...dsh, profile: { ...profile, bundles: current } };
      writeProfileManifest(this.dir, manifest);
      return { ok: true, changed: true, enabled };
    });
  }

  /** Inspect an npm registry spec before the user commits to installing it. */
  async inspectSpec(spec: string): Promise<InspectSpecOutput> {
    const value = spec.trim();
    if (!isRegistrySpec(value)) {
      return { ok: false, client: false, errorCode: "invalid-spec" };
    }

    let result: RunResult;
    try {
      result = await this.#runPlugin(["view", value, "--json"], VIEW_TIMEOUT_MS);
    } catch (error) {
      return { ok: false, client: false, ...failureOf(error) };
    }
    if (result.code !== 0) {
      return { ok: false, client: false, ...this.#commandFailure(result) };
    }

    let manifest: unknown;
    try {
      manifest = parseJsonLoose(result.stdout);
    } catch {
      return { ok: false, client: false, errorCode: "registry-unreadable" };
    }
    if (!isRecord(manifest)) {
      return { ok: false, client: false, errorCode: "registry-invalid" };
    }
    const dsh = packageDsh(manifest);
    if (!isRecord(dsh?.bundle)) {
      return { ok: false, client: false, errorCode: "not-a-bundle" };
    }

    return {
      ok: true,
      name: stringValue(manifest.name) ?? registryName(value),
      version: stringValue(manifest.version),
      description: stringValue(manifest.description) ?? "",
      client: hasClientUi(manifest),
    };
  }

  /** Start one package operation. At most one may run at a time. */
  startJob(input: StartJobInput): StartJobOutput {
    if (this.#disposed) throw new ManagerError("disposed");
    if (this.#activeJobId !== undefined) {
      throw new ManagerError("busy", this.#activeJobId);
    }
    const job: Job = {
      id: randomUUID(),
      kind: input.kind,
      state: "running",
      output: "",
      startedAt: Date.now(),
    };
    this.#jobs.set(job.id, job);
    this.#activeJobId = job.id;

    void this.#runJob(job, input)
      .then(() => {
        job.state = "succeeded";
      })
      .catch((error) => {
        job.state = "failed";
        const failure = failureOf(error);
        job.errorCode = failure.errorCode;
        job.errorDetail = failure.errorDetail;
      })
      .finally(() => {
        job.finishedAt = Date.now();
        if (this.#activeJobId === job.id) this.#activeJobId = undefined;
        this.#pruneJobs();
      });

    return { ok: true, id: job.id };
  }

  status(id: string): JobStatus {
    const job = this.#jobs.get(id);
    if (job === undefined) throw new ManagerError("job-missing", id);
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      output: job.output,
      ...(job.errorCode === undefined ? {} : { errorCode: job.errorCode }),
      ...(job.errorDetail === undefined ? {} : { errorDetail: job.errorDetail }),
      ...(job.updates === undefined ? {} : { updates: job.updates }),
      ...(job.updateResults === undefined ? {} : { updateResults: job.updateResults }),
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    };
  }

  /** Kill running children when Paseo unloads the plugin. */
  dispose(): void {
    this.#disposed = true;
    for (const child of this.#children) killTree(child);
    this.#children.clear();
    if (this.#activeJobId !== undefined) {
      const job = this.#jobs.get(this.#activeJobId);
      if (job !== undefined) {
        if (job.child !== undefined) killTree(job.child);
        job.state = "failed";
        job.errorCode = "disposed";
        job.finishedAt = Date.now();
      }
      this.#activeJobId = undefined;
    }
    this.#jobs.clear();
  }

  #describe(
    name: string,
    spec: string | undefined,
    selected: string[],
    dshVersion: string | undefined,
  ): BundleInfo {
    const resolved = this.resolveBundlePackage(name);
    const pkg = resolved?.manifest;
    // Official means "the installation supplied it", not "the name starts with
    // @deepseek-ai": DSH's contract is that an in-box bundle always loads from
    // the installation, so that is the copy this row describes.
    const official = resolved?.origin === "installation";
    const protectedBundle = PROTECTED_BUNDLES.has(name);
    // A base bundle this process cannot see (an unrecognised launcher) is still
    // installed: the running dsh composed this profile from it. Reporting it
    // missing would be the same false alarm this resolution removes.
    const baseFallback = name === BASE_BUNDLE && resolved === undefined;
    const installed = resolved !== undefined || baseFallback;
    const bundleManifest = baseFallback || (pkg !== undefined && hasBundleManifest(pkg));
    const enabled = selected.includes(name);
    const version = pkg !== undefined
      ? stringValue(pkg.version)
      : baseFallback
        ? dshVersion
        : undefined;
    const kind: BundleInfo["kind"] = !installed
      ? "missing"
      : bundleManifest || enabled
        ? "bundle"
        : "dependency";
    const client = pkg !== undefined && hasClientUi(pkg);
    const platform = pkg === undefined ? { supported: true as const } : bundlePlatformSupport(pkg);
    // Rows come from the resolved copy: an installation bundle's patch is inside
    // the dsh package, not under the profile.
    const rows = resolved === undefined ? [] : readRows(resolved.dir, resolved.manifest);
    const description = pkg === undefined ? "" : stringValue(pkg.description) ?? "";
    const updatable = !official
      && !protectedBundle
      && installed
      && bundleManifest
      && version !== undefined
      && versionParts(version) !== undefined
      && spec !== undefined
      && isRegistryDependencySpec(spec);
    const cachedUpdate = this.#updates.get(name);
    const update = cachedUpdate !== undefined
      && version !== undefined
      && isNewer(cachedUpdate, version)
      ? cachedUpdate
      : undefined;

    return {
      name,
      ...(version === undefined ? {} : { version }),
      description,
      enabled,
      installed,
      kind,
      protected: protectedBundle,
      official,
      client,
      platformSupported: platform.supported,
      ...(platform.supported ? {} : { platformReason: platform.reason }),
      // Official bundles follow the DSH upgrade: removing one would only edit a
      // profile dependency the installation's copy keeps overriding.
      removable: !protectedBundle && !official && installed && spec !== undefined,
      updatable,
      ...(update === undefined ? {} : { update }),
      rows,
    };
  }

  async #runJob(job: Job, input: StartJobInput): Promise<void> {
    switch (input.kind) {
      case "install": {
        const spec = input.spec.trim();
        const inspected = await this.inspectSpec(spec);
        if (!inspected.ok) {
          throw new ManagerError(inspected.errorCode ?? "command-failed", inspected.errorDetail);
        }
        const name = inspected.name ?? registryName(spec);
        const manifest = readProfileManifestIfPresent(this.dir);
        if (manifest !== undefined && dependencies(manifest)[name] !== undefined) {
          throw new ManagerError("already-installed", name);
        }
        const result = await this.#runPlugin(
          ["add", "--save-exact", spec],
          INSTALL_TIMEOUT_MS,
          job,
        );
        if (result.code !== 0) throw new ManagerError("command-failed", this.#commandFailure(result).errorDetail);
        return;
      }
      case "remove": {
        const name = input.name.trim();
        if (PROTECTED_BUNDLES.has(name)) {
          throw new ManagerError("protected", name);
        }
        if (this.resolveBundlePackage(name)?.origin === "installation") {
          throw new ManagerError("not-removable", name);
        }
        const manifest = readProfileManifest(this.dir);
        if (dependencies(manifest)[name] === undefined) {
          throw new ManagerError("not-removable", name);
        }
        const result = await this.#runPlugin(["remove", name], INSTALL_TIMEOUT_MS, job);
        if (result.code !== 0) throw new ManagerError("command-failed", this.#commandFailure(result).errorDetail);
        return;
      }
      case "update": {
        await this.#updateOne(input.name, input.version, job);
        return;
      }
      case "update-all": {
        await this.#updateAll(input.targets, job);
        return;
      }
      case "check":
        await this.#checkUpdates(job);
        return;
    }
  }

  /**
   * Move one installed bundle to a discovered version, the single and the
   * batch path both. Validation is the single-update contract: a protected,
   * installation-supplied, malformed, undeclared or non-bundle target never
   * reaches `dsh plugin`.
   */
  async #updateOne(rawName: string, rawVersion: string, job?: Job): Promise<void> {
    const name = rawName.trim();
    const version = rawVersion.trim();
    if (PROTECTED_BUNDLES.has(name)) {
      throw new ManagerError("protected", name);
    }
    if (this.resolveBundlePackage(name)?.origin === "installation") {
      throw new ManagerError("protected", name);
    }
    if (!isRegistrySpec(`${name}@${version}`)) {
      throw new ManagerError("invalid-version", version);
    }
    const manifest = readProfileManifest(this.dir);
    if (dependencies(manifest)[name] === undefined) {
      throw new ManagerError("not-in-dependencies", name);
    }
    const installed = this.resolveBundlePackage(name);
    if (installed === undefined || !hasBundleManifest(installed.manifest)) {
      throw new ManagerError("not-a-bundle", name);
    }
    const result = await this.#runPlugin(
      ["add", "--save-exact", `${name}@${version}`],
      INSTALL_TIMEOUT_MS,
      job,
    );
    if (result.code !== 0) throw new ManagerError("command-failed", this.#commandFailure(result).errorDetail);
    this.#updates.delete(name);
  }

  /**
   * Update every updatable bundle in one job.
   *
   * `dsh plugin update <names…>` exists (pnpm's `update` is forwarded) but is
   * not usable here: on DSH 0.2.2-rc.3 it answers "Already up to date" and
   * leaves the profile's exact-pinned dependencies where they were (measured in
   * a throwaway DSH_HOME), so a batch must reuse the single update path, which
   * pins the *discovered* version with `add --save-exact`. One job, one process
   * lock at a time (`startJob` refuses a second job); targets are re-checked
   * against the current inventory, so an official bundle is dropped even if a
   * stale page asks for it. Any failure fails the job while keeping every
   * target's own outcome — a partial success must never read as success.
   *
   * @param targets - the rows the page showed as updatable.
   * @param job - the job these calls stream into.
   */
  async #updateAll(targets: UpdateTarget[], job: Job): Promise<void> {
    const snapshot = await this.list();
    if (snapshot.errorCode !== undefined) {
      throw new ManagerError(snapshot.errorCode, snapshot.errorDetail);
    }
    const updatable = new Set(
      snapshot.bundles
        .filter((bundle) => bundle.updatable && !bundle.official)
        .map((bundle) => bundle.name),
    );
    const selected = targets.filter((target) => updatable.has(target.name.trim()));
    job.updateResults = [];
    if (selected.length === 0) return;

    for (const target of selected) {
      const name = target.name.trim();
      const version = target.version.trim();
      try {
        await this.#updateOne(name, version, job);
        job.updateResults.push({ name, version, ok: true });
      } catch (error) {
        const failure = failureOf(error);
        job.updateResults.push({
          name,
          version,
          ok: false,
          errorCode: failure.errorCode,
          ...(failure.errorDetail === undefined ? {} : { errorDetail: failure.errorDetail }),
        });
      }
    }

    // The task fails as a whole; the per-target list above carries the reasons,
    // so no single error detail is invented here.
    if (job.updateResults.some((outcome) => !outcome.ok)) {
      throw new ManagerError("command-failed");
    }
  }

  async #checkUpdates(job: Job): Promise<void> {
    const snapshot = await this.list();
    if (snapshot.errorCode !== undefined) {
      throw new ManagerError(snapshot.errorCode, snapshot.errorDetail);
    }
    const candidates = snapshot.bundles.filter((bundle) => bundle.updatable);
    this.#updates.clear();
    if (candidates.length === 0) {
      job.updates = {};
      return;
    }

    const failures: string[] = [];
    for (const bundle of candidates) {
      const result = await this.#runPlugin(
        ["view", bundle.name, "version", "--json"],
        VIEW_TIMEOUT_MS,
      );
      if (result.code !== 0) {
        failures.push(`${bundle.name}: ${lastLines(result.output, 4)}`);
        continue;
      }
      let latest: string | undefined;
      try {
        const parsed = parseJsonLoose(result.stdout);
        latest = typeof parsed === "string"
          ? parsed
          : isRecord(parsed)
            ? stringValue(parsed.version)
            : undefined;
      } catch {
        latest = undefined;
      }
      if (latest === undefined) {
        failures.push(`${bundle.name}: unreadable version`);
        continue;
      }
      if (bundle.version !== undefined && isNewer(latest, bundle.version)) {
        this.#updates.set(bundle.name, latest);
      }
    }
    job.updates = Object.fromEntries(this.#updates);
    if (failures.length > 0) {
      throw new ManagerError("check-failed", failures.join("\n"));
    }
  }

  #commandFailure(result: RunResult): { errorCode: "command-failed"; errorDetail: string } {
    const reason = result.timedOut ? "timeout" : `exit ${result.code}`;
    const tail = lastLines(result.output, 20);
    return {
      errorCode: "command-failed",
      errorDetail: tail === "" ? reason : `${reason}\n${tail}`,
    };
  }

  async #getDshVersion(): Promise<string | undefined> {
    this.#dshVersionPromise ??= this.#readDshVersion();
    return this.#dshVersionPromise;
  }

  async #readDshVersion(): Promise<string | undefined> {
    try {
      const result = await this.#runDsh(["--version"], 5_000);
      const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(`${result.stdout}\n${result.output}`);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  #runPlugin(args: string[], timeoutMs: number, job?: Job): Promise<RunResult> {
    return this.#runDsh(["plugin", "--profile", this.profile, ...args], timeoutMs, job);
  }

  #runDsh(args: string[], timeoutMs: number, job?: Job): Promise<RunResult> {
    if (this.#disposed) {
      return Promise.reject(new ManagerError("disposed"));
    }
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      // The page manages the profile this process was configured with, and DSH
      // reads the same `$DSH_HOME`; passing it explicitly keeps a child that
      // inherits a *different* environment from managing another tree.
      const env = { ...process.env, DSH_HOME: this.dshHome };
      try {
        child = this.#spawnDsh(args, {
          cwd: this.dir,
          env,
          detached: process.platform !== "win32",
        });
      } catch (error) {
        reject(new ManagerError("spawn-failed", `${dshCommandLabel()}: ${errorMessage(error)}`));
        return;
      }

      this.#children.add(child);
      if (job !== undefined) job.child = child;

      let stdout = "";
      let stderr = "";
      let output = "";
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        const fallback = setTimeout(() => {
          finish({ code: 124, timedOut: true, stdout, stderr, output });
        }, 5_000);
        fallback.unref();
      }, timeoutMs);
      timer.unref();

      const push = (chunk: string): void => {
        output = (output + chunk).slice(-OUTPUT_LIMIT);
        if (job !== undefined) {
          job.output = `${job.output}${chunk}`.slice(-OUTPUT_LIMIT);
        }
      };
      const finish = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (job !== undefined && job.child === child) job.child = undefined;
        resolve(result);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (job !== undefined && job.child === child) job.child = undefined;
        reject(error);
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-CAPTURE_LIMIT);
        push(chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-CAPTURE_LIMIT);
        push(chunk);
      });
      child.on("error", (error) => {
        this.#children.delete(child);
        fail(new ManagerError("spawn-failed", `${dshCommandLabel()}: ${error.message}`));
      });
      child.on("close", (code) => {
        this.#children.delete(child);
        finish({
          code: code ?? (timedOut ? 124 : 1),
          timedOut,
          stdout,
          stderr,
          output,
        });
      });
    });
  }

  #pruneJobs(): void {
    for (const [id] of this.#jobs) {
      if (this.#jobs.size <= MAX_RETAINED_JOBS) break;
      if (id !== this.#activeJobId) this.#jobs.delete(id);
    }
  }
}