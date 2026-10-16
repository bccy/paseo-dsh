/**
 * Real-runtime check: a bridge request must never be answered from a
 * half-composed profile.
 *
 * The plugin's catalog/session/archive probes start a runtime with
 * `initializeRoute: false` — they deliberately never send `initialize`, because
 * they must not create an agent. The bridge used to await the profile loader
 * only for `initialize`, so those probes raced the loader: `paseo/archive`
 * arrived before `@deepseek-ai/dsh-workspace` was mounted and was answered with
 * "this DSH runtime composes no workspace registry" — intermittently for
 * catalog reads, deterministically for the archive probe every time.
 *
 * The fake bridge cannot catch this class of bug (it has no loader and invents
 * its own answers), so this check talks to the real `dsh --profile` and sends
 * `paseo/archive`/`paseo/unarchive` as the very first frame.
 *
 * It mutates nothing: a session id that does not exist is refused by
 * `archiveSession` (which proves the registry was reached), and
 * `unarchiveSession` on an id that is not archived is an idempotent no-op.
 *
 * Usage (a real `dsh` must be on PATH or named by DSH_BINARY):
 *
 *   node harness/archive-registry-check.mjs
 *   DSH_PASEO_PROFILE=my-profile node harness/archive-registry-check.mjs
 *
 * Exit status is non-zero when the registry was not reached.
 */
import { spawn } from 'node:child_process';

const PROFILE = process.env.DSH_PASEO_PROFILE ?? 'paseo';
const BINARY = process.env.DSH_BINARY ?? 'dsh';
const MISSING = `dsh-paseo-archive-registry-probe-${Date.now()}`;

const child = spawn(BINARY, ['--profile', PROFILE], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;
let stderr = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.id !== undefined && pending.has(frame.id)) {
      pending.get(frame.id)(frame);
      pending.delete(frame.id);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

function request(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (frame) => {
      if (frame.error !== undefined) reject(new Error(frame.error.message ?? `${method} failed`));
      else resolve(frame.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, timeoutMs).unref?.();
  });
}

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

try {
  // The very first frame is the probe's own shape: no `initialize` before it.
  const archived = await request('paseo/archive', { sessionId: MISSING });
  const archiveMessage = String(archived?.error?.message ?? '');
  check(
    'paseo/archive reaches the workspace registry without a preceding initialize',
    archived?.available === false &&
      archiveMessage.includes(MISSING) &&
      !/composes no workspace registry/.test(archiveMessage),
    JSON.stringify(archived),
  );

  // An id that is not archived is an idempotent no-op, so this also proves the
  // registry is mounted without writing anything.
  const unarchived = await request('paseo/unarchive', { sessionId: MISSING });
  check(
    'paseo/unarchive reaches the workspace registry without a preceding initialize',
    unarchived?.available === true,
    JSON.stringify(unarchived),
  );
} catch (error) {
  check('bridged archive registry probe', false, error instanceof Error ? error.message : String(error));
  if (stderr.trim() !== '') console.error(stderr.trim().split('\n').slice(-8).join('\n'));
} finally {
  try {
    child.stdin.end();
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    child.kill('SIGKILL');
    const failed = results.filter((pass) => !pass).length;
    console.log(`\n  ${results.length - failed}/${results.length} passed`);
    process.exit(failed === 0 && results.length > 0 ? 0 : 1);
  }, 300);
}
