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
 * Build one rewind scenario.
 *
 * `onFlush` runs **inside** `sessions.flush`, i.e. exactly in the window the bug
 * lived in: after the plan was frozen, before the restore.
 */
async function fixture(onFlush) {
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
    runMaintenance: async (task) => {
      maintenance += 1;
      return task(new AbortController().signal);
    },
  };
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
      },
      subagents: {
        interrupt: (child) => interrupted.push(child),
        waitForChildren: async () => {},
      },
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
    revert: () => server.revert({ sessionId: id, scope: 'both', token: { messageId: 'm-10' } }),
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
  assert.equal(partial.files.failed.length, 1, 'the file half must be reported as failed');
  assert.ok(
    String(partial.files.failed[0].path).endsWith('journal.jsonl'),
    `the failure must name the journal as retry material: ${String(partial.files.failed[0].path)}`,
  );
  assert.equal(await readFile(unreadable.file, 'utf8'), 'CHANGED', 'no file may be touched');
  assert.equal((await unreadable.snapshots.readJournal(unreadable.id)).entries.length, 1, 'the journal is retained');
  assert.equal(unreadable.server.fileMutationGate.size, 0);
  pass('a journal read failing after the log commit reports a partial outcome and retains the journal');

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
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n  ${passed}/${passed} passed`);
