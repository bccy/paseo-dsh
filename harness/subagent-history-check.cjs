/**
 * 子代理历史读取失败（`paseo/history` 抛错）必须可见且不留下缓冲帧。
 *
 * `replaySubagents()` 读子会话历史有两种失败形状，用户看到的结果必须一致：
 *
 *   - 桥答 `available:false`（日志在、读不出）：发「子代理历史读取失败」notice，
 *     并丢掉回放窗口内为它缓冲的帧。
 *   - RPC **抛错**（60s 超时、传输失败、子进程已死）：修复前只写 stderr，
 *     不发 notice，也不丢缓冲帧。
 *
 * 后者有两个后果，正是本脚本钉住的两条：
 *
 *   1. 重开会话时该子代理行缺失，时间线上没有任何提示——与根历史抛错、子代理
 *      目录抛错（两者都已发 notice）是同一个用户可见失败类，只有这一条静默；
 *   2. 回放窗口内缓冲的帧永远等不到视图：它们留在 `#pendingChildEvents` 里，
 *      直到 2000 上限 trim 才按最旧丢弃；同一子会话后续的 live 帧被记为
 *      「unknown subagent session」丢掉。
 *
 * 第二条的判据是「第二次成功回放」：失败时缓冲的那帧如果没被丢弃，下一次
 * 成功回放打开该子会话后会被 flush 进它的时间线；丢了就不会出现。所以脚本
 * 在失败回放期间送一帧带唯一文本的子会话消息，再成功回放一次，断言这帧的
 * 文本**没有**出现在任何 timeline item 里——同时用同一帧正常回放的历史行做
 * 阳性对照（REPLAYED-H 必须出现），否则「没出现」可能只是回放根本没跑。
 *
 * 断言全部读 `DshSession` 自己发出的事件/日志或 `configState()`，不读源码文本；
 * 传输层是记录调用的假 `DshProcess`，所以不 spawn 进程、不连 daemon、不写真实
 * `~/.dsh`。
 *
 * 用法：node harness/subagent-history-check.cjs [编译输出目录]
 *
 * 不给目录时自动编译到 `paseo-plugin/.dbg-subagent-history`（见
 * `harness/plugin-build.cjs`：产物必须在仓库内，否则 node 从 /tmp 向上找不到
 * `paseo-plugin/node_modules`）。
 */
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { resolvePluginBuild } = require('./plugin-build.cjs');

// Loading the compiled plugin is side-effect free, but never leave a check able
// to touch the real profile: a throwaway DSH_HOME is the standing rule here.
process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), 'dsh-subagent-history-'));
process.on('exit', () => {
  try {
    rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const compiled = resolvePluginBuild(process.argv[2], '.dbg-subagent-history');
const { DshSession } = require(path.join(compiled, 'server/session.js'));

const MODES_BUILD_ONLY = [{ id: 'build', label: 'Build', description: 'Build' }];
const MODELS = [{ id: 'fixture/alpha', label: 'Alpha', description: 'fixture' }];
/** Unique text only the buffered live frame carries; never in a history fixture. */
const LIVE_MARKER = 'LIVE-DURING-THE-FAILED-REPLAY';
/** Text the second (successful) replay restores, the positive control. */
const REPLAYED_MARKER = 'REPLAYED-H';

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${String(error?.message ?? error).split('\n').join('\n        ')}`);
  }
}

/**
 * The transport stand-in: only the methods `DshSession` reaches are implemented,
 * each answering the shape `dsh-process.ts` documents.
 *
 * `histories` is keyed by native child id and holds the promise factory a test
 * wants that child's history read to be — which is how one child hangs and then
 * rejects while the next replay answers normally.
 */
class FakeProcess {
  constructor() {
    this.attached = new Map();
    this.listing = { available: true, subagents: [] };
    this.histories = new Map();
    this.historyCalls = [];
  }
  async start() {}
  async shutdown() {}
  kill() {}
  setHandlers() {}
  async attachSession(sessionId, handlers) {
    this.attached.set(sessionId, handlers);
  }
  async closeSession(sessionId) {
    this.attached.delete(sessionId);
  }
  async subagents() {
    return this.listing;
  }
  history(sessionId) {
    this.historyCalls.push(sessionId);
    const read = this.histories.get(sessionId);
    if (read === undefined) return Promise.reject(new Error(`no history fixture for ${sessionId}`));
    return read();
  }
  async usage() {
    return { available: true, contextWindow: 64000, usedTokens: 0 };
  }
  async setPermission() {
    return { available: false, current: null, presets: [] };
  }
  async presets() {
    return { available: false };
  }
  async commands() {
    return [];
  }
  async permission() {
    return { available: false };
  }
  async setPlan(_sessionId, active) {
    return { active, pending: false };
  }
  async waitForExit() {
    return true;
  }
}

let sessionSeq = 0;
function makeSession(overrides = {}) {
  sessionSeq += 1;
  const sessionId = overrides.sessionId ?? `subagent-history-${sessionSeq}`;
  const events = [];
  const logs = [];
  const transport = new FakeProcess();
  const session = new DshSession({
    sessionId,
    cwd: '/work',
    env: {},
    route: { provider: 'fixture', model: 'alpha' },
    mode: 'build',
    modes: MODES_BUILD_ONLY,
    models: MODELS,
    thinkingOptions: [],
    // Child visibility is the whole point: without the negotiated capability
    // `replaySubagents()` returns immediately.
    subsession: true,
    emit: (event) => events.push(event),
    log: (line) => logs.push(line),
    acquireProcess: async () => ({ process: transport, reused: false }),
    releaseProcess: () => {},
  });
  const handlers = () => {
    const set = transport.attached.get(sessionId);
    if (set === undefined) throw new Error(`session ${sessionId} never attached its handlers`);
    return set;
  };
  return { session, transport, events, logs, handlers };
}

/** Emit one event for a native child session (the payload names it). */
function emitChildEvent(handlers, sessionId, event) {
  handlers().onEvent({ sessionId, event });
}

const noticesOf = (events, title) =>
  events.filter((event) => event.type === 'session.notice' && event.notice?.title === title);
const timelineText = (events) =>
  events
    .filter((event) => event.type === 'timeline.item')
    .map((event) => JSON.stringify(event.item));
const childTimeline = (events, childSessionId) =>
  events.filter((event) => event.type === 'timeline.item' && event.sessionId === childSessionId);

(async () => {
  const rootId = 'subagent-history-root';
  const nativeChildId = 'child-H';
  const scopedChildId = `${rootId}:sub:${nativeChildId}`;
  const { session, transport, events, logs, handlers } = makeSession({ sessionId: rootId });

  console.log('a rejected subagent history read is visible and drops its buffered frames');
  await session.open();
  session.markRootReady();

  // The listing names the child, then the history read hangs so the replay
  // window is open long enough to buffer a live frame for that child.
  transport.listing = {
    available: true,
    subagents: [{ sessionId: nativeChildId, parentSessionId: rootId, mode: 'continuable', label: 'Broken H' }],
  };
  let releaseHistory;
  const historyGate = new Promise((resolve) => {
    releaseHistory = resolve;
  });
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  transport.histories.set(nativeChildId, async () => {
    markEntered();
    await historyGate;
    throw new Error('paseo/history transport failed: simulated timeout');
  });

  const replay = session.replaySubagents();
  await entered;
  // The frame a child can emit while its history read is in flight: held for the
  // replay (see `#onSessionEvent`), and the one that must not survive the failure.
  emitChildEvent(handlers, nativeChildId, {
    type: 'assistant/message',
    data: { message: { id: 'live-h', content: [{ type: 'text', text: LIVE_MARKER }] } },
  });
  releaseHistory();
  await replay;

  check('the rejection is logged with its reason', () => {
    assert.ok(
      logs.some((line) => line.includes(`subagent history failed for ${nativeChildId}`) && line.includes('simulated timeout')),
      `logs=${JSON.stringify(logs)}`,
    );
  });
  check('…and becomes a 子代理历史读取失败 notice (not stderr-only)', () => {
    const notices = noticesOf(events, '子代理历史读取失败');
    assert.equal(notices.length, 1, JSON.stringify(events.filter((event) => event.type === 'session.notice')));
    assert.match(notices[0].notice.description, /child-H/);
    assert.match(notices[0].notice.description, /simulated timeout/);
  });
  check('…the unreadable child is never announced as opened', () => {
    assert.equal(
      events.filter((event) => event.type === 'session.opened' && event.sessionId === scopedChildId).length,
      0,
    );
  });
  check('…and later live frames for it are reported as unknown, not misrouted', () => {
    emitChildEvent(handlers, nativeChildId, {
      type: 'assistant/message',
      data: { message: { id: 'after-h', content: [{ type: 'text', text: 'AFTER-THE-FAILURE' }] } },
    });
    assert.ok(
      logs.some((line) => line.includes(`ignoring event for unknown subagent session ${nativeChildId}`)),
      `logs=${JSON.stringify(logs)}`,
    );
  });

  // The drop assertion: a second replay whose history read succeeds opens the
  // child. If the failed replay kept its buffered frame, the flush on open would
  // deliver it into the child's timeline now; if it was dropped, it cannot.
  transport.histories.set(nativeChildId, async () => ({
    available: true,
    inheritedEventCount: 0,
    events: [
      {
        type: 'assistant/message',
        seq: 1,
        data: { message: { id: 'replayed-h', content: [{ type: 'text', text: REPLAYED_MARKER }] } },
      },
    ],
  }));
  await session.replaySubagents();

  check('a later readable replay still opens the child (positive control)', () => {
    assert.ok(
      events.some((event) => event.type === 'session.opened' && event.sessionId === scopedChildId),
      JSON.stringify(events.filter((event) => event.type === 'session.opened')),
    );
  });
  check('…and restores its stored history', () => {
    assert.ok(
      childTimeline(events, scopedChildId).some((event) => JSON.stringify(event.item).includes(REPLAYED_MARKER)),
      JSON.stringify(childTimeline(events, scopedChildId)),
    );
  });
  check('the frame buffered during the failed replay was dropped, not replayed later', () => {
    assert.ok(
      !timelineText(events).some((item) => item.includes(LIVE_MARKER)),
      JSON.stringify(events.filter((event) => event.type === 'timeline.item')),
    );
  });

  await session.close();

  console.log(`\n  ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.log(`  ${failed} FAILED`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(`subagent-history-check could not run: ${String(error?.stack ?? error)}`);
  process.exitCode = 1;
});
