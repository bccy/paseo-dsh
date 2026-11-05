/**
 * Behavioural check for the bridge entry's event wiring.
 *
 * `dsh-bridge/lib/index.js` is the only place the DSH tool lifecycle is connected
 * to the rewind machinery:
 *
 *   - `tools/execute`     -> beginFileMutation / captureFileBeforeTool (in that order)
 *   - `tools/post-execute`-> commitFileTool / finishFileMutation
 *   - `tools/result`      -> dropFileTool for failures, then finishFileMutation
 *   - `tools/execute`     -> rememberToolDescription for the jobs pill
 *
 * Every offline rewind harness either drives `PaseoHarnessServer` directly or
 * matches source text, so deleting or reordering any of these listeners left
 * every check green while the product silently stopped snapshotting. This file
 * loads the **real** entry module with a fake context and fake collaborators,
 * registers the hooks exactly as `startBridge` does, and drives them:
 *
 *   - the ticket is taken before the snapshot (order is the mechanism);
 *   - a success path releases no ticket in `execute` and commits + releases in
 *     `post-execute`;
 *   - a throwing snapshot drops the ticket and propagates the error;
 *   - an execution that was never admitted must not run the commit path;
 *   - `rememberToolDescription` runs before the tool executes.
 *
 * No profile, no daemon, no DSH install is needed: `@deepseek-ai/*`, `commander`
 * and the bridge's own sibling modules are resolved to local stubs through a
 * Node module resolve hook. The real file under test is `dsh-bridge/lib/index.js`.
 *
 * Usage: node harness/bridge-entry-check.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const bridgeEntry = join(here, '..', 'dsh-bridge', 'lib', 'index.js');

// The resolve hook runs in Node's module-loader context, whose `globalThis` is
// not the main realm's. Recording calls through a small file keeps the stub and
// the assertions in one process without pretending the realms are shared.
const scratch = mkdtempSync(join(tmpdir(), 'bridge-entry-check-'));
const callLog = join(scratch, 'calls.jsonl');
process.env.BRIDGE_ENTRY_CALL_LOG = callLog;
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** Make a `data:` URL for a CommonJS-free ESM stub. */
function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

const stubs = {
  commander: dataUrl(`
export class Command {
  constructor() { this._action = null; }
  name() { return this; }
  description() { return this; }
  helpOption() { return this; }
  addHelpText() { return this; }
  action(handler) { this._action = handler; return this; }
  parse() { return this; }
}
`),
  schemastery: dataUrl(`
const chain = { default() { return chain; } };
export default { object() { return chain; }, string() { return chain; }, dict() { return chain; } };
`),
  cmdline: dataUrl(`
export function exitOnStdinEnd() {}
export function parseCmdline(ctx, program) { program._action(); }
`),
  transport: dataUrl(`
import { appendFileSync } from 'node:fs';
const log = process.env.BRIDGE_ENTRY_CALL_LOG;
const record = (entry) => { if (log !== undefined && log !== '') appendFileSync(log, JSON.stringify(entry) + '\\n'); };
export class PaseoTransport {
  constructor(stdin, stdout) { this.stdin = stdin; this.stdout = stdout; this.handler = null; }
  onRequest(handler) { this.handler = handler; }
  start() { this.started = true; }
  close() {}
  async flush() {}
  request() { return Promise.resolve({ answers: [] }); }
  notify(method, params) { record({ method: 'transport.notify', call: method, params }); }
}
`),
  approval: dataUrl(`
export function registerApprovalAnswerer() { return () => {}; }
`),
  server: dataUrl(`
import { appendFileSync } from 'node:fs';
const log = process.env.BRIDGE_ENTRY_CALL_LOG;
const calls = [];
const record = (entry) => { calls.push(entry); if (log !== undefined && log !== '') appendFileSync(log, JSON.stringify(entry) + '\\n'); };
export class PaseoHarnessServer {
  constructor(ctx, transport, options) { this.ctx = ctx; this.transport = transport; this.options = options; }
  async beginFileMutation(exec) { record({ method: 'beginFileMutation', label: exec?.__label }); exec.__owned = true; }
  async captureFileBeforeTool(exec) {
    record({ method: 'captureFileBeforeTool', label: exec?.__label });
    if (exec?.__failCapture === true) throw new Error('snapshot failed');
  }
  ownsFileMutation(exec) { return exec?.__owned === true; }
  async commitFileTool(exec, result) { record({ method: 'commitFileTool', label: exec?.__label, result }); }
  dropFileTool(exec) { record({ method: 'dropFileTool', label: exec?.__label }); exec.__owned = false; }
  finishFileMutation(exec) { record({ method: 'finishFileMutation', label: exec?.__label }); exec.__owned = false; }
  rememberToolDescription(exec) { record({ method: 'rememberToolDescription', label: exec?.__label }); }
  settingsNamespaceTracked(ns) { record({ method: 'settingsNamespaceTracked', ns }); return ns === 'exposed'; }
  async handleRequest() { return {}; }
  async shutdown() {}
  owns() { return false; }
}
`),
};

const resolveHook = `
import { pathToFileURL } from 'node:url';
const stubs = ${JSON.stringify(stubs)};
export async function resolve(specifier, context, next) {
  if (specifier === 'commander' || specifier === '@deepseek-ai/schemastery' || specifier === '@deepseek-ai/dsh-cmdline') {
    return { url: stubs[specifier === 'commander' ? 'commander' : specifier === '@deepseek-ai/schemastery' ? 'schemastery' : 'cmdline'], shortCircuit: true };
  }
  const parent = context.parentURL ?? '';
  if (parent.endsWith('/dsh-bridge/lib/index.js')) {
    if (specifier === './transport.js') return { url: stubs.transport, shortCircuit: true };
    if (specifier === './server.js') return { url: stubs.server, shortCircuit: true };
    if (specifier === './approval.js') return { url: stubs.approval, shortCircuit: true };
  }
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(resolveHook)}`);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

function readCalls() {
  try {
    return readFileSync(callLog, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
const scopes = new Map();
const effectDisposers = [];
/** Event listeners the entry registers with `ctx.on`, keyed by event name. */
const eventHandlers = new Map();
/** Deliver one event the way the DSH context would, to every live listener. */
const emit = (event, ...args) => {
  for (const handler of [...(eventHandlers.get(event) ?? [])]) handler(...args);
};
const ctx = {
  get(name) {
    if (name === 'cmdlineArgs') return { get: () => [] };
    if (name === 'appExit') return () => {};
    if (name === 'appReady') return { onReady: () => () => {} };
    if (name === 'loader') return { await: async () => {} };
    return undefined;
  },
  provide() {},
  effect(effect) {
    const disposer = effect();
    if (typeof disposer === 'function') effectDisposers.push(disposer);
    return disposer;
  },
  inject(names, callback) {
    for (const name of names) {
      const handlers = new Map();
      scopes.set(name, handlers);
      callback({
        on(event, handler) {
          handlers.set(event, handler);
          return () => handlers.delete(event);
        },
      });
    }
  },
  on(event, handler) {
    const handlers = eventHandlers.get(event) ?? new Set();
    handlers.add(handler);
    eventHandlers.set(event, handlers);
    return () => handlers.delete(handler);
  },
  root: { fiber: { dispose() {} } },
};

let applyError;
try {
  const entry = await import(pathToFileURL(bridgeEntry).href);
  entry.apply(ctx, {});
} catch (error) {
  applyError = error;
}
check('the real bridge entry loads and registers its hooks', applyError === undefined, applyError?.message);

const fsHandlers = scopes.get('fs');
const toolsHandlers = scopes.get('tools');
check(
  'entry injects the fs and tools services',
  fsHandlers !== undefined && toolsHandlers !== undefined,
  [...scopes.keys()].join(', ') || '(none)',
);
for (const event of ['tools/execute', 'tools/post-execute', 'tools/result']) {
  check(`fs scope registers ${event}`, fsHandlers?.has(event) === true);
}
check('tools scope registers tools/execute', toolsHandlers?.has('tools/execute') === true);

const fsExecute = fsHandlers?.get('tools/execute');
const fsPostExecute = fsHandlers?.get('tools/post-execute');
const fsResult = fsHandlers?.get('tools/result');
const toolsExecute = toolsHandlers?.get('tools/execute');

const reset = () => {
  writeFileSync(callLog, '');
};
const recorded = (label) => readCalls().filter((call) => call.label === label).map((call) => call.method);

// Success path: ticket -> snapshot -> next.
reset();
const order = [];
const exec = { __label: 'success', signal: { throwIfAborted() {} } };
let returned;
let executeError;
try {
  returned = await fsExecute(exec, async () => {
    order.push('next');
    return 'tool-result';
  });
} catch (error) {
  executeError = error;
}
check(
  'tools/execute takes the ticket before snapshotting the file',
  executeError === undefined &&
    JSON.stringify(recorded('success')) === JSON.stringify(['beginFileMutation', 'captureFileBeforeTool']) &&
    order.join(',') === 'next' &&
    returned === 'tool-result',
  `calls=[${recorded('success').join(', ')}] order=[${order.join(', ')}]`,
);

// post-execute: commit then release, and only then continue.
reset();
const postOrder = [];
let postReturned;
let postError;
try {
  postReturned = await fsPostExecute(exec, { ok: true }, async () => {
    postOrder.push('next');
    return 'post-result';
  });
} catch (error) {
  postError = error;
}
check(
  'tools/post-execute commits the snapshot and releases the ticket',
  postError === undefined &&
    JSON.stringify(recorded('success')) === JSON.stringify(['commitFileTool', 'finishFileMutation']) &&
    postOrder.join(',') === 'next' &&
    postReturned === 'post-result',
  `calls=[${recorded('success').join(', ')}] order=[${postOrder.join(', ')}]`,
);

// Failure path: a throwing snapshot must drop the ticket and propagate.
reset();
const failing = { __label: 'capture-fail', __failCapture: true, signal: { throwIfAborted() {} } };
let failureError;
try {
  await fsExecute(failing, async () => {
    throw new Error('next must not run');
  });
} catch (error) {
  failureError = error;
}
check(
  'a failing snapshot drops the ticket and propagates the error',
  failureError?.message === 'snapshot failed' &&
    JSON.stringify(recorded('capture-fail')) ===
      JSON.stringify(['beginFileMutation', 'captureFileBeforeTool', 'dropFileTool', 'finishFileMutation']),
  `calls=[${recorded('capture-fail').join(', ')}] error=${failureError?.message}`,
);

// An execution that never took a ticket must not run the commit path.
reset();
const unowned = { __label: 'unowned' };
const unownedOrder = [];
await fsPostExecute(unowned, {}, async () => {
  unownedOrder.push('next');
});
check(
  'post-execute skips the commit path for an execution that was never admitted',
  recorded('unowned').length === 0 && unownedOrder.join(',') === 'next',
  `calls=[${recorded('unowned').join(', ')}] order=[${unownedOrder.join(', ')}]`,
);

// tools/result: drop when owned (failure/cancel), always release.
reset();
await fsResult({ __label: 'result-owned', __owned: true });
check(
  'tools/result drops an owned ticket before releasing',
  JSON.stringify(recorded('result-owned')) === JSON.stringify(['dropFileTool', 'finishFileMutation']),
  `calls=[${recorded('result-owned').join(', ')}]`,
);
reset();
await fsResult({ __label: 'result-plain' });
check(
  'tools/result still releases a ticket it does not own (idempotent finish)',
  JSON.stringify(recorded('result-plain')) === JSON.stringify(['finishFileMutation']),
  `calls=[${recorded('result-plain').join(', ')}]`,
);

// The jobs pill's description capture happens before the tool runs.
reset();
const toolsOrder = [];
await toolsExecute({ __label: 'tools-exec', arguments: { command: 'ls', description: 'list files' } }, async () => {
  toolsOrder.push('next');
});
check(
  'tools/execute records the bash description before delegating',
  JSON.stringify(recorded('tools-exec')) === JSON.stringify(['rememberToolDescription']) &&
    toolsOrder.join(',') === 'next',
  `calls=[${recorded('tools-exec').join(', ')}] order=[${toolsOrder.join(', ')}]`,
);

// The settings notification wiring: DSH's `settings/document-updated` becomes a
// `paseo/settings/changed` notification for namespaces the composer shows.
const settingsHandler = eventHandlers.get('settings/document-updated');
check(
  'the entry subscribes to settings/document-updated',
  typeof settingsHandler?.size === 'number' && settingsHandler.size === 1,
  `${String(settingsHandler?.size ?? 0)} listener(s)`,
);
reset();
emit('settings/document-updated', 'exposed');
const forwarded = readCalls().filter((call) => call.method === 'transport.notify');
check(
  'an advertised namespace is forwarded as paseo/settings/changed',
  forwarded.length === 1
    && forwarded[0].call === 'paseo/settings/changed'
    && JSON.stringify(forwarded[0].params) === JSON.stringify({ ns: 'exposed' }),
  JSON.stringify(forwarded),
);
reset();
emit('settings/document-updated', 'hidden');
check(
  'a namespace the bridge never advertised is not forwarded',
  readCalls().filter((call) => call.method === 'transport.notify').length === 0,
  JSON.stringify(readCalls()),
);

for (const disposer of effectDisposers.reverse()) {
  try {
    await disposer();
  } catch {
    /* teardown is best-effort */
  }
}

// After the effect teardown the subscription must be gone: a plugin reload that
// left the listener behind would notify a transport that is already closed.
reset();
emit('settings/document-updated', 'exposed');
check(
  'the subscription is removed on teardown (no notify after dispose)',
  readCalls().filter((call) => call.method === 'transport.notify').length === 0
    && (eventHandlers.get('settings/document-updated')?.size ?? 0) === 0,
  JSON.stringify({ calls: readCalls(), listeners: eventHandlers.get('settings/document-updated')?.size ?? 0 }),
);

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
