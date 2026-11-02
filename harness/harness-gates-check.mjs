/**
 * Offline regression for the harness's own judgement gates.
 *
 * Each block pins one audit finding that used to be green on broken behaviour:
 *
 *   T01  route-test treated any text as WORKS and exited 0 with every route
 *        failing. The route-test block runs the **real** script against a
 *        scripted peer: a route that streams a prefix then fails must print
 *        FAILS, a route that never ends must print TIMEOUT, and the mixed sweep
 *        must exit 1; an all-clean sweep must still exit 0 (positive control).
 *   T02  tools.mjs initialized without a session id and then prompted with one,
 *        which the current bridge refuses. The block runs the real script
 *        against the strict scripted bridge and asserts the initialize/prompt
 *        frames carry the same session id and that the process exits promptly
 *        (no 180 s timer keeping it alive).
 *   T03  plugin-check filtered the timeline to assistant rows before checking
 *        adjacency, deleting the interruption that proves fragmentation. The
 *        projection block feeds the shared predicate the full sequence
 *        `assistant A -> reasoning THINK -> assistant AB`: the old
 *        assistant-only fold yields one row, the fixed full fold yields two.
 *   T04  the image check accepted `IMAGE-SEEN` text demanded by the prompt.
 *        The image block shows the old text predicate passing with zero image
 *        blocks, while the structural prompt-frame predicate rejects it.
 *   HP-08 session-calls passed with `no schema` calls. The block builds real
 *        zstd session logs (one without `request/header`, one clean, one with an
 *        undeclared key) and asserts exit 2 / 0 / 1 respectively.
 *
 * No real profile, model or daemon is touched. Run: node harness/harness-gates-check.mjs
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { assistantFragmentation, classifyRouteOutcome, contentBlocksIncludeImage, projectTimelineLikePaseo, routeExitCode, timelineItemsWithTurns } = require('./harness-gates.cjs');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

const scratch = mkdtempSync(join(tmpdir(), 'harness-gates-check-'));
const cleanup = () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
};
process.on('exit', cleanup);

// --------------------------------------------------------------- T01: route-test

console.log('\nT01 route-test outcome gate');
const routeCases = [
  {
    name: 'partial text + fatal turn error',
    observation: { text: 'partial answer', failure: 'fatal turn error', turnEnd: 'error' },
    expected: 'failed',
  },
  { name: 'answer + completed turn', observation: { text: 'PONG', turnEnd: 'completed' }, expected: 'works' },
  { name: 'completed turn without text', observation: { text: '   ', turnEnd: 'completed' }, expected: 'empty' },
  { name: 'no terminal before deadline', observation: { text: 'slow', timedOut: true }, expected: 'timeout' },
  { name: 'canceled turn', observation: { text: 'partial', turnEnd: 'canceled' }, expected: 'canceled' },
];
for (const routeCase of routeCases) {
  const outcome = classifyRouteOutcome(routeCase.observation);
  check(
    `route classification: ${routeCase.name} -> ${routeCase.expected}`,
    outcome.status === routeCase.expected,
    `got ${outcome.status}`,
  );
}
// The old predicate, reproduced exactly: any text means WORKS. It passes the two
// cases that must fail, which is the bug this gate exists to catch.
const oldPredicate = (observation) => (observation.text?.trim() ? 'works' : 'failed');
check(
  'old text-only predicate is green on the exact failing case (regression witness)',
  oldPredicate(routeCases[0].observation) === 'works' &&
    oldPredicate(routeCases[1].observation) === 'works',
  'old predicate: "partial answer" -> works',
);
check(
  'route exit code: all routes working -> 0',
  routeExitCode([{ works: true }, { works: true }]) === 0,
  String(routeExitCode([{ works: true }, { works: true }])),
);
check(
  'route exit code: one failing route -> 1',
  routeExitCode([{ works: true }, { works: false }]) === 1,
  String(routeExitCode([{ works: true }, { works: false }])),
);
check('route exit code: empty sweep -> 2', routeExitCode([]) === 2, String(routeExitCode([])));

// Run the real script against a scripted peer. The peer's routes are selected by
// `ROUTE_FAKE_SET` so the same file serves the mixed and all-clean controls.
const routePeer = join(scratch, 'route-peer.mjs');
writeFileSync(
  routePeer,
  `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const set = process.env.ROUTE_FAKE_SET ?? 'mixed';
const routes = set === 'clean'
  ? [{ provider: 'p', id: 'clean' }]
  : [{ provider: 'p', id: 'partial-fail' }, { provider: 'p', id: 'clean' }, { provider: 'p', id: 'timeout' }];
const models = new Map();
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const notify = (sessionId, event) => send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event } });
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'paseo/catalog') {
    send({ jsonrpc: '2.0', id: frame.id, result: { models: routes, defaultProvider: 'p', defaultModel: 'clean' } });
    return;
  }
  if (frame.method === 'initialize') {
    models.set(frame.params.sessionId, frame.params.model);
    send({ jsonrpc: '2.0', id: frame.id, result: { serverInfo: { name: 'route-peer', version: '0' }, route: { provider: 'p', model: frame.params.model, reasoningEffort: null } } });
    return;
  }
  if (frame.method === 'session/prompt') {
    const sessionId = frame.params.sessionId;
    const model = models.get(sessionId);
    if (model === 'partial-fail') {
      setTimeout(() => {
        notify(sessionId, { type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: { type: 'text', text: 'partial answer' } }] } });
        notify(sessionId, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'fatal turn error' } } } });
      }, 20);
    } else if (model === 'clean') {
      setTimeout(() => {
        notify(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'PONG' }] } } });
        notify(sessionId, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      }, 20);
    } else {
      setTimeout(() => {
        notify(sessionId, { type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: { type: 'text', text: 'slow' } }] } });
      }, 20);
    }
    send({ jsonrpc: '2.0', id: frame.id, result: { messageId: 'm-' + model } });
    return;
  }
  if (frame.id !== undefined) send({ jsonrpc: '2.0', id: frame.id, result: {} });
});
`,
);
chmodSync(routePeer, 0o755);

function runRouteTest(set) {
  const home = mkdtempSync(join(scratch, `route-home-${set}-`));
  const started = Date.now();
  const run = spawnSync(process.execPath, [join(here, 'route-test.mjs'), '--turn-timeout-ms', '400'], {
    cwd: join(here, '..'),
    env: { ...process.env, DSH_HOME: home, DSH_BINARY: routePeer, ROUTE_FAKE_SET: set },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { ...run, elapsed: Date.now() - started };
}

const mixed = runRouteTest('mixed');
const mixedOut = `${mixed.stdout ?? ''}${mixed.stderr ?? ''}`;
check(
  'real route-test: a routed turn with partial text + fatal error is FAILS, not WORKS',
  mixed.status === 1 &&
    /FAILS\s+p\/partial-fail/.test(mixed.stdout ?? '') &&
    !/WORKS\s+p\/partial-fail/.test(mixed.stdout ?? ''),
  `exit=${mixed.status} partial-line=${(mixed.stdout ?? '').split('\n').find((line) => line.includes('partial-fail'))}`,
);
check(
  'real route-test: a route without turn/end is TIMEOUT',
  /TIMEOUT\s+p\/timeout/.test(mixed.stdout ?? ''),
  (mixed.stdout ?? '').split('\n').find((line) => line.includes('timeout')),
);
check(
  'real route-test: all-failing sweep exits non-zero (1)',
  mixed.status === 1,
  `exit=${mixed.status} elapsed=${mixed.elapsed}ms`,
);
const clean = runRouteTest('clean');
check(
  'real route-test: all-clean control still exits 0',
  clean.status === 0 && /WORKS\s+p\/clean/.test(clean.stdout ?? ''),
  `exit=${clean.status} elapsed=${clean.elapsed}ms`,
);

// --------------------------------------------------------------- T02: tools.mjs

console.log('\nT02 tools.mjs protocol sequence and timers');
const toolsHome = mkdtempSync(join(scratch, 'tools-home-'));
const toolsOut = join(toolsHome, 'frames.jsonl');
const toolsRequestLog = join(toolsHome, 'requests.jsonl');
const fakeBridge = join(here, 'fake-dsh-bridge.mjs');
const toolsStarted = Date.now();
const toolsRun = spawnSync(process.execPath, [join(here, 'tools.mjs'), '--wait-ms', '300', '--out', toolsOut], {
  cwd: join(here, '..'),
  env: {
    ...process.env,
    DSH_HOME: toolsHome,
    DSH_BINARY: fakeBridge,
    DSH_FAKE_MODE: 'live',
    // The probe dumps the frames it receives; the scripted bridge records the
    // frames it was sent. T02 is about the request shape, so read the latter.
    DSH_FAKE_LOG: toolsRequestLog,
  },
  encoding: 'utf8',
  timeout: 20000,
});
const toolsElapsed = Date.now() - toolsStarted;
const requests = existsSync(toolsRequestLog)
  ? readFileSync(toolsRequestLog, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean)
  : [];
const initializeFrame = requests.find((frame) => frame.method === 'initialize');
const promptFrame = requests.find((frame) => frame.method === 'session/prompt');
check(
  'real tools.mjs finishes with exit 0 against the strict per-session bridge',
  toolsRun.status === 0,
  `exit=${toolsRun.status} elapsed=${toolsElapsed}ms ${((toolsRun.stderr ?? '').trim().split('\n').at(-1) ?? '').slice(0, 120)}`,
);
check(
  'real tools.mjs initialize carries the same sessionId as its prompt',
  typeof initializeFrame?.params?.sessionId === 'string' &&
    initializeFrame.params.sessionId !== '' &&
    initializeFrame.params.sessionId === promptFrame?.params?.sessionId,
  `initialize=${JSON.stringify(initializeFrame?.params?.sessionId)} prompt=${JSON.stringify(promptFrame?.params?.sessionId)}`,
);
check(
  'real tools.mjs exits promptly (no uncleaned 180 s request timer)',
  toolsElapsed < 15000,
  `${toolsElapsed} ms`,
);

// --------------------------------------------------------------- T03: projection

console.log('\nT03 complete-timeline adjacency');
const fullSequence = [
  { type: 'session.turn', state: 'started', turnId: 'turn:t1' },
  { type: 'timeline.item', sessionId: 's1', item: { id: 'a', type: 'assistant_message', messageId: 'm1', text: 'A' } },
  { type: 'timeline.item', sessionId: 's1', item: { id: 'r', type: 'reasoning', text: 'THINK' } },
  { type: 'timeline.item', sessionId: 's1', item: { id: 'a', type: 'assistant_message', messageId: 'm1', text: 'AB' } },
];
const itemsWithTurns = timelineItemsWithTurns(fullSequence);
const fixed = assistantFragmentation(itemsWithTurns);
const oldAssistantOnly = projectTimelineLikePaseo(
  itemsWithTurns.filter((item) => item.type === 'assistant_message'),
);
check(
  'full sequence: reasoning between assistant snapshots fragments the step',
  fixed.assistantIds.length === 1 && fixed.fragmented.length === 1,
  `ids=${fixed.assistantIds.join(',')} fragmented=${fixed.fragmented.join(',')}`,
);
check(
  'old assistant-only filter hides the same fragmentation (regression witness)',
  oldAssistantOnly.filter((row) => row.type === 'assistant_message').length === 1,
  `${oldAssistantOnly.filter((row) => row.type === 'assistant_message').length} projected row(s)`,
);
// A tool row carries no text; it must still be a row, or it would silently
// stop breaking adjacency (the original helper dropped empty-delta items).
const toolBreak = assistantFragmentation(
  timelineItemsWithTurns([
    { type: 'session.turn', state: 'started', turnId: 'turn:t1' },
    { type: 'timeline.item', item: { id: 'a', type: 'assistant_message', messageId: 'm1', text: 'A' } },
    { type: 'timeline.item', item: { id: 'tool-1', type: 'tool_call', name: 'bash', detail: { command: 'ls' } } },
    { type: 'timeline.item', item: { id: 'a', type: 'assistant_message', messageId: 'm1', text: 'AB' } },
  ]),
);
check(
  'a text-less tool row still breaks assistant adjacency',
  toolBreak.fragmented.length === 1,
  `fragmented=${toolBreak.fragmented.join(',') || '(none)'} rows=${toolBreak.rows.map((row) => row.type).join(',')}`,
);
const adjacent = assistantFragmentation(
  timelineItemsWithTurns([
    { type: 'session.turn', state: 'started', turnId: 'turn:t1' },
    { type: 'timeline.item', item: { id: 'a', type: 'assistant_message', messageId: 'm1', text: 'A' } },
    { type: 'timeline.item', item: { id: 'a', type: 'assistant_message', messageId: 'm1', text: 'AB' } },
  ]),
);
check(
  'adjacent same-id snapshots still fold to exactly one row (positive control)',
  adjacent.fragmented.length === 0,
  `fragmented=${adjacent.fragmented.join(',') || '(none)'}`,
);
const acrossTurns = assistantFragmentation(
  timelineItemsWithTurns([
    { type: 'session.turn', state: 'started', turnId: 'turn:t1' },
    { type: 'timeline.item', item: { id: 'a', type: 'assistant_message', messageId: 'm1', text: 'A' } },
    { type: 'session.turn', state: 'started', turnId: 'turn:t2' },
    { type: 'timeline.item', item: { id: 'a', type: 'assistant_message', messageId: 'm1', text: 'AB' } },
  ]),
);
check(
  'the same messageId in different turns does not merge into one row',
  acrossTurns.fragmented.length === 1,
  `fragmented=${acrossTurns.fragmented.join(',') || '(none)'}`,
);

// --------------------------------------------------------------- T04: image evidence

console.log('\nT04 image evidence');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const promptOnly = [{ type: 'text', text: 'IMAGE-SEEN' }];
check(
  'old text predicate is green on zero image blocks (regression witness)',
  /image|图片|图像|视觉|visual|text only|text-only|attachment/i.test(JSON.stringify(promptOnly)),
  'text "IMAGE-SEEN" matches the old regex',
);
check(
  'structured predicate rejects a text placeholder even when it says IMAGE-SEEN',
  contentBlocksIncludeImage(promptOnly, png, 'image/png') === false,
);
check(
  'structured predicate accepts the exact image block bytes and media type',
  contentBlocksIncludeImage([{ type: 'text', text: 'describe' }, { type: 'image', data: png, mimeType: 'image/png' }], png, 'image/png') === true,
);

// --------------------------------------------------------------- HP-08 session-calls

console.log('\nHP-08 session-calls fail-closed');
const sessionCalls = join(here, 'session-calls.mjs');
const HEADER = {
  type: 'request/header',
  seq: 0,
  data: { header: { tools: [{ name: 'tool_a', parameters: { type: 'object', properties: { text: { type: 'string' } } } }] } },
};
function makeSessionHome(label, events) {
  const home = mkdtempSync(join(scratch, `session-calls-${label}-`));
  const dir = join(home, 'sessions', label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`)));
  return home;
}
function runSessionCalls(home) {
  return spawnSync(process.execPath, [sessionCalls, '--latest'], {
    cwd: join(here, '..'),
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 20000,
  });
}
const noSchema = makeSessionHome('noschema', [
  { type: 'tool/call', seq: 1, data: { name: 'tool_a', arguments: { text: 'hi', bogus: 1 } } },
]);
const cleanSchema = makeSessionHome('clean', [
  HEADER,
  { type: 'tool/call', seq: 1, data: { name: 'tool_a', arguments: { text: 'hi' } } },
]);
const badSchema = makeSessionHome('bad', [
  HEADER,
  { type: 'tool/call', seq: 1, data: { name: 'tool_a', arguments: { text: 'hi', bogus: 1 } } },
  { type: 'tool/call', seq: 2, data: { name: 'tool_a', arguments: { text: 'hello' } } },
]);
const noSchemaRun = runSessionCalls(noSchema);
check(
  'session-calls exits 2 when no request/header schema exists (gate cannot pass unchecked)',
  noSchemaRun.status === 2,
  `exit=${noSchemaRun.status} ${(noSchemaRun.stderr ?? '').trim().split('\n').at(-1)}`,
);
const cleanRun = runSessionCalls(cleanSchema);
check(
  'session-calls exits 0 when every call is checked and clean (positive control)',
  cleanRun.status === 0,
  `exit=${cleanRun.status}`,
);
const badRun = runSessionCalls(badSchema);
check(
  'session-calls exits 1 when a call carries an undeclared key',
  badRun.status === 1,
  `exit=${badRun.status} ${(badRun.stderr ?? '').trim().split('\n').at(-1)}`,
);

// --------------------------------------------------------------- profile isolation

console.log('\nHP-05 throwaway DSH_HOME');
const isolateHelper = join(here, 'isolated-dsh-home.cjs');
const sourceHome = mkdtempSync(join(scratch, 'source-home-'));
mkdirSync(join(sourceHome, 'profiles', 'paseo'), { recursive: true });
writeFileSync(join(sourceHome, 'profiles', 'paseo', 'cordis.patch.yml'), '[]\n');
writeFileSync(join(sourceHome, '.credentials.yaml'), 'canary: not-a-real-credential\n');
const isolateProbe = `
const helper = require(${JSON.stringify(isolateHelper)});
const mode = helper.prepareDshHome({ script: 'probe', profile: 'paseo', argv: [], env: { DSH_HOME_SOURCE: ${JSON.stringify(sourceHome)} } });
const fs = require('node:fs');
const path = require('node:path');
const result = {
  mode: mode.mode,
  home: mode.home,
  differsFromSource: path.resolve(mode.home) !== path.resolve(${JSON.stringify(sourceHome)}),
  profileCopied: fs.existsSync(path.join(mode.home, 'profiles', 'paseo', 'cordis.patch.yml')),
  credentialsLinked: fs.lstatSync(path.join(mode.home, '.credentials.yaml')).isSymbolicLink() === true,
  credentialsTarget: fs.readlinkSync(path.join(mode.home, '.credentials.yaml')),
};
mode.cleanup();
result.removedAfterCleanup = !fs.existsSync(result.home);
process.stdout.write(JSON.stringify(result));
`;
const isolationEnv = { ...process.env };
delete isolationEnv.DSH_HOME;
const isolateRun = spawnSync(process.execPath, ['-e', isolateProbe], {
  env: isolationEnv,
  encoding: 'utf8',
  timeout: 20000,
});
let isolate;
try {
  isolate = JSON.parse(isolateRun.stdout ?? '{}');
} catch {
  isolate = {};
}
check(
  'default real-profile scripts get a throwaway DSH_HOME, not ~/.dsh',
  isolate.mode === 'isolated' && isolate.differsFromSource === true,
  `mode=${isolate.mode} home=${isolate.home}`,
);
check(
  'the cloned home carries the profile and links (not copies) the credentials',
  isolate.profileCopied === true && isolate.credentialsLinked === true,
  `target=${isolate.credentialsTarget}`,
);
check('the throwaway home is removed by cleanup()', isolate.removedAfterCleanup === true);

const allowRealProbe = `
const helper = require(${JSON.stringify(isolateHelper)});
const mode = helper.prepareDshHome({ script: 'probe', profile: 'paseo', argv: ['--allow-real-profile'], env: { DSH_HOME_SOURCE: ${JSON.stringify(sourceHome)} } });
process.stdout.write(JSON.stringify({ mode: mode.mode, home: mode.home }));
`;
const allowReal = spawnSync(process.execPath, ['-e', allowRealProbe], { env: isolationEnv, encoding: 'utf8', timeout: 20000 });
check(
  '--allow-real-profile opts into the live home explicitly',
  JSON.parse(allowReal.stdout ?? '{}').mode === 'real',
  allowReal.stdout,
);

// --------------------------------------------------------------- wiring assertions
// --------------------------------------------------------------- wiring assertions

console.log('\nwiring');
const routeSource = readFileSync(join(here, 'route-test.mjs'), 'utf8');
const pluginCheckSource = readFileSync(join(here, 'plugin-check.cjs'), 'utf8');
check('route-test.mjs uses the shared outcome classifier', routeSource.includes('classifyRouteOutcome('));
check(
  'plugin-check.cjs uses the complete-timeline predicate',
  pluginCheckSource.includes('gates.assistantFragmentation('),
);
check(
  'plugin-check.cjs uses the structural prompt-frame image predicate',
  pluginCheckSource.includes('countPromptFramesWithImage(') && pluginCheckSource.includes('toDshContent('),
);
const isolatedScripts = ['plugin-check.cjs', 'route-test.mjs', 'tools.mjs', 'stream-probe.mjs', 'rewind-e2e.mjs', 'rewind-merge-e2e.mjs'];
for (const script of isolatedScripts) {
  const source = readFileSync(join(here, script), 'utf8');
  check(`${script} prepares an isolated DSH_HOME`, source.includes('prepareDshHome('));
}
const nativeSource = readFileSync(join(here, 'rewind-native-check.mjs'), 'utf8');
check(
  'rewind-native-check.mjs requires an explicit real-daemon acknowledgement',
  nativeSource.includes('--allow-real-daemon'),
);

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
