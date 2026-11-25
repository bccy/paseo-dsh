/**
 * 53-week token activity heatmap for the DSH console Usage tab.
 *
 * Pure React Native (`View` + `Pressable`), Hermes-safe, dark/light theme
 * friendly, and responsive down to narrow mobile viewports (`<560px`) where
 * week columns automatically shrink to keep tiles `>=12px` and day details
 * appear in a tap-selected inline bar with zero hover dependency.
 *
 * @module dsh-paseo/client/console-heatmap
 */
import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import type { UsageDaily } from "../shared/usage";
import {
  dayLabel,
  integer,
  longDate,
  moneyFixed,
  monthShort,
  safeLocale,
  tokens,
  weekdayShort,
  weekStartsOn,
  type Currency,
} from "./console-format";
import { font, radius, space, tabular, tint, type Colors } from "./console-theme";
import { Card } from "./console-ui";

const DAY_MS = 86_400_000;
const MAX_WEEKS = 53;
const NARROW_BREAKPOINT = 560;
const LABEL_WIDTH = 32;
const LABEL_GAP = 6;
const MONTH_ROW = 20;
const MAX_PITCH = 17;
const MIN_PITCH_WIDE = 11;
/** Narrow screens enforce >=12px tiles with >=3px breathing room between tiles. */
const MIN_PITCH_NARROW = 15;
const MIN_CELL_NARROW = 12;
const TOOLTIP_WIDTH = 224;

/** Single-hue accent alpha steps so the scale reads cleanly in both light and dark themes. */
const LEVEL_ALPHA = [0, 0.24, 0.46, 0.7, 1] as const;
const LEVELS = [0, 1, 2, 3, 4] as const;

type Level = (typeof LEVELS)[number];

interface DayCell {
  day: number;
  tokens: number;
  requests: number;
  cost: number | null;
  level: Level;
}

interface HeatmapCopy {
  title: string;
  totalYear(value: string): string;
  totalWeeks(value: string, weeks: number): string;
  totalWeeksCompact(value: string, weeks: number): string;
  tokensReadout(value: string): string;
  requestsReadout(count: number, formatted: string): string;
  costLabel: string;
  none: string;
  activeDays: string;
  peakDay: string;
  activeDailyAvg: string;
  streak: string;
  daysCount(count: number, formatted: string): string;
  less: string;
  more: string;
  legend: string;
  tapHint: string;
  dismissSelection: string;
}

const COPY_EN: HeatmapCopy = {
  title: "Activity",
  totalYear: (value) => `${value} tokens in the last year`,
  totalWeeks: (value, weeks) => `${value} tokens in the last ${weeks} weeks`,
  totalWeeksCompact: (value, weeks) => `${value} tokens · ${weeks}w`,
  tokensReadout: (value) => `${value} tokens`,
  requestsReadout: (count, formatted) => `${formatted} ${count === 1 ? "request" : "requests"}`,
  costLabel: "Cost",
  none: "No activity",
  activeDays: "Active days",
  peakDay: "Peak day",
  activeDailyAvg: "Active daily avg",
  streak: "Streak",
  daysCount: (count, formatted) => `${formatted} ${count === 1 ? "day" : "days"}`,
  less: "Less",
  more: "More",
  legend: "Activity intensity scale from less to more",
  tapHint: "Tap any square to inspect day totals",
  dismissSelection: "Clear selected day",
};

const COPY_ZH: HeatmapCopy = {
  title: "活跃度",
  totalYear: (value) => `近一年共 ${value} tokens`,
  totalWeeks: (value, weeks) => `近 ${weeks} 周共 ${value} tokens`,
  totalWeeksCompact: (value, weeks) => `近 ${weeks} 周共 ${value} tokens`,
  tokensReadout: (value) => `${value} tokens`,
  requestsReadout: (_count, formatted) => `${formatted} 次请求`,
  costLabel: "估算费用",
  none: "无用量记录",
  activeDays: "活跃天数",
  peakDay: "最高单日",
  activeDailyAvg: "活跃日均",
  streak: "连续天数",
  daysCount: (_count, formatted) => `${formatted} 天`,
  less: "少",
  more: "多",
  legend: "活跃度从低到高色阶",
  tapHint: "点击任意方格查看当日详情",
  dismissSelection: "清除选中日期",
};

function copyFor(locale: string): HeatmapCopy {
  return safeLocale(locale).toLowerCase().startsWith("zh") ? COPY_ZH : COPY_EN;
}

/** Calendar day number since 1970-01-01 from a "YYYY-MM-DD" key (DST/TZ invariant). */
function dayNumber(key: string): number {
  const parts = key.split("-");
  const year = Number(parts[0] ?? 1970);
  const month = Number(parts[1] ?? 1);
  const date = Number(parts[2] ?? 1);
  return Math.round(Date.UTC(year, month - 1, date) / DAY_MS);
}

function todayNumber(): number {
  const now = new Date();
  return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
}

/** Local noon for a UTC calendar day number, safe for weekday/month formatting. */
function localDate(day: number): Date {
  const utc = new Date(day * DAY_MS);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), 12);
}

function weekdayOf(day: number): number {
  return new Date(day * DAY_MS).getUTCDay();
}

function dayOfMonthOf(day: number): number {
  return new Date(day * DAY_MS).getUTCDate();
}

/**
 * Compute responsive grid geometry.
 *
 * - Wide (`>=560px`): fits up to 53 full weeks across the available card width.
 * - Narrow (`<560px`): reduces visible week columns automatically so each tile
 *   stays at least `12px` square for comfortable touch targeting.
 */
function computeGeometry(innerWidth: number, narrow: boolean) {
  const available = Math.max(0, innerWidth - LABEL_WIDTH - LABEL_GAP);
  if (narrow) {
    const weeks = Math.max(4, Math.min(MAX_WEEKS, Math.floor(available / MIN_PITCH_NARROW)));
    const pitch = weeks > 0 ? Math.min(MAX_PITCH, Math.max(MIN_PITCH_NARROW, available / weeks)) : MIN_PITCH_NARROW;
    const cell = Math.max(MIN_CELL_NARROW, Math.min(Math.floor(pitch) - 2, Math.round(pitch * 0.8)));
    const gridWidth = Math.max(0, (weeks - 1) * pitch + cell);
    return { pitch, weeks, cell, gridWidth, labelWidth: LABEL_WIDTH, corner: cell >= 12 ? 3 : 2 };
  }

  let weeks: number = MAX_WEEKS;
  let pitch = Math.min(MAX_PITCH, available / MAX_WEEKS);
  if (pitch < MIN_PITCH_WIDE) {
    weeks = Math.max(4, Math.floor(available / MIN_PITCH_WIDE));
    pitch = weeks > 0 ? available / weeks : MIN_PITCH_WIDE;
  }
  const cell = Math.max(6, Math.round(pitch * 0.8));
  const gridWidth = Math.max(0, (weeks - 1) * pitch + cell);
  return { pitch, weeks, cell, gridWidth, labelWidth: LABEL_WIDTH, corner: cell >= 12 ? 3 : 2 };
}

/** Quartile scale over active days; the busiest visible day always takes level 4. */
function levelScale(values: readonly number[]): (value: number) => Level {
  const sorted = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (sorted.length === 0) return () => 0;
  const pick = (quantile: number) => sorted[Math.floor(quantile * (sorted.length - 1))]!;
  const low = pick(0.25);
  const middle = pick(0.5);
  const high = pick(0.75);
  const max = sorted[sorted.length - 1]!;
  return (value) => {
    if (value <= 0) return 0;
    if (value >= max) return 4;
    if (value <= low) return 1;
    if (value <= middle) return 2;
    if (value <= high) return 3;
    return 4;
  };
}

function buildCalendar(data: UsageDaily | null | undefined, weeks: number, locale: string) {
  const today = data ? dayNumber(data.today) : todayNumber();
  const firstWeekday = weekStartsOn(locale);
  const todayRow = (weekdayOf(today) - firstWeekday + 7) % 7;
  const firstDay = today - todayRow - (weeks - 1) * 7;

  const byDay = new Map<number, UsageDaily["days"][number]>();
  for (const entry of data?.days ?? []) {
    byDay.set(dayNumber(entry.date), entry);
  }

  const tokensOn = (day: number): number => {
    const entry = byDay.get(day);
    if (!entry) return 0;
    if (typeof entry.totalTokens === "number" && Number.isFinite(entry.totalTokens)) {
      return entry.totalTokens;
    }
    return entry.input + entry.cached + entry.cacheWrite + entry.output;
  };

  const visibleValues: number[] = [];
  for (let day = firstDay; day <= today; day += 1) {
    visibleValues.push(tokensOn(day));
  }
  const scale = levelScale(visibleValues);

  const columns: Array<Array<DayCell | null>> = [];
  let total = 0;
  let activeDays = 0;
  let busiest: DayCell | null = null;

  for (let column = 0; column < weeks; column += 1) {
    const cells: Array<DayCell | null> = [];
    for (let row = 0; row < 7; row += 1) {
      const day = firstDay + column * 7 + row;
      if (day > today) {
        cells.push(null);
        continue;
      }
      const entry = byDay.get(day);
      const value = tokensOn(day);
      const cell: DayCell = {
        day,
        tokens: value,
        requests: entry?.requests ?? 0,
        cost: entry && entry.pricedRequests > 0 ? entry.cost : null,
        level: scale(value),
      };
      cells.push(cell);
      total += value;
      if (value > 0) activeDays += 1;
      if (value > 0 && (!busiest || value > busiest.tokens)) busiest = cell;
    }
    columns.push(cells);
  }

  // Streak spans full available daily history even when narrow viewports show fewer weeks,
  // and stays alive while today has no activity yet (anchored on yesterday).
  let streak = 0;
  if (data && typeof data.summary?.streak === "number") {
    streak = data.summary.streak;
  } else {
    for (let day = tokensOn(today) > 0 ? today : today - 1; tokensOn(day) > 0; day -= 1) {
      streak += 1;
    }
  }

  const months: Array<{ column: number; label: string }> = [];
  for (let column = 0; column < weeks; column += 1) {
    for (let row = 0; row < 7; row += 1) {
      const day = firstDay + column * 7 + row;
      if (day > today) break;
      if (dayOfMonthOf(day) !== 1) continue;
      const previous = months[months.length - 1];
      if (!previous || column - previous.column >= 3) {
        months.push({ column, label: monthShort(localDate(day), locale) });
      }
      break;
    }
  }
  if ((months[0]?.column ?? weeks) >= 3) {
    months.unshift({ column: 0, label: monthShort(localDate(firstDay + 6), locale) });
  }

  const weekdays = Array.from({ length: 7 }, (_, row) => {
    const day = firstDay + row;
    return [1, 3, 5].includes(weekdayOf(day)) ? weekdayShort(localDate(day), locale) : "";
  });

  return {
    columns,
    months,
    weekdays,
    total,
    activeDays,
    busiest,
    streak,
    average: activeDays > 0 ? total / activeDays : 0,
  };
}

const HeatmapCell = memo(function HeatmapCell({
  index,
  pitch,
  size,
  corner,
  color,
  label,
  selected,
  onEnter,
  onTap,
}: {
  index: number;
  pitch: number;
  size: number;
  corner: number;
  color: string;
  label: string;
  selected: boolean;
  onEnter(index: number): void;
  onTap(index: number): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      focusable={false}
      onHoverIn={() => onEnter(index)}
      onPress={(event) => {
        event.stopPropagation?.();
        onTap(index);
      }}
      style={{ width: pitch, height: pitch }}
    >
      <View style={{ width: size, height: size, borderRadius: corner, backgroundColor: color }} />
    </Pressable>
  );
});

function SummaryFigure({
  colors,
  label,
  value,
  detail,
}: {
  colors: Colors;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
        {label}
      </Text>
      <Text
        numberOfLines={1}
        style={{ ...font.small, ...tabular, color: colors.foreground, fontWeight: "600" }}
      >
        {value}
        {detail ? (
          <Text style={{ fontWeight: "400", ...tabular, color: colors.foregroundMuted }}>
            {`  ${detail}`}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}

export interface ConsoleHeatmapProps {
  /** Daily rollup payload from `dsh.usage.daily`. */
  data: UsageDaily | null | undefined;
  /** Active display currency (`"USD"` or `"CNY"`). */
  currency: Currency;
  /** Active display locale (`"zh-CN"`, `"en"`, etc.). */
  locale: string;
  /** Paseo theme colors. */
  colors: Colors;
  /** Optional explicit width; falls back to `onLayout` and `useWindowDimensions()`. */
  width?: number;
  /** Dim slightly during filter/currency transitions without flashing empty. */
  dimmed?: boolean;
  /** Optional error text shown inside the card. */
  error?: string | null;
}

export function ConsoleHeatmap({
  data,
  currency,
  locale,
  colors,
  width: providedWidth,
  dimmed = false,
  error = null,
}: ConsoleHeatmapProps) {
  const windowDims = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const copy = useMemo(() => copyFor(locale), [locale]);

  const effectiveWidth =
    typeof providedWidth === "number" && providedWidth > 0
      ? providedWidth
      : measuredWidth > 0
        ? measuredWidth
        : Math.max(280, windowDims.width - space.lg * 2);

  const narrow = effectiveWidth < NARROW_BREAKPOINT;
  const padding = narrow ? space.md : space.lg;
  const innerWidth = Math.max(0, effectiveWidth - padding * 2 - 2);
  const { pitch, weeks, cell, gridWidth, labelWidth, corner } = useMemo(
    () => computeGeometry(innerWidth, narrow),
    [innerWidth, narrow],
  );

  const calendar = useMemo(() => buildCalendar(data, weeks, locale), [data, weeks, locale]);

  const labels = useMemo(
    () =>
      calendar.columns.map((cells) =>
        cells.map((day) => {
          if (!day) return "";
          const dateText = longDate(localDate(day.day), locale);
          if (day.tokens <= 0 && day.requests <= 0) {
            return `${dateText}: ${copy.none}`;
          }
          const costText = day.cost !== null ? moneyFixed(day.cost, currency, locale) : "—";
          return `${dateText}: ${copy.tokensReadout(tokens(day.tokens))}, ${copy.requestsReadout(
            day.requests,
            integer(day.requests, locale),
          )}, ${copy.costLabel} ${costText}`;
        }),
      ),
    [calendar.columns, copy, currency, locale],
  );

  const [active, setActive] = useState<number | null>(null);
  const pointerActive = useRef(false);

  const handleEnter = useCallback(
    (index: number) => {
      if (narrow) return;
      pointerActive.current = true;
      setActive(index);
    },
    [narrow],
  );

  const handleTap = useCallback(
    (index: number) => {
      if (narrow) {
        pointerActive.current = false;
        setActive((current) => (current === index ? null : index));
        return;
      }
      setActive((current) => (pointerActive.current ? index : current === index ? null : index));
    },
    [narrow],
  );

  const handleLeave = useCallback(() => {
    if (narrow) return;
    pointerActive.current = false;
    setActive(null);
  }, [narrow]);

  // Reset active index when column count or narrow mode changes so indices never drift across days.
  useEffect(() => {
    setActive(null);
  }, [weeks, narrow]);

  const levelColor = (level: Level): string =>
    level === 0 ? tint(colors.foreground, 0.07) : tint(colors.accent, LEVEL_ALPHA[level]);

  const gridHeight = MONTH_ROW + 7 * pitch;
  const activeColumn = active === null ? -1 : Math.floor(active / 7);
  const activeRow = active === null ? -1 : active % 7;
  const activeCell =
    active === null ? null : (calendar.columns[activeColumn]?.[activeRow] ?? null);

  const gridLeft = labelWidth + LABEL_GAP;
  const blockWidth = gridLeft + gridWidth;
  const tooltipWidth = Math.min(TOOLTIP_WIDTH, Math.max(140, blockWidth));
  const tooltipLeft = Math.min(
    Math.max(gridLeft + activeColumn * pitch + cell / 2 - tooltipWidth / 2, 0),
    Math.max(0, blockWidth - tooltipWidth),
  );
  const tooltipBelow = activeRow <= 2;

  const heading = data
    ? weeks >= 52
      ? copy.totalYear(tokens(calendar.total))
      : narrow
        ? copy.totalWeeksCompact(tokens(calendar.total), weeks)
        : copy.totalWeeks(tokens(calendar.total), weeks)
    : copy.title;

  const activeCostText =
    activeCell && activeCell.cost !== null ? moneyFixed(activeCell.cost, currency, locale) : "—";

  const swatchSize = narrow ? Math.min(cell, 10) : Math.min(cell, 12);

  const legend = (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0 }}
      accessibilityLabel={copy.legend}
    >
      <Text style={{ ...font.caption, color: colors.foregroundMuted, marginRight: 2 }}>
        {copy.less}
      </Text>
      {LEVELS.map((level) => (
        <View
          key={level}
          style={{
            width: swatchSize,
            height: swatchSize,
            borderRadius: corner,
            backgroundColor: levelColor(level),
          }}
        />
      ))}
      <Text style={{ ...font.caption, color: colors.foregroundMuted, marginLeft: 2 }}>
        {copy.more}
      </Text>
    </View>
  );

  return (
    <View
      onLayout={
        providedWidth === undefined || providedWidth <= 0
          ? (event) => {
              const next = Math.round(event.nativeEvent.layout.width);
              setMeasuredWidth((prev) => (Math.abs(prev - next) <= 1 ? prev : next));
            }
          : undefined
      }
      style={{ width: "100%", zIndex: 2 }}
    >
      <Card colors={colors} style={{ padding, gap: space.md, opacity: dimmed ? 0.6 : 1 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{ ...font.heading, ...tabular, color: colors.foreground, flexShrink: 1 }}
          >
            {heading}
          </Text>
          {legend}
        </View>

        {error ? (
          <Text style={{ ...font.small, color: colors.statusDanger }}>{error}</Text>
        ) : null}

        {/* Stacked above the summary row so the floating wide-screen tooltip never clips underneath. */}
        <View style={{ flexDirection: "row", zIndex: 2 }}>
          <View style={{ width: labelWidth, marginRight: LABEL_GAP, height: gridHeight }}>
            {calendar.weekdays.map((label, row) =>
              label ? (
                <Text
                  key={row}
                  numberOfLines={1}
                  style={{
                    position: "absolute",
                    right: 0,
                    top: MONTH_ROW + row * pitch + (cell - 14) / 2,
                    fontSize: 11,
                    lineHeight: 14,
                    color: colors.foregroundMuted,
                  }}
                >
                  {label}
                </Text>
              ) : null,
            )}
          </View>

          <View style={{ width: gridWidth, height: gridHeight }}>
            {calendar.months.map((month) => (
              <Text
                key={`${month.column}-${month.label}`}
                numberOfLines={1}
                style={{
                  position: "absolute",
                  left: month.column * pitch,
                  top: 0,
                  fontSize: 11,
                  lineHeight: 14,
                  color: colors.foregroundMuted,
                }}
              >
                {month.label}
              </Text>
            ))}

            <Pressable
              accessible={false}
              focusable={false}
              onHoverOut={handleLeave}
              onPress={() => setActive(null)}
              style={{ position: "absolute", left: 0, top: MONTH_ROW, flexDirection: "row" }}
            >
              {calendar.columns.map((cells, column) => (
                <View key={column} style={{ width: pitch }}>
                  {cells.map((day, row) =>
                    day ? (
                      <HeatmapCell
                        key={row}
                        index={column * 7 + row}
                        pitch={pitch}
                        size={cell}
                        corner={corner}
                        color={levelColor(day.level)}
                        label={labels[column]?.[row] ?? ""}
                        selected={active === column * 7 + row}
                        onEnter={handleEnter}
                        onTap={handleTap}
                      />
                    ) : (
                      <View key={row} style={{ width: pitch, height: pitch }} />
                    ),
                  )}
                </View>
              ))}
            </Pressable>

            {activeCell ? (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: activeColumn * pitch - 2,
                  top: MONTH_ROW + activeRow * pitch - 2,
                  width: cell + 4,
                  height: cell + 4,
                  borderRadius: corner + 2,
                  borderWidth: 1.5,
                  borderColor: colors.foreground,
                }}
              />
            ) : null}
          </View>

          {!narrow && activeCell ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                zIndex: 10,
                left: tooltipLeft,
                width: tooltipWidth,
                ...(tooltipBelow
                  ? { top: MONTH_ROW + activeRow * pitch + cell + 6 }
                  : { bottom: gridHeight - (MONTH_ROW + activeRow * pitch) + 6 }),
                paddingHorizontal: space.sm + 2,
                paddingVertical: space.xs + 2,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface0,
                shadowColor: "#000",
                shadowOpacity: 0.14,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 4 },
                elevation: 4,
                gap: 2,
              }}
            >
              <Text
                numberOfLines={1}
                style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}
              >
                {longDate(localDate(activeCell.day), locale)}
              </Text>
              <Text
                numberOfLines={1}
                style={{ ...font.small, ...tabular, fontWeight: "600", color: colors.foreground }}
              >
                {activeCell.tokens > 0
                  ? copy.tokensReadout(tokens(activeCell.tokens))
                  : copy.none}
              </Text>
              <Text
                numberOfLines={1}
                style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}
              >
                {`${copy.requestsReadout(
                  activeCell.requests,
                  integer(activeCell.requests, locale),
                )} · ${copy.costLabel} ${activeCostText}`}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Narrow screens: subtle tap hint when idle; accent-tinted detail card when a day is selected. */}
        {narrow ? (
          activeCell ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: space.sm,
                paddingHorizontal: space.sm + 2,
                paddingVertical: space.xs + 2,
                borderRadius: radius.md,
                backgroundColor: tint(colors.accent, 0.08),
                borderWidth: 1,
                borderColor: tint(colors.accent, 0.25),
              }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, flexWrap: "wrap" }}>
                  <Text
                    numberOfLines={1}
                    style={{ ...font.caption, ...tabular, fontWeight: "600", color: colors.foreground }}
                  >
                    {longDate(localDate(activeCell.day), locale)}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{ ...font.caption, ...tabular, fontWeight: "600", color: colors.accent }}
                  >
                    {activeCell.tokens > 0
                      ? copy.tokensReadout(tokens(activeCell.tokens))
                      : copy.none}
                  </Text>
                </View>
                <Text
                  numberOfLines={1}
                  style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}
                >
                  {`${copy.requestsReadout(
                    activeCell.requests,
                    integer(activeCell.requests, locale),
                  )} · ${copy.costLabel} ${activeCostText}`}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.dismissSelection}
                hitSlop={8}
                onPress={() => setActive(null)}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: radius.pill,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: tint(colors.foreground, 0.06),
                }}
              >
                <Icon name="X" size={12} color={colors.foregroundMuted} />
              </Pressable>
            </View>
          ) : (
            <Text
              numberOfLines={1}
              style={{
                fontSize: 11.5,
                lineHeight: 15,
                color: colors.foregroundMuted,
              }}
            >
              {copy.tapHint}
            </Text>
          )
        ) : null}

        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: tint(colors.border, 0.7),
            paddingTop: space.sm + 2,
            gap: space.md,
          }}
        >
          {narrow ? (
            <>
              <View style={{ flexDirection: "row", gap: space.md }}>
                <SummaryFigure
                  colors={colors}
                  label={copy.activeDays}
                  value={integer(calendar.activeDays, locale)}
                />
                <SummaryFigure
                  colors={colors}
                  label={copy.peakDay}
                  value={calendar.busiest ? tokens(calendar.busiest.tokens) : "—"}
                  detail={calendar.busiest ? dayLabel(localDate(calendar.busiest.day), locale) : undefined}
                />
              </View>
              <View style={{ flexDirection: "row", gap: space.md }}>
                <SummaryFigure
                  colors={colors}
                  label={copy.activeDailyAvg}
                  value={calendar.activeDays > 0 ? tokens(Math.round(calendar.average)) : "—"}
                />
                <SummaryFigure
                  colors={colors}
                  label={copy.streak}
                  value={copy.daysCount(calendar.streak, integer(calendar.streak, locale))}
                />
              </View>
            </>
          ) : (
            <View style={{ flexDirection: "row", gap: space.lg }}>
              <SummaryFigure
                colors={colors}
                label={copy.activeDays}
                value={integer(calendar.activeDays, locale)}
              />
              <SummaryFigure
                colors={colors}
                label={copy.peakDay}
                value={calendar.busiest ? tokens(calendar.busiest.tokens) : "—"}
                detail={calendar.busiest ? dayLabel(localDate(calendar.busiest.day), locale) : undefined}
              />
              <SummaryFigure
                colors={colors}
                label={copy.activeDailyAvg}
                value={calendar.activeDays > 0 ? tokens(Math.round(calendar.average)) : "—"}
              />
              <SummaryFigure
                colors={colors}
                label={copy.streak}
                value={copy.daysCount(calendar.streak, integer(calendar.streak, locale))}
              />
            </View>
          )}
        </View>
      </Card>
    </View>
  );
}
