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
 * 1. `removeAll` → `register`: the per-agent map was cleared, so the next poll
 *    took the same number again and a stale answer passed the "is it newest" test.
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
  jobsPillPresentation,
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

/* Scenario 1: removeAll() then register() — the snapshot path ----------------- */

// registered → poll in flight → snapshot arrives → removeAll() → register() → new
// poll → the old answer arrives. It must not publish.
console.log("\nscenario 1: removeAll() then register()");

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
// with `removeAll` clearing the map and `remove` doing nothing.
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
// label is the live count, never an idle total. The static mark is reserved for
// the one state baseline 2f71225 kept visible with it: an unreadable registry.
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
  check("an unreadable registry stays visible", unreadable.visible, true);
  // Baseline 2f71225 draws the static mark for `available: false`; that one
  // exception is kept. A turning ring there would claim progress that is not
  // happening, so the baseline mark is the correct one.
  check("an unreadable registry keeps the baseline static mark", unreadable.icon, "static");
  equal("an unreadable registry has the neutral title", unreadable.label, { kind: "title" });

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

  // The old route-1 rule, as an oracle: it kept the settled-only pill visible,
  // which is exactly the regression this block exists to catch.
  const oldVisible = (jobs) => jobs.length > 0;
  assert(
    "OLD: history-visible keeps a settled-only pill visible, unlike route 2",
    oldVisible([{ status: "completed" }]) !== settledOnly.visible,
  );
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
