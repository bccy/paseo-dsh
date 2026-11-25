require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  CURRENCIES,
  DEFAULT_CATALOG_TTL_MS,
  DEFAULT_DISPLAY_CURRENCY,
  DEFAULT_PRICING_AUTO_SYNC,
  DEFAULT_PRICING_SYNC_SOURCE,
  DEFAULT_USD_TO_CNY_RATE,
  MAX_RATE_PER_MILLION,
  MAX_USD_TO_CNY_RATE,
  MIN_USD_TO_CNY_RATE,
  OFFICIAL_PROVIDER_PRIORITY,
  PRICING_CATALOG_SCHEMA_VERSION,
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
  matchSyncedCatalogEntry,
  modelRatesSchema,
  normalizeModelKey,
  parseModelsDevCatalog,
  pricingGetRpc,
  pricingSyncRpc,
  pricingUpdateInputSchema,
  pricingUpdateRpc,
  resolveModelRates,
  resolvePricingKey,
  stripProviderPrefix,
} = require("../shared/pricing.ts");

const {
  PRICING_CACHE_FILENAME,
  PRICING_CATALOG_CACHE_FILENAME,
  PricingStore,
  pricingCatalogFilePath,
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

// ---- Official API Pricing Sync (`models.dev`) ----------------------------------------------

function buildSampleModelsDevPayload() {
  return {
    // Third-party resellers / aggregators / flat-rate subscription plans with marked-up or $0 prices
    // MUST NEVER pollute official first-party API prices!
    "scnet-token-plan": {
      name: "Token Plan Reseller",
      models: {
        "DeepSeek-V4-Pro": {
          name: "DeepSeek V4 Pro (Plan)",
          cost: { input: 0, output: 0, cache_read: 0 },
        },
      },
    },
    openrouter: {
      name: "OpenRouter",
      models: {
        "deepseek/deepseek-chat": {
          name: "DeepSeek Chat (Marked Up)",
          cost: { input: 9.9, output: 29.9 },
        },
        "anthropic/claude-sonnet-4-5": {
          name: "Claude Sonnet 4.5 (Marked Up)",
          cost: { input: 99, output: 199, cache_read: 9.9 },
        },
      },
    },
    "zhipuai-coding-plan": {
      name: "Zhipu Coding Plan",
      models: {
        "glm-5": {
          name: "GLM-5 (Plan)",
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        },
      },
    },
    // Official first-party providers
    deepseek: {
      name: "DeepSeek",
      models: {
        "deepseek-v4-pro": {
          name: "DeepSeek V4 Pro",
          cost: { input: 0.66, output: 1.98, reasoning: 1.98, cache_read: 0.022 },
        },
        "deepseek-v4-flash": {
          name: "DeepSeek V4 Flash",
          cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
        },
      },
    },
    anthropic: {
      name: "Anthropic",
      models: {
        "claude-sonnet-4-5": {
          name: "Claude Sonnet 4.5",
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        },
        "claude-sonnet-5": {
          name: "Claude Sonnet 5",
          cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
        },
      },
    },
    openai: {
      name: "OpenAI",
      models: {
        "gpt-5": {
          name: "GPT-5",
          cost: { input: 1.25, output: 10, cache_read: 0.125 },
        },
        "gpt-5-pro": {
          name: "GPT-5 Pro",
          // Omitted cache_read MUST safely fall back to input (15), never 0!
          cost: { input: 15, output: 120 },
        },
        "gpt-5.4": {
          name: "GPT-5.4",
          // tiers has exact 272k threshold while legacy context_over_200k exists too: tiers must win!
          cost: {
            input: 2.5,
            output: 15,
            cache_read: 0.25,
            tiers: [
              { input: 5, output: 22.5, cache_read: 0.5, tier: { type: "context", size: 272000 } },
            ],
            context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
          },
        },
        "gpt-4.1": {
          name: "GPT-4.1",
          cost: { input: 2, output: 8, cache_read: 0.5 },
        },
        o3: {
          name: "o3",
          cost: { input: 2, output: 8, cache_read: 0.5 },
        },
      },
    },
    google: {
      name: "Google",
      models: {
        "gemini-2.5-pro": {
          name: "Gemini 2.5 Pro",
          cost: {
            input: 1.25,
            output: 10,
            cache_read: 0.125,
            context_over_200k: { input: 2.5, output: 15, cache_read: 0.25 },
          },
        },
      },
    },
    xai: {
      name: "xAI",
      models: {
        "grok-4.5": {
          name: "Grok 4.5",
          cost: {
            input: 2,
            output: 6,
            cache_read: 0.3,
            tiers: [
              { input: 4, output: 12, cache_read: 0.6, tier: { type: "context", size: 200000 } },
            ],
          },
        },
      },
    },
    moonshotai: {
      name: "Moonshot AI",
      models: {
        "kimi-k3.1-pro": {
          name: "Kimi K3.1 Pro",
          cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2 },
        },
      },
    },
    "moonshotai-cn": {
      name: "Moonshot AI (China)",
      models: {
        "kimi-k3.1-pro": {
          name: "Kimi K3.1 Pro (CN)",
          cost: { input: 1.94, output: 10.17, cache_read: 0.19, cache_write: 1.94 },
        },
      },
    },
    zhipuai: {
      name: "Zhipu AI",
      models: {
        "glm-5": {
          name: "GLM-5",
          cost: {
            input: 0.6,
            output: 2.7,
            cache_read: 0.15,
            cache_write: 0,
            tiers: [
              {
                input: 0.9,
                output: 3.3,
                cache_read: 0.22,
                cache_write: 0,
                tier: { type: "context", size: 32000 },
              },
            ],
          },
        },
      },
    },
    alibaba: {
      name: "Alibaba",
      models: {
        "qwen3-coder-flash": {
          name: "Qwen3 Coder Flash",
          cost: {
            input: 0.3,
            output: 1.5,
            cache_read: 0.06,
            cache_write: 0.375,
            tiers: [
              {
                input: 0.8,
                output: 4,
                cache_read: 0.16,
                cache_write: 1,
                tier: { type: "context", size: 128000 },
              },
              {
                input: 0.5,
                output: 2.5,
                cache_read: 0.1,
                cache_write: 0.625,
                tier: { type: "context", size: 32000 },
              },
            ],
          },
        },
        // Re-hosted third-party DeepSeek model on Alibaba: goes into providerModels only, never canonical!
        "deepseek-v4-flash-0731": {
          name: "DeepSeek V4 Flash 0731 (Alibaba)",
          cost: { input: 0.44, output: 1.32, cache_read: 0.044 },
        },
        "deepseek-v4-flash": {
          name: "DeepSeek V4 Flash (Alibaba)",
          cost: { input: 0.44, output: 1.32, cache_read: 0.044 },
        },
      },
    },
    minimax: {
      name: "MiniMax",
      models: {
        "MiniMax-M3": {
          name: "MiniMax M3",
          cost: {
            input: 0.3,
            output: 1.2,
            cache_read: 0.06,
            tiers: [
              { input: 0.6, output: 2.4, cache_read: 0.12, tier: { type: "context", size: 512000 } },
            ],
          },
        },
      },
    },
  };
}

function makeJsonResponse(payload, { status = 200, headers = {} } = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    async text() {
      return text;
    },
  };
}

test("parseModelsDevCatalog enforces official first-party priority, tier parsing, and safe cache_read fallback", () => {
  assert.ok(OFFICIAL_PROVIDER_PRIORITY.indexOf("deepseek") < OFFICIAL_PROVIDER_PRIORITY.indexOf("alibaba"));
  assert.ok(OFFICIAL_PROVIDER_PRIORITY.indexOf("anthropic") < OFFICIAL_PROVIDER_PRIORITY.indexOf("togetherai"));

  const catalog = parseModelsDevCatalog(buildSampleModelsDevPayload(), "2026-11-26T00:00:00.000Z");
  assert.equal(catalog.version, PRICING_CATALOG_SCHEMA_VERSION);
  assert.equal(catalog.source, DEFAULT_PRICING_SYNC_SOURCE);
  assert.equal(catalog.syncedAt, "2026-11-26T00:00:00.000Z");

  // Official DeepSeek wins over scnet-token-plan ($0) and Alibaba ($0.44/$1.32).
  assert.equal(catalog.models["deepseek-v4-pro"]?.provider, "deepseek");
  assert.equal(catalog.models["deepseek-v4-pro"]?.rates.input, 0.66);
  assert.equal(catalog.models["deepseek-v4-pro"]?.rates.cached, 0.022);
  assert.equal(catalog.models["deepseek-v4-pro"]?.rates.output, 1.98);
  assert.equal(catalog.models["deepseek-v4-flash"]?.provider, "deepseek");
  assert.equal(catalog.models["deepseek-v4-flash"]?.rates.input, 0.15);

  // Alibaba's re-hosted deepseek-v4-flash-0731 is in providerModels, NOT canonical models!
  assert.equal(catalog.models["deepseek-v4-flash-0731"], undefined);
  assert.equal(catalog.providerModels["alibaba/deepseek-v4-flash-0731"]?.rates.input, 0.44);

  // OpenRouter's deepseek-chat and marked-up claude-sonnet-4-5 are ignored completely.
  assert.equal(catalog.models["deepseek-chat"], undefined);
  assert.equal(catalog.models["claude-sonnet-4-5"]?.provider, "anthropic");
  assert.equal(catalog.models["claude-sonnet-4-5"]?.rates.input, 3);
  assert.equal(catalog.models["claude-sonnet-4-5"]?.rates.cacheWrite, 3.75);

  // Zhipu official GLM-5 wins over zhipuai-coding-plan ($0) and preserves explicit cache_write: 0 & 32k tier.
  assert.equal(catalog.models["glm-5"]?.provider, "zhipuai");
  assert.equal(catalog.models["glm-5"]?.rates.input, 0.6);
  assert.equal(catalog.models["glm-5"]?.rates.cacheWrite, 0);
  assert.equal(catalog.models["glm-5"]?.rates.longContextThreshold, 32_000);
  assert.equal(catalog.models["glm-5"]?.rates.longInput, 0.9);

  // Missing cache_read falls back safely to input (never 0).
  assert.equal(catalog.models["gpt-5-pro"]?.rates.input, 15);
  assert.equal(catalog.models["gpt-5-pro"]?.rates.cached, 15);
  assert.equal(catalog.models["gpt-5-pro"]?.rates.output, 120);

  // Explicit `tiers` threshold (272k) wins over legacy `context_over_200k` alias; multi-tier picks lowest threshold (32k).
  assert.equal(catalog.models["gpt-5.4"]?.rates.longContextThreshold, 272_000);
  assert.equal(catalog.models["gpt-5.4"]?.rates.longInput, 5);
  assert.equal(catalog.models["gpt-5.4"]?.rates.longOutput, 22.5);
  assert.equal(catalog.models["qwen3-coder-flash"]?.rates.longContextThreshold, 32_000);
  assert.equal(catalog.models["qwen3-coder-flash"]?.rates.longInput, 0.5);

  // Legacy `context_over_200k` still parsed when `tiers` is omitted.
  assert.equal(catalog.models["gemini-2.5-pro"]?.rates.longContextThreshold, 200_000);
  assert.equal(catalog.models["gemini-2.5-pro"]?.rates.longInput, 2.5);

  // Mixed-case model IDs normalize cleanly to lowercase (`minimax-m3`).
  assert.equal(catalog.models["minimax-m3"]?.provider, "minimax");
  assert.equal(catalog.models["minimax-m3"]?.rates.longContextThreshold, 512_000);

  // Provider-scoped regional pricing (`moonshotai-cn` vs `moonshotai`) both retained cleanly.
  assert.equal(catalog.models["kimi-k3.1-pro"]?.provider, "moonshotai");
  assert.equal(catalog.models["kimi-k3.1-pro"]?.rates.input, 2);
  assert.equal(catalog.providerModels["moonshotai-cn/kimi-k3.1-pro"]?.rates.input, 1.94);

  // Invalid or empty official payloads fail loudly.
  assert.throws(() => parseModelsDevCatalog(null));
  assert.throws(() => parseModelsDevCatalog([]));
  assert.throws(() => parseModelsDevCatalog({ openrouter: { models: { "a/b": { cost: { input: 1, output: 2 } } } } }));
});

test("resolution precedence: overrides > synced official catalog > built-in reference > unpriced, with safe fuzzy guards", () => {
  const catalog = parseModelsDevCatalog(buildSampleModelsDevPayload(), "2026-11-26T00:00:00.000Z");

  // 1. User override ALWAYS wins over synced catalog and built-in reference.
  const customOverride = { currency: "CNY", input: 9, cached: 0.9, output: 18 };
  const overridden = resolveModelRates(
    "anthropic/claude-sonnet-5",
    { "claude-sonnet-5": customOverride },
    "my-proxy",
    catalog,
  );
  assert.equal(overridden?.source, "override");
  assert.equal(overridden?.pricingKey, "claude-sonnet-5");
  assert.deepEqual(overridden?.rates, customOverride);
  assert.equal(overridden?.synced?.id, "claude-sonnet-5");

  // 2. Synced official model wins over built-in reference (e.g. claude-sonnet-5 $2/$10, gpt-5.4 $2.5/$15).
  const sonnet5 = resolveModelRates("openrouter/anthropic/claude-sonnet-5", {}, "openrouter", catalog);
  assert.equal(sonnet5?.source, "synced");
  assert.equal(sonnet5?.pricingKey, "claude-sonnet-5");
  assert.equal(sonnet5?.rates.input, 2);
  assert.equal(sonnet5?.rates.output, 10);

  // 3. Exact (provider, model) match uses regional/host rates when provider matches explicitly.
  const kimiCn = resolveModelRates("kimi-k3.1-pro", {}, "moonshotai-cn", catalog);
  assert.equal(kimiCn?.source, "synced");
  assert.equal(kimiCn?.rates.input, 1.94);
  const kimiGlobal = resolveModelRates("kimi-k3.1-pro", {}, "custom-gateway", catalog);
  assert.equal(kimiGlobal?.source, "synced");
  assert.equal(kimiGlobal?.rates.input, 2);

  // 4. Version separator alias & release-date suffix stripping match official synced entries.
  assert.equal(matchSyncedCatalogEntry("claude-sonnet-4.5", catalog)?.id, "claude-sonnet-4-5");
  assert.equal(matchSyncedCatalogEntry("gpt-5-2025-08-07", catalog)?.id, "gpt-5");
  assert.equal(matchSyncedCatalogEntry("gemini-2.5-pro-preview-06-05", catalog)?.id, "gemini-2.5-pro");
  assert.equal(matchSyncedCatalogEntry("deepseek-v4-flash-0731", catalog)?.id, "deepseek-v4-flash");
  assert.equal(matchSyncedCatalogEntry("deepseek-v4-flash-0731", catalog, "alibaba")?.provider, "alibaba");

  // 5. CRITICAL GUARD: distinct tier qualifiers (`o3-mini`, `gpt-4.1-nano`) MUST NOT falsely match synced `o3`/`gpt-4.1`!
  const o3Mini = resolveModelRates("o3-mini-2025-01-31", {}, "openai", catalog);
  assert.equal(o3Mini?.source, "reference");
  assert.equal(o3Mini?.pricingKey, "o3-mini");
  assert.equal(o3Mini?.rates.input, 1.1);

  const gpt41Nano = resolveModelRates("gpt-4.1-nano-2025-04-14", {}, "openai", catalog);
  assert.equal(gpt41Nano?.source, "reference");
  assert.equal(gpt41Nano?.pricingKey, "gpt-4.1-nano");
  assert.equal(gpt41Nano?.rates.input, 0.1);

  // 6. Model absent from official deepseek on models.dev (`deepseek-chat`) falls back to built-in CNY reference.
  const dsChat = resolveModelRates("deepseek-chat", {}, "deepseek", catalog);
  assert.equal(dsChat?.source, "reference");
  assert.equal(dsChat?.pricingKey, "deepseek-chat");
  assert.equal(dsChat?.rates.currency, "CNY");
  assert.equal(dsChat?.rates.input, 2);

  // 7. UsagePricer / PricingResolver prices synced long-context tier (272k) and converts USD -> CNY.
  const resolver = createPricingResolver({ displayCurrency: "CNY", usdToCnyRate: 7.2 }, catalog);
  assert.equal(resolver.hasCustomPricing, false);
  const longCall = resolver.priceCall({
    model: "gpt-5.4",
    provider: "openai",
    tokens: { input: 200_000, cached: 100_000, output: 10_000 }, // 300k prompt > 272k threshold!
  });
  assert.equal(longCall.priced, true);
  assert.equal(longCall.source, "synced");
  assert.equal(longCall.longContext, true);
  assert.equal(longCall.nativeCurrency, "USD");
  // (0.2*5 + 0.1*0.5 + 0.01*22.5) = 1 + 0.05 + 0.225 = $1.275 -> CNY @ 7.2 = ¥9.18
  assertApprox(longCall.nativeCost, 1.275);
  assertApprox(longCall.cost, 1.275 * 7.2);

  // 8. Completely unknown model remains unpriced.
  const unknown = resolver.priceCall({
    model: "local/my-private-model",
    tokens: { input: 1000, cached: 0, output: 500 },
  });
  assert.equal(unknown.priced, false);
  assert.equal(unknown.cost, null);
  assert.equal(unknown.source, null);
});

test("PricingStore official catalog sync: atomic disk cache, TTL, single-flight, backward-compat autoSync, and safe error fallback", async (t) => {
  const tmp = makeTempDir(t);
  let nowMs = Date.parse("2026-11-26T10:00:00.000Z");

  // Seed legacy pricing config file WITHOUT `autoSync` field -> must load cleanly with autoSync: true!
  const configFile = pricingFilePath({ dshHome: tmp });
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      displayCurrency: "CNY",
      usdToCnyRate: 7.3,
      overrides: {},
    }),
    "utf8",
  );

  let fetchCalls = 0;
  let releaseFetch = null;
  let fetchMode = "ok";
  const warnings = [];

  const mockFetch = async (_url, init) => {
    fetchCalls += 1;
    if (fetchMode === "slow-single-flight") {
      await new Promise((resolve) => {
        releaseFetch = resolve;
      });
      return makeJsonResponse(buildSampleModelsDevPayload());
    }
    if (fetchMode === "network-error") {
      throw new Error("ECONNRESET simulated");
    }
    if (fetchMode === "http-503") {
      return makeJsonResponse("Service Unavailable", { status: 503 });
    }
    if (fetchMode === "bad-json") {
      return makeJsonResponse("{corrupt-json");
    }
    if (fetchMode === "too-large") {
      return makeJsonResponse("x".repeat(32_768), {
        headers: { "content-length": String(32_768) },
      });
    }
    if (fetchMode === "timeout") {
      return await new Promise((_resolve, reject) => {
        const onAbort = () => reject(init?.signal?.reason ?? new Error("Aborted"));
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return makeJsonResponse(buildSampleModelsDevPayload());
  };

  const store = new PricingStore({
    dshHome: tmp,
    fetchImpl: mockFetch,
    now: () => nowMs,
    syncTimeoutMs: 60,
    maxResponseBytes: 16_384,
    onWarning: (msg, err) => warnings.push({ msg, err }),
  });
  t.after(() => store.dispose());

  // Legacy config loads with default autoSync === true.
  const loadedCfg = await store.load();
  assert.equal(loadedCfg.displayCurrency, "CNY");
  assert.equal(loadedCfg.usdToCnyRate, 7.3);
  assert.equal(loadedCfg.autoSync, DEFAULT_PRICING_AUTO_SYNC);
  assert.equal(store.isCatalogStale(), true);
  assert.equal(store.catalogPath, pricingCatalogFilePath({ dshHome: tmp }));

  // Single-flight: two concurrent syncOfficialCatalog() calls share ONE HTTP fetch!
  fetchMode = "slow-single-flight";
  const p1 = store.syncOfficialCatalog({ force: true });
  const p2 = store.syncOfficialCatalog({ force: true });
  // Wait a microtask so mockFetch starts.
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchCalls, 1, "concurrent syncs must coalesce into one single-flight request");
  assert.equal(store.syncStatus().syncing, true);
  releaseFetch();
  const [res1, res2] = await Promise.all([p1, p2]);
  assert.equal(res1.ok, true);
  assert.equal(res2.ok, true);
  assert.equal(res1.status.syncing, false);
  assert.equal(res1.status.lastError, null);
  assert.ok(res1.status.modelCount >= 10);

  // Disk cache written atomically with 0600 permissions and no leftover .tmp files.
  assert.equal(fs.existsSync(store.catalogPath), true);
  const cacheFiles = fs.readdirSync(path.dirname(store.catalogPath)).sort();
  assert.deepEqual(cacheFiles, [PRICING_CATALOG_CACHE_FILENAME, PRICING_CACHE_FILENAME].sort());
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(store.catalogPath).mode & 0o777, 0o600);
  }
  const diskBeforeFailure = fs.readFileSync(store.catalogPath, "utf8");

  // Fresh cache within 24h TTL: non-forced sync skips network completely!
  fetchMode = "ok";
  nowMs += 60 * 60 * 1000; // +1h (< 24h)
  const skipped = await store.syncOfficialCatalog({ force: false });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.equal(fetchCalls, 1);

  // Failure modes NEVER crash and NEVER wipe existing valid disk cache!
  for (const mode of ["network-error", "http-503", "bad-json", "too-large", "timeout"]) {
    fetchMode = mode;
    const failed = await store.syncOfficialCatalog({ force: true });
    assert.equal(failed.ok, false, `mode ${mode} should fail cleanly`);
    assert.ok(failed.error && failed.error.length > 0, `mode ${mode} must record lastError`);
    assert.equal(store.syncStatus().lastError, failed.error);
    assert.equal(store.syncStatus().modelCount, res1.status.modelCount, "cached models preserved");
    assert.equal(
      fs.readFileSync(store.catalogPath, "utf8"),
      diskBeforeFailure,
      `mode ${mode} must never wipe disk cache`,
    );
  }

  // Fresh store instance reads persisted catalog from disk completely offline!
  const offlineStore = new PricingStore({
    dshHome: tmp,
    now: () => nowMs,
    fetchImpl: async () => {
      throw new Error("offline store must not fetch during load/resolver");
    },
  });
  t.after(() => offlineStore.dispose());
  const offlineResolver = await offlineStore.resolver();
  const dsV4 = offlineResolver.resolveRates("deepseek-v4-pro");
  assert.equal(dsV4?.source, "synced");
  assert.equal(dsV4?.rates.input, 0.66);

  // After 24h TTL expires, non-forced sync refreshes from network cleanly.
  fetchMode = "ok";
  nowMs += DEFAULT_CATALOG_TTL_MS + 1_000;
  assert.equal(store.isCatalogStale(), true);
  const refreshed = await store.syncOfficialCatalog({ force: false });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.skipped, false);
  assert.equal(store.syncStatus().lastError, null);

  // Updating autoSync persists cleanly; resetOverrides preserves it; resetAll restores default true.
  const disabled = await store.update({ autoSync: false });
  assert.equal(disabled.autoSync, false);
  const afterResetOverrides = await store.update({ resetOverrides: true });
  assert.equal(afterResetOverrides.autoSync, false);
  const afterResetAll = await store.update({ resetAll: true });
  assert.equal(afterResetAll.autoSync, true);
});

test("registerPricingRpc wires dsh.pricing.sync, lazy stale refresh on get, and disposable startup timer", async (t) => {
  const tmp = makeTempDir(t);
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount += 1;
    return makeJsonResponse(buildSampleModelsDevPayload());
  };

  const store = new PricingStore({
    dshHome: tmp,
    fetchImpl: mockFetch,
  });

  const handlers = new Map();
  const mockServer = {
    handle(contract, handler) {
      handlers.set(contract.name, { contract, handler });
    },
  };

  const dispose = registerPricingRpc(mockServer, store, {
    getSeenModels: async () => new Map([["deepseek-v4-pro", "DeepSeek V4 Pro"]]),
    startAutoSync: true,
    autoSyncDelayMs: 60_000, // far future; disposed before firing
    lazySyncOnGet: true,
  });
  t.after(dispose);

  assert.equal(pricingSyncRpc.name, "dsh.pricing.sync");
  assert.ok(handlers.has("dsh.pricing.sync"));

  async function callRpc(name, rawInput) {
    const entry = handlers.get(name);
    assert.ok(entry);
    const parsedInput = entry.contract.input.parse(rawInput);
    const result = await entry.handler(parsedInput, { paseo: {} });
    return entry.contract.output.parse(result);
  }

  // Manual dsh.pricing.sync force-syncs and returns synced state + synced badge source on rows.
  const syncedState = await callRpc("dsh.pricing.sync", { force: true });
  assert.equal(fetchCount, 1);
  assert.equal(syncedState.sync.source, "models.dev");
  assert.equal(syncedState.sync.lastError, null);
  assert.ok(syncedState.sync.modelCount >= 10);
  assert.ok(syncedState.sync.syncedAt);

  const dsRow = syncedState.models.find((row) => row.key === "deepseek-v4-pro");
  assert.equal(dsRow?.source, "synced");
  assert.equal(dsRow?.syncedProvider, "deepseek");
  assert.equal(dsRow?.seenLocally, true);
  assert.equal(dsRow?.effective?.input, 0.66);

  const dsChatRow = syncedState.models.find((row) => row.key === "deepseek-chat");
  assert.equal(dsChatRow?.source, "reference");
  assert.equal(dsChatRow?.effective?.currency, "CNY");

  // Startup auto-sync timer fires when delay is short and respects dispose().
  const tmp2 = makeTempDir(t);
  let startupFetches = 0;
  const store2 = new PricingStore({
    dshHome: tmp2,
    fetchImpl: async () => {
      startupFetches += 1;
      return makeJsonResponse(buildSampleModelsDevPayload());
    },
  });
  const dispose2 = registerPricingRpc(
    { handle: () => undefined },
    store2,
    { startAutoSync: true, autoSyncDelayMs: 15 },
  );
  t.after(dispose2);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(startupFetches, 1, "delayed startup auto-sync should fetch once when cache missing");
  dispose2();
});

test("shared/pricing.ts stays Hermes-safe and index.server.ts registers zero agent.open.before hooks", () => {
  const sharedSrc = fs.readFileSync(path.join(__dirname, "../shared/pricing.ts"), "utf8");
  const sharedCode = sharedSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(/["']node:/.test(sharedCode), false, "shared/pricing.ts must have zero node:* imports");
  assert.equal(/\bstructuredClone\b/.test(sharedCode), false, "shared/pricing.ts must not use structuredClone");

  const serverEntry = fs.readFileSync(path.join(__dirname, "../index.server.ts"), "utf8");
  const serverCode = serverEntry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(serverCode.includes("agent.session_open"), false);
  assert.equal(serverCode.includes("agent.open.before"), false);
});
