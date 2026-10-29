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
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DSH_PACKAGES =
  `${homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`;
const dshPackages = process.env.DSH_PACKAGES_DIR ?? DEFAULT_DSH_PACKAGES;
const schemasterPath = process.env.DSH_SCHEMASTER_MJS ?? `${dshPackages}/schemastery/lib/index.mjs`;
const toolsPath = `${dshPackages}/dsh-tools/lib/index.js`;
// `mcp-stdio.js` imports the harness's child-environment policy from the DSH
// install (`@deepseek-ai/dsh-subprocess`); at runtime the profile's resolution
// table supplies it, offline it has to be mapped like the other two.
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
const { browserHostGapOf } = await import('../dsh-bridge/lib/mcp-http.js');

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/** Every method the fake server was asked to run, in order. */
const seen = [];
/** Every `tools/call` the fake server received, so arguments can be asserted. */
const calls = [];
/** Whether the `browser_tabs` probe answers as if a host were attached. */
let probeSucceeds = false;

/**
 * A one-pixel PNG, base64. Real image content, so the write path runs exactly as
 * it does for a screenshot rather than being short-circuited by a fake.
 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AL0AAAAASUVORK5CYII=';

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
            { name: 'shot', description: 'Return a screenshot', inputSchema: { type: 'object' } },
            { name: 'shot_error', description: 'Screenshot then fail', inputSchema: { type: 'object' } },
            // The Server Browser bridge's own listing: the browser tools are
            // registered unconditionally, so the listing cannot say whether a host
            // is attached. `browser_tabs` is the name it answers the probe under.
            { name: 'no_result', description: 'Answer with no result', inputSchema: { type: 'object' } },
            { name: 'browser_tabs', description: 'List browser tabs', inputSchema: { type: 'object' } },
            { name: 'browser_click', description: 'Click', inputSchema: { type: 'object' } },
            { name: 'browser_screenshot', description: 'Screenshot', inputSchema: { type: 'object' } },
          ],
        },
      });
      return;
    }
    if (message.method === 'tools/call') {
      calls.push(message);
      const name = message.params?.name;
      // A screenshot-shaped result: real image content, so the gateway's write path
      // runs for real. Used to prove that a model-supplied tool name never becomes
      // part of the file path, and that a failing call writes nothing at all.
      // `{jsonrpc, id}` with neither `result` nor `error`: legal JSON, illegal
      // JSON-RPC. The transport used to hand back `undefined`, which projected to
      // empty content and, with `isError` unset, *succeeded* — a tool call that
      // reported success and produced nothing.
      if (name === 'no_result') {
        respond(res, { jsonrpc: '2.0', id: message.id });
        return;
      }
      if (name === 'browser_tabs') {
        if (probeSucceeds) {
          respond(res, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'Found 1 Paseo browser tab.' }] } });
          return;
        }
        // Verbatim from the installed bridge's `refusal(notRunning)` — the message
        // the gateway has to recognise. `isError` is the protocol-level signal; the
        // sentence is localized and must not be depended on.
        respond(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: '服务器浏览器尚未启动或正在恢复，请在 Paseo「服务器浏览器」面板查看状态后重试。' }],
          },
        });
        return;
      }
      // Any tool the listing advertises as image-returning, plus whatever the
      // traversal case names: the point there is that a *model-chosen* name still
      // gets an image, so the write path runs with that name in hand.
      if (name === 'shot' || name === 'shot_error' || (typeof name === 'string' && name.includes('pwned'))) {
        respond(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            ...(name === 'shot_error' ? { isError: true } : {}),
            content: [
              ...(name === 'shot_error' ? [{ type: 'text', text: 'screenshot taken, then the click failed' }] : []),
              { type: 'image', data: PNG_B64, mimeType: 'image/png' },
            ],
          },
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
    // Invisible characters that survive `.trim()` and are not zero-width, so a
    // blacklist of zero-width spellings let every one of them through: the guard
    // compared the normalized spelling to `mcp_call_tool`, they differed, and the
    // name went to the server, which answered "Tool … not found" — the exact
    // failure the guard exists to replace. LRM/RLM/LRO are the realistic ones
    // (copying a name out of RTL text or a web page brings them along); NBSP and
    // the soft hyphen come from rich-text copy; U+0301 is a combining accent.
    '\u200emcp_call_tool',
    'mcp_call_tool\u200f',
    '\u202dmcp_call_tool',
    'mcp\u00ad_call_tool',
    '\u2060mcp_call_tool',
    'mcp_call_tool\u00a0',
    'mcp_call_too\u0301l',
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
  // ── the image write path ───────────────────────────────────────────────────
  // `mcp_call_tool` writes image content to a file and hands the model a path.
  // The file name used to be built from the *model-supplied* tool name, so
  // `tool: "../../../../tmp/x/evil"` made `path.join` normalize the `..` segments
  // away and the server's base64 landed in a directory of the model's choosing —
  // arbitrary write, in the permission profile where the model is supposed to be
  // read-only. Two independent things have to hold: the name is not part of the
  // path, and the write is confined to the image directory.
  //
  // The second half is `isError`: the write used to happen *before* the error was
  // detected, so a call that reported failure (a screenshot succeeded, the next
  // step failed) still wrote the file — the model could not avoid it by reading
  // the error, because the write had already happened.

  // Where the image directory is, without reaching into the gateway's internals:
  // run one honest call and take the directory it writes to.
  const honest = await run(tools, 'mcp_call_tool', { tool: 'shot', arguments: {} });
  const honestPath = honest.value?.images?.[0]?.path;
  const imageDir = honestPath === undefined ? undefined : dirname(honestPath);
  check(
    'an image result is written to a file and reported by path',
    typeof honestPath === 'string' && existsSync(honestPath) && honest.value.images[0].mimeType === 'image/png',
    JSON.stringify(honest).slice(0, 240),
  );

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

  // A traversing tool name. The escape target is a directory this check owns, so
  // "did it escape" is answerable without touching anything outside it.
  const escapeRoot = mkdtempSync(join(tmpdir(), 'mcp-guard-escape-'));
  const before = new Set(filesUnder(escapeRoot));
  const traversing = `../../../../../../..${escapeRoot}/pwned`;
  const traversed = await run(tools, 'mcp_call_tool', { tool: traversing, arguments: {} });
  const escaped = filesUnder(escapeRoot).filter((file) => !before.has(file));
  check(
    'a tool name containing ".." cannot choose where the image is written',
    escaped.length === 0,
    escaped.length === 0
      ? 'nothing was written outside the image directory'
      : `the server-controlled name escaped the image directory: ${escaped.join(', ')}`,
  );
  // And the call still works: the fix must not turn a legal call into an error.
  check(
    'and the same call still returns the image',
    typeof traversed.value?.images?.[0]?.path === 'string' && existsSync(traversed.value.images[0].path),
    JSON.stringify(traversed).slice(0, 240),
  );
  // The path it did write must be inside the image directory — that is the
  // property, not "no file at the escape target".
  check(
    'the written file is inside the gateway image directory',
    typeof traversed.value?.images?.[0]?.path === 'string'
      && imageDir !== undefined
      && dirname(traversed.value.images[0].path) === imageDir
      && !traversed.value.images[0].path.includes('..'),
    `wrote ${JSON.stringify(traversed.value?.images?.[0]?.path)} (image directory ${JSON.stringify(imageDir)})`,
  );
  rmSync(escapeRoot, { recursive: true, force: true });

  // A failing call that carries an image: the file must not be written at all.
  const imagesBefore = filesUnder(imageDir).length;
  const failedShot = await run(tools, 'mcp_call_tool', { tool: 'shot_error', arguments: {} });
  const imagesAfter = filesUnder(imageDir).length;
  check(
    'a failing call reports the error and names the server text',
    /reported an error/.test(failedShot.error ?? '') && /screenshot taken, then the click failed/.test(failedShot.error ?? ''),
    JSON.stringify(failedShot).slice(0, 240),
  );
  check(
    'a failing call writes no image to disk',
    imagesAfter === imagesBefore,
    `${imagesAfter - imagesBefore} new file(s) in the image directory for a call that reported an error`,
  );

  // A response frame carrying neither `result` nor `error` is a protocol
  // violation. It must not become "the call succeeded with no content": the model
  // would read that as a completed action.
  const noResult = await run(tools, 'mcp_call_tool', { tool: 'no_result', arguments: {} });
  check(
    'a tool call answered with no result is a failure, not empty success',
    noResult.error !== undefined && /no result object/.test(noResult.error),
    noResult.error === undefined
      ? `returned ${JSON.stringify(noResult.value)} — a call that produced nothing reported success`
      : noResult.error,
  );

  // ── the browser host probe ─────────────────────────────────────────────────
  // The probe exists to label browser tools that cannot run, and it got both
  // halves wrong for the stdio bridge: it recognised only two English shapes,
  // while the bridge answers `isError: true` with a localized sentence — so
  // `unavailable` was permanently empty ("a dead probe that looks alive"). And it
  // called `browser_tabs` with `{}`, which the bridge classifies as a *write*
  // (`action !== 'list'`): every `mcp_list_tools` grabbed a write lease, dropped
  // the panel's live input and invalidated its view, then failed anyway because
  // the action was undefined.
  //
  // The probe table is `{name, args}` for exactly that reason, and the fake server
  // records what it received so the read-only shape is asserted on the wire.
  const probeCalls = () => calls.filter((message) => message.params?.name === 'browser_tabs');
  const probeBefore = probeCalls().length;
  const listing = await run(tools, 'mcp_list_tools', {});
  const probes = probeCalls().slice(probeBefore);
  check(
    'the browser probe is sent with the read-only arguments the bridge recognises',
    probes.length === 1
      && JSON.stringify(probes[0].params?.arguments) === JSON.stringify({ action: 'list' }),
    probes.length === 0
      ? 'the probe was never sent, so nothing here proves it is read-only'
      : `arguments=${JSON.stringify(probes.map((message) => message.params?.arguments))} (the bridge treats anything but {action:'list'} as a write)`,
  );
  check(
    'an isError browser probe marks every browser tool unavailable',
    JSON.stringify(listing.value?.unavailable) === JSON.stringify(['browser_tabs', 'browser_click', 'browser_screenshot']),
    listing.error !== undefined
      ? listing.error
      : `unavailable=${JSON.stringify(listing.value?.unavailable)} (a localized isError refusal is still a refusal)`,
  );
  // `unavailable` is a list of tool *names*; the reason lives in the probe result
  // the gateway consumed, so the assertion is on the tool that recognised it —
  // `browserHostGapOf` is the function under test and it is exported.
  check(
    'the localized refusal is recognised as a host gap, not just the English text',
    typeof browserHostGapOf({
      isError: true,
      content: [{ type: 'text', text: '服务器浏览器尚未启动或正在恢复，请在 Paseo「服务器浏览器」面板查看状态后重试。' }],
    }) === 'string',
    'a localized isError refusal must produce a reason; matching only /browser automation host/i left it undefined',
  );
  check(
    'and a successful browser result is still not a host gap (the control)',
    browserHostGapOf({ content: [{ type: 'text', text: 'Found 1 Paseo browser tab.' }] }) === undefined,
    'a working host must not be reported as missing',
  );

  // The control: the same listing with a *successful* probe must label nothing.
  // Without it, a probe that marked everything unavailable unconditionally would
  // pass the assertions above.
  probeSucceeds = true;
  const healthyListing = await run(tools, 'mcp_list_tools', {});
  check(
    'a successful browser probe marks nothing unavailable (the control)',
    JSON.stringify(healthyListing.value?.unavailable) === JSON.stringify([]),
    healthyListing.error !== undefined
      ? healthyListing.error
      : `unavailable=${JSON.stringify(healthyListing.value?.unavailable)} — a probe that never clears is as wrong as one that never fires`,
  );
  probeSucceeds = false;
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
