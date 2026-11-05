/**
 * The composer pill that shows the current DeepSeek Harness goal and lets the
 * user pause, resume, edit or clear it.
 *
 * **One slot with the jobs (T10b).** The jobs half is a live counter that
 * hides the moment nothing runs; a goal stays relevant while it exists,
 * including when it is *not* running. They used to be two registrations; on a
 * phone the host then shrank every plugin pill to a bare icon. They now share
 * one composer slot (`./goal-jobs-slot`): this module reports the goal's
 * presentation to it, and the slot decides which half the trigger shows — the
 * goal whenever it needs the user, the jobs while the goal runs on its own and
 * something is live. Both rules stay their own (`goalPillPresentation`,
 * `jobsPillPresentation`); the slot only chooses between them. This module also
 * hosts the slot's one fixed panel ({@link makeGoalJobsPopover}).
 *
 * **Why it polls.** DSH's goal lives in the `dsh` child process and Paseo 0.14
 * has no goal protocol at all (no field, no event, no capability bit — see
 * DESIGN §0), so there is nothing to subscribe to. A plugin RPC is the supported
 * channel for daemon-side reads; the cadence is the jobs pill's, shared through
 * `client/agent-polling.ts`.
 *
 * **What the trigger can and cannot show (UI-v6).** The *label* is the fixed
 * noun 「目标」/「Goal」 in every state. The state is shown by the **icon**, a
 * custom component — a `Target` glyph coloured by tone, with the running ring on
 * its corner while the goal is really running (T10b: the glyph is never
 * replaced, so a pill shrunk to its icon still reads as the goal) (`goalIconColorToken`: muted while
 * armed, warning when not continuing, danger when blocked) — and spelled out in
 * the button's `title` (「目标进行中」/「目标未在续跑」/「目标已暂停」/「目标受阻」).
 * The host uses `title` as the button's accessibility name and desktop tooltip,
 * and as the phone sheet's header (`plugins/buttons/view.tsx`): the plugin API
 * has no separate accessibility-name slot, so a screen reader can only hear the
 * state through `title`. The full objective still lives once, in the popover body.
 *
 * **What is never shown.** A goal the user cannot read is not "no goal": the
 * poller keeps the last state on a transient error, and a terminal error (a
 * bridge without `paseo/goal`, a profile with no goal service) removes the pill
 * — the same appearance as a profile that never had the feature, rather than an
 * error the user can never dismiss.
 *
 * @module dsh-paseo/client/goal-pill
 */
import type {
  PluginButtonContentProps,
  PluginButtonIcon,
  PluginButtonIconProps,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { goalControl, goalCurrent, type GoalAction, type GoalState } from "../shared/goal";
import { CornerRingIcon } from "./corner-ring";
import { DeepSeekMark } from "./deepseek-mark";
import {
  createGoalJobsSlot,
  goalJobsSlotView,
  goalNeedsAttention,
  type GoalJobsSlot,
  type SlotKind,
  type SlotSnapshot,
} from "./goal-jobs-slot";
import { GoalPopoverBody } from "./goal-popover";
import { useAgent, useGoalRunningMark } from "./goal-running";
import {
  createGoalPoller,
  goalCompleteSeenStep,
  goalEditSubmittable,
  goalFactsLine,
  goalStateName,
  GOAL_FACTS_LINE_HEIGHT,
  GOAL_OBJECTIVE_LINE_HEIGHT,
  GOAL_WHALE_SIZE,
  goalIconColorToken,
  goalIconName,
  goalPillCopy,
  goalPanelNext,
  goalPillPresentation,
  type GoalCompleteEvent,
  type GoalPoller,
  type GoalSeenState,
  type GoalTone,
  type GoalViewState,
} from "./goal-polling";
import {
  CHEVRON_BOX,
  FACTS_FONT_SIZE,
  POPOVER_HOST_PADDING,
  SECTION_SEPARATOR_COLOR,
  SECTION_SEPARATOR_HEIGHT,
  SECTION_SEPARATOR_MARGIN_VERTICAL,
  TITLE_FONT_SIZE,
  chevronColorToken,
  popoverRootBox,
  rowActiveFill,
  rowBox,
  rowTextColumn,
} from "./jobs-popover-layout";
import { JobsPillIcon } from "./jobs-spinner";
import { localeText } from "./locale";

/** One agent's latest answer, plus the listeners the pill and popover subscribe with. */
interface AgentGoal {
  goal: GoalState | null;
  /** `false` when the runtime could not be read — never confused with "none". */
  available: boolean;
  error?: string;
  /** The remembered `id:revision` of the completed goal the user has seen. */
  seen?: string;
  /** The trigger's glyph and the popover re-render from this set when a poll lands. */
  readonly listeners: Set<() => void>;
}

/** The live answer per agent, shared by the pill, its glyph and its popover. */
export type GoalStore = Map<string, AgentGoal>;

/** The tone the trigger's glyph should draw with for one stored answer. */
function goalToneOf(entry: AgentGoal | undefined): GoalTone {
  const presentation = goalPillPresentation(
    {
      available: entry?.available ?? true,
      goal: entry?.goal ?? null,
    },
    entry?.seen,
  );
  // A hidden pill draws nothing; the warning tone is only the initial value
  // before the first poll, and the glyph is invisible then anyway.
  return presentation.visible ? presentation.tone : "warning";
}

function publish(store: GoalStore, agentId: string, next: Omit<AgentGoal, "listeners">): void {
  const previous = store.get(agentId);
  const entry: AgentGoal = { ...next, listeners: previous?.listeners ?? new Set() };
  store.set(agentId, entry);
  for (const listener of [...entry.listeners]) {
    try {
      listener();
    } catch {
      /* a popover that threw while re-rendering must not stop the others */
    }
  }
}

/**
 * The trigger's glyph: the Target mark coloured by the goal's tone, with the
 * running ring on its corner while the goal really runs.
 *
 * The host paints a plugin pill's icon with a fixed muted colour (`color` is
 * `foregroundMuted` there) and its label as plain text, so a custom icon
 * component is the only channel through which the state can reach the trigger.
 * The component subscribes to the same store the popover reads, so a tone change
 * repaints the glyph without re-registering the button (a `registration.update`
 * per poll would republish the composer for nothing).
 */
export function makeGoalIcon(store: GoalStore, agentId: string) {
  function GoalPillIcon({ size, theme }: PluginButtonIconProps) {
    const [tone, setTone] = useState<GoalTone>(() => goalToneOf(store.get(agentId)));
    const [goal, setGoal] = useState<GoalState | null>(() => store.get(agentId)?.goal ?? null);
    useEffect(() => {
      const current = store.get(agentId);
      if (current === undefined) return;
      const listener = () => {
        setTone(goalToneOf(store.get(agentId)));
        setGoal(store.get(agentId)?.goal ?? null);
      };
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
      };
    }, []);
    const agentStatus = useAgent(agentId, (agent) => agent.status);
    const running = useGoalRunningMark(
      goal?.phase ?? "complete",
      goal?.activation ?? "armed",
      agentStatus,
    );
    // T10b: the glyph always stays — the tone-coloured Target, or the green
    // check for an unseen completed goal — and a running goal adds the corner
    // ring (`./corner-ring`). The ring used to replace the glyph, so a goal pill
    // the host shrank to its icon was one more anonymous blue ring.
    return (
      <CornerRingIcon
        name={goalIconName(tone)}
        size={size}
        color={theme.colors[goalIconColorToken(tone)]}
        running={running}
        theme={theme}
      />
    );
  }
  GoalPillIcon.displayName = "GoalPillIcon";
  return GoalPillIcon;
}

/**
 * The popover container: the interaction state and the RPCs around the pure
 * body (`goal-popover.tsx`).
 *
 * It reads the shared store rather than issuing its own read, so opening the
 * popover does not double the request rate. After a successful control action it
 * asks the poller for one immediate read (`refresh`) instead of waiting up to
 * the four-second interval: the user just pressed a button and expects the pill
 * to change now.
 *
 * **Failure keeps the panel open.** DSH's own sentence is shown in place — a
 * paused goal at its round cap refuses `resume`, and closing the popover would
 * leave the user with no explanation. **Leaving the editor closes it** (UI-v8):
 * 取消 / Escape, and a successful save, call the host's `close()`; the clear
 * page's 取消 still returns to the main page (`goalPanelNext`). Closing unmounts
 * this body, which records "seen" only for a complete goal — and the editor
 * never shows one, so an edit never marks anything seen.
 *
 * Exported only so `harness/goal-popover-render-check.cjs` can mount the real
 * container with a fake RPC client. Clearing is an in-place confirmation page
 * (`mode: "confirm"`): the red row appears only after the user has asked.
 */
export function makeGoalPopover(
  client: PluginClientContext,
  store: GoalStore,
  agentId: string,
  refresh: () => Promise<void>,
  onClosed: (goal: GoalState | null) => void,
) {
  function GoalPopover({ theme, layout, close }: PluginButtonContentProps) {
    const [entry, setEntry] = useState<AgentGoal | undefined>(store.get(agentId));
    // The host unmounts a closed surface's content (`menu-surface.tsx` /
    // `menu-overlay.tsx`), so this body's unmount *is* "the panel was closed".
    // The last goal it showed is what was seen; a completed one is then hidden.
    const shown = useRef<GoalState | null>(entry?.goal ?? null);
    shown.current = entry?.goal ?? null;
    useEffect(() => () => onClosed(shown.current), []);
    const [busy, setBusy] = useState<GoalAction | null>(null);
    const [error, setError] = useState<string | undefined>(undefined);
    const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
    const [draft, setDraft] = useState("");

    useEffect(() => {
      const current = store.get(agentId);
      setEntry(current);
      if (current === undefined) return;
      const listener = () => {
        setEntry(store.get(agentId));
      };
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
      };
    }, []);

    const text = localeText().goal;
    const goal = entry?.goal ?? null;
    // Before the first poll lands (or after the pill was removed) the body must
    // render something rather than throw. A read that never succeeded is the
    // only case that shows the "could not read" line.
    if (goal === null) {
      const message =
        entry === undefined || entry.available
          ? text.noGoal
          : (entry.error ?? text.unavailable);
      return (
        <View style={{ padding: 8 }}>
          <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
            {message}
          </Text>
        </View>
      );
    }

    const busyNow = busy !== null;

    const run = async (action: GoalAction, objective?: string): Promise<void> => {
      if (busyNow) return;
      setBusy(action);
      setError(undefined);
      try {
        const result = await client.rpc(goalControl, {
          agentId,
          action,
          ...(objective === undefined ? {} : { objective }),
        });
        if (!result.ok) {
          // DSH's own refusal, verbatim. The popover stays open on purpose.
          setError(result.error ?? text.controlFailed);
          return;
        }
        if (goalPanelNext({ kind: "control", action, ok: true }) === "close") {
          // A saved edit closes the panel. The refresh is the poller's, not this
          // body's, so it is started and not awaited: the panel must not wait
          // on a read before it closes.
          void refresh();
          close();
          return;
        }
        setMode("view");
        setDraft("");
        // Immediate refresh: the user just pressed a button and the pill must
        // show the new phase now, not on the next scheduled poll.
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(null);
      }
    };

    // The pill's icon and the panel's whale share the running decision; the
    // popover reads the agent's live status the same way the icon does.
    const agentStatus = useAgent(agentId, (agent) => agent.status);
    const running = useGoalRunningMark(goal.phase, goal.activation, agentStatus);
    const resumable = goal.phase !== "active" || goal.activation === "disarmed";

    const onToggleRunning = (): void => {
      void run(resumable ? "resume" : "pause");
    };

    const onBeginEdit = (): void => {
      // The header shows one truncated line, so this is where the full objective
      // becomes visible and editable.
      setDraft(goal.objective);
      setMode("edit");
    };

    const onBeginClear = (): void => {
      setMode("confirm");
    };

    const onSave = (): void => {
      if (busyNow) return;
      if (!goalEditSubmittable(draft, goal.objective)) return;
      void run("edit", draft);
    };

    // 取消 and Escape (the body routes both here) close the panel.
    const onCancelEdit = (): void => {
      if (goalPanelNext({ kind: "cancelEdit" }) === "close") {
        close();
        return;
      }
      setMode("view");
      setDraft("");
    };

    const onConfirmClear = (): void => {
      void run("clear");
    };

    const onCancelClear = (): void => {
      if (goalPanelNext({ kind: "cancelClear" }) === "close") {
        close();
        return;
      }
      setMode("view");
    };

    return (
      <GoalPopoverBody
        goal={goal}
        text={text}
        theme={theme}
        compact={layout.compact}
        running={running}
        mode={mode}
        busy={busyNow}
        error={error}
        draft={draft}
        onToggleRunning={onToggleRunning}
        onBeginEdit={onBeginEdit}
        onBeginClear={onBeginClear}
        onSave={onSave}
        onCancelEdit={onCancelEdit}
        onConfirmClear={onConfirmClear}
        onCancelClear={onCancelClear}
        onChangeDraft={setDraft}
      />
    );
  }
  return GoalPopover;
}

/* -------------------------------------------------------------------------- */
/* The goal/jobs slot's one panel (T10b)                                      */
/* -------------------------------------------------------------------------- */

/** The slot as the plugin instantiates it: host icons, host popover bodies. */
export type GoalJobsPluginSlot = GoalJobsSlot<PluginButtonIcon, ComponentType<PluginButtonContentProps>>;

/** The host's hover/press callback state, as the jobs and goal panels read it. */
type SlotHoverState = PressableStateCallbackType & { hovered?: boolean };

/**
 * The switch row at the top of one view: it names the other half and opens it
 * in place. Drawn only when the other half is present.
 *
 * - In the goal view it is the jobs row: the jobs trigger's own mark (terminal
 *   glyph, ring on its corner while live) and label 「N 个后台」.
 * - In the jobs view it is the goal row: the whale, the objective on one line,
 *   and the goal's facts line (state · round · budget).
 *
 * It is a track row (`rowBox`) with the host's hover/press fill. On the view the
 * panel opened on, a trailing `ChevronRight` says "this opens"; on the other
 * view it is the way back, so it leads with the host sheet header's back
 * chevron (`ChevronLeft`, as the team panel's detail page) and is named 「返回，…」.
 */
function SlotSwitchRow({
  target,
  back,
  snapshot,
  theme,
  compact,
  onPress,
}: {
  target: SlotKind;
  back: boolean;
  snapshot: SlotSnapshot<PluginButtonIcon, ComponentType<PluginButtonContentProps>>;
  theme: PluginButtonContentProps["theme"];
  compact: boolean;
  onPress: () => void;
}) {
  const text = localeText();
  const goal = snapshot.goal?.state?.goal ?? null;
  const jobs = snapshot.jobs?.state;
  const name =
    target === "jobs"
      ? (jobs?.label ?? text.jobs.title)
      : goal === null
        ? text.goal.title
        : text.goal.rowLabel(goalStateName(goal, text.goal), goal.objective);
  return (
    <Pressable
      testID={`goal-jobs-switch-${target}`}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={back ? `${text.team.back}，${name}` : name}
      style={({ hovered = false, pressed }: SlotHoverState) => {
        const fill = rowActiveFill(hovered, pressed);
        return [rowBox({ compact }), fill === undefined ? undefined : { backgroundColor: theme.colors[fill] }];
      }}
    >
      {({ hovered = false, pressed }: SlotHoverState) => (
        <>
          {back ? (
            <View style={{ width: CHEVRON_BOX, height: CHEVRON_BOX, alignItems: "center", justifyContent: "center" }}>
              <Icon name="ChevronLeft" size={CHEVRON_BOX} color={theme.colors[chevronColorToken(hovered, pressed)]} />
            </View>
          ) : null}
          {target === "jobs" ? (
            <>
              <View style={{ width: GOAL_WHALE_SIZE, height: GOAL_WHALE_SIZE, alignItems: "center", justifyContent: "center" }}>
                {jobs?.live === true ? (
                  <JobsPillIcon size={14} color={theme.colors.foregroundMuted} theme={theme} />
                ) : (
                  <Icon name="SquareTerminal" size={14} color={theme.colors.foregroundMuted} />
                )}
              </View>
              <Text numberOfLines={1} style={{ ...rowTextColumn(), fontSize: TITLE_FONT_SIZE, color: theme.colors.foreground }}>
                {jobs?.label ?? text.jobs.title}
              </Text>
            </>
          ) : (
            <>
              <DeepSeekMark size={GOAL_WHALE_SIZE} />
              <View style={rowTextColumn()}>
                <Text
                  numberOfLines={1}
                  style={{ fontSize: TITLE_FONT_SIZE, lineHeight: GOAL_OBJECTIVE_LINE_HEIGHT, color: theme.colors.foreground }}
                >
                  {goal === null ? text.goal.title : goal.objective}
                </Text>
                {goal === null ? null : (
                  <Text
                    numberOfLines={1}
                    style={{ fontSize: FACTS_FONT_SIZE, lineHeight: GOAL_FACTS_LINE_HEIGHT, color: theme.colors.foregroundMuted }}
                  >
                    {goalFactsLine(goal, text.goal.statuses, text.goal.rounds)}
                  </Text>
                )}
              </View>
            </>
          )}
          {back ? null : (
            <View style={{ width: CHEVRON_BOX, height: CHEVRON_BOX, alignItems: "center", justifyContent: "center" }}>
              <Icon name="ChevronRight" size={CHEVRON_BOX} color={theme.colors[chevronColorToken(hovered, pressed)]} />
            </View>
          )}
        </>
      )}
    </Pressable>
  );
}

/**
 * The slot's one fixed panel (T10b): the goal panel or the jobs panel, with a
 * switch row to the other half when both are present.
 *
 * **One component, internal view.** The registration's `behavior` is this
 * component for the agent's whole life; a view switch is `setView`, never a
 * `registration.update({ behavior })`, which would make the host close the
 * surface (Paseo 0.15.0 `plugins/buttons/model.ts:126`). Pressing the switch
 * row calls neither `close()` nor the registration.
 *
 * - **Opening** takes the half the trigger shows (`snapshot.shown`).
 * - **A flip while open** (jobs finished, the goal blocked) only moves the
 *   trigger; the view stays where it is. If the open view's own half vanished
 *   it falls back to the other ({@link goalJobsSlotView}).
 * - **The two bodies are the existing ones**, unchanged (`makeGoalPopover`,
 *   `makeJobsPopover`), including the goal panel's edit/confirm pages and their
 *   `close()` calls. Each body cancels the host's 12pt content padding itself;
 *   below a switch row the body sits in a 12pt box so that cancel still lands
 *   on the surface edge.
 * - **"Seen".** Only the open view is mounted, so the goal body also unmounts
 *   on a switch; the completed-goal "seen" mark therefore waits for this
 *   panel's own unmount (the host closed it) and uses the goal the goal view
 *   last showed — none when the goal view never came on screen.
 */
export function makeGoalJobsPopover(slot: GoalJobsPluginSlot, agentId: string) {
  function GoalJobsPopover(props: PluginButtonContentProps) {
    const [snapshot, setSnapshot] = useState(() => slot.snapshot(agentId));
    const [opened] = useState<SlotKind>(() => {
      const first = slot.snapshot(agentId);
      return first?.shown ?? (first?.goal !== undefined ? "goal" : "jobs");
    });
    const [chosen, setChosen] = useState<SlotKind>(opened);
    useEffect(() => {
      setSnapshot(slot.snapshot(agentId));
      return slot.subscribe(agentId, () => setSnapshot(slot.snapshot(agentId)));
    }, []);

    const goalVisible = snapshot?.goal?.state?.visible === true;
    const jobsVisible = snapshot?.jobs?.state?.visible === true;
    const view = goalJobsSlotView(chosen, goalVisible, jobsVisible);
    useEffect(() => {
      if (view !== chosen) setChosen(view);
    }, [view, chosen]);

    // The goal the goal view last put on screen; `undefined` until it has.
    const goalShown = useRef<GoalState | null | undefined>(undefined);
    if (view === "goal" && snapshot?.goal !== undefined) goalShown.current = snapshot.goal.state?.goal ?? null;
    useEffect(() => () => slot.panelClosed(agentId, goalShown.current), []);

    const half = view === "goal" ? snapshot?.goal : snapshot?.jobs;
    const other: SlotKind = view === "goal" ? "jobs" : "goal";
    const otherVisible = other === "goal" ? goalVisible : jobsVisible;
    if (half === undefined || snapshot === undefined) {
      // Both halves detached while the panel was open: the host is about to
      // remove the button; render nothing rather than a stale body.
      return null;
    }
    const Body = half.Content;
    // One tree shape whether or not the switch row is drawn: the body keeps
    // its position (and so its state — the goal editor's draft) when the other
    // half appears or goes away while the panel is open. The root cancels the
    // host's 12pt content padding and the body's box restores it, so a body
    // without a switch row lands exactly where it would on its own.
    return (
      <View testID={`goal-jobs-view-${view}`} style={popoverRootBox()}>
        {otherVisible ? (
          <SlotSwitchRow
            target={other}
            back={view !== opened}
            snapshot={snapshot}
            theme={props.theme}
            compact={props.layout.compact}
            onPress={() => setChosen(other)}
          />
        ) : null}
        {otherVisible ? (
          <View
            style={{
              height: SECTION_SEPARATOR_HEIGHT,
              marginVertical: SECTION_SEPARATOR_MARGIN_VERTICAL,
              backgroundColor: props.theme.colors[SECTION_SEPARATOR_COLOR],
            }}
          />
        ) : null}
        <View style={{ padding: POPOVER_HOST_PADDING }}>
          <Body key={view} {...props} />
        </View>
      </View>
    );
  }
  GoalJobsPopover.displayName = "GoalJobsPopover";
  return GoalJobsPopover;
}

/** The plugin's goal/jobs slot, registered through the host's composer pills. */
export function createGoalJobsPluginSlot(client: PluginClientContext): GoalJobsPluginSlot {
  const slot: GoalJobsPluginSlot = createGoalJobsSlot<PluginButtonIcon, ComponentType<PluginButtonContentProps>>({
    addComposerPill: (contribution) => client.addComposerPill(contribution),
    makeContent: (agentId) => makeGoalJobsPopover(slot, agentId),
  });
  return slot;
}

/** The daemon's page limit for the agent directory; also the max its schema accepts. */
const AGENT_DIRECTORY_PAGE_SIZE = 200;

/**
 * Poll every agent of this provider and report its goal to the shared
 * goal/jobs slot (T10b).
 *
 * Returns the contribution's cleanup, which Paseo calls when the plugin, the
 * client entrypoint or the host connection goes away: every timer and the agent
 * observation are released there, and each agent's half is detached from the
 * slot. Polling itself is `createGoalPoller`; this function owns what the
 * controller cannot see — the React store the popover reads, the "seen"
 * machine, and the locale.
 */
export function contributeGoalPill(client: PluginClientContext, slot: GoalJobsPluginSlot) {
  const store: GoalStore = new Map();
  /** The agents this half is attached to the slot for. */
  const pills = new Set<string>();
  /**
   * agentId -> the completed goal's "seen" progress (UI-v7). Memory only: a
   * reload forgets it and a completed goal shows once more (accepted).
   */
  const seenStates = new Map<string, GoalSeenState>();
  /** agentId -> the last poll answer, to re-present it when only "seen" changed. */
  const answers = new Map<string, GoalViewState>();
  /** agentId -> the agent's last status from the directory (snapshot or upsert). */
  const agentStatuses = new Map<string, string | undefined>();
  /** agentId -> the trigger glyph component, created once per registration. */
  const goalIcons = new Map<string, PluginButtonIcon>();
  const lifetime = new AbortController();
  const rpc = (input: { agentId: string }) => client.rpc(goalCurrent, input);

  /**
   * Publish one poll answer: the popover store first (its listeners redraw from
   * it, including the trigger's glyph), then the slot. The
   * visibility/label rule is {@link goalPillPresentation}; this function only
   * turns its keys into copy.
   */
  const present = (agentId: string): void => {
    const next = answers.get(agentId);
    if (!pills.has(agentId) || next === undefined) return;
    const seen = seenStates.get(agentId)?.seen;
    publish(store, agentId, {
      goal: next.goal,
      available: next.available,
      ...(next.error === undefined ? {} : { error: next.error }),
      ...(seen === undefined ? {} : { seen }),
    });
    const presentation = goalPillPresentation(next, seen);
    const text = localeText().goal;
    // The label and the title are the noun in every state (UI-v7): the title is
    // also the phone sheet's header, which must read 「目标」. The state is the
    // glyph's, and the panel's first row speaks it. Never the objective — that
    // would print it twice on a phone.
    const { label, title } = goalPillCopy(presentation, text);
    slot.presentGoal(agentId, {
      visible: presentation.visible,
      attention: goalNeedsAttention(presentation),
      goal: next.goal,
      label,
      title,
      icon: goalIcons.get(agentId) ?? text.title,
    });
  };

  /** Feed one event to an agent's "seen" machine; re-present when it changed visibility. */
  const advanceSeen = (agentId: string, event: GoalCompleteEvent): void => {
    const before = seenStates.get(agentId) ?? {};
    const after = goalCompleteSeenStep(before, event);
    seenStates.set(agentId, after);
    if (after.seen !== before.seen) present(agentId);
  };

  const publishState = (agentId: string, next: GoalViewState): void => {
    if (!pills.has(agentId)) return;
    answers.set(agentId, next);
    seenStates.set(
      agentId,
      goalCompleteSeenStep(seenStates.get(agentId) ?? {}, {
        kind: "goal",
        goal: next.goal,
        agentStatus: agentStatuses.get(agentId),
      }),
    );
    present(agentId);
  };

  const poller: GoalPoller = createGoalPoller({
    readGoal: (agentId) => rpc({ agentId }),
    /**
     * The snapshot is only the directory's first page (the daemon defaults to
     * 200 entries); the controller walks `pageInfo.nextCursor` through this.
     */
    listAgentPage: async (cursor) => {
      const page = await client.paseo.agents.list({
        page: { limit: AGENT_DIRECTORY_PAGE_SIZE, cursor },
        signal: lifetime.signal,
      });
      return { entries: page.entries, pageInfo: page.pageInfo };
    },
    addAgent: (agent) => {
      // A custom component so the Target glyph can carry the goal's tone (the
      // host would paint a plain icon name muted for every state). One identity
      // per agent, so the slot never resends it on a poll.
      const icon = makeGoalIcon(store, agent.id);
      goalIcons.set(agent.id, icon);
      slot.attach("goal", agent, {
        Content: makeGoalPopover(
          client,
          store,
          agent.id,
          () => poller.pollNow(agent.id),
          // Not here: this body also unmounts when the user switches the slot
          // panel to the jobs view. "Seen" waits for the whole panel to close.
          () => {},
        ),
        icon,
        title: localeText().goal.title,
        onPanelClosed: (goal) => advanceSeen(agent.id, { kind: "closed", goal }),
      });
      pills.add(agent.id);
      store.delete(agent.id);
      answers.delete(agent.id);
    },
    removeAgent: (agentId, reason, error) => {
      if (!pills.has(agentId)) return;
      pills.delete(agentId);
      goalIcons.delete(agentId);
      slot.detach("goal", agentId);
      answers.delete(agentId);
      seenStates.delete(agentId);
      agentStatuses.delete(agentId);
      // Dropped rather than kept: the popover must not show a stale goal for an
      // agent this client may not read, or whose runtime cannot serve goals.
      store.delete(agentId);
      if (reason === "unauthorized") {
        console.error(
          "[dsh-paseo] goal pill: this connection is not allowed to call plugin RPCs " +
            "(plugin.rpc.invoke needs daemon.manage); the goal pill is disabled for this agent",
        );
      } else if (reason === "terminal") {
        // A terminal contract error cannot be fixed by polling. Say what to do
        // once in the log, then hide: a permanent error pill per agent is noise,
        // and the four-second retry it would carry never changes the answer.
        console.error(
          `[dsh-paseo] goal pill disabled for ${agentId}: ${error?.message ?? "a terminal goal error"}`,
        );
      }
    },
    publishState,
    onError: (message, error) => {
      if (lifetime.signal.aborted) return;
      // `console`, not `process.stderr`: this module runs inside the app's client
      // bundle, where there is no `process`.
      console.error(`[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
    setTimeout: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      // Node keeps the process alive for a pending timer; a plugin must not be
      // the reason it never exits.
      (timer as unknown as { unref?: () => void }).unref?.();
      return timer;
    },
    clearTimeout: (timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    },
    random: () => Math.random(),
  });

  // An owned list subscription delivers the existing agents, then every update,
  // and a fresh snapshot after a reconnect — which is what keeps the pills
  // correct across a daemon restart without a reload of this bundle.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: (page) => {
          for (const { agent } of page.entries) agentStatuses.set(agent.id, agent.status);
          void poller.applySnapshot(page);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            poller.upsert(update.agent);
            // The agent's status is the only "the user moved on" signal the
            // client has: a turn starting after the completing one ended.
            agentStatuses.set(update.agent.id, update.agent.status);
            advanceSeen(update.agent.id, { kind: "agent", status: update.agent.status });
            return;
          }
          poller.drop(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      // Without the agent list there is no pill at all; the console is the only
      // place that can say why, because a pill that was never registered has no
      // surface to report on.
      if (!lifetime.signal.aborted) {
        console.error(
          `[dsh-paseo] goal pill could not observe agents: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

  return () => {
    lifetime.abort();
    poller.dispose();
  };
}
