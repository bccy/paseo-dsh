/**
 * An explicitly configured `DSH_BINARY` must not silently fall back to `dsh`.
 *
 * `DSH_BINARY` is the operator's instruction for which runtime to spawn. The old
 * resolver only used a configured path when it existed, and otherwise walked on
 * to the `dsh` on `PATH`: a mistyped path therefore started a **different**
 * binary (another version, another profile, another bridge) and looked like a
 * normal start. A review probe aimed at a nonexistent path launched the real
 * `dsh` this way.
 *
 * What is pinned:
 *   1. a configured path that does not exist fails `start()` with a message that
 *      names the configured value and says it will not fall back
 *   2. the same for a path that exists but is not executable
 *   3. neither shape reaches `spawn` at all — "fell back and spawned something"
 *      would satisfy a message-only assertion
 *   4. an unset `DSH_BINARY` keeps the historical behaviour: `spawn("dsh")`
 *   5. a valid executable path is used verbatim (the positive control: without
 *      it, "rejects everything" would pass 1-3 for the wrong reason)
 *
 * The plugin is compiled and `child_process.spawn` is replaced with a recorder,
 * so no real `dsh` can be started even by the red (pre-fix) build: the fallback
 * would call the recorder with `"dsh"`, and assertion 3 is exactly what fails.
 *
 * Run:
 *   node harness/dsh-binary-check.mjs [compiled-plugin-dir]
 *
 * (compiles the plugin into `paseo-plugin/.dbg-dsh-binary` itself unless a build
 * directory is passed, and never touches a profile, model or daemon)
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolvePluginBuild } = require("./plugin-build.cjs");

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-dsh-binary");
const { DshProcess } = require(join(buildDir, "server", "dsh-process.js"));

const scratch = mkdtempSync(join(tmpdir(), "dsh-binary-check-"));
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition === true) {
    passed += 1;
    console.log(`  PASS  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  }
}

/** A child-process stand-in: `initializeRoute: false` only registers handlers. */
function fakeChild() {
  const events = new EventEmitter();
  const child = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 91002,
    exitCode: null,
    signalCode: null,
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
    emit: events.emit.bind(events),
    kill(signal) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (signal === undefined) child.exitCode = 0;
      else child.signalCode = signal;
      setImmediate(() => events.emit("exit", child.exitCode, child.signalCode));
    },
  };
  return child;
}

function makeProcess() {
  return new DshProcess({
    sessionId: "binary-check-root",
    cwd: process.cwd(),
    route: { provider: "fake", model: "fake" },
    // Only the spawn decision is under test; no initialize round trip.
    initializeRoute: false,
    onEvent: () => {},
    onStatus: () => {},
    onQuestion: async () => ({ answers: [] }),
    onLog: () => {},
    onExit: () => {},
    onProtocolError: () => {},
  });
}

const settle = (promise) =>
  promise.then(
    () => "resolved",
    (error) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  );

/** Run one `start()` with `spawn` recorded instead of executed. */
async function startWith(command) {
  const originalSpawn = childProcess.spawn;
  const spawnCalls = [];
  childProcess.spawn = (spawnCommand, args, options) => {
    spawnCalls.push({ command: spawnCommand, args, options });
    return fakeChild();
  };
  const prior = process.env.DSH_BINARY;
  if (command === undefined) delete process.env.DSH_BINARY;
  else process.env.DSH_BINARY = command;
  const proc = makeProcess();
  try {
    const outcome = await settle(proc.start());
    return { outcome, spawnCalls, proc };
  } finally {
    childProcess.spawn = originalSpawn;
    if (prior === undefined) delete process.env.DSH_BINARY;
    else process.env.DSH_BINARY = prior;
    proc.kill();
  }
}

const missing = join(scratch, "no-such-dsh");
{
  const { outcome, spawnCalls } = await startWith(missing);
  check("a configured path that does not exist fails start()", outcome.startsWith("rejected"), outcome);
  check(
    "…naming the configured value",
    outcome.includes(missing),
    outcome,
  );
  check(
    "…and refusing the PATH fallback",
    /refusing to fall back/i.test(outcome) && /DSH_BINARY/.test(outcome),
    outcome,
  );
  check("…without spawning anything", spawnCalls.length === 0, `${String(spawnCalls.length)} spawn call(s)`);
}

const notExecutable = join(scratch, "not-executable-dsh");
writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
chmodSync(notExecutable, 0o644);
{
  const { outcome, spawnCalls } = await startWith(notExecutable);
  check("a configured path that is not executable fails start()", outcome.startsWith("rejected"), outcome);
  check("…naming the configured value", outcome.includes(notExecutable), outcome);
  check("…without spawning anything", spawnCalls.length === 0, `${String(spawnCalls.length)} spawn call(s)`);
}

{
  const executable = join(scratch, "executable-dsh");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(executable, 0o755);
  const { outcome, spawnCalls } = await startWith(executable);
  check("a configured executable path is spawned verbatim (positive control)", outcome === "resolved", outcome);
  check(
    "…as the configured command",
    spawnCalls.length === 1 && spawnCalls[0].command === executable,
    JSON.stringify(spawnCalls.map((call) => call.command)),
  );
}

{
  const { outcome, spawnCalls } = await startWith(undefined);
  check("an unset DSH_BINARY keeps the historical lookup", outcome === "resolved", outcome);
  check(
    "…spawning the dsh on PATH",
    spawnCalls.length === 1 && spawnCalls[0].command === "dsh",
    JSON.stringify(spawnCalls.map((call) => call.command)),
  );
}

console.log(`\n  ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log(`  ${failed} FAILED`);
  process.exitCode = 1;
}
