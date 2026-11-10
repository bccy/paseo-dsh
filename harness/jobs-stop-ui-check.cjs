/**
 * Offline check for the jobs popover's **stop button** (design 2026-11-11).
 *
 * `jobs-pill.tsx` imports the host runtime, so plain `node` cannot load it. The
 * button's *behaviour* therefore lives in `client/jobs-polling.ts` as pure
 * functions (`jobStop*`), and this file drives the real implementations with
 * plain objects and the **real locale tables**; the JSX wiring (only `canStop`
 * rows get a button, the button is disabled while pending, the note tone, the
 * 5-second timer, the a11y name, the geometry) is pinned by reading the source.
 *
 * What it proves, in the design's own words:
 *
 *   1. **`canStop` only.** A row the runtime will not stop gets no control, and a
 *      second press on a pending row is a no-op.
 *   2. **Pending disables.** One row's request is in flight while another row can
 *      start its own — the state is per job id, not per popover.
 *   3. **Refusals are loud but graded.** `job_finished` / `job_not_stoppable` /
 *      `job_not_found` / `session_missing` are neutral tips, never errors; a
 *      bridge/transport/producer failure keeps the runtime's own sentence and the
 *      destructive tone.
 *   4. **Success is the content of nothing.** `ok: true` leaves the row pending:
 *      the client never fabricates a stopped row, and the push decides.
 *   5. **The 5-second promise.** While the job still reports stoppable the button
 *      comes back with "requested, still running"; once a push has moved it on,
 *      the timeout changes nothing.
 *
 * Run (from paseo-plugin):
 *   npx tsc -p ../harness/jobs-stop-ui.tsconfig.json
 *   echo '{"type":"commonjs"}' > .dbg-stop-ui/package.json
 *   cp ../harness/jobs-stop-ui-check.cjs .dbg-stop-ui/
 *   cd .dbg-stop-ui && node jobs-stop-ui-check.cjs
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  JOB_STOP_BOX,
  JOB_STOP_GLYPH,
  JOB_STOP_HIT_SLOP,
  JOB_STOP_RADIUS,
  JOB_STOP_TIMEOUT_MS,
  jobRowTitle,
  jobStopA11yLabel,
  jobStopAnswer,
  jobStopDroppedIds,
  jobStopNoteOf,
  jobStopPendingOf,
  jobStopPushed,
  jobStopRefusalNote,
  jobStopStart,
  jobStopTimedOut,
  jobStoppable,
} = require("./client/jobs-polling.js");
const { allText } = require("./client/locale.js");
const { jobsStop, JOB_STOP_ERROR_CODES } = require("./shared/jobs.js");

const ZH = allText()["zh-CN"].jobs;
const EN = allText().en.jobs;

let failures = 0;
let checks = 0;
function check(what, actual, expected) {
  checks += 1;
  if (Object.is(actual, expected)) return;
  failures += 1;
  console.error(`  FAIL ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function equal(what, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures += 1;
  console.error(`  FAIL ${what}: expected ${e}, got ${a}`);
}
function assert(what, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${what}${detail === undefined ? "" : `: ${detail}`}`);
}

/** One job row as the wire schema carries it (only the fields this check reads). */
const job = (id, status, extra = {}) => ({
  id,
  kind: "bash",
  label: `sleep 600 #${id}`,
  status,
  canStop: status === "running",
  startedAt: 1,
  ...extra,
});

/* The design's numbers ------------------------------------------------------- */
console.log("the design's geometry");
{
  check("the button box is 28×28", JOB_STOP_BOX, 28);
  check("the radius matches the popover's small buttons", JOB_STOP_RADIUS, 6);
  check("the glyph is the row mark's size", JOB_STOP_GLYPH, 14);
  check("hitSlop per side is 8", JOB_STOP_HIT_SLOP, 8);
  assert(
    "the effective touch target is at least 44×44",
    JOB_STOP_BOX + JOB_STOP_HIT_SLOP * 2 >= 44,
    String(JOB_STOP_BOX + JOB_STOP_HIT_SLOP * 2),
  );
  check("the still-running note appears after 5 s", JOB_STOP_TIMEOUT_MS, 5000);
}

/* 1. canStop gates the control ---------------------------------------------- */
console.log("\ncanStop only");
{
  check("a running job can be stopped", jobStoppable(job("a", "running")), true);
  check("a stopping job cannot (cancellation is in flight)", jobStoppable(job("a", "stopping")), false);
  check("a completed job cannot", jobStoppable(job("a", "completed")), false);
  check("a killed job cannot", jobStoppable(job("a", "killed")), false);
  check("a failed job cannot", jobStoppable(job("a", "failed")), false);
  check("a missing canStop is not stoppable", jobStoppable({ id: "a", canStop: undefined }), false);

  const states = jobStopStart({}, job("a", "stopping"));
  equal("pressing a row that cannot stop changes nothing", states, {});
  const running = jobStopStart({}, job("a", "running"));
  check("pressing a running row starts pending on that row", jobStopPendingOf(running, "a"), true);
  const again = jobStopStart(running, job("a", "running"));
  assert("a second press while pending is the same state (no repeat request)", again === running);
  check("…so it is still pending, not restarted", jobStopPendingOf(again, "a"), true);
}

/* 2. two rows in parallel --------------------------------------------------- */
console.log("\ntwo rows can be stopped independently");
{
  let states = jobStopStart({}, job("a", "running"));
  states = jobStopStart(states, job("b", "running"));
  equal("both rows are pending at once", [jobStopPendingOf(states, "a"), jobStopPendingOf(states, "b")], [true, true]);
  states = jobStopAnswer(states, "a", { ok: false, error: { message: "boom", code: "rpc_failed" } }, ZH);
  equal("answering one row clears only its pending", [jobStopPendingOf(states, "a"), jobStopPendingOf(states, "b")], [false, true]);
  equal("…and the other row's note stays empty", jobStopNoteOf(states, "b"), undefined);
  states = jobStopTimedOut(states, job("b", "running"), ZH);
  check("timing out the second row does not touch the first", jobStopPendingOf(states, "a"), false);
  equal("…and the first row keeps its error note", jobStopNoteOf(states, "a")?.tone, "error");
}

/* 3. graded refusals -------------------------------------------------------- */
console.log("\nrefusals: neutral tips vs errors");
{
  const neutral = (code) => {
    const states = jobStopAnswer(jobStopStart({}, job("a", "running")), "a", { ok: false, error: { message: `runtime says ${code}`, code } }, ZH);
    return jobStopNoteOf(states, "a");
  };
  equal(
    "a job that already finished is a neutral tip",
    neutral("job_finished"),
    { kind: "refusal", tone: "neutral", message: ZH.stopAlreadyFinished },
  );
  equal(
    "a job already stopping is a neutral tip",
    neutral("job_not_stoppable"),
    { kind: "refusal", tone: "neutral", message: ZH.stopAlreadyStopping },
  );
  equal(
    "a job no longer in the list is a neutral tip",
    neutral("job_not_found"),
    { kind: "refusal", tone: "neutral", message: ZH.stopGone },
  );
  equal(
    "an unopened session is a neutral tip too",
    neutral("session_missing"),
    { kind: "refusal", tone: "neutral", message: ZH.stopGone },
  );
  for (const code of ["bridge_too_old", "registry_missing", "rpc_failed", "cancel_failed"]) {
    const note = neutral(code);
    equal(`a ${code} failure keeps the runtime's sentence`, note?.message, `runtime says ${code}`);
    equal(`…and is an error, not a tip (${code})`, note?.tone, "error");
  }
  equal(
    "an error with no code (a thrown request) is still an error with its message",
    jobStopRefusalNote({ message: "Stream end encountered" }, ZH),
    { kind: "refusal", tone: "error", message: "Stream end encountered" },
  );
  equal("no error object means no note", jobStopRefusalNote(undefined, ZH), undefined);
  equal(
    "every code the contract defines is graded (no unknown code reaches the note)",
    JOB_STOP_ERROR_CODES.filter((code) => jobStopRefusalNote({ message: "x", code }, ZH) === undefined),
    [],
  );
  equal(
    "the neutral tips are exactly the four answers that are not failures",
    JOB_STOP_ERROR_CODES.filter((code) => jobStopRefusalNote({ message: "x", code }, ZH)?.tone === "neutral"),
    ["session_missing", "job_not_found", "job_finished", "job_not_stoppable"],
  );
}

/* 4. success is not fabricated --------------------------------------------- */
console.log("\na successful request is not a stopped row");
{
  const pending = jobStopStart({}, job("a", "running"));
  const answered = jobStopAnswer(pending, "a", { ok: true, outcome: "requested" }, ZH);
  assert("an ok answer returns the same state (nothing to repaint)", answered === pending);
  check("…the row is still pending, waiting for the push", jobStopPendingOf(answered, "a"), true);
  equal("…and carries no note", jobStopNoteOf(answered, "a"), undefined);
}

/* 5. pushes and the 5-second promise ---------------------------------------- */
console.log("\npushes move the rows, the timer reports the stall");
{
  // The push that lands the job in `stopping`: `canStop` false → the state is
  // dropped, and the (now unnecessary) button/timer state goes with it.
  const pending = jobStopStart({}, job("a", "running"));
  equal(
    "a push that stops the job drops its state",
    jobStopPushed(pending, [job("a", "stopping")]),
    {},
  );
  // Same for a settled row.
  equal(
    "a push that settles the job drops its state",
    jobStopPushed(pending, [job("a", "killed", { canStop: false })]),
    {},
  );
  // A refusal note clears on the next push (design), while pending survives.
  const refused = jobStopAnswer(pending, "a", { ok: false, error: { message: "boom", code: "rpc_failed" } }, ZH);
  const afterPush = jobStopPushed(refused, [job("a", "running")]);
  equal("a push clears a refusal note", jobStopNoteOf(afterPush, "a"), undefined);
  const stillPending = jobStopPushed(pending, [job("a", "running")]);
  check("a push that still reports running keeps the pending flag", jobStopPendingOf(stillPending, "a"), true);

  // The 5 s timer, while the job still runs: the button returns with the note.
  const timedOut = jobStopTimedOut(pending, job("a", "running"), ZH);
  check("the timeout restores the button", jobStopPendingOf(timedOut, "a"), false);
  equal(
    "…with the “requested, still running” note",
    jobStopNoteOf(timedOut, "a"),
    { kind: "timeout", tone: "neutral", message: ZH.stopSentStillRunning },
  );
  // A timeout note survives a push that still reports running…
  equal(
    "…a push that still reports running keeps the timeout note",
    jobStopNoteOf(jobStopPushed(timedOut, [job("a", "running")]), "a")?.kind,
    "timeout",
  );
  // …and disappears when the row leaves the stoppable set.
  equal(
    "…and the push that stops the job drops it",
    jobStopPushed(timedOut, [job("a", "stopping")]),
    {},
  );
  // A pending row whose job the push already moved on: the timeout is a no-op.
  equal(
    "a timeout after the push already moved the job on changes nothing",
    jobStopTimedOut(pending, job("a", "stopping"), ZH),
    {},
  );
  // A timeout for a row that already answered (not pending) is a no-op.
  {
    const idle = {};
    assert("a timeout with nothing pending is literally the same state", jobStopTimedOut(idle, job("a", "running"), ZH) === idle);
  }
  // A click clears an old note.
  const noted = jobStopTimedOut(pending, job("a", "running"), ZH);
  equal("a new click clears the old note", jobStopNoteOf(jobStopStart(noted, job("a", "running")), "a"), undefined);
}

/* 5b. a dropped row must not keep its timer --------------------------------- */
console.log("\na dropped row's timer is cancellable");
{
  const pending = jobStopStart(jobStopStart({}, job("a", "running")), job("b", "running"));
  const after = jobStopPushed(pending, [job("a", "stopping"), job("b", "running")]);
  equal("the push reports exactly the rows it dropped", jobStopDroppedIds(pending, after), ["a"]);
  equal("…an unchanged row is not reported", jobStopDroppedIds(after, after), []);
  equal(
    "…a row the push keeps is not reported either",
    jobStopDroppedIds(jobStopPushed(after, [job("b", "running")]), jobStopPushed(after, [job("b", "running")])),
    [],
  );
  const added = jobStopStart(after, job("c", "running"));
  equal("…and rows the push did not remove are never reported", jobStopDroppedIds(after, added), []);
}

/* 6. the a11y name ---------------------------------------------------------- */
console.log("\nthe stop button's accessibility name");
{
  const row = job("a", "running", { description: "运行完整测试套件" });
  check("the row's title is the model's description", jobRowTitle(row), "运行完整测试套件");
  check("…falling back to the command", jobRowTitle(job("a", "running", { description: "" })), "sleep 600 #a");
  equal("the Chinese name quotes the title", jobStopA11yLabel(ZH, "运行完整测试套件"), "停止「运行完整测试套件」");
  equal("the English name quotes the title", jobStopA11yLabel(EN, "Run the suite"), 'Stop "Run the suite"');
  // `String.replace`'s `$` patterns must not be interpreted: a shell command
  // easily contains `$&` or `$1`.
  const command = "awk '{print $1, $&}'";
  equal("a `$` in the title reaches the label verbatim", jobStopA11yLabel(ZH, command), `停止「${command}」`);
}

/* 7. the contract ----------------------------------------------------------- */
console.log("\nthe jobs.stop contract");
{
  check("the RPC is jobs.stop", jobsStop.name, "jobs.stop");
  const ok = jobsStop.output.safeParse({
    ok: true,
    outcome: "requested",
    job: job("a", "stopping"),
  });
  check("a successful answer parses", ok.success, true);
  const refused = jobsStop.output.safeParse({
    ok: false,
    error: { message: "already finished", code: "job_finished" },
    job: job("a", "completed", { canStop: false }),
  });
  check("a coded refusal with its projection parses", refused.success, true);
  check(
    "an unknown code is rejected (both halves share the list)",
    jobsStop.output.safeParse({ ok: false, error: { message: "x", code: "not_a_code" } }).success,
    false,
  );
  check("an empty jobId is rejected", jobsStop.input.safeParse({ agentId: "a", jobId: "" }).success, false);
  check("an empty agentId is rejected", jobsStop.input.safeParse({ agentId: "", jobId: "j" }).success, false);
}

/* 8. the JSX wiring (source pins) ------------------------------------------- */
console.log("\nthe popover's wiring (source pins)");
{
  const repo = path.resolve(__dirname, "..", "..");
  const pill = fs.readFileSync(path.join(repo, "paseo-plugin/client/jobs-pill.tsx"), "utf8");

  // The popover needs the client to issue the RPC, and the contribution passes it.
  assert("the popover receives the plugin client", /function makeJobsPopover\(client: PluginClientContext/.test(pill));
  assert("…and the contribution passes it", /makeJobsPopover\(client, store, agent\.id\)/.test(pill));
  assert("the stop RPC is the shared contract", /client\s*\.\s*rpc\(jobsStop, \{ agentId, jobId: job\.id \}\)/.test(pill));
  // Only a canStop row gets the control; a non-stoppable row passes undefined.
  assert(
    "the button is mounted only for a stoppable row",
    /stop=\{\s*jobStoppable\(job\)\s*\?\s*\{ pending: jobStopPendingOf\(stops, job\.id\), onPress: \(\) => stopJob\(job\) \}\s*:\s*undefined\s*\}/.test(
      pill,
    ),
  );
  // The popover asks the pure rules instead of re-deciding.
  assert("pending comes from the machine", /jobStopPendingOf\(stops, job\.id\)/.test(pill));
  assert("the note comes from the machine", /jobStopNoteOf\(stops, job\.id\)/.test(pill));
  assert("a push advances the rows", /const after = jobStopPushed\(before, next\.jobs\)/.test(pill));
  // Review P3-5: a dropped row's 5 s timer is cancelled, before the new state is
  // applied, so a late timeout cannot re-enter a row the push settled.
  assert(
    "a push cancels the dropped rows' timers",
    /for \(const jobId of jobStopDroppedIds\(before, after\)\) clearStopTimer\(jobId\)/.test(pill),
  );
  assert(
    "…before the new state is applied",
    pill.indexOf("jobStopDroppedIds(before, after)") >= 0
      && pill.indexOf("jobStopDroppedIds(before, after)") < pill.indexOf("applyStops(after)"),
  );
  assert("the click starts the request", /jobStopStart\(stopsRef\.current, job\)/.test(pill));
  assert("the answer is graded by the machine", /jobStopAnswer\(stopsRef\.current, job\.id, result, text\)/.test(pill));
  assert("the timer uses the design's 5 s", /JOB_STOP_TIMEOUT_MS/.test(pill) && /setTimeout\(/.test(pill));
  assert("the timeout is graded by the machine", /jobStopTimedOut\(stopsRef\.current, row \?\?/.test(pill));
  // The button itself.
  assert("the glyph is the stop square at the design's size", /<Icon\s+name="Square"\s+size=\{JOB_STOP_GLYPH\}/.test(pill));
  assert("pending shows the small ActivityIndicator", /<ActivityIndicator size="small"/.test(pill));
  assert("pending disables the button", /disabled=\{pending\}/.test(pill));
  assert("the a11y role is a button", /accessibilityRole="button"/.test(pill));
  assert("the a11y name carries the row's title", /accessibilityLabel=\{jobStopA11yLabel\(text, jobRowTitle\(job\)\)\}/.test(pill));
  assert("the box and hitSlop come from the constants", /width: JOB_STOP_BOX/.test(pill) && /top: JOB_STOP_HIT_SLOP/.test(pill));
  assert("the hover fill is the popover's existing one", /rowActiveFill\(hot, pressed\)/.test(pill));
  assert("the hover tint is the theme's danger token", /theme\.colors\.statusDanger/.test(pill));
  // The note under the row.
  assert("the note uses the NoteLine", /<NoteLine[^>]*tone=\{note\.tone\}/.test(pill));
  assert("a runtime error note is truncated to one line", /numberOfLines=\{1\}/.test(pill));
  // Nothing fabricated: the stop path never writes a job's status into the store.
  const stopSection = pill.slice(pill.indexOf("const stopJob = (job: Job)"), pill.indexOf("const unavailableNote"));
  assert("the stop path never publishes a row", !/publish\(/.test(stopSection));
  assert("the stop path never invents a status", !/status:\s*"(stopping|killed|completed|failed)"/.test(stopSection));
  assert("the module never hard-codes a literal stop colour", !/#[0-9a-fA-F]{3,8}\b/.test(pill));

  // Locale tables: both languages carry every string, and they are not copies.
  for (const key of ["stop", "stopAlreadyFinished", "stopAlreadyStopping", "stopGone", "stopSentStillRunning"]) {
    assert(`zh carries ${key}`, typeof ZH[key] === "string" && ZH[key] !== "", String(ZH[key]));
    assert(`en carries ${key}`, typeof EN[key] === "string" && EN[key] !== "", String(EN[key]));
  }
  equal(
    "the five stop strings are translated, not copied",
    ["stop", "stopAlreadyFinished", "stopAlreadyStopping", "stopGone", "stopSentStillRunning"].filter(
      (key) => ZH[key] === EN[key],
    ),
    [],
  );
  assert("the zh a11y template carries the title slot", ZH.stop.includes("{title}"));
  assert("the en a11y template carries the title slot", EN.stop.includes("{title}"));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log("OK");
