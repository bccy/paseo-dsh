/**
 * Hermes-safe, dual-currency (`USD` / `CNY`) formatting utilities for the DSH
 * console and timeline views.
 *
 * Deliberately free of React / React Native / Node imports so it works across
 * Web, iOS/Android Hermes, and plain Node unit tests. Avoids `Intl` options
 * that throw on partial mobile ICU / Hermes builds (e.g. `style: "unit"` or
 * `Intl.RelativeTimeFormat` without a guard) and never uses `style: "currency"`
 * so `$` and `¥` stay compact and uniform across platforms.
 *
 * @module dsh-paseo/client/console-format
 */

export type Currency = "USD" | "CNY";

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const EN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const ZH_WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** Normalize a locale tag (`zh_CN` -> `zh-CN`, empty -> `en`). */
export function safeLocale(locale?: string): string {
  const cleaned = (locale ?? "").trim().replace(/_/g, "-");
  return cleaned || "en";
}

function isChineseLocale(locale?: string): boolean {
  return safeLocale(locale).toLowerCase().startsWith("zh");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function groupThousands(intText: string): string {
  const negative = intText.startsWith("-");
  const digits = negative ? intText.slice(1) : intText;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/** Fixed digits without trailing fraction zeros: `1.50` -> `"1.5"`, `300` -> `"300"`. */
function trim(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Compact symbol for a display currency (`"USD"` -> `"$"`, `"CNY"` -> `"¥"`). */
export function currencySymbol(currency: Currency): "$" | "¥" {
  return currency === "CNY" ? "¥" : "$";
}

/** Locale-aware uppercase that never throws on partial ICU / Hermes locale tags. */
export function upper(text: string, locale?: string): string {
  try {
    return locale ? text.toLocaleUpperCase(safeLocale(locale)) : text.toLocaleUpperCase();
  } catch {
    return text.toUpperCase();
  }
}

/** Compact token count: `"420"`, `"11.8K"`, `"456K"`, `"1M"`, `"1.05M"`, `"1.25B"`. */
export function tokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    const billions = abs / 1_000_000_000;
    return `${sign}${trim(billions, billions >= 100 ? 0 : billions >= 10 ? 1 : 2)}B`;
  }
  if (abs >= 1_000_000) {
    // Context windows are binary sizes: 1,048,576 reads as "1M".
    const millions = abs % 1_048_576 === 0 ? abs / 1_048_576 : abs / 1_000_000;
    return `${sign}${trim(millions, millions >= 100 ? 0 : millions >= 10 ? 1 : 2)}M`;
  }
  if (abs >= 1000) {
    return `${sign}${trim(abs / 1000, abs >= 100_000 ? 0 : 1)}K`;
  }
  return `${sign}${Math.round(abs)}`;
}

/** Percentage string (`"76%"`, `"0.4%"`), with safe fallback when `Intl` is unavailable. */
export function percent(fraction: number, locale = "en"): string {
  if (!Number.isFinite(fraction)) return "0%";
  const abs = Math.abs(fraction);
  const digits = abs > 0 && abs < 0.01 ? 1 : 0;
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

/** Locale-grouped integer (`"1,234"`), safe on Hermes builds with partial ICU. */
export function integer(value: number, locale = "en"): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value);
  if (typeof Intl !== "undefined" && typeof Intl.NumberFormat === "function") {
    try {
      return new Intl.NumberFormat(safeLocale(locale), { maximumFractionDigits: 0 }).format(rounded);
    } catch {
      // Fall through to ASCII grouping.
    }
  }
  return groupThousands(String(rounded));
}

function formatTwoDecimals(value: number, locale: string): string {
  if (typeof Intl !== "undefined" && typeof Intl.NumberFormat === "function") {
    try {
      return new Intl.NumberFormat(safeLocale(locale), {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    } catch {
      // Fall through to ASCII grouping.
    }
  }
  const [whole = "0", fraction = "00"] = value.toFixed(2).split(".");
  return `${groupThousands(whole)}.${fraction}`;
}

/**
 * Readable dual-currency cost: `"$0.00"`, `"<$0.0001"`, `"$0.0042"`, `"$1.28"`,
 * `"¥9.22"`, `"$1,234"`.
 */
export function money(value: number, currency: Currency = "USD", locale = "en"): string {
  const sym = currencySymbol(currency);
  if (!Number.isFinite(value) || value <= 0) return `${sym}0.00`;
  if (value < 0.0001) return `<${sym}0.0001`;
  if (value < 0.01) return `${sym}${value.toFixed(4)}`;
  if (value < 1) return `${sym}${value.toFixed(3)}`;
  if (value >= 1000) return `${sym}${integer(Math.round(value), locale)}`;
  return `${sym}${formatTwoDecimals(value, locale)}`;
}

/**
 * Fixed two-decimal cost (`"$113.05"`, `"¥0.12"`, `"<$0.01"`) so columns of
 * numbers align on the decimal point.
 */
export function moneyFixed(value: number, currency: Currency = "USD", locale = "en"): string {
  const sym = currencySymbol(currency);
  if (!Number.isFinite(value) || value <= 0) return `${sym}0.00`;
  if (value < 0.005) return `<${sym}0.01`;
  return `${sym}${formatTwoDecimals(value, locale)}`;
}

/** Compact dual-currency formatter for chart Y-axis ticks (`"$0"`, `"$0.05"`, `"¥12.5K"`). */
export function moneyShort(value: number, currency: Currency = "USD"): string {
  const sym = currencySymbol(currency);
  if (!Number.isFinite(value) || value <= 0) return `${sym}0`;
  if (value < 0.01) return `${sym}${trim(value, 4)}`;
  if (value < 1) return `${sym}${trim(value, 3)}`;
  if (value < 100) return `${sym}${trim(value, 2)}`;
  if (value >= 10_000) return `${sym}${trim(value / 1000, value >= 100_000 ? 0 : 1)}K`;
  return `${sym}${Math.round(value)}`;
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
 * Relative time (`"in 3 hours"`, `"5 minutes ago"`, `"5 分钟前"`).
 * Falls back cleanly on Hermes where `Intl.RelativeTimeFormat` is absent.
 */
export function relative(timestamp: string | number, now = Date.now(), locale = "en"): string {
  const time = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(time) || !Number.isFinite(now)) return "";
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

function formatUnit(value: number | string, unit: "second" | "minute" | "hour", zh: boolean): string {
  if (zh) {
    const suffix = unit === "second" ? "秒" : unit === "minute" ? "分" : "小时";
    return `${value}${suffix}`;
  }
  const suffix = unit === "second" ? "s" : unit === "minute" ? "m" : "h";
  return `${value}${suffix}`;
}

function formatDurationMs(ms: number, locale: string, allowSubSecond: boolean): string {
  const zh = isChineseLocale(locale);
  if (allowSubSecond && ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  if (allowSubSecond && ms < 10_000) {
    return formatUnit(trim(ms / 1000, 1), "second", zh);
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return formatUnit(Math.max(1, seconds), "second", zh);
  }
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) {
    return formatUnit(totalMinutes, "minute", zh);
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes
    ? `${formatUnit(hours, "hour", zh)} ${formatUnit(minutes, "minute", zh)}`
    : formatUnit(hours, "hour", zh);
}

function looksLikeLocaleTag(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  return /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(trimmed);
}

/**
 * Elapsed duration (`"420ms"`, `"1.4s"`, `"12s"`, `"9m"`, `"1h 15m"` / `"12秒"`,
 * `"9分"`, `"1小时 15分"`).
 *
 * Accepts either `(ms, locale?)` or `(start, end, locale?)`. Avoids
 * `Intl.NumberFormat({ style: "unit" })`, which throws on many Hermes builds.
 */
export function duration(ms: number, locale?: string): string;
export function duration(
  start: string | number | null | undefined,
  end: string | number | null | undefined,
  locale?: string,
): string | null;
export function duration(
  first: string | number | null | undefined,
  second?: string | number | null | undefined,
  third?: string,
): string | null {
  const isLocaleArg =
    typeof second === "string" &&
    (looksLikeLocaleTag(second) || !Number.isFinite(Date.parse(second)));
  if (arguments.length < 3 && typeof first === "number" && (second === undefined || isLocaleArg)) {
    if (!Number.isFinite(first) || first < 0) return "";
    return formatDurationMs(first, second ?? "en", true);
  }
  const from = typeof first === "number" ? first : first ? Date.parse(first) : NaN;
  const to = typeof second === "number" ? second : second ? Date.parse(second) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return formatDurationMs(to - from, third ?? "en", false);
}

/** 24-hour clock string (`"14:05"` or `"14:05:09"`), safe across mobile ICU implementations. */
export function clockTime(timestamp: string | number | Date, locale = "en", withSeconds = false): string {
  const date = toDate(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
    try {
      const formatted = new Intl.DateTimeFormat(safeLocale(locale), {
        hour: "2-digit",
        minute: "2-digit",
        ...(withSeconds ? { second: "2-digit" } : {}),
        hour12: false,
      }).format(date);
      // Some ICU builds format midnight as "24:00" under `hour12: false`.
      return formatted.replace(/^24:/, "00:");
    } catch {
      // Fall through to manual 24-hour clock.
    }
  }
  const base = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(date.getSeconds())}` : base;
}

/** Formatters are costly to construct and charts format hundreds of dates; cache per key. */
const dateFormatters = new Map<string, Intl.DateTimeFormat | null>();

function dateText(
  input: Date | number | string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
  fallback: (date: Date) => string,
): string {
  const date = toDate(input);
  if (!Number.isFinite(date.getTime())) return "";
  const key = `${safeLocale(locale)}|${JSON.stringify(options)}`;
  let formatter = dateFormatters.get(key);
  if (formatter === undefined) {
    formatter = null;
    if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
      try {
        formatter = new Intl.DateTimeFormat(safeLocale(locale), options);
      } catch {
        // Fall back to the built-in names.
      }
    }
    dateFormatters.set(key, formatter);
  }
  if (formatter) {
    try {
      return formatter.format(date);
    } catch {
      // Fall through to the built-in names.
    }
  }
  return fallback(date);
}

/** Short month name (`"Nov"`, `"11月"`). */
export function monthShort(date: Date | number | string, locale = "en"): string {
  return dateText(date, locale, { month: "short" }, (d) =>
    isChineseLocale(locale) ? `${d.getMonth() + 1}月` : EN_MONTHS[d.getMonth()]!,
  );
}

/** Short weekday name (`"Mon"`, `"周一"`). */
export function weekdayShort(date: Date | number | string, locale = "en"): string {
  return dateText(date, locale, { weekday: "short" }, (d) =>
    (isChineseLocale(locale) ? ZH_WEEKDAYS : EN_WEEKDAYS)[d.getDay()]!,
  );
}

/** Month and day label (`"Nov 23"`, `"11月23日"`). */
export function dayLabel(date: Date | number | string, locale = "en"): string {
  return dateText(date, locale, { month: "short", day: "numeric" }, (d) =>
    isChineseLocale(locale)
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : `${EN_MONTHS[d.getMonth()]} ${d.getDate()}`,
  );
}

/** Full date with weekday (`"Sun, Nov 23, 2026"`, `"2026年11月23日周日"`). */
export function longDate(date: Date | number | string, locale = "en"): string {
  return dateText(date, locale, { weekday: "short", year: "numeric", month: "short", day: "numeric" }, (d) =>
    isChineseLocale(locale)
      ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${ZH_WEEKDAYS[d.getDay()]}`
      : `${EN_WEEKDAYS[d.getDay()]}, ${EN_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`,
  );
}

/** Numeric month/day label (`"11/23"`), safe across mobile ICU implementations. */
export function monthDay(timestamp: Date | number | string, locale = "en"): string {
  return dateText(timestamp, locale, { month: "numeric", day: "numeric" }, (d) =>
    `${d.getMonth() + 1}/${d.getDate()}`,
  );
}

/** Sunday-first (`0`) weeks in English, Monday-first (`1`) in Chinese. */
export function weekStartsOn(locale = "en"): 0 | 1 {
  return isChineseLocale(locale) ? 1 : 0;
}
