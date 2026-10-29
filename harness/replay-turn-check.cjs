/**
 * 重放路径的 turnId 断言：`replayHistory()` 必须用 `session.turn` 把 DSH 的
 * `turn/start`…`turn/end` 括号重放出来。
 *
 * 为什么这件事只能在这里断言：Paseo 0.14 的「折叠轮次」靠 `turnId` 划分回合
 * （`packages/protocol/src/timeline-turn.ts` 的 `continuesTimelineTurn`），而
 * Paseo 给行打 turnId 的唯一位置是 `plugin-provider.ts` 的 `translateTimeline`：
 * `turnId: this.currentTurnId ?? undefined`，`currentTurnId` **只由 `session.turn`
 * 事件设置**。缺 turnId 时 `continuesTimelineTurn` 退回
 * `return !nextIsTrigger`，把每条 `user_message` 都当回合起点 —— 一条本属同一
 * 回合的历史被切成若干「没有回复的伪回合」，`collapseTurns` 的
 * `replyIndex <= runStart` 成立，于是不折叠。实时路径一直发 `session.turn`；
 * 重放路径以前一条都不发，所以**只有重开过的会话不折叠**。
 *
 * 断言打在协议层而不是界面：界面错了不报错，只会静默不折叠。
 *
 * 用法（在仓库根目录）：
 *   node harness/replay-turn-check.cjs
 *
 * 纯离线：假桥喂一段含两个 `turn/start`→`user/message`→`assistant/message`→
 * `turn/end` 的历史，驱动编译后的真实 `DshSession.replayHistory()`。不启动模型、
 * 不读凭据、不碰正式会话；编译产物落在私有的 `.dbg-replay-turn` 目录
 * （见 `harness/plugin-build.cjs`）。
 */
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { existsSync } = require("node:fs");
const { resolvePluginBuild } = require("./plugin-build.cjs");

const compiled = resolvePluginBuild(process.argv[2], ".dbg-replay-turn");
const processModule = require(path.join(compiled, "server/dsh-process.js"));

/**
 * 从编译目录往上找到仓库里的一个模块，按绝对路径 require。
 *
 * 撤回折叠必须用**桥的真实实现**（`dsh-bridge/lib/surface.js`），否则这条断言
 * 就只是在验证自己写的折叠函数。编译目录在 `paseo-plugin/<dir>` 下，往上走到
 * 仓库根就能拿到它；`node` 对 ESM 文件的 `require` 在 Node 22 上可用（桥的
 * `package.json` 是 `"type": "module"`，同步 require ESM 需要 22+）。
 */
function findRepoModule(relative) {
  let dir = compiled;
  for (let i = 0; i < 4; i += 1) {
    const candidate = path.join(dir, relative);
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`could not find ${relative} above ${compiled}`);
}

const instances = [];

/**
 * 进程替身。
 *
 * `DshSession` 通过替换模块级 `DshProcess` 来驱动，整个类被换掉，所以会话可能
 * 触达的每个方法都必须存在 —— 否则会抛一个看着像回归、其实是 stub 不全的
 * TypeError。这里只让 `history()` 有实际内容，其余按形状返回空值。
 */
class FakeProcess {
  constructor(options) {
    this.options = options;
    this.historyResponse = { available: true, events: [] };
    this.running = true;
    instances.push(this);
  }
  async start() {}
  async shutdown() {
    this.running = false;
  }
  kill() {
    this.running = false;
  }
  setHandlers(handlers) {
    this.handlers = handlers;
  }
  async attachSession(sessionId, handlers) {
    this.attached ??= new Map();
    this.attached.set(sessionId, handlers);
    this.handlers = handlers;
  }
  async closeSession(sessionId) {
    this.attached?.delete(sessionId);
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
const { DshSession } = require(path.join(compiled, "server/session.js"));

/**
 * 一段两个回合的 DSH 历史。
 *
 * 形状照真实日志：`turn/start` 开括号、`user/message`（`source.kind === "user"`
 * 才是人写的）、`assistant/message` 带 `message.id`、`turn/end` 带 `reason`。
 * 第二个回合的 `turn` 号与第一个不同 —— 正是这一点让「两个回合 turnId 必须
 * 不同」可以被断言。
 */
const turnOneStart = Date.UTC(2026, 0, 2, 3, 4, 5);
const historyEvents = [
  { type: "turn/start", seq: 1, time: turnOneStart, data: { turn: 1 } },
  {
    type: "user/message",
    seq: 2,
    time: turnOneStart + 1000,
    data: { id: "msg-1", source: { kind: "user" }, content: [{ type: "text", text: "第一个问题" }] },
  },
  {
    type: "assistant/message",
    seq: 3,
    time: turnOneStart + 2000,
    data: { turn: 1, step: 1, message: { id: "assistant-1", content: [{ type: "text", text: "第一个回答" }] } },
  },
  { type: "turn/end", seq: 4, time: turnOneStart + 3000, data: { turn: 1, reason: { kind: "completed" } } },
  { type: "turn/start", seq: 5, time: turnOneStart + 10000, data: { turn: 2 } },
  {
    type: "user/message",
    seq: 6,
    time: turnOneStart + 11000,
    data: { id: "msg-2", source: { kind: "user" }, content: [{ type: "text", text: "第二个问题" }] },
  },
  {
    type: "assistant/message",
    seq: 7,
    time: turnOneStart + 12000,
    data: { turn: 2, step: 1, message: { id: "assistant-2", content: [{ type: "text", text: "第二个回答" }] } },
  },
  { type: "turn/end", seq: 8, time: turnOneStart + 13000, data: { turn: 2, reason: { kind: "completed" } } },
];

/**
 * 用 Paseo 自己的规则给重放出来的行打 turnId。
 *
 * 逐字复刻 `plugin-provider.ts`：`translateTurn` 在 `state === "started"` 时把
 * `currentTurnId` 设为该 turnId，任何非 started 的终态在 id 匹配时清空它；
 * `translateTimeline` 每条行取 `turnId: currentTurnId ?? undefined`。所以下面
 * 得到的 `turnId` 就是真机上客户端会看到的那个值 —— 这个脚本断言的是它，不是
 * 插件内部状态。
 *
 * @param {Array<{type: string, [key: string]: unknown}>} events - replayHistory 发出的事件
 * @returns {{items: Array<{item: {id?: string, type: string}, turnId: string | undefined}>, unclosed: string | undefined}}
 */
function applyPaseoTurnRule(events) {
  let currentTurnId;
  const items = [];
  let openStarts = 0;
  const terminals = [];
  for (const event of events) {
    if (event.type === "session.turn") {
      if (event.state === "started") {
        currentTurnId = event.turnId;
        openStarts += 1;
        continue;
      }
      terminals.push(event.turnId);
      if (currentTurnId === event.turnId) currentTurnId = undefined;
      openStarts -= 1;
      continue;
    }
    if (event.type === "timeline.item") {
      items.push({ item: event.item, turnId: currentTurnId });
    }
  }
  assert.equal(openStarts, 0, `重放结束时仍有未闭合的 started（净 ${String(openStarts)} 个）`);
  return { items, terminals, unclosed: currentTurnId };
}

(async () => {
  const events = [];
  const sharedTransport = new FakeProcess({ sessionId: "__paseo_shared_process__" });
  sharedTransport.historyResponse = { available: true, events: historyEvents };
  const session = new DshSession({
    sessionId: "replay-turn-check",
    cwd: process.cwd(),
    env: {},
    route: { provider: "fixture", model: "alpha" },
    mode: "build",
    models: [{ id: "fixture/alpha" }],
    thinkingOptions: [],
    emit: (e) => events.push(e),
    log() {},
    acquireProcess: async () => ({ process: sharedTransport, reused: false }),
    releaseProcess: () => {},
  });
  await session.open();
  await session.replayHistory();

  const { items, terminals, unclosed } = applyPaseoTurnRule(events);

  assert.ok(items.length > 0, "重放没有发出任何 timeline.item");
  assert.equal(
    terminals.length,
    2,
    `应恰好闭合两个重放回合，实际终态 ${String(terminals.length)} 个：${JSON.stringify(terminals)}`,
  );
  assert.equal(unclosed, undefined, "重放结束后 Paseo 的 currentTurnId 必须被清空");
  console.log("PASS 重放的两个 turn/start…turn/end 都被 session.turn 闭合");

  // 每个行都必须落在某个 started…终态区间内：有一条落在区间外，客户端就会按
  // trigger 兜底把它当成新回合的起点。
  const outside = items.filter((entry) => entry.turnId === undefined);
  assert.equal(
    outside.length,
    0,
    `有 ${String(outside.length)} 条 timeline.item 落在任何 session.turn 区间之外：`
      + JSON.stringify(outside.map((entry) => entry.item.id ?? entry.item.type)),
  );
  console.log(`PASS ${String(items.length)} 条重放行全部被夹在 started…终态之间`);

  // 两个回合的 turnId 必须不同，否则客户端会把两段历史并成一段（或者反过来，
  // 一段被同一 id 切碎）。这是「按回合折叠」的前提。
  const turnIds = [...new Set(items.map((entry) => entry.turnId))];
  assert.equal(turnIds.length, 2, `应有 2 个不同的 turnId，实际 ${JSON.stringify(turnIds)}`);
  console.log(`PASS 两个回合的 turnId 不同：${JSON.stringify(turnIds)}`);

  // 归属也要对：每个回合的用户消息与助手回复必须落在同一个 turnId 下，且第一个
  // 回合的行不能跑到第二个回合的 id 里。
  const firstTurn = items.filter((entry) => entry.turnId === turnIds[0]);
  const secondTurn = items.filter((entry) => entry.turnId === turnIds[1]);
  const textOf = (entry) => JSON.stringify(entry.item);
  assert.ok(
    firstTurn.some((entry) => textOf(entry).includes("第一个问题")) &&
      firstTurn.some((entry) => textOf(entry).includes("第一个回答")),
    "第一个回合的用户消息与助手回复不在同一个 turnId 下",
  );
  assert.ok(
    secondTurn.some((entry) => textOf(entry).includes("第二个问题")) &&
      secondTurn.some((entry) => textOf(entry).includes("第二个回答")),
    "第二个回合的用户消息与助手回复不在同一个 turnId 下",
  );
  console.log("PASS 每个回合的 user_message 与 assistant_message 归属同一个 turnId");

  // turnId 必须由 DSH 自己的回合号派生、且可复现：同一个日志重放两次得到同一
  // 组 id，否则每次重开都像是一批新回合，接口幂等性也就没了。
  assert.deepEqual(
    turnIds,
    ["turn:history:1", "turn:history:2"],
    `turnId 应稳定派生自 DSH 回合号，实际 ${JSON.stringify(turnIds)}`,
  );
  console.log("PASS turnId 稳定派生自 DSH 回合号（重开可复现）");

  // ---- 一个「行全被撤回」的回合不得发出任何 session.turn ------------------
  //
  // `turn/start` 是 log-only 括号，DSH 从不把它写成 surface 节点，所以桥的
  // 撤回折叠（`dsh-bridge/lib/surface.js` 的 `visibleEvents`，`SURFACE_EVENT_TYPES`
  // 里没有 `turn/start`）删不掉它。以前重放看到它就立刻发 `started`，日志又正好
  // 在这里结束，收口逻辑再补一条 `canceled` —— 每撤回一次就多一个「空回合」，
  // 而且每次重开都重来一遍。宿主把它翻译成 `turn_started`/`turn_canceled` 一对，
  // 终态走 `applyActiveTurnTerminal` 落到 `"untracked"`，还会把 agent 的
  // `lifecycle` 压回 idle、清掉 `lastError`（`agent-manager.js`）。
  //
  // 输入不是手写的理想序列：一段真实的两回合日志 + 一条真实撤回标记，交给真实的
  // `visibleEvents` 折叠。
  console.log("\n一个被撤回的回合（可见日志里只剩 turn/start）不发任何 session.turn");
  {
    const { visibleEvents } = require(findRepoModule("dsh-bridge/lib/surface.js"));
    const at = (seq) => Date.UTC(2026, 0, 2, 3, 0, 0) + seq * 1000;
    const raw = [
      { seq: 1, type: "turn/start", time: at(1), data: { turn: 1 } },
      { seq: 2, type: "user/message", time: at(2), surfaceOp: "append", data: { id: "m1", source: { kind: "user" }, content: [{ type: "text", text: "第一个问题" }] } },
      { seq: 3, type: "assistant/message", time: at(3), surfaceOp: "append", data: { turn: 1, step: 1, message: { id: "a1", content: [{ type: "text", text: "第一个回答" }] } } },
      { seq: 4, type: "turn/end", time: at(4), data: { turn: 1, reason: { kind: "completed" } } },
      { seq: 5, type: "turn/start", time: at(5), data: { turn: 2 } },
      { seq: 6, type: "user/message", time: at(6), surfaceOp: "append", data: { id: "m2", source: { kind: "user" }, content: [{ type: "text", text: "第二个问题（被撤回）" }] } },
      { seq: 7, type: "assistant/message", time: at(7), surfaceOp: "append", data: { turn: 2, step: 1, message: { id: "a2", content: [{ type: "text", text: "第二个回答（被撤回）" }] } } },
      { seq: 8, type: "turn/end", time: at(8), data: { turn: 2, reason: { kind: "completed" } } },
      {
        seq: 9,
        type: "user/message",
        time: at(9),
        surfaceOp: { op: "replace", startSeq: 6, endSeq: 7 },
        data: { id: "marker", source: { kind: "paseo-rewind" }, content: [{ type: "text", text: "(empty message)" }] },
      },
    ];
    const folded = visibleEvents(raw);
    const foldedTypes = folded.map((event) => `${String(event.seq)}:${event.type}`);
    // 前提：折叠确实把第二回合的行删掉了，只留下它的 turn/start（这条不成立就
    // 说明输入或折叠变了，后面的断言也就测不到那个缺陷）。
    assert.ok(
      foldedTypes.includes("5:turn/start") &&
        !foldedTypes.includes("6:user/message") &&
        !foldedTypes.includes("7:assistant/message"),
      `撤回折叠的输入不成立，可见日志是 ${JSON.stringify(foldedTypes)}`,
    );

    const phantomEvents = [];
    const phantomTransport = new FakeProcess({ sessionId: "__paseo_shared_process__" });
    phantomTransport.historyResponse = { available: true, events: folded };
    const phantomSession = new DshSession({
      sessionId: "replay-turn-phantom",
      cwd: process.cwd(),
      env: {},
      route: { provider: "fixture", model: "alpha" },
      mode: "build",
      models: [{ id: "fixture/alpha" }],
      thinkingOptions: [],
      emit: (e) => phantomEvents.push(e),
      log() {},
      acquireProcess: async () => ({ process: phantomTransport, reused: false }),
      releaseProcess: () => {},
    });
    await phantomSession.open();
    await phantomSession.replayHistory();

    // 回合号 -> 它名下有几行（按 Paseo 的 currentTurnId 规则归属）。
    const rowsPerTurn = new Map();
    let current;
    for (const event of phantomEvents) {
      if (event.type === "session.turn") {
        current = event.state === "started" ? event.turnId : undefined;
        continue;
      }
      if (event.type === "timeline.item" && current !== undefined) {
        rowsPerTurn.set(current, (rowsPerTurn.get(current) ?? 0) + 1);
      }
    }
    const startedIds = phantomEvents
      .filter((event) => event.type === "session.turn" && event.state === "started")
      .map((event) => event.turnId);
    assert.deepEqual(
      [...rowsPerTurn.keys()].sort(),
      ["turn:history:1"],
      `可见日志里只有第一个回合还有行，实际有行的回合是 ${JSON.stringify([...rowsPerTurn.keys()])}`,
    );
    assert.deepEqual(
      startedIds,
      ["turn:history:1"],
      `只有有行的回合才该发 started，实际 ${JSON.stringify(startedIds)}（被撤回的回合留下了 turn/start）`,
    );
    assert.ok(
      !phantomEvents.some((event) => event.type === "session.turn" && event.turnId === "turn:history:2"),
      `被撤回的回合发了 session.turn：${JSON.stringify(
        phantomEvents.filter((event) => event.type === "session.turn").map((event) => [event.turnId, event.state]),
      )}`,
    );
    // 终态也只在发过 started 时才有：一对不配对的 canceled 同样是空回合。
    const phantomTerminals = phantomEvents
      .filter((event) => event.type === "session.turn" && event.state !== "started")
      .map((event) => [event.turnId, event.state]);
    assert.deepEqual(phantomTerminals, [["turn:history:1", "completed"]], `终态应只有第一回合，实际 ${JSON.stringify(phantomTerminals)}`);
    // Paseo 的折叠规则跑一遍：没有悬挂的 started，没有落在区间外的行。
    const phantomRule = applyPaseoTurnRule(phantomEvents);
    assert.equal(phantomRule.unclosed, undefined, "重放结束后 Paseo 的 currentTurnId 必须被清空");
    assert.equal(
      phantomRule.items.filter((entry) => entry.turnId === undefined).length,
      0,
      "有行落在任何 session.turn 区间之外",
    );
    console.log("PASS 被撤回的回合（可见日志里只剩 turn/start）不发任何 session.turn");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
