// The stream-stats row is a plugin timeline item, and Paseo accepts a plugin's
// items only under that plugin's own ID: one under another ID fails the whole
// provider connection. A plugin that reuses this provider under its own ID
// passes it to createDshProvider, and the row must carry it.
require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { performance } = require("node:perf_hooks");
const { createDshProvider } = require("../server/provider.ts");
const { ProviderEventSchema, PROVIDER_CAPABILITIES } = require("@getpaseo/plugin/server/provider");

// A fake DSH executable that answers each prompt with one streamed model step:
// the frames that time it, then the committed message that ends it.
async function fixture(t, options) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-plugin-id-")));
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, "profiles", "paseo"), { recursive: true });
  const cli = path.join(dir, "fake-dsh.cjs");
  fs.writeFileSync(
    cli,
    `#!${process.execPath}
if (process.argv.includes("--version")) {
  process.stdout.write("0.2.1-fixture\\n");
  process.exit(0);
}
const send = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const r = JSON.parse(line);
  if (!r.method) return;
  let result = {};
  if (r.method === "paseo/config/set") {
    result = { provider: "fixture", model: "fixture", reasoningEffort: r.params?.reasoningEffort ?? null };
  } else if (r.method === "paseo/catalog") {
    result = {
      providers: [{ id: "fixture", name: "Fixture" }],
      models: [{ provider: "fixture", id: "fixture", name: "Fixture" }],
      defaultProvider: "fixture",
      defaultModel: "fixture",
    };
  } else if (r.method === "paseo/commands") {
    result = { available: true, commands: [] };
  } else if (r.method === "paseo/permission/get") {
    result = { available: false };
  } else if (r.method === "paseo/presets") {
    result = { available: false };
  } else if (r.method === "paseo/settings/list") {
    result = { available: false };
  } else if (r.method === "session/prompt") {
    const sid = r.params?.sessionId ?? "root";
    const now = Date.now();
    send({
      jsonrpc: "2.0",
      method: "session.event",
      params: {
        sessionId: sid,
        event: {
          type: "paseo/assistant-delta",
          data: {
            turn: 1,
            step: 1,
            startedAt: now - 50,
            firstTextAt: now,
            text: "Hello there",
          },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session.event",
      params: {
        sessionId: sid,
        event: {
          type: "assistant/message",
          time: now + 100,
          data: { turn: 1, step: 1, usage: { outputTokens: 4 }, message: { content: [{ type: "text", text: "Hello there" }] } },
        },
      },
    });
  }
  send({ jsonrpc: "2.0", id: r.id, result });
  if (r.method === "shutdown") process.exit(0);
});
`,
  );
  fs.chmodSync(cli, 0o755);

  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_BINARY: process.env.DSH_BINARY,
    DSH_PASEO_PROFILE: process.env.DSH_PASEO_PROFILE,
  };
  process.env.DSH_HOME = home;
  process.env.DSH_BINARY = cli;
  delete process.env.DSH_PASEO_PROFILE;

  const connection = await createDshProvider(options).connect({
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
  });
  const events = [];
  connection.onEvent((event) => {
    ProviderEventSchema.parse(event);
    events.push(event);
  });

  t.after(async () => {
    await connection.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  await connection.send({
    type: "session.open",
    requestId: "open",
    sessionId: "root",
    history: "skip",
    config: { cwd: dir, env: {}, persist: true, settings: {} },
  });
  const readyDeadline = performance.now() + 5000;
  while (performance.now() < readyDeadline) {
    if (events.some((e) => e.type === "session.ready" && e.sessionId === "root")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(
    events.some((e) => e.type === "session.ready" && e.sessionId === "root"),
    "session did not become ready",
  );

  async function statsRow() {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const hit = events.find(
        (e) => e.type === "timeline.item" && e.item.type === "plugin" && e.item.kind === "dsh-stream-stats",
      );
      if (hit) return hit.item;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("no stream-stats row");
  }
  return { connection, events, statsRow };
}

async function promptOnce(f) {
  await f.connection.send({
    type: "session.prompt",
    sessionId: "root",
    prompt: {
      clientMessageId: "msg-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hi" }] },
    },
  });
  return f.statsRow();
}

test("a provider created with a plugin ID tags the stream-stats row with it", async (t) => {
  const f = await fixture(t, { pluginId: "dsh-wrapper" });
  const row = await promptOnce(f);
  assert.equal(row.pluginId, "dsh-wrapper");
  assert.equal(row.data.outputTokens, 4);
  assert(!f.events.some((e) => e.type === "request.failed"));
});

test("without a plugin ID the row keeps the default dsh-paseo owner", async (t) => {
  const f = await fixture(t);
  const row = await promptOnce(f);
  assert.equal(row.pluginId, "dsh-paseo");
});
