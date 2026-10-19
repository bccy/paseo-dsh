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

  // ---- a steer answers whatever the agent was blocked on ------------------
  // The daemon sends `clearPendingPermissions` on every steer, because a typed
  // message *is* the answer. Ignoring the flag (which is what happened) left the
  // request in the daemon's own `pendingPermissions` map forever: the card stays
  // pending in the UI and in `getPendingPermissions()`, and the promise the
  // plugin is holding never settles, so a later click answers nobody.
  const steerClears = "steer-clears-1";
  await conn.send({
    type: "session.prompt",
    sessionId: rootA,
    prompt: {
      clientMessageId: steerClears,
      delivery: "steer",
      clearPendingPermissions: true,
      input: { type: "message", content: [{ type: "text", text: "just take the first option" }] },
    },
  });
  const clearedBySteer = await until(
    (e) => e.type === "session.permission_resolved" && e.permissionId === rootPerm.request.id,
    "root permission cleared by the steer",
  );
  check(
    "a steer carrying clearPendingPermissions answers the card the agent was blocked on",
    clearedBySteer.sessionId === rootA,
    clearedBySteer.sessionId,
  );

  // ---- a block DSH has no counterpart for fails the *prompt* --------------
  // Paseo's `ProviderContent` is wider than DSH's block set (`uploaded_file`,
  // `review`, `forge_*`, `github_*` all ride in on the same prompt, and only
  // `image` is capability-gated). A throw out of the translation used to escape
  // `prompt()` entirely and surface as `session.runtime_failed`, which the daemon
  // treats as terminal: it rejects the pending prompt, drops the session and
  // spawns a fresh `dsh` for the same native id, while the old process and this
  // DshSession stayed behind. One unsupported block ended the conversation.
  const badBlock = "bad-block-1";
  const beforeBadBlock = events.length;
  await conn.send({
    type: "session.prompt",
    sessionId: rootA,
    prompt: {
      clientMessageId: badBlock,
      input: {
        type: "message",
        content: [
          { type: "text", text: "look at this" },
          { type: "uploaded_file", mimeType: "application/pdf", data: "x" },
        ],
      },
    },
  });
  const badResult = await until(
    (e) => e.type === "session.prompt_result" && e.clientMessageId === badBlock,
    "untranslatable prompt result",
  );
  check(
    "a prompt block with no DSH counterpart fails the prompt, with the reason",
    badResult.result?.type === "failed" &&
      /unsupported prompt content type/.test(badResult.result?.error?.message ?? ""),
    JSON.stringify(badResult.result),
  );
  check(
    "and it never becomes session.runtime_failed (which would kill the session)",
    !events.slice(beforeBadBlock).some((e) => e.type === "session.runtime_failed"),
  );

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

  // ---- a replayed one-shot child: label only in its own history ----------
  // The durable catalog omits the label of a one-shot child, but the title it
  // opens with is the only one it can ever have (children have no configuration
  // channel), so the replay has to read the descriptor out of the child's own
  // history before opening it.
  const replayOpens = events.filter((e) => e.type === "session.opened" && e.sessionId.endsWith(":sub:child-B"));
  check("a replayed one-shot child opens with its own descriptor's label", replayOpens.length > 0 && replayOpens.every((e) => e.title === "Nested B"), JSON.stringify(replayOpens.map((e) => e.title)));

  // ---- a child whose label never arrives --------------------------------
  // The hold exists so a child opens with its real title; it must still be
  // bounded by something other than a check that can only ever read zero. With
  // the wait evaluated only at `child-opened` time the child never opened at
  // all, and its output was buffered and quietly dropped.
  const conn3c = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
  const conn3cEvents = [];
  conn3c.onEvent((e) => conn3cEvents.push(e));
  const rootN = `subN-${Date.now()}`;
  process.env.DSH_FAKE_MODE = "label-never";
  await conn3c.send({ type: "session.open", sessionId: rootN, config: { cwd: process.cwd(), mode: "build" }, history: "skip" });
  const neverChild = await untilIn(
    conn3cEvents,
    (e) => e.type === "session.opened" && e.sessionId === scoped(rootN, "child-N"),
    "child-N opened despite never being labelled",
    30000,
  );
  check("a label-less child still opens once it has waited long enough", neverChild.title === undefined, `title=${JSON.stringify(neverChild.title)}`);
  await untilIn(
    conn3cEvents,
    (e) => e.type === "timeline.item" && e.sessionId === scoped(rootN, "child-N") && e.item?.text === "never-labelled line 45",
    "the never-labelled child's output",
    30000,
  );
  check("and its output reaches the timeline instead of being dropped", true, "never-labelled line 45");

  // ---- a child DSH reports as archived ----------------------------------
  // Announcing it again would resurrect it in Paseo, which is exactly how
  // "archive all" appeared to do nothing after a restart. Asserted against the
  // **replay** connection below: `child-Z` only appears in the `replay` mode's
  // `paseo/subagents` list, so checking `events` (the live connection, which
  // lists nothing) could only ever pass — a mutation that removed the filter
  // outright still reported 55/55.

  // ---- the archive round trip -------------------------------------------
  // Paseo's archive action must land on DSH's native archive set. Two things
  // were silently wrong before: a success emitted no reply (Paseo awaits one,
  // so the click would hang), and the request was refused outright when no
  // Paseo session was open — which is the state after archiving the last
  // session, because Paseo closes that session's DSH process as part of
  // archiving it. Both directions must now answer, and an id the registry
  // refuses must fail loud.
  const archHandle = events.find((e) => e.type === "session.opened" && e.sessionId === rootA)?.persistence;
  check(
    "session.opened carries the persistence handle archive addresses",
    archHandle !== undefined && typeof archHandle.data?.sessionId === "string",
    JSON.stringify(archHandle ?? null),
  );

  const isReply = (requestId) => (e) => e.requestId === requestId && (e.type === "request.completed" || e.type === "request.failed");

  await conn.send({ type: "session.archive", requestId: "arch-live", persistence: archHandle });
  const archLive = await until(isReply("arch-live"), "archive via an open session");
  check("archive answers on an open session", archLive.type === "request.completed", JSON.stringify(archLive.error ?? archLive.type));

  await conn.send({ type: "session.unarchive", requestId: "unarch-live", persistence: archHandle });
  const unarchLive = await until(isReply("unarch-live"), "unarchive via an open session");
  check("unarchive answers on an open session", unarchLive.type === "request.completed", JSON.stringify(unarchLive.error ?? unarchLive.type));

  // A connection with nothing open has no process to borrow, so the plugin must
  // stand a throwaway runtime up. This is the click that used to fail with
  // "no DSH session is open".
  const connArchive = await registration.connect({ capabilities: ["session.persistence"] });
  const connArchiveEvents = [];
  connArchive.onEvent((e) => connArchiveEvents.push(e));
  const probeHandle = { version: 1, data: { sessionId: "child-A" } };

  await connArchive.send({ type: "session.archive", requestId: "arch-probe", persistence: probeHandle });
  const archProbe = await untilIn(connArchiveEvents, isReply("arch-probe"), "archive with no open session", 30000);
  check(
    "archive answers with no open session (throwaway runtime)",
    archProbe.type === "request.completed",
    JSON.stringify(archProbe.error ?? archProbe.type),
  );

  await connArchive.send({ type: "session.unarchive", requestId: "unarch-probe", persistence: probeHandle });
  const unarchProbe = await untilIn(connArchiveEvents, isReply("unarch-probe"), "unarchive with no open session", 30000);
  check(
    "unarchive answers with no open session (throwaway runtime)",
    unarchProbe.type === "request.completed",
    JSON.stringify(unarchProbe.error ?? unarchProbe.type),
  );

  await connArchive.send({
    type: "session.unarchive",
    requestId: "unarch-unknown",
    persistence: { version: 1, data: { sessionId: "unknown-session" } },
  });
  const unarchUnknown = await untilIn(connArchiveEvents, isReply("unarch-unknown"), "unknown handle", 30000);
  check(
    "an id the registry refuses fails loud, never reports success",
    unarchUnknown.type === "request.failed" && /unknown-session/.test(unarchUnknown.error?.message ?? ""),
    JSON.stringify(unarchUnknown.error ?? unarchUnknown.type),
  );
  await connArchive.close();

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
  const archivedAnnouncements = replayed.filter(
    (e) => e.type === "session.opened" && e.sessionId.endsWith(":sub:child-Z"),
  );
  check(
    "an archived child is not announced by the replay",
    archivedAnnouncements.length === 0,
    archivedAnnouncements.length === 0 ? "" : `child-Z was announced ${archivedAnnouncements.length}x`,
  );

  // ---- a root killed with a tool in flight -------------------------------
  // The root replay builds its rows with a *local* builder, so the live builder
  // never learns they exist and no later `turn/end` can close them. Without an
  // explicit settle the row pulsed for the rest of the session and again on every
  // reopen; the child replay already did this, the root path did not.
  const killedRoot = `killed-root-${Date.now()}`;
  const killedMark = events.length;
  await conn.send({
    type: "session.open",
    requestId: "reopen-killed",
    sessionId: killedRoot,
    config: { cwd: process.cwd(), mode: "build" },
    persistence: { version: 1, data: { sessionId: killedRoot } },
    history: "replay",
  });
  await untilSince(
    killedMark,
    (e) => e.type === "session.ready" && e.sessionId === killedRoot,
    "killed root ready",
    30000,
  );
  await sleep(300);
  const killedRows = events
    .slice(killedMark)
    .filter(
      (e) =>
        e.type === "timeline.item" &&
        e.sessionId === killedRoot &&
        e.item?.type === "tool_call" &&
        e.item?.callId === "killed-1",
    )
    .map((e) => e.item);
  check(
    "a root replay that stops mid-tool closes the running row instead of pulsing forever",
    killedRows.length > 0 && killedRows[killedRows.length - 1].status === "canceled",
    JSON.stringify(killedRows.map((row) => row.status)),
  );

  // ---- a child killed mid-turn: no terminal anywhere in its log ----------
  // DSH appends no "the process died" fact, and a live child caught between two
  // steps writes the very same tail (`step/start`, last turn never closed), so
  // the stored shape alone cannot tell them apart. What can is the live channel:
  // replay reads the durable catalog of a process that has just booted, where
  // nothing is live. Without that, Paseo's default on attach is "running" and
  // the row pulses forever.
  const killedScoped = scoped(rootA, "child-K");
  const killedTurns = replayed.filter((e) => e.type === "session.turn" && e.sessionId === killedScoped);
  check(
    "a replayed child whose log stops inside a turn is closed, not announced as running",
    killedTurns.some((e) => e.state === "canceled") && !killedTurns.some((e) => e.state === "started"),
    `turns=${JSON.stringify(killedTurns.map((e) => e.state))}`,
  );
  const killedItems = replayed.filter((e) => e.type === "timeline.item" && e.sessionId === killedScoped);
  // The row is emitted running when its `tool/call` is replayed and then settled
  // canceled; Paseo folds same-id items, so the *last* emission is the state the
  // user sees. A row left running is the forever-pulsing bug.
  const killedTool = killedItems.filter((e) => e.item?.callId === "ck-1");
  check(
    "and its tool call that never got a result is settled as canceled",
    killedTool.length > 0 && killedTool[killedTool.length - 1].item?.status === "canceled",
    JSON.stringify(killedTool.map((e) => e.item?.status)),
  );
  check(
    "the killed child is still announced (closed, never hidden)",
    replayed.some((e) => e.type === "session.opened" && e.sessionId === killedScoped && e.title === "Killed K"),
  );

  // ---- the same shape, but hosted live: it must stay running -------------
  // The counter-case to the rule above. A child the bridge announced during this
  // very open is live evidence; closing it would trade a stuck row for a lying
  // one.
  const liveScoped = scoped(rootA, "child-M");
  check(
    "a child the bridge hosts live keeps its open turn (same log shape, no cancel)",
    !replayed.some((e) => e.type === "session.turn" && e.sessionId === liveScoped && e.state === "canceled"),
    JSON.stringify(replayed.filter((e) => e.type === "session.turn" && e.sessionId === liveScoped).map((e) => e.state)),
  );
  const liveItems = replayed.filter((e) => e.type === "timeline.item" && e.sessionId === liveScoped);
  check(
    "and its in-flight tool row is left running",
    liveItems.some((e) => e.item?.callId === "cm-1" && e.item?.status === "running"),
    JSON.stringify(liveItems.map((e) => `${e.item?.type}/${e.item?.callId ?? "-"}=${e.item?.status ?? "-"}`)),
  );

  const skipMark = events.length;
  await conn.send({ type: "session.open", requestId: "reopen-skip", sessionId: rootA, config: { cwd: process.cwd(), mode: "build" }, persistence: { version: 1, data: { sessionId: rootA } }, history: "skip" });
  await untilSince(skipMark, (e) => e.type === "session.ready" && e.sessionId === rootA, "skip ready", 30000);
  await untilSince(skipMark, (e) => e.type === "session.opened" && e.sessionId === childAScoped, "skip-reopened child-A", 30000);
  check("reopen with history:skip also rebuilds the tree", since(skipMark).some((e) => e.type === "session.opened" && e.sessionId === childAScoped && e.parentSessionId === rootA));

  // ---- adopted reopen: a mid-turn child hosted by the SAME process ---------
  // The rewind refresh closes the provider session and reopens it on the parked
  // dsh process. That process never stopped, so a child whose stored log ends
  // inside a turn is still running. Closing it as canceled (correct on a cold
  // start — see child-K above) would be a lie here, and it is what made a
  // running subagent show as stopped after every rewind.
  process.env.DSH_FAKE_MODE = "replay";
  const rootP = `subP-${Date.now()}`;
  const parkOpenMark = events.length;
  await conn.send({
    type: "session.open",
    requestId: "adopt-open",
    sessionId: rootP,
    config: { cwd: process.cwd(), mode: "build" },
    persistence: { version: 1, data: { sessionId: rootP } },
    history: "replay",
  });
  await untilSince(parkOpenMark, (e) => e.type === "session.ready" && e.sessionId === rootP, "adopt root ready", 30000);
  await sleep(300);
  // The daemon normally closes the old provider session right before the reopen;
  // an idle session is parked (not killed), which is the adoption precondition.
  await conn.send({ type: "session.close", sessionId: rootP });
  await sleep(300);
  const adoptMark = events.length;
  await conn.send({
    type: "session.open",
    requestId: "adopt-reopen",
    sessionId: rootP,
    config: { cwd: process.cwd(), mode: "build" },
    persistence: { version: 1, data: { sessionId: rootP } },
    history: "replay",
  });
  await untilSince(adoptMark, (e) => e.type === "session.ready" && e.sessionId === rootP, "adopt reopen ready", 30000);
  await sleep(400);
  const adopted = since(adoptMark);
  const adoptedChildK = scoped(rootP, "child-K");
  const adoptedKilledTurns = adopted.filter((e) => e.type === "session.turn" && e.sessionId === adoptedChildK);
  check(
    "an adopted reopen keeps a mid-turn child running instead of closing it as canceled",
    adoptedKilledTurns.length === 0,
    JSON.stringify(adoptedKilledTurns.map((e) => e.state)),
  );
  check(
    "and it still announces that child (closed-looking logs are never hidden)",
    adopted.some((e) => e.type === "session.opened" && e.sessionId === adoptedChildK),
  );
  // Contrast: cold opens are unchanged — child-K is still closed as canceled.
  check(
    "a cold reopen of the same fixture still closes child-K as canceled",
    replayed.some((e) => e.type === "session.turn" && e.sessionId === killedScoped && e.state === "canceled"),
  );

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

  // ---- a failed open leaves no session (or process) behind ----------------
  // The daemon drops its own maps and rethrows on a failed open without ever
  // sending `session.close` (`PluginProvider.openSession`'s catch), while the
  // plugin used to keep its entry — plus the `dsh` process `open()` had already
  // spawned. Every retry arrives under a fresh session id, so they accumulate for
  // the life of the connection. The observable proof that the rollback ran is the
  // `shutdown` frame the plugin sends, which the fake bridge logs.
  const failOpenLog = path.join(require("node:os").tmpdir(), `dsh-fake-log-${Date.now()}.jsonl`);
  const connFailOpen = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
  const connFailOpenEvents = [];
  connFailOpen.onEvent((e) => connFailOpenEvents.push(e));
  const rootFailOpen = `subFO-${Date.now()}`;
  process.env.DSH_FAKE_MODE = "failopen";
  process.env.DSH_FAKE_LOG = failOpenLog;
  await connFailOpen
    .send({ type: "session.open", sessionId: rootFailOpen, config: { cwd: process.cwd(), mode: "build" } })
    .catch(() => undefined);
  await sleep(600);
  const failOpenFrames = fs
    .readFileSync(failOpenLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).method);
  check(
    "a session whose open failed is closed, not left holding its process",
    failOpenFrames.includes("initialize") && failOpenFrames.includes("shutdown"),
    failOpenFrames.join(", "),
  );
  await connFailOpen.close();
  delete process.env.DSH_FAKE_LOG;

  // ---- a turn DSH ended for a reason that is not a clean finish ----------
  // The root's terminal `session.turn` is emitted later, from the remembered
  // reason. Reading every non-`aborted` reason as `completed` meant the daemon
  // took its `turn_completed` branch, which never resolves the permissions an
  // abandoned turn leaves behind — so a card from a turn that died stayed pending
  // forever — and the UI could not tell a failed turn from a finished one.
  const connFail = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
  const connFailEvents = [];
  connFail.onEvent((e) => connFailEvents.push(e));
  const rootFail = `subF-${Date.now()}`;
  process.env.DSH_FAKE_MODE = "failturn";
  await connFail.send({ type: "session.open", sessionId: rootFail, config: { cwd: process.cwd(), mode: "build" } });
  await untilIn(connFailEvents, (e) => e.type === "session.ready" && e.sessionId === rootFail, "rootFail ready", 30000);
  await connFail.send({
    type: "session.prompt",
    sessionId: rootFail,
    prompt: { clientMessageId: "failturn-1", input: { type: "message", content: [{ type: "text", text: "go" }] } },
  });
  const failedTurn = await untilIn(
    connFailEvents,
    (e) => e.type === "session.turn" && e.sessionId === rootFail && e.state !== "started",
    "failed turn terminal",
    30000,
  );
  check(
    "a turn DSH ended with an error reaches Paseo as failed, with the reason",
    failedTurn.state === "failed" && /error/.test(failedTurn.error?.message ?? ""),
    JSON.stringify({ state: failedTurn.state, error: failedTurn.error?.message }),
  );
  await connFail.close();

  await conn.close();
  await conn2.close();
  await conn3.close();
  await conn4.close();
  await connFail.close();

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(1);
});
