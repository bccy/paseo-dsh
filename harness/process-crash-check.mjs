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
 *   5. the outbound path has a budget: a burst past it is refused loudly instead
 *      of being buffered without bound, the stream is not fed past its own
 *      high-water mark while the child is not reading, and the frames that were
 *      accepted are delivered in request order once the child reads again
 *   6. the in-flight request table has a bound too: past it, the next request
 *      fails loudly and its frame never reaches the bridge, while the ones
 *      already in flight stay there (a cap is not a flush)
 *
 * The fake bridge's `crash` mode exits the instant a `session/prompt` arrives and
 * never replies, which is the shape of an OOM kill or a bootstrap throw: no
 * output, no receipt, just a dead pipe. The budget sections replace `spawn`
 * with a controlled child whose stdin is a real `PassThrough` with a small
 * high-water mark, so `write()` returns false exactly like a pipe whose reader
 * stopped — the only way to exercise backpressure without a slow real child.
 *
 * Run:
 *   node harness/process-crash-check.mjs [compiled-plugin-dir]
 *
 * (it compiles the plugin into `paseo-plugin/.dbg-process-crash` itself unless a build
 * directory is passed, and uses a throwaway `DSH_HOME`, so no profile, model or
 * daemon is touched)
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";

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

// --- the outbound queue is bounded and preserves request order -------------
//
// `stdin.write()` reports backpressure by returning false; ignoring that answer
// made every frame a caller produced land in Node's internal buffer. A pipe
// whose child has stopped reading (a wedged bridge, a huge tool argument) then
// held an unbounded amount of the plugin's memory. The same is true of the
// in-flight request table: every request shares the 120 s timeout, so callers
// could pile up without bound behind a bridge that never answers.
//
// The child stand-in below is a real `PassThrough` with a small high-water mark,
// not a stub: `write()` returns false exactly when a pipe would, and `drain`
// fires when the test starts reading. That is the only way to assert the two
// halves of backpressure — what is queued by the plugin and what is not — from
// outside the process.
console.log("\nthe outbound queue is bounded and preserves request order");

/** A child-process stand-in with a real, controllable stdin pipe. */
function fakeChild(highWaterMark) {
  const stdin = new PassThrough({ highWaterMark });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();
  const child = {
    stdin,
    stdout,
    stderr,
    pid: 91001,
    exitCode: null,
    signalCode: null,
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
    kill(signal) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (signal === undefined) child.exitCode = 0;
      else child.signalCode = signal;
      setImmediate(() => events.emit("exit", child.exitCode, child.signalCode));
    },
  };
  return child;
}

/** Start consuming what the plugin writes, handing each parsed frame over. */
function readChildFrames(child, onFrame) {
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at === -1) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim() === "") continue;
      onFrame(JSON.parse(line));
    }
  });
}

/** Answer one request frame on the stand-in's stdout. */
function answer(child, frame, result) {
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`);
}

{
  const originalSpawn = childProcess.spawn;
  const child = fakeChild(1024);
  childProcess.spawn = () => child;
  const proc = new DshProcess({
    sessionId: "budget-root",
    cwd: process.cwd(),
    route: { provider: "fake", model: "fake" },
    initializeRoute: false,
    maxPendingRequests: 64,
    maxOutboundQueueBytes: 4096,
    onEvent: () => {},
    onStatus: () => {},
    onQuestion: async () => ({ answers: [] }),
    onLog: () => {},
    onExit: () => {},
    onProtocolError: () => {},
  });
  try {
    await proc.start();
    const settled = new Array(10);
    const prompts = [];
    for (let i = 0; i < 10; i += 1) {
      // Alternate sessions: the queue is one FIFO for the whole shared pipe, so
      // a per-session queue or a reordering when one session is ahead would show
      // up as a mismatch between `received` and call order.
      const sessionId = i % 2 === 0 ? "budget-root" : "budget-other";
      const text = `p${i}:${"x".repeat(400)}`;
      prompts.push(proc.prompt(sessionId, text).then(
        (value) => {
          settled[i] = { ok: true, value };
        },
        (error) => {
          settled[i] = { ok: false, message: error instanceof Error ? error.message : String(error) };
        },
      ));
    }
    await sleep(100);
    const buffered = child.stdin.writableLength;
    const refused = settled.filter((entry) => entry !== undefined && entry.ok === false);
    check(
      "a burst past the outbound budget is refused loudly",
      refused.length > 0 && refused.every((entry) => /outbound queue is full|bound/i.test(entry.message)),
      refused.map((entry) => entry.message).join(" | ") || "(no refusal)",
    );
    check(
      "…and the child's stdin is not fed past its own high-water mark while it is not reading",
      buffered < 4096,
      `${String(buffered)} character(s) buffered in the stream`,
    );

    const received = [];
    readChildFrames(child, (frame) => {
      if (frame.method !== "session/prompt") return;
      received.push(frame.params.contentBlocks[0].text);
      answer(child, frame, { messageId: `m-${received.length}` });
    });
    await Promise.allSettled(prompts);
    const accepted = settled.filter((entry) => entry !== undefined && entry.ok === true).length;
    check(
      "every accepted frame is delivered, in request order across sessions",
      received.length === accepted && received.every((text, i) => text.startsWith(`p${i}:`)),
      `${received.length} received / ${accepted} accepted: ${received.map((text) => text.slice(0, 3)).join(",")}`,
    );
    check(
      "…and no accepted request is silently dropped",
      settled.filter((entry) => entry !== undefined).length === 10,
      `${settled.filter((entry) => entry !== undefined).length} settled`,
    );
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  the outbound-budget section could not run  — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    childProcess.spawn = originalSpawn;
    try {
      proc.kill();
      await proc.waitForExit(3000);
    } catch {
      /* the stand-in is gone; a failure here must not mask the assertions */
    }
  }
}

// --- the in-flight request table is bounded --------------------------------
console.log("\nthe in-flight request table is bounded");
{
  const originalSpawn = childProcess.spawn;
  const child = fakeChild(1024 * 1024);
  childProcess.spawn = () => child;
  const received = [];
  // Read the frames but never answer: every request stays in flight, which is
  // the "bridge is wedged behind its 120 s timeout" shape under test.
  readChildFrames(child, (frame) => received.push(frame.method));
  const proc = new DshProcess({
    sessionId: "pending-root",
    cwd: process.cwd(),
    route: { provider: "fake", model: "fake" },
    initializeRoute: false,
    maxPendingRequests: 4,
    maxOutboundQueueBytes: 1024 * 1024,
    onEvent: () => {},
    onStatus: () => {},
    onQuestion: async () => ({ answers: [] }),
    onLog: () => {},
    onExit: () => {},
    onProtocolError: () => {},
  });
  try {
    await proc.start();
    const settled = new Array(6);
    const prompts = [];
    for (let i = 0; i < 6; i += 1) {
      prompts.push(proc.prompt("pending-root", `q${i}`).then(
        (value) => {
          settled[i] = { ok: true, value };
        },
        (error) => {
          settled[i] = { ok: false, message: error instanceof Error ? error.message : String(error) };
        },
      ));
    }
    await sleep(100);
    const refused = settled.filter((entry) => entry !== undefined && entry.ok === false);
    check(
      "a request past the pending bound is refused loudly",
      refused.length === 2 && refused.every((entry) => /too many requests in flight/i.test(entry.message)),
      refused.map((entry) => entry.message).join(" | ") || "(no refusal)",
    );
    check(
      "…and the refused frames never reach the bridge",
      received.filter((method) => method === "session/prompt").length === 4,
      `${received.filter((method) => method === "session/prompt").length} prompt frame(s) received`,
    );
    // The four accepted ones are still pending (no answer was ever sent); kill
    // them below through the child's exit. `prompts` exists so the two refused
    // promises are not left as unhandled rejections either.
    void prompts;
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  the pending-bound section could not run  — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    childProcess.spawn = originalSpawn;
    try {
      proc.kill();
      await proc.waitForExit(3000);
    } catch {
      /* the stand-in is gone; a failure here must not mask the assertions */
    }
  }
}

console.log(`\n  ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log(`  ${failed} FAILED`);
  process.exitCode = 1;
}
