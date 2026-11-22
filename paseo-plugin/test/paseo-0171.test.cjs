require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const {
  ProviderEventSchema,
  ProviderInspectionSchema,
} = require("@getpaseo/plugin/server/provider");
const { createDshProvider } = require("../server/provider.ts");
const { DshSession, modes } = require("../server/session.ts");

function withEnv(patch, fn) {
  const saved = new Map();
  for (const key of Object.keys(patch)) {
    saved.set(key, process.env[key]);
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function makeFakeDsh(t, body) {
  const dir = mkdtempSync(join(tmpdir(), "paseo-dsh-0171-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "dsh");
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

test("Paseo 0.17.1 provider installation contract reports installed version and missing binary", async (t) => {
  const provider = createDshProvider();
  assert.ok(provider.installation, "provider declares installation metadata");
  assert.equal(provider.installation.installUrl, "https://www.npmjs.com/package/@deepseek-ai/dsh");
  assert.equal(typeof provider.installation.inspect, "function");

  const versioned = makeFakeDsh(t, 'if (process.argv.includes("--version")) console.log("0.2.2-rc.5");');
  await withEnv({ DSH_BINARY: versioned.bin }, async () => {
    const result = await provider.installation.inspect({ signal: new AbortController().signal });
    assert.deepEqual(ProviderInspectionSchema.parse(result), {
      status: "installed",
      version: "0.2.2-rc.5",
    });
  });

  const silent = makeFakeDsh(t, "// prints nothing on --version");
  await withEnv({ DSH_BINARY: silent.bin }, async () => {
    const result = await provider.installation.inspect({ signal: new AbortController().signal });
    assert.deepEqual(ProviderInspectionSchema.parse(result), {
      status: "installed",
    });
  });

  const emptyDir = mkdtempSync(join(tmpdir(), "paseo-dsh-empty-"));
  t.after(() => rmSync(emptyDir, { recursive: true, force: true }));
  await withEnv({ DSH_BINARY: undefined, PATH: emptyDir, HOME: emptyDir }, async () => {
    const result = await provider.installation.inspect({ signal: new AbortController().signal });
    assert.deepEqual(ProviderInspectionSchema.parse(result), {
      status: "not_installed",
    });
  });

  await withEnv({ DSH_BINARY: join(emptyDir, "missing-dsh") }, async () => {
    await assert.rejects(
      () => provider.installation.inspect({ signal: new AbortController().signal }),
      /DSH_BINARY is set to/,
    );
  });
});

test("Paseo 0.17.1 session.commands forwards kind='command' and kind='skill'", async (t) => {
  const dshHomeDir = mkdtempSync(join(tmpdir(), "paseo-dsh-home-"));
  t.after(() => rmSync(dshHomeDir, { recursive: true, force: true }));

  const events = [];
  const fakeProcess = {
    async attachSession() {},
    async closeSession() {},
    async commands() {
      return [
        { name: "goal", description: "Manage session goal", argumentHint: "<action>", kind: "command" },
        { name: "custom-skill", description: "Run custom skill", kind: "skill" },
      ];
    },
    async translate() {
      return [];
    },
  };

  const session = new DshSession({
    sessionId: "sess-0171",
    cwd: dshHomeDir,
    env: { DSH_HOME: dshHomeDir },
    route: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: null },
    mode: "build",
    modes: modes(false),
    models: [],
    thinkingOptions: [],
    subsession: false,
    emit: (event) => events.push(event),
    log: () => {},
    acquireProcess: async () => ({ process: fakeProcess, reused: false }),
    releaseProcess: async () => {},
  });

  await session.open();
  await session.loadCommands();

  const cmdEvent = events.find((e) => e.type === "session.commands");
  assert.ok(cmdEvent, "emitted session.commands event");
  const parsed = ProviderEventSchema.parse(cmdEvent);
  assert.equal(parsed.type, "session.commands");

  const byName = new Map(parsed.commands.map((c) => [c.name, c]));
  assert.equal(byName.get("goal")?.kind, "command");
  assert.equal(byName.get("custom-skill")?.kind, "skill");
  await session.close();
});
