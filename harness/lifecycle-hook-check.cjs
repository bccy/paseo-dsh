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
const { resolvePluginBuild } = require('./plugin-build.cjs');
const build = resolvePluginBuild(process.argv[2], '.dbg-lifecycle-hooks');
const bootstrap = require(path.join(build, 'server/bootstrap.js'));
const reports = require(path.join(build, 'server/rewind-notice-append.js'));
const provision = bootstrap.ensurePaseoProfile;
const capture = reports.capturePaseo;
const captured = [];
const handlers = new Map();
const released = [];
bootstrap.ensurePaseoProfile = () => ({ profile: 'fixture', dir: '(fixture)', bridgeFiles: 0 });
reports.capturePaseo = (paseo) => captured.push(paseo);
const expected = [
  'agent.create.after', 'agent.turn.before', 'agent.turn.after',
  'agent.permission.before', 'agent.permission.after', 'agent.archive.after',
];
(async () => {
  let cleanup;
  try {
    cleanup = require(path.join(build, 'index.server.js')).default({
      addHook(name, handler) {
        assert(!handlers.has(name), `duplicate hook ${name}`);
        handlers.set(name, handler);
        return () => { released.push(name); handlers.delete(name); };
      },
      registerProvider() {},
      handle() {},
    });
    assert.deepEqual([...handlers.keys()], expected, 'exactly the six observation hooks; no open/create before hook');
    for (const [name, handler] of handlers) {
      const paseo = { marker: name };
      const result = handler({}, { paseo, signal: new AbortController().signal });
      assert(result instanceof Promise, `${name} satisfies the async addHook handler contract`);
      await result;
      assert.equal(captured.at(-1), paseo, `${name} captures this callback's API handle`);
    }
    assert.equal(captured.length, expected.length);
    cleanup();
    cleanup = undefined;
    assert.deepEqual(released, expected, 'cleanup releases every registered hook');
    assert.equal(handlers.size, 0);
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
      addHook() { return () => {}; }, registerProvider() {}, handle() {},
    }), /server.on is not a function/);
    console.log('lifecycle hooks: six registrations, handle capture, cleanup and legacy-hook mutation passed');
  } finally {
    cleanup?.();
    bootstrap.ensurePaseoProfile = provision;
    reports.capturePaseo = capture;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
