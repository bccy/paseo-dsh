/**
 * Pure state, geometry, and rasterized badge data for timeline row status icons
 * (Plan A: base glyph + bottom-right knocked-out badge, bare green checkmark).
 *
 * Kept free of React and React Native imports so offline harnesses can compile
 * and `require` this module directly with plain `node`.
 *
 * @module dsh-paseo/client/row-status-icon-data
 */

/** Visual status rendered on a timeline row's leading icon slot. */
export type RowIconStatus = "running" | "completed" | "failed" | "idle";

/** Duration (ms) of one smooth rotation for the running thinking-petals glyph. */
export const ROW_ICON_SPIN_MS = 3600;

/** Duration (ms) of one gentle breathing pulse for a running tool glyph. */
export const ROW_ICON_PULSE_MS = 1600;

/** Duration (ms) of the one-shot pop animation when a running row settles. */
export const ROW_BADGE_POP_MS = 260;

/**
 * Fallback semantic colours used only when an offline test passes a minimal
 * theme without `statusSuccess` / `statusDanger`. Real Paseo themes always
 * supply both tokens.
 */
export const FALLBACK_SUCCESS_COLOR = "#4ade80";
export const FALLBACK_DANGER_COLOR = "#f87171";

/**
 * Geometry of the bottom-right corner badge for a given base icon size.
 *
 * Mirrors `CornerRingIcon` (`PILL_CORNER_FRAME = 9`, `PILL_CORNER_RING = 6`)
 * for compact 14px rows, and scales up by 1px for standard 16px rows.
 */
export interface CornerBadgeMetrics {
  /** Outer knockout circle diameter (filled with `surface0`). */
  readonly frame: number;
  /** Outward offset from the base glyph's bottom-right corner (negative). */
  readonly offset: number;
  /** Running `StatusRingMark` outer ring diameter inside `frame`. */
  readonly ring: number;
  /** Bare green checkmark glyph size inside `frame`. */
  readonly checkGlyph: number;
  /** Error solid red circle diameter inside `frame`. */
  readonly errorDisk: number;
  /** Error cross glyph size inside `errorDisk`. */
  readonly errorGlyph: number;
}

export function cornerBadgeMetrics(size: number): CornerBadgeMetrics {
  if (size >= 16) {
    return {
      frame: 10,
      offset: -2,
      ring: 7,
      checkGlyph: 8.5,
      errorDisk: 8.5,
      errorGlyph: 6.5,
    };
  }
  return {
    frame: 9,
    offset: -1.5,
    ring: 6,
    checkGlyph: 7.5,
    errorDisk: 7.5,
    errorGlyph: 5.5,
  };
}

/**
 * Map a tool-call row's `status` and pulse-activeness to its leading icon state.
 *
 * - `failed` always shows the error badge.
 * - `completed` always shows the bare green checkmark (even while a freshly
 *   finished short command still shimmers its text for a moment).
 * - `running` shows the animated ring only when `active` is true, so a stale
 *   `running` row left over from an interrupted historic session does not spin
 *   forever.
 * - `canceled` (and any unknown status) stays quiet (`idle`).
 */
export function resolveRowIconStatus(status: string, active: boolean): RowIconStatus {
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  if (status === "running") return active ? "running" : "idle";
  return "idle";
}

/**
 * Map an `InlineThinking` row's `growing` flag to its leading icon state.
 *
 * Both live-settled and historic completed thinking rows receive the bare green
 * checkmark; only live `running -> completed` transitions play the pop motion.
 */
export function resolveThinkingIconStatus(growing: boolean): RowIconStatus {
  return growing ? "running" : "completed";
}

/**
 * Whether transitioning from `previous` to `current` should trigger the
 * one-shot badge pop animation. Historic rows mount directly in `completed` or
 * `failed` and never pop.
 */
export function shouldPopRowBadge(previous: RowIconStatus, current: RowIconStatus): boolean {
  return previous === "running" && (current === "completed" || current === "failed");
}

/**
 * 48x48 white-on-transparent antialiased PNG (~5.6x oversampled for an 8.5px
 * bare green checkmark: `M2.2 6.3 L4.8 8.9 L9.8 3.3` on a 12x12 viewBox,
 * stroke-width 2.35, round caps and join). Tinted with `colors.statusSuccess`
 * at render time via `<Image tintColor>` so dark and light themes stay crisp
 * with zero third-party dependencies.
 */
export const CHECK_BADGE_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAABhElEQVR42u2YIUsEQRiGD0yiReGwahK5fmgRg3Ux6S/QJAaxyV3RJCaRC9rOpEk3KZdMmsRmU1gQ4xUxKT5uuOJ56843s3v7LczT55vnvRtmX6ZS8Xg8Ho9HGUAN2AaaQFA2+TZ/iYB6GeTPSeYTqGqWPyKdllb5XcyINMqvY05Xm3yAjI4m+TpyAi3y08C7UP5Qi/wo8CyUP9N0dO6E8jea5C+F8o9Z3BLNXi+pOc46Ecq/AZMuN0Q0YGjbct6eUP4LmLOVr/Z6RxKhcN6mxXW55PJXtww2CA1nrVrIr7me+8hwozBlzqKF/FYWN0VXsGGYMGM25RgOYj+rq64j3DjsWz8RF7RX4YzTIgvWrxDx+geXHyCrEAc2IYBr4Zr7PL+aNiEkvMQFbSzvT39eIT7ij+LMsPpLHiHmh13CsgyxUlSTzCLERtF12CVEQ0untwlxrO01QRLiQutjlEmIW+1vmf+FeIoL2kgZHmR3gO8++StgvGzP4gvAMjBV8Xg8Hk9Z+AG5PRubvWNqqwAAAABJRU5ErkJggg==";

/**
 * 48x48 white-on-transparent antialiased PNG (~7x oversampled for a 6.5px cross
 * inside the failed badge: `M3.2 3.2 L8.8 8.8` and `M8.8 3.2 L3.2 8.8` on a
 * 12x12 viewBox, stroke-width 2.2, round caps). Tinted with `colors.surface0`
 * on top of a `colors.statusDanger` disk.
 */
export const ERROR_BADGE_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAA4ElEQVR42u2Y0Q2EIBBELcoCbIZuaIAG+KIym5gLyfl13h3KIAzZ9+86L8F12WUxDMMwjEIAOAABgAewEetu75q5tmsRfAWw45NIqB1P6uZ3rUyBs/AHqaJu+lF3Zx6bfyRy+APHEAgoI5HDZwJDwKOcRAyf8awOAYbExfCgdbovneKSxI3wkd1K012Jmme7SwwTvkJinPCNJZ4J30ji2fBkiT7hSRJ9w1dKjBFeXkD6CEl/xNJtVPpHJj1KSA9z0uO09IVG/ko5w6Vefq2ivdiSXy1OsdyVX68bhmEY0/ICeUnZjFokpbMAAAAASUVORK5CYII=";
