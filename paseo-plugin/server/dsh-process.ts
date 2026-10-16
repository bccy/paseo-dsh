/**
 * One `dsh --profile paseo` child process, speaking the bridge's stdio JSON-RPC.
 *
 * A process owns exactly one agent session. DSH pins the working directory,
 * provider, model and reasoning effort at `initialize`, so a session per
 * process is what lets Paseo run several workspaces against one provider.
 *
 * @module dsh-paseo/server/dsh-process
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** JSON-compatible value tree. */
export type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

/** Provider/model/thinking route pinned for the life of one process. */
export interface DshRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/**
 * One MCP server Paseo attached to this session, mirroring the provider
 * contract's `ProviderMcpServerConfig`. `alwaysLoad` is deliberately absent: it
 * is a loading hint for runtimes that have one, and DSH has no equivalent.
 */
export type DshMcpServer =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

/**
 * One switchable DSH permission preset. `name` is the display label its own
 * configuration declares and defaults to `value` in DSH, so the composer shows
 * the deployment's label instead of a raw key.
 */
export interface DshPermissionPreset {
  /** The preset key `/permission` accepts; never the display label. */
  value: string;
  /** The display label, falling back to {@link value} when none is configured. */
  name: string;
  description?: string;
}

/** One question the model asked, mirroring DSH's `AskUserQuestionItem`. */
export interface DshQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  intent?: { kind: string; approve?: string; callId?: string };
}

/** One answer batch returned to DSH. */
export interface DshAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>;
}

/** A server -> client question request raised by the DSH bridge. */
export interface DshQuestionRequest {
  callId: string | null;
  timed: boolean;
  questions: DshQuestion[];
  /** Native session id of the asking agent; absent for older bridges. */
  sessionId?: string;
}

/**
 * A server -> client notice that a native subagent child session exists. The
 * ids are DSH's own: `sessionId` is the child's native session id, and
 * `parentSessionId` is the direct parent's native session id.
 */
export interface DshChildOpened {
  sessionId: string;
  parentSessionId: string;
  mode?: string;
  label?: string;
  cwd?: string;
}

/** A `session.event` payload's outer envelope. */
export interface DshSessionEvent {
  sessionId: string;
  event: { type: string; [key: string]: unknown };
}

/** One model the runtime advertises, with its adapter-owned reasoning efforts. */
export interface DshCatalogModel {
  provider: string;
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    defaultEffort?: string;
    efforts: Array<{ id: string; name: string; description?: string }>;
  };
}

/** The runtime's provider/model catalog. */
export interface DshCatalog {
  providers: Array<{ id: string; name: string }>;
  models: DshCatalogModel[];
  defaultProvider?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string | null;
  planMode?: boolean;
}

/**
 * The session's current context occupancy, measured by DSH's own token meter.
 * Fields are absent when the runtime does not know them; a caller must never
 * substitute a default, because a fabricated window is worse than none.
 */
export interface DshUsage {
  available: boolean;
  /** Current context capacity of the live route, in tokens. */
  contextWindow?: number;
  /** Tokens the next request's prompt is expected to occupy. */
  usedTokens?: number;
}

/**
 * One entry of the composer's `/` menu. `kind` decides how running it works:
 * a registered `command` executes in the runtime, a `skill` rides a `/name`
 * user message that DSH's skill tool turns into an injected instruction set.
 */
export interface DshCommand {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "command" | "skill";
}

export interface DshProcessHandlers {
  onEvent(payload: DshSessionEvent): void;
  /** `sessionId` is DSH's own id, so the caller can route by session. */
  onStatus(status: string, sessionId: string): void;
  onQuestion(request: DshQuestionRequest, sessionId: string): Promise<DshAnswer>;
  /** A native subagent child session was observed; Paseo may show it. */
  onChildOpened?(payload: DshChildOpened): void;
  onLog(line: string): void;
  onExit(code: number | null, signal: string | null): void;
  onProtocolError(message: string): void;
}

export interface DshProcessOptions extends DshProcessHandlers {
  cwd: string;
  route: DshRoute;
  sessionId: string;
  /** Extra environment for the child; merged over the daemon's environment. */
  env?: Record<string, string>;
  /**
   * MCP servers Paseo handed this session. DSH resolves MCP servers only at
   * boot, so `start()` turns them into a per-process `--patch` overlay; a
   * session with none spawns exactly as before.
   */
  mcpServers?: Readonly<Record<string, DshMcpServer>>;
  /**
   * Whether `start()` pins a route with `initialize`. Catalog reads skip it,
   * because `paseo/catalog` needs no agent and a bad route must not hide the
   * model list that would let the user pick a good one.
   */
  initializeRoute?: boolean;
}

const BINARY_CANDIDATES = [
  process.env.DSH_BINARY,
  "dsh",
  `${process.env.HOME ?? ""}/.local/bin/dsh`,
].filter((value): value is string => typeof value === "string" && value.length > 0);

function resolveBinary(): string {
  for (const candidate of BINARY_CANDIDATES) {
    if (candidate.includes("/") && existsSync(candidate)) return candidate;
    if (!candidate.includes("/")) return candidate;
  }
  return "dsh";
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === "object" && value !== null && "message" in value) {
    return new Error(String((value as { message: unknown }).message));
  }
  return new Error(fallback);
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** The DSH plugin each injected MCP server is mounted through. */
const MCP_CLIENT_PLUGIN = "@deepseek-ai/dsh-mcp-client";

/** DSH's `serverName` contract: a tool-name namespace, not a free-form label. */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** One prepared `--patch` overlay and the private directory holding it. */
interface McpPatch {
  path: string;
  dir: string;
}

/** Translate one Paseo MCP server into a `dsh-mcp-client` patch entry. */
function mcpEntry(name: string, server: DshMcpServer): Record<string, unknown> {
  if (!MCP_SERVER_NAME.test(name)) {
    throw new Error(
      `MCP server "${name}" cannot be mounted in DSH: a serverName must match ${MCP_SERVER_NAME.source}`,
    );
  }
  // `failOnStartupError` is what keeps a broken connection loud: DSH still boots
  // and the entry is reported as "did not activate" on stderr, which this
  // process forwards to the log, instead of the model silently getting no tools.
  if (server.type === "stdio") {
    return {
      id: `mcp-${name}`,
      name: MCP_CLIENT_PLUGIN,
      config: {
        serverName: name,
        transport: "stdio",
        command: server.command,
        ...(server.args === undefined ? {} : { args: server.args }),
        ...(server.env === undefined ? {} : { env: server.env }),
        failOnStartupError: true,
      },
    };
  }
  if (server.type === "sse") {
    // dsh-mcp-client speaks stdio and Streamable HTTP only. Retrying a legacy
    // SSE endpoint as Streamable HTTP fails with an error that names the wrong
    // cause, so refuse the server by name instead of guessing at a transport.
    throw new Error(
      `MCP server "${name}" uses the legacy "sse" transport, which DSH does not support`
        + ' (only "stdio" and Streamable HTTP)',
    );
  }
  return {
    id: `mcp-${name}`,
    name: MCP_CLIENT_PLUGIN,
    config: {
      serverName: name,
      transport: "streamable-http",
      url: server.url,
      ...(server.headers === undefined ? {} : { headers: server.headers }),
      failOnStartupError: true,
    },
  };
}

/**
 * Write the `--patch` overlay that mounts Paseo's MCP servers into this DSH
 * process, or `undefined` when the session was handed none.
 *
 * The overlay cannot live in the shared profile: the server Paseo injects
 * carries this agent's id in its URL, so it differs per session. The file also
 * carries the MCP auth token, so it is written 0600 inside a fresh 0700
 * directory and removed together with the process.
 */
function prepareMcpPatch(
  servers: Readonly<Record<string, DshMcpServer>> | undefined,
): McpPatch | undefined {
  const list = servers ?? {};
  const names = Object.keys(list);
  if (names.length === 0) return undefined;
  // Translate and validate everything before touching the filesystem, so a
  // rejected server leaves no directory behind.
  const entries = names.map((name) => mcpEntry(name, list[name]));
  const dir = mkdtempSync(join(tmpdir(), "dsh-paseo-mcp-"));
  const path = join(dir, "mcp-patch.json");
  // JSON is a YAML subset and DSH parses the patch as YAML, so emitting JSON is
  // how a URL or token containing YAML-significant characters survives intact.
  writeFileSync(path, `${JSON.stringify([{ insert: entries }], null, 2)}\n`, { mode: 0o600 });
  return { path, dir };
}

export class DshProcess {
  readonly #options: DshProcessOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #initializeTask: Promise<void> | undefined;
  #patch: McpPatch | undefined;

  constructor(options: DshProcessOptions) {
    this.#options = options;
  }

  /** Spawn the child and complete `initialize`. Idempotent. */
  start(): Promise<void> {
    this.#initializeTask ??= this.#start();
    return this.#initializeTask;
  }

  async #start(): Promise<void> {
    // A rejected MCP server throws here, before any process exists: `start()`
    // rejects, the provider reports it, and nothing is left on disk.
    this.#patch = prepareMcpPatch(this.#options.mcpServers);
    const args = ["--profile", process.env.DSH_PASEO_PROFILE ?? "paseo"];
    if (this.#patch !== undefined) args.push("--patch", this.#patch.path);
    const child = spawn(resolveBinary(), args, {
      cwd: this.#options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.#options.env },
    });
    this.#child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") this.#options.onLog(line);
      }
    });
    child.on("error", (error) => {
      this.#cleanupPatch();
      this.#failAll(error);
      this.#options.onProtocolError(error.message);
    });
    child.on("exit", (code, signal) => {
      this.#cleanupPatch();
      this.#closed = true;
      this.#failAll(new Error("DeepSeek Harness process ended"));
      this.#options.onExit(code, signal);
    });

    if (this.#options.initializeRoute === false) return;

    await this.#request("initialize", {
      cwd: this.#options.cwd,
      provider: this.#options.route.provider,
      model: this.#options.route.model,
      ...(this.#options.route.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: this.#options.route.reasoningEffort }),
    });
  }

  /** Read the runtime's provider/model catalog without creating an agent. */
  async catalog(): Promise<DshCatalog> {
    return (await this.#request("paseo/catalog", {}, 60000)) as DshCatalog;
  }

  /** List the session's registered commands and user-invocable skills. */
  async commands(): Promise<DshCommand[]> {
    const result = (await this.#request(
      "paseo/commands",
      { sessionId: this.#options.sessionId },
      60000,
    )) as { commands?: DshCommand[] };
    return result.commands ?? [];
  }

  /** Execute one registered slash command (skills are sent as text instead). */
  async runCommand(name: string, args: string): Promise<{ kind: "success" | "error"; text?: string }> {
    return (await this.#request("paseo/command/run", {
      sessionId: this.#options.sessionId,
      name,
      arguments: args,
    })) as { kind: "success" | "error"; text?: string };
  }

  /**
   * Read the session's current permission preset and the switchable ones.
   *
   * `name` is the label the preset's own configuration declares (falling back to
   * the key in DSH), so a deployment that renames its presets — including into
   * another language — sees its label rather than the raw key. `value` stays the
   * key `/permission` accepts.
   */
  async permission(): Promise<{
    available: boolean;
    current: string | null;
    presets: DshPermissionPreset[];
  }> {
    return (await this.#request("paseo/permission", {
      sessionId: this.#options.sessionId,
    })) as { available: boolean; current: string | null; presets: DshPermissionPreset[] };
  }

  /**
   * Read the session's current context occupancy from the runtime's own token
   * meter. Absent fields mean the runtime does not know them yet; they are
   * never defaulted here.
   */
  async usage(): Promise<DshUsage> {
    return (await this.#request("paseo/usage", {
      sessionId: this.#options.sessionId,
    })) as DshUsage;
  }

  /** Send one text prompt. Resolves when the bridge accepts it, not when the turn ends. */
  async prompt(
    text: string,
    contentBlocks?: unknown[],
    delivery?: "auto" | "steer",
  ): Promise<void> {
    await this.#request("session/prompt", {
      sessionId: this.#options.sessionId,
      contentBlocks: contentBlocks ?? [{ type: "text", text }],
      ...(delivery === undefined ? {} : { delivery }),
    });
  }

  /** Cancel the running turn while keeping the session usable afterwards. */
  async cancel(): Promise<void> {
    await this.#request("session/cancel", { sessionId: this.#options.sessionId });
  }

  /** Select plan mode and return the committed state. */
  async setPlan(active: boolean): Promise<{ active: boolean; pending: boolean; outcome?: string }> {
    return (await this.#request("paseo/plan/set", {
      sessionId: this.#options.sessionId,
      active,
    })) as { active: boolean; pending: boolean; outcome?: string };
  }

  /** Read the committed plan state. */
  async getPlan(): Promise<{ active: boolean; pending: boolean; available: boolean }> {
    return (await this.#request("paseo/plan/get", {
      sessionId: this.#options.sessionId,
    })) as { active: boolean; pending: boolean; available: boolean };
  }

  /** Switch model and/or reasoning effort on the live agent. */
  async setConfig(changes: {
    model?: string;
    provider?: string;
    reasoningEffort?: string | null;
    preset?: string;
  }): Promise<{ provider: string; model: string; reasoningEffort: string | null; preset?: string | null }> {
    return (await this.#request("paseo/config/set", {
      sessionId: this.#options.sessionId,
      ...changes,
    })) as { provider: string; model: string; reasoningEffort: string | null; preset?: string | null };
  }

  /** List the profile's agent presets and the one this session runs. */
  async presets(): Promise<{
    available: boolean;
    presets: Array<{ id: string; name?: string; description?: string; broken?: string }>;
    current: string | null;
    default: string | null;
  }> {
    return (await this.#request("paseo/presets", {
      sessionId: this.#options.sessionId,
    })) as {
      available: boolean;
      presets: Array<{ id: string; name?: string; description?: string; broken?: string }>;
      current: string | null;
      default: string | null;
    };
  }

  /** List the DSH sessions a user could import into Paseo. */
  async sessions(options: { query?: string; cwd?: string; limit?: number } = {}): Promise<
    Array<{ sessionId: string; cwd?: string; title?: string; preview?: string; updatedAt?: string }>
  > {
    const result = (await this.#request(
      "paseo/sessions",
      {
        ...(options.query === undefined ? {} : { query: options.query }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      },
      60000,
    )) as { sessions?: Array<{ sessionId: string; cwd?: string; title?: string; preview?: string; updatedAt?: string }> };
    return result.sessions ?? [];
  }

  /** Read one session's stored event log, for replaying into a timeline. */
  async history(sessionId = this.#options.sessionId): Promise<{
    events: Array<{ type: string; seq?: number; time?: number; data: unknown }>;
    /** Leading events inherited from a fork parent; own history starts here. */
    inheritedEventCount: number;
  }> {
    const result = (await this.#request(
      "paseo/history",
      { sessionId },
      60000,
    )) as {
      events?: Array<{ type: string; seq?: number; time?: number; data: unknown }>;
      inheritedEventCount?: number;
    };
    return {
      events: result.events ?? [],
      inheritedEventCount:
        typeof result.inheritedEventCount === "number" && result.inheritedEventCount > 0
          ? result.inheritedEventCount
          : 0,
    };
  }

  /**
   * List the native subagent children reachable from this session, for
   * rebuilding the tree on replay. Read-only: DSH reads its durable catalog
   * without loading or resuming any child agent. `available: false` means the
   * runtime composes no subagent service; a failed read carries `error`, and an
   * unreadable branch is reported in `diagnostics` — never a silent empty list.
   */
  /**
   * Ask DSH to archive or unarchive one of its sessions.
   *
   * The plugin owns no archive state of its own: DSH does, and Paseo's adapters
   * translate their archive action into the provider's native one.
   */
  async setArchived(sessionId: string, archived: boolean): Promise<{ available: boolean; error?: { message: string } }> {
    try {
      const result = (await this.#request(
        archived ? "paseo/archive" : "paseo/unarchive",
        { sessionId },
      )) as { available?: boolean; error?: { message?: string } };
      return {
        available: result.available === true,
        ...(result.error?.message === undefined ? {} : { error: { message: result.error.message } }),
      };
    } catch (error) {
      return { available: false, error: { message: toError(error, "archive request failed").message } };
    }
  }

  async subagents(): Promise<{
    available: boolean;
    subagents: Array<{ sessionId: string; parentSessionId: string; mode?: string; label?: string; archived?: boolean }>;
    diagnostics?: unknown[];
    error?: { message: string };
  }> {
    const result = (await this.#request(
      "paseo/subagents",
      { sessionId: this.#options.sessionId },
      60000,
    )) as {
      available?: boolean;
      subagents?: Array<{ sessionId: string; parentSessionId: string; mode?: string; label?: string }>;
      diagnostics?: unknown[];
      error?: { message?: string };
    };
    return {
      available: result.available === true,
      subagents: result.subagents ?? [],
      ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
      ...(result.error === undefined ? {} : { error: { message: result.error.message ?? "subagent listing failed" } }),
    };
  }

  /** Ask the bridge to dispose the agent and exit. */
  async shutdown(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#request("shutdown", {}, 5000);
    } catch {
      /* the child may exit before answering */
    }
    this.kill();
  }

  /** Terminate the child without a protocol shutdown. */
  kill(): void {
    this.#closed = true;
    this.#cleanupPatch();
    this.#child?.kill("SIGTERM");
    const child = this.#child;
    setTimeout(() => {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 4000).unref?.();
  }

  #request(method: string, params: unknown, timeoutMs = 120000): Promise<unknown> {
    if (this.#closed || this.#child === undefined) {
      return Promise.reject(new Error("DeepSeek Harness process is not running"));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`DeepSeek Harness did not answer ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #send(frame: unknown): void {
    try {
      this.#child?.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      this.#options.onProtocolError(toError(error, "failed to write to the bridge").message);
    }
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.#options.onLog(line);
        continue;
      }
      void this.#dispatch(frame);
    }
  }

  async #dispatch(frame: Record<string, unknown>): Promise<void> {
    const method = typeof frame.method === "string" ? frame.method : undefined;
    const id = frame.id;

    if (method === "paseo/question" && id !== undefined) {
      try {
        const params = (frame.params ?? {}) as DshQuestionRequest;
        const answer = await this.#options.onQuestion(
          {
            callId: params.callId ?? null,
            timed: params.timed === true,
            questions: params.questions ?? [],
            ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
          },
          typeof params.sessionId === "string" ? params.sessionId : "",
        );
        this.#send({ jsonrpc: "2.0", id, result: answer });
      } catch (error) {
        this.#send({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: toError(error, "question cancelled").message },
        });
      }
      return;
    }

    if (method === "session.event") {
      this.#options.onEvent(frame.params as DshSessionEvent);
      return;
    }
    if (method === "session.status") {
      const params = frame.params as { status?: string; sessionId?: string } | undefined;
      this.#options.onStatus(params?.status ?? "unknown", params?.sessionId ?? "");
      return;
    }
    if (method === "session.child-opened") {
      const params = frame.params as DshChildOpened | undefined;
      if (params !== undefined && typeof params.sessionId === "string" && params.sessionId !== "") {
        this.#options.onChildOpened?.(params);
      }
      return;
    }
    if (method !== undefined) {
      if (id !== undefined) {
        this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported ${method}` } });
      }
      return;
    }

    if (id !== undefined && typeof id === "number") {
      const entry = this.#pending.get(id);
      if (entry === undefined) return;
      this.#pending.delete(id);
      const error = frame.error as { message?: string } | undefined;
      if (error !== undefined) entry.reject(new Error(error.message ?? "bridge request failed"));
      else entry.resolve(frame.result);
    }
  }

  /**
   * Remove the per-process MCP overlay. The child reads it once at boot, so it
   * is deleted as soon as the process is gone: the auth token it carries must
   * not outlive the session. Idempotent.
   */
  #cleanupPatch(): void {
    const patch = this.#patch;
    if (patch === undefined) return;
    this.#patch = undefined;
    try {
      rmSync(patch.dir, { recursive: true, force: true });
    } catch {
      /* the OS reaps the temp directory; never mask the real exit reason */
    }
  }

  #failAll(error: Error): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) entry.reject(error);
  }
}
