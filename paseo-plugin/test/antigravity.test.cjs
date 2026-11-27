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
const { SubagentReader } = require("../server/antigravity/subagents.ts");
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
    assert.ok(renderers.has(agContracts.STEPS_TIMELINE_KIND));
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

    // Assistant bloom only intercepts streaming replies so completed turns keep Paseo's native Copy/Fork footer
    const bloomTx = transformers.get("dsh-assistant-bloom");
    assert.ok(bloomTx, "dsh-assistant-bloom transformer registered");
    const streamingBloom = bloomTx.transform({
      phase: "streaming",
      item: { type: "assistant_message", text: "Hello streaming" },
    });
    assert.equal(streamingBloom?.items[0]?.kind, "dsh-assistant-bloom");
    const completedBloom = bloomTx.transform({
      phase: "complete",
      item: { type: "assistant_message", text: "Hello completed" },
    });
    assert.equal(completedBloom, undefined);
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

// ============================================================================
// 8. Antigravity `/swarm` & subagent discovery, state transitions, board reports, counts, and timeline transforms
// ============================================================================

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function makeFakeContextReader(mapping) {
  return {
    async conversationOf(_paseo, agentId) {
      return mapping[agentId] ?? null;
    },
  };
}

test("SubagentReader discovers swarm workers + subagents from members.json, subagents/*.json, board.jsonl, and transcript.jsonl with accurate states and sorting", async (t) => {
  const cliDir = makeTempDir(t, "paseo-ag-swarm-");
  const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const workingId = "11111111-1111-4111-8111-111111111111";
  const waitingDoneId = "22222222-2222-4222-8222-222222222222";
  const waitingIdleId = "33333333-3333-4333-8333-333333333333";
  const killedAfterDoneId = "44444444-4444-4444-8444-444444444444";
  const killedMidWorkId = "55555555-5555-4555-8555-555555555555";
  const failedWorkerId = "66666666-6666-4666-8666-666666666666";
  const registrySubagentId = "77777777-7777-4777-8777-777777777777";
  const nestedChildId = "88888888-8888-4888-8888-888888888888";
  const foreignTranscriptChildId = "99999999-9999-4999-8999-999999999999";
  const transcriptOnlySwarmId = "abababab-abab-4aba-8aba-abababababab";

  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  const parentBrain = path.join(cliDir, "brain", parentId);

  // Parent transcript: swarm add (single + sharded) + swarm kill (prefix match) + foreign invoke_subagent
  writeJsonl(path.join(parentBrain, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-60_000),
      tool_calls: [
        {
          name: "swarm",
          args: { action: '"add"', name: '"backend"', brief: '"Implement backend API"' },
        },
        {
          name: "swarm",
          args: { action: '"add"', name: '"shard"', brief: '"Shard work"' },
        },
        {
          name: "invoke_subagent",
          args: { Role: '"foreign"', TypeName: '"explorer"', Prompt: '"Should be rejected"' },
        },
      ],
    },
    {
      step_index: 1,
      type: "GENERIC",
      status: "DONE",
      created_at: iso(-59_000),
      content: JSON.stringify({
        status: "added",
        name: "backend",
        model: "gemini-4-neon-high",
        conversation_id: workingId,
      }),
    },
    {
      step_index: 2,
      type: "GENERIC",
      status: "DONE",
      created_at: iso(-58_000),
      content: JSON.stringify({
        status: "added",
        workers: [
          { name: "shard-1", conversation_id: killedMidWorkId, model: "gemini-4-neon-high" },
          { name: "shard-2", conversation_id: transcriptOnlySwarmId, model: "gemini-4-neon-high" },
        ],
      }),
    },
    {
      step_index: 3,
      type: "GENERIC",
      status: "DONE",
      created_at: iso(-57_000),
      content: `Created the following subagent: {"conversationId":"${foreignTranscriptChildId}"}`,
    },
    {
      step_index: 4,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-10_000),
      tool_calls: [
        { name: "swarm", args: { action: '"kill"', name: '"shard"' } },
      ],
    },
    {
      step_index: 5,
      type: "GENERIC",
      status: "DONE",
      created_at: iso(-9_500),
      content: '{"status":"killed","name":"shard"}',
    },
  ]);

  // Parent `.system_generated/swarm/members.json`
  writeJson(path.join(parentBrain, ".system_generated", "swarm", "members.json"), {
    title: "Refactor Subagents & Swarm",
    members: {
      coordinator: {
        conversation_id: parentId,
        role: "coordinator",
        wake_mode: "mentions",
        killed: false,
        model: "gemini-4-neon-high",
      },
      backend: {
        conversation_id: workingId,
        role: "worker",
        wake_mode: "working",
        killed: false,
        applied_model: "gemini-4-neon-high",
      },
      "ui-done": {
        conversation_id: waitingDoneId,
        role: "worker",
        wake_mode: "waiting",
        killed: false,
        model: "gemini-4-carbon-high",
      },
      verifier: {
        conversation_id: waitingIdleId,
        role: "worker",
        wake_mode: "mentions",
        killed: false,
        model: "gemini-4-neon-high",
      },
      "killed-done": {
        conversation_id: killedAfterDoneId,
        role: "worker",
        wake_mode: "waiting",
        killed: true,
        phase: "KILLED",
        model: "gemini-4-neon-high",
      },
      "shard-1": {
        conversation_id: killedMidWorkId,
        role: "worker",
        wake_mode: "working",
        killed: true,
        desired_state: "KILLED",
        model: "gemini-4-neon-high",
      },
      broken: {
        conversation_id: failedWorkerId,
        role: "worker",
        wake_mode: "working",
        killed: false,
        model: "gemini-4-neon-high",
      },
    },
  });

  // Parent `.system_generated/subagents/*.json` (includes a regular subagent + a swarm worker)
  writeJson(path.join(parentBrain, ".system_generated", "subagents", `${registrySubagentId}.json`), {
    conversationId: registrySubagentId,
    subagentDescriptor: { typeName: "explorer", role: "Repo Auditor" },
    state: "SUBAGENT_STATE_ALIVE",
  });
  writeJson(path.join(parentBrain, ".system_generated", "subagents", `${workingId}.json`), {
    conversationId: workingId,
    subagentDescriptor: { typeName: "worker", role: "Swarm Worker (backend)" },
    state: "SUBAGENT_STATE_ALIVE",
  });

  // Parent `.system_generated/swarm/board.jsonl`
  writeJsonl(path.join(parentBrain, ".system_generated", "swarm", "board.jsonl"), [
    { seq: 1, agent: "coordinator", text: "@backend Own server + contracts", timestamp: iso(-55_000) },
    { seq: 2, agent: "coordinator", text: "@ui-done Build popover UI", timestamp: iso(-54_000) },
    { seq: 3, agent: "coordinator", text: "@killed-done Ship quick fix", timestamp: iso(-53_000) },
    { seq: 4, agent: "ui-done", text: "Interim update on popover", timestamp: iso(-40_000) },
    { seq: 5, agent: "ui-done", text: "@coordinator [done] Popover ready and tested", timestamp: iso(-20_000) },
    { seq: 6, agent: "killed-done", text: "@coordinator [done] Quick fix landed", timestamp: iso(-25_000) },
  ]);

  // 1. workingId: step 0 sender=system, step 1 sender=parentId, actively calling read_file
  writeJsonl(path.join(cliDir, "brain", workingId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-55_000),
      content: "<SYSTEM_MESSAGE>[Message] sender=system content=[swarm] new board message #1</SYSTEM_MESSAGE>",
    },
    {
      step_index: 1,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-54_900),
      content: `<SYSTEM_MESSAGE>[Message] sender=${parentId} content=Own server + contracts</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 2,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-5_000),
      model: "gemini-4-neon-high",
      input_tokens: 1200,
      output_tokens: 300,
      tool_calls: [{ name: "read_file", args: { Path: '"/repo/subagents.ts"' } }],
    },
    {
      step_index: 3,
      type: "GENERIC",
      status: "RUNNING",
      created_at: iso(-4_000),
      content: "reading...",
    },
  ]);

  // Nested subagent spawned by workingId
  writeJson(path.join(cliDir, "brain", workingId, ".system_generated", "subagents", `${nestedChildId}.json`), {
    conversationId: nestedChildId,
    subagentDescriptor: { typeName: "helper", role: "Schema Check" },
    state: "SUBAGENT_STATE_ALIVE",
  });
  writeJsonl(path.join(cliDir, "brain", nestedChildId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-4_500),
      content: `<SYSTEM_MESSAGE>[Message] sender=${workingId} content=Verify schema</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-3_000),
      content: "Looks good",
    },
  ]);

  // 2. waitingDoneId: parked on swarm_wait after posting @coordinator [done]
  writeJsonl(path.join(cliDir, "brain", waitingDoneId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-54_000),
      content: "<SYSTEM_MESSAGE>[Message] sender=system content=[swarm] new board message #2</SYSTEM_MESSAGE>",
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-21_000),
      tool_calls: [
        { name: "post_message", args: { text: '"@coordinator [done] Popover ready and tested"' } },
        { name: "swarm_wait", args: { since: "5" } },
      ],
    },
    { step_index: 2, type: "GENERIC", status: "DONE", created_at: iso(-20_500), content: '{"seq":5}' },
    { step_index: 3, type: "GENERIC", status: "DONE", created_at: iso(-20_000), content: "waiting" },
  ]);

  // 3. waitingIdleId: parked on swarm_wait without any board report yet -> idle
  writeJsonl(path.join(cliDir, "brain", waitingIdleId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-50_000),
      content: "<SYSTEM_MESSAGE>[Message] sender=system content=[swarm] new board message #4</SYSTEM_MESSAGE>",
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-49_000),
      tool_calls: [{ name: "swarm_wait", args: { since: "4" } }],
    },
    { step_index: 2, type: "GENERIC", status: "DONE", created_at: iso(-48_000), content: "waiting" },
  ]);

  // 4. killedAfterDoneId: reached finalAnswer + board report, then killed -> stays "done"
  writeJsonl(path.join(cliDir, "brain", killedAfterDoneId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-53_000),
      content: `<SYSTEM_MESSAGE>[Message] sender=${parentId} content=Ship quick fix</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-24_000),
      content: "All done.",
    },
  ]);

  // 5. killedMidWorkId: killed while mid-tool without report -> "stopped"
  writeJsonl(path.join(cliDir, "brain", killedMidWorkId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-52_000),
      content: `<SYSTEM_MESSAGE>[Message] sender=${parentId} content=Shard work 1</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-30_000),
      tool_calls: [{ name: "run_command", args: { CommandLine: '"npm test"' } }],
    },
  ]);

  // 6. transcriptOnlySwarmId (shard-2): NOT in members.json, only in transcript.jsonl;
  //    step 0 is sender=system, step 1 is sender=parentId -> accepted by sentBy() AND killed by `swarm kill shard`!
  writeJsonl(path.join(cliDir, "brain", transcriptOnlySwarmId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-51_000),
      content: "<SYSTEM_MESSAGE>[Message] sender=system content=[swarm] new board message #1</SYSTEM_MESSAGE>",
    },
    {
      step_index: 1,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-50_900),
      content: `<SYSTEM_MESSAGE>[Message] sender=${parentId} content=Shard work 2</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 2,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-35_000),
      tool_calls: [{ name: "read_file", args: { Path: '"/repo/a.ts"' } }],
    },
  ]);

  // 7. failedWorkerId: model step ERROR -> "failed"
  writeJsonl(path.join(cliDir, "brain", failedWorkerId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-45_000),
      content: `<SYSTEM_MESSAGE>[Message] sender=${parentId} content=Run failing step</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "ERROR",
      created_at: iso(-15_000),
      content: "Quota exhausted",
    },
  ]);

  // 8. registrySubagentId: regular subagent from subagents/*.json with inbox report -> "done"
  writeJsonl(path.join(cliDir, "brain", registrySubagentId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-40_000),
      content: "<SYSTEM_MESSAGE>[Message] sender=other-wrapper content=Audit repository</SYSTEM_MESSAGE>",
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-12_000),
      content: "Audit complete.",
    },
  ]);
  writeJson(path.join(parentBrain, ".system_generated", "messages", "msg-1.json"), {
    sender: registrySubagentId,
    timestamp: iso(-11_500),
    content: "Repository audit passed.",
  });

  // 9. foreignTranscriptChildId: NOT in members.json or subagents/*.json, and sentBy is another conversation -> rejected
  writeJsonl(path.join(cliDir, "brain", foreignTranscriptChildId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-50_000),
      content: "<SYSTEM_MESSAGE>[Message] sender=ffffffff-ffff-4fff-8fff-ffffffffffff content=Foreign</SYSTEM_MESSAGE>",
    },
  ]);

  const reader = new SubagentReader(
    makeFakeContextReader({
      "agent-1": { conversationId: parentId, closed: false, model: "gemini-4-neon-high" },
    }),
    cliDir,
  );

  const list = await reader.list({}, "agent-1");
  // Validate against shared Zod contract
  agContracts.subagentListSchema.parse(list);
  assert.equal(list.conversationId, parentId);
  assert.equal(list.swarmTitle, "Refactor Subagents & Swarm");

  const byId = new Map(list.subagents.map((s) => [s.id, s]));
  assert.equal(byId.has(foreignTranscriptChildId), false, "untrusted foreign child must be filtered out");
  assert.equal(byId.has(parentId), false, "coordinator must not appear as its own child");

  // Verify states, origins, roles, tasks, and reports
  const backend = byId.get(workingId);
  assert.ok(backend);
  assert.equal(backend.origin, "swarm");
  assert.equal(backend.role, "backend");
  assert.equal(backend.state, "running");
  assert.equal(backend.phase, "tool");
  assert.equal(backend.task, "Own server + contracts");

  const uiDone = byId.get(waitingDoneId);
  assert.ok(uiDone);
  assert.equal(uiDone.origin, "swarm");
  assert.equal(uiDone.state, "done");
  assert.equal(uiDone.task, "Build popover UI");
  assert.ok(uiDone.reportedAt, "board report timestamp should populate reportedAt");

  const verifier = byId.get(waitingIdleId);
  assert.ok(verifier);
  assert.equal(verifier.origin, "swarm");
  assert.equal(verifier.state, "idle");

  const killedDone = byId.get(killedAfterDoneId);
  assert.ok(killedDone);
  assert.equal(killedDone.origin, "swarm");
  assert.equal(killedDone.state, "done", "worker killed after finalAnswer + report must remain done");

  const killedMid = byId.get(killedMidWorkId);
  assert.ok(killedMid);
  assert.equal(killedMid.origin, "swarm");
  assert.equal(killedMid.state, "stopped", "worker killed mid-work must be stopped");

  const shard2 = byId.get(transcriptOnlySwarmId);
  assert.ok(shard2, "transcript-only swarm worker with step-0 sender=system + step-1 sender=parentId must pass sentBy");
  assert.equal(shard2.origin, "swarm");
  assert.equal(shard2.role, "shard-2");
  assert.equal(shard2.state, "stopped", "sharded worker targeted by `swarm kill shard` must be stopped");

  const broken = byId.get(failedWorkerId);
  assert.ok(broken);
  assert.equal(broken.state, "failed");

  const auditor = byId.get(registrySubagentId);
  assert.ok(auditor);
  assert.equal(auditor.origin, "subagent");
  assert.equal(auditor.role, "Repo Auditor");
  assert.equal(auditor.state, "done");

  // Sorting: running worker first, its nested child immediately after it, then non-running reverse-chronological
  assert.equal(list.subagents[0].id, workingId);
  assert.equal(list.subagents[1].id, nestedChildId);
  assert.equal(list.subagents[1].depth, 2);
  const topLevelNonRunning = list.subagents.filter((s) => s.depth === 1 && s.state !== "running");
  for (let i = 1; i < topLevelNonRunning.length; i += 1) {
    const prevTs = Date.parse(topLevelNonRunning[i - 1].updatedAt ?? topLevelNonRunning[i - 1].startedAt);
    const currTs = Date.parse(topLevelNonRunning[i].updatedAt ?? topLevelNonRunning[i].startedAt);
    assert.ok(prevTs >= currTs, "non-running top-level subagents must be sorted reverse-chronologically");
  }

  // Detail includes board report for swarm worker (preferring @coordinator / [done] post over interim post)
  const uiDetail = await reader.detail({}, "agent-1", waitingDoneId);
  agContracts.subagentDetailSchema.parse(uiDetail);
  assert.equal(uiDetail.report, "@coordinator [done] Popover ready and tested");

  // Counts include total, running, failed, settledIds, and failedIds
  const counts = await reader.counts({}, ["agent-1"]);
  agContracts.subagentCountsRpc.output.parse({ counts });
  assert.equal(counts["agent-1"].total, 9);
  assert.equal(counts["agent-1"].running, 1);
  assert.equal(counts["agent-1"].failed, 1);
  assert.equal(counts["agent-1"].settledIds.length, 8);
  assert.deepEqual(counts["agent-1"].failedIds, ["66666666-6666-4666-8666-666666666666"]);

  // Backward-compatibility check: counts schema defaults missing `failed` to 0
  const parsedLegacyCounts = agContracts.subagentCountsRpc.output.parse({
    counts: { legacy: { total: 2, running: 1 } },
  });
  assert.deepEqual(parsedLegacyCounts.counts.legacy, { total: 2, running: 1, failed: 0 });

  // forget() clears caches cleanly
  reader.forget("agent-1");
});

test("SubagentReader extracts clean roster name from `Swarm Worker (<name>)` in subagents/*.json and marks SUBAGENT_STATE_KILLED", async (t) => {
  const cliDir = makeTempDir(t, "paseo-ag-reg-");
  const parentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const workerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const parentBrain = path.join(cliDir, "brain", parentId);

  writeJson(path.join(parentBrain, ".system_generated", "subagents", `${workerId}.json`), {
    conversationId: workerId,
    subagentDescriptor: { typeName: "worker", role: "Swarm Worker (i18n-sync)" },
    state: "SUBAGENT_STATE_KILLED",
  });
  writeJsonl(path.join(cliDir, "brain", workerId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: new Date().toISOString(),
      content: "<SYSTEM_MESSAGE>[Message] sender=system content=[swarm] new board message #2</SYSTEM_MESSAGE>",
    },
    {
      step_index: 1,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: new Date().toISOString(),
      content: `<SYSTEM_MESSAGE>[Message] sender=${parentId} content=Sync all Antigravity i18n strings</SYSTEM_MESSAGE>`,
    },
  ]);

  const reader = new SubagentReader(
    makeFakeContextReader({
      "agent-reg": { conversationId: parentId, closed: false, model: null },
    }),
    cliDir,
  );
  const list = await reader.list({}, "agent-reg");
  assert.equal(list.subagents.length, 1);
  assert.equal(list.subagents[0].origin, "swarm");
  assert.equal(list.subagents[0].role, "i18n-sync");
  assert.equal(list.subagents[0].state, "stopped");
  assert.equal(list.subagents[0].task, "Sync all Antigravity i18n strings");
});

test("transformToolCall transforms swarm add, kill, status, title, and model while letting models fall through", () => {
  const transforms = createAntigravityTimelineTransforms();
  const w1 = "11111111-1111-4111-8111-111111111111";
  const w2 = "22222222-2222-4222-8222-222222222222";

  // 1. swarm add (single completed)
  const addSingle = transforms.transformToolCall({
    type: "tool_call",
    callId: "sw-1",
    name: "swarm",
    status: "completed",
    detail: {
      type: "unknown",
      input: { action: "add", name: "swarm-backend", brief: "Upgrade subagent reader" },
      output: JSON.stringify({
        status: "added",
        name: "swarm-backend",
        conversation_id: w1,
      }),
    },
  });
  assert.equal(addSingle?.items.length, 1);
  assert.equal(addSingle.items[0].kind, agContracts.SUBAGENT_TIMELINE_KIND);
  agContracts.subagentCardSchema.parse(addSingle.items[0].data);
  assert.deepEqual(addSingle.items[0].data, {
    id: w1,
    role: "swarm-backend",
    type: "swarm",
    origin: "swarm",
    task: "Upgrade subagent reader",
    status: "completed",
  });

  // 2. swarm add (still running, no output yet -> single placeholder card)
  const addRunning = transforms.transformToolCall({
    type: "tool_call",
    callId: "sw-2",
    name: "swarm",
    status: "running",
    detail: {
      type: "unknown",
      input: { action: "add", name: "verifier", brief: "Run verification suite" },
      output: null,
    },
  });
  assert.equal(addRunning?.items.length, 1);
  assert.equal(addRunning.items[0].data.id, "");
  assert.equal(addRunning.items[0].data.role, "verifier");
  assert.equal(addRunning.items[0].data.origin, "swarm");

  // 3. swarm add (sharded multi-worker output)
  const addSharded = transforms.transformToolCall({
    type: "tool_call",
    callId: "sw-3",
    name: "swarm",
    status: "completed",
    detail: {
      type: "unknown",
      input: { action: "add", name: "audit", brief: "Audit module", tasks: ["auth", "billing"] },
      output: JSON.stringify({
        workers: [
          { name: "audit-1", conversation_id: w1 },
          { name: "audit-2", conversation_id: w2 },
        ],
      }),
    },
  });
  assert.equal(addSharded?.items.length, 2);
  assert.equal(addSharded.items[0].data.id, w1);
  assert.equal(addSharded.items[0].data.role, "audit-1");
  assert.equal(addSharded.items[0].data.origin, "swarm");
  assert.equal(addSharded.items[0].data.task, "Audit module — auth");
  assert.equal(addSharded.items[1].data.id, w2);
  assert.equal(addSharded.items[1].data.role, "audit-2");
  assert.equal(addSharded.items[1].data.task, "Audit module — billing");

  // 4. swarm status (excludes coordinator, normalizes working->running, waiting->idle, killed->stopped)
  const statusRes = transforms.transformToolCall({
    type: "tool_call",
    callId: "sw-4",
    name: "swarm",
    status: "completed",
    detail: {
      type: "unknown",
      input: { action: "status" },
      output: JSON.stringify({
        title: "Release Prep",
        members: [
          { name: "coordinator", role: "coordinator", state: "waiting", conversation_id: "00000000-0000-4000-8000-000000000000" },
          { name: "backend", conversation_id: w1, state: "working" },
          { name: "verifier", conversation_id: w2, state: "waiting" },
          { name: "old-worker", state: "killed" },
        ],
      }),
    },
  });
  assert.equal(statusRes?.items.length, 1);
  assert.equal(statusRes.items[0].kind, agContracts.SUBAGENT_LIST_TIMELINE_KIND);
  agContracts.subagentCheckSchema.parse(statusRes.items[0].data);
  assert.equal(statusRes.items[0].data.action, "swarm:status");
  assert.equal(statusRes.items[0].data.title, "Release Prep");
  assert.deepEqual(statusRes.items[0].data.states, [
    { id: w1, role: "backend", state: "running" },
    { id: w2, role: "verifier", state: "idle" },
    { id: "old-worker", role: "old-worker", state: "stopped" },
  ]);

  // 5. swarm kill
  const killRes = transforms.transformToolCall({
    type: "tool_call",
    callId: "sw-5",
    name: "swarm",
    status: "completed",
    detail: {
      type: "unknown",
      input: { action: "kill", name: "backend" },
      output: JSON.stringify({ status: "killed", name: "backend" }),
    },
  });
  assert.equal(killRes?.items[0].kind, agContracts.SUBAGENT_LIST_TIMELINE_KIND);
  assert.equal(killRes.items[0].data.action, "swarm:kill");
  assert.deepEqual(killRes.items[0].data.states, [{ id: "backend", role: "backend", state: "stopped" }]);

  // 6. swarm title
  const titleRes = transforms.transformToolCall({
    type: "tool_call",
    callId: "sw-6",
    name: "swarm",
    status: "completed",
    detail: {
      type: "unknown",
      input: { action: "title", title: "Align Antigravity subagents" },
      output: JSON.stringify({ status: "titled", title: "Align Antigravity subagents" }),
    },
  });
  assert.equal(titleRes?.items[0].kind, agContracts.SUBAGENT_LIST_TIMELINE_KIND);
  assert.equal(titleRes.items[0].data.action, "swarm:title");
  assert.equal(titleRes.items[0].data.title, "Align Antigravity subagents");

  // 7. swarm model
  const modelRes = transforms.transformToolCall({
    type: "tool_call",
    callId: "sw-7",
    name: "swarm",
    status: "completed",
    detail: {
      type: "unknown",
      input: { action: "model", name: "backend", model: "gemini-4-carbon-high" },
      output: JSON.stringify({ status: "switched", name: "backend", model: "gemini-4-carbon-high" }),
    },
  });
  assert.equal(modelRes?.items[0].kind, agContracts.SUBAGENT_LIST_TIMELINE_KIND);
  assert.equal(modelRes.items[0].data.action, "swarm:model");
  assert.equal(modelRes.items[0].data.title, "backend · gemini-4-carbon-high");

  // 8. swarm models falls through cleanly
  const modelsRes = transforms.transformToolCall({
    type: "tool_call",
    callId: "sw-8",
    name: "swarm",
    status: "completed",
    detail: {
      type: "unknown",
      input: { action: "models" },
      output: '{"models":[]}',
    },
  });
  assert.equal(modelsRes, undefined);
});

// ============================================================================
// 9. Antigravity i18n sync, subagent pill stability, and live locale teardown
// ============================================================================

function loadClientModulesWithMocks(loader) {
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
        useRpc: () => async () => ({}),
        useAgent: () => ({ agent: null }),
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
  try {
    return loader();
  } finally {
    Module._load = originalLoad;
  }
}

test("translateAntigravity syncs with setLanguageOverride, pluralizes _zero/_one/_other, interpolates {{name}}, falls back to en, and zh-CN avoids 子代理", (t) => {
  const { localeMod, messagesMod } = loadClientModulesWithMocks(() => ({
    localeMod: require("../client/locale.ts"),
    messagesMod: require("../client/antigravity/messages.ts"),
  }));
  const { setLanguageOverride } = localeMod;
  const { translateAntigravity } = messagesMod;

  t.after(() => setLanguageOverride("auto"));

  // zh-CN override
  setLanguageOverride("zh-CN");
  assert.equal(translateAntigravity("subagents.pill"), "智能体");
  assert.equal(translateAntigravity("subagents.type.research"), "只读调研");
  assert.equal(translateAntigravity("subagents.type.self"), "通用");
  assert.equal(translateAntigravity("subagents.type.image-generator"), "图像生成");
  assert.equal(translateAntigravity("agents", { count: 0 }), "没有智能体");
  assert.equal(translateAntigravity("agents", { count: 1 }), "1 个智能体");
  assert.equal(translateAntigravity("agents", { count: 3 }), "3 个智能体");
  assert.equal(translateAntigravity("subagents.workspaceBadgeA11y", { count: 1 }), "子智能体：1 个运行中");
  assert.equal(translateAntigravity("subagents.workspaceBadgeA11y", { count: 4 }), "子智能体：4 个运行中");
  assert.equal(translateAntigravity("subagents.check.swarmKill", { count: 1 }), "停止了 1 个蜂群成员");
  assert.equal(translateAntigravity("subagents.check.swarmKill", { count: 2 }), "停止了 2 个蜂群成员");
  assert.equal(translateAntigravity("subagents.steps", { count: 1 }), "1 步");
  assert.equal(translateAntigravity("subagents.steps", { count: 5 }), "5 步");
  assert.equal(translateAntigravity("switched", { label: "工作" }), "已切换到「工作」");
  assert.equal(translateAntigravity("switchingNow", { label: "工作" }), "已切换账号为「工作」，正在重载对话…");

  // en override
  setLanguageOverride("en");
  assert.equal(translateAntigravity("subagents.pill"), "Subagents");
  assert.equal(translateAntigravity("agents", { count: 0 }), "No agents");
  assert.equal(translateAntigravity("agents", { count: 1 }), "1 agent");
  assert.equal(translateAntigravity("agents", { count: 3 }), "3 agents");
  assert.equal(translateAntigravity("subagents.workspaceBadgeA11y", { count: 1 }), "Subagents: 1 running");
  assert.equal(translateAntigravity("subagents.workspaceBadgeA11y", { count: 4 }), "Subagents: 4 running");
  assert.equal(translateAntigravity("subagents.check.swarmKill", { count: 1 }), "Stopped 1 swarm worker");
  assert.equal(translateAntigravity("subagents.check.swarmKill", { count: 2 }), "Stopped 2 swarm workers");
  assert.equal(translateAntigravity("subagents.steps", { count: 1 }), "1 step");
  assert.equal(translateAntigravity("subagents.steps", { count: 5 }), "5 steps");
  assert.equal(translateAntigravity("switched", { label: "Work" }), "Switched to “Work”");
  assert.equal(translateAntigravity("switchingNow", { label: "Work" }), "Switched to “Work”, reloading conversation…");

  // Explicit localeOverride parameter + missing param placeholder preservation + missing key fallback
  assert.equal(translateAntigravity("subagents.pill", undefined, "zh-CN"), "智能体");
  assert.equal(translateAntigravity("subagents.nested", {}), "Started by {{role}}");
  assert.equal(translateAntigravity("nonexistent.nested.key"), "nonexistent.nested.key");

  // zh-CN locale file must have zero occurrences of legacy "子代理"
  const zhFile = path.resolve(__dirname, "..", "client", "antigravity", "locales", "zh-CN.ts");
  const zhContent = fs.readFileSync(zhFile, "utf8");
  assert.equal(zhContent.includes("子代理"), false, "locales/zh-CN.ts must use 子智能体 instead of 子代理");

  // Placeholder parity: Paseo's real defineTranslations throws at load time if any
  // zh-CN key's {{placeholder}} set differs from en.
  const enTree = require("../client/antigravity/locales/en.ts").default;
  const zhTree = require("../client/antigravity/locales/zh-CN.ts").default;
  const flatten = (obj, prefix = "", out = {}) => {
    for (const [k, v] of Object.entries(obj)) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") flatten(v, full, out);
      else if (typeof v === "string") out[full] = v;
    }
    return out;
  };
  const placeholdersOf = (str) =>
    [...new Set([...str.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map((m) => m[1]))].sort();
  const enFlat = flatten(enTree);
  const zhFlat = flatten(zhTree);
  for (const [k, zhVal] of Object.entries(zhFlat)) {
    assert.ok(k in enFlat, `zh-CN key missing in en: ${k}`);
    assert.deepEqual(
      placeholdersOf(zhVal),
      placeholdersOf(enFlat[k]),
      `Translation placeholders differ in zh-CN: ${k}`,
    );
  }
});

test("contributeAntigravityClient & observeAgents keep stable CornerRingIcon identities, skip redundant pill.update, refresh live titles on locale switch, and leak zero listeners on dispose", async (t) => {
  const { localeMod, agClientMod } = loadClientModulesWithMocks(() => ({
    localeMod: require("../client/locale.ts"),
    agClientMod: require("../client/antigravity/index.ts"),
  }));
  const { setLanguageOverride } = localeMod;
  const { contributeAntigravityClient } = agClientMod;

  t.after(() => setLanguageOverride("auto"));
  setLanguageOverride("zh-CN");

  let currentCounts = { total: 3, running: 2, failed: 0 };
  const agentRow = {
    id: "ag-1",
    workspaceId: "ws-1",
    provider: "antigravity",
    model: "gemini-4-neon-high",
    title: "Main",
    status: "running",
    metadata: {},
  };

  const pills = [];
  const panels = [];
  const badges = [];
  const commands = [];
  const footers = [];
  const slashes = [];
  const noop = () => {};

  function trackRegistration(list, spec) {
    const record = { spec, removed: false };
    list.push(record);
    return () => {
      record.removed = true;
    };
  }

  const fakeClient = {
    addSidebarFooterItem: (spec) => trackRegistration(footers, spec),
    addWorkspaceRowBadgeItem: (spec) => trackRegistration(badges, spec),
    addCommandCenterItem: (spec) => trackRegistration(commands, spec),
    addScreen: (spec) => trackRegistration(panels, spec),
    addAgentPanel: (spec) => trackRegistration(panels, spec),
    addSlashCommand: (spec) => trackRegistration(slashes, spec),
    addComposerItem: () => noop,
    addTimelineRenderer: () => noop,
    addTimelineTransformer: () => noop,
    openScreen: noop,
    openAgentPanel: noop,
    addComposerPill(spec) {
      const entry = {
        spec,
        current: { ...spec.button },
        updates: [],
        removed: false,
      };
      pills.push(entry);
      return {
        update(patch) {
          entry.updates.push(patch);
          entry.current = { ...entry.current, ...patch };
        },
        remove() {
          entry.removed = true;
        },
      };
    },
    async rpc(def) {
      if (def.name === "subagents.counts") {
        return { counts: { "ag-1": { ...currentCounts } } };
      }
      if (def.name === "accounts.list") {
        return {
          accounts: [],
          defaultAccountId: "default",
          agyPath: null,
          agyVersion: null,
          problems: [],
          fallback: { enabled: false, retries: 0, strategy: "order" },
          revision: 1,
        };
      }
      if (def.name === "orchestrator.get") {
        return { planner: null, executor: null, overrides: {}, planners: [], executors: [], error: null };
      }
      return {};
    },
    subscribe: () => ({ ready: Promise.resolve(), close: noop, unsubscribe: noop }),
    paseo: {
      agents: {
        async list() {
          return {
            entries: [{ agent: agentRow }],
            subscription: {
              subscribe(handlers) {
                handlers.snapshot({ entries: [{ agent: agentRow }] });
                return noop;
              },
              release: noop,
            },
          };
        },
      },
    },
  };

  const handle = contributeAntigravityClient(fakeClient, { consoleScreenId: "dsh-console" });
  try {
    // Allow initial async agents.list() snapshot to deliver the agent
    await Promise.resolve();
    await Promise.resolve();

    // Poll 1: running state
    await handle.observation.refreshSubagents();
    const subagentPill = pills.find((p) => p.spec.id === "subagents");
    assert.ok(subagentPill, "subagents composer pill should be registered");
    assert.equal(subagentPill.current.label, "智能体");
    assert.equal(subagentPill.current.title, "智能体");
    assert.equal(subagentPill.spec.button.behavior.kind, "popover");
    assert.equal(typeof subagentPill.spec.button.behavior.Content, "function");
    const runningIcon = subagentPill.current.icon;
    assert.equal(typeof runningIcon, "function");
    assert.equal(subagentPill.updates.length, 0);

    // Poll 2: unchanged visual state (still running, count changes from 2 to 1) -> zero pill.update calls
    currentCounts = { total: 4, running: 1, failed: 0 };
    await handle.observation.refreshSubagents();
    assert.equal(subagentPill.updates.length, 0, "pill.update must not be called when iconState/label/title are unchanged");

    // Poll 3: failed state -> updates once with distinct failed icon
    currentCounts = { total: 4, running: 0, failed: 1 };
    await handle.observation.refreshSubagents();
    assert.equal(subagentPill.updates.length, 1);
    const failedIcon = subagentPill.current.icon;
    assert.equal(typeof failedIcon, "function");
    assert.notEqual(failedIcon, runningIcon);

    // Poll 4: unchanged failed visual state -> zero extra pill.update calls
    currentCounts = { total: 4, running: 0, failed: 2 };
    await handle.observation.refreshSubagents();
    assert.equal(subagentPill.updates.length, 1);

    // Poll 5: idle state -> updates once with distinct idle icon
    currentCounts = { total: 4, running: 0, failed: 0 };
    await handle.observation.refreshSubagents();
    assert.equal(subagentPill.updates.length, 2);
    const idleIcon = subagentPill.current.icon;
    assert.equal(typeof idleIcon, "function");
    assert.notEqual(idleIcon, runningIcon);
    assert.notEqual(idleIcon, failedIcon);

    // Poll 6: back to running -> reuses exact same stable runningIcon identity
    currentCounts = { total: 4, running: 1, failed: 0 };
    await handle.observation.refreshSubagents();
    assert.equal(subagentPill.updates.length, 3);
    assert.equal(subagentPill.current.icon, runningIcon, "CornerRingIcon component identity must stay stable");

    // Initial zh-CN live titles
    assert.equal(panels.at(-1).spec.title, "子智能体");
    assert.equal(badges.at(-1).spec.title, "子智能体");
    assert.equal(commands.at(-1).spec.title, "刷新所有 Antigravity 额度");

    // Switch locale to en -> pill and live titles update cleanly, removing old registrations
    setLanguageOverride("en");
    assert.equal(subagentPill.updates.length, 4);
    assert.equal(subagentPill.current.label, "Subagents");
    assert.equal(subagentPill.current.title, "Subagents");
    assert.equal(subagentPill.current.icon, runningIcon);

    assert.equal(panels.length, 2);
    assert.equal(panels[0].removed, true);
    assert.equal(panels[1].spec.title, "Subagents");
    assert.equal(panels[1].removed, false);

    assert.equal(badges.length, 2);
    assert.equal(badges[0].removed, true);
    assert.equal(badges[1].spec.title, "Subagents");
    assert.equal(badges[1].removed, false);

    assert.equal(commands.length, 2);
    assert.equal(commands[0].removed, true);
    assert.equal(commands[1].spec.title, "Refresh Antigravity quotas");
    assert.equal(commands[1].removed, false);
  } finally {
    handle.dispose();
  }

  // Every registration must be cleaned up on dispose()
  assert.ok(panels.every((r) => r.removed), "all agent panels must be removed on dispose");
  assert.ok(badges.every((r) => r.removed), "all workspace badges must be removed on dispose");
  assert.ok(commands.every((r) => r.removed), "all command center items must be removed on dispose");
  assert.ok(footers.every((r) => r.removed), "all sidebar footers must be removed on dispose");
  assert.ok(slashes.every((r) => r.removed), "all slash commands must be removed on dispose");
  assert.ok(pills.every((p) => p.removed), "all composer pills must be removed on dispose");

  // Toggling locale after dispose() must trigger zero callbacks (no leaked locale listeners)
  const countsAfterDispose = {
    panels: panels.length,
    badges: badges.length,
    commands: commands.length,
    footers: footers.length,
    slashes: slashes.length,
    pillUpdates: pills.reduce((sum, p) => sum + p.updates.length, 0),
  };
  setLanguageOverride("zh-CN");
  setLanguageOverride("en");
  assert.deepEqual(
    {
      panels: panels.length,
      badges: badges.length,
      commands: commands.length,
      footers: footers.length,
      slashes: slashes.length,
      pillUpdates: pills.reduce((sum, p) => sum + p.updates.length, 0),
    },
    countsAfterDispose,
    "disposed client handle must leak zero subscribeLocale listeners",
  );
});

test("Antigravity built-in tool names and mcp_paseo_* prefixes localize cleanly in zh-CN and en", () => {
  const { setLocale } = require("../client/locale.ts");
  const { toolLabel, toolIcon, toolCallData } = require("../client/tool-call-data.ts");

  const cases = [
    ["run_command", "运行命令", "Run command", { type: "shell", command: "ls" }, "SquareTerminal"],
    ["read_file", "读取", "Read", { type: "read", filePath: "/a.ts" }, "Eye"],
    ["edit_file", "编辑", "Edit", { type: "edit", filePath: "/a.ts" }, "Pencil"],
    ["write_file", "写入", "Write", { type: "write", filePath: "/a.ts" }, "Pencil"],
    ["grep_search", "搜索文件内容", "Grep", { type: "search" }, "Search"],
    ["find_by_name", "查找文件", "Find files", { type: "search" }, "Search"],
    ["list_dir", "列出目录", "List directory", { type: "unknown" }, "FolderOpen"],
    ["search_web", "网页搜索", "Search", { type: "search" }, "Globe"],
    ["read_url_content", "网页获取", "Fetch", { type: "fetch" }, "Eye"],
    ["manage_task", "管理后台任务", "Manage task", { type: "unknown" }, "Timer"],
    ["schedule", "定时任务", "Schedule", { type: "unknown" }, "CalendarClock"],
    ["update_steps", "更新任务清单", "Update tasks", { type: "unknown" }, "ListChecks"],
    ["ask_question", "提问", "Ask question", { type: "unknown" }, "MessageCircleQuestion"],
    ["invoke_subagent", "调用子智能体", "Invoke subagent", { type: "unknown" }, "Bot"],
    ["swarm", "管理蜂群", "Manage swarm", { type: "unknown" }, "Users"],
    ["post_message", "发布蜂群消息", "Post board message", { type: "unknown" }, "Send"],
    ["read_board", "读取蜂群公告板", "Read board", { type: "unknown" }, "ClipboardList"],
    ["swarm_wait", "等待蜂群消息", "Wait for swarm", { type: "unknown" }, "Hourglass"],
    ["list_resources", "列出 MCP 资源", "List MCP resources", { type: "unknown" }, "Server"],
    ["read_resource", "读取 MCP 资源", "Read MCP resource", { type: "unknown" }, "FileText"],
    ["paseo.get_agent_activity", "查看智能体活动", "Read agent activity", { type: "unknown" }, "Activity"],
    ["mcp_paseo_list_agents", "列出智能体", "List agents", { type: "unknown" }, "Bot"],
    ["agy-fast_fast.batch_search", "批量搜索", "Batch search", { type: "unknown" }, "Search"],
    ["mcp_agy-fast_fast_apply_edits", "批量编辑", "Apply edits", { type: "unknown" }, "Pencil"],
    ["fast.read_slices", "分段读取", "Read slices", { type: "unknown" }, "Eye"],
    ["mcp__agy-fast_fast__quick_outline", "代码大纲", "Quick outline", { type: "unknown" }, "FileCode"],
    ["run_checks", "并行检查", "Run checks", { type: "unknown" }, "SquareTerminal"],
  ];

  try {
    for (const [name, zh, en, detail, expectedIcon] of cases) {
      setLocale("zh-CN");
      assert.equal(toolLabel(name, detail), zh, `${name} zh-CN label`);
      assert.equal(toolIcon(name, detail), expectedIcon, `${name} icon`);
      assert.equal(
        toolCallData({ name, status: "completed", detail }, "complete").label,
        zh,
        `${name} toolCallData zh-CN`,
      );
      setLocale("en");
      assert.equal(toolLabel(name, detail), en, `${name} en label`);
    }
  } finally {
    setLocale(undefined);
  }
});

test("SubagentReader.toolSummaries maps exact and truncated run_command CommandLine to toolSummary", async (t) => {
  const cliDir = makeTempDir(t, "paseo-ag-summaries-");
  const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const logFile = path.join(cliDir, "brain", parentId, ".system_generated", "logs", "transcript.jsonl");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const rows = [
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      tool_calls: [
        {
          name: "run_command",
          args: {
            CommandLine: JSON.stringify("paseo plugin reload dsh-paseo && paseo plugin ls"),
            toolSummary: JSON.stringify("重载并检查插件状态"),
          },
        },
        {
          name: "run_command",
          args: {
            // Simulate agy truncating a long CommandLine mid-JSON string
            CommandLine: '"node -e \'const longCommand = true; console.log(longCommand);\'',
            toolSummary: JSON.stringify("运行长脚本检查"),
          },
        },
      ],
    },
  ];
  fs.writeFileSync(logFile, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

  const context = {
    conversationId: async (_paseo, agentId) => (agentId === "agent-1" ? parentId : null),
  };
  const reader = new SubagentReader(context, cliDir);
  const summaries = await reader.toolSummaries({}, "agent-1");

  assert.equal(
    agContracts.matchAntigravityCommandSummary(summaries, "paseo plugin reload dsh-paseo && paseo plugin ls"),
    "重载并检查插件状态",
  );
  assert.equal(
    agContracts.matchAntigravityCommandSummary(
      summaries,
      "node -e 'const longCommand = true; console.log(longCommand);' && echo done",
    ),
    "运行长脚本检查",
  );
  assert.equal(agContracts.matchAntigravityCommandSummary(summaries, "echo unknown"), "");

  // Non-Antigravity agent returns empty map cleanly
  const empty = await reader.toolSummaries({}, "non-ag");
  assert.deepEqual(empty, { byCommand: {}, prefixes: [] });
});

test("ThinkingTranslator detects English prose, chunks paragraphs, caches to disk, and rejects quota warnings", async (t) => {
  const { needsChineseTranslation, splitTranslationChunks, isPreviewReadyForTranslation } = require("../shared/translate-text.ts");
  const { ThinkingTranslator } = require("../server/translate.ts");

  assert.equal(needsChineseTranslation("Feature request asks for a return button in the full view."), true);
  assert.equal(needsChineseTranslation("正在检查 `InlineThinking` 和 `/workspace/project/paseo-dsh` 的渲染逻辑。"), false);
  assert.equal(needsChineseTranslation("ok"), false);

  // Streaming prefetch readiness
  assert.equal(isPreviewReadyForTranslation("Checking", "Checking", "streaming"), false);
  assert.equal(isPreviewReadyForTranslation("Checking files\nSecond line", "Checking files", "streaming"), true);
  assert.equal(
    isPreviewReadyForTranslation("Inspecting navigation props cleanly.", "Inspecting navigation props cleanly.", "streaming"),
    true,
  );
  assert.equal(isPreviewReadyForTranslation("Short", "Short", "complete"), true);

  const longEnglish = [
    "First paragraph explains the architecture in detail.",
    `${"Sentence explaining one step of the plan. ".repeat(14).trim()}`,
  ].join("\n\n");
  const plan = splitTranslationChunks(longEnglish, 200);
  assert.ok(plan.pieces.length >= 3, "long paragraph must be split into <= 200-char chunks");
  assert.ok(plan.pieces.every((p) => p.length <= 200), "every chunk respects maxLen");

  const dir = makeTempDir(t, "paseo-translate-cache-");
  const cacheFile = path.join(dir, "cache.json");
  let fetchCalls = 0;
  let quotaMode = false;
  const mockFetch = async (url) => {
    fetchCalls += 1;
    const q = new URL(String(url)).searchParams.get("q") || "";
    if (quotaMode) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          responseStatus: 200,
          responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS" },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        responseStatus: 200,
        responseData: { translatedText: `译:${q}` },
      }),
    };
  };

  const translator1 = new ThinkingTranslator({
    cacheFile,
    fetchImpl: mockFetch,
    dshHomeDir: null,
    allowPublicFallback: true,
  });
  t.after(() => translator1.dispose());

  // Chinese text is skipped without hitting fetch
  const skipped = await translator1.translate("已经是一段中文思考内容，无需翻译。", "zh-CN");
  assert.equal(skipped.provider, "skip");
  assert.equal(fetchCalls, 0);

  // English text translates and preserves paragraphs
  const sample = "First thought paragraph.\n\nSecond thought paragraph.";
  const first = await translator1.translate(sample, "zh-CN");
  assert.equal(first.cached, false);
  assert.equal(first.provider, "mymemory");
  assert.equal(first.translated, "译:First thought paragraph.\n\n译:Second thought paragraph.");
  assert.equal(fetchCalls, 2);

  // Second call hits in-memory cache
  const second = await translator1.translate(sample, "zh-CN");
  assert.equal(second.cached, true);
  assert.equal(second.translated, first.translated);
  assert.equal(fetchCalls, 2);

  // Flush to disk and verify a fresh instance loads the persisted cache
  await translator1.flushCache();
  const translator2 = new ThinkingTranslator({
    cacheFile,
    fetchImpl: mockFetch,
    dshHomeDir: null,
    allowPublicFallback: true,
  });
  t.after(() => translator2.dispose());
  const persisted = await translator2.translate(sample, "zh-CN");
  assert.equal(persisted.cached, true);
  assert.equal(persisted.translated, first.translated);
  assert.equal(fetchCalls, 2);

  // MyMemory quota warning must reject and never poison cache
  quotaMode = true;
  await assert.rejects(() => translator2.translate("Another English thought that hits quota limit.", "zh-CN"));
});

test("ThinkingTranslator prefers dynamically discovered DSH openai-completions fast model and falls back to MyMemory", async (t) => {
  const { ThinkingTranslator, resolveDshTranslationEndpoint } = require("../server/translate.ts");
  const dshDir = makeTempDir(t, "paseo-dsh-translate-");
  const patchFile = path.join(dshDir, "profiles", "paseo", "cordis.patch.yml");
  fs.mkdirSync(path.dirname(patchFile), { recursive: true });
  fs.writeFileSync(
    patchFile,
    [
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      other:",
      "        api: openai-responses",
      "        apiKeyEnv: TEST_KEY",
      "        baseURL: https://example.invalid/v1",
      "        models:",
      "          - id: slow-responses-model",
      "      primary:",
      "        api: openai-completions",
      "        apiKeyEnv: TEST_TRANSLATE_KEY",
      "        baseURL: https://example.test/v1/",
      "        models:",
      "          - id: agy-acp/skip-me",
      "          - id: example-pro",
      "          - id: example-flash",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dshDir, ".credentials.yaml"), 'TEST_TRANSLATE_KEY: "dummy-secret-token"\n');

  const endpoint = await resolveDshTranslationEndpoint(dshDir, "paseo");
  assert.deepEqual(endpoint, {
    baseURL: "https://example.test/v1",
    apiKey: "dummy-secret-token",
    model: "example-flash",
  });

  const cacheFile = path.join(dshDir, "cache.json");
  let failDsh = false;
  const seenUrls = [];
  const mockFetch = async (url, init) => {
    const href = String(url);
    seenUrls.push(href);
    if (href.startsWith("https://example.test/v1/chat/completions")) {
      if (failDsh) return { ok: false, status: 503, json: async () => ({}) };
      const body = JSON.parse(init.body);
      assert.equal(body.model, "example-flash");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "DSH 译文：检查导航属性并接入返回按钮。" } }],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        responseStatus: 200,
        responseData: { translatedText: "MyMemory 回退译文" },
      }),
    };
  };

  const translator = new ThinkingTranslator({
    cacheFile,
    fetchImpl: mockFetch,
    dshHomeDir: dshDir,
    profile: "paseo",
    allowPublicFallback: true,
  });
  t.after(() => translator.dispose());

  const dshRes = await translator.translate("Inspecting navigation props to add a return button.", "zh-CN");
  assert.equal(dshRes.provider, "dsh");
  assert.equal(dshRes.cached, false);
  assert.equal(dshRes.translated, "DSH 译文：检查导航属性并接入返回按钮。");

  // When DSH fails transiently, automatically falls back to MyMemory
  failDsh = true;
  const fallbackRes = await translator.translate("Another English paragraph when primary is down.", "zh-CN");
  assert.equal(fallbackRes.provider, "mymemory");
  assert.equal(fallbackRes.translated, "MyMemory 回退译文");
});

test("translate-text detects starting English and splits streaming thinking segments cleanly", () => {
  const { isLikelyStartingEnglish, splitStreamingThinkingSegments } = require("../shared/translate-text.ts");

  assert.equal(isLikelyStartingEnglish("The"), true);
  assert.equal(isLikelyStartingEnglish("Let's check"), true);
  assert.equal(isLikelyStartingEnglish("正在检查"), false);
  assert.equal(isLikelyStartingEnglish("A long English sentence that exceeds twenty four chars."), false);
  assert.equal(isLikelyStartingEnglish("12345"), false);

  // Streaming segment splitter keeps closed sentences stable and marks live tail open
  const streamingSegs = splitStreamingThinkingSegments(
    "First closed sentence. Second sentence still typing",
    "streaming",
  );
  assert.deepEqual(streamingSegs, [
    { text: "First closed sentence.", sep: " ", closed: true },
    { text: "Second sentence still typing", sep: "", closed: false },
  ]);

  const completeSegs = splitStreamingThinkingSegments(
    "First closed sentence. Second sentence done",
    "complete",
  );
  assert.deepEqual(completeSegs, [
    { text: "First closed sentence.", sep: " ", closed: true },
    { text: "Second sentence done", sep: "", closed: true },
  ]);

  const multilineSegs = splitStreamingThinkingSegments(
    "Line one heading\n\n```ts\nconst x = 1;\n```\nStill streaming line",
    "streaming",
  );
  assert.equal(multilineSegs[0].closed, true);
  assert.equal(multilineSegs[0].text, "Line one heading");
  assert.equal(multilineSegs[0].sep, "\n\n");
  assert.equal(multilineSegs[1].closed, true);
  assert.equal(multilineSegs[1].text, "```ts\nconst x = 1;\n```");
  assert.equal(multilineSegs[2].closed, false);
  assert.equal(multilineSegs[2].text, "Still streaming line");
});

test("resolveRealHome rejects profile-isolated HOME paths so account switching never creates symlink loops", () => {
  const { isProfileHomePath, resolveRealHome } = require("../server/antigravity/paths.ts");
  const profileHomePath = "/home/alice/.paseo/plugin-data/dsh-paseo/antigravity/profiles/a3bdf6066/home";
  const legacyProfileHomePath = "/home/alice/.paseo/plugin-data/antigravity-accounts/profiles/afbd62f31/home";

  assert.equal(isProfileHomePath(profileHomePath), true);
  assert.equal(isProfileHomePath(`${profileHomePath}/.gemini/config`), true);
  assert.equal(isProfileHomePath(legacyProfileHomePath), true);
  assert.equal(isProfileHomePath("/home/alice"), false);
  assert.equal(isProfileHomePath("/home/alice/.gemini/config"), false);

  // Uses passwd home when env HOME is a profile home
  assert.equal(resolveRealHome(profileHomePath, "/home/alice"), "/home/alice");
  // Falls back to stripping `.paseo/...` when passwd home is unavailable
  assert.equal(resolveRealHome(profileHomePath, ""), "/home/alice");
  assert.equal(resolveRealHome(legacyProfileHomePath, ""), "/home/alice");
  // Keeps normal user HOME untouched
  assert.equal(resolveRealHome("/home/alice", "/home/other"), "/home/alice");
});

test("OrchestratorSettings.supportsModel matches base model ids against effort-suffixed agy catalog entries", () => {
  const { OrchestratorSettings } = require("../server/antigravity/orchestrator.ts");
  const settings = new OrchestratorSettings({});
  settings.catalogs.set("a1111111", {
    fetchedAt: Date.now(),
    identity: "user@example.com",
    models: [
      { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
      { id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)" },
      { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
      { id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)" },
    ],
  });

  // Base model id (what Paseo stores in agent.model) matches effort-suffixed agy catalog entries
  assert.equal(settings.supportsModel("a1111111", "gemini-4-neon"), true);
  assert.equal(settings.supportsModel("a1111111", "antigravity/gemini-4-neon"), true);
  // Exact effort variant still requires exact availability
  assert.equal(settings.supportsModel("a1111111", "gemini-4-neon-high"), true);
  assert.equal(settings.supportsModel("a1111111", "gemini-4-neon-xhigh"), false);
  // Orchestrator and missing models behave strictly
  assert.equal(settings.supportsModel("a1111111", "gemini-pro-orchestrator-neon"), true);
  assert.equal(settings.supportsModel("a1111111", "claude-opus-5-5"), false);
  // Uncached account stays unknown (null) so it is never falsely blocked
  assert.equal(settings.supportsModel("a2222222", "gemini-4-neon"), null);
});

test("FallbackController detects agy soft quota completions, parses reset delay, avoids false positives, and switches accounts", async () => {
  const {
    EXHAUSTED_THRESHOLD,
    FallbackController,
    exhausted,
    extractAgySoftFailureLine,
    extractSoftTurnFailure,
    parseResetDelayMs,
    resetOfExhausted,
  } = require("../server/antigravity/fallback.ts");
  const { PendingSwitches } = require("../server/antigravity/hooks.ts");
  const { OrchestratorSettings } = require("../server/antigravity/orchestrator.ts");

  assert.equal(EXHAUSTED_THRESHOLD, 0.01);
  assert.equal(parseResetDelayMs("⚠ Individual quota reached. Resets in 11m21s."), (11 * 60 + 21) * 1000);
  assert.equal(parseResetDelayMs("Resets in 1h1m24s."), (3600 + 60 + 24) * 1000);
  assert.equal(parseResetDelayMs("No reset info"), null);

  // Near-zero bucket (0.64%) counts as exhausted and provides reset timestamp
  const nearZeroGroups = [
    {
      name: "Gemini Models",
      buckets: [
        {
          id: "gemini-5h",
          name: "Five Hour Limit Remaining",
          window: "5h",
          remainingFraction: 0.00638,
          resetTime: "2026-11-27T08:04:52Z",
          disabled: false,
        },
      ],
    },
  ];
  assert.equal(exhausted(nearZeroGroups, "gemini"), true);
  assert.equal(resetOfExhausted(nearZeroGroups, "gemini"), Date.parse("2026-11-27T08:04:52Z"));

  // Soft-failure extraction: real agy messages match; prose/code/quotes never false-trigger
  const realQuotaMsg = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 11m21s.";
  assert.equal(extractAgySoftFailureLine(realQuotaMsg), realQuotaMsg);
  assert.equal(extractAgySoftFailureLine(`正在检查日志...\n\n${realQuotaMsg}`), realQuotaMsg);
  assert.equal(extractAgySoftFailureLine(`日志里看到 \`${realQuotaMsg}\``), null);
  assert.equal(extractAgySoftFailureLine(`> ${realQuotaMsg}`), null);
  assert.equal(extractAgySoftFailureLine(`- ${realQuotaMsg}`), null);
  assert.equal(extractAgySoftFailureLine(`\`\`\`\n${realQuotaMsg}\n\`\`\``), null);
  assert.equal(extractAgySoftFailureLine(`${realQuotaMsg}\n\n这是因为 agy acp 正常结束了回合。`), null);

  // Older turn warning must be ignored when a newer turn completed cleanly
  assert.equal(
    extractSoftTurnFailure(
      [
        { turnId: "t1", item: { type: "user_message", text: "first" } },
        { turnId: "t1", item: { type: "assistant_message", text: realQuotaMsg } },
        { turnId: "t2", item: { type: "user_message", text: "second" } },
        { turnId: "t2", item: { type: "assistant_message", text: "一切正常。" } },
      ],
      "t2",
    ),
    null,
  );

  // Already-noted turn must never re-trigger
  assert.equal(
    extractSoftTurnFailure(
      [
        { turnId: "t1", item: { type: "user_message", text: "hi" } },
        { turnId: "t1", item: { type: "assistant_message", text: realQuotaMsg } },
        { turnId: "t1", item: { type: "plugin", kind: agContracts.FALLBACK_TIMELINE_KIND } },
      ],
      "t1",
    ),
    null,
  );

  // End-to-end FallbackController on a `completed` turn with `⚠ Individual quota reached...`
  const metadata = {};
  const timelineNotes = [];
  let reloaded = 0;
  const sentPrompts = [];

  const fakeService = {
    init: async () => {},
    setCooldownProvider: () => {},
    onStatusUpdated: () => () => {},
    notifyChange: () => {},
    fallbackSettings: () => ({ enabled: true, retries: 2, strategy: "reset" }),
    labelOf: (id) => (id === "default" ? "Ultra" : "mon"),
    requireAccount: (id) => (id === "default" ? null : { id: "a3bdf6066", label: "mon", unsafeDetail: null }),
    quotaFor: async () => ({ status: "signed-in" }),
    refreshOne: async () => {},
    knownQuota: (id) =>
      id === "default"
        ? [{ name: "Gemini Models", buckets: [{ id: "gemini-5h", name: "5h", window: "5h", remainingFraction: 0.05, resetTime: null, disabled: false }] }]
        : [{ name: "Gemini Models", buckets: [{ id: "gemini-5h", name: "5h", window: "5h", remainingFraction: 0.8, resetTime: "2026-11-27T08:29:03Z", disabled: false }] }],
    state: async () => ({
      defaultAccountId: "default",
      accounts: [
        { id: "default", label: "Ultra", kind: "system", status: "signed-in", usable: true, fallbackEnabled: false },
        { id: "a3bdf6066", label: "mon", kind: "profile", status: "signed-in", usable: true, fallbackEnabled: true },
      ],
    }),
  };

  const models = new OrchestratorSettings(fakeService);
  models.catalogs.set("a3bdf6066", {
    fetchedAt: Date.now(),
    identity: "mon@example.com",
    models: [{ id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" }],
  });

  const controller = new FallbackController(fakeService, new PendingSwitches(), models);
  const { server, hooks } = createFakeServer();
  const unregister = controller.register(server);
  try {
    const turnAfter = hooks.find((h) => h.name === "agent.turn.after");
    assert.ok(turnAfter, "FallbackController must register agent.turn.after");

    const fakeAgentRef = {
      refresh: async () => ({
        agent: {
          id: "agent-1",
          provider: "antigravity",
          model: "gemini-4-neon",
          status: "idle",
          archivedAt: null,
          metadata: { ...metadata },
        },
      }),
      setMetadata: async (patch) => {
        Object.assign(metadata, patch);
      },
      reload: async () => {
        reloaded += 1;
      },
      send: async (text) => {
        sentPrompts.push(text);
      },
      timeline: {
        refetch: async () => ({
          agent: {
            id: "agent-1",
            provider: "antigravity",
            model: "gemini-4-neon",
            metadata: { ...metadata },
          },
          entries: [
            { turnId: "turn-1", item: { type: "user_message", text: "帮我查一下" } },
            { turnId: "turn-1", item: { type: "assistant_message", text: realQuotaMsg } },
          ],
        }),
        append: async (item) => {
          timelineNotes.push(item);
        },
      },
    };
    const fakePaseo = { agents: { ref: () => fakeAgentRef } };

    const before = Date.now();
    await turnAfter.handler(
      {
        agent: { id: "agent-1", provider: "antigravity", metadata: {} },
        turnId: "turn-1",
        outcome: { kind: "completed" },
      },
      { paseo: fakePaseo, signal: new AbortController().signal },
    );

    assert.equal(metadata[agContracts.ACCOUNT_METADATA_KEY], "a3bdf6066", "must switch account to backup profile");
    assert.equal(reloaded, 1, "must reload agent onto new account");
    assert.deepEqual(sentPrompts, ["Continue."], "must auto-continue on the new account");
    assert.equal(timelineNotes.length, 1);
    assert.equal(timelineNotes[0].kind, agContracts.FALLBACK_TIMELINE_KIND);
    assert.equal(timelineNotes[0].data.event, "switch");
    assert.equal(timelineNotes[0].data.reason, "quota");
    assert.equal(timelineNotes[0].data.from, "Ultra");
    assert.equal(timelineNotes[0].data.to, "mon");

    // Cooldown must use the parsed ~11m21s delay rather than the default 30m fallback
    const cooldowns = controller.cooldownsOf("default");
    assert.equal(cooldowns.length, 1);
    const delayMs = Date.parse(cooldowns[0].until) - before;
    assert.ok(delayMs >= 11 * 60_000 && delayMs <= 12 * 60_000, `expected ~11m21s cooldown, got ${delayMs}ms`);
  } finally {
    unregister();
    controller.dispose();
  }
});

// ============================================================================
// 10. Regression coverage for audit P0/P1 fixes (migration, fallback, swarm, signin, client transforms & tool-summaries)
// ============================================================================

test("migrateLegacyDataDir recovers partial migration when profiles/ exists but accounts.json is missing", async (t) => {
  const root = makeTempDir(t, "paseo-partial-mig-");
  const legacyDir = path.join(root, "antigravity-accounts");
  const targetDir = path.join(root, "dsh-paseo", "antigravity");

  writeJson(path.join(legacyDir, "accounts.json"), {
    version: 1,
    defaultAccountId: "a1234567",
    accounts: [{ id: "a1234567", label: "Recovered" }],
  });
  writeJson(path.join(legacyDir, "status.json"), { a1234567: { status: "signed-in" } });
  fs.mkdirSync(path.join(legacyDir, "profiles", "a1234567"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "profiles", "a1234567", "legacy.txt"), "legacy");

  // Simulate partial target state: profiles/ already exists with existing data, but accounts.json is missing.
  fs.mkdirSync(path.join(targetDir, "profiles", "a1234567"), { recursive: true });
  fs.writeFileSync(path.join(targetDir, "profiles", "a1234567", "existing.txt"), "keep-me");

  const res = await migrateLegacyDataDir({ legacyDir, targetDir });
  assert.equal(res.migrated, true);
  assert.deepEqual([...res.copiedEntries].sort(), ["accounts.json", "status.json"]);
  assert.equal(fs.readFileSync(path.join(targetDir, "profiles", "a1234567", "existing.txt"), "utf8"), "keep-me");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(targetDir, "accounts.json"), "utf8")).accounts[0].label,
    "Recovered",
  );
});

test("FallbackController.pickNext does not skip ids[0] when current account was removed, and resetOfExhausted ignores expired timestamps", async () => {
  const { FallbackController, resetOfExhausted } = require("../server/antigravity/fallback.ts");
  const { PendingSwitches } = require("../server/antigravity/hooks.ts");

  const now = Date.parse("2026-11-27T10:00:00Z");
  const groupsWithExpiredAndFuture = [
    {
      name: "Gemini Models",
      buckets: [
        {
          id: "b-expired",
          name: "Expired",
          window: "5h",
          remainingFraction: 0.0,
          resetTime: "2026-11-27T09:55:00Z",
          disabled: false,
        },
        {
          id: "b-future",
          name: "Future",
          window: "5h",
          remainingFraction: 0.005,
          resetTime: "2026-11-27T10:30:00Z",
          disabled: false,
        },
      ],
    },
  ];
  assert.equal(
    resetOfExhausted(groupsWithExpiredAndFuture, "gemini", now),
    Date.parse("2026-11-27T10:30:00Z"),
    "expired resetTime must be ignored in favor of future resetTime",
  );
  const onlyExpired = [
    {
      name: "Gemini Models",
      buckets: [
        {
          id: "b-expired",
          name: "Expired",
          window: "5h",
          remainingFraction: 0.0,
          resetTime: "2026-11-27T09:55:00Z",
          disabled: false,
        },
      ],
    },
  ];
  assert.equal(resetOfExhausted(onlyExpired, "gemini", now), null, "only expired timestamps must return null");

  const fakeService = {
    setCooldownProvider: () => {},
    onStatusUpdated: () => () => {},
    notifyChange: () => {},
    fallbackSettings: () => ({ enabled: true, retries: 1, strategy: "order" }),
    knownQuota: () => [{ name: "Gemini Models", buckets: [{ id: "g", name: "5h", window: "5h", remainingFraction: 0.9, resetTime: null, disabled: false }] }],
    state: async () => ({
      defaultAccountId: "default",
      accounts: [
        { id: "default", label: "First", kind: "system", status: "signed-in", usable: true, fallbackEnabled: true },
        { id: "a2222222", label: "Second", kind: "profile", status: "signed-in", usable: true, fallbackEnabled: true },
      ],
    }),
  };
  const controller = new FallbackController(fakeService, new PendingSwitches());
  try {
    // Current account is no longer in `state.accounts` -> must start at index 0 (`default`), not skip it!
    const picked = await controller.pickNext("a9999999", new Set(["a9999999"]), "gemini-4-neon", "order");
    assert.equal(picked, "default");
  } finally {
    controller.dispose();
  }
});

test("SubagentReader keeps recreated swarm worker alive when members.json explicitly marks killed: false despite historical swarm kill by same name", async (t) => {
  const cliDir = makeTempDir(t, "paseo-ag-recreate-");
  const parentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const oldWorkerId = "10101010-1010-4010-8010-101010101010";
  const newWorkerId = "20202020-2020-4020-8020-202020202020";
  const parentBrain = path.join(cliDir, "brain", parentId);
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

  writeJsonl(path.join(parentBrain, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-60_000),
      tool_calls: [{ name: "swarm", args: { action: '"add"', name: '"worker"', brief: '"Old task"' } }],
    },
    {
      step_index: 1,
      type: "GENERIC",
      status: "DONE",
      created_at: iso(-59_000),
      content: JSON.stringify({ status: "added", name: "worker", conversation_id: oldWorkerId }),
    },
    {
      step_index: 2,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-40_000),
      tool_calls: [{ name: "swarm", args: { action: '"kill"', name: '"worker"' } }],
    },
    {
      step_index: 3,
      type: "GENERIC",
      status: "DONE",
      created_at: iso(-39_500),
      content: '{"status":"killed","name":"worker"}',
    },
    {
      step_index: 4,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-10_000),
      tool_calls: [{ name: "swarm", args: { action: '"add"', name: '"worker"', brief: '"Fresh task"' } }],
    },
    {
      step_index: 5,
      type: "GENERIC",
      status: "DONE",
      created_at: iso(-9_500),
      content: JSON.stringify({ status: "added", name: "worker", conversation_id: newWorkerId }),
    },
  ]);

  writeJson(path.join(parentBrain, ".system_generated", "swarm", "members.json"), {
    title: "Recreated Worker Test",
    members: {
      coordinator: { conversation_id: parentId, role: "coordinator", killed: false },
      worker: { conversation_id: newWorkerId, role: "worker", wake_mode: "working", killed: false },
    },
  });

  writeJsonl(path.join(cliDir, "brain", oldWorkerId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-59_000),
      content: `<SYSTEM_MESSAGE>[Message] sender=${parentId} content=Old task</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-50_000),
      tool_calls: [{ name: "read_file", args: { Path: '"/repo/old.ts"' } }],
    },
  ]);
  writeJsonl(path.join(cliDir, "brain", newWorkerId, ".system_generated", "logs", "transcript.jsonl"), [
    {
      step_index: 0,
      type: "SYSTEM_MESSAGE",
      status: "DONE",
      created_at: iso(-9_000),
      content: `<SYSTEM_MESSAGE>[Message] sender=${parentId} content=Fresh task</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(-2_000),
      tool_calls: [{ name: "read_file", args: { Path: '"/repo/new.ts"' } }],
    },
    {
      step_index: 2,
      type: "GENERIC",
      status: "RUNNING",
      created_at: iso(-1_000),
      content: "running",
    },
  ]);

  const reader = new SubagentReader(
    makeFakeContextReader({ "agent-recreate": { conversationId: parentId, closed: false, model: null } }),
    cliDir,
  );
  const list = await reader.list({}, "agent-recreate");
  const byId = new Map(list.subagents.map((s) => [s.id, s]));
  assert.equal(byId.get(oldWorkerId)?.state, "stopped", "old killed worker stays stopped");
  assert.equal(byId.get(newWorkerId)?.state, "running", "recreated worker with members.json killed:false must stay running");
});

test("SignInManager redacts OAuth codes containing +/=% and access_token key-values from failure messages", async (t) => {
  const prevPaseoHome = process.env.PASEO_HOME;
  const root = makeTempDir(t, "paseo-signin-redact-");
  process.env.PASEO_HOME = path.join(root, "paseo-home");
  t.after(() => {
    if (prevPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevPaseoHome;
  });

  const { SignInManager } = require("../server/antigravity/signin.ts");
  const { profileHome } = require("../server/antigravity/paths.ts");
  const accountId = "a1b2c3d4";
  fs.mkdirSync(profileHome(accountId), { recursive: true });

  const oauthCode = "4/0AeanS0+AbCdEfGhIjKlMnOpQrStUvWxYz%2F12345==";
  const fakeAgy = makeExecutable(
    path.join(root, "fake-agy.js"),
    `#!${process.execPath}
process.stdout.write("Open https://accounts.google.com/o/oauth2/auth?state=st-123\\n");
process.stdin.once("data", (chunk) => {
  const pasted = chunk.toString("utf8").trim();
  process.stderr.write("exchange failed for " + pasted + " access_token=ya29.SecretValue+With/Chars==\\n");
  process.exit(1);
});
`,
  );

  const mgr = new SignInManager();
  t.after(() => mgr.cancelAll());
  const started = await mgr.start(fakeAgy, accountId);
  await assert.rejects(
    () => mgr.submit(started.loginId, oauthCode),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message.includes("AeanS0"), false, `raw OAuth code leaked in error: ${err.message}`);
      assert.equal(err.message.includes("ya29.SecretValue"), false, `access_token leaked in error: ${err.message}`);
      assert.match(err.message, /<redacted>/);
      return true;
    },
  );
});

test("transformToolCall manage_subagents supports ACP { output: string } wrapper objects for both list and kill", () => {
  const transforms = createAntigravityTimelineTransforms();
  const childUuid = "12345678-1234-4123-8123-123456789abc";

  const wrappedList = transforms.transformToolCall({
    type: "tool_call",
    callId: "wrap-list",
    name: "manage_subagents",
    status: "completed",
    detail: {
      type: "unknown",
      input: { Action: "list" },
      output: {
        output: `You have 1 active subagent(s): [{"conversationId":"${childUuid}","role":"verifier","state":"running"}]`,
      },
    },
  });
  assert.equal(wrappedList?.items[0].kind, agContracts.SUBAGENT_LIST_TIMELINE_KIND);
  assert.deepEqual(wrappedList.items[0].data.states, [
    { id: childUuid, role: "verifier", state: "running" },
  ]);

  const wrappedKill = transforms.transformToolCall({
    type: "tool_call",
    callId: "wrap-kill",
    name: "manage_subagents",
    status: "completed",
    detail: {
      type: "unknown",
      input: { Action: "kill", ConversationIds: [childUuid] },
      output: { output: "Killed 1 subagent(s).\nKilled roles: verifier" },
    },
  });
  assert.equal(wrappedKill?.items[0].kind, agContracts.SUBAGENT_LIST_TIMELINE_KIND);
  assert.deepEqual(wrappedKill.items[0].data.states, [
    { id: childUuid, role: "verifier", state: "stopped" },
  ]);
});

test("tool-summaries client cache throttles fetches within STALE_MS and evicts idle entries even when oldest entry has active listeners", async (t) => {
  // Minimal isolated React hook harness for `useAntigravityCommandSummary`.
  function createReactStub() {
    let activeInst = null;
    const stub = {
      useState(init) {
        const inst = activeInst;
        const idx = inst.cursor++;
        if (!(idx in inst.states)) {
          inst.states[idx] = typeof init === "function" ? init() : init;
        }
        const setState = (next) => {
          inst.states[idx] = typeof next === "function" ? next(inst.states[idx]) : next;
        };
        return [inst.states[idx], setState];
      },
      useRef(init) {
        const inst = activeInst;
        const idx = inst.cursor++;
        if (!(idx in inst.refs)) inst.refs[idx] = { current: init };
        return inst.refs[idx];
      },
      useEffect(fn, deps) {
        const inst = activeInst;
        const idx = inst.cursor++;
        const prev = inst.effects[idx];
        const changed =
          !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
        if (changed) {
          inst.pendingEffects.push({ idx, fn, deps, prevCleanup: prev?.cleanup });
        }
      },
    };
    function mount(renderFn) {
      const inst = { cursor: 0, states: [], refs: [], effects: [], pendingEffects: [], lastResult: undefined };
      const render = () => {
        inst.cursor = 0;
        inst.pendingEffects = [];
        activeInst = inst;
        try {
          inst.lastResult = renderFn();
        } finally {
          activeInst = null;
        }
        for (const eff of inst.pendingEffects) {
          eff.prevCleanup?.();
          const cleanup = eff.fn();
          inst.effects[eff.idx] = { deps: eff.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
        }
        return inst.lastResult;
      };
      const unmount = () => {
        for (const eff of inst.effects) eff?.cleanup?.();
        inst.effects = [];
      };
      render();
      return { render, unmount };
    }
    return { stub, mount };
  }

  const { stub, mount } = createReactStub();
  const originalLoad = Module._load;
  const modPath = require.resolve("../client/antigravity/tool-summaries.ts");
  delete require.cache[modPath];
  Module._load = function patchedLoad(id, parent, isMain) {
    if (id === "react") return stub;
    return originalLoad.call(this, id, parent, isMain);
  };
  let mod;
  try {
    mod = require(modPath);
  } finally {
    Module._load = originalLoad;
  }
  t.after(() => {
    delete require.cache[modPath];
  });

  const calls = new Map();
  const unregister = mod.registerAntigravityToolSummariesReader(async (agentId) => {
    calls.set(agentId, (calls.get(agentId) ?? 0) + 1);
    return {
      byCommand: { [`cmd-${agentId}`]: `摘要-${agentId}` },
      prefixes: [],
    };
  });
  t.after(() => unregister());

  // 1. Throttling: two rows for the same agent within STALE_MS trigger only one RPC fetch.
  const rowA = mount(() => mod.useAntigravityCommandSummary("ag-sticky", "cmd-ag-sticky", "completed", "r1", true));
  const rowB = mount(() => mod.useAntigravityCommandSummary("ag-sticky", "other-cmd", "completed", "r2", true));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(calls.get("ag-sticky"), 1, "same-agent rows within STALE_MS must share a single fetch");
  assert.equal(rowA.render(), "摘要-ag-sticky");
  rowB.unmount();

  // 2. LRU eviction: keep `ag-sticky` mounted (active listener) at the head, then mount/unmount 45 other agents.
  //    Idle older agents (e.g. `ag-idle-0`) must be evicted instead of being blocked by active `ag-sticky`.
  for (let i = 0; i < 45; i += 1) {
    const id = `ag-idle-${i}`;
    const h = mount(() => mod.useAntigravityCommandSummary(id, `cmd-${id}`, "completed", `r-${i}`, true));
    await Promise.resolve();
    h.unmount();
  }
  await new Promise((r) => setTimeout(r, 15));
  // `ag-sticky` is still cached (active listener kept it); `ag-idle-0` was evicted so remounting returns "" before re-fetch.
  assert.equal(rowA.render(), "摘要-ag-sticky");
  const probeEvicted = mount(() => mod.useAntigravityCommandSummary("ag-idle-0", "cmd-ag-idle-0", "completed", "probe", true));
  assert.equal(probeEvicted.render(), "", "evicted idle entry must not remain cached when oldest entry had active listeners");
  probeEvicted.unmount();
  rowA.unmount();
});

test("after-turn deferred switch prevents FallbackController from blaming the newly switched account when agent.turn.after handlers run serially", async () => {
  const { FallbackController } = require("../server/antigravity/fallback.ts");
  const { PendingSwitches, registerHooks } = require("../server/antigravity/hooks.ts");

  const metadata = { [agContracts.ACCOUNT_METADATA_KEY]: "default" };
  let reloaded = 0;
  const sentPrompts = [];
  const timelineNotes = [];
  const storeMap = new Map([
    ["a2222222", { id: "a2222222", label: "Account B", unsafeDetail: null }],
    ["a3333333", { id: "a3333333", label: "Account C", unsafeDetail: null }],
  ]);

  const fakeService = {
    store: { get: (id) => storeMap.get(id) },
    init: async () => {},
    setCooldownProvider: () => {},
    onStatusUpdated: () => () => {},
    notifyChange: () => {},
    fallbackSettings: () => ({ enabled: true, retries: 1, strategy: "order" }),
    labelOf: (id) => (id === "default" ? "Account A" : storeMap.get(id)?.label ?? id),
    requireAccount: (id) => (id === "default" ? null : storeMap.get(id) ?? null),
    quotaFor: async () => ({ status: "signed-in" }),
    refreshOne: async () => {},
    knownQuota: () => [
      {
        name: "Gemini Models",
        buckets: [{ id: "g", name: "5h", window: "5h", remainingFraction: 0.9, resetTime: null, disabled: false }],
      },
    ],
    state: async () => ({
      defaultAccountId: "default",
      accounts: [
        { id: "default", label: "Account A", kind: "system", status: "signed-in", usable: true, fallbackEnabled: true },
        { id: "a2222222", label: "Account B", kind: "profile", status: "signed-in", usable: true, fallbackEnabled: true },
        { id: "a3333333", label: "Account C", kind: "profile", status: "signed-in", usable: true, fallbackEnabled: true },
      ],
    }),
  };

  const pending = new PendingSwitches();
  const controller = new FallbackController(fakeService, pending);
  const { server, hooks } = createFakeServer();
  // Match real registration order in `server/antigravity/index.ts`: hooks first, then fallback.
  const hookRemovers = registerHooks(server, fakeService, pending, controller, { registerOpenBefore: false });
  const unregisterFallback = controller.register(server);

  const fakeAgentRef = {
    refresh: async () => ({
      agent: {
        id: "agent-serial",
        provider: "antigravity",
        model: "gemini-4-neon",
        status: "idle",
        archivedAt: null,
        metadata: { ...metadata },
      },
    }),
    setMetadata: async (patch) => {
      Object.assign(metadata, patch);
    },
    reload: async () => {
      reloaded += 1;
    },
    send: async (text) => {
      sentPrompts.push(text);
    },
    timeline: {
      refetch: async () => ({ agent: { id: "agent-serial", provider: "antigravity", model: "gemini-4-neon", metadata: { ...metadata } }, entries: [] }),
      append: async (item) => {
        timelineNotes.push(item);
      },
    },
  };
  const fakePaseo = { agents: { ref: () => fakeAgentRef } };

  try {
    // Schedule an after-turn switch from Account A (`default`) -> Account B (`a2222222`).
    pending.set("agent-serial", "a2222222");

    // Paseo dispatches all `agent.turn.after` handlers serially for the failed turn on Account A.
    const turnAfterHooks = hooks.filter((h) => h.name === "agent.turn.after");
    assert.ok(turnAfterHooks.length >= 3);
    const failedEvent = {
      agent: { id: "agent-serial", provider: "antigravity", metadata: { ...metadata } },
      turnId: "turn-fail-1",
      outcome: { kind: "failed", error: { message: "429 resource_exhausted" } },
    };
    for (const hook of turnAfterHooks) {
      await hook.handler(failedEvent, { paseo: fakePaseo, signal: new AbortController().signal });
    }

    assert.equal(metadata[agContracts.ACCOUNT_METADATA_KEY], "a2222222", "must stay on newly switched Account B without bouncing to C");
    assert.equal(reloaded, 1, "must reload exactly once for the deferred switch");
    assert.deepEqual(sentPrompts, [], "must not auto-send Continue. after a deferred manual switch");
    assert.deepEqual(controller.cooldownsOf("a2222222"), [], "healthy Account B must not receive cooldown for Account A's failure");
    assert.equal(timelineNotes.length, 0, "must not record a fallback switch event for the deferred manual switch");

    // Starting the next turn clears deferred-turn suppression so genuine failures on Account B still trigger fallback to C.
    const turnBeforeHooks = hooks.filter((h) => h.name === "agent.turn.before");
    for (const hook of turnBeforeHooks) {
      await hook.handler(
        { agent: { id: "agent-serial", provider: "antigravity", metadata: { ...metadata } } },
        { paseo: fakePaseo, signal: new AbortController().signal },
      );
    }
    const nextFailEvent = {
      agent: { id: "agent-serial", provider: "antigravity", metadata: { ...metadata } },
      turnId: "turn-fail-2",
      outcome: { kind: "failed", error: { message: "429 resource_exhausted" } },
    };
    for (const hook of turnAfterHooks) {
      await hook.handler(nextFailEvent, { paseo: fakePaseo, signal: new AbortController().signal });
    }
    assert.equal(metadata[agContracts.ACCOUNT_METADATA_KEY], "a3333333", "subsequent genuine failure on B must fall back to C");
    assert.equal(controller.cooldownsOf("a2222222").length, 1);
    assert.deepEqual(sentPrompts, ["Continue."]);
  } finally {
    unregisterFallback();
    for (const remove of hookRemovers) remove();
    controller.dispose();
  }
});

test("SubagentReader extracts Chinese swarm displayName from board brief & plan.json while preserving raw roster role, and duration formats zh-CN minutes cleanly", async (t) => {
  const { duration } = require("../client/antigravity/format.ts");

  // Duration must format minutes in zh-CN cleanly without iOS/Hermes ICU multiplying minutes by 60
  assert.equal(duration("2026-11-27T08:00:00Z", "2026-11-27T08:00:42Z", "zh-CN"), "42 秒");
  assert.equal(duration("2026-11-27T08:00:00Z", "2026-11-27T08:29:00Z", "zh-CN"), "29 分钟");
  assert.equal(duration("2026-11-27T08:00:00Z", "2026-11-27T09:15:00Z", "zh-CN"), "1 小时 15 分");
  assert.equal(duration("2026-11-27T08:00:00Z", "2026-11-27T10:00:00Z", "zh-CN"), "2 小时");

  // Pure contract helpers
  assert.equal(
    agContracts.extractSwarmBriefLabel("@audit-server-ag 你是「Antigravity 服务端审查员」，本阶段只读审查"),
    "Antigravity 服务端审查员",
  );
  assert.equal(
    agContracts.extractSwarmBriefLabel("@verifier 你是本蜂群的「独立代码复审与验收员（只读，严禁修改任何文件）」"),
    "独立代码复审与验收员",
  );
  assert.equal(
    agContracts.extractSwarmBriefLabel("@monitor You are this swarm's stall monitor."),
    null,
  );
  assert.equal(
    agContracts.cleanSwarmPlanLabel("Antigravity 客户端 P1 修复（待复审）"),
    "Antigravity 客户端 P1 修复",
  );

  // SubagentReader end-to-end with members.json + plan.json + board.jsonl
  const cliDir = makeTempDir(t, "paseo-ag-swarm-zh-");
  const parentId = "11111111-1111-4111-8111-111111111111";
  const workerA = "22222222-2222-4222-8222-222222222222";
  const workerB = "33333333-3333-4333-8333-333333333333";
  const monitorId = "44444444-4444-4444-8444-444444444444";

  const swarmPath = path.join(cliDir, "brain", parentId, ".system_generated", "swarm");
  writeJson(path.join(swarmPath, "members.json"), {
    title: "审查未推送改动并修复 P1+ 问题",
    members: {
      "audit-server-ag": { conversation_id: workerA, role: "worker", phase: "KILLED", killed: true },
      "audit-client-ag": { conversation_id: workerB, role: "worker", phase: "KILLED", killed: true },
      monitor: { conversation_id: monitorId, role: "worker", phase: "KILLED", killed: true },
    },
  });
  writeJson(path.join(swarmPath, "plan.json"), {
    tasks: {
      "audit-server-ag": "Antigravity 服务端 P0/P1 修复（待复审）",
      "audit-client-ag": "Antigravity 客户端 P1 修复（待复审）",
      monitor: "监控蜂群停滞状态",
    },
  });
  fs.writeFileSync(
    path.join(swarmPath, "board.jsonl"),
    [
      JSON.stringify({ seq: 1, agent: "coordinator", text: "@audit-server-ag 你是「Antigravity 服务端审查员」，只读审查。" }),
      JSON.stringify({ seq: 2, agent: "coordinator", text: "@audit-client-ag 请检查 client/antigravity 目录。" }),
      JSON.stringify({ seq: 3, agent: "coordinator", text: "@monitor You are this swarm's stall monitor." }),
    ].join("\n") + "\n",
  );

  for (const id of [workerA, workerB, monitorId]) {
    const log = path.join(cliDir, "brain", id, ".system_generated", "logs", "transcript.jsonl");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(
      log,
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-27T08:00:00Z" }) + "\n",
    );
  }

  const reader = new SubagentReader(
    { conversationOf: async () => ({ conversationId: parentId, closed: false }) },
    cliDir,
  );
  const listed = await reader.list({}, "agent-zh");
  const parsed = agContracts.subagentListSchema.parse(listed);
  const byRole = new Map(parsed.subagents.map((s) => [s.role, s]));
  assert.equal(byRole.get("audit-server-ag")?.displayName, "Antigravity 服务端审查员");
  assert.equal(byRole.get("audit-client-ag")?.displayName, "Antigravity 客户端 P1 修复");
  // Built-in monitor leaves displayName null so client localizes it to "监工" (zh-CN) / "monitor" (en)
  assert.equal(byRole.get("monitor")?.displayName, null);
});

test("swarm displayName helpers and SubagentReader guard against prototype-key collisions and non-string/non-CJK edge cases", async (t) => {
  // Defensive non-string handling
  for (const bad of [Object, 123, {}, [], true, null, undefined]) {
    assert.equal(agContracts.extractSwarmBriefLabel(bad), null);
    assert.equal(agContracts.cleanSwarmPlanLabel(bad), null);
  }

  // cleanSwarmPlanLabel strips trailing parens BEFORE checking CJK, matching extractSwarmBriefLabel
  assert.equal(agContracts.cleanSwarmPlanLabel("Fix bug（中文备注）"), null);
  assert.equal(agContracts.cleanSwarmPlanLabel("Fix bug (待复审)"), null);
  assert.equal(agContracts.cleanSwarmPlanLabel("Fix pure English task"), null);
  const truncated = agContracts.cleanSwarmPlanLabel("这是一个非常非常非常非常非常非常非常非常非常长的中文任务标题");
  assert.equal(truncated?.length, 28);
  assert.ok(truncated?.endsWith("…"));

  // Explicit "角色：「...」" syntax
  assert.equal(agContracts.extractSwarmBriefLabel("@worker-1 角色：「离线门禁验证员」"), "离线门禁验证员");

  // Prototype-key worker names (`constructor`, `toString`) must not collide with Object.prototype in plan.json lookup
  const cliDir = makeTempDir(t, "paseo-ag-swarm-proto-");
  const parentId = "55555555-5555-4555-8555-555555555555";
  const ctorId = "66666666-6666-4666-8666-666666666666";
  const toStrId = "77777777-7777-4777-8777-777777777777";

  const swarmPath = path.join(cliDir, "brain", parentId, ".system_generated", "swarm");
  writeJson(path.join(swarmPath, "members.json"), {
    title: "原型键回归测试",
    members: {
      constructor: { conversation_id: ctorId, role: "worker", phase: "KILLED", killed: true },
      toString: { conversation_id: toStrId, role: "worker", phase: "KILLED", killed: true },
    },
  });
  writeJson(path.join(swarmPath, "plan.json"), {
    tasks: {
      "other-worker": "其他成员任务",
    },
  });
  fs.writeFileSync(
    path.join(swarmPath, "board.jsonl"),
    [
      JSON.stringify({ seq: 1, agent: "coordinator", text: "@constructor Inspect build config." }),
      JSON.stringify({ seq: 2, agent: "coordinator", text: "@toString Inspect formatting helpers." }),
    ].join("\n") + "\n",
  );

  for (const id of [ctorId, toStrId]) {
    const log = path.join(cliDir, "brain", id, ".system_generated", "logs", "transcript.jsonl");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(
      log,
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-27T08:00:00Z" }) + "\n",
    );
  }

  const reader = new SubagentReader(
    { conversationOf: async () => ({ conversationId: parentId, closed: false }) },
    cliDir,
  );
  const listed = await reader.list({}, "agent-proto");
  const parsed = agContracts.subagentListSchema.parse(listed);
  const byRole = new Map(parsed.subagents.map((s) => [s.role, s]));
  assert.equal(byRole.get("constructor")?.role, "constructor");
  assert.equal(byRole.get("constructor")?.displayName, null);
  assert.equal(byRole.get("toString")?.role, "toString");
  assert.equal(byRole.get("toString")?.displayName, null);
});

test("Antigravity UsageSource uses dedicated antigravity-icon.svg packaged at plugin root (not DeepSeek whale icon.svg)", () => {
  const { createUsageSource } = require("../server/antigravity/usage.ts");
  const source = createUsageSource({});
  assert.equal(source.icon, "antigravity-icon.svg");

  const pluginRoot = path.resolve(__dirname, "..");
  const agyIconPath = path.join(pluginRoot, "antigravity-icon.svg");
  const dshIconPath = path.join(pluginRoot, "icon.svg");
  assert.equal(fs.existsSync(agyIconPath), true, "antigravity-icon.svg must exist at plugin root");

  const agySvg = fs.readFileSync(agyIconPath, "utf8");
  const dshSvg = fs.readFileSync(dshIconPath, "utf8");
  assert.notEqual(agySvg, dshSvg, "antigravity-icon.svg must not duplicate the DeepSeek whale icon.svg");
  assert.match(agySvg, /viewBox="8\.8 10\.5 94 94"/);
  assert.match(agySvg, /id="agy-usage-body"/);

  const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
  assert.equal(Array.isArray(pkg.files) && pkg.files.includes("antigravity-icon.svg"), true);
});

test("Antigravity update_steps model, chronological StepsStore, and tool_call transform", () => {
  const {
    parseUpdateSteps,
    summarizeSteps,
    windowSteps,
    stepsAllDoneSignature,
    extractStepsFromTimelineEntries,
    createStepsStore,
  } = require("../client/antigravity/stepsModel.ts");
  const { createAntigravityTimelineTransforms } = require("../client/antigravity/transform.ts");

  assert.equal(parseUpdateSteps(null), null);
  assert.equal(parseUpdateSteps({ steps: [] }), null);
  const parsed = parseUpdateSteps({
    steps: [
      { title: "预演合并并分析冲突", status: "done" },
      { title: "跳过旧脚本", status: "skipped" },
      { title: "检查失败项", status: "failed" },
      { title: "运行测试", status: "in_progress" },
      { title: "待推送", status: "pending" },
      { title: "   ", status: "pending" },
    ],
  });
  assert.equal(parsed?.length, 5);
  const summary = summarizeSteps(parsed);
  assert.equal(summary.total, 5);
  assert.equal(summary.done, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.inProgress.length, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.allDone, false);
  assert.equal(summary.pillState, "failed");
  assert.equal(stepsAllDoneSignature(parsed), undefined);

  const allDoneSteps = parseUpdateSteps({
    steps: [
      { title: "任务 1", status: "done" },
      { title: "任务 2", status: "skipped" },
    ],
  });
  const doneSummary = summarizeSteps(allDoneSteps);
  assert.equal(doneSummary.allDone, true);
  assert.equal(doneSummary.pillState, "complete");
  assert.equal(stepsAllDoneSignature(allDoneSteps), "done:任务 1\nskipped:任务 2");

  // Windowing focuses around the active step with at most 7 visible items
  const nineSteps = Array.from({ length: 9 }, (_, i) => ({
    title: `任务 ${i + 1}`,
    status: i < 5 ? "done" : i === 5 ? "in_progress" : "pending",
  }));
  const win = windowSteps(nineSteps, 7);
  assert.equal(win.earlier, 2);
  assert.equal(win.slice.length, 7);
  assert.equal(win.more, 0);
  assert.equal(win.slice[0].title, "任务 3");

  // StepsStore keeps chronologically newest call even if an older row remounts during scroll-up
  const store = createStepsStore();
  const events = [];
  const unsub = store.subscribe((agentId) => events.push(agentId));
  store.observe("agent-1", "call-2", [{ title: "新任务", status: "in_progress" }], 2000);
  assert.equal(store.getLatest("agent-1")?.callId, "call-2");
  assert.equal(store.isLatestCall("agent-1", "call-2"), true);
  assert.equal(events.length, 1);

  // Scroll-up remounts older call-1 (timestamp 1000) -> must NOT overwrite call-2 or notify
  store.observe("agent-1", "call-1", [{ title: "旧任务", status: "done" }], 1000);
  assert.equal(store.getLatest("agent-1")?.callId, "call-2");
  assert.equal(store.isLatestCall("agent-1", "call-1"), false);
  assert.equal(events.length, 1);

  // Updating call-2 in place publishes the new steps
  store.observe("agent-1", "call-2", [{ title: "新任务", status: "done" }], 2000);
  assert.equal(store.getLatest("agent-1")?.steps[0]?.status, "done");
  assert.equal(events.length, 2);
  unsub();

  // transformToolCall maps update_steps to antigravity-steps and validates against stepsCardSchema
  const transforms = createAntigravityTimelineTransforms();
  const tx = transforms.transformToolCall({
    type: "tool_call",
    callId: "call-steps-1",
    name: "update_steps",
    status: "completed",
    detail: {
      type: "unknown",
      input: {
        steps: [
          { title: "预演合并并分析冲突", status: "done" },
          { title: "验证代码检查与相关测试", status: "in_progress" },
        ],
      },
      output: "OK",
    },
  });
  assert.equal(tx?.items.length, 1);
  assert.equal(tx?.items[0].kind, agContracts.STEPS_TIMELINE_KIND);
  const validated = agContracts.stepsCardSchema.parse(tx.items[0].data);
  assert.equal(validated.steps.length, 2);
  assert.equal(validated.steps[1].status, "in_progress");

  // Authoritative daemon seq ordering + timeline entry extraction
  const extracted = extractStepsFromTimelineEntries([
    {
      seq: 10,
      timestamp: "2026-11-28T03:41:27.000Z",
      item: {
        type: "tool_call",
        callId: "c-early",
        name: "update_steps",
        status: "completed",
        detail: { type: "unknown", input: { steps: [{ title: "任务 1", status: "in_progress" }] } },
      },
    },
    {
      seq: 42,
      timestamp: "2026-11-28T03:41:27.000Z",
      item: {
        type: "tool_call",
        callId: "c-final",
        name: "update_steps",
        status: "completed",
        detail: { type: "unknown", input: { steps: [{ title: "任务 1", status: "done" }] } },
      },
    },
  ]);
  assert.equal(extracted.length, 2);
  const seqStore = createStepsStore();
  // Even if c-final arrives first and c-early arrives later with identical timestamp, higher seq wins
  seqStore.observe("agent-seq", extracted[1].callId, extracted[1].steps, extracted[1].timestampMs, extracted[1].seq);
  seqStore.observe("agent-seq", extracted[0].callId, extracted[0].steps, extracted[0].timestampMs, extracted[0].seq);
  assert.equal(seqStore.getLatest("agent-seq")?.callId, "c-final");
  assert.equal(seqStore.getLatest("agent-seq")?.steps[0]?.status, "done");
});

test("extractGeminiQuota returns only Gemini 5h and weekly active buckets", () => {
  const { extractGeminiQuota } = require("../client/antigravity/accountQuota.ts");

  assert.equal(extractGeminiQuota(null), null);
  assert.equal(extractGeminiQuota([]), null);
  // Non-Gemini groups (e.g. Claude/GPT or Argon) must NOT be returned
  assert.equal(
    extractGeminiQuota([
      {
        name: "Claude and GPT models",
        buckets: [
          { id: "c5", name: "5h", window: "5h", remainingFraction: 0.9, resetTime: null, disabled: false },
          { id: "cw", name: "weekly", window: "weekly", remainingFraction: 0.7, resetTime: null, disabled: false },
        ],
      },
      {
        name: "Gemini Argon",
        buckets: [
          { id: "a5", name: "5h", window: "5h", remainingFraction: 0.5, resetTime: null, disabled: false },
        ],
      },
    ]),
    null,
  );

  // Picks Gemini 5h and weekly while skipping disabled buckets
  const res = extractGeminiQuota([
    {
      name: "Claude and GPT models",
      buckets: [{ id: "c5", name: "5h", window: "5h", remainingFraction: 0.1, resetTime: null, disabled: false }],
    },
    {
      name: "Gemini models",
      buckets: [
        { id: "g5-off", name: "5h", window: "5h", remainingFraction: 0.2, resetTime: null, disabled: true },
        { id: "g5", name: "5h", window: "5h", remainingFraction: 0.82, resetTime: null, disabled: false },
        { id: "gw", name: "weekly", window: "weekly", remainingFraction: 0.64, resetTime: null, disabled: false },
      ],
    },
  ]);
  assert.equal(res?.fiveHour?.id, "g5");
  assert.equal(res?.fiveHour?.remainingFraction, 0.82);
  assert.equal(res?.weekly?.id, "gw");
  assert.equal(res?.weekly?.remainingFraction, 0.64);
});

test("subagentsArchive persists non-destructively, never hides running workers, bounds size, and updates effective counts", async () => {
  const { SUBAGENTS_ARCHIVED_METADATA_KEY } = require("../shared/pill-metadata.ts");
  const {
    MAX_ARCHIVED_SUBAGENT_IDS,
    archivedSubagentsFromMetadata,
    archiveSubagentIds,
    createSubagentsArchiveStore,
    effectiveSubagentCount,
    isSubagentArchived,
    partitionSubagents,
    serializeArchivedSubagents,
    unarchiveSubagentId,
  } = require("../client/antigravity/subagentsArchive.ts");

  // Parsing untrusted metadata
  assert.equal(archivedSubagentsFromMetadata(null).size, 0);
  assert.equal(archivedSubagentsFromMetadata({ [SUBAGENTS_ARCHIVED_METADATA_KEY]: 123 }).size, 0);
  assert.deepEqual(
    [...archivedSubagentsFromMetadata({ [SUBAGENTS_ARCHIVED_METADATA_KEY]: " a1 , a2, , a1 " })],
    ["a1", "a2"],
  );

  // Deduplication and bounding to latest MAX_ARCHIVED_SUBAGENT_IDS
  const many = Array.from({ length: MAX_ARCHIVED_SUBAGENT_IDS + 5 }, (_, i) => `id-${i}`);
  const serialized = serializeArchivedSubagents(many);
  const parts = serialized.split(",");
  assert.equal(parts.length, MAX_ARCHIVED_SUBAGENT_IDS);
  assert.equal(parts[0], "id-5");
  assert.equal(parts[parts.length - 1], `id-${MAX_ARCHIVED_SUBAGENT_IDS + 4}`);

  // Running subagents/swarm workers are never treated as archived
  const archivedSet = new Set(["s-run", "s-done", "s-fail"]);
  assert.equal(isSubagentArchived({ id: "s-run", state: "running" }, archivedSet), false);
  assert.equal(isSubagentArchived({ id: "s-done", state: "done" }, archivedSet), true);
  assert.equal(isSubagentArchived({ id: "s-fail", state: "failed" }, archivedSet), true);

  const parted = partitionSubagents(
    [
      { id: "s-run", state: "running" },
      { id: "s-done", state: "done" },
      { id: "s-fail", state: "failed" },
      { id: "s-keep", state: "done" },
    ],
    archivedSet,
  );
  assert.deepEqual(parted.live.map((s) => s.id), ["s-run"]);
  assert.deepEqual(parted.settled.map((s) => s.id), ["s-keep"]);
  assert.deepEqual(parted.archivedList.map((s) => s.id), ["s-done", "s-fail"]);

  // Effective pill counts hide archived settled/failed items and drop to 0 when all settled are archived
  assert.deepEqual(
    effectiveSubagentCount(
      { total: 3, running: 0, failed: 1, settledIds: ["s-done", "s-fail", "s-keep"], failedIds: ["s-fail"] },
      new Set(["s-done", "s-fail"]),
    ),
    { total: 1, running: 0, failed: 0 },
  );
  assert.deepEqual(
    effectiveSubagentCount(
      { total: 2, running: 0, failed: 1, settledIds: ["s-done", "s-fail"], failedIds: ["s-fail"] },
      new Set(["s-done", "s-fail"]),
    ),
    { total: 0, running: 0, failed: 0 },
  );
  // Running items keep pill visible even if settled are all archived
  assert.deepEqual(
    effectiveSubagentCount(
      { total: 2, running: 1, failed: 0, settledIds: ["s-done"], failedIds: [] },
      new Set(["s-done"]),
    ),
    { total: 1, running: 1, failed: 0 },
  );

  // Store optimistic archive/unarchive + remote observe without clobbering optimistic state
  const writes = [];
  const store = createSubagentsArchiveStore({
    write: async (agentId, raw) => {
      writes.push({ agentId, raw });
    },
  });
  let notifications = 0;
  const unsub = store.subscribe(() => {
    notifications += 1;
  });
  store.observe("ag-1", { [SUBAGENTS_ARCHIVED_METADATA_KEY]: "old-1" });
  assert.deepEqual([...store.get("ag-1")], ["old-1"]);

  const afterArchive = store.archive("ag-1", ["old-2", "old-3"]);
  assert.equal(afterArchive, "old-1,old-2,old-3");
  assert.deepEqual([...store.get("ag-1")], ["old-1", "old-2", "old-3"]);

  // Stale snapshot repeating last remote value must not overwrite optimistic state
  assert.equal(store.observe("ag-1", { [SUBAGENTS_ARCHIVED_METADATA_KEY]: "old-1" }), false);
  assert.deepEqual([...store.get("ag-1")], ["old-1", "old-2", "old-3"]);

  const afterUnarchive = store.unarchive("ag-1", "old-2");
  assert.equal(afterUnarchive, "old-1,old-3");
  assert.deepEqual([...store.get("ag-1")], ["old-1", "old-3"]);

  await Promise.resolve();
  assert.deepEqual(writes, [
    { agentId: "ag-1", raw: "old-1,old-2,old-3" },
    { agentId: "ag-1", raw: "old-1,old-3" },
  ]);
  assert.ok(notifications >= 3);
  unsub();

  // Direct pure helpers
  assert.equal(archiveSubagentIds(new Set(["a"]), ["b", "a"]), "b,a");
  assert.equal(unarchiveSubagentId(new Set(["a", "b"]), "a"), "b");
});
