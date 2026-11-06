/**
 * Offline assertions for the composer pill deference coordinator.
 *
 * The rule is plain TypeScript in `client/pill-deference.ts` (no React, no host
 * runtime), so this drives the real implementation:
 *
 *   - the initial state is goal=false / team=false, so nothing is blocked;
 *   - `blocksJobs` is true **only** while both the goal and the team pill are
 *     visible — all four goal/team combinations;
 *   - `report` notifies only on a real change (a repeated report is silent),
 *     and `forget` clears one side and notifies only when it had been true;
 *   - state is isolated per agent;
 *   - subscribers can unsubscribe, and `dispose` releases every state/listener
 *     and makes the coordinator inert.
 *
 * Run (from paseo-plugin):
 *   npx tsc -p ../harness/pill-deference.tsconfig.json
 *   echo '{"type":"commonjs"}' > .dbg-deference/package.json
 *   cp ../harness/pill-deference-check.cjs .dbg-deference/
 *   cd .dbg-deference && node pill-deference-check.cjs
 */
"use strict";

const { createPillDeference } = require("./client/pill-deference.js");

let failures = 0;
let checks = 0;
function check(what, actual, expected) {
  checks += 1;
  if (Object.is(actual, expected)) return;
  failures += 1;
  console.error(`  FAIL ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assert(what, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${what}${detail === undefined ? "" : `: ${detail}`}`);
}

/** Subscribe and count the notifications for one agent. */
function watch(deference, agentId) {
  const calls = { count: 0 };
  const unsubscribe = deference.subscribe(agentId, () => {
    calls.count += 1;
  });
  return { calls, unsubscribe };
}

console.log("\nthe initial state is not blocked");
{
  const deference = createPillDeference();
  check("a fresh coordinator does not block jobs", deference.blocksJobs("a1"), false);
  const { calls } = watch(deference, "a1");
  check("…and reports nothing before either pill speaks", calls.count, 0);
  deference.report("goal", "a1", false);
  deference.report("team", "a1", false);
  check("reporting the initial false values stays silent", calls.count, 0);
  check("…and the state is still not blocked", deference.blocksJobs("a1"), false);
  deference.dispose();
}

console.log("\nall four goal/team combinations");
{
  const deference = createPillDeference();
  const { calls } = watch(deference, "a1");
  deference.report("goal", "a1", true);
  check("goal only: not blocked", deference.blocksJobs("a1"), false);
  check("…the goal change notified once", calls.count, 1);
  deference.report("team", "a1", true);
  check("goal + team: blocked", deference.blocksJobs("a1"), true);
  check("…the team change notified once more", calls.count, 2);
  deference.report("goal", "a1", false);
  check("team only: not blocked", deference.blocksJobs("a1"), false);
  check("…the goal change notified once more", calls.count, 3);
  deference.report("team", "a1", false);
  check("neither: not blocked", deference.blocksJobs("a1"), false);
  check("…the team change notified once more", calls.count, 4);
  deference.dispose();
}

console.log("\nrepeated reports are deduped");
{
  const deference = createPillDeference();
  const { calls } = watch(deference, "a1");
  deference.report("goal", "a1", true);
  deference.report("goal", "a1", true);
  deference.report("goal", "a1", true);
  check("three identical goal reports notify once", calls.count, 1);
  deference.report("team", "a1", true);
  deference.report("team", "a1", true);
  check("two identical team reports notify once", calls.count, 2);
  check("…and the block is on", deference.blocksJobs("a1"), true);
  deference.dispose();
}

console.log("\nforget clears one side and notifies only when it was set");
{
  const deference = createPillDeference();
  const { calls } = watch(deference, "a1");
  deference.report("goal", "a1", true);
  deference.report("team", "a1", true);
  check("both visible first", deference.blocksJobs("a1"), true);
  check("…with two notifications", calls.count, 2);
  deference.forget("goal", "a1");
  check("forgetting the goal unblocks jobs", deference.blocksJobs("a1"), false);
  check("…and notifies once", calls.count, 3);
  deference.forget("goal", "a1");
  check("forgetting it again does nothing", calls.count, 3);
  deference.forget("team", "a1");
  check("forgetting the still-visible team notifies once", calls.count, 4);
  deference.forget("team", "a1");
  check("forgetting the team again does nothing", calls.count, 4);
  deference.report("goal", "a1", true);
  check("the forgotten side can be reported again", deference.blocksJobs("a1"), false);
  check("…and that report notified", calls.count, 5);
  deference.dispose();
}

console.log("\nagents are isolated");
{
  const deference = createPillDeference();
  const a1 = watch(deference, "a1");
  const a2 = watch(deference, "a2");
  deference.report("goal", "a1", true);
  deference.report("team", "a1", true);
  deference.report("goal", "a2", true);
  check("a1 is blocked", deference.blocksJobs("a1"), true);
  check("a2 is not blocked with the goal alone", deference.blocksJobs("a2"), false);
  check("a1's listener saw a1's two changes", a1.calls.count, 2);
  check("a2's listener saw only a2's goal change", a2.calls.count, 1);
  deference.forget("team", "a1");
  check("forgetting a1 leaves a2 untouched", deference.blocksJobs("a2"), false);
  check("…and a2's listener was not woken", a2.calls.count, 1);
  assert("an unknown agent is not blocked", !deference.blocksJobs("a3"));
  deference.dispose();
}

console.log("\na false report does not create state");
{
  const deference = createPillDeference();
  const { calls } = watch(deference, "a1");
  deference.report("goal", "a1", false);
  deference.report("team", "a1", false);
  check("false reports on a fresh agent stay silent", calls.count, 0);
  deference.forget("goal", "a1");
  deference.forget("team", "a1");
  check("forgetting the still-false sides stays silent", calls.count, 0);
  check("…and leaves the agent unblocked", deference.blocksJobs("a1"), false);
  deference.report("goal", "a1", true);
  check("the first real report still creates the state", deference.blocksJobs("a1"), false);
  check("…and notifies once", calls.count, 1);
  deference.dispose();
}

console.log("\na throwing listener is logged, and the others still run");
{
  const deference = createPillDeference();
  const original = console.error;
  const logged = [];
  console.error = (message) => {
    logged.push(String(message));
  };
  try {
    const before = watch(deference, "a1");
    deference.subscribe("a1", () => {
      throw new Error("boom");
    });
    const after = watch(deference, "a1");
    deference.report("goal", "a1", true);
    check("the listener before the throwing one still ran", before.calls.count, 1);
    check("…the listener after it also ran", after.calls.count, 1);
    check("the failure was logged once", logged.length, 1);
    assert(
      "…with the module prefix and the error message",
      (logged[0] ?? "").includes("[dsh-paseo] pill deference listener failed") && (logged[0] ?? "").includes("boom"),
    );
  } finally {
    console.error = original;
  }
  deference.dispose();
}

console.log("\nunsubscribe and dispose release the coordinator");
{
  const deference = createPillDeference();
  const first = watch(deference, "a1");
  const second = watch(deference, "a1");
  first.unsubscribe();
  deference.report("goal", "a1", true);
  check("an unsubscribed listener is not called", first.calls.count, 0);
  check("…the remaining listener is", second.calls.count, 1);
  deference.report("team", "a1", true);
  check("the block is still on", deference.blocksJobs("a1"), true);
  deference.dispose();
  check("dispose clears the block", deference.blocksJobs("a1"), false);
  deference.report("goal", "a1", true);
  deference.report("team", "a1", true);
  check("reports after dispose are inert", deference.blocksJobs("a1"), false);
  check("…and no listener is woken after dispose", second.calls.count, 2);
  const late = watch(deference, "a1");
  check("subscribing after dispose returns a usable no-op", typeof late.unsubscribe, "function");
  late.unsubscribe();
  deference.dispose();
  const afterSecondDispose = watch(deference, "a1");
  deference.report("goal", "a1", true);
  check("a second dispose still leaves the coordinator inert", deference.blocksJobs("a1"), false);
  check("…and its late subscription is never woken", afterSecondDispose.calls.count, 0);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log("OK");
process.exit(0);
