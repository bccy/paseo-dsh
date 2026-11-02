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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

await conn.close();
console.log(`\n${String(passed)} passed, ${String(failed)} failed`);
if (failed > 0) process.exit(1);
