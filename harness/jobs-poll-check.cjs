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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log("OK");
