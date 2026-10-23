/**
 * Offline check for the MCP gateway's transport resolution.
 *
 * The gateway proxies two transports (Streamable HTTP and stdio) through the same
 * three meta-tools, and it decides which client to build from the config shape:
 * `url` means HTTP, `command` means stdio. Getting that wrong mounts a client that
 * cannot connect, and the failure only surfaces inside a model turn as "the tool
 * call failed" — the slowest place to diagnose it.
 *
 * `Schema.union` cannot enforce the choice on its own: schemastery validates by
 * *matching* a branch, so an entry carrying both keys passes the HTTP branch and
 * keeps the stray `command` as an extra property, and a typo'd key can slip
 * through as well. `transportOf` is therefore the authority, and this check pins
 * its four outcomes so a later "simplification" cannot quietly restore the
 * silent-prefer-one behaviour.
 *
 * Pure module: no DSH profile, no daemon, no child processes.
 *
 * The gateway imports `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`,
 * which live in the DSH install rather than this repo, so the schema module is
 * loaded by absolute path — the same approach `revert-shape-probe.mjs` uses for
 * `dsh-session`. Point `DSH_SCHEMASTER_MJS` elsewhere to check another install.
 *
 * Usage: node harness/mcp-gateway-transport-check.mjs
 */
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const DEFAULT_DSH_PACKAGES =
  `${homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`;
const dshPackages = process.env.DSH_PACKAGES_DIR ?? DEFAULT_DSH_PACKAGES;
const schemasterPath = process.env.DSH_SCHEMASTER_MJS ?? `${dshPackages}/schemastery/lib/index.mjs`;
const toolsPath = `${dshPackages}/dsh-tools/lib/index.js`;
const { default: Schema } = await import(pathToFileURL(schemasterPath).href);

// The gateway imports its two DSH dependencies by bare specifier, so those names
// must resolve to the same modules this script loaded. Register a hook before
// importing the gateway; anything else falls through to Node's normal resolution.
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

const { Config, transportOf } = await import('../dsh-bridge/lib/mcp-gateway.js');

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/** Run `fn` and report whether it threw, without letting the throw escape. */
function outcomeOf(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Validate one server entry through the plugin's real Config, then resolve it. */
function resolve(entry) {
  const parsed = Config({ servers: { probe: entry } });
  return transportOf('probe', parsed.servers.probe);
}

// ---- the two shapes that must work ---------------------------------------
check(
  'an http entry resolves to http',
  resolve({ url: 'http://127.0.0.1:1/mcp' }) === 'http',
  `transportOf -> ${JSON.stringify(outcomeOf(() => resolve({ url: 'http://127.0.0.1:1/mcp' })))}`,
);

check(
  'a stdio entry resolves to stdio',
  resolve({ command: 'node', args: ['bridge.mjs'] }) === 'stdio',
  `transportOf -> ${JSON.stringify(outcomeOf(() => resolve({ command: 'node', args: ['bridge.mjs'] })))}`,
);

check(
  'a stdio entry keeps its args and env through Config',
  (() => {
    const parsed = Config({
      servers: { probe: { command: 'node', args: ['a.mjs'], env: { TOKEN: 't' } } },
    });
    const entry = parsed.servers.probe;
    return JSON.stringify(entry.args) === '["a.mjs"]' && entry.env?.TOKEN === 't';
  })(),
  'args and env survive schema validation',
);

// ---- the shapes that must fail loudly ------------------------------------
check(
  'an entry naming both transports is refused by name',
  (() => {
    const r = outcomeOf(() => resolve({ url: 'http://127.0.0.1:1/mcp', command: 'node' }));
    return /both/.test(r.error ?? '') && /probe/.test(r.error ?? '');
  })(),
  JSON.stringify(outcomeOf(() => resolve({ url: 'http://127.0.0.1:1/mcp', command: 'node' }))),
);

check(
  'an entry naming neither transport is refused',
  (() => {
    const r = outcomeOf(() => resolve({}));
    return r.error !== undefined;
  })(),
  JSON.stringify(outcomeOf(() => resolve({}))),
);

// `.required()` only checks presence, so an empty string reaches `transportOf`.
// This is the case that would otherwise build a client pointed at `""`.
check(
  'an empty url is refused rather than treated as a transport',
  (() => {
    const r = outcomeOf(() => resolve({ url: '' }));
    return r.error !== undefined && /neither/.test(r.error);
  })(),
  JSON.stringify(outcomeOf(() => resolve({ url: '' }))),
);

check(
  'an empty command is refused rather than treated as a transport',
  (() => {
    const r = outcomeOf(() => resolve({ command: '' }));
    return r.error !== undefined && /neither/.test(r.error);
  })(),
  JSON.stringify(outcomeOf(() => resolve({ command: '' }))),
);

// A typo'd key must not be silently accepted as "some server".
check(
  'a typo in the command key does not resolve to a transport',
  (() => {
    const r = outcomeOf(() => resolve({ comand: 'node' }));
    return r.error !== undefined;
  })(),
  JSON.stringify(outcomeOf(() => resolve({ comand: 'node' }))),
);

check(
  'a non-string url is refused at the schema layer',
  (() => {
    const r = outcomeOf(() => resolve({ url: 42 }));
    return r.error !== undefined;
  })(),
  JSON.stringify(outcomeOf(() => resolve({ url: 42 }))),
);

check(
  'a non-object entry is refused by transportOf',
  (() => {
    const r = outcomeOf(() => transportOf('probe', null));
    return r.error !== undefined && /probe/.test(r.error);
  })(),
  JSON.stringify(outcomeOf(() => transportOf('probe', null))),
);

// ---- report --------------------------------------------------------------
let failed = 0;
for (const { name, pass, detail } of results) {
  if (!pass) failed += 1;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `  — ${detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exitCode = 1;
