/**
 * Shared native-Paseo frameless UI primitives for composer popovers (team,
 * goal, and background jobs).
 *
 * Strictly React Native + Paseo theme tokens (`surface0`, subtle `tint()`
 * fills, 1px hairlines, no boxed `surface1` cards). Zero HTML/DOM/CSS and
 * Hermes-safe across dark and light themes.
 *
 * @module dsh-paseo/client/popover-ui
 */
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Fragment, type ReactNode } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { mono, tabular, tint, toneColor, type Tone } from "./console-theme";
import { ringColorFor } from "./jobs-popover-layout";
import { parseProseBlocks, type ProseBlock, type ProseSpan } from "./popover-prose";

export type PopoverTheme = PluginButtonContentProps["theme"];
export type PopoverPillTone = Tone | "running";

export const POPOVER_DETAIL_TITLE_SIZE = 16;
export const POPOVER_DETAIL_TITLE_LINE = 23;
export const POPOVER_PROSE_FONT_SIZE = 13.5;
export const POPOVER_PROSE_LINE_HEIGHT = 21.5;

const KICKER_FONT_SIZE = 11.5;
const KICKER_LINE_HEIGHT = 16;
const HEADING_FONT_SIZE = 14;
const HEADING_LINE_HEIGHT = 20;
const MUTED_PROSE_FONT_SIZE = 13;
const MUTED_PROSE_LINE_HEIGHT = 20.5;
const MARKER_FONT_SIZE = 12.5;
const CODE_FONT_SIZE = 12;

/** 1px frameless divider tinted from the theme border token. */
export function PopoverHairline({
  theme,
  inset = 0,
  marginVertical = 4,
}: {
  theme: PopoverTheme;
  inset?: number;
  marginVertical?: number;
}) {
  return (
    <View
      style={{
        height: 1,
        marginHorizontal: inset,
        marginVertical,
        backgroundColor: tint(theme.colors.border, 0.7),
      }}
    />
  );
}

/** Borderless soft-tinted pill for compact status and metadata chips inside popovers. */
export function PopoverPill({
  theme,
  label,
  tone = "neutral",
  leading,
  compact = false,
  testID,
  style,
}: {
  theme: PopoverTheme;
  label: string;
  tone?: PopoverPillTone;
  leading?: ReactNode;
  compact?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const resolved =
    tone === "running"
      ? ringColorFor(theme.colors.surface0)
      : toneColor(theme.colors, tone);
  const backgroundColor =
    tone === "neutral"
      ? tint(theme.colors.foreground, 0.07)
      : tint(resolved, tone === "running" ? 0.14 : 0.13);
  const ink = tone === "neutral" ? theme.colors.foregroundMuted : resolved;

  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: compact ? 4 : 5,
          height: compact ? 18 : 20,
          borderRadius: 999,
          paddingHorizontal: compact ? 6 : 7,
          backgroundColor,
          flexShrink: 0,
        },
        style,
      ]}
    >
      {leading === undefined || leading === null ? null : leading}
      <Text
        numberOfLines={1}
        style={{
          fontSize: compact ? 11 : 11.5,
          lineHeight: compact ? 14 : 15,
          fontWeight: "600",
          color: ink,
          ...tabular,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/** Native section header row with muted label, optional count, and optional toned trailing note. */
export function PopoverSectionHeader({
  theme,
  label,
  count,
  note,
  noteTone = "muted",
  paddingTop = 10,
}: {
  theme: PopoverTheme;
  label: string;
  count?: number | string;
  note?: string;
  noteTone?: "muted" | "warning" | "danger";
  paddingTop?: number;
}) {
  const noteColor =
    noteTone === "danger"
      ? theme.colors.statusDanger
      : noteTone === "warning"
        ? theme.colors.statusWarning
        : theme.colors.foregroundMuted;
  const hasCount = count !== undefined && String(count) !== "";
  const hasNote = note !== undefined && note !== "";

  return (
    <View
      accessibilityRole="header"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingTop,
        paddingBottom: 4,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            fontSize: KICKER_FONT_SIZE,
            lineHeight: KICKER_LINE_HEIGHT,
            fontWeight: "600",
            color: theme.colors.foregroundMuted,
            flexShrink: 1,
          }}
        >
          {label}
        </Text>
        {hasCount ? (
          <Text
            numberOfLines={1}
            style={{
              fontSize: KICKER_FONT_SIZE,
              lineHeight: KICKER_LINE_HEIGHT,
              fontWeight: "500",
              color: tint(theme.colors.foregroundMuted, 0.8),
              flexShrink: 0,
              ...tabular,
            }}
          >
            {String(count)}
          </Text>
        ) : null}
      </View>
      {hasNote ? (
        <Text
          numberOfLines={1}
          style={{
            flexShrink: 2,
            minWidth: 0,
            fontSize: KICKER_FONT_SIZE,
            lineHeight: KICKER_LINE_HEIGHT,
            fontWeight: noteTone === "muted" ? "400" : "500",
            color: noteColor,
            ...tabular,
          }}
        >
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** Frameless soft-tinted alert row for warnings and errors inside popovers. */
export function PopoverAlertRow({
  theme,
  tone,
  message,
  detail,
  icon,
  marginHorizontal = 12,
}: {
  theme: PopoverTheme;
  tone: "warning" | "danger";
  message: string;
  detail?: string;
  icon?: "TriangleAlert" | "CircleAlert";
  marginHorizontal?: number;
}) {
  const color = tone === "danger" ? theme.colors.statusDanger : theme.colors.statusWarning;
  const iconName = icon ?? (tone === "danger" ? "CircleAlert" : "TriangleAlert");

  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        marginHorizontal,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 6,
        backgroundColor: tint(color, 0.11),
      }}
    >
      <View style={{ height: 18.5, justifyContent: "center", flexShrink: 0 }}>
        <Icon name={iconName} size={14} color={color} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          selectable
          style={{
            fontSize: 12.5,
            lineHeight: 18.5,
            fontWeight: "500",
            color,
          }}
        >
          {message}
        </Text>
        {detail !== undefined && detail !== "" ? (
          <Text
            selectable
            style={{
              fontSize: 12,
              lineHeight: 17.5,
              color: theme.colors.foregroundMuted,
            }}
          >
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function renderInlineSpans(spans: readonly ProseSpan[], theme: PopoverTheme): ReactNode {
  return spans.map((span, index) => {
    if (span.kind === "strong") {
      return (
        <Text key={index} style={{ fontWeight: "600" }}>
          {span.text}
        </Text>
      );
    }
    if (span.kind === "code") {
      return (
        <Text
          key={index}
          style={{
            fontFamily: mono,
            fontSize: CODE_FONT_SIZE,
            backgroundColor: tint(theme.colors.foreground, 0.08),
          }}
        >
          {span.text}
        </Text>
      );
    }
    return <Fragment key={index}>{span.text}</Fragment>;
  });
}

function blockMarginTop(prev: ProseBlock | undefined, current: ProseBlock): number {
  if (!prev) return 0;
  if (prev.kind === "kicker") return 3;
  if (current.kind === "kicker" || current.kind === "heading") return 12;
  return 8;
}

/** Structured prose renderer for popover detail pages and multi-section descriptions. */
export function PopoverProse({ text, theme }: { text: string; theme: PopoverTheme }) {
  const blocks = parseProseBlocks(text);
  if (blocks.length === 0) return null;

  return (
    <View>
      {blocks.map((block, index) => {
        const marginTop = blockMarginTop(blocks[index - 1], block);

        if (block.kind === "kicker") {
          return (
            <Text
              key={index}
              selectable
              style={{
                marginTop,
                fontSize: KICKER_FONT_SIZE,
                lineHeight: KICKER_LINE_HEIGHT,
                fontWeight: "600",
                color: theme.colors.foregroundMuted,
              }}
            >
              {block.text}
            </Text>
          );
        }

        if (block.kind === "heading") {
          return (
            <Text
              key={index}
              selectable
              style={{
                marginTop,
                fontSize: HEADING_FONT_SIZE,
                lineHeight: HEADING_LINE_HEIGHT,
                fontWeight: "600",
                color: theme.colors.foreground,
              }}
            >
              {block.text}
            </Text>
          );
        }

        if (block.kind === "paragraph") {
          const textNode = (
            <Text
              selectable
              style={{
                fontSize: block.muted ? MUTED_PROSE_FONT_SIZE : POPOVER_PROSE_FONT_SIZE,
                lineHeight: block.muted ? MUTED_PROSE_LINE_HEIGHT : POPOVER_PROSE_LINE_HEIGHT,
                color: block.muted ? theme.colors.foregroundMuted : theme.colors.foreground,
              }}
            >
              {renderInlineSpans(block.spans, theme)}
            </Text>
          );

          if (block.rail) {
            return (
              <View
                key={index}
                style={{
                  marginTop,
                  paddingLeft: 10,
                  borderLeftWidth: 2,
                  borderLeftColor: theme.colors.border,
                }}
              >
                {textNode}
              </View>
            );
          }

          return (
            <View key={index} style={{ marginTop }}>
              {textNode}
            </View>
          );
        }

        return (
          <View key={index} style={{ marginTop, gap: 8 }}>
            {block.items.map((item, itemIndex) => (
              <View
                key={itemIndex}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 7,
                }}
              >
                <Text
                  style={{
                    minWidth: 18,
                    fontSize: MARKER_FONT_SIZE,
                    lineHeight: POPOVER_PROSE_LINE_HEIGHT,
                    fontWeight: "600",
                    color: theme.colors.foregroundMuted,
                    ...tabular,
                  }}
                >
                  {item.marker}
                </Text>
                <Text
                  selectable
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: POPOVER_PROSE_FONT_SIZE,
                    lineHeight: POPOVER_PROSE_LINE_HEIGHT,
                    color: theme.colors.foreground,
                  }}
                >
                  {item.lead ? (
                    <Text style={{ fontWeight: "600", color: theme.colors.foreground }}>
                      {item.lead.endsWith(":") ? `${item.lead} ` : item.lead}
                    </Text>
                  ) : null}
                  {renderInlineSpans(item.spans, theme)}
                </Text>
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}
