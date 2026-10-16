/**
 * Offline assertions for the native sweep's geometry.
 *
 * DSH's shimmer is a CSS mask; React Native has none, so the mask is rebuilt
 * from slices whose alphas sample DSH's own gradient profile, and the window
 * travels on DSH's own clock. Those numbers are the whole "same effect" claim,
 * so they are asserted here rather than eyeballed on a device — a stepped edge
 * that is too coarse, or a travel that ends early, still looks like "something
 * shimmers" while no longer matching DSH.
 *
 * Run (from paseo-plugin):
 *   npx tsc client/sweep-geometry.ts \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/sweep-check.cjs .dbg/
 *   cd .dbg && node sweep-check.cjs
 */
"use strict";

const {
  SWEEP_BANDS,
  SWEEP_CYCLE_MS,
  SWEEP_DELAY_MS,
  SWEEP_STEPS,
  SWEEP_TRAVEL_FRACTION,
  bandAlpha,
  bandLeft,
  bandWidth,
  quantize,
  sweepOffset,
  sweepProfile,
} = require("./client/sweep-geometry.js");

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition === true) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label} — ${detail === undefined ? String(condition) : detail}`);
  }
}

const near = (a, b, epsilon = 1e-6) => Math.abs(a - b) < epsilon;

console.log("the mask profile matches DSH's stops");
{
  // DSH: `linear-gradient(105deg, transparent 0%, black 40% 60%, transparent 100%)`.
  check("transparent at the leading edge", sweepProfile(0) === 0);
  check("fully opaque at 40%", near(sweepProfile(0.4), 1));
  check("still opaque at 50%", near(sweepProfile(0.5), 1));
  check("still opaque at 60%", near(sweepProfile(0.6), 1));
  check("transparent at the trailing edge", sweepProfile(1) === 0);
  check("half way up the leading ramp", near(sweepProfile(0.2), 0.5));
  check("half way down the trailing ramp", near(sweepProfile(0.8), 0.5));
  check("clamped outside 0..1", sweepProfile(-3) === 0 && sweepProfile(9) === 0);
}

console.log("the slice staircase");
{
  check("enough slices to read as a ramp, not a bar", SWEEP_BANDS >= 6);
  check("the first slice is the faintest", bandAlpha(0) < bandAlpha(1));
  check("the middle slices are opaque", near(bandAlpha(Math.floor(SWEEP_BANDS / 2)), 1));
  check(
    "the profile is symmetric",
    near(bandAlpha(0), bandAlpha(SWEEP_BANDS - 1)) &&
      near(bandAlpha(1), bandAlpha(SWEEP_BANDS - 2)),
  );
  check(
    "the slices tile the window",
    near(bandLeft(0), 0) &&
      near(bandLeft(SWEEP_BANDS - 1) + bandWidth(), 1) &&
      near(bandWidth() * SWEEP_BANDS, 1),
  );
}

console.log("the window travels on DSH's clock");
{
  check("it starts a full width to the left", near(sweepOffset(0), -1));
  check(
    "it reaches the right edge at two thirds",
    near(sweepOffset(SWEEP_CYCLE_MS * SWEEP_TRAVEL_FRACTION), 1),
  );
  check("and holds there for the rest of the cycle", near(sweepOffset(SWEEP_CYCLE_MS * 0.9), 1));
  check("the cycle repeats", near(sweepOffset(SWEEP_CYCLE_MS), -1));
  let monotonic = true;
  for (let i = 1; i <= 32; i += 1) {
    const a = sweepOffset((SWEEP_CYCLE_MS * SWEEP_TRAVEL_FRACTION * (i - 1)) / 32);
    const b = sweepOffset((SWEEP_CYCLE_MS * SWEEP_TRAVEL_FRACTION * i) / 32);
    if (b < a) monotonic = false;
  }
  check("it never moves backwards while travelling", monotonic);
  check("the hold is a third of the cycle", near(1 - SWEEP_TRAVEL_FRACTION, 1 / 3));
  check("DSH's delay is kept", SWEEP_DELAY_MS === 300 && SWEEP_CYCLE_MS === 1500);
}

console.log("DSH's steps(48, end)");
{
  check("48 steps", SWEEP_STEPS === 48);
  check("the start is exact", quantize(0) === 0);
  check("the end is exact", quantize(1) === 1);
  check("values snap to a step", near(quantize(0.5) % (1 / 48), 0));
  check("stepping is finer than the slice staircase", SWEEP_STEPS > SWEEP_BANDS * 4);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
