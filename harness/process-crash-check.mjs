/**
 * A large frame written to a child that dies must fail the request, not the
 * daemon.
 *
 * The shared `dsh` child is written to through its `stdin` pipe. A frame bigger
 * than the pipe buffer — a screenshot in a prompt, a large tool argument, a
 * `paseo/history` request; Linux's default buffer is 64 KB, and
 * `session.ts:2462` puts base64 image data straight into the frame — is queued
 * by `stdin.write` and drained as the child reads. If the child dies while bytes
 * are still queued, the stream emits **`'error'` (EPIPE) asynchronously**: the
 * `write()` call itself has long returned, so `#send`'s try/catch cannot see it.
 *
 * A stream `'error'` with no listener is an uncaught exception, whose Node default
 * action is to terminate the process. For this plugin that is not "one session
 * lost": the child is shared, so the daemon goes down and **every** conversation
 * on it ends at once. The guard that exists for the child's own `'error'` event
 * (`dsh-process.ts` `#start`) does not cover the stream's.
 *
 * What is pinned:
 *   1. writing a >256 KB frame to a child that dies produces **no**
 *      `uncaughtException` in the test process
 *   2. the request fails **promptly** (well under the 120 s RPC timeout) instead
 *      of hanging until the timeout
 *   3. the failure is visible: the process reports it through `onProtocolError`
 *      and/or the request rejects — never a silent drop
 *   4. the same write path is healthy while the child is alive (the positive
 *      control: without it, a broken fake bridge that never reads stdin would
 *      make 1 and 2 pass for the wrong reason)
 *
 * The fake bridge's `crash` mode exits the instant a `session/prompt` arrives and
 * never replies, which is the shape of an OOM kill or a bootstrap throw: no
 * output, no receipt, just a dead pipe.
 *
 * Run:
 *   node harness/process-crash-check.mjs [compiled-plugin-dir]
 *
 * (it compiles the plugin into `paseo-plugin/.dbg-process-crash` itself unless a build
 * directory is passed, and uses a throwaway `DSH_HOME`, so no profile, model or
 * daemon is touched)
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolvePluginBuild } = require("./plugin-build.cjs");

const fakeBridge = join(here, "fake-dsh-bridge.mjs");
if (!existsSync(fakeBridge)) {
  console.error(`fake bridge missing at ${fakeBridge}`);
  process.exit(2);
}
chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;

// Loading the plugin calls `ensurePaseoProfile()`, which rewrites
// `$DSH_HOME/profiles/<name>/...` from the embedded bridge. The fake `dsh` needs
// no profile at all, so point DSH_HOME at a throwaway tree and delete it on exit.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-process-crash-check-"));
process.on("exit", () => {
  try {
    rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-process-crash");
const { DshProcess } = require(join(buildDir, "server", "dsh-process.js"));

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record any uncaught exception instead of letting it kill the check.
 *
 * The very failure under test is a process-fatal uncaught error, so the harness
 * has to survive it to report anything at all. This listener is the assertion
 * instrument, not a workaround: what it records is exactly what the daemon's own
 * handler (`daemon-worker.ts:344-352`) would turn into `process.exit(1)`.
 */
const uncaught = [];
process.on("uncaughtException", (error) => {
  uncaught.push(error);
});

/** Frames big enough to overflow the pipe buffer several times over. */
const BIG = 512 * 1024;

/** Build one process against the fake bridge in `crash` mode. */
function makeProcess(sessionId, logs, protocolErrors) {
  return new DshProcess({
    sessionId,
    cwd: process.cwd(),
    route: { provider: "fake", model: "fake" },
    onEvent: () => {},
    onStatus: () => {},
    onQuestion: async () => ({ answers: [] }),
    onLog: (line) => logs.push(line),
    onExit: () => {},
    onProtocolError: (message) => protocolErrors.push(message),
  });
}

// --- positive control: the same write path with a live child ---------------
//
// Without this section a fake bridge that simply never reads `stdin` would make
// every crash assertion pass (nothing writes, nothing errors), and a plugin that
// rejected every prompt would look like a working one. So the large frame is
// first written to a child that is alive and answering.
console.log("a large frame to a live child is accepted");
{
  process.env.DSH_FAKE_MODE = "live";
  const logs = [];
  const protocolErrors = [];
  const live = makeProcess("crash-control-root", logs, protocolErrors);
  try {
    await live.start();
    const result = await live.prompt("crash-control-root", "x".repeat(BIG));
    check(
      "a 512 KB prompt is accepted by a live child",
      typeof result.messageId === "string",
      JSON.stringify(result),
    );
    check(
      "…with no protocol error reported",
      protocolErrors.length === 0,
      protocolErrors.join(" | ") || "(none)",
    );
    check("…and no uncaught exception", uncaught.length === 0, uncaught.map(String).join(" | ") || "(none)");
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  the live control could not run  — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      await live.shutdown();
      await live.waitForExit(3000);
    } catch {
      /* the fake bridge exits on `shutdown`; a failure here must not mask the assertions */
    }
  }
}

// --- the crash: two large frames queued behind a child that dies -----------
console.log("\na large frame to a dying child fails the request, not the process");
{
  process.env.DSH_FAKE_MODE = "crash";
  const logs = [];
  const protocolErrors = [];
  const crash = makeProcess("crash-root", logs, protocolErrors);
  try {
    await crash.start();
    const started = Date.now();
    // Both writes are issued without awaiting the first: that is what puts bytes
    // in the pipe while the child is still alive to read the first one and then
    // dies, leaving the rest unwritable. Awaiting in sequence would let the exit
    // event arrive first, and then `#request`'s "not running" guard would reject
    // before any write happened — passing for a reason that has nothing to do
    // with EPIPE.
    const first = crash.prompt("crash-root", "y".repeat(BIG));
    const second = crash.prompt("crash-root", "z".repeat(BIG));
    const settled = await Promise.allSettled([first, second]);
    const elapsedMs = Date.now() - started;

    const rejected = settled.filter((entry) => entry.status === "rejected");
    check(
      "both in-flight requests reject",
      rejected.length === 2,
      settled
        .map((entry) => (entry.status === "rejected" ? `rejected: ${entry.reason?.message}` : "resolved"))
        .join(" | "),
    );
    check(
      "…promptly, not at the 120 s RPC timeout",
      elapsedMs < 5000,
      `${String(elapsedMs)} ms`,
    );
    check(
      "…and the process did not die of an uncaught exception",
      uncaught.length === 0,
      uncaught.map((error) => `${error?.code ?? ""} ${String(error?.message ?? error)}`).join(" | ") || "(none)",
    );
    // Visibility: either sink is acceptable, silence is not. The EPIPE path reports
    // through `onProtocolError`; a plain "process ended" rejection is the exit
    // path. Both mean the user sees a failed turn.
    const visible =
      protocolErrors.length > 0
      || logs.some((line) => line.includes("process ended") || line.includes("not running"))
      || rejected.some((entry) => String(entry.reason?.message ?? "").length > 0);
    check("the failure is reported, not swallowed", visible, protocolErrors.join(" | ") || `${rejected.length} rejection(s)`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  the crash section could not run  — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      crash.kill();
      await crash.waitForExit(3000);
    } catch {
      /* the child is already gone; a failure here must not mask the assertions */
    }
  }
}

console.log(`\n  ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log(`  ${failed} FAILED`);
  process.exitCode = 1;
}
