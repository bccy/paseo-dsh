/**
 * Offline check for the read-only paths of the bridge server itself.
 *
 * `dsh-bridge/lib/server.js` imports profile-only packages (`@deepseek-ai/dsh-*`),
 * so for a long time nothing could load it outside a real `dsh --profile` — every
 * behavioural claim about the server had to go through a fake bridge, which
 * invents its own answers. That is fine for protocol shapes and useless for
 * claims about the server's own side effects: a fake that returns
 * `{available:false}` because its author wrote it that way says nothing about
 * whether the real `usage()` still materialises a closed session's agent.
 *
 * This file closes that gap: it maps the bare `@deepseek-ai/*` imports onto a DSH
 * installation with a module resolve hook, then drives the real class with a
 * recording context. No profile, no daemon, no model, no child process.
 *
 * What is pinned (both were reported as audit findings):
 *
 *   1. **`usage()` must not resurrect a closed session.** It is refreshed by a
 *      timer and by turn events, not by the user, so a request can still be in
 *      flight when the session is closed. Landing after `session/close`, the old
 *      code's `getOrCreateSession` resumed the just-disposed agent, which
 *      re-took the session log's write lease and kept its listeners for the life
 *      of the process. A closed id must answer `{available:false}` and create
 *      nothing; a session that was *re-initialized* (a reopen) or a resumed
 *      session on its first composer query must still be created — that is the
 *      behaviour the gate must not take away.
 *   2. **The two archive-state readers must say why they failed.** An empty
 *      archive set means "treat every session as unarchived", so `paseo/subagents`
 *      re-announces archived children and the user sees one come back. The
 *      strategy stays (filtering everything out would be a worse failure) but
 *      the cause is reported, and a *missing service* is reported once per
 *      process — these run on every session listing and every subagent replay,
 *      and a profile without the web bundle legitimately composes no
 *      `workspaceRegistry`, so repeating the line per call is noise. A failure
 *      (a throwing lookup or read) is still reported on every occurrence.
 *
 * Usage:
 *
 *   node harness/bridge-server-check.mjs
 *
 * The DSH packages are read from this machine's installation, resolved exactly
 * like `mcp-gateway-transport-check.mjs`:
 *
 *   DSH_PACKAGES_DIR  the `@deepseek-ai` package directory to resolve from
 *                     (default: this machine's global DSH install)
 *   DSH_INSTALL_DIR   the installation root to anchor resolution at
 *                     (default: two levels above DSH_PACKAGES_DIR)
 *
 * That is a **local** dependency: a machine without a DSH install cannot run this
 * check, which is why it is not part of a CI gate that runs on a bare runner.
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

/** Run one async call with stderr captured; returns its value plus the lines. */
async function captureStderr(fn) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (text) => {
    lines.push(String(text));
    return true;
  };
  try {
    return { value: await fn(), lines };
  } finally {
    process.stderr.write = original;
  }
}

const SUBAGENTS = {
  listDescendants: async () => [
    { kind: 'child', id: 'child-1', parentId: 'root-1', label: 'Child', mode: 'continuable' },
  ],
};

/**
 * Build a server whose side effects are observable.
 *
 * `createSession` is the thing under test — it is what materialises an agent and
 * takes the session log's write lease — so it is stubbed (a profile-less ctx
 * would otherwise fail deeper in) and every call is recorded. The fake agents it
 * hands back land in `agents`, which is what `assertLiveAgent` checks.
 *
 * `services` maps a ctx service name to the value `ctx.get` should answer; an
 * `Error` value makes the lookup throw, which is the failure path under test.
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
    const agent = { id: `agent-${sessionId}`, session: { id: sessionId } };
    agents.set(agent.id, agent);
    return { handle: { agent }, control: { dispose() {} } };
  };
  return { server, created };
}

console.log('bridge server: usage gate and archive-state reporting\n');

// ===== 1. usage() must not resurrect a closed session =====================
{
  const { server, created } = makeServer();
  server.closedSessions.add('closed-1');
  const out = await server.usage({ sessionId: 'closed-1' });
  check('usage() on a closed session answers available:false', out?.available === false, JSON.stringify(out));
  check(
    'usage() on a closed session creates no agent (no write lease taken)',
    created.length === 0,
    `createSession called for ${JSON.stringify(created)}`,
  );
  check('the closed id stays out of the live table', server.sessions.has('closed-1') === false);
}

{
  const { server, created } = makeServer();
  // `initialize` clears the close marker; that is the documented reopen path.
  server.closedSessions.add('reopened-1');
  server.closedSessions.delete('reopened-1');
  server.initializedSessions.add('reopened-1');
  const out = await server.usage({ sessionId: 'reopened-1' });
  check(
    'usage() still materializes a session that was re-initialized after a close',
    out?.available === true && created.length === 1,
    `${JSON.stringify(out)}, created=${JSON.stringify(created)}`,
  );
}

{
  const { server, created } = makeServer();
  server.initializedSessions.add('resumed-1');
  const out = await server.usage({ sessionId: 'resumed-1' });
  check(
    'usage() still materializes a resumed session on its first composer query',
    out?.available === true && created.length === 1,
    `${JSON.stringify(out)}, created=${JSON.stringify(created)}`,
  );
}

{
  const { server, created } = makeServer();
  const agent = { id: 'agent-live', session: { id: 'live-1' } };
  server.ctx.agents = { get: () => agent };
  server.sessions.set('live-1', { handle: { agent } });
  const out = await server.usage({ sessionId: 'live-1' });
  check(
    'usage() on a live session reads it without creating anything',
    out?.available === true && created.length === 0,
    `${JSON.stringify(out)}, created=${JSON.stringify(created)}`,
  );
}

// ===== 2. archive-state reads report their failures =====================
// The report order matters: `#archivedSessionIds` runs before `#sessionHeaders`
// on every call, and the once-per-process latch for a missing service is spent
// by the first assertion that exercises it. Each block below therefore leaves
// the services it is NOT testing present, so its capture holds only its own
// line.
const present = () => ({
  workspaceRegistry: { archivedSessionIds: new Set() },
  sessionPersistence: { list: async () => [] },
  sessions: { list: () => [] },
  subagents: SUBAGENTS,
});

// ---- 2a. a missing registry says so once, not once per call ------------
{
  const services = present();
  delete services.workspaceRegistry;
  const { server } = makeServer(services);
  const { lines: first } = await captureStderr(() => server.subagents({ sessionId: 'root-1' }));
  const { lines: second } = await captureStderr(() => server.subagents({ sessionId: 'root-1' }));
  const all = [...first, ...second];
  const said = all.filter((line) => line.includes('composes no workspace registry'));
  check(
    'a missing workspace registry is reported exactly once across two calls',
    said.length === 1,
    `${said.length} line(s) in ${all.length} total`,
  );
  check(
    'the missing-service line stays a missing-service line (not a failure)',
    said.every((line) => line.includes('composes no workspace registry') && !line.includes('failed')),
    JSON.stringify(said),
  );
}

// ---- 2b. a missing persistence says so once, not once per call ---------
{
  const services = { ...present() };
  delete services.sessionPersistence;
  const { server } = makeServer(services);
  const { lines: first } = await captureStderr(() => server.subagents({ sessionId: 'root-1' }));
  const { lines: second } = await captureStderr(() => server.subagents({ sessionId: 'root-1' }));
  const said = [...first, ...second].filter((line) => line.includes('composes no session persistence'));
  check(
    'a missing session persistence is reported exactly once across two calls',
    said.length === 1,
    `${said.length} line(s)`,
  );
}

// ---- 2c. a throwing lookup is reported on every call -------------------
{
  const { server } = makeServer({ ...present(), workspaceRegistry: new Error('registry exploded') });
  const { value: first, lines: firstLines } = await captureStderr(() => server.subagents({ sessionId: 'root-1' }));
  const { lines: secondLines } = await captureStderr(() => server.subagents({ sessionId: 'root-1' }));
  const failed = (lines) => lines.filter((line) => line.includes("looking up DSH's workspace registry failed"));
  check(
    'a throwing registry lookup is reported, naming the lookup and the cause',
    failed(firstLines).length === 1
      && failed(firstLines)[0].includes('registry exploded'),
    JSON.stringify(firstLines),
  );
  check(
    'a throwing lookup is reported on every call, not once per process',
    failed(secondLines).length === 1 && failed(firstLines).length === 1,
    `${failed(firstLines).length} + ${failed(secondLines).length}`,
  );
  check(
    'the strategy is unchanged: subagents still answers available:true, unarchived',
    first?.available === true && first.subagents[0]?.archived === undefined,
    JSON.stringify(first),
  );
}

// ---- 2d. a throwing archive-set read is reported on every call ----------
{
  const registry = {
    get archivedSessionIds() {
      throw new Error('archive set unreadable');
    },
  };
  const { server } = makeServer({ ...present(), workspaceRegistry: registry });
  const { value, lines: firstLines } = await captureStderr(() => server.subagents({ sessionId: 'root-1' }));
  const { lines: secondLines } = await captureStderr(() => server.subagents({ sessionId: 'root-1' }));
  const readFailed = (lines) => lines.filter((line) => line.includes("reading DSH's archived-session set failed"));
  check(
    'a throwing archive-set read is reported, naming the read and the cause',
    readFailed(firstLines).length === 1 && readFailed(firstLines)[0].includes('archive set unreadable'),
    JSON.stringify(firstLines),
  );
  check(
    'a throwing archive-set read is reported on every call',
    readFailed(secondLines).length === 1,
    `${readFailed(firstLines).length} + ${readFailed(secondLines).length}`,
  );
  check(
    'the strategy is unchanged: the child is still reported unarchived',
    value?.available === true && value.subagents[0]?.archived === undefined,
    JSON.stringify(value),
  );
}

// ---- 2e. a throwing stored-header list is reported on every call -------
{
  const persistence = {
    list: async () => {
      throw new Error('storage fault');
    },
  };
  const { server } = makeServer({ ...present(), sessionPersistence: persistence });
  const { value, lines: firstLines } = await captureStderr(() => server.subagents({ sessionId: 'root-1' }));
  const { lines: secondLines } = await captureStderr(() => server.subagents({ sessionId: 'root-1' }));
  const listFailed = (lines) => lines.filter((line) => line.includes('listing stored session headers failed'));
  check(
    'a throwing stored-header list is reported, naming the read and the cause',
    listFailed(firstLines).length === 1 && listFailed(firstLines)[0].includes('storage fault'),
    JSON.stringify(firstLines),
  );
  check(
    'a throwing stored-header list is reported on every call',
    listFailed(secondLines).length === 1,
    `${listFailed(firstLines).length} + ${listFailed(secondLines).length}`,
  );
  check('the subagent answer still succeeds', value?.available === true, JSON.stringify(value));
}

// ---- 2f. the reported line is attributed to the right reader -----------
// A capture that holds a persistence line while the persistence service is
// present would mean the latch and the report are wired to different things.
{
  const { server } = makeServer(present());
  const { value, lines } = await captureStderr(() => server.subagents({ sessionId: 'root-1' }));
  check(
    'a fully composed profile reports nothing at all',
    lines.length === 0 && value?.available === true,
    `${lines.length} line(s): ${JSON.stringify(lines)}`,
  );
}

const failedCount = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount === 0 ? 0 : 1);
