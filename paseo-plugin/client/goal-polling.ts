/**
 * The goal pill's presentation rules, its popover geometry, and the adapter that
 * binds both to the shared poll controller.
 *
 * `goal-pill.tsx` / `goal-popover.tsx` import the host runtime (React, React
 * Native, the plugin component library), so plain `node` cannot load them.
 * Everything here is pure: the harness drives these functions directly instead
 * of pattern-matching JSX, which is the only way a rule like "the primary button
 * is last and right-aligned" or "a complete goal is hidden" can be asserted.
 *
 * **The four states the pill must tell apart.** `active + armed` is the only
 * state that is actually auto-continuing; `active + disarmed` looks identical
 * from the durable phase alone and is the silent degradation this surface exists
 * to fix — after a reopen the goal is still active but will never continue on
 * its own. `paused` and `blocked` are durable and need 继续. `complete` is
 * hidden: the goal is finished, and DSH's own GoalBar hides it too.
 *
 * **The UI revision (2026-11-03).** The trigger's label no longer carries the
 * round fraction (`目标 3/10` read as "30% done", which the round budget is
 * not); it says what state the goal is in, and the round *budget* moved into the
 * popover as a sentence (`第 3 轮 · 预算 10`). The popover's action row is
 * right-aligned with the primary action last and alone in accent, its buttons
 * follow the host's sm (desktop) / md (phone sheet) geometry, and the trigger's
 * icon is tone-coloured through a custom component because the host draws the
 * label as plain text.
 *
 * **The polling policy is the jobs pill's** (`client/agent-polling.ts`), shared
 * rather than copied. The two differences are both in the adapter below: the
 * payload is one goal (or `null`) instead of a list, and a transient read error
 * keeps the last state instead of publishing "could not read".
 *
 * @module dsh-paseo/client/goal-polling
 */
import {
  createAgentPoller,
  type AgentPoller,
  type AgentPollerHost,
  type PollAgent,
  type PollAgentPage,
  type PollRemoveReason,
  type PollViewState,
} from "./agent-polling";
import { relativeLuminance } from "./jobs-popover-layout";
import {
  isTerminalGoalErrorCode,
  type GoalAction,
  type GoalState,
} from "../shared/goal";

export {
  INITIAL_POLL_JITTER_MS,
  LIVE_POLL_MS,
  MAX_AGENT_DIRECTORY_PAGES,
  MAX_POLL_JITTER_MS,
  MAX_POLL_MS,
  POLL_JITTER_RATIO,
  initialPollDelayMs,
  nextPollDelayMs,
} from "./agent-polling";

/** One read's answer, mirroring the `goal.current` contract. */
export interface GoalReadResult {
  available: boolean;
  goal?: GoalState | null;
  error?: { message: string; code?: string };
}

/** One agent's state as the popover store keeps it. */
export interface GoalViewState {
  goal: GoalState | null;
  available: boolean;
  error?: string;
  code?: string;
}

/** The fields of an agent the pill cares about. */
export type GoalAgent = PollAgent;

/** One page of the agent directory, structurally. */
export type GoalAgentPage = PollAgentPage;

/** Why an agent's pill was torn down; the host decides what to log. */
export type GoalRemoveReason = PollRemoveReason;

/**
 * The label the trigger carries, as a semantic key.
 *
 * A union rather than a finished string: the copy lives in `client/locale.ts`
 * and this module must stay locale-free (the harness compares the two
 * languages, so a string baked in here could never be translated).
 *
 * There is deliberately **no round-bearing label**: the trigger's `label` is a
 * one-line string in a 160px-wide button, and a fraction there reads as
 * completion when it is a budget. The round line lives in the popover.
 */
export type GoalLabel =
  | { readonly kind: "running" }
  | { readonly kind: "notRunning" }
  | { readonly kind: "paused" }
  | { readonly kind: "blocked" };

/**
 * The tone the status line, the trigger icon and the "now" line use.
 *
 * `normal` is the only tone that means "this is working"; a goal that is not
 * auto-continuing is a warning even while its phase is active, and a blocked
 * goal is an error. Mapped to theme tokens by {@link goalToneColorToken} (text)
 * and {@link goalIconColorToken} (the 14px trigger glyph).
 */
export type GoalTone = "normal" | "warning" | "error";

/** The theme colour key one tone draws text with. */
export function goalToneColorToken(tone: GoalTone): "foreground" | "statusWarning" | "statusDanger" {
  switch (tone) {
    case "normal":
      return "foreground";
    case "warning":
      return "statusWarning";
    case "error":
      return "statusDanger";
  }
}

/**
 * The theme colour key one tone draws the trigger's glyph with.
 *
 * The active goal is the one that is working, so its glyph is `accent` — the
 * same colour the host uses for its own live affordances — while the
 * not-continuing states reuse the warning/danger text colours. The host paints
 * a plugin pill's label itself (plain text, no colour channel), so the glyph is
 * the only place this tone can reach the trigger.
 */
export function goalIconColorToken(tone: GoalTone): "accent" | "statusWarning" | "statusDanger" {
  switch (tone) {
    case "normal":
      return "accent";
    case "warning":
      return "statusWarning";
    case "error":
      return "statusDanger";
  }
}

/** What the trigger shows for one answer. */
export type GoalPillPresentation =
  | { readonly visible: false }
  | {
      readonly visible: true;
      readonly label: GoalLabel;
      readonly tone: GoalTone;
    };

/**
 * Whether the pill is shown for one answer, and what it says.
 *
 * Visibility is DESIGN §2's rule: **a goal exists and is not complete**. A
 * `null` goal (never created, or cleared) and a `complete` goal are both hidden
 * — there is nothing to manage and nothing to report. `available: false` is
 * hidden too, but that branch is normally unreachable: terminal errors remove
 * the pill outright and transient ones keep the last state (see
 * {@link createGoalPoller}).
 *
 * `active + disarmed` is a warning, not a normal label: the goal is not
 * finished, it is just not continuing on its own, and the popover's 继续 button
 * is the fix.
 */
export function goalPillPresentation(answer: {
  available: boolean;
  goal?: GoalState | null;
}): GoalPillPresentation {
  const goal = answer.goal ?? null;
  if (!answer.available || goal === null || goal.phase === "complete") {
    return { visible: false };
  }
  if (goal.phase === "blocked") {
    return { visible: true, label: { kind: "blocked" }, tone: "error" };
  }
  if (goal.phase === "paused") {
    return { visible: true, label: { kind: "paused" }, tone: "warning" };
  }
  if (goal.activation === "disarmed") {
    return { visible: true, label: { kind: "notRunning" }, tone: "warning" };
  }
  return { visible: true, label: { kind: "running" }, tone: "normal" };
}

/* -------------------------------------------------------------------------- */
/* The popover's action row                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The gap between two action buttons. = the host's form-footer gap
 * (`pair-link-modal.tsx`: `gap: theme.spacing[3]` = 12).
 */
export const GOAL_BUTTON_GAP = 12;

/** The geometry of one action button, copied from the host's Button contract. */
export interface GoalButtonGeometry {
  /** The control's min height (`CONTROL_HEIGHTS`). */
  readonly height: number;
  /** Label font size (`theme.fontSize.base`). */
  readonly fontSize: number;
  /** Corner radius (`theme.borderRadius.xl` / `2xl`). */
  readonly borderRadius: number;
  /** Horizontal padding (`theme.spacing[3]` / `spacing[4]`). */
  readonly paddingHorizontal: number;
  /** Gap between buttons. */
  readonly gap: number;
}

/**
 * The button geometry for one layout.
 *
 * **The host's own two sizes**, not invented: `control-geometry.ts` defines
 * `buttonSm = { minHeight: 32, paddingHorizontal: spacing[3]=12, borderRadius:
 * xl=12 }` and `buttonMd = { minHeight: 44, paddingHorizontal: spacing[4]=16,
 * borderRadius: 2xl=16 }`, with `fontSize.base = 14` for both. The wide popover
 * uses `sm` (pointer precision is enough); the phone's bottom sheet uses `md`
 * so the touch target meets the 44px floor. A plugin cannot import those
 * constants (the bundle's externals are react/react-native/zod/the plugin
 * package), so they are copied here and asserted against literals.
 */
export function goalButtonGeometry(compact: boolean): GoalButtonGeometry {
  return compact
    ? { height: 44, fontSize: 14, borderRadius: 16, paddingHorizontal: 16, gap: GOAL_BUTTON_GAP }
    : { height: 32, fontSize: 14, borderRadius: 12, paddingHorizontal: 12, gap: GOAL_BUTTON_GAP };
}

/**
 * The buttons in drawing order: **`[清除][编辑][主操作]`**.
 *
 * The row is right-aligned, so the primary action lands at the right edge where
 * the host's own form dialogs put it (`[Cancel secondary][Primary default]`),
 * and the destructive 清除 is kept away from it on the far left. Only the
 * actions that apply to the state are returned (the caller never draws a
 * disabled one).
 */
export function goalButtonRow(actions: readonly GoalAction[]): readonly GoalAction[] {
  const primary = actions.find((action) => action === "pause" || action === "resume");
  return [
    ...(actions.includes("clear") ? (["clear"] as const) : []),
    ...(actions.includes("edit") ? (["edit"] as const) : []),
    ...(primary === undefined ? [] : [primary]),
  ];
}

/* -------------------------------------------------------------------------- */
/* The action button's look                                                    */
/* -------------------------------------------------------------------------- */

/** One action button's visual variant. */
export type GoalButtonVariant = "primary" | "secondary" | "outline" | "destructive";

/** The theme colours a button resolves against (the plugin theme's subset). */
export interface GoalButtonColors {
  readonly foreground: string;
  readonly foregroundMuted: string;
  readonly surface1: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly statusDanger: string;
}

/** One button's resolved look. **Every variant carries a 1px border.** */
export interface GoalButtonPalette {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly borderWidth: number;
  readonly color: string;
}

/** One button's hover/press state. */
export interface GoalButtonState {
  readonly hovered: boolean;
  readonly pressed: boolean;
}

/**
 * The variant for one action.
 *
 * `pause` / `resume` are the primary call to action and the only accent fill.
 * `edit` is secondary. `clear` is a neutral outline until the user arms it, then
 * **destructive**: a red outline with red text, not a red fill. The red-fill
 * variant was tried and measured at 2.80:1 (white on the dark theme's
 * `statusDanger` #d8847b) — below AA — while red-on-panel is 6.10 (light) and
 * 5.80 (dark). See {@link goalButtonPalette}.
 */
export function goalButtonVariant(action: GoalAction, clearArmed: boolean): GoalButtonVariant {
  if (action === "pause" || action === "resume") return "primary";
  if (action === "edit") return "secondary";
  return clearArmed ? "destructive" : "outline";
}

/**
 * The label for one action.
 *
 * The destructive button switches to its confirmation sentence when armed, so
 * the screen says "press again to clear" instead of relying on colour alone. The
 * button's width is held by {@link goalButtonMinWidth}, so the switch does not
 * move the row.
 */
export function goalActionLabel(
  action: GoalAction,
  clearArmed: boolean,
  actions: { readonly pause: string; readonly resume: string; readonly edit: string; readonly clear: string; readonly confirmClear: string },
): string {
  switch (action) {
    case "pause":
      return actions.pause;
    case "resume":
      return actions.resume;
    case "edit":
      return actions.edit;
    case "clear":
      return clearArmed ? actions.confirmClear : actions.clear;
  }
}

/** An `#rgb` / `#rrggbb` colour as channels, or `undefined` for anything else. */
export function parseHexColor(hex: string): { readonly r: number; readonly g: number; readonly b: number } | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return undefined;
  const digits = match[1];
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : digits;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/**
 * Mix `foreground` over `background` at `alpha`, returning an opaque `#rrggbb`.
 *
 * The plugin theme carries no translucent tokens (11 opaque colours), and the
 * host's own status tints are `${color}${alphaHex}` strings, so blending here —
 * against the known panel colour — is the same idea without a token the plugin
 * does not have. An unparseable input returns the background unchanged rather
 * than throwing: a button in the wrong tint is cosmetic, a thrown renderer is an
 * empty panel.
 */
export function blendHex(foreground: string, background: string, alpha: number): string {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (fg === undefined || bg === undefined) return background;
  const ratio = Math.min(1, Math.max(0, alpha));
  const channel = (f: number, b: number): string =>
    Math.round(ratio * f + (1 - ratio) * b)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(fg.r, bg.r)}${channel(fg.g, bg.g)}${channel(fg.b, bg.b)}`;
}

/**
 * WCAG 2.1 contrast ratio between two `#rrggbb` colours, or `undefined`.
 *
 * Used by the harness to assert the measured values the verification round asked
 * for (destructive text ≥ 4.5:1, button shapes ≥ 1.5:1, light **and** dark).
 */
export function contrastRatio(a: string, b: string): number | undefined {
  const left = relativeLuminance(a);
  const right = relativeLuminance(b);
  if (left === undefined || right === undefined) return undefined;
  const high = Math.max(left, right);
  const low = Math.min(left, right);
  return (high + 0.05) / (low + 0.05);
}

/**
 * The resolved palette for one variant and state.
 *
 * **Every variant returns `borderWidth: 1`.** The outline and destructive
 * variants used to be the only ones with a border, so arming 清除 removed 1px
 * and the button's width moved 2px (measured 54→52 desktop / 62→60 phone). The
 * host's own `Button` keeps `borderWidth: 1, borderColor: "transparent"` on
 * every variant (`packages/app/src/components/ui/button.tsx`), so this does the
 * same: the primary and secondary fills draw their border in their own fill
 * colour.
 *
 * The fills are measured against the panel (`surface1`), not invented:
 * - secondary: `foreground` at 22% over the panel → 1.59:1 (light) / 2.02:1
 *   (dark), above the 1.5:1 floor; 8–12% was tried and measured 1.17–1.43, too
 *   faint in the dark theme (the verification round's F3).
 * - outline: `foregroundMuted` at 50% for the border → 1.94:1 / 2.67:1.
 * - destructive: `statusDanger` text and border on the panel → 6.10:1 / 5.80:1
 *   (AA for the text; ≥3:1 for the border as a graphic).
 */
export function goalButtonPalette(
  variant: GoalButtonVariant,
  colors: GoalButtonColors,
  state: GoalButtonState,
): GoalButtonPalette {
  const active = state.hovered || state.pressed;
  switch (variant) {
    case "primary":
      return {
        backgroundColor: colors.accent,
        borderColor: colors.accent,
        borderWidth: 1,
        color: colors.accentForeground,
      };
    case "secondary": {
      const fill = blendHex(colors.foreground, colors.surface1, active ? 0.3 : 0.22);
      return { backgroundColor: fill, borderColor: fill, borderWidth: 1, color: colors.foreground };
    }
    case "outline":
      return {
        backgroundColor: "transparent",
        borderColor: blendHex(colors.foregroundMuted, colors.surface1, active ? 0.65 : 0.5),
        borderWidth: 1,
        color: colors.foreground,
      };
    case "destructive":
      return {
        backgroundColor: "transparent",
        borderColor: colors.statusDanger,
        borderWidth: 1,
        color: colors.statusDanger,
      };
  }
}

/**
 * The width of one label at `fontSize`, in points.
 *
 * An approximation, not text measurement: CJK and full-width punctuation count
 * as one em, everything else as 0.55em. It only needs to be an upper bound wide
 * enough for both the 清除 and the 确认清除 labels, so the button does not resize
 * between them.
 *
 * Exported so the harness can assert the safety margin {@link goalButtonMinWidth}
 * adds on top of it.
 */
export function goalTextWidth(label: string, fontSize: number): number {
  let width = 0;
  for (const character of label) {
    width += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(character)
      ? fontSize
      : fontSize * 0.55;
  }
  return width;
}

/**
 * The horizontal breathing room added **per side** on top of the measured label.
 *
 * `goalTextWidth` is an estimate (CJK = 1em, other = 0.55em), not the native
 * font's real advance. Without a margin the pinned width came out exactly equal
 * to the label's estimated width (measured 56.00 = 56.00 in the verification
 * round), so a native font whose advance is a little wider would ellipsise the
 * confirmation label. The brief's floor is 4px per side or 0.5em; this is the
 * 0.5em value (`fontSize.base` = 14 → 7). 4px was tried first and the rendered
 * margin came out at 6px total (3 per side) because the estimate is ~2px under
 * the web font's real advance — so the floor is not enough on its own.
 *
 * The label is also `numberOfLines={1}`: if an unexpected font still overflows,
 * it truncates with an ellipsis instead of wrapping the action row.
 */
export const GOAL_BUTTON_LABEL_SAFETY = 7;

/**
 * The minimum outer width that fits the widest of `labels` at this geometry.
 *
 * Pins the button's width so switching 清除 → 确认清除 (or Clear → Confirm)
 * cannot move it: the label change is what tells the user to press again, and a
 * row that jumps while confirming looks broken. Padding and the 1px border on
 * both sides are added because `minWidth` is the outer box, plus
 * {@link GOAL_BUTTON_LABEL_SAFETY} per side for the estimate error.
 *
 * The same value is applied to **every** button in the row (`goal-popover.tsx`),
 * not just the destructive one: a single wider button made the destructive
 * control the widest thing in a row of otherwise compact buttons and read as
 * visually unbalanced (verification round 4a/N1). An equal-width row is the
 * deliberate layout.
 */
export function goalButtonMinWidth(labels: readonly string[], geometry: GoalButtonGeometry): number {
  const widest = labels.reduce((width, label) => Math.max(width, goalTextWidth(label, geometry.fontSize)), 0);
  return Math.ceil(widest) + geometry.paddingHorizontal * 2 + 2 + GOAL_BUTTON_LABEL_SAFETY * 2;
}

/**
 * The status line's 8px dot colour token per tone.
 *
 * The user asked for the status *colour* to identify the four states; the label
 * text cannot carry it (the host draws the popover's text, and the theme's
 * `accent` fails AA as text on the dark surface at 2.83:1). The dot is the
 * colour channel: accent while auto-continuing, warning when not, danger when
 * blocked — visible at 8px and independent of the text's contrast.
 */
export function goalStatusDotColorToken(tone: GoalTone): "accent" | "statusWarning" | "statusDanger" {
  switch (tone) {
    case "normal":
      return "accent";
    case "warning":
      return "statusWarning";
    case "error":
      return "statusDanger";
  }
}

/** The action row's layout: right-aligned, wrapping, shared gap. */
export interface GoalActionRowStyle {
  readonly flexDirection: "row";
  readonly justifyContent: "flex-end";
  readonly flexWrap: "wrap";
  readonly gap: number;
}

/**
 * The action row's layout.
 *
 * Exported as a value (not written inline in the JSX) because the "right
 * aligned" rule is a **behaviour** the harness must pin: the previous version
 * asserted the JSX source with a regex, which the file's own doc comment
 * satisfied — deleting `justifyContent: "flex-end"` left the check green (the
 * verification round's F1). A test that reads this function's return value fails
 * when the rule is removed.
 */
export function goalActionRowStyle(geometry: GoalButtonGeometry): GoalActionRowStyle {
  return { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: geometry.gap };
}

/* -------------------------------------------------------------------------- */
/* The popover's content lines                                                 */
/* -------------------------------------------------------------------------- */

/** The target line's DeepSeek mark: the host's 16px icon slot (`ICON_SIZE.md`). */
export const GOAL_MARK_SIZE = 16;

/** Between the mark and the objective text. = `spacing[1.5]`. */
export const GOAL_MARK_GAP = 6;

/** The objective's line height at `fontSize.base` (host body text ≈ 1.43×). */
export const GOAL_OBJECTIVE_LINE_HEIGHT = 20;

/**
 * How far the mark drops below the objective's top edge.
 *
 * `(lineHeight - mark) / 2` = 2, so a 16px mark centres on the first line of a
 * 20px line box. A mark aligned to the box's top reads as superscript text.
 */
export const GOAL_MARK_TOP_OFFSET = 2;

/** The vertical rhythm between the popover's blocks. = `spacing[2]`. */
export const GOAL_BODY_GAP = 8;

/**
 * The task DSH's todo list marks `in_progress`, trimmed, or `undefined`.
 *
 * DSH resets the `todos` projection every turn, so an absent/empty value is the
 * normal state and means "do not draw the now line" — never an empty sentence.
 */
export function goalCurrentTaskLine(goal: GoalState): string | undefined {
  const task = goal.currentTask?.trim();
  return task === undefined || task === "" ? undefined : task;
}

/* -------------------------------------------------------------------------- */
/* The destructive confirmation                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the 清除 button does on one click.
 *
 * `arm` is the first click: it only turns the button red, so a mis-tap cannot
 * destroy the goal. `run` is the second click on the same button. Any other
 * action resets the arm — the state machine lives here rather than in the JSX so
 * the harness can assert that one click never executes.
 *
 * The button's **label does not change** between the two steps: swapping 清除
 * for a longer confirmation sentence would change the button's width and make
 * the row jump. The colour is the confirmation, and the accessibility label
 * carries the sentence.
 */
export type ClearConfirmStep = "arm" | "run";

/** The step a 清除 click takes, given whether the button is already armed. */
export function clearConfirmStep(armed: boolean): ClearConfirmStep {
  return armed ? "run" : "arm";
}

/**
 * Whether an edit draft may be submitted.
 *
 * Empty (or whitespace-only) text is not a replacement objective, and DSH's
 * `/goal edit` grammar rejects it; the popover must not submit it. The server
 * half refuses it again — this is the UI half, not the only guard.
 */
export function goalEditDraftValid(draft: string): boolean {
  return draft.trim() !== "";
}

/**
 * The control buttons the popover offers, in semantic order.
 *
 * DESIGN §2's table, as data: a goal that is auto-continuing offers 暂停; one
 * that is not (disarmed, paused, blocked) offers 继续; every visible state
 * offers 编辑 and 清除. **Unavailable actions are not drawn, never disabled** —
 * a disabled button claims "you could do this but not now", which is wrong for a
 * state that has no such operation at all.
 *
 * `blocked` keeps 继续 even when the round cap is exhausted: DSH refuses that
 * resume with its own sentence ("not valid for the current state"), and the
 * popover shows it verbatim. Hiding the button instead would leave the user with
 * no way to discover why.
 *
 * This is the *set*; the drawing order is {@link goalButtonRow}'s.
 */
export function goalActionsFor(goal: GoalState): readonly GoalAction[] {
  const primary: GoalAction =
    goal.phase === "active" && goal.activation === "armed" ? "pause" : "resume";
  return [primary, "edit", "clear"];
}

/* -------------------------------------------------------------------------- */
/* The poll controller                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The host half the goal pill's poller needs.
 *
 * Mirrors `JobsPollerHost` with the goal payload: the adapter owns the
 * `{goal}` shape and the pill module owns the React store and registration.
 */
export interface GoalPollerHost {
  readGoal(agentId: string): Promise<GoalReadResult>;
  /** One more directory page, only when the first snapshot said there is one. */
  listAgentPage(cursor: string): Promise<GoalAgentPage>;
  addAgent(agent: GoalAgent): void;
  removeAgent(agentId: string, reason: GoalRemoveReason, error?: GoalReadResult["error"]): void;
  publishState(agentId: string, state: GoalViewState): void;
  onError(message: string, error?: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  random?: () => number;
}

/** The controller `goal-pill.tsx` drives from its agent subscription. */
export type GoalPoller = AgentPoller;

/**
 * Create the per-agent goal poll controller.
 *
 * A thin adapter over {@link createAgentPoller}: it maps the goal answer to the
 * controller's payload and hands it the goal terminal-code predicate. Two
 * goal-specific policies:
 *
 * - **A transient read error keeps the last state** (`publishOnTransientError:
 *   false`): one flaky poll must not make an active goal look gone.
 * - **A terminal code removes the pill**, which is what "no goal support in
 *   this profile" should look like — the same answer as a profile that never
 *   had the feature, not an error the user can never clear.
 */
export function createGoalPoller(host: GoalPollerHost): GoalPoller {
  const adapter: AgentPollerHost<GoalState | null> = {
    read: async (agentId) => {
      const result = await host.readGoal(agentId);
      if (!result.available) return { available: false, error: result.error };
      return { available: true, data: result.goal ?? null };
    },
    listAgentPage: (cursor) => host.listAgentPage(cursor),
    addAgent: (agent) => host.addAgent(agent),
    removeAgent: (agentId, reason, error) => host.removeAgent(agentId, reason, error),
    publishState: (agentId, state: PollViewState<GoalState | null>) => {
      // The adapter only ever receives a successful answer: transient failures
      // are swallowed by `publishOnTransientError: false` and terminal ones
      // remove the pill. Guarded anyway so a future core change cannot publish
      // "no goal" for a failed read.
      if (!state.available) return;
      host.publishState(agentId, {
        goal: state.data,
        available: true,
        ...(state.error === undefined ? {} : { error: state.error }),
        ...(state.code === undefined ? {} : { code: state.code }),
      });
    },
    onError: (message, error) => host.onError(message, error),
    setTimeout: (callback, delayMs) => host.setTimeout(callback, delayMs),
    clearTimeout: (handle) => host.clearTimeout(handle),
    ...(host.random === undefined ? {} : { random: host.random }),
    isTerminalErrorCode: isTerminalGoalErrorCode,
    initialData: null,
    // The goal pill's own copy for the two diagnostics the shared controller
    // emits: the fallback sentence a failed read carries when the runtime sent
    // none, and the noun its console lines name.
    fallbackErrorMessage: "the DSH runtime could not read this agent's goal",
    pillLabel: "goal pill",
    publishOnTransientError: false,
  };
  return createAgentPoller(adapter);
}
