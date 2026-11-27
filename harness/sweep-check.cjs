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
  SWEEP_BEAMS,
  SWEEP_CONCENTRIC_LAYERS,
  SWEEP_CYCLE_MS,
  SWEEP_DELAY_MS,
  SWEEP_PEAK_OPACITY_DARK,
  SWEEP_PEAK_OPACITY_LIGHT,
  SWEEP_PERIOD_MS,
  SWEEP_STEPS,
  SWEEP_TRAVEL_FRACTION,
  bandAlpha,
  bandLeft,
  bandWidth,
  beamPeriodProfile,
  concentricBeamLayers,
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

console.log("the mask profile matches the seamless raised-cosine 3-beam wave");
{
  check("3 evenly spaced beams per row", SWEEP_BEAMS === 3);
  check("zero at period dark troughs", near(beamPeriodProfile(0), 0) && near(beamPeriodProfile(1), 0));
  check("beam peaks smoothly at center of each period", near(beamPeriodProfile(0.5), 1));
  check("all three beams peak at identical spacing 1/3 apart", near(sweepProfile(1 / 6), 1) && near(sweepProfile(3 / 6), 1) && near(sweepProfile(5 / 6), 1));
  check("dark troughs sit identically between every beam and at wrap boundaries", near(sweepProfile(0), 0) && near(sweepProfile(1 / 3), 0) && near(sweepProfile(2 / 3), 0) && near(sweepProfile(1), 0));
  check(
    "smooth monotonic cosine rise and symmetric fall with soft shoulders",
    beamPeriodProfile(0.1) < beamPeriodProfile(0.25) &&
      beamPeriodProfile(0.25) < beamPeriodProfile(0.4) &&
      near(beamPeriodProfile(0.25), beamPeriodProfile(0.75)),
  );
  check("clamped outside 0..1", sweepProfile(-3) === 0 && sweepProfile(9) === 0);
}

console.log("the feathered triple-beam slice staircase");
{
  check("21 slices resolve 3 beams with 7 feathered slices per period", SWEEP_BANDS === 21);
  check("each beam center slice reaches full peak alpha", near(bandAlpha(3), 1) && near(bandAlpha(10), 1) && near(bandAlpha(17), 1));
  check(
    "each beam ramps smoothly through multi-step feathered edges",
    bandAlpha(0) < 0.04 &&
      bandAlpha(1) > 0.1 &&
      bandAlpha(1) < bandAlpha(2) &&
      bandAlpha(2) < bandAlpha(3),
  );
  check(
    "all 3 periods have identical slice alphas (100% uniform spacing)",
    [0, 1, 2, 3, 4, 5, 6].every((sub) => near(bandAlpha(sub), bandAlpha(sub + 7)) && near(bandAlpha(sub), bandAlpha(sub + 14))),
  );
  check(
    "the slices tile the window",
    near(bandLeft(0), 0) &&
      near(bandLeft(SWEEP_BANDS - 1) + bandWidth(), 1) &&
      near(bandWidth() * SWEEP_BANDS, 1),
  );
}

console.log("the seamless 4.5s conveyor clock");
{
  check("starts at offset 0", near(sweepOffset(0), 0));
  check("halfway through one period sits at 1/6 row width", near(sweepOffset(SWEEP_PERIOD_MS / 2), 1 / 6));
  check("wraps seamlessly at SWEEP_PERIOD_MS", near(sweepOffset(SWEEP_PERIOD_MS), 0));
  check("travels continuously with zero pause seam", SWEEP_TRAVEL_FRACTION === 1);
  let monotonic = true;
  for (let i = 1; i <= 32; i += 1) {
    const a = sweepOffset((SWEEP_PERIOD_MS * (i - 1)) / 33);
    const b = sweepOffset((SWEEP_PERIOD_MS * i) / 33);
    if (b <= a) monotonic = false;
  }
  check("advances strictly linearly within every period", monotonic);
  check("4.5s full-row cycle and 1.5s period shift are kept", SWEEP_DELAY_MS === 120 && SWEEP_CYCLE_MS === 4500 && SWEEP_PERIOD_MS === 1500);
  check(
    "balanced peak shimmer opacity on both dark and light themes",
    SWEEP_PEAK_OPACITY_DARK >= 0.75 &&
      SWEEP_PEAK_OPACITY_DARK <= 0.9 &&
      SWEEP_PEAK_OPACITY_LIGHT >= 0.6 &&
      SWEEP_PEAK_OPACITY_LIGHT < SWEEP_PEAK_OPACITY_DARK,
  );
}

console.log("concentric nested beam layers (zero adjacent seams)");
{
  const layers = concentricBeamLayers(SWEEP_PEAK_OPACITY_DARK);
  check("builds SWEEP_CONCENTRIC_LAYERS nested rings", layers.length === SWEEP_CONCENTRIC_LAYERS && layers.length >= 6);
  let nested = true;
  let maxStep = 0;
  let composited = 0;
  for (let i = 0; i < layers.length; i += 1) {
    const cur = layers[i];
    if (i > 0) {
      const prev = layers[i - 1];
      if (!(cur.leftInPeriod > prev.leftInPeriod && cur.leftInPeriod + cur.widthInPeriod < prev.leftInPeriod + prev.widthInPeriod)) {
        nested = false;
      }
    }
    const nextComposited = 1 - (1 - composited) * (1 - cur.alpha);
    maxStep = Math.max(maxStep, nextComposited - composited);
    composited = nextComposited;
  }
  check("every ring sits strictly inside the previous ring (zero edge-to-edge seams)", nested);
  check("composited core reaches exact peakOpacity", near(composited, SWEEP_PEAK_OPACITY_DARK, 1e-3), `${composited} vs ${SWEEP_PEAK_OPACITY_DARK}`);
  check("every single concentric step stays gentle (<= 0.22)", maxStep <= 0.22, `maxStep=${maxStep.toFixed(3)}`);
}

console.log("steps(96, end)");
{
  check("96 steps", SWEEP_STEPS === 96);
  check("the start is exact", quantize(0) === 0);
  check("the end is exact", quantize(1) === 1);
  check("values snap to a step", near(quantize(0.5) % (1 / 96), 0));
  check("stepping is finer than the slice staircase", SWEEP_STEPS > SWEEP_BANDS * 4);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
