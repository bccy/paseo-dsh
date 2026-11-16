/**
 * Paseo 0.16 child close must preserve the last failed/canceled turn.
 * Uses the real host provider adapter and a protocol-only fake connection.
 * No daemon, profile or model. Requires PASEO_CLI_ROOT with @getpaseo/server.
 * This host-dependent check is intentionally outside the portable CI suite.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PASEO_CLI_ROOT;
if (!root) { console.error('INCOMPLETE: set PASEO_CLI_ROOT to a Paseo 0.16 installation'); process.exit(2); }
const { PluginAgentClientRegistry } = await import(pathToFileURL(join(root, 'node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js')).href);
const logger = { child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
let listener;
let parentId;
const emit = (event) => listener(event);
const registry = new PluginAgentClientRegistry(logger);
registry.replace([{
  id: 'fixture', label: 'Fixture',
  async connect(request) {
    return {
      version: request.versions[0],
      capabilities: request.capabilities.filter((x) => x === 'session.subsession'),
      onEvent(fn) { listener = fn; return () => { listener = () => {}; }; },
      async send(input) {
        if (input.type === 'session.open') {
          parentId = input.sessionId;
          emit({ type: 'session.opened', sessionId: parentId, requestId: input.requestId,
            capabilities: ['session.subsession'], restoration: 'core', cwd: input.config.cwd });
          emit({ type: 'session.ready', sessionId: parentId, requestId: input.requestId });
        } else if (input.type === 'session.close') emit({ type: 'session.closed', sessionId: input.sessionId });
        else throw new Error(`unexpected request ${input.type}`);
      },
      async close() {},
    };
  },
}]);
try {
  const session = await registry.clients().fixture.createSession({ provider: 'fixture', cwd: '/fixture', modeId: 'build' }, { env: {} });
  const events = [];
  session.subscribe((event) => events.push(event));
  for (const outcome of ['canceled', 'failed', 'completed']) {
    const id = `child-${outcome}`;
    emit({ type: 'session.opened', sessionId: id, parentSessionId: parentId,
      capabilities: [], restoration: 'parent', cwd: '/fixture', title: outcome });
    emit({ type: 'session.ready', sessionId: id });
    emit({ type: 'session.turn', sessionId: id, turnId: 'turn-1', state: 'started' });
    emit({ type: 'session.turn', sessionId: id, turnId: 'turn-1', state: outcome });
    emit({ type: 'session.closed', sessionId: id });
    const updates = events.filter((e) => e.type === 'provider_subagent' && e.event.id === id && e.event.type === 'upsert');
    assert.equal(updates.at(-1)?.event.status, outcome);
    console.log(`PASS ${outcome} turn then close stays ${outcome}`);
  }
  await session.close();
} finally { await registry.shutdown(); }
