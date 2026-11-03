/**
 * 目标状态行排在引起它的 `/goal` 命令行**之后**，实时与重放一致，且永远不被吞掉。
 *
 * DSH 对一条 `/goal <目标>` 写 `command/run` → `goal/change` → `command/done`。命令行要等
 * `command/done`（输出在那里）才画，状态行以前在 `goal/change` 就画了，于是「先有目标、后敲
 * 命令」。现在 `TimelineBuilder` 在命令括号打开期间暂存状态行，`command/done` 之后放出。
 *
 * 断言（真实 `DshSession` + 假进程传输；实时 = 进程 handler 喂帧，重放 = `replayHistory()`）：
 *   1. 实时：`/goal` 行在第一条 `goal_state` 行之前，且紧挨着它；
 *   2. 重放同一段历史：行的 id 顺序与实时**逐个相同**，状态行内容深相等；
 *   3. 被 compaction 认领、命令行被丢掉的命令（`/compact`）里发生的 goal 变化仍出状态行；
 *   4. 日志停在括号中间（没有 `command/done`）：重放结束时 `settleRunningTools` 放出状态行；
 *   5. 括号还开着时出了别的行：状态行先于它放出（不为了命令行去挪别人的位置）；
 *   6. 命令失败（`command/done kind:error`）也放出暂存行。
 *
 * 纯离线：不起 dsh、不读凭据。编译产物在私有的 `.dbg-goal-state-order`（`plugin-build.cjs`）。
 *
 * 用法（仓库根目录）：node harness/goal-state-order-check.cjs
 *
 * 动了 `server/timeline.ts` 的 `consume` / `#heldGoalRows` / `settleRunningTools`、命令行
 * （`#commandRun` / `#commandDone`）或 `server/session.ts` 的重放循环必跑。
 */
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { resolvePluginBuild } = require("./plugin-build.cjs");

const compiled = resolvePluginBuild(process.argv[2], ".dbg-goal-state-order");
const processModule = require(path.join(compiled, "server/dsh-process.js"));
const { TimelineBuilder } = require(path.join(compiled, "server/timeline.js"));

const instances = [];

class FakeProcess {
  constructor() {
    this.historyResponse = { available: true, events: [] };
    this.attached = new Map();
    instances.push(this);
  }
  async start() {}
  async shutdown() {}
  kill() {}
  setHandlers(handlers) {
    this.handlers = handlers;
  }
  async attachSession(sessionId, handlers) {
    this.attached.set(sessionId, handlers);
    this.handlers = handlers;
  }
  async closeSession(sessionId) {
    this.attached.delete(sessionId);
  }
  async usage() {
    return { available: false };
  }
  async setConfig(config) {
    return { ...config, reasoningEffort: config.reasoningEffort ?? null };
  }
  async setPlan(active) {
    return { active, pending: false };
  }
  async getPlan() {
    return { active: false, pending: false, available: true };
  }
  async catalog() {
    return { providers: [], models: [], presets: [] };
  }
  async commands() {
    return [];
  }
  async permission() {
    return { current: null, presets: [] };
  }
  async presets() {
    return { presets: [], current: null };
  }
  async sessions() {
    return { sessions: [] };
  }
  async subagents() {
    return { available: true, subagents: [] };
  }
  async history() {
    return this.historyResponse;
  }
  async prompt() {
    return { turnId: "fake-turn" };
  }
  async cancel() {}
  async revert() {
    return undefined;
  }
  async setArchived() {
    return { available: true };
  }
  async runCommand() {
    return { kind: "success" };
  }
  async waitForExit() {
    return true;
  }
}
processModule.DshProcess = FakeProcess;

const { DshSession, modes: advertisedModes } = require(path.join(compiled, "server/session.js"));

function sessionOptions(events, transport, sessionId) {
  return {
    sessionId, cwd: process.cwd(), env: {}, route: { provider: "fixture", model: "alpha" }, mode: "build",
    modes: advertisedModes(), models: [{ id: "fixture/alpha" }], thinkingOptions: [], subsession: false,
    emit: (event) => events.push(event), log() {},
    acquireProcess: async () => ({ process: transport, reused: false }), releaseProcess: () => {},
  };
}

const at = (seq) => Date.UTC(2026, 0, 2, 3, 0, 0) + seq * 1000;
const GOAL = { id: "goal-order-1", revision: 1, objective: "检查主机状态", phase: "active", maxGoalRounds: 256 };
const goalChange = (seq, operation, goal) => ({ type: "goal/change", seq, time: at(seq),
  data: { kind: "goal/change", version: 1, operation, goal, roundsStarted: 0, createdAt: 1, updatedAt: 1 } });
const commandRun = (seq, id, name, args) => ({ type: "command/run", seq, time: at(seq), data: { commandId: id, name, args, source: { kind: "user" } } });
const commandDone = (seq, id, kind, text) => ({ type: "command/done", seq, time: at(seq), data: { commandId: id, kind, text } });

/** The user's `/goal <目标>` then one automatic round, the shape the real log has. */
const SESSION = [
  commandRun(1, "cmd-1", "goal", `  ${GOAL.objective}`),
  goalChange(2, "create", GOAL),
  commandDone(3, "cmd-1", "success", `Goal created\nObjective: ${GOAL.objective}`),
  { type: "turn/start", seq: 4, time: at(4), data: { turn: 1 } },
  { type: "user/message", seq: 5, time: at(5), data: { id: "m-r1", content: [{ type: "text", text: "<goal_round>\n</goal_round>" }],
    source: { kind: "goal", goalId: GOAL.id, revision: 1, round: 1 } } },
  { type: "assistant/message", seq: 6, time: at(6), data: { turn: 1, step: 1, message: { id: "a1", content: [{ type: "text", text: "完成" }] } } },
  goalChange(7, "complete", { ...GOAL, revision: 2, phase: "complete" }),
  { type: "turn/end", seq: 8, time: at(8), data: { turn: 1, reason: { kind: "completed" } } },
];

const items = (events) => events.filter((e) => e.type === "timeline.item").map((e) => e.item);
const ids = (list) => list.map((item) => item.id);

async function live(history, sessionId) {
  const events = [];
  const transport = new FakeProcess();
  const session = new DshSession(sessionOptions(events, transport, sessionId));
  await session.open();
  const handlers = transport.attached.get(sessionId);
  assert.ok(handlers !== undefined, "the session never attached its handlers");
  for (const event of history) handlers.onEvent({ sessionId, event });
  return items(events);
}

async function replay(history, sessionId) {
  const events = [];
  const transport = new FakeProcess();
  transport.historyResponse = { available: true, events: history };
  const session = new DshSession(sessionOptions(events, transport, sessionId));
  await session.open();
  await session.replayHistory();
  return items(events);
}

(async () => {
  // 1. live
  const liveRows = await live(SESSION, "order-live");
  const command = liveRows.findIndex((item) => item.id === "command:cmd-1");
  const state = liveRows.findIndex((item) => item.name === "goal_state");
  assert.ok(command >= 0 && state >= 0, `live rows: ${JSON.stringify(ids(liveRows))}`);
  assert.ok(command < state, `live: the /goal row must come before the state row, got ${JSON.stringify(ids(liveRows))}`);
  assert.equal(state, command + 1, "live: the state row follows its command row directly");
  console.log("PASS live: /goal row, then its state row");

  // 2. replay — the same order, the same rows
  const replayRows = await replay(SESSION, "order-replay");
  const order = (list) => ids(list).filter((id) => id.startsWith("command:") || id.startsWith("tool:goal:"));
  assert.deepEqual(order(replayRows), order(liveRows), "replay must draw the goal rows in the live order");
  const firstState = (list) => list.find((item) => item.name === "goal_state");
  assert.deepEqual(firstState(replayRows), firstState(liveRows), "and the same state row");
  console.log("PASS replay: same order and same state row as live");

  // 3. a compaction-claimed command drops its own row, never the held state row
  const compact = [
    // The goal change lands after the compaction's own rows, so nothing but the
    // (dropped) `command/done` can release it.
    commandRun(1, "cmd-c", "compact", ""),
    { type: "compaction/start", seq: 2, time: at(2), data: { compactionId: "cp-1", trigger: "manual" } },
    { type: "compaction/end", seq: 3, time: at(3), data: { compactionId: "cp-1", sourceCommandId: "cmd-c" } },
    goalChange(4, "pause", { ...GOAL, phase: "paused" }),
    commandDone(5, "cmd-c", "success", "compacted"),
  ];
  for (const [label, rows] of [["live", await live(compact, "order-compact-live")], ["replay", await replay(compact, "order-compact-replay")]]) {
    assert.ok(!rows.some((item) => item.id === "command:cmd-c"), `${label}: the claimed /compact row is still dropped`);
    assert.ok(rows.some((item) => item.name === "goal_state" && /已暂停|paused/.test(item.detail.label)),
      `${label}: the state row survived the dropped command row: ${JSON.stringify(ids(rows))}`);
  }
  console.log("PASS a compaction-claimed command still releases its state row");

  // 4. a log cut inside the bracket: replay's settle releases it
  const cut = [commandRun(1, "cmd-x", "goal", "clear"), goalChange(2, "pause", { ...GOAL, phase: "paused" })];
  const cutRows = await replay(cut, "order-cut");
  assert.ok(cutRows.some((item) => item.name === "goal_state"), `a log that stops mid-bracket still shows the state: ${JSON.stringify(ids(cutRows))}`);
  const builder = new TimelineBuilder({ warn() {} });
  for (const event of cut) assert.deepEqual(builder.consume(event), [], "held while the bracket is open");
  assert.equal(builder.settleRunningTools().filter((item) => item.name === "goal_state").length, 1, "settle releases exactly one state row");
  assert.equal(builder.settleRunningTools().length, 0, "and settle is idempotent");
  console.log("PASS a log cut mid-bracket releases the state row at settle");

  // 5. another row while the bracket is open goes out after the held state row
  const fresh = new TimelineBuilder({ warn() {} });
  fresh.consume(commandRun(1, "cmd-m", "goal", "x"));
  fresh.consume(goalChange(2, "create", GOAL));
  const out = fresh.consume({ type: "tool/call", seq: 3, data: { callId: "t1", name: "bash", arguments: { command: "ls" } } });
  assert.deepEqual(out.map((item) => item.name), ["goal_state", "bash"], "the held state row goes first, where it was written");
  console.log("PASS a row drawn mid-bracket does not overtake the held state row");

  // 6. a failed command still releases it
  const failed = new TimelineBuilder({ warn() {} });
  failed.consume(commandRun(1, "cmd-f", "goal", "x"));
  failed.consume(goalChange(2, "create", GOAL));
  const failedOut = failed.consume(commandDone(3, "cmd-f", "error", "boom"));
  assert.deepEqual(failedOut.map((item) => [item.id, item.status]), [["command:cmd-f", "failed"], ["tool:goal:current", "completed"]]);
  console.log("PASS a failed command row, then the state row");

  console.log("goal state order checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
