/**
 * Offline assertions for the poll sequence — the guard that decides which answer
 * may publish.
 *
 * `client/jobs-pill.tsx` imports the host runtime, so plain `node` cannot load it.
 * The rule lives in `client/poll-sequence.ts`, which has no imports at all; this
 * drives the real implementation.
 *
 * The two scenarios are the bugs review found in the first version:
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
 *   npx tsc client/poll-sequence.ts \
 *     --outDir .dbg-poll --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg-poll/package.json
 *   cp ../harness/jobs-poll-check.cjs .dbg-poll/
 *   cd .dbg-poll && node jobs-poll-check.cjs
 */

"use strict";

const { createPollSequence } = require("./client/poll-sequence.js");
const { orderJobs, splitJobs } = require("./shared/jobs.js");

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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log("OK");
