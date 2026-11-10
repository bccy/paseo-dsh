/**
 * The goal pill's presentation rules, its popover geometry, and the projection one
 * pushed goal answer goes through.
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
 * **The transport is not this module's business** (2026-11-11, Paseo 0.16). The
 * goal used to be polled every four seconds; `server/pill-feed` now reads it once
 * per agent and pushes the snapshot to every subscriber. What stays goal-specific
 * is {@link projectGoalAnswer}: the payload is one goal (or `null`) instead of a
 * list, and a transient failure keeps the last state instead of publishing
 * "could not read".
 *
 * @module dsh-paseo/client/goal-polling
 */
import type { PillReadResult } from "./agent-subscriptions";
import type { GoalAnswer, GoalState } from "../shared/goal";

/** One agent's state as the popover store keeps it. */
export interface GoalViewState {
  goal: GoalState | null;
  available: boolean;
  error?: string;
  code?: string;
}

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
  | { readonly kind: "blocked" }
  /** A completed goal the user has not seen yet (UI-v7). */
  | { readonly kind: "complete" };

/**
 * The tone the status line, the trigger icon and the "now" line use.
 *
 * `normal` is the only tone that means "this is working"; a goal that is not
 * auto-continuing is a warning even while its phase is active, and a blocked
 * goal is an error. Mapped to theme tokens by {@link goalIconColorToken} (the
 * 14px trigger glyph); the panel's facts line stays muted, like the host's row
 * facts.
 */
export type GoalTone = "normal" | "warning" | "error" | "success";

/**
 * The theme colour key one tone draws the trigger's glyph with.
 *
 * `normal` is `foregroundMuted`, not `accent`: the design's rule is one signal
 * one token, and on the composer rail every host mark is a single muted glyph.
 * A running goal's glyph is not even this — it is the running ring (see
 * `goalRunningMark`); this colour is what a *non-running* normal goal draws.
 * The not-continuing states reuse the warning/danger text colours. The host
 * paints a plugin pill's label itself (plain text, no colour channel), so the
 * glyph is the only place this tone can reach the trigger.
 */
export function goalIconColorToken(
  tone: GoalTone,
): "foregroundMuted" | "statusWarning" | "statusDanger" | "statusSuccess" {
  switch (tone) {
    case "normal":
      return "foregroundMuted";
    case "warning":
      return "statusWarning";
    case "error":
      return "statusDanger";
    case "success":
      // A completed goal not yet seen: the host's "done, review it" state is
      // green (`statusDotSuccess` for the `attention` bucket); the plugin theme
      // carries only `statusSuccess`, so that is the one token.
      return "statusSuccess";
  }
}

/**
 * The trigger's glyph name for one tone: a completed goal draws the host's
 * completed-task mark (`CircleCheck`, `components/task-list-row.tsx`), every
 * other non-running state the `Target`. The running ring replaces either.
 */
export function goalIconName(tone: GoalTone): "CircleCheck" | "Target" {
  return tone === "success" ? "CircleCheck" : "Target";
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
 * The key a completed goal's "seen" state is remembered under: `id:revision`.
 * A new goal (new id) or a new mutation of the same goal (new revision) is a
 * new key, so it is shown again even if its objective reads the same.
 */
export function goalSeenKey(goal: Pick<GoalState, "id" | "revision">): string {
  return `${goal.id}:${String(goal.revision)}`;
}

/**
 * Whether the pill is shown for one answer, and what it says.
 *
 * Visibility (UI-v7): **a goal exists, and if it is complete the user has not
 * seen it yet**. A `null` goal (never created, or cleared) is hidden. A
 * `complete` goal is shown once — `seen` is the client's remembered
 * {@link goalSeenKey} for this agent, and a complete goal whose key equals it is
 * hidden. DSH's own Web hides a complete goal at once (survey §2); showing it
 * until seen is this plugin's bounded extension. `available: false` is
 * hidden too, but that branch is normally unreachable: terminal answers remove
 * the pill outright and transient ones keep the last state (see
 * {@link projectGoalAnswer} and the pill's host options).
 *
 * `active + disarmed` is a warning, not a normal label: the goal is not
 * finished, it is just not continuing on its own, and the popover's 继续 button
 * is the fix.
 */
export function goalPillPresentation(
  answer: {
    available: boolean;
    goal?: GoalState | null;
  },
  seen?: string,
): GoalPillPresentation {
  const goal = answer.goal ?? null;
  if (!answer.available || goal === null) {
    return { visible: false };
  }
  if (goal.phase === "complete") {
    if (seen === goalSeenKey(goal)) return { visible: false };
    return { visible: true, label: { kind: "complete" }, tone: "success" };
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

/** The copy `goalPillCopy` needs: the noun. */
export interface GoalPillWords {
  readonly title: string;
}

/**
 * The trigger's two strings (UI-v7): the noun 「目标」/「Goal」 for **both**, in
 * every state.
 *
 * - `label` is the text drawn in the pill; the glyph (tone colour, running ring,
 *   completed check) carries the state.
 * - `title` is the host's accessibility name, desktop tooltip **and** phone
 *   sheet header (`plugins/buttons/view.tsx`) — one string for all three, the
 *   plugin API has no separate slot. The sheet header must read 「目标」, so the
 *   accessibility name does too (the user accepted this); the full state is
 *   spoken by the panel's first row instead (`goalStateName`).
 */
export function goalPillCopy(
  _presentation: GoalPillPresentation,
  words: GoalPillWords,
): { label: string; title: string } {
  return { label: words.title, title: words.title };
}

/** The full state names, for the panel's first-row accessibility label. */
export interface GoalStateWords {
  readonly running: string;
  readonly notRunning: string;
  readonly paused: string;
  readonly blocked: string;
  readonly complete: string;
}

/**
 * The goal's state in full words (「目标进行中」…「目标已完成」), for the panel's
 * objective row: with the pill's name fixed to the noun, this is where a screen
 * reader hears the state. Same rule as the pill, so the two cannot disagree.
 */
export function goalStateName(goal: GoalState, words: GoalStateWords): string {
  if (goal.phase === "complete") return words.complete;
  if (goal.phase === "blocked") return words.blocked;
  if (goal.phase === "paused") return words.paused;
  if (goal.activation === "disarmed") return words.notRunning;
  return words.running;
}

/* -------------------------------------------------------------------------- */
/* A completed goal's "seen" state (UI-v7)                                     */
/* -------------------------------------------------------------------------- */

/** One input to {@link goalCompleteSeenStep}. */
export type GoalCompleteEvent =
  /** A poll answer: the goal now (null when there is none). */
  | { readonly kind: "goal"; readonly goal: GoalState | null }
  /**
   * The agent's status, from the agent directory subscription.
   *
   * **Never a "seen" signal.** This used to mean "the user sent the next
   * message" (idle, then running), which hid a completed goal the user had
   * never opened. It is kept as an explicit no-op so the existing subscription
   * wiring stays harmless.
   */
  | { readonly kind: "agent"; readonly status: string | undefined }
  /** The completed panel was opened and then **really** closed (`./seen-close-gate`). */
  | { readonly kind: "closed"; readonly goal: GoalState | null };

/** The machine's state: the remembered seen key. */
export interface GoalSeenState {
  readonly seen?: string;
}

/**
 * Advance one agent's "seen" state.
 *
 * Seen means **only one thing**: the panel of that completed goal was opened
 * and then really closed — the close reported by `./seen-close-gate` after its
 * confirmation window. An agent status event (including the next turn
 * starting, i.e. the user sending another message) never marks a goal seen: a
 * completed pill must stay until the user has actually opened its panel. Polls
 * never mark anything either; a new goal (new `id`) or a new mutation (new
 * `revision`) is a new key and shows again. The remembered key is kept when
 * the goal leaves `complete` (cleared, replaced), so the same `id:revision`
 * cannot reappear.
 */
export function goalCompleteSeenStep(state: GoalSeenState, event: GoalCompleteEvent): GoalSeenState {
  switch (event.kind) {
    case "goal":
    case "agent":
      return state;
    case "closed": {
      const goal = event.goal;
      if (goal === null || goal.phase !== "complete") return state;
      return { seen: goalSeenKey(goal) };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The panel's row geometry (the host's numbers, value for value)              */
/* -------------------------------------------------------------------------- */

/**
 * The rail every panel row sits on: `composer/tracks.tsx:347-379`'s `trackRow`,
 * value for value. The compact breakpoint is the phone sheet (40px row, 8px
 * vertical padding), the wide one the desktop popover (32 / 4). The 4px
 * horizontal margin is what makes a row a rounded block inside the surface
 * instead of a full-width stripe — the single geometric reason the old panel
 * read as "not Paseo".
 */
export interface GoalTrackRow {
  readonly flexDirection: "row";
  readonly alignItems: "center";
  readonly gap: number;
  readonly minHeight: number;
  readonly marginHorizontal: number;
  readonly paddingHorizontal: number;
  readonly paddingVertical: number;
  readonly borderRadius: number;
}

/** `trackRow` at one density. */
export function goalTrackRow(compact: boolean): GoalTrackRow {
  return {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: compact ? 40 : 32,
    marginHorizontal: 4,
    paddingHorizontal: 8,
    paddingVertical: compact ? 8 : 4,
    borderRadius: 6,
  };
}

/**
 * The row-end icon button: `components/ui/icon-button-chrome.ts:11-14` — 20×20
 * with a 14px glyph on a pointer layout, 32×32 with an 18px glyph under a finger
 * (the compact touch target).
 */
export interface GoalIconButton {
  readonly size: number;
  readonly glyph: number;
  readonly borderRadius: number;
}

/** The icon button's box at one density. */
export function goalIconButton(compact: boolean): GoalIconButton {
  return { size: compact ? 32 : 20, glyph: compact ? 18 : 14, borderRadius: 6 };
}

/** The whale mark's edge: the host's 16px icon slot (`task-list-row.tsx:15-25`). */
export const GOAL_WHALE_SIZE = 16;

/** The corner ring's frame: the host's 14px `StatusRingFrame` (`status-ring/frame.tsx`). */
export const GOAL_RING_FRAME_SIZE = 14;

/** The corner ring's offset: the host's `getStatusRingOffset(-2, 8)` = -5. */
export const GOAL_RING_OFFSET = -5;

/** The objective's line height (`fontSize.base` 14 → 20). */
export const GOAL_OBJECTIVE_LINE_HEIGHT = 20;

/** The facts line's line height (`fontSize.sm` 12 → 16). */
export const GOAL_FACTS_LINE_HEIGHT = 16;

/* -------------------------------------------------------------------------- */
/* The edit page: a small Paseo composer (design-opus-v4, direction C)         */
/* -------------------------------------------------------------------------- */

/**
 * The editor box: the host composer's `inputWrapper`
 * (`composer/input/input.tsx:2259-2287`) at its compact padding — 16px radius,
 * 8px top/bottom, 12px left/right, 12px between the text and the button row.
 * The box sits 8px in from the panel edge so its 16px corner is concentric with
 * the surface's 8px one.
 */
export const GOAL_EDITOR_RADIUS = 16;
export const GOAL_EDITOR_PADDING_VERTICAL = 8;
export const GOAL_EDITOR_PADDING_HORIZONTAL = 12;
export const GOAL_EDITOR_GAP = 12;
export const GOAL_EDITOR_MARGIN_HORIZONTAL = 8;

/** The composer's 28px round send button (`input.tsx:2390-2398`). */
export const GOAL_SAVE_BUTTON_SIZE = 28;

/** A disabled send button is the same button at half opacity (`input.tsx:2429-2431`). */
export const GOAL_SAVE_DISABLED_OPACITY = 0.5;

/** The field grows from two lines to six, then scrolls inside the box. */
export const GOAL_EDITOR_MIN_LINES = 2;
export const GOAL_EDITOR_MAX_LINES = 6;

/**
 * The field's type: the host's `fontSize.content` (15 on web, 16 on native) at
 * the composer's 1.4 line height (`input.tsx:2325-2345`). The plugin theme has
 * no `fontSize`, so the two host values are restated here.
 */
export interface GoalEditorType {
  readonly fontSize: number;
  readonly lineHeight: number;
}

export function goalEditorType(web: boolean): GoalEditorType {
  const fontSize = web ? 15 : 16;
  return { fontSize, lineHeight: Math.round(fontSize * 1.4) };
}

/**
 * The field's height for a measured text height: at least two lines, at most
 * six. An unmeasured text (0, or a layout that never ran) is the two-line floor,
 * never zero — an editor must never collapse to nothing.
 */
export function goalEditorHeight(measured: number, lineHeight: number): number {
  const floor = GOAL_EDITOR_MIN_LINES * lineHeight;
  const ceiling = GOAL_EDITOR_MAX_LINES * lineHeight;
  if (!Number.isFinite(measured) || measured <= 0) return floor;
  return Math.min(ceiling, Math.max(floor, Math.ceil(measured)));
}

/** The keys the edit field reacts to, as read from a key event. */
export interface GoalEditKey {
  readonly key: string;
  readonly shiftKey: boolean;
  /** An IME composition is in progress (`isComposing` or keyCode 229). */
  readonly composing: boolean;
  /**
   * Whether Enter submits here: a pointer layout on web only, the host
   * composer's rule (`input.tsx:1768`, `isWeb && !isCompact`). On a phone Enter
   * is a newline and only the ✓ button saves.
   */
  readonly submitOnEnter: boolean;
}

/**
 * What a key does in the edit field.
 *
 * - Escape cancels (a phone has no Escape, so this is a desktop key in practice).
 * - Enter saves only where Enter submits, never with Shift (Shift+Enter is the
 *   newline, `composer/input/state.ts:167-176`), and never mid-composition (the
 *   Enter that commits an IME candidate is not a submit).
 * - Everything else is typing.
 */
export function goalEditKeyAction(input: GoalEditKey): "save" | "cancel" | null {
  if (input.key === "Escape") return "cancel";
  if (input.key !== "Enter") return null;
  if (!input.submitOnEnter || input.shiftKey || input.composing) return null;
  return "save";
}

/**
 * The edit page's width on wide layouts: the popover surface's own 420 minus
 * the 12px content padding on each side, so replacing the objective row with
 * the field does not shrink the surface under the pointer.
 */
export const GOAL_EDITOR_WIDTH_WIDE = 396;

/**
 * The clear confirmation (UI-v9, direction B): the view page's objective row
 * held in place, its two row-end icon buttons swapped for a quiet 取消 and a
 * red round trash button.
 *
 * The red button sits where the view page's trash was, so a double click (or
 * a double tap) on the trash would land on it. For {@link GOAL_CONFIRM_ARM_MS}
 * after the page appears it is therefore inert and drawn faded and slightly
 * shrunk, then it settles to full size and colour; the press is the user's
 * second, deliberate one. Position was kept (rather than moving the button
 * away) because the row's end is where the action lives on the view page —
 * moving it would make the confirmation read as a different control.
 */
export const GOAL_CONFIRM_ARM_MS = 400;

/** The red button's look while it is not armed yet. */
export const GOAL_CONFIRM_UNARMED_OPACITY = 0.35;
export const GOAL_CONFIRM_UNARMED_SCALE = 0.86;

/** The web fade/scale from unarmed to armed; native jumps (state re-render, FIELD-NOTES on Animated). */
export const GOAL_CONFIRM_SETTLE_MS = 160;

/**
 * The host destructive button's pressed opacity (`components/ui/button.tsx`
 * `pressed: { opacity: 0.85 }`); hover is a lighter step of the same.
 */
export const GOAL_DANGER_PRESSED_OPACITY = 0.85;
export const GOAL_DANGER_HOVER_OPACITY = 0.92;

/** The confirmation row's trailing controls at one density. */
export interface GoalConfirmControls {
  /** The red round button's edge: the phone's 32px touch floor, 24 on a pointer layout. */
  readonly dangerSize: number;
  readonly dangerGlyph: number;
  /** The quiet 取消: the red button's height, 8px side padding, 12px muted text. */
  readonly cancelPaddingHorizontal: number;
  /** Between 取消 and the red button: the view page's 4px icon-button gap. */
  readonly gap: number;
}

/**
 * The confirmation's trailing geometry. With 取消 about 40px wide, the row end
 * is 76px on a phone against the view page's 68 (two 32px buttons and a 4px
 * gap), so the objective keeps all but 8px of its width there.
 */
export function goalConfirmControls(compact: boolean): GoalConfirmControls {
  return {
    dangerSize: compact ? 32 : 24,
    dangerGlyph: compact ? 18 : 14,
    cancelPaddingHorizontal: 8,
    gap: 4,
  };
}

/** `MenuHint`'s box: 12px horizontal, 8px vertical (`menu-item.tsx` hint styles). */
export const GOAL_HINT_PADDING_HORIZONTAL = 12;
export const GOAL_HINT_PADDING_VERTICAL = 8;

/**
 * How long a just-idled agent still counts as running.
 *
 * The round driver only schedules the next round after the agent settles and the
 * session flushes (`dsh-goal-round-driver`), so an armed goal really does go
 * `running → idle → running` between rounds. Without a hold the ring would blink
 * off and on every round; 1.5s covers the flush gap while still stopping within
 * a breath when the goal is not actually working. The value is the design's
 * 【推断】 — it should be re-measured on a device with a real goal.
 */
export const GOAL_RUNNING_HOLD_MS = 1500;

/** The agent statuses the host exposes (`contracts.d.ts:38-42`). */
export type GoalAgentStatus = "initializing" | "idle" | "running" | "error" | "closed";

/** Everything {@link goalRunningMark} decides from. */
export interface GoalRunningInput {
  readonly phase: GoalState["phase"];
  readonly activation: GoalState["activation"];
  /** `useAgent(agentId, a => a.status)`; null when the host exposes none. */
  readonly agentStatus: GoalAgentStatus | null | undefined;
  /** ms epoch until which a just-idled agent still counts as running. */
  readonly holdUntil?: number;
  readonly now: number;
}

/**
 * Whether the running ring turns.
 *
 * The design's truth table (A2): the goal must be `active + armed` **and** the
 * agent must really be running. An armed goal whose agent is idle only turns
 * while the {@link GOAL_RUNNING_HOLD_MS} hold from its last running moment is
 * still open. Everything else — disarmed, paused, blocked, complete, a missing
 * agent status, or a non-running status — is a static mark.
 *
 * The alternative (A1: turn whenever `active + armed`) was rejected in the
 * design: it spins while DSH is not working, which is the "silent degradation"
 * class this project treats as a bug. When the host cannot answer the agent's
 * status at all, the mark stays static rather than guessing.
 */
export function goalRunningMark(input: GoalRunningInput): boolean {
  if (input.phase !== "active" || input.activation !== "armed") return false;
  if (input.agentStatus === "running") return true;
  if (input.agentStatus !== "idle") return false;
  return input.holdUntil !== undefined && input.holdUntil > input.now;
}

/**
 * The facts line under the objective: `进行中 · 第 3 轮 · 预算 10`.
 *
 * One `sm` line in `foregroundMuted`, the way a subagent row carries its
 * provider/model under the title (`subagents/track.tsx` row facts). The round
 * budget is a sentence here, never a fraction beside the phase.
 */
export function goalFactsLine(
  goal: GoalState,
  statuses: Readonly<Record<string, string>>,
  rounds: (started: number, max: number) => string,
): string {
  // `active + disarmed` is its own fact: the phase alone would say 「进行中」 while
  // the same panel's pill says 「目标未在续跑」, and the design's disarmed state
  // reads 「未在续跑 · 第 N 轮 · 预算 M」 (design v1 §98). The word lives in
  // `statuses.disarmed`; it is not a phase, so it is looked up before the phase.
  const disarmed = goal.phase === "active" && goal.activation === "disarmed";
  const word = disarmed ? (statuses.disarmed ?? "disarmed") : (statuses[goal.phase] ?? goal.phase);
  return [word, rounds(goal.roundsStarted, goal.maxGoalRounds)].join(" · ");
}

/** The "now" line's content: DSH's own `in_progress` todo text, or undefined. */
export function goalCurrentTaskLine(goal: GoalState): string | undefined {
  const current = goal.currentTask;
  if (current === undefined) return undefined;
  const trimmed = current.trim();
  return trimmed === "" ? undefined : trimmed;
}

/* -------------------------------------------------------------------------- */
/* The edit page's rules                                                       */
/* -------------------------------------------------------------------------- */

/** What happened in the panel that may move it to another page or close it. */
export type GoalPanelEvent =
  /** The edit page's 取消, or Escape in its field. */
  | { readonly kind: "cancelEdit" }
  /** The clear confirmation page's 取消. */
  | { readonly kind: "cancelClear" }
  /** A `/goal` control action answered. */
  | { readonly kind: "control"; readonly action: "pause" | "resume" | "clear" | "edit"; readonly ok: boolean };

/**
 * Where the panel goes after one event (UI-v8).
 *
 * - `close`: call the host's `close()`, back to the conversation. Leaving the
 *   editor — cancelled, or saved successfully — closes the panel outright; the
 *   user was done with it the moment they started editing the one thing in it.
 * - `view`: the panel's main page. The clear page's 取消 returns there (it is a
 *   detour from the main page, not a task of its own), and so does every other
 *   successful action.
 * - `stay`: a refused or failed action keeps the current page, so DSH's sentence
 *   is shown where the user acted (an edit keeps the draft).
 */
export function goalPanelNext(event: GoalPanelEvent): "close" | "view" | "stay" {
  switch (event.kind) {
    case "cancelEdit":
      return "close";
    case "cancelClear":
      return "view";
    case "control":
      if (!event.ok) return "stay";
      return event.action === "edit" ? "close" : "view";
  }
}

/** Whether the draft can be submitted: non-blank **and** changed. */
export function goalEditDraftValid(draft: string): boolean {
  return draft.trim() !== "";
}

/**
 * Whether the save action is enabled.
 *
 * Two rules from the design: an empty objective cannot be saved (DSH would
 * reject it), and an unchanged draft cannot be saved either — the host disables
 * a rename's submit when the value did not change (`rename-modal.tsx:111`).
 */
export function goalEditSubmittable(draft: string, original: string): boolean {
  return goalEditDraftValid(draft) && draft !== original;
}

/* -------------------------------------------------------------------------- */
/* The pushed answer                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Map one pushed goal answer to the controller's payload
 * (`client/agent-subscriptions`).
 *
 * Only two things happen here, both of them rules the old poller's adapter held:
 * a failed answer keeps its message and code so the controller can grade it, and
 * an empty goal becomes `null` — "we looked and there is no goal" — never a
 * fabricated one.
 *
 * **A transient failure keeps the last state** (`publishOnTransientError: false`
 * in the pill's host options): one flaky answer must not make an active goal look
 * gone. **A terminal code removes the pill**, which is what "no goal support in
 * this profile" should look like — the same answer as a profile that never had
 * the feature, not an error the user can never clear.
 */
export function projectGoalAnswer(answer: GoalAnswer): PillReadResult<GoalState | null> {
  if (!answer.available) return { available: false, ...(answer.error === undefined ? {} : { error: answer.error }) };
  return { available: true, data: answer.goal ?? null };
}
