/**
 * 时间线里 goal 相关的行：状态行的名字、goal 工具结果卡、失败行的人话。
 *
 * 一条真实链路：插件真实的 `TimelineBuilder` → 宿主 `ProviderEventSchema`（宿主会剥掉
 * 不认识的字段）→ 客户端真实的 `toolCallData`。行按宿主规则合并（tool_call 以
 * `turnId + callId` 为身份，后写覆盖、位置取首次出现），与 Paseo 看到的一致。
 *
 * 断言：
 *   1. 插件自己的状态行叫 `goal_state`，标题「目标状态」；模型真实的 `get_goal` 行仍是
 *      「查看目标」。两者不再同名（以前状态行借 `get_goal` 的名字，于是也拿到了它的标题）。
 *   2. `get_goal` / `update_goal` / `create_goal` 的成功结果画成 DSH 的字段卡（`goalDetail`）：
 *      行头右半是 objective，卡片是 状态 / 执行轮次（受阻时加 受阻原因），不再是原始 JSON；
 *      `active + disarmed` 读作「等待继续」，`{goal:null}` 读作「没有目标」。
 *      解析不了的结果（坏 JSON、DSH 新增的 phase、缺字段）不出卡，原文一字不少地留在 body。
 *      失败的调用不出卡。
 *   3. 失败行带 DSH 的结构化错误码（`metadata.errorCode`，经过 ProviderEventSchema 仍在）；
 *      已知码的行头红字是中文短句、展开有一句解释，`error` 仍是 DSH 原文、行仍是 failed；
 *      未知码与原型链上的名字（`constructor`）不给人话，行头回落原文。
 *   4. 状态行排在引起它的 `/goal` 命令行之后（细节与实时/重放一致性见 goal-state-order-check）。
 *
 * 夹具是用户那次会话（`/goal <目标>` → 续跑第 1 轮 → 被拒的 create_goal → get_goal →
 * 参数非法的 update_goal → 成功的 update_goal）的同构复刻，id 与文本均为虚构。
 * 给出第一个参数时，另把那份解压后的真实会话日志（`session.v4.jsonl`）原样重放一遍，断言
 * 同样成立；路径只在命令行上，不写进仓库。
 *
 * 纯离线：不起 dsh、不读凭据。编译产物落在私有的 `.dbg-goal-tool-rows`（`plugin-build.cjs`）。
 *
 * 用法（仓库根目录）：
 *   node harness/goal-tool-rows-check.cjs [解压后的 session.v4.jsonl]
 *
 * 动了 `server/activity-timeline.ts` 的状态行、`server/timeline.ts` 的 `#toolResult`
 * metadata、`client/tool-call-data.ts` 的 goal 卡 / 失败码、`client/locale.ts` 的
 * `goalCard` 或 `toolLabels.goal_state`、`index.client.tsx` 的 dsh-tool schema 必跑。
 */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createRequire } = require("node:module");
const build = require("./plugin-build.cjs").resolvePluginBuild(undefined, ".dbg-goal-tool-rows");
const { TimelineBuilder } = require(join(build, "server/timeline.js"));
const req = createRequire(join(build, "index.server.js"));
const { ProviderEventSchema } = req("@getpaseo/plugin/server/provider");
const { toolCallData } = require(join(build, "client/tool-call-data.js"));
const { setLocale } = require(join(build, "client/locale.js"));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("PASS", name);
}

/* --------------------------------------------------------------- fixture */

const GOAL_ID = "goal-fixture-1";
const OBJ = "检查主机状态";
const goalValue = (phase, extra = {}) =>
  JSON.stringify({
    goal: { id: GOAL_ID, revision: phase === "complete" ? 2 : 1, objective: OBJ, phase, roundsStarted: 1, maxGoalRounds: 256, ...extra },
    activation: phase === "complete" ? "disarmed" : "armed",
  });
const ev = (seq, type, data) => ({ type, seq, data });
const toolCall = (seq, turn, step, callId, name, args) =>
  ev(seq, "tool/call", { turn, step, callId, name, arguments: JSON.stringify(args) });
const toolResult = (seq, turn, step, callId, text, error) =>
  ev(seq, "tool/result", {
    turn,
    step,
    message: { role: "tool", toolCallId: callId, content: [{ type: "text", text }], ...(error ? { isError: true } : {}) },
    ...(error ? { error: { name: "HarnessError", code: error } } : {}),
  });

/** The user's session, rebuilt with invented ids: same events, same order. */
const SESSION = [
  ev(7, "command/run", { commandId: "cmd-1", name: "goal", args: `  ${OBJ}`, source: { kind: "user" } }),
  ev(8, "goal/change", { kind: "goal/change", version: 1, operation: "create",
    goal: { id: GOAL_ID, revision: 1, objective: OBJ, phase: "active", maxGoalRounds: 256 }, roundsStarted: 0, createdAt: 1, updatedAt: 1 }),
  ev(9, "command/done", { commandId: "cmd-1", kind: "success", text: `Goal created\nStatus: active\nObjective: ${OBJ}` }),
  ev(11, "turn/start", { turn: 1 }),
  ev(15, "user/message", { id: "m-round-1", content: [{ type: "text", text: "<goal_round>\n</goal_round>" }],
    source: { kind: "goal", goalId: GOAL_ID, revision: 1, round: 1 } }),
  toolCall(23, 1, 1, "call-create", "create_goal", { max_goal_rounds: 10, objective: "改写过的目标" }),
  toolResult(24, 1, 1, "call-create", "Error: this goal operation requires a direct human turn on a top-level agent", "GOAL_TOOL_AUTHORITY_REQUIRED"),
  toolCall(28, 1, 2, "call-bash", "bash", { command: "uptime", description: "只读检查" }),
  toolResult(31, 1, 2, "call-bash", "up 5 days"),
  toolCall(35, 1, 3, "call-get", "get_goal", {}),
  toolResult(36, 1, 3, "call-get", goalValue("active")),
  toolCall(40, 1, 4, "call-upd1", "update_goal", { action: "complete", blocked_reason: "", goal_id: GOAL_ID, max_goal_rounds: 256, objective: OBJ, revision: 1 }),
  toolResult(41, 1, 4, "call-upd1", "Error: objective and max_goal_rounds are valid only with action edit", "GOAL_TOOL_INVALID_UPDATE"),
  toolCall(45, 1, 5, "call-upd2", "update_goal", { action: "complete", blocked_reason: "", goal_id: GOAL_ID, max_goal_rounds: 0, objective: "", revision: 1 }),
  ev(46, "goal/change", { kind: "goal/change", version: 1, operation: "complete",
    goal: { id: GOAL_ID, revision: 2, objective: OBJ, phase: "complete", maxGoalRounds: 256 }, roundsStarted: 1, createdAt: 1, updatedAt: 2 }),
  toolResult(47, 1, 5, "call-upd2", goalValue("complete")),
  ev(55, "turn/end", { turn: 1, reason: { kind: "completed" } }),
];

/* --------------------------------------------------------------- pipeline */

/**
 * Feed events through the real builder and the host's own schema, then merge the
 * way the host does: a tool_call's identity is `turnId + callId`
 * (`stream.ts` agentToolCallIdentity, `timeline-projection.ts`), anything else
 * its id; the last write wins and keeps the first position.
 */
function rowsOf(events, warnings = []) {
  const builder = new TimelineBuilder({ warn: (line) => warnings.push(line) });
  const order = [];
  const last = new Map();
  let turn = null;
  for (const e of events) {
    if (e.type === "turn/start") turn = `turn:${String(e.data.turn)}`;
    for (const raw of builder.consume({ type: e.type, seq: e.seq, data: e.data })) {
      const item = ProviderEventSchema.parse({ type: "timeline.item", sessionId: "s", item: raw }).item;
      const key = item.type === "tool_call" ? `${turn}/${item.callId}` : item.id;
      if (!last.has(key)) order.push(key);
      last.set(key, item);
    }
    if (e.type === "turn/end") turn = null;
  }
  return order.map((key) => last.get(key));
}
const view = (item) => toolCallData(item, "complete");
const tools = (rows) => rows.filter((row) => row.type === "tool_call");
const byName = (rows, name, status) => tools(rows).filter((row) => row.name === name && (status === undefined || row.status === status));

/* --------------------------------------------------------------- checks */

function assertSession(rows, objective, label) {
  setLocale("zh-CN");
  const states = byName(rows, "goal_state");
  assert.ok(states.length >= 2, `${label}: expected a state row at create and at complete, got ${JSON.stringify(tools(rows).map((r) => r.name))}`);
  for (const row of states) {
    const data = view(row);
    assert.equal(data.label, "目标状态", `${label}: state row title`);
    assert.equal(data.icon, "Target", `${label}: state row glyph`);
  }
  assert.equal(view(states[0]).summary, `进行中 · ${objective}`, `${label}: first state row`);
  // The state row follows the `/goal` command that caused it, not the other way round.
  const names = tools(rows).map((row) => row.name);
  assert.ok(names.indexOf("/goal") >= 0 && names.indexOf("/goal") < names.indexOf("goal_state"),
    `${label}: the /goal row comes before its state row, got ${JSON.stringify(names)}`);
  assert.equal(view(states.at(-1)).summary, `已完成 · ${objective}`, `${label}: last state row`);
  assert.equal(byName(rows, "get_goal").length, 1, `${label}: only the model's real get_goal call carries that name`);
  // The confusion the user saw: two 「查看目标」 rows, one of which was never a call.
  assert.equal(tools(rows).filter((row) => view(row).label === "查看目标").length, 1, `${label}: exactly one 「查看目标」 row`);

  const get = view(byName(rows, "get_goal")[0]);
  assert.equal(get.summary, objective, `${label}: get_goal head shows the objective`);
  assert.deepEqual(get.goal, { objective, fields: [{ label: "状态", value: "进行中" }, { label: "执行轮次", value: "1 / 256" }], empty: false });
  assert.equal(get.body, "", `${label}: no raw JSON body under the card`);
  assert.equal(get.hasDetail, true);

  const updates = byName(rows, "update_goal");
  const done = view(updates.find((row) => row.status === "completed"));
  assert.equal(done.summary, objective, `${label}: update_goal head shows the objective, not its arguments`);
  assert.deepEqual(done.goal?.fields, [{ label: "状态", value: "已完成" }, { label: "执行轮次", value: "1 / 256" }]);

  const create = byName(rows, "create_goal", "failed")[0];
  assert.equal(create.metadata?.errorCode, "GOAL_TOOL_AUTHORITY_REQUIRED", `${label}: the code survives the host schema`);
  const createView = view(create);
  assert.equal(createView.status, "failed");
  assert.equal(createView.failed, true);
  assert.equal(createView.goal, null, "a failed call never gets the card");
  assert.equal(createView.errorShort, "已拒绝：续跑轮不能创建或修改目标");
  assert.match(createView.errorHint, /自动续跑轮不行/);
  assert.equal(createView.error, "Error: this goal operation requires a direct human turn on a top-level agent", "DSH's text is kept verbatim");

  const bad = view(updates.find((row) => row.status === "failed"));
  assert.equal(bad.errorShort, "已拒绝：参数组合不合法");
  assert.equal(bad.errorCode, "GOAL_TOOL_INVALID_UPDATE");
  assert.equal(bad.error, "Error: objective and max_goal_rounds are valid only with action edit");
}

test("the user's session, rebuilt: state row is 「目标状态」, goal results are cards, refusals read in words", () => {
  assertSession(rowsOf(SESSION), OBJ, "fixture");
});

const REAL_LOG = process.argv[2];
if (REAL_LOG !== undefined) {
  test(`the real session log replays to the same rows (${REAL_LOG.split("/").at(-2) ?? "log"})`, () => {
    const events = readFileSync(REAL_LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const created = events.find((e) => e.type === "goal/change" && e.data.operation === "create");
    assertSession(rowsOf(events), created.data.goal.objective, "real log");
  });
}

/** One goal tool call + result through the real pipeline, returning the row's view. */
function goalCall(name, text, error, metaCode) {
  const builder = new TimelineBuilder();
  builder.consume(toolCall(1, 1, 1, "c", name, {}));
  const items = builder.consume(
    metaCode === undefined
      ? toolResult(2, 1, 1, "c", text, error)
      : ev(2, "tool/result", { message: { toolCallId: "c", content: [{ type: "text", text }], isError: true }, error: { name: "HarnessError", code: metaCode } }),
  );
  const item = ProviderEventSchema.parse({ type: "timeline.item", sessionId: "s", item: items.find((i) => i.type === "tool_call") }).item;
  return { item, data: view(item) };
}

test("DSH's goalDetail rules: disarmed reads 等待继续, blocked shows its reason, {goal:null} is 没有目标", () => {
  setLocale("zh-CN");
  const disarmed = JSON.stringify({ goal: { id: "g", revision: 1, objective: "o", phase: "active", roundsStarted: 0, maxGoalRounds: 5 }, activation: "disarmed" });
  assert.equal(goalCall("get_goal", disarmed).data.goal.fields[0].value, "等待继续");
  const blocked = JSON.stringify({ goal: { id: "g", revision: 3, objective: "o", phase: "blocked", roundsStarted: 4, maxGoalRounds: 5,
    blockedReason: { code: "model-reported", message: "需要确认能否删除 dist" } }, activation: "armed" });
  assert.deepEqual(goalCall("update_goal", blocked).data.goal.fields, [
    { label: "状态", value: "受阻" }, { label: "执行轮次", value: "4 / 5" }, { label: "受阻原因", value: "需要确认能否删除 dist" },
  ]);
  const none = goalCall("get_goal", JSON.stringify({ goal: null })).data;
  assert.equal(none.goal.empty, true);
  assert.equal(none.summary, "没有目标");
  setLocale("en");
  assert.equal(goalCall("get_goal", disarmed).data.goal.fields[0].value, "Awaiting continuation");
  setLocale("zh-CN");
});

test("a result the card cannot read keeps every byte of it (no silent drop)", () => {
  setLocale("zh-CN");
  const cases = {
    "not json": "goal updated",
    "a phase DSH adds later": JSON.stringify({ goal: { id: "g", revision: 1, objective: "o", phase: "archived", roundsStarted: 0, maxGoalRounds: 5 }, activation: "armed" }),
    "a missing count": JSON.stringify({ goal: { id: "g", revision: 1, objective: "o", phase: "active", maxGoalRounds: 5 }, activation: "armed" }),
    "an unknown activation": JSON.stringify({ goal: { id: "g", revision: 1, objective: "o", phase: "active", roundsStarted: 0, maxGoalRounds: 5 }, activation: "maybe" }),
  };
  for (const [why, text] of Object.entries(cases)) {
    const { data } = goalCall("get_goal", text);
    assert.equal(data.goal, null, `${why}: no card`);
    assert.ok(data.body.includes(text), `${why}: the raw result is still the body`);
    assert.equal(data.hasDetail, true, `${why}: the row still opens`);
  }
  // A failed call never gets the card, even if its text is goal-shaped (DSH's
  // `detailsCardModel` returns null on `isError` first).
  const failedShaped = goalCall("update_goal", goalValue("active"), "GOAL_TOOL_INVALID_UPDATE").data;
  assert.equal(failedShaped.goal, null, "a failed call has no card");
  assert.equal(failedShaped.status, "failed");
  // Only the three goal tools: another tool's goal-shaped output is not a goal.
  assert.equal(goalCall("schedule_list", goalValue("active")).data.goal, null);
});

test("a refusal code the table does not know keeps DSH's verbatim head", () => {
  setLocale("zh-CN");
  for (const code of ["GOAL_STALE_REVISION", "constructor", "toString"]) {
    const { item, data } = goalCall("update_goal", "Error: stale goal ref", undefined, code);
    assert.equal(item.metadata?.errorCode, code);
    assert.equal(data.errorShort, "", `${code}: no words invented`);
    assert.equal(data.errorHint, "", `${code}: no hint invented`);
    assert.equal(data.error, "Error: stale goal ref");
    assert.equal(data.status, "failed");
  }
  // A success never carries a code, even if DSH's payload had an error field.
  const ok = new TimelineBuilder();
  ok.consume(toolCall(1, 1, 1, "c", "get_goal", {}));
  const row = ok.consume(ev(2, "tool/result", { message: { toolCallId: "c", content: [{ type: "text", text: goalValue("active") }] },
    error: { name: "HarnessError", code: "GOAL_TOOL_AUTHORITY_REQUIRED" } })).find((i) => i.type === "tool_call");
  assert.equal(row.metadata?.errorCode, undefined);
  // English has its own short form.
  setLocale("en");
  assert.equal(goalCall("create_goal", "Error: x", "GOAL_TOOL_AUTHORITY_REQUIRED").data.errorShort,
    "Rejected: automatic rounds cannot create or change a goal");
  setLocale("zh-CN");
});

console.log(`${passed} goal tool row checks passed`);
