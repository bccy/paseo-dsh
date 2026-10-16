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
  noteCommit,
  noteRender,
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
