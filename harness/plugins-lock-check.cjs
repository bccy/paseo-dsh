/**
 * Minimal check for the profile package.json lock used by the DSH Plugins page.
 *
 * The page's only direct write is `dsh.profile.bundles` (enable/disable), done
 * under the lock DSH itself uses: `<profile>/package.json.lock`, a `wx`-created
 * sibling holding `` `${pid}\n` `` (verified against DSH 0.2.2-rc.3,
 * `@deepseek-ai/dsh-atomic-write`). The lock is invisible in the UI, and every
 * failure mode here is a silently corrupted profile rather than an error
 * message, so each rule gets an assertion:
 *
 *   1. a successful enable writes the ordered bundle list and releases the lock
 *   2. enabling twice is idempotent (`changed: false`, still no lock left over)
 *   3. two concurrent changes serialize: exactly one observes a change
 *   4. a stale lock from a dead pid is reclaimed, then released (a killed
 *      holder is the only way one appears in practice; a normal `dsh plugin`
 *      run releases it in `finally`)
 *   5. a protected bundle refuses without writing or leaking the lock
 *   6. a corrupt manifest refuses without rewriting it and without leaking the lock
 *
 * Everything runs in a fresh `mkdtemp` directory with an explicit `dir`, so no
 * real `$DSH_HOME` profile is read or written, and no `dsh` process starts.
 *
 * The plugin is TypeScript; this script uses the same compile-and-reuse helper
 * the other plugin harnesses do (`.dbg-plugins-lock` is this task's private
 * build tree):
 *
 *   node harness/plugins-lock-check.cjs
 *
 * Prints `PLUGINS_LOCK_OK` on success.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolvePluginBuild } = require("./plugin-build.cjs");

const compiled = resolvePluginBuild(process.argv[2], ".dbg-plugins-lock");
const { DshPlugins } = require(path.join(compiled, "server/dsh-plugins.js"));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-plugins-lock-"));
const profileDir = path.join(root, "profile");
const manifestPath = path.join(profileDir, "package.json");
const lockPath = path.join(profileDir, "package.json.lock");
const bundleName = "@example/dsh-demo";

function writeManifest(value) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
}

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function bundles() {
  return readManifest().dsh?.profile?.bundles ?? [];
}

function installBundle() {
  const dir = path.join(profileDir, "node_modules", ...bundleName.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({
      name: bundleName,
      version: "1.0.0",
      dsh: { bundle: {} },
    }, null, 2)}\n`,
  );
}

async function main() {
  fs.mkdirSync(profileDir, { recursive: true });
  writeManifest({
    name: "paseo-profile",
    dependencies: { [bundleName]: "1.0.0" },
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "dsh-paseo-bridge"],
      },
    },
  });
  installBundle();

  // `installAnchor: null` keeps this lock-only check from reading the real
  // global dsh installation; nothing here resolves a bundle.
  const plugins = new DshPlugins({
    dir: profileDir,
    profile: "paseo",
    dshHome: root,
    installAnchor: null,
  });

  const enabled = await plugins.setEnabled(bundleName, true);
  assert.deepEqual(enabled, { ok: true, changed: true, enabled: true });
  assert.deepEqual(bundles(), ["@deepseek-ai/dsh-base", "dsh-paseo-bridge", bundleName]);
  assert.equal(fs.existsSync(lockPath), false, "successful write must release the lock");

  const idempotent = await plugins.setEnabled(bundleName, true);
  assert.deepEqual(idempotent, { ok: true, changed: false, enabled: true });

  // Two concurrent changes must serialize: exactly one observes a change.
  const concurrent = await Promise.all([
    plugins.setEnabled(bundleName, false),
    plugins.setEnabled(bundleName, false),
  ]);
  assert.equal(concurrent.filter((result) => result.changed).length, 1);
  assert.deepEqual(bundles(), ["@deepseek-ai/dsh-base", "dsh-paseo-bridge"]);
  assert.equal(fs.existsSync(lockPath), false, "serialized writes must release the lock");

  // A stale lock from a dead process must be reclaimed. It is what a holder
  // killed mid-operation leaves behind (normal runs release in `finally`).
  fs.writeFileSync(lockPath, "99999999\n");
  const reclaimed = await plugins.setEnabled(bundleName, true);
  assert.deepEqual(reclaimed, { ok: true, changed: true, enabled: true });
  assert.equal(fs.existsSync(lockPath), false, "stale lock must be removed");

  const protectedResult = plugins.setEnabled("@deepseek-ai/dsh-base", false);
  await assert.rejects(protectedResult, /protected/);
  assert.equal(fs.existsSync(lockPath), false, "rejected write must release the lock");

  // A corrupt manifest must fail without rewriting it, and without leaking the lock.
  fs.writeFileSync(manifestPath, "{\n");
  const before = fs.readFileSync(manifestPath, "utf8");
  await assert.rejects(plugins.setEnabled(bundleName, false), /profile-invalid/);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), before);
  assert.equal(fs.existsSync(lockPath), false, "failed parse must release the lock");

  fs.rmSync(root, { recursive: true, force: true });
  console.log("PLUGINS_LOCK_OK");
}

main().catch((error) => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});