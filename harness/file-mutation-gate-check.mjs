/**
 * The root-scoped admission gate for tracked file mutations.
 *
 * A rewind calls DSH's `agent.runMaintenance`, which holds out that agent's own
 * tools — but not its independently running descendants. A native subagent that
 * is still finishing a `write`/`edit` can therefore commit a journal line after
 * the rewind planned its restore: the file is left modified, the rewind reports
 * success, and the same rewind prunes the journal line so a second attempt has
 * nothing to restore from.
 *
 * `FileMutationGate` closes exactly that seam: tracked executions of one root
 * take a shared ticket, a rewind takes the exclusive side, and the plan is only
 * computed while no tracked write is in flight.
 *
 * ## What is pinned
 *
 *   1. `freeze` drains the writers already in flight and holds new ones out;
 *      releasing it admits them again, in order, and the map returns to empty
 *      (no leaked root entry per conversation)
 *   2. a queued writer whose caller aborts leaves without being admitted, and
 *      without leaking a waiter count that would keep the root alive forever
 *   3. a `freeze` that times out re-opens admission — otherwise one slow writer
 *      would refuse every later edit in that conversation for the process's life
 *   4. roots are independent: a freeze on one does not block another
 *   5. a second `freeze` on the same root is refused rather than queued (the
 *      bridge already refuses a concurrent rewind per session, so reaching here
 *      twice means that guard was lost)
 *   6. releasing a barrier cannot orphan a waiter that was queued behind it —
 *      the next `freeze` must still see and wait for it
 *
 * No DSH, no profile, no files, no model: a plain module plus its own promises.
 * Run:
 *
 *   node harness/file-mutation-gate-check.mjs
 *
 * **动了 `dsh-bridge/lib/file-mutation-gate.js` 的 `enter` / `freeze` / `#collect`
 * 必跑。**
 */
import assert from 'node:assert/strict';
import { FileMutationGate } from '../dsh-bridge/lib/file-mutation-gate.js';

let passed = 0;
const pass = (label) => {
  passed += 1;
  console.log(`  PASS  ${label}`);
};

/** Let already-resolved promises run so a waiter can observe its state. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// 1. Freeze drains what is in flight, holds what is not, then re-admits.
// ---------------------------------------------------------------------------
{
  const gate = new FileMutationGate();
  const first = await gate.enter('a');
  let frozen = false;
  const freezeTask = gate.freeze('a').then((release) => {
    frozen = true;
    return release;
  });
  let admitted = false;
  const nextTask = gate.enter('a').then((release) => {
    admitted = true;
    return release;
  });
  // A different root is untouched by a freeze on `a`.
  const otherRelease = await gate.enter('b');
  otherRelease();
  await tick();
  assert.equal(frozen, false, 'freeze must wait for the writer in flight');
  assert.equal(admitted, false, 'a writer must not enter while the root is frozen');

  first();
  const release = await freezeTask;
  assert.equal(frozen, true);
  assert.equal(admitted, false, 'releasing the writer must not admit the queued one');
  release();
  const nextRelease = await nextTask;
  assert.equal(admitted, true);
  nextRelease();
  assert.equal(gate.size, 0, 'a drained, unfrozen root must be forgotten');
  pass('freeze drains in-flight mutations, holds new writes, and isolates roots');
}

// ---------------------------------------------------------------------------
// 2. A queued caller that aborts must leave without being admitted.
// ---------------------------------------------------------------------------
{
  const gate = new FileMutationGate();
  const held = await gate.freeze('a');
  const controller = new AbortController();
  const canceled = gate.enter('a', controller.signal);
  controller.abort(new Error('caller canceled'));
  await assert.rejects(canceled, /caller canceled/);
  held();
  // The aborted waiter must not have left a waiter count behind: with a leaked
  // one, `size` would stay non-zero and the next freeze would wait forever.
  assert.equal(gate.size, 0, 'an aborted waiter must not leak the root entry');
  const after = await gate.enter('a');
  after();
  assert.equal(gate.size, 0);
  pass('a queued caller that aborts leaves without being admitted and leaks nothing');
}

// ---------------------------------------------------------------------------
// 3. A timed-out freeze must re-open admission.
// ---------------------------------------------------------------------------
{
  const gate = new FileMutationGate();
  const active = await gate.enter('a');
  // `AbortSignal.timeout`'s timer is unref'd, so under a top-level await the
  // event loop can exit before it fires. Hold it open for the duration — the
  // timeout path itself is what is under test, not Node's timer refcount.
  const keeper = setInterval(() => {}, 100);
  try {
    await assert.rejects(gate.freeze('a', undefined, 15), /timeout|timed out|abort/i);
  } finally {
    clearInterval(keeper);
  }
  // Admission is open again: the stuck writer is still accounted for, but new
  // writers are not blocked behind a barrier nobody holds.
  const retry = await gate.enter('a');
  retry();
  active();
  assert.equal(gate.size, 0);
  pass('a timed-out recovery re-opens admission and keeps the active writer accounted for');
}

// ---------------------------------------------------------------------------
// 4. A second freeze on the same root is refused, not queued.
// ---------------------------------------------------------------------------
{
  const gate = new FileMutationGate();
  const first = await gate.freeze('a');
  await assert.rejects(gate.freeze('a'), /already holds/, 'a concurrent freeze must be refused');
  first();
  assert.equal(gate.size, 0);
  const again = await gate.freeze('a');
  again();
  pass('a second freeze on the same root is refused, and the root is usable afterwards');
}

// ---------------------------------------------------------------------------
// 5. Releasing a barrier cannot orphan a waiter queued behind it.
// ---------------------------------------------------------------------------
{
  const gate = new FileMutationGate();
  const barrier = await gate.freeze('a');
  const queued = gate.enter('a');
  barrier();
  const unqueue = await queued;
  // The waiter is now active. A second freeze must wait for it — if releasing
  // the barrier had dropped it from the accounting, this would resolve early.
  let refrozen = false;
  const refreezeTask = gate.freeze('a').then((release) => {
    refrozen = true;
    return release;
  });
  await tick();
  assert.equal(refrozen, false, 'a resumed waiter must remain visible to the next freeze');
  unqueue();
  const refreeze = await refreezeTask;
  refreeze();
  assert.equal(gate.size, 0);
  pass('releasing a barrier cannot orphan a queued mutation from the next freeze');
}

// ---------------------------------------------------------------------------
// 6. Every release is idempotent: the hooks may fire more than once for one
//    execution (a failed tool reaches both `post-execute` and `result`).
// ---------------------------------------------------------------------------
{
  const gate = new FileMutationGate();
  const release = await gate.enter('a');
  release();
  release();
  release();
  assert.equal(gate.size, 0, 'a repeated release must not drive the count negative');
  // A negative count would silently admit writers during a freeze; prove the
  // accounting is still honest by freezing with a live writer present.
  const live = await gate.enter('a');
  let frozen = false;
  const freezeTask = gate.freeze('a').then((fn) => {
    frozen = true;
    return fn;
  });
  await tick();
  assert.equal(frozen, false, 'the writer must still be counted after extra releases');
  live();
  (await freezeTask)();
  assert.equal(gate.size, 0);
  pass('a repeated release is idempotent and cannot corrupt the active count');
}

console.log(`\n  ${passed}/${passed} passed`);
