import fsSync, { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RECOVERY_FOLDER_NAME } from "../../shared/antigravity/contracts";

/** The daemon user's real home. agy keeps the system sign-in's data in `<home>/.gemini`. */
export const REAL_HOME = os.homedir();
export const REAL_GEMINI = path.join(REAL_HOME, ".gemini");
/** agy's default app-data directory (`--app-data-dir antigravity-cli`). */
export const REAL_CLI_DIR = path.join(REAL_GEMINI, "antigravity-cli");
/** agy's settings: default model, Orchestrator planner and executor, trusted folders and more. */
export const REAL_SETTINGS_FILE = path.join(REAL_CLI_DIR, "settings.json");

/**
 * Directories under antigravity-cli that hold conversation state. Every profile links these to the
 * real ones, so a conversation started on one account can be reopened on another.
 */
export const SHARED_CLI_DIRS = ["conversations", "brain", "implicit"] as const;

/** Files agents saved in a removed account's HOME are moved here, one folder per account. */
export const RECOVERY_DIR = path.join(REAL_HOME, RECOVERY_FOLDER_NAME);

/** Entries migrated from the standalone `antigravity-accounts` plugin data dir. */
const LEGACY_MIGRATION_ENTRIES = [
  "profiles",
  "conversation-accounts.json",
  "status.json",
  "pricing.json",
  "accounts.json",
] as const;

export interface PathResolveOptions {
  paseoHome?: string;
  homeDir?: string;
  pathEnv?: string;
  /** Override default system search paths (`["/opt/homebrew/bin/agy", "/usr/local/bin/agy"]`), primarily for tests. */
  systemCandidates?: readonly string[];
}

export interface MigrateOptions {
  legacyDir?: string;
  targetDir?: string;
}

export interface MigrateResult {
  migrated: boolean;
  copiedEntries: string[];
}

export interface OpenHookCheckOptions extends PathResolveOptions {
  primaryDataDir?: string;
  legacyDataDir?: string;
}

export interface PresenceCheckOptions extends OpenHookCheckOptions {
  cliDir?: string;
}

export interface AntigravityPresence {
  agyInstalled: boolean;
  hasAntigravityData: boolean;
  hasAntigravityAccounts: boolean;
}

/** A path for people to read: inside the real home it starts with `~`. */
export function displayPath(file: string): string {
  return file === REAL_HOME || file.startsWith(REAL_HOME + path.sep)
    ? "~" + file.slice(REAL_HOME.length)
    : file;
}

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(REAL_HOME, ".paseo");
}

export function dataDir(): string {
  return path.join(paseoHome(), "plugin-data", "dsh-paseo", "antigravity");
}

export function legacyDataDir(): string {
  return path.join(paseoHome(), "plugin-data", "antigravity-accounts");
}

export function legacyPricingFile(): string {
  return path.join(legacyDataDir(), "pricing.json");
}

export function storeFile(): string {
  return path.join(dataDir(), "accounts.json");
}

export function profileRoot(accountId: string): string {
  return path.join(dataDir(), "profiles", accountId);
}

/** The HOME an account's agy processes run with. */
export function profileHome(accountId: string): string {
  return path.join(profileRoot(accountId), "home");
}

export function profileCliDir(accountId: string): string {
  return path.join(profileHome(accountId), ".gemini", "antigravity-cli");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function buildAgyCandidates(
  configured: string | null,
  homeDir: string,
  pathEnv: string,
  systemCandidates: readonly string[] = ["/opt/homebrew/bin/agy", "/usr/local/bin/agy"],
): string[] {
  const candidates: string[] = [];
  if (configured) {
    if (path.isAbsolute(configured)) candidates.push(configured);
    else if (configured.includes("/")) candidates.push(path.resolve(homeDir, configured));
  }
  const name = configured && !configured.includes("/") ? configured : "agy";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, name));
  }
  candidates.push(path.join(homeDir, ".local", "bin", "agy"), ...systemCandidates);
  return candidates;
}

function parseConfiguredAgyCommand(raw: string): string | null {
  try {
    const config = JSON.parse(raw) as {
      agents?: { providers?: Record<string, { command?: unknown }> };
    };
    const command = config.agents?.providers?.antigravity?.command;
    if (Array.isArray(command) && typeof command[0] === "string" && command[0].trim()) {
      return command[0].trim();
    }
  } catch {
    // Malformed config: fall back to PATH lookup.
  }
  return null;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    await fs.access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutableSync(file: string): boolean {
  try {
    const stat = fsSync.statSync(file);
    if (!stat.isFile()) return false;
    fsSync.accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The command Paseo itself launches for the built-in provider, when config.json overrides it. */
async function configuredAgyCommand(paseoHomeDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(paseoHomeDir, "config.json"), "utf8");
    return parseConfiguredAgyCommand(raw);
  } catch {
    return null;
  }
}

function configuredAgyCommandSync(paseoHomeDir: string): string | null {
  try {
    const raw = fsSync.readFileSync(path.join(paseoHomeDir, "config.json"), "utf8");
    return parseConfiguredAgyCommand(raw);
  } catch {
    return null;
  }
}

/** Finds the agy executable the same way a user would expect: config override, PATH, usual installs. */
export async function resolveAgy(options?: PathResolveOptions): Promise<string | null> {
  const paseoHomeDir = options?.paseoHome ?? paseoHome();
  const homeDir = options?.homeDir ?? REAL_HOME;
  const pathEnv = options?.pathEnv ?? process.env.PATH ?? "";
  const configured = await configuredAgyCommand(paseoHomeDir);
  const candidates = buildAgyCandidates(configured, homeDir, pathEnv, options?.systemCandidates);
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Synchronous counterpart to `resolveAgy()`, used during synchronous plugin hook registration. */
export function resolveAgySync(options?: PathResolveOptions): string | null {
  const paseoHomeDir = options?.paseoHome ?? paseoHome();
  const homeDir = options?.homeDir ?? REAL_HOME;
  const pathEnv = options?.pathEnv ?? process.env.PATH ?? "";
  const configured = configuredAgyCommandSync(paseoHomeDir);
  const candidates = buildAgyCandidates(configured, homeDir, pathEnv, options?.systemCandidates);
  for (const candidate of candidates) {
    if (isExecutableSync(candidate)) return candidate;
  }
  return null;
}

function accountsJsonHasProfileAccounts(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { accounts?: unknown };
    return Array.isArray(parsed?.accounts) && parsed.accounts.length >= 1;
  } catch {
    return false;
  }
}

function hasProfileAccountsSync(filePath: string): boolean {
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    return accountsJsonHasProfileAccounts(raw);
  } catch {
    return false;
  }
}

async function hasProfileAccounts(filePath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return accountsJsonHasProfileAccounts(raw);
  } catch {
    return false;
  }
}

/**
 * Synchronous gate for registering `agent.open.before`.
 * Returns true only when `agy` is installed on this host OR at least one Antigravity profile
 * account is configured (in primary or legacy data dir), so pure-DSH hosts register zero
 * `agent.open.before` hooks and never trigger Paseo's session-invalidation reload on plugin restarts.
 */
export function shouldRegisterAntigravityOpenHookSync(options?: OpenHookCheckOptions): boolean {
  if (resolveAgySync(options) !== null) return true;
  const paseoHomeDir = options?.paseoHome ?? paseoHome();
  const primary = options?.primaryDataDir ?? path.join(paseoHomeDir, "plugin-data", "dsh-paseo", "antigravity");
  const legacy = options?.legacyDataDir ?? path.join(paseoHomeDir, "plugin-data", "antigravity-accounts");
  if (hasProfileAccountsSync(path.join(primary, "accounts.json"))) return true;
  if (hasProfileAccountsSync(path.join(legacy, "accounts.json"))) return true;
  return false;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasConversationDbs(cliDir: string): Promise<boolean> {
  const dir = path.join(cliDir, SHARED_CLI_DIRS[0]);
  try {
    const names = await fs.readdir(dir);
    return names.some((name) => /^[0-9a-f-]{36}\.db$/i.test(name));
  } catch {
    return false;
  }
}

/** Detects whether Antigravity CLI, conversation data, or profile accounts exist on this host. */
export async function detectAntigravityPresence(options?: PresenceCheckOptions): Promise<AntigravityPresence> {
  const paseoHomeDir = options?.paseoHome ?? paseoHome();
  const homeDir = options?.homeDir ?? REAL_HOME;
  const cliDir = options?.cliDir ?? path.join(homeDir, ".gemini", "antigravity-cli");
  const primary = options?.primaryDataDir ?? path.join(paseoHomeDir, "plugin-data", "dsh-paseo", "antigravity");
  const legacy = options?.legacyDataDir ?? path.join(paseoHomeDir, "plugin-data", "antigravity-accounts");

  const [agyPath, primaryAccounts, legacyAccounts, hasDbs, hasSettings, hasPrimaryAttr, hasLegacyAttr, hasPrimaryStore, hasLegacyStore] =
    await Promise.all([
      resolveAgy(options),
      hasProfileAccounts(path.join(primary, "accounts.json")),
      hasProfileAccounts(path.join(legacy, "accounts.json")),
      hasConversationDbs(cliDir),
      pathExists(path.join(cliDir, "settings.json")),
      pathExists(path.join(primary, "conversation-accounts.json")),
      pathExists(path.join(legacy, "conversation-accounts.json")),
      pathExists(path.join(primary, "accounts.json")),
      pathExists(path.join(legacy, "accounts.json")),
    ]);

  const hasAntigravityAccounts = primaryAccounts || legacyAccounts;
  const hasAntigravityData =
    hasAntigravityAccounts ||
    hasDbs ||
    hasSettings ||
    hasPrimaryAttr ||
    hasLegacyAttr ||
    hasPrimaryStore ||
    hasLegacyStore;

  return {
    agyInstalled: Boolean(agyPath),
    hasAntigravityData,
    hasAntigravityAccounts,
  };
}

/**
 * Recursively copies a file, directory, or symlink without ever dereferencing symlinks.
 * Special files (sockets, FIFOs, devices) are skipped safely.
 */
async function copyPreservingSymlinks(src: string, dest: string): Promise<void> {
  const stat = await fs.lstat(src);
  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(src);
    await fs.symlink(linkTarget, dest);
    return;
  }
  if (stat.isDirectory()) {
    const mode = stat.mode & 0o777;
    await fs.mkdir(dest, { recursive: true, mode: mode || 0o700 });
    const entries = await fs.readdir(src);
    for (const name of entries) {
      await copyPreservingSymlinks(path.join(src, name), path.join(dest, name));
    }
    await fs.utimes(dest, stat.atime, stat.mtime).catch(() => undefined);
    return;
  }
  if (stat.isFile()) {
    await fs.copyFile(src, dest);
    const mode = stat.mode & 0o777;
    if (mode) await fs.chmod(dest, mode).catch(() => undefined);
    await fs.utimes(dest, stat.atime, stat.mtime).catch(() => undefined);
  }
}

const migrationInFlight = new Map<string, Promise<MigrateResult>>();
let migrationSeq = 0;

/**
 * One-time, idempotent migration from legacy `plugin-data/antigravity-accounts` to
 * `plugin-data/dsh-paseo/antigravity`. Preserves symlinks verbatim (never dereferencing profile
 * symlinks into the user's real HOME) and leaves the legacy directory untouched as a backup.
 * Concurrent calls for the same pair share one in-flight operation.
 */
export function migrateLegacyDataDir(options?: MigrateOptions): Promise<MigrateResult> {
  const legacyDir = path.resolve(options?.legacyDir ?? legacyDataDir());
  const targetDir = path.resolve(options?.targetDir ?? dataDir());
  if (legacyDir === targetDir) {
    return Promise.resolve({ migrated: false, copiedEntries: [] });
  }
  const key = `${legacyDir}::${targetDir}`;
  const existing = migrationInFlight.get(key);
  if (existing) return existing;

  const task = (async (): Promise<MigrateResult> => {
    const [hasTargetAccounts, hasTargetProfiles] = await Promise.all([
      pathExists(path.join(targetDir, "accounts.json")),
      pathExists(path.join(targetDir, "profiles")),
    ]);
    if (hasTargetAccounts || hasTargetProfiles) {
      return { migrated: false, copiedEntries: [] };
    }

    const legacyStat = await fs.stat(legacyDir).catch(() => null);
    if (!legacyStat?.isDirectory()) {
      return { migrated: false, copiedEntries: [] };
    }

    const present: string[] = [];
    for (const entry of LEGACY_MIGRATION_ENTRIES) {
      if (await pathExists(path.join(legacyDir, entry))) {
        present.push(entry);
      }
    }
    if (present.length === 0) {
      return { migrated: false, copiedEntries: [] };
    }

    await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });

    const copiedEntries: string[] = [];
    for (const entry of present) {
      const src = path.join(legacyDir, entry);
      const dest = path.join(targetDir, entry);
      if (await pathExists(dest)) continue;
      const temp = path.join(targetDir, `.${entry}.migrating-${process.pid}-${Date.now()}-${++migrationSeq}`);
      try {
        await copyPreservingSymlinks(src, temp);
        try {
          await fs.rename(temp, dest);
        } catch (error) {
          if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOTEMPTY") {
            await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
            continue;
          }
          throw error;
        }
        copiedEntries.push(entry);
      } catch (error) {
        await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }

    return { migrated: copiedEntries.length > 0, copiedEntries };
  })().finally(() => {
    if (migrationInFlight.get(key) === task) {
      migrationInFlight.delete(key);
    }
  });

  migrationInFlight.set(key, task);
  return task;
}
