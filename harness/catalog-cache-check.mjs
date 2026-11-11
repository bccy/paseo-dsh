/**
 * Catalog cache is per-cwd (a small LRU), not a single slot.
 *
 * The provider serves several workspaces from one connection. The catalog cache
 * used to keep only the most recent cwd, so two workspaces used alternately
 * missed on every switch and each miss boots a whole `dsh` probe (measured
 * 1.5–2.7 s in the code comments). A single slot therefore turned ordinary
 * project switching into a cold start every time.
 *
 * The regression is pinned by counting bridge processes that actually received
 * a `paseo/catalog` request, not by reading the cache map: the map is module
 * private, and the user-visible cost is the probe spawn.
 *
 * Scenario: A → B → A. With the old single slot the third request misses and
 * spawns a third probe. With the LRU the first A is still fresh, so exactly two
 * probes are spawned and all three requests answer with a catalog.
 *
 * Uses the scripted fake `dsh` and a throwaway `DSH_HOME`; no profile, model or
 * daemon is touched.
 *
 * Run:
 *   node harness/catalog-cache-check.mjs [compiled-plugin-dir]
 *
 * (compiles into `paseo-plugin/.dbg-p5b-catalog` unless a build directory is
 * passed)
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolvePluginBuild } = require("./plugin-build.cjs");

const fakeBridge = join(here, "fake-dsh-bridge.mjs");
if (!existsSync(fakeBridge)) {
  console.error(`fake bridge missing at ${fakeBridge}`);
  process.exit(2);
}
chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "live";
const dshHome = mkdtempSync(join(tmpdir(), "dsh-catalog-cache-check-"));
process.env.DSH_HOME = dshHome;
const frameLog = join(dshHome, "frames.jsonl");
process.env.DSH_FAKE_LOG = frameLog;
process.on("exit", () => {
  try {
    rmSync(dshHome, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const workspaceA = join(dshHome, "workspace-a");
const workspaceB = join(dshHome, "workspace-b");
mkdirSync(workspaceA, { recursive: true });
mkdirSync(workspaceB, { recursive: true });

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-p5b-catalog");
const plugin = require(join(buildDir, "index.server.js")).default;

let registration;
plugin({
  handle() {},
  registerProvider(r) {
    registration = r;
  },
  registerSettings() {},
  on() {},
  before() {},
});
if (registration === undefined) {
  console.error("the plugin did not register a provider");
  process.exit(2);
}

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(list, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = list.find(predicate);
      if (found !== undefined) return resolve(found);
      if (Date.now() > deadline) {
        return reject(new Error(`timed out; saw ${list.map((event) => event.type).join(", ") || "(nothing)"}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

const conn = await registration.connect({ capabilities: ["prompt.message"] });
const events = [];
conn.onEvent((event) => events.push(event));

let sequence = 0;
async function requestCatalog(cwd) {
  const requestId = `catalog-${String(++sequence)}`;
  const mark = events.length;
  await conn.send({ type: "catalog", requestId, cwd });
  await waitFor(events.slice(mark), (event) => event.type === "catalog" && event.requestId === requestId);
  // Let the probe exit and flush its frame log before the next request.
  await sleep(150);
  return events.slice(mark);
}

console.log("catalog cache: A → B → A keeps the first workspace warm");
{
  const firstA = await requestCatalog(workspaceA);
  const b = await requestCatalog(workspaceB);
  const secondA = await requestCatalog(workspaceA);
  check("all three catalog requests answered", firstA.some((e) => e.type === "catalog")
    && b.some((e) => e.type === "catalog") && secondA.some((e) => e.type === "catalog"));

  const frames = existsSync(frameLog)
    ? readFileSync(frameLog, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
    : [];
  const catalogPids = new Set(
    frames.filter((frame) => frame.method === "paseo/catalog").map((frame) => frame.pid),
  );
  check(
    "the third request reuses the first workspace's cached catalog (2 probes, not 3)",
    catalogPids.size === 2,
    `spawned ${String(catalogPids.size)} catalog probe(s)`,
  );
}

// ---------------------------------------------------------------------------
// The on-disk cache: a *new process* on the same DSH home must not boot another
// probe. The in-memory cache above cannot cover that, and a reload is exactly a
// new process — which is the 4.2 s this cache exists to remove.
console.log("\nthe on-disk catalog cache is used by the next process, and only when provably fresh");
{
  const cacheModule = require(join(buildDir, "server", "catalog-cache.js"));
  const cacheHome = join(dshHome, "catalog-home");
  const profileName = "paseo";
  const profileDir = join(cacheHome, "profiles", profileName);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "cordis.patch.yml"), "- id: webserver\n  config:\n    port: 0\n");
  const binary = process.env.DSH_BINARY;
  const fingerprint = cacheModule.catalogFingerprint({ home: cacheHome, profile: profileName, binary });
  const cachePath = cacheModule.catalogCachePath({ home: cacheHome, profile: profileName, cwd: workspaceA });
  const sample = { models: [{ provider: "fake", id: "fake-model" }], thinkingOptions: [], fallbackRoute: { provider: "fake", model: "fake-model" }, defaults: {} };

  check("an entry written with a non-empty model list reads back", cacheModule.writeCatalogCache({ path: cachePath, fingerprint, catalog: sample }) === true
    && JSON.stringify(cacheModule.readCatalogCache({ path: cachePath, fingerprint })) === JSON.stringify(sample));
  check("…and an empty model list is never written (FIELD-NOTES 58)", cacheModule.writeCatalogCache({ path: cachePath, fingerprint, catalog: { ...sample, models: [] } }) === false
    && JSON.stringify(cacheModule.readCatalogCache({ path: cachePath, fingerprint })) === JSON.stringify(sample));
  check("…an empty entry on disk is not trusted either", (() => {
    writeFileSync(cachePath, JSON.stringify({ version: 1, writtenAt: Date.now(), fingerprint, catalog: { ...sample, models: [] } }));
    return cacheModule.readCatalogCache({ path: cachePath, fingerprint }) === undefined;
  })());
  check("…a profile edit invalidates it (fingerprint)", (() => {
    cacheModule.writeCatalogCache({ path: cachePath, fingerprint, catalog: sample });
    writeFileSync(join(profileDir, "cordis.patch.yml"), "- id: webserver\n  config:\n    port: 0\n- id: dsh-memory\n");
    const moved = cacheModule.catalogFingerprint({ home: cacheHome, profile: profileName, binary });
    return moved !== fingerprint && cacheModule.readCatalogCache({ path: cachePath, fingerprint: moved }) === undefined;
  })());
  check("…a corrupt file is ignored, not fatal", (() => {
    writeFileSync(cachePath, "{ this is not json");
    return cacheModule.readCatalogCache({ path: cachePath, fingerprint }) === undefined;
  })());
  check("…an expired entry is ignored", (() => {
    writeFileSync(cachePath, JSON.stringify({ version: 1, writtenAt: 1000, fingerprint, catalog: sample }));
    return cacheModule.readCatalogCache({ path: cachePath, fingerprint, now: 1000 + cacheModule.CATALOG_DISK_TTL_MS }) === undefined;
  })());

  // Integration (read path): a cache entry that a previous process could have
  // written must be used by a **new process** instead of booting another probe.
  // Seeded here rather than produced by a probe because the scripted fake `dsh`
  // answers an *empty* model list, and an empty list is never written (the rule
  // above) — so the write path cannot be exercised with it, but the read path can.
  const childScript = join(dshHome, "child-open.mjs");
  writeFileSync(childScript, `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const plugin = require(${JSON.stringify(join(buildDir, "index.server.js"))}).default;
const events = [];
let registration;
plugin({ handle() {}, registerProvider(r) { registration = r; }, registerSettings() {}, on() {}, before() {} });
const conn = await registration.connect({ capabilities: ["prompt.message"] });
conn.onEvent((event) => events.push(event));
const requestId = "child-" + process.argv[2];
await conn.send({ type: "catalog", requestId, cwd: ${JSON.stringify(workspaceA)} });
const deadline = Date.now() + 60000;
while (Date.now() < deadline && !events.some((e) => e.type === "catalog" && e.requestId === requestId)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const answered = events.some((e) => e.type === "catalog" && e.requestId === requestId);
await new Promise((resolve) => setTimeout(resolve, 200));
await conn.close();
process.exit(answered ? 0 : 1);
`);
  const catalogPidsNow = () => {
    if (!existsSync(frameLog)) return new Set();
    return new Set(
      readFileSync(frameLog, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
        .filter((frame) => frame.method === "paseo/catalog").map((frame) => frame.pid),
    );
  };
  const childEnv = { ...process.env, DSH_HOME: dshHome, DSH_BINARY: binary, DSH_FAKE_MODE: "live", DSH_FAKE_LOG: frameLog };
  const realFingerprint = cacheModule.catalogFingerprint({ home: dshHome, profile: "paseo", binary });
  const realPath = cacheModule.catalogCachePath({ home: dshHome, profile: "paseo", cwd: workspaceA });
  const seeded = cacheModule.writeCatalogCache({
    path: realPath,
    fingerprint: realFingerprint,
    // Shape-valid on purpose: `#open` reads `models`, `fallbackRoute` and
    // `defaults.modes`, and the provider validates those before using an entry.
    catalog: { models: [{ id: "fake-model", label: "fake" }], thinkingOptions: [], fallbackRoute: { provider: "fake", model: "fake-model" }, defaults: { models: [{ id: "fake-model", label: "fake" }], modes: [{ id: "build", label: "Build" }] } },
  });
  const beforePids = catalogPidsNow();
  const child = spawnSync(process.execPath, [childScript, "cached"], { encoding: "utf8", timeout: 120000, env: childEnv });
  const afterPids = catalogPidsNow();
  check("a cache entry for this home is accepted by the writer", seeded === true);
  check(
    "…and a new process answers the catalog from it without booting a probe",
    child.status === 0 && afterPids.size === beforePids.size,
    `pids ${String(beforePids.size)} → ${String(afterPids.size)} (child exit ${String(child.status)}; ${String((child.stderr ?? "").slice(-160))})`,
  );

  // A cache entry that is *shaped* wrong (truncated / written by another version)
  // must be a miss, never a TypeError inside the open. The entry below passes the
  // cache's own checks (non-empty models, matching fingerprint) and fails the
  // provider's shape validation (`defaults` and `defaults.modes` are what the open
  // reads), so the child must fall back to the probe and still open.
  const sessionChild = join(dshHome, "child-open-session.mjs");
  writeFileSync(sessionChild, `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const plugin = require(${JSON.stringify(join(buildDir, "index.server.js"))}).default;
const events = [];
let registration;
plugin({ handle() {}, registerProvider(r) { registration = r; }, registerSettings() {}, on() {}, before() {} });
const conn = await registration.connect({ capabilities: ["prompt.message"] });
conn.onEvent((event) => events.push(event));
const sessionId = "child-session-" + process.argv[2];
await conn.send({ type: "session.open", sessionId, config: { cwd: ${JSON.stringify(workspaceA)}, mode: "build" } });
const deadline = Date.now() + 60000;
while (Date.now() < deadline && !events.some((e) => (e.type === "session.ready" && e.sessionId === sessionId) || e.type === "request.failed")) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const ready = events.some((e) => e.type === "session.ready" && e.sessionId === sessionId);
const failure = events.find((e) => e.type === "request.failed");
console.error("open " + (ready ? "ready" : "failed: " + (failure?.error?.message ?? "unknown")));
await new Promise((resolve) => setTimeout(resolve, 150));
await conn.close();
process.exit(ready ? 0 : 1);
`);
  writeFileSync(realPath, JSON.stringify({
    version: 1,
    writtenAt: Date.now(),
    fingerprint: realFingerprint,
    catalog: { models: [{ id: "fake-model", label: "fake" }], thinkingOptions: [], fallbackRoute: { provider: "fake", model: "fake-model" }, defaults: null },
  }));
  const pidsBefore = catalogPidsNow();
  const sessionRun = spawnSync(process.execPath, [sessionChild, "truncated"], { encoding: "utf8", timeout: 120000, env: childEnv });
  const pidsAfter = catalogPidsNow();
  check(
    "a wrongly-shaped entry is treated as a miss and the open still succeeds",
    sessionRun.status === 0,
    `exit ${String(sessionRun.status)}; ${String((sessionRun.stderr ?? "").trim().slice(-240))}`,
  );
  check(
    "…by falling back to the runtime probe",
    pidsAfter.size > pidsBefore.size,
    `catalog-serving pids ${String(pidsBefore.size)} → ${String(pidsAfter.size)}`,
  );
}

await conn.close();
await conn.close();
console.log(`\n${String(passed)} passed, ${String(failed)} failed`);
if (failed > 0) process.exit(1);
