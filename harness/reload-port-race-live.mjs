/**
 * Live repro: the first session open after a plugin reload, against a **real**
 * `dsh --profile` whose `webserver` is pinned to a fixed port.
 *
 * The race this exercises is cross-process and needs the real thing: Paseo stops
 * a plugin process on a 2 s budget (`@getpaseo/server` `plugins/runtime.js`,
 * `SOFT_SHUTDOWN_TIMEOUT_MS = 2000`, then SIGTERM/SIGKILL), the shared `dsh` it
 * spawned outlives it (stdin EOF → DSH's own graceful exit, which takes as long as
 * the running agents need), and the profile's pinned `webserver` port stays bound
 * for that whole window. The successor's child then dies at profile boot with
 * `listen EADDRINUSE … webserver (required)`.
 *
 * So the script plays both sides for real:
 *
 *   old side — a separate node process loads the compiled plugin, opens two
 *              sessions against the real profile (one turn finished, one still
 *              running), reports READY, then starts its real `close()` and is
 *              SIGTERMed 2 s later, exactly like the host does.
 *   new side — the parent (a "new plugin process") opens one session right after
 *              the old process is reaped, on the **same** profile and port.
 *
 * With the record-based wait (`server/shared-dsh-record.ts`) the new side waits
 * for the orphan to exit and then succeeds. Without it, the run fails with the
 * real `EADDRINUSE`. Run it in a checkout of the pre-fix revision for the second
 * half of that comparison.
 *
 *   node harness/reload-port-race-live.mjs            # current checkout
 *   node harness/reload-port-race-live.mjs --label before
 *
 * Costs two small model turns (it must: an idle `dsh` exits in ~230 ms, measured,
 * and reproduces nothing). The profile is a throwaway clone whose `webserver`
 * port is rewritten to a free fixed one, so the live home and its bookmarked port
 * are never touched.
 */
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { prepareDshHome } = require("./isolated-dsh-home.cjs");
const { resolvePluginBuild } = require("./plugin-build.cjs");

const label = process.argv.includes("--label")
  ? process.argv[process.argv.indexOf("--label") + 1]
  : "current";

const homeInfo = prepareDshHome({ script: "reload-port-race-live", argv: process.argv.slice(2) });
const HOME = homeInfo.home;
const PROFILE = homeInfo.profile;

/** A free port, then handed back: the profile needs it *fixed*, not `0`. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

log(`throwaway DSH_HOME: ${HOME} (kept only for this run)`);
const PORT = await freePort();
{
  const patchPath = join(HOME, "profiles", PROFILE, "cordis.patch.yml");
  const lines = readFileSync(patchPath, "utf8").split("\n");
  const out = [];
  let inWebserver = false;
  for (const line of lines) {
    const item = /^- id:\s*(.+?)\s*$/.exec(line);
    if (item !== null) inWebserver = item[1].replace(/^["']|["']$/g, "") === "webserver";
    else if (/^- /.test(line)) inWebserver = false;
    if (inWebserver && /^\s+host:\s*\S+/.test(line)) { out.push("    host: 127.0.0.1"); continue; }
    if (inWebserver && /^\s+port:\s*\d+/.test(line)) { out.push(`    port: ${PORT}`); continue; }
    out.push(line);
  }
  writeFileSync(patchPath, out.join("\n"));
}

const buildDir = resolvePluginBuild(undefined, ".dbg-reload-port-race-live");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function log(message) {
  console.log(`[${label}] ${message}`);
}

/**
 * Deterministic variant: a **real** `dsh` holds the profile's fixed port while the
 * successor opens, and is stopped mid-wait.
 *
 * The orphan mode above measures the real timing but leaves the collision to
 * chance: the orphan exits ~2.3 s after the reload (measured), while a real dsh
 * needs ~4 s to boot, so whether the successor ever sees `EADDRINUSE` depends on
 * the host's CPU and plugin count. This mode removes that dependence without
 * faking anything: a real `dsh --profile <clone>` owns the port, the successor
 * starts, and the holder is asked to stop a few seconds in. Before the fix the
 * successor's child dies at profile boot with `listen EADDRINUSE`; with the fix it
 * waits for the holder (its record) and then comes up.
 */
async function runPortMode() {
  const stderrLines = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrLines.push(String(chunk));
    return realWrite(chunk, ...rest);
  };

  const holder = spawn(process.env.DSH_BIN ?? "dsh", ["--profile", PROFILE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DSH_HOME: HOME },
  });
  const holderLines = [];
  holder.stdout.setEncoding("utf8");
  holder.stderr.setEncoding("utf8");
  const collect = (chunk) => { holderLines.push(chunk); };
  holder.stdout.on("data", collect);
  holder.stderr.on("data", collect);
  const listenDeadline = Date.now() + 60000;
  while (Date.now() < listenDeadline && !holderLines.join("").includes("dsh web:") && holder.exitCode === null) {
    await sleep(50);
  }
  const holderListening = holderLines.join("").includes("dsh web:");
  log(`port-holder (a real dsh) pid ${String(holder.pid)} listening=${String(holderListening)} port ${String(PORT)}`);

  const recordModule = join(buildDir, "server", "shared-dsh-record.js");
  // Local, not the orphan section's `recordPath`: this function runs before that
  // declaration is initialized (it is defined further down, and the dispatch is up
  // here), so reaching for it would be a temporal-dead-zone error.
  let portRecordPath;
  if (existsSync(recordModule)) {
    const api = require(recordModule);
    const observed = api.systemProcessProbe().inspect(holder.pid);
    // `ownerPid` is a process that has already exited: this is the reload shape —
    // the plugin process that spawned the holder is gone, the holder is not. An
    // owner that is still alive is never signalled (it would be a sibling
    // connection's child), so the reclamation only applies to this shape.
    const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise((resolve) => deadOwner.on("exit", resolve));
    portRecordPath = recordPathFor(api, PROFILE);
    api.writeSharedDshRecord(portRecordPath, {
      pid: holder.pid,
      identity: observed.identity,
      command: process.env.DSH_BIN ?? "dsh",
      home: HOME,
      profile: PROFILE,
      ownerPid: deadOwner.pid,
    });
  } else {
    log("no shared-dsh-record module in this build (pre-fix): nothing records the holder");
  }

  const plugin = require(join(buildDir, "index.server.js")).default;
  const events = [];
  let registration;
  plugin({ handle() {}, registerProvider(r) { registration = r; }, registerSettings() {}, on() {}, before() {} });
  const conn = await registration.connect({ capabilities: ["prompt.message"] });
  conn.onEvent((event) => events.push(event));
  const openAt = Date.now();
  // The holder is asked to stop a few seconds in: before the fix the successor
  // binds inside that window, after the fix the wait covers it.
  // `--keep-holder` leaves the port owner running for the whole open: that is the
  // pre-fix reproduction (nothing waits, so the successor's child binds into a
  // port that is in use and dies at profile boot). The default stops the holder
  // mid-wait, which is the reload shape the fix is for.
  if (!process.argv.includes("--keep-holder")) {
    setTimeout(() => { if (holder.exitCode === null) holder.kill("SIGTERM"); }, 6000);
  }
  await conn.send({
    type: "session.open",
    requestId: "open-port",
    sessionId: "port-mode",
    config: { cwd: process.cwd(), mode: "build" },
    history: "skip",
  });
  let outcome = "pending";
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const ready = events.find((e) => e.type === "session.ready" && e.sessionId === "port-mode");
    const failure = events.find((e) => e.type === "request.failed" || e.type === "session.runtime_failed");
    if (ready !== undefined) { outcome = "opened"; break; }
    if (failure !== undefined) { outcome = `failed: ${failure.error?.message ?? failure.type}`; break; }
    await sleep(25);
  }
  const everything = `${stderrLines.join("")}\n${holderLines.join("")}`;
  const eaddr = everything
    .split("\n")
    .filter((line) => /EADDRINUSE|webserver \(required\)/.test(line));
  const steps = everything
    .split("\n")
    .filter((line) => /sending SIGTERM|after SIGTERM|ignored SIGTERM|after SIGKILL/.test(line));
  console.log(JSON.stringify({
    label,
    mode: "port",
    outcome,
    waitedMs: Date.now() - openAt,
    holderPid: holder.pid,
    holderListening,
    eaddrInUse: eaddr.slice(0, 6),
    reclaimSteps: steps.map((line) => line.trim()).slice(0, 4),
    recordWritten: portRecordPath === undefined ? false : existsSync(portRecordPath),
  }, null, 2));
  log(`outcome: ${outcome} (${String(Date.now() - openAt)} ms)`);
  try {
    await conn.close();
  } catch {
    /* teardown */
  }
  if (holder.exitCode === null) holder.kill("SIGKILL");
  process.exit(outcome === "opened" ? 0 : 1);
}

/** The old plugin process: real sessions on the real profile, then a real teardown. */
const oldScript = join(HOME, "old-plugin-process.mjs");
writeFileSync(
  oldScript,
  `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const plugin = require(${JSON.stringify(join(buildDir, "index.server.js"))}).default;
const events = [];
let registration;
plugin({ handle() {}, registerProvider(r) { registration = r; }, registerSettings() {}, on() {}, before() {} });
const step = (message) => process.stderr.write("OLD: " + message + "\\n");
step("plugin loaded");
const conn = await registration.connect({ capabilities: ["prompt.message"] });
conn.onEvent((event) => events.push(event));
step("connected");
const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for " + label);
};
const open = async (sessionId) => {
  step("opening " + sessionId);
  await conn.send({ type: "session.open", sessionId, config: { cwd: process.cwd(), mode: "build" } });
  const event = await waitFor((e) => (e.type === "session.ready" && e.sessionId === sessionId) || e.type === "request.failed" || e.type === "session.runtime_failed", 120000, "session.ready " + sessionId);
  if (event.type !== "session.ready") throw new Error("open " + sessionId + " failed: " + (event.error?.message ?? event.type));
};
const prompt = (sessionId, clientMessageId, text) => conn.send({
  type: "session.prompt",
  sessionId,
  prompt: { clientMessageId, delivery: "auto", input: { type: "text", text } },
});
// Several sessions, each left **mid-turn**: the teardown of a real dsh is
// proportional to the work its agents have in flight, and that is the only thing
// that keeps the port bound past the successor's boot. No turn is awaited: a live
// agent only has to exist, and a turn that fails still creates one.
const SESSIONS = ["live-a", "live-b", "live-c", "live-d", "live-e"];
for (const id of SESSIONS) {
  await open(id);
  step("session " + id + " ready");
  void prompt(id, "m-" + id, "List six numbered sentences about damped springs.");
}
await new Promise((resolve) => setTimeout(resolve, 500));
for (const event of events) {
  if (event.type === "request.failed" || event.type === "session.runtime_failed") {
    step("prompt failure: " + (event.error?.message ?? event.type));
  }
}
process.stdout.write("OLD READY\\n");
process.on("SIGUSR1", () => {
  // Deliberately no conn.close(): the host's SIGTERM at the 2 s budget is what
  // ends this process in the failing case, and the plugin's own teardown is then
  // cut off before it reaches the shared child. Letting the host's kill do the
  // work makes the reproduction the orphaned-child case instead of a race the
  // test hopes to win; the fix is about that orphan, not about this process.
  process.stdout.write("OLD CLOSING (kill me)\\n");
});
// No SIGTERM handler: the host's default action is what ends this process.
setInterval(() => {}, 1000);
`,
);

if (process.argv.includes("--mode=port")) {
  await runPortMode();
}

/** Is the pinned port bound right now (i.e. some dsh is listening)? */
function portBound() {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error) => resolve(error.code === "EADDRINUSE"));
    server.listen(PORT, "127.0.0.1", () => server.close(() => resolve(false)));
  });
}

const oldProcess = spawn(process.execPath, [oldScript], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, DSH_HOME: HOME },
});
let oldOutput = "";
oldProcess.stdout.setEncoding("utf8");
oldProcess.stderr.setEncoding("utf8");
oldProcess.stdout.on("data", (chunk) => { oldOutput += chunk; });
oldProcess.stderr.on("data", (chunk) => { oldOutput += chunk; });

/**
 * The record path the plugin itself would use.
 *
 * The file name carries the profile (`shared-dsh.<profile>.json`) and the plugin's
 * own resolver is the only thing that knows how a profile name is made safe, so a
 * repro must ask it instead of hard-coding a name. The legacy name is kept only as
 * a fallback for running this script against a pre-fix tree, which has no such
 * resolver and writes the old single file.
 */
function recordPathFor(api, profile) {
  return typeof api.sharedDshRecordPath === "function"
    ? api.sharedDshRecordPath(HOME, profile)
    : join(HOME, "paseo", "shared-dsh.json");
}

/** The compiled record module, if this build has one (a pre-fix tree does not). */
function paseoRecordApi() {
  const module = join(buildDir, "server", "shared-dsh-record.js");
  return existsSync(module) ? require(module) : undefined;
}

const recordPath = recordPathFor(paseoRecordApi() ?? {}, PROFILE);

/**
 * The old plugin process's `dsh` child, found from the process table.
 *
 * The record is the fixed revision's way of naming it; the pre-fix revision
 * writes no record at all, and the comparison needs the same fact from both. The
 * old process spawns exactly one `dsh`, so its only child is that one.
 */
function childOf(pid) {
  try {
    const text = require("node:child_process").execFileSync("ps", ["-o", "pid=", "--ppid", String(pid)], { encoding: "utf8", timeout: 2000 });
    const pids = text.split("\n").map((line) => Number(line.trim())).filter((value) => Number.isInteger(value) && value > 0);
    return pids[0];
  } catch {
    return undefined;
  }
}
const oldRecord = () => {
  try {
    return JSON.parse(readFileSync(recordPath, "utf8"));
  } catch {
    return undefined;
  }
};

const deadline = Date.now() + 180000;
let lastProgressAt = 0;
while (!oldOutput.includes("OLD READY") && oldProcess.exitCode === null && Date.now() < deadline) {
  if (Date.now() - lastProgressAt >= 5000) {
    lastProgressAt = Date.now();
    log(`waiting for the old process: alive=${String(oldProcess.exitCode === null)} output=${String(oldOutput.length)} bytes, dsh pid=${String(oldRecord()?.pid ?? "none")}`);
  }
  await sleep(50);
}
const ready = oldOutput.includes("OLD READY");
const orphanPid = oldRecord()?.pid ?? childOf(oldProcess.pid);
log(`old process ready=${String(ready)} pid=${String(oldProcess.pid)} dsh pid=${String(orphanPid)} port ${String(PORT)} bound=${String(await portBound())}`);
if (!ready) {
  console.error(`old process did not report READY (exitCode=${String(oldProcess.exitCode)}, ${String(oldOutput.length)} bytes)`);
  console.error(oldOutput.slice(-4000));
  oldProcess.kill("SIGKILL");
  process.exit(2);
}

// The host's stop: ask the plugin to shut down, then SIGTERM it on the 2 s budget.
const closingAt = Date.now();
oldProcess.kill("SIGUSR1");
await sleep(2000);
oldProcess.kill("SIGTERM");
await new Promise((resolve) => oldProcess.on("exit", resolve));
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const orphanAliveAtKill = orphanPid !== undefined && isAlive(orphanPid);
log(`old plugin process exited after ${String(Date.now() - closingAt)} ms; orphan pid ${String(orphanPid)} alive=${String(orphanAliveAtKill)}`);

// How long the orphan keeps its port: the size of the window the successor must
// not spawn into. Polled **while** the new side opens — waiting here first would
// remove the very race being measured.
const orphanPoll = orphanAliveAtKill
  ? (async () => {
    const until = Date.now() + 120000;
    while (Date.now() < until && isAlive(orphanPid)) await sleep(25);
    return isAlive(orphanPid) ? undefined : Date.now() - closingAt;
  })()
  : Promise.resolve(undefined);

// The new plugin process, immediately: connect and open the first session.
const plugin = require(join(buildDir, "index.server.js")).default;
const events = [];
let registration;
plugin({ handle() {}, registerProvider(r) { registration = r; }, registerSettings() {}, on() {}, before() {} });
const conn = await registration.connect({ capabilities: ["prompt.message"] });
conn.onEvent((event) => events.push(event));

const newPidBefore = oldRecord()?.pid;
const openAt = Date.now();
await conn.send({
  type: "session.open",
  requestId: "open-new",
  sessionId: "live-new",
  config: { cwd: process.cwd(), mode: "build" },
  history: "skip",
});
let outcome = "pending";
const openDeadline = Date.now() + 120000;
while (Date.now() < openDeadline) {
  const readyEvent = events.find((e) => e.type === "session.ready" && e.sessionId === "live-new");
  const failure = events.find((e) => e.type === "request.failed" || e.type === "session.runtime_failed");
  if (readyEvent !== undefined) { outcome = "opened"; break; }
  if (failure !== undefined) { outcome = `failed: ${failure.error?.message ?? failure.type}`; break; }
  await sleep(25);
}
const waited = Date.now() - openAt;
const logLines = oldOutput.split("\n").filter((line) => /EADDRINUSE|webserver \(required\)|waited|shared dsh/i.test(line));

// The reclaimed sessions' logs must still be readable by DSH. The old plugin
// process was writing them when it was stopped on the host's budget, so this is
// what says the reclamation did not leave a half-written store: DSH's own replay
// path (`harness/replay-fidelity-probe.mjs`) is run over the newest log in the
// clone. A corrupt or truncated log fails it.
function newestSessionLog(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = require("node:fs").readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.name === "session.v4.jsonl.zstd") {
        try {
          found.push({ path, mtime: require("node:fs").statSync(path).mtimeMs });
        } catch {
          /* raced with a write; the next walk sees it */
        }
      }
    }
  };
  walk(root, 0);
  // The reclaimed logs are the old plugin process's sessions (`live-a`…`live-e`);
  // `live-new` belongs to the successor and would prove nothing about the reclaim.
  const reclaimed = found.filter((entry) => /\/live-[a-z]+\//.test(entry.path) && !/\/live-new\//.test(entry.path));
  const pool = reclaimed.length > 0 ? reclaimed : found;
  pool.sort((a, b) => b.mtime - a.mtime);
  return pool[0]?.path;
}
const reclaimedLog = newestSessionLog(HOME);
let logReplay = "no session log found in the clone";
if (reclaimedLog !== undefined) {
  // The probe is a real DSH replay of that file, so this is "DSH can read it",
  // not "the file exists".
  const probeRun = spawnSync(
    process.execPath,
    [join(here, "replay-fidelity-probe.mjs"), reclaimedLog],
    { encoding: "utf8", timeout: 120000, env: { ...process.env } },
  );
  const tailText = `${probeRun.stdout ?? ""}${probeRun.stderr ?? ""}`.trim().split("\n").slice(-2).join(" | ");
  logReplay = `exit ${String(probeRun.status)}: ${tailText}`;
}
log(`first open after the reload: ${outcome} (${String(waited)} ms)`);
console.log(JSON.stringify({
  label,
  outcome,
  waitedMs: waited,
  orphanPid: orphanPid ?? null,
  orphanAliveAtKill,
  orphanGoneAfterMs: (await orphanPoll) ?? null,
  newDshPidBefore: newPidBefore ?? null,
  port: PORT,
  eaddrInUse: logLines.length > 0 ? logLines.slice(0, 6) : [],
  reclaimedSessionLog: reclaimedLog ?? null,
  sessionLogReplay: logReplay,
}, null, 2));
log(`old process output tail: ${JSON.stringify(oldOutput.split("\n").filter((l) => l.trim() !== "").slice(-6))}`);

try {
  await conn.close();
} catch {
  /* teardown */
}
if (orphanPid !== undefined && isAlive(orphanPid)) {
  try { process.kill(orphanPid, "SIGKILL"); } catch { /* gone */ }
}
if (oldProcess.exitCode === null) oldProcess.kill("SIGKILL");
process.exit(outcome === "opened" ? 0 : 1);