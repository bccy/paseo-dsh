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
 * `replaced` block, which is where the awaits before the claim sit:
 *
 *   1. open the session once and let it reach `session.ready` (`#sessions[id]`
 *      now holds a live instance, and `#opening` is empty again — the success
 *      path releases the claim before `session.ready`)
 *   2. issue **two** concurrent opens for that same provider session id; both
 *      pass the `#opening` check while it is empty, then both park on the first
 *      await inside `#acquirePoolProcess` — `await this.#awaitPoolShutdown()`,
 *      which resolves immediately but still yields a microtask, which is enough
 *      to order them
 *   3. the first wakes, finds the `replaced` instance, deletes its `#sessions`
 *      entry, and parks on `await replaced.close({park:false})` — a cross-process
 *      `session/close` round trip, so it stays parked for whole macrotasks
 *   4. the second wakes, finds `#sessions` already empty, claims `#opening` and
 *      completes its open — the winner
 *   5. the first wakes again, claims `#opening` (a `Set.add` is idempotent),
 *      overwrites `#sessions`, and fails `attachSession`; its catch deletes the
 *      winner's entry and disposes the winner's agent
 *
 * **The yield points changed when the parked pool was deleted.** Step 2 used to
 * name `ParkedSessions.quiesce` (`await this.#parked.quiesce(...)` in `#open`);
 * that class and its `quiesce` are gone, so the first yield is now
 * `#acquirePoolProcess`'s own `await this.#awaitPoolShutdown()`. The window is
 * still real and still reproduced by this script — the two awaits that make it
 * are `await replaced.close({ park: false })` (step 3) and `await session.open()`
 * (inside step 4/5), both of which cross the child process. Measured when the
 * pool was deleted: this check stayed 8/8, i.e. no assertion depended on
 * `quiesce` being the yield, which is why deleting it did not need a harness
 * change here.
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
 *   6. the `session.config` published by the open advertises exactly the modes
 *      the catalog advertised — one capability source, not a second local list.
 *      The fake `dsh` reports `planMode: false`, so before this was one source a
 *      profile without plan-mode hid Plan in the draft and re-advertised it as
 *      `availableModes` after the session opened.
 *
 * Run:
 *   node harness/concurrent-open-check.mjs [compiled-plugin-dir]
 *
 * (it compiles the plugin into `paseo-plugin/.dbg-t6` itself unless a build
 * directory is passed, and uses the scripted fake `dsh` with a throwaway
 * `DSH_HOME`, so no profile, model or daemon is touched)
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-t6");
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
// Step 1b: the advertised modes have a single source.
//
// `session.config.modes` is what the host publishes as `availableModes`
// (`@getpaseo/server@0.14.0` `plugin-provider.js:1197-1204`). The catalog is
// where the bridge's `planMode` filter is applied, so the session must report
// that same list back; deriving a second, unconditional list inside the session
// made a profile without plan-mode hide Plan in the draft and offer it again as
// soon as the session opened — a toggle the user could pick but never apply.
// The policy order is checked by appending here rather than in its own step: the
// open transaction is the only place `session.config` is published, so this is
// where a regression in it would land.
const catalogMark = events.length;
await conn.send({ type: "catalog", requestId: "catalog-modes", cwd: process.cwd() });
const catalogDeadline = Date.now() + 15000;
let catalogEvent;
while (catalogEvent === undefined && Date.now() < catalogDeadline) {
  catalogEvent = events
    .slice(catalogMark)
    .find((event) => event.type === "catalog" && event.requestId === "catalog-modes");
  if (catalogEvent === undefined) await sleep(20);
}
const configEvent = events.find((event) => event.type === "session.config" && event.sessionId === sessionId);
const catalogModes = (catalogEvent?.catalog?.modes ?? []).map((mode) => mode.id);
const configModes = (configEvent?.config?.modes ?? []).map((mode) => mode.id);
check(
  "session.config advertises exactly the catalog's modes (one capability source)",
  catalogEvent !== undefined && configEvent !== undefined
    && JSON.stringify(configModes) === JSON.stringify(catalogModes),
  `catalog=${JSON.stringify(catalogModes)}, config=${JSON.stringify(configModes)}`,
);

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

// ===========================================================================
// Part 2: the three windows the `#opening` claim alone does not close.
//
// Part 1 above pins the window that exists *between the two opens themselves*
// (two opens for one provider id, both past the check). The open transaction
// has three more, and each needs a second request placed **inside** an await of
// the first one:
//
//   a. the previous holder's `close()` — the claim used to be taken after it, so
//      a close landing in that window was invisible to the open, which then
//      published readiness for a session the daemon had just closed;
//   b. the `#sessions` re-registration — a close during the open must invalidate
//      publication, not merely race it;
//   c. provider-id rebinding — the same provider id opened against a *different*
//      native session while the first open is still running. The `#opening` set
//      is keyed by the native id only, so this pair was not exclusive at all.
//
// Each scenario needs its own child process: `DSH_FAKE_HOLD_*` is read by the
// bridge child, and a child's environment is frozen at spawn. Closing the
// connection retires the child, so a fresh `connect()` spawns one that sees the
// new values.
// ===========================================================================


/** A throwaway directory for one scenario's hold markers. */
function holdDir() {
  return mkdtempSync(join(tmpdir(), "dsh-open-hold-"));
}

/**
 * Run one scenario against a connection whose bridge parks `holdMethod` until
 * `release()` is called.
 *
 * `body` receives the helpers it needs and must drive the open itself, so each
 * scenario states its own interleaving instead of sharing a scripted one.
 */
async function withHeldBridge(holdMethod, holdSession, body) {
  const dir = holdDir();
  const ready = join(dir, "ready");
  const release = join(dir, "release");
  process.env.DSH_FAKE_HOLD_METHOD = holdMethod;
  process.env.DSH_FAKE_HOLD_SESSION = holdSession;
  process.env.DSH_FAKE_HOLD_READY = ready;
  process.env.DSH_FAKE_HOLD_RELEASE = release;
  const connection = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
  const heldEvents = [];
  connection.onEvent((event) => heldEvents.push(event));
  try {
    return await body({
      conn: connection,
      events: heldEvents,
      /** Release the parked request. Idempotent. */
      release: () => writeFileSync(release, "release"),
      /** Wait until the bridge has actually parked on the held method. */
      held: () => waitUntil(() => existsSync(ready), 20000),
    });
  } finally {
    writeFileSync(release, "release");
    await connection.close();
    for (const key of ["DSH_FAKE_HOLD_METHOD", "DSH_FAKE_HOLD_SESSION", "DSH_FAKE_HOLD_READY", "DSH_FAKE_HOLD_RELEASE"]) {
      delete process.env[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (a) A close landing while the open is still inside its awaits must invalidate
//     it: no `session.opened` / `session.ready` for a session the daemon closed,
//     and the open itself has to fail loudly rather than publish.
//
// The hold is on `session/close` — the *previous holder's* teardown, which is the
// first await inside the transaction once a holder exists. Without a claim taken
// before it, the reentrant close below sees an open with no claim and cannot
// invalidate it.
// ---------------------------------------------------------------------------
console.log("\na close during the open's own awaits invalidates publication");
{
  // Open once so the next open has a holder to close, then hold that close.
  const setup = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
  const setupEvents = [];
  setup.onEvent((event) => setupEvents.push(event));
  const nativeId = `held-native-${String(Date.now())}`;
  await setup.send(openInput("holder-open", "holder-provider", { version: 1, data: { sessionId: nativeId } }));
  await waitUntil(
    () => setupEvents.some((event) => event.type === "session.ready" && event.sessionId === "holder-provider"),
    20000,
  );
  await setup.close();

  await withHeldBridge("session/close", "", async ({ conn: heldConn, events: heldEvents, release, held }) => {
    // Re-establish a holder under this connection, then take the held close.
    await heldConn.send(openInput("holder-2", "holder-2", { version: 1, data: { sessionId: nativeId } }));
    await waitUntil(
      () => heldEvents.some((event) => event.type === "session.ready" && event.sessionId === "holder-2"),
      20000,
    );

    // This open will park on the holder's `session/close` — the hold is armed.
    const victim = heldConn.send(
      openInput("victim", "victim", { version: 1, data: { sessionId: nativeId } }),
    );
    const parked = await held();
    check(
      "(a) the open parks on the previous holder's close (the window exists)",
      parked === true,
      String(parked),
    );

    // Close the session the open is still opening, *from inside that window*.
    const mark = heldEvents.length;
    await heldConn.send({ type: "session.close", requestId: "close-mid-open", sessionId: "victim" });
    release();
    await victim;
    await sleep(300);

    const after = heldEvents.slice(mark);
    check(
      "(a) a close mid-open makes the open fail loudly",
      after.some((event) => event.type === "request.failed" && event.requestId === "victim"),
      after
        .filter((event) => event.type === "request.failed")
        .map((event) => `${String(event.requestId)}: ${String(event.error?.message)}`)
        .join(" | ") || "(no failure)",
    );
    check(
      "(a) …and it publishes no readiness for the closed session",
      !after.some(
        (event) =>
          (event.type === "session.ready" || event.type === "session.opened")
          && event.sessionId === "victim",
      ),
      after
        .filter((event) => event.sessionId === "victim")
        .map((event) => event.type)
        .join(", ") || "(nothing)",
    );
  });
}

// ---------------------------------------------------------------------------
// (b) One provider id cannot be rebound to a *different* native session while an
//     open for it is in flight.
//
// The `#opening` set is keyed by the native id, so before the provider-id claim
// existed these two opens were not exclusive at all: the second one saw a
// different native id, passed the check, and both went on to publish for the
// same provider id. The hold is on `paseo/commands` — late in the open, after
// the native claim but before publication — so the rebinding open arrives while
// the first one is unmistakably mid-transaction.
// ---------------------------------------------------------------------------
console.log("\na provider id cannot be rebound to another native session mid-open");
await withHeldBridge("paseo/commands", "", async ({ conn: rebindConn, events: rebindEvents, release, held }) => {
  const first = rebindConn.send(
    openInput("first", "shared-provider", { version: 1, data: { sessionId: "native-one" } }),
  );
  const parked = await held();
  check(
    "(b) the first open parks late in the transaction (the window exists)",
    parked === true,
    String(parked),
  );

  // Same provider id, different native id — the reload-under-a-fresh-agent-id
  // shape, but arriving while the first open still owns the id.
  const rebindMark = rebindEvents.length;
  await rebindConn.send(
    openInput("second", "shared-provider", { version: 1, data: { sessionId: "native-two" } }),
  );
  release();
  await first;
  await sleep(300);

  const rebindAfter = rebindEvents.slice(rebindMark);
  check(
    "(b) the rebinding open is refused loudly",
    rebindAfter.some((event) => event.type === "request.failed" && event.requestId === "second"),
    rebindAfter
      .filter((event) => event.type === "request.failed")
      .map((event) => `${String(event.requestId)}: ${String(event.error?.message)}`)
      .join(" | ") || "(no failure)",
  );
  check(
    "(b) …and exactly one open publishes readiness for that provider id",
    rebindEvents.filter((event) => event.type === "session.ready" && event.sessionId === "shared-provider").length === 1,
    String(rebindEvents.filter((event) => event.type === "session.ready" && event.sessionId === "shared-provider").length),
  );
});

console.log(`\n  ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log(`  ${failed} FAILED`);
  process.exit(1);
}
