/**
 * The `paseo` profile pins its `webserver` to one fixed host:port, so only one
 * `dsh` child of this plugin process can boot it at a time. Two kinds of child do
 * boot it: the resident pool child and the throwaway probes (`catalog`, sessions,
 * archive). A reload exposes every gap between them:
 *
 *   1. **The prewarm must not need the catalog on disk.** The on-disk catalog
 *      entry is correctly invalidated whenever the profile composition changes
 *      (an edit of `cordis.patch.yml`, a DSH upgrade, a key rotation), so the
 *      first plugin load after such a change always has a cold catalog. The old
 *      prewarm gave up on that ("prewarm skipped: the profile's catalog is not on
 *      disk yet") and the first open paid the whole cold boot — the window the
 *      port race lives in. It must now start the child and let the first session
 *      pin the route instead (`DshProcessOptions.deferRoute`).
 *   2. **A killed probe must be reaped before the next child boots.** `probe.kill()`
 *      sends SIGTERM and only SIGKILLs at + 4 s; it returns immediately, so the
 *      pool spawn that follows the first open's catalog probe used to land while
 *      the probe still held the profile's listener. Measured on the real daemon at
 *      2026-11-15T05:50:03Z: `listen EADDRINUSE <host>:<port>` on the profile's
 *      `webserver (required)` → child exit 1, and the retry 4.4 s later succeeded.
 *   3. **Every spawn waits for the previous plugin process's recorded child.**
 *      The cross-process record (`shared-dsh-record.ts`) was only consulted by the
 *      pool spawn; a probe spawned first in the successor process could take the
 *      port from under the orphan. The probe path must do the same bounded reclaim
 *      wait.
 *
 * The check is scripted through the fake `dsh` (`harness/fake-dsh-bridge.mjs`)
 * with a real TCP listener standing in for the profile's fixed port
 * (`DSH_FAKE_PORT`), a slow exit for the teardown window
 * (`DSH_FAKE_EXIT_HOLD_MS`), and an exit journal (`DSH_FAKE_EXIT_LOG`) so
 * spawn/exit ordering is asserted from outside the plugin. Throwaway `DSH_HOME`,
 * no profile, model or daemon is touched.
 *
 * Run:
 *   node harness/profile-child-gate-check.mjs [compiled-plugin-dir]
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
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

const ROOT = mkdtempSync(join(tmpdir(), "dsh-profile-child-gate-"));
process.env.DSH_HOME = join(ROOT, "home-a");
mkdirSync(process.env.DSH_HOME, { recursive: true });
process.on("exit", () => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const PROFILE = "paseo";
const SPAWN_LOG = join(ROOT, "spawns.log");
const EXIT_LOG = join(ROOT, "exits.log");

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Every spawn appends its pid and wall-clock timestamp; every fake child appends
// its own exit timestamp. Comparing the two is the only way to prove "the next
// spawn waited for the previous child's exit" from outside the plugin.
const wrapper = join(ROOT, "fake-dsh-wrapper.sh");
writeFileSync(
  wrapper,
  [
    "#!/usr/bin/env bash",
    `printf 'spawn %s %s %s\\n' "$$" "$(date +%s%3N)" "$*" >> ${shellQuote(SPAWN_LOG)}`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(fakeBridge)} "$@"`,
    "",
  ].join("\n"),
);
chmodSync(wrapper, 0o755);
process.env.DSH_BINARY = wrapper;
process.env.DSH_FAKE_MODE = "multi";
process.env.DSH_FAKE_EXIT_LOG = EXIT_LOG;

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-profile-child-gate");
const plugin = require(join(buildDir, "index.server.js")).default;
const recordApi = require(join(buildDir, "server", "shared-dsh-record.js"));
const processProbe = recordApi.systemProcessProbe();

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

/**
 * Every profile child the fake dsh made, oldest first.
 *
 * `catalogFingerprint` runs `dsh --version` through the same wrapper (a real
 * spawn, but never one that boots the profile), so entries whose argv does not
 * name a `--profile` are filtered out: the assertions below are about profile
 * children only.
 */
function spawns() {
  if (!existsSync(SPAWN_LOG)) return [];
  return readFileSync(SPAWN_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [kind, pid, at, ...argv] = line.trim().split(/\s+/);
      return { kind, pid: Number(pid), at: Number(at), argv: argv.join(" ") };
    })
    .filter((entry) => entry.argv.includes("--profile"));
}

/** Exit journal entries (`exit <pid> <epoch-ms>`), oldest first. */
function exits() {
  if (!existsSync(EXIT_LOG)) return [];
  return readFileSync(EXIT_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [kind, pid, at] = line.trim().split(/\s+/);
      return { kind, pid: Number(pid), at: Number(at) };
    });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined && value !== false) return value;
    await sleep(10);
  }
  return undefined;
}

async function waitForExit(pid, timeoutMs = 10000) {
  return waitFor(() => exits().find((entry) => entry.pid === pid), timeoutMs);
}

/** A free ephemeral port, closed again immediately: the child will bind it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The plugin's own record path for one home; never rebuild the naming rule here. */
const recordFor = (home) => recordApi.sharedDshRecordPath(home, PROFILE);

/** A brand-new `$DSH_HOME` with no profile and no catalog cache. */
function freshHome(name) {
  const home = join(ROOT, `home-${name}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  process.env.DSH_HOME = home;
  return home;
}

/** Every provider line this check caused, so the steps can be asserted. */
const stderrLog = [];
{
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrLog.push(String(chunk));
    return realWrite(chunk, ...rest);
  };
}
const stderrTail = (count = 10) => stderrLog.slice(-count).join("").trim();
const sinceMark = (mark) => stderrLog.slice(mark).join("");

const pluginEvents = [];
let registration;
plugin({
  handle() {},
  registerProvider(r) {
    registration = r;
  },
  registerSettings() {},
  addHook() { return () => {}; },
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

async function connect() {
  const conn = await registration.connect({ capabilities: ["prompt.message"] });
  conn.onEvent((event) => pluginEvents.push(event));
  return conn;
}

/** Ask the connection for the runtime catalog; returns its own events. */
async function sendCatalog(conn, requestId, cwd) {
  const mark = pluginEvents.length;
  await conn.send({ type: "catalog", requestId, cwd });
  await waitForEvent(
    (event) => (event.requestId === requestId && (event.type === "catalog" || event.type === "request.failed")),
    20000,
  ).catch(() => undefined);
  return pluginEvents.slice(mark);
}

async function openSession(conn, sessionId, cwd) {
  const mark = pluginEvents.length;
  await conn.send({
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    config: { cwd, mode: "build" },
    history: "skip",
  });
  await waitForEvent(
    (event) => (event.type === "session.ready" && event.sessionId === sessionId)
      || (event.type === "session.runtime_failed" && event.sessionId === sessionId)
      || (event.type === "request.failed" && event.requestId === `open-${sessionId}`),
    20000,
  ).catch(() => undefined);
  return pluginEvents.slice(mark);
}

const failedEvents = (events) => events.filter(
  (event) => event.type === "request.failed" || event.type === "session.runtime_failed",
);
const ready = (events, sessionId) => events.some(
  (event) => event.type === "session.ready" && event.sessionId === sessionId,
);
const catalogAnswered = (events) => events.some((event) => event.type === "catalog");

const connections = [];
const extraChildren = [];

try {
  // -------------------------------------------------------------------------
  console.log("\nthe prewarm starts the child even when the catalog cache is cold");
  {
    const home = freshHome("a");
    const cwd = join(ROOT, "workspace-a");
    mkdirSync(cwd, { recursive: true });
    delete process.env.DSH_FAKE_PORT;
    delete process.env.DSH_FAKE_EXIT_HOLD_MS;
    const catalogDir = join(home, "paseo", "catalog");
    check("the catalog cache directory is empty before the connect (the premise)", !existsSync(catalogDir), catalogDir);

    const spawnMark = spawns().length;
    const stderrMark = stderrLog.length;
    const conn = await connect();
    connections.push(conn);
    // The prewarm is fire-and-forget; give the spawn a real window before deciding.
    const spawnedAtConnect = await waitFor(() => spawns().length > spawnMark, 5000);
    check(
      "connect spawns the shared child without a catalog on disk",
      spawnedAtConnect !== undefined && spawnedAtConnect !== false,
      spawnedAtConnect === undefined
        ? sinceMark(stderrMark).trim().split("\n").slice(-2).join(" | ") || "(no spawn, no line)"
        : `pid ${String(spawns()[spawnMark]?.pid)}`,
    );
    if (spawnedAtConnect !== undefined) {
      const record = recordApi.readSharedDshRecord(recordFor(home));
      check(
        "…and the spawn is recorded for the next plugin process",
        record !== undefined && record.pid === spawns()[spawnMark]?.pid,
        JSON.stringify(record),
      );
    }

    const id = `gate-cold-${Date.now()}`;
    const events = await openSession(conn, id, cwd);
    check("the first session opened", ready(events, id), failedEvents(events).map((e) => e.error?.message).join(" | ") || "ready");
    check(
      "…reusing the prewarmed child instead of spawning another",
      spawns().length === spawnMark + 1,
      `${String(spawns().length - spawnMark)} spawn(s) after connect + open`,
    );
    await conn.close();
  }

  // -------------------------------------------------------------------------
  console.log("\na probe that was killed is reaped before the next child boots");
  {
    const home = freshHome("b");
    const cwd = join(ROOT, "workspace-b");
    mkdirSync(cwd, { recursive: true });
    const port = await freePort();
    process.env.DSH_FAKE_PORT = String(port);
    // The probe keeps the listener for 1200 ms after SIGTERM: the teardown window
    // `DshProcess.kill()` opens and the pool spawn used to land in.
    process.env.DSH_FAKE_EXIT_HOLD_MS = "1200";

    const conn = await connect();
    connections.push(conn);
    // Whatever the connect spawned (a prewarmed child, or nothing on a code that
    // still skips a cold prewarm): get it out of the way, because this case needs
    // the catalog *probe* path. The spawn is fire-and-forget, so wait for its
    // record instead of assuming it already exists. A killed child frees its
    // listener at once.
    const prewarmRecord = await waitFor(
      () => recordApi.readSharedDshRecord(recordFor(home)),
      3000,
    );
    if (prewarmRecord !== undefined) {
      try {
        process.kill(prewarmRecord.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await waitFor(() => recordApi.readSharedDshRecord(recordFor(home)) === undefined, 5000);
    }

    const stderrMark = stderrLog.length;
    const catalogEvents = await sendCatalog(conn, `gate-probe-catalog-${Date.now()}`, cwd);
    check(
      "the catalog request answered through a probe",
      catalogAnswered(catalogEvents),
      failedEvents(catalogEvents).map((e) => e.error?.message).join(" | ") || "catalog event",
    );

    const probePid = spawns().at(-1)?.pid;
    const id = `gate-probe-open-${Date.now()}`;
    const events = await openSession(conn, id, cwd);
    const openFailures = failedEvents(events).map((e) => e.error?.message ?? "").join(" | ");
    check("the session opened right after the probe was killed", ready(events, id), openFailures || "ready");
    check(
      "…without the pool child racing the probe's listener",
      ready(events, id) && !/EADDRINUSE|address already in use/.test(sinceMark(stderrMark)),
      sinceMark(stderrMark).split("\n").filter((line) => /EADDRINUSE/.test(line)).join(" | ") || "no EADDRINUSE",
    );
    const poolPid = spawns().at(-1)?.pid;
    const probeExited = probePid === undefined ? undefined : await waitForExit(probePid, 8000);
    const poolSpawned = spawns().find((entry) => entry.pid === poolPid);
    check(
      "the pool child was spawned only after the probe's process was gone",
      probePid !== undefined && probePid !== poolPid && probeExited !== undefined && poolSpawned !== undefined
        && poolSpawned.at >= probeExited.at,
      `probe ${String(probePid)} exited ${String(probeExited?.at)}, pool ${String(poolPid)} spawned ${String(poolSpawned?.at)}`,
    );
    delete process.env.DSH_FAKE_EXIT_HOLD_MS;
    await conn.close();
  }

  // -------------------------------------------------------------------------
  console.log("\na probe never spawns beside the previous plugin process's recorded child");
  {
    const home = freshHome("c");
    const cwd = join(ROOT, "workspace-c");
    mkdirSync(cwd, { recursive: true });
    delete process.env.DSH_FAKE_EXIT_HOLD_MS;
    const port = await freePort();
    process.env.DSH_FAKE_PORT = String(port);

    const readyFile = join(ROOT, "orphan-c.ready");
    const exitStamp = join(ROOT, "orphan-c.exit");
    const script = join(ROOT, "orphan-c.mjs");
    writeFileSync(
      script,
      `import { createServer } from "node:net";\n`
        + `import { writeFileSync } from "node:fs";\n`
        + `const server = createServer();\n`
        + `process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(exitStamp)}, String(Date.now())); process.exit(0); });\n`
        + `server.listen(${String(port)}, "127.0.0.1", () => writeFileSync(${JSON.stringify(readyFile)}, "ready"));\n`,
    );
    // The shape of a reload: the old plugin process is gone (its child is not).
    const orphan = spawn(process.execPath, [script, "--profile", PROFILE], { stdio: "ignore" });
    extraChildren.push(orphan);
    const orphanUp = await waitFor(() => existsSync(readyFile), 5000);
    check("the previous process's child holds the profile's listener", orphanUp !== undefined, `pid ${String(orphan.pid)}`);
    const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    extraChildren.push(deadOwner);
    await new Promise((resolve) => deadOwner.once("exit", resolve));
    recordApi.writeSharedDshRecord(recordFor(home), {
      pid: orphan.pid,
      identity: processProbe.inspect(orphan.pid).identity,
      command: wrapper,
      home,
      profile: PROFILE,
      ownerPid: deadOwner.pid,
    });
    const stderrMark = stderrLog.length;
    const spawnMark = spawns().length;

    const conn = await connect();
    connections.push(conn);
    const catalogEvents = await sendCatalog(conn, `gate-orphan-catalog-${Date.now()}`, cwd);
    check(
      "the successor's first request answers instead of colliding with the orphan",
      catalogAnswered(catalogEvents),
      failedEvents(catalogEvents).map((e) => e.error?.message).join(" | ") || "catalog event",
    );
    const orphanExitRecorded = await waitFor(() => existsSync(exitStamp), 15000);
    check("…the orphan was reclaimed (it is gone)", orphanExitRecorded !== undefined, `pid ${String(orphan.pid)}`);
    check(
      "…by the bounded reclaim (SIGTERM is logged)",
      /sending SIGTERM/.test(sinceMark(stderrMark)) || /exited \d+ ms after SIGTERM/.test(sinceMark(stderrMark)),
      sinceMark(stderrMark).split("\n").filter((line) => /SIGTERM|reclaim/.test(line)).join(" | ") || "(no reclaim line)",
    );
    const orphanExitedAt = existsSync(exitStamp) ? Number(readFileSync(exitStamp, "utf8")) : undefined;
    const firstSpawn = spawns()[spawnMark];
    check(
      "…and no child was spawned while it was still alive",
      firstSpawn !== undefined && orphanExitedAt !== undefined && firstSpawn.at >= orphanExitedAt,
      `first spawn ${String(firstSpawn?.pid)} at ${String(firstSpawn?.at)}, orphan exited ${String(orphanExitedAt)}`,
    );
    await conn.close();
  }
  // -------------------------------------------------------------------------
  console.log("\ntwo concurrent probes never boot the profile at the same time");
  {
    // The profile has one listener, so the gate is what makes "kill one probe,
    // start the next" safe. Sequential scenarios cannot see the gate at all; this
    // one crosses it: two catalog requests on one connection race for the probe,
    // and the fake child's slow SIGTERM exit tells "serialized" from "concurrent"
    // without trusting event order (both requests are answered either way — a
    // bind-failing child still answers the RPC before it exits).
    const home = freshHome("d");
    const cwdA = join(ROOT, "workspace-d1");
    const cwdB = join(ROOT, "workspace-d2");
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });
    const port = await freePort();
    process.env.DSH_FAKE_PORT = String(port);
    // Long enough that a serialized pair is two ~1.2 s lifetimes in a row, while
    // an unserialized pair overlaps (one probe dies at bind in tens of ms).
    process.env.DSH_FAKE_EXIT_HOLD_MS = "1200";

    const conn = await connect();
    connections.push(conn);
    // Retire the prewarmed child: this case needs the probe path, and a live
    // resident child would be reused instead (the correct behaviour when the
    // profile already has a child — covered by the cold-prewarm case above).
    const prewarmRecord = await waitFor(() => recordApi.readSharedDshRecord(recordFor(home)), 3000);
    if (prewarmRecord !== undefined) {
      try {
        process.kill(prewarmRecord.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await waitFor(() => recordApi.readSharedDshRecord(recordFor(home)) === undefined, 5000);
    }

    const spawnMark = spawns().length;
    const eventMark = pluginEvents.length;
    const ids = [`gate-concurrent-a-${String(Date.now())}`, `gate-concurrent-b-${String(Date.now())}`];
    // Same turn, no await between them: both `#catalog` handlers are in flight at
    // the same time, which is the only way the gate is exercised.
    await Promise.all([
      conn.send({ type: "catalog", requestId: ids[0], cwd: cwdA }),
      conn.send({ type: "catalog", requestId: ids[1], cwd: cwdB }),
    ]);
    const answered = await waitFor(
      () => ids.every((id) => pluginEvents.slice(eventMark).some(
        (event) => event.requestId === id && (event.type === "catalog" || event.type === "request.failed"),
      )),
      20000,
    );
    check("both concurrent catalog requests were answered", answered !== undefined, ids.join(", "));

    const probes = spawns().slice(spawnMark);
    await waitFor(
      () => probes.length === 2 && probes.every((entry) => !processProbe.inspect(entry.pid).alive),
      15000,
    );
    const spans = probes.map((entry) => ({
      pid: entry.pid,
      started: entry.at,
      exited: exits().find((exit) => exit.pid === entry.pid)?.at,
    }));
    check(
      "…and exactly two probes were spawned for them",
      spans.length === 2,
      spans.map((span) => `pid ${String(span.pid)}`).join(", ") || "(none)",
    );
    check(
      "…both probes are reaped (their lifetimes are known)",
      spans.length === 2 && spans.every((span) => span.exited !== undefined),
      spans.map((span) => `${String(span.pid)} ${String(span.started)}→${String(span.exited)}`).join(", "),
    );
    const ordered = [...spans].sort((a, b) => a.started - b.started);
    const disjoint = ordered.length === 2
      && ordered[0].exited !== undefined
      && ordered[1].exited !== undefined
      && ordered[0].exited <= ordered[1].started;
    check(
      "…and the second probe is spawned only after the first one exited (lifetimes do not overlap)",
      disjoint,
      ordered.map((span) => `${String(span.pid)} alive ${String(span.started)}→${String(span.exited)}`).join(" | "),
    );
    delete process.env.DSH_FAKE_EXIT_HOLD_MS;
    await conn.close();
  }
} finally {
  for (const conn of connections) {
    try {
      await conn.close();
    } catch {
      /* best-effort */
    }
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && spawns().some((entry) => processProbe.inspect(entry.pid).alive)) {
    for (const entry of spawns()) {
      if (!processProbe.inspect(entry.pid).alive) continue;
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    await sleep(20);
  }
  for (const child of extraChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  if (failed > 0) {
    console.log(`\n${failed} failed, ${passed} passed`);
    console.log(`stderr tail:\n${stderrTail(16)}`);
    process.exitCode = 1;
  } else {
    console.log(`\n${passed} passed`);
  }
}