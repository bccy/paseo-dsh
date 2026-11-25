/**
 * Shared RPC contract for the DSH console's Environment & Doctor diagnostics.
 *
 * Kept strictly runtime-neutral (Zod schemas + `defineRpc` only; zero Node or
 * React Native imports) so both the daemon server and the client console
 * validate against one source of truth.
 *
 * Security invariant: none of these schemas have fields for raw credential
 * values, `.credentials.yaml` source text, provider auth headers, or raw
 * baseURL credentials/paths.
 *
 * @module dsh-paseo/shared/diagnostics
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DIAGNOSTICS_OVERVIEW_METHOD = "dsh.diagnostics.overview" as const;
/**
 * Wire method name for on-demand full doctor execution.
 * `@getpaseo/plugin` `defineRpc` enforces `/^[a-z][a-z0-9._-]*$/` (lowercase only),
 * so kebab-case `run-doctor` matches `dsh-plugins.set-enabled` / `dsh-plugins.start-job`.
 */
export const DIAGNOSTICS_RUN_DOCTOR_METHOD = "dsh.diagnostics.run-doctor" as const;

export const DOCTOR_CHECK_LEVELS = ["ok", "warn", "fail"] as const;
export const doctorCheckLevelSchema = z.enum(DOCTOR_CHECK_LEVELS);
export type DoctorCheckLevel = z.infer<typeof doctorCheckLevelSchema>;

export const DOCTOR_CHECK_CATEGORIES = [
  "cli",
  "plugin",
  "profile",
  "bridge",
  "route",
  "composition",
  "credentials",
] as const;
export const doctorCheckCategorySchema = z.enum(DOCTOR_CHECK_CATEGORIES);
export type DoctorCheckCategory = z.infer<typeof doctorCheckCategorySchema>;

export const doctorCheckItemSchema = z.object({
  id: z.string(),
  category: doctorCheckCategorySchema,
  level: doctorCheckLevelSchema,
  label: z.string(),
  detail: z.string().optional(),
  fixHint: z.string().optional(),
});
export type DoctorCheckItem = z.infer<typeof doctorCheckItemSchema>;

export const doctorSummarySchema = z.object({
  ok: z.number().int().nonnegative(),
  warn: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  blocking: z.boolean(),
});
export type DoctorSummary = z.infer<typeof doctorSummarySchema>;

export const dshBinaryInfoSchema = z.object({
  configuredBinary: z.string(),
  resolvedPath: z.string().optional(),
  version: z.string().optional(),
  minimumVersion: z.string(),
  versionOk: z.boolean().optional(),
  cached: z.boolean(),
  error: z.string().optional(),
});
export type DshBinaryInfo = z.infer<typeof dshBinaryInfoSchema>;

export const profileInfoSchema = z.object({
  name: z.string(),
  fromEnv: z.boolean(),
  dshHome: z.string(),
  displayDshHome: z.string(),
  dir: z.string(),
  displayDir: z.string(),
  exists: z.boolean(),
  manifestValid: z.boolean(),
  loadsBridgeBundle: z.boolean(),
  bundles: z.array(z.string()),
  issue: z.string().optional(),
});
export type ProfileInfo = z.infer<typeof profileInfoSchema>;

export const BRIDGE_STATUSES = [
  "provisioned",
  "shadowed",
  "incomplete",
  "missing",
  "unverified",
] as const;
export const bridgeStatusSchema = z.enum(BRIDGE_STATUSES);
export type BridgeStatus = z.infer<typeof bridgeStatusSchema>;

export const bridgeInfoSchema = z.object({
  status: bridgeStatusSchema,
  location: z.enum(["shared", "local", "both", "none"]),
  activeDir: z.string(),
  displayActiveDir: z.string(),
  shadowed: z.boolean(),
  localDir: z.string(),
  sharedDir: z.string(),
  expectedFiles: z.number().int().nonnegative(),
  presentFiles: z.number().int().nonnegative(),
  missingFiles: z.array(z.string()),
  issue: z.string().optional(),
});
export type BridgeInfo = z.infer<typeof bridgeInfoSchema>;

export const ROUTE_STATUSES = [
  "configured",
  "missing-patch",
  "invalid-yaml",
  "invalid-patch",
  "missing-default",
  "disabled",
  "incomplete",
  "unknown-provider",
  "unverified",
] as const;
export const routeStatusSchema = z.enum(ROUTE_STATUSES);
export type RouteStatus = z.infer<typeof routeStatusSchema>;

export const defaultRouteInfoSchema = z.object({
  status: routeStatusSchema,
  patchPath: z.string(),
  displayPatchPath: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  issue: z.string().optional(),
});
export type DefaultRouteInfo = z.infer<typeof defaultRouteInfoSchema>;

export const redactedModelInfoSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
});
export type RedactedModelInfo = z.infer<typeof redactedModelInfoSchema>;

export const redactedProviderInfoSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  api: z.string().optional(),
  /** Redacted origin only (`scheme://host`); never userinfo, path, or query string. */
  baseUrlHost: z.string().optional(),
  /** Credential ref NAME only (e.g. `MY_GATEWAY_KEY`); never the secret value. */
  apiKeyEnv: z.string().optional(),
  /** True when the referenced `apiKeyEnv` exists and is non-empty under `refs:`. */
  credentialReady: z.boolean().optional(),
  isDefault: z.boolean(),
  models: z.array(redactedModelInfoSchema),
});
export type RedactedProviderInfo = z.infer<typeof redactedProviderInfoSchema>;

export const CREDENTIALS_STATUSES = [
  "ready",
  "missing-file",
  "unreadable",
  "bad-permissions",
  "invalid-yaml",
  "invalid-contract",
  "missing-refs",
  "no-refs-needed",
  "unverified",
] as const;
export const credentialsStatusSchema = z.enum(CREDENTIALS_STATUSES);
export type CredentialsStatus = z.infer<typeof credentialsStatusSchema>;

export const credentialRefStatusSchema = z.object({
  name: z.string(),
  present: z.boolean(),
});
export type CredentialRefStatus = z.infer<typeof credentialRefStatusSchema>;

export const credentialsInfoSchema = z.object({
  status: credentialsStatusSchema,
  path: z.string(),
  displayPath: z.string(),
  exists: z.boolean(),
  readable: z.boolean(),
  /** Octal POSIX file mode such as `"0600"`; omitted on Windows or when absent. */
  mode: z.string().optional(),
  /** True when group/other permission bits (`0o77`) are zero on POSIX (or on Windows). */
  ownerOnly: z.boolean().optional(),
  formatValid: z.boolean().optional(),
  legacyFlatLayout: z.boolean(),
  /** Sanitized structural contract issues (never raw YAML or secret text). */
  contractIssues: z.array(z.string()),
  referencedRefs: z.array(credentialRefStatusSchema),
  missingRefs: z.array(z.string()),
  fixHint: z.string().optional(),
});
export type CredentialsInfo = z.infer<typeof credentialsInfoSchema>;

export const diagnosticsOverviewInputSchema = z.object({
  /** Bypass the in-memory DSH version cache when true. */
  refreshVersion: z.boolean().optional(),
});
export type DiagnosticsOverviewInput = z.infer<typeof diagnosticsOverviewInputSchema>;

export const diagnosticsOverviewSchema = z.object({
  collectedAt: z.number(),
  pluginVersion: z.string().optional(),
  dsh: dshBinaryInfoSchema,
  profile: profileInfoSchema,
  bridge: bridgeInfoSchema,
  route: defaultRouteInfoSchema,
  providers: z.array(redactedProviderInfoSchema),
  credentials: credentialsInfoSchema,
  hasIssues: z.boolean(),
});
export type DiagnosticsOverview = z.infer<typeof diagnosticsOverviewSchema>;

export const runDoctorInputSchema = z.object({
  /** Optional timeout in ms (clamped server-side to 1s..60s; default 20s). */
  timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
});
export type RunDoctorInput = z.infer<typeof runDoctorInputSchema>;

export const doctorReportSchema = z.object({
  ok: z.boolean(),
  ranAt: z.number(),
  durationMs: z.number().nonnegative(),
  timedOut: z.boolean(),
  sharedInFlight: z.boolean(),
  pluginVersion: z.string().optional(),
  profile: z.string(),
  profileDir: z.string(),
  displayProfileDir: z.string(),
  dshVersion: z.string().optional(),
  paseoVersion: z.string().optional(),
  checks: z.array(doctorCheckItemSchema),
  summary: doctorSummarySchema,
  error: z.string().optional(),
});
export type DoctorReport = z.infer<typeof doctorReportSchema>;

export const diagnosticsOverviewRpc = defineRpc({
  name: DIAGNOSTICS_OVERVIEW_METHOD,
  input: diagnosticsOverviewInputSchema,
  output: diagnosticsOverviewSchema,
});

export const diagnosticsRunDoctorRpc = defineRpc({
  name: DIAGNOSTICS_RUN_DOCTOR_METHOD,
  input: runDoctorInputSchema,
  output: doctorReportSchema,
});
