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
  GOAL_BODY_GAP,
  GOAL_BUTTON_GAP,
  GOAL_BUTTON_LABEL_SAFETY,
  GOAL_MARK_GAP,
  GOAL_MARK_SIZE,
  GOAL_MARK_TOP_OFFSET,
  GOAL_OBJECTIVE_LINE_HEIGHT,
  INITIAL_POLL_JITTER_MS,
  LIVE_POLL_MS,
  MAX_POLL_JITTER_MS,
  MAX_POLL_MS,
  blendHex,
  clearConfirmStep,
  contrastRatio,
  createGoalPoller,
  goalActionLabel,
  goalActionRowStyle,
  goalActionsFor,
  goalButtonGeometry,
  goalButtonMinWidth,
  goalButtonPalette,
  goalButtonRow,
  goalButtonVariant,
  goalCurrentTaskLine,
  goalEditDraftValid,
  goalIconColorToken,
  goalPillPresentation,
  goalStatusDotColorToken,
  goalTextWidth,
  goalToneColorToken,
  initialPollDelayMs,
  nextPollDelayMs,
  parseHexColor,
} = require("./client/goal-polling.js");
const {
  DEEPSEEK_MARK_BRAND_BLUE,
  DEEPSEEK_MARK_SVG,
} = require("./client/deepseek-mark-svg.js");

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

console.log("\nthe four states the trigger must tell apart");
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

  // ---- the hidden states, one named assertion per reason ------------------
  // DESIGN §2: "无目标/已完成/已清除 → 隐藏". These are different rules that
  // happen to share one visible outcome, so each gets its own assertion — a
  // mutation that deletes one rule must show up as its own red, not hide behind
  // another state's check. The complete rule is the first branch of the
  // visibility decision, so several assertions pin it: deleting it must be more
  // than one red (verified by mutation in evidence/mutation.md).
  const complete = goalPillPresentation({ available: true, goal: goal({ phase: "complete" }) });
  check("a complete goal is hidden", complete.visible, false);
  check(
    "a complete goal is hidden even when it is armed",
    goalPillPresentation({ available: true, goal: goal({ phase: "complete", activation: "armed" }) }).visible,
    false,
  );
  check(
    "a complete goal is hidden at any round count",
    goalPillPresentation({
      available: true,
      goal: goal({ phase: "complete", roundsStarted: 0, maxGoalRounds: 0 }),
    }).visible,
    false,
  );
  check("a complete goal carries no label to render", !("label" in complete), true);

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
  equal("the running tone colours the glyph with accent", goalIconColorToken("normal"), "accent");
  equal("the warning tone colours the glyph with statusWarning", goalIconColorToken("warning"), "statusWarning");
  equal("the error tone colours the glyph with statusDanger", goalIconColorToken("error"), "statusDanger");
  equal("the running tone colours the status line with foreground", goalToneColorToken("normal"), "foreground");
}

/* The popover's action row -------------------------------------------------- */

console.log("\nthe action row is right-aligned, primary last");
{
  // DESIGN's revision: [清除][编辑][主操作], right-aligned, primary is the only
  // accent fill. The order is data (goalButtonRow) so a JSX reshuffle cannot
  // silently move the destructive button next to the primary one.
  equal("active+armed row order", [...goalButtonRow(goalActionsFor(goal()))], ["clear", "edit", "pause"]);
  for (const [what, state] of [
    ["active+disarmed", goal({ activation: "disarmed" })],
    ["paused", goal({ phase: "paused" })],
    ["blocked", goal({ phase: "blocked", blockedReason: { code: "round-limit", message: "x" } })],
  ]) {
    equal(`${what} row order`, [...goalButtonRow(goalActionsFor(state))], ["clear", "edit", "resume"]);
  }
  // The row never draws an action the state does not offer.
  equal("an empty action set draws nothing", [...goalButtonRow([])], []);

  // **The row's layout is asserted as a value, not as source text.** The old
  // check regex-matched the JSX, and the file's own doc comment contained the
  // literal, so deleting the rule left it green (verification round F1). This
  // reads the function the JSX spreads into `style`; deleting the rule from the
  // function fails here.
  const desktop = goalButtonGeometry(false);
  const phone = goalButtonGeometry(true);
  const desktopRow = goalActionRowStyle(desktop);
  equal("the action row is right-aligned", desktopRow.justifyContent, "flex-end");
  equal("the action row is a row", desktopRow.flexDirection, "row");
  equal("the action row wraps on narrow sheets", desktopRow.flexWrap, "wrap");
  equal("the action row gap is the geometry gap", desktopRow.gap, desktop.gap);
  equal("the phone row uses the same gap", goalActionRowStyle(phone).gap, phone.gap);
  equal("the phone row is right-aligned too", goalActionRowStyle(phone).justifyContent, "flex-end");

  // Geometry follows the host's Button contract: desktop `sm` (32px), phone
  // sheet `md` (44px, the touch floor), both 14px text and 12px gap.
  equal("desktop height is the host's sm (32)", desktop.height, 32);
  equal("desktop radius is the host's xl (12)", desktop.borderRadius, 12);
  equal("desktop horizontal padding is spacing[3] (12)", desktop.paddingHorizontal, 12);
  equal("phone height is the host's md (44)", phone.height, 44);
  equal("phone height meets the 44px touch floor", phone.height >= 44, true);
  equal("phone radius is the host's 2xl (16)", phone.borderRadius, 16);
  equal("phone horizontal padding is spacing[4] (16)", phone.paddingHorizontal, 16);
  equal("both sizes use fontSize.base (14)", [desktop.fontSize, phone.fontSize], [14, 14]);
  equal("the row gap is the host's 12", [desktop.gap, phone.gap, GOAL_BUTTON_GAP], [12, 12, 12]);

  // The objective line's mark geometry: a 16px mark centred on a 20px first line.
  equal("the DeepSeek mark is the host's 16px icon slot", GOAL_MARK_SIZE, 16);
  equal("the mark gap is spacing[1.5]", GOAL_MARK_GAP, 6);
  equal("the objective line height is 20", GOAL_OBJECTIVE_LINE_HEIGHT, 20);
  equal("the mark centres on the first line", GOAL_MARK_TOP_OFFSET, 2);
  equal("the popover body gap is spacing[2]", GOAL_BODY_GAP, 8);
}

/* The action buttons' palette (measured against the panel, light and dark) --- */

console.log("\nthe action buttons' palette and contrast (light + dark)");
{
  // The host's real tokens, from `packages/app/src/styles/theme.ts` (lightTheme
  // and paseoDarkColors) mapped through `plugins/theme.ts` to the plugin's 11
  // colours. The verification round's F2/F3 measured the old implementation
  // against these; the assertions below re-measure the fix.
  const LIGHT = {
    foreground: "#1a1a1e",
    foregroundMuted: "#71717a",
    surface1: "#fafafa",
    accent: "#20744A",
    accentForeground: "#ffffff",
    statusDanger: "#9d433b",
  };
  const DARK = {
    foreground: "#fafafa",
    foregroundMuted: "#A1A5A4",
    surface1: "#1E2120",
    accent: "#20744A",
    accentForeground: "#ffffff",
    statusDanger: "#d8847b",
  };
  const at = (colors, variant, state = { hovered: false, pressed: false }) =>
    goalButtonPalette(variant, colors, state);

  // The variants per action.
  equal("pause is primary", goalButtonVariant("pause", false), "primary");
  equal("resume is primary", goalButtonVariant("resume", false), "primary");
  equal("edit is secondary", goalButtonVariant("edit", false), "secondary");
  equal("clear at rest is outline", goalButtonVariant("clear", false), "outline");
  equal("armed clear is destructive", goalButtonVariant("clear", true), "destructive");

  // **Every variant carries a 1px border.** Arming used to drop the outline's
  // border and shrink the button by 2px (verification round F5); the host's own
  // Button keeps a 1px border on every variant.
  for (const variant of ["primary", "secondary", "outline", "destructive"]) {
    equal(`${variant} keeps a 1px border`, at(LIGHT, variant).borderWidth, 1);
    equal(`${variant} keeps a 1px border in the dark theme`, at(DARK, variant).borderWidth, 1);
  }

  // The destructive state is a red outline + red text, not a red fill: the fill
  // measured 2.80:1 (white on the dark theme's #d8847b) in the verification
  // round. Red on the panel is AA in both themes.
  for (const [name, colors] of [["light", LIGHT], ["dark", DARK]]) {
    const destructive = at(colors, "destructive");
    equal(`the destructive button is not a red fill (${name})`, destructive.backgroundColor, "transparent");
    equal(`the destructive border is the danger colour (${name})`, destructive.borderColor, colors.statusDanger);
    equal(`the destructive text is the danger colour (${name})`, destructive.color, colors.statusDanger);
    const textContrast = contrastRatio(destructive.color, colors.surface1);
    assert(
      `the destructive text meets AA 4.5:1 (${name})`,
      textContrast !== undefined && textContrast >= 4.5,
      String(textContrast),
    );
    const borderContrast = contrastRatio(destructive.borderColor, colors.surface1);
    assert(
      `the destructive border meets 3:1 as a graphic (${name})`,
      borderContrast !== undefined && borderContrast >= 3,
      String(borderContrast),
    );

    // Secondary fill: `foreground` at 22% over the panel. 8–12% was measured at
    // 1.17–1.43 in the verification round (F3) — too faint in the dark theme.
    const secondary = at(colors, "secondary");
    equal(
      `the secondary fill is foreground at 22% over the panel (${name})`,
      secondary.backgroundColor,
      blendHex(colors.foreground, colors.surface1, 0.22),
    );
    const fillContrast = contrastRatio(secondary.backgroundColor, colors.surface1);
    assert(
      `the secondary fill is visible against the panel 1.5:1 (${name})`,
      fillContrast !== undefined && fillContrast >= 1.5,
      String(fillContrast),
    );
    const secondaryText = contrastRatio(secondary.color, secondary.backgroundColor);
    assert(
      `the secondary label meets AA 4.5:1 (${name})`,
      secondaryText !== undefined && secondaryText >= 4.5,
      String(secondaryText),
    );
    // Hover/press darken the fill rather than swapping tokens.
    assert(
      `the secondary hover is stronger than rest (${name})`,
      contrastRatio(at(colors, "secondary", { hovered: true, pressed: false }).backgroundColor, colors.surface1) >
        fillContrast,
    );

    // Outline: a translucent `foregroundMuted` border (50%), never the panel.
    const outline = at(colors, "outline");
    equal(`the outline has no fill (${name})`, outline.backgroundColor, "transparent");
    equal(
      `the outline border is foregroundMuted at 50% (${name})`,
      outline.borderColor,
      blendHex(colors.foregroundMuted, colors.surface1, 0.5),
    );
    const outlineContrast = contrastRatio(outline.borderColor, colors.surface1);
    assert(
      `the outline is visible against the panel 1.5:1 (${name})`,
      outlineContrast !== undefined && outlineContrast >= 1.5,
      String(outlineContrast),
    );
    const outlineText = contrastRatio(outline.color, colors.surface1);
    assert(
      `the outline label meets AA 4.5:1 (${name})`,
      outlineText !== undefined && outlineText >= 4.5,
      String(outlineText),
    );

    // Primary: the only accent fill, its label AA on the accent.
    const primary = at(colors, "primary");
    equal(`the primary is the accent fill (${name})`, primary.backgroundColor, colors.accent);
    const primaryText = contrastRatio(primary.color, primary.backgroundColor);
    assert(
      `the primary label meets AA 4.5:1 (${name})`,
      primaryText !== undefined && primaryText >= 4.5,
      String(primaryText),
    );
  }
}

/* The destructive confirmation's label and pinned width --------------------- */

console.log("\nthe destructive button says \"press again\" without moving");
{
  const actions = { pause: "暂停", resume: "继续", edit: "编辑", clear: "清除", confirmClear: "确认清除" };
  // F4: the confirmation must be visible on screen, not only in the aria label.
  equal("clear at rest reads 清除", goalActionLabel("clear", false, actions), "清除");
  equal("the armed button reads 确认清除", goalActionLabel("clear", true, actions), "确认清除");
  equal("pause keeps its label", goalActionLabel("pause", false, actions), "暂停");
  equal("edit keeps its label", goalActionLabel("edit", false, actions), "编辑");
  // English too, because the label length differs between languages.
  const english = { pause: "Pause", resume: "Continue", edit: "Edit", clear: "Clear", confirmClear: "Confirm" };
  equal("the armed button reads Confirm in English", goalActionLabel("clear", true, english), "Confirm");

  // F5: the button's width is pinned to the wider of the two labels, so the
  // label switch cannot resize it. `minWidth` is the outer box, so it must
  // cover each label plus padding and the 1px border on both sides — **plus the
  // safety margin**: the verification round measured the old pin at exactly the
  // label's estimated width (56.00 = 56.00), which would ellipsise under a
  // native font whose advance is a little wider (N1).
  const desktop = goalButtonGeometry(false);
  const phone = goalButtonGeometry(true);
  for (const [name, geometry] of [["desktop", desktop], ["phone", phone]]) {
    const pinned = goalButtonMinWidth(["清除", "确认清除"], geometry);
    const short = goalButtonMinWidth(["清除"], geometry);
    const long = goalButtonMinWidth(["确认清除"], geometry);
    assert(`${name}: the pinned width fits the longer label`, pinned >= long, `${pinned} vs ${long}`);
    assert(`${name}: the longer label needs more room`, long > short, `${long} vs ${short}`);
    // The confirmation sentence is what makes the button wider, so the pin has
    // to be driven by it — not by the short label.
    equal(`${name}: the pin is the longer label's width`, pinned, long);
    // The margin is on top of the label, its padding and its border, per side.
    const labelWidth = goalTextWidth("确认清除", geometry.fontSize);
    const contentWidth = pinned - geometry.paddingHorizontal * 2 - 2;
    // The margin is asserted against a **frozen literal** (8 = 4 per side, the
    // brief's floor), not against the module's own constant: comparing with
    // `GOAL_BUTTON_LABEL_SAFETY * 2` would make the check pass when the constant
    // is set to 0.
    assert(
      `${name}: the label keeps a safety margin on both sides`,
      contentWidth - labelWidth >= 8,
      `content ${contentWidth} - label ${labelWidth} = ${contentWidth - labelWidth}`,
    );
    assert(`${name}: the safety margin is positive`, GOAL_BUTTON_LABEL_SAFETY > 0, String(GOAL_BUTTON_LABEL_SAFETY));
  }
  // The label-width estimate itself: a CJK character is one em, so 清除 (2 CJK
  // chars) is two font sizes wide.
  equal("a two-character CJK label is two ems wide", goalTextWidth("清除", desktop.fontSize), 28);

  // **The whole row shares one width.** A single wider destructive button made
  // the row read as unbalanced (verification round 4a/N1); an equal-width row is
  // the deliberate layout. The phone sheet is 390 wide with 12px side padding,
  // so 3 buttons + 2 gaps must fit in 366 — in Chinese and English, because the
  // labels differ in length.
  const rowWidth = (labels, geometry) => goalButtonMinWidth(labels, geometry) * 3 + geometry.gap * 2;
  const PHONE_CONTENT_WIDTH = 390 - 12 * 2;
  for (const [language, clear, confirmClear] of [
    ["zh-CN", "清除", "确认清除"],
    ["en", "Clear", "Confirm"],
  ]) {
    const width = rowWidth([clear, confirmClear], phone);
    assert(
      `the phone row fits the 390px sheet in ${language}`,
      width <= PHONE_CONTENT_WIDTH,
      `${width} vs ${PHONE_CONTENT_WIDTH}`,
    );
    // The desktop popover is 420 wide with 12px padding + 1px border.
    const desktopWidth = rowWidth([clear, confirmClear], desktop);
    assert(
      `the desktop row fits the 420px popover in ${language}`,
      desktopWidth <= 420 - 13 * 2,
      `${desktopWidth} vs ${420 - 26}`,
    );
  }
}

/* The status dot ------------------------------------------------------------ */

console.log("\nthe status line carries its tone as an 8px dot");
{
  // The user asked for the status *colour* to identify the four states; the
  // text cannot carry it in the dark theme (accent as text measures 2.83:1), so
  // the dot is the colour channel.
  equal("the running tone draws an accent dot", goalStatusDotColorToken("normal"), "accent");
  equal("the warning tone draws a warning dot", goalStatusDotColorToken("warning"), "statusWarning");
  equal("the error tone draws a danger dot", goalStatusDotColorToken("error"), "statusDanger");
  // Four states, three tones: active+armed is the only "normal" one.
  equal("active+armed is the normal tone", goalPillPresentation({ available: true, goal: goal() }).tone, "normal");
  equal(
    "active+disarmed is the warning tone",
    goalPillPresentation({ available: true, goal: goal({ activation: "disarmed" }) }).tone,
    "warning",
  );
  equal("paused is the warning tone", goalPillPresentation({ available: true, goal: goal({ phase: "paused" }) }).tone, "warning");
  equal(
    "blocked is the error tone",
    goalPillPresentation({ available: true, goal: goal({ phase: "blocked", blockedReason: { code: "x", message: "y" } }) }).tone,
    "error",
  );
}

/* Colour helpers ------------------------------------------------------------ */

console.log("\nthe colour helpers");
{
  equal("parseHexColor reads #rrggbb", parseHexColor("#1a1a1e"), { r: 26, g: 26, b: 30 });
  equal("parseHexColor expands #rgb", parseHexColor("#abc"), { r: 170, g: 187, b: 204 });
  equal("parseHexColor rejects garbage", parseHexColor("red"), undefined);
  equal("blendHex at 0 keeps the background", blendHex("#000000", "#ffffff", 0), "#ffffff");
  equal("blendHex at 1 keeps the foreground", blendHex("#000000", "#ffffff", 1), "#000000");
  equal("blendHex at 0.5 mixes", blendHex("#000000", "#ffffff", 0.5), "#808080");
  equal("contrastRatio is 21 for black on white", Math.round(contrastRatio("#000000", "#ffffff")), 21);
  equal("contrastRatio is 1 for a colour on itself", contrastRatio("#123456", "#123456"), 1);
  equal("contrastRatio rejects garbage", contrastRatio("red", "#ffffff"), undefined);
}

/* The popover's content lines                                                 */

/* The popover's "now" line ----------------------------------------------- */

console.log("\nthe current-task line only exists when DSH has one in progress");
{
  // The task comes from DSH's `todos` projection; the popover trims it and
  // draws nothing when it is absent or blank (DSH resets the list every turn).
  equal("an in-progress task is shown verbatim", goalCurrentTaskLine(goal({ currentTask: "write the UI revision" })), "write the UI revision");
  equal("the task is trimmed", goalCurrentTaskLine(goal({ currentTask: "  padded task  " })), "padded task");
  equal("no task means no line", goalCurrentTaskLine(goal()), undefined);
  equal("a blank task means no line", goalCurrentTaskLine(goal({ currentTask: "   " })), undefined);
  equal("an empty task means no line", goalCurrentTaskLine(goal({ currentTask: "" })), undefined);
}

/* The destructive confirmation ---------------------------------------------- */

/* Buttons ------------------------------------------------------------------- */

console.log("\nthe popover's buttons per state");
{
  equal("active+armed offers pause", [...goalActionsFor(goal())], ["pause", "edit", "clear"]);
  for (const [what, state] of [
    ["active+disarmed", goal({ activation: "disarmed" })],
    ["paused", goal({ phase: "paused" })],
    ["blocked", goal({ phase: "blocked", blockedReason: { code: "round-limit", message: "x" } })],
  ]) {
    equal(`${what} offers resume`, [...goalActionsFor(state)], ["resume", "edit", "clear"]);
    assert(
      `${what} never offers both pause and resume`,
      !(goalActionsFor(state).includes("pause") && goalActionsFor(state).includes("resume")),
    );
  }
  // The design says unavailable actions are not drawn rather than disabled, so
  // every visible state offers clear/edit and exactly one of pause/resume.
  for (const state of [
    goal(),
    goal({ activation: "disarmed" }),
    goal({ phase: "paused" }),
    goal({ phase: "blocked", blockedReason: { code: "round-limit", message: "x" } }),
  ]) {
    const actions = goalActionsFor(state);
    check(`clear is always offered (${state.phase}/${state.activation})`, actions.includes("clear"), true);
    check(`edit is always offered (${state.phase}/${state.activation})`, actions.includes("edit"), true);
    check(
      `exactly one primary action (${state.phase}/${state.activation})`,
      actions.filter((action) => action === "pause" || action === "resume").length,
      1,
    );
  }
}

/* The destructive confirmation ---------------------------------------------- */

console.log("\nthe clear button takes two clicks");
{
  equal("the first click only arms", clearConfirmStep(false), "arm");
  equal("the second click runs", clearConfirmStep(true), "run");
  // A mis-tap can never clear: one click always lands on `arm`.
  assert("one click cannot execute", clearConfirmStep(false) !== "run");
}

/* The edit draft ------------------------------------------------------------ */

console.log("\nthe edit field refuses empty text");
{
  for (const value of ["", "   ", "\n\t"]) {
    check(`${JSON.stringify(value)} is not submittable`, goalEditDraftValid(value), false);
  }
  for (const value of ["x", "  x  ", "把目标改短"]) {
    check(`${JSON.stringify(value)} is submittable`, goalEditDraftValid(value), true);
  }
}

/* Tones --------------------------------------------------------------------- */

console.log("\ntones map to the theme tokens the popover draws with");
{
  equal("normal is the foreground", goalToneColorToken("normal"), "foreground");
  equal("warning is statusWarning", goalToneColorToken("warning"), "statusWarning");
  equal("error is statusDanger", goalToneColorToken("error"), "statusDanger");
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

/* The popover's wiring (source-level: it is JSX) ----------------------------- */

console.log("\nthe trigger and popover wiring");
{
  // The layout rules are asserted as **values** above; these are the call sites
  // that must actually use them. Read from source because JSX cannot be loaded
  // by plain node (it imports the host runtime). **Only code forms are matched**
  // — never a bare identifier or a style literal: the previous version matched
  // `justifyContent: "flex-end"`, a literal the file's own doc comment
  // contained, so the check stayed green after the rule was deleted
  // (verification round F1).
  const repoRoot = path.resolve(__dirname, "..", "..");
  const readRepo = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
  const pill = readRepo("paseo-plugin/client/goal-pill.tsx");
  const popover = readRepo("paseo-plugin/client/goal-popover.tsx");
  const mark = readRepo("paseo-plugin/client/deepseek-mark.tsx");

  // The title is the fixed noun, never the objective: on a phone the host draws
  // it as the sheet header, so an objective here would print it twice.
  assert("the trigger's title is the fixed noun", /title: text\.title/.test(pill));
  assert("the trigger's title is not the objective", !/title:.*goal\.objective/.test(pill));
  // The trigger's glyph is the tone-coloured component, not a bare icon name.
  assert("the trigger's icon is the tone-coloured component", /icon: makeGoalIcon\(store, agent\.id\)/.test(pill));
  assert("the glyph colours from the tone token", /theme\.colors\[goalIconColorToken\(tone\)\]/.test(pill));
  // The popover draws the DeepSeek mark on the objective's first line.
  assert("the popover draws the DeepSeek mark", /<DeepSeekMark size=\{GOAL_MARK_SIZE\}/.test(popover));
  assert("the mark renders through the host's svg icon", /icon=\{\{ svg: DEEPSEEK_MARK_SVG \}\}/.test(mark));
  // The action row's layout and each button's look come from the pure rules.
  // **Equivalent spellings pass**: the verification round showed that pinning
  // the exact JSX form `style={goalActionRowStyle(geometry)}` failed a
  // semantically identical `style={{ ...goalActionRowStyle(geometry) }}` (N3 —
  // a false red on a refactor, not a false green). The pattern only requires the
  // call to appear inside a `style={…}` expression.
  assert(
    "the row spreads the layout rule",
    /style=\{[^}]*goalActionRowStyle\(geometry\)/.test(popover),
  );
  assert(
    "each button resolves its look from the palette rule",
    /const palette = goalButtonPalette\(variant, colors, \{ hovered, pressed \}\)/.test(popover),
  );
  assert(
    "every button is pinned by the shared min-width rule",
    /minWidth=\{buttonMinWidth\}/.test(popover),
  );
  assert(
    "the label comes from the pure label rule",
    /goalActionLabel\(action, clearArmed, text\.actions\)/.test(popover),
  );
  assert("the row draws goalButtonRow's order", /goalButtonRow\(goalActionsFor\(goal\)\)/.test(popover));
  // The status line draws the 8px dot and takes its colour from the tone rule.
  assert("the status line draws a tone dot", /backgroundColor: statusDot/.test(popover));
  assert(
    "the dot colour comes from the tone rule",
    /const statusDot = theme\.colors\[goalStatusDotColorToken\(tone\)\]/.test(popover),
  );
  // The round budget and the now line are both drawn from the pure rules.
  assert("the round line is drawn from locale", /text\.rounds\(goal\.roundsStarted, goal\.maxGoalRounds\)/.test(popover));
  assert("the now line is drawn only when present", /goalCurrentTaskLine\(goal\)/.test(popover));
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
