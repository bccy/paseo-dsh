/**
 * End-to-end probe: stop a real background job through the bridge's
 * `paseo/jobs/stop`, against a real `dsh --profile paseo`.
 *
 * Everything else about this feature is pinned offline (`jobs-stop-check.mjs`);
 * what offline checks cannot prove is that the registry call reaches a **live
 * harness process**, that DSH's `kill()` actually settles the job, and that the
 * command's process is gone afterwards. A fake registry and a fake child can
 * both answer `requested` without anything being killed.
 *
 * Scenario (one model turn, then registry calls only):
 *   1. prompt the model to start `sleep 517` with `run_in_background: true`;
 *   2. wait for the job to appear as `running` (with `canStop: true`);
 *   3. `paseo/jobs/stop` → assert `requested` and a `stopping` projection;
 *   4. poll `paseo/jobs` until the job settles as `killed`;
 *   5. assert no `sleep 517` process is left;
 *   6. the same id again answers `job_finished`; an unknown id answers
 *      `job_not_found`; a session the bridge never opened answers
 *      `session_missing`.
 *
 * **Costs one model turn** (the prompt) plus a few cents of registry polling.
 * It is a probe, not a CI regression: it needs a working `dsh` on PATH, a live
 * model route, and the `paseo` profile.
 *
 * Usage:
 *
 *   env -u DSH_HOME node harness/jobs-stop-live.mjs
 *
 * The home is a throwaway clone of `~/.dsh/profiles/paseo` (see
 * `isolated-dsh-home.cjs`), so nothing is written to the live profile or session
 * store. An explicit `DSH_HOME=<dir>` is used as-is; `--allow-real-profile`
 * uses the live home and prints a warning.
 *
 * Only the job this run started is stopped; the session id is minted here, so no
 * pre-existing session's jobs are touched.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { announceDshHome, prepareDshHome } = require('./isolated-dsh-home.cjs');

const argv = process.argv.slice(2);
const cwdFlag = argv.indexOf('--cwd');
const root =
  cwdFlag >= 0 && argv[cwdFlag + 1] !== undefined
    ? argv[cwdFlag + 1]
    : mkdtempSync(join(tmpdir(), 'jobs-stop-live-'));

let runMode;
try {
  runMode = prepareDshHome({
    script: 'jobs-stop-live',
    profile: process.env.DSH_PASEO_PROFILE ?? 'paseo',
    argv,
  });
} catch (error) {
  console.error(`jobs-stop-live: ${error.message}`);
  process.exit(2);
}
announceDshHome(runMode);

const profile = runMode.profile ?? process.env.DSH_PASEO_PROFILE ?? 'paseo';

/**
 * Release the clone's pinned web port.
 *
 * The live `paseo` profile pins the GUI's host/port so the user can bookmark it
 * (`~/.dsh/profiles/paseo/cordis.patch.yml`), and the running daemon holds that
 * port. A probe that boots a second `dsh --profile paseo` on the same number dies
 * with `EADDRINUSE` before any turn — which is exactly how this script first
 * failed. The port lives in the **clone** here, so rewriting it changes nothing
 * the user owns; `port: 0` is the profile's own documented concurrency setting
 * ("若将来并发多个 dsh 进程需改回 port: 0"). A profile without the entry is left
 * alone, and the rewrite is reported so a silent no-op cannot pass for a fix.
 */
function releasePinnedWebPort(home, profileName) {
  const file = join(home, 'profiles', profileName, 'cordis.patch.yml');
  if (!existsSync(file)) return 'no profile patch to rewrite';
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  let inWebserver = false;
  let rewritten = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^- id: webserver\s*$/.test(lines[index])) {
      inWebserver = true;
      continue;
    }
    if (inWebserver) {
      if (/^- \w/.test(lines[index]) || /^- id:/.test(lines[index])) {
        inWebserver = false;
        continue;
      }
      const match = /^(\s+port:\s*)(\d+)\s*$/.exec(lines[index]);
      if (match !== null) {
        lines[index] = `${match[1]}0`;
        rewritten = true;
      }
    }
  }
  if (!rewritten) return 'no pinned web port found (left as-is)';
  writeFileSync(file, lines.join('\n'));
  return `webserver port -> 0 in the clone (${file})`;
}

if (runMode.mode === 'isolated') {
  console.log(`probe: ${releasePinnedWebPort(runMode.home, profile)}`);
}

/**
 * Provision the clone's bridge from **this build**, exactly as production does.
 *
 * A clone of the live profile carries the bridge bundle the installed plugin
 * wrote there, which may predate this checkout — the first run of this probe
 * failed with `unknown paseo bridge method: paseo/jobs/stop` for that reason, and
 * a probe against a stale bridge proves nothing about the code under test.
 * `ensurePaseoProfile()` is the plugin's own provisioning path (it materializes
 * `server/bridge-assets.ts`, i.e. the embedded copy of `dsh-bridge/`), and it runs
 * against the throwaway clone because `DSH_HOME` is pointed at it. That makes the
 * probe read the regenerated bundle: run `node paseo-plugin/scripts/generate-bridge-assets.mjs`
 * after touching `dsh-bridge/` (or the script's own check fails, loudly).
 */
const pluginDbg = process.env.PLUGIN_DBG_DIR ?? join(import.meta.dirname, '..', 'paseo-plugin', '.dbg');
if (runMode.mode !== 'real') {
  process.env.DSH_HOME = runMode.home;
  const compiledBootstrap = createRequire(join(pluginDbg, 'package.json'))('./server/bootstrap.js');
  const provisioned = compiledBootstrap.ensurePaseoProfile();
  console.log(`probe: bridge provisioned into the clone from this build (${provisioned.bridgeFiles} file(s))`);
}

const child = spawn('dsh', ['--profile', profile], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
const events = [];
const permissionRequests = [];
let nextId = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() === '') continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.id !== undefined && pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) reject(new Error(JSON.stringify(frame.error)));
      else resolve(frame.result);
      continue;
    }
    if (frame.method === 'paseo/permission') {
      // A permission request would otherwise hang the turn until the 300 s wait
      // gives up. Recorded loudly: if the profile gates bash, the probe must say
      // "the run was blocked by a permission prompt", not "no job appeared".
      permissionRequests.push(frame);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { decision: 'deny' } })}\n`,
      );
      continue;
    }
    if (frame.method !== undefined) events.push(frame);
  }
});
const stderr = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => stderr.push(chunk));
// A boot failure (`EADDRINUSE`, a broken profile) closes the child before the
// first answer, and an unref'd timer plus a dead child leaves Node with no
// handles: the script used to exit 13 ("unsettled top-level await") and lose the
// one line that explained why. Fail every waiter with the child's stderr.
child.on('exit', (code, signal) => {
  const tail = stderr.join('').trim().split('\n').slice(-6).join(' | ');
  for (const [id, waiter] of pending) {
    pending.delete(id);
    waiter.reject(new Error(`dsh exited (code ${code}, signal ${signal}) before answering: ${tail}`));
  }
});

function request(method, params, timeoutMs = 180000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }
    }, timeoutMs).unref();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

const TERMINAL = new Set(['completed', 'killed', 'failed']);

/** The pid of the probe's command, when it is running. */
function probeProcesses() {
  try {
    return execFileSync('pgrep', ['-f', '^sleep 517$'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

async function listJobs(sessionId) {
  return await request('paseo/jobs', { sessionId }, 30000);
}

async function waitForLiveJob(sessionId, timeoutMs) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await listJobs(sessionId);
    const running = (last?.jobs ?? []).find((job) => job.status === 'running');
    if (running !== undefined) return { job: running, last };
    await sleep(500);
  }
  return { job: undefined, last };
}

async function waitForSettledJob(sessionId, jobId, timeoutMs) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await listJobs(sessionId);
    const job = (last?.jobs ?? []).find((candidate) => candidate.id === jobId);
    if (job !== undefined && TERMINAL.has(job.status)) return job;
    await sleep(250);
  }
  return undefined;
}

const sessionId = `jobs-stop-live-${Date.now()}`;
const command = 'sleep 517';

try {
  await request('initialize', { cwd: root, sessionId });
  await request('session/prompt', {
    sessionId,
    contentBlocks: [
      {
        type: 'text',
        text:
          `用 bash 工具在后台启动一条长命令：\`${command}\`。`
          + '必须设置 run_in_background: true、description 写「长跑探针」，'
          + '启动后立刻只回复“已启动”，不要等它结束，也不要用别的命令。',
      },
    ],
  });

  const started = Date.now();
  while (Date.now() - started < 300000) {
    if (events.some((frame) => frame.params?.event?.type === 'turn/end')) break;
    await sleep(250);
  }
  check(
    'the model turn finished (the background command was returned immediately)',
    events.some((frame) => frame.params?.event?.type === 'turn/end'),
    `${events.length} event frame(s)`,
  );
  check(
    'the profile raised no permission prompt for the command',
    permissionRequests.length === 0,
    `${permissionRequests.length} request(s)`,
  );

  const live = await waitForLiveJob(sessionId, 120000);
  check(
    'a running bash job appears in paseo/jobs',
    live.job?.kind === 'bash' && live.job?.status === 'running',
    JSON.stringify(live.job ?? live.last ?? null).slice(0, 400),
  );
  check(
    'the running row says it can be stopped',
    live.job?.canStop === true,
    JSON.stringify(live.job?.canStop),
  );
  check(
    "the row's label carries the command the model ran",
    typeof live.job?.label === 'string' && live.job.label.includes(command),
    live.job?.label,
  );

  const before = probeProcesses();
  check(
    'the command process is alive before the stop',
    before.length > 0,
    JSON.stringify(before),
  );

  const stop = await request('paseo/jobs/stop', { sessionId, jobId: live.job.id }, 30000);
  check(
    'paseo/jobs/stop answers {stopped:true, outcome:"requested"}',
    stop?.stopped === true && stop?.outcome === 'requested',
    JSON.stringify(stop).slice(0, 400),
  );
  check(
    'the immediate projection is stopping and no longer stoppable',
    stop?.job?.status === 'stopping' && stop?.job?.canStop === false,
    JSON.stringify(stop?.job ?? null).slice(0, 400),
  );

  const settled = await waitForSettledJob(sessionId, live.job.id, 60000);
  check(
    'the job settles as killed',
    settled?.status === 'killed',
    JSON.stringify(settled ?? null).slice(0, 400),
  );
  check(
    'a settled row is no longer stoppable',
    settled?.canStop === false,
    JSON.stringify(settled?.canStop),
  );

  const gone = Date.now();
  while (Date.now() - gone < 15000 && probeProcesses().length > 0) await sleep(250);
  check(
    'no sleep process is left after the stop',
    probeProcesses().length === 0,
    JSON.stringify(probeProcesses()),
  );

  const again = await request('paseo/jobs/stop', { sessionId, jobId: live.job.id }, 30000);
  check(
    'stopping the same id again answers job_finished (not a fake success)',
    again?.stopped === false && again?.code === 'job_finished' && again?.job?.status === 'killed',
    JSON.stringify(again).slice(0, 400),
  );

  const unknown = await request('paseo/jobs/stop', { sessionId, jobId: 'bash-0000000000000000' }, 30000);
  check(
    'an unknown job answers job_not_found',
    unknown?.stopped === false && unknown?.code === 'job_not_found',
    JSON.stringify(unknown).slice(0, 400),
  );

  const cold = await request(
    'paseo/jobs/stop',
    { sessionId: `jobs-stop-live-cold-${Date.now()}`, jobId: 'bash-0000000000000000' },
    30000,
  );
  check(
    'a session the bridge never opened answers session_missing',
    cold?.stopped === false && cold?.code === 'session_missing',
    JSON.stringify(cold).slice(0, 400),
  );
} catch (error) {
  console.log('probe failed:', error.message);
  console.log(stderr.join('').slice(-2500));
  results.push({ name: 'probe', pass: false });
} finally {
  child.stdin.end();
  child.kill('SIGKILL');
  if (cwdFlag < 0) setTimeout(() => rmSync(root, { recursive: true, force: true }), 500);
  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}