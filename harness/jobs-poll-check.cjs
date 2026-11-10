/**
 * Offline assertions for the jobs pill's data layer: the visibility/count rule,
 * the registry ordering, the settle latch, and the per-agent subscription
 * controller the pill drives.
 *
 * `client/jobs-pill.tsx` imports the host runtime, so plain `node` cannot load it.
 * The rules live in `client/jobs-polling.ts` and `client/agent-subscriptions.ts`,
 * which have no React or host imports; this drives the real implementations — a
 * fake host that pushes answers by hand, a fake directory page and a fake
 * projection — so the controller's publish, terminal and directory branches are
 * behaviour, not source regexes.
 *
 * **What the 0.16 port changed here (2026-11-11).** The four-second poll timer,
 * its jitter and its failure backoff moved to the server
 * (`server/pill-feed`), so those are asserted by `harness/pill-feed-check.cjs`;
 * the poll-sequence module and this file's two stale-answer scenarios were
 * deleted with the timers they guarded. What remains is the client half: one
 * subscription per agent, publish-on-change, terminal removal, the directory
 * diff and pagination, and the pill's own copy.
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

const {
  jobsPillCopy,
  jobsPillPresentation,
  isBridgeEnvironmentJobsError,
  isTerminalJobsErrorCode,
  createJobsProjection,
  jobsPillViewState,
} = require("./client/jobs-polling.js");
const { createAgentSubscriptions } = require("./client/agent-subscriptions.js");
const fs = require("node:fs");
const path = require("node:path");
const {
  orderJobs,
  splitJobs,
  settleDownJobs,
  jobsSnapshot,
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

  const withTerminal = jobsSnapshot.event.safeParse({
    available: false,
    jobs: [],
    error: { message: "old bridge", code: "bridge_too_old" },
  });
  check("the jobs snapshot answer accepts a terminal code", withTerminal.success, true);
  const withTransient = jobsSnapshot.event.safeParse({
    available: false,
    jobs: [],
    error: { message: "flaky", code: "rpc_failed" },
  });
  check("the jobs snapshot answer accepts a transient code", withTransient.success, true);
  const unknownCode = jobsSnapshot.event.safeParse({
    available: false,
    jobs: [],
    error: { message: "x", code: "not_a_code" },
  });
  check("the jobs answer rejects an unknown code", unknownCode.success, false);
  const legacy = jobsSnapshot.event.safeParse({ available: false, jobs: [], error: { message: "x" } });
  check("a code-less error from an older server stays valid", legacy.success, true);

  // `canStop` is required on every row (the jobs-stop RPC's read side). A
  // bridge that predates the stop feature sends no field at all, and the parse
  // must fail loudly rather than default it to false — a missing `canStop` on a
  // *running* row would otherwise draw no stop control on a job that can be
  // stopped, which is the silent-degradation shape this repo keeps finding.
  const stoppingRow = { id: "bash-1", kind: "bash", label: "ls", status: "running", startedAt: 1 };
  const noCanStop = jobsSnapshot.event.safeParse({ available: true, jobs: [stoppingRow] });
  check("a job row without canStop is rejected (an older bridge cannot look stoppable)", noCanStop.success, false);
  const withCanStop = jobsSnapshot.event.safeParse({
    available: true,
    jobs: [{ ...stoppingRow, canStop: true }],
  });
  check("…and one with it parses", withCanStop.success, true);

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
    "index.server serves the jobs snapshot subscription over the shared feed",
    /server\.handle\(jobsSnapshot/.test(serverEntrySource) &&
      /jobsFeed\.subscribe\(agentId/.test(serverEntrySource),
  );
  assert(
    "the jobs feed grades the terminal codes from the shared list",
    /isTerminal: \(answer\) => !answer\.available && isTerminalJobsErrorCode\(answer\.error\?\.code\)/.test(
      serverEntrySource,
    ),
  );
}

/* The controller, driven by a fake clock ----------------------------------------- */
async function runControllerChecks() {
  /**
   * The fake host: one push channel per agent, exactly what `client.subscribe`
   * gives the real pill — an answer callback, an end callback (the host closed
   * it by itself) and the abort signal this side releases with.
   */
  function createHarness(overrides = {}) {
    const calls = {
      added: [],
      updated: [],
      removed: [],
      states: [],
      errors: [],
      pages: [],
      reads: 0,
      opens: [],
      aborts: [],
    };
    /** agentId -> { onAnswer, onEnd, signal } for the live subscription. */
    const live = new Map();
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    /** Set below; `removeAgent` uses it exactly like the pill's own teardown. */
    let projection;
    const host = {
      open(agentId, onAnswer, onEnd, signal) {
        calls.opens.push(agentId);
        live.set(agentId, { onAnswer, onEnd, signal });
        signal.addEventListener("abort", () => {
          calls.aborts.push(agentId);
          live.delete(agentId);
        });
      },
      listAgentPage:
        overrides.listAgentPage ??
        (async (cursor) => {
          calls.pages.push(cursor);
          return { entries: [], pageInfo: { hasMore: false, nextCursor: null } };
        }),
      addAgent(agent) {
        calls.added.push(agent.id);
      },
      updateAgent(agent) {
        calls.updated.push(agent.id);
      },
      removeAgent(agentId, reason, error) {
        // The real jobs pill drops both per-agent maps here (`createJobsProjection`'s
        // `forget`); the latch's teardown rule is only meaningful if the fake does
        // the same.
        projection?.forget(agentId);
        calls.removed.push([agentId, reason, error === undefined ? undefined : error.code]);
      },
      publishState(agentId, state) {
        // The real pill's conversion, not a copy of it: what the store and the
        // popover see is `jobsPillViewState(state)`.
        const view = jobsPillViewState(state);
        // A scenario may need the publish itself to fail: the controller must
        // report that instead of letting it escape into the host's event
        // dispatch.
        if (overrides.publishState !== undefined) {
          overrides.publishState(agentId, view, calls);
          return;
        }
        calls.states.push([agentId, view]);
      },
      onError(message, error) {
        calls.errors.push([message, error instanceof Error ? error.message : error]);
      },
      project: overrides.project,
      isTerminalErrorCode: isTerminalJobsErrorCode,
      initialData: [],
      fallbackErrorMessage: "the DSH runtime could not list this session's jobs",
      pillLabel: "jobs pill",
    };
    if (host.project === undefined) {
      projection = createJobsProjection({ onError: host.onError });
      host.project = (agentId, answer) => projection.project(agentId, answer);
    }
    const subscriptions = createAgentSubscriptions(host);

    /**
     * The answer the server would push for one agent now.
     *
     * A `readJobs` that throws models the *server's* read throwing — which the
     * client never sees: `server/pill-feed` reports that on its side and keeps the
     * last answer. A **failed** read is an `available: false` answer, and that is
     * what the controller grades, so a throw here becomes one (`answerFor`
     * mirrors `pill-feed`'s `answerFor`). The old scenarios said "the read failed"
     * by throwing; they keep meaning exactly that.
     */
    const answerFor = async (agentId) => {
      calls.reads += 1;
      try {
        return await (overrides.readJobs ? overrides.readJobs(agentId) : { available: true, jobs: [] });
      } catch (error) {
        return { available: false, jobs: [], error: { message: error instanceof Error ? error.message : String(error) } };
      }
    };
    /** Push one answer to one agent, as the server's feed would. */
    const deliver = async (agentId) => {
      const record = live.get(agentId);
      if (record === undefined) return false;
      const answer = await answerFor(agentId);
      record.onAnswer(answer);
      await settle();
      return true;
    };
    return {
      calls,
      live,
      subscriptions,
      deliver,
      settle,
      /** Deliver one answer to every live subscription (the old "tick"). */
      async step() {
        for (const agentId of [...live.keys()]) await deliver(agentId);
      },
      /** The host closes one agent's subscription by itself. */
      close(agentId, error) {
        const record = live.get(agentId);
        if (record === undefined) return;
        record.onEnd(error);
        live.delete(agentId);
      },
      /** The old scenarios advanced a clock; the push model has nothing to time. */
      clock: {
        async advance() {
          for (const agentId of [...live.keys()]) await deliver(agentId);
        },
      },
    };
  }

  const snapshot = (ids) => ({
    entries: ids.map((id) => ({ agent: { id, workspaceId: "ws" } })),
    pageInfo: { hasMore: false, nextCursor: null },
  });

  // CJ-03: the subscription snapshot is one page (the daemon caps it at 200
  // entries). The controller must walk pageInfo.nextCursor, or agents after the
  // first page never get a pill until an unrelated agent_update happens to name
  // them.
  console.log("\nagent-directory snapshot pagination");
  {
    const pages = [];
    const harness = createHarness({
      listAgentPage: async (cursor) => {
        pages.push(cursor);
        return {
          entries: [{ agent: { id: "agent-2", workspaceId: "ws" } }],
          pageInfo: { hasMore: false, nextCursor: null },
        };
      },
    });
    await harness.subscriptions.applySnapshot({
      entries: [{ agent: { id: "agent-1", workspaceId: "ws" } }],
      pageInfo: { hasMore: true, nextCursor: "cursor-1" },
    });
    equal("both pages are registered", harness.calls.added, ["agent-1", "agent-2"]);
    equal("the second page is fetched with the snapshot's cursor", pages, ["cursor-1"]);
    equal("a terminating directory raises no pagination error", harness.calls.errors, []);
    equal("every registered agent gets a subscription", harness.calls.opens, ["agent-1", "agent-2"]);
    harness.subscriptions.dispose();

    // The reverse control: a one-page snapshot must not fetch a page at all. A
    // controller that always paginates would pass the first half alone.
    const single = createHarness();
    await single.subscriptions.applySnapshot(snapshot(["only"]));
    equal("a one-page snapshot makes no extra request", single.calls.pages, []);
    single.subscriptions.dispose();
  }

  // A reconnect can deliver a fresh snapshot while an older snapshot's next page
  // is still in flight. The stale page must not resurrect its agents.
  {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      listAgentPage: async () => {
        await gate;
        return {
          entries: [{ agent: { id: "stale-agent", workspaceId: "ws" } }],
          pageInfo: { hasMore: false, nextCursor: null },
        };
      },
    });
    const first = harness.subscriptions.applySnapshot({
      entries: [{ agent: { id: "fresh-1", workspaceId: "ws" } }],
      pageInfo: { hasMore: true, nextCursor: "cursor-1" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.subscriptions.applySnapshot(snapshot(["fresh-2"]));
    release();
    await first;
    assert("the stale page is discarded after a newer snapshot", !harness.calls.added.includes("stale-agent"));
    equal("only the newest snapshot's agents are registered", harness.calls.added.filter((id) => id !== "fresh-1"), ["fresh-2"]);
    harness.subscriptions.dispose();
  }

  // One subscription per agent, opened when the pill is registered and released
  // with it. The pill used to start a timer per agent; the push model must not
  // open a second stream for the same agent, and must close the one it has when
  // the agent leaves.
  console.log("\none subscription per agent");
  {
    const harness = createHarness();
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    equal("registering an agent opens its subscription", harness.calls.opens, ["a"]);
    await harness.step();
    equal("the first pushed answer publishes", harness.calls.states.length, 1);
    check("…and it is a readable answer", harness.calls.states[0][1].available, true);

    harness.subscriptions.upsert({ id: "a", workspaceId: "ws", status: "running" });
    equal("an agent update does not reopen the subscription", harness.calls.opens, ["a"]);
    equal("…and is handed to the pill (its metadata channel)", harness.calls.updated, ["a"]);

    harness.subscriptions.drop("a");
    equal("a removed agent releases its subscription", harness.calls.aborts, ["a"]);
    assert("…and nothing is left listening", !harness.live.has("a"));
    const before = harness.calls.reads;
    await harness.step();
    equal("a released agent is never pushed again", harness.calls.reads, before);
    harness.subscriptions.dispose();
  }

  // A late answer for a released entry must not publish: the pill (and its store
  // row) is gone, and the host would otherwise show a row for an agent that has
  // no registration left.
  {
    const harness = createHarness();
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    const record = harness.live.get("a");
    harness.subscriptions.drop("a");
    const published = harness.calls.states.length;
    record.onAnswer({ available: true, jobs: [] });
    await harness.settle();
    equal("an answer after the release publishes nothing", harness.calls.states.length, published);
    harness.subscriptions.dispose();
  }

  // CJ-01 (behaviour): an answer that repeats must not publish. Publishing is
  // what rebuilds the popover's store row (waking its listeners) and calls
  // `registration.update()`, which the host republishes unconditionally — and
  // under live-only visibility "nothing running" is the normal answer, so the
  // idle session was repainting the composer and any open popover on every push.
  console.log("\npublish dedup");
  {
    // A readable answer that repeats publishes once; a changed one still goes
    // through.
    let answer = { available: true, jobs: [] };
    const harness = createHarness({ readJobs: async () => answer });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    equal("the first readable answer publishes", harness.calls.states.length, 1);
    await harness.clock.advance();
    await harness.clock.advance();
    equal("two identical answers do not publish again", harness.calls.states.length, 1);
    answer = { available: true, jobs: [{ status: "running" }] };
    await harness.clock.advance();
    equal("a job appearing publishes", harness.calls.states.length, 2);
    equal("…with the live answer", harness.calls.states[1][1].jobs.length, 1);
    harness.subscriptions.dispose();
  }
  {
    // The same failure repeated is also the same answer: it must publish once.
    // (The backoff it used to grow here now lives in `server/pill-feed`, and
    // `harness/pill-feed-check.cjs` asserts it.)
    let message = "registry exploded";
    const harness = createHarness({
      readJobs: async () => {
        throw new Error(message);
      },
    });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    equal("a failure publishes once", harness.calls.states.length, 1);
    await harness.clock.advance();
    equal("the same failure repeated does not publish again", harness.calls.states.length, 1);
    message = "registry exploded differently";
    await harness.clock.advance();
    equal("a different failure message publishes", harness.calls.states.length, 2);
    harness.subscriptions.dispose();
  }
  {
    // Recovery is a change even when the job list is empty: the unavailable
    // answer must not stick.
    let fail = true;
    const harness = createHarness({
      readJobs: async () => {
        if (fail) throw new Error("registry exploded");
        return { available: true, jobs: [] };
      },
    });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    equal("a failure publishes once", harness.calls.states.length, 1);
    fail = false;
    await harness.clock.advance();
    equal("recovery publishes even with no jobs", harness.calls.states.length, 2);
    check("…and the published answer is readable again", harness.calls.states[1][1].available, true);
    harness.subscriptions.dispose();
  }
  {
    // The guard is per agent: two agents with identical answers each publish
    // their own first answer, and then neither publishes again.
    const harness = createHarness();
    await harness.subscriptions.applySnapshot(snapshot(["a", "b"]));
    await harness.clock.advance();
    equal("each agent's first answer publishes", harness.calls.states.map(([agentId]) => agentId).sort(), ["a", "b"]);
    await harness.clock.advance();
    equal("…and identical answers publish nothing more", harness.calls.states.length, 2);
    harness.subscriptions.dispose();
  }
  {
    // A re-registration is a new pill: its store row was dropped, so its first
    // answer must publish even if it is identical to the one before the drop.
    const harness = createHarness();
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    equal("a fresh registration publishes its first answer", harness.calls.states.length, 1);
    harness.subscriptions.drop("a");
    harness.subscriptions.upsert({ id: "a", workspaceId: "ws" });
    await harness.clock.advance();
    equal("a re-registration publishes again", harness.calls.states.length, 2);
    harness.subscriptions.dispose();
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
    const harness = createHarness({
      readJobs: async () => {
        if (fail) throw new Error("Stream end encountered");
        return answer;
      },
    });
    const last = () => harness.calls.states[harness.calls.states.length - 1][1];
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.step();
    check("the first readable empty answer hides the pill", jobsPillPresentation(last()).visible, false);

    fail = true;
    await harness.step();
    equal("the failed read is published (the popover can say so)", last().available, false);
    equal("…carrying the last known rows, not a fabricated list", last().jobs, []);
    check("…and does not make the pill appear", jobsPillPresentation(last()).visible, false);

    // Path B: with a real job running, the same failure keeps the pill and its
    // count — the job is running whether or not the registry answers this read.
    fail = false;
    answer = { available: true, jobs: [{ id: "bash-1", status: "running", startedAt: 1 }] };
    await harness.step();
    check("a running job shows the pill", jobsPillPresentation(last()).visible, true);
    fail = true;
    await harness.step();
    equal("the failure carries the running job", last().jobs, answer.jobs);
    check("…so the pill stays visible", jobsPillPresentation(last()).visible, true);
    equal("…and keeps the real count", jobsPillPresentation(last()).label, { kind: "live", count: 1 });

    // Recovery with the job settled: the pill hides, and the next failure does
    // not bring it back.
    fail = false;
    answer = { available: true, jobs: [{ id: "bash-1", status: "completed", startedAt: 1, finishedAt: 2 }] };
    await harness.step();
    check("the settled answer hides the pill", jobsPillPresentation(last()).visible, false);
    fail = true;
    await harness.step();
    check("a later failure does not bring the settled-only pill back", jobsPillPresentation(last()).visible, false);
    harness.subscriptions.dispose();
  }

  // Review P2-1 (2026-11-10): with the pill no longer carrying a failed read,
  // the console line is the only thing that keeps "could not read" loud instead
  // of looking like "nothing is running". Exactly one line per entry into the
  // failed state (not per answer), one on recovery, and none for a terminal code
  // — the pill's removal already logs exactly one line there.
  console.log("\nthe failed-read console line");
  {
    let mode = "ok";
    const harness = createHarness({
      readJobs: async () => {
        if (mode === "throw") throw new Error("Stream end encountered");
        if (mode === "unreadable") {
          return { available: false, jobs: [], error: { message: "registry exploded", code: "rpc_failed" } };
        }
        if (mode === "terminal") {
          return { available: false, jobs: [], error: { message: "reload the plugin", code: "bridge_too_old" } };
        }
        return { available: true, jobs: [] };
      },
    });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.step();
    equal("a readable answer logs nothing", harness.calls.errors, []);

    mode = "throw";
    await harness.step();
    equal("entering the failed state logs exactly once", harness.calls.errors.length, 1);
    equal(
      "…with the pill's console sentence and the agent id",
      harness.calls.errors[0][0],
      "jobs pill: could not read this session's jobs for a; keeping the last known answer until a read succeeds",
    );
    equal("…and the underlying message", harness.calls.errors[0][1], "Stream end encountered");

    await harness.step();
    equal("a repeated failure does not log again", harness.calls.errors.length, 1);
    mode = "unreadable";
    await harness.step();
    equal("a different failure shape in the same state does not log again", harness.calls.errors.length, 1);

    mode = "ok";
    await harness.step();
    equal("recovery logs one line", harness.calls.errors.length, 2);
    equal(
      "…naming the recovery",
      harness.calls.errors[1][0],
      "jobs pill: this session's jobs are readable again for a",
    );
    equal('…with no error detail (the sink must not print "undefined")', harness.calls.errors[1][1], undefined);

    mode = "terminal";
    await harness.step();
    equal("a terminal code adds no unreadable line (removal logs its own)", harness.calls.errors.length, 2);
    equal("…and removes the pill once", harness.calls.removed.map(([id, reason]) => [id, reason]), [["a", "terminal"]]);
    harness.subscriptions.dispose();
  }

  // Path B "job 结算后": **a defensive guard, not a diagnosed regression** — the
  // fixture (a settled id reported running) is a shape DSH does not produce, and
  // the transport only pushes changed snapshots. The latch covers the paths those
  // guards cannot see; the assertion pins the intended monotonicity: the stale
  // answer is projected back to the settled row, so it is identical to the
  // previous one and the controller does not even publish (no repaint, no pill).
  // A genuinely new job is a new id and still appears in the same answer.
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
    const harness = createHarness({
      readJobs: async () => answers[Math.min(index, answers.length - 1)],
    });
    const last = () => harness.calls.states[harness.calls.states.length - 1][1];
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.step();
    equal("a running job is counted", jobsPillPresentation(last()).label, { kind: "live", count: 1 });

    index = 1;
    await harness.step();
    check("the settled answer hides the pill", jobsPillPresentation(last()).visible, false);
    const publishedWhenSettled = harness.calls.states.length;

    index = 2;
    await harness.step();
    equal("a stale 'running' for the settled id is not published again", harness.calls.states.length, publishedWhenSettled);
    equal("…and the popover still holds the settled row", last().jobs, answers[1].jobs);
    check("…so the pill does not reappear", jobsPillPresentation(last()).visible, false);

    index = 3;
    await harness.step();
    equal("a new job (new id) still appears", jobsPillPresentation(last()).label, { kind: "live", count: 1 });
    equal("…with the settled row kept beside it", last().jobs, answers[3].jobs);

    // P3-1 (review): tearing the pill down drops the agent's latch, so a
    // long-lived client cannot accumulate one entry per agent it ever saw. The
    // observable proof: after removal + re-registration the same id is read from
    // the wire again instead of being quietly projected back to settled.
    harness.subscriptions.drop("a");
    index = 2;
    harness.subscriptions.upsert({ id: "a", workspaceId: "ws" });
    await harness.step();
    equal(
      "after a teardown the latch is gone (the re-registration trusts the new answer)",
      jobsPillPresentation(last()).label,
      { kind: "live", count: 1 },
    );
    harness.subscriptions.dispose();
  }

  // CJ-04 (behaviour): a terminal code removes the pill and releases the stream;
  // a transient code keeps it. The pair is the positive control — a controller
  // that stopped on every error would pass the first half alone.
  console.log("\nterminal errors");
  {
    const harness = createHarness({
      readJobs: async () => ({ available: false, jobs: [], error: { message: "reload the plugin", code: "bridge_too_old" } }),
    });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    equal("a terminal error removes the pill", harness.calls.removed, [["a", "terminal", "bridge_too_old"]]);
    equal("a terminal error releases the subscription", harness.calls.aborts, ["a"]);
    await harness.clock.advance();
    equal("a terminal error is never re-read", harness.calls.reads, 1);
    // A terminal code is not a permission refusal: an upsert for the same agent
    // must not bring the stream back (a snapshot is what revives it).
    harness.subscriptions.upsert({ id: "a", workspaceId: "ws" });
    equal("an upsert does not re-register a terminal agent", harness.calls.added, ["a"]);
    equal("an upsert does not reopen a terminal agent's subscription", harness.calls.opens, ["a"]);
    harness.subscriptions.dispose();
  }
  {
    // The terminal entry stays flagged, and only a **new directory snapshot** —
    // the host re-describing the world after a reconnect, when a plugin reload
    // may have rewritten the bridge — rebuilds the pill.
    const harness = createHarness({
      readJobs: async () => ({ available: false, jobs: [], error: { message: "reload the plugin", code: "bridge_too_old" } }),
    });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    equal("the terminal pill is removed", harness.calls.removed.length, 1);
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    equal("a fresh snapshot rebuilds the pill", harness.calls.added, ["a", "a"]);
    equal("…and opens a new subscription", harness.calls.opens, ["a", "a"]);
    harness.subscriptions.dispose();
  }
  {
    // The user-visible failure shape: the bridge never answers `paseo/jobs`, so
    // the server classifies the timeout as terminal `bridge_too_old` with the
    // "did not answer" message. End-to-end at the controller boundary: one
    // removal (that single removal is the one console.error in jobs-pill), and no
    // further reads however long the host pushes — the read storm a transient
    // classification would cause.
    const harness = createHarness({
      readJobs: async () => ({
        available: false,
        jobs: [],
        error: {
          message:
            "this profile's bridge did not answer paseo/jobs (it may predate jobs support or be unresponsive); reload the plugin so the embedded bridge is rewritten",
          code: "bridge_too_old",
        },
      }),
    });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    equal(
      "a paseo/jobs timeout removes the pill exactly once (one console line)",
      harness.calls.removed,
      [["a", "terminal", "bridge_too_old"]],
    );
    equal("…and releases the stream", harness.calls.aborts, ["a"]);
    await harness.clock.advance();
    equal("…and never reads again (no polling storm)", harness.calls.reads, 1);
    harness.subscriptions.dispose();
  }
  {
    const harness = createHarness({
      readJobs: async () => ({ available: false, jobs: [], error: { message: "flaky", code: "rpc_failed" } }),
    });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    equal("a transient error keeps the pill", harness.calls.removed, []);
    equal("a transient error keeps the subscription", harness.calls.aborts, []);
    await harness.clock.advance();
    equal("…and is still watched for the next answer", harness.calls.reads, 2);
    harness.subscriptions.dispose();
  }
  {
    // The host closes the subscription by itself (daemon restart, plugin stop):
    // one console line and the pill's failed-read behaviour, with no client-side
    // retry timer — Paseo re-subscribes on its own reconnect, and a fresh
    // directory snapshot is the other recovery edge.
    const harness = createHarness();
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    const published = harness.calls.states.length;
    harness.close("a", new Error("stream ended"));
    equal("a host close logs one line", harness.calls.errors.length, 1);
    equal(
      "…naming the pill and the agent",
      harness.calls.errors[0][0],
      "jobs pill: the subscription for a ended; keeping the last known answer until the host re-subscribes",
    );
    equal("…and publishes the failed state", harness.calls.states.length, published + 1);
    equal("…which is what the pill renders", harness.calls.states[published][1].available, false);
    equal("…and the pill is not removed", harness.calls.removed, []);
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    equal("a fresh snapshot reopens the subscription", harness.calls.opens, ["a", "a"]);
    harness.subscriptions.dispose();
  }
  {
    // A refused subscription (`plugin.subscription.subscribe` needs a permission
    // this connection lacks) rejects `ready`, which reaches this controller as a
    // host close with that error: the pill goes, like the old RPC's permission
    // refusal, and logs no extra "unreadable" line (the pill's own removal logs
    // the refusal once).
    const refusal = Object.assign(new Error("Session is not authorized for plugin.subscription.subscribe.request"), {
      code: "access_denied",
    });
    const harness = createHarness({
      // The refusal arrives before any answer: open then immediately close.
      listAgentPage: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
    });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    harness.close("a", refusal);
    equal("a permission refusal stops the pill", harness.calls.removed, [["a", "unauthorized", undefined]]);
    equal("a permission refusal logs no extra unreadable line", harness.calls.errors, []);
    // A reconnect can widen permissions, so the agent is not terminal: a later
    // upsert must build a fresh registration and subscribe again. Without this
    // half, a controller that simply stopped forever would pass the assertions
    // above.
    harness.subscriptions.upsert({ id: "a", workspaceId: "ws" });
    equal("a later upsert re-registers the agent", harness.calls.added, ["a", "a"]);
    equal("…and subscribes again", harness.calls.opens, ["a", "a"]);
    harness.subscriptions.dispose();
  }
  {
    // A projection that throws is dropped with one line, and the next answer still
    // reaches the pill: a broken answer must not take the stream with it.
    let explode = true;
    const harness = createHarness({
      project: (agentId, answer) => {
        if (explode) throw new Error("projection exploded");
        return { available: answer.available, data: answer.jobs };
      },
    });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    equal("a throwing projection is reported", harness.calls.errors[0]?.[0], "jobs pill could not read one answer for a");
    equal("…with no publish", harness.calls.states.length, 0);
    explode = false;
    await harness.clock.advance();
    equal("…and the stream keeps delivering", harness.calls.states.length, 1);
    harness.subscriptions.dispose();
  }

  /* ---------------------------------------------------------------------------- */
  /* The jobs pill's own copy, preserved across the shared-controller refactor     */
  /* ---------------------------------------------------------------------------- */

  // The controller is shared with the goal and team pills, which means its
  // diagnostics had to become injected strings. The jobs pill's wording is what
  // the user already sees (and what a log search for "jobs pill" finds), so it
  // must be **verbatim**: a genericised sentence would be a silent copy change on
  // a surface nobody asked to change.
  console.log("\nthe jobs pill's copy survives the shared controller");
  {
    // 1. The fallback sentence a failed read carries when the runtime sent none.
    //    (Production always sends a message; this is the defensive path, pinned
    //    because it is user-visible copy all the same.)
    const harness = createHarness({
      // `available: false` with no error object at all — the one shape where the
      // controller must fall back to the injected sentence.
      readJobs: async () => ({ available: false, jobs: [] }),
    });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    equal(
      "a failed read with no runtime message uses the jobs pill's fallback sentence",
      harness.calls.states[0]?.[1]?.error,
      "the DSH runtime could not list this session's jobs",
    );
    harness.subscriptions.dispose();
  }
  {
    // 2. The publish-failure log line. A host store that throws must not escape
    //    into the subscription's dispatch (that would look like a transport
    //    failure and could kill the stream), so the controller reports it.
    const harness = createHarness({
      publishState() {
        throw new Error("store exploded");
      },
    });
    await harness.subscriptions.applySnapshot(snapshot(["a"]));
    await harness.clock.advance();
    equal(
      "a failed publish reports the jobs pill's own prefix",
      harness.calls.errors[0]?.[0],
      "jobs pill could not publish one answer for a",
    );
    equal("…with the host's message", harness.calls.errors[0]?.[1], "store exploded");
    harness.subscriptions.dispose();
  }
  {
    // 3. The pagination-cap log line.
    let pages = 0;
    const harness = createHarness({
      listAgentPage: async () => {
        pages += 1;
        return {
          entries: [],
          pageInfo: { hasMore: true, nextCursor: `cursor-${String(pages)}` },
        };
      },
    });
    await harness.subscriptions.applySnapshot({
      entries: [],
      pageInfo: { hasMore: true, nextCursor: "cursor-0" },
    });
    equal(
      "the pagination cap names the jobs pill",
      harness.calls.errors[0]?.[0],
      "agent directory pagination did not terminate; the jobs pill sees only the first pages",
    );
    harness.subscriptions.dispose();
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
