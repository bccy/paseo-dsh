/**
 * Offline check for `DshProcess.jobs()`'s consecutive-timeout policy.
 *
 * A jobs poll can time out during a long session's open/replay window even on a
 * current, byte-identical bridge (measured: a fresh bridge ignoring the first
 * `paseo/jobs` for a 2700+ step history). The plugin therefore tolerates two
 * consecutive timeouts: both answer a quiet `{available:true, jobs:[]}`, no log,
 * no terminal; only the third consecutive miss is `bridge_too_old` with one
 * latched stderr line. Any answer resets the streak.
 *
 * This drives the **real** `DshProcess` class with a real spawned fake child
 * (the same stdio JSON-RPC surface `dsh --profile` speaks), not a stub of the
 * method: the timeout is produced by the class's own pending-request timer. The
 * case passes a short timeout (`jobs(sessionId, timeoutMs)`) so it runs in
 * milliseconds; production keeps the 15 s budget.
 *
 * Run (from paseo-plugin, after compiling the plugin):
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/jobs-timeout-check.cjs .dbg/
 *   cd .dbg && node jobs-timeout-check.cjs
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DshProcess } = require("./server/dsh-process.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-timeout-check-"));
const modeFile = path.join(dir, "mode");
const fakeChild = path.join(dir, "fake-dsh.mjs");
fs.writeFileSync(modeFile, "hang\n");
fs.writeFileSync(fakeChild, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const modeFile = process.env.JOBS_FAKE_MODE_FILE;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    const frame = JSON.parse(line);
    if (frame.method === "paseo/jobs") {
      const mode = readFileSync(modeFile, "utf8").trim();
      if (mode === "hang") continue; // never answer: the caller must time out
      if (mode === "registry") {
        // A real answer that reports an unreadable registry (available:false).
        // It must end the timeout streak exactly like a successful list.
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { available: false, jobs: [], error: { message: "this DSH runtime composes no job registry" } } }) + "\\n");
        continue;
      }
      if (mode === "unknown") {
        // The bridge's unknown-method reply (the shape this repo's bridge uses).
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown paseo bridge method: paseo/jobs" } }) + "\\n");
        continue;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { available: true, jobs: [] } }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }) + "\\n");
  }
});
`);
fs.chmodSync(fakeChild, 0o755);

process.env.DSH_BINARY = fakeChild;
process.env.JOBS_FAKE_MODE_FILE = modeFile;

const logs = [];
const proc = new DshProcess({
  cwd: dir,
  route: { provider: "fake", model: "fake" },
  sessionId: "jobs-timeout-probe",
  initializeRoute: false,
  env: { JOBS_FAKE_MODE_FILE: modeFile },
  onEvent() {},
  onStatus() {},
  onQuestion: async () => ({ answers: [] }),
  onLog: (line) => logs.push(line),
  onExit() {},
  onProtocolError() {},
});

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
}
const setMode = (value) => fs.writeFileSync(modeFile, `${value}\n`);
const TIMEOUT_MS = 60;

(async () => {
  await proc.start();

  // First two consecutive timeouts: quiet empty answers, no log, no terminal.
  setMode("hang");
  const first = await proc.jobs("probe", TIMEOUT_MS);
  const second = await proc.jobs("probe", TIMEOUT_MS);
  check(
    "the first two consecutive timeouts are a quiet empty answer (available:true, jobs:[])",
    first.available === true && Array.isArray(first.jobs) && first.jobs.length === 0 &&
      second.available === true && Array.isArray(second.jobs) && second.jobs.length === 0,
    JSON.stringify({ first, second }),
  );
  check("no warning is logged for the tolerated timeouts", logs.length === 0, JSON.stringify(logs));

  // Any real answer resets the streak.
  setMode("ok");
  const answered = await proc.jobs("probe", TIMEOUT_MS);
  check("a real answer still reports its jobs", answered.available === true && Array.isArray(answered.jobs), JSON.stringify(answered));
  setMode("hang");
  await proc.jobs("probe", TIMEOUT_MS);
  await proc.jobs("probe", TIMEOUT_MS);
  check("a successful answer resets the streak (two more timeouts stay tolerated)", logs.length === 0, JSON.stringify(logs));

  // Third consecutive timeout: terminal bridge_too_old + exactly one log.
  const third = await proc.jobs("probe", TIMEOUT_MS);
  check(
    "the third consecutive timeout becomes terminal bridge_too_old",
    third.available === false && third.error?.code === "bridge_too_old",
    JSON.stringify(third),
  );
  check("the terminal classification logs exactly once", logs.length === 1, JSON.stringify(logs));
  const fourth = await proc.jobs("probe", TIMEOUT_MS);
  check(
    "later timeouts stay terminal but do not log again (latched)",
    fourth.available === false && fourth.error?.code === "bridge_too_old" && logs.length === 1,
    JSON.stringify({ fourth, logs: logs.length }),
  );

  // A registry-missing answer is still an answer and must reset the streak: two
  // further timeouts stay silent instead of tipping the stale count over.
  logs.length = 0;
  setMode("registry");
  const registry = await proc.jobs("probe", TIMEOUT_MS);
  setMode("hang");
  const registryThenFirst = await proc.jobs("probe", TIMEOUT_MS);
  const registryThenSecond = await proc.jobs("probe", TIMEOUT_MS);
  check(
    "a registry-missing answer resets the streak (two later timeouts stay silent)",
    registry.available === false && registry.error?.code === "registry_missing" &&
      registryThenFirst.available === true && registryThenSecond.available === true &&
      logs.length === 0,
    JSON.stringify({ registry, first: registryThenFirst, second: registryThenSecond, logs: logs.length }),
  );

  // The unknown-method reply is an answer too (the bridge talked, then rejected):
  // the terminal branch resets the streak, so two later timeouts are tolerated.
  logs.length = 0;
  setMode("unknown");
  const unknown = await proc.jobs("probe", TIMEOUT_MS);
  setMode("hang");
  const unknownThenFirst = await proc.jobs("probe", TIMEOUT_MS);
  const unknownThenSecond = await proc.jobs("probe", TIMEOUT_MS);
  check(
    "an unknown-method reply resets the streak (two later timeouts stay silent)",
    unknown.available === false && unknown.error?.code === "bridge_too_old" &&
      unknownThenFirst.available === true && unknownThenSecond.available === true &&
      logs.length === 1,
    JSON.stringify({ unknown, first: unknownThenFirst, second: unknownThenSecond, logs: logs.length }),
  );

  await proc.shutdown().catch(() => undefined);
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.pass).length;
  console.log(`\n  ${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  process.exit(1);
});
