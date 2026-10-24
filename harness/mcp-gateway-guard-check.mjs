/**
 * Offline check for the MCP gateway's `tool`-argument guard.
 *
 * The gateway forwards `tool` verbatim to an MCP server, and a model that gets
 * the call shape wrong produces an error the *server* writes: "MCP error -32602:
 * Tool mcp_call_tool not found". That names neither the mistake nor the fix, so
 * the model repeats the same call. A live session on 2026-10-20 hit exactly
 * that, twice — once passing a meta-tool name as the target, once folding a
 * whole `mcp_call_tool` into another call's `arguments`:
 *
 *   {"tool":"mcp_call_tool","arguments":{"server":"paseo","tool":"list_providers","arguments":{}}}
 *
 * `resolveTargetTool` rejects those before a request goes out, naming the target
 * and the expected shape. It is module-private, so this check drives the real
 * `apply()` + `defineTool` path instead of the function: a fake `ctx` collects
 * the registered tools, and a loopback MCP server answers the calls that are
 * *supposed* to succeed. Driving the registered tool also proves the guard sits
 * ahead of the network round trip — the rejected cases never reach the server.
 *
 * Pure module: no DSH profile, no daemon, no network beyond loopback.
 *
 * The gateway imports `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`
 * from the DSH install rather than this repo, so those are loaded by absolute
 * path and mapped through a resolve hook — the same approach
 * `mcp-gateway-transport-check.mjs` uses. Point `DSH_PACKAGES_DIR` elsewhere to
 * check another install.
 *
 * Usage: node harness/mcp-gateway-guard-check.mjs
 */
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const DEFAULT_DSH_PACKAGES =
  `${homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`;
const dshPackages = process.env.DSH_PACKAGES_DIR ?? DEFAULT_DSH_PACKAGES;
const schemasterPath = process.env.DSH_SCHEMASTER_MJS ?? `${dshPackages}/schemastery/lib/index.mjs`;
const toolsPath = `${dshPackages}/dsh-tools/lib/index.js`;
await import(pathToFileURL(schemasterPath).href);

const { register } = await import('node:module');
register(`data:text/javascript,${encodeURIComponent(
  `const map = {
     '@deepseek-ai/schemastery': ${JSON.stringify(pathToFileURL(schemasterPath).href)},
     '@deepseek-ai/dsh-tools': ${JSON.stringify(pathToFileURL(toolsPath).href)},
   };
   export async function resolve(specifier, context, next) {
     const hit = map[specifier];
     if (hit !== undefined) return { url: hit, shortCircuit: true };
     return next(specifier, context);
   }`,
)}`);

const { apply } = await import('../dsh-bridge/lib/mcp-gateway.js');

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/** Every method the fake server was asked to run, in order. */
const seen = [];

/** Answer one JSON-RPC POST the way a streamable-HTTP MCP server does. */
function respond(res, message) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(message));
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const message = JSON.parse(raw);
    seen.push(message.method);
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
      respond(res, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'echo', description: 'Echo the text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          ],
        },
      });
      return;
    }
    if (message.method === 'tools/call') {
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
async function run(tools, name, args) {
  try {
    return { value: await tools.get(name).execute(args, {}) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** `tools/list` and `tools/call` requests the fake server saw. */
const listCalls = () => seen.filter((method) => method === 'tools/list').length;
const callCalls = () => seen.filter((method) => method === 'tools/call').length;

try {
  const tools = mountTools(`${base}/rpc`);
  check(
    'the gateway registers its three meta-tools',
    ['mcp_list_tools', 'mcp_tool_schema', 'mcp_call_tool'].every((name) => tools.has(name)),
    [...tools.keys()].join(', '),
  );
  // `archive_subagents` comes from `registerSubagentArchiveTool`, called by the
  // same `apply()`. It lives in this process too, so it is just as invalid a call
  // target as the discovery meta-tools — asserting it here is what keeps the
  // guard's name list honest.
  check(
    'and archive_subagents, which the same plugin registers',
    tools.has('archive_subagents'),
    [...tools.keys()].join(', '),
  );

  // ── the guard outcomes ─────────────────────────────────────────────────────

  // 1. An empty target. `.required()` only checks presence, so `''` reaches the
  //    guard — this is the shape that would otherwise ask the server for "".
  const emptyBefore = listCalls();
  const empty = await run(tools, 'mcp_tool_schema', { tool: '' });
  check(
    'an empty "tool" is refused with the expected shape named',
    /must name the MCP tool to call/.test(empty.error ?? '') && /mcp_list_tools/.test(empty.error ?? ''),
    JSON.stringify(empty),
  );
  check(
    'an empty "tool" never reaches the server',
    listCalls() === emptyBefore,
    `tools/list went from ${emptyBefore} to ${listCalls()}`,
  );

  // Whitespace is the same mistake, so the guard trims before judging.
  const blank = await run(tools, 'mcp_tool_schema', { tool: '   ' });
  check(
    'a whitespace-only "tool" is refused the same way',
    /must name the MCP tool to call/.test(blank.error ?? ''),
    JSON.stringify(blank),
  );

  // 2. A gateway tool name as the target: the server has no such tool, so the
  //    answer it gives ("Tool mcp_call_tool not found") misdescribes the fix.
  //    Every spelling a model realistically produces is covered: the exact name,
  //    upper case, mixed case, a zero-width character inside it (survives
  //    `.trim()`), and the full-width spelling a CJK keyboard emits.
  const REFUSED_SPELLINGS = [
    'mcp_list_tools',
    'mcp_tool_schema',
    'mcp_call_tool',
    'archive_subagents',
    'MCP_CALL_TOOL',
    'Mcp_Call_Tool',
    'ARCHIVE_SUBAGENTS',
    '\u200bmcp_call_tool',
    'mcp_call_tool\u200b',
    '\ufeffmcp_list_tools',
    // Full-width capitals, what an IME can produce for the same name (NFKC folds
    // them back to ASCII, so this is the normalization, not a special case).
    'ＭＣＰ＿ＣＡＬＬ＿ＴＯＯＬ',
  ];
  for (const spelling of REFUSED_SPELLINGS) {
    const before = listCalls();
    const refused = await run(tools, 'mcp_tool_schema', { tool: spelling });
    // The message quotes the *trimmed* target — `trim()` already removes U+FEFF,
    // so a BOM-prefixed spelling is quoted without it. Asserting the raw spelling
    // would fail on the one case where the guard's own trimming is correct.
    check(
      `the gateway tool name ${JSON.stringify(spelling)} is refused as a target`,
      /is one of this gateway's own tools/.test(refused.error ?? '')
        && refused.error.includes(`"${spelling.trim()}"`),
      JSON.stringify(refused),
    );
    check(
      `${JSON.stringify(spelling)} as a target never reaches the server`,
      listCalls() === before,
      `tools/list went from ${before} to ${listCalls()}`,
    );
  }

  // 3. A normal tool name passes and returns the real schema.
  const ok = await run(tools, 'mcp_tool_schema', { tool: 'echo' });
  check(
    'a normal tool name passes the guard and returns its schema',
    ok.value?.name === 'echo' && ok.value?.server === 'fake' && ok.value?.description === 'Echo the text',
    JSON.stringify(ok).slice(0, 200),
  );

  // A padded name is the same tool: trimming is a convenience, not a bypass.
  const padded = await run(tools, 'mcp_tool_schema', { tool: '  echo  ' });
  check(
    'a padded tool name resolves to the same tool',
    padded.value?.name === 'echo',
    JSON.stringify(padded).slice(0, 200),
  );

  // An unknown but well-formed name keeps its own error, distinct from the
  // guard's: the two failures must not collapse into one message.
  const unknown = await run(tools, 'mcp_tool_schema', { tool: 'nope' });
  check(
    'an unknown tool name reports the missing tool, not the guard',
    /exposes no tool "nope"/.test(unknown.error ?? '') && !/gateway's own tool/.test(unknown.error ?? ''),
    JSON.stringify(unknown),
  );

  // 4. The folded call: a whole `mcp_call_tool` passed as another call's
  //    `arguments`. The message must name the nested tool so the model can see
  //    what it actually did.
  const foldedBefore = callCalls();
  const folded = await run(tools, 'mcp_call_tool', {
    tool: 'mcp_call_tool',
    arguments: { server: 'paseo', tool: 'list_providers', arguments: {} },
  });
  check(
    'a call folded into "arguments" is refused and the nested tool is named',
    /is one of this gateway's own tools/.test(folded.error ?? '')
      && /folded another call into "arguments"/.test(folded.error ?? '')
      && /list_providers/.test(folded.error ?? ''),
    JSON.stringify(folded),
  );
  check(
    'a folded call never reaches the server',
    callCalls() === foldedBefore,
    `tools/call went from ${foldedBefore} to ${callCalls()}`,
  );

  // The same name *without* a nested envelope gets the plain message: the
  // "folded" clause is evidence, so it must not appear when there is none.
  const unfolded = await run(tools, 'mcp_call_tool', { tool: 'mcp_call_tool', arguments: { query: 'x' } });
  check(
    'a gateway-tool target without a nested envelope omits the folded clause',
    /is one of this gateway's own tools/.test(unfolded.error ?? '')
      && !/folded another call/.test(unfolded.error ?? ''),
    JSON.stringify(unfolded),
  );

  // The same guard covers the fourth gateway tool, on the call path: it is not a
  // meta-tool, but asking a server for it is the same mistake with the same fix.
  const archivedAsCall = await run(tools, 'mcp_call_tool', { tool: 'archive_subagents', arguments: { scope: 'all' } });
  check(
    'archive_subagents is refused as a call target too',
    /is one of this gateway's own tools/.test(archivedAsCall.error ?? '')
      && /archive_subagents/.test(archivedAsCall.error ?? ''),
    JSON.stringify(archivedAsCall),
  );

  // A normal call still goes through, and the guard's trim is what gets
  // forwarded — a padded name must not be sent to the server verbatim.
  const called = await run(tools, 'mcp_call_tool', { tool: '  echo  ', arguments: { text: 'hi' } });
  check(
    'a normal call passes and the trimmed name is what gets forwarded',
    called.value?.tool === 'echo' && called.value?.content === 'echo:hi',
    JSON.stringify(called).slice(0, 200),
  );

  // An empty target on the call path is refused too, not just on the schema
  // path — the two meta-tools share the guard, so both entry points must hold.
  const emptyCall = await run(tools, 'mcp_call_tool', { tool: '', arguments: {} });
  check(
    'an empty "tool" is refused on the call path as well',
    /must name the MCP tool to call/.test(emptyCall.error ?? ''),
    JSON.stringify(emptyCall),
  );

  // A non-string target never reaches the guard: `defineTool` validates the
  // arguments before `execute` runs, so the rejection comes from the schema, not
  // from `resolveTargetTool`. Asserting the *schema's* wording is what makes this
  // a real assertion — the old form only checked "something threw and no echo
  // came back", which stayed true even if the guard were deleted (the schema
  // still throws), i.e. it could not fail for the defect it claimed to cover.
  for (const bad of [42, null, ['mcp_call_tool'], { name: 'mcp_call_tool' }]) {
    const before = callCalls();
    const nonString = await run(tools, 'mcp_call_tool', { tool: bad, arguments: {} });
    check(
      `a non-string "tool" (${JSON.stringify(bad)}) is rejected by the argument schema`,
      /invalid arguments/.test(nonString.error ?? '') && /"tool" must be a string/.test(nonString.error ?? ''),
      JSON.stringify(nonString),
    );
    check(
      `a non-string "tool" (${JSON.stringify(bad)}) never reaches the server`,
      callCalls() === before,
      `tools/call went from ${before} to ${callCalls()}`,
    );
  }
} finally {
  server.close();
}

let failed = 0;
for (const { name, pass, detail } of results) {
  if (!pass) failed += 1;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `  — ${detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exitCode = 1;
