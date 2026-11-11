/**
 * The reload port race: a successor plugin process must not spawn its shared
 * `dsh` while the previous one's child still holds the profile's fixed port.
 *
 * Paseo stops a plugin process on a **2 s** budget (`@getpaseo/server`
 * `plugins/runtime.js`, `SOFT_SHUTDOWN_TIMEOUT_MS = 2000`, then SIGTERM and
 * SIGKILL), while this plugin's own teardown is bounded by 10 s per session close
 * plus 5 s for the pool. A reload can therefore kill the old plugin process
 * mid-teardown, leaving its shared `dsh` alive with the profile's `webserver`
 * port bound; the new plugin process opens the first session immediately and that
 * child dies at profile boot with `listen EADDRINUSE … webserver (required)`.
 *
 * The fix (`paseo-plugin/server/shared-dsh-record.ts`) is a record of the shared
 * child — pid, start identity, profile — under `$DSH_HOME/paseo/`, and a bounded
 * wait before any spawn. What this check pins:
 *
 *   1. the record is written **at spawn** (same tick as the pid), names the real
 *      child and its profile, and is cleared once the child has exited
 *   2. a recorded old child that is still shutting down is **waited for**: the new
 *      child is spawned only after it is gone, and the open then succeeds
 *   3. the same wait covers a sibling connection in **this** process: a spawn
 *      that collides with a retiring child waits instead of putting two dsh
 *      processes on one profile
 *   4. a record whose pid has been **reused** by another program is not waited on
 *      — a pid is not an identity
 *   5. a child that will not exit is a **loud failure** naming its pid, not a
 *      silent second process and not a silent kill
 *   6. a record naming a dead pid costs no wait
 *
 * Uses the scripted fake `dsh` (`harness/fake-dsh-bridge.mjs`, `multi` mode) and
 * a throwaway `DSH_HOME`; no profile, model or daemon is touched.
 *
 * Run:
 *   node harness/reload-port-race-check.mjs [compiled-plugin-dir]
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-reload-port-race-"));
const HOME = process.env.DSH_HOME;
process.on("exit", () => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const PROFILE = "paseo";

const SPAWN_LOG = join(HOME, "spawns.log");
const HOLD_READY = join(HOME, "shutdown-hold.ready");
const HOLD_RELEASE = join(HOME, "shutdown-hold.release");

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Every spawn appends its pid and wall-clock timestamp; the assertions below
// compare those timestamps with the exit times, which is the only way to prove
// "no two dsh processes on one profile" from outside the provider.
const wrapper = join(HOME, "fake-dsh-wrapper.sh");
writeFileSync(
  wrapper,
  [
    "#!/usr/bin/env bash",
    `printf 'spawn %s %s\\n' "$$" "$(date +%s%3N)" >> ${shellQuote(SPAWN_LOG)}`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(fakeBridge)} "$@"`,
    "",
  ].join("\n"),
);
chmodSync(wrapper, 0o755);
process.env.DSH_BINARY = wrapper;
process.env.DSH_FAKE_MODE = "multi";

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-reload-port-race");
const plugin = require(join(buildDir, "index.server.js")).default;
const recordApi = require(join(buildDir, "server", "shared-dsh-record.js"));
const probe = recordApi.systemProcessProbe();
// One record per (home, profile): the file name carries the profile, so a child of
// another profile can never be mistaken for this spawn's predecessor.
const RECORD_FOR = (profile) => recordApi.sharedDshRecordPath(HOME, profile);
// Every path this check uses comes from the plugin's own resolver: the file name
// carries the profile, and duplicating that rule here would let the two drift.
const RECORD = RECORD_FOR(PROFILE);

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

/** Every spawn the fake dsh made, oldest first. */
function spawns() {
  if (!existsSync(SPAWN_LOG)) return [];
  return readFileSync(SPAWN_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [kind, pid, at] = line.trim().split(/\s+/);
      return { kind, pid: Number(pid), at: Number(at) };
    });
}

/** Wait until a spawn log entry for a pid exists (or the deadline passes). */
async function waitForSpawn(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = spawns().find((entry) => entry.pid === pid);
    if (found !== undefined) return found;
    await sleep(10);
  }
  return undefined;
}

/** Exit time of a pid, polled; `undefined` when it is still alive at the bound. */
async function waitForGone(pid, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!probe.inspect(pid).alive) return Date.now();
    await sleep(10);
  }
  return undefined;
}

/**
 * A process that is not `dsh`, alive for as long as the test needs it.
 *
 * Its command line carries `--profile <name>` on purpose: that is what a record
 * with a **stale identity** has to be rejected by — the identity alone decides,
 * and a live pid with a `--profile paseo` argument is the hardest false positive
 * to reject.
 */
function startSleeper(exitAfterMs) {
  const stamp = String(Date.now());
  const exitStamp = join(HOME, `sleeper-${stamp}.exit`);
  // A script file, not `-e`: node parses `node -e code --profile paseo` as an
  // option and dies with "bad option: --profile", which would make the record
  // name a process that is already gone.
  const script = join(HOME, `sleeper-${stamp}.mjs`);
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\n`
      + `setTimeout(() => { writeFileSync(${JSON.stringify(exitStamp)}, String(Date.now())); process.exit(0); }, ${String(exitAfterMs)});\n`,
  );
  const child = spawn(process.execPath, [script, "--profile", PROFILE], { stdio: "ignore" });
  return { child, pid: child.pid, exitStamp };
}

/** Every `[dsh-paseo]`/provider line this check caused, so the steps can be asserted. */
const stderrLog = [];
{
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrLog.push(String(chunk));
    return realWrite(chunk, ...rest);
  };
}
const stderrTail = (count = 12) => stderrLog.slice(-count).join("").trim();
const sinceMark = (mark) => stderrLog.slice(mark).join("");

/** A pid that is provably dead: a child that exits immediately. */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid;
}

/**
 * A process that survives on its own, with a chosen SIGTERM behaviour.
 *
 * `diesOnTerm` is the ordinary case (node's default action), `ignoresTerm` is the
 * wedged one the SIGKILL step exists for. Both carry `--profile <name>` so a
 * record naming them passes the command-line half of the identity check.
 */
function startHoldout(kind, exitAfterMs, profile = PROFILE) {
  const stamp = `${kind}-${String(Date.now())}`;
  const script = join(HOME, `${stamp}.mjs`);
  const body = kind === "ignoresTerm"
    ? "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n"
    : `setTimeout(() => { process.exit(0); }, ${String(exitAfterMs)});\nsetInterval(() => {}, 1000);\n`;
  writeFileSync(script, `import process from "node:process";\n${body}`);
  const child = spawn(process.execPath, [script, "--profile", profile], { stdio: "ignore" });
  return { child, pid: child.pid, exitStamp: undefined };
}

/** Write a record naming `pid` with the given (possibly wrong) identity. */
function writeRecord({ pid, identity, command = wrapper, profile = PROFILE, ownerPid = process.pid }) {
  const written = recordApi.writeSharedDshRecord(RECORD, {
    pid,
    identity,
    command,
    home: HOME,
    profile,
    ownerPid,
  });
  if (!written) throw new Error(`could not write the record at ${RECORD}`);
}

const pluginEvents = [];
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

function waitForEvent(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = pluginEvents.find(predicate);
      if (found !== undefined) return resolve(found);
      if (Date.now() > deadline) {
        return reject(new Error(`timed out; events: ${pluginEvents.map((e) => e.type).join(", ") || "(none)"}`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** One provider connection = one plugin process's worth of pool state. */
async function connect() {
  const conn = await registration.connect({ capabilities: ["prompt.message"] });
  conn.onEvent((event) => pluginEvents.push(event));
  return conn;
}

/** Open one session; returns the failure event instead of throwing on a failed open. */
async function openSession(conn, sessionId) {
  const mark = pluginEvents.length;
  await conn.send({
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    config: { cwd: process.cwd(), mode: "build" },
    history: "skip",
  });
  try {
    await waitForEvent(
      (event) => (event.type === "session.ready" && event.sessionId === sessionId)
        || event.type === "request.failed"
        || event.type === "session.runtime_failed",
      8000,
    );
  } catch {
    /* fall through: the caller inspects the events */
  }
  return pluginEvents.slice(mark);
}

const failures = (events) => events.filter(
  (event) => event.type === "request.failed" || event.type === "session.runtime_failed",
);
const ready = (events, sessionId) => events.some(
  (event) => event.type === "session.ready" && event.sessionId === sessionId,
);

const connections = [];
const sleepers = [];
try {
  // -------------------------------------------------------------------------
  console.log("\nthe record is written at spawn and cleared once the child is gone");
  {
    // Behaviour, not a string match: two profiles under one home must not share a
    // record, or whichever process writes last decides for both.
    const pathA = recordApi.sharedDshRecordPath(HOME, "a");
    const pathB = recordApi.sharedDshRecordPath(HOME, "b");
    check(
      "the record path is per profile",
      pathA !== pathB,
      `${pathA} vs ${pathB}`,
    );
    check(
      "…and the profile is in the file name",
      /shared-dsh\.a\.json$/.test(pathA) && /shared-dsh\.b\.json$/.test(pathB),
      `${pathA} | ${pathB}`,
    );
    const conn = await connect();
    connections.push(conn);
    const id = `race-record-${Date.now()}`;
    const events = await openSession(conn, id);
    check("the first session opened", ready(events, id), failures(events).map((e) => e.error?.message).join(" | ") || "ready");

    const record = recordApi.readSharedDshRecord(RECORD);
    // The provider also spawns short-lived probe children (catalog reads), so the
    // log has more than one entry by now: the assertion is that the record names a
    // pid the wrapper *did* spawn, not that only one spawn happened.
    const spawned = spawns().find((entry) => entry.pid === record?.pid);
    check("a record exists after the spawn", record !== undefined, RECORD);
    check(
      "…and it names the process that actually got spawned",
      record !== undefined && spawned !== undefined,
      `record pid ${String(record?.pid)}, wrapper-logged pids ${spawns().map((e) => e.pid).join(",") || "(none)"}`,
    );
    check(
      "…with the profile it serves",
      record?.profile === PROFILE,
      `profile=${String(record?.profile)}`,
    );
    check(
      "…and a start identity, not just the pid",
      typeof record?.identity === "string" && record.identity !== "",
      String(record?.identity),
    );

    await conn.close();
    check("the record is cleared once the child exited", recordApi.readSharedDshRecord(RECORD) === undefined);
  }

  // -------------------------------------------------------------------------
  // The reload itself: the old plugin process is gone, its child is still
  // shutting down and still holds the port. The successor must wait.
  console.log("\na previous process's child that is still exiting is waited for");
  {
    // Deliberately opened *while* the old child is still alive: the exit time is
    // taken from the child itself (it writes its own timestamp on exit), not from
    // a poll, so the ordering assertion is exact rather than polled.
    const sleeper = startSleeper(1500);
    sleepers.push(sleeper);
    const observed = probe.inspect(sleeper.pid);
    // `ownerPid` is a dead process: this record describes the reload shape — the
    // plugin process that spawned the child is gone, the child is not. A record
    // whose owner is alive is a sibling connection's child and is never signalled
    // (case "…is not killed" below).
    writeRecord({ pid: sleeper.pid, identity: observed.identity, ownerPid: await deadPid() });
    const stderrMark = stderrLog.length;
    const spawnCountBefore = spawns().length;
    const conn = await connect();
    connections.push(conn);
    const id = `race-wait-${Date.now()}`;
    const events = await openSession(conn, id);
    check("the session opened after the wait", ready(events, id), failures(events).map((e) => e.error?.message).join(" | ") || "ready");

    const newSpawn = spawns().find((entry) => entry.pid === recordApi.readSharedDshRecord(RECORD)?.pid);
    const sleeperGoneAt = existsSync(sleeper.exitStamp) ? Number(readFileSync(sleeper.exitStamp, "utf8")) : undefined;
    check(
      "…without signalling it: it exited within the self-exit window",
      !/sending SIGTERM|sending SIGKILL/.test(sinceMark(stderrMark)),
      sinceMark(stderrMark).split("\n").filter((l) => /SIGTERM|SIGKILL/.test(l)).join(" | ") || "(no signal)",
    );
    check(
      "the new child was spawned only after the old one exited",
      sleeperGoneAt !== undefined && newSpawn !== undefined && newSpawn.at >= sleeperGoneAt,
      `old exited ${String(sleeperGoneAt)}, new spawned ${String(newSpawn?.at)}`,
    );
    check(
      "exactly one child was spawned for that open",
      spawns().length === spawnCountBefore + 1,
      `${String(spawns().length - spawnCountBefore)} spawn(s) in this case`,
    );
    await conn.close();
  }

  // -------------------------------------------------------------------------
  // The same collision inside one plugin process: a sibling connection opens
  // while the pool is still retiring its child (the fake bridge holds `shutdown`
  // so the retirement is real, not a duration the test hopes for).
  console.log("\na retiring child is waited for, not spawned beside");
  {
    process.env.DSH_FAKE_HOLD_METHOD = "shutdown";
    process.env.DSH_FAKE_HOLD_READY = HOLD_READY;
    process.env.DSH_FAKE_HOLD_RELEASE = HOLD_RELEASE;
    const old = await connect();
    connections.push(old);
    const oldId = `race-retire-${Date.now()}`;
    check("the retiring connection opened its session", ready(await openSession(old, oldId), oldId));
    const oldPid = recordApi.readSharedDshRecord(RECORD)?.pid;
    const spawnCountBefore = spawns().length;

    // Start the teardown and do not await it: this is exactly the window in which
    // a second connection used to spawn beside the dying child.
    const closing = old.close();
    const holdDeadline = Date.now() + 8000;
    while (!existsSync(HOLD_READY) && Date.now() < holdDeadline) await sleep(10);
    check("the retirement reached the bridge's shutdown (positive control)", existsSync(HOLD_READY));

    const fresh = await connect();
    connections.push(fresh);
    const freshId = `race-retire-fresh-${Date.now()}`;
    const openTask = openSession(fresh, freshId);
    await sleep(400);
    check(
      "no second child is spawned while the old one is still alive",
      spawns().length === spawnCountBefore,
      `${String(spawns().length - spawnCountBefore)} extra spawn(s) while pid ${String(oldPid)} was alive`,
    );
    check(
      "…and the old child is in fact still alive (positive control)",
      oldPid !== undefined && probe.inspect(oldPid).alive,
      `pid ${String(oldPid)}`,
    );

    writeFileSync(HOLD_RELEASE, "go");
    const freshEvents = await openTask;
    check(
      "the fresh session opened once the old child exited",
      ready(freshEvents, freshId),
      failures(freshEvents).map((e) => e.error?.message).join(" | ") || "ready",
    );
    await waitForGone(oldPid);
    const freshPid = recordApi.readSharedDshRecord(RECORD)?.pid;
    check(
      "exactly one child was spawned after the release",
      spawns().length === spawnCountBefore + 1,
      `${String(spawns().length - spawnCountBefore)} spawn(s) in this case`,
    );
    check(
      "…and the retired child is the one that left",
      freshPid !== undefined && oldPid !== undefined && freshPid !== oldPid && !probe.inspect(oldPid).alive,
      `old pid ${String(oldPid)} alive=${String(oldPid !== undefined && probe.inspect(oldPid).alive)}, fresh pid ${String(freshPid)}`,
    );
    await closing;
    delete process.env.DSH_FAKE_HOLD_METHOD;
    await fresh.close();
  }

  // -------------------------------------------------------------------------
  // A reused pid is not our child. The record's identity is the only thing that
  // says otherwise, so this is the case that fails when the identity check goes.
  console.log("\na record whose pid now belongs to another process is not waited on");
  {
    process.env.DSH_PASEO_SHARED_DSH_WAIT_MS = "300";
    const sleeper = startSleeper(8000);
    sleepers.push(sleeper);
    // A dead owner on purpose: the *only* thing standing between this bystander and
    // a SIGTERM is the start-identity check. That is what the mutation "skip the
    // identity check" turns red.
    writeRecord({ pid: sleeper.pid, identity: "linux:0", ownerPid: await deadPid() });
    const stderrMark = stderrLog.length;
    const started = Date.now();
    const conn = await connect();
    connections.push(conn);
    const id = `race-reuse-${Date.now()}`;
    const events = await openSession(conn, id);
    check("the session opened without waiting for the unrelated process", ready(events, id), failures(events).map((e) => e.error?.message).join(" | ") || "ready");
    check(
      "…and it did not sit out the wait bound",
      Date.now() - started < 2500,
      `${String(Date.now() - started)} ms`,
    );
    check(
      "…and the unrelated process was not signalled",
      probe.inspect(sleeper.pid).alive && !/SIGTERM|SIGKILL/.test(sinceMark(stderrMark)),
      `alive=${String(probe.inspect(sleeper.pid).alive)}; ${sinceMark(stderrMark).trim() || "(no line)"}`,
    );
    const record = recordApi.readSharedDshRecord(RECORD);
    check(
      "…and the stale record was replaced by this child's",
      record !== undefined && record.pid !== sleeper.pid,
      `record pid ${String(record?.pid)}, unrelated pid ${String(sleeper.pid)}`,
    );
    await conn.close();
  }

  // -------------------------------------------------------------------------
  // The loud failure, on the path where nothing may be signalled: the record's
  // owner plugin process is still alive, so this is another live (or retiring)
  // connection's child and the successor only waits.
  console.log("\na child whose owner plugin process is still alive is not signalled, and fails the open loudly");
  {
    process.env.DSH_PASEO_SHARED_DSH_WAIT_MS = "300";
    const sleeper = startSleeper(8000);
    sleepers.push(sleeper);
    const spawnCountBefore = spawns().length;
    writeRecord({ pid: sleeper.pid, identity: probe.inspect(sleeper.pid).identity, ownerPid: process.pid });
    const stderrMark = stderrLog.length;
    check(
      "the record names a process that is alive and readable",
      probe.inspect(sleeper.pid).alive && recordApi.readSharedDshRecord(RECORD)?.pid === sleeper.pid,
      JSON.stringify(recordApi.readSharedDshRecord(RECORD)),
    );
    const conn = await connect();
    connections.push(conn);
    const id = `race-timeout-${Date.now()}`;
    const events = await openSession(conn, id);
    const failuresSeen = failures(events);
    const message = failuresSeen.map((event) => event.error?.message ?? "").join(" | ");
    check("the open failed", ready(events, id) === false && failuresSeen.length > 0, message || "(no failure event)");
    check(
      "…with a message that names the pid that would not exit",
      message.includes(String(sleeper.pid)),
      message.slice(0, 200) || "(empty)",
    );
    check(
      "…and says it refused to spawn beside it",
      /Refusing to start a second dsh/.test(message),
      message.slice(0, 200) || "(empty)",
    );
    check(
      "…and says the owner plugin process is still running",
      /still owned by a running plugin process/.test(message),
      message.slice(0, 260) || "(empty)",
    );
    check(
      "…and never signalled that process",
      probe.inspect(sleeper.pid).alive && !/SIGTERM|SIGKILL/.test(sinceMark(stderrMark)),
      `alive=${String(probe.inspect(sleeper.pid).alive)}; ${sinceMark(stderrMark).trim() || "(no line)"}`,
    );
    check(
      "…and no child was spawned",
      spawns().length === spawnCountBefore,
      `${String(spawns().length - spawnCountBefore)} spawn(s) in this case`,
    );
    sleeper.child.kill("SIGKILL");
    await waitForGone(sleeper.pid, 3000);
    check(
      "the record is still the refused child's (not silently cleared)",
      recordApi.readSharedDshRecord(RECORD)?.pid === sleeper.pid,
    );
    // With the child gone the very next open proceeds, and the stale record is
    // dropped rather than waited on.
    recordApi.clearSharedDshRecord(RECORD, sleeper.pid);
    const retryId = `race-timeout-retry-${Date.now()}`;
    const retry = await openSession(conn, retryId);
    check(
      "the next open succeeds once that pid is gone",
      ready(retry, retryId),
      failures(retry).map((e) => e.error?.message).join(" | ") || "ready",
    );
    await conn.close();
    delete process.env.DSH_PASEO_SHARED_DSH_WAIT_MS;
  }

  // -------------------------------------------------------------------------
  // The reclamation levels. A verified orphan that ignores the soft signal acts
  // out exactly what the extra steps exist for; a clean child must never see one.
  console.log("\na verified orphan that ignores SIGTERM is reclaimed with SIGKILL");
  {
    // The self-exit window is 3 s and the SIGTERM window 2 s (module constants), so
    // this case costs ~5 s of real time; there is no knob to shorten it because
    // the point is the production order of steps.
    const holdout = startHoldout("ignoresTerm");
    sleepers.push(holdout);
    writeRecord({
      pid: holdout.pid,
      identity: probe.inspect(holdout.pid).identity,
      ownerPid: await deadPid(),
    });
    const stderrMark = stderrLog.length;
    const conn = await connect();
    connections.push(conn);
    const id = `race-sigkill-${Date.now()}`;
    const events = await openSession(conn, id);
    const lines = sinceMark(stderrMark);
    check("the session opened once the wedge was killed", ready(events, id), failures(events).map((e) => e.error?.message).join(" | ") || "ready");
    check("…SIGTERM was tried first, with the pid in the log", /sending SIGTERM/.test(lines) && lines.includes(String(holdout.pid)), lines.trim() || "(no line)");
    check("…SIGTERM did not take, and that was said out loud", /ignored SIGTERM/.test(lines), lines.split("\n").filter((l) => /SIGTERM|SIGKILL/.test(l)).join(" | "));
    check("…SIGKILL finished it", /exited \d+ ms after SIGKILL|after SIGKILL/.test(lines) || /SIGKILL/.test(lines), lines.split("\n").filter((l) => /SIGKILL/.test(l)).join(" | "));
    check("…and the process is gone", !probe.inspect(holdout.pid).alive);
    await conn.close();
  }

  console.log("\na verified orphan that exits on SIGTERM is not killed");
  {
    const holdout = startHoldout("diesOnTerm", 60000);
    sleepers.push(holdout);
    writeRecord({
      pid: holdout.pid,
      identity: probe.inspect(holdout.pid).identity,
      ownerPid: await deadPid(),
    });
    const stderrMark = stderrLog.length;
    const conn = await connect();
    connections.push(conn);
    const id = `race-sigterm-${Date.now()}`;
    const events = await openSession(conn, id);
    const lines = sinceMark(stderrMark);
    check("the session opened after the reclaim", ready(events, id), failures(events).map((e) => e.error?.message).join(" | ") || "ready");
    check("…the child exited on SIGTERM (DSH's own shutdown path)", /after SIGTERM/.test(lines), lines.split("\n").filter((l) => /SIGTERM|SIGKILL/.test(l)).join(" | "));
    check("…so SIGKILL was never needed", !/SIGKILL/.test(lines), lines.split("\n").filter((l) => /SIGKILL/.test(l)).join(" | ") || "(none)");
    check("…and the process is gone", !probe.inspect(holdout.pid).alive);
    await conn.close();
  }

  // -------------------------------------------------------------------------
  // One record per profile (verify4 P2-1): another profile's live child is a
  // different DSH runtime, so this spawn must neither wait for it nor signal it.
  console.log("\na record for another profile is foreign: no wait, no signal");
  {
    const otherProfile = "other-profile";
    // Its command line names the other profile, like a real child of it would: that
    // is what makes the profile guard (rather than the command-line check) the only
    // thing standing between this child and a SIGTERM.
    const holdout = startHoldout("diesOnTerm", 60000, otherProfile);
    sleepers.push(holdout);
    const otherPath = RECORD_FOR(otherProfile);
    recordApi.writeSharedDshRecord(otherPath, {
      pid: holdout.pid,
      identity: probe.inspect(holdout.pid).identity,
      command: wrapper,
      home: HOME,
      profile: otherProfile,
      ownerPid: await deadPid(),
    });
    // Module level: the record is readable, alive, identity-matching — and still
    // foreign to a spawn that serves "paseo".
    const signals = [];
    const outcome = await recordApi.reclaimPreviousSharedDsh({
      path: otherPath,
      home: HOME,
      profile: PROFILE,
      probe,
      waitMs: 5000,
      selfPid: process.pid,
      signal: (pid, signal) => signals.push(`${String(pid)}:${String(signal)}`),
    });
    check("the module reports it foreign instead of waiting", outcome.state === "foreign", JSON.stringify(outcome));
    check("…and signals nothing", signals.length === 0 && probe.inspect(holdout.pid).alive, signals.join(",") || "(no signal)");
    // Provider level: the open is not slowed down by it either.
    process.env.DSH_PASEO_SHARED_DSH_WAIT_MS = "5000";
    const startedAt = Date.now();
    const conn = await connect();
    connections.push(conn);
    const id = `race-foreign-${Date.now()}`;
    const events = await openSession(conn, id);
    check("the session opened", ready(events, id), failures(events).map((e) => e.error?.message).join(" | ") || "ready");
    check(
      "…without waiting for the other profile's child",
      Date.now() - startedAt < 4000,
      `${String(Date.now() - startedAt)} ms; ${sinceMark(0).split("\n").filter((l) => /foreign/.test(l)).join(" | ")}`,
    );
    check("…and that child is still alive", probe.inspect(holdout.pid).alive);
    await conn.close();
    recordApi.clearSharedDshRecord(otherPath, holdout.pid);
    delete process.env.DSH_PASEO_SHARED_DSH_WAIT_MS;
  }

  // -------------------------------------------------------------------------
  // An unreadable process is "cannot verify", not "ours" (verify4 P3-2): the
  // module must wait on it and never signal it.
  console.log("\na pid that cannot be identified is waited on, never signalled");
  {
    const holdout = startHoldout("diesOnTerm", 60000);
    sleepers.push(holdout);
    const path = RECORD_FOR(PROFILE);
    recordApi.writeSharedDshRecord(path, {
      pid: holdout.pid,
      identity: probe.inspect(holdout.pid).identity,
      command: wrapper,
      home: HOME,
      profile: PROFILE,
      ownerPid: await deadPid(),
    });
    const signals = [];
    // A probe that answers "alive" with no identity and no command line: exactly
    // what a permission-denied `/proc` looks like for the child pid. It must stay
    // *truthful* for every other pid, or the owner check would read the dead owner
    // as alive and the case would pass for the wrong reason (as it did before this
    // distinction was added: the mutation "unknown counts as ours" survived).
    const blindProbe = {
      inspect: (pid) => (pid === holdout.pid ? { alive: true } : probe.inspect(pid)),
    };
    const outcome = await recordApi.reclaimPreviousSharedDsh({
      path,
      home: HOME,
      profile: PROFILE,
      probe: blindProbe,
      waitMs: 60,
      selfPid: process.pid,
      signal: (pid, signal) => signals.push(`${String(pid)}:${String(signal)}`),
    });
    check("the module times out instead of reclaiming", outcome.state === "timed-out", JSON.stringify(outcome));
    check("…with verified:false, so the caller reports it as unverified", outcome.state === "timed-out" && outcome.verified === false);
    check("…and it never signalled the pid", signals.length === 0 && probe.inspect(holdout.pid).alive, signals.join(",") || "(no signal)");
    holdout.child.kill("SIGKILL");
    await waitForGone(holdout.pid, 3000);
    recordApi.clearSharedDshRecord(path, holdout.pid);
  }

  // -------------------------------------------------------------------------
  console.log("\na record naming a dead pid costs no wait");
  {
    process.env.DSH_PASEO_SHARED_DSH_WAIT_MS = "5000";
    const dead = startSleeper(0);
    sleepers.push(dead);
    await waitForGone(dead.pid, 3000);
    writeRecord({ pid: dead.pid, identity: "linux:1" });
    const started = Date.now();
    const conn = await connect();
    connections.push(conn);
    const id = `race-dead-${Date.now()}`;
    const events = await openSession(conn, id);
    check("the session opened", ready(events, id), failures(events).map((e) => e.error?.message).join(" | ") || "ready");
    check("…without spending the wait bound", Date.now() - started < 3000, `${String(Date.now() - started)} ms`);
    await conn.close();
  }
} catch (error) {
  failed += 1;
  console.log(`  FAIL  the check could not finish — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  for (const conn of connections) {
    try {
      await conn.close();
    } catch {
      /* teardown of a connection that may already be closed */
    }
  }
  for (const sleeper of sleepers) {
    try {
      sleeper.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

console.log(`\n${String(passed)}/${String(passed + failed)} passed`);
process.exit(failed === 0 ? 0 : 1);