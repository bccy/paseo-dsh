/**
 * Tool-visibility probe: dumps every JSON-RPC frame from a minimal turn so the
 * model's visible tool catalog can be inspected.
 *
 * The turn itself is the point: the bridge only admits a `session/prompt` for a
 * session whose own `initialize` named that same `sessionId` (one process now
 * serves many sessions). This probe used to initialize without an id and then
 * prompt with one, so against the current bridge it failed with "paseo bridge is
 * not initialized for session …" and never produced a visibility turn. The id is
 * minted once here and used by both frames.
 *
 * Profile isolation: by default the probe clones the profile named by
 * DSH_PASEO_PROFILE (default `paseo`) into a throwaway DSH_HOME, so the live
 * `~/.dsh` is never written. Pass `--allow-real-profile` to use the live home
 * instead; an explicit `DSH_HOME=<dir>` is used as-is. DSH_BINARY overrides the
 * `dsh` executable (the offline regression points it at a scripted peer).
 *
 * Usage:
 *   node harness/tools.mjs
 *   node harness/tools.mjs --out /tmp/frames.jsonl --wait-ms 45000
 *   node harness/tools.mjs --allow-real-profile   # live ~/.dsh (writes sessions)
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { announceDshHome, prepareDshHome } = require('./isolated-dsh-home.cjs');

const SESSION_ID = `tools-${Date.now()}`;
const BINARY = process.env.DSH_BINARY ?? 'dsh';

function argumentOf(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const OUT = argumentOf('--out', new URL('./frames.jsonl', import.meta.url).pathname);
const WAIT_MS = Number(argumentOf('--wait-ms', '45000'));

let runMode;
try {
  runMode = prepareDshHome({ script: 'tools', profile: process.env.DSH_PASEO_PROFILE ?? 'paseo' });
} catch (error) {
  console.error(`tools: ${error.message}`);
  process.exit(2);
}
announceDshHome(runMode);

const out = createWriteStream(OUT);

const child = spawn(BINARY, ['--profile', process.env.DSH_PASEO_PROFILE ?? 'paseo'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

const pending = new Map();
let nextId = 1;
let buffer = '';
let asked = 0;

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
    }, 180000);
    // `unref()`: a settled request must not keep the process alive for its whole
    // timeout budget after the main flow has finished.
    timer.unref();
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    out.write(`${line}\n`);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.method === 'paseo/question') {
      asked += 1;
      console.log('>>> paseo/question arrived:', JSON.stringify(frame.params).slice(0, 300));
      send({ jsonrpc: '2.0', id: frame.id, result: { answers: [] } });
      continue;
    }
    if (frame.id !== undefined && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.error) entry.reject(new Error(frame.error.message));
      else entry.resolve(frame.result);
    }
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(`[dsh] ${chunk}`));
child.on('exit', (code) => {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(new Error(`dsh exited ${code ?? 'by signal'} before the request settled`));
  }
});

function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // `sessionId` is not optional: `initialize` pins cwd/route FOR ONE session,
  // and the shared-process bridge refuses a prompt from a session it has never
  // initialized. The prompt below reuses this exact id.
  await request('initialize', { cwd: process.cwd(), sessionId: SESSION_ID });
  console.log('initialized');

  await request('session/prompt', {
    sessionId: SESSION_ID,
    contentBlocks: [
      {
        type: 'text',
        text:
          'Do not call any tool. Reply with the exact names of every tool available to you, ' +
          'one per line, prefixed with "TOOL: ". Include ask_user_question if you have it.',
      },
    ],
  });

  await sleep(WAIT_MS);
  console.log(`\npaseo/question arrivals: ${asked}`);
  console.log(`frames written to ${OUT}`);
  try {
    await request('shutdown', {});
  } catch {
    /* expected */
  }
  await sleep(1000);
  out.end();
  child.kill();
}

main().catch((error) => {
  console.error('FAILED:', error);
  out.end();
  child.kill();
  process.exitCode = 1;
});
