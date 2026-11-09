/**
 * Offline check for `DshProcess.jobs()`'s consecutive-timeout policy.
 *
 * A jobs poll can time out during a long session's open/replay window even on a
 * current, byte-identical bridge (measured: a fresh bridge ignoring the first
 * `paseo/jobs` for a 2700+ step history). The plugin therefore tolerates
 * `JOBS_TIMEOUT_TOLERANCE = 8` consecutive timeouts: each answers quietly
 * (`available:true`, no log, no terminal) with **the last list it actually read**
 * — never a fabricated `jobs: []`, which would claim "nothing is running" for a
 * registry that was only unreachable (2026-11-10). The ninth consecutive miss is
 * `bridge_too_old` with one latched stderr line; any answer resets the streak, and
 * an `available:false` answer does not overwrite the carried list.
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
      if (mode === "jobs") {
        // A readable answer with a real background job, so the tolerated-timeout
        // answer can be asserted to carry it (2026-11-10).
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { available: true, jobs: [
          { id: "jobs-probe", kind: "bash", label: "sleep 5", status: "running", startedAt: 1 },
        ] } }) + "\\n");
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

  // The first eight consecutive timeouts are all quiet: empty answers, no log,
  // no terminal. A 2700+ step session's replay legitimately misses several 15 s
  // polls while a fresh, byte-identical bridge is opening it.
  setMode("hang");
  const tolerated = [];
  for (let index = 0; index < 8; index += 1) {
    tolerated.push(await proc.jobs("probe", TIMEOUT_MS));
  }
  check(
    "the first eight consecutive timeouts are quiet empty answers (available:true, jobs:[])",
    tolerated.every((entry) => entry.available === true && Array.isArray(entry.jobs) && entry.jobs.length === 0),
    JSON.stringify(tolerated),
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
  // Six more misses complete the ninth consecutive timeout counting from the
  // reset; nothing may be logged along the way.
  for (let index = 0; index < 6; index += 1) {
    await proc.jobs("probe", TIMEOUT_MS);
  }

  // Ninth consecutive timeout: terminal bridge_too_old + exactly one log.
  const ninth = await proc.jobs("probe", TIMEOUT_MS);
  check(
    "the ninth consecutive timeout becomes terminal bridge_too_old",
    ninth.available === false && ninth.error?.code === "bridge_too_old",
    JSON.stringify(ninth),
  );
  check("the terminal classification logs exactly once", logs.length === 1, JSON.stringify(logs));
  const tenth = await proc.jobs("probe", TIMEOUT_MS);
  check(
    "later timeouts stay terminal but do not log again (latched)",
    tenth.available === false && tenth.error?.code === "bridge_too_old" && logs.length === 1,
    JSON.stringify({ tenth, logs: logs.length }),
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

  // 2026-11-10 (review P2-3): the tolerated window must not fabricate state.
  // 1) it carries the last readable list; 2) an `available:false` answer does not
  // overwrite that list; 3) a detached session does not lend it out.
  logs.length = 0;
  setMode("jobs");
  const withJob = await proc.jobs("probe", TIMEOUT_MS);
  check(
    "a readable answer with a job reports it",
    withJob.available === true && withJob.jobs?.length === 1 && withJob.jobs[0].id === "jobs-probe",
    JSON.stringify(withJob),
  );
  setMode("hang");
  const carried = await proc.jobs("probe", TIMEOUT_MS);
  check(
    "a tolerated timeout carries the same job instead of an empty list",
    carried.available === true && carried.jobs?.length === 1 && carried.jobs[0].id === "jobs-probe",
    JSON.stringify(carried),
  );
  setMode("registry");
  const registryAfterJob = await proc.jobs("probe", TIMEOUT_MS);
  setMode("hang");
  const carriedAfterRegistry = await proc.jobs("probe", TIMEOUT_MS);
  check(
    "an unreadable answer does not overwrite the last known list",
    registryAfterJob.available === false &&
      registryAfterJob.jobs?.length === 0 &&
      carriedAfterRegistry.available === true &&
      carriedAfterRegistry.jobs?.[0]?.id === "jobs-probe",
    JSON.stringify({ registryAfterJob, carriedAfterRegistry }),
  );
  proc.detachSession("probe");
  const afterDetach = await proc.jobs("probe", TIMEOUT_MS);
  check(
    "after detachSession a tolerated timeout carries no stale list",
    afterDetach.available === true && afterDetach.jobs?.length === 0 && logs.length === 0,
    JSON.stringify({ afterDetach, logs: logs.length }),
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
