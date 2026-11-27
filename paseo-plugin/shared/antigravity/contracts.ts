/**
 * Shared RPC contracts, subscription definitions, timeline kinds, and schemas
 * for the integrated Antigravity Console capabilities inside `dsh-paseo`.
 *
 * Kept strictly runtime-neutral (`@getpaseo/plugin` + `zod` only; zero `node:*`
 * imports, Hermes/React Native safe) so both the daemon server and client UI
 * share one source of truth.
 *
 * Note: context-window usage RPC/schemas are intentionally omitted (the
 * Antigravity context window pill is excluded).
 *
 * @module dsh-paseo/shared/antigravity/contracts
 */
import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/** The built-in provider this module works with. */
export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

/**
 * Agent metadata key that names the account an Antigravity agent runs on.
 * Absent (or "default") means the system sign-in that `agy` uses on its own.
 */
export const ACCOUNT_METADATA_KEY = "antigravity-accounts.account";

/** Id of the system sign-in (the keychain login `agy` uses without this plugin). */
export const SYSTEM_ACCOUNT_ID = "default";

/** True when a provider string (`antigravity` or `antigravity/<model>`) is Antigravity. */
export function isAntigravityProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return provider.split("/")[0] === ANTIGRAVITY_PROVIDER_ID;
}

/** Reads the account id stored on an agent; returns SYSTEM_ACCOUNT_ID when none is stored. */
export function accountIdFromMetadata(metadata: Readonly<Record<string, unknown>> | null | undefined): string {
  const value = metadata?.[ACCOUNT_METADATA_KEY];
  return typeof value === "string" && value.length > 0 ? value : SYSTEM_ACCOUNT_ID;
}

/** Quota pool a model draws from. */
export const quotaPoolSchema = z.enum(["gemini", "third-party", "all"]);
export type QuotaPool = z.infer<typeof quotaPoolSchema>;

/** Infers which agy quota pool a model id or label uses. */
export function quotaPoolForModel(model: string | null | undefined): "gemini" | "third-party" {
  const name = (model ?? "").trim().toLowerCase().replace(/^antigravity\//, "");
  if (name.startsWith("claude") || name.startsWith("gpt")) return "third-party";
  return "gemini";
}

export const accountIdSchema = z
  .string()
  .regex(/^(default|a[0-9a-f]{8})$/, "Unknown account id");

export const accountLabelSchema = z
  .string()
  .trim()
  .min(1, "Enter a name")
  .max(40, "Use at most 40 characters");

export const quotaBucketSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Provider period name, for example "weekly" or "5h". */
  window: z.string(),
  /** 0..1 of quota left; null when agy reports none. */
  remainingFraction: z.number().min(0).max(1).nullable(),
  /** ISO timestamp of the next reset, when reported. */
  resetTime: z.string().nullable(),
  disabled: z.boolean(),
});

export const quotaGroupSchema = z.object({
  name: z.string(),
  buckets: z.array(quotaBucketSchema),
});

export const accountStatusSchema = z.enum([
  /** agy answered with this account's quota. */
  "signed-in",
  /** agy asked to sign in. */
  "signed-out",
  /** Never checked yet. */
  "unknown",
  /** The last check failed for another reason; see statusDetail. */
  "error",
]);

export const failureReasonSchema = z.enum(["quota", "auth", "transient", "error"]);
export type FailureReason = z.infer<typeof failureReasonSchema>;

export const accountCooldownSchema = z.object({
  pool: quotaPoolSchema,
  reason: failureReasonSchema,
  until: z.string(),
});
export type AccountCooldown = z.infer<typeof accountCooldownSchema>;

export const orchestratorChoiceSchema = z.object({
  planner: z.string().nullable(),
  executor: z.string().nullable(),
});
export type OrchestratorChoice = z.infer<typeof orchestratorChoiceSchema>;

export const accountSummarySchema = z.object({
  id: accountIdSchema,
  label: z.string(),
  /** "system": agy's own keychain login. "profile": a login this plugin keeps in its own profile. */
  kind: z.enum(["system", "profile"]),
  /** New Antigravity agents get this account unless the composer picks another. */
  isDefaultForNewAgents: z.boolean(),
  status: accountStatusSchema,
  /** Google account email from agy's log, when known. */
  email: z.string().nullable(),
  /** The account's Google AI plan as agy names it, for example "Google AI Pro"; null until known. */
  plan: z.string().nullable(),
  /** Human-readable reason for status "error" or "signed-out", or a safety warning. */
  statusDetail: z.string().nullable(),
  /** ISO timestamp of the last status check. */
  checkedAt: z.string().nullable(),
  quota: z.array(quotaGroupSchema).nullable(),
  /** ISO timestamp; null for the system account. */
  createdAt: z.string().nullable(),
  /** False when the plugin found credentials stored outside the profile and refuses to launch it. */
  usable: z.boolean(),
  /** Whether automatic fallback may route turns onto this account. */
  fallbackEnabled: z.boolean(),
  /** Active fallback cooldowns on this account (by quota pool or whole account). */
  cooldowns: z.array(accountCooldownSchema),
  /** Per-account Orchestrator override for profile accounts; null inherits the global choice. */
  orchestratorOverride: orchestratorChoiceSchema.nullable(),
});

export type AccountSummary = z.infer<typeof accountSummarySchema>;
export type QuotaGroup = z.infer<typeof quotaGroupSchema>;
export type QuotaBucket = z.infer<typeof quotaBucketSchema>;

/** Strategy used when picking the next account for fallback (or smart routing). */
export const fallbackStrategySchema = z.enum(["order", "quota", "reset"]);
export type FallbackStrategy = z.infer<typeof fallbackStrategySchema>;

/** Automatic account fallback when an Antigravity turn fails. */
export const fallbackSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Retries on the same account for errors that may pass (network, 5xx, unknown) before moving on. */
  retries: z.number().int().min(0).max(3),
  /** order: list order; quota: highest remaining quota for the model's pool; reset: soonest reset with quota left. */
  strategy: fallbackStrategySchema,
});

export type FallbackSettings = z.infer<typeof fallbackSettingsSchema>;

export const accountsStateSchema = z.object({
  /** Accounts in configured fallback priority order. */
  accounts: z.array(accountSummarySchema),
  defaultAccountId: accountIdSchema,
  /** Resolved agy executable, or null when it was not found. */
  agyPath: z.string().nullable(),
  agyVersion: z.string().nullable(),
  /** Host-level problems to show above the list, for example "agy was not found". */
  problems: z.array(z.string()),
  fallback: fallbackSettingsSchema,
  /** Increases on every change; clients can compare it with the watch event. */
  revision: z.number().int().nonnegative(),
});

export type AccountsState = z.infer<typeof accountsStateSchema>;

const empty = z.object({}).strict();

/** Lists accounts. `refresh: true` re-checks every account's sign-in and quota first (a few seconds). */
export const listAccountsRpc = defineRpc({
  name: "accounts.list",
  input: z.object({ refresh: z.boolean().optional() }).strict(),
  output: accountsStateSchema,
});

/** Re-checks one account (or all when accountId is omitted) and returns the new state. */
export const refreshAccountsRpc = defineRpc({
  name: "accounts.refresh",
  input: z.object({ accountId: accountIdSchema.optional() }).strict(),
  output: accountsStateSchema,
});

/** Creates a profile account. It starts signed out; call signIn.start next. */
export const createAccountRpc = defineRpc({
  name: "accounts.create",
  input: z.object({ label: accountLabelSchema }).strict(),
  output: z.object({ account: accountSummarySchema, state: accountsStateSchema }),
});

/** Renames an account. The system account can be renamed too (display only). */
export const renameAccountRpc = defineRpc({
  name: "accounts.rename",
  input: z.object({ accountId: accountIdSchema, label: accountLabelSchema }).strict(),
  output: accountsStateSchema,
});

/** Chooses the account new Antigravity agents get. */
export const setDefaultAccountRpc = defineRpc({
  name: "accounts.set-default",
  input: z.object({ accountId: accountIdSchema }).strict(),
  output: accountsStateSchema,
});

/** Moves an account up or down in the list and fallback priority order. */
export const moveAccountRpc = defineRpc({
  name: "accounts.move",
  input: z
    .object({
      accountId: accountIdSchema,
      direction: z.enum(["up", "down"]),
    })
    .strict(),
  output: accountsStateSchema,
});

/** Updates per-account options: whether fallback may use it, and optional Orchestrator override. */
export const setAccountOptionsRpc = defineRpc({
  name: "accounts.set-options",
  input: z
    .object({
      accountId: accountIdSchema,
      fallbackEnabled: z.boolean().optional(),
      /** Pass null to inherit the global Orchestrator setting, or `{ planner, executor }` to override. */
      orchestratorOverride: orchestratorChoiceSchema.nullable().optional(),
    })
    .strict(),
  output: accountsStateSchema,
});

/** Clears active fallback cooldowns on an account (or all accounts when omitted). */
export const clearCooldownRpc = defineRpc({
  name: "accounts.clear-cooldown",
  input: z.object({ accountId: accountIdSchema.optional() }).strict(),
  output: accountsStateSchema,
});

/** The folder in the daemon user's home that receives a removed account's saved files. */
export const RECOVERY_FOLDER_NAME = "Antigravity Console";

/** Files agents saved in a profile account's home folder, and where removing or recovering puts them. */
export const savedFilesSchema = z.object({
  /** Files and folders, relative to the account's home folder. */
  items: z.array(z.string()),
  /** The folder they are (or would be) moved or copied to, with the home folder written as `~`. */
  folder: z.string(),
  /** Subset of `items` that were copied instead of moved (originals left in place, e.g. across volumes). */
  copied: z.array(z.string()).optional(),
});
export type SavedFiles = z.infer<typeof savedFilesSchema>;

/** Lists what removing or recovering a profile account would move out of its home folder. */
export const savedFilesRpc = defineRpc({
  name: "accounts.saved-files",
  input: z.object({ accountId: accountIdSchema }).strict(),
  output: savedFilesSchema,
});

/** Moves saved files out of a profile account's home folder without removing the account. */
export const recoverSavedFilesRpc = defineRpc({
  name: "accounts.recover-files",
  input: z.object({ accountId: accountIdSchema }).strict(),
  output: z.object({ moved: savedFilesSchema.nullable() }),
});

/**
 * Deletes a profile account, its sign-in and agy's data for it. Files agents saved in its home
 * folder are moved to a folder under ~/Antigravity Console first (`moved`, null when there were
 * none). Shared conversations are kept. Fails for the system account. Agents still pointing at it
 * fail to open until switched.
 */
export const removeAccountRpc = defineRpc({
  name: "accounts.remove",
  input: z.object({ accountId: accountIdSchema }).strict(),
  output: z.object({ state: accountsStateSchema, moved: savedFilesSchema.nullable() }),
});

/** Deletes a profile account's stored sign-in but keeps the account. Fails for the system account. */
export const signOutAccountRpc = defineRpc({
  name: "accounts.sign-out",
  input: z.object({ accountId: accountIdSchema }).strict(),
  output: accountsStateSchema,
});

/**
 * Starts Google sign-in for a profile account. Returns the Google URL to open in a browser.
 * Google then shows a code (or lands on a page whose URL can be pasted); pass it to signIn.submit.
 * A pending sign-in expires after 10 minutes. Starting again cancels the previous one for that account.
 */
export const startSignInRpc = defineRpc({
  name: "sign-in.start",
  input: z.object({ accountId: accountIdSchema }).strict(),
  output: z.object({
    loginId: z.string(),
    url: z.string().url(),
    expiresAt: z.string(),
  }),
});

/** Sends the pasted code or landing-page URL. Resolves with the refreshed state once agy confirms. */
export const submitSignInRpc = defineRpc({
  name: "sign-in.submit",
  input: z
    .object({
      loginId: z.string().min(1),
      code: z.string().trim().min(1, "Paste the code").max(16384),
    })
    .strict(),
  output: accountsStateSchema,
});

export const cancelSignInRpc = defineRpc({
  name: "sign-in.cancel",
  input: z.object({ loginId: z.string().min(1) }).strict(),
  output: empty,
});

/**
 * Moves an Antigravity agent to another account and keeps its conversation.
 * "now" reloads the session immediately (interrupts a running turn).
 * "after-turn" stores the choice and reloads when the current turn ends; when the agent is idle it
 * behaves like "now".
 */
export const switchAgentAccountRpc = defineRpc({
  name: "agents.switch-account",
  input: z
    .object({
      agentId: z.string().min(1),
      accountId: accountIdSchema,
      when: z.enum(["now", "after-turn"]).default("now"),
    })
    .strict(),
  output: z.object({
    result: z.enum(["switched", "scheduled", "unchanged"]),
    accountLabel: z.string(),
  }),
});

/** Moves multiple Antigravity agents from one account to another. */
export const migrateAccountAgentsRpc = defineRpc({
  name: "agents.migrate-account",
  input: z
    .object({
      fromAccountId: accountIdSchema,
      toAccountId: accountIdSchema,
      mode: z.enum(["idle-only", "after-turn", "now"]).default("after-turn"),
    })
    .strict(),
  output: z.object({
    switched: z.number().int().nonnegative(),
    scheduled: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.array(z.object({ agentId: z.string(), title: z.string().nullable(), error: z.string() })),
    targetLabel: z.string(),
  }),
});

/** Pushes `{ revision }` whenever the account list, a status, cooldown, or a default changes. */
export const watchAccountsSubscription = defineSubscription({
  name: "accounts.watch",
  input: empty,
  event: z.object({ revision: z.number().int().nonnegative() }),
});

export const statsRangeSchema = z.enum(["24h", "7d", "30d"]);
export type StatsRange = z.infer<typeof statsRangeSchema>;

export const statsScopeSchema = z.enum(["all", "main", "subagent"]);
export type StatsScope = z.infer<typeof statsScopeSchema>;

/** Token, timing, and estimated API cost sums for a set of model calls; ratios are derived by the client. */
export const usageTotalsSchema = z.object({
  requests: z.number().int().nonnegative(),
  input: z.number().nonnegative(),
  cached: z.number().nonnegative(),
  output: z.number().nonnegative(),
  /** Seconds spent streaming output (TPS = output / generationSeconds). */
  generationSeconds: z.number().nonnegative(),
  /** Seconds from request to first token, summed. */
  firstTokenSeconds: z.number().nonnegative(),
  /** Estimated API cost in USD across priced requests. */
  cost: z.number().nonnegative(),
  /** Number of requests that matched an official or custom price entry. */
  pricedRequests: z.number().int().nonnegative(),
});

export type UsageTotals = z.infer<typeof usageTotalsSchema>;

export const usageAccountBreakdownSchema = usageTotalsSchema.extend({
  accountId: z.string(),
  label: z.string(),
  conversations: z.number().int().nonnegative(),
});
export type UsageAccountBreakdown = z.infer<typeof usageAccountBreakdownSchema>;

export const usageStatsSchema = z.object({
  range: statsRangeSchema,
  /** Nominal bin duration in ms (DST days may be 23h or 25h; each bin carries its exact start/end). */
  binMs: z.number().int().positive(),
  bins: z.array(usageTotalsSchema.extend({ start: z.number(), end: z.number() })),
  totals: usageTotalsSchema,
  /** Split between main conversations and subagent conversations in the selected range/account. */
  breakdown: z.object({
    main: usageTotalsSchema,
    subagent: usageTotalsSchema,
  }),
  /** Per model label as agy shows it, most requests first. */
  models: z.array(usageTotalsSchema.extend({ label: z.string(), pricingKey: z.string() })),
  /** Per attributed account (only conversations launched while this plugin observed them carry an account id). */
  accounts: z.array(usageAccountBreakdownSchema),
  conversations: z.number().int().nonnegative(),
  /** True when at least one custom price override is currently configured. */
  hasCustomPricing: z.boolean(),
  generatedAt: z.string(),
});

export type UsageStats = z.infer<typeof usageStatsSchema>;

/** Usage of Antigravity conversations on this host, filterable by scope, account, and model. */
export const usageStatsRpc = defineRpc({
  name: "stats.usage",
  input: z
    .object({
      range: statsRangeSchema,
      scope: statsScopeSchema.optional(),
      accountId: z.string().min(1).max(40).optional(),
      model: z.string().min(1).max(120).optional(),
    })
    .strict(),
  output: usageStatsSchema,
});

/** Local calendar days the activity calendar covers: 53 weeks, so any week start fits a full year. */
export const DAILY_HISTORY_DAYS = 371;

const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const usageDaySchema = usageTotalsSchema.extend({ date: dayKeySchema });
export type UsageDay = z.infer<typeof usageDaySchema>;

export const usageDailySchema = z.object({
  /** Today in the daemon's local calendar; the activity calendar ends on this day. */
  today: dayKeySchema,
  /** Days with at least one request in the last DAILY_HISTORY_DAYS days, oldest first. */
  days: z.array(usageDaySchema),
  generatedAt: z.string(),
});
export type UsageDaily = z.infer<typeof usageDailySchema>;

/** Daily totals for the activity calendar. Filters match stats.usage; the window is always a year. */
export const usageDailyRpc = defineRpc({
  name: "stats.daily",
  input: z
    .object({
      scope: statsScopeSchema.optional(),
      accountId: z.string().min(1).max(40).optional(),
      model: z.string().min(1).max(120).optional(),
    })
    .strict(),
  output: usageDailySchema,
});

// ---- API Pricing ---------------------------------------------------------------------------

const rateNumber = z.number().finite().min(0).max(10_000);

export const modelRatesSchema = z.object({
  input: rateNumber,
  cached: rateNumber,
  output: rateNumber,
  longContextThreshold: z.number().int().positive().max(10_000_000).optional(),
  longInput: rateNumber.optional(),
  longCached: rateNumber.optional(),
  longOutput: rateNumber.optional(),
});

export const pricingModelRowSchema = z.object({
  key: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
  provider: z.string().nullable(),
  /** Official rates effective right now, or null for custom/unrecognized models. */
  official: modelRatesSchema.nullable(),
  /** User-configured override rates, or null when using official defaults. */
  custom: modelRatesSchema.nullable(),
  /** Effective rates currently used for estimation, or null when unpriced. */
  effective: modelRatesSchema.nullable(),
  /** Optional note about official scheduled or tiered rates. */
  note: z.string().nullable(),
  /** True when this model appeared in recent local conversations. */
  seenLocally: z.boolean(),
});

export type PricingModelRow = z.infer<typeof pricingModelRowSchema>;

export const pricingStateSchema = z.object({
  models: z.array(pricingModelRowSchema),
  /** Raw custom overrides map so clients (e.g. subagent views) can also estimate costs locally. */
  overrides: z.record(z.string(), modelRatesSchema),
});

export type PricingState = z.infer<typeof pricingStateSchema>;

export const getPricingRpc = defineRpc({
  name: "pricing.get",
  input: empty,
  output: pricingStateSchema,
});

export const setPricingRpc = defineRpc({
  name: "pricing.set",
  input: z
    .object({
      /** Model pricing family key (e.g. "gemini-4-neon"). Required unless resetAll is true. */
      key: z.string().trim().min(1).max(120).optional(),
      /** Custom rates in USD per 1M tokens, or null to restore the official default for `key`. */
      rates: modelRatesSchema.nullable().optional(),
      /** When true, clears all custom overrides and restores official API pricing. */
      resetAll: z.boolean().optional(),
    })
    .strict(),
  output: pricingStateSchema,
});

export const setFallbackRpc = defineRpc({
  name: "accounts.set-fallback",
  input: fallbackSettingsSchema.partial().strict(),
  output: accountsStateSchema,
});

/** Timeline row the plugin appends when it retries or moves an agent to another account. */
export const FALLBACK_TIMELINE_KIND = "antigravity-fallback";

export const fallbackEventSchema = z.object({
  event: z.enum(["retry", "switch", "exhausted"]),
  /** quota: limit reached; auth: sign-in rejected; transient: may pass; error: anything else. */
  reason: failureReasonSchema,
  from: z.string(),
  to: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  message: z.string().max(400),
});

export type FallbackEvent = z.infer<typeof fallbackEventSchema>;

// ---- Orchestrator --------------------------------------------------------------------------

/** Antigravity model ids that run the Orchestrator (a planner that hands work to an executor). */
export function isOrchestratorModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.startsWith("gemini-pro-orchestrator");
}

export const modelVariantSchema = z.object({
  /** agy model id, for example `gemini-4-carbon-high`. */
  id: z.string(),
  /** agy model label, the value saved in settings.json, for example `Gemini 4 Carbon (High)`. */
  label: z.string(),
  /** Effort part of the label, for example `High`. */
  effort: z.string(),
});

export const modelFamilySchema = z.object({
  /** Model id without the effort suffix, for example `gemini-4-carbon`. */
  id: z.string(),
  /** Label without the effort, for example `Gemini 4 Carbon`. */
  label: z.string(),
  variants: z.array(modelVariantSchema),
  /** Accounts that can run this family. */
  accounts: z.array(z.string()),
});
export type ModelFamily = z.infer<typeof modelFamilySchema>;

export const orchestratorStateSchema = z.object({
  /** Saved global planner label, or null for agy's default. */
  planner: z.string().nullable(),
  executor: z.string().nullable(),
  /** Per-account overrides keyed by accountId (only profile accounts with an explicit override). */
  overrides: z.record(z.string(), orchestratorChoiceSchema),
  planners: z.array(modelFamilySchema),
  executors: z.array(modelFamilySchema),
  /** Why the model lists could not be read, when they could not. */
  error: z.string().nullable(),
});
export type OrchestratorState = z.infer<typeof orchestratorStateSchema>;

export const getOrchestratorRpc = defineRpc({
  name: "orchestrator.get",
  input: z.object({ refresh: z.boolean().optional() }).strict(),
  output: orchestratorStateSchema,
});

export const setOrchestratorRpc = defineRpc({
  name: "orchestrator.set",
  input: z
    .object({
      planner: z.string().min(1).max(80).nullable().optional(),
      executor: z.string().min(1).max(80).nullable().optional(),
      /** When set to a profile account id, saves an override for that account instead of global settings.json. */
      accountId: accountIdSchema.optional(),
      /** When true with accountId, clears that account's override so it inherits the global choice. */
      inheritGlobal: z.boolean().optional(),
      /** Agent to reopen with the new choice: now when idle, after its turn when running. */
      applyTo: z.string().min(1).max(200).optional(),
    })
    .strict(),
  output: z.object({
    state: orchestratorStateSchema,
    applied: z.enum(["now", "after-turn", "none"]),
  }),
});

// ---- Subagents -----------------------------------------------------------------------------

export const subagentStateSchema = z.enum(["running", "done", "stopped", "failed", "idle"]);
export type SubagentState = z.infer<typeof subagentStateSchema>;

export const subagentOriginSchema = z.enum(["subagent", "swarm"]);
export type SubagentOrigin = z.infer<typeof subagentOriginSchema>;

export const subagentSummarySchema = z.object({
  /** agy conversation id of the subagent. */
  id: z.string(),
  /** Parent conversation id; the agent's own conversation for direct children. */
  parentId: z.string(),
  depth: z.number().int().min(1),
  role: z.string().nullable(),
  /** Human-friendly display name (e.g. Chinese role title from swarm brief or plan.json), when available. */
  displayName: z.string().nullable().optional(),
  type: z.string().nullable(),
  /** Whether this child came from a regular subagent or an Antigravity `/swarm` worker. */
  origin: subagentOriginSchema.optional(),
  /** Start of the task the parent gave it. */
  task: z.string(),
  state: subagentStateSchema,
  /** While running: thinking about the next step, or running a tool. */
  phase: z.enum(["thinking", "tool"]).nullable(),
  /** Its latest tool call. */
  activity: z.string().nullable(),
  steps: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  model: z.string().nullable(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedTokens: z.number().nonnegative(),
  startedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** Set when it reported back to its parent. */
  reportedAt: z.string().nullable(),
});
export type SubagentSummary = z.infer<typeof subagentSummarySchema>;

export const subagentListSchema = z.object({
  conversationId: z.string().nullable(),
  swarmTitle: z.string().nullable().optional(),
  subagents: z.array(subagentSummarySchema),
});
export type SubagentList = z.infer<typeof subagentListSchema>;

export const listSubagentsRpc = defineRpc({
  name: "subagents.list",
  input: z.object({ agentId: z.string().min(1).max(200) }).strict(),
  output: subagentListSchema,
});

export const subagentCountsRpc = defineRpc({
  name: "subagents.counts",
  input: z.object({ agentIds: z.array(z.string().min(1).max(200)).max(200) }).strict(),
  output: z.object({
    counts: z.record(
      z.string(),
      z.object({
        total: z.number().int(),
        running: z.number().int(),
        failed: z.number().int().default(0),
      }),
    ),
  }),
});

export const transcriptToolSchema = z.object({
  name: z.string(),
  /** One-line description of the call. */
  summary: z.string(),
  /** Start of the tool's output, when it finished. */
  output: z.string().nullable(),
  failed: z.boolean(),
});

export const transcriptEntrySchema = z.object({
  index: z.number().int(),
  kind: z.enum(["task", "message", "response", "error"]),
  at: z.string().nullable(),
  text: z.string().nullable(),
  thinking: z.string().nullable(),
  tools: z.array(transcriptToolSchema),
  model: z.string().nullable(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

export const subagentArtifactInfoSchema = z.object({
  /** Relative path under the subagent's brain directory. */
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  updatedAt: z.string(),
  isMarkdown: z.boolean(),
});
export type SubagentArtifactInfo = z.infer<typeof subagentArtifactInfoSchema>;

export const subagentDetailSchema = z.object({
  summary: subagentSummarySchema.nullable(),
  entries: z.array(transcriptEntrySchema),
  /** The report it sent to its parent, in full. */
  report: z.string().nullable(),
  /** Artifacts written by the subagent inside its brain directory. */
  artifacts: z.array(subagentArtifactInfoSchema),
  /** True when older entries were left out. */
  truncated: z.boolean(),
});
export type SubagentDetail = z.infer<typeof subagentDetailSchema>;

export const subagentDetailRpc = defineRpc({
  name: "subagents.detail",
  input: z
    .object({
      agentId: z.string().min(1).max(200),
      subagentId: z.string().regex(/^[0-9a-f-]{36}$/i),
    })
    .strict(),
  output: subagentDetailSchema,
});

export const subagentArtifactRpc = defineRpc({
  name: "subagents.artifact",
  input: z
    .object({
      agentId: z.string().min(1).max(200),
      subagentId: z.string().regex(/^[0-9a-f-]{36}$/i),
      path: z.string().min(1).max(300),
    })
    .strict(),
  output: z.object({
    path: z.string(),
    content: z.string(),
    truncated: z.boolean(),
    isMarkdown: z.boolean(),
  }),
});

export const toolSummariesSchema = z.object({
  byCommand: z.record(z.string(), z.string()),
  prefixes: z.array(z.object({ prefix: z.string(), summary: z.string() })),
});
export type ToolSummaries = z.infer<typeof toolSummariesSchema>;

export const toolSummariesRpc = defineRpc({
  name: "antigravity.tool_summaries",
  input: z
    .object({
      agentId: z.string().min(1).max(200),
    })
    .strict(),
  output: toolSummariesSchema,
});

/** Collapses whitespace so transcript CommandLine and ACP detail.command match reliably. */
export function normalizeCommandKey(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/** Matches an Antigravity `run_command` headline against cached `toolSummary` entries. */
export function matchAntigravityCommandSummary(summaries: ToolSummaries | undefined, command: string): string {
  if (!summaries) return "";
  const norm = normalizeCommandKey(command);
  if (!norm) return "";
  if (Object.prototype.hasOwnProperty.call(summaries.byCommand, norm)) {
    return summaries.byCommand[norm] ?? "";
  }
  let best = "";
  let bestLen = 0;
  for (const entry of summaries.prefixes) {
    const p = entry.prefix;
    if (p.length < 16) continue;
    if ((norm.startsWith(p) || p.startsWith(norm)) && p.length >= bestLen) {
      best = entry.summary;
      bestLen = p.length;
    }
  }
  return best;
}

export const SUBAGENT_TIMELINE_KIND = "antigravity-subagent";
export const SUBAGENT_LIST_TIMELINE_KIND = "antigravity-subagents-check";
export const ASK_QUESTION_TIMELINE_KIND = "antigravity-ask-question";

export const subagentCardSchema = z.object({
  id: z.string(),
  role: z.string().nullable().optional(),
  type: z.string().nullable(),
  origin: subagentOriginSchema.optional(),
  task: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
});
export type SubagentCard = z.infer<typeof subagentCardSchema>;

export const subagentCheckSchema = z.object({
  action: z.string(),
  /** States reported by that check, keyed by subagent id. */
  states: z.array(z.object({ id: z.string(), role: z.string().nullable(), state: z.string() })),
  title: z.string().nullable().optional(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
});
export type SubagentCheck = z.infer<typeof subagentCheckSchema>;

export const askQuestionEntrySchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  multiSelect: z.boolean(),
});
export type AskQuestionEntry = z.infer<typeof askQuestionEntrySchema>;

export const askQuestionCardSchema = z.object({
  callId: z.string(),
  questions: z.array(askQuestionEntrySchema),
  output: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
});
export type AskQuestionCard = z.infer<typeof askQuestionCardSchema>;

const CJK_RE = /[\u4e00-\u9fff]/;
const SWARM_EXPLICIT_ROLE_RE =
  /(?:你是(?:本?蜂群的?|负责)?|角色\s*[：:]\s*)[「『【"']([^」』】"'\n]{2,40})[」』】"']/;
const TRAILING_PARENS_RE = /\s*[（(][^）)\n]{1,32}[）)]\s*$/;

/**
 * Extracts a short human-readable Chinese role title (e.g. `Antigravity 服务端审查员`) from a
 * swarm worker's brief when the coordinator declares it via `你是「...」` or `角色：「...」`.
 */
export function extractSwarmBriefLabel(brief: string | null | undefined): string | null {
  if (typeof brief !== "string" || !brief) return null;
  const head = brief.replace(/^@[a-z0-9_-]+\s+/i, "").trim().slice(0, 220);
  if (!head) return null;
  const match = SWARM_EXPLICIT_ROLE_RE.exec(head);
  if (!match?.[1]) return null;
  const cleaned = match[1].replace(TRAILING_PARENS_RE, "").trim();
  if (cleaned.length < 2 || cleaned.length > 32) return null;
  return CJK_RE.test(cleaned) ? cleaned : null;
}

/**
 * Normalizes a task title from `.system_generated/swarm/plan.json` into a concise Chinese label.
 */
export function cleanSwarmPlanLabel(task: string | null | undefined): string | null {
  if (typeof task !== "string" || !task) return null;
  const trimmed = task.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(TRAILING_PARENS_RE, "").trim();
  if (cleaned.length < 2 || !CJK_RE.test(cleaned)) return null;
  return cleaned.length > 28 ? `${cleaned.slice(0, 27)}…` : cleaned;
}
