/**
 * The goal popover's body: the objective, its state, the round budget, the
 * current task, and the action row.
 *
 * Split out of `goal-pill.tsx` as a **pure presentational component**: the pill
 * module owns the store, the RPCs and the interaction state (busy / error /
 * clear-armed / editing), this file owns only what is drawn. Two reasons:
 *
 * - the layout rules are values in `client/goal-polling.ts` (button geometry,
 *   palette, min width, row layout), so the harness can assert them directly
 *   instead of regex-matching this file's JSX — the previous version's
 *   right-alignment assertion was satisfied by a doc comment here and stayed
 *   green after the rule was deleted (verification round F1);
 * - the harness can render this component with the real host theme tokens,
 *   which is how the desktop/mobile screenshots are produced.
 *
 * **The layout (方案 A, 2026-11-03).** Top to bottom: the DeepSeek mark + the
 * full objective, the status line (an 8px tone dot + the phase word), the
 * round-budget line, the "now" line (only when DSH's todo list has an
 * `in_progress` item), the blocker / disarmed hint / error lines, the edit
 * field, the action row, and the one-line footnote.
 *
 * **The action row.** Right-aligned (`goalActionRowStyle`), order
 * `[清除][编辑][主操作]`: the primary action is last and the only accent fill,
 * the destructive 清除 sits furthest from it on the far left. Sizes follow the
 * host's sm (desktop popover) / md (phone sheet) geometry, so the phone's touch
 * targets meet the 44px floor.
 *
 * **The destructive confirmation.** The first click arms 清除: its label
 * switches to 确认清除 / Confirm and its palette turns red (outline + text, not a
 * fill — the fill measured 2.80:1 in the dark theme). The button's width is
 * pinned by `goalButtonMinWidth`, so the label switch cannot move the row.
 *
 * @module dsh-paseo/client/goal-popover
 */
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Platform, Pressable, Text, TextInput, View, type PressableStateCallbackType } from "react-native";
import type { GoalAction, GoalState } from "../shared/goal";
import { DeepSeekMark } from "./deepseek-mark";
import {
  GOAL_BODY_GAP,
  GOAL_MARK_GAP,
  GOAL_MARK_SIZE,
  GOAL_MARK_TOP_OFFSET,
  GOAL_OBJECTIVE_LINE_HEIGHT,
  goalActionLabel,
  goalActionRowStyle,
  goalActionsFor,
  goalButtonGeometry,
  goalButtonMinWidth,
  goalButtonPalette,
  goalButtonRow,
  goalButtonVariant,
  goalCurrentTaskLine,
  goalPillPresentation,
  goalStatusDotColorToken,
  goalToneColorToken,
  type GoalButtonGeometry,
} from "./goal-polling";
import { FACTS_FONT_SIZE, POPOVER_HOST_PADDING, TITLE_FONT_SIZE, popoverRootBox } from "./jobs-popover-layout";
import type { GoalText } from "./locale";

/** The host's popover theme slot, so the type is not spelled at every call. */
type PopoverTheme = PluginButtonContentProps["theme"];

/** The host's hover/press callback state, as `jobs-pill.tsx` reads it. */
type HoverState = PressableStateCallbackType & { hovered?: boolean };

/** A disabled control's opacity, matching the host's disabled button. */
const BUSY_OPACITY = 0.5;

/** The edit field's inner padding. */
const FIELD_PADDING_HORIZONTAL = 8;
const FIELD_PADDING_VERTICAL = 6;

/** The status line's dot size and its gap to the word. */
const STATUS_DOT_SIZE = 8;
const STATUS_DOT_GAP = 6;

/**
 * One action button, drawn to the host's Button geometry and palette.
 *
 * A `Pressable` is the only button primitive the plugin bundle has (the host's
 * `Button` is not exported to plugins), so this reproduces its look from
 * `goalButtonPalette` — including the **1px border every variant carries**, so
 * arming the destructive button cannot change its width.
 *
 * `minWidth` is the row's shared pinned outer width (see `goalButtonMinWidth`):
 * every button is the same width, so the destructive button's longer
 * confirmation label cannot resize it and the row reads as a deliberate
 * equal-width layout instead of one oversized control.
 */
function ActionButton({
  label,
  variant,
  geometry,
  minWidth,
  disabled,
  theme,
  onPress,
}: {
  label: string;
  variant: ReturnType<typeof goalButtonVariant>;
  geometry: GoalButtonGeometry;
  minWidth?: number;
  disabled: boolean;
  theme: PopoverTheme;
  onPress: () => void;
}) {
  const colors = {
    foreground: theme.colors.foreground,
    foregroundMuted: theme.colors.foregroundMuted,
    surface1: theme.colors.surface1,
    accent: theme.colors.accent,
    accentForeground: theme.colors.accentForeground,
    statusDanger: theme.colors.statusDanger,
  } as const;
  // The text colour does not depend on hover/press (only the fill and the
  // outline do), so it is resolved once for the label.
  const labelColor = goalButtonPalette(variant, colors, { hovered: false, pressed: false }).color;
  const style = ({ hovered = false, pressed }: HoverState) => {
    const palette = goalButtonPalette(variant, colors, { hovered, pressed });
    return {
      minHeight: geometry.height,
      minWidth,
      paddingHorizontal: geometry.paddingHorizontal,
      borderRadius: geometry.borderRadius,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.backgroundColor,
      borderWidth: palette.borderWidth,
      borderColor: palette.borderColor,
      opacity: disabled ? BUSY_OPACITY : 1,
    } as const;
  };
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      {...(Platform.OS === "web" ? { "aria-disabled": disabled } : null)}
      style={style}
    >
      <Text numberOfLines={1} style={{ fontSize: geometry.fontSize, color: labelColor }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Everything the popover body draws. State and RPCs stay in `goal-pill.tsx`. */
export interface GoalPopoverBodyProps {
  goal: GoalState;
  text: GoalText;
  theme: PopoverTheme;
  /** The host's compact layout flag (phone sheet). */
  compact: boolean;
  /** One control action is in flight; every button is disabled meanwhile. */
  busy: boolean;
  /** DSH's refusal sentence, shown in place and never auto-cleared. */
  error?: string;
  /** The 清除 button has been clicked once and waits for confirmation. */
  clearArmed: boolean;
  /** The edit field is open. */
  editing: boolean;
  /** The edit field's current text. */
  draft: string;
  onAction: (action: GoalAction) => void;
  onChangeDraft: (text: string) => void;
  onSubmitEdit: () => void;
}

/**
 * The popover body. Pure: the same props always render the same tree, which is
 * what lets the offline preview render the real component for the screenshots.
 */
export function GoalPopoverBody({
  goal,
  text,
  theme,
  compact,
  busy,
  error,
  clearArmed,
  editing,
  draft,
  onAction,
  onChangeDraft,
  onSubmitEdit,
}: GoalPopoverBodyProps) {
  const presentation = goalPillPresentation({ available: true, goal });
  const tone = presentation.visible ? presentation.tone : "warning";
  const statusColor = theme.colors[goalToneColorToken(tone)];
  const statusDot = theme.colors[goalStatusDotColorToken(tone)];
  const geometry = goalButtonGeometry(compact);
  const actions = goalButtonRow(goalActionsFor(goal));
  const currentTask = goalCurrentTaskLine(goal);
  const disarmed = goal.phase === "active" && goal.activation === "disarmed";
  // Every button in the row shares one pinned width, sized for the wider of the
  // destructive button's two labels: 清除 → 确认清除 cannot move the row, and the
  // row is a deliberate equal-width layout (verification round 4a/N1) instead of
  // one oversized destructive control.
  const buttonMinWidth = goalButtonMinWidth([text.actions.clear, text.actions.confirmClear], geometry);
  const root = {
    ...popoverRootBox(),
    paddingHorizontal: POPOVER_HOST_PADDING,
    paddingVertical: 4,
    gap: GOAL_BODY_GAP,
  } as const;

  return (
    <View style={root}>
      {/* The DeepSeek mark sits on the first line of the objective: the trigger
          only carries the neutral noun, so this is where the brand shows. */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: GOAL_MARK_GAP }}>
        <View style={{ marginTop: GOAL_MARK_TOP_OFFSET }}>
          <DeepSeekMark size={GOAL_MARK_SIZE} />
        </View>
        <Text
          selectable
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: TITLE_FONT_SIZE,
            lineHeight: GOAL_OBJECTIVE_LINE_HEIGHT,
            color: theme.colors.foreground,
          }}
        >
          {goal.objective}
        </Text>
      </View>

      {/* Status: an 8px tone dot plus the phase word. The dot is the colour
          channel (accent / warning / danger) — the word stays in a text colour
          that meets AA in both themes. The round budget is the next line, never
          a fraction beside the phase (it is a budget, not progress). */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: STATUS_DOT_GAP }}>
        <View
          style={{
            width: STATUS_DOT_SIZE,
            height: STATUS_DOT_SIZE,
            borderRadius: STATUS_DOT_SIZE / 2,
            backgroundColor: statusDot,
          }}
        />
        <Text style={{ fontSize: FACTS_FONT_SIZE, color: statusColor }}>
          {text.statuses[goal.phase] ?? goal.phase}
        </Text>
      </View>
      <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
        {text.rounds(goal.roundsStarted, goal.maxGoalRounds)}
      </Text>
      {currentTask === undefined ? null : (
        <Text numberOfLines={1} style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foreground }}>
          {text.currentTask(currentTask)}
        </Text>
      )}
      {goal.blockedReason === undefined ? null : (
        <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.statusDanger }}>
          {text.blocker(goal.blockedReason.code, goal.blockedReason.message)}
        </Text>
      )}
      {disarmed ? (
        <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.statusWarning }}>
          {text.disarmedHint}
        </Text>
      ) : null}
      {editing ? (
        <TextInput
          value={draft}
          onChangeText={onChangeDraft}
          onSubmitEditing={onSubmitEdit}
          placeholder={text.editPlaceholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          returnKeyType="done"
          autoFocus
          accessibilityLabel={text.editPlaceholder}
          style={{
            fontSize: FACTS_FONT_SIZE,
            color: theme.colors.foreground,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: geometry.borderRadius,
            paddingHorizontal: FIELD_PADDING_HORIZONTAL,
            paddingVertical: FIELD_PADDING_VERTICAL,
          }}
        />
      ) : null}
      {error === undefined ? null : (
        <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.statusDanger }}>{error}</Text>
      )}

      {/* Right-aligned: the primary action is last, at the right edge, and is
          the only accent fill. 清除 stays on the far left, away from it. */}
      <View style={goalActionRowStyle(geometry)}>
        {actions.map((action) => (
          <ActionButton
            key={action}
            label={goalActionLabel(action, clearArmed, text.actions)}
            variant={goalButtonVariant(action, clearArmed)}
            geometry={geometry}
            minWidth={buttonMinWidth}
            disabled={busy}
            theme={theme}
            onPress={() => {
              onAction(action);
            }}
          />
        ))}
      </View>
      {busy ? (
        <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
          {text.busy}
        </Text>
      ) : null}
      {/* One line now (the old footnote was two sentences over two lines): the
          product answer to "can I still send a message?" without the height. */}
      <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
        {text.footnote}
      </Text>
    </View>
  );
}
