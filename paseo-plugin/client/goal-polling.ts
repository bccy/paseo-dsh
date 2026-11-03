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
import { isTerminalGoalErrorCode, type GoalState } from "../shared/goal";

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
 * goal is an error. Mapped to theme tokens by {@link goalIconColorToken} (the
 * 14px trigger glyph); the panel's facts line stays muted, like the host's row
 * facts.
 */
export type GoalTone = "normal" | "warning" | "error";

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
): "foregroundMuted" | "statusWarning" | "statusDanger" {
  switch (tone) {
    case "normal":
      return "foregroundMuted";
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
 * A menu row's box: `components/ui/menu/menu-item.tsx:441`'s `item`, value for
 * value (`MENU_ITEM_HEIGHT` xs 40 / md 28). The 1px border is always present —
 * transparent at rest — so a row that turns destructive cannot resize.
 */
export interface GoalMenuItem extends GoalTrackRow {
  readonly borderWidth: number;
}

/** `item` at one density; the caller supplies the border colour. */
export function goalMenuItem(compact: boolean): GoalMenuItem {
  return {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: compact ? 40 : 28,
    marginHorizontal: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
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

/** The edit field's floor: four lines of 20 (`menu-item.tsx:457-478`'s field). */
export const GOAL_EDITOR_MIN_HEIGHT = 80;

/**
 * The edit page's width on wide layouts: the popover surface's own 420 minus
 * the 12px content padding on each side, so replacing the objective row with
 * the field does not shrink the surface under the pointer.
 */
export const GOAL_EDITOR_WIDTH_WIDE = 396;

/** `MenuSeparator`: 1px, 4px above and below, full width (`menu-item.tsx:407`). */
export const GOAL_SEPARATOR_HEIGHT = 1;
export const GOAL_SEPARATOR_MARGIN_VERTICAL = 4;

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
