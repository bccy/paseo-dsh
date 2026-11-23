require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PROVIDER_CAPABILITIES } = require("@getpaseo/plugin/server/provider");
const { createDshProvider, toDisplayCatalog } = require("../server/provider.ts");

test("Paseo 0.17.3 provider registration exposes valid http(s) docsUrl", () => {
  const provider = createDshProvider();
  assert.equal(typeof provider.docsUrl, "string");
  const parsed = new URL(provider.docsUrl);
  assert.ok(parsed.protocol === "https:" || parsed.protocol === "http:");
  assert.ok(PROVIDER_CAPABILITIES.includes("session.metrics"), "SDK includes 0.17.2+ session.metrics capability");
});

test("Paseo 0.17.3 toDisplayCatalog preserves per-model defaultThinkingOptionId fallback (#10524)", () => {
  const display = toDisplayCatalog({
    providers: [{ id: "acme", name: "Acme" }],
    defaultProvider: "acme",
    defaultModel: "inherits-global",
    defaultReasoningEffort: "high",
    models: [
      {
        provider: "acme",
        id: "explicit-default",
        name: "Explicit",
        reasoning: {
          defaultEffort: "low",
          efforts: [{ id: "low" }, { id: "high" }],
        },
      },
      {
        provider: "acme",
        id: "inherits-global",
        name: "Inherits Global",
        reasoning: {
          efforts: [{ id: "medium" }, { id: "high" }],
        },
      },
      {
        provider: "acme",
        id: "unsupported-global",
        name: "Unsupported Global",
        reasoning: {
          efforts: [{ id: "low" }, { id: "medium" }],
        },
      },
      {
        provider: "acme",
        id: "no-reasoning",
        name: "No Reasoning",
      },
    ],
  });

  const byId = new Map(display.models.map((m) => [m.id, m]));
  assert.equal(byId.get("acme/explicit-default")?.defaultThinkingOptionId, "low");
  assert.equal(byId.get("acme/inherits-global")?.defaultThinkingOptionId, "high");
  assert.equal(byId.get("acme/unsupported-global")?.defaultThinkingOptionId, undefined);
  assert.equal(byId.get("acme/no-reasoning")?.defaultThinkingOptionId, undefined);
  assert.equal(byId.get("acme/no-reasoning")?.thinkingOptions, undefined);
});
