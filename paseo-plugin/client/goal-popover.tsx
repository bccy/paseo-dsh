/**
 * The goal popover's body: a **Paseo row-style panel**, not a card of buttons.
 *
 * The first revision drew the actions as three large rounded buttons. On a real
 * iOS device the user reported that (a) the buttons did not look like Paseo,
 * (b) tapping 编辑 showed no input, and (c) the objective wrapped to two lines.
 * This revision follows the survey's plan C: the host's own menu-row grammar —
 * an icon + title row per action, no fills, no borders — with the goal header
 * truncated to one line and the edit field in place of its row.
 *
 * **Why the old edit field was invisible on iOS.** It was a bare React Native
 * `TextInput` (`react-native`'s, imported in the previous version of this file)
 * placed inside the host's compact bottom sheet. The host's own text field is
 * `SheetAwareTextInput`, which renders `@gorhom/bottom-sheet`'s
 * `BottomSheetTextInput` when it is inside a sheet on native
 * (`packages/app/src/components/ui/text-input/sheet-aware.tsx:17-25`); that
 * component registers focus with the sheet. The host's sheet uses
 * `keyboardBehavior="interactive"` with a content-sized sheet precisely so the
 * keyboard moves the sheet up instead of covering the field
 * (`packages/app/src/components/ui/menu/menu-surface.tsx:420-424`). A bare RN
 * `TextInput` never registers, so the sheet does not move and the keyboard
 * covers the new field — on the device it looks like "no edit box appeared".
 * The fix is to use the plugin UI kit's `TextInput`, which is that same
 * sheet-aware component (`packages/app/src/plugins/react-native/ui.ts:25`).
 *
 * **The layout.** Top to bottom: the DeepSeek mark + the objective on one line
 * (truncated; the full text appears in the edit field when editing), the status
 * line (8px tone dot + phase word · round budget), the optional "now" line, the
 * blocker / disarmed hint / error lines, the action rows, and the one-line
 * footnote. The edit row replaces itself with an inline single-line field and
 * two text actions (save / cancel); the clear row switches to its confirmation
 * state (red "confirm clear" + cancel). Both rows keep the row grammar — no
 * button chrome.
 *
 * @module dsh-paseo/client/goal-popover
 */
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon, TextInput as UiTextInput } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { GoalAction, GoalState } from "../shared/goal";
import { DeepSeekMark } from "./deepseek-mark";
import {
  GOAL_BODY_GAP,
  GOAL_MARK_GAP,
  GOAL_MARK_SIZE,
  GOAL_OBJECTIVE_MAX_LINES,
  goalActionIcon,
  goalActionLabel,
  goalActionsFor,
  goalCurrentTaskLine,
  goalEditDraftValid,
  goalPillPresentation,
  goalStatusDotColorToken,
  goalStatusLine,
  goalToneColorToken,
} from "./goal-polling";
import {
  FACTS_FONT_SIZE,
  POPOVER_HOST_PADDING,
  ROW_GAP,
  TITLE_FONT_SIZE,
  rowActiveFill,
  rowBox,
  rowTextColumn,
  popoverRootBox,
} from "./jobs-popover-layout";
import type { GoalText } from "./locale";

/** The host's popover theme slot, so the type is not spelled at every call. */
type PopoverTheme = PluginButtonContentProps["theme"];

/** The host's hover/press callback state, as `jobs-pill.tsx` reads it. */
type HoverState = PressableStateCallbackType & { hovered?: boolean };

/** A disabled control's opacity, matching the host's disabled button. */
const BUSY_OPACITY = 0.5;

/**
 * One action row: icon + title, drawn with the same `rowBox` the jobs popover
 * uses (32px tall on wide layouts, 40px on the phone sheet — the touch floor).
 *
 * No background at rest and no border; hover/press paints the host's row fill
 * (`rowActiveFill`), exactly like the host's menu rows. The destructive label
 * turns red only in its confirmation state.
 */
function ActionRow({
  action,
  label,
  compact,
  danger,
  disabled,
  theme,
  onPress,
}: {
  action: GoalAction;
  label: string;
  compact: boolean;
  danger: boolean;
  disabled: boolean;
  theme: PopoverTheme;
  onPress: () => void;
}) {
  const box = rowBox({ compact });
  const style = ({ hovered = false, pressed }: HoverState) => {
    const fill = rowActiveFill(hovered, pressed);
    return {
      ...box,
      backgroundColor: fill === undefined ? "transparent" : theme.colors[fill],
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
      style={style}
    >
      <Icon
        name={goalActionIcon(action)}
        size={14}
        color={danger ? theme.colors.statusDanger : theme.colors.foregroundMuted}
      />
      <Text
        numberOfLines={1}
        style={{
          ...rowTextColumn(),
          fontSize: TITLE_FONT_SIZE,
          color: danger ? theme.colors.statusDanger : theme.colors.foreground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** One lightweight text action (save / cancel), with no button chrome. */
function TextAction({
  label,
  tone,
  disabled,
  theme,
  onPress,
}: {
  label: string;
  tone: "accent" | "muted" | "danger";
  disabled?: boolean;
  theme: PopoverTheme;
  onPress: () => void;
}) {
  const color =
    tone === "accent"
      ? theme.colors.accent
      : tone === "danger"
        ? theme.colors.statusDanger
        : theme.colors.foregroundMuted;
  return (
    <Pressable
      onPress={disabled === true ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      style={{ paddingHorizontal: 4, paddingVertical: 4, opacity: disabled === true ? BUSY_OPACITY : 1 }}
    >
      <Text style={{ fontSize: FACTS_FONT_SIZE, color }}>{label}</Text>
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
  /** One control action is in flight; every row is disabled meanwhile. */
  busy: boolean;
  /** DSH's refusal sentence, shown in place and never auto-cleared. */
  error?: string;
  /** The 清除 row has been clicked once and waits for confirmation. */
  clearArmed: boolean;
  /** The edit row is open. */
  editing: boolean;
  /** The edit field's current text. */
  draft: string;
  onAction: (action: GoalAction) => void;
  onChangeDraft: (text: string) => void;
  onSubmitEdit: () => void;
  onCancelEdit: () => void;
  onCancelClear: () => void;
}

/**
 * The popover body. Pure: the same props always render the same tree, which is
 * what lets the offline preview render the real component for the screenshots
 * and the render harness assert the edit/clear states as DOM, not regexes.
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
  onCancelEdit,
  onCancelClear,
}: GoalPopoverBodyProps) {
  const presentation = goalPillPresentation({ available: true, goal });
  const tone = presentation.visible ? presentation.tone : "warning";
  const statusColor = theme.colors[goalToneColorToken(tone)];
  const statusDot = theme.colors[goalStatusDotColorToken(tone)];
  const actions = goalActionsFor(goal);
  const currentTask = goalCurrentTaskLine(goal);
  const disarmed = goal.phase === "active" && goal.activation === "disarmed";
  const box = rowBox({ compact });
  const root = {
    ...popoverRootBox(),
    paddingHorizontal: POPOVER_HOST_PADDING,
    paddingVertical: 4,
    gap: GOAL_BODY_GAP,
  } as const;

  return (
    <View style={root}>
      {/* The DeepSeek mark stays on the header line; the objective is one line
          (truncated) — the full text is what the edit field pre-fills. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: GOAL_MARK_GAP }}>
        <DeepSeekMark size={GOAL_MARK_SIZE} />
        <Text
          numberOfLines={GOAL_OBJECTIVE_MAX_LINES}
          style={{ flex: 1, minWidth: 0, fontSize: TITLE_FONT_SIZE, color: theme.colors.foreground }}
        >
          {goal.objective}
        </Text>
      </View>

      {/* Status: dot + "phase · round budget" on one line. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: statusDot,
          }}
        />
        <Text style={{ fontSize: FACTS_FONT_SIZE, color: statusColor }}>
          {goalStatusLine(goal, text.statuses, text.rounds)}
        </Text>
      </View>
      {currentTask === undefined ? null : (
        <Text numberOfLines={1} style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
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
      {error === undefined ? null : (
        <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.statusDanger }}>{error}</Text>
      )}

      {/* One row per action, in semantic order: primary, edit, clear. The edit
          row becomes the inline field in place; the clear row becomes its
          confirmation in place. No fills, no borders. The rows sit tight
          together (2px) like the host's menu list; the 8px body rhythm is kept
          between the sections around them. */}
      <View style={{ gap: 2 }}>
      {actions.map((action) => {
        if (action === "edit" && editing) {
          return (
            <View key={action} style={{ ...box, gap: ROW_GAP }}>
              <UiTextInput
                value={draft}
                onChangeText={onChangeDraft}
                onSubmitEditing={onSubmitEdit}
                placeholder={text.editPlaceholder}
                placeholderTextColor={theme.colors.foregroundMuted}
                returnKeyType="done"
                autoFocus
                accessibilityLabel={text.editPlaceholder}
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                  flexBasis: "auto",
                  minWidth: 0,
                  fontSize: TITLE_FONT_SIZE,
                  color: theme.colors.foreground,
                  paddingVertical: 2,
                }}
              />
              <TextAction
                label={text.actions.save}
                tone="accent"
                disabled={busy || !goalEditDraftValid(draft)}
                theme={theme}
                onPress={onSubmitEdit}
              />
              <TextAction label={text.actions.cancel} tone="muted" theme={theme} onPress={onCancelEdit} />
            </View>
          );
        }
        if (action === "clear" && clearArmed) {
          return (
            <View key={action} style={{ ...box, gap: ROW_GAP }}>
              <Icon name="Trash2" size={14} color={theme.colors.statusDanger} />
              <Pressable
                onPress={() => {
                  onAction("clear");
                }}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={text.actions.confirmClear}
                style={{ ...rowTextColumn(), paddingVertical: 2 }}
              >
                <Text numberOfLines={1} style={{ fontSize: TITLE_FONT_SIZE, color: theme.colors.statusDanger }}>
                  {text.actions.confirmClear}
                </Text>
              </Pressable>
              <TextAction label={text.actions.cancel} tone="muted" theme={theme} onPress={onCancelClear} />
            </View>
          );
        }
        return (
          <ActionRow
            key={action}
            action={action}
            label={goalActionLabel(action, clearArmed, text.actions)}
            compact={compact}
            danger={false}
            disabled={busy}
            theme={theme}
            onPress={() => {
              onAction(action);
            }}
          />
        );
      })}
      </View>
      <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
        {text.footnote}
      </Text>
    </View>
  );
}
