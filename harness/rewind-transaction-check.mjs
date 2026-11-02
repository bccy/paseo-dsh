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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const session = {
    id,
    header: { id, origin: 'new' },
    surface: { nodes: [0, 10, 20] },
    eventAt: (seq) => events.get(seq),
    append() {
      appended = true;
      this.surface.nodes = [0, 30];
    },
  };
  const agent = {
    id,
    session,
    status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
  };
  if (options.runMaintenance !== false) {
    agent.runMaintenance = async (task) => {
      maintenance += 1;
      return task(new AbortController().signal);
    };
  }
  const interrupted = [];
  const state = { fixture: undefined };
  const ctx = {
    on: () => () => {},
    agents: { get: (child) => (child === id ? agent : undefined) },
    get: (name) => ({
      sessions: {
        flush: async () => {
          if (onFlush !== undefined) await onFlush(state.fixture);
          return true;
        },
        get: (sessionId) => (sessionId === id ? session : undefined),
      },
      subagents: {
        interrupt: (child) => interrupted.push(child),
        waitForChildren: options.waitForChildren ?? (async () => {}),
      },
      ...options.services,
    })[name],
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
    interrupted,
    get maintenance() {
      return maintenance;
    },
    get appended() {
      return appended;
    },
    revert: () => server.revert({ sessionId: id, scope: options.scope ?? 'both', token: { messageId: 'm-10' } }),
  };
  return state.fixture;
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
  // and must fail loudly (before touching the log) when the runtime lacks it.
  const legacyBoth = await fixture(undefined, { runMaintenance: false });
  await assert.rejects(legacyBoth.revert(), /runMaintenance contract/);
  assert.equal(legacyBoth.appended, false, 'a missing maintenance scope must fail before the conversation is changed');
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
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n  ${passed}/${passed} passed`);
