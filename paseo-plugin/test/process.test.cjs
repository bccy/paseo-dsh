/**
 * Process-level regression for the Windows npm launcher path.
 *
 * These tests exist because a DSH installed with `npm -g` on Windows is a
 * `dsh.cmd` shim, and both `spawn("dsh", ...)` and `execFile("dsh.cmd", ...)`
 * fail there (EINVAL / not executable). The plugin therefore resolves the shim
 * to its Node entrypoint with `server/dsh-command.mjs`. Getting that wrong is
 * invisible on macOS/Linux, so the POSIX path and the DSH_BINARY override are
 * pinned here too — a fix that breaks the normal launch would otherwise ship
 * green.
 *
 * The TypeScript process class is compiled through `harness/plugin-build.cjs`
 * first; plain `node --test` cannot require the fork's ESM sources directly
 * (their relative imports are extensionless). Fixtures are isolated temp
 * directories and fake children: no credentials, profile or model calls.
 *
 * Run with: `cd paseo-plugin && npm run test:process`
 */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { delimiter, join, resolve } = require("node:path");
const { test } = require("node:test");

const build = require("../../harness/plugin-build.cjs");
const buildDir = build.buildPlugin({ dir: ".dbg-process-test", quiet: false });
process.on("exit", () => {
  try {
    rmSync(buildDir, { recursive: true, force: true });
  } catch {
    /* a leftover build tree is not a test failure */
  }
});

const { DshProcess, resolveDshBinary } = require(join(buildDir, "server", "dsh-process.js"));
const { resolveDshCommand } = require(join(buildDir, "server", "dsh-command.mjs"));

/**
 * A throwaway npm-style DSH install: `node_modules/@deepseek-ai/dsh` plus a
 * `dsh.cmd` shim beside it (the Windows npm layout), a POSIX `dsh` script for
 * the same directory, and a fake CLI that speaks just enough JSON-RPC.
 */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "paseo dsh 中文 ")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "cli.cjs" } }));
  writeFileSync(join(pkg, "cli.cjs"), `
    const readline = require("node:readline");
    if (process.argv.includes("--version")) { console.log("0.2.2-test"); process.exit(0); }
    process.stderr.write("fixture stderr\\n");
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const frame = JSON.parse(line);
      const result = frame.method === "paseo/catalog"
        ? { providers: [], models: [], cwd: process.cwd(), argv: process.argv.slice(2), marker: process.env.TEST_MARKER, pid: process.pid }
        : {};
      send({ jsonrpc: "2.0", id: frame.id, result });
      if (frame.method === "session/cancel") send({ jsonrpc: "2.0", method: "session.status", params: { status: "idle", sessionId: "fixture" } });
      if (frame.method === "shutdown") process.exit(7);
    });
  `);
  writeFileSync(join(dir, "dsh.cmd"), `@"${process.execPath}" "%~dp0node_modules\\@deepseek-ai\\dsh\\cli.cjs" %*\r\n`);
  writeFileSync(join(dir, "dsh"), '#!/usr/bin/env node\nrequire("./node_modules/@deepseek-ai/dsh/cli.cjs");\n');
  chmodSync(join(dir, "dsh"), 0o755);
  const env = { ...process.env, TEST_MARKER: "session environment", DSH_PASEO_PROFILE: "profile 空白 & %PATH% ! ^ (test)" };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = dir + delimiter + (process.env.PATH ?? process.env.Path ?? "");
  delete env.DSH_BINARY;
  const cwd = join(dir, "working directory");
  mkdirSync(cwd);
  return { dir, pkg, env, cwd };
}

function session(t, f, onSpawned) {
  let exited;
  const exit = new Promise((done) => { exited = done; });
  const logs = [], errors = [], statuses = [];
  const child = new DshProcess({
    cwd: f.cwd,
    env: f.env,
    sessionId: "fixture",
    route: { provider: "test", model: "test" },
    ...(onSpawned === undefined ? {} : { onSpawned }),
    onEvent() {},
    onStatus: (value) => statuses.push(value),
    onQuestion: async () => ({ answers: [] }),
    onLog: (value) => logs.push(value),
    onProtocolError: (value) => errors.push(value),
    onExit: (code, signal) => exited({ code, signal }),
  });
  t.after(() => child.kill());
  return { child, exit, logs, errors, statuses };
}

/** Run `body` with `process.platform` pretending to be `platform`. */
function asPlatform(platform, body) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: platform });
    return body();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

test("npm-installed DSH preserves cwd, argv, env and streamed JSON-RPC; cancel keeps it alive", { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  const s = session(t, f);
  await s.child.start();
  const first = await s.child.catalog();
  assert.equal(first.cwd, f.cwd);
  assert.deepEqual(first.argv, ["--profile", f.env.DSH_PASEO_PROFILE]);
  assert.equal(first.marker, f.env.TEST_MARKER);
  await s.child.cancel("fixture");
  const next = await s.child.catalog();
  assert.equal(next.pid, first.pid);
  // The bridge writes the status notification right after the cancel receipt;
  // the reader delivers it on the next tick.
  await new Promise((done) => setTimeout(done, 100));
  assert(s.statuses.includes("idle"), JSON.stringify(s.statuses));
  assert(s.logs.some((value) => value.includes("fixture stderr")));
  assert.deepEqual(s.errors, []);
  await s.child.shutdown();
  const ended = await s.exit;
  assert(ended.code === 7 || ended.signal === "SIGTERM");
});

test("spawn and the catalog fingerprint resolve the same process-level DSH_BINARY", { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  const binary = join(f.dir, process.platform === "win32" ? "dsh.cmd" : "dsh");
  const prior = process.env.DSH_BINARY;
  process.env.DSH_BINARY = binary;
  // A session env value must not change which binary runs: provider.ts computes
  // the catalog fingerprint with resolveDshBinary() (process.env), so a session
  // override would split the two rules and let a cache entry survive an upgrade.
  f.env.DSH_BINARY = "session-only-must-not-win";
  const spawned = [];
  try {
    const s = session(t, f, (pid, command) => spawned.push(command));
    await s.child.start();
    assert.equal((await s.child.catalog()).cwd, f.cwd);
    assert.deepEqual(spawned, [binary]);
    assert.equal(resolveDshBinary(), binary);
    s.child.kill();
    await s.exit;
  } finally {
    if (prior === undefined) delete process.env.DSH_BINARY;
    else process.env.DSH_BINARY = prior;
  }
});

test("win32 resolves the npm .cmd shim to the package's Node entry", (t) => {
  const f = fixture(t);
  // `resolveDshCommand` splits a Windows PATH on `;`; the fixture's own env uses
  // the host delimiter, so build the simulated Windows env explicitly.
  const winEnv = { ...f.env, PATH: f.dir };
  const launch = asPlatform("win32", () => resolveDshCommand("dsh", winEnv, f.cwd));
  assert.deepEqual(launch, { command: "node.exe", args: [join(f.pkg, "cli.cjs")] });
  // An adjacent node.exe wins, matching npm's own launcher.
  writeFileSync(join(f.dir, "node.exe"), "");
  const withNode = asPlatform("win32", () => resolveDshCommand("dsh", winEnv, f.cwd));
  assert.deepEqual(withNode, { command: join(f.dir, "node.exe"), args: [join(f.pkg, "cli.cjs")] });
  // An explicit path to the shim has the same result.
  const explicit = asPlatform("win32", () => resolveDshCommand(join(f.dir, "dsh.cmd"), winEnv, f.cwd));
  assert.deepEqual(explicit, { command: join(f.dir, "node.exe"), args: [join(f.pkg, "cli.cjs")] });
});

test("win32 keeps a native dsh.exe ahead of the npm shim", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "dsh.exe"), "");
  // Same win32-shaped env as the resolution test: a `;`-joined PATH containing
  // the fixture dir. Reusing `f.env` would hand the win32 branch a host-delimited
  // PATH (Linux `:`), so the directory loop would skip every entry and the
  // assertion would pass vacuously even if the native-exe check were deleted.
  const winEnv = { ...f.env, PATH: f.dir };
  assert.deepEqual(asPlatform("win32", () => resolveDshCommand("dsh", winEnv, f.cwd)), {
    command: "dsh",
    args: [],
  });
});

test("win32 leaves an unrecognized shim for the spawn error instead of guessing", (t) => {
  const f = fixture(t);
  // The normal spawn error must surface: no silent fallback to `dsh.cmd`.
  const missingBinPackage = join(f.dir, "missing-bin", "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(missingBinPackage, { recursive: true });
  writeFileSync(join(missingBinPackage, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "gone.cjs" } }));
  writeFileSync(join(f.dir, "missing-bin", "dsh.cmd"), "@echo off\r\n");
  const env = { ...f.env, PATH: join(f.dir, "missing-bin") };
  assert.deepEqual(asPlatform("win32", () => resolveDshCommand("dsh", env, f.cwd)), {
    command: "dsh",
    args: [],
  });
});
test("macOS/Linux and native executables retain their original launch command", () => {
  for (const platform of ["linux", "darwin"]) {
    asPlatform(platform, () => {
      for (const command of ["dsh", "/opt/tools/dsh", "/home/test/.local/bin/dsh"]) {
        assert.deepEqual(resolveDshCommand(command), { command, args: [] });
      }
    });
  }
  assert.deepEqual(resolveDshCommand(process.execPath), { command: process.execPath, args: [] });
});

test("resolveDshBinary reads only the process environment and treats backslashes as a path", (t) => {
  const f = fixture(t);
  const prior = process.env.DSH_BINARY;
  try {
    process.env.DSH_BINARY = join(f.dir, "dsh");
    assert.equal(resolveDshBinary(), join(f.dir, "dsh"));
    process.env.DSH_BINARY = "custom-dsh";
    assert.equal(resolveDshBinary(), "custom-dsh");
    // A Windows-style path contains only `\` as a separator; it must still take
    // the executable check instead of being handed to spawn as a bare name.
    process.env.DSH_BINARY = "C:\\tools\\dsh.cmd";
    assert.throws(() => resolveDshBinary(), /DSH_BINARY is set to/);
    process.env.DSH_BINARY = "";
    assert.equal(resolveDshBinary(), "dsh");
    // A missing explicit path is an error, never a silent fallback to PATH.
    process.env.DSH_BINARY = join(f.dir, "missing dsh");
    assert.throws(() => resolveDshBinary(), /refusing to fall back/);
  } finally {
    if (prior === undefined) delete process.env.DSH_BINARY;
    else process.env.DSH_BINARY = prior;
  }
});

test("direct Node launch preserves literal arguments, stdin, stderr and nonzero exit code", { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  const launch = asPlatform(process.platform, () => resolveDshCommand("dsh", f.env, f.cwd));
  const args = ["", "space and 中文", 'quote"inside', "trailing\\", "& | < > ^ ( ) ! %PATH%", "line\nbreak"];
  const child = require("node:child_process").spawn(launch.command, [...launch.args, ...args], {
    cwd: f.cwd,
    env: f.env,
    stdio: "pipe",
  });
  t.after(() => child.kill());
  const closed = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => done({ code, signal }));
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "paseo/catalog" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "shutdown" }) + "\n");
  assert.deepEqual(await closed, { code: 7, signal: null });
  const frame = JSON.parse(stdout.split("\n")[0]);
  assert.deepEqual(frame.result.argv, args);
  assert.equal(frame.result.cwd, f.cwd);
  assert.match(stderr, /fixture stderr/);
});

test("win32 explains an unresolved npm launcher instead of a bare spawn error", { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  const priorBinary = process.env.DSH_BINARY;
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  process.env.DSH_BINARY = "dsh.cmd";
  // A PATH without any dsh shim: `resolveDshCommand` cannot resolve the command
  // and Windows would otherwise fail with a bare ENOENT/EINVAL.
  f.env.PATH = join(f.dir, "empty-path");
  mkdirSync(f.env.PATH);
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const s = session(t, f);
    await assert.rejects(s.child.start(), (error) => {
      assert.match(error.message, /Node entry point/);
      assert.match(error.message, /DSH_BINARY/);
      assert.match(error.message, /docs\/WINDOWS\.md/);
      return true;
    });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    if (priorBinary === undefined) delete process.env.DSH_BINARY;
    else process.env.DSH_BINARY = priorBinary;
  }
});

test("missing executable still rejects startup and reports the process error", { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  const prior = process.env.DSH_BINARY;
  process.env.DSH_BINARY = "missing-dsh-regression-fixture";
  try {
    const s = session(t, f);
    // The first rejected request can be the pipe failing before the child's own
    // ENOENT lands; the process error sink is what must name the real cause.
    await assert.rejects(s.child.start());
    await new Promise((done) => setTimeout(done, 100));
    assert(s.errors.some((value) => value.includes("ENOENT")), s.errors.join(" | "));
  } finally {
    if (prior === undefined) delete process.env.DSH_BINARY;
    else process.env.DSH_BINARY = prior;
  }
});

test("doctor detects npm DSH and treats an unavailable Windows Paseo CLI as optional", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dir, "profiles", "paseo", "node_modules", "dsh-paseo-bridge", "lib"), { recursive: true });
  writeFileSync(join(f.dir, "profiles", "paseo", "node_modules", "dsh-paseo-bridge", "lib", "server.js"), "");
  writeFileSync(join(f.dir, "profiles", "paseo", "cordis.patch.yml"), "[]\n");
  const result = spawnSync(process.execPath, [resolve(__dirname, "../bin/paseo-dsh.mjs"), "doctor"], {
    env: { ...f.env, DSH_HOME: f.dir, DSH_PASEO_PROFILE: "paseo", PASEO_CLI: "missing-paseo" },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.match(result.stdout, /dsh 0\.2\.2-test/);
  assert.doesNotMatch(result.stdout, /fail[^\n]*dsh on PATH/);
  if (process.platform === "win32") {
    assert.match(result.stdout, /warn[^\n]*paseo CLI/i);
  }
});

test("doctor still fails for a missing DSH executable", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [resolve(__dirname, "../bin/paseo-dsh.mjs"), "doctor"], {
    env: { ...f.env, DSH_BINARY: "missing-dsh-regression-fixture", DSH_HOME: f.dir, DSH_PASEO_PROFILE: "paseo" },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /fail[^\n]*dsh on PATH/);
});

test("doctor tries the explicit PASEO_CLI executable before PATH discovery", (t) => {
  const f = fixture(t);
  // Node is a portable native executable with a deterministic --version reply.
  // It stands in for the caller-supplied CLI; no globally installed Paseo is needed.
  const result = spawnSync(process.execPath, [resolve(__dirname, "../bin/paseo-dsh.mjs"), "doctor"], {
    env: { ...f.env, DSH_HOME: f.dir, DSH_PASEO_PROFILE: "paseo", PASEO_CLI: process.execPath },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.ok(result.stdout.includes(`paseo ${process.version}`), result.stdout);
  assert.doesNotMatch(result.stdout, /paseo CLI version not checked/);
});
