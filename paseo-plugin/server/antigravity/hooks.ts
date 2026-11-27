import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  ACCOUNT_METADATA_KEY,
  SYSTEM_ACCOUNT_ID,
  accountIdFromMetadata,
  isAntigravityProvider,
  type FallbackEvent,
} from "../../shared/antigravity/contracts";
import type { AccountService } from "./accounts";
import { sessionEnv } from "./agy";
import { conversationIdFrom } from "./context";
import type { PaseoApi } from "./types";

const DEFERRED_TURN_WINDOW_MS = 10_000;

/** Agents that switch account once their running turn ends, plus in-flight manual/controlled switches. */
export class PendingSwitches {
  private readonly pending = new Map<string, string>();
  private readonly executing = new Set<string>();
  private readonly deferredTurns = new Map<string, { turnId: string | null; at: number }>();
  private readonly manualCounts = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * Serializes account switches on the same agent so refresh, CAS, metadata update,
   * and reload run atomically without interleaving manual switches and fallback.
   */
  async withAgentLock<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.locks.set(agentId, tail);
    await prev;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(agentId) === tail) {
        this.locks.delete(agentId);
      }
    }
  }

  set(agentId: string, accountId: string): void {
    this.pending.set(agentId, accountId);
  }

  has(agentId: string): boolean {
    return this.pending.has(agentId);
  }

  hasPendingOrActive(agentId: string): boolean {
    return this.pending.has(agentId) || this.executing.has(agentId);
  }

  take(agentId: string): string | undefined {
    const value = this.pending.get(agentId);
    this.pending.delete(agentId);
    return value;
  }

  beginDeferred(agentId: string): void {
    this.executing.add(agentId);
  }

  endDeferred(agentId: string): void {
    this.executing.delete(agentId);
  }

  /**
   * Records that this agent's turn was claimed by a deferred manual switch.
   * Needed because Paseo dispatches `agent.turn.after` handlers serially: by the time
   * `FallbackController`'s handler runs, the deferred switch handler may have already finished.
   */
  markDeferredTurn(agentId: string, turnId?: string | null): void {
    this.deferredTurns.set(agentId, { turnId: turnId ?? null, at: Date.now() });
  }

  /**
   * True when `turnId` matches the turn claimed by a deferred manual switch, or within a short
   * fallback window when `turnId` is absent.
   */
  wasDeferredForTurn(agentId: string, turnId?: string | null): boolean {
    const record = this.deferredTurns.get(agentId);
    if (!record) return false;
    if (record.turnId && turnId) return record.turnId === turnId;
    if (Date.now() - record.at <= DEFERRED_TURN_WINDOW_MS) return true;
    this.deferredTurns.delete(agentId);
    return false;
  }

  clearDeferredTurn(agentId: string): void {
    this.deferredTurns.delete(agentId);
  }

  delete(agentId: string): void {
    this.pending.delete(agentId);
  }

  beginManual(agentId: string): void {
    this.manualCounts.set(agentId, (this.manualCounts.get(agentId) ?? 0) + 1);
  }

  endManual(agentId: string): void {
    const next = (this.manualCounts.get(agentId) ?? 0) - 1;
    if (next <= 0) this.manualCounts.delete(agentId);
    else this.manualCounts.set(agentId, next);
  }

  isManual(agentId: string): boolean {
    return (this.manualCounts.get(agentId) ?? 0) > 0;
  }
}

export interface SwitchInput {
  agentId: string;
  accountId: string;
  when: "now" | "after-turn";
  /** True when the user explicitly chose the account (bypasses automatic open redirect). */
  manual?: boolean;
  /**
   * Optional CAS guard for automatic fallback: abort with `"unchanged"` if the agent has
   * already moved away from this account (e.g. the user manually switched it meanwhile).
   */
  expectedCurrentAccountId?: string;
}

export interface SwitchOutcome {
  result: "switched" | "scheduled" | "unchanged";
  accountLabel: string;
}

/** Moves an agent to another account. The conversation stays because the store is shared. */
export async function switchAgentAccount(
  paseo: PaseoApi,
  service: AccountService,
  pending: PendingSwitches,
  input: SwitchInput,
): Promise<SwitchOutcome> {
  const isUserManual = input.manual === true && input.expectedCurrentAccountId === undefined;
  if (isUserManual) pending.beginManual(input.agentId);
  try {
    return await pending.withAgentLock(input.agentId, async () => {
      const target = service.requireAccount(input.accountId);
      if (target?.unsafeDetail) throw new Error(target.unsafeDetail);
      const accountLabel = service.labelOf(input.accountId);
      if (target) {
        // Moving an agent onto an account that cannot run would strand it there.
        // Only block on a live probe when the account has never been checked or was
        // last seen signed-out/error; when already known signed-in, switch at once
        // and refresh stale quota in the background so failover/manual switches never
        // stall 10+ seconds waiting on `agy -p /usage`.
        const known = typeof service.knownStatus === "function" ? service.knownStatus(input.accountId) : "unknown";
        if (known === "signed-in") {
          void Promise.resolve(service.quotaFor(input.accountId, 5 * 60_000)).catch(() => undefined);
        } else {
          const status = await service.quotaFor(input.accountId, 5 * 60_000);
          if (status.status === "signed-out") {
            throw new Error(`Sign in to "${accountLabel}" in Antigravity accounts before moving an agent to it.`);
          }
        }
      }
      const handle = paseo.agents.ref(input.agentId);
      const refreshed = await handle.refresh();
      if (!refreshed) throw new Error("That agent no longer exists.");
      const agent = refreshed.agent;
      if (!isAntigravityProvider(agent.provider)) {
        throw new Error("Only Antigravity agents can switch Google accounts.");
      }
      if (agent.archivedAt) throw new Error("That agent is archived.");
      const current = accountIdFromMetadata(agent.metadata);
      if (
        input.expectedCurrentAccountId !== undefined &&
        (current !== input.expectedCurrentAccountId || pending.isManual(input.agentId))
      ) {
        return { result: "unchanged", accountLabel: service.labelOf(current) };
      }
      if (current === input.accountId) {
        pending.delete(input.agentId);
        return { result: "unchanged", accountLabel };
      }
      const running = agent.status === "running" || agent.status === "initializing";
      if (input.when === "after-turn" && running) {
        // Do not overwrite metadata while the turn is still executing on `current`:
        // turn-after attribution and fallback must see the account that actually ran this turn.
        pending.set(input.agentId, input.accountId);
        return { result: "scheduled", accountLabel };
      }
      // An explicit "default" keeps the system choice even when another account is the default.
      await handle.setMetadata({ [ACCOUNT_METADATA_KEY]: input.accountId });
      pending.delete(input.agentId);
      // Protect both forward reload and failure rollback reload from re-entering `redirectForOpen`.
      pending.beginManual(input.agentId);
      try {
        await handle.reload();
      } catch (error) {
        // Put the agent back where it worked, then report why the new account failed.
        const reason = error instanceof Error ? error.message : String(error);
        await handle.setMetadata({ [ACCOUNT_METADATA_KEY]: current }).catch(() => undefined);
        const restored = await handle.reload().then(
          () => true,
          () => false,
        );
        throw new Error(
          `"${accountLabel}" could not open this agent: ${reason}` +
            (restored ? ` The agent stays on "${service.labelOf(current)}".` : ""),
        );
      } finally {
        pending.endManual(input.agentId);
      }
      return { result: "switched", accountLabel };
    });
  } finally {
    if (isUserManual) pending.endManual(input.agentId);
  }
}

export interface MigrateInput {
  fromAccountId: string;
  toAccountId: string;
  mode: "idle-only" | "after-turn" | "now";
}

export interface MigrateOutcome {
  switched: number;
  scheduled: number;
  skipped: number;
  failed: Array<{ agentId: string; title: string | null; error: string }>;
  targetLabel: string;
}

/** Moves all matching Antigravity agents from one account onto another. */
export async function migrateAccountAgents(
  paseo: PaseoApi,
  service: AccountService,
  pending: PendingSwitches,
  input: MigrateInput,
): Promise<MigrateOutcome> {
  if (input.fromAccountId === input.toAccountId) {
    throw new Error("Choose a different target account.");
  }
  service.requireAccount(input.fromAccountId);
  const target = service.requireAccount(input.toAccountId);
  if (target?.unsafeDetail) throw new Error(target.unsafeDetail);
  const targetLabel = service.labelOf(input.toAccountId);
  if (target) {
    const status = await service.quotaFor(input.toAccountId, 5 * 60_000);
    if (status.status === "signed-out") {
      throw new Error(`Sign in to "${targetLabel}" before migrating agents to it.`);
    }
  }
  const { entries } = await paseo.agents.list();
  let switched = 0;
  let scheduled = 0;
  let skipped = 0;
  const failed: MigrateOutcome["failed"] = [];

  for (const { agent } of entries) {
    if (agent.archivedAt || !isAntigravityProvider(agent.provider)) continue;
    if (accountIdFromMetadata(agent.metadata) !== input.fromAccountId) continue;
    const running = agent.status === "running" || agent.status === "initializing";
    if (running && input.mode === "idle-only") {
      skipped += 1;
      continue;
    }
    try {
      const outcome = await switchAgentAccount(paseo, service, pending, {
        agentId: agent.id,
        accountId: input.toAccountId,
        when: input.mode === "now" ? "now" : "after-turn",
        manual: true,
      });
      if (outcome.result === "switched") switched += 1;
      else if (outcome.result === "scheduled") scheduled += 1;
      else skipped += 1;
    } catch (error) {
      failed.push({
        agentId: agent.id,
        title: agent.title ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { switched, scheduled, skipped, failed, targetLabel };
}

/** The fallback controller's part of the session-open path; kept as an interface to avoid an import cycle. */
export interface OpenFallback {
  healthOf(accountId: string, model?: string | null): Promise<FallbackEvent["reason"] | null>;
  redirectForOpen(
    paseo: PaseoApi,
    agentId: string,
    accountId: string,
    reason: FallbackEvent["reason"],
    record: boolean,
    model?: string | null,
  ): Promise<string | null>;
  pickNext(current: string, tried: ReadonlySet<string>, model?: string | null): Promise<string | null>;
}

export interface HookObservers {
  onConversationAccount?: (conversationId: string, accountId: string) => void;
  onAgentArchived?: (agentId: string) => void;
  /** Only register `agent.open.before` when true, preserving pure-DSH zero-invalidation guarantee. */
  registerOpenBefore: boolean;
  /** Optional callback invoked with the plugin handler context (e.g. to capture PaseoApi). */
  onContext?: (ctx: PluginHandlerContext) => void;
}

export function registerHooks(
  server: PluginServerContext,
  service: AccountService,
  pending: PendingSwitches,
  fallback?: OpenFallback,
  observers?: HookObservers,
): Array<() => void> {
  const removers: Array<() => void> = [];

  // New Antigravity agents get the default account (or best fallback when configured & default is unavailable).
  removers.push(
    server.addHook("agent.create.before", async ({ request }, ctx) => {
      observers?.onContext?.(ctx);
      if (!isAntigravityProvider(request.config.provider)) return undefined;
      await service.init();
      const metadata = request.metadata ?? {};
      if (typeof metadata[ACCOUNT_METADATA_KEY] === "string") return undefined;
      const state = await service.state();
      const model = request.config.model ?? null;
      let chosen = state.defaultAccountId;
      const fallbackSettings = service.fallbackSettings();
      if (fallbackSettings.enabled && fallback) {
        const problem = await fallback.healthOf(chosen, model);
        if (problem) {
          const better = await fallback.pickNext(chosen, new Set([chosen]), model);
          if (better) chosen = better;
        }
      }
      if (chosen === SYSTEM_ACCOUNT_ID) return undefined;
      const account = service.store.get(chosen);
      if (!account || account.unsafeDetail || service.knownStatus(account.id) === "signed-out") {
        // A default that cannot run would make every new agent fail; leave it on the system sign-in.
        console.warn(
          `dsh-paseo/antigravity: default account ${chosen} cannot run; new agent stays on the system sign-in`,
        );
        return undefined;
      }
      return {
        ...request,
        metadata: { ...metadata, [ACCOUNT_METADATA_KEY]: chosen },
      };
    }),
  );

  // Conditionally register `agent.open.before` ONLY when Antigravity CLI or profile accounts exist.
  // Paseo calls `invalidatePluginSessions()` on start/stop for plugins that register `agent.open.before`;
  // skipping it on pure-DSH machines guarantees zero agent reloads on plugin restarts.
  if (observers?.registerOpenBefore) {
    removers.push(
      server.addHook("agent.open.before", async ({ request }, ctx) => {
        observers.onContext?.(ctx);
        const { paseo } = ctx;
        if (!isAntigravityProvider(request.provider)) return undefined;
        await service.init();
        let accountId = accountIdFromMetadata(request.metadata);
        // Fallback: an account known to be unable to serve gives way to the next one that can,
        // unless the user explicitly asked to switch this agent to that account right now.
        if (service.fallbackSettings().enabled && fallback && !pending.isManual(request.agentId)) {
          const snapshot = await paseo.agents
            .ref(request.agentId)
            .refresh()
            .catch(() => null);
          const model = snapshot?.agent.model ?? null;
          const reason = await fallback.healthOf(accountId, model);
          if (reason) {
            const next = await fallback.redirectForOpen(
              paseo,
              request.agentId,
              accountId,
              reason,
              request.purpose === "interactive",
              model,
            );
            if (next) accountId = next;
          }
        }
        const account = accountId === SYSTEM_ACCOUNT_ID ? null : service.store.get(accountId);
        if (accountId !== SYSTEM_ACCOUNT_ID) {
          const problem = !account
            ? "The Antigravity account this agent was using has been removed."
            : account.unsafeDetail;
          if (problem) {
            // Reading history is harmless on the system sign-in; running a turn is not.
            if (request.purpose === "history") accountId = SYSTEM_ACCOUNT_ID;
            else {
              throw new Error(
                `${problem} Switch the agent to another account with the account pill above the composer.`,
              );
            }
          }
        }
        if (accountId !== SYSTEM_ACCOUNT_ID) await service.ensureAccountProfile(accountId);
        return {
          ...request,
          env: { ...request.env, ...sessionEnv(accountId, request.env) },
        };
      }),
    );
  }

  // A finished turn used quota: re-read that account's quota shortly after and record attribution.
  const quotaRefresh = new Map<string, NodeJS.Timeout>();
  removers.push(
    server.addHook("agent.turn.after", async ({ agent }, ctx) => {
      observers?.onContext?.(ctx);
      const { paseo } = ctx;
      if (!isAntigravityProvider(agent.provider)) return;
      await service.init();
      const accountId = accountIdFromMetadata(agent.metadata);
      if (observers?.onConversationAccount) {
        void paseo.agents
          .ref(agent.id)
          .refresh()
          .then((snapshot) => {
            const conversationId = conversationIdFrom(snapshot?.agent.persistence);
            if (conversationId) observers.onConversationAccount?.(conversationId, accountId);
          })
          .catch(() => undefined);
      }
      clearTimeout(quotaRefresh.get(accountId));
      quotaRefresh.set(
        accountId,
        setTimeout(() => {
          quotaRefresh.delete(accountId);
          void service.refreshOne(accountId).catch(() => undefined);
        }, 15_000),
      );
    }),
  );
  removers.push(() => {
    for (const timer of quotaRefresh.values()) clearTimeout(timer);
    quotaRefresh.clear();
  });

  // Deferred switches run as soon as the agent's turn ends.
  removers.push(
    server.addHook("agent.turn.after", async ({ agent, turnId }, ctx) => {
      observers?.onContext?.(ctx);
      const { paseo } = ctx;
      const target = pending.take(agent.id);
      if (!target) return;
      pending.beginDeferred(agent.id);
      pending.markDeferredTurn(agent.id, turnId);
      try {
        await service.init();
        if (target !== SYSTEM_ACCOUNT_ID) {
          const account = service.store.get(target);
          if (!account || account.unsafeDetail) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        await pending.withAgentLock(agent.id, async () => {
          const handle = paseo.agents.ref(agent.id);
          const snapshot = await handle.refresh().catch(() => null);
          if (!snapshot || snapshot.agent.archivedAt) return;
          const previous = accountIdFromMetadata(snapshot.agent.metadata);
          if (previous === target) return;
          pending.beginManual(agent.id);
          try {
            await handle.setMetadata({ [ACCOUNT_METADATA_KEY]: target });
            try {
              await handle.reload();
            } catch (reloadError) {
              await handle.setMetadata({ [ACCOUNT_METADATA_KEY]: previous }).catch(() => undefined);
              await handle.reload().catch(() => undefined);
              throw reloadError;
            }
          } catch (error) {
            console.error(`dsh-paseo/antigravity: deferred switch of ${agent.id} failed`, error);
          } finally {
            pending.endManual(agent.id);
          }
        });
      } finally {
        // Refresh timestamp on exit so a slow reload never expires the turnId-less fallback window
        // before the next serial `agent.turn.after` handler runs.
        pending.markDeferredTurn(agent.id, turnId);
        pending.endDeferred(agent.id);
      }
    }),
  );

  removers.push(
    server.addHook("agent.archive.after", async ({ agent }, ctx) => {
      observers?.onContext?.(ctx);
      pending.delete(agent.id);
      pending.clearDeferredTurn(agent.id);
      observers?.onAgentArchived?.(agent.id);
    }),
  );

  return removers;
}
