/**
 * Plugin-level regression for the two provider requests that do not run a turn:
 * the session-import list (`paseo/sessions`) and the rewind receipt
 * (`paseo/revert`).
 *
 * Both are requests Paseo drives through the provider contract and both reach
 * the bridge *outside* any `session/prompt`. Before this check the scripted fake
 * bridge did not implement either method, so a regression in the plugin's
 * mapping (or a drift in the bridge's returned shape) could only be found with a
 * real daemon — the fake would throw "unknown method" and no check exercised the
 * path. This drives the real Paseo plugin over `harness/fake-dsh-bridge.mjs` and
 * asserts:
 *
 *   1. a `sessions` input answers with persistence handles (not raw ids), the
 *      cwd/title/updatedAt pass through, and the first-message preview becomes
 *      Paseo's `description` — the daemon reopens an imported session by that
 *      handle, so a raw id is an "Invalid plugin provider persistence handle";
 *   2. a rewind the bridge accepts answers `request.completed` and emits the
 *      transient "正在回退，请稍候" notice, the click's only feedback while the
 *      daemon rebuilds the timeline;
 *   3. with no agent record for the session the automatic refresh cannot run, and
 *      that must be a visible warning notice, not silence;
 *   4. a rewind the bridge refuses becomes `request.failed`, never a silent
 *      success.
 *
 * Compile the plugin first (tsc type errors under `--moduleResolution node` are
 * expected; the emitted JS is what runs):
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/session-request-check.cjs ../harness/fake-dsh-bridge.mjs .dbg/
 *   cd .dbg && node session-request-check.cjs
 *   rm -rf ../.dbg
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fakeBridge = path.join(__dirname, "fake-dsh-bridge.mjs");
fs.chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "live";

// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which rewrites `$DSH_HOME/profiles/<name>/
// node_modules/dsh-paseo-bridge` from the bridge embedded in the plugin. The
// fake `dsh` needs no profile, so point DSH_HOME at a throwaway tree.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-request-check-"));
process.on("exit", () => {
  try {
    fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const plugin = require("./index.server.js").default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
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

async function until(predicate, label, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Like `until`, but ignores events recorded before `start` (stale matches). */
async function untilSince(start, predicate, label, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.slice(start).find(predicate);
    if (hit) return hit;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Like `untilSince`, but returns undefined instead of throwing on timeout. */
async function maybeSince(start, predicate, ms = 10000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.slice(start).find(predicate);
    if (hit) return hit;
    await sleep(80);
  }
  return undefined;
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

(async () => {
  const conn = await registration.connect({
    capabilities: [
      "prompt.message",
      "session.persistence",
      "session.list",
      "session.revert.both",
      "session.revert.conversation",
    ],
  });
  conn.onEvent((event) => events.push(event));

  check(
    "provider declares session.list (import)",
    (conn.capabilities ?? []).includes("session.list"),
    `capabilities=[${(conn.capabilities ?? []).join(", ")}]`,
  );
  check(
    "provider declares session.revert.both",
    (conn.capabilities ?? []).includes("session.revert.both"),
    `capabilities=[${(conn.capabilities ?? []).join(", ")}]`,
  );

  // ---- 1. the import list ------------------------------------------------
  // The request cwd is where the provider spawns its short-lived probe process,
  // so it has to exist; the rows' own cwd comes back from the bridge.
  await conn.send({ type: "sessions", requestId: "imports", cwd: process.cwd() });
  const list = await until((e) => e.type === "sessions" && e.requestId === "imports", "sessions list");
  const rows = Array.isArray(list.sessions) ? list.sessions : [];
  check("the sessions input answers with the bridge's rows", rows.length === 2, `${rows.length} row(s)`);
  check(
    "every row carries a persistence handle",
    rows.every(
      (row) =>
        row.persistence?.version === 1 &&
        typeof row.persistence?.data?.sessionId === "string" &&
        row.persistence.data.sessionId !== "",
    ),
    JSON.stringify(rows.map((row) => row.persistence ?? null)),
  );
  const storedA = rows.find((row) => row.persistence?.data?.sessionId === "stored-A");
  check(
    "a described row keeps cwd, title and updatedAt",
    storedA !== undefined &&
      storedA.cwd === "/tmp/stored-project" &&
      storedA.title === "Stored A" &&
      storedA.updatedAt === "2026-10-19T00:00:00.000Z",
    JSON.stringify(storedA ?? null),
  );
  check(
    "the first-message preview becomes Paseo's description",
    storedA?.description === "first message of A",
    JSON.stringify(storedA?.description ?? null),
  );

  // ---- 2. a rewind the bridge accepts ------------------------------------
  const sessionId = `request-check-${Date.now()}`;
  await conn.send({
    type: "session.open",
    sessionId,
    config: { cwd: process.cwd(), mode: "build" },
  });
  await until((e) => e.type === "session.ready" && e.sessionId === sessionId, "session ready");

  const beforeRevert = events.length;
  await conn.send({
    type: "session.revert",
    requestId: "revert-ok",
    sessionId,
    token: { messageId: "m-1" },
    scope: "conversation",
  });
  const revertReply = await untilSince(
    beforeRevert,
    (e) => e.requestId === "revert-ok" && (e.type === "request.completed" || e.type === "request.failed"),
    "revert reply",
  );
  check(
    "an accepted rewind answers request.completed",
    revertReply.type === "request.completed",
    revertReply.type === "request.failed" ? JSON.stringify(revertReply.error) : "completed",
  );
  // The provider answers first and refreshes second; the notice is emitted right
  // after the reply, because the delay before the daemon rebuilds the timeline
  // is otherwise an unexplained pause.
  const workingNotice = await maybeSince(
    beforeRevert,
    (e) => e.type === "session.notice" && e.sessionId === sessionId,
  );
  check(
    "the click gets a visible working notice",
    workingNotice?.notice?.title === "正在回退，请稍候",
    JSON.stringify(workingNotice?.notice ?? null),
  );

  // No Paseo agent record carries this throwaway provider session, so the
  // automatic refresh cannot run. That is a real failure of the refresh, and it
  // must surface as a warning instead of leaving the old timeline in place
  // silently.
  const refreshFallback = await maybeSince(
    beforeRevert,
    (e) =>
      e.type === "session.notice" &&
      e.sessionId === sessionId &&
      typeof e.notice?.title === "string" &&
      e.notice.title.includes("未自动刷新"),
    5000,
  );
  check(
    "a refresh that cannot find its agent is a visible warning",
    refreshFallback !== undefined,
    JSON.stringify(refreshFallback?.notice ?? null),
  );

  // ---- 3. a rewind the bridge refuses ------------------------------------
  const beforeFailedRevert = events.length;
  await conn.send({
    type: "session.revert",
    requestId: "revert-bad",
    sessionId,
    token: { messageId: "revert-unknown" },
    scope: "conversation",
  });
  const failedRevert = await untilSince(
    beforeFailedRevert,
    (e) => e.requestId === "revert-bad" && (e.type === "request.completed" || e.type === "request.failed"),
    "refused revert reply",
  );
  check(
    "a refused rewind is request.failed, not a silent success",
    failedRevert.type === "request.failed" && /无法解析/.test(failedRevert.error?.message ?? ""),
    JSON.stringify(failedRevert.error ?? failedRevert),
  );
  // The refusal must release the in-flight gate the provider set before asking
  // the bridge. A gate left behind would refuse every later rewind (and every
  // prompt) on this session with "该会话已有撤回正在进行", so the next accepted
  // rewind is the observable proof it was cleared.
  const beforeSecondRevert = events.length;
  await conn.send({
    type: "session.revert",
    requestId: "revert-ok-2",
    sessionId,
    token: { messageId: "m-2" },
    scope: "conversation",
  });
  const secondRevert = await untilSince(
    beforeSecondRevert,
    (e) => e.requestId === "revert-ok-2" && (e.type === "request.completed" || e.type === "request.failed"),
    "second revert reply",
  );
  check(
    "a refused rewind leaves the gate open for the next one",
    secondRevert.type === "request.completed",
    JSON.stringify(secondRevert.error ?? "completed"),
  );

  await conn.close();

  const failed = results.filter((result) => !result.pass).length;
  console.log(`\n  ${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((event) => event.type))].join(", ") || "(none)");
  process.exit(1);
});
