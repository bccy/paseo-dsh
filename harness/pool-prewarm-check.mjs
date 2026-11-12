/**
 * The pool prewarm: the shared `dsh` child is started when the provider connects,
 * kept resident for the connection's life, and reused by the first session open.
 *
 * Why this exists (FIELD-NOTES 92). The shared child's cold boot is the largest
 * cost on the first open of a connection — measured on the real profile at
 * **+8.4 s** to `listening` and **+23.2 s** to serving. Every open that arrives
 * inside that window queues behind it: the user's click, the first batch of ~20
 * sessions after a plugin load, and the 4 s native-subagent replay budget
 * (`provider.ts` `SUBAGENT_REPLAY_READY_BUDGET_MS`) all waited the same 23 s. The
 * fix moves the spawn to `connect()`, where nothing is waiting for it.
 *
 * What is pinned here, at the plugin layer and through the scripted fake `dsh`:
 *
 *   a) `connect()` spawns the child with **no session open**, and spawns exactly
 *      one. A prewarm takes no claim (`poolClaimCount` stays 0): it is a start,
 *      not a user of the child.
 *   b) the first open **reuses** that child — no second spawn, and the session's
 *      own `initialize` frame carries the prewarmed pid. An open that races the
 *      prewarm's in-flight spawn also produces exactly one spawn (it joins,
 *      it does not spawn beside it).
 *   c) the child stays **resident** after the last session closes: still alive
 *      past the old 5 s idle-retirement window, and the next open reuses the same
 *      pid. This is the accepted trade of "start it at load time" (one dsh
 *      resident per connection).
 *   d) `close()` still shuts it down: the child exits and the bridge saw a
 *      `shutdown` frame.
 *   e) a failed prewarm is loud and non-fatal: `connect()` resolves, stderr names
 *      the failure, and the next open spawns again and reports its own error. A
 *      failed prewarm is never remembered as "ready".
 *   f) the prewarm's route is the **profile default from the catalog on disk**,
 *      not a hardcoded provider/model: the cached entry's `fallbackRoute` is what
 *      arrives in the child's `initialize`.
 *   g) a profile with **no** catalog cache is left alone: no probe process, no
 *      spawn, one stderr line. Reading a cold catalog would boot the whole
 *      profile a second time — the cost the prewarm exists to remove — and would
 *      also break every check that counts bridge processes.
 *
 * Uses the scripted fake `dsh` (`harness/fake-dsh-bridge.mjs`, `live` mode) and a
 * throwaway `DSH_HOME`, so no profile, model, or daemon is touched.
 *
 * Run:
 *   node harness/pool-prewarm-check.mjs [compiled-plugin-dir]
 *
 * (it compiles the plugin into `paseo-plugin/.dbg-pool-prewarm` unless a build
 * directory is passed)
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which rewrites `$DSH_HOME/profiles/<name>/...`.
const HOME = mkdtempSync(join(tmpdir(), "dsh-pool-prewarm-"));
process.env.DSH_HOME = HOME;
const spawnLog = join(HOME, "spawns.log");
const frameLog = join(HOME, "frames.jsonl");
process.env.DSH_FAKE_LOG = frameLog;
process.env.DSH_FAKE_MODE = "live";
process.on("exit", () => {
  for (const dir of [HOME, process.env.DSH_HOME]) {
    if (dir === undefined || dir === "" || !dir.includes("dsh-pool-prewarm-")) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

const PROFILE = "paseo";

/**
 * The non-identity key the retirement section sets on the first session of a
 * connection: it is what a prewarmed child was **not** born with, so it is what
 * makes `#retireUnusedPrewarmFor` retire that child and respawn with this env.
 */
const APPLIED_ENV_KEY = "DSH_PREWARM_APPLIED_KEY";
const APPLIED_ENV_VALUE = "applied-by-the-first-session";

/** Single-quote one string for embedding in the generated `bash` wrapper. */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Every spawn appends its pid and wall-clock timestamp, so "did a second child
// start" is answerable from outside the provider.
//
// `--version` is answered here and never becomes the bridge: `catalogFingerprint`
// runs `dsh --version`, and letting that reach the fake would put a version probe
// in the spawn log as if it were a child.
//
// The spawn env is recorded too: the retirement path (`#retireUnusedPrewarmFor`)
// respawns a child **with the first session's env**, and the only place that can
// be observed is inside the child process. Same wrapper trick as
// `multi-session-check.mjs`: record, then `exec` the bridge under the same pid.
const spawnEnvLog = join(HOME, "spawn-env.log");
const wrapper = join(HOME, "fake-dsh-wrapper.sh");
writeFileSync(
  wrapper,
  [
    "#!/usr/bin/env bash",
    'if [ "$1" = "--version" ]; then echo "0.0.0-pool-prewarm-check"; exit 0; fi',
    `printf 'spawn %s %s\\n' "$$" "$(date +%s%3N)" >> ${shellQuote(spawnLog)}`,
    // No `${VAR-default}` in the generated script: this file is a template
    // literal, so `${` would be read as a JS interpolation. The whole environment
    // is recorded instead (`env`), with a pid marker line before it.
    `printf 'env %s\\n' "$$" >> ${shellQuote(spawnEnvLog)}`,
    `env >> ${shellQuote(spawnEnvLog)}`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(fakeBridge)} "$@"`,
    "",
  ].join("\n"),
);
chmodSync(wrapper, 0o755);
process.env.DSH_BINARY = wrapper;

// The plugin logs the prewarm's outcome (and its own spawn failures) to stderr.
// Capture it instead of letting it scroll past: "loud and non-fatal" is one of
// the assertions, and it is only checkable through that channel.
const stderrChunks = [];
const originalStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  try {
    stderrChunks.push(String(chunk));
  } catch {
    /* a non-string chunk is not interesting here */
  }
  return originalStderr(chunk, ...rest);
};
const stderrText = () => stderrChunks.join("");

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-pool-prewarm");
const plugin = require(join(buildDir, "index.server.js")).default;
const catalogApi = require(join(buildDir, "server", "catalog-cache.js"));
const processApi = require(join(buildDir, "server", "dsh-process.js"));

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

/** Every spawn the fake `dsh` made, oldest first. */
function spawns() {
  if (!existsSync(spawnLog)) return [];
  return readFileSync(spawnLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [kind, pid, at] = line.trim().split(/\s+/);
      return { kind, pid: Number(pid), at: Number(at) };
    });
}

/**
 * The env each spawned child was started with, keyed by pid.
 *
 * `APPLIED_ENV_KEY` is what the retirement section looks for; `PASEO_AGENT_ID` is
 * the control that shows the added key did not smuggle an identity key in with it.
 */
function spawnEnvs() {
  const out = new Map();
  if (!existsSync(spawnEnvLog)) return out;
  let current;
  for (const line of readFileSync(spawnEnvLog, "utf8").split("\n")) {
    if (line.startsWith("env ")) {
      current = {};
      out.set(Number(line.slice(4).trim()), current);
      continue;
    }
    if (current === undefined) continue;
    const eq = line.indexOf("=");
    if (eq > 0) current[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Every frame the fake `dsh` children received, oldest first. */
function frames() {
  if (!existsSync(frameLog)) return [];
  return readFileSync(frameLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** Whether a pid names a live process (the provider's own view of "alive"). */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll `predicate` until it is true or the deadline passes. */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label} after ${String(timeoutMs)} ms`);
}

/**
 * Wait until the prewarm reports **this** pid on stderr.
 *
 * A regex over the whole captured output would match the previous section's line
 * and pass before the child under test is even published, which is exactly the
 * window in which "the prewarm ran" and "the prewarm is serving" differ.
 */
async function waitForPrewarmLog(pid, from = 0) {
  await waitFor(
    () => stderrChunks.slice(from).join("").includes(`prewarmed the shared dsh (pid ${String(pid)})`),
    10000,
    `the prewarm log line for pid ${String(pid)}`,
  );
}

/** The pid of the fake bridge that served a method (optionally for one session). */
function vias(method, sessionId) {
  return frames()
    .filter((frame) => frame.method === method && (sessionId === undefined || frame.params?.sessionId === sessionId))
    .map((frame) => frame.pid);
}

/** Frames received by one pid. */
function framesOf(pid) {
  return frames().filter((frame) => frame.pid === pid);
}

/**
 * Prime the on-disk catalog cache the prewarm reads.
 *
 * This is the state every profile that has been used at least once is in: any
 * open wrote the catalog through `writeCatalogCache`. The entry is written with
 * the plugin's **own** fingerprint and path helpers, so the assertion below is
 * about the prewarm reading the cache it is supposed to read, not about the
 * check reproducing the cache layout by hand.
 *
 * The route is deliberately unlike the fake bridge's own (`fake/fake`) and unlike
 * the "no default" sentinel: the `initialize` frame can then only match the cached
 * fallback route.
 */
let PRIMED_WORKSPACE = "";

function primeCatalogCache(home) {
  const fingerprint = catalogApi.catalogFingerprint({
    home,
    profile: PROFILE,
    binary: processApi.resolveDshBinary(),
  });
  const workspace = join(home, "primed-workspace");
  mkdirSync(workspace, { recursive: true });
  PRIMED_WORKSPACE = workspace;
  const models = [
    {
      id: "cache-lane/cache-default-model",
      label: "Cache Default",
      description: "cache-lane",
      thinkingOptions: [{ id: "high", label: "High" }],
      defaultThinkingOptionId: "high",
    },
  ];
  const written = catalogApi.writeCatalogCache({
    path: catalogApi.catalogCachePath({ home, profile: PROFILE, cwd: workspace }),
    fingerprint,
    catalog: {
      models,
      thinkingOptions: [{ id: "high", label: "High" }],
      fallbackRoute: { provider: "cache-lane", model: "cache-default-model" },
      defaults: {
        models,
        modes: [{ id: "build", label: "Build" }],
        defaultModel: "cache-lane/cache-default-model",
        defaultMode: "build",
        defaultThinkingOption: "high",
      },
    },
  });
  if (!written) throw new Error("could not prime the catalog cache");
}

/**
 * Open one provider session and resolve once it is ready.
 *
 * @returns the events published for that open, or the failure events when the
 *   open was refused (the caller decides which it expects).
 */
async function openSession(conn, events, sessionId, env) {
  const mark = events.length;
  await conn.send({
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    // The primed workspace, so `loadCatalog` hits the disk cache instead of
    // spawning a throwaway probe: probes are `catalog-cache-check`'s subject, and
    // letting one into this log would make every spawn count ambiguous.
    config: {
      cwd: PRIMED_WORKSPACE === "" ? process.cwd() : PRIMED_WORKSPACE,
      mode: "build",
      ...(env === undefined ? {} : { env }),
    },
    history: "skip",
  });
  try {
    await waitFor(
      () => events.slice(mark).some((event) => event.type === "session.ready" && event.sessionId === sessionId),
      20000,
      `session.ready for ${sessionId}`,
    );
    return { ready: true, events: events.slice(mark) };
  } catch (error) {
    const failures = events
      .slice(mark)
      .filter((event) => event.type === "request.failed" || event.type === "session.runtime_failed");
    return {
      ready: false,
      error: error instanceof Error ? error.message : String(error),
      events: events.slice(mark),
      failures,
    };
  }
}

// ---------------------------------------------------------------------------
// a) + f): connect() starts the child, with the profile's cached default route.
console.log("a session-less connect spawns the shared child with the profile default route");
primeCatalogCache(HOME);
process.env.DSH_FAKE_MODE = "live";

const firstStderrMark = stderrChunks.length;
let conn = await registration.connect({ capabilities: ["prompt.message"] });
let events = [];
conn.onEvent((event) => events.push(event));

let prewarmSpawned = false;
try {
  // The spawn line is written before the child has even read its stdin, so wait
  // for the frame the provider's `start()` sends and for the log line it prints
  // once the child is serving — the two facts the assertions below are about.
  await waitFor(() => spawns().length >= 1, 10000, "the prewarm spawn");
  await waitFor(() => vias("initialize").length >= 1, 10000, "the prewarm's initialize frame");
  await waitForPrewarmLog(spawns()[0]?.pid, firstStderrMark);
  prewarmSpawned = true;
} catch {
  /* reported by the assertion below */
}
const firstSpawns = spawns();
const prewarmPid = firstSpawns[0]?.pid;
check(
  "connect spawns the shared child with no session open",
  prewarmSpawned && firstSpawns.length === 1,
  `${String(firstSpawns.length)} spawn(s)${prewarmPid === undefined ? "" : `, pid ${String(prewarmPid)}`}`,
);
check(
  "the prewarm takes no claim on the child",
  conn.poolClaimCount === 0,
  `${String(conn.poolClaimCount)} claim(s) after the prewarm`,
);
{
  const initialize = prewarmPid === undefined
    ? undefined
    : framesOf(prewarmPid).find((frame) => frame.method === "initialize");
  check(
    "the prewarm spawns with the catalog's fallback route",
    initialize?.params?.provider === "cache-lane" && initialize?.params?.model === "cache-default-model",
    initialize === undefined ? "(no initialize frame)" : `${String(initialize.params?.provider)}/${String(initialize.params?.model)}`,
  );
  check(
    "…and the prewarm reports itself on stderr",
    /prewarmed the shared dsh \(pid \d+\)/.test(stderrText()),
    stderrText().split("\n").filter((line) => line.includes("prewarmed")).join(" | ") || "(nothing logged)",
  );
}

// ---------------------------------------------------------------------------
// b) the first open reuses it.
console.log("\nthe first session open reuses the prewarmed child");
{
  const spawnCountBefore = spawns().length;
  const opened = await openSession(conn, events, "prewarm-first");
  check("the first session opened", opened.ready === true, opened.ready ? "ready" : (opened.error ?? "no error"));
  check(
    "…without spawning a second child",
    spawns().length === spawnCountBefore,
    `${String(spawns().length - spawnCountBefore)} extra spawn(s)`,
  );
  check(
    "…on the prewarmed process (its own session initialize carries that pid)",
    prewarmPid !== undefined && vias("initialize", "prewarm-first").includes(prewarmPid),
    `initialize pids ${vias("initialize", "prewarm-first").join(",") || "(none)"}`,
  );
  check(
    "the open took exactly one claim (then the prewarm's marker is gone)",
    conn.poolClaimCount === 1,
    `${String(conn.poolClaimCount)} claim(s)`,
  );
}

// ---------------------------------------------------------------------------
// b2) the control: an env with only the daemon's per-agent identity keys does
// **not** retire the prewarmed child.
console.log("\na first session whose env carries only the identity keys keeps the prewarmed child");
{
  const spawnMark = spawns().length;
  const stderrMark = stderrChunks.length;
  const envConn = await registration.connect({ capabilities: ["prompt.message"] });
  const envEvents = [];
  envConn.onEvent((event) => envEvents.push(event));
  let idPid;
  let prewarmed = false;
  try {
    await waitFor(() => spawns().length > spawnMark, 10000, "the identity-only connection's prewarm spawn");
    idPid = spawns().at(-1)?.pid;
    await waitForPrewarmLog(idPid, stderrMark);
    prewarmed = true;
  } catch {
    /* reported below */
  }
  check("the identity-only connection prewarmed a child", prewarmed, `pid ${String(idPid)}`);
  const opened = await openSession(envConn, envEvents, "identity-only", {
    PASEO_AGENT_ID: "agent-identity-only",
    PASEO_AGENT_CWD: PRIMED_WORKSPACE,
    PASEO_WORKSPACE_ID: "workspace-identity-only",
  });
  check("…its session opened", opened.ready === true, opened.ready ? "ready" : (opened.error ?? "no error"));
  check(
    "…on the prewarmed child, with no second spawn",
    idPid !== undefined && vias("initialize", "identity-only").includes(idPid) && spawns().length === spawnMark + 1,
    `initialize pids ${vias("initialize", "identity-only").join(",") || "(none)"}, `
      + `${String(spawns().length - spawnMark - 1)} extra spawn(s)`,
  );
  const window = stderrChunks.slice(stderrMark).join("");
  check(
    "…and the identity keys alone never retire it",
    !window.includes("retiring it"),
    window.split("\n").filter((line) => line.includes("retiring it")).join(" | ") || "(no retirement)",
  );
  await envConn.close();
}

// ---------------------------------------------------------------------------
// b3) a first session that really sets env keys retires the **unused** prewarm
// and respawns with that env (`#retireUnusedPrewarmFor`).
//
// A prewarmed child has no session to take an env from, so it is spawned with
// none; without this path the first session's real keys would be silently inert.
// The old contract — the first session of a connection defines the process
// environment — survives at the cost of one cold boot on a path a real daemon
// never takes (its only env keys are the exempt identity ones).
console.log("\na first session with a non-identity env key retires the unused prewarm and respawns");
{
  const spawnMark = spawns().length;
  const stderrMark = stderrChunks.length;
  const retireConn = await registration.connect({ capabilities: ["prompt.message"] });
  const retireEvents = [];
  retireConn.onEvent((event) => retireEvents.push(event));
  let oldPid;
  let prewarmed = false;
  try {
    await waitFor(() => spawns().length > spawnMark, 10000, "the retiring connection's prewarm spawn");
    oldPid = spawns().at(-1)?.pid;
    await waitForPrewarmLog(oldPid, stderrMark);
    prewarmed = true;
  } catch {
    /* reported below */
  }
  check("the retiring connection prewarmed a child", prewarmed, `pid ${String(oldPid)}`);

  const opened = await openSession(retireConn, retireEvents, "env-retires-prewarm", {
    PASEO_AGENT_ID: "agent-retire",
    PASEO_AGENT_CWD: PRIMED_WORKSPACE,
    [APPLIED_ENV_KEY]: APPLIED_ENV_VALUE,
  });
  check(
    "the session opened on a child that carries its env",
    opened.ready === true
      && opened.events.every((event) => event.notice?.title !== "会话环境变量未生效"),
    opened.ready
      ? `ready; notices ${opened.events.filter((event) => event.type === "session.notice").map((event) => String(event.notice?.title)).join(",") || "(none)"}`
      : (opened.error ?? "no error"),
  );

  const forThisConnection = spawns().slice(spawnMark);
  const newPid = forThisConnection.at(-1)?.pid;
  check(
    "…after exactly one replacement spawn for that connection",
    forThisConnection.length === 2 && newPid !== oldPid,
    `${String(forThisConnection.length)} spawn(s): ${forThisConnection.map((entry) => String(entry.pid)).join(",")}`,
  );
  check(
    "…whose spawn env really holds the session's non-identity key",
    newPid !== undefined && spawnEnvs().get(newPid)?.[APPLIED_ENV_KEY] === APPLIED_ENV_VALUE,
    newPid === undefined
      ? "(no replacement pid)"
      : `${APPLIED_ENV_KEY}=${String(spawnEnvs().get(newPid)?.[APPLIED_ENV_KEY])}`,
  );
  check(
    "…and still no identity key (the respawn did not let one in)",
    newPid !== undefined && newPid !== oldPid
      && !("PASEO_AGENT_ID" in (spawnEnvs().get(newPid) ?? {}))
      && !("PASEO_AGENT_CWD" in (spawnEnvs().get(newPid) ?? {}))
      && !("PASEO_WORKSPACE_ID" in (spawnEnvs().get(newPid) ?? {})),
    JSON.stringify(
      ["PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_WORKSPACE_ID"]
        .filter((key) => key in (spawnEnvs().get(newPid ?? 0) ?? {})),
    ),
  );
  let oldRetired = false;
  try {
    oldRetired = await waitFor(
      () => !alive(oldPid) && framesOf(oldPid ?? 0).some((frame) => frame.method === "shutdown"),
      10000,
      "the prewarmed child's shutdown",
    );
  } catch {
    /* reported below */
  }
  check(
    "the prewarmed child was torn down (shutdown frame, then exited)",
    oldRetired === true && !alive(oldPid),
    `pid ${String(oldPid)} shutdown=${
      String(framesOf(oldPid ?? 0).some((frame) => frame.method === "shutdown"))
    } alive=${String(alive(oldPid))}`,
  );
  const retireLine = stderrChunks.slice(stderrMark).join("")
    .split("\n")
    .find((line) => line.includes("retiring it"));
  check(
    "…and the retirement is reported on stderr, naming that pid",
    oldPid !== undefined && retireLine !== undefined
      && retireLine.includes(`pid ${String(oldPid)}`)
      && retireLine.includes(APPLIED_ENV_KEY),
    retireLine ?? "(nothing logged)",
  );
  await retireConn.close();
}

// ---------------------------------------------------------------------------
// b) an open that races the prewarm's in-flight spawn joins it.
console.log("\nan open that races the prewarm's spawn joins it instead of spawning");
await conn.close();
{
  // Park the process-level `initialize`, which is the request `DshProcess.start()`
  // awaits: the prewarm is then provably still starting when the open arrives.
  const holdReady = join(HOME, "initialize-hold.ready");
  const holdRelease = join(HOME, "initialize-hold.release");
  process.env.DSH_FAKE_HOLD_METHOD = "initialize";
  process.env.DSH_FAKE_HOLD_READY = holdReady;
  process.env.DSH_FAKE_HOLD_RELEASE = holdRelease;

  const racing = await registration.connect({ capabilities: ["prompt.message"] });
  const racingEvents = [];
  racing.onEvent((event) => racingEvents.push(event));

  let parked = false;
  try {
    await waitFor(() => existsSync(holdReady), 10000, "the prewarm's parked initialize");
    parked = true;
  } catch {
    /* a prewarm that never started cannot park; reported below */
  }
  check(
    "the prewarm's spawn is parked in `initialize` (precondition for this race)",
    parked,
    parked ? holdReady : "the prewarm never reached initialize",
  );
  const spawnCount = spawns().length;
  const openTask = openSession(racing, racingEvents, "prewarm-racing");
  await sleep(400);
  check(
    "no second child is spawned while the prewarm's spawn is in flight",
    spawns().length === spawnCount,
    `${String(spawns().length - spawnCount)} extra spawn(s)`,
  );
  writeFileSync(holdRelease, "go");
  const raced = await openTask;
  check("the racing open succeeded once the prewarm's spawn finished", raced.ready === true, raced.ready ? "ready" : (raced.error ?? "no error"));
  check(
    "…still on one spawn for the whole race",
    spawns().length === spawnCount,
    `${String(spawns().length - spawnCount)} extra spawn(s) after the release`,
  );
  await racing.close();
  delete process.env.DSH_FAKE_HOLD_METHOD;
  delete process.env.DSH_FAKE_HOLD_READY;
  delete process.env.DSH_FAKE_HOLD_RELEASE;
  try {
    rmSync(holdReady, { force: true });
    rmSync(holdRelease, { force: true });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// c) the child stays resident past the old idle-retirement window.
console.log("\nthe child stays resident after the last session closes");
{
  const spawnMark = spawns().length;
  const stderrMark = stderrChunks.length;
  conn = await registration.connect({ capabilities: ["prompt.message"] });
  events = [];
  conn.onEvent((event) => events.push(event));
  let residentPid;
  let prewarmed = false;
  try {
    await waitFor(() => spawns().length > spawnMark, 10000, "the second connection's prewarm spawn");
    residentPid = spawns().at(-1)?.pid;
    await waitForPrewarmLog(residentPid, stderrMark);
    prewarmed = true;
  } catch {
    /* reported below; the assertions after the open still say what went wrong */
  }
  check("the second connection prewarmed a child", prewarmed, `pid ${String(residentPid)}`);
  const opened = await openSession(conn, events, "resident-first");
  residentPid ??= spawns().at(-1)?.pid;
  check("the session opened", opened.ready === true, opened.ready ? "ready" : (opened.error ?? "no error"));
  await conn.send({ type: "session.close", sessionId: "resident-first" });
  const spawnCountBefore = spawns().length;
  // The old pool retired an idle child after `POOL_RELEASE_GRACE_MS` (5 s). The
  // wait is deliberately past that whole window, teardown included.
  await sleep(6500);
  check(
    "the child is still alive 6.5 s after its last session closed",
    alive(residentPid),
    `pid ${String(residentPid)} alive=${String(alive(residentPid))}`,
  );
  check(
    "…and no `shutdown` frame was sent to it (it was not retired)",
    residentPid !== undefined && !framesOf(residentPid).some((frame) => frame.method === "shutdown"),
    framesOf(residentPid ?? 0).map((frame) => frame.method).filter((method) => method === "shutdown").join(",") || "(none)",
  );
  check(
    "…and the next open reuses the same pid",
    (await openSession(conn, events, "resident-second")).ready === true
      && vias("initialize", "resident-second").includes(residentPid)
      && spawns().length === spawnCountBefore,
    `initialize pids ${vias("initialize", "resident-second").join(",") || "(none)"}, `
      + `${String(spawns().length - spawnCountBefore)} extra spawn(s)`,
  );
  await conn.close();
  let retired = false;
  try {
    retired = await waitFor(() => !alive(residentPid), 10000, "the resident child's exit");
  } catch {
    /* reported below */
  }
  check(
    "close() retires the resident child",
    retired === true && !alive(residentPid),
    `pid ${String(residentPid)} alive=${String(alive(residentPid))}`,
  );
}

// ---------------------------------------------------------------------------
// d) close() still shuts the child down.
console.log("\nclose() shuts the child down");
{
  // The teardown above is the same path; assert it directly on the pid and frame
  // that the previous section produced, plus one fresh connection so the
  // assertion does not depend on that section's bookkeeping.
  const spawnMark = spawns().length;
  const stderrMark = stderrChunks.length;
  const closed = await registration.connect({ capabilities: ["prompt.message"] });
  const closedEvents = [];
  closed.onEvent((event) => closedEvents.push(event));
  let pid;
  let prewarmed = false;
  try {
    await waitFor(() => spawns().length > spawnMark, 10000, "the teardown connection's prewarm spawn");
    pid = spawns().at(-1)?.pid;
    // Published before the teardown starts: a `close()` that lands while the spawn
    // is still in flight kills the child instead (the provider cannot publish onto
    // a dead connection), which is a different path than the one under test here.
    await waitForPrewarmLog(pid, stderrMark);
    prewarmed = true;
  } catch {
    /* reported below */
  }
  check("the teardown connection prewarmed a child", prewarmed, `pid ${String(pid)}`);
  await closed.close();
  let gone = false;
  try {
    gone = await waitFor(() => !alive(pid), 10000, "the child's exit after close()");
  } catch {
    /* reported below */
  }
  check(
    "the shared child exits after close()",
    gone === true,
    `pid ${String(pid)} alive=${String(alive(pid))}`,
  );
  check(
    "…because teardown sent it a `shutdown` frame",
    pid !== undefined && framesOf(pid).some((frame) => frame.method === "shutdown"),
    framesOf(pid ?? 0).map((frame) => frame.method).join(",") || "(no frames)",
  );
}

// ---------------------------------------------------------------------------
// e) a failed prewarm is loud, non-fatal, and not cached as ready.
console.log("\na failed prewarm is reported and retried by the next open");
{
  process.env.DSH_FAKE_MODE = "failopen";
  const stderrMark = stderrChunks.length;
  const spawnCountBefore = spawns().length;
  const failing = await registration.connect({ capabilities: ["prompt.message"] });
  const failingEvents = [];
  failing.onEvent((event) => failingEvents.push(event));
  check("connect succeeds even though the prewarm fails", failing !== undefined, "connection returned");
  let logged = false;
  try {
    await waitFor(() => /prewarm failed/.test(stderrChunks.slice(stderrMark).join("")), 12000, "the prewarm failure line");
    logged = true;
  } catch {
    /* reported below */
  }
  const failureText = stderrChunks.slice(stderrMark).join("").split("\n").filter((line) => line.includes("prewarm failed")).join(" | ");
  check("…and the failure is on stderr", logged, failureText || "(nothing logged)");
  check(
    "the failed prewarm did look like a spawn attempt",
    spawns().length === spawnCountBefore + 1,
    `${String(spawns().length - spawnCountBefore)} spawn(s)`,
  );

  // The next open must spawn again rather than reuse the failure: with the
  // runtime still refusing `initialize`, that open fails and says so.
  const spawnsBeforeOpen = spawns().length;
  const opened = await openSession(failing, failingEvents, "prewarm-after-failure");
  check(
    "the next open spawns again (the failure was not cached as ready)",
    spawns().length === spawnsBeforeOpen + 1,
    `${String(spawns().length - spawnsBeforeOpen)} spawn(s)`,
  );
  check(
    "…and reports its own failure to the user",
    opened.ready === false && opened.failures.length > 0,
    opened.failures.map((event) => event.error?.message ?? event.type).join(" | ") || (opened.error ?? "no failure event"),
  );
  await failing.close();
  process.env.DSH_FAKE_MODE = "live";
}

// ---------------------------------------------------------------------------
// g) no catalog cache: no probe, no spawn, one line.
console.log("\na profile with no catalog cache is left to its first open");
{
  const coldHome = mkdtempSync(join(tmpdir(), "dsh-pool-prewarm-cold-"));
  process.env.DSH_HOME = coldHome;
  const coldSpawnLog = spawnLog;
  void coldSpawnLog;
  const spawnCountBefore = spawns().length;
  const stderrMark = stderrChunks.length;
  const cold = await registration.connect({ capabilities: ["prompt.message"] });
  await sleep(1500);
  const lines = stderrChunks.slice(stderrMark).join("");
  check(
    "no child and no probe are spawned without a cached catalog",
    spawns().length === spawnCountBefore,
    `${String(spawns().length - spawnCountBefore)} spawn(s)`,
  );
  check(
    "…and the skip is reported on stderr",
    /prewarm skipped/.test(lines),
    lines.split("\n").filter((line) => line.includes("prewarm skipped")).join(" | ") || "(nothing logged)",
  );
  await cold.close();
  try {
    rmSync(coldHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  process.env.DSH_HOME = HOME;
}

process.stderr.write = originalStderr;
if (failed === 0) console.log(`\npool prewarm: OK (${String(passed)} checks)`);
console.log(`\n${String(passed)} passed, ${String(failed)} failed`);
process.exit(failed === 0 ? 0 : 1);