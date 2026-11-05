/**
 * Offline assertions for the team pill's pure rules and its poll adapter (T3).
 *
 * The rules live in `client/team-polling.ts` as plain functions (no React, no
 * host), so their behaviour can be pinned here:
 *
 *   - **visibility**: only the Lead and no task → hidden; a teammate or a task →
 *     visible; no board → hidden;
 *   - **the pill icon**: failure / failed member → red, a teammate the server
 *     *says* runs → ring, "unknown" is never the ring;
 *   - **member words**: running/idle only when the server sent `running`; an
 *     `active` member without it reads 成员, never 运行中 or 空闲;
 *   - **direction B grouping**: 进行中 → 可开始 → 等待依赖 → 已完成, by DSH's
 *     own `ready` (a pending task that is not ready is never 可开始);
 *   - **facts lines, detail fields, warning translation** (unknown verbatim);
 *   - **the poller adapter**: terminal codes remove the pill, a transient error
 *     keeps the last board, a good answer publishes it;
 *   - **label/title is the noun** and the pill source never counts (P1).
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
const { allText } = require("./client/locale.js");
const { PROVIDER_ID } = require("./shared/provider.js");
const { isTerminalTeamErrorCode, teamViewSchema, TEAM_ERROR_CODES, TERMINAL_TEAM_ERROR_CODES } = require("./shared/team.js");

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
  equal("no board → hidden", teamPillVisible(null), false);
  equal("only the Lead, no task → hidden", teamPillVisible({ members: [LEAD], tasks: [] }), false);
  equal("the Lead and one task → visible", teamPillVisible({ members: [LEAD], tasks: [task()] }), true);
  equal("a teammate, no task → visible", teamPillVisible({ members: [LEAD, mate()], tasks: [] }), true);
  equal("a failure on an otherwise empty board stays hidden only when there is no team", teamPillVisible({ members: [LEAD], tasks: [], failure: "x" }), false);
  // Visibility counts teammates, not rows: it must not lean on the synthesised Lead row.
  equal("a teammate and no Lead row → visible", teamPillVisible({ members: [mate()], tasks: [] }), true);
  equal("no rows, no task → hidden", teamPillVisible({ members: [], tasks: [] }), false);
  equal("teammates are counted without the Lead", teamMateCount({ members: [LEAD, mate({ id: "a" }), mate({ id: "b" })], tasks: [] }), 2);
}

console.log("\nthe pill icon");
{
  equal("a running teammate → ring", teamPillIcon({ members: [LEAD, mate({ running: true })], tasks: [] }), "running");
  equal("an idle teammate → idle", teamPillIcon({ members: [LEAD, mate({ running: false })], tasks: [] }), "idle");
  equal("an unknown teammate is never the ring", teamPillIcon({ members: [LEAD, mate()], tasks: [] }), "idle");
  equal("a running Lead alone is not the team running", teamPillIcon({ members: [{ ...LEAD, running: true }], tasks: [task()] }), "idle");
  equal("a failed member → failed", teamPillIcon({ members: [LEAD, mate({ phase: "failed", running: true })], tasks: [] }), "failed");
  equal("a projection failure → failed, even with a runner", teamPillIcon({ members: [LEAD, mate({ running: true })], tasks: [], failure: "bad" }), "failed");
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
  assert("label and title are both the noun", /update\(\{ visible, label: text\.title, title: text\.title/.test(pill));
  assert("the pill never puts a count in its label (P1)", !/label: `|pillCount|\.length\}/.test(pill));
  assert("visibility goes through teamPillVisible", /const visible = teamPillVisible\(team\)/.test(pill));
  assert("the pill polls through createTeamPoller", /createTeamPoller\(\{/.test(pill));
  equal("zh title", ZH.title, "团队");
  equal("en title", EN.title, "Team");
  const client = fs.readFileSync(path.join(repo, "paseo-plugin/index.client.tsx"), "utf8");
  assert("the client registers the team pill", /contributeTeamPill\(client\)/.test(client));
  assert("the jobs and goal pills are still registered", /contributeJobsPill\(client\)/.test(client) && /contributeGoalPill\(client\)/.test(client));
  // The Users glyph is never replaced; the running state is a corner ring.
  assert("every team pill icon draws the Users glyph through CornerRingIcon", (pill.match(/<CornerRingIcon name="Users"/g) ?? []).length === 3, String((pill.match(/<CornerRingIcon name="Users"/g) ?? []).length));
  assert("…only the running icon turns the ring on", /function RunningIcon[\s\S]{0,200}running theme/.test(pill) && (pill.match(/running=\{false\}/g) ?? []).length === 2);
  assert("the team pill no longer draws a bare StatusRingMark", !/StatusRingMark/.test(pill));
  assert("the team pill's visibility rule is untouched", /const visible = teamPillVisible\(team\)/.test(pill));
}

pollerChecks()
  .catch((error) => {
    failures += 1;
    console.error(`  FAIL the poller checks threw: ${error instanceof Error ? error.stack : String(error)}`);
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
