/**
 * The geometry of DSH's row shimmer, as plain numbers.
 *
 * DSH's effect is one masked window sliding across a stationary copy of the
 * text: `.sweep` translates while `.highlight` counter-translates, so the
 * glyphs never move and only the mask does. Its mask is a 105° gradient —
 * transparent, opaque from 40% to 60%, transparent again.
 *
 * React Native has no mask and no gradient, so the mask is rebuilt as `count`
 * equal slices with a constant alpha each: the gradient's profile sampled at
 * the middle of every slice. Everything here is pure so the staircase, the
 * timing and the counter-translation can be asserted without a device.
 *
 * @module dsh-paseo/client/sweep-geometry
 */

/** Full-row transit duration (`4.5s` for one beam to cross the full row width; `1.5s` per beam step). */
export const SWEEP_CYCLE_MS = 4500;
/** Brief initial delay (`0.12s`), keeping active rows in step without hiding short runs. */
export const SWEEP_DELAY_MS = 120;
/** Number of evenly spaced beams visible across the row at any instant. */
export const SWEEP_BEAMS = 3;
/** Seamless continuous conveyor: travels 100% of the cycle with zero pause seam. */
export const SWEEP_TRAVEL_FRACTION = 1;
/** Balanced peak shimmer highlight opacity on dark surfaces. */
export const SWEEP_PEAK_OPACITY_DARK = 0.82;
/** Balanced peak shimmer highlight opacity on light surfaces. */
export const SWEEP_PEAK_OPACITY_LIGHT = 0.68;
/** Gentle base-text dim while active for clean yet understated contrast. */
export const SWEEP_ACTIVE_BASE_OPACITY = 0.78;

/** Slices per beam period (7 per beam = 5 feathered visible steps; dark troughs skipped). */
export const SWEEP_SLICES_PER_BEAM = 7;
/** Total slice count across the visible row width (`3 * 7 = 21`). */
export const SWEEP_BANDS = SWEEP_BEAMS * SWEEP_SLICES_PER_BEAM;

/**
 * Single repeating beam period profile on `u` in `[0, 1)` using a raised-cosine
 * bell curve `(0.5 - 0.5 * cos(2πu))^1.6`:
 * - Zero slope at both dark troughs (`u = 0, 1`) and bright peak (`u = 0.5`)
 * - Produces a continuous, feather-soft gradient with zero hard borders.
 */
export function beamPeriodProfile(u: number): number {
  const local = ((u % 1) + 1) % 1;
  const wave = 0.5 - 0.5 * Math.cos(2 * Math.PI * local);
  return Math.pow(Math.max(0, Math.min(1, wave)), 1.6);
}

/**
 * Seamless 3-beam periodic mask profile sampled across the row `t` in `0..1`.
 * Every beam has identical width and identical spacing — even across loop wrap.
 */
export function sweepProfile(t: number): number {
  if (t < 0 || t > 1) return 0;
  return beamPeriodProfile(t * SWEEP_BEAMS);
}

/** The alpha of slice `index` of `count`, sampled at the slice's middle. */
export function bandAlpha(index: number, count: number = SWEEP_BANDS): number {
  return sweepProfile((index + 0.5) / count);
}

/** The left edge of slice `index`, as a fraction of the window. */
export function bandLeft(index: number, count: number = SWEEP_BANDS): number {
  return index / count;
}

/** The width of one slice, as a fraction of the window. */
export function bandWidth(count: number = SWEEP_BANDS): number {
  return 1 / count;
}

/**
 * Duration (ms) for one seamless period shift (`1 / SWEEP_BEAMS` of the row width).
 * Shifting by one exact period loops pixel-for-pixel seamlessly with zero pause.
 */
export const SWEEP_PERIOD_MS = SWEEP_CYCLE_MS / SWEEP_BEAMS;

/**
 * Seamless linear offset within one beam period (`[0, 1 / SWEEP_BEAMS)`) at `elapsedMs`.
 */
export function sweepOffset(elapsedMs: number, cycleMs: number = SWEEP_CYCLE_MS): number {
  const periodMs = cycleMs / SWEEP_BEAMS;
  const phase = (((elapsedMs % periodMs) + periodMs) % periodMs) / periodMs;
  return phase / SWEEP_BEAMS;
}

/** Concentric nested highlight layers per beam (zero adjacent slice seams on iOS Retina). */
export const SWEEP_CONCENTRIC_LAYERS = 6;

export interface ConcentricBeamLayer {
  /** Left inset within a single `[0, 1]` beam period. */
  readonly leftInPeriod: number;
  /** Width fraction within a single `[0, 1]` beam period. */
  readonly widthInPeriod: number;
  /** Individual layer opacity solved via Porter-Duff so nested layers compose smoothly. */
  readonly alpha: number;
  /** Target cumulative composited opacity inside this layer. */
  readonly cumulativeAlpha: number;
}

/**
 * Build nested concentric highlight layers for one beam period `[0, 1]`.
 *
 * Unlike side-by-side tiled slices (which create 1px sub-pixel seams and sharp
 * vertical steps on iOS `@3x` screens), concentric nested layers NEVER meet
 * edge-to-edge and build brightness gradually (~7%..18% per step) up to `peakOpacity`.
 */
export function concentricBeamLayers(
  peakOpacity: number,
  layerCount: number = SWEEP_CONCENTRIC_LAYERS,
): ConcentricBeamLayer[] {
  const clampedPeak = Math.max(0, Math.min(0.99, peakOpacity));
  if (clampedPeak <= 0 || layerCount <= 0) return [];
  const layers: ConcentricBeamLayer[] = [];
  let prevCumulative = 0;
  // Widths shrink smoothly from 86% (outer mist) to 16% (velvet core).
  const outerW = 0.86;
  const innerW = 0.16;
  for (let i = 0; i < layerCount; i += 1) {
    const frac = layerCount === 1 ? 1 : i / (layerCount - 1);
    const widthInPeriod = outerW - (outerW - innerW) * frac;
    const leftInPeriod = (1 - widthInPeriod) / 2;
    // Sample our smooth raised-cosine bell at the midpoint of this concentric ring
    // (or exact peak at the innermost core).
    const u = i === layerCount - 1 ? 0.5 : leftInPeriod + (outerW - innerW) / (2 * Math.max(1, layerCount - 1));
    const profile = i === layerCount - 1 ? 1 : beamPeriodProfile(u);
    const targetCumulative = Math.max(prevCumulative, Math.min(clampedPeak, profile * clampedPeak));
    const denom = Math.max(1e-6, 1 - prevCumulative);
    const layerAlpha = Math.max(0, Math.min(1, (targetCumulative - prevCumulative) / denom));
    layers.push({
      leftInPeriod,
      widthInPeriod,
      alpha: Number(layerAlpha.toFixed(4)),
      cumulativeAlpha: Number(targetCumulative.toFixed(4)),
    });
    prevCumulative = targetCumulative;
  }
  return layers;
}

/** `steps(96, end)`: smooth stepping finer than the 21-slice feathered staircase. */
export const SWEEP_STEPS = 96;

/** Quantize a 0..1 progress the way `steps(96, end)` does. */
export function quantize(progress: number, steps: number = SWEEP_STEPS): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return Math.round(clamped * steps) / steps;
}
