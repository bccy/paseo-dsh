/**
 * Offline check: Paseo's live model / reasoning-effort switch actually reaches
 * DSH on both the 0.2.1 and 0.2.2 model-selection contracts.
 *
 * Why this exists: DSH 0.2.2 changed the model-selection contract.
 * `installModelSelection` lost its second parameter (the caller-owned mutable
 * ref) and now only installs the model-switch notice listener; the step's route
 * is read from the durable `model/selection` projection written by
 * `agent.model.select()`. The bridge kept passing the old ref and kept mutating
 * `control.selection.current`, so on 0.2.2 `paseo/config/set` answered success
 * while the next step still ran on the old model — a silent capability loss
 * (the same class as FIELD-NOTES #58: doctor green, feature gone).
 *
 * What is pinned (each assertion is a way the regression could pass silently):
 *
 *   1. **`paseo/config/set` on a live session calls `agent.model.select`.**
 *      Merely updating `control.selection.current` (the bridge's own mirror,
 *      read by `paseo/usage`) must no longer count as a pass. The recording
 *      agent captures the complete selection object.
 *   2. **Selection fields follow DSH's shape.** `reasoningEffort: null` clears
 *      the effort by OMITTING the key (an explicit `undefined` would be written
 *      as a key by object spread in some paths, and DSH treats absence as
 *      "adapter default"); `maxTokens` never enters the model selection, but it
 *      stays in the bridge's pinned route row.
 *   3. **A rejected `model.select` is not swallowed.** The request must reject,
 *      and neither the in-memory mirror nor the pinned route may be updated —
 *      otherwise the UI/usage would report a switch the agent never took.
 *   4. **`initialize` on an already-live session applies a route change through
 *      `agent.model.select` before writing the route tables.** A reconnect can
 *      re-initialize a live agent with a different route; writing only the
 *      tables is the same silent split-brain.
 *   5. **Both DSH lines are supported.** `installModelSelection.length >= 2`
 *      selects the old 0.2.1 contract (two arguments, caller-owned ref read by
 *      the listeners); otherwise the 0.2.2 single-argument contract is used.
 *      This is a source-level guard: 0.2.2 silently ignores an extra argument,
 *      so no behaviour can distinguish the two calls — only the source shape
 *      can. The check also records that the real installed
 *      `installModelSelection` declares one parameter.
 *   6. **A queued route survives a persisted-session resume.** `config/set`
 *      before the agent exists rewrites `sessionRoutes`; on a later
 *      `agents.resume`, the real `AgentModel` prefers the previous durable
 *      `model/selection`, so `createSession` must pin the queued route through
 *      `agent.model.select()` or the first prompt after reopen still runs the
 *      old model.
 *   7. **The 0.2.1 live path does not require `agent.model`.** With no
 *      `agent.model` the bridge must update only the caller-owned
 *      `control.selection` ref (the installed 0.2.1 listeners read it); it must
 *      not depend on `agent.model.select` existing.
 *
 * No profile, no daemon, no model, no child process. The real
 * `dsh-bridge/lib/server.js` is loaded with a module resolve hook that maps
 * `@deepseek-ai/*` onto this machine's DSH installation, exactly like
 * `bridge-server-check.mjs`.
 *
 * Usage:
 *
 *   node harness/model-route-check.mjs
 *
 *   DSH_PACKAGES_DIR  the `@deepseek-ai` package directory to resolve from
 *                     (default: this machine's global DSH install)
 *   DSH_INSTALL_DIR   the installation root to anchor resolution at
 *                     (default: two levels above DSH_PACKAGES_DIR)
 *
 * That is a **local** dependency: a machine without a DSH install cannot run
 * this check. **动了 `server.js` 的 `installSelection` / `configSet` /
 * `initialize` live 分支或 DSH 升版后必跑。**
 */
import { readFileSync } from 'node:fs';
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
let AgentModel;
let installModelSelection;
try {
  ({ PaseoHarnessServer } = await import(pathToFileURL(serverPath).href));
  ({ AgentModel, installModelSelection } = await import('@deepseek-ai/dsh-agent'));
} catch (error) {
  console.error(`could not load ${serverPath} offline.`);
  console.error(`  DSH packages were resolved from ${dshPackages}`);
  console.error(`  (override with DSH_PACKAGES_DIR / DSH_INSTALL_DIR)`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

/**
 * The same runtime discriminator the bridge uses: 0.2.1 declares two parameters
 * (`installModelSelection(agentCtx, selection)`), 0.2.2 declares one.
 */
const LEGACY_MODEL_SELECTION = installModelSelection.length >= 2;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

/** Minimal recording context, identical in shape to `bridge-server-check.mjs`. */
function makeServer(services = {}) {
  const ctx = {
    get(name) {
      if (!(name in services)) return undefined;
      const value = services[name];
      if (value instanceof Error) throw value;
      return value;
    },
    on: () => () => {},
    agents: { get: () => undefined },
  };
  const transport = {
    notify() {},
    write() {},
    flush: async () => {},
    request: async () => ({}),
  };
  return new PaseoHarnessServer(ctx, transport, {});
}

/** A fake Agent whose only interesting surface is DSH's `agent.model`. */
function recordingAgent(sessionId, { select } = {}) {
  const calls = [];
  const agent = {
    id: `agent-${sessionId}`,
    session: { id: sessionId },
    model: {
      select(selection) {
        calls.push({ ...selection });
        if (select !== undefined) select(selection);
      },
      current() {
        return undefined;
      },
    },
  };
  return { agent, calls };
}

/** Put one already-live session in the bridge's tables, as createSession would. */
function attachLiveSession(server, sessionId, agent, selection) {
  server.ctx.agents = { get: (id) => (id === agent.id ? agent : undefined) };
  server.sessions.set(sessionId, {
    handle: { agent },
    control: { selection: { current: selection }, dispose() {} },
  });
  server.controls.set(sessionId, server.sessions.get(sessionId).control);
  return server.controls.get(sessionId);
}

console.log('bridge server: live model-route switching (DSH 0.2.1/0.2.2 contracts)\n');

// ===== 1. paseo/config/set on a live session reaches agent.model.select =====
{
  const { agent, calls } = recordingAgent('route-1');
  const server = makeServer();
  const control = attachLiveSession(server, 'route-1', agent, {
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'low',
  });
  server.sessionRoutes.set('route-1', {
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'low',
    maxTokens: 4096,
  });

  const out = await server.handleRequest('paseo/config/set', {
    sessionId: 'route-1',
    provider: 'provider-b',
    model: 'model-b',
    reasoningEffort: 'high',
  });

  check(
    'paseo/config/set on a live session calls agent.model.select with the new route',
    calls.length === 1
      && calls[0].provider === 'provider-b'
      && calls[0].model === 'model-b'
      && calls[0].reasoningEffort === 'high',
    JSON.stringify(calls),
  );
  check(
    'the selection handed to agent.model.select carries no maxTokens (not a DSH selection field)',
    calls.length === 1 && !('maxTokens' in calls[0]),
    JSON.stringify(calls[0]),
  );
  check(
    'the request answer reports the applied route',
    out?.provider === 'provider-b' && out?.model === 'model-b' && out?.reasoningEffort === 'high',
    JSON.stringify(out),
  );
  check(
    'the usage mirror follows the applied route',
    control.selection.current?.provider === 'provider-b'
      && control.selection.current?.model === 'model-b'
      && control.selection.current?.reasoningEffort === 'high',
    JSON.stringify(control.selection.current),
  );
  check(
    'the pinned route follows the applied route and keeps maxTokens',
    server.sessionRoutes.get('route-1')?.provider === 'provider-b'
      && server.sessionRoutes.get('route-1')?.model === 'model-b'
      && server.sessionRoutes.get('route-1')?.reasoningEffort === 'high'
      && server.sessionRoutes.get('route-1')?.maxTokens === 4096,
    JSON.stringify(server.sessionRoutes.get('route-1')),
  );
}

// ===== 2. reasoningEffort:null clears; maxTokens never enters the selection ====
{
  const { agent, calls } = recordingAgent('route-2');
  const server = makeServer();
  attachLiveSession(server, 'route-2', agent, {
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'low',
  });
  server.sessionRoutes.set('route-2', {
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'low',
    maxTokens: 2048,
  });

  const out = await server.configSet({ sessionId: 'route-2', reasoningEffort: null });

  check(
    'an explicit reasoningEffort:null reaches agent.model.select as an omitted key',
    calls.length === 1 && !('reasoningEffort' in calls[0]) && calls[0].provider === 'provider-a',
    JSON.stringify(calls),
  );
  check(
    'the pinned route records the clear as null and keeps maxTokens',
    server.sessionRoutes.get('route-2')?.reasoningEffort === null
      && server.sessionRoutes.get('route-2')?.maxTokens === 2048,
    JSON.stringify(server.sessionRoutes.get('route-2')),
  );
  check(
    'the answer reports null for the cleared effort',
    out?.reasoningEffort === null,
    JSON.stringify(out),
  );
}

// ===== 3. a rejected model.select fails loudly and keeps both mirrors =======
{
  const old = { provider: 'provider-a', model: 'model-a', reasoningEffort: 'low' };
  const { agent } = recordingAgent('route-3', {
    select() {
      throw new Error('model route rejected by agent');
    },
  });
  const server = makeServer();
  const control = attachLiveSession(server, 'route-3', agent, { ...old });
  server.sessionRoutes.set('route-3', { ...old, maxTokens: 1024 });

  let thrown;
  let out;
  try {
    out = await server.handleRequest('paseo/config/set', {
      sessionId: 'route-3',
      provider: 'provider-b',
      model: 'model-b',
    });
  } catch (error) {
    thrown = error;
  }

  check(
    'a rejected model.select fails the config/set request (not a fake success)',
    thrown instanceof Error && /model route rejected/.test(thrown.message),
    thrown instanceof Error ? thrown.message : JSON.stringify(out),
  );
  check(
    'a rejected model.select leaves the usage mirror on the old route',
    control.selection.current?.provider === 'provider-a'
      && control.selection.current?.model === 'model-a'
      && control.selection.current?.reasoningEffort === 'low',
    JSON.stringify(control.selection.current),
  );
  check(
    'a rejected model.select leaves the pinned route on the old route',
    server.sessionRoutes.get('route-3')?.provider === 'provider-a'
      && server.sessionRoutes.get('route-3')?.model === 'model-a'
      && server.sessionRoutes.get('route-3')?.maxTokens === 1024,
    JSON.stringify(server.sessionRoutes.get('route-3')),
  );
}

// ===== 4. pre-live sessions keep the queued memory-only semantics ===========
// configSet before the agent exists is documented as a route-table write; there
// is no agent to switch yet, and createSession composes from this row.
{
  const server = makeServer();
  server.sessionRoutes.set('cold-1', {
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'low',
    maxTokens: 512,
  });
  const out = await server.configSet({ sessionId: 'cold-1', model: 'model-b' });
  check(
    'config/set before the agent exists still queues into the pinned route',
    server.sessionRoutes.get('cold-1')?.model === 'model-b'
      && server.sessionRoutes.get('cold-1')?.provider === 'provider-a'
      && server.sessionRoutes.get('cold-1')?.maxTokens === 512
      && out?.model === 'model-b',
    JSON.stringify({ row: server.sessionRoutes.get('cold-1'), out }),
  );
}

// ===== 5. initialize on a live session applies a route change ===============
{
  const { agent, calls } = recordingAgent('init-1');
  const llm = {
    listProviders: () => [{ id: 'provider-a' }, { id: 'provider-b' }],
    resolveCallConfig: async () => ({}),
  };
  const server = makeServer({ llm });
  const control = attachLiveSession(server, 'init-1', agent, {
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'low',
  });

  const out = await server.initialize({
    cwd: process.cwd(),
    sessionId: 'init-1',
    provider: 'provider-a',
    model: 'model-b',
    reasoningEffort: 'high',
  });

  check(
    'initialize on an already-live session applies the route through agent.model.select',
    calls.length === 1
      && calls[0].provider === 'provider-a'
      && calls[0].model === 'model-b'
      && calls[0].reasoningEffort === 'high',
    JSON.stringify(calls),
  );
  check(
    'initialize still answers the route it recorded',
    out?.route?.provider === 'provider-a'
      && out?.route?.model === 'model-b'
      && out?.route?.reasoningEffort === 'high',
    JSON.stringify(out?.route),
  );
  check(
    'initialize updates the usage mirror after the live switch',
    control.selection.current?.model === 'model-b' && control.selection.current?.reasoningEffort === 'high',
    JSON.stringify(control.selection.current),
  );
  check(
    'initialize persists the new route into the pinned row',
    server.sessionRoutes.get('init-1')?.model === 'model-b'
      && server.sessionRoutes.get('init-1')?.reasoningEffort === 'high',
    JSON.stringify(server.sessionRoutes.get('init-1')),
  );
}

// ===== 6. a failed live switch does not write the initialize route tables ===
{
  const { agent } = recordingAgent('init-fail-1', {
    select() {
      throw new Error('live initialize route rejected');
    },
  });
  const llm = {
    listProviders: () => [{ id: 'provider-a' }],
    resolveCallConfig: async () => ({}),
  };
  const server = makeServer({ llm });
  const control = attachLiveSession(server, 'init-fail-1', agent, {
    provider: 'provider-a',
    model: 'model-a',
  });

  let thrown;
  try {
    await server.initialize({
      cwd: process.cwd(),
      sessionId: 'init-fail-1',
      provider: 'provider-a',
      model: 'model-b',
    });
  } catch (error) {
    thrown = error;
  }

  check(
    'a rejected live switch fails initialize loudly',
    thrown instanceof Error && /live initialize route rejected/.test(thrown.message),
    thrown instanceof Error ? thrown.message : 'no throw',
  );
  check(
    'a rejected live switch writes no newly initialized route row',
    server.sessionRoutes.has('init-fail-1') === false
      && server.initializedSessions.has('init-fail-1') === false,
    JSON.stringify({
      route: server.sessionRoutes.get('init-fail-1'),
      initialized: server.initializedSessions.has('init-fail-1'),
    }),
  );
  check(
    'a rejected live switch leaves the usage mirror on the old route',
    control.selection.current?.model === 'model-a',
    JSON.stringify(control.selection.current),
  );
  check(
    'a rejected live switch writes no prompt or cwd side effect',
    server.sessionSystemPrompts.has('init-fail-1') === false && server.sessionCwd.has('init-fail-1') === false,
    JSON.stringify({
      prompt: server.sessionSystemPrompts.get('init-fail-1'),
      cwd: server.sessionCwd.get('init-fail-1'),
    }),
  );
}

// ===== 7. createSession installs the contract-matching listener =============
{
  const events = [];
  const listeners = new Map();
  const agent = { id: 'agent-create-1', session: { id: 'create-1' }, model: { select() {}, current() {} } };
  const server = makeServer();
  server.sessionRoutes.set('create-1', {
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'low',
    maxTokens: undefined,
  });
  server.ctx.agents = {
    create: async (options) => {
      const agentCtx = {
        on: (name, handler) => {
          events.push(name);
          listeners.set(name, handler);
          return () => {};
        },
        get: () => undefined,
      };
      await options.setup(agentCtx, agent);
      return { agent };
    },
    get: (id) => (id === agent.id ? agent : undefined),
  };

  await server.createSession('create-1');
  check(
    'createSession installs the model-switch listener(s) that match the installed contract',
    events.includes('agent/pre-step')
      && (LEGACY_MODEL_SELECTION
        ? events.length === 3 && events.includes('system-prompt/assemble') && events.includes('agent/request')
        : events.length === 1),
    JSON.stringify(events),
  );

  if (LEGACY_MODEL_SELECTION) {
    // Real 0.2.1 `installModelSelection` registers a `system-prompt/assemble`
    // listener that reads `selection.current` immediately. Invoking it is the
    // behavioural proof that `installSelection` passed the caller-owned ref
    // (a single-argument call would throw `Cannot read properties of undefined`).
    const assemble = listeners.get('system-prompt/assemble');
    let assembled;
    let assembleError;
    try {
      assembled = await assemble({}, {}, async () => ({ variables: {} }));
    } catch (error) {
      assembleError = error;
    }
    check(
      'installSelection passed the caller-owned selection ref to the 0.2.1 listener',
      assembleError === undefined
        && assembled?.variables?.provider === 'provider-a'
        && assembled?.variables?.model === 'model-a',
      assembleError instanceof Error ? assembleError.message : JSON.stringify(assembled),
    );
  }

  const source = readFileSync(serverPath, 'utf8');
  check(
    'installModelSelection is arity-gated: 0.2.1 two-arg ref vs 0.2.2 single-arg',
    /installModelSelection\.length\s*>=\s*2/.test(source)
      && /installModelSelection\(agentCtx,\s*control\.selection\)/.test(source)
      && /installModelSelection\(agentCtx\)/.test(source),
    'source-level guard: 0.2.2 silently ignores an extra argument, so the branch shape is only visible in source',
  );
  check(
    `the installed installModelSelection matches the ${LEGACY_MODEL_SELECTION ? '0.2.1' : '0.2.2'} contract`,
    installModelSelection.length === (LEGACY_MODEL_SELECTION ? 2 : 1),
    `Function.length = ${String(installModelSelection.length)}`,
  );
}

// ===== 8. a real AgentModel records the bridge's selection ==================
// The fake above pins the call shape; this one runs the installed DSH class so
// the assertion also covers DSH's own projection contract: `select` appends a
// `model/selection` event, an identical selection is a no-op, and an effort
// clear arrives as an omitted key (not `undefined` spelled as a key).
// 0.2.1 has no AgentModel/agent.model, so the modern blocks are skipped there;
// the legacy contract is covered by block 7's real 0.2.1 listeners and block 10.
if (!LEGACY_MODEL_SELECTION) {
{
  const appended = [];
  const state = { lastUsed: null, pending: null };
  const session = {
    append(type, data) {
      appended.push({ type, data });
      if (type === 'model/selection') state.pending = data;
    },
  };
  const agent = {
    id: 'agent-real-model-1',
    session: { id: 'real-model-1' },
    model: new AgentModel(() => state, session, { provider: 'provider-a', model: 'model-a' }),
  };
  const server = makeServer();
  attachLiveSession(server, 'real-model-1', agent, {
    provider: 'provider-a',
    model: 'model-a',
  });

  await server.configSet({
    sessionId: 'real-model-1',
    provider: 'provider-b',
    model: 'model-b',
    reasoningEffort: 'high',
  });
  check(
    'a real AgentModel records the switch as a model/selection event',
    appended.length === 1
      && appended[0].type === 'model/selection'
      && appended[0].data.provider === 'provider-b'
      && appended[0].data.model === 'model-b'
      && appended[0].data.reasoningEffort === 'high',
    JSON.stringify(appended),
  );

  // The bridge calls select on every config/set; the real class must keep an
  // identical selection from appending a duplicate durable event.
  await server.configSet({
    sessionId: 'real-model-1',
    provider: 'provider-b',
    model: 'model-b',
    reasoningEffort: 'high',
  });
  check(
    'an identical selection is a no-op at the real AgentModel layer',
    appended.length === 1,
    JSON.stringify(appended),
  );

  await server.configSet({ sessionId: 'real-model-1', reasoningEffort: null });
  check(
    'a real AgentModel records the effort clear without a reasoningEffort key',
    appended.length === 2
      && appended[1].data.provider === 'provider-b'
      && appended[1].data.model === 'model-b'
      && !('reasoningEffort' in appended[1].data),
    JSON.stringify(appended[1]?.data),
  );
}

// ===== 9. a queued route survives a persisted-session resume ================
// The real AgentModel prefers the recorded `model/selection` over agentOptions,
// so a session reopened after `config/set` while unmaterialized would otherwise
// run its old persisted model on the first prompt. `createSession` must pin the
// queued route through `agent.model.select(initial)`.
{
  const appended = [];
  const state = {
    lastUsed: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
    pending: null,
  };
  const session = {
    append(type, data) {
      appended.push({ type, data });
      if (type === 'model/selection') state.pending = data;
    },
  };
  const agent = {
    id: 'agent-resume-1',
    session: { id: 'resume-1' },
    model: new AgentModel(() => state, session, {
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high',
    }),
  };
  const server = makeServer();
  // Initialized (route pinned) but never materialized: the live-branch is not
  // available, so `config/set` takes the queued row-writing path.
  server.sessionRoutes.set('resume-1', {
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'high',
    maxTokens: 4096,
  });
  server.initializedSessions.add('resume-1');

  const queued = await server.configSet({ sessionId: 'resume-1', model: 'model-b', reasoningEffort: 'low' });
  check(
    'config/set before materialization rewrites the pinned route',
    server.sessionRoutes.get('resume-1')?.model === 'model-b'
      && server.sessionRoutes.get('resume-1')?.reasoningEffort === 'low'
      && server.sessionRoutes.get('resume-1')?.maxTokens === 4096
      && queued?.model === 'model-b',
    JSON.stringify({ row: server.sessionRoutes.get('resume-1'), queued }),
  );

  let resumeCalls = 0;
  server.ctx.agents = {
    create: async () => {
      throw new Error('session already exists: resume-1');
    },
    resume: async (options) => {
      resumeCalls += 1;
      const agentCtx = { on: () => () => {}, get: () => undefined };
      await options.setup(agentCtx, agent);
      return { agent };
    },
    get: (id) => (id === agent.id ? agent : undefined),
  };

  await server.createSession('resume-1');
  check(
    'createSession takes the resume path for a persisted session',
    resumeCalls === 1,
    `resume called ${resumeCalls} time(s)`,
  );
  check(
    'a queued route overrides the old persisted model/selection on resume',
    appended.length === 1
      && appended[0].type === 'model/selection'
      && appended[0].data.provider === 'provider-a'
      && appended[0].data.model === 'model-b'
      && appended[0].data.reasoningEffort === 'low',
    JSON.stringify(appended),
  );
  check(
    'the resumed real AgentModel now reports the queued route',
    agent.model.current()?.model === 'model-b' && agent.model.current()?.reasoningEffort === 'low',
    JSON.stringify(agent.model.current()),
  );
}

} // end modern-contract-only blocks

// ===== 10. the 0.2.1 live path works without agent.model ====================
// 0.2.1 has no AgentModel/agent.model: the installed two-argument listener
// reads the caller-owned `control.selection` ref. configSet/initialize must
// update that ref and must not depend on `agent.model.select` existing.
{
  const agent = { id: 'agent-legacy-1', session: { id: 'legacy-1' } };
  const llm = {
    listProviders: () => [{ id: 'provider-a' }],
    resolveCallConfig: async () => ({}),
  };
  const server = makeServer({ llm });
  const control = attachLiveSession(server, 'legacy-1', agent, {
    provider: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'low',
  });

  const out = await server.configSet({ sessionId: 'legacy-1', model: 'model-b', reasoningEffort: 'high' });
  check(
    'config/set without agent.model updates the 0.2.1 caller-owned selection ref',
    control.selection.current?.model === 'model-b'
      && control.selection.current?.reasoningEffort === 'high'
      && out?.model === 'model-b',
    JSON.stringify({ ref: control.selection.current, out }),
  );

  await server.initialize({
    cwd: process.cwd(),
    sessionId: 'legacy-1',
    provider: 'provider-a',
    model: 'model-c',
    reasoningEffort: 'low',
  });
  check(
    'initialize without agent.model updates the 0.2.1 caller-owned selection ref',
    control.selection.current?.model === 'model-c'
      && control.selection.current?.reasoningEffort === 'low',
    JSON.stringify(control.selection.current),
  );
}

const failedCount = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount === 0 ? 0 : 1);
