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
  needsChineseTranslation,
  splitStreamingThinkingSegments,
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
        const prev = inst.states[idx];
        const value = typeof next === "function" ? next(prev) : next;
        inst.states[idx] = value;
        if (inst.autoRerender && !inst.unmounted && !Object.is(prev, value) && !inst.scheduled) {
          inst.scheduled = true;
          queueMicrotask(() => {
            inst.scheduled = false;
            if (!inst.unmounted) inst.render();
          });
        }
      };
      return [inst.states[idx], setState];
    },
    useRef(init) {
      const inst = activeInst;
      const idx = inst.cursor++;
      if (!(idx in inst.refs)) {
        inst.refs[idx] = { current: init };
      }
      return inst.refs[idx];
    },
    useMemo(fn, deps) {
      const inst = activeInst;
      const idx = inst.cursor++;
      const prev = inst.memos[idx];
      const changed =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        const value = fn();
        inst.memos[idx] = { deps, value };
        return value;
      }
      return prev.value;
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
  function mount(renderFn, { autoRerender = false } = {}) {
    const inst = {
      cursor: 0,
      states: [],
      refs: [],
      memos: [],
      effects: [],
      pendingEffects: [],
      lastResult: undefined,
      autoRerender,
      scheduled: false,
      unmounted: false,
      render: null,
    };
    const render = () => {
      if (inst.unmounted) return inst.lastResult;
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
    inst.render = render;
    const unmount = () => {
      inst.unmounted = true;
      for (const eff of inst.effects) eff?.cleanup?.();
      inst.effects = [];
    };
    render();
    return { render, unmount, current: () => inst.lastResult };
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
    /No DSH translation endpoint configured/,
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
      "      primary:",
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

test("shared/translate-text.ts preserves trailing unclosed code fences as isCode and excludes them from needsChineseTranslation", () => {
  // 1. Trailing opening fence line without body must not be dropped.
  const openFenceOnly = "Inspecting module layout\n```ts";
  const segs1 = splitStreamingThinkingSegments(openFenceOnly, "streaming");
  assert.equal(segs1.length, 2);
  assert.deepEqual(segs1[0], { text: "Inspecting module layout", sep: "\n", closed: true });
  assert.deepEqual(segs1[1], { text: "```ts", sep: "", closed: false, isCode: true });
  assert.equal(segs1.map((s) => s.text + s.sep).join(""), openFenceOnly);

  // 2. Trailing unclosed fence with newline or body preserves exact text and marks isCode: true.
  const openFenceBody = "Checking snippet\n```ts\nconst answer = computeTotal();";
  const segs2Streaming = splitStreamingThinkingSegments(openFenceBody, "streaming");
  assert.equal(segs2Streaming.length, 2);
  assert.equal(segs2Streaming[1].isCode, true);
  assert.equal(segs2Streaming[1].closed, false);
  assert.equal(segs2Streaming[1].text, "```ts\nconst answer = computeTotal();");
  assert.equal(segs2Streaming.map((s) => s.text + s.sep).join(""), openFenceBody);

  const segs2Complete = splitStreamingThinkingSegments(openFenceBody, "complete");
  assert.equal(segs2Complete[1].isCode, true);
  assert.equal(segs2Complete[1].closed, true);

  const trailingNewlineFence = "Header line\n```bash\n";
  const segs3 = splitStreamingThinkingSegments(trailingNewlineFence, "streaming");
  assert.equal(segs3.length, 2);
  assert.equal(segs3[1].isCode, true);
  assert.equal(segs3[1].text, "```bash\n");
  assert.equal(segs3.map((s) => s.text + s.sep).join(""), trailingNewlineFence);

  // 3. needsChineseTranslation strips trailing unclosed fenced code blocks cleanly.
  assert.equal(
    needsChineseTranslation("```ts\nfunction evaluateLongEnglishIdentifierName() { return true; }"),
    false,
    "unclosed fenced code block alone must never be sent for translation",
  );
  assert.equal(
    needsChineseTranslation("中文说明：\n```ts\nconst englishVariableName = calculateSomething();"),
    false,
    "Chinese prose followed by unclosed code fence must not trigger translation",
  );
  assert.equal(
    needsChineseTranslation("Evaluating the outer English explanation before code.\n```ts\nconst x = 1;"),
    true,
    "English prose outside the unclosed fence still qualifies for translation",
  );
});

test("client/thinking-translate.ts useStreamingTranslatedThinking preserves failed segments & leading spaces on complete, keeps in-flight liveTail across token growth, and resets on rowKey switch", async (t) => {
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

  // Scenario A: Partial segment failure on complete must fall back verbatim (no dropped segment) and keep leading spaces.
  const seg1 = "  First indented thought line that translates.";
  const seg2 = "  Second indented thought line that fails.";
  const fullTwoLines = `${seg1}\n${seg2}`;
  const unregisterA = mod.registerThinkingTranslator(async (text) => {
    if (text.includes("Second indented")) throw new Error("transient failure");
    return "第一条缩进思考译文。";
  });
  t.after(() => unregisterA());

  let phaseA = "streaming";
  let textA = `${seg1}\n`;
  const hA = mount(() => mod.useStreamingTranslatedThinking(textA, phaseA, true, "row-partial"), {
    autoRerender: true,
  });
  t.after(() => hA.unmount());

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hA.current().translated, "  第一条缩进思考译文。\n");

  // Transition to complete with second indented line that fails into cooldown.
  textA = fullTwoLines;
  phaseA = "complete";
  hA.render();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(
    hA.current().translated,
    "  第一条缩进思考译文。\n  Second indented thought line that fails.",
    "completed thought must never drop failed segment and must preserve leading spaces on both translated and fallback segments",
  );
  hA.unmount();
  unregisterA();

  // Scenario B: Growing the same liveTail sentence must NOT cancel the in-flight RPC, and must follow up with the newer tail.
  const pendingCalls = [];
  const unregisterB = mod.registerThinkingTranslator(
    (text) =>
      new Promise((resolve) => {
        pendingCalls.push({ text, resolve });
      }),
  );
  t.after(() => unregisterB());

  let textB = "Checking streaming tail prefix";
  let phaseB = "streaming";
  let rowKeyB = "row-live-1";
  const hB = mount(() => mod.useStreamingTranslatedThinking(textB, phaseB, true, rowKeyB), {
    autoRerender: true,
  });
  t.after(() => hB.unmount());

  // Wait past initial 40ms live-tail delay so first RPC is in flight.
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(pendingCalls.length, 1);
  assert.equal(pendingCalls[0].text, "Checking streaming tail prefix");

  // Grow the SAME sentence while the first RPC is still in flight.
  textB = "Checking streaming tail prefix with more tokens";
  hB.render();

  // Resolve the first in-flight RPC: result must NOT be discarded by effect cleanup.
  pendingCalls[0].resolve("正在检查流式尾部前缀");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(hB.current().translated, "正在检查流式尾部前缀");

  // Follow-up tail RPC is scheduled automatically from `finally` for the longer text.
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(pendingCalls.length, 2, "finally must schedule follow-up translation for newly arrived tail tokens");
  assert.equal(pendingCalls[1].text, "Checking streaming tail prefix with more tokens");
  pendingCalls[1].resolve("正在检查包含更多令牌的流式尾部前缀");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(hB.current().translated, "正在检查包含更多令牌的流式尾部前缀");

  // Scenario C: Switching rowKey immediately isolates/resets transient liveTail state on the very first frame.
  rowKeyB = "row-live-2";
  textB = "Fresh";
  phaseB = "streaming";
  const afterSwitch = hB.render();
  assert.equal(afterSwitch.translated, "", "switching rowKey must not leak previous row's liveTail translation");
  assert.equal(afterSwitch.pending, true, "new short English streaming row starts in pending placeholder state");

  hB.unmount();
  unregisterB();

  // Scenario D: Fast burst where sentence 2 finishes translating before sentence 1 must hold
  // strict in-order prefix output (no out-of-order insertion flash) and suppress liveTail RPCs
  // while earlier closed sentences are still queued.
  const burstCalls = [];
  const unregisterD = mod.registerThinkingTranslator(
    (text) =>
      new Promise((resolve) => {
        burstCalls.push({ text, resolve });
      }),
  );
  t.after(() => unregisterD());

  const fastBurst =
    "First longer sentence that takes a bit more time to translate.\n" +
    "Second quick sentence.\n" +
    "Third unclosed trailing clause still streaming quickly without punctuation yet";
  const hD = mount(
    () => mod.useStreamingTranslatedThinking(fastBurst, "streaming", true, "row-fast-burst"),
    { autoRerender: true },
  );
  t.after(() => hD.unmount());

  // Wait past live-tail delay: only the 2 closed sentences should be dispatched (liveTail yields!).
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(burstCalls.length, 2, "must not waste RPC concurrency on liveTail while closed sentences are pending");

  // Resolve sentence 2 BEFORE sentence 1: output must stay pending (never jump ahead with sentence 2 alone).
  burstCalls[1].resolve("第二句快译文。");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(hD.current().translated, "", "must hold sentence 2 behind unresolved sentence 1 to prevent rewrite flash");
  assert.equal(hD.current().pending, true);

  // Now resolve sentence 1: both sentence 1 and cached sentence 2 append cleanly in exact order!
  burstCalls[0].resolve("第一句较长译文。");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(hD.current().pending, false);
  assert.equal(hD.current().translated, "第一句较长译文。\n第二句快译文。…");

  hD.unmount();
  unregisterD();
});

test("ThinkingTranslator translates long DSH texts in parallel chunks and retries transient HTTP 502 once", async (t) => {
  const { ThinkingTranslator } = require("../server/translate.ts");
  const dir = makeTempDir(t, "paseo-dsh-parallel-");
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
      "        apiKeyEnv: TEST_PARALLEL_KEY",
      "        baseURL: https://example.test/v1",
      "        models:",
      "          - id: fast-model",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, ".credentials.yaml"), 'TEST_PARALLEL_KEY: "dummy-token"\n');

  let active = 0;
  let maxActive = 0;
  let transient502Remaining = 1;
  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const userText = body.messages[1].content;
    if (userText.includes("Transient 502 probe") && transient502Remaining > 0) {
      transient502Remaining -= 1;
      return { ok: false, status: 502, json: async () => ({}) };
    }
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    active -= 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ finish_reason: "stop", message: { content: `译:${userText.slice(0, 12)}` } }],
      }),
    };
  };

  const translator = new ThinkingTranslator({
    cacheFile: path.join(dir, "cache.json"),
    fetchImpl: mockFetch,
    dshHomeDir: dir,
    profile: "paseo",
    allowPublicFallback: false,
  });
  t.after(() => translator.dispose());

  // 1. Transient HTTP 502 self-heals on single retry
  const retried = await translator.translate("Transient 502 probe sentence for retry check.", "zh-CN");
  assert.equal(retried.provider, "dsh");
  assert.equal(transient502Remaining, 0);

  // 2. Long text (>1600 chars) splits and executes chunks concurrently while preserving paragraph order
  const p1 = "Paragraph one. " + "Alpha testing parallel translation throughput. ".repeat(18);
  const p2 = "Paragraph two. " + "Beta verifying chunk order preservation cleanly. ".repeat(18);
  const p3 = "Paragraph three. " + "Gamma confirming bounded concurrency execution. ".repeat(18);
  const longResult = await translator.translate(`${p1}\n\n${p2}\n\n${p3}`, "zh-CN");
  assert.equal(longResult.provider, "dsh");
  assert.ok(maxActive >= 2, `expected concurrent chunk execution, got maxActive=${maxActive}`);
  assert.equal(longResult.translated, "译:Paragraph on\n\n译:Paragraph tw\n\n译:Paragraph th");
});

test("client/thinking-translate.ts progressively renders long settled thoughts paragraph-by-paragraph and supports prefetchThinkingTranslation", async (t) => {
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

  const resolvers = [];
  const unregister = mod.registerThinkingTranslator(
    (text) =>
      new Promise((resolve) => {
        resolvers.push({ text, resolve });
      }),
  );
  t.after(() => unregister());

  const p1 = "Paragraph alpha. " + "Inspecting progressive translation rendering behavior. ".repeat(12);
  const p2 = "Paragraph beta. " + "Confirming second paragraph arrives smoothly afterward. ".repeat(12);
  const longSettled = `${p1}\n\n${p2}`;

  const h = mount(() => mod.useStreamingTranslatedThinking(longSettled, "complete", true, "row-long-settled"), {
    autoRerender: true,
  });
  t.after(() => h.unmount());

  // Both paragraph chunks are dispatched concurrently on mount.
  assert.equal(resolvers.length, 2);
  assert.equal(h.current().pending, true);

  // Resolving paragraph 1 immediately renders Chinese + trailing ellipsis while paragraph 2 is still in flight.
  resolvers[0].resolve("第一段长思考译文。");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(h.current().pending, false);
  assert.equal(h.current().translated, "第一段长思考译文。…");

  // Resolving paragraph 2 completes the full translation with exact paragraph spacing.
  resolvers[1].resolve("第二段长思考译文。");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(h.current().translated, "第一段长思考译文。\n\n第二段长思考译文。");

  // prefetchThinkingTranslation warms cache for short settled thought before mount.
  mod.prefetchThinkingTranslation("Short thought prefetched on hover before click.");
  assert.equal(resolvers.length, 3);
  resolvers[2].resolve("悬停预取的短思考译文。");
  await new Promise((r) => setTimeout(r, 15));

  const h2 = mount(
    () =>
      mod.useStreamingTranslatedThinking(
        "Short thought prefetched on hover before click.",
        "complete",
        true,
        "row-prefetched",
      ),
    { autoRerender: true },
  );
  t.after(() => h2.unmount());
  assert.equal(h2.current().pending, false);
  assert.equal(h2.current().translated, "悬停预取的短思考译文。");
  assert.equal(resolvers.length, 3, "mounted row must hit prefetched cache synchronously with zero extra RPC");
});

test("client/thinking-text.ts left-scroll stream normalizer and adaptive cursor pace both DSH and Antigravity identically", () => {
  const {
    advanceLeftScrollCursor,
    normalizeLeftScrollStream,
    streamingTail,
  } = require("../client/thinking-text.ts");

  assert.equal(
    normalizeLeftScrollStream("**先检查**第一段。\n\n再检查第二段…"),
    "先检查第一段。 再检查第二段",
  );

  // Small backlog advances at calm readable pace (~14 chars/sec -> ~0.7 char per 50ms)
  const step1 = advanceLeftScrollCursor(0, 10, 50);
  assert.ok(step1 > 0.5 && step1 < 1.0, `expected calm pace ~0.7 char per 50ms, got ${step1}`);

  // Large backlog accelerates gently, strictly capped at <=1 char/frame
  const burstStep = advanceLeftScrollCursor(0, 100, 32);
  assert.ok(burstStep > 0.5 && burstStep <= 1.0, `expected gentle <=1 char step, got ${burstStep}`);

  // Clamps huge dtMs (background tab resume) and never skips more than 1 char in a single frame
  assert.ok(advanceLeftScrollCursor(0, 200, 5000) <= 1.0, "single frame step must stay <=1 char so text stays readable");

  // Sub-pixel GPU marquee velocity advances smoothly by a few pixels per 60fps frame
  const {
    advanceSmoothPixelOffset,
    computeSmoothMarqueeDurationMs,
    splitNativeMarqueeChunks,
  } = require("../client/thinking-text.ts");
  const { isLikelyStartingEnglish } = require("../shared/translate-text.ts");
  const px1 = advanceSmoothPixelOffset(0, 100, 16);
  assert.ok(px1 > 2.0 && px1 < 4.5, `expected ~2.5-3.5px per 60fps frame, got ${px1}`);
  const pxBurst = advanceSmoothPixelOffset(0, 2000, 16);
  assert.ok(pxBurst > px1 && pxBurst <= 5.0, `expected capped <=5px per 60fps frame, got ${pxBurst}`);
  assert.equal(advanceSmoothPixelOffset(200, 150, 16), 150);
  assert.equal(advanceLeftScrollCursor(10, 10, 50), 10);
  assert.equal(advanceLeftScrollCursor(25, 10, 50), 10);

  // Native iOS/Android marquee duration matches the exact same calm velocity curve
  assert.equal(computeSmoothMarqueeDurationMs(0), 0);
  const shortDur = computeSmoothMarqueeDurationMs(145);
  assert.ok(shortDur > 600 && shortDur <= 1050, `expected ~740ms for 145px, got ${shortDur}`);
  const longDur = computeSmoothMarqueeDurationMs(3000);
  assert.equal(longDur, 10000, "large backlog caps cleanly at 300px/sec (3000px -> 10s)");

  // Code-point-safe chunk splitting never splits surrogate-pair emoji
  const emojiStream = "🚀".repeat(25) + "测试";
  const chunks = splitNativeMarqueeChunks(emojiStream, 24);
  assert.equal(chunks.length, 2);
  assert.equal(Array.from(chunks[0]).length, 24);
  assert.equal(chunks[1], "🚀测试");

  // isLikelyStartingEnglish catches real English starts without false-triggering on DSH code/symbols
  assert.equal(isLikelyStartingEnglish("The"), true);
  assert.equal(isLikelyStartingEnglish("Let's check"), true);
  assert.equal(isLikelyStartingEnglish("I need"), true);
  assert.equal(isLikelyStartingEnglish("Analyzing"), true);
  assert.equal(isLikelyStartingEnglish("DSH"), false);
  assert.equal(isLikelyStartingEnglish("iOS"), false);
  assert.equal(isLikelyStartingEnglish("inline-thinking.tsx"), false);
  assert.equal(isLikelyStartingEnglish("`useGrowing`"), false);
  assert.equal(isLikelyStartingEnglish("/home/user/project"), false);
  assert.equal(isLikelyStartingEnglish("useNativeDriver"), false);
  assert.equal(isLikelyStartingEnglish("foo_bar"), false);
  assert.equal(isLikelyStartingEnglish("DSH 的思考"), false);

  // Advancing 1 char at a time shifts streamingTail smoothly leftward once width is filled
  const zhStream = "正在检查为什么子智能体胶囊动画在初始挂载时延迟并核对后端轮询状态。";
  const chars = Array.from(zhStream);
  const w1 = streamingTail(chars.slice(0, 22).join(""), 180, 13);
  const w2 = streamingTail(chars.slice(0, 23).join(""), 180, 13);
  assert.notEqual(w1, w2);
  assert.ok(w1.endsWith("…") && w2.endsWith("…"));
  assert.equal(w2.slice(-2, -1), chars[22], "newest character enters at the right edge as older chars scroll left");

  // Expanded thinking body ink-bloom helpers: code-point counting, calm wave cursor, and paragraph freeze split
  const {
    EXPANDED_BLOOM_WAVE_WIDTH,
    advanceExpandedInkCursor,
    buildExpandedBloomSegments,
    countCodePoints,
    findSettledBodySplit,
  } = require("../client/thinking-text.ts");
  assert.equal(countCodePoints("你好🚀world"), 8);
  const ink1 = advanceExpandedInkCursor(0, 30, 16, EXPANDED_BLOOM_WAVE_WIDTH);
  assert.ok(ink1 > 0.2 && ink1 < 0.8, `expected slow front-emergence advance per 60fps frame, got ${ink1}`);
  const inkBurst = advanceExpandedInkCursor(0, 500, 16, EXPANDED_BLOOM_WAVE_WIDTH);
  assert.ok(inkBurst > ink1 && inkBurst <= 0.8, `expected calm capped <=0.8 chars/frame under burst, got ${inkBurst}`);
  const inkSettle = advanceExpandedInkCursor(30, 30, 40, EXPANDED_BLOOM_WAVE_WIDTH);
  assert.ok(inkSettle > 30 && inkSettle < 30 + EXPANDED_BLOOM_WAVE_WIDTH);

  // buildExpandedBloomSegments pre-places lookahead at alpha=0 and fades smoothly from front half
  const bloomMid = buildExpandedBloomSegments("已定格内容接下来缓慢浮现出来", 9, 24, 5, 48);
  assert.equal(bloomMid[0].text, "已定格内容");
  assert.equal(bloomMid[0].alpha, 1);
  const fadingAlphas = bloomMid.filter((s) => s.alpha > 0 && s.alpha < 1).map((s) => s.alpha);
  assert.ok(fadingAlphas.length >= 3, "front half emerges gradually across multiple soft alpha steps");
  assert.ok(fadingAlphas[0] > fadingAlphas[fadingAlphas.length - 1], "alpha decreases smoothly front-to-back");
  const tailSeg = bloomMid[bloomMid.length - 1];
  assert.equal(tailSeg.alpha, 0, "un-emerged tail stays pre-placed invisibly at alpha=0");
  assert.equal(bloomMid.map((s) => s.text).join(""), "已定格内容接下来缓慢浮现出来");

  const splitBlank = findSettledBodySplit("第一段内容\n\n第二段新内容", 8);
  assert.deepEqual(splitBlank, {
    frozenDelta: "第一段内容",
    nextActiveStart: 7,
    consumedCodePoints: 7,
    gapLines: 1,
  });
  const splitSingle = findSettledBodySplit("第一行\r\n第二行正在输入", 6);
  assert.deepEqual(splitSingle, {
    frozenDelta: "第一行",
    nextActiveStart: 5,
    consumedCodePoints: 5,
    gapLines: 0,
  });
  assert.equal(findSettledBodySplit("第一行\n\n", 10), null, "never split when nothing follows the newline");
  assert.equal(findSettledBodySplit("无换行短句", 3), null);

  // settledFloor keeps already-settled prefix at opacity 1 while newly appended chars bloom from char 0
  const { buildInkTrailSegments } = require("../client/stream-reveal.ts");
  const segsFrame0 = buildInkTrailSegments("已定格内容新增", 5, 5.5, 5);
  assert.deepEqual(segsFrame0, [{ text: "已定格内容", opacity: 1, highlight: 0 }]);
  const segsFrame1 = buildInkTrailSegments("已定格内容新增", 6.2, 5.5, 5);
  assert.equal(segsFrame1[0].text, "已定格内容");
  assert.equal(segsFrame1[0].opacity, 1);
  assert.equal(segsFrame1[1].text, "新");
  assert.ok(segsFrame1[1].opacity < 0.5 && segsFrame1[1].highlight === 2);

  // Global assistant Markdown block splitter preserves fenced code blocks, Setext headings,
  // list-to-paragraph transitions, and skips standalone images
  const {
    ACTIVE_BLOCK_THROTTLE_MS,
    isStandaloneMarkdownImage,
    shouldFlushActiveBlockImmediately,
    shouldMergeToUnifiedMarkdown,
    shouldStartAssistantBloomFromZero,
    splitAssistantMarkdownBlocks,
    splitStableMarkdownBlocks,
  } = require("../client/thinking-text.ts");
  assert.equal(isStandaloneMarkdownImage("![preview](file:///tmp/a.png)"), true);
  assert.equal(isStandaloneMarkdownImage("说明文字\n![preview](file:///tmp/a.png)"), false);
  const mdBlocks = splitAssistantMarkdownBlocks(
    "第一段正文。\n\n### 标题\n- 列表1\n- 列表2\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n最后一段",
  );
  assert.deepEqual(mdBlocks, [
    "第一段正文。",
    "### 标题",
    "- 列表1\n- 列表2",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    "最后一段",
  ]);
  // Unclosed streaming code fence stays intact as one single block
  const unclosedFence = splitAssistantMarkdownBlocks("开场\n\n```py\nx = 1\n\ny = 2");
  assert.deepEqual(unclosedFence, ["开场", "```py\nx = 1\n\ny = 2"]);
  // Paragraph followed immediately by list/hr splits cleanly into separate blocks
  assert.deepEqual(
    splitAssistantMarkdownBlocks("导语\n- 要点一\n- 要点二\n---\n尾声"),
    ["导语", "- 要点一\n- 要点二", "---", "尾声"],
  );
  // List followed immediately by an unindented paragraph splits cleanly while indented continuation stays in list
  assert.deepEqual(
    splitAssistantMarkdownBlocks("- 第一项\n  缩进续行\n- 第二项\n紧跟普通段落"),
    ["- 第一项\n  缩进续行\n- 第二项", "紧跟普通段落"],
  );
  // Setext heading underline directly below a plain paragraph is preserved as one block, not split as <hr>
  assert.deepEqual(
    splitAssistantMarkdownBlocks("二级标题\n---\n后续正文"),
    ["二级标题\n---", "后续正文"],
  );
  assert.deepEqual(
    splitAssistantMarkdownBlocks("一级标题\n===\n后续正文"),
    ["一级标题\n===", "后续正文"],
  );
  // Outer 4-backtick fence is not prematurely closed by inner 3-backtick fence
  assert.deepEqual(
    splitAssistantMarkdownBlocks("````md\n```ts\nconst x = 1;\n```\n````\n\n尾段"),
    ["````md\n```ts\nconst x = 1;\n```\n````", "尾段"],
  );
  // CommonMark §4.5: inline triple-backtick span is not a fenced code block opener
  assert.deepEqual(
    splitAssistantMarkdownBlocks("```foo```\n\n后续普通段落"),
    ["```foo```", "后续普通段落"],
  );
  assert.deepEqual(splitStableMarkdownBlocks("```foo```\n\n后续普通段落"), {
    settledBlocks: ["```foo```"],
    activeBlock: "后续普通段落",
  });
  // P1-B: 4-space indented code blocks preserve their leading indentation instead of downgrading to plain prose
  assert.deepEqual(
    splitAssistantMarkdownBlocks("说明\n\n    const x = 1;\n    const y = 2;\n\n尾段"),
    ["说明", "    const x = 1;\n    const y = 2;", "尾段"],
  );
  assert.deepEqual(
    splitStableMarkdownBlocks("说明\n\n    const x = 1;\n    const y = 2;"),
    {
      settledBlocks: ["说明"],
      activeBlock: "    const x = 1;\n    const y = 2;",
    },
  );
  // P1-B: double-buffered unified <Markdown> merge triggers only on completed, settled, multi-block replies
  assert.equal(
    shouldMergeToUnifiedMarkdown({ phase: "streaming", tailSettling: false, blockCount: 3 }),
    false,
  );
  assert.equal(
    shouldMergeToUnifiedMarkdown({ phase: "complete", tailSettling: true, blockCount: 3 }),
    false,
  );
  assert.equal(
    shouldMergeToUnifiedMarkdown({ phase: "complete", tailSettling: false, blockCount: 1 }),
    false,
    "single-block replies already render one unified <Markdown> and need no merge",
  );
  assert.equal(
    shouldMergeToUnifiedMarkdown({ phase: "complete", tailSettling: false, blockCount: 2 }),
    true,
  );

  // Stable block splitting separates frozen settledBlocks from the single trailing activeBlock
  assert.deepEqual(splitStableMarkdownBlocks(""), { settledBlocks: [], activeBlock: "" });
  assert.deepEqual(splitStableMarkdownBlocks("正在输入首段"), {
    settledBlocks: [],
    activeBlock: "正在输入首段",
  });
  assert.deepEqual(splitStableMarkdownBlocks("首段完成\n\n"), {
    settledBlocks: ["首段完成"],
    activeBlock: "",
  });
  assert.deepEqual(splitStableMarkdownBlocks("首段完成\n\n第二段流式中"), {
    settledBlocks: ["首段完成"],
    activeBlock: "第二段流式中",
  });
  // Unclosed fence ending with blank line still stays active so it is never split mid-fence
  assert.deepEqual(splitStableMarkdownBlocks("说明\n\n```ts\nconst a = 1;\n\n"), {
    settledBlocks: ["说明"],
    activeBlock: "```ts\nconst a = 1;",
  });

  // Streaming throttle boundary: immediate flush on complete / newly closed block / first non-empty text
  assert.equal(ACTIVE_BLOCK_THROTTLE_MS, 64);
  assert.equal(
    shouldFlushActiveBlockImmediately({
      prevSettledCount: 1,
      nextSettledCount: 1,
      phase: "streaming",
      hasCommittedText: true,
      nextActiveText: "继续追加 token",
    }),
    false,
    "steady streaming within the same active block honors the 64ms throttle",
  );
  assert.equal(
    shouldFlushActiveBlockImmediately({
      prevSettledCount: 1,
      nextSettledCount: 2,
      phase: "streaming",
      hasCommittedText: true,
      nextActiveText: "新块开头",
    }),
    true,
    "closing a settled block flushes immediately",
  );
  assert.equal(
    shouldFlushActiveBlockImmediately({
      prevSettledCount: 1,
      nextSettledCount: 1,
      phase: "complete",
      hasCommittedText: true,
      nextActiveText: "最终定稿",
    }),
    true,
    "phase=complete always flushes synchronously with zero dropped chars",
  );
  assert.equal(
    shouldFlushActiveBlockImmediately({
      prevSettledCount: 0,
      nextSettledCount: 0,
      phase: "streaming",
      hasCommittedText: false,
      nextActiveText: "首批文字",
    }),
    true,
    "first non-empty chunk commits immediately without waiting 64ms",
  );

  // Idle/reload guard keeps reopened conversations animation-free while allowing live bursts
  assert.equal(
    shouldStartAssistantBloomFromZero({ phase: "streaming", totalCp: 420, agentStatus: "running" }),
    true,
    "live running reply animates even on a large first burst",
  );
  assert.equal(
    shouldStartAssistantBloomFromZero({ phase: "streaming", totalCp: 420, agentStatus: "idle" }),
    false,
    "reloaded idle conversation renders settled immediately",
  );
  assert.equal(
    shouldStartAssistantBloomFromZero({ phase: "streaming", totalCp: 30, agentStatus: "initializing" }),
    false,
    "initializing reload conversation renders settled immediately",
  );
  assert.equal(
    shouldStartAssistantBloomFromZero({ phase: "complete", totalCp: 24, agentStatus: "running" }),
    false,
  );

  // Zero-flash live bloom tracker: historical replies pass through to native;
  // live replies stay permanently on one stable plugin row across complete transitions.
  const {
    MAX_LIVE_BLOOM_KEYS,
    createLiveBloomTracker,
    readLiveBloomState,
    resetLiveBloomStateForTests,
    writeLiveBloomState,
  } = require("../client/assistant-bloom-handoff.ts");
  resetLiveBloomStateForTests();
  assert.equal(MAX_LIVE_BLOOM_KEYS, 48);

  const tracker = createLiveBloomTracker({ maxKeys: 3 });
  // Historical complete message is never intercepted
  assert.deepEqual(
    tracker.resolve({ text: "Historical reply", messageId: "old-1" }, "complete"),
    { transform: false },
  );
  // Live streaming reply with messageId stays transformed permanently across complete
  const live1 = tracker.resolve({ text: "Fast reply", messageId: "m-1" }, "streaming");
  assert.deepEqual(live1, { transform: true, bloomKey: "id:m-1" });
  const complete1 = tracker.resolve({ text: "Fast reply full table", messageId: "m-1" }, "complete");
  assert.deepEqual(complete1, { transform: true, bloomKey: "id:m-1" });
  // Repeated complete re-projections remain stable on the same bloomKey (0 ID swap / 0 flash)
  assert.deepEqual(
    tracker.resolve({ text: "Fast reply full table", messageId: "m-1" }, "complete"),
    { transform: true, bloomKey: "id:m-1" },
  );

  // Fallback prefix matching when provider omits messageId (including initial empty chunk adoption)
  const emptyStart = tracker.resolve({ text: "" }, "streaming");
  assert.equal(emptyStart.transform, true);
  const grownNoId = tracker.resolve({ text: "本机健康，无需处理。" }, "streaming");
  assert.equal(grownNoId.bloomKey, emptyStart.bloomKey);
  const doneNoId = tracker.resolve({ text: "本机健康，无需处理。更多指标表格…" }, "complete");
  assert.deepEqual(doneNoId, { transform: true, bloomKey: emptyStart.bloomKey });
  // A subsequent messageId-less streaming reply sharing a short prefix with an
  // already-completed reply must get its own fresh key rather than colliding.
  const nextNoId = tracker.resolve({ text: "本机" }, "streaming");
  assert.equal(nextNoId.transform, true);
  assert.notEqual(nextNoId.bloomKey, doneNoId.bloomKey);
  // Old completed message still resolves to its own key
  assert.deepEqual(
    tracker.resolve({ text: "本机健康，无需处理。更多指标表格…" }, "complete"),
    { transform: true, bloomKey: doneNoId.bloomKey },
  );

  // Bounded LRU eviction & ghost-state resurrection guard
  writeLiveBloomState("id:m-1", {
    everStreamed: true,
    revealedBlocks: new Set([0, 1]),
  });
  assert.equal(tracker.has("id:m-1"), true);
  assert.equal(readLiveBloomState("id:m-1")?.revealedBlocks.has(1), true);
  // Add two more live keys -> maxKeys=3 evicts the least-recently-used key (`id:m-1`)
  tracker.resolve({ text: "Third reply", messageId: "m-3" }, "streaming");
  tracker.resolve({ text: "Fourth reply", messageId: "m-4" }, "streaming");
  assert.equal(tracker.size, 3);
  assert.equal(tracker.has("id:m-1"), false);
  assert.equal(readLiveBloomState("id:m-1"), undefined, "evicted key clears its in-memory state");
  // Late unmount write for an evicted key must be ignored (no ghost leak)
  writeLiveBloomState("id:m-1", {
    everStreamed: true,
    revealedBlocks: new Set([0]),
  });
  assert.equal(readLiveBloomState("id:m-1"), undefined, "evicted key cannot be resurrected by late write");

  // Re-observing a live state key preserves revealedBlocks across remount
  writeLiveBloomState("id:m-4", {
    everStreamed: true,
    revealedBlocks: new Set([0, 2]),
  });
  assert.equal(tracker.has("id:m-4"), true);
  assert.equal(readLiveBloomState("id:m-4")?.revealedBlocks.has(2), true);

  tracker.dispose();
  assert.equal(tracker.size, 0);
  assert.equal(tracker.has("id:m-4"), false);
  assert.equal(readLiveBloomState("id:m-4"), undefined);
  assert.deepEqual(
    tracker.resolve({ text: "After dispose", messageId: "m-5" }, "streaming"),
    { transform: false },
  );

  // A-7: concurrent messageId-less streaming replies on different agents never collide
  const scopedTracker = createLiveBloomTracker({ maxKeys: 8 });
  const agA1 = scopedTracker.resolve({ text: "好的" }, "streaming", "agent-a");
  const agB1 = scopedTracker.resolve({ text: "好的" }, "streaming", "agent-b");
  assert.equal(agA1.transform, true);
  assert.equal(agB1.transform, true);
  assert.notEqual(agA1.bloomKey, agB1.bloomKey);
  assert.equal(scopedTracker.has(agA1.bloomKey), true);
  assert.equal(scopedTracker.has(agB1.bloomKey), true);
  assert.deepEqual(
    scopedTracker.resolve({ text: "好的，这是 agent A 的回复" }, "complete", "agent-a"),
    { transform: true, bloomKey: agA1.bloomKey },
  );
  assert.deepEqual(
    scopedTracker.resolve({ text: "好的，这是 agent B 的回复" }, "complete", "agent-b"),
    { transform: true, bloomKey: agB1.bloomKey },
  );
  // Also accepts `item.agentId` when third arg is omitted
  const agC = scopedTracker.resolve({ text: "好的", agentId: "agent-c" }, "streaming");
  assert.notEqual(agC.bloomKey, agA1.bloomKey);
  assert.notEqual(agC.bloomKey, agB1.bloomKey);
  scopedTracker.dispose();
  assert.equal(scopedTracker.has(agA1.bloomKey), false);
  resetLiveBloomStateForTests();
});
