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
 *   2. an accepted rewind answers `request.completed` **and** leaves exactly one
 *      `撤回已生效` notice in front of that receipt. The notice is the rewind's
 *      canary: whether it survives is how the user (and a later phase) can tell
 *      a host that refreshes the timeline from one that does not, and it only
 *      works because of the order — a host that truncates its history buffer at
 *      the rewound row drops everything already in it, so a notice sent after the
 *      receipt would survive on that host too and lie. `harness/host-contract-sim.mjs`
 *      drives the real host code to prove both halves;
 *   3. the retired reload path stays gone: no "正在回退，请稍候" working notice and
 *      no "未自动刷新" warning, because nothing refreshes and nothing can fail;
 *   4. a rewind the bridge refuses becomes `request.failed`, never a silent
 *      success, and leaves no canary behind (nothing was rewound);
 *   5. a second accepted rewind's canary text differs from the first (`#2`), so a
 *      later phase can find *this* rewind's notice on a host that keeps them all;
 *   6. the canary is scoped to rewinds that touched the conversation. A
 *      `files`-only rewind restores the working tree and deliberately leaves the
 *      conversation alone (`dsh-bridge/lib/server.js` skips the replacement for
 *      that scope), so there is no timeline to refresh and the canary's "reload to
 *      see the result" advice would be a warning about a problem the user does not
 *      have. A `both` rewind does change the conversation, so it does get one — and
 *      its text names the files too, because that is the half the user cannot see
 *      from the timeline.
 *
 * The scope cases are the ones that are easy to lose: the provider decides with
 * `input.scope !== "files"` and `files: input.scope === "both"`, and with only
 * `conversation` rewinds exercised, dropping either condition left every other
 * check green (verified by mutation — see the report).
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

/** Synchronous counterpart: everything already recorded since `sinceIndex`. */
function eventsSince(sinceIndex) {
  return events.slice(sinceIndex);
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

  // The canary. It has to be a `撤回已生效` notice **in front of** the receipt, and
  // the index comparison is the assertion — not "a notice exists". A host that
  // truncates its history buffer at the rewound row cuts everything already in it
  // when the receipt resolves, which is what makes the canary vanish on a
  // refreshed timeline; a notice emitted after the receipt is outside that window
  // and survives on that host too, turning the canary into a false "your timeline
  // is stale" warning. Both directions are driven against the real host code in
  // `harness/host-contract-sim.mjs`.
  const rewindNotices = eventsSince(beforeRevert).filter(
    (e) => e.type === "session.notice" && e.sessionId === sessionId,
  );
  const canaries = rewindNotices.filter((e) => e.notice?.title === "撤回已生效");
  check(
    "an accepted rewind leaves exactly one canary notice",
    canaries.length === 1,
    `${canaries.length} canary notice(s): ${JSON.stringify(rewindNotices.map((e) => e.notice?.title ?? null))}`,
  );
  // Index comparison over the whole event array, not "canary index < reply index
  // within the notice list": the two are different lists, and comparing inside one
  // of them would compare a notice against itself.
  const canaryIndex = canaries.length === 1 ? events.indexOf(canaries[0]) : -1;
  const replyIndex = events.indexOf(revertReply);
  check(
    "…emitted before request.completed (the order is the whole mechanism)",
    canaryIndex !== -1 && replyIndex !== -1 && canaryIndex < replyIndex,
    `canary at ${canaryIndex}, request.completed at ${replyIndex}`,
  );
  // And the canary's text is the one the module defines: the timestamp and the
  // sequence number, which is what makes it findable when several rewinds have
  // each left one behind.
  const canaryDescription = String(canaries[0]?.notice?.description ?? "");
  check(
    "…whose text carries the time and this rewind's sequence number",
    /^\d{2}:\d{2}:\d{2} · #1。/u.test(canaryDescription),
    JSON.stringify(canaryDescription),
  );
  // A rewind no longer reloads the agent, so the click needs no "working" notice:
  // the reply is immediate and the daemon rebuilds the timeline from the
  // truncated history. Asserting the *absence* keeps this honest — if someone
  // reintroduces the reload path, the notice (and this check) come back together.
  check(
    "no working notice is needed (the rewind answers immediately)",
    rewindNotices.every((e) => e.notice?.title !== "正在回退，请稍候"),
    JSON.stringify(rewindNotices.map((e) => e.notice?.title ?? null)),
  );
  // Likewise there is no automatic refresh left to fail, so no "未自动刷新"
  // warning can appear. Silence here means "nothing to report", not "failure
  // swallowed": the reply above already proved the rewind succeeded.
  check(
    "no refresh-failure warning exists (the reload path is gone)",
    rewindNotices.every(
      (e) => !String(e.notice?.title ?? "").includes("未自动刷新"),
    ),
    JSON.stringify(rewindNotices.map((e) => e.notice?.title ?? null)),
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
  // A refusal rewinds nothing, so there is nothing for a canary to announce. A
  // canary here would tell the user their timeline is stale after an action that
  // did not happen — and it would be the loudest possible signal for a click that
  // failed, which is worse than no signal at all.
  const refusedCanaries = eventsSince(beforeFailedRevert).filter(
    (e) => e.type === "session.notice" && e.notice?.title === "撤回已生效",
  );
  check(
    "a refused rewind leaves no canary behind",
    refusedCanaries.length === 0,
    `${refusedCanaries.length} canary notice(s)`,
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
  // The second canary must be distinguishable from the first. On a host that keeps
  // the withdrawn rows the first one is still on screen, so "a notice exists" would
  // match the stale one; the sequence number is what names *this* rewind. It is
  // also what a later phase would search for to find the notice it just emitted.
  const secondCanaries = eventsSince(beforeSecondRevert).filter(
    (e) => e.type === "session.notice" && e.notice?.title === "撤回已生效",
  );
  const firstCanaryDescription = String(canaries[0]?.notice?.description ?? "");
  const secondCanaryDescription = String(secondCanaries[0]?.notice?.description ?? "");
  check(
    "the second rewind's canary is a different notice (#2)",
    secondCanaries.length === 1
      && /· #2。/u.test(secondCanaryDescription)
      && secondCanaryDescription !== firstCanaryDescription,
    `${secondCanaries.length} notice(s); second=${JSON.stringify(secondCanaryDescription)} first=${JSON.stringify(firstCanaryDescription)}`,
  );

  // ---- 4. the scope decides whether there is a canary at all -------------
  //
  // A `files`-only rewind restores the working tree and deliberately leaves the
  // conversation alone, so the timeline the canary talks about was not touched.
  // Telling the user to "Reload agent 或重开会话" after one would be advice for a
  // problem they do not have — and the notice would sit at the bottom of a
  // timeline that is already correct.
  //
  // This is the case that used to be uncovered: every rewind above is
  // `conversation`, so the provider's `if (input.scope !== "files")` guard could be
  // removed (or defeated with a `if (true)` beside it) with every check still
  // green. The bridge answers a `files` rewind exactly like any other, so the only
  // observable difference is the missing notice.
  const beforeFilesRevert = events.length;
  await conn.send({
    type: "session.revert",
    requestId: "revert-files",
    sessionId,
    token: { messageId: "m-3" },
    scope: "files",
  });
  const filesRevert = await untilSince(
    beforeFilesRevert,
    (e) => e.requestId === "revert-files" && (e.type === "request.completed" || e.type === "request.failed"),
    "files revert reply",
  );
  // Positive control for the case: a `files` rewind that *failed* would also
  // produce no canary, so the absence below only means something if this one
  // succeeded. (The fake bridge accepts any resolvable token, like the real one
  // does for a files-scoped rewind.)
  check(
    "a files-scoped rewind is accepted (so the absence below is meaningful)",
    filesRevert.type === "request.completed",
    JSON.stringify(filesRevert.error ?? "completed"),
  );
  const filesCanaries = eventsSince(beforeFilesRevert).filter(
    (e) => e.type === "session.notice" && e.notice?.title === "撤回已生效",
  );
  check(
    "a files-only rewind leaves no canary (the conversation was not touched)",
    filesCanaries.length === 0,
    `${filesCanaries.length} canary notice(s): ${JSON.stringify(filesCanaries.map((e) => e.notice?.description ?? null))}`,
  );

  // ---- 5. a `both` rewind does get one, and its text names the files ------
  //
  // The other half of the same condition: `files: input.scope === "both"` picks the
  // wording. A `both` rewind restored the working tree *and* rewound the
  // conversation, so the notice must say so — the file half is exactly what the
  // user cannot see from the timeline, and a canary that only mentioned the
  // conversation would leave a restored tree unexplained.
  const beforeBothRevert = events.length;
  await conn.send({
    type: "session.revert",
    requestId: "revert-both",
    sessionId,
    token: { messageId: "m-4" },
    scope: "both",
  });
  const bothRevert = await untilSince(
    beforeBothRevert,
    (e) => e.requestId === "revert-both" && (e.type === "request.completed" || e.type === "request.failed"),
    "both revert reply",
  );
  check(
    "a both-scoped rewind is accepted",
    bothRevert.type === "request.completed",
    JSON.stringify(bothRevert.error ?? "completed"),
  );
  const bothCanaries = eventsSince(beforeBothRevert).filter(
    (e) => e.type === "session.notice" && e.notice?.title === "撤回已生效",
  );
  const bothCanaryDescription = String(bothCanaries[0]?.notice?.description ?? "");
  check(
    "a both-scoped rewind does leave a canary",
    bothCanaries.length === 1,
    `${bothCanaries.length} canary notice(s)`,
  );
  // The wording must name the file half. Not the sequence number: that is
  // bookkeeping, and pinning it here would fail a harmless reorder (spending a
  // number for a `files` rewind that emits nothing) while the user-visible text
  // was still right. `#3` is only asserted through "differs from the previous
  // one", which is what a later phase needs.
  check(
    "…whose text names the files it restored",
    bothCanaryDescription.includes("文件") && bothCanaryDescription !== secondCanaryDescription,
    JSON.stringify(bothCanaryDescription),
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
