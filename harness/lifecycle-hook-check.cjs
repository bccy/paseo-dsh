/**
 * The 0.16 public hook contract, using the real compiled server entry.
 * No legacy on/before exists on the fake: falling back to one must fail.
 * No profile/model/daemon is opened; provisioning and handle capture are spies.
 * Run: node harness/lifecycle-hook-check.cjs [compiled-plugin-dir]
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const { resolvePluginBuild } = require('./plugin-build.cjs');
const build = resolvePluginBuild(process.argv[2], '.dbg-lifecycle-hooks');
const bootstrap = require(path.join(build, 'server/bootstrap.js'));
const reports = require(path.join(build, 'server/rewind-notice-append.js'));
const agPaths = require(path.join(build, 'server/antigravity/paths.js'));
const provision = bootstrap.ensurePaseoProfile;
const capture = reports.capturePaseo;
const origOpenGate = agPaths.shouldRegisterAntigravityOpenHookSync;
const origDetectPresence = agPaths.detectAntigravityPresence;
const prevPaseoHome = process.env.PASEO_HOME;
const prevDshHome = process.env.DSH_HOME;
const isolatedPaseoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-lifecycle-hooks-'));
const isolatedDshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-lifecycle-dsh-'));
process.env.PASEO_HOME = isolatedPaseoHome;
process.env.DSH_HOME = isolatedDshHome;
const captured = [];
const handlers = [];
const released = [];
bootstrap.ensurePaseoProfile = () => ({ profile: 'fixture', dir: '(fixture)', bridgeFiles: 0 });
reports.capturePaseo = (paseo) => captured.push(paseo);
// Simulate a pure-DSH host (no agy binary / no Antigravity accounts) so the
// conditional `agent.open.before` hook stays un-registered.
agPaths.shouldRegisterAntigravityOpenHookSync = () => false;
agPaths.detectAntigravityPresence = async () => ({
  agyInstalled: false,
  hasAntigravityData: false,
  hasAntigravityAccounts: false,
});
const expectedCaptureHooks = [
  'agent.create.after', 'agent.turn.before', 'agent.turn.after',
  'agent.permission.before', 'agent.permission.after', 'agent.archive.after',
];
// Full allowlist of hooks registered on a pure-DSH host (no `agent.open.before`):
// 6 DSH capture hooks + 4 Antigravity lifecycle hooks + 3 fallback hooks + 2 orchestrator hooks.
const expectedPureDshHooks = [
  ...expectedCaptureHooks,
  'agent.create.before', 'agent.turn.after', 'agent.turn.after', 'agent.archive.after',
  'agent.turn.before', 'agent.archive.after', 'agent.turn.after',
  'agent.turn.after', 'agent.archive.after',
];
(async () => {
  let cleanup;
  try {
    cleanup = require(path.join(build, 'index.server.js')).default({
      addHook(name, handler) {
        const entry = { name, handler };
        handlers.push(entry);
        return () => {
          released.push(name);
          const idx = handlers.indexOf(entry);
          if (idx >= 0) handlers.splice(idx, 1);
        };
      },
      registerProvider() {},
      registerSettings() {},
      registerUsageSource() {},
      handle() {},
    });
    const registeredNames = handlers.map((entry) => entry.name);
    assert.deepEqual(
      registeredNames.slice(0, expectedCaptureHooks.length),
      expectedCaptureHooks,
      'first six hooks are the DSH observation capture hooks',
    );
    assert.equal(
      registeredNames.includes('agent.open.before'),
      false,
      'pure-DSH host must register zero agent.open.before hooks',
    );
    assert.deepEqual(
      registeredNames,
      expectedPureDshHooks,
      'pure-DSH host must match the exact audited hook allowlist',
    );
    for (const { name, handler } of handlers.slice(0, expectedCaptureHooks.length)) {
      const paseo = { marker: name };
      const result = handler({}, { paseo, signal: new AbortController().signal });
      assert(result instanceof Promise, `${name} satisfies the async addHook handler contract`);
      await result;
      assert.equal(captured.at(-1), paseo, `${name} captures this callback's API handle`);
    }
    assert.equal(captured.length, expectedCaptureHooks.length);
    const totalRegistered = handlers.length;
    cleanup();
    cleanup = undefined;
    assert.equal(released.length, totalRegistered, 'cleanup releases every registered hook');
    assert.equal(handlers.length, 0);
    // Drive a mutation of the actual emitted entry: old compatibility hooks
    // must fail even while the host SDK still exports them.
    const filename = path.join(build, 'index.server.js');
    const source = fs.readFileSync(filename, 'utf8');
    assert(source.includes('server.addHook('), 'mutation reaches the real registration call');
    const mutated = new Module(filename, module);
    mutated.filename = filename;
    mutated.paths = Module._nodeModulePaths(build);
    mutated._compile(source.replace('server.addHook(', 'server.on('), filename);
    assert.throws(() => mutated.exports.default({
      addHook() { return () => {}; }, registerProvider() {}, registerSettings() {}, registerUsageSource() {}, handle() {},
    }), /server.on is not a function/);
    console.log('lifecycle hooks: capture hooks, pure-DSH open-hook gating, cleanup and legacy-hook mutation passed');
  } finally {
    cleanup?.();
    bootstrap.ensurePaseoProfile = provision;
    reports.capturePaseo = capture;
    agPaths.shouldRegisterAntigravityOpenHookSync = origOpenGate;
    agPaths.detectAntigravityPresence = origDetectPresence;
    if (prevPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevPaseoHome;
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    fs.rmSync(isolatedPaseoHome, { recursive: true, force: true });
    fs.rmSync(isolatedDshHome, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
