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
/* The action rows (Paseo row style, not buttons)                              */
/* -------------------------------------------------------------------------- */

/**
 * The label for one action row.
 *
 * The destructive row switches to its confirmation sentence when armed, so the
 * screen says "press again to clear" instead of relying on colour alone.
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

/**
 * The leading glyph for one action row.
 *
 * Lucide names the host can draw (`Icon` from `@getpaseo/plugin/client/ui`).
 * Rows carry an icon and a title like the host's own menu rows; there is no
 * button fill and no border — the brief explicitly forbids both.
 */
export function goalActionIcon(action: GoalAction): "Pause" | "Play" | "Pencil" | "Trash2" {
  switch (action) {
    case "pause":
      return "Pause";
    case "resume":
      return "Play";
    case "edit":
      return "Pencil";
    case "clear":
      return "Trash2";
  }
}

/**
 * The status line's 8px dot colour token per tone.
 *
 * The user asked for the status colour to identify the four states; the label
 * text cannot carry it (the host draws the popover's text, and `accent` as text
 * fails AA on the dark surface at 2.83:1). The dot is the colour channel:
 * accent while auto-continuing, warning when not, danger when blocked.
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

/**
 * The status line: the phase word and the round budget on **one** line.
 *
 * `进行中 · 第 3 轮 · 预算 10`. The 8px dot in front carries the tone colour;
 * the text stays `foreground` because `accent` as text fails AA on the dark
 * surface (2.83:1), which the verification round made explicit.
 */
export function goalStatusLine(
  goal: GoalState,
  statuses: Readonly<Record<string, string>>,
  rounds: (started: number, max: number) => string,
): string {
  return `${statuses[goal.phase] ?? goal.phase} · ${rounds(goal.roundsStarted, goal.maxGoalRounds)}`;
}

/** The objective's line count in the popover header: one, truncated. */
export const GOAL_OBJECTIVE_MAX_LINES = 1;

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
 * The rendering is one row per action, in this order.
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
