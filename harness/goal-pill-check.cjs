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
 * The popover's "closed" is **confirmed, not assumed** (UI-v7 fix): the host
 * unmounts and remounts the body once when the panel opens, so
 * `client/seen-close-gate.ts` — shared with the team pill — reports a close only
 * when the unmount outlives its window. Its behaviour is asserted in
 * `harness/team-pill-check.cjs` and `harness/goal-popover-render-check.cjs`; the
 * pins below hold the goal wiring and forbid a second copy.
 *
 * The persisted "seen" document (UI-v7 persistence, 2026-11-08) is asserted
 * here too: a confirmed close writes `agentId -> goalSeenKey` into host-scoped
 * plugin settings, a fresh controller over the same document (the app restart)
 * hydrates it and keeps a completed goal hidden, a failed read degrades to the
 * old in-memory behaviour, a failed write never throws, and the only write path
 * is `advanceSeen`'s confirmed-close branch (polls never write).
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
const { createSeenPersistence } = require("./client/seen-persistence.js");
const { SEEN_SETTINGS_LIMIT, seenMapOf, mergeSeenValues } = require("./shared/seen-settings.js");
const { defineTeamSeenSettings } = require("./shared/team-seen-settings.js");
const { defineGoalSeenSettings } = require("./shared/goal-seen-settings.js");
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
  // Merely observing a complete goal — while the completing turn still runs,
  // after it idles, or while a later turn runs — is not "seen". Only the user
  // opening and closing its panel is. The completing turn's own running→idle
  // and the next message's idle→running must both leave the pill visible.
  const running = step({}, { kind: "goal", goal: done });
  equal("observing complete while running records nothing", running, {});
  const idled = step(running, { kind: "agent", status: "idle" });
  equal("the completing turn's running→idle is not seen", idled.seen, undefined);
  equal("…and the next running (a new message) is not seen either", step(idled, { kind: "agent", status: "running" }).seen, undefined);
  equal("a repeated running before idle is not seen", step(running, { kind: "agent", status: "running" }).seen, undefined);
  // First observed while already idle (the completing turn ended between polls).
  const lateIdle = step({}, { kind: "goal", goal: done });
  equal("a completion first observed while idle records nothing", lateIdle, {});
  equal("…and the next running still does not mark it seen", step(lateIdle, { kind: "agent", status: "running" }).seen, undefined);
  // Closing the opened panel marks it seen at once.
  equal("closing the complete panel marks it seen", step(running, { kind: "closed", goal: done }), { seen: "goal-1:1" });
  equal("closing a non-complete panel marks nothing", step({}, { kind: "closed", goal: goal() }).seen, undefined);
  // A new key is shown again; the old key stays remembered.
  const seen = { seen: "goal-1:1" };
  equal("the seen key survives repeated polls", step(seen, { kind: "goal", goal: done }), seen);
  equal(
    "a new revision is not hidden by the old key",
    step(seen, { kind: "goal", goal: { ...done, revision: 2 } }).seen,
    "goal-1:1",
  );
  check(
    "…and is shown until its own close is confirmed",
    goalPillPresentation({ available: true, goal: { ...done, revision: 2 } }, step(seen, { kind: "goal", goal: { ...done, revision: 2 } }).seen).visible,
    true,
  );
  // Leaving complete (cleared / replaced) keeps the key.
  equal("a cleared goal keeps a remembered key", step(seen, { kind: "goal", goal: null }), seen);
  equal("agent events without a watch change nothing", step({}, { kind: "agent", status: "running" }), {});
  // End to end with the presentation rule: after the completing turn idles and
  // the user sends the next message (running), the completed pill stays visible.
  const final = step(
    {},
    { kind: "goal", goal: done },
    { kind: "agent", status: "idle" },
    { kind: "agent", status: "running" },
  );
  check("after the next turn starts the pill is still visible", goalPillPresentation({ available: true, goal: done }, final.seen).visible, true);
  check("after the completed panel is closed the pill is hidden", goalPillPresentation({ available: true, goal: done }, step(final, { kind: "closed", goal: done }).seen).visible, false);
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
  // The pill's icon slot: the glyph always stays; running adds the corner ring
  // (`client/corner-ring.tsx`) instead of replacing the glyph. The rendered
  // half (glyph present, ring on the corner) is in
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

/* The goal and the jobs are two separate pills ------------------------------ */

console.log("\nthe goal and the jobs are two separate composer pills");
{
  // The shared goal/jobs slot (one registration per agent) was withdrawn on
  // 2026-11-05: each half registers its own pill again, under its own id, from
  // its own contribution. These pins fail if either half stops registering, if
  // the two ids collapse into one, or if a coordinator comes back.
  const repoRoot = path.resolve(__dirname, "..", "..");
  const readRepo = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const pill = code(readRepo("paseo-plugin/client/goal-pill.tsx"));
  const jobs = code(readRepo("paseo-plugin/client/jobs-pill.tsx"));
  const index = code(readRepo("paseo-plugin/index.client.tsx"));
  const idsOf = (source) => [...source.matchAll(/addComposerPill\(\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1]);
  equal("the goal pill registers exactly one pill, id dsh-goal", idsOf(pill), ["dsh-goal"]);
  equal("the jobs pill registers exactly one pill, id dsh-jobs", idsOf(jobs), ["dsh-jobs"]);
  assert("the goal pill opens its own goal popover", /behavior:\s*\{\s*kind:\s*"popover",\s*Content:\s*makeGoalPopover\(/.test(pill));
  assert("the jobs pill opens its own jobs popover", /behavior:\s*\{\s*kind:\s*"popover",\s*Content:\s*makeJobsPopover\(store, agent\.id\)\s*\}/.test(jobs));
  assert("closing the goal popover marks a completed goal seen", /advanceSeen\(agent\.id, \{ kind: "closed", goal \}\)/.test(pill));
  assert(
    "…only for the pill the close belongs to (a stale close is dropped)",
    /if \(pills\.get\(agent\.id\) !== registration\) return;/.test(pill),
  );
  assert("the client entry contributes the three pills on their own",
    /contributeJobsPill\(client\),/.test(index) &&
      /contributeGoalPill\(client\),/.test(index) &&
      /contributeTeamPill\(client\),/.test(index));
  assert("…with no deference reference left",
    !/deference|PillDeference|createPillDeference|pill-deference/.test(index));
  assert("…and the coordinator module is gone",
    !fs.existsSync(path.join(repoRoot, "paseo-plugin/client/pill-deference.ts")));
  assert("the goal pill takes only the client", /export function contributeGoalPill\(client: PluginClientContext\)/.test(pill));
  assert("the jobs pill takes only the client", /export function contributeJobsPill\(client: PluginClientContext\)/.test(jobs));
  assert("the team pill takes only the client",
    /export function contributeTeamPill\(client: PluginClientContext\)/.test(code(readRepo("paseo-plugin/client/team-pill.tsx"))));
  // Assembled from fragments so a repo-wide grep for the withdrawn names finds
  // nothing in this file either (the pin itself is not a use).
  const gj = ["goal", "jobs"].join("-");
  const withdrawn = new RegExp([`${gj}-slot`, "Goal" + "JobsSlot", `dsh-${gj}`, `${gj}-switch`].join("|"));
  assert("no shared slot coordinator is wired", !withdrawn.test(pill + jobs + index));
  assert("the coordinator module is gone",
    !fs.existsSync(path.join(repoRoot, `paseo-plugin/client/${gj}-slot.ts`)));
}

/* The popover's close is confirmed (UI-v7 fix) ------------------------------- */

console.log("\nthe goal popover's close is confirmed, not assumed");
{
  // The desktop completed-goal pill vanished the moment it was opened: the host
  // unmounts and remounts the popover body once when the surface's position
  // lands (`menu-overlay.tsx:350`, `key={placed ? "placed" : "measuring"}`), and
  // the old `useEffect(() => () => onClosed(...))` read that as a user close.
  // The rule is the shared gate (`client/seen-close-gate.ts`), also used by the
  // team pill; its behaviour is asserted in `harness/team-pill-check.cjs` and
  // `harness/goal-popover-render-check.cjs`, the wiring here.
  const repoRoot = path.resolve(__dirname, "..", "..");
  const readRepo = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const pill = code(readRepo("paseo-plugin/client/goal-pill.tsx"));
  const teamPill = code(readRepo("paseo-plugin/client/team-pill.tsx"));
  assert("the goal popover's close goes through the shared gate",
    /createSeenCloseGate<GoalState>\(\{/.test(pill) && /gate\.mounted\(\)/.test(pill) && /gate\.unmounted\(shown\.current\)/.test(pill));
  assert("…and is imported, not copied, from ./seen-close-gate", /from "\.\/seen-close-gate"/.test(pill));
  assert("…the old unmount-is-a-close effect is gone", !/useEffect\(\(\) => \(\) => onClosed\(/.test(pill));
  assert("no pill file re-implements the gate", !/function createSeenCloseGate/.test(pill + teamPill));
  assert("present publishes only a real change (visible/label/title)",
    /before\.visible === presentation\.visible && before\.label === label && before\.title === title/.test(pill));
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

  /**
   * The 2026-11-09 regression: "目标完成点击后，等会又有 pill 按钮了".
   *
   * The user closed a completed goal's panel, the confirmed close wrote its
   * `id:revision` into the host settings and the pill hid — and a few seconds
   * later it was back. Two client-side memories could lose that fact:
   *
   * 1. a websocket reconnect delivers a fresh directory snapshot, and
   *    `applySnapshot` used to remove *every* agent and re-register the listing
   *    (this drive's first half);
   * 2. the removal path itself used to call the persistence controller's
   *    `forget`, which masked the *persisted* key too — so any removal
   *    (a snapshot rebuild, a permission retry, a terminal recovery) made the
   *    completed state unseen again (the second half, after the snapshot rule
   *    was already a diff).
   *
   * This drives the full wiring (poll controller + seen machine + persisted
   * fallback + the host's visible flag) through that exact sequence: the
   * snapshot that still lists the agent must not remove anything, the completed
   * pill must stay hidden across the reconnect, a changed poll answer must not
   * un-hide it, and the persisted key must outlive a real removal.
   */
  console.log("\npoll controller: a snapshot refresh keeps a closed completed goal hidden");
  {
    const clock = createFakeClock();
    const COMPLETE = goal({ phase: "complete", activation: "disarmed", revision: 3 });
    const KEY = goalSeenKey(COMPLETE);
    // The host's settings document, in memory, through the real controller.
    const document = { revision: "rev-1", values: { seen: {} } };
    const persistence = createSeenPersistence({
      read: async () => ({
        status: "ready",
        revision: document.revision,
        values: JSON.parse(JSON.stringify(document.values)),
      }),
      write: async ({ values }) => {
        document.revision = "rev-2";
        document.values = values;
        return { status: "saved", revision: document.revision, values: document.values };
      },
      onError: () => {},
    });
    await persistence.hydrate();

    /** agentId -> the completed goal's in-session seen progress (`seenStates`). */
    const seenStates = new Map();
    /** agentId -> the last poll answer (`answers`). */
    const answers = new Map();
    /** Every host-facing event, in order: registration, removal, publish, visibility. */
    const events = [];
    /** The answer the daemon currently gives; a poll change is a new object. */
    let answer = { available: true, goal: COMPLETE };
    /** What the pill's `present()` would publish for the current state. */
    const present = (agentId) => {
      const current = answers.get(agentId);
      if (current === undefined) return;
      const seen = seenStates.get(agentId)?.seen ?? persistence.get(agentId);
      const presentation = goalPillPresentation(current, seen);
      events.push(["visible", presentation.visible]);
    };

    const poller = createGoalPoller({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0,
      readGoal: async () => answer,
      listAgentPage: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      addAgent(agent) {
        events.push(["add", agent.id]);
        seenStates.delete(agent.id);
        answers.delete(agent.id);
      },
      removeAgent(agentId) {
        events.push(["remove", agentId]);
        // The pill's removal path: the in-session memory only. The persisted
        // key survives on purpose (2026-11-09) — it is content-addressed.
        seenStates.delete(agentId);
        answers.delete(agentId);
      },
      publishState(agentId, state) {
        events.push(["publish", agentId]);
        answers.set(agentId, state);
        present(agentId);
      },
      onError() {},
    });

    const snapshot = () =>
      poller.applySnapshot({
        entries: [{ agent: AGENT }],
        pageInfo: { hasMore: false, nextCursor: null },
      });

    await snapshot();
    await clock.advance(0);
    equal(
      "the unseen completed goal is registered, polled and shown once",
      events,
      [["add", "a"], ["publish", "a"], ["visible", true]],
    );

    // The user opens the panel, closes it, and `seen-close-gate` confirms it:
    // the seen machine records the key, `advanceSeen` persists it and re-presents.
    seenStates.set("a", goalCompleteSeenStep(seenStates.get("a") ?? {}, { kind: "closed", goal: COMPLETE }));
    persistence.remember("a", seenStates.get("a").seen);
    present("a");
    equal("the confirmed close hides the completed pill", events.at(-1), ["visible", false]);
    equal("…and the key reached the host document", persistence.get("a"), KEY);

    // The reconnect: same directory, fresh snapshot. Nothing was removed, so
    // the registration and the remembered key are still there.
    await snapshot();
    equal("a reconnect snapshot removes no agent that is still listed", events.filter((row) => row[0] === "remove"), []);
    equal("…and registers nothing twice", events.filter((row) => row[0] === "add").length, 1);
    equal("…the persisted key survives the snapshot", persistence.get("a"), KEY);

    // The next poll after the reconnect: the goal is unchanged, so the poll
    // publishes nothing and the pill stays hidden. A re-registered pill has no
    // publish signature and would show itself again here.
    const publishesAfterClose = events.filter((row) => row[0] === "publish").length;
    await clock.advance(LIVE_POLL_MS);
    equal("an unchanged answer after the reconnect publishes nothing", events.filter((row) => row[0] === "publish").length, publishesAfterClose);
    equal("the completed pill stays hidden across the reconnect", events.at(-1), ["visible", false]);

    // A poll whose **answer changed** does republish (the dedupe cannot hide
    // this one), so the seen path itself has to keep the pill hidden: same
    // completed revision, only its "now" line moved.
    answer = { available: true, goal: { ...COMPLETE, currentTask: "still shipping" } };
    await clock.advance(LIVE_POLL_MS);
    equal(
      "a changed answer after the reconnect is published again",
      events.filter((row) => row[0] === "publish").length,
      publishesAfterClose + 1,
    );
    equal("…and the same completed revision stays hidden", events.at(-1), ["visible", false]);
    equal(
      "…no poll ever shows it again after the close",
      events.filter((row) => row[0] === "visible").map((row) => row[1]),
      [true, false, false],
    );

    // A real removal drops the in-session state and keeps the persisted key:
    // the same completed revision the user already closed stays hidden after a
    // re-add, while anything new has a new key (`goalSeenKey`).
    poller.drop("a");
    equal("a real removal keeps the persisted key (content-addressed)", persistence.get("a"), KEY);
    poller.upsert(AGENT);
    await clock.advance(0);
    equal("…so the re-added pill stays hidden for the same revision", events.at(-1), ["visible", false]);
    answer = { available: true, goal: { ...COMPLETE, revision: 4 } };
    await clock.advance(LIVE_POLL_MS);
    equal("…while a new revision is a new key and shows again", events.at(-1), ["visible", true]);
    poller.dispose();
    persistence.dispose();
  }

  console.log("\npoll controller: a snapshot removes only the agents that left");
  {
    const B = { id: "b", workspaceId: "ws", provider: "deepseek-harness-native" };
    const harness = createPollerHarness();
    await harness.poller.applySnapshot({
      entries: [{ agent: AGENT }, { agent: B }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    equal("both agents are registered", harness.calls.added, ["a", "b"]);
    await harness.poller.applySnapshot({
      entries: [{ agent: AGENT }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    equal("an agent the snapshot no longer lists is removed", harness.calls.removed, [["b", "gone", undefined]]);
    equal("…and the surviving agent keeps its registration", harness.calls.added, ["a", "b"]);
    equal("…leaving exactly one poll timer", harness.clock.pendingDelays().length, 1);
    harness.poller.dispose();
  }

  console.log("\npoll controller: an upsert during pagination is not removed by the diff");
  {
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const harness = createPollerHarness({
      listAgentPage: async () => {
        await gate;
        return { entries: [{ agent: AGENT }], pageInfo: { hasMore: false, nextCursor: null } };
      },
    });
    const snapshot = harness.poller.applySnapshot({
      entries: [{ agent: AGENT }],
      pageInfo: { hasMore: true, nextCursor: "cursor-1" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    // The host pushes a brand-new agent while page two is still in flight.
    harness.poller.upsert({ id: "new-agent", workspaceId: "ws", provider: "deepseek-harness-native" });
    release();
    await snapshot;
    equal("the agent pushed mid-snapshot is not removed", harness.calls.removed, []);
    equal("…and keeps the pill the upsert gave it", harness.calls.added, ["a", "new-agent"]);
    harness.poller.dispose();
  }

  console.log("\npoll controller: the older snapshot's completion does not close the newer one's window");
  {
    // A reconnect can start a second snapshot while the first one is still
    // paginating. The **older** one finishes first; its `finally` must not clear
    // the collection window the newer one is still filling (P3-2). The guard is
    // `inflightListed === listed`: without it, an `upsert` landing in the gap
    // between the two completions is dropped from the newer snapshot's retention
    // set and its pill is removed at the end of that snapshot.
    let releaseOlder = () => {};
    let releaseNewer = () => {};
    const olderPage = new Promise((resolve) => {
      releaseOlder = resolve;
    });
    const newerPage = new Promise((resolve) => {
      releaseNewer = resolve;
    });
    const harness = createPollerHarness({
      listAgentPage: async (cursor) => {
        await (cursor === "cursor-a" ? olderPage : newerPage);
        return { entries: [{ agent: AGENT }], pageInfo: { hasMore: false, nextCursor: null } };
      },
    });
    const older = harness.poller.applySnapshot({
      entries: [{ agent: AGENT }],
      pageInfo: { hasMore: true, nextCursor: "cursor-a" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const newer = harness.poller.applySnapshot({
      entries: [{ agent: AGENT }],
      pageInfo: { hasMore: true, nextCursor: "cursor-b" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseOlder();
    await older;
    // The host pushes a new agent after the older snapshot ended but while the
    // newer one is still collecting: only the newer window may accept it.
    harness.poller.upsert({ id: "new-agent", workspaceId: "ws", provider: "deepseek-harness-native" });
    releaseNewer();
    await newer;
    equal("the agent pushed inside the newer snapshot's window is not removed", harness.calls.removed, []);
    equal("…and keeps its pill", harness.calls.added, ["a", "new-agent"]);
    harness.poller.dispose();
  }

  console.log("\npoll controller: a reconnect snapshot revives a terminal pill");
  {
    let answer = { available: false, error: { message: "reload the plugin", code: "bridge_too_old" } };
    const harness = createPollerHarness({
      readGoal: async () => {
        harness.calls.reads += 1;
        return answer;
      },
    });
    await registerOne(harness);
    equal("the terminal code removes the pill", harness.calls.removed, [["a", "terminal", "bridge_too_old"]]);
    equal("…and stops the timer", harness.clock.pendingDelays(), []);
    // A bare upsert says nothing about the runtime: it must not restart the
    // failing loop (the rule `harness/jobs-poll-check.cjs` also pins).
    harness.poller.upsert(AGENT);
    equal("a bare upsert does not re-register a terminal agent", harness.calls.added, ["a"]);
    equal("…and schedules nothing", harness.clock.pendingDelays(), []);
    // The directory snapshot is the host re-describing the world after a
    // reconnect, when a plugin reload may have fixed the bridge: it rebuilds.
    answer = { available: true, goal: goal({ phase: "complete", revision: 3 }) };
    await harness.poller.applySnapshot({
      entries: [{ agent: AGENT }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    equal("a reconnect snapshot re-registers the terminal agent", harness.calls.added, ["a", "a"]);
    await harness.clock.advance(0);
    equal("…it reads the goal again", harness.calls.reads, 2);
    equal("…and publishes the real answer", harness.calls.states.at(-1)?.[1]?.goal?.phase, "complete");
    harness.poller.dispose();
  }
}

/**
 * The persisted "seen" document (UI-v7 persistence, 2026-11-08): a confirmed
 * close writes one `agentId -> goalSeenKey` entry to the host's plugin settings,
 * and a *new controller over the same document* — the app restart — hydrates it
 * and keeps the completed goal hidden. A load failure degrades to the old
 * in-memory behaviour (show once more); a write failure keeps this session
 * correct and never throws. The document rules themselves are shared with the
 * team pill and driven here for the goal id.
 */
async function seenPersistenceChecks() {
  console.log("\nthe persisted \"seen\" document (UI-v7 persistence, 2026-11-08)");
  const complete = goal({ phase: "complete", activation: "disarmed" });
  const completeNewer = goal({ phase: "complete", revision: 2 });
  const KEY = goalSeenKey(complete);
  const hidden = (seen) => goalPillPresentation({ available: true, goal: complete }, seen).visible === false;
  const visible = (seen) => goalPillPresentation({ available: true, goal: complete }, seen).visible === true;

  /** A fake host: one in-memory settings file; the revision hashes the raw bytes. */
  const fakeHost = (initial = null) => {
    let raw = initial === null ? null : JSON.stringify(initial);
    const revision = () => (raw === null ? "missing" : `rev:${raw}`);
    const io = {
      writes: [],
      resetCalls: 0,
      warned: [],
      failRead: false,
      failWrite: false,
      failReset: false,
      resetHangs: false,
      resetConflict: false,
      readInvalid: false,
      alwaysConflict: false,
      read: async () => {
        if (io.failRead) throw new Error("unknown method settings.goal-pill-seen.read");
        if (io.readInvalid) return { status: "invalid", revision: revision(), error: "a document this schema refuses" };
        return { status: "ready", revision: revision(), values: raw === null ? {} : JSON.parse(raw) };
      },
      write: async (input) => {
        io.writes.push(input);
        if (io.alwaysConflict) return { status: "conflict", error: "Settings changed on another client." };
        if (io.failWrite) throw new Error("settings write failed");
        if (input.revision !== revision()) return { status: "conflict", error: "Settings changed on another client." };
        raw = JSON.stringify(input.values);
        return { status: "saved", revision: revision(), values: input.values };
      },
      /** The host's repair write: replaces the document without parsing the envelope. */
      reset: async (input) => {
        io.resetCalls += 1;
        // A host that never answers: hydrate must still finish via the timeout.
        if (io.resetHangs) return new Promise(() => undefined);
        if (io.failReset) throw new Error("reset failed");
        if (io.resetConflict) {
          // Another client repaired the file while this reset was in flight.
          raw = JSON.stringify({ seen: { "other-agent": "goal-9:3" } });
          return { status: "conflict", error: "Settings changed on another client." };
        }
        if (input.revision !== revision()) return { status: "conflict", error: "Settings changed on another client." };
        raw = JSON.stringify({ seen: {} });
        return { status: "saved", revision: revision(), values: { seen: {} } };
      },
      warn: (message) => io.warned.push(message),
      document: () => (raw === null ? {} : JSON.parse(raw)),
      externalWrite: (values) => {
        raw = JSON.stringify(values);
      },
    };
    return io;
  };

  // The document's pure rules: untrusted JSON normalises to a bounded map.
  equal("a non-object document is an empty map", seenMapOf(42), {});
  equal("non-string and empty entries are dropped", seenMapOf({ a: "k", b: 3, "": "k", c: "" }), { a: "k" });
  const many = {};
  for (let index = 0; index < SEEN_SETTINGS_LIMIT + 3; index += 1) many[`agent-${String(index)}`] = `goal-${String(index)}:1`;
  const capped = seenMapOf(many);
  equal("the document is capped", Object.keys(capped).length, SEEN_SETTINGS_LIMIT);
  equal("…keeping the newest entry", capped[`agent-${String(SEEN_SETTINGS_LIMIT + 2)}`], `goal-${String(SEEN_SETTINGS_LIMIT + 2)}:1`);
  equal("…and dropping the oldest", capped["agent-0"], undefined);
  equal(
    "merge keeps stored agents and lets pending win",
    mergeSeenValues({ a: "old", b: "kept" }, new Map([["a", "new"]])),
    { a: "new", b: "kept" },
  );

  // Restart semantics: the entry a close wrote is hydrated by the next bundle.
  {
    const first = fakeHost();
    const before = createSeenPersistence(first);
    await before.hydrate();
    equal("nothing is remembered before any close", before.get("agent-1"), undefined);
    equal("…and the completed goal is visible", visible(before.get("agent-1")), true);
    equal("hydrating never writes the document", first.writes.length, 0);
    before.remember("agent-1", KEY);
    await before.flush();
    equal("the confirmed close wrote the document", first.document(), { seen: { "agent-1": KEY } });

    // "Restart": the client bundle runs again and hydrates the same host file.
    const after = createSeenPersistence(fakeHost(first.document()));
    await after.hydrate();
    equal("a restart remembers the closed goal", after.get("agent-1"), KEY);
    equal("…so the same completed goal stays hidden", hidden(after.get("agent-1")), true);
    equal("…a new revision shows it again", goalPillPresentation({ available: true, goal: completeNewer }, after.get("agent-1")).visible, true);
  }

  // A failed read (older host without the settings RPC) is the old behaviour.
  {
    const broken = fakeHost();
    broken.failRead = true;
    const persistence = createSeenPersistence(broken);
    await persistence.hydrate();
    equal("a failed read still becomes ready", persistence.ready(), true);
    equal("…with nothing remembered", persistence.get("agent-1"), undefined);
    equal("…so the completed goal shows once more", visible(persistence.get("agent-1")), true);
    persistence.remember("agent-1", KEY);
    await persistence.flush();
    equal("…and a write without a revision does not throw", persistence.get("agent-1"), KEY);
  }

  // A failed write keeps the session's answer and never throws.
  {
    const broken = fakeHost();
    broken.failWrite = true;
    const persistence = createSeenPersistence(broken);
    await persistence.hydrate();
    persistence.remember("agent-1", KEY);
    await persistence.flush();
    equal("a failed write keeps the in-memory seen", persistence.get("agent-1"), KEY);
    equal("…so the pill stays hidden this session", hidden(persistence.get("agent-1")), true);
  }

  // Conflict: another client wrote meanwhile — re-read, merge, keep its agents.
  {
    const concurrent = fakeHost();
    const persistence = createSeenPersistence(concurrent);
    await persistence.hydrate();
    concurrent.externalWrite({ seen: { "other-agent": "goal-9:3" } });
    persistence.remember("agent-1", KEY);
    await persistence.flush();
    equal("a conflicted write is retried once", concurrent.writes.length, 2);
    equal("…and the other client's agent is kept", concurrent.document(), {
      seen: { "other-agent": "goal-9:3", "agent-1": KEY },
    });
    equal("…and a retry that succeeds does not warn", concurrent.warned.length, 0);
  }

  // A silent host must not hold the first publish forever.
  {
    const silent = fakeHost();
    silent.read = () => new Promise(() => undefined);
    const persistence = createSeenPersistence(silent, { timeoutMs: 5 });
    await persistence.flush();
    equal("a silent read times out into the old behaviour", persistence.ready(), true);
    equal("…with nothing remembered", persistence.get("agent-1"), undefined);
  }

  // A removal keeps the persisted key (2026-11-09): the signature is
  // content-addressed, so it can only hide the exact completed revision the user
  // closed. Masking it per session made every removal path (a snapshot rebuild,
  // a permission retry, a terminal recovery) show that revision again.
  {
    const removal = fakeHost({ seen: { "agent-1": KEY } });
    const persistence = createSeenPersistence(removal);
    await persistence.hydrate();
    equal("the document remembers a closed goal", persistence.get("agent-1"), KEY);
    equal("a removed pill keeps the persisted key (no per-session mask)", persistence.get("agent-1"), KEY);
    equal("…so the same completed revision stays hidden after a re-add", hidden(persistence.get("agent-1")), true);
    persistence.remember("agent-1", goalSeenKey(completeNewer));
    await persistence.flush();
    equal("a new confirmed close overwrites the entry", persistence.get("agent-1"), goalSeenKey(completeNewer));
    equal("…and the older completed revision is visible again", visible(persistence.get("agent-1")), true);
  }

  // P2-1: a document the host refuses (`invalid`: an older version's envelope, a
  // corrupt file) is repaired by the host's `reset` — a `save` would re-parse the
  // same envelope and be refused on every attempt, so the stale goal would show
  // once more after every app/plugin reload for the life of the file.
  {
    const repair = fakeHost();
    repair.readInvalid = true;
    const persistence = createSeenPersistence(repair);
    await persistence.hydrate();
    equal("an invalid document triggers exactly one reset", repair.resetCalls, 1);
    equal("…hydration continues with an empty map", persistence.get("agent-1"), undefined);
    equal("…so the completed goal is shown once", visible(persistence.get("agent-1")), true);
    persistence.remember("agent-1", KEY);
    await persistence.flush();
    equal("…and the next confirmed close writes normally", repair.writes.length, 1);
    equal("…into the repaired document", repair.document(), { seen: { "agent-1": KEY } });
  }
  {
    const refused = fakeHost();
    refused.readInvalid = true;
    refused.failReset = true;
    const persistence = createSeenPersistence(refused);
    await persistence.hydrate();
    equal("a refused reset does not throw", persistence.ready(), true);
    equal("…and was attempted once", refused.resetCalls, 1);
    equal("…and degrades to the empty map", persistence.get("agent-1"), undefined);
    equal("…so the goal is shown once more (the old behaviour)", visible(persistence.get("agent-1")), true);
  }
  {
    // The gate P2: a host that never answers the reset must not leave `ready`
    // false — that would keep present() from ever publishing and the pill would
    // never show again this session, the opposite of the degrade contract.
    const hung = fakeHost();
    hung.readInvalid = true;
    hung.resetHangs = true;
    const persistence = createSeenPersistence(hung, { timeoutMs: 5 });
    await persistence.flush();
    equal("a hanging reset still resolves hydrate inside the timeout", persistence.ready(), true);
    equal("…and was attempted once", hung.resetCalls, 1);
    equal("…with the empty map (old behaviour)", persistence.get("agent-1"), undefined);
    equal("…so the goal shows once more", visible(persistence.get("agent-1")), true);
  }
  {
    // A reset that answers `conflict` (another client repaired the file): the
    // next save re-reads the now-valid document and merges, keeping its entries.
    const heal = fakeHost();
    heal.readInvalid = true;
    heal.resetConflict = true;
    const persistence = createSeenPersistence(heal, { settingsId: "goal-pill-seen" });
    await persistence.hydrate();
    equal("a conflicting reset still finishes hydrate", persistence.ready(), true);
    equal("…until the next close nothing is remembered", persistence.get("agent-1"), undefined);
    equal("…and nothing was warned about", heal.warned.length, 0);
    // The other client's repair becomes readable: the next save self-heals.
    heal.readInvalid = false;
    persistence.remember("agent-1", KEY);
    await persistence.flush();
    equal("…the next save re-reads the repaired document", heal.writes.length, 2);
    equal("…and merges the other client's agent", heal.document(), {
      seen: { "other-agent": "goal-9:3", "agent-1": KEY },
    });
    equal("…without a conflict warning", heal.warned.length, 0);
  }

  // P2-2: a write still in conflict after its one retry warns once (diagnostic
  // only — settings id and agent ids, never the document) and keeps the pending
  // entry for the next confirmed close; there is no polling retry.
  {
    const stubborn = fakeHost();
    stubborn.alwaysConflict = true;
    const persistence = createSeenPersistence(stubborn, { settingsId: "goal-pill-seen" });
    await persistence.hydrate();
    persistence.remember("agent-1", KEY);
    await persistence.flush();
    equal("a conflicting write is attempted twice (one retry)", stubborn.writes.length, 2);
    equal("…then warns once", stubborn.warned.length, 1);
    assert("…naming the settings id", /goal-pill-seen/.test(stubborn.warned[0] ?? ""), stubborn.warned[0]);
    assert("…and the agent id", /agentId=agent-1/.test(stubborn.warned[0] ?? ""), stubborn.warned[0]);
    assert("…never the document contents", !/goal-1:1/.test(stubborn.warned[0] ?? ""), stubborn.warned[0]);
    equal("…while the memory keeps the seen state", persistence.get("agent-1"), KEY);
    equal("…so the pill stays hidden this session", hidden(persistence.get("agent-1")), true);
    persistence.remember("agent-1", KEY);
    await persistence.flush();
    equal("the next confirmed close retries the write", stubborn.writes.length, 4);
    equal("…but the warning is not repeated", stubborn.warned.length, 1);
  }

  // P2-3: run the real definitions (not just source regexes): id, scope, version
  // and normalisation are exactly what the host sees. A team/goal id swap in a
  // pill's IO wiring is pinned by the source checks below, and this half pins
  // the ids the definitions actually register.
  {
    const goalDefinition = defineGoalSeenSettings();
    equal("goal definition id", goalDefinition.id, "goal-pill-seen");
    equal("goal definition scope", goalDefinition.scope, "host");
    equal("goal definition version", goalDefinition.version, 1);
    const teamDefinition = defineTeamSeenSettings();
    equal("team definition id (not swapped)", teamDefinition.id, "team-pill-seen");
    equal("team definition scope", teamDefinition.scope, "host");
    equal("team definition version", teamDefinition.version, 1);
    const cases = [
      ["an empty document", {}, { seen: {} }],
      ["mixed value types", { seen: { a: 1, b: "x", "": "y", c: "" } }, { seen: { b: "x" } }],
      ["a garbage string", "nonsense", { seen: {} }],
      ["null", null, { seen: {} }],
    ];
    for (const [label, input, expected] of cases) {
      equal(`goal schema normalises ${label}`, await goalDefinition.schema.parseAsync(input), expected);
      equal(`team schema normalises ${label}`, await teamDefinition.schema.parseAsync(input), expected);
    }
  }

  // Sources: one write path only (the confirmed-close branch); polls never write.
  {
    const repo = path.resolve(__dirname, "..", "..");
    const pill = fs.readFileSync(path.join(repo, "paseo-plugin/client/goal-pill.tsx"), "utf8");
    assert("the pill hydrates the persisted seen state at load", /void persistence\.hydrate\(\)/.test(pill));
    assert("nothing is published before hydrate resolves", /if \(!persistence\.ready\(\)\) return;/.test(pill));
    assert(
      "the persisted fallback is read after the session's own seen state",
      /seenStates\.get\(agentId\)\?\.seen \?\? persistence\.get\(agentId\)/.test(pill),
    );
    assert(
      "the only write is advanceSeen's confirmed-close branch",
      /if \(event\.kind === "closed" && after\.seen !== undefined\) persistence\.remember\(agentId, after\.seen\);/.test(pill),
    );
    equal("persistence.remember appears exactly once", (pill.match(/persistence\.remember\(/g) ?? []).length, 1);
    const publishState = pill.slice(pill.indexOf("const publishState"), pill.indexOf("const poller"));
    assert("the poll path (publishState) never writes", !/persistence\.(remember|write)/.test(publishState));
    // Identifier checks run on comment-stripped source: the pills' comments name
    // the removed call (`forget`) to explain why it went, and a pin that cannot
    // tell code from prose would either fail on its own explanation or pass on
    // one (P3-7).
    const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert(
      "the removal path never calls the persisted-fallback forget",
      !/persistence\.forget\s*\(/.test(code(pill)),
    );
    const persistenceSource = code(
      fs.readFileSync(path.join(repo, "paseo-plugin/client/seen-persistence.ts"), "utf8"),
    );
    assert(
      "…because the controller has no forget member (interface or implementation)",
      !/\bforget\b/.test(persistenceSource),
    );
    assert(
      "the pill wires read/write/reset/warn against the goal settings id",
      /settingsRpc\(GOAL_SEEN_SETTINGS_ID\)\.read/.test(pill) &&
        /settingsRpc\(GOAL_SEEN_SETTINGS_ID\)\.write/.test(pill) &&
        /settingsRpc\(GOAL_SEEN_SETTINGS_ID\)\.reset/.test(pill) &&
        /warn: \(message\) => console\.warn/.test(pill),
    );
    assert("…and passes the goal settings id to the controller", /settingsId: GOAL_SEEN_SETTINGS_ID/.test(pill));
    assert("…never references the team settings id (a swap must fail)", !/TEAM_SEEN_SETTINGS_ID/.test(pill));
    for (const file of ["client/goal-polling.ts", "client/agent-polling.ts"]) {
      const source = fs.readFileSync(path.join(repo, "paseo-plugin", file), "utf8");
      assert(`${file} never writes the seen document`, !/seen-persistence|persistence\.remember|settingsRpc/.test(source));
    }
    const server = fs.readFileSync(path.join(repo, "paseo-plugin/index.server.ts"), "utf8");
    assert(
      "the server registers both seen settings",
      /registerSettings\(defineTeamSeenSettings\(\)\)/.test(server) && /registerSettings\(defineGoalSeenSettings\(\)\)/.test(server),
    );
    assert("…guarded for a host without plugin settings", /typeof server\.registerSettings !== "function"/.test(server));
    const definition = fs.readFileSync(path.join(repo, "paseo-plugin/shared/goal-seen-settings.ts"), "utf8");
    assert(
      "the goal definition is host-scoped and sanitises the document",
      /scope: "host"/.test(definition) && /seenDocumentOf/.test(definition) && /GOAL_SEEN_SETTINGS_ID = "goal-pill-seen"/.test(definition),
    );
  }
}

(async () => {
  await runControllerChecks();
  await seenPersistenceChecks();
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
