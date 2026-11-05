/**
 * The composer's team pill (T3): one pill per DSH agent whose session has an
 * Agent Team, opening the read-only roster + shared-task panel.
 *
 * - **Visibility**: `teamPillVisible` — more than the Lead, or any task.
 * - **Label and title**: the noun 「团队」/「Team」 in every state; no count
 *   (T2 P1). The host uses `title` as the accessibility name, desktop tooltip
 *   and phone sheet header, so all three read the noun.
 * - **Icon**: `Users`, with the host running ring on its corner while a
 *   teammate runs (only when the server *said* it runs; T10b — the glyph is
 *   never replaced, so a pill the host shrank to its icon still reads as the
 *   team), red on a failure, muted otherwise. Sent
 *   through `update` only when it changes, like the jobs pill, so the ring does
 *   not restart on every poll.
 *
 * Polling is the shared controller (`./agent-polling` via `./team-polling`),
 * at the jobs/goal cadence; the jobs and goal pills are untouched.
 *
 * @module dsh-paseo/client/team-pill
 */
import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { teamRead, type TeamView } from "../shared/team";
import { localeText } from "./locale";
import { CornerRingIcon } from "./corner-ring";
import { createTeamPoller, teamPillIcon, teamPillVisible, type TeamPillIcon } from "./team-polling";
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
 * `Users` glyph is drawn in every state; a running teammate adds the corner
 * ring (`./corner-ring`) instead of replacing it.
 */
function RunningIcon({ size, theme }: PluginButtonIconProps) {
  return <CornerRingIcon name="Users" size={size} color={theme.colors.foregroundMuted} running theme={theme} />;
}
function FailedIcon({ size, theme }: PluginButtonIconProps) {
  return <CornerRingIcon name="Users" size={size} color={theme.colors.statusDanger} running={false} theme={theme} />;
}
function IdleIcon({ size, theme }: PluginButtonIconProps) {
  return <CornerRingIcon name="Users" size={size} color={theme.colors.foregroundMuted} running={false} theme={theme} />;
}
const ICONS: Record<TeamPillIcon, typeof IdleIcon> = { running: RunningIcon, failed: FailedIcon, idle: IdleIcon };

/** The popover body: reads the shared store, issues no RPC of its own. */
export function makeTeamPopover(store: TeamStore, agentId: string) {
  function TeamPopover({ theme, layout }: PluginButtonContentProps) {
    const [team, setTeam] = useState<TeamView | null>(store.get(agentId)?.team ?? null);
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

/** One agent's registration and the icon state its last update left. */
interface PillEntry {
  readonly registration: PluginButtonRegistration;
  icon: TeamPillIcon;
}

/** Register one team pill per agent of this provider and keep it current. Returns the cleanup. */
export function contributeTeamPill(client: PluginClientContext) {
  const store: TeamStore = new Map();
  const pills = new Map<string, PillEntry>();
  const lifetime = new AbortController();

  const poller = createTeamPoller({
    readTeam: (agentId) => client.rpc(teamRead, { agentId }),
    listAgentPage: async (cursor) => {
      const page = await client.paseo.agents.list({ page: { limit: AGENT_DIRECTORY_PAGE_SIZE, cursor }, signal: lifetime.signal });
      return { entries: page.entries, pageInfo: page.pageInfo };
    },
    addAgent: (agent) => {
      const registration = client.addComposerPill({
        id: "dsh-team",
        workspaceId: agent.workspaceId ?? "",
        agentId: agent.id,
        button: {
          icon: IdleIcon,
          title: localeText().team.title,
          label: localeText().team.title,
          // Hidden until the first poll proves there is a team.
          visible: false,
          behavior: { kind: "popover", Content: makeTeamPopover(store, agent.id) },
        },
      });
      pills.set(agent.id, { registration, icon: "idle" });
      store.delete(agent.id);
    },
    removeAgent: (agentId, reason, error) => {
      const entry = pills.get(agentId);
      if (entry === undefined) return;
      pills.delete(agentId);
      entry.registration.remove();
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
    publishState: (agentId, team) => {
      const entry = pills.get(agentId);
      if (entry === undefined) return;
      publish(store, agentId, team);
      const text = localeText().team;
      const visible = teamPillVisible(team);
      const icon = team === null ? "idle" : teamPillIcon(team);
      const iconPatch = icon === entry.icon ? {} : { icon: ICONS[icon] };
      entry.icon = icon;
      entry.registration.update({ visible, label: text.title, title: text.title, ...iconPatch });
    },
    onError: (message, error) => {
      if (lifetime.signal.aborted) return;
      console.error(`[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
    setTimeout: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      return timer;
    },
    clearTimeout: (timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    },
    random: () => Math.random(),
  });

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
      if (!lifetime.signal.aborted) {
        console.error(`[dsh-paseo] team pill could not observe agents: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  return () => {
    lifetime.abort();
    poller.dispose();
  };
}
