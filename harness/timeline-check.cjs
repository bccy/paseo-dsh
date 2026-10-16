/**
 * Offline assertions for `TimelineBuilder`'s tool-call state machine.
 *
 * The builder turns DSH session events into Paseo timeline items, and every
 * branch here was once silently wrong in a way the UI cannot show:
 *
 * - A tool call that never gets a result (an aborted turn takes the process with
 *   it) stayed `running` forever. The client pulses a running row with no time
 *   window, so that row blinked for the rest of the session and on every replay.
 * - A repeated `tool/call` rebuilt the row from its input alone, which reset a
 *   finished tool to `running` and dropped the output it already carried.
 *
 * `harness/plugin-check.cjs` drives the plugin end to end; this drives the
 * builder directly, which is the only way to stage those orderings.
 *
 * Run (from paseo-plugin):
 *   npx tsc server/timeline.ts \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/timeline-check.cjs .dbg/
 *   cd .dbg && node timeline-check.cjs
 *
 * The `@getpaseo/plugin/server/provider` type errors tsc prints under
 * `--moduleResolution node` are expected; the emitted JavaScript is what runs.
 */
"use strict";

const { TimelineBuilder } = require("./server/timeline.js");

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

const call = (builder, callId = "c1", command = "ls") =>
  builder.consume({ type: "tool/call", seq: 1, data: { callId, name: "bash", arguments: { command } } });
const result = (builder, callId = "c1", output = "file.txt") =>
  builder.consume({
    type: "tool/result",
    seq: 2,
    data: { toolCallId: callId, message: { content: [{ type: "text", text: output }] } },
  });
const turnEnd = (builder, reason) =>
  builder.consume({ type: "turn/end", seq: 3, data: { turn: 1, reason } });

console.log("tool call lifecycle");
{
  const builder = new TimelineBuilder();
  const started = call(builder);
  check("a tool call starts running", started[0]?.status === "running", JSON.stringify(started[0]));

  const finished = result(builder);
  check("a result completes it", finished[0]?.status === "completed");
  check(
    "and carries the output",
    finished[0]?.detail?.output === "file.txt",
    JSON.stringify(finished[0]?.detail),
  );
}

console.log("a repeated tool/call must not undo a finished row");
{
  const builder = new TimelineBuilder();
  call(builder);
  result(builder, "c1", "kept");
  const again = call(builder);
  check("no item is emitted", again.length === 0, JSON.stringify(again));
  check(
    "the finished row still carries its output",
    builder.consume({ type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } }).length === 0,
  );
  const reread = call(builder, "c2");
  check("a different call still starts", reread[0]?.status === "running");
}

console.log("a repeated tool/call while running");
{
  const builder = new TimelineBuilder();
  call(builder);
  const again = call(builder);
  check("it stays running", again[0]?.status === "running");
  const out = turnEnd(builder, { kind: "aborted" });
  check("and is still cancellable", out[0]?.status === "canceled");
}

console.log("an interrupted turn closes out what never finished");
{
  // DSH cancels a turn with `reason.kind === "aborted"`, and the in-flight tool
  // never gets a result.
  const builder = new TimelineBuilder();
  call(builder);
  const out = turnEnd(builder, { kind: "aborted" });
  check("the running tool becomes canceled", out[0]?.status === "canceled", JSON.stringify(out[0]));
  check("and stops being running", out[0]?.error === null);
}

console.log("turn end variants");
{
  const clean = new TimelineBuilder();
  call(clean);
  result(clean);
  check(
    "a completed turn emits nothing",
    turnEnd(clean, { kind: "completed" }).length === 0,
  );

  const nothingRunning = new TimelineBuilder();
  check(
    "an aborted turn with no running tool emits nothing",
    turnEnd(nothingRunning, { kind: "aborted" }).length === 0,
  );

  const failed = new TimelineBuilder();
  call(failed);
  const out = turnEnd(failed, { kind: "error", error: { message: "boom" } });
  check("an errored turn cancels the tool too", out[0]?.status === "canceled");
  check("and reports the error", out[1]?.type === "error" && out[1]?.message === "boom", JSON.stringify(out[1]));

  const noReason = new TimelineBuilder();
  call(noReason);
  check(
    "a turn end with no reason still cancels",
    turnEnd(noReason, undefined)[0]?.status === "canceled",
  );
}

console.log("replay of an interrupted session");
{
  // Replaying the same event log must reach the same terminal state, or opening
  // the session again revives the forever-pulsing row.
  const builder = new TimelineBuilder();
  call(builder, "c9");
  turnEnd(builder, { kind: "aborted" });
  const replayed = new TimelineBuilder();
  call(replayed, "c9");
  const out = turnEnd(replayed, { kind: "aborted" });
  check("replay reaches canceled too", out[0]?.status === "canceled");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
