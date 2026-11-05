/**
 * Offline assertions for the goal pill's data layer: the shared RPC contract,
 * the command-argument grammar, the four-state presentation rule, the popover's
 * button/confirmation rules, and the poll controller's goal-specific policies.
 *
 * `client/goal-pill.tsx` imports the host runtime (React, React Native, the
 * plugin component library), so plain `node` cannot load it and its behaviour
 * could only be asserted through source regexes. Every rule this file pins lives
 * in `client/goal-polling.ts` / `shared/goal.ts` instead — no React, no host
 * types, every dependency injected — so the harness drives the real
 * implementations.
 *
 * The four states are DESIGN §2's table, and each is asserted separately:
 * `active + armed` is the only one that auto-continues; `active + disarmed` is
 * the silent degradation the pill exists to expose (after a reopen the phase is
 * still active but nothing will continue it). A presentation rule that collapsed
 * the last three into "active" would still render — and would be wrong in the
 * exact way this surface was built to fix.
 *
 * The server half's behaviour (a real session over the fake bridge: read,
 * grading of bridge errors, control success/refusal) is
 * `harness/goal-server-check.cjs`; the copy tables are `harness/locale-check.cjs`.
 *
 * Run (from paseo-plugin):
 *   npx tsc -p ../harness/goal-pill.tsconfig.json
 *   echo '{"type":"commonjs"}' > .dbg-goal/package.json
 *   cp ../harness/goal-pill-check.cjs .dbg-goal/
 *   cd .dbg-goal && node goal-pill-check.cjs
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  GOAL_PHASES,
  GOAL_ACTIVATIONS,
  GOAL_ERROR_CODES,
  TERMINAL_GOAL_ERROR_CODES,
  isTerminalGoalErrorCode,
  goalCommandArguments,
  goalCurrent,
  goalControl,
} = require("./shared/goal.js");
const {
  GOAL_EDITOR_GAP,
  GOAL_EDITOR_MARGIN_HORIZONTAL,
  GOAL_EDITOR_MAX_LINES,
  GOAL_EDITOR_MIN_LINES,
  GOAL_EDITOR_PADDING_HORIZONTAL,
  GOAL_EDITOR_PADDING_VERTICAL,
  GOAL_EDITOR_RADIUS,
  GOAL_EDITOR_WIDTH_WIDE,
  GOAL_SAVE_BUTTON_SIZE,
  GOAL_SAVE_DISABLED_OPACITY,
  GOAL_FACTS_LINE_HEIGHT,
  GOAL_HINT_PADDING_HORIZONTAL,
  GOAL_HINT_PADDING_VERTICAL,
  GOAL_OBJECTIVE_LINE_HEIGHT,
  GOAL_RING_FRAME_SIZE,
  GOAL_RING_OFFSET,
  GOAL_RUNNING_HOLD_MS,
  GOAL_CONFIRM_ARM_MS,
  GOAL_CONFIRM_SETTLE_MS,
  GOAL_CONFIRM_UNARMED_OPACITY,
  GOAL_CONFIRM_UNARMED_SCALE,
  GOAL_DANGER_HOVER_OPACITY,
  GOAL_DANGER_PRESSED_OPACITY,
  GOAL_WHALE_SIZE,
  INITIAL_POLL_JITTER_MS,
  LIVE_POLL_MS,
  MAX_POLL_JITTER_MS,
  MAX_POLL_MS,
  createGoalPoller,
  goalCompleteSeenStep,
  goalConfirmControls,
  goalCurrentTaskLine,
  goalEditDraftValid,
  goalEditKeyAction,
  goalEditSubmittable,
  goalEditorHeight,
  goalEditorType,
  goalFactsLine,
  goalIconButton,
  goalIconColorToken,
  goalIconName,
  goalPanelNext,
  goalPillCopy,
  goalPillPresentation,
  goalRunningMark,
  goalSeenKey,
  goalStateName,
  goalTrackRow,
  initialPollDelayMs,
  nextPollDelayMs,
} = require("./client/goal-polling.js");
const { allText } = require("./client/locale.js");
const LOCALE_TEXT = allText();

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

/** A goal fixture; `over` replaces single fields. */
function goal(over = {}) {
  return {
    id: "goal-1",
    revision: 1,
    objective: "ship the goal pill",
    phase: "active",
    activation: "armed",
    roundsStarted: 3,
    maxGoalRounds: 10,
    ...over,
  };
}

/* The shared contract ------------------------------------------------------- */

console.log("the goal contract (phases, activations, error codes)");
{
  // Frozen literals, not the module's own constants: a typo in the contract must
  // be a red check here, not a value compared against itself.
  equal("phases are DSH's durable set", [...GOAL_PHASES], ["active", "paused", "blocked", "complete"]);
  equal("activations are DSH's process-local set", [...GOAL_ACTIVATIONS], ["armed", "disarmed"]);
  equal(
    "error codes are the four the grading produces",
    [...GOAL_ERROR_CODES].sort(),
    ["bridge_too_old", "goal_unavailable", "rpc_failed", "session_missing"].sort(),
  );
  equal(
    "the terminal half needs a human action",
    [...TERMINAL_GOAL_ERROR_CODES].sort(),
    ["bridge_too_old", "goal_unavailable"].sort(),
  );
  for (const code of ["bridge_too_old", "goal_unavailable"]) {
    check(`${code} is terminal`, isTerminalGoalErrorCode(code), true);
  }
  for (const code of ["session_missing", "rpc_failed", "some_future_code", undefined, ""]) {
    check(`${String(code)} keeps retrying`, isTerminalGoalErrorCode(code), false);
  }

  check("goal.current is the read RPC", goalCurrent.name, "goal.current");
  check("goal.control is the control RPC", goalControl.name, "goal.control");

  // The wire shapes: a payload with the five drawn fields plus the optional
  // blocker parses, and one without activation does not (activation is what the
  // disarmed state depends on; dropping it would silently present the goal as
  // auto-continuing).
  const wire = goalCurrent.output.safeParse({
    available: true,
    goal: goal(),
  });
  check("a full goal parses on the wire", wire.success, true);
  const noActivation = goalCurrent.output.safeParse({
    available: true,
    goal: { objective: "x", phase: "active", roundsStarted: 0, maxGoalRounds: 1 },
  });
  check("a goal without activation is rejected", noActivation.success, false);
  // id/revision are the completed goal's seen key (UI-v7): an old server that
  // does not send them is rejected rather than read as "never seen".
  const { id: _id, ...noId } = goal();
  check("a goal without id is rejected", goalCurrent.output.safeParse({ available: true, goal: noId }).success, false);
  const { revision: _revision, ...noRevision } = goal();
  check(
    "a goal without revision is rejected",
    goalCurrent.output.safeParse({ available: true, goal: noRevision }).success,
    false,
  );
  const parsed = goalCurrent.output.safeParse({ available: true, goal: { ...goal(), createdAt: 1, updatedAt: 2 } });
  check(
    "timestamps are still stripped on the wire",
    parsed.success && !("createdAt" in parsed.data.goal) && !("updatedAt" in parsed.data.goal),
    true,
  );
  const blocked = goalCurrent.output.safeParse({
    available: true,
    goal: goal({ phase: "blocked", blockedReason: { code: "round-limit", message: "limit reached" } }),
  });
  check("a blocked goal carries its reason", blocked.success, true);
  const nullGoal = goalCurrent.output.safeParse({ available: true, goal: null });
  check("no goal is a null goal, not a missing field", nullGoal.success, true);
  const failed = goalCurrent.output.safeParse({
    available: false,
    goal: null,
    error: { message: "no goal service", code: "goal_unavailable" },
  });
  check("a coded read failure parses", failed.success, true);
  const olderServer = goalCurrent.output.safeParse({
    available: false,
    goal: null,
    error: { message: "boom" },
  });
  check("a code-less error from an older server stays valid", olderServer.success, true);
  const controlOk = goalControl.output.safeParse({ ok: true, message: "Goal paused" });
  check("a control success parses", controlOk.success, true);
  const controlFailed = goalControl.output.safeParse({ ok: false, error: "not valid" });
  check("a control refusal parses", controlFailed.success, true);
}

/* The command grammar ------------------------------------------------------- */

console.log("\nthe /goal argument grammar (DSH's own)");
{
  // `dsh-command-goal`'s `parseGoalCommand`: pause/resume/clear are whole words,
  // `edit` takes a replacement objective, everything else is a new objective.
  // The plugin only ever builds control arguments, never a create.
  equal("pause is a bare word", goalCommandArguments("pause"), { ok: true, args: "pause" });
  equal("resume is a bare word", goalCommandArguments("resume"), { ok: true, args: "resume" });
  equal("clear is a bare word", goalCommandArguments("clear"), { ok: true, args: "clear" });
  equal("edit carries the objective", goalCommandArguments("edit", "make it faster"), {
    ok: true,
    args: "edit make it faster",
  });
  equal("edit trims the replacement", goalCommandArguments("edit", "  make it faster  "), {
    ok: true,
    args: "edit make it faster",
  });
  equal("edit accepts a Chinese objective", goalCommandArguments("edit", "把目标改短"), {
    ok: true,
    args: "edit 把目标改短",
  });
  // `/goal edit pause after verification` is an edit whose objective starts with
  // a control word — DSH's regex only treats a bare `edit` as the control, so the
  // rest is the objective. The plugin must not re-parse it.
  equal("edit's objective may start with a control word", goalCommandArguments("edit", "pause after verification"), {
    ok: true,
    args: "edit pause after verification",
  });
  for (const [what, value] of [
    ["empty", ""],
    ["whitespace-only", "   "],
    ["absent", undefined],
  ]) {
    const refused = goalCommandArguments("edit", value);
    assert(`an ${what} edit is refused`, refused.ok === false, JSON.stringify(refused));
    assert(
      `…with an explanation for the ${what} edit`,
      refused.ok === false && typeof refused.error === "string" && refused.error.length > 0,
      JSON.stringify(refused),
    );
  }
}

/* Presentation -------------------------------------------------------------- */

console.log("\nthe five states the trigger must tell apart");
{
  const armed = goalPillPresentation({ available: true, goal: goal() });
  check("active+armed is visible", armed.visible, true);
  equal("active+armed labels itself as running (no round fraction)", armed.label, { kind: "running" });
  check("active+armed is the normal tone", armed.tone, "normal");
  check("the presentation carries no title (the title is the fixed noun)", !("title" in armed), true);

  const disarmed = goalPillPresentation({ available: true, goal: goal({ activation: "disarmed" }) });
  check("active+disarmed is visible", disarmed.visible, true);
  equal("active+disarmed does NOT claim to be running", disarmed.label, { kind: "notRunning" });
  check("active+disarmed warns", disarmed.tone, "warning");

  const paused = goalPillPresentation({ available: true, goal: goal({ phase: "paused" }) });
  check("paused is visible", paused.visible, true);
  equal("paused labels itself", paused.label, { kind: "paused" });
  check("paused warns", paused.tone, "warning");

  const blocked = goalPillPresentation({
    available: true,
    goal: goal({ phase: "blocked", blockedReason: { code: "round-limit", message: "limit reached" } }),
  });
  check("blocked is visible", blocked.visible, true);
  equal("blocked labels itself", blocked.label, { kind: "blocked" });
  check("blocked is the error tone", blocked.tone, "error");

  // ---- a completed goal is shown once, until seen (UI-v7) ----------------
  // DSH's Web hides a complete goal at once; this plugin shows it until the user
  // has seen it, remembered per `id:revision`. Several assertions pin both
  // halves: shown while unseen, hidden once seen, shown again for a new key.
  const complete = goalPillPresentation({ available: true, goal: goal({ phase: "complete", activation: "disarmed" }) });
  check("an unseen complete goal is visible", complete.visible, true);
  equal("…labelled complete", complete.label, { kind: "complete" });
  check("…in the success tone", complete.tone, "success");
  check(
    "an unseen complete goal is visible even when armed",
    goalPillPresentation({ available: true, goal: goal({ phase: "complete", activation: "armed" }) }).visible,
    true,
  );
  check(
    "an unseen complete goal is visible at any round count",
    goalPillPresentation({ available: true, goal: goal({ phase: "complete", roundsStarted: 0, maxGoalRounds: 0 }) }).visible,
    true,
  );
  const seenKey = goalSeenKey(goal({ phase: "complete" }));
  equal("the seen key is id:revision", seenKey, "goal-1:1");
  check(
    "a seen complete goal is hidden",
    goalPillPresentation({ available: true, goal: goal({ phase: "complete" }) }, seenKey).visible,
    false,
  );
  check(
    "a new revision of a seen goal is shown again",
    goalPillPresentation({ available: true, goal: goal({ phase: "complete", revision: 2 }) }, seenKey).visible,
    true,
  );
  check(
    "a new goal with the same objective is shown again",
    goalPillPresentation({ available: true, goal: goal({ phase: "complete", id: "goal-2" }) }, seenKey).visible,
    true,
  );
  check(
    "the seen key only hides a complete goal",
    goalPillPresentation({ available: true, goal: goal() }, seenKey).visible,
    true,
  );
  equal("a completed goal draws the check", goalIconName("success"), "CircleCheck");
  equal("every other tone draws the Target", ["normal", "warning", "error"].map(goalIconName), ["Target", "Target", "Target"]);
  equal("the success tone colours the glyph with statusSuccess", goalIconColorToken("success"), "statusSuccess");

  // No goal: never created, or cleared (both are `goal: null`).
  check("no goal is hidden", goalPillPresentation({ available: true, goal: null }).visible, false);
  check(
    "no goal carries no label to render",
    !("label" in goalPillPresentation({ available: true, goal: null })),
    true,
  );

  // Terminal read failures hide the pill: a profile that cannot report goals at
  // all must look like "the feature is not here", not like an error the user
  // cannot clear. The rule only sees `available`, but both terminal codes the
  // poller removes on are named so the intent is pinned for each.
  check(
    "a goal_unavailable read is hidden",
    goalPillPresentation({ available: false, goal: null }).visible,
    false,
  );
  check(
    "a bridge_too_old read is hidden",
    goalPillPresentation({ available: false, goal: null }).visible,
    false,
  );
  check("a failed read is hidden", goalPillPresentation({ available: false, goal: goal() }).visible, false);

  // The trigger's glyph: the label is plain text the host paints, so the tone
  // reaches the pill only through the icon component's colour.
  // The design's one-signal-one-token rule: a normal (non-running) glyph is the
  // same muted mark every host rail uses; the running state is the ring, not a
  // colour.
  equal("the normal tone colours the glyph muted", goalIconColorToken("normal"), "foregroundMuted");
  equal("the warning tone colours the glyph with statusWarning", goalIconColorToken("warning"), "statusWarning");
  equal("the error tone colours the glyph with statusDanger", goalIconColorToken("error"), "statusDanger");
}

/* The panel's geometry (the host's numbers, value for value) ---------------- */

console.log("\nthe panel rows use the host's track geometry");
{
  // composer/tracks.tsx:347-379 `trackRow`, value for value.
  const wide = goalTrackRow(false);
  const compact = goalTrackRow(true);
  equal("the wide row is the host's 32px row", wide.minHeight, 32);
  equal("the phone row meets the host's 40px row", compact.minHeight, 40);
  equal("the row insets 4 from the surface", wide.marginHorizontal, 4);
  equal("the row pads 8 horizontally", wide.paddingHorizontal, 8);
  equal("the wide row pads 4 vertically", wide.paddingVertical, 4);
  equal("the phone row pads 8 vertically", compact.paddingVertical, 8);
  equal("the row radius is the host's 6", wide.borderRadius, 6);
  equal("the row gap is the host's 8", wide.gap, 8);
  equal("the row is a row", wide.flexDirection, "row");
  equal("the phone row insets the same 4", compact.marginHorizontal, 4);

  // UI-v9: the clear confirmation's row end. The phone's red button keeps the
  // view page's 32px touch target; the whole end stays within 8px of the view
  // page's two buttons + gap, so the objective is not squeezed (UI-v9 issue 2).
  equal("the phone red button is the 32px touch target", goalConfirmControls(true).dangerSize, 32);
  equal("the phone red glyph is 18", goalConfirmControls(true).dangerGlyph, 18);
  equal("the wide red button is 24", goalConfirmControls(false).dangerSize, 24);
  equal("the wide red glyph is 14", goalConfirmControls(false).dangerGlyph, 14);
  equal("取消 pads 8 each side", goalConfirmControls(true).cancelPaddingHorizontal, 8);
  equal("the row-end gap is the view page's 4", goalConfirmControls(true).gap, 4);
  {
    // 取消 is two 12px CJK glyphs: 24px of text + 2×8 padding = 40.
    const c = goalConfirmControls(true);
    const confirmEnd = 2 * 12 + 2 * c.cancelPaddingHorizontal + c.gap + c.dangerSize;
    const viewEnd = 2 * goalIconButton(true).size + 4;
    assert(`the phone confirm row end (${confirmEnd}) is at most 8px wider than the view page's (${viewEnd})`, confirmEnd - viewEnd <= 8);
  }
  // The double-click guard and the host destructive button's pressed opacity.
  equal("the red button arms after 400ms", GOAL_CONFIRM_ARM_MS, 400);
  assert("the unarmed red button is visibly faded", GOAL_CONFIRM_UNARMED_OPACITY > 0 && GOAL_CONFIRM_UNARMED_OPACITY <= 0.5);
  assert("the unarmed red button is visibly smaller", GOAL_CONFIRM_UNARMED_SCALE >= 0.8 && GOAL_CONFIRM_UNARMED_SCALE < 1);
  assert("the settle transition ends before arming", GOAL_CONFIRM_SETTLE_MS > 0 && GOAL_CONFIRM_SETTLE_MS < GOAL_CONFIRM_ARM_MS);
  equal("the red button presses to the host's 0.85", GOAL_DANGER_PRESSED_OPACITY, 0.85);
  assert("hover is a lighter step than pressed", GOAL_DANGER_HOVER_OPACITY > GOAL_DANGER_PRESSED_OPACITY && GOAL_DANGER_HOVER_OPACITY < 1);

  // icon-button-chrome.ts:11-14: 20x20 / 32x32, glyph 14 / 18.
  equal("the wide icon button is 20", goalIconButton(false).size, 20);
  equal("the phone icon button meets the touch floor", goalIconButton(true).size, 32);
  equal("the wide glyph is 14", goalIconButton(false).glyph, 14);
  equal("the phone glyph is 18", goalIconButton(true).glyph, 18);
  equal("the icon button radius is the host's 6", goalIconButton(false).borderRadius, 6);

  // The design's constants, as numbers so a silent change fails here.
  equal("the whale is the host's 16px slot", GOAL_WHALE_SIZE, 16);
  equal("the corner ring frame is 14", GOAL_RING_FRAME_SIZE, 14);
  equal("the corner ring offset is the host's -5", GOAL_RING_OFFSET, -5);
  equal("the objective line is 20", GOAL_OBJECTIVE_LINE_HEIGHT, 20);
  equal("the facts line is 16", GOAL_FACTS_LINE_HEIGHT, 16);
  // The edit box is the host composer's `inputWrapper` at compact padding and
  // its 28px send button (composer/input/input.tsx:2259-2287, :2390-2398).
  equal("the edit box radius is the composer's 16", GOAL_EDITOR_RADIUS, 16);
  equal("the edit box pads 8 vertically", GOAL_EDITOR_PADDING_VERTICAL, 8);
  equal("the edit box pads 12 horizontally", GOAL_EDITOR_PADDING_HORIZONTAL, 12);
  equal("the edit box's text-to-buttons gap is 12", GOAL_EDITOR_GAP, 12);
  equal("the edit box sits 8 in from the panel edge", GOAL_EDITOR_MARGIN_HORIZONTAL, 8);
  equal("the save button is the composer's 28", GOAL_SAVE_BUTTON_SIZE, 28);
  equal("a disabled save button is half opacity", GOAL_SAVE_DISABLED_OPACITY, 0.5);
  equal("the field grows from two lines", GOAL_EDITOR_MIN_LINES, 2);
  equal("the field stops growing at six lines", GOAL_EDITOR_MAX_LINES, 6);
  equal("the edit page is the popover's content width", GOAL_EDITOR_WIDTH_WIDE, 396);
  equal("the hint pads 12 horizontally", GOAL_HINT_PADDING_HORIZONTAL, 12);
  equal("the hint pads 8 vertically", GOAL_HINT_PADDING_VERTICAL, 8);
  equal("the running hold is 1.5s", GOAL_RUNNING_HOLD_MS, 1500);
}

/* The facts line ------------------------------------------------------------ */

console.log("\nthe facts line joins the phase and the round budget");
{
  const zh = { active: "进行中", paused: "已暂停", blocked: "受阻", complete: "已完成", disarmed: "未在续跑" };
  const zhRounds = (started, max) => `第 ${String(started)} 轮 · 预算 ${String(max)}`;
  equal("the facts line is one sentence", goalFactsLine(goal(), zh, zhRounds), "进行中 · 第 3 轮 · 预算 10");
  // `active + disarmed` is not a phase: the facts line must say 未在续跑, matching
  // the pill's 目标未在续跑 on the same screen (design v1 §98, *-disarmed.png).
  equal(
    "disarmed facts start with 未在续跑",
    goalFactsLine(goal({ phase: "active", activation: "disarmed" }), zh, zhRounds),
    "未在续跑 · 第 3 轮 · 预算 10",
  );
  assert(
    "the disarmed word wins over the phase word",
    goalFactsLine(goal({ phase: "active", activation: "disarmed" }), zh, zhRounds) !== goalFactsLine(goal(), zh, zhRounds),
  );
  equal("an unknown phase falls back to the key", goalFactsLine(goal(), {}, () => "r"), "active · r");
  const en = { active: "Active", paused: "Paused", blocked: "Blocked", complete: "Complete", disarmed: "Not continuing" };
  equal(
    "the English facts line",
    goalFactsLine(goal(), en, (started, max) => `Round ${String(started)} · budget ${String(max)}`),
    "Active · Round 3 · budget 10",
  );
  equal(
    "the English disarmed facts line",
    goalFactsLine(goal({ phase: "active", activation: "disarmed" }), en, (started, max) => `Round ${String(started)} · budget ${String(max)}`),
    "Not continuing · Round 3 · budget 10",
  );
}

/* The running mark (the design's A2 truth table) ---------------------------- */

console.log("\nthe running mark follows the design's truth table");
{
  const running = { phase: "active", activation: "armed", agentStatus: "running", now: 1000 };
  equal("a running agent turns the ring", goalRunningMark(running), true);
  equal("an idle agent inside the hold turns", goalRunningMark({ ...running, agentStatus: "idle", holdUntil: 2500 }), true);
  equal("an idle agent past the hold stops", goalRunningMark({ ...running, agentStatus: "idle", holdUntil: 900 }), false);
  equal("an idle agent with no hold stops", goalRunningMark({ ...running, agentStatus: "idle" }), false);
  equal("a disarmed goal never turns", goalRunningMark({ ...running, activation: "disarmed" }), false);
  equal("a paused goal never turns", goalRunningMark({ ...running, phase: "paused" }), false);
  equal("a blocked goal never turns", goalRunningMark({ ...running, phase: "blocked" }), false);
  equal("a complete goal never turns", goalRunningMark({ ...running, phase: "complete" }), false);
  for (const status of ["initializing", "error", "closed"]) {
    equal(`${status} never turns`, goalRunningMark({ ...running, agentStatus: status }), false);
  }
  equal("an unreadable agent status never turns", goalRunningMark({ ...running, agentStatus: null }), false);
  equal("an undefined agent status never turns", goalRunningMark({ ...running, agentStatus: undefined }), false);
  // The hold is a window, not a latch: the same idle status turns inside it and
  // stops outside it.
  const idle = { ...running, agentStatus: "idle", holdUntil: 2000 };
  equal("inside the hold", goalRunningMark({ ...idle, now: 1999 }), true);
  equal("at the hold boundary", goalRunningMark({ ...idle, now: 2000 }), false);
}

/* The trigger glyph's colour ------------------------------------------------ */

console.log("\nthe trigger glyph is muted, warning or danger");
{
  equal("a normal goal is muted", goalIconColorToken("normal"), "foregroundMuted");
  equal("a warning goal is warning", goalIconColorToken("warning"), "statusWarning");
  equal("an error goal is danger", goalIconColorToken("error"), "statusDanger");
}

/* The edit page's rules ----------------------------------------------------- */

console.log("\nthe edit page refuses empty and unchanged drafts");
{
  for (const value of ["", "   ", "\n\t"]) {
    check(`${JSON.stringify(value)} is not submittable`, goalEditSubmittable(value, "old"), false);
  }
  equal("a changed draft is submittable", goalEditSubmittable("new", "old"), true);
  equal("an unchanged draft is not submittable", goalEditSubmittable("old", "old"), false);
  equal("the same text with spaces is a change", goalEditSubmittable(" old ", "old"), true);
  equal("the empty-draft rule alone", goalEditDraftValid(""), false);
  equal("a non-empty draft alone", goalEditDraftValid("x"), true);
}

console.log("\nthe edit field's height grows from two lines to six");
{
  equal("web type is the composer's 15/21", goalEditorType(true), { fontSize: 15, lineHeight: 21 });
  equal("native type is the composer's 16/22", goalEditorType(false), { fontSize: 16, lineHeight: 22 });
  equal("an unmeasured field is two lines", goalEditorHeight(0, 21), 42);
  equal("a NaN measurement is two lines", goalEditorHeight(Number.NaN, 21), 42);
  equal("one line of text still gets two", goalEditorHeight(21, 21), 42);
  equal("four lines are four lines", goalEditorHeight(84, 21), 84);
  equal("a fractional height rounds up", goalEditorHeight(84.4, 21), 85);
  equal("twelve lines stop at six", goalEditorHeight(252, 21), 126);
}

console.log("\nkeys in the edit field follow the host composer");
{
  const desk = { shiftKey: false, composing: false, submitOnEnter: true };
  const phone = { shiftKey: false, composing: false, submitOnEnter: false };
  equal("desktop Enter saves", goalEditKeyAction({ ...desk, key: "Enter" }), "save");
  equal("desktop Shift+Enter is a newline", goalEditKeyAction({ ...desk, key: "Enter", shiftKey: true }), null);
  equal("Enter that commits an IME candidate is not a save", goalEditKeyAction({ ...desk, key: "Enter", composing: true }), null);
  equal("desktop Escape cancels", goalEditKeyAction({ ...desk, key: "Escape" }), "cancel");
  equal("phone Enter is a newline", goalEditKeyAction({ ...phone, key: "Enter" }), null);
  equal("typing does nothing", goalEditKeyAction({ ...desk, key: "a" }), null);
}

console.log("\nthe pill's label and title are 目标 in every state; the panel row speaks the state");
{
  const cases = [
    ["running", goal(), "目标进行中", "Goal running"],
    ["notRunning", goal({ activation: "disarmed" }), "目标未在续跑", "Goal not running"],
    ["paused", goal({ phase: "paused" }), "目标已暂停", "Goal paused"],
    ["blocked", goal({ phase: "blocked", blockedReason: { code: "x", message: "y" } }), "目标受阻", "Goal blocked"],
    ["complete", goal({ phase: "complete", activation: "disarmed" }), "目标已完成", "Goal complete"],
  ];
  for (const [what, value, zhState, enState] of cases) {
    const presentation = goalPillPresentation({ available: true, goal: value });
    const zh = goalPillCopy(presentation, LOCALE_TEXT["zh-CN"].goal);
    const en = goalPillCopy(presentation, LOCALE_TEXT.en.goal);
    // The title is also the phone sheet's header, which must read the noun.
    equal(`${what}: zh label and title are the noun`, zh, { label: "目标", title: "目标" });
    equal(`${what}: en label and title are the noun`, en, { label: "Goal", title: "Goal" });
    equal(`${what}: the zh state name`, goalStateName(value, LOCALE_TEXT["zh-CN"].goal), zhState);
    equal(`${what}: the en state name`, goalStateName(value, LOCALE_TEXT.en.goal), enState);
  }
  const hidden = goalPillCopy(goalPillPresentation({ available: true, goal: null }), LOCALE_TEXT["zh-CN"].goal);
  equal("a hidden pill falls back to the noun", hidden, { label: "目标", title: "目标" });
}

console.log("\na completed goal's seen state");
{
  const done = goal({ phase: "complete", activation: "disarmed" });
  const step = (state, ...events) => events.reduce((acc, event) => goalCompleteSeenStep(acc, event), state);
  // The completing turn: complete observed while the agent still runs (it is
  // writing the closing summary), then it goes idle. Neither is "seen".
  const running = step({}, { kind: "goal", goal: done, agentStatus: "running" });
  equal("observing complete while running starts watching", running, { watch: { key: "goal-1:1", stage: "watching" } });
  const idled = step(running, { kind: "agent", status: "idle" });
  equal("the completing turn's running→idle is not seen", idled.seen, undefined);
  equal("…it only arms the watch", idled.watch, { key: "goal-1:1", stage: "idleSeen" });
  equal("a repeated running before idle is not seen", step(running, { kind: "agent", status: "running" }).seen, undefined);
  // The next turn: running after idle is the user moving on.
  equal("running after idle marks it seen", step(idled, { kind: "agent", status: "running" }), { seen: "goal-1:1" });
  // First observed while already idle (the completing turn ended between polls).
  const lateIdle = step({}, { kind: "goal", goal: done, agentStatus: "idle" });
  equal("a completion first seen while idle starts armed", lateIdle.watch?.stage, "idleSeen");
  equal("…so the next running marks it seen", step(lateIdle, { kind: "agent", status: "running" }).seen, "goal-1:1");
  // Closing the opened panel marks it seen at once.
  equal("closing the complete panel marks it seen", step(running, { kind: "closed", goal: done }), { seen: "goal-1:1" });
  equal("closing a non-complete panel marks nothing", step({}, { kind: "closed", goal: goal() }).seen, undefined);
  // A new key is watched again; the old key stays remembered.
  const seen = { seen: "goal-1:1" };
  equal("the seen key survives repeated polls", step(seen, { kind: "goal", goal: done, agentStatus: "running" }), seen);
  equal(
    "a new revision is watched again",
    step(seen, { kind: "goal", goal: { ...done, revision: 2 }, agentStatus: "running" }).watch,
    { key: "goal-1:2", stage: "watching" },
  );
  // Leaving complete (cleared / replaced) drops the watch but keeps the key.
  equal("a cleared goal drops the watch", step(running, { kind: "goal", goal: null }), {});
  equal("…and keeps a remembered key", step(seen, { kind: "goal", goal: null }), seen);
  equal("agent events without a watch change nothing", step({}, { kind: "agent", status: "running" }), {});
  // End to end with the presentation rule.
  const final = step(
    {},
    { kind: "goal", goal: done, agentStatus: "running" },
    { kind: "agent", status: "idle" },
    { kind: "agent", status: "running" },
  );
  check("after the next turn the pill is hidden", goalPillPresentation({ available: true, goal: done }, final.seen).visible, false);
}

console.log("\nleaving the editor closes the panel (UI-v8)");
{
  equal("the editor's 取消 / Escape closes", goalPanelNext({ kind: "cancelEdit" }), "close");
  equal("the clear page's 取消 returns to the main page", goalPanelNext({ kind: "cancelClear" }), "view");
  equal("a saved edit closes", goalPanelNext({ kind: "control", action: "edit", ok: true }), "close");
  equal("a refused edit stays in the editor", goalPanelNext({ kind: "control", action: "edit", ok: false }), "stay");
  for (const action of ["pause", "resume", "clear"]) {
    equal(`a successful ${action} returns to the main page`, goalPanelNext({ kind: "control", action, ok: true }), "view");
    equal(`a refused ${action} stays`, goalPanelNext({ kind: "control", action, ok: false }), "stay");
  }
}

/* The popover's wiring (source-level: it is JSX) ---------------------------- */

console.log("\nthe trigger and popover wiring");
{
  // The values above are asserted directly; these pin the call sites. Only code
  // forms are matched — never a bare identifier or a style literal (a literal in
  // a doc comment once satisfied a check). The rendered DOM — row press opens
  // the editor, exactly two icon buttons, no edit button, Escape/blur — is
  // asserted by `harness/goal-popover-render-check.cjs`.
  const repoRoot = path.resolve(__dirname, "..", "..");
  const readRepo = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
  const pill = readRepo("paseo-plugin/client/goal-pill.tsx");
  const popover = readRepo("paseo-plugin/client/goal-popover.tsx");
  const mark = readRepo("paseo-plugin/client/deepseek-mark.tsx");

  // The label/title strings themselves are asserted behaviourally above; this
  // pins that the registration uses that rule rather than its own copy.
  assert("the trigger's strings come from goalPillCopy", /const \{ label, title \} = goalPillCopy\(presentation, text\)/.test(pill));
  assert("the trigger's title is not the objective", !/title:.*goal\.objective/.test(pill));
  // The pill's icon slot (T10b): the glyph always stays; running adds the
  // corner ring (`client/corner-ring.tsx`) instead of replacing the glyph. The
  // rendered half (glyph present, ring on the corner) is in
  // `harness/goal-popover-render-check.cjs`.
  assert(
    "the trigger's icon keeps its glyph and puts the ring on the corner while running",
    /<CornerRingIcon[\s\S]{0,200}running=\{running\}/.test(pill) && !/<StatusRingMark/.test(pill),
  );
  // The static glyph's name comes from the pure rule (Target, or the completed
  // check), asserted behaviourally above; this pins the call site.
  assert("the static glyph's name comes from goalIconName", /name=\{goalIconName\(tone\)\}/.test(pill));
  // The objective row is the host's track row and the edit entry.
  assert("the objective row is a track row", /goalTrackRow\(compact\)/.test(popover));
  assert("the objective is one truncated line", /numberOfLines=\{1\}[\s\S]{0,400}?\{goal\.objective\}/.test(popover));
  assert("the facts line comes from the pure rule", /goalFactsLine\(goal, text\.statuses, text\.rounds\)/.test(popover));
  // The clear page (UI-v9 direction B) is the view page's row held in place,
  // at the panel's own density; the old menu rows and separator are gone, and
  // neither page draws menu rows any more.
  assert("the clear page's row end comes from the pure rule", /goalConfirmControls\(compact\)/.test(popover));
  assert("the clear page has no menu rows", !/function MenuRow/.test(popover) && !/goalMenuItem/.test(popover));
  assert("the clear page has no separator", !/function Separator/.test(popover));
  assert("the edit page has no save menu row", !/label=\{text\.actions\.save\}/.test(popover));
  assert("the edit keys go through the pure rule", /goalEditKeyAction\(\{/.test(popover));
  assert("the clear page's red button is statusDanger", /backgroundColor: theme\.colors\.statusDanger/.test(popover));
  // Every place that shows a control error goes through the translated display.
  assert("control errors render through ControlError", /<ControlError theme=\{theme\} text=\{text\} error=\{error\} \/>/.test(popover));
  assert("no raw red error hint remains", !/<Hint theme=\{theme\} danger>/.test(popover));
  // The old button component and the footnote are gone.
  assert("no filled-button component remains", !/function ActionButton/.test(popover));
  assert("the footnote is gone", !/text\.footnote/.test(popover));
  // The panel cancels the host's popover content padding.
  assert("the panel cancels the host content padding", /popoverRootBox\(\)/.test(popover));
  // The whale draws through the host's svg seam.
  assert("the mark renders through the host's svg icon", /icon=\{\{ svg: DEEPSEEK_MARK_SVG \}\}/.test(mark));
}

/* The goal/jobs slot (T10b) ------------------------------------------------- */

console.log("\nthe goal and the jobs share one slot (T10b)");
{
  const {
    GOAL_JOBS_SLOT_ID,
    createGoalJobsSlot,
    goalJobsSlotShown,
    goalJobsSlotView,
    goalNeedsAttention,
  } = require("./client/goal-jobs-slot.js");
  const { jobsPillPresentation } = require("./client/jobs-polling.js");

  // The two halves' real rules, so the slot is tested on what they report.
  const goalSide = (g, seen) => {
    const p = goalPillPresentation({ available: true, goal: g }, seen);
    return { visible: p.visible, attention: goalNeedsAttention(p) };
  };
  const jobsSide = (answer) => {
    const p = jobsPillPresentation(answer);
    return { visible: p.visible, live: p.label.kind === "live" };
  };
  const running = { available: true, jobs: [{ status: "running" }, { status: "completed" }] };
  const stopping = { available: true, jobs: [{ status: "stopping" }] };
  const finished = { available: true, jobs: [{ status: "completed" }, { status: "failed" }, { status: "killed" }] };
  const none = { available: true, jobs: [] };

  // Which goal states need the user: everything but the armed, active goal.
  check("armed active goal does not need the user", goalSide(goal()).attention, false);
  for (const [what, g] of [
    ["blocked", goal({ phase: "blocked" })],
    ["paused", goal({ phase: "paused" })],
    ["active+disarmed", goal({ activation: "disarmed" })],
    ["complete, unseen", goal({ phase: "complete", activation: "disarmed" })],
  ]) {
    check(`${what} needs the user`, goalSide(g).attention, true);
    check(`${what} beside running jobs: the slot shows the goal`, goalJobsSlotShown(goalSide(g), jobsSide(running)), "goal");
  }
  check("no goal at all needs nothing", goalNeedsAttention(goalPillPresentation({ available: true, goal: null })), false);

  // Only jobs.
  check("only running jobs: jobs", goalJobsSlotShown(undefined, jobsSide(running)), "jobs");
  check("only stopping jobs: jobs", goalJobsSlotShown(undefined, jobsSide(stopping)), "jobs");
  check("cleared goal + running jobs: jobs", goalJobsSlotShown(goalSide(null), jobsSide(running)), "jobs");
  const seenKey = goalSeenKey(goal({ phase: "complete" }));
  check("seen complete goal + running jobs: jobs",
    goalJobsSlotShown(goalSide(goal({ phase: "complete", activation: "disarmed" }), seenKey), jobsSide(running)), "jobs");
  // Only goal.
  check("only an armed goal: goal", goalJobsSlotShown(goalSide(goal()), jobsSide(none)), "goal");
  check("only a blocked goal: goal", goalJobsSlotShown(goalSide(goal({ phase: "blocked" })), undefined), "goal");
  // Both, goal armed: the jobs while live.
  check("armed goal + running jobs: jobs", goalJobsSlotShown(goalSide(goal()), jobsSide(running)), "jobs");
  check("armed goal + stopping jobs: jobs", goalJobsSlotShown(goalSide(goal()), jobsSide(stopping)), "jobs");
  // The jobs' own semantics are unchanged: finished work never holds the slot.
  check("finished jobs only: hidden", goalJobsSlotShown(goalSide(null), jobsSide(finished)), null);
  check("armed goal + finished jobs: goal", goalJobsSlotShown(goalSide(goal()), jobsSide(finished)), "goal");
  check("nothing at all: hidden", goalJobsSlotShown(goalSide(null), jobsSide(none)), null);
  check("neither half reported: hidden", goalJobsSlotShown(undefined, undefined), null);
  // An unreadable registry stays visible (baseline), but has no live count, so
  // it does not take the trigger from a running goal.
  const unreadable = { available: false, jobs: [] };
  check("unreadable registry alone: jobs (the panel explains it)", goalJobsSlotShown(undefined, jobsSide(unreadable)), "jobs");
  check("armed goal + unreadable registry: goal", goalJobsSlotShown(goalSide(goal()), jobsSide(unreadable)), "goal");

  // The open panel's view: stays put, falls back only when its half vanished.
  check("goal view stays while the goal exists", goalJobsSlotView("goal", true, false), "goal");
  check("jobs view stays while jobs run", goalJobsSlotView("jobs", true, true), "jobs");
  check("jobs finished while the jobs view is open: falls back to the goal", goalJobsSlotView("jobs", true, false), "goal");
  check("goal cleared while the goal view is open: falls back to the jobs", goalJobsSlotView("goal", false, true), "jobs");
  check("both gone: the view is kept (the host hides the button)", goalJobsSlotView("jobs", false, false), "jobs");

  // The coordinator against a fake host: one registration per agent, never a
  // behavior in an update, only changed fields sent.
  const regs = [];
  const fakeHost = {
    addComposerPill(contribution) {
      const reg = { contribution, updates: [], removed: 0 };
      reg.update = (patch) => reg.updates.push(patch);
      reg.remove = () => {
        reg.removed += 1;
      };
      regs.push(reg);
      return reg;
    },
    makeContents: 0,
    makeContent(agentId) {
      fakeHost.makeContents += 1;
      return `Content:${agentId}`;
    },
  };
  const slot = createGoalJobsSlot(fakeHost);
  const agent = { id: "a", workspaceId: "ws" };
  const GoalIcon = "GoalIcon";
  const JobsIcon = "JobsIcon";
  slot.attach("jobs", agent, { Content: "JobsBody", icon: JobsIcon, title: "后台任务" });
  slot.attach("goal", agent, { Content: "GoalBody", icon: GoalIcon, title: "目标" });
  check("both halves of one agent share ONE registration", regs.length, 1);
  check("…under the slot id", regs[0].contribution.id, GOAL_JOBS_SLOT_ID);
  check("…registered hidden", regs[0].contribution.button.visible, false);
  check("…with one fixed popover Content", regs[0].contribution.button.behavior.Content, "Content:a");
  check("…built once", fakeHost.makeContents, 1);
  // The other order too: whichever half's poller registers the agent first,
  // the second half joins the same registration (never a second pill).
  const ordered = createGoalJobsSlot(fakeHost);
  const before2 = regs.length;
  ordered.attach("goal", { id: "z", workspaceId: "ws" }, { Content: "GoalBody", icon: GoalIcon, title: "目标" });
  ordered.attach("jobs", { id: "z", workspaceId: "ws" }, { Content: "JobsBody", icon: JobsIcon, title: "后台任务" });
  check("goal first, then jobs: still ONE registration", regs.length - before2, 1);
  // A half re-attaching (after a drop) does not add a pill either.
  ordered.attach("jobs", { id: "z", workspaceId: "ws" }, { Content: "JobsBody", icon: JobsIcon, title: "后台任务" });
  ordered.attach("goal", { id: "z", workspaceId: "ws" }, { Content: "GoalBody", icon: GoalIcon, title: "目标" });
  check("re-attaching either half keeps ONE registration", regs.length - before2, 1);
  ordered.dispose();
  regs.splice(before2);

  const goalState = (g, label = "目标") => ({ ...goalSide(g), goal: g, label, title: "目标", icon: GoalIcon });
  const jobsState = (answer, count) => ({ ...jobsSide(answer), label: count === undefined ? "后台任务" : `${count} 个后台`, title: "后台任务", icon: JobsIcon });
  const last = () => {
    const merged = { visible: false, title: "后台任务", icon: JobsIcon };
    for (const patch of regs[0].updates) Object.assign(merged, patch);
    return merged;
  };
  slot.presentGoal("a", goalState(goal()));
  slot.presentJobs("a", jobsState(running, 1));
  check("armed goal + 1 running job: the trigger reads 1 个后台", last().label, "1 个后台");
  check("…with the jobs icon", last().icon, JobsIcon);
  check("…and the jobs title", last().title, "后台任务");
  check("…visible", last().visible, true);
  check("the snapshot says jobs", slot.snapshot("a").shown, "jobs");
  slot.presentGoal("a", goalState(goal({ phase: "blocked" })));
  check("the goal blocks: the trigger flips to 目标", last().label, "目标");
  check("…with the goal icon", last().icon, GoalIcon);
  check("…and the goal title", last().title, "目标");
  slot.presentGoal("a", goalState(goal()));
  slot.presentJobs("a", jobsState(finished));
  check("jobs finished beside an armed goal: back to 目标", last().label, "目标");
  check("…still visible", last().visible, true);
  slot.presentGoal("a", goalState(null));
  check("goal cleared and jobs finished: hidden", last().visible, false);
  check("no update ever carries a behavior", regs[0].updates.every((patch) => !("behavior" in patch)), true);
  const before = regs[0].updates.length;
  slot.presentJobs("a", jobsState(finished));
  slot.presentGoal("a", goalState(null));
  check("an unchanged answer sends no update", regs[0].updates.length, before);
  slot.presentJobs("a", jobsState(running, 2));
  const flips = regs[0].updates.slice(before);
  check("a flip sends only the changed fields", JSON.stringify(flips), JSON.stringify([{ visible: true, label: "2 个后台", title: "后台任务", icon: JobsIcon }]));
  slot.presentJobs("a", jobsState(running, 3));
  check("a count change sends only the label", JSON.stringify(regs[0].updates.at(-1)), JSON.stringify({ label: "3 个后台" }));

  // A second agent gets its own registration; detaching one half keeps the
  // slot, detaching both removes it.
  slot.attach("goal", { id: "b", workspaceId: "ws" }, { Content: "GoalBody", icon: GoalIcon, title: "目标" });
  check("another agent gets its own slot", regs.length, 2);
  slot.detach("goal", "a");
  check("detaching the goal keeps the slot for the jobs", regs[0].removed, 0);
  check("…and the snapshot has no goal half", slot.snapshot("a").goal, undefined);
  slot.detach("jobs", "a");
  check("detaching both halves removes the one registration", regs[0].removed, 1);
  check("…and forgets the agent", slot.snapshot("a"), undefined);

  // "Seen" waits for the whole panel to close, with the goal the goal view showed.
  const seen = [];
  slot.attach("goal", { id: "c", workspaceId: "ws" }, { Content: "G", icon: GoalIcon, title: "目标", onPanelClosed: (g) => seen.push(g) });
  slot.panelClosed("c", undefined);
  check("a panel closed without the goal view on screen records nothing", seen.length, 0);
  const done = goal({ phase: "complete" });
  slot.panelClosed("c", done);
  check("a panel closed after the goal view showed reports that goal", seen[0], done);
  slot.dispose();
  check("dispose removes every remaining registration", regs.slice(1).every((reg) => reg.removed === 1), true);
}

/* The panel and pill wiring of the slot (source pins) ----------------------- */

console.log("\nthe slot is wired as one registration with one fixed panel");
{
  const repoRoot = path.resolve(__dirname, "..", "..");
  const readRepo = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
  const pill = readRepo("paseo-plugin/client/goal-pill.tsx");
  const jobs = readRepo("paseo-plugin/client/jobs-pill.tsx");
  const index = readRepo("paseo-plugin/index.client.tsx");
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert("the goal half registers no composer pill of its own", !/addComposerPill\(/.test(code(pill).replace(/addComposerPill: \(contribution\) => client\.addComposerPill\(contribution\)/, "")));
  assert("the jobs half registers no composer pill of its own", !/addComposerPill\(/.test(code(jobs)));
  assert("the old per-half ids are gone", !/"dsh-goal"|"dsh-jobs"/.test(code(pill) + code(jobs)));
  assert("the goal half reports to the slot", /slot\.presentGoal\(agentId,/.test(pill) && /slot\.attach\("goal"/.test(pill));
  assert("the jobs half reports to the slot", /slot\.presentJobs\(agentId,/.test(jobs) && /slot\.attach\("jobs"/.test(jobs));
  assert("the jobs half reports its own visibility unchanged", /visible: presentation\.visible,\s*live: presentation\.label\.kind === "live"/.test(jobs));
  assert("the client entry creates one slot and hands it to both halves",
    /createGoalJobsPluginSlot\(client\)/.test(index) && /contributeJobsPill\(client, goalJobsSlot\)/.test(index) && /contributeGoalPill\(client, goalJobsSlot\)/.test(index));
  assert("the panel switches views with its own state, not through the registration",
    /onPress=\{\(\) => setChosen\(other\)\}/.test(pill));
  const panel = pill.slice(pill.indexOf("export function makeGoalJobsPopover"), pill.indexOf("export function createGoalJobsPluginSlot"));
  assert("the panel never calls update or close itself", panel.length > 0 && !/\.update\(|close\(\)/.test(code(panel)));
  assert("the completed goal's seen mark waits for the panel's own unmount",
    /useEffect\(\(\) => \(\) => slot\.panelClosed\(agentId, goalShown\.current\), \[\]\)/.test(panel));
}

/* The poll cadence is the jobs pill's ---------------------------------------- */

console.log("\nthe poll cadence matches the jobs pill's");
{
  // Frozen numbers: the two pills share one policy (DESIGN §2), so a change here
  // that is not a change there is a red check, not a silent divergence.
  equal("the base interval is four seconds", LIVE_POLL_MS, 4000);
  equal("the backoff ceiling is thirty seconds", MAX_POLL_MS, 30_000);
  equal("the initial jitter is one second", INITIAL_POLL_JITTER_MS, 1000);
  equal("the jitter cap is two seconds", MAX_POLL_JITTER_MS, 2000);
  equal("a readable answer polls at the base rate", nextPollDelayMs(0, () => 0), LIVE_POLL_MS);
  equal("the first failure backs off to 8s", nextPollDelayMs(1, () => 0), 8000);
  equal("the second failure backs off to 16s", nextPollDelayMs(2, () => 0), 16_000);
  equal("the third failure hits the cap", nextPollDelayMs(3, () => 0), MAX_POLL_MS);
  equal("the first poll is jittered", initialPollDelayMs(() => 0.5), Math.floor(0.5 * INITIAL_POLL_JITTER_MS));
}

/* The controller, driven by a fake clock ------------------------------------- */

async function runControllerChecks() {
  function createFakeClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    return {
      setTimeout(fn, delay) {
        const id = nextId;
        nextId += 1;
        timers.set(id, { at: now + delay, fn });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
      pendingDelays() {
        return [...timers.values()].map((timer) => timer.at - now).sort((left, right) => left - right);
      },
      async advance(ms) {
        const target = now + ms;
        for (;;) {
          let due = null;
          for (const [id, timer] of timers) {
            if (timer.at <= target && (due === null || timer.at < due.at)) due = { id, at: timer.at, fn: timer.fn };
          }
          if (due === null) break;
          timers.delete(due.id);
          now = due.at;
          due.fn();
          // Let the poll's promise chain and its next schedule land before the
          // loop looks for the next due timer.
          await new Promise((resolve) => setImmediate(resolve));
          await new Promise((resolve) => setImmediate(resolve));
        }
        now = target;
      },
    };
  }

  /** The provider id the pill registers for; a wire value, frozen on purpose. */
  const AGENT = { id: "a", workspaceId: "ws", provider: "deepseek-harness-native" };

  function createPollerHarness(overrides = {}) {
    const clock = createFakeClock();
    const calls = { added: [], removed: [], states: [], errors: [], pages: [], reads: 0 };
    const host = {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: overrides.random ?? (() => 0),
      readGoal:
        overrides.readGoal ??
        (async () => {
          calls.reads += 1;
          return { available: true, goal: null };
        }),
      listAgentPage:
        overrides.listAgentPage ??
        (async (cursor) => {
          calls.pages.push(cursor);
          return { entries: [], pageInfo: { hasMore: false, nextCursor: null } };
        }),
      addAgent(agent) {
        calls.added.push(agent.id);
      },
      removeAgent(agentId, reason, error) {
        calls.removed.push([agentId, reason, error === undefined ? undefined : error.code]);
      },
      publishState(agentId, state) {
        calls.states.push([agentId, state]);
      },
      onError(message, error) {
        calls.errors.push([message, error instanceof Error ? error.message : error]);
      },
    };
    const poller = createGoalPoller(host);
    return { clock, calls, poller };
  }

  async function registerOne(harness) {
    await harness.poller.applySnapshot({
      entries: [{ agent: AGENT }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    // The initial delay is jittered; random() = 0 makes it zero.
    await harness.clock.advance(0);
  }

  console.log("\npoll controller: one publish per change, none per unchanged answer");
  {
    const harness = createPollerHarness();
    await registerOne(harness);
    equal("the first answer publishes once", harness.calls.states.length, 1);
    equal("…and it is an empty goal, not a failure", harness.calls.states[0]?.[1]?.goal, null);
    check("…reported as readable", harness.calls.states[0]?.[1]?.available === true, true);
    await harness.clock.advance(LIVE_POLL_MS);
    equal("an unchanged answer is not republished", harness.calls.states.length, 1);
    equal("…but the read happened", harness.calls.reads, 2);
    harness.poller.dispose();
  }

  console.log("\npoll controller: a transient failure keeps the last state");
  {
    let answer = { available: true, goal: goal() };
    const harness = createPollerHarness({
      readGoal: async () => {
        harness.calls.reads += 1;
        return answer;
      },
    });
    await registerOne(harness);
    equal("the active goal is published", harness.calls.states.length, 1);
    answer = { available: false, error: { message: "one flaky poll", code: "rpc_failed" } };
    await harness.clock.advance(LIVE_POLL_MS);
    equal("a transient failure publishes nothing", harness.calls.states.length, 1);
    equal("the goal stays on screen (not replaced by an error)", harness.calls.states[0]?.[1]?.goal?.phase, "active");
    answer = { available: true, goal: goal() };
    // The failure backed off to 8 s; the same answer as the last published one
    // must still not republish, because the failed poll never overwrote it.
    await harness.clock.advance(8000);
    equal("an unchanged answer after the failure is not republished", harness.calls.states.length, 1);
    answer = { available: true, goal: goal({ roundsStarted: 4 }) };
    await harness.clock.advance(LIVE_POLL_MS);
    equal("a changed answer publishes", harness.calls.states.length, 2);
    equal("…with the new round count", harness.calls.states[1]?.[1]?.goal?.roundsStarted, 4);
    harness.poller.dispose();
  }

  console.log("\npoll controller: a terminal code removes the pill and stops polling");
  for (const code of ["bridge_too_old", "goal_unavailable"]) {
    let answer = { available: true, goal: goal() };
    const harness = createPollerHarness({
      readGoal: async () => {
        harness.calls.reads += 1;
        return answer;
      },
    });
    await registerOne(harness);
    answer = { available: false, error: { message: "terminal", code } };
    await harness.clock.advance(LIVE_POLL_MS);
    equal(`${code} removes the agent's pill`, harness.calls.removed, [["a", "terminal", code]]);
    const readsAfterTerminal = harness.calls.reads;
    await harness.clock.advance(MAX_POLL_MS * 3);
    equal(`${code} stops the timer`, harness.calls.reads, readsAfterTerminal);
    equal(`${code} leaves no pending timer`, harness.clock.pendingDelays().length, 0);
    harness.poller.dispose();
  }

  console.log("\npoll controller: a transient code keeps retrying with backoff");
  {
    let answer = { available: false, error: { message: "not open yet", code: "session_missing" } };
    const harness = createPollerHarness({
      readGoal: async () => {
        harness.calls.reads += 1;
        return answer;
      },
    });
    await registerOne(harness);
    equal("a session_missing read removes nothing", harness.calls.removed, []);
    equal("…and publishes nothing (last state kept)", harness.calls.states.length, 0);
    equal("…and schedules the 8 s backoff", harness.clock.pendingDelays(), [8000]);
    answer = { available: true, goal: goal() };
    await harness.clock.advance(8000);
    equal("the next successful read publishes", harness.calls.states.length, 1);
    equal("…the goal", harness.calls.states[0]?.[1]?.goal?.phase, "active");
    harness.poller.dispose();
  }

  console.log("\npoll controller: pollNow refreshes out of band");
  {
    let answer = { available: true, goal: goal() };
    const harness = createPollerHarness({
      readGoal: async () => {
        harness.calls.reads += 1;
        return answer;
      },
    });
    await registerOne(harness);
    equal("the initial answer publishes", harness.calls.states.length, 1);
    answer = { available: true, goal: goal({ phase: "paused" }) };
    await harness.poller.pollNow("a");
    equal("pollNow reads immediately", harness.calls.reads, 2);
    equal("pollNow publishes the new phase", harness.calls.states.length, 2);
    equal("…paused", harness.calls.states[1]?.[1]?.goal?.phase, "paused");
    await harness.poller.pollNow("a");
    equal("an unchanged pollNow does not republish", harness.calls.states.length, 2);
    harness.poller.dispose();
  }

  console.log("\npoll controller: agents outside this provider are not registered");
  {
    const harness = createPollerHarness();
    await harness.poller.applySnapshot({
      entries: [
        { agent: { id: "foreign", workspaceId: "ws", provider: "claude-code" } },
        { agent: { id: "no-workspace", provider: "deepseek-harness-native" } },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await harness.clock.advance(0);
    equal("no pill for another provider's agent", harness.calls.added, []);
    equal("no read for it either", harness.calls.reads, 0);
    harness.poller.dispose();
  }

  console.log("\npoll controller: a closed agent is dropped");
  {
    const harness = createPollerHarness();
    await registerOne(harness);
    harness.poller.upsert({ ...AGENT, status: "closed" });
    equal("a closed agent's pill is removed", harness.calls.removed.map((row) => row[1]), ["gone"]);
    harness.poller.dispose();
  }
}

(async () => {
  await runControllerChecks();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`${failures} FAILED`);
    process.exitCode = 1;
    return;
  }
  console.log("OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
