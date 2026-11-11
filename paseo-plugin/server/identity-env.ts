/**
 * Per-session Paseo identity for the one shared `dsh` child.
 *
 * Paseo's daemon injects `PASEO_AGENT_ID`, `PASEO_AGENT_CWD` and (when the agent
 * belongs to a workspace) `PASEO_WORKSPACE_ID` into every session open. The
 * shared child has one process environment, so it cannot carry any of them
 * (`dsh-process.ts` strips them from the spawn env). They travel instead on the
 * session's `initialize` frame: the bridge records them per DSH session id and
 * republishes the current execution's values as `DSH_PASEO_*` through the public
 * `ctx.shellEnv.register` API.
 *
 * `BASH_ENV` completes the chain for every non-interactive `bash -c` (model bash
 * tool, background jobs, sandbox): it maps those per-execution `DSH_PASEO_*`
 * facts to the real `PASEO_*` names the `paseo` CLI reads. The script does
 * nothing when the shell has no identity — it must never fall back to another
 * session's values.
 *
 * @module dsh-paseo/server/identity-env
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dshHome } from "./bootstrap";

/**
 * The three Paseo identity values of one agent, as Paseo hands them over.
 *
 * Every field is optional: the workspace id is absent for an agent that belongs
 * to no workspace, and a session opened without a Paseo agent identity has none
 * of them. Missing is "unknown", never "reuse another session's value".
 */
export interface PaseoAgentIdentity {
  agentId?: string;
  agentCwd?: string;
  workspaceId?: string;
}

/** Env var names the daemon uses for that identity. */
const ENV_KEYS = {
  agentId: "PASEO_AGENT_ID",
  agentCwd: "PASEO_AGENT_CWD",
  workspaceId: "PASEO_WORKSPACE_ID",
} as const;

/**
 * Extract the identity a session open asked for.
 *
 * Values are trimmed and empty strings are dropped: a daemon that injects the
 * key with an empty value means "no identity", not "empty agent id". Returns
 * `undefined` when the env carries none of the three keys, so callers can omit
 * the frame field entirely instead of sending an empty object.
 *
 * @param env - the session's `config.env`, as received from Paseo.
 */
export function paseoIdentityFromEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): PaseoAgentIdentity | undefined {
  if (env === undefined) return undefined;
  const identity: PaseoAgentIdentity = {};
  for (const field of ["agentId", "agentCwd", "workspaceId"] as const) {
    const raw = env[ENV_KEYS[field]];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value !== "") identity[field] = value;
  }
  return Object.keys(identity).length === 0 ? undefined : identity;
}

/** Single-quote one string for embedding in the generated `bash` script. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The fixed `BASH_ENV` hook content.
 *
 * Only three `if` lines and a `set +e`. It reads nothing except the environment
 * it was started with, exports a `PASEO_*` variable **only** when the matching
 * per-execution `DSH_PASEO_*` value is present and non-empty, and never returns
 * a failing status (`:` at the end). When the child was spawned with a user
 * `BASH_ENV`, that script is sourced last so the user's own behaviour is
 * preserved rather than replaced.
 *
 * @param originalBashEnv - the `BASH_ENV` the spawn env had before this hook.
 */
export function buildIdentityBashEnvScript(originalBashEnv: string | undefined): string {
  const lines = [
    "# Managed by the Paseo bridge plugin. This file is the shared dsh child's",
    "# BASH_ENV hook. Each execution carries its own agent identity as",
    "# DSH_PASEO_* (ctx.shellEnv); map only what THIS shell has, to the real",
    "# PASEO_* names the `paseo` CLI reads. No identity -> export nothing, never",
    "# another session's value. `set +e` keeps a broken hook from breaking bash.",
    "set +e",
    'if [ -n "${DSH_PASEO_AGENT_ID-}" ]; then export PASEO_AGENT_ID="$DSH_PASEO_AGENT_ID"; fi',
    'if [ -n "${DSH_PASEO_AGENT_CWD-}" ]; then export PASEO_AGENT_CWD="$DSH_PASEO_AGENT_CWD"; fi',
    'if [ -n "${DSH_PASEO_WORKSPACE_ID-}" ]; then export PASEO_WORKSPACE_ID="$DSH_PASEO_WORKSPACE_ID"; fi',
  ];
  if (originalBashEnv !== undefined) {
    lines.push(
      "# The spawn env already had BASH_ENV; keep the user's behaviour by running it last.",
      `[ -r ${shellQuote(originalBashEnv)} ] && . ${shellQuote(originalBashEnv)}`,
    );
  }
  lines.push(":");
  return `${lines.join("\n")}\n`;
}

/**
 * Write (or reuse) the `BASH_ENV` hook for one child spawn and return its path.
 *
 * Lives under `$DSH_HOME/paseo/bash-env`, not `/tmp`: DSH's sandbox mounts the
 * host `/tmp` as a tmpfs, so a script written there is invisible inside a
 * sandboxed bash call. `$DSH_HOME` is on the user's home and visible read-only
 * from the sandbox. The file name carries a digest of the original `BASH_ENV`
 * so two spawns with different user hooks never race over one file; the content
 * is deterministic, so a concurrent duplicate write is byte-identical.
 *
 * @param env - the environment the child will be spawned with (before override).
 * @returns absolute path to use as the child's `BASH_ENV`.
 */
export function ensureIdentityBashEnvScript(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const original = typeof env.BASH_ENV === "string" && env.BASH_ENV.trim() !== ""
    ? env.BASH_ENV
    : undefined;
  const digest = createHash("sha256").update(original ?? "\u0000").digest("hex").slice(0, 16);
  const dir = join(dshHome(env), "paseo", "bash-env");
  const file = join(dir, `identity-${digest}.sh`);
  const content = buildIdentityBashEnvScript(original);
  let current: string | undefined;
  if (existsSync(file)) {
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = undefined;
    }
  }
  if (current !== content) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content, { mode: 0o600 });
  }
  return file;
}
