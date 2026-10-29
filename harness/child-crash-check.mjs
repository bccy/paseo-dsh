/**
 * A shared `dsh` child dying mid-subagent must fail the child's turn loudly.
 *
 * The child is shared by every conversation of the connection, so its death is
 * not one session's problem. `DshProcess.#exitAll` fans the exit out to every
 * session that **attached** to it — which is exactly the root conversations. A
 * native subagent has no process of its own and is not in that table: its view
 * lives in `DshSession.#children`. Nothing in the process-level path can reach
 * it, and `DshChildSession` had no failure channel at all (only a `turn/end` or
 * an idle status could close its turn).
 *
 * The consequence was silent and permanent: the child's `#turnId` stayed set, and
 * Paseo's default status on attach is "running", so the subagent row pulsed for
 * the life of the daemon and any question card it was holding stayed pending.
 * Paseo consumes exactly two terminal signals for a provider child —
 * `session.runtime_failed` and `session.closed` — and the plugin sent neither.
 *
 * What is pinned here:
 *   1. the child is genuinely mid-turn before the kill (positive control: without
 *      it, "no events" and "the scenario never started" look identical)
 *   2. the child view receives `session.runtime_failed` naming the **child's**
 *      provider id, with a reason
 *   3. the root receives its own `session.runtime_failed` too (the process really
 *      died; both halves must be reported)
 *   4. the child's failure is emitted **before** the root's — the daemon treats
 *      `session.runtime_failed` as terminal for the session it names, so a child
 *      announced after the root's failure would be dropped as an event for a
 *      conversation that is already gone
 *   5. the child gets no `session.turn` terminal: the failure is the terminal,
 *      and inventing a turn id for a turn DSH never closed would be a guess
 *
 * The crash is produced by the check itself (`SIGKILL` on the pid the fake bridge
 * logs), not by a new fake-bridge scenario: the fake bridge is owned by another
 * task and its existing `steer` scenario already leaves a child mid-turn.
 *
 * Run:
 *   node harness/child-crash-check.mjs [compiled-plugin-dir]
 *
 * (compiles the plugin into `paseo-plugin/.dbg-child-crash` itself unless a build
 * directory is passed, and uses a throwaway `DSH_HOME`, so no profile, model or
 * daemon is touched)
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
// The `steer` scenario opens a foreground child and leaves it running with the
// root turn still open — the state a subagent is in while the user is waiting.
process.env.DSH_FAKE_MODE = "steer";

// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which rewrites `$DSH_HOME/profiles/<name>/...` from the
// embedded bridge. The fake `dsh` needs no profile, so point DSH_HOME at a
// throwaway tree.
const scratch = mkdtempSync(join(tmpdir(), "dsh-child-crash-check-"));
process.env.DSH_HOME = scratch;
// Every request frame the fake bridge receives is appended here, with the pid
// that served it — that is how this check finds the child to kill.
const frameLog = join(scratch, "frames.jsonl");
process.env.DSH_FAKE_LOG = frameLog;
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-child-crash");
const plugin = require(join(buildDir, "index.server.js")).default;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Wait until `predicate` holds over the growing event list, or time out. */
async function until(list, predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = list.find(predicate);
    if (found !== undefined) return found;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}; saw ${list.map((event) => event.type).join(", ") || "(nothing)"}`);
}

/**
 * The same wait, but only over events that arrive **after** `from`.
 *
 * `list.slice(from)` is evaluated once, so passing a slice would freeze the list
 * at call time and never see anything new — a timeout that looks exactly like
 * "the plugin emitted nothing".
 */
async function untilAfter(list, from, predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = list.slice(from).find(predicate);
    if (found !== undefined) return found;
    await sleep(20);
  }
  throw new Error(
    `timed out waiting for ${label}; saw ${list.slice(from).map((event) => event.type).join(", ") || "(nothing)"}`,
  );
}

/** The pids the fake bridge has served a frame under. */
function servedPids() {
  try {
    return [
      ...new Set(
        readFileSync(frameLog, "utf8")
          .trim()
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line).pid),
      ),
    ];
  } catch {
    return [];
  }
}

let registration;
plugin({
  handle() {},
  registerProvider(r) {
    registration = r;
  },
  registerSettings() {},
  on() {},
  before() {},
});
if (registration === undefined) {
  console.error("the plugin did not register a provider");
  process.exit(2);
}

/** Every provider event the connection delivered, in arrival order. */
const events = [];

(async () => {
  const conn = await registration.connect({
    capabilities: ["prompt.message", "session.subsession"],
  });
  conn.onEvent((event) => events.push(event));

  const root = `crash-root-${Date.now()}`;
  await conn.send({
    type: "session.open",
    sessionId: root,
    config: { cwd: process.cwd(), mode: "build" },
    history: "skip",
  });
  await until(events, (e) => e.type === "session.ready" && e.sessionId === root, "root ready");

  await conn.send({
    type: "session.prompt",
    sessionId: root,
    prompt: { clientMessageId: "crash-p1", input: { type: "message", content: [{ type: "text", text: "go" }] } },
  });

  // The `steer` scenario announces its foreground child and leaves it running.
  const childOpened = await until(
    events,
    (e) => e.type === "session.opened" && e.parentSessionId === root,
    "the foreground child to open",
  );
  const child = childOpened.sessionId;
  await until(
    events,
    (e) => e.type === "session.turn" && e.sessionId === child && e.state === "started",
    "the child's turn to start",
  );
  await until(
    events,
    (e) => e.type === "timeline.item" && e.sessionId === child,
    "the child's first row",
  );
  check(
    "the subagent is mid-turn before the kill (positive control)",
    events.some((e) => e.type === "session.turn" && e.sessionId === child && e.state === "started") &&
      !events.some((e) => e.type === "session.turn" && e.sessionId === child && e.state !== "started"),
    `child=${child}, turns=${JSON.stringify(
      events.filter((e) => e.type === "session.turn" && e.sessionId === child).map((e) => e.state),
    )}`,
  );

  // --- kill the shared child ------------------------------------------------
  const pids = servedPids();
  check("the fake child is identified (it logged its pid)", pids.length > 0, `pids=${JSON.stringify(pids)}`);
  if (pids.length === 0) {
    throw new Error("cannot simulate a crash without a pid");
  }
  const childPid = pids[pids.length - 1];
  const beforeKill = events.length;
  let killed = false;
  try {
    process.kill(childPid, "SIGKILL");
    killed = true;
  } catch (error) {
    console.log(`  FAIL  could not kill the fake child  — ${String(error?.message ?? error)}`);
    failed += 1;
  }
  check("the shared child was killed (SIGKILL)", killed, `pid=${String(childPid)}`);

  // Both failures are expected. The child's is the one that used to be missing.
  const childFailure = await untilAfter(
    events,
    beforeKill,
    (e) => e.type === "session.runtime_failed" && e.sessionId === child,
    "the child's session.runtime_failed",
  );
  const rootFailure = await untilAfter(
    events,
    beforeKill,
    (e) => e.type === "session.runtime_failed" && e.sessionId === root,
    "the root's session.runtime_failed",
  );

  check(
    "the subagent's failure names the child and carries a reason",
    childFailure.sessionId === child && /exited/i.test(childFailure.error?.message ?? ""),
    JSON.stringify({ sessionId: childFailure.sessionId, error: childFailure.error?.message }),
  );
  check(
    "the root is told as well (the process it was using is gone)",
    rootFailure.sessionId === root && /exited/i.test(rootFailure.error?.message ?? ""),
    JSON.stringify({ sessionId: rootFailure.sessionId, error: rootFailure.error?.message }),
  );
  check(
    "the child's failure is emitted before the root's",
    events.indexOf(childFailure) < events.indexOf(rootFailure),
    `child@${String(events.indexOf(childFailure))}, root@${String(events.indexOf(rootFailure))}`,
  );
  // The failure IS the terminal for a child: Paseo maps `runtime_failed` to
  // `status: "failed"` and rejects its pending permissions. A `session.turn` here
  // would have to invent a turn id for a turn DSH never closed.
  check(
    "no invented turn terminal is sent to the child",
    !events
      .slice(beforeKill)
      .some((e) => e.type === "session.turn" && e.sessionId === child && e.state !== "started"),
    JSON.stringify(
      events
        .slice(beforeKill)
        .filter((e) => e.type === "session.turn" && e.sessionId === child)
        .map((e) => e.state),
    ),
  );
  check(
    "the failure is not attributed to the wrong session",
    events
      .slice(beforeKill)
      .filter((e) => e.type === "session.runtime_failed")
      .every((e) => e.sessionId === child || e.sessionId === root),
    events
      .slice(beforeKill)
      .filter((e) => e.type === "session.runtime_failed")
      .map((e) => e.sessionId)
      .join(", "),
  );

  try {
    await conn.close();
  } catch {
    /* the child is gone; the connection teardown may fail and must not mask the assertions */
  }

  console.log(`\n  ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.log(`  ${failed} FAILED`);
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error?.message ?? error}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(1);
});
