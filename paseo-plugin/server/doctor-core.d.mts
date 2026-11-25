export const MINIMUM_PASEO: string;
export const MINIMUM_DSH: string;
export const BRIDGE_PACKAGE: string;
export const CREDENTIAL_REF: RegExp;
export const CREDENTIALS_GROUP_OTHER: number;
export const DUMP_TIMEOUT_MS: number;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export type DoctorCheckLevel = "ok" | "warn" | "fail";

export type DoctorCheckCategory =
  | "cli"
  | "plugin"
  | "profile"
  | "bridge"
  | "route"
  | "composition"
  | "credentials";

export interface DoctorCheckItem {
  id: string;
  category: DoctorCheckCategory;
  level: DoctorCheckLevel;
  label: string;
  detail?: string;
  fixHint?: string;
}

export interface DoctorFileInspection {
  dshHome: string;
  profile: string;
  profileFromEnv: boolean;
  profileDir: string;
  binary: string;
  launcher: { command: string; args: string[] };
  dshPath?: string;
  platform: string;
  profileExists: boolean;
  profileBundle: {
    ok: boolean;
    bundles: string[];
    label?: string;
    detail?: string;
    fixHint?: string;
  };
  bridge: {
    status: "provisioned" | "shadowed" | "incomplete" | "missing" | "unverified";
    location: "shared" | "local" | "both" | "none";
    activeDir: string;
    localDir: string;
    sharedDir: string;
    localExists: boolean;
    sharedExists: boolean;
    shadowed: boolean;
    fileListError?: string;
    entryExists: boolean;
    expectedFiles: number;
    presentFiles: number;
    missingFiles: string[];
  };
  yamlAvailable: boolean;
  patch: {
    path: string;
    exists: boolean;
    readError?: string;
    yamlError?: string;
    listError?: string;
    status:
      | "configured"
      | "missing-patch"
      | "invalid-yaml"
      | "invalid-patch"
      | "missing-default"
      | "disabled"
      | "incomplete"
      | "unknown-provider"
      | "unverified";
    defaultProvider?: string;
    defaultModel?: string;
    defaultReasoningEffort?: string;
    label?: string;
    detail?: string;
    fixHint?: string;
  };
  providers: Array<{
    id: string;
    displayName?: string;
    api?: string;
    baseUrlHost?: string;
    apiKeyEnv?: string;
    credentialReady?: boolean;
    isDefault: boolean;
    models: Array<{ id: string; name?: string }>;
  }>;
  referencedApiKeyEnvs: string[];
  credentials: {
    path: string;
    exists: boolean;
    readable: boolean;
    readError?: string;
    mode?: number;
    modeBits?: number;
    modeOctal?: string;
    ownerOnly?: boolean;
    formatValid?: boolean;
    legacy: boolean;
    contractProblems: Array<{ label: string; detail: string; fixHint?: string }>;
    referencedRefs: Array<{ name: string; present: boolean }>;
    missingRefs: string[];
    status:
      | "ready"
      | "missing-file"
      | "unreadable"
      | "bad-permissions"
      | "invalid-yaml"
      | "invalid-contract"
      | "missing-refs"
      | "no-refs-needed"
      | "unverified";
    fixHint?: string;
  };
}

export interface RawDoctorReport {
  fatalError?: string;
  pluginVersion?: string;
  dshHome: string;
  profile: string;
  profileFromEnv: boolean;
  profileDir: string;
  binary: string;
  dshPath?: string;
  dshVersion?: string;
  paseoVersion?: string;
  checks: DoctorCheckItem[];
  summary: {
    ok: number;
    warn: number;
    fail: number;
    total: number;
    blocking: boolean;
    exitCode: number;
  };
  timedOut: boolean;
}

export function resolveDshHome(
  env?: Readonly<Record<string, string | undefined>>,
  cwd?: string,
): string;

export function bridgeLocations(
  profileDir: string,
  dshHome: string,
): { local: string; shared: string };

export function profileBundleVerdict(
  profileDir: string,
  profile: string,
):
  | { ok: true; bundles: string[] }
  | { ok: false; bundles: string[]; label: string; detail: string; fixHint: string };

export function credentialContract(
  document: unknown,
  text: string,
  path: string,
): {
  refs: Record<string, unknown>;
  problems: Array<{ label: string; detail: string; fixHint: string }>;
  legacy: boolean;
};

export function atLeast(version: unknown, minimum: string): boolean;

export function parseVersion(value: unknown): ParsedVersion | undefined;

export function compareCore(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number;

export function redactBaseUrlHost(rawUrl: unknown): string | undefined;

export function loadBridgeFileList(
  pluginDir?: string,
): { keys: string[]; error?: undefined } | { keys?: undefined; error: string };

export function whichDsh(
  launcher?: { command: string; args: string[] },
  env?: Readonly<Record<string, string | undefined>>,
  platform?: string,
  cwd?: string,
): string | undefined;

export function loadYaml(
  launcher?: { command: string; args: string[] },
  env?: Readonly<Record<string, string | undefined>>,
  platform?: string,
  cwd?: string,
):
  | {
      name: "yaml" | "js-yaml";
      module: { parse?: (s: string) => unknown; load?: (s: string) => unknown };
      viaDsh?: boolean;
    }
  | undefined;

export function inspectInstallFiles(options?: Record<string, unknown>): DoctorFileInspection;

export function runDoctorChecks(options?: Record<string, unknown>): RawDoctorReport;

export function runDoctorChecksAsync(options?: Record<string, unknown>): Promise<RawDoctorReport>;
