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
const { DshSession, modes: advertisedModes } = require(path.join(compiled, 'server/session.js'));

/**
 * Extra event sinks and transports for the post-open re-publish cases below.
 *
 * Each scenario needs its own session so the guards it asserts on (a running
 * turn, a closed session) cannot leak into the others; sharing the first
 * session's event array would make "no new event was published" unfalsifiable.
 */
const replayEvents = [];
const guardEvents = [];
const closeEvents = [];
const replayTransport = new FakeProcess({ sessionId: '__replay__' });
const guardTransport = new FakeProcess({ sessionId: '__guard__' });
const closeTransport = new FakeProcess({ sessionId: '__close__' });

/**
 * Track the replay timers the session arms, and which of them it cancels.
 *
 * "A closed session publishes nothing" and "a closed session cancels its pending
 * timers" are two different properties, and only this instrumentation can tell
 * them apart: the `#closed` guard inside the callback keeps the publish assertion
 * green even when `close()` never cancels anything. Counting calls is not enough
 * either — `refreshUsage()` also clears `#usageRefreshTimer`, so a count cannot
 * say *which* timer was cleared. Hence handles.
 *
 * `node:timers/promises` does not route through `global.setTimeout` (verified
 * directly), so the only calls seen here are the session's own and `delay()` in
 * this file is unaffected.
 */
const armedTimers = [];
const clearedTimers = new Set();
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
global.setTimeout = function instrumentedSetTimeout(...args) {
  const handle = realSetTimeout.apply(this, args);
  armedTimers.push(handle);
  return handle;
};
global.clearTimeout = function instrumentedClearTimeout(handle, ...rest) {
  clearedTimers.add(handle);
  return realClearTimeout.call(this, handle, ...rest);
};

(async () => {
  const events = [];
  // The session joins a shared child instead of spawning one, so the transport is
  // supplied through `acquireProcess`. `releaseProcess` is the claim hand-back;
  // this check never asserts on it, but `close()` calls it.
  const sharedTransport = new FakeProcess({ sessionId: '__paseo_shared_process__' });
  const session = new DshSession({
    sessionId: 'context-check', cwd: process.cwd(), env: {},
    route: { provider: 'fixture', model: 'alpha' }, mode: 'build', modes: advertisedModes(),
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
  assert.equal(latest().contextWindowUsedTokens, 900);
  console.log('PASS 未知容量清除旧容量，但保留本次测得的已用量');

  // An unavailable read is not a measurement: publishing it would clear the
  // occupancy Paseo is showing for a session whose value is merely unknown.
  const eventsBeforeUnavailable = events.length;
  const usageBeforeUnavailable = latest();
  transport.snapshot = { available: false };
  await session.refreshUsage();
  assert.equal(events.length, eventsBeforeUnavailable);
  assert.deepEqual(latest(), usageBeforeUnavailable);
  assert.equal(latest().contextWindowUsedTokens, 900);
  console.log('PASS 不可用状态不发布事件，也不抹掉已知的上下文占用');

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

  // ---------------------------------------------------------------------------
  // Re-publishing the open-time occupancy across the host's subscription window.
  //
  // The host subscribes to a provider session only at the end of its own
  // registration, so a `session.usage` emitted during open can reach an empty
  // listener set — and its replay drops `usage_updated`, so it never comes back.
  // A reopen starts the agent with no cached usage at all, which is why the
  // composer showed nothing until the next prompt. `publishUsageAfterOpen`
  // re-emits the cached answer instead of re-polling (a second `refreshUsage`
  // would bump the generation and invalidate the first answer).
  // ---------------------------------------------------------------------------
  {
    const replaySession = new DshSession({
      sessionId: 'replay-check', cwd: process.cwd(), env: {},
      route: { provider: 'fixture', model: 'alpha' }, mode: 'build', modes: advertisedModes(),
      models: [{ id: 'fixture/alpha' }],
      thinkingOptions: [], emit: e => replayEvents.push(e), log() {},
      acquireProcess: async () => ({ process: replayTransport, reused: false }),
      releaseProcess: () => {},
    });
    await replaySession.open();
    const readsBeforeOpen = replayTransport.reads;
    await replaySession.refreshUsage();
    const readsAfterFirstPoll = replayTransport.reads;
    const publishesBefore = replayEvents.filter(e => e.type === 'session.usage').length;
    // The replay is a re-emit of the cached record, so there has to be a record:
    // without this, an empty publish list would make the comparison below read
    // `undefined.usage` and fail with a TypeError that hides the real cause.
    assert.ok(publishesBefore >= 1);
    const polledUsage = replayEvents.filter(e => e.type === 'session.usage').at(-1).usage;
    replaySession.publishUsageAfterOpen();

    // 0 ms lands first, well before the host's registration chain could finish.
    await delay(20);
    const afterFirstReplay = replayEvents.filter(e => e.type === 'session.usage');
    assert.equal(afterFirstReplay.length, publishesBefore + 1);
    assert.deepEqual(afterFirstReplay.at(-1).usage, polledUsage);
    console.log('PASS 打开会话后立即重发一次已缓存的用量快照');

    // …and the later delays land too, so a host that subscribes tens of ms later
    // still receives it. This is what makes the fix cover the window rather than
    // a single guessed moment.
    await delay(320);
    assert.equal(replayEvents.filter(e => e.type === 'session.usage').length, publishesBefore + 2);
    await delay(760);
    assert.equal(replayEvents.filter(e => e.type === 'session.usage').length, publishesBefore + 3);
    // The 3 s replay is the one that covers a daemon cold start resuming several
    // agents, where the host's registration chain carries two disk writes and a
    // registry cold scan. It has to be asserted: a three-delay list would pass
    // every check above and still leave that case uncovered.
    await delay(2100);
    assert.equal(replayEvents.filter(e => e.type === 'session.usage').length, publishesBefore + 4);
    console.log('PASS 250ms / 1000ms / 3000ms 三次补发都到达（覆盖宿主冷启动的注册链）');

    // Re-emitting is a cache read, not another measurement: the RPC count is
    // unchanged, so the retry cannot be mistaken for a re-poll.
    assert.equal(replayTransport.reads, readsAfterFirstPoll);
    assert.equal(readsAfterFirstPoll, readsBeforeOpen + 1);
    console.log('PASS 补发不重新读取运行时（RPC 只发 1 次，纯缓存重发）');

    // A running turn has moved the occupancy on; the stale snapshot must not
    // overwrite it. The guard is what keeps the retry from becoming a regression.
    const turnSession = new DshSession({
      sessionId: 'replay-guard', cwd: process.cwd(), env: {},
      route: { provider: 'fixture', model: 'alpha' }, mode: 'build', modes: advertisedModes(),
      models: [{ id: 'fixture/alpha' }],
      thinkingOptions: [], emit: e => guardEvents.push(e), log() {},
      acquireProcess: async () => ({ process: guardTransport, reused: false }),
      releaseProcess: () => {},
    });
    await turnSession.open();
    await turnSession.refreshUsage();
    guardTransport.attached.get('replay-guard').onStatus('running', 'replay-guard');
    const guardBefore = guardEvents.filter(e => e.type === 'session.usage').length;
    turnSession.publishUsageAfterOpen();
    // Past the last delay, so this covers every replay in the list rather than
    // just the early ones: the guard has to hold for the 3 s attempt too.
    await delay(3200);
    assert.equal(guardEvents.filter(e => e.type === 'session.usage').length, guardBefore);
    console.log('PASS 回合进行中不补发旧快照（4 个延迟全部被守卫挡下）');

    // A closed session has no composer to fix, and a timer that outlived it would
    // publish into a dead session. Two separate properties, asserted separately:
    // nothing is published afterwards, AND the pending timers are actually
    // cancelled. The first stays green from the `#closed` guard alone, so only the
    // second one fails when `close()` forgets to clear the timers.
    const closeSession = new DshSession({
      sessionId: 'replay-close', cwd: process.cwd(), env: {},
      route: { provider: 'fixture', model: 'alpha' }, mode: 'build', modes: advertisedModes(),
      models: [{ id: 'fixture/alpha' }],
      thinkingOptions: [], emit: e => closeEvents.push(e), log() {},
      acquireProcess: async () => ({ process: closeTransport, reused: false }),
      releaseProcess: () => {},
    });
    await closeSession.open();
    await closeSession.refreshUsage();
    const armedBeforeReplay = armedTimers.length;
    closeSession.publishUsageAfterOpen();
    // Every timer this call armed is one it must cancel on close.
    const replayTimers = armedTimers.slice(armedBeforeReplay);
    assert.equal(replayTimers.length, 4);
    assert.equal(replayTimers.filter((handle) => clearedTimers.has(handle)).length, 0);
    const closeBefore = closeEvents.filter(e => e.type === 'session.usage').length;
    await closeSession.close();
    const cancelled = replayTimers.filter((handle) => clearedTimers.has(handle));
    assert.equal(cancelled.length, replayTimers.length);
    await delay(3200);
    assert.equal(closeEvents.filter(e => e.type === 'session.usage').length, closeBefore);
    console.log('PASS 关闭会话时清掉待补发的定时器（4 个全部 clearTimeout）');
    console.log('PASS 关闭会话后不再发布用量事件');
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
