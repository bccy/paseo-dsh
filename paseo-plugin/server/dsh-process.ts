/**
 * One `dsh --profile paseo` child process, speaking the bridge's stdio JSON-RPC.
 *
 * A process serves **many** agent sessions. DSH pins the working directory,
 * provider, model and reasoning effort per session at `initialize`, so one
 * process can host several Paseo sessions at once — each with its own cwd,
 * route and MCP servers — instead of paying a full profile load per session.
 *
 * The split is deliberate:
 *
 * - **Session-scoped** (keyed by DSH session id in {@link DshProcess.attachSession}):
 *   events, status, questions, child notices, exit, and every request that names
 *   a session (prompt, cancel, revert, plan, usage, …).
 * - **Process-scoped**: stderr lines, JSON-RPC protocol failures, and the child's
 *   own lifecycle. Those belong to the child, not to any one session.
 *
 * @module dsh-paseo/server/dsh-process
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * The handlers one attached session reports to.
 *
 * `onLog` and `onProtocolError` are deliberately absent. A stderr line or a
 * malformed frame belongs to the child, not to any one conversation, so a
 * session must not be able to silence diagnostics for the sessions sharing its
 * process — which is exactly what the parked pool's silent handler set used to
 * do to a whole process.
 */
export type DshSessionHandlers = Omit<DshProcessHandlers, "onLog" | "onProtocolError">;

/**
 * One frame held until its producing session's lineage becomes resolvable.
 *
 * Only the frame kinds addressed by a producing session can be orphaned this
 * way: a JSON-RPC *response* is matched by request id and never routed by
 * session.
 *
 * `child-opened` is included, and that is the subtle part. It looks like it
 * should never need holding — it is the notice that *creates* a parent edge — but
 * its own `parentSessionId` can name a session nothing has announced yet (a
 * grandchild reported before the child that parents it). Recording the edge and
 * *delivering* the notice are separate: the edge is recorded unconditionally,
 * while delivery needs an owner, so an unresolvable notice was dropped and the
 * child never appeared in the session at all. Holding it is what lets a whole
 * chain surface once its top-level ancestor is announced.
 */
type OrphanFrame =
  | { kind: "event"; params: Record<string, unknown> }
  | { kind: "status"; params: Record<string, unknown> }
  | { kind: "child-opened"; params: Record<string, unknown> };

/** How many orphan frames one producing session may accumulate. */
const ORPHAN_FRAME_LIMIT = 256;
/**
 * How long a frame may wait for its lineage.
 *
 * A child's parent notice normally arrives within the same burst, so this only
 * bounds a lineage that will never resolve (a child of a session this process
 * does not serve). The frame is then reported and dropped, exactly as it was
 * before buffering existed — the difference is that a transient reorder now
 * survives instead of losing the child's first output.
 */
const ORPHAN_FRAME_TTL_MS = 5_000;

/** What one attached session contributes besides its handlers. */
export interface DshSessionOptions {
  /** Working directory this session runs in; defaults to the process's. */
  cwd?: string;
  /** Route this session is pinned to; defaults to the process's. */
  route?: DshRoute;
  /** MCP servers Paseo handed this session. */
  mcpServers?: Readonly<Record<string, DshMcpServer>>;
}

export interface DshProcessOptions extends DshProcessHandlers {
  cwd: string;
  route: DshRoute;
  /**
   * The session this process was built for.
   *
   * It is attached at construction, so a single-session construction (the
   * one-shot probes, and every provider session until the process pool lands)
   * keeps behaving exactly as before. A pooled process serves more sessions
   * through {@link DshProcess.attachSession}; this id stays the default that
   * the session-scoped methods fall back to when a caller names none.
   */
  sessionId: string;
  /** Extra environment for the child; merged over the daemon's environment. */
  env?: Record<string, string>;
  /**
   * MCP servers Paseo handed this session — the process-level default.
   *
   * DSH mounts MCP servers per agent, so they are no longer a boot-time
   * `--patch` overlay: {@link DshProcess.attachSession} takes each session's own
   * map, and the process sends it to the bridge as a `paseo/mcp/set` frame
   * before that session's first request. This field covers the single-session
   * construction where there is nothing to override it with.
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
 * flowing while the model pays for only the tools it actually discovers.
 *
 * The specifier is **relative to the bridge bundle**, not a package name: the
 * gateway ships inside `dsh-paseo-bridge`, and this plugin cannot name a package
 * it does not depend on. The bridge resolves each entry's `name` with a plain
 * `import()`, so a relative path loads the gateway module from its own lib
 * directory while a bare specifier still loads a profile-installed plugin. That
 * keeps the choice of *which* plugin mounts which server here, where the
 * translation lives, instead of hardcoding a plugin name in the bridge.
 */
const MCP_GATEWAY_PLUGIN = "./mcp-gateway.js";

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

/** One plugin mount the bridge is asked to perform in a session's agent scope. */
export interface DshMcpEntry {
  /**
   * Module specifier the bridge resolves with `import()`: a bare package name
   * for a profile-installed plugin, or a path relative to the bridge bundle.
   */
  name: string;
  config: Record<string, unknown>;
}

/**
 * Translate Paseo's MCP servers into the entries the bridge mounts.
 *
 * Streamable-HTTP servers and the whitelisted stdio servers ride the gateway
 * (one row, three tools). Every other stdio server keeps the stock client: it was
 * configured by the user, and dropping it — or quietly demoting it to discovery
 * calls — would remove capability they asked for. Legacy SSE stays refused.
 *
 * These are DSH patch entries in shape (`{ name, config }`), which is what the
 * bridge's `paseo/mcp/set` consumes. Keeping that shape means the bridge only
 * has to call `ctx.plugin(await import(entry.name), entry.config)` and never
 * learns which plugin is the gateway — the whitelist and the native/refused
 * decision stay here, in the layer that owns the translation.
 */
function mcpEntries(
  servers: Readonly<Record<string, DshMcpServer>>,
): DshMcpEntry[] {
  const entries: DshMcpEntry[] = [];
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
      // `failOnStartupError` is what keeps a broken connection loud: the mount
      // still succeeds and the entry is reported as "did not activate" on stderr,
      // which this process forwards to the log, instead of the model silently
      // getting no tools.
      entries.push({
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
    entries.push({ name: MCP_GATEWAY_PLUGIN, config: { servers: proxied } });
  }
  return entries;
}

/**
 * Translate one session's MCP servers into bridge entries, merging the browser.
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
 * @returns the entries to mount, empty when this session has none.
 * @throws when a server cannot be represented in DSH (see {@link mcpEntries}).
 */
function sessionMcpEntries(
  servers: Readonly<Record<string, DshMcpServer>> | undefined,
  cwd: string,
): DshMcpEntry[] {
  const merged: Record<string, DshMcpServer> = { ...(servers ?? {}) };
  if (!Object.hasOwn(merged, BROWSER_MCP_SERVER)) {
    const browser = browserMcpServer(cwd);
    if (browser !== undefined) merged[BROWSER_MCP_SERVER] = browser;
  }
  if (Object.keys(merged).length === 0) return [];
  return mcpEntries(merged);
}

export class DshProcess {
  readonly #options: DshProcessOptions;
  /**
   * The handlers that belong to the child itself rather than to any one session:
   * stderr lines and JSON-RPC protocol failures. They stay process-wide so a
   * session cannot silence diagnostics for the sessions sharing its process.
   * Mutable on purpose: {@link setHandlers} re-points a parked process.
   */
  #processHandlers: { onLog(line: string): void; onProtocolError(message: string): void };
  /**
   * One handler set per attached session, keyed by DSH's own session id.
   *
   * A map rather than a single object because one child serves many Paseo
   * sessions: each session's events, questions and exit must reach its own
   * provider session and no other.
   */
  readonly #sessionHandlers = new Map<string, DshSessionHandlers>();
  /** Per-session cwd/route/MCP overrides; absent fields fall back to the process. */
  readonly #sessionOptions = new Map<string, DshSessionOptions>();
  /** Sessions that have completed their own `initialize` in this child. */
  readonly #initializedSessions = new Set<string>();
  /** Sessions whose MCP entries have been handed to the bridge. */
  readonly #mcpSent = new Set<string>();
  /** The entries each session mounts, translated once (translation may throw). */
  readonly #sessionMcp = new Map<string, DshMcpEntry[]>();
  /** Memoized per-session preparation, so concurrent callers share one attempt. */
  readonly #readyTasks = new Map<string, Promise<void>>();
  /**
   * Child session id -> its direct parent, learned from `session.child-opened`.
   *
   * The bridge reports a subagent's frames under the *child's* own session id,
   * so routing them to the session that owns the conversation needs this edge.
   * A parent may itself be a child (a grandchild), which is why resolution walks
   * the chain instead of reading one hop.
   */
  readonly #childParent = new Map<string, string>();
  /**
   * Frames whose producing session has no resolvable owner *yet*.
   *
   * The bridge does not guarantee that an ancestor's `session.child-opened`
   * arrives before a descendant's own frames: `observeChildSession`
   * (`dsh-bridge/lib/server.js:363`) only registers a child once its durable
   * header is materialized, and an unregistered child's frames take the
   * pass-through branch (`server.js:320`) instead of being held. A grandchild can
   * therefore reach this process before its parent has been announced, and
   * `#rootOf` walks `child -> parent` to a dead end.
   *
   * Dropping those frames loses the child's earliest output and its terminal
   * `turn/end` (the turn then never closes). They are held instead, per producing
   * session, and replayed as soon as an edge makes them routable. Bounded in both
   * size and age: a frame whose lineage never arrives is reported and dropped
   * rather than buffered for the life of the process.
   */
  readonly #orphanFrames = new Map<string, { frames: OrphanFrame[]; since: number }>();
  /** Timers that report and drop one orphan bucket that never became routable. */
  readonly #orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #initializeTask: Promise<void> | undefined;
  /** Resolved once the child is gone; created lazily by {@link waitForExit}. */
  #exited: Promise<void> | undefined;
  #resolveExited: (() => void) | undefined;

  constructor(options: DshProcessOptions) {
    this.#options = options;
    this.#processHandlers = {
      onLog: (line) => options.onLog(line),
      onProtocolError: (message) => options.onProtocolError(message),
    };
    // The session this process was built for is attached immediately, so a
    // single-session construction behaves exactly as it did before the split.
    this.#sessionOptions.set(options.sessionId, {
      cwd: options.cwd,
      route: options.route,
      ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
    });
    this.#sessionHandlers.set(options.sessionId, {
      onEvent: (payload) => options.onEvent(payload),
      onStatus: (status, sessionId) => options.onStatus(status, sessionId),
      onQuestion: (request, sessionId) => options.onQuestion(request, sessionId),
      ...(options.onChildOpened === undefined
        ? {}
        : { onChildOpened: (payload: DshChildOpened) => options.onChildOpened?.(payload) }),
      onExit: (code, signal) => options.onExit(code, signal),
    });
  }

  /** Whether the child is still alive and usable. */
  get running(): boolean {
    return this.#closed === false && this.#child !== undefined;
  }

  /**
   * Point this process at a different set of handlers.
   *
   * Kept for the warm pool: an idle process is parked and a fresh provider
   * session adopts it, so the same child must start reporting to a new session
   * without being killed and respawned (that spawn is the 1.5–2.7 s half of the
   * refresh latency). It re-points the session this process was built for, and
   * the process-level log/protocol sinks, which is the whole of its old meaning
   * when a process serves one session.
   *
   * A pooled process must use {@link attachSession} / {@link detachSession}
   * instead: re-pointing here would move the wrong conversation's events.
   *
   * @param handlers - the new handler set.
   */
  setHandlers(handlers: DshProcessHandlers): void {
    this.#processHandlers = {
      onLog: (line) => handlers.onLog(line),
      onProtocolError: (message) => handlers.onProtocolError(message),
    };
    this.#sessionHandlers.set(this.#options.sessionId, {
      onEvent: (payload) => handlers.onEvent(payload),
      onStatus: (status, sessionId) => handlers.onStatus(status, sessionId),
      onQuestion: (request, sessionId) => handlers.onQuestion(request, sessionId),
      ...(handlers.onChildOpened === undefined
        ? {}
        : { onChildOpened: (payload: DshChildOpened) => handlers.onChildOpened?.(payload) }),
      onExit: (code, signal) => handlers.onExit(code, signal),
    });
  }

  /**
   * Attach one more session to this process.
   *
   * The session gets its own handlers and, optionally, its own working
   * directory, route and MCP servers; anything omitted falls back to what this
   * process was constructed with. The session is initialized under its own id
   * before this resolves, so the caller can prompt immediately afterwards.
   *
   * @param sessionId - DSH's own session id; the key every request and frame uses.
   * @param handlers - where this session's events, questions and exit go.
   * @param options - this session's cwd/route/MCP servers, if they differ.
   * @throws when one of the session's MCP servers cannot be mounted in DSH.
   */
  async attachSession(
    sessionId: string,
    handlers: DshSessionHandlers,
    options: DshSessionOptions = {},
  ): Promise<void> {
    if (sessionId === "") throw new Error("attachSession requires a session id");
    this.#sessionHandlers.set(sessionId, handlers);
    const merged: DshSessionOptions = { ...(this.#sessionOptions.get(sessionId) ?? {}) };
    if (options.cwd !== undefined) merged.cwd = options.cwd;
    if (options.route !== undefined) merged.route = options.route;
    if (options.mcpServers !== undefined) merged.mcpServers = options.mcpServers;
    this.#sessionOptions.set(sessionId, merged);
    // Translate this session's MCP servers now, so a server DSH cannot mount
    // fails at attach — where the caller reports it — instead of at the first
    // prompt of a conversation the user already opened.
    this.#mcpEntriesFor(sessionId);
    // Attaching implies the session is usable, so the child must exist first.
    // `start()` is idempotent, so an already-running process pays nothing here.
    await this.start();
    await this.#ensureSessionReady(sessionId);
  }

  /**
   * Stop routing this session's frames to its handlers and forget its state.
   *
   * The child keeps running for every other session it serves. Everything about
   * the session is dropped, including the "already initialized" flag: a later
   * {@link attachSession} for the same id re-initializes it, which is the only
   * way to be sure the bridge still holds that session's route.
   *
   * @param sessionId - the session to detach; unknown ids are ignored.
   */
  detachSession(sessionId: string): void {
    if (!this.#sessionHandlers.delete(sessionId)) return;
    this.#sessionOptions.delete(sessionId);
    this.#sessionMcp.delete(sessionId);
    this.#initializedSessions.delete(sessionId);
    this.#mcpSent.delete(sessionId);
    this.#readyTasks.delete(sessionId);
    this.#forgetChildrenOf(sessionId);
  }

  /**
   * Detach a session and tell the bridge to drop its state too.
   *
   * The bridge keeps ten tables keyed by session id (`sessions`, `controls`,
   * `assistantStreams`, `pendingPresets`, `pendingPlanMode`, `pendingMcpServers`,
   * `children`, `childAnchors`, `revertInflight`, `snapshotOwners`); they only
   * shrink when it is told. It deliberately keeps `sessionCwd`, `sessionRoutes`
   * and `initializedSessions`: a closed session's agent can be resumed inside
   * this same process, and clearing its route while leaving it "initialized"
   * would make that resume silently compose another session's defaults. Those
   * three are the bridge's to keep, so nothing here tries to clear them.
   *
   * A failure is logged rather than thrown: this runs on the teardown path,
   * where the process may already be dying, and losing a cleanup frame must not
   * turn a normal close into an error the user sees. The log line is what makes
   * it diagnosable instead of silent.
   *
   * @param sessionId - the session to close; unknown ids are ignored.
   */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.#sessionHandlers.has(sessionId)) return;
    this.detachSession(sessionId);
    if (this.#closed || this.#child === undefined) return;
    try {
      const result = (await this.#request("session/close", { sessionId })) as
        | { closed?: unknown }
        | undefined;
      // `{ closed: false }` means the bridge never knew the session, which is a
      // legitimate outcome of closing something that was attached but never
      // prompted. Anything else is worth a line, because a table that failed to
      // shrink is how a long-lived process slowly leaks sessions.
      if (result?.closed !== true) {
        this.#processHandlers.onLog(`session/close for ${sessionId} reported nothing closed`);
      }
    } catch (error) {
      this.#processHandlers.onLog(
        `session/close failed for ${sessionId}: ${toError(error, "close failed").message}`,
      );
    }
  }

  /** Spawn the child and complete `initialize`. Idempotent. */
  start(): Promise<void> {
    this.#initializeTask ??= this.#start();
    return this.#initializeTask;
  }

  async #start(): Promise<void> {
    // Translate the construction session's MCP servers before spawning: a server
    // DSH cannot mount must fail the start — and be reported by the provider —
    // rather than surface later at this session's first prompt.
    this.#mcpEntriesFor(this.#options.sessionId);
    // The profile is resolved from the environment the child will actually get,
    // not the daemon's: a session may override `DSH_PASEO_PROFILE`, and asking DSH
    // for a profile the session did not provision is a failure with no local
    // explanation. `profileName` is the single definition of that lookup.
    const args = ["--profile", profileName({ ...process.env, ...this.#options.env })];
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
        if (line.trim() !== "") this.#processHandlers.onLog(line);
      }
    });
    child.on("error", (error) => {
      this.#failAll(error);
      this.#processHandlers.onProtocolError(error.message);
      this.#markExited();
    });
    child.on("exit", (code, signal) => {
      this.#closed = true;
      this.#failAll(new Error("DeepSeek Harness process ended"));
      this.#exitAll(code, signal);
      this.#markExited();
    });

    if (this.#options.initializeRoute === false) return;

    await this.#ensureSessionReady(this.#options.sessionId);
  }

  /**
   * Pin one session's cwd and route in the bridge.
   *
   * The id always travels: it is what makes the bridge store the values against
   * that session instead of as this process's defaults, and what admits the
   * session to `prompt` at all. Idempotent.
   */
  async #initializeSession(sessionId: string): Promise<void> {
    if (this.#initializedSessions.has(sessionId)) return;
    const options = this.#sessionOptions.get(sessionId) ?? {};
    const cwd = options.cwd ?? this.#options.cwd;
    const route = options.route ?? this.#options.route;
    await this.#request("initialize", {
      cwd,
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      sessionId,
    });
    this.#initializedSessions.add(sessionId);
  }
  /**
   * Make one session ready to be used: initialized, with its MCP servers queued.
   *
   * Callers reach this through {@link #ensureSessionReady} rather than by
   * remembering the two frames themselves. The bridge rejects a prompt from a
   * session it has never initialized, so "every session initialized itself" is
   * an invariant this class maintains for its callers instead of trusting every
   * path to do it — a missed path would otherwise surface as a protocol error
   * that reads like a bridge bug.
   */
  #ensureSessionReady(sessionId: string): Promise<void> {
    // A process built with `initializeRoute: false` exists to read the catalog or
    // list stored sessions, never to run a turn. Pinning a route there would make
    // a bad route hide the model list the read is meant to produce, which is the
    // whole reason that flag exists.
    if (this.#options.initializeRoute === false) return Promise.resolve();
    const existing = this.#readyTasks.get(sessionId);
    if (existing !== undefined) return existing;
    const task = this.#prepareSession(sessionId);
    this.#readyTasks.set(sessionId, task);
    // A failed preparation must not be memoized: the next request retries
    // instead of inheriting a rejection nobody awaited.
    task.catch(() => {
      if (this.#readyTasks.get(sessionId) === task) this.#readyTasks.delete(sessionId);
    });
    return task;
  }

  async #prepareSession(sessionId: string): Promise<void> {
    await this.#initializeSession(sessionId);
    await this.#sendSessionMcp(sessionId);
  }

  /**
   * Hand this session's MCP entries to the bridge, once.
   *
   * DSH mounts MCP servers per agent, so they cannot ride a boot-time `--patch`
   * overlay any more: the bridge queues them and mounts them in that session's
   * agent scope. The frame must arrive **after** the session's `initialize` and
   * **before** its first prompt — that window is the only one where the agent
   * does not exist yet, and entries that arrive later are deferred to the next
   * resume, which for a fresh session may never come.
   *
   * An empty list is still sent: it is the bridge's way of being told "this
   * session has none", so a re-attach that dropped servers cannot inherit the
   * previous ones.
   */
  async #sendSessionMcp(sessionId: string): Promise<void> {
    if (this.#mcpSent.has(sessionId)) return;
    const entries = this.#mcpEntriesFor(sessionId);
    const result = (await this.#request("paseo/mcp/set", { sessionId, entries })) as
      | { accepted?: unknown; entries?: unknown; mounted?: unknown }
      | undefined;
    this.#mcpSent.add(sessionId);
    // `mounted: false` is a legal reply, not an error: the bridge is saying the
    // session's agent already exists, so these entries will only take effect on
    // its next resume. On the documented order (initialize -> set -> prompt) that
    // cannot happen, so it is reported — a silently deferred MCP mount would show
    // up as "the model has no Paseo tools" with nothing in the log to explain it.
    if (result?.mounted === false) {
      this.#processHandlers.onLog(
        `paseo/mcp/set for ${sessionId} arrived after its agent was created; `
          + `${entries.length} entr(y/ies) will be mounted on the next resume`,
      );
    }
  }

  /** This session's translated MCP entries, computed once. */
  #mcpEntriesFor(sessionId: string): DshMcpEntry[] {
    const cached = this.#sessionMcp.get(sessionId);
    if (cached !== undefined) return cached;
    const options = this.#sessionOptions.get(sessionId) ?? {};
    const entries = sessionMcpEntries(options.mcpServers, options.cwd ?? this.#options.cwd);
    this.#sessionMcp.set(sessionId, entries);
    return entries;
  }

  /**
   * The attached session that owns a frame's session id.
   *
   * A frame's id is the session that *produced* it, which for a native subagent
   * is the child, not the conversation the user is looking at. Resolution walks
   * the child -> parent chain until it reaches an attached session; the `seen`
   * guard bounds a malformed or cyclic chain instead of looping forever.
   *
   * @returns the owning session's id, or `undefined` when nothing owns it.
   */
  #rootOf(sessionId: string): string | undefined {
    if (sessionId === "") return undefined;
    let current: string | undefined = sessionId;
    const seen = new Set<string>();
    while (current !== undefined && current !== "" && !seen.has(current)) {
      if (this.#sessionHandlers.has(current)) return current;
      seen.add(current);
      current = this.#childParent.get(current);
    }
    return undefined;
  }

  /** Drop every child->parent edge that pointed into a detached session. */
  #forgetChildrenOf(root: string): void {
    const removed = new Set<string>([root]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [child, parent] of this.#childParent) {
        if (removed.has(parent) && !removed.has(child)) {
          removed.add(child);
          grew = true;
        }
      }
    }
    for (const id of removed) {
      if (id !== root) this.#childParent.delete(id);
    }
  }

  /** Tell every attached session the child is gone. */
  #exitAll(code: number | null, signal: string | null): void {
    // The child dying ends every conversation it served, so all of them hear it
    // — not just whichever handler happened to be assigned last.
    for (const [sessionId, handlers] of [...this.#sessionHandlers]) {
      try {
        handlers.onExit(code, signal);
      } catch (error) {
        this.#processHandlers.onLog(
          `session ${sessionId} exit handler failed: ${toError(error, "exit handler failed").message}`,
        );
      }
    }
  }

  /** Read the runtime's provider/model catalog without creating an agent. */
  async catalog(): Promise<DshCatalog> {
    return (await this.#request("paseo/catalog", {}, 60000)) as DshCatalog;
  }

  /**
   * List the session's registered commands and user-invocable skills.
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async commands(sessionId: string): Promise<DshCommand[]> {
    await this.#ensureSessionReady(sessionId);
    const result = (await this.#request(
      "paseo/commands",
      { sessionId },
      60000,
    )) as { commands?: DshCommand[] };
    return result.commands ?? [];
  }

  /**
   * Execute one registered slash command (skills are sent as text instead).
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async runCommand(
    sessionId: string,
    name: string,
    args: string,
  ): Promise<{ kind: "success" | "error"; text?: string }> {
    await this.#ensureSessionReady(sessionId);
    return (await this.#request("paseo/command/run", {
      sessionId,
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
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async permission(sessionId: string): Promise<{
    available: boolean;
    current: string | null;
    presets: DshPermissionPreset[];
  }> {
    await this.#ensureSessionReady(sessionId);
    return (await this.#request("paseo/permission", {
      sessionId,
    })) as { available: boolean; current: string | null; presets: DshPermissionPreset[] };
  }

  /**
   * Read the session's current context occupancy from the runtime's own token
   * meter. Absent fields mean the runtime does not know them yet; they are
   * never defaulted here.
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async usage(sessionId: string): Promise<DshUsage> {
    await this.#ensureSessionReady(sessionId);
    return (await this.#request("paseo/usage", {
      sessionId,
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
   * @param sessionId - which session; defaults to the one this process was built for.
   * @returns the message id and the message's DSH source kind when reported.
   */
  async prompt(
    sessionId: string,
    text: string,
    contentBlocks?: unknown[],
    delivery?: "auto" | "steer",
  ): Promise<{ messageId?: string; sourceKind?: string }> {
    // Every session must have initialized the bridge under its own id before it
    // can prompt: `initialize` is what pins that session's cwd and route, and the
    // bridge admits a prompt only from a session it has seen. A path that opened
    // a session without going through `attachSession` would otherwise fail at the
    // first prompt with an error that reads like a protocol bug, so the invariant
    // is maintained here rather than trusted to every caller.
    await this.#ensureSessionReady(sessionId);
    const result = (await this.#request("session/prompt", {
      sessionId,
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
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async setPermission(sessionId: string, name: string): Promise<{ current: string | null }> {
    await this.#ensureSessionReady(sessionId);
    return (await this.#request("paseo/permission/set", {
      sessionId,
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
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async revert(
    sessionId: string,
    token: unknown,
    scope: "conversation" | "files" | "both",
  ): Promise<DshRevertResult | undefined> {
    await this.#ensureSessionReady(sessionId);
    return (await this.#request(
      "paseo/revert",
      { sessionId, token, scope },
      120000,
    )) as DshRevertResult | undefined;
  }

  /**
   * Cancel the running turn while keeping the session usable afterwards.
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async cancel(sessionId: string): Promise<void> {
    await this.#ensureSessionReady(sessionId);
    await this.#request("session/cancel", { sessionId });
  }

  /**
   * Select plan mode and return the committed state.
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async setPlan(
    sessionId: string,
    active: boolean,
  ): Promise<{ active: boolean; pending: boolean; outcome?: string }> {
    await this.#ensureSessionReady(sessionId);
    return (await this.#request("paseo/plan/set", {
      sessionId,
      active,
    })) as { active: boolean; pending: boolean; outcome?: string };
  }

  /**
   * Read the committed plan state.
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async getPlan(sessionId: string): Promise<{ active: boolean; pending: boolean; available: boolean }> {
    await this.#ensureSessionReady(sessionId);
    return (await this.#request("paseo/plan/get", {
      sessionId,
    })) as { active: boolean; pending: boolean; available: boolean };
  }

  /**
   * Switch model and/or reasoning effort on the live agent.
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async setConfig(sessionId: string, changes: {
    model?: string;
    provider?: string;
    reasoningEffort?: string | null;
    preset?: string;
  }): Promise<{ provider: string; model: string; reasoningEffort: string | null; preset?: string | null }> {
    await this.#ensureSessionReady(sessionId);
    return (await this.#request("paseo/config/set", {
      sessionId,
      ...changes,
    })) as { provider: string; model: string; reasoningEffort: string | null; preset?: string | null };
  }

  /**
   * List the profile's agent presets and the one this session runs.
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async presets(sessionId: string): Promise<{
    available: boolean;
    presets: Array<{ id: string; name?: string; description?: string; broken?: string }>;
    current: string | null;
    default: string | null;
  }> {
    await this.#ensureSessionReady(sessionId);
    return (await this.#request("paseo/presets", {
      sessionId,
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
  async history(sessionId: string): Promise<{
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
   *
   * @param sessionId - which session; defaults to the one this process was built for.
   */
  async subagents(sessionId: string): Promise<{
    available: boolean;
    subagents: Array<{ sessionId: string; parentSessionId: string; mode?: string; label?: string; archived?: boolean }>;
    diagnostics?: unknown[];
    error?: { message: string };
  }> {
    await this.#ensureSessionReady(sessionId);
    const result = (await this.#request(
      "paseo/subagents",
      { sessionId },
      60000,
    )) as {
      available?: boolean;
      subagents?: Array<{ sessionId: string; parentSessionId: string; mode?: string; label?: string }>;
      diagnostics?: unknown[];
      error?: { message?: string };
    };
    const subagents = result.subagents ?? [];
    // The listing is read from DSH's own durable headers, so it names every
    // child's direct parent — including children whose `session.child-opened` this
    // process never received (a reopen, or a child announced to a previous
    // provider session). Recording those edges here is what lets their frames be
    // routed at all: without an edge `#rootOf` walks `child -> parent` to a dead
    // end, and only a `child-opened` would ever add one. A frame that arrived
    // before this call resolving is already held by `#holdOrphan`, so the listing
    // is followed by a replay — the hold and the catalog are two halves of the
    // same recovery.
    //
    // An existing edge is never overwritten: a notice names the parent DSH has
    // materialized, which stays authoritative for a re-parented child.
    for (const child of subagents) {
      if (typeof child.parentSessionId !== "string" || child.parentSessionId === "") continue;
      if (!this.#childParent.has(child.sessionId)) {
        this.#childParent.set(child.sessionId, child.parentSessionId);
      }
    }
    // Run after the edges exist, so held frames for these children become
    // routable now instead of waiting out the orphan TTL.
    if (subagents.length > 0) this.#replayOrphans();
    return {
      available: result.available === true,
      subagents,
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
      this.#processHandlers.onProtocolError(toError(error, "failed to write to the bridge").message);
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
        this.#processHandlers.onLog(line);
        continue;
      }
      void this.#dispatch(frame);
    }
  }

  /**
   * Route one bridge frame to the session that owns it.
   *
   * The bridge names a producing session on every notification that has one, and
   * that id is the *child's* for a subagent — {@link #rootOf} walks up to the
   * conversation the user is looking at. A frame whose owner cannot be found is
   * reported and dropped: it belongs to a session this process does not serve
   * (a stale child, or one whose close raced the frame), and guessing an owner
   * would put one conversation's events on another's timeline.
   *
   * Frames without a session id are process-level: an `initialize` reply, or any
   * other JSON-RPC response, is matched to its pending request by id.
   */
  async #dispatch(frame: Record<string, unknown>): Promise<void> {
    const method = typeof frame.method === "string" ? frame.method : undefined;
    const id = frame.id;
    const params = (frame.params ?? {}) as {
      sessionId?: unknown;
      status?: unknown;
      [key: string]: unknown;
    };
    const producer = typeof params.sessionId === "string" ? params.sessionId : undefined;

    if (method === "session.child-opened") {
      // Registered before anything else: the parent edge is what makes the
      // child's own frames routable.
      const parent = typeof params.parentSessionId === "string" ? params.parentSessionId : undefined;
      if (producer !== undefined && parent !== undefined && producer !== "") {
        this.#childParent.set(producer, parent);
      }
    }

    if (method === "paseo/question" && id !== undefined) {
      const owner = producer === undefined ? undefined : this.#rootOf(producer);
      if (owner === undefined) {
        this.#reportUnroutable(method, producer);
        // The bridge is blocked awaiting this answer. Failing the request is what
        // lets the model's question tool finish; silence would hang the turn.
        this.#send({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `no attached session for ${producer ?? "an unidentified session"}` },
        });
        return;
      }
      try {
        const handlers = this.#sessionHandlers.get(owner);
        const request = params as unknown as DshQuestionRequest;
        const answer = await handlers?.onQuestion(
          {
            callId: request.callId ?? null,
            timed: request.timed === true,
            questions: request.questions ?? [],
            ...(typeof request.sessionId === "string" ? { sessionId: request.sessionId } : {}),
          },
          typeof request.sessionId === "string" ? request.sessionId : "",
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
      const owner = producer === undefined ? undefined : this.#rootOf(producer);
      const handlers = owner === undefined ? undefined : this.#sessionHandlers.get(owner);
      if (handlers === undefined) {
        this.#holdOrphan(producer, method, { kind: "event", params: params as Record<string, unknown> });
        return;
      }
      handlers.onEvent(frame.params as DshSessionEvent);
      return;
    }
    if (method === "session.status") {
      const owner = producer === undefined ? undefined : this.#rootOf(producer);
      const handlers = owner === undefined ? undefined : this.#sessionHandlers.get(owner);
      if (handlers === undefined) {
        this.#holdOrphan(producer, method, { kind: "status", params: params as Record<string, unknown> });
        return;
      }
      handlers.onStatus(typeof params.status === "string" ? params.status : "unknown", producer ?? "");
      return;
    }
    if (method === "session.child-opened") {
      const owner = producer === undefined ? undefined : this.#rootOf(producer);
      const handlers = owner === undefined ? undefined : this.#sessionHandlers.get(owner);
      // The notice is held, not dropped, when its own parent chain does not reach
      // an attached session yet: a grandchild can be announced before the child
      // that parents it, and the session cannot open a view for a notice it never
      // receives. The edge above is already recorded, so this only delays delivery
      // — it never loses it, and it resolves as soon as an ancestor is announced.
      if (handlers === undefined || producer === undefined) {
        this.#holdOrphan(producer, method, {
          kind: "child-opened",
          params: params as Record<string, unknown>,
        });
        return;
      }
      handlers.onChildOpened?.(params as unknown as DshChildOpened);
      // This edge may have made a grandchild's held frames routable: a deeper
      // descendant can be announced before the child that parents it, and its
      // frames wait in `#orphanFrames` until the chain reaches an attached
      // session. Replayed after the notice, so the child view exists first.
      this.#replayOrphans();
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
   * Report one frame that arrived for a session nothing here serves.
   *
   * Dropped, never guessed: attaching it to whichever session happens to be
   * around would show one conversation's output inside another. Logged because a
   * silent drop is the failure mode this repo keeps re-learning — the user sees
   * "the agent went quiet" with nothing to explain it.
   */
  #reportUnroutable(method: string, sessionId: string | undefined): void {
    this.#processHandlers.onLog(
      `dropped ${method} for unknown session ${sessionId ?? "(none)"}; it belongs to no attached session`,
    );
  }

  /**
   * Hold one frame whose producing session has no resolvable owner yet.
   *
   * The bridge does not order an ancestor's `session.child-opened` before a
   * descendant's frames (see {@link OrphanFrame}), so "no owner" here is often
   * "not yet" rather than "never". Holding is what keeps a grandchild's earliest
   * message and its terminal `turn/end` from being lost to a reorder.
   *
   * A frame with no producing session id, or a producing session that is
   * genuinely not this process's, has nothing to wait for: it is reported and
   * dropped on the spot, exactly as before.
   *
   * @param producer - the session that produced the frame, from `params.sessionId`.
   * @param method - the frame method, for the log line.
   * @param frame - the held payload.
   */
  #holdOrphan(producer: string | undefined, method: string, frame: OrphanFrame): void {
    if (producer === undefined || producer === "") {
      this.#reportUnroutable(method, producer);
      return;
    }
    let bucket = this.#orphanFrames.get(producer);
    if (bucket === undefined) {
      bucket = { frames: [], since: Date.now() };
      this.#orphanFrames.set(producer, bucket);
      // One timer per producing session: a lineage that never resolves must not
      // buffer forever, and the frame is still reported when it gives up.
      const timer = setTimeout(() => {
        this.#orphanTimers.delete(producer);
        const held = this.#orphanFrames.get(producer);
        if (held === undefined) return;
        this.#orphanFrames.delete(producer);
        this.#processHandlers.onLog(
          `dropped ${held.frames.length} frame(s) for unknown session ${producer}; `
            + "no ancestor announced it within the hold window",
        );
      }, ORPHAN_FRAME_TTL_MS);
      timer.unref?.();
      this.#orphanTimers.set(producer, timer);
    }
    if (bucket.frames.length >= ORPHAN_FRAME_LIMIT) {
      // Keep the newest: the earliest frames of a child that never resolves are
      // the least likely to matter, and an unbounded bucket is a leak.
      bucket.frames.shift();
      this.#processHandlers.onLog(
        `orphan buffer full for ${producer} (${ORPHAN_FRAME_LIMIT}); dropping its oldest held frame`,
      );
    }
    bucket.frames.push(frame);
  }

  /**
   * Deliver every held frame whose lineage now resolves.
   *
   * Called after each `session.child-opened`, because that is the only frame that
   * creates a parent edge — and a single notice can resolve a whole chain of held
   * descendants at once. Resolution is re-evaluated per frame, so a chain that
   * only becomes complete after several notices drains progressively.
   *
   * Order is preserved per producing session: frames are replayed in arrival
   * order, which is what the child view's timeline needs. A held `child-opened`
   * is replayed through the same path as a live one, which is what makes its
   * parent edge and its delivery consistent — and can itself unblock the next
   * level, so the loop repeats until nothing more resolves.
   */
  #replayOrphans(): void {
    if (this.#orphanFrames.size === 0) return;
    // A notice resolved at one level can make a deeper one resolvable, so keep
    // sweeping until a pass delivers nothing. Bounded by the buffer's own size:
    // every pass that makes progress removes at least one bucket.
    let delivered = true;
    while (delivered && this.#orphanFrames.size > 0) {
      delivered = false;
      for (const [producer, bucket] of [...this.#orphanFrames]) {
        const owner = this.#rootOf(producer);
        const handlers = owner === undefined ? undefined : this.#sessionHandlers.get(owner);
        if (handlers === undefined) continue;
        const timer = this.#orphanTimers.get(producer);
        if (timer !== undefined) {
          clearTimeout(timer);
          this.#orphanTimers.delete(producer);
        }
        this.#orphanFrames.delete(producer);
        delivered = true;
        this.#processHandlers.onLog(
          `replaying ${bucket.frames.length} held frame(s) for ${producer} after its lineage resolved`,
        );
        for (const held of bucket.frames) {
          try {
            if (held.kind === "event") {
              handlers.onEvent(held.params as unknown as DshSessionEvent);
            } else if (held.kind === "status") {
              handlers.onStatus(
                typeof held.params["status"] === "string" ? held.params["status"] : "unknown",
                producer,
              );
            } else {
              handlers.onChildOpened?.(held.params as unknown as DshChildOpened);
            }
          } catch (error) {
            this.#processHandlers.onLog(
              `replaying a held ${held.kind} for ${producer} failed: ${toError(error, "replay failed").message}`,
            );
          }
        }
      }
    }
  }

  #failAll(error: Error): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) entry.reject(error);
  }
}
