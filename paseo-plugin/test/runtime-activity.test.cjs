require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { registerHooks } = require("node:module");
const { test } = require("node:test");
const { PROVIDER_CAPABILITIES } = require("@getpaseo/plugin/server/provider");

/**
 * Idle-cleanup veto (`session.can_stop_runtime`), both halves of the contract.
 *
 * Paseo releases a resumable session after an hour without activity. What it
 * cannot see runs inside the DSH process — a background shell, a running
 * subagent, a scheduled reminder — and releasing the root ends that agent's
 * subtree. So the provider declares `session.can_stop_runtime`, the bridge
 * answers `paseo/activity` from DSH's own archive admission
 * (`workspace/session-activity`), and any answer the bridge cannot give is a
 * failed request: Paseo then keeps the runtime, as it does on a timeout.
 */

// --- Bridge half: which sessions are asked, and what counts as activity -----

/** A root context whose waterfall answers from `reports` and records who it asked. */
function fakeCtx({ live = [], reports = {}, sessions = {} }) {
  const asked = [];
  const ctx = {
    agents: { list: () => live },
    async waterfall(event, payload, base) {
      assert.equal(event, "workspace/session-activity");
      asked.push(payload.sessionId);
      return payload.sessionId in reports ? reports[payload.sessionId] : base();
    },
    get(name) {
      return name === "sessions" ? { get: (id) => sessions[id] } : undefined;
    },
  };
  return { ctx, asked };
}

/** A live agent row in the shape DSH's registry returns (`agent.session.id`). */
function liveAgent(id, parentSession, origin = "subagent") {
  return { id, session: { id, header: { id, ...(parentSession === undefined ? {} : { parentSession, origin }) } } };
}

/** A parent map of the shape the bridge builds from its `children` table. */
function parentsFrom(edges) {
  return (id) => edges[id];
}

test("a root asks itself and its live descendants only, because releasing it ends its own subtree", async () => {
  const { runtimeActivity } = await import("../../dsh-bridge/lib/activity.js");
  const { ctx, asked } = fakeCtx({
    live: [liveAgent("root", undefined, "core"), liveAgent("child"), liveAgent("grandchild"), liveAgent("other-root", undefined, "core")],
    reports: { grandchild: [{ kind: "job", items: [{ id: "job-1", label: "sleep 40" }] }] },
  });
  const activity = await runtimeActivity(ctx, {
    sessionId: "root",
    parentOf: parentsFrom({ child: "root", grandchild: "child" }),
  });
  assert.deepEqual(asked.sort(), ["child", "grandchild", "root"]);
  assert.deepEqual(activity, [{ sessionId: "grandchild", kind: "job", items: [{ id: "job-1", label: "sleep 40" }] }]);
});

test("a root whose agent was never created is still asked, and reports nothing", async () => {
  const { runtimeActivity } = await import("../../dsh-bridge/lib/activity.js");
  const { ctx, asked } = fakeCtx({ live: [] });
  assert.deepEqual(await runtimeActivity(ctx, { sessionId: "root", parentOf: () => undefined }), []);
  assert.deepEqual(asked, ["root"]);
});

test("a child asks only its own subtree, because releasing it drains only that subtree", async () => {
  const { runtimeActivity } = await import("../../dsh-bridge/lib/activity.js");
  const { ctx, asked } = fakeCtx({
    live: [liveAgent("root", undefined, "core"), liveAgent("a"), liveAgent("a-1"), liveAgent("a-1-x"), liveAgent("b")],
    reports: { root: [{ kind: "turn" }], b: [{ kind: "subagent", items: [{ id: "b-1" }] }] },
  });
  const activity = await runtimeActivity(ctx, {
    sessionId: "a",
    parentOf: parentsFrom({ a: "root", "a-1": "a", "a-1-x": "a-1", b: "root" }),
  });
  assert.deepEqual(activity, [], "the parent's turn and a sibling's work are not this child's to keep");
  assert.deepEqual(asked.sort(), ["a", "a-1", "a-1-x"]);
});

test("a live child DSH never announced in the bridge's table is still attributed by its own session header", async () => {
  const { runtimeActivity } = await import("../../dsh-bridge/lib/activity.js");
  // No `children` edge for `adopted`: only the live agent's durable header says
  // whose child it is (a bridge restart adopts running children).
  const { ctx, asked } = fakeCtx({
    live: [liveAgent("root", undefined, "core"), liveAgent("adopted", "root")],
    reports: { adopted: [{ kind: "job", items: [{ id: "job-2" }] }] },
  });
  const activity = await runtimeActivity(ctx, { sessionId: "root", parentOf: () => undefined });
  assert.deepEqual(asked.sort(), ["adopted", "root"]);
  assert.equal(activity.length, 1);
  assert.equal(activity[0].sessionId, "adopted");
});

test("a lineage cycle ends the walk instead of hanging", async () => {
  const { runtimeActivity } = await import("../../dsh-bridge/lib/activity.js");
  const { ctx, asked } = fakeCtx({ live: [liveAgent("x"), liveAgent("y")] });
  await runtimeActivity(ctx, { sessionId: "a", parentOf: parentsFrom({ x: "y", y: "x" }) });
  assert.deepEqual(asked, ["a"]);
});

test("every reported family counts, a malformed one included", async () => {
  const { runtimeActivity } = await import("../../dsh-bridge/lib/activity.js");
  const { ctx } = fakeCtx({
    live: [liveAgent("root", undefined, "core")],
    reports: { root: [{ kind: "turn" }, { kind: "schedule", items: [{ id: 7, label: "" }, null] }, {}, null] },
  });
  assert.deepEqual(await runtimeActivity(ctx, { sessionId: "root", parentOf: () => undefined }), [
    { sessionId: "root", kind: "turn" },
    { sessionId: "root", kind: "schedule", items: [{ id: "7" }, { id: "" }] },
    { sessionId: "root", kind: "unknown" },
    { sessionId: "root", kind: "unknown" },
  ]);
});

test("a runtime that cannot say what runs fails instead of answering 'nothing'", async () => {
  const { runtimeActivity } = await import("../../dsh-bridge/lib/activity.js");
  const scope = { sessionId: "root", parentOf: () => undefined };
  await assert.rejects(runtimeActivity({ agents: { list: () => [] } }, scope), /cannot report session activity/);
  await assert.rejects(runtimeActivity({ waterfall: async () => [] }, scope), /agent registry is unavailable/);
  await assert.rejects(
    runtimeActivity({ agents: { list: () => [] }, waterfall: async () => undefined }, scope),
    /answered session root with undefined, not a list/,
  );
});

// --- Bridge half: the `paseo/activity` request itself ------------------------

/** Find the installed DSH package so its internal modules can be resolved. */
function dshPackageDir() {
  let bin;
  try {
    bin = childProcess.execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
  if (bin === "") return undefined;
  let dir = path.dirname(fs.realpathSync(bin));
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === "@deepseek-ai/dsh") return dir;
      } catch {
        // Not a manifest we can read; keep walking up.
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

let bridgeServer;
/**
 * Import the bridge's ESM server, resolving its DSH-internal imports from the
 * installed harness (the bridge normally runs inside that process). Returns
 * undefined where the harness is not reachable, so the suite still runs.
 */
async function loadBridgeServer() {
  if (bridgeServer !== undefined) return bridgeServer.PaseoHarnessServer;
  const pkg = dshPackageDir();
  if (pkg === undefined) return undefined;
  const modules = path.join(pkg, "node_modules");
  if (!fs.existsSync(path.join(modules, "@deepseek-ai", "dsh-brand"))) return undefined;
  // A synthetic importer under the harness's own node_modules makes bare
  // specifiers resolve exactly as they do inside the running bridge.
  const parentURL = pathToFileURL(path.join(modules, "_resolver.mjs")).href;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith(".") && !specifier.startsWith("node:") && !specifier.startsWith("file:")) {
        try {
          return nextResolve(specifier, { ...context, parentURL });
        } catch {
          // Fall through to the ordinary resolution.
        }
      }
      return nextResolve(specifier, context);
    },
  });
  const module = await import(pathToFileURL(path.join(__dirname, "..", "..", "dsh-bridge", "lib", "server.js")).href);
  hook.deregister?.();
  bridgeServer = module;
  return module.PaseoHarnessServer;
}

/** One bridge server with its session tables placed directly (no real DSH). */
function bridgeFixture(PaseoHarnessServer, { live, reports, roots = [], children = {} }) {
  const asked = [];
  const ctx = {
    on() {
      return () => {};
    },
    get() {
      return undefined;
    },
    agents: { list: () => live, get: () => undefined, create: async () => ({}) },
    async waterfall(_event, { sessionId }, base) {
      asked.push(sessionId);
      return sessionId in reports ? reports[sessionId] : base();
    },
  };
  const server = new PaseoHarnessServer(ctx, { notify() {} });
  for (const root of roots) {
    server.initializedSessions.add(root);
    server.sessions.set(root, {});
  }
  for (const [id, parentId] of Object.entries(children)) server.children.set(id, { parentId, opened: true, buffered: [] });
  return { server, asked };
}

test("paseo/activity answers for a root and its children, and refuses ids it does not own", async t => {
  const PaseoHarnessServer = await loadBridgeServer();
  if (PaseoHarnessServer === undefined) return t.skip("installed @deepseek-ai/dsh package not resolvable");

  const { server, asked } = bridgeFixture(PaseoHarnessServer, {
    live: [liveAgent("root", undefined, "core"), liveAgent("child"), liveAgent("grandchild")],
    reports: { root: [{ kind: "turn" }], grandchild: [{ kind: "job", items: [{ id: "job-1", label: "sleep 40" }] }] },
    roots: ["root"],
    children: { child: "root", grandchild: "child" },
  });
  const kinds = (result) => result.activity.map((entry) => `${entry.kind}@${entry.sessionId}`).sort();
  assert.deepEqual(kinds(await server.handleRequest("paseo/activity", { sessionId: "root" })), ["job@grandchild", "turn@root"]);
  assert.deepEqual(asked.sort(), ["child", "grandchild", "root"], "releasing the root ends its own subtree");
  assert.deepEqual(kinds(await server.handleRequest("paseo/activity", { sessionId: "child" })), ["job@grandchild"]);
  await assert.rejects(server.handleRequest("paseo/activity", { sessionId: "elsewhere" }), /unknown session: elsewhere/);
  await assert.rejects(server.handleRequest("paseo/activity", {}), /requires sessionId/);
});

// --- Provider half: the answer Paseo gets -----------------------------------

test("DshChildSession advertises the idle-cleanup veto, so a child is asked too", async () => {
  const { DshChildSession } = require("../server/session.ts");
  const events = [];
  const child = new DshChildSession({
    id: "agent-1:sub:native-child",
    nativeId: "native-child",
    subsession: true,
    cwd: "/tmp",
    closed: () => false,
    emit: (event) => events.push(event),
    log: () => {},
    resolvePermission: async () => {},
    teamRoster: new Map(),
  });
  child.open("agent-1");
  const opened = events.find((event) => event.type === "session.opened");
  assert.ok(opened !== undefined);
  assert.ok(
    opened.capabilities.includes("session.can_stop_runtime"),
    `capabilities=[${opened.capabilities.join(", ")}]`,
  );
});

/** A DshSession over a fake process, which is all the veto needs from it. */
function sessionFixture({ activity, logs = [] }) {
  const { DshSession } = require("../server/session.ts");
  const calls = { activity: [], attach: 0, close: 0 };
  let handlers;
  const process = {
    async attachSession(_sessionId, value) {
      calls.attach += 1;
      handlers = value;
    },
    async activity(nativeId) {
      calls.activity.push(nativeId);
      return activity(nativeId);
    },
    async closeSession() {
      calls.close += 1;
    },
  };
  const events = [];
  const session = new DshSession({
    sessionId: "paseo-root",
    dshSessionId: "native-root",
    agentId: "agent-1",
    cwd: "/tmp",
    env: {},
    route: { provider: "fixture", model: "fixture" },
    mode: "build",
    modes: [],
    models: [],
    thinkingOptions: [],
    subsession: true,
    permission: true,
    emit: (event) => events.push(event),
    log: (line) => logs.push(line),
    acquireProcess: async () => ({ process, reused: false }),
    releaseProcess: () => {},
  });
  return { session, calls, events, handlers: () => handlers };
}

test("no DSH activity lets the runtime go, with no log line", async () => {
  const logs = [];
  const { session, calls } = sessionFixture({ activity: async () => [], logs });
  await session.open();
  assert.equal(await session.canStopRuntime(), true);
  assert.deepEqual(calls.activity, ["native-root"], "the bridge is asked about the native DSH session id");
  assert.deepEqual(logs, []);
  await session.close();
});

test("a live job keeps the runtime and the log says what kept it", async () => {
  const logs = [];
  const { session } = sessionFixture({
    activity: async () => [{ sessionId: "native-root", kind: "job", items: [{ id: "job-1", label: "npm test" }] }],
    logs,
  });
  await session.open();
  assert.equal(await session.canStopRuntime(), false);
  assert.ok(
    logs.some((line) => line.includes("kept paseo-root running for DSH work") && line.includes("job") && line.includes("npm test")),
    `logs=${JSON.stringify(logs)}`,
  );
  await session.close();
});

test("a child's job keeps the root's runtime, mapped through its own native id", async () => {
  const { session, calls, events, handlers } = sessionFixture({
    activity: async (nativeId) =>
      nativeId === "native-child" ? [{ sessionId: nativeId, kind: "job", items: [{ id: "job-2", label: "npm test" }] }] : [],
  });
  await session.open();
  session.markRootReady();
  handlers().onChildOpened({ sessionId: "native-child", parentSessionId: "native-root", label: "Child" });
  const opened = events.find((event) => event.type === "session.opened" && event.parentSessionId !== undefined);
  assert.ok(opened !== undefined);
  const answer = await session.canStopRuntime(opened.sessionId);
  assert.equal(answer, false);
  assert.deepEqual(calls.activity, ["native-child"], "a child is asked about under its own native id");
  assert.equal(await session.canStopRuntime(), true, "the root itself has nothing running");
  await assert.rejects(session.canStopRuntime("no-such-child"), /unknown native child session/);
  await session.close();
});

test("a bridge that cannot answer rejects instead of letting the runtime go", async () => {
  const { session } = sessionFixture({ activity: async () => { throw new Error("workspace/session-activity threw"); } });
  await session.open();
  await assert.rejects(session.canStopRuntime(), /workspace\/session-activity threw/);
  await session.close();
});

test("a closed session answers true without asking the bridge", async () => {
  const { session, calls } = sessionFixture({ activity: async () => [] });
  await session.open();
  await session.close();
  assert.equal(await session.canStopRuntime(), true);
  assert.deepEqual(calls.activity, [], "a closed session has no process left, so nothing can be lost");
});

test("the provider declares the veto and turns an unanswered request into request.failed", async t => {
  // A throwaway DSH home: the provider's prewarm consults the cross-process
  // shared-child record, and the user's own running daemon owns one in the real
  // home (it would refuse to spawn "beside" that live dsh). Nothing here needs a
  // profile — the child is the fixture below.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-activity-home-")));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-activity-")));
  const cli = path.join(dir, "fixture.cjs");
  fs.writeFileSync(
    cli,
    `
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!request.method) return;
  let result = {};
  if (request.method === "initialize") {
    result = { serverInfo: { name: "fixture", version: "0.0.0" }, route: { provider: "fixture", model: "fixture", reasoningEffort: null } };
  }
  if (request.method === "paseo/catalog") {
    result = {
      providers: [{ id: "fixture", name: "Fixture" }],
      models: [{ provider: "fixture", id: "fixture", name: "Fixture" }],
      defaultProvider: "fixture",
      defaultModel: "fixture",
    };
  }
  send({ jsonrpc: "2.0", id: request.id, result });
  if (request.method === "shutdown") process.exit(0);
});`,
  );
  const spawn = childProcess.spawn;
  childProcess.spawn = (_command, args, options) => spawn(process.execPath, [cli, ...args], options);
  t.after(() => {
    childProcess.spawn = spawn;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  const { createDshProvider } = require("../server/provider.ts");
  const connection = await createDshProvider().connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  const events = [];
  connection.onEvent((event) => events.push(event));
  t.after(async () => {
    await connection.close().catch(() => {});
  });

  assert.ok(
    connection.capabilities.includes("session.can_stop_runtime"),
    `capabilities=[${connection.capabilities.join(", ")}]`,
  );
  for (const sessionId of ["no-such-session", "paseo-root"]) {
    const requestId = `stop-${sessionId}`;
    await connection.send({ type: "session.can_stop_runtime", requestId, sessionId });
    const answers = events.filter((event) => event.requestId === requestId);
    assert.deepEqual(answers.map((event) => event.type), ["request.failed"], `${sessionId} answered ${JSON.stringify(answers)}`);
  }
  assert.ok(events.every((event) => event.type !== "session.can_stop_runtime"), "an unknown session must never be answered canStop");
});