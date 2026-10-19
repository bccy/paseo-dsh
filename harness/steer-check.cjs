/**
 * Plugin-level regression for steering into a running DSH turn.
 *
 * Drives the real Paseo plugin over the bridge protocol using a scripted fake
 * `dsh` (`harness/fake-dsh-bridge.mjs`, `DSH_FAKE_MODE=steer`). The scenario
 * holds a root turn open while a foreground child runs, and emits the running
 * status *before* the prompt reply — the order real DSH produces, because the
 * turn opens synchronously inside `agent.followup()`.
 *
 * It also reimplements Paseo's own steer admission (`@getpaseo/server`
 * `agent-manager.js` `steerOrReplaceActiveTurn`): a steer counts as delivered
 * only when the prompt result is `steer` and its `turnId` equals the turn id the
 * daemon bound when the turn started (`activeForegroundTurnId`). Anything else
 * falls back to canceling and replacing the turn, which is what aborted the
 * foreground subagent. The fallback is replayed here, so a regression shows up
 * as a `cancel` on the wire rather than a silently wrong event shape.
 *
 * Every request the bridge receives is appended to `DSH_FAKE_LOG`, so delivery
 * counts are asserted at the protocol boundary, not inferred from the UI.
 *
 * The same contract also fixes the turn id itself: the id a prompt result names
 * and the id `session.turn started` later names must be one value, because Paseo
 * binds the turn it steers to the prompt result. Real DSH emits the running
 * status *before* the prompt reply (the `steer` mode's order); the `late` mode is
 * a synthetic, defensive reverse order that pins the invariant without relying on
 * that cross-process ordering, and `failonce` covers the reset of an id issued
 * for a turn that never started.
 *
 * The last scenario is the other half of "a turn in progress": a *cancel*. With
 * `DSH_FAKE_MODE=cancel` a root turn stays open and keeps emitting output, a
 * `session.interrupt` arrives mid-turn, and the fake ends the turn exactly as
 * real DSH does for `agent.cancel({kind:'user'})` — `turn/end` with
 * `{kind:'aborted', reason:{kind:'user'}}`, then an idle status. The check
 * asserts the receipt (`request.completed` naming the requestId), that the
 * runtime was really told to stop (`session/cancel`) and produced nothing more
 * for that turn, that the terminal is `canceled` rather than `completed`, and
 * that the same session still runs the next turn — cancel is a turn cancel,
 * never a kill.
 *
 * Compile the plugin first (tsc type errors under `--moduleResolution node` are
 * expected; the emitted JS is what runs):
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/steer-check.cjs ../harness/fake-dsh-bridge.mjs .dbg/
 *   cd .dbg && node steer-check.cjs
 *   rm -rf ../.dbg
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fakeBridge = path.join(__dirname, "fake-dsh-bridge.mjs");
fs.chmodSync(fakeBridge, 0o755);
const frameLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "steer-check-")), "frames.jsonl");
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "steer";
process.env.DSH_FAKE_LOG = frameLog;

// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which rewrites `$DSH_HOME/profiles/<name>/
// node_modules/dsh-paseo-bridge` from the bridge embedded in the plugin. The
// fake `dsh` needs no profile, so point DSH_HOME at a throwaway tree.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-steer-check-"));
process.on("exit", () => {
  try {
    fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

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

const until = async (predicate, label, ms = 30000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const untilSince = async (mark, predicate, label, ms = 30000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.slice(mark).find(predicate);
    if (hit) return hit;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
};
/** Wait inside an explicit event list, for a connection other than the first. */
const untilIn = async (list, predicate, label, ms = 30000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = list.find(predicate);
    if (hit) return hit;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
};
/**
 * Like `untilIn`, but returns undefined instead of throwing.
 *
 * A regression must show up as a named FAIL, not as an abort that hides every
 * assertion after it.
 */
const maybeIn = async (list, predicate, ms = 30000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = list.find(predicate);
    if (hit) return hit;
    await sleep(25);
  }
  return undefined;
};

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** Every request the bridge received, in order. */
function frames() {
  if (!fs.existsSync(frameLog)) return [];
  return fs
    .readFileSync(frameLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Paseo's `steerOrReplaceActiveTurn`, replayed. Returns how the daemon would
 * have disposed of the message: `steered`, or `replaced` after the cancel-and-
 * resend fallback an unavailable steer triggers.
 */
async function steerOrReplace(sessionId, expectedTurnId, clientMessageId) {
  const mark = events.length;
  const prompt = { clientMessageId, delivery: "steer", input: { type: "message", content: [{ type: "text", text: "steer now" }] } };
  await conn.send({ type: "session.prompt", sessionId, prompt });
  const result = await untilSince(mark, (e) => e.type === "session.prompt_result" && e.clientMessageId === clientMessageId, "steer prompt_result");
  if (result.result?.type === "steer" && result.result.turnId === expectedTurnId) {
    return { status: "steered", result };
  }
  await conn.send({ type: "session.interrupt", sessionId, requestId: `interrupt-${clientMessageId}` });
  await conn.send({ type: "session.prompt", sessionId, prompt: { ...prompt, delivery: "auto" } });
  return { status: "replaced", result };
}

let conn;

(async () => {
  conn = await registration.connect({
    capabilities: ["prompt.message", "prompt.steer", "prompt.command", "session.configure", "session.subsession", "permission"],
  });
  conn.onEvent((event) => events.push(event));

  check("provider declares prompt.steer", (conn.capabilities ?? []).includes("prompt.steer"), `[${(conn.capabilities ?? []).join(", ")}]`);

  const sessionId = `steer-${Date.now()}`;
  await conn.send({ type: "session.open", sessionId, config: { cwd: process.cwd(), mode: "build" }, history: "skip" });
  await until((e) => e.type === "session.ready" && e.sessionId === sessionId, `ready ${sessionId}`);

  // ---- open a turn and wait for the foreground child it is blocked on -----
  const startMark = events.length;
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: { clientMessageId: "s1", input: { type: "message", content: [{ type: "text", text: "start the job" }] } },
  });
  const started = await untilSince(startMark, (e) => e.type === "session.turn" && e.sessionId === sessionId && e.state === "started", "root turn started");
  const firstResult = await untilSince(startMark, (e) => e.type === "session.prompt_result" && e.clientMessageId === "s1", "s1 prompt_result");
  const childScoped = `${sessionId}:sub:child-S`;
  await until((e) => e.type === "session.opened" && e.sessionId === childScoped, "foreground child opened");
  await sleep(200);

  // `activeForegroundTurnId` is what the daemon steers by; it is the turnId the
  // plugin returned when the turn started.
  const acceptedTurnId = firstResult.result?.turnId;

  check("an ordinary prompt is still answered as a turn", firstResult.result?.type === "turn", JSON.stringify(firstResult.result));
  check(
    "the accepted turn id matches the session.turn started turnId",
    acceptedTurnId !== undefined && acceptedTurnId === started.turnId,
    `accepted=${acceptedTurnId} started=${started.turnId}`,
  );

  // ---- the daemon's steer path -------------------------------------------
  const admission = await steerOrReplace(sessionId, acceptedTurnId, "s2");

  check(
    "a steer into the running turn is admitted as a steer",
    admission.status === "steered" && admission.result.result?.type === "steer",
    `disposition=${admission.status} result=${JSON.stringify(admission.result.result)}`,
  );
  check(
    "the steer names exactly the turn the daemon bound",
    admission.result.result?.turnId === acceptedTurnId,
    `steer=${admission.result.result?.turnId} expected=${acceptedTurnId}`,
  );
  check(
    "the steered turn id equals the session.turn started turnId",
    admission.result.result?.turnId === started.turnId,
    `steer=${admission.result.result?.turnId} started=${started.turnId}`,
  );

  const recorded = frames();
  check(
    "steering never cancels or interrupts the running turn",
    recorded.filter((frame) => frame.method === "session/cancel").length === 0 &&
      !events.some((e) => e.type === "request.completed" && String(e.requestId ?? "").startsWith("interrupt-")),
    `${recorded.filter((frame) => frame.method === "session/cancel").length} session/cancel frame(s)`,
  );

  const steerDeliveries = recorded.filter((frame) => frame.method === "session/prompt" && frame.params?.delivery === "steer");
  const allPrompts = recorded.filter((frame) => frame.method === "session/prompt");
  check(
    "the steered message reaches the bridge exactly once",
    steerDeliveries.length === 1 &&
      steerDeliveries[0].params.contentBlocks?.some((block) => block.text === "steer now") === true &&
      allPrompts.length === 2,
    `${steerDeliveries.length} steer delivery(ies), ${allPrompts.length} prompt(s) total`,
  );
  const steerEchoes = events.filter((e) => e.type === "timeline.item" && e.item?.type === "user_message" && e.item.clientMessageId === "s2");
  // The row is emitted exactly once, after the bridge named the DSH message, so it
  // carries its revert token from the start. Splitting it into "shown now, token
  // later" left a window where Paseo's rewind button appeared on a row the daemon
  // could not map to a provider token.
  const steerRowIds = new Set(steerEchoes.map((event) => event.item.id));
  check(
    "the steered message lands in the timeline as exactly one row",
    steerEchoes.length === 1 && steerRowIds.size === 1,
    `${steerEchoes.length} echo(es) over ${steerRowIds.size} row id(s)`,
  );
  check(
    "and the row carries a revert token",
    steerEchoes[0]?.item?.revertToken?.messageId !== undefined,
    JSON.stringify(steerEchoes[0]?.item?.revertToken ?? null),
  );

  // ---- the child the parent was waiting on is untouched -------------------
  await until((e) => e.type === "session.turn" && e.sessionId === sessionId && e.state === "completed", "root turn completed");
  await sleep(200);
  const childTurns = events.filter((e) => e.type === "session.turn" && e.sessionId === childScoped);
  check(
    "the foreground child finishes normally under a steered parent",
    childTurns.some((e) => e.state === "started") &&
      childTurns.some((e) => e.state === "completed") &&
      !childTurns.some((e) => e.state === "canceled" || e.state === "failed"),
    childTurns.map((e) => e.state).join(","),
  );
  const rootStarts = events.filter((e) => e.type === "session.turn" && e.sessionId === sessionId && e.state === "started");
  check("steering does not open a second turn", rootStarts.length === 1, `${rootStarts.length} started event(s)`);

  // ---- no running turn: steer must not be claimed -------------------------
  const idleMark = events.length;
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: { clientMessageId: "s3", delivery: "steer", input: { type: "message", content: [{ type: "text", text: "no turn to steer" }] } },
  });
  const idleResult = await untilSince(idleMark, (e) => e.type === "session.prompt_result" && e.clientMessageId === "s3", "s3 prompt_result");
  check(
    "a steer with no running turn is answered honestly as a turn",
    idleResult.result?.type === "turn",
    JSON.stringify(idleResult.result),
  );

  // ---- a command is still a command, not a turn ---------------------------
  const commandMark = events.length;
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: { clientMessageId: "s4", input: { type: "command", name: "goal", arguments: "" } },
  });
  const commandResult = await untilSince(commandMark, (e) => e.type === "session.prompt_result" && e.clientMessageId === "s4", "s4 prompt_result");
  check("a registered command still answers completed, not a turn", commandResult.result?.type === "completed", JSON.stringify(commandResult.result));

  // ---- the turn id is identical even when the status arrives late ---------
  // Paseo binds `activeForegroundTurnId` to the prompt result's turn id, so the
  // plugin must name that same turn in `session.turn started`. Real DSH sends the
  // status first (the `steer` mode's order); this synthetic reverse order (reply,
  // then turn) pins the invariant defensively rather than depending on that
  // cross-process ordering.
  process.env.DSH_FAKE_MODE = "late";
  const conn2 = await registration.connect({ capabilities: ["prompt.message", "prompt.steer", "session.subsession", "permission"] });
  const events2 = [];
  conn2.onEvent((event) => events2.push(event));
  const lateId = `late-${Date.now()}`;
  await conn2.send({ type: "session.open", sessionId: lateId, config: { cwd: process.cwd(), mode: "build" }, history: "skip" });
  await untilIn(events2, (e) => e.type === "session.ready" && e.sessionId === lateId, `ready ${lateId}`);
  await conn2.send({
    type: "session.prompt",
    sessionId: lateId,
    prompt: { clientMessageId: "L1", input: { type: "message", content: [{ type: "text", text: "go" }] } },
  });
  const lateResult = await untilIn(events2, (e) => e.type === "session.prompt_result" && e.clientMessageId === "L1", "L1 prompt_result");
  const lateStarted = await untilIn(events2, (e) => e.type === "session.turn" && e.sessionId === lateId && e.state === "started", "L1 turn started");
  check(
    "the prompt result and the later session.turn started name the same turn",
    lateResult.result?.turnId === lateStarted.turnId && lateResult.result?.turnId === "turn:L1",
    `result=${lateResult.result?.turnId} started=${lateStarted.turnId}`,
  );

  // ---- a refused prompt leaves no ghost turn id ---------------------------
  process.env.DSH_FAKE_MODE = "failonce";
  const conn3 = await registration.connect({ capabilities: ["prompt.message", "prompt.steer", "session.subsession", "permission"] });
  const events3 = [];
  conn3.onEvent((event) => events3.push(event));
  const failId = `fail-${Date.now()}`;
  await conn3.send({ type: "session.open", sessionId: failId, config: { cwd: process.cwd(), mode: "build" }, history: "skip" });
  await untilIn(events3, (e) => e.type === "session.ready" && e.sessionId === failId, `ready ${failId}`);
  await conn3.send({
    type: "session.prompt",
    sessionId: failId,
    prompt: { clientMessageId: "F1", input: { type: "message", content: [{ type: "text", text: "go" }] } },
  });
  const failedResult = await untilIn(events3, (e) => e.type === "session.prompt_result" && e.clientMessageId === "F1", "F1 prompt_result");
  check("a refused prompt reports failed", failedResult.result?.type === "failed", JSON.stringify(failedResult.result));

  // A steer now must not be claimed: claiming one would mean the id issued for
  // the refused turn survived as a ghost.
  await conn3.send({
    type: "session.prompt",
    sessionId: failId,
    prompt: { clientMessageId: "F2", delivery: "steer", input: { type: "message", content: [{ type: "text", text: "probe" }] } },
  });
  const probe = await untilIn(events3, (e) => e.type === "session.prompt_result" && e.clientMessageId === "F2", "F2 prompt_result");
  check(
    "a refused prompt leaves no ghost turn id behind",
    probe.result?.type === "turn",
    JSON.stringify(probe.result),
  );

  // The next real turn still gets one consistent id.
  await conn3.send({
    type: "session.prompt",
    sessionId: failId,
    prompt: { clientMessageId: "F3", input: { type: "message", content: [{ type: "text", text: "go again" }] } },
  });
  const recovered = await untilIn(events3, (e) => e.type === "session.prompt_result" && e.clientMessageId === "F3", "F3 prompt_result");
  const recoveredStarted = await untilIn(events3, (e) => e.type === "session.turn" && e.sessionId === failId && e.state === "started", "F3 turn started");
  check(
    "the turn after a failure still gets one consistent id",
    recovered.result?.turnId === recoveredStarted.turnId && recovered.result?.turnId === "turn:F3",
    `result=${recovered.result?.turnId} started=${recoveredStarted.turnId}`,
  );

  // ---- cancel: a stop must stop the turn, and must say so -------------------
  //
  // Paseo's own cancel path is `ProviderRuntimeSession.interrupt()` →
  // `session.interrupt` (`@getpaseo/server` `agent/plugin-provider.js`), awaited
  // through `complete()`, which settles only on `request.completed` /
  // `request.failed`. Its adapters stop the provider's own run and report the
  // turn as canceled (`turn_canceled` in opencode/claude/codex). So three things
  // have to hold on the wire, and each of them failed at least once in a way the
  // UI could not show:
  //   1. the request is answered with a success receipt naming its requestId
  //   2. the runtime is actually told to stop (`session/cancel`), and the turn
  //      produces no further output afterwards — a receipt without a stop is
  //      "回成功但没停"
  //   3. the turn terminal is `canceled`, not `completed`, so a stop is not
  //      indistinguishable from a finish
  // The session must also stay usable: cancel is a turn cancel, never a kill.
  process.env.DSH_FAKE_MODE = "cancel";
  const conn4 = await registration.connect({ capabilities: ["prompt.message", "prompt.steer"] });
  const events4 = [];
  conn4.onEvent((event) => events4.push(event));
  const cancelSessionId = `cancel-${Date.now()}`;
  await conn4.send({ type: "session.open", sessionId: cancelSessionId, config: { cwd: process.cwd(), mode: "build" }, history: "skip" });
  await untilIn(events4, (e) => e.type === "session.ready" && e.sessionId === cancelSessionId, `ready ${cancelSessionId}`);

  const cancelMark = events4.length;
  const framesBefore = frames().length;
  await conn4.send({
    type: "session.prompt",
    sessionId: cancelSessionId,
    prompt: { clientMessageId: "c1", input: { type: "message", content: [{ type: "text", text: "count forever" }] } },
  });
  const cancelStarted = await untilIn(events4, (e) => e.type === "session.turn" && e.sessionId === cancelSessionId && e.state === "started", "cancel turn started");
  // Wait until the turn has demonstrably produced a stream of output, so a
  // no-op cancel cannot pass by being sent into a turn that never ran.
  const cancelOutput = (mark) =>
    events4.slice(mark).filter((e) => e.type === "timeline.item" && e.sessionId === cancelSessionId).length;
  const cancelWaitStart = Date.now();
  while (cancelOutput(cancelMark) < 3 && Date.now() - cancelWaitStart < 30000) await sleep(20);
  const outputBeforeCancel = cancelOutput(cancelMark);
  check("the turn is demonstrably producing output before the cancel", outputBeforeCancel >= 3, `${outputBeforeCancel} item(s) before the cancel`);

  const interruptRequestId = `interrupt-cancel-${Date.now()}`;
  await conn4.send({ type: "session.interrupt", sessionId: cancelSessionId, requestId: interruptRequestId });
  const interruptReceipt = await maybeIn(
    events4,
    (e) => e.type === "request.completed" && e.requestId === interruptRequestId,
    10000,
  );
  check(
    "a cancel is acknowledged with a request.completed naming its requestId",
    interruptReceipt !== undefined &&
      events4.every((e) => !(e.type === "request.failed" && e.requestId === interruptRequestId)),
    JSON.stringify(interruptReceipt ?? "(no receipt)"),
  );

  const cancelFrames = frames().slice(framesBefore).filter((frame) => frame.method === "session/cancel");
  check(
    "the cancel reaches the runtime as a session/cancel for that session",
    cancelFrames.length === 1 && cancelFrames[0].params?.sessionId === cancelSessionId,
    `${cancelFrames.length} session/cancel frame(s)`,
  );

  // Silence after the cancel: the fake keeps ticking until it is told to stop,
  // so a receipt that never stopped anything shows up here as a growing count.
  const outputAtCancel = cancelOutput(cancelMark);
  await sleep(600);
  const outputAfterCancel = cancelOutput(cancelMark);
  check(
    "no further output for the cancelled turn after the cancel",
    outputAfterCancel === outputAtCancel,
    `${outputAtCancel} item(s) at the cancel, ${outputAfterCancel} after 600ms`,
  );

  const cancelTerminal = await maybeIn(
    events4,
    (e) => e.type === "session.turn" && e.sessionId === cancelSessionId && e.state !== "started",
    8000,
  );
  check(
    "the cancelled turn is reported as canceled, not completed",
    cancelTerminal?.state === "canceled" && cancelTerminal?.turnId === cancelStarted.turnId,
    `state=${cancelTerminal?.state} turnId=${cancelTerminal?.turnId} started=${cancelStarted.turnId}`,
  );

  // Cancel is a turn cancel, never a kill: the same session takes another turn.
  const afterMark = events4.length;
  await conn4.send({
    type: "session.prompt",
    sessionId: cancelSessionId,
    prompt: { clientMessageId: "c2", input: { type: "message", content: [{ type: "text", text: "are you alive" }] } },
  });
  const afterTerminal = await maybeIn(
    events4,
    (e) => e.type === "session.turn" && e.sessionId === cancelSessionId && e.state === "completed" && e.turnId !== cancelStarted.turnId,
    15000,
  );
  check(
    "the session survives the cancel and runs the next turn",
    afterTerminal !== undefined &&
      events4
        .slice(afterMark)
        .some((e) => e.type === "timeline.item" && e.sessionId === cancelSessionId && /still alive/.test(e.item?.text ?? "")),
    `next turn state=${afterTerminal?.state}`,
  );
  check(
    "the cancel did not kill the runtime process",
    frames().filter((frame) => frame.method === "shutdown").length === 0,
    `${frames().filter((frame) => frame.method === "shutdown").length} shutdown frame(s)`,
  );

  await conn.close();
  await conn2.close();
  await conn3.close();
  await conn4.close();
  fs.rmSync(path.dirname(frameLog), { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(1);
});
