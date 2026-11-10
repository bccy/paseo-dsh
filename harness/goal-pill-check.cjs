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
  goalControl,
  goalSnapshot,
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
  projectGoalAnswer,
} = require("./client/goal-polling.js");
const { allText } = require("./client/locale.js");
const { createAgentSubscriptions } = require("./client/agent-subscriptions.js");
const { PROVIDER_ID } = require("./shared/provider.js");
const { createSeenMetadataStore } = require("./client/seen-metadata.js");
const {
  GOAL_SEEN_METADATA_KEY,
  TEAM_SEEN_METADATA_KEY,
  seenFromMetadata,
  seenMetadataPatch,
} = require("./shared/pill-metadata.js");
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

  check("goal.snapshot is the watch subscription", goalSnapshot.name, "goal.snapshot");
  check("goal.control is the control RPC", goalControl.name, "goal.control");

  // The wire shapes: a payload with the five drawn fields plus the optional
  // blocker parses, and one without activation does not (activation is what the
  // disarmed state depends on; dropping it would silently present the goal as
  // auto-continuing).
  const wire = goalSnapshot.event.safeParse({
    available: true,
    goal: goal(),
  });
  check("a full goal parses on the wire", wire.success, true);
  const noActivation = goalSnapshot.event.safeParse({
    available: true,
    goal: { objective: "x", phase: "active", roundsStarted: 0, maxGoalRounds: 1 },
  });
  check("a goal without activation is rejected", noActivation.success, false);
  // id/revision are the completed goal's seen key (UI-v7): an old server that
  // does not send them is rejected rather than read as "never seen".
  const { id: _id, ...noId } = goal();
  check("a goal without id is rejected", goalSnapshot.event.safeParse({ available: true, goal: noId }).success, false);
  const { revision: _revision, ...noRevision } = goal();
  check(
    "a goal without revision is rejected",
    goalSnapshot.event.safeParse({ available: true, goal: noRevision }).success,
    false,
  );
  const parsed = goalSnapshot.event.safeParse({ available: true, goal: { ...goal(), createdAt: 1, updatedAt: 2 } });
  check(
    "timestamps are still stripped on the wire",
    parsed.success && !("createdAt" in parsed.data.goal) && !("updatedAt" in parsed.data.goal),
    true,
  );
  const blocked = goalSnapshot.event.safeParse({
    available: true,
    goal: goal({ phase: "blocked", blockedReason: { code: "round-limit", message: "limit reached" } }),
  });
  check("a blocked goal carries its reason", blocked.success, true);
  const nullGoal = goalSnapshot.event.safeParse({ available: true, goal: null });
  check("no goal is a null goal, not a missing field", nullGoal.success, true);
  const failed = goalSnapshot.event.safeParse({
    available: false,
    goal: null,
    error: { message: "no goal service", code: "goal_unavailable" },
  });
  check("a coded read failure parses", failed.success, true);
  const olderServer = goalSnapshot.event.safeParse({
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
  // The argument list is deliberately not pinned literally: the factory gained a
  // leading `client` when the popover started issuing `jobs.stop` (2026-11-11), and
  // a pin on the exact call made an unrelated signature change look like "the jobs
  // pill stopped opening its own popover" (V-P1). What this assertion is for is
  // *which* factory draws the popover and that it is the jobs pill's own store and
  // agent — both still pinned below.
  assert(
    "the jobs pill opens its own jobs popover",
    /behavior:\s*\{\s*kind:\s*"popover",\s*Content:\s*makeJobsPopover\([^)]*\bstore\b[^)]*\bagent\.id\b/.test(jobs),
  );
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

/* The controller and the agent metadata it reads ------------------------------ */

async function runControllerChecks() {
  /**
   * The fake host: one push channel per agent, exactly what `client.subscribe`
   * gives the real pill. The goal-specific policy lives in the injected options
   * (`publishOnTransientError: false`, the terminal predicate), so this drives the
   * real controller with the goal pill's own host shape.
   */
  function createHarness(overrides = {}) {
    const calls = { added: [], updated: [], removed: [], states: [], errors: [], pages: [], reads: 0, opens: [], aborts: [] };
    const live = new Map();
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const host = {
      open(agentId, onAnswer, onEnd, signal) {
        calls.opens.push(agentId);
        live.set(agentId, { onAnswer, onEnd, signal });
        signal.addEventListener("abort", () => {
          calls.aborts.push(agentId);
          live.delete(agentId);
        });
      },
      listAgentPage:
        overrides.listAgentPage ??
        (async (cursor) => {
          calls.pages.push(cursor);
          return { entries: [], pageInfo: { hasMore: false, nextCursor: null } };
        }),
      addAgent(agent) {
        calls.added.push(agent.id);
      },
      updateAgent(agent) {
        calls.updated.push(agent);
      },
      removeAgent(agentId, reason, error) {
        calls.removed.push([agentId, reason, error === undefined ? undefined : error.code]);
      },
      publishState(agentId, state) {
        if (!state.available) return;
        calls.states.push([agentId, { goal: state.data, available: true }]);
      },
      onError(message, error) {
        calls.errors.push([message, error instanceof Error ? error.message : error]);
      },
      project: (_agentId, answer) => projectGoalAnswer(answer),
      isTerminalErrorCode: isTerminalGoalErrorCode,
      initialData: null,
      fallbackErrorMessage: "the DSH runtime could not read this agent's goal",
      pillLabel: "goal pill",
      publishOnTransientError: false,
    };
    const subscriptions = createAgentSubscriptions(host);
    const answerFor = async (agentId) => {
      calls.reads += 1;
      try {
        return await (overrides.readGoal ? overrides.readGoal(agentId) : { available: true, goal: null });
      } catch (error) {
        return { available: false, goal: null, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    };
    const deliver = async (agentId) => {
      const record = live.get(agentId);
      if (record === undefined) return false;
      record.onAnswer(await answerFor(agentId));
      await settle();
      return true;
    };
    const snapshot = (ids) => ({
      entries: ids.map((id) => ({ agent: { id, workspaceId: "ws" } })),
      pageInfo: { hasMore: false, nextCursor: null },
    });
    return {
      calls,
      live,
      subscriptions,
      snapshot,
      deliver,
      settle,
      async step() {
        for (const agentId of [...live.keys()]) await deliver(agentId);
      },
    };
  }

  console.log("\npushed answers: one publish per change");
  {
    let answer = { available: true, goal: goal() };
    const harness = createHarness({ readGoal: async () => answer });
    const last = () => harness.calls.states[harness.calls.states.length - 1][1];
    await harness.subscriptions.applySnapshot(harness.snapshot(["a"]));
    await harness.step();
    equal("the first answer publishes", harness.calls.states.length, 1);
    await harness.step();
    equal("an unchanged answer does not publish again", harness.calls.states.length, 1);
    answer = { available: true, goal: goal({ phase: "paused" }) };
    await harness.step();
    equal("a phase change publishes", harness.calls.states.length, 2);
    equal("…with the new phase", last().goal.phase, "paused");
    answer = { available: true, goal: null };
    await harness.step();
    equal("a cleared goal publishes", harness.calls.states.length, 3);
    equal("…as null, not as an error", last().goal, null);
    harness.subscriptions.dispose();
  }

  console.log("\na transient failure keeps the last state (DESIGN §2)");
  {
    let fail = false;
    const harness = createHarness({
      readGoal: async () => {
        if (fail) throw new Error("stream ended");
        return { available: true, goal: goal({ phase: "active" }) };
      },
    });
    await harness.subscriptions.applySnapshot(harness.snapshot(["a"]));
    await harness.step();
    const readable = harness.calls.states.length;
    fail = true;
    await harness.step();
    equal("a failed answer publishes nothing", harness.calls.states.length, readable);
    equal("…it does not remove the pill either", harness.calls.removed, []);
    equal("…and the controller keeps the stream", harness.calls.aborts, []);
    fail = false;
    await harness.step();
    equal("recovery is compared against the last published answer", harness.calls.states.length, readable);
    harness.subscriptions.dispose();
  }

  console.log("\na terminal code removes the pill and releases the stream");
  {
    const harness = createHarness({
      readGoal: async () => ({ available: false, goal: null, error: { message: "no goal service", code: "goal_unavailable" } }),
    });
    await harness.subscriptions.applySnapshot(harness.snapshot(["a"]));
    await harness.step();
    equal("a terminal code removes the pill", harness.calls.removed, [["a", "terminal", "goal_unavailable"]]);
    equal("…and releases the subscription", harness.calls.aborts, ["a"]);
    await harness.step();
    equal("…and is never re-read", harness.calls.reads, 1);
    harness.subscriptions.upsert({ id: "a", workspaceId: "ws" });
    equal("an upsert does not reopen it", harness.calls.opens, ["a"]);
    await harness.subscriptions.applySnapshot(harness.snapshot(["a"]));
    equal("a fresh snapshot rebuilds the pill", harness.calls.added, ["a", "a"]);
    harness.subscriptions.dispose();
  }

  console.log("\nwhich agents get a goal pill");
  {
    const harness = createHarness();
    await harness.subscriptions.applySnapshot({
      entries: [
        { agent: { id: "ours", workspaceId: "ws", provider: PROVIDER_ID } },
        { agent: { id: "foreign", workspaceId: "ws", provider: "some-other-provider" } },
        { agent: { id: "no-workspace", provider: PROVIDER_ID } },
        { agent: { id: "closed", workspaceId: "ws", provider: PROVIDER_ID, status: "closed" } },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    equal("only this provider's agents in a workspace are registered", harness.calls.added, ["ours"]);
    equal("…and only they are subscribed", harness.calls.opens, ["ours"]);
    harness.subscriptions.dispose();
  }

  console.log("\nan upsert hands the agent's metadata to the pill");
  {
    // The "seen" key arrives on agent updates; the controller must pass the whole
    // agent through so the pill can re-decide its visibility.
    const harness = createHarness();
    await harness.subscriptions.applySnapshot(harness.snapshot(["a"]));
    harness.subscriptions.upsert({ id: "a", workspaceId: "ws", metadata: { "dsh.goalSeen": "goal-1:1" } });
    equal("the update reaches the pill", harness.calls.updated.length, 1);
    equal("…with its metadata", harness.calls.updated[0].metadata, { "dsh.goalSeen": "goal-1:1" });
    equal("…and the subscription is not reopened", harness.calls.opens, ["a"]);
    harness.subscriptions.dispose();
  }

  console.log("\ndrop and snapshot diff");
  {
    const harness = createHarness();
    await harness.subscriptions.applySnapshot(harness.snapshot(["a", "b"]));
    await harness.subscriptions.applySnapshot(harness.snapshot(["a"]));
    equal("a snapshot removes only the agents that left", harness.calls.removed.map(([id, reason]) => [id, reason]), [["b", "gone"]]);
    equal("…and keeps the survivor's subscription", harness.calls.aborts, ["b"]);
    harness.subscriptions.drop("a");
    equal("a push removal tears the pill down", harness.calls.removed.map(([id]) => id), ["b", "a"]);
    harness.subscriptions.dispose();
  }
}

/* The agent-metadata store that replaced the settings document ---------------- */

async function seenMetadataChecks() {
  console.log('\nthe "seen" signature on the agent (agent metadata, 2026-11-11)');

  /** A fake agent whose metadata this test controls, plus the writes it received. */
  function createStore(overrides = {}) {
    const writes = [];
    const errors = [];
    const store = createSeenMetadataStore(
      {
        write: async (agentId, signature) => {
          writes.push([agentId, signature]);
          if (overrides.failWrites) throw new Error("the host refused the metadata write");
        },
        onError: (message, error) => {
          errors.push([message, error instanceof Error ? error.message : error]);
        },
      },
      GOAL_SEEN_METADATA_KEY,
    );
    return { store, writes, errors };
  }

  {
    const { store } = createStore();
    equal("an agent with no metadata remembers nothing", store.get("a"), undefined);
    equal("…and observing it changes nothing", store.observe({ id: "a", metadata: {} }), false);
    equal("a completed goal that was never closed shows", goalPillPresentation({ available: true, goal: goal({ phase: "complete" }) }, store.get("a")).visible, true);
    equal("observing a stored key reports the change", store.observe({ id: "a", metadata: { [GOAL_SEEN_METADATA_KEY]: "goal-1:1" } }), true);
    equal("…and the pill reads it back", store.get("a"), "goal-1:1");
    equal(
      "…hiding the completed goal the user closed",
      goalPillPresentation({ available: true, goal: goal({ phase: "complete" }) }, store.get("a")).visible,
      false,
    );
    equal("observing the same key again reports nothing", store.observe({ id: "a", metadata: { [GOAL_SEEN_METADATA_KEY]: "goal-1:1" } }), false);
    equal("a value of the wrong type is not a signature", store.observe({ id: "b", metadata: { [GOAL_SEEN_METADATA_KEY]: 7 } }), false);
    equal("…and is not remembered", store.get("b"), undefined);
    equal("an empty string is not a signature", seenFromMetadata({ [GOAL_SEEN_METADATA_KEY]: "" }, GOAL_SEEN_METADATA_KEY), undefined);
    equal("the key is this plugin's namespace", GOAL_SEEN_METADATA_KEY, "dsh.goalSeen");
    equal("the team key is its own", TEAM_SEEN_METADATA_KEY, "dsh.teamSeen");
    equal("the patch names the key", seenMetadataPatch(GOAL_SEEN_METADATA_KEY, "goal-1:2"), { "dsh.goalSeen": "goal-1:2" });
    store.dispose();
  }

  {
    // A confirmed close: in memory at once (this session hides it), on the agent
    // right after (a reload hides it too).
    const { store, writes } = createStore();
    store.observe({ id: "a", metadata: {} });
    store.remember("a", "goal-1:1");
    equal("the confirmed close is in memory immediately", store.get("a"), "goal-1:1");
    await store.flush();
    equal("…and one write carries it", writes, [["a", "goal-1:1"]]);
    // The daemon echoes the new metadata as an agent update; that is what proves
    // it stored the value.
    equal("the echo reports no visible change", store.observe({ id: "a", metadata: { [GOAL_SEEN_METADATA_KEY]: "goal-1:1" } }), false);
    equal("…but the answer is still the signature", store.get("a"), "goal-1:1");
    // A stale snapshot (read before the write) must not undo the close.
    store.remember("a", "goal-1:2");
    await store.flush();
    equal("a stale snapshot does not change the visible answer", store.observe({ id: "a", metadata: { [GOAL_SEEN_METADATA_KEY]: "goal-1:1" } }), false);
    equal("…and the pending close wins", store.get("a"), "goal-1:2");
    store.dispose();
  }

  {
    // A refused write: one line, and the session still hides the finished state.
    const { store, errors } = createStore({ failWrites: true });
    store.observe({ id: "a", metadata: {} });
    store.remember("a", "goal-1:1");
    await store.flush();
    equal("a failed write is reported once", errors.length, 1);
    assert("…naming the agent", errors[0][1] === "the host refused the metadata write", JSON.stringify(errors[0]));
    equal("…and the in-session answer survives", store.get("a"), "goal-1:1");
    store.remember("a", "goal-1:2");
    await store.flush();
    equal("…a second failure does not log again", errors.length, 1);
    equal("…and the newer close still wins", store.get("a"), "goal-1:2");
    store.dispose();
  }

  {
    // Writes are chained in call order, and a removal must not forget the key
    // (the 2026-11-09 rule): a pill that comes back still hides what was read.
    const { store, writes } = createStore();
    store.observe({ id: "a", metadata: {} });
    store.remember("a", "goal-1:1");
    store.remember("b", "goal-2:1");
    await store.flush();
    equal("two closes are written in call order", writes, [["a", "goal-1:1"], ["b", "goal-2:1"]]);
    equal("a removed pill's key is still remembered", store.get("a"), "goal-1:1");
    store.dispose();
    store.remember("c", "goal-3:1");
    await store.flush();
    equal("a disposed store writes nothing more", writes.length, 2);
    equal("…and answers nothing", store.get("c"), undefined);
  }

  // Source pins: where the write may come from, and what the server half no
  // longer does. These are source reads because the code they pin runs inside the
  // app's client bundle and the daemon's plugin process.
  console.log("\nthe seen wiring in the pill and the server half");
  {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const readRepo = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
    const goalPill = readRepo("paseo-plugin/client/goal-pill.tsx");
    // The one write path: the confirmed-close branch of `advanceSeen`.
    assert("the goal pill writes a seen key on a confirmed close", /if \(event\.kind === "closed" && after\.seen !== undefined\) seen\.remember\(/.test(goalPill));
    assert(
      "no other code in the pill writes the seen key",
      (goalPill.match(/seen\.remember\(/g) ?? []).length === 1,
      String((goalPill.match(/seen\.remember\(/g) ?? []).length),
    );
    assert("the goal pill reads its key through the store", /seen\.get\(agentId\)/.test(goalPill));
    assert("the metadata write targets the agent record", /client\.paseo\.agents\.ref\(agentId\)\.setMetadata\(\{ \[GOAL_SEEN_METADATA_KEY\]/.test(goalPill));
    assert("the pill no longer talks to plugin settings", !/settingsRpc|registerSettings/.test(goalPill));
    // The controller and the presentation module never write: the close is the
    // only input that may.
    for (const file of ["client/goal-polling.ts", "client/agent-subscriptions.ts"]) {
      const source = readRepo(`paseo-plugin/${file}`);
      assert(`${file} never writes a seen key`, !/seen\.remember|setMetadata|settingsRpc/.test(source));
    }
    const serverEntry = readRepo("paseo-plugin/index.server.ts");
    assert("the server registers no settings any more", !/registerSettings/.test(serverEntry));
    assert("the server serves the goal subscription", /server\.handle\(goalSnapshot/.test(serverEntry));
    assert("the goal control action refreshes the feed", /if \(result\.ok\) goalFeed\.refresh\(agentId\)/.test(serverEntry));
    const metadata = readRepo("paseo-plugin/shared/pill-metadata.ts");
    assert("the keys live in the shared metadata module", /GOAL_SEEN_METADATA_KEY = "dsh\.goalSeen"/.test(metadata) && /TEAM_SEEN_METADATA_KEY = "dsh\.teamSeen"/.test(metadata));
  }
}

Promise.resolve()
  .then(() => seenMetadataChecks())
  .then(() => runControllerChecks())
  .then(() => {
    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
      console.error(`${failures} FAILED`);
      process.exit(1);
    }
    console.log("OK");
  })
  .catch((error) => {
    console.error("late checks crashed:", error);
    process.exit(1);
  });
