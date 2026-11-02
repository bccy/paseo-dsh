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
 *      handle, so a raw id is an "Invalid plugin provider persistence handle".
 *      The request frame must also carry the host's cwd as the bridge's filter
 *      parameter (and must not invent one when the host sent none); without it
 *      another workspace's sessions could push this workspace's rows out of the
 *      truncated import list;
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
 *      from the timeline;
 *   7. a file-restore receipt with `files.error` (the bridge aborted before it
 *      could run the restore: the post-durability re-plan failed) still produces
 *      the failure notice, carrying the bridge's own error text verbatim and **not**
 *      the failed-path sentence about a rescue directory — that shape has no
 *      per-path outcomes and sends `rescueDir` empty. The token is
 *      `revert-plan-failed` and the bridge's answer is scripted by the fake;
 *   8. the other unrestored shapes are loud too (BF-03): a `skipped`-only receipt
 *      names the skipped path, an `unrecoverable` receipt names the path **and its
 *      reason** without repeating it as a generic skip, and an `alreadyAbsent`-only
 *      receipt (the planned delete was already gone — a complete rewind) emits **no**
 *      `文件回退未完成` notice. Before this the provider only looked at `failed`, so
 *      every one of the first two shapes produced the plain success notice while
 *      the file stayed modified.
 *   9. every successful rewind leaves **exactly one** completion notice, with the
 *      copy for its scope and counts taken from the receipt's `restored` /
 *      `deleted` arrays, emitted **after** `request.completed` (the opposite side
 *      of the canary's ordering: a truncating host would cut anything sent before
 *      the receipt, and this report has to survive). A partial file restore emits
 *      only the failure notice, never a success line beside it.
 *
 * The completion copy is localized by `server/locale.ts`; this check pins the
 * Chinese column by setting `DSH_PASEO_LANG` before the plugin is required, so
 * an English CI host cannot turn the exact-copy assertions into a false red. The
 * English column is asserted by `harness/rewind-notice-check.cjs`.
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
// Pin the server half's display locale: the completion copy assertions below
// compare the Chinese column verbatim, while `server/locale.ts` resolves the
// daemon's LANG at module load. The English column is covered separately by
// `rewind-notice-check.cjs`, which drives the shared table directly.
process.env.DSH_PASEO_LANG = "zh-CN";

// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which rewrites `$DSH_HOME/profiles/<name>/
// node_modules/dsh-paseo-bridge` from the bridge embedded in the plugin. The
// fake `dsh` needs no profile, so point DSH_HOME at a throwaway tree.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-request-check-"));
// Frames the fake `dsh` receives, so a check can assert what the plugin actually
// *sent* (the sessions cwd filter below), not only what it answered.
const FRAME_LOG = path.join(process.env.DSH_HOME, "frames.jsonl");
process.env.DSH_FAKE_LOG = FRAME_LOG;
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

/**
 * Wait for the rewind notice the provider sends **after** the receipt.
 *
 * The provider queues that notice until the daemon's rewind run lock is
 * released (`server/rewind-delivery.ts`): the daemon stages and then discards
 * every provider event sent while that lock is held, which is why the report
 * cannot go out with the receipt (`harness/rewind-notice-delivery-check.mjs`
 * drives the real host code to prove both halves). Reading `events` right after
 * the reply would therefore see no notice at all — this wait is part of the
 * contract now, not a race workaround.
 *
 * Every accepted rewind gets one notice: the completion sentence, or the
 * partial-file failure. A refused rewind gets none, so it is not waited for.
 */
async function waitForRewindNotice(sinceIndex, sessionId) {
  return await untilSince(
    sinceIndex,
    (e) => e.type === "session.notice"
      && e.sessionId === sessionId
      && (isRewindSuccessTitle(String(e.notice?.title ?? "")) || e.notice?.title === "文件回退未完成"),
    "rewind notice",
  );
}

/**
 * Whether a notice title is one of the completion sentences this check pins.
 *
 * Spelled out here rather than imported from `shared/rewind-notice.ts`: this
 * file asserts the *copy*, so deriving the expectation from the module under
 * test would only prove the module equals itself. The two dynamic shapes carry
 * a count; the fixed ones are exact.
 */
const REWIND_SUCCESS_TITLES = new Set([
  "已撤回到这条消息",
  "已撤回对话，这条消息之后没有改动文件",
  "这条消息之后没有改动文件，无需恢复",
]);
const REWIND_SUCCESS_PATTERNS = [
  /^已撤回对话，并恢复 \d+ 个文件（删除 \d+ 个）$/u,
  /^已恢复 \d+ 个文件（删除 \d+ 个）$/u,
];
function isRewindSuccessTitle(title) {
  return REWIND_SUCCESS_TITLES.has(title)
    || REWIND_SUCCESS_PATTERNS.some((pattern) => pattern.test(title));
}

/** Every rewind completion notice since `sinceIndex` (not the canary, not a failure). */
function successNoticesSince(sinceIndex) {
  return eventsSince(sinceIndex).filter(
    (event) => event.type === "session.notice" && isRewindSuccessTitle(String(event.notice?.title ?? "")),
  );
}

/** Every `paseo/sessions` frame the fake `dsh` has received so far. */
function sessionsFrames() {
  if (!fs.existsSync(FRAME_LOG)) return [];
  return fs
    .readFileSync(FRAME_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((frame) => frame.method === "paseo/sessions");
}

/**
 * Wait for one sessions frame matching `predicate`.
 *
 * The fake bridge writes the frame before it answers, but that write happens in
 * the child process; polling the file avoids depending on that timing.
 */
async function waitForSessionsFrame(predicate, label, ms = 10000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = sessionsFrames().find(predicate);
    if (hit !== undefined) return hit;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
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
      "session.revert.files",
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
  // The files-only menu entry is capability-gated exactly like the other two:
  // without this bit Paseo never offers "restore files only", no matter how
  // complete the bridge's handler is.
  check(
    "provider declares session.revert.files",
    (conn.capabilities ?? []).includes("session.revert.files"),
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

  // ---- 1b. the host cwd reaches the bridge as a filter -------------------
  // The provider used to pass the request cwd only as the probe process's
  // working directory, never as `paseo/sessions`'s filter parameter. With ~20
  // stored sessions and no query, another workspace's rows could push the
  // current workspace's rows out of the import list before the bridge truncated
  // to the limit. The distinction this block pins is **presence**, so the probe
  // cwd must stay out of the filter when the host sent none.
  const hostWorkspace = path.join(process.env.DSH_HOME, "host-workspace");
  fs.mkdirSync(hostWorkspace, { recursive: true });
  await conn.send({ type: "sessions", requestId: "imports-filtered", cwd: hostWorkspace, limit: 3 });
  await until((e) => e.type === "sessions" && e.requestId === "imports-filtered", "filtered sessions list");
  const filteredFrame = await waitForSessionsFrame(
    (frame) => frame.params?.limit === 3,
    "sessions frame with cwd",
  );
  check(
    "a sessions request forwards the host cwd as the bridge filter",
    filteredFrame.params?.cwd === hostWorkspace,
    JSON.stringify(filteredFrame.params),
  );

  await conn.send({ type: "sessions", requestId: "imports-no-cwd", limit: 4 });
  await until((e) => e.type === "sessions" && e.requestId === "imports-no-cwd", "unfiltered sessions list");
  const plainFrame = await waitForSessionsFrame(
    (frame) => frame.params?.limit === 4,
    "sessions frame without cwd",
  );
  check(
    "a sessions request with no host cwd sends no cwd filter",
    !Object.prototype.hasOwnProperty.call(plainFrame.params ?? {}, "cwd"),
    JSON.stringify(plainFrame.params),
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

  // The report is queued behind the host's rewind run lock; wait for it before
  // asserting on the notices this rewind left behind.
  await waitForRewindNotice(beforeRevert, sessionId);

  // The completion report. It is a second, different notice: the canary above
  // proves whether the timeline refreshed, this one says what the rewind did.
  // It must come **after** the receipt — the opposite side of the canary's
  // ordering — because a host that truncates history at the rewound row cuts
  // everything already in that buffer, and a real completion report has to
  // survive on every host.
  const conversationSuccess = successNoticesSince(beforeRevert).filter(
    (event) => event.sessionId === sessionId,
  );
  check(
    "a conversation rewind leaves exactly one completion notice",
    conversationSuccess.length === 1
      && conversationSuccess[0]?.notice?.title === "已撤回到这条消息",
    `${conversationSuccess.length} notice(s): ${JSON.stringify(conversationSuccess.map((event) => event.notice?.title ?? null))}`,
  );
  check(
    "…emitted after request.completed (so a truncating host cannot cut it)",
    conversationSuccess.length === 1
      && events.indexOf(conversationSuccess[0]) > events.indexOf(revertReply),
    `completion at ${events.indexOf(conversationSuccess[0])}, request.completed at ${events.indexOf(revertReply)}`,
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
  await waitForRewindNotice(beforeSecondRevert, sessionId);
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
  await waitForRewindNotice(beforeFilesRevert, sessionId);
  const filesCanaries = eventsSince(beforeFilesRevert).filter(
    (e) => e.type === "session.notice" && e.notice?.title === "撤回已生效",
  );
  check(
    "a files-only rewind leaves no canary (the conversation was not touched)",
    filesCanaries.length === 0,
    `${filesCanaries.length} canary notice(s): ${JSON.stringify(filesCanaries.map((e) => e.notice?.description ?? null))}`,
  );
  const filesSuccess = successNoticesSince(beforeFilesRevert);
  check(
    "a files-only rewind reports its own completion",
    filesSuccess.length === 1
      && filesSuccess[0]?.notice?.title === "这条消息之后没有改动文件，无需恢复",
    `${filesSuccess.length} notice(s): ${JSON.stringify(filesSuccess.map((e) => e.notice?.title ?? null))}`,
  );
  check(
    "…also after request.completed",
    filesSuccess.length === 1 && events.indexOf(filesSuccess[0]) > events.indexOf(filesRevert),
    `completion at ${events.indexOf(filesSuccess[0])}, request.completed at ${events.indexOf(filesRevert)}`,
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
  await waitForRewindNotice(beforeBothRevert, sessionId);
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
  const bothSuccess = successNoticesSince(beforeBothRevert);
  check(
    "a both-scoped rewind reports its own completion (no file half → no-file wording)",
    bothSuccess.length === 1
      && bothSuccess[0]?.notice?.title === "已撤回对话，这条消息之后没有改动文件",
    `${bothSuccess.length} notice(s): ${JSON.stringify(bothSuccess.map((e) => e.notice?.title ?? null))}`,
  );
  check(
    "…after request.completed",
    bothSuccess.length === 1 && events.indexOf(bothSuccess[0]) > events.indexOf(bothRevert),
    `completion at ${events.indexOf(bothSuccess[0])}, request.completed at ${events.indexOf(bothRevert)}`,
  );

  // ---- 6. the counts come from the receipt's arrays ------------------------
  //
  // `restored` and `deleted` are string arrays, not counts. A provider that
  // reads a `count` field invents one; one that prints `files.restored` itself
  // prints paths. This block is the positive assertion for both scopes, so the
  // "no file half" wording above is not allowed to pass by accident for every
  // rewind.
  const beforeBothCounts = events.length;
  await conn.send({
    type: "session.revert",
    requestId: "revert-both-counts",
    sessionId,
    token: { messageId: "revert-files-counts" },
    scope: "both",
  });
  const bothCountsReply = await untilSince(
    beforeBothCounts,
    (e) => e.requestId === "revert-both-counts" && (e.type === "request.completed" || e.type === "request.failed"),
    "both-counts revert reply",
  );
  check(
    "a both rewind with a file receipt answers request.completed",
    bothCountsReply.type === "request.completed",
    JSON.stringify(bothCountsReply.error ?? "completed"),
  );
  await waitForRewindNotice(beforeBothCounts, sessionId);
  const bothCountsSuccess = successNoticesSince(beforeBothCounts);
  check(
    "…and its completion notice counts the receipt's arrays",
    bothCountsSuccess.length === 1
      && bothCountsSuccess[0]?.notice?.title === "已撤回对话，并恢复 2 个文件（删除 1 个）",
    `${bothCountsSuccess.length} notice(s): ${JSON.stringify(bothCountsSuccess.map((e) => e.notice?.title ?? null))}`,
  );

  const beforeFilesCounts = events.length;
  await conn.send({
    type: "session.revert",
    requestId: "revert-files-counts",
    sessionId,
    token: { messageId: "revert-files-counts" },
    scope: "files",
  });
  const filesCountsReply = await untilSince(
    beforeFilesCounts,
    (e) => e.requestId === "revert-files-counts" && (e.type === "request.completed" || e.type === "request.failed"),
    "files-counts revert reply",
  );
  check(
    "a files rewind with a file receipt answers request.completed",
    filesCountsReply.type === "request.completed",
    JSON.stringify(filesCountsReply.error ?? "completed"),
  );
  await waitForRewindNotice(beforeFilesCounts, sessionId);
  const filesCountsSuccess = successNoticesSince(beforeFilesCounts);
  check(
    "…and its completion notice counts the receipt's arrays",
    filesCountsSuccess.length === 1
      && filesCountsSuccess[0]?.notice?.title === "已恢复 2 个文件（删除 1 个）",
    `${filesCountsSuccess.length} notice(s): ${JSON.stringify(filesCountsSuccess.map((e) => e.notice?.title ?? null))}`,
  );
  const filesCountsCanaries = eventsSince(beforeFilesCounts).filter(
    (e) => e.type === "session.notice" && e.notice?.title === "撤回已生效",
  );
  check(
    "…with no canary even when the file receipt has counts",
    filesCountsCanaries.length === 0,
    `${filesCountsCanaries.length} canary notice(s)`,
  );

  // ---- 7. a file-restore plan failure (files.error) is loud and verbatim ----
  //
  // The bridge answers the rewind with `files` carrying no per-path outcome and
  // an `error` string: after the conversation half became durable, the re-plan
  // of the file restore ran against an unreadable journal / vanished target and
  // the restore was never attempted. There is no `failed` entry, so the old
  // condition (and the old text) produced silence; treating it as `failed` would
  // point the user at a rescue copy that does not exist.
  const planFailedToken = "PLAN-FAILED: journal unreadable (/fake/session/journal.jsonl)";
  const beforePlanFailedRevert = events.length;
  await conn.send({
    type: "session.revert",
    requestId: "revert-plan-failed",
    sessionId,
    token: { messageId: "revert-plan-failed" },
    scope: "both",
  });
  const planFailedRevert = await untilSince(
    beforePlanFailedRevert,
    (e) => e.requestId === "revert-plan-failed" && (e.type === "request.completed" || e.type === "request.failed"),
    "plan-failed revert reply",
  );
  check(
    "a rewind whose file restore never ran still answers request.completed",
    planFailedRevert.type === "request.completed",
    JSON.stringify(planFailedRevert.error ?? "completed"),
  );
  await waitForRewindNotice(beforePlanFailedRevert, sessionId);
  const planFailedNotices = eventsSince(beforePlanFailedRevert).filter(
    (e) => e.type === "session.notice" && e.notice?.title === "文件回退未完成",
  );
  const planFailedDescription = String(planFailedNotices[0]?.notice?.description ?? "");
  check(
    "…emits the file-failure notice for files.error",
    planFailedNotices.length === 1,
    JSON.stringify(planFailedNotices.map((e) => e.notice?.description ?? null)),
  );
  check(
    "…carrying the bridge's error text verbatim",
    planFailedDescription.includes(planFailedToken),
    JSON.stringify(planFailedDescription),
  );
  check(
    "…and does not claim a rescue copy that was never made",
    !planFailedDescription.includes("另存到") && !planFailedDescription.includes("rescue"),
    JSON.stringify(planFailedDescription),
  );
  check(
    "…and emits no success notice beside the failure",
    successNoticesSince(beforePlanFailedRevert).length === 0,
    JSON.stringify(successNoticesSince(beforePlanFailedRevert).map((e) => e.notice?.title ?? null)),
  );

  // ---- 8. a skipped-only file outcome is loud (BF-03) ----
  //
  // The rewind succeeded and `failed` is empty, but one path was deliberately not
  // restored (it became a symlink/directory, or its parent changed after capture).
  // The receipt used to produce only the success notice; the path is exactly the
  // half the user cannot see from the timeline.
  const beforeSkippedRevert = events.length;
  await conn.send({
    type: "session.revert",
    requestId: "revert-skipped-only",
    sessionId,
    token: { messageId: "revert-skipped-only" },
    scope: "both",
  });
  const skippedRevert = await untilSince(
    beforeSkippedRevert,
    (e) => e.requestId === "revert-skipped-only" && (e.type === "request.completed" || e.type === "request.failed"),
    "skipped-only revert reply",
  );
  check(
    "a rewind whose only unrestored file was skipped still answers request.completed",
    skippedRevert.type === "request.completed",
    JSON.stringify(skippedRevert.error ?? "completed"),
  );
  await waitForRewindNotice(beforeSkippedRevert, sessionId);
  const skippedNotices = eventsSince(beforeSkippedRevert).filter(
    (e) => e.type === "session.notice" && e.notice?.title === "文件回退未完成",
  );
  const skippedDescription = String(skippedNotices[0]?.notice?.description ?? "");
  check(
    "…emits the file-failure notice for a skipped path",
    skippedNotices.length === 1,
    JSON.stringify(skippedNotices.map((e) => e.notice?.description ?? null)),
  );
  check(
    "…naming the skipped path",
    skippedDescription.includes("/work/link.txt"),
    JSON.stringify(skippedDescription),
  );
  check(
    "…and emits no success notice beside the failure",
    successNoticesSince(beforeSkippedRevert).length === 0,
    JSON.stringify(successNoticesSince(beforeSkippedRevert).map((e) => e.notice?.title ?? null)),
  );

  // ---- 9. an unrecoverable capture names the reason (BF-03) ----
  //
  // The bridge folds the path into `skipped` for older consumers and carries the
  // reason in `unrecoverable`. Both facts must reach the user, and the path must
  // not be reported twice (once generically, once with the reason).
  const beforeUnrecoverableRevert = events.length;
  await conn.send({
    type: "session.revert",
    requestId: "revert-unrecoverable-only",
    sessionId,
    token: { messageId: "revert-unrecoverable-only" },
    scope: "both",
  });
  const unrecoverableRevert = await untilSince(
    beforeUnrecoverableRevert,
    (e) =>
      e.requestId === "revert-unrecoverable-only"
      && (e.type === "request.completed" || e.type === "request.failed"),
    "unrecoverable-only revert reply",
  );
  check(
    "a rewind whose file could not be snapshotted still answers request.completed",
    unrecoverableRevert.type === "request.completed",
    JSON.stringify(unrecoverableRevert.error ?? "completed"),
  );
  await waitForRewindNotice(beforeUnrecoverableRevert, sessionId);
  const unrecoverableNotices = eventsSince(beforeUnrecoverableRevert).filter(
    (e) => e.type === "session.notice" && e.notice?.title === "文件回退未完成",
  );
  const unrecoverableDescription = String(unrecoverableNotices[0]?.notice?.description ?? "");
  check(
    "…emits the file-failure notice for an unrecoverable capture",
    unrecoverableNotices.length === 1,
    JSON.stringify(unrecoverableNotices.map((e) => e.notice?.description ?? null)),
  );
  check(
    "…naming the path and the capture's own reason",
    unrecoverableDescription.includes("/work/big.bin")
      && unrecoverableDescription.includes("larger than 8388608 bytes"),
    JSON.stringify(unrecoverableDescription),
  );
  check(
    "…and not repeating the path as a generic skipped entry",
    (unrecoverableDescription.match(/\/work\/big\.bin/gu) ?? []).length === 1,
    JSON.stringify(unrecoverableDescription),
  );
  check(
    "…and emits no success notice beside the failure",
    successNoticesSince(beforeUnrecoverableRevert).length === 0,
    JSON.stringify(successNoticesSince(beforeUnrecoverableRevert).map((e) => e.notice?.title ?? null)),
  );

  // ---- 10. an already-absent delete is benign, not a failure (BF-03) ----
  //
  // The only planned action was deleting a file the agent had created, and it was
  // already gone when the restore ran. Nothing is unrestored, so a failure notice
  // here would be a false alarm. This is the guard against widening the condition
  // into "any files receipt is a failure".
  const beforeAlreadyAbsentRevert = events.length;
  await conn.send({
    type: "session.revert",
    requestId: "revert-already-absent",
    sessionId,
    token: { messageId: "revert-already-absent" },
    scope: "both",
  });
  const alreadyAbsentRevert = await untilSince(
    beforeAlreadyAbsentRevert,
    (e) =>
      e.requestId === "revert-already-absent"
      && (e.type === "request.completed" || e.type === "request.failed"),
    "already-absent revert reply",
  );
  check(
    "a rewind whose delete target was already gone still answers request.completed",
    alreadyAbsentRevert.type === "request.completed",
    JSON.stringify(alreadyAbsentRevert.error ?? "completed"),
  );
  await waitForRewindNotice(beforeAlreadyAbsentRevert, sessionId);
  const alreadyAbsentNotices = eventsSince(beforeAlreadyAbsentRevert).filter(
    (e) => e.type === "session.notice" && e.notice?.title === "文件回退未完成",
  );
  check(
    "…and emits no file-failure notice (a benign no-op is not a partial restore)",
    alreadyAbsentNotices.length === 0,
    JSON.stringify(alreadyAbsentNotices.map((e) => e.notice?.description ?? null)),
  );
  const alreadyAbsentSuccess = successNoticesSince(beforeAlreadyAbsentRevert);
  check(
    "…but still reports the rewind as complete (counts are zero, not missing)",
    alreadyAbsentSuccess.length === 1
      && alreadyAbsentSuccess[0]?.notice?.title === "已撤回对话，这条消息之后没有改动文件",
    `${alreadyAbsentSuccess.length} notice(s): ${JSON.stringify(alreadyAbsentSuccess.map((e) => e.notice?.title ?? null))}`,
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
