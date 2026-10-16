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

/** DSH's `animation-duration: 1.5s`. */
export const SWEEP_CYCLE_MS = 1500;
/** DSH's `animation-delay: 0.3s`. */
export const SWEEP_DELAY_MS = 300;
/**
 * The transform moves for the first 2/3 of the cycle and rests for the last
 * third: DSH's keyframes go `-100%` at 0% to `100%` at 66.6667%, then hold.
 */
export const SWEEP_TRAVEL_FRACTION = 2 / 3;

/** How many slices stand in for the gradient. */
export const SWEEP_BANDS = 8;

/**
 * DSH's mask profile, sampled at `t` in 0..1 across the window: transparent at
 * the edges, opaque between 40% and 60%.
 */
export function sweepProfile(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return Math.max(0, Math.min(clamped / 0.4, (1 - clamped) / 0.4, 1));
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
 * Where the mask window sits, as a fraction of the row width, at `elapsedMs`
 * into a cycle. `-1` is DSH's `translateX(-100%)`, `1` is `translateX(100%)`,
 * and the value holds at `1` for the last third of the cycle.
 */
export function sweepOffset(elapsedMs: number, cycleMs: number = SWEEP_CYCLE_MS): number {
  const phase = ((elapsedMs % cycleMs) + cycleMs) % cycleMs / cycleMs;
  if (phase >= SWEEP_TRAVEL_FRACTION) return 1;
  return -1 + (2 * phase) / SWEEP_TRAVEL_FRACTION;
}

/** DSH's `steps(48, end)`: the transform advances in 48 discrete jumps. */
export const SWEEP_STEPS = 48;

/** Quantize a 0..1 progress the way `steps(48, end)` does. */
export function quantize(progress: number, steps: number = SWEEP_STEPS): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return Math.round(clamped * steps) / steps;
}
