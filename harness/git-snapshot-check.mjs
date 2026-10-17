/**
 * Offline checks for `dsh-bridge/lib/git-snapshot.js`.
 *
 * Pure module: every git call goes through the injected runner, so the tests need
 * no repository and no subprocesses.
 *
 *   node harness/git-snapshot-check.mjs
 */
import assert from 'node:assert/strict';
import { worktreeState, snapshot, restore, snapshotFor, ledgerLine } from '../dsh-bridge/lib/git-snapshot.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
};

/** A runner that answers from a table and records the calls made. */
function runnerFor(table) {
  const calls = [];
  const run = (cwd, args) => {
    calls.push(args.join(' '));
    const key = args.join(' ');
    const answer = table[key];
    if (answer === undefined) throw new Error(`unexpected git call: ${key}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { run, calls };
}

check('a directory outside a repository is not a repo', () => {
  const { run } = runnerFor({ 'rev-parse --show-toplevel': new Error('fatal: not a git repository') });
  assert.deepEqual(worktreeState('/nowhere', run), { repo: false, dirty: [] });
});

check('a clean repository has no dirty files', () => {
  const { run } = runnerFor({ 'rev-parse --show-toplevel': '/repo', 'status --porcelain': '' });
  assert.deepEqual(worktreeState('/repo', run), { repo: true, dirty: [] });
});

check('dirty files are reported one per line, blank lines dropped', () => {
  const { run } = runnerFor({ 'rev-parse --show-toplevel': '/repo', 'status --porcelain': ' M a.js\n?? b.txt\n\n' });
  assert.deepEqual(worktreeState('/repo', run).dirty, [' M a.js', '?? b.txt']);
});

check('a clean tree snapshots HEAD and no stash', () => {
  const { run, calls } = runnerFor({ 'rev-parse HEAD': 'abc123\n', 'stash create': '' });
  assert.deepEqual(snapshot('/repo', run), { head: 'abc123', stash: null });
  assert.deepEqual(calls, ['rev-parse HEAD', 'stash create']);
});

check('a dirty tree snapshots HEAD and the stash commit', () => {
  const { run } = runnerFor({ 'rev-parse HEAD': 'abc123\n', 'stash create': 'def456\n' });
  assert.deepEqual(snapshot('/repo', run), { head: 'abc123', stash: 'def456' });
});

check('snapshotting a repository without commits fails loudly', () => {
  const { run } = runnerFor({ 'rev-parse HEAD': '' });
  assert.throws(() => snapshot('/repo', run), /without commits/);
});

check('restoring a clean snapshot only resets', () => {
  const { run, calls } = runnerFor({ 'reset --hard abc123': '' });
  restore('/repo', { head: 'abc123', stash: null }, run);
  assert.deepEqual(calls, ['reset --hard abc123']);
});

check('restoring a dirty snapshot resets then applies the stash', () => {
  const { run, calls } = runnerFor({ 'reset --hard abc123': '', 'stash apply --index def456': '' });
  restore('/repo', { head: 'abc123', stash: 'def456' }, run);
  assert.deepEqual(calls, ['reset --hard abc123', 'stash apply --index def456']);
});

check('a failed reset is thrown, never swallowed', () => {
  const { run } = runnerFor({ 'reset --hard abc123': new Error('fatal: could not reset') });
  assert.throws(() => restore('/repo', { head: 'abc123', stash: null }, run), /could not reset/);
});

check('snapshotFor matches by message id and prefers the newest line', () => {
  const text = [
    JSON.stringify({ messageId: 'm1', head: 'h1', stash: null }),
    JSON.stringify({ messageId: 'm2', head: 'h2', stash: 's2' }),
    JSON.stringify({ messageId: 'm1', head: 'h1b', stash: 's1b' }),
  ].join('\n');
  assert.deepEqual(snapshotFor(text, 'm1'), { head: 'h1b', stash: 's1b' });
  assert.deepEqual(snapshotFor(text, 'm2'), { head: 'h2', stash: 's2' });
  assert.equal(snapshotFor(text, 'missing'), undefined);
});

check('a truncated ledger tail does not lose earlier snapshots', () => {
  const text = `${JSON.stringify({ messageId: 'm1', head: 'h1', stash: null })}\n{"messageId":"m2","head":`;
  assert.deepEqual(snapshotFor(text, 'm1'), { head: 'h1', stash: null });
  assert.equal(snapshotFor(text, 'm2'), undefined);
});

check('an entry without a head is ignored', () => {
  const text = JSON.stringify({ messageId: 'm1', head: '', stash: null });
  assert.equal(snapshotFor(text, 'm1'), undefined);
});

check('ledgerLine round-trips through snapshotFor', () => {
  const line = ledgerLine({ seq: 29, messageId: 'm9', head: 'h9', stash: null });
  assert.equal(line.endsWith('\n'), true);
  assert.deepEqual(snapshotFor(line, 'm9'), { head: 'h9', stash: null });
});

console.log(`${passed} passed`);
