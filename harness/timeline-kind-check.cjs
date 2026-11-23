/** Actual client entry/stream-stats registrations, without mounting React UI. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { resolvePluginBuild } = require('./plugin-build.cjs');
const build = resolvePluginBuild(process.argv[2], '.dbg-timeline-kinds');
const fromBuild = createRequire(path.join(build, 'index.client.js'));
const entrySource = fs.readFileSync(path.join(build, 'index.client.js'), 'utf8');
const noop = () => {};
function evaluate(source, filename, require) {
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', { console }, { filename })(require, module, module.exports);
  return module.exports;
}
function readKinds(source) {
  const kinds = [];
  const client = {
    addTimelineTransformer() { return noop; },
    addTimelineRenderer(spec) {
      assert.match(spec.kind, /^[a-z][a-z0-9-]*$/, `invalid timeline kind: ${spec.kind}`);
      kinds.push(spec.kind);
      return noop;
    },
    // The screen and sidebar registrations are not timeline kinds; they only
    // need to be accepted so the entry body runs to the renderer registrations.
    addScreen() { return noop; },
    addSidebarHeaderItem() { return noop; },
    rpc() { return Promise.resolve({ status: 'ready', values: {} }); },
    paseo: {},
  };
  const requireClient = (id) => {
    if (id === './client/stream-stats') {
      const file = path.join(build, 'client/stream-stats.js');
      return evaluate(fs.readFileSync(file, 'utf8'), file,
        (name) => name === 'react-native' ? {} : fromBuild(name));
    }
    if (id === './client/rewind-notice-live') return { startRewindLiveMonitor: () => noop };
    if (id === './client/dsh-plugins-page') return { DshPluginsPage: () => null };
    if (id === './client/dsh-plugins-icon') return { PluginsIcon: () => null };
    if (id === './client/settings-screen') {
      return {
        DISPLAY_SETTINGS_ID: 'dsh-display',
        contributeDisplaySettingsCommand: () => noop,
        contributeTimelineSettings: () => noop,
      };
    }
    // The entry runs `installFatalGuard()` on load and registers the screen and
    // sidebar item through `guardCleanup`; none of that is a timeline kind, but
    // the module itself imports React Native, which plain node cannot load.
    if (id === './client/dsh-plugins-guard') {
      return {
        installFatalGuard: noop,
        report: noop,
        guardCleanup: (_label, run) => {
          try {
            return run();
          } catch {
            return noop;
          }
        },
      };
    }
    if (id === '@getpaseo/plugin/client/ui') return { SidebarRow: () => null };
    if (/^\.\/client\/(goal-pill|jobs-pill|team-pill|workspace-badges)$/.test(id)) {
      // These register composer/side-bar surfaces, not timeline kinds.
      return new Proxy({}, { get: () => () => noop });
    }
    if (/^\.\/client\/(inline-thinking|rewind-notice|tool-call)$/.test(id)) return {};
    return fromBuild(id);
  };
  const cleanup = evaluate(source, path.join(build, 'index.client.js'), requireClient).default(client);
  cleanup();
  return kinds;
}
assert.deepEqual(readKinds(entrySource).sort(), ['dsh-thinking', 'dsh-tool', 'dsh-rewind-notice', 'dsh-stream-stats'].sort());
assert(entrySource.includes('dsh-thinking'), 'mutation must reach the actual renderer registration');
assert.throws(() => readKinds(entrySource.replaceAll('dsh-thinking', 'Invalid-kind')), /invalid timeline kind/, 'an invalid registered kind must be rejected');
console.log('timeline kinds: real registrations and invalid-kind mutation passed');
