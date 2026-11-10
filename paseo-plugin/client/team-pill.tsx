/**
 * The composer's team pill (T3): one pill per DSH agent whose session has an
 * Agent Team, opening the read-only roster + shared-task panel.
 *
 * - **Visibility**: `teamPillVisible` — any task only; teammates without a
 *   shared task do not show it. An all-done board is shown once more and then
 *   hidden only after the user has opened and really closed its panel (UI-v7,
 *   the user's 2026-11-06 decision): sending a new message without opening the
 *   panel does not hide it. A close is a *confirmed* one — the host remounts the
 *   popover body when it opens, so a bare unmount means nothing
 *   (`createSeenCloseGate` in `./seen-close-gate`). The remembered signature is
 *   **stored on the agent** — the `dsh.teamSeen` key of Paseo's durable agent
 *   metadata (`../shared/pill-metadata` via `./seen-metadata`, 2026-11-11), so an
 *   app restart, a plugin reload or a daemon restart no longer shows the board
 *   once more, and the value arrives with the agent before the pill is first
 *   presented.
 * - **Label and title**: the noun 「团队」/「Team」 in every state; no count
 *   (T2 P1). The host uses `title` as the accessibility name, desktop tooltip
 *   and phone sheet header, so all three read the noun.
 * - **Icon**: the `Users` glyph, with the host running ring on its corner while
 *   a teammate runs (only when the server *said* it runs; T10b), red on a
 *   failure, muted otherwise; when **every task is completed** it becomes the
 *   green `CircleCheck` (UI-v8, the goal pill's complete mark). Sent through
 *   `update` only when it changes, like the jobs pill, so the ring does not
 *   restart on every poll.
 *
 * **The transport moved in the 0.16 port (2026-11-11).** The board used to be
 * polled every four seconds through the `team.read` RPC; `server/pill-feed` now
 * reads it once per agent and pushes a snapshot only when it changes, so this
 * pill holds no timer — `./team-polling` keeps the answer → payload mapping and
 * the pure presentation rules.
 *
 * @module dsh-paseo/client/team-pill
 */
import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { teamSnapshot, isTerminalTeamErrorCode, type TeamAnswer, type TeamView } from "../shared/team";
import { TEAM_SEEN_METADATA_KEY } from "../shared/pill-metadata";
import { createAgentSubscriptions } from "./agent-subscriptions";
import { localeText } from "./locale";
import { CornerRingIcon } from "./corner-ring";
import { createSeenCloseGate } from "./seen-close-gate";
import { createSeenMetadataStore } from "./seen-metadata";
import {
  projectTeamAnswer,
  teamCompleteSeenStep,
  teamPillIcon,
  teamPillVisible,
  type TeamPillIcon,
  type TeamSeenEvent,
  type TeamSeenState,
} from "./team-polling";
import { TeamPanel, TeamPanelNote } from "./team-popover";

/** One agent's latest board, plus the popover bodies listening for the next one. */
interface AgentTeam {
  team: TeamView | null;
  readonly listeners: Set<() => void>;
}
type TeamStore = Map<string, AgentTeam>;

function publish(store: TeamStore, agentId: string, team: TeamView | null): void {
  const entry: AgentTeam = { team, listeners: store.get(agentId)?.listeners ?? new Set() };
  store.set(agentId, entry);
  for (const listener of [...entry.listeners]) {
    try {
      listener();
    } catch {
      /* one popover that threw while re-rendering must not stop the others */
    }
  }
}

/**
 * The icon components, one per state, so `update` swaps a stable identity. The
 * team reads through the `Users` glyph; a running teammate adds the corner ring
 * (`./corner-ring`) instead of replacing it. The exception is an all-done board:
 * it wears the green `CircleCheck` the goal pill uses for a complete goal.
 */
function RunningIcon({ size, theme }: PluginButtonIconProps) {
  return <CornerRingIcon name="Users" size={size} color={theme.colors.foregroundMuted} running theme={theme} />;
}
function FailedIcon({ size, theme }: PluginButtonIconProps) {
  return <CornerRingIcon name="Users" size={size} color={theme.colors.statusDanger} running={false} theme={theme} />;
}
function CompleteIcon({ size, theme }: PluginButtonIconProps) {
  return <CornerRingIcon name="CircleCheck" size={size} color={theme.colors.statusSuccess} running={false} theme={theme} />;
}
function IdleIcon({ size, theme }: PluginButtonIconProps) {
  return <CornerRingIcon name="Users" size={size} color={theme.colors.foregroundMuted} running={false} theme={theme} />;
}
const ICONS: Record<TeamPillIcon, typeof IdleIcon> = {
  running: RunningIcon,
  failed: FailedIcon,
  complete: CompleteIcon,
  idle: IdleIcon,
};

/**
 * The popover body: reads the shared store, issues no RPC of its own.
 *
 * `onClosed` is the "seen" signal (UI-v7), but **an unmount is not a close**: the
 * host renders this body inside `AnchoredSurface`, whose `FloatingSurface` is
 * keyed `placed ? "placed" : "measuring"` (Paseo 0.15.0,
 * `packages/app/src/components/ui/menu/menu-overlay.tsx:350`), so the body is
 * unmounted and mounted again one frame after the panel opens, while the user
 * has only just opened it. `createSeenCloseGate` therefore confirms a close only
 * when the unmount survives a short window; a remount cancels it. The last board
 * it showed is what was seen, and an all-done board is then hidden.
 */
export function makeTeamPopover(store: TeamStore, agentId: string, onClosed: (team: TeamView | null) => void) {
  const gate = createSeenCloseGate({
    onClosed,
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  function TeamPopover({ theme, layout }: PluginButtonContentProps) {
    const [team, setTeam] = useState<TeamView | null>(store.get(agentId)?.team ?? null);
    const shown = useRef<TeamView | null>(team);
    shown.current = team;
    // Mount/unmount rather than a dependency array: the gate decides whether the
    // unmount is a real close, and cancels the pending one when the host
    // remounts this body (its open-time remount, a panel swap, StrictMode).
    useEffect(() => {
      gate.mounted();
      return () => {
        gate.unmounted(shown.current);
      };
    }, []);
    useEffect(() => {
      const current = store.get(agentId);
      setTeam(current?.team ?? null);
      if (current === undefined) return;
      const listener = () => setTeam(store.get(agentId)?.team ?? null);
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
      };
    }, []);
    const text = localeText().team;
    if (team === null) return <TeamPanelNote theme={theme} compact={layout.compact} message={text.noTeam} />;
    return <TeamPanel team={team} text={text} theme={theme} compact={layout.compact} />;
  }
  return TeamPopover;
}

/** The daemon's page limit for the agent directory. */
const AGENT_DIRECTORY_PAGE_SIZE = 200;

/** One agent's registration and the state its last `update` published. */
interface PillEntry {
  readonly registration: PluginButtonRegistration;
  icon: TeamPillIcon;
  /** What the host was last told; `present` publishes only a real change. */
  visible: boolean;
  label: string;
  title: string;
}

/** Register one team pill per agent of this provider and keep it current. Returns the cleanup. */
export function contributeTeamPill(client: PluginClientContext) {
  const store: TeamStore = new Map();
  const pills = new Map<string, PillEntry>();
  /**
   * agentId -> the all-done board's in-session "seen" progress (UI-v7). The
   * remembered key is also persisted as agent metadata (`shared/pill-metadata.ts`
   * → `dsh.teamSeen`, written through `client/seen-metadata.ts`), so an app
   * restart or a plugin reload no longer forgets it; this map only carries the
   * closes of this session, and `seen` is the fallback for everything the agent's
   * metadata remembers.
   */
  const seenStates = new Map<string, TeamSeenState>();
  const lifetime = new AbortController();

  /**
   * UI-v7 "seen" (2026-11-11): the all-done board the user closed a panel on is
   * remembered in the agent's own metadata (`../shared/pill-metadata`), so an app
   * restart, a plugin reload or a daemon restart does not show it once more. The
   * value arrives with the agent in the directory snapshot — the pill is
   * registered *after* `seen.observe(agent)` in `addAgent`, so nothing flashes
   * before it is known — and a second window's close reaches this one as an agent
   * update.
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
        client.paseo.agents.ref(agentId).setMetadata({ [TEAM_SEEN_METADATA_KEY]: signature }),
      onError: (message, error) => {
        console.error(`[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}`);
      },
    },
    TEAM_SEEN_METADATA_KEY,
  );

  /**
   * Publish the current visibility, label and icon for one agent from the last
   * board in the store. Called on every poll answer, and again when only "seen"
   * changed so an all-done board can disappear without waiting for a poll.
   *
   * **Only a real change reaches the host.** A poll answers every few seconds and
   * almost always says the same thing; an identical `update` would rebuild the
   * host's button view and the popover's page elements for nothing — and a host
   * that remounts the surface on such an update would look like a user close to
   * `createSeenCloseGate`. `visible`/`label`/`title`/`icon` are compared here.
   */
  const present = (agentId: string): void => {
    const entry = pills.get(agentId);
    if (entry === undefined) return;
    const team = store.get(agentId)?.team ?? null;
    const remembered = seenStates.get(agentId)?.seen ?? seen.get(agentId);
    const text = localeText().team;
    const visible = teamPillVisible(team, remembered);
    const icon = team === null ? "idle" : teamPillIcon(team);
    if (entry.visible === visible && entry.icon === icon && entry.label === text.title && entry.title === text.title) {
      return;
    }
    entry.visible = visible;
    entry.icon = icon;
    entry.label = text.title;
    entry.title = text.title;
    entry.registration.update({ visible, label: text.title, title: text.title, icon: ICONS[icon] });
  };

  /** Feed one event to an agent's "seen" machine; re-present when it changed. */
  const advanceSeen = (agentId: string, event: TeamSeenEvent): void => {
    // No pill, nothing to hide: a close the gate still owed a removed agent must
    // not leave a seen state behind for a later re-add.
    if (pills.get(agentId) === undefined) return;
    const before = seenStates.get(agentId) ?? {};
    const after = teamCompleteSeenStep(before, event);
    seenStates.set(agentId, after);
    if (after.seen !== before.seen) {
      // The only write path in this file: a **confirmed panel close** (the
      // gate's `closed` event, the only event the machine advances on) changed
      // the remembered all-done signature. Polls and agent status events are
      // no-ops above and never reach here.
      if (event.kind === "closed" && after.seen !== undefined) seen.remember(agentId, after.seen);
      present(agentId);
    }
  };

  const subscriptions = createAgentSubscriptions<TeamView | null, TeamAnswer>({
    /**
     * Watch this agent's team-board snapshots.
     *
     * `client.subscribe` re-subscribes by itself after a reconnect and releases
     * what is left when the plugin stops; aborting `signal` releases this one, so
     * the controller deliberately keeps no handle. A refused subscription rejects
     * `ready` instead (a permission refusal removes the pill); the guard keeps
     * the release path from reporting a close that this side caused.
     */
    open: (agentId, onAnswer, onEnd, signal) => {
      const handle = client.subscribe(teamSnapshot, { agentId }, onAnswer, {
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
    listAgentPage: async (cursor) => {
      const page = await client.paseo.agents.list({ page: { limit: AGENT_DIRECTORY_PAGE_SIZE, cursor }, signal: lifetime.signal });
      return { entries: page.entries, pageInfo: page.pageInfo };
    },
    addAgent: (agent) => {
      const text = localeText().team;
      // The durable "seen" value arrives with the agent; taking it before the
      // pill exists is what removes the old hydrate gate — `present` below always
      // has an answer, so an all-done board the user already closed never flashes.
      seen.observe(agent);
      const registration = client.addComposerPill({
        id: "dsh-team",
        workspaceId: agent.workspaceId ?? "",
        agentId: agent.id,
        button: {
          icon: IdleIcon,
          title: text.title,
          label: text.title,
          // Hidden until the first poll proves there is a task.
          visible: false,
          behavior: {
            kind: "popover",
            Content: makeTeamPopover(store, agent.id, (team) => {
              // A close is only this pill's: the gate's confirmation can land
              // after the agent's pill was replaced or removed, and a stale
              // "seen" must never hide a board the user has not been shown.
              if (pills.get(agent.id)?.registration !== registration) return;
              advanceSeen(agent.id, { kind: "closed", team });
            }),
          },
        },
      });
      pills.set(agent.id, { registration, icon: "idle", visible: false, label: text.title, title: text.title });
      // A re-added agent starts with no **in-session** seen state: the close
      // that hid the previous pill belonged to that registration. The persisted
      // key keeps applying (2026-11-09) — within this agent's journal it names
      // the all-done board the user really closed, so it cannot hide a board the
      // user has not been shown.
      seenStates.delete(agent.id);
      store.delete(agent.id);
    },
    updateAgent: (agent) => {
      // The "seen" key of this agent changed — this session's own close echoed
      // back, or another window's close. Either way the pill must re-decide its
      // visibility now instead of waiting for the next board answer.
      if (seen.observe(agent)) present(agent.id);
      // The agent's status is **not** a "seen" signal: a turn starting after the
      // completing one ended is usually just the user sending the next message,
      // and an all-done pill must stay until its panel is opened and closed.
    },
    removeAgent: (agentId, reason, error) => {
      const entry = pills.get(agentId);
      if (entry === undefined) return;
      pills.delete(agentId);
      entry.registration.remove();
      seenStates.delete(agentId);
      // The **in-session** memory goes; the persisted one stays (2026-11-09, the
      // same rule as the goal pill). Within this agent's journal the key (the
      // all-done board's `id:revision` set) names the board the user closed, and
      // only that board is hidden; erasing the key on every removal only made a
      // reconnect / permission retry / terminal recovery show a board already
      // read. A new task or a new revision is a new signature and shows anyway.
      // (The task ids are a per-journal counter, so a rewound or re-created
      // board could in principle mint the same set again — the old mask never
      // covered that either: it only covered removals.)
      store.delete(agentId);
      if (reason === "unauthorized") {
        console.error(
          "[dsh-paseo] team pill: this connection is not allowed to call plugin RPCs " +
            "(plugin.rpc.invoke needs daemon.manage); the team pill is disabled for this agent",
        );
      } else if (reason === "terminal") {
        console.error(`[dsh-paseo] team pill disabled for ${agentId}: ${error?.message ?? "a terminal team error"}`);
      }
    },
    // The controller carries the payload as `data`; this pill's store keeps the
    // board itself. A failed answer never reaches the store (transient ones are
    // swallowed by `publishOnTransientError: false`, terminal ones remove the pill).
    publishState: (agentId, state) => {
      if (!state.available) return;
      if (pills.get(agentId) === undefined) return;
      publish(store, agentId, state.data);
      // An answer never marks an all-done board seen: seen is only the confirmed
      // panel close (the popover's `onClosed` below).
      present(agentId);
    },
    project: (_agentId, answer) => projectTeamAnswer(answer),
    onError: (message, error) => {
      if (lifetime.signal.aborted) return;
      console.error(`[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
    isTerminalErrorCode: isTerminalTeamErrorCode,
    initialData: null,
    fallbackErrorMessage: "the DSH runtime could not read this agent's team",
    pillLabel: "team pill",
    // A transient failure keeps the last board: one bad answer must not make a
    // team vanish.
    publishOnTransientError: false,
  });

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
            // Also the channel the "seen" key arrives on: `updateAgent`
            // re-presents the pill when the metadata says something changed.
            subscriptions.upsert(update.agent);
            return;
          }
          subscriptions.drop(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) {
        console.error(`[dsh-paseo] team pill could not observe agents: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  return () => {
    lifetime.abort();
    subscriptions.dispose();
    seen.dispose();
  };
}
