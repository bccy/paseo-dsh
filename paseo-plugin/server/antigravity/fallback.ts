import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  ACCOUNT_METADATA_KEY,
  FALLBACK_TIMELINE_KIND,
  SYSTEM_ACCOUNT_ID,
  accountIdFromMetadata,
  isAntigravityProvider,
  quotaPoolForModel,
  type AccountCooldown,
  type AccountSummary,
  type FallbackEvent,
  type FallbackStrategy,
  type QuotaGroup,
  type QuotaPool,
} from "../../shared/antigravity/contracts";
import type { AccountService } from "./accounts";
import { switchAgentAccount, type PendingSwitches } from "./hooks";
import type { PaseoApi } from "./types";

export type FailureKind = FallbackEvent["reason"];

/** The prompt that resumes an agent after a retry or an account switch; the conversation carries the task. */
const RESUME_PROMPT = "Continue.";

const QUOTA = /resource.?exhausted|\b429\b|quota|usage limit|rate.?limit|limit (reached|exceeded)|exhausted|too many requests/i;
const AUTH = /authenticat|sign.?in|log.?in|unauthori[sz]ed|\b401\b|\b403\b|permission.?denied|invalid.?grant|credentials/i;
const TRANSIENT =
  /\b5\d\d\b|unavailable|deadline|timed? ?out|timeout|econn|etimedout|socket|network|overloaded|capacity|internal|temporar|did not initialize|exited/i;

export function classify(message: string, code?: string): FailureKind {
  const text = `${code ?? ""} ${message}`;
  if (QUOTA.test(text)) return "quota";
  if (AUTH.test(text)) return "auth";
  if (TRANSIENT.test(text)) return "transient";
  return "error";
}

interface Chain {
  /** Retries spent on the current account. */
  attempts: number;
  /** Accounts this failure chain already ran on. */
  tried: Set<string>;
}

interface CooldownEntry {
  until: number;
  reason: FailureKind;
}

interface AccountCooldownState {
  all?: CooldownEntry;
  gemini?: CooldownEntry;
  "third-party"?: CooldownEntry;
}

export interface ModelSupport {
  supportsModel(accountId: string, model: string | null | undefined): boolean | null;
}

/** Picks the QuotaGroup matching a model pool (`gemini` vs `third-party`). */
export function groupForPool(
  groups: readonly QuotaGroup[] | null,
  pool: "gemini" | "third-party",
): QuotaGroup | null {
  if (!groups?.length) return null;
  if (pool === "third-party") {
    return (
      groups.find((group) => /claude|gpt|3p|third/i.test(group.name)) ??
      groups.find((group) => !/gemini/i.test(group.name)) ??
      null
    );
  }
  return groups.find((group) => /gemini/i.test(group.name) && !/argon/i.test(group.name)) ?? groups[0] ?? null;
}

/** Earliest reset among exhausted buckets in the target pool, else null. */
export function resetOfExhausted(
  groups: readonly QuotaGroup[] | null,
  pool: "gemini" | "third-party",
): number | null {
  const group = groupForPool(groups, pool);
  let earliest: number | null = null;
  for (const bucket of group?.buckets ?? []) {
    if (bucket.disabled || bucket.remainingFraction === null || bucket.remainingFraction > 0.001) continue;
    const at = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
    if (Number.isFinite(at) && (earliest === null || at < earliest)) earliest = at;
  }
  return earliest;
}

/** True when a known quota says the account cannot serve the next request for `pool`. */
export function exhausted(
  groups: readonly QuotaGroup[] | null,
  pool: "gemini" | "third-party",
): boolean {
  const group = groupForPool(groups, pool);
  return (group?.buckets ?? []).some(
    (bucket) => !bucket.disabled && bucket.remainingFraction !== null && bucket.remainingFraction <= 0.001,
  );
}

/** Minimum remaining fraction (0..1) across active buckets of `pool`, or -1 when unknown. */
function poolRemainingScore(groups: readonly QuotaGroup[] | null, pool: "gemini" | "third-party"): number {
  const group = groupForPool(groups, pool);
  const fractions = (group?.buckets ?? [])
    .filter((bucket) => !bucket.disabled && bucket.remainingFraction !== null)
    .map((bucket) => bucket.remainingFraction!);
  if (!fractions.length) return -1;
  return Math.min(...fractions);
}

/** Earliest reset timestamp among active non-empty buckets of `pool`, or Infinity when unknown. */
function poolSoonestReset(groups: readonly QuotaGroup[] | null, pool: "gemini" | "third-party"): number {
  const group = groupForPool(groups, pool);
  let soonest = Infinity;
  for (const bucket of group?.buckets ?? []) {
    if (bucket.disabled || !bucket.resetTime) continue;
    const at = Date.parse(bucket.resetTime);
    if (Number.isFinite(at) && at < soonest) soonest = at;
  }
  return soonest;
}

export class FallbackController {
  private readonly chains = new Map<string, Chain>();
  /** Account id → active cooldowns (whole account or per quota pool). */
  private readonly cooldowns = new Map<string, AccountCooldownState>();
  /** Per-agent pending retry timer, canceled when a new turn starts or completes. */
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly redirectTimers = new Set<NodeJS.Timeout>();
  private noteSeq = 0;

  constructor(
    private readonly service: AccountService,
    private readonly pending: PendingSwitches,
    private readonly models?: ModelSupport,
  ) {
    this.service.setCooldownProvider((accountId) => this.cooldownsOf(accountId));
  }

  /** Active (non-expired) cooldown entries for an account. */
  cooldownsOf(accountId: string): AccountCooldown[] {
    const entry = this.cooldowns.get(accountId);
    if (!entry) return [];
    const now = Date.now();
    const active: AccountCooldown[] = [];
    for (const pool of ["all", "gemini", "third-party"] as const) {
      const item = entry[pool];
      if (!item) continue;
      if (item.until <= now) {
        delete entry[pool];
        continue;
      }
      active.push({ pool, reason: item.reason, until: new Date(item.until).toISOString() });
    }
    if (!entry.all && !entry.gemini && !entry["third-party"]) this.cooldowns.delete(accountId);
    return active;
  }

  private activeCooldown(accountId: string, pool: "gemini" | "third-party"): CooldownEntry | null {
    const entry = this.cooldowns.get(accountId);
    if (!entry) return null;
    const now = Date.now();
    if (entry.all) {
      if (entry.all.until > now) return entry.all;
      delete entry.all;
    }
    const pooled = entry[pool];
    if (pooled) {
      if (pooled.until > now) return pooled;
      delete entry[pool];
    }
    if (!entry.all && !entry.gemini && !entry["third-party"]) this.cooldowns.delete(accountId);
    return null;
  }

  private setCooldown(accountId: string, pool: QuotaPool, until: number, reason: FailureKind): void {
    const entry = this.cooldowns.get(accountId) ?? {};
    entry[pool] = { until, reason };
    this.cooldowns.set(accountId, entry);
    this.service.notifyChange();
  }

  /** Clears active cooldowns for one account (or all accounts when omitted). */
  clearCooldown(accountId?: string): boolean {
    if (!accountId) {
      if (this.cooldowns.size === 0) return false;
      this.cooldowns.clear();
      this.service.notifyChange();
      return true;
    }
    const removed = this.cooldowns.delete(accountId);
    if (removed) this.service.notifyChange();
    return removed;
  }

  /** Automatically clears cooldowns that fresh account status proves have resolved. */
  reconcileStatus(accountId: string, status: AccountSummary["status"], quota: QuotaGroup[] | null): void {
    const entry = this.cooldowns.get(accountId);
    if (!entry || status !== "signed-in") return;
    let changed = false;
    if (entry.all?.reason === "auth") {
      delete entry.all;
      changed = true;
    }
    for (const pool of ["gemini", "third-party"] as const) {
      if (entry[pool]?.reason === "quota" && !exhausted(quota, pool) && poolRemainingScore(quota, pool) > 0.01) {
        delete entry[pool];
        changed = true;
      }
    }
    if (!entry.all && !entry.gemini && !entry["third-party"]) this.cooldowns.delete(accountId);
    if (changed) this.service.notifyChange();
  }

  private cancelRetry(agentId: string): void {
    const timer = this.retryTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(agentId);
    }
  }

  register(
    server: PluginServerContext,
    options?: { onContext?: (ctx: PluginHandlerContext) => void },
  ): () => void {
    const removers = [
      this.service.onStatusUpdated(({ accountId, status, quota }) => {
        this.reconcileStatus(accountId, status, quota);
      }),
      server.addHook("agent.turn.before", async ({ agent }, ctx) => {
        options?.onContext?.(ctx);
        if (!isAntigravityProvider(agent.provider)) return;
        this.cancelRetry(agent.id);
      }),
      server.addHook("agent.archive.after", async ({ agent }, ctx) => {
        options?.onContext?.(ctx);
        this.cancelRetry(agent.id);
        this.chains.delete(agent.id);
      }),
      server.addHook("agent.turn.after", async ({ agent, outcome }, ctx) => {
        options?.onContext?.(ctx);
        const { paseo } = ctx;
        if (!isAntigravityProvider(agent.provider)) return;
        this.cancelRetry(agent.id);
        if (outcome.kind !== "failed") {
          // A finished or canceled turn ends the chain; the user decides what happens next.
          this.chains.delete(agent.id);
          return;
        }
        await this.service.init();
        const settings = this.service.fallbackSettings();
        if (!settings.enabled) return;
        try {
          const snapshot = await paseo.agents
            .ref(agent.id)
            .refresh()
            .catch(() => null);
          const model = snapshot?.agent.model ?? null;
          await this.handleFailure(
            paseo,
            agent.id,
            accountIdFromMetadata(agent.metadata),
            model,
            outcome.error,
            settings.retries,
            settings.strategy,
          );
        } catch (error) {
          console.error(`dsh-paseo/antigravity: fallback for ${agent.id} failed`, error);
        }
      }),
    ];
    return () => {
      for (const remove of removers) remove();
    };
  }

  private async handleFailure(
    paseo: PaseoApi,
    agentId: string,
    current: string,
    model: string | null,
    error: { message: string; code?: string },
    retries: number,
    strategy: FallbackStrategy,
  ): Promise<void> {
    const reason = classify(error.message, error.code);
    const pool = quotaPoolForModel(model);
    const chain = this.chains.get(agentId) ?? { attempts: 0, tried: new Set<string>() };
    this.chains.set(agentId, chain);
    chain.tried.add(current);
    const fromLabel = this.service.labelOf(current);
    const message = error.message.slice(0, 400);
    // The failure may have changed the quota; the sidebar and the next choice should see it.
    await this.service.refreshOne(current).catch(() => undefined);

    if ((reason === "transient" || reason === "error") && chain.attempts < retries) {
      chain.attempts += 1;
      const attempt = chain.attempts;
      await this.note(paseo, agentId, { event: "retry", reason, from: fromLabel, to: null, attempt, retries, message });
      this.scheduleRetry(agentId, attempt * 5000, () => this.resume(paseo, agentId));
      return;
    }

    const cooldownPool: QuotaPool = reason === "auth" ? "all" : pool;
    const until =
      reason === "quota"
        ? (resetOfExhausted(this.service.knownQuota(current), pool) ?? Date.now() + 30 * 60_000)
        : reason === "auth"
          ? Date.now() + 6 * 3_600_000
          : Date.now() + 10 * 60_000;
    this.setCooldown(current, cooldownPool, until, reason);

    // Keep trying candidates when one fails to open (e.g. an account that lacks the agent's model).
    for (;;) {
      const next = await this.pickNext(current, chain.tried, model, strategy);
      if (!next) {
        this.chains.delete(agentId);
        await this.note(paseo, agentId, {
          event: "exhausted",
          reason,
          from: fromLabel,
          to: null,
          attempt: chain.attempts,
          retries,
          message,
        });
        return;
      }
      chain.tried.add(next);
      try {
        await switchAgentAccount(paseo, this.service, this.pending, { agentId, accountId: next, when: "now" });
      } catch (switchError) {
        console.warn(
          `dsh-paseo/antigravity: fallback candidate ${next} could not take ${agentId}:`,
          switchError instanceof Error ? switchError.message : String(switchError),
        );
        continue;
      }
      chain.attempts = 0;
      await this.note(paseo, agentId, {
        event: "switch",
        reason,
        from: fromLabel,
        to: this.service.labelOf(next),
        attempt: 0,
        retries,
        message,
      });
      await this.resume(paseo, agentId);
      return;
    }
  }

  /**
   * The next account after `current` that can take work for `model`, respecting `fallbackEnabled`,
   * cooldowns for the model's quota pool, model support, and the configured selection strategy.
   */
  async pickNext(
    current: string,
    tried: ReadonlySet<string>,
    model?: string | null,
    strategy: FallbackStrategy = this.service.fallbackSettings().strategy,
  ): Promise<string | null> {
    const pool = quotaPoolForModel(model);
    const state = await this.service.state();
    const ids = state.accounts.map((account) => account.id);
    const start = Math.max(0, ids.indexOf(current));
    const ordered: AccountSummary[] = [];
    for (let step = 1; step < ids.length; step += 1) {
      const id = ids[(start + step) % ids.length]!;
      const account = state.accounts.find((entry) => entry.id === id);
      if (account) ordered.push(account);
    }

    const candidates: Array<{ id: string; orderIndex: number; score: number; soonestReset: number }> = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const account = ordered[index]!;
      const id = account.id;
      if (tried.has(id)) continue;
      if (!account.fallbackEnabled) continue;
      if (this.activeCooldown(id, pool)) continue;
      if (!account.usable || account.status === "signed-out") continue;
      if (this.models?.supportsModel(id, model) === false) continue;
      if (id !== SYSTEM_ACCOUNT_ID && account.status === "unknown") {
        // Never checked: look once before sending work there.
        await this.service.refreshOne(id).catch(() => undefined);
      }
      const known = this.service.knownQuota(id);
      if (exhausted(known, pool)) continue;
      const fresh = (await this.service.state()).accounts.find((entry) => entry.id === id);
      if (!fresh || fresh.status === "signed-out" || !fresh.usable || !fresh.fallbackEnabled) continue;
      if (this.models?.supportsModel(id, model) === false) continue;
      candidates.push({
        id,
        orderIndex: index,
        score: poolRemainingScore(known, pool),
        soonestReset: poolSoonestReset(known, pool),
      });
    }

    if (!candidates.length) return null;
    if (strategy === "quota") {
      candidates.sort((a, b) => b.score - a.score || a.orderIndex - b.orderIndex);
    } else if (strategy === "reset") {
      candidates.sort((a, b) => a.soonestReset - b.soonestReset || b.score - a.score || a.orderIndex - b.orderIndex);
    }
    return candidates[0]!.id;
  }

  /**
   * Why an account cannot take a session right now, or null. Uses only what is already known:
   * a missing sign-in file, a signed-out or unsafe account, an exhausted quota, or a cooldown.
   */
  async healthOf(accountId: string, model?: string | null): Promise<FailureKind | null> {
    const pool = quotaPoolForModel(model);
    const cooling = this.activeCooldown(accountId, pool);
    if (cooling) return cooling.reason;
    const state = await this.service.state();
    const account = state.accounts.find((entry) => entry.id === accountId);
    if (!account || !account.usable || account.status === "signed-out") return "auth";
    if (account.kind === "profile" && !(await this.service.hasSignInFile(accountId))) return "auth";
    if (exhausted(this.service.knownQuota(accountId), pool)) return "quota";
    return null;
  }

  /**
   * Called while an agent's session opens on an account that cannot take it. Returns the account to
   * open on instead and, once the open is over, records the change on the agent and in its timeline.
   */
  async redirectForOpen(
    paseo: PaseoApi,
    agentId: string,
    accountId: string,
    reason: FailureKind,
    record: boolean,
    model?: string | null,
  ): Promise<string | null> {
    const next = await this.pickNext(accountId, new Set([accountId]), model);
    if (!next || !record) return next;
    const from = this.service.labelOf(accountId);
    const to = this.service.labelOf(next);
    // The open waits for this hook; touching the agent before it returns could deadlock.
    this.laterRedirect(1500, async () => {
      const handle = paseo.agents.ref(agentId);
      const snapshot = await handle.refresh().catch(() => null);
      if (!snapshot || snapshot.agent.archivedAt) return;
      // Only commit the redirect if the user did not manually switch the agent meanwhile.
      if (accountIdFromMetadata(snapshot.agent.metadata) !== accountId) return;
      await handle.setMetadata({ [ACCOUNT_METADATA_KEY]: next });
      await this.note(paseo, agentId, {
        event: "switch",
        reason,
        from,
        to,
        attempt: 0,
        retries: this.service.fallbackSettings().retries,
        message: "",
      });
    });
    return next;
  }

  /** Sends the resume prompt unless the agent is already busy, archived, or fallback was turned off. */
  private async resume(paseo: PaseoApi, agentId: string): Promise<void> {
    if (!this.service.fallbackSettings().enabled) {
      this.chains.delete(agentId);
      return;
    }
    const handle = paseo.agents.ref(agentId);
    const snapshot = await handle.refresh().catch(() => null);
    if (!snapshot || snapshot.agent.archivedAt) {
      this.chains.delete(agentId);
      return;
    }
    if (snapshot.agent.status === "running" || snapshot.agent.status === "initializing") return;
    await handle.send(RESUME_PROMPT);
  }

  private async note(paseo: PaseoApi, agentId: string, event: FallbackEvent): Promise<void> {
    await paseo.agents
      .ref(agentId)
      .timeline.append({
        type: "plugin",
        id: `fallback-${Date.now()}-${++this.noteSeq}`,
        kind: FALLBACK_TIMELINE_KIND,
        version: 1,
        data: event,
      })
      .catch((error: unknown) => console.error("dsh-paseo/antigravity: could not add the fallback note", error));
  }

  private scheduleRetry(agentId: string, ms: number, task: () => Promise<void>): void {
    this.cancelRetry(agentId);
    const timer = setTimeout(() => {
      this.retryTimers.delete(agentId);
      void task().catch((error: unknown) => console.error("dsh-paseo/antigravity: retry failed", error));
    }, ms);
    this.retryTimers.set(agentId, timer);
  }

  private laterRedirect(ms: number, task: () => Promise<void>): void {
    const timer = setTimeout(() => {
      this.redirectTimers.delete(timer);
      void task().catch((error: unknown) => console.error("dsh-paseo/antigravity: redirect record failed", error));
    }, ms);
    this.redirectTimers.add(timer);
  }

  dispose(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const timer of this.redirectTimers) clearTimeout(timer);
    this.redirectTimers.clear();
    this.chains.clear();
  }
}
