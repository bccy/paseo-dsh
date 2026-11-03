/**
 * Offline check for the bridge's `paseo/goal` read path (DESIGN §1.1).
 *
 * The goal pill's whole value is the field the durable projection deliberately
 * omits: `activation` (armed/disarmed). It lives only in the live process
 * (`dsh-goal`'s `goals` service, `get(agent) -> GoalView | undefined`), so the
 * bridge has to read it from a live agent rather than from the session log. This
 * file drives the real `PaseoHarnessServer` with a recording context and a fake
 * `goals` service — no profile, no model, no child process:
 *
 *   1. **A live goal is passed through verbatim.** Every GoalView field must
 *      survive, `activation` included; a bridge that rebuilt the object and
 *      dropped `activation` would make an `active + disarmed` goal look like it
 *      is still auto-continuing — the silent degradation this RPC exists to end.
 *   2. **No goal answers `{goal:null}`, never an error.** A profile that composes
 *      the goal service but has no current goal is the common case; it must stay
 *      distinct from "this profile has no goal service".
 *   3. **A missing goal service fails loudly with its own wording.** Mapping it
 *      to `{goal:null}` would tell the plugin "there is no goal" when the truth
 *      is "I cannot know" — the plugin turns this message into a terminal
 *      `goal_unavailable` code. A throwing lookup is reported as such, and a
 *      throwing `get()` propagates instead of being swallowed into null.
 *   4. **An unknown / not-yet-opened session keeps `requireSession`'s error and
 *      creates nothing.** The pill polls agents whose bridge session may not be
 *      open; resuming one just to draw a label would take the session log's
 *      write lease (the exact regression `usage()` had).
 *   5. **The method is dispatched.** `handleRequest('paseo/goal', …)` must reach
 *      it: a deleted method body with a live `case` is a regression this repo has
 *      already shipped once (`setPermission`).
 *
 * Usage:
 *
 *   node harness/goal-bridge-check.mjs
 *
 * DSH packages are read from this machine's installation, resolved exactly like
 * `bridge-server-check.mjs`:
 *
 *   DSH_PACKAGES_DIR  the `@deepseek-ai` package directory to resolve from
 *                     (default: this machine's global DSH install)
 *   DSH_INSTALL_DIR   the installation root to anchor resolution at
 *                     (default: two levels above DSH_PACKAGES_DIR)
 *
 * That is a **local** dependency: a machine without a DSH install cannot run it.
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DSH_PACKAGES =
  `${homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`;
const dshPackages = process.env.DSH_PACKAGES_DIR ?? DEFAULT_DSH_PACKAGES;
const dshRoot = process.env.DSH_INSTALL_DIR ?? resolve(dshPackages, '..', '..');
const dshAnchor = join(dshRoot, 'package.json');

const { register } = await import('node:module');
register(`data:text/javascript,${encodeURIComponent(
  `import { createRequire } from 'node:module';
   import { pathToFileURL } from 'node:url';
   const require = createRequire(${JSON.stringify(dshAnchor)});
   export async function resolve(specifier, context, next) {
     if (specifier.startsWith('@deepseek-ai/')) {
       try {
         return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
       } catch {
         /* not a package this install ships: let Node report it */
       }
     }
     return next(specifier, context);
   }`,
)}`);

const serverPath = join(import.meta.dirname, '..', 'dsh-bridge/lib/server.js');
let PaseoHarnessServer;
try {
  ({ PaseoHarnessServer } = await import(pathToFileURL(serverPath).href));
} catch (error) {
  console.error(`could not load ${serverPath} offline.`);
  console.error(`  DSH packages were resolved from ${dshPackages}`);
  console.error(`  (override with DSH_PACKAGES_DIR / DSH_INSTALL_DIR)`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

/**
 * Build a server whose only live agent is the one a test registers.
 *
 * `services` maps a ctx service name to the value `ctx.get` answers; an `Error`
 * value makes the lookup throw. `createSession` is recorded so a test can prove
 * the goal read materialized nothing.
 */
function makeServer(services = {}) {
  const created = [];
  const agents = new Map();
  const ctx = {
    get(name) {
      if (!(name in services)) return undefined;
      const value = services[name];
      if (value instanceof Error) throw value;
      return value;
    },
    on: () => () => {},
    agents: { get: (id) => agents.get(id) },
  };
  const transport = {
    notify() {},
    write() {},
    flush: async () => {},
    request: async () => ({}),
  };
  const server = new PaseoHarnessServer(ctx, transport, {});
  server.createSession = async (sessionId) => {
    created.push(sessionId);
    throw new Error('goal read must not materialize a session');
  };
  return { server, agents, created };
}

/** Register one live agent the way `createSession` leaves the server's tables. */
function liveSession(server, agents, sessionId) {
  const agent = { id: `agent-${sessionId}`, session: { id: sessionId } };
  agents.set(agent.id, agent);
  server.sessions.set(sessionId, { handle: { agent } });
  return agent;
}

/** Frozen historical literal: the shape `dsh-goal`'s `get()` returned when this
 * contract was written (`GoalView`, types.d.ts:74-83). Never derived from the
 * implementation under test. */
const ACTIVE_GOAL = {
  id: 'goal-7f3a',
  revision: 4,
  objective: 'Ship the goal pill read path without touching the jobs pill',
  phase: 'active',
  maxGoalRounds: 10,
  roundsStarted: 2,
  createdAt: 1793670000000,
  updatedAt: 1793670100000,
  activation: 'armed',
};

const BLOCKED_GOAL = {
  ...ACTIVE_GOAL,
  id: 'goal-9c11',
  revision: 6,
  phase: 'blocked',
  blockedReason: { code: 'round-limit', message: 'Goal reached its configured limit of 10 rounds.' },
  roundsStarted: 10,
  activation: 'disarmed',
};

/** A fake `goals` service that records the exact agent it was handed. */
function goalsService(answer) {
  const calls = [];
  return {
    calls,
    service: {
      get(agent) {
        calls.push(agent);
        return typeof answer === 'function' ? answer(agent) : answer;
      },
    },
  };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

console.log('bridge server: paseo/goal read path\n');

// ===== 1. a live goal is passed through verbatim, activation included =====
{
  const fake = goalsService(ACTIVE_GOAL);
  const { server, agents } = makeServer({ goals: fake.service });
  const agent = liveSession(server, agents, 'goal-live-1');
  const out = await server.handleRequest('paseo/goal', { sessionId: 'goal-live-1' });
  check(
    'paseo/goal answers {goal} with the GoalView fields verbatim',
    JSON.stringify(out) === JSON.stringify({ goal: ACTIVE_GOAL }),
    JSON.stringify(out),
  );
  check(
    'the answer carries activation, the process-local field the projection omits',
    out?.goal?.activation === 'armed',
    JSON.stringify(out?.goal?.activation),
  );
  check(
    'the answer has exactly one key (no envelope fields the contract never promised)',
    Object.keys(out ?? {}).join(',') === 'goal',
    JSON.stringify(Object.keys(out ?? {})),
  );
  check(
    'goals.get() receives the exact live agent, not a session or an id',
    fake.calls.length === 1 && fake.calls[0] === agent,
    `${fake.calls.length} call(s), agent match=${fake.calls[0] === agent}`,
  );
}

// ===== 2. blocked reason travels with the view ============================
{
  const fake = goalsService(BLOCKED_GOAL);
  const { server, agents } = makeServer({ goals: fake.service });
  liveSession(server, agents, 'goal-blocked-1');
  const out = await server.handleRequest('paseo/goal', { sessionId: 'goal-blocked-1' });
  check(
    'a blocked goal keeps blockedReason.code and message verbatim',
    out?.goal?.phase === 'blocked'
      && out?.goal?.blockedReason?.code === 'round-limit'
      && out?.goal?.blockedReason?.message === BLOCKED_GOAL.blockedReason.message,
    JSON.stringify(out?.goal),
  );
}

// ===== 3. no current goal is null, not an error ===========================
{
  const fake = goalsService(undefined);
  const { server, agents } = makeServer({ goals: fake.service });
  liveSession(server, agents, 'goal-none-1');
  const out = await server.handleRequest('paseo/goal', { sessionId: 'goal-none-1' });
  check(
    'a live session with no current goal answers {goal:null}',
    JSON.stringify(out) === JSON.stringify({ goal: null }),
    JSON.stringify(out),
  );
  check(
    'the null answer still read the live service (it is not the missing-service path)',
    fake.calls.length === 1,
    `${fake.calls.length} call(s)`,
  );
}

// ===== 4. a missing goal service fails loudly with its own wording ========
{
  const { server, agents } = makeServer({});
  liveSession(server, agents, 'goal-noservice-1');
  const error = await rejection(server.handleRequest('paseo/goal', { sessionId: 'goal-noservice-1' }));
  check(
    'a profile with no goal service rejects instead of answering {goal:null}',
    error instanceof Error,
    error === undefined ? 'resolved (silent no-goal)' : 'rejected',
  );
  check(
    'the missing-service error names the missing service (the plugin maps this text)',
    error instanceof Error && /composes no goal service/.test(error.message),
    error instanceof Error ? error.message : String(error),
  );
}

// ===== 5. a throwing lookup and a throwing read both stay loud ============
{
  const { server, agents } = makeServer({ goals: new Error('goal registry exploded') });
  liveSession(server, agents, 'goal-lookupthrow-1');
  const error = await rejection(server.handleRequest('paseo/goal', { sessionId: 'goal-lookupthrow-1' }));
  check(
    'a throwing goal-service lookup is reported, naming the lookup and the cause',
    error instanceof Error
      && /looking up DSH's goal service failed/.test(error.message)
      && /goal registry exploded/.test(error.message),
    error instanceof Error ? error.message : String(error),
  );
}
{
  const fake = goalsService(() => {
    throw new Error('goal "goal-7f3a" is not live in this registry');
  });
  const { server, agents } = makeServer({ goals: fake.service });
  liveSession(server, agents, 'goal-readthrow-1');
  const error = await rejection(server.handleRequest('paseo/goal', { sessionId: 'goal-readthrow-1' }));
  check(
    'a throwing goals.get() propagates instead of degrading to {goal:null}',
    error instanceof Error && /not live in this registry/.test(error.message),
    error instanceof Error ? error.message : String(error),
  );
}

// ===== 6. an unknown / not-yet-opened session creates nothing =============
{
  const fake = goalsService(ACTIVE_GOAL);
  const { server, created } = makeServer({ goals: fake.service });
  // Paseo initializes a session before prompting it; the bridge's session table
  // is empty until the first prompt. The pill must not turn that into a resume.
  server.initializedSessions.add('goal-cold-1');
  const error = await rejection(server.handleRequest('paseo/goal', { sessionId: 'goal-cold-1' }));
  check(
    "an unopened session keeps requireSession's unknown-session error",
    error instanceof Error && /unknown or not-yet-created session/.test(error.message),
    error instanceof Error ? error.message : String(error),
  );
  check(
    'the goal read materializes no session (no write lease taken)',
    created.length === 0,
    JSON.stringify(created),
  );
  check(
    'the goal read never reaches the service for a session it cannot resolve',
    fake.calls.length === 0,
    `${fake.calls.length} call(s)`,
  );
}
{
  const { server } = makeServer({ goals: goalsService(ACTIVE_GOAL).service });
  const error = await rejection(server.handleRequest('paseo/goal', {}));
  check(
    'a request with no sessionId fails loudly instead of reading some default',
    error instanceof TypeError && /requires a sessionId/.test(error.message),
    error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error),
  );
}

const failedCount = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount === 0 ? 0 : 1);
