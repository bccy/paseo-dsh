/**
 * Drive the real goal/team/jobs contribution functions through a recording host.
 * React hooks are a minimal mount/unmount driver; native drawing primitives are
 * stubs. No presentation/seen/observer logic is replaced. This checks composer
 * registration, snapshot/upsert delivery and confirmed popover close behaviour,
 * not pixel layout. No daemon, profile or model is touched.
 * Run: node harness/pill-contribution-check.cjs
 */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { resolvePluginBuild } = require("./plugin-build.cjs");
const build = resolvePluginBuild(process.argv[2], ".dbg-pill-contribution");
let effects;
const react = {
  useState: value => [typeof value === "function" ? value() : value, () => {}],
  useRef: value => ({ current: value }),
  useEffect: callback => effects.push(callback),
  useLayoutEffect: callback => effects.push(callback),
  useMemo: callback => callback(),
  useCallback: callback => callback,
  Fragment: "Fragment",
};
const originalLoad = Module._load;
Module._load = function (id, parent, main) {
  if (id === "react") return react;
  if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "Fragment" };
  if (id === "react-native") return { Platform: { OS: "web" }, View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", TextInput: "TextInput", ActivityIndicator: "ActivityIndicator", Animated: { View: "AnimatedView", Value: class {} } };
  if (id === "@getpaseo/plugin") return { defineRpc: value => value, defineSubscription: value => value };
  if (id === "@getpaseo/plugin/client") return { useAgent: () => undefined };
  if (id === "@getpaseo/plugin/client/ui") return { Icon: "Icon", TextInput: "TextInput" };
  return originalLoad.call(this, id, parent, main);
};
const contributions = {
  goal: require(path.join(build, "client/goal-pill.js")).contributeGoalPill,
  team: require(path.join(build, "client/team-pill.js")).contributeTeamPill,
  jobs: require(path.join(build, "client/jobs-pill.js")).contributeJobsPill,
};
Module._load = originalLoad;
const { teamAllDoneKey } = require(path.join(build, "client/team-polling.js"));
const provider = require(path.join(build, "shared/provider.js")).PROVIDER_ID;
let checks = 0;
const check = (label, actual, expected) => { checks++; assert.deepEqual(actual, expected, label); };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function makeHost(kind, observer) {
  const registrations = [], streams = [], writes = [], errors = [];
  let directory, failUpdate = false;
  const client = {
    addComposerPill(input) {
      const registration = { input, current: { ...input.button }, updates: [], removed: false,
        update(patch) { if (failUpdate) throw new Error("temporary registration failure"); this.updates.push(patch); Object.assign(this.current, patch); },
        remove() { this.removed = true; } };
      registrations.push(registration); return registration;
    },
    subscribe(contract, input, onAnswer, options) { streams.push({ contract, input, onAnswer, options }); return { ready: Promise.resolve() }; },
    paseo: { agents: {
      list: async () => ({ subscription: { subscribe: value => { directory = value; } } }),
      ref: id => ({ setMetadata: async patch => { writes.push({ id, patch }); } }),
    } },
  };
  const cleanup = contributions[kind](client, observer);
  const agent = { id: "agent-a", workspaceId: "workspace-a", provider, status: "idle", background: true };
  return {
    registrations, streams, writes, errors, cleanup, agent,
    setFailUpdate(value) { failUpdate = value; },
    snapshot(metadata = {}) { directory.snapshot({ entries: [{ agent: { ...agent, metadata } }], pageInfo: { hasMore: false, nextCursor: null } }); },
    upsert(metadata = {}) { directory.update({ type: "agent_update", payload: { kind: "upsert", agent: { ...agent, metadata } } }); },
    push(answer) { streams.at(-1).onAnswer(answer); },
    end(error = new Error("subscription ended")) { streams.at(-1).options.onClosed({ error }); },
    get current() { return registrations.at(-1).current; },
    closePanel() {
      effects = [];
      const content = this.current.behavior.Content;
      content({ theme: { colors: {} }, layout: { compact: false, platform: "web" }, close() {} });
      const cleanups = effects.map(effect => effect()).filter(value => typeof value === "function");
      const originalTimeout = global.setTimeout, originalClear = global.clearTimeout;
      const timers = new Map(); let next = 0;
      global.setTimeout = (callback, delay) => { assert.equal(delay, 250); const id = ++next; timers.set(id, callback); return id; };
      global.clearTimeout = id => timers.delete(id);
      try { for (const cleanup of cleanups) cleanup(); for (const callback of timers.values()) callback(); }
      finally { global.setTimeout = originalTimeout; global.clearTimeout = originalClear; }
    },
  };
}
const goal = id => ({ id, revision: 1, phase: "complete", objective: id, activation: "disarmed", roundsStarted: 1, maxGoalRounds: 5 });
const team = id => ({ enabled: true, members: [], tasks: [{ id, revision: 1, subject: id, description: "", status: "completed", blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [] }] });
const value = (kind, id) => kind === "goal" ? goal(id) : team(id);
const key = (kind, item) => kind === "goal" ? `${item.id}:${item.revision}` : teamAllDoneKey(item);
const answer = (kind, item) => ({ available: true, [kind]: item });
async function main() {
  for (const kind of ["goal", "team"]) {
    const h = makeHost(kind); await flush(); h.snapshot();
    const old = value(kind, "old"), next = value(kind, "new");
    h.push(answer(kind, old)); check(`${kind}: completed state is visible`, h.current.visible, true);
    h.closePanel(); await flush(); check(`${kind}: confirmed local close hides`, h.current.visible, false);
    check(`${kind}: one metadata write`, h.writes.length, 1);
    h.upsert(h.writes[0].patch);
    h.push(answer(kind, next)); check(`${kind}: new state appears`, h.current.visible, true);
    h.upsert({ [`dsh.${kind}Seen`]: key(kind, next) });
    check(`${kind}: remote new close supersedes old local close`, h.current.visible, false);
    const later = value(kind, "later"); h.push(answer(kind, later));
    check(`${kind}: later completion appears`, h.current.visible, true);
    h.snapshot({ [`dsh.${kind}Seen`]: key(kind, later) });
    check(`${kind}: reconnect metadata hides current completion`, h.current.visible, false);
    check(`${kind}: snapshot keeps one registration`, h.registrations.length, 1);
    check(`${kind}: snapshot keeps one subscription`, h.streams.length, 1);
    h.cleanup(); check(`${kind}: cleanup releases stream`, h.streams[0].options.signal.aborted, true);
  }
  for (const kind of ["goal", "team", "jobs"]) {
    const h = makeHost(kind); await flush(); h.snapshot();
    const pushed = kind === "jobs"
      ? { available: true, jobs: [{ id: "job-live", status: "running", description: "live", createdAt: 1 }] }
      : answer(kind, value(kind, "completed"));
    h.setFailUpdate(true);
    h.push(pushed);
    check(`${kind}: failed registration update leaves host hidden`, h.current.visible, false);
    h.setFailUpdate(false);
    h.push(pushed);
    check(`${kind}: identical answer retries failed publication`, h.current.visible, true);
    check(`${kind}: successful update is delivered once`, h.registrations[0].updates.length, 1);
    h.push(pushed);
    check(`${kind}: duplicate after success stays deduplicated`, h.registrations[0].updates.length, 1);
    h.cleanup();
  }
  for (const kind of ["goal", "team", "jobs"]) {
    const observed = { agents: [], states: [], removed: [] };
    const h = makeHost(kind, {
      agent: agent => observed.agents.push(agent),
      state: (id, state) => observed.states.push({ id, ...state }),
      remove: id => observed.removed.push(id),
    });
    await flush(); h.snapshot();
    check(`${kind}: observer sees background without hiding it`, observed.agents[0].background, true);
    const item = kind === "jobs" ? [{ id: "job-observed", status: "running", description: "live", createdAt: 1 }] : value(kind, "observed");
    h.push({ available: true, [kind]: item });
    check(`${kind}: observer sees successful payload`, observed.states.at(-1).data, item);
    check(`${kind}: observer sees actual visibility after presentation`, observed.states.at(-1).visible, true);
    h.push({ available: false, error: { code: "rpc_failed", message: "temporarily unavailable" } });
    check(`${kind}: observer sees unavailable despite retained UI`, observed.states.at(-1).available, false);
    check(`${kind}: observer preserves known payload on failure`, observed.states.at(-1).data, item);
    check(`${kind}: transient read leaves UI visible`, h.current.visible, true);
    if (kind !== "jobs") {
      h.upsert({ [`dsh.${kind}Seen`]: key(kind, item) });
      check(`${kind}: metadata-only close reaches observer`, observed.states.at(-1).visible, false);
      check(`${kind}: metadata-only close retains failure fact`, observed.states.at(-1).available, false);
      const next = value(kind, "observed-new"); h.push(answer(kind, next));
      h.closePanel(); await flush();
      check(`${kind}: confirmed panel close reaches observer`, observed.states.at(-1).visible, false);
      check(`${kind}: recovered answer restores availability`, observed.states.at(-1).available, true);
    }
    check(`${kind}: observer adds no subscription`, h.streams.length, 1);
    h.cleanup();
    check(`${kind}: cleanup removes observer state`, observed.removed, ["agent-a"]);
  }
  {
    const h = makeHost("goal", {
      agent() { throw new Error("observer agent failure"); },
      state() { throw new Error("observer state failure"); },
      remove() { throw new Error("observer removal failure"); },
    });
    await flush(); h.snapshot(); h.push(answer("goal", goal("observer-throws")));
    check("an observer failure cannot stop the pill", h.current.visible, true);
    h.cleanup();
    check("an observer failure cannot stop cleanup", h.streams[0].options.signal.aborted, true);
  }
  for (const kind of ["goal", "team", "jobs"]) {
    const current = new Map(), events = [];
    const h = makeHost(kind, {
      agent(agent) { current.set(agent.id, {}); events.push("agent"); },
      state(id, state) { check(`${kind}: a state always belongs to a registered observer agent`, current.has(id), true); current.set(id, state); events.push("state"); },
      remove(id) { current.delete(id); events.push("remove"); },
    });
    await flush(); h.snapshot();
    const pushed = kind === "jobs"
      ? { available: true, jobs: [{ id: "reconnect-job", status: "running", description: "live", createdAt: 1 }] }
      : answer(kind, value(kind, "reconnect"));
    h.push(pushed);
    h.end();
    check(`${kind}: subscription end removes observer ownership`, current.size, 0);
    check(`${kind}: subscription end keeps the existing composer UI`, h.current.visible, true);
    const at = events.length;
    h.snapshot();
    check(`${kind}: reopen registers the observer before any state`, events[at], "agent");
    h.push(pushed);
    check(`${kind}: same-value recovery publishes current observer state`, current.get(h.agent.id)?.available, true);
    check(`${kind}: same-value recovery carries current visibility`, current.get(h.agent.id)?.visible, true);
    check(`${kind}: exactly one replacement subscription`, h.streams.length, 2);
    h.cleanup();
  }
  console.log(`${checks} contribution checks passed`);
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
