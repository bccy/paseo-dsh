import type {
  PluginButton,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
  PluginText,
} from "@getpaseo/plugin/client";
import { useToast, type ToastApi } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
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
} from "../../shared/antigravity/contracts";
import { displayLabel } from "./labels";
import { errorMessage, messages } from "./messages";
import { resolvePresets, shortModelLabel } from "./orchestrator";

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
  navigation?: ObserveAgentsNavigation,
) {
  const lifetime = new AbortController();
  const agents = new Map<string, ObservedAgent>();
  const accountPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const subagentPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const orchestratorPills = new Map<string, PluginButtonRegistration<PluginText>>();
  const subagentCounts = new Map<string, { total: number; running: number }>();
  const lastPolledAt = new Map<string, number>();
  let orchestrator: OrchestratorState | undefined;
  const listeners = new Set<() => void>();
  const presenters = new Map<symbol, ToastApi>();
  let pendingNotice: string | undefined;
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
  function notify(message: string) {
    if (lifetime.signal.aborted) return;
    const presenter = presenters.values().next().value;
    if (presenter) presenter.show(message, { durationMs: 5000 });
    else pendingNotice = message;
  }

  function useNotifications() {
    const toast = useToast();
    useEffect(() => {
      const key = Symbol();
      presenters.set(key, toast);
      if (pendingNotice) {
        notify(pendingNotice);
        pendingNotice = undefined;
      }
      return () => {
        presenters.delete(key);
      };
    }, [toast]);
  }

  const nameOf = (label: string, kind?: AccountSummary["kind"]) =>
    displayLabel(label, (key) => client.i18n.t(messages, key), kind);

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

  async function switchTo(agentId: string, account: AccountSummary, when: "now" | "after-turn") {
    const result = await client.rpc(switchAgentAccountRpc, { agentId, accountId: account.id, when });
    notify(client.i18n.t(messages, result.result, { label: nameOf(result.accountLabel, account.kind) }));
  }

  // ---- Account pill -------------------------------------------------------------------------

  function renderAccountPill(agent: ObservedAgent) {
    if (!agent.workspace) return;
    const current = accounts?.accounts.find((account) => account.id === agent.account);
    const healthy = !current || (current.usable && current.status !== "signed-out");
    const choices: PluginButtonMenuEntry<PluginText>[] = (accounts?.accounts ?? []).map((account) => {
      const selected = account.id === agent.account;
      const unavailable = !account.usable || account.status === "signed-out";
      const action = (when: "now" | "after-turn") => ({
        kind: "action" as const,
        onPress: () => switchTo(agent.id, account, when),
      });
      return {
        kind: "item",
        id: account.id,
        title: [
          nameOf(account.label, account.kind),
          account.kind === "profile" && account.status === "signed-out" ? null : account.email,
          account.plan,
        ]
          .filter(Boolean)
          .join(" · "),
        icon: selected ? "Check" : unavailable ? "UserX" : "UserRound",
        disabled: selected || unavailable,
        behavior: agent.running
          ? {
              kind: "menu",
              items: [
                { kind: "item", id: "now", title: messages.message("now"), icon: "Zap", behavior: action("now") },
                { kind: "item", id: "after", title: messages.message("after"), icon: "Clock", behavior: action("after-turn") },
              ],
            }
          : action("now"),
      };
    });
    if (choices.length) choices.push({ kind: "separator", id: "separator" });
    choices.push({
      kind: "item",
      id: "manage",
      title: messages.message("manage"),
      icon: "Settings2",
      behavior: { kind: "action", onPress: openAntigravityConsole },
    });
    const button: PluginButton<PluginText> = {
      icon: healthy ? "UserRound" : "UserX",
      title: healthy ? messages.message("pill") : messages.message("pillSignedOut"),
      label: current ? nameOf(current.label, current.kind) : agent.account,
      behavior: { kind: "menu", items: choices },
    };
    const pill = accountPills.get(agent.id);
    if (pill) pill.update(button);
    else {
      accountPills.set(
        agent.id,
        client.addComposerPill({ id: "account", agentId: agent.id, workspaceId: agent.workspace, button }),
      );
    }
  }

  // ---- Subagent pill ------------------------------------------------------------------------

  function renderSubagentPill(agent: ObservedAgent) {
    const count = subagentCounts.get(agent.id);
    if (!agent.workspace || !count?.total) {
      subagentPills.get(agent.id)?.remove();
      subagentPills.delete(agent.id);
      return;
    }
    const label = count.running
      ? messages.message("subagents.pillLabel", { running: count.running, total: count.total })
      : messages.message("subagents.pillLabelIdle", { total: count.total });
    const pill = subagentPills.get(agent.id);
    if (pill) {
      pill.update({ label });
      return;
    }
    const workspace = agent.workspace;
    subagentPills.set(
      agent.id,
      client.addComposerPill({
        id: "subagents",
        agentId: agent.id,
        workspaceId: workspace,
        button: {
          icon: "Bot",
          title: messages.message("subagents.pill"),
          label,
          behavior: { kind: "action", onPress: () => openSubagents(agent.id, workspace) },
        },
      }),
    );
  }

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
      notify(client.i18n.t(messages, `orchestrator.applied.${applied}`));
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
      title: messages.message("orchestrator.default"),
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
      label = `${client.i18n.t(messages, "orchestrator.pillDefault")} / ${shortModelLabel(effectiveExecutor)}`;
    } else {
      label = messages.message("orchestrator.pillDefault");
    }

    const menuItems: PluginButtonMenuEntry<PluginText>[] = [
      {
        kind: "item",
        id: "planner",
        title: messages.message("orchestrator.planner"),
        icon: "Sparkles",
        behavior: { kind: "menu", items: roleMenu(agent, "planner", state.planners, savedPlanner, overrideAccountId) },
      },
      {
        kind: "item",
        id: "executor",
        title: messages.message("orchestrator.executor"),
        icon: "Cpu",
        behavior: { kind: "menu", items: roleMenu(agent, "executor", state.executors, savedExecutor, overrideAccountId) },
      },
      { kind: "separator", id: "separator" },
      {
        kind: "item",
        id: "manage",
        title: messages.message("orchestrator.manage"),
        icon: "Settings2",
        behavior: { kind: "action", onPress: openAntigravityConsole },
      },
    ];

    const button: PluginButton<PluginText> = {
      icon: "Workflow",
      title: isOverride ? messages.message("orchestrator.pillOverride") : messages.message("orchestrator.pillTitle"),
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
          if (found) subagentCounts.set(id, found);
          else subagentCounts.delete(id);
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
    accountPills.get(id)?.remove();
    accountPills.delete(id);
    subagentPills.get(id)?.remove();
    subagentPills.delete(id);
    orchestratorPills.get(id)?.remove();
    orchestratorPills.delete(id);
    subagentCounts.delete(id);
    lastPolledAt.delete(id);
    agents.delete(id);
  }

  function upsert(row: AgentRow) {
    if (row.archivedAt || !isAntigravityProvider(row.provider)) return remove(row.id);
    const member: ObservedAgent = {
      id: row.id,
      workspace: row.workspaceId ?? null,
      account: accountIdFromMetadata(row.metadata),
      running: row.status === "running" || row.status === "initializing",
      model: row.model ?? null,
      title: row.title ?? null,
    };
    const old = agents.get(row.id);
    // A status change usually means a turn started or ended: subagent counts may change then.
    if (!old || old.running !== member.running) {
      lastPolledAt.delete(row.id);
      pollSoon();
    }
    if (
      old &&
      old.workspace === member.workspace &&
      old.account === member.account &&
      old.running === member.running &&
      old.model === member.model &&
      old.title === member.title
    ) {
      return;
    }
    if (old && old.workspace !== member.workspace) remove(row.id);
    agents.set(row.id, member);
    renderAccountPill(member);
    renderSubagentPill(member);
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

  const slashAccount = client.addSlashCommand({
    name: "account",
    context: "agent",
    description: messages.message("slash"),
    argumentHint: messages.message("hint"),
    async onSubmit({ agent, args }) {
      if (!isAntigravityProvider(agent.provider)) return notify(client.i18n.t(messages, "only"));
      const state = await client.rpc(listAccountsRpc, {});
      applyAccounts(state);
      const list = state.accounts;
      const current = accountIdFromMetadata(agent.metadata);
      const input = args.trim().toLowerCase();
      if (!input) {
        const curAccount = list.find((account) => account.id === current);
        return notify(
          client.i18n.t(messages, "choices", {
            label: curAccount ? nameOf(curAccount.label, curAccount.kind) : current,
            list: list.map((account, index) => `${index + 1}. ${nameOf(account.label, account.kind)}`).join("\n"),
          }),
        );
      }
      const named = (account: AccountSummary) => nameOf(account.label, account.kind).toLowerCase();
      let matches = list.filter((account) => named(account) === input || account.label.toLowerCase() === input);
      if (/^\d+$/.test(input)) matches = list.slice(Number(input) - 1, Number(input));
      else if (!matches.length) matches = list.filter((account) => named(account).startsWith(input));
      if (matches.length !== 1) return notify(client.i18n.t(messages, matches.length ? "ambiguous" : "noMatch"));
      const target = matches[0]!;
      if (!target.usable || target.status === "signed-out") {
        return notify(target.statusDetail || client.i18n.t(messages, "unusable"));
      }
      const busy = agent.status === "running" || agent.status === "initializing";
      await switchTo(agent.id, target, busy ? "after-turn" : "now");
    },
  });

  const slashOrchestrator = client.addSlashCommand({
    name: "orchestrator",
    context: "agent",
    description: messages.message("orchestrator.slash"),
    argumentHint: messages.message("orchestrator.slashHint"),
    async onSubmit({ agent, args }) {
      if (!isAntigravityProvider(agent.provider)) return notify(client.i18n.t(messages, "only"));
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
      const input = args.trim();
      if (!input) {
        const eff = effectiveOrchestrator(member, state);
        return notify(
          client.i18n.t(messages, "orchestrator.slashCurrent", {
            planner: eff.savedPlanner ?? client.i18n.t(messages, "orchestrator.default"),
            executor: eff.savedExecutor ?? client.i18n.t(messages, "orchestrator.default"),
          }),
        );
      }
      const lower = input.toLowerCase();
      const presets = resolvePresets(state);
      const preset = presets.find((p) => p.id === lower);
      if (preset) {
        await chooseOrchestrator(member, { planner: preset.planner, executor: preset.executor });
        return;
      }
      const [first, ...rest] = input.split(/\s+/);
      const role = first?.toLowerCase() === "planner" || first?.toLowerCase() === "executor" ? (first.toLowerCase() as "planner" | "executor") : null;
      const query = (role ? rest.join(" ") : input).trim().toLowerCase();
      const findVariant = (families: readonly ModelFamily[]) => {
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
        if (picked === undefined) return notify(client.i18n.t(messages, "orchestrator.slashNoMatch"));
        await chooseOrchestrator(member, { [role]: picked });
        return;
      }
      const asPlanner = findVariant(state.planners);
      if (asPlanner !== undefined) {
        await chooseOrchestrator(member, { planner: asPlanner });
        return;
      }
      const asExecutor = findVariant(state.executors);
      if (asExecutor !== undefined) {
        await chooseOrchestrator(member, { executor: asExecutor });
        return;
      }
      notify(client.i18n.t(messages, "orchestrator.slashNoMatch"));
    },
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
      clearTimeout(retry);
      clearTimeout(reconnect);
      clearTimeout(soon);
      clearInterval(subagentTimer);
      clearInterval(orchestratorTimer);
      void slashAccount();
      void slashOrchestrator();
      accountPills.forEach((pill) => pill.remove());
      subagentPills.forEach((pill) => pill.remove());
      orchestratorPills.forEach((pill) => pill.remove());
      accountPills.clear();
      subagentPills.clear();
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
