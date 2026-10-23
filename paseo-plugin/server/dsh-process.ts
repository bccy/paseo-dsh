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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { profileName } from "./bootstrap";

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
 * The outcome of a rewind's file rollback, as reported by the bridge.
 *
 * `failed` is the only field that means "the conversation was rewound but a file
 * was not restored"; the provider turns it into a timeline notice. `rescue`
 * lists copies of the content that the restore overwrote, so a user can recover
 * a mistaken restore by hand.
 */
export interface DshRevertFiles {
  restored: string[];
  deleted: string[];
  skipped: string[];
  failed: Array<{ path: string; error: string }>;
  rescue: string[];
  rescueDir: string;
}

/**
 * The bridge's `paseo/revert` receipt.
 *
 * A failed rewind is a thrown RPC error, never a receipt: the bridge writes
 * nothing until its plan is valid, so there is no partial-success `error` kind
 * to represent here.
 */
export interface DshRevertResult {
  kind: "success";
  text?: string;
  files?: DshRevertFiles;
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

/** The DSH plugin each injected stdio MCP server is mounted through. */
const MCP_CLIENT_PLUGIN = "@deepseek-ai/dsh-mcp-client";

/**
 * The bridge bundle's MCP gateway: three discovery/call tools instead of one
 * schema per MCP tool.
 *
 * Streamable-HTTP servers are proxied rather than mounted directly because a
 * server with dozens of tools costs that many schemas in every request — Paseo's
 * own server is 61 tools (~33 KB). The gateway keeps the same endpoint and token
 * flowing (they arrive through this overlay either way) while the model pays for
 * only the tools it actually discovers.
 */
const MCP_GATEWAY_PLUGIN = "dsh-paseo-bridge/mcp-gateway";

/**
 * The stdio servers allowed to ride the gateway instead of the stock client.
 *
 * Proxying is a **capability trade**, not an optimisation: a proxied server's
 * tools stop being callable directly and become reachable only through
 * `mcp_list_tools` / `mcp_tool_schema` / `mcp_call_tool`, so each use costs two
 * extra round trips and the model has to know a tool exists before calling it.
 * That is the right trade only for a server that is wide, rarely used and narrow
 * in purpose — Paseo's Server Browser bridge (25 tools, ~20 KB of schema in every
 * request, called in a minority of sessions).
 *
 * It is the wrong trade for anything a user configured themselves: their stdio
 * MCP was mounted with its full schema on purpose, and silently demoting it to
 * three-step discovery is a regression they never asked for. Hence a whitelist by
 * name rather than "all stdio".
 */
const GATEWAY_STDIO_SERVERS: ReadonlySet<string> = new Set(["server_browser"]);

/**
 * One entry of the gateway's `config.servers` map.
 *
 * The gateway picks the transport from the shape (`url` → Streamable HTTP,
 * `command` → stdio) and refuses an entry that names both or neither, so this
 * union is also the contract for what may be proxied.
 */
type GatewayServerConfig =
  | { url: string; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string> };

/** DSH's `serverName` contract: a tool-name namespace, not a free-form label. */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Name of the browser bridge entry this plugin injects itself.
 *
 * It is also the gateway whitelist entry above: the bridge is stdio-only and
 * declares 25 tools, so mounting it natively would put ~20 KB of schema in every
 * request of every session that merely *has* a browser.
 */
const BROWSER_MCP_SERVER = "server_browser";

/** Expand a leading `~` the way Paseo's own home resolver does. */
function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/** A path from the environment, treating empty/whitespace as unset. */
function envPath(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return resolve(expandHome(raw));
}

/**
 * Paseo's own home directory, resolved like `@getpaseo/server` does.
 *
 * `PASEO_HOME` is set on the daemon's environment and inherited by the plugin
 * process, so a non-default install still finds its workspace registry. Reading
 * `~/.paseo` unconditionally would silently point at the wrong tree there.
 */
function paseoHome(env: Readonly<Record<string, string | undefined>>): string {
  return envPath(env, "PASEO_HOME") ?? join(homedir(), ".paseo");
}

/**
 * The Server Browser plugin's per-workspace data directory.
 *
 * Mirrors the plugin's own resolution (`server/runtime.ts` and
 * `server/browser-manager.ts`): the runtime root defaults to
 * `~/.local/share/paseo-server-browser`, and the data root is `<runtime>/visual`
 * unless `PASEO_SERVER_BROWSER_DATA` names it outright. Both variables exist so a
 * deployment can move the runtime off the home directory, and the bridge path is
 * only ever `join(dataRoot, 'mcp-bridge.mjs')`.
 */
function browserDataRoot(env: Readonly<Record<string, string | undefined>>): string {
  const configured = envPath(env, "PASEO_SERVER_BROWSER_DATA");
  if (configured !== undefined) return configured;
  const runtime = envPath(env, "PASEO_SERVER_BROWSER_RUNTIME")
    ?? join(homedir(), ".local", "share", "paseo-server-browser");
  return join(runtime, "visual");
}

/**
 * Map a session's working directory to the Paseo workspace that owns it.
 *
 * Paseo keeps its registry in `$PASEO_HOME/projects/workspaces.json`, and the
 * browser plugin names each workspace's data directory after `workspaceId`. Only
 * an unarchived workspace whose `cwd` resolves to the same directory counts:
 * archived records keep their `cwd`, and two live records can share one directory
 * (a reopened workspace leaves the old one behind), so an ambiguous match is
 * reported as "no workspace" rather than picking one.
 *
 * @returns the workspace id, or `undefined` when the mapping is missing or unclear.
 */
function browserWorkspaceId(
  cwd: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const raw = readFileSync(join(home, "projects", "workspaces.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return undefined;
  const target = resolve(cwd);
  const matches: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { workspaceId?: unknown; cwd?: unknown; archivedAt?: unknown };
    if (record.archivedAt !== null && record.archivedAt !== undefined) continue;
    if (typeof record.cwd !== "string" || typeof record.workspaceId !== "string") continue;
    if (resolve(record.cwd) !== target) continue;
    // The id becomes a path segment, so a record that is not a plain id is not usable.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(record.workspaceId)) continue;
    matches.push(record.workspaceId);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The Server Browser bridge as an MCP server for one session, or `undefined`.
 *
 * The bridge is a stdio MCP server shipped by Paseo's Server Browser plugin
 * (`<dataRoot>/mcp-bridge.mjs`); it takes the workspace's `session.json` path as
 * its only argument and reads the CDP endpoint and token from that file itself.
 * This function therefore only computes the path — it never reads the metadata,
 * which carries a credential that has no business passing through here.
 *
 * **Fail-open on purpose.** Every failure returns `undefined` and nothing throws:
 * the result is merged into the same `--patch` that mounts Paseo's own 61-tool
 * server, so a throw here would take the agent's whole tool surface down with it.
 * Losing the browser is a degraded feature; losing Paseo's tools is a broken
 * session. A missing `session.json` is *not* checked: it only exists while the
 * browser runs, and the bridge reports that state itself with a clear message,
 * while a patch built at boot must keep working after the user starts the browser.
 *
 * @param cwd - the session's working directory, as passed to `dsh`.
 * @returns a stdio MCP server entry, or `undefined` when the bridge cannot be located.
 */
export function browserMcpServer(cwd: string): DshMcpServer | undefined {
  try {
    const env = process.env;
    const dataRoot = browserDataRoot(env);
    const bridge = join(dataRoot, "mcp-bridge.mjs");
    // A profile without the browser plugin would otherwise mount a server whose
    // command fails at spawn time; DSH reports that as "did not activate", which
    // reads like a plugin bug rather than an absent feature.
    //
    // Every early return below says why on stderr, because fail-open must not turn
    // into fail-silent: when a session has no browser tools, this function is the
    // only place that knows the reason, and "the feature quietly is not there" is
    // precisely the silent-degradation class this repo keeps re-learning (see
    // docs/FIELD-NOTES.md). The provider forwards stderr to the daemon log.
    if (!existsSync(bridge)) {
      logBrowserGap(`bridge not found at ${bridge}`);
      return undefined;
    }
    const workspaceId = browserWorkspaceId(cwd, paseoHome(env), env);
    if (workspaceId === undefined) {
      logBrowserGap(`cwd ${cwd} maps to no single live Paseo workspace`);
      return undefined;
    }
    return {
      type: "stdio",
      command: process.execPath,
      args: [bridge, join(dataRoot, workspaceId, "session.json")],
    };
  } catch (error) {
    // Deliberately swallowed: see the fail-open note above. Logged so an
    // unreadable registry or a malformed file is diagnosable instead of looking
    // like a feature this build simply does not have.
    logBrowserGap(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** One stderr line explaining why a session got no browser MCP server. */
function logBrowserGap(reason: string): void {
  // The provider tags every line it writes with its own id; repeating the literal
  // here keeps this module free of a cycle through `provider.ts`.
  process.stderr.write(`[deepseek-harness-native] no browser MCP server: ${reason}\n`);
}

/** One prepared `--patch` overlay and the private directory holding it. */
interface McpPatch {
  path: string;
  dir: string;
}

/**
 * Translate Paseo's MCP servers into patch entries.
 *
 * Streamable-HTTP servers and the whitelisted stdio servers ride the gateway
 * (one row, three tools). Every other stdio server keeps the stock client: it was
 * configured by the user, and dropping it — or quietly demoting it to discovery
 * calls — would remove capability they asked for. Legacy SSE stays refused.
 */
function mcpEntries(
  servers: Readonly<Record<string, DshMcpServer>>,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const proxied: Record<string, GatewayServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!MCP_SERVER_NAME.test(name)) {
      throw new Error(
        `MCP server "${name}" cannot be mounted in DSH: a serverName must match ${MCP_SERVER_NAME.source}`,
      );
    }
    if (server.type === "stdio") {
      if (GATEWAY_STDIO_SERVERS.has(name)) {
        // Whitelisted: the gateway spawns it and speaks JSON-RPC over its stdio,
        // so the tools cost three meta-schemas instead of one schema each. `env`
        // and `args` pass through untouched — the browser bridge needs both the
        // session-file path and the daemon's environment to find its Chromium.
        proxied[name] = {
          command: server.command,
          ...(server.args === undefined ? {} : { args: server.args }),
          ...(server.env === undefined ? {} : { env: server.env }),
        };
        continue;
      }
      // `failOnStartupError` is what keeps a broken connection loud: DSH still boots
      // and the entry is reported as "did not activate" on stderr, which this
      // process forwards to the log, instead of the model silently getting no tools.
      entries.push({
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
      });
      continue;
    }
    if (server.type === "sse") {
      // The gateway speaks Streamable HTTP only. Retrying a legacy SSE endpoint as
      // Streamable HTTP fails with an error that names the wrong cause, so refuse
      // the server by name instead of guessing at a transport.
      throw new Error(
        `MCP server "${name}" uses the legacy "sse" transport, which DSH does not support`
          + ' (only "stdio" and Streamable HTTP)',
      );
    }
    proxied[name] = {
      url: server.url,
      ...(server.headers === undefined ? {} : { headers: server.headers }),
    };
  }
  if (Object.keys(proxied).length > 0) {
    entries.push({
      id: "paseo-mcp-gateway",
      name: MCP_GATEWAY_PLUGIN,
      inject: ["tools"],
      config: { servers: proxied },
    });
  }
  return entries;
}

/**
 * Write the `--patch` overlay that mounts Paseo's MCP servers into this DSH
 * process, or `undefined` when there is nothing to mount.
 *
 * The overlay cannot live in the shared profile: the server Paseo injects
 * carries this agent's id in its URL, so it differs per session. The file also
 * carries the MCP auth token, so it is written 0600 inside a fresh 0700
 * directory and removed together with the process.
 *
 * The browser bridge is merged in here rather than by Paseo: the Server Browser
 * plugin hands providers no MCP server at all (its bridge is started by the
 * browser panel, not by the agent contract), so without this the agent can only
 * reach the shared browser through the `shared-browser` skill's shell path.
 * Paseo's own entry wins on a name collision — a deployment that starts
 * injecting `server_browser` itself knows better than this heuristic.
 *
 * @param servers - the MCP servers Paseo attached to this session, if any.
 * @param cwd - the session's working directory; identifies the browser workspace.
 * @returns the written overlay, or `undefined` when no server could be mounted.
 */
function prepareMcpPatch(
  servers: Readonly<Record<string, DshMcpServer>> | undefined,
  cwd: string,
): McpPatch | undefined {
  const merged: Record<string, DshMcpServer> = { ...(servers ?? {}) };
  if (!Object.hasOwn(merged, BROWSER_MCP_SERVER)) {
    const browser = browserMcpServer(cwd);
    if (browser !== undefined) merged[BROWSER_MCP_SERVER] = browser;
  }
  if (Object.keys(merged).length === 0) return undefined;
  // Translate and validate everything before touching the filesystem, so a
  // rejected server leaves no directory behind.
  const entries = mcpEntries(merged);
  const dir = mkdtempSync(join(tmpdir(), "dsh-paseo-mcp-"));
  const path = join(dir, "mcp-patch.json");
  // JSON is a YAML subset and DSH parses the patch as YAML, so emitting JSON is
  // how a URL or token containing YAML-significant characters survives intact.
  writeFileSync(path, `${JSON.stringify([{ insert: entries }], null, 2)}\n`, { mode: 0o600 });
  return { path, dir };
}

export class DshProcess {
  readonly #options: DshProcessOptions;
  /**
   * The handlers this process reports to. Mutable on purpose: a rewind's reload
   * parks the idle process and a fresh provider session adopts it, so the same
   * child must start reporting to a new session without being killed and
   * respawned (that spawn is the 1.5–2.7 s half of the refresh latency).
   */
  #handlers: DshProcessHandlers;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #initializeTask: Promise<void> | undefined;
  #patch: McpPatch | undefined;
  /** Resolved once the child is gone; created lazily by {@link waitForExit}. */
  #exited: Promise<void> | undefined;
  #resolveExited: (() => void) | undefined;

  constructor(options: DshProcessOptions) {
    this.#options = options;
    this.#handlers = {
      onEvent: (payload) => options.onEvent(payload),
      onStatus: (status, sessionId) => options.onStatus(status, sessionId),
      onQuestion: (request, sessionId) => options.onQuestion(request, sessionId),
      ...(options.onChildOpened === undefined
        ? {}
        : { onChildOpened: (payload: DshChildOpened) => options.onChildOpened?.(payload) }),
      onLog: (line) => options.onLog(line),
      onExit: (code, signal) => options.onExit(code, signal),
      onProtocolError: (message) => options.onProtocolError(message),
    };
  }

  /** Whether the child is still alive and usable. */
  get running(): boolean {
    return this.#closed === false && this.#child !== undefined;
  }

  /**
   * Point this process at a different set of handlers.
   *
   * Used when an idle process is parked and later adopted by a new provider
   * session: the child keeps running, but its events/questions/exit now belong
   * to the new session (or to a silent set while nobody owns it).
   *
   * @param handlers - the new handler set.
   */
  setHandlers(handlers: DshProcessHandlers): void {
    this.#handlers = {
      onEvent: (payload) => handlers.onEvent(payload),
      onStatus: (status, sessionId) => handlers.onStatus(status, sessionId),
      onQuestion: (request, sessionId) => handlers.onQuestion(request, sessionId),
      ...(handlers.onChildOpened === undefined
        ? {}
        : { onChildOpened: (payload: DshChildOpened) => handlers.onChildOpened?.(payload) }),
      onLog: (line) => handlers.onLog(line),
      onExit: (code, signal) => handlers.onExit(code, signal),
      onProtocolError: (message) => handlers.onProtocolError(message),
    };
  }

  /** Spawn the child and complete `initialize`. Idempotent. */
  start(): Promise<void> {
    this.#initializeTask ??= this.#start();
    return this.#initializeTask;
  }

  async #start(): Promise<void> {
    // A rejected MCP server throws here, before any process exists: `start()`
    // rejects, the provider reports it, and nothing is left on disk.
    this.#patch = prepareMcpPatch(this.#options.mcpServers, this.#options.cwd);
    // The profile is resolved from the environment the child will actually get,
    // not the daemon's: a session may override `DSH_PASEO_PROFILE`, and asking DSH
    // for a profile the session did not provision is a failure with no local
    // explanation. `profileName` is the single definition of that lookup.
    const args = ["--profile", profileName({ ...process.env, ...this.#options.env })];
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
        if (line.trim() !== "") this.#handlers.onLog(line);
      }
    });
    child.on("error", (error) => {
      this.#cleanupPatch();
      this.#failAll(error);
      this.#handlers.onProtocolError(error.message);
      this.#markExited();
    });
    child.on("exit", (code, signal) => {
      this.#cleanupPatch();
      this.#closed = true;
      this.#failAll(new Error("DeepSeek Harness process ended"));
      this.#handlers.onExit(code, signal);
      this.#markExited();
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

  /**
   * Send one text prompt. Resolves when the bridge accepts it, not when the turn ends.
   *
   * The receipt carries the DSH message id — Paseo's rewind button hands it back as
   * its revert token, so it has to travel on the timeline row that represents the
   * message — and, when the bridge can attribute the message, `sourceKind`: the DSH
   * event's `source.kind`, which tells a human message apart from a synthetic one
   * (a notification, a rewind marker) so only the former becomes a rewind anchor.
   * Both fields are optional: an older bridge reports neither, and a missing field
   * stays absent rather than being guessed.
   *
   * @param text - prompt text, used when `contentBlocks` is omitted.
   * @param contentBlocks - pre-built content blocks (text and/or attachments).
   * @param delivery - `steer` injects into the running turn, `auto` opens the next one.
   * @returns the message id and the message's DSH source kind when reported.
   */
  async prompt(
    text: string,
    contentBlocks?: unknown[],
    delivery?: "auto" | "steer",
  ): Promise<{ messageId?: string; sourceKind?: string }> {
    const result = (await this.#request("session/prompt", {
      sessionId: this.#options.sessionId,
      contentBlocks: contentBlocks ?? [{ type: "text", text }],
      ...(delivery === undefined ? {} : { delivery }),
    })) as { messageId?: unknown; sourceKind?: unknown } | undefined;
    return {
      ...(typeof result?.messageId === "string" ? { messageId: result.messageId } : {}),
      ...(typeof result?.sourceKind === "string" ? { sourceKind: result.sourceKind } : {}),
    };
  }

  /**
   * Switch the session's permission preset through DSH's projection API.
   *
   * The preset owns both the sandbox mode and the approval policy. Going through
   * this non-command write keeps the timeline free of a `/permission` row the
   * user never typed; the command path remains only for DSH's own `/permission`
   * slash usage.
   */
  async setPermission(name: string): Promise<{ current: string | null }> {
    return (await this.#request("paseo/permission/set", {
      sessionId: this.#options.sessionId,
      preset: name,
    })) as { current: string | null };
  }

  /**
   * Rewind to just before one user message.
   *
   * The token is opaque to Paseo: it hands back whatever `revertToken` our
   * timeline row carried (`{ messageId }`). The bridge resolves it against the
   * visible surface and refuses loudly when the row is no longer rewindable
   * (already rewound, or compacted away). With `both` it also restores the files
   * the agent's editing tools touched since that message, and reports the outcome
   * so the provider can surface a partial failure instead of pretending.
   */
  async revert(token: unknown, scope: "conversation" | "files" | "both"): Promise<DshRevertResult | undefined> {
    return (await this.#request(
      "paseo/revert",
      { sessionId: this.#options.sessionId, token, scope },
      120000,
    )) as DshRevertResult | undefined;
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

  /**
   * List the DSH sessions a user could import into Paseo.
   *
   * A failed read is not an empty list. The bridge answers
   * `{available:false, sessions:[], error?}` when the runtime composes no session
   * store or the store cannot be listed; Paseo renders its import view from
   * whatever rows arrive, so folding that into `[]` would show "nothing to import"
   * for a runtime that actually failed. The failure is thrown instead, and the
   * caller's `request.failed` carries it to the UI (`history`/`subagents` report the
   * same condition as data; this method's return type is a bare list, so a throw is
   * the loud channel). An older bridge reports neither field — absence means the
   * list is usable, which keeps the legacy behavior.
   *
   * @param options - query/cwd/limit filters forwarded to the bridge.
   * @returns the bridge's stored-session rows.
   * @throws when the bridge reports `available:false`.
   */
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
    )) as {
      available?: boolean;
      sessions?: Array<{ sessionId: string; cwd?: string; title?: string; preview?: string; updatedAt?: string }>;
      error?: { message?: string };
    };
    if (result.available === false) {
      const detail =
        typeof result.error?.message === "string" && result.error.message !== ""
          ? result.error.message
          : "the runtime composes no session store";
      throw new Error(`the session list is unavailable: ${detail}`);
    }
    return result.sessions ?? [];
  }

  /**
   * Read one session's stored event log, for replaying into a timeline.
   *
   * `available: false` means the log could not be read — a stalled or failed
   * read — as opposed to a session that genuinely has no history. The caller
   * has to tell them apart: both used to arrive as an empty `events` array, so
   * a reopen whose replay failed rendered a blank conversation with no error,
   * which reads to the user as "my history is gone".
   */
  async history(sessionId = this.#options.sessionId): Promise<{
    events: Array<{ type: string; seq?: number; time?: number; data: unknown }>;
    /** Leading events inherited from a fork parent; own history starts here. */
    inheritedEventCount: number;
    /** False when the log exists but could not be read. */
    available: boolean;
    /** Why it could not be read, when `available` is false. */
    error?: string;
  }> {
    const result = (await this.#request(
      "paseo/history",
      { sessionId },
      60000,
    )) as {
      events?: Array<{ type: string; seq?: number; time?: number; data: unknown }>;
      inheritedEventCount?: number;
      available?: boolean;
      error?: { message?: string };
    };
    return {
      events: result.events ?? [],
      inheritedEventCount:
        typeof result.inheritedEventCount === "number" && result.inheritedEventCount > 0
          ? result.inheritedEventCount
          : 0,
      available: result.available !== false,
      ...(result.available === false
        ? { error: typeof result.error?.message === "string" ? result.error.message : "the history read failed" }
        : {}),
    };
  }

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

  /**
   * List the native subagent children reachable from this session, for
   * rebuilding the tree on replay. Read-only: DSH reads its durable catalog
   * without loading or resuming any child agent. `available: false` means the
   * runtime composes no subagent service; a failed read carries `error`, and an
   * unreadable branch is reported in `diagnostics` — never a silent empty list.
   */
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

  /**
   * Resolve once the child is gone, or `false` when `timeoutMs` elapses.
   *
   * Used before a DSH session is handed to a new process: the dead child released
   * the session log's kernel write lock only when the OS actually reaped it, and a
   * successor spawned into that window cannot materialize the session ("already
   * owned by an active write handle"). `kill()` returns before that happens, so
   * callers that must not race it need this await with a bound.
   *
   * @param timeoutMs - upper bound on the wait; the caller decides what to do on
   *   timeout (this method never rejects).
   * @returns `true` when the child is gone (or was never spawned), `false` on timeout.
   */
  waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.#child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }
    this.#exited ??= new Promise<void>((resolve) => {
      this.#resolveExited = resolve;
    });
    const exited = this.#exited;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      void exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Wake every {@link waitForExit} caller; idempotent. */
  #markExited(): void {
    const resolve = this.#resolveExited;
    this.#resolveExited = undefined;
    resolve?.();
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
      this.#handlers.onProtocolError(toError(error, "failed to write to the bridge").message);
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
        this.#handlers.onLog(line);
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
        const answer = await this.#handlers.onQuestion(
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
      this.#handlers.onEvent(frame.params as DshSessionEvent);
      return;
    }
    if (method === "session.status") {
      const params = frame.params as { status?: string; sessionId?: string } | undefined;
      this.#handlers.onStatus(params?.status ?? "unknown", params?.sessionId ?? "");
      return;
    }
    if (method === "session.child-opened") {
      const params = frame.params as DshChildOpened | undefined;
      if (params !== undefined && typeof params.sessionId === "string" && params.sessionId !== "") {
        this.#handlers.onChildOpened?.(params);
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
