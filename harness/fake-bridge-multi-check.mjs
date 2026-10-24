/**
 * The `multi` scenario: one bridge process, several Paseo sessions.
 *
 * This is the harness-side precondition for the one-process-multi-session work.
 * Every other fake-bridge mode drives a single root, so the plugin has never had
 * a way to be tested against "two sessions share one `dsh` child" — the exact
 * arrangement the change introduces. Before this mode existed, the fake bridge
 * latched onto the first `sessionId` it saw (`rootId` was a module-level
 * singleton) and emitted every event against it, so a multi-session check could
 * only ever observe one session's traffic.
 *
 * What this check pins:
 *   1. each session's prompt gets its own answer, and no session sees another's
 *      (`answer for <id>` — a cross-routed event would show the wrong id)
 *   2. each session gets exactly one `turn/end`, on its own turn number
 *   3. `initialize` carries no session id and does not disturb the binding, so a
 *      shared process keeps serving every session after one initialize
 *   4. the per-session scenario state is real: a second prompt to the *same*
 *      session does not re-emit the first session's scenario
 *
 * Pure protocol: it spawns the fake bridge and speaks JSON-RPC to it. No plugin,
 * no daemon, no model. Run with `node harness/fake-bridge-multi-check.mjs`.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(here, "fake-dsh-bridge.mjs");

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  }
}

/**
 * Run one bridge process and collect every frame it emits.
 *
 * `promptsPerSession` sends that many prompts to **each** session, which is what
 * makes "one answer per prompt" distinguishable from "one answer per process":
 * with a single prompt both look identical.
 */
function runBridge({ mode, sessionIds, promptsPerSession = 1 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DSH_FAKE_MODE: mode },
    });
    const frames = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() === "") continue;
        try {
          frames.push(JSON.parse(line));
        } catch {
          /* the bridge only writes JSON lines; ignore anything else */
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      /* the bridge writes no diagnostics of its own */
    });
    child.on("error", reject);

    let nextId = 1;
    const send = (method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })}\n`);
    };
    const settle = (ms) => new Promise((done) => setTimeout(done, ms));

    void (async () => {
      // One initialize, no session id — the shape a shared process sees.
      send("initialize", { cwd: process.cwd() });
      await settle(30);
      for (const sessionId of sessionIds) {
        send("paseo/commands", { sessionId });
        await settle(10);
      }
      for (const sessionId of sessionIds) {
        for (let attempt = 0; attempt < promptsPerSession; attempt += 1) {
          send("session/prompt", { sessionId, contentBlocks: [{ type: "text", text: `hi ${sessionId} #${attempt}` }] });
        }
      }
      await settle(200 * promptsPerSession);
      child.kill("SIGKILL");
      resolve({ frames, sessionIds });
    })();
  });
}

/** Every `session.event` notification, flattened to `{sessionId, event}`. */
function sessionEvents(frames) {
  return frames
    .filter((frame) => frame.method === "session.event")
    .map((frame) => ({ sessionId: frame.params?.sessionId, event: frame.params?.event }));
}
/** Every `session.status` notification. */
function sessionStatuses(frames) {
  return frames
    .filter((frame) => frame.method === "session.status")
    .map((frame) => ({ sessionId: frame.params?.sessionId, status: frame.params?.status }));
}

const SESSIONS = ["multi-A", "multi-B", "multi-C"];

console.log("multi: one bridge process drives several sessions");
{
  const { frames } = await runBridge({ mode: "multi", sessionIds: SESSIONS });
  const events = sessionEvents(frames);

  // 1. Each session's answer names its own session, and only its own.
  for (const sessionId of SESSIONS) {
    const mine = events.filter(
      (entry) => entry.sessionId === sessionId && entry.event?.type === "assistant/message",
    );
    check(`session ${sessionId} receives exactly one answer`, mine.length === 1, `${mine.length}`);
    const text = mine[0]?.event?.data?.message?.content?.[0]?.text;
    check(`session ${sessionId}'s answer names its own session`, text === `answer for ${sessionId}`, String(text));
  }
  // No answer text belongs to a session other than the one that carried it.
  const crossed = events.filter((entry) => {
    if (entry.event?.type !== "assistant/message") return false;
    const text = entry.event?.data?.message?.content?.[0]?.text;
    return typeof text === "string" && text.startsWith("answer for ") && text !== `answer for ${entry.sessionId}`;
  });
  check("no answer is routed to the wrong session", crossed.length === 0, `${crossed.length} crossed`);

  // 2. Exactly one turn/end per session, on that session's own turn number.
  for (const sessionId of SESSIONS) {
    const ends = events.filter((entry) => entry.sessionId === sessionId && entry.event?.type === "turn/end");
    check(`session ${sessionId} ends exactly one turn`, ends.length === 1, `${ends.length}`);
    check(`session ${sessionId}'s turn number is its own`, ends[0]?.event?.data?.turn === 1, String(ends[0]?.event?.data?.turn));
  }

  // 3. Every session reaches idle, and the statuses are attributed per session.
  const statuses = sessionStatuses(frames);
  for (const sessionId of SESSIONS) {
    const mine = statuses.filter((entry) => entry.sessionId === sessionId);
    check(`session ${sessionId} reports running then idle`, mine.some((s) => s.status === "running") && mine.some((s) => s.status === "idle"), mine.map((s) => s.status).join(","));
  }
  const unknownStatus = statuses.filter((entry) => !SESSIONS.includes(entry.sessionId));
  check("no status is attributed to an unknown session", unknownStatus.length === 0, `${unknownStatus.length}`);
}

console.log("\nmulti: the scenario runs once per process, not once per prompt");
{
  // The claim needs a *control group that differs from the experiment*: one
  // session, but **two** prompts. A single prompt cannot tell "one answer per
  // process" from "one answer per prompt" apart — both produce exactly one
  // answer — so the earlier version of this block asserted nothing about the
  // property it names.
  //
  // The `multi` scenario answers the session that prompted (see
  // `emitMultiTurn`), so two prompts legitimately produce two answers for the
  // same session: what must NOT happen is a *re-run of the whole scenario* per
  // prompt. Both halves are pinned below.
  const { frames } = await runBridge({ mode: "multi", sessionIds: ["multi-A"], promptsPerSession: 2 });
  const events = sessionEvents(frames);
  const answers = events.filter((entry) => entry.event?.type === "assistant/message");
  check(
    "two prompts to one session produce two answers, not one (the scenario is per prompt, not per process)",
    answers.length === 2,
    `${answers.length}`,
  );
  check(
    "…and each answer is a fresh turn of that same session",
    answers.map((entry) => entry.event?.data?.turn).join(",") === "1,2",
    answers.map((entry) => entry.event?.data?.turn).join(","),
  );
  // The per-process half: the scenario must not *also* emit its process-wide set
  // (every session, every child, the ghost frame). A duplicate of the first
  // prompt's output on the second prompt would show up as a repeated turn number
  // or an answer attributed to a session that never prompted.
  const otherSessions = events.filter(
    (entry) => entry.sessionId !== "multi-A" && entry.event?.type === "assistant/message",
  );
  check(
    "a second prompt emits no event for any other session",
    otherSessions.length === 0,
    `${otherSessions.length}: ${otherSessions.map((entry) => entry.sessionId).join(",")}`,
  );
  const turns = events.filter((entry) => entry.event?.type === "turn/end").map((entry) => entry.event?.data?.turn);
  check(
    "the two prompts are two distinct turns, never a replayed first one",
    turns.join(",") === "1,2",
    turns.join(","),
  );
}

console.log("\nmulti: initialize does not bind a session");
{
  // A process that receives initialize before any session must still serve every
  // session afterwards. `initialize` carries no sessionId, so a bridge that
  // bound a root from it would have nothing to bind.
  const { frames } = await runBridge({ mode: "multi", sessionIds: ["multi-only"] });
  const events = sessionEvents(frames);
  const answer = events.find((entry) => entry.event?.type === "assistant/message");
  check("a session opened after initialize still runs", answer !== undefined, answer?.sessionId);
  check("its event is attributed to that session", answer?.sessionId === "multi-only", String(answer?.sessionId));
}

console.log(`\n  ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log(`  ${failed} FAILED`);
  process.exit(1);
}
