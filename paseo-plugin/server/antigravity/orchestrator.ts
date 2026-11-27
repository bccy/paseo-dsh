import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  SYSTEM_ACCOUNT_ID,
  isAntigravityProvider,
  type ModelFamily,
  type OrchestratorChoice,
  type OrchestratorState,
} from "../../shared/antigravity/contracts";
import type { AccountService } from "./accounts";
import { NEEDS_SIGN_IN, commandEnv, runAgy } from "./agy";
import { REAL_CLI_DIR, REAL_SETTINGS_FILE, paseoHome, profileHome, resolveAgy } from "./paths";
import type { PaseoApi } from "./types";

/**
 * agy 1.5.14 runs its Orchestrator models as a planner that hands the plan to an executor. Which
 * models play those roles comes from `"orchestrator": { "planner", "executor" }` in agy's
 * settings.json (values are model labels such as `Gemini 4 Carbon (High)`), not from the
 * Orchestrator model's own name. A planner the account cannot run falls back to agy's default.
 */
const SETTINGS_FILE = REAL_SETTINGS_FILE;

/** Model families agy accepts in each role (agy's built-in `orchestrator-model-roles`). */
const PLANNER_FAMILIES = ["gemini-4-neon", "gemini-4-carbon", "gemini-4-argon", "claude-opus-5-5"];
const EXECUTOR_FAMILIES = ["gemini-4-hydrogen", "claude-sonnet-5-5"];

const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;
const MODEL_EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/;
const LABEL_EFFORT = /^(.*?)\s*\(([^()]+)\)\s*$/;
const CATALOG_TTL_MS = 10 * 60_000;

interface CatalogModel {
  id: string;
  label: string;
}

interface Catalog {
  models: CatalogModel[];
  fetchedAt: number;
  /** The sign-in the list belongs to; another Google account on the same profile lists anew. */
  identity: string;
}

/** After a failed `agy models`, wait this long before trying the account again. */
const FAILURE_BACKOFF_MS = 2 * 60_000;

type SettingsJson = Record<string, unknown> & { orchestrator?: Record<string, unknown> };

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readSettingsJson(): Promise<SettingsJson> {
  let raw: string;
  try {
    raw = await fs.readFile(SETTINGS_FILE, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw error;
  }
  const text = stripBom(raw).trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SETTINGS_FILE} does not hold a JSON object`);
  }
  return parsed as SettingsJson;
}

function orchestratorOf(settings: SettingsJson): Record<string, unknown> {
  const value = settings.orchestrator;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function savedRole(settings: SettingsJson, role: "planner" | "executor"): string | null {
  const value = orchestratorOf(settings)[role];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Model ids the user kept in Paseo's own Antigravity model list, when they curated one. */
async function curatedModelIds(): Promise<Set<string> | null> {
  try {
    const raw = await fs.readFile(path.join(paseoHome(), "config.json"), "utf8");
    const config = JSON.parse(raw) as {
      agents?: { providers?: Record<string, { models?: Array<{ id?: unknown }> }> };
    };
    const models = config.agents?.providers?.antigravity?.models;
    if (!Array.isArray(models)) return null;
    return new Set(models.map((model) => (typeof model?.id === "string" ? model.id : "")).filter(Boolean));
  } catch {
    return null;
  }
}

function parseCatalog(output: string): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [id, label, ...extra] = line.split("\t");
    if (!id || !label || extra.length > 0 || /\s/.test(id)) continue;
    models.push({ id: id.trim(), label: label.trim() });
  }
  return models;
}

function familiesFor(
  allowed: readonly string[],
  catalogs: ReadonlyMap<string, CatalogModel[]>,
  curated: ReadonlySet<string> | null,
): ModelFamily[] {
  const families = new Map<string, ModelFamily>();
  for (const [accountId, models] of catalogs) {
    for (const model of models) {
      const familyId = model.id.replace(EFFORT_SUFFIX, "");
      if (familyId === model.id || !allowed.includes(familyId)) continue;
      const match = LABEL_EFFORT.exec(model.label);
      const familyLabel = match?.[1] ?? model.label;
      const effort = match?.[2] ?? "";
      let family = families.get(familyId);
      if (!family) {
        family = { id: familyId, label: familyLabel, variants: [], accounts: [] };
        families.set(familyId, family);
      }
      if (!family.accounts.includes(accountId)) family.accounts.push(accountId);
      if (!family.variants.some((variant) => variant.id === model.id)) {
        family.variants.push({ id: model.id, label: model.label, effort });
      }
    }
  }
  const order = ["low", "medium", "high", "xhigh", "max"];
  const rank = (id: string) => order.indexOf(EFFORT_SUFFIX.exec(id)?.[1] ?? "");
  const available = allowed
    .map((id) => families.get(id))
    .filter((family): family is ModelFamily => Boolean(family))
    .map((family) => ({ ...family, variants: family.variants.sort((a, b) => rank(a.id) - rank(b.id)) }));
  // A family the user removed from Paseo's model list stays out of these choices too, unless that
  // list names none of them (then it says nothing about planners and executors).
  const kept = curated ? available.filter((family) => family.variants.some((variant) => curated.has(variant.id))) : available;
  return kept.length ? kept : available;
}

export class OrchestratorSettings {
  private readonly catalogs = new Map<string, Catalog>();
  private readonly fetching = new Map<string, Promise<CatalogModel[] | null>>();
  private readonly failures = new Map<string, number>();
  private readonly pendingReloads = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private writing: Promise<unknown> = Promise.resolve();
  private writeSeq = 0;

  constructor(private readonly service: AccountService) {}

  invalidateAccount(accountId: string): void {
    this.catalogs.delete(accountId);
    this.failures.delete(accountId);
  }

  /**
   * Whether `accountId` is known to support `model`. Returns `null` when the account's model
   * catalog has not been fetched yet so callers do not falsely block an unchecked account.
   */
  supportsModel(accountId: string, model: string | null | undefined): boolean | null {
    if (!model) return null;
    const cached = this.catalogs.get(accountId);
    if (!cached) return null;
    const normalized = model.trim().toLowerCase().replace(/^antigravity\//, "");
    const stripped = normalized.replace(MODEL_EFFORT_SUFFIX, "");
    return cached.models.some((entry) => {
      const entryId = entry.id.toLowerCase();
      const entryLabel = entry.label.toLowerCase();
      if (entryId === normalized || entryLabel === normalized) return true;
      // Paseo stores base model ids (e.g. "gemini-4-neon") separately from thinkingOptionId,
      // while `agy models` lists effort-suffixed variants (e.g. "gemini-4-neon-high").
      if (normalized === stripped && entryId.replace(MODEL_EFFORT_SUFFIX, "") === normalized) return true;
      return false;
    });
  }

  private catalog(accountId: string, identity: string, refresh: boolean): Promise<CatalogModel[] | null> {
    const cached = this.catalogs.get(accountId);
    const usable = cached && cached.identity === identity ? cached : undefined;
    if (usable && !refresh && Date.now() - usable.fetchedAt < CATALOG_TTL_MS) return Promise.resolve(usable.models);
    if (!refresh && Date.now() - (this.failures.get(accountId) ?? 0) < FAILURE_BACKOFF_MS) {
      return Promise.resolve(usable?.models ?? null);
    }
    const inflight = this.fetching.get(accountId);
    if (inflight) return inflight;
    const task = (async () => {
      const agy = await resolveAgy();
      if (!agy) throw new Error("Antigravity CLI (agy) was not found.");
      if (accountId !== SYSTEM_ACCOUNT_ID) await this.service.ensureAccountProfile(accountId);
      const result = await runAgy(agy, ["models"], {
        env: commandEnv(accountId),
        cwd: accountId === SYSTEM_ACCOUNT_ID ? os.tmpdir() : profileHome(accountId),
        timeoutMs: 30_000,
        stopWhen: NEEDS_SIGN_IN,
      });
      const models = result.code === 0 && !result.timedOut && !result.stopped ? parseCatalog(result.stdout) : [];
      if (!models.length) {
        this.failures.set(accountId, Date.now());
        return usable?.models ?? null;
      }
      this.failures.delete(accountId);
      this.catalogs.set(accountId, { models, fetchedAt: Date.now(), identity });
      return models;
    })().finally(() => {
      if (this.fetching.get(accountId) === task) this.fetching.delete(accountId);
    });
    this.fetching.set(accountId, task);
    return task;
  }

  async state(refresh = false): Promise<OrchestratorState> {
    await this.service.init();
    const accountState = await this.service.state();
    const accounts = accountState.accounts.filter((account) => account.usable && account.status !== "signed-out");
    const catalogs = new Map<string, CatalogModel[]>();
    let error: string | null = null;
    await Promise.all(
      accounts.map(async (account) => {
        try {
          const models = await this.catalog(account.id, account.email ?? "", refresh);
          if (models) catalogs.set(account.id, models);
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
        }
      }),
    );
    // Keep configured account order, with the system sign-in first when present.
    const ordered = new Map(
      [...catalogs].sort(
        ([a], [b]) =>
          (a === SYSTEM_ACCOUNT_ID ? -1 : accounts.findIndex((x) => x.id === a)) -
          (b === SYSTEM_ACCOUNT_ID ? -1 : accounts.findIndex((x) => x.id === b)),
      ),
    );
    const curated = await curatedModelIds();
    let settings: SettingsJson = {};
    try {
      settings = await readSettingsJson();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (!ordered.size && !error) error = "No signed-in account could list its models.";
    const overrides: Record<string, OrchestratorChoice> = {};
    for (const account of accountState.accounts) {
      if (account.kind === "profile" && account.orchestratorOverride) {
        overrides[account.id] = account.orchestratorOverride;
      }
    }
    return {
      planner: savedRole(settings, "planner"),
      executor: savedRole(settings, "executor"),
      overrides,
      planners: familiesFor(PLANNER_FAMILIES, ordered, curated),
      executors: familiesFor(EXECUTOR_FAMILIES, ordered, curated),
      error,
    };
  }

  /**
   * Saves the planner and executor either globally (agy's settings.json) or as a per-account
   * override for a profile account. `null` restores agy's default.
   */
  async save(update: {
    planner?: string | null;
    executor?: string | null;
    accountId?: string;
    inheritGlobal?: boolean;
  }): Promise<OrchestratorState> {
    const state = await this.state();
    const known = (families: readonly ModelFamily[], label: string) =>
      families.some((family) => family.variants.some((variant) => variant.label === label));
    if (update.planner && !known(state.planners, update.planner)) {
      throw new Error(`${update.planner} is not a planner model your accounts can use.`);
    }
    if (update.executor && !known(state.executors, update.executor)) {
      throw new Error(`${update.executor} is not an executor model your accounts can use.`);
    }
    if (update.accountId && update.accountId !== SYSTEM_ACCOUNT_ID) {
      if (update.inheritGlobal) {
        await this.service.setAccountOptions(update.accountId, { orchestratorOverride: null });
        return this.state();
      }
      const existing = state.overrides[update.accountId] ?? { planner: state.planner, executor: state.executor };
      const next: OrchestratorChoice = {
        planner: update.planner !== undefined ? update.planner : existing.planner,
        executor: update.executor !== undefined ? update.executor : existing.executor,
      };
      await this.service.setAccountOptions(update.accountId, { orchestratorOverride: next });
      return this.state();
    }

    const run = this.writing.then(async () => {
      const settings = await readSettingsJson();
      const orchestrator: Record<string, unknown> = { ...orchestratorOf(settings) };
      for (const role of ["planner", "executor"] as const) {
        const value = update[role];
        if (value === undefined) continue;
        if (value === null) delete orchestrator[role];
        else orchestrator[role] = value;
      }
      if (Object.keys(orchestrator).length) settings.orchestrator = orchestrator;
      else delete settings.orchestrator;
      await fs.mkdir(REAL_CLI_DIR, { recursive: true });
      const temp = `${SETTINGS_FILE}.paseo-${process.pid}-${Date.now()}-${++this.writeSeq}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, SETTINGS_FILE);
    });
    this.writing = run.catch(() => undefined);
    await run;
    await this.service.syncAllProfiles();
    return this.state();
  }

  /** Reopens an agent so its next turn uses the saved choice; waits for a running turn to end. */
  async apply(paseo: PaseoApi, agentId: string): Promise<"now" | "after-turn" | "none"> {
    const handle = paseo.agents.ref(agentId);
    const snapshot = await handle.refresh().catch(() => null);
    if (!snapshot || snapshot.agent.archivedAt || !isAntigravityProvider(snapshot.agent.provider)) return "none";
    if (snapshot.agent.status === "running" || snapshot.agent.status === "initializing") {
      this.pendingReloads.add(agentId);
      // The turn may have ended while this ran; then nothing would pick the reload up.
      const again = await handle.refresh().catch(() => null);
      if (again && again.agent.status !== "running" && again.agent.status !== "initializing" && this.pendingReloads.delete(agentId)) {
        return (await this.reload(paseo, agentId)) ? "now" : "none";
      }
      return "after-turn";
    }
    this.pendingReloads.delete(agentId);
    return (await this.reload(paseo, agentId)) ? "now" : "none";
  }

  /** Reopens an idle agent. The settings are already saved, so a failure only delays them. */
  private async reload(paseo: PaseoApi, agentId: string): Promise<boolean> {
    try {
      await paseo.agents.ref(agentId).reload();
      return true;
    } catch (error) {
      console.error(`dsh-paseo/antigravity: could not reopen ${agentId}`, error);
      return false;
    }
  }

  register(
    server: PluginServerContext,
    options?: { onContext?: (ctx: PluginHandlerContext) => void },
  ): Array<() => void> {
    return [
      this.service.onStatusUpdated(({ accountId, signedInChanged }) => {
        if (signedInChanged) this.invalidateAccount(accountId);
      }),
      server.addHook("agent.turn.after", async ({ agent }, ctx) => {
        options?.onContext?.(ctx);
        const { paseo } = ctx;
        if (!this.pendingReloads.has(agent.id)) return;
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          void (async () => {
            if (!this.pendingReloads.has(agent.id)) return;
            const snapshot = await paseo.agents.ref(agent.id).refresh().catch(() => null);
            if (!snapshot || snapshot.agent.archivedAt) {
              this.pendingReloads.delete(agent.id);
              return;
            }
            // Another turn started meanwhile: wait for that one.
            if (snapshot.agent.status === "running" || snapshot.agent.status === "initializing") return;
            this.pendingReloads.delete(agent.id);
            await this.reload(paseo, agent.id);
          })();
        }, 500);
        this.timers.add(timer);
      }),
      server.addHook("agent.archive.after", async ({ agent }, ctx) => {
        options?.onContext?.(ctx);
        this.pendingReloads.delete(agent.id);
      }),
      () => {
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.pendingReloads.clear();
      },
    ];
  }
}
