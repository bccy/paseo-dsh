/**
 * Idempotent provisioning of the DSH `paseo` profile the plugin drives.
 *
 * Paseo installs plugins from npm or git and runs no install scripts, so a
 * plugin cannot rely on the repo's `install.sh`. Instead the plugin carries the
 * DSH bridge bundle (embedded by `scripts/generate-bridge-assets.mjs`) and
 * writes the whole profile on load: the profile files, the bridge itself under
 * the shared module anchor beside the profiles (see {@link sharedBridgeDir}),
 * and a starter model-route patch when the user has none.
 *
 * Re-running on every load is deliberate — updating the installed plugin is the
 * only step needed to update the bridge, because this rewrites it from the
 * plugin's own embedded copy.
 *
 * @module dsh-paseo/server/bootstrap
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BRIDGE_FILES, BRIDGE_PACKAGE_NAME, PROFILE_PATCH_TEMPLATE_BASE64 } from "./bridge-assets";

const CORDIS_YML = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

const PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

/**
 * Where the bridge package lives: beside the profiles, not inside one.
 *
 * `$DSH_HOME/profiles/<name>/node_modules` belongs to pnpm — `dsh plugin
 * --profile <name> add|remove|install` forwards its arguments to pnpm in that
 * directory, and the profile's `pnpm-workspace.yaml` selects `nodeLinker:
 * hoisted`. Under that linker pnpm 12 treats every directory its previous
 * install did not record as an orphan and moves it to `node_modules/.ignored/`
 * ("clears orphaned package directories … an unrecorded directory is moved to
 * node_modules/.ignored", pnpm CHANGELOG, issue #13676). The bridge is written
 * by this plugin and never installed by pnpm, so it was exactly that orphan:
 * the first `dsh plugin` command after a daemon start moved it away, DSH printed
 * `skipping profile bundle "dsh-paseo-bridge"`, and the profile ran without the
 * bridge until the next daemon restart rewrote it.
 *
 * The alternatives were measured and rejected (harness/pnpm-bridge-check.mjs
 * pins the chosen one): declaring the bridge in the profile manifest as a
 * `link:` dependency rewrites a file the user owns, makes pnpm and this plugin
 * fight over the same `node_modules` entry on every install, and turns every
 * plugin command into a `peer dependencies` warning (the bridge peers
 * `@deepseek-ai/cordis`, which a profile does not install); an undeclared
 * symlink survives pnpm only because pnpm 12 happens to move directories and
 * not symlinks — an undocumented detail, not a contract. Moving the package out
 * of the pnpm project removes the race instead of negotiating it: pnpm's working
 * directory is the profile and it only manages that directory's `node_modules`.
 *
 * `$DSH_HOME/profiles/node_modules` is a real resolution anchor, not a made-up
 * path. `resolveBundleDir()` in `@deepseek-ai/dsh-app-boot` resolves a bundle
 * from the installation first, then from `createRequire(<profile>/package.json)
 * .resolve.paths(...)` — Node's own lookup order, which walks up from the
 * profile to its parent. The profile runtime interception does the same: a
 * request with no entry in the profile's own `node_modules` continues natively
 * from `<profileParent>/package.json` (`routeScoped` / `computeProfileLayer`).
 * Verified end to end with `dsh --profile <name> --dump-config` (composition)
 * and `--dump-config-schema` (which imports the bridge modules).
 *
 * Trade-off, stated because it is real: the anchor is shared by every profile
 * under this DSH home, so two profiles driven by different plugin builds would
 * overwrite each other's bridge on load (last load wins; the same build writes
 * identical bytes). The normal deployment is one daemon driving one profile, and
 * the alternative is putting the bridge back inside pnpm's territory.
 *
 * @param home - absolute `$DSH_HOME`.
 * @returns absolute path of the bridge package directory.
 */
function sharedBridgeDir(home: string): string {
  return join(home, "profiles", "node_modules", BRIDGE_PACKAGE_NAME);
}

/** Whether a path exists, including a dangling symlink (`existsSync` follows links). */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * pnpm parks the copies it moved aside as `dsh-paseo-bridge` or
 * `dsh-paseo-bridge_<n>`. Anything else — notably the `dsh-paseo-bridge.bak-*`
 * directories an older tool left in one real profile — is not pnpm's naming and
 * is left alone: this cleanup owns pnpm's parked copies, not someone's backups.
 */
const IGNORED_BRIDGE_COPY = new RegExp(`^${BRIDGE_PACKAGE_NAME}(?:_\\d+)?$`);

/**
 * Delete the copies pnpm parked in `node_modules/.ignored/`.
 *
 * These are copies of this plugin's own bridge that pnpm moved out of the way
 * (one per `dsh plugin` command before the bridge moved to the shared anchor);
 * the real profile had 18 of them. Removing them is what stops the leak from
 * continuing to grow. A failure is ignored: the directory is inert, pnpm may be
 * mid-move, and a leftover copy must not turn a usable profile into a reported
 * provisioning failure.
 *
 * @param ignoredDir - `<profile>/node_modules/.ignored`.
 */
function removeIgnoredBridgeCopies(ignoredDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(ignoredDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!IGNORED_BRIDGE_COPY.test(name)) continue;
    try {
      rmSync(join(ignoredDir, name), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Take the bridge out of the profile's pnpm-managed `node_modules`.
 *
 * The old provisioning location (`<profile>/node_modules/dsh-paseo-bridge`, real
 * directory or the symlink `install.sh` creates) is resolved *before* the shared
 * anchor, so a stale copy left there would shadow the generation this call just
 * wrote. The directory is renamed aside first — the rename is what stops it from
 * being resolved — and the parked generation is removed best-effort.
 *
 * A rename failure throws, and that is all it does: the caller
 * (`index.server.ts`) logs one `NOT ready` line and **still registers the
 * provider** — a provisioning failure must not take the provider down. So the
 * profile keeps the old bridge in its own `node_modules`, DSH resolves that copy
 * before the shared anchor, and sessions run on the stale bridge. The throw makes
 * the failure visible in the log; it does not remove the stale copy. That state
 * is what `doctor` names as `legacy bridge copy shadows the provisioned one`.
 * Reading `NOT ready` as "the stale bridge was taken out of the way" would be
 * wrong.
 *
 * @param profileDir - the profile directory.
 */
function retireLegacyBridge(profileDir: string): void {
  const modules = join(profileDir, "node_modules");
  const legacy = join(modules, BRIDGE_PACKAGE_NAME);
  if (pathExists(legacy)) {
    const parked = bridgeGenerationPath(modules, `.${BRIDGE_PACKAGE_NAME}.retired-`);
    renameSync(legacy, parked);
    try {
      rmSync(parked, { recursive: true, force: true });
    } catch {
      /* the parked generation is out of the resolution path; cleanup is best-effort */
    }
  }
  removeIgnoredBridgeCopies(join(modules, ".ignored"));
}

/**
 * The DSH profile name this plugin drives.
 *
 * The single definition of the lookup: `ensurePaseoProfile()` provisions what the
 * daemon's environment names, and the spawned child is given `--profile` with the
 * value resolved from *its own* environment (see `dsh-process.ts`), so both sides
 * always agree on which profile directory is meant.
 *
 * @param env - environment to read (a child's merged env, or the daemon's).
 * @returns the configured profile name, or `paseo` when unset.
 */
export function profileName(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env["DSH_PASEO_PROFILE"] ?? "paseo";
}

/**
 * Expand a leading `~` exactly like DSH's own home resolver.
 *
 * Copied verbatim from `@deepseek-ai/dsh-home-paths` `expandHomePath`: a leading
 * `~`, `~/` or `~\` is the OS home, anything else is returned unchanged.
 *
 * @param value - configured path that may begin with `~`.
 * @returns the expanded path, or the original value when no prefix matched.
 */
function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Resolve `$DSH_HOME` the way DSH itself does.
 *
 * DSH's resolver (`resolveRoot` in `@deepseek-ai/dsh-home-paths`) treats a `~`
 * prefix as the OS home, treats an empty/whitespace-only override as unset, and
 * `path.resolve()`s the result — so a deployment that sets `DSH_HOME=~/dsh-alt`
 * or a relative path gets a different directory than a literal `join(raw, …)`
 * would produce. Provisioning into the wrong tree is invisible until *every*
 * session fails to find its profile, so the two resolvers must agree.
 *
 * @param env - environment to read (defaults to the daemon's own).
 * @returns the absolute DSH home directory.
 */
function dshHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env["DSH_HOME"];
  const base =
    configured !== undefined && configured.trim() !== "" ? configured : join(homedir(), ".dsh");
  return resolve(expandHomePath(base));
}

function profilePackageJson(profile: string): string {
  return `${JSON.stringify(
    {
      name: `dsh-profile-${profile}`,
      private: true,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", BRIDGE_PACKAGE_NAME] } },
    },
    null,
    2,
  )}\n`;
}

/** Write only when the path does not exist yet. */
function writeIfAbsent(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, content);
  return true;
}

/** A sibling directory name for one bridge generation; unique per call. */
function bridgeGenerationPath(parent: string, prefix: string): string {
  return join(
    parent,
    `${prefix}${String(process.pid)}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

/** SHA-256 of one buffer, used to verify what actually reached the disk. */
function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Write the embedded bridge into a fresh directory and verify every file.
 *
 * The verification is not ceremony: `writeFileSync` returning normally is not a
 * promise that the bytes on disk are complete (a full disk or a failing overlay
 * can leave a short file), and a half bridge is only discovered when the first
 * session fails to start. A generation that fails either the length or the hash
 * check throws here, before anything is renamed into place.
 *
 * @param dir - the (not yet published) generation directory.
 */
function writeBridgeGeneration(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [relativePath, encoded] of Object.entries(BRIDGE_FILES)) {
    const target = join(dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    const expected = Buffer.from(encoded, "base64");
    writeFileSync(target, expected);
    const written = readFileSync(target);
    if (written.length !== expected.length || digest(written) !== digest(expected)) {
      throw new Error(
        `bridge file "${relativePath}" did not survive its write `
          + `(${String(written.length)} of ${String(expected.length)} bytes)`,
      );
    }
  }
}

/**
 * Replace the profile's bridge directory with the embedded copy, atomically.
 *
 * The new generation is staged and verified beside the target first; only then
 * is the old directory moved aside and the staged one renamed into place. A
 * failure at any point leaves the previous generation in place (or restores it),
 * so a disk error cannot leave the profile with half a bridge until the next
 * plugin load. `renameSync` within one directory is the atomic publish step.
 *
 * @param bridgeDir - the bridge package directory to publish.
 */
function replaceBridge(bridgeDir: string): void {
  const parent = dirname(bridgeDir);
  const staging = bridgeGenerationPath(parent, `.${BRIDGE_PACKAGE_NAME}.staging-`);
  const previous = bridgeGenerationPath(parent, `.${BRIDGE_PACKAGE_NAME}.previous-`);
  let previousHoldsOld = false;
  try {
    writeBridgeGeneration(staging);
    if (pathExists(bridgeDir)) {
      // `rename` cannot replace a non-empty directory, and clearing the old one
      // first is exactly the window this function exists to remove. Move it
      // aside only after the replacement is complete and verified.
      renameSync(bridgeDir, previous);
      previousHoldsOld = true;
    }
    renameSync(staging, bridgeDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(bridgeDir) && previousHoldsOld) {
      try {
        renameSync(previous, bridgeDir);
      } catch (restoreError) {
        const cause = error instanceof Error ? error.message : String(error);
        const restore = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new Error(
          `could not replace the bridge (${cause}) and the previous generation could not be restored (${restore})`,
        );
      }
    }
    throw error;
  }
  if (previousHoldsOld) {
    // The switch already succeeded; a leftover generation directory is harmless
    // and must not turn a usable profile into a reported provisioning failure.
    try {
      rmSync(previous, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

export interface ProvisionResult {
  profile: string;
  dir: string;
  /** The bridge package directory this call provisioned (outside the profile's pnpm project). */
  bridgeDir: string;
  bridgeFiles: number;
  patchCreated: boolean;
}

/**
 * Ensure `$DSH_HOME/profiles/<profile>` exists and carries the bridge.
 *
 * Throws only on a real filesystem failure; callers treat provisioning as a
 * convenience and must not fail plugin load over it.
 */
export function ensurePaseoProfile(): ProvisionResult {
  const profile = profileName();
  const home = dshHome();
  const dir = join(home, "profiles", profile);
  mkdirSync(join(dir, "node_modules"), { recursive: true });

  // The profile's own files belong to the user: create a missing one, but never
  // overwrite a customized package.json (extra dependencies), cordis.yml, or
  // workspace file. Only the bridge we own is rewritten.
  writeIfAbsent(join(dir, "package.json"), profilePackageJson(profile));
  writeIfAbsent(join(dir, "cordis.yml"), CORDIS_YML);
  writeIfAbsent(join(dir, "pnpm-workspace.yaml"), PNPM_WORKSPACE);

  // Replace whatever bridge is present — an older copy, or the symlink the
  // repo's install.sh creates — so the profile always matches this plugin build.
  // Generation staging + verification + rename keeps a failed copy from ever
  // becoming the live bridge; see {@link replaceBridge}. The package lives at
  // the shared anchor beside the profiles, outside the directory pnpm manages
  // for the profile; see {@link sharedBridgeDir} for why.
  const bridgeDir = sharedBridgeDir(home);
  replaceBridge(bridgeDir);

  // Older plugin builds (and install.sh) put the bridge inside the profile's
  // node_modules, where pnpm now moves it to .ignored on every plugin command.
  // Publish first, then take the legacy copy out of the resolution path; the
  // profile's own node_modules is resolved before the shared anchor.
  retireLegacyBridge(dir);

  // The one file the user owns: never overwrite an existing model route.
  const patch = join(dir, "cordis.patch.yml");
  const patchCreated = !existsSync(patch);
  if (patchCreated) {
    writeFileSync(patch, Buffer.from(PROFILE_PATCH_TEMPLATE_BASE64, "base64"));
  }

  return { profile, dir, bridgeDir, bridgeFiles: Object.keys(BRIDGE_FILES).length, patchCreated };
}
