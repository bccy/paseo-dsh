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
  GOAL_EDITOR_MIN_HEIGHT,
  GOAL_EDITOR_WIDTH_WIDE,
  GOAL_FACTS_LINE_HEIGHT,
  GOAL_HINT_PADDING_HORIZONTAL,
  GOAL_HINT_PADDING_VERTICAL,
  GOAL_OBJECTIVE_LINE_HEIGHT,
  GOAL_RING_FRAME_SIZE,
  GOAL_RING_OFFSET,
  GOAL_RUNNING_HOLD_MS,
  GOAL_SEPARATOR_HEIGHT,
  GOAL_SEPARATOR_MARGIN_VERTICAL,
  GOAL_WHALE_SIZE,
  INITIAL_POLL_JITTER_MS,
  LIVE_POLL_MS,
  MAX_POLL_JITTER_MS,
  MAX_POLL_MS,
  createGoalPoller,
  goalCurrentTaskLine,
  goalEditDraftValid,
  goalEditSubmittable,
  goalFactsLine,
  goalIconButton,
  goalIconColorToken,
  goalMenuItem,
  goalPillPresentation,
  goalRunningMark,
  goalTrackRow,
  initialPollDelayMs,
  nextPollDelayMs,
} = require("./client/goal-polling.js");

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

  // menu-item.tsx:441 `item`: 28 wide / 40 compact, always a 1px border.
  equal("the menu row is the host's 28px row", goalMenuItem(false).minHeight, 28);
  equal("the phone menu row is 40", goalMenuItem(true).minHeight, 40);
  equal("the menu row keeps a 1px border", goalMenuItem(false).borderWidth, 1);
  equal("the menu row insets 4", goalMenuItem(false).marginHorizontal, 4);
  equal("the menu row pads 8 horizontally", goalMenuItem(false).paddingHorizontal, 8);

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
  equal("the edit field is four lines tall", GOAL_EDITOR_MIN_HEIGHT, 80);
  equal("the edit page is the popover's content width", GOAL_EDITOR_WIDTH_WIDE, 396);
  equal("the separator is 1px", GOAL_SEPARATOR_HEIGHT, 1);
  equal("the separator breathes 4", GOAL_SEPARATOR_MARGIN_VERTICAL, 4);
  equal("the hint pads 12 horizontally", GOAL_HINT_PADDING_HORIZONTAL, 12);
  equal("the hint pads 8 vertically", GOAL_HINT_PADDING_VERTICAL, 8);
  equal("the running hold is 1.5s", GOAL_RUNNING_HOLD_MS, 1500);
}

/* The facts line ------------------------------------------------------------ */

console.log("\nthe facts line joins the phase and the round budget");
{
  const zh = { active: "进行中", paused: "已暂停", blocked: "受阻", complete: "已完成" };
  const zhRounds = (started, max) => `第 ${String(started)} 轮 · 预算 ${String(max)}`;
  equal("the facts line is one sentence", goalFactsLine(goal(), zh, zhRounds), "进行中 · 第 3 轮 · 预算 10");
  equal("an unknown phase falls back to the key", goalFactsLine(goal(), {}, () => "r"), "active · r");
  const en = { active: "Active", paused: "Paused", blocked: "Blocked", complete: "Complete" };
  equal(
    "the English facts line",
    goalFactsLine(goal(), en, (started, max) => `Round ${String(started)} · budget ${String(max)}`),
    "Active · Round 3 · budget 10",
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

  assert("the trigger's title is the fixed noun", /title: text\.title/.test(pill));
  assert("the trigger's title is not the objective", !/title:.*goal\.objective/.test(pill));
  // The pill's icon slot: the running ring replaces the glyph, else a Target.
  assert(
    "the trigger's icon switches to the ring while running",
    /if \(running\) \{[\s\S]{0,400}StatusRingMark/.test(pill),
  );
  assert("the static glyph is the Target", /name="Target"/.test(pill));
  // The objective row is the host's track row and the edit entry.
  assert("the objective row is a track row", /goalTrackRow\(compact\)/.test(popover));
  assert("the objective is one truncated line", /numberOfLines=\{1\}[\s\S]{0,400}?\{goal\.objective\}/.test(popover));
  assert("the facts line comes from the pure rule", /goalFactsLine\(goal, text\.statuses, text\.rounds\)/.test(popover));
  // The edit and clear pages are the host's menu rows.
  assert("the edit page uses the menu row", /goalMenuItem\(false\)/.test(popover));
  assert("the clear page's row is destructive", /destructive/.test(popover));
  // The old button component and the footnote are gone.
  assert("no filled-button component remains", !/function ActionButton/.test(popover));
  assert("the footnote is gone", !/text\.footnote/.test(popover));
  // The panel cancels the host's popover content padding.
  assert("the panel cancels the host content padding", /popoverRootBox\(\)/.test(popover));
  // The whale draws through the host's svg seam.
  assert("the mark renders through the host's svg icon", /icon=\{\{ svg: DEEPSEEK_MARK_SVG \}\}/.test(mark));
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
