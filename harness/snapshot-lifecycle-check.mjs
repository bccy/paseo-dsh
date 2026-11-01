/**
 * Capture order for file snapshots must survive a process restart.
 *
 * `FileSnapshots.#captureSequence` used to be a plain process-local counter
 * starting at 0. A restart therefore rewound it, the second process's captures
 * ranked *earlier* than the first process's, and a rewind could restore an
 * intermediate version of a path touched in both while reporting success.
 *
 * The fix resumes the retained journal's high-water mark and marks every line it
 * writes with `captureOrderVersion`. A pre-migration line (no version) carries a
 * number from a counter that restarted per process, which within one path is
 * indistinguishable from a valid reverse commit — so `planRestore` refuses that
 * journal instead of guessing, and keeps the journal and its backups as evidence.
 *
 * ## What is pinned, and the boundary the code actually proves
 *
 *   1. a second instance continues the first one's numbering, and a rewind across
 *      that boundary restores the original pre-image
 *   2. the parallel parent/child case (captures in one order, commits in the
 *      opposite) still restores the earliest capture, including across a restart
 *   3. a process that loses and regains writer ownership re-reads the high water
 *      another process advanced (`beginOwner`), so its next capture sorts after
 *   4. an ambiguous **pre-migration** journal is refused before anything is
 *      written, and the journal + target file are left intact
 *   5. a single old pre-image for a path remains usable — there is nothing to
 *      choose between
 *   6. **the boundary**: two *different* paths whose old numbers disagree are
 *      **not** refused. Only one path's order decides one path's restore, so
 *      cross-path disagreement is not evidence of a counter reset. This case is
 *      here because the fix's comment claims "per path", and a check that only
 *      ever exercises one path cannot tell "per path" from "per journal".
 *
 * No DSH, no profile, no daemon: a private temp directory and the module under
 * test. Run:
 *
 *   node harness/snapshot-lifecycle-check.mjs
 *
 * **动了 `file-snapshots.js` 的 `#captureSequence` / `#nextCaptureSequence` /
 * `captureOrderVersion` / `planRestore` 的旧日志判定，或 `server.js` 的
 * `beginOwner` 接线必跑。**
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSnapshots } from '../dsh-bridge/lib/file-snapshots.js';

let passed = 0;
function pass(label) {
  passed += 1;
  console.log(`  PASS  ${label}`);
}

const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-lifecycle-'));
try {
  const options = { rootDir: join(root, 'state') };
  const file = join(root, 'target');
  const warm = join(root, 'warm');
  await writeFile(file, 'ORIGINAL');
  await writeFile(warm, 'warm');

  // -------------------------------------------------------------------------
  // 1. A restart must continue the numbering, not restart it.
  //
  // The warm-up capture is discarded on purpose: it proves the high water covers
  // numbers that were *allocated* but never written, which a read of the journal
  // alone would miss if the allocation happened after the read.
  // -------------------------------------------------------------------------
  const before = new FileSnapshots(options);
  await before.capture({ sessionId: 's', anchorSeq: 10, callId: 'warm', path: warm });
  before.discard({ sessionId: 's', callId: 'warm' });
  await before.capture({ sessionId: 's', anchorSeq: 20, callId: 'old', path: file });
  await writeFile(file, 'INTERMEDIATE');
  await before.commit({ sessionId: 's', callId: 'old' }, {});

  const after = new FileSnapshots(options);
  await after.capture({ sessionId: 's', anchorSeq: 30, callId: 'new', path: file });
  await writeFile(file, 'LATEST');
  await after.commit({ sessionId: 's', callId: 'new' }, {});

  const journal = await after.readJournal('s');
  assert.ok(
    journal.entries[1].captureSeq > journal.entries[0].captureSeq,
    `a restarted process must resume the durable high water (got ${String(journal.entries[1].captureSeq)} after ${String(journal.entries[0].captureSeq)})`,
  );
  assert.equal(journal.entries[1].captureOrderVersion, 1, 'a numbered line carries the version marker');
  await after.restore('s', (await after.planRestore('s', 20)).actions);
  assert.equal(await readFile(file, 'utf8'), 'ORIGINAL');
  pass('a restart resumes the durable capture order and restores the original pre-image');

  // -------------------------------------------------------------------------
  // 2. Reverse commit order must still be ranked by capture, across a restart.
  // -------------------------------------------------------------------------
  await writeFile(file, 'ORIGINAL');
  const current = new FileSnapshots(options);
  await current.capture({ sessionId: 's', anchorSeq: 40, callId: 'first', path: file });
  await writeFile(file, 'FIRST');
  await current.capture({ sessionId: 's', anchorSeq: 40, callId: 'second', path: file });
  await writeFile(file, 'SECOND');
  await current.commit({ sessionId: 's', callId: 'second' }, {});
  await current.commit({ sessionId: 's', callId: 'first' }, {});

  const restarted = new FileSnapshots(options);
  await restarted.restore('s', (await restarted.planRestore('s', 40)).actions);
  assert.equal(await readFile(file, 'utf8'), 'ORIGINAL');
  pass('reverse commit order still restores the earliest capture after another restart');

  // -------------------------------------------------------------------------
  // 3. Writer handoff: a process that was NOT the owner must re-read.
  //
  // A stays alive while B owns the journal and advances it, then A takes over
  // again. Without `beginOwner` A keeps its cached floor and its next capture
  // sorts *before* B's, which is the same wrong-pre-image bug in a live process.
  // -------------------------------------------------------------------------
  await writeFile(file, 'HANDOFF_ORIGINAL');
  const ownerA = new FileSnapshots({ rootDir: join(root, 'handoff') });
  const ownerB = new FileSnapshots({ rootDir: join(root, 'handoff') });
  await ownerA.capture({ sessionId: 's', anchorSeq: 10, callId: 'a1', path: file });
  await writeFile(file, 'AFTER_A');
  await ownerA.commit({ sessionId: 's', callId: 'a1' }, {});
  await ownerB.capture({ sessionId: 's', anchorSeq: 20, callId: 'b', path: file });
  await writeFile(file, 'AFTER_B');
  await ownerB.commit({ sessionId: 's', callId: 'b' }, {});
  ownerA.beginOwner('s');
  await ownerA.capture({ sessionId: 's', anchorSeq: 30, callId: 'a2', path: file });
  await writeFile(file, 'AFTER_A_AGAIN');
  await ownerA.commit({ sessionId: 's', callId: 'a2' }, {});

  const handed = await ownerA.readJournal('s');
  assert.ok(
    handed.entries[2].captureSeq > handed.entries[1].captureSeq,
    `a reused process must refresh its high water after a handoff (got ${String(handed.entries[2].captureSeq)} after ${String(handed.entries[1].captureSeq)})`,
  );
  await ownerA.restore('s', (await ownerA.planRestore('s', 20)).actions);
  assert.equal(await readFile(file, 'utf8'), 'AFTER_A');
  pass('a reused process refreshes the capture high water after a writer handoff');

  // -------------------------------------------------------------------------
  // 4/5. Pre-migration ambiguity: refuse the unprovable, keep the provable.
  // -------------------------------------------------------------------------
  await writeFile(file, 'ORIGINAL');
  const legacyJournal = (entries) => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';

  // Two old lines for one path with different pre-images: the counter may have
  // reset, so which one is earlier cannot be decided.
  const ambiguous = [
    { ...journal.entries[0], captureOrderVersion: undefined },
    { ...journal.entries[1], captureSeq: 1, captureOrderVersion: undefined },
  ];
  const ambiguousText = legacyJournal(ambiguous);
  await writeFile(after.journalPath('s'), ambiguousText);
  await assert.rejects(
    new FileSnapshots(options).planRestore('s', 20),
    /cannot prove file snapshot capture order/,
    'an ambiguous pre-migration journal must be refused',
  );
  assert.equal(await readFile(after.journalPath('s'), 'utf8'), ambiguousText, 'the refused journal is retained as evidence');
  assert.equal(await readFile(file, 'utf8'), 'ORIGINAL', 'planning cannot change the target file');
  pass('an ambiguous pre-migration journal is refused before any mutation, with evidence retained');

  // A single old pre-image for a path has nothing to choose between.
  const singleOld = [
    { ...journal.entries[0], captureOrderVersion: undefined },
    journal.entries[1],
  ];
  await writeFile(after.journalPath('s'), legacyJournal(singleOld));
  const singlePlan = await new FileSnapshots(options).planRestore('s', 20);
  assert.equal(singlePlan.actions.length, 1);
  assert.equal(singlePlan.actions[0].backup, journal.entries[0].backup);
  pass('a single pre-migration pre-image for a path stays usable');

  // An old line that FOLLOWS a numbered line for the same path is a reset the
  // migration cannot explain: the numbered line proves this build already wrote
  // to that journal, so a version-less line after it means a downgraded writer.
  const oldAfterNew = [
    journal.entries[0],
    { ...journal.entries[1], captureSeq: 1, captureOrderVersion: undefined },
  ];
  await writeFile(after.journalPath('s'), legacyJournal(oldAfterNew));
  await assert.rejects(
    new FileSnapshots(options).planRestore('s', 20),
    /cannot prove file snapshot capture order/,
    'a version-less line after a numbered one must be refused',
  );
  pass('a pre-migration line that follows a numbered line for the same path is refused');

  // -------------------------------------------------------------------------
  // 6. The boundary the comment claims: per PATH, not per journal.
  //
  // Two different paths, each with one old line, whose old numbers disagree
  // (2 then 1). No restore decision depends on their relative order, so this
  // must NOT be refused. A check that only used one path could not tell this
  // apart from an implementation that refuses the whole journal.
  // -------------------------------------------------------------------------
  const pathA = join(root, 'cross-a');
  const pathB = join(root, 'cross-b');
  await writeFile(pathA, 'A_ORIGINAL');
  await writeFile(pathB, 'B_ORIGINAL');
  const crossPath = [
    { anchorSeq: 20, captureSeq: 2, path: pathA, backup: 'a'.repeat(64), mode: 420 },
    { anchorSeq: 20, captureSeq: 1, path: pathB, backup: 'b'.repeat(64), mode: 420 },
  ];
  await writeFile(after.journalPath('s'), legacyJournal(crossPath));
  const crossPlan = await new FileSnapshots(options).planRestore('s', 20);
  assert.equal(crossPlan.actions.length, 2, 'cross-path disagreement must not be refused');
  assert.deepEqual(
    crossPlan.actions.map((action) => action.path).sort(),
    [pathA, pathB].sort(),
    'both paths must appear in the plan',
  );
  pass('two paths whose old numbers disagree are NOT refused (the judgement is per path)');

  // Positive control for the same shape: make ONE of those paths carry two
  // different pre-images, and the same journal must be refused. Without this the
  // assertion above could pass for an implementation that never refuses anything.
  const onePathAmbiguous = [
    ...crossPath,
    { anchorSeq: 20, captureSeq: 1, path: pathA, backup: 'c'.repeat(64), mode: 420 },
  ];
  await writeFile(after.journalPath('s'), legacyJournal(onePathAmbiguous));
  await assert.rejects(
    new FileSnapshots(options).planRestore('s', 20),
    /cannot prove file snapshot capture order/,
    'the same journal must be refused once one path has two old pre-images',
  );
  pass('…while the same journal IS refused once one path carries two old pre-images');

  console.log(`\n  ${passed}/${passed} passed`);
} finally {
  await rm(root, { recursive: true, force: true });
}
