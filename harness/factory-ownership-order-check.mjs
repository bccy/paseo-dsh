/**
 * The bridge must refresh the file-snapshot capture order when it becomes the
 * writer for a session, and it must do that from the factory's `setup` hook.
 *
 * `FileSnapshots` resumes a journal's durable high water when it becomes an
 * owner (`beginOwner`). That is only useful if something calls it: a process that
 * was a previous owner, or that is taking over from another one, keeps a stale
 * cached floor otherwise, and its next capture sorts *before* captures another
 * process already wrote — the wrong-pre-image bug this fix removes, in a live
 * process rather than across a restart.
 *
 * ## Why this is a separate check from `snapshot-lifecycle-check.mjs`
 *
 * That one drives `FileSnapshots` directly, so it proves the mechanism works but
 * cannot see whether the bridge uses it. A bridge that never calls `beginOwner`
 * would leave it fully green. This file therefore drives the **real**
 * `PaseoHarnessServer.createSession` over the **real** DSH agent factory
 * (`dsh-agent-loop`'s `setupAndPublish`) and asserts, from outside the bridge:
 *
 *   1. `createSession` calls `beginOwner` for that session id — the wiring exists
 *   2. it happens **before** the first capture the factory can run. The capture is
 *      taken from the `agent/created` observer, i.e. after setup and after
 *      publication, so an ordering assertion here is the strongest one available
 *      without reaching into the factory
 *   3. the resumed numbering respects a high water another process advanced —
 *      i.e. the call is not merely made, it is made at a point where it can still
 *      see the journal
 *   4. `resume` (a reopen) repeats it for the new writer epoch
 *   5. the live agent exposes `runMaintenance`, the internal method a
 *      file-restoring rewind runs inside. It is an instance method of a class DSH
 *      does not export, so only a real created agent can be checked (RW-02).
 *
 * ## How the services are assembled
 *
 * DSH 0.2.2 moved the wiring of `dsh-agent` and `dsh-agent-loop` into the Cordis
 * service init hook `[Service.init]` (factory registration in `dsh-agent-loop`;
 * the turn-boundary projection handle in `dsh-agent`). That hook only runs when
 * Cordis constructs the class as a plugin, so a plain `new AgentRegistry(ctx)` /
 * `new AgentLoop(ctx, ...)` now builds a half-initialized service and the first
 * `createSession` throws `no agent factory registered (load an agent-loop
 * plugin)`. This check therefore loads both of them with `await ctx.plugin(...)`,
 * which runs the init hook on 0.2.2 and the constructor path on 0.2.1 — the host
 * (profile plugin) loads them the same way, so one assembly covers both lines.
 * **Do not replace these with `new`**: it regresses to that half-initialized
 * state. The plugin path also validates the config, which is why
 * `maxParallelToolCalls` is the number 10 (the factory wraps it in a holder with
 * `.get()`, the shape the consumer reads).
 *
 * ## The hook choice this pins
 *
 * `setup` is awaited while the process already holds the session's write lease and
 * BEFORE the agent is published (`dsh-agent-loop/lib/index.js` `setupAndPublish`:
 * `await setup?.(...)` then `prepared.publish(...)`), so no capture can have run
 * and no other writer exists. That is why no extra factory contract
 * (`AgentSetupCommit.commit()`) is needed — and that contract's position is not
 * stable across DSH lines, so relying on it would be worse. Assertion 2 is what
 * would fail if someone moved the call after publication.
 *
 * **What "published" has to mean here changed on 0.2.2.** Upstream moved the
 * session publication ahead of `setup` (0.2.1: `sessions.enter/announce` inside
 * `publish()`, after setup; 0.2.2: before `setup?.(...)`), while the agent is
 * still created, entered and announced after setup on both lines. So the session
 * is already in the sessions store when `setup` runs on 0.2.2, and a "session not
 * yet published" assertion would only be testing that upstream ordering. What
 * closes the capture window is the *agent* publication (`agent/created` is where
 * a capture can first run), which is still after setup — that is the assertion
 * kept below. The session-table observation was dropped with it; a write-only
 * record of it would be dead weight.
 *
 * Usage:
 *
 *   node harness/factory-ownership-order-check.mjs
 *
 * `DSH_PACKAGES_DIR` / `DSH_INSTALL_DIR` select the DSH install to load, exactly
 * like `bridge-server-check.mjs`. **This is a local dependency** (a machine
 * without DSH cannot run it), so it is not part of the bare-runner CI gate.
 * **动了 `server.js` 的 `beginOwner` 接线或 `file-snapshots.js` 的 `beginOwner` /
 * `#nextCaptureSequence` 必跑。**
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
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

const require = createRequire(join(dshPackages, 'dsh-agent', 'package.json'));
const load = (name) => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);

const repo = resolve(import.meta.dirname, '..');
const { FileSnapshots } = await import(pathToFileURL(join(repo, 'dsh-bridge/lib/file-snapshots.js')).href);
let PaseoHarnessServer;
try {
  ({ PaseoHarnessServer } = await import(pathToFileURL(join(repo, 'dsh-bridge/lib/server.js')).href));
} catch (error) {
  console.error('could not load dsh-bridge/lib/server.js offline.');
  console.error(`  DSH packages were resolved from ${dshPackages}`);
  console.error('  (override with DSH_PACKAGES_DIR / DSH_INSTALL_DIR)');
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const [
  { Context },
  { AgentRegistry },
  { SessionStore },
  { SessionProjectionRegistry },
  { AgentLoop },
  { SessionPersistence },
] = await Promise.all(
  ['cordis', 'dsh-agent', 'dsh-session', 'dsh-session-projection', 'dsh-agent-loop', 'dsh-session-persistence']
    .map(load),
);

let passed = 0;
const pass = (label, detail) => {
  passed += 1;
  console.log(`  PASS  ${label}${detail === undefined ? '' : `  — ${detail}`}`);
};

const root = await mkdtemp(join(tmpdir(), 'dsh-factory-order-'));

/** In-memory persistence: enough for the factory to mint, publish and close. */
class MemoryPersistence extends SessionPersistence {
  records = new Map();
  writers = new Set();

  constructor(ctx) {
    super(ctx);
  }

  async create(header, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.records.has(header.id)) {
      const error = new Error('session already exists');
      error.name = 'SessionAlreadyExistsError';
      throw error;
    }
    const record = { header: structuredClone(header), events: [] };
    this.records.set(header.id, record);
    return this.handle(header.id, record, 'write');
  }

  async open(id, access, { signal } = {}) {
    signal?.throwIfAborted();
    const record = this.records.get(id);
    if (record === undefined) {
      const error = new Error('session missing');
      error.name = 'SessionPersistenceNotFoundError';
      throw error;
    }
    return this.handle(id, record, access);
  }

  handle(id, record, access) {
    if (access === 'write') {
      if (this.writers.has(id)) {
        const error = new Error('already owned');
        error.name = 'SessionAlreadyOwnedError';
        throw error;
      }
      this.writers.add(id);
    }
    let shut = false;
    const close = async () => {
      if (shut) return;
      shut = true;
      if (access === 'write') this.writers.delete(id);
    };
    return {
      id,
      access,
      header: record.header,
      inheritedEventCount: 0,
      read: async (offset = 0) => ({ eventState: 'detached', events: structuredClone(record.events.slice(offset)) }),
      append: async (events) => {
        assert.equal(access, 'write');
        for (const event of events) record.events.push(structuredClone(event));
      },
      flush: async () => {},
      close,
      [Symbol.asyncDispose]: close,
    };
  }

  async stat(id) {
    const record = this.records.get(id);
    return record === undefined ? undefined : { header: record.header, revision: `${id}:${record.events.length}`, formatStatus: 'current' };
  }

  async list() {
    return [...this.records].map(([id, record]) => ({
      header: record.header,
      revision: `${id}:${record.events.length}`,
      formatStatus: 'current',
    }));
  }

  async flush() {}
}

const ctx = new Context();
new SessionStore(ctx);
new SessionProjectionRegistry(ctx);
await ctx.plugin(AgentRegistry);
ctx.provide('systemPrompt', {
  variable() { return () => {}; },
  tools() { return () => {}; },
  section() { return () => {}; },
  getSectionOrder() { return 0; },
});
ctx.provide('llm', new Proxy({}, {
  get() {
    return () => {
      throw new Error('this check must not issue a model request');
    };
  },
}));
ctx.provide('tools', { register() { return () => {}; } });
const persistence = new MemoryPersistence(ctx);
await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 });

const server = new PaseoHarnessServer(
  ctx,
  { notify() {}, request() { throw new Error('unexpected client request'); } },
  { provider: 'fixture', model: 'fixture' },
);
const snapshotsDir = join(root, 'snapshots');
const realSnapshots = new FileSnapshots({ rootDir: snapshotsDir, warn() {} });
server.fileSnapshots = realSnapshots;

// Record every beginOwner call and whether it preceded publication, without
// changing what the bridge does. `ctx.agents.get(id)` answers only for a
// published agent, so "undefined here" is exactly "not published yet".
const beginCalls = [];
const realBegin = realSnapshots.beginOwner.bind(realSnapshots);
realSnapshots.beginOwner = (sessionId) => {
  beginCalls.push({
    sessionId,
    published: ctx.agents.get(sessionId) !== undefined,
  });
  realBegin(sessionId);
};

const target = join(root, 'target');
await writeFile(target, 'ORIGINAL');

// Capture from the publication observer: the earliest point a capture can run,
// and strictly after setup. Its captureSeq is therefore the first number this
// process hands out for the session.
const captures = [];
ctx.on('agent/created', async ({ agent }) => {
  const callId = `capture-${String(captures.length + 1)}`;
  const result = await realSnapshots.capture({ sessionId: agent.id, anchorSeq: 10 * (captures.length + 1), callId, path: target });
  assert.equal(result.ok, true, `capture must succeed: ${String(result.error)}`);
  await realSnapshots.commit({ sessionId: agent.id, callId }, {});
  captures.push({ sessionId: agent.id, captureSeq: (await realSnapshots.readJournal(agent.id)).entries.at(-1).captureSeq });
}, { global: true });

/** Advance a journal through a *different* FileSnapshots, as another process would. */
async function seedExternalWriter(sessionId) {
  const other = new FileSnapshots({ rootDir: snapshotsDir, warn() {} });
  for (let index = 0; index < 3; index += 1) {
    await other.capture({ sessionId, anchorSeq: 1, callId: `warm-${String(index)}`, path: join(root, 'absent') });
    other.discard({ sessionId, callId: `warm-${String(index)}` });
  }
  await other.capture({ sessionId, anchorSeq: 2, callId: 'external', path: target });
  await other.commit({ sessionId, callId: 'external' }, {});
  const journal = await other.readJournal(sessionId);
  return journal.entries.at(-1).captureSeq;
}

try {
  // -------------------------------------------------------------------------
  // 1/2/3. create: beginOwner is called, before publication, and it makes the
  //        first capture sort after another writer's high water.
  // -------------------------------------------------------------------------
  const sessionId = 'factory-root';
  // Prime this long-lived instance so it has a *stale* cached floor to refresh.
  await realSnapshots.capture({ sessionId, anchorSeq: 1, callId: 'old', path: target });
  await realSnapshots.commit({ sessionId, callId: 'old' }, {});

  const high = await seedExternalWriter(sessionId);
  beginCalls.length = 0;
  const created = await server.createSession(sessionId, { cwd: root, route: { provider: 'fixture', model: 'fixture' } });

  assert.equal(beginCalls.length, 1, `createSession must call beginOwner exactly once (called ${String(beginCalls.length)} time(s))`);
  assert.equal(beginCalls[0].sessionId, sessionId, 'beginOwner must name the session being created');
  pass('createSession calls beginOwner for the session it creates');

  assert.equal(beginCalls[0].published, false, 'beginOwner must run before the agent is published');
  pass('…before the agent is published (the capture window is closed at that point)');

  const firstCapture = captures.find((entry) => entry.sessionId === sessionId);
  assert.ok(firstCapture !== undefined, 'the publication observer must have captured');
  assert.ok(
    firstCapture.captureSeq > high,
    `the first capture after create must sort after the external high water (got ${String(firstCapture.captureSeq)}, external was ${String(high)})`,
  );
  pass('…and the first capture resumes the durable high water instead of restarting', `${String(firstCapture.captureSeq)} > ${String(high)}`);

  assert.equal(ctx.agents.get(sessionId), created.handle.agent);
  // The bridge's file-restoring rewind calls `agent.runMaintenance` on this exact
  // live object. The method lives on a class DSH does not export (`ReactLoopAgent`),
  // so an import-level contract check cannot see it; a real created agent is the
  // only honest place to assert it still exists. If upstream renames it, fail here
  // instead of every `both` rewind failing on a real machine.
  assert.equal(
    typeof created.handle.agent.runMaintenance,
    'function',
    'the live DSH agent must expose runMaintenance (the exclusive scope a file-restoring rewind runs in)',
  );
  pass('the live agent exposes runMaintenance for the file-restoring rewind');
  await server.closeSession({ sessionId });
  assert.equal(persistence.writers.has(sessionId), false, 'the write lease must be released');

  // -------------------------------------------------------------------------
  // 4. resume (a reopen) repeats it for the new writer epoch.
  // -------------------------------------------------------------------------
  const highAfterResume = await seedExternalWriter(sessionId);
  beginCalls.length = 0;
  await server.createSession(sessionId, { cwd: root, route: { provider: 'fixture', model: 'fixture' } });

  assert.equal(beginCalls.length, 1, `a resume must call beginOwner exactly once (called ${String(beginCalls.length)} time(s))`);
  assert.equal(beginCalls[0].published, false, 'a resume must also refresh before publication');
  const resumedCapture = captures.at(-1);
  assert.ok(
    resumedCapture.captureSeq > highAfterResume,
    `the first capture after resume must sort after the external high water (got ${String(resumedCapture.captureSeq)}, external was ${String(highAfterResume)})`,
  );
  pass('a resume repeats the refresh for the new writer epoch', `${String(resumedCapture.captureSeq)} > ${String(highAfterResume)}`);

  await server.closeSession({ sessionId });
  assert.equal(persistence.writers.size, 0, 'every write lease must be released');
  pass('all write leases released; no model request was issued');
} finally {
  await server.shutdown();
  await ctx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}

console.log(`\n  ${passed}/${passed} passed`);
