// The catalog cache must follow everything that shapes DSH's catalog while
// respecting this branch's resident shared-child architecture:
// - unified full fingerprint (command/version, profile, env, home patch,
//   stat-only credentials, profile files, shared bridge directory);
// - idle shared child is safely retired when inputs change, while a shared
//   child serving active sessions is never killed and never poisons the new
//   fingerprint's cache;
// - mid-probe edits fail as retryable (`catalog_inputs_changed`) and cache nothing;
// - close() aborts in-flight probes without publishing a catalog or leaking ports.
require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createDshProvider } = require("../server/provider.ts");
const {
  catalogCachePath,
  catalogFingerprint,
  readCatalogCache,
  writeCatalogCache,
} = require("../server/catalog-cache.ts");
const { BRIDGE_PACKAGE_NAME } = require("../server/bridge-assets.ts");
const { PROVIDER_CAPABILITIES, ProviderEventSchema } = require("@getpaseo/plugin/server/provider");

// A fake DSH that snapshots `cordis.patch.yml` AT PROCESS STARTUP — just like
// real DSH loads Cordis config once at boot — so only a restarted/fresh process
// sees profile edits. A `delay` file in `$DSH_HOME` holds `paseo/catalog` back
// without being part of the catalog fingerprint.
function fixtureCli(log, activeLog) {
  return `#!${process.execPath}
if (process.argv.includes("--version")) {
  process.stdout.write("0.2.1-fixture\\n");
  process.exit(0);
}
const fs = require("node:fs");
const path = require("node:path");
const send = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
const profile = process.argv[process.argv.indexOf("--profile") + 1] || "paseo";
const patchPath = path.join(process.env.DSH_HOME, "profiles", profile, "cordis.patch.yml");
const bootSpec = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8").trim() : "Alpha|low,medium";
const [bootLabel, bootEffortsRaw] = bootSpec.split("|");
const bootEfforts = (bootEffortsRaw || "low").split(",").filter(Boolean);

fs.appendFileSync(${JSON.stringify(activeLog)}, JSON.stringify({ event: "start", pid: process.pid }) + "\\n");
const markExit = () => {
  try {
    fs.appendFileSync(${JSON.stringify(activeLog)}, JSON.stringify({ event: "exit", pid: process.pid }) + "\\n");
  } catch {}
};
process.on("SIGTERM", () => { markExit(); process.exit(0); });
process.on("exit", markExit);

require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const r = JSON.parse(line);
  if (!r.method) return;
  fs.appendFileSync(
    ${JSON.stringify(log)},
    JSON.stringify({ pid: process.pid, cwd: process.cwd(), method: r.method, params: r.params }) + "\\n",
  );
  const answer = (result) => send({ jsonrpc: "2.0", id: r.id, result });
  if (r.method === "paseo/catalog") {
    const delayFile = path.join(process.env.DSH_HOME, "delay");
    const delay = fs.existsSync(delayFile) ? Number(fs.readFileSync(delayFile, "utf8")) : 0;
    const model = {
      provider: "fixture",
      id: "model",
      name: bootLabel,
      reasoning: {
        defaultEffort: bootEfforts[0] || "low",
        efforts: bootEfforts.map((id) => ({ id, name: id })),
      },
    };
    const payload = {
      providers: [{ id: "fixture", name: "Fixture" }],
      models: [model],
      defaultProvider: "fixture",
      defaultModel: "model",
    };
    if (delay > 0) return setTimeout(() => answer(payload), delay);
    return answer(payload);
  }
  if (r.method === "paseo/config/set") {
    return answer({
      provider: r.params?.provider ?? "fixture",
      model: r.params?.model ?? "model",
      reasoningEffort: r.params?.reasoningEffort ?? null,
    });
  }
  if (r.method === "paseo/commands") return answer({ available: true, commands: [] });
  if (r.method === "paseo/permission/get") return answer({ available: false });
  if (r.method === "paseo/presets") return answer({ available: false });
  if (r.method === "paseo/settings/list") return answer({ available: false });
  answer({});
  if (r.method === "shutdown") {
    markExit();
    process.exit(0);
  }
});
`;
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-catalog-")));
  const home = path.join(root, "home");
  const profileDir = path.join(home, "profiles", "paseo");
  const patch = path.join(profileDir, "cordis.patch.yml");
  const homePatch = path.join(home, "cordis.patch.yml");
  const credentials = path.join(home, ".credentials.yaml");
  const sharedBridgeDir = path.join(home, "profiles", "node_modules", BRIDGE_PACKAGE_NAME);
  const workspace = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(sharedBridgeDir, { recursive: true });
  fs.writeFileSync(patch, "Alpha|low,medium");
  fs.writeFileSync(homePatch, "[]\n");
  fs.writeFileSync(credentials, "refs:\n  FIXTURE_KEY: one\n");
  fs.writeFileSync(path.join(sharedBridgeDir, "index.js"), "module.exports = { v: 1 };\n");

  const log = path.join(root, "rpc.jsonl");
  const activeLog = path.join(root, "lifecycle.jsonl");
  const cli = path.join(root, "fake-dsh.cjs");
  fs.writeFileSync(cli, fixtureCli(log, activeLog));
  fs.chmodSync(cli, 0o755);

  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_BINARY: process.env.DSH_BINARY,
    DSH_PASEO_PROFILE: process.env.DSH_PASEO_PROFILE,
    FIXTURE_SECRET_TOKEN: process.env.FIXTURE_SECRET_TOKEN,
  };
  process.env.DSH_HOME = home;
  process.env.DSH_BINARY = cli;
  delete process.env.DSH_PASEO_PROFILE;
  delete process.env.FIXTURE_SECRET_TOKEN;

  const connections = [];
  t.after(async () => {
    for (const connection of connections) await connection.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  async function connect() {
    const connection = await createDshProvider().connect({
      versions: [1],
      capabilities: PROVIDER_CAPABILITIES,
    });
    connections.push(connection);
    const events = [];
    connection.onEvent((event) => {
      ProviderEventSchema.parse(event);
      events.push(event);
    });
    return { connection, events };
  }

  const frames = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const lifecycle = () =>
    fs.existsSync(activeLog)
      ? fs
          .readFileSync(activeLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const catalogCalls = () => frames().filter((r) => r.method === "paseo/catalog");
  const isPidAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  return {
    root,
    home,
    cli,
    patch,
    homePatch,
    credentials,
    sharedBridgeDir,
    workspace,
    connect,
    frames,
    lifecycle,
    catalogCalls,
    isPidAlive,
  };
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function readCatalog(c, requestId, cwd) {
  await c.connection.send({ type: "catalog", requestId, cwd });
  const event = c.events.find((e) => e.requestId === requestId);
  assert(event, `no response for ${requestId}`);
  assert.equal(event.type, "catalog", event.type === "request.failed" ? event.error.message : event.type);
  return event.catalog;
}

test("fingerprint covers home patch, bridge, profile, env without leaking secrets, and stats credentials without reading them", (t) => {
  const f = fixture(t);
  const readPaths = [];
  const originalReadFileSync = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    readPaths.push(String(target));
    return originalReadFileSync.call(fs, target, ...args);
  });

  const base = catalogFingerprint({ home: f.home, profile: "paseo", binary: f.cli });
  assert.ok(
    readPaths.includes(f.patch),
    `expected readFileSync mock to observe profile patch (${f.patch}); saw: ${readPaths.join(", ")}`,
  );
  assert(
    !readPaths.some((p) => p.endsWith(".credentials.yaml") || p.endsWith(".credentials.yml") || p.endsWith("credentials.json")),
    `credentials must only be stat'd, never read: ${readPaths.join(", ")}`,
  );

  // systemd / service-manager per-invocation env keys must not churn the fingerprint across restarts.
  const withSystemdEnv = catalogFingerprint({
    home: f.home,
    profile: "paseo",
    binary: f.cli,
    env: {
      ...process.env,
      INVOCATION_ID: "inv-1234",
      JOURNAL_STREAM: "8:99999",
      SYSTEMD_EXEC_PID: "4242",
      LISTEN_PID: "4242",
      LISTEN_FDS: "1",
      LISTEN_FDNAMES: "paseo",
      NOTIFY_SOCKET: "/run/systemd/notify",
    },
  });
  assert.equal(withSystemdEnv, base, "systemd per-invocation env keys should be ignored");

  // Bare command resolution on PATH: editing the target executable invalidates the fingerprint.
  const binDir = path.join(f.root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bareBin = path.join(binDir, "dsh-bare-fixture");
  fs.writeFileSync(bareBin, `#!${process.execPath}\nconsole.log("1.0.0");\n`);
  fs.chmodSync(bareBin, 0o755);
  const pathEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
  const bareBefore = catalogFingerprint({ home: f.home, profile: "paseo", binary: "dsh-bare-fixture", env: pathEnv });
  fs.writeFileSync(bareBin, `#!${process.execPath}\nconsole.log("1.0.1");\n`);
  fs.chmodSync(bareBin, 0o755);
  const bareAfter = catalogFingerprint({ home: f.home, profile: "paseo", binary: "dsh-bare-fixture", env: pathEnv });
  assert.notEqual(bareAfter, bareBefore, "upgrading a bare command on PATH must invalidate the fingerprint");

  // Home-level cordis.patch.yml change invalidates fingerprint.
  fs.writeFileSync(f.homePatch, "- id: extra\n");
  const afterHomePatch = catalogFingerprint({ home: f.home, profile: "paseo", binary: f.cli });
  assert.notEqual(afterHomePatch, base);

  // Shared bridge directory ($DSH_HOME/profiles/node_modules/dsh-paseo-bridge) change invalidates.
  fs.writeFileSync(path.join(f.sharedBridgeDir, "index.js"), "module.exports = { v: 2 };\n");
  const afterBridge = catalogFingerprint({ home: f.home, profile: "paseo", binary: f.cli });
  assert.notEqual(afterBridge, afterHomePatch);

  // Profile name change invalidates even for an empty/missing second profile.
  const otherProfile = catalogFingerprint({ home: f.home, profile: "alt", binary: f.cli });
  assert.notEqual(otherProfile, afterBridge);

  // Env change invalidates and never leaks secret value into the fingerprint or disk file.
  const secretValue = "super-secret-test-value-do-not-leak";
  const withSecret = catalogFingerprint({
    home: f.home,
    profile: "paseo",
    binary: f.cli,
    env: { ...process.env, FIXTURE_SECRET_TOKEN: secretValue },
  });
  assert.notEqual(withSecret, afterBridge);
  assert(!withSecret.includes(secretValue), "fingerprint must not contain raw env secret");

  const diskFile = catalogCachePath({ home: f.home, profile: "paseo", cwd: f.workspace("ws-disk") });
  writeCatalogCache({
    path: diskFile,
    fingerprint: withSecret,
    catalog: { models: [{ id: "fixture/model", label: "Alpha" }], thinkingOptions: [], fallbackRoute: { provider: "fixture", model: "model" }, defaults: { modes: [{ id: "build", label: "Build" }] } },
  });
  const rawDisk = fs.readFileSync(diskFile, "utf8");
  assert(!rawDisk.includes(secretValue), "disk cache file must not leak raw env values");

  // Credential edit (same byte length, immediate overwrite) invalidates via stat.
  fs.writeFileSync(f.credentials, "refs:\n  FIXTURE_KEY: two\n");
  const afterCred = catalogFingerprint({
    home: f.home,
    profile: "paseo",
    binary: f.cli,
    env: { ...process.env, FIXTURE_SECRET_TOKEN: secretValue },
  });
  assert.notEqual(afterCred, withSecret);
});

test("cached reads across connections and session open do not re-probe", async (t) => {
  const f = fixture(t);
  const cwd = f.workspace("ws");
  const first = await f.connect();
  const catalog = await readCatalog(first, "c1", cwd);
  assert.equal(catalog.models[0].label, "Alpha");
  assert.equal(f.catalogCalls().length, 1);

  // Same connection, a second connection, and a session open all hit cache.
  await readCatalog(first, "c2", cwd);
  const second = await f.connect();
  await readCatalog(second, "c3", cwd);
  await second.connection.send({
    type: "session.open",
    requestId: "open",
    sessionId: "root",
    history: "skip",
    config: { cwd, env: {}, persist: true, settings: {} },
  });
  assert(second.events.some((e) => e.type === "session.ready" && e.sessionId === "root"));
  assert.equal(f.catalogCalls().length, 1);
});

test("profile edit retires idle shared child, reaches next catalog and session open, and protects active sessions", async (t) => {
  const f = fixture(t);
  const cwd = f.workspace("ws");
  const c = await f.connect();
  const before = await readCatalog(c, "c1", cwd);
  assert.equal(before.models[0].label, "Alpha");
  const firstPid = f.catalogCalls()[0].pid;

  // No active sessions yet: editing cordis.patch.yml retires the idle shared
  // child and probes a fresh process so the new label & thinking levels arrive.
  fs.writeFileSync(f.patch, "Beta|low,medium,max");
  const after = await readCatalog(c, "c2", cwd);
  assert.equal(after.models[0].label, "Beta");
  assert.deepEqual(
    after.models[0].thinkingOptions.map((option) => option.id),
    ["low", "medium", "max"],
  );
  assert.equal(f.catalogCalls().length, 2);
  assert.notEqual(f.catalogCalls()[1].pid, firstPid);
  assert(!f.isPidAlive(firstPid), "idle stale shared child should have been retired");

  // Session open validates thinkingOption against the refreshed catalog, not a stale #display.
  await c.connection.send({
    type: "session.open",
    requestId: "open",
    sessionId: "root",
    history: "skip",
    config: { cwd, env: {}, persist: true, settings: {}, model: "fixture/model", thinkingOption: "max" },
  });
  assert(c.events.some((e) => e.type === "session.ready" && e.sessionId === "root"));
  const setConfig = f.frames().find((r) => r.method === "paseo/config/set" && r.params?.sessionId === "root");
  assert.equal(setConfig.params.reasoningEffort, "max");
  const activeSharedPid = setConfig.pid;

  // Now an active session is running on `activeSharedPid`. Editing the profile
  // must NOT kill that shared child, must NOT persist stale Beta under Gamma's
  // fingerprint, and once the session closes the next catalog picks up Gamma.
  fs.writeFileSync(f.patch, "Gamma|low");
  const gammaFingerprint = catalogFingerprint({ home: f.home, profile: "paseo", binary: f.cli, cwd });
  const whileActive = await readCatalog(c, "c3", cwd);
  assert.equal(whileActive.models[0].label, "Beta", "active shared child continues serving its live catalog");
  assert(f.isPidAlive(activeSharedPid), "active shared child must not be killed while a session is open");
  assert.equal(
    readCatalogCache({ path: catalogCachePath({ home: f.home, profile: "paseo", cwd }), fingerprint: gammaFingerprint }),
    undefined,
    "stale catalog from an active shared child must not be cached under the new fingerprint",
  );

  // Close the active session so claims drop to 0; next catalog retires the old
  // shared child and probes the updated profile cleanly.
  await c.connection.send({ type: "session.close", requestId: "close-root", sessionId: "root" });
  const afterClose = await readCatalog(c, "c4", cwd);
  assert.equal(afterClose.models[0].label, "Gamma");
  assert(!f.isPidAlive(activeSharedPid), "old shared child should retire once no sessions remain");
  assert(
    readCatalogCache({ path: catalogCachePath({ home: f.home, profile: "paseo", cwd }), fingerprint: gammaFingerprint }) !== undefined,
    "fresh probe result is cached on disk under the new fingerprint",
  );
});

test("mid-probe configuration change fails as retryable and caches nothing", async (t) => {
  const f = fixture(t);
  const cwd = f.workspace("ws");
  const c = await f.connect();
  await readCatalog(c, "c1", cwd);

  fs.writeFileSync(path.join(f.home, "delay"), "300");
  fs.writeFileSync(f.patch, "Delta|low");
  const beforeCalls = f.catalogCalls().length;
  const racing = c.connection.send({ type: "catalog", requestId: "c2", cwd });
  await waitFor(() => f.catalogCalls().length > beforeCalls, 5000, "the probe to receive paseo/catalog");
  fs.writeFileSync(f.patch, "Epsilon|low");
  await racing;

  const failed = c.events.find((e) => e.requestId === "c2");
  assert(failed, "racing request should emit a response");
  assert.equal(failed.type, "request.failed");
  assert.equal(failed.error.code, "catalog_inputs_changed");

  fs.rmSync(path.join(f.home, "delay"));
  const retried = await readCatalog(c, "c3", cwd);
  assert.equal(retried.models[0].label, "Epsilon");
});

test("close() stops an in-flight resident catalog read without publishing a catalog", async (t) => {
  const f = fixture(t);
  const cwd = f.workspace("ws");
  fs.writeFileSync(path.join(f.home, "delay"), "1500");
  const c = await f.connect();
  const pending = c.connection.send({ type: "catalog", requestId: "slow-resident", cwd });
  await waitFor(() => f.catalogCalls().length === 1, 5000, "the resident child to receive paseo/catalog");
  const residentPid = f.catalogCalls()[0].pid;

  const startedAt = Date.now();
  await c.connection.close();
  await pending;
  const elapsed = Date.now() - startedAt;
  assert(elapsed < 1300, `close() waited for the slow resident read instead of stopping it (${elapsed}ms)`);
  assert(!f.isPidAlive(residentPid), "the resident process outlived close()");

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert(!c.events.some((e) => e.type === "catalog"), "closed connection must never publish a catalog");
});

test("close() aborts an in-flight throwaway catalog probe and reaps it before returning", async (t) => {
  const f = fixture(t);
  const cwd = f.workspace("ws");
  const c = await f.connect();
  // Wait for prewarmSharedDsh() to boot the resident shared child first.
  await waitFor(() => f.lifecycle().some((e) => e.event === "start"), 5000, "prewarm shared child to start");
  const prewarmPid = f.lifecycle().find((e) => e.event === "start").pid;

  // Edit the profile so the next catalog read retires the idle prewarmed child
  // and spawns an exclusive throwaway `catalog-probe` process, then hold it in delay.
  fs.writeFileSync(f.patch, "Throwaway|low");
  fs.writeFileSync(path.join(f.home, "delay"), "1500");

  const pending = c.connection.send({ type: "catalog", requestId: "slow-throwaway", cwd });
  await waitFor(() => f.catalogCalls().length === 1, 5000, "the throwaway probe to receive paseo/catalog");
  const probePid = f.catalogCalls()[0].pid;
  assert.notEqual(probePid, prewarmPid, "catalog read must run on an exclusive throwaway probe, not the stale prewarm child");
  assert(
    f.lifecycle().some((e) => e.event === "exit" && e.pid === prewarmPid),
    "idle stale prewarm child should have exited before the throwaway probe started",
  );

  const startedAt = Date.now();
  await c.connection.close();
  await pending;
  const elapsed = Date.now() - startedAt;
  assert(elapsed < 1300, `close() waited for the slow throwaway probe instead of aborting it (${elapsed}ms)`);
  assert(!f.isPidAlive(probePid), "the throwaway probe outlived close()");
  assert(
    f.lifecycle().some((e) => e.event === "exit" && e.pid === probePid),
    "throwaway probe exit should be recorded before close() returns",
  );

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert(!c.events.some((e) => e.type === "catalog"), "closed connection must never publish a catalog");
});

test("concurrent catalog reads for different workspaces complete cleanly through the serialized gate", async (t) => {
  const f = fixture(t);
  const wsA = f.workspace("ws-a");
  const wsB = f.workspace("ws-b");
  const c = await f.connect();
  const [a, b] = await Promise.all([readCatalog(c, "a1", wsA), readCatalog(c, "b1", wsB)]);
  assert.equal(a.models[0].label, "Alpha");
  assert.equal(b.models[0].label, "Alpha");
  const callsAfterCold = f.catalogCalls().length;
  assert.equal(callsAfterCold, 2);

  // Both workspaces are now cached independently; re-reading either sends no RPC.
  const [a2, b2] = await Promise.all([readCatalog(c, "a2", wsA), readCatalog(c, "b2", wsB)]);
  assert.equal(a2.models[0].label, "Alpha");
  assert.equal(b2.models[0].label, "Alpha");
  assert.equal(f.catalogCalls().length, callsAfterCold);
});
