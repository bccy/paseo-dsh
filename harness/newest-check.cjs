/**
 * Offline assertions for "which row is the newest, and should it pulse".
 *
 * This decides the pulse for a *finished* row, which is the only way a short
 * command — `tool/call` and `tool/result` in the same tick — ever pulses at
 * all. Getting it wrong is silent in two directions: no pulse (the bug the user
 * reported) or every historical row pulsing (the bug before that). So the
 * checks live at the data layer, not in the UI.
 *
 * Run (from paseo-plugin):
 *   npx tsc client/newest.ts \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/newest-check.cjs .dbg/
 *   cd .dbg && node newest-check.cjs
 */
"use strict";

const { isFresh, isNewest, NEWEST_PULSE_MS } = require("./client/newest.js");

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const base = Date.UTC(2026, 0, 1, 0, 0, 0);

console.log("newest row");
{
  check("the first row seen is the newest", isNewest("a", new Date(base)) === true);
  check(
    "an older row is not the newest",
    isNewest("a", new Date(base - 1000)) === false,
  );
  check("a newer row takes over", isNewest("a", new Date(base + 1000)) === true);
  check(
    "the row that lost the position is not newest any more",
    isNewest("a", new Date(base)) === false,
  );
  check(
    "an older row cannot take the position back",
    isNewest("a", new Date(base - 5000)) === false && isNewest("a", new Date(base + 1000)) === true,
  );
}

console.log("per agent");
{
  // Sessions are independent: a quiet agent must not be demoted by another one.
  check("another agent starts its own position", isNewest("b", new Date(base - 9000)) === true);
  check("the first agent keeps its own newest", isNewest("a", new Date(base + 1000)) === true);
}

console.log("freshness window");
{
  const at = new Date(base);
  check("a just-appeared row is fresh", isFresh(at, base + 10) === true);
  check(
    "a row inside the window is fresh",
    isFresh(at, base + NEWEST_PULSE_MS - 1) === true,
  );
  check(
    "a row past the window is not fresh",
    isFresh(at, base + NEWEST_PULSE_MS) === false,
  );
  check(
    "a replayed history row is not fresh",
    isFresh(at, base + 60 * 60 * 1000) === false,
  );
  check("a string timestamp is understood", isFresh(new Date(base).toISOString(), base + 10) === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
