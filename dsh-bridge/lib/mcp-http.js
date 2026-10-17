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
 *   - `Mcp-Session-Id` is echoed back only by stateful servers — tracked when present;
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
      throw new Error(`mcp: ${method} failed with HTTP ${response.status}${text === '' ? '' : `: ${text.slice(0, 200)}`}`);
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
 * One MCP server connection: initialize once, then list and call tools.
 *
 * `tools/list` is fetched per call unless `cacheTools` is set, because a browser
 * tab or agent registry can change what a server exposes between calls and a
 * stale catalog would make the gateway report tools that no longer exist.
 */
export class McpHttpClient {
  #id = 0;
  #sessionId;
  #initialized;
  #tools;

  constructor({ url, headers = {}, timeoutMs = DEFAULT_MCP_TIMEOUT_MS, fetchImpl = fetch, clientInfo = { name: 'paseo-mcp-gateway', version: '0.1.0' } }) {
    if (typeof url !== 'string' || url === '') throw new Error('mcp: server url is required');
    this.url = url;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.clientInfo = clientInfo;
  }

  #nextId() {
    this.#id += 1;
    return this.#id;
  }

  async #call(method, params) {
    const response = await mcpRequest({
      url: this.url,
      headers: this.headers,
      method,
      params,
      id: this.#nextId(),
      sessionId: this.#sessionId,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    if (response.sessionId !== undefined) this.#sessionId = response.sessionId;
    return response.result;
  }

  /** Handshake once; a failed handshake is retried on the next call. */
  async ensureInitialized() {
    this.#initialized ??= (async () => {
      const response = await mcpRequest({
        url: this.url,
        headers: this.headers,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo },
        id: this.#nextId(),
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      if (response.sessionId !== undefined) this.#sessionId = response.sessionId;
      await mcpRequest({
        url: this.url,
        headers: this.headers,
        method: 'notifications/initialized',
        sessionId: this.#sessionId,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
    })().catch((error) => {
      this.#initialized = undefined;
      throw error;
    });
    return this.#initialized;
  }

  /** Every tool the server currently exposes. */
  async listTools({ refresh = false } = {}) {
    await this.ensureInitialized();
    if (refresh || this.#tools === undefined) {
      const result = await this.#call('tools/list', {});
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
