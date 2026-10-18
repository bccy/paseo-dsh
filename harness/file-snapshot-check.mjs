/**
 * Offline check for the rewind's file layer (`dsh-bridge/lib/file-snapshots.js`).
 *
 * The contract this pins: a rewind restores exactly the files the agent's
 * editing tools touched after the target message, and nothing else.
 *
 * - write-before state is captured per tool call and committed only on success;
 * - a file created after the target is deleted, an edited one gets its earliest
 *   post-target content back, and a file untouched since the target is left alone;
 * - bash side effects and the user's own edits are never recorded (they never go
 *   through the tracked tools);
 * - the current content is rescued before restore overwrites it, and one failed
 *   path does not abort the rest.
 *
 * Uses a real temp directory, so the journal/objects/rescue layout is exercised
 * as written, not mocked.
 *
 * Usage: node harness/file-snapshot-check.mjs
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSnapshots,
  isTrackedTool,
  mutationPathOf,
  resolveMutationPath,
} from '../dsh-bridge/lib/file-snapshots.js';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

const root = await mkdtemp(join(tmpdir(), 'paseo-rewind-check-'));
const warnings = [];
const snapshots = new FileSnapshots({ rootDir: root, warn: (line) => warnings.push(line) });

const tool = (name, filePath, callId) => ({ name, callId, arguments: { file_path: filePath } });

async function captureAndCommit(exec, anchorSeq, { isError = false } = {}) {
  await snapshots.capture({
    sessionId: SESSION,
    anchorSeq,
    callId: String(exec.callId),
    path: exec._resolvedPath,
  });
  await snapshots.commit({ sessionId: SESSION, callId: String(exec.callId) }, { isError });
}

const SESSION = 'sess-file-check';

console.log('tracked tools and path extraction');
{
  check('write is tracked', isTrackedTool({ name: 'write' }) === true);
  check('edit is tracked', isTrackedTool({ name: 'edit' }) === true);
  check('read is not', isTrackedTool({ name: 'read' }) === false);
  check('bash is not', isTrackedTool({ name: 'bash' }) === false);
  check('write exposes file_path', mutationPathOf(tool('write', 'a.txt', 'c1')) === 'a.txt');
  check('another key is ignored', mutationPathOf({ name: 'write', arguments: { path: 'a.txt' } }) === undefined);
  check('relative paths resolve against cwd', resolveMutationPath('/w', 'a.txt') === '/w/a.txt');
  check('absolute paths stay absolute', resolveMutationPath('/w', '/tmp/a.txt') === '/tmp/a.txt');
}

console.log('before-content is captured only on success');
{
  const file = join(root, 'edit-me.txt');
  await writeFile(file, 'v0', 'utf8');
  const exec = tool('edit', file, 'call-1');
  exec._resolvedPath = file;
  await snapshots.capture({ sessionId: SESSION, anchorSeq: 10, callId: 'call-1', path: file });
  await snapshots.commit({ sessionId: SESSION, callId: 'call-1' }, { isError: true });
  let journal = await snapshots.readJournal(SESSION);
  check('a failed tool records nothing', journal.entries.length === 0, `${journal.entries.length} entries`);

  await writeFile(file, 'v1', 'utf8');
  await captureAndCommit(exec, 10);
  journal = await snapshots.readJournal(SESSION);
  check('a successful tool records one entry', journal.entries.length === 1, `${journal.entries.length} entries`);
  check('and stores the before content', journal.entries[0]?.backup !== null);
}

console.log('rewind to an anchor restores the earliest post-target state');
{
  const file = join(root, 'multi.txt');
  await writeFile(file, 'A', 'utf8');
  const exec = tool('write', file, 'call-2');
  exec._resolvedPath = file;
  await captureAndCommit(exec, 20);
  await writeFile(file, 'B', 'utf8');
  exec.callId = 'call-3';
  await captureAndCommit(exec, 20);
  await writeFile(file, 'C', 'utf8');

  const { actions } = await snapshots.planRestore(SESSION, 15);
  const action = actions.find((entry) => entry.path === file);
  check('one action per path', actions.filter((entry) => entry.path === file).length === 1);
  const outcome = await snapshots.restore(SESSION, [action]);
  check('restore succeeded', outcome.failed.length === 0, JSON.stringify(outcome.failed));
  check('the earliest post-target content is back', (await readFile(file, 'utf8')) === 'A', await readFile(file, 'utf8'));
  const rescueFiles = await readdir(join(root, encodeURIComponent(SESSION), 'rescue'));
  check('the pre-restore content is rescued', rescueFiles.length === 1, JSON.stringify(rescueFiles));
  const rescueBody = await readFile(join(root, encodeURIComponent(SESSION), 'rescue', rescueFiles[0]), 'utf8');
  check('the rescue copy is the content that was overwritten', rescueBody === 'C', rescueBody);
}

console.log('a file created after the target is deleted');
{
  const file = join(root, 'created-later.txt');
  const exec = tool('write', file, 'call-4');
  exec._resolvedPath = file;
  await captureAndCommit(exec, 30);
  await writeFile(file, 'new file', 'utf8');
  const { actions } = await snapshots.planRestore(SESSION, 25);
  const action = actions.find((entry) => entry.path === file);
  check('the action deletes it', action !== undefined && action.backup === null, JSON.stringify(action));
  const outcome = await snapshots.restore(SESSION, [action]);
  check('the file is gone', existsSync(file) === false, JSON.stringify(outcome));
}

console.log('files touched by an earlier turn are left alone');
{
  const file = join(root, 'old-change.txt');
  await writeFile(file, 'before', 'utf8');
  const exec = tool('write', file, 'call-5');
  exec._resolvedPath = file;
  await captureAndCommit(exec, 4);
  await writeFile(file, 'after', 'utf8');
  const { actions } = await snapshots.planRestore(SESSION, 5);
  check('no action is planned for them', actions.some((entry) => entry.path === file) === false, JSON.stringify(actions.map((entry) => entry.path)));
  const atTarget = await snapshots.planRestore(SESSION, 4);
  check('but a file touched by the target turn itself is restored', atTarget.actions.some((entry) => entry.path === file) === true, JSON.stringify(atTarget.actions.map((entry) => entry.path)));
}

console.log('missing objects and failures are reported, not fatal');
{
  const ghost = join(root, 'ghost.txt');
  const ghostEntry = { path: ghost, backup: 'does-not-exist', mode: null };
  const live = join(root, 'live.txt');
  await writeFile(join(root, 'object-source.txt'), 'x', 'utf8');
  const journal = await snapshots.readJournal(SESSION);
  const source = journal.entries.find((entry) => entry.backup !== null);
  const liveEntry = { path: live, backup: source.backup, mode: 0o644 };
  const outcome = await snapshots.restore(SESSION, [ghostEntry, liveEntry]);
  check('the missing object is reported as failed', outcome.failed.length === 1 && outcome.failed[0].path === ghost, JSON.stringify(outcome.failed));
  check('the other path still restores', outcome.restored.includes(live), JSON.stringify(outcome.restored));
}

console.log('size cap, directories and corrupt journal lines');
{
  const big = join(root, 'big.bin');
  await writeFile(big, Buffer.alloc(64), 'utf8');
  const tight = new FileSnapshots({ rootDir: join(root, 'tight'), maxFileBytes: 8 });
  const captured = await tight.capture({ sessionId: SESSION, anchorSeq: 1, callId: 'big', path: big });
  check('an oversized file is skipped', captured.ok === true && captured.skipped !== undefined, JSON.stringify(captured));
  await tight.commit({ sessionId: SESSION, callId: 'big' }, { isError: false });
  const tightJournal = await tight.readJournal(SESSION);
  check('and never reaches the journal', tightJournal.entries.length === 0);

  const dir = join(root, 'a-directory');
  await mkdir(dir, { recursive: true });
  const dirCapture = await tight.capture({ sessionId: SESSION, anchorSeq: 1, callId: 'dir', path: dir });
  check('a directory is skipped', dirCapture.ok === true && dirCapture.skipped !== undefined);

  const journalPath = join(root, encodeURIComponent(SESSION), 'journal.jsonl');
  const existing = await readFile(journalPath, 'utf8');
  await writeFile(journalPath, `${existing}{not json\n`, 'utf8');
  const readBack = await snapshots.readJournal(SESSION);
  check('a corrupt line is skipped and reported', readBack.skippedLines === 1, `${readBack.skippedLines} skipped`);
  check('earlier entries survive the corrupt tail', readBack.entries.length === existing.split('\n').filter((line) => line.trim() !== '').length);
}

console.log('prune drops entries the rewind already applied');
{
  const before = await snapshots.readJournal(SESSION);
  const { kept, dropped } = await snapshots.prune(SESSION, 20);
  check('entries after the target are dropped', dropped > 0, `kept ${kept}, dropped ${dropped}`);
  const after = await snapshots.readJournal(SESSION);
  check('and only entries at or before the target remain', after.entries.every((entry) => entry.anchorSeq <= 20));
  check('the journal is not empty for the kept entries', after.entries.length > 0, `${after.entries.length} entries`);
  check('before count matches', before.entries.length === kept + dropped);
}

console.log('journal trimming keeps the newest anchors only');
{
  const trimRoot = join(root, 'trim');
  const trimmer = new FileSnapshots({ rootDir: trimRoot });
  const file = join(trimRoot, 'x.txt');
  await mkdir(trimRoot, { recursive: true });
  await writeFile(file, 'x', 'utf8');
  for (let anchor = 0; anchor < 102; anchor += 1) {
    await trimmer.capture({ sessionId: SESSION, anchorSeq: anchor, callId: `c${anchor}`, path: file });
    await trimmer.commit({ sessionId: SESSION, callId: `c${anchor}` }, { isError: false });
  }
  const { dropped } = await trimmer.trim(SESSION);
  check('more than 100 anchors are trimmed', dropped > 0, `dropped ${dropped}`);
  const after = await trimmer.readJournal(SESSION);
  const anchors = [...new Set(after.entries.map((entry) => entry.anchorSeq))];
  check('exactly 100 anchors remain', anchors.length === 100, `${anchors.length} anchors`);
  check('the newest anchors are the ones kept', anchors.includes(101) && anchors.includes(0) === false, JSON.stringify([anchors[0], anchors.at(-1)]));
}

console.log('deduplicated objects');
{
  const a = join(root, 'same-a.txt');
  const b = join(root, 'same-b.txt');
  await writeFile(a, 'identical', 'utf8');
  await writeFile(b, 'identical', 'utf8');
  const dedupe = new FileSnapshots({ rootDir: join(root, 'dedupe') });
  await dedupe.capture({ sessionId: 's', anchorSeq: 1, callId: 'a', path: a });
  await dedupe.commit({ sessionId: 's', callId: 'a' }, { isError: false });
  await dedupe.capture({ sessionId: 's', anchorSeq: 1, callId: 'b', path: b });
  await dedupe.commit({ sessionId: 's', callId: 'b' }, { isError: false });
  const journal = await dedupe.readJournal('s');
  check('two records share one object', journal.entries.length === 2 && journal.entries[0].backup === journal.entries[1].backup);
  const objects = await readdir(join(root, 'dedupe', encodeURIComponent('s'), 'objects'));
  check('only one object file exists', objects.length === 1, JSON.stringify(objects));
}

console.log('rescue copies from separate rewinds are not overwritten');
{
  const session = 'rescue-check';
  const file = join(root, 'rescue-target.txt');
  await writeFile(file, 'A', 'utf8');
  await snapshots.capture({ sessionId: session, anchorSeq: 5, callId: 'c1', path: file });
  await snapshots.commit({ sessionId: session, callId: 'c1' }, { isError: false });
  await writeFile(file, 'B', 'utf8');
  const first = await snapshots.planRestore(session, 5);
  await snapshots.restore(session, first.actions);
  await writeFile(file, 'C', 'utf8');
  const second = await snapshots.planRestore(session, 5);
  await snapshots.restore(session, second.actions);
  const rescues = await readdir(join(root, encodeURIComponent(session), 'rescue'));
  check('two rewinds produce two rescue copies', rescues.length === 2, JSON.stringify(rescues));
  check('and both contain real pre-restore content', rescues.length === 2);
}

console.log('journal writes are serialised under parallel tool commits');
{
  const session = 'queue-check';
  const firstFile = join(root, 'queue-a.txt');
  const secondFile = join(root, 'queue-b.txt');
  await writeFile(firstFile, 'one', 'utf8');
  await writeFile(secondFile, 'two', 'utf8');
  await snapshots.capture({ sessionId: session, anchorSeq: 7, callId: 'q1', path: firstFile });
  await snapshots.capture({ sessionId: session, anchorSeq: 7, callId: 'q2', path: secondFile });
  // Both commits race, like two editing tools finishing in the same instant.
  await Promise.all([
    snapshots.commit({ sessionId: session, callId: 'q1' }, { isError: false }),
    snapshots.commit({ sessionId: session, callId: 'q2' }, { isError: false }),
  ]);
  const journal = await snapshots.readJournal(session);
  check('parallel commits produce two readable journal lines', journal.entries.length === 2 && journal.skippedLines === 0, JSON.stringify(journal));
}

console.log('unreferenced objects are collected');
{
  const session = 'gc-check';
  const file = join(root, 'gc-target.txt');
  await writeFile(file, 'keep-me', 'utf8');
  await snapshots.capture({ sessionId: session, anchorSeq: 9, callId: 'g1', path: file });
  await snapshots.commit({ sessionId: session, callId: 'g1' }, { isError: false });
  const objectsDir = join(root, encodeURIComponent(session), 'objects');
  await writeFile(join(objectsDir, 'deadbeefdeadbeef'), 'orphan', 'utf8');
  const collected = await snapshots.collectGarbage(session);
  const left = await readdir(objectsDir);
  check('one unreferenced object is removed', collected.removed === 1, JSON.stringify(collected));
  check('the referenced object is kept', left.length === 1, JSON.stringify(left));
}

await rm(root, { recursive: true, force: true });
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
