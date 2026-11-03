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
 * custom component — the running ring while the goal is really running,
 * otherwise a `Target` glyph coloured by tone (`goalIconColorToken`: muted while
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
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { goalControl, goalCurrent, type GoalAction, type GoalState } from "../shared/goal";
import { GoalPopoverBody } from "./goal-popover";
import { useAgent, useGoalRunningMark } from "./goal-running";
import {
  createGoalPoller,
  goalEditSubmittable,
  goalIconColorToken,
  goalPillCopy,
  goalPillPresentation,
  type GoalPoller,
  type GoalTone,
  type GoalViewState,
} from "./goal-polling";
import { FACTS_FONT_SIZE, ringColorFor } from "./jobs-popover-layout";
import { StatusRingMark } from "./status-ring";
import { localeText } from "./locale";

/** One agent's latest answer, plus the listeners the pill and popover subscribe with. */
interface AgentGoal {
  goal: GoalState | null;
  /** `false` when the runtime could not be read — never confused with "none". */
  available: boolean;
  error?: string;
  /** The trigger's glyph and the popover re-render from this set when a poll lands. */
  readonly listeners: Set<() => void>;
}

/** The live answer per agent, shared by the pill, its glyph and its popover. */
export type GoalStore = Map<string, AgentGoal>;

/** The tone the trigger's glyph should draw with for one stored answer. */
function goalToneOf(entry: AgentGoal | undefined): GoalTone {
  const presentation = goalPillPresentation({
    available: entry?.available ?? true,
    goal: entry?.goal ?? null,
  });
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
 * The trigger's glyph: the Target mark coloured by the goal's tone.
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
    if (running) {
      // The ring **replaces** the glyph, the way the host's track marks do:
      // the pill's 14px icon slot is too small for a ring over a Target, and on
      // the rail a running mark is always the ring itself.
      return <StatusRingMark size={size} color={ringColorFor(theme.colors.surface0)} />;
    }
    return <Icon name="Target" size={size} color={theme.colors[goalIconColorToken(tone)]} />;
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
 * leave the user with no explanation. Clearing is an in-place confirmation page
 * (`mode: "confirm"`): the red row appears only after the user has asked.
 */
function makeGoalPopover(
  client: PluginClientContext,
  store: GoalStore,
  agentId: string,
  refresh: () => Promise<void>,
) {
  function GoalPopover({ theme, layout }: PluginButtonContentProps) {
    const [entry, setEntry] = useState<AgentGoal | undefined>(store.get(agentId));
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

    const onCancelEdit = (): void => {
      setMode("view");
      setDraft("");
    };

    const onConfirmClear = (): void => {
      void run("clear");
    };

    const onCancelClear = (): void => {
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
  const lifetime = new AbortController();
  const rpc = (input: { agentId: string }) => client.rpc(goalCurrent, input);

  /**
   * Publish one poll answer: the popover store first (its listeners redraw from
   * it, including the trigger's glyph), then the registration. The
   * visibility/label rule is {@link goalPillPresentation}; this function only
   * turns its keys into copy.
   */
  const publishState = (agentId: string, next: GoalViewState): void => {
    const registration = pills.get(agentId);
    if (registration === undefined) return;
    publish(store, agentId, {
      goal: next.goal,
      available: next.available,
      ...(next.error === undefined ? {} : { error: next.error }),
    });
    const presentation = goalPillPresentation(next);
    const text = localeText().goal;
    // The label is the noun in every state; the title is the state in full
    // words (the host's accessibility name, tooltip and phone sheet header).
    // Never the objective — that would print it twice on a phone.
    const { label, title } = goalPillCopy(presentation, text);
    registration.update({ visible: presentation.visible, label, title });
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
      const registration = client.addComposerPill({
        id: "dsh-goal",
        workspaceId: agent.workspaceId ?? "",
        agentId: agent.id,
        button: {
          // A custom component so the Target glyph can carry the goal's tone
          // (the host would paint a plain icon name muted for every state).
          icon: makeGoalIcon(store, agent.id),
          title: localeText().goal.title,
          // Hidden until the first poll proves otherwise: a pill that appears and
          // then disappears is worse.
          visible: false,
          behavior: {
            kind: "popover",
            Content: makeGoalPopover(client, store, agent.id, () => poller.pollNow(agent.id)),
          },
        },
      });
      pills.set(agent.id, registration);
      store.delete(agent.id);
    },
    removeAgent: (agentId, reason, error) => {
      const entry = pills.get(agentId);
      if (entry === undefined) return;
      pills.delete(agentId);
      entry.remove();
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
