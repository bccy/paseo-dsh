/**
 * Offline check for the bridge's minimal MCP stdio client.
 *
 * The Paseo MCP gateway (`dsh-bridge/lib/mcp-gateway.js`) reaches its servers
 * through three meta-tools instead of injecting their schemas into every request.
 * `dsh-bridge/lib/mcp-http.js` covers the HTTP servers; `dsh-bridge/lib/mcp-stdio.js`
 * is the mirror for servers that live behind a child process — Paseo's Server
 * Browser bridge is stdio-only and its 25 tool schemas (~20 KB) are exactly the
 * kind of catalog the gateway exists to keep out of the context.
 *
 * A stdio client has failure modes a live session cannot exercise cheaply, and
 * every one of them shows up as "the browser tools do not work" in the middle of
 * a model turn:
 *   - the handshake must precede `tools/*`, and a failed handshake must be
 *     retryable rather than permanently poisoned;
 *   - servers print their own diagnostics to stdout, so a non-JSON line must be
 *     dropped, not treated as a protocol error;
 *   - a request that is never answered has to time out, and one whose process
 *     dies has to be rejected — a hung promise stalls the whole turn;
 *   - `dispose()` has to actually reap the child, or every gateway reload leaks
 *     a browser bridge.
 *
 * This check drives the client against a scripted fake server (a temp .mjs file
 * spawned with `process.execPath`) and asserts the wire traffic it sends as well
 * as the failures it reports.
 *
 * Pure module: no DSH profile, no daemon, no network.
 *
 * Usage: node harness/mcp-stdio-check.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../dsh-bridge/lib/mcp-stdio.js';

/**
 * The scripted server. Kept as one string so the check stays a single file; it is
 * written to a private temp directory and spawned with `process.execPath`, which
 * also means it inherits no module resolution from the repository.
 *
 * Behaviour is keyed by tool name so one process covers every case:
 * `echo` answers, `boom` returns a JSON-RPC error, `hang` never answers, `die`
 * exits mid-request. Every received message is appended to the log file named by
 * argv[2], and every response is preceded by a non-JSON stdout line — the client
 * must tolerate that or the handshake would never complete against a real server.
 */
const FAKE_SERVER = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logPath = process.argv[2];
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + '\\n');
const write = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const noise = () => {
  log({ noise: true });
  process.stdout.write('hello from fake\\n');
};

const tools = [{ name: 'a', description: 'A', inputSchema: { type: 'object' } }];

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    log({ method: '(unparseable)' });
    return;
  }
  log({ method: message.method, id: message.id, params: message.params });
  noise();
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    write({ jsonrpc: '2.0', id: message.id, result: { tools } });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    if (name === 'boom') {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'boom' } });
      return;
    }
    // Never answered: only the client's per-request timer can end this call.
    if (name === 'hang') return;
    // Dies mid-request: in-flight callers must be rejected, never left waiting.
    if (name === 'die') process.exit(0);
    const text = message.params && message.params.arguments && message.params.arguments.text;
    write({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + (text === undefined ? '' : text) }] } });
    return;
  }
  write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + message.method } });
});
// An MCP stdio server exits on EOF; dispose() relies on exactly that.
lines.on('close', () => process.exit(0));
`;

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const tmpDir = join(dirname(fileURLToPath(import.meta.url)), `.tmp-stdio-check-${process.pid}`);
const logPath = join(tmpDir, 'fake-server.log');
const fakeServerPath = join(tmpDir, 'fake-server.mjs');
mkdirSync(tmpDir, { recursive: true });
writeFileSync(logPath, '');
writeFileSync(fakeServerPath, FAKE_SERVER);

/** Every message the fake server received, in arrival order. */
const readLog = () => readFileSync(logPath, 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line));
const methods = () => readLog().filter((entry) => typeof entry.method === 'string').map((entry) => entry.method);
const countOf = (method) => methods().filter((name) => name === method).length;
const lastCall = () => readLog().filter((entry) => entry.method === 'tools/call').at(-1);

/**
 * Settle a promise into an outcome instead of awaiting it, with a ceiling: the
 * whole point of two of these cases is that the client must not hang, and an
 * `await` that never resolves would hang the check instead.
 */
const outcomeOf = (promise, ms = 5_000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ status: 'hung' }), ms);
  promise.then(
    (value) => { clearTimeout(timer); resolve({ status: 'resolved', value }); },
    (error) => { clearTimeout(timer); resolve({ status: 'rejected', error }); },
  );
});

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const clients = [];
const makeClient = (options = {}) => {
  const client = new McpStdioClient({ command: process.execPath, args: [fakeServerPath, logPath], ...options });
  clients.push(client);
  return client;
};

try {
  // ── handshake, catalog, cache, calls: one client, sequential ──────────────
  const client = makeClient();
  const tools = await client.listTools();
  const handshake = methods();
  check(
    'initialize precedes tools/list and notifications/initialized is sent',
    handshake[0] === 'initialize'
      && handshake.includes('notifications/initialized')
      && handshake.indexOf('notifications/initialized') < handshake.indexOf('tools/list'),
    handshake.join(' → '),
  );

  check(
    'listTools returns the server catalog as an array',
    Array.isArray(tools) && tools.length === 1 && tools[0].name === 'a',
    JSON.stringify(tools).slice(0, 160),
  );

  // The default is the contract: `clientFor` in `mcp-gateway.js` passes no
  // `cacheTools` to either transport, so the stdio default has to match the HTTP
  // one — a server must not behave differently depending on which transport it
  // happens to speak. (This half was missing when only the HTTP side was fixed.)
  await client.listTools();
  const afterCached = countOf('tools/list');
  await client.listTools({ refresh: true });
  const afterRefresh = countOf('tools/list');
  check(
    'by default listTools caches until refresh: true',
    afterCached === 1 && afterRefresh === 2,
    `tools/list sent ${afterCached}× on the cached call, ${afterRefresh}× after refresh`,
  );
  check(
    'the stdio cache is on by default, spelled out rather than inferred from counts',
    client.cacheTools === true,
    `cacheTools = ${JSON.stringify(client.cacheTools)}`,
  );

  // `cacheTools: false` is the opt-out, and it has to actually reach the wire:
  // a server whose catalog changes between calls would otherwise be served a
  // stale one for the life of the session.
  const uncachedClient = makeClient({ cacheTools: false });
  const uncachedBefore = countOf('tools/list');
  await uncachedClient.listTools();
  await uncachedClient.listTools();
  await uncachedClient.listTools();
  const uncachedAfter = countOf('tools/list');
  check(
    'with cacheTools: false, every listTools re-reads the catalog',
    uncachedAfter - uncachedBefore === 3,
    `${uncachedAfter - uncachedBefore} tools/list request(s) for 3 calls`,
  );

  const echo = await client.callTool('echo', { text: 'hi' });
  const call = lastCall();
  check(
    'callTool forwards the tool name and arguments verbatim',
    call?.params?.name === 'echo'
      && JSON.stringify(call?.params?.arguments) === JSON.stringify({ text: 'hi' })
      && echo?.content?.[0]?.text === 'echo:hi',
    `params=${JSON.stringify(call?.params)} result=${JSON.stringify(echo).slice(0, 120)}`,
  );

  const boom = await outcomeOf(client.callTool('boom'));
  const boomMessage = boom.error?.message ?? '';
  check(
    'a JSON-RPC error becomes a thrown error naming the server',
    boom.status === 'rejected' && /boom/.test(boomMessage) && /fake-server\.mjs/.test(boomMessage),
    boomMessage,
  );

  // The fake server prints "hello from fake" before every response, so a client
  // that choked on it would have failed the handshake above already; assert the
  // noise really was there and that the connection still answers afterwards.
  const noiseLines = readLog().filter((entry) => entry.noise === true).length;
  const again = await client.callTool('echo', { text: 'again' });
  check(
    'non-JSON stdout lines are ignored instead of breaking the connection',
    noiseLines > 0 && again?.content?.[0]?.text === 'echo:again',
    `${noiseLines} non-JSON line(s) on stdout, later call still answered`,
  );

  // ── a request that is never answered ──────────────────────────────────────
  const hangClient = makeClient({ timeoutMs: 200 });
  const hung = await outcomeOf(hangClient.callTool('hang'));
  check(
    'an unanswered request times out with the budget named',
    hung.status === 'rejected' && /timed out after 200ms/.test(hung.error?.message ?? ''),
    hung.status === 'hung' ? 'the call never settled' : (hung.error?.message ?? ''),
  );

  // ── a server that dies mid-request ────────────────────────────────────────
  const dieClient = makeClient();
  const died = await outcomeOf(dieClient.callTool('die'));
  // The failure is sticky by design: the process is gone, so the next call must
  // reject immediately rather than wait out a timeout or respawn a dead binary.
  // Asserting only the first rejection would pass even if later calls hung.
  const afterDeath = await outcomeOf(dieClient.callTool('echo', { text: 'x' }));
  const diedMessage = died.status === 'hung' ? 'the call never settled' : (died.error?.message ?? '');
  const afterDeathMessage = afterDeath.status === 'hung' ? 'the next call never settled' : (afterDeath.error?.message ?? '');
  check(
    'a server that exits rejects in-flight requests and stays failed',
    died.status === 'rejected' && /exited/.test(diedMessage)
      && afterDeath.status === 'rejected' && /exited/.test(afterDeathMessage),
    `first: ${diedMessage} | next: ${afterDeathMessage}`,
  );

  // ── a catalog cached while the server was alive ───────────────────────────
  // Caching is the default and the reason the gateway exists, but a cache hit
  // sends no request — so nothing on that path would notice the server is gone.
  // `listTools()` would answer from the catalog read before the exit and report
  // "the catalog did not change" for "the connection died", after which the
  // gateway offers tools that cannot be called and the model learns the truth
  // only when its call fails. The health gate has to sit in front of the cache.
  //
  // The cache itself is not this assertion's business: the "caches until
  // refresh: true" case above already fails if the gate is implemented as a
  // refetch, so `tools/list` is only counted for the diagnostic line.
  const staleClient = makeClient();
  const catalogWhileAlive = await staleClient.listTools();
  const listsBeforeDeath = countOf('tools/list');
  await outcomeOf(staleClient.callTool('die'));
  const staleAfterDeath = await outcomeOf(staleClient.listTools());
  const staleMessage = staleAfterDeath.status === 'hung'
    ? 'the call never settled'
    : staleAfterDeath.status === 'resolved'
      ? `stale catalog returned from a dead server: ${JSON.stringify((staleAfterDeath.value ?? []).map((tool) => tool?.name))}`
      : staleAfterDeath.error?.message ?? '';
  check(
    'a cached catalog is not served once the server is dead',
    staleAfterDeath.status === 'rejected'
      && /exited/.test(staleMessage)
      && /fake-server\.mjs/.test(staleMessage)
      && Array.isArray(catalogWhileAlive) && catalogWhileAlive.length === 1,
    `${staleMessage} | tools/list ${listsBeforeDeath} → ${countOf('tools/list')}`,
  );

  // ── teardown ──────────────────────────────────────────────────────────────
  const disposeClient = makeClient();
  await disposeClient.listTools();
  const pid = disposeClient.pid;
  const aliveBefore = typeof pid === 'number' && isAlive(pid);
  await disposeClient.dispose();
  const aliveAfter = isAlive(pid);
  check(
    'dispose stops the child process',
    aliveBefore && !aliveAfter,
    `pid ${pid}: alive before=${aliveBefore}, alive after=${aliveAfter}`,
  );
  // The same gate covers teardown: `dispose()` marks the client disposed and
  // rejects whatever is in flight, so a cache hit afterwards must not answer
  // either — the catalog belongs to a connection that no longer exists.
  const afterDispose = await outcomeOf(disposeClient.listTools());
  const afterDisposeMessage = afterDispose.status === 'hung'
    ? 'the call never settled'
    : afterDispose.status === 'resolved'
      ? `stale catalog returned after dispose: ${JSON.stringify((afterDispose.value ?? []).map((tool) => tool?.name))}`
      : afterDispose.error?.message ?? '';
  check(
    'a disposed client does not answer from the cached catalog',
    afterDispose.status === 'rejected' && /client disposed/.test(afterDisposeMessage),
    afterDisposeMessage,
  );
} catch (error) {
  check('the check itself did not crash', false, error instanceof Error ? error.message : String(error));
} finally {
  for (const client of clients) await client.dispose();
  rmSync(tmpDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${result.name}${result.pass ? '' : ` — ${result.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
