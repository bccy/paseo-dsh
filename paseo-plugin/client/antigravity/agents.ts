import type {
  PluginButton,
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
  PluginText,
} from "@getpaseo/plugin/client";
import { useToast, type ToastApi, type ToastOptions } from "@getpaseo/plugin/client/ui";
import { createElement, useEffect, type ComponentType } from "react";
import {
  SYSTEM_ACCOUNT_ID,
  accountIdFromMetadata,
  getOrchestratorRpc,
  isAntigravityProvider,
  isOrchestratorModel,
  listAccountsRpc,
  setOrchestratorRpc,
  subagentCountsRpc,
  switchAgentAccountRpc,
  watchAccountsSubscription,
  type AccountsState,
  type AccountSummary,
  type ModelFamily,
  type OrchestratorState,
  type StepEntry,
} from "../../shared/antigravity/contracts";
import { STEPS_SEEN_METADATA_KEY, SUBAGENTS_ARCHIVED_METADATA_KEY } from "../../shared/pill-metadata";
import { CornerRingIcon } from "../corner-ring";
import { subscribeLocale } from "../locale";
import { createSeenMetadataStore } from "../seen-metadata";
import { makeAccountPopover } from "./accountPopover";
import { displayLabel } from "./labels";
import { errorMessage, translateAntigravity } from "./messages";
import { resolvePresets, shortModelLabel } from "./orchestrator";
import {
  extractStepsFromTimelineEntries,
  stepsAllDoneSignature,
  summarizeSteps,
  type StepsPillIconState,
  type StepsStore,
} from "./stepsModel";
import {
  createSubagentsArchiveStore,
  effectiveSubagentCount,
  type RawSubagentCount,
  type SubagentsArchiveStore,
} from "./subagentsArchive";

type AgentRow = {
  id: string;
  workspaceId?: string | null;
  archivedAt?: unknown;
  metadata?: Readonly<Record<string, unknown>> | null;
  provider: string;
  model?: string | null;
  title?: string | null;
  status: string;
};

export interface ObservedAgent {
  id: string;
  workspace: string | null;
  account: string;
  running: boolean;
  model: string | null;
  title: string | null;
}

export interface ObserveAgentsNavigation {
  readonly consoleScreenId: string;
  readonly onOpenAntigravityTab?: () => void;
}

type OpenSubagents = (agentId: string, workspaceId: string | null | undefined, subagentId?: string) => void;
type MakeSubagentPopover = (
  agentId: string,
  workspaceId: string | null | undefined,
) => ComponentType<PluginButtonContentProps>;
type MakeStepsPopover = (
  agentId: string,
  onClosed: (steps: readonly StepEntry[] | null) => void,
  onOpen?: () => void,
) => ComponentType<PluginButtonContentProps>;

export interface ObserveAgentsSteps {
  readonly store: StepsStore;
  readonly makePopover: MakeStepsPopover;
}

type SubagentPillIconState = "running" | "failed" | "idle";
type SubagentCount = RawSubagentCount;

interface AccountPillEntry {
  readonly registration: PluginButtonRegistration<PluginText>;
  icon: "UserRound" | "UserX";
  label: string;
  title: string;
}

interface SubagentPillEntry {
  readonly registration: PluginButtonRegistration<PluginText>;
  iconState: SubagentPillIconState;
  label: string;
  title: string;
}

interface StepsPillEntry {
  readonly registration: PluginButtonRegistration<PluginText>;
  iconState: StepsPillIconState;
  label: string;
  title: string;
}

/**
 * Stable module-level icon components, one per pill state, matching `team-pill.tsx`
 * so `pill.update()` swaps a stable component identity and never restarts the
 * corner ring animation unnecessarily.
 */
function SubagentRunningIcon({ size, theme }: PluginButtonIconProps) {
  return createElement(CornerRingIcon, {
    name: "Bot",
    size,
    color: theme.colors.foregroundMuted,
    running: true,
    theme,
  });
}

function SubagentFailedIcon({ size, theme }: PluginButtonIconProps) {
  return createElement(CornerRingIcon, {
    name: "Bot",
    size,
    color: theme.colors.statusDanger,
    running: false,
    theme,
  });
}

function SubagentIdleIcon({ size, theme }: PluginButtonIconProps) {
  return createElement(CornerRingIcon, {
    name: "Bot",
    size,
    color: theme.colors.foregroundMuted,
    running: false,
    theme,
  });
}

const SUBAGENT_PILL_ICONS: Record<SubagentPillIconState, ComponentType<PluginButtonIconProps>> = {
  running: SubagentRunningIcon,
  failed: SubagentFailedIcon,
  idle: SubagentIdleIcon,
};

function StepsRunningIcon({ size, theme }: PluginButtonIconProps) {
  return createElement(CornerRingIcon, {
    name: "ListChecks",
    size,
    color: theme.colors.foregroundMuted,
    running: true,
    theme,
  });
}

function StepsFailedIcon({ size, theme }: PluginButtonIconProps) {
  return createElement(CornerRingIcon, {
    name: "ListChecks",
    size,
    color: theme.colors.statusDanger,
    running: false,
    theme,
  });
}

function StepsCompleteIcon({ size, theme }: PluginButtonIconProps) {
  return createElement(CornerRingIcon, {
    name: "CircleCheck",
    size,
    color: theme.colors.statusSuccess,
    running: false,
    theme,
  });
}

function StepsIdleIcon({ size, theme }: PluginButtonIconProps) {
  return createElement(CornerRingIcon, {
    name: "ListChecks",
    size,
    color: theme.colors.foregroundMuted,
    running: false,
    theme,
  });
}

const STEPS_PILL_ICONS: Record<StepsPillIconState, ComponentType<PluginButtonIconProps>> = {
  running: StepsRunningIcon,
  failed: StepsFailedIcon,
  complete: StepsCompleteIcon,
  idle: StepsIdleIcon,
};

/** An empty icon that keeps menu labels aligned with the checked one. */
const BLANK_ICON = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M0 0h24v24H0z" fill="none"/></svg>',
};

type Counts = ReadonlyMap<string, number>;
type WorkspaceSubagents = ReadonlyMap<string, number>;
type Timer = ReturnType<typeof setTimeout>;

const SUBAGENT_POLL_MS = 5000;
const IDLE_POLL_MS = 30_000;
const POLL_BATCH_SIZE = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export function observeAgents(
  client: PluginClientContext,
  openSubagents: OpenSubagents,
  makeSubagentPopover?: MakeSubagentPopover,
  navigation?: ObserveAgentsNavigation,
  steps?: ObserveAgentsSteps,
  subagentsArchive?: SubagentsArchiveStore,
) {
  const lifetime = new AbortController();
  const agents = new Map<string, ObservedAgent>();
  const accountPills = new Map<string, AccountPillEntry>();
  const subagentPills = new Map<string, SubagentPillEntry>();
  const stepsPills = new Map<string, StepsPillEntry>();
  const orchestratorPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const subagentCounts = new Map<string, SubagentCount>();
  const lastPolledAt = new Map<string, number>();
  const archiveStore =
    subagentsArchive ??
    createSubagentsArchiveStore({
      write: (agentId, raw) =>
        client.paseo.agents.ref(agentId).setMetadata({ [SUBAGENTS_ARCHIVED_METADATA_KEY]: raw }),
      onError: (message, error) => {
        console.warn(`[dsh-paseo:antigravity] ${message}: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
  const stepsSeen = createSeenMetadataStore(
    {
      write: (agentId, signature) =>
        client.paseo.agents.ref(agentId).setMetadata({ [STEPS_SEEN_METADATA_KEY]: signature }),
      onError: (message, error) => {
        console.warn(`[dsh-paseo:antigravity] ${message}: ${error instanceof Error ? error.message : String(error)}`);
      },
    },
    STEPS_SEEN_METADATA_KEY,
  );
  let orchestrator: OrchestratorState | undefined;
  const listeners = new Set<() => void>();
  const presenters = new Map<symbol, ToastApi>();
  type PendingNotice = { message: string; options?: ToastOptions; isError?: boolean };
  let pendingNotice: PendingNotice | undefined;
  let counts: Counts | null = null;
  let memberSnapshot: readonly ObservedAgent[] = [];
  let workspaceSubagents: WorkspaceSubagents = new Map();
  let accounts: AccountsState | undefined;
  let accountSignature = "";

  const openAntigravityConsole = () => {
    navigation?.onOpenAntigravityTab?.();
    client.openScreen({
      screenId: navigation?.consoleScreenId ?? "dsh-console",
      params: { tab: "antigravity" },
    });
  };

  // Commands have no toast API of their own; mounted plugin surfaces lend theirs.
  function notify(
    message: string,
    opts?: { toast?: ToastApi; options?: ToastOptions; isError?: boolean },
  ) {
    if (lifetime.signal.aborted) return;
    const presenter = opts?.toast ?? presenters.values().next().value;
    if (presenter) {
      if (opts?.isError) presenter.error(message);
      else presenter.show(message, opts?.options);
    } else {
      pendingNotice = { message, options: opts?.options, isError: opts?.isError };
    }
  }

  function useNotifications() {
    const toast = useToast();
    useEffect(() => {
      const key = Symbol();
      presenters.set(key, toast);
      if (pendingNotice) {
        const queued = pendingNotice;
        pendingNotice = undefined;
        notify(queued.message, { toast, options: queued.options, isError: queued.isError });
      }
      return () => {
        presenters.delete(key);
      };
    }, [toast]);
  }

  const nameOf = (label: string, kind?: AccountSummary["kind"]) =>
    displayLabel(label, (key) => translateAntigravity(key), kind);

  function emit() {
    listeners.forEach((listener) => listener());
  }

  function publishWorkspaceSubagents() {
    const next = new Map<string, number>();
    for (const agent of agents.values()) {
      if (!agent.workspace) continue;
      const running = subagentCounts.get(agent.id)?.running ?? 0;
      if (running > 0) next.set(agent.workspace, (next.get(agent.workspace) ?? 0) + running);
    }
    if (
      workspaceSubagents.size === next.size &&
      [...next].every(([ws, n]) => workspaceSubagents.get(ws) === n)
    ) {
      return;
    }
    workspaceSubagents = next;
    emit();
  }

  async function switchTo(
    agentId: string,
    account: AccountSummary,
    when: "now" | "after-turn",
    toast?: ToastApi,
  ) {
    if (when === "now") {
      notify(translateAntigravity("switchingNow", { label: nameOf(account.label, account.kind) }), {
        toast,
        options: { variant: "info", durationMs: 6000 },
      });
    }
    try {
      const result = await client.rpc(switchAgentAccountRpc, { agentId, accountId: account.id, when });
      const variant = result.result === "unchanged" ? "info" : "success";
      notify(translateAntigravity(result.result, { label: nameOf(result.accountLabel, account.kind) }), {
        toast,
        options: { variant },
      });
    } catch (error) {
      notify(errorMessage(error), { toast, isError: true });
    }
  }

  // ---- Account pill -------------------------------------------------------------------------

  function renderAccountPill(agent: ObservedAgent) {
    if (!agent.workspace) return;
    const current = accounts?.accounts.find((account) => account.id === agent.account);
    const healthy = !current || (current.usable && current.status !== "signed-out");
    const icon: "UserRound" | "UserX" = healthy ? "UserRound" : "UserX";
    const title = healthy ? translateAntigravity("pill") : translateAntigravity("pillSignedOut");
    const label = current ? nameOf(current.label, current.kind) : agent.account;
    const entry = accountPills.get(agent.id);
    if (entry) {
      if (entry.icon === icon && entry.title === title && entry.label === label) {
        return;
      }
      entry.registration.update({ icon, title, label });
      entry.icon = icon;
      entry.title = title;
      entry.label = label;
      return;
    }
    const agentId = agent.id;
    const registration = client.addComposerPill({
      id: "account",
      agentId,
      workspaceId: agent.workspace,
      button: {
        icon,
        title,
        label,
        behavior: {
          kind: "popover",
          Content: makeAccountPopover({
            agentId,
            read: () => {
              const live = agents.get(agentId);
              return {
                accounts: accounts?.accounts ?? [],
                currentAccountId: live?.account ?? agent.account,
                running: live?.running ?? false,
              };
            },
            subscribe: (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
            onSwitch: (targetAccount, when, toast) => {
              void switchTo(agentId, targetAccount, when, toast);
            },
            onManage: openAntigravityConsole,
          }),
        },
      },
    });
    accountPills.set(agent.id, { registration, icon, title, label });
  }

  // ---- Subagent pill ------------------------------------------------------------------------

  function renderSubagentPill(agent: ObservedAgent) {
    const count = effectiveSubagentCount(subagentCounts.get(agent.id), archiveStore.get(agent.id));
    if (!agent.workspace || !count.total) {
      subagentPills.get(agent.id)?.registration.remove();
      subagentPills.delete(agent.id);
      return;
    }
    const iconState: SubagentPillIconState =
      count.running > 0 ? "running" : count.failed > 0 ? "failed" : "idle";
    const label = translateAntigravity("subagents.pill");
    const title = label;
    const entry = subagentPills.get(agent.id);
    if (entry) {
      if (entry.iconState === iconState && entry.label === label && entry.title === title) {
        return;
      }
      entry.registration.update({
        icon: SUBAGENT_PILL_ICONS[iconState],
        label,
        title,
      });
      entry.iconState = iconState;
      entry.label = label;
      entry.title = title;
      return;
    }
    const workspace = agent.workspace;
    const registration = client.addComposerPill({
      id: "subagents",
      agentId: agent.id,
      workspaceId: workspace,
      button: {
        icon: SUBAGENT_PILL_ICONS[iconState],
        title,
        label,
        behavior: makeSubagentPopover
          ? { kind: "popover", Content: makeSubagentPopover(agent.id, workspace) }
          : { kind: "action", onPress: () => openSubagents(agent.id, workspace) },
      },
    });
    subagentPills.set(agent.id, { registration, iconState, label, title });
  }

  // ---- Tasks (`update_steps`) pill ----------------------------------------------------------

  const syncingSteps = new Set<string>();
  async function syncStepsFromTimeline(agentId: string) {
    if (!steps || lifetime.signal.aborted || syncingSteps.has(agentId)) return;
    const agentsApi = client.paseo?.agents;
    if (!agentsApi || typeof agentsApi.ref !== "function") return;
    syncingSteps.add(agentId);
    try {
      const result = await agentsApi.ref(agentId).timeline.refetch({ direction: "tail", limit: 80 });
      if (lifetime.signal.aborted || !Array.isArray(result?.entries)) return;
      const found = extractStepsFromTimelineEntries(result.entries);
      for (const entry of found) {
        steps.store.observe(agentId, entry.callId, entry.steps, entry.timestampMs, entry.seq);
      }
    } catch {
      /* timeline refetch can fail while reconnecting or on older hosts; mounted rows still feed the store */
    } finally {
      syncingSteps.delete(agentId);
    }
  }

  function renderStepsPill(agent: ObservedAgent) {
    if (!steps || !agent.workspace) {
      stepsPills.get(agent.id)?.registration.remove();
      stepsPills.delete(agent.id);
      return;
    }
    const snapshot = steps.store.getLatest(agent.id);
    if (!snapshot || snapshot.steps.length === 0) {
      stepsPills.get(agent.id)?.registration.remove();
      stepsPills.delete(agent.id);
      return;
    }
    const summary = summarizeSteps(snapshot.steps);
    const doneSig = stepsAllDoneSignature(snapshot.steps);
    if (doneSig !== undefined && stepsSeen.get(agent.id) === doneSig) {
      stepsPills.get(agent.id)?.registration.remove();
      stepsPills.delete(agent.id);
      return;
    }
    const iconState = summary.pillState;
    const title = translateAntigravity("tasks.title");
    const label =
      summary.failed > 0
        ? translateAntigravity("tasks.pillFailed", {
            done: summary.done,
            total: summary.total,
            failed: summary.failed,
          })
        : translateAntigravity("tasks.pillProgress", {
            done: summary.done,
            total: summary.total,
          });
    const entry = stepsPills.get(agent.id);
    if (entry) {
      if (entry.iconState === iconState && entry.label === label && entry.title === title) {
        return;
      }
      const patch: Partial<PluginButton<PluginText>> = { label, title };
      if (entry.iconState !== iconState) patch.icon = STEPS_PILL_ICONS[iconState];
      entry.registration.update(patch);
      entry.iconState = iconState;
      entry.label = label;
      entry.title = title;
      return;
    }
    const registration = client.addComposerPill({
      id: "tasks",
      agentId: agent.id,
      workspaceId: agent.workspace,
      button: {
        icon: STEPS_PILL_ICONS[iconState],
        title,
        label,
        behavior: {
          kind: "popover",
          Content: steps.makePopover(
            agent.id,
            (closedSteps) => {
              if (stepsPills.get(agent.id)?.registration !== registration) return;
              if (!closedSteps) return;
              const closedSig = stepsAllDoneSignature(closedSteps);
              if (closedSig === undefined) return;
              stepsSeen.remember(agent.id, closedSig);
              const latestAgent = agents.get(agent.id);
              if (latestAgent) renderStepsPill(latestAgent);
            },
            () => {
              void syncStepsFromTimeline(agent.id);
            },
          ),
        },
      },
    });
    stepsPills.set(agent.id, { registration, iconState, label, title });
  }

  const unsubscribeSteps = steps?.store.subscribe((agentId) => {
    if (lifetime.signal.aborted) return;
    const agent = agents.get(agentId);
    if (agent) renderStepsPill(agent);
  });

  // ---- Orchestrator pill --------------------------------------------------------------------

  function effectiveOrchestrator(agent: ObservedAgent, state: OrchestratorState) {
    const override = agent.account !== SYSTEM_ACCOUNT_ID ? state.overrides[agent.account] : undefined;
    const savedPlanner = override ? override.planner : state.planner;
    const savedExecutor = override ? override.executor : state.executor;
    const plannerFamily = state.planners.find((family) => family.variants.some((variant) => variant.label === savedPlanner));
    const executorFamily = state.executors.find((family) => family.variants.some((variant) => variant.label === savedExecutor));
    return {
      isOverride: Boolean(override),
      savedPlanner,
      savedExecutor,
      effectivePlanner: plannerFamily && plannerFamily.accounts.includes(agent.account) ? savedPlanner : null,
      effectiveExecutor: executorFamily && executorFamily.accounts.includes(agent.account) ? savedExecutor : null,
    };
  }

  async function chooseOrchestrator(
    agent: ObservedAgent,
    patch: { planner?: string | null; executor?: string | null; accountId?: string; inheritGlobal?: boolean },
  ) {
    try {
      const { state, applied } = await client.rpc(setOrchestratorRpc, { ...patch, applyTo: agent.id });
      orchestrator = state;
      agents.forEach(renderOrchestratorPill);
      notify(translateAntigravity(`orchestrator.applied.${applied}`));
    } catch (error) {
      notify(errorMessage(error));
    }
  }

  function roleMenu(
    agent: ObservedAgent,
    role: "planner" | "executor",
    families: readonly ModelFamily[],
    saved: string | null,
    overrideAccountId?: string,
  ): PluginButtonMenuEntry<PluginText>[] {
    const scope = overrideAccountId ? { accountId: overrideAccountId } : {};
    const entries: PluginButtonMenuEntry<PluginText>[] = families.map((family) => {
      const choose = (label: string) => ({
        kind: "action" as const,
        onPress: () => chooseOrchestrator(agent, { ...scope, [role]: label }),
      });
      const chosen = family.variants.some((variant) => variant.label === saved);
      const missing = !family.accounts.includes(agent.account);
      if (family.variants.length === 1) {
        const only = family.variants[0]!;
        return {
          kind: "item",
          id: family.id,
          title: only.label,
          icon: chosen ? "Check" : BLANK_ICON,
          disabled: missing,
          behavior: choose(only.label),
        };
      }
      return {
        kind: "item",
        id: family.id,
        title: family.label,
        icon: chosen ? "Check" : BLANK_ICON,
        disabled: missing,
        behavior: {
          kind: "menu",
          items: family.variants.map((variant) => ({
            kind: "item" as const,
            id: variant.id,
            title: variant.effort || variant.label,
            icon: variant.label === saved ? "Check" : BLANK_ICON,
            behavior: choose(variant.label),
          })),
        },
      };
    });
    entries.push({ kind: "separator", id: `${role}-separator` });
    entries.push({
      kind: "item",
      id: `${role}-default`,
      title: translateAntigravity("orchestrator.default"),
      icon: saved ? BLANK_ICON : "Check",
      behavior: { kind: "action", onPress: () => chooseOrchestrator(agent, { ...scope, [role]: null }) },
    });
    return entries;
  }

  function renderOrchestratorPill(agent: ObservedAgent) {
    if (!agent.workspace || !isOrchestratorModel(agent.model) || !orchestrator) {
      orchestratorPills.get(agent.id)?.remove();
      orchestratorPills.delete(agent.id);
      return;
    }
    const state = orchestrator;
    const { isOverride, savedPlanner, savedExecutor, effectivePlanner, effectiveExecutor } = effectiveOrchestrator(agent, state);
    const overrideAccountId = isOverride ? agent.account : undefined;
    let label: PluginText;
    if (effectivePlanner && effectiveExecutor) {
      label = `${shortModelLabel(effectivePlanner)} / ${shortModelLabel(effectiveExecutor)}`;
    } else if (effectivePlanner) {
      label = shortModelLabel(effectivePlanner);
    } else if (effectiveExecutor) {
      label = `${translateAntigravity("orchestrator.pillDefault")} / ${shortModelLabel(effectiveExecutor)}`;
    } else {
      label = translateAntigravity("orchestrator.pillDefault");
    }

    const menuItems: PluginButtonMenuEntry<PluginText>[] = [
      {
        kind: "item",
        id: "planner",
        title: translateAntigravity("orchestrator.planner"),
        icon: "Sparkles",
        behavior: { kind: "menu", items: roleMenu(agent, "planner", state.planners, savedPlanner, overrideAccountId) },
      },
      {
        kind: "item",
        id: "executor",
        title: translateAntigravity("orchestrator.executor"),
        icon: "Cpu",
        behavior: { kind: "menu", items: roleMenu(agent, "executor", state.executors, savedExecutor, overrideAccountId) },
      },
      { kind: "separator", id: "separator" },
      {
        kind: "item",
        id: "manage",
        title: translateAntigravity("orchestrator.manage"),
        icon: "Settings2",
        behavior: { kind: "action", onPress: openAntigravityConsole },
      },
    ];

    const button: PluginButton<PluginText> = {
      icon: "Workflow",
      title: isOverride ? translateAntigravity("orchestrator.pillOverride") : translateAntigravity("orchestrator.pillTitle"),
      label,
      behavior: { kind: "menu", items: menuItems },
    };
    const pill = orchestratorPills.get(agent.id);
    if (pill) pill.update(button);
    else {
      orchestratorPills.set(
        agent.id,
        client.addComposerPill({ id: "orchestrator", agentId: agent.id, workspaceId: agent.workspace, button }),
      );
    }
  }

  async function readOrchestrator(refresh = false) {
    try {
      orchestrator = await client.rpc(getOrchestratorRpc, { refresh });
      agents.forEach(renderOrchestratorPill);
    } catch (error) {
      if (!lifetime.signal.aborted) console.warn("[dsh-paseo:antigravity] orchestrator settings unavailable", error);
    }
  }
  void readOrchestrator();
  const orchestratorTimer = setInterval(() => void readOrchestrator(), 10 * 60_000);

  let polling = false;
  async function pollSubagents(forceAll = false) {
    const now = Date.now();
    const due: string[] = [];
    for (const agent of agents.values()) {
      if (!agent.workspace) continue;
      const prev = lastPolledAt.get(agent.id) ?? 0;
      const hasRunningSubagents = (subagentCounts.get(agent.id)?.running ?? 0) > 0;
      if (forceAll || agent.running || hasRunningSubagents || prev === 0 || now - prev >= IDLE_POLL_MS) {
        due.push(agent.id);
      }
    }
    if (polling || lifetime.signal.aborted || due.length === 0) return;
    polling = true;
    try {
      for (const batch of chunk(due, POLL_BATCH_SIZE)) {
        if (lifetime.signal.aborted) break;
        const subagentRes = await client.rpc(subagentCountsRpc, { agentIds: batch });
        for (const id of batch) {
          lastPolledAt.set(id, Date.now());
          const found = subagentRes.counts[id];
          if (found) {
            subagentCounts.set(id, {
              total: found.total,
              running: found.running,
              failed: (found as { failed?: number }).failed ?? 0,
              settledIds: found.settledIds,
              failedIds: found.failedIds,
            });
          } else {
            subagentCounts.delete(id);
          }
          const agent = agents.get(id);
          if (agent) {
            renderSubagentPill(agent);
          }
        }
      }
      publishWorkspaceSubagents();
    } catch (error) {
      if (!lifetime.signal.aborted) console.warn("[dsh-paseo:antigravity] subagent count refresh failed", error);
    } finally {
      polling = false;
    }
  }

  let soon: Timer | undefined;
  function pollSoon(forceAll = false) {
    clearTimeout(soon);
    soon = setTimeout(() => void pollSubagents(forceAll), 800);
  }
  const subagentTimer = setInterval(() => void pollSubagents(), SUBAGENT_POLL_MS);

  // ---- Accounts -----------------------------------------------------------------------------

  function applyAccounts(next: AccountsState) {
    if (lifetime.signal.aborted || (accounts && accounts.revision > next.revision)) return;
    accounts = next;
    agents.forEach(renderAccountPill);
    emit();
    // Refresh Orchestrator model lists whenever account membership, sign-in state, or overrides change.
    const nextSignature = next.accounts
      .map((a) => `${a.id}:${a.status}:${a.email ?? ""}:${JSON.stringify(a.orchestratorOverride)}`)
      .join("|");
    if (accountSignature && nextSignature !== accountSignature) {
      void readOrchestrator(true);
    }
    accountSignature = nextSignature;
  }

  let retry: Timer | undefined;
  async function readAccounts() {
    try {
      applyAccounts(await client.rpc(listAccountsRpc, {}));
    } catch (error) {
      if (lifetime.signal.aborted) return;
      console.warn("[dsh-paseo:antigravity] account list unavailable", error);
      clearTimeout(retry);
      retry = setTimeout(readAccounts, 5000);
    }
  }

  const watch = client.subscribe(
    watchAccountsSubscription,
    {},
    ({ revision }) => {
      if (revision > (accounts?.revision ?? -1)) void readAccounts();
    },
    { signal: lifetime.signal },
  );
  void watch.ready.catch((error: unknown) => {
    if (!lifetime.signal.aborted) console.warn("[dsh-paseo:antigravity] account watch unavailable", error);
  });
  void readAccounts();

  // ---- Agents -------------------------------------------------------------------------------

  function publishAgents() {
    const nextCounts = new Map<string, number>();
    const nextMembers: ObservedAgent[] = [];
    for (const member of agents.values()) {
      nextMembers.push(member);
      nextCounts.set(member.account, (nextCounts.get(member.account) ?? 0) + 1);
    }
    counts = nextCounts;
    memberSnapshot = nextMembers;
    publishWorkspaceSubagents();
    emit();
  }

  function remove(id: string) {
    accountPills.get(id)?.registration.remove();
    accountPills.delete(id);
    subagentPills.get(id)?.registration.remove();
    subagentPills.delete(id);
    stepsPills.get(id)?.registration.remove();
    stepsPills.delete(id);
    orchestratorPills.get(id)?.remove();
    orchestratorPills.delete(id);
    subagentCounts.delete(id);
    lastPolledAt.delete(id);
    steps?.store.deleteAgent(id);
    archiveStore.deleteAgent(id);
    agents.delete(id);
  }

  function upsert(row: AgentRow) {
    if (row.archivedAt || !isAntigravityProvider(row.provider)) return remove(row.id);
    const seenChanged = stepsSeen.observe({ id: row.id, metadata: row.metadata ?? undefined });
    const archiveChanged = archiveStore.observe(row.id, row.metadata);
    const member: ObservedAgent = {
      id: row.id,
      workspace: row.workspaceId ?? null,
      account: accountIdFromMetadata(row.metadata),
      running: row.status === "running" || row.status === "initializing",
      model: row.model ?? null,
      title: row.title ?? null,
    };
    const old = agents.get(row.id);
    // A status change usually means a turn started or ended: subagent counts and task checklists may change then.
    if (!old || old.running !== member.running) {
      lastPolledAt.delete(row.id);
      pollSoon();
      void syncStepsFromTimeline(row.id);
    }
    if (
      old &&
      old.workspace === member.workspace &&
      old.account === member.account &&
      old.running === member.running &&
      old.model === member.model &&
      old.title === member.title
    ) {
      if (seenChanged) renderStepsPill(member);
      if (archiveChanged) renderSubagentPill(member);
      return;
    }
    if (old && old.workspace !== member.workspace) remove(row.id);
    agents.set(row.id, member);
    renderAccountPill(member);
    renderSubagentPill(member);
    renderStepsPill(member);
    renderOrchestratorPill(member);
  }

  let reconnect: Timer | undefined;
  async function observe() {
    try {
      const { subscription } = await client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal });
      if (lifetime.signal.aborted) return;
      subscription.subscribe({
        snapshot({ entries }) {
          if (lifetime.signal.aborted) return;
          const ids = new Set(entries.map(({ agent }) => agent.id));
          for (const id of agents.keys()) if (!ids.has(id)) remove(id);
          entries.forEach(({ agent }) => upsert(agent));
          publishAgents();
        },
        update(message) {
          if (lifetime.signal.aborted || message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else upsert(update.agent);
          publishAgents();
        },
      });
    } catch (error) {
      if (lifetime.signal.aborted) return;
      console.warn("[dsh-paseo:antigravity] agent observation unavailable", error);
      reconnect = setTimeout(observe, 5000);
    }
  }
  void observe();

  // ---- /account & /orchestrator -------------------------------------------------------------

  const registerSlashAccount = () =>
    client.addSlashCommand({
      name: "account",
      context: "agent",
      description: translateAntigravity("slash"),
      argumentHint: translateAntigravity("hint"),
      async onSubmit({ agent, args }) {
        if (!isAntigravityProvider(agent.provider)) return notify(translateAntigravity("only"));
        try {
          const state = await client.rpc(listAccountsRpc, {});
          applyAccounts(state);
          const list = state.accounts;
          const current = accountIdFromMetadata(agent.metadata);
          const input = args.trim().toLowerCase();
          if (!input) {
            const curAccount = list.find((account) => account.id === current);
            return notify(
              translateAntigravity("choices", {
                label: curAccount ? nameOf(curAccount.label, curAccount.kind) : current,
                list: list.map((account, index) => `${index + 1}. ${nameOf(account.label, account.kind)}`).join("\n"),
              }),
            );
          }
          const named = (account: AccountSummary) => nameOf(account.label, account.kind).toLowerCase();
          let matches = list.filter((account) => named(account) === input || account.label.toLowerCase() === input);
          if (/^\d+$/.test(input)) matches = list.slice(Number(input) - 1, Number(input));
          else if (!matches.length) matches = list.filter((account) => named(account).startsWith(input));
          if (matches.length !== 1) return notify(translateAntigravity(matches.length ? "ambiguous" : "noMatch"));
          const target = matches[0]!;
          if (!target.usable || target.status === "signed-out") {
            return notify(target.statusDetail || translateAntigravity("unusable"));
          }
          const busy = agent.status === "running" || agent.status === "initializing";
          await switchTo(agent.id, target, busy ? "after-turn" : "now");
        } catch (error) {
          notify(errorMessage(error));
        }
      },
    });

  const registerSlashOrchestrator = () =>
    client.addSlashCommand({
      name: "orchestrator",
      context: "agent",
      description: translateAntigravity("orchestrator.slash"),
      argumentHint: translateAntigravity("orchestrator.slashHint"),
      async onSubmit({ agent, args }) {
        if (!isAntigravityProvider(agent.provider)) return notify(translateAntigravity("only"));
        try {
          const state = await client.rpc(getOrchestratorRpc, {});
          orchestrator = state;
          const member = agents.get(agent.id) ?? {
            id: agent.id,
            workspace: agent.workspaceId ?? null,
            account: accountIdFromMetadata(agent.metadata),
            running: agent.status === "running" || agent.status === "initializing",
            model: agent.model ?? null,
            title: agent.title ?? null,
          };
          const eff = effectiveOrchestrator(member, state);
          const scope = eff.isOverride ? { accountId: member.account } : {};
          const input = args.trim();
          if (!input) {
            return notify(
              translateAntigravity("orchestrator.slashCurrent", {
                planner: eff.savedPlanner ?? translateAntigravity("orchestrator.default"),
                executor: eff.savedExecutor ?? translateAntigravity("orchestrator.default"),
              }),
            );
          }
          const lower = input.toLowerCase();
          const presets = resolvePresets(state);
          const preset = presets.find((p) => p.id === lower);
          if (preset) {
            await chooseOrchestrator(member, { ...scope, planner: preset.planner, executor: preset.executor });
            return;
          }
          const [first, ...rest] = input.split(/\s+/);
          const role = first?.toLowerCase() === "planner" || first?.toLowerCase() === "executor" ? (first.toLowerCase() as "planner" | "executor") : null;
          const query = (role ? rest.join(" ") : input).trim().toLowerCase();
          const findVariant = (families: readonly ModelFamily[]) => {
            if (!query) return undefined;
            if (query === "default" || query === "reset") return null;
            for (const family of families) {
              for (const variant of family.variants) {
                if (
                  variant.label.toLowerCase() === query ||
                  variant.id.toLowerCase() === query ||
                  shortModelLabel(variant.label).toLowerCase() === query
                ) {
                  return variant.label;
                }
              }
            }
            for (const family of families) {
              for (const variant of family.variants) {
                if (variant.label.toLowerCase().includes(query) || variant.id.toLowerCase().includes(query)) {
                  return variant.label;
                }
              }
            }
            return undefined;
          };
          if (role) {
            const picked = findVariant(role === "planner" ? state.planners : state.executors);
            if (picked === undefined) return notify(translateAntigravity("orchestrator.slashNoMatch"));
            await chooseOrchestrator(member, { ...scope, [role]: picked });
            return;
          }
          const asPlanner = findVariant(state.planners);
          if (asPlanner !== undefined) {
            await chooseOrchestrator(member, { ...scope, planner: asPlanner });
            return;
          }
          const asExecutor = findVariant(state.executors);
          if (asExecutor !== undefined) {
            await chooseOrchestrator(member, { ...scope, executor: asExecutor });
            return;
          }
          notify(translateAntigravity("orchestrator.slashNoMatch"));
        } catch (error) {
          notify(errorMessage(error));
        }
      },
    });

  let slashAccount = registerSlashAccount();
  let slashOrchestrator = registerSlashOrchestrator();

  const unsubscribeLocale = subscribeLocale(() => {
    if (lifetime.signal.aborted) return;
    agents.forEach((agent) => {
      renderAccountPill(agent);
      renderSubagentPill(agent);
      renderStepsPill(agent);
      renderOrchestratorPill(agent);
    });
    const prevAccount = slashAccount;
    const prevOrchestrator = slashOrchestrator;
    slashAccount = () => {};
    slashOrchestrator = () => {};
    void prevAccount();
    void prevOrchestrator();
    slashAccount = registerSlashAccount();
    slashOrchestrator = registerSlashOrchestrator();
  });

  const unsubscribeArchive = archiveStore.subscribe(() => {
    if (lifetime.signal.aborted) return;
    agents.forEach(renderSubagentPill);
  });

  return {
    useNotifications,
    notify,
    counts: () => counts,
    members: () => memberSnapshot,
    workspaceRunningSubagents: () => workspaceSubagents,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refreshSubagents: () => pollSubagents(true),
    /** Settings changed elsewhere (the console screen): redraw the Orchestrator pills. */
    setOrchestrator(state: OrchestratorState) {
      orchestrator = state;
      agents.forEach(renderOrchestratorPill);
    },
    stop() {
      lifetime.abort();
      unsubscribeLocale();
      unsubscribeSteps?.();
      unsubscribeArchive();
      clearTimeout(retry);
      clearTimeout(reconnect);
      clearTimeout(soon);
      clearInterval(subagentTimer);
      clearInterval(orchestratorTimer);
      void slashAccount();
      void slashOrchestrator();
      accountPills.forEach((entry) => entry.registration.remove());
      subagentPills.forEach((entry) => entry.registration.remove());
      stepsPills.forEach((entry) => entry.registration.remove());
      orchestratorPills.forEach((pill) => pill.remove());
      accountPills.clear();
      subagentPills.clear();
      stepsPills.clear();
      orchestratorPills.clear();
      subagentCounts.clear();
      lastPolledAt.clear();
      agents.clear();
      listeners.clear();
      presenters.clear();
      pendingNotice = undefined;
    },
  };
}

export type AgentObservation = ReturnType<typeof observeAgents>;
