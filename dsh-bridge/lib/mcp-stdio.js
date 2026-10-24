/**
 * Minimal MCP client for the stdio transport.
 *
 * `mcp-http.js` covers the gateway's HTTP servers; this is its mirror for servers
 * that speak JSON-RPC over a child process's stdin/stdout. The one that matters
 * here is Paseo's Server Browser bridge: it is stdio-only, declares 25 tool
 * schemas (~20 KB of every request) that a session rarely calls, and so belongs
 * behind the gateway's three meta-tools instead of being mounted as
 * `@deepseek-ai/dsh-mcp-client` on every turn.
 *
 * Written by hand for the same reason as the HTTP client: the bridge is
 * materialized from base64 into a profile that runs no install step, so
 * `@modelcontextprotocol/client` cannot be a dependency. What the gateway needs
 * is the wire protocol, and that is a spawn plus a pending-id map — a few hundred
 * lines instead of a package the profile could not resolve anyway.
 *
 * Protocol facts this implements (MCP stdio transport):
 *   - one JSON-RPC message per line on stdin/stdout; stderr is diagnostics, not
 *     protocol, and is forwarded to our own stderr unfiltered;
 *   - `initialize` + `notifications/initialized` must precede `tools/*`;
 *   - servers also print their own warnings to stdout (Playwright's bridge does),
 *     so a line that is not JSON is dropped instead of failing the connection;
 *   - answers can arrive in any order and long after the request, so every
 *     request owns a pending entry with its own timeout.
 *
 * Pure module on purpose: `harness/mcp-stdio-check.mjs` drives it against a
 * scripted fake server without a DSH profile.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Default per-request budget for one JSON-RPC round trip.
 *
 * Deliberately the same number as `mcp-http.js` (which exports its own): the two
 * transports serve the same gateway config, and the bridge embeds modules
 * independently, so each keeps its own copy rather than importing the other.
 */
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;

/** Protocol revision this client speaks; the server may answer with its own. */
const PROTOCOL_VERSION = '2025-06-18';

/**
 * How long the server gets to exit after its stdin is closed.
 *
 * Every MCP stdio server is expected to exit on EOF; this is the grace period
 * before escalating, not the normal path.
 */
const DISPOSE_GRACE_MS = 2_000;

/** How long each signal gets before escalating (SIGTERM -> SIGKILL). */
const KILL_GRACE_MS = 1_000;

/** Resolve true when `promise` settles within `ms`; never rejects. */
function settledWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(true); },
    );
  });
}

/**
 * One MCP server process: initialize once, then list and call tools.
 *
 * The process is spawned on first use rather than in the constructor, so a
 * configured-but-unused server costs nothing and a client that is never called
 * leaves no child behind. A server that failed to start, exited, or was disposed
 * stays failed: respawning on every tool call would turn one broken binary into
 * a restart loop, and the gateway already reports the error to the model.
 *
 * `tools/list` is fetched once and reused by default, for the same reason as the
 * HTTP client: what a server exposes is the payload the gateway exists to keep
 * out of the context, and the Server Browser bridge's 25 schemas are not worth a
 * round trip per listing. `listTools({ refresh: true })` re-reads on demand, and
 * `cacheTools: false` opts a server that rewrites its catalog out of the cache.
 */
export class McpStdioClient {
  #child;
  #lines;
  #label;
  #pending = new Map();
  #nextId = 0;
  #initialized;
  #tools;
  #failure;
  #exit;
  #resolveExit;
  #disposed = false;

  constructor({
    command,
    args = [],
    env = {},
    cwd,
    timeoutMs = DEFAULT_MCP_TIMEOUT_MS,
    clientInfo = { name: 'paseo-mcp-gateway', version: '0.1.0' },
    cacheTools = true,
  }) {
    if (typeof command !== 'string' || command === '') throw new Error('mcp: stdio server command is required');
    this.command = command;
    this.args = Array.isArray(args) ? args.map(String) : [];
    this.env = env ?? {};
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.clientInfo = clientInfo;
    // Same option and same default as `mcp-http.js`: the two transports serve one
    // gateway config, so a server must not behave differently depending on which
    // one it happens to speak.
    this.cacheTools = cacheTools;
    // Errors have to name the server: the gateway talks to several, and a bare
    // "tools/call failed" would not say which one broke.
    this.#label = [this.command, ...this.args].join(' ').slice(0, 120);
  }

  /** Process id of the server once spawned; undefined before that. */
  get pid() {
    return this.#child?.pid;
  }

  /**
   * Launch the server on first use.
   *
   * The inherited environment is kept underneath the configured one: MCP's stdio
   * config is additive by convention, and dropping PATH would make `node` itself
   * unresolvable.
   */
  #start() {
    if (this.#failure !== undefined) throw new Error(`mcp: ${this.#label}: ${this.#failure}`);
    if (this.#child !== undefined) return this.#child;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    this.#exit = new Promise((resolve) => { this.#resolveExit = resolve; });
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#lines.on('line', (line) => this.#onLine(line));
    // Server diagnostics belong to whoever is reading the bridge's log, verbatim.
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); });
    child.stdin.on('error', (error) => { this.#fail(`stdin write failed: ${error.message}`); });
    child.on('error', (error) => {
      // A missing binary never emits `exit`, so both the pending drain and the
      // dispose wait hang on this event unless it is handled here.
      this.#fail(`failed to start: ${error.message}`);
      this.#resolveExit?.();
    });
    child.on('exit', (code, signal) => {
      this.#lines?.close();
      child.stdout?.destroy();
      this.#fail(signal === null ? `stdio server exited with code ${code}` : `stdio server killed by ${signal}`);
      this.#resolveExit?.();
    });
    return child;
  }

  /**
   * Refuse to answer from state that a dead connection makes untrustworthy.
   *
   * `#start()` is the only place that inspects `#failure`, and it runs on the
   * request path — which a cache hit never takes. So without this gate a server
   * that exited, or a client that was disposed, still hands back the catalog it
   * read while alive, and "the connection is gone" is reported as "the catalog
   * did not change". The gateway would list tools that cannot be called, and the
   * model would learn the server died only when the call it planned fails — the
   * silent degradation this repository bans. Caching is untouched: the catalog
   * is still reused, but only while the premise that produced it holds.
   */
  #assertUsable() {
    if (this.#failure !== undefined) throw new Error(`mcp: ${this.#label}: ${this.#failure}`);
  }

  /**
   * Reject everything in flight and make later calls fail with `reason`.
   *
   * Rejection is per request so the message still names the method that was
   * waiting; a caller must never be left hanging on a process we know is gone.
   */
  #fail(reason) {
    this.#failure ??= reason;
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`mcp: ${this.#label}: ${entry.method} failed: ${reason}`));
    }
  }

  /** Consume one stdout line: a JSON-RPC response, or server noise to ignore. */
  #onLine(line) {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      // Servers legitimately log to stdout (Playwright's bridge prints startup
      // warnings there). Dropping the line is the difference between "works" and
      // "the handshake never completes", and there is nothing to repair.
      return;
    }
    if (frame === null || typeof frame !== 'object') return;
    // Server-initiated notifications and requests have no consumer on this side;
    // only an answer to something we sent resolves a promise.
    if (frame.id === undefined || frame.id === null) return;
    const entry = this.#pending.get(frame.id);
    // A late answer to a request that already timed out: the caller is gone.
    if (entry === undefined) return;
    this.#pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error !== undefined && frame.error !== null) {
      const message = typeof frame.error.message === 'string' ? frame.error.message : JSON.stringify(frame.error);
      const code = typeof frame.error.code === 'number' ? ` (${frame.error.code})` : '';
      entry.reject(new Error(`mcp: ${this.#label}: ${entry.method} failed: ${message}${code}`));
      return;
    }
    entry.resolve(frame.result);
  }

  /** One JSON-RPC request; `params` is omitted when undefined, like the HTTP client. */
  #request(method, params) {
    if (this.#disposed) return Promise.reject(new Error(`mcp: ${this.#label}: client disposed`));
    const id = (this.#nextId += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`mcp: ${this.#label}: ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        const frame = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
        this.#start().stdin.write(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** One JSON-RPC notification (no id, no reply). */
  #notify(method, params) {
    const frame = params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
    this.#start().stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** Handshake once; a failed handshake is retried on the next call. */
  async ensureInitialized() {
    this.#initialized ??= (async () => {
      await this.#request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo });
      this.#notify('notifications/initialized');
    })().catch((error) => {
      this.#initialized = undefined;
      throw error;
    });
    return this.#initialized;
  }

  /** Every tool the server currently exposes; cached unless `cacheTools: false`. */
  async listTools({ refresh = false } = {}) {
    await this.ensureInitialized();
    if (this.#tools === undefined || refresh || this.cacheTools !== true) {
      const result = await this.#request('tools/list', {});
      this.#tools = Array.isArray(result?.tools) ? result.tools : [];
    } else {
      // A cache hit sends nothing, so nothing else on this path would ever
      // notice that the server has since exited (or that the client was
      // disposed) — the catalog would be served from a connection that is gone.
      this.#assertUsable();
    }
    return this.#tools;
  }

  /** Invoke one tool by its server-side name. */
  async callTool(name, args = {}) {
    await this.ensureInitialized();
    return this.#request('tools/call', { name, arguments: args ?? {} });
  }

  /**
   * Stop the server: close its stdin first (an MCP stdio server exits on EOF),
   * then escalate to SIGTERM and finally SIGKILL if it lingers.
   *
   * Requests still in flight are rejected up front — their callers must not wait
   * on a process that is being torn down. Idempotent.
   */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#fail('client disposed');
    const child = this.#child;
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin?.end();
    } catch {
      /* stdin already gone; the escalation below is what matters */
    }
    if (await settledWithin(this.#exit, DISPOSE_GRACE_MS)) return;
    child.kill('SIGTERM');
    if (await settledWithin(this.#exit, KILL_GRACE_MS)) return;
    child.kill('SIGKILL');
    await settledWithin(this.#exit, KILL_GRACE_MS);
  }
}
