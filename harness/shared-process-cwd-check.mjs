#!/usr/bin/env node
/**
 * The shared `dsh` child must be spawned in a directory no session owns, while
 * every session still gets **its own** cwd passed to DSH.
 *
 * The regression this pins (FIELD-NOTES 91) is cross-session and invisible at
 * the protocol layer: the pool process used to be spawned with the **first
 * caller's** cwd. That is a workspace path, and Paseo workspaces are disposable
 * worktrees — once one was removed, `/proc/<pid>/cwd` read `(deleted)`, and
 * every later bash call in **every** session failed with
 * `spawn systemd-run ENOENT`. DSH's Linux scope launcher
 * (`@deepseek-ai/dsh-subprocess-local` `lib/index.js:546,575`) starts
 * `systemd-run` with `cwd: process.cwd()`; a deleted directory cannot be a
 * child's working directory. Session cwd never had the problem — it travels per
 * session in `initialize` — which is exactly why a single deleted workspace
 * took down bash for sessions that had nothing to do with it.
 *
 * What is pinned here:
 *   1. the shared child's **own** cwd is the stable process directory
 *      (`os.homedir()`, see `stableProcessCwd`), not the first session's
 *      workspace, and not the second's either
 *   2. the process-level `initialize` carries that same stable directory, so the
 *      bridge's process defaults are not a workspace path either
 *   3. session cwd is still delivered per session: each session's `initialize`
 *      names its own workspace — the fix must not move sessions to the home
 *      directory
 *   4. deleting the first session's workspace does not break the child: its
 *      spawn cwd still exists, the same pid still serves a later prompt (no
 *      respawn), and that session still answers
 *   5. `stableProcessCwd` itself: an existing home wins, a missing/empty home
 *      falls back to the temp directory
 *
 * The fake `dsh` is wrapped by a one-line script that records the cwd the
 * plugin spawned it in (`pwd -P`) plus its pid, then `exec`s the real scripted
 * bridge — so the assertion reads the actual spawn cwd instead of inferring it.
 *
 * Run:
 *   node harness/shared-process-cwd-check.mjs [compiled-plugin-dir]
 *
 * (it compiles the plugin into `paseo-plugin/.dbg-shared-cwd` itself unless a
 * build directory is passed, and uses a throwaway `DSH_HOME`, so no profile,
 * model or daemon is touched)
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/** Single-quote one string for embedding in the generated `bash` wrapper. */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const scratch = mkdtempSync(join(tmpdir(), "dsh-shared-cwd-check-"));
const workA = join(scratch, "workspace-a");
const workB = join(scratch, "workspace-b");
mkdirSync(workA);
mkdirSync(workB);

/** Where the wrapper records the cwd it was spawned in, and its pid. */
const spawnRecord = join(scratch, "spawn-cwd.txt");
const wrapper = join(scratch, "fake-dsh-wrapper.sh");
writeFileSync(
  wrapper,
  [
    "#!/usr/bin/env bash",
    "# Record the directory the plugin actually spawned this child in, then become",
    "# the scripted bridge (same pid, so the frame log's pid can be matched).",
    `pwd -P > ${shellQuote(spawnRecord)}`,
    `printf '%s\\n' "$$" >> ${shellQuote(spawnRecord)}`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(fakeBridge)} "$@"`,
    "",
  ].join("\n"),
);
chmodSync(wrapper, 0o755);

// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which writes into `$DSH_HOME`. The fake bridge needs
// no profile at all, so point DSH_HOME at a throwaway tree.
process.env.DSH_HOME = join(scratch, "dsh-home");
process.env.DSH_BINARY = wrapper;
process.env.DSH_FAKE_MODE = "multi";
const frameLog = join(scratch, "frames.jsonl");
process.env.DSH_FAKE_LOG = frameLog;

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-shared-cwd");
const plugin = require(join(buildDir, "index.server.js")).default;
/** `stableProcessCwd` is the pure decision under test for the fallback half. */
const { stableProcessCwd } = require(join(buildDir, "server", "dsh-process.js"));

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

/** `realpath` without throwing on a path that no longer exists. */
function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Wait until an event at or after `fromIndex` matches, or time out.
 *
 * The index is read on every tick on purpose: a `pluginEvents.slice(fromIndex)`
 * taken once would be a snapshot, and an answer the fake bridge emits after a
 * short delay (as the `multi` scenario does) would arrive in the live array and
 * never be seen.
 */
function waitFor(fromIndex, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = pluginEvents.slice(fromIndex).find(predicate);
      if (found !== undefined) return resolve(found);
      if (Date.now() > deadline) {
        const seen = pluginEvents
          .slice(fromIndex)
          .map((event) => `${event.type}${event.item === undefined ? "" : `:${String(event.item.type)}`}`);
        return reject(new Error(`timed out; saw ${seen.join(", ") || "(nothing)"}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

let registration;
const pluginEvents = [];
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

/** Read the fake bridge's frame log, or an empty list when it wrote none. */
function frames() {
  if (!existsSync(frameLog)) return [];
  return readFileSync(frameLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** The `initialize` frames of one kind: process-level (no id) or one session's. */
function initializeFrames() {
  return frames().filter((frame) => frame.method === "initialize");
}
function processInitialize() {
  return initializeFrames().find((frame) => frame.params?.sessionId === undefined);
}
function sessionInitialize(sessionId) {
  return initializeFrames().find((frame) => frame.params?.sessionId === sessionId);
}

const expectedStable = stableProcessCwd();
const sessionA = `shared-cwd-A-${Date.now()}`;
const sessionB = `shared-cwd-B-${Date.now()}`;
let conn;
const opened = [];

/** Open one provider session in `cwd` and wait for it to be ready. */
async function openSession(sessionId, cwd) {
  const mark = pluginEvents.length;
  await conn.send({
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    config: { cwd, mode: "build" },
    history: "skip",
  });
  try {
    await waitFor(mark, (event) => event.type === "session.ready" && event.sessionId === sessionId);
    opened.push(sessionId);
  } catch (error) {
    const failures = pluginEvents
      .slice(mark)
      .filter((event) => event.type === "request.failed" || event.type === "session.runtime_failed");
    console.error(
      `open ${sessionId} failed: ${failures.map((event) => event.error?.message ?? event.type).join(" | ")}`,
    );
    throw error;
  }
}

/** Send one prompt and wait for the fake bridge's answer for that session. */
async function promptAndAwaitAnswer(sessionId) {
  const mark = pluginEvents.length;
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId: `prompt-${sessionId}`,
      input: { type: "message", content: [{ type: "text", text: "hello" }] },
    },
  });
  await waitFor(
    mark,
    (event) =>
      event.type === "timeline.item"
      && event.sessionId === sessionId
      && event.item?.type === "assistant_message",
  );
}

try {
  conn = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
  conn.onEvent((event) => pluginEvents.push(event));

  // Two sessions in two different workspaces. The **first** one is the cwd the
  // old code spawned the shared child in, so it is also the one this check
  // deletes to reproduce the defect's trigger.
  await openSession(sessionA, workA);
  await openSession(sessionB, workB);

  const spawn = existsSync(spawnRecord)
    ? readFileSync(spawnRecord, "utf8").split("\n").filter((line) => line.trim() !== "")
    : [];
  const spawnedCwd = spawn[0];
  const spawnedPid = Number.parseInt(spawn[1] ?? "", 10);
  check(
    "the fake dsh recorded the cwd it was spawned in",
    typeof spawnedCwd === "string" && spawnedCwd !== "" && Number.isInteger(spawnedPid),
    spawn.join(" / ") || "(nothing recorded)",
  );

  // 1. The child's own cwd is the stable process directory.
  check(
    "the shared child is spawned in the stable process directory",
    typeof spawnedCwd === "string" && realOrSelf(spawnedCwd) === realOrSelf(expectedStable),
    `spawn cwd ${String(spawnedCwd)}; stable ${expectedStable}`,
  );
  check(
    "…which is not the first session's workspace",
    typeof spawnedCwd === "string" && realOrSelf(spawnedCwd) !== realOrSelf(workA),
    `spawn cwd ${String(spawnedCwd)}; first workspace ${workA}`,
  );
  check(
    "…nor the second session's workspace",
    typeof spawnedCwd === "string" && realOrSelf(spawnedCwd) !== realOrSelf(workB),
    `spawn cwd ${String(spawnedCwd)}; second workspace ${workB}`,
  );

  // 2. The process-level initialize carries the same stable directory: the
  //    bridge's process defaults must not be a workspace either.
  const processInit = processInitialize();
  check(
    "the process-level initialize names the stable directory",
    processInit !== undefined
      && typeof processInit.params?.cwd === "string"
      && realOrSelf(processInit.params.cwd) === realOrSelf(expectedStable),
    processInit === undefined ? "(no process-level initialize)" : JSON.stringify(processInit.params?.cwd),
  );

  // 3. Session cwd is still per session — the fix must not flatten sessions to
  //    the home directory.
  const initA = sessionInitialize(sessionA);
  const initB = sessionInitialize(sessionB);
  check(
    "session A's initialize carries A's own cwd",
    initA !== undefined && realOrSelf(String(initA.params?.cwd)) === realOrSelf(workA),
    initA === undefined ? "(no initialize for A)" : JSON.stringify(initA.params?.cwd),
  );
  check(
    "session B's initialize carries B's own cwd",
    initB !== undefined && realOrSelf(String(initB.params?.cwd)) === realOrSelf(workB),
    initB === undefined ? "(no initialize for B)" : JSON.stringify(initB.params?.cwd),
  );

  // 4. Delete the first session's workspace — the trigger that used to leave the
  //    child's cwd dangling. Nothing below may need a respawn: the same pid must
  //    keep serving, and the recorded spawn cwd must still exist.
  rmSync(workA, { recursive: true, force: true });
  check(
    "the spawn cwd still exists after the first workspace is deleted",
    typeof spawnedCwd === "string" && existsSync(spawnedCwd),
    String(spawnedCwd),
  );
  await promptAndAwaitAnswer(sessionB);
  const afterDelete = frames().filter((frame) => frame.method === "session/prompt");
  check(
    "the same child still serves a prompt after the workspace is deleted",
    afterDelete.length > 0 && afterDelete.every((frame) => frame.pid === spawnedPid),
    afterDelete.map((frame) => String(frame.pid)).join(", ") || "(no prompt frame)",
  );
  const answerB = pluginEvents.filter(
    (event) =>
      event.type === "timeline.item"
      && event.sessionId === sessionB
      && event.item?.type === "assistant_message",
  );
  check(
    "…and session B still answers",
    answerB.length === 1 && answerB[0].item?.text === `answer for ${sessionB}`,
    answerB.map((event) => String(event.item?.text)).join(", ") || "(no answer)",
  );

  // 5. The directory choice itself: an existing home wins, a missing/empty home
  //    falls back to the temp directory.
  check(
    "stableProcessCwd prefers an existing home directory",
    realOrSelf(stableProcessCwd(workB, scratch)) === realOrSelf(workB),
    stableProcessCwd(workB, scratch),
  );
  check(
    "stableProcessCwd falls back to the temp directory when home is gone",
    realOrSelf(stableProcessCwd(workA, scratch)) === realOrSelf(scratch),
    stableProcessCwd(workA, scratch),
  );
  check(
    "stableProcessCwd treats an empty home as missing",
    realOrSelf(stableProcessCwd("", scratch)) === realOrSelf(scratch),
    stableProcessCwd("", scratch),
  );
} catch (error) {
  failed += 1;
  console.log(`  FAIL  the check could not run  — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  try {
    if (conn !== undefined) await conn.close();
  } catch {
    /* the fake bridge may already be gone; cleanup must not mask assertions */
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

console.log(`\n  ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log(`  ${failed} FAILED`);
  process.exit(1);
}
