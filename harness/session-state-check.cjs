/**
 * 会话状态机回归：回合统计、配置提交顺序、modes 单源、子会话标题闸门与
 * prompt 失败后的回合收尾。
 *
 * 运行编译后的真实 `DshSession`，只替换它的进程传输（`acquireProcess` 返回一个
 * 记录调用的假 `DshProcess`），所以断言打在事件/状态层：不 spawn 进程、不连
 * daemon、不读凭据、不写真实 `~/.dsh`。
 *
 * 覆盖 2026-11-02 全量审查登记在 `plugin-session` 的六条（编号按 lane 报告）：
 *
 *   1. S-07 / S02（会话侧）：`configState().modes` 必须来自 catalog 的同一份清单。
 *      构造函数收到 `modes` 后原样回发；profile 不组合 plan-mode 时，持久化的
 *      `mode: "plan"` 不能重新出现在会话配置里，`configure` 也不能乐观地先提交。
 *   2. S-03：`configure` 必须先等后端回执再提交本地状态。先前 mode / effort 都是
 *      先写本地再 await，后端拒绝后 `configState()` 仍报新值；model 分支还会在
 *      await 前清空上下文占用，被拒后界面从有数字变成空。
 *   3. S-04：切模型只换 route，`#thinkingOption` 没跟着回执走。切到不声明思考档位
 *      的模型后后端已清空 effort，`configState()` 仍报旧档位。
 *   4. S-01 / S05：`prompt()` 在发 RPC 前预置 `#turnId`，而 `#onStatus("running")`
 *      只在 `#turnId === null` 时重置工具/统计。第二个回合的 `toolCalls` 于是累加
 *      两个回合，且取消的回合会改写上一回合已经显示的统计行。
 *   5. S-02：prompt RPC 在 running 已发出后失败时，catch 无条件清空 `#turnId`，
 *      已发出的 `session.turn started` 永远等不到终态。只有「started 尚未发出」
 *      时才允许丢弃预置 id；没 start 的失败仍须清掉，否则留下幽灵回合 id。
 *   6. S-06 / S07：`#flushPendingChildren` 缺少 label 条件，任何一次与它无关的
 *      flush（另一个带标题的子会话到达、root ready）都会把还没有标题的子会话
 *      提前打开——而 `session.opened` 是该子会话唯一的标题通道，之后到达的
 *      descriptor 无法更正。
 *
 * 每一条都先失败于未修版本（报告里带修前红日志），修后通过；断言全部读
 * `DshSession` 自己发出的事件或 `configState()`，不读源码文本。
 *
 * 用法：node harness/session-state-check.cjs [编译输出目录]
 *
 * 不给目录时自动编译到 `paseo-plugin/.dbg-session-state`（见
 * `harness/plugin-build.cjs`：产物必须在仓库内，否则 node 从 /tmp 向上找不到
 * `paseo-plugin/node_modules`）。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolvePluginBuild } = require('./plugin-build.cjs');

const compiled = resolvePluginBuild(process.argv[2], '.dbg-session-state');
const { DshSession } = require(path.join(compiled, 'server/session.js'));
const { ASSISTANT_DELTA_EVENT } = require(path.join(compiled, 'server/timeline.js'));

const MODES_BUILD_ONLY = [{ id: 'build', label: 'Build', description: 'Build' }];
const MODES_BUILD_PLAN = [
  { id: 'build', label: 'Build', description: 'Build' },
  { id: 'plan', label: 'Plan', description: 'Plan' },
];
/** alpha declares two efforts; beta declares none — the S04 model switch target. */
const MODELS = [
  {
    id: 'fixture/alpha',
    label: 'Alpha',
    description: 'fixture',
    thinkingOptions: [
      { id: 'high', label: 'High' },
      { id: 'low', label: 'Low' },
    ],
  },
  { id: 'fixture/beta', label: 'Beta', description: 'fixture' },
];

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
 * The transport stand-in.
 *
 * Only the methods `DshSession` actually reaches are implemented, each answering
 * the shape `dsh-process.ts` documents. Failures are injectable **once** so a
 * test can prove a refused call commits nothing: `configError` / `planError`
 * throw on the next call, `failPromptAfterRunning` makes `prompt()` emit the
 * running status first and then throw (the real failure shape behind S-02).
 */
class FakeProcess {
  constructor() {
    this.attached = new Map();
    this.planWrites = [];
    this.configWrites = [];
    this.prompts = [];
    this.snapshot = { available: true, contextWindow: 64000, usedTokens: 1024 };
    this.configError = null;
    this.planError = null;
    this.planReceipt = null;
    this.failPromptAfterRunning = false;
    this.failPromptBeforeRunning = false;
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
  async usage() {
    return this.snapshot;
  }
  async setConfig(_sessionId, changes) {
    this.configWrites.push(changes);
    if (this.configError !== null) {
      const error = this.configError;
      this.configError = null;
      throw error;
    }
    return {
      provider: changes.provider ?? 'fixture',
      model: changes.model ?? 'fixture/alpha',
      reasoningEffort: changes.reasoningEffort ?? null,
      preset: null,
    };
  }
  async setPlan(_sessionId, active) {
    this.planWrites.push(active);
    if (this.planError !== null) {
      const error = this.planError;
      this.planError = null;
      throw error;
    }
    return this.planReceipt ?? { active, pending: false };
  }
  async setPermission() {
    return { available: true, current: null, presets: [] };
  }
  async prompt(sessionId) {
    this.prompts.push(sessionId);
    const handlers = this.attached.get(sessionId);
    if (this.failPromptBeforeRunning) {
      this.failPromptBeforeRunning = false;
      throw new Error('the runtime refused the prompt');
    }
    handlers.onStatus('running', sessionId);
    if (this.failPromptAfterRunning) {
      this.failPromptAfterRunning = false;
      throw new Error('transport request timed out after the turn started');
    }
    return { messageId: `m-${this.prompts.length}` };
  }
  async cancel() {}
  async commands() {
    return [];
  }
  async permission() {
    return { available: false };
  }
  async presets() {
    return { available: false };
  }
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

let sessionSeq = 0;
/**
 * Build one session over its own recorded transport.
 *
 * `modes` is always passed explicitly: it is the catalog's list, which is the
 * point of the first section (the production caller in `provider.ts` passes the
 * same `display.defaults.modes` it publishes as the catalog).
 */
function makeSession(overrides = {}) {
  sessionSeq += 1;
  const sessionId = overrides.sessionId ?? `state-check-${sessionSeq}`;
  const events = [];
  const logs = [];
  const transport = new FakeProcess();
  const session = new DshSession({
    sessionId,
    cwd: '/work',
    env: {},
    route: overrides.route ?? { provider: 'fixture', model: 'alpha', reasoningEffort: 'high' },
    mode: overrides.mode ?? 'build',
    modes: overrides.modes ?? MODES_BUILD_PLAN,
    models: overrides.models ?? MODELS,
    thinkingOptions: [],
    subsession: overrides.subsession ?? false,
    ...(overrides.agentId === undefined ? {} : { agentId: overrides.agentId }),
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

/** Emit one DSH session event through the attached handler set. */
function emitEvent(set, event) {
  set.onEvent({ event });
}
/** Emit one event for a native child session (the payload names it). */
function emitChildEvent(set, sessionId, event) {
  set.onEvent({ sessionId, event });
}
/** Emit the transient stream snapshot that starts a step's stats row. */
function emitDelta(set, turn, step) {
  emitEvent(set, {
    type: ASSISTANT_DELTA_EVENT,
    data: { turn, step, startedAt: Date.now() - 200, firstTextAt: Date.now() - 100 },
  });
}
/** Emit the durable assistant message for one step (the stats row is published here). */
function emitAssistant(set, turn, step) {
  emitEvent(set, {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: { id: `am-${turn}-${step}`, content: [{ type: 'text', text: `answer ${turn}.${step}` }] },
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  });
}
function emitToolCall(set, callId) {
  emitEvent(set, { type: 'tool/call', data: { callId, name: 'bash', arguments: { command: 'echo hi' } } });
}
function emitToolResult(set, callId) {
  emitEvent(set, {
    type: 'tool/result',
    data: { toolCallId: callId, message: { content: [{ type: 'text', text: 'hi' }] } },
  });
}
function emitTurnEnd(set, turn, kind) {
  emitEvent(set, { type: 'turn/end', data: { turn, reason: { kind } } });
}

/** The newest plugin item of the collapsed stats row (`stream-stats:<turn>:<step>`). */
function latestStatsRow(events) {
  return events
    .filter((event) => event.type === 'timeline.item' && event.item?.kind === 'dsh-stream-stats')
    .at(-1);
}
function statsRowById(events, id) {
  return events
    .filter((event) => event.type === 'timeline.item' && event.item?.id === id)
    .at(-1);
}

const promptInput = (text) => ({
  clientMessageId: `p-${text}`,
  delivery: 'auto',
  input: { type: 'message', content: [{ type: 'text', text }] },
});

(async () => {
  // -------------------------------------------------------------------------
  // 1. S-07 / S02: the catalog is the single source of the advertised modes.
  // -------------------------------------------------------------------------
  console.log('the catalog is the single source of advertised modes (S-07 / S02)');
  {
    const { session, transport, logs } = makeSession({
      sessionId: 'modes-build-only',
      modes: MODES_BUILD_ONLY,
      // Paseo persisted plan from before the profile lost plan-mode.
      mode: 'plan',
    });
    check('a persisted plan mode does not re-advertise a hidden Plan', () => {
      assert.equal(session.configState().mode, 'build');
      assert.deepEqual(session.configState().modes.map((mode) => mode.id), ['build']);
      assert.ok(logs.some((line) => /plan mode is not advertised/.test(line)), `logs=${JSON.stringify(logs)}`);
    });
    await session.open();
    check('open does not ask the runtime for a plan capability it does not advertise', () => {
      assert.deepEqual(transport.planWrites, []);
    });
    check('configure refuses plan with the advertised list instead of committing it', async () => {
      await assert.rejects(session.configure({ mode: 'plan' }), /not available in this profile/);
      assert.equal(session.configState().mode, 'build');
    });
    await session.close();

    const plan = makeSession({ sessionId: 'modes-plan', modes: MODES_BUILD_PLAN, mode: 'plan' });
    await plan.session.open();
    check('an advertised plan mode is reported and reconciled on open', () => {
      assert.deepEqual(plan.session.configState().modes.map((mode) => mode.id), ['build', 'plan']);
      assert.equal(plan.session.configState().mode, 'plan');
      assert.deepEqual(plan.transport.planWrites, [true]);
    });
    // While a turn is open DSH *queues* the switch: `active` still reports the
    // logged state and `pending` carries the accepted selection. The composer
    // must show the accepted pick, not snap back as if it were refused.
    plan.transport.planReceipt = { active: false, pending: true };
    await plan.session.configure({ mode: 'plan' });
    check('a queued plan selection is reported as the accepted mode', () => {
      assert.equal(plan.session.configState().mode, 'plan');
    });
    plan.transport.planReceipt = null;
    await plan.session.configure({ mode: 'build' });
    check('a committed mode switch follows the runtime receipt', () => {
      assert.equal(plan.session.configState().mode, 'build');
    });
    await plan.session.close();
  }

  // -------------------------------------------------------------------------
  // 2. S-03: commit only after the runtime's receipt.
  // -------------------------------------------------------------------------
  console.log('configuration commits only after the runtime confirms it (S-03)');
  {
    const { session, transport, events } = makeSession({ sessionId: 'config-reject' });
    await session.open();
    await session.refreshUsage();
    const usageBefore = events.filter((event) => event.type === 'session.usage').at(-1)?.usage;
    check('precondition: the context readout is populated before a rejected switch', () => {
      assert.equal(usageBefore?.contextWindowUsedTokens, 1024);
    });

    transport.configError = new Error('the runtime refused the route');
    await assert.rejects(session.configure({ model: 'fixture/beta' }));
    check('a refused model switch keeps the previous model', () => {
      assert.equal(session.configState().model, 'fixture/alpha');
    });
    check('a refused model switch does not wipe the known context readout', () => {
      const usageAfter = events.filter((event) => event.type === 'session.usage').at(-1)?.usage;
      assert.deepEqual(usageAfter, usageBefore);
    });

    transport.configError = new Error('the runtime refused the effort');
    await assert.rejects(session.configure({ thinkingOption: 'low' }));
    check('a refused thinking option is not committed locally', () => {
      assert.equal(session.configState().thinkingOption, 'high');
    });

    transport.planError = new Error('plan mode is not mounted in this profile');
    await assert.rejects(session.configure({ mode: 'plan' }));
    check('a refused plan mode is not committed locally', () => {
      assert.equal(session.configState().mode, 'build');
    });
    await session.close();
  }

  // -------------------------------------------------------------------------
  // 3. S-04: switching model re-reads the effort from the receipt.
  // -------------------------------------------------------------------------
  console.log('a model switch takes the thinking option from the receipt (S-04)');
  {
    const { session } = makeSession({ sessionId: 'model-effort' });
    await session.open();
    check('precondition: the fixture session starts with an effort', () => {
      assert.equal(session.configState().thinkingOption, 'high');
    });
    await session.configure({ model: 'fixture/beta' });
    check('switching to a model without efforts clears the advertised thinking option', () => {
      assert.equal(session.configState().model, 'fixture/beta');
      assert.equal(session.configState().thinkingOption, undefined);
      assert.deepEqual(session.configState().thinkingOptions, []);
    });
    await session.close();
  }

  // -------------------------------------------------------------------------
  // 4. S-01 / S05: per-turn counters reset when the turn actually starts.
  // -------------------------------------------------------------------------
  console.log('per-turn tool counters reset on the running status (S-01 / S05)');
  {
    const { session, handlers, events } = makeSession({ sessionId: 'turn-stats' });
    await session.open();
    const set = handlers();

    // Turn 1: no tools, one assistant message -> a stats row with toolCalls 0.
    await session.prompt(promptInput('one'));
    emitDelta(set, 1, 1);
    emitAssistant(set, 1, 1);
    emitTurnEnd(set, 1, 'completed');
    set.onStatus('idle', 'turn-stats');
    const row1 = latestStatsRow(events);
    check('precondition: turn 1 publishes a stats row with no tool calls', () => {
      assert.equal(row1?.item?.data?.toolCalls, 0);
    });

    // Turn 2: one tool, then the turn is cancelled before settling any step. Its
    // tool count must not leak into turn 1's already-shown row.
    await session.prompt(promptInput('two'));
    emitToolCall(set, 'call-2');
    emitToolResult(set, 'call-2');
    emitTurnEnd(set, 2, 'aborted');
    set.onStatus('idle', 'turn-stats');
    check('a cancelled second turn does not rewrite the first turn\'s stats row', () => {
      const rewritten = statsRowById(events, row1.item.id);
      assert.equal(rewritten?.item?.data?.toolCalls, 0);
    });

    // Turn 3: one tool and one settled step. Its own row counts only this turn.
    await session.prompt(promptInput('three'));
    emitToolCall(set, 'call-3');
    emitToolResult(set, 'call-3');
    emitDelta(set, 3, 1);
    emitAssistant(set, 3, 1);
    emitTurnEnd(set, 3, 'completed');
    set.onStatus('idle', 'turn-stats');
    check('the third turn counts only its own tool calls', () => {
      assert.equal(latestStatsRow(events)?.item?.data?.toolCalls, 1);
    });
    await session.close();
  }

  // -------------------------------------------------------------------------
  // 5. S-02: a prompt failure after `started` keeps the turn and closes it.
  // -------------------------------------------------------------------------
  console.log('a prompt that fails after the turn started still ends that turn (S-02)');
  {
    const { session, transport, handlers, events } = makeSession({ sessionId: 'prompt-fail-late' });
    await session.open();
    const set = handlers();
    transport.failPromptAfterRunning = true;
    await session.prompt(promptInput('late-fail'));
    const started = events.filter((event) => event.type === 'session.turn' && event.state === 'started');
    check('precondition: the started turn was announced before the prompt failed', () => {
      assert.equal(started.length, 1);
      assert.ok(
        events.some((event) => event.type === 'session.prompt_result' && event.result?.type === 'failed'),
        'the prompt failure is still reported',
      );
    });
    set.onStatus('idle', 'prompt-fail-late');
    check('the idle status still closes the turn it opened (one terminal, same id)', () => {
      const terminals = events.filter((event) => event.type === 'session.turn' && event.state !== 'started');
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].turnId, started[0].turnId);
    });

    // The other half of the fix: a prompt that failed BEFORE a turn started must
    // still discard the id it issued, or the next successful prompt would inherit
    // a ghost turn id.
    transport.failPromptBeforeRunning = true;
    await session.prompt(promptInput('early-fail'));
    const startedAfterEarlyFailure = events.filter(
      (event) => event.type === 'session.turn' && event.state === 'started',
    );
    check('a prompt that failed before starting announces no turn', () => {
      assert.equal(startedAfterEarlyFailure.length, 1);
    });
    await session.prompt(promptInput('recovered'));
    check('the next successful prompt opens a fresh turn id, not the failed one', () => {
      const starts = events.filter((event) => event.type === 'session.turn' && event.state === 'started');
      assert.equal(starts.length, 2);
      assert.equal(starts[1].turnId, 'turn:p-recovered');
      assert.notEqual(starts[1].turnId, 'turn:p-early-fail');
    });
    set.onStatus('idle', 'prompt-fail-late');
    await session.close();

    // The same failure shape on the slash-skill path: a `command` prompt the
    // catalog did not mark as a runtime command is forwarded as a `/name`
    // message through its own try/catch, and that catch had the same
    // unconditional `#turnId = null`.
    const skill = makeSession({ sessionId: 'prompt-fail-skill' });
    await skill.session.open();
    const skillSet = skill.handlers();
    skill.transport.failPromptAfterRunning = true;
    await skill.session.prompt({
      clientMessageId: 's1',
      delivery: 'auto',
      input: { type: 'command', name: 'skill-x', arguments: '' },
    });
    const skillStarts = skill.events.filter((event) => event.type === 'session.turn' && event.state === 'started');
    check('precondition: the skill prompt started a turn before failing', () => {
      assert.equal(skillStarts.length, 1);
    });
    skillSet.onStatus('idle', 'prompt-fail-skill');
    check('a failed slash-skill prompt still closes the turn it started', () => {
      const terminals = skill.events.filter((event) => event.type === 'session.turn' && event.state !== 'started');
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].turnId, skillStarts[0].turnId);
    });
    await skill.session.close();
  }

  // -------------------------------------------------------------------------
  // 6. S-06 / S07: only a labelled child (or a timed-out wait) opens on flush.
  // -------------------------------------------------------------------------
  console.log('flush keeps a label-less child held for its own descriptor (S-06 / S07)');
  {
    const { session, handlers, events } = makeSession({
      sessionId: 'flush-root',
      subsession: true,
      agentId: 'agent-1',
    });
    await session.open();
    const set = handlers();
    // Root not ready yet: both notices are held on the root gate.
    set.onChildOpened({ sessionId: 'child-labelled', parentSessionId: 'flush-root', label: 'Labelled L' });
    set.onChildOpened({ sessionId: 'child-late', parentSessionId: 'flush-root' });
    // An unrelated flush (the root becoming ready) must not release the untitled
    // child: the only title it will ever have is the one on its own `opened`.
    session.markRootReady();
    const opened = () => events.filter((event) => event.type === 'session.opened');
    check('the labelled child opens on root ready', () => {
      assert.deepEqual(opened().map((event) => event.sessionId), ['agent-1:sub:child-labelled']);
    });
    check('the label-less child is not opened by an unrelated flush', () => {
      assert.equal(
        opened().some((event) => event.sessionId === 'agent-1:sub:child-late'),
        false,
        JSON.stringify(opened().map((event) => event.sessionId)),
      );
    });

    emitChildEvent(set, 'child-late', { type: 'subagent/descriptor', data: { label: 'Late L' } });
    const late = opened().find((event) => event.sessionId === 'agent-1:sub:child-late');
    check('the descriptor opens the held child with its real title', () => {
      assert.ok(late !== undefined, JSON.stringify(opened().map((event) => event.sessionId)));
      assert.equal(late.title, 'Late L');
    });
    await session.close();
  }

  console.log(`\n  ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.log(`  ${failed} FAILED`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
