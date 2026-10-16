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
import { useRowPulse } from "./newest";
import { useShimmer } from "./shimmer";
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
  const canExpand = hasBody || data.summary !== "";
  const compact = layout.compact;
  const iconSize = compact ? 14 : 16;
  // A running tool pulses for as long as it runs. A finished one still pulses
  // while it is the newest row and recently committed, which is the only way a
  // short command — call and result in the same tick — ever shows a pulse.
  const { newest, fresh } = useRowPulse(agentId, timestamp);
  const shimmer = useShimmer(data.status === "running" || (newest && fresh));

  const styles = useMemo(
    () => ({
      root: { gap: 3, paddingVertical: compact ? 3 : 5 },
      head: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const },
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
      bodyText: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace" as const,
        fontSize: compact ? 12 : 13,
        lineHeight: compact ? 17 : 19,
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
      <View style={[styles.head, { opacity: shimmer }]}>
        <Icon
          name={data.icon}
          size={iconSize}
          color={data.failed ? theme.colors.statusDanger : theme.colors.foregroundMuted}
        />
        <Text style={styles.label}>{data.label}</Text>
        {/* When expanded the summary moves below at full width, so the head
            does not show a truncated copy of what the body already carries. */}
        {!expanded && data.summary !== "" ? (
          <Text style={styles.summary} numberOfLines={1}>
            {data.summary}
          </Text>
        ) : !expanded ? (
          <View style={styles.summary} />
        ) : null}
      </View>
      {expanded && canExpand ? (
        <View style={styles.body}>
          {data.summary !== "" ? <Text style={styles.summaryFull}>{data.summary}</Text> : null}
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
            ) : data.code ? (
              // Source code (read/write/search): a soft code surface so it
              // reads as code, without the hard box the user rejected.
              <View style={styles.codeBlock}>
                <Text style={styles.codeText} selectable>
                  {data.body}
                </Text>
              </View>
            ) : (
              <Text style={styles.bodyText} selectable>
                {data.body}
              </Text>
            )
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
