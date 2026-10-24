/**
 * 上下文上报边界回归：运行编译后的真实 DshSession，只替换进程传输。
 * 用法：node harness/context-usage-check.cjs [编译输出目录]
 *
 * 不给目录时自动编译到 `paseo-plugin/.dbg-t5-context`（见
 * `harness/plugin-build.cjs`：产物必须在仓库内，否则 node 从 /tmp 向上找不到
 * `paseo-plugin/node_modules`）。不启动模型、不读取凭据、不操作正式会话。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { resolvePluginBuild } = require('./plugin-build.cjs');

const compiled = resolvePluginBuild(process.argv[2], '.dbg-t5-context');
const processModule = require(path.join(compiled, 'server/dsh-process.js'));
const instances = [];

/**
 * The transport stand-in.
 *
 * `DshSession` is driven through a module-level replacement of `DshProcess`
 * (the constructor takes no process factory yet — that injection is the
 * `DshSessionOptions.createProcess?` contract T3 owns). Because the whole class
 * is replaced, **every method the session (or a caller of it) may reach has to
 * exist here**, or the check dies with a TypeError that looks like a regression
 * but is really an incomplete stub. The stubs below answer the shape each method
 * returns without asserting anything about it — this file is about context
 * usage, and the other surfaces have their own checks.
 */
class FakeProcess {
  constructor(options) {
    this.options = options;
    this.snapshot = { available: true, contextWindow: 64000, usedTokens: 1024 };
    this.reads = 0;
    this.running = true;
    this.planWrites = [];
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
  /**
   * Attach one session's handlers.
   *
   * `DshSession.open()` no longer spawns: it asks `acquireProcess()` for the
   * shared child and attaches to it. The transport therefore has to accept an
   * attach per session id — the session's handlers live in that map, not in a
   * single field.
   */
  async attachSession(sessionId, handlers) {
    this.attached ??= new Map();
    this.attached.set(sessionId, handlers);
    this.handlers = handlers;
  }
  /** Detach one session (the bridge drops its session-keyed tables). */
  async closeSession(sessionId) {
    this.attached?.delete(sessionId);
  }
  async usage() {
    this.reads++;
    return this.readUsage ? this.readUsage() : this.snapshot;
  }
  async setConfig(config) {
    return { ...config, reasoningEffort: config.reasoningEffort ?? null };
  }
  async setPlan(active) {
    this.planWrites.push(active);
    return { active, pending: false };
  }
  async getPlan() {
    return { active: this.planWrites.at(-1) ?? false, pending: false, available: true };
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
    return { subagents: [] };
  }
  async history() {
    return { events: [], hasMore: false };
  }
  async prompt() {
    return { turnId: 'fake-turn' };
  }
  async cancel() {}
  async revert() {
    return undefined;
  }
  async setArchived() {
    return { available: true };
  }
  async runCommand() {
    return { kind: 'success' };
  }
  async waitForExit() {
    return true;
  }
}
processModule.DshProcess = FakeProcess;
const { DshSession } = require(path.join(compiled, 'server/session.js'));

(async () => {
  const events = [];
  // The session joins a shared child instead of spawning one, so the transport is
  // supplied through `acquireProcess`. `releaseProcess` is the claim hand-back;
  // this check never asserts on it, but `close()` calls it.
  const sharedTransport = new FakeProcess({ sessionId: '__paseo_shared_process__' });
  const session = new DshSession({
    sessionId: 'context-check', cwd: process.cwd(), env: {},
    route: { provider: 'fixture', model: 'alpha' }, mode: 'build',
    models: [{ id: 'fixture/alpha' }, { id: 'fixture/beta' }],
    thinkingOptions: [], emit: e => events.push(e), log() {},
    acquireProcess: async () => ({ process: sharedTransport, reused: false }),
    releaseProcess: () => {},
  });
  await session.open();
  const transport = sharedTransport;
  const latest = () => events.filter(e => e.type === 'session.usage').at(-1)?.usage;
  // Handlers now come from `attachSession`, not from the constructor options, so
  // the test drives them through the map the session registered.
  const handlers = transport.attached.get('context-check');
  const emit = (type, data = {}) => handlers.onEvent({ event: { type, data } });

  await session.refreshUsage();
  assert.equal(latest().contextWindowUsedTokens, 1024);
  assert.equal(latest().contextWindowMaxTokens, 64000);
  console.log('PASS 打开会话时上报已用量和容量');

  handlers.onStatus('running', 'context-check');
  const readsBeforeStep = transport.reads;
  transport.snapshot = { available: true, contextWindow: 64000, usedTokens: 2500 };
  emit('assistant/message', { usage: { inputTokens: 100, cacheReadTokens: 2300, outputTokens: 100 } });
  emit('request/context');
  emit('step/end');
  await delay(130);
  assert.equal(transport.reads, readsBeforeStep + 1);
  assert.equal(latest().contextWindowUsedTokens, 2500);
  assert.equal(latest().cachedInputTokens, 2300);
  assert.equal(events.some(e => e.type === 'session.turn' && e.state === 'completed'), false);
  console.log('PASS 回合内更新且合并相邻事件，缓存计数保持独立');

  transport.snapshot = { available: true, contextWindow: 64000, usedTokens: 900 };
  emit('compaction/end');
  await delay(0);
  assert.equal(latest().contextWindowUsedTokens, 900);
  assert.equal(latest().inputTokens, 100);
  console.log('PASS 压缩后的下降值传到界面且保留用量统计');

  transport.snapshot = { available: true, usedTokens: 900 };
  await session.refreshUsage();
  assert.equal(Object.hasOwn(latest(), 'contextWindowMaxTokens'), false);
  transport.snapshot = { available: false };
  await session.refreshUsage();
  assert.equal(Object.hasOwn(latest(), 'contextWindowUsedTokens'), false);
  assert.equal(latest().cachedInputTokens, 2300);
  console.log('PASS 未知容量与不可用状态清除旧上下文值');

  emit('assistant/message', { usage: { inputTokens: 500, outputTokens: 20 } });
  assert.equal(Object.hasOwn(latest(), 'cachedInputTokens'), false);
  console.log('PASS 新步骤缺少缓存字段时不沿用旧缓存计数');

  transport.snapshot = { available: true, contextWindow: Infinity, usedTokens: -1 };
  await session.refreshUsage();
  assert.equal(Object.hasOwn(latest(), 'contextWindowMaxTokens'), false);
  assert.equal(Object.hasOwn(latest(), 'contextWindowUsedTokens'), false);
  console.log('PASS 拒绝无效的上下文计数');

  const pending = [];
  transport.readUsage = () => new Promise(resolve => pending.push(resolve));
  const oldRead = session.refreshUsage();
  await session.configure({ model: 'fixture/beta' });
  assert.equal(pending.length, 2);
  pending[1]({ available: true, contextWindow: 128000, usedTokens: 1100 });
  await delay(0);
  pending[0]({ available: true, contextWindow: 64000, usedTokens: 900 });
  await oldRead;
  assert.equal(latest().contextWindowMaxTokens, 128000);
  assert.equal(latest().contextWindowUsedTokens, 1100);
  console.log('PASS 切模型后迟到的旧响应不能覆盖新值');

  const closingRead = session.refreshUsage();
  await session.close();
  const countBeforeLateResult = events.length;
  pending[2]({ available: true, contextWindow: 128000, usedTokens: 1200 });
  await closingRead;
  assert.equal(events.length, countBeforeLateResult);
  console.log('PASS 关闭后不再发出用量事件');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
