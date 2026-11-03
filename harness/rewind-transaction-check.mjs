/**
 * A rewind must include file writes that a delegated child commits while the
 * rewind itself is waiting.
 *
 * ## The bug
 *
 * `revert()` froze the restore plan, then awaited `sessions.flush()` and the
 * delegated-work settle, then restored. A native subagent finishing a `write`
 * during that window committed its journal line **after** the plan was frozen:
 * the file was never restored, the rewind still answered `success`, and the same
 * rewind pruned that journal line away — so a second attempt had nothing left to
 * restore from. The user sees "撤回已生效" with the file still modified.
 *
 * ## The fix this drives
 *
 * `revert` runs inside `agent.runMaintenance` (DSH's own exclusive scope for one
 * agent) **and** takes `fileMutationGate.freeze` (which covers descendants, the
 * half `runMaintenance` does not), then **re-plans** the file restore after the
 * flush and the delegated settle. A late commit is therefore either held out of
 * the window or picked up by the second plan.
 *
 * ## What is pinned
 *
 *   1. a child commit that lands **during the flush** is in the restore — the
 *      file is restored to its pre-edit state and the child's file is deleted,
 *      i.e. the late write did not survive the rewind
 *   2. the plan is computed twice (before the log write and after the flush),
 *      and `runMaintenance` was actually used — the ordering, not just the result
 *   3. a durability failure keeps the files untouched, does not interrupt the
 *      children, and leaves the journal as retry material
 *   4. a journal read that fails **after** the log commit reports a partial
 *      outcome (the conversation was rewound, the files were not) instead of a
 *      bare success, and keeps the journal
 *   5. a tracked write starting mid-rewind waits for the transaction to finish
 *      (the gate is held), so it cannot land between plan and restore
 *   6. the gate is always released: after a successful rewind, after a failed
 *      one, and the ticket table is empty
 *   7. closing a session drops its tickets AND releases the gate lease — a
 *      leaked ticket made that root's next freeze wait out its 15s budget
 *   8. a conversation-only rewind neither requires `agent.runMaintenance` nor
 *      takes the file gate; a `both` rewind without that method still fails
 *      loudly before changing the conversation
 *   9. a kept child blocked by our own gate does not turn the delegated settle
 *      into a 3s mutual wait (and does not print the misleading timeout line)
 *  10. a second-plan failure is reported as a plan failure (`files.error`), not
 *      as a per-file restore failure with rescue copies that do not exist
 *  11. a files-only rewind restores files inside the same exclusive transaction
 *      but appends no replacement, flushes nothing, needs no session store and
 *      keeps the journal; it still cancels/joins withdrawn children first
 *  12. after a files-only rewind the journal still yields the target message's
 *      own pre-image for a later `both` (repeated files-only is idempotent, and
 *      prune is still confined to the conversation scopes)
 *  13. a files-only rewind may target the first human message (it withdraws no
 *      conversation), while conversation/both still refuse it (BSR-01)
 *  14. a pending snapshot whose write landed before the session closed is
 *      journaled from the close path instead of dropped, and an unchanged one
 *      is not journaled (BF-02)
 *  15. a capture that fails after the read reaches the rewind receipt as
 *      `skipped`/`unrecoverable`, never as "no files changed" (BF-01)
 *
 * ## The fixture's `token` (a deliberate difference from the branch)
 *
 * The branch carried `exec.token ?? exec` in production so its synthetic
 * fixtures — which had no `token` — could be identified. Production has no
 * execution without a token, so the fallback existed only for the test. Here the
 * fixtures set `token`, and `server.js` compares `exec.token` directly. That is
 * the whole point of the difference: a test-only branch is not allowed in
 * production code.
 *
 * Runs the real `PaseoHarnessServer` with the real `FileSnapshots` and a
 * recording context; private temp files, no profile, no daemon, no model.
 *
 *   node harness/rewind-transaction-check.mjs
 *
 * `DSH_PACKAGES_DIR` / `DSH_INSTALL_DIR` select the DSH install to load, like
 * `bridge-server-check.mjs`. **This is a local dependency**, so it is not part of
 * the bare-runner CI gate. **动了 `server.js` 的 `revert` 事务、`beginFileMutation` /
 * `finishFileMutation` / `ownsFileMutation`，或 `file-mutation-gate.js` 必跑。**
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire, register } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DSH_PACKAGES =
  `${homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`;
const dshPackages = process.env.DSH_PACKAGES_DIR ?? DEFAULT_DSH_PACKAGES;
const dshRoot = process.env.DSH_INSTALL_DIR ?? resolve(dshPackages, '..', '..');
const dshAnchor = join(dshRoot, 'package.json');
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

const repo = resolve(import.meta.dirname, '..');
let PaseoHarnessServer;
let FileSnapshots;
try {
  ({ PaseoHarnessServer } = await import(pathToFileURL(join(repo, 'dsh-bridge/lib/server.js')).href));
  ({ FileSnapshots } = await import(pathToFileURL(join(repo, 'dsh-bridge/lib/file-snapshots.js')).href));
} catch (error) {
  console.error('could not load dsh-bridge/lib/server.js offline.');
  console.error(`  DSH packages were resolved from ${dshPackages}`);
  console.error('  (override with DSH_PACKAGES_DIR / DSH_INSTALL_DIR)');
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
// Loaded only to prove the module resolves against the installed DSH too.
const { createRequire: makeRequire } = await import('node:module');
makeRequire(join(dshPackages, 'dsh-agent', 'package.json')).resolve('@deepseek-ai/dsh-agent');

let passed = 0;
const pass = (label) => {
  passed += 1;
  console.log(`  PASS  ${label}`);
};

const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-transaction-'));
let serial = 0;

/**
 * Run one async call with stderr captured; returns its value plus the lines.
 *
 * The delegated-settle timeout is only ever reported on stderr today, so a
 * regression that reintroduces the 3s mutual wait would still "pass" on the
 * duration alone if the misleading line went unchecked.
 */
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

/**
 * Build one rewind scenario.
 *
 * `onFlush` runs **inside** `sessions.flush`, i.e. exactly in the window the bug
 * lived in: after the plan was frozen, before the restore.
 *
 * `options` keeps the fixture honest for the edge cases pinned below:
 *  - `scope`: Paseo's revert scope (`conversation` must not touch the file layer)
 *  - `runMaintenance`: set false to model a DSH that does not expose the internal
 *    method at all
 *  - `services`: extra ctx services (the `agents` registry used to join one
 *    interrupted child by identity)
 *  - `waitForChildren`: the subagent service's join, so the old all-children
 *    wait can be modelled against a child that is blocked by our own gate
 */
async function fixture(onFlush, options = {}) {
  const id = `root-${String(++serial)}`;
  const file = join(root, `${id}-file`);
  const childFile = join(root, `${id}-child`);
  const snapshots = new FileSnapshots({ rootDir: join(root, id), warn() {} });
  await writeFile(file, 'ORIGINAL');
  await snapshots.capture({ sessionId: id, anchorSeq: 10, callId: 'root-edit', path: file });
  await writeFile(file, 'CHANGED');
  await snapshots.commit({ sessionId: id, callId: 'root-edit' }, {});
  // The child's capture: it recorded that the file did not exist yet, so a rewind
  // must delete it.
  await snapshots.capture({ sessionId: id, anchorSeq: 20, callId: 'child-edit', path: childFile });

  const events = new Map(
    [0, 10, 20].map((seq) => [seq, { type: 'user/message', data: { id: `m-${String(seq)}`, source: { kind: 'user' } } }]),
  );
  let maintenance = 0;
  let appended = false;
  let flushCalls = 0;
  const session = {
    id,
    header: { id, origin: 'new' },
    surface: { nodes: [0, 10, 20] },
    eventAt: (seq) => events.get(seq),
    append(_type, _data, options) {
      appended = true;
      // DSH replaces the shadowed tail with the replacement node. Keep the rows
      // before the target: a later rewind may target one of them.
      const start = options?.surfaceOp?.startSeq ?? 30;
      this.surface.nodes = [...this.surface.nodes.filter((seq) => seq < start), 30];
    },
  };
  const cancels = [];
  const agent = {
    id,
    session,
    status: 'idle',
    inbox: {
      nextStep: [],
      nextTurn: [],
      remove(messageId) {
        for (const target of ['nextStep', 'nextTurn']) {
          const index = this[target].findIndex((message) => message.id === messageId);
          if (index >= 0) {
            this[target].splice(index, 1);
            return true;
          }
        }
        return false;
      },
    },
    // The pending-steer regression drives the real `prompt()`, so the agent needs
    // the two delivery methods DSH's ReactLoopAgent has (and the same inbox lists
    // the loop's Inbox exposes).
    steer(message) {
      this.inbox.nextStep.push(message);
    },
    followup(message) {
      this.inbox.nextTurn.push(message);
    },
    cancel(cause) {
      cancels.push(cause);
    },
  };
  if (options.runMaintenance !== false) {
    agent.runMaintenance = async (task) => {
      maintenance += 1;
      return task(new AbortController().signal);
    };
  }
  const interrupted = [];
  const state = { fixture: undefined };
  // The bridge registers its listeners through `ctx.on`; the pending-steer
  // regression drives them (a `user/message` event is what marks an issued
  // message committed), so capture the handlers instead of discarding them.
  const handlers = new Map();
  // `assertLiveAgent` reads `ctx.agents.get(rootId)`; the rewind itself reads the
  // `agents` service for the children it joined. One object serves both: a test
  // that supplies its own child lookup still has to be able to resolve the root.
  const agents = {
    get: (childId) => options.services?.agents?.get?.(childId) ?? (childId === id ? agent : undefined),
  };
  const services = { ...options.services, agents };
  const ctx = {
    on: (name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    },
    agents,
    get: (name) => {
      if (name === 'sessions') {
        // `sessions: false` models a profile with no session store. A
        // conversation rewind needs one (its marker must be durable); a
        // files-only rewind does not touch the log and must not need it.
        if (options.sessions === false) return undefined;
        return {
          flush: async () => {
            flushCalls += 1;
            if (onFlush !== undefined) await onFlush(state.fixture);
            return true;
          },
          get: (sessionId) => (sessionId === id ? session : undefined),
        };
      }
      if (name === 'subagents') {
        return {
          interrupt: (child) => interrupted.push(child),
          waitForChildren: options.waitForChildren ?? (async () => {}),
        };
      }
      return services[name];
    },
  };
  const server = new PaseoHarnessServer(ctx, { notify() {}, request() { throw new Error('unexpected request'); } });
  server.fileSnapshots = snapshots;
  server.sessions.set(id, { handle: { agent }, control: {} });
  server.childAnchors.record('child', 20, id);
  state.fixture = {
    id,
    file,
    childFile,
    snapshots,
    server,
    agent,
    session,
    interrupted,
    /** Add one surface event (a committed message) at `seq`. */
    appendEvent(seq, event) {
      events.set(seq, event);
    },
    /** Drive the bridge's own `session/event` listeners for one event. */
    emitSessionEvent(event) {
      for (const handler of handlers.get('session/event') ?? []) handler(session, event);
    },
    get cancels() {
      return cancels;
    },
    get maintenance() {
      return maintenance;
    },
    get appended() {
      return appended;
    },
    get flushCalls() {
      return flushCalls;
    },
    revert: (token) => server.revert({
      sessionId: id,
      scope: options.scope ?? 'both',
      token: token ?? options.token ?? { messageId: 'm-10' },
    }),
  };
  return state.fixture;
}

/**
 * A root session with one edit at each of several messages, for the journal
 * semantics across a files-only rewind followed by conversation rewinds.
 *
 * Anchor 10 changes the file to v1, 20 to v2, 30 to v3 and 40 to v4, so the
 * state at message 10/20/30/40 is v0/v1/v2/v3 (each capture's backup is the
 * state immediately before that message's first edit).
 */
async function sequenceFixture() {
  const id = `seq-${String(++serial)}`;
  const file = join(root, `${id}-file`);
  const snapshots = new FileSnapshots({ rootDir: join(root, id), warn() {} });
  const anchors = [10, 20, 30, 40];
  const events = new Map(
    [0, ...anchors].map((seq) => [seq, { type: 'user/message', data: { id: `m-${String(seq)}`, source: { kind: 'user' } } }]),
  );
  await writeFile(file, 'v0');
  for (const [index, anchor] of anchors.entries()) {
    const callId = `e${String(index + 1)}`;
    await snapshots.capture({ sessionId: id, anchorSeq: anchor, callId, path: file });
    await writeFile(file, `v${String(index + 1)}`);
    await snapshots.commit({ sessionId: id, callId }, {});
  }
  let appends = 0;
  let flushes = 0;
  const session = {
    id,
    header: { id, origin: 'new' },
    surface: { nodes: [0, ...anchors] },
    eventAt: (seq) => events.get(seq),
    append(_type, _data, options) {
      appends += 1;
      const markerSeq = 100 + appends;
      events.set(markerSeq, { type: 'user/message', data: { id: `mark-${String(appends)}`, source: { kind: 'paseo-rewind' } } });
      const start = options?.surfaceOp?.startSeq ?? markerSeq;
      this.surface.nodes = [...this.surface.nodes.filter((seq) => seq < start), markerSeq];
    },
  };
  const agent = {
    id,
    session,
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    runMaintenance: async (task) => task(new AbortController().signal),
  };
  const ctx = {
    on: () => () => {},
    agents: { get: (childId) => (childId === id ? agent : undefined) },
    get: (name) => {
      if (name === 'sessions') {
        return {
          flush: async () => {
            flushes += 1;
            return true;
          },
          get: () => session,
        };
      }
      if (name === 'subagents') return { interrupt() {}, waitForChildren: async () => {} };
      return undefined;
    },
  };
  const server = new PaseoHarnessServer(ctx, { notify() {}, request() { throw new Error('unexpected request'); } });
  server.fileSnapshots = snapshots;
  server.sessions.set(id, { handle: { agent }, control: {} });
  return {
    id,
    file,
    snapshots,
    server,
    get appends() {
      return appends;
    },
    get flushes() {
      return flushes;
    },
    revert: (scope, messageId) => server.revert({ sessionId: id, scope, token: { messageId } }),
  };
}

try {
  // -------------------------------------------------------------------------
  // 1/2/6. A child commit during the flush must be included.
  // -------------------------------------------------------------------------
  const late = await fixture(async (f) => {
    // The child finishes its write in the window the bug lived in.
    await writeFile(f.childFile, 'LATE_CHILD_WRITE');
    await f.snapshots.commit({ sessionId: f.id, callId: 'child-edit' }, {});
  });
  const latePlan = late.snapshots.planRestore.bind(late.snapshots);
  let planCalls = 0;
  late.snapshots.planRestore = async (...args) => {
    planCalls += 1;
    return latePlan(...args);
  };
  const lateResult = await late.revert();
  assert.equal(lateResult.kind, 'success', `the rewind must succeed: ${JSON.stringify(lateResult)}`);
  assert.equal(await readFile(late.file, 'utf8'), 'ORIGINAL', 'the root file must be restored');
  await assert.rejects(readFile(late.childFile), { code: 'ENOENT' }, 'the late child file must be deleted');
  pass('a child commit during the flush is included: the late write does not survive the rewind');

  assert.equal(late.maintenance, 1, 'the rewind must run inside agent.runMaintenance');
  assert.ok(planCalls >= 2, `the plan must be recomputed after the flush (called ${String(planCalls)} time(s))`);
  pass('…and the fix is the ordering: runMaintenance was used and the plan was recomputed');

  assert.equal(late.server.fileMutationGate.size, 0, 'the gate must be released after a successful rewind');
  assert.equal(late.server.fileMutationTickets.size, 0, 'no ticket may outlive the rewind');
  assert.equal((await late.snapshots.readJournal(late.id)).entries.length, 0, 'the journal is pruned after success');
  pass('the gate and the ticket table are empty after a successful rewind');

  // -------------------------------------------------------------------------
  // 3. A durability failure must leave everything alone.
  // -------------------------------------------------------------------------
  const failed = await fixture(async () => {
    throw new Error('durability failed');
  });
  await assert.rejects(failed.revert(), /durability failed/);
  assert.equal(await readFile(failed.file, 'utf8'), 'CHANGED', 'a failed rewind must not touch files');
  assert.equal(failed.interrupted.length, 0, 'children must not be interrupted when durability failed');
  assert.equal((await failed.snapshots.readJournal(failed.id)).entries.length, 1, 'the journal stays as retry material');
  assert.equal(failed.server.fileMutationGate.size, 0, 'the gate must be released after a failed rewind');
  pass('a durability failure keeps files, child work and recovery evidence, and releases the gate');

  // -------------------------------------------------------------------------
  // 4. A journal read failing after the log commit is a partial outcome.
  // -------------------------------------------------------------------------
  const unreadable = await fixture();
  const plan = unreadable.snapshots.planRestore.bind(unreadable.snapshots);
  let reads = 0;
  unreadable.snapshots.planRestore = async (...args) => {
    reads += 1;
    // The FIRST read (before the log write) must succeed — a failure there has to
    // abort while the conversation is still untouched. The SECOND (the re-plan)
    // is the one that fails, which is the partial-outcome case.
    if (reads === 2) throw new Error('final journal read failed');
    return plan(...args);
  };
  const partial = await unreadable.revert();
  assert.equal(unreadable.appended, true, 'the conversation rewind did happen');
  assert.equal(partial.kind, 'success', 'the conversation half succeeded');
  // A plan failure is not a per-file restore failure: nothing was restored and
  // no rescue copy exists, so it must not be packed into `files.failed` (the
  // provider renders that field as "these files failed; the overwritten content
  // was rescued to <rescueDir>"). It gets its own `error` and names the journal
  // as the retry material instead.
  assert.equal(partial.files.failed.length, 0, 'a plan failure must not masquerade as failed file restores');
  assert.match(String(partial.files.error), /文件恢复计划/, `the failure must be attributed to the plan: ${String(partial.files.error)}`);
  assert.match(String(partial.files.error), /journal\.jsonl/, 'the failure must name the journal as retry material');
  assert.equal(await readFile(unreadable.file, 'utf8'), 'CHANGED', 'no file may be touched');
  assert.equal((await unreadable.snapshots.readJournal(unreadable.id)).entries.length, 1, 'the journal is retained');
  assert.equal(unreadable.server.fileMutationGate.size, 0);
  pass('a journal read failing after the log commit reports a plan failure (not a file restore failure) and retains the journal');

  // -------------------------------------------------------------------------
  // 5/6. A tracked write starting mid-rewind waits for the transaction.
  // -------------------------------------------------------------------------
  let queuedAdmitted = false;
  let queuedAdmission;
  let exec;
  const blocked = await fixture(async (f) => {
    exec = {
      name: 'write',
      arguments: { file_path: f.file },
      callId: 'queued',
      // The execution's own token, which every real execution has — see the
      // header note about why this is not `exec.token ?? exec`.
      token: { id: 'exec-token-queued' },
      agent: f.agent,
      signal: new AbortController().signal,
    };
    queuedAdmitted = false;
    // One ticket, one `beginFileMutation` call: the same promise is awaited after
    // the rewind below. Calling it twice would (correctly) be refused as a
    // duplicate identity.
    queuedAdmission = f.server.beginFileMutation(exec).then(() => {
      queuedAdmitted = true;
    });
    // A real delay, not `await Promise.resolve()`: `enter` resolves through
    // several microtasks even when it is NOT blocked, so a single tick would let
    // this pass with the gate removed (verified by mutation — it did). Waiting a
    // macrotask means "still not admitted" is genuinely caused by the freeze.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(queuedAdmitted, false, 'a tracked write must not start mid-rewind');
  });
  const blockedResult = await blocked.revert();
  assert.equal(blockedResult.kind, 'success');
  // Only now may the queued write proceed.
  await queuedAdmission;
  assert.equal(queuedAdmitted, true, 'the queued write is admitted once the rewind finished');
  assert.equal(blocked.server.ownsFileMutation(exec), true, 'it owns its ticket');
  blocked.server.finishFileMutation(exec);
  assert.equal(blocked.server.ownsFileMutation(exec), false, 'releasing drops ownership');
  assert.equal(blocked.server.fileMutationGate.size, 0);
  assert.equal(blocked.server.fileMutationTickets.size, 0);
  pass('a tracked write starting mid-rewind waits for the transaction, then owns and releases its ticket');

  // -------------------------------------------------------------------------
  // 7. Duplicate identities must not leak leases or steal tickets.
  // -------------------------------------------------------------------------
  const duplicate = await fixture();
  const input = {
    name: 'write',
    arguments: { file_path: duplicate.file },
    callId: 'duplicate',
    token: { id: 'exec-token-dup' },
    agent: duplicate.agent,
  };
  const rejectedInput = { ...input, token: { id: 'exec-token-dup-2' } };
  const firstTicket = duplicate.server.beginFileMutation(input);
  await assert.rejects(duplicate.server.beginFileMutation(rejectedInput), /duplicate/);
  await firstTicket;
  assert.equal(duplicate.server.ownsFileMutation(rejectedInput), false, 'a rejected execution must not own the ticket');
  assert.equal(duplicate.server.finishFileMutation(rejectedInput), false, 'a rejected execution must not release it');
  assert.equal(duplicate.server.ownsFileMutation(input), true, 'the admitted execution keeps its ticket');
  duplicate.server.finishFileMutation(input);
  assert.equal(duplicate.server.fileMutationGate.size, 0);
  assert.equal(duplicate.server.fileMutationTickets.size, 0);
  pass('duplicate mutation identities neither leak a lease nor retire the admitted execution');

  // -------------------------------------------------------------------------
  // 8. A close must drop and release every ticket it still owns.
  // -------------------------------------------------------------------------
  const closing = await fixture();
  const heldExec = {
    name: 'write',
    arguments: { file_path: closing.file },
    callId: 'held-across-close',
    token: { id: 'exec-token-held' },
    agent: closing.agent,
  };
  await closing.server.beginFileMutation(heldExec);
  assert.equal(closing.server.fileMutationTickets.size, 1, 'the held execution owns one ticket');
  assert.equal(closing.server.fileMutationGate.size, 1, 'the ticket keeps the root leased in the gate');
  await closing.server.closeSession({ sessionId: closing.id });
  assert.equal(closing.server.fileMutationTickets.size, 0, 'close must drop the session\'s tickets');
  assert.equal(closing.server.fileMutationGate.size, 0, 'close must release the gate lease, not only forget the ticket');
  const freezeStarted = Date.now();
  const releaseClosed = await closing.server.fileMutationGate.freeze(closing.id, undefined, 500);
  releaseClosed();
  assert.ok(
    Date.now() - freezeStarted < 400,
    `a closed session's root must not poison the next freeze (${String(Date.now() - freezeStarted)}ms)`,
  );

  // A descendant can run a tracked tool before the bridge has recorded it in
  // `children` (the child's first event has not been observed yet). Its ticket
  // is keyed by the CHILD id, but the lease belongs to the root being closed.
  const lagging = await fixture();
  const laggingChildId = 'lagging-child';
  const laggingChild = {
    id: laggingChildId,
    session: { id: laggingChildId, header: { origin: 'subagent', parentSession: lagging.id } },
  };
  await lagging.server.beginFileMutation({
    name: 'write',
    arguments: { file_path: lagging.file },
    callId: 'lagging-write',
    token: { id: 'exec-token-lagging' },
    agent: laggingChild,
  });
  assert.equal(lagging.server.fileMutationTickets.size, 1, 'the descendant holds one ticket');
  assert.equal(lagging.server.children.has(laggingChildId), false, 'the descendant was never recorded in children');
  await lagging.server.closeSession({ sessionId: lagging.id });
  assert.equal(lagging.server.fileMutationTickets.size, 0, 'a root close must release a descendant ticket keyed by the child id');
  assert.equal(lagging.server.fileMutationGate.size, 0, '…and the root lease it kept active');
  pass('closing a session drops its file-mutation tickets and releases the gate lease');

  // -------------------------------------------------------------------------
  // 9. Conversation-only must not require the internal maintenance scope.
  // -------------------------------------------------------------------------
  const legacyConversation = await fixture(undefined, { runMaintenance: false, scope: 'conversation' });
  const legacyResult = await legacyConversation.revert();
  assert.equal(legacyResult.kind, 'success', `a conversation-only rewind must succeed without runMaintenance: ${JSON.stringify(legacyResult)}`);
  assert.equal(legacyConversation.maintenance, 0, 'the conversation path must not call runMaintenance');
  assert.equal(legacyConversation.appended, true, 'the conversation rewind still happened');
  assert.equal(await readFile(legacyConversation.file, 'utf8'), 'CHANGED', 'a conversation-only rewind must not touch files');
  pass('a conversation-only rewind succeeds without agent.runMaintenance and leaves files alone');

  // The other half: a file-restoring rewind still requires the exclusive scope
  // and must fail loudly (before touching the log or any file) when the runtime
  // lacks it. `files` restores files just like `both`, so it must share this.
  const legacyBoth = await fixture(undefined, { runMaintenance: false });
  await assert.rejects(legacyBoth.revert(), /runMaintenance contract/);
  assert.equal(legacyBoth.appended, false, 'a missing maintenance scope must fail before the conversation is changed');
  const legacyFiles = await fixture(undefined, { runMaintenance: false, scope: 'files' });
  await assert.rejects(legacyFiles.revert(), /runMaintenance contract/);
  assert.equal(await readFile(legacyFiles.file, 'utf8'), 'CHANGED', 'a refused files-only rewind must not touch files');
  assert.equal(legacyFiles.interrupted.length, 0, 'a refused files-only rewind must not interrupt children');
  pass('a file-restoring rewind without agent.runMaintenance fails loudly before any write');

  // -------------------------------------------------------------------------
  // 10. Conversation-only must not take the file gate either.
  // -------------------------------------------------------------------------
  let convExec;
  let convAdmission;
  let convAdmittedDuringFlush = false;
  let convAdmittedAtFlush;
  const conversation = await fixture(async (f) => {
    convExec = {
      name: 'write',
      arguments: { file_path: f.file },
      callId: 'conversation-write',
      token: { id: 'exec-token-conversation' },
      agent: f.agent,
      signal: new AbortController().signal,
    };
    // Start it during the flush. It must be admitted immediately: a
    // conversation-only rewind has no file plan, so blocking tracked writes
    // would be pure latency (and a slow writer could fail the rewind at 15s).
    convAdmission = f.server.beginFileMutation(convExec).then(() => {
      convAdmittedDuringFlush = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    convAdmittedAtFlush = convAdmittedDuringFlush;
  }, { scope: 'conversation' });
  const conversationResult = await conversation.revert();
  assert.equal(conversationResult.kind, 'success');
  assert.equal(convAdmittedAtFlush, true, 'a tracked write must not be blocked by a conversation-only rewind');
  await convAdmission;
  conversation.server.finishFileMutation(convExec);
  assert.equal(conversation.server.fileMutationGate.size, 0);
  pass('a conversation-only rewind does not freeze the file gate');

  // -------------------------------------------------------------------------
  // 11. A kept (not withdrawn) child blocked by our own gate must not stretch
  //     the settle wait to its 3s cap — that is the gate × waitForChildren
  //     deadlock, and the log line it prints would be misleading.
  // -------------------------------------------------------------------------
  const keptChildId = 'kept-child';
  let keptIdleResolve;
  const keptIdle = new Promise((resolve) => {
    keptIdleResolve = resolve;
  });
  const keptChild = {
    id: keptChildId,
    session: { id: keptChildId, header: { origin: 'subagent', parentSession: '' } },
    status: 'running',
    whenIdle: () => keptIdle,
  };
  let keptExec;
  let keptAdmission;
  let keptAdmittedDuringFlush = false;
  let keptAdmittedAtFlush;
  const kept = await fixture(async (f) => {
    keptChild.session.header.parentSession = f.id;
    keptExec = {
      name: 'write',
      arguments: { file_path: f.childFile },
      callId: 'kept-write',
      token: { id: 'exec-token-kept' },
      agent: keptChild,
      signal: new AbortController().signal,
    };
    keptAdmission = f.server.beginFileMutation(keptExec).then(() => {
      keptAdmittedDuringFlush = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    keptAdmittedAtFlush = keptAdmittedDuringFlush;
  }, {
    services: { agents: { get: (childId) => (childId === keptChildId ? keptChild : undefined) } },
    // Model the old all-children join: it cannot resolve while the child's
    // tracked write sits in `gate.enter` waiting for this very rewind.
    waitForChildren: async () => {
      await keptIdle;
    },
  });
  // Anchor before the target: this child belongs to a conversation that stays,
  // so the rewind must neither cancel it nor wait for it.
  kept.server.childAnchors.record(keptChildId, 0, kept.id);
  const keptStarted = Date.now();
  const keptResult = await captureStderr(() => kept.revert());
  const keptElapsed = Date.now() - keptStarted;
  assert.equal(keptResult.value.kind, 'success', JSON.stringify(keptResult.value));
  assert.equal(keptAdmittedAtFlush, false, 'the gate must still hold a tracked write that started mid-rewind');
  assert.ok(keptElapsed < 1000, `the kept child must not stretch the rewind to the 3s settle cap (${String(keptElapsed)}ms)`);
  assert.ok(
    keptResult.lines.every((line) => !line.includes('did not settle after the rewind interrupt')),
    `a gate-blocked kept child is not an unsettled interrupt: ${JSON.stringify(keptResult.lines)}`,
  );
  keptIdleResolve();
  await keptAdmission;
  kept.server.finishFileMutation(keptExec);
  pass('a kept child blocked by the gate does not turn the settle wait into a 3s mutual wait');

  // -------------------------------------------------------------------------
  // 12. The withdrawn children are STILL joined — narrowing the wait must not
  //     drop the original promise (interrupted work gets its bounded moment).
  // -------------------------------------------------------------------------
  let withdrawnIdleResolve;
  const withdrawnIdle = new Promise((resolve) => {
    withdrawnIdleResolve = resolve;
  });
  const withdrawnChild = {
    id: 'withdrawn-child',
    session: { id: 'withdrawn-child', header: { origin: 'subagent', parentSession: '' } },
    status: 'running',
    whenIdle: () => withdrawnIdle,
  };
  let waitForChildrenCalls = 0;
  const joined = await fixture(undefined, {
    services: { agents: { get: (childId) => (childId === 'withdrawn-child' ? withdrawnChild : undefined) } },
    waitForChildren: async () => {
      waitForChildrenCalls += 1;
    },
  });
  // Anchor at/after the target: this child was dispatched by the withdrawn turn
  // and is exactly the work the interrupt + bounded join exists for.
  joined.server.childAnchors.record('withdrawn-child', 20, joined.id);
  setTimeout(() => withdrawnIdleResolve(), 100);
  const joinedStarted = Date.now();
  const joinedResult = await joined.revert();
  const joinedElapsed = Date.now() - joinedStarted;
  assert.equal(joinedResult.kind, 'success', JSON.stringify(joinedResult));
  assert.ok(joinedElapsed >= 50, `the rewind must wait for the withdrawn child it signalled (${String(joinedElapsed)}ms)`);
  assert.ok(joinedElapsed < 1000, `and stop as soon as that child is idle (${String(joinedElapsed)}ms)`);
  assert.equal(waitForChildrenCalls, 0, 'the join is by child identity, not the all-children wait');
  assert.ok(joined.interrupted.includes('withdrawn-child'), 'the withdrawn child must be interrupted');
  pass('a withdrawn child is still joined by identity, and the all-children wait is not used');

  // -------------------------------------------------------------------------
  // 13. Files-only: restore the files, leave the conversation byte-for-byte
  //     alone, and keep the journal (a later conversation rewind needs it).
  // -------------------------------------------------------------------------
  const filesOnly = await fixture(undefined, { scope: 'files' });
  await writeFile(filesOnly.childFile, 'CHILD');
  await filesOnly.snapshots.commit({ sessionId: filesOnly.id, callId: 'child-edit' }, {});
  const filesOnlyResult = await filesOnly.revert();
  assert.equal(filesOnlyResult.kind, 'success', JSON.stringify(filesOnlyResult));
  assert.equal(filesOnly.maintenance, 1, 'a files-only rewind still runs inside agent.runMaintenance');
  assert.equal(filesOnly.appended, false, 'a files-only rewind must not append a conversation replacement');
  assert.equal(filesOnly.flushCalls, 0, 'a files-only rewind must not flush the conversation log');
  assert.equal(await readFile(filesOnly.file, 'utf8'), 'ORIGINAL', 'the edited file must be restored');
  await assert.rejects(readFile(filesOnly.childFile), { code: 'ENOENT' }, 'the child-created file must be deleted');
  assert.ok(filesOnlyResult.files !== undefined, 'the files-only receipt must carry the same `files` shape as both');
  assert.deepEqual([...filesOnlyResult.files.restored, ...filesOnlyResult.files.deleted].sort(), [filesOnly.file, filesOnly.childFile].sort());
  assert.equal((await filesOnly.snapshots.readJournal(filesOnly.id)).entries.length, 2, 'a files-only rewind must keep the journal for later rewinds');
  assert.ok(
    !String(filesOnlyResult.text ?? '').toLowerCase().includes('withdrawn'),
    `a files-only receipt must not claim a message was withdrawn: ${String(filesOnlyResult.text)}`,
  );
  assert.equal(filesOnly.server.fileMutationGate.size, 0, 'the gate must be released after a files-only rewind');
  pass('a files-only rewind restores files without touching the conversation or pruning the journal');

  // It must not even require a session store: nothing is written to the log.
  const filesNoStore = await fixture(undefined, { scope: 'files', sessions: false });
  const filesNoStoreResult = await filesNoStore.revert();
  assert.equal(filesNoStoreResult.kind, 'success', JSON.stringify(filesNoStoreResult));
  assert.equal(await readFile(filesNoStore.file, 'utf8'), 'ORIGINAL');
  pass('a files-only rewind works without a session store (it never touches the log)');

  // The withdrawn child is still interrupted and joined before the restore: a
  // child writing behind the restore would resurrect the file after it was fixed.
  let filesChildIdleResolve;
  const filesChildIdle = new Promise((resolve) => {
    filesChildIdleResolve = resolve;
  });
  const filesChild = {
    id: 'files-withdrawn-child',
    session: { id: 'files-withdrawn-child', header: { origin: 'subagent', parentSession: '' } },
    status: 'running',
    whenIdle: () => filesChildIdle,
  };
  const filesJoined = await fixture(undefined, {
    scope: 'files',
    services: { agents: { get: (childId) => (childId === 'files-withdrawn-child' ? filesChild : undefined) } },
  });
  filesJoined.server.childAnchors.record('files-withdrawn-child', 20, filesJoined.id);
  setTimeout(() => filesChildIdleResolve(), 100);
  const realFilesRestore = filesJoined.snapshots.restore.bind(filesJoined.snapshots);
  let filesRestoreAt;
  filesJoined.snapshots.restore = async (...args) => {
    filesRestoreAt = Date.now();
    return realFilesRestore(...args);
  };
  const filesJoinedStarted = Date.now();
  const filesJoinedResult = await filesJoined.revert();
  assert.equal(filesJoinedResult.kind, 'success', JSON.stringify(filesJoinedResult));
  assert.ok(filesJoined.interrupted.includes('files-withdrawn-child'), 'a files-only rewind must interrupt a child whose dispatch turn it covers');
  assert.ok(
    filesRestoreAt !== undefined && filesRestoreAt - filesJoinedStarted >= 50,
    `the file restore must wait for the interrupted child (${String(filesRestoreAt === undefined ? 'never' : filesRestoreAt - filesJoinedStarted)}ms)`,
  );
  pass('a files-only rewind cancels and joins withdrawn children before restoring files');

  // -------------------------------------------------------------------------
  // 14. The journal after a files-only rewind: repeated files-only is
  //     idempotent; a later `both` still selects the target's own pre-image.
  // -------------------------------------------------------------------------
  const sequence = await sequenceFixture();
  const seqJournal = async () => (await sequence.snapshots.readJournal(sequence.id)).entries.length;
  assert.equal(await seqJournal(), 4, 'the fixture writes one journal line per edit');
  const seqFiles = await sequence.revert('files', 'm-20');
  assert.equal(seqFiles.kind, 'success', JSON.stringify(seqFiles));
  assert.equal(await readFile(sequence.file, 'utf8'), 'v1', 'files-only to m-20 restores the state at m-20');
  assert.equal(sequence.appends, 0);
  assert.equal(sequence.flushes, 0);
  assert.equal(await seqJournal(), 4, 'files-only must not prune the journal');
  const seqFilesAgain = await sequence.revert('files', 'm-20');
  assert.equal(seqFilesAgain.kind, 'success', JSON.stringify(seqFilesAgain));
  assert.equal(await readFile(sequence.file, 'utf8'), 'v1', 'repeating files-only is idempotent');
  assert.equal(await seqJournal(), 4, 'repeating files-only still keeps the journal');
  const seqBothLater = await sequence.revert('both', 'm-30');
  assert.equal(seqBothLater.kind, 'success', JSON.stringify(seqBothLater));
  assert.equal(
    await readFile(sequence.file, 'utf8'),
    'v2',
    "both to a later message restores that message's own pre-image (v2), not whatever the earlier files-only left behind (v1)",
  );
  assert.match(String(seqBothLater.text), /Withdrawn/);
  assert.equal(sequence.appends, 1, 'the both rewind appends its replacement marker');
  assert.equal(sequence.flushes, 1);
  assert.equal(await seqJournal(), 3, 'the both rewind prunes entries after its target only');
  const seqBothEarlier = await sequence.revert('both', 'm-10');
  assert.equal(seqBothEarlier.kind, 'success', JSON.stringify(seqBothEarlier));
  assert.equal(await readFile(sequence.file, 'utf8'), 'v0', 'both to an earlier message restores the state at m-10');
  // The replacement removed every later row, so no visible message is
  // rewindable any more: the post-rewind trim drops the whole journal by design
  // (`minRewindableAnchor` is Infinity). The restore itself already used e1.
  assert.equal(await seqJournal(), 0, 'trim drops entries once no visible message can anchor a future rewind');
  pass('files-only leaves the journal intact; a later both still restores the target message\'s pre-image');

  // -------------------------------------------------------------------------
  // 15. Files-only under the first human message: no conversation is withdrawn,
  //     so the "first message" rule must not apply (BSR-01).
  // -------------------------------------------------------------------------
  const firstFiles = await fixture(undefined, { scope: 'files', token: { messageId: 'm-0' } });
  await writeFile(firstFiles.childFile, 'CHILD');
  await firstFiles.snapshots.commit({ sessionId: firstFiles.id, callId: 'child-edit' }, {});
  const firstFilesResult = await firstFiles.revert();
  assert.equal(
    firstFilesResult.kind,
    'success',
    `a files-only rewind under the first message must succeed: ${JSON.stringify(firstFilesResult)}`,
  );
  assert.equal(await readFile(firstFiles.file, 'utf8'), 'ORIGINAL', 'it restores the file like any other files-only rewind');
  await assert.rejects(
    readFile(firstFiles.childFile),
    { code: 'ENOENT' },
    'and deletes the file created after the first message',
  );
  assert.equal(firstFiles.appended, false, 'it still appends no conversation replacement');
  pass('a files-only rewind under the first human message restores files instead of being refused');

  for (const scope of ['conversation', 'both']) {
    const firstConversation = await fixture(undefined, { scope, token: { messageId: 'm-0' } });
    await assert.rejects(
      firstConversation.revert(),
      /首条消息禁止撤回/,
      `a ${scope} rewind must keep refusing the first human message`,
    );
    assert.equal(firstConversation.appended, false, `a refused ${scope} rewind must not append`);
  }
  pass('conversation and both rewinds still refuse the first human message');

  // -------------------------------------------------------------------------
  // 16. A close must not drop a pending snapshot whose write already landed.
  //     The bridge clears its tables before disposing the agent, so the
  //     post-execute commit never arrives; the pre-image has to be journaled
  //     from the close path instead (BF-02).
  // -------------------------------------------------------------------------
  const closingWrite = await fixture();
  const lateFile = join(root, `${closingWrite.id}-late-close.txt`);
  await writeFile(lateFile, 'BEFORE', 'utf8');
  await closingWrite.snapshots.capture({
    sessionId: closingWrite.id,
    pendingKey: `${closingWrite.id}:closing-edit`,
    anchorSeq: 20,
    callId: 'closing-edit',
    path: lateFile,
  });
  // The atomic write lands, then the session closes before the result is seen.
  await writeFile(lateFile, 'AFTER', 'utf8');
  await closingWrite.server.closeSession({ sessionId: closingWrite.id });
  await closingWrite.snapshots.settle();
  const closingJournal = await closingWrite.snapshots.readJournal(closingWrite.id);
  const closingEntry = closingJournal.entries.find((entry) => entry.path === lateFile);
  assert.ok(
    closingEntry !== undefined && closingEntry.backup !== null,
    `a landed write must be journaled on close: ${JSON.stringify(closingJournal.entries)}`,
  );
  const closingPlan = await closingWrite.snapshots.planRestore(closingWrite.id, 20);
  const closingAction = closingPlan.actions.find((action) => action.path === lateFile);
  assert.ok(closingAction !== undefined, 'the journaled entry is restorable');
  await closingWrite.snapshots.restore(closingWrite.id, [closingAction]);
  assert.equal(await readFile(lateFile, 'utf8'), 'BEFORE', 'the pre-write content comes back');
  pass('a pending snapshot whose write landed before close is journaled, not dropped');

  // The other direction: a pending snapshot whose file did not change must not
  // invent a journal line (that would make every rewind report a phantom path).
  const quietClose = await fixture();
  const quietFile = join(root, `${quietClose.id}-quiet-close.txt`);
  await writeFile(quietFile, 'SAME', 'utf8');
  await quietClose.snapshots.capture({
    sessionId: quietClose.id,
    pendingKey: `${quietClose.id}:quiet-edit`,
    anchorSeq: 20,
    callId: 'quiet-edit',
    path: quietFile,
  });
  await quietClose.server.closeSession({ sessionId: quietClose.id });
  await quietClose.snapshots.settle();
  const quietJournal = await quietClose.snapshots.readJournal(quietClose.id);
  assert.ok(
    quietJournal.entries.every((entry) => entry.path !== quietFile),
    'an unchanged file must not be journaled on close',
  );
  pass('a pending snapshot whose file did not change is dropped on close');

  // -------------------------------------------------------------------------
  // 17. A capture that fails after reading the bytes must reach the receipt:
  //     the tool still writes the file, so "no files changed" would be a lie
  //     (BF-01).
  // -------------------------------------------------------------------------
  const failedCapture = await fixture(undefined, { scope: 'files' });
  failedCapture.agent.session.header.cwd = root;
  const extraFile = join(root, `${failedCapture.id}-extra.txt`);
  // Deliberately not the fixture file's content: identical bytes would already
  // have an object on disk, and capture would skip the object write it is meant
  // to fail.
  await writeFile(extraFile, 'EXTRA-BEFORE', 'utf8');
  const objectsDir = join(root, failedCapture.id, encodeURIComponent(failedCapture.id), 'objects');
  const extraExec = {
    name: 'write',
    callId: 'extra-edit',
    arguments: { file_path: extraFile },
    token: { id: 'exec-token-extra' },
    agent: failedCapture.agent,
  };
  // The bytes are read, then the object store refuses the write: the shape the
  // old catch-all turned into a bare stderr line.
  await chmod(objectsDir, 0o500);
  try {
    await failedCapture.server.captureFileBeforeTool(extraExec);
  } finally {
    await chmod(objectsDir, 0o700);
  }
  await failedCapture.server.commitFileTool(extraExec, { isError: false });
  await writeFile(extraFile, 'EXTRA-AFTER', 'utf8');
  const failedCaptureResult = await failedCapture.revert();
  assert.equal(failedCaptureResult.kind, 'success', JSON.stringify(failedCaptureResult));
  assert.ok(
    failedCaptureResult.files.skipped.includes(extraFile),
    `the unrestorable path must be in the receipt: ${JSON.stringify(failedCaptureResult.files)}`,
  );
  assert.ok(
    (failedCaptureResult.files.unrecoverable ?? []).some(
      (entry) => entry.path === extraFile && /capture failed/.test(entry.reason),
    ),
    `the receipt must carry the capture failure reason: ${JSON.stringify(failedCaptureResult.files.unrecoverable)}`,
  );
  pass('a capture that fails after the read reaches the rewind receipt instead of "no files changed"');

  // -------------------------------------------------------------------------
  // 18. Rewinding a message that was just steered and has NOT reached the
  //     surface yet (P3, real daemon): DSH queues a steer in the agent inbox and
  //     only appends it at the next step boundary. The daemon cancels the run
  //     before calling revert, and that cancel clears the inbox — so the message
  //     is discarded, never committed. The rewind must withdraw it and answer
  //     success, not claim it was "already rewound or compacted".
  // -------------------------------------------------------------------------
  {
    const hostFlow = await fixture(undefined, { scope: 'conversation' });
    hostFlow.server.initializedSessions.add(hostFlow.id);
    hostFlow.agent.status = 'running';
    const steer = await hostFlow.server.prompt({
      sessionId: hostFlow.id,
      contentBlocks: [{ type: 'text', text: 'steer: withdraw me before I land' }],
      delivery: 'steer',
    });
    const steerId = steer.messageId;
    assert.equal(hostFlow.agent.inbox.nextStep.length, 1, 'the steer is queued in the agent inbox');
    assert.equal(hostFlow.agent.inbox.nextStep[0].id, steerId);
    assert.equal(
      hostFlow.session.surface.nodes.some((seq) => hostFlow.session.eventAt(seq)?.data?.id === steerId),
      false,
      'the steer is not on the surface yet',
    );
    assert.equal(
      hostFlow.server.pendingUserMessages.get(hostFlow.id)?.has(steerId),
      true,
      'the bridge tracks the issued id as pending',
    );

    // The daemon's pre-rewind cancel clears the inbox and settles the turn; only
    // the pending table still knows this message. This is the exact state the P3
    // failure saw when the rewind reached the bridge.
    hostFlow.agent.inbox.nextStep.length = 0;
    hostFlow.agent.status = 'idle';
    const hostReceipt = await hostFlow.revert({ messageId: steerId });
    assert.equal(hostReceipt.kind, 'success', JSON.stringify(hostReceipt));
    assert.match(String(hostReceipt.text), /pending message/i, `the receipt must name the pending withdraw: ${hostReceipt.text}`);
    assert.equal(hostFlow.appended, false, 'nothing is appended to the log for a message that never reached the surface');
    assert.equal(hostFlow.flushCalls, 0, 'no log flush is needed (nothing was written)');
    assert.equal(hostFlow.cancels.length, 0, 'the pending withdraw must not cancel the running turn');
    assert.notEqual(
      hostFlow.server.pendingUserMessages.get(hostFlow.id)?.has(steerId),
      true,
      'the withdrawn message is no longer pending',
    );
    // A second rewind naming the same id is now the honest stale case: the
    // message is not in the conversation and cannot be withdrawn twice.
    await assert.rejects(
      hostFlow.revert({ messageId: steerId }),
      /不在可撤回的对话中/,
      'a repeated rewind of the withdrawn pending message falls back to the stale-token refusal',
    );
    pass('a steer that never reached the surface is withdrawn with a success receipt (host flow)');
  }
  {
    // Direct caller (no daemon pre-cancel): the message is still in the inbox,
    // so the bridge must remove it itself or it could still be sent later.
    const direct = await fixture(undefined, { scope: 'conversation' });
    direct.server.initializedSessions.add(direct.id);
    direct.agent.status = 'running';
    const steer = await direct.server.prompt({
      sessionId: direct.id,
      contentBlocks: [{ type: 'text', text: 'steer: direct withdraw' }],
      delivery: 'steer',
    });
    const receipt = await direct.revert({ messageId: steer.messageId });
    assert.equal(receipt.kind, 'success', JSON.stringify(receipt));
    assert.equal(direct.agent.inbox.nextStep.length, 0, 'the queued message is removed so it can never be sent');
    assert.equal(direct.cancels.length, 0, 'the turn is left running');
    assert.equal(direct.appended, false);
    pass('a still-queued steer is removed from the inbox by the withdraw (direct flow)');
  }
  {
    // Files-only has no conversation half and a queued message is not a surface
    // anchor: refuse with that reason instead of "already rewound/compacted".
    const filesScope = await fixture(undefined, { scope: 'files' });
    filesScope.server.initializedSessions.add(filesScope.id);
    const steer = await filesScope.server.prompt({
      sessionId: filesScope.id,
      contentBlocks: [{ type: 'text', text: 'steer: files scope' }],
      delivery: 'steer',
    });
    await assert.rejects(
      filesScope.revert({ messageId: steer.messageId }),
      /不能作为文件恢复的锚点/,
      'a files-only rewind of a queued message must refuse with the real reason',
    );
    assert.equal(filesScope.agent.inbox.nextStep.length, 1, 'a files-only rewind must not withdraw the message');
    assert.equal(filesScope.appended, false);
    pass('a files-only rewind of a queued message refuses accurately and keeps the message queued');
  }
  {
    // Tracked but already claimed by a step that is about to append it: the
    // claim removed it from the inbox, so the bridge cannot remove it any more.
    // Answering success would claim a withdrawal that may not happen, so this
    // must be the transient refusal (and keep it tracked for a retry).
    const claimed = await fixture(undefined, { scope: 'conversation' });
    claimed.server.initializedSessions.add(claimed.id);
    claimed.agent.status = 'running';
    const steer = await claimed.server.prompt({
      sessionId: claimed.id,
      contentBlocks: [{ type: 'text', text: 'steer: already claimed' }],
      delivery: 'steer',
    });
    claimed.agent.inbox.nextStep.length = 0;
    await assert.rejects(
      claimed.revert({ messageId: steer.messageId }),
      /还在发送中/,
      'a claimed-but-not-appended message must be refused as still sending, not silently "withdrawn"',
    );
    assert.equal(
      claimed.server.pendingUserMessages.get(claimed.id)?.has(steer.messageId),
      true,
      'the refusal keeps the id tracked so a retry can still withdraw it',
    );
    pass('a message claimed by the step but not appended yet is refused as still sending');
  }
  {
    // Once the message lands on the surface it is a normal conversation row: the
    // pending shortcut must not apply, and the ordinary marker/rewind path runs.
    const committed = await fixture(undefined, { scope: 'conversation' });
    committed.server.initializedSessions.add(committed.id);
    const steer = await committed.server.prompt({
      sessionId: committed.id,
      contentBlocks: [{ type: 'text', text: 'steer: this one lands' }],
      delivery: 'steer',
    });
    const steerId = steer.messageId;
    const event = {
      type: 'user/message',
      data: { id: steerId, source: { kind: 'user' }, content: [{ type: 'text', text: 'steer: this one lands' }] },
    };
    committed.appendEvent(30, event);
    committed.session.surface.nodes.push(30);
    committed.emitSessionEvent(event);
    assert.notEqual(
      committed.server.pendingUserMessages.get(committed.id)?.has(steerId),
      true,
      'the surface event clears the pending entry',
    );
    const receipt = await committed.revert({ messageId: steerId });
    assert.equal(receipt.kind, 'success', JSON.stringify(receipt));
    assert.match(String(receipt.text), /Withdrawn seq 30/, `the normal surface rewind applies: ${receipt.text}`);
    assert.equal(committed.appended, true, 'the normal rewind appends its replacement marker');
    assert.equal(committed.flushCalls, 1);
    pass('a steer that reached the surface takes the normal rewind path, not the pending shortcut');
  }
  {
    // Closing the session drops the pending table (bounded memory, no leak).
    const closing = await fixture(undefined, { scope: 'conversation' });
    closing.server.initializedSessions.add(closing.id);
    await closing.server.prompt({
      sessionId: closing.id,
      contentBlocks: [{ type: 'text', text: 'steer: close me' }],
      delivery: 'steer',
    });
    assert.equal(closing.server.pendingUserMessages.has(closing.id), true);
    await closing.server.closeSession({ sessionId: closing.id });
    assert.equal(closing.server.pendingUserMessages.has(closing.id), false, 'a closed session keeps no pending table');
    pass('closing a session drops its pending-message table');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n  ${passed}/${passed} passed`);
