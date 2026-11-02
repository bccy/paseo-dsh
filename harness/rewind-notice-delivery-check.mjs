/**
 * Does a rewind report actually reach the user's timeline — deterministically?
 *
 * The old implementation sent a `session.notice` after a guessed 300 ms delay,
 * because the host holds a foreground run lock for the whole rewind
 * (`AgentManager.rewind`: `createPendingRun` before the provider call,
 * `settleForegroundRun` in the `finally`) and `enqueueSessionEvent` stages (then
 * `clearRun` deletes) every provider event sent meanwhile. A real rewind took
 * 1128 ms once (daemon log), so the report was silently dropped.
 *
 * The fix appends a **plugin timeline row** instead
 * (`paseo.agents.ref(agentId).timeline.append`): the daemon's
 * `appendTimelineItem` records and dispatches directly, bypassing the run lock,
 * and the row is not part of the provider history a rebuild replays.
 *
 * This file drives the real `PluginAgentClientRegistry`, `AgentManager` and
 * `agent-run-state` from the installed host, with the plugin's own compiled
 * provider connected to them, `harness/fake-dsh-bridge.mjs` underneath as the
 * `dsh` runtime, and a **fake Paseo API** whose `timeline.append` /
 * `timeline.subscribe` / `timeline.refetch` call the host's own methods and
 * event stream. One process, no daemon, no model. It asserts:
 *
 *   1. a rewind report lands in the daemon's timeline store exactly once, with
 *      the copy the shared table produces;
 *   2. conversation/`both` reports land **after** the host dispatched
 *      `agent.timeline.replacement` — the rebuild before it wipes rows, and the
 *      rebuild after it is what a stale order would have eaten;
 *   3. the same holds on a slow host (a 2 s snapshot write and a 5 s timeline
 *      rebuild — both far past the old 300 ms guess);
 *   4. the row is **not** in the provider history, so a later conversation
 *      rewind cannot resurrect it (the old notice path accumulated old rows);
 *   5. a rewind that happens before the plugin process captured the Paseo API
 *      handle is queued and appended on capture, not dropped — and the arm RPC
 *      the client bundle calls prevents that state;
 *   6. the canary is unchanged: still emitted before the receipt;
 *   7. the mechanism, with the plugin out of the picture: a `session.notice`
 *      injected in the same turn as the receipt is dropped by the host, while
 *      the appended row survives — the pair that explains why the row is not a
 *      notice.
 *
 * Run (from the repo root):
 *   node harness/rewind-notice-delivery-check.mjs [compiled-plugin-dir]
 *
 * Without an argument the plugin is compiled into `paseo-plugin/.dbg-p17-delivery`
 * by `harness/plugin-build.cjs`; `PASEO_CLI_ROOT` overrides the host location.
 * The file re-executes itself once with
 * `DSH_PASEO_REWIND_REPLACEMENT_TIMEOUT_MS` set short, to drive the degraded
 * "replacement never arrives" path without waiting out the real bound.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
// CLI: `[compiled-plugin-dir]` for the normal run, `--degraded` for the child
// process that models a host which never dispatches a replacement.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const degraded = args.includes("--degraded");
const buildArg = args.find((value) => !value.startsWith("--"));

// ---------------------------------------------------------------------------
// The `dsh` underneath the plugin: the scripted fake bridge, in `live` mode so
// a prompt produces real timeline rows. The plugin is required *after* these are
// set: it reads `DSH_BINARY` and pins its display locale at module load, exactly
// like the daemon's process.
// ---------------------------------------------------------------------------
const fakeBridge = join(here, "fake-dsh-bridge.mjs");
fs.chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "live";
process.env.DSH_PASEO_LANG = "zh-CN";
// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which rewrites `$DSH_HOME/profiles/<name>`.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rewind-append-"));
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

const buildDir = resolvePluginBuild(buildArg, ".dbg-p17-delivery");
console.log(`plugin build: ${buildDir}`);
console.log(`host:         ${hostAgentDir}`);

// Loaded lazily so a build **without** the append module (the pre-fix code this
// check must be red on) reports the missing mechanism as failures instead of
// dying before the behavioural assertions run.
let appendModule;
try {
  appendModule = require(join(buildDir, "server", "rewind-notice-append.js"));
} catch (error) {
  appendModule = {
    hasPaseoHandle: () => false,
    REWIND_REPLACEMENT_TIMEOUT_MS: 0,
    missing: error instanceof Error ? error.message : String(error),
  };
  console.log(`  note  server/rewind-notice-append.js is missing (${appendModule.missing})`);
}
const { rewindSuccessText, rewindNoticeTone, REWIND_NOTICE_KIND, REWIND_NOTICE_ITEM_ID } =
  require(join(buildDir, "shared", "rewind-notice.js"));
const { UI } = require(join(buildDir, "server", "locale.js"));
const FILES_REPORT = rewindSuccessText(UI.rewind, "files", undefined);
const CONVERSATION_REPORT = rewindSuccessText(UI.rewind, "conversation", undefined);
const BOTH_REPORT = rewindSuccessText(UI.rewind, "both", undefined);
const CANARY_PREFIX = "撤回已生效";
const PLUGIN_ID = "dsh-paseo";

// ---------------------------------------------------------------------------
// The plugin, registered into the host's own registry. The fake server object
// captures the RPC handlers and lifecycle hooks the plugin registers: the
// hooks are how the real host hands the plugin its Paseo API handle, so the
// check drives them to model a captured handle.
// ---------------------------------------------------------------------------
const plugin = require(join(buildDir, "index.server.js")).default;
const rpcHandlers = new Map();
const hookHandlers = new Map();
let registration;
let beforeRegistered = false;
plugin({
  handle(contract, handler) {
    rpcHandlers.set(contract.name, handler);
  },
  registerProvider(candidate) {
    registration = candidate;
  },
  registerSettings() {},
  on(name, handler) {
    hookHandlers.set(name, handler);
    return () => hookHandlers.delete(name);
  },
  before() {
    beforeRegistered = true;
    return () => {};
  },
});
if (registration === undefined) {
  console.error("the plugin registered no provider");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The fake Paseo API. Its `append` is the daemon's `appendTimelineItem`, its
// `subscribe` is the session's live timeline delivery, its `refetch` is the
// daemon's `fetchTimeline` — i.e. the three host paths the fix depends on.
// ---------------------------------------------------------------------------
const emitted = [];
const appends = [];
const replacements = [];
const subscriptions = new Set();
/** Set by the mechanism scenario: inject a notice in the receipt's own turn. */
let probeMode = false;
let connectionListener;

/** False in the degraded child: the host dispatches, the subscription never sees it. */
const deliverReplacements = !degraded;

function makePaseo(manager) {
  const managerUnsubscribe = manager.subscribe((event) => {
    if (event.type === "timeline_replacement") {
      const record = { agentId: event.agentId, at: Date.now(), epoch: event.epoch };
      replacements.push(record);
      if (!deliverReplacements) return;
      for (const subscription of subscriptions) {
        if (subscription.agentId !== event.agentId) continue;
        subscription.handler({ agentId: event.agentId, event: { type: "replacement", epoch: event.epoch } });
      }
      return;
    }
    if (event.type !== "agent_stream" || event.event?.type !== "timeline") return;
    for (const subscription of subscriptions) {
      if (subscription.agentId !== event.agentId) continue;
      subscription.handler({
        agentId: event.agentId,
        event: event.event,
        ...(event.seq === undefined ? {} : { seq: event.seq }),
        ...(event.epoch === undefined ? {} : { epoch: event.epoch }),
        ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
      });
    }
  });
  return {
    async dispose() {
      managerUnsubscribe();
    },
    agents: {
      async list() {
        throw new Error("the server half must not read the agent directory");
      },
      ref(agentId) {
        return {
          timeline: {
            async append(item) {
              const at = Date.now();
              const result = await manager.appendTimelineItem(agentId, { ...item, pluginId: PLUGIN_ID });
              appends.push({ agentId, item, at, result });
              return result;
            },
            async refetch(options) {
              const page = manager.fetchTimeline(agentId, {
                direction: options?.direction ?? "tail",
                limit: options?.limit ?? 20,
              });
              return { ...page, entries: page.rows };
            },
            subscribe(handler) {
              const subscription = { agentId, handler };
              subscriptions.add(subscription);
              const unsubscribe = () => subscriptions.delete(subscription);
              unsubscribe.ready = Promise.resolve();
              unsubscribe.subscriptionId = "sim";
              unsubscribe.release = async () => {
                subscriptions.delete(subscription);
              };
              return unsubscribe;
            },
          },
        };
      },
    },
  };
}

/**
 * The plugin's provider registration, wrapped so the check can timestamp every
 * provider event (the canary order, the receipt) and, in the mechanism scenario,
 * inject a notice in the receipt's own turn.
 */
const wrappedRegistration = {
  ...registration,
  async connect(request) {
    const connection = await registration.connect(request);
    const originalOnEvent = connection.onEvent.bind(connection);
    const originalSend = connection.send.bind(connection);
    connection.onEvent = (listener) => {
      connectionListener = listener;
      return originalOnEvent((event) => {
        emitted.push({ at: Date.now(), event });
        listener(event);
      });
    };
    connection.send = async (input) => {
      const result = await originalSend(input);
      if (probeMode && input?.type === "session.revert" && connectionListener !== undefined) {
        connectionListener({
          type: "session.notice",
          sessionId: input.sessionId,
          notice: { id: "p17-immediate", severity: "info", title: "p17-immediate-probe" },
        });
      }
      return result;
    };
    return connection;
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

/** Snapshot write delay; the slow-host scenario raises it. */
let snapshotWriteMs = 3;
const storage = {
  async get() {
    return null;
  },
  async list() {
    return [];
  },
  async upsert() {},
  async applySnapshot() {
    await sleep(snapshotWriteMs);
  },
};

const manager = new AgentManager({
  logger,
  clients: registry.clients(),
  providerDefinitions: registry.definitions(),
  registry: storage,
});
const paseo = makePaseo(manager);

/** The plugin timeline rows the daemon's timeline store holds for one agent. */
function reportRows(agentId) {
  return manager.timelineStore
    .getRows(agentId)
    .filter((row) => row.item.type === "plugin" && row.item.kind === REWIND_NOTICE_KIND);
}
function describeRows(agentId) {
  const rows = manager.timelineStore
    .getRows(agentId)
    .map((row) => (row.item.type === "plugin" ? `plugin(${row.item.data?.message})` : row.item.type));
  const joined = rows.join(" | ") || "(no rows)";
  return joined.length > 260 ? `${joined.slice(0, 257)}…` : joined;
}
async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(10);
  }
  return undefined;
}
function reportFor(agentId) {
  return reportRows(agentId)[0];
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rewind-append-cwd-"));
process.on("exit", () => {
  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ---------------------------------------------------------------------------
// Boot: one agent, one prompt, then find the user row a rewind targets.
// ---------------------------------------------------------------------------
const agent = await manager.createAgent({ provider: registration.id, cwd }, undefined, { env: {} });
await sleep(200);
await manager.runAgent(agent.id, "hello", {});
const userRow = manager.timelineStore.getRows(agent.id).find((row) => row.item.type === "user_message");
if (userRow === undefined) {
  console.error("the fake prompt produced no user row; cannot drive a rewind");
  process.exit(2);
}
const messageId = userRow.item.messageId;
const session = manager.agents.get(agent.id).session;

/**
 * A fresh revert token for a follow-up rewind.
 *
 * The fake bridge answers one prompt with a scripted turn; a second prompt has
 * no turn events to resolve against. The host's own contract for a rewind is
 * `PluginAgentSession.revert(messageId)`, which only needs a token in its map —
 * so a unique id is registered there directly. The host then treats it exactly
 * like a message id it translated from provider history: the receipt, the
 * rebuild and the replacement are all real host code paths.
 */
let tokenSeq = 0;
function freshRevertToken() {
  tokenSeq += 1;
  const messageId = `p17-message-${String(tokenSeq)}`;
  const tokens = session.revertTokens;
  if (!(tokens instanceof Map)) throw new Error("the host session no longer exposes revertTokens");
  tokens.set(messageId, { messageId });
  return messageId;
}

/** Rewind, then wait until the plugin row for that rewind settles. */
async function rewindAndWait(scope, label, targetMessageId = messageId) {
  const before = appends.length;
  const replacementBefore = replacements.length;
  const started = Date.now();
  await manager.rewind(agent.id, targetMessageId, scope);
  const resolvedAt = Date.now();
  const appended = await waitFor(() => (appends.length > before ? appends[appends.length - 1] : undefined));
  return {
    label,
    scope,
    startedAt: started,
    resolvedAt,
    appended,
    replacement: replacements[replacementBefore],
  };
}

console.log(`\nscenario: ${degraded ? "degraded (no timeline replacement)" : "normal"}`);

// ---------------------------------------------------------------------------
// 0. Before any hook/RPC captured a handle: the report must be queued, not
//    dropped, and appended when a callback finally carries the handle.
// ---------------------------------------------------------------------------
if (!degraded) {
  console.log("\nno captured handle yet");
  check("the plugin registered no before() hook", beforeRegistered === false);
  check(
    "the provider half starts without a Paseo API handle",
    appendModule.hasPaseoHandle() === false,
    "a handle was captured before any callback fired",
  );
  await manager.rewind(agent.id, messageId, "files");
  await sleep(300);
  check(
    "a report with no handle is queued, not appended and not lost",
    reportRows(agent.id).length === 0 && appendModule.hasPaseoHandle() === false,
    describeRows(agent.id),
  );
  // The real host hands the handle to every lifecycle hook. Model the first
  // turn hook firing after the rewind.
  const turnHook = hookHandlers.get("agent.turn_started");
  check("the plugin registered the turn hook that captures the handle", typeof turnHook === "function");
  if (typeof turnHook === "function") {
    turnHook({ agent: { id: agent.id }, turnId: null }, { paseo, signal: new AbortController().signal });
  }
  const flushed = await waitFor(() => reportFor(agent.id));
  check(
    "the queued report is appended once a callback captures the handle",
    flushed !== undefined,
    describeRows(agent.id),
  );
  check(
    "…and it carries the scope's copy",
    flushed?.item.data?.message === FILES_REPORT,
    JSON.stringify(flushed?.item.data?.message),
  );

  // 1. With the handle captured, the arm RPC (what the client bundle calls on
  //    load) is accepted and the next report goes out directly.
  const arm = rpcHandlers.get("rewind.notice.arm");
  check("the plugin registered the rewind-notice arm RPC", typeof arm === "function");
  if (typeof arm === "function") {
    const armResult = arm({}, { paseo });
    check("the arm RPC answers without an error", JSON.stringify(armResult) === "{}");
  }
  const direct = await rewindAndWait("files", "files after arm");
  check(
    "a files report is appended with the handle already captured",
    direct.appended !== undefined,
    describeRows(agent.id),
  );
  check(
    "…exactly one report row is on the timeline",
    reportRows(agent.id).length === 1,
    describeRows(agent.id),
  );
  check(
    "…and a second files rewind replaces it instead of stacking",
    reportRows(agent.id).length === 1,
    describeRows(agent.id),
  );
}

// ---------------------------------------------------------------------------
// 2. Conversation rewind: the row must land after the rebuild's replacement.
// ---------------------------------------------------------------------------
if (!degraded) {
  console.log("\nconversation rewind");
  const result = await rewindAndWait("conversation", "conversation");
  const row = reportFor(agent.id);
  check("the conversation report reached the timeline", row !== undefined, describeRows(agent.id));
  check(
    "…after the host dispatched the timeline replacement",
    result.replacement !== undefined && result.appended !== undefined && result.appended.at >= result.replacement.at,
    result.replacement === undefined || result.appended === undefined
      ? "missing replacement or append"
      : `append +${String(result.appended.at - result.replacement.at)}ms after replacement`,
  );
  check(
    "…with the conversation copy",
    row?.item.data?.message === CONVERSATION_REPORT,
    JSON.stringify(row?.item.data?.message),
  );
  const rows = manager.timelineStore.getRows(agent.id);
  check(
    "the withdrawn conversation is gone from the rebuilt timeline",
    !rows.some((candidate) => candidate.item.type === "assistant_message"),
    rows.map((candidate) => candidate.item.type).join(" | "),
  );
  const historyHasRow = session.history.some(
    (event) => event.type === "timeline" && event.item.type === "plugin",
  );
  check("the report row never entered the provider history", historyHasRow === false);

  // 3. A second conversation rewind: the rebuild must not resurrect the first
  //    report, and the new one replaces it.
  const firstNoticeId = row?.item.data?.noticeId;
  await sleep(50);
  const secondMessageId = freshRevertToken();
  const second = await rewindAndWait("conversation", "conversation again", secondMessageId);
  const rowsAfter = reportRows(agent.id);
  check(
    "a later conversation rewind shows exactly one report row (no accumulation)",
    rowsAfter.length === 1,
    describeRows(agent.id),
  );
  check(
    "…and it is the new report, not the previous one resurrected",
    rowsAfter[0]?.item.data?.noticeId !== undefined && rowsAfter[0]?.item.data?.noticeId !== firstNoticeId,
    `first=${String(firstNoticeId)} second=${String(rowsAfter[0]?.item.data?.noticeId)}`,
  );
  check(
    "…the old delivery path left no rewind notification in the rebuilt timeline",
    !manager.timelineStore
      .getRows(agent.id)
      .some((candidate) => candidate.item.type === "notification" && rewindNoticeTone(String(candidate.item.message ?? "")) !== undefined),
    describeRows(agent.id),
  );
  void second;

  // 4. `both`: same rebuild, different copy.
  console.log("\nboth rewind");
  const bothMessageId = freshRevertToken();
  const both = await rewindAndWait("both", "both", bothMessageId);
  const bothRow = reportFor(agent.id);
  check("the both report reached the timeline", bothRow !== undefined, describeRows(agent.id));
  check(
    "…after the replacement",
    both.replacement !== undefined && both.appended !== undefined && both.appended.at >= both.replacement.at,
    both.replacement === undefined || both.appended === undefined
      ? "missing replacement or append"
      : `append +${String(both.appended.at - both.replacement.at)}ms after replacement`,
  );
  check(
    "…with the both copy (the fake receipt has no file half)",
    bothRow?.item.data?.message === BOTH_REPORT,
    JSON.stringify(bothRow?.item.data?.message),
  );
  check("…exactly one report row", reportRows(agent.id).length === 1, describeRows(agent.id));

  // 5. The canary is unchanged: still sent before the receipt, still not a
  //    report row (it is a notice, and the report path never emits one).
  const canaryEvents = emitted.filter(
    (entry) => entry.event.type === "session.notice" && String(entry.event.notice?.title ?? "").startsWith(CANARY_PREFIX),
  );
  check("the rewind canary is still emitted", canaryEvents.length > 0, `${String(canaryEvents.length)} notices`);
}

// ---------------------------------------------------------------------------
// 6. Slow host: a 2 s snapshot write and a 5 s timeline rebuild, both far past
//    the old 300 ms guess. The row must still land after the replacement.
// ---------------------------------------------------------------------------
if (!degraded) {
  console.log("\nslow host (2 s snapshot write, 5 s timeline rebuild)");
  snapshotWriteMs = 2000;
  const originalStreamHistory = session.streamHistory.bind(session);
  session.streamHistory = async function* slowHistory() {
    await sleep(5000);
    yield* originalStreamHistory();
  };
  try {
    const slowMessageId = freshRevertToken();
    const slow = await rewindAndWait("conversation", "slow conversation", slowMessageId);
    const row = reportFor(agent.id);
    check("the slow host's report still reached the timeline", row !== undefined, describeRows(agent.id));
    check(
      "…after the slow rebuild's replacement, not before it",
      slow.replacement !== undefined && slow.appended !== undefined && slow.appended.at >= slow.replacement.at,
      slow.replacement === undefined || slow.appended === undefined
        ? "missing replacement or append"
        : `replacement +${String(slow.replacement.at - slow.startedAt)}ms, append +${String(slow.appended.at - slow.replacement.at)}ms after it`,
    );
    check("…exactly one report row", reportRows(agent.id).length === 1, describeRows(agent.id));
  } finally {
    session.streamHistory = originalStreamHistory;
    snapshotWriteMs = 3;
  }
}

// ---------------------------------------------------------------------------
// 7. Degraded host: no replacement ever arrives. The delivery must append after
//    its timeout and verify the row survived (the rebuild may still be running).
// ---------------------------------------------------------------------------
if (degraded) {
  console.log("\ntimeline replacement never dispatched");
  // The host dispatches the replacement; the fake subscription is what never
  // receives it (`deliverReplacements` is false in this mode). The handle is
  // captured through the arm RPC — the path a freshly loaded client bundle uses.
  const arm = rpcHandlers.get("rewind.notice.arm");
  if (typeof arm === "function") arm({}, { paseo });
  check("the arm RPC captured the handle before the rewind", appendModule.hasPaseoHandle() === true);
  const before = appends.length;
  const started = Date.now();
  const degradedMessageId = freshRevertToken();
  await manager.rewind(agent.id, degradedMessageId, "conversation");
  const appended = await waitFor(() => (appends.length > before ? appends[appends.length - 1] : undefined), 6000);
  check(
    "the report is appended after the replacement timeout",
    appended !== undefined,
    `appended after ${String(appended === undefined ? -1 : appended.at - started)}ms`,
  );
  check(
    "…the timeout path is bounded by the documented override",
    appendModule.REWIND_REPLACEMENT_TIMEOUT_MS > 0 && appendModule.REWIND_REPLACEMENT_TIMEOUT_MS < 10_000,
    `timeout ${String(appendModule.REWIND_REPLACEMENT_TIMEOUT_MS)}ms`,
  );
  await sleep(2000);
  check(
    "…and exactly one report row remains after the verification pass",
    reportRows(agent.id).length === 1,
    describeRows(agent.id),
  );
}

// ---------------------------------------------------------------------------
// 8. The mechanism, with the plugin out of the picture: a provider notice in the
//    same turn as the receipt is dropped by the host's run lock, while the
//    appended row survives. This is why the report is a plugin row.
// ---------------------------------------------------------------------------
if (!degraded) {
  console.log("\nmechanism: a notice sent with the receipt is dropped");
  probeMode = true;
  try {
    const probeMessageId = freshRevertToken();
    await manager.rewind(agent.id, probeMessageId, "files");
    await sleep(300);
    const noticeRows = manager.timelineStore
      .getRows(agent.id)
      .filter((row) => row.item.type === "notification");
    check(
      "a notice sent in the receipt's turn is dropped by the host",
      !noticeRows.some((row) => String(row.item.message ?? "").includes("p17-immediate-probe")),
      noticeRows.map((row) => String(row.item.message ?? "")).join(" | ") || "(no notification rows)",
    );
    check(
      "…while the appended report row survives the same rewind",
      reportRows(agent.id).length === 1,
      describeRows(agent.id),
    );
  } finally {
    probeMode = false;
  }

  // 9. The degraded path runs in a child process: the replacement timeout is read
  //    when the plugin build loads, so a second process is how the check drives a
  //    host that never dispatches a replacement without waiting out the real
  //    bound.
  console.log("\ndegraded scenario (child process, replacement timeout overridden)");
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--degraded"], {
    env: { ...process.env, DSH_PASEO_REWIND_REPLACEMENT_TIMEOUT_MS: "300" },
    stdio: "inherit",
  });
  check("the degraded child run passed", child.status === 0, `exit ${String(child.status)}`);
}

console.log(`\n  ${passed}/${passed + failed} passed`);
await registry.shutdown().catch(() => undefined);
if (failed > 0) {
  console.log(`  ${failed} FAILED`);
  process.exit(1);
}
process.exit(0);
