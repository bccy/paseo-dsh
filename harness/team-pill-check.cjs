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
  createTeamPoller,
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
} = require("./client/team-polling.js");
const { SEEN_CLOSE_CONFIRM_MS, createSeenCloseGate } = require("./client/seen-close-gate.js");
const { allText } = require("./client/locale.js");
const { PROVIDER_ID } = require("./shared/provider.js");
const { isTerminalTeamErrorCode, teamViewSchema, TEAM_ERROR_CODES, TERMINAL_TEAM_ERROR_CODES } = require("./shared/team.js");
const { createSeenPersistence } = require("./client/seen-persistence.js");
const { SEEN_SETTINGS_LIMIT, seenMapOf, mergeSeenValues } = require("./shared/seen-settings.js");
const { defineTeamSeenSettings } = require("./shared/team-seen-settings.js");
const { defineGoalSeenSettings } = require("./shared/goal-seen-settings.js");

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
  equal("only the Lead, no task → hidden", teamPillVisible({ members: [LEAD], tasks: [] }), false);
  equal("a teammate, no task → hidden", teamPillVisible({ members: [LEAD, mate()], tasks: [] }), false);
  equal("a running teammate, no task → hidden", teamPillVisible({ members: [LEAD, mate({ running: true })], tasks: [] }), false);
  equal("the Lead and one task → visible", teamPillVisible({ members: [LEAD], tasks: [task()] }), true);
  equal("a task and no member rows → visible", teamPillVisible({ members: [], tasks: [task()] }), true);
  equal("a teammate and a task → visible", teamPillVisible({ members: [LEAD, mate()], tasks: [task()] }), true);
  equal("a completed task still counts (any task, not only open ones)", teamPillVisible({ members: [LEAD], tasks: [task({ status: "completed" })] }), true);
  equal("a failure on an otherwise empty board stays hidden", teamPillVisible({ members: [LEAD], tasks: [], failure: "x" }), false);
  equal("no rows, no task → hidden", teamPillVisible({ members: [], tasks: [] }), false);
  equal("teammates are counted without the Lead", teamMateCount({ members: [LEAD, mate({ id: "a" }), mate({ id: "b" })], tasks: [] }), 2);
}

console.log("\nan all-done board's seen state (UI-v7)");
{
  // The key is `id:revision`, sorted by id, and only while every task is done.
  const done = (id, revision) => task({ id, revision, status: "completed" });
  const allDone = { members: [LEAD], tasks: [done("task-1", 3), done("task-2", 7)] };
  const allDoneNewer = { members: [LEAD], tasks: [done("task-1", 3), done("task-2", 8)] };
  const partial = { members: [LEAD], tasks: [done("task-1", 3), task({ id: "task-2" })] };
  const KEY = "task-1:3,task-2:7";
  equal("empty board → no key", teamAllDoneKey({ members: [LEAD], tasks: [] }), undefined);
  equal("a pending task → no key", teamAllDoneKey({ members: [LEAD], tasks: [task()] }), undefined);
  equal("one open task among done → no key", teamAllDoneKey(partial), undefined);
  equal("all done → id:revision joined", teamAllDoneKey(allDone), KEY);
  equal("…sorted by id, whatever the wire order", teamAllDoneKey({ members: [LEAD], tasks: [...allDone.tasks].reverse() }), KEY);
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
  equal("an empty board + seen → hidden", teamPillVisible({ members: [LEAD], tasks: [] }, KEY), false);
  equal("no board + seen → hidden", teamPillVisible(null, KEY), false);
}

console.log("\na close is confirmed, not assumed (UI-v7 fix: the host remounts the body at open)");
{
  // The host's popover content is keyed `placed ? "placed" : "measuring"`
  // (menu-overlay.tsx:350), so opening a panel mounts the body, unmounts it one
  // measurement frame later and mounts it again. Only a later unmount that stays
  // unmounted is the user closing the panel.
  const board = { members: [LEAD], tasks: [task({ id: "task-1", revision: 2, status: "completed" })] };
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
  equal("a running teammate → ring", teamPillIcon({ members: [LEAD, mate({ running: true })], tasks: [] }), "running");
  equal("an idle teammate → idle", teamPillIcon({ members: [LEAD, mate({ running: false })], tasks: [] }), "idle");
  equal("an unknown teammate is never the ring", teamPillIcon({ members: [LEAD, mate()], tasks: [] }), "idle");
  equal("a running Lead alone is not the team running", teamPillIcon({ members: [{ ...LEAD, running: true }], tasks: [task()] }), "idle");
  equal("a failed member → failed", teamPillIcon({ members: [LEAD, mate({ phase: "failed", running: true })], tasks: [] }), "failed");
  equal("a projection failure → failed, even with a runner", teamPillIcon({ members: [LEAD, mate({ running: true })], tasks: [], failure: "bad" }), "failed");
  // UI-v8: an all-done board wears the goal pill's green CircleCheck.
  const done = (id, revision = 1) => task({ id, revision, status: "completed" });
  equal("every task completed → complete", teamPillIcon({ members: [LEAD], tasks: [done("task-1")] }), "complete");
  equal("…several completed tasks → complete", teamPillIcon({ members: [LEAD, mate()], tasks: [done("task-1"), done("task-2", 3)] }), "complete");
  equal("…complete outranks a running teammate", teamPillIcon({ members: [LEAD, mate({ running: true })], tasks: [done("task-1")] }), "complete");
  equal("one open task among completed → not complete", teamPillIcon({ members: [LEAD], tasks: [done("task-1"), task({ id: "task-2" })] }), "idle");
  equal("…a running teammate then decides", teamPillIcon({ members: [LEAD, mate({ running: true })], tasks: [done("task-1"), task({ id: "task-2" })] }), "running");
  equal("a projection failure beats complete", teamPillIcon({ members: [LEAD], tasks: [done("task-1")], failure: "bad" }), "failed");
  equal("a failed member beats complete", teamPillIcon({ members: [LEAD, mate({ phase: "failed" })], tasks: [done("task-1")] }), "failed");
  equal("no tasks is idle, never complete", teamPillIcon({ members: [LEAD], tasks: [] }), "idle");
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
  const user = { members: [{ ...LEAD, running: true }, mate({ id: "a", name: "a", running: true }), mate({ id: "b", name: "b", running: true }), mate({ id: "c", name: "c", running: true })], tasks: [0, 1, 2].map((i) => task({ id: `task-${i}`, status: "in_progress" })) };
  equal("user scale: 3 running teammates (the running Lead is not counted)", keys(user), ["running:3"]);
  // Mixed: 2 running (Lead + one), 1 stopped, 1 failed, 5/8 done.
  const mixed = {
    members: [{ ...LEAD, running: true }, mate({ id: "f", name: "f", running: true }), mate({ id: "r", name: "r", running: false }), mate({ id: "x", name: "x", phase: "failed" })],
    tasks: Array.from({ length: 8 }, (_, i) => task({ id: `task-${i}`, status: i < 5 ? "completed" : "in_progress" })),
  };
  equal("mixed: failed, running, stopped, done in order (Lead excluded)", keys(mixed), ["failed:1", "running:1", "stopped:1", "done:5/8"]);
  // Run state missing for everyone: no running / stopped chip at all.
  const unknown = { members: mixed.members.map(({ running, ...rest }) => rest), tasks: mixed.tasks };
  equal("running missing: no running or stopped chip", keys(unknown), ["failed:1", "done:5/8"]);
  // Zero counts are never chips.
  equal("nothing to count: no chips", keys({ members: [LEAD, mate()], tasks: [task()] }), []);
  equal("no completed task: no done chip", keys({ members: [LEAD], tasks: [task({ status: "in_progress" })] }), []);
  equal("a running Lead alone is not 运行中", keys({ members: [{ ...LEAD, running: true }, mate()], tasks: [] }), []);
  equal("a Lead's run state alone does not make it known", keys({ members: [{ ...LEAD, running: true }, mate({ id: "a" })], tasks: [] }), []);
  equal("an idle Lead is not stopped", keys({ members: [{ ...LEAD, running: false }, mate({ running: true })], tasks: [] }), ["running:1"]);
  equal("a failed member with running:true is not running", keys({ members: [LEAD, mate({ phase: "failed", running: true })], tasks: [] }), ["failed:1"]);
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
  const ok = teamViewSchema.safeParse({ members: [LEAD], tasks: [task()] });
  assert("DSH's view parses", ok.success, ok.success ? "" : ok.error.message);
  assert("a deleted task does not parse (the wire filters tombstones)", !teamViewSchema.safeParse({ members: [LEAD], tasks: [task({ status: "deleted" })] }).success);
  const stripped = teamViewSchema.parse({ members: [{ ...LEAD, running: true }], tasks: [] });
  equal("running survives the schema", stripped.members[0].running, true);
}

console.log("\nthe poller adapter");
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function pollerChecks() {
  const timers = [];
  const make = (answers) => {
    const log = { added: [], removed: [], published: [] };
    let i = 0;
    const poller = createTeamPoller({
      readTeam: async () => answers[Math.min(i++, answers.length - 1)],
      listAgentPage: async () => ({ entries: [] }),
      addAgent: (agent) => log.added.push(agent.id),
      removeAgent: (agentId, reason) => log.removed.push([agentId, reason]),
      publishState: (agentId, team) => log.published.push([agentId, team]),
      onError: () => {},
      setTimeout: (cb, ms) => {
        timers.push({ cb, ms });
        return timers.length - 1;
      },
      clearTimeout: () => {},
      random: () => 0,
    });
    return { poller, log };
  };
  const agent = { id: "a1", provider: PROVIDER_ID, workspaceId: "w" };
  const board = { members: [LEAD, mate()], tasks: [] };
  {
    const { poller, log } = make([{ available: true, team: board }]);
    poller.upsert(agent);
    await settle();
    timers.at(-1)?.cb();
    await settle();
    await settle();
    equal("a DSH agent registers a pill", log.added, ["a1"]);
    equal("a good answer publishes the board", log.published.at(-1)?.[1]?.members?.length, 2);
    poller.dispose();
  }
  {
    const { poller, log } = make([{ available: false, team: null, error: { message: "no bundle", code: "team_unavailable" } }]);
    poller.upsert(agent);
    await settle();
    timers.at(-1)?.cb();
    await settle();
    await settle();
    equal("a terminal code removes the pill", log.removed.at(-1), ["a1", "terminal"]);
    poller.dispose();
  }
  {
    const { poller, log } = make([
      { available: true, team: board },
      { available: false, team: null, error: { message: "timeout", code: "rpc_failed" } },
    ]);
    poller.upsert(agent);
    await settle();
    timers.at(-1)?.cb();
    await settle();
    await settle();
    const before = log.published.length;
    timers.at(-1)?.cb();
    await settle();
    await settle();
    equal("a transient error publishes nothing (the last board stays)", log.published.length, before);
    equal("…and does not remove the pill", log.removed.length, 0);
    poller.dispose();
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
  assert("visibility goes through teamPillVisible", /const visible = teamPillVisible\(team, seen\)/.test(pill));
  assert("the pill polls through createTeamPoller", /createTeamPoller\(\{/.test(pill));
  equal("zh title", ZH.title, "团队");
  equal("en title", EN.title, "Team");
  const client = fs.readFileSync(path.join(repo, "paseo-plugin/index.client.tsx"), "utf8");
  assert("the client registers the team pill", /contributeTeamPill\(client, deference\)/.test(client));
  assert("the jobs and goal pills are still registered", /contributeJobsPill\(client, deference\)/.test(client) && /contributeGoalPill\(client, deference\)/.test(client));
  // The Users glyph is never replaced; the running state is a corner ring.
  assert("every team pill icon draws the Users glyph through CornerRingIcon", (pill.match(/<CornerRingIcon name="Users"/g) ?? []).length === 3, String((pill.match(/<CornerRingIcon name="Users"/g) ?? []).length));
  assert("…only the running icon turns the ring on", /function RunningIcon[\s\S]{0,200}running theme/.test(pill) && (pill.match(/running=\{false\}/g) ?? []).length === 3);
  assert("the complete icon is the green CircleCheck", /function CompleteIcon[\s\S]{0,220}name="CircleCheck"[\s\S]{0,220}statusSuccess/.test(pill));
  assert("ICONS maps complete to CompleteIcon", /complete: CompleteIcon/.test(pill) && /Record<TeamPillIcon, typeof IdleIcon>/.test(pill));
  assert("the team pill no longer draws a bare StatusRingMark", !/StatusRingMark/.test(pill));
  // The popover's close is the only "seen" input (UI-v7): an all-done board
  // disappears only after that confirmed close. Polls and agent status events
  // must never mark it seen (a new message is not "the user looked at it").
  assert("closing the team popover marks an all-done board seen", /advanceSeen\(agent\.id, \{ kind: "closed", team \}\)/.test(pill));
  assert(
    "…only for the pill the close belongs to (a stale close is dropped)",
    /if \(pills\.get\(agent\.id\)\?\.registration !== registration\) return;/.test(pill),
  );
  assert("a poll answer does not mark anything seen", !/advanceSeen\(agentId, \{ kind: "board"/.test(pill));
  assert(
    "the agent status is wired as a no-op, never as a seen signal",
    /advanceSeen\(update\.agent\.id, \{ kind: "agent", status: update\.agent\.status \}\)/.test(pill),
  );
}

/**
 * The persisted "seen" document (UI-v7 persistence, 2026-11-08): a confirmed
 * close writes one `agentId -> teamAllDoneKey` entry to the host's plugin
 * settings, and a *new controller over the same document* — the app restart —
 * hydrates it and keeps the board hidden. A load failure degrades to the old
 * in-memory behaviour (show once more); a write failure keeps this session
 * correct and never throws.
 */
async function seenPersistenceChecks() {
  console.log("\nthe persisted \"seen\" document (UI-v7 persistence, 2026-11-08)");
  const done = (id, revision) => task({ id, revision, status: "completed" });
  const allDone = { members: [LEAD], tasks: [done("task-1", 3)] };
  const allDoneNewer = { members: [LEAD], tasks: [done("task-1", 4)] };
  const KEY = "task-1:3";

  /** A fake host: one in-memory settings file; the revision hashes the raw bytes. */
  const fakeHost = (initial = null) => {
    let raw = initial === null ? null : JSON.stringify(initial);
    const revision = () => (raw === null ? "missing" : `rev:${raw}`);
    const io = {
      reads: 0,
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
        io.reads += 1;
        if (io.failRead) throw new Error("unknown method settings.team-pill-seen.read");
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
          raw = JSON.stringify({ seen: { "other-agent": "task-9:3" } });
          return { status: "conflict", error: "Settings changed on another client." };
        }
        if (input.revision !== revision()) return { status: "conflict", error: "Settings changed on another client." };
        raw = JSON.stringify({ seen: {} });
        return { status: "saved", revision: revision(), values: { seen: {} } };
      },
      warn: (message) => io.warned.push(message),
      document: () => (raw === null ? {} : JSON.parse(raw)),
      /** Another client on the same host changes the document now. */
      externalWrite: (values) => {
        raw = JSON.stringify(values);
      },
    };
    return io;
  };

  // The document's pure rules: untrusted JSON normalises to a bounded map.
  equal("a non-object document is an empty map", seenMapOf("nonsense"), {});
  equal("non-string and empty entries are dropped", seenMapOf({ a: "k", b: 3, "": "k", c: "" }), { a: "k" });
  const many = {};
  for (let index = 0; index < SEEN_SETTINGS_LIMIT + 5; index += 1) many[`agent-${String(index)}`] = `task-${String(index)}:1`;
  const capped = seenMapOf(many);
  equal("the document is capped", Object.keys(capped).length, SEEN_SETTINGS_LIMIT);
  equal("…keeping the newest entry", capped[`agent-${String(SEEN_SETTINGS_LIMIT + 4)}`], `task-${String(SEEN_SETTINGS_LIMIT + 4)}:1`);
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
    equal("…and the all-done board is visible", teamPillVisible(allDone, before.get("agent-1")), true);
    equal("hydrating never writes the document", first.writes.length, 0);
    before.remember("agent-1", KEY);
    await before.flush();
    equal("the confirmed close wrote the document", first.document(), { seen: { "agent-1": KEY } });

    // "Restart": the client bundle runs again and hydrates the same host file.
    const after = createSeenPersistence(fakeHost(first.document()));
    await after.hydrate();
    equal("a restart remembers the closed board", after.get("agent-1"), KEY);
    equal("…so the same all-done board stays hidden", teamPillVisible(allDone, after.get("agent-1")), false);
    equal("…a revision change shows it again", teamPillVisible(allDoneNewer, after.get("agent-1")), true);
  }

  // A failed read (older host without the settings RPC) is the old behaviour.
  {
    const broken = fakeHost();
    broken.failRead = true;
    const persistence = createSeenPersistence(broken);
    await persistence.hydrate();
    equal("a failed read still becomes ready", persistence.ready(), true);
    equal("…with nothing remembered", persistence.get("agent-1"), undefined);
    equal("…so the all-done board shows once more", teamPillVisible(allDone, persistence.get("agent-1")), true);
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
    equal("…so the pill stays hidden this session", teamPillVisible(allDone, persistence.get("agent-1")), false);
  }

  // Conflict: another client wrote meanwhile — re-read, merge, keep its agents.
  {
    const concurrent = fakeHost();
    const persistence = createSeenPersistence(concurrent);
    await persistence.hydrate();
    concurrent.externalWrite({ seen: { "other-agent": "task-9:3" } });
    persistence.remember("agent-1", KEY);
    await persistence.flush();
    equal("a conflicted write is retried once", concurrent.writes.length, 2);
    equal("…and the other client's agent is kept", concurrent.document(), {
      seen: { "other-agent": "task-9:3", "agent-1": KEY },
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

  // A removed pill starts clean; a re-add can be closed again.
  {
    const removal = fakeHost({ seen: { "agent-1": KEY } });
    const persistence = createSeenPersistence(removal);
    await persistence.hydrate();
    equal("the document remembers a closed board", persistence.get("agent-1"), KEY);
    persistence.forget("agent-1");
    equal("a removed pill starts clean", persistence.get("agent-1"), undefined);
    equal("…so the board is visible again", teamPillVisible(allDone, persistence.get("agent-1")), true);
    persistence.remember("agent-1", KEY);
    await persistence.flush();
    equal("a new confirmed close is remembered again", persistence.get("agent-1"), KEY);
  }

  // P2-1: a document the host refuses (`invalid`: an older version's envelope, a
  // corrupt file) is repaired by the host's `reset` — a `save` would re-parse the
  // same envelope and be refused on every attempt, so the stale board would show
  // once more after every restart for the life of the file.
  {
    const repair = fakeHost();
    repair.readInvalid = true;
    const persistence = createSeenPersistence(repair);
    await persistence.hydrate();
    equal("an invalid document triggers exactly one reset", repair.resetCalls, 1);
    equal("…hydration continues with an empty map", persistence.get("agent-1"), undefined);
    equal("…so the board is shown once", teamPillVisible(allDone, persistence.get("agent-1")), true);
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
    equal("…so the board is shown once more (the old behaviour)", teamPillVisible(allDone, persistence.get("agent-1")), true);
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
    equal("…so the board shows once more", teamPillVisible(allDone, persistence.get("agent-1")), true);
  }
  {
    // A reset that answers `conflict` (another client repaired the file): the
    // next save re-reads the now-valid document and merges, keeping its entries.
    const heal = fakeHost();
    heal.readInvalid = true;
    heal.resetConflict = true;
    const persistence = createSeenPersistence(heal, { settingsId: "team-pill-seen" });
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
      seen: { "other-agent": "task-9:3", "agent-1": KEY },
    });
    equal("…without a conflict warning", heal.warned.length, 0);
  }

  // P2-2: a write still in conflict after its one retry warns once (diagnostic
  // only — settings id and agent ids, never the document) and keeps the pending
  // entry for the next confirmed close; there is no polling retry.
  {
    const stubborn = fakeHost();
    stubborn.alwaysConflict = true;
    const persistence = createSeenPersistence(stubborn, { settingsId: "team-pill-seen" });
    await persistence.hydrate();
    persistence.remember("agent-1", KEY);
    await persistence.flush();
    equal("a conflicting write is attempted twice (one retry)", stubborn.writes.length, 2);
    equal("…then warns once", stubborn.warned.length, 1);
    assert("…naming the settings id", /team-pill-seen/.test(stubborn.warned[0] ?? ""), stubborn.warned[0]);
    assert("…and the agent id", /agentId=agent-1/.test(stubborn.warned[0] ?? ""), stubborn.warned[0]);
    assert("…never the document contents", !/task-1:3/.test(stubborn.warned[0] ?? ""), stubborn.warned[0]);
    equal("…while the memory keeps the seen state", persistence.get("agent-1"), KEY);
    equal("…so the pill stays hidden this session", teamPillVisible(allDone, persistence.get("agent-1")), false);
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
    const teamDefinition = defineTeamSeenSettings();
    equal("team definition id", teamDefinition.id, "team-pill-seen");
    equal("team definition scope", teamDefinition.scope, "host");
    equal("team definition version", teamDefinition.version, 1);
    const goalDefinition = defineGoalSeenSettings();
    equal("goal definition id", goalDefinition.id, "goal-pill-seen");
    equal("goal definition scope", goalDefinition.scope, "host");
    equal("goal definition version", goalDefinition.version, 1);
    const cases = [
      ["an empty document", {}, { seen: {} }],
      ["mixed value types", { seen: { a: 1, b: "x", "": "y", c: "" } }, { seen: { b: "x" } }],
      ["a garbage string", "nonsense", { seen: {} }],
      ["null", null, { seen: {} }],
    ];
    for (const [label, input, expected] of cases) {
      equal(`team schema normalises ${label}`, await teamDefinition.schema.parseAsync(input), expected);
      equal(`goal schema normalises ${label}`, await goalDefinition.schema.parseAsync(input), expected);
    }
  }

  // Sources: one write path only (the confirmed-close branch); polls never write.
  {
    const repo = path.resolve(__dirname, "..", "..");
    const pill = fs.readFileSync(path.join(repo, "paseo-plugin/client/team-pill.tsx"), "utf8");
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
    assert("a removed pill forgets the persisted fallback", /persistence\.forget\(agentId\)/.test(pill));
    assert(
      "the pill wires read/write/reset/warn against the team settings id",
      /settingsRpc\(TEAM_SEEN_SETTINGS_ID\)\.read/.test(pill) &&
        /settingsRpc\(TEAM_SEEN_SETTINGS_ID\)\.write/.test(pill) &&
        /settingsRpc\(TEAM_SEEN_SETTINGS_ID\)\.reset/.test(pill) &&
        /warn: \(message\) => console\.warn/.test(pill),
    );
    assert("…and passes the team settings id to the controller", /settingsId: TEAM_SEEN_SETTINGS_ID/.test(pill));
    assert("…never references the goal settings id (a swap must fail)", !/GOAL_SEEN_SETTINGS_ID/.test(pill));
    for (const file of ["client/team-polling.ts", "client/agent-polling.ts"]) {
      const source = fs.readFileSync(path.join(repo, "paseo-plugin", file), "utf8");
      assert(`${file} never writes the seen document`, !/seen-persistence|persistence\.remember|settingsRpc/.test(source));
    }
    const server = fs.readFileSync(path.join(repo, "paseo-plugin/index.server.ts"), "utf8");
    assert(
      "the server registers both seen settings",
      /registerSettings\(defineTeamSeenSettings\(\)\)/.test(server) && /registerSettings\(defineGoalSeenSettings\(\)\)/.test(server),
    );
    assert("…guarded for a host without plugin settings", /typeof server\.registerSettings !== "function"/.test(server));
    const definition = fs.readFileSync(path.join(repo, "paseo-plugin/shared/team-seen-settings.ts"), "utf8");
    assert(
      "the team definition is host-scoped and sanitises the document",
      /scope: "host"/.test(definition) && /seenDocumentOf/.test(definition) && /TEAM_SEEN_SETTINGS_ID = "team-pill-seen"/.test(definition),
    );
  }
}

pollerChecks()
  .catch((error) => {
    failures += 1;
    console.error(`  FAIL the poller checks threw: ${error instanceof Error ? error.stack : String(error)}`);
  })
  .then(() => seenPersistenceChecks())
  .catch((error) => {
    failures += 1;
    console.error(`  FAIL the seen-persistence checks threw: ${error instanceof Error ? error.stack : String(error)}`);
  })
  .then(() => {
    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
      console.error(`${failures} FAILED`);
      process.exit(1);
    }
    console.log("OK");
    process.exit(0);
  });
