/**
 * The goal popover's body: a **Paseo track panel**, not a card of buttons.
 *
 * The user's design (design-opus-v3) is the specification; this file implements
 * it with the geometry of the host's own rows, value for value:
 *
 * - **The objective row** is a `ComposerTrackRow` (`composer/tracks.tsx:347-379`:
 *   32px / 40px compact, 4px inset, 8px padding, 6px radius) whose whole body is
 *   the edit entry. It carries the whale, the objective on **one** truncated line
 *   (`numberOfLines={1}`), a facts line (`进行中 · 第 3 轮 · 预算 10`) and two
 *   row-end icon buttons — pause/continue and clear. There is no edit button: the
 *   row itself is the edit affordance (hover/press fills `surface2`, the host's
 *   `rowActive`), which is how the host's pressable track rows read.
 * - **The "now" row** is a track row with a `CircleDot` and the current todo.
 * - **Blocked / disarmed / error** are the design's one-line rows and hint.
 * - **Edit** replaces the objective row **in place** with a multi-line field in
 *   `MenuTextField`'s box (`menu-item.tsx:441` + `:457-478`: `surface2`, 1px
 *   border, 6px radius), then a separator and two menu rows, 保存 and 取消. The
 *   caret starts at offset 0 so a long goal is read from its start; Enter saves,
 *   Escape cancels, and **blur never saves** — a long objective is too expensive
 *   to change by accident.
 * - **Clear** is an in-place confirmation page (hint, separator, red 清除目标
 *   row, 取消 row). Red appears only after the user has said they want to clear.
 * - **Running**: the whale carries the host's status ring in its bottom-right
 *   corner (offset -5, 14px frame, row-colour knockout), exactly as the host's
 *   `StatusIcon` overlays a provider icon.
 *
 * The panel root cancels `PluginPopoverContent`'s 12px padding with a -12 margin
 * (`popoverRootBox`), which is what lets rows sit on the host's 4px rail; the
 * old panel kept that padding and read as inset content rather than rows.
 *
 * @module dsh-paseo/client/goal-popover
 */
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon, TextInput as UiTextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { GoalState } from "../shared/goal";
import { DeepSeekMark } from "./deepseek-mark";
import {
  GOAL_EDITOR_MIN_HEIGHT,
  GOAL_EDITOR_WIDTH_WIDE,
  GOAL_FACTS_LINE_HEIGHT,
  GOAL_HINT_PADDING_HORIZONTAL,
  GOAL_HINT_PADDING_VERTICAL,
  GOAL_OBJECTIVE_LINE_HEIGHT,
  GOAL_RING_FRAME_SIZE,
  GOAL_RING_OFFSET,
  GOAL_SEPARATOR_HEIGHT,
  GOAL_SEPARATOR_MARGIN_VERTICAL,
  GOAL_WHALE_SIZE,
  goalCurrentTaskLine,
  goalEditSubmittable,
  goalFactsLine,
  goalIconButton,
  goalMenuItem,
  goalTrackRow,
} from "./goal-polling";
import {
  FACTS_FONT_SIZE,
  TITLE_FONT_SIZE,
  popoverRootBox,
  ringColorFor,
} from "./jobs-popover-layout";
import type { GoalText } from "./locale";
import { StatusRingMark } from "./status-ring";

/** The host's popover theme slot, so the type is not spelled at every call. */
type PopoverTheme = PluginButtonContentProps["theme"];

/** The host's hover/press callback state, as `jobs-pill.tsx` reads it. */
type HoverState = PressableStateCallbackType & { hovered?: boolean };

/** The panel's three in-place pages. */
export type GoalPanelMode = "view" | "edit" | "confirm";

/** A disabled control's opacity, matching the host's disabled button. */
const BUSY_OPACITY = 0.5;

/**
 * The whale with the running ring on its bottom-right corner.
 *
 * The host's `StatusIcon` (`components/status-icon.tsx:59-70`) overlays a 14px
 * ring frame at `getStatusRingOffset(-2, 8)` = -5 and fills the frame with the
 * row's own background so the ring punches a hole in the icon instead of sitting
 * on a square patch. `backdrop` is that fill: the row's surface at rest, or
 * `surface2` while the row is hovered/pressed.
 */
function Whale({
  running,
  theme,
  backdrop,
  label,
}: {
  running: boolean;
  theme: PopoverTheme;
  backdrop: string;
  label: string;
}) {
  return (
    <View style={{ width: GOAL_WHALE_SIZE, height: GOAL_WHALE_SIZE, flexShrink: 0 }}>
      <DeepSeekMark size={GOAL_WHALE_SIZE} />
      {running ? (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={label}
          style={{
            position: "absolute",
            right: GOAL_RING_OFFSET,
            bottom: GOAL_RING_OFFSET,
            width: GOAL_RING_FRAME_SIZE,
            height: GOAL_RING_FRAME_SIZE,
            borderRadius: GOAL_RING_FRAME_SIZE / 2,
            backgroundColor: backdrop,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <StatusRingMark size={GOAL_RING_FRAME_SIZE} color={ringColorFor(theme.colors.surface0)} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * One row-end icon button: `ToolbarButton`'s box at the host's sizes (20×20 with
 * a 14px glyph on pointer layouts, 32×32 with an 18px glyph under a finger),
 * hover filled `surface2` because the plugin theme has no `interactionHighlight`.
 *
 * The press must **not** bubble into the row's own press (the row opens the
 * editor): the host's rule for nested controls (`providers-section.tsx`'s
 * `stopPropagation`) is applied here.
 */
function IconButton({
  name,
  glyph,
  size,
  color,
  disabled,
  theme,
  label,
  onPress,
}: {
  name: "Pause" | "Play" | "Trash2";
  glyph: number;
  size: number;
  color: string;
  disabled: boolean;
  theme: PopoverTheme;
  label: string;
  onPress: () => void;
}) {
  const style = ({ hovered = false, pressed }: HoverState) => ({
    width: size,
    height: size,
    borderRadius: 6,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: hovered || pressed ? theme.colors.surface2 : "transparent",
    opacity: disabled ? BUSY_OPACITY : 1,
  });
  return (
    <Pressable
      onPress={(event) => {
        event.stopPropagation?.();
        if (!disabled) onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={style}
    >
      <Icon name={name} size={glyph} color={color} />
    </Pressable>
  );
}

/**
 * One menu row: `menu-item.tsx:441`'s box, a 16px leading glyph when given, a
 * 14px label, hover filled `surface2`. Destructive rows paint both the glyph and
 * the label `statusDanger` — the host's `MenuItem destructive` (a colour, not a
 * red button).
 */
function MenuRow({
  icon,
  label,
  destructive,
  disabled,
  compact,
  theme,
  onPress,
}: {
  icon?: "Check" | "Trash2";
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Phone sheet density: the host's menu item is 40px tall there, 28 on pointer layouts. */
  compact: boolean;
  theme: PopoverTheme;
  onPress: () => void;
}) {
  const box = goalMenuItem(compact);
  const color = destructive === true ? theme.colors.statusDanger : theme.colors.foreground;
  const glyphColor = destructive === true ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  const style = ({ hovered = false, pressed }: HoverState) => ({
    ...box,
    borderColor: "transparent",
    backgroundColor: hovered || pressed ? theme.colors.surface2 : "transparent",
    opacity: disabled === true ? BUSY_OPACITY : 1,
  });
  return (
    <Pressable
      onPress={() => {
        if (disabled !== true) onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      style={style}
    >
      {icon === undefined ? null : (
        <View style={{ width: 16, alignItems: "center" }}>
          <Icon name={icon} size={16} color={glyphColor} />
        </View>
      )}
      <Text numberOfLines={1} style={{ fontSize: TITLE_FONT_SIZE, lineHeight: 18, color }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** `MenuHint`: one muted line, 12px horizontal and 8px vertical padding. */
function Hint({ theme, danger, children }: { theme: PopoverTheme; danger?: boolean; children: string }) {
  return (
    <View
      style={{
        paddingHorizontal: GOAL_HINT_PADDING_HORIZONTAL,
        paddingVertical: GOAL_HINT_PADDING_VERTICAL,
      }}
    >
      <Text style={{ fontSize: FACTS_FONT_SIZE, color: danger === true ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>
        {children}
      </Text>
    </View>
  );
}

/** `MenuSeparator`: a 1px full-width rule, 4px above and below. */
function Separator({ theme }: { theme: PopoverTheme }) {
  return (
    <View
      style={{
        height: GOAL_SEPARATOR_HEIGHT,
        marginVertical: GOAL_SEPARATOR_MARGIN_VERTICAL,
        backgroundColor: theme.colors.border,
      }}
    />
  );
}

/** Everything the popover body draws. State and RPCs stay in `goal-pill.tsx`. */
export interface GoalPopoverBodyProps {
  goal: GoalState;
  text: GoalText;
  theme: PopoverTheme;
  /** The host's compact layout flag (phone sheet). */
  compact: boolean;
  /** Whether the running ring turns (see `goalRunningMark`). */
  running: boolean;
  /** The in-place page. */
  mode: GoalPanelMode;
  /** One control action is in flight; the panel is read-only meanwhile. */
  busy: boolean;
  /** DSH's refusal sentence, shown in place and never auto-cleared. */
  error?: string;
  /** The edit field's current text. */
  draft: string;
  /** Pause (goal is auto-continuing) or continue. */
  onToggleRunning: () => void;
  /** Enter the edit page. */
  onBeginEdit: () => void;
  /** Enter the clear confirmation page. */
  onBeginClear: () => void;
  /** Submit the edit page. */
  onSave: () => void;
  /** Leave the edit page without saving. */
  onCancelEdit: () => void;
  /** Execute the clear after the confirmation page. */
  onConfirmClear: () => void;
  /** Leave the clear confirmation page. */
  onCancelClear: () => void;
  onChangeDraft: (text: string) => void;
}

/**
 * The popover body. Pure: the same props always render the same tree, which is
 * what lets the offline render harness assert the pages and the screenshots
 * render the real component.
 */
export function GoalPopoverBody({
  goal,
  text,
  theme,
  compact,
  running,
  mode,
  busy,
  error,
  draft,
  onToggleRunning,
  onBeginEdit,
  onBeginClear,
  onSave,
  onCancelEdit,
  onConfirmClear,
  onCancelClear,
  onChangeDraft,
}: GoalPopoverBodyProps) {
  // The row's own hover state, so the whale's ring can knock out of the row fill
  // it is drawn on (the host's `backdrop`).
  const [hot, setHot] = useState(false);
  // The first selection pins the caret to offset 0 (the start of the goal); the
  // first keystroke or selection change releases it to the platform.
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>({
    start: 0,
    end: 0,
  });
  const iconButton = goalIconButton(compact);
  const resumable = goal.phase !== "active" || goal.activation === "disarmed";
  const facts = goalFactsLine(goal, text.statuses, text.rounds);
  const currentTask = goalCurrentTaskLine(goal);
  const root = { ...popoverRootBox() } as const;

  if (mode === "edit") {
    return (
      <View style={{ ...root, margin: -12, ...(compact ? {} : { width: GOAL_EDITOR_WIDTH_WIDE }) }}>
        <View
          style={{
            marginHorizontal: 4,
            paddingHorizontal: 8,
            paddingVertical: 6,
            borderWidth: 1,
            borderColor: theme.colors.foregroundMuted,
            borderRadius: 6,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <UiTextInput
            value={draft}
            onChangeText={(next) => {
              setSelection(undefined);
              onChangeDraft(next);
            }}
            onSelectionChange={() => setSelection(undefined)}
            onFocus={() => setSelection({ start: 0, end: 0 })}
            selection={selection}
            multiline
            numberOfLines={4}
            autoFocus
            submitBehavior="blurAndSubmit"
            onSubmitEditing={onSave}
            onKeyPress={(event) => {
              const key = event.nativeEvent.key;
              if (key === "Escape") {
                event.preventDefault?.();
                onCancelEdit();
                return;
              }
              if (key === "Enter") {
                event.preventDefault?.();
                onSave();
              }
            }}
            accessibilityLabel={text.editPlaceholder}
            // `resize`/`outline` are web-only keys the RN style type does not
            // carry; the host's own field strips them the same way.
            style={{
              fontSize: TITLE_FONT_SIZE,
              lineHeight: GOAL_OBJECTIVE_LINE_HEIGHT,
              minHeight: GOAL_EDITOR_MIN_HEIGHT,
              color: theme.colors.foreground,
              padding: 0,
              borderWidth: 0,
              outlineWidth: 0,
              ...({ resize: "none" } as Record<string, unknown>),
            } as never}
          />
        </View>
        <Separator theme={theme} />
        <MenuRow
          label={text.actions.save}
          disabled={busy || !goalEditSubmittable(draft, goal.objective)}
          compact={compact}
          theme={theme}
          onPress={onSave}
        />
        <MenuRow label={text.actions.cancel} compact={compact} theme={theme} onPress={onCancelEdit} />
        {error === undefined ? null : <Hint theme={theme} danger>{error}</Hint>}
      </View>
    );
  }

  if (mode === "confirm") {
    return (
      <View style={{ ...root, margin: -12 }}>
        <Hint theme={theme}>{text.clearHint}</Hint>
        <Separator theme={theme} />
        <MenuRow
          icon="Trash2"
          label={text.actions.clearTarget}
          destructive
          disabled={busy}
          compact={compact}
          theme={theme}
          onPress={onConfirmClear}
        />
        <MenuRow label={text.actions.cancel} compact={compact} theme={theme} onPress={onCancelClear} />
        {error === undefined ? null : <Hint theme={theme} danger>{error}</Hint>}
      </View>
    );
  }

  const row = goalTrackRow(compact);
  return (
    <View style={{ ...root, margin: -12 }}>
      {/* The whole row is the edit target. The two buttons stop their own press. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={text.actions.edit}
        onPress={onBeginEdit}
        onHoverIn={() => setHot(true)}
        onHoverOut={() => setHot(false)}
        style={({ hovered = false, pressed }: HoverState) => ({
          ...row,
          backgroundColor: hovered || pressed || hot ? theme.colors.surface2 : "transparent",
        })}
      >
        <Whale
          running={running}
          theme={theme}
          backdrop={hot ? theme.colors.surface2 : theme.colors.surface1}
          label={text.runningA11y}
        />
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{
              fontSize: TITLE_FONT_SIZE,
              lineHeight: GOAL_OBJECTIVE_LINE_HEIGHT,
              color: theme.colors.foreground,
            }}
          >
            {goal.objective}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              fontSize: FACTS_FONT_SIZE,
              lineHeight: GOAL_FACTS_LINE_HEIGHT,
              color: theme.colors.foregroundMuted,
            }}
          >
            {facts}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 4 }}>
          <IconButton
            name={resumable ? "Play" : "Pause"}
            glyph={iconButton.glyph}
            size={iconButton.size}
            color={theme.colors.foregroundMuted}
            disabled={busy}
            theme={theme}
            label={resumable ? text.actions.resumeTarget : text.actions.pauseTarget}
            onPress={onToggleRunning}
          />
          <IconButton
            name="Trash2"
            glyph={iconButton.glyph}
            size={iconButton.size}
            color={theme.colors.foregroundMuted}
            disabled={busy}
            theme={theme}
            label={text.actions.clearTarget}
            onPress={onBeginClear}
          />
        </View>
      </Pressable>
      {currentTask === undefined ? null : (
        <View style={row}>
          <Icon name="CircleDot" size={16} color={theme.colors.foregroundMuted} />
          <Text
            numberOfLines={1}
            style={{ flexShrink: 1, fontSize: TITLE_FONT_SIZE, color: theme.colors.foreground }}
          >
            <Text style={{ color: theme.colors.foregroundMuted }}>{text.currentTaskPrefix}</Text>
            {currentTask}
          </Text>
        </View>
      )}
      {goal.phase === "blocked" && goal.blockedReason !== undefined ? (
        <View style={[row, { alignItems: "flex-start" }]}>
          <View style={{ marginTop: 2 }}>
            <Icon name="CircleAlert" size={16} color={theme.colors.statusDanger} />
          </View>
          <Text
            numberOfLines={2}
            style={{
              flexShrink: 1,
              fontSize: TITLE_FONT_SIZE,
              lineHeight: GOAL_OBJECTIVE_LINE_HEIGHT,
              color: theme.colors.foregroundMuted,
            }}
          >
            {goal.blockedReason.message}
          </Text>
        </View>
      ) : null}
      {goal.phase === "active" && goal.activation === "disarmed" ? (
        <Hint theme={theme}>{text.disarmedHint}</Hint>
      ) : null}
      {error === undefined ? null : <Hint theme={theme} danger>{error}</Hint>}
    </View>
  );
}
