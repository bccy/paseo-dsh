import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelSignInRpc,
  clearCooldownRpc,
  createAccountRpc,
  getOrchestratorRpc,
  listAccountsRpc,
  listSubagentsRpc,
  migrateAccountAgentsRpc,
  moveAccountRpc,
  recoverSavedFilesRpc,
  refreshAccountsRpc,
  removeAccountRpc,
  renameAccountRpc,
  savedFilesRpc,
  setAccountOptionsRpc,
  setDefaultAccountRpc,
  setFallbackRpc,
  setOrchestratorRpc,
  signOutAccountRpc,
  startSignInRpc,
  subagentArtifactRpc,
  subagentCountsRpc,
  subagentDetailRpc,
  submitSignInRpc,
  switchAgentAccountRpc,
  watchAccountsSubscription,
} from "../../shared/antigravity/contracts";
import { AccountService } from "./accounts";
import { ContextReader } from "./context";
import { FallbackController } from "./fallback";
import { PendingSwitches, migrateAccountAgents, registerHooks, switchAgentAccount } from "./hooks";
import { OrchestratorSettings } from "./orchestrator";
import {
  detectAntigravityPresence,
  legacyPricingFile,
  migrateLegacyDataDir,
  shouldRegisterAntigravityOpenHookSync,
  type AntigravityPresence,
} from "./paths";
import { UsageStatsReader } from "./stats";
import { SubagentReader } from "./subagents";
import { createUsageSource } from "./usage";

export interface RegisterAntigravityServerOptions {
  /** Optional callback invoked with each hook/RPC handler context (e.g. to capture PaseoApi). */
  onContext?: (ctx: PluginHandlerContext) => void;
  /** Optional override for `agent.open.before` hook gating (defaults to `shouldRegisterAntigravityOpenHookSync()`). */
  registerOpenBefore?: boolean;
  /** Optional override for Antigravity presence detection (defaults to `detectAntigravityPresence`). */
  detectPresence?: () => Promise<AntigravityPresence>;
}

export interface AntigravityServerHandle {
  dispose: () => void;
  stats: UsageStatsReader;
  service: AccountService;
  detectPresence: () => Promise<AntigravityPresence>;
  legacyPricingPath: string;
  openHookRegistered: boolean;
}

export function registerAntigravityServer(
  server: PluginServerContext,
  opts: RegisterAntigravityServerOptions = {},
): AntigravityServerHandle {
  const onContext = opts.onContext;
  const service = new AccountService();
  const pending = new PendingSwitches();
  const context = new ContextReader();
  const stats = new UsageStatsReader({
    getAccountLabels: () => service.accountLabels(),
  });
  const subagents = new SubagentReader(context);
  const orchestrator = new OrchestratorSettings(service);
  const detectPresence = opts.detectPresence ?? (() => detectAntigravityPresence());
  const registerOpenBefore = opts.registerOpenBefore ?? shouldRegisterAntigravityOpenHookSync();

  // Run one-time legacy data dir migration before reading accounts.json or status.json.
  const ready = migrateLegacyDataDir()
    .catch((error: unknown) => {
      console.error("dsh-paseo/antigravity: legacy data directory migration failed", error);
    })
    .then(() => service.init());

  let disposed = false;
  let warmup: NodeJS.Timeout | null = null;
  let quotaTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;

  const fallback = new FallbackController(service, pending, orchestrator);
  const removers: Array<() => void> = [];

  const dispose = () => {
    disposed = true;
    if (warmup) clearTimeout(warmup);
    if (quotaTimer) clearInterval(quotaTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    warmup = null;
    quotaTimer = null;
    sweepTimer = null;
    for (const remove of removers) remove();
    removers.length = 0;
    fallback.dispose();
    stats.dispose();
    service.dispose();
  };

  try {
    removers.push(
      ...registerHooks(server, service, pending, fallback, {
        registerOpenBefore,
        onContext,
        onConversationAccount: (conversationId, accountId) => stats.recordConversationAccount(conversationId, accountId),
        onAgentArchived: (agentId) => {
          context.forget(agentId);
          subagents.forget(agentId);
        },
      }),
    );
    removers.push(fallback.register(server, { onContext }));
    removers.push(...orchestrator.register(server, { onContext }));
    if (typeof server.registerUsageSource === "function") {
      server.registerUsageSource(createUsageSource(service));
    }

    server.handle(listAccountsRpc, async ({ refresh }, ctx) => {
      onContext?.(ctx);
      await ready;
      if (refresh) await service.refreshAll({ forcePlan: true });
      return service.state();
    });

    server.handle(refreshAccountsRpc, async ({ accountId }, ctx) => {
      onContext?.(ctx);
      await ready;
      if (accountId) {
        service.requireAccount(accountId);
        await service.refreshOne(accountId, { forcePlan: true });
        orchestrator.invalidateAccount(accountId);
      } else {
        await service.refreshAll({ forcePlan: true });
      }
      return service.state();
    });

    server.handle(createAccountRpc, async ({ label }, ctx) => {
      onContext?.(ctx);
      await ready;
      const account = await service.create(label);
      return { account, state: await service.state() };
    });

    server.handle(renameAccountRpc, async ({ accountId, label }, ctx) => {
      onContext?.(ctx);
      await ready;
      await service.rename(accountId, label);
      return service.state();
    });

    server.handle(moveAccountRpc, async ({ accountId, direction }, ctx) => {
      onContext?.(ctx);
      await ready;
      await service.move(accountId, direction);
      return service.state();
    });

    server.handle(setAccountOptionsRpc, async ({ accountId, fallbackEnabled, orchestratorOverride }, ctx) => {
      onContext?.(ctx);
      await ready;
      await service.setAccountOptions(accountId, { fallbackEnabled, orchestratorOverride });
      return service.state();
    });

    server.handle(clearCooldownRpc, async ({ accountId }, ctx) => {
      onContext?.(ctx);
      await ready;
      if (accountId) service.requireAccount(accountId);
      fallback.clearCooldown(accountId);
      return service.state();
    });

    server.handle(setFallbackRpc, async (patch, ctx) => {
      onContext?.(ctx);
      await ready;
      await service.setFallback(patch);
      return service.state();
    });

    server.handle(setDefaultAccountRpc, async ({ accountId }, ctx) => {
      onContext?.(ctx);
      await ready;
      await service.setDefault(accountId);
      return service.state();
    });

    server.handle(savedFilesRpc, async ({ accountId }, ctx) => {
      onContext?.(ctx);
      await ready;
      return service.savedFiles(accountId);
    });

    server.handle(recoverSavedFilesRpc, async ({ accountId }, ctx) => {
      onContext?.(ctx);
      await ready;
      const moved = await service.recoverSavedFiles(accountId);
      return { moved };
    });

    server.handle(removeAccountRpc, async ({ accountId }, ctx) => {
      onContext?.(ctx);
      await ready;
      fallback.clearCooldown(accountId);
      orchestrator.invalidateAccount(accountId);
      const moved = await service.remove(accountId);
      return { state: await service.state(), moved };
    });

    server.handle(signOutAccountRpc, async ({ accountId }, ctx) => {
      onContext?.(ctx);
      await ready;
      fallback.clearCooldown(accountId);
      orchestrator.invalidateAccount(accountId);
      await service.signOut(accountId);
      return service.state();
    });

    server.handle(startSignInRpc, async ({ accountId }, ctx) => {
      onContext?.(ctx);
      await ready;
      return service.startSignIn(accountId);
    });

    server.handle(submitSignInRpc, async ({ loginId, code }, ctx) => {
      onContext?.(ctx);
      await ready;
      const accountId = service.signIns.accountOf(loginId);
      await service.submitSignIn(loginId, code);
      if (accountId) {
        fallback.clearCooldown(accountId);
        orchestrator.invalidateAccount(accountId);
      }
      return service.state();
    });

    server.handle(cancelSignInRpc, async ({ loginId }, ctx) => {
      onContext?.(ctx);
      service.cancelSignIn(loginId);
      return {};
    });

    server.handle(switchAgentAccountRpc, async (input, ctx) => {
      onContext?.(ctx);
      await ready;
      fallback.clearCooldown(input.accountId);
      return switchAgentAccount(ctx.paseo, service, pending, { ...input, manual: true });
    });

    server.handle(migrateAccountAgentsRpc, async (input, ctx) => {
      onContext?.(ctx);
      await ready;
      fallback.clearCooldown(input.toAccountId);
      return migrateAccountAgents(ctx.paseo, service, pending, input);
    });

    server.handle(listSubagentsRpc, async ({ agentId }, ctx) => {
      onContext?.(ctx);
      return subagents.list(ctx.paseo, agentId);
    });

    server.handle(subagentCountsRpc, async ({ agentIds }, ctx) => {
      onContext?.(ctx);
      return { counts: await subagents.counts(ctx.paseo, agentIds) };
    });

    server.handle(subagentDetailRpc, async ({ agentId, subagentId }, ctx) => {
      onContext?.(ctx);
      return subagents.detail(ctx.paseo, agentId, subagentId);
    });

    server.handle(subagentArtifactRpc, async ({ agentId, subagentId, path: artifactPath }, ctx) => {
      onContext?.(ctx);
      return subagents.artifact(ctx.paseo, agentId, subagentId, artifactPath);
    });

    server.handle(getOrchestratorRpc, async ({ refresh }, ctx) => {
      onContext?.(ctx);
      await ready;
      return orchestrator.state(refresh ?? false);
    });

    server.handle(setOrchestratorRpc, async ({ planner, executor, accountId, inheritGlobal, applyTo }, ctx) => {
      onContext?.(ctx);
      await ready;
      const state = await orchestrator.save({ planner, executor, accountId, inheritGlobal });
      const applied = applyTo ? await orchestrator.apply(ctx.paseo, applyTo) : "none";
      return { state, applied };
    });

    // Must return synchronously: a returned promise closes the subscription when it settles.
    server.handle(watchAccountsSubscription, (_input, ctx) => {
      onContext?.(ctx);
      const { push, signal } = ctx;
      const stop = service.onChange((revision) => {
        void push({ revision }).catch(() => undefined);
      });
      signal.addEventListener("abort", stop, { once: true });
      void ready.then(() => push({ revision: service.currentRevision() })).catch(() => undefined);
    });
  } catch (error) {
    dispose();
    throw error;
  }

  // Only start background agy quota polling AFTER synchronous registrations succeed AND
  // when agy is installed or profile accounts exist, so pure-DSH machines spawn zero `agy`
  // processes and short-lived harness scripts exit cleanly without leaking active timers.
  void ready
    .then(() => detectPresence())
    .then((presence) => {
      if (disposed || (!presence.agyInstalled && !presence.hasAntigravityAccounts)) return;
      warmup = setTimeout(() => {
        if (disposed) return;
        void ready.then(() => service.refreshAll()).catch((error: unknown) => {
          console.error("dsh-paseo/antigravity: initial refresh failed", error);
        });
      }, 3000);
      warmup.unref?.();
      quotaTimer = setInterval(() => {
        if (disposed) return;
        void ready
          .then(async () => {
            const state = await service.state();
            await service.refreshOne(state.defaultAccountId);
          })
          .catch(() => undefined);
      }, 3 * 60_000);
      quotaTimer.unref?.();
      sweepTimer = setInterval(() => {
        if (disposed) return;
        void ready.then(() => service.refreshAll()).catch(() => undefined);
      }, 15 * 60_000);
      sweepTimer.unref?.();
    })
    .catch(() => undefined);

  return {
    dispose,
    stats,
    service,
    detectPresence,
    legacyPricingPath: legacyPricingFile(),
    openHookRegistered: registerOpenBefore,
  };
}

export * from "./paths";
export * from "./stats";
export { AccountService } from "./accounts";
export { ContextReader, conversationIdFrom } from "./context";
export { FallbackController } from "./fallback";
export { PendingSwitches, registerHooks, switchAgentAccount, migrateAccountAgents } from "./hooks";
export { OrchestratorSettings } from "./orchestrator";
export { SubagentReader } from "./subagents";
export { createUsageSource, quotaWindows } from "./usage";
