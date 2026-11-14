/**
 * Offline assertions for the team pill's pure rules and its poll adapter (T3).
 *
 * The rules live in `client/team-polling.ts` as plain functions (no React, no
 * host), so their behaviour can be pinned here:
 *
 *   - **visibility**: tasks only (the user's 2026-11-06 decision) — any task →
 *     visible, no task → hidden even with teammates running; no board → hidden;
 *     an all-done board is shown once more and then hidden only after its panel
 *     was opened and confirmed closed (`teamAllDoneKey` / `teamCompleteSeenStep`,
 *     UI-v7); a new message does not hide it;
 *   - **"closed" is confirmed, not assumed** (the shared
 *     `client/seen-close-gate.ts`, UI-v7 fix — the goal pill uses it too):
 *     the host unmounts the popover body when it *opens* (its surface remounts
 *     once the position lands), so only an unmount that outlives the window is a
 *     user close — a remount inside it cancels, and nothing is ever reported
 *     twice;
 *   - **the pill icon**: failure / failed member → red, every task completed →
 *     the green `CircleCheck` (complete outranks running, failure outranks
 *     complete), a teammate the server *says* runs → ring, "unknown" is never
 *     the ring;
 *   - **member words**: running/idle only when the server sent `running`; an
 *     `active` member without it reads 成员, never 运行中 or 空闲;
 *   - **direction B grouping**: 进行中 → 可开始 → 等待依赖 → 已完成, by DSH's
 *     own `ready` (a pending task that is not ready is never 可开始);
 *   - **facts lines, detail fields, warning translation** (unknown verbatim);
 *   - **the poller adapter**: terminal codes remove the pill, a transient error
 *     keeps the last board, a good answer publishes it;
 *   - **label/title is the noun** and the pill source never counts (P1);
 *   - **the persisted "seen" document** (UI-v7 persistence, 2026-11-08): a
 *     confirmed close writes `agentId -> teamAllDoneKey` into the host's plugin
 *     settings, so a fresh controller over the same document — the app restart —
 *     hydrates it and keeps the board hidden; a failed read degrades to the old
 *     in-memory behaviour (show once more), a failed write never throws, and
 *     `advanceSeen`'s confirmed-close branch is the only write path (polls never
 *     write).
 *
 * Run (from paseo-plugin):
 *   npx tsc -p ../harness/team-pill.tsconfig.json
 *   echo '{"type":"commonjs"}' > .dbg-team/package.json
 *   cp ../harness/team-pill-check.cjs .dbg-team/
 *   cd .dbg-team && node team-pill-check.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  TEAM_GROUP_ORDER,
  TEAM_TASK_ICONS,
  teamAllDoneKey,
  teamCompleteSeenStep,
  teamMemberState,
  TEAM_HEAD_LEVELS,
  teamHeadAt,
  teamHeadItems,
  teamHeadLabel,
  teamHeadLevel,
  teamOwnerRunning,
  teamOwnerState,
  teamStoppedOwnerCount,
  teamPillIcon,
  teamPillVisible,
  teamMateCount,
  teamTaskFacts,
  teamTaskFactsParts,
  teamTaskFields,
  teamTaskGroups,
  teamTaskMark,
  teamWarningText,
  projectTeamAnswer,
} = require("./client/team-polling.js");
const { SEEN_CLOSE_CONFIRM_MS, createSeenCloseGate } = require("./client/seen-close-gate.js");
const { allText } = require("./client/locale.js");
const { PROVIDER_ID } = require("./shared/provider.js");
const {
  isTerminalTeamErrorCode,
  TEAM_ERROR_CODES,
  TERMINAL_TEAM_ERROR_CODES,
  teamModeProjectionSchema,
  teamProjectionSchema,
  teamRosterProjectionSchema,
  teamViewSchema,
} = require("./shared/team.js");
const { createAgentSubscriptions } = require("./client/agent-subscriptions.js");
const { createSeenMetadataStore } = require("./client/seen-metadata.js");
const { TEAM_SEEN_METADATA_KEY } = require("./shared/pill-metadata.js");

const ZH = allText()["zh-CN"].team;
const EN = allText().en.team;

let failures = 0;
let checks = 0;
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
function check(what, actual, expected) {
  checks += 1;
  if (Object.is(actual, expected)) return;
  failures += 1;
  console.error(`  FAIL ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const LEAD = { id: "root", name: "lead", role: "lead", phase: "active" };
const mate = (over = {}) => ({ id: `m-${over.name ?? "a"}`, name: "alpha", role: "teammate", phase: "active", ...over });
const task = (over = {}) => ({
  id: "task-1",
  revision: 1,
  subject: "do the thing",
  description: "",
  status: "pending",
  blockedBy: [],
  writeScopes: [],
  ready: true,
  writeScopeWarnings: [],
  ...over,
});

console.log("visibility");
{
  // Tasks only (the user's 2026-11-06 decision): starting teammates without a
  // shared task must not light the pill — the panel would only say
  // 「N 名成员 / 暂无共享任务」, which is the screenshot the user rejected.
  equal("no board → hidden", teamPillVisible(null), false);
  equal("no board (undefined) → hidden", teamPillVisible(undefined), false);
  equal("only the Lead, no task → hidden", teamPillVisible({ enabled: true, members: [LEAD], tasks: [] }), false);
  equal("a teammate, no task → hidden", teamPillVisible({ enabled: true, members: [LEAD, mate()], tasks: [] }), false);
  equal("a running teammate, no task → hidden", teamPillVisible({ enabled: true, members: [LEAD, mate({ running: true })], tasks: [] }), false);
  equal("the Lead and one task → visible", teamPillVisible({ enabled: true, members: [LEAD], tasks: [task()] }), true);
  equal("a task and no member rows → visible", teamPillVisible({ enabled: true, members: [], tasks: [task()] }), true);
  equal("a teammate and a task → visible", teamPillVisible({ enabled: true, members: [LEAD, mate()], tasks: [task()] }), true);
  equal("a completed task still counts (any task, not only open ones)", teamPillVisible({ enabled: true, members: [LEAD], tasks: [task({ status: "completed" })] }), true);
  equal("a failure on an otherwise empty board stays hidden", teamPillVisible({ enabled: true, members: [LEAD], tasks: [], failure: "x" }), false);
  equal("no rows, no task → hidden", teamPillVisible({ enabled: true, members: [], tasks: [] }), false);
  equal("teammates are counted without the Lead", teamMateCount({ enabled: true, members: [LEAD, mate({ id: "a" }), mate({ id: "b" })], tasks: [] }), 2);
  // The rc.3 selection: `enabled: false` hides the pill even when historical
  // tasks are still on the board — DSH's own TeamBoard renders nothing for it.
  equal("a disabled team with tasks → hidden", teamPillVisible({ enabled: false, members: [], tasks: [task()] }), false);
  const disabledDone = { enabled: false, members: [], tasks: [task({ status: "completed" })] };
  equal("a disabled all-done team with its seen key → still hidden", teamPillVisible(disabledDone, teamAllDoneKey(disabledDone)), false);
}

console.log("\nan all-done board's seen state (UI-v7)");
{
  // The key is `id:revision`, sorted by id, and only while every task is done.
  const done = (id, revision) => task({ id, revision, status: "completed" });
  const allDone = { enabled: true, members: [LEAD], tasks: [done("task-1", 3), done("task-2", 7)] };
  const allDoneNewer = { enabled: true, members: [LEAD], tasks: [done("task-1", 3), done("task-2", 8)] };
  const partial = { enabled: true, members: [LEAD], tasks: [done("task-1", 3), task({ id: "task-2" })] };
  const KEY = "task-1:3,task-2:7";
  equal("empty board → no key", teamAllDoneKey({ enabled: true, members: [LEAD], tasks: [] }), undefined);
  equal("a pending task → no key", teamAllDoneKey({ enabled: true, members: [LEAD], tasks: [task()] }), undefined);
  equal("one open task among done → no key", teamAllDoneKey(partial), undefined);
  equal("all done → id:revision joined", teamAllDoneKey(allDone), KEY);
  equal("…sorted by id, whatever the wire order", teamAllDoneKey({ enabled: true, members: [LEAD], tasks: [...allDone.tasks].reverse() }), KEY);
  equal("a revision change → a new key", teamAllDoneKey(allDoneNewer), "task-1:3,task-2:8");

  const step = (state, event) => teamCompleteSeenStep(state, event);
  equal("all done first seen while running records nothing", step({}, { kind: "board", team: allDone }), {});
  equal("…first seen while idle records nothing either", step({}, { kind: "board", team: allDone }), {});
  equal("the completing turn's idle marks nothing", step({}, { kind: "agent", status: "idle" }), {});
  equal("a running while the board is complete proves nothing", step({}, { kind: "agent", status: "running" }), {});
  const afterCompletion = step(step(step({}, { kind: "board", team: allDone }), { kind: "agent", status: "idle" }), {
    kind: "agent",
    status: "running",
  });
  equal("the next running (the user's next message) is not seen", afterCompletion, {});
  equal("closing the panel marks it seen", step({}, { kind: "closed", team: allDone }), { seen: KEY });
  equal("closing a not-all-done board marks nothing", step({}, { kind: "closed", team: partial }), {});
  equal("a board that stops being all done keeps seen", step({ seen: "old" }, { kind: "board", team: partial }), { seen: "old" });
  equal("the same all-done board after seen keeps it seen", step({ seen: KEY }, { kind: "board", team: allDone }), { seen: KEY });
  equal(
    "a new key shows again, the old seen stays",
    step({ seen: KEY }, { kind: "board", team: allDoneNewer }),
    { seen: KEY },
  );

  equal("all done + seen → hidden", teamPillVisible(allDone, KEY), false);
  equal("all done + no seen → visible", teamPillVisible(allDone), true);
  equal("all done + a different seen → visible", teamPillVisible(allDone, "other"), true);
  equal("a working board + any seen → visible", teamPillVisible(partial, KEY), true);
  equal("an empty board + seen → hidden", teamPillVisible({ enabled: true, members: [LEAD], tasks: [] }, KEY), false);
  equal("no board + seen → hidden", teamPillVisible(null, KEY), false);
}

console.log("\na close is confirmed, not assumed (UI-v7 fix: the host remounts the body at open)");
{
  // The host's popover content is keyed `placed ? "placed" : "measuring"`
  // (menu-overlay.tsx:350), so opening a panel mounts the body, unmounts it one
  // measurement frame later and mounts it again. Only a later unmount that stays
  // unmounted is the user closing the panel.
  const board = { enabled: true, members: [LEAD], tasks: [task({ id: "task-1", revision: 2, status: "completed" })] };
  const makeGate = (delayMs) => {
    const scheduled = [];
    const closed = [];
    const created = createSeenCloseGate({
      onClosed: (team) => closed.push(team),
      setTimeout: (callback, ms) => {
        const handle = { callback, ms, live: true };
        scheduled.push(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        if (handle !== undefined && handle !== null) handle.live = false;
      },
      ...(delayMs === undefined ? {} : { delayMs }),
    });
    return {
      gate: created,
      closed,
      scheduled,
      live: () => scheduled.filter((handle) => handle.live),
      fire: () => {
        for (const handle of scheduled.filter((candidate) => candidate.live)) {
          handle.live = false;
          handle.callback();
        }
      },
    };
  };

  assert("the confirmation window is 100–300ms", SEEN_CLOSE_CONFIRM_MS >= 100 && SEEN_CLOSE_CONFIRM_MS <= 300, String(SEEN_CLOSE_CONFIRM_MS));
  {
    const one = makeGate();
    one.gate.mounted();
    one.gate.unmounted(board);
    equal("a real close is not reported before the window elapses", one.closed.length, 0);
    equal("…the window is the default one", one.live()[0]?.ms, SEEN_CLOSE_CONFIRM_MS);
    one.fire();
    equal("…and it is reported once the window does", one.closed.length, 1);
    assert("…with the board it showed", one.closed[0] === board);
  }
  {
    // The host's open-time remount: mount → unmount (measuring) → mount (placed).
    const one = makeGate();
    one.gate.mounted();
    one.gate.unmounted(board);
    const stale = one.live()[0];
    one.gate.mounted();
    equal("a remount inside the window leaves no timer behind", one.live().length, 0);
    stale.live = false;
    stale.callback();
    equal("…and a late fire of the cancelled timer reports nothing", one.closed.length, 0);
  }
  {
    // The whole point: opening an all-done pill must not hide it.
    const one = makeGate(40);
    one.gate.mounted();
    one.gate.unmounted(board); // the open-time measuring unmount
    one.gate.mounted(); // the placed render
    one.fire();
    equal("opening the panel does not report a close", one.closed.length, 0);
    one.gate.unmounted(board); // the user really closed it
    one.fire();
    equal("a close after the open-time remount reports exactly once", one.closed.length, 1);
    equal("…on the configured window", one.scheduled.at(-1)?.ms, 40);
  }
  {
    // Remount churn (a poll redraw, a panel swap) never accumulates reports.
    const one = makeGate();
    for (let index = 0; index < 4; index += 1) {
      one.gate.mounted();
      one.gate.unmounted(board);
    }
    one.gate.mounted();
    one.fire();
    equal("repeated remounts never add a close", one.closed.length, 0);
    one.gate.unmounted(board);
    one.fire();
    equal("…and the eventual real close reports once", one.closed.length, 1);
  }
  {
    // Closing and reopening inside the window: the user is looking at the board
    // again, so the reopen cancels and only the next close reports.
    const one = makeGate();
    one.gate.mounted();
    one.gate.unmounted(board);
    one.gate.mounted();
    one.gate.unmounted(board);
    one.gate.mounted();
    one.fire();
    equal("closing and reopening inside the window reports nothing", one.closed.length, 0);
    one.gate.unmounted(board);
    one.fire();
    equal("…the next close reports it once", one.closed.length, 1);
  }
}

console.log("\nthe pill icon");
{
  equal("a running teammate → ring", teamPillIcon({ enabled: true, members: [LEAD, mate({ running: true })], tasks: [] }), "running");
  equal("an idle teammate → idle", teamPillIcon({ enabled: true, members: [LEAD, mate({ running: false })], tasks: [] }), "idle");
  equal("an unknown teammate is never the ring", teamPillIcon({ enabled: true, members: [LEAD, mate()], tasks: [] }), "idle");
  equal("a running Lead alone is not the team running", teamPillIcon({ enabled: true, members: [{ ...LEAD, running: true }], tasks: [task()] }), "idle");
  equal("a failed member → failed", teamPillIcon({ enabled: true, members: [LEAD, mate({ phase: "failed", running: true })], tasks: [] }), "failed");
  equal("a projection failure → failed, even with a runner", teamPillIcon({ enabled: true, members: [LEAD, mate({ running: true })], tasks: [], failure: "bad" }), "failed");
  // UI-v8: an all-done board wears the goal pill's green CircleCheck.
  const done = (id, revision = 1) => task({ id, revision, status: "completed" });
  equal("every task completed → complete", teamPillIcon({ enabled: true, members: [LEAD], tasks: [done("task-1")] }), "complete");
  equal("…several completed tasks → complete", teamPillIcon({ enabled: true, members: [LEAD, mate()], tasks: [done("task-1"), done("task-2", 3)] }), "complete");
  equal("…complete outranks a running teammate", teamPillIcon({ enabled: true, members: [LEAD, mate({ running: true })], tasks: [done("task-1")] }), "complete");
  equal("one open task among completed → not complete", teamPillIcon({ enabled: true, members: [LEAD], tasks: [done("task-1"), task({ id: "task-2" })] }), "idle");
  equal("…a running teammate then decides", teamPillIcon({ enabled: true, members: [LEAD, mate({ running: true })], tasks: [done("task-1"), task({ id: "task-2" })] }), "running");
  equal("a projection failure beats complete", teamPillIcon({ enabled: true, members: [LEAD], tasks: [done("task-1")], failure: "bad" }), "failed");
  equal("a failed member beats complete", teamPillIcon({ enabled: true, members: [LEAD, mate({ phase: "failed" })], tasks: [done("task-1")] }), "failed");
  equal("no tasks is idle, never complete", teamPillIcon({ enabled: true, members: [LEAD], tasks: [] }), "idle");
}

console.log("\nthe roster headline chips (T7): no running/stopped without the server's running");
{
  equal("running: true → running", teamMemberState(mate({ running: true })), "running");
  equal("running: false → idle", teamMemberState(mate({ running: false })), "idle");
  equal("no running → unknown", teamMemberState(mate()), "unknown");
  equal("provisioning wins over running", teamMemberState(mate({ phase: "provisioning", running: true })), "provisioning");
  equal("failed wins over running", teamMemberState(mate({ phase: "failed", running: true })), "failed");
  const keys = (team) => teamHeadItems(team).map((i) => `${i.key}:${i.count}`);
  // The user's screenshot: 4 members all running, 3 in-progress tasks.
  const user = { enabled: true, members: [{ ...LEAD, running: true }, mate({ id: "a", name: "a", running: true }), mate({ id: "b", name: "b", running: true }), mate({ id: "c", name: "c", running: true })], tasks: [0, 1, 2].map((i) => task({ id: `task-${i}`, status: "in_progress" })) };
  equal("user scale: 3 running teammates (the running Lead is not counted)", keys(user), ["running:3"]);
  // Mixed: 2 running (Lead + one), 1 stopped, 1 failed, 5/8 done.
  const mixed = {
    members: [{ ...LEAD, running: true }, mate({ id: "f", name: "f", running: true }), mate({ id: "r", name: "r", running: false }), mate({ id: "x", name: "x", phase: "failed" })],
    tasks: Array.from({ length: 8 }, (_, i) => task({ id: `task-${i}`, status: i < 5 ? "completed" : "in_progress" })),
  };
  equal("mixed: failed, running, stopped, done in order (Lead excluded)", keys(mixed), ["failed:1", "running:1", "stopped:1", "done:5/8"]);
  // Run state missing for everyone: no running / stopped chip at all.
  const unknown = { enabled: true, members: mixed.members.map(({ running, ...rest }) => rest), tasks: mixed.tasks };
  equal("running missing: no running or stopped chip", keys(unknown), ["failed:1", "done:5/8"]);
  // Zero counts are never chips.
  equal("nothing to count: no chips", keys({ enabled: true, members: [LEAD, mate()], tasks: [task()] }), []);
  equal("no completed task: no done chip", keys({ enabled: true, members: [LEAD], tasks: [task({ status: "in_progress" })] }), []);
  equal("a running Lead alone is not 运行中", keys({ enabled: true, members: [{ ...LEAD, running: true }, mate()], tasks: [] }), []);
  equal("a Lead's run state alone does not make it known", keys({ enabled: true, members: [{ ...LEAD, running: true }, mate({ id: "a" })], tasks: [] }), []);
  equal("an idle Lead is not stopped", keys({ enabled: true, members: [{ ...LEAD, running: false }, mate({ running: true })], tasks: [] }), ["running:1"]);
  equal("a failed member with running:true is not running", keys({ enabled: true, members: [LEAD, mate({ phase: "failed", running: true })], tasks: [] }), ["failed:1"]);
  // Labels.
  const item = { key: "running", count: "2" };
  equal("zh full / short", [teamHeadLabel(item, ZH, false), teamHeadLabel(item, ZH, true)], ["2 运行中", "2 运行"]);
  equal("zh done", teamHeadLabel({ key: "done", count: "5/8" }, ZH, false), "5/8 任务完成");
  equal("zh failed", [teamHeadLabel({ key: "failed", count: "1" }, ZH, false), teamHeadLabel({ key: "failed", count: "1" }, ZH, true)], ["1 创建失败", "1 失败"]);
  equal("en running", teamHeadLabel(item, EN, false), "2 running");
  equal("member count", [ZH.memberCount(4), EN.memberCount(1)], ["4 名成员", "1 member"]);
  // The ladder: failed and running are never dropped and keep a word at every level.
  equal("four levels", TEAM_HEAD_LEVELS.length, 4);
  for (const [index, level] of TEAM_HEAD_LEVELS.entries()) {
    const kept = teamHeadAt(teamHeadItems(mixed), level).map((i) => i.key);
    assert(`level ${index} keeps failed and running`, kept.includes("failed") && kept.includes("running"), kept.join(","));
    for (const key of ["failed", "running"]) {
      const label = teamHeadLabel({ key, count: "1" }, ZH, level.short);
      assert(`level ${index}: ${key} keeps a word`, /[^\d\s/]/.test(label), label);
    }
  }
  equal("level order: full, short, -stopped, -done", TEAM_HEAD_LEVELS.map((l) => `${l.short}:${l.drop.join("+")}`), ["false:", "true:", "true:stopped", "true:stopped+done"]);
  equal("unmeasured → full", teamHeadLevel([], undefined), 0);
  equal("full fits → 0", teamHeadLevel([200, 160, 120, 90], 250), 0);
  equal("short fits → 1", teamHeadLevel([300, 200, 120, 90], 250), 1);
  equal("only -stopped fits → 2", teamHeadLevel([300, 260, 200, 90], 250), 2);
  equal("only -done fits → 3", teamHeadLevel([300, 260, 255, 200], 250), 3);
  equal("nothing fits → the last level (failed+running remain)", teamHeadLevel([300, 290, 280, 270], 250), 3);
}

console.log("\nthe owner's mark (T5): ring / 已停止 / nothing");
{
  const members = [LEAD, mate({ id: "r", name: "fixer", running: true }), mate({ id: "i", name: "reviewer", running: false }), mate({ id: "u", name: "far" })];
  const doing = (owner) => task({ status: "in_progress", ownerName: owner });
  equal("a running owner → running", teamOwnerState(doing("fixer"), members), "running");
  equal("…and the ring", teamOwnerRunning(doing("fixer"), members), true);
  equal("running:false → stopped", teamOwnerState(doing("reviewer"), members), "stopped");
  equal("…and no ring", teamOwnerRunning(doing("reviewer"), members), false);
  equal("running missing → nothing (never stopped)", teamOwnerState(doing("far"), members), undefined);
  equal("an owner not on the roster → nothing", teamOwnerState(doing("ghost"), members), undefined);
  equal("no owner → nothing", teamOwnerState(task(), members), undefined);
  equal("a failed owner (even running:true) → nothing", teamOwnerState(doing("broken"), [mate({ name: "broken", phase: "failed", running: true })]), undefined);
  equal("a starting owner → nothing", teamOwnerState(doing("new"), [mate({ name: "new", phase: "provisioning", running: false })]), undefined);
  equal("a completed task's idle owner → nothing (the normal end)", teamOwnerState(task({ status: "completed", ownerName: "reviewer" }), members), undefined);
  equal("a pending task claimed by a stopped owner → stopped", teamOwnerState(task({ status: "pending", ownerName: "reviewer" }), members), "stopped");
  equal("the Lead as owner, running → running", teamOwnerState(doing("lead"), [{ ...LEAD, running: true }]), "running");
  equal("the stopped count only counts running:false owners", teamStoppedOwnerCount([doing("reviewer"), doing("far"), doing("fixer"), doing("ghost"), task()], members), 1);
  equal("ten in-progress tasks, all owners stopped", teamStoppedOwnerCount(Array.from({ length: 10 }, () => doing("reviewer")), members), 10);
  equal("ten in-progress tasks, owners unknown → 0", teamStoppedOwnerCount(Array.from({ length: 10 }, () => doing("far")), members), 0);
  equal("zh stopped tag", ZH.ownerStopped, "已停止");
  equal("zh header note", ZH.stoppedOwners(3), "3 个负责人已停止");
  equal("en header note", [EN.stoppedOwners(1), EN.stoppedOwners(3)], ["1 owner stopped", "3 owners stopped"]);
  equal("the detail owner field: running", teamTaskFields(doing("fixer"), ZH, members)[1], { label: "负责人", value: "fixer", owner: "running" });
  equal("…stopped", teamTaskFields(doing("reviewer"), ZH, members)[1], { label: "负责人", value: "reviewer", owner: "stopped" });
  equal("…unknown: no mark", teamTaskFields(doing("far"), ZH, members)[1], { label: "负责人", value: "far" });
  equal("…no roster (the timeline card): no mark", teamTaskFields(doing("fixer"), ZH)[1], { label: "负责人", value: "fixer" });
  equal("facts split around the owner", teamTaskFactsParts(task({ ready: false, ownerName: "fixer", blockedBy: ["task-3"], writeScopes: ["a/"] }), ZH), { lead: "task-1 · fixer", owner: true, trail: " · 等 task-3 · a/" });
  equal("…an unowned task has no owner slot", teamTaskFactsParts(task(), ZH), { lead: "task-1 · 未分配", owner: false, trail: "" });
  // Status and grouping stay DSH's: a stopped owner does not move its task.
  equal("a stopped owner's task stays 进行中", teamTaskMark(doing("reviewer")), "doing");
}

console.log("\ntasks: marks and direction-B groups");
{
  equal("completed → done", teamTaskMark(task({ status: "completed", ready: false })), "done");
  equal("in_progress → doing", teamTaskMark(task({ status: "in_progress", ready: false })), "doing");
  equal("pending + ready → ready", teamTaskMark(task({ ready: true })), "ready");
  equal("pending + not ready → blocked", teamTaskMark(task({ ready: false, blockedBy: ["task-9"] })), "blocked");
  equal("readiness is DSH's: pending, no blockers, ready:false → blocked", teamTaskMark(task({ ready: false, blockedBy: [] })), "blocked");
  equal("the icons are the host task-list ones plus CircleDashed", TEAM_TASK_ICONS, { doing: "CircleDot", ready: "Circle", blocked: "CircleDashed", done: "CircleCheck" });
  equal("group order", TEAM_GROUP_ORDER, ["doing", "ready", "blocked", "done"]);
  const tasks = [
    task({ id: "task-1", status: "completed", ready: false }),
    task({ id: "task-2", status: "pending", ready: false, blockedBy: ["task-3"] }),
    task({ id: "task-3", status: "in_progress", ready: false }),
    task({ id: "task-4", status: "pending", ready: true }),
    task({ id: "task-5", status: "in_progress", ready: false }),
  ];
  const groups = teamTaskGroups(tasks).map((g) => [g.mark, g.tasks.map((t) => t.id)]);
  equal("groups in order, DSH's order within", groups, [
    ["doing", ["task-3", "task-5"]],
    ["ready", ["task-4"]],
    ["blocked", ["task-2"]],
    ["done", ["task-1"]],
  ]);
  const readyIds = teamTaskGroups(tasks).find((g) => g.mark === "ready")?.tasks.map((t) => t.id) ?? [];
  assert("a blocked task never lands in 可开始", !readyIds.includes("task-2"), readyIds.join(","));
  equal("empty groups are dropped", teamTaskGroups([task()]).map((g) => g.mark), ["ready"]);
  equal("zh group names", [ZH.marks.doing, ZH.marks.ready, ZH.marks.blocked, ZH.marks.done], ["进行中", "可开始", "等待依赖", "已完成"]);
}

console.log("\ntask facts and detail fields");
{
  equal("zh facts: id · owner · scope", teamTaskFacts(task({ status: "in_progress", ready: false, ownerName: "fixer", writeScopes: ["src/a.ts"] }), ZH), "task-1 · fixer · src/a.ts");
  equal("zh facts: unowned, waiting, two scopes", teamTaskFacts(task({ ready: false, blockedBy: ["task-3", "task-4"], writeScopes: ["a/", "b/"] }), ZH), "task-1 · 未分配 · 等 task-3、task-4 · a/ +1");
  equal("zh facts: a done task without owner says nothing about owners", teamTaskFacts(task({ status: "completed", ready: false, blockedBy: ["task-0"] }), ZH), "task-1");
  equal("zh facts: a ready task whose blockers finished does not say 等", teamTaskFacts(task({ ready: true, blockedBy: ["task-0"] }), ZH), "task-1 · 未分配");
  equal("en facts", teamTaskFacts(task({ ready: false, blockedBy: ["task-3"] }), EN), "task-1 · Unassigned · after task-3");
  equal("zh overlap warning translated", teamWarningText("write scopes overlap with task-7", ZH), "写入范围与 task-7 重叠");
  equal("en overlap warning verbatim", teamWarningText("write scopes overlap with task-7", EN), "write scopes overlap with task-7");
  equal("an unknown warning stays verbatim in zh", teamWarningText("scopes look odd", ZH), "scopes look odd");
  const fields = teamTaskFields(task({ status: "in_progress", ready: false, ownerName: "fixer", blockedBy: ["task-0"], writeScopes: ["a/", "b/"], writeScopeWarnings: ["write scopes overlap with task-2"], revision: 4 }), ZH);
  equal("detail fields in order", fields.map((f) => f.label), ["状态", "负责人", "依赖", "写入范围", "提醒", "修订"]);
  equal("detail scopes one per line", fields.find((f) => f.label === "写入范围")?.value, "a/\nb/");
  equal("detail warning is a warning", fields.find((f) => f.label === "提醒")?.tone, "warning");
  equal("an unowned task's detail says 未分配", teamTaskFields(task(), ZH)[1], { label: "负责人", value: "未分配" });
}

console.log("\nthe contract");
{
  equal("error codes", TEAM_ERROR_CODES, ["bridge_too_old", "team_unavailable", "session_missing", "rpc_failed"]);
  equal("terminal codes", TERMINAL_TEAM_ERROR_CODES, ["bridge_too_old", "team_unavailable"]);
  equal("a missing code is not terminal", isTerminalTeamErrorCode(undefined), false);
  equal("session_missing is transient", isTerminalTeamErrorCode("session_missing"), false);
  const ok = teamViewSchema.safeParse({ enabled: true, members: [LEAD], tasks: [task()] });
  assert("the normalized view parses", ok.success, ok.success ? "" : ok.error.message);
  assert("a deleted task does not parse (the wire filters tombstones)", !teamViewSchema.safeParse({ enabled: true, members: [LEAD], tasks: [task({ status: "deleted" })] }).success);
  const stripped = teamViewSchema.parse({ enabled: true, members: [{ ...LEAD, running: true }], tasks: [] });
  equal("running survives the schema", stripped.members[0].running, true);
  // The two wire generations (shared/team.ts): both must parse, a hybrid or a
  // third shape must not. This is the rc.3 (dsh-agent-team) shape — no roster.
  const rc3Projection = teamModeProjectionSchema.safeParse({ enabled: true, tasks: [task()] });
  assert("the rc.3 projection (enabled, no roster) parses", rc3Projection.success, rc3Projection.success ? "" : rc3Projection.error.message);
  assert("the older projection (members, no enabled) parses", teamRosterProjectionSchema.safeParse({ members: [LEAD], tasks: [task()] }).success);
  assert("a hybrid {members, enabled} is neither generation", !teamProjectionSchema.safeParse({ members: [LEAD], enabled: true, tasks: [] }).success);
  assert("a projection with neither marker is neither generation", !teamProjectionSchema.safeParse({ tasks: [] }).success);
  equal("the union keeps each arm's own keys", Object.keys(teamModeProjectionSchema.parse({ enabled: false, tasks: [] })).sort(), ["enabled", "tasks"]);
  // A member derived from the rc.3 subagent catalog carries no phase: its
  // absence is "this generation does not express it", not `active`.
  equal("a phase-less member reads unknown without running", teamMemberState({ id: "x", name: "x", role: "teammate" }), "unknown");
  equal("…and running:false still reads idle", teamMemberState({ id: "x", name: "x", role: "teammate", running: false }), "idle");
}

console.log("\nthe subscription adapter");
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function subscriptionChecks() {
  /** The fake host: one push channel per agent, as `client.subscribe` gives the pill. */
  const make = (answers) => {
    const log = { added: [], updated: [], removed: [], published: [], opens: [], aborts: [] };
    const live = new Map();
    const host = {
      open(agentId, onAnswer, onEnd, signal) {
        log.opens.push(agentId);
        live.set(agentId, { onAnswer, onEnd });
        signal.addEventListener("abort", () => {
          log.aborts.push(agentId);
          live.delete(agentId);
        });
      },
      listAgentPage: async () => ({ entries: [] }),
      addAgent: (agent) => log.added.push(agent.id),
      updateAgent: (agent) => log.updated.push(agent),
      removeAgent: (agentId, reason) => log.removed.push([agentId, reason]),
      publishState: (agentId, state) => log.published.push([agentId, state.data]),
      onError: () => {},
      project: (_agentId, answer) => projectTeamAnswer(answer),
      isTerminalErrorCode: isTerminalTeamErrorCode,
      initialData: null,
      fallbackErrorMessage: "the DSH runtime could not read this agent's team",
      pillLabel: "team pill",
      publishOnTransientError: false,
    };
    const subscriptions = createAgentSubscriptions(host);
    let i = 0;
    const deliver = async () => {
      for (const [agentId, record] of [...live.entries()]) {
        record.onAnswer(answers[Math.min(i++, answers.length - 1)]);
        await settle();
        await settle();
        void agentId;
      }
    };
    return { subscriptions, log, deliver };
  };
  const agent = { id: "a1", provider: PROVIDER_ID, workspaceId: "w" };
  const board = { enabled: true, members: [LEAD, mate()], tasks: [] };
  {
    const { subscriptions, log, deliver } = make([{ available: true, team: board }]);
    subscriptions.upsert(agent);
    equal("a DSH agent registers a pill", log.added, ["a1"]);
    equal("…and opens its subscription", log.opens, ["a1"]);
    await deliver();
    equal("a good answer publishes the board", log.published.at(-1)?.[1]?.members?.length, 2);
    subscriptions.dispose();
  }
  {
    const { subscriptions, log, deliver } = make([
      { available: false, team: null, error: { message: "no bundle", code: "team_unavailable" } },
    ]);
    subscriptions.upsert(agent);
    await deliver();
    equal("a terminal code removes the pill", log.removed.at(-1), ["a1", "terminal"]);
    equal("…and releases the subscription", log.aborts, ["a1"]);
    subscriptions.dispose();
  }
  {
    const { subscriptions, log, deliver } = make([
      { available: true, team: board },
      { available: false, team: null, error: { message: "timeout", code: "rpc_failed" } },
    ]);
    subscriptions.upsert(agent);
    await deliver();
    const before = log.published.length;
    await deliver();
    equal("a transient error publishes nothing (the last board stays)", log.published.length, before);
    equal("…and does not remove the pill", log.removed.length, 0);
    subscriptions.dispose();
  }
  {
    // An agent update reaches the pill with its metadata: that is the channel the
    // "seen" key travels on (another window's confirmed close, or this one's echo).
    const { subscriptions, log } = make([{ available: true, team: board }]);
    subscriptions.upsert(agent);
    subscriptions.upsert({ ...agent, metadata: { "dsh.teamSeen": "task-1:1" } });
    equal("an update reaches the pill with its metadata", log.updated.at(-1)?.metadata, { "dsh.teamSeen": "task-1:1" });
    subscriptions.dispose();
  }
}

console.log("\npill wiring (source pins)");
{
  const repo = path.resolve(__dirname, "..", "..");
  const pill = fs.readFileSync(path.join(repo, "paseo-plugin/client/team-pill.tsx"), "utf8");
  assert(
    "label and title are both the noun",
    /registration\.update\(\{ visible, label: text\.title, title: text\.title, icon: ICONS\[icon\] \}\)/.test(pill),
  );
  assert(
    "the popover close is confirmed through the gate, never read off one unmount",
    /createSeenCloseGate\(\{/.test(pill) && /gate\.mounted\(\)/.test(pill) && /gate\.unmounted\(shown\.current\)/.test(pill),
  );
  assert("…the old unmount-is-a-close effect is gone", !/useEffect\(\(\) => \(\) => onClosed\(/.test(pill));
  assert(
    "present publishes only a real change (visible/label/title/icon)",
    /entry\.visible === visible && entry\.icon === icon && entry\.label === text\.title && entry\.title === text\.title[\s\S]{0,80}return;/.test(pill),
  );
  assert("the pill never puts a count in its label (P1)", !/label: `|pillCount|\.length\}/.test(pill));
  assert("visibility goes through teamPillVisible", /const visible = teamPillVisible\(team, remembered\)/.test(pill));
  assert("the pill watches the board through the team subscription", /client\.subscribe\(teamSnapshot, \{ agentId \}/.test(pill));
  assert("…and the old poller is gone", !/createTeamPoller|readTeam:/.test(pill));
  equal("zh title", ZH.title, "团队");
  equal("en title", EN.title, "Team");
  const client = fs.readFileSync(path.join(repo, "paseo-plugin/index.client.tsx"), "utf8");
  assert("the client registers the team pill", /contributeTeamPill\(client\)/.test(client));
  assert("the jobs and goal pills are still registered", /contributeJobsPill\(client\)/.test(client) && /contributeGoalPill\(client\)/.test(client));
  // The deference coordinator was deleted on 2026-11-08: the host's composer
  // track scrolls horizontally (host v0.15.3), so every pill shows by its own
  // rule and nothing coordinates visibility across them.
  assert("the team pill takes only the client", /export function contributeTeamPill\(client: PluginClientContext\)/.test(pill));
  assert("the client entry passes no coordinator", !/deference|PillDeference|createPillDeference|pill-deference/.test(client));
  assert("the coordinator module is gone", !fs.existsSync(path.join(repo, "paseo-plugin/client/pill-deference.ts")));
  const clientDir = path.join(repo, "paseo-plugin/client");
  const deferenceFiles = fs
    .readdirSync(clientDir)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => /pill-deference|PillDeference|createPillDeference|\bdeference\b/.test(fs.readFileSync(path.join(clientDir, file), "utf8")));
  equal("no deference reference remains in client/", deferenceFiles, []);
  // The Users glyph is never replaced; the running state is a corner ring.
  assert("every team pill icon draws the Users glyph through CornerRingIcon", (pill.match(/<CornerRingIcon name="Users"/g) ?? []).length === 3, String((pill.match(/<CornerRingIcon name="Users"/g) ?? []).length));
  assert("…only the running icon turns the ring on", /function RunningIcon[\s\S]{0,200}running theme/.test(pill) && (pill.match(/running=\{false\}/g) ?? []).length === 3);
  assert("the complete icon is the green CircleCheck", /function CompleteIcon[\s\S]{0,220}name="CircleCheck"[\s\S]{0,220}statusSuccess/.test(pill));
  assert("ICONS maps complete to CompleteIcon", /complete: CompleteIcon/.test(pill) && /Record<TeamPillIcon, typeof IdleIcon>/.test(pill));
  assert("the team pill no longer draws a bare StatusRingMark", !/StatusRingMark/.test(pill));
  // The popover's close is the only "seen" input (UI-v7): an all-done board
  // disappears only after that confirmed close. Answers and agent status events
  // must never mark it seen (a new message is not "the user looked at it").
  assert("closing the team popover marks an all-done board seen", /advanceSeen\(agent\.id, \{ kind: "closed", team \}\)/.test(pill));
  assert(
    "…only for the pill the close belongs to (a stale close is dropped)",
    /if \(pills\.get\(agent\.id\)\?\.registration !== registration\) return;/.test(pill),
  );
  assert("a board answer does not mark anything seen", !/advanceSeen\(agentId, \{ kind: "board"/.test(pill));
  assert(
    "an agent update re-presents only through the metadata store",
    /if \(seen\.observe\(agent\)\) present\(agent\.id\)/.test(pill),
  );
  assert(
    "…the agent's status is never a seen signal",
    /advanceSeen\([^)]*status/.test(pill) === false,
  );
  assert("the confirmed close writes the agent's metadata", /seen\.remember\(agentId, after\.seen\)/.test(pill));
  assert("…and there is exactly one write path in the pill", (pill.match(/seen\.remember\(/g) ?? []).length === 1);
  assert("the pill no longer talks to plugin settings", !/settingsRpc|registerSettings/.test(pill));
}

/**
 * The "seen" signature on the agent (agent metadata, 2026-11-11).
 *
 * A confirmed close writes one `teamAllDoneKey` under `dsh.teamSeen`, and a new
 * store over the same agent metadata — the app restart — reads it back and keeps
 * the all-done board hidden. A load failure degrades to the old in-memory
 * behaviour (show once more); a write failure keeps this session correct and
 * never throws.
 */
async function seenMetadataChecks() {
  console.log('\nthe "seen" signature on the agent (agent metadata, 2026-11-11)');
  const doneBoard = () => ({ enabled: true, members: [LEAD], tasks: [task({ id: "task-1", revision: 1, status: "completed" })] });

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
          errors.push([message, error instanceof Error ? error.message : String(error)]);
        },
      },
      TEAM_SEEN_METADATA_KEY,
    );
    return { store, writes, errors };
  }

  {
    const { store } = createStore();
    equal("an agent with no metadata remembers nothing", store.get("a1"), undefined);
    check("…so an all-done board shows", teamPillVisible(doneBoard(), store.get("a1")), true);
    const key = teamAllDoneKey(doneBoard());
    equal("observing the stored key reports the change", store.observe({ id: "a1", metadata: { [TEAM_SEEN_METADATA_KEY]: key } }), true);
    equal("…and the board is hidden", teamPillVisible(doneBoard(), store.get("a1")), false);
    check(
      "a working board stays visible whatever the key says",
      teamPillVisible({ enabled: true, members: [LEAD], tasks: [task({ id: "task-1", revision: 1, status: "in_progress" })] }, store.get("a1")),
      true,
    );
    check(
      "a new revision is a new key and shows again",
      teamPillVisible(
        { enabled: true, members: [LEAD], tasks: [task({ id: "task-1", revision: 2, status: "completed" })] },
        store.get("a1"),
      ),
      true,
    );
    equal("observing the same key again reports nothing", store.observe({ id: "a1", metadata: { [TEAM_SEEN_METADATA_KEY]: key } }), false);
    store.dispose();
  }

  {
    // The confirmed close: in memory now, on the agent right after; the daemon's
    // agent update echoes it back and that echo is not a visible change.
    const { store, writes } = createStore();
    const key = teamAllDoneKey(doneBoard());
    store.observe({ id: "a1", metadata: {} });
    store.remember("a1", key);
    equal("the confirmed close is in memory immediately", store.get("a1"), key);
    await store.flush();
    equal("…and one write carries it", writes, [["a1", key]]);
    equal("…the echo reports no visible change", store.observe({ id: "a1", metadata: { [TEAM_SEEN_METADATA_KEY]: key } }), false);
    equal("…and the answer survives the echo", store.get("a1"), key);
    // Another window's close lands as an agent update with a different key.
    const newer = teamAllDoneKey({ enabled: true, members: [LEAD], tasks: [task({ id: "task-2", revision: 3, status: "completed" })] });
    equal("another window's close reports the change", store.observe({ id: "a1", metadata: { [TEAM_SEEN_METADATA_KEY]: newer } }), true);
    equal("…and becomes the answer", store.get("a1"), newer);
    store.dispose();
  }

  {
    // A refused write: one line, and this session still hides the all-done board.
    const { store, errors } = createStore({ failWrites: true });
    const key = teamAllDoneKey(doneBoard());
    store.observe({ id: "a1", metadata: {} });
    store.remember("a1", key);
    await store.flush();
    equal("a failed write is reported once", errors.length, 1);
    equal("…and the in-session board stays hidden", store.get("a1"), key);
    equal("…which the visibility rule reads", teamPillVisible(doneBoard(), store.get("a1")), false);
    store.remember("a1", `${key},task-9:1`);
    await store.flush();
    equal("a second failure does not log again", errors.length, 1);
    store.dispose();
  }

  {
    // A removed pill does not forget the key (the 2026-11-09 rule): a reconnect
    // re-registers the agent, and the board it already read must stay hidden.
    const { store } = createStore();
    const key = teamAllDoneKey(doneBoard());
    store.observe({ id: "a1", metadata: {} });
    store.remember("a1", key);
    await store.flush();
    equal("a removed pill's key is still remembered", store.get("a1"), key);
    store.dispose();
  }

  // Source pins for the server half: no plugin settings, one subscription.
  {
    const repo = path.resolve(__dirname, "..", "..");
    const serverEntry = fs.readFileSync(path.join(repo, "paseo-plugin/index.server.ts"), "utf8");
    assert("the server registers no settings any more", !/registerSettings/.test(serverEntry));
    assert("the server serves the team subscription", /server\.handle\(teamSnapshot/.test(serverEntry));
    const polling = fs.readFileSync(path.join(repo, "paseo-plugin/client/team-polling.ts"), "utf8");
    assert("the team rules never write a seen key", !/seen\.remember|setMetadata|settingsRpc/.test(polling));
    assert("the controllers never write a seen key", !/seen\.remember|setMetadata/.test(fs.readFileSync(path.join(repo, "paseo-plugin/client/agent-subscriptions.ts"), "utf8")));
  }
}

Promise.resolve()
  .then(() => subscriptionChecks())
  .then(() => seenMetadataChecks())
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
