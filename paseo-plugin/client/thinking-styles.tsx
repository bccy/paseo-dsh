/**
 * Five selectable visual styles for `InlineThinking`, configurable in Display
 * settings (`timelineStyleSettings.thinkingStyle`):
 *
 * - `rail`      (Plan A · 呼吸竖轨): 2px breathing left rail + 3-line streaming peek + structured prose
 * - `silk`      (Plan B · 丝绸单行): strict single-line subtitle swap + pill badge + copy/collapse toolbar
 * - `capsule`   (Plan C · 柔雾思考舱): subtle `surface1` capsule + gliding progress bar + collapse footer
 * - `stepper`   (Plan D · 思维脉络): vertical step-node timeline parsed from headings/paragraphs
 * - `editorial` (Plan E · 静谧引用): quiet marginalia with dashed quote rail + 2-line mist peek
 *
 * Every colour derives from Paseo's theme tokens (`TokenColors` + `withAlpha`)
 * with zero hardcoded hex values and zero third-party dependencies. Expanded
 * scroll bodies keep `<ScrollView>` outside `<Pressable>` so scrolling never
 * fights tap-to-collapse (`shouldCollapseOnBodyPress`).
 *
 * @module dsh-paseo/client/thinking-styles
 */
import { copyText } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { ThinkingStyleChoice } from "../shared/settings";
import type { UiText } from "./locale";
import { SCROLL_BOX_TEST_ID, shouldCollapseOnBodyPress } from "./row-entrance";
import { RowStatusIcon, resolveThinkingIconStatus } from "./row-status-icon";
import { TextShimmer } from "./text-shimmer";
import {
  BreathingDot,
  BreathingRail,
  GlideProgressBar,
  SilkSubtitleSlide,
  SteppedFadeVeil,
} from "./thinking-motion";
import {
  formatThinkingDuration,
  parseInlineRuns,
  parseThinkingSections,
  thinkingHeadline,
  thinkingPeekTail,
  thinkingSubtitleKey,
  type ThinkingSection,
} from "./thinking-text";
import {
  CODE_FONT_FAMILY,
  HAIRLINE,
  ROW_FONT_SIZE,
  ROW_GAP,
  ROW_LINE_HEIGHT,
  SEP_RADIUS,
  SEP_SIZE,
  isLightSurface,
  withAlpha,
  type TokenColors,
} from "./tokens";

export type EnhancedThinkingStyle = Exclude<ThinkingStyleChoice, "classic">;

export const THINKING_PEEK_TEST_ID = "dsh-thinking-peek";
export const THINKING_COPY_TEST_ID = "dsh-thinking-copy";
export const THINKING_STEPS_TEST_ID = "dsh-thinking-steps";

export function thinkingStyleTestId(variant: EnhancedThinkingStyle): string {
  return `dsh-thinking-style-${variant}`;
}

export interface EnhancedThinkingProps {
  variant: EnhancedThinkingStyle;
  text: string;
  growing: boolean;
  open: boolean;
  onToggle: () => void;
  onCollapse: (event?: unknown) => void;
  colors: TokenColors;
  compact: boolean;
  iconUri: string;
  iconSize: number;
  rowMarginY: number;
  rowPaddingY: number;
  rowMinHeight: number;
  rowGap: number;
  expandedMaxHeight: number;
  copy: UiText;
}

const DURATION_TICK_MS = 200;
const COPY_FEEDBACK_MS = 1000;

/**
 * Observe live elapsed duration strictly when the row is seen streaming.
 *
 * Historic / replayed rows that mount already settled keep `0` so the UI never
 * invents a fake elapsed time.
 */
function useThinkingDuration(growing: boolean): number {
  const startedAtRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (growing) {
      if (startedAtRef.current === null) {
        startedAtRef.current = Date.now();
      }
      const tick = () => {
        if (startedAtRef.current !== null) {
          setElapsedMs(Math.max(0, Date.now() - startedAtRef.current));
        }
      };
      tick();
      const id = setInterval(tick, DURATION_TICK_MS);
      return () => {
        clearInterval(id);
      };
    }
    if (startedAtRef.current !== null) {
      setElapsedMs(Math.max(0, Date.now() - startedAtRef.current));
    }
    return undefined;
  }, [growing]);

  return elapsedMs;
}

/** Copy helper with cleanup-safe transient feedback for the Silk toolbar. */
function useThinkingCopy(text: string): { copied: boolean; onCopy: () => void } {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const onCopy = useCallback(() => {
    if (copied) return;
    void Promise.resolve(copyText(text)).then(
      () => {
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          setCopied(false);
        }, COPY_FEEDBACK_MS);
      },
      () => {},
    );
  }, [copied, text]);

  return { copied, onCopy };
}

function hairlineWidth(): number {
  const w = StyleSheet?.hairlineWidth;
  return typeof w === "number" && w > 0 ? w : HAIRLINE;
}

/** Small geometric directional chevron that rotates 90° when expanded. */
function ThinkingChevron({ open, color }: { open: boolean; color: string }): ReactElement {
  return (
    <View
      pointerEvents="none"
      style={{
        width: 14,
        height: 14,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ rotate: open ? "90deg" : "0deg" }],
      }}
    >
      <Text
        style={{
          color,
          opacity: 0.6,
          fontSize: 14,
          lineHeight: 15,
          includeFontPadding: false,
        }}
      >
        ›
      </Text>
    </View>
  );
}

/** Inline formatted runs (`code` + **bold** + plain text) rendered as nested `<Text>`. */
function InlineFormattedText({
  text,
  baseStyle,
  boldStyle,
  codeStyle,
  selectable,
  numberOfLines,
}: {
  text: string;
  baseStyle: TextStyle;
  boldStyle: TextStyle;
  codeStyle: TextStyle;
  selectable?: boolean;
  numberOfLines?: number;
}): ReactElement {
  const runs = parseInlineRuns(text);
  return (
    <Text style={baseStyle} selectable={selectable} numberOfLines={numberOfLines}>
      {runs.map((run, index) => {
        if (run.kind === "code") {
          return (
            <Text key={index} style={codeStyle}>
              {run.text}
            </Text>
          );
        }
        if (run.kind === "bold") {
          return (
            <Text key={index} style={boldStyle}>
              {run.text}
            </Text>
          );
        }
        return run.text;
      })}
    </Text>
  );
}

/** Structured multi-section prose renderer shared by Rail, Silk, Capsule, and Editorial. */
function ThinkingProse({
  sections,
  rawText,
  running,
  colors,
  compact,
  editorial = false,
}: {
  sections: readonly ThinkingSection[];
  rawText: string;
  running: boolean;
  colors: TokenColors;
  compact: boolean;
  editorial?: boolean;
}): ReactElement {
  const light = isLightSurface(colors.surface0);
  const bodySize = compact ? 12.5 : 13;
  const bodyLineHeight = editorial ? (compact ? 21 : 22) : (compact ? 19.5 : 21);

  const headingStyle: TextStyle = {
    color: colors.foreground,
    fontSize: compact ? 12.5 : 13,
    lineHeight: compact ? 18 : 19,
    fontWeight: "600",
    marginBottom: 2,
  };
  const bodyStyle: TextStyle = {
    color: colors.foregroundMuted,
    fontSize: bodySize,
    lineHeight: bodyLineHeight,
    opacity: editorial ? 0.86 : 0.92,
  };
  const boldStyle: TextStyle = {
    color: colors.foreground,
    fontWeight: "600",
  };
  const codeStyle: TextStyle = {
    fontFamily: CODE_FONT_FAMILY,
    fontSize: bodySize - 1,
    color: colors.foreground,
    backgroundColor: withAlpha(colors.foreground, light ? 0.06 : 0.08),
  };

  if (sections.length === 0) {
    return (
      <Text style={bodyStyle} selectable>
        {rawText}
      </Text>
    );
  }

  return (
    <View style={{ gap: 7 }}>
      {sections.map((section, index) => {
        const isLast = index === sections.length - 1;
        return (
          <View key={index} style={{ gap: 2 }}>
            {section.explicitTitle ? (
              <Text style={headingStyle} selectable>
                {section.title}
              </Text>
            ) : null}
            {section.body.length > 0 ? (
              <InlineFormattedText
                text={section.body}
                baseStyle={bodyStyle}
                boldStyle={boldStyle}
                codeStyle={codeStyle}
                selectable
              />
            ) : null}
            {running && isLast ? (
              <View style={{ paddingTop: 2 }}>
                <BreathingDot color={colors.accent} size={5} />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** Combine observed duration and section count honestly (never fabricating duration). */
function formatMetaSummary(
  durationText: string,
  sectionCount: number,
  copy: UiText,
  mode: "section" | "step",
  running: boolean,
): string {
  const countLabel =
    sectionCount <= 0
      ? ""
      : mode === "step"
        ? running
          ? copy.thinkingUi.runningStep(sectionCount)
          : copy.thinkingUi.stepCount(sectionCount)
        : copy.thinkingUi.sectionCount(sectionCount);

  if (countLabel && durationText) return `${countLabel} · ${durationText}`;
  return countLabel || durationText;
}

/**
 * Render one of the five enhanced thinking-row styles.
 */
export function EnhancedThinkingView({
  variant,
  text,
  growing,
  open,
  onToggle,
  onCollapse,
  colors,
  compact,
  iconUri,
  iconSize,
  rowMarginY,
  rowPaddingY,
  rowMinHeight,
  rowGap,
  expandedMaxHeight,
  copy,
}: EnhancedThinkingProps): ReactElement {
  const elapsedMs = useThinkingDuration(growing);
  const { copied, onCopy } = useThinkingCopy(text);
  const sections = useMemo(() => parseThinkingSections(text), [text]);
  const headline = useMemo(() => {
    const raw = thinkingHeadline(text, growing, sections);
    return raw.length > 0 ? raw : growing ? copy.thinkingUi.organizing : "";
  }, [text, growing, sections, copy.thinkingUi.organizing]);
  const subtitleKey = useMemo(
    () => thinkingSubtitleKey(sections, growing),
    [sections, growing],
  );

  const durationText = formatThinkingDuration(elapsedMs);
  const sectionCount = sections.length;
  const labelText = growing
    ? copy.thinkingUi.labels[variant].running
    : copy.thinkingUi.labels[variant].done;
  const rowLineHeight = Math.min(ROW_LINE_HEIGHT, rowMinHeight);
  const hair = hairlineWidth();
  const light = isLightSurface(colors.surface0);

  const rootStyle: ViewStyle = {
    gap: ROW_GAP,
    marginVertical: rowMarginY,
    paddingVertical: rowPaddingY,
  };

  const sepStyle: ViewStyle = {
    width: SEP_SIZE,
    height: SEP_SIZE,
    borderRadius: SEP_RADIUS,
    backgroundColor: colors.foregroundMuted,
    opacity: 0.55,
    flexShrink: 0,
  };

  const metaStyle: TextStyle = {
    fontSize: 11,
    lineHeight: rowLineHeight,
    color: colors.foregroundMuted,
    opacity: 0.68,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  };

  const renderIcon = (backdropColor?: string): ReactElement => (
    <RowStatusIcon
      status={resolveThinkingIconStatus(growing)}
      size={iconSize}
      colors={colors}
      spinBase
      backdropColor={backdropColor}
    >
      <Image
        source={{ uri: iconUri }}
        style={{ width: iconSize, height: iconSize }}
        tintColor={colors.foregroundMuted}
      />
    </RowStatusIcon>
  );

  const collapseFromPress = (event?: unknown): void => {
    if (shouldCollapseOnBodyPress(event)) onCollapse(event);
  };

  /* ------------------------------------------------------------------------ */
  /* Plan A · Breathing Rail                                                  */
  /* ------------------------------------------------------------------------ */
  if (variant === "rail") {
    const metaText = formatMetaSummary(durationText, sectionCount, copy, "section", growing);
    const peekText = growing && !open ? thinkingPeekTail(text, compact ? 96 : 168) : "";
    const showSummary = !open && headline.length > 0;
    const headRowStyle: ViewStyle = {
      flexDirection: "row",
      alignItems: "center",
      gap: rowGap,
      minHeight: rowMinHeight,
    };
    const shimmerRowStyle: ViewStyle = {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: rowGap,
    };
    const labelStyle: TextStyle = {
      fontSize: ROW_FONT_SIZE,
      lineHeight: rowLineHeight,
      fontWeight: "500",
      color: growing ? colors.foreground : colors.foregroundMuted,
      flexShrink: 0,
    };
    const summaryStyle: TextStyle = {
      flex: 1,
      minWidth: 0,
      fontSize: ROW_FONT_SIZE,
      lineHeight: rowLineHeight,
      color: colors.foregroundMuted,
      opacity: 0.82,
    };

    return (
      <View testID={thinkingStyleTestId("rail")} style={rootStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? copy.collapseThinking : copy.expandThinking}
          onPress={onToggle}
          style={headRowStyle}
        >
          {renderIcon()}
          <TextShimmer
            active={growing && !open}
            contentStyle={shimmerRowStyle}
            highlightColor={colors.foreground}
            surfaceColor={colors.surface0}
          >
            {(color) => (
              <>
                <Text style={[labelStyle, color === null ? null : { color }]}>{labelText}</Text>
                {showSummary ? <View style={sepStyle} /> : null}
                {showSummary ? (
                  <Text
                    style={[summaryStyle, color === null ? null : { color }]}
                    numberOfLines={1}
                  >
                    {headline}
                  </Text>
                ) : null}
              </>
            )}
          </TextShimmer>
          {metaText.length > 0 ? <Text style={metaStyle}>{metaText}</Text> : null}
          <ThinkingChevron open={open} color={colors.foregroundMuted} />
        </Pressable>

        {growing && !open && peekText.length > 0 ? (
          <BreathingRail active accentColor={colors.accent} idleColor={colors.border}>
            <Pressable
              testID={THINKING_PEEK_TEST_ID}
              accessibilityRole="button"
              accessibilityLabel={copy.expandThinking}
              onPress={onToggle}
              style={{
                position: "relative",
                maxHeight: 72,
                overflow: "hidden",
                paddingVertical: 1,
              }}
            >
              <View style={{ minHeight: 36, justifyContent: "flex-end" }}>
                <Text
                  style={{
                    fontSize: 12.5,
                    lineHeight: 20,
                    color: colors.foregroundMuted,
                  }}
                  numberOfLines={3}
                >
                  {peekText}
                </Text>
                <View style={{ paddingTop: 3 }}>
                  <BreathingDot color={colors.accent} size={4.5} />
                </View>
              </View>
              <SteppedFadeVeil backgroundColor={colors.surface0} height={18} />
            </Pressable>
          </BreathingRail>
        ) : null}

        {open ? (
          <BreathingRail active={growing} accentColor={colors.accent} idleColor={colors.border}>
            <ScrollView
              style={{ maxHeight: expandedMaxHeight }}
              nestedScrollEnabled
              testID={SCROLL_BOX_TEST_ID}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.collapseThinking}
                onPress={collapseFromPress}
                style={{ paddingVertical: 2 }}
              >
                <ThinkingProse
                  sections={sections}
                  rawText={text}
                  running={growing}
                  colors={colors}
                  compact={compact}
                />
              </Pressable>
            </ScrollView>
          </BreathingRail>
        ) : null}
      </View>
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Plan B · Silk Subtitle (strict single line, zero height jump)            */
  /* ------------------------------------------------------------------------ */
  if (variant === "silk") {
    const pillText = formatMetaSummary(durationText, sectionCount, copy, "section", growing);
    const subMetaParts = [
      sectionCount > 0 ? copy.thinkingUi.sectionCount(sectionCount) : "",
      durationText,
    ].filter((part) => part.length > 0);
    const headRowStyle: ViewStyle = {
      flexDirection: "row",
      alignItems: "center",
      gap: rowGap,
      minHeight: Math.max(rowMinHeight, 26),
    };
    const shimmerRowStyle: ViewStyle = {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: rowGap,
    };
    const labelStyle: TextStyle = {
      fontSize: ROW_FONT_SIZE,
      lineHeight: rowLineHeight,
      fontWeight: "500",
      color: growing ? colors.foreground : colors.foregroundMuted,
      flexShrink: 0,
    };
    const pillBoxStyle: ViewStyle = {
      paddingHorizontal: 7,
      paddingVertical: 1,
      borderRadius: 999,
      backgroundColor: growing ? withAlpha(colors.accent, light ? 0.12 : 0.16) : colors.surface1,
      flexShrink: 0,
    };
    const pillLabelStyle: TextStyle = {
      fontSize: 10.5,
      lineHeight: 16,
      fontVariant: ["tabular-nums"],
      color: growing ? colors.accent : colors.foregroundMuted,
    };
    const showTicker = !open && headline.length > 0;

    return (
      <View testID={thinkingStyleTestId("silk")} style={rootStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? copy.collapseThinking : copy.expandThinking}
          onPress={onToggle}
          style={headRowStyle}
        >
          {renderIcon()}
          <TextShimmer
            active={growing && !open}
            contentStyle={shimmerRowStyle}
            highlightColor={colors.foreground}
            surfaceColor={colors.surface0}
          >
            {(color) => (
              <>
                <Text style={[labelStyle, color === null ? null : { color }]}>{labelText}</Text>
                {showTicker ? <View style={sepStyle} /> : null}
                {showTicker ? (
                  <SilkSubtitleSlide
                    slideKey={subtitleKey}
                    active={growing && color === null}
                    style={{ flex: 1, minWidth: 0, overflow: "hidden" }}
                  >
                    <Text
                      style={{
                        fontSize: ROW_FONT_SIZE,
                        lineHeight: rowLineHeight,
                        color: color ?? colors.foregroundMuted,
                        opacity: color === null ? 0.85 : 1,
                      }}
                      numberOfLines={1}
                    >
                      {headline}
                    </Text>
                  </SilkSubtitleSlide>
                ) : null}
              </>
            )}
          </TextShimmer>
          {pillText.length > 0 ? (
            <View style={pillBoxStyle}>
              <Text style={pillLabelStyle}>{pillText}</Text>
            </View>
          ) : null}
          <ThinkingChevron open={open} color={colors.foregroundMuted} />
        </Pressable>

        {open ? (
          <View
            style={{
              marginLeft: 7,
              paddingLeft: 12,
              paddingTop: 4,
              paddingBottom: 2,
              borderLeftWidth: 2,
              borderLeftColor: colors.border,
              gap: 6,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingBottom: 5,
                borderBottomWidth: hair,
                borderBottomColor: colors.border,
                gap: 8,
              }}
            >
              <Text style={{ fontSize: 11, color: colors.foregroundMuted, opacity: 0.72 }}>
                {subMetaParts.join(" · ")}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Pressable
                  testID={THINKING_COPY_TEST_ID}
                  accessibilityRole="button"
                  accessibilityLabel={copied ? copy.thinkingUi.copied : copy.thinkingUi.copy}
                  onPress={onCopy}
                  style={{ paddingHorizontal: 4, paddingVertical: 2 }}
                >
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: "500",
                      color: copied ? colors.statusSuccess : colors.foregroundMuted,
                    }}
                  >
                    {copied ? copy.thinkingUi.copied : copy.thinkingUi.copy}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.collapseThinking}
                  onPress={() => onCollapse()}
                  style={{ paddingHorizontal: 4, paddingVertical: 2 }}
                >
                  <Text style={{ fontSize: 11, fontWeight: "500", color: colors.foregroundMuted }}>
                    {copy.thinkingUi.collapse}
                  </Text>
                </Pressable>
              </View>
            </View>

            <ScrollView
              style={{ maxHeight: expandedMaxHeight }}
              nestedScrollEnabled
              testID={SCROLL_BOX_TEST_ID}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.collapseThinking}
                onPress={collapseFromPress}
              >
                <ThinkingProse
                  sections={sections}
                  rawText={text}
                  running={growing}
                  colors={colors}
                  compact={compact}
                />
              </Pressable>
            </ScrollView>
          </View>
        ) : null}
      </View>
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Plan C · Soft Mist Capsule                                               */
  /* ------------------------------------------------------------------------ */
  if (variant === "capsule") {
    const metaText = formatMetaSummary(durationText, sectionCount, copy, "section", growing);
    const subMetaParts = [
      sectionCount > 0 ? copy.thinkingUi.sectionCount(sectionCount) : "",
      durationText,
    ].filter((part) => part.length > 0);
    const peekText = growing && !open ? thinkingPeekTail(text, compact ? 105 : 175) : "";
    const showSummary = !open && headline.length > 0;
    const shimmerRowStyle: ViewStyle = {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: rowGap,
    };

    return (
      <View testID={thinkingStyleTestId("capsule")} style={rootStyle}>
        <View
          style={{
            backgroundColor: colors.surface1,
            borderWidth: hair,
            borderColor: growing ? withAlpha(colors.accent, 0.42) : colors.border,
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={open ? copy.collapseThinking : copy.expandThinking}
            onPress={onToggle}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: rowGap,
              paddingHorizontal: 10,
              paddingVertical: 7,
              minHeight: Math.max(rowMinHeight + 8, 34),
            }}
          >
            {renderIcon(colors.surface1)}
            <TextShimmer
              active={growing && !open}
              contentStyle={shimmerRowStyle}
              highlightColor={colors.foreground}
              surfaceColor={colors.surface1}
            >
              {(color) => (
                <>
                  <Text
                    style={{
                      fontSize: 12.5,
                      lineHeight: 18,
                      fontWeight: "600",
                      color: color ?? colors.foreground,
                      flexShrink: 0,
                    }}
                  >
                    {labelText}
                  </Text>
                  {showSummary ? <View style={sepStyle} /> : null}
                  {showSummary ? (
                    <Text
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12.5,
                        lineHeight: 18,
                        color: color ?? colors.foregroundMuted,
                      }}
                      numberOfLines={1}
                    >
                      {headline}
                    </Text>
                  ) : null}
                </>
              )}
            </TextShimmer>
            {metaText.length > 0 ? <Text style={metaStyle}>{metaText}</Text> : null}
            <ThinkingChevron open={open} color={colors.foregroundMuted} />
          </Pressable>

          {growing ? (
            <GlideProgressBar accentColor={colors.accent} trackColor={colors.border} />
          ) : null}

          {growing && !open && peekText.length > 0 ? (
            <Pressable
              testID={THINKING_PEEK_TEST_ID}
              accessibilityRole="button"
              accessibilityLabel={copy.expandThinking}
              onPress={onToggle}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderTopWidth: hair,
                borderTopColor: colors.border,
              }}
            >
              <View style={{ position: "relative", maxHeight: 72, overflow: "hidden" }}>
                <Text
                  style={{
                    fontSize: 12.5,
                    lineHeight: 20,
                    color: colors.foregroundMuted,
                  }}
                  numberOfLines={3}
                >
                  {peekText}
                </Text>
                <View style={{ paddingTop: 3 }}>
                  <BreathingDot color={colors.accent} size={4.5} />
                </View>
                <SteppedFadeVeil backgroundColor={colors.surface1} height={15} />
              </View>
            </Pressable>
          ) : null}

          {open ? (
            <View
              style={{
                paddingHorizontal: 12,
                paddingTop: 8,
                paddingBottom: 9,
                borderTopWidth: hair,
                borderTopColor: colors.border,
                gap: 8,
              }}
            >
              <ScrollView
                style={{ maxHeight: expandedMaxHeight }}
                nestedScrollEnabled
                testID={SCROLL_BOX_TEST_ID}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.collapseThinking}
                  onPress={collapseFromPress}
                >
                  <ThinkingProse
                    sections={sections}
                    rawText={text}
                    running={growing}
                    colors={colors}
                    compact={compact}
                  />
                </Pressable>
              </ScrollView>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingTop: 6,
                  borderTopWidth: hair,
                  borderTopColor: colors.border,
                }}
              >
                <Text style={{ fontSize: 11, color: colors.foregroundMuted, opacity: 0.72 }}>
                  {subMetaParts.join(" · ")}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.collapseThinking}
                  onPress={() => onCollapse()}
                  style={{ paddingHorizontal: 4, paddingVertical: 2 }}
                >
                  <Text style={{ fontSize: 11, color: colors.foregroundMuted }}>
                    {`${copy.thinkingUi.tapToCollapse} ▴`}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Plan D · Thought Stepper Timeline                                        */
  /* ------------------------------------------------------------------------ */
  if (variant === "stepper") {
    const badgeText = formatMetaSummary(durationText, sectionCount, copy, "step", growing);
    const showHeadSummary = !open && !growing && headline.length > 0;
    const showSteps = (open || growing) && sections.length > 0;
    const bodySize = compact ? 12 : 12.5;
    const bodyStyle: TextStyle = {
      fontSize: bodySize,
      lineHeight: compact ? 18.5 : 20,
      color: colors.foregroundMuted,
    };
    const boldStyle: TextStyle = {
      color: colors.foreground,
      fontWeight: "600",
    };
    const codeStyle: TextStyle = {
      fontFamily: CODE_FONT_FAMILY,
      fontSize: bodySize - 1,
      color: colors.foreground,
      backgroundColor: withAlpha(colors.foreground, light ? 0.06 : 0.08),
    };
    const shimmerRowStyle: ViewStyle = {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: rowGap,
    };

    const renderStepList = (previewMode: boolean): ReactElement => {
      const visibleSections = previewMode ? sections.slice(-2) : sections;
      const indexOffset = sections.length - visibleSections.length;
      return (
        <View testID={THINKING_STEPS_TEST_ID} style={{ marginLeft: 7, paddingVertical: 3 }}>
          {visibleSections.map((section, localIndex) => {
            const index = indexOffset + localIndex;
            const isLast = index === sections.length - 1;
            const isActiveStep = growing && isLast;
            const compactStep = previewMode && !isLast;
            // For implicit paragraphs (`explicitTitle === false`), `section.body`
            // already contains the full paragraph including its first line, so
            // suppress the synthetic title whenever the body is rendered.
            const showTitle =
              compactStep || section.explicitTitle || section.body.length === 0;
            const previewSnippet =
              previewMode && !compactStep && section.body.length > 0
                ? thinkingPeekTail(section.body, compact ? 76 : 136)
                : "";
            return (
              <View
                key={index}
                style={{
                  position: "relative",
                  paddingLeft: 16,
                  paddingBottom: isLast ? 2 : previewMode ? 6 : 9,
                  borderLeftWidth: isLast ? 0 : 1.5,
                  borderLeftColor: colors.border,
                }}
              >
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: -4.25,
                    top: 4,
                    width: 9,
                    height: 9,
                    borderRadius: 4.5,
                    backgroundColor: isActiveStep
                      ? withAlpha(colors.accent, light ? 0.2 : 0.26)
                      : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {isActiveStep ? (
                    <BreathingDot color={colors.accent} size={6} />
                  ) : (
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: colors.foregroundMuted,
                        opacity: 0.72,
                      }}
                    />
                  )}
                </View>
                {showTitle ? (
                  <Text
                    style={{
                      fontSize: compactStep ? 12 : 12.5,
                      lineHeight: 18,
                      fontWeight: compactStep ? "500" : "600",
                      color: compactStep ? colors.foregroundMuted : colors.foreground,
                      marginBottom: compactStep ? 0 : 2,
                    }}
                    numberOfLines={compactStep ? 1 : undefined}
                    selectable={open}
                  >
                    {section.title}
                  </Text>
                ) : null}
                {!compactStep && section.body.length > 0 ? (
                  previewMode ? (
                    <Text style={bodyStyle} numberOfLines={2}>
                      {previewSnippet}
                    </Text>
                  ) : (
                    <InlineFormattedText
                      text={section.body}
                      baseStyle={bodyStyle}
                      boldStyle={boldStyle}
                      codeStyle={codeStyle}
                      selectable={open}
                    />
                  )
                ) : null}
                {isActiveStep ? (
                  <View style={{ paddingTop: 3 }}>
                    <BreathingDot color={colors.accent} size={4.5} />
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      );
    };

    return (
      <View testID={thinkingStyleTestId("stepper")} style={rootStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? copy.collapseThinking : copy.expandThinking}
          onPress={onToggle}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: rowGap,
            minHeight: rowMinHeight,
          }}
        >
          {renderIcon()}
          <TextShimmer
            active={growing && !open}
            contentStyle={shimmerRowStyle}
            highlightColor={colors.foreground}
            surfaceColor={colors.surface0}
          >
            {(color) => (
              <>
                <Text
                  style={{
                    fontSize: ROW_FONT_SIZE,
                    lineHeight: rowLineHeight,
                    fontWeight: "600",
                    color: color ?? (growing ? colors.foreground : colors.foregroundMuted),
                    flexShrink: 0,
                  }}
                >
                  {labelText}
                </Text>
                {showHeadSummary ? <View style={sepStyle} /> : null}
                {showHeadSummary ? (
                  <Text
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: ROW_FONT_SIZE,
                      lineHeight: rowLineHeight,
                      color: color ?? colors.foregroundMuted,
                    }}
                    numberOfLines={1}
                  >
                    {headline}
                  </Text>
                ) : null}
              </>
            )}
          </TextShimmer>
          {badgeText.length > 0 ? (
            <View
              style={{
                borderWidth: hair,
                borderColor: growing ? withAlpha(colors.accent, 0.45) : colors.border,
                paddingHorizontal: 7,
                paddingVertical: 1,
                borderRadius: 999,
                flexShrink: 0,
              }}
            >
              <Text
                style={{
                  fontSize: 10.5,
                  lineHeight: 15,
                  fontVariant: ["tabular-nums"],
                  color: growing ? colors.accent : colors.foregroundMuted,
                }}
              >
                {badgeText}
              </Text>
            </View>
          ) : null}
          <ThinkingChevron open={open} color={colors.foregroundMuted} />
        </Pressable>

        {showSteps ? (
          open ? (
            <ScrollView
              style={{ maxHeight: expandedMaxHeight }}
              nestedScrollEnabled
              testID={SCROLL_BOX_TEST_ID}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.collapseThinking}
                onPress={collapseFromPress}
              >
                {renderStepList(false)}
              </Pressable>
            </ScrollView>
          ) : (
            <Pressable
              testID={THINKING_PEEK_TEST_ID}
              accessibilityRole="button"
              accessibilityLabel={copy.expandThinking}
              onPress={onToggle}
              style={{ position: "relative", maxHeight: 96, overflow: "hidden" }}
            >
              {renderStepList(true)}
              <SteppedFadeVeil backgroundColor={colors.surface0} height={14} />
            </Pressable>
          )
        ) : open ? (
          <ScrollView
            style={{ maxHeight: expandedMaxHeight }}
            nestedScrollEnabled
            testID={SCROLL_BOX_TEST_ID}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.collapseThinking}
              onPress={collapseFromPress}
            >
              <Text style={bodyStyle} selectable>
                {text}
              </Text>
            </Pressable>
          </ScrollView>
        ) : null}
      </View>
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Plan E · Quiet Editorial Marginalia                                      */
  /* ------------------------------------------------------------------------ */
  const metaText = formatMetaSummary(durationText, sectionCount, copy, "section", growing);
  const peekText = growing && !open ? thinkingPeekTail(text, compact ? 68 : 130) : "";
  const showSummary = !open && headline.length > 0;
  const shimmerRowStyle: ViewStyle = {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: rowGap,
  };

  return (
    <View testID={thinkingStyleTestId("editorial")} style={rootStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? copy.collapseThinking : copy.expandThinking}
        onPress={onToggle}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: rowGap,
          minHeight: rowMinHeight,
        }}
      >
        {renderIcon()}
        <TextShimmer
          active={growing && !open}
          contentStyle={shimmerRowStyle}
          highlightColor={colors.foreground}
          surfaceColor={colors.surface0}
        >
          {(color) => (
            <>
              <Text
                style={{
                  fontSize: 12.5,
                  lineHeight: rowLineHeight,
                  letterSpacing: 0.25,
                  color: color ?? colors.foregroundMuted,
                  opacity: color === null ? (growing ? 0.92 : 0.65) : 1,
                  flexShrink: 0,
                }}
              >
                {labelText}
              </Text>
              {showSummary ? (
                <Text
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    lineHeight: rowLineHeight,
                    fontStyle: "italic",
                    color: color ?? colors.foregroundMuted,
                    opacity: color === null ? 0.72 : 1,
                  }}
                  numberOfLines={1}
                >
                  {headline}
                </Text>
              ) : null}
            </>
          )}
        </TextShimmer>
        {metaText.length > 0 ? <Text style={metaStyle}>{metaText}</Text> : null}
        <ThinkingChevron open={open} color={colors.foregroundMuted} />
      </Pressable>

      {growing && !open && peekText.length > 0 ? (
        <View
          style={{
            marginLeft: 7,
            paddingLeft: 13,
            paddingVertical: 2,
            borderLeftWidth: 1,
            borderLeftColor: colors.border,
          }}
        >
          <Pressable
            testID={THINKING_PEEK_TEST_ID}
            accessibilityRole="button"
            accessibilityLabel={copy.expandThinking}
            onPress={onToggle}
            style={{ position: "relative", maxHeight: 44, overflow: "hidden" }}
          >
            <Text
              style={{
                fontSize: 12.5,
                lineHeight: 20,
                color: colors.foregroundMuted,
                opacity: 0.8,
              }}
              numberOfLines={2}
            >
              {peekText}
            </Text>
            <SteppedFadeVeil backgroundColor={colors.surface0} height={14} />
          </Pressable>
        </View>
      ) : null}

      {open ? (
        <View
          style={{
            marginLeft: 7,
            paddingLeft: 13,
            paddingVertical: 2,
            borderLeftWidth: 1,
            borderStyle: "dashed",
            borderLeftColor: colors.border,
          }}
        >
          <ScrollView
            style={{ maxHeight: expandedMaxHeight }}
            nestedScrollEnabled
            testID={SCROLL_BOX_TEST_ID}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.collapseThinking}
              onPress={collapseFromPress}
            >
              <ThinkingProse
                sections={sections}
                rawText={text}
                running={growing}
                colors={colors}
                compact={compact}
                editorial
              />
            </Pressable>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
