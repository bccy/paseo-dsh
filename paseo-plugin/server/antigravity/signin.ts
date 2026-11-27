import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commandEnv } from "./agy";
import { profileHome } from "./paths";

const URL_PATTERN = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/;
const CALLBACK_ORIGIN = "https://antigravity.google";
const PENDING_TTL_MS = 10 * 60 * 1000;
const URL_WAIT_MS = 45_000;
const SUBMIT_WAIT_MS = 90_000;

/** Prefix used when pasted input is rejected locally so the client knows the sign-in session is still alive. */
export const RETRYABLE_INPUT_PREFIX = "Invalid input: ";

interface PendingSignIn {
  loginId: string;
  accountId: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
  url: string;
  state: string | null;
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
  exited: Promise<number | null>;
  submitting: boolean;
}

export interface SubmitOutcome {
  /** True when agy exited 0 after the code; false when it is still running and was stopped. */
  exitedCleanly: boolean;
  /** Milliseconds since epoch just before the code was sent, for the credential scan. */
  submittedAt: number;
}

interface StartingSignIn {
  loginId: string;
  accountId: string;
  child: ChildProcessWithoutNullStreams;
  exited: Promise<number | null>;
  cancelled: boolean;
}

function terminateChild(child: ChildProcessWithoutNullStreams, exited: Promise<number | null>): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // Already exited.
  }
  const killTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, 2000);
  killTimer.unref?.();
  void exited.then(() => clearTimeout(killTimer));
}

function redact(text: string): string {
  return text
    .replace(/https:\/\/\S+/g, "<url>")
    .replace(/\b(code|token|access_token|refresh_token|id_token|client_secret)\s*[:=]\s*[^\s"'&,;)}\]]+/gi, "$1=<redacted>")
    .replace(/(^|[\s"'=:,(])[\w./~+%=-]{32,}(?=$|[\s"'&;,)}\]])/g, "$1<redacted>")
    .trim();
}

function tail(text: string, lines = 6): string {
  return redact(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}

function inputError(message: string): Error {
  return new Error(`${RETRYABLE_INPUT_PREFIX}${message}`);
}

/**
 * Validates what the user pasted: the code Google's page shows, or the full URL of that page.
 * Rejects anything with line breaks so nothing else can be typed into agy.
 */
export function normalizeSignInResponse(pending: { state: string | null }, raw: string): string {
  const value = raw.trim();
  if (/[\r\n]/.test(value)) throw inputError("Paste a single line: the code or the page URL.");
  // Raw OAuth codes may carry `/`, `+`, `=`, `-`, `_`, `~`, `.` or percent-encoded characters like `%2F`.
  if (/^[\w./~+%=-]{1,2048}$/.test(value) && !/^https?:/i.test(value)) {
    if (value.includes("%")) {
      try {
        const decoded = decodeURIComponent(value);
        if (!/[\r\n]/.test(decoded) && /^[\w./~+=-]{1,2048}$/.test(decoded)) return decoded;
      } catch {
        // Leave as-is if not valid percent-encoding.
      }
    }
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw inputError("That is neither a sign-in code nor the URL of the Antigravity page.");
  }
  if (url.origin !== CALLBACK_ORIGIN) {
    throw inputError("Paste the URL of the antigravity.google page Google sent you to.");
  }
  if (!url.searchParams.get("code")) throw inputError("That URL carries no code.");
  const state = url.searchParams.get("state");
  if (pending.state && state && state !== pending.state) {
    throw new Error("That URL belongs to a different sign-in. Start again.");
  }
  return value;
}

/** Runs `agy acp --login` per profile and relays the code the user pastes. */
export class SignInManager {
  private readonly pending = new Map<string, PendingSignIn>();
  private readonly starting = new Map<string, StartingSignIn>();
  private disposed = false;

  async start(agyPath: string, accountId: string): Promise<{ loginId: string; url: string; expiresAt: string }> {
    if (this.disposed) throw new Error("Sign-in manager has been disposed.");
    this.cancelForAccount(accountId);
    const child = spawn(agyPath, ["acp", "--disable-telemetry", "--login"], {
      cwd: profileHome(accountId),
      env: commandEnv(accountId),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Prevent unhandled 'error' events (e.g. EPIPE / ERR_STREAM_DESTROYED) from crashing plugin-process.
    child.stdin.on("error", () => undefined);
    const loginId = randomUUID();
    let output = "";
    const exited = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });
    const startingEntry: StartingSignIn = {
      loginId,
      accountId,
      child,
      exited,
      cancelled: false,
    };
    this.starting.set(loginId, startingEntry);
    let url: string;
    try {
      url = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.stderr.off("data", onData);
          child.off("error", onError);
        };
        const done = (callback: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        const timer = setTimeout(() => {
          done(() => {
            terminateChild(child, exited);
            reject(new Error(`agy did not print a sign-in link within ${URL_WAIT_MS / 1000} seconds. ${tail(output)}`));
          });
        }, URL_WAIT_MS);
        timer.unref?.();
        const onData = (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.length > 64 * 1024) output = output.slice(-32 * 1024);
          const match = URL_PATTERN.exec(output);
          if (match) done(() => resolve(match[0]));
        };
        const onError = (error: Error) => {
          done(() => reject(new Error(`Could not start agy: ${error.message}`)));
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", onError);
        void exited.then((code) => {
          done(() =>
            reject(
              startingEntry.cancelled
                ? new Error("Sign-in was cancelled.")
                : new Error(`agy exited (code ${String(code)}) before printing a sign-in link. ${tail(output)}`),
            ),
          );
        });
      });
    } finally {
      this.starting.delete(loginId);
    }
    if (startingEntry.cancelled || this.disposed) {
      terminateChild(child, exited);
      throw new Error("Sign-in was cancelled.");
    }
    let state: string | null = null;
    try {
      state = new URL(url).searchParams.get("state");
    } catch {
      state = null;
    }
    const expiresAt = Date.now() + PENDING_TTL_MS;
    const entry: PendingSignIn = {
      loginId,
      accountId,
      child,
      output,
      url,
      state,
      expiresAt,
      expiryTimer: setTimeout(() => this.cancel(loginId), PENDING_TTL_MS),
      exited,
      submitting: false,
    };
    entry.expiryTimer.unref?.();
    const keep = (chunk: Buffer) => {
      entry.output += chunk.toString("utf8");
      if (entry.output.length > 64 * 1024) entry.output = entry.output.slice(-32 * 1024);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    void exited.then(() => {
      if (!entry.submitting) this.drop(loginId);
    });
    this.pending.set(loginId, entry);
    return { loginId, url, expiresAt: new Date(expiresAt).toISOString() };
  }

  accountOf(loginId: string): string | undefined {
    return this.pending.get(loginId)?.accountId ?? this.starting.get(loginId)?.accountId;
  }

  /**
   * Sends the code. Resolves when agy exits 0, or after SUBMIT_WAIT_MS with exitedCleanly=false so
   * the caller can check the sign-in itself. Rejects with agy's message when it exits non-zero.
   */
  async submit(loginId: string, raw: string): Promise<SubmitOutcome> {
    const entry = this.pending.get(loginId);
    if (!entry) throw new Error("This sign-in expired or was cancelled. Start again.");
    if (entry.submitting) throw new Error("This sign-in is already being completed.");
    // Local validation throws before touching the child process so the user can fix a bad paste.
    const response = normalizeSignInResponse(entry, raw);
    entry.submitting = true;
    const before = entry.output.length;
    const submittedAt = Date.now() - 5000;
    let submitTimer: NodeJS.Timeout | undefined;
    try {
      const stdin = entry.child.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) {
        throw new Error("Sign-in process is no longer accepting input. Start again.");
      }
      await new Promise<void>((resolve, reject) => {
        stdin.write(`${response}\n`, (err) => {
          if (err) reject(new Error(`Could not send sign-in code to agy: ${err.message}`));
          else resolve();
        });
      });
      const code = await Promise.race([
        entry.exited,
        new Promise<"timeout">((resolve) => {
          submitTimer = setTimeout(() => resolve("timeout"), SUBMIT_WAIT_MS);
          submitTimer.unref?.();
        }),
      ]);
      if (code === "timeout") {
        terminateChild(entry.child, entry.exited);
        return { exitedCleanly: false, submittedAt };
      }
      if (code !== 0) {
        const message = tail(entry.output.slice(before)) || `agy exited with code ${String(code)}`;
        throw new Error(`Sign-in failed: ${message}`);
      }
      return { exitedCleanly: true, submittedAt };
    } finally {
      if (submitTimer) clearTimeout(submitTimer);
      this.drop(loginId);
    }
  }

  cancel(loginId: string): void {
    const startingEntry = this.starting.get(loginId);
    if (startingEntry) {
      startingEntry.cancelled = true;
      this.starting.delete(loginId);
      terminateChild(startingEntry.child, startingEntry.exited);
    }
    const entry = this.pending.get(loginId);
    if (!entry) return;
    terminateChild(entry.child, entry.exited);
    this.drop(loginId);
  }

  cancelForAccount(accountId: string): void {
    for (const entry of [...this.starting.values()]) {
      if (entry.accountId === accountId) this.cancel(entry.loginId);
    }
    for (const entry of [...this.pending.values()]) {
      if (entry.accountId === accountId) this.cancel(entry.loginId);
    }
  }

  cancelAll(): void {
    this.disposed = true;
    for (const loginId of [...this.starting.keys()]) this.cancel(loginId);
    for (const loginId of [...this.pending.keys()]) this.cancel(loginId);
  }

  private drop(loginId: string): void {
    const entry = this.pending.get(loginId);
    if (!entry) return;
    clearTimeout(entry.expiryTimer);
    this.pending.delete(loginId);
  }
}
