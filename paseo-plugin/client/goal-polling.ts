/**
 * The goal pill's presentation rule, its popover interaction rules, and the
 * adapter that binds both to the shared poll controller.
 *
 * `goal-pill.tsx` imports the host runtime (React, React Native, the plugin
 * component library), so plain `node` cannot load it. Everything here is pure:
 * the harness drives these functions directly instead of pattern-matching JSX,
 * which is the only way a rule like "a blocked goal shows 继续" can be asserted.
 *
 * **The four states the pill must tell apart** (DESIGN §2). `active + armed` is
 * the only state that is actually auto-continuing; `active + disarmed` looks
 * identical from the durable phase alone and is the silent degradation this
 * surface exists to fix — after a reopen the goal is still active but will never
 * continue on its own. `paused` and `blocked` are durable and need 继续.
 * `complete` is hidden: the goal is finished, and DSH's own GoalBar hides it
 * too.
 *
 * **The polling policy is the jobs pill's** (`client/agent-polling.ts`), shared
 * rather than copied. The two differences are both in the adapter below: the
 * payload is one goal (or `null`) instead of a list, and a transient read error
 * keeps the last state instead of publishing "could not read" (DESIGN §2).
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
 * languages, so a string baked in here could never be translated). The
 * round-bearing state is the only one that needs data.
 */
export type GoalLabel =
  | { readonly kind: "rounds"; readonly started: number; readonly max: number }
  | { readonly kind: "notRunning" }
  | { readonly kind: "paused" }
  | { readonly kind: "blocked" };

/**
 * The tone the label and the popover's status line use.
 *
 * `normal` is the only tone that means "this is working"; a goal that is not
 * auto-continuing is a warning even while its phase is active, and a blocked
 * goal is an error. Mapped to theme tokens by {@link goalToneColorToken}.
 */
export type GoalTone = "normal" | "warning" | "error";

/** The theme colour key one tone draws with. */
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

/** What the trigger shows for one answer. */
export type GoalPillPresentation =
  | { readonly visible: false }
  | {
      readonly visible: true;
      readonly label: GoalLabel;
      readonly tone: GoalTone;
      /** The button's title: the objective, truncated for the composer. */
      readonly title: string;
    };

/**
 * The longest objective the pill's title carries before it is cut.
 *
 * The title is what the compact popover draws as its sheet header and what the
 * trigger shows on a wide composer, so it has to stay one short line; the full
 * objective is always in the popover body. 60 characters fits the header of a
 * phone sheet without wrapping in either language.
 */
export const GOAL_TITLE_MAX_LENGTH = 60;

/** The ellipsis appended to a cut title. One character, both languages. */
export const GOAL_TITLE_ELLIPSIS = "…";

/**
 * The objective as the trigger's title: one line, cut at
 * {@link GOAL_TITLE_MAX_LENGTH}.
 *
 * Counted in code points (`Array.from`) rather than UTF-16 units so an emoji or
 * a surrogate pair is never cut in half. A title that is exactly the limit is
 * left alone — the ellipsis is only for text that actually lost characters.
 */
export function goalTitle(objective: string, max = GOAL_TITLE_MAX_LENGTH): string {
  const points = Array.from(objective.trim());
  if (points.length <= max) return points.join("");
  return points.slice(0, max).join("") + GOAL_TITLE_ELLIPSIS;
}

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
  const title = goalTitle(goal.objective);
  if (goal.phase === "blocked") {
    return { visible: true, label: { kind: "blocked" }, tone: "error", title };
  }
  if (goal.phase === "paused") {
    return { visible: true, label: { kind: "paused" }, tone: "warning", title };
  }
  if (goal.activation === "disarmed") {
    return { visible: true, label: { kind: "notRunning" }, tone: "warning", title };
  }
  return {
    visible: true,
    label: { kind: "rounds", started: goal.roundsStarted, max: goal.maxGoalRounds },
    tone: "normal",
    title,
  };
}

/**
 * The control buttons the popover offers, in drawing order.
 *
 * DESIGN §2's table, as data: a goal that is auto-continuing offers 暂停; one
 * that is not (disarmed, paused, blocked) offers 继续; every visible state
 * offers 编辑 and 清除. **Unavailable actions are not drawn, never disabled** —
 * a disabled button claims "you could do this but not now", which is wrong for
 * a state that has no such operation at all.
 *
 * `blocked` keeps 继续 even when the round cap is exhausted: DSH refuses that
 * resume with its own sentence ("not valid for the current state"), and the
 * popover shows it verbatim. Hiding the button instead would leave the user
 * with no way to discover why.
 */
export function goalActionsFor(goal: GoalState): readonly GoalAction[] {
  const primary: GoalAction =
    goal.phase === "active" && goal.activation === "armed" ? "pause" : "resume";
  return [primary, "edit", "clear"];
}

/**
 * What the 清除 button does on one click.
 *
 * `arm` is the first click: it only turns the button into its confirmation
 * label, so a mis-tap cannot destroy the goal. `run` is the second click on the
 * same button. Any other action resets the arm — the state machine lives here
 * rather than in the JSX so the harness can assert that one click never
 * executes.
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
 * `/goal edit` grammar rejects it; the popover must not submit it. The
 * server half refuses it again — this is the UI half, not the only guard.
 */
export function goalEditDraftValid(draft: string): boolean {
  return draft.trim() !== "";
}

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
