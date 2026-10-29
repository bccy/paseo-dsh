/**
 * Offline check for the bridge's minimal MCP streamable-HTTP client.
 *
 * The Paseo MCP gateway replaces the official `@deepseek-ai/dsh-mcp-client`
 * plugin (61 tool schemas injected into every request) with three meta-tools
 * that reach the same server on demand — see `dsh-bridge/lib/mcp-gateway.js`.
 * The wire protocol lives in `dsh-bridge/lib/mcp-http.js`, which is the part a
 * live session cannot easily exercise: servers answer with SSE *or* plain JSON,
 * may or may not issue a session id, and distinguish notifications from
 * requests. A regression here shows up as "the gateway cannot reach Paseo"
 * inside a model turn — the slowest possible place to debug it.
 *
 * This check drives the client against a local HTTP server that behaves like the
 * real one (SSE frames, no session id on `initialize`, JSON-RPC errors) and
 * asserts both the requests it sends and the failures it reports.
 *
 * Pure module: no DSH profile, no daemon, no network beyond loopback.
 *
 * Usage: node harness/mcp-http-check.mjs
 */
import { createServer } from 'node:http';
import { McpHttpClient, browserHostGapOf, isEventStream, isSessionGoneError, mcpRequest, parseSseFrames, pickResult, unavailableBrowserTools } from '../dsh-bridge/lib/mcp-http.js';

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/** Requests the fake server observed, so the check can assert what went out. */
const seen = [];
let initializeCount = 0;
/** `tools/list` requests, counted so `cacheTools` can be asserted exactly. */
let listCount = 0;
/** Session ids the `/sessions` server still honours; emptying it is a restart. */
const liveSessions = new Set();
let nextSession = 0;
/** Forget every issued session, the way a restarted stateful server does. */
const dropSessions = () => liveSessions.clear();
/** Ids issued per path, in order, so assertions name the real id rather than guess. */
const issuedByPath = new Map();
/** Make `/sessions-down` fail `tools/list` — a server that stayed broken. */
let sessionDownOnList = false;
/**
 * Notifications that arrived carrying an `id`, counted so the check can assert
 * the handshake never made the server answer `-32601`.
 *
 * This is the counter that would have caught the regression that shipped: a
 * `notifications/initialized` sent as a request is not a cosmetic difference,
 * it is the handshake failing on Paseo's own server.
 */
let notificationRejections = 0;
/** `/malformed` answers its first `tools/list` with a protocol-illegal frame. */
let malformedServed = false;

/** One page of the three-page `/paged` catalog, keyed by the cursor that names it. */
const PAGED_TOOLS = {
  '': [{ name: 'p1', description: 'page 1', inputSchema: { type: 'object' } }],
  p2: [{ name: 'p2', description: 'page 2', inputSchema: { type: 'object' } }],
  p3: [{ name: 'p3', description: 'page 3', inputSchema: { type: 'object' } }],
};
/** The cursor each page advertises as `nextCursor`; the last page has none. */
const PAGED_NEXT = { '': 'p2', p2: 'p3' };

/** Settle a promise into its value or its error, so a failure stays assertable. */
const attempt = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    return error;
  }
};

/**
 * Lines the client wrote to stderr during this run.
 *
 * The streamable-HTTP transport has no server-to-client write channel — one POST
 * carries one message, and the response body is the only thing the server can say
 * — so a server request that arrives here cannot be *answered*. Dropping it in
 * silence is the one option that is wrong: a server handler awaiting the reply
 * hangs to its own timeout, and nothing anywhere says why. The client therefore
 * reports it, and that report is what this check can assert.
 */
const serverRequestNotices = [];
const writeStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  serverRequestNotices.push(String(chunk).trimEnd());
  return writeStderr(chunk, ...rest);
};

/**
 * The paths that model session loss, keyed by URL.
 *
 * `stateful` servers issue an id per handshake and 404 anything carrying a dead
 * one. `callStatus`/`callBody` make `tools/call` fail with a chosen status, so
 * the check can drive a 404 that is *not* about the session through the same
 * client while `tools/list` keeps working.
 */
const sessionPaths = {
  // A restarted stateful server: `session not found` on a forgotten id.
  '/sessions': { stateful: true, goneBody: 'session not found' },
  // The same server, but it stays broken after the restart: `tools/list` fails
  // once `sessionDownOnList` is set, so "recovered" and "served a stale catalog"
  // are distinguishable.
  '/sessions-down': { stateful: true, goneBody: 'session not found', failsWhenDown: true },
  // A stateful server that answers a dead id with a bare 404 and no explanation.
  '/sessions-bare': { stateful: true, goneBody: '' },
  // A stateful server whose 404 is about something else entirely — the client
  // must not read it as a lost session and throw the session away.
  '/sessions-other-404': { stateful: true, goneBody: '', callStatus: 404, callBody: 'no such widget' },
  // A stateless server (Paseo's own shape) that 404s with session-sounding text:
  // no id was ever issued, so there is no session to lose and nothing to reset.
  '/stateless-404': { stateful: false, goneBody: '', listStatus: 404, listBody: 'session not found' },
  // A server-initiated request (`ping`) that carries the same id as the listing in
  // flight. JSON-RPC allows a server to send requests at any time, and both sides
  // number from 1, so the collision is the expected case rather than an exotic
  // one. Treating it as the answer resolved `tools/list` with `undefined` → an
  // empty catalog cached for the life of the session, with the real answer
  // arriving one frame later and dropped.
  '/server-request': { stateful: false, serverRequest: 'collide' },
  // The same request with an id nobody is waiting on: nothing may resolve, and the
  // request must still be answered — a server handler awaiting `ping()` hangs to
  // its own timeout if the client silently drops it. This endpoint has no write
  // channel back (one POST per message, no GET stream), so "answered" here means
  // the client says so on stderr rather than pretending it replied.
  '/server-request-foreign': { stateful: false, serverRequest: 'foreign' },
  // A three-page catalog. `tools/list` is the one MCP method with standard
  // pagination; a client that ignores `nextCursor` reports page one as the whole
  // catalog, so `mcp_tool_schema` for a page-two tool answers "exposes no tool" —
  // a missing fetch reported as a missing tool.
  '/paged': { stateful: false, paged: true },
  // A server that answers its first `tools/list` with `{jsonrpc, id}` and neither
  // `result` nor `error` (protocol-illegal), then behaves. The empty catalog must
  // not be cached: "we could not read it" is not "it has no tools".
  '/malformed': { stateful: false, malformedOnce: true },
  // A request answered `202` with an empty body. `202` acknowledges a
  // *notification*; for a request it means the server violated the spec, and
  // reading the empty body as success cached an empty catalog.
  '/empty-body': { stateful: false, emptyBody: true },
};

/** Answer one JSON-RPC POST the way a streamable-HTTP MCP server does. */
function respond(res, message, { sse = true, sessionId, delayMs = 0 } = {}) {
  const body = sse ? `event: message\ndata: ${JSON.stringify(message)}\n\n` : JSON.stringify(message);
  setTimeout(() => {
    res.writeHead(200, {
      'content-type': sse ? 'text/event-stream' : 'application/json',
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    });
    res.end(body);
  }, delayMs);
}

/**
 * Answer with several messages on one SSE response.
 *
 * A streamable-HTTP server may put a server-initiated request and the response to
 * our own request in the same POST answer — the SDK writes one `data:` frame per
 * message. Sending them as one array instead would be a different (batch-shaped)
 * body and would not reproduce the id collision this check is about.
 */
function respondFrames(res, messages) {
  const body = messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join('');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(body);
}

/**
 * Answer a JSON-RPC *notification* the way the real Paseo server does.
 *
 * A notification has no `id` by definition (JSON-RPC 2.0 §4), and the server
 * acknowledges it with a bare `202` and no body. What the real endpoint does
 * with a notification that *does* carry an id — verified by hand against
 * `http://127.0.0.1:6767/mcp/agents` — is treat it as a request for a method it
 * does not have: `200` plus `-32601 Method not found`. Answering `202`
 * unconditionally, as this fake used to, hides that difference completely: the
 * client can send the wrong shape and still see a clean handshake, which is
 * exactly how a handshake-breaking regression passed 43/43 here while Paseo
 * refused every gateway call in the live environment.
 */
function respondNotification(res, message) {
  if (message.id !== undefined) {
    notificationRejections += 1;
    // Same framing as the real endpoint: a `200` SSE frame carrying `-32601`.
    respond(res, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  res.writeHead(202);
  res.end();
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (req.url === '/fail') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('exploded');
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => respond(res, { jsonrpc: '2.0', id: 1, result: {} }, { sse: false }), 5_000);
      return;
    }
    // ── servers that can lose a session, or 404 for another reason ────────────
    // A stateful server forgets every session when it restarts, and then answers
    // any request still carrying the old id with the spec's HTTP 404. `dropSessions()`
    // is that restart. The other paths exist so the check can prove the client
    // tells a lost session apart from a 404 about some other resource, and that a
    // stateless server (which never gets an id) is not touched at all.
    const sessionPath = sessionPaths[req.url];
    if (sessionPath !== undefined) {
      const message = JSON.parse(raw);
      seen.push({ message, headers: req.headers, url: req.url });
      const carried = req.headers['mcp-session-id'];
      if (carried !== undefined && !liveSessions.has(carried)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end(sessionPath.goneBody);
        return;
      }
      if (message.method === 'initialize') {
        initializeCount += 1;
        const issued = sessionPath.stateful ? `sess-${nextSession++}` : undefined;
        if (issued !== undefined) {
          liveSessions.add(issued);
          const list = issuedByPath.get(req.url) ?? [];
          list.push(issued);
          issuedByPath.set(req.url, list);
        }
        respond(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-session', version: '1' } },
        }, { sessionId: issued });
        return;
      }
      if (message.method === 'notifications/initialized') {
        respondNotification(res, message);
        return;
      }
      if (message.method === 'tools/list') {
        if (sessionPath.listStatus !== undefined) {
          res.writeHead(sessionPath.listStatus, { 'content-type': 'text/plain' });
          res.end(sessionPath.listBody);
          return;
        }
        if (sessionPath.failsWhenDown === true && sessionDownOnList) {
          res.writeHead(503, { 'content-type': 'text/plain' });
          res.end('server restarting');
          return;
        }
        listCount += 1;
        if (sessionPath.paged === true) {
          const cursor = message.params?.cursor ?? '';
          const next = PAGED_NEXT[cursor];
          respond(res, {
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: PAGED_TOOLS[cursor] ?? [], ...(next === undefined ? {} : { nextCursor: next }) },
          });
          return;
        }
        if (sessionPath.malformedOnce === true && !malformedServed) {
          // `{jsonrpc, id}` with neither `result` nor `error`: legal JSON, illegal
          // JSON-RPC. The client must say so and must not cache the emptiness.
          malformedServed = true;
          respond(res, { jsonrpc: '2.0', id: message.id });
          return;
        }
        if (sessionPath.emptyBody === true) {
          // `202` with no body acknowledges a notification. Answering a *request*
          // this way is a server bug, and treating it as success turned "the
          // server said nothing" into "the server has no tools".
          res.writeHead(202);
          res.end();
          return;
        }
        if (sessionPath.serverRequest !== undefined) {
          // A server-initiated request, framed exactly as the MCP SDK sends `ping`
          // (both sides number from 1, so the colliding id is the ordinary case).
          const requestId = sessionPath.serverRequest === 'collide' ? message.id : 999;
          respondFrames(res, [
            { jsonrpc: '2.0', id: requestId, method: 'ping' },
            {
              jsonrpc: '2.0',
              id: message.id,
              result: { tools: [{ name: 'echo', description: 'Echo the text', inputSchema: { type: 'object' } }] },
            },
          ]);
          return;
        }
        respond(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: [{ name: 'echo', description: 'Echo the text', inputSchema: { type: 'object' } }] },
        });
        return;
      }
      if (message.method === 'tools/call') {
        if (sessionPath.callStatus !== undefined) {
          res.writeHead(sessionPath.callStatus, { 'content-type': 'text/plain' });
          res.end(sessionPath.callBody);
          return;
        }
        respond(res, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } }, { sse: false });
        return;
      }
      respond(res, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } }, { sse: false });
      return;
    }
    const message = JSON.parse(raw);
    seen.push({ message, headers: req.headers, url: req.url });
    if (message.method === 'initialize') {
      initializeCount += 1;
      // Paseo's own server is stateless (`/rpc`); a stateful server issues a
      // session id (`/stateful`) and expects it echoed afterwards.
      respond(res, {
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } },
      }, { sessionId: req.url === '/stateful' ? 'sess-a' : undefined });
      return;
    }
    if (message.method === 'notifications/initialized') {
      respondNotification(res, message);
      return;
    }
    if (message.method === 'tools/list') {
      listCount += 1;
      respond(res, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'echo', description: 'Echo the text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
            { name: 'boom', description: 'Always fails', inputSchema: { type: 'object' } },
          ],
        },
      });
      return;
    }
    if (message.method === 'tools/call') {
      // JSON (not SSE) exercises the second response framing.
      if (message.params?.name === 'boom') {
        respond(res, { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'tool exploded' } }, { sse: false });
        return;
      }
      respond(res, {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `echo:${message.params?.arguments?.text ?? ''}` }] },
      }, { sse: false });
      return;
    }
    respond(res, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } }, { sse: false });
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  // ── framing helpers ────────────────────────────────────────────────────────
  const frames = parseSseFrames('event: message\ndata: {"a":1}\n\ndata: {"b":2}\n');
  check('SSE frames parse into JSON messages', frames.length === 2 && frames[1].b === 2, JSON.stringify(frames));
  check('SSE comments and event names are ignored', parseSseFrames(': keep-alive\nevent: message\n').length === 0, 'no data lines');
  check(
    'an unparseable SSE frame fails loudly',
    (() => { try { parseSseFrames('data: {oops}\n'); return false; } catch { return true; } })(),
    'non-JSON data must throw, not be skipped',
  );
  check('event-stream detection', isEventStream('text/event-stream; charset=utf-8') && !isEventStream('application/json'), 'content-type sniff');

  const ok = pickResult({ jsonrpc: '2.0', id: 7, result: { value: 1 } }, 7);
  check('pickResult returns the matching result', ok.value === 1, JSON.stringify(ok));
  check(
    'pickResult surfaces JSON-RPC errors with code',
    (() => { try { pickResult({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'nope' } }, 7); return false; } catch (error) { return /nope \(-32000\)/.test(error.message); } })(),
    'error frames become thrown errors',
  );
  check(
    'pickResult refuses a missing id',
    (() => { try { pickResult([{ jsonrpc: '2.0', method: 'notifications/progress' }], 9); return false; } catch { return true; } })(),
    'notifications must never be mistaken for the reply',
  );

  // ── browser-host labelling (the gateway probes before promising browser tools) ──
  const catalog = [
    { name: 'browser_click' },
    { name: 'browser_screenshot' },
    { name: 'list_agents' },
    { name: 'create_heartbeat' },
  ];
  // Paseo answers "no host" as an ordinary tool result, not a JSON-RPC error.
  const noHostResult = {
    content: [{ type: 'text', text: 'No browser automation host is connected.' }],
    structuredContent: { ok: false, error: { code: 'browser_no_host', message: 'No browser automation host is connected.', retryable: true } },
  };
  const gap = browserHostGapOf(noHostResult);
  check(
    'a no-host probe result is recognised from its structured error code',
    gap === 'No browser automation host is connected.',
    String(gap),
  );
  check(
    'an unreachable browser host marks every browser tool unavailable',
    JSON.stringify(unavailableBrowserTools(catalog, gap)) === JSON.stringify(['browser_click', 'browser_screenshot']),
    JSON.stringify(unavailableBrowserTools(catalog, gap)),
  );
  check(
    'the no-host text alone is enough for an older host',
    browserHostGapOf({ content: [{ type: 'text', text: 'No browser automation host is connected.' }] }) !== undefined,
    'structuredContent is not required',
  );
  check(
    'a reachable host (tab list) marks nothing',
    browserHostGapOf({ content: [{ type: 'text', text: 'Found 1 Paseo browser tab.' }], structuredContent: { ok: true } }) === undefined &&
      unavailableBrowserTools(catalog, undefined).length === 0,
    'normal listing or no probe leaves tools unlabelled',
  );
  check(
    'an unrelated probe failure marks nothing',
    browserHostGapOf(new Error('mcp: browser_list_tabs timed out after 60000ms')) === undefined &&
      browserHostGapOf({ content: [{ type: 'text', text: 'some other tool failure' }] }) === undefined,
    'a timeout must not be reported as "no host"',
  );
  check(
    'a catalog without browser tools marks nothing',
    unavailableBrowserTools([{ name: 'list_agents' }], gap).length === 0,
    'non-browser servers are unaffected',
  );
  check(
    'a non-array catalog is tolerated',
    unavailableBrowserTools(undefined, gap).length === 0 && unavailableBrowserTools('nope', gap).length === 0,
    'defensive for untyped JSON-RPC input',
  );

  // ── one round trip ─────────────────────────────────────────────────────────
  const single = await mcpRequest({ url: `${base}/rpc`, method: 'initialize', params: { protocolVersion: '2025-06-18' }, id: 1 });
  check('a stateless server (Paseo) round-trips without a session id', single.result?.serverInfo?.name === 'fake' && single.sessionId === undefined, JSON.stringify(single.sessionId));
  const sentHeaders = seen.at(-1).headers;
  check(
    'requests advertise both media types',
    String(sentHeaders.accept).includes('application/json') && String(sentHeaders.accept).includes('text/event-stream'),
    String(sentHeaders.accept),
  );
  check('requests are JSON-RPC 2.0 POSTs', seen.at(-1).message.jsonrpc === '2.0' && seen.at(-1).message.method === 'initialize', JSON.stringify(seen.at(-1).message).slice(0, 120));

  const failed = await (async () => { try { await mcpRequest({ url: `${base}/fail`, method: 'tools/list', id: 2 }); return null; } catch (error) { return error; } })();
  check('HTTP failures name the method and status', /tools\/list failed with HTTP 500/.test(failed?.message ?? ''), failed?.message);

  const timedOut = await (async () => { try { await mcpRequest({ url: `${base}/slow`, method: 'tools/list', id: 3, timeoutMs: 120 }); return null; } catch (error) { return error; } })();
  check('a slow server times out with the budget named', /timed out after 120ms/.test(timedOut?.message ?? ''), timedOut?.message);

  // ── a notification must not be sent as a request ───────────────────────────
  // JSON-RPC 2.0 draws one line the handshake depends on: a *request* carries an
  // `id`, a *notification* does not. Sending `notifications/initialized` with an
  // id is therefore not a cosmetic difference — it asks the server for a method
  // it does not have. Paseo's own endpoint answers such a message with
  // `-32601 Method not found` (verified by hand against
  // `http://127.0.0.1:6767/mcp/agents`: an id-bearing notification gets `200` +
  // `-32601`, the id-less one gets `202` with an empty body), which fails
  // `ensureInitialized()` and makes all 61 gateway tools unreachable.
  //
  // This shipped once, because this fake server answered `202` to every
  // `notifications/initialized` regardless of its shape — 43/43 green on a
  // handshake the real server was rejecting. `respondNotification` above now
  // mirrors the real endpoint, so the assertions below are the ones that would
  // have gone red: the wire shape of the notification, and the handshake
  // actually completing against a server that refuses the wrong shape.

  // (a) The transport itself: `id === undefined` must mean "no `id` field at
  // all", not `"id": null` and not a generated one.
  const directNotification = await (async () => {
    try {
      return await mcpRequest({ url: `${base}/notify-shape`, method: 'notifications/initialized', sessionId: 'sess-x' });
    } catch (error) { return error; }
  })();
  const directSent = seen.findLast((entry) => entry.url === '/notify-shape' && entry.message.method === 'notifications/initialized');
  check(
    'mcpRequest omits the id field entirely for a notification',
    !(directNotification instanceof Error)
      && directSent !== undefined
      && !Object.prototype.hasOwnProperty.call(directSent.message, 'id')
      && directSent.message.jsonrpc === '2.0'
      && directSent.message.method === 'notifications/initialized'
      && directSent.headers['mcp-session-id'] === 'sess-x',
    directNotification instanceof Error
      ? `mcpRequest rejected the notification: ${directNotification.message}`
      : `payload: ${JSON.stringify(directSent?.message)}`,
  );

  // (b) The client's own handshake, asserted before anything else can throw: on
  // the regression these two halves fail together, because the id makes the
  // server answer `-32601` and `ensureInitialized()` rejects. Catching that
  // rejection here (rather than letting it abort the run) is what keeps the
  // failure a named FAIL with the server's own words in it.
  const shapeClient = new McpHttpClient({ url: `${base}/rpc` });
  const shapeHandshake = await (async () => {
    try { await shapeClient.ensureInitialized(); return null; } catch (error) { return error; }
  })();
  const clientNotification = seen.findLast((entry) => entry.url === '/rpc' && entry.message.method === 'notifications/initialized');
  check(
    'the client sends notifications/initialized without an id',
    shapeHandshake === null
      && clientNotification !== undefined
      && !Object.prototype.hasOwnProperty.call(clientNotification.message, 'id'),
    shapeHandshake !== null
      ? `ensureInitialized() threw: ${shapeHandshake.message}; payload: ${JSON.stringify(clientNotification?.message)}`
      : `payload: ${JSON.stringify(clientNotification?.message)}`,
  );
  check(
    'the handshake is accepted by a server that refuses id-bearing notifications',
    shapeHandshake === null && notificationRejections === 0,
    shapeHandshake !== null
      ? `ensureInitialized() threw: ${shapeHandshake.message} (${notificationRejections} notification(s) answered -32601)`
      : `${notificationRejections} notification(s) answered -32601, handshake completed`,
  );

  // ── client lifecycle ───────────────────────────────────────────────────────
  const client = new McpHttpClient({ url: `${base}/rpc` });
  // A handshake the server refuses must be reported, not thrown: an aborting
  // check prints nothing and therefore names nothing.
  const firstList = await (async () => {
    try { return await client.listTools(); } catch (error) { return error; }
  })();
  const tools = Array.isArray(firstList) ? firstList : [];
  check(
    'listTools returns the server catalog',
    !(firstList instanceof Error) && tools.length === 2 && tools[0].name === 'echo',
    firstList instanceof Error ? firstList.message : JSON.stringify(tools.map((tool) => tool.name)),
  );

  const echo = await (async () => {
    try { return await client.callTool('echo', { text: 'hi' }); } catch (error) { return error; }
  })();
  check(
    'callTool returns MCP content',
    echo?.content?.[0]?.text === 'echo:hi',
    echo instanceof Error ? echo.message : JSON.stringify(echo).slice(0, 120),
  );

  const boom = await (async () => { try { await client.callTool('boom'); return null; } catch (error) { return error; } })();
  check('an MCP tool error becomes a thrown error', /tool exploded/.test(boom?.message ?? ''), boom?.message);

  await client.listTools();
  check('the handshake runs once per client', initializeCount === 3, `initialize count: ${initializeCount} (1 direct + 1 shape client + 1 client)`);
  const statelessList = seen.findLast((entry) => entry.message.method === 'tools/list');
  check('a stateless server needs no session header', statelessList.headers['mcp-session-id'] === undefined, String(statelessList.headers['mcp-session-id']));


  // ── tools/list caching ─────────────────────────────────────────────────────
  // The default is the contract that matters: `clientFor` in `mcp-gateway.js`
  // passes no `cacheTools`, so whatever the constructor defaults to is what every
  // gateway listing pays. Caching is the whole point of the gateway (61 schemas,
  // ~33 KB kept out of every request), so an uncached default would turn each
  // `mcp_list_tools` into a round trip for a catalog that changes only on restart.
  // Both directions are asserted, plus the escape hatches.

  // Default (no `cacheTools`): the catalog is read once and reused.
  const defaultBefore = listCount;
  const byDefault = new McpHttpClient({ url: `${base}/rpc` });
  const defaultFirst = await byDefault.listTools();
  const defaultSecond = await byDefault.listTools();
  const defaultThird = await byDefault.listTools();
  check(
    'by default tools/list is fetched only on the first call',
    listCount - defaultBefore === 1,
    `${listCount - defaultBefore} tools/list request(s) for 3 calls`,
  );
  check(
    'a cached catalog is the same catalog, not a refetch',
    defaultFirst === defaultSecond && defaultSecond === defaultThird && defaultSecond.length === 2,
    JSON.stringify(defaultSecond.map((tool) => tool.name)),
  );
  check(
    'the cache is on by default, spelled out rather than inferred from counts',
    byDefault.cacheTools === true,
    `cacheTools = ${JSON.stringify(byDefault.cacheTools)}`,
  );

  // `cacheTools: false` opts a server that rewrites its catalog out of the cache.
  const uncachedBefore = listCount;
  const uncached = new McpHttpClient({ url: `${base}/rpc`, cacheTools: false });
  await uncached.listTools();
  await uncached.listTools();
  await uncached.listTools();
  check(
    'with cacheTools: false, tools/list is fetched on every call',
    listCount - uncachedBefore === 3,
    `${listCount - uncachedBefore} tools/list request(s) for 3 calls`,
  );

  // `refresh` still overrides the cache: the escape hatch has to work, or a
  // server that did change its catalog could never be re-read.
  const refreshBefore = listCount;
  const refreshed = await byDefault.listTools({ refresh: true });
  check(
    'refresh: true re-reads even with the cache on',
    listCount - refreshBefore === 1 && refreshed.length === 2,
    `${listCount - refreshBefore} tools/list request(s)`,
  );

  // The cache is per client, not module-wide: a second client must not inherit
  // the first one's catalog (it may point at a different server).
  const otherBefore = listCount;
  const other = new McpHttpClient({ url: `${base}/rpc` });
  await other.listTools();
  check(
    'the cache does not leak between clients',
    listCount - otherBefore === 1,
    `${listCount - otherBefore} tools/list request(s) for a fresh client`,
  );

  // `callTool` must not be affected by the flag — the cache is about the
  // catalog only, and a cached call would be a wrong answer, not a saving.
  const callBefore = listCount;
  const called = await byDefault.callTool('echo', { text: 'cached' });
  check(
    'a cached client still calls tools for real',
    called.content?.[0]?.text === 'echo:cached' && listCount === callBefore,
    JSON.stringify(called).slice(0, 120),
  );

  const stateful = new McpHttpClient({ url: `${base}/stateful` });
  await stateful.listTools();
  const statefulList = seen.findLast((entry) => entry.message.method === 'tools/list' && entry.headers['mcp-session-id'] === 'sess-a');
  check('an issued session id is echoed on later requests', statefulList !== undefined, 'tools/list must carry mcp-session-id: sess-a');
  // Counted per path so the transport-level notification asserted earlier
  // (`/notify-shape`, one direct `mcpRequest`) cannot be mistaken for a client
  // handshake: `/rpc` has four clients, `/stateful` one, and each must have sent
  // its notification exactly once.
  const notificationsByPath = new Map();
  for (const entry of seen.filter((item) => item.message.method === 'notifications/initialized')) {
    notificationsByPath.set(entry.url, (notificationsByPath.get(entry.url) ?? 0) + 1);
  }
  check(
    'each client sends initialized exactly once, after its handshake',
    notificationsByPath.get('/rpc') === 5
      && notificationsByPath.get('/stateful') === 1
      && notificationsByPath.get('/notify-shape') === 1,
    `per path: ${JSON.stringify([...notificationsByPath])} (5 /rpc clients, 1 /stateful client, 1 direct)`,
  );

  // ── a lost session heals, and a known-dead connection never answers ────────
  // A stateful MCP server drops every session when it restarts and answers any
  // request still carrying the old id with HTTP 404. `initialize` is sent once
  // per client, so without recovery that 404 is permanent: every later call
  // fails, and a cached catalog keeps answering for a connection the server has
  // already forgotten — the silent degradation this repository bans. Both halves
  // are asserted below: the client must re-handshake (self-heal), and it must not
  // serve a cache hit from a session it knows is gone (no silent degradation).

  const sessionClient = new McpHttpClient({ url: `${base}/sessions` });
  const sessionFirst = await sessionClient.listTools();
  const firstIssued = (issuedByPath.get('/sessions') ?? [])[0];
  check(
    'a stateful server issues a session id that is echoed afterwards',
    sessionFirst.length === 1 &&
      firstIssued !== undefined &&
      seen.findLast((entry) => entry.url === '/sessions' && entry.message.method === 'tools/list')?.headers['mcp-session-id'] === firstIssued,
    'tools/list must carry the id issued by initialize',
  );

  // The restart. The next call is rejected with 404 `session not found`, which is
  // the only signal the server gives — there is no JSON-RPC frame to inspect.
  dropSessions();
  const goneCall = await (async () => { try { await sessionClient.callTool('echo'); return null; } catch (error) { return error; } })();
  check(
    'a call on a forgotten session is rejected and named',
    /HTTP 404/.test(goneCall?.message ?? '') && /session not found/.test(goneCall?.message ?? ''),
    goneCall?.message,
  );

  // Self-healing: the next listing must succeed by re-handshaking, not repeat the
  // 404 forever. The 404 is thrown for the call that hit it; recovery is the next
  // call's job, which is what a model retrying its tool does.
  const healedAttempt = await (async () => {
    try { return await sessionClient.listTools(); } catch (error) { return error; }
  })();
  const healed = Array.isArray(healedAttempt) ? healedAttempt : [];
  const healedList = seen.findLast((entry) => entry.url === '/sessions' && entry.message.method === 'tools/list');
  const healedId = (issuedByPath.get('/sessions') ?? [])[1];
  check(
    'the next call after a lost session re-handshakes and succeeds',
    !(healedAttempt instanceof Error)
      && healed.length === 1
      && healedId !== undefined
      && healedList?.headers['mcp-session-id'] === healedId
      && healedId !== firstIssued,
    healedAttempt instanceof Error
      ? `recovery threw: ${healedAttempt.message}`
      : `catalog=${JSON.stringify(healed.map((tool) => tool.name))} carried=${String(healedList?.headers['mcp-session-id'])} expected=${String(healedId)}`,
  );
  const sessionHandshakes = seen.filter((entry) => entry.url === '/sessions' && entry.message.method === 'initialize').length;
  check(
    'recovery re-runs initialize exactly once, not once per call',
    sessionHandshakes === 2,
    `${sessionHandshakes} initialize request(s) on /sessions (initial + one recovery)`,
  );
  const recoveredEcho = await (async () => { try { return await sessionClient.callTool('echo'); } catch (error) { return error; } })();
  check(
    'the recovered session id is the one echoed from then on',
    !(recoveredEcho instanceof Error) &&
      seen.findLast((entry) => entry.url === '/sessions' && entry.message.method === 'tools/call')?.headers['mcp-session-id'] === healedId,
    `later calls must carry the id issued by the recovery handshake — got ${recoveredEcho instanceof Error ? recoveredEcho.message : 'ok'}`,
  );

  // No silent degradation. The cache must not survive the session it describes:
  // a catalog read from a connection the server has forgotten may not answer the
  // next `listTools()`. The server here stays down after the restart, so a correct
  // client has nothing to serve and must fail loudly — returning the cached catalog
  // is the only way this call could "succeed", which is exactly the bug.
  const downClient = new McpHttpClient({ url: `${base}/sessions-down` });
  const downFirst = await downClient.listTools();   // cache established while alive
  sessionDownOnList = true;
  dropSessions();
  const downCall = await (async () => { try { await downClient.callTool('echo'); return null; } catch (error) { return error; } })();
  const staleAfterLoss = await (async () => { try { return await downClient.listTools(); } catch (error) { return error; } })();
  check(
    'a cached catalog cannot answer after the session is known to be gone',
    downFirst.length === 1
      && /HTTP 404/.test(downCall?.message ?? '')
      && staleAfterLoss instanceof Error,
    `after the 404, listTools() must fail loudly instead of serving the stale catalog — got ${staleAfterLoss instanceof Error ? staleAfterLoss.message : `the cached catalog (${JSON.stringify(staleAfterLoss.map((tool) => tool.name))}), silently`}`,
  );
  sessionDownOnList = false;

  // A bare 404 — the spec's minimum, no explanation in the body — is still a lost
  // session: the request carried an id the server no longer honours.
  const bareClient = new McpHttpClient({ url: `${base}/sessions-bare` });
  await bareClient.listTools();
  dropSessions();
  const bareGone = await (async () => { try { await bareClient.callTool('echo'); return null; } catch (error) { return error; } })();
  const bareHealedAttempt = await (async () => {
    try { return await bareClient.listTools(); } catch (error) { return error; }
  })();
  const bareHealed = Array.isArray(bareHealedAttempt) ? bareHealedAttempt : [];
  check(
    'a bare 404 with no body is still read as a lost session',
    /HTTP 404/.test(bareGone?.message ?? '')
      && !(bareHealedAttempt instanceof Error)
      && bareHealed.length === 1
      && (issuedByPath.get('/sessions-bare') ?? []).length === 2,
    bareHealedAttempt instanceof Error
      ? `recovery threw: ${bareHealedAttempt.message}`
      : `rejected=${bareGone?.message} recovered=${JSON.stringify(bareHealed.map((tool) => tool.name))} handshakes=${(issuedByPath.get('/sessions-bare') ?? []).length}`,
  );

  // Precision: a 404 that is *not* about the session must not throw the session
  // away. The server here keeps honouring `sess-*`; only `tools/call` 404s, and
  // the body says what is actually missing.
  const otherClient = new McpHttpClient({ url: `${base}/sessions-other-404` });
  await otherClient.listTools();
  const otherGone = await (async () => { try { await otherClient.callTool('echo'); return null; } catch (error) { return error; } })();
  const otherAfter = await otherClient.listTools();
  const otherCalls = seen.filter((entry) => entry.url === '/sessions-other-404' && entry.message.method === 'tools/call');
  check(
    'a 404 about something other than the session does not discard the session',
    /no such widget/.test(otherGone?.message ?? '') &&
      otherAfter.length === 1 &&
      otherCalls.length === 1 &&
      seen.filter((entry) => entry.url === '/sessions-other-404' && entry.message.method === 'initialize').length === 1,
    `initialize count stayed 1 (no needless re-handshake), calls=${otherCalls.length}`,
  );

  // Stateless servers are untouched: Paseo's own never issues an id, so there is
  // no session state to lose. A 404 whose body even says "session not found"
  // must still propagate as-is and must not trigger a re-handshake, because this
  // client never had a session to reset.
  const statelessClient = new McpHttpClient({ url: `${base}/stateless-404` });
  const statelessGone = await (async () => { try { await statelessClient.listTools(); return null; } catch (error) { return error; } })();
  const statelessRetry = await (async () => { try { await statelessClient.listTools(); return null; } catch (error) { return error; } })();
  const statelessHandshakes = seen.filter((entry) => entry.url === '/stateless-404' && entry.message.method === 'initialize').length;
  const statelessCarried = seen.filter((entry) => entry.url === '/stateless-404' && entry.headers['mcp-session-id'] !== undefined).length;
  check(
    'a stateless server never takes the session-recovery path',
    /HTTP 404/.test(statelessGone?.message ?? '') &&
      /HTTP 404/.test(statelessRetry?.message ?? '') &&
      statelessHandshakes === 1 &&
      statelessCarried === 0,
    `initialize=${statelessHandshakes} (no recovery), requests carrying an id=${statelessCarried} (must be 0)`,
  );

  // ── server-initiated requests ──────────────────────────────────────────────
  // JSON-RPC 2.0 §5 lets a server send requests of its own (`ping`, `roots/list`,
  // `sampling/createMessage`, `elicitation/create`) at any point in the stream,
  // and MCP servers do. Two things go wrong if a response and a request are
  // matched by `id` alone:
  //
  //   (a) both sides number from 1, so a server request's id collides with an
  //       in-flight request of ours. Reading it as the answer resolved the call
  //       with `undefined` — an empty catalog, or a tool call reporting success
  //       with no content while the real answer arrived one frame later;
  //   (b) an id nobody is waiting on was dropped, so a server handler awaiting
  //       that reply hangs to its own timeout.
  //
  // The streamable-HTTP transport here is one POST per message with no server
  // write channel, so (b) can only be *said* on stderr, not replied to. The
  // assertion is therefore on the client's diagnostic and on the answer still
  // being the answer — not on a response frame that cannot exist.
  const collideClient = new McpHttpClient({ url: `${base}/server-request` });
  const collided = await attempt(() => collideClient.listTools());
  check(
    'a server request that collides with an in-flight id is not read as the answer',
    Array.isArray(collided) && collided.length === 1 && collided[0].name === 'echo',
    collided instanceof Error ? collided.message : `catalog=${JSON.stringify(collided.map((tool) => tool.name))} (the server sent {id:<same>,method:"ping"} first)`,
  );

  const foreignClient = new McpHttpClient({ url: `${base}/server-request-foreign` });
  const foreign = await attempt(() => foreignClient.listTools());
  check(
    'a server request with a foreign id leaves the real answer intact',
    Array.isArray(foreign) && foreign.length === 1,
    foreign instanceof Error ? foreign.message : `catalog=${JSON.stringify(foreign.map((tool) => tool.name))}`,
  );
  check(
    'and the dropped server request is reported rather than silently discarded',
    serverRequestNotices.some((line) => /ping/.test(line)) && serverRequestNotices.some((line) => /999/.test(line)),
    serverRequestNotices.length === 0
      ? 'nothing was written to stderr: a server awaiting this reply hangs to its own timeout'
      : serverRequestNotices.join(' | '),
  );

  // ── tools/list pagination ──────────────────────────────────────────────────
  // `tools/list` is the one MCP method with standard cursor pagination. A client
  // that reads only the first page reports it as the whole catalog, so a page-two
  // tool "does not exist" as far as `mcp_tool_schema` is concerned — a fetch that
  // never happened reported as a missing tool.
  const pagedBefore = listCount;
  const pagedClient = new McpHttpClient({ url: `${base}/paged` });
  const paged = await attempt(() => pagedClient.listTools());
  const pagedNames = Array.isArray(paged) ? paged.map((tool) => tool.name) : [];
  check(
    'every page of a paginated tools/list is collected',
    JSON.stringify(pagedNames) === JSON.stringify(['p1', 'p2', 'p3']),
    paged instanceof Error ? paged.message : `catalog=${JSON.stringify(pagedNames)}`,
  );
  check(
    'and it takes exactly one request per page, no more',
    listCount - pagedBefore === 3,
    `${listCount - pagedBefore} tools/list request(s) for a 3-page catalog`,
  );
  // The pages must be stitched into one cache entry: a second call is still a
  // cache hit, and `refresh` re-walks all three pages rather than fetching one.
  const pagedCachedBefore = listCount;
  const pagedAgain = await attempt(() => pagedClient.listTools());
  const pagedRefreshBefore = listCount;
  const pagedRefreshed = await attempt(() => pagedClient.listTools({ refresh: true }));
  check(
    'the stitched catalog is cached, and refresh walks every page again',
    listCount - pagedCachedBefore === 3
      && listCount - pagedRefreshBefore === 3
      && Array.isArray(pagedAgain) && pagedAgain.length === 3
      && Array.isArray(pagedRefreshed) && pagedRefreshed.length === 3,
    `cached call: ${listCount - pagedCachedBefore} request(s) (expected 0), refresh: ${listCount - pagedRefreshBefore} (expected 3)`,
  );

  // ── an untrustworthy tools/list must not be cached ─────────────────────────
  // Two shapes of "the server said nothing usable": a frame with neither `result`
  // nor `error`, and a `202` with an empty body. Both used to be read as an empty
  // catalog, cached, and never retried — so a server that recovered was still
  // reported as having no tools, and the model had no way to tell.
  const malformedClient = new McpHttpClient({ url: `${base}/malformed` });
  const malformed = await attempt(() => malformedClient.listTools());
  check(
    'a tools/list frame with neither result nor error fails loudly',
    malformed instanceof Error && /tools\/list/.test(malformed.message),
    malformed instanceof Error ? malformed.message : `returned ${JSON.stringify(malformed)} instead of throwing`,
  );
  const recovered = await attempt(() => malformedClient.listTools());
  check(
    'and the empty read is not cached: the next call gets the real catalog',
    Array.isArray(recovered) && recovered.length === 1 && recovered[0].name === 'echo',
    recovered instanceof Error ? recovered.message : `catalog=${JSON.stringify(recovered.map((tool) => tool.name))}`,
  );

  const emptyBodyClient = new McpHttpClient({ url: `${base}/empty-body` });
  const emptyBody = await attempt(() => emptyBodyClient.listTools());
  check(
    'a request answered with an empty body is a failure, not an empty catalog',
    emptyBody instanceof Error && /empty body/.test(emptyBody.message) && /tools\/list/.test(emptyBody.message),
    emptyBody instanceof Error ? emptyBody.message : `returned ${JSON.stringify(emptyBody)} instead of throwing`,
  );

  // The detector itself, on the shapes that decide whether recovery happens.
  check(
    'isSessionGoneError accepts only session-shaped 404s',
    (() => {
      const make = (status, body) => Object.assign(new Error('mcp: x failed'), { httpStatus: status, httpBody: body });
      return isSessionGoneError(make(404, 'session not found')) === true
        && isSessionGoneError(make(404, '')) === true
        && isSessionGoneError(make(404, 'session expired')) === true
        && isSessionGoneError(make(404, 'no such widget')) === false
        && isSessionGoneError(make(404, '{"error":"Not Found"}')) === false
        && isSessionGoneError(make(500, 'session not found')) === false
        && isSessionGoneError(make(400, 'session not found')) === false
        && isSessionGoneError(new Error('mcp: timed out after 10ms')) === false;
    })(),
    'session-shaped 404s recover; other statuses and unrelated 404 bodies do not',
  );
} catch (error) {
  // Anything the checks above did not anticipate still has to be *reported*.
  // An uncaught rejection prints a stack trace and exits before the results
  // loop, so every assertion above it vanishes — the run looks like a crash
  // rather than a named failure, and a regression is indistinguishable from a
  // typo in the check itself. Naming it here keeps the exit code meaningful and
  // the failing assertion visible.
  check('the check ran to completion without an uncaught error', false, error instanceof Error ? `${error.message}` : String(error));
} finally {
  server.close();
}

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${result.name}${result.pass ? '' : ` — ${result.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
