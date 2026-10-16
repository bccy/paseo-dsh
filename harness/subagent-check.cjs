/**
 * Plugin-level regression for native DSH subagent visibility.
 *
 * Drives the real Paseo plugin over the bridge protocol using a scripted fake
 * `dsh` (`harness/fake-dsh-bridge.mjs`), so it exercises the plugin's routing
 * of native child sessions without a real DSH, a model, or a spawned subagent.
 *
 * It also reimplements Paseo's own parent-capability gate: a provider child is
 * only accepted when its parent negotiated `session.subsession`, exactly like
 * `@getpaseo/server` `runtime.js`. That is what the plugin-level event stream
 * alone cannot catch.
 *
 * Compile the plugin first (tsc type errors under `--moduleResolution node` are
 * expected; the emitted JS is what runs):
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/subagent-check.cjs ../harness/fake-dsh-bridge.mjs .dbg/
 *   cd .dbg && node subagent-check.cjs
 *   rm -rf ../.dbg
 */
const fs = require("node:fs");
const path = require("node:path");

const fakeBridge = path.join(__dirname, "fake-dsh-bridge.mjs");
fs.chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "live";

const plugin = require("./index.server.js").default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
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

async function untilIn(list, predicate, label, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = list.find(predicate);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const until = (predicate, label, ms) => untilIn(events, predicate, label, ms);
async function maybe(predicate, ms = 3000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(50);
  }
  return undefined;
}
const since = (mark) => events.slice(mark);
async function untilSince(mark, predicate, label, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.slice(mark).find(predicate);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const scoped = (root, native) => `${root}:sub:${native}`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const timelineText = (e) => (e.item?.text ?? "") + JSON.stringify(e.item?.detail ?? {});

/** Paseo's runtime.js:825 gate, replayed over the emitted event stream. */
function parentCapViolations(list) {
  const caps = new Map();
  const order = new Map();
  const violations = [];
  list.forEach((e, i) => {
    if (e.type !== "session.opened") return;
    caps.set(e.sessionId, e.capabilities ?? []);
    order.set(e.sessionId, i);
    if (e.parentSessionId) {
      if (!caps.has(e.parentSessionId)) violations.push(`child ${e.sessionId} before parent ${e.parentSessionId}`);
      else if (!(caps.get(e.parentSessionId) ?? []).includes("session.subsession")) {
        violations.push(`parent ${e.parentSessionId} did not negotiate session.subsession for ${e.sessionId}`);
      }
    }
  });
  return violations;
}

async function openSession(conn, sessionId, history) {
  await conn.send({ type: "session.open", sessionId, config: { cwd: process.cwd(), mode: "build" }, history });
  return until((e) => e.type === "session.ready" && e.sessionId === sessionId, `ready ${sessionId}`);
}

(async () => {
  const conn = await registration.connect({
    capabilities: ["prompt.message", "session.configure", "session.persistence", "session.list", "session.subsession", "permission"],
  });
  conn.onEvent((event) => events.push(event));

  check("provider declares session.subsession", (conn.capabilities ?? []).includes("session.subsession"));

  // ---- main session: live child tree -------------------------------------
  const rootA = `subA-${Date.now()}`;
  await openSession(conn, rootA, "skip");
  const rootAOpened = events.find((e) => e.type === "session.opened" && e.sessionId === rootA);
  check(
    "root opened is restoration core, no parent, declares subsession",
    rootAOpened !== undefined && rootAOpened.restoration === "core" && rootAOpened.parentSessionId === undefined &&
      (rootAOpened.capabilities ?? []).includes("session.subsession"),
    JSON.stringify({ r: rootAOpened?.restoration, caps: rootAOpened?.capabilities }),
  );
  check("a fresh session opens no child before any delegation", (await maybe((e) => e.type === "session.opened" && e.parentSessionId !== undefined, 1000)) === undefined);

  await conn.send({ type: "session.prompt", sessionId: rootA, prompt: { clientMessageId: "pA", input: { type: "message", content: [{ type: "text", text: "go" }] } } });
  const childAScoped = scoped(rootA, "child-A");
  await until((e) => e.type === "session.opened" && e.sessionId === childAScoped, "child-A opened");
  await sleep(400);

  const childA = events.find((e) => e.type === "session.opened" && e.sessionId === childAScoped);
  check(
    "child-A opened as restoration parent under the root, advertising subsession (for grandchildren)",
    childA !== undefined && childA.restoration === "parent" && childA.parentSessionId === rootA &&
      (childA.capabilities ?? []).includes("session.subsession") && !(childA.capabilities ?? []).includes("prompt.message"),
    JSON.stringify({ parent: childA?.parentSessionId, caps: childA?.capabilities }),
  );
  const childB = events.find((e) => e.type === "session.opened" && e.sessionId === scoped(rootA, "child-B"));
  check("nested child-B is parented to child-A's scoped id", childB !== undefined && childB.parentSessionId === childAScoped, childB?.parentSessionId);

  check(
    "strict Paseo parent-cap gate holds (no violation)",
    parentCapViolations(events).length === 0,
    parentCapViolations(events)[0],
  );

  const childATimeline = events.filter((e) => e.type === "timeline.item" && e.sessionId === childAScoped);
  check(
    "child-A timeline carries its own messages and tools",
    childATimeline.some((e) => e.item?.text === "child A answer") && childATimeline.some((e) => e.item?.type === "tool_call"),
    `${childATimeline.length} item(s)`,
  );
  check("no child text leaks into the parent timeline", !events.some((e) => e.type === "timeline.item" && e.sessionId === rootA && /child A answer|child B answer/.test(timelineText(e))));

  check("child-A usage attributed to child-A", events.some((e) => e.type === "session.usage" && e.sessionId === childAScoped && e.usage?.inputTokens === 11));
  check(
    "child usage does not overwrite parent usage",
    !events.some((e) => e.type === "session.usage" && e.sessionId === rootA && e.usage?.inputTokens === 11) &&
      events.some((e) => e.type === "session.usage" && e.sessionId === rootA && e.usage?.inputTokens === 1),
  );

  // ---- terminal state from real turn/end reasons -------------------------
  const childATurns = events.filter((e) => e.type === "session.turn" && e.sessionId === childAScoped);
  const childBTurns = events.filter((e) => e.type === "session.turn" && e.sessionId === scoped(rootA, "child-B"));
  check("a failed child turn ends 'failed', not 'completed'", childATurns.some((e) => e.state === "failed") && !childATurns.some((e) => e.state === "completed"), childATurns.map((e) => e.state).join(","));
  check("an aborted child turn ends 'canceled'", childBTurns.some((e) => e.state === "canceled"), childBTurns.map((e) => e.state).join(","));

  const rootTurns = events.filter((e) => e.type === "session.turn" && e.sessionId === rootA);
  check(
    "parent turn state is untouched by the children",
    rootTurns.filter((e) => e.state === "started").length === 1 && rootTurns.filter((e) => e.state === "completed").length === 1,
    rootTurns.map((e) => e.state).join(","),
  );
  check("unknown session event is dropped, not misattributed", !events.some((e) => e.type === "timeline.item" && /GHOST-SHOULD-NOT-APPEAR/.test(timelineText(e))));

  // ---- permission isolation: same tool-call id, different sessions -------
  const perms = events.filter((e) => e.type === "session.permission");
  const rootPerm = perms.find((e) => e.sessionId === rootA);
  const childPerm = perms.find((e) => e.sessionId === childAScoped);
  check(
    "root and child questions with the same callId get distinct, session-scoped card ids",
    rootPerm !== undefined && childPerm !== undefined && rootPerm.request.id !== childPerm.request.id,
    `${rootPerm?.request?.id} vs ${childPerm?.request?.id}`,
  );
  await conn.send({ type: "session.permission", sessionId: childAScoped, permissionId: childPerm.request.id, response: { behavior: "allow", updatedInput: { answers: { Pick: "yes" } } } });
  const resolved = await until((e) => e.type === "session.permission_resolved" && e.permissionId === childPerm.request.id, "child permission resolved");
  check("a child's permission resolves on the child, not the parent", resolved.sessionId === childAScoped, resolved.sessionId);

  // ---- read-only surface -------------------------------------------------
  const childPromptId = "child-prompt-1";
  await conn.send({ type: "session.prompt", sessionId: childAScoped, prompt: { clientMessageId: childPromptId, input: { type: "message", content: [{ type: "text", text: "hi" }] } } });
  const cpr = await until((e) => e.type === "session.prompt_result" && e.clientMessageId === childPromptId, "child prompt_result");
  check("prompting a subagent fails on the child", cpr.sessionId === childAScoped && cpr.result?.type === "failed", JSON.stringify({ s: cpr.sessionId, r: cpr.result?.type }));
  await conn.send({ type: "session.configure", sessionId: childAScoped, requestId: "cfg-child", changes: { model: "x" } });
  check("configuring a subagent fails loud", (await until((e) => e.type === "request.failed" && e.requestId === "cfg-child", "child configure failed")).error?.message !== undefined);
  const bogus = "bogus-1";
  await conn.send({ type: "definitely.not.a.real.input", requestId: bogus });
  check("unknown input -> request.failed", /unsupported/i.test((await until((e) => e.type === "request.failed" && e.requestId === bogus, "bogus failed")).error?.message ?? ""));

  // ---- two roots observing the same native child must not collide --------
  const rootB = `subB-${Date.now()}`;
  process.env.DSH_FAKE_MODE = "live";
  await openSession(conn, rootB, "skip");
  await conn.send({ type: "session.prompt", sessionId: rootB, prompt: { clientMessageId: "pB", input: { type: "message", content: [{ type: "text", text: "go" }] } } });
  const childBScoped = scoped(rootB, "child-A");
  await until((e) => e.type === "session.opened" && e.sessionId === childBScoped, "rootB child-A opened");
  check(
    "the same native child under two roots gets distinct root-scoped provider ids",
    childBScoped !== childAScoped && events.some((e) => e.type === "session.opened" && e.sessionId === childBScoped && e.parentSessionId === rootB),
    `${childAScoped} vs ${childBScoped}`,
  );
  check("strict parent-cap gate still holds across both roots", parentCapViolations(events).length === 0, parentCapViolations(events)[0]);

  // ---- host without session.subsession: stay root-only, never fail -------
  const conn2 = await registration.connect({ capabilities: ["prompt.message", "session.persistence"] });
  const conn2Events = [];
  conn2.onEvent((e) => conn2Events.push(e));
  check("without subsession offered, the connection does not declare it", !(conn2.capabilities ?? []).includes("session.subsession"));
  const rootC = `subC-${Date.now()}`;
  process.env.DSH_FAKE_MODE = "live";
  await conn2.send({ type: "session.open", sessionId: rootC, config: { cwd: process.cwd(), mode: "build" }, history: "skip" });
  await untilIn(conn2Events, (e) => e.type === "session.ready" && e.sessionId === rootC, "rootC ready", 30000);
  await conn2.send({ type: "session.prompt", sessionId: rootC, prompt: { clientMessageId: "pC", input: { type: "message", content: [{ type: "text", text: "go" }] } } });
  await sleep(600);
  check(
    "no child is emitted when the host did not negotiate subsession (parent stays healthy)",
    !conn2Events.some((e) => e.type === "session.opened" && e.parentSessionId !== undefined) &&
      !conn2Events.some((e) => e.type === "session.runtime_failed"),
  );

  // ---- child reported before the parent is ready -------------------------
  const conn3 = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
  const conn3Events = [];
  conn3.onEvent((e) => conn3Events.push(e));
  const rootD = `subD-${Date.now()}`;
  process.env.DSH_FAKE_MODE = "early";
  await conn3.send({ type: "session.open", sessionId: rootD, config: { cwd: process.cwd(), mode: "build" }, history: "skip" });
  await untilIn(conn3Events, (e) => e.type === "session.ready" && e.sessionId === rootD, "rootD ready", 30000);
  const earlyChild = await untilIn(conn3Events, (e) => e.type === "session.opened" && e.sessionId === scoped(rootD, "child-E"), "child-E opened", 30000);
  const readyIdx = conn3Events.findIndex((e) => e.type === "session.ready" && e.sessionId === rootD);
  const openedIdx = conn3Events.findIndex((e) => e.type === "session.opened" && e.sessionId === scoped(rootD, "child-E"));
  check(
    "a child reported before the parent was ready is held and released after session.ready",
    earlyChild.parentSessionId === rootD && openedIdx > readyIdx,
    `ready#${readyIdx} child#${openedIdx}`,
  );

  // ---- a child whose label arrives after its notice ----------------------
  // Paseo shows a child whose title never arrived as "加载中…" forever, and a
  // child has no configuration channel, so the title it opens with is the only
  // one it can have. The durable label lives in the child's own descriptor.
  const conn3b = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
  const conn3bEvents = [];
  conn3b.onEvent((e) => conn3bEvents.push(e));
  const rootL = `subL-${Date.now()}`;
  process.env.DSH_FAKE_MODE = "label-late";
  await conn3b.send({ type: "session.open", sessionId: rootL, config: { cwd: process.cwd(), mode: "build" }, history: "skip" });
  const lateChild = await untilIn(
    conn3bEvents,
    (e) => e.type === "session.opened" && e.sessionId === scoped(rootL, "child-L"),
    "child-L opened",
    30000,
  );
  check(
    "a label-less notice opens with the child's durable label as its title",
    lateChild.title === "Late L",
    `title=${JSON.stringify(lateChild.title)}`,
  );
  const lateOpens = conn3bEvents.filter((e) => e.type === "session.opened" && e.sessionId === scoped(rootL, "child-L"));
  check("and it is opened exactly once", lateOpens.length === 1, `${lateOpens.length} open(s)`);
  await untilIn(
    conn3bEvents,
    (e) => e.type === "timeline.item" && e.sessionId === scoped(rootL, "child-L") && e.item?.text === "late-label child answer",
    "the held child's output",
    30000,
  );
  check("its buffered output still arrives", true, "late-label child answer");

  // ---- grandchild reported before its parent, root already ready ---------
  const conn5 = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
  const conn5Events = [];
  conn5.onEvent((e) => conn5Events.push(e));
  const rootF = `subF-${Date.now()}`;
  process.env.DSH_FAKE_MODE = "nested";
  await conn5.send({ type: "session.open", sessionId: rootF, config: { cwd: process.cwd(), mode: "build" }, history: "skip" });
  await untilIn(conn5Events, (e) => e.type === "session.ready" && e.sessionId === rootF, "rootF ready", 30000);
  await conn5.send({ type: "session.prompt", sessionId: rootF, prompt: { clientMessageId: "pF", input: { type: "message", content: [{ type: "text", text: "go" }] } } });

  const pScoped = scoped(rootF, "child-P");
  const gScoped = scoped(rootF, "grand-G");
  const hScoped = scoped(rootF, "great-H");
  await untilIn(conn5Events, (e) => e.type === "session.opened" && e.sessionId === hScoped, "great-H opened", 30000);
  await sleep(400);

  const idxP = conn5Events.findIndex((e) => e.type === "session.opened" && e.sessionId === pScoped);
  const idxG = conn5Events.findIndex((e) => e.type === "session.opened" && e.sessionId === gScoped);
  const idxH = conn5Events.findIndex((e) => e.type === "session.opened" && e.sessionId === hScoped);
  check(
    "a grandchild reported before its parent opens only after the parent, pre-order",
    idxP >= 0 && idxG > idxP && idxH > idxG,
    `P#${idxP} G#${idxG} H#${idxH}`,
  );
  check(
    "held grandchildren open under their scoped parents, not the root",
    conn5Events.some((e) => e.type === "session.opened" && e.sessionId === gScoped && e.parentSessionId === pScoped) &&
      conn5Events.some((e) => e.type === "session.opened" && e.sessionId === hScoped && e.parentSessionId === gScoped),
  );
  check(
    "strict Paseo parent-cap gate holds for the held subtree",
    parentCapViolations(conn5Events).length === 0,
    parentCapViolations(conn5Events)[0],
  );
  const gEarly = conn5Events.filter((e) => e.type === "timeline.item" && e.sessionId === gScoped && e.item?.text === "grand early answer");
  const hEarly = conn5Events.filter((e) => e.type === "timeline.item" && e.sessionId === hScoped && e.item?.text === "great early answer");
  check(
    "the held grandchild's earliest output survives, exactly once",
    gEarly.length === 1,
    `${gEarly.length} copy/copies`,
  );
  check(
    "the held great-grandchild's earliest output survives, exactly once",
    hEarly.length === 1,
    `${hEarly.length} copy/copies`,
  );
  check(
    "held-subtree output never leaks into the parent or root timeline",
    !conn5Events.some((e) => e.type === "timeline.item" && (e.sessionId === rootF || e.sessionId === pScoped) && /grand early answer|great early answer|GHOST-SHOULD-NOT-APPEAR/.test(timelineText(e))),
  );
  check(
    "the held grandchild's buffered status still drives its own turn",
    conn5Events.some((e) => e.type === "session.turn" && e.sessionId === gScoped && e.state === "started") &&
      conn5Events.some((e) => e.type === "session.turn" && e.sessionId === gScoped && e.state === "completed"),
  );
  check(
    "an unknown ghost alongside held children is still dropped",
    !conn5Events.some((e) => e.type === "timeline.item" && /GHOST-SHOULD-NOT-APPEAR/.test(timelineText(e))),
  );

  // ---- reopen: replay and skip both rebuild; fork prefix excluded --------
  process.env.DSH_FAKE_MODE = "replay";
  const replayMark = events.length;
  await conn.send({ type: "session.open", requestId: "reopen-replay", sessionId: rootA, config: { cwd: process.cwd(), mode: "build" }, persistence: { version: 1, data: { sessionId: rootA } }, history: "replay" });
  await untilSince(replayMark, (e) => e.type === "session.ready" && e.sessionId === rootA, "replay ready", 30000);
  await untilSince(replayMark, (e) => e.type === "session.opened" && e.sessionId === childAScoped, "replayed child-A", 30000);
  await sleep(300);
  const replayed = since(replayMark);
  check(
    "reopen replay rebuilds the tree (restoration parent)",
    replayed.some((e) => e.type === "session.opened" && e.sessionId === childAScoped && e.parentSessionId === rootA) &&
      replayed.some((e) => e.type === "session.opened" && e.sessionId === scoped(rootA, "child-B") && e.parentSessionId === childAScoped),
  );
  check(
    "replay restores the child's terminal status (not stuck running)",
    replayed.some((e) => e.type === "session.turn" && e.sessionId === childAScoped && e.state === "failed"),
  );
  check(
    "fork-inherited history is not replayed as the child's own messages",
    replayed.some((e) => e.type === "timeline.item" && e.sessionId === childAScoped && e.item?.text === "child A answer") &&
      !replayed.some((e) => e.type === "timeline.item" && e.sessionId === childAScoped && /INHERITED-PARENT/.test(timelineText(e))),
  );

  const skipMark = events.length;
  await conn.send({ type: "session.open", requestId: "reopen-skip", sessionId: rootA, config: { cwd: process.cwd(), mode: "build" }, persistence: { version: 1, data: { sessionId: rootA } }, history: "skip" });
  await untilSince(skipMark, (e) => e.type === "session.ready" && e.sessionId === rootA, "skip ready", 30000);
  await untilSince(skipMark, (e) => e.type === "session.opened" && e.sessionId === childAScoped, "skip-reopened child-A", 30000);
  check("reopen with history:skip also rebuilds the tree", since(skipMark).some((e) => e.type === "session.opened" && e.sessionId === childAScoped && e.parentSessionId === rootA));

  // ---- subagent listing failure is honest, not a silent empty tree -------
  const conn4 = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
  const conn4Events = [];
  conn4.onEvent((e) => conn4Events.push(e));
  const rootE = `subE-${Date.now()}`;
  process.env.DSH_FAKE_MODE = "error";
  await conn4.send({ type: "session.open", sessionId: rootE, config: { cwd: process.cwd(), mode: "build" }, history: "replay" });
  await untilIn(conn4Events, (e) => e.type === "session.ready" && e.sessionId === rootE, "rootE ready", 30000);
  await sleep(400);
  check(
    "a failed subagent listing opens no child and does not fail the parent",
    !conn4Events.some((e) => e.type === "session.opened" && e.parentSessionId !== undefined) &&
      !conn4Events.some((e) => e.type === "session.runtime_failed"),
  );

  await conn.close();
  await conn2.close();
  await conn3.close();
  await conn4.close();
  await conn5.close();

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(1);
});
