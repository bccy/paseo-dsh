/**
 * End-to-end probe for the parent/child file-snapshot merge, against a real
 * `dsh --profile paseo`.
 *
 * The offline `harness/rewind-merge-check.mjs` pins the resolution and the
 * journal attribution with fixtures. This is the one check that runs the whole
 * chain for real — the model delegates through the `subagent` tool, the child's
 * `write` is snapshotted under the ROOT session, `paseo/revert` (scope=both)
 * restores the plan, and the receipts/log agree. It costs a few model turns and
 * is a probe, not a CI regression (like `rewind-e2e.mjs`).
 *
 * Scenario:
 *   1. turn 1: remember ALPHA (gives the session a human anchor);
 *   2. turn 2: the MAIN agent writes parent-control.txt itself, then delegates
 *      through the `subagent` tool; the child writes subagent-test.txt;
 *   3. rewinds turn 2 with scope=both — BOTH files must be deleted, the root
 *      journal must hold both lines, and the child session must own no journal;
 *   4. the replay keeps exactly the first human message.
 *
 * Usage: node harness/rewind-merge-e2e.mjs [--keep]
 * Requires a working `dsh` on PATH and the `paseo` profile. The session runs in
 * a temp directory that is removed afterwards unless `--keep` is given.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const keep = process.argv.includes('--keep');
const root = mkdtempSync(join(tmpdir(), 'rewind-merge-e2e-'));
const PROFILE = process.env.DSH_PASEO_PROFILE ?? 'paseo';
const sessionId = `rewind-merge-${Date.now()}`;
const parentFile = join(root, 'parent-control.txt');
const childFile = join(root, 'subagent-test.txt');

const child = spawn('dsh', ['--profile', PROFILE], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

let buffer = '';
let nextId = 1;
const pending = new Map();
const events = [];
const childOpened = [];
const stderr = [];

const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
const request = (method, params, timeoutMs = 240000) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
    }, timeoutMs).unref();
  });

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() === '') continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (frame.method === 'paseo/question') {
      send({ jsonrpc: '2.0', id: frame.id, result: { answers: [] } });
      continue;
    }
    if (frame.id !== undefined && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) entry.reject(new Error(JSON.stringify(frame.error)));
      else entry.resolve(frame.result);
      continue;
    }
    if (frame.method === 'session.child-opened') childOpened.push(frame.params);
    else if (frame.method === 'session.event') events.push(frame.params);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => stderr.push(chunk));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const turnEnds = (id) => events.filter((frame) => frame.sessionId === id && frame.event?.type === 'turn/end').length;
async function waitForTurns(id, count, timeoutMs = 320000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (turnEnds(id) >= count) return;
    await sleep(250);
  }
  throw new Error(`never saw turn end #${count} for ${id} (saw ${turnEnds(id)})`);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

let evidence = {};
try {
  // `sessionId` is required: `initialize` pins cwd/route FOR ONE session, and the
  // shared-process bridge refuses a prompt from a session it never initialized.
  await request('initialize', { cwd: root, sessionId });
  await request('session/prompt', {
    sessionId,
    contentBlocks: [{ type: 'text', text: '记住一个暗号：ALPHA。只回复“记住了”。' }],
  });
  await waitForTurns(sessionId, 1);
  await sleep(500);

  const second = await request('session/prompt', {
    sessionId,
    contentBlocks: [{
      type: 'text',
      text: '这一步依次做两件事，全部用 write 工具，全程不要用 bash：\n'
        + '1) 你自己用 write 在当前目录创建 parent-control.txt，内容写 PARENT-CONTROL；\n'
        + '2) 再用 subagent 工具派一个子代理，让子代理用 write 在当前目录创建 subagent-test.txt，'
        + '内容写 SUBAGENT-TEST；子代理里不要再派子代理。\n'
        + '两件事都完成后只回复“好”。',
    }],
  });
  await waitForTurns(sessionId, 2);
  await sleep(4000);

  check('the main agent created its control file', existsSync(parentFile));
  check('the subagent created its test file', existsSync(childFile));
  const childIds = childOpened.map((opened) => String(opened.sessionId));
  evidence.childSessions = childOpened;

  // The merged journal must already record BOTH edits under the root session.
  // Follow DSH_HOME exactly like the bridge's FileSnapshots root.
  const rewindRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'paseo-rewind');
  const rootJournalPath = join(rewindRoot, sessionId, 'journal.jsonl');
  const journalLines = existsSync(rootJournalPath)
    ? readFileSync(rootJournalPath, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
    : [];
  evidence.rootJournal = journalLines;
  check(
    'the root journal records the parent\'s own edit',
    journalLines.some((line) => line.path === parentFile),
    JSON.stringify(journalLines.map((line) => line.path)),
  );
  check(
    'the root journal records the SUBAGENT\'s edit (the merge)',
    journalLines.some((line) => line.path === childFile),
    JSON.stringify(journalLines.map((line) => line.path)),
  );
  check(
    'the subagent session owns no journal of its own',
    childIds.length > 0 && childIds.every((id) => !existsSync(join(rewindRoot, id, 'journal.jsonl'))),
    JSON.stringify(childIds),
  );
  const snapshotLog = stderr.join('').split('\n').filter((line) => line.includes('file snapshot'));
  evidence.snapshotLog = snapshotLog;
  check('no snapshot skipped/failed line on the bridge stderr', snapshotLog.length === 0, JSON.stringify(snapshotLog));

  const before = await request('paseo/history', { sessionId });
  const beforeUsers = (before.events ?? []).filter(
    (event) => event.type === 'user/message' && event.data?.source?.kind === 'user',
  );
  check('the replay sees both human messages before the rewind', beforeUsers.length === 2, String(beforeUsers.length));

  const receipt = await request('paseo/revert', {
    sessionId,
    token: { messageId: second.messageId },
    scope: 'both',
  }, 240000);
  evidence.receipt = receipt;
  check('the rewind reports success', receipt?.kind === 'success', JSON.stringify(receipt).slice(0, 240));
  const deleted = (receipt?.files?.deleted ?? []).map(String);
  evidence.deleted = deleted;
  check('the receipt claims to delete the parent control file', deleted.some((entry) => entry === parentFile), JSON.stringify(deleted));
  check('the receipt claims to delete the subagent file', deleted.some((entry) => entry === childFile), JSON.stringify(deleted));
  check('the parent control file is gone', !existsSync(parentFile));
  check('the subagent file is gone (merge works end to end)', !existsSync(childFile));

  const after = await request('paseo/history', { sessionId });
  const afterUsers = (after.events ?? []).filter(
    (event) => event.type === 'user/message' && event.data?.source?.kind === 'user',
  );
  check('the conversation was withdrawn (one human message left)', afterUsers.length === 1, String(afterUsers.length));
} catch (error) {
  console.log('probe failed:', error.message);
  console.log(stderr.join('').slice(-3000));
  results.push({ name: 'probe', pass: false });
} finally {
  child.stdin.end();
  child.kill('SIGKILL');
  evidence.stderrTail = stderr.join('').slice(-2000);
  console.log('\n=== EVIDENCE (JSON) ===');
  console.log(JSON.stringify(evidence, null, 2));
  if (!keep) setTimeout(() => rmSync(root, { recursive: true, force: true }), 300);
  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed${keep ? ` (cwd kept: ${root})` : ''}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
