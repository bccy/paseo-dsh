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
 * What is pinned (each was reported as an audit finding):
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
 *   3. **`paseo/permission/set` must reach a real method.** 3047948 deleted
 *      `setPermission` while moving a JSDoc block and left its `case` in
 *      `handleRequest`, so applying Paseo's chosen preset on open threw
 *      `TypeError: this.setPermission is not a function`, became an open
 *      warning, and the session silently ran on the profile default — a
 *      read-only request still ran with write access. The method and its
 *      dispatch are pinned, and the whole switch is scanned for a `case` that
 *      names a method the prototype does not have: that is the exact shape the
 *      regression took, and it is what no behavioural check would have noticed.
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

// ===== 3. `paseo/permission/set` reaches a real implementation ===========
// The plugin applies Paseo's chosen preset on open (`session.configure` →
// `setPermission`), so a request that exists only as a `case` in the switch is a
// silent capability loss: the TypeError became an open warning and the user ran
// on the profile default even after picking "read-only". Both the method and its
// dispatch are pinned here, plus a scan that no future `case` points at a method
// that is not on the prototype — that is the shape the regression took.
{
  const calls = [];
  const service = {
    set: (session, name) => calls.push({ session, name }),
    current: () => 'restricted',
  };
  const { server, created } = makeServer({ permissionPresets: service });
  check(
    'the server implements setPermission',
    typeof PaseoHarnessServer.prototype.setPermission === 'function',
    typeof PaseoHarnessServer.prototype.setPermission,
  );
  // The dispatch throw is captured rather than allowed to abort the run: on the
  // regressed tree this request throws `this.setPermission is not a function`,
  // and an uncaught throw would end the script before the dispatch scan below
  // gets to report the same defect by name.
  let out;
  let thrown;
  try {
    out = await server.handleRequest('paseo/permission/set', { sessionId: 'perm-1', preset: 'restricted' });
  } catch (error) {
    thrown = error;
  }
  check(
    'paseo/permission/set dispatches without throwing',
    thrown === undefined,
    thrown === undefined ? 'no throw' : `threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
  );
  check(
    'paseo/permission/set writes the preset through DSH and answers the result',
    calls.length === 1 && calls[0].name === 'restricted' && out?.current === 'restricted',
    `${JSON.stringify(calls.map((call) => call.name))}, ${JSON.stringify(out)}`,
  );
  check(
    'paseo/permission/set materializes the session it is given',
    created.length === 1 && created[0] === 'perm-1' && calls[0]?.session?.id === 'perm-1',
    `created=${JSON.stringify(created)}`,
  );
}

// Every `case '…': return this.X(...)` in `handleRequest` must name a method that
// exists. This is the anti-regression net for the whole dispatch table: the
// regression that removed `setPermission` left its case standing, and nothing
// caught it because no check ever sent that request.
{
  const dispatch = PaseoHarnessServer.prototype.handleRequest.toString();
  const cases = [...dispatch.matchAll(/case '([^']+)':\s*return this\.([A-Za-z_$][\w$]*)\(/g)];
  const missing = cases.filter(([, , method]) => typeof PaseoHarnessServer.prototype[method] !== 'function');
  check(
    'the dispatch scan found the switch cases',
    cases.length >= 15,
    `${cases.length} case(s) parsed`,
  );
  check(
    'every method the request switch calls exists on the prototype',
    cases.length > 0 && missing.length === 0,
    missing.length === 0 ? `${cases.length} method(s) present` : `missing: ${missing.map(([, , method]) => method).join(', ')}`,
  );
}

// ===== 4. a bash job is titled by the model's own description ===========
// The pill printed shell source because `dsh-tool-bash` registers a job with
// `label: args.command`. Every bash call also carries a mandatory `description`
// that DSH's own row is titled with; the bridge captures it at `tools/execute`
// and joins it to the job through the command text, because `JobView` drops the
// `toolCall.callId` that would be the obvious key.
{
  const COMMAND = "grep -rn 'jobs' paseo-plugin/client";
  const DESCRIPTION = "查 jobs 行如何渲染";
  const jobsService = {
    list: () => [
      { id: 'bash-1', kind: 'bash', label: COMMAND, status: 'running', startedAt: 1 },
      { id: 'bash-2', kind: 'bash', label: 'make -j8', status: 'running', startedAt: 2 },
    ],
  };
  const { server } = makeServer({ jobs: jobsService });
  const session = { id: 'jobs-1' };

  // Nothing captured yet: the row must still answer, with the command as its
  // label and NO description key — an absent key is what tells the client to
  // keep the old rendering, so inventing an empty string would be a silent
  // downgrade dressed as a migration.
  const before = await server.jobs({ sessionId: 'jobs-1' });
  check(
    'a job with no captured description carries no description field',
    before?.available === true
      && before.jobs.length === 2
      && !('description' in before.jobs[0]),
    JSON.stringify(before.jobs[0]),
  );

  server.rememberToolDescription({ name: 'bash', arguments: { command: COMMAND, description: DESCRIPTION }, agent: { session } });
  const after = await server.jobs({ sessionId: 'jobs-1' });
  check(
    'a captured description is attached to the job that ran that command',
    after.jobs[0]?.description === DESCRIPTION,
    JSON.stringify(after.jobs[0]),
  );
  check(
    'the raw command is still on the row',
    after.jobs[0]?.label === COMMAND,
    JSON.stringify(after.jobs[0]),
  );
  check(
    "another job's row is untouched",
    !('description' in after.jobs[1]),
    JSON.stringify(after.jobs[1]),
  );

  // A description is per session: another session's identical command must not
  // inherit this one's words, or two conversations would title each other's
  // jobs.
  const other = await server.jobs({ sessionId: 'jobs-2' });
  check(
    "one session's description does not leak into another session",
    !('description' in (other.jobs[0] ?? {})),
    JSON.stringify(other.jobs[0]),
  );

  // Only bash is captured. The probe deliberately carries BOTH `command` and
  // `description`, because that is what makes it discriminating: a `read` call
  // has no `command` either, so a probe without one would pass on the argument
  // shape alone and never exercise the name check at all.
  server.rememberToolDescription({ name: 'bash', arguments: { command: 'make -j8', description: '编译全部目标' }, agent: { session } });
  server.rememberToolDescription({
    name: 'read',
    arguments: { command: 'make -j8', description: '一个 read 调用不该覆盖它' },
    agent: { session },
  });
  check(
    'a non-bash call records nothing, even when it carries command+description',
    server.toolDescriptionFor('jobs-1', 'make -j8') === '编译全部目标',
    String(server.toolDescriptionFor('jobs-1', 'make -j8')),
  );
  const mixed = await server.jobs({ sessionId: 'jobs-1' });
  check(
    'the job row keeps the bash description after a non-bash call',
    mixed.jobs[1]?.description === '编译全部目标',
    JSON.stringify(mixed.jobs[1]),
  );

  // A blank or missing description must not produce an empty title.
  server.rememberToolDescription({ name: 'bash', arguments: { command: 'echo hi', description: '   ' }, agent: { session } });
  server.rememberToolDescription({ name: 'bash', arguments: { command: 'echo hi' }, agent: { session } });
  check(
    'a blank description is not recorded',
    server.toolDescriptionFor('jobs-1', 'echo hi') === undefined,
    String(server.toolDescriptionFor('jobs-1', 'echo hi')),
  );

  // Closing the session drops the table, the same way the other per-session
  // tables are dropped — a closed session has no jobs left to title. Driven
  // through the public `closeSession` request rather than the private helper,
  // because that is the path a real provider takes.
  server.initializedSessions.add('jobs-1');
  await server.closeSession({ sessionId: 'jobs-1' });
  check(
    'closing a session drops its captured descriptions',
    server.toolDescriptionFor('jobs-1', COMMAND) === undefined,
    String(server.toolDescriptionFor('jobs-1', COMMAND)),
  );
}

const failedCount = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount === 0 ? 0 : 1);
