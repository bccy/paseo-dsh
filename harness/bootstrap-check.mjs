/**
 * Bootstrap bridge provisioning: verify-before-switch, and an honest failure log.
 *
 * `ensurePaseoProfile()` rewrites `$DSH_HOME/profiles/node_modules/
 * dsh-paseo-bridge` on every plugin load — the shared anchor beside the
 * profiles, not the profile's own `node_modules`, which belongs to pnpm and had
 * the bridge moved into `.ignored` on every `dsh plugin` command (the pnpm 12
 * hoisted-linker orphan cleanup; `harness/pnpm-bridge-check.mjs` pins the
 * pnpm-facing behaviour, this file pins the install/replace/migrate half). The old implementation deleted the
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
 *   6. the success path still says the profile is ready;
 *   7. a bridge left in the old profile-local `node_modules` (plus the copies
 *      pnpm parked in `.ignored/`) is retired, so DSH cannot resolve the stale
 *      copy instead of the generation just written.
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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const sharedModulesDir = join(dshHome, "profiles", "node_modules");
const bridgeDir = join(sharedModulesDir, "dsh-paseo-bridge");
/** Where plugin builds before the pnpm fix put the bridge (and pnpm moved it from). */
const legacyBridgeDir = join(profileDir, "node_modules", "dsh-paseo-bridge");
const legacyIgnoredDir = join(profileDir, "node_modules", ".ignored");
const stagingLeftovers = () =>
  existsSync(sharedModulesDir)
    ? readdirSync(sharedModulesDir).filter((name) => name.startsWith(".dsh-paseo-bridge."))
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
    "the bridge is published at the shared anchor, outside the profile's pnpm project",
    result.bridgeDir === bridgeDir && existsSync(join(bridgeDir, "package.json")),
    result.bridgeDir,
  );
  check(
    "nothing is left in the profile-local node_modules the plugin does not own",
    !existsSync(legacyBridgeDir),
    legacyBridgeDir,
  );
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

console.log("\nbootstrap: a legacy profile-local bridge is retired");
{
  // The shape a pre-fix install leaves behind: a real bridge directory (or the
  // symlink install.sh makes) in the profile's own node_modules, plus the copies
  // pnpm parked in .ignored/ on each `dsh plugin` command. DSH resolves the
  // profile's node_modules first, so leaving any of it in place would shadow the
  // shared generation — the migration has to remove it, not just add the new one.
  mkdirSync(legacyBridgeDir, { recursive: true });
  writeFileSync(join(legacyBridgeDir, "legacy-marker.txt"), "STALE");
  for (const name of ["dsh-paseo-bridge", "dsh-paseo-bridge_1", "dsh-paseo-bridge_17"]) {
    mkdirSync(join(legacyIgnoredDir, name), { recursive: true });
    writeFileSync(join(legacyIgnoredDir, name, "marker.txt"), "STALE");
  }
  // A neighbouring package's .ignored copy must survive: it is not ours to delete.
  mkdirSync(join(legacyIgnoredDir, "someone-elses-plugin"), { recursive: true });
  writeFileSync(join(legacyIgnoredDir, "someone-elses-plugin", "marker.txt"), "KEEP");
  // So must this bridge's own `.bak-*` directories: they are somebody's backups,
  // not the pnpm naming this cleanup owns (`dsh-paseo-bridge` / `_<n>`). One real
  // profile had seven of them. Without this fixture, widening the cleanup regex
  // to `(?:[._].*)?` deleted them and both migration checks still passed.
  const backupNames = ["dsh-paseo-bridge.bak-20261015", "dsh-paseo-bridge.bak-before-upgrade"];
  const backupContents = new Map();
  for (const name of backupNames) {
    const dir = join(legacyIgnoredDir, name);
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "dsh-paseo-bridge", backup: name })}\n`);
    writeFileSync(join(dir, "lib", "index.js"), `// backup ${name}\n`);
    backupContents.set(join(name, "package.json"), readFileSync(join(dir, "package.json")));
    backupContents.set(join(name, "lib", "index.js"), readFileSync(join(dir, "lib", "index.js")));
  }

  const migrated = bootstrap.ensurePaseoProfile();
  check(
    "the legacy profile-local bridge is gone, so DSH cannot resolve the stale copy",
    !existsSync(legacyBridgeDir),
    legacyBridgeDir,
  );
  check(
    "every .ignored copy of the bridge is cleaned up",
    !existsSync(join(legacyIgnoredDir, "dsh-paseo-bridge"))
      && !existsSync(join(legacyIgnoredDir, "dsh-paseo-bridge_1"))
      && !existsSync(join(legacyIgnoredDir, "dsh-paseo-bridge_17")),
    readdirSync(legacyIgnoredDir).join(", "),
  );
  check(
    "…but a neighbouring package's .ignored copy is left alone",
    existsSync(join(legacyIgnoredDir, "someone-elses-plugin", "marker.txt")),
  );
  const backupsIntact = [...backupContents].every(([relativePath, bytes]) => {
    const target = join(legacyIgnoredDir, relativePath);
    if (!existsSync(target)) return false;
    const actual = readFileSync(target);
    return actual.length === bytes.length && sha256(actual) === sha256(bytes);
  });
  check(
    "…and the bridge's own .bak-* backups are left alone, byte-for-byte",
    backupsIntact,
    backupNames.join(", "),
  );
  check(
    "the shared generation is complete after the migration",
    migrated.bridgeDir === bridgeDir && bridgeMatches(expected) === true,
  );
  check(
    "the retirement left no parked generation behind",
    stagingLeftovers().length === 0,
    stagingLeftovers().join(", "),
  );

  // install.sh links the checkout into that spot. The migration must remove the
  // link itself, not follow it: the checkout is the developer's tree, and a
  // recursive delete through the symlink would empty it.
  const checkoutStub = join(dshHome, "checkout-stub");
  mkdirSync(checkoutStub, { recursive: true });
  writeFileSync(join(checkoutStub, "package.json"), "{}");
  symlinkSync(checkoutStub, legacyBridgeDir, "dir");
  const afterSymlink = bootstrap.ensurePaseoProfile();
  const legacyExists = (() => {
    try {
      lstatSync(legacyBridgeDir);
      return true;
    } catch {
      return false;
    }
  })();
  check("a legacy symlink in the profile's node_modules is removed", legacyExists === false);
  check(
    "…and the checkout it pointed at is untouched",
    existsSync(join(checkoutStub, "package.json")),
  );
  check("…and the shared bridge is still the one this build writes", afterSymlink.bridgeDir === bridgeDir && bridgeMatches(expected) === true);
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
