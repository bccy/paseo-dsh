import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Wire contract between the DSH Plugins page and the plugin server.
 *
 * Kept in one file so the client and server cannot drift: both import these
 * schemas, and Paseo parses every input/output at the RPC boundary.
 *
 * Failures cross this boundary as a code plus optional raw detail. The daemon
 * never writes user-facing sentences: the page chooses the language, from the
 * plugin's own two copy tables in `client/locale.ts` — the same rule this fork
 * follows everywhere else (no host translation API on the client half; see the
 * module note there).
 */

/**
 * The display language the page asks the daemon for.
 *
 * It travels on `list` because the locale files live on the daemon's disk; the
 * client's own locale chain (`client/locale.ts`) has no way to read them.
 */
export const pluginLocaleSchema = z.enum(["en", "zh-CN"]);
export type PluginLocale = z.infer<typeof pluginLocaleSchema>;

export const jobKindSchema = z.enum(["install", "remove", "update", "update-all", "check"]);
export const jobStateSchema = z.enum(["running", "succeeded", "failed"]);

/**
 * Every failure the page can show. Adding one here without a matching entry in
 * `client/locale.ts` is a type error there (`Record<FailureCode, …>`), so a new
 * code cannot silently render as a blank line.
 */
export const failureCodeSchema = z.enum([
  "profile-unreadable",
  "profile-invalid",
  "invalid-platform",
  "lock-timeout",
  "invalid-name",
  "protected",
  "not-installed",
  "not-a-bundle",
  "invalid-spec",
  "registry-unreadable",
  "registry-invalid",
  "already-installed",
  "not-removable",
  "not-in-dependencies",
  "invalid-version",
  "check-failed",
  "disposed",
  "busy",
  "job-missing",
  "spawn-failed",
  "command-failed",
  "request-failed",
]);

const failureFields = {
  errorCode: failureCodeSchema.optional(),
  errorDetail: z.string().optional(),
};

/** One bundle the page asks "update all" to move to a discovered version. */
export const updateTargetSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

/**
 * What happened to one target of a batch update.
 *
 * A batch is one job over several packages, so its outcome cannot be a single
 * flag: every target reports `ok` plus, on failure, the same failure code and
 * raw detail a single update would have returned. A partially failed batch is a
 * failed job whose `updateResults` still lists what did succeed.
 */
export const updateOutcomeSchema = z.object({
  name: z.string(),
  version: z.string(),
  ok: z.boolean(),
  ...failureFields,
});

export const bundleRowSchema = z.object({
  id: z.string(),
  module: z.string().optional(),
});

export const bundleInfoSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  /** Localized display title from the package's `locale/*.json`; absent keeps the name. */
  title: z.string().optional(),
  /** Localized introduction, with the package.json description as fallback. */
  description: z.string().optional(),
  enabled: z.boolean(),
  installed: z.boolean(),
  kind: z.enum(["bundle", "dependency", "missing"]),
  protected: z.boolean(),
  official: z.boolean(),
  client: z.boolean(),
  platformSupported: z.boolean(),
  platformReason: z.string().optional(),
  removable: z.boolean(),
  updatable: z.boolean(),
  update: z.string().optional(),
  rows: z.array(bundleRowSchema),
});

export const pluginsSnapshotSchema = z.object({
  profile: z.string(),
  dir: z.string(),
  displayDir: z.string(),
  bundles: z.array(bundleInfoSchema),
  busy: z.boolean(),
  activeJobId: z.string().optional(),
  activeJobKind: jobKindSchema.optional(),
  ...failureFields,
});

export const jobStatusSchema = z.object({
  id: z.string(),
  kind: jobKindSchema,
  state: jobStateSchema,
  output: z.string(),
  updates: z.record(z.string(), z.string()).optional(),
  /** Per-target outcomes of an `update-all` job, in the order they ran. */
  updateResults: z.array(updateOutcomeSchema).optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  ...failureFields,
});

export const setEnabledInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
});

export const setEnabledOutputSchema = z.object({
  ok: z.boolean(),
  changed: z.boolean(),
  enabled: z.boolean(),
  ...failureFields,
});

export const inspectSpecInputSchema = z.object({
  spec: z.string().min(1),
});

export const inspectSpecOutputSchema = z.object({
  ok: z.boolean(),
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  client: z.boolean(),
  ...failureFields,
});

export const startJobInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("install"), spec: z.string().min(1) }),
  z.object({ kind: z.literal("remove"), name: z.string().min(1) }),
  z.object({ kind: z.literal("update"), name: z.string().min(1), version: z.string().min(1) }),
  // The page sends the rows it showed as updatable; the server re-derives the
  // updatable set and refuses to touch anything else (official bundles).
  z.object({ kind: z.literal("update-all"), targets: z.array(updateTargetSchema).min(1) }),
  z.object({ kind: z.literal("check") }),
]);

export const startJobOutputSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  ...failureFields,
});

export const jobIdInputSchema = z.object({
  id: z.string().min(1),
});

export type JobKind = z.infer<typeof jobKindSchema>;
export type JobState = z.infer<typeof jobStateSchema>;
export type FailureCode = z.infer<typeof failureCodeSchema>;
export type BundleRow = z.infer<typeof bundleRowSchema>;
export type BundleInfo = z.infer<typeof bundleInfoSchema>;
export type PluginsSnapshot = z.infer<typeof pluginsSnapshotSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type UpdateTarget = z.infer<typeof updateTargetSchema>;
export type UpdateOutcome = z.infer<typeof updateOutcomeSchema>;
export type SetEnabledInput = z.infer<typeof setEnabledInputSchema>;
export type SetEnabledOutput = z.infer<typeof setEnabledOutputSchema>;
export type InspectSpecOutput = z.infer<typeof inspectSpecOutputSchema>;
export type StartJobInput = z.infer<typeof startJobInputSchema>;
export type StartJobOutput = z.infer<typeof startJobOutputSchema>;

export const listRpc = defineRpc({
  name: "dsh-plugins.list",
  input: z.object({ locale: pluginLocaleSchema.optional() }),
  output: pluginsSnapshotSchema,
});

export const setEnabledRpc = defineRpc({
  name: "dsh-plugins.set-enabled",
  input: setEnabledInputSchema,
  output: setEnabledOutputSchema,
});

export const inspectSpecRpc = defineRpc({
  name: "dsh-plugins.inspect",
  input: inspectSpecInputSchema,
  output: inspectSpecOutputSchema,
});

export const startJobRpc = defineRpc({
  name: "dsh-plugins.start-job",
  input: startJobInputSchema,
  output: startJobOutputSchema,
});

export const jobStatusRpc = defineRpc({
  name: "dsh-plugins.job",
  input: jobIdInputSchema,
  output: jobStatusSchema,
});