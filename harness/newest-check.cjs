/**
 * Offline assertions for "which row is the newest, and should it still pulse".
 *
 * This decides the pulse for a *finished* row, which is the only way a short
 * command — `tool/call` and `tool/result` in the same tick — ever pulses at
 * all. Getting it wrong is silent in three directions: no pulse (the bug the
 * user reported), every row pulsing (the bug before that), or a pulse that
 * never stops (an interrupted tool). So the checks live at the data layer.
 *
 * The module folds a render pass's maxima in from a microtask, so a pass is
 * modelled as "render, then let the microtask run".
 *
 * The module is stateful, so every scenario uses its own agent id.
 *
 * Run (from paseo-plugin):
 *   npx tsc client/newest.ts \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/newest-check.cjs .dbg/
 *   cd .dbg && node newest-check.cjs
 */
"use strict";

const {
  BULK_MIN_ROWS,
  BULK_WINDOW_MS,
  PULSE_MS,
  isPulsing,
  markRowAnimated,
  normalizeRowTimestamp,
  noteCommit,
  noteRender,
  pulseRemainingMs,
  resetNewestForTests,
  shouldEnterLive,
  shouldPulse,
} = require("./client/newest.js");

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition === true) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label} — ${detail === undefined ? String(condition) : detail}`);
  }
}

const base = Date.UTC(2026, 0, 1, 0, 0, 0);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One render pass over a list, in list order, then the fold-in. */
async function pass(agent, timestamps) {
  const answers = timestamps.map((at) => noteRender(agent, at));
  await settle();
  return answers;
}

async function main() {
  console.log("position");
  {
    const agent = "position";
    // Nothing has been seen, so nothing may claim the position. Answering "yes"
    // here is what made a whole replayed list blink for a frame.
    const first = await pass(agent, [base, base + 100, base + 200]);
    check("no row claims the position on the first pass", first.every((v) => v === false));

    const second = await pass(agent, [base, base + 100, base + 200]);
    check("only the newest row claims it afterwards", second.filter(Boolean).length === 1);
    check("and it is the newest one", second[2] === true);

    const third = await pass(agent, [base + 200, base + 300]);
    const fourth = await pass(agent, [base + 200, base + 300]);
    check("a newer row takes over", fourth[1] === true && fourth[0] === false);
    check("the pass that discovered it is allowed one frame of overlap", third[1] === true);
  }

  console.log("pulse window");
  {
    const agent = "window";
    await pass(agent, [base]);
    const commit = noteCommit(agent, base);
    check("the last row pulses", isPulsing(agent, commit, base) === true);
    check("still pulsing inside the window", isPulsing(agent, commit, base + PULSE_MS - 1) === true);
    check("stops at the window edge", isPulsing(agent, commit, base + PULSE_MS) === false);
  }

  console.log("a newer row takes the pulse away");
  {
    const agent = "handover";
    await pass(agent, [base]);
    const first = noteCommit(agent, base);
    await pass(agent, [base, base + 50]);
    const second = noteCommit(agent, base + 50);
    check("the first row stops", isPulsing(agent, first, base + 50) === false);
    check("the second row pulses", isPulsing(agent, second, base + 50) === true);
  }

  console.log("live pair vs replayed history");
  {
    // Two commands a human issued: both are real activity, the last one pulses.
    const live = "live-pair";
    await pass(live, [base]);
    const a = noteCommit(live, base);
    await pass(live, [base, base + 50]);
    const b = noteCommit(live, base + 50);
    check("a pair is not a batch", a.bulk === false && b.bulk === false);
    check("the last of a live pair pulses", isPulsing(live, b, base + 60) === true);

    // Replaying a session emits the whole history in a burst. None of it is live.
    const replay = "replay";
    const commits = [];
    for (let i = 0; i < 12; i += 1) {
      await pass(replay, [base + i * 5]);
      commits.push(noteCommit(replay, base + i * 5));
    }
    check(
      "a history burst is recognised",
      commits[commits.length - 1].bulk === true && commits[0].bulk === false,
    );
    check(
      "nothing in a replayed history pulses",
      commits.every((commit) => isPulsing(replay, commit, base + 100) === false),
    );
    check("the threshold is a batch, not a pair", BULK_MIN_ROWS > 2 && BULK_WINDOW_MS > 0);
  }

  console.log("a live row after a replayed history");
  {
    const agent = "after-replay";
    for (let i = 0; i < 8; i += 1) {
      await pass(agent, [base + i * 5]);
      noteCommit(agent, base + i * 5);
    }
    // Well past the batch window, so the burst no longer counts.
    const liveAt = base + BULK_WINDOW_MS + 1000;
    await pass(agent, [base + 35, liveAt]);
    const commit = noteCommit(agent, liveAt);
    check("it is not treated as part of the burst", commit.bulk === false);
    check("and it pulses", isPulsing(agent, commit, liveAt) === true);
  }

  console.log("commit, not render, starts the window");
  {
    const agent = "commit-only";
    await pass(agent, [base]);
    const early = noteCommit(agent, base);
    check("the window starts at commit", isPulsing(agent, early, base + 10) === true);
    check("rendering again does not restart it", isPulsing(agent, early, base + PULSE_MS) === false);
  }

  console.log("timestamp shapes");
  {
    const agent = "shapes";
    check("a Date renders", noteRender(agent, new Date(base)) === false);
    await settle();
    check("a newer Date claims it", noteRender(agent, new Date(base + 1000)) === true);
    const commit = noteCommit(agent, base);
    check("a commit is reported", typeof commit.seq === "number" && commit.seenAt === base);
  }

  console.log("the predicate the renderer actually uses");
  {
    // `running` is gated on `newest`. Ungated, an interrupted tool — stuck
    // `running` in the daemon's store, never newest again — blinks for the rest
    // of the session. That was measured on the live UI before the gate existed.
    check("a newest running row pulses", shouldPulse("running", { newest: true, fresh: false }) === true);
    check("a newest fresh row pulses", shouldPulse("completed", { newest: true, fresh: true }) === true);
    check("a stale running row does not", shouldPulse("running", { newest: false, fresh: false }) === false);
    check("a stale fresh row does not", shouldPulse("completed", { newest: false, fresh: true }) === false);
    check(
      "a newest but stale finished row does not",
      shouldPulse("completed", { newest: true, fresh: false }) === false,
    );
    check(
      "a just-committed finished row pulses whatever its outcome",
      shouldPulse("canceled", { newest: true, fresh: true }) === true &&
        shouldPulse("failed", { newest: true, fresh: true }) === true,
    );
    check("a stale canceled row does not", shouldPulse("canceled", { newest: false, fresh: false }) === false);
  }

  console.log("how long a pulse has left");
{
  // The row schedules its own wake-up from this, because nothing else re-renders
  // it: the sweep runs in an Animated loop on native and in CSS on web, and the
  // state timer that used to drive it went away with the opacity pulse. A wrong
  // answer here is a row that shimmers until unrelated news arrives.
  const commit = { seq: 1, seenAt: 1_000, bulk: false };
  check("a full window remains at commit time", pulseRemainingMs(commit, 1_000) === PULSE_MS, String(pulseRemainingMs(commit, 1_000)));
  check("halfway through, half is left", pulseRemainingMs(commit, 4_000) === PULSE_MS / 2, String(pulseRemainingMs(commit, 4_000)));
  check("the closing instant is still positive", pulseRemainingMs(commit, 1_000 + PULSE_MS - 1) === 1, String(pulseRemainingMs(commit, 1_000 + PULSE_MS - 1)));
  check("an expired window is zero, never negative", pulseRemainingMs(commit, 1_000 + PULSE_MS) === 0, String(pulseRemainingMs(commit, 1_000 + PULSE_MS)));
  check("and stays zero afterwards", pulseRemainingMs(commit, 999_999) === 0, String(pulseRemainingMs(commit, 999_999)));
  const agent = "agent-remaining";
  const committed = noteCommit(agent, 1_000);
  check("an expired window is exactly what isPulsing refuses", isPulsing(agent, committed, 1_000 + PULSE_MS) === false, "still pulsing");
  check("and it is still pulsing one millisecond earlier", isPulsing(agent, committed, 1_000 + PULSE_MS - 1) === true, "stopped early");
}

  console.log("normalizeRowTimestamp");
  {
    check("undefined returns 0", normalizeRowTimestamp(undefined) === 0);
    check("invalid string returns 0", normalizeRowTimestamp("not-a-date") === 0);
    check("NaN returns 0", normalizeRowTimestamp(Number.NaN) === 0);
    check("numeric ms passes through", normalizeRowTimestamp(base) === base);
    check("Date instance converts to ms", normalizeRowTimestamp(new Date(base)) === base);
    check("ISO string converts to ms", normalizeRowTimestamp(new Date(base).toISOString()) === base);
  }

  console.log("shouldEnterLive: live entrance vs replay and scroll-back");
  {
    check(
      "empty agentId never animates",
      shouldEnterLive("", base, true, "k-empty", base) === false,
    );

    // Unsettled session without liveHint (reopened history rows): silent.
    const histFirst = "enter-history-first";
    check(
      "unsettled session without liveHint stays silent",
      shouldEnterLive(histFirst, base, false, "h1", base) === false,
    );
    // History row still records itself on commit so a later scroll-back never animates.
    markRowAnimated(histFirst, base, "h1");
    // Multi-row first pass in pending queue suppresses even liveHint=true.
    noteRender(histFirst, base);
    noteRender(histFirst, base + 10);
    check(
      "multi-row pending first pass suppresses even liveHint",
      shouldEnterLive(histFirst, base + 20, true, "h2", base + 20) === false,
    );
    await settle();
    // After flushing a multi-row first pass, replayUntil suppresses immediate rows.
    const nowDuringReplay = Date.now();
    check(
      "replay window after multi-row first pass suppresses entrance",
      shouldEnterLive(histFirst, base + 30, true, "h3", nowDuringReplay) === false,
    );
    // Once replay window expires, a live row enters, whereas a committed history row stays silent.
    const afterReplay = nowDuringReplay + BULK_WINDOW_MS + 50;
    check(
      "committed history row stays silent even after replay window",
      shouldEnterLive(histFirst, base + 40, true, "h1", afterReplay) === false,
    );
    check(
      "a new row after the replay window enters",
      shouldEnterLive(histFirst, base + 40, false, "h4", afterReplay) === true,
    );

    // Brand-new session first live row: liveHint=true allowed when pending has <= 1 row,
    // is pure / side-effect free (StrictMode double-render safe), and must NOT populate
    // `rows` prematurely (preserving noteRender first-pass semantics).
    const freshLive = "enter-fresh-live";
    check(
      "brand-new session first row with liveHint enters",
      shouldEnterLive(freshLive, base, true, "live-0", base) === true,
    );
    check(
      "repeated shouldEnterLive before commit (StrictMode double render) still returns true",
      shouldEnterLive(freshLive, base, true, "live-0", base + 5) === true &&
        shouldEnterLive(freshLive, base, true, "live-0", base + 10) === true,
    );
    markRowAnimated(freshLive, base, "live-0");
    check(
      "after markRowAnimated on commit, same rowKey does not enter again",
      shouldEnterLive(freshLive, base, true, "live-0", base + 15) === false,
    );
    check(
      "shouldEnterLive + markRowAnimated did not pre-populate rows (first noteRender still returns false)",
      noteRender(freshLive, base) === false,
    );
    await settle();

    // Settled session: shouldEnterLive is pure across repeated calls, dedupes only after
    // markRowAnimated, and older timestamp row is rejected.
    const settled = "enter-settled";
    await pass(settled, [base + 500]);
    const settledNow = Date.now() + BULK_WINDOW_MS + 100;
    check(
      "live row at >= state.at enters and stays true across StrictMode double render",
      shouldEnterLive(settled, base + 600, false, "row-600", settledNow) === true &&
        shouldEnterLive(settled, base + 600, false, "row-600", settledNow + 10) === true,
    );
    markRowAnimated(settled, base + 600, "row-600");
    check(
      "scroll-back remount with same rowKey does not re-enter after markRowAnimated",
      shouldEnterLive(settled, base + 600, false, "row-600", settledNow + 50) === false,
    );
    check(
      "row without explicit rowKey is pure before commit and dedupes by String(at) after markRowAnimated",
      shouldEnterLive(settled, base + 700, false, undefined, settledNow + 60) === true &&
        shouldEnterLive(settled, base + 700, false, undefined, settledNow + 65) === true,
    );
    markRowAnimated(settled, base + 700);
    check(
      "row without explicit rowKey returns false once markRowAnimated records String(at)",
      shouldEnterLive(settled, base + 700, false, undefined, settledNow + 70) === false,
    );
    check(
      "older timestamp row remounting does not enter even with fresh key",
      shouldEnterLive(settled, base + 100, true, "old-row", settledNow + 80) === false,
    );

    // Bulk burst suppression: BULK_MIN_ROWS - 1 recent commits suppress entrance.
    const bulkAgent = "enter-bulk";
    await pass(bulkAgent, [base]);
    for (let i = 0; i < BULK_MIN_ROWS - 1; i += 1) {
      noteCommit(bulkAgent, base + 1000 + i * 10);
    }
    check(
      "bulk burst suppresses entrance inside BULK_WINDOW_MS",
      shouldEnterLive(bulkAgent, base + 2000, true, "burst-row", base + 1000 + 50) === false,
    );
    check(
      "entrance resumes once bulk window has elapsed",
      shouldEnterLive(bulkAgent, base + 2000, false, "burst-row", base + 1000 + BULK_WINDOW_MS + 100) === true,
    );

    // Bounded animatedKeys (cap 500): evicts oldest key when exceeding 500.
    const capAgent = "enter-cap";
    resetNewestForTests(capAgent);
    await pass(capAgent, [base]);
    const capNow = Date.now() + BULK_WINDOW_MS + 100;
    let all500Entered = true;
    for (let i = 0; i < 500; i += 1) {
      if (!shouldEnterLive(capAgent, base + i, false, `k-${i}`, capNow)) {
        all500Entered = false;
        break;
      }
      markRowAnimated(capAgent, base + i, `k-${i}`);
    }
    check("500 distinct keys all enter once", all500Entered === true);
    check(
      "501st key enters before commit",
      shouldEnterLive(capAgent, base + 500, false, "k-500", capNow) === true,
    );
    markRowAnimated(capAgent, base + 500, "k-500");
    check("second key is still remembered and deduped", shouldEnterLive(capAgent, base + 501, false, "k-1", capNow) === false);
    check("evicted oldest key can enter again", shouldEnterLive(capAgent, base + 502, false, "k-0", capNow) === true);
    resetNewestForTests(capAgent);
    check("resetNewestForTests clears remembered keys", shouldEnterLive(capAgent, base + 501, true, "k-1", capNow) === true);
    resetNewestForTests(capAgent);
  }

  console.log("stream-reveal: ink-trail cadence, unicode code points, and row progress");
  {
    const {
      STREAM_MAX_DURATION_MS,
      STREAM_MAX_VISIBLE_CHARS,
      STREAM_MIN_DURATION_MS,
      STREAM_TAIL_SETTLE_MS,
      STREAM_TRAIL_WIDTH,
      buildInkTrailSegments,
      calcStreamDurationMs,
      splitRowStreamProgress,
      streamCursorAt,
    } = require("./client/stream-reveal.js");

    check("empty text has 0ms duration", calcStreamDurationMs("") === 0);
    check(
      "short label clamps to STREAM_MIN_DURATION_MS",
      calcStreamDurationMs("读取") === STREAM_MIN_DURATION_MS,
      String(calcStreamDurationMs("读取")),
    );
    check(
      "very long line clamps to STREAM_MAX_DURATION_MS",
      calcStreamDurationMs("检查插件重载状态并核对进程数量配置版本与门禁测试结果".repeat(4)) ===
        STREAM_MAX_DURATION_MS,
    );
    check(
      "CJK text paces slower than equal-length ASCII text",
      calcStreamDurationMs("检查插件重载状态与进程数量配置版本") >
        calcStreamDurationMs("check plugin reload status ok now"),
    );

    check("cursor is 0 before lead-in completes", streamCursorAt(-10, 500, 20) === 0);
    const mid = streamCursorAt(250, 500, 20);
    check(
      "mid-stream cursor advances smoothly without jumping to end",
      mid > 8 && mid < 14,
      String(mid),
    );
    const settledCursor = streamCursorAt(500 + STREAM_TAIL_SETTLE_MS, 500, 20);
    check(
      "after streamMs + tailSettleMs, cursor clears full trail width",
      settledCursor >= 20 + STREAM_TRAIL_WIDTH,
      String(settledCursor),
    );

    check("zero progress emits no segments", buildInkTrailSegments("运行命令", 0).length === 0);
    const midSegs = buildInkTrailSegments("检查插件重载状态", 6.2);
    check(
      "mid-stream segments preserve exact revealed prefix and monotonic trailing opacity",
      midSegs.map((s) => s.text).join("") === "检查插件重载状" &&
        midSegs.length >= 3 &&
        midSegs[0].opacity > midSegs[midSegs.length - 1].opacity &&
        midSegs[midSegs.length - 1].highlight === 2,
      JSON.stringify(midSegs),
    );
    const emojiSegs = buildInkTrailSegments("🚀测试", 1.2);
    check(
      "unicode surrogate pair emoji is never split mid-code-point",
      emojiSegs.length === 2 && emojiSegs[0].text === "🚀" && emojiSegs[1].text === "测",
      JSON.stringify(emojiSegs),
    );
    const doneSegs = buildInkTrailSegments("运行命令", 4 + STREAM_TRAIL_WIDTH);
    check(
      "settled progress collapses to one plain segment",
      doneSegs.length === 1 &&
        doneSegs[0].text === "运行命令" &&
        doneSegs[0].opacity === 1 &&
        doneSegs[0].highlight === 0,
    );

    const earlyRow = splitRowStreamProgress("运行命令", "检查状态", 2);
    check(
      "while label is still streaming, separator and stat stay hidden",
      earlyRow.showSeparator === false && earlyRow.showStat === false && earlyRow.summaryProgress < 0,
    );
    const summaryPhase = splitRowStreamProgress("运行命令", "检查状态", 5.5);
    check(
      "once label finishes, separator shows and summary begins streaming",
      summaryPhase.showSeparator === true && summaryPhase.summaryProgress === 1.5,
    );
    const longSummary = "a".repeat(STREAM_MAX_VISIBLE_CHARS + 30);
    const cappedDone = splitRowStreamProgress(
      "读取",
      longSummary,
      2 + STREAM_MAX_VISIBLE_CHARS + STREAM_TRAIL_WIDTH,
    );
    check(
      "long summary hands off to Infinity once visible char budget settles",
      cappedDone.summaryProgress === Number.POSITIVE_INFINITY && cappedDone.showStat === true,
    );
    const thinkingTail = splitRowStreamProgress("思考", "…正在实时滚动尾部", 1, false);
    check(
      "streamSummary=false leaves summaryProgress at Infinity while label streams",
      thinkingTail.labelProgress === 1 && thinkingTail.summaryProgress === Number.POSITIVE_INFINITY,
    );
  }

console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
