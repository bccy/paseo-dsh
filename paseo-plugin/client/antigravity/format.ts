export function safeLocale(locale: string | undefined): string {
  const cleaned = (locale ?? "").trim().replace(/_/g, "-");
  return cleaned || "en";
}

function isChineseLocale(locale: string | undefined): boolean {
  return safeLocale(locale).toLowerCase().startsWith("zh");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function groupThousands(intText: string): string {
  return intText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Locale-aware uppercase that never throws on partial ICU / Hermes locale tags. */
export function upper(text: string, locale?: string): string {
  try {
    return locale ? text.toLocaleUpperCase(safeLocale(locale)) : text.toLocaleUpperCase();
  } catch {
    return text.toUpperCase();
  }
}

/** "11.8K", "456K", "1M", "1.05M" — compact token counts. */
export function tokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value % 1_048_576 === 0 ? value / 1_048_576 : value / 1_000_000;
    return `${trim(millions, millions >= 10 ? 0 : 2)}M`;
  }
  if (value >= 1000) return `${trim(value / 1000, value >= 100_000 ? 0 : 1)}K`;
  return String(value);
}

/** Fixed digits without trailing fraction zeros: 1.50 -> "1.5", 300 -> "300". */
function trim(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

export function percent(fraction: number, locale: string): string {
  const digits = fraction > 0 && fraction < 0.01 ? 1 : 0;
  if (typeof Intl !== "undefined" && typeof Intl.NumberFormat === "function") {
    try {
      return new Intl.NumberFormat(safeLocale(locale), {
        style: "percent",
        maximumFractionDigits: digits,
      }).format(fraction);
    } catch {
      // Fall through to plain percentage formatting.
    }
  }
  return `${trim(fraction * 100, digits)}%`;
}

export function integer(value: number, locale: string): string {
  if (typeof Intl !== "undefined" && typeof Intl.NumberFormat === "function") {
    try {
      return new Intl.NumberFormat(safeLocale(locale)).format(value);
    } catch {
      // Fall through to ASCII grouping.
    }
  }
  return groupThousands(String(Math.round(value)));
}

/** "$0.00", "$0.0042", "$1.28", "$124.50", "$1,234" — readable currency cost formatting. */
export function money(value: number, currency: "USD" | "CNY" = "USD", locale = "en-US"): string {
  const symbol = currency === "CNY" ? "¥" : "$";
  if (!Number.isFinite(value) || value <= 0) return `${symbol}0.00`;
  if (value < 0.0001) return `<${symbol}0.0001`;
  if (value < 0.01) return `${symbol}${value.toFixed(4)}`;
  if (value < 1) return `${symbol}${value.toFixed(3)}`;
  if (value >= 1000) {
    return `${symbol}${integer(Math.round(value), locale)}`;
  }
  if (typeof Intl !== "undefined" && typeof Intl.NumberFormat === "function") {
    try {
      return `${symbol}${new Intl.NumberFormat(safeLocale(locale), {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)}`;
    } catch {
      // Fall through to fixed two-decimal formatting.
    }
  }
  return `${symbol}${value.toFixed(2)}`;
}

/** "$0.00", "$0.0042", "$1.28", "$124.50", "$1,234" — readable USD cost formatting. */
export function usd(value: number, locale = "en-US"): string {
  return money(value, "USD", locale);
}

type RelativeUnit = "second" | "minute" | "hour" | "day";

function fallbackRelative(value: number, unit: RelativeUnit, locale: string): string {
  const zh = isChineseLocale(locale);
  if (unit === "second" || value === 0) {
    return zh ? "现在" : "now";
  }
  const abs = Math.abs(value);
  const future = value > 0;
  if (unit === "day" && abs === 1) {
    return zh ? (future ? "明天" : "昨天") : future ? "tomorrow" : "yesterday";
  }
  if (zh) {
    const unitName = unit === "minute" ? "分钟" : unit === "hour" ? "小时" : "天";
    return `${abs} ${unitName}${future ? "后" : "前"}`;
  }
  const unitName = abs === 1 ? unit : `${unit}s`;
  return future ? `in ${abs} ${unitName}` : `${abs} ${unitName} ago`;
}

/**
 * "in 3 hours" / "5 minutes ago" in the app language.
 * Falls back cleanly on React Native Hermes where `Intl.RelativeTimeFormat` is undefined.
 */
export function relative(timestamp: string | number, now: number, locale: string): string {
  const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  const absolute = Math.abs(seconds);
  const [value, unit]: [number, RelativeUnit] =
    absolute < 45
      ? [0, "second"]
      : absolute < 3600
        ? [Math.round(seconds / 60), "minute"]
        : absolute < 86_400
          ? [Math.round(seconds / 3600), "hour"]
          : [Math.round(seconds / 86_400), "day"];

  const RelativeTimeFormat =
    typeof Intl !== "undefined"
      ? (
          Intl as {
            RelativeTimeFormat?: new (
              locales?: string,
              options?: { numeric?: "always" | "auto" },
            ) => { format(val: number, u: RelativeUnit): string };
          }
        ).RelativeTimeFormat
      : undefined;

  if (typeof RelativeTimeFormat === "function") {
    try {
      return new RelativeTimeFormat(safeLocale(locale), { numeric: "auto" }).format(value, unit);
    } catch {
      // Fall through to built-in relative formatter.
    }
  }
  return fallbackRelative(value, unit, locale);
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

/** 24-hour clock string ("14:05" or "14:05:09"), safe across mobile ICU implementations. */
export function clockTime(timestamp: string | number | Date, locale: string, withSeconds = false): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return "";
  if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
    try {
      return new Intl.DateTimeFormat(safeLocale(locale), {
        hour: "2-digit",
        minute: "2-digit",
        ...(withSeconds ? { second: "2-digit" } : {}),
        hour12: false,
      }).format(date);
    } catch {
      // Fall through to manual 24-hour clock.
    }
  }
  const base = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(date.getSeconds())}` : base;
}
