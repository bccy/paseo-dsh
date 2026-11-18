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
const {
  jobStatusSchema,
  startJobInputSchema,
} = require(path.join(compiled, "shared/dsh-plugins-api.js"));

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
    // `installAnchor: null`: this test is about the lock, and must not read the
    // real global dsh installation for a package it never resolves.
    const plugins = new DshPlugins({
      dir: space.dir,
      profile: "paseo",
      dshHome: space.root,
      installAnchor: null,
    });

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

/**
 * Bundle resolution fixtures.
 *
 * The real profile resolves a selected bundle from three places, in DSH's own
 * order (`@deepseek-ai/dsh-app-boot`'s `resolveBundleDir`: the dsh installation
 * anchor first, then `<profile>/package.json`, whose Node lookup walks
 * `<profile>/node_modules` -> `~/.dsh/profiles/node_modules` -> ...):
 *
 *   1. the profile's own `node_modules/` (pnpm-installed dependencies),
 *   2. the shared `$DSH_HOME/profiles/node_modules/` anchor (the bridge),
 *   3. the dsh installation's `node_modules/` (in-box `@deepseek-ai/*` bundles).
 *
 * A package found in none of them is the only case that may read "missing".
 * These fixtures build one home with all three layouts plus one truly absent
 * package, and assert the page's view of each.
 */
function dshHomeLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-plugins-resolve-"));
  const profileDir = path.join(root, "profiles", "paseo");
  const installDir = path.join(root, "install", "node_modules", "@deepseek-ai", "dsh");
  const installAnchor = path.join(installDir, "package.json");
  const layout = {
    root,
    profileDir,
    installDir,
    installAnchor,
    profilePackage(name) {
      return path.join(profileDir, "node_modules", ...name.split("/"));
    },
    sharedPackage(name) {
      return path.join(root, "profiles", "node_modules", ...name.split("/"));
    },
    /** In-box bundles live under the installation package's own node_modules. */
    installedPackage(name) {
      return path.join(installDir, "node_modules", ...name.split("/"));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  fs.mkdirSync(profileDir, { recursive: true });
  writePackage(installDir, { name: "@deepseek-ai/dsh", version: "0.2.2-rc.3" });
  return layout;
}

function writePackage(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

const BASE = "@deepseek-ai/dsh-base";

/** A home whose dsh installation ships the base bundle, as every install does. */
function writeInstalledBase(layout) {
  writePackage(layout.installedPackage(BASE), {
    name: BASE,
    version: "0.2.2-rc.3",
    dsh: { bundle: { patch: "cordis.patch.yml" } },
  });
}

function bundleEntry(snapshot, name) {
  const entry = snapshot.bundles.find((bundle) => bundle.name === name);
  assert.ok(entry !== undefined, `expected a row for ${name}: ${JSON.stringify(snapshot.bundles.map((row) => row.name))}`);
  return entry;
}

test("resolves a bundle from the profile's own node_modules", async () => {
  const layout = dshHomeLayout();
  try {
    writeInstalledBase(layout);
    writeManifest(layout.profileDir, {
      name: "dsh-profile-paseo",
      dependencies: { "@example/profile-bundle": "1.0.0" },
      dsh: { profile: { bundles: [BASE, "@example/profile-bundle"] } },
    });
    writePackage(layout.profilePackage("@example/profile-bundle"), {
      name: "@example/profile-bundle",
      version: "1.0.0",
      dsh: { bundle: { patch: "cordis.patch.yml" } },
    });
    const plugins = new DshPlugins({
      dir: layout.profileDir,
      profile: "paseo",
      dshHome: layout.root,
      installAnchor: layout.installAnchor,
    });
    const row = bundleEntry(await plugins.list(), "@example/profile-bundle");
    assert.equal(row.installed, true);
    assert.equal(row.kind, "bundle");
    assert.equal(row.official, false);
    assert.equal(row.version, "1.0.0");
    assert.equal(row.removable, true);
    assert.equal(fs.existsSync(path.join(layout.profileDir, "package.json.lock")), false);
  } finally {
    layout.cleanup();
  }
});

test("resolves a bundle from the shared profiles node_modules anchor", async () => {
  const layout = dshHomeLayout();
  try {
    writeInstalledBase(layout);
    writeManifest(layout.profileDir, {
      name: "dsh-profile-paseo",
      dsh: { profile: { bundles: [BASE, "@example/shared-bundle"] } },
    });
    writePackage(layout.sharedPackage("@example/shared-bundle"), {
      name: "@example/shared-bundle",
      version: "2.3.4",
      dsh: { bundle: { patch: "cordis.patch.yml" } },
    });
    const plugins = new DshPlugins({
      dir: layout.profileDir,
      profile: "paseo",
      dshHome: layout.root,
      installAnchor: layout.installAnchor,
    });
    const row = bundleEntry(await plugins.list(), "@example/shared-bundle");
    assert.equal(row.installed, true);
    assert.equal(row.kind, "bundle");
    assert.equal(row.official, false);
    assert.equal(row.version, "2.3.4");
  } finally {
    layout.cleanup();
  }
});

test("an installation bundle is official, keeps its version, and is not removable or updatable", async () => {
  const layout = dshHomeLayout();
  try {
    writeInstalledBase(layout);
    writePackage(layout.installedPackage("@deepseek-ai/dsh-web-app"), {
      name: "@deepseek-ai/dsh-web-app",
      version: "0.2.2-rc.3",
      dsh: { bundle: { patch: "cordis.patch.yml" } },
    });
    writeManifest(layout.profileDir, {
      name: "dsh-profile-paseo",
      dsh: { profile: { bundles: [BASE, "@deepseek-ai/dsh-web-app"] } },
    });
    const plugins = new DshPlugins({
      dir: layout.profileDir,
      profile: "paseo",
      dshHome: layout.root,
      installAnchor: layout.installAnchor,
    });
    const snapshot = await plugins.list();
    const webApp = bundleEntry(snapshot, "@deepseek-ai/dsh-web-app");
    assert.equal(webApp.installed, true, "an installation-supplied bundle is not missing");
    assert.equal(webApp.official, true);
    assert.equal(webApp.kind, "bundle");
    assert.equal(webApp.version, "0.2.2-rc.3");
    assert.equal(webApp.removable, false, "official bundles follow the DSH installation");
    assert.equal(webApp.updatable, false);

    const base = bundleEntry(snapshot, BASE);
    assert.equal(base.official, true);
    assert.equal(base.installed, true);
    assert.equal(base.version, "0.2.2-rc.3");
  } finally {
    layout.cleanup();
  }
});

test("the installation's copy wins over a profile-local copy", async () => {
  const layout = dshHomeLayout();
  try {
    writeInstalledBase(layout);
    writePackage(layout.installedPackage("@deepseek-ai/dsh-web-app"), {
      name: "@deepseek-ai/dsh-web-app",
      version: "0.2.2-rc.3",
      dsh: { bundle: { patch: "cordis.patch.yml" } },
    });
    writeManifest(layout.profileDir, {
      name: "dsh-profile-paseo",
      dependencies: { "@deepseek-ai/dsh-web-app": "0.1.0" },
      dsh: { profile: { bundles: [BASE, "@deepseek-ai/dsh-web-app"] } },
    });
    writePackage(layout.profilePackage("@deepseek-ai/dsh-web-app"), {
      name: "@deepseek-ai/dsh-web-app",
      version: "0.1.0",
      dsh: { bundle: { patch: "cordis.patch.yml" } },
    });
    const plugins = new DshPlugins({
      dir: layout.profileDir,
      profile: "paseo",
      dshHome: layout.root,
      installAnchor: layout.installAnchor,
    });
    const row = bundleEntry(await plugins.list(), "@deepseek-ai/dsh-web-app");
    assert.equal(row.official, true, "the installation's copy is the one DSH loads");
    assert.equal(row.version, "0.2.2-rc.3");
  } finally {
    layout.cleanup();
  }
});

test("a package resolved from none of the three layouts still reads missing", async () => {
  const layout = dshHomeLayout();
  try {
    writeInstalledBase(layout);
    writeManifest(layout.profileDir, {
      name: "dsh-profile-paseo",
      dependencies: { "@example/absent-bundle": "1.0.0" },
      dsh: { profile: { bundles: [BASE, "@example/absent-bundle"] } },
    });
    const plugins = new DshPlugins({
      dir: layout.profileDir,
      profile: "paseo",
      dshHome: layout.root,
      installAnchor: layout.installAnchor,
    });
    const row = bundleEntry(await plugins.list(), "@example/absent-bundle");
    assert.equal(row.installed, false);
    assert.equal(row.kind, "missing");
    assert.equal(row.version, undefined);
  } finally {
    layout.cleanup();
  }
});


/**
 * Batch "update all" fixtures.
 *
 * The job runs on the production `DshPlugins`, with the spawn seam pointed at a
 * scripted `dsh` (a JS file spawned through `process.execPath`, so it works on
 * POSIX and Windows alike). The fake logs every argv it receives and fails any
 * spec naming `bad-bundle`, which is how the assertions tell "one failure" from
 * "success everywhere" without a registry, pnpm, or network.
 */
function batchUpdateLayout() {
  const layout = dshHomeLayout();
  writeInstalledBase(layout);
  writePackage(layout.installedPackage("@deepseek-ai/dsh-web-app"), {
    name: "@deepseek-ai/dsh-web-app",
    version: "0.2.2-rc.3",
    dsh: { bundle: { patch: "cordis.patch.yml" } },
  });
  writeManifest(layout.profileDir, {
    name: "dsh-profile-paseo",
    dependencies: {
      "@example/ok-bundle": "1.0.0",
      "@example/bad-bundle": "1.0.0",
    },
    dsh: {
      profile: {
        bundles: [BASE, "@example/ok-bundle", "@example/bad-bundle", "@deepseek-ai/dsh-web-app"],
      },
    },
  });
  for (const name of ["@example/ok-bundle", "@example/bad-bundle"]) {
    writePackage(layout.profilePackage(name), {
      name,
      version: "1.0.0",
      dsh: { bundle: { patch: "cordis.patch.yml" } },
    });
  }
  return layout;
}

function fakeDsh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-dsh-"));
  const script = path.join(dir, "fake-dsh.cjs");
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(script, [
    '"use strict";',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify(args) + "\\n");',
    'if (args.includes("--version")) { console.log("0.2.2-rc.3"); process.exit(0); }',
    'const spec = args[args.length - 1] ?? "";',
    'if (spec.includes("bad-bundle")) {',
    '  process.stderr.write("E_BAD_PACKAGE: registry refused " + spec + "\\n");',
    '  process.exit(1);',
    '}',
    'console.log("done " + spec);',
    '',
  ].join("\n"));
  return {
    dir,
    calls() {
      try {
        return fs.readFileSync(log, "utf8").split("\n").filter((line) => line !== "")
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    addCalls() {
      return this.calls().filter((argv) => argv.includes("add"));
    },
    spawn(args, options) {
      return spawn(process.execPath, [script, ...args], {
        cwd: options.cwd,
        env: { ...options.env, FAKE_DSH_LOG: log },
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function batchManager(layout, fake) {
  return new DshPlugins({
    dir: layout.profileDir,
    profile: "paseo",
    dshHome: layout.root,
    installAnchor: layout.installAnchor,
    spawn: (args, options) => fake.spawn(args, options),
  });
}

async function waitForJob(plugins, id, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = plugins.status(id);
    if (status.state !== "running") return status;
    if (Date.now() > deadline) throw new Error(`job ${id} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("update-all updates every target in one job and succeeds", async () => {
  const layout = batchUpdateLayout();
  const fake = fakeDsh();
  try {
    const plugins = batchManager(layout, fake);
    const started = plugins.startJob({
      kind: "update-all",
      targets: [{ name: "@example/ok-bundle", version: "1.1.0" }],
    });
    assert.equal(started.ok, true);
    const status = await waitForJob(plugins, started.id);
    assert.equal(status.kind, "update-all");
    assert.equal(status.state, "succeeded");
    assert.deepEqual(status.updateResults, [
      { name: "@example/ok-bundle", version: "1.1.0", ok: true },
    ]);
    const addCalls = fake.addCalls();
    assert.equal(addCalls.length, 1);
    assert.deepEqual(addCalls[0], [
      "plugin", "--profile", "paseo", "add", "--save-exact", "@example/ok-bundle@1.1.0",
    ]);
  } finally {
    fake.cleanup();
    layout.cleanup();
  }
});

test("update-all records a partial failure per item and fails the task", async () => {
  const layout = batchUpdateLayout();
  const fake = fakeDsh();
  try {
    const plugins = batchManager(layout, fake);
    const started = plugins.startJob({
      kind: "update-all",
      targets: [
        { name: "@example/ok-bundle", version: "1.1.0" },
        { name: "@example/bad-bundle", version: "9.9.9" },
      ],
    });
    const status = await waitForJob(plugins, started.id);
    assert.equal(status.state, "failed");
    assert.ok(status.errorCode !== undefined, "a partially failed batch must not read as success");
    assert.equal(status.updateResults.length, 2);
    assert.deepEqual(status.updateResults[0], {
      name: "@example/ok-bundle",
      version: "1.1.0",
      ok: true,
    });
    const failed = status.updateResults[1];
    assert.equal(failed.name, "@example/bad-bundle");
    assert.equal(failed.version, "9.9.9");
    assert.equal(failed.ok, false);
    assert.equal(failed.errorCode, "command-failed");
    assert.match(failed.errorDetail, /E_BAD_PACKAGE/);
    assert.equal(fake.addCalls().length, 2, "both targets are attempted in the one job");
  } finally {
    fake.cleanup();
    layout.cleanup();
  }
});

test("update-all spawns no command when no target is updatable", async () => {
  const layout = batchUpdateLayout();
  const fake = fakeDsh();
  try {
    const plugins = batchManager(layout, fake);
    const started = plugins.startJob({
      kind: "update-all",
      // An installation-supplied bundle is never updatable; a stale page (or a
      // direct RPC) must not turn it into a command.
      targets: [{ name: "@deepseek-ai/dsh-web-app", version: "0.2.2-rc.4" }],
    });
    const status = await waitForJob(plugins, started.id);
    assert.equal(status.state, "succeeded");
    assert.deepEqual(status.updateResults, []);
    assert.equal(fake.addCalls().length, 0, "no updatable target means no dsh command");
  } finally {
    fake.cleanup();
    layout.cleanup();
  }
});

test("update-all excludes official bundles and still updates the rest", async () => {
  const layout = batchUpdateLayout();
  const fake = fakeDsh();
  try {
    const plugins = batchManager(layout, fake);
    const started = plugins.startJob({
      kind: "update-all",
      targets: [
        { name: "@deepseek-ai/dsh-web-app", version: "0.2.2-rc.3" },
        { name: "@example/ok-bundle", version: "1.1.0" },
      ],
    });
    const status = await waitForJob(plugins, started.id);
    assert.equal(status.state, "succeeded");
    assert.deepEqual(status.updateResults, [
      { name: "@example/ok-bundle", version: "1.1.0", ok: true },
    ]);
    const addCalls = fake.addCalls();
    assert.equal(addCalls.length, 1);
    assert.equal(addCalls[0][addCalls[0].length - 1], "@example/ok-bundle@1.1.0");
  } finally {
    fake.cleanup();
    layout.cleanup();
  }
});


test("the RPC contract carries update-all and its per-target outcomes", () => {
  const accepted = startJobInputSchema.safeParse({
    kind: "update-all",
    targets: [{ name: "@example/ok-bundle", version: "1.1.0" }],
  });
  assert.equal(accepted.success, true);
  assert.equal(
    startJobInputSchema.safeParse({ kind: "update-all", targets: [] }).success,
    false,
    "the page must not ask for an empty batch",
  );

  const status = jobStatusSchema.safeParse({
    id: "job-1",
    kind: "update-all",
    state: "failed",
    output: "",
    updateResults: [
      { name: "@example/ok-bundle", version: "1.1.0", ok: true },
      { name: "@example/bad-bundle", version: "9.9.9", ok: false, errorCode: "command-failed", errorDetail: "E_BAD_PACKAGE" },
    ],
    startedAt: 1,
    finishedAt: 2,
  });
  assert.equal(status.success, true);
  assert.equal(
    jobStatusSchema.safeParse({
      id: "job-1",
      kind: "update-all",
      state: "failed",
      output: "",
      updateResults: [{ name: "x", version: "1", ok: false, errorCode: "not-a-real-code" }],
      startedAt: 1,
    }).success,
    false,
    "a per-target failure code must stay inside the shared failure-code enum",
  );
});


/**
 * Localized display text fixtures.
 *
 * DSH reads a package's display text from the locale files it exports beside
 * `<package>/locale/en.json` (all `locale/*.json`), and the client resolves the
 * active locale through its fallback chain. Here the selection is pinned to the
 * same file rules (`languageChain`: zh-CN -> zh-cn -> zh -> en) so the page can
 * ask for one language over the RPC:
 *
 *   locale/<lang>.json  meta.title / meta.description
 *   otherwise            package.json description (title stays the package name)
 *   malformed locale     ignored for that file, package.json fallback kept
 */
function writeLocale(dir, file, value) {
  const localeDir = path.join(dir, "locale");
  fs.mkdirSync(localeDir, { recursive: true });
  fs.writeFileSync(path.join(localeDir, file), `${JSON.stringify(value, null, 2)}\n`);
}

function localizedLayout() {
  const layout = dshHomeLayout();
  writeInstalledBase(layout);
  writeManifest(layout.profileDir, {
    name: "dsh-profile-paseo",
    dependencies: { "@example/localized-bundle": "1.0.0" },
    dsh: { profile: { bundles: [BASE, "@example/localized-bundle"] } },
  });
  const dir = layout.profilePackage("@example/localized-bundle");
  writePackage(dir, {
    name: "@example/localized-bundle",
    version: "1.0.0",
    description: "English package description",
    dsh: { bundle: { patch: "cordis.patch.yml" } },
  });
  return { layout, dir };
}

function localizedManager(layout) {
  return new DshPlugins({
    dir: layout.profileDir,
    profile: "paseo",
    dshHome: layout.root,
    installAnchor: layout.installAnchor,
  });
}

test("a package's locale meta title and description follow the requested language", async () => {
  const { layout, dir } = localizedLayout();
  try {
    // Both spellings exist on purpose: the more specific `zh-CN.json` must win
    // over `zh.json`, matching DSH's lowercased-id fallback chain.
    writeLocale(dir, "zh-CN.json", { meta: { title: "中文标题", description: "中文简介" } });
    writeLocale(dir, "zh.json", { meta: { title: "备选标题", description: "备选简介" } });
    writeLocale(dir, "en.json", { meta: { title: "English title", description: "English locale description" } });
    const plugins = localizedManager(layout);

    const zh = bundleEntry(await plugins.list({ locale: "zh-CN" }), "@example/localized-bundle");
    assert.equal(zh.description, "中文简介");
    assert.equal(zh.title, "中文标题");

    // DSH puts the English locale file's description in the English slot, ahead
    // of the raw package.json description.
    const en = bundleEntry(await plugins.list({ locale: "en" }), "@example/localized-bundle");
    assert.equal(en.description, "English locale description");
    assert.equal(en.title, "English title");
  } finally {
    layout.cleanup();
  }
});

test("a package without locale files falls back to its package.json description", async () => {
  const { layout } = localizedLayout();
  try {
    const plugins = localizedManager(layout);
    const row = bundleEntry(await plugins.list({ locale: "zh-CN" }), "@example/localized-bundle");
    assert.equal(row.description, "English package description");
    assert.equal(row.title, undefined);
  } finally {
    layout.cleanup();
  }
});

test("a malformed locale file falls back instead of failing the list", async () => {
  const { layout, dir } = localizedLayout();
  try {
    writeLocale(dir, "zh.json", "{");
    writePackage(layout.profilePackage("@example/second-bundle"), {
      name: "@example/second-bundle",
      version: "1.0.0",
      description: "Second bundle",
      dsh: { bundle: { patch: "cordis.patch.yml" } },
    });
    const manifestPath = path.join(layout.profileDir, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.dependencies["@example/second-bundle"] = "1.0.0";
    manifest.dsh.profile.bundles.push("@example/second-bundle");
    writeManifest(layout.profileDir, manifest);

    const plugins = localizedManager(layout);
    const snapshot = await plugins.list({ locale: "zh-CN" });
    assert.equal(snapshot.errorCode, undefined, "one bad locale file must not fail the whole list");
    const row = bundleEntry(snapshot, "@example/localized-bundle");
    assert.equal(row.description, "English package description");
    assert.equal(row.title, undefined);
    assert.equal(bundleEntry(snapshot, "@example/second-bundle").description, "Second bundle");
  } finally {
    layout.cleanup();
  }
});
