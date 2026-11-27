/**
 * Shared local-calendar bin windowing, day-key formatting, and binary search
 * for both DSH (`server/usage-stats.ts`) and Antigravity (`server/antigravity/stats.ts`).
 *
 * @module dsh-paseo/server/stats-bins
 */

export type CalendarBinRange = "today" | "24h" | "7d" | "30d";

export interface BinWindow {
  start: number;
  end: number;
}

export const CALENDAR_BIN_RANGES: Record<CalendarBinRange, { binMs: number; bins: number }> = {
  today: { binMs: 3_600_000, bins: 24 },
  "24h": { binMs: 3_600_000, bins: 24 },
  "7d": { binMs: 6 * 3_600_000, bins: 28 },
  "30d": { binMs: 86_400_000, bins: 30 },
};

/**
 * Builds local-calendar-aligned bin windows so daylight-saving transitions never
 * shift midnight/6-hour boundaries to 01:00 or 23:00 (which otherwise breaks day
 * labels and hides X-axis ticks).
 */
export function buildCalendarBins(now: number, range: CalendarBinRange): BinWindow[] {
  const { binMs, bins: count } = CALENDAR_BIN_RANGES[range];
  const anchor = new Date(now);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const day = anchor.getDate();

  if (range === "today") {
    return Array.from({ length: count }, (_, hour) => {
      const start = new Date(year, month, day, hour, 0, 0, 0).getTime();
      const end = new Date(year, month, day, hour + 1, 0, 0, 0).getTime();
      return { start, end };
    });
  }
  if (range === "30d") {
    return Array.from({ length: count }, (_, index) => {
      const offset = index - (count - 1);
      const start = new Date(year, month, day + offset, 0, 0, 0, 0).getTime();
      const end = new Date(year, month, day + offset + 1, 0, 0, 0, 0).getTime();
      return { start, end };
    });
  }
  if (range === "7d") {
    const slot = Math.floor(anchor.getHours() / 6);
    const currentIndex = day * 4 + slot;
    return Array.from({ length: count }, (_, index) => {
      const target = currentIndex - (count - 1 - index);
      const targetDay = Math.floor(target / 4);
      const targetSlot = ((target % 4) + 4) % 4;
      const next = target + 1;
      const nextDay = Math.floor(next / 4);
      const nextSlot = ((next % 4) + 4) % 4;
      const start = new Date(year, month, targetDay, targetSlot * 6, 0, 0, 0).getTime();
      const end = new Date(year, month, nextDay, nextSlot * 6, 0, 0, 0).getTime();
      return { start, end };
    });
  }
  // 24h: walk back 24 real hours from the current hour start so spring/fall DST hours stay monotonic.
  const currentHour = new Date(year, month, day, anchor.getHours(), 0, 0, 0).getTime();
  return Array.from({ length: count }, (_, index) => {
    const start = currentHour - (count - 1 - index) * binMs;
    return { start, end: start + binMs };
  });
}

/** Local calendar day key `"YYYY-MM-DD"`. */
export function localDayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Binary search for the half-open bin `[start, end)` containing `at`, or `-1`. */
export function findBinIndex(bins: readonly BinWindow[], at: number): number {
  let lo = 0;
  let hi = bins.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bin = bins[mid]!;
    if (at < bin.start) hi = mid - 1;
    else if (at >= bin.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}
