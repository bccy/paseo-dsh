/**
 * Inline tool-call row for the Paseo timeline.
 *
 * Paseo's stock tool row is a single line that expands on click. This keeps
 * that shape and its icon, and expands downward the way the reasoning row
 * does: the block below the row is a card at full width, not a squeeze beside
 * the icon and label.
 *
 * The row head and the card follow DSH's own metrics (`./tokens`): a fixed
 * 24px line, a 13px UI-font summary, a 2x2 separator square, 16px card radius
 * on a card surface, and a `+A -R` suffix on diff rows. A command row splits
 * into a command banner, a hairline, and an output region; a diff row gives
 * every line a 3px semantic left bar and an 8%/12% wash; everything else is
 * one code surface.
 *
 * While the tool is running the row pulses (see `./shimmer`), matching the
 * "still working" feel Paseo's own loading rows have.
 *
 * @module dsh-paseo/client/tool-call
 */
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { shouldPulse, useRowPulse } from "./newest";
import { localeText } from "./locale";
import { TextShimmer } from "./text-shimmer";
import { type ToolCallData } from "./tool-call-data";
import {
  BODY_INDENT,
  cardStyle,
  codeRegionStyle,
  codeTextStyle,
  commandRegionStyle,
  commandTextStyle,
  DIFF_LINE_PADDING_HORIZONTAL,
  diffBodyTextStyle,
  diffLineStyle,
  diffMarkerTextStyle,
  diffStat,
  diffStatTextStyle,
  dividerStyle,
  isCommandBlock,
  isLightSurface,
  outputRegionStyle,
  outputTextStyle,
  rowHeadStyle,
  rowIconColor,
  rowLabelTextStyle,
  rowRootStyle,
  separatorStyle,
  summaryTextStyle,
} from "./tokens";

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
  // Expanding is only worth offering when the block below actually has
  // something in it — `hasDetail` is that answer, computed in the data layer.
  // The row is a Pressable, so promising an expansion that never renders left a
  // button which did nothing when pressed.
  const canExpand = data.hasDetail;
  // Once expanded the block carries the subject in full, so a row whose title
  // *is* that subject does not repeat a compact copy of it above.
  const showSummary = data.summary !== "" && !(expanded && !data.titled && data.headline !== "");
  const compact = layout.compact;
  // Icon size is Paseo's own (and was settled in an earlier round); everything
  // else in the row now comes from the shared token table.
  const iconSize = compact ? 14 : 16;
  // Only the newest row is "running": while it runs, and for a window after it
  // commits (the only way a short command — call and result in the same tick —
  // ever shows a signal). Gating on the newest row also keeps an interrupted
  // tool, stuck `running` forever, from blinking for the rest of the session.
  const running = shouldPulse(data.status, useRowPulse(agentId, timestamp));
  // `+A -R` beside the summary, for a row whose body is a real diff and which
  // did not settle with a cue (DSH hides the stat on error/stopped rows).
  const stat = diffStat(data);
  // A shell (or `/`-command) block: command banner, hairline, output region.
  // The caption is read from the locale so this keeps working once the data
  // layer localizes `bodyLabel`; the literal covers a tree where it has not.
  const command = isCommandBlock(data, [localeText().bodyLabels.output, "输出"]);

  const styles = useMemo(() => {
    // The wash is 8% on a light card and 12% on a dark one; the card's own
    // surface is what the diff lines are painted on.
    const light = isLightSurface(theme.colors.surface1);
    return {
      root: rowRootStyle(),
      head: rowHeadStyle(),
      // The text run, and the flex row the shimmer's copy re-lays-out. No gap:
      // the separator carries its own margins, the way DSH's `.sep` does.
      text: { flexDirection: "row" as const, alignItems: "center" as const, flex: 1, minWidth: 0 },
      label: rowLabelTextStyle(theme.colors),
      sep: separatorStyle(theme.colors),
      summary: summaryTextStyle(theme.colors, data.status),
      stat: diffStatTextStyle(theme.colors),
      body: { marginLeft: BODY_INDENT },
      // RN has no hairline in a plain object; `StyleSheet.hairlineWidth` is the
      // device's own (0.5 at 1x/2x), which is what DSH's `.5px` means here.
      card: cardStyle(theme.colors, StyleSheet.hairlineWidth),
      divider: dividerStyle(theme.colors, StyleSheet.hairlineWidth),
      command: commandRegionStyle(),
      commandText: commandTextStyle(theme.colors),
      output: outputRegionStyle(),
      outputText: outputTextStyle(theme.colors),
      code: codeRegionStyle(),
      codeText: codeTextStyle(theme.colors),
      diffLine: {
        flexDirection: "row" as const,
        paddingHorizontal: DIFF_LINE_PADDING_HORIZONTAL,
      },
      diffAdd: diffLineStyle(theme.colors, "add", light),
      diffDel: diffLineStyle(theme.colors, "del", light),
      diffContext: diffLineStyle(theme.colors, "context", light),
      markerAdd: diffMarkerTextStyle(theme.colors, "add"),
      markerDel: diffMarkerTextStyle(theme.colors, "del"),
      markerContext: diffMarkerTextStyle(theme.colors, "context"),
      diffTextAdd: diffBodyTextStyle(theme.colors, "add"),
      diffTextDel: diffBodyTextStyle(theme.colors, "del"),
      diffTextContext: diffBodyTextStyle(theme.colors, "context"),
    };
  }, [theme, data.status]);

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
        {/* DSH never recolours the icon: a failure shows up in the summary
            text, not in the glyph beside it. */}
        <Icon name={data.icon} size={iconSize} color={rowIconColor(theme.colors)} />
        <TextShimmer
          active={running}
          contentStyle={styles.text}
          highlightColor={theme.colors.foreground}
          surfaceColor={theme.colors.surface0}
        >
          {(color) => (
            <>
              <Text style={[styles.label, color === null ? null : { color }]}>{data.label}</Text>
              {/* The row stays one line, label and summary together: moving the
                  summary onto its own line just pushed it away from the row it
                  names. It is only dropped once the block below carries the same
                  subject in full, so a description-less row does not print its
                  arguments twice. `numberOfLines` stays 1 for the same reason —
                  an unbounded line beside a long label wrapped one character per
                  line, which is what "并行显示" was. */}
              {showSummary ? (
                <>
                  {/* A 2x2 square with 1px corners, not a dot — DSH's separator
                      between the title and its summary. */}
                  <View style={styles.sep} />
                  <Text
                    style={[styles.summary, color === null ? null : { color }]}
                    numberOfLines={1}
                  >
                    {data.summary}
                  </Text>
                </>
              ) : null}
              {stat !== null ? (
                <Text style={[styles.stat, color === null ? null : { color }]}>
                  {`+${stat.added} -${stat.removed}`}
                </Text>
              ) : null}
            </>
          )}
        </TextShimmer>
      </View>
      {expanded && canExpand ? (
        <View style={styles.body}>
          {/* One card per expanded block, the way DSH's TerminalBlock, DiffBlock
              and ReadBlock all are: same radius, same hairline, same surface. */}
          <View style={styles.card}>
            {command ? (
              <>
                {/* The command the row ran, at full contrast and on its own
                    line, then a hairline, then what it printed. A running
                    command that has printed nothing yet draws no divider, the
                    same as DSH's banner-only terminal card. */}
                <View style={styles.command}>
                  <Text style={styles.commandText} selectable>
                    {data.headline}
                  </Text>
                </View>
                {hasBody ? <View style={styles.divider} /> : null}
                {hasBody ? (
                  <View style={styles.output}>
                    <Text style={styles.outputText} selectable>
                      {data.body}
                    </Text>
                  </View>
                ) : null}
              </>
            ) : data.diff ? (
              <>
                {data.headline !== "" ? (
                  <View style={styles.code}>
                    <Text style={styles.codeText} selectable>
                      {data.headline}
                    </Text>
                  </View>
                ) : null}
                {hasBody
                  ? data.body.split("\n").map((line, index) => {
                      const added = line.startsWith("+");
                      const removed = line.startsWith("-");
                      const kind = added ? "add" : removed ? "del" : "context";
                      // The marker column stays a separate Text so the code
                      // starts at the same x on every row, and the `+ `/`- `
                      // prefix keeps DSH's meaning: the sign is the marker, the
                      // text is the line without it.
                      const marker = added ? "+" : removed ? "-" : " ";
                      const text = added || removed ? line.slice(1) : line;
                      return (
                        <View
                          key={index}
                          style={[
                            styles.diffLine,
                            kind === "add"
                              ? styles.diffAdd
                              : kind === "del"
                                ? styles.diffDel
                                : styles.diffContext,
                          ]}
                        >
                          <Text
                            style={
                              kind === "add"
                                ? styles.markerAdd
                                : kind === "del"
                                  ? styles.markerDel
                                  : styles.markerContext
                            }
                          >
                            {marker}
                          </Text>
                          <Text
                            style={
                              kind === "add"
                                ? styles.diffTextAdd
                                : kind === "del"
                                  ? styles.diffTextDel
                                  : styles.diffTextContext
                            }
                          >
                            {text === "" ? " " : text}
                          </Text>
                        </View>
                      );
                    })
                  : null}
              </>
            ) : data.headline !== "" || hasBody ? (
              <View style={styles.code}>
                {data.headline !== "" ? (
                  <Text style={styles.codeText} selectable>
                    {data.headline}
                  </Text>
                ) : null}
                {hasBody ? (
                  <Text style={styles.codeText} selectable>
                    {data.body}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}
