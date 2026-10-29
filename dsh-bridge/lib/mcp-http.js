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
 * Ceiling on `tools/list` pages walked in one read.
 *
 * A paginated server is supposed to end with a page that carries no `nextCursor`,
 * but a buggy one can hand back a cursor that names itself forever. Without a
 * bound that is an infinite loop inside a model turn, which is strictly worse than
 * a named failure; with one, the catalog is refused rather than half-cached.
 */
const MAX_TOOL_PAGES = 100;

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
 *
 * **A frame with a `method` is a request from the server, never an answer.**
 * JSON-RPC 2.0 §5 lets the server send requests of its own (`ping`, `roots/list`,
 * `sampling/createMessage`, `elicitation/create`) at any point in the stream, and
 * MCP servers do. Matching on `id` alone looked right because responses and
 * requests both carry one — but both sides number from 1, so a server request's
 * id collides with an in-flight request of ours as the *ordinary* case. The
 * collision resolved the call with `undefined`: an empty catalog cached for the
 * session, or a tool call reporting success with no content while the real answer
 * arrived one frame later and was dropped.
 *
 * This transport has no server-to-client write channel (one POST per message, the
 * response body is the only thing the server can read), so such a request cannot
 * be answered here. Ignoring it in silence is the one option that is wrong: a
 * server handler awaiting the reply hangs to its own timeout with nothing
 * anywhere saying why. It is therefore reported on stderr and the answer is still
 * the answer.
 *
 * @param body - The parsed response body.
 * @param id - The request id being awaited.
 * @returns The JSON-RPC `result` of the frame answering `id`.
 */
export function pickResult(body, id) {
  const frames = Array.isArray(body) ? body : [body];
  for (const frame of frames) {
    if (frame === null || typeof frame !== 'object') continue;
    if (frame.method === undefined) continue;
    // A server-initiated request or notification. Neither is our answer; a request
    // additionally expects a reply this transport cannot carry.
    if (frame.id === undefined || frame.id === null) continue;
    process.stderr.write(
      `mcp: server sent a "${frame.method}" request (id ${JSON.stringify(frame.id)}) over streamable HTTP; `
      + 'this transport has no server-to-client channel, so it cannot be answered\n',
    );
  }
  const match = frames.find((frame) => frame !== null && typeof frame === 'object' && frame.method === undefined && frame.id === id);
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
    // Notifications are acknowledged without a JSON-RPC message. A *request* is
    // not: `202` with no body acknowledges a notification, and a server that
    // answers a request that way has violated the protocol. Reading the empty body
    // as success turned "the server said nothing" into "the server has no tools" —
    // and because the catalog is cached, the emptiness outlived the glitch.
    if (id === undefined) return { result: undefined, sessionId: issuedSession, contentType, text };
    if (text.trim() === '') {
      const error = new Error(
        `mcp: ${method} answered with an empty body (HTTP ${response.status}); `
        + 'a JSON-RPC request must be answered with a message — only a notification may be acknowledged this way',
      );
      error.httpStatus = response.status;
      error.httpBody = '';
      throw error;
    }
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
 * Whether a probe of the browser tools reported that no desktop browser host is
 * attached.
 *
 * The two servers answer this differently, and only one of them was recognised:
 *
 *   - Paseo's own HTTP server returns an ordinary tool result carrying
 *     `structuredContent.error.code === "browser_no_host"` and the English
 *     sentence "No browser automation host is connected.";
 *   - the Server Browser bridge (stdio) returns `{ isError: true, content: [{
 *     type: 'text', text: <localized sentence> }] }` — `grep -c "browser automation
 *     host"` in its source is 0, and its message is Chinese when the host is not
 *     running.
 *
 * Matching only the English text left `unavailable` permanently empty against the
 * stdio bridge: all 25 browser tools were presented as usable, which is the "dead
 * probe that looks alive" the gateway's own comment set out to avoid. `isError` is
 * the protocol-level signal and does not depend on any wording, so it is checked
 * first and its first text block becomes the reason.
 *
 * A probe that failed for a *transport* reason (timeout, process exit) returns
 * undefined: a transient failure must not be reported as "no browser host".
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
  // Protocol-level first: an `isError` result is a refusal whatever language it is
  // written in, and the first text block is the server's own explanation of why.
  if (result?.isError === true) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') return block.text;
    }
    return 'the browser probe reported an error with no message';
  }
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
   * One JSON-RPC *request* round trip that keeps the session bookkeeping honest.
   *
   * Session loss is only detectable on the response — the server answers 404 and
   * never gets as far as a JSON-RPC frame — so every request this class sends
   * goes through here rather than through `mcpRequest` directly. The guard reads
   * the session id that was actually *sent*: a request without one cannot have
   * lost a session, so a 404 on a stateless server (Paseo's own never issues an
   * id) is left to propagate untouched.
   *
   * Requests only, never notifications. The `id` below is unconditional because a
   * JSON-RPC request always carries one — and that is exactly why a notification
   * must not come through here: with an `id` it stops being a notification and
   * becomes a request for a method the server does not have. Paseo's server
   * answers `-32601 Method not found` to `notifications/initialized` that carries
   * an id, which fails the handshake and takes all 61 of its tools with it.
   * Notifications therefore call `mcpRequest` directly (see `ensureInitialized`),
   * which also keeps them out of the 404 recovery below: only a message carrying
   * a session id can be disowned, and a fire-and-forget notification is not a
   * place to re-handshake from.
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
      // A JSON-RPC *notification*, so it goes to `mcpRequest` directly instead of
      // through `#request` — that helper always attaches an id, and an
      // `id`-bearing notification is not a notification any more: Paseo's server
      // answers `-32601 Method not found` and the handshake fails, which is what
      // makes every gateway tool unreachable. No id, no `#request`, no session
      // recovery: this message carries the id the handshake just opened (adopted
      // by `#request` above), and a fire-and-forget acknowledgement is not where
      // a lost session gets noticed or re-established.
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

  /**
   * Every tool the server currently exposes.
   *
   * Cached across calls by default: the catalog is the payload the gateway was
   * built to stop re-sending, and re-reading it on every listing turns three
   * meta-tools into a per-call round trip for a catalog that changes only when
   * the server is restarted. Pass `{ refresh: true }` to re-read on demand, or
   * construct the client with `cacheTools: false` for a server whose catalog is
   * expected to change between calls.
   *
   * `tools/list` is the one MCP method with standard cursor pagination, so the
   * whole catalog means every page. Reading page one alone reported it as the
   * catalog, and the symptom was not "there is more" but "the page-two tool does
   * not exist" — `mcp_tool_schema` answered `exposes no tool`, naming the missing
   * tool instead of the fetch that never happened. The loop stops on a non-string
   * or empty `nextCursor` (nothing more to ask for), and is bounded in case a
   * server hands back a cursor that keeps naming itself.
   */
  async listTools({ refresh = false } = {}) {
    await this.ensureInitialized();
    if (this.#tools === undefined || refresh || this.cacheTools !== true) {
      const epoch = this.#epoch;
      const tools = [];
      let cursor;
      for (let page = 0; ; page += 1) {
        if (page >= MAX_TOOL_PAGES) {
          throw new Error(`mcp: tools/list still paginating after ${MAX_TOOL_PAGES} pages; refusing to cache a partial catalog`);
        }
        const result = await this.#call('tools/list', cursor === undefined ? {} : { cursor });
        // "We could not read the catalog" is not "the server has no tools". The
        // two used to be the same value (`[]`), and the emptiness was cached, so a
        // server that recovered was still reported as empty for the rest of the
        // session with no way for the model to tell.
        if (result === null || typeof result !== 'object' || !Array.isArray(result.tools)) {
          throw new Error('mcp: tools/list returned no tool array; the catalog is unknown, not empty');
        }
        tools.push(...result.tools);
        const next = result.nextCursor;
        if (typeof next !== 'string' || next === '') break;
        cursor = next;
      }
      // The session can be disowned while this read is in flight (a parallel
      // call is the one that sees the 404). A catalog read from the connection
      // the server has just forgotten must not become the next cache hit, so the
      // read is repeated against the session that replaced it. The check sits
      // after the whole loop: checking per page would cache the pages read before
      // the loss.
      if (this.#epoch !== epoch) return this.listTools({ refresh });
      this.#tools = tools;
    }
    return this.#tools;
  }

  /** Invoke one tool by its server-side name. */
  async callTool(name, args = {}) {
    await this.ensureInitialized();
    return this.#call('tools/call', { name, arguments: args ?? {} });
  }
}
