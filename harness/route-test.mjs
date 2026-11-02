/**
 * Route test: find which provider/model routes in a profile actually complete a
 * turn.
 *
 * The route list is read from the profile's own catalog, so nothing here is
 * tied to one machine: every model `dsh --profile <name>` knows about is tried,
 * and the results tell you which ones to point the composer at.
 *
 * This also demonstrates why `assistant/attempt` matters: a route that fails
 * mid-stream reports it there rather than through an error item, so a probe that
 * only watches assistant messages sees silence instead of the reason.
 *
 * Verdicts come from the turn terminal, not from "did any text arrive":
 *
 *   WORKS     turn/end completed and the route produced an answer
 *   FAILS     turn/end error, a failed attempt, or an RPC rejection
 *   TIMEOUT   no turn/end before --turn-timeout-ms
 *   CANCELED  turn/end canceled/aborted
 *   EMPTY     turn completed with no answer text (not a confirmed route)
 *   UNKNOWN   no terminal classification was possible
 *
 * Exit code: 0 only when every route reports WORKS; 1 when any route is not
 * WORKS; 2 when the profile exposes no routes (nothing was measured).
 *
 * Profile isolation: the script clones the profile named by DSH_PASEO_PROFILE
 * (default `paseo`) into a throwaway DSH_HOME, so the live `~/.dsh` is never
 * written. Pass `--allow-real-profile` to use the live home instead. An explicit
 * `DSH_HOME=<dir>` is used as-is. The first output line names the mode.
 *
 * Usage:
 *   node harness/route-test.mjs
 *   DSH_PASEO_PROFILE=my-profile node harness/route-test.mjs
 *   node harness/route-test.mjs --turn-timeout-ms 60000
 *   node harness/route-test.mjs --allow-real-profile   # live ~/.dsh (writes sessions)
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { announceDshHome, prepareDshHome } = require('./isolated-dsh-home.cjs');
const { classifyRouteOutcome, routeExitCode } = require('./harness-gates.cjs');

const PROFILE = process.env.DSH_PASEO_PROFILE ?? 'paseo';
const BINARY = process.env.DSH_BINARY ?? 'dsh';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function argumentOf(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const TURN_TIMEOUT_MS = Number(argumentOf('--turn-timeout-ms', process.env.DSH_ROUTE_TIMEOUT_MS ?? '120000'));

let runMode;
try {
  runMode = prepareDshHome({ script: 'route-test', profile: PROFILE });
} catch (error) {
  console.error(`route-test: ${error.message}`);
  process.exit(2);
}
announceDshHome(runMode);

/** Spawn one bridge process and return JSON-RPC plus a raw event sink. */
function bridge(onEvent, onExit) {
  const child = spawn(BINARY, ['--profile', PROFILE], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;

  const failAll = (error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  };
  child.on('exit', (code) => {
    const error = new Error(`dsh exited ${code ?? 'by signal'} before the request settled`);
    failAll(error);
    onExit?.(error);
  });
  child.on('error', (error) => {
    failAll(error);
    onExit?.(error);
  });

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame.method === 'session.event') onEvent?.(frame.params);
      if (frame.id !== undefined && pending.has(frame.id)) {
        const entry = pending.get(frame.id);
        pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.error) entry.reject(new Error(frame.error.message));
        else entry.resolve(frame.result);
      }
    }
  });
  child.stderr.on('data', () => {});

  return {
    child,
    request: (method, params, timeoutMs = 120000) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      }),
  };
}

/** Every route the profile reports. */
async function listRoutes() {
  const { child, request } = bridge();
  try {
    const catalog = await request('paseo/catalog', {});
    return (catalog.models ?? []).map((model) => ({ provider: model.provider, model: model.id }));
  } finally {
    child.kill();
    await sleep(300);
  }
}

/** Wake every waiter of one route's terminal state. */
function resolveTurnWaiters(state, value) {
  for (const waiter of state.waiters) waiter(value);
  state.waiters.clear();
}

/** Wait for this route's own `turn/end` (not "sleep long enough"). */
function waitForTurnEnd(state, timeoutMs) {
  if (state.turnDone) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiter = (hit) => {
      clearTimeout(timer);
      resolve(hit);
    };
    const timer = setTimeout(() => {
      state.waiters.delete(waiter);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    state.waiters.add(waiter);
  });
}

async function tryRoute({ provider, model }) {
  // One id for both frames. `initialize` pins cwd/route FOR THAT SESSION, and
  // the bridge refuses a prompt from a session it has never initialized — so
  // letting the two calls mint different ids (the pre-multi-session shape,
  // where `initialize` was process-wide) would now fail every route with
  // "paseo bridge is not initialized".
  const sessionId = `route-${provider}-${model}-${Date.now()}`.replace(/[^A-Za-z0-9-]/g, '-');
  const state = {
    attemptText: '',
    durableText: '',
    failure: null,
    turnDone: false,
    turnReason: null,
    waiters: new Set(),
    finished: false,
  };
  const { child, request } = bridge(
    ({ sessionId: eventSessionId, event } = {}) => {
      if (event === undefined) return;
      if (eventSessionId !== undefined && eventSessionId !== sessionId) return;
      // Two shapes carry the answer, and a profile may publish only one of them:
      // `assistant/attempt` (a streaming attempt with its chunk list) and the
      // durable `assistant/message` (the settled message). This probe used to read
      // only the first, so against a profile that emits the durable shape it
      // reported every route as "FAILS … text=\"\"" with no error — a false red,
      // reproduced here with the unmodified bridge as well.
      if (event.type === 'assistant/attempt') {
        for (const record of event.data?.stream ?? []) {
          if (record.type !== 'chunk') continue;
          if (record.chunk?.type === 'text') state.attemptText += record.chunk.text ?? '';
          if (record.chunk?.type === 'finish' && record.chunk.reason?.kind === 'error') {
            state.failure = record.chunk.reason.failure?.message ?? 'error';
          }
        }
      }
      if (event.type === 'assistant/message') {
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') state.durableText += block.text;
        }
      }
      if (event.type === 'turn/end') {
        state.turnDone = true;
        state.turnReason = event.data?.reason?.kind ?? 'unknown';
        if (event.data?.reason?.kind === 'error') {
          state.failure = event.data.reason.error?.message ?? 'error';
        }
        resolveTurnWaiters(state, true);
      }
    },
    (error) => {
      // A dead child is a failed route, not a silent timeout. `turnDone` makes
      // the wait return immediately instead of consuming the whole deadline.
      // Ignore the exit we cause ourselves after the route has been classified.
      if (state.finished) return;
      state.failure ??= error.message;
      state.turnDone = true;
      resolveTurnWaiters(state, true);
    },
  );

  let rpcError = null;
  try {
    await request('initialize', { cwd: process.cwd(), provider, model, sessionId });
    await request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text: 'Reply with exactly: PONG' }],
    });
  } catch (error) {
    rpcError = error.message;
  }
  const timedOut = rpcError === null ? !(await waitForTurnEnd(state, TURN_TIMEOUT_MS)) : false;
  // Mark the observation closed before killing the child: the exit handler must
  // not turn our own cleanup kill into a `failure` on an otherwise good route.
  state.finished = true;
  child.kill();
  await sleep(200);

  const text = state.durableText !== '' ? state.durableText : state.attemptText;
  const outcome = classifyRouteOutcome({
    text,
    failure: state.failure,
    turnEnd: state.turnReason,
    timedOut,
    rpcError,
  });
  return { provider, model, outcome };
}

const routes = await listRoutes();
if (routes.length === 0) {
  console.error(`profile "${PROFILE}" reports no models; check its cordis.patch.yml`);
  process.exit(2);
}
console.log(`profile "${PROFILE}": ${routes.length} route(s)\n`);

const labels = {
  works: 'WORKS ',
  failed: 'FAILS ',
  timeout: 'TIMEOUT',
  canceled: 'CANCELED',
  empty: 'EMPTY ',
  unknown: 'UNKNOWN',
};
const outcomes = [];
for (const route of routes) {
  const { outcome } = await tryRoute(route);
  outcomes.push(outcome);
  console.log(
    `${labels[outcome.status]} ${route.provider}/${route.model}  ` +
      `text=${JSON.stringify(outcome.answer.slice(0, 60))}  err=${outcome.error?.slice(0, 110) ?? '-'}`,
  );
}

const failed = outcomes.filter((outcome) => !outcome.works);
if (failed.length > 0) {
  console.error(
    `\n${failed.length}/${outcomes.length} route(s) did not complete a usable turn ` +
      `(${[...new Set(failed.map((outcome) => outcome.status))].join(', ')})`,
  );
}
process.exit(routeExitCode(outcomes));
