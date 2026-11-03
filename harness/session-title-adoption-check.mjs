/**
 * Offline check for the bridge half of "Paseo's agent title becomes the DSH session title".
 *
 * The chain: Paseo names an agent itself (the name its own UI shows) and hands
 * it to the provider as `config.title`; the plugin forwards it on the session's
 * `initialize` frame (`paseo-plugin/server/{provider,session,dsh-process}.ts`);
 * the bridge remembers it per session and writes it with
 * `sessionTitle.rename()` once the session is live. DSH's title service derives
 * titles only from human `user` messages, and a Paseo agent's first message is a
 * host envelope — so without this passthrough the DSH session list shows an
 * unnamed conversation, while the Paseo name is the accurate one.
 *
 * This file pins the **bridge** segment of that chain, driving the real
 * `PaseoHarnessServer` with a recording context. What is asserted:
 *
 *   1. `initialize` carrying a title + a **freshly created** session → the title
 *      is written on the live session (the exact Session object).
 *   2. The same on the **resume** branch (a persisted session opened again), and
 *      a reopen with an equal title does not append a second `session/title`.
 *   3. `initialize` without a title → nothing is written (DSH keeps its own
 *      title derivation).
 *   4. A non-string, empty or whitespace-only title is ignored rather than
 *      refused — the name is a label and must not break the open.
 *   5. An existing *different* title is overwritten: the Paseo name is
 *      authoritative for a Paseo agent, so a title DSH generated from the first
 *      user turn is replaced.
 *   6. The name is per session: a title sent for one session never titles
 *      another, and a process-level `initialize` (no session id) has no session
 *      to name.
 *   7. Best-effort failures: a missing title service or a refused rename is
 *      reported on stderr and the session still opens (and `initialize` still
 *      succeeds).
 *
 * The plugin half (config.title → DshSession → attachSession → initialize frame)
 * is type-checked by `tsc --noEmit` and exercised by the real-plugin checks; this
 * file deliberately does not re-implement the plugin host.
 *
 * `dsh-bridge/lib/server.js` imports profile-only packages, so this file maps
 * `@deepseek-ai/*` onto a DSH installation exactly like `bridge-server-check.mjs`:
 * no profile, no daemon, no model, no child process.
 *
 * Usage:
 *
 *   node harness/session-title-adoption-check.mjs
 *
 * DSH packages are read from this machine's installation:
 *
 *   DSH_PACKAGES_DIR  the `@deepseek-ai` package directory to resolve from
 *                     (default: this machine's global DSH install)
 *   DSH_INSTALL_DIR   the installation root to anchor resolution at
 *                     (default: two levels above DSH_PACKAGES_DIR)
 *
 * That is a **local** dependency, which is why this check is not part of a CI
 * gate that runs on a bare runner.
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
  console.error('  (override with DSH_PACKAGES_DIR / DSH_INSTALL_DIR)');
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

/** The title service as the bridge sees it; records every accepted rename. */
function fakeTitleService({ titles = new Map(), renameError } = {}) {
  const renames = [];
  return {
    renames,
    get(session) {
      const title = titles.get(String(session.id));
      return title === undefined ? undefined : { title, source: { kind: 'user' } };
    },
    rename(session, title) {
      renames.push({ session, title });
      if (renameError !== undefined) throw renameError;
      titles.set(String(session.id), title);
      return { title, source: { kind: 'user' } };
    },
  };
}

/**
 * Build a server whose `initialize` + `getOrCreateSession` run for real.
 *
 * `createFails` selects the branch under test: `true` makes `agents.create`
 * throw the "already exists" conflict DSH raises for a persisted session, so
 * `createSession` takes its resume path; `false` exercises fresh creation.
 */
function makeServer({ titleService, createFails = false, sessionId = 's1' } = {}) {
  const session = { id: sessionId, header: { id: sessionId } };
  const agent = { id: `agent-${sessionId}`, session };
  const calls = { create: 0, resume: 0 };
  const services = {
    llm: {
      listProviders: () => [{ id: 'p1' }],
      resolveCallConfig: async () => ({}),
    },
    ...(titleService === undefined ? {} : { sessionTitle: titleService }),
  };
  const ctx = {
    get(name) {
      return services[name];
    },
    on: () => () => {},
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      create: async () => {
        calls.create += 1;
        if (createFails) throw new Error(`session "${sessionId}" already exists`);
        return { agent, dispose: async () => {} };
      },
      resume: async () => {
        calls.resume += 1;
        return { agent, dispose: async () => {} };
      },
    },
  };
  const transport = {
    notify() {},
    write() {},
    flush: async () => {},
    request: async () => ({}),
  };
  const server = new PaseoHarnessServer(ctx, transport, {});
  return { server, calls, session, agent };
}

const ROUTE = { cwd: process.cwd(), provider: 'p1', model: 'm1' };

// ===== 1. a fresh session takes Paseo's title ============================
console.log('session title adoption: Paseo agent title\n');

{
  const titleService = fakeTitleService();
  const { server, session, calls } = makeServer({ titleService });
  const initialized = await server.initialize({ ...ROUTE, sessionId: 's1', title: 'Paseo 里的 agent 名' });
  const rec = await server.getOrCreateSession('s1');
  check(
    'initialize still answers its route',
    initialized?.route?.provider === 'p1' && initialized.route.model === 'm1',
    JSON.stringify(initialized?.route),
  );
  check(
    'a fresh session is renamed with Paseo\'s agent title',
    titleService.renames.length === 1
      && titleService.renames[0].title === 'Paseo 里的 agent 名'
      && titleService.renames[0].session === session
      && rec?.handle?.agent?.session === session,
    JSON.stringify(titleService.renames.map((entry) => ({ title: entry.title, sameSession: entry.session === session }))),
  );
  check('the fresh-creation branch was the one exercised', calls.create === 1 && calls.resume === 0, JSON.stringify(calls));
}

// ===== 2. a resumed session takes it too, idempotently ==================
{
  const titles = new Map();
  const titleService = fakeTitleService({ titles });
  const { server, session, calls } = makeServer({ titleService, createFails: true });
  await server.initialize({ ...ROUTE, sessionId: 's1', title: '恢复后的 agent 名' });
  await server.getOrCreateSession('s1');
  check(
    'a resumed session is renamed with Paseo\'s agent title',
    titleService.renames.length === 1
      && titleService.renames[0].title === '恢复后的 agent 名'
      && titleService.renames[0].session === session
      && calls.resume === 1,
    `${titleService.renames.length} rename(s), calls=${JSON.stringify(calls)}`,
  );
  // Reopen: the agent is disposed and the same persisted session is resumed
  // again (the bridge's close-then-reopen path). The title is already right, so
  // no second `session/title` event may be appended.
  server.sessions.delete('s1');
  await server.getOrCreateSession('s1');
  check(
    'a reopen with an equal title appends nothing',
    titleService.renames.length === 1 && calls.resume === 2,
    `${titleService.renames.length} rename(s), calls=${JSON.stringify(calls)}`,
  );
}

// ===== 3. no title → DSH keeps its own derivation =======================
{
  const titleService = fakeTitleService();
  const { server } = makeServer({ titleService });
  await server.initialize({ ...ROUTE, sessionId: 's1' });
  await server.getOrCreateSession('s1');
  check(
    'an initialize without a title writes no title',
    titleService.renames.length === 0,
    `${titleService.renames.length} rename(s)`,
  );
}

// ===== 4. a malformed title is ignored, not fatal =======================
{
  const titleService = fakeTitleService();
  const { server } = makeServer({ titleService });
  let threw;
  try {
    await server.initialize({ ...ROUTE, sessionId: 's1', title: 42 });
    await server.initialize({ ...ROUTE, sessionId: 's1', title: '' });
    await server.initialize({ ...ROUTE, sessionId: 's1', title: '   ' });
  } catch (error) {
    threw = error;
  }
  await server.getOrCreateSession('s1');
  check(
    'non-string and blank titles are ignored, not refused',
    threw === undefined && titleService.renames.length === 0,
    `threw=${threw === undefined ? 'no' : String(threw)}, ${titleService.renames.length} rename(s)`,
  );
}

// ===== 5. an existing different title is overwritten ====================
{
  const titles = new Map([['s1', 'DSH 从首条消息生成的标题']]);
  const titleService = fakeTitleService({ titles });
  const { server } = makeServer({ titleService });
  await server.initialize({ ...ROUTE, sessionId: 's1', title: 'Paseo 权威名称' });
  await server.getOrCreateSession('s1');
  check(
    'a different existing title is replaced by the Paseo name',
    titleService.renames.length === 1
      && titleService.renames[0].title === 'Paseo 权威名称'
      && titles.get('s1') === 'Paseo 权威名称',
    `${titleService.renames.length} rename(s), stored=${JSON.stringify(titles.get('s1'))}`,
  );
}

// ===== 6. the title is per session ======================================
{
  const titleService = fakeTitleService();
  const first = makeServer({ titleService, sessionId: 's1' });
  await first.server.initialize({ ...ROUTE, sessionId: 's1', title: '只有 s1 有名字' });
  await first.server.getOrCreateSession('s1');
  check(
    'a title sent for one session names only that session',
    titleService.renames.length === 1 && titleService.renames[0].session === first.session,
    JSON.stringify(titleService.renames.map((entry) => String(entry.session.id))),
  );

  // A process-level initialize (no session id) has no session to name.
  const titleService2 = fakeTitleService();
  const second = makeServer({ titleService: titleService2 });
  await second.server.initialize({ ...ROUTE, title: '进程级 initialize 的标题' });
  await second.server.initialize({ ...ROUTE, sessionId: 's1' });
  await second.server.getOrCreateSession('s1');
  check(
    'a process-level initialize never titles a session',
    titleService2.renames.length === 0,
    `${titleService2.renames.length} rename(s)`,
  );
}

// ===== 7. failures never fail the open ==================================
{
  const titleService = fakeTitleService({ renameError: new Error('session "s1" is not live in this store') });
  const { server } = makeServer({ titleService });
  await server.initialize({ ...ROUTE, sessionId: 's1', title: '会失败的标题' });
  const { value: rec, lines } = await captureStderr(() => server.getOrCreateSession('s1'));
  check(
    'a refused rename does not fail the open',
    rec?.handle?.agent?.session !== undefined,
    rec === undefined ? 'undefined' : 'session returned',
  );
  check(
    'the refused rename is reported with the session id',
    lines.some((line) => line.includes('adopting Paseo\'s agent title') && line.includes('s1') && line.includes('not live')),
    JSON.stringify(lines),
  );
}

{
  const { server } = makeServer({ titleService: undefined });
  await server.initialize({ ...ROUTE, sessionId: 's1', title: '没有标题服务' });
  const { value: rec, lines } = await captureStderr(() => server.getOrCreateSession('s1'));
  check(
    'a profile without the title service still opens the session',
    rec?.handle?.agent?.session !== undefined,
    rec === undefined ? 'undefined' : 'session returned',
  );
  check(
    'the missing title service is reported as missing, not as a failure',
    lines.some((line) => line.includes('composes no session-title service')),
    JSON.stringify(lines),
  );
}

const failedCount = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount === 0 ? 0 : 1);
