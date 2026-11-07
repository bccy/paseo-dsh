/**
 * The composer pill that shows the current DeepSeek Harness goal and lets the
 * user pause, resume, edit or clear it.
 *
 * **Why a second pill.** The jobs pill is a live counter and hides the moment
 * nothing is running; a goal is the opposite kind of surface — it stays relevant
 * while it exists, including when it is *not* running (paused, blocked, or
 * active but disarmed after a reopen). Folding it into the jobs pill would give
 * one button two meanings and change the jobs semantics the user already set,
 * so this is a separate registration (`id: "dsh-goal"`) beside it.
 *
 * **Why it polls.** DSH's goal lives in the `dsh` child process and Paseo 0.14
 * has no goal protocol at all (no field, no event, no capability bit — see
 * DESIGN §0), so there is nothing to subscribe to. A plugin RPC is the supported
 * channel for daemon-side reads; the cadence is the jobs pill's, shared through
 * `client/agent-polling.ts`.
 *
 * **What the trigger can and cannot show (UI-v6).** The *label* is the fixed
 * noun 「目标」/「Goal」 in every state. The state is shown by the **icon**, a
 * custom component — a `Target` glyph coloured by tone (`goalIconColorToken`:
 * muted while armed, warning when not continuing, danger when blocked), with
 * the running ring on its corner while the goal is really running (the glyph is
 * never replaced, so a pill the host shrank to its icon still reads as the
 * goal) — and spelled out in
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
 * **What "seen" survives.** A completed goal is shown once and hidden only after
 * its panel was opened and really closed (UI-v7). That memory is persisted in
 * host-scoped plugin settings (`../shared/goal-seen-settings` via
 * `./seen-persistence`, 2026-11-08), so an app restart or a plugin reload no
 * longer shows it once more; a host without settings degrades to memory-only.
 *
 * @module dsh-paseo/client/goal-pill
 */
import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { settingsRpc } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { goalControl, goalCurrent, type GoalAction, type GoalState } from "../shared/goal";
import { GOAL_SEEN_SETTINGS_ID } from "../shared/goal-seen-settings";
import { CornerRingIcon } from "./corner-ring";
import { GoalPopoverBody } from "./goal-popover";
import { useAgent, useGoalRunningMark } from "./goal-running";
import {
  createGoalPoller,
  goalCompleteSeenStep,
  goalEditSubmittable,
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
import { FACTS_FONT_SIZE } from "./jobs-popover-layout";
import { localeText } from "./locale";
import { createSeenCloseGate } from "./seen-close-gate";
import { createSeenPersistence } from "./seen-persistence";

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
    // The glyph always stays — the tone-coloured Target, or the green check
    // for an unseen completed goal — and a running goal adds the corner ring
    // (`./corner-ring`). The ring used to replace the glyph, so a goal pill the
    // host shrank to its icon was one more anonymous blue ring.
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
 * page's 取消 still returns to the main page (`goalPanelNext`). A close is
 * **confirmed** (`./seen-close-gate`): the body records "seen" only for a
 * complete goal once it has really been closed — and the editor never shows one,
 * so an edit never marks anything seen.
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
  /**
   * An unmount is not a close: the host remounts this body once when the panel
   * opens (its `FloatingSurface` is keyed `placed ? "placed" : "measuring"`,
   * `menu-overlay.tsx:350`), so only an unmount that outlives
   * `./seen-close-gate`'s confirmation window is the user closing the panel. The
   * last goal it showed is what was seen; a completed one is then hidden.
   */
  const gate = createSeenCloseGate<GoalState>({
    onClosed,
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  function GoalPopover({ theme, layout, close }: PluginButtonContentProps) {
    const [entry, setEntry] = useState<AgentGoal | undefined>(store.get(agentId));
    const shown = useRef<GoalState | null>(entry?.goal ?? null);
    shown.current = entry?.goal ?? null;
    // Mount/unmount rather than a dependency array: the gate decides whether the
    // unmount is a real close, and cancels it when the host remounts this body.
    useEffect(() => {
      gate.mounted();
      return () => {
        gate.unmounted(shown.current);
      };
    }, []);
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

/** The daemon's page limit for the agent directory; also the max its schema accepts. */
const AGENT_DIRECTORY_PAGE_SIZE = 200;

/**
 * Register one goal pill per agent of this provider and keep it current.
 *
 * Returns the contribution's cleanup, which Paseo calls when the plugin, the
 * client entrypoint or the host connection goes away: every timer, every pill
 * and the agent observation are released there. Polling itself is
 * `createGoalPoller`; this function owns the host objects the controller cannot
 * see — the React store the popover reads, the composer registration, and the
 * locale.
 */
export function contributeGoalPill(client: PluginClientContext) {
  const store: GoalStore = new Map();
  /** agentId -> the composer registration. */
  const pills = new Map<string, PluginButtonRegistration>();
  /**
   * agentId -> the completed goal's in-session "seen" progress (UI-v7). The
   * remembered key is also persisted on the host (`../shared/goal-seen-settings`),
   * so an app restart or a plugin reload no longer forgets it; this map only
   * carries the closes of this session, and the persistence is the fallback for
   * everything the host document remembers.
   */
  const seenStates = new Map<string, GoalSeenState>();
  /** agentId -> the last poll answer, to re-present it when only "seen" changed. */
  const answers = new Map<string, GoalViewState>();
  /** agentId -> what the host was last told; an unchanged poll publishes nothing. */
  const published = new Map<string, { visible: boolean; label: string; title: string }>();
  const lifetime = new AbortController();
  const rpc = (input: { agentId: string }) => client.rpc(goalCurrent, input);

  /**
   * UI-v7 persistence (2026-11-08): the "seen" keys the user closed a panel on
   * live in a host setting, so an app restart does not show a completed goal
   * once more. `present` refuses to publish before `hydrate` resolved (a
   * registration starts hidden), so an already-seen goal never flashes; a host
   * without the settings RPC degrades to the old in-memory behaviour. Only
   * `advanceSeen`'s confirmed-close branch writes (below) — polls never do.
   */
  const persistence = createSeenPersistence(
    {
      read: () => client.rpc(settingsRpc(GOAL_SEEN_SETTINGS_ID).read, {}),
      write: (input) => client.rpc(settingsRpc(GOAL_SEEN_SETTINGS_ID).write, input),
      // A document the host refused is repaired with `reset`, the one write the
      // host applies without re-parsing the stored envelope (`./seen-persistence`).
      reset: (input) => client.rpc(settingsRpc(GOAL_SEEN_SETTINGS_ID).reset, input),
      onError: (message, error) => {
        console.error(`[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}`);
      },
      warn: (message) => console.warn(`[dsh-paseo] ${message}`),
    },
    {
      settingsId: GOAL_SEEN_SETTINGS_ID,
      onHydrated: () => {
        for (const agentId of [...pills.keys()]) present(agentId);
      },
    },
  );
  void persistence.hydrate();

  /**
   * Publish one poll answer: the popover store first (its listeners redraw from
   * it, including the trigger's glyph), then the registration. The
   * visibility/label rule is {@link goalPillPresentation}; this function only
   * turns its keys into copy.
   */
  const present = (agentId: string): void => {
    const registration = pills.get(agentId);
    const next = answers.get(agentId);
    if (registration === undefined || next === undefined) return;
    // Nothing is published before the persisted "seen" state is known: the
    // registration starts hidden, so an already-seen completed goal never
    // flashes on the composer while the settings read is in flight.
    if (!persistence.ready()) return;
    const seen = seenStates.get(agentId)?.seen ?? persistence.get(agentId);
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
    // A poll answers every few seconds and almost always says the same thing; an
    // identical update would rebuild the host's button view and the popover's
    // page elements for nothing (the team pill's rule).
    const before = published.get(agentId);
    if (before !== undefined && before.visible === presentation.visible && before.label === label && before.title === title) {
      return;
    }
    published.set(agentId, { visible: presentation.visible, label, title });
    registration.update({ visible: presentation.visible, label, title });
  };

  /** Feed one event to an agent's "seen" machine; re-present when it changed visibility. */
  const advanceSeen = (agentId: string, event: GoalCompleteEvent): void => {
    // No pill, nothing to hide: a close the gate still owed a removed agent must
    // not leave a seen state behind for a later re-add.
    if (pills.get(agentId) === undefined) return;
    const before = seenStates.get(agentId) ?? {};
    const after = goalCompleteSeenStep(before, event);
    seenStates.set(agentId, after);
    if (after.seen !== before.seen) {
      // The only write path in this file: a **confirmed panel close** (the
      // gate's `closed` event, the only event the machine advances on) changed
      // the remembered completed-goal key. Polls and agent status events are
      // no-ops above and never reach here.
      if (event.kind === "closed" && after.seen !== undefined) persistence.remember(agentId, after.seen);
      present(agentId);
    }
  };

  const publishState = (agentId: string, next: GoalViewState): void => {
    if (pills.get(agentId) === undefined) return;
    answers.set(agentId, next);
    // A poll never marks a completed goal seen: seen is only the confirmed
    // panel close (the popover's `onClosed` below). It also never clears the
    // remembered key — a new goal/revision simply has a new one.
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
      const text = localeText().goal;
      const registration = client.addComposerPill({
        id: "dsh-goal",
        workspaceId: agent.workspaceId ?? "",
        agentId: agent.id,
        button: {
          // A custom component so the Target glyph can carry the goal's tone
          // (the host would paint a plain icon name muted for every state).
          icon: makeGoalIcon(store, agent.id),
          title: text.title,
          // Hidden until the first poll proves otherwise: a pill that appears and
          // then disappears is worse.
          visible: false,
          behavior: {
            kind: "popover",
            Content: makeGoalPopover(
              client,
              store,
              agent.id,
              () => poller.pollNow(agent.id),
              (goal) => {
                // Only this pill's close counts: the gate's confirmation can land
                // after the agent's pill was replaced or removed, and a stale
                // "seen" must never hide a goal the user has not been shown.
                if (pills.get(agent.id) !== registration) return;
                advanceSeen(agent.id, { kind: "closed", goal });
              },
            ),
          },
        },
      });
      pills.set(agent.id, registration);
      // The registration starts hidden with the noun as its effective label.
      published.set(agent.id, { visible: false, label: text.title, title: text.title });
      store.delete(agent.id);
      answers.delete(agent.id);
      // A re-added agent starts clean: a previous pill's "seen" must not hide a
      // goal the user has not been shown since.
      seenStates.delete(agent.id);
    },
    removeAgent: (agentId, reason, error) => {
      const entry = pills.get(agentId);
      if (entry === undefined) return;
      pills.delete(agentId);
      entry.remove();
      answers.delete(agentId);
      published.delete(agentId);
      seenStates.delete(agentId);
      // Session-only: the persisted fallback must not hide a goal for an agent
      // this pill was removed from and later re-added (`addAgent` clears the
      // in-session state for the same reason).
      persistence.forget(agentId);
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
          void poller.applySnapshot(page);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            poller.upsert(update.agent);
            // The agent's status is **not** a "seen" signal: a turn starting
            // after the completing one ended is usually just the user sending
            // the next message, and a completed pill must stay until its panel
            // is opened and closed. The event is an explicit no-op.
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
    persistence.dispose();
  };
}
