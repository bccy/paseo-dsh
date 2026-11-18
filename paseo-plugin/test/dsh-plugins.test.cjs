/**
 * Regression tests for the DSH Plugins page's server half.
 *
 * `harness/plugins-lock-check.cjs` covers the six happy/refusal paths of the
 * profile lock. This file covers the three rules that the review round
 * (upstream e320298) added and that no UI can show:
 *
 *   1. **Release only what you still hold.** This page's holder can be killed
 *      mid-write (SIGKILL is the only way a stale `package.json.lock` appears:
 *      a normal `dsh plugin` run releases it in `finally`); DSH then reclaims
 *      the dead holder's lock. An unconditional unlink in `finally` would
 *      delete the *new* owner's lock and let two writers into the manifest.
 *      Assert: when the lock record changed
 *      under us, the file survives the write.
 *   2. **A live foreign holder times out.** A lock whose pid still exists is
 *      waited for, and the wait has a deadline that reports `lock-timeout` —
 *      never a silent success or an unlink of someone else's lock.
 *   3. **First install on a profile with no package.json.** `dsh plugin`
 *      initializes the profile itself, so the absence of the manifest is a valid
 *      pre-install state; an existing but unparsable manifest still fails loudly.
 *   4. **Failure codes cross the RPC boundary intact.** A `ManagerError` keeps
 *      its code (the page owns the words); any other throw degrades to
 *      `command-failed` with its raw detail, never to a success.
 *
 * Runs against the compiled plugin (same compile-and-reuse helper as the other
 * plugin harnesses; `.dbg-plugins-test` is this task's private build tree):
 *
 *   node --test paseo-plugin/test/dsh-plugins.test.cjs
 *
 * Every test writes only inside a private `mkdtemp` directory and never starts
 * a `dsh` process, so a real `$DSH_HOME` profile is untouched.
 */
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { resolvePluginBuild } = require("../../harness/plugin-build.cjs");

const compiled = resolvePluginBuild(undefined, ".dbg-plugins-test");
const {
  DshPlugins,
  ManagerError,
  failureOf,
  readProfileManifestIfPresent,
  withPackageLock,
} = require(path.join(compiled, "server/dsh-plugins.js"));

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-plugins-test-"));
  return {
    root,
    dir: path.join(root, "profile"),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeManifest(dir, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function writeLock(dir, pid) {
  fs.writeFileSync(path.join(dir, "package.json.lock"), `${pid}\n`);
}

function readLock(dir) {
  return fs.readFileSync(path.join(dir, "package.json.lock"), "utf8");
}

function lockExists(dir) {
  return fs.existsSync(path.join(dir, "package.json.lock"));
}

test("releases the profile lock when this process still holds it", async () => {
  const space = scratch();
  try {
    fs.mkdirSync(space.dir, { recursive: true });
    const result = await withPackageLock(space.dir, () => "written");
    assert.equal(result, "written");
    assert.equal(lockExists(space.dir), false);
  } finally {
    space.cleanup();
  }
});

test("leaves a lock alone when its record was taken over by another process", async () => {
  const space = scratch();
  const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    stdio: "ignore",
  });
  try {
    fs.mkdirSync(space.dir, { recursive: true });
    await withPackageLock(space.dir, () => {
      // Stands in for DSH reclaiming a dead holder's lock while our write was
      // in flight: by the time `finally` runs, the lock belongs to that pid.
      writeLock(space.dir, foreign.pid);
    });
    assert.equal(lockExists(space.dir), true, "the new owner's lock must survive our release");
    assert.equal(readLock(space.dir), `${foreign.pid}\n`);
  } finally {
    foreign.kill("SIGKILL");
    space.cleanup();
  }
});

test("waits for a live foreign holder and reports lock-timeout", async () => {
  const space = scratch();
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    stdio: "ignore",
  });
  try {
    fs.mkdirSync(space.dir, { recursive: true });
    writeLock(space.dir, holder.pid);
    let ran = false;
    await assert.rejects(
      withPackageLock(space.dir, () => {
        ran = true;
      }, 400),
      /lock-timeout/,
    );
    assert.equal(ran, false, "the action must not run while another process holds the lock");
    assert.equal(lockExists(space.dir), true, "a foreign lock must not be removed");
    assert.equal(readLock(space.dir), `${holder.pid}\n`);
  } finally {
    holder.kill("SIGKILL");
    space.cleanup();
  }
});

test("a missing profile manifest is the pre-install state, not an error", () => {
  const space = scratch();
  try {
    fs.mkdirSync(space.dir, { recursive: true });
    assert.equal(readProfileManifestIfPresent(space.dir), undefined);
  } finally {
    space.cleanup();
  }
});

test("an existing but corrupt profile manifest fails loudly", () => {
  const space = scratch();
  try {
    fs.mkdirSync(space.dir, { recursive: true });
    fs.writeFileSync(path.join(space.dir, "package.json"), "{\n");
    assert.throws(() => readProfileManifestIfPresent(space.dir), /profile-invalid/);
  } finally {
    space.cleanup();
  }
});

test("setEnabled keeps the ordered bundle list and releases the lock", async () => {
  const space = scratch();
  try {
    const bundle = "@example/dsh-demo";
    writeManifest(space.dir, {
      name: "paseo-profile",
      dependencies: { [bundle]: "1.0.0" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-paseo-bridge"] } },
    });
    const packageDir = path.join(space.dir, "node_modules", ...bundle.split("/"));
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name: bundle, version: "1.0.0", dsh: { bundle: {} } })}\n`,
    );
    const plugins = new DshPlugins({ dir: space.dir, profile: "paseo", dshHome: space.root });

    assert.deepEqual(await plugins.setEnabled(bundle, true), {
      ok: true,
      changed: true,
      enabled: true,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(space.dir, "package.json"), "utf8"));
    assert.deepEqual(manifest.dsh.profile.bundles, [
      "@deepseek-ai/dsh-base",
      "dsh-paseo-bridge",
      bundle,
    ]);
    assert.equal(lockExists(space.dir), false);
  } finally {
    space.cleanup();
  }
});

test("failureOf keeps a manager code and degrades an unknown throw to command-failed", () => {
  const coded = failureOf(new ManagerError("protected", "dsh-paseo-bridge"));
  assert.deepEqual(coded, { errorCode: "protected", errorDetail: "dsh-paseo-bridge" });

  const bare = failureOf(new Error("spawn EACCES"));
  assert.equal(bare.errorCode, "command-failed");
  assert.equal(bare.errorDetail, "spawn EACCES");

  const noDetail = failureOf(new ManagerError("busy"));
  assert.deepEqual(noDetail, { errorCode: "busy" });
});