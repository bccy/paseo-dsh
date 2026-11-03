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
  teamMemberFacts,
  teamMemberOrder,
  teamMemberState,
  teamMemberWord,
  teamPillIcon,
  teamPillVisible,
  teamTaskFacts,
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

console.log("\nmember words: no 运行中/空闲 without the server's running");
{
  equal("running: true → running", teamMemberState(mate({ running: true })), "running");
  equal("running: false → idle", teamMemberState(mate({ running: false })), "idle");
  equal("no running → unknown", teamMemberState(mate()), "unknown");
  equal("provisioning wins over running", teamMemberState(mate({ phase: "provisioning", running: true })), "provisioning");
  equal("failed wins over running", teamMemberState(mate({ phase: "failed", running: true })), "failed");
  for (const [name, text] of [["zh-CN", ZH], ["en", EN]]) {
    const unknown = teamMemberWord(mate(), text);
    assert(`${name}: an unknown member is not called running`, unknown !== text.memberStates.running, unknown);
    assert(`${name}: an unknown member is not called idle`, unknown !== text.memberStates.idle, unknown);
    equal(`${name}: an unknown member reads memberActive`, unknown, text.memberActive);
    const facts = teamMemberFacts(mate({ description: "reviews" }), text);
    assert(`${name}: an unknown member's facts carry no running word`, !facts.includes(text.memberStates.running) && !facts.includes(text.memberStates.idle), facts);
  }
  equal("zh: a running member's facts", teamMemberFacts(mate({ running: true, description: "修 bug" }), ZH), "运行中 · 修 bug");
  equal("zh: an idle member's facts", teamMemberFacts(mate({ running: false, description: "审查" }), ZH), "空闲 · 审查");
  equal("zh: a failed member shows DSH's error", teamMemberFacts(mate({ phase: "failed", error: "child Session recovery failed: x" }), ZH), "创建失败 · child Session recovery failed: x");
  equal("zh: the Lead running", teamMemberFacts({ ...LEAD, running: true }, ZH), "队长 · 运行中");
  equal("zh: the Lead unknown says only its role", teamMemberFacts(LEAD, ZH), "队长");
  const ordered = teamMemberOrder([
    mate({ id: "i", name: "idle", running: false }),
    mate({ id: "u", name: "unknown" }),
    LEAD,
    mate({ id: "f", name: "failed", phase: "failed" }),
    mate({ id: "r", name: "running", running: true }),
    mate({ id: "p", name: "prov", phase: "provisioning" }),
  ]).map((m) => m.name);
  equal("members order: lead, running, starting, failed, unknown, idle", ordered, ["lead", "running", "prov", "failed", "unknown", "idle"]);
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
