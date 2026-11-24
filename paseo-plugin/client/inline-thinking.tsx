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
 * arriving and `complete` has held for a short window (`useGrowing`).
 *
 * The text is used **as it arrives**, never through the host's paced reveal
 * (`useRevealedText`). That hook re-plays the reasoning at a rate it owns — its
 * signature takes no speed — so the collapsed preview trailed the expanded one,
 * which always read the raw text. dsh web applies the same preview rule to the
 * live text; this row now does too.
 *
 * @module dsh-paseo/client/inline-thinking
 */
import { useSettings, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import {
  EXPANDED_MAX_HEIGHT_DEFAULT,
  THINKING_STYLE_DEFAULT,
  TIMELINE_STYLE_DEFAULTS,
  isThinkingStyleChoice,
  timelineStyleSettings,
  type ThinkingStyleChoice,
} from "../shared/settings";
import { normalizeRowTimestamp, noteRender } from "./newest";
import {
  RowEntrance,
  SCROLL_BOX_TEST_ID,
  renderInkTrailText,
  shouldCollapseOnBodyPress,
  useInkStreamReveal,
} from "./row-entrance";
import { RowStatusIcon, resolveThinkingIconStatus } from "./row-status-icon";
import { TextShimmer } from "./text-shimmer";
import { EnhancedThinkingView } from "./thinking-styles";
import { reasoningPreview, streamingTail } from "./thinking-text";
import { BODY_INDENT, ROW_FONT_SIZE, ROW_GAP, ROW_LINE_HEIGHT } from "./tokens";
import { useLocaleText } from "./use-locale";

/**
 * DSH's thinking icon (`PROCESS_ICONS.thinking` = `IconThinkOutlineRegular`:
 * two petals crossed on the diagonal plus a filled centre dot, `viewBox 16`,
 * 1px stroke, drawn at 16). Rasterized at exactly 4x and shown at 16 so the
 * stroke lands on whole pixels; `tintColor` replaces `currentColor`.
 */
const THINK_ICON = "data:image/png;base64,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";

/** The row icon is drawn at 16, matching every other row head. */
const THINK_ICON_SIZE = 16;

export interface InlineThinkingData {
  text: string;
  phase: "streaming" | "complete";
}



/**
 * How long `complete` has to hold before the row stops scrolling.
 *
 * `phase` is derived from a per-item status that flips between loading and
 * ready as chunks settle (`docs/FIELD-NOTES.md` #26), so a **single** complete
 * frame is not proof the thought is over: settling on it makes the sweep stop
 * and restart while the model is still thinking. A short stable window is the
 * middle ground — a further frame clears it, and once the text really has
 * stopped the timer itself settles the row, without needing one more host
 * update (which is the defect this replaced: the effect deps only change when
 * text or phase changes, so a `grew && complete` last frame latched the row on
 * forever).
 */
const SETTLE_WINDOW_MS = 300;

/**
 * Track "still producing text" without trusting the flickering `phase`.
 *
 * Any growth latches the row on. It settles when the text stopped growing and
 * `complete` has held for {@link SETTLE_WINDOW_MS}; every new frame re-runs the
 * effect, which cancels the pending settle and demands the window again.
 */
function useGrowing(text: string, phase: "streaming" | "complete"): boolean {
  const [growing, setGrowing] = useState(phase === "streaming");
  const lastLength = useRef(text.length);
  useEffect(() => {
    const grew = text.length > lastLength.current;
    lastLength.current = text.length;
    if (grew) setGrowing(true);
    if (phase !== "complete") return;
    const timer = setTimeout(() => setGrowing(false), SETTLE_WINDOW_MS);
    // Runs on unmount and before the next frame's effect, so a timer never
    // outlives the row and a stream that continues never settles.
    return () => clearTimeout(timer);
  }, [text, phase]);
  return growing;
}

export function InlineThinking({
  theme,
  layout,
  agentId,
  timestamp,
  item,
}: PluginTimelineItemProps<InlineThinkingData>) {
  const { text, phase } = item.data;
  const growing = useGrowing(text, phase);
  const rowAt = normalizeRowTimestamp(timestamp);
  if (typeof agentId === "string" && agentId !== "" && rowAt !== 0) {
    noteRender(agentId, rowAt);
  }
  const rowKey = rowAt !== 0 ? `thinking:${rowAt}` : undefined;
  // The width the preview line has to work with, derived from its ancestors.
  //
  // Measuring the line itself does not work: the sweep container is
  // content-sized (the web build pins `width: max-content` on it, the native
  // sweep is sized by its content), so a `flex: 1` child inside it has no
  // definite basis and reports its own content width — a feedback loop that
  // collapsed the window to a couple of characters on the desktop client while
  // the settled row (which needs no width) looked fine. The row and the label are
  // both definite, so the line is what is left over.
  const styleState = useSettings(timelineStyleSettings);
  const style = styleState.status === "ready" ? styleState.values : TIMELINE_STYLE_DEFAULTS;
  const expandedMaxHeight =
    "expandedMaxHeight" in style &&
    typeof (style as { expandedMaxHeight?: unknown }).expandedMaxHeight === "number"
      ? (style as { expandedMaxHeight: number }).expandedMaxHeight
      : EXPANDED_MAX_HEIGHT_DEFAULT;
  const thinkingStyle: ThinkingStyleChoice = isThinkingStyleChoice(style.thinkingStyle)
    ? style.thinkingStyle
    : THINKING_STYLE_DEFAULT;
  const [rowWidth, setRowWidth] = useState(0);
  const [labelWidth, setLabelWidth] = useState(0);
  const lineWidth = Math.max(
    0,
    rowWidth - THINK_ICON_SIZE - style.toolRowGap - labelWidth - style.toolRowGap,
  );
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? false;
  const collapseBody = (event?: unknown) => {
    if (shouldCollapseOnBodyPress(event)) setManual(false);
  };
  // Subscribe via `useLocaleText()` so host-relayed or settings-driven locale
  // changes re-render the label and screen-reader strings live.
  const copy = useLocaleText();


  const isClassic = thinkingStyle === "classic";

  // While streaming the collapsed line is a **tail window**: it advances with
  // every arrived character instead of waiting for a paragraph to finish, which
  // is what made it lag the expanded view. Before the box has been measured (the
  // very first frame) and once the thought settles, dsh's own rule applies —
  // the latest completed paragraph's first line, then the first line outright.
  const line = isClassic
    ? growing && lineWidth > 0
      ? streamingTail(text, lineWidth, ROW_FONT_SIZE)
      : reasoningPreview(text, growing)
    : "";
  const tailSliding = isClassic && growing && lineWidth > 0 && line.startsWith("…");
  const stream = useInkStreamReveal({
    agentId,
    timestamp,
    rowKey,
    liveHint: isClassic && (phase === "streaming" || growing),
    label: isClassic ? copy.thinking : "",
    summary: isClassic && !open && !tailSliding ? line : "",
    streamSummary: isClassic && !open && !tailSliding,
    enabled: isClassic,
  });

  const styles = useMemo(() => {
    const rowLineHeight = Math.min(ROW_LINE_HEIGHT, style.toolRowMinHeight);
    return {
      // DSH renders a thought and a tool call through the same DisclosureRow, so
      // the two rows must not disagree about their rhythm: same 24px line, same
      // head gap, no vertical padding of their own (overridable via settings).
      root: {
        gap: ROW_GAP,
        marginVertical: style.rowMarginY,
        paddingVertical: style.toolRowPaddingY,
      },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: style.toolRowGap,
        minHeight: style.toolRowMinHeight,
      },
      textRow: {
        flex: 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: style.toolRowGap,
      },
      label: {
        color: theme.colors.foregroundMuted,
        fontSize: ROW_FONT_SIZE,
        lineHeight: rowLineHeight,
        opacity: growing ? 0.9 : 0.6,
      },
      line: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.foregroundMuted,
        fontSize: ROW_FONT_SIZE,
        lineHeight: rowLineHeight,
        opacity: growing ? 0.95 : 0.7,
      },
      fullScroll: {
        maxHeight: expandedMaxHeight,
      },
      full: {
        marginLeft: BODY_INDENT,
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 13 : 14,
        lineHeight: layout.compact ? 19 : 21,
        opacity: 0.8,
      },
    };
  }, [theme, layout.compact, growing, style, expandedMaxHeight]);

  const toggleOpen = () => setManual((value) => !(value ?? false));

  if (thinkingStyle !== "classic") {
    return (
      <RowEntrance
        agentId={agentId}
        timestamp={timestamp}
        rowKey={rowKey}
        liveHint={phase === "streaming" || growing}
      >
        <EnhancedThinkingView
          variant={thinkingStyle}
          text={text}
          growing={growing}
          open={open}
          onToggle={toggleOpen}
          onCollapse={collapseBody}
          colors={theme.colors}
          compact={layout.compact}
          iconUri={THINK_ICON}
          iconSize={THINK_ICON_SIZE}
          rowMarginY={style.rowMarginY}
          rowPaddingY={style.toolRowPaddingY}
          rowMinHeight={style.toolRowMinHeight}
          rowGap={style.toolRowGap}
          expandedMaxHeight={expandedMaxHeight}
          copy={copy}
        />
      </RowEntrance>
    );
  }

  return (
    <RowEntrance
      agentId={agentId}
      timestamp={timestamp}
      rowKey={rowKey}
      liveHint={phase === "streaming" || growing}
    >
      <View style={styles.root}>
        {/* The head row toggles open/closed; the expanded body sits beside it in
            its own bounded ScrollView so scrolling long thoughts never competes
            with tapping the toggle or pushes the timeline off screen. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? copy.collapseThinking : copy.expandThinking}
          onPress={toggleOpen}
          style={styles.row}
          onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
        >
          <RowStatusIcon
            status={resolveThinkingIconStatus(growing)}
            size={THINK_ICON_SIZE}
            colors={theme.colors}
            spinBase
          >
            <Image
              source={{ uri: THINK_ICON }}
              style={{ width: THINK_ICON_SIZE, height: THINK_ICON_SIZE }}
              tintColor={theme.colors.foregroundMuted}
            />
          </RowStatusIcon>
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
                <Text
                  style={[styles.label, color === null ? null : { color }]}
                  onLayout={(event) => setLabelWidth(event.nativeEvent.layout.width)}
                >
                  {renderInkTrailText(copy.thinking, stream.labelProgress, theme.colors.foreground, color)}
                </Text>
                {!open ? (
                  <Text
                    style={[styles.line, color === null ? null : { color }]}
                    numberOfLines={1}
                  >
                    {renderInkTrailText(line, stream.summaryProgress, theme.colors.foreground, color)}
                  </Text>
                ) : null}
              </>
            )}
          </TextShimmer>
        </Pressable>
        {open ? (
          // Render the raw source, not the paced reveal: a per-frame re-render of
          // a very long thought is what froze the app before. Wrapping the inner
          // content in a Pressable lets short taps collapse the scroll box while
          // scroll gestures still pan smoothly on iOS/Android/Web.
          <ScrollView
            style={styles.fullScroll}
            nestedScrollEnabled
            testID={SCROLL_BOX_TEST_ID}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.collapseThinking}
              onPress={collapseBody}
            >
              <Text style={styles.full} selectable>
                {text}
              </Text>
            </Pressable>
          </ScrollView>
        ) : null}
      </View>
    </RowEntrance>
  );
}
