/**
 * Bootstrap bridge provisioning: verify-before-switch, and an honest failure log.
 *
 * `ensurePaseoProfile()` rewrites `$DSH_HOME/profiles/<name>/node_modules/
 * dsh-paseo-bridge` on every plugin load. The old implementation deleted the
 * live bridge and then wrote the files one by one, so a disk failure left a
 * half bridge that every session failed to start from — until the next plugin
 * load happened to succeed. It also wrote `profile ready` after catching the
 * provisioning error, which made the broken install look healthy.
 *
 * What is pinned here, all through the compiled real modules:
 *   1. a fresh provision writes every embedded bridge file byte-for-byte;
 *   2. an upgrade replaces the previous generation (no stale marker survives);
 *   3. a write failure during staging throws **and leaves the old generation
 *      intact**, with no staging/previous directory leaked;
 *   4. a short write is detected by the post-write size/hash verification
 *      (writeFileSync returning is not proof the bytes are on disk);
 *   5. `index.server.js` does not print `profile ... ready` when provisioning
 *      throws, and still registers the provider (the documented best-effort
 *      availability choice);
 *   6. the success path still says the profile is ready.
 *
 * The fault injection patches `node:fs.writeFileSync` on the module object the
 * compiled bootstrap reads at call time — no production test hook is added.
 *
 * Run:
 *   node harness/bootstrap-check.mjs [compiled-plugin-dir]
 *
 * (compiles into `paseo-plugin/.dbg-p5b-bootstrap` unless a build directory is
 * passed; uses a throwaway DSH_HOME, never the real profile)
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolvePluginBuild } = require("./plugin-build.cjs");

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-p5b-bootstrap");
const bootstrap = require(join(buildDir, "server", "bootstrap.js"));
const { BRIDGE_FILES } = require(join(buildDir, "server", "bridge-assets.js"));
const nodeFs = require("node:fs");

const dshHome = mkdtempSync(join(tmpdir(), "dsh-bootstrap-check-"));
const savedHome = process.env.DSH_HOME;
process.env.DSH_HOME = dshHome;
process.on("exit", () => {
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  try {
    rmSync(dshHome, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

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

const expected = new Map(
  Object.entries(BRIDGE_FILES).map(([relativePath, encoded]) => [relativePath, Buffer.from(encoded, "base64")]),
);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const profileDir = join(dshHome, "profiles", "paseo");
const bridgeDir = join(profileDir, "node_modules", "dsh-paseo-bridge");
const nodeModulesDir = join(profileDir, "node_modules");
const stagingLeftovers = () =>
  existsSync(nodeModulesDir)
    ? readdirSync(nodeModulesDir).filter((name) => name.startsWith(".dsh-paseo-bridge."))
    : [];

/** Compare the published bridge directory with the embedded asset, byte-for-byte. */
function bridgeMatches(expectedFiles) {
  for (const [relativePath, bytes] of expectedFiles) {
    const target = join(bridgeDir, relativePath);
    if (!existsSync(target)) return `missing ${relativePath}`;
    const actual = readFileSync(target);
    if (actual.length !== bytes.length || sha256(actual) !== sha256(bytes)) {
      return `content mismatch in ${relativePath} (${String(actual.length)} of ${String(bytes.length)} bytes)`;
    }
  }
  return true;
}

console.log("bootstrap: fresh provision and upgrade");
{
  const result = bootstrap.ensurePaseoProfile();
  check("a fresh profile is provisioned under DSH_HOME", result.profile === "paseo" && existsSync(profileDir), result.dir);
  check(
    "every embedded bridge file is written and byte-identical",
    bridgeMatches(expected) === true,
    String(bridgeMatches(expected)),
  );
  check("the bridge file count matches the asset", result.bridgeFiles === expected.size, `${String(result.bridgeFiles)}`);

  // Simulate an older generation with a marker the new copy must not keep.
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "old-generation-marker.txt"), "old");
  const upgraded = bootstrap.ensurePaseoProfile();
  check(
    "an upgrade replaces the previous generation",
    !existsSync(join(bridgeDir, "old-generation-marker.txt"))
      && bridgeMatches(expected) === true
      && upgraded.bridgeFiles === expected.size,
  );
  check("no staging/previous directories leak after a successful switch", stagingLeftovers().length === 0, stagingLeftovers().join(", "));
}

console.log("\nbootstrap: a failed write keeps the old generation");
{
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "old-generation-marker.txt"), "KEEP-OLD");
  const originalWrite = nodeFs.writeFileSync;
  let writes = 0;
  nodeFs.writeFileSync = function writeFileSyncFailing(path, data, ...rest) {
    writes += 1;
    if (writes === 2) throw new Error("injected disk failure");
    return originalWrite.call(this, path, data, ...rest);
  };
  let thrown;
  try {
    bootstrap.ensurePaseoProfile();
  } catch (error) {
    thrown = error;
  } finally {
    nodeFs.writeFileSync = originalWrite;
  }
  check("a staging write failure throws", thrown instanceof Error && /injected disk failure/.test(thrown.message), thrown?.message);
  check(
    "…the previous generation is still in place and untouched",
    existsSync(join(bridgeDir, "old-generation-marker.txt"))
      && readFileSync(join(bridgeDir, "old-generation-marker.txt"), "utf8") === "KEEP-OLD",
  );
  check("…and the failed staging directory is removed", stagingLeftovers().length === 0, stagingLeftovers().join(", "));
}

console.log("\nbootstrap: a short write is caught before it can be published");
{
  const originalWrite = nodeFs.writeFileSync;
  let writes = 0;
  nodeFs.writeFileSync = function writeFileSyncShort(path, data, ...rest) {
    writes += 1;
    if (writes === 1 && typeof path === "string" && path.includes(".dsh-paseo-bridge.staging-")) {
      return originalWrite.call(this, path, Buffer.from(data).subarray(0, 1), ...rest);
    }
    return originalWrite.call(this, path, data, ...rest);
  };
  let thrown;
  try {
    bootstrap.ensurePaseoProfile();
  } catch (error) {
    thrown = error;
  } finally {
    nodeFs.writeFileSync = originalWrite;
  }
  check(
    "a short bridge write is detected by the size/hash verification",
    thrown instanceof Error && /did not survive its write/.test(thrown.message),
    thrown?.message,
  );
  check(
    "…and the old generation remains live",
    existsSync(join(bridgeDir, "old-generation-marker.txt"))
      && readFileSync(join(bridgeDir, "old-generation-marker.txt"), "utf8") === "KEEP-OLD"
      && stagingLeftovers().length === 0,
  );
}

console.log("\nbootstrap: a provisioning failure never claims the profile is ready");
{
  const originalEnsure = bootstrap.ensurePaseoProfile;
  bootstrap.ensurePaseoProfile = () => {
    throw new Error("injected provisioning failure");
  };
  const stderr = [];
  const originalStderr = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    stderr.push(String(chunk));
    return originalStderr.call(process.stderr, chunk, ...rest);
  };
  let registered = false;
  const contribute = require(join(buildDir, "index.server.js")).default;
  try {
    contribute({
      handle() {},
      registerProvider() {
        registered = true;
      },
      registerSettings() {},
      on() {},
      before() {},
    });
  } finally {
    process.stderr.write = originalStderr;
    bootstrap.ensurePaseoProfile = originalEnsure;
  }
  const text = stderr.join("");
  check("the provider is still registered (best-effort availability)", registered);
  check("the failure log says the profile is NOT ready", /NOT ready/.test(text), text.trim());
  check("the failure log names the cause", /injected provisioning failure/.test(text), text.trim());
  check("the failure log never claims `profile ... ready`", !/profile\s+"[^"]*"\s+ready/.test(text), text.trim());
}

console.log("\nbootstrap: the success path still reports ready");
{
  const stderr = [];
  const originalStderr = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    stderr.push(String(chunk));
    return originalStderr.call(process.stderr, chunk, ...rest);
  };
  let registered = false;
  const contribute = require(join(buildDir, "index.server.js")).default;
  try {
    contribute({
      handle() {},
      registerProvider() {
        registered = true;
      },
      registerSettings() {},
      on() {},
      before() {},
    });
  } finally {
    process.stderr.write = originalStderr;
  }
  const text = stderr.join("");
  check("a successful provision reports the profile ready", /profile\s+"paseo"\s+ready/.test(text), text.trim());
  check("…and still registers the provider", registered);
}

console.log(`\n${String(passed)} passed, ${String(failed)} failed`);
if (failed > 0) process.exit(1);
