/**
 * Inline reasoning row for the Paseo timeline, shaped like dsh web's.
 *
 * dsh web shows a thought as one line: a small label and the current line of
 * the thought together, scrolling while the model thinks, expanding to the
 * full text only when clicked. Paseo's stock reasoning row is a collapsed
 * tool-like row labelled "Thinking".
 *
 * The host's transformer `phase` is not a reliable "still streaming" signal:
 * a thought is `streaming` only while its render-model status is `loading`, so
 * it flips back and forth as chunks settle and would make this row open and
 * close repeatedly. Instead the row watches the *revealed text* grow: while it
 * grows the row stays in its scrolling state, and it settles only once the
 * reveal has caught up and the host reports `complete`.
 *
 * @module dsh-paseo/client/inline-thinking
 */
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, useRevealedText } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useShimmer } from "./shimmer";

export interface InlineThinkingData {
  text: string;
  phase: "streaming" | "complete";
}

/** Last non-empty line: the current (or final) line of the thought. */
function lastLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines[lines.length - 1] ?? "";
}

/**
 * Track "still producing text" without trusting the flickering `phase`.
 *
 * Any growth latches the row on; it turns off only when the reveal stopped
 * growing *and* the host says the item is complete.
 */
function useGrowing(revealed: string, phase: "streaming" | "complete"): boolean {
  const [growing, setGrowing] = useState(phase === "streaming");
  const lastLength = useRef(revealed.length);
  useEffect(() => {
    const grew = revealed.length > lastLength.current;
    lastLength.current = revealed.length;
    if (grew) {
      setGrowing(true);
      return;
    }
    if (phase === "complete") setGrowing(false);
  }, [revealed, phase]);
  return growing;
}

export function InlineThinking({
  theme,
  layout,
  item,
}: PluginTimelineItemProps<InlineThinkingData>) {
  const { text, phase } = item.data;
  const revealed = useRevealedText(text, phase);
  const growing = useGrowing(revealed, phase);
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? false;
  const shimmer = useShimmer(growing && !open);

  const line = lastLine(revealed);

  const styles = useMemo(
    () => ({
      root: { gap: 3, paddingVertical: layout.compact ? 3 : 5 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      textRow: {
        flex: 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      label: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 11 : 12,
        opacity: growing ? 0.9 : 0.6,
      },
      line: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 13 : 14,
        lineHeight: layout.compact ? 19 : 21,
        opacity: growing ? 0.95 : 0.7,
      },
      full: {
        marginLeft: layout.compact ? 10 : 12,
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 13 : 14,
        lineHeight: layout.compact ? 19 : 21,
        opacity: 0.8,
      },
    }),
    [theme, layout.compact, growing],
  );

  return (
    // The whole block toggles, so a tap anywhere (including on the expanded
    // text) closes it. No inner ScrollView: an inner scroll swallows the tap.
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open ? "收起思考" : "展开思考"}
      onPress={() => setManual((value) => !(value ?? false))}
      style={styles.root}
    >
      <View style={styles.row}>
        <Icon
          name="Brain"
          size={layout.compact ? 14 : 16}
          color={theme.colors.foregroundMuted}
        />
        <View style={[styles.textRow, { opacity: shimmer }]}>
          <Text style={styles.label}>{growing ? "思考中…" : "已思考"}</Text>
          {!open ? (
            <Text style={styles.line} numberOfLines={1}>
              {line}
            </Text>
          ) : null}
        </View>
      </View>
      {open ? (
        // Render the raw source, not the paced reveal: a per-frame re-render of
        // a very long thought is what froze the app before.
        <Text style={styles.full}>{text}</Text>
      ) : null}
    </Pressable>
  );
}
