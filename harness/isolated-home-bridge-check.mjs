/**
 * A throwaway clone must carry the bridge the plugin provisions beside the profiles.
 *
 * `harness/isolated-dsh-home.cjs` clones `$DSH_HOME_SOURCE/profiles/<name>` for
 * the real-profile scripts. Since `paseo-plugin/server/bootstrap.ts` moved the
 * bridge out of the profile's pnpm-managed `node_modules` into the shared anchor
 * `$DSH_HOME/profiles/node_modules/dsh-paseo-bridge` (pnpm 12 moved it into
 * `.ignored` on every `dsh plugin` command), a profile-only clone no longer has a
 * bridge at all. The scripts that start `dsh --profile` on the clone without
 * running bootstrap first (`route-test`, `stream-probe`, `tools`, `catalog`,
 * `probe`, `rewind-e2e`, `rewind-merge-e2e`) then boot a profile DSH composes
 * without the bridge layer: it only prints `skipping profile bundle
 * "dsh-paseo-bridge"` and carries on. Every turn would fail later with a much
 * less obvious error, so this must be a red check, not a silent degradation.
 *
 * What is pinned here (real `dsh` on PATH or DSH_BINARY; no pnpm, no model):
 *   1. a source home whose bridge lives only at the shared anchor (the migrated
 *      shape) clones into a home that carries it;
 *   2. the copy is a real directory, not a symlink — a symlink would let the
 *      clone's `dsh` write into the user's live home;
 *   3. the cloned home composes the bridge layer (`dsh --profile <p> --dump-config`,
 *      no skipping warning) — the actual thing the real-profile scripts need;
 *   4. a source home with the bridge only in the profile's own `node_modules`
 *      (pre-migration shape) still clones into a working home (the copy is a
 *      no-op there);
 *   5. a source home with no bridge anywhere does not get one invented.
 *
 * Before the helper copied the shared anchor this script fails at 1-3: the clone
 * has no bridge and DSH prints the skipping warning.
 *
 * Run:
 *   node harness/isolated-home-bridge-check.mjs
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { prepareDshHome } = require("./isolated-dsh-home.cjs");

const BRIDGE_NAME = "dsh-paseo-bridge";
const BRIDGE_SOURCE = join(here, "..", "dsh-bridge");
const BINARY = process.env.DSH_BINARY ?? "dsh";
const PROFILE = "paseo";

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

/** A source `$DSH_HOME` shaped like the real one, with the bridge where asked. */
function makeSourceHome({ sharedBridge = false, profileBridge = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dsh-isolated-src-"));
  const profileDir = join(home, "profiles", PROFILE);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, "package.json"),
    `${JSON.stringify(
      {
        name: `dsh-profile-${PROFILE}`,
        private: true,
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", BRIDGE_NAME] } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(profileDir, "cordis.yml"), "[]\n");
  writeFileSync(join(profileDir, "cordis.patch.yml"), "[]\n");
  if (sharedBridge) {
    cpSync(BRIDGE_SOURCE, join(home, "profiles", "node_modules", BRIDGE_NAME), { recursive: true });
  }
  if (profileBridge) {
    cpSync(BRIDGE_SOURCE, join(profileDir, "node_modules", BRIDGE_NAME), { recursive: true });
  }
  return home;
}

/** Clone one source home through the shared helper; the caller owns cleanup. */
function clone(source) {
  return prepareDshHome({
    script: "isolated-home-bridge-check",
    profile: PROFILE,
    argv: [],
    env: { DSH_HOME_SOURCE: source },
  });
}

/** DSH's own composition of the cloned profile: the oracle for "bridge loaded". */
function compose(home) {
  const result = spawnSync(BINARY, ["--profile", PROFILE, "--dump-config"], {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: home },
    timeout: 180_000,
  });
  if (result.error !== undefined) {
    throw new Error(`could not run ${JSON.stringify(BINARY)}: ${result.error.message}`);
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status,
    skipsBridge: stderr.includes('skipping profile bundle "dsh-paseo-bridge"'),
    // `# == <bundle>` marks the bundle's own inserted rows; `patched by` marks
    // its patch entries applied to base rows. Either proves the layer composed.
    hasBridgeLayer: stdout.includes("# == dsh-paseo-bridge") || stdout.includes("patched by dsh-paseo-bridge"),
    stderr,
  };
}

const removeTree = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp tree is not a test failure */
  }
};

console.log("isolated-home-bridge: a migrated source home clones into a working home");
{
  const source = makeSourceHome({ sharedBridge: true });
  const cloned = clone(source);
  try {
    check(
      "the clone is a throwaway home, not the source",
      cloned.mode === "isolated" && cloned.home !== source,
      `${cloned.mode}: ${cloned.home}`,
    );
    const cloneBridge = join(cloned.home, "profiles", "node_modules", BRIDGE_NAME);
    check(
      "the clone carries the bridge from the shared anchor",
      existsSync(join(cloneBridge, "package.json")),
      cloneBridge,
    );
    check(
      "…as a real copy, not a symlink (a link would write back into the live home)",
      existsSync(cloneBridge) && lstatSync(cloneBridge).isSymbolicLink() === false,
      existsSync(cloneBridge) ? `symlink=${String(lstatSync(cloneBridge).isSymbolicLink())}` : "missing",
    );
    const composed = compose(cloned.home);
    check("DSH composes the cloned profile", composed.status === 0, `exit ${String(composed.status)}`);
    check(
      "DSH does not skip the bridge bundle in the clone",
      composed.skipsBridge === false,
      composed.stderr.trim(),
    );
    check("the cloned composition carries the bridge layer", composed.hasBridgeLayer === true);

    // Prove the copy is independent: a write in the clone must not reach the
    // source. A symlinked bridge would make this check — and the isolation the
    // helper promises — false. Without a bridge in the clone the two assertions
    // above already failed; the probe then reports that instead of crashing, so
    // the red run lands on assertions rather than a stack trace.
    const marker = "isolated-home-bridge-marker";
    let wroteBack = false;
    try {
      writeFileSync(join(cloneBridge, "write-back-probe.txt"), `${marker}\n`);
      wroteBack = true;
    } catch {
      /* no bridge in the clone */
    }
    check(
      "writing into the cloned bridge does not reach the source home",
      wroteBack && !existsSync(join(source, "profiles", "node_modules", BRIDGE_NAME, "write-back-probe.txt")),
      wroteBack ? undefined : "the clone has no bridge to write into (see above)",
    );
    check(
      "…and the source bridge is still the unmodified checkout copy",
      readFileSync(join(source, "profiles", "node_modules", BRIDGE_NAME, "package.json"), "utf8").includes(BRIDGE_NAME),
    );
  } finally {
    cloned.cleanup();
    removeTree(source);
  }
}

console.log("\nisolated-home-bridge: a pre-migration source home still clones into a working home");
{
  // The bridge in the profile's own node_modules: what every home has until the
  // new plugin loads. The shared-anchor copy is a no-op here; the cloned profile
  // already carries the bridge inside it.
  const source = makeSourceHome({ profileBridge: true });
  const cloned = clone(source);
  try {
    const composed = compose(cloned.home);
    check(
      "a profile-local bridge is still cloned and composed",
      composed.status === 0 && composed.skipsBridge === false && composed.hasBridgeLayer === true,
      composed.stderr.trim() || `exit ${String(composed.status)}`,
    );
    check(
      "the helper does not add a shared-anchor copy the source did not have",
      !existsSync(join(cloned.home, "profiles", "node_modules", BRIDGE_NAME)),
    );
  } finally {
    cloned.cleanup();
    removeTree(source);
  }
}

console.log("\nisolated-home-bridge: a source home without a bridge gets none invented");
{
  const source = makeSourceHome();
  const cloned = clone(source);
  try {
    check(
      "no bridge is invented for a home that has none",
      !existsSync(join(cloned.home, "profiles", "node_modules", BRIDGE_NAME)),
      join(cloned.home, "profiles", "node_modules", BRIDGE_NAME),
    );
    check("the clone is still usable as a throwaway home", cloned.mode === "isolated" && existsSync(cloned.home));
  } finally {
    cloned.cleanup();
    removeTree(source);
  }
}

console.log(`\n${String(passed)} passed, ${String(failed)} failed`);
if (failed > 0) process.exit(1);
