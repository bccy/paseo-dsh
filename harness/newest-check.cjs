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

const Module = require("node:module");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const {
  BULK_MIN_ROWS,
  BULK_WINDOW_MS,
  PULSE_MS,
  commitMountEntrance,
  isPulsing,
  markRowAnimated,
  normalizeRowTimestamp,
  noteCommit,
  noteMountCandidate,
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
    const { yieldRowPulse } = require("./client/newest.js");
    yieldRowPulse(agent);
    check("yieldRowPulse immediately stops the last row when a reply streams below", isPulsing(agent, second, base + 55) === false);
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

    // Same-millisecond multi-row first pass must NOT collapse to 1.
    const sameMsFirst = "enter-same-ms-first";
    noteRender(sameMsFirst, base);
    noteRender(sameMsFirst, base);
    check(
      "same-millisecond multi-row first pass suppresses even liveHint",
      shouldEnterLive(sameMsFirst, base, true, "same-ms-1", base) === false,
    );
    await settle();
    check(
      "same-millisecond multi-row first pass activates replayUntil after flush",
      shouldEnterLive(sameMsFirst, base + 10, true, "same-ms-2", Date.now()) === false,
    );
    resetNewestForTests(sameMsFirst);

    // Already-settled agent receiving a multi-row batch (including same-ms rows)
    // must also be classified as a batch and activate replayUntil.
    const knownBatch = "enter-known-agent-batch";
    await pass(knownBatch, [base]);
    noteRender(knownBatch, base + 100);
    noteRender(knownBatch, base + 100);
    check(
      "settled agent with same-ms multi-row pending suppresses entrance immediately",
      shouldEnterLive(knownBatch, base + 100, true, "kb-1", Date.now() + BULK_WINDOW_MS + 100) === false,
    );
    await settle();
    const afterKnownBatchNow = Date.now();
    check(
      "settled agent multi-row flush sets replayUntil (not gated on !sawFirstPass)",
      shouldEnterLive(knownBatch, base + 200, true, "kb-2", afterKnownBatchNow) === false,
    );
    check(
      "settled agent resumes live entrance once replayUntil elapses",
      shouldEnterLive(knownBatch, base + 200, false, "kb-2", afterKnownBatchNow + BULK_WINDOW_MS + 50) === true,
    );
    resetNewestForTests(knownBatch);

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

  console.log("row-entrance & useInkStreamReveal: batch mount, terminal snap, and Web overflow observer");
  {
    const rowEntrancePath = join(__dirname, "client", "row-entrance.js");
    check("compiled client/row-entrance.js exists", existsSync(rowEntrancePath));

    function createMiniReactHarness({ includeLayoutEffect = true } = {}) {
      const instances = new Map();
      let activeKey = "root";
      let activeSlot = 0;
      let pendingLayoutEffects = [];
      let pendingEffects = [];
      let seenInstances = new Set();
      let changed = false;

      const sameDeps = (a, b) =>
        Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

      function storeOf(key) {
        let s = instances.get(key);
        if (!s) {
          s = [];
          instances.set(key, s);
        }
        return s;
      }

      function cleanupInstance(key) {
        const slots = instances.get(key);
        if (!slots) return;
        for (const slot of slots) {
          if (slot && typeof slot === "object" && typeof slot.cleanup === "function") {
            slot.cleanup();
            slot.cleanup = undefined;
          }
        }
        instances.delete(key);
      }

      function scheduleEffect(queue, effect, deps) {
        const slots = storeOf(activeKey);
        const i = activeSlot++;
        const slot = slots[i];
        if (slot !== undefined && sameDeps(slot.deps, deps)) return;
        slots[i] = { deps, cleanup: slot === undefined ? undefined : slot.cleanup };
        queue.push({ key: activeKey, index: i, effect });
      }

      const hooks = {
        useState(initial) {
          const slots = storeOf(activeKey);
          const i = activeSlot++;
          if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
          const keyCapture = activeKey;
          return [
            slots[i],
            (next) => {
              const s = storeOf(keyCapture);
              const value = typeof next === "function" ? next(s[i]) : next;
              if (!Object.is(value, s[i])) {
                s[i] = value;
                changed = true;
              }
            },
          ];
        },
        useRef(initial) {
          const slots = storeOf(activeKey);
          const i = activeSlot++;
          if (!(i in slots)) slots[i] = { current: initial };
          return slots[i];
        },
        useEffect(effect, deps) {
          scheduleEffect(pendingEffects, effect, deps);
        },
      };
      if (includeLayoutEffect) {
        hooks.useLayoutEffect = function useLayoutEffect(effect, deps) {
          scheduleEffect(pendingLayoutEffects, effect, deps);
        };
      }

      function expand(node, path) {
        if (node === null || node === undefined || typeof node !== "object") return node;
        if (Array.isArray(node)) return node.map((child, idx) => expand(child, `${path}[${idx}]`));
        if (typeof node.type === "function") {
          const instKey = `${path}:${node.type.name || "fn"}:${node.key ?? ""}`;
          seenInstances.add(instKey);
          const prevKey = activeKey;
          const prevSlot = activeSlot;
          activeKey = instKey;
          activeSlot = 0;
          const rendered = node.type(node.props);
          activeKey = prevKey;
          activeSlot = prevSlot;
          return expand(rendered, instKey);
        }
        if (node.props && node.props.children !== undefined) {
          return {
            ...node,
            props: {
              ...node.props,
              children: expand(node.props.children, `${path}/${String(node.type)}`),
            },
          };
        }
        return node;
      }

      function runQueue(queue) {
        for (const { key, index, effect } of queue) {
          if (!instances.has(key)) continue;
          const slot = storeOf(key)[index];
          if (typeof slot.cleanup === "function") slot.cleanup();
          const cleanup = effect();
          slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
        }
      }

      let lastRoot = null;
      function render(Component, props, onFirstFrame) {
        lastRoot = { Component, props };
        let tree;
        let passes = 0;
        do {
          changed = false;
          pendingLayoutEffects = [];
          pendingEffects = [];
          seenInstances = new Set();
          tree = expand({ type: Component, props }, "root");
          if (passes === 0 && typeof onFirstFrame === "function") onFirstFrame(tree);
          for (const key of Array.from(instances.keys())) {
            if (!seenInstances.has(key)) cleanupInstance(key);
          }
          const layouts = pendingLayoutEffects;
          const passives = pendingEffects;
          pendingLayoutEffects = [];
          pendingEffects = [];
          runQueue(layouts);
          runQueue(passives);
          passes += 1;
        } while (changed && passes < 6);
        return tree;
      }

      function flushPendingRerender() {
        if (changed && lastRoot !== null) {
          return render(lastRoot.Component, lastRoot.props);
        }
        return null;
      }

      function unmountAll() {
        for (const key of Array.from(instances.keys())) {
          cleanupInstance(key);
        }
      }

      return { hooks, render, flushPendingRerender, unmountAll };
    }

    function findAllNodes(node, predicate, out = []) {
      if (node === null || node === undefined || typeof node !== "object") return out;
      if (Array.isArray(node)) {
        for (const item of node) findAllNodes(item, predicate, out);
        return out;
      }
      if (predicate(node)) out.push(node);
      if (node.props && node.props.children !== undefined) {
        findAllNodes(node.props.children, predicate, out);
      }
      return out;
    }

    function loadRowEntrance(rnStub, hooks) {
      const originalLoad = Module._load;
      for (const key of Object.keys(require.cache)) {
        if (key.endsWith("row-entrance.js")) delete require.cache[key];
      }
      Module._load = function load(request, parent, isMain) {
        if (request === "react") return hooks;
        if (request === "react/jsx-runtime") {
          return {
            jsx: (type, props, key) => ({ type, props, key }),
            jsxs: (type, props, key) => ({ type, props, key }),
            Fragment: "Fragment",
          };
        }
        if (request === "react-native") return rnStub;
        return originalLoad.call(this, request, parent, isMain);
      };
      try {
        return require(rowEntrancePath);
      } finally {
        Module._load = originalLoad;
      }
    }

    // 1. Known settled agent batch-mounting 5 completed rows at once (both
    //    distinct and same-ms timestamps): 0 entrance animations, 0 ink reveals,
    //    full titles visible on frame 0.
    {
      const prevDoc = global.document;
      const prevWin = global.window;
      global.document = {
        getElementById: () => null,
        createElement: (tag) => ({ tag, id: "", textContent: "" }),
        head: { appendChild: () => {} },
      };
      global.window = {};
      const harness = createMiniReactHarness({ includeLayoutEffect: true });
      try {
        const mod = loadRowEntrance(
          { Platform: { OS: "web" }, View: "View", Text: "Text" },
          harness.hooks,
        );
        const { RowEntrance, ROW_ENTER_TEST_ID, useInkStreamReveal, renderInkTrailText } = mod;

        const batchAgent = "component-known-batch-5";
        resetNewestForTests(batchAgent);
        await pass(batchAgent, [base]);
        // Wait past any initial window by verifying state is settled.
        const rowsSpec = [0, 1, 2, 3, 4].map((i) => ({
          key: `hist-${i}`,
          ts: base + 100 + i * 10,
          label: `读取文件${i}`,
          summary: `src/file-${i}.ts`,
        }));

        function RowItem({ agentId, ts, rowKey, liveHint, label, summary }) {
          const stream = useInkStreamReveal({
            agentId,
            timestamp: ts,
            rowKey,
            liveHint,
            label,
            summary,
          });
          const renderedLabel = renderInkTrailText(label, stream.labelProgress, "#fff", null);
          return {
            type: RowEntrance,
            props: {
              agentId,
              timestamp: ts,
              rowKey,
              liveHint,
              children: {
                type: "Title",
                props: {
                  rowKey,
                  active: stream.active,
                  labelProgress: stream.labelProgress,
                  renderedLabel,
                },
              },
            },
          };
        }

        function BatchList({ agentId, items }) {
          return {
            type: "List",
            props: {
              children: items.map((item) => ({
                type: RowItem,
                key: item.key,
                props: {
                  agentId,
                  ts: item.ts,
                  rowKey: item.key,
                  liveHint: false,
                  label: item.label,
                  summary: item.summary,
                },
              })),
            },
          };
        }

        let firstFrameTitles = [];
        let firstFrameEnters = [];
        const finalTree = harness.render(BatchList, { agentId: batchAgent, items: rowsSpec }, (frame0) => {
          firstFrameTitles = findAllNodes(frame0, (n) => n.type === "Title");
          firstFrameEnters = findAllNodes(frame0, (n) => n.props?.testID === ROW_ENTER_TEST_ID);
        });
        const finalTitles = findAllNodes(finalTree, (n) => n.type === "Title");
        const finalEnters = findAllNodes(finalTree, (n) => n.props?.testID === ROW_ENTER_TEST_ID);

        check(
          "known agent batch-mounting 5 completed rows: frame 0 has full non-empty titles and 0 entrance animations",
          firstFrameTitles.length === 5 &&
            firstFrameTitles.every(
              (t, idx) =>
                t.props.renderedLabel === rowsSpec[idx].label &&
                t.props.active === false &&
                t.props.labelProgress === Number.POSITIVE_INFINITY,
            ) &&
            firstFrameEnters.length === 0,
          JSON.stringify(firstFrameTitles.map((t) => t.props)),
        );
        check(
          "known agent batch-mounting 5 completed rows: after commit 0 rows animate or stream-reveal",
          finalEnters.length === 0 &&
            finalTitles.length === 5 &&
            finalTitles.every((t) => t.props.active === false && t.props.labelProgress === Number.POSITIVE_INFINITY),
        );
        // All 5 rows must be marked animated so later remounts stay static too.
        const farFuture = Date.now() + BULK_WINDOW_MS + 500;
        check(
          "all 5 batch-mounted completed rows are recorded in animatedKeys",
          rowsSpec.every((r) => shouldEnterLive(batchAgent, r.ts, false, r.key, farFuture) === false),
        );
        harness.unmountAll();
        await settle();

        // Same-ms 5-row batch on known agent also triggers 0 animations.
        const sameMsAgent = "component-known-same-ms-batch";
        resetNewestForTests(sameMsAgent);
        await pass(sameMsAgent, [base]);
        const sameMsRows = [0, 1, 2, 3, 4].map((i) => ({
          key: `same-ms-${i}`,
          ts: base,
          label: `命令${i}`,
          summary: `echo ${i}`,
        }));
        const sameMsTree = harness.render(BatchList, { agentId: sameMsAgent, items: sameMsRows });
        const sameMsEnters = findAllNodes(sameMsTree, (n) => n.props?.testID === ROW_ENTER_TEST_ID);
        const sameMsTitles = findAllNodes(sameMsTree, (n) => n.type === "Title");
        check(
          "known agent batch-mounting 5 same-ms rows triggers 0 entrance and 0 reveal",
          sameMsEnters.length === 0 &&
            sameMsTitles.every((t, idx) => t.props.active === false && t.props.renderedLabel === sameMsRows[idx].label),
        );
        harness.unmountAll();
        await settle();

        // Control: a single genuine live row on a known agent DOES trigger both
        // RowEntrance and useInkStreamReveal (proving the gate is not always-off).
        const singleLiveAgent = "component-single-live-row";
        resetNewestForTests(singleLiveAgent);
        await pass(singleLiveAgent, [base]);
        const singleTree = harness.render(RowItem, {
          agentId: singleLiveAgent,
          ts: base + 500,
          rowKey: "live-only-1",
          liveHint: true,
          label: "运行命令",
          summary: "git status",
        });
        const singleEnters = findAllNodes(singleTree, (n) => n.props?.testID === ROW_ENTER_TEST_ID);
        const singleTitles = findAllNodes(singleTree, (n) => n.type === "Title");
        check(
          "control: single genuine live row activates both RowEntrance and useInkStreamReveal",
          singleEnters.length === 1 && singleTitles.length === 1 && singleTitles[0].props.active === true,
          `enters=${singleEnters.length}, active=${singleTitles[0]?.props?.active}`,
        );
        harness.unmountAll();
        await settle();
        resetNewestForTests(batchAgent);
        resetNewestForTests(sameMsAgent);
        resetNewestForTests(singleLiveAgent);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
      }
    }

    // 2. Minimal React stub without useLayoutEffect must fall back to useEffect safely.
    {
      const prevDoc = global.document;
      const prevWin = global.window;
      global.document = {
        getElementById: () => null,
        createElement: (tag) => ({ tag, id: "", textContent: "" }),
        head: { appendChild: () => {} },
      };
      global.window = {};
      const noLayoutHarness = createMiniReactHarness({ includeLayoutEffect: false });
      try {
        const mod = loadRowEntrance(
          { Platform: { OS: "web" }, View: "View", Text: "Text" },
          noLayoutHarness.hooks,
        );
        const { RowEntrance, ROW_ENTER_TEST_ID, useInkStreamReveal } = mod;
        const stubAgent = "no-layout-effect-agent";
        resetNewestForTests(stubAgent);
        await pass(stubAgent, [base]);
        let threw = false;
        let tree = null;
        try {
          function SingleProbe() {
            const s = useInkStreamReveal({
              agentId: stubAgent,
              timestamp: base + 100,
              rowKey: "stub-1",
              liveHint: true,
              label: "读取",
              summary: "a.ts",
            });
            return {
              type: RowEntrance,
              props: {
                agentId: stubAgent,
                timestamp: base + 100,
                rowKey: "stub-1",
                liveHint: true,
                children: { type: "Out", props: { active: s.active } },
              },
            };
          }
          tree = noLayoutHarness.render(SingleProbe, {});
        } catch (err) {
          threw = true;
          console.error(err);
        }
        const enters = tree ? findAllNodes(tree, (n) => n.props?.testID === ROW_ENTER_TEST_ID) : [];
        const outs = tree ? findAllNodes(tree, (n) => n.type === "Out") : [];
        check(
          "row-entrance safely falls back to useEffect when useLayoutEffect is absent from stub",
          !threw && enters.length === 1 && outs[0]?.props?.active === true,
        );
        noLayoutHarness.unmountAll();
        await settle();
        resetNewestForTests(stubAgent);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
      }
    }

    // 3. useInkStreamReveal snaps immediately to Infinity and cancels RAF/timer
    //    when liveHint transitions from true -> false mid-reveal.
    {
      const prevRaf = global.requestAnimationFrame;
      const prevCancelRaf = global.cancelAnimationFrame;
      const prevPerf = global.performance;
      const prevWin = global.window;
      let fakeNow = 1000;
      let nextRafId = 1;
      const pendingRafs = new Map();
      const cancelledRafIds = [];
      global.performance = { now: () => fakeNow };
      global.requestAnimationFrame = (cb) => {
        const id = nextRafId++;
        pendingRafs.set(id, cb);
        return id;
      };
      global.cancelAnimationFrame = (id) => {
        cancelledRafIds.push(id);
        pendingRafs.delete(id);
      };
      global.window = {};

      const harness = createMiniReactHarness({ includeLayoutEffect: true });
      const snapAgent = "stream-terminal-snap-raf";
      resetNewestForTests(snapAgent);
      try {
        await pass(snapAgent, [base]);
        const mod = loadRowEntrance(
          { Platform: { OS: "web" }, View: "View", Text: "Text" },
          harness.hooks,
        );
        const { useInkStreamReveal, renderInkTrailText } = mod;

        let latest = null;
        function StreamProbe({ liveHint, label, summary }) {
          const s = useInkStreamReveal({
            agentId: snapAgent,
            timestamp: base + 200,
            rowKey: "snap-row-1",
            liveHint,
            label,
            summary,
          });
          latest = {
            ...s,
            renderedLabel: renderInkTrailText(label, s.labelProgress, "#fff", null),
            renderedSummary: renderInkTrailText(summary, s.summaryProgress, "#fff", null),
          };
          return { type: "Probe", props: latest };
        }

        // Start running: reveal becomes active and schedules a RAF callback.
        harness.render(StreamProbe, {
          liveHint: true,
          label: "运行命令",
          summary: "npm run test:all",
        });
        const initialPendingRafCount = pendingRafs.size;
        // Advance halfway through reveal (still finite).
        fakeNow += 120;
        for (const [id, cb] of Array.from(pendingRafs.entries())) {
          pendingRafs.delete(id);
          cb(fakeNow);
        }
        harness.flushPendingRerender();
        const midActive = latest.active;
        const midFinite = Number.isFinite(latest.labelProgress);
        const rafQueuedMid = pendingRafs.size;

        check(
          "mid-stream live row is actively revealing with a queued RAF frame",
          initialPendingRafCount === 1 && midActive === true && midFinite === true && rafQueuedMid === 1,
          JSON.stringify({ initialPendingRafCount, midActive, midFinite, rafQueuedMid }),
        );

        // Transition liveHint true -> false (e.g. tool failed early).
        let snapFrame0 = null;
        harness.render(
          StreamProbe,
          {
            liveHint: false,
            label: "运行命令",
            summary: "已失败：exit code 1",
          },
          (f0) => {
            snapFrame0 = f0.props;
          },
        );
        check(
          "liveHint true -> false snaps immediately on frame 0 to Infinity with full headline & failure summary",
          snapFrame0 !== null &&
            snapFrame0.active === false &&
            snapFrame0.labelProgress === Number.POSITIVE_INFINITY &&
            snapFrame0.summaryProgress === Number.POSITIVE_INFINITY &&
            snapFrame0.renderedLabel === "运行命令" &&
            snapFrame0.renderedSummary === "已失败：exit code 1",
          JSON.stringify(snapFrame0),
        );
        check(
          "liveHint true -> false cancels pending RAF and leaves zero queued frames",
          cancelledRafIds.length >= 1 &&
            pendingRafs.size === 0 &&
            latest.active === false &&
            latest.labelProgress === Number.POSITIVE_INFINITY,
          `cancelled=${JSON.stringify(cancelledRafIds)}, pending=${pendingRafs.size}`,
        );
        harness.unmountAll();
        await settle();

        // Also verify timer fallback path (no requestAnimationFrame) clears setTimeout immediately.
        global.requestAnimationFrame = undefined;
        global.cancelAnimationFrame = undefined;
        const prevSetTimeout = global.setTimeout;
        const prevClearTimeout = global.clearTimeout;
        let nextTimerId = 100;
        const pendingTimers = new Map();
        const clearedTimerIds = [];
        global.setTimeout = (fn) => {
          const id = nextTimerId++;
          pendingTimers.set(id, fn);
          return id;
        };
        global.clearTimeout = (id) => {
          clearedTimerIds.push(id);
          pendingTimers.delete(id);
        };
        const timerAgent = "stream-terminal-snap-timer";
        resetNewestForTests(timerAgent);
        try {
          // settle without our mocked setTimeout by advancing state directly
          noteRender(timerAgent, base);
          await Promise.resolve();
          const timerHarness = createMiniReactHarness({ includeLayoutEffect: true });
          const timerMod = loadRowEntrance(
            { Platform: { OS: "web" }, View: "View", Text: "Text" },
            timerHarness.hooks,
          );
          let timerLatest = null;
          function TimerProbe({ liveHint, label, summary }) {
            timerLatest = timerMod.useInkStreamReveal({
              agentId: timerAgent,
              timestamp: base + 200,
              rowKey: "snap-timer-1",
              liveHint,
              label,
              summary,
            });
            return { type: "Probe", props: timerLatest };
          }
          timerHarness.render(TimerProbe, { liveHint: true, label: "编辑", summary: "app.ts" });
          const queuedBefore = pendingTimers.size;
          timerHarness.render(TimerProbe, { liveHint: false, label: "编辑", summary: "已完成" });
          check(
            "timer fallback path cancels pending setTimeout and snaps to Infinity on liveHint true -> false",
            queuedBefore === 1 &&
              clearedTimerIds.length >= 1 &&
              pendingTimers.size === 0 &&
              timerLatest.active === false &&
              timerLatest.labelProgress === Number.POSITIVE_INFINITY,
            `queuedBefore=${queuedBefore}, cleared=${JSON.stringify(clearedTimerIds)}, pending=${pendingTimers.size}`,
          );
          timerHarness.unmountAll();
          await Promise.resolve();
        } finally {
          global.setTimeout = prevSetTimeout;
          global.clearTimeout = prevClearTimeout;
          resetNewestForTests(timerAgent);
        }
      } finally {
        global.requestAnimationFrame = prevRaf;
        global.cancelAnimationFrame = prevCancelRaf;
        global.performance = prevPerf;
        global.window = prevWin;
        resetNewestForTests(snapAgent);
      }
    }

    // 4. Web scroll-box overflow observer: dynamic data-dsh-overflow-y toggling,
    //    unobserve on unmount, and safety under minimal DOM stubs.
    {
      const prevDoc = global.document;
      const prevRO = global.ResizeObserver;
      const prevMO = global.MutationObserver;
      try {
        const harness = createMiniReactHarness({ includeLayoutEffect: true });
        const mod = loadRowEntrance(
          { Platform: { OS: "web" }, View: "View", Text: "Text" },
          harness.hooks,
        );
        const {
          SCROLL_BOX_TEST_ID,
          SCROLL_OVERFLOW_Y_ATTR,
          ensureRowEntranceStyles,
        } = mod;

        function makeFakeElement({ testId, scrollHeight = 100, clientHeight = 200, child = null } = {}) {
          const attrs = new Map();
          if (testId !== undefined) attrs.set("data-testid", testId);
          const el = {
            scrollHeight,
            clientHeight,
            firstElementChild: child,
            parentElement: null,
            isConnected: true,
            getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
            setAttribute: (name, value) => attrs.set(name, String(value)),
            removeAttribute: (name) => attrs.delete(name),
            matches: (sel) => sel === `[data-testid="${SCROLL_BOX_TEST_ID}"]` && attrs.get("data-testid") === SCROLL_BOX_TEST_ID,
            closest: (sel) => (el.matches(sel) ? el : null),
            querySelectorAll: () => [],
          };
          if (child) {
            child.parentElement = el;
            child.closest = (sel) => (el.matches(sel) ? el : null);
          }
          return el;
        }

        const observedTargets = new Set();
        const unobservedTargets = [];
        let resizeCb = null;
        let mutationCb = null;
        global.ResizeObserver = class FakeResizeObserver {
          constructor(cb) {
            resizeCb = cb;
          }
          observe(target) {
            observedTargets.add(target);
          }
          unobserve(target) {
            observedTargets.delete(target);
            unobservedTargets.push(target);
          }
        };
        global.MutationObserver = class FakeMutationObserver {
          constructor(cb) {
            mutationCb = cb;
          }
          observe() {}
          disconnect() {}
        };

        const child1 = makeFakeElement({});
        const shortBox = makeFakeElement({
          testId: SCROLL_BOX_TEST_ID,
          scrollHeight: 120,
          clientHeight: 200,
          child: child1,
        });
        const injected = new Map();
        global.document = {
          getElementById: (id) => injected.get(id) ?? null,
          createElement: (tag) => ({ tag, id: "", textContent: "" }),
          head: { appendChild: (el) => injected.set(el.id, el) },
          body: makeFakeElement({}),
          querySelectorAll: (sel) => (sel === `[data-testid="${SCROLL_BOX_TEST_ID}"]` ? [shortBox] : []),
        };

        ensureRowEntranceStyles();
        const styleSheet = injected.get("dsh-paseo-row-entrance");
        check(
          "Web CSS scopes overscroll-behavior-y: contain strictly to [data-dsh-overflow-y=\"true\"]",
          styleSheet !== undefined &&
            styleSheet.textContent.includes(
              `[data-testid="${SCROLL_BOX_TEST_ID}"][${SCROLL_OVERFLOW_Y_ATTR}="true"]`,
            ) &&
            styleSheet.textContent.includes("overscroll-behavior-y: contain") &&
            !styleSheet.textContent.includes(`[data-testid="${SCROLL_BOX_TEST_ID}"] {`),
          styleSheet?.textContent,
        );
        check(
          "short scroll box (scrollHeight <= clientHeight + 1) does NOT get data-dsh-overflow-y",
          shortBox.getAttribute(SCROLL_OVERFLOW_Y_ATTR) === null &&
            observedTargets.has(shortBox) &&
            observedTargets.has(child1),
        );

        // Grow content child so scrollBox now overflows vertically.
        shortBox.scrollHeight = 340;
        resizeCb([{ target: child1 }]);
        check(
          "overflowing scroll box gets data-dsh-overflow-y=\"true\" when content child resizes",
          shortBox.getAttribute(SCROLL_OVERFLOW_Y_ATTR) === "true",
        );

        // Shrink back to non-overflowing via DOM/text mutation (within +1px tolerance).
        shortBox.scrollHeight = 201;
        mutationCb([{ type: "characterData", target: child1 }]);
        check(
          "scroll box removes data-dsh-overflow-y when content shrinks within +1px tolerance",
          shortBox.getAttribute(SCROLL_OVERFLOW_Y_ATTR) === null,
        );

        // Dynamically mount a second overflowing box via MutationObserver addedNodes.
        const child2 = makeFakeElement({});
        const dynamicBox = makeFakeElement({
          testId: SCROLL_BOX_TEST_ID,
          scrollHeight: 480,
          clientHeight: 260,
          child: child2,
        });
        mutationCb([{ type: "childList", target: global.document.body, addedNodes: [dynamicBox], removedNodes: [] }]);
        check(
          "dynamically mounted overflowing scroll box immediately receives data-dsh-overflow-y=\"true\" and is observed",
          dynamicBox.getAttribute(SCROLL_OVERFLOW_Y_ATTR) === "true" &&
            observedTargets.has(dynamicBox) &&
            observedTargets.has(child2),
        );

        // Unmount the dynamic box -> must unobserve both box and its content child to prevent leaks.
        dynamicBox.isConnected = false;
        mutationCb([{ type: "childList", target: global.document.body, addedNodes: [], removedNodes: [dynamicBox] }]);
        check(
          "removed scroll box unobserves both container and content child (no observer leak)",
          !observedTargets.has(dynamicBox) &&
            !observedTargets.has(child2) &&
            unobservedTargets.includes(dynamicBox) &&
            unobservedTargets.includes(child2),
        );

        // Minimal DOM stub missing MutationObserver, ResizeObserver, querySelectorAll, and body.
        global.ResizeObserver = undefined;
        global.MutationObserver = undefined;
        const minimalInjected = new Map();
        global.document = {
          getElementById: (id) => minimalInjected.get(id) ?? null,
          createElement: (tag) => ({ tag, id: "", textContent: "" }),
          head: { appendChild: (el) => minimalInjected.set(el.id, el) },
        };
        let minimalOk = true;
        try {
          ensureRowEntranceStyles();
          // Calling a second time is idempotent.
          ensureRowEntranceStyles();
        } catch (err) {
          minimalOk = false;
          console.error(err);
        }
        check(
          "ensureRowEntranceStyles is safe and idempotent under minimal stub without MutationObserver/ResizeObserver/body",
          minimalOk && minimalInjected.has("dsh-paseo-row-entrance"),
        );
        mod.disposeRowEntranceObservers();
      } finally {
        global.document = prevDoc;
        global.ResizeObserver = prevRO;
        global.MutationObserver = prevMO;
      }
    }

    // 5. StrictMode double-render of a single live row with stable identity does NOT trigger batch suppression;
    //    existing row updating timestamp (firstPaint=false) alongside 1 new tool row also enters cleanly.
    {
      const prevDoc = global.document;
      const prevWin = global.window;
      global.document = {
        getElementById: () => null,
        createElement: (tag) => ({ tag, id: "", textContent: "" }),
        head: { appendChild: () => {} },
      };
      global.window = {};
      const harness = createMiniReactHarness({ includeLayoutEffect: true });
      const strictAgent = "strict-mode-single-live";
      const mixedUpdateAgent = "existing-update-plus-new-tool";
      const distinctSameMsAgent = "distinct-identities-same-ms";
      resetNewestForTests(strictAgent);
      resetNewestForTests(mixedUpdateAgent);
      resetNewestForTests(distinctSameMsAgent);
      try {
        await pass(strictAgent, [base]);
        await pass(mixedUpdateAgent, [base]);
        await pass(distinctSameMsAgent, [base]);

        const mod = loadRowEntrance(
          { Platform: { OS: "web" }, View: "View", Text: "Text" },
          harness.hooks,
        );
        const { RowEntrance, ROW_ENTER_TEST_ID, useInkStreamReveal } = mod;

        // 5a. Simulate React StrictMode rendering a single live row twice in one pass with the same identity.
        const rowTs = base + 100;
        const rowId = "tool:strict-single-1";
        noteRender(strictAgent, rowTs, true, rowId);
        noteRender(strictAgent, rowTs, true, rowId);
        noteMountCandidate(strictAgent, rowTs, rowId);
        noteMountCandidate(strictAgent, rowTs, rowId);

        function StrictLiveRow() {
          const stream = useInkStreamReveal({
            agentId: strictAgent,
            timestamp: rowTs,
            rowKey: rowId,
            liveHint: true,
            label: "运行命令",
            summary: "echo strict",
          });
          return {
            type: RowEntrance,
            props: {
              agentId: strictAgent,
              timestamp: rowTs,
              rowKey: rowId,
              liveHint: true,
              children: { type: "Title", props: { active: stream.active } },
            },
          };
        }

        const strictTree = harness.render(StrictLiveRow, {});
        const strictEnters = findAllNodes(strictTree, (n) => n.props?.testID === ROW_ENTER_TEST_ID);
        const strictTitles = findAllNodes(strictTree, (n) => n.type === "Title");
        check(
          "StrictMode double render of a single live row with stable identity still activates entrance and reveal",
          strictEnters.length === 1 && strictTitles.length === 1 && strictTitles[0].props.active === true,
          `enters=${strictEnters.length}, active=${strictTitles[0]?.props?.active}`,
        );
        harness.unmountAll();
        await settle();
        check(
          "StrictMode single live row does not arm replayUntil after pass flush",
          shouldEnterLive(strictAgent, rowTs + 20, true, "tool:strict-next", Date.now()) === true,
        );

        // Negative control: two distinct identities at the same ms STILL register as a batch.
        noteRender(distinctSameMsAgent, base + 100, true, "tool:batch-a");
        noteRender(distinctSameMsAgent, base + 100, true, "tool:batch-b");
        check(
          "two distinct row identities at the same ms still suppress entrance as a batch",
          commitMountEntrance(distinctSameMsAgent, base + 100, true, "tool:batch-a") === false,
        );
        await settle();

        // 5b. Existing row updates timestamp (firstPaint=false) + 1 new tool row mounts in same pass.
        noteRender(mixedUpdateAgent, base + 50, false, "row:existing-1");
        noteRender(mixedUpdateAgent, base + 60, true, "tool:new-live-1");
        noteMountCandidate(mixedUpdateAgent, base + 60, "tool:new-live-1");
        const mixedEntered = commitMountEntrance(mixedUpdateAgent, base + 60, true, "tool:new-live-1");
        await settle();
        check(
          "existing row updating timestamp (firstPaint=false) plus 1 new tool row does not misclassify as batch",
          mixedEntered === true &&
            shouldEnterLive(mixedUpdateAgent, base + 70, true, "tool:new-live-2", Date.now()) === true,
          `mixedEntered=${mixedEntered}`,
        );

        // 5c. Concurrent render slicing across microtask yields:
        //     Slice 1 mounts rows 1..N (or even a single first row) -> microtask flush runs before commit ->
        //     Slice 2 mounts the final row -> commit phase must still classify the whole commit as a batch
        //     (0 entrance animations) and retire the sealed batch on the post-commit microtask.
        const slicedAgent = "agent-concurrent-slice";
        const abandonedAgent = "agent-abandoned-render";
        resetNewestForTests(slicedAgent);
        resetNewestForTests(abandonedAgent);
        const sliceNow = Date.now();
        // Two-slice history mount where slice 1 has 1 row and yields across a microtask before slice 2 renders row 2.
        noteMountCandidate(slicedAgent, base + 200, "tool:slice-1", sliceNow);
        await settle(); // flush() runs before commit — unsealed batch must survive!
        noteMountCandidate(slicedAgent, base + 201, "tool:slice-2", sliceNow + 10);
        const slice1Commit = commitMountEntrance(slicedAgent, base + 200, true, "tool:slice-1", sliceNow + 12);
        const slice2Commit = commitMountEntrance(slicedAgent, base + 201, true, "tool:slice-2", sliceNow + 12);
        await settle(); // sealed batch must now be retired cleanly
        const postReplayLive = commitMountEntrance(
          slicedAgent,
          base + 300,
          true,
          "tool:slice-live-after",
          sliceNow + BULK_WINDOW_MS + 50,
        );
        check(
          "concurrent render slices separated by a microtask yield still coalesce into a suppressed batch and resume live after replay window",
          slice1Commit === false && slice2Commit === false && postReplayLive === true,
          JSON.stringify({ slice1Commit, slice2Commit, postReplayLive }),
        );

        // Abandoned uncommitted single-row render ages out after BULK_WINDOW_MS so a later genuine live row still enters.
        noteMountCandidate(abandonedAgent, base + 400, "tool:abandoned-1", sliceNow);
        await settle();
        const laterLiveNow = sliceNow + BULK_WINDOW_MS + 20;
        noteMountCandidate(abandonedAgent, base + 410, "tool:later-live", laterLiveNow);
        const laterLiveCommit = commitMountEntrance(
          abandonedAgent,
          base + 410,
          true,
          "tool:later-live",
          laterLiveNow,
        );
        check(
          "abandoned uncommitted single-row render expires after BULK_WINDOW_MS and does not suppress a later live row",
          laterLiveCommit === true,
          `laterLiveCommit=${laterLiveCommit}`,
        );
        resetNewestForTests(slicedAgent);
        resetNewestForTests(abandonedAgent);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        resetNewestForTests(strictAgent);
        resetNewestForTests(mixedUpdateAgent);
        resetNewestForTests(distinctSameMsAgent);
      }
    }

    // 6. Hot-swap CSS overwrite, cross-bundle observer replacement/disposal,
    //    and zero scrollHeight reads on unrelated scroll boxes during outside DOM mutations.
    {
      const prevDoc = global.document;
      const prevRO = global.ResizeObserver;
      const prevMO = global.MutationObserver;
      try {
        const harness = createMiniReactHarness({ includeLayoutEffect: true });
        const rnStub = { Platform: { OS: "web" }, View: "View", Text: "Text" };
        const mod1 = loadRowEntrance(rnStub, harness.hooks);
        const { SCROLL_BOX_TEST_ID, SCROLL_OVERFLOW_Y_ATTR } = mod1;

        const createdROs = [];
        const createdMOs = [];
        global.ResizeObserver = class TrackingResizeObserver {
          constructor(cb) {
            this.cb = cb;
            this.disconnected = false;
            this.observed = new Set();
            createdROs.push(this);
          }
          observe(target) {
            this.observed.add(target);
          }
          unobserve(target) {
            this.observed.delete(target);
          }
          disconnect() {
            this.disconnected = true;
            this.observed.clear();
          }
        };
        global.MutationObserver = class TrackingMutationObserver {
          constructor(cb) {
            this.cb = cb;
            this.disconnected = false;
            this.observeOptions = null;
            createdMOs.push(this);
          }
          observe(_root, options) {
            this.observeOptions = options;
          }
          disconnect() {
            this.disconnected = true;
          }
        };

        function makeTrackedBox(initialScrollHeight, clientHeight) {
          let scrollHeightVal = initialScrollHeight;
          let scrollHeightReads = 0;
          const attrs = new Map([["data-testid", SCROLL_BOX_TEST_ID]]);
          const child = {
            parentElement: null,
            isConnected: true,
            matches: () => false,
            closest: null,
            querySelectorAll: () => [],
          };
          const box = {
            clientHeight,
            firstElementChild: child,
            parentElement: null,
            isConnected: true,
            getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
            setAttribute: (name, value) => attrs.set(name, String(value)),
            removeAttribute: (name) => attrs.delete(name),
            matches: (sel) => sel === `[data-testid="${SCROLL_BOX_TEST_ID}"]` && attrs.get("data-testid") === SCROLL_BOX_TEST_ID,
            closest: (sel) => (box.matches(sel) ? box : null),
            querySelectorAll: () => [],
            getReads: () => scrollHeightReads,
            resetReads: () => {
              scrollHeightReads = 0;
            },
          };
          Object.defineProperty(box, "scrollHeight", {
            get() {
              scrollHeightReads += 1;
              return scrollHeightVal;
            },
            set(v) {
              scrollHeightVal = v;
            },
            enumerable: true,
            configurable: true,
          });
          child.parentElement = box;
          child.closest = (sel) => (box.matches(sel) ? box : null);
          return { box, child };
        }

        const trackedA = makeTrackedBox(120, 200);
        const trackedB = makeTrackedBox(400, 200);
        const unrelatedDiv = {
          parentElement: null,
          isConnected: true,
          matches: () => false,
          closest: () => null,
          querySelectorAll: () => [],
        };
        const unrelatedSpan = {
          parentElement: unrelatedDiv,
          isConnected: true,
          matches: () => false,
          closest: () => null,
          querySelectorAll: () => [],
        };

        // 6a. Pre-seed stale legacy stylesheet with unconditional overscroll-behavior-y: contain.
        const staleStyle = {
          id: "dsh-paseo-row-entrance",
          textContent: `[data-testid="${SCROLL_BOX_TEST_ID}"] { overscroll-behavior-y: contain; }`,
        };
        const injected = new Map([["dsh-paseo-row-entrance", staleStyle]]);
        let appendCalls = 0;
        const sharedDoc = {
          getElementById: (id) => injected.get(id) ?? null,
          createElement: (tag) => ({ tag, id: "", textContent: "" }),
          head: {
            appendChild: (el) => {
              appendCalls += 1;
              injected.set(el.id, el);
            },
          },
          body: { matches: () => false, closest: () => null, querySelectorAll: () => [] },
          querySelectorAll: (sel) =>
            sel === `[data-testid="${SCROLL_BOX_TEST_ID}"]` ? [trackedA.box, trackedB.box] : [],
        };
        global.document = sharedDoc;

        mod1.ensureRowEntranceStyles();
        check(
          "ensureRowEntranceStyles overwrites stale legacy stylesheet in place with conditional overflow-y CSS",
          appendCalls === 0 &&
            staleStyle.textContent.includes(
              `[data-testid="${SCROLL_BOX_TEST_ID}"][${SCROLL_OVERFLOW_Y_ATTR}="true"]`,
            ) &&
            staleStyle.textContent.includes("overscroll-behavior-y: contain") &&
            !staleStyle.textContent.includes(`[data-testid="${SCROLL_BOX_TEST_ID}"] {`),
          `appendCalls=${appendCalls}, css=${staleStyle.textContent}`,
        );
        check(
          "MutationObserver does not subscribe to characterData mutations",
          createdMOs.length === 1 && createdMOs[0].observeOptions?.characterData !== true,
          JSON.stringify(createdMOs[0]?.observeOptions),
        );

        // 6b. Outside unrelated DOM mutations must NOT read scrollHeight on any tracked scroll box.
        trackedA.box.resetReads();
        trackedB.box.resetReads();
        createdMOs[0].cb([
          { type: "childList", target: unrelatedDiv, addedNodes: [unrelatedSpan], removedNodes: [] },
          { type: "childList", target: {}, addedNodes: [], removedNodes: [] },
        ]);
        check(
          "outside unrelated DOM mutations perform 0 scrollHeight reads on tracked scroll boxes",
          trackedA.box.getReads() === 0 && trackedB.box.getReads() === 0,
          `readsA=${trackedA.box.getReads()}, readsB=${trackedB.box.getReads()}`,
        );

        // Inside-box mutation only resyncs the single affected scroll box, leaving other boxes untouched.
        createdMOs[0].cb([
          { type: "childList", target: trackedA.child, addedNodes: [unrelatedSpan], removedNodes: [] },
        ]);
        check(
          "mutation inside box A only resyncs box A and leaves unrelated box B unread",
          trackedA.box.getReads() >= 1 && trackedB.box.getReads() === 0,
          `readsA=${trackedA.box.getReads()}, readsB=${trackedB.box.getReads()}`,
        );

        // 6c. Reloading a second row-entrance bundle instance on the same document disposes the old observer
        //     so only 1 active observer remains; disposeRowEntranceObservers() cleans up completely.
        mod1.ensureRowEntranceStyles(); // idempotent for same bundle
        const countAfterIdempotent = { mo: createdMOs.length, ro: createdROs.length };
        const mod2 = loadRowEntrance(rnStub, harness.hooks);
        mod2.ensureRowEntranceStyles();
        const activeMOsAfterReload = createdMOs.filter((o) => !o.disconnected);
        const activeROsAfterReload = createdROs.filter((o) => !o.disconnected);
        check(
          "cross-bundle reload on same document disconnects previous observers and keeps exactly 1 active pair",
          countAfterIdempotent.mo === 1 &&
            countAfterIdempotent.ro === 1 &&
            createdMOs[0].disconnected === true &&
            createdROs[0].disconnected === true &&
            activeMOsAfterReload.length === 1 &&
            activeROsAfterReload.length === 1,
          JSON.stringify({
            countAfterIdempotent,
            mo0Disconnected: createdMOs[0]?.disconnected,
            ro0Disconnected: createdROs[0]?.disconnected,
            activeMOs: activeMOsAfterReload.length,
            activeROs: activeROsAfterReload.length,
          }),
        );

        mod2.disposeRowEntranceObservers();
        const sym = Symbol.for("dsh.paseo.scrollOverflowObserver.v1");
        check(
          "disposeRowEntranceObservers disconnects active observers and clears document symbol handle",
          createdMOs.every((o) => o.disconnected) &&
            createdROs.every((o) => o.disconnected) &&
            sharedDoc[sym] === undefined,
          `remainingMOs=${createdMOs.filter((o) => !o.disconnected).length}, hasSym=${sharedDoc[sym] !== undefined}`,
        );

        // 6d. Multi-host coexistence via retainRowEntranceObservers():
        //     Host A & Host B coexist on the same document; Host A's render-time
        //     ensureRowEntranceStyles() shares the v2 observer without ping-pong;
        //     uninstalling Host B leaves Host A's existing & newly added scroll boxes
        //     observed; uninstalling Host A disconnects observers & strips markers.
        createdMOs.length = 0;
        createdROs.length = 0;
        const hostABox = makeTrackedBox(300, 120);
        const hostBMod = loadRowEntrance(rnStub, harness.hooks);
        const hostAMod = loadRowEntrance(rnStub, harness.hooks);
        const multiDocBoxes = [hostABox.box];
        const multiDoc = {
          head: { appendChild: () => {} },
          body: {},
          getElementById: () => staleStyle,
          createElement: () => ({ id: "", textContent: "" }),
          querySelectorAll: () => multiDocBoxes,
        };
        global.document = multiDoc;

        const releaseHostA = hostAMod.retainRowEntranceObservers();
        const releaseHostB = hostBMod.retainRowEntranceObservers();
        const moCountBeforeRenderCheck = createdMOs.length;
        // Render-time implicit calls from either host must share the v2 observer (zero ping-pong).
        hostAMod.ensureRowEntranceStyles();
        hostBMod.ensureRowEntranceStyles();
        check(
          "multi-host render-time ensureRowEntranceStyles shares active observer without recreating it",
          createdMOs.length === moCountBeforeRenderCheck &&
            createdMOs.filter((o) => !o.disconnected).length === 1 &&
            createdROs.filter((o) => !o.disconnected).length === 1 &&
            hostABox.box.getAttribute("data-dsh-overflow-y") === "true",
          JSON.stringify({
            totalMOs: createdMOs.length,
            before: moCountBeforeRenderCheck,
            activeMOs: createdMOs.filter((o) => !o.disconnected).length,
            activeROs: createdROs.filter((o) => !o.disconnected).length,
            attr: hostABox.box.getAttribute("data-dsh-overflow-y"),
          }),
        );

        // Uninstall Host B while Host A remains active.
        releaseHostB();
        const activeMOAfterB = createdMOs.filter((o) => !o.disconnected);
        const activeROAfterB = createdROs.filter((o) => !o.disconnected);
        // Shrink Host A's existing box -> ResizeObserver must still fire and remove marker.
        hostABox.box.scrollHeight = 80;
        activeROAfterB[0]?.cb([{ target: hostABox.box }]);
        // Mount a brand-new overflowing box in Host A -> MutationObserver must still mark it.
        const hostANewBox = makeTrackedBox(400, 100);
        activeMOAfterB[0]?.cb([
          { type: "childList", target: multiDoc.body, addedNodes: [hostANewBox.box], removedNodes: [] },
        ]);
        check(
          "uninstalling Host B keeps observer alive for Host A (both resize shrink and newly added overflow box)",
          activeMOAfterB.length === 1 &&
            activeROAfterB.length === 1 &&
            hostABox.box.getAttribute("data-dsh-overflow-y") === null &&
            hostANewBox.box.getAttribute("data-dsh-overflow-y") === "true",
          JSON.stringify({
            activeMOs: activeMOAfterB.length,
            activeROs: activeROAfterB.length,
            shrunkAttr: hostABox.box.getAttribute("data-dsh-overflow-y"),
            newBoxAttr: hostANewBox.box.getAttribute("data-dsh-overflow-y"),
          }),
        );

        // 6e. Subtree-local childList removals must NOT scan `isConnected` across unrelated tracked boxes.
        let trackedConnectedReads = 0;
        const makeConnectedProbeBox = (scrollH, clientH) => {
          const base = makeTrackedBox(scrollH, clientH);
          Object.defineProperty(base.box, "isConnected", {
            configurable: true,
            get() {
              trackedConnectedReads += 1;
              return true;
            },
          });
          return base;
        };
        const probeBox1 = makeConnectedProbeBox(280, 100);
        const probeBox2 = makeConnectedProbeBox(280, 100);
        activeMOAfterB[0].cb([
          { type: "childList", target: multiDoc.body, addedNodes: [probeBox1.box, probeBox2.box], removedNodes: [] },
        ]);
        trackedConnectedReads = 0;
        probeBox1.box.resetReads();
        probeBox2.box.resetReads();
        const removedTextNode = { nodeType: 3 };
        const removedUnrelatedEl = { nodeType: 1, querySelectorAll: () => [] };
        activeMOAfterB[0].cb([
          { type: "childList", target: unrelatedDiv, addedNodes: [], removedNodes: [removedTextNode, removedUnrelatedEl] },
        ]);
        check(
          "unrelated DOM text/element removals perform 0 isConnected checks and 0 scrollHeight reads on tracked boxes",
          trackedConnectedReads === 0 && probeBox1.box.getReads() === 0 && probeBox2.box.getReads() === 0,
          `connectedReads=${trackedConnectedReads}, reads1=${probeBox1.box.getReads()}, reads2=${probeBox2.box.getReads()}`,
        );

        // Removing a wrapper containing probeBox1 untracks probeBox1 via subtree querySelectorAll without touching probeBox2.
        const wrapperHoldingBox1 = { nodeType: 1, querySelectorAll: () => [probeBox1.box] };
        activeMOAfterB[0].cb([
          { type: "childList", target: multiDoc.body, addedNodes: [], removedNodes: [wrapperHoldingBox1] },
        ]);
        check(
          "removing a wrapper containing a tracked box untracks only that box without scanning unrelated boxes",
          trackedConnectedReads === 0 &&
            !activeROAfterB[0].observed.has(probeBox1.box) &&
            activeROAfterB[0].observed.has(probeBox2.box),
          `connectedReads=${trackedConnectedReads}, stillObserved1=${activeROAfterB[0].observed.has(probeBox1.box)}, stillObserved2=${activeROAfterB[0].observed.has(probeBox2.box)}`,
        );

        // Uninstalling the last host (Host A) disconnects observers, strips overflow markers, and clears symbol.
        releaseHostA();
        check(
          "uninstalling the last host disconnects observers, strips data-dsh-overflow-y, and clears symbol",
          createdMOs.every((o) => o.disconnected) &&
            createdROs.every((o) => o.disconnected) &&
            hostANewBox.box.getAttribute("data-dsh-overflow-y") === null &&
            multiDoc[sym] === undefined,
          JSON.stringify({
            remainingMOs: createdMOs.filter((o) => !o.disconnected).length,
            remainingROs: createdROs.filter((o) => !o.disconnected).length,
            newBoxAttr: hostANewBox.box.getAttribute("data-dsh-overflow-y"),
            hasSym: multiDoc[sym] !== undefined,
          }),
        );
      } finally {
        global.document = prevDoc;
        global.ResizeObserver = prevRO;
        global.MutationObserver = prevMO;
      }
    }

    // 7. Row cascade continuity, live parallel tool bursts, fast-tool smooth glide, and iOS rgba trail.
    console.log("row-cascade: handoff, parallel live burst stagger, fast-tool glide, and iOS rgba");
    {
      const {
        BLOOM_HANDOFF_MAX_DELAY_MS,
        ROW_CASCADE_MAX_DELAY_MS,
        ROW_CASCADE_STAGGER_MS,
        claimCascadeDelay,
        clearActiveBloom,
        markAgentLiveActivity,
        reportActiveBloom,
        resetRowCascadeForTests,
      } = require("./client/row-cascade.js");

      const cascadeAgent = "cascade-handoff-agent";
      resetRowCascadeForTests(cascadeAgent);
      let boosted = false;
      const t0 = 10_000;
      reportActiveBloom(cascadeAgent, 400, () => {
        boosted = true;
      }, t0);
      const d1 = claimCascadeDelay(cascadeAgent, "tool:1", t0);
      const d1Again = claimCascadeDelay(cascadeAgent, "tool:1", t0 + 2);
      const d2 = claimCascadeDelay(cascadeAgent, "tool:2", t0 + 2);
      const d3 = claimCascadeDelay(cascadeAgent, "tool:3", t0 + 2);
      const dHuge = claimCascadeDelay(cascadeAgent, "tool:8", t0 + 2);
      check(
        "arriving tool nudges upstream bloom and claims capped handoff delay",
        boosted === true && d1 > 0 && d1 <= BLOOM_HANDOFF_MAX_DELAY_MS,
        JSON.stringify({ boosted, d1, max: BLOOM_HANDOFF_MAX_DELAY_MS }),
      );
      check(
        "paired RowEntrance + useInkStreamReveal on same rowKey receive identical phase-locked delay",
        Math.abs(d1Again - (d1 - 2)) <= 1,
        JSON.stringify({ d1, d1Again }),
      );
      check(
        "parallel tool rows stagger sequentially and clamp to ROW_CASCADE_MAX_DELAY_MS",
        d2 >= d1 + ROW_CASCADE_STAGGER_MS - 5 &&
          d3 > d2 &&
          dHuge <= ROW_CASCADE_MAX_DELAY_MS,
        JSON.stringify({ d1, d2, d3, dHuge }),
      );
      // End-of-turn stats footer can pass a larger maxHandoffDelayMs so it waits
      // for a longer upstream reply bloom to finish instead of popping early.
      const footerAgent = "cascade-footer-agent";
      resetRowCascadeForTests(footerAgent);
      reportActiveBloom(footerAgent, 1200, undefined, t0);
      const footerDelay = claimCascadeDelay(footerAgent, "stream-stats:1", t0, 900);
      check(
        "footer row with larger maxHandoffDelayMs waits past default tool cap for upstream reply bloom",
        footerDelay > BLOOM_HANDOFF_MAX_DELAY_MS && footerDelay <= 900,
        JSON.stringify({ footerDelay }),
      );
      clearActiveBloom(footerAgent);
      resetRowCascadeForTests(footerAgent);
      clearActiveBloom(cascadeAgent);
      resetRowCascadeForTests(cascadeAgent);

      // Live parallel burst of 3 running tools on an active session all animate with stagger,
      // while a mixed/completed history batch still stays 0 animations.
      const prevDoc = global.document;
      const prevWin = global.window;
      global.document = {
        getElementById: () => null,
        createElement: (tag) => ({ tag, id: "", textContent: "" }),
        head: { appendChild: () => {} },
      };
      global.window = {};
      const burstHarness = createMiniReactHarness({ includeLayoutEffect: true });
      const burstAgent = "live-parallel-burst-3";
      resetNewestForTests(burstAgent);
      try {
        markAgentLiveActivity(burstAgent, Date.now());
        const mod = loadRowEntrance(
          { Platform: { OS: "web" }, View: "View", Text: "Text" },
          burstHarness.hooks,
        );
        const { RowEntrance, ROW_ENTER_TEST_ID, useInkStreamReveal, renderInkTrailText } = mod;

        const parallelRows = [0, 1, 2].map((i) => ({
          key: `live-tool-${i}`,
          ts: base + 500,
          label: "读取文件",
          summary: `file-${i}.ts`,
        }));
        function ParallelRow({ row }) {
          const s = useInkStreamReveal({
            agentId: burstAgent,
            timestamp: row.ts,
            rowKey: row.key,
            liveHint: true,
            label: row.label,
            summary: row.summary,
            snapOnSettle: false,
            snapNow: false,
            trailWidth: 9,
          });
          return {
            type: RowEntrance,
            props: {
              agentId: burstAgent,
              timestamp: row.ts,
              rowKey: row.key,
              liveHint: true,
              children: { type: "RowOut", props: { active: s.active, key: row.key } },
            },
          };
        }
        function ParallelList() {
          return {
            type: "List",
            props: {
              children: parallelRows.map((row) => ({
                type: ParallelRow,
                key: row.key,
                props: { row },
              })),
            },
          };
        }
        const burstTree = burstHarness.render(ParallelList, {});
        const burstEnters = findAllNodes(burstTree, (n) => n.props?.testID === ROW_ENTER_TEST_ID);
        const burstOuts = findAllNodes(burstTree, (n) => n.type === "RowOut");
        check(
          "live parallel burst of 3 running tools on active agent animates all 3 with staggered delays",
          burstEnters.length === 3 &&
            burstOuts.length === 3 &&
            burstOuts.every((o) => o.props.active === true) &&
            burstEnters[1].props.style?.animationDelay !== undefined &&
            burstEnters[2].props.style?.animationDelay !== burstEnters[1].props.style?.animationDelay,
          JSON.stringify({
            enters: burstEnters.map((e) => e.props.style),
            actives: burstOuts.map((o) => o.props.active),
          }),
        );

        // renderInkTrailText uses true rgba(...) color on nested <Text> when baseColor is supplied.
        const rgbaNodes = renderInkTrailText("读取文件", 2.5, "#ffffff", null, 0, "#94a3b8", 9);
        const tintedSpans = Array.isArray(rgbaNodes)
          ? rgbaNodes.filter((n) => typeof n === "object" && n !== null && typeof n.props?.style?.color === "string")
          : [];
        check(
          "renderInkTrailText emits true rgba(...) colors instead of iOS-ignored opacity-only spans",
          tintedSpans.length >= 2 &&
            tintedSpans.every((n) => /^rgba\(\d+, \d+, \d+, [0-9.]+\)$/.test(n.props.style.color)) &&
            tintedSpans.every((n) => n.props.style.opacity === undefined),
          JSON.stringify(tintedSpans.map((n) => n.props.style)),
        );

        // Fast tool completion with snapOnSettle=false keeps blooming smoothly; snapNow=true snaps immediately.
        const fastAgent = "fast-tool-glide";
        resetNewestForTests(fastAgent);
        await pass(fastAgent, [base]);
        let fastState = null;
        function FastToolProbe({ liveHint, snapNow }) {
          fastState = useInkStreamReveal({
            agentId: fastAgent,
            timestamp: base + 100,
            rowKey: "fast-1",
            liveHint,
            label: "读取文件",
            summary: "index.ts",
            snapOnSettle: false,
            snapNow,
            trailWidth: 9,
          });
          return { type: "FastOut", props: fastState };
        }
        burstHarness.render(FastToolProbe, { liveHint: true, snapNow: false });
        const activeWhileRunning = fastState.active;
        burstHarness.render(FastToolProbe, { liveHint: false, snapNow: false });
        const stillGlidingAfterFastComplete = fastState.active;
        burstHarness.render(FastToolProbe, { liveHint: false, snapNow: true });
        const snappedOnFailure = fastState.active === false && fastState.labelProgress === Number.POSITIVE_INFINITY;
        check(
          "fast tool completion (snapOnSettle=false) glides smoothly while snapNow=true snaps immediately on error",
          activeWhileRunning === true && stillGlidingAfterFastComplete === true && snappedOnFailure === true,
          JSON.stringify({ activeWhileRunning, stillGlidingAfterFastComplete, snappedOnFailure }),
        );
        burstHarness.unmountAll();
        resetNewestForTests(fastAgent);

        // Hook-level exclusive pulse ownership: thinking row yields when a tool
        // commits below it, an older slow tool updating its timestamp never
        // steals shimmer back from the bottom row, and unmount releases all listeners.
        const pulseHarness = createMiniReactHarness({ includeLayoutEffect: true });
        const pulseAgent = "hook-pulse-handover";
        const originalLoadPulse = Module._load;
        for (const key of Object.keys(require.cache)) {
          if (key.endsWith("newest.js")) delete require.cache[key];
        }
        let newestMod;
        Module._load = function load(request, parent, isMain) {
          if (request === "react") return pulseHarness.hooks;
          return originalLoadPulse.call(this, request, parent, isMain);
        };
        try {
          newestMod = require(join(__dirname, "client", "newest.js"));
        } finally {
          Module._load = originalLoadPulse;
        }
        newestMod.resetNewestForTests(pulseAgent);
        // Settle an initial pass so subsequent rows are live.
        newestMod.noteRender(pulseAgent, base);
        await settle();

        let thinkingOwns = false;
        let tool1Pulse = null;
        let tool2Pulse = null;
        function PulseScene({ showTool1, tool1Ts, showTool2, tool2Ts, thinkingActive }) {
          thinkingOwns = newestMod.useIsPulseOwner(pulseAgent, thinkingActive);
          return {
            type: "Scene",
            props: {
              children: [
                showTool1
                  ? {
                      type: function Tool1Probe({ ts }) {
                        tool1Pulse = newestMod.useRowPulse(pulseAgent, ts, "tool:slow-1");
                        return { type: "T1", props: tool1Pulse };
                      },
                      key: "t1",
                      props: { ts: tool1Ts },
                    }
                  : null,
                showTool2
                  ? {
                      type: function Tool2Probe({ ts }) {
                        tool2Pulse = newestMod.useRowPulse(pulseAgent, ts, "tool:newest-2");
                        return { type: "T2", props: tool2Pulse };
                      },
                      key: "t2",
                      props: { ts: tool2Ts },
                    }
                  : null,
              ],
            },
          };
        }

        // Step 1: Thinking row is active -> owns pulse.
        pulseHarness.render(PulseScene, {
          thinkingActive: true,
          showTool1: false,
          tool1Ts: base + 100,
          showTool2: false,
          tool2Ts: base + 200,
        });
        const thinkingInitiallyOwned = thinkingOwns;

        // Step 2: Tool 1 mounts below thinking row -> thinking yields, Tool 1 owns.
        pulseHarness.render(PulseScene, {
          thinkingActive: true,
          showTool1: true,
          tool1Ts: base + 100,
          showTool2: false,
          tool2Ts: base + 200,
        });
        await settle();
        const thinkingYieldedToTool1 = thinkingOwns === false;
        const tool1OwnedBeforeTool2 = tool1Pulse?.newest === true && tool1Pulse?.fresh === true;

        // Step 3: Tool 2 mounts below Tool 1 -> Tool 1 yields immediately, Tool 2 owns.
        pulseHarness.render(PulseScene, {
          thinkingActive: true,
          showTool1: true,
          tool1Ts: base + 100,
          showTool2: true,
          tool2Ts: base + 200,
        });
        await settle();
        const tool1YieldedToTool2 = tool1Pulse?.newest === false && tool1Pulse?.fresh === false;
        const tool2Owned = tool2Pulse?.newest === true && tool2Pulse?.fresh === true;

        // Step 4: Older slow Tool 1 finishes and Paseo jumps its timestamp to base + 900.
        // Frozen birthRef must keep Tool 1 superseded and Tool 2 as the exclusive newest row.
        pulseHarness.render(PulseScene, {
          thinkingActive: false,
          showTool1: true,
          tool1Ts: base + 900,
          showTool2: true,
          tool2Ts: base + 200,
        });
        await settle();
        const slowFinishDidNotSteal =
          tool1Pulse?.newest === false &&
          tool1Pulse?.fresh === false &&
          tool2Pulse?.newest === true &&
          tool2Pulse?.fresh === true;

        // Step 4b: Virtual-list scroll-back remounts a single older historical row
        // (`ts = base + 500`) alone while the live bottom row (`ts = base + 2000`)
        // is pulsing. The older row must stay silent (`shouldPulse === false`) and
        // must NOT steal `seq` or interrupt the live row's pulse.
        const scrollAgent = "hook-scroll-remount-no-steal";
        let liveRowPulse = null;
        let histRowPulse = null;
        const scrollHarness = createMiniReactHarness({ includeLayoutEffect: true });
        for (const key of Object.keys(require.cache)) {
          if (key.endsWith("newest.js")) delete require.cache[key];
        }
        let scrollNewestMod;
        Module._load = function load(request, parent, isMain) {
          if (request === "react") return scrollHarness.hooks;
          return originalLoadPulse.call(this, request, parent, isMain);
        };
        try {
          scrollNewestMod = require(join(__dirname, "client", "newest.js"));
        } finally {
          Module._load = originalLoadPulse;
        }
        scrollNewestMod.resetNewestForTests(scrollAgent);
        scrollNewestMod.noteRender(scrollAgent, base);
        await settle();
        function ScrollTestScene({ mountOld }) {
          return {
            type: "Root",
            props: {
              children: [
                mountOld
                  ? {
                      type: function HistRow() {
                        histRowPulse = scrollNewestMod.useRowPulse(scrollAgent, base + 500, "tool:hist-500");
                        return { type: "Hist", props: histRowPulse };
                      },
                      key: "hist",
                      props: {},
                    }
                  : null,
                {
                  type: function LiveRow() {
                    liveRowPulse = scrollNewestMod.useRowPulse(scrollAgent, base + 2000, "tool:live-2000");
                    return { type: "Live", props: liveRowPulse };
                  },
                  key: "live",
                  props: {},
                },
              ],
            },
          };
        }
        scrollHarness.render(ScrollTestScene, { mountOld: false });
        await settle();
        const livePulsingBeforeScroll =
          liveRowPulse !== null && scrollNewestMod.shouldPulse("running", liveRowPulse);
        scrollHarness.render(ScrollTestScene, { mountOld: true });
        await settle();
        const oldRowSilentOnRemount =
          histRowPulse !== null &&
          histRowPulse.newest === false &&
          histRowPulse.fresh === false &&
          scrollNewestMod.shouldPulse("completed", histRowPulse) === false;
        const liveStillPulsingAfterOldRemount =
          liveRowPulse !== null &&
          liveRowPulse.newest === true &&
          liveRowPulse.fresh === true &&
          scrollNewestMod.shouldPulse("running", liveRowPulse) === true;
        scrollHarness.unmountAll();
        scrollNewestMod.resetNewestForTests(scrollAgent);
        check(
          "scroll-back single old historical row remount stays silent and never steals pulse from live newest row",
          livePulsingBeforeScroll === true &&
            oldRowSilentOnRemount === true &&
            liveStillPulsingAfterOldRemount === true,
          JSON.stringify({
            livePulsingBeforeScroll,
            oldRowSilentOnRemount,
            liveStillPulsingAfterOldRemount,
            histRowPulse,
            liveRowPulse,
          }),
        );

        // Step 5: Unmount releases every handover listener cleanly.
        const listenersBeforeUnmount = newestMod.pulseListenerCountForTests(pulseAgent);
        pulseHarness.unmountAll();
        const listenersAfterUnmount = newestMod.pulseListenerCountForTests(pulseAgent);
        newestMod.resetNewestForTests(pulseAgent);

        check(
          "hook handover: thinking yields to tool 1, tool 1 yields to tool 2, slow finish never steals pulse, unmount leaks 0 listeners",
          thinkingInitiallyOwned === true &&
            thinkingYieldedToTool1 === true &&
            tool1OwnedBeforeTool2 === true &&
            tool1YieldedToTool2 === true &&
            tool2Owned === true &&
            slowFinishDidNotSteal === true &&
            listenersBeforeUnmount >= 1 &&
            listenersAfterUnmount === 0,
          JSON.stringify({
            thinkingInitiallyOwned,
            thinkingYieldedToTool1,
            tool1OwnedBeforeTool2,
            tool1YieldedToTool2,
            tool2Owned,
            slowFinishDidNotSteal,
            listenersBeforeUnmount,
            listenersAfterUnmount,
          }),
        );
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        resetNewestForTests(burstAgent);
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
