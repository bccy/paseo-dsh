/**
 * Offline check for parent/child file-snapshot attribution in the rewind.
 *
 * A native subagent edits files from its own session; a human rewinds the ROOT
 * session, whose journal is the only one the rewind reads. This pins the two
 * halves of the fix without starting a provider:
 *
 * 1. `rootSessionFor` resolution (`dsh-bridge/lib/snapshot-owners.js`): child and
 *    grandchild resolve to the root, a depth-only header still walks up, and a
 *    broken chain (missing parent, dead parent, lineage loop) fails open.
 * 2. The resulting journal attribution (`dsh-bridge/lib/file-snapshots.js`): a
 *    child edit captured under the resolved root lands in the ROOT journal with
 *    the root's anchor, the child gets no journal of its own, a rewind plan from
 *    the root restores/deletes it, and independent session trees never cross.
 *
 * The bridge's `captureFileBeforeTool`/`commitFileTool` wiring is exactly these
 * two calls in sequence; the real-machine probe covers the wiring end to end.
 *
 * Usage: node harness/rewind-merge-check.mjs
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSnapshots, isTrackedTool, resolveMutationPath } from '../dsh-bridge/lib/file-snapshots.js';
import { isDelegatedSession, rootSessionFor, snapshotOwnerKey } from '../dsh-bridge/lib/snapshot-owners.js';
import { ChildAnchors } from '../dsh-bridge/lib/child-anchors.js';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

const journalRoot = await mkdtemp(join(tmpdir(), 'paseo-rewind-merge-journals-'));
const workspace = await mkdtemp(join(tmpdir(), 'paseo-rewind-merge-files-'));
const snapshots = new FileSnapshots({ rootDir: journalRoot, warn: () => {} });

/**
 * A session stand-in with just the header fields the resolution reads.
 *
 * `workingDir` models the `workingDirectory` service's committed current
 * directory. It is deliberately separate from `header.cwd`: a subagent's header
 * cwd is COPIED from its parent (the durable original project directory) while
 * its actual working directory is its own `cwd` argument — resolving against the
 * header would snapshot the wrong file.
 */
const session = ({ id, cwd = workspace, workingDir = cwd, origin, parentSession, delegationDepth }) => ({
  id,
  workingDir,
  header: {
    id,
    cwd,
    ...(origin === undefined ? {} : { origin }),
    ...(parentSession === undefined ? {} : { parentSession }),
    ...(delegationDepth === undefined ? {} : { delegationDepth }),
  },
});

const root = session({ id: 'root-1' });
const child = session({ id: 'child-1', origin: 'subagent', parentSession: 'root-1', delegationDepth: 1 });
const grand = session({ id: 'grand-1', origin: 'subagent', parentSession: 'child-1', delegationDepth: 2 });
const depthOnly = session({ id: 'depth-1', delegationDepth: 1, parentSession: 'root-1' });
const orphan = session({ id: 'orphan-1', origin: 'subagent', parentSession: 'ghost-1', delegationDepth: 1 });
const noParent = session({ id: 'noparent-1', origin: 'subagent', delegationDepth: 1 });
const loopA = session({ id: 'loop-a', origin: 'subagent', parentSession: 'loop-b', delegationDepth: 1 });
const loopB = session({ id: 'loop-b', origin: 'subagent', parentSession: 'loop-a', delegationDepth: 2 });
const root2 = session({ id: 'root-2' });
const child2 = session({ id: 'child-2', origin: 'subagent', parentSession: 'root-2', delegationDepth: 1 });
// A forked child carries a `parentSession` but is not delegated: it must stop at
// itself, or the owner would jump into the source conversation.
const forked = session({ id: 'fork-1', parentSession: 'root-1' });
// A subagent whose `cwd` argument is a subdirectory: header cwd stays the
// parent's, the committed working directory is the child's own.
const subChild = session({
  id: 'child-sub',
  origin: 'subagent',
  parentSession: 'root-1',
  delegationDepth: 1,
  cwd: workspace,
  workingDir: join(workspace, 'sub'),
});

const allSessions = [root, child, grand, depthOnly, orphan, noParent, loopA, loopB, root2, child2, subChild, forked];
const live = new Map(allSessions.map((entry) => [entry.id, entry]));
const getSession = (id) => live.get(String(id));

/** The bridge's owner key (`sessionId:callId`); must not collide across sessions. */
const ownerKeyOf = (execSession, callId) => snapshotOwnerKey(execSession, callId);

const journal = async (sessionId) => {
  const path = join(journalRoot, sessionId, 'journal.jsonl');
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
};

/** What the bridge does for one tool call in `session` (untracked tools are ignored). */
async function trackEdit(execSession, callId, filePath, { name = 'write', anchor = 12, isError = false, content } = {}) {
  if (!isTrackedTool({ name })) return undefined;
  const owner = rootSessionFor(execSession, getSession);
  if (owner === undefined) return undefined;
  // The bridge resolves with the workingDirectory service; the fixture models
  // that committed directory with `workingDir`.
  const path = resolveMutationPath(execSession.workingDir, filePath);
  await snapshots.capture({ sessionId: String(owner.id), anchorSeq: anchor, callId, path });
  if (content !== undefined) await writeFile(path, content);
  await snapshots.commit({ sessionId: String(owner.id), callId }, { isError });
  return { owner, path };
}

console.log('== resolution ==');
check('a root session resolves to itself', rootSessionFor(root, getSession)?.id === 'root-1');
check('a child resolves to the root', rootSessionFor(child, getSession)?.id === 'root-1');
check('a grandchild resolves through the chain to the root', rootSessionFor(grand, getSession)?.id === 'root-1');
check(
  'a depth-only delegated header still walks up',
  isDelegatedSession(depthOnly) === true && rootSessionFor(depthOnly, getSession)?.id === 'root-1',
);
check('a missing parentSession fails open', rootSessionFor(noParent, getSession) === undefined);
check('a dead parent fails open', rootSessionFor(orphan, getSession) === undefined);
check('a lineage loop fails open', rootSessionFor(loopA, getSession) === undefined);
check('an undefined session fails open', rootSessionFor(undefined, getSession) === undefined);
check(
  'a forked child (parentSession, no delegation) stops at itself',
  isDelegatedSession(forked) === false && rootSessionFor(forked, getSession)?.id === 'fork-1',
);

console.log('== owner key ==');
const sameCallAcrossSessions = {
  a: ownerKeyOf(child, 'call_0'),
  b: ownerKeyOf(grand, 'call_0'),
  again: ownerKeyOf(child, 'call_0'),
  root: ownerKeyOf(root, 'call_0'),
};
check(
  'the same callId in different sessions maps to different owners keys',
  sameCallAcrossSessions.a !== sameCallAcrossSessions.b && sameCallAcrossSessions.a !== sameCallAcrossSessions.root,
  JSON.stringify(sameCallAcrossSessions),
);
check('and the same session+callId is stable', sameCallAcrossSessions.a === sameCallAcrossSessions.again);

console.log('== delegated turn anchors ==');
const anchors = new ChildAnchors();
check('a child\'s turn start records its dispatch anchor', anchors.record(child.id, 12) === true && anchors.anchorFor(child.id) === 12);
check('a resumed run refreshes the anchor', anchors.record(child.id, 40) === true && anchors.anchorFor(child.id) === 40);
check(
  'an invalid anchor is ignored',
  anchors.record('bad-child', Number.NaN) === false && anchors.record('', 12) === false && anchors.anchorFor('bad-child') === undefined,
);
check('an unobserved child has no anchor', anchors.anchorFor('never-started') === undefined);
anchors.record(child.id, 12);
anchors.record(grand.id, 12);
check(
  'a rewind at the dispatch message withdraws those children',
  anchors.withdrawnSince(12).includes(child.id) && anchors.withdrawnSince(12).includes(grand.id),
  JSON.stringify(anchors.withdrawnSince(12)),
);
check('a rewind to a later message leaves them running', anchors.withdrawnSince(13).length === 0);
check('an invalid target withdraws nothing', anchors.withdrawnSince(Number.NaN).length === 0);
// The snapshot anchor rule: a delegated edit takes the recorded dispatch anchor
// even when a newer human message has arrived (the M2 cross-turn case).
const delegatedAnchor = anchors.anchorFor(child.id);
check(
  'a delegated edit anchors to its dispatch turn, not the newest message',
  delegatedAnchor === 12,
  JSON.stringify({ delegatedAnchor, newestHuman: 33 }),
);

console.log('== journal attribution ==');
const createdByChild = join(workspace, 'child-created.txt');
const childEdit = await trackEdit(child, 'call-child-create', createdByChild, { content: 'CHILD\n' });
const rootJournal = await journal('root-1');
check('a subagent edit lands in the ROOT journal', rootJournal?.length === 1, JSON.stringify(rootJournal));
check('anchored to the root message, not the child', rootJournal?.[0]?.anchorSeq === 12, String(rootJournal?.[0]?.anchorSeq));
check('with the subagent path recorded', rootJournal?.[0]?.path === createdByChild);
check('the child gets no journal of its own', (await journal('child-1')) === undefined);
check('the resolved owner is the root', childEdit?.owner?.id === 'root-1');

const editedByGrand = join(workspace, 'grand-edited.txt');
await writeFile(editedByGrand, 'V1\n');
await trackEdit(grand, 'call-grand-edit', editedByGrand, { content: 'V2\n' });
const grandLine = (await journal('root-1'))?.find((line) => line.path === editedByGrand);
check('a grandchild edit also lands in the root journal', grandLine !== undefined);
check('with the pre-edit content backed up', typeof grandLine?.backup === 'string');
check('the grandchild gets no journal of its own', (await journal('grand-1')) === undefined);

await mkdir(join(workspace, 'sub'), { recursive: true });
await trackEdit(subChild, 'call-child-relative', 'relative.txt', { content: 'REL\n' });
check(
  'a relative path resolves against the committed working directory, not header.cwd',
  subChild.header.cwd === workspace
    && (await journal('root-1'))?.some((line) => line.path === join(workspace, 'sub', 'relative.txt')),
  JSON.stringify({ headerCwd: subChild.header.cwd, workingDir: subChild.workingDir }),
);
check('and is still journaled under the root', (await journal('child-sub')) === undefined);

console.log('== same path, parent then child ==');
const sharedPath = join(workspace, 'shared.txt');
await writeFile(sharedPath, 'BASE\n');
await trackEdit(root, 'call-parent-shared', sharedPath, { content: 'FROM-PARENT\n' });
await trackEdit(child, 'call-child-shared', sharedPath, { content: 'FROM-CHILD\n' });
const sharedLines = ((await journal('root-1')) ?? []).filter((line) => line.path === sharedPath);
check('parent and child writes to the same path leave two journal lines', sharedLines.length === 2, JSON.stringify(sharedLines.map((line) => line.callId)));

const beforeIgnored = (await journal('root-1'))?.length ?? 0;
await trackEdit(child, 'call-child-failed', join(workspace, 'failed.txt'), { isError: true, content: 'X\n' });
await trackEdit(child, 'call-bash-untouched', join(workspace, 'bash.txt'), { name: 'bash' });
check('a failed tool call records nothing', ((await journal('root-1'))?.length ?? 0) === beforeIgnored);
check('an untracked tool records nothing', ((await journal('root-1'))?.length ?? 0) === beforeIgnored);
check('the pending map is empty after commit', snapshots.pending.size === 0);

console.log('== broken chains ==');
const beforeBroken = (await journal('root-1'))?.length ?? 0;
await trackEdit(orphan, 'call-orphan', join(workspace, 'orphan.txt'), { content: 'O\n' });
await trackEdit(loopA, 'call-loop', join(workspace, 'loop.txt'), { content: 'L\n' });
check('broken chains record nothing', ((await journal('root-1'))?.length ?? 0) === beforeBroken);
check('and open no journal directories', (await journal('orphan-1')) === undefined && (await journal('loop-a')) === undefined);

console.log('== isolation ==');
await trackEdit(child2, 'call-root2', join(workspace, 'root2.txt'), { anchor: 5, content: 'R2\n' });
const root2Journal = await journal('root-2');
check(
  'an unrelated session tree journals under its own root',
  root2Journal?.length === 1 && root2Journal[0]?.path === join(workspace, 'root2.txt'),
  JSON.stringify(root2Journal),
);
check('and never leaks into the first tree', (await journal('root-1'))?.every((line) => !line.path.endsWith('root2.txt')));

console.log('== restore plan ==');
const plan = await snapshots.planRestore('root-1', 12);
const planned = plan.actions.map((action) => action.path);
check('a rewind to the anchor plans the child-created file', planned.includes(createdByChild));
check('and the grandchild-edited file', planned.includes(editedByGrand));
const sharedAction = plan.actions.find((action) => action.path === sharedPath);
check(
  'the earliest touch after the target decides the shared path\'s restore state',
  sharedAction !== undefined && typeof sharedAction.backup === 'string',
  JSON.stringify(sharedAction),
);
check('a rewind to a later message plans nothing', (await snapshots.planRestore('root-1', 13)).actions.length === 0);
const outcome = await snapshots.restore('root-1', plan.actions);
check('restore deletes the subagent-created file', !existsSync(createdByChild));
check('restore writes the pre-edit content back', (await readFile(editedByGrand, 'utf8')) === 'V1\n');
check('restore writes the state before the parent write back', (await readFile(sharedPath, 'utf8')) === 'BASE\n');
check('the restore receipt reports no failure', outcome.failed.length === 0, JSON.stringify(outcome.failed));

await rm(journalRoot, { recursive: true, force: true });
await rm(workspace, { recursive: true, force: true });

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
