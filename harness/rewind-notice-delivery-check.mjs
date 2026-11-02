/**
 * Does a rewind report actually reach the user's timeline? Asserted on the real
 * host code and the real plugin in one process.
 *
 * `harness/session-request-check.cjs` proves the plugin *emits* the completion
 * notice after `request.completed`; `harness/host-contract-sim.mjs` proves what
 * the host does with the provider's history buffer. Neither can see the daemon's
 * timeline store, and that is where the notice was being lost: while a rewind is
 * in flight the host holds a foreground run lock (`AgentManager.rewind` in
 * `agent-manager.js`: `createPendingRun` before the provider call,
 * `settleForegroundRun` in the `finally`), and `enqueueSessionEvent` pushes every
 * provider event into `pendingRun.stagedEvents` instead of dispatching it. Only
 * the normal prompt path ever replays those events; `settleForegroundRun` →
 * `clearRun` deletes the run and its staged events. A `session.notice` sent from
 * the rewind branch is therefore dropped — before *or* after the receipt, which
 * is why the completion report never appeared on a real daemon even though the
 * plugin sent it and the client had a renderer for it.
 *
 * This file drives the real `PluginAgentClientRegistry`, `AgentManager` and
 * `agent-run-state` from the installed host, with the plugin's own compiled
 * provider connected to them and `harness/fake-dsh-bridge.mjs` underneath as the
 * `dsh` runtime. One process, no daemon, no model. It asserts:
 *
 *   1. the completion report is **not** in the timeline when `rewind()` resolves
 *      (the host has just released the lock) but **is** there once the plugin's
 *      delivery delay has elapsed, and it arrives only after the lock was
 *      released — the ordering the delay exists to create;
 *   2. the plugin waits its documented delay after the receipt before sending
 *      it, and that delay keeps a margin over the host's own post-receipt tail
 *      (`hydrateTimelineFromProvider` + `refreshSessionState` +
 *      `persistSnapshot` + `emitState` + settle, measured here), so a report
 *      cannot be sent back into the window it is supposed to escape;
 *   3. the mechanism, independent of the plugin's current implementation: a
 *      `session.notice` injected through the same provider connection right
 *      after the receipt is dropped by the host, while the same event injected
 *      after the lock is released is kept. Without this pair the delay would
 *      look like a workaround rather than a requirement;
 *   4. the conversation/both shape too: the report survives a rewind whose tail
 *      also rebuilds the timeline from provider history, and the withdrawn rows
 *      are gone.
 *
 * The rewind canary is out of scope: it is sent *before* the receipt on purpose
 * (its ordering is the probe) and this check only reports what the timeline does
 * with it. See `docs/FIELD-NOTES.md` for the delivery finding.
 *
 * Run (from the repo root):
 *   node harness/rewind-notice-delivery-check.mjs [compiled-plugin-dir]
 *
 * Without an argument the plugin is compiled into `paseo-plugin/.dbg-p15-delivery`
 * by `harness/plugin-build.cjs`; `PASEO_CLI_ROOT` overrides the host location.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolvePluginBuild } = require(join(here, "plugin-build.cjs"));

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

// ---------------------------------------------------------------------------
// The `dsh` underneath the plugin: the scripted fake bridge, in `live` mode so
// a prompt produces real timeline rows (a user row with a revert token, and its
// answer). The plugin is required *after* these are set: it reads `DSH_BINARY`
// and pins its display locale at module load, exactly like the daemon's process.
// ---------------------------------------------------------------------------
const fakeBridge = join(here, "fake-dsh-bridge.mjs");
fs.chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "live";
process.env.DSH_PASEO_LANG = "zh-CN";
// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which rewrites `$DSH_HOME/profiles/<name>` from the
// bridge embedded in the plugin. The fake `dsh` needs no profile.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rewind-delivery-"));
process.on("exit", () => {
  try {
    fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** Minimal `which`, same reasoning as `host-contract-sim.mjs`: no shell, no alias. */
function whichSync(name) {
  const separator = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(separator)) {
    if (dir === "") continue;
    try {
      if (fs.readFileSync(join(dir, name)).length >= 0) return join(dir, name);
    } catch {
      /* not here */
    }
  }
  return null;
}

/** The installed Paseo CLI's package root (`PASEO_CLI_ROOT` wins). */
function resolvePaseoCliRoot() {
  const fromEnv = process.env.PASEO_CLI_ROOT;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  for (const name of ["paseo", "paseo.cmd", "paseo.ps1"]) {
    const found = whichSync(name);
    if (found === null) continue;
    let real;
    try {
      real = fs.realpathSync(found);
    } catch {
      continue;
    }
    const candidate = dirname(dirname(real));
    try {
      if (fs.readFileSync(join(candidate, "node_modules", "@getpaseo", "server", "package.json")).length > 0) {
        return candidate;
      }
    } catch {
      /* not the CLI package root */
    }
  }
  return null;
}

const cliRoot = resolvePaseoCliRoot();
if (cliRoot === null) {
  console.error("cannot locate the Paseo host: set PASEO_CLI_ROOT");
  process.exit(2);
}
const hostAgentDir = join(cliRoot, "node_modules", "@getpaseo", "server", "dist", "server", "server", "agent");

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-p15-delivery");
console.log(`plugin build: ${buildDir}`);
console.log(`host:         ${hostAgentDir}`);

// The delivery policy the fix introduces. Loaded lazily so a build without it
// reports a missing module instead of dying before the behavioural assertions
// run — this is exactly the state the check has to describe as red.
let delivery;
try {
  delivery = require(join(buildDir, "server", "rewind-delivery.js"));
} catch (error) {
  delivery = undefined;
  console.log(`  note  server/rewind-delivery.js is missing (${error.code ?? error.message})`);
}
const delayMs = delivery?.REWIND_NOTICE_DELAY_MS;

// Expected copy, from the plugin's own table and locale resolution — a copy here
// would be a second definition that could drift from what users see.
const { rewindSuccessText } = require(join(buildDir, "shared", "rewind-notice.js"));
const { UI } = require(join(buildDir, "server", "locale.js"));
const FILES_REPORT = rewindSuccessText(UI.rewind, "files", undefined);
const CONVERSATION_REPORT = rewindSuccessText(UI.rewind, "conversation", undefined);
const CANARY_PREFIX = "撤回已生效";
const IMMEDIATE_PROBE = "p15-immediate-probe";
const AFTER_SETTLE_PROBE = "p15-after-settle-probe";

// ---------------------------------------------------------------------------
// The plugin, registered into the host's own registry. `connect()` is what the
// daemon calls; the wrapper is the check's window into the provider connection:
// it timestamps every event the plugin sends and keeps the host's listener so a
// synthetic event can be delivered exactly when the mechanism needs it.
// ---------------------------------------------------------------------------
const plugin = require(join(buildDir, "index.server.js")).default;
let registration;
plugin({
  handle() {},
  registerProvider(candidate) {
    registration = candidate;
  },
  registerSettings() {},
  on() {},
  before() {},
});
if (registration === undefined) {
  console.error("the plugin registered no provider");
  process.exit(2);
}

const emitted = [];
const settles = [];
let hostListener;
let observedSessionId;
let revertInFlight = false;
let immediateProbeAt;
let immediateProbeInjected = false;

const wrappedRegistration = {
  ...registration,
  async connect(request) {
    const conn = await registration.connect(request);
    const origOnEvent = conn.onEvent.bind(conn);
    const origSend = conn.send.bind(conn);
    conn.onEvent = (listener) => {
      // The host's own listener (it parses the event against the provider
      // contract, then accepts it). Kept for the mechanism half below.
      hostListener = listener;
      return origOnEvent((event) => {
        emitted.push({ at: Date.now(), event });
        if (observedSessionId === undefined && typeof event.sessionId === "string") {
          observedSessionId = event.sessionId;
        }
        listener(event);
        // Model the pre-fix plugin: the report sent in the same turn as the
        // receipt, i.e. while the host still holds the rewind run lock.
        if (revertInFlight && event.type === "request.completed") {
          revertInFlight = false;
          immediateProbeInjected = true;
          immediateProbeAt = Date.now();
          listener({
            type: "session.notice",
            sessionId: observedSessionId,
            notice: { id: "p15-immediate", severity: "info", title: IMMEDIATE_PROBE },
          });
        }
      });
    };
    conn.send = async (input) => {
      if (input?.type === "session.revert") revertInFlight = true;
      return origSend(input);
    };
    return conn;
  },
};

const logger = {
  child() {
    return logger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const { PluginAgentClientRegistry } = await import(pathToFileURL(join(hostAgentDir, "plugin-provider.js")).href);
const { AgentManager } = await import(pathToFileURL(join(hostAgentDir, "agent-manager.js")).href);

const registry = new PluginAgentClientRegistry(logger);
registry.replace([wrappedRegistration]);

// The daemon's real agent storage is a JSON snapshot written through
// `writeJsonFileAtomic`; the rewind tail awaits it. Modelled here as a short
// await so the measured tail is not microtask-only (that would make any timer
// look safe).
const SNAPSHOT_WRITE_MS = 3;
const storage = {
  async get() {
    return null;
  },
  async list() {
    return [];
  },
  async upsert() {},
  async applySnapshot() {
    await sleep(SNAPSHOT_WRITE_MS);
  },
};

const manager = new AgentManager({
  logger,
  clients: registry.clients(),
  providerDefinitions: registry.definitions(),
  registry: storage,
});

// `settleForegroundRun` is the release of the rewind's run lock; every event
// the plugin sends before this timestamp is dropped by `enqueueSessionEvent`.
const origSettle = manager.runs.settleForegroundRun.bind(manager.runs);
manager.runs.settleForegroundRun = (agentId, token) => {
  settles.push({ at: Date.now(), agentId });
  return origSettle(agentId, token);
};

/** The notification rows the daemon's timeline store holds for one agent. */
function notificationRows(agentId) {
  return manager.timelineStore
    .getRows(agentId)
    .filter((row) => row.item.type === "notification")
    .map((row) => String(row.item.message ?? ""));
}

/** A one-line description of the notification rows, for failure output. */
function describeRows(agentId) {
  const rows = notificationRows(agentId).map((text) => text.replace(/\n/gu, " / "));
  const joined = rows.join(" | ") || "(no notification rows)";
  return joined.length > 220 ? `${joined.slice(0, 217)}…` : joined;
}

async function waitForRow(agentId, text, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = manager.timelineStore.getRows(agentId).find(
      (candidate) => candidate.item.type === "notification" && candidate.item.message === text,
    );
    if (row !== undefined) return { row, at: Date.now() };
    await sleep(10);
  }
  return undefined;
}

/** The first plugin event of a kind since `sinceIndex`. */
function pluginEvent(sinceIndex, predicate) {
  return emitted.slice(sinceIndex).find((entry) => predicate(entry.event));
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rewind-cwd-"));
const agent = await manager.createAgent({ provider: registration.id, cwd }, undefined, { env: {} });
await sleep(200);
await manager.runAgent(agent.id, "hello", {});
const userRow = manager.timelineStore.getRows(agent.id).find((row) => row.item.type === "user_message");
if (userRow === undefined) {
  console.error("the fake prompt produced no user row; cannot drive a rewind");
  process.exit(2);
}
const messageId = userRow.item.messageId;

// ---------------------------------------------------------------------------
// 1–3. A files rewind: no conversation change, so no timeline rebuild — the
// shortest host tail there is. This is the scope the user tested when the
// report went missing.
// ---------------------------------------------------------------------------
console.log(`\nfiles rewind (expected report: ${JSON.stringify(FILES_REPORT)})`);
let filesTail = 0;
let filesSettledAt;
{
  const start = emitted.length;
  const rewindStart = Date.now();
  await manager.rewind(agent.id, messageId, "files");
  const resolvedAt = Date.now();
  const settle = settles[settles.length - 1];
  filesSettledAt = settle?.at;
  const receipt = pluginEvent(start, (event) => event.type === "request.completed");
  filesTail = settle !== undefined && receipt !== undefined ? settle.at - receipt.at : -1;

  check(
    "the report was not in the timeline when rewind() resolved (lock just released)",
    !notificationRows(agent.id).includes(FILES_REPORT),
    describeRows(agent.id),
  );

  const landed = await waitForRow(agent.id, FILES_REPORT);
  // Read the plugin's own send time only after the wait: the report is expected
  // to arrive during it, and searching earlier would assert on a missing event.
  const report = pluginEvent(
    start,
    (event) => event.type === "session.notice" && event.notice?.title === FILES_REPORT,
  );
  check(
    "the plugin sent the completion report at all",
    report !== undefined,
    report === undefined ? "no session.notice with the completion copy" : `at +${String(report.at - rewindStart)}ms`,
  );
  check(
    "…and it reached the timeline once the plugin's delay elapsed",
    landed !== undefined,
    landed === undefined ? `still absent after 3s; rows: ${describeRows(agent.id)}` : undefined,
  );
  check(
    "…after the host released the rewind lock, not before",
    landed !== undefined && filesSettledAt !== undefined && landed.at > filesSettledAt,
    landed === undefined || filesSettledAt === undefined
      ? "missing row or no settle recorded"
      : `report +${String(landed.at - rewindStart)}ms vs settle +${String(filesSettledAt - rewindStart)}ms`,
  );
  check(
    "the plugin waited its documented delay after the receipt",
    report !== undefined && receipt !== undefined && typeof delayMs === "number" && report.at - receipt.at >= delayMs - 30,
    report === undefined || receipt === undefined
      ? "missing report or receipt"
      : `delay ${String(report.at - receipt.at)}ms vs documented ${String(delayMs)}ms`,
  );

  // The mechanism, with the plugin out of the picture: the same event, sent
  // through the same connection, is dropped inside the window and kept outside.
  check(
    "the immediate probe was injected (the check exercised the pre-fix timing)",
    immediateProbeInjected,
    `at +${String((immediateProbeAt ?? rewindStart) - rewindStart)}ms`,
  );
  check(
    "a report sent with the receipt is dropped by the host (why the delay exists)",
    !notificationRows(agent.id).includes(IMMEDIATE_PROBE),
    describeRows(agent.id),
  );
  hostListener({
    type: "session.notice",
    sessionId: observedSessionId,
    notice: { id: "p15-after-settle", severity: "info", title: AFTER_SETTLE_PROBE },
  });
  const afterSettle = await waitForRow(agent.id, AFTER_SETTLE_PROBE, 1000);
  check(
    "…while the same event sent after the lock is released survives",
    afterSettle !== undefined,
    afterSettle === undefined ? "the post-settle probe never appeared" : undefined,
  );
  console.log(
    `  info  receipt→settle ${String(filesTail)}ms, receipt→report ${
      report === undefined || receipt === undefined ? "?" : String(report.at - receipt.at)
    }ms, rewind() ${String(resolvedAt - rewindStart)}ms`,
  );
}

// ---------------------------------------------------------------------------
// 4. A conversation rewind: the same report, but the host's tail also rebuilds
// the timeline from provider history (`hydrateTimelineFromProvider`), which is
// the longer tail the delay has to cover.
// ---------------------------------------------------------------------------
console.log(`\nconversation rewind (expected report: ${JSON.stringify(CONVERSATION_REPORT)})`);
let conversationTail = 0;
{
  const start = emitted.length;
  const rewindStart = Date.now();
  await manager.rewind(agent.id, messageId, "conversation");
  const resolvedAt = Date.now();
  const receipt = pluginEvent(start, (event) => event.type === "request.completed");
  const settle = settles[settles.length - 1];
  conversationTail = settle !== undefined && receipt !== undefined ? settle.at - receipt.at : -1;

  check(
    "the conversation rewind's report is not in the timeline when rewind() resolved",
    !notificationRows(agent.id).includes(CONVERSATION_REPORT),
    describeRows(agent.id),
  );
  const landed = await waitForRow(agent.id, CONVERSATION_REPORT);
  const report = pluginEvent(
    start,
    (event) => event.type === "session.notice" && event.notice?.title === CONVERSATION_REPORT,
  );
  check(
    "…and it reaches the timeline once the longer tail is over",
    landed !== undefined,
    landed === undefined ? `still absent after 3s; rows: ${describeRows(agent.id)}` : undefined,
  );
  const rows = manager.timelineStore.getRows(agent.id);
  check(
    "the withdrawn conversation is gone from the rebuilt timeline",
    !rows.some((row) => row.item.type === "assistant_message"),
    rows.map((row) => row.item.type).join(" | "),
  );
  check(
    "the plugin waited its documented delay after this receipt too",
    report !== undefined && receipt !== undefined && typeof delayMs === "number" && report.at - receipt.at >= delayMs - 30,
    report === undefined || receipt === undefined
      ? "missing report or receipt"
      : `delay ${String(report.at - receipt.at)}ms vs documented ${String(delayMs)}ms`,
  );
  console.log(
    `  info  receipt→settle ${String(conversationTail)}ms, receipt→report ${
      report === undefined || receipt === undefined ? "?" : String(report.at - receipt.at)
    }ms, rewind() ${String(resolvedAt - rewindStart)}ms`,
  );

  // Report only, no assertion: the canary is sent *before* the receipt on
  // purpose, and this check is not the place to change it.
  const canary = notificationRows(agent.id).find((text) => text.startsWith(CANARY_PREFIX));
  console.log(
    `  info  canary in the timeline: ${canary === undefined ? "absent" : JSON.stringify(canary)}`,
  );
}

// ---------------------------------------------------------------------------
// 5. The delay must dominate the host's own post-receipt work, not merely be
// "some timer": if a future host (or a slower snapshot write) makes the tail
// longer than the delay, the report falls back into the dropped window.
// ---------------------------------------------------------------------------
const maxTail = Math.max(filesTail, conversationTail);
check(
  "the documented delay keeps a margin over the measured host tail",
  typeof delayMs === "number" && maxTail >= 0 && delayMs - maxTail >= 100,
  `delay ${String(delayMs)}ms vs longest tail ${String(maxTail)}ms`,
);

console.log(`\n  ${passed}/${passed + failed} passed`);
await registry.shutdown().catch(() => undefined);
if (failed > 0) {
  console.log(`  ${failed} FAILED`);
  process.exit(1);
}
process.exit(0);
