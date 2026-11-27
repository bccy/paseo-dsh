import { money, safeLocale } from "../console-format";

export {
  clockTime,
  integer,
  money,
  percent,
  relative,
  safeLocale,
  tokens,
  upper,
} from "../console-format";

function isChineseLocale(locale: string | undefined): boolean {
  return safeLocale(locale).toLowerCase().startsWith("zh");
}

/** "$0.00", "$0.0042", "$1.28", "$124.50", "$1,234" — readable USD cost formatting. */
export function usd(value: number, locale = "en-US"): string {
  return money(value, "USD", locale);
}

/** Elapsed duration ("12s", "9m", "1h 15m"), safe on Hermes/iOS builds with buggy `style: "unit"`. */
export function duration(start: string | null, end: string | null, locale: string): string | null {
  const from = start ? Date.parse(start) : NaN;
  const to = end ? Date.parse(end) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const seconds = Math.round((to - from) / 1000);
  const zh = isChineseLocale(locale);
  const formatUnit = (value: number, unit: "second" | "minute" | "hour") => {
    // Avoid `Intl.NumberFormat({ style: "unit", unit: "minute", unitDisplay: "narrow" })` on zh-CN:
    // iOS/Hermes ICU renders minutes multiplied by 60 as seconds (e.g. 29m -> "1,740 秒").
    if (zh) {
      const suffix = unit === "second" ? " 秒" : unit === "minute" ? " 分钟" : " 小时";
      return `${value}${suffix}`;
    }
    if (typeof Intl !== "undefined" && typeof Intl.NumberFormat === "function") {
      try {
        return new Intl.NumberFormat(safeLocale(locale), {
          style: "unit",
          unit,
          unitDisplay: "narrow",
        }).format(value);
      } catch {
        // Fall through on Hermes builds that reject `style: "unit"`.
      }
    }
    const suffix = unit === "second" ? "s" : unit === "minute" ? "m" : "h";
    return `${value}${suffix}`;
  };
  if (seconds < 60) return formatUnit(Math.max(1, seconds), "second");
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return formatUnit(totalMinutes, "minute");
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (zh) {
    return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  }
  return minutes ? `${formatUnit(hours, "hour")} ${formatUnit(minutes, "minute")}` : formatUnit(hours, "hour");
}
