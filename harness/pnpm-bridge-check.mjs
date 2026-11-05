/**
 * A real `dsh plugin` command must not be able to take the bridge away.
 *
 * `dsh plugin --profile <name> add|remove|install` forwards its arguments to
 * pnpm in the profile directory, and the profile's `pnpm-workspace.yaml`
 * selects `nodeLinker: hoisted`. Under that linker pnpm 12 moves every
 * directory in `node_modules` that its previous install did not record into
 * `node_modules/.ignored/` (pnpm CHANGELOG, issue #13676). The bridge is written
 * by the plugin, never installed by pnpm, so while it lived in the profile's
 * `node_modules` the first plugin command after a daemon start parked it in
 * `.ignored`; DSH then printed `skipping profile bundle "dsh-paseo-bridge"` and
 * the profile ran without a bridge until the next daemon restart. The live
 * profile had 18 parked copies.
 *
 * This check drives the failure end to end, in a throwaway DSH home:
 *
 *   1. `ensurePaseoProfile()` provisions the profile and the bridge;
 *   2. the real `dsh --profile <name> --dump-config` composes the bridge layer
 *      (an independent oracle: DSH's own resolution, not the plugin's path);
 *   3. the real `dsh plugin --profile <name> add file:<local package>` runs
 *      pnpm exactly the way a user's command does;
 *   4. after it, DSH still composes the bridge and pnpm parked no copy of it;
 *   5. a second command (`dsh plugin install`) changes nothing about that;
 *   6. a pre-fix install shape — bridge in the profile's own node_modules plus
 *      `.ignored/` copies — is migrated by the next provisioning run.
 *
 * Why `file:` and not a registry package: the check must stay offline. A local
 * package is enough to make pnpm run a real install, which is the only thing
 * this check needs from it.
 *
 * Before the fix this script fails at step 4 (and at step 2's placement
 * assertion): the bridge is under `<profile>/node_modules`, pnpm moves it, and
 * DSH prints the skipping warning.
 *
 * Requires a real `dsh` (PATH or DSH_BINARY) and pnpm on PATH — DSH forwards
 * `plugin` to it and prints "dsh: pnpm was not found" otherwise. The DSH home is
 * a fresh `mkdtemp()`; the live `~/.dsh` is never read or written.
 *
 * Run:
 *   node harness/pnpm-bridge-check.mjs
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolvePluginBuild } = require("./plugin-build.cjs");

const PROFILE = "paseo";
const BINARY = process.env.DSH_BINARY ?? "dsh";
const buildDir = resolvePluginBuild(undefined, ".dbg-pnpm-bridge");
const bootstrap = require(join(buildDir, "server", "bootstrap.js"));
const { BRIDGE_FILES } = require(join(buildDir, "server", "bridge-assets.js"));

const dshHome = mkdtempSync(join(tmpdir(), "dsh-pnpm-bridge-check-"));
process.env.DSH_HOME = dshHome;
process.env.DSH_PASEO_PROFILE = PROFILE;
process.on("exit", () => {
  try {
    rmSync(dshHome, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const profileDir = join(dshHome, "profiles", PROFILE);
const sharedModulesDir = join(dshHome, "profiles", "node_modules");
const bridgeDir = join(sharedModulesDir, "dsh-paseo-bridge");
const legacyBridgeDir = join(profileDir, "node_modules", "dsh-paseo-bridge");
const legacyIgnoredDir = join(profileDir, "node_modules", ".ignored");

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition === true) {
    passed += 1;
    console.log(`  PASS  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  }
}

/** Run the real DSH CLI with this check's throwaway home. */
function dsh(args) {
  const result = spawnSync(BINARY, args, {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: dshHome },
    timeout: 180_000,
  });
  if (result.error !== undefined) {
    throw new Error(`could not run ${JSON.stringify(BINARY)}: ${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** DSH's own composition of the profile: the oracle for "is the bridge loaded". */
function composeProfile() {
  const result = dsh(["--profile", PROFILE, "--dump-config"]);
  return {
    ...result,
    // DSH prints this warning once per start when a listed bundle cannot be
    // resolved; it is the exact symptom this check exists for.
    skipsBridge: result.stderr.includes('skipping profile bundle "dsh-paseo-bridge"'),
    // The bridge layer inserts this row; `name: dsh-paseo-bridge` is the plugin
    // row itself (see dsh-bridge/cordis.patch.yml).
    composed: result.stdout.includes("name: dsh-paseo-bridge") && result.stdout.includes("- id: paseo-bridge"),
  };
}

/** Every embedded bridge file on disk under `dir`, byte-for-byte. */
function bridgeMatches(dir) {
  for (const [relativePath, encoded] of Object.entries(BRIDGE_FILES)) {
    const target = join(dir, relativePath);
    if (!existsSync(target)) return `missing ${relativePath}`;
    const expected = Buffer.from(encoded, "base64");
    const actual = readFileSync(target);
    if (actual.length !== expected.length || !actual.equals(expected)) {
      return `content mismatch in ${relativePath} (${String(actual.length)} of ${String(expected.length)} bytes)`;
    }
  }
  return true;
}

/** Names pnpm parked in `.ignored/` for this bridge (`dsh-paseo-bridge`, `…_1`, …). */
function parkedBridgeCopies() {
  try {
    return readdirSync(legacyIgnoredDir).filter((name) => /^dsh-paseo-bridge(?:_\d+)?$/.test(name));
  } catch {
    return [];
  }
}

const fixtureDir = join(dshHome, "fixture-pkg");
mkdirSync(fixtureDir, { recursive: true });
writeFileSync(
  join(fixtureDir, "package.json"),
  `${JSON.stringify(
    { name: "dsh-pnpm-bridge-fixture", version: "1.0.0", description: "harmless local package", main: "index.js" },
    null,
    2,
  )}\n`,
);
writeFileSync(join(fixtureDir, "index.js"), "module.exports = {};\n");

console.log(`DSH home: throwaway mkdtemp (never ~/.dsh) — ${dshHome}`);
console.log(`dsh: ${BINARY}   profile: ${PROFILE}`);

console.log("\npnpm-bridge: provisioning puts the bridge where pnpm does not manage");
{
  const provisioned = bootstrap.ensurePaseoProfile();
  check(
    "the bridge is provisioned at the shared anchor beside the profiles",
    provisioned.bridgeDir === bridgeDir && existsSync(join(bridgeDir, "package.json")),
    provisioned.bridgeDir,
  );
  check("every embedded bridge file is on disk byte-identical", bridgeMatches(bridgeDir) === true, String(bridgeMatches(bridgeDir)));
  check(
    "nothing is provisioned inside the profile's pnpm-managed node_modules",
    !existsSync(legacyBridgeDir),
    legacyBridgeDir,
  );
  const composed = composeProfile();
  check("DSH composes the profile", composed.status === 0 && composed.stdout !== "", `exit ${String(composed.status)}`);
  check("DSH does not skip the bridge bundle", composed.skipsBridge === false, composed.stderr.trim());
  check("DSH's composition carries the bridge layer", composed.composed === true, composed.stderr.trim() || "(no stderr)");
}

console.log("\npnpm-bridge: a real `dsh plugin add` leaves the bridge resolvable");
{
  const added = dsh(["plugin", "--profile", PROFILE, "add", `file:${fixtureDir}`]);
  check(
    "`dsh plugin add file:<local package>` succeeds",
    added.status === 0,
    added.output.trim().split("\n").slice(-3).join(" | ") || `exit ${String(added.status)}`,
  );
  const parked = parkedBridgeCopies();
  check("pnpm parked no copy of the bridge in node_modules/.ignored", parked.length === 0, parked.join(", "));
  check("the shared bridge is untouched", bridgeMatches(bridgeDir) === true, String(bridgeMatches(bridgeDir)));
  const composed = composeProfile();
  check("DSH still does not skip the bridge bundle", composed.skipsBridge === false, composed.stderr.trim());
  check(
    "DSH's composition still carries the bridge layer",
    composed.composed === true,
    composed.stderr.trim() || "(no stderr)",
  );
}

console.log("\npnpm-bridge: a second pnpm command changes nothing");
{
  const installed = dsh(["plugin", "--profile", PROFILE, "install"]);
  check("`dsh plugin install` succeeds", installed.status === 0, installed.output.trim().split("\n").slice(-2).join(" | "));
  check("still no parked bridge copy", parkedBridgeCopies().length === 0, parkedBridgeCopies().join(", "));
  check("the shared bridge is still byte-identical", bridgeMatches(bridgeDir) === true, String(bridgeMatches(bridgeDir)));
  const composed = composeProfile();
  check(
    "DSH still composes the bridge layer",
    composed.skipsBridge === false && composed.composed === true,
    composed.stderr.trim() || "(no stderr)",
  );
}

console.log("\npnpm-bridge: a pre-fix install shape is migrated by the next provisioning run");
{
  // What a user upgrading from the old plugin has on disk: the bridge in the
  // profile's own node_modules (a real directory here; install.sh's symlink is
  // the same shape for the resolution order) plus pnpm's parked copies.
  mkdirSync(legacyBridgeDir, { recursive: true });
  writeFileSync(join(legacyBridgeDir, "stale-marker.txt"), "STALE");
  for (const name of ["dsh-paseo-bridge", "dsh-paseo-bridge_1", "dsh-paseo-bridge_18"]) {
    mkdirSync(join(legacyIgnoredDir, name), { recursive: true });
    writeFileSync(join(legacyIgnoredDir, name, "marker.txt"), "STALE");
  }
  // A different package's parked copy is not ours to delete.
  mkdirSync(join(legacyIgnoredDir, "some-other-plugin"), { recursive: true });

  const migrated = bootstrap.ensurePaseoProfile();
  check(
    "the legacy profile-local bridge is retired",
    !existsSync(legacyBridgeDir),
    legacyBridgeDir,
  );
  check(
    "the parked copies of this bridge are cleaned up",
    parkedBridgeCopies().length === 0,
    parkedBridgeCopies().join(", "),
  );
  check(
    "another package's parked copy is left alone",
    existsSync(join(legacyIgnoredDir, "some-other-plugin")),
  );
  check("the migration republishes a complete bridge", migrated.bridgeDir === bridgeDir && bridgeMatches(bridgeDir) === true);
  const composed = composeProfile();
  check(
    "DSH composes the bridge layer after the migration",
    composed.skipsBridge === false && composed.composed === true,
    composed.stderr.trim() || "(no stderr)",
  );
}

console.log(`\n${String(passed)} passed, ${String(failed)} failed`);
if (failed > 0) process.exit(1);
