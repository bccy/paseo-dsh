require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  CURRENCIES,
  DEFAULT_DISPLAY_CURRENCY,
  DEFAULT_USD_TO_CNY_RATE,
  MAX_RATE_PER_MILLION,
  MAX_USD_TO_CNY_RATE,
  MIN_USD_TO_CNY_RATE,
  PRICING_SCHEMA_VERSION,
  REFERENCE_PRICING,
  aggregateCallCosts,
  calculateCallCost,
  calculateNativeCost,
  convertCurrency,
  createPricingResolver,
  defaultPricingConfig,
  getReferencePricingEntry,
  matchReferenceEntry,
  modelRatesSchema,
  normalizeModelKey,
  pricingGetRpc,
  pricingUpdateInputSchema,
  pricingUpdateRpc,
  resolveModelRates,
  resolvePricingKey,
  stripProviderPrefix,
} = require("../shared/pricing.ts");

const {
  PRICING_CACHE_FILENAME,
  PricingStore,
  pricingFilePath,
  registerPricingRpc,
} = require("../server/pricing.ts");

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-dsh-pricing-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function assertApprox(actual, expected, eps = 1e-9, message) {
  assert.equal(typeof actual, "number", message ?? `expected number, got ${String(actual)}`);
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${message ?? "number mismatch"}: expected ${String(expected)}, got ${String(actual)}`,
  );
}

// ---- Reference catalog & family prefix matching -------------------------------------------

test("REFERENCE_PRICING contains only generic public model families with valid rates", () => {
  assert.ok(REFERENCE_PRICING.length >= 20);
  const allowedPrefixRoot = /^(deepseek-|claude-|gpt-|o1\b|o1-|o3\b|o3-|o4-|gemini-)/;
  const seenKeys = new Set();

  for (const entry of REFERENCE_PRICING) {
    assert.ok(!seenKeys.has(entry.key), `duplicate reference key: ${entry.key}`);
    seenKeys.add(entry.key);
    assert.ok(CURRENCIES.includes(entry.rates.currency));
    assert.doesNotThrow(() => modelRatesSchema.parse(entry.rates), `invalid rates for ${entry.key}`);
    assert.ok(entry.prefixes.length > 0, `empty prefixes for ${entry.key}`);
    for (const prefix of entry.prefixes) {
      assert.match(prefix, allowedPrefixRoot, `non-generic prefix in reference catalog: ${prefix}`);
    }
  }

  // DeepSeek uses native CNY; Claude / OpenAI / Gemini use native USD.
  assert.equal(getReferencePricingEntry("deepseek-chat")?.rates.currency, "CNY");
  assert.equal(getReferencePricingEntry("deepseek-reasoner")?.rates.currency, "CNY");
  assert.equal(getReferencePricingEntry("claude-sonnet-4")?.rates.currency, "USD");
  assert.equal(getReferencePricingEntry("gpt-4o")?.rates.currency, "USD");
  assert.equal(getReferencePricingEntry("gemini-2.5-pro")?.rates.currency, "USD");
});

test("prefix matching covers deepseek/claude/gpt/o-series/gemini with longest-prefix & boundary safety", () => {
  const cases = [
    ["deepseek-chat", "deepseek-chat"],
    ["deepseek-v3.2", "deepseek-chat"],
    ["deepseek-v3-0324", "deepseek-chat"],
    ["deepseek-reasoner", "deepseek-reasoner"],
    ["deepseek-r1-0528", "deepseek-reasoner"],
    ["claude-opus-4-6", "claude-opus-4.5"],
    ["claude-opus-4.5-20251101", "claude-opus-4.5"],
    ["claude-opus-4-20250514", "claude-opus-4"],
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4"],
    ["claude-3-7-sonnet-20250219", "claude-3.5-sonnet"],
    ["claude-3.5-sonnet", "claude-3.5-sonnet"],
    ["claude-3-5-haiku-20241022", "claude-3.5-haiku"],
    ["gpt-5.2", "gpt-5"],
    ["gpt-5-mini-2025-08-07", "gpt-5-mini"],
    ["gpt-5-nano-2025-08-07", "gpt-5-nano"],
    ["gpt-4.1-2025-04-14", "gpt-4.1"],
    ["gpt-4.1-mini-2025-04-14", "gpt-4.1-mini"],
    ["gpt-4.1-nano-2025-04-14", "gpt-4.1-nano"],
    ["gpt-4o-2024-11-20", "gpt-4o"],
    ["gpt-4o-mini-2024-07-18", "gpt-4o-mini"],
    ["o1-2024-12-17", "o1"],
    ["o1-mini-2024-09-12", "o1-mini"],
    ["o3-2025-04-16", "o3"],
    ["o3-mini-2025-01-31", "o3-mini"],
    ["o4-mini-2025-04-16", "o4-mini"],
    ["gemini-3.1-pro-preview", "gemini-3-pro"],
    ["gemini-3-flash-preview", "gemini-3-flash"],
    ["gemini-2.5-pro-preview-06-05", "gemini-2.5-pro"],
    ["gemini-2.5-flash-preview-05-20", "gemini-2.5-flash"],
    ["gemini-2.5-flash-lite-preview", "gemini-2.5-flash-lite"],
    ["gemini-2.0-flash-001", "gemini-2.0-flash"],
  ];

  for (const [model, expectedKey] of cases) {
    const matched = matchReferenceEntry(model);
    assert.equal(matched?.key, expectedKey, `model "${model}" should match "${expectedKey}"`);
  }

  // Provider prefixes, nested namespaces, case, and whitespace are normalized.
  assert.equal(stripProviderPrefix("openrouter/anthropic/claude-sonnet-4-5"), "claude-sonnet-4-5");
  assert.equal(normalizeModelKey("  DeepSeek-Chat  "), "deepseek-chat");
  assert.equal(matchReferenceEntry("deepseek/deepseek-chat")?.key, "deepseek-chat");
  assert.equal(
    matchReferenceEntry("  OpenRouter/Anthropic/Claude-Sonnet-4-5-20250929 ")?.key,
    "claude-sonnet-4",
  );
  assert.equal(matchReferenceEntry("google/gemini-2.5-pro-exp")?.key, "gemini-2.5-pro");

  // Boundary guards prevent accidental prefix collisions on unrelated models.
  for (const unmatched of [
    "",
    "   ",
    "unknown",
    "o100-custom",
    "o365-assistant",
    "gpt-500",
    "gpt-4000",
    "llama-3.3-70b-instruct",
    "qwen-2.5-coder-32b",
    "custom-vendor/private-llm-v1",
  ]) {
    assert.equal(matchReferenceEntry(unmatched), null, `model "${unmatched}" must remain unmatched`);
  }
});

// ---- Override precedence -------------------------------------------------------------------

test("resolveModelRates applies strict override precedence over built-in family references", () => {
  const familyOverride = { currency: "USD", input: 10, cached: 1, output: 30 };
  const exactOverride = { currency: "CNY", input: 50, cached: 5, output: 150 };
  const providerOverride = { currency: "CNY", input: 40, cached: 4, output: 120 };
  const customOnly = { currency: "CNY", input: 1.5, cached: 0.15, output: 4.5 };

  const overrides = {
    "Claude-Sonnet-4": familyOverride,
    "claude-sonnet-4-20250514": exactOverride,
    "proxy-a/claude-sonnet-4-20250514": providerOverride,
    "my-private-model": customOnly,
  };

  // 1. Provider + model override wins first.
  const r1 = resolveModelRates("claude-sonnet-4-20250514", overrides, "proxy-a");
  assert.equal(r1?.source, "override");
  assert.equal(r1?.pricingKey, "proxy-a/claude-sonnet-4-20250514");
  assert.deepEqual(r1?.rates, providerOverride);
  assert.equal(r1?.reference?.key, "claude-sonnet-4");

  // 2. Exact model override wins over family override.
  const r2 = resolveModelRates("claude-sonnet-4-20250514", overrides, "proxy-b");
  assert.equal(r2?.source, "override");
  assert.equal(r2?.pricingKey, "claude-sonnet-4-20250514");
  assert.deepEqual(r2?.rates, exactOverride);

  // 3. Family key override applies to another dated variant in the same family.
  const r3 = resolveModelRates("openrouter/claude-sonnet-4-5-20250929", overrides);
  assert.equal(r3?.source, "override");
  assert.equal(r3?.pricingKey, "claude-sonnet-4");
  assert.deepEqual(r3?.rates, familyOverride);

  // 4. Custom override prices an otherwise unrecognized model (including with provider prefix).
  const r4 = resolveModelRates("gateway/my-private-model", overrides);
  assert.equal(r4?.source, "override");
  assert.equal(r4?.pricingKey, "my-private-model");
  assert.deepEqual(r4?.rates, customOnly);
  assert.equal(r4?.reference, null);

  // 5. Model with no override falls back to built-in family reference.
  const r5 = resolveModelRates("gpt-4o-2024-11-20", overrides);
  assert.equal(r5?.source, "reference");
  assert.equal(r5?.pricingKey, "gpt-4o");
  assert.equal(r5?.rates.currency, "USD");

  // 6. Unrecognized model with no override resolves to null.
  assert.equal(resolveModelRates("gateway/unknown-llm", overrides), null);
  assert.equal(resolvePricingKey("gateway/unknown-llm", null, overrides), "unknown-llm");
  assert.equal(resolvePricingKey("", null, overrides), "unknown");
});

// ---- Long-context tiering & cacheWrite billing ---------------------------------------------

test("calculateNativeCost handles long-context threshold boundary and cacheWrite fallback", () => {
  const sonnet = getReferencePricingEntry("claude-sonnet-4").rates;

  // At exact threshold (100k input + 80k cached + 20k cacheWrite = 200k): standard tier.
  const atBoundary = calculateNativeCost(
    { input: 100_000, cached: 80_000, cacheWrite: 20_000, output: 10_000 },
    sonnet,
  );
  assert.equal(atBoundary.longContext, false);
  // 0.1*3 + 0.08*0.3 + 0.02*3.75 + 0.01*15 = 0.3 + 0.024 + 0.075 + 0.15 = 0.549
  assertApprox(atBoundary.cost, 0.549);

  // 1 token over threshold (200,001 prompt tokens): long-context tier applies across all buckets.
  const overBoundary = calculateNativeCost(
    { input: 100_001, cached: 80_000, cacheWrite: 20_000, output: 10_000 },
    sonnet,
  );
  assert.equal(overBoundary.longContext, true);
  // (100_001*6 + 80_000*0.6 + 20_000*7.5 + 10_000*22.5) / 1e6
  const expectedOver = (100_001 * 6 + 80_000 * 0.6 + 20_000 * 7.5 + 10_000 * 22.5) / 1_000_000;
  assertApprox(overBoundary.cost, expectedOver);

  // Gemini 2.5 Pro omits cacheWrite: cacheWrite tokens fall back to input/longInput rate.
  const gemini = getReferencePricingEntry("gemini-2.5-pro").rates;
  const gemShort = calculateNativeCost(
    { input: 50_000, cached: 50_000, cacheWrite: 10_000, output: 20_000 },
    gemini,
  );
  assert.equal(gemShort.longContext, false);
  // (50k*1.25 + 50k*0.125 + 10k*1.25 + 20k*10) / 1e6 = 0.28125
  assertApprox(gemShort.cost, 0.28125);

  const gemLong = calculateNativeCost(
    { input: 150_000, cached: 50_000, cacheWrite: 10_000, output: 20_000 },
    gemini,
  );
  assert.equal(gemLong.longContext, true);
  // (150k*2.5 + 50k*0.25 + 10k*2.5 + 20k*15) / 1e6 = 0.7125
  assertApprox(gemLong.cost, 0.7125);

  // Negative or NaN tokens sanitize to 0 instead of producing NaN or negative cost.
  const sanitized = calculateNativeCost(
    { input: -500, cached: Number.NaN, cacheWrite: Number.POSITIVE_INFINITY, output: 1000 },
    sonnet,
  );
  assertApprox(sanitized.cost, 0.015);
});

// ---- Currency conversion & mixed-currency aggregation --------------------------------------

test("convertCurrency performs exact identity and USD<->CNY conversions and rejects bad rates", () => {
  assert.equal(convertCurrency(12.345, "USD", "USD", 7.2), 12.345);
  assert.equal(convertCurrency(12.345, "CNY", "CNY", 7.2), 12.345);
  assertApprox(convertCurrency(10, "USD", "CNY", 7.2), 72);
  assertApprox(convertCurrency(72, "CNY", "USD", 7.2), 10);
  assertApprox(convertCurrency(15, "CNY", "USD", 7.5), 2);

  for (const badRate of [0, -7.2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => convertCurrency(1, "USD", "CNY", badRate), RangeError);
  }
  assert.throws(() => convertCurrency(Number.NaN, "USD", "CNY", 7.2), RangeError);
  assert.throws(() => convertCurrency(Number.POSITIVE_INFINITY, "USD", "USD", 7.2), RangeError);
});

test("mixed USD/CNY calls convert to displayCurrency and exclude unmatched models from pricedRequests", () => {
  const calls = [
    // DeepSeek Chat (CNY native): 1M input (¥2) + 1M cached (¥0.2) + 1M output (¥3) = ¥5.2
    { model: "deepseek/deepseek-chat", tokens: { input: 1_000_000, cached: 1_000_000, output: 1_000_000 } },
    // GPT-4o (USD native): 1M input ($2.5) + 0 cached + 1M output ($10) = $12.5
    { model: "openai/gpt-4o-2024-11-20", tokens: { input: 1_000_000, cached: 0, output: 1_000_000 } },
    // Unmatched model: MUST be excluded from pricedRequests and cost
    { model: "local/unpriced-model-7b", tokens: { input: 500_000, cached: 0, output: 500_000 } },
  ];

  // Default USD @ 7.2: ¥5.2 / 7.2 + $12.5
  const usdResolver = createPricingResolver({ displayCurrency: "USD", usdToCnyRate: 7.2 });
  assert.equal(usdResolver.displayCurrency, "USD");
  assert.equal(usdResolver.usdToCnyRate, 7.2);
  assert.equal(usdResolver.hasCustomPricing, false);

  const deepseekUsd = usdResolver.priceCall(calls[0]);
  assert.equal(deepseekUsd.priced, true);
  assert.equal(deepseekUsd.nativeCurrency, "CNY");
  assertApprox(deepseekUsd.nativeCost, 5.2);
  assert.equal(deepseekUsd.displayCurrency, "USD");
  assertApprox(deepseekUsd.cost, 5.2 / 7.2);

  const unpriced = usdResolver.priceCall(calls[2]);
  assert.deepEqual(unpriced, {
    priced: false,
    nativeCost: null,
    nativeCurrency: null,
    cost: null,
    displayCurrency: "USD",
    pricingKey: "unpriced-model-7b",
    longContext: false,
    source: null,
  });

  const usdAgg = aggregateCallCosts(calls, usdResolver);
  assert.equal(usdAgg.displayCurrency, "USD");
  assert.equal(usdAgg.pricedRequests, 2);
  assert.equal(usdAgg.unpricedRequests, 1);
  assert.equal(usdAgg.totalRequests, 3);
  assertApprox(usdAgg.cost, 5.2 / 7.2 + 12.5);
  assertApprox(usdAgg.totalCost, 5.2 / 7.2 + 12.5);

  // Switch displayCurrency to CNY @ 7.5: ¥5.2 + $12.5 * 7.5 = ¥98.95
  const cnyAgg = aggregateCallCosts(calls, {
    displayCurrency: "CNY",
    usdToCnyRate: 7.5,
    overrides: {},
  });
  assert.equal(cnyAgg.displayCurrency, "CNY");
  assert.equal(cnyAgg.pricedRequests, 2);
  assert.equal(cnyAgg.unpricedRequests, 1);
  assertApprox(cnyAgg.cost, 5.2 + 12.5 * 7.5);

  // All-unpriced batch yields cost: null and pricedRequests: 0.
  const onlyUnpriced = aggregateCallCosts([calls[2]], usdResolver);
  assert.equal(onlyUnpriced.cost, null);
  assert.equal(onlyUnpriced.totalCost, 0);
  assert.equal(onlyUnpriced.pricedRequests, 0);
  assert.equal(onlyUnpriced.unpricedRequests, 1);

  // Explicit zero-cost custom override IS priced (priced: true, cost: 0, pricedRequests: 1).
  const freeCall = calculateCallCost(calls[2], {
    displayCurrency: "USD",
    usdToCnyRate: 7.2,
    overrides: {
      "unpriced-model-7b": { currency: "USD", input: 0, cached: 0, output: 0 },
    },
  });
  assert.equal(freeCall.priced, true);
  assert.equal(freeCall.cost, 0);
  const freeAgg = aggregateCallCosts([calls[2]], {
    displayCurrency: "USD",
    usdToCnyRate: 7.2,
    overrides: {
      "unpriced-model-7b": { currency: "USD", input: 0, cached: 0, output: 0 },
    },
  });
  assert.equal(freeAgg.pricedRequests, 1);
  assert.equal(freeAgg.cost, 0);
});

// ---- PricingStore persistence, atomic writes, override CRUD, validation --------------------

test("pricingFilePath resolves pricingPath > dshHome > env.DSH_HOME", (t) => {
  const tmp = makeTempDir(t);
  const explicit = path.join(tmp, "custom-pricing.json");
  assert.equal(pricingFilePath({ pricingPath: explicit, dshHome: tmp }), path.resolve(explicit));
  assert.equal(
    pricingFilePath({ dshHome: tmp }),
    path.join(path.resolve(tmp), ".cache", PRICING_CACHE_FILENAME),
  );
  assert.equal(
    pricingFilePath({ env: { DSH_HOME: tmp } }),
    path.join(path.resolve(tmp), ".cache", PRICING_CACHE_FILENAME),
  );
});

test("PricingStore atomic save/load, override CRUD, resetOverrides, resetAll, and concurrency", async (t) => {
  const tmp = makeTempDir(t);
  const warnings = [];
  const store = new PricingStore({
    dshHome: tmp,
    onWarning: (msg, err) => warnings.push({ msg, err }),
  });

  // Missing file loads default config cleanly without warning.
  const initial = await store.load();
  assert.deepEqual(initial, defaultPricingConfig());
  assert.equal(initial.version, PRICING_SCHEMA_VERSION);
  assert.equal(initial.displayCurrency, DEFAULT_DISPLAY_CURRENCY);
  assert.equal(initial.usdToCnyRate, DEFAULT_USD_TO_CNY_RATE);
  assert.deepEqual(initial.overrides, {});
  assert.equal(warnings.length, 0);
  assert.equal(fs.existsSync(store.filePath), false);

  // Concurrent updates serialize cleanly with no lost updates and no leftover .tmp files.
  await Promise.all([
    store.update({ displayCurrency: "CNY" }),
    store.update({ usdToCnyRate: 7.35 }),
    store.update({
      key: "DeepSeek-Chat",
      rates: { currency: "CNY", input: 1.5, cached: 0.15, output: 2.5 },
    }),
    store.update({
      key: "custom-model",
      rates: {
        currency: "USD",
        input: 2,
        cached: 0.2,
        cacheWrite: 2.5,
        output: 8,
        longContextThreshold: 128_000,
        longInput: 4,
        longCached: 0.4,
        longCacheWrite: 5,
        longOutput: 12,
      },
    }),
  ]);

  const cacheDir = path.dirname(store.filePath);
  const files = fs.readdirSync(cacheDir);
  assert.deepEqual(files, [PRICING_CACHE_FILENAME], "atomic write must leave no .tmp leftovers");

  if (process.platform !== "win32") {
    const mode = fs.statSync(store.filePath).mode & 0o777;
    assert.equal(mode, 0o600, "pricing file should be owner-readable/writable (0600)");
  }

  // Fresh PricingStore instance reads back exact persisted config.
  const reloaded = new PricingStore({ dshHome: tmp });
  const loaded = await reloaded.load();
  assert.equal(loaded.displayCurrency, "CNY");
  assert.equal(loaded.usdToCnyRate, 7.35);
  assert.deepEqual(Object.keys(loaded.overrides).sort(), ["custom-model", "deepseek-chat"]);
  assert.equal(loaded.overrides["deepseek-chat"].input, 1.5);
  assert.equal(loaded.overrides["custom-model"].longContextThreshold, 128_000);

  // Resolver reflects loaded overrides & exchange rate.
  const resolver = await reloaded.resolver();
  assert.equal(resolver.displayCurrency, "CNY");
  assert.equal(resolver.usdToCnyRate, 7.35);
  assert.equal(resolver.hasCustomPricing, true);
  const customCall = resolver.priceCall({
    model: "custom-model",
    tokens: { input: 100_000, cached: 0, output: 50_000 },
  });
  // Native USD: 0.1*2 + 0.05*8 = $0.6 -> CNY @ 7.35 = ¥4.41
  assert.equal(customCall.priced, true);
  assert.equal(customCall.nativeCurrency, "USD");
  assertApprox(customCall.nativeCost, 0.6);
  assertApprox(customCall.cost, 0.6 * 7.35);

  // Delete one override via `rates: null`.
  const afterDelete = await reloaded.update({ key: "deepseek-chat", rates: null });
  assert.deepEqual(Object.keys(afterDelete.overrides), ["custom-model"]);

  // resetOverrides clears overrides while preserving displayCurrency & usdToCnyRate.
  const afterResetOverrides = await reloaded.update({ resetOverrides: true });
  assert.deepEqual(afterResetOverrides.overrides, {});
  assert.equal(afterResetOverrides.displayCurrency, "CNY");
  assert.equal(afterResetOverrides.usdToCnyRate, 7.35);

  // Add an override back then test resetAll restores everything to defaults.
  await reloaded.update({
    key: "temp-model",
    rates: { currency: "USD", input: 1, cached: 0.1, output: 2 },
  });
  const afterResetAll = await reloaded.update({ resetAll: true });
  assert.deepEqual(afterResetAll, defaultPricingConfig());
});

test("PricingStore rejects invalid exchange rates, negative prices, and malformed updates without mutating state", async (t) => {
  const tmp = makeTempDir(t);
  const store = new PricingStore({ dshHome: tmp });
  await store.update({
    displayCurrency: "CNY",
    usdToCnyRate: 7.25,
    key: "gpt-4o",
    rates: { currency: "USD", input: 2, cached: 1, output: 8 },
  });
  const before = store.snapshot();
  const rawBefore = fs.readFileSync(store.filePath, "utf8");

  const invalidUpdates = [
    {},
    { usdToCnyRate: 0 },
    { usdToCnyRate: -7.2 },
    { usdToCnyRate: Number.NaN },
    { usdToCnyRate: Number.POSITIVE_INFINITY },
    { usdToCnyRate: MIN_USD_TO_CNY_RATE / 10 },
    { usdToCnyRate: MAX_USD_TO_CNY_RATE + 1 },
    { displayCurrency: "EUR" },
    { key: "gpt-4o" }, // missing rates
    { rates: { currency: "USD", input: 1, cached: 0.1, output: 2 } }, // missing key
    { key: "   ", rates: { currency: "USD", input: 1, cached: 0.1, output: 2 } },
    { key: "gpt-4o", rates: { currency: "USD", input: -0.01, cached: 0, output: 1 } },
    { key: "gpt-4o", rates: { currency: "USD", input: 1, cached: -1, output: 1 } },
    { key: "gpt-4o", rates: { currency: "USD", input: 1, cached: 0, output: -1 } },
    { key: "gpt-4o", rates: { currency: "USD", input: 1, cached: 0, output: 1, cacheWrite: -0.5 } },
    { key: "gpt-4o", rates: { currency: "USD", input: Number.NaN, cached: 0, output: 1 } },
    { key: "gpt-4o", rates: { currency: "USD", input: MAX_RATE_PER_MILLION + 1, cached: 0, output: 1 } },
    {
      key: "gpt-4o",
      rates: { currency: "USD", input: 1, cached: 0, output: 1, longContextThreshold: 0 },
    },
    {
      key: "gpt-4o",
      rates: { currency: "USD", input: 1, cached: 0, output: 1, longContextThreshold: 100.5 },
    },
    {
      key: "gpt-4o",
      rates: { currency: "USD", input: 1, cached: 0, output: 1, longOutput: -5 },
    },
    { key: "gpt-4o", rates: { currency: "GBP", input: 1, cached: 0, output: 1 } },
    { displayCurrency: "USD", extraUnexpectedField: true },
  ];

  for (const bad of invalidUpdates) {
    assert.equal(
      pricingUpdateInputSchema.safeParse(bad).success,
      false,
      `schema should reject ${JSON.stringify(bad)}`,
    );
    await assert.rejects(() => store.update(bad));
  }

  // Neither in-memory state nor on-disk JSON changed after rejected updates.
  assert.deepEqual(store.snapshot(), before);
  assert.equal(fs.readFileSync(store.filePath, "utf8"), rawBefore);
});

test("PricingStore recovers safely with defaults when disk file is corrupt or schema-invalid", async (t) => {
  const tmp = makeTempDir(t);
  const corruptPath = path.join(tmp, "corrupt.json");
  fs.writeFileSync(corruptPath, "{ not valid json", "utf8");

  const warnings1 = [];
  const store1 = new PricingStore({
    pricingPath: corruptPath,
    onWarning: (msg, err) => warnings1.push({ msg, err }),
  });
  assert.deepEqual(await store1.load(), defaultPricingConfig());
  assert.equal(warnings1.length, 1);

  // Valid JSON but negative rate / bad exchange rate on disk.
  const badSchemaPath = path.join(tmp, "bad-schema.json");
  fs.writeFileSync(
    badSchemaPath,
    JSON.stringify({
      version: 1,
      displayCurrency: "USD",
      usdToCnyRate: -5,
      overrides: { "gpt-4o": { currency: "USD", input: -1, cached: 0, output: 2 } },
    }),
    "utf8",
  );
  const warnings2 = [];
  const store2 = new PricingStore({
    pricingPath: badSchemaPath,
    onWarning: (msg, err) => warnings2.push({ msg, err }),
  });
  assert.deepEqual(await store2.load(), defaultPricingConfig());
  assert.equal(warnings2.length, 1);
});

// ---- RPC handlers (`dsh.pricing.get` / `dsh.pricing.update`) -------------------------------

test("registerPricingRpc wires dsh.pricing.get and dsh.pricing.update with seenModels and schema checks", async (t) => {
  const tmp = makeTempDir(t);
  const store = new PricingStore({ dshHome: tmp });
  const handlers = new Map();
  const capturedContexts = [];

  const mockServer = {
    handle(contract, handler) {
      handlers.set(contract.name, { contract, handler });
    },
  };

  let seenModels = new Map([
    ["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"],
    ["local/unmatched-llm", "Unmatched Local LLM"],
    ["unknown", "Unknown"],
  ]);

  const dispose = registerPricingRpc(mockServer, store, {
    getSeenModels: async () => seenModels,
    onContext: (ctx) => capturedContexts.push(ctx),
  });
  t.after(dispose);

  assert.equal(pricingGetRpc.name, "dsh.pricing.get");
  assert.equal(pricingUpdateRpc.name, "dsh.pricing.update");
  assert.ok(handlers.has("dsh.pricing.get"));
  assert.ok(handlers.has("dsh.pricing.update"));

  async function callRpc(name, rawInput) {
    const entry = handlers.get(name);
    assert.ok(entry, `handler ${name} not registered`);
    const parsedInput = entry.contract.input.parse(rawInput);
    const fakeCtx = { paseo: { mock: name } };
    const result = await entry.handler(parsedInput, fakeCtx);
    return entry.contract.output.parse(result);
  }

  // Initial GET: locally seen rows sorted to the top; unmatched seen row has effective === null.
  const initialState = await callRpc("dsh.pricing.get", {});
  assert.equal(initialState.displayCurrency, "USD");
  assert.equal(initialState.usdToCnyRate, 7.2);
  assert.equal(initialState.hasCustomOverrides, false);
  assert.equal(capturedContexts.length, 1);

  const topTwoKeys = initialState.models.slice(0, 2).map((row) => row.key);
  assert.deepEqual(topTwoKeys, ["claude-sonnet-4", "unmatched-llm"]);

  const unmatchedRow = initialState.models.find((row) => row.key === "unmatched-llm");
  assert.equal(unmatchedRow?.seenLocally, true);
  assert.equal(unmatchedRow?.reference, null);
  assert.equal(unmatchedRow?.custom, null);
  assert.equal(unmatchedRow?.effective, null);
  assert.equal(initialState.models.some((row) => row.key === "unknown"), false);

  // UPDATE: set custom CNY rate for unmatched-llm and switch displayCurrency to CNY.
  const updated = await callRpc("dsh.pricing.update", {
    displayCurrency: "CNY",
    usdToCnyRate: 7.4,
    key: "unmatched-llm",
    rates: { currency: "CNY", input: 1, cached: 0.1, output: 2 },
  });
  assert.equal(updated.displayCurrency, "CNY");
  assert.equal(updated.usdToCnyRate, 7.4);
  assert.equal(updated.hasCustomOverrides, true);
  const pricedUnmatched = updated.models.find((row) => row.key === "unmatched-llm");
  assert.equal(pricedUnmatched?.effective?.currency, "CNY");
  assert.equal(pricedUnmatched?.effective?.input, 1);

  // UPDATE: remove override via rates: null -> returns to unpriced (effective: null).
  const cleared = await callRpc("dsh.pricing.update", { key: "unmatched-llm", rates: null });
  assert.equal(cleared.hasCustomOverrides, false);
  const unpricedAgain = cleared.models.find((row) => row.key === "unmatched-llm");
  assert.equal(unpricedAgain?.effective, null);

  // Array form of seenModels + resilience when getSeenModels throws.
  seenModels = ["deepseek/deepseek-reasoner"];
  const withArray = await callRpc("dsh.pricing.get", {});
  assert.equal(withArray.models[0].key, "deepseek-reasoner");
  assert.equal(withArray.models[0].seenLocally, true);

  const failingHandlers = new Map();
  registerPricingRpc(
    { handle: (contract, handler) => failingHandlers.set(contract.name, { contract, handler }) },
    store,
    {
      getSeenModels: async () => {
        throw new Error("usage scan unavailable");
      },
    },
  );
  const fallbackState = await failingHandlers.get("dsh.pricing.get").handler({}, { paseo: {} });
  assert.doesNotThrow(() => pricingGetRpc.output.parse(fallbackState));
  assert.equal(fallbackState.displayCurrency, "CNY");
});
