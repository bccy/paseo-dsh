/** Private base+bridge profile using only the user's existing route/credentials.
 * No custom memory/web plugins, no edits to the installed DSH or live profile. */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const require = createRequire(import.meta.url);

export function liveProfile({ projections = false } = {}) {
  const root = process.env.DSH_INSTALL_DIR ?? join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh');
  const dshRequire = createRequire(join(root, 'package.json'));
  const yaml = dshRequire('yaml');
  const sourceHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const sourceProfile = process.env.DSH_PASEO_PROFILE ?? 'paseo';
  const build = require('./plugin-build.cjs').resolvePluginBuild(undefined, '.dbg-p003');
  const home = mkdtempSync(join(tmpdir(), 'p003-live-'));
  const prior = { DSH_HOME: process.env.DSH_HOME, DSH_PASEO_PROFILE: process.env.DSH_PASEO_PROFILE };
  process.env.DSH_HOME = home;
  process.env.DSH_PASEO_PROFILE = 'p003';
  const { dir } = require(join(build, 'server/bootstrap.js')).ensurePaseoProfile();
  const rows = yaml.parse(readFileSync(join(sourceHome, 'profiles', sourceProfile, 'cordis.patch.yml'), 'utf8'));
  // Config identities, not provider/model names: preserve the probed route byte
  // values, never invent a model or copy unrelated services with external state.
  const routing = rows.filter(row => ['llm-pi-ai', 'llm-deepseek', 'agent-default-model'].includes(row.id));
  if (!routing.some(row => row.id === 'agent-default-model')) throw new Error('profile has no default model patch');
  const fixture = join(dir, 'node_modules/p003-probe');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'p003-probe', type: 'module', main: 'index.js' }));
  writeFileSync(join(fixture, 'index.js'), `
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'p003-probe';
export const inject = ['tools', 'approval'];
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'p003_approval_probe', description: 'Test one permission request. Performs no file, network, or process operation.',
    parameters: {}, output: {schema:{type:'string'}, render:(_args,value)=>[{type:'text',text:value}]},
    async execute(_args, exec) {
      return ctx.approval.request({agent:exec.agent, toolName:'p003_approval_probe', callId:exec.callId,
        reason:'P003 harmless approval check', signal:exec.signal});
    }
  }));
}
`);
  // These two projection units belong to the upstream web composition, not
  // dsh-base. Mount the native plugins explicitly when testing their values;
  // an empty preset adds no tools/persona and keeps this fixture self-contained.
  const projectionRows = projections ? [
    { id: 'session-stats', name: '@deepseek-ai/dsh-session-stats' },
    { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'p003-empty' } },
    { id: 'p003-empty', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'p003-empty', plugins: [] } },
  ] : [];
  writeFileSync(join(dir, 'cordis.patch.yml'), yaml.stringify([...routing, { insert: [
    { id: 'p003-probe', name: 'p003-probe' }, ...projectionRows,
  ] }]), { mode: 0o600 });
  for (const file of ['.credentials.yaml', '.credentials.yml']) {
    if (existsSync(join(sourceHome, file))) copyFileSync(join(sourceHome, file), join(home, file));
  }
  const env = { ...process.env };
  return { home, build, env, binary: process.env.DSH_BINARY ?? join(root, 'bin/dsh.mjs'),
    cleanup() { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(home, { recursive: true, force: true }); } };
}

export function bridge(profile) {
  const child = spawn(process.env.DSH_BINARY ?? join(homedir(), '.npm-global/bin/dsh'), ['--profile', 'p003'],
    { cwd: profile.home, env: profile.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [], pending = new Map(); let id = 0, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const send = frame => child.stdin.write(JSON.stringify(frame) + '\n');
  createInterface({ input: child.stdout }).on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    frames.push(frame);
    if (frame.method === undefined && pending.has(frame.id)) {
      const entry = pending.get(frame.id); pending.delete(frame.id); clearTimeout(entry.timer);
      if (frame.error) entry.reject(new Error(frame.error.message)); else entry.resolve(frame.result);
    }
  });
  child.on('exit', (code) => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`bridge exited ${code}: ${stderr.slice(-800)}`)); } pending.clear(); });
  return { child, frames, send,
    rpc(method, params = {}) { return new Promise((resolve, reject) => { const n = ++id;
      const timer = setTimeout(() => { pending.delete(n); reject(new Error(`timeout ${method}: ${stderr.slice(-800)}`)); }, 120000);
      pending.set(n, { resolve, reject, timer }); send({ jsonrpc: '2.0', id: n, method, params }); }); },
    async close() { if (child.exitCode === null) { child.stdin.end(); await new Promise(r => child.once('exit', r)); } },
  };
}

export async function until(fn, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const found = fn(); if (found) return found; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`timeout: ${label}`);
}
