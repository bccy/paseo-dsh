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
 * - **Edit** (design-opus-v4 direction C) is a small Paseo composer: a header
 *   (whale + 编辑目标, and on desktop an `Esc 取消` hint), then the host composer's
 *   box (`composer/input/input.tsx:2259-2287`: 16px radius, same surface as the
 *   panel, 1px border) holding a field that grows from two lines to six and then
 *   scrolls, and a button row with the composer's 28px round accent button (a ✓,
 *   half opacity and inert while the draft is empty or unchanged) and a quiet
 *   取消. Keys follow the composer: on desktop Enter saves, Shift+Enter is a
 *   newline, Escape cancels; on a phone Enter is a newline and only ✓ saves.
 *   The caret starts at offset 0 so a long goal is read from its start, and
 *   **blur never saves** — a long objective is too expensive to change by
 *   accident.
 * - **Clear** (UI-v9, direction B) holds the view page in place: the same
 *   objective row, its two row-end icon buttons swapped for a quiet 取消 and a
 *   red round trash button, the hint below the row. Red appears only after the
 *   user has said they want to clear, and the red button stays inert for
 *   `GOAL_CONFIRM_ARM_MS` after the page appears because it sits where the
 *   trash was (a double click must not clear).
 * - **Errors** are DSH's refusals, shown in the panel's language when the
 *   sentence is known (`goalControlErrorDisplay`) with DSH's original under
 *   the translation; an unknown sentence is shown verbatim.
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
import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import type { GoalState } from "../shared/goal";
import { DeepSeekMark } from "./deepseek-mark";
import {
  GOAL_EDITOR_GAP,
  GOAL_EDITOR_MARGIN_HORIZONTAL,
  GOAL_EDITOR_MAX_LINES,
  GOAL_EDITOR_PADDING_HORIZONTAL,
  GOAL_EDITOR_PADDING_VERTICAL,
  GOAL_EDITOR_RADIUS,
  GOAL_EDITOR_WIDTH_WIDE,
  GOAL_FACTS_LINE_HEIGHT,
  GOAL_HINT_PADDING_HORIZONTAL,
  GOAL_HINT_PADDING_VERTICAL,
  GOAL_OBJECTIVE_LINE_HEIGHT,
  GOAL_RING_FRAME_SIZE,
  GOAL_RING_OFFSET,
  GOAL_SAVE_BUTTON_SIZE,
  GOAL_SAVE_DISABLED_OPACITY,
  GOAL_CONFIRM_ARM_MS,
  GOAL_CONFIRM_SETTLE_MS,
  GOAL_CONFIRM_UNARMED_OPACITY,
  GOAL_CONFIRM_UNARMED_SCALE,
  GOAL_DANGER_HOVER_OPACITY,
  GOAL_DANGER_PRESSED_OPACITY,
  GOAL_WHALE_SIZE,
  goalConfirmControls,
  goalCurrentTaskLine,
  goalEditKeyAction,
  goalEditSubmittable,
  goalEditorHeight,
  goalEditorType,
  goalStateName,
  goalFactsLine,
  goalIconButton,
  goalTrackRow,
} from "./goal-polling";
import {
  FACTS_FONT_SIZE,
  TITLE_FONT_SIZE,
  popoverRootBox,
  ringColorFor,
} from "./jobs-popover-layout";
import { goalControlErrorDisplay, type GoalText } from "./locale";
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

/** `MenuHint`: one muted line, 12px horizontal and 8px vertical padding. */
function Hint({ theme, children }: { theme: PopoverTheme; children: string }) {
  return (
    <View
      style={{
        paddingHorizontal: GOAL_HINT_PADDING_HORIZONTAL,
        paddingVertical: GOAL_HINT_PADDING_VERTICAL,
      }}
    >
      <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
        {children}
      </Text>
    </View>
  );
}

/**
 * A control error: DSH's refusal in the panel's language when the sentence is
 * known, with DSH's own words muted underneath; an unknown sentence verbatim
 * (`goalControlErrorDisplay`). The pair is one accessible element so a screen
 * reader hears both.
 */
function ControlError({ theme, text, error }: { theme: PopoverTheme; text: GoalText; error: string }) {
  const shown = goalControlErrorDisplay(error, text);
  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLabel={shown.original === undefined ? shown.message : `${shown.message} ${shown.original}`}
      style={{
        paddingHorizontal: GOAL_HINT_PADDING_HORIZONTAL,
        paddingVertical: GOAL_HINT_PADDING_VERTICAL,
        gap: 2,
      }}
    >
      <Text style={{ fontSize: FACTS_FONT_SIZE, lineHeight: GOAL_FACTS_LINE_HEIGHT, color: theme.colors.statusDanger }}>
        {shown.message}
      </Text>
      {shown.original === undefined ? null : (
        <Text
          selectable
          style={{ fontSize: FACTS_FONT_SIZE - 1, lineHeight: GOAL_FACTS_LINE_HEIGHT - 1, color: theme.colors.foregroundMuted }}
        >
          {shown.original}
        </Text>
      )}
    </View>
  );
}

/**
 * A key name in the host's shortcut chip (`components/ui/shortcut.tsx`: 4/2
 * padding, 6px radius, sm muted text on `surface3` at half opacity). The plugin
 * theme has no `surface3`; `surface2` is the fallback (DESIGN v4 §6).
 */
function KeyChip({ theme, children }: { theme: PopoverTheme; children: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 4,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>{children}</Text>
    </View>
  );
}

/** One muted word beside a chip. */
function KeyWord({ theme, children }: { theme: PopoverTheme; children: ReactNode }) {
  return <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>{children}</Text>;
}

/** The read-only part of the edit page's props. */
interface GoalEditorProps {
  goal: GoalState;
  text: GoalText;
  theme: PopoverTheme;
  compact: boolean;
  busy: boolean;
  error?: string;
  draft: string;
  onSave: () => void;
  onCancelEdit: () => void;
  onChangeDraft: (text: string) => void;
}

/**
 * The edit page: a small Paseo composer (design-opus-v4 direction C).
 *
 * The field's height comes from a hidden copy of the text laid out at the same
 * width — the host composer measures its lines the same way (`lineMeasurement`,
 * `composer/input/input.tsx`) — because a textarea's `scrollHeight` only ever
 * grows on web, so a field sized from it would never shrink back.
 */
function GoalEditor({
  goal,
  text,
  theme,
  compact,
  busy,
  error,
  draft,
  onSave,
  onCancelEdit,
  onChangeDraft,
}: GoalEditorProps) {
  const web = Platform.OS === "web";
  // Enter submits only where the host composer's does: web, pointer layout.
  const submitOnEnter = web && !compact;
  const type = goalEditorType(web);
  const [measured, setMeasured] = useState(0);
  // The first selection pins the caret to offset 0 (the start of the goal); the
  // first keystroke or selection change releases it to the platform.
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>({
    start: 0,
    end: 0,
  });
  const canSave = !busy && goalEditSubmittable(draft, goal.objective);
  const height = goalEditorHeight(measured, type.lineHeight);
  const save = (): void => {
    if (canSave) onSave();
  };

  return (
    <View
      style={{
        ...popoverRootBox(),
        margin: -12,
        paddingBottom: GOAL_EDITOR_PADDING_VERTICAL,
        ...(compact ? {} : { width: GOAL_EDITOR_WIDTH_WIDE }),
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: GOAL_HINT_PADDING_HORIZONTAL,
          paddingVertical: GOAL_HINT_PADDING_VERTICAL,
        }}
      >
        <DeepSeekMark size={GOAL_WHALE_SIZE} />
        <Text
          style={{
            flexGrow: 1,
            flexShrink: 1,
            fontSize: TITLE_FONT_SIZE,
            fontWeight: "500",
            color: theme.colors.foreground,
          }}
        >
          {text.editor.title}
        </Text>
        {submitOnEnter ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <KeyChip theme={theme}>{text.editor.escKey}</KeyChip>
            <KeyWord theme={theme}>{text.editor.escHint}</KeyWord>
          </View>
        ) : null}
      </View>
      <View
        style={{
          marginHorizontal: GOAL_EDITOR_MARGIN_HORIZONTAL,
          gap: GOAL_EDITOR_GAP,
          paddingVertical: GOAL_EDITOR_PADDING_VERTICAL,
          paddingHorizontal: GOAL_EDITOR_PADDING_HORIZONTAL,
          borderRadius: GOAL_EDITOR_RADIUS,
          borderWidth: 1,
          // The composer's `borderAccent` is not in the plugin theme (DESIGN v4 §6).
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <View style={{ position: "relative" }}>
          {/* The measuring copy: same width, font and line height, never seen. */}
          <Text
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            onLayout={(event) => setMeasured(event.nativeEvent.layout.height)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              opacity: 0,
              fontSize: type.fontSize,
              lineHeight: type.lineHeight,
            }}
          >
            {/* A zero-width space keeps a trailing newline's empty line measured. */}
            {`${draft}\u200b`}
          </Text>
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
            autoFocus
            editable={!busy}
            placeholder={text.editPlaceholder}
            placeholderTextColor={theme.colors.foregroundMuted}
            onKeyPress={(event) => {
              const native = event.nativeEvent as {
                key: string;
                shiftKey?: boolean;
                isComposing?: boolean;
                keyCode?: number;
              };
              const action = goalEditKeyAction({
                key: native.key,
                shiftKey: native.shiftKey === true,
                composing: native.isComposing === true || native.keyCode === 229,
                submitOnEnter,
              });
              if (action === null) return;
              event.preventDefault?.();
              if (action === "cancel") onCancelEdit();
              else save();
            }}
            accessibilityLabel={text.editPlaceholder}
            // `resize`/`outline` are web-only keys the RN style type does not
            // carry; the host's own field strips them the same way.
            style={{
              height,
              maxHeight: GOAL_EDITOR_MAX_LINES * type.lineHeight,
              fontSize: type.fontSize,
              lineHeight: type.lineHeight,
              color: theme.colors.foreground,
              padding: 0,
              borderWidth: 0,
              outlineWidth: 0,
              textAlignVertical: "top",
              ...({ resize: "none", outlineStyle: "none" } as Record<string, unknown>),
            } as never}
          />
        </View>
        {/* The composer's button row bleeds 6px each side (`input.tsx:2350-2356`). */}
        <View style={{ flexDirection: "row", alignItems: "center", marginHorizontal: -6 }}>
          <View style={{ flexGrow: 1, flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 6 }}>
            {submitOnEnter ? (
              <>
                <KeyChip theme={theme}>{text.editor.enterKey}</KeyChip>
                <KeyWord theme={theme}>{text.editor.enterHint}</KeyWord>
                <KeyChip theme={theme}>{text.editor.shiftEnterKey}</KeyChip>
                <KeyWord theme={theme}>{text.editor.shiftEnterHint}</KeyWord>
              </>
            ) : null}
          </View>
          <Pressable
            onPress={onCancelEdit}
            accessibilityRole="button"
            accessibilityLabel={text.editor.cancel}
            style={({ hovered = false, pressed }: HoverState) => ({
              height: GOAL_SAVE_BUTTON_SIZE,
              paddingHorizontal: 12,
              borderRadius: 9999,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: hovered || pressed ? theme.colors.surface2 : "transparent",
            })}
          >
            {({ hovered = false, pressed }: HoverState) => (
              <Text
                style={{
                  fontSize: FACTS_FONT_SIZE,
                  color: hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted,
                }}
              >
                {text.editor.cancel}
              </Text>
            )}
          </Pressable>
          <Pressable
            onPress={save}
            disabled={!canSave}
            accessibilityRole="button"
            accessibilityLabel={text.editor.save}
            accessibilityState={{ disabled: !canSave, busy }}
            style={{
              width: GOAL_SAVE_BUTTON_SIZE,
              height: GOAL_SAVE_BUTTON_SIZE,
              marginLeft: 4,
              borderRadius: GOAL_SAVE_BUTTON_SIZE / 2,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.colors.accent,
              opacity: canSave || busy ? 1 : GOAL_SAVE_DISABLED_OPACITY,
            }}
          >
            {busy ? (
              <ActivityIndicator size="small" color={theme.colors.accentForeground} />
            ) : (
              <Icon name="Check" size={web ? 16 : 20} color={theme.colors.accentForeground} />
            )}
          </Pressable>
        </View>
      </View>
      {error === undefined ? null : <ControlError theme={theme} text={text} error={error} />}
    </View>
  );
}

/**
 * Whether the confirmation's red button accepts a press yet: `false` for
 * `GOAL_CONFIRM_ARM_MS` after the page mounts, then `true`. The button sits
 * where the view page's trash was, so without this a double click on the trash
 * clears the goal (UI-v9). A state re-render, not `Animated`: the timer is
 * reliable on web and native alike (FIELD-NOTES on `Animated` in RN Web).
 */
function useArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), GOAL_CONFIRM_ARM_MS);
    return () => clearTimeout(timer);
  }, []);
  return armed;
}

/** The read-only props of the clear confirmation. */
interface GoalClearConfirmProps {
  goal: GoalState;
  text: GoalText;
  theme: PopoverTheme;
  compact: boolean;
  busy: boolean;
  error?: string;
  onConfirmClear: () => void;
  onCancelClear: () => void;
}

/**
 * The clear confirmation (UI-v9, direction B): the view page held in place.
 *
 * The objective row is the view page's (whale without ring, one truncated
 * line, facts), not pressable. Its end carries a quiet 取消 — the edit page's
 * ghost text button, muted until hovered — and the red round trash button: the
 * host's destructive button (`statusDanger` fill, `surface0` glyph, 0.85 when
 * pressed) at the view page's icon-button size on a phone. The hint sits under
 * the row. 取消 stays live while the clear is in flight, as before; the red
 * button shows the composer's spinner then.
 */
function GoalClearConfirm({ goal, text, theme, compact, busy, error, onConfirmClear, onCancelClear }: GoalClearConfirmProps) {
  const armed = useArmed();
  const controls = goalConfirmControls(compact);
  const row = goalTrackRow(compact);
  const facts = goalFactsLine(goal, text.statuses, text.rounds);
  const live = armed && !busy;
  const web = Platform.OS === "web";
  return (
    <View style={{ ...popoverRootBox(), margin: -12 }}>
      <View style={row}>
        <View
          accessible
          accessibilityLabel={text.rowLabel(goalStateName(goal, text), goal.objective)}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 }}
        >
          <Whale running={false} theme={theme} backdrop={theme.colors.surface1} label={text.runningA11y} />
          <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 }}>
            <Text
              numberOfLines={1}
              style={{ fontSize: TITLE_FONT_SIZE, lineHeight: GOAL_OBJECTIVE_LINE_HEIGHT, color: theme.colors.foreground }}
            >
              {goal.objective}
            </Text>
            <Text
              numberOfLines={1}
              style={{ fontSize: FACTS_FONT_SIZE, lineHeight: GOAL_FACTS_LINE_HEIGHT, color: theme.colors.foregroundMuted }}
            >
              {facts}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: controls.gap, flexShrink: 0 }}>
          <Pressable
            onPress={onCancelClear}
            accessibilityRole="button"
            accessibilityLabel={text.actions.cancel}
            style={({ hovered = false, pressed }: HoverState) => ({
              height: controls.dangerSize,
              paddingHorizontal: controls.cancelPaddingHorizontal,
              borderRadius: 9999,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: hovered || pressed ? theme.colors.surface2 : "transparent",
            })}
          >
            {({ hovered = false, pressed }: HoverState) => (
              <Text
                style={{
                  fontSize: FACTS_FONT_SIZE,
                  color: hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted,
                }}
              >
                {text.actions.cancel}
              </Text>
            )}
          </Pressable>
          <Pressable
            onPress={() => {
              if (live) onConfirmClear();
            }}
            disabled={!live}
            accessibilityRole="button"
            accessibilityLabel={text.actions.clearTarget}
            accessibilityState={{ disabled: !live, busy }}
            style={({ hovered = false, pressed }: HoverState) => ({
              width: controls.dangerSize,
              height: controls.dangerSize,
              borderRadius: controls.dangerSize / 2,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.colors.statusDanger,
              opacity: !armed
                ? GOAL_CONFIRM_UNARMED_OPACITY
                : live && pressed
                  ? GOAL_DANGER_PRESSED_OPACITY
                  : live && hovered
                    ? GOAL_DANGER_HOVER_OPACITY
                    : 1,
              transform: [{ scale: armed ? 1 : GOAL_CONFIRM_UNARMED_SCALE }],
              // Web eases from the unarmed look; native re-renders straight to it.
              ...(web
                ? ({
                    transitionProperty: "opacity, transform",
                    transitionDuration: `${String(GOAL_CONFIRM_SETTLE_MS)}ms`,
                    transitionTimingFunction: "ease-out",
                  } as Record<string, unknown>)
                : {}),
            })}
          >
            {busy ? (
              <ActivityIndicator size="small" color={theme.colors.surface0} />
            ) : (
              <Icon name="Trash2" size={controls.dangerGlyph} color={theme.colors.surface0} />
            )}
          </Pressable>
        </View>
      </View>
      {/* A completed goal stops nothing when cleared; it loses the record. */}
      <Hint theme={theme}>{goal.phase === "complete" ? text.completeClearHint : text.clearHint}</Hint>
      {error === undefined ? null : <ControlError theme={theme} text={text} error={error} />}
    </View>
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
  const iconButton = goalIconButton(compact);
  const resumable = goal.phase !== "active" || goal.activation === "disarmed";
  const facts = goalFactsLine(goal, text.statuses, text.rounds);
  const currentTask = goalCurrentTaskLine(goal);
  const root = { ...popoverRootBox() } as const;

  if (mode === "edit") {
    return (
      <GoalEditor
        goal={goal}
        text={text}
        theme={theme}
        compact={compact}
        busy={busy}
        error={error}
        draft={draft}
        onSave={onSave}
        onCancelEdit={onCancelEdit}
        onChangeDraft={onChangeDraft}
      />
    );
  }

  if (mode === "confirm") {
    return (
      <GoalClearConfirm
        goal={goal}
        text={text}
        theme={theme}
        compact={compact}
        busy={busy}
        error={error}
        onConfirmClear={onConfirmClear}
        onCancelClear={onCancelClear}
      />
    );
  }

  const row = goalTrackRow(compact);
  const stateName = goalStateName(goal, text);

  if (goal.phase === "complete") {
    // UI-v7: read-only. The objective row is a plain View (no press, no hover
    // fill — nothing here edits), the whale has no ring, the objective is the
    // same one truncated line as every other state, and the only action is
    // clear. The hint points at the model's closing message: DSH has no
    // summary field to show instead.
    return (
      <View style={{ ...root, margin: -12 }}>
        <View accessible accessibilityLabel={text.rowLabel(stateName, goal.objective)} style={row}>
          <Whale running={false} theme={theme} backdrop={theme.colors.surface1} label={text.runningA11y} />
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
        <Hint theme={theme}>{text.completeHint}</Hint>
        {error === undefined ? null : <ControlError theme={theme} text={text} error={error} />}
      </View>
    );
  }

  return (
    <View style={{ ...root, margin: -12 }}>
      {/* The whole row is the edit target. The two buttons stop their own press.
          Its name speaks the state first: the pill's own name is only 「目标」. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={text.rowLabel(stateName, text.actions.edit)}
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
      {error === undefined ? null : <ControlError theme={theme} text={text} error={error} />}
    </View>
  );
}
