/**
 * One composer slot for the goal and the background jobs (T10b).
 *
 * **Why one slot.** On a phone the composer rail already carries the host's
 * own three pills (N/M 项任务, subagents, the diff count); with the team, goal
 * and jobs pills on top the host shrinks every plugin pill until only its icon
 * and a clipped first character are left. The user decided (2026-11-05) that
 * the goal and the jobs share one slot and switch with state; the team pill
 * keeps its own. This plugin then occupies at most two places on the rail.
 *
 * **Who owns what.** The goal and jobs halves keep their own pollers, stores,
 * presentation rules and panels (`goal-pill.tsx`, `jobs-pill.tsx`). Neither
 * registers a composer pill: each reports here, and this module owns the
 * **single** registration per agent ({@link GOAL_JOBS_SLOT_ID}) and decides
 * which half the trigger shows ({@link goalJobsSlotShown}).
 *
 * **The panel never changes identity.** `behavior` is set once, at
 * registration, to one fixed popover component per agent. Every later
 * `update` carries only `visible`/`label`/`title`/`icon`: the host closes an
 * open surface when a patch carries `behavior` (or hides/disables the button;
 * Paseo 0.15.0 `packages/app/src/plugins/buttons/model.ts:120-127`), so a flip
 * from goal to jobs while the panel is open must not touch it. Switching views
 * happens inside that one component's state, because the host renders
 * `behavior.Content` as `<Content {...props} close={close} />`
 * (`plugins/buttons/view.tsx:169-173`) and offers no other channel.
 *
 * Pure: no React, no host import (the host types are structural here), so
 * `harness/goal-pill-check.cjs` drives it with a fake `addComposerPill`.
 *
 * @module dsh-paseo/client/goal-jobs-slot
 */
import type { GoalState } from "../shared/goal";

/** The two halves that share the slot. */
export type SlotKind = "goal" | "jobs";

/** The registration id; one per agent, for both halves. A wire value, frozen. */
export const GOAL_JOBS_SLOT_ID = "dsh-goal-jobs";

/** The slice of each half the slot rule reads. */
export interface SlotGoalPresence {
  readonly visible: boolean;
}
export interface SlotJobsPresence {
  /** `jobsPillPresentation(...).visible`, unchanged: live work, or an unreadable registry. */
  readonly visible: boolean;
}

/**
 * Which half the slot's trigger shows, or `null` to hide it.
 *
 * - A goal exists (the goal half is visible): the goal, **always** — whether
 *   it runs, needs the user or is complete, and whatever the jobs do (user
 *   decision 2026-11-05, T12). The jobs stay one tap away on the panel's
 *   switch row.
 * - No goal, jobs present: the jobs.
 * - Neither: hidden.
 *
 * "Jobs present" is the jobs pill's own visibility, never re-derived here: live
 * work, or an unreadable registry the panel must explain. A finished job never
 * occupies the slot.
 */
export function goalJobsSlotShown(
  goal: SlotGoalPresence | undefined,
  jobs: SlotJobsPresence | undefined,
): SlotKind | null {
  if (goal?.visible === true) return "goal";
  if (jobs?.visible === true) return "jobs";
  return null;
}

/**
 * The open panel's view after a state change. It stays where the user put it
 * unless its own half disappeared, then falls back to the other half; a half
 * that comes back does not pull the view back.
 */
export function goalJobsSlotView(view: SlotKind, goalVisible: boolean, jobsVisible: boolean): SlotKind {
  if (view === "goal" && !goalVisible && jobsVisible) return "jobs";
  if (view === "jobs" && !jobsVisible && goalVisible) return "goal";
  return view;
}

/** What one half reports on every published answer. */
export interface SlotSideState<Icon> {
  readonly visible: boolean;
  /** The trigger text when this half is shown. */
  readonly label: string;
  /** The trigger title (accessibility name, tooltip, phone sheet header). */
  readonly title: string;
  /** The trigger icon when this half is shown; compared by identity. */
  readonly icon: Icon;
}
export interface SlotGoalState<Icon> extends SlotSideState<Icon> {
  /** What the jobs view's switch row draws. */
  readonly goal: GoalState | null;
}
export interface SlotJobsState<Icon> extends SlotSideState<Icon> {
  readonly live: boolean;
  /**
   * How the goal view's switch row names the jobs (「N 个后台」 while live).
   * Separate from `label`: the trigger's label is the bare noun (T12), the row
   * keeps the count.
   */
  readonly rowLabel: string;
}

/** What a half hands over when its poller registers an agent. */
export interface SlotSideAttach<Icon, Content> {
  /** The half's own panel, rendered inside the slot's fixed panel. */
  readonly Content: Content;
  /** The icon and title the registration starts with when this half arrives first. */
  readonly icon: Icon;
  readonly title: string;
  /**
   * Called once the slot's panel has closed, with the goal its goal view last
   * showed (`null` when the view was on screen with no goal). Only the open
   * view's body is mounted, so a half's own unmount also fires when the user
   * merely switches views; the goal half's "seen" bookkeeping waits for this.
   * Not called when the goal view never came on screen.
   */
  readonly onPanelClosed?: (goalShown: GoalState | null) => void;
}

/** One agent's slot, as the panel reads it. */
export interface SlotSnapshot<Icon, Content> {
  readonly shown: SlotKind | null;
  readonly goal?: SlotSideAttach<Icon, Content> & { readonly state?: SlotGoalState<Icon> };
  readonly jobs?: SlotSideAttach<Icon, Content> & { readonly state?: SlotJobsState<Icon> };
}

/** The patch the slot sends; `behavior` is deliberately not a field. */
export interface SlotPatch<Icon> {
  visible?: boolean;
  label?: string;
  title?: string;
  icon?: Icon;
}

/** The host's composer pill registration, structurally. */
export interface SlotRegistration<Icon> {
  update(patch: SlotPatch<Icon>): void;
  remove(): void;
}

/** The host half the coordinator needs. */
export interface GoalJobsSlotHost<Icon, Content> {
  addComposerPill(contribution: {
    id: string;
    workspaceId: string;
    agentId: string;
    button: {
      icon: Icon;
      title: string;
      visible: boolean;
      behavior: { kind: "popover"; Content: Content };
    };
  }): SlotRegistration<Icon>;
  /** The one fixed panel component for an agent; built once, at registration. */
  makeContent(agentId: string): Content;
}

/** The coordinator both halves report to, and the panel reads. */
export interface GoalJobsSlot<Icon, Content> {
  attach(kind: SlotKind, agent: { id: string; workspaceId?: string | null }, side: SlotSideAttach<Icon, Content>): void;
  presentGoal(agentId: string, state: SlotGoalState<Icon>): void;
  presentJobs(agentId: string, state: SlotJobsState<Icon>): void;
  detach(kind: SlotKind, agentId: string): void;
  snapshot(agentId: string): SlotSnapshot<Icon, Content> | undefined;
  subscribe(agentId: string, listener: () => void): () => void;
  /**
   * The open panel's view, so the title (the phone sheet header) follows it;
   * `undefined` when the panel closes, which hands the title back to the half
   * the trigger shows. Sends a title-only update, never a `behavior`.
   */
  panelView(agentId: string, view: SlotKind | undefined): void;
  /** The slot's panel unmounted (the host closed it); `undefined` = the goal view never showed. */
  panelClosed(agentId: string, goalShown: GoalState | null | undefined): void;
  dispose(): void;
}

interface SlotEntry<Icon, Content> {
  readonly registration: SlotRegistration<Icon>;
  goal?: SlotSideAttach<Icon, Content> & { state?: SlotGoalState<Icon> };
  jobs?: SlotSideAttach<Icon, Content> & { state?: SlotJobsState<Icon> };
  shown: SlotKind | null;
  /** The view the open panel shows; `undefined` while the panel is closed. */
  panelView?: SlotKind;
  /** What the registration carries now, so a patch holds only real changes. */
  sent: { visible: boolean; label?: string; title: string; icon: Icon };
  readonly listeners: Set<() => void>;
}

/** Create the per-agent goal/jobs slot coordinator. */
export function createGoalJobsSlot<Icon, Content>(host: GoalJobsSlotHost<Icon, Content>): GoalJobsSlot<Icon, Content> {
  const entries = new Map<string, SlotEntry<Icon, Content>>();
  let disposed = false;

  const notify = (entry: SlotEntry<Icon, Content>): void => {
    for (const listener of [...entry.listeners]) {
      try {
        listener();
      } catch {
        /* a panel that threw while re-rendering must not stop the others */
      }
    }
  };

  /**
   * Re-decide the trigger and send only what changed. A hidden slot keeps its
   * last label/icon: the host does not draw them, and resending would only
   * republish the composer (and restart a turning ring).
   */
  const recompute = (entry: SlotEntry<Icon, Content>): void => {
    const goal = entry.goal?.state;
    const jobs = entry.jobs?.state;
    const shown = goalJobsSlotShown(
      goal === undefined ? undefined : { visible: goal.visible },
      jobs === undefined ? undefined : { visible: jobs.visible },
    );
    entry.shown = shown;
    const patch: SlotPatch<Icon> = {};
    if (entry.sent.visible !== (shown !== null)) patch.visible = shown !== null;
    const side = shown === "goal" ? goal : shown === "jobs" ? jobs : undefined;
    if (side !== undefined) {
      if (entry.sent.label !== side.label) patch.label = side.label;
      if (entry.sent.icon !== side.icon) patch.icon = side.icon;
    }
    // The title is the phone sheet's header (`sheetTitle={button.title}`,
    // Paseo 0.15.0 `plugins/buttons/view.tsx:339`), so while the panel is open
    // it names the view on screen, not the half the trigger shows. A title-only
    // patch keeps the surface open (`model.ts:126` closes only on hide,
    // disable or a new `behavior`).
    const viewed = entry.panelView === "goal" ? goal : entry.panelView === "jobs" ? jobs : undefined;
    const titleSide = viewed?.visible === true ? viewed : side;
    if (titleSide !== undefined && entry.sent.title !== titleSide.title) patch.title = titleSide.title;
    if (Object.keys(patch).length > 0) {
      entry.sent = { ...entry.sent, ...patch };
      entry.registration.update(patch);
    }
    notify(entry);
  };

  return {
    attach(kind, agent, side) {
      if (disposed) return;
      let entry = entries.get(agent.id);
      if (entry === undefined) {
        const registration = host.addComposerPill({
          id: GOAL_JOBS_SLOT_ID,
          workspaceId: agent.workspaceId ?? "",
          agentId: agent.id,
          button: {
            icon: side.icon,
            title: side.title,
            // Hidden until a half proves otherwise: a pill that appears and then
            // disappears is worse.
            visible: false,
            behavior: { kind: "popover", Content: host.makeContent(agent.id) },
          },
        });
        entry = {
          registration,
          shown: null,
          sent: { visible: false, title: side.title, icon: side.icon },
          listeners: new Set(),
        };
        entries.set(agent.id, entry);
      }
      // A re-registration (after a drop, or an unauthorized poll) replaces the
      // half and forgets its last answer: the next poll reports it again.
      if (kind === "goal") entry.goal = { ...side };
      else entry.jobs = { ...side };
      recompute(entry);
    },
    presentGoal(agentId, state) {
      const entry = entries.get(agentId);
      if (entry?.goal === undefined) return;
      entry.goal = { ...entry.goal, state };
      recompute(entry);
    },
    presentJobs(agentId, state) {
      const entry = entries.get(agentId);
      if (entry?.jobs === undefined) return;
      entry.jobs = { ...entry.jobs, state };
      recompute(entry);
    },
    detach(kind, agentId) {
      const entry = entries.get(agentId);
      if (entry === undefined) return;
      if (kind === "goal") entry.goal = undefined;
      else entry.jobs = undefined;
      if (entry.goal === undefined && entry.jobs === undefined) {
        // Neither half serves this agent any more: the one registration goes.
        entries.delete(agentId);
        entry.registration.remove();
        notify(entry);
        return;
      }
      recompute(entry);
    },
    snapshot(agentId) {
      const entry = entries.get(agentId);
      if (entry === undefined) return undefined;
      return {
        shown: entry.shown,
        ...(entry.goal === undefined ? {} : { goal: entry.goal }),
        ...(entry.jobs === undefined ? {} : { jobs: entry.jobs }),
      };
    },
    subscribe(agentId, listener) {
      const entry = entries.get(agentId);
      if (entry === undefined) return () => {};
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    panelView(agentId, view) {
      const entry = entries.get(agentId);
      if (entry === undefined || entry.panelView === view) return;
      entry.panelView = view;
      recompute(entry);
    },
    panelClosed(agentId, goalShown) {
      if (goalShown === undefined) return;
      entries.get(agentId)?.goal?.onPanelClosed?.(goalShown);
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) entry.registration.remove();
      entries.clear();
    },
  };
}
