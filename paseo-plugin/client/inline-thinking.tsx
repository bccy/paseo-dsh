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
 * close repeatedly. Instead the row watches the text itself grow: while it grows
 * the row stays in its scrolling state, and it settles once the text has stopped
 * arriving and the host reports `complete`.
 *
 * The text is used **as it arrives**, never through the host's paced reveal
 * (`useRevealedText`). That hook re-plays the reasoning at a rate it owns — its
 * signature takes no speed — so the collapsed preview trailed the expanded one,
 * which always read the raw text. dsh web applies the same preview rule to the
 * live text; this row now does too.
 *
 * @module dsh-paseo/client/inline-thinking
 */
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { TextShimmer } from "./text-shimmer";
import { reasoningPreview, streamingTail } from "./thinking-text";
import { BODY_INDENT, ROW_FONT_SIZE, ROW_GAP, ROW_HEAD_GAP, ROW_HEIGHT, ROW_LINE_HEIGHT } from "./tokens";
import { localeText } from "./locale";

/**
 * DSH's thinking icon (`PROCESS_ICONS.thinking` = `IconThinkOutlineRegular`:
 * two petals crossed on the diagonal plus a filled centre dot, `viewBox 16`,
 * 1px stroke, drawn at 16). Rasterized at exactly 4x and shown at 16 so the
 * stroke lands on whole pixels; `tintColor` replaces `currentColor`.
 */
const THINK_ICON = "data:image/png;base64,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";

export interface InlineThinkingData {
  text: string;
  phase: "streaming" | "complete";
}



/**
 * Track "still producing text" without trusting the flickering `phase`.
 *
 * Any growth latches the row on; it turns off only when the text stopped
 * growing *and* the host says the item is complete.
 */
function useGrowing(text: string, phase: "streaming" | "complete"): boolean {
  const [growing, setGrowing] = useState(phase === "streaming");
  const lastLength = useRef(text.length);
  useEffect(() => {
    const grew = text.length > lastLength.current;
    lastLength.current = text.length;
    if (grew) {
      setGrowing(true);
      return;
    }
    if (phase === "complete") setGrowing(false);
  }, [text, phase]);
  return growing;
}

export function InlineThinking({
  theme,
  layout,
  item,
}: PluginTimelineItemProps<InlineThinkingData>) {
  const { text, phase } = item.data;
  const growing = useGrowing(text, phase);
  // The width the preview line has to work with, reported by its own layout: one
  // measurement per resize, not per frame.
  const [boxWidth, setBoxWidth] = useState(0);
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? false;
  // Read per render, not hoisted: `./locale` follows a locale the host relays
  // after this module loaded, and the label and the two screen-reader strings
  // have to move with it.
  const copy = localeText();


  // While streaming the collapsed line is a **tail window**: it advances with
  // every arrived character instead of waiting for a paragraph to finish, which
  // is what made it lag the expanded view. Before the box has been measured (the
  // very first frame) and once the thought settles, dsh's own rule applies —
  // the latest completed paragraph's first line, then the first line outright.
  const line =
    growing && boxWidth > 0
      ? streamingTail(text, boxWidth, ROW_FONT_SIZE)
      : reasoningPreview(text, growing);

  const styles = useMemo(
    () => ({
      // DSH renders a thought and a tool call through the same DisclosureRow, so
      // the two rows must not disagree about their rhythm: same 24px line, same
      // head gap, no vertical padding of their own.
      root: { gap: ROW_GAP, paddingVertical: 0 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: ROW_HEAD_GAP,
        minHeight: ROW_HEIGHT,
      },
      textRow: {
        flex: 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: ROW_HEAD_GAP,
      },
      label: {
        color: theme.colors.foregroundMuted,
        fontSize: ROW_FONT_SIZE,
        lineHeight: ROW_LINE_HEIGHT,
        opacity: growing ? 0.9 : 0.6,
      },
      line: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.foregroundMuted,
        fontSize: ROW_FONT_SIZE,
        lineHeight: ROW_LINE_HEIGHT,
        opacity: growing ? 0.95 : 0.7,
      },
      full: {
        marginLeft: BODY_INDENT,
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
      accessibilityLabel={open ? copy.collapseThinking : copy.expandThinking}
      onPress={() => setManual((value) => !(value ?? false))}
      style={styles.root}
    >
      <View style={styles.row}>
        <Image
          source={{ uri: THINK_ICON }}
          style={{ width: 16, height: 16 }}
          tintColor={theme.colors.foregroundMuted}
        />
        <TextShimmer
          active={growing && !open}
          contentStyle={styles.textRow}
          highlightColor={theme.colors.foreground}
          surfaceColor={theme.colors.surface0}
        >
          {(color) => (
            <>
              {/* DSH titles every reasoning row "思考" (its English table says
                  "Thinking") and never swaps it for a finished form; the
                  "已思考" string it ships belongs to its collapsed whole-turn
                  summary, not to this row. */}
              <Text style={[styles.label, color === null ? null : { color }]}>{copy.thinking}</Text>
              {!open ? (
                <Text
                  style={[styles.line, color === null ? null : { color }]}
                  numberOfLines={1}
                  onLayout={(event) => setBoxWidth(event.nativeEvent.layout.width)}
                >
                  {line}
                </Text>
              ) : null}
            </>
          )}
        </TextShimmer>
      </View>
      {open ? (
        // Render the raw source, not the paced reveal: a per-frame re-render of
        // a very long thought is what froze the app before.
        <Text style={styles.full}>{text}</Text>
      ) : null}
    </Pressable>
  );
}
