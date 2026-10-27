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
 * - `write`/`edit` are not the only tracked tools: `str_replace_editor` names the
 *   file with `path` and only its writing commands (`create`/`str_replace`/
 *   `insert`) count — `view`, an unknown command or a missing path are not edits;
 * - the current content is rescued before restore overwrites it, and one failed
 *   path does not abort the rest.
 *
 * Uses a real temp directory, so the journal/objects/rescue layout is exercised
 * as written, not mocked.
 *
 * Usage: node harness/file-snapshot-check.mjs
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
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

  // `str_replace_editor` names the file with `path` and only three of its
  // commands write. Getting this wrong is silent in both directions: a missing
  // entry lets a `both` rewind report success while the file stays modified, and
  // a read command would journal an edit that never happened. Driven through the
  // real bridge module (`mutationPathOf`), not the source text.
  const editor = (command, path) => ({ name: 'str_replace_editor', arguments: { command, path } });
  check("str_replace_editor 'create' takes path as the edit", mutationPathOf(editor('create', 'new.txt')) === 'new.txt');
  check(
    "str_replace_editor 'str_replace' takes path as the edit",
    mutationPathOf(editor('str_replace', 'a.txt')) === 'a.txt',
  );
  check("str_replace_editor 'insert' takes path as the edit", mutationPathOf(editor('insert', 'a.txt')) === 'a.txt');
  check("str_replace_editor 'view' is not an edit", mutationPathOf(editor('view', 'a.txt')) === undefined);
  check(
    'an unrecognized command or a missing path is not an edit',
    mutationPathOf(editor('undo_edit', 'a.txt')) === undefined &&
      mutationPathOf({ name: 'str_replace_editor', arguments: { command: 'str_replace' } }) === undefined,
    'unknown command and missing path both yield no mutation',
  );
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

console.log('journal trimming drops only unreachable anchors');
{
  const trimRoot = join(root, 'trim');
  const trimmer = new FileSnapshots({ rootDir: trimRoot, warn: (line) => warnings.push(line) });
  const file = join(trimRoot, 'x.txt');
  await mkdir(trimRoot, { recursive: true });
  await writeFile(file, 'x', 'utf8');
  for (let anchor = 0; anchor < 102; anchor += 1) {
    await trimmer.capture({ sessionId: SESSION, anchorSeq: anchor, callId: `c${anchor}`, path: file });
    await trimmer.commit({ sessionId: SESSION, callId: `c${anchor}` }, { isError: false });
  }
  const reachable = await trimmer.trim(SESSION, 60);
  const after = await trimmer.readJournal(SESSION);
  check('entries below the oldest rewindable anchor are dropped', reachable.dropped === 60, `dropped ${reachable.dropped}`);
  check('and every reachable entry stays', after.entries.length === 42 && after.entries.every((entry) => entry.anchorSeq >= 60), `${after.entries.length} entries`);
  await trimmer.trim(SESSION, Number.POSITIVE_INFINITY);
  check('no visible rewind target drops the whole journal', (await trimmer.readJournal(SESSION)).entries.length === 0);

  const capRoot = join(root, 'trim-cap');
  const capWarnings = [];
  const capped = new FileSnapshots({ rootDir: capRoot, warn: (line) => capWarnings.push(line) });
  const capFile = join(capRoot, 'y.txt');
  await mkdir(capRoot, { recursive: true });
  await writeFile(capFile, 'y', 'utf8');
  for (let anchor = 0; anchor < 1002; anchor += 1) {
    await capped.capture({ sessionId: SESSION, anchorSeq: anchor, callId: `k${anchor}`, path: capFile });
    await capped.commit({ sessionId: SESSION, callId: `k${anchor}` }, { isError: false });
  }
  const capResult = await capped.trim(SESSION, 0);
  const capAnchors = new Set((await capped.readJournal(SESSION)).entries.map((entry) => entry.anchorSeq));
  check('the hard cap keeps the newest anchors', capAnchors.size === 1000 && capAnchors.has(1001) && !capAnchors.has(0), `${capAnchors.size} anchors`);
  check(
    'and reports the cap loudly',
    capResult.capped === true && capWarnings.some((line) => line.includes('capped at')),
    JSON.stringify(capWarnings.slice(-1)),
  );
}

console.log('a delegated edit and a root edit with the same callId stay separate');
{
  const session = 'pending-scope';
  const firstFile = join(root, 'pending-root.txt');
  const secondFile = join(root, 'pending-child.txt');
  await writeFile(firstFile, 'ROOT', 'utf8');
  await writeFile(secondFile, 'CHILD', 'utf8');
  const scoped = new FileSnapshots({ rootDir: join(root, 'pending'), warn: (line) => warnings.push(line) });
  // Same provider-minted callId, different executing sessions: an owner-scoped
  // key alone would let the second capture overwrite the first pending entry.
  await scoped.capture({ sessionId: session, pendingKey: 'root:call_0', anchorSeq: 5, callId: 'call_0', path: firstFile });
  await scoped.capture({ sessionId: session, pendingKey: 'child:call_0', anchorSeq: 5, callId: 'call_0', path: secondFile });
  await Promise.all([
    scoped.commit({ sessionId: session, pendingKey: 'root:call_0', callId: 'call_0' }, { isError: false }),
    scoped.commit({ sessionId: session, pendingKey: 'child:call_0', callId: 'call_0' }, { isError: false }),
  ]);
  const journal = await scoped.readJournal(session);
  const paths = journal.entries.map((entry) => entry.path);
  check(
    'both pending entries commit under their own key',
    journal.entries.length === 2 && paths.includes(firstFile) && paths.includes(secondFile),
    JSON.stringify(paths),
  );
}

console.log('a rewind restores the state before the earliest capture');
{
  const session = 'capture-order';
  const file = join(root, 'capture-order.txt');
  await writeFile(file, 'BASE', 'utf8');
  const ordered = new FileSnapshots({ rootDir: join(root, 'order'), warn: (line) => warnings.push(line) });
  // Parent captures first, then the child captures; the child commits first
  // (parallel tool calls can finish out of order).
  await ordered.capture({ sessionId: session, pendingKey: 'p1', anchorSeq: 5, callId: 'c1', path: file });
  await writeFile(file, 'PARENT', 'utf8');
  await ordered.capture({ sessionId: session, pendingKey: 'p2', anchorSeq: 5, callId: 'c2', path: file });
  await writeFile(file, 'CHILD', 'utf8');
  await ordered.commit({ sessionId: session, pendingKey: 'p2', callId: 'c2' }, { isError: false });
  await ordered.commit({ sessionId: session, pendingKey: 'p1', callId: 'c1' }, { isError: false });
  const plan = await ordered.planRestore(session, 5);
  await ordered.restore(session, plan.actions);
  check('the earliest captured pre-image wins over commit order', (await readFile(file, 'utf8')) === 'BASE');
}

console.log('a hostile journal cannot make the rewind escape the session');
{
  const session = 'guard';
  const sessionDir = join(root, encodeURIComponent(session));
  await mkdir(sessionDir, { recursive: true });
  const outside = join(root, 'guard-outside.txt');
  await writeFile(outside, 'SAFE', 'utf8');
  const link = join(root, 'guard-link.txt');
  await rm(link, { force: true });
  await symlink(outside, link);
  const lines = [
    JSON.stringify({ anchorSeq: 5, path: 'relative.txt', backup: null }),
    JSON.stringify({ anchorSeq: 5, path: join(root, 'guard-escape.txt'), backup: '../../../../etc/passwd' }),
    JSON.stringify({ anchorSeq: 5, path: link, backup: null }),
  ].join('\n');
  await writeFile(join(sessionDir, 'journal.jsonl'), `${lines}\n`, 'utf8');
  const read = await snapshots.readJournal(session);
  check('relative paths and traversal-prone backups are skipped', read.entries.length === 1 && read.skippedLines === 2, JSON.stringify(read));
  const plan = await snapshots.planRestore(session, 5);
  const outcome = await snapshots.restore(session, plan.actions);
  check(
    'a symlinked target is skipped, never deleted',
    outcome.skipped.includes(link) && existsSync(link) && (await readFile(outside, 'utf8')) === 'SAFE',
    JSON.stringify(outcome.skipped),
  );
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
  const rescueBodies = await Promise.all(
    rescues.map((name) => readFile(join(root, encodeURIComponent(session), 'rescue', name), 'utf8')),
  );
  check(
    'and both contain real pre-restore content',
    rescueBodies.includes('B') && rescueBodies.includes('C'),
    JSON.stringify(rescueBodies),
  );
}

console.log('rescue copies are unique even inside one millisecond');
{
  const session = 'rescue-same-ms';
  const file = join(root, 'rescue-same-ms.txt');
  await writeFile(file, 'A', 'utf8');
  await snapshots.capture({ sessionId: session, anchorSeq: 5, callId: 'ms1', path: file });
  await snapshots.commit({ sessionId: session, callId: 'ms1' }, { isError: false });
  await writeFile(file, 'B', 'utf8');
  // Pin the clock so both rewinds provably land in the same millisecond: that is
  // the window the old name format collided in, and leaving it to chance made this
  // a 1-in-10 flake instead of a test. Restored in `finally` so the checks below
  // still see the real clock.
  //
  // This is the assertion that catches the original defect: with a counter local to
  // `restore()` the second copy is named `<ts>-1-…` again and overwrites the first,
  // leaving one file holding 'C' and 'B' gone forever.
  const realNow = Date.now;
  Date.now = () => 1700000000000;
  try {
    const firstMs = await snapshots.planRestore(session, 5);
    await snapshots.restore(session, firstMs.actions);
    await writeFile(file, 'C', 'utf8');
    const secondMs = await snapshots.planRestore(session, 5);
    await snapshots.restore(session, secondMs.actions);
  } finally {
    Date.now = realNow;
  }
  const msDir = join(root, encodeURIComponent(session), 'rescue');
  const msFiles = (await readdir(msDir)).sort();
  check('same-millisecond rewinds produce two rescue copies', msFiles.length === 2, JSON.stringify(msFiles));
  const msBodies = await Promise.all(msFiles.map((name) => readFile(join(msDir, name), 'utf8')));
  check(
    'both same-millisecond copies keep their own pre-restore content',
    msBodies.includes('B') && msBodies.includes('C'),
    JSON.stringify(msBodies),
  );
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
  const gc = new FileSnapshots({ rootDir: root, warn: (line) => warnings.push(line), gcGraceMs: 0 });
  await gc.capture({ sessionId: session, anchorSeq: 9, callId: 'g1', path: file });
  await gc.commit({ sessionId: session, callId: 'g1' }, { isError: false });
  const objectsDir = join(root, encodeURIComponent(session), 'objects');
  await writeFile(join(objectsDir, 'deadbeefdeadbeef'), 'orphan', 'utf8');
  // Age the orphan explicitly rather than assuming a just-written file has
  // `mtime <= Date.now()`. The GC keeps any object whose mtime is inside the
  // grace window (`Date.now() - mtimeMs < gcGraceMs`), which is the safe
  // direction — but a CI runner whose clock steps back (NTP correction) or a
  // filesystem whose timestamps run slightly ahead makes a fresh file compare
  // as recent even with `gcGraceMs: 0`, so this case failed over collection it
  // never exercised: 2026-10-27 Sync upstream gate, 54/56,
  // `{"removed":0,"keptRecent":1}` and `["c1a66b9d…","deadbeefdeadbeef"]`.
  // The case is "an unreferenced object *verified old* is removed", so make it
  // old. (The grace-period case below still covers the fresh-file guard.)
  const old = new Date(Date.now() - 60_000);
  await utimes(join(objectsDir, 'deadbeefdeadbeef'), old, old);
  const collected = await gc.collectGarbage(session);
  const left = await readdir(objectsDir);
  check('one unreferenced object is removed', collected.removed === 1, JSON.stringify(collected));
  check('the referenced object is kept', left.length === 1, JSON.stringify(left));

  // A capture whose journal line is still in flight must survive GC.
  const pendingFile = join(root, 'gc-pending.txt');
  await writeFile(pendingFile, 'not-committed-yet', 'utf8');
  await gc.capture({ sessionId: session, anchorSeq: 10, callId: 'g2', path: pendingFile });
  const pendingBackup = [...gc.pending.values()].find((entry) => typeof entry?.backup === 'string')?.backup;
  await gc.collectGarbage(session);
  check(
    'an uncommitted capture protects its object',
    typeof pendingBackup === 'string' && existsSync(join(objectsDir, pendingBackup)),
    String(pendingBackup),
  );
  gc.discard({ sessionId: session, callId: 'g2' });

  // A just-written unreferenced object is protected by the grace period.
  const young = new FileSnapshots({ rootDir: root, warn: (line) => warnings.push(line) });
  await writeFile(join(objectsDir, 'feedfacefeedface'), 'young', 'utf8');
  const swept = await young.collectGarbage(session);
  check(
    'a freshly written unreferenced object is kept (race guard)',
    swept.keptRecent >= 1 && existsSync(join(objectsDir, 'feedfacefeedface')),
    JSON.stringify(swept),
  );
}

await rm(root, { recursive: true, force: true });
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
