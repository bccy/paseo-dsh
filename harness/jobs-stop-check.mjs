/**
 * Offline check for the jobs popover's **stop** path: the bridge's
 * `paseo/jobs/stop` method, the `canStop` field it projects, and the plugin's
 * half (`DshProcess.stopJob` → `stopAgentJob` → the `jobs.stop` contract).
 *
 * DSH's own `job_kill` tool reaches `ctx.jobs.kill(id, caller, reason)`, so the
 * bridge calls the same registry entry rather than signalling a process. This
 * file asserts the contract that makes that safe:
 *
 *   1. **`canStop` is derived, not assumed.** Only a `running` job is
 *      stoppable; `stopping` and every terminal status are not. The pill draws
 *      its button from this field, so a job it cannot stop must not say it can.
 *   2. **A stop is requested, not completed.** A successful answer carries
 *      `outcome: "requested"` and the post-request projection (`stopping`) —
 *      `kill()` is asynchronous and settlement arrives through the poll.
 *   3. **Every refusal is loud and coded.** Unknown / another session's job,
 *      an already-settled job, an already-stopping job, an unopened session, a
 *      missing registry, and a producer cancel that threw all answer
 *      `stopped: false` with a code from `shared/jobs.ts`. None of them may
 *      answer success.
 *   4. **The two halves agree.** Every code the bridge can send exists in the
 *      shared enum and travels through `DshProcess.stopJob` unchanged; an
 *      unknown code degrades to `rpc_failed` instead of reaching the client's
 *      schema unparseable.
 *   5. **The method is dispatched.** `handleRequest('paseo/jobs/stop', …)` must
 *      reach it — this repo has already shipped a deleted method body behind a
 *      live `case`.
 *
 * Part A drives the real `PaseoHarnessServer` with a recording context and a
 * fake job registry (no profile, no model, no child process). Part B drives the
 * real compiled plugin modules: `DshProcess.stopJob` against a spawned fake
 * `dsh` child that speaks the bridge's stdio JSON-RPC, `stopAgentJob` with no
 * connection, and the shared contract's schemas.
 *
 * Usage (compile the plugin first; Part B requires it):
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cd .. && node harness/jobs-stop-check.mjs
 *
 * DSH packages for Part A resolve from this machine's install (override with
 * `DSH_PACKAGES_DIR` / `DSH_INSTALL_DIR`), and the compiled plugin is read from
 * `paseo-plugin/.dbg` (override with `PLUGIN_DBG_DIR`). Pure offline: no profile,
 * no daemon, no model call.
 */
import { existsSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DSH_PACKAGES =
  `${homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`;
const dshPackages = process.env.DSH_PACKAGES_DIR ?? DEFAULT_DSH_PACKAGES;
const dshRoot = process.env.DSH_INSTALL_DIR ?? resolve(dshPackages, '..', '..');
const dshAnchor = join(dshRoot, 'package.json');

const HERE = import.meta.dirname;
const REPO = resolve(HERE, '..');
const bridgePath = join(REPO, 'dsh-bridge', 'lib', 'server.js');
const pluginDbg = process.env.PLUGIN_DBG_DIR ?? join(REPO, 'paseo-plugin', '.dbg');

// The real bridge imports DSH's internal assembly packages by bare specifier; a
// process running from this repo cannot resolve them. Same shim as
// `goal-bridge-check.mjs`, anchored at the install that will run the bridge.
register(`data:text/javascript,${encodeURIComponent(
  `import { createRequire } from 'node:module';
   import { pathToFileURL } from 'node:url';
   const require = createRequire(${JSON.stringify(dshAnchor)});
   export async function resolve(specifier, context, next) {
     if (specifier.startsWith('@deepseek-ai/')) {
       try {
         return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
       } catch {
         /* not a package this install ships: let Node report it */
       }
     }
     return next(specifier, context);
   }`,
)}`);

let PaseoHarnessServer;
try {
  ({ PaseoHarnessServer } = await import(pathToFileURL(bridgePath).href));
} catch (error) {
  console.error(`could not load ${bridgePath} offline.`);
  console.error(`  DSH packages were resolved from ${dshPackages}`);
  console.error(`  (override with DSH_PACKAGES_DIR / DSH_INSTALL_DIR)`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const results = [];
/** Every refusal code the bridge answered with, for the cross-half pin below. */
const bridgeCodes = new Set();
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

/**
 * Build a bridge whose only live agent is the one a test registers.
 *
 * `services` maps a ctx service name to what `ctx.get` answers; an `Error` value
 * makes the lookup throw. Nothing else about the server is faked: the method
 * under test is the file's own.
 */
function makeServer(services = {}) {
  const agents = new Map();
  const ctx = {
    get(name) {
      if (!(name in services)) return undefined;
      const value = services[name];
      if (value instanceof Error) throw value;
      return value;
    },
    on: () => () => {},
    agents: { get: (id) => agents.get(id) },
  };
  const transport = {
    notify() {},
    write() {},
    flush: async () => {},
    request: async () => ({}),
  };
  const server = new PaseoHarnessServer(ctx, transport, {});
  return { server, agents };
}

/** Register one live agent the way `createSession` leaves the server's tables. */
function liveSession(server, agents, sessionId) {
  const agent = { id: `agent-${sessionId}`, session: { id: sessionId } };
  agents.set(agent.id, agent);
  server.sessions.set(sessionId, { handle: { agent } });
  return agent;
}

/**
 * A fake `ctx.jobs` carrying real `JobView` shapes.
 *
 * `kill()` mirrors the shipped registry's documented behaviour: refusals throw
 * for an unknown/foreign job, a terminal job answers `already-finished`, and a
 * live one gets its cancellation invoked before the record turns `stopping`.
 * Every call is recorded so a test can prove a refusal never reached it.
 */
function fakeRegistry(jobsByOwner = {}) {
  const calls = [];
  const registry = {
    calls,
    /** Which session ids were asked for a list (proves the owner filter was used). */
    listCallers: [],
    list(caller) {
      registry.listCallers.push(caller);
      const owned = Object.prototype.hasOwnProperty.call(jobsByOwner, caller)
        ? jobsByOwner[caller]
        : [];
      return [...owned, ...(jobsByOwner.__unowned__ ?? [])];
    },
    get(id, caller) {
      const job = registry.list(caller).find((candidate) => candidate.id === id);
      if (job === undefined) throw new Error(`unknown job ${id}`);
      if (job.owner !== undefined && job.owner !== caller) throw new Error(`job ${id} belongs to another session`);
      return job;
    },
    kill(id, caller, reason) {
      calls.push({ id, caller, reason });
      const job = registry.get(id, caller);
      const alreadyFinished = ['completed', 'killed', 'failed'].includes(job.status);
      if (alreadyFinished) return 'already-finished';
      if (job.cancelThrows === true) throw new Error('producer cancel exploded');
      // A record that settles between the caller's `list` and this call: DSH
      // answers `already-finished` for it, and the bridge must not call that a
      // successful stop.
      if (job.settleOnKill === true) {
        job.status = 'killed';
        job.finishedAt = 300;
        return 'already-finished';
      }
      job.status = 'stopping';
      return 'requested';
    },
  };
  return registry;
}

/** One `JobView` the bridge can project. */
function jobView(id, status, extra = {}) {
  return { id, kind: 'bash', label: `sleep 600 # ${id}`, status, startedAt: 100, ...extra };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

console.log('jobs stop path: bridge contract\n');

// ===== 1. canStop is derived from the status, never assumed ===============
{
  const registry = fakeRegistry({
    'sess-1': [
      jobView('bash-running', 'running'),
      jobView('bash-stopping', 'stopping'),
      jobView('bash-done', 'completed', { finishedAt: 200 }),
      jobView('bash-killed', 'killed', { finishedAt: 200 }),
      jobView('bash-failed', 'failed', { finishedAt: 200 }),
    ],
  });
  const { server } = makeServer({ jobs: registry });
  const out = await server.handleRequest('paseo/jobs', { sessionId: 'sess-1' });
  const byId = new Map((out?.jobs ?? []).map((job) => [job.id, job]));
  check(
    'running is the only stoppable status (stopping and every terminal are not)',
    byId.get('bash-running')?.canStop === true
      && ['bash-stopping', 'bash-done', 'bash-killed', 'bash-failed']
        .every((id) => byId.get(id)?.canStop === false),
    JSON.stringify([...byId.values()].map((job) => `${job.id}:${job.status}:${job.canStop}`)),
  );
  check(
    'every row carries an explicit boolean canStop (never an absent key)',
    [...byId.values()].every((job) => typeof job.canStop === 'boolean'),
    JSON.stringify([...byId.values()].map((job) => job.canStop)),
  );
  check(
    'the list is read through the caller filter (owner-scoped registry)',
    registry.listCallers.length === 1 && registry.listCallers[0] === 'sess-1',
    JSON.stringify(registry.listCallers),
  );
}

// ===== 2. a stop requests cancellation and answers `requested` ===========
{
  const target = jobView('bash-live', 'running');
  const registry = fakeRegistry({ 'sess-2': [target] });
  const { server, agents } = makeServer({ jobs: registry });
  liveSession(server, agents, 'sess-2');
  const out = await server.handleRequest('paseo/jobs/stop', { sessionId: 'sess-2', jobId: 'bash-live' });
  check(
    'a running job answers {stopped:true, outcome:"requested"}',
    out?.stopped === true && out?.outcome === 'requested',
    JSON.stringify(out),
  );
  check(
    'the answer projects the job as stopping with canStop:false',
    out?.job?.status === 'stopping' && out?.job?.canStop === false,
    JSON.stringify(out?.job),
  );
  check(
    "the registry's kill() receives the job id and this session as the caller, no invented reason",
    registry.calls.length === 1
      && registry.calls[0].id === 'bash-live'
      && registry.calls[0].caller === 'sess-2'
      && registry.calls[0].reason === undefined,
    JSON.stringify(registry.calls),
  );
  check(
    'the projection reuses the list shape (id/kind/label/startedAt survive)',
    out?.job?.id === 'bash-live' && out?.job?.kind === 'bash'
      && out?.job?.label === target.label && out?.job?.startedAt === 100,
    JSON.stringify(out?.job),
  );
}

// ===== 3. an already-settled job is a refusal, not a success =============
{
  const registry = fakeRegistry({ 'sess-3': [jobView('bash-finished', 'completed', { finishedAt: 200 })] });
  const { server, agents } = makeServer({ jobs: registry });
  liveSession(server, agents, 'sess-3');
  const out = await server.handleRequest('paseo/jobs/stop', { sessionId: 'sess-3', jobId: 'bash-finished' });
  bridgeCodes.add(out?.code);
  check(
    'a settled job answers stopped:false with job_finished',
    out?.stopped === false && out?.code === 'job_finished',
    JSON.stringify(out),
  );
  check(
    'the refusal says the job already finished and carries its terminal row',
    /already finished/.test(out?.message ?? '') && out?.job?.status === 'completed',
    JSON.stringify({ message: out?.message, status: out?.job?.status }),
  );
  check(
    'the registry kill() is never called for a settled job (no fake success in the producer)',
    registry.calls.length === 0,
    JSON.stringify(registry.calls),
  );
}

// ===== 3b. a job that settles between the list and the kill ==============
{
  const raced = jobView('bash-raced', 'running');
  raced.settleOnKill = true;
  const registry = fakeRegistry({ 'sess-3c': [raced] });
  const { server, agents } = makeServer({ jobs: registry });
  liveSession(server, agents, 'sess-3c');
  const out = await server.handleRequest('paseo/jobs/stop', { sessionId: 'sess-3c', jobId: 'bash-raced' });
  bridgeCodes.add(out?.code);
  check(
    'a job that settles during the stop answers job_finished, never a claimed success',
    out?.stopped === false && out?.code === 'job_finished',
    JSON.stringify(out),
  );
  check(
    'the raced answer carries the terminal row DSH settled into',
    out?.job?.status === 'killed' && out?.job?.canStop === false,
    JSON.stringify(out?.job),
  );
  check(
    'the race still cost exactly one kill call (no retry, no second cancel)',
    registry.calls.length === 1,
    JSON.stringify(registry.calls),
  );
}

// ===== 4. an already-stopping job is a distinct refusal ==================
{
  const registry = fakeRegistry({ 'sess-4': [jobView('bash-already-stopping', 'stopping')] });
  const { server, agents } = makeServer({ jobs: registry });
  liveSession(server, agents, 'sess-4');
  const out = await server.handleRequest('paseo/jobs/stop', { sessionId: 'sess-4', jobId: 'bash-already-stopping' });
  bridgeCodes.add(out?.code);
  check(
    'a stopping job answers stopped:false with job_not_stoppable (not "already finished")',
    out?.stopped === false && out?.code === 'job_not_stoppable' && !/finished/.test(out?.message ?? ''),
    JSON.stringify(out),
  );
  check(
    'cancellation is not requested twice for the same job',
    registry.calls.length === 0,
    JSON.stringify(registry.calls),
  );
}

// ===== 5. an unknown or another session's job is one refusal =============
{
  const registry = fakeRegistry({ 'sess-5': [] });
  const { server, agents } = makeServer({ jobs: registry });
  liveSession(server, agents, 'sess-5');
  const unknown = await server.handleRequest('paseo/jobs/stop', { sessionId: 'sess-5', jobId: 'bash-ghost' });
  bridgeCodes.add(unknown?.code);
  check(
    'an unknown job answers stopped:false with job_not_found',
    unknown?.stopped === false && unknown?.code === 'job_not_found',
    JSON.stringify(unknown),
  );
  check(
    'the refusal names the id and claims nothing about a stop',
    /bash-ghost/.test(unknown?.message ?? '') && unknown?.job === undefined,
    JSON.stringify(unknown?.message),
  );
  check(
    'no kill reached the registry for a job this session does not own',
    registry.calls.length === 0,
    JSON.stringify(registry.calls),
  );
}
{
  // The other session's job is simply absent from this session's list, so the
  // answer must not disclose it — and must not be a different code, which would
  // tell the user a foreign job exists.
  const registry = fakeRegistry({ 'sess-6a': [jobView('bash-other', 'running')], 'sess-6b': [] });
  const { server, agents } = makeServer({ jobs: registry });
  liveSession(server, agents, 'sess-6b');
  const out = await server.handleRequest('paseo/jobs/stop', { sessionId: 'sess-6b', jobId: 'bash-other' });
  bridgeCodes.add(out?.code);
  check(
    "another session's job answers the same job_not_found (ownership is not leaked)",
    out?.stopped === false && out?.code === 'job_not_found' && registry.calls.length === 0,
    JSON.stringify(out),
  );
}

// ===== 6. an unopened session is a refusal, and materializes nothing =====
{
  const registry = fakeRegistry({});
  let created = 0;
  const { server } = makeServer({ jobs: registry });
  server.createSession = async () => {
    created += 1;
    throw new Error('a stop must not materialize a session');
  };
  const out = await server.handleRequest('paseo/jobs/stop', { sessionId: 'sess-cold', jobId: 'bash-1' });
  bridgeCodes.add(out?.code);
  check(
    'a session the bridge has not opened answers stopped:false with session_missing',
    out?.stopped === false && out?.code === 'session_missing',
    JSON.stringify(out),
  );
  check(
    "the refusal keeps requireSession's sentence (the plugin maps its text, not a new one)",
    /unknown or not-yet-created session/.test(out?.message ?? ''),
    out?.message,
  );
  check(
    'the stop materializes no session and reads no registry',
    created === 0 && registry.listCallers.length === 0,
    JSON.stringify({ created, listCallers: registry.listCallers }),
  );
}

// ===== 7. a missing registry is terminal, never "already finished" =======
{
  const { server, agents } = makeServer({});
  liveSession(server, agents, 'sess-7');
  const out = await server.handleRequest('paseo/jobs/stop', { sessionId: 'sess-7', jobId: 'bash-1' });
  bridgeCodes.add(out?.code);
  check(
    'a profile with no job registry answers stopped:false with registry_missing',
    out?.stopped === false && out?.code === 'registry_missing',
    JSON.stringify(out),
  );
  check(
    "the registry_missing sentence is the shared constant's (plugin matches it verbatim)",
    out?.message === 'this DSH runtime composes no job registry',
    out?.message,
  );
}
{
  const { server, agents } = makeServer({ jobs: new Error('registry exploded during lookup') });
  liveSession(server, agents, 'sess-7b');
  const out = await server.handleRequest('paseo/jobs/stop', { sessionId: 'sess-7b', jobId: 'bash-1' });
  bridgeCodes.add(out?.code);
  check(
    'a throwing registry lookup is reported as registry_missing, naming the cause',
    out?.stopped === false
      && out?.code === 'registry_missing'
      && /looking up DSH's job registry failed/.test(out?.message ?? '')
      && /registry exploded during lookup/.test(out?.message ?? ''),
    JSON.stringify(out),
  );
}

// ===== 8. a producer cancel that throws leaves the job running ===========
{
  const target = jobView('bash-stubborn', 'running');
  target.cancelThrows = true;
  const registry = fakeRegistry({ 'sess-8': [target] });
  const { server, agents } = makeServer({ jobs: registry });
  liveSession(server, agents, 'sess-8');
  const out = await server.handleRequest('paseo/jobs/stop', { sessionId: 'sess-8', jobId: 'bash-stubborn' });
  bridgeCodes.add(out?.code);
  check(
    'a throwing cancel answers stopped:false with cancel_failed (never success)',
    out?.stopped === false && out?.code === 'cancel_failed',
    JSON.stringify(out),
  );
  check(
    'the refusal carries the cause and the still-running row',
    /producer cancel exploded/.test(out?.message ?? '') && out?.job?.status === 'running',
    JSON.stringify({ message: out?.message, status: out?.job?.status }),
  );
}

// ===== 9. a malformed request fails loudly ===============================
{
  const { server } = makeServer({ jobs: fakeRegistry({}) });
  const noJob = await rejection(server.handleRequest('paseo/jobs/stop', { sessionId: 'sess-9' }));
  const noSession = await rejection(server.handleRequest('paseo/jobs/stop', { jobId: 'bash-1' }));
  check(
    'a request without sessionId or jobId throws instead of stopping some default',
    noJob instanceof TypeError && /requires a sessionId and a jobId/.test(noJob.message)
      && noSession instanceof TypeError && /requires a sessionId and a jobId/.test(noSession.message),
    `${noJob?.message} | ${noSession?.message}`,
  );
}

console.log('\njobs stop path: plugin half\n');

// ===== 10. the shared contract ============================================
const pluginRequire = createRequire(join(pluginDbg, 'package.json'));
let shared;
let providerModule;
let DshProcess;
try {
  shared = pluginRequire('./shared/jobs.js');
  providerModule = pluginRequire('./server/provider.js');
  ({ DshProcess } = pluginRequire('./server/dsh-process.js'));
} catch (error) {
  console.error(`could not load the compiled plugin from ${pluginDbg}.`);
  console.error('  compile it first: cd paseo-plugin && npx tsc --noEmit false --outDir .dbg \\');
  console.error('    --declaration false --module commonjs --moduleResolution node');
  console.error('  then: echo \'{"type":"commonjs"}\' > .dbg/package.json');
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const { jobsStop, jobSchema, JOB_STOP_ERROR_CODES } = shared;
check(
  'the RPC is named jobs.stop (the name the client bundle will call)',
  jobsStop.name === 'jobs.stop',
  jobsStop.name,
);
check(
  'the input requires agentId and jobId, both non-empty',
  jobsStop.input.safeParse({ agentId: 'a-1', jobId: 'bash-1' }).success
    && !jobsStop.input.safeParse({ agentId: '', jobId: 'bash-1' }).success
    && !jobsStop.input.safeParse({ agentId: 'a-1' }).success,
  JSON.stringify(jobsStop.input.safeParse({ agentId: 'a-1', jobId: 'bash-1' }).success),
);
const validJob = { id: 'bash-1', kind: 'bash', label: 'sleep 600', status: 'running', canStop: true, startedAt: 1 };
check(
  'a job row requires canStop (a server half without it fails the parse instead of lying)',
  jobSchema.safeParse(validJob).success
    && !jobSchema.safeParse({ ...validJob, canStop: undefined }).success,
  JSON.stringify(jobSchema.safeParse(validJob).success),
);
check(
  'the stop error codes are the eight the bridge can send',
  JOB_STOP_ERROR_CODES.length === 8
    && JOB_STOP_ERROR_CODES.includes('job_finished')
    && JOB_STOP_ERROR_CODES.includes('job_not_stoppable'),
  JSON.stringify(JOB_STOP_ERROR_CODES),
);

// ===== 11. DshProcess.stopJob maps the bridge's answer ====================
const dir = mkdtempSync(join(tmpdir(), 'jobs-stop-check-'));
const modeFile = join(dir, 'mode');
const frameLog = join(dir, 'frames.jsonl');
const fakeChild = join(dir, 'fake-dsh.mjs');
writeFileSync(modeFile, 'ok\n');
writeFileSync(fakeChild, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const modeFile = process.env.JOBS_STOP_MODE_FILE;
const frameLog = process.env.JOBS_STOP_FRAME_LOG;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    const frame = JSON.parse(line);
    appendFileSync(frameLog, JSON.stringify(frame) + "\\n");
    if (frame.method !== "paseo/jobs/stop") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }) + "\\n");
      continue;
    }
    const mode = readFileSync(modeFile, "utf8").trim();
    if (mode === "hang") continue;
    if (mode === "unknown") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown paseo bridge method: paseo/jobs/stop" } }) + "\\n");
      continue;
    }
    const job = { id: "bash-1", kind: "bash", label: "sleep 600", status: "stopping", canStop: false, startedAt: 1 };
    if (mode === "ok") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { stopped: true, outcome: "requested", job } }) + "\\n");
      continue;
    }
    if (mode === "finished") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { stopped: false, code: "job_finished", message: "background job bash-1 is completed; it already finished", job: { ...job, status: "completed", finishedAt: 2 } } }) + "\\n");
      continue;
    }
    if (mode === "weird") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { stopped: false, code: "weird_code", message: "the bridge said something odd" } }) + "\\n");
      continue;
    }
    if (mode === "noboolean") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { stopped: "yes" } }) + "\\n");
      continue;
    }
    if (mode === "naked") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { stopped: true } }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }) + "\\n");
  }
});
`);
chmodSync(fakeChild, 0o755);

process.env.DSH_BINARY = fakeChild;
const logs = [];
const proc = new DshProcess({
  cwd: dir,
  route: { provider: 'fake', model: 'fake' },
  sessionId: 'jobs-stop-probe',
  initializeRoute: false,
  env: { JOBS_STOP_MODE_FILE: modeFile, JOBS_STOP_FRAME_LOG: frameLog },
  onEvent() {},
  onStatus() {},
  onQuestion: async () => ({ answers: [] }),
  onLog: (line) => logs.push(line),
  onExit() {},
  onProtocolError() {},
});
const setMode = (value) => writeFileSync(modeFile, `${value}\n`);
const TIMEOUT_MS = 60;

await proc.start();

{
  setMode('ok');
  const out = await proc.stopJob('probe', 'bash-1', TIMEOUT_MS);
  check(
    'a bridge success becomes {ok:true, outcome:"requested", job} with canStop:false',
    out.ok === true && out.outcome === 'requested'
      && out.job?.id === 'bash-1' && out.job?.status === 'stopping' && out.job?.canStop === false,
    JSON.stringify(out),
  );
  const frames = readFileSync(frameLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const stopFrame = frames.find((frame) => frame.method === 'paseo/jobs/stop');
  check(
    'the plugin asks paseo/jobs/stop with {sessionId, jobId} and no extra fields',
    stopFrame !== undefined
      && stopFrame.params.sessionId === 'probe'
      && stopFrame.params.jobId === 'bash-1'
      && Object.keys(stopFrame.params).sort().join(',') === 'jobId,sessionId',
    JSON.stringify(stopFrame),
  );
}
{
  setMode('finished');
  const out = await proc.stopJob('probe', 'bash-1', TIMEOUT_MS);
  check(
    'a job_finished refusal travels with its code, sentence and terminal row',
    out.ok === false && out.error?.code === 'job_finished'
      && /already finished/.test(out.error?.message ?? '')
      && out.job?.status === 'completed',
    JSON.stringify(out),
  );
}
{
  setMode('weird');
  const out = await proc.stopJob('probe', 'bash-1', TIMEOUT_MS);
  check(
    'an unknown bridge code degrades to rpc_failed instead of reaching the client schema',
    out.ok === false && out.error?.code === 'rpc_failed'
      && /something odd/.test(out.error?.message ?? ''),
    JSON.stringify(out),
  );
}
{
  setMode('noboolean');
  const out = await proc.stopJob('probe', 'bash-1', TIMEOUT_MS);
  check(
    'a truthy non-boolean "stopped" is refused (never read as success)',
    out.ok === false && out.error?.code === 'rpc_failed',
    JSON.stringify(out),
  );
}
{
  // Review P3-4: a `stopped:true` without DSH's `outcome:"requested"` is a shape
  // the runtime never produces. The plugin used to report it as a success with
  // the outcome simply omitted — telling the user the job is stopping when the
  // bridge may not have cancelled anything.
  setMode('naked');
  const out = await proc.stopJob('probe', 'bash-1', TIMEOUT_MS);
  check(
    'a success claim without outcome "requested" is refused (review P3-4)',
    out.ok === false && out.error?.code === 'rpc_failed'
      && /without outcome "requested"/.test(out.error?.message ?? ''),
    JSON.stringify(out),
  );
}
{
  setMode('unknown');
  const out = await proc.stopJob('probe', 'bash-1', TIMEOUT_MS);
  check(
    'a bridge without the method answers bridge_too_old with the reload instruction',
    out.ok === false && out.error?.code === 'bridge_too_old'
      && /paseo\/jobs\/stop/.test(out.error?.message ?? '')
      && /reload the plugin/.test(out.error?.message ?? ''),
    JSON.stringify(out.error),
  );
}
{
  setMode('hang');
  const out = await proc.stopJob('probe', 'bash-1', TIMEOUT_MS);
  check(
    'no answer within the budget answers rpc_failed with its own sentence',
    out.ok === false && out.error?.code === 'rpc_failed'
      && /did not answer paseo\/jobs\/stop/.test(out.error?.message ?? ''),
    JSON.stringify(out.error),
  );
}
{
  setMode('shape');
  const out = await proc.stopJob('probe', 'bash-1', TIMEOUT_MS);
  check(
    'an answer that is neither shape answers rpc_failed, naming the unexpected payload',
    out.ok === false && out.error?.code === 'rpc_failed'
      && /no boolean "stopped"/.test(out.error?.message ?? ''),
    JSON.stringify(out),
  );
}

// ===== 12. an agent with no open session is a refusal ====================
{
  const out = await providerModule.stopAgentJob('agent-without-session', 'bash-1');
  check(
    'no open DSH session answers ok:false with session_missing (never a quiet success)',
    out.ok === false && out.error?.code === 'session_missing',
    JSON.stringify(out),
  );
  check(
    'the refusal tells the user what to do next',
    /no DSH session is open/.test(out.error?.message ?? '')
      && /send it a message first/.test(out.error?.message ?? ''),
    out.error?.message,
  );
}

await proc.shutdown().catch(() => undefined);

// ===== 13. the code set is one contract ==================================
{
  // Every code the bridge answered with in Part A must exist in the shared enum;
  // an unlisted one would reach the client's zod enum and fail the parse.
  const seen = [...bridgeCodes];
  check(
    'every code the bridge sends exists in the shared stop-error enum',
    seen.every((code) => JOB_STOP_ERROR_CODES.includes(code)),
    JSON.stringify({ bridge: seen, shared: [...JOB_STOP_ERROR_CODES] }),
  );
  check(
    'the check exercised every code the bridge can send',
    seen.length === 6,
    `${seen.length} code(s): ${seen.join(', ')}`,
  );
}

const failedCount = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount === 0 ? 0 : 1);