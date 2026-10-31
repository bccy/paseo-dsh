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
import { createFrameReader, splitFrames, type FrameReader } from "./frame-reader";

/** JSON-compatible value tree; declared in {@link ./json-value}. */
export type { JsonValue } from "./json-value";

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

export interface DshApprovalRequest {
  requestId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}
export interface DshApprovalAnswer {
  outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable";
}
export type DshApprovalSignal = AbortSignal & { approvalTimedOut?: boolean };

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
 * The session's current context occupancy, measured by DSH's own replay-aware
 * token meter. Fields are absent when the runtime does not know them; a caller
 * must never substitute a default, because a fabricated window is worse than none.
 */
export interface DshUsage {
  available: boolean;
  /** Current context capacity of the live route, in tokens. */
  contextWindow?: number;
  /** Tokens the next request's prompt is expected to occupy. */
  usedTokens?: number;
}

/**
 * One background job of the composer's jobs pill, as the bridge projects it.
 *
 * The fields are DSH's own `JobView` vocabulary reduced to what a pill row
 * draws: identity, lifecycle, and the optional human-readable lines. `progress`
 * is cleared at settlement by DSH itself, so a settled row carries `detail`
 * (the terminal reason) instead — nothing is fabricated for either here.
 */
export interface DshJob {
  id: string;
  kind: string;
  label: string;
  status: "running" | "stopping" | "completed" | "killed" | "failed";
  /** Epoch ms when the job was registered. */
  startedAt: number;
  progress?: string;
  detail?: string;
  finishedAt?: number;
}

/**
 * One session's background jobs.
 *
 * `available: false` means the registry could not be read — not "no jobs". An
 * empty list is a real answer the pill hides on; an unreadable one must not be
 * shown as one.
 */
export interface DshJobs {
  available: boolean;
  jobs?: DshJob[];
  error?: { message?: string };
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

/** One live assistant-stream frame, already reduced by the bridge. */
export interface DshAssistantFrame {
  type: "start" | "chunk" | "end";
  attemptId: string;
  revision: number;
  /** Present on `start`. */
  turn?: number;
  step?: number;
  /** Present on a `chunk`: DSH's epoch-ms publication time. */
  time?: number;
  /** Present on a `chunk`: which row the delta belongs to. */
  kind?: "text" | "reasoning";
  /** Present on a `chunk`. */
  text?: string;
  /** Present on `end`. */
  outcome?: { kind: "committed" | "abandoned" };
}

export interface DshProcessHandlers {
  onEvent(payload: DshSessionEvent): void;
  /**
   * A live assistant-stream frame reduced by the bridge.
   *
   * **This fork does not use the `assistant.stream` channel, and no handler
   * provides this method.** Upstream 0.2.12+ introduced it as its live-stream
   * path, but this fork's bridge already subscribes to DSH's
   * `agent/assistant-stream` frames itself, assembles them with DSH's own
   * `BlockAssembler` and forwards throttled snapshots as `paseo/assistant-delta`
   * session events. Running both would render every token twice.
   *
   * It stays on the contract so the two channels are *documented* rather than
   * confused: a bridge that sends `assistant.stream` while no handler is
   * installed is a mismatch this process reports (see the dispatch below),
   * never a frame it silently drops. The plugin's own bridge is the other
   * channel, so this only fires against a mismatched bridge build.
   */
  onAssistantStream?(frame: DshAssistantFrame): void;
  /** `sessionId` is DSH's own id, so the caller can route by session. */
  onStatus(status: string, sessionId: string): void;
  onQuestion(request: DshQuestionRequest, sessionId: string): Promise<DshAnswer>;
  onPermission?(request: DshApprovalRequest, sessionId: string, signal: AbortSignal): Promise<DshApprovalAnswer>;
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

/**
 * How many orphan frames one producing session may accumulate.
 *
 * The bound is set from the **producer**, not from what feels generous. While a
 * child session is unopened the bridge holds its frames itself, up to
 * `CHILD_BUFFER_CAP = 500` (`dsh-bridge/lib/server.js:135`), and only then opens
 * the child and flushes them (`server.js:429-437`). A single flush can therefore
 * deliver ~500 frames of ONE child in one burst, and they arrive here *before*
 * the ancestor notice that would make them routable. A bucket smaller than that
 * overflowed in the middle of the very burst it exists to survive, and the
 * eviction it then performed dropped the child's earliest output and usually its
 * first `turn/end` — the exact loss this buffer is here to prevent. 1024 leaves
 * room for two bridge buffers plus live traffic in flight.
 *
 * Overflow is no longer solved by dropping the oldest frame: an oldest-first
 * eviction tears a turn apart (a `turn/end` survives while its `turn/start` is
 * gone, or the reverse), which is worse than an empty bucket because the session
 * is then stuck in a state nothing will close. A bucket that reaches this bound
 * has a lineage that will never resolve in practice, so it is discarded whole
 * and reported loudly.
 */
const ORPHAN_FRAME_LIMIT = 1024;
/**
 * How long a frame may wait for its lineage.
 *
 * A child's parent notice normally arrives within the same burst, so this only
 * bounds a lineage that will never resolve (a child of a session this process
 * does not serve). Expiry re-checks the lineage once before giving up: a
 * resolvable chain that simply arrived late must be replayed rather than
 * dropped, because the two things that create an edge — `session.child-opened`
 * and `subagents()` — are both asynchronous relative to `session.open`, and a
 * bucket can outlive the notice by a few milliseconds.
 */
const ORPHAN_FRAME_TTL_MS = 5_000;
/**
 * How long `session/close` waits for its receipt before giving up.
 *
 * The bridge's close disposes the session's agent and has no deadline of its own,
 * so at the request default (120 s) one unresponsive close would hold the caller
 * for two minutes and every other session on the process queued behind it. The
 * local half of the close (detaching this session's handlers) has already
 * happened by then, and the failure is logged. Measured on the real bridge, the
 * bridge's own bookkeeping costs ~0.4 ms and the rest is however long the agent
 * takes to go idle, which for an interactive turn is seconds — 10 s covers it, and
 * the case it does not cover is handled rather than left to chance: the timed-out
 * request is remembered per session and the next attach waits for it
 * ({@link DshProcess.#closeTasks}). That is the difference between "we stopped
 * waiting" and "nobody is waiting any more".
 */
const SESSION_CLOSE_TIMEOUT_MS = 10_000;
/**
 * How long the next attach waits for a close that outlived
 * {@link SESSION_CLOSE_TIMEOUT_MS}.
 *
 * The bridge now waits for the same teardown on its side
 * (`#awaitTeardown`, bounded at 30 s there), so this is the plugin's own bound on
 * the same condition: after it, the attach proceeds and the session may lose its
 * first prompt — reported, never hidden. It is deliberately longer than the
 * bridge's bound so the bridge's diagnosis wins when both fire.
 */
const CLOSE_PENDING_TIMEOUT_MS = 35_000;

/**
 * How long one `paseo/jobs` read may take.
 *
 * Much shorter than the other bounds here: the composer pill polls this on a timer
 * (`POLL_MS` in `client/jobs-pill.tsx`), so a slow answer is worth less than the
 * next poll. Named because the client's interval is chosen against it — changing
 * either without the other is what this constant makes visible.
 */
const JOBS_READ_TIMEOUT_MS = 15_000;

/**
 * The bridge's reply when it does not implement a method at all — the verbatim
 * prefix its `handleRequest` `default:` branch throws. Matched as a substring for
 * the same reason as {@link DshProcess.#isNotInitializedError}: the transport
 * passes messages through unchanged.
 *
 * A bridge predating `paseo/jobs` is the real case, and it is **not** "the registry
 * could not be read" — the user's next step differs, so the two must not collapse
 * into one message.
 */
const UNKNOWN_BRIDGE_METHOD_PREFIX = "unknown paseo bridge method:";

/** What the pill shows when the profile's bridge has no `paseo/jobs`. */
const BRIDGE_TOO_OLD_MESSAGE =
  "this profile's bridge has no jobs support (it predates paseo/jobs); reload the plugin so the embedded bridge is rewritten";

/** What one attached session contributes besides its handlers. */
export interface DshSessionOptions {
  systemPrompt?: string;
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
   * The id this process is constructed under.
   *
   * Three roles, and the third is what makes its meaning precise:
   *
   * 1. A real conversation attached at construction (the single-session
   *    construction, and every one-shot probe that names a real id).
   * 2. The fallback key for `#sessionOptions` when a session names none.
   * 3. **Possibly not a session at all.** The shared process is constructed
   *    with a sentinel (`POOL_PLACEHOLDER_SESSION_ID` in `provider.ts`), which
   *    serves sessions through {@link DshProcess.attachSession} and has no
   *    conversation of its own. That sentinel must never reach a session-scoped
   *    bridge frame, so the process-level `initialize` is sent WITHOUT it: see
   *    {@link DshProcess.#initializeSession} for where and why the two kinds of
   *    initialization diverge.
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

/**
 * DSH's `serverName` contract: a tool-name namespace, not a free-form label.
 *
 * It applies to **one** path only — a server mounted through the native
 * `dsh-mcp-client`, where DSH builds tool names as `mcp__<serverName>__<tool>`,
 * so the name has to be usable as an identifier fragment. A server that rides the
 * gateway never becomes a tool namespace (its tools are reached through
 * `mcp_call_tool` and addressed by string), and the gateway's own `Config` is a
 * plain dict that accepts any key — measured: `foo.bar`, `com.acme.tools`,
 * `my server` and even a CJK name all validate there.
 *
 * Applying it to every server was a defect with an outsized symptom: Paseo does
 * not restrict server names either (`z.record(z.string(), McpServerConfigSchema)`
 * plus a duplicate check), so a user or plugin that configured `com.acme.tools`
 * as an HTTP server could not open the session **at all** — not even with Paseo's
 * own tools, because this throws during `attachSession`.
 */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Keys that must not be used as a gateway server name.
 *
 * `__proto__` is the only one that matters and it is not a style preference: the
 * gateway's `config.servers` is a dictionary built from this object, and a
 * `__proto__` key does not behave like a key in a JavaScript object — it either
 * mutates the prototype or silently vanishes from `Object.keys`, which is the
 * "server quietly disappeared" failure this whole translation layer is supposed
 * to prevent. Refusing it by name is the loud half of that choice; the silent
 * half (a `proxied` map with a prototype) is fixed by `Object.create(null)`.
 */
const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(["__proto__"]);

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
  return resolveBrowserMcpServer(cwd).server;
}

/**
 * Validate a session's MCP servers **before** anything is spawned for it.
 *
 * `attachSession` already translates the entries, and that translation is what
 * rejects an unmountable server — but `attachSession` runs *after*
 * `acquireProcess()` (`session.ts` `open()`), so on a cold pool a refused open has
 * already spawned a `dsh` child and validated its route before the rejection is
 * even reached. The child is retired ~4 s later, so nothing leaks, but the work is
 * pointless and — worse — the assertion that used to guard it was written against
 * the warm pool, where no spawn happens anyway, so it could not fail.
 *
 * This runs the same translation early and discards the result. Same function, so
 * the two answers cannot disagree: a pre-check that disagreed with the real one
 * would be a new class of bug (an open rejected for a server that would have
 * mounted, or accepted for one that then fails).
 *
 * No browser injection here on purpose: `browserMcpServer()` is this plugin's own
 * construction and cannot be unmountable, and calling it would emit a second
 * stderr line for every session that has no browser. An entry Paseo itself
 * supplies under the same name takes precedence anyway (see
 * {@link sessionMcpEntries}), so the name is validated as a plain entry — which is
 * exactly what `attachSession` will do with it.
 *
 * @param servers - the MCP servers Paseo attached to this session, if any.
 * @throws when a server cannot be represented in DSH (same message as the mount).
 */
export function validateMcpServers(
  servers: Readonly<Record<string, DshMcpServer>> | undefined,
): void {
  if (servers === undefined) return;
  mcpEntries(servers, new Set());
}

/**
 * Why this session has no browser MCP server **although one should be there**.
 *
 * The distinction this function exists to draw:
 *
 * - **The browser plugin is not installed.** `mcp-bridge.mjs` is absent, so there
 *   is no browser capability to be missing. This returns `undefined`: a timeline
 *   warning on every open of every session would be noise, and worse than noise —
 *   it would tell a user who never installed Server Browser that something is
 *   broken. The stderr line stays (it is what a developer diagnosing a profile
 *   needs), but the timeline stays quiet.
 * - **The plugin is installed and this session still cannot use it.** The bridge
 *   file is there, and the failure is per-session: the cwd maps to no single live
 *   Paseo workspace, or the registry cannot be read. That is a real, actionable
 *   difference — the user has the feature, expects it, and this session silently
 *   lacks it. The provider turns this into an open warning.
 *
 * Recomputing rather than widening `browserMcpServer`'s return type is deliberate:
 * the fail-open contract is "undefined, never throws", and a richer return value
 * would invite callers to branch on the reason and eventually to throw. The
 * resolution is one `existsSync` plus one registry read, and the provider only
 * calls it when it is about to emit warnings anyway.
 *
 * @param cwd - the session's working directory, as passed to `dsh`.
 * @returns the reason when the bridge exists but cannot be mounted here, else
 *   `undefined` — including when the browser plugin is simply not installed.
 */
export function browserMcpGap(cwd: string): string | undefined {
  return resolveBrowserMcpServer(cwd).gap;
}

/**
 * Locate the browser bridge once, keeping the reason when it cannot be used here.
 *
 * One implementation for both public views above, so "there is no bridge" and
 * "here is why there is no bridge" can never disagree — which they would if the
 * reason were re-derived by a second copy of these checks.
 *
 * `gap` is set **only** when the bridge exists and this session cannot mount it;
 * an absent bridge is reported to stderr and yields no gap, because "you never
 * installed the browser plugin" is not a per-session failure. See
 * {@link browserMcpGap}.
 *
 * @param cwd - the session's working directory.
 * @returns the entry, or the reason a present bridge could not be used.
 */
function resolveBrowserMcpServer(cwd: string): { server?: DshMcpServer; gap?: string } {
  const env = process.env;
  const dataRoot = browserDataRoot(env);
  const bridge = join(dataRoot, "mcp-bridge.mjs");
  // A profile without the browser plugin would otherwise mount a server whose
  // command fails at spawn time; DSH reports that as "did not activate", which
  // reads like a plugin bug rather than an absent feature. Logged and NOT turned
  // into a gap: see this function's doc comment.
  if (!existsSync(bridge)) {
    logBrowserGap(`bridge not found at ${bridge}`);
    return {};
  }
  try {
    const workspaceId = browserWorkspaceId(cwd, paseoHome(env), env);
    if (workspaceId === undefined) {
      const reason = `cwd ${cwd} maps to no single live Paseo workspace`;
      logBrowserGap(reason);
      return {
        gap: `工作目录 ${cwd} 没有唯一对应的活动 Paseo 工作区`
          + `（${join(paseoHome(env), "projects", "workspaces.json")}）`,
      };
    }
    return {
      server: {
        type: "stdio",
        command: process.execPath,
        args: [bridge, join(dataRoot, workspaceId, "session.json")],
      },
    };
  } catch (error) {
    // Deliberately swallowed: see the fail-open note above. Logged so an
    // unreadable registry or a malformed file is diagnosable instead of looking
    // like a feature this build simply does not have. This one IS a gap: the
    // bridge is installed, so the capability was expected here.
    const message = error instanceof Error ? error.message : String(error);
    logBrowserGap(message);
    return { gap: `读取 Paseo 工作区注册表失败：${message}` };
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
 * The transport string one entry names, verbatim, for the refusal message.
 *
 * Reading the raw value rather than a narrowed union is the point: the whole
 * class of defect here is a `type` that is not one of the three known strings, and
 * a helper that returned a union would have to collapse that case into a default.
 * `DshMcpServer` declares the type as required, so the cast is only to keep a
 * malformed frame from being a type error at the call site — the runtime value is
 * whatever Paseo (or a contributing plugin) actually sent.
 */
function rawTransportType(server: DshMcpServer): unknown {
  return (server as { type?: unknown }).type;
}

/**
 * Translate Paseo's MCP servers into the entries the bridge mounts.
 *
 * Streamable-HTTP servers and the self-injected browser bridge ride the gateway
 * (one row, three tools). Every other stdio server keeps the stock client: it was
 * configured by the user, and dropping it — or quietly demoting it to discovery
 * calls — would remove capability they asked for. Legacy SSE stays refused.
 *
 * These are DSH patch entries in shape (`{ name, config }`), which is what the
 * bridge's `paseo/mcp/set` consumes. Keeping that shape means the bridge only
 * has to call `ctx.plugin(await import(entry.name), entry.config)` and never
 * learns which plugin is the gateway — the whitelist and the native/refused
 * decision stay here, in the layer that owns the translation.
 *
 * @param servers - the session's MCP servers, browser bridge already merged in.
 * @param selfInjected - names this plugin produced itself (see
 *   {@link sessionMcpEntries}); only those may be proxied as whitelisted stdio.
 * @throws when a server cannot be represented in DSH, or names an unknown
 *   transport. Every message names the server and none of them quotes `env`,
 *   `args` or `headers`, because those carry credentials.
 */
function mcpEntries(
  servers: Readonly<Record<string, DshMcpServer>>,
  selfInjected: ReadonlySet<string>,
): DshMcpEntry[] {
  const entries: DshMcpEntry[] = [];
  // Null-prototype on purpose: a server literally named `__proto__` must either be
  // a normal key here or be refused loudly — it must never silently vanish from
  // `Object.keys` because it hit a setter on `Object.prototype`. It is refused
  // below (RESERVED_MCP_SERVER_NAMES) AND this map cannot be poisoned; both halves
  // are kept because either one alone leaves a way for a server to disappear.
  const proxied: Record<string, GatewayServerConfig> = Object.create(null) as Record<
    string,
    GatewayServerConfig
  >;
  for (const [name, server] of Object.entries(servers)) {
    if (RESERVED_MCP_SERVER_NAMES.has(name)) {
      throw new Error(
        `MCP server name "${name}" cannot be used: it is reserved by JavaScript's object model `
          + 'and would not survive the gateway\'s configuration map',
      );
    }
    if (server.type === "stdio") {
      // Only this branch needs the identifier-shaped name: it becomes a DSH tool
      // namespace (`mcp__<serverName>__<tool>`). See {@link MCP_SERVER_NAME}.
      if (!MCP_SERVER_NAME.test(name)) {
        throw new Error(
          `MCP server "${name}" cannot be mounted in DSH: a serverName must match ${MCP_SERVER_NAME.source}`,
        );
      }
      // Whitelisted **and** self-injected. The name alone was not enough: a user
      // who configures their own stdio server called `server_browser` was proxied
      // too, silently demoting their full tool surface to three-step discovery.
      // The whitelist is about *this plugin's* wide, rarely-called bridge, not
      // about a string.
      if (GATEWAY_STDIO_SERVERS.has(name) && selfInjected.has(name)) {
        // `env` and `args` pass through untouched — the browser bridge needs both
        // the session-file path and the daemon's environment to find its Chromium.
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
    if (server.type === "http") {
      proxied[name] = {
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }),
      };
      continue;
    }
    // Unknown or missing `type` — the last branch, and a refusal rather than a
    // guess. The previous behavior proxied it as Streamable HTTP, which opened the
    // session successfully and deferred the failure to the first tool call, where
    // the gateway's config error echoed the whole entry — including any
    // `Authorization` header — into text the model can read. Neither the value nor
    // the entry is quoted: the message names the server and the offending type,
    // nothing else.
    const named = rawTransportType(server);
    throw new Error(
      `MCP server "${name}" has an unsupported transport type `
        + `${typeof named === "string" ? `"${named}"` : "(none)"}; expected "stdio" or "http" `
        + '(legacy "sse" is not supported either)',
    );
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
 * The set of names this function injected is handed to {@link mcpEntries} as
 * `selfInjected`, and that is what the gateway whitelist is checked against: a
 * whitelist keyed on the name alone would also proxy a *user's* stdio server that
 * happens to be called `server_browser`, which is the capability regression the
 * whitelist exists to avoid. The provenance is only knowable here, so it is
 * recorded here.
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
  const selfInjected = new Set<string>();
  if (!Object.hasOwn(merged, BROWSER_MCP_SERVER)) {
    const browser = browserMcpServer(cwd);
    if (browser !== undefined) {
      merged[BROWSER_MCP_SERVER] = browser;
      selfInjected.add(BROWSER_MCP_SERVER);
    }
  }
  if (Object.keys(merged).length === 0) return [];
  return mcpEntries(merged, selfInjected);
}

export class DshProcess {
  readonly #options: DshProcessOptions;
  /**
   * The handlers that belong to the child itself rather than to any one session:
   * stderr lines, JSON-RPC protocol failures and **the child's own exit**. They
   * stay process-wide so a session cannot silence diagnostics for the sessions
   * sharing its process.
   *
   * `onExit` belongs here rather than only to the session that happens to share
   * the child's construction id. It used to reach the owner *only* through that
   * session's handler set (the constructor installs one for `options.sessionId`,
   * and `#exitAll` calls it like any other), which made a process-level callback
   * depend on that entry still being in the map: detaching the construction id
   * would have silently stopped reporting the exit the provider's pool
   * bookkeeping listens for. Both paths now converge on {@link #reportExit},
   * which fires the callback **exactly once** per child. A parked process is the
   * case that needs this: `setHandlers` re-points both the process-level sink and
   * the construction session, and the pool's "forget the exited child" must run
   * once, not twice.
   *
   * Mutable on purpose: {@link setHandlers} re-points a parked process.
   */
  #processHandlers: {
    onLog(line: string): void;
    onProtocolError(message: string): void;
    onExit(code: number | null, signal: string | null): void;
  };
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
  readonly #approvalRequests = new Map<string, { sessionId: string; controller: AbortController }>();
  /** Sessions that have completed their own `initialize` in this child. */
  readonly #initializedSessions = new Set<string>();
  /** Sessions whose MCP entries have been handed to the bridge. */
  readonly #mcpSent = new Set<string>();
  /** The entries each session mounts, translated once (translation may throw). */
  readonly #sessionMcp = new Map<string, DshMcpEntry[]>();
  /** Memoized per-session preparation, so concurrent callers share one attempt. */
  readonly #readyTasks = new Map<string, Promise<void>>();
  /**
   * sessionId -> the `session/close` it last sent, while that request is pending.
   *
   * Kept because the request outlives the caller's patience: {@link closeSession}
   * gives up after {@link SESSION_CLOSE_TIMEOUT_MS}, and the bridge's dispose —
   * the thing that actually closes the session log's write handle — keeps running.
   * The reopen that follows must wait for it, which is what {@link #awaitClose}
   * does. Deliberately NOT cleared by {@link detachSession}: the close is sent
   * from there, so clearing it on detach would erase the very record the next
   * attach needs.
   */
  readonly #closeTasks = new Map<string, Promise<void>>();
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
   *
   * `since` is DIAGNOSTIC ONLY and is deliberately never read: the deadline is
   * `#orphanTimers`, one timer per bucket, because a timestamp would have to be
   * polled to have any effect and a poll loop is a timer that fires for every
   * bucket anyway. It is kept on the record so a future log line can say how long
   * a bucket lived without adding a field to the hot path.
   */
  readonly #orphanFrames = new Map<string, { frames: OrphanFrame[]; since: number }>();
  /** Timers that report and drop one orphan bucket that never became routable. */
  readonly #orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #child: ChildProcessWithoutNullStreams | undefined;
  /**
   * The stdout frame splitter for this child.
   *
   * Replaced on every spawn rather than reused: a `FrameReader` holds the
   * partial line of the stream it was created for, and carrying that across a
   * respawn would prepend a dead child's half-frame to the new child's first one.
   *
   * Assigned in the constructor rather than by a field initializer: the reader's
   * overflow callback reports through {@link #processHandlers}, which is itself
   * only assigned there. Field initializers run before the constructor body, so
   * the sink would not exist yet — a latent ordering hazard that costs nothing to
   * avoid.
   */
  #frames: FrameReader;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  /**
   * Whether the mismatched-`assistant.stream` bridge has been reported.
   *
   * Latched because the bridge sends one frame per streamed chunk: an unlatched
   * warning would be thousands of identical stderr lines per answer, which is
   * how a warning that matters gets ignored (same reasoning as the bridge's own
   * `REPORTED_MISSING_SERVICES`).
   */
  #warnedAssistantStream = false;
  /**
   * Whether the "this bridge has no paseo/jobs" line has been logged.
   *
   * Latched for the same reason as {@link #warnedAssistantStream}: the pill polls
   * every four seconds, so an unlatched line would be a steady stderr stream that
   * buries everything else.
   */
  #warnedJobsUnsupported = false;
  /** Whether the process-level exit callback has already fired for this child. */
  #exitReported = false;
  #initializeTask: Promise<void> | undefined;
  /** Resolved once the child is gone; created lazily by {@link waitForExit}. */
  #exited: Promise<void> | undefined;
  #resolveExited: (() => void) | undefined;

  constructor(options: DshProcessOptions) {
    this.#options = options;
    this.#processHandlers = {
      onLog: (line) => options.onLog(line),
      onProtocolError: (message) => options.onProtocolError(message),
      onExit: (code, signal) => options.onExit(code, signal),
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
      onPermission: options.onPermission,
      ...(options.onChildOpened === undefined
        ? {}
        : { onChildOpened: (payload: DshChildOpened) => options.onChildOpened?.(payload) }),
      onExit: (code, signal) => options.onExit(code, signal),
    });
    // After the sinks, because the reader's overflow report goes through them.
    this.#frames = this.#createFrames();
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
      onExit: (code, signal) => handlers.onExit(code, signal),
    };
    this.#sessionHandlers.set(this.#options.sessionId, {
      onEvent: (payload) => handlers.onEvent(payload),
      onStatus: (status, sessionId) => handlers.onStatus(status, sessionId),
      onQuestion: (request, sessionId) => handlers.onQuestion(request, sessionId),
      onPermission: handlers.onPermission,
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
    // A second attach for the same id is a bug in the caller, and it used to be
    // silent: `set` replaced the first owner's handlers without a word, and then
    // that first owner's `closeSession` deleted the SECOND owner's handlers — the
    // conversation that was still running lost its frames, and the one that had
    // just opened went on holding a bridge session nobody would ever close.
    // Frames are delivered by id, so there is no way to serve two owners at once;
    // the second attach must fail loudly instead of quietly stealing the slot.
    // Re-attaching after `detachSession` is the supported path and has no entry
    // here, which is what keeps Paseo's refresh (close, then reopen with the same
    // persistence) working.
    const existing = this.#sessionHandlers.get(sessionId);
    if (existing !== undefined) {
      throw new Error(
        `session ${sessionId} is already attached to this process; `
          + "detach it before attaching it again",
      );
    }
    this.#sessionHandlers.set(sessionId, handlers);
    const merged: DshSessionOptions = { ...(this.#sessionOptions.get(sessionId) ?? {}) };
    if (options.cwd !== undefined) merged.cwd = options.cwd;
    if (options.route !== undefined) merged.route = options.route;
    if (options.mcpServers !== undefined) merged.mcpServers = options.mcpServers;
    merged.systemPrompt = options.systemPrompt;
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
   * Held orphan frames are part of "everything". They are keyed by the session
   * that *produced* them, which for a detached conversation means its own id or
   * one of its descendants' — and a bucket that outlives its owner is a lie with
   * a deadline: its timer fires a few seconds later and reports "no ancestor
   * announced it within the hold window", which is the wrong cause (the
   * conversation was closed) and the wrong owner (a session that no longer
   * exists). They are dropped here instead, with their timers, so the log says
   * nothing rather than something false.
   *
   * @param sessionId - the session to detach; unknown ids are ignored.
   */
  detachSession(sessionId: string): void {
    for (const pending of this.#approvalRequests.values()) {
      if (pending.sessionId === sessionId) pending.controller.abort();
    }
    if (!this.#sessionHandlers.delete(sessionId)) return;
    this.#sessionOptions.delete(sessionId);
    this.#sessionMcp.delete(sessionId);
    this.#initializedSessions.delete(sessionId);
    this.#mcpSent.delete(sessionId);
    this.#readyTasks.delete(sessionId);
    // Order matters: the descendant set comes from `#childParent`, and forgetting
    // the edges first would leave every held grandchild bucket behind.
    const forgotten = this.#forgetChildrenOf(sessionId);
    this.#dropOrphansOf(forgotten);
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
    const task = this.#sendClose(sessionId);
    this.#closeTasks.set(sessionId, task);
    try {
      await task;
    } finally {
      // Only clear our own record: a newer close of the same id may already have
      // replaced it, and that one's waiters must not be released early.
      if (this.#closeTasks.get(sessionId) === task) this.#closeTasks.delete(sessionId);
    }
  }

  /**
   * Send one `session/close` and log what came back; never throws.
   *
   * Separate from {@link closeSession} because the promise itself has to be
   * retained: the public method awaits it with a bound that the *bridge's* dispose
   * can outlive, and everything that reopens the same session needs to know the
   * dispose is still running. See {@link #awaitClose}.
   *
   * @param sessionId - the session being closed.
   */
  async #sendClose(sessionId: string): Promise<void> {
    try {
      // A **bounded** wait, deliberately short. This runs on the teardown path
      // (a Paseo close or refresh), and the bridge's `session/close`
      // disposes the session's agent — which can take as long as the agent's own
      // shutdown does, and has no deadline of its own. At the default 120 s a
      // child that stopped answering held the caller for two minutes, and every
      // session on this shared process waited behind it. The session's handlers
      // are already detached above, so the local half of the close has happened;
      // giving up on the receipt only means the bridge's tables shrink later or
      // not at all, and that is reported rather than hidden.
      //
      // Giving up here does NOT mean nobody waits: the bridge records its own
      // teardown (`server.js` `#trackTeardown`) and the next creation of this id
      // waits for it, and this side records the promise so the next attach can
      // wait too ({@link #awaitClose}). Without that pair, a slow dispose became
      // "reopened before it finished", whose symptom is a session that opens and
      // then fails its first prompt with "already owned by an active write
      // handle".
      const result = (await this.#request("session/close", { sessionId }, SESSION_CLOSE_TIMEOUT_MS)) as
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

  /**
   * Wait (bounded) for a close of this id that the caller already abandoned.
   *
   * The bridge's dispose — which is what closes the session log's write handle —
   * can outlive {@link SESSION_CLOSE_TIMEOUT_MS}, and the reopen that follows (a
   * Paseo refresh, a daemon restart, a user reopening the same conversation)
   * starts milliseconds later. Attaching into that window used to produce a
   * session that reported itself ready and then failed its FIRST prompt with
   * "already owned by an active write handle", because the previous agent still
   * held the lease.
   *
   * Two-sided on purpose: the bridge waits for its own teardown before creating
   * the agent (`server.js` `#awaitTeardown`), and this waits before sending the
   * session's `initialize`/`paseo/mcp/set`. Waiting only on one side still leaves
   * the other's frames queued behind an open write handle.
   *
   * A timeout is logged, not thrown: the attach must still be attempted, because
   * a close that never finishes must not become a session that can never open.
   *
   * @param sessionId - the session about to be attached.
   */
  async #awaitClose(sessionId: string): Promise<void> {
    const pending = this.#closeTasks.get(sessionId);
    if (pending === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_PENDING_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([pending, bounded]);
    if (timer !== undefined) clearTimeout(timer);
    if (this.#closeTasks.get(sessionId) !== pending) return;
    this.#processHandlers.onLog(
      `the previous close of ${sessionId} is still waiting for its receipt after `
        + `${String(CLOSE_PENDING_TIMEOUT_MS)}ms; attaching anyway — the first turn may fail if the `
        + "bridge is still disposing that agent",
    );
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

    // A fresh splitter per spawn: see {@link #frames}. Created before the first
    // `data` handler can run, which is guaranteed because nothing yields between
    // here and the listener registration below.
    this.#frames = this.#createFrames();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") this.#processHandlers.onLog(line);
      }
    });
    // Writing to a dead child's stdin fails **asynchronously**, and an 'error'
    // event with no listener is an uncaught exception: the default action is to
    // terminate the process. That is the whole reason this listener exists. The
    // sync try/catch in `#send` cannot see it — the write returns before the pipe
    // reports the broken end — and it is reachable in normal use: a frame larger
    // than the pipe buffer (a screenshot in a prompt, a big tool argument, a
    // `paseo/history` request; Linux's default buffer is 64 KB) sits in the pipe
    // waiting for the child to read it, so a child that dies at that moment
    // leaves unread bytes behind and the stream emits EPIPE.
    //
    // The consequence used to be out of proportion to the cause: this process is
    // shared, so its death ends **every** conversation it serves, not just the
    // one whose frame was in flight. Reported and failed here instead, the same
    // way the child's own 'error' event is — and deliberately not with a
    // `process.on("uncaughtException")`, which would take the plugin's problem
    // and hand it to the host daemon.
    //
    // No `#markExited()`: the child may still be running, and its 'exit' event is
    // what owns that bookkeeping. Failing the pending requests is the point — they
    // reject now instead of waiting out their timeouts.
    child.stdin.on("error", (error) => {
      const failure = toError(error, "failed to write to the bridge");
      this.#processHandlers.onProtocolError(failure.message);
      this.#failAll(failure);
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

    // The **process** is initialized here, never the construction id as a
    // session. See {@link #prepareProcess}: the shared process is built under a
    // sentinel that is not a conversation, and the session half of `initialize`
    // must not be sent for it.
    await this.#prepareProcess();
  }

  /**
   * Compose this child's LLM adapter and validate its route — the process-level
   * half of `initialize`, sent with **no session id**.
   *
   * The bridge's `initialize` does two separable things, and this method exists
   * because only the first one belongs to a process:
   *
   * - **Process-level** (before its table writes, `dsh-bridge/lib/server.js:732-757`):
   *   resolve the adapter for `provider`, `ctx.plugin()` it into `llmFibers`, and
   *   `resolveCallConfig()` the route. This is per child — an adapter fiber lives
   *   for the life of the process — and it is what makes every session's first
   *   prompt cheap instead of re-validating a route per conversation.
   * - **Session-level** (`server.js:762-772`): write `sessionCwd`,
   *   `sessionRoutes` and `initializedSessions` for the id on the frame, which is
   *   also what admits that id to `prompt` (`server.js:817`).
   *
   * Omitting the id selects the bridge's process-wide form (`server.js:762-768`),
   * which does the same adapter work and the same route validation while writing
   * only the process defaults `routeFor`/`sessionDirectoryFor` already use as a
   * last-resort fallback. Sending the sentinel instead would create four
   * session-keyed bridge entries for a session nothing ever closes
   * (`sessionCwd`, `sessionRoutes`, `initializedSessions`, and — through
   * `paseo/mcp/set` — `pendingMcpServers`), because `closeSession` is only ever
   * called for an id some provider session attached.
   *
   * A construction id that IS a real conversation is not harmed by this: every
   * session-scoped method goes through {@link #ensureSessionReady}, and
   * {@link attachSession} does so explicitly, so that id initializes itself with
   * its own id on first use.
   */
  async #prepareProcess(): Promise<void> {
    const route = this.#options.route;
    await this.#request("initialize", {
      cwd: this.#options.cwd,
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    });
  }

  /**
   * Pin one **session's** cwd and route in the bridge.
   *
   * The id always travels here: it is what makes the bridge store the values
   * against that session instead of as this process's defaults, and what admits
   * the session to `prompt` at all. Only sessions that a provider actually
   * attached reach this, so every id written this way has a `closeSession`
   * counterpart. Idempotent.
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
      systemPrompt: options.systemPrompt ?? "",
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
    // A close of this same id may still be inside the bridge's dispose, and that
    // dispose is what closes the session log's write handle. Sending this
    // session's `initialize`/`paseo/mcp/set` into that window is harmless for the
    // frames themselves, but the agent they prepare for is created by the prompt
    // right after them — and THAT is what fails with "already owned by an active
    // write handle". Waiting here is what closes the race; see {@link #awaitClose}.
    await this.#awaitClose(sessionId);
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

  /**
   * Drop every child->parent edge that pointed into a detached session.
   *
   * @returns every id whose edge was removed, **including** the root: the caller
   *   needs the descendant set to drop the orphan buckets those ids produced.
   */
  #forgetChildrenOf(root: string): ReadonlySet<string> {
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
    return removed;
  }

  /**
   * Drop the held orphan frames a detached session (and its descendants) produced.
   *
   * See {@link detachSession}: an orphan bucket is a promise to replay a frame
   * once its lineage resolves, and a closed conversation will never resolve it.
   * The timer is cleared with the bucket because it exists only to report the
   * bucket's expiry — leaving it armed would log a misleading cause 5 s later.
   *
   * @param producers - the detached session id plus every known descendant.
   */
  #dropOrphansOf(producers: ReadonlySet<string>): void {
    for (const producer of producers) {
      const timer = this.#orphanTimers.get(producer);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.#orphanTimers.delete(producer);
      }
      this.#orphanFrames.delete(producer);
    }
  }

  /**
   * Tell every attached session the child is gone, and fire the process-level
   * exit callback **once**.
   *
   * Two audiences, and they are not the same thing: a session learns its
   * conversation died (`session.runtime_failed`), and the process owner learns
   * the child itself died (the provider's `#onPoolExit`, which drops the pooled
   * reference and its claims). The process-level callback used to be reachable
   * only as a side effect of the construction session still being attached — see
   * {@link #processHandlers} — so it is called explicitly here, and
   * {@link #reportExit} makes the "once" hold even when that session's own
   * `onExit` is the very same function.
   */
  #exitAll(code: number | null, signal: string | null): void {
    for (const pending of this.#approvalRequests.values()) pending.controller.abort();
    // The child dying ends every conversation it served, so all of them hear it
    // — not just whichever handler happened to be assigned last.
    for (const [sessionId, handlers] of [...this.#sessionHandlers]) {
      // The construction session's `onExit` **is** `options.onExit` (the
      // constructor and `setHandlers` both wire it that way). Skipping it here
      // and firing the process-level sink below calls it exactly once; calling
      // both would deliver the same callback twice, which the parked pool reads
      // as two forgets and the provider logs as two exits.
      if (sessionId === this.#options.sessionId) continue;
      try {
        handlers.onExit(code, signal);
      } catch (error) {
        this.#processHandlers.onLog(
          `session ${sessionId} exit handler failed: ${toError(error, "exit handler failed").message}`,
        );
      }
    }
    this.#reportExit(code, signal);
  }

  /**
   * Fire the process-level exit callback exactly once per child.
   *
   * The provider's `#onPoolExit` is not idempotent in a harmless way: the first
   * call drops the pooled reference and every claim, so a second call for the
   * same child finds `#pooled !== child` and returns — the duplicate is therefore
   * quiet, but the *log line* it writes when it does match would appear twice if
   * the two paths ever both fired, which reads as "the child exited twice". The
   * latch makes the contract explicit instead of relying on the consumer's guards.
   *
   * A throwing callback is logged, never propagated: this runs inside the child's
   * own `exit` listener, and an exception there would escape into Node's event
   * loop for a process that is already gone.
   */
  #reportExit(code: number | null, signal: string | null): void {
    if (this.#exitReported) return;
    this.#exitReported = true;
    try {
      this.#processHandlers.onExit(code, signal);
    } catch (error) {
      this.#processHandlers.onLog(
        `process exit handler failed: ${toError(error, "exit handler failed").message}`,
      );
    }
  }

  /** Read the runtime's provider/model catalog without creating an agent. */
  async catalog(): Promise<DshCatalog> {
    return (await this.#request("paseo/catalog", {}, 60000)) as DshCatalog;
  }

  /**
   * List the session's registered commands and user-invocable skills.
   *
   * @param sessionId - which session; required — there is no default.
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
   * @param sessionId - which session; required — there is no default.
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
   * @param sessionId - which session; required — there is no default.
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
   * @param sessionId - which session; required — there is no default.
   */
  async usage(sessionId: string): Promise<DshUsage> {
    await this.#ensureSessionReady(sessionId);
    return (await this.#request("paseo/usage", {
      sessionId,
    })) as DshUsage;
  }

  /**
   * Read the background jobs this session owns.
   *
   * A short timeout, unlike the catalog and history reads: the composer pill
   * polls this on a timer, and a slow answer is worth less than the next poll —
   * a 120 s bound would let one stalled frame wedge the pill for two minutes.
   * The answer is never defaulted to an empty list here; `available: false`
   * travels through so the caller can say "could not read" instead of "none".
   *
   * @param sessionId - which session; required — there is no default.
   */
  async jobs(sessionId: string): Promise<DshJobs> {
    await this.#ensureSessionReady(sessionId);
    try {
      return (await this.#request("paseo/jobs", { sessionId }, JOBS_READ_TIMEOUT_MS)) as DshJobs;
    } catch (error) {
      // A bridge without this method is not "the registry could not be read": the
      // user's next step is to get a newer bridge, not to wait. Reported through
      // `available: false` because the pill has no other way to say "I could not
      // look" — but with a message that says what to do.
      if (!this.#isUnknownBridgeMethodError(error)) throw error;
      if (!this.#warnedJobsUnsupported) {
        this.#warnedJobsUnsupported = true;
        // Once per process: the pill polls every four seconds, so an unlatched
        // line would bury the log (same reasoning as `#warnedAssistantStream`).
        this.#processHandlers.onLog(
          `the bridge does not implement paseo/jobs (it predates jobs support); ` +
            `the jobs pill will stay on "${BRIDGE_TOO_OLD_MESSAGE}" until the embedded bridge is rewritten`,
        );
      }
      return { available: false, error: { message: BRIDGE_TOO_OLD_MESSAGE } };
    }
  }

  /**
   * Whether a rejection is the bridge's "I do not implement that method" reply.
   *
   * Unrelated text returns false, so a genuine read failure keeps its own message
   * instead of being reported as an outdated bridge.
   *
   * @param error - the rejection from `#request`.
   */
  #isUnknownBridgeMethodError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    return message.includes(UNKNOWN_BRIDGE_METHOD_PREFIX);
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
   * @param sessionId - which session; required — there is no default.
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
    const params = {
      sessionId,
      contentBlocks: contentBlocks ?? [{ type: "text", text }],
      ...(delivery === undefined ? {} : { delivery }),
    };
    let result: { messageId?: unknown; sourceKind?: unknown } | undefined;
    try {
      result = (await this.#request("session/prompt", params)) as typeof result;
    } catch (error) {
      // **Idempotent self-heal, once.** The bridge bounds its route tables, so a
      // session whose row was recycled answers `prompt` with "is not initialized"
      // even though this process still has it in `#initializedSessions` — which is
      // precisely why the cached readiness cannot fix itself: `initialize` is the
      // only frame that can, and nothing would ever re-send it. The user-visible
      // symptom was a session that opened fine and whose every prompt failed until
      // it was closed and reopened.
      //
      // One retry, only for that error: a second `initialize` + `prompt` is safe
      // because the first prompt was refused outright (the bridge throws before it
      // creates the agent or appends anything), and retrying any OTHER failure
      // would risk duplicating a turn that actually ran.
      if (!this.#isNotInitializedError(error)) throw error;
      this.#initializedSessions.delete(sessionId);
      this.#mcpSent.delete(sessionId);
      // The memoized task is what held the stale "already initialized" belief, so
      // it must go too or the retry would await the same fulfilled promise and
      // send nothing.
      this.#readyTasks.delete(sessionId);
      this.#processHandlers.onLog(
        `the bridge forgot session ${sessionId}'s initialize (its route table is bounded); re-initializing and retrying the prompt`,
      );
      await this.#ensureSessionReady(sessionId);
      result = (await this.#request("session/prompt", params)) as typeof result;
    }
    return {
      ...(typeof result?.messageId === "string" ? { messageId: result.messageId } : {}),
      ...(typeof result?.sourceKind === "string" ? { sourceKind: result.sourceKind } : {}),
    };
  }

  /**
   * Whether a rejection is the bridge's "this session never initialized" gate.
   *
   * Matched on a substring the bridge emits verbatim (`server.js` `prompt`), not
   * on any JSON-RPC shape: the transport hands the message through unchanged, and
   * a structured code would have to be added to both sides of a protocol that
   * only ever had messages. `null`/`undefined` rejections and unrelated text
   * return false, so a genuine failure is never retried.
   *
   * @param error - the rejection from `#request`.
   */
  #isNotInitializedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    return message.includes("is not initialized for session");
  }

  /**
   * Switch the session's permission preset through DSH's projection API.
   *
   * The preset owns both the sandbox mode and the approval policy. Going through
   * this non-command write keeps the timeline free of a `/permission` row the
   * user never typed; the command path remains only for DSH's own `/permission`
   * slash usage.
   *
   * @param sessionId - which session; required — there is no default.
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
   * @param sessionId - which session; required — there is no default.
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
   * @param sessionId - which session; required — there is no default.
   */
  async cancel(sessionId: string): Promise<void> {
    await this.#ensureSessionReady(sessionId);
    await this.#request("session/cancel", { sessionId });
  }

  /**
   * Select plan mode and return the committed state.
   *
   * @param sessionId - which session; required — there is no default.
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
   * @param sessionId - which session; required — there is no default.
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
   * @param sessionId - which session; required — there is no default.
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
   * @param sessionId - which session; required — there is no default.
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
   * @param sessionId - which session; required — there is no default.
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
    //
    // Called **unconditionally**, including when the listing is empty. Guarding it
    // with `subagents.length > 0` assumed "no edges recorded here means no edges
    // exist", but `#childParent` can already hold edges from
    // `session.child-opened` notices and from earlier listings — and this call is
    // one of only two replay trigger points. A root whose own listing is empty can
    // still have held frames for a descendant announced under it, and the guard
    // would leave them to expire.
    this.#replayOrphans();
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

  /**
   * Build the splitter for one child, with the unterminated-frame bound wired to
   * this process's log sink.
   *
   * The bound itself lives in `frame-reader.ts` (`DEFAULT_MAX_PENDING_BYTES`);
   * what belongs here is only where the report goes. It goes to `onLog`, the same
   * sink malformed lines use, because the two are the same user-visible event:
   * bytes arrived that cannot become a frame. Dropping them silently would leave
   * "the agent went quiet" with nothing to explain it.
   *
   * A factory rather than two inline `createFrameReader()` calls because the
   * reader is created twice (once for the field initializer, once per spawn) and
   * both have to be wired identically — a second call site without the callback
   * would be a silently unbounded reader.
   */
  #createFrames(): FrameReader {
    return createFrameReader({
      onOverflow: ({ dropped, limit }) => {
        this.#processHandlers.onLog(
          `discarded a ${String(dropped)}-character bridge frame: it had no newline before the `
            + `${String(limit)}-character bound (the line is malformed or the child stopped mid-frame); `
            + "skipping to the next newline",
        );
      },
    });
  }

  /**
   * Feed one stdout chunk through the incremental frame splitter and dispatch
   * every frame it completed.
   *
   * The splitting itself lives in {@link createFrameReader} / {@link splitFrames}
   * so it can be exercised offline (`harness/frame-reader-check.mjs`), and it is
   * incremental rather than `buffer.split("\n")` because that reader was
   * quadratic: a replayed conversation arrives as one ~39 MB frame in ~2400
   * chunks and the old version scanned all ~47 GB of the growing buffer, which is
   * where the multi-second rewind went. See the module comment in
   * `frame-reader.ts` for the measurements.
   *
   * Everything this method still owns is the part that must not change:
   *
   * - A **blank** line is skipped silently (not reported as a parse failure). The
   *   old code decided this with `line.trim() === ""`, and `trim()` is what makes
   *   `\r\n` work, so the test is kept verbatim rather than replaced by "length
   *   is zero" — a whitespace-only line is skipped the same as an empty one.
   * - An **unparsable** line is handed to `onLog` as-is and the loop continues,
   *   so one bad frame does not cost the frames queued behind it.
   * - `#dispatch` is async and nothing awaits it. A rejection must not escape as
   *   an unhandled one: this process is shared, so its default fate (terminate)
   *   would end every conversation it serves over one frame.
   */
  #consume(chunk: string): void {
    splitFrames(this.#frames, chunk, {
      onFrame: (frame) => {
        void this.#dispatch(frame).catch((error: unknown) => {
          this.#processHandlers.onLog(
            `dispatching a bridge frame failed: ${toError(error, "dispatch failed").message}`,
          );
        });
      },
      onMalformed: (line) => this.#processHandlers.onLog(line),
    });
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

    if (method === "paseo/permission-cancelled") {
      const pending = this.#approvalRequests.get(String(params.requestId));
      if (pending && pending.sessionId === producer) {
        (pending.controller.signal as DshApprovalSignal).approvalTimedOut = params.timedOut === true;
        pending.controller.abort();
      }
      return;
    }
    if (method === "paseo/permission" && id !== undefined) {
      const requestId = params.requestId;
      const handlers = producer === undefined ? undefined : this.#sessionHandlers.get(producer);
      // Root only: the host's child permission channel cannot display a card.
      if (!handlers?.onPermission || typeof requestId !== "string" || !requestId
        || typeof params.toolName !== "string" || !params.toolName
        || this.#approvalRequests.has(requestId)) {
        this.#send({ jsonrpc: "2.0", id, error: { code: -32000, message: "invalid or unowned tool approval request" } });
        return;
      }
      const controller = new AbortController();
      this.#approvalRequests.set(requestId, { sessionId: producer as string, controller });
      try {
        const answer = await handlers.onPermission(params as unknown as DshApprovalRequest, producer as string, controller.signal);
        if (controller.signal.aborted) throw new Error(
          (controller.signal as DshApprovalSignal).approvalTimedOut ? "Tool approval timed out" : "Tool approval cancelled",
        );
        this.#send({ jsonrpc: "2.0", id, result: answer });
      } catch (error) {
        this.#send({ jsonrpc: "2.0", id, error: { code: -32000, message: toError(error, "tool approval failed").message } });
      } finally {
        this.#approvalRequests.delete(requestId);
      }
      return;
    }

    if (method === "session.child-opened") {
      // Registered before anything else: the parent edge is what makes the
      // child's own frames routable.
      //
      // This writer **overwrites**, deliberately, and that is the opposite of what
      // `subagents()` does to the same map. The asymmetry is not an oversight; the
      // two record different things:
      //
      // - `subagents()` records DSH's durable topology: `child -> parent` from the
      //   stored headers, which does not change.
      // - This notice records a **live delivery route**: which conversation the
      //   child's frames must currently be shown in.
      //
      // They diverge for a native child observed under two Paseo agents. The bridge
      // announces the same native id under whichever root is prompting — it sends
      // `{ sessionId: "child-A", parentSessionId: <current root> }`
      // (`harness/fake-dsh-bridge.mjs:367`, one notice per root) — because one DSH
      // child session can be reached from more than one conversation. Keeping the
      // first edge would route the second root's frames into the first root's
      // timeline, and its own `child-opened` would never open a child view: a
      // measured regression, not a hypothetical one (`harness/subagent-check.cjs`
      // asserts distinct root-scoped ids for this exact case). Durable topology
      // losing to a live route is the correct precedence: the live notice is what
      // knows where output belongs *now*.
      //
      // A real re-target is still worth a line, because it is the one case where a
      // frame can move between conversations, and "why did this child's output
      // appear over there" should be answerable from the log.
      const parent = typeof params.parentSessionId === "string" ? params.parentSessionId : undefined;
      if (producer !== undefined && parent !== undefined && producer !== "") {
        const known = this.#childParent.get(producer);
        if (known !== undefined && known !== parent) {
          this.#processHandlers.onLog(
            `session.child-opened re-targets ${producer} from ${known} to ${parent}`
              + " (a native child reached from another conversation)",
          );
        }
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
      this.#deliverLive(producer, "event", () => handlers.onEvent(frame.params as DshSessionEvent));
      return;
    }
    if (method === "session.status") {
      const owner = producer === undefined ? undefined : this.#rootOf(producer);
      const handlers = owner === undefined ? undefined : this.#sessionHandlers.get(owner);
      if (handlers === undefined) {
        this.#holdOrphan(producer, method, { kind: "status", params: params as Record<string, unknown> });
        return;
      }
      this.#deliverLive(producer, "status", () =>
        handlers.onStatus(typeof params.status === "string" ? params.status : "unknown", producer ?? ""));
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
      this.#deliverLive(producer, "child-opened", () =>
        handlers.onChildOpened?.(params as unknown as DshChildOpened));
      // This edge may have made a grandchild's held frames routable: a deeper
      // descendant can be announced before the child that parents it, and its
      // frames wait in `#orphanFrames` until the chain reaches an attached
      // session. Replayed after the notice, so the child view exists first.
      this.#replayOrphans();
      return;
    }
    if (method === "assistant.stream") {
      // The upstream live-stream channel. This fork's bridge sends
      // `paseo/assistant-delta` on `session.event` instead (see
      // `DshProcessHandlers.onAssistantStream`), so a frame arriving here means
      // the bridge and the plugin disagree about which channel is live. Say so
      // once per process rather than dropping it: silently discarding the whole
      // answer stream is exactly the failure mode this repo keeps re-finding.
      const params = frame.params as { frame?: DshAssistantFrame } | undefined;
      if (this.#options.onAssistantStream !== undefined) {
        if (params?.frame !== undefined) this.#options.onAssistantStream(params.frame);
        return;
      }
      if (!this.#warnedAssistantStream) {
        this.#warnedAssistantStream = true;
        this.#options.onLog(
          "bridge sent `assistant.stream` but this plugin reads live text from " +
            "`paseo/assistant-delta`; the live stream from this bridge will not render " +
            "(mismatched bridge/plugin builds)",
        );
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
        // Re-check the lineage before giving up. Both things that create a parent
        // edge arrive asynchronously relative to `session.open` — a
        // `session.child-opened` notice, and `subagents()` which runs *after* the
        // open — so a bucket can become routable a few milliseconds after its TTL
        // fired. Dropping it there would lose exactly the output this buffer
        // exists to keep, while a replay costs one `#rootOf` walk.
        this.#replayOrphans();
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
      // Discard the bucket WHOLE rather than evicting its oldest frames. An
      // oldest-first eviction tears one turn's frames apart — a `turn/end`
      // survives while its `turn/start` is gone, or the reverse — which leaves
      // the session in a state nothing will ever close, and that is worse than
      // having no frames at all. A bucket this deep has a lineage that will not
      // resolve in practice, so it is reported loudly and dropped.
      this.#orphanFrames.delete(producer);
      const timer = this.#orphanTimers.get(producer);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.#orphanTimers.delete(producer);
      }
      this.#processHandlers.onLog(
        `orphan buffer overflow for ${producer}: discarding all ${bucket.frames.length} held frame(s) `
          + `at the ${ORPHAN_FRAME_LIMIT}-frame bound instead of losing only the oldest`,
      );
      return;
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

  /**
   * Deliver one live frame to a session's handler without letting it take the
   * process down.
   *
   * The replay path has always wrapped its handler calls, but the live path did
   * not — and the live path is the dangerous one. `#consume` calls `#dispatch`
   * with `void`, `#dispatch` is `async`, and a synchronous throw from a handler
   * becomes an **unhandled rejection**, whose Node default is to terminate the
   * process. One conversation's bad frame would then kill every other
   * conversation sharing this child, which is exactly the failure mode the
   * one-process-many-sessions design must not have.
   *
   * The exception is not swallowed: it is logged with the producing session, so a
   * session whose handler keeps failing is diagnosable instead of looking like a
   * bridge that stopped sending.
   *
   * @param producer - the producing session, for the log line.
   * @param kind - which delivery path threw, for the log line.
   * @param deliver - the call to make; its throw is contained.
   */
  #deliverLive(producer: string | undefined, kind: string, deliver: () => unknown): void {
    try {
      const result = deliver();
      // The declared handler shapes are synchronous, but a handler is free to be
      // an `async` function assigned to a `void`-returning slot — and a rejection
      // from that promise is unhandled too. Contain it on the same path.
      if (typeof (result as { then?: unknown } | undefined)?.then === "function") {
        void (result as Promise<unknown>).catch((error: unknown) => {
          this.#processHandlers.onLog(
            `delivering a live ${kind} for ${producer ?? "(none)"} rejected: `
              + `${toError(error, "handler rejected").message}`,
          );
        });
      }
    } catch (error) {
      this.#processHandlers.onLog(
        `delivering a live ${kind} for ${producer ?? "(none)"} failed: `
          + `${toError(error, "handler failed").message}`,
      );
    }
  }

  #failAll(error: Error): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) entry.reject(error);
  }
}
