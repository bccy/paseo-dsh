/**
 * Offline assertions for the jobs pill's state machine: the poll sequence, the
 * visibility/count rule, the polling policy and the controller's terminal and
 * pagination branches.
 *
 * `client/jobs-pill.tsx` imports the host runtime, so plain `node` cannot load it.
 * The rules live in `client/poll-sequence.ts` and `client/jobs-polling.ts`, which
 * have no React or host imports; this drives the real implementations — the
 * controller with a fake clock and a fake RPC, so its timers and terminal paths
 * are behaviour, not source regexes.
 *
 * The two scenarios at the top are the bugs review found in the first version:
 *
 * 1. a mass invalidation → `register`: the per-agent numbers were cleared, so
 *    the next poll took the same number again and a stale answer passed the "is
 *    it newest" test. (The directory snapshot no longer tears every entry down
 *    — since 2026-11-09 `applySnapshot` removes the diff and keeps the agents it
 *    still lists — so this now models a full teardown of the map, e.g. `dispose()`.)
 * 2. `remove` then `register`: `remove` never advanced the number, so an answer in
 *    flight still published into a deleted entry.
 *
 * The old algorithm is also re-implemented inline and asserted to *pass* the same
 * stale answers, so this file fails if someone reintroduces that shape.
 *
 * Run (from paseo-plugin):
 *   npx tsc -p ../harness/jobs-poll.tsconfig.json
 *   echo '{"type":"commonjs"}' > .dbg-poll/package.json
 *   cp ../harness/jobs-poll-check.cjs .dbg-poll/
 *   cd .dbg-poll && node jobs-poll-check.cjs
 *
 * The tsconfig carries the `@getpaseo/plugin` paths mapping: that SDK is ESM-only
 * with an exports map, which plain `--moduleResolution node` cannot read, and the
 * emitted CommonJS is what this harness requires at run time.
 */

"use strict";

const { createPollSequence } = require("./client/poll-sequence.js");
const {
  jobsPillCopy,
  jobsPillPresentation,
  isBridgeEnvironmentJobsError,
  nextPollDelayMs,
  initialPollDelayMs,
  isTerminalJobsErrorCode,
  createJobsPoller,
  LIVE_POLL_MS,
  MAX_POLL_MS,
  INITIAL_POLL_JITTER_MS,
  MAX_POLL_JITTER_MS,
} = require("./client/jobs-polling.js");
const fs = require("node:fs");
const path = require("node:path");
const {
  orderJobs,
  splitJobs,
  settleDownJobs,
  jobsList,
  JOB_ERROR_CODES,
  TERMINAL_JOB_ERROR_CODES,
} = require("./shared/jobs.js");

let failures = 0;
let checks = 0;
function check(what, actual, expected) {
  checks += 1;
  if (Object.is(actual, expected)) return;
  failures += 1;
  console.error(`  FAIL ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function equal(what, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures += 1;
  console.error(`  FAIL ${what}: expected ${e}, got ${a}`);
}

function assert(what, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${what}${detail === undefined ? "" : `: ${detail}`}`);
}

/* Primitives ----------------------------------------------------------------- */

console.log("poll sequence primitives");

{
  const sequence = createPollSequence();
  const first = sequence.issue("a");
  check("issue() starts at 1", first, 1);
  check("the first number is current", sequence.isCurrent("a", first), true);

  const second = sequence.issue("a");
  check("a second issue is larger", second > first, true);
  check("the older number is no longer current", sequence.isCurrent("a", first), false);

  // Numbers are global, not per agent: that is what makes "an old number can never
  // look newest again" true across a teardown.
  const other = sequence.issue("b");
  assert("numbers are unique across agents", other !== second, `a=${second} b=${other}`);
  check("an unknown agent has no latest number", sequence.latest("never"), undefined);
  check("another agent's number is not current", sequence.isCurrent("b", second), false);
}

/* Scenario 1: a mass invalidation then register() ---------------------------- */

// registered → poll in flight → every entry torn down at once → the same id
// registered again → new poll → the old answer arrives. It must not publish.
// This is *not* the snapshot path any more: `applySnapshot` removes the diff and
// keeps every entry the listing still names (2026-11-09, `client/agent-polling.ts`),
// so the scenario pins the sequence's rule for a full teardown (`dispose()`, or a
// future snapshot policy that does tear down).
console.log("\nscenario 1: invalidateAll() then register()");

{
  const sequence = createPollSequence();
  const inFlight = sequence.issue("x");
  sequence.invalidateAll();
  const fresh = sequence.issue("x");

  assert("the post-snapshot poll gets a NEW number", fresh !== inFlight, `both are ${fresh}`);
  check("the pre-snapshot answer must NOT publish", sequence.isCurrent("x", inFlight), false);
  check("the post-snapshot answer must publish", sequence.isCurrent("x", fresh), true);
}

/* Scenario 2: remove() with a poll in flight ---------------------------------- */

// The positive control matters: a sequence that rejected everything would also
// pass the first half of this scenario.
console.log("\nscenario 2: remove() with a poll in flight");

{
  const sequence = createPollSequence();
  const beforeRemove = sequence.issue("y");
  sequence.invalidate("y");

  check("the in-flight answer must NOT publish", sequence.isCurrent("y", beforeRemove), false);
  check("the agent has no latest number after removal", sequence.latest("y"), undefined);

  const afterReRegister = sequence.issue("y");
  assert("the new registration's number is larger", afterReRegister > beforeRemove, `${afterReRegister} vs ${beforeRemove}`);
  check("the new registration's answer MUST publish", sequence.isCurrent("y", afterReRegister), true);

  // Removing one agent must not disturb another's in-flight poll.
  const z = sequence.issue("z");
  sequence.invalidate("y");
  check("removing y leaves z's poll current", sequence.isCurrent("z", z), true);
}

/* The old algorithm must fail both ------------------------------------------- */

// `const issued = new Map(); seq = (issued.get(id) ?? 0) + 1; current = issued.get(id) === seq`
// with a mass invalidation clearing the map and `remove` doing nothing.
console.log("\nthe old algorithm must fail the same scenarios");

function createOldSequence() {
  const issued = new Map();
  return {
    issue(agentId) {
      const seq = (issued.get(agentId) ?? 0) + 1;
      issued.set(agentId, seq);
      return seq;
    },
    isCurrent(agentId, seq) {
      return issued.get(agentId) === seq;
    },
    invalidateAll() {
      issued.clear();
    },
    remove() {},
  };
}

{
  const old = createOldSequence();
  const inFlight = old.issue("x");
  old.invalidateAll();
  const fresh = old.issue("x");
  check("OLD: the post-snapshot poll collides", fresh, inFlight);
  check("OLD: so the stale answer wrongly publishes", old.isCurrent("x", inFlight), true);

  const old2 = createOldSequence();
  const beforeRemove = old2.issue("y");
  old2.remove();
  check("OLD: the removed agent's answer still publishes", old2.isCurrent("y", beforeRemove), true);
}

/* ---------------------------------------------------------------------------- */

// The pill draws `orderJobs(entry.jobs)`, not the registry's own order: a running
// job is what the user opened the popover for, so it must not sit under rows that
// already finished. The registry only promises *registration* order, and a
// settled row's registration position says nothing about when it finished.
console.log("\nrow order (running first, then settled newest-first)");
{
  const job = (id, status, startedAt, finishedAt) => ({ id, status, startedAt, finishedAt });

  // The reported shape: a live job registered FIRST, then settled ones — the
  // registry hands them back in registration order, so the live row would come
  // first by luck here. The real bug needs the live one registered later.
  const settledFirst = [
    job("a-settled-old", "completed", 100, 200),
    job("b-settled-new", "completed", 150, 400),
    job("c-live", "running", 300),
  ];
  equal(
    "a running job sorts above settled ones regardless of registration order",
    orderJobs(settledFirst).map((entry) => entry.id),
    ["c-live", "b-settled-new", "a-settled-old"],
  );

  // Two live jobs keep start order, so a long-running command stays at the top
  // instead of jumping around as the poll re-reads.
  const twoLive = [job("later", "running", 500), job("earlier", "running", 100)];
  equal(
    "live jobs keep start order",
    orderJobs(twoLive).map((entry) => entry.id),
    ["earlier", "later"],
  );

  // `stopping` is still live: it is work that has not settled, and hiding it
  // among the finished rows would make a stuck stop look done.
  const stopping = [job("done", "completed", 100, 200), job("stopping", "stopping", 150)];
  equal(
    "a stopping job still sorts with the live ones",
    orderJobs(stopping).map((entry) => entry.id),
    ["stopping", "done"],
  );

  // Same-millisecond settlements fall back to start order — the registry's map
  // iteration must not decide the result.
  const tie = [job("tie-late", "failed", 200, 500), job("tie-early", "completed", 100, 500)];
  equal(
    "rows settled in the same millisecond fall back to start order",
    orderJobs(tie).map((entry) => entry.id),
    ["tie-early", "tie-late"],
  );

  // A settled row with no `finishedAt` (a projection that dropped it) must not
  // sort as if it finished at the epoch.
  const noFinished = [job("no-finish", "killed", 300), job("has-finish", "completed", 100, 900)];
  equal(
    "a settled row without finishedAt falls back to its start time",
    orderJobs(noFinished).map((entry) => entry.id),
    ["has-finish", "no-finish"],
  );

  // The input must not be mutated: the store hands the same array to every
  // listener, and an in-place sort would reorder another render's data.
  const original = [job("x", "completed", 100, 200), job("y", "running", 150)];
  const snapshot = original.map((entry) => entry.id);
  orderJobs(original);
  equal("orderJobs does not mutate its input", original.map((entry) => entry.id), snapshot);

  // The OLD behaviour — registration order — must fail the first scenario, or
  // this block proves nothing.
  equal(
    "OLD: registration order puts a settled row above a live one",
    settledFirst.map((entry) => entry.id),
    ["a-settled-old", "b-settled-new", "c-live"],
  );
}

/* ---------------------------------------------------------------------------- */

// The popover splits the list so the finished half can fold away. The split runs
// AFTER the sort, so each half keeps its order without a second sort — and the
// counts decide the panel's shape: a live row plus a folded header, or (idle) the
// settled rows in full.
console.log("\npopover groups (live rows vs the foldable finished section)");
{
  const job = (id, status, startedAt, finishedAt) => ({ id, status, startedAt, finishedAt });

  const mixed = [
    job("done-old", "completed", 100, 200),
    job("live-late", "running", 300),
    job("done-new", "failed", 150, 400),
    job("live-early", "stopping", 50),
  ];
  const { live, settled } = splitJobs(mixed);
  equal("the live group holds only live jobs", live.map((entry) => entry.id), ["live-early", "live-late"]);
  equal("the settled group holds the rest, newest-first", settled.map((entry) => entry.id), ["done-new", "done-old"]);

  // The counts are what the header prints and what decides whether the section
  // starts folded; a split that dropped or duplicated a row would show up here.
  equal("every job lands in exactly one group", live.length + settled.length, mixed.length);

  // A `stopping` job is still live work — it must not fall into the finished
  // section, or a stuck stop would read as done.
  equal("a stopping job counts as live", splitJobs([job("s", "stopping", 1)]).settled.length, 0);

  // With nothing running the caller opens the section (nothing to protect), so
  // the split must still report the settled rows rather than swallowing them.
  const idle = splitJobs([job("a", "completed", 1, 2), job("b", "killed", 3, 4)]);
  equal("an idle session has no live group", idle.live.length, 0);
  equal("an idle session keeps its settled rows", idle.settled.map((entry) => entry.id), ["b", "a"]);

  // Same input-immutability rule as `orderJobs`: the store hands one array to
  // every listener, so sorting it in place would reorder another render's data.
  const before = mixed.map((entry) => entry.id);
  splitJobs(mixed);
  equal("splitJobs does not mutate its input", mixed.map((entry) => entry.id), before);

  // The OLD behaviour — one flat list — must fail the split's first assertion.
  equal("OLD: a flat list keeps the finished rows mixed in", mixed.map((entry) => entry.id),
    ["done-old", "live-late", "done-new", "live-early"]);
}

/* ---------------------------------------------------------------------------- */

// CJ-01, route 2: the pill is a **live indicator**. A session with no running /
// stopping job hides it, however much settled history the registry retains; the
// label is the live count, never an idle total.
//
// 2026-11-10: **visibility is a statement about jobs, never about a read.** A
// failed read that carries no known live job hides, like any empty answer; a
// failed read that carries a known live job keeps the pill and its count. The
// static mark is reserved for an unreadable registry with nothing to show (a
// hidden slot), matching baseline 2f71225.
console.log("\nthe pill's presentation (live-only, ring-only)");
{
  const settledOnly = jobsPillPresentation({
    available: true,
    jobs: [{ status: "completed" }, { status: "failed" }],
  });
  check("a session with no live job hides the pill", settledOnly.visible, false);
  check("a hidden idle pill keeps the turning ring, not the static mark", settledOnly.icon, "spinner");
  equal("a hidden idle pill has the neutral title", settledOnly.label, { kind: "title" });

  const liveAndSettled = jobsPillPresentation({
    available: true,
    jobs: [{ status: "running" }, { status: "completed" }, { status: "stopping" }],
  });
  check("a live job keeps the pill visible", liveAndSettled.visible, true);
  check("a live pill carries the turning ring", liveAndSettled.icon, "spinner");
  equal("a live pill counts only the live rows", liveAndSettled.label, { kind: "live", count: 2 });

  const empty = jobsPillPresentation({ available: true, jobs: [] });
  check("a genuinely empty session hides the pill", empty.visible, false);
  check("an empty session keeps the ring in the icon slot", empty.icon, "spinner");
  equal("an empty session has the neutral title", empty.label, { kind: "title" });

  const unreadable = jobsPillPresentation({ available: false, jobs: [] });
  // 2026-11-10: an unreadable answer is a statement about the *read*, not about
  // jobs. With no known live row it must hide, exactly like a readable empty
  // answer — otherwise one flaky RPC brings the pill back after it legitimately
  // hid, and keeps it up while the failure persists. Those are the two halves of
  // the user's "不消失 / 消失后重复出现".
  check("an unreadable registry with no known job hides the pill", unreadable.visible, false);
  // Baseline 2f71225 draws the static mark for `available: false`; that one
  // exception is kept (in a hidden slot). A turning ring there would claim
  // progress that is not happening.
  check("an unreadable registry keeps the baseline static mark", unreadable.icon, "static");
  equal("an unreadable registry has the neutral title", unreadable.label, { kind: "title" });

  // The positive control: the same failed read *carrying* the last known live job
  // is still a running job. It must keep the pill and its count, or the rule above
  // would hide real work.
  const unreadableWithLive = jobsPillPresentation({
    available: false,
    jobs: [{ status: "running" }, { status: "completed" }],
  });
  check("a failed read that carries a live job keeps the pill", unreadableWithLive.visible, true);
  check("…with the ring (the job runs; the read is what failed)", unreadableWithLive.icon, "spinner");
  equal("…and counts that live job", unreadableWithLive.label, { kind: "live", count: 1 });

  // The environment case: an old or unresponsive bridge cannot serve jobs at
  // all. The poller has already stopped on the terminal code; if the same answer
  // ever reaches a published state it must not leave a permanent error pill —
  // that was the user-reported "no tasks but always a 后台 pill" (FIELD-NOTES
  // #95). The predicate stays checkable on its own.
  const oldBridge = jobsPillPresentation({ available: false, jobs: [], code: "bridge_too_old" });
  check("an old/unresponsive bridge hides the pill", oldBridge.visible, false);
  check("…and keeps the static mark in the hidden slot", oldBridge.icon, "static");
  const registryMissing = jobsPillPresentation({ available: false, jobs: [], code: "registry_missing" });
  check("a missing job registry hides like any other failed read", registryMissing.visible, false);
  const transientFailure = jobsPillPresentation({ available: false, jobs: [], code: "rpc_failed" });
  check("a transient read failure hides like any other failed read", transientFailure.visible, false);
  const oldBridgeWithLive = jobsPillPresentation({
    available: false,
    jobs: [{ status: "running" }],
    code: "bridge_too_old",
  });
  check("the environment code hides even a carried live row (the poller has stopped)", oldBridgeWithLive.visible, false);
  check("only bridge_too_old is an environment (hiding) code", isBridgeEnvironmentJobsError("bridge_too_old"), true);
  check("registry_missing is not an environment (hiding) code", isBridgeEnvironmentJobsError("registry_missing"), false);

  // The invariant in one place: no readable answer — live or idle, visible or
  // hidden — may select the static mark. Route 1 made the settled-only pill
  // visible *and* static; this catches that regression at the rule.
  assert(
    "no readable answer uses the static mark",
    [settledOnly, liveAndSettled, empty].every((presentation) => presentation.icon === "spinner"),
  );
  assert(
    "no answer keeps an idle label kind",
    [settledOnly, liveAndSettled, empty].every((presentation) => presentation.label.kind !== "idle"),
  );

  // User decision 2026-11-05: the trigger's label is the bare noun in **every**
  // visible state — running, stopping, mixed, an unreadable registry — in both
  // languages. No count reaches the composer; the popover lists the jobs.
  const LANGS = {
    "zh-CN": { pillLabel: "后台", title: "后台任务" },
    en: { pillLabel: "Background", title: "Background tasks" },
  };
  const visibleAnswers = [
    ["one running", { available: true, jobs: [{ status: "running" }] }],
    ["one stopping", { available: true, jobs: [{ status: "stopping" }] }],
    ["running + stopping + settled", { available: true, jobs: [{ status: "running" }, { status: "stopping" }, { status: "completed" }] }],
    ["nine running", { available: true, jobs: Array.from({ length: 9 }, () => ({ status: "running" })) }],
    // A failed read carrying a live job is visible (2026-11-10); the failure
    // alone is not (that is the assertion above).
    ["a failed read carrying a live job", { available: false, jobs: [{ status: "running" }] }],
  ];
  for (const [lang, text] of Object.entries(LANGS)) {
    for (const [what, answer] of visibleAnswers) {
      const presentation = jobsPillPresentation(answer);
      check(`${what} is visible`, presentation.visible, true);
      check(`${lang}: ${what}: the trigger label is exactly ${text.pillLabel}`, jobsPillCopy(presentation, text).label, text.pillLabel);
    }
    check(`${lang}: the copy carries the label only (no count field)`, JSON.stringify(Object.keys(jobsPillCopy(liveAndSettled, text))), JSON.stringify(["label"]));
  }

  // The old route-1 rule, as an oracle: it kept the settled-only pill visible,
  // which is exactly the regression this block exists to catch.
  const oldVisible = (jobs) => jobs.length > 0;
  assert(
    "OLD: history-visible keeps a settled-only pill visible, unlike route 2",
    oldVisible([{ status: "completed" }]) !== settledOnly.visible,
  );
}

// ── The settlement latch ─────────────────────────────────────────────────
  // A **defensive** monotonicity guard (2026-11-10, review P2-4): DSH settles a
  // job once and the controller's in-flight/sequence guards already reject an
  // answer a newer poll superseded, so no observed answer has reported a settled
  // job as running. The latch covers only the paths those guards cannot see (a
  // bridge replaying a long open window, a second connection for the same agent)
  // and is kept because the symptom it would produce is the pill coming back
  // after the user watched the job finish.
  console.log("\nthe settlement latch (a settled job cannot run again)");
  {
    const running = { id: "bash-1", status: "running", startedAt: 100 };
    const completed = { id: "bash-1", status: "completed", startedAt: 100, finishedAt: 200 };

    const first = settleDownJobs([running], new Map());
    equal("a running job is passed through", first.jobs, [running]);
    equal("…and is not latched yet", [...first.settled.keys()], []);

    const settled = settleDownJobs([completed], first.settled);
    equal("a settled job is passed through unchanged", settled.jobs, [completed]);
    equal("…and is remembered by id", [...settled.settled.keys()], ["bash-1"]);
    check("…with its real outcome", settled.settled.get("bash-1").status, "completed");

    const regressed = settleDownJobs([running], settled.settled);
    equal("a later 'running' for the same id is projected back to its settled row", regressed.jobs, [completed]);
    equal("…so the latch does not grow again", [...regressed.settled.keys()], ["bash-1"]);

    // The positive control: a *new* job is a new id and must appear immediately.
    const secondJob = { id: "bash-2", status: "running", startedAt: 300 };
    const both = settleDownJobs([regressed.jobs[0], secondJob], regressed.settled);
    equal("a new job still appears", both.jobs, [completed, secondJob]);

    // Only a *live* claim is corrected: the rule exists to stop a count going back
    // up, not to overrule a later settled word. A settled→settled change passes
    // through, and the latch keeps the first settlement it saw.
    const refinished = settleDownJobs([{ id: "bash-1", status: "failed", startedAt: 100, finishedAt: 400 }], settled.settled);
    check("a later settled outcome for the same id is passed through", refinished.jobs[0].status, "failed");
    check("…and the latch keeps the first settlement", refinished.settled.get("bash-1").status, "completed");

    // Rows with no identity cannot be remembered; they pass through so foreign
    // payloads and fixtures are not silently dropped.
    const idless = settleDownJobs([{ status: "completed" }], new Map());
    equal("a row without a string id passes through unlatched", idless.jobs, [{ status: "completed" }]);
    equal("…and latches nothing", [...idless.settled.keys()], []);
}

// ── The popover keeps the failed-read note above the rows ─────────────────
// Review P3-4 (2026-11-10). The failure used to *replace* the list with the
// error, which is how a transient RPC failure made the sheet look as if the
// registry had changed. The fix keeps both: the note is rendered before the live
// rows in the same `<View>`, so a readable failure no longer early-returns.
console.log("\nthe popover renders the failed-read note above the rows");
{
  const candidates = [
    path.join(__dirname, "..", "client", "jobs-pill.tsx"),
    path.join(__dirname, "..", "paseo-plugin", "client", "jobs-pill.tsx"),
    path.join(__dirname, "client", "jobs-pill.tsx"),
  ];
  const sourceFile = candidates.find((candidate) => fs.existsSync(candidate));
  assert("the jobs pill source is reachable from this harness", sourceFile !== undefined, candidates.join(", "));
  if (sourceFile !== undefined) {
    const source = fs.readFileSync(sourceFile, "utf8");
    /**
     * The anchor is the marker comment **inside the row list**, not the first
     * `{unavailableNote}` in the file: the note also appears in the row-less
     * early return (`entry.jobs.length === 0` → note-only body), so a whole-file
     * `indexOf` stayed green even when the row list lost its copy — a false
     * green found in review (2026-11-10). Every index below is searched from the
     * marker, so the row-less branch cannot satisfy them.
     */
    const marker = source.indexOf("Above the rows so the failure is readable without scrolling.");
    const note = marker < 0 ? -1 : source.indexOf("{unavailableNote}", marker);
    const rows = marker < 0 ? -1 : source.indexOf("{live.map(", marker);
    assert("the row list's marker comment is present", marker >= 0, sourceFile);
    assert("the note is rendered after the row list's marker", note > marker, `marker=${String(marker)} note=${String(note)}`);
    assert(
      "the note is rendered immediately above the live rows (a note in another branch does not count)",
      rows > note && note > marker && note - marker < 400,
      `marker=${String(marker)} note=${String(note)} rows=${String(rows)} gap=${String(note - marker)}`,
    );
    assert(
      "a readable failure does not early-return the rows away",
      !/if \(entry !== undefined && !entry\.available\) \{/.test(source),
    );
  }
}

// CJ-02: one timer per agent must not become one burst per four seconds. The
// policy is a pure function of the failure count, so the base interval, the
// backoff and the jitter are assertable without a clock; the controller tests
// below drive the real timers. Live-only visibility makes the pill hidden most
// of the time, so the hidden interval must equal the visible one: the old 15 s
// hidden probe would make a new job appear up to four times slower than the
// baseline's 4 s.
console.log("\npolling intervals (one base rate, failure backoff, jitter)");
{
  check("a readable answer polls at the base interval", nextPollDelayMs(0, () => 0), LIVE_POLL_MS);
  check("the first failed read doubles the base", nextPollDelayMs(1, () => 0), LIVE_POLL_MS * 2);
  check("the second failed read doubles again", nextPollDelayMs(2, () => 0), LIVE_POLL_MS * 4);
  check("failure backoff is capped", nextPollDelayMs(8, () => 0), MAX_POLL_MS);

  const jittered = nextPollDelayMs(0, () => 0.99);
  assert("jitter is added, never subtracted", jittered > LIVE_POLL_MS, String(jittered));
  assert("jitter is capped", jittered <= LIVE_POLL_MS + MAX_POLL_JITTER_MS, String(jittered));
  assert(
    "two agents with different random draws do not share an interval",
    nextPollDelayMs(0, () => 0.1) !== nextPollDelayMs(0, () => 0.9),
  );

  const firstInitial = initialPollDelayMs(() => 0);
  const secondInitial = initialPollDelayMs(() => 0.999);
  check("an initial poll can start immediately", firstInitial, 0);
  assert(
    "initial polls are spread instead of created on one tick",
    secondInitial > firstInitial && secondInitial < INITIAL_POLL_JITTER_MS,
    `${firstInitial} / ${secondInitial}`,
  );
}

/* CJ-04: the contract's error code and the client's terminal rule ----------------- */

console.log("\nthe jobs error contract (terminal vs transient)");
{
  equal("the contract lists exactly the error codes", [...JOB_ERROR_CODES], [
    "bridge_too_old",
    "registry_missing",
    "rpc_failed",
  ]);
  equal("the terminal subset is the two unfixable codes", [...TERMINAL_JOB_ERROR_CODES], [
    "bridge_too_old",
    "registry_missing",
  ]);
  check("bridge_too_old is terminal", isTerminalJobsErrorCode("bridge_too_old"), true);
  check("registry_missing is terminal", isTerminalJobsErrorCode("registry_missing"), true);
  check("rpc_failed is not terminal", isTerminalJobsErrorCode("rpc_failed"), false);
  check("an unknown code is not terminal", isTerminalJobsErrorCode("something_else"), false);
  check("a missing code is not terminal", isTerminalJobsErrorCode(undefined), false);

  const withTerminal = jobsList.output.safeParse({
    available: false,
    jobs: [],
    error: { message: "old bridge", code: "bridge_too_old" },
  });
  check("jobs.list accepts a terminal code", withTerminal.success, true);
  const withTransient = jobsList.output.safeParse({
    available: false,
    jobs: [],
    error: { message: "flaky", code: "rpc_failed" },
  });
  check("jobs.list accepts a transient code", withTransient.success, true);
  const unknownCode = jobsList.output.safeParse({
    available: false,
    jobs: [],
    error: { message: "x", code: "not_a_code" },
  });
  check("jobs.list rejects an unknown code", unknownCode.success, false);
  const legacy = jobsList.output.safeParse({ available: false, jobs: [], error: { message: "x" } });
  check("a code-less error from an older server stays valid", legacy.success, true);

  // The server half's wiring: the contract above only helps if the plugin
  // actually sends the code. These three files are read as source because the
  // behavior they pin runs inside the daemon's plugin process (a spawned `dsh`
  // child, a Paseo connection) and cannot be driven offline; the client's half of
  // the same contract is behaviour-tested below.
  const repoRoot = path.resolve(__dirname, "..", "..");
  const readRepo = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
  const dshProcessSource = readRepo("paseo-plugin/server/dsh-process.ts");
  const providerSource = readRepo("paseo-plugin/server/provider.ts");
  const serverEntrySource = readRepo("paseo-plugin/index.server.ts");
  assert(
    "an unknown bridge method answers bridge_too_old",
    /code:\s*"bridge_too_old"/.test(dshProcessSource),
  );
  assert(
    "a paseo/jobs timeout is recognised (not rethrown as an unclassified error)",
    /#isBridgeTimeoutError\(error,\s*"paseo\/jobs"\)/.test(dshProcessSource) &&
      /const NO_ANSWER_PREFIX = "DeepSeek Harness did not answer "/.test(dshProcessSource),
  );
  assert(
    "a paseo/jobs timeout answers terminal bridge_too_old with the unresponsive message",
    /BRIDGE_UNRESPONSIVE_MESSAGE,\s*code:\s*"bridge_too_old"/.test(dshProcessSource),
  );
  assert(
    "a profile without a job registry is normalised to registry_missing",
    /REGISTRY_MISSING_MESSAGE\s*\?\s*"registry_missing"\s*:\s*"rpc_failed"/.test(dshProcessSource),
  );
  assert(
    "readAgentJobs forwards the error code",
    /result\.error\?\.code\s*===\s*undefined\s*\?\s*\{\}\s*:\s*\{\s*code:\s*result\.error\.code\s*\}/.test(providerSource),
  );
  assert(
    "the jobs.list RPC answers with the error object unchanged",
    /\(result\.error === undefined \? \{\} : \{ error: result\.error \}\)/.test(serverEntrySource),
  );
}

/* The controller, driven by a fake clock ----------------------------------------- */
async function runControllerChecks() {

  const { createFakeClock, createPollerHarness } = (() => {
    function createFakeClock() {
      let now = 0;
      let nextId = 1;
      const timers = new Map();
      return {
        setTimeout(fn, delay) {
          const id = nextId;
          nextId += 1;
          timers.set(id, { at: now + delay, fn });
          return id;
        },
        clearTimeout(id) {
          timers.delete(id);
        },
        pendingDelays() {
          return [...timers.values()].map((timer) => timer.at - now).sort((left, right) => left - right);
        },
        async advance(ms) {
          const target = now + ms;
          for (;;) {
            let due = null;
            for (const [id, timer] of timers) {
              if (timer.at <= target && (due === null || timer.at < due.at)) due = { id, at: timer.at, fn: timer.fn };
            }
            if (due === null) break;
            timers.delete(due.id);
            now = due.at;
            due.fn();
            // Let the poll's promise chain and its next schedule land before the
            // loop looks for the next due timer.
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
          }
          now = target;
        },
      };
    }

    function createPollerHarness(overrides = {}) {
      const clock = createFakeClock();
      const calls = { added: [], removed: [], states: [], errors: [], pages: [], reads: 0 };
      const host = {
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        random: overrides.random ?? (() => 0),
        readJobs:
          overrides.readJobs ??
          (async () => {
            calls.reads += 1;
            return { available: true, jobs: [] };
          }),
        listAgentPage:
          overrides.listAgentPage ??
          (async (cursor) => {
            calls.pages.push(cursor);
            return { entries: [], pageInfo: { hasMore: false, nextCursor: null } };
          }),
        addAgent(agent) {
          calls.added.push(agent.id);
        },
        removeAgent(agentId, reason, error) {
          calls.removed.push([agentId, reason, error === undefined ? undefined : error.code]);
        },
        publishState(agentId, state) {
          // A scenario may need the publish itself to fail (the controller's
          // top-level `onError` branch is only reachable when a tick rejects).
          if (overrides.publishState !== undefined) {
            overrides.publishState(agentId, state, calls);
            return;
          }
          calls.states.push([agentId, state]);
        },
        onError(message, error) {
          calls.errors.push([message, error instanceof Error ? error.message : error]);
        },
      };
      const poller = createJobsPoller(host);
      return { clock, calls, poller };
    }

    return { createFakeClock, createPollerHarness };
  })();

  // CJ-03: the subscription snapshot is one page (the daemon caps it at 200
  // entries). The controller must walk pageInfo.nextCursor, or agents after the
  // first page never get a pill until an unrelated agent_update happens to name
  // them.
  console.log("\nagent-directory snapshot pagination");
  {
    const pages = [];
    const harness = createPollerHarness({
      listAgentPage: async (cursor) => {
        pages.push(cursor);
        return { entries: [{ agent: { id: "agent-2", workspaceId: "ws" } }], pageInfo: { hasMore: false, nextCursor: null } };
      },
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "agent-1", workspaceId: "ws" } }],
      pageInfo: { hasMore: true, nextCursor: "cursor-1" },
    });
    equal("both pages are registered", harness.calls.added, ["agent-1", "agent-2"]);
    equal("the second page is fetched with the snapshot's cursor", pages, ["cursor-1"]);
    equal("a terminating directory raises no pagination error", harness.calls.errors, []);
    harness.poller.dispose();

    // The reverse control: a one-page snapshot must not fetch a page at all. A
    // controller that always paginates would pass the first half alone.
    const single = createPollerHarness();
    await single.poller.applySnapshot({
      entries: [{ agent: { id: "only", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    equal("a one-page snapshot makes no extra request", single.calls.pages, []);
    single.poller.dispose();
  }

  // A reconnect can deliver a fresh snapshot while an older snapshot's next page
  // is still in flight. The stale page must not resurrect its agents.
  {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const harness = createPollerHarness({
      listAgentPage: async () => {
        await gate;
        return { entries: [{ agent: { id: "stale-agent", workspaceId: "ws" } }], pageInfo: { hasMore: false, nextCursor: null } };
      },
    });
    const first = harness.poller.applySnapshot({
      entries: [{ agent: { id: "fresh-1", workspaceId: "ws" } }],
      pageInfo: { hasMore: true, nextCursor: "cursor-1" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "fresh-2", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    release();
    await first;
    assert("the stale page is discarded after a newer snapshot", !harness.calls.added.includes("stale-agent"));
    equal("only the newest snapshot's agents are registered", harness.calls.added.filter((id) => id !== "fresh-1"), ["fresh-2"]);
    harness.poller.dispose();
  }

  // CJ-02 (behaviour): the controller's own timers. Every readable answer polls
  // at the base interval — a settled-only answer now hides the pill, but hidden
  // is the normal state under live-only visibility, so it must not slow down to
  // the old 15 s probe. Failures grow 8 s → 16 s → the cap.
  console.log("\npoll controller cadence");
  {
    let answer = { available: true, jobs: [{ status: "completed" }] };
    const harness = createPollerHarness({
      readJobs: async () => {
        harness.calls.reads += 1;
        return answer;
      },
      random: () => 0,
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    equal("the first poll is scheduled immediately (random 0)", harness.clock.pendingDelays(), [0]);
    await harness.clock.advance(0);
    equal("the first readable answer publishes", harness.calls.states.length, 1);
    check("the settled answer keeps the pill's state available", harness.calls.states[0][1].available, true);
    equal("a settled (hidden) pill still polls at the base interval", harness.clock.pendingDelays(), [LIVE_POLL_MS]);

    answer = { available: true, jobs: [] };
    await harness.clock.advance(LIVE_POLL_MS);
    equal("a changed answer publishes", harness.calls.states.length, 2);
    equal("an empty pill keeps the base interval, not a slow hidden one", harness.clock.pendingDelays(), [LIVE_POLL_MS]);
    harness.poller.dispose();
  }

  // CJ-01 (behaviour): a poll that finds nothing new must not publish. Publishing
  // is what rebuilds the popover's store row (waking its listeners) and calls
  // `registration.update()`, which the host republishes unconditionally — and
  // under live-only visibility "nothing running" is the normal answer, so the
  // idle session was repainting the composer and any open popover every 4 s.
  console.log("\npoll controller publish dedup");
  {
    // A readable answer that repeats publishes once; a changed one still goes
    // through, and the cadence is untouched by the dedup.
    let answer = { available: true, jobs: [] };
    const harness = createPollerHarness({
      readJobs: async () => {
        harness.calls.reads += 1;
        return answer;
      },
      random: () => 0,
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal("the first readable answer publishes", harness.calls.states.length, 1);
    await harness.clock.advance(LIVE_POLL_MS);
    await harness.clock.advance(LIVE_POLL_MS);
    equal("two identical answers do not publish again", harness.calls.states.length, 1);
    equal("the deduped polls still run at the base interval", harness.clock.pendingDelays(), [LIVE_POLL_MS]);
    answer = { available: true, jobs: [{ status: "running" }] };
    await harness.clock.advance(LIVE_POLL_MS);
    equal("a job appearing publishes", harness.calls.states.length, 2);
    equal("…with the live answer", harness.calls.states[1][1].jobs.length, 1);
    harness.poller.dispose();
  }
  {
    // The same failure repeated is also the same answer: it must publish once
    // while the backoff still grows, and a different message must publish.
    let message = "registry exploded";
    const harness = createPollerHarness({
      readJobs: async () => {
        harness.calls.reads += 1;
        throw new Error(message);
      },
      random: () => 0,
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal("a failure publishes once", harness.calls.states.length, 1);
    await harness.clock.advance(LIVE_POLL_MS * 2);
    equal("the same failure repeated does not publish again", harness.calls.states.length, 1);
    equal("…and the backoff still grows", harness.clock.pendingDelays(), [LIVE_POLL_MS * 4]);
    message = "registry exploded differently";
    await harness.clock.advance(LIVE_POLL_MS * 4);
    equal("a different failure message publishes", harness.calls.states.length, 2);
    harness.poller.dispose();
  }
  {
    // Recovery is a change even when the job list is empty: the unavailable
    // answer must not stick.
    let fail = true;
    const harness = createPollerHarness({
      readJobs: async () => {
        harness.calls.reads += 1;
        if (fail) throw new Error("registry exploded");
        return { available: true, jobs: [] };
      },
      random: () => 0,
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal("a failure publishes once", harness.calls.states.length, 1);
    fail = false;
    await harness.clock.advance(LIVE_POLL_MS * 2);
    equal("recovery publishes even with no jobs", harness.calls.states.length, 2);
    check("…and the published answer is readable again", harness.calls.states[1][1].available, true);
    harness.poller.dispose();
  }
  {
    // The guard is per agent: two agents with identical answers each publish
    // their own first answer, and then neither publishes again.
    const harness = createPollerHarness({
      readJobs: async () => ({ available: true, jobs: [] }),
    });
    await harness.poller.applySnapshot({
      entries: [
        { agent: { id: "a", workspaceId: "ws" } },
        { agent: { id: "b", workspaceId: "ws" } },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal("each agent's first answer publishes", harness.calls.states.map(([agentId]) => agentId).sort(), ["a", "b"]);
    await harness.clock.advance(LIVE_POLL_MS);
    equal("…and identical answers publish nothing more", harness.calls.states.length, 2);
    harness.poller.dispose();
  }
  {
    // A re-registration is a new pill: its store row was dropped, so its first
    // answer must publish even if it is identical to the one before the drop.
    const harness = createPollerHarness({
      readJobs: async () => ({ available: true, jobs: [] }),
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal("a fresh registration publishes its first answer", harness.calls.states.length, 1);
    harness.poller.drop("a");
    harness.poller.upsert({ id: "a", workspaceId: "ws" });
    await harness.clock.advance(0);
    equal("a re-registration publishes again", harness.calls.states.length, 2);
    harness.poller.dispose();
  }
  {
    const harness = createPollerHarness({
      readJobs: async () => {
        harness.calls.reads += 1;
        throw new Error("registry exploded");
      },
      random: () => 0,
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    check("a failed read publishes an unavailable state", harness.calls.states[0][1].available, false);
    equal("the first failure backs off to 8 s", harness.clock.pendingDelays(), [LIVE_POLL_MS * 2]);
    await harness.clock.advance(LIVE_POLL_MS * 2);
    equal("the second failure backs off to 16 s", harness.clock.pendingDelays(), [LIVE_POLL_MS * 4]);
    await harness.clock.advance(LIVE_POLL_MS * 4);
    equal("the third failure is capped", harness.clock.pendingDelays(), [MAX_POLL_MS]);
    harness.poller.dispose();
  }

  // ── The two user-reported paths, end to end through the real controller ────
  // 2026-11-10. Path A "错误态→成功态": a failed read is a fact about the
  // transport, so it must not invent a pill when the last known answer had
  // nothing live, and must keep the pill (with the real count) when a job is
  // live. The state published on failure is what the popover renders, so it must
  // carry the last known rows instead of replacing them with the error.
  console.log("\npath A: a failed read never invents a pill");
  {
    let answer = { available: true, jobs: [] };
    let fail = false;
    /** Advance to the next scheduled poll (whatever the backoff is). */
    const step = async () => {
      const [delay] = harness.clock.pendingDelays();
      await harness.clock.advance(delay ?? 0);
    };
    const harness = createPollerHarness({
      readJobs: async () => {
        harness.calls.reads += 1;
        if (fail) throw new Error("Stream end encountered");
        return answer;
      },
      random: () => 0,
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    const last = () => harness.calls.states[harness.calls.states.length - 1][1];
    await step();
    check("the first readable empty answer hides the pill", jobsPillPresentation(last()).visible, false);

    fail = true;
    await step();
    equal("the failed read is published (the popover can say so)", last().available, false);
    equal("…carrying the last known rows, not a fabricated list", last().jobs, []);
    check("…and does not make the pill appear", jobsPillPresentation(last()).visible, false);

    // Path B: with a real job running, the same failure keeps the pill and its
    // count — the job is running whether or not the registry answers this poll.
    fail = false;
    answer = { available: true, jobs: [{ id: "bash-1", status: "running", startedAt: 1 }] };
    await step();
    check("a running job shows the pill", jobsPillPresentation(last()).visible, true);
    fail = true;
    await step();
    equal("the failure carries the running job", last().jobs, answer.jobs);
    check("…so the pill stays visible", jobsPillPresentation(last()).visible, true);
    equal("…and keeps the real count", jobsPillPresentation(last()).label, { kind: "live", count: 1 });

    // Recovery with the job settled: the pill hides, and the next failure does
    // not bring it back.
    fail = false;
    answer = { available: true, jobs: [{ id: "bash-1", status: "completed", startedAt: 1, finishedAt: 2 }] };
    await step();
    check("the settled answer hides the pill", jobsPillPresentation(last()).visible, false);
    fail = true;
    await step();
    check("a later failure does not bring it back", jobsPillPresentation(last()).visible, false);
    harness.poller.dispose();
  }

  // Review P2-1 (2026-11-10): with the pill no longer carrying a failed read,
  // the console line is the only thing that keeps "could not read" loud instead
  // of looking like "nothing is running". Exactly one line per entry into the
  // failed state (not per poll), one on recovery, and none for a terminal code —
  // the pill's removal already logs exactly one line there.
  console.log("\nthe failed-read console line");
  {
    let mode = "ok";
    const harness = createPollerHarness({
      readJobs: async () => {
        harness.calls.reads += 1;
        if (mode === "throw") throw new Error("Stream end encountered");
        if (mode === "unreadable") {
          return { available: false, jobs: [], error: { message: "registry exploded", code: "rpc_failed" } };
        }
        if (mode === "terminal") {
          return { available: false, jobs: [], error: { message: "reload the plugin", code: "bridge_too_old" } };
        }
        return { available: true, jobs: [] };
      },
      random: () => 0,
    });
    const step = async () => {
      const [delay] = harness.clock.pendingDelays();
      await harness.clock.advance(delay ?? 0);
    };
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await step();
    equal("a readable poll logs nothing", harness.calls.errors, []);

    mode = "throw";
    await step();
    equal("entering the failed state logs exactly once", harness.calls.errors.length, 1);
    equal(
      "…with the pill's console sentence and the agent id",
      harness.calls.errors[0][0],
      "jobs pill: could not read this session's jobs for a; keeping the last known answer until a read succeeds",
    );
    equal("…and the underlying message", harness.calls.errors[0][1], "Stream end encountered");

    await step();
    equal("a repeated failure does not log again", harness.calls.errors.length, 1);
    mode = "unreadable";
    await step();
    equal("a different failure shape in the same state does not log again", harness.calls.errors.length, 1);

    mode = "ok";
    await step();
    equal("recovery logs one line", harness.calls.errors.length, 2);
    equal(
      "…naming the recovery",
      harness.calls.errors[1][0],
      "jobs pill: this session's jobs are readable again for a",
    );
    equal("…with no error detail (the sink must not print \"undefined\")", harness.calls.errors[1][1], undefined);

    mode = "terminal";
    await step();
    equal("a terminal code adds no unreadable line (removal logs its own)", harness.calls.errors.length, 2);
    equal("…and removes the pill once", harness.calls.removed.map(([id, reason]) => [id, reason]), [["a", "terminal"]]);
    harness.poller.dispose();
  }

  // Path B "job 结算后": **a defensive guard, not a diagnosed regression** — the
  // fixture (a settled id reported running) is a shape DSH does not produce, and
  // the controller's sequence guard already rejects a superseded in-flight
  // answer. The latch covers the paths those guards cannot see; the assertion
  // pins the intended monotonicity: the stale answer is projected back to the
  // settled row, so it is identical to the previous one and the controller does
  // not even publish (no repaint, no pill). A genuinely new job is a new id and
  // still appears in the same poll.
  console.log("\npath B: a settled job cannot be resurrected by a later answer");
  {
    const answers = [
      { available: true, jobs: [{ id: "bash-1", status: "running", startedAt: 1 }] },
      { available: true, jobs: [{ id: "bash-1", status: "completed", startedAt: 1, finishedAt: 2 }] },
      // The stale read: same id, running again.
      { available: true, jobs: [{ id: "bash-1", status: "running", startedAt: 1 }] },
      // The positive control: a new job alongside the settled one.
      {
        available: true,
        jobs: [
          { id: "bash-1", status: "completed", startedAt: 1, finishedAt: 2 },
          { id: "bash-2", status: "running", startedAt: 3 },
        ],
      },
    ];
    let index = 0;
    const harness = createPollerHarness({
      readJobs: async () => {
        harness.calls.reads += 1;
        return answers[Math.min(index, answers.length - 1)];
      },
      random: () => 0,
    });
    const step = async () => {
      const [delay] = harness.clock.pendingDelays();
      await harness.clock.advance(delay ?? 0);
    };
    const last = () => harness.calls.states[harness.calls.states.length - 1][1];
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await step();
    equal("a running job is counted", jobsPillPresentation(last()).label, { kind: "live", count: 1 });

    index = 1;
    await step();
    check("the settled answer hides the pill", jobsPillPresentation(last()).visible, false);
    const publishedWhenSettled = harness.calls.states.length;

    index = 2;
    await step();
    equal("a stale 'running' for the settled id is not published again", harness.calls.states.length, publishedWhenSettled);
    equal("…and the popover still holds the settled row", last().jobs, answers[1].jobs);
    check("…so the pill does not reappear", jobsPillPresentation(last()).visible, false);

    index = 3;
    await step();
    equal("a new job (new id) still appears", jobsPillPresentation(last()).label, { kind: "live", count: 1 });
    equal("…with the settled row kept beside it", last().jobs, answers[3].jobs);

    // P3-1 (review): tearing the pill down drops the agent's latch, so a
    // long-lived client cannot accumulate one entry per agent it ever saw. The
    // observable proof: after removal + re-registration the same id is read from
    // the wire again instead of being quietly projected back to settled.
    harness.poller.drop("a");
    index = 2;
    harness.poller.upsert({ id: "a", workspaceId: "ws" });
    await step();
    equal(
      "after a teardown the latch is gone (the re-registration trusts the new answer)",
      jobsPillPresentation(last()).label,
      { kind: "live", count: 1 },
    );
    harness.poller.dispose();
  }

  // CJ-04 (behaviour): a terminal code removes the pill and stops the timer; a
  // transient code keeps retrying. The pair is the positive control — a
  // controller that stopped on every error would pass the first half alone.
  console.log("\npoll controller terminal errors");
  {
    const harness = createPollerHarness({
      readJobs: async () => {
        harness.calls.reads += 1;
        return { available: false, jobs: [], error: { message: "reload the plugin", code: "bridge_too_old" } };
      },
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal("a terminal error removes the pill", harness.calls.removed, [["a", "terminal", "bridge_too_old"]]);
    equal("a terminal error leaves no timer behind", harness.clock.pendingDelays(), []);
    await harness.clock.advance(60_000);
    equal("a terminal error is never retried", harness.calls.reads, 1);
    // A terminal code is not a permission refusal: an upsert for the same agent
    // must not bring the retry loop back (a plugin reload is what resets it).
    harness.poller.upsert({ id: "a", workspaceId: "ws" });
    equal("an upsert does not re-register a terminal agent", harness.calls.added, ["a"]);
    equal("an upsert does not restart a terminal agent", harness.clock.pendingDelays(), []);
    harness.poller.dispose();
  }
  {
    // The user-visible failure shape: the bridge never answers `paseo/jobs`, so
    // the server now classifies the 15 s timeout as terminal `bridge_too_old`
    // with the "did not answer" message. End-to-end at the controller boundary:
    // one removal (that single removal is the one console.error in jobs-pill),
    // no timer, and no further reads however long the clock runs — the polling
    // storm a transient classification would cause.
    const harness = createPollerHarness({
      readJobs: async () => {
        harness.calls.reads += 1;
        return {
          available: false,
          jobs: [],
          error: {
            message: "this profile's bridge did not answer paseo/jobs (it may predate jobs support or be unresponsive); reload the plugin so the embedded bridge is rewritten",
            code: "bridge_too_old",
          },
        };
      },
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal(
      "a paseo/jobs timeout removes the pill exactly once (one console line)",
      harness.calls.removed,
      [["a", "terminal", "bridge_too_old"]],
    );
    equal("…and leaves no retry timer", harness.clock.pendingDelays(), []);
    await harness.clock.advance(120_000);
    equal("…and never retries (no polling storm)", harness.calls.reads, 1);
    harness.poller.dispose();
  }
  {
    const harness = createPollerHarness({
      readJobs: async () => {
        harness.calls.reads += 1;
        return { available: false, jobs: [], error: { message: "flaky", code: "rpc_failed" } };
      },
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal("a transient error keeps the pill", harness.calls.removed, []);
    assert("a transient error keeps a retry timer", harness.clock.pendingDelays().length === 1);
    harness.poller.dispose();
  }
  {
    const refusal = Object.assign(new Error("Session is not authorized for plugin.rpc.invoke.request"), {
      code: "access_denied",
    });
    const harness = createPollerHarness({
      readJobs: async () => {
        throw refusal;
      },
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal("a permission refusal stops the pill", harness.calls.removed, [["a", "unauthorized", undefined]]);
    equal("a permission refusal leaves no timer", harness.clock.pendingDelays(), []);
    // The pill's teardown logs the refusal; the adapter must not add a second line
    // for the same event (2026-11-10, P2-1).
    equal("a permission refusal logs no extra unreadable line", harness.calls.errors, []);
    // A reconnect can widen permissions, so the agent is not terminal: a later
    // upsert must build a fresh registration and poll again. Without this half, a
    // controller that simply stopped forever would pass the assertions above.
    harness.poller.upsert({ id: "a", workspaceId: "ws" });
    equal("a later upsert re-registers the agent", harness.calls.added, ["a", "a"]);
    assert("a later upsert schedules a new poll", harness.clock.pendingDelays().length === 1);
    harness.poller.dispose();
  }

  // Two agents from one snapshot must not share a first tick: the initial delay is
  // jittered per agent by the injected random source.
  {
    const draws = [0, 0.5];
    const harness = createPollerHarness({
      random: () => draws.shift() ?? 0,
      readJobs: async () => ({ available: true, jobs: [] }),
    });
    await harness.poller.applySnapshot({
      entries: [
        { agent: { id: "a", workspaceId: "ws" } },
        { agent: { id: "b", workspaceId: "ws" } },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    const initialDelays = harness.clock.pendingDelays();
    assert(
      "two agents do not receive the same first delay",
      initialDelays.length === 2 && initialDelays[0] !== initialDelays[1],
      JSON.stringify(initialDelays),
    );
    harness.poller.dispose();
  }


  /* ---------------------------------------------------------------------------- */
  /* The jobs pill's own copy, preserved across the shared-controller refactor     */
  /* ---------------------------------------------------------------------------- */

  // The controller was extracted from this pill and is now shared with the goal
  // pill, which means its three diagnostics had to become injected strings. The
  // jobs pill's wording is what the user already sees (and what a log search for
  // "jobs pill" finds), so it must be **verbatim** what it was before the
  // refactor — a genericised sentence would be a silent copy change on a surface
  // nobody asked to change.
  console.log("\nthe jobs pill's copy survives the shared controller");
  {
    // 1. The fallback sentence a failed read carries when the runtime sent none.
    //    (Production always sends a message; this is the defensive path, pinned
    //    because it is user-visible copy all the same.)
    const harness = createPollerHarness({
      readJobs: async () => ({ available: false }),
      random: () => 0,
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal(
      "a failed read with no runtime message uses the jobs pill's fallback sentence",
      harness.calls.states[0]?.[1]?.error,
      "the DSH runtime could not list this session's jobs",
    );
    harness.poller.dispose();
  }
  {
    // 2. The poll-failure log line. Reachable when a tick rejects, i.e. when the
    //    publish itself throws (the read path is caught inside the tick).
    const harness = createPollerHarness({
      readJobs: async () => ({ available: true, jobs: [] }),
      publishState() {
        throw new Error("store exploded");
      },
      random: () => 0,
    });
    await harness.poller.applySnapshot({
      entries: [{ agent: { id: "a", workspaceId: "ws" } }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal(
      "a failed poll reports the jobs pill's own prefix",
      harness.calls.errors[0]?.[0],
      "jobs pill poll failed for a",
    );
    harness.poller.dispose();
  }
  {
    // 3. The pagination-cap log line.
    let pages = 0;
    const harness = createPollerHarness({
      listAgentPage: async () => {
        pages += 1;
        return {
          entries: [],
          pageInfo: { hasMore: true, nextCursor: `cursor-${String(pages)}` },
        };
      },
    });
    await harness.poller.applySnapshot({
      entries: [],
      pageInfo: { hasMore: true, nextCursor: "cursor-0" },
    });
    equal(
      "the pagination cap names the jobs pill",
      harness.calls.errors[0]?.[0],
      "agent directory pagination did not terminate; the jobs pill sees only the first pages",
    );
    harness.poller.dispose();
  }
}

runControllerChecks()
  .then(() => {
    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
      console.error(`${failures} FAILED`);
      process.exit(1);
    }
    console.log("OK");
  })
  .catch((error) => {
    console.error("controller checks crashed:", error);
    process.exit(1);
  });
