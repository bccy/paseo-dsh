import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SYSTEM_ACCOUNT_ID, type QuotaGroup } from "../../shared/antigravity/contracts";
import { REAL_CLI_DIR, profileCliDir, profileHome } from "./paths";

/** agy 1.5 keeps Google sign-ins in one OS keyring entry unless it believes it runs over SSH. */
export const FAKE_SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0";

/**
 * Environment added to an agent session on a profile account. HOME moves agy's data directory and
 * hides the keyring sign-in; SSH_CONNECTION makes agy store its own sign-in in a file inside HOME.
 * ANTIGRAVITY_HOME is ignored by agy, but Paseo's built-in usage source reads it to show the quota
 * of the account the agent runs on.
 */
export function sessionEnv(accountId: string, current: Readonly<Record<string, string>>): Record<string, string> {
  if (accountId === SYSTEM_ACCOUNT_ID) return {};
  return {
    HOME: profileHome(accountId),
    SSH_CONNECTION: current.SSH_CONNECTION || FAKE_SSH_CONNECTION,
    ANTIGRAVITY_HOME: profileCliDir(accountId),
  };
}

/** Full environment for the plugin's own agy calls (probes and sign-in). */
export function commandEnv(accountId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) base[key] = value;
  Object.assign(env, sessionEnv(accountId, base));
  // Never let a probe or sign-in open a browser on the daemon host or update the CLI.
  env.BROWSER = "/usr/bin/false";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  return env;
}

export function accountHome(accountId: string): string {
  return accountId === SYSTEM_ACCOUNT_ID ? os.homedir() : profileHome(accountId);
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when `stopWhen` matched and the process was stopped early. */
  stopped: boolean;
}

/** Runs agy with stdin closed, a byte cap, and a hard timeout. */
export function runAgy(
  agyPath: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; stopWhen?: RegExp },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(agyPath, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stopped = false;
    const cap = 4 * 1024 * 1024;
    const check = () => {
      if (stopped || !options.stopWhen) return;
      if (options.stopWhen.test(stdout) || options.stopWhen.test(stderr)) {
        stopped = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString("utf8");
      check();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString("utf8");
      check();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut, stopped });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, stopped });
    });
  });
}

export async function agyVersion(agyPath: string): Promise<string | null> {
  const result = await runAgy(agyPath, ["--version"], {
    env: commandEnv(SYSTEM_ACCOUNT_ID),
    cwd: os.tmpdir(),
    timeoutMs: 8000,
  });
  return /\b\d+\.\d+\.\d+\S*/.exec(result.stdout)?.[0] ?? null;
}

const usageResponse = z.object({
  status: z.string(),
  error: z.string().optional(),
  response: z.string().optional(),
  command: z
    .object({
      name: z.string(),
      data: z.object({
        groups: z.array(
          z.object({
            name: z.string(),
            buckets: z.array(
              z.object({
                id: z.string().min(1),
                name: z.string(),
                window: z.string(),
                remaining_fraction: z.number().min(0).max(1).nullish(),
                reset_time: z.string().nullish(),
                disabled: z.boolean().optional(),
              }),
            ),
          }),
        ),
      }),
    })
    .optional(),
});

export type ProbeResult =
  | { kind: "signed-in"; quota: QuotaGroup[] }
  | { kind: "signed-out"; detail: string }
  | { kind: "error"; detail: string };

const SIGN_IN_TEXT = /(authentication required|authentication failed|not signed in|sign in|log in|login)/i;
/** agy prints this and then waits up to 60 s for a code; there is no point waiting. */
export const NEEDS_SIGN_IN = /Authentication required|paste the authorization code/i;

function firstMeaningfulLine(text: string): string {
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0 && !value.startsWith("https://"));
  return (line ?? "").slice(0, 300);
}

/** Reads an account's quota with `agy -p /usage`, which also tells whether it is signed in. */
export async function probeAccount(agyPath: string, accountId: string): Promise<ProbeResult> {
  const result = await runAgy(agyPath, ["-p", "/usage", "--output-format", "json"], {
    env: commandEnv(accountId),
    cwd: accountId === SYSTEM_ACCOUNT_ID ? os.tmpdir() : profileHome(accountId),
    timeoutMs: 25_000,
    stopWhen: NEEDS_SIGN_IN,
  });
  if (result.stopped) return { kind: "signed-out", detail: "Not signed in" };
  const stdout = result.stdout.trim();
  const jsonStart = stdout.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = usageResponse.parse(JSON.parse(stdout.slice(jsonStart)));
      if (parsed.status === "SUCCESS" && parsed.command?.name === "usage") {
        return {
          kind: "signed-in",
          quota: parsed.command.data.groups.map((group) => ({
            name: group.name,
            buckets: group.buckets.map((bucket) => ({
              id: bucket.id,
              name: bucket.name,
              window: bucket.window,
              remainingFraction: bucket.remaining_fraction ?? null,
              // Unused buckets report the Unix epoch instead of a reset time.
              resetTime: bucket.reset_time && !bucket.reset_time.startsWith("1970-01-01") ? bucket.reset_time : null,
              disabled: bucket.disabled === true,
            })),
          })),
        };
      }
      const detail = parsed.error || parsed.response || `agy reported ${parsed.status}`;
      if (SIGN_IN_TEXT.test(detail)) return { kind: "signed-out", detail: firstMeaningfulLine(detail) };
      return { kind: "error", detail: firstMeaningfulLine(detail) };
    } catch {
      // Fall through to the text checks below.
    }
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (SIGN_IN_TEXT.test(combined)) {
    return { kind: "signed-out", detail: "Not signed in" };
  }
  if (result.timedOut) return { kind: "error", detail: "agy did not answer within 25 seconds" };
  return {
    kind: "error",
    detail: firstMeaningfulLine(combined) || `agy exited with code ${String(result.code)}`,
  };
}

export interface AccountPlan {
  /** agy's tier id, for example "g1-pro-tier". */
  id: string;
  /** The plan's name, for example "Google AI Pro". */
  name: string;
}

const PLAN_TIMEOUT_MS = 15_000;
/** The consumer Google sign-in, the one agy uses for Google AI plans. */
const PERSONAL_SIGN_IN = "oauth-personal";

const acpInitialize = z.object({
  agentCapabilities: z.object({
    _meta: z.object({ antigravity: z.object({ tier: z.literal(true) }) }),
  }),
  authMethods: z.array(z.object({ id: z.string() })),
});

const acpAuthenticate = z.object({
  _meta: z.object({
    antigravity: z.object({ tier: z.object({ id: z.string(), name: z.string().trim().min(1) }) }),
  }),
});

/**
 * The Google AI plan of a signed-in account, for example "Google AI Ultra". `/usage` does not
 * report it. agy's ACP server advertises `_meta.antigravity.tier` and answers `authenticate` with
 * the account's tier, reusing the stored sign-in. For a signed-out account `authenticate` would
 * start a sign-in instead, so call this only after the quota probe found the account signed in.
 * Returns null when agy does not report a plan.
 */
export function readPlan(agyPath: string, accountId: string): Promise<AccountPlan | null> {
  return new Promise((resolve) => {
    const child = spawn(agyPath, ["acp", "--disable-telemetry"], {
      cwd: accountId === SYSTEM_ACCOUNT_ID ? os.tmpdir() : profileHome(accountId),
      env: commandEnv(accountId),
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => finish(null), PLAN_TIMEOUT_MS);
    function finish(plan: AccountPlan | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      resolve(plan);
    }
    function send(id: number, method: string, params: unknown) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    }
    function answer(message: { id?: unknown; result?: unknown }) {
      if (message.id === 1) {
        const init = acpInitialize.safeParse(message.result);
        if (!init.success || !init.data.authMethods.some((method) => method.id === PERSONAL_SIGN_IN)) {
          finish(null);
          return;
        }
        send(2, "authenticate", { methodId: PERSONAL_SIGN_IN });
      } else if (message.id === 2) {
        const auth = acpAuthenticate.safeParse(message.result);
        finish(auth.success ? auth.data._meta.antigravity.tier : null);
      }
    }
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin.on("error", () => finish(null));
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
      if (NEEDS_SIGN_IN.test(stderr)) finish(null);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      let newline = stdout.indexOf("\n");
      while (newline >= 0 && !settled) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
        if (!line.startsWith("{")) continue;
        try {
          answer(JSON.parse(line) as { id?: unknown; result?: unknown });
        } catch {
          // Not a JSON-RPC message.
        }
      }
      if (stdout.length > 1024 * 1024) finish(null);
    });
    send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
  });
}

const EMAIL_LINE = /authenticated successfully as (\S+@\S+)/g;

/** The Google account agy last reported for this account, from its own logs. */
export async function readAccountEmail(accountId: string): Promise<string | null> {
  const logDir = path.join(
    accountId === SYSTEM_ACCOUNT_ID ? REAL_CLI_DIR : profileCliDir(accountId),
    "log",
  );
  let names: string[];
  try {
    names = await fs.readdir(logDir);
  } catch {
    return null;
  }
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".log"))
      .map(async (name) => {
        const full = path.join(logDir, name);
        const stat = await fs.stat(full).catch(() => null);
        return stat?.isFile() ? { full, mtime: stat.mtimeMs } : null;
      }),
  );
  const recent = files
    .filter((file): file is { full: string; mtime: number } => file !== null)
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, 25);
  for (const file of recent) {
    const text = await fs.readFile(file.full, "utf8").catch(() => "");
    let last: string | null = null;
    for (const match of text.matchAll(EMAIL_LINE)) last = match[1] ?? null;
    if (last) return last.replace(/[.,;)]+$/, "");
  }
  return null;
}
