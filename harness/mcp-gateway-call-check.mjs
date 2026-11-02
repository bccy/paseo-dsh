/**
 * Offline check for the MCP gateway's call-result contract and cancellation
 * forwarding.
 *
 * Two classes of defects live at the `mcp_call_tool` boundary, and neither is
 * visible to the transport-level checks:
 *
 *   - **Result fidelity.** `structuredContent` is a first-class part of an MCP
 *     tool result; a structured-only result used to project to `content: ""`,
 *     i.e. "the call succeeded and produced nothing". A malformed
 *     `CallToolResult` (`content` that is not an array, a non-boolean
 *     `isError`, a task-based result) took the same route. The repository's
 *     failure policy is the opposite: anything the gateway cannot honestly
 *     project must throw with the server and tool named.
 *   - **Cancellation.** DSH requires async tool work to observe or forward
 *     `exec.signal`. The gateway used to drop it, so a cancelled turn kept an
 *     MCP call running and even reported success afterwards.
 *
 * The check drives the real `apply()` registration path against a loopback
 * streamable-HTTP server, so the assertions are on what the model would receive
 * (canonical value + rendered content) and on the HTTP request actually being
 * aborted. `exec.signal` is exercised through the registered tool definition,
 * not through a private helper.
 *
 * Pure module: no DSH profile, no daemon, no model, no network beyond loopback.
 * The gateway imports its DSH packages by bare specifier, so they are mapped
 * from the DSH install the same way `mcp-gateway-guard-check.mjs` does; point
 * `DSH_PACKAGES_DIR` elsewhere to check another install.
 *
 * Usage: node harness/mcp-gateway-call-check.mjs
 */
import { readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DSH_PACKAGES =
  `${homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`;
const dshPackages = process.env.DSH_PACKAGES_DIR ?? DEFAULT_DSH_PACKAGES;
const schemasterPath = process.env.DSH_SCHEMASTER_MJS ?? `${dshPackages}/schemastery/lib/index.mjs`;
const toolsPath = `${dshPackages}/dsh-tools/lib/index.js`;
const subprocessPath = `${dshPackages}/dsh-subprocess/lib/index.js`;
await import(pathToFileURL(schemasterPath).href);

const { register } = await import('node:module');
register(`data:text/javascript,${encodeURIComponent(
  `const map = {
     '@deepseek-ai/schemastery': ${JSON.stringify(pathToFileURL(schemasterPath).href)},
     '@deepseek-ai/dsh-tools': ${JSON.stringify(pathToFileURL(toolsPath).href)},
     '@deepseek-ai/dsh-subprocess': ${JSON.stringify(pathToFileURL(subprocessPath).href)},
   };
   export async function resolve(specifier, context, next) {
     const hit = map[specifier];
     if (hit !== undefined) return { url: hit, shortCircuit: true };
     return next(specifier, context);
   }`,
)}`);

const { apply } = await import('../dsh-bridge/lib/mcp-gateway.js');
const { validateJsonSchemaValue } = await import(pathToFileURL(toolsPath).href);

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/** A one-pixel PNG, base64: a real image block, so the write path runs. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AL0AAAAASUVORK5CYII=';

/** Whether a delayed response was abandoned because the client disconnected. */
let delayedClosedEarly = false;

/** Answer one JSON-RPC POST the way a streamable-HTTP MCP server does. */
function respond(res, message) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(message));
}

/** The catalog the fake server advertises. */
const TOOLS = [
  { name: 'echo', description: 'Echo the text', inputSchema: { type: 'object' } },
  { name: 'shot', description: 'Return a screenshot', inputSchema: { type: 'object' } },
  { name: 'structured', description: 'Return only structured content', inputSchema: { type: 'object' } },
  { name: 'mixed', description: 'Return text plus structured content', inputSchema: { type: 'object' } },
  { name: 'bad_content', description: 'Return a non-array content field', inputSchema: { type: 'object' } },
  { name: 'bad_iserror', description: 'Return a non-boolean isError', inputSchema: { type: 'object' } },
  { name: 'task_result', description: 'Return an MCP task result', inputSchema: { type: 'object' } },
  { name: 'structured_error', description: 'Fail with only structured content', inputSchema: { type: 'object' } },
  { name: 'delayed', description: 'Answer after a delay', inputSchema: { type: 'object' } },
  { name: 'delayed_shot', description: 'Answer with an image after a delay', inputSchema: { type: 'object' } },
];

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const message = JSON.parse(raw);
    if (message.method === 'initialize') {
      respond(res, {
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } },
      });
      return;
    }
    if (message.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (message.method === 'tools/list') {
      respond(res, { jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
      return;
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      // Delayed answers are how cancellation is observed as a client-side event:
      // if the request is actually aborted, the server sees the response socket
      // close before the timer fires.
      if (name === 'delayed' || name === 'delayed_shot') {
        let replied = false;
        const timer = setTimeout(() => {
          replied = true;
          respond(res, {
            jsonrpc: '2.0',
            id: message.id,
            result: name === 'delayed_shot'
              ? { content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }] }
              : { content: [{ type: 'text', text: 'delayed' }] },
          });
        }, 300);
        res.on('close', () => {
          if (!replied) {
            delayedClosedEarly = true;
            clearTimeout(timer);
          }
        });
        return;
      }
      if (name === 'structured') {
        // The shape from the audit: a legal result whose whole answer is the
        // structured payload, with no text fallback at all.
        respond(res, { jsonrpc: '2.0', id: message.id, result: { content: [], structuredContent: { answer: 42 } } });
        return;
      }
      if (name === 'mixed') {
        respond(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'hello' }], structuredContent: { answer: 42 } },
        });
        return;
      }
      if (name === 'bad_content') {
        respond(res, { jsonrpc: '2.0', id: message.id, result: { content: 'hello' } });
        return;
      }
      if (name === 'bad_iserror') {
        respond(res, { jsonrpc: '2.0', id: message.id, result: { content: [], isError: 'true' } });
        return;
      }
      if (name === 'task_result') {
        respond(res, { jsonrpc: '2.0', id: message.id, result: { task: { id: 't1', status: 'working' } } });
        return;
      }
      if (name === 'structured_error') {
        respond(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: { isError: true, content: [], structuredContent: { error: { code: 'browser_no_host' } } },
        });
        return;
      }
      if (name === 'shot') {
        respond(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }] },
        });
        return;
      }
      respond(res, {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `echo:${message.params?.arguments?.text ?? ''}` }] },
      });
      return;
    }
    respond(res, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** Register the gateway's tools on a fake context and return them by name. */
function mountTools(url) {
  const registered = new Map();
  const ctx = {
    tools: { register: (tool) => registered.set(tool.name, tool) },
    effect: () => {},
    get: () => undefined,
  };
  apply(ctx, { servers: { fake: { url } } });
  return registered;
}

/** Run one registered tool's execute and report the outcome, never throwing. */
async function run(tools, name, args, exec = {}) {
  try {
    return { value: await tools.get(name).execute(args, exec) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Every file under `dir`, recursively. */
const filesUnder = (dir) => {
  if (dir === undefined) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
};

let imageDirForCleanup;
try {
  const tools = mountTools(`${base}/rpc`);

  // ── structuredContent: the whole answer must survive ──────────────────────
  const schema = tools.get('mcp_call_tool').output?.schema;
  check(
    'the call output schema carries a structuredContent field',
    schema?.properties?.structuredContent?.type === 'object',
    JSON.stringify(Object.keys(schema?.properties ?? {})),
  );

  const structured = await run(tools, 'mcp_call_tool', { tool: 'structured', arguments: {} });
  check(
    'a structured-only result keeps the structured value instead of becoming empty success',
    structured.value?.structuredContent?.answer === 42 && structured.value?.content === '',
    JSON.stringify(structured.value),
  );
  const structuredRender = structured.value === undefined
    ? ''
    : tools.get('mcp_call_tool').output.render({}, structured.value).map((block) => block.text).join('\n');
  check(
    'with no text, render shows the structured value as JSON',
    /"answer":\s*42/.test(structuredRender),
    JSON.stringify(structuredRender),
  );

  // The declared output schema is what the DSH registry validates the canonical
  // value against; a schema that omits `structuredContent` would reject the very
  // result this fix is about, so it is asserted with the same validator.
  const schemasOk = structured.value === undefined
    ? ['no value to validate']
    : validateJsonSchemaValue(tools.get('mcp_call_tool').output.schema, structured.value, 'value');
  check(
    'the structured result validates against the declared output schema',
    schemasOk.length === 0,
    schemasOk.join('; '),
  );

  const mixed = await run(tools, 'mcp_call_tool', { tool: 'mixed', arguments: {} });
  check(
    'a text-plus-structured result keeps both the text and the structured value',
    mixed.value?.content === 'hello' && mixed.value?.structuredContent?.answer === 42,
    JSON.stringify(mixed.value),
  );
  const mixedRender = mixed.value === undefined
    ? ''
    : tools.get('mcp_call_tool').output.render({}, mixed.value).map((block) => block.text).join('\n');
  check(
    'when text exists, render stays the text (the structured value is canonical data)',
    mixedRender === 'hello',
    JSON.stringify(mixedRender),
  );

  // ── malformed CallToolResult: loud, never "success with no content" ───────
  const badContent = await run(tools, 'mcp_call_tool', { tool: 'bad_content', arguments: {} });
  check(
    'a non-array "content" is a protocol error naming the field',
    badContent.error !== undefined && /"content" must be an array/.test(badContent.error) && /fake\/bad_content/.test(badContent.error),
    badContent.error ?? JSON.stringify(badContent.value),
  );

  const badIsError = await run(tools, 'mcp_call_tool', { tool: 'bad_iserror', arguments: {} });
  check(
    'a non-boolean "isError" is a protocol error naming the field',
    badIsError.error !== undefined && /"isError" must be a boolean/.test(badIsError.error) && /fake\/bad_iserror/.test(badIsError.error),
    badIsError.error ?? JSON.stringify(badIsError.value),
  );

  const taskResult = await run(tools, 'mcp_call_tool', { tool: 'task_result', arguments: {} });
  check(
    'a task-based result is refused loudly instead of becoming empty success',
    taskResult.error !== undefined && /task-based/.test(taskResult.error) && /fake\/task_result/.test(taskResult.error),
    taskResult.error ?? JSON.stringify(taskResult.value),
  );

  const structuredError = await run(tools, 'mcp_call_tool', { tool: 'structured_error', arguments: {} });
  check(
    'a structured-only error keeps its structured reason instead of "(no message)"',
    structuredError.error !== undefined && /browser_no_host/.test(structuredError.error) && /reported an error/.test(structuredError.error),
    structuredError.error ?? JSON.stringify(structuredError.value),
  );

  // ── cancellation: exec.signal must reach the transport ────────────────────
  const inFlight = new AbortController();
  const delayed = run(tools, 'mcp_call_tool', { tool: 'delayed', arguments: {} }, { signal: inFlight.signal });
  setTimeout(() => inFlight.abort(), 40);
  const delayedOutcome = await delayed;
  // The loopback server sees the connection reset on its own event loop; give it
  // a moment before asserting on the close event.
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(
    'cancelling an in-flight call rejects with a cancellation, not a late success',
    delayedOutcome.error !== undefined && /canceled/.test(delayedOutcome.error) && !/timed out/.test(delayedOutcome.error),
    delayedOutcome.error ?? JSON.stringify(delayedOutcome.value),
  );
  check(
    'and the HTTP request really is aborted (the server sees the socket close early)',
    delayedClosedEarly === true,
    `delayedClosedEarly=${delayedClosedEarly}`,
  );

  const afterCancel = await run(tools, 'mcp_call_tool', { tool: 'echo', arguments: { text: 'still-here' } });
  check(
    'the gateway remains usable after a cancelled call',
    afterCancel.value?.content === 'echo:still-here',
    afterCancel.error ?? JSON.stringify(afterCancel.value),
  );

  // Two concurrent calls, only one cancelled: cancellation is caller-scoped,
  // not a property of the shared client.
  const onlyOne = new AbortController();
  const delayedPair = run(tools, 'mcp_call_tool', { tool: 'delayed', arguments: {} }, { signal: onlyOne.signal });
  const echoPair = run(tools, 'mcp_call_tool', { tool: 'echo', arguments: { text: 'pair' } });
  setTimeout(() => onlyOne.abort(), 20);
  const [delayedMember, echoMember] = await Promise.all([delayedPair, echoPair]);
  check(
    'cancelling one of two concurrent calls leaves the other one unaffected',
    delayedMember.error !== undefined && /canceled/.test(delayedMember.error) && echoMember.value?.content === 'echo:pair',
    `delayed=${delayedMember.error ?? 'resolved'} echo=${echoMember.error ?? JSON.stringify(echoMember.value)}`,
  );

  const late = new AbortController();
  const completed = await run(tools, 'mcp_call_tool', { tool: 'echo', arguments: { text: 'late' } }, { signal: late.signal });
  late.abort();
  check(
    'a cancellation after the call has settled does not rewrite its result',
    completed.value?.content === 'echo:late',
    completed.error ?? JSON.stringify(completed.value),
  );

  // A cancelled call must not leave an image behind — the write happens while
  // projecting, so the abort check has to sit in front of it.
  const shot = await run(tools, 'mcp_call_tool', { tool: 'shot', arguments: {} });
  const imageDir = shot.value?.images?.[0]?.path === undefined ? undefined : dirname(shot.value.images[0].path);
  imageDirForCleanup = imageDir;
  const imagesBefore = filesUnder(imageDir).length;
  const imageAbort = new AbortController();
  const delayedShot = run(tools, 'mcp_call_tool', { tool: 'delayed_shot', arguments: {} }, { signal: imageAbort.signal });
  setTimeout(() => imageAbort.abort(), 40);
  const delayedShotOutcome = await delayedShot;
  const imagesAfter = filesUnder(imageDir).length;
  check(
    'a cancelled image-returning call writes no image to disk',
    delayedShotOutcome.error !== undefined && /canceled/.test(delayedShotOutcome.error) && imagesAfter === imagesBefore,
    `${delayedShotOutcome.error ?? 'resolved'}; files ${imagesBefore} -> ${imagesAfter}`,
  );

  // A signal that is already aborted must stop the work before the server is
  // asked anything (the turn may be cancelled before the tool starts).
  const preAborted = new AbortController();
  preAborted.abort();
  const preOutcome = await run(tools, 'mcp_list_tools', {}, { signal: preAborted.signal });
  check(
    'an already-cancelled discovery call is refused before reaching the server',
    preOutcome.error !== undefined && /canceled/.test(preOutcome.error),
    preOutcome.error ?? JSON.stringify(preOutcome.value),
  );
} finally {
  server.close();
  server.closeAllConnections?.();
  if (imageDirForCleanup !== undefined) rmSync(imageDirForCleanup, { recursive: true, force: true });
}

let failed = 0;
for (const { name, pass, detail } of results) {
  if (!pass) failed += 1;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `  — ${detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exitCode = 1;
