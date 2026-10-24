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
import { McpHttpClient, browserHostGapOf, isEventStream, mcpRequest, parseSseFrames, pickResult, unavailableBrowserTools } from '../dsh-bridge/lib/mcp-http.js';

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/** Requests the fake server observed, so the check can assert what went out. */
const seen = [];
let initializeCount = 0;
/** `tools/list` requests, counted so `cacheTools` can be asserted exactly. */
let listCount = 0;

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
    const message = JSON.parse(raw);
    seen.push({ message, headers: req.headers });
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
      res.writeHead(202);
      res.end();
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

  // ── client lifecycle ───────────────────────────────────────────────────────
  const client = new McpHttpClient({ url: `${base}/rpc` });
  const tools = await client.listTools();
  check('listTools returns the server catalog', tools.length === 2 && tools[0].name === 'echo', JSON.stringify(tools.map((tool) => tool.name)));

  const echo = await client.callTool('echo', { text: 'hi' });
  check('callTool returns MCP content', echo.content?.[0]?.text === 'echo:hi', JSON.stringify(echo).slice(0, 120));

  const boom = await (async () => { try { await client.callTool('boom'); return null; } catch (error) { return error; } })();
  check('an MCP tool error becomes a thrown error', /tool exploded/.test(boom?.message ?? ''), boom?.message);

  await client.listTools();
  check('the handshake runs once per client', initializeCount === 2, `initialize count: ${initializeCount} (1 direct + 1 client)`);
  const statelessList = seen.findLast((entry) => entry.message.method === 'tools/list');
  check('a stateless server needs no session header', statelessList.headers['mcp-session-id'] === undefined, String(statelessList.headers['mcp-session-id']));

  // ── tools/list caching ─────────────────────────────────────────────────────
  // The class doc promises "`tools/list` is fetched per call unless `cacheTools`
  // is set". Both halves are asserted: a server can add or drop tools between
  // calls, so an unconditional cache would make `mcp_tool_schema` answer from a
  // catalog the server has since changed, and an unconditional fetch would pay
  // a round trip for a catalog known to be fixed.

  // Default (no `cacheTools`): every call re-reads the catalog.
  const uncachedBefore = listCount;
  const uncached = new McpHttpClient({ url: `${base}/rpc` });
  await uncached.listTools();
  await uncached.listTools();
  await uncached.listTools();
  check(
    'without cacheTools, tools/list is fetched on every call',
    listCount - uncachedBefore === 3,
    `${listCount - uncachedBefore} tools/list request(s) for 3 calls`,
  );

  // `cacheTools: true`: the catalog is read once and reused.
  const cachedBefore = listCount;
  const cached = new McpHttpClient({ url: `${base}/rpc`, cacheTools: true });
  const first = await cached.listTools();
  const second = await cached.listTools();
  const third = await cached.listTools();
  check(
    'with cacheTools, tools/list is fetched only on the first call',
    listCount - cachedBefore === 1,
    `${listCount - cachedBefore} tools/list request(s) for 3 calls`,
  );
  check(
    'a cached catalog is the same catalog, not a refetch',
    first === second && second === third && second.length === 2,
    JSON.stringify(second.map((tool) => tool.name)),
  );

  // `refresh` still overrides the cache: the escape hatch has to work, or a
  // server that did change its catalog could never be re-read.
  const refreshBefore = listCount;
  const refreshed = await cached.listTools({ refresh: true });
  check(
    'refresh: true re-reads even with cacheTools set',
    listCount - refreshBefore === 1 && refreshed.length === 2,
    `${listCount - refreshBefore} tools/list request(s)`,
  );

  // The cache is per client, not module-wide: a second client must not inherit
  // the first one's catalog (it may point at a different server).
  const otherBefore = listCount;
  const other = new McpHttpClient({ url: `${base}/rpc`, cacheTools: true });
  await other.listTools();
  check(
    'the cache does not leak between clients',
    listCount - otherBefore === 1,
    `${listCount - otherBefore} tools/list request(s) for a fresh client`,
  );

  // `callTool` must not be affected by the flag — the cache is about the
  // catalog only, and a cached call would be a wrong answer, not a saving.
  const callBefore = listCount;
  const called = await cached.callTool('echo', { text: 'cached' });
  check(
    'a cached client still calls tools for real',
    called.content?.[0]?.text === 'echo:cached' && listCount === callBefore,
    JSON.stringify(called).slice(0, 120),
  );

  const stateful = new McpHttpClient({ url: `${base}/stateful` });
  await stateful.listTools();
  const statefulList = seen.findLast((entry) => entry.message.method === 'tools/list' && entry.headers['mcp-session-id'] === 'sess-a');
  check('an issued session id is echoed on later requests', statefulList !== undefined, 'tools/list must carry mcp-session-id: sess-a');
  check(
    'each client sends initialized exactly once, after its handshake',
    seen.filter((entry) => entry.message.method === 'notifications/initialized').length === 5,
    'one notification per client handshake (5 clients built above)',
  );
} finally {
  server.close();
}

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${result.name}${result.pass ? '' : ` — ${result.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
