#!/usr/bin/env node
/**
 * One CI gate for local work, pull requests and upstream sync.
 * Only offline source checks, temporary fixtures, and fake DSH children belong
 * here. Installed DSH/Paseo, real profiles, a daemon and models are not required.
 * See docs/HARNESS.md. --list prints the inventory without building or running.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildPlugin, freshness, PLUGIN_DIR } = require('./plugin-build.cjs');
const root = path.resolve(__dirname, '..');
const sourceChecks = [
  'bridge-assets-check.mjs', 'archived-lineage-check.mjs', 'image-host-path-check.mjs',
  'paseo-system-envelope-check.mjs', 'revert-check.mjs', 'surface-check.mjs',
  'file-snapshot-check.mjs', 'snapshot-lifecycle-check.mjs', 'file-mutation-gate-check.mjs',
  'rewind-merge-check.mjs', 'mcp-http-check.mjs', 'mcp-stdio-check.mjs',
  'doctor-check.mjs', 'probe-check.mjs', 'plugin-build-check.mjs',
  'frame-reader-check.mjs', 'transport-frame-check.mjs', 'replay-turn-check.cjs',
  'concurrent-open-check.mjs', 'bootstrap-check.mjs', 'bridge-entry-check.mjs',
  'catalog-cache-check.mjs', 'open-degrade-check.mjs', 'session-state-check.cjs',
  'harness-gates-check.mjs', 'goal-timeline-check.cjs', 'rewind-notice-check.cjs',
  'subagent-history-check.cjs', 'pill-contribution-check.cjs',
  'lifecycle-hook-check.cjs', 'timeline-kind-check.cjs', 'workspace-badges-check.cjs', 'pool-prewarm-check.mjs', 'profile-child-gate-check.mjs',
  'multi-session-check.mjs', 'process-crash-check.mjs', 'child-crash-check.mjs',
  'reload-port-race-check.mjs', 'shared-process-cwd-check.mjs',
];
// These older checks require siblings relative to their compiled entry. Copying
// only the harness scripts leaves the plugin-build stamp/output set intact.
const compiledChecks = [
  'jobs-poll-check.cjs', 'pill-feed-check.cjs', 'goal-pill-check.cjs',
  'goal-server-check.cjs', 'team-server-check.cjs', 'team-pill-check.cjs',
  'jobs-stop-ui-check.cjs', 'session-request-check.cjs', 'subagent-check.cjs',
  'uploaded-file-check.cjs', 'assistant-stream-check.cjs', 'assistant-retry-check.cjs',
  'mcp-injection-check.cjs', 'image-check.cjs', 'steer-check.cjs',
  'timeline-check.cjs', 'tool-call-check.cjs', 'locale-check.cjs',
];
const inventory = ['typecheck', 'bridge syntax', ...sourceChecks, ...compiledChecks, 'plugin-check.cjs --self-test'];
const args = process.argv.slice(2);
if (args.includes('--list')) {
  console.log(inventory.join('\n'));
  process.exit(0);
}
if (args.some((arg) => arg !== '--keep-going')) {
  console.error('usage: node harness/offline-checks.cjs [--list | --keep-going]');
  process.exit(2);
}
const failures = [];
function run(label, script, argv = [], env = process.env, cwd = root) {
  console.log(`\n[offline] ${label}`);
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd, env, stdio: 'inherit', timeout: 240_000,
  });
  if (result.status === 0 && !result.error) return;
  failures.push(label);
  console.error(`[offline] FAILED ${label}: ${result.error?.message ?? `exit ${String(result.status)}, signal ${String(result.signal)}`}`);
  if (!args.includes('--keep-going') || label === 'typecheck') process.exit(1);
}
// Real type checking is a separate mandatory gate. plugin-build's CJS emit may
// report ESM declaration-resolution diagnostics, but may not replace this gate.
run('typecheck', path.join(PLUGIN_DIR, 'node_modules/typescript/bin/tsc'), ['--noEmit'], process.env, PLUGIN_DIR);
run('bridge syntax', '--check', [path.join(root, 'dsh-bridge/lib/server.js')]);
const build = buildPlugin({ dir: '.dbg-offline-checks' });
function assertFresh() {
  const state = freshness(build);
  if (!state.fresh) throw new Error(`offline build became stale: ${state.reasons.join('; ')}`);
}
assertFresh();
const env = { ...process.env, PASEO_PLUGIN_BUILD: build };
for (const name of sourceChecks) {
  assertFresh();
  run(name, path.join(__dirname, name), [], env);
}
for (const name of [...compiledChecks, 'plugin-check.cjs', 'fake-dsh-bridge.mjs']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(build, name));
}
for (const name of compiledChecks) {
  assertFresh();
  run(name, path.join(build, name), [], env, build);
}
assertFresh();
run('plugin-check.cjs --self-test', path.join(build, 'plugin-check.cjs'), ['--self-test'], env, build);
console.log(`\n[offline] ${inventory.length - failures.length}/${inventory.length} gates passed`);
if (failures.length) console.error(`[offline] failed: ${failures.join(', ')}`);
process.exitCode = failures.length ? 1 : 0;
