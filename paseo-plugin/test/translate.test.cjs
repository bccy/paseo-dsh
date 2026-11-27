require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { translateThinkingRpc } = require("../shared/translate.ts");
const {
  MAX_TRANSLATE_TEXT_LENGTH,
  splitTranslationChunks,
} = require("../shared/translate-text.ts");
const { ThinkingTranslator } = require("../server/translate.ts");

function makeTempDir(t, prefix = "paseo-translate-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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
    useEffect(fn, deps) {
      const inst = activeInst;
      const idx = inst.cursor++;
      const prev = inst.effects[idx];
      const changed =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        inst.pendingEffects.push({ idx, fn, deps, prevCleanup: prev?.cleanup });
      }
    },
  };
  function mount(renderFn) {
    const inst = { cursor: 0, states: [], effects: [], pendingEffects: [], lastResult: undefined };
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

test("shared/translate.ts translateThinkingRpc enforces strict input and output schemas", () => {
  assert.equal(translateThinkingRpc.name, "thinking.translate");
  assert.deepEqual(translateThinkingRpc.input.parse({ text: "Hello world" }), {
    text: "Hello world",
    target: "zh-CN",
  });
  assert.throws(() => translateThinkingRpc.input.parse({ text: "" }), "empty text must fail");
  assert.throws(
    () => translateThinkingRpc.input.parse({ text: "a".repeat(MAX_TRANSLATE_TEXT_LENGTH + 1) }),
    "text above 20,000 chars must fail",
  );
  assert.throws(
    () => translateThinkingRpc.input.parse({ text: "Hello", target: "ja-JP" }),
    "unsupported target locale must fail",
  );
  assert.throws(
    () => translateThinkingRpc.input.parse({ text: "Hello", extra: true }),
    "strict schema must reject unknown keys",
  );
  assert.deepEqual(
    translateThinkingRpc.output.parse({ translated: "你好", cached: false, provider: "dsh" }),
    { translated: "你好", cached: false, provider: "dsh" },
  );
});

test("shared/translate-text.ts splits sentences without lookbehind and bounds non-trailing long spaceless words", () => {
  const sentences = "First sentence ends here! Second asks why? Third finishes cleanly.";
  const plan1 = splitTranslationChunks(sentences, 30);
  assert.deepEqual(plan1.pieces, [
    "First sentence ends here!",
    "Second asks why?",
    "Third finishes cleanly.",
  ]);
  assert.ok(plan1.pieces.every((p) => p.length <= 30));

  // Non-trailing spaceless token (e.g. long URL/path) followed by normal trailing words must also be sliced <= maxLen.
  const longToken = "https://example.test/" + "segment/".repeat(25);
  const mixed = `Prefix ${longToken} trailing words after long token.`;
  const plan2 = splitTranslationChunks(mixed, 60);
  assert.ok(plan2.pieces.length >= 4);
  assert.ok(
    plan2.pieces.every((piece) => piece.length <= 60),
    `every piece must respect maxLen=60, got lengths: ${plan2.pieces.map((p) => p.length).join(",")}`,
  );
  const recombined = plan2.pieces.join("");
  assert.ok(recombined.includes("Prefix"));
  assert.ok(recombined.includes("trailing words after long token."));
});

test("ThinkingTranslator defaults to allowPublicFallback=false and never calls MyMemory when DSH is absent or fails", async (t) => {
  const prevEnv = process.env.PASEO_DSH_ALLOW_PUBLIC_TRANSLATE;
  delete process.env.PASEO_DSH_ALLOW_PUBLIC_TRANSLATE;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.PASEO_DSH_ALLOW_PUBLIC_TRANSLATE;
    else process.env.PASEO_DSH_ALLOW_PUBLIC_TRANSLATE = prevEnv;
  });

  const dir = makeTempDir(t, "paseo-no-public-fallback-");
  const calledUrls = [];
  const spyFetch = async (url) => {
    calledUrls.push(String(url));
    return { ok: false, status: 503, json: async () => ({}) };
  };

  // 1. No DSH endpoint configured -> throws without making any network request.
  const noDsh = new ThinkingTranslator({
    cacheFile: path.join(dir, "cache-1.json"),
    fetchImpl: spyFetch,
    dshHomeDir: null,
  });
  t.after(() => noDsh.dispose());
  await assert.rejects(
    () => noDsh.translate("Inspecting private workspace logic carefully.", "zh-CN"),
    /No local DSH translation endpoint configured/,
  );
  assert.deepEqual(calledUrls, [], "must not issue any HTTP request when DSH is absent and public fallback is off");

  // 2. DSH endpoint configured but fails with 503 -> throws without falling back to MyMemory.
  const patchFile = path.join(dir, "profiles", "paseo", "cordis.patch.yml");
  fs.mkdirSync(path.dirname(patchFile), { recursive: true });
  fs.writeFileSync(
    patchFile,
    [
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      local:",
      "        api: openai-completions",
      "        apiKeyEnv: TEST_LOCAL_KEY",
      "        baseURL: https://example.test/v1",
      "        models:",
      "          - id: fast-model",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, ".credentials.yaml"), 'TEST_LOCAL_KEY: "dummy-token"\n');

  const failingDsh = new ThinkingTranslator({
    cacheFile: path.join(dir, "cache-2.json"),
    fetchImpl: spyFetch,
    dshHomeDir: dir,
    profile: "paseo",
  });
  t.after(() => failingDsh.dispose());
  await assert.rejects(
    () => failingDsh.translate("Evaluating local error handling without leaking prose.", "zh-CN"),
    /DSH translation HTTP 503/,
  );
  assert.equal(calledUrls.length, 1);
  assert.equal(calledUrls[0], "https://example.test/v1/chat/completions");
  assert.equal(
    calledUrls.some((u) => u.includes("mymemory")),
    false,
    "must never fall back to MyMemory when allowPublicFallback is false",
  );
});

test("ThinkingTranslator honors PASEO_HOME for default cache path and refuses to cache finish_reason==='length' truncations", async (t) => {
  const prevPaseoHome = process.env.PASEO_HOME;
  const dir = makeTempDir(t, "paseo-translate-paseo-home-");
  const fakePaseoHome = path.join(dir, "custom-paseo-home");
  process.env.PASEO_HOME = fakePaseoHome;
  t.after(() => {
    if (prevPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevPaseoHome;
  });

  const dshDir = path.join(dir, "dsh");
  const patchFile = path.join(dshDir, "profiles", "paseo", "cordis.patch.yml");
  fs.mkdirSync(path.dirname(patchFile), { recursive: true });
  fs.writeFileSync(
    patchFile,
    [
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      local:",
      "        api: openai-completions",
      "        apiKeyEnv: TEST_LEN_KEY",
      "        baseURL: https://example.test/v1",
      "        models:",
      "          - id: fast-model",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dshDir, ".credentials.yaml"), 'TEST_LEN_KEY: "dummy-token"\n');

  let mode = "truncated";
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          finish_reason: mode === "truncated" ? "length" : "stop",
          message: { content: mode === "truncated" ? "半截被截断的译文" : "完整且未截断的译文" },
        },
      ],
    }),
  });

  const translator = new ThinkingTranslator({
    fetchImpl: mockFetch,
    dshHomeDir: dshDir,
    profile: "paseo",
  });
  t.after(() => translator.dispose());

  // 1. Truncated response must reject and never be cached in memory or on disk.
  const sample = "Single short sentence whose response gets truncated by length limit.";
  await assert.rejects(
    () => translator.translate(sample, "zh-CN"),
    /DSH translation output truncated/,
  );

  // 2. Subsequent healthy response succeeds (proving truncated output was NOT cached) and persists under PASEO_HOME.
  mode = "complete";
  const ok = await translator.translate(sample, "zh-CN");
  assert.equal(ok.cached, false);
  assert.equal(ok.translated, "完整且未截断的译文");
  await translator.flushCache();

  const expectedCache = path.join(fakePaseoHome, "plugin-data", "dsh-paseo", "thinking-translations.json");
  assert.equal(fs.existsSync(expectedCache), true, `default cache file must live under PASEO_HOME: ${expectedCache}`);
  const persisted = JSON.parse(fs.readFileSync(expectedCache, "utf8"));
  assert.deepEqual(Object.values(persisted), ["完整且未截断的译文"]);
});

test("client/thinking-translate.ts short-circuits oversized text, cools down empty/echo responses, and bounds failureCooldown", async (t) => {
  const { stub, mount } = createReactStub();
  const originalLoad = Module._load;
  const modPath = require.resolve("../client/thinking-translate.ts");
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

  const seen = [];
  let behavior = "echo";
  const unregister = mod.registerThinkingTranslator(async (text) => {
    seen.push(text);
    if (behavior === "empty") return "   ";
    if (behavior === "echo") return text;
    if (behavior === "throw") throw new Error("offline");
    return `译:${text}`;
  });
  t.after(() => unregister());

  // 1. Oversized text (> MAX_TRANSLATE_TEXT_LENGTH) short-circuits with zero RPC calls.
  const huge = "English sentence for thinking. ".repeat(700);
  assert.ok(huge.length > MAX_TRANSLATE_TEXT_LENGTH);
  const hHuge = mount(() => mod.useTranslatedThinking(huge, true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(hHuge.render(), "");
  assert.equal(seen.length, 0, "oversized text must never invoke translator RPC");
  hHuge.unmount();

  // 2. Unchanged echo response enters cooldown -> remount does not re-fire RPC.
  behavior = "echo";
  const echoText = "Echo response that returns identical English prose.";
  const hEcho1 = mount(() => mod.useTranslatedThinking(echoText, true));
  await new Promise((r) => setTimeout(r, 10));
  hEcho1.unmount();
  assert.equal(seen.length, 1);

  const hEcho2 = mount(() => mod.useTranslatedThinking(echoText, true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 1, "identical echo must enter failureCooldown and suppress immediate retry");
  hEcho2.unmount();

  // 3. Empty response also enters cooldown.
  behavior = "empty";
  const emptyText = "Empty translation result should also enter cooldown.";
  const hEmpty1 = mount(() => mod.useTranslatedThinking(emptyText, true));
  await new Promise((r) => setTimeout(r, 10));
  hEmpty1.unmount();
  assert.equal(seen.length, 2);

  const hEmpty2 = mount(() => mod.useTranslatedThinking(emptyText, true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 2, "empty translation must enter failureCooldown");
  hEmpty2.unmount();

  // 4. failureCooldown is bounded at MAX_FAILURE_COOLDOWN (200):
  //    pushing 205 distinct failing texts evicts the earliest (`echoText`) while keeping the latest cooled down.
  behavior = "throw";
  let lastFailText = "";
  for (let i = 0; i < 205; i += 1) {
    lastFailText = `Distinct failing thinking entry number ${i} for LRU eviction test.`;
    const h = mount(() => mod.useTranslatedThinking(lastFailText, true));
    h.unmount();
  }
  await new Promise((r) => setTimeout(r, 25));
  const countBeforeProbe = seen.length;

  // Latest entry is still in cooldown -> no new call.
  const hLatest = mount(() => mod.useTranslatedThinking(lastFailText, true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, countBeforeProbe, "newest failing entry must remain in cooldown");
  hLatest.unmount();

  // Earliest `echoText` was evicted beyond 200 cap -> remounting triggers a fresh call and succeeds.
  behavior = "ok";
  const hOldest = mount(() => mod.useTranslatedThinking(echoText, true));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(seen.length, countBeforeProbe + 1, "oldest cooldown entry beyond 200 cap must have been evicted");
  assert.equal(hOldest.render(), `译:${echoText}`);
  hOldest.unmount();
});
