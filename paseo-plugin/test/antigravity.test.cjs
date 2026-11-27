require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  CAPABILITIES_GET_METHOD,
  buildCapabilitiesSnapshot,
  capabilitiesGetRpc,
  capabilitiesSnapshotSchema,
} = require("../shared/capabilities.ts");
const agContracts = require("../shared/antigravity/contracts.ts");
const {
  ANTIGRAVITY_DEFAULT_PRICING,
  parseLegacyAntigravityPricing,
  resolvePricingKey: resolveAgPricingKey,
} = require("../shared/antigravity/pricing-defaults.ts");
const {
  ANTIGRAVITY_REFERENCE_PRICING,
  calculateCallCost,
  matchAntigravityReferenceEntry,
} = require("../shared/pricing.ts");
const { PricingStore } = require("../server/pricing.ts");
const { UsageStatsEngine } = require("../server/usage-stats.ts");
const {
  detectAntigravityPresence,
  migrateLegacyDataDir,
  resolveAgySync,
  shouldRegisterAntigravityOpenHookSync,
} = require("../server/antigravity/paths.ts");
const { ContextReader, conversationIdFrom } = require("../server/antigravity/context.ts");
const { registerAntigravityServer } = require("../server/antigravity/index.ts");
const { detectDshPresence, isDshBinaryResolvable } = require("../index.server.ts");
const { createAntigravityTimelineTransforms } = require("../client/antigravity/transform.ts");
const { formatQuestionEcho } = require("../client/antigravity/questionModel.ts");

function makeTempDir(t, prefix = "paseo-ag-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeExecutable(filePath, content = "#!/bin/sh\nexit 0\n") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFakeServer({ includeUsageSource = true } = {}) {
  const hooks = [];
  const rpcs = [];
  const usageSources = [];
  const server = {
    addHook(name, handler) {
      const entry = { name, handler, removed: false };
      hooks.push(entry);
      return () => {
        entry.removed = true;
      };
    },
    handle(def, handler) {
      rpcs.push({ name: def.name, def, handler });
      return () => {};
    },
    registerProvider() {},
    registerSettings() {},
  };
  if (includeUsageSource) {
    server.registerUsageSource = (source) => {
      usageSources.push(source);
    };
  }
  return { server, hooks, rpcs, usageSources };
}

function loadConsoleScreenHelpers() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(id, parent, isMain) {
    if (id === "react-native") {
      return {
        ScrollView: () => null,
        Text: () => null,
        View: () => null,
        Pressable: () => null,
        TextInput: () => null,
        ActivityIndicator: () => null,
        StyleSheet: { create: (styles) => styles },
        Platform: { OS: "ios", select: (obj) => obj.default ?? obj.ios },
        useWindowDimensions: () => ({ width: 1024, height: 768 }),
      };
    }
    if (id === "@getpaseo/plugin/client/ui") {
      return new Proxy({}, { get: () => () => null });
    }
    return originalLoad.call(this, id, parent, isMain);
  };
  try {
    return require("../client/console-screen.tsx");
  } finally {
    Module._load = originalLoad;
  }
}

function assertApprox(actual, expected, eps = 1e-6, label = "value") {
  assert.equal(typeof actual, "number", `${label}: expected number, got ${typeof actual}`);
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${label}: expected ${expected} (+/- ${eps}), got ${actual}`,
  );
}

// ============================================================================
// 1. Bidirectional capability detection (both / DSH-only / Antigravity-only / neither)
// ============================================================================

test("buildCapabilitiesSnapshot covers all 4 bidirectional visibility states and indirect signals", () => {
  assert.equal(CAPABILITIES_GET_METHOD, "dsh.capabilities.get");
  assert.equal(capabilitiesGetRpc.name, "dsh.capabilities.get");

  const both = buildCapabilitiesSnapshot({
    dshInstalled: true,
    hasDshSessions: true,
    agyInstalled: true,
    hasAntigravityData: true,
    hasAntigravityAccounts: true,
  });
  assert.deepEqual(capabilitiesSnapshotSchema.parse(both), {
    dshInstalled: true,
    hasDshSessions: true,
    dshVisible: true,
    agyInstalled: true,
    hasAntigravityData: true,
    hasAntigravityAccounts: true,
    antigravityVisible: true,
  });

  const dshOnly = buildCapabilitiesSnapshot({
    dshInstalled: true,
    hasDshSessions: false,
    agyInstalled: false,
    hasAntigravityData: false,
    hasAntigravityAccounts: false,
  });
  assert.equal(dshOnly.dshVisible, true);
  assert.equal(dshOnly.antigravityVisible, false);

  const agyOnly = buildCapabilitiesSnapshot({
    dshInstalled: false,
    hasDshSessions: false,
    agyInstalled: true,
    hasAntigravityData: false,
    hasAntigravityAccounts: false,
  });
  assert.equal(agyOnly.dshVisible, false);
  assert.equal(agyOnly.antigravityVisible, true);

  const neither = buildCapabilitiesSnapshot({
    dshInstalled: false,
    hasDshSessions: false,
    agyInstalled: false,
    hasAntigravityData: false,
    hasAntigravityAccounts: false,
  });
  assert.equal(neither.dshVisible, false);
  assert.equal(neither.antigravityVisible, false);

  // Indirect visibility: historical sessions / data / accounts keep the tab visible even if CLI is uninstalled.
  assert.equal(
    buildCapabilitiesSnapshot({
      dshInstalled: false,
      hasDshSessions: true,
      agyInstalled: false,
      hasAntigravityData: false,
      hasAntigravityAccounts: false,
    }).dshVisible,
    true,
  );
  assert.equal(
    buildCapabilitiesSnapshot({
      dshInstalled: false,
      hasDshSessions: false,
      agyInstalled: false,
      hasAntigravityData: true,
      hasAntigravityAccounts: false,
    }).antigravityVisible,
    true,
  );
  assert.equal(
    buildCapabilitiesSnapshot({
      dshInstalled: false,
      hasDshSessions: false,
      agyInstalled: false,
      hasAntigravityData: false,
      hasAntigravityAccounts: true,
    }).antigravityVisible,
    true,
  );
});

test("detectDshPresence & detectAntigravityPresence probe binaries, sessions, data, and accounts cleanly", async (t) => {
  const root = makeTempDir(t, "paseo-caps-");
  const emptyBin = path.join(root, "empty-bin");
  const dshBinDir = path.join(root, "dsh-bin");
  const agyBinDir = path.join(root, "agy-bin");
  const dshHomeDir = path.join(root, "dsh-home");
  const homeDir = path.join(root, "home");
  const paseoHomeDir = path.join(root, "paseo-home");
  const cliDir = path.join(homeDir, ".gemini", "antigravity-cli");
  fs.mkdirSync(emptyBin, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(paseoHomeDir, { recursive: true });

  // Neither installed, no data
  const emptyDsh = await detectDshPresence({
    env: { DSH_HOME: dshHomeDir, PATH: emptyBin },
    cwd: root,
    platform: "linux",
  });
  assert.deepEqual(emptyDsh, { dshInstalled: false, hasDshSessions: false });
  assert.equal(
    isDshBinaryResolvable({ env: { PATH: emptyBin }, cwd: root, platform: "linux" }),
    false,
  );

  const emptyAgy = await detectAntigravityPresence({
    paseoHome: paseoHomeDir,
    homeDir,
    cliDir,
    pathEnv: emptyBin,
    systemCandidates: [],
  });
  assert.deepEqual(emptyAgy, {
    agyInstalled: false,
    hasAntigravityData: false,
    hasAntigravityAccounts: false,
  });

  // DSH session file only (no binary) -> dshVisible true via hasDshSessions
  const sessFile = path.join(dshHomeDir, "sessions", "2026", "s1.v4.jsonl.zstd");
  fs.mkdirSync(path.dirname(sessFile), { recursive: true });
  fs.writeFileSync(sessFile, "stub");
  const dshSessionsOnly = await detectDshPresence({
    env: { DSH_HOME: dshHomeDir, PATH: emptyBin },
    cwd: root,
    platform: "linux",
  });
  assert.deepEqual(dshSessionsOnly, { dshInstalled: false, hasDshSessions: true });

  // DSH binary installed
  makeExecutable(path.join(dshBinDir, "dsh"));
  const dshInstalled = await detectDshPresence({
    env: { DSH_HOME: dshHomeDir, PATH: dshBinDir },
    cwd: root,
    platform: "linux",
  });
  assert.deepEqual(dshInstalled, { dshInstalled: true, hasDshSessions: true });

  // Antigravity conversation DB only (no binary, no profile accounts)
  const convDb = path.join(cliDir, "conversations", "11111111-2222-3333-4444-555555555555.db");
  fs.mkdirSync(path.dirname(convDb), { recursive: true });
  fs.writeFileSync(convDb, "");
  const agyDataOnly = await detectAntigravityPresence({
    paseoHome: paseoHomeDir,
    homeDir,
    cliDir,
    pathEnv: emptyBin,
    systemCandidates: [],
  });
  assert.deepEqual(agyDataOnly, {
    agyInstalled: false,
    hasAntigravityData: true,
    hasAntigravityAccounts: false,
  });

  // Antigravity binary + profile account
  makeExecutable(path.join(agyBinDir, "agy"));
  writeJson(path.join(paseoHomeDir, "plugin-data", "dsh-paseo", "antigravity", "accounts.json"), {
    version: 1,
    defaultAccountId: "a1111111",
    accounts: [{ id: "a1111111", label: "Work" }],
  });
  const agyFull = await detectAntigravityPresence({
    paseoHome: paseoHomeDir,
    homeDir,
    cliDir,
    pathEnv: agyBinDir,
    systemCandidates: [],
  });
  assert.deepEqual(agyFull, {
    agyInstalled: true,
    hasAntigravityData: true,
    hasAntigravityAccounts: true,
  });
});

test("visibleConsoleTabs and defaultConsoleTab adapt cleanly to all 4 capability states", () => {
  const { visibleConsoleTabs, defaultConsoleTab } = loadConsoleScreenHelpers();

  // Loading baseline (capabilities undefined): safe DSH default without flashing Antigravity UI
  assert.deepEqual(visibleConsoleTabs(undefined), ["usage", "plugins", "settings"]);
  assert.equal(defaultConsoleTab(undefined), "usage");

  // Both
  const both = buildCapabilitiesSnapshot({
    dshInstalled: true,
    hasDshSessions: false,
    agyInstalled: true,
    hasAntigravityData: false,
    hasAntigravityAccounts: false,
  });
  assert.deepEqual(visibleConsoleTabs(both), ["usage", "antigravity", "plugins", "settings"]);
  assert.equal(defaultConsoleTab(both), "usage");

  // DSH-only
  const dshOnly = buildCapabilitiesSnapshot({
    dshInstalled: true,
    hasDshSessions: false,
    agyInstalled: false,
    hasAntigravityData: false,
    hasAntigravityAccounts: false,
  });
  assert.deepEqual(visibleConsoleTabs(dshOnly), ["usage", "plugins", "settings"]);
  assert.equal(defaultConsoleTab(dshOnly), "usage");

  // Antigravity-only
  const agyOnly = buildCapabilitiesSnapshot({
    dshInstalled: false,
    hasDshSessions: false,
    agyInstalled: true,
    hasAntigravityData: false,
    hasAntigravityAccounts: false,
  });
  assert.deepEqual(visibleConsoleTabs(agyOnly), ["usage", "antigravity", "settings"]);
  assert.equal(defaultConsoleTab(agyOnly), "usage");

  // Neither
  const neither = buildCapabilitiesSnapshot({
    dshInstalled: false,
    hasDshSessions: false,
    agyInstalled: false,
    hasAntigravityData: false,
    hasAntigravityAccounts: false,
  });
  assert.deepEqual(visibleConsoleTabs(neither), ["settings"]);
  assert.equal(defaultConsoleTab(neither), "settings");
});

// ============================================================================
// 2. Conditional `agent.open.before` hook gating
// ============================================================================

test("shouldRegisterAntigravityOpenHookSync gates strictly on agy binary or profile accounts", (t) => {
  const root = makeTempDir(t, "paseo-open-gate-");
  const emptyBin = path.join(root, "empty-bin");
  const homeDir = path.join(root, "home");
  const paseoHomeDir = path.join(root, "paseo-home");
  const primaryDataDir = path.join(paseoHomeDir, "plugin-data", "dsh-paseo", "antigravity");
  const legacyDataDir = path.join(paseoHomeDir, "plugin-data", "antigravity-accounts");
  fs.mkdirSync(emptyBin, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  const baseOpts = {
    paseoHome: paseoHomeDir,
    homeDir,
    pathEnv: emptyBin,
    systemCandidates: [],
    primaryDataDir,
    legacyDataDir,
  };

  // Pure DSH host: neither agy nor profile accounts -> false
  assert.equal(resolveAgySync(baseOpts), null);
  assert.equal(shouldRegisterAntigravityOpenHookSync(baseOpts), false);

  // Empty accounts.json (`accounts: []`) must still return false
  writeJson(path.join(primaryDataDir, "accounts.json"), { version: 1, accounts: [] });
  assert.equal(shouldRegisterAntigravityOpenHookSync(baseOpts), false);

  // Legacy accounts.json with >= 1 profile account -> true
  writeJson(path.join(legacyDataDir, "accounts.json"), {
    version: 1,
    accounts: [{ id: "a1234567", label: "Legacy" }],
  });
  assert.equal(shouldRegisterAntigravityOpenHookSync(baseOpts), true);
  fs.rmSync(path.join(legacyDataDir, "accounts.json"));

  // Primary accounts.json with >= 1 profile account -> true
  writeJson(path.join(primaryDataDir, "accounts.json"), {
    version: 1,
    accounts: [{ id: "a7654321", label: "Primary" }],
  });
  assert.equal(shouldRegisterAntigravityOpenHookSync(baseOpts), true);
  fs.rmSync(path.join(primaryDataDir, "accounts.json"));
  assert.equal(shouldRegisterAntigravityOpenHookSync(baseOpts), false);

  // config.json override pointing to executable agy -> true
  const customAgy = makeExecutable(path.join(root, "custom", "agy-bin"));
  writeJson(path.join(paseoHomeDir, "config.json"), {
    agents: { providers: { antigravity: { command: [customAgy, "acp"] } } },
  });
  assert.equal(resolveAgySync(baseOpts), customAgy);
  assert.equal(shouldRegisterAntigravityOpenHookSync(baseOpts), true);
  fs.rmSync(path.join(paseoHomeDir, "config.json"));

  // PATH containing executable agy -> true
  const pathBin = path.join(root, "path-bin");
  const pathAgy = makeExecutable(path.join(pathBin, "agy"));
  assert.equal(resolveAgySync({ ...baseOpts, pathEnv: pathBin }), pathAgy);
  assert.equal(shouldRegisterAntigravityOpenHookSync({ ...baseOpts, pathEnv: pathBin }), true);
});

test("registerAntigravityServer registers 0 agent.open.before hooks when gated off, and 1 when gated on", async (t) => {
  const prevPaseoHome = process.env.PASEO_HOME;
  const tempPaseo = makeTempDir(t, "paseo-reg-hooks-");
  process.env.PASEO_HOME = tempPaseo;
  t.after(() => {
    if (prevPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevPaseoHome;
  });

  // 1. Gated off (pure DSH host)
  const off = createFakeServer();
  const handleOff = registerAntigravityServer(off.server, {
    registerOpenBefore: false,
    detectPresence: async () => ({
      agyInstalled: false,
      hasAntigravityData: false,
      hasAntigravityAccounts: false,
    }),
  });
  try {
    assert.equal(handleOff.openHookRegistered, false);
    const openHooks = off.hooks.filter((h) => h.name === "agent.open.before");
    assert.equal(openHooks.length, 0, "pure-DSH host must register zero agent.open.before hooks");
    assert.equal(off.usageSources.length, 1);
  } finally {
    handleOff.dispose();
  }
  assert.ok(
    off.hooks.every((h) => h.removed),
    "dispose() must remove every registered hook",
  );

  // 2. Gated on (Antigravity present)
  const on = createFakeServer();
  const handleOn = registerAntigravityServer(on.server, {
    registerOpenBefore: true,
    detectPresence: async () => ({
      agyInstalled: false,
      hasAntigravityData: false,
      hasAntigravityAccounts: false,
    }),
  });
  try {
    assert.equal(handleOn.openHookRegistered, true);
    const openHooks = on.hooks.filter((h) => h.name === "agent.open.before");
    assert.equal(openHooks.length, 1, "Antigravity host must register agent.open.before");

    // Non-antigravity providers pass through untouched
    const passthrough = await openHooks[0].handler(
      {
        request: {
          agentId: "dsh-1",
          provider: "deepseek-harness-native",
          purpose: "interactive",
          metadata: {},
          env: {},
        },
      },
      { paseo: {}, signal: new AbortController().signal },
    );
    assert.equal(passthrough, undefined);
  } finally {
    handleOn.dispose();
  }
  assert.ok(
    on.hooks.every((h) => h.removed),
    "dispose() must remove agent.open.before and all other hooks",
  );
});

// ============================================================================
// 3. One-time legacy data dir migration (copies files + preserves symlinks + leaves legacy untouched + idempotent)
// ============================================================================

test("migrateLegacyDataDir copies files, preserves symlinks verbatim, leaves legacy dir untouched, and is idempotent", async (t) => {
  const root = makeTempDir(t, "paseo-migrate-");
  const legacyDir = path.join(root, "antigravity-accounts");
  const targetDir = path.join(root, "dsh-paseo", "antigravity");
  const sharedReal = path.join(root, "real-gemini-cli");
  fs.mkdirSync(path.join(sharedReal, "conversations"), { recursive: true });
  fs.mkdirSync(path.join(sharedReal, "brain"), { recursive: true });
  fs.mkdirSync(path.join(sharedReal, "implicit"), { recursive: true });
  fs.writeFileSync(path.join(sharedReal, "conversations", "sentinel.txt"), "real-shared");

  // Populate legacy data dir
  const accountsPayload = { version: 1, defaultAccountId: "a1234567", accounts: [{ id: "a1234567", label: "Work" }] };
  writeJson(path.join(legacyDir, "accounts.json"), accountsPayload);
  writeJson(path.join(legacyDir, "conversation-accounts.json"), { "conv-1": "a1234567" });
  writeJson(path.join(legacyDir, "status.json"), { a1234567: { status: "signed-in" } });
  writeJson(path.join(legacyDir, "pricing.json"), { version: 1, overrides: { "gemini-4-neon": { input: 4, cached: 0.2, output: 20 } } });

  const legacyCliDir = path.join(legacyDir, "profiles", "a1234567", "home", ".gemini", "antigravity-cli");
  fs.mkdirSync(legacyCliDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "profiles", "a1234567", "home", "token.dat"), "profile-file");
  fs.symlinkSync(path.join(sharedReal, "conversations"), path.join(legacyCliDir, "conversations"));
  fs.symlinkSync(path.join(sharedReal, "brain"), path.join(legacyCliDir, "brain"));
  fs.symlinkSync(path.join(sharedReal, "implicit"), path.join(legacyCliDir, "implicit"));

  // Run concurrent first-boot migrations to verify single-flight safety
  const [first, concurrent] = await Promise.all([
    migrateLegacyDataDir({ legacyDir, targetDir }),
    migrateLegacyDataDir({ legacyDir, targetDir }),
  ]);
  assert.equal(first.migrated, true);
  assert.deepEqual(first, concurrent);
  assert.deepEqual(
    [...first.copiedEntries].sort(),
    ["accounts.json", "conversation-accounts.json", "pricing.json", "profiles", "status.json"],
  );

  // Verify regular files copied accurately
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(targetDir, "accounts.json"), "utf8")), accountsPayload);
  assert.equal(
    fs.readFileSync(path.join(targetDir, "profiles", "a1234567", "home", "token.dat"), "utf8"),
    "profile-file",
  );

  // Verify symlinks preserved verbatim (NOT dereferenced into copies)
  const targetCliDir = path.join(targetDir, "profiles", "a1234567", "home", ".gemini", "antigravity-cli");
  for (const dirName of ["conversations", "brain", "implicit"]) {
    const linkPath = path.join(targetCliDir, dirName);
    const lstat = fs.lstatSync(linkPath);
    assert.equal(lstat.isSymbolicLink(), true, `${dirName} must remain a symlink`);
    assert.equal(fs.readlinkSync(linkPath), path.join(sharedReal, dirName));
  }

  // Verify legacy directory left completely untouched as backup
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(legacyDir, "accounts.json"), "utf8")), accountsPayload);
  assert.equal(fs.lstatSync(path.join(legacyCliDir, "conversations")).isSymbolicLink(), true);

  // Mutate target accounts.json and run migration again -> must be idempotent no-op
  const updatedAccounts = { ...accountsPayload, defaultAccountId: "default" };
  writeJson(path.join(targetDir, "accounts.json"), updatedAccounts);
  const second = await migrateLegacyDataDir({ legacyDir, targetDir });
  assert.deepEqual(second, { migrated: false, copiedEntries: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(targetDir, "accounts.json"), "utf8")), updatedAccounts);
});

// ============================================================================
// 4. Deterministic `tool_call` transformer precedence + echo suppression
// ============================================================================

test("Antigravity tool_call transforms handle invoke_subagent, manage_subagents, ask_question, echo suppression, and let DSH tools fall through", () => {
  const transforms = createAntigravityTimelineTransforms();

  // 4a. invoke_subagent (sub_agent with agy brain log)
  const childUuid = "12345678-1234-4123-8123-123456789abc";
  const subagentNative = transforms.transformToolCall({
    type: "tool_call",
    callId: "call-1",
    name: "invoke_subagent",
    status: "running",
    detail: {
      type: "sub_agent",
      childSessionId: childUuid,
      subAgentType: "explorer",
      description: "Inspect repository layout",
      log: `/home/user/.gemini/antigravity-cli/brain/${childUuid}/trace.log`,
    },
  });
  assert.equal(subagentNative?.items.length, 1);
  assert.equal(subagentNative.items[0].kind, agContracts.SUBAGENT_TIMELINE_KIND);
  assert.equal(subagentNative.items[0].data.id, childUuid);
  assert.equal(subagentNative.items[0].data.task, "Inspect repository layout");

  // Non-agy log path must NOT be hijacked by Antigravity
  const foreignSubagent = transforms.transformToolCall({
    type: "tool_call",
    callId: "call-foreign",
    name: "invoke_subagent",
    status: "running",
    detail: {
      type: "sub_agent",
      childSessionId: childUuid,
      log: "/tmp/other-provider/subagent.log",
    },
  });
  assert.equal(foreignSubagent, undefined);

  // 4b. invoke_subagent over generic ACP (`unknown` detail)
  const subagentAcp = transforms.transformToolCall({
    type: "tool_call",
    callId: "call-2",
    name: "invoke_subagent",
    status: "completed",
    detail: {
      type: "unknown",
      input: { Prompt: "Verify tests", Role: "verifier", TypeName: "worker" },
      output: `Started child ${childUuid}`,
    },
  });
  assert.equal(subagentAcp?.items[0].kind, agContracts.SUBAGENT_TIMELINE_KIND);
  assert.equal(subagentAcp.items[0].data.id, childUuid);
  assert.equal(subagentAcp.items[0].data.role, "verifier");

  // 4c. manage_subagents
  const manageList = transforms.transformToolCall({
    type: "tool_call",
    callId: "call-3",
    name: "manage_subagents",
    status: "completed",
    detail: {
      type: "unknown",
      input: { Action: "list" },
      output: `You have 1 active subagent(s): [{"conversationId":"${childUuid}","role":"verifier","state":"idle"}]`,
    },
  });
  assert.equal(manageList?.items[0].kind, agContracts.SUBAGENT_LIST_TIMELINE_KIND);
  assert.equal(manageList.items[0].data.states[0].state, "done");

  // 4d. ask_question + plain-text echo suppression
  const askInput = {
    questions: [
      {
        question: "Which target should we deploy?",
        options: ["Staging", "Production"],
      },
    ],
  };
  const askRes = transforms.transformToolCall({
    type: "tool_call",
    callId: "call-4",
    name: "ask_question",
    status: "running",
    detail: {
      type: "unknown",
      input: askInput,
      output: null,
    },
  });
  assert.equal(askRes?.items[0].kind, agContracts.ASK_QUESTION_TIMELINE_KIND);
  assert.equal(askRes.items[0].data.callId, "call-4");
  assert.equal(askRes.items[0].data.questions.length, 1);

  const echoText = formatQuestionEcho(askRes.items[0].data.questions);
  assert.deepEqual(
    transforms.transformAssistantMessage({ type: "assistant_message", text: echoText }),
    { items: [] },
    "matching plain-text question echo must be suppressed",
  );
  assert.equal(
    transforms.transformAssistantMessage({ type: "assistant_message", text: "Normal assistant reply." }),
    undefined,
    "normal assistant replies must not be suppressed",
  );

  // 4e. Normal DSH tools return undefined so dsh-inline-tool maps them to dsh-tool
  for (const name of ["bash", "read_file", "edit_file", "search_grep"]) {
    assert.equal(
      transforms.transformToolCall({
        type: "tool_call",
        callId: `dsh-${name}`,
        name,
        status: "completed",
        detail: { type: "unknown", input: { command: "echo hi" }, output: "hi" },
      }),
      undefined,
    );
  }
});

test("index.client.tsx dsh-inline-tool runs Antigravity transformToolCall BEFORE dsh-tool fallback", () => {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(id, parent, isMain) {
    if (id === "react-native") {
      return {
        ScrollView: () => null,
        Text: () => null,
        View: () => null,
        Pressable: () => null,
        TextInput: () => null,
        ActivityIndicator: () => null,
        StyleSheet: { create: (styles) => styles },
        Platform: { OS: "ios", select: (obj) => obj.default ?? obj.ios },
        useWindowDimensions: () => ({ width: 1024, height: 768 }),
      };
    }
    if (id === "@getpaseo/plugin/client/ui") {
      return new Proxy({}, { get: () => () => null });
    }
    if (id === "@getpaseo/plugin/client") {
      return {
        defineTranslations: (spec) => ({
          ...spec,
          message: (key) => ({ key }),
        }),
        defineMessages: (spec) => ({
          ...spec,
          message: (key) => ({ key }),
        }),
        useTranslation: () => ({ t: (k) => k }),
        usePluginClient: () => ({}),
        usePluginRpc: () => ({ data: undefined }),
      };
    }
    if (id === "@tanstack/react-query") {
      return {
        useQuery: () => ({ data: undefined }),
        useMutation: () => ({ mutate: () => {} }),
        useQueryClient: () => ({ invalidateQueries: () => {} }),
      };
    }
    return originalLoad.call(this, id, parent, isMain);
  };

  let cleanup;
  try {
    const clientEntry = require("../index.client.tsx").default;
    const transformers = new Map();
    const renderers = new Set();
    const noop = () => {};
    const fakeClient = {
      addTimelineTransformer(spec) {
        transformers.set(spec.id, spec);
        return noop;
      },
      addTimelineRenderer(spec) {
        renderers.add(spec.kind);
        return noop;
      },
      addScreen: () => noop,
      addSettingsScreen: () => noop,
      addSidebarHeaderItem: () => noop,
      addSidebarFooterItem: () => noop,
      addWorkspaceRowBadgeItem: () => noop,
      addCommandCenterItem: () => noop,
      addComposerItem: () => noop,
      addComposerPill: () => ({ update: noop, remove: noop }),
      addSlashCommand: () => noop,
      addAgentPanel: () => noop,
      addAgentStatusPill: () => noop,
      rpc: () => Promise.resolve({ status: "ready", values: {} }),
      subscribe: () => ({ ready: Promise.resolve(), close: noop, unsubscribe: noop }),
      i18n: { locale: "en", t: (_m, key) => key },
      paseo: {
        agents: {
          list: () => Promise.resolve({ entries: [], subscription: { subscribe: () => noop, release: noop } }),
          subscribe: () => noop,
        },
        subscribe: () => noop,
      },
    };

    cleanup = clientEntry(fakeClient);

    const toolTx = transformers.get("dsh-inline-tool");
    assert.ok(toolTx, "dsh-inline-tool transformer registered");
    assert.ok(transformers.has("antigravity-ask-question-echo"), "echo suppression transformer registered");
    assert.ok(renderers.has("dsh-tool"));
    assert.ok(renderers.has(agContracts.SUBAGENT_TIMELINE_KIND));
    assert.ok(renderers.has(agContracts.SUBAGENT_LIST_TIMELINE_KIND));
    assert.ok(renderers.has(agContracts.ASK_QUESTION_TIMELINE_KIND));
    assert.ok(renderers.has(agContracts.FALLBACK_TIMELINE_KIND));

    // Antigravity tool call takes precedence over dsh-tool
    const agResult = toolTx.transform({
      phase: "complete",
      item: {
        type: "tool_call",
        callId: "ag-1",
        name: "ask_question",
        status: "running",
        detail: {
          type: "unknown",
          input: { questions: [{ question: "Proceed?", options: ["Yes", "No"] }] },
          output: null,
        },
      },
    });
    assert.equal(agResult.items[0].kind, agContracts.ASK_QUESTION_TIMELINE_KIND);

    // Normal DSH tool call still maps to dsh-tool
    const dshResult = toolTx.transform({
      phase: "complete",
      item: {
        type: "tool_call",
        callId: "dsh-1",
        name: "bash",
        status: "completed",
        detail: {
          type: "shell",
          command: "echo hello",
          output: "hello\n",
          exitCode: 0,
        },
      },
    });
    assert.equal(dshResult.items[0].kind, "dsh-tool");
    assert.equal(dshResult.items[0].data.name, "bash");
  } finally {
    cleanup?.();
    Module._load = originalLoad;
  }
});

// ============================================================================
// 5. Unified usage aggregation (`all` / `dsh` / `antigravity`) + dual-currency pricing & legacy migration
// ============================================================================

test("Antigravity pricing defaults, scheduled rates, dual-currency conversion, and one-time legacy override migration", async (t) => {
  assert.ok(ANTIGRAVITY_DEFAULT_PRICING.length >= 10);
  assert.ok(ANTIGRAVITY_REFERENCE_PRICING.length >= 10);

  // Gemini 4 Neon & Carbon (including scheduled rate change on 2026-12-01)
  const neon = matchAntigravityReferenceEntry("gemini-4-neon");
  assert.ok(neon);
  assert.equal(neon.rates.currency, "USD");
  assert.equal(neon.rates.input, 3.0);
  assert.equal(neon.rates.output, 15.0);

  const carbonNov = matchAntigravityReferenceEntry("gemini-4-carbon", Date.parse("2026-11-15T00:00:00Z"));
  const carbonDec = matchAntigravityReferenceEntry("gemini-4-carbon", Date.parse("2026-12-05T00:00:00Z"));
  assert.equal(carbonNov?.rates.input, 2.0);
  assert.equal(carbonNov?.rates.output, 10.0);
  assert.equal(carbonDec?.rates.input, 4.0);
  assert.equal(carbonDec?.rates.output, 20.0);

  // Dual-currency cost calculation (1M input + 1M output on Gemini 4 Neon = $18 USD = ¥126 CNY at rate 7.0)
  const usdCost = calculateCallCost(
    { model: "gemini-4-neon", provider: "antigravity", tokens: { input: 1_000_000, cached: 0, output: 1_000_000 } },
    { displayCurrency: "USD", usdToCnyRate: 7.0, overrides: {} },
  );
  const cnyCost = calculateCallCost(
    { model: "gemini-4-neon", provider: "antigravity", tokens: { input: 1_000_000, cached: 0, output: 1_000_000 } },
    { displayCurrency: "CNY", usdToCnyRate: 7.0, overrides: {} },
  );
  assert.equal(usdCost.priced, true);
  assert.equal(cnyCost.priced, true);
  assertApprox(usdCost.cost, 18.0, 1e-6, "USD cost");
  assertApprox(cnyCost.cost, 126.0, 1e-6, "CNY cost");

  // Legacy parser sanity
  const parsedLegacy = parseLegacyAntigravityPricing({
    version: 1,
    overrides: {
      "Gemini-4-Neon": { input: 5.0, cached: 0.25, output: 25.0 },
      "gemini-4-hydrogen": { input: 1.2, cached: 0.05, output: 6.0 },
    },
  });
  assert.ok(parsedLegacy);
  assert.equal(parsedLegacy.overrides["gemini-4-neon"]?.currency, "USD");
  assert.equal(parsedLegacy.overrides["gemini-4-neon"]?.input, 5.0);

  // PricingStore one-time legacy migration (preserves existing dsh-paseo override + does not re-import after deletion)
  const dir = makeTempDir(t, "paseo-pricing-mig-");
  const dshHomeDir = path.join(dir, "dsh-home");
  const legacyPricingPath = path.join(dir, "antigravity-accounts", "pricing.json");
  writeJson(legacyPricingPath, {
    version: 1,
    overrides: {
      "gemini-4-neon": { input: 5.0, cached: 0.25, output: 25.0 },
      "gemini-4-hydrogen": { input: 1.2, cached: 0.05, output: 6.0 },
    },
  });

  // Pre-seed dsh-paseo pricing with a newer override for gemini-4-neon
  const initialStore = new PricingStore({ dshHome: dshHomeDir });
  await initialStore.update({
    displayCurrency: "CNY",
    usdToCnyRate: 7.2,
    key: "gemini-4-neon",
    rates: { currency: "USD", input: 9.0, cached: 0.5, output: 40.0 },
  });

  // Load with legacyAntigravityPricingPath -> imports gemini-4-hydrogen, keeps gemini-4-neon at $9.0
  const migratedStore = new PricingStore({
    dshHome: dshHomeDir,
    legacyAntigravityPricingPath: legacyPricingPath,
  });
  const cfg = await migratedStore.load();
  assert.equal(cfg.legacyAntigravityImported, true);
  assert.equal(cfg.overrides["gemini-4-neon"]?.input, 9.0, "existing dsh-paseo override must not be overwritten");
  assert.equal(cfg.overrides["gemini-4-hydrogen"]?.input, 1.2, "missing legacy override must be imported");
  assert.equal(cfg.overrides["gemini-4-hydrogen"]?.currency, "USD");

  // Delete the imported override and reload in a fresh store instance -> must NOT re-import
  await migratedStore.update({ key: "gemini-4-hydrogen", rates: null });
  const reloadedStore = new PricingStore({
    dshHome: dshHomeDir,
    legacyAntigravityPricingPath: legacyPricingPath,
  });
  const reloadedCfg = await reloadedStore.load();
  assert.equal(reloadedCfg.legacyAntigravityImported, true);
  assert.equal(reloadedCfg.overrides["gemini-4-hydrogen"], undefined, "one-time migration must not re-import removed override");
});

test("UsageStatsEngine aggregates dsh, antigravity, and all sources with account filtering, dual-currency pricing, and daily heatmap", async (t) => {
  const dir = makeTempDir(t, "paseo-unified-usage-");
  const dshHomeDir = path.join(dir, "dsh-home");
  const sessionsDir = path.join(dshHomeDir, "sessions");
  const nowMs = Date.parse("2026-11-26T14:00:00.000Z");

  // Write 1 DSH session log with 1 call (deepseek-chat: 1M input + 1M output -> ¥2 + ¥3 = ¥5 CNY in reference pricing)
  const dshSessionPath = path.join(sessionsDir, "2026-11-26", "dsh-s1.jsonl");
  fs.mkdirSync(path.dirname(dshSessionPath), { recursive: true });
  const dshLines = [
    { type: "session", version: 4, id: "dsh-s1", createdAt: nowMs - 3_600_000, cwd: "/tmp/demo", isSeeded: false, delegationDepth: 0 },
    { type: "step/start", seq: 1, time: nowMs - 60_000, data: { turn: 1, step: 1 } },
    {
      type: "assistant/message",
      seq: 2,
      time: nowMs - 50_000,
      data: {
        turn: 1,
        step: 1,
        stream: [
          { type: "chunk", time: nowMs - 59_000, chunk: { type: "text-delta", text: "ok" } },
          {
            type: "chunk",
            time: nowMs - 50_000,
            chunk: { type: "finish", reason: "stop", replayState: { response: { provider: "deepseek", model: "deepseek-chat" } } },
          },
        ],
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
    },
  ];
  fs.writeFileSync(dshSessionPath, `${dshLines.map((l) => JSON.stringify(l)).join("\n")}\n`);

  // Synthetic Antigravity adapter with 2 accounts (Work + Personal, including 1 subagent call)
  const agRecords = [
    {
      at: nowMs - 30_000,
      conversationId: "conv-work-1",
      isSubagent: false,
      accountId: "a1111111",
      modelId: "gemini-4-neon",
      label: "Gemini 4 Neon",
      pricingKey: resolveAgPricingKey("gemini-4-neon", "Gemini 4 Neon"),
      input: 1_000_000,
      cached: 0,
      output: 1_000_000,
      firstToken: 1.5,
      generation: 10.0,
    },
    {
      at: nowMs - 20_000,
      conversationId: "conv-personal-1",
      isSubagent: true,
      accountId: "a2222222",
      modelId: "gemini-4-hydrogen",
      label: "Gemini 4 Hydrogen",
      pricingKey: resolveAgPricingKey("gemini-4-hydrogen", "Gemini 4 Hydrogen"),
      input: 500_000,
      cached: 0,
      output: 500_000,
      firstToken: 0.8,
      generation: 5.0,
    },
  ];
  const antigravityStats = {
    async allRecords() {
      return agRecords;
    },
    async seenPricingModels() {
      return new Map([
        ["gemini-4-neon", "Gemini 4 Neon"],
        ["gemini-4-hydrogen", "Gemini 4 Hydrogen"],
      ]);
    },
    accountLabels() {
      return { a1111111: "Work Account", a2222222: "Personal Account" };
    },
  };

  const pricingStore = new PricingStore({ dshHome: dshHomeDir });
  await pricingStore.update({ displayCurrency: "USD", usdToCnyRate: 7.0 });

  const engine = new UsageStatsEngine({
    dshHome: dshHomeDir,
    sessionsDir,
    pricer: pricingStore,
    antigravityStats,
    now: () => nowMs,
  });

  // DSH-only source
  const dshOnly = await engine.stats({ range: "7d", source: "dsh" });
  assert.equal(dshOnly.source, "dsh");
  assert.deepEqual(dshOnly.availableSources, ["dsh", "antigravity"]);
  assert.equal(dshOnly.totals.requests, 1);
  assert.equal(dshOnly.totals.input, 1_000_000);
  assert.equal(dshOnly.providers.length, 1);
  assert.equal(dshOnly.providers[0].provider, "deepseek");

  // Antigravity-only source (USD)
  const agOnly = await engine.stats({ range: "7d", source: "antigravity", currency: "USD" });
  assert.equal(agOnly.source, "antigravity");
  assert.equal(agOnly.totals.requests, 2);
  assert.equal(agOnly.totals.input, 1_500_000);
  assert.equal(agOnly.totals.output, 1_500_000);
  assert.equal(agOnly.accounts.length, 2);
  // Gemini 4 Neon ($3+$15 = $18) + 0.5M Gemini 4 Hydrogen ($0.75+$3.75 = $4.50) = $22.50 USD
  assertApprox(agOnly.totals.cost, 22.5, 1e-4, "Antigravity USD total cost");
  assert.equal(agOnly.totals.pricedRequests, 2);

  // Antigravity-only source filtered by account + CNY conversion
  const agWorkCny = await engine.stats({
    range: "7d",
    source: "antigravity",
    account: "a1111111",
    currency: "CNY",
  });
  assert.equal(agWorkCny.totals.requests, 1);
  assertApprox(agWorkCny.totals.cost, 18.0 * 7.0, 1e-4, "Work account CNY cost");

  // Unified "all" source aggregates DSH + Antigravity totals, models, and daily heatmap
  const combined = await engine.stats({ range: "7d", source: "all", currency: "USD" });
  assert.equal(combined.source, "all");
  assert.equal(combined.totals.requests, 3);
  assert.equal(combined.totals.input, 2_500_000);
  assert.equal(combined.totals.output, 2_500_000);
  assert.equal(combined.models.length, 3);
  assert.ok(combined.totals.cost > 22.5, "combined cost includes both Antigravity and DSH");

  const dailyAll = await engine.daily({ source: "all" });
  assert.equal(dailyAll.source, "all");
  assert.equal(dailyAll.days.reduce((sum, day) => sum + day.requests, 0), 3);
  assert.equal(dailyAll.days.reduce((sum, day) => sum + day.totalTokens, 0), 5_000_000);

  // seenPricingModels merges both DSH and Antigravity models
  const seen = await engine.seenPricingModels();
  assert.ok(seen.has("deepseek-chat"), "seenPricingModels includes DSH model");
  assert.ok(seen.has("gemini-4-neon"), "seenPricingModels includes Antigravity model");
  assert.ok(seen.has("gemini-4-hydrogen"), "seenPricingModels includes second Antigravity model");
});

// ============================================================================
// 6. Context pill excluded (no contextUsageRpc registered, no context pill code)
// ============================================================================

test("Antigravity context-window pill and contextUsageRpc are completely excluded", (t) => {
  // Contracts must not export contextUsageRpc / contextUsageSchema
  assert.equal("contextUsageRpc" in agContracts, false);
  assert.equal("contextUsageSchema" in agContracts, false);
  for (const [exportName, value] of Object.entries(agContracts)) {
    assert.doesNotMatch(exportName, /contextUsage/i, `unexpected contract export: ${exportName}`);
    if (value && typeof value === "object" && "name" in value && typeof value.name === "string") {
      assert.doesNotMatch(value.name, /context/i, `unexpected context RPC name: ${value.name}`);
    }
  }

  // ContextReader must only expose conversation-id resolution (no usage() method)
  assert.equal(typeof conversationIdFrom, "function");
  assert.equal(typeof ContextReader.prototype.conversationId, "function");
  assert.equal(typeof ContextReader.prototype.forget, "function");
  assert.equal("usage" in ContextReader.prototype, false, "ContextReader must not include context-window usage()");

  // Server registration must register zero context-usage RPCs
  const prevPaseoHome = process.env.PASEO_HOME;
  const tempPaseo = makeTempDir(t, "paseo-no-ctx-");
  process.env.PASEO_HOME = tempPaseo;
  t.after(() => {
    if (prevPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevPaseoHome;
  });

  const { server, rpcs } = createFakeServer();
  const handle = registerAntigravityServer(server, {
    registerOpenBefore: false,
    detectPresence: async () => ({
      agyInstalled: false,
      hasAntigravityData: false,
      hasAntigravityAccounts: false,
    }),
  });
  try {
    const contextRpcs = rpcs.filter((r) => /context/i.test(r.name));
    assert.deepEqual(contextRpcs, [], "no context-usage RPC may be registered");
  } finally {
    handle.dispose();
  }

  // Client antigravity directory must not contain removed files or context-pill identifiers
  const clientAgDir = path.resolve(__dirname, "..", "client", "antigravity");
  for (const omitted of ["context.tsx", "context.ts", "stats.tsx", "heatmap.tsx", "pricing.tsx"]) {
    assert.equal(fs.existsSync(path.join(clientAgDir, omitted)), false, `${omitted} must be omitted`);
  }
  const forbiddenPattern = /\b(contextUsageRpc|contextUsageSchema|contextPills|contextStore|ContextPopover|CONTEXT_POLL_MS)\b/;
  const walkFiles = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkFiles(abs));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(abs);
    }
    return out;
  };
  for (const file of walkFiles(clientAgDir)) {
    const content = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(content, forbiddenPattern, `forbidden context pill symbol in ${path.basename(file)}`);
  }
});

// ============================================================================
// 7. Hermes interop safety: no top-level `key` identifier in client/shared code
// ============================================================================

test("client and shared modules never declare a top-level `key` identifier (preserves Paseo Hermes eager interop)", () => {
  const pluginRoot = path.resolve(__dirname, "..");
  const collectTs = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectTs(abs));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(abs);
    }
    return out;
  };
  const files = [
    path.join(pluginRoot, "index.client.tsx"),
    ...collectTs(path.join(pluginRoot, "client")),
    ...collectTs(path.join(pluginRoot, "shared")),
  ];
  const topLevelKey = /^(?:export\s+)?(?:const|let|var|function|class)\s+key\b/m;
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      content,
      topLevelKey,
      `Top-level \`key\` in ${path.relative(pluginRoot, file)} causes esbuild to rename __copyProps's \`key\` to \`key2\`, breaking Paseo's Hermes eager interop rewrite`,
    );
  }
});
