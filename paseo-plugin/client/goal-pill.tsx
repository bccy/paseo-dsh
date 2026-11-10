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
 * **Why it rides a feed.** DSH's goal lives in the `dsh` child process and Paseo
 * has no goal protocol at all (no field, no event, no capability bit — see
 * DESIGN §0), so the host cannot push it. The server half therefore owns the
 * read cadence (`server/pill-feed.ts`, one reader per agent shared by every
 * subscriber) and this pill only consumes its `goal.snapshot` subscription
 * (`client/agent-subscriptions.ts` handles the directory diff and re-subscribe).
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
 * **What is never shown.** A goal the user cannot read is not "no goal": a
 * transient error keeps the last state, and a terminal error (a bridge without
 * `paseo/goal`, a profile with no goal service) removes the pill — the same
 * appearance as a profile that never had the feature, rather than an error the
 * user can never dismiss.
 *
 * **What "seen" survives.** A completed goal is shown once and hidden only after
 * its panel was opened and really closed (UI-v7). That memory lives on the agent
 * itself — the `dsh.goalSeen` key of Paseo's durable agent metadata
 * (`../shared/pill-metadata` via `./seen-metadata`, 2026-11-11) — so an app
 * restart, a plugin reload or a daemon restart no longer shows it once more, and
 * the value arrives with the agent before the pill is first presented.
 *
 * @module dsh-paseo/client/goal-pill
 */
import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  goalControl,
  goalSnapshot,
  isTerminalGoalErrorCode,
  type GoalAction,
  type GoalAnswer,
  type GoalState,
} from "../shared/goal";
import { GOAL_SEEN_METADATA_KEY } from "../shared/pill-metadata";
import { createAgentSubscriptions } from "./agent-subscriptions";
import { CornerRingIcon } from "./corner-ring";
import { GoalPopoverBody } from "./goal-popover";
import { useAgent, useGoalRunningMark } from "./goal-running";
import {
  goalCompleteSeenStep,
  goalEditSubmittable,
  goalIconColorToken,
  goalIconName,
  goalPillCopy,
  goalPanelNext,
  goalPillPresentation,
  projectGoalAnswer,
  type GoalCompleteEvent,
  type GoalSeenState,
  type GoalTone,
  type GoalViewState,
} from "./goal-polling";
import { FACTS_FONT_SIZE } from "./jobs-popover-layout";
import { localeText } from "./locale";
import { createSeenCloseGate } from "./seen-close-gate";
import { createSeenMetadataStore } from "./seen-metadata";

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
 * popover costs nothing: one subscription feeds the trigger, the icon and the
 * body. After a successful control action the server's goal feed re-reads
 * immediately (`index.server.ts`), so the new phase reaches this panel through
 * the same subscription instead of up to one interval later.
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
          close();
          return;
        }
        setMode("view");
        setDraft("");
        // No read here: `goal.control` asks the server's goal feed to re-read
        // immediately (`index.server.ts`), so the new phase arrives through this
        // panel's own subscription — the same answer the pill's trigger sees.
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
 * `createAgentSubscriptions`; this function owns the host objects the controller
 * cannot see — the React store the popover reads, the composer registration, the
 * subscription call itself, and the locale.
 */
export function contributeGoalPill(client: PluginClientContext) {
  const store: GoalStore = new Map();
  /** agentId -> the composer registration. */
  const pills = new Map<string, PluginButtonRegistration>();
  /**
   * agentId -> the completed goal's in-session "seen" progress (UI-v7). The
   * remembered key is also stored on the agent (`../shared/pill-metadata`), so an
   * app restart or a plugin reload no longer forgets it; this map only carries the
   * closes of this session, and `seen` is the fallback for everything the agent's
   * metadata remembers.
   */
  const seenStates = new Map<string, GoalSeenState>();
  /** agentId -> the last pushed answer, to re-present it when only "seen" changed. */
  const answers = new Map<string, GoalViewState>();
  /** agentId -> what the host was last told; an unchanged poll publishes nothing. */
  const published = new Map<string, { visible: boolean; label: string; title: string }>();
  const lifetime = new AbortController();

  /**
   * UI-v7 "seen" (2026-11-11): the completed goal the user closed a panel on is
   * remembered in the agent's own metadata (`../shared/pill-metadata`), so an app
   * restart, a plugin reload or a daemon restart does not show it once more. The
   * value arrives with the agent in the directory snapshot — the pill is
   * registered *after* `seen.observe(agent)`, so nothing can flash before it is
   * known — and a second window's close reaches this one as an agent update.
   *
   * The write goes through `paseo.agents.ref(agentId).setMetadata`, not the
   * composer: this pill's code runs in the contribution callback, outside React,
   * and an agent's composer exists only while its tab is open, whereas the
   * metadata record belongs to the agent and works for an idle one too. Only
   * `advanceSeen`'s confirmed-close branch writes (below) — answers never do.
   */
  const seen = createSeenMetadataStore(
    {
      write: (agentId, signature) =>
        client.paseo.agents.ref(agentId).setMetadata({ [GOAL_SEEN_METADATA_KEY]: signature }),
      onError: (message, error) => {
        console.error(`[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}`);
      },
    },
    GOAL_SEEN_METADATA_KEY,
  );

  /**
   * Publish one pushed answer: the popover store first (its listeners redraw from
   * it, including the trigger's glyph), then the registration. The
   * visibility/label rule is {@link goalPillPresentation}; this function only
   * turns its keys into copy.
   */
  const present = (agentId: string): void => {
    const registration = pills.get(agentId);
    const next = answers.get(agentId);
    if (registration === undefined || next === undefined) return;
    const remembered = seenStates.get(agentId)?.seen ?? seen.get(agentId);
    publish(store, agentId, {
      goal: next.goal,
      available: next.available,
      ...(next.error === undefined ? {} : { error: next.error }),
      ...(remembered === undefined ? {} : { seen: remembered }),
    });
    const presentation = goalPillPresentation(next, remembered);
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
      if (event.kind === "closed" && after.seen !== undefined) seen.remember(agentId, after.seen);
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

  const subscriptions = createAgentSubscriptions<GoalState | null, GoalAnswer>({
    /**
     * Watch this agent's goal snapshots.
     *
     * `client.subscribe` re-subscribes by itself after a reconnect and releases
     * what is left when the plugin stops; aborting `signal` releases this one, so
     * the controller deliberately keeps no handle. A refused subscription rejects
     * `ready` instead (a permission refusal removes the pill); the guard keeps
     * the release path from reporting a close that this side caused.
     */
    open: (agentId, onAnswer, onEnd, signal) => {
      const handle = client.subscribe(goalSnapshot, { agentId }, onAnswer, {
        signal,
        onClosed: (closed) => {
          if (signal.aborted) return;
          onEnd(closed.error);
        },
      });
      void handle.ready.catch((error: unknown) => {
        if (signal.aborted) return;
        onEnd(error instanceof Error ? error : new Error(String(error)));
      });
    },
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
      // The durable "seen" value arrives with the agent; taking it before the
      // pill exists is what removes the old hydrate gate — `present` below always
      // has an answer, so a completed goal the user already closed never flashes.
      seen.observe(agent);
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
      // A re-added agent starts with no **in-session** seen state: the close
      // that hid the previous pill belonged to that registration. The persisted
      // key keeps applying (2026-11-09) — it names the exact completed revision
      // the user really closed (`goal-<uuid>:revision`), so it cannot hide a goal
      // the user has not been shown.
      seenStates.delete(agent.id);
    },
    updateAgent: (agent) => {
      // The "seen" key of this agent changed — this session's own close echoed
      // back, or another window's close. Either way the pill must re-decide its
      // visibility now instead of waiting for the next goal answer.
      if (seen.observe(agent)) present(agent.id);
      // The agent's status is **not** a "seen" signal: a turn starting after the
      // completing one ended is usually just the user sending the next message,
      // and a completed pill must stay until its panel is opened and closed.
    },
    removeAgent: (agentId, reason, error) => {
      const entry = pills.get(agentId);
      if (entry === undefined) return;
      pills.delete(agentId);
      entry.remove();
      answers.delete(agentId);
      published.delete(agentId);
      seenStates.delete(agentId);
      // The **in-session** memory goes; the persisted one stays (2026-11-09).
      // A "seen" key is `id:revision` — DSH mints a fresh `goal-<uuid>` per
      // created goal (`dsh-goal/lib/index.js`), so a remembered key can only
      // hide the exact completed revision the user closed. Erasing it on every
      // removal therefore could not prevent showing an unseen goal; it only
      // made a reconnect / permission retry / terminal recovery show a goal the
      // user had already read (`docs/GOAL.md`, 2026-11-09 regression). A new
      // goal or a new mutation is a new key and shows anyway.
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
    // The controller carries the payload as `data`; this pill's store row names it
    // `goal`, so the two shapes are joined here (the old adapter's only job). The
    // controller already guarantees an available answer here — transient failures
    // are swallowed by `publishOnTransientError: false` and terminal ones remove
    // the pill — but the guard keeps a future core change from publishing "no
    // goal" for a failed answer.
    publishState: (agentId, state) => {
      if (!state.available) return;
      publishState(agentId, {
        goal: state.data,
        available: true,
        ...(state.error === undefined ? {} : { error: state.error }),
        ...(state.code === undefined ? {} : { code: state.code }),
      });
    },
    project: (_agentId, answer) => projectGoalAnswer(answer),
    onError: (message, error) => {
      if (lifetime.signal.aborted) return;
      // `console`, not `process.stderr`: this module runs inside the app's client
      // bundle, where there is no `process`.
      console.error(`[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
    isTerminalErrorCode: isTerminalGoalErrorCode,
    initialData: null,
    // The goal pill's own copy for the diagnostics the controller emits: the
    // fallback sentence a failed answer carries when the runtime sent none, and
    // the noun its console lines name.
    fallbackErrorMessage: "the DSH runtime could not read this agent's goal",
    pillLabel: "goal pill",
    // A transient failure keeps the last state: one flaky answer must not make an
    // active goal look gone (DESIGN §2).
    publishOnTransientError: false,
  });

  // An owned list subscription delivers the existing agents, then every update,
  // and a fresh snapshot after a reconnect — which is what keeps the pills
  // correct across a daemon restart without a reload of this bundle.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: (page) => {
          void subscriptions.applySnapshot(page);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            // Also the channel the "seen" key arrives on: `updateAgent` re-presents
            // the pill when the metadata says something changed.
            subscriptions.upsert(update.agent);
            return;
          }
          subscriptions.drop(update.agentId);
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
    subscriptions.dispose();
    seen.dispose();
  };
}
