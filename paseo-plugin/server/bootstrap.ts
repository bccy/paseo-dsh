/**
 * Idempotent provisioning of the DSH `paseo` profile the plugin drives.
 *
 * Paseo installs plugins from npm or git and runs no install scripts, so a
 * plugin cannot rely on the repo's `install.sh`. Instead the plugin carries the
 * DSH bridge bundle (embedded by `scripts/generate-bridge-assets.mjs`) and
 * writes the whole profile on load: the profile files, the bridge itself under
 * `node_modules/`, and a starter model-route patch when the user has none.
 *
 * Re-running on every load is deliberate — updating the installed plugin is the
 * only step needed to update the bridge, because this rewrites it from the
 * plugin's own embedded copy.
 *
 * @module dsh-paseo/server/bootstrap
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

export interface ProvisionResult {
  profile: string;
  dir: string;
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
  const dir = join(dshHome(), "profiles", profile);
  mkdirSync(join(dir, "node_modules"), { recursive: true });

  // The profile's own files belong to the user: create a missing one, but never
  // overwrite a customized package.json (extra dependencies), cordis.yml, or
  // workspace file. Only the bridge we own is rewritten.
  writeIfAbsent(join(dir, "package.json"), profilePackageJson(profile));
  writeIfAbsent(join(dir, "cordis.yml"), CORDIS_YML);
  writeIfAbsent(join(dir, "pnpm-workspace.yaml"), PNPM_WORKSPACE);

  // Replace whatever bridge is present — an older copy, or the symlink the
  // repo's install.sh creates — so the profile always matches this plugin build.
  const bridgeDir = join(dir, "node_modules", BRIDGE_PACKAGE_NAME);
  if (existsSync(bridgeDir)) rmSync(bridgeDir, { recursive: true, force: true });
  mkdirSync(bridgeDir, { recursive: true });
  for (const [relativePath, encoded] of Object.entries(BRIDGE_FILES)) {
    const target = join(bridgeDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(encoded, "base64"));
  }

  // The one file the user owns: never overwrite an existing model route.
  const patch = join(dir, "cordis.patch.yml");
  const patchCreated = !existsSync(patch);
  if (patchCreated) {
    writeFileSync(patch, Buffer.from(PROFILE_PATCH_TEMPLATE_BASE64, "base64"));
  }

  return { profile, dir, bridgeFiles: Object.keys(BRIDGE_FILES).length, patchCreated };
}
