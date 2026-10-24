/**
 * Two Paseo sessions sharing one `dsh` child: no cross-talk, and a close on one
 * leaves the other working.
 *
 * This is the regression the one-process-multi-session change exists to make
 * safe, asserted at the **plugin** layer rather than at the fake bridge's own
 * protocol layer (that is `fake-bridge-multi-check.mjs`, which drives the bridge
 * directly). The distinction matters: the bridge's `multi` scenario can be
 * perfectly per-session while the plugin still routes one session's frames into
 * another, because the plugin keeps its own maps (`#sessions`, child ids, the
 * parked pool). Only a run through the plugin proves the pair is clean.
 *
 * What is pinned here:
 *   1. two sessions prompt a **single shared process** and each receives its own
 *      answer (`answer for <sessionId>`) — a crossed event shows the wrong id
 *   2. each session's timeline carries only its own message: no session sees the
 *      other's text under any event type
 *   3. each session gets exactly one `session.turn` start and one terminal turn
 *   4. closing one session does not disturb the other: the survivor still
 *      prompts and still answers
 *
 * Uses the scripted fake `dsh` (`harness/fake-dsh-bridge.mjs`, `multi` mode) and
 * a throwaway `DSH_HOME`, so no profile, model or daemon is touched.
 *
 * Run:
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg-t5 --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg-t5/package.json
 *   cp ../harness/multi-session-check.cjs ../harness/fake-dsh-bridge.mjs .dbg-t5/
 *   cd .dbg-t5 && node multi-session-check.cjs
 *
 * (or just `node harness/multi-session-check.mjs`, which compiles for you)
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolvePluginBuild } = require("./plugin-build.cjs");

// The fake `dsh` the plugin will spawn. It must be executable and it must be the
// one the plugin's `DshProcess` resolves — the plugin reads `DSH_BINARY`.
const fakeBridge = join(here, "fake-dsh-bridge.mjs");
if (!existsSync(fakeBridge)) {
  console.error(`fake bridge missing at ${fakeBridge}`);
  process.exit(2);
}
chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "multi";

// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which rewrites `$DSH_HOME/profiles/<name>/...` from the
// embedded bridge. The fake `dsh` needs no profile at all, so point DSH_HOME at a
// throwaway tree and delete it on exit.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-multi-session-check-"));
process.on("exit", () => {
  try {
    rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const buildDir = resolvePluginBuild(undefined, ".dbg-t5-multi");
const plugin = require(join(buildDir, "index.server.js")).default;

/**
 * Frames the plugin now sends that the scripted fake `dsh` has to answer.
 *
 * These are part of the one-process-multi-session protocol (`docs/IMPL-CONTRACT.md`
 * §1): `paseo/mcp/set` mounts a session's MCP entries at its agent scope, and
 * `session/close` clears one session's bridge state. The plugin sends both
 * unconditionally, so a fake bridge without them fails every `session.open`
 * with "unknown method" — which looks like a plugin regression but is really a
 * missing fake.
 *
 * This check cannot add them (the fake bridge is owned by the same task that
 * owns `dsh-bridge/`, and this harness task must not edit it). So the absence is
 * reported as a **blocked precondition**, loudly and with a non-zero exit, rather
 * than silently skipping the multi-session assertions — a skipped multi-session
 * check is indistinguishable from a passing one in a green run.
 */
const REQUIRED_FAKE_METHODS = ["paseo/mcp/set", "session/close"];
{
  const fakeSource = readFileSync(fakeBridge, "utf8");
  const missing = REQUIRED_FAKE_METHODS.filter(
    (method) => !fakeSource.includes(`case "${method}"`),
  );
  if (missing.length > 0) {
    console.error(
      [
        "BLOCKED: harness/fake-dsh-bridge.mjs does not answer the multi-session frames",
        `  missing: ${missing.join(", ")}`,
        "  the plugin sends these on every session.open / session.close, so no",
        "  plugin-level multi-session assertion can run until the fake bridge",
        "  implements them (docs/IMPL-CONTRACT.md §1.2 and §1.5).",
        "  This check owns only harness/*.cjs|mjs except the fake bridge, so it",
        "  cannot add them. Reported to the Lead.",
      ].join("\n"),
    );
    process.exit(3);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
const skipped = [];
function check(label, condition, detail) {
  if (condition === true) {
    passed += 1;
    console.log(`  PASS  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  }
}

/** Collect events from one connection until `predicate` holds, or time out. */
function waitFor(list, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = list.find(predicate);
      if (found !== undefined) return resolve(found);
      if (Date.now() > deadline) {
        return reject(
          new Error(`timed out; saw ${list.map((event) => event.type).join(", ") || "(nothing)"}`),
        );
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

let registration;
const pluginEvents = [];
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

const rootA = `multi-root-A-${Date.now()}`;
const rootB = `multi-root-B-${Date.now()}`;

// ---------------------------------------------------------------------------
// The routing decision itself, pinned where it is made.
//
// Every assertion below this section reads what the *plugin emits*, and a
// provider event carries a `sessionId` the plugin itself stamped on it. That
// makes those checks blind to the one failure this whole change exists to
// prevent: a frame handed to the wrong session's handler. The mis-delivery is
// invisible from the outside because `DshSession.#onSessionEvent`
// (`paseo-plugin/server/session.ts:1772`) drops any payload whose id is not its
// own — so "no cross-talk" and "cross-talk silently discarded" produce exactly
// the same event stream, and dropping both guards still left the plugin-level
// checks green (verified by mutation, see below).
//
// So `DshProcess` is driven directly here: two sessions attached to one process,
// a turn produced by B alone, and A's handler must never be called. The positive
// control matters as much as the negative one — a handler set that was never
// wired up would also report zero calls.
//
// Mutation check (run in a throwaway copy, never in this repo): making
// `dsh-process.ts:2044` broadcast the frame to every attached handler leaves
// every other assertion in this file green and turns only this section red.
//
// This runs *before* `DSH_FAKE_LOG` is armed below: the plugin-level
// single-process assertion counts every pid that received an `initialize`, and a
// second fake bridge spawned for this section would be counted as a second
// session carrier.
console.log("frames are routed by session id, never broadcast");
{
  const { DshProcess } = require(join(buildDir, "server", "dsh-process.js"));
  const eventsA = [];
  const eventsB = [];
  const statusesA = [];
  const statusesB = [];
  const sessionHandlers = (events, statuses) => ({
    onEvent: (payload) => events.push(payload),
    onStatus: (status, sessionId) => statuses.push({ status, sessionId }),
    onQuestion: async () => ({ answers: [] }),
    onExit: () => {},
  });
  const routed = new DshProcess({
    // The shared process is constructed under a sentinel that is not a
    // conversation (`POOL_PLACEHOLDER_SESSION_ID` in `provider.ts`). Using a
    // third id here is deliberate: if delivery ever falls back to "every handler
    // set in the map", the sentinel is one more place a frame can land, and the
    // assertions below would see it.
    sessionId: "placeholder-not-a-session",
    cwd: process.cwd(),
    route: { provider: "fake", model: "fake" },
    onEvent: () => {},
    onStatus: () => {},
    onQuestion: async () => ({ answers: [] }),
    onLog: () => {},
    onExit: () => {},
    onProtocolError: () => {},
  });
  try {
    await routed.attachSession(rootA, sessionHandlers(eventsA, statusesA));
    await routed.attachSession(rootB, sessionHandlers(eventsB, statusesB));
    await routed.prompt(rootB, "hello B");
    // The `multi` scenario answers a prompt with that session's own turn: one
    // `assistant/message`, one `turn/end`, and the running/idle status pair.
    const deadline = Date.now() + 15000;
    while ((eventsB.length < 2 || statusesB.length < 2) && Date.now() < deadline) {
      await sleep(20);
    }
    const typesB = eventsB.map((payload) => payload.event?.type);
    check(
      "the frame's own session receives it (positive control)",
      typesB.includes("assistant/message") && typesB.includes("turn/end"),
      typesB.join(", ") || "(nothing)",
    );
    check(
      "…and it names that session",
      eventsB.length > 0 && eventsB.every((payload) => payload.sessionId === rootB),
      eventsB.map((payload) => String(payload.sessionId)).join(", ") || "(nothing)",
    );
    // The negative control. This is the assertion the old version of this file
    // could not make: a broadcast delivery reaches A's handler here even though
    // it never reaches A's *timeline*.
    check(
      "the other session's event handler is never called",
      eventsA.length === 0,
      eventsA.length === 0
        ? "(never called)"
        : `${eventsA.length} call(s): ${eventsA
            .map((payload) => `${String(payload.sessionId)}:${String(payload.event?.type)}`)
            .join(" | ")}`,
    );
    check(
      "…and neither is its status sink",
      statusesA.length === 0,
      statusesA.length === 0
        ? "(never called)"
        : `${statusesA.length} call(s): ${statusesA.map((item) => `${item.sessionId}:${item.status}`).join(" | ")}`,
    );
    check(
      "B's statuses are B's own",
      statusesB.length === 2 && statusesB.every((item) => item.sessionId === rootB),
      statusesB.map((item) => `${item.sessionId}:${item.status}`).join(", ") || "(nothing)",
    );
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  the routing section could not run  — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      await routed.shutdown();
      await routed.waitForExit(3000);
    } catch {
      /* the fake bridge exits on `shutdown`; a failure here must not mask the assertions */
    }
  }
}

// ---------------------------------------------------------------------------
// The provider half of the reference count.
//
// `ParkedSessions.hold()` / `release()` are what stop the pool from killing a
// process other sessions are running in, but they are *called* from
// `provider.ts` (`#addPoolClaim` at :631, `#dropPoolClaims` at :652 and
// `#releasePoolProcess` at :708). `harness/parked-sessions-check.cjs` drives the
// pool directly, so it can prove the guards work but not that the provider ever
// takes a hold — deleting `provider.ts:631` left that whole file green (verified
// by mutation).
//
// So the methods are counted here, across the plugin-level run below: two
// sessions open onto one shared child, therefore exactly two claims, therefore
// exactly two holds. Counting is used instead of "was it called at all" because
// a hold per *request* would still pass the weaker form while drifting away from
// one-hold-per-claim.
const holdCalls = { hold: 0, release: 0 };
{
  const { ParkedSessions } = require(join(buildDir, "server", "parked-sessions.js"));
  for (const name of ["hold", "release"]) {
    const original = ParkedSessions.prototype[name];
    ParkedSessions.prototype[name] = function counted(...args) {
      holdCalls[name] += 1;
      return original.apply(this, args);
    };
  }
}

// The fake bridge records every frame it receives (with its own pid) when
// `DSH_FAKE_LOG` names a file. Arming it *before* the first open is what makes
// the single-process assertion possible: the log then contains the spawn frames
// of both sessions, and two distinct pids would mean one child per session.
const frameLog = join(process.env.DSH_HOME, "frames.jsonl");
process.env.DSH_FAKE_LOG = frameLog;

const conn = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
conn.onEvent((event) => pluginEvents.push(event));

/** Open one provider session and wait for it to be ready. */
async function openSession(sessionId) {
  const mark = pluginEvents.length;
  await conn.send({
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    config: { cwd: process.cwd(), mode: "build" },
    history: "skip",
  });
  try {
    await waitFor(
      pluginEvents.slice(mark),
      (event) => event.type === "session.ready" && event.sessionId === sessionId,
    );
  } catch (error) {
    const failures = pluginEvents
      .slice(mark)
      .filter((event) => event.type === "request.failed" || event.type === "session.runtime_failed");
    console.error(
      `open ${sessionId} failed: ${failures.map((event) => event.error?.message ?? event.type).join(" | ")}`,
    );
    throw error;
  }
}

console.log("two sessions, one shared bridge process");
await openSession(rootA);
await openSession(rootB);
{
  // Both sessions must reach ready on the *same* fake bridge process. The fake
  // bridge logs every frame with its pid, so two distinct pids would mean the
  // plugin spawned a child per session — the arrangement this change removes.
  check("both sessions opened", true, `${rootA}, ${rootB}`);
  if (existsSync(frameLog)) {
    const frames = readFileSync(frameLog, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    // Which processes are involved, and what each one did.
    //
    // "Every pid in the log is the same pid" is the **wrong assertion**: the
    // provider also spawns short-lived probes (`probeProcess`, `initializeRoute:
    // false`) to read the catalog and to archive — they are legitimate, they
    // never carry a session, and counting them would demand a single process
    // where two are correct.
    //
    // The claim this check exists for is narrower: **the sessions share one
    // process**. So a pid is a "session carrier" when it received an
    // `initialize` (the per-process handshake) or a `session/prompt` for a real
    // session id — that is exactly the traffic a per-session child would
    // produce, and exactly what a probe never sends.
    const byPid = new Map();
    for (const frame of frames) {
      if (!byPid.has(frame.pid)) byPid.set(frame.pid, []);
      byPid.get(frame.pid).push({
        method: frame.method,
        sessionId: frame.params?.sessionId,
      });
    }
    const carriers = [...byPid.entries()].filter(([, calls]) =>
      calls.some((call) => call.method === "initialize" || call.method === "session/prompt"),
    );
    const describe = [...byPid.entries()]
      .map(([pid, calls]) => {
        const methods = [...new Set(calls.map((call) => call.method))];
        return `pid ${String(pid)}: ${methods.slice(0, 4).join(",")}`;
      })
      .join(" | ");
    check(
      "…on a single bridge process",
      carriers.length === 1,
      `session carriers ${String(carriers.length)}; ${describe}`,
    );
    // And that one process really served both sessions: a single pid with only
    // one session in the log would pass the check above for the wrong reason.
    const sessionIds = new Set(
      frames.map((frame) => frame.params?.sessionId).filter((id) => typeof id === "string"),
    );
    check(
      "…and that process served both sessions",
      sessionIds.has(rootA) && sessionIds.has(rootB),
      [...sessionIds].join(", "),
    );
  } else {
    failed += 1;
    console.log("  FAIL  the fake bridge wrote no frame log  — DSH_FAKE_LOG was not honoured");
  }
}

console.log("\ntwo sessions, two answers, no cross-talk");
{
  const markA = pluginEvents.length;
  await conn.send({
    type: "session.prompt",
    sessionId: rootA,
    prompt: { clientMessageId: "prompt-A", input: { type: "message", content: [{ type: "text", text: "hello A" }] } },
  });
  await conn.send({
    type: "session.prompt",
    sessionId: rootB,
    prompt: { clientMessageId: "prompt-B", input: { type: "message", content: [{ type: "text", text: "hello B" }] } },
  });
  // The `multi` scenario emits one interleaved turn for every session the process
  // serves, so both answers arrive without a second prompt.
  await sleep(1200);

  const fresh = pluginEvents.slice(markA);

  // The event names are different on the two sides of the plugin, and mixing
  // them up silently filters everything out:
  //
  //   bridge -> plugin:  `session.event`  (a DSH frame; `dsh-process.ts` turns
  //                                       it into timeline rows)
  //   plugin -> Paseo:   `timeline.item`  (a `ProviderTimelineItem`)
  //
  // This file listens to what the *plugin emits*, so it must read
  // `timeline.item`, and the row lives at `event.item` — verified by driving the
  // plugin and dumping the payload, not guessed from the DSH frame shape:
  //
  //   { type: "assistant_message", id: "assistant:1:1",
  //     messageId: "assistant:1:1", text: "answer for <sessionId>" }
  //
  // The earlier version of this check looked for `session.event` and read
  // `event.event.data.message.content[0].text`, so it matched nothing and
  // reported the plugin as broken.
  const answersOf = (sessionId) =>
    fresh.filter(
      (event) =>
        event.type === "timeline.item"
        && event.sessionId === sessionId
        && event.item?.type === "assistant_message",
    );

  const answersA = answersOf(rootA);
  const answersB = answersOf(rootB);
  check("session A receives its own answer", answersA.length === 1, `${answersA.length}`);
  check("session B receives its own answer", answersB.length === 1, `${answersB.length}`);

  /** The text of a timeline row, whatever kind it is. */
  const textOf = (event) => event.item?.text;
  check(
    "A's answer names A",
    textOf(answersA[0] ?? {}) === `answer for ${rootA}`,
    String(textOf(answersA[0] ?? {})),
  );
  check(
    "B's answer names B",
    textOf(answersB[0] ?? {}) === `answer for ${rootB}`,
    String(textOf(answersB[0] ?? {})),
  );

  // The stronger claim: no event delivered under one session carries the other
  // session's text. Checking the answers alone would miss an event that was
  // routed to both.
  const leaked = fresh.filter((event) => {
    const text = textOf(event);
    if (typeof text !== "string" || !text.startsWith("answer for ")) return false;
    return text !== `answer for ${event.sessionId}`;
  });
  check("no event carries another session's text", leaked.length === 0, `${leaked.length} leaked`);

  // And each session's turn bookkeeping is its own.
  for (const [label, sessionId] of [["A", rootA], ["B", rootB]]) {
    const turns = fresh.filter(
      (event) => event.type === "session.turn" && event.sessionId === sessionId,
    );
    const started = turns.filter((event) => event.state === "started");
    const finished = turns.filter((event) => event.state !== "started");
    check(
      `session ${label} opens and closes exactly one turn`,
      started.length === 1 && finished.length === 1,
      `${started.length} started, ${finished.length} finished`,
    );
  }
}

console.log("\nclosing one session leaves the other working");
{
  // `session.close` at the provider level is what the daemon sends when an agent
  // is closed. The other session must be untouched: still open, still able to
  // prompt, still answered.
  const mark = pluginEvents.length;
  await conn.send({ type: "session.close", sessionId: rootA });
  await sleep(400);
  const afterClose = pluginEvents.slice(mark);
  check(
    "closing A emits no event for B",
    afterClose.every((event) => event.sessionId !== rootB),
    afterClose.map((event) => `${event.type}@${String(event.sessionId)}`).join(", ") || "(no events)",
  );

  // The provider's side of the reference count, checked at the point where both
  // halves must have happened: two sessions opened (two claims, two holds) and A
  // has been closed (its claim returned, one hold released). `#dropPoolClaims`
  // would also release, but it only runs when the child dies, and the child is
  // alive here — so an extra release would mean a claim was returned twice.
  check(
    "the provider takes one hold per opened session",
    holdCalls.hold === 2,
    `${holdCalls.hold} hold(s) for 2 opened session(s)`,
  );
  check(
    "…and returns one when a session closes",
    holdCalls.release === 1,
    `${holdCalls.release} release(s) after closing 1 of 2 session(s)`,
  );
  check(
    "…so the shared child is still held, not free to kill",
    holdCalls.hold - holdCalls.release === 1,
    `net ${holdCalls.hold - holdCalls.release} hold(s)`,
  );

  // B keeps working. The `multi` scenario is process-wide and only runs once, so
  // this prompt is answered by the bridge's ordinary root path — what matters is
  // that the prompt is accepted and the session is still alive.
  const beforePrompt = pluginEvents.length;
  await conn.send({
    type: "session.prompt",
    sessionId: rootB,
    prompt: { clientMessageId: "prompt-B-after-close", input: { type: "message", content: [{ type: "text", text: "still there?" }] } },
  });
  await sleep(800);
  const afterPrompt = pluginEvents.slice(beforePrompt);
  check(
    "B still accepts a prompt after A is closed",
    !afterPrompt.some(
      (event) =>
        event.type === "request.failed"
        && (event.requestId === "prompt-B-after-close" || event.clientMessageId === "prompt-B-after-close"),
    ),
    afterPrompt
      .filter((event) => event.type === "request.failed")
      .map((event) => `${event.requestId}: ${event.error?.message}`)
      .join(" | ") || "(accepted)",
  );
  check(
    "B reports no runtime failure",
    !afterPrompt.some((event) => event.type === "session.runtime_failed"),
    afterPrompt.filter((event) => event.type === "session.runtime_failed").map((event) => event.error?.message).join(" | ") || "(none)",
  );

  // And a prompt for the closed session must not silently succeed, and must not
  // be answered under any other session.
  //
  // The row the plugin emits is `timeline.item`, with the text at
  // `event.item.text` — the same shape `answersOf` reads earlier in this file (see
  // the comment there for the dumped payload). The previous version of this check
  // read `event.event?.type`, a field that **never exists** on a provider event
  // (`event.event` is a DSH frame field, not a `ProviderEvent` one), so
  // `answeredAsB` was always false and the assertion could not fail.
  const answerRows = (list) =>
    list.filter((event) => event.type === "timeline.item" && event.item?.type === "assistant_message");

  // Positive control first. Without it, a renamed field (exactly the bug above)
  // would make "no answer for the closed session" pass forever. A live prompt must
  // produce a row this filter can see.
  const controlMark = pluginEvents.length;
  await conn.send({
    type: "session.prompt",
    sessionId: rootB,
    prompt: { clientMessageId: "prompt-B-control", input: { type: "message", content: [{ type: "text", text: "control" }] } },
  });
  await sleep(800);
  const control = answerRows(pluginEvents.slice(controlMark));
  check(
    "the answer filter sees a live answer (positive control)",
    control.length === 1 && control[0].sessionId === rootB && control[0].item?.text === `answer for ${rootB}`,
    `${control.length} row(s): ${control.map((event) => `${String(event.sessionId)}:${String(event.item?.text)}`).join(" | ") || "(none)"}`,
  );

  const beforeClosed = pluginEvents.length;
  await conn.send({
    type: "session.prompt",
    sessionId: rootA,
    prompt: { clientMessageId: "prompt-A-after-close", input: { type: "message", content: [{ type: "text", text: "anyone home?" }] } },
  });
  await sleep(600);
  const afterClosed = pluginEvents.slice(beforeClosed);
  const answeredAfterClose = answerRows(afterClosed);
  check(
    "a prompt for the closed session is answered nowhere",
    answeredAfterClose.length === 0,
    answeredAfterClose.map((event) => `${String(event.sessionId)}:${String(event.item?.text)}`).join(" | ") || "(no answer row)",
  );
  check(
    "…and specifically never lands on B",
    answeredAfterClose.every((event) => event.sessionId !== rootB),
    answeredAfterClose.filter((event) => event.sessionId === rootB).map((event) => String(event.item?.text)).join(" | ") || "(nothing under B)",
  );
  // The other half of "never silently succeeds": the prompt has to fail visibly
  // for the session it was sent to. Either shape counts — the point is that the
  // user sees a failure instead of a prompt that vanished.
  check(
    "…and the closed session's prompt fails loudly instead of vanishing",
    afterClosed.some(
      (event) =>
        (event.type === "session.runtime_failed" && event.sessionId === rootA)
        || (event.type === "session.prompt_result" && event.sessionId === rootA && event.result?.type === "failed"),
    ),
    afterClosed.map((event) => `${event.type}@${String(event.sessionId)}`).join(", ") || "(no events)",
  );
}

await conn.close();

console.log(`\n  ${passed}/${passed + failed} passed`);
if (skipped.length > 0) {
  console.log(`  skipped: ${skipped.join("; ")}`);
}
if (failed > 0) {
  console.log(`  ${failed} FAILED`);
  process.exit(1);
}
