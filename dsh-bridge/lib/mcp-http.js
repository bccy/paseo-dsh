/**
 * Minimal MCP client for the streamable-HTTP transport.
 *
 * The gateway replaces Paseo's per-session injection of `@deepseek-ai/dsh-mcp-client`
 * (61 tool schemas, ~32 KB of every request) with three meta-tools that reach the
 * same server on demand. That client is a full plugin with its own retry, cache and
 * image-admission machinery; the gateway only needs the wire protocol, so this module
 * keeps the dependency surface at zero: `fetch` is in Node 22, and SSE framing is a
 * few lines. Being dependency-free is what lets the bridge embed it — the plugin
 * materializes this package into the profile from base64 and runs no install step.
 *
 * Protocol facts this implements (verified against Paseo's own server):
 *   - one JSON-RPC message per POST; the server answers with `text/event-stream`
 *     frames or plain JSON, so both are parsed;
 *   - `Mcp-Session-Id` is echoed back only by stateful servers — tracked when present,
 *     and dropped when the server says it no longer knows the session (HTTP 404),
 *     so a restarted server costs one handshake instead of wedging the client;
 *   - `initialize` + `notifications/initialized` must precede `tools/*`;
 *   - `accept` must list both media types or the server rejects the request.
 *
 * Pure module on purpose: `harness/mcp-gateway-check.mjs` drives it against a local
 * HTTP server without a DSH profile.
 */

/** Default per-request budget for one JSON-RPC round trip. */
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;

/** Protocol revision this client speaks; the server may answer with its own. */
const PROTOCOL_VERSION = '2025-06-18';

/**
 * Parse one `text/event-stream` body into its JSON frames.
 *
 * MCP servers answer a POST with the frame that resolves that request, and may
 * prepend notifications; everything that is not a JSON `data:` payload is either
 * a comment or an event name this client does not consume.
 */
export function parseSseFrames(text) {
  const frames = [];
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '') continue;
    try {
      frames.push(JSON.parse(payload));
    } catch {
      // A non-JSON data frame is a server bug, not something to guess around.
      throw new Error(`mcp: unparseable SSE data frame: ${payload.slice(0, 120)}`);
    }
  }
  return frames;
}

/** Whether a content type indicates SSE framing. */
export function isEventStream(contentType) {
  return /text\/event-stream/i.test(String(contentType ?? ''));
}

/**
 * Resolve the JSON-RPC message that answers `id` out of a response body.
 *
 * A plain JSON body may be the message or an array of messages (batch-shaped
 * servers); an SSE body carries one frame per message.
 */
export function pickResult(body, id) {
  const frames = Array.isArray(body) ? body : [body];
  const match = frames.find((frame) => frame !== null && typeof frame === 'object' && frame.id === id);
  if (match === undefined) throw new Error(`mcp: no JSON-RPC response for request ${id}`);
  if (match.error !== undefined && match.error !== null) {
    const message = typeof match.error.message === 'string' ? match.error.message : JSON.stringify(match.error);
    const code = typeof match.error.code === 'number' ? ` (${match.error.code})` : '';
    throw new Error(`mcp: ${message}${code}`);
  }
  return match.result;
}

/**
 * One JSON-RPC round trip over streamable HTTP.
 *
 * @param options.url - MCP endpoint.
 * @param options.headers - Auth headers from the injected session config.
 * @param options.method - JSON-RPC method.
 * @param options.params - Method params, omitted when undefined.
 * @param options.id - Request id; omit for a notification.
 * @param options.sessionId - `Mcp-Session-Id` to echo when the server issued one.
 * @param options.timeoutMs - Budget for the whole round trip.
 * @param options.fetchImpl - Injection point for the offline check.
 * @returns The JSON-RPC `result`, the session id the server issued, and the raw response.
 */
export async function mcpRequest({
  url,
  headers = {},
  method,
  params,
  id,
  sessionId,
  timeoutMs = DEFAULT_MCP_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`mcp: ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
  const message = id === undefined
    ? { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }
    : { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
        ...headers,
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    const issuedSession = response.headers?.get?.('mcp-session-id') ?? undefined;
    const contentType = response.headers?.get?.('content-type') ?? '';
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`mcp: ${method} failed with HTTP ${response.status}${text === '' ? '' : `: ${text.slice(0, 200)}`}`);
      // The status and body are kept on the error so a caller can tell "the server
      // no longer knows my session" from every other transport failure without
      // parsing the human-readable message back apart.
      error.httpStatus = response.status;
      error.httpBody = text.slice(0, 512);
      throw error;
    }
    // Notifications are acknowledged without a JSON-RPC message.
    if (id === undefined || text.trim() === '') return { result: undefined, sessionId: issuedSession, contentType, text };
    const body = isEventStream(contentType) ? parseSseFrames(text) : JSON.parse(text);
    return { result: pickResult(body, id), sessionId: issuedSession, contentType, text };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`mcp: ${method} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a failure means "the server no longer honours my session".
 *
 * A stateful MCP server answers a request that carries a dead `Mcp-Session-Id`
 * with HTTP 404 (streamable-HTTP spec), and that is the only signal it gives:
 * the JSON-RPC body never arrives, so the client has to read the transport.
 * The status is the primary discriminator, but a 404 also covers "no such
 * resource", so the body is inspected too — a 404 that names a session problem
 * (`session not found`, `session expired`, …) is a session loss, and a 404 that
 * talks about anything else is not. A 404 with no body is read as the spec shape
 * (a bare rejection of the session-bearing request) because there is no other
 * reading available; the caller still requires that a session id was actually
 * sent, so a stateless server can never take this path.
 *
 * @param error - A rejection from `mcpRequest`.
 * @returns Whether the session should be dropped and re-established.
 */
export function isSessionGoneError(error) {
  if (!(error instanceof Error) || error.httpStatus !== 404) return false;
  const body = typeof error.httpBody === 'string' ? error.httpBody : '';
  if (body.trim() === '') return true;
  return /session/i.test(body)
    && /(not\s+found|expired|terminated|unknown|invalid|no\s+longer|closed|missing)/i.test(body);
}

/**
 * Whether a probe of Paseo's browser tools reported that no desktop browser host
 * is attached.
 *
 * Paseo answers the probe as an ordinary tool result, not a JSON-RPC error, and
 * marks it in two places: `structuredContent.error.code === "browser_no_host"`
 * and the one-line text "No browser automation host is connected.". Both are
 * accepted (the code is authoritative; the text survives older hosts), and a
 * probe that failed for any other reason — timeout, transport — returns
 * undefined so a transient failure never hides a capability.
 *
 * @param outcome - The probe's tool result, or the error it rejected with.
 * @returns The host-gap message when the probe says no host is attached.
 */
export function browserHostGapOf(outcome) {
  if (outcome === undefined || outcome === null) return undefined;
  if (outcome instanceof Error) {
    return /browser automation host/i.test(outcome.message) ? outcome.message : undefined;
  }
  const result = outcome;
  const structured = result?.structuredContent;
  if (structured?.error?.code === 'browser_no_host') {
    return typeof structured.error.message === 'string' ? structured.error.message : 'no browser automation host';
  }
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && /browser automation host/i.test(block.text)) return block.text;
  }
  return undefined;
}

/**
 * Browser tools whose execution needs a connected desktop browser host.
 *
 * Paseo registers its browser tools in the MCP catalog unconditionally — the
 * broker that knows whether a host is attached is not consulted when the catalog
 * is built — so a listing can offer tools that cannot run right now. The gateway
 * probes once and labels them instead of hiding them: the capability is real,
 * only its reachability is missing, and the next listing re-probes.
 */
export function unavailableBrowserTools(tools, hostGap) {
  if (hostGap === undefined) return [];
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => (tool !== null && typeof tool === 'object' ? tool.name : undefined))
    .filter((name) => typeof name === 'string' && name.startsWith('browser_'));
}

/**
 * One MCP server connection: initialize once, then list and call tools.
 *
 * `tools/list` is fetched once and reused by default (`cacheTools: true`): the
 * catalog is what the gateway exists to keep out of the context — Paseo's server
 * is 61 tools / ~33 KB — so paying a round trip for it on every `mcp_list_tools`
 * would undo the saving this client was written for. A long-lived connection can
 * still ask for a fresh read with `listTools({ refresh: true })`, and a caller
 * that knows its server rewrites the catalog on every request can opt out with
 * `cacheTools: false`.
 */
export class McpHttpClient {
  #id = 0;
  #sessionId;
  #initialized;
  #tools;
  /**
   * Bumped every time the session is disowned.
   *
   * A request that was already in flight when the session died still carries the
   * old id, and its answer — a 404, or worse a success that echoes the id — must
   * not be written back over the state of the session that replaced it.
   */
  #epoch = 0;

  constructor({ url, headers = {}, timeoutMs = DEFAULT_MCP_TIMEOUT_MS, fetchImpl = fetch, clientInfo = { name: 'paseo-mcp-gateway', version: '0.1.0' }, cacheTools = true }) {
    if (typeof url !== 'string' || url === '') throw new Error('mcp: server url is required');
    this.url = url;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.clientInfo = clientInfo;
    this.cacheTools = cacheTools;
  }

  #nextId() {
    this.#id += 1;
    return this.#id;
  }

  /**
   * Drop connection state the server has disowned.
   *
   * A stateful server forgets its sessions when it restarts. It then answers
   * every request carrying the old id with 404, and because this client sent
   * `initialize` exactly once, that 404 repeats forever — nothing on the request
   * path would ever handshake again. Clearing the id and the handshake latch
   * makes the next call open a fresh session instead, which is the same recovery
   * a human performs by reloading.
   *
   * The cached catalog goes with it, and that is what keeps a known-dead
   * connection from answering at all: the cache describes a session that no
   * longer exists, so there is no such thing as a valid cache hit until the
   * handshake succeeds again. The next `listTools()` therefore either re-reads
   * from the new session or fails loudly — it can never hand back the catalog of
   * a connection the server has already disowned.
   */
  #forgetSession() {
    this.#sessionId = undefined;
    this.#initialized = undefined;
    this.#tools = undefined;
    this.#epoch += 1;
  }

  /**
   * One JSON-RPC round trip that keeps the session bookkeeping honest.
   *
   * Session loss is only detectable on the response — the server answers 404 and
   * never gets as far as a JSON-RPC frame — so every request this class sends
   * goes through here rather than through `mcpRequest` directly. The guard reads
   * the id that was actually *sent*: a request without one cannot have lost a
   * session, so a 404 on a stateless server (Paseo's own never issues an id) is
   * left to propagate untouched.
   */
  async #request(method, { params, sessionId = this.#sessionId } = {}) {
    const epoch = this.#epoch;
    try {
      const response = await mcpRequest({
        url: this.url,
        headers: this.headers,
        method,
        params,
        id: this.#nextId(),
        sessionId,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      if (response.sessionId !== undefined && this.#epoch === epoch) this.#sessionId = response.sessionId;
      return response;
    } catch (error) {
      if (sessionId !== undefined && this.#epoch === epoch && isSessionGoneError(error)) this.#forgetSession();
      throw error;
    }
  }

  async #call(method, params) {
    const response = await this.#request(method, { params });
    return response.result;
  }

  /** Handshake once; a failed handshake is retried on the next call. */
  async ensureInitialized() {
    this.#initialized ??= (async () => {
      await this.#request('initialize', {
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo },
      });
      // The id this handshake just opened — `#request` adopted it above.
      await this.#request('notifications/initialized', { sessionId: this.#sessionId });
    })().catch((error) => {
      this.#initialized = undefined;
      throw error;
    });
    return this.#initialized;
  }

  /**
   * Every tool the server currently exposes.
   *
   * Cached across calls by default: the catalog is the payload the gateway was
   * built to stop re-sending, and re-reading it on every listing turns three
   * meta-tools into a per-call round trip for a catalog that changes only when
   * the server is restarted. Pass `{ refresh: true }` to re-read on demand, or
   * construct the client with `cacheTools: false` for a server whose catalog is
   * expected to change between calls.
   */
  async listTools({ refresh = false } = {}) {
    await this.ensureInitialized();
    if (this.#tools === undefined || refresh || this.cacheTools !== true) {
      const epoch = this.#epoch;
      const result = await this.#call('tools/list', {});
      // The session can be disowned while this read is in flight (a parallel
      // call is the one that sees the 404). A catalog read from the connection
      // the server has just forgotten must not become the next cache hit, so the
      // read is repeated against the session that replaced it.
      if (this.#epoch !== epoch) return this.listTools({ refresh });
      this.#tools = Array.isArray(result?.tools) ? result.tools : [];
    }
    return this.#tools;
  }

  /** Invoke one tool by its server-side name. */
  async callTool(name, args = {}) {
    await this.ensureInitialized();
    return this.#call('tools/call', { name, arguments: args ?? {} });
  }
}
