/**
 * 自动续跑 goal 轮次在时间线上的那一行：实时与重放必须是同一行。
 *
 * DSH 的 round driver 把每一轮续跑排成一条 `user/message`，来源标成 goal
 * （`GoalMessageSource`: kind/goalId/revision/round）。它既不是人类提问，也不能
 * 显示 `<goal_round>` 提示原文，于是 Paseo 为每一轮画一行紧凑状态行
 * （`tool_call` + `plain_text`，与 `tool:goal:current` 同家族）。这个脚本钉的是
 * **实时与重放的一致性**，因为两者走的是两条不同的代码路径：
 *
 *   - 实时：`DshSession.#onSessionEvent` → `TimelineBuilder.consume` → `timeline.item`；
 *   - 重放：`DshSession.replayHistory` / `DshChildSession.replay` 的 `user/message`
 *     过滤必须先放行 goal 轮次，再交给同一个 builder。
 *
 * 断言：
 *   1. 真实 `DshSession` 的实时事件路径为 goal 轮次出一行：id
 *      `tool:goal:round:<goalId>:<round>`、name `goal_round`、status completed、
 *      文本是 locale 的「第 N 轮」半段、无 body、无 revertToken；
 *   2. 真实 `replayHistory()` 重放同一段历史，得到**深相等**的同一行，且不为它出
 *      `user_message`；人类消息仍照旧重放；
 *   3. 这一行落在它自己的回合里（`turn:history:<turn>`），说明它触发了该回合的
 *      `session.turn started` —— 否则客户端会把它当成一条没有 turnId 的伪行；
 *   4. 子会话的两条路径（`DshChildSession.event` 实时 / `.replay` 重放）同样出这一行，
 *      且与根会话的行一致：子会话重放里 goal 轮次不能被静默丢掉；
 *   5. 同一事件重复喂给 builder 得到同一行（重开不叠行），不同轮次 id 不同。
 *
 * 纯离线：假进程传输，不启动模型、不读凭据、不碰正式会话。编译产物落在私有的
 * `.dbg-goal-timeline` 目录（见 `harness/plugin-build.cjs`）。
 *
 * 用法（在仓库根目录）：
 *   node harness/goal-timeline-check.cjs
 *
 * 动了 `server/activity-timeline.ts` 的 goal 轮次行、`server/session.ts` 的重放
 * 过滤，或 `server/locale.ts` 的 `goalRound` 文案必跑。
 */
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { resolvePluginBuild } = require("./plugin-build.cjs");

const compiled = resolvePluginBuild(process.argv[2], ".dbg-goal-timeline");
const processModule = require(path.join(compiled, "server/dsh-process.js"));
const { TimelineBuilder } = require(path.join(compiled, "server/timeline.js"));
const { LOCALE } = require(path.join(compiled, "server/locale.js"));

/**
 * 进程替身。
 *
 * `DshSession` 通过替换模块级 `DshProcess` 驱动，整个类被换掉，所以会话可能触达
 * 的每个方法都必须存在。这里只让 `history()` 有内容、`attachSession()` 记住 handlers
 * （实时路径要从这里喂帧），其余按形状返回空值。
 */
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

const {
  DshSession,
  DshChildSession,
  modes: advertisedModes,
} = require(path.join(compiled, "server/session.js"));

/** 轮次行的「第 N 轮」半段：服务端文案表按 LOCALE 冻结成字面量。 */
const ROUND = {
  "zh-CN": (round) => `第 ${round} 轮`,
  en: (round) => String(round),
}[LOCALE];

const prompt = '<goal_round>\nObjective: "SHIP-THE-RENDERER"\nRound: 1/2\n</goal_round>';
const GOAL_ID = "goal-1";
const ROUND_ID = "tool:goal:round:goal-1:1";

/** DSH 记录的那条 goal 轮次消息（形状照真实日志）。 */
const goalRoundEvent = {
  type: "user/message",
  seq: 6,
  data: {
    id: "msg-round-1",
    source: { kind: "goal", goalId: GOAL_ID, revision: 1, round: 1 },
    content: [{ type: "text", text: prompt }],
  },
};

const at = (seq) => Date.UTC(2026, 0, 2, 3, 0, 0) + seq * 1000;

/** 一段真实形状的历史：人类回合，然后是自动续跑的第 1 轮。 */
const historyEvents = [
  { type: "turn/start", seq: 1, time: at(1), data: { turn: 1 } },
  {
    type: "user/message",
    seq: 2,
    time: at(2),
    data: { id: "msg-human", source: { kind: "user" }, content: [{ type: "text", text: "开始吧" }] },
  },
  {
    type: "assistant/message",
    seq: 3,
    time: at(3),
    data: { turn: 1, step: 1, message: { id: "assistant-1", content: [{ type: "text", text: "好的" }] } },
  },
  { type: "turn/end", seq: 4, time: at(4), data: { turn: 1, reason: { kind: "completed" } } },
  { type: "turn/start", seq: 5, time: at(5), data: { turn: 2 } },
  // The stored event carries its own durable time; the live frame does not need
  // one (Paseo stamps live rows on arrival).
  { ...goalRoundEvent, time: at(6) },
  {
    type: "assistant/message",
    seq: 7,
    time: at(7),
    data: { turn: 2, step: 1, message: { id: "assistant-2", content: [{ type: "text", text: "ROUND1_OK" }] } },
  },
  { type: "turn/end", seq: 8, time: at(8), data: { turn: 2, reason: { kind: "completed" } } },
];

/**
 * 用 Paseo 自己的规则给重放出来的行打 turnId（逐字复刻宿主
 * `plugin-provider.ts` 的 `translateTurn` / `translateTimeline`）：`started` 设置
 * `currentTurnId`，任何终态清空它，`timeline.item` 取当前值。
 */
function applyPaseoTurnRule(events) {
  let currentTurnId;
  const items = [];
  let openStarts = 0;
  for (const event of events) {
    if (event.type === "session.turn") {
      if (event.state === "started") {
        currentTurnId = event.turnId;
        openStarts += 1;
      } else {
        if (currentTurnId === event.turnId) currentTurnId = undefined;
        openStarts -= 1;
      }
      continue;
    }
    if (event.type === "timeline.item") items.push({ item: event.item, turnId: currentTurnId });
  }
  assert.equal(openStarts, 0, `重放结束时仍有未闭合的 started（净 ${String(openStarts)} 个）`);
  return items;
}

function sessionOptions(events, transport, overrides = {}) {
  return {
    sessionId: "goal-timeline-check",
    cwd: process.cwd(),
    env: {},
    route: { provider: "fixture", model: "alpha" },
    mode: "build",
    modes: advertisedModes(),
    models: [{ id: "fixture/alpha" }],
    thinkingOptions: [],
    subsession: false,
    emit: (event) => events.push(event),
    log() {},
    acquireProcess: async () => ({ process: transport, reused: false }),
    releaseProcess: () => {},
    ...overrides,
  };
}

const childOptions = (events, overrides = {}) => ({
  id: "child-provider-id",
  nativeId: "child-native-id",
  subsession: true,
  cwd: process.cwd(),
  closed: () => false,
  emit: (event) => events.push(event),
  log() {},
  resolvePermission() {},
  ...overrides,
});

/** 只保留本脚本关心的行，失败信息才看得懂。 */
const rows = (events) => events.filter((event) => event.type === "timeline.item");

(async () => {
  // ---- 1/2. 真实实时路径 vs 真实重放路径 ---------------------------------
  //
  // 实时：打开一个空历史的会话，从假进程的 handler 喂一帧 goal 轮次事件 —— 这就是
  // 桥把 `session.event` 交给会话时走的同一条路。
  const liveEvents = [];
  const liveTransport = new FakeProcess();
  const liveSession = new DshSession(sessionOptions(liveEvents, liveTransport));
  await liveSession.open();
  const handlers = liveTransport.attached.get("goal-timeline-check");
  assert.ok(handlers !== undefined, "会话没有把 handlers 挂到进程上，实时路径喂不进去");
  handlers.onEvent({ sessionId: "goal-timeline-check", event: goalRoundEvent });
  const liveRows = rows(liveEvents).filter((event) => event.item.name === "goal_round");
  assert.equal(liveRows.length, 1, `实时路径应恰好出一行，实际 ${JSON.stringify(rows(liveEvents).map((e) => e.item.id))}`);
  const liveItem = liveRows[0].item;
  assert.equal(liveItem.type, "tool_call");
  assert.equal(liveItem.id, ROUND_ID);
  assert.equal(liveItem.callId, "goal:round:goal-1:1");
  assert.equal(liveItem.status, "completed");
  assert.equal(liveItem.detail.type, "plain_text");
  assert.equal(liveItem.detail.label, ROUND(1));
  // No protocol icon key: the client draws a `plain_text` row that names no
  // glyph with the tool's own (Target, same as the goal state row and the pill);
  // the rendered glyph is pinned by `harness/tool-call-check.cjs`.
  assert.equal(liveItem.detail.icon, undefined);
  assert.equal(liveItem.detail.text, undefined, "轮次行不该带 body（<goal_round> 原文不能显示）");
  assert.equal(liveItem.metadata.locale, LOCALE);
  assert.equal(liveItem.revertToken, undefined, "轮次行不能被撤回选中");
  assert.ok(!JSON.stringify(liveItem).includes("SHIP-THE-RENDERER"), "轮次行泄漏了 <goal_round> 提示原文");
  assert.ok(
    !rows(liveEvents).some((event) => event.item.type === "user_message"),
    "goal 轮次在实时路径上不该出 user_message 行",
  );
  console.log("PASS 实时路径为 goal 轮次出唯一一行 tool_call（goal_round）");

  // 重放：同一段历史（含那个轮次事件）交给真实 `replayHistory()`。
  const replayEvents = [];
  const replayTransport = new FakeProcess();
  replayTransport.historyResponse = { available: true, events: historyEvents };
  const replaySession = new DshSession(
    sessionOptions(replayEvents, replayTransport, { sessionId: "goal-timeline-replay" }),
  );
  await replaySession.open();
  await replaySession.replayHistory();
  const replayRows = rows(replayEvents).filter((event) => event.item.name === "goal_round");
  assert.equal(
    replayRows.length,
    1,
    `重放应恰好出一行 goal_round，实际 ${JSON.stringify(rows(replayEvents).map((e) => e.item.id))}`,
  );
  const replayItem = replayRows[0].item;
  assert.deepEqual(replayItem, liveItem, "实时与重放必须是同一行（同 id 同内容）");
  assert.equal(replayRows[0].timestamp, new Date(at(6)).toISOString(), "重放行应带 DSH 的持久事件时间");
  console.log("PASS 重放同一段历史得到深相等的同一行");

  // 人类消息照旧重放成 user_message（不能被这次改动带走），轮次原文与 objective
  // 不出现在任何一行里。
  const userRows = rows(replayEvents).filter((event) => event.item.type === "user_message");
  assert.equal(userRows.length, 1, `应只重放人类那一条 user_message，实际 ${JSON.stringify(userRows.map((e) => e.item.text))}`);
  assert.equal(userRows[0].item.text, "开始吧");
  assert.equal(userRows[0].item.revertToken.messageId, "msg-human", "人类行必须保留撤回令牌");
  const allRows = JSON.stringify(rows(replayEvents).map((event) => event.item));
  assert.ok(!allRows.includes("<goal_round>") && !allRows.includes("SHIP-THE-RENDERER"), "重放泄漏了轮次提示原文");
  console.log("PASS 人类消息照旧重放，轮次提示原文不进时间线");

  // ---- 3. 轮次行落在自己的回合里 -----------------------------------------
  const attributed = applyPaseoTurnRule(replayEvents);
  const entry = attributed.find((candidate) => candidate.item === replayItem);
  assert.ok(entry !== undefined, "轮次行没有出现在 Paseo 的行序列里");
  assert.equal(entry.turnId, "turn:history:2", `轮次行应落在第 2 个回合，实际 turnId=${String(entry.turnId)}`);
  // 它是该回合的首行，所以 `session.turn started` 必须紧贴其前 —— 否则客户端拿不到
  // turnId，会把它当成一条没有回合归属的行。
  const rowIndex = replayEvents.findIndex((event) => event.item === replayItem);
  const before = replayEvents[rowIndex - 1];
  assert.ok(
    before !== undefined && before.type === "session.turn" && before.state === "started",
    `轮次行前应紧邻 session.turn started，实际 ${JSON.stringify(before)}`,
  );
  assert.equal(before.turnId, "turn:history:2");
  console.log("PASS 轮次行是该回合首行、落在自己的 turnId 区间内");

  // ---- 4. 子会话的两条路径同样出这一行 -----------------------------------
  //
  // 子会话重放以前和其它非人类来源一样直接 `continue`，于是实时能出的行重开后消失。
  const childLiveEvents = [];
  const childLive = new DshChildSession(childOptions(childLiveEvents));
  childLive.event({ type: "user/message", seq: 1, data: goalRoundEvent.data });
  const childLiveRows = rows(childLiveEvents).filter((event) => event.item.name === "goal_round");
  assert.equal(childLiveRows.length, 1, `子会话实时路径应出一行，实际 ${JSON.stringify(childLiveEvents.map((e) => e.type))}`);

  const childReplayEvents = [];
  const childReplay = new DshChildSession(childOptions(childReplayEvents));
  childReplay.replay(historyEvents.filter((event) => event.seq !== 2 && event.seq !== 3));
  const childReplayRows = rows(childReplayEvents).filter((event) => event.item.name === "goal_round");
  assert.equal(
    childReplayRows.length,
    1,
    `子会话重放应出一行，实际 ${JSON.stringify(rows(childReplayEvents).map((e) => e.item.id))}`,
  );
  assert.deepEqual(childReplayRows[0].item, childLiveRows[0].item, "子会话实时与重放必须是同一行");
  assert.deepEqual(childLiveRows[0].item, liveItem, "子会话的轮次行与根会话的行一致");
  assert.ok(
    !rows(childReplayEvents).some((event) => event.item.type === "user_message"),
    "子会话重放里 goal 轮次不该出 user_message 行",
  );
  console.log("PASS 子会话实时与重放出同一行（重放不再静默丢掉 goal 轮次）");

  // ---- 5. 幂等：同一轮重复消费不叠行，不同轮不同 id -----------------------
  const builder = new TimelineBuilder({ warn: () => {} });
  const first = builder.consume({ type: "user/message", seq: 1, data: goalRoundEvent.data })[0];
  const second = builder.consume({ type: "user/message", seq: 1, data: goalRoundEvent.data })[0];
  assert.deepEqual(second, first, "同一轮重复消费必须得到同一行（重开不叠行）");
  const next = builder.consume({
    type: "user/message",
    seq: 2,
    data: {
      id: "msg-round-2",
      source: { kind: "goal", goalId: GOAL_ID, revision: 1, round: 2 },
      content: [{ type: "text", text: prompt }],
    },
  })[0];
  assert.equal(next.id, "tool:goal:round:goal-1:2", "不同轮次必须不同 id");
  assert.notEqual(next.id, first.id);
  console.log("PASS 同一轮幂等、不同轮次 id 不同");

  console.log("\ngoal timeline checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
