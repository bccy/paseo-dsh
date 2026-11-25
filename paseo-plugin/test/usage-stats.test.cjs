require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { test } = require("node:test");

const {
  DAILY_HISTORY_DAYS,
  UNPRICED_PRICER,
  convertUsageCurrency,
  deriveUsageMetrics,
  normalizeUsagePricingKey,
  usageDailyRpc,
  usageDailySchema,
  usageStatsRpc,
  usageStatsSchema,
} = require("../shared/usage.ts");
const {
  UsageStatsEngine,
  buildCalendarBins,
  localDayKey,
  parseSessionJsonl,
  registerUsageStatsRpc,
  usageCachePath,
} = require("../server/usage-stats.ts");

function makeTempDir(prefix = "paseo-usage-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function encodeZstd(text) {
  if (typeof zlib.zstdCompressSync === "function") {
    return zlib.zstdCompressSync(Buffer.from(text, "utf8"));
  }
  const { execFileSync } = require("node:child_process");
  return execFileSync("zstd", ["-q", "-c"], { input: Buffer.from(text, "utf8") });
}

function writeSessionFile(sessionsDir, relPath, lines, { zstd = false, mtimeMs } = {}) {
  const abs = path.join(sessionsDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n";
  fs.writeFileSync(abs, zstd ? encodeZstd(text) : text);
  if (typeof mtimeMs === "number") {
    const sec = mtimeMs / 1000;
    fs.utimesSync(abs, sec, sec);
  }
  return abs;
}

function sessionHeader({ id = "sess-1", origin, delegationDepth = 0 } = {}) {
  return {
    type: "session",
    version: 4,
    id,
    createdAt: 1_750_000_000_000,
    cwd: "/workspace/demo",
    isSeeded: false,
    ...(origin ? { origin } : {}),
    delegationDepth,
  };
}

function makeCallLines({
  turn = 1,
  step = 1,
  stepStartMs,
  firstTokenMs,
  finishMs,
  eventMs,
  provider,
  model,
  includeFinishResponse = true,
  packedStream = false,
  inputTokens = 1000,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  outputTokens = 200,
}) {
  const lines = [];
  if (stepStartMs !== undefined) {
    lines.push({ type: "step/start", seq: step * 10, time: stepStartMs, data: { turn, step } });
  }
  const stream = [];
  if (firstTokenMs !== undefined) {
    if (packedStream) {
      stream.push({
        type: "reasoning-chunks",
        time0: firstTokenMs,
        dt: [20, 20],
        texts: ["step", "1", "2"],
      });
    } else {
      stream.push({
        type: "chunk",
        time: firstTokenMs,
        chunk: { type: "text-delta", text: "hi" },
      });
    }
  }
  if (finishMs !== undefined || includeFinishResponse) {
    const chunk = { type: "finish", reason: "stop" };
    if (includeFinishResponse && (provider || model)) {
      chunk.replayState = {
        response: {
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        },
      };
    }
    stream.push({
      type: "chunk",
      time: finishMs ?? eventMs,
      chunk,
    });
  }
  const usage = {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
  };
  lines.push({
    type: "assistant/message",
    seq: step * 10 + 5,
    time: eventMs ?? finishMs,
    data: {
      turn,
      step,
      message: { role: "assistant", content: "ok" },
      usage,
      stream,
    },
  });
  return lines;
}

function makeMixedCurrencyPricer({ displayCurrency = "USD", usdToCnyRate = 7.2, hasCustomPricing = true } = {}) {
  // Matches `PricingStore` / `PricingResolver` from `shared/pricing.ts` 1:1.
  // Synthetic generic rates (per 1M tokens):
  // - "model-usd": $2 input, $0.20 cached, $0.50 cacheWrite, $10 output (USD)
  // - "model-cny": ¥7.2 input, ¥0.72 cached, ¥14.4 output (CNY -> exactly $1/$0.10/$2 at 7.2)
  // - anything else: unpriced
  const table = {
    "model-usd": { currency: "USD", input: 2.0, cached: 0.2, cacheWrite: 0.5, output: 10.0 },
    "model-cny": { currency: "CNY", input: 7.2, cached: 0.72, cacheWrite: 0, output: 14.4 },
  };
  return {
    async resolver() {
      return {
        displayCurrency,
        usdToCnyRate,
        hasCustomPricing,
        resolveKey(model) {
          return normalizeUsagePricingKey(model);
        },
        priceCall(input) {
          const pricingKey = normalizeUsagePricingKey(input.model);
          const rate = table[pricingKey];
          if (!rate) {
            return {
              priced: false,
              nativeCost: null,
              nativeCurrency: null,
              cost: null,
              displayCurrency,
              pricingKey,
              longContext: false,
              source: null,
            };
          }
          const cacheWrite = input.tokens.cacheWrite ?? 0;
          const nativeCost =
            (input.tokens.input * rate.input +
              input.tokens.cached * rate.cached +
              cacheWrite * rate.cacheWrite +
              input.tokens.output * rate.output) /
            1_000_000;
          const cost = convertUsageCurrency(nativeCost, rate.currency, displayCurrency, usdToCnyRate);
          return {
            priced: true,
            nativeCost,
            nativeCurrency: rate.currency,
            cost,
            displayCurrency,
            pricingKey,
            longContext: false,
            source: "reference",
          };
        },
      };
    },
  };
}

test("parseSessionJsonl handles subagent detection, provider/model fallback, packed runs, and timing bounds", () => {
  const base = 1_760_000_000_000;
  const lines = [
    sessionHeader({ id: "sub-1", origin: "subagent", delegationDepth: 1 }),
    { type: "request/context", seq: 2, time: base, data: { provider: "ctx-prov", model: "ctx-model", contextWindow: 128_000 } },
    // Noise line that should be skipped cheaply
    { type: "tool/result", seq: 3, time: base + 10, data: { output: "contains \"assistant/message\" in text" } },
    // Call 1: finish replayState wins over request/context; normal TTFT (2.5s) and speed (100 tok/s)
    ...makeCallLines({
      turn: 1,
      step: 1,
      stepStartMs: base + 1_000,
      firstTokenMs: base + 3_500,
      finishMs: base + 5_500,
      eventMs: base + 5_510,
      provider: "finish-prov",
      model: "finish-model",
      packedStream: true,
      inputTokens: 1_000,
      cacheReadTokens: 3_000,
      cacheWriteTokens: 500,
      outputTokens: 200,
    }),
    // Call 2: no finish replayState -> falls back to request/context; TTFT > 300s clamped to 300; burst speed > 3000 tok/s filtered out
    ...makeCallLines({
      turn: 1,
      step: 2,
      stepStartMs: base + 10_000,
      firstTokenMs: base + 500_000, // 490s -> clamped to 300s
      finishMs: base + 500_050, // 0.05s for 500 output -> 10,000 tok/s -> filtered
      eventMs: base + 500_055,
      includeFinishResponse: false,
      inputTokens: 400,
      cacheReadTokens: 0,
      outputTokens: 500,
    }),
    // Call 3: negative TTFT clamped to 0; exact 3000 tok/s boundary preserved
    ...makeCallLines({
      turn: 1,
      step: 3,
      stepStartMs: base + 600_000,
      firstTokenMs: base + 599_500, // -0.5s -> clamped to 0
      finishMs: base + 600_500, // 1.0s for 3000 output -> 3000 tok/s -> kept
      eventMs: base + 600_505,
      provider: "finish-prov",
      model: "finish-model",
      inputTokens: 200,
      outputTokens: 3_000,
    }),
    // Call 4: missing step/start -> firstTokenSec omitted; missing usage -> skipped
    ...makeCallLines({
      turn: 2,
      step: 1,
      stepStartMs: undefined,
      firstTokenMs: base + 700_000,
      finishMs: base + 702_000,
      eventMs: base + 702_010,
      provider: "finish-prov",
      model: "finish-model",
      inputTokens: 100,
      outputTokens: 100,
    }),
    { type: "assistant/message", seq: 99, time: base + 800_000, data: { turn: 2, step: 2, stream: [] } },
    "{corrupt truncated trailing json line",
  ];

  const text = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  const parsed = parseSessionJsonl(text, base);

  assert.equal(parsed.isSubagent, true);
  assert.equal(parsed.calls.length, 4);

  assert.equal(parsed.calls[0].provider, "finish-prov");
  assert.equal(parsed.calls[0].model, "finish-model");
  assert.equal(parsed.calls[0].contextWindow, 128_000);
  assert.equal(parsed.calls[0].cacheWrite, 500);
  assert.equal(parsed.calls[0].firstTokenSec, 2.5);
  assert.equal(parsed.calls[0].generationSec, 2);

  assert.equal(parsed.calls[1].provider, "ctx-prov");
  assert.equal(parsed.calls[1].model, "ctx-model");
  assert.equal(parsed.calls[1].firstTokenSec, 300);
  assert.equal(parsed.calls[1].generationSec, undefined);

  assert.equal(parsed.calls[2].firstTokenSec, 0);
  assert.equal(parsed.calls[2].generationSec, 1);

  assert.equal(parsed.calls[3].firstTokenSec, undefined);
  assert.equal(parsed.calls[3].generationSec, 2);
});

test("engine parses zstd + jsonl, caches incrementally, invalidates on edit, prunes deleted, and tolerates corrupt files", async () => {
  const dir = makeTempDir();
  try {
    const sessionsDir = path.join(dir, "sessions");
    const cachePath = usageCachePath(dir);
    const fixedNow = new Date(2026, 10, 20, 14, 30, 0, 0).getTime();

    // 1. Compressed .v4.jsonl.zstd main session
    writeSessionFile(
      sessionsDir,
      "proj-a/sess-main/session.v4.jsonl.zstd",
      [
        sessionHeader({ id: "sess-main", delegationDepth: 0 }),
        ...makeCallLines({
          turn: 1,
          step: 1,
          stepStartMs: fixedNow - 10_000,
          firstTokenMs: fixedNow - 8_000,
          finishMs: fixedNow - 4_000,
          eventMs: fixedNow - 4_000,
          provider: "route-alpha",
          model: "model-usd",
          inputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          outputTokens: 100_000,
        }),
      ],
      { zstd: true, mtimeMs: fixedNow - 60_000 },
    );

    // 2. Uncompressed .jsonl subagent session (delegationDepth > 0 without origin)
    const subFile = writeSessionFile(
      sessionsDir,
      "proj-a/sess-sub/session.jsonl",
      [
        sessionHeader({ id: "sess-sub", delegationDepth: 1 }),
        ...makeCallLines({
          turn: 1,
          step: 1,
          stepStartMs: fixedNow - 20_000,
          firstTokenMs: fixedNow - 19_000,
          finishMs: fixedNow - 17_000,
          eventMs: fixedNow - 17_000,
          provider: "route-beta",
          model: "model-cny",
          inputTokens: 500_000,
          cacheReadTokens: 0,
          outputTokens: 50_000,
        }),
      ],
      { zstd: false, mtimeMs: fixedNow - 60_000 },
    );

    // 3. Corrupt zstd file (old enough to be cached as corrupt)
    const corruptPath = path.join(sessionsDir, "proj-a/sess-corrupt/session.v4.jsonl.zstd");
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, Buffer.from("not-valid-zstd-bytes-at-all"));
    const oldSec = (fixedNow - 120_000) / 1000;
    fs.utimesSync(corruptPath, oldSec, oldSec);

    // 4. Ignored lock and backup files
    fs.writeFileSync(path.join(sessionsDir, "proj-a/sess-main/session.lock"), "pid=123");
    fs.writeFileSync(path.join(sessionsDir, "proj-a/sess-main/session.v4.jsonl.zstd.bak-rewind"), "ignored");

    const engine = new UsageStatsEngine({
      dshHome: dir,
      pricer: makeMixedCurrencyPricer(),
      now: () => fixedNow,
    });

    const first = await engine.refresh();
    assert.equal(first.scanned, 3);
    assert.equal(first.parsed, 3);
    assert.equal(first.corrupt, 1);
    assert.equal(first.pruned, 0);

    // Cache file exists with version 1 and no leftover .tmp files
    assert.equal(fs.existsSync(cachePath), true);
    const cacheDirFiles = fs.readdirSync(path.dirname(cachePath));
    assert.deepEqual(cacheDirFiles, ["paseo-dsh-usage-v1.json"]);
    const diskCache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.equal(diskCache.version, 1);
    assert.equal(Object.keys(diskCache.files).length, 3);
    assert.equal(diskCache.files["proj-a/sess-main/session.v4.jsonl.zstd"].isSubagent, false);
    assert.equal(diskCache.files["proj-a/sess-sub/session.jsonl"].isSubagent, true);
    assert.equal(diskCache.files["proj-a/sess-corrupt/session.v4.jsonl.zstd"].corrupt, true);

    // Warm refresh on a brand-new engine instance hits disk cache with 0 files re-parsed!
    const engine2 = new UsageStatsEngine({
      dshHome: dir,
      pricer: makeMixedCurrencyPricer(),
      now: () => fixedNow,
    });
    const warm = await engine2.refresh();
    assert.equal(warm.scanned, 3);
    assert.equal(warm.parsed, 0);
    assert.equal(warm.pruned, 0);

    // Modify subagent file -> only that 1 file is re-parsed
    writeSessionFile(
      sessionsDir,
      "proj-a/sess-sub/session.jsonl",
      [
        sessionHeader({ id: "sess-sub", delegationDepth: 1 }),
        ...makeCallLines({
          turn: 1,
          step: 1,
          stepStartMs: fixedNow - 20_000,
          firstTokenMs: fixedNow - 19_000,
          finishMs: fixedNow - 17_000,
          eventMs: fixedNow - 17_000,
          provider: "route-beta",
          model: "model-cny",
          inputTokens: 500_000,
          outputTokens: 50_000,
        }),
        ...makeCallLines({
          turn: 1,
          step: 2,
          stepStartMs: fixedNow - 15_000,
          firstTokenMs: fixedNow - 14_000,
          finishMs: fixedNow - 13_000,
          eventMs: fixedNow - 13_000,
          provider: "route-beta",
          model: "model-cny",
          inputTokens: 250_000,
          outputTokens: 25_000,
        }),
      ],
      { zstd: false, mtimeMs: fixedNow - 5_000 },
    );

    const afterEdit = await engine2.refresh();
    assert.equal(afterEdit.scanned, 3);
    assert.equal(afterEdit.parsed, 1);
    assert.equal(afterEdit.pruned, 0);

    const statsAfterEdit = await engine2.stats({ range: "24h" });
    assert.equal(statsAfterEdit.totals.requests, 3);

    // Delete subagent file -> auto-pruned from cache and stats
    fs.unlinkSync(subFile);
    const afterDelete = await engine2.refresh();
    assert.equal(afterDelete.scanned, 2);
    assert.equal(afterDelete.parsed, 0);
    assert.equal(afterDelete.pruned, 1);

    const statsAfterDelete = await engine2.stats({ range: "24h" });
    assert.equal(statsAfterDelete.totals.requests, 1);
    assert.equal(statsAfterDelete.hasSubagents, false);

    // Corrupt disk cache file is ignored and rebuilt cleanly on restart
    fs.writeFileSync(cachePath, "{not valid json");
    const engine3 = new UsageStatsEngine({
      dshHome: dir,
      pricer: makeMixedCurrencyPricer(),
      now: () => fixedNow,
    });
    const rebuilt = await engine3.refresh();
    assert.equal(rebuilt.scanned, 2);
    assert.equal(rebuilt.parsed, 2);

    engine.dispose();
    engine2.dispose();
    engine3.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mixed-currency pricer aggregation, unpriced exclusion, scope/provider/model filtering, and schema validation", async () => {
  const dir = makeTempDir();
  try {
    const sessionsDir = path.join(dir, "sessions");
    const fixedNow = new Date(2026, 10, 20, 15, 0, 0, 0).getTime();

    // Main session on route-alpha with model-usd + model-unpriced
    // model-usd cost in USD: (1M*2 + 1M*0.2 + 0.5M*0.5 + 0.1M*10)/1M = 2 + 0.2 + 0.25 + 1.0 = $3.45
    writeSessionFile(sessionsDir, "main-1.jsonl", [
      sessionHeader({ id: "main-1", delegationDepth: 0 }),
      ...makeCallLines({
        turn: 1,
        step: 1,
        stepStartMs: fixedNow - 30_000,
        firstTokenMs: fixedNow - 28_000, // TTFT = 2s
        finishMs: fixedNow - 24_000, // gen = 4s, output = 100k -> >3000 tok/s (filtered!)
        eventMs: fixedNow - 24_000,
        provider: "route-alpha",
        model: "model-usd",
        inputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 500_000,
        outputTokens: 100_000,
      }),
      ...makeCallLines({
        turn: 1,
        step: 2,
        stepStartMs: fixedNow - 20_000,
        firstTokenMs: fixedNow - 16_000, // TTFT = 4s
        finishMs: fixedNow - 14_000, // gen = 2s, output = 400 -> 200 tok/s (valid!)
        eventMs: fixedNow - 14_000,
        provider: "route-alpha",
        model: "model-unpriced",
        inputTokens: 2_000,
        cacheReadTokens: 8_000,
        outputTokens: 400,
      }),
    ]);

    // Subagent session on route-beta with model-cny
    // model-cny cost in CNY: (1M*7.2 + 1M*0.72 + 0.5M*14.4)/1M = 7.2 + 0.72 + 7.2 = ¥15.12 -> $2.10 USD
    writeSessionFile(sessionsDir, "sub-1.jsonl", [
      sessionHeader({ id: "sub-1", origin: "subagent", delegationDepth: 1 }),
      ...makeCallLines({
        turn: 1,
        step: 1,
        stepStartMs: fixedNow - 10_000,
        firstTokenMs: fixedNow - 9_000, // TTFT = 1s
        finishMs: fixedNow - 4_000, // gen = 5s, output = 500 -> 100 tok/s (valid!)
        eventMs: fixedNow - 4_000,
        provider: "route-beta",
        model: "model-cny",
        inputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 500_000,
      }),
    ]);

    // Wait: 500,000 output over 5s is 100,000 tok/s (>3000), let's add a realistic speed call on route-beta too
    writeSessionFile(sessionsDir, "sub-2.jsonl", [
      sessionHeader({ id: "sub-2", origin: "subagent", delegationDepth: 1 }),
      ...makeCallLines({
        turn: 1,
        step: 1,
        stepStartMs: fixedNow - 5_000,
        firstTokenMs: fixedNow - 4_000, // TTFT = 1s
        finishMs: fixedNow - 2_000, // gen = 2s, output = 200 -> 100 tok/s (valid!)
        eventMs: fixedNow - 2_000,
        provider: "route-beta",
        model: "model-unpriced",
        inputTokens: 500,
        outputTokens: 200,
      }),
    ]);

    const engine = new UsageStatsEngine({
      dshHome: dir,
      pricer: makeMixedCurrencyPricer({ displayCurrency: "USD", usdToCnyRate: 7.2 }),
      now: () => fixedNow,
    });

    // Default USD query
    const statsUsd = await engine.stats({ range: "24h" });
    usageStatsSchema.parse(statsUsd);

    assert.equal(statsUsd.bins.length, 24);
    assert.equal(statsUsd.binMs, 3_600_000);
    assert.equal(statsUsd.sparklines.tokens.length, 24);
    assert.equal(statsUsd.sparklines.cost.length, 24);
    assert.equal(statsUsd.sparklines.requests.length, 24);
    assert.equal(statsUsd.sparklines.tps.length, 24);
    assert.equal(statsUsd.sparklines.cacheHitRate.length, 24);
    assert.equal(statsUsd.sparklines.firstTokenSec.length, 24);

    assert.equal(statsUsd.displayCurrency, "USD");
    assert.equal(statsUsd.hasCustomPricing, true);
    assert.equal(statsUsd.hasSubagents, true);
    assert.equal(statsUsd.sessions, 3);
    assert.equal(statsUsd.totals.requests, 4);
    assert.equal(statsUsd.totals.pricedRequests, 2); // model-usd + model-cny only!
    assert.ok(Math.abs(statsUsd.totals.cost - (3.45 + 2.10)) < 1e-9, `expected 5.55, got ${statsUsd.totals.cost}`);

    // Verify TPS excludes burst calls (>3000 tok/s): only 400/2s and 200/2s are valid -> 600 / 4s = 150 tok/s
    const derived = deriveUsageMetrics(statsUsd.totals);
    assert.equal(statsUsd.totals.generationSeconds, 4);
    assert.equal(statsUsd.totals.generationOutput, 600);
    assert.equal(derived.tps, 150);
    // Mean TTFT: (2 + 4 + 1 + 1) / 4 = 2s
    assert.equal(derived.firstTokenSec, 2);

    // Provider chips have both providers with converted costs
    assert.equal(statsUsd.providers.length, 2);
    const provAlpha = statsUsd.providers.find((p) => p.provider === "route-alpha");
    const provBeta = statsUsd.providers.find((p) => p.provider === "route-beta");
    assert.ok(provAlpha && provBeta);
    assert.equal(provAlpha.requests, 2);
    assert.equal(provAlpha.pricedRequests, 1);
    assert.ok(Math.abs(provAlpha.cost - 3.45) < 1e-9);
    assert.equal(provBeta.requests, 2);
    assert.equal(provBeta.pricedRequests, 1);
    assert.ok(Math.abs(provBeta.cost - 2.10) < 1e-9);

    // Model rows show priced state & shares summing to 1
    assert.equal(statsUsd.models.length, 4);
    const shareSum = statsUsd.models.reduce((acc, m) => acc + m.share, 0);
    assert.ok(Math.abs(shareSum - 1) < 1e-9);
    const rowUsd = statsUsd.models.find((m) => m.id === "route-alpha/model-usd");
    const rowUnpriced = statsUsd.models.find((m) => m.id === "route-alpha/model-unpriced");
    assert.equal(rowUsd.priced, "full");
    assert.equal(rowUnpriced.priced, "none");
    assert.equal(rowUnpriced.cost, 0);
    assert.equal(rowUnpriced.pricedRequests, 0);

    // Currency override to CNY: $3.45 * 7.2 + ¥15.12 = ¥24.84 + ¥15.12 = ¥39.96
    const statsCny = await engine.stats({ range: "24h", currency: "CNY" });
    assert.equal(statsCny.displayCurrency, "CNY");
    assert.ok(Math.abs(statsCny.totals.cost - (3.45 * 7.2 + 15.12)) < 1e-9);

    // Scope filtering
    const mainOnly = await engine.stats({ range: "24h", scope: "main" });
    assert.equal(mainOnly.totals.requests, 2);
    assert.equal(mainOnly.breakdown.main.requests, 2);
    assert.equal(mainOnly.breakdown.subagent.requests, 2);

    const subOnly = await engine.stats({ range: "24h", scope: "subagent" });
    assert.equal(subOnly.totals.requests, 2);
    assert.equal(subOnly.sessions, 2);

    // Provider filter narrows totals/models while keeping both providers in provider chips
    const betaOnly = await engine.stats({ range: "24h", provider: "route-beta" });
    assert.equal(betaOnly.totals.requests, 2);
    assert.equal(betaOnly.providers.length, 2);
    assert.equal(betaOnly.models.length, 2);

    // Model filter matches both bare model name and composite provider/model, keeping table intact
    const bareModel = await engine.stats({ range: "24h", model: "model-unpriced" });
    assert.equal(bareModel.totals.requests, 2);
    assert.equal(bareModel.models.length, 4);

    const compositeModel = await engine.stats({ range: "24h", model: "route-alpha/model-unpriced" });
    assert.equal(compositeModel.totals.requests, 1);
    assert.equal(compositeModel.models.length, 4);

    // 7d and 30d bin counts
    const stats7d = await engine.stats({ range: "7d" });
    assert.equal(stats7d.bins.length, 28);
    assert.equal(stats7d.binMs, 6 * 3_600_000);

    const stats30d = await engine.stats({ range: "30d" });
    assert.equal(stats30d.bins.length, 30);
    assert.equal(stats30d.binMs, 86_400_000);

    engine.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("365-day (371-day) daily rollups compute activeDays, maxDay, activeDailyAvg, streak, and window cutoffs", async () => {
  const dir = makeTempDir();
  try {
    const sessionsDir = path.join(dir, "sessions");
    const fixedNow = new Date(2026, 10, 20, 12, 0, 0, 0).getTime();
    const dayAt = (daysAgo) => new Date(2026, 10, 20 - daysAgo, 10, 0, 0, 0).getTime();

    // Activity on yesterday (1d ago), 2d ago, 3d ago -> 3-day active streak even when today has 0 calls!
    // Plus activity 10d ago (busiest day!) and 400d ago (outside 371-day window, must be excluded).
    writeSessionFile(sessionsDir, "history.jsonl", [
      sessionHeader({ id: "hist-1", delegationDepth: 0 }),
      ...makeCallLines({
        turn: 1,
        step: 1,
        eventMs: dayAt(400),
        finishMs: dayAt(400),
        provider: "route-alpha",
        model: "model-usd",
        inputTokens: 999_999,
        outputTokens: 1,
      }),
      ...makeCallLines({
        turn: 1,
        step: 2,
        eventMs: dayAt(10),
        finishMs: dayAt(10),
        provider: "route-alpha",
        model: "model-usd",
        inputTokens: 50_000,
        outputTokens: 10_000,
      }),
      ...makeCallLines({
        turn: 1,
        step: 3,
        eventMs: dayAt(3),
        finishMs: dayAt(3),
        provider: "route-alpha",
        model: "model-usd",
        inputTokens: 5_000,
        outputTokens: 1_000,
      }),
      ...makeCallLines({
        turn: 1,
        step: 4,
        eventMs: dayAt(2),
        finishMs: dayAt(2),
        provider: "route-alpha",
        model: "model-usd",
        inputTokens: 8_000,
        outputTokens: 2_000,
      }),
      ...makeCallLines({
        turn: 1,
        step: 5,
        eventMs: dayAt(1),
        finishMs: dayAt(1),
        provider: "route-alpha",
        model: "model-usd",
        inputTokens: 4_000,
        outputTokens: 1_000,
      }),
    ]);

    const engine = new UsageStatsEngine({
      dshHome: dir,
      pricer: makeMixedCurrencyPricer(),
      now: () => fixedNow,
    });

    const daily = await engine.daily({});
    usageDailySchema.parse(daily);

    assert.equal(daily.today, localDayKey(fixedNow));
    assert.equal(daily.days.length, 4);
    assert.equal(daily.summary.activeDays, 4);
    assert.equal(daily.summary.totalRequests, 4);
    assert.equal(daily.summary.totalTokens, 60_000 + 6_000 + 10_000 + 5_000);
    assert.equal(daily.summary.activeDailyAvgTokens, 81_000 / 4);
    assert.equal(daily.summary.streak, 3);
    assert.equal(daily.summary.maxDay.date, localDayKey(dayAt(10)));
    assert.equal(daily.summary.maxDay.tokens, 60_000);
    assert.equal(daily.summary.maxDay.requests, 1);
    assert.ok(daily.summary.maxDay.cost > 0);
    assert.equal(DAILY_HISTORY_DAYS, 371);

    // Adding a call today bumps streak to 4
    writeSessionFile(sessionsDir, "today.jsonl", [
      sessionHeader({ id: "today-1", origin: "subagent", delegationDepth: 1 }),
      ...makeCallLines({
        turn: 1,
        step: 1,
        eventMs: fixedNow - 1_000,
        finishMs: fixedNow - 1_000,
        provider: "route-alpha",
        model: "model-usd",
        inputTokens: 2_000,
        outputTokens: 500,
      }),
    ]);

    const dailyWithToday = await engine.daily({});
    assert.equal(dailyWithToday.summary.activeDays, 5);
    assert.equal(dailyWithToday.summary.streak, 4);
    assert.equal(dailyWithToday.hasSubagents, true);

    // Filter to main only -> today's subagent excluded, streak returns to 3
    const mainDaily = await engine.daily({ scope: "main" });
    assert.equal(mainDaily.summary.activeDays, 4);
    assert.equal(mainDaily.summary.streak, 3);

    engine.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("background prewarm, registerUsageStatsRpc, buildCalendarBins, and UNPRICED_PRICER work cleanly", async () => {
  const dir = makeTempDir();
  try {
    const sessionsDir = path.join(dir, "sessions");
    const fixedNow = new Date(2026, 10, 20, 16, 15, 0, 0).getTime();
    writeSessionFile(sessionsDir, "solo.jsonl", [
      sessionHeader({ id: "solo", delegationDepth: 0 }),
      ...makeCallLines({
        turn: 1,
        step: 1,
        stepStartMs: fixedNow - 5_000,
        firstTokenMs: fixedNow - 4_000,
        finishMs: fixedNow - 3_000,
        eventMs: fixedNow - 3_000,
        provider: "route-alpha",
        model: "unknown-family-x",
        inputTokens: 1_000,
        outputTokens: 500,
      }),
    ]);

    const engine = new UsageStatsEngine({
      dshHome: dir,
      pricer: UNPRICED_PRICER,
      prewarmDelayMs: 25,
      now: () => fixedNow,
    });

    const handlers = new Map();
    const mockServer = {
      handle(rpc, fn) {
        handlers.set(rpc.name, fn);
      },
    };

    const contextsSeen = [];
    const dispose = registerUsageStatsRpc(mockServer, engine, {
      startPrewarm: true,
      prewarmDelayMs: 25,
      onContext: (ctx) => contextsSeen.push(ctx),
    });
    assert.equal(handlers.has(usageStatsRpc.name), true);
    assert.equal(handlers.has(usageDailyRpc.name), true);
    assert.equal(usageStatsRpc.name, "dsh.usage.stats");
    assert.equal(usageDailyRpc.name, "dsh.usage.daily");

    // Wait briefly for prewarm timer to fire and populate disk cache
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(fs.existsSync(engine.cachePath), true);
    assert.deepEqual(engine.getIndexingStatus(), { active: false, done: 1, total: 1 });

    const rpcStats = await handlers.get("dsh.usage.stats")({ range: "24h" }, { tag: "ctx-1" });
    usageStatsSchema.parse(rpcStats);
    assert.equal(rpcStats.totals.requests, 1);
    assert.equal(rpcStats.totals.pricedRequests, 0);
    assert.equal(rpcStats.totals.cost, 0);
    assert.equal(rpcStats.models[0].priced, "none");

    const rpcDaily = await handlers.get("dsh.usage.daily")({}, { tag: "ctx-2" });
    usageDailySchema.parse(rpcDaily);
    assert.equal(rpcDaily.summary.totalCost, null);
    assert.equal(rpcDaily.summary.activeDays, 1);
    assert.deepEqual(contextsSeen, [{ tag: "ctx-1" }, { tag: "ctx-2" }]);

    const seen = await engine.seenModels();
    assert.deepEqual(seen, [{ provider: "route-alpha", model: "unknown-family-x", pricingKey: "unknown-family-x" }]);
    const seenMap = await engine.seenPricingModels();
    assert.equal(seenMap.get("unknown-family-x"), "unknown-family-x");

    // Non-canonical JSON key order (type not first) still parses accurately
    const reordered = parseSessionJsonl(
      [
        JSON.stringify(sessionHeader({ id: "reord", delegationDepth: 0 })),
        JSON.stringify({ seq: 2, time: fixedNow - 3_000, type: "step/start", data: { turn: 1, step: 1 } }),
        JSON.stringify({
          seq: 3,
          time: fixedNow - 1_000,
          type: "assistant/message",
          data: {
            turn: 1,
            step: 1,
            usage: { inputTokens: 100, outputTokens: 50 },
            stream: [
              { type: "chunk", time: fixedNow - 2_000, chunk: { type: "text-delta", text: "ok" } },
              {
                type: "chunk",
                time: fixedNow - 1_000,
                chunk: { type: "finish", replayState: { response: { provider: "reord-prov", model: "reord-model" } } },
              },
            ],
          },
        }),
      ].join("\n"),
      fixedNow,
    );
    assert.equal(reordered.calls.length, 1);
    assert.equal(reordered.calls[0].provider, "reord-prov");
    assert.equal(reordered.calls[0].model, "reord-model");
    assert.equal(reordered.calls[0].firstTokenSec, 1);
    assert.equal(reordered.calls[0].generationSec, 1);

    // Live indexing progress reporting during multi-batch refresh (concurrency: 1)
    const batchDir = makeTempDir("paseo-usage-batch-");
    try {
      const batchSessions = path.join(batchDir, "sessions");
      for (let i = 0; i < 6; i += 1) {
        writeSessionFile(
          batchSessions,
          `sess-${i}.v4.jsonl.zstd`,
          [
            sessionHeader({ id: `s-${i}`, delegationDepth: 0 }),
            ...makeCallLines({
              turn: 1,
              step: 1,
              eventMs: fixedNow - 1_000 * (i + 1),
              finishMs: fixedNow - 1_000 * (i + 1),
              provider: "route-alpha",
              model: "model-usd",
              inputTokens: 100,
              outputTokens: 50,
            }),
          ],
          { zstd: true },
        );
      }
      const batchEngine = new UsageStatsEngine({
        dshHome: batchDir,
        concurrency: 1,
        now: () => fixedNow,
      });
      const refreshPromise = batchEngine.refresh();
      // Poll immediately with waitMs: 0 while discovery/batched indexing is active
      const midStats = await batchEngine.stats({ range: "24h" }, { waitMs: 0 });
      usageStatsSchema.parse(midStats);
      assert.equal(midStats.indexing.active, true);
      await refreshPromise;
      const doneStats = await batchEngine.stats({ range: "24h" });
      assert.deepEqual(doneStats.indexing, { active: false, done: 6, total: 6 });
      assert.equal(doneStats.totals.requests, 6);
      batchEngine.dispose();
    } finally {
      fs.rmSync(batchDir, { recursive: true, force: true });
    }

    // Verify monotonic calendar bins
    for (const range of ["24h", "7d", "30d"]) {
      const bins = buildCalendarBins(fixedNow, range);
      for (let i = 1; i < bins.length; i += 1) {
        assert.equal(bins[i].start, bins[i - 1].end);
      }
    }

    dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
