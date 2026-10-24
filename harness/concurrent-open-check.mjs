/**
 * Two concurrent `session.open` requests for **one** DSH session must not
 * destroy the one that succeeds.
 *
 * The provider's `#opening` set guards against two opens interleaving for the
 * same DSH session (only one process may own a session log's write lock). It is
 * only a guard if the check and the claim happen in the same synchronous turn.
 * They did not: the claim used to be taken *after* two awaits, so a second open
 * could pass the same check, finish first, and then the first one — waking up —
 * overwrote its `#sessions` entry and failed `attachSession` with "already
 * attached". Its catch then deleted the **winner's** `#sessions` entry and called
 * `session.close()`, which detaches the winner's handlers and tells the bridge to
 * dispose its agent.
 *
 * The result was the worst possible shape for a provider that serves several
 * Paseo sessions from one child: Paseo had received `session.ready` for the
 * winner, so the conversation looked open, yet every prompt on it failed with
 * "unknown session" and its agent had already been disposed.
 *
 * ## Reproducing the window
 *
 * A **cold** connection cannot reproduce it: with no `#sessions` entry there is
 * no `replaced` instance, so the only awaits before the claim are already-
 * resolved microtasks and the two opens never interleave. The window needs the
 * `replaced` block, which is exactly where the third await sits:
 *
 *   1. open the session once and let it reach `session.ready` (`#sessions[id]`
 *      now holds a live instance, and `#opening` is empty again — the success
 *      path releases the claim before `session.ready`)
 *   2. issue **two** concurrent opens for that same provider session id; both
 *      pass the `#opening` check while it is empty, then both park on
 *      `ParkedSessions.quiesce` (an `await` on a resolved promise still yields a
 *      microtask, which is enough to order them)
 *   3. the first wakes, finds the `replaced` instance, deletes its `#sessions`
 *      entry, and parks on `await replaced.close({park:false})` — a cross-process
 *      `session/close` round trip, so it stays parked for whole macrotasks
 *   4. the second wakes, finds `#sessions` already empty, claims `#opening` and
 *      completes its open — the winner
 *   5. the first wakes again, claims `#opening` (a `Set.add` is idempotent),
 *      overwrites `#sessions`, and fails `attachSession`; its catch deletes the
 *      winner's entry and disposes the winner's agent
 *
 * ## What is pinned (behaviour, read off the provider's own event stream)
 *
 *   1. exactly one of the two concurrent opens reaches `session.ready`
 *   2. the other one fails **loudly** (`request.failed`, not silence)
 *   3. the loser is refused by the in-flight guard ("another open … is already in
 *      flight"), never by `attachSession` ("already attached"). The distinction
 *      is the whole fix: reaching `attachSession` is what leaves the loser's
 *      catch holding the winner's state.
 *   4. the winner is still usable — a prompt on it is accepted and answered, and
 *      no prompt comes back "unknown session". This is the user-visible half.
 *   5. the failed transaction released the in-flight claim: a later open of the
 *      same DSH session (fresh provider session id + persistence handle, as a
 *      reload does) still succeeds. A leaked claim would refuse every later open
 *      for the connection's life.
 *
 * Run:
 *   node harness/concurrent-open-check.mjs
 *
 * (it compiles the plugin into `paseo-plugin/.dbg-t6` itself, and uses the
 * scripted fake `dsh` with a throwaway `DSH_HOME`, so no profile, model or
 * daemon is touched)
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolvePluginBuild } = require("./plugin-build.cjs");

// The fake `dsh` the plugin spawns. `multi` mode answers each session's prompt
// with `answer for <sessionId>`, which is how assertion 4 can tell the winner's
// own answer from anybody else's.
const fakeBridge = join(here, "fake-dsh-bridge.mjs");
if (!existsSync(fakeBridge)) {
  console.error(`fake bridge missing at ${fakeBridge}`);
  process.exit(2);
}
chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "multi";

// Loading the plugin calls `ensurePaseoProfile()`, which rewrites
// `$DSH_HOME/profiles/<name>/...` from the embedded bridge. The fake `dsh` needs
// no profile at all, so point DSH_HOME at a throwaway tree and delete it on exit.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-concurrent-open-check-"));
process.on("exit", () => {
  try {
    rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const buildDir = resolvePluginBuild(undefined, ".dbg-t6");
const plugin = require(join(buildDir, "index.server.js")).default;

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

/** Poll a predicate until it holds, or give up after `timeoutMs`. */
async function waitUntil(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

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

const conn = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
const events = [];
conn.onEvent((event) => events.push(event));

const cwd = process.cwd();
// One provider session id, and the DSH session id it maps to (no persistence
// handle, so they are the same). Paseo mints a fresh provider session id per
// open, so re-opening an id that is already open is the caller bug the guard
// exists to refuse — this check drives that bug on purpose.
const sessionId = `concurrent-open-${String(Date.now())}`;
const openInput = (requestId, id, persistence) => ({
  type: "session.open",
  requestId,
  sessionId: id,
  config: { cwd, mode: "build" },
  history: "skip",
  ...(persistence === undefined ? {} : { persistence }),
});
const readyFor = (id) =>
  events.some((event) => event.type === "session.ready" && event.sessionId === id);

// ---------------------------------------------------------------------------
// Step 1: open it once, so `#sessions[id]` holds a live instance. Without this
// there is no `replaced` instance and the race cannot happen (see the header).
// ---------------------------------------------------------------------------
console.log("a session is opened once, so a reopen has something to replace");
await conn.send(openInput("open-first", sessionId));
const firstReady = await waitUntil(() => readyFor(sessionId), 15000);
check("the first open reaches session.ready", firstReady === true, String(firstReady));
if (firstReady !== true) {
  // Everything below depends on a live instance; continuing would only produce
  // misleading failures. Report and stop with a non-zero exit.
  console.log(`\n  ${passed}/${passed + failed} passed`);
  console.log("  1 FAILED (precondition)");
  await conn.close();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 2: two concurrent opens for the same provider session id.
// ---------------------------------------------------------------------------
console.log("\ntwo concurrent opens for that same DSH session");
const concurrentRequestIds = ["open-A", "open-B"];
const raceMark = events.length;
const settled = await Promise.allSettled(
  concurrentRequestIds.map((requestId) => conn.send(openInput(requestId, sessionId))),
);
// `send()` turns a thrown open into a `request.failed` event, so both promises
// resolving is the contract; a rejection here would mean the provider leaked an
// exception past its own error handling.
check(
  "both opens are answered by the provider (no escaped exception)",
  settled.every((result) => result.status === "fulfilled"),
  settled
    .map((result) => (result.status === "fulfilled" ? "fulfilled" : String(result.reason?.message ?? result.reason)))
    .join(" | "),
);

// Wait for both transactions to reach an outcome. `session.ready` and
// `request.failed` are emitted at the very end of each transaction, so seeing
// one of each means both have run to completion.
await waitUntil(
  () =>
    events.slice(raceMark).filter(
      (event) =>
        (event.type === "session.ready" && event.sessionId === sessionId)
        || (event.type === "request.failed" && concurrentRequestIds.includes(event.requestId)),
    ).length >= 2,
  20000,
);
// The winner emits `session.ready` and the loser's catch runs around the same
// time; give the loser's cleanup a moment to land so the assertions below see
// the settled state rather than a snapshot mid-transaction.
await sleep(500);

const raceEvents = events.slice(raceMark);
const raceReady = raceEvents.filter(
  (event) => event.type === "session.ready" && event.sessionId === sessionId,
);
const raceFailed = raceEvents.filter(
  (event) => event.type === "request.failed" && concurrentRequestIds.includes(event.requestId),
);

// 1. Exactly one winner. Two `session.ready` would mean two live owners of one
//    DSH session (the write lock this guard protects); zero would mean the guard
//    refused both, which is not "one of them wins".
check(
  "exactly one of the two concurrent opens reaches session.ready",
  raceReady.length === 1,
  `ready ${String(raceReady.length)}; failed ${String(raceFailed.length)}`,
);

// 2. Positive control for the failure filter: the loser has to surface as a
//    `request.failed` for the assertions below to mean anything. Without this,
//    an event renamed out of the filter would make them vacuous.
check(
  "the other open fails loudly (request.failed, not silence)",
  raceFailed.length === 1,
  raceFailed.map((event) => `${String(event.requestId)}: ${String(event.error?.message)}`).join(" | ") || "(none)",
);

// 3. The loser must be stopped at the guard, before it can touch the winner.
//
// This is the assertion that pins the fix. Taking the `#opening` claim in the
// same synchronous turn as the check is what makes the second open stop here.
// Before the fix the loser reached `attachSession` and was refused with
// "already attached" — and its catch then deleted the winner's entry, detached
// the winner's handlers and disposed the winner's agent. Either direction of the
// race produces an "already attached" message when the guard is broken, so
// asserting on its absence is stable regardless of which open happens to win.
const loserMessages = raceFailed.map((event) => String(event.error?.message ?? ""));
check(
  "the loser is refused by the in-flight guard, not inside attachSession",
  loserMessages.length === 1
    && loserMessages[0].includes("is already in flight")
    && !loserMessages[0].includes("already attached"),
  JSON.stringify(loserMessages[0] ?? ""),
);

// 4. The winner is still usable. This is the user-visible symptom of the bug:
//    Paseo saw `session.ready`, so the conversation is open on screen, but the
//    provider had dropped the entry and the prompt came back "unknown session".
const promptMark = events.length;
await conn.send({
  type: "session.prompt",
  sessionId,
  prompt: {
    clientMessageId: "prompt-winner",
    input: { type: "message", content: [{ type: "text", text: "are you still there?" }] },
  },
});
const answered = await waitUntil(
  () =>
    events
      .slice(promptMark)
      .some(
        (event) =>
          event.type === "timeline.item"
          && event.sessionId === sessionId
          && event.item?.type === "assistant_message",
      ),
  15000,
);
const promptEvents = events.slice(promptMark);
const unknownSession = promptEvents.filter((event) =>
  String(event.error?.message ?? "").includes("unknown session"),
);
const answers = promptEvents.filter(
  (event) =>
    event.type === "timeline.item"
    && event.sessionId === sessionId
    && event.item?.type === "assistant_message",
);
check(
  "the winner's prompt is answered (its #sessions entry and bridge session survived)",
  answered === true && answers.length >= 1 && answers[0].item?.text === `answer for ${sessionId}`,
  `${String(answers.length)} answer row(s)`
    + `${answers.length === 0 ? "" : `: ${String(answers[0].item?.text)}`}; `
    + `unknown-session errors ${String(unknownSession.length)}`,
);
check(
  "…and no prompt was refused with \"unknown session\"",
  unknownSession.length === 0,
  unknownSession.map((event) => String(event.error?.message)).join(" | ") || "(none)",
);

// 5. The failed transaction must have released the in-flight claim. A reload
//    opens the same DSH session under a **fresh** provider session id with a
//    persistence handle, so the claim is keyed by the DSH id: a leaked one would
//    refuse every later open of it with "already in flight" for the connection's
//    life. This reopen takes the winner over (that is the reload path), so it
//    runs last.
const reopenId = `${sessionId}-reopened`;
const reopenMark = events.length;
await conn.send(openInput("open-reopen", reopenId, { version: 1, data: { sessionId } }));
const reopened = await waitUntil(() => readyFor(reopenId), 20000);
const reopenEvents = events.slice(reopenMark);
check(
  "a later open of the same DSH session still succeeds (the claim was released)",
  reopened === true,
  reopenEvents
    .filter((event) => event.type === "request.failed")
    .map((event) => `${String(event.requestId)}: ${String(event.error?.message)}`)
    .join(" | ") || "(opened)",
);

await conn.close();

console.log(`\n  ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log(`  ${failed} FAILED`);
  process.exit(1);
}
