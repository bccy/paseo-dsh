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
  GOAL_TITLE_MAX_LENGTH,
  GOAL_TITLE_ELLIPSIS,
  INITIAL_POLL_JITTER_MS,
  LIVE_POLL_MS,
  MAX_POLL_JITTER_MS,
  MAX_POLL_MS,
  clearConfirmStep,
  createGoalPoller,
  goalActionsFor,
  goalEditDraftValid,
  goalPillPresentation,
  goalTitle,
  goalToneColorToken,
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
  equal("active+armed labels the round count", armed.label, { kind: "rounds", started: 3, max: 10 });
  check("active+armed is the normal tone", armed.tone, "normal");
  check("the title is the objective", armed.title, "ship the goal pill");

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

  // The trigger's title is cut to one line; the popover body keeps the full
  // objective. Counted in code points so an emoji is never split.
  equal("a short objective is not cut", goalTitle("short"), "short");
  const exact = "x".repeat(GOAL_TITLE_MAX_LENGTH);
  equal("an objective at the limit is not cut", goalTitle(exact), exact);
  const long = "y".repeat(GOAL_TITLE_MAX_LENGTH + 1);
  equal(
    "a longer objective is cut with one ellipsis",
    goalTitle(long),
    "y".repeat(GOAL_TITLE_MAX_LENGTH) + GOAL_TITLE_ELLIPSIS,
  );
  equal("the title is trimmed", goalTitle("  padded  "), "padded");
  const emoji = "😀".repeat(GOAL_TITLE_MAX_LENGTH + 5);
  const emojiTitle = goalTitle(emoji);
  equal(
    "an emoji objective is cut on a code-point boundary",
    Array.from(emojiTitle).length,
    GOAL_TITLE_MAX_LENGTH + 1,
  );
}

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
