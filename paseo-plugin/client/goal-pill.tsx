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
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, TextInput, View, type PressableStateCallbackType } from "react-native";
import { goalControl, goalCurrent, type GoalAction, type GoalState } from "../shared/goal";
import {
  clearConfirmStep,
  createGoalPoller,
  goalActionsFor,
  goalEditDraftValid,
  goalPillPresentation,
  goalToneColorToken,
  type GoalLabel,
  type GoalPoller,
  type GoalViewState,
} from "./goal-polling";
import {
  FACTS_FONT_SIZE,
  POPOVER_HOST_PADDING,
  ROW_BORDER_RADIUS,
  ROW_GAP,
  TITLE_FONT_SIZE,
  popoverRootBox,
} from "./jobs-popover-layout";
import { localeText, type GoalText } from "./locale";

/** One agent's latest answer, plus the listeners the popover subscribes with. */
interface AgentGoal {
  goal: GoalState | null;
  /** `false` when the runtime could not be read — never confused with "none". */
  available: boolean;
  error?: string;
  /** Popover bodies re-render from this set when a poll lands. */
  readonly listeners: Set<() => void>;
}

/** The live answer per agent, shared by the pill's label and its popover. */
type GoalStore = Map<string, AgentGoal>;

/** The popover's body type, so the theme slot is not spelled out at every call. */
type PopoverTheme = PluginButtonContentProps["theme"];

/** The host's hover/press callback state, as `jobs-pill.tsx` reads it. */
type HoverState = PressableStateCallbackType & { hovered?: boolean };

/** The label copy for one semantic label key. */
function goalLabelText(label: GoalLabel, text: GoalText): string {
  switch (label.kind) {
    case "rounds":
      return text.roundsLabel(label.started, label.max);
    case "notRunning":
      return text.notRunning;
    case "paused":
      return text.paused;
    case "blocked":
      return text.blocked;
  }
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

/** The popover body's spacing. The host draws the surface; these are our gaps. */
const BODY_GAP = ROW_GAP;
const BUTTON_PADDING_HORIZONTAL = 10;
const BUTTON_PADDING_VERTICAL = 6;
const FIELD_PADDING_HORIZONTAL = 8;
const FIELD_PADDING_VERTICAL = 6;
const BUSY_OPACITY = 0.5;

/**
 * One control button.
 *
 * A `Pressable` with the host's own row-active fill while hovered/pressed, and
 * a disabled state while another action is in flight. `aria-disabled` is set on
 * web the same way the jobs popover sets `aria-expanded`: React Native Web does
 * not map `accessibilityState.disabled` for a `Pressable` in every host version.
 */
function GoalButton({
  label,
  tone,
  primary,
  disabled,
  theme,
  onPress,
}: {
  label: string;
  tone: "normal" | "danger";
  primary: boolean;
  disabled: boolean;
  theme: PopoverTheme;
  onPress: () => void;
}) {
  const style = ({ hovered = false, pressed }: HoverState) => {
    const fill = primary
      ? theme.colors.accent
      : hovered || pressed
        ? theme.colors.surface2
        : theme.colors.surface1;
    return {
      backgroundColor: fill,
      borderRadius: ROW_BORDER_RADIUS,
      paddingHorizontal: BUTTON_PADDING_HORIZONTAL,
      paddingVertical: BUTTON_PADDING_VERTICAL,
      opacity: disabled ? BUSY_OPACITY : 1,
    } as const;
  };
  const color = primary
    ? theme.colors.accentForeground
    : tone === "danger"
      ? theme.colors.statusDanger
      : theme.colors.foreground;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      {...(Platform.OS === "web" ? { "aria-disabled": disabled } : null)}
      style={style}
    >
      <Text numberOfLines={1} style={{ fontSize: FACTS_FONT_SIZE, color }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The popover body: the objective, its state, and the control buttons.
 *
 * It reads the shared store rather than issuing its own RPC, so opening the
 * popover does not double the request rate. After a successful control action it
 * asks the poller for one immediate read (`refresh`) instead of waiting up to
 * the four-second interval: the user just pressed a button and expects the pill
 * to change now.
 *
 * **Failure keeps the panel open.** DSH's own sentence is shown in place — a
 * paused goal at its round cap refuses `resume`, and closing the popover would
 * leave the user with no explanation. `清除` is the only destructive action, so
 * it takes two clicks ({@link clearConfirmStep}); the arm resets on any other
 * action.
 *
 * **No inner ScrollView.** The host's popover surface is already scrollable at
 * its own `maxHeight`; a second one capped the body shorter and gave the panel
 * two scroll regions (the jobs popover's note). A long objective therefore wraps
 * inside the body and the surface scrolls.
 */
function makeGoalPopover(
  client: PluginClientContext,
  store: GoalStore,
  agentId: string,
  refresh: () => Promise<void>,
) {
  function GoalPopover({ theme }: PluginButtonContentProps) {
    const [entry, setEntry] = useState<AgentGoal | undefined>(store.get(agentId));
    const [busy, setBusy] = useState<GoalAction | null>(null);
    const [error, setError] = useState<string | undefined>(undefined);
    const [clearArmed, setClearArmed] = useState(false);
    const [editing, setEditing] = useState(false);
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
    const root = {
      ...popoverRootBox(),
      paddingHorizontal: POPOVER_HOST_PADDING,
      paddingVertical: 4,
      gap: BODY_GAP,
    } as const;

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
        <View style={root}>
          <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
            {message}
          </Text>
        </View>
      );
    }

    const presentation = goalPillPresentation({ available: true, goal });
    const tone = presentation.visible ? presentation.tone : "warning";
    const statusColor = theme.colors[goalToneColorToken(tone)];
    const actions = goalActionsFor(goal);
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
        setClearArmed(false);
        setEditing(false);
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

    const onAction = (action: GoalAction): void => {
      if (action === "clear") {
        if (clearConfirmStep(clearArmed) === "arm") {
          setClearArmed(true);
          return;
        }
        void run("clear");
        return;
      }
      setClearArmed(false);
      if (action === "edit") {
        setEditing((open) => !open);
        return;
      }
      void run(action);
    };

    const submitEdit = (): void => {
      if (!goalEditDraftValid(draft)) return;
      void run("edit", draft);
    };

    const actionLabel = (action: GoalAction): string => {
      switch (action) {
        case "pause":
          return text.actions.pause;
        case "resume":
          return text.actions.resume;
        case "edit":
          return text.actions.edit;
        case "clear":
          return clearArmed ? text.actions.confirmClear : text.actions.clear;
      }
    };

    const disarmed = goal.phase === "active" && goal.activation === "disarmed";

    return (
      <View style={root}>
        {/* The objective in full: the trigger only carries a cut title, and this
            is the one place the user can read (and copy) all of it. */}
        <Text
          selectable
          style={{ fontSize: TITLE_FONT_SIZE, color: theme.colors.foreground }}
        >
          {goal.objective}
        </Text>
        <Text style={{ fontSize: FACTS_FONT_SIZE, color: statusColor }}>
          {`${text.statuses[goal.phase] ?? goal.phase} · ${text.rounds(goal.roundsStarted, goal.maxGoalRounds)}`}
        </Text>
        {goal.blockedReason === undefined ? null : (
          <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.statusDanger }}>
            {text.blocker(goal.blockedReason.code, goal.blockedReason.message)}
          </Text>
        )}
        {disarmed ? (
          <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.statusWarning }}>
            {text.disarmedHint}
          </Text>
        ) : null}
        {editing ? (
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submitEdit}
            placeholder={text.editPlaceholder}
            placeholderTextColor={theme.colors.foregroundMuted}
            returnKeyType="done"
            autoFocus
            accessibilityLabel={text.editPlaceholder}
            style={{
              fontSize: FACTS_FONT_SIZE,
              color: theme.colors.foreground,
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: ROW_BORDER_RADIUS,
              paddingHorizontal: FIELD_PADDING_HORIZONTAL,
              paddingVertical: FIELD_PADDING_VERTICAL,
            }}
          />
        ) : null}
        {error === undefined ? null : (
          <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.statusDanger }}>
            {error}
          </Text>
        )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: BODY_GAP }}>
          {actions.map((action) => (
            <GoalButton
              key={action}
              label={actionLabel(action)}
              tone={action === "clear" ? "danger" : "normal"}
              primary={action === "pause" || action === "resume"}
              disabled={busyNow}
              theme={theme}
              onPress={() => {
                onAction(action);
              }}
            />
          ))}
        </View>
        {busyNow ? (
          <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
            {text.busy}
          </Text>
        ) : null}
        {/* The product answer to "can I still send a message?": yes, and it does
            not interrupt the goal — but stop does pause it. */}
        <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
          {text.footnote}
        </Text>
      </View>
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
   * it), then the registration. The visibility/label rule is
   * {@link goalPillPresentation}; this function only turns its keys into copy.
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
    const label = presentation.visible ? goalLabelText(presentation.label, text) : text.title;
    registration.update({
      visible: presentation.visible,
      label,
      // The title is the objective cut to one short line; the popover body holds
      // the full text. When hidden the neutral noun stands in, so the button the
      // host keeps for its popover header never carries a stale objective.
      title: presentation.visible ? presentation.title : text.title,
    });
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
          // The same Target glyph DSH's own goal rows use (`tool-call-data`), so
          // the pill and the timeline row read as the same subject.
          icon: "Target",
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
