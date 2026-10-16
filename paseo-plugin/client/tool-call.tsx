/**
 * Inline tool-call row for the Paseo timeline.
 *
 * Paseo's stock tool row is a single line that expands on click. This keeps
 * that shape and its icon, and expands downward the way the reasoning row
 * does: the full command and the output/diff are laid out below the row at
 * full width, not squeezed beside the icon and label.
 *
 * Code is monospaced, and an edit diff follows GitHub's convention: a soft
 * green/red line background, a coloured +/- marker, and the code itself in the
 * muted foreground colour.
 *
 * While the tool is running the row pulses (see `./shimmer`), matching the
 * "still working" feel Paseo's own loading rows have.
 *
 * @module dsh-paseo/client/tool-call
 */
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { shouldPulse, useRowPulse } from "./newest";
import { TextShimmer } from "./text-shimmer";
import { type ToolCallData } from "./tool-call-data";

/** GitHub's diff line tints, at low alpha so both themes stay readable. */
const ADD_BG = "rgba(46, 160, 67, 0.12)";
const DEL_BG = "rgba(248, 81, 73, 0.12)";

export function InlineToolCall({
  theme,
  layout,
  item,
  agentId,
  timestamp,
}: PluginTimelineItemProps<ToolCallData>) {
  const data = item.data;
  const [expanded, setExpanded] = useState(false);
  const hasBody = data.body !== "";
  // Even a tool with no output can have a command longer than the row, so it
  // must still be expandable: expanding lays the full command out below.
  const canExpand = hasBody || data.summary !== "" || data.headline !== "";
  const compact = layout.compact;
  const iconSize = compact ? 14 : 16;
  // Only the newest row is "running": while it runs, and for a window after it
  // commits (the only way a short command — call and result in the same tick —
  // ever shows a signal). Gating on the newest row also keeps an interrupted
  // tool, stuck `running` forever, from blinking for the rest of the session.
  const running = shouldPulse(data.status, useRowPulse(agentId, timestamp));

  const styles = useMemo(
    () => ({
      root: { gap: 3, paddingVertical: compact ? 3 : 5 },
      head: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const },
      // The text run, and the flex row the shimmer's copy re-lays-out.
      text: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const, flex: 1, minWidth: 0 },
      label: { color: theme.colors.foregroundMuted, fontSize: compact ? 13 : 14 },
      summary: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace" as const,
        fontSize: compact ? 12 : 13,
        lineHeight: compact ? 18 : 20,
        flex: 1,
        minWidth: 0,
      },
      body: { marginLeft: compact ? 10 : 12, gap: 2 },
      summaryFull: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace" as const,
        fontSize: compact ? 12 : 13,
        lineHeight: compact ? 18 : 20,
      },
      diffLine: { flexDirection: "row" as const, paddingHorizontal: 6 },
      diffAdd: { backgroundColor: ADD_BG },
      diffDel: { backgroundColor: DEL_BG },
      marker: {
        fontFamily: "monospace" as const,
        fontSize: compact ? 12 : 13,
        lineHeight: compact ? 17 : 19,
        width: 12,
      },
      codeBlock: {
        backgroundColor: "rgba(127, 127, 127, 0.10)",
        borderRadius: 6,
        paddingVertical: compact ? 5 : 6,
        paddingHorizontal: compact ? 6 : 8,
      },
      codeText: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace" as const,
        fontSize: compact ? 12 : 13,
        lineHeight: compact ? 17 : 19,
      },
      diffText: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace" as const,
        fontSize: compact ? 12 : 13,
        lineHeight: compact ? 17 : 19,
        flex: 1,
        minWidth: 0,
      },
    }),
    [theme, compact],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${data.label} ${data.summary}`}
      onPress={() => {
        if (canExpand) setExpanded((value) => !value);
      }}
      style={styles.root}
    >
      <View style={styles.head}>
        <Icon
          name={data.icon}
          size={iconSize}
          color={data.failed ? theme.colors.statusDanger : theme.colors.foregroundMuted}
        />
        <TextShimmer
          active={running}
          contentStyle={styles.text}
          highlightColor={theme.colors.foreground}
          surfaceColor={theme.colors.surface0}
        >
          {(color) => (
            <>
              <Text style={[styles.label, color === null ? null : { color }]}>{data.label}</Text>
              {/* The row's title never disappears: expanding reveals the tool's
                  own subject below, so hiding this left the row unnamed — DSH
                  keeps the title and puts the command in the block under it.
                  Expanded it wraps instead of clipping, which is where a long
                  command that has no description becomes readable. */}
              {data.summary !== "" ? (
                <Text
                  style={[styles.summary, color === null ? null : { color }]}
                  numberOfLines={expanded ? undefined : 1}
                >
                  {data.summary}
                </Text>
              ) : null}
            </>
          )}
        </TextShimmer>
      </View>
      {expanded && canExpand && data.hasDetail ? (
        <View style={styles.body}>
          {/* Everything a row reveals goes in one code surface, the way the edit
              rows already did: the subject the title describes (the command),
              then the payload (the output, the file, the diff). */}
          <View style={styles.codeBlock}>
          {data.headline !== "" ? (
            <Text style={styles.summaryFull} selectable>
              {data.headline}
            </Text>
          ) : null}
          {hasBody ? (
            data.diff ? (
              data.body.split("\n").map((line, index) => {
                const added = line.startsWith("+");
                const removed = line.startsWith("-");
                const marker = added ? "+" : removed ? "-" : " ";
                const text = added || removed ? line.slice(1) : line;
                return (
                  <View
                    key={index}
                    style={[styles.diffLine, added ? styles.diffAdd : removed ? styles.diffDel : null]}
                  >
                    <Text
                      style={[
                        styles.marker,
                        {
                          color: added
                            ? theme.colors.statusSuccess
                            : removed
                              ? theme.colors.statusDanger
                              : theme.colors.foregroundMuted,
                        },
                      ]}
                    >
                      {marker}
                    </Text>
                    <Text style={styles.diffText}>{text === "" ? " " : text}</Text>
                  </View>
                );
              })
            ) : (
              <Text style={styles.codeText} selectable>
                {data.body}
              </Text>
            )
          ) : null}
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}
