require("./register-typescript.cjs");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ProviderEventSchema } = require("@getpaseo/plugin/server/provider");

const {
  DSH_SUBAGENT_METADATA_KEY,
  classifyListAgentStatus,
  extractSubagentTelemetryFromEvents,
  mapSubagentStopReason,
  parseArchiveSubagentsOutput,
  parseListAgentsOutput,
  parseRelayedAgentMessage,
  parseSubagentActivation,
  parseSubagentSettlementMessage,
  parseSubagentStatusChips,
  resolveSubagentCardMetadata,
  sanitizeSubagentMetadata,
  subagentMetadataFromItemMetadata,
} = require("../shared/subagent-card.ts");
const { TimelineBuilder } = require("../server/timeline.ts");
const { DshChildSession, DshSession } = require("../server/session.ts");

test("subagent and subagent_fork preserve detail shapes and survive ProviderEventSchema.parse", () => {
  const builder = new TimelineBuilder({ warn() {} });

  // Synchronous subagent call with durable timestamps
  const startSub = builder.consume({
    type: "tool/call",
    seq: 1,
    time: 1_700_000_000_000,
    data: {
      callId: "sub-1",
      name: "subagent",
      arguments: {
        name: "scout-alpha",
        description: "Audit module layout",
        prompt: "Inspect server/ and report exports.",
        agent_preset: "explorer",
        provider: "fixture",
        model: "alpha",
      },
    },
  })[0];

  assert.equal(startSub.type, "tool_call");
  assert.deepEqual(startSub.detail, {
    type: "sub_agent",
    description: "Audit module layout",
    log: "",
  });
  assert.deepEqual(startSub.metadata[DSH_SUBAGENT_METADATA_KEY], {
    kind: "subagent",
    status: "running",
    role: "scout-alpha",
    title: "Audit module layout",
    task: "Inspect server/ and report exports.",
    preset: "explorer",
    model: "fixture/alpha",
  });
  // Unmeasured fields must be absent, never guessed.
  assert.equal("steps" in startSub.metadata[DSH_SUBAGENT_METADATA_KEY], false);
  assert.equal("durationMs" in startSub.metadata[DSH_SUBAGENT_METADATA_KEY], false);
  assert.equal("outputTokens" in startSub.metadata[DSH_SUBAGENT_METADATA_KEY], false);

  const doneSub = builder.consume({
    type: "tool/result",
    seq: 2,
    time: 1_700_000_004_250,
    data: {
      toolCallId: "sub-1",
      message: { content: [{ type: "text", text: "Found 3 exported functions." }] },
    },
  })[0];

  assert.deepEqual(doneSub.detail, {
    type: "sub_agent",
    description: "Audit module layout",
    log: "Found 3 exported functions.",
  });
  assert.deepEqual(doneSub.metadata[DSH_SUBAGENT_METADATA_KEY], {
    kind: "subagent",
    status: "completed",
    role: "scout-alpha",
    title: "Audit module layout",
    task: "Inspect server/ and report exports.",
    report: "Found 3 exported functions.",
    preset: "explorer",
    model: "fixture/alpha",
    durationMs: 4250,
  });

  const parsedSub = ProviderEventSchema.parse({
    type: "timeline.item",
    sessionId: "root-1",
    item: doneSub,
  });
  assert.deepEqual(parsedSub.item.detail, doneSub.detail);
  assert.deepEqual(
    parsedSub.item.metadata[DSH_SUBAGENT_METADATA_KEY],
    doneSub.metadata[DSH_SUBAGENT_METADATA_KEY],
  );

  // subagent_fork preserves detail.type === "unknown"
  builder.consume({
    type: "tool/call",
    seq: 3,
    data: {
      callId: "fork-1",
      name: "subagent_fork",
      arguments: {
        name: "branch-review",
        description: "Review diff on branch",
        prompt: "Check edge cases from prior context.",
      },
    },
  });
  const doneFork = builder.consume({
    type: "tool/result",
    seq: 4,
    data: {
      toolCallId: "fork-1",
      message: { content: [{ type: "text", text: "No regressions found." }] },
    },
  })[0];

  assert.equal(doneFork.detail.type, "unknown");
  assert.deepEqual(doneFork.metadata[DSH_SUBAGENT_METADATA_KEY], {
    kind: "subagent_fork",
    status: "completed",
    role: "branch-review",
    title: "Review diff on branch",
    task: "Check edge cases from prior context.",
    report: "No regressions found.",
  });
  // No event.time provided -> durationMs must be omitted, never 0.
  assert.equal("durationMs" in doneFork.metadata[DSH_SUBAGENT_METADATA_KEY], false);

  const parsedFork = ProviderEventSchema.parse({
    type: "timeline.item",
    sessionId: "root-1",
    item: doneFork,
  });
  assert.deepEqual(
    parsedFork.item.metadata[DSH_SUBAGENT_METADATA_KEY],
    doneFork.metadata[DSH_SUBAGENT_METADATA_KEY],
  );

  // Non-subagent tools never carry dshSubagent metadata
  const bashRow = builder.consume({
    type: "tool/call",
    seq: 5,
    data: { callId: "b1", name: "bash", arguments: { command: "ls" } },
  })[0];
  assert.equal(DSH_SUBAGENT_METADATA_KEY in (bashRow.metadata ?? {}), false);
});

test("canceled subagent tool call marks metadata.dshSubagent.status as canceled", () => {
  const builder = new TimelineBuilder({ warn() {} });
  builder.consume({
    type: "tool/call",
    seq: 1,
    data: { callId: "c-abort", name: "subagent", arguments: { name: "worker-1", description: "Long task", prompt: "Work" } },
  });
  const canceled = builder.consume({
    type: "turn/end",
    seq: 2,
    data: { turn: 1, reason: { kind: "aborted" } },
  })[0];
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.metadata[DSH_SUBAGENT_METADATA_KEY].status, "canceled");
});

test("async activation correlates subagent/catalog, ignores ack timing/text, and prevents failed duplicate calls from stealing child state", () => {
  const builder = new TimelineBuilder({ warn() {} });

  // Model omits `name`; DSH auto-assigns `agent-1` in catalog + result meta.
  builder.consume({
    type: "tool/call",
    seq: 1,
    time: 1000,
    data: {
      callId: "act-1",
      name: "subagent",
      arguments: { description: "Auto named scout", prompt: "Inspect codebase" },
    },
  });
  builder.consume({
    type: "subagent/catalog",
    seq: 2,
    data: {
      version: 3,
      childId: "child-uuid-1",
      childCreatedAt: 1020,
      mode: "continuable",
      label: "Auto named scout",
      name: "agent-1",
    },
  });
  const activated = builder.consume({
    type: "tool/result",
    seq: 3,
    time: 1095,
    data: {
      toolCallId: "act-1",
      meta: { kind: "activation", name: "agent-1" },
      message: { content: [{ type: "text", text: "started subagent agent-1" }] },
    },
  })[0];

  assert.equal(activated.status, "completed");
  const meta = activated.metadata[DSH_SUBAGENT_METADATA_KEY];
  assert.deepEqual(meta, {
    kind: "subagent",
    status: "running",
    role: "agent-1",
    title: "Auto named scout",
    task: "Inspect codebase",
    childSessionId: "child-uuid-1",
    mode: "continuable",
  });
  // Activation ack is NOT the report and 95ms ack is NOT execution durationMs.
  assert.equal("report" in meta, false);
  assert.equal("durationMs" in meta, false);

  // A failed duplicate-name call must NOT steal child-uuid-1's state.
  builder.consume({
    type: "tool/call",
    seq: 4,
    time: 2000,
    data: {
      callId: "act-dup-fail",
      name: "subagent",
      arguments: { name: "agent-1", description: "Duplicate name", prompt: "Retry" },
    },
  });
  const failedDup = builder.consume({
    type: "tool/result",
    seq: 5,
    time: 2050,
    data: {
      toolCallId: "act-dup-fail",
      message: {
        isError: true,
        content: [{ type: "text", text: 'Error: agent name "agent-1" is already used' }],
      },
    },
  })[0];
  assert.equal(failedDup.status, "failed");
  assert.deepEqual(failedDup.metadata[DSH_SUBAGENT_METADATA_KEY], {
    kind: "subagent",
    status: "failed",
    role: "agent-1",
    title: "Duplicate name",
    task: "Retry",
  });
  assert.equal("childSessionId" in failedDup.metadata[DSH_SUBAGENT_METADATA_KEY], false);
  assert.equal("durationMs" in failedDup.metadata[DSH_SUBAGENT_METADATA_KEY], false);

  // Settlement notice updates act-1 cleanly.
  const settled = builder.observeSubagentUserMessage({
    source: {
      kind: "subagent-settled",
      form: "notice",
      stopReason: "completed",
      senderSessionId: "child-uuid-1",
    },
    content: [
      { type: "text", text: "Background subagent agent-1 finished and will do no further work unless you send it more." },
      { type: "text", text: "Its closing message:" },
      { type: "text", text: "All checks verified." },
    ],
  });
  assert.ok(settled !== undefined);
  assert.equal(settled.callId, "act-1");
  assert.equal(settled.item.metadata[DSH_SUBAGENT_METADATA_KEY].status, "completed");
  assert.equal(settled.item.metadata[DSH_SUBAGENT_METADATA_KEY].report, "All checks verified.");
});

test("subagent-settled falls back to preceding relayed agent-message when closing message is omitted", () => {
  const relayed = parseRelayedAgentMessage({
    source: { kind: "agent-message", form: "relay", senderSessionId: "child-2" },
    content: [
      { type: "text", text: "Agent scout-b sent a message: " },
      { type: "text", text: "Final report via send_message." },
    ],
  });
  assert.deepEqual(relayed, { senderSessionId: "child-2", text: "Final report via send_message." });

  const notice = parseSubagentSettlementMessage({
    source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: "child-2" },
    content: [
      { type: "text", text: "Background subagent scout-b finished and will do no further work unless you send it more." },
      { type: "text", text: "It sent you a message just before finishing, so its closing message is omitted." },
    ],
  });
  assert.deepEqual(notice, {
    senderSessionId: "child-2",
    status: "completed",
    omittedForAgentMessage: true,
  });

  const builder = new TimelineBuilder({ warn() {} });
  builder.consume({
    type: "tool/call",
    seq: 1,
    data: { callId: "c2", name: "subagent", arguments: { name: "scout-b", description: "Scout B", prompt: "Do B" } },
  });
  builder.consume({
    type: "subagent/catalog",
    seq: 2,
    data: { version: 3, childId: "child-2", mode: "continuable", label: "Scout B", name: "scout-b" },
  });
  builder.consume({
    type: "tool/result",
    seq: 3,
    data: { toolCallId: "c2", meta: { kind: "activation", name: "scout-b" }, message: { content: [{ type: "text", text: "started subagent scout-b" }] } },
  });
  builder.observeSubagentUserMessage({
    source: { kind: "agent-message", form: "relay", senderSessionId: "child-2" },
    content: [
      { type: "text", text: "Agent scout-b sent a message: " },
      { type: "text", text: "Final report via send_message." },
    ],
  });
  const updated = builder.observeSubagentUserMessage({
    source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: "child-2" },
    content: [
      { type: "text", text: "Background subagent scout-b finished." },
      { type: "text", text: "It sent you a message just before finishing, so its closing message is omitted." },
    ],
  });
  assert.equal(updated?.item.metadata[DSH_SUBAGENT_METADATA_KEY].report, "Final report via send_message.");
});

test("extractSubagentTelemetryFromEvents ignores fork-inherited prefix and never fabricates missing fields", () => {
  const telemetry = extractSubagentTelemetryFromEvents(
    [
      {
        type: "subagent/descriptor",
        seq: 0,
        data: {
          version: 3,
          mode: "continuable",
          provider: "fork",
          label: "Forked branch",
          agentPreset: "reviewer",
          agentProvider: "fixture",
          agentModel: "beta",
        },
      },
      // Inherited parent events (seq < 4) must NOT be counted in steps/tokens/duration/report.
      { type: "turn/start", seq: 1, time: 1000, data: { turn: 0 } },
      {
        type: "assistant/message",
        seq: 2,
        time: 2000,
        data: {
          turn: 0,
          step: 1,
          usage: { inputTokens: 100, outputTokens: 9999 },
          message: { content: [{ type: "text", text: "INHERITED PARENT REPLY" }] },
        },
      },
      { type: "turn/end", seq: 3, time: 5000, data: { turn: 0, reason: { kind: "completed" } } },
      // Child's own suffix (seq >= 4)
      { type: "turn/start", seq: 4, time: 10000, data: { turn: 1 } },
      {
        type: "assistant/message",
        seq: 5,
        time: 12000,
        data: {
          turn: 1,
          step: 1,
          usage: { inputTokens: 200, outputTokens: 120 },
          message: { content: [{ type: "text", text: "Step 1 work" }] },
        },
      },
      {
        type: "assistant/message",
        seq: 6,
        time: 14500,
        data: {
          turn: 1,
          step: 2,
          usage: { inputTokens: 300, outputTokens: 380 },
          message: { content: [{ type: "text", text: "Child final conclusion." }] },
        },
      },
      { type: "turn/end", seq: 7, time: 15250, data: { turn: 1, reason: { kind: "completed" } } },
    ],
    4,
  );

  assert.deepEqual(telemetry, {
    status: "completed",
    report: "Child final conclusion.",
    mode: "continuable",
    preset: "reviewer",
    model: "fixture/beta",
    label: "Forked branch",
    steps: 2,
    durationMs: 5250,
    outputTokens: 500,
  });

  // Unmeasured log with no timestamps and no usage must omit durationMs & outputTokens
  const sparse = extractSubagentTelemetryFromEvents([
    { type: "turn/start", seq: 0, data: { turn: 1 } },
    {
      type: "assistant/message",
      seq: 1,
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "Done." }] } },
    },
    { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "aborted" } } },
  ]);
  assert.deepEqual(sparse, {
    status: "canceled",
    report: "Done.",
    steps: 1,
  });
  assert.equal("durationMs" in sparse, false);
  assert.equal("outputTokens" in sparse, false);
});

test("DshSession live same-turn updates merge in place and cross-turn completion never duplicates tool_call", async () => {
  let handlers;
  const fakeProcess = {
    async start() {},
    async shutdown() {},
    async attachSession(_sid, h) { handlers = h; },
    async closeSession() {},
    async usage() { return { available: false }; },
    async history() { return { available: true, events: [], inheritedEventCount: 0 }; },
    async subagents() { return { available: true, subagents: [] }; },
  };
  const emitted = [];
  const session = new DshSession({
    sessionId: "root-live",
    cwd: "/work",
    env: {},
    route: { provider: "fixture", model: "alpha" },
    mode: "build",
    modes: [{ id: "build", label: "Build", description: "Build" }],
    models: [{ id: "fixture/alpha", label: "Alpha", description: "fixture" }],
    thinkingOptions: [],
    subsession: true,
    emit: (event) => emitted.push(event),
    log() {},
    acquireProcess: async () => ({ process: fakeProcess, reused: false }),
    releaseProcess: () => {},
  });

  await session.open();
  session.markRootReady();

  // Start root turn 1
  handlers.onStatus("running", "root-live");
  handlers.onEvent({
    sessionId: "root-live",
    event: {
      type: "tool/call",
      seq: 1,
      time: 1000,
      data: { callId: "live-sub-1", name: "subagent", arguments: { name: "scout-1", description: "Live scout", prompt: "Inspect A" } },
    },
  });
  handlers.onEvent({
    sessionId: "root-live",
    event: {
      type: "subagent/catalog",
      seq: 2,
      data: { version: 3, childId: "live-child-1", mode: "continuable", label: "Live scout", name: "scout-1" },
    },
  });
  handlers.onEvent({
    sessionId: "root-live",
    event: {
      type: "tool/result",
      seq: 3,
      time: 1080,
      data: { toolCallId: "live-sub-1", meta: { kind: "activation", name: "scout-1" }, message: { content: [{ type: "text", text: "started subagent scout-1" }] } },
    },
  });

  // Child opens and completes WHILE root turn 1 is still active -> same-turn update emitted!
  handlers.onChildOpened({ sessionId: "live-child-1", parentSessionId: "root-live", mode: "continuable", label: "Live scout" });
  handlers.onEvent({
    sessionId: "live-child-1",
    event: { type: "turn/start", seq: 1, time: 1100, data: { turn: 1 } },
  });
  handlers.onEvent({
    sessionId: "live-child-1",
    event: {
      type: "assistant/message",
      seq: 2,
      time: 2100,
      data: { turn: 1, step: 1, usage: { outputTokens: 256 }, message: { content: [{ type: "text", text: "Live child output" }] } },
    },
  });
  handlers.onEvent({
    sessionId: "live-child-1",
    event: { type: "turn/end", seq: 3, time: 3100, data: { turn: 1, reason: { kind: "completed" } } },
  });

  const rootSubRowsTurn1 = emitted.filter(
    (e) => e.type === "timeline.item" && e.sessionId === "root-live" && e.item?.callId === "live-sub-1",
  );
  const latestTurn1 = rootSubRowsTurn1.at(-1)?.item;
  assert.ok(latestTurn1 !== undefined);
  assert.deepEqual(latestTurn1.metadata[DSH_SUBAGENT_METADATA_KEY], {
    kind: "subagent",
    status: "completed",
    role: "scout-1",
    title: "Live scout",
    task: "Inspect A",
    report: "Live child output",
    childSessionId: "live-child-1",
    mode: "continuable",
    steps: 1,
    durationMs: 2000,
    outputTokens: 256,
  });

  // Spawn a second subagent in turn 1, then END turn 1 before child-2 finishes.
  handlers.onEvent({
    sessionId: "root-live",
    event: {
      type: "tool/call",
      seq: 4,
      time: 3200,
      data: { callId: "live-sub-2", name: "subagent_fork", arguments: { name: "fork-2", description: "Async fork", prompt: "Inspect B" } },
    },
  });
  handlers.onEvent({
    sessionId: "root-live",
    event: {
      type: "subagent/catalog",
      seq: 5,
      data: { version: 3, childId: "live-child-2", mode: "continuable", label: "Async fork", name: "fork-2" },
    },
  });
  handlers.onEvent({
    sessionId: "root-live",
    event: {
      type: "tool/result",
      seq: 6,
      time: 3260,
      data: { toolCallId: "live-sub-2", meta: { kind: "activation", name: "fork-2" }, message: { content: [{ type: "text", text: "started subagent fork-2" }] } },
    },
  });
  handlers.onChildOpened({ sessionId: "live-child-2", parentSessionId: "root-live", mode: "continuable", label: "Async fork" });
  handlers.onEvent({ sessionId: "root-live", event: { type: "turn/end", seq: 7, data: { turn: 1, reason: { kind: "completed" } } } });
  handlers.onStatus("idle", "root-live");

  const countBeforeCrossTurn = emitted.filter(
    (e) => e.type === "timeline.item" && e.sessionId === "root-live" && e.item?.callId === "live-sub-2",
  ).length;

  // Now child-2 finishes AFTER root turn 1 ended (and during turn 2) -> MUST NOT re-emit cross-turn tool_call!
  handlers.onStatus("running", "root-live");
  handlers.onEvent({
    sessionId: "live-child-2",
    event: { type: "turn/start", seq: 1, time: 4000, data: { turn: 1 } },
  });
  handlers.onEvent({
    sessionId: "live-child-2",
    event: {
      type: "assistant/message",
      seq: 2,
      time: 5000,
      data: { turn: 1, step: 1, usage: { outputTokens: 100 }, message: { content: [{ type: "text", text: "Late finish" }] } },
    },
  });
  handlers.onEvent({
    sessionId: "live-child-2",
    event: { type: "turn/end", seq: 3, time: 6000, data: { turn: 1, reason: { kind: "completed" } } },
  });
  handlers.onEvent({
    sessionId: "root-live",
    event: {
      type: "user/message",
      seq: 8,
      data: {
        source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: "live-child-2" },
        content: [{ type: "text", text: "Background subagent fork-2 finished." }, { type: "text", text: "Its closing message:" }, { type: "text", text: "Late finish" }],
      },
    },
  });

  const countAfterCrossTurn = emitted.filter(
    (e) => e.type === "timeline.item" && e.sessionId === "root-live" && e.item?.callId === "live-sub-2",
  ).length;
  assert.equal(countAfterCrossTurn, countBeforeCrossTurn, "must not re-emit cross-turn tool_call");

  await session.close();
});

test("DshSession.replayHistory hydrates subagent metadata from parent log and child telemetry without extra RPCs when no subagents exist", async () => {
  const historyCalls = [];
  const histories = new Map();
  histories.set("root-replay", {
    available: true,
    inheritedEventCount: 0,
    events: [
      { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } },
      {
        type: "assistant/message",
        seq: 2,
        time: 1100,
        data: {
          turn: 1,
          step: 1,
          message: {
            content: [
              {
                type: "tool-call",
                id: "call-fork",
                name: "subagent_fork",
                arguments: { name: "fork-scout", description: "Check fork telemetry", prompt: "Inspect fork diff" },
              },
            ],
          },
        },
      },
      {
        type: "subagent/catalog",
        seq: 3,
        time: 1150,
        data: { version: 3, childId: "child-fork-1", childCreatedAt: 1120, mode: "continuable", label: "Check fork telemetry", name: "fork-scout" },
      },
      {
        type: "tool/result",
        seq: 4,
        time: 1180,
        data: {
          toolCallId: "call-fork",
          meta: { kind: "activation", name: "fork-scout" },
          message: { content: [{ type: "text", text: "started subagent fork-scout" }] },
        },
      },
      { type: "turn/end", seq: 5, time: 1200, data: { turn: 1, reason: { kind: "completed" } } },
      { type: "turn/start", seq: 6, time: 9500, data: { turn: 2 } },
      {
        type: "user/message",
        seq: 7,
        time: 9500,
        data: {
          source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: "child-fork-1" },
          content: [
            { type: "text", text: "Background subagent fork-scout finished." },
            { type: "text", text: "Its closing message:" },
            { type: "text", text: "Fork audit passed cleanly." },
          ],
        },
      },
      { type: "turn/end", seq: 8, time: 9600, data: { turn: 2, reason: { kind: "completed" } } },
    ],
  });
  histories.set("child-fork-1", {
    available: true,
    inheritedEventCount: 2,
    events: [
      {
        type: "subagent/descriptor",
        seq: 0,
        data: { version: 3, mode: "continuable", provider: "fork", label: "Check fork telemetry", agentProvider: "fixture", agentModel: "gamma" },
      },
      {
        type: "assistant/message",
        seq: 1,
        time: 500,
        data: { turn: 0, step: 1, usage: { outputTokens: 8888 }, message: { content: [{ type: "text", text: "PARENT PREFIX" }] } },
      },
      { type: "turn/start", seq: 2, time: 1200, data: { turn: 1 } },
      {
        type: "assistant/message",
        seq: 3,
        time: 4000,
        data: { turn: 1, step: 1, usage: { outputTokens: 150 }, message: { content: [{ type: "text", text: "Checking..." }] } },
      },
      {
        type: "assistant/message",
        seq: 4,
        time: 7000,
        data: { turn: 1, step: 2, usage: { outputTokens: 350 }, message: { content: [{ type: "text", text: "Fork audit passed cleanly." }] } },
      },
      { type: "turn/end", seq: 5, time: 7400, data: { turn: 1, reason: { kind: "completed" } } },
    ],
  });

  const fakeProcess = {
    async start() {},
    async shutdown() {},
    async attachSession() {},
    async closeSession() {},
    async usage() { return { available: false }; },
    async history(sid) {
      historyCalls.push(sid);
      const entry = histories.get(sid);
      if (entry === undefined) throw new Error(`missing fixture ${sid}`);
      return entry;
    },
  };

  const emitted = [];
  const session = new DshSession({
    sessionId: "root-replay",
    cwd: "/work",
    env: {},
    route: { provider: "fixture", model: "alpha" },
    mode: "build",
    modes: [],
    models: [],
    thinkingOptions: [],
    subsession: true,
    emit: (event) => emitted.push(event),
    log() {},
    acquireProcess: async () => ({ process: fakeProcess, reused: false }),
    releaseProcess: () => {},
  });

  await session.open();
  await session.replayHistory();

  assert.deepEqual(historyCalls, ["root-replay", "child-fork-1"]);
  const replayedRows = emitted.filter(
    (e) => e.type === "timeline.item" && e.item?.type === "tool_call" && e.item?.callId === "call-fork",
  );
  // Running (tool-call block) + completed (tool/result) inside turn 1 only
  const completedRow = replayedRows.find((e) => e.item.status === "completed")?.item;
  assert.ok(completedRow !== undefined);
  assert.deepEqual(completedRow.metadata[DSH_SUBAGENT_METADATA_KEY], {
    kind: "subagent_fork",
    status: "completed",
    role: "fork-scout",
    title: "Check fork telemetry",
    task: "Inspect fork diff",
    report: "Fork audit passed cleanly.",
    childSessionId: "child-fork-1",
    mode: "continuable",
    model: "fixture/gamma",
    steps: 2,
    durationMs: 6200,
    outputTokens: 500,
  });

  // Control: session without subagent calls makes ZERO child history RPCs.
  const plainCalls = [];
  const plainProcess = {
    async start() {},
    async shutdown() {},
    async attachSession() {},
    async closeSession() {},
    async usage() { return { available: false }; },
    async history(sid) {
      plainCalls.push(sid);
      return {
        available: true,
        inheritedEventCount: 0,
        events: [
          { type: "turn/start", seq: 1, data: { turn: 1 } },
          { type: "tool/call", seq: 2, data: { callId: "b1", name: "bash", arguments: { command: "pwd" } } },
          { type: "tool/result", seq: 3, data: { toolCallId: "b1", message: { content: [{ type: "text", text: "/work" }] } } },
          { type: "turn/end", seq: 4, data: { turn: 1, reason: { kind: "completed" } } },
        ],
      };
    },
  };
  const plainSession = new DshSession({
    sessionId: "plain-root",
    cwd: "/work",
    env: {},
    route: { provider: "fixture", model: "alpha" },
    mode: "build",
    modes: [],
    models: [],
    thinkingOptions: [],
    subsession: true,
    emit() {},
    log() {},
    acquireProcess: async () => ({ process: plainProcess, reused: false }),
    releaseProcess: () => {},
  });
  await plainSession.open();
  await plainSession.replayHistory();
  assert.deepEqual(plainCalls, ["plain-root"]);

  await session.close();
  await plainSession.close();
});

test("DshChildSession tracks telemetry across replay + live continuation and fail()", () => {
  const reports = [];
  const child = new DshChildSession({
    id: "root:sub:c1",
    nativeId: "c1",
    subsession: true,
    cwd: "/work",
    closed: () => false,
    emit() {},
    log() {},
    resolvePermission() {},
    onTelemetry: (nativeId, telemetry) => reports.push({ nativeId, telemetry }),
  });

  child.replay(
    [
      { type: "subagent/descriptor", seq: 0, data: { mode: "continuable", agentPreset: "analyst", label: "Analyze" } },
      { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } },
      {
        type: "assistant/message",
        seq: 2,
        time: 2000,
        data: { turn: 1, step: 1, usage: { outputTokens: 40 }, message: { content: [{ type: "text", text: "Turn 1 done" }] } },
      },
      { type: "turn/end", seq: 3, time: 2500, data: { turn: 1, reason: { kind: "completed" } } },
    ],
    0,
  );
  assert.deepEqual(child.telemetry(), {
    status: "completed",
    report: "Turn 1 done",
    mode: "continuable",
    preset: "analyst",
    label: "Analyze",
    steps: 1,
    durationMs: 1500,
    outputTokens: 40,
  });

  // Live continuation turn 2
  child.event({ type: "turn/start", time: 5000, data: { turn: 2 } });
  child.event({
    type: "assistant/message",
    time: 6000,
    data: { turn: 2, step: 1, usage: { outputTokens: 60 }, message: { content: [{ type: "text", text: "Turn 2 done" }] } },
  });
  child.fail("process crashed");
  assert.deepEqual(child.telemetry(), {
    status: "failed",
    report: "Turn 2 done",
    mode: "continuable",
    preset: "analyst",
    label: "Analyze",
    steps: 2,
    durationMs: 1500,
    outputTokens: 100,
  });
  assert.ok(reports.length >= 3);
});

test("sanitizeSubagentMetadata, subagentMetadataFromItemMetadata, and resolveSubagentCardMetadata validate and degrade cleanly", () => {
  assert.equal(sanitizeSubagentMetadata(null), null);
  assert.equal(sanitizeSubagentMetadata({ kind: "other", status: "completed" }), null);
  assert.equal(sanitizeSubagentMetadata({ kind: "subagent", status: "unknown" }), null);

  const sanitized = sanitizeSubagentMetadata({
    kind: "subagent",
    status: "completed",
    role: " scout ",
    title: "",
    steps: -1,
    durationMs: Number.NaN,
    outputTokens: 42.5,
  });
  assert.deepEqual(sanitized, {
    kind: "subagent",
    status: "completed",
    role: "scout",
  });

  assert.deepEqual(
    subagentMetadataFromItemMetadata({
      [DSH_SUBAGENT_METADATA_KEY]: { kind: "subagent_fork", status: "running", steps: 2, durationMs: 321.4, outputTokens: 99 },
    }),
    { kind: "subagent_fork", status: "running", steps: 2, durationMs: 321, outputTokens: 99 },
  );

  // Fallback for historical pre-upgrade subagent row without metadata.dshSubagent
  const legacySub = resolveSubagentCardMetadata({
    name: "subagent",
    status: "completed",
    detail: { type: "sub_agent", description: "Legacy explore", log: "Legacy report" },
  });
  assert.deepEqual(legacySub, {
    kind: "subagent",
    status: "completed",
    title: "Legacy explore",
    report: "Legacy report",
  });

  // Fallback for historical activation row recognizes started subagent ack
  const legacyActivation = resolveSubagentCardMetadata({
    name: "subagent",
    status: "completed",
    detail: { type: "sub_agent", description: "Background task", log: "started subagent scout-x" },
  });
  assert.deepEqual(legacyActivation, {
    kind: "subagent",
    status: "running",
    role: "scout-x",
    title: "Background task",
  });

  // Fallback for historical subagent_fork row
  const legacyFork = resolveSubagentCardMetadata({
    name: "subagent_fork",
    status: "completed",
    detail: {
      type: "unknown",
      input: { name: "fork-a", description: "Fork task", prompt: "Full fork prompt", provider: "p", model: "m" },
      output: "Fork output",
    },
  });
  assert.deepEqual(legacyFork, {
    kind: "subagent_fork",
    status: "completed",
    role: "fork-a",
    title: "Fork task",
    task: "Full fork prompt",
    report: "Fork output",
    model: "p/m",
  });

  assert.equal(resolveSubagentCardMetadata({ name: "bash", status: "completed", detail: { type: "shell", command: "ls" } }), null);
});

test("parseListAgentsOutput handles all DSH generations and fails closed on malformed shapes", () => {
  // 1. DSH 0.2.2-rc.3+ plain-text lines
  const textOut = [
    "lead [running] — root agent",
    "scout-a [running] — Check path A",
    "scout-b [inactive] — Check path B",
    "scout-b/checker [corrupt]",
    "scout-c [completed] — Done",
  ].join("\n");
  const parsedText = parseListAgentsOutput(textOut);
  assert.ok(parsedText !== null);
  assert.equal(parsedText.format, "text");
  assert.equal(parsedText.leadOnly, false);
  assert.equal(parsedText.leadStatus, "running");
  assert.deepEqual(parsedText.counts, {
    total: 4,
    running: 1,
    inactive: 1,
    completed: 1,
    failed: 0,
    canceled: 0,
    archived: 0,
    diagnostic: 1,
    other: 0,
  });
  assert.deepEqual(parsedText.byStatus, {
    running: 1,
    inactive: 1,
    corrupt: 1,
    completed: 1,
  });

  // Lead-only plain text
  const leadOnlyText = parseListAgentsOutput("lead [running] — root agent");
  assert.ok(leadOnlyText !== null);
  assert.equal(leadOnlyText.leadOnly, true);
  assert.equal(leadOnlyText.counts.total, 0);
  assert.equal(leadOnlyText.counts.running, 0);

  // 2. DSH 0.2.2-rc.2 JSON tree
  const treeJson = JSON.stringify([
    { name: "lead", status: "running", description: "root agent" },
    { name: "reviewer", status: "inactive", description: "Review" },
    { name: "reviewer/checker", status: "running" },
    { name: "worker-x", status: "failed" },
  ]);
  const parsedTree = parseListAgentsOutput(treeJson);
  assert.ok(parsedTree !== null);
  assert.equal(parsedTree.format, "tree-json");
  assert.equal(parsedTree.counts.total, 3);
  assert.equal(parsedTree.counts.running, 1);
  assert.equal(parsedTree.counts.inactive, 1);
  assert.equal(parsedTree.counts.failed, 1);

  // 3. DSH <= 0.2.1 JSON roster
  const rosterJson = JSON.stringify([
    { target: "lead", role: "lead", status: "running" },
    { target: "worker-1", role: "teammate", status: "completed", description: "Unit 1" },
    { target: "worker-2", role: "teammate", status: "archived" },
    { target: "worker-3", role: "teammate", status: "aborted" },
  ]);
  const parsedRoster = parseListAgentsOutput(rosterJson);
  assert.ok(parsedRoster !== null);
  assert.equal(parsedRoster.format, "roster-json");
  assert.equal(parsedRoster.counts.total, 3);
  assert.equal(parsedRoster.counts.completed, 1);
  assert.equal(parsedRoster.counts.archived, 1);
  assert.equal(parsedRoster.counts.canceled, 1);

  // 4. Empty variants
  assert.equal(parseListAgentsOutput("[]")?.format, "empty");
  assert.equal(parseListAgentsOutput("(no subagents)")?.format, "empty");

  // 5. Fail closed on failures, mixed JSON arrays, and garbage prose
  assert.equal(parseListAgentsOutput(textOut, true), null);
  assert.equal(
    parseListAgentsOutput(JSON.stringify([{ target: "lead", role: "lead", status: "running" }, { name: "x", status: "running" }])),
    null,
  );
  assert.equal(parseListAgentsOutput("some random error text"), null);
  assert.equal(parseListAgentsOutput(""), null);

  assert.equal(classifyListAgentStatus("unavailable"), "diagnostic");
  assert.equal(classifyListAgentStatus("unknown_future_state"), "other");
});

test("parseArchiveSubagentsOutput and parseSubagentStatusChips handle text, dry-run, JSON, and malformed outputs", () => {
  // Rendered 5-line text (real archive)
  const textArchived = [
    "children of this session: 8 candidate(s)",
    "archived 5: id-1, id-2, id-3, id-4, id-5",
    "already archived 2: id-6, id-7",
    "running (skipped) 1: id-8",
    "failed: none",
  ].join("\n");
  assert.deepEqual(parseArchiveSubagentsOutput(textArchived), {
    scope: "session",
    dryRun: false,
    total: 8,
    archived: 5,
    alreadyArchived: 2,
    running: 1,
    failed: 0,
  });

  // Dry run with scope="all" and failures
  const textDryRun = [
    "all stored subagent sessions: 4 candidate(s)",
    "[dry run] would archive 2: id-1, id-2",
    "already archived 0: none",
    "running (skipped) 1: id-3",
    "failed 1: id-4 (permission denied)",
  ].join("\n");
  assert.deepEqual(parseArchiveSubagentsOutput(textDryRun), {
    scope: "all",
    dryRun: true,
    total: 4,
    archived: 2,
    alreadyArchived: 0,
    running: 1,
    failed: 1,
  });

  // JSON object / JSON string format
  const jsonPayload = {
    scope: "session",
    dryRun: false,
    total: 3,
    archived: ["a", "b"],
    alreadyArchived: [],
    running: ["c"],
    failed: [],
  };
  assert.deepEqual(parseArchiveSubagentsOutput(jsonPayload), {
    scope: "session",
    dryRun: false,
    total: 3,
    archived: 2,
    alreadyArchived: 0,
    running: 1,
    failed: 0,
  });
  assert.deepEqual(parseArchiveSubagentsOutput(JSON.stringify(jsonPayload)), {
    scope: "session",
    dryRun: false,
    total: 3,
    archived: 2,
    alreadyArchived: 0,
    running: 1,
    failed: 0,
  });

  // Unified chip dispatcher
  assert.equal(parseSubagentStatusChips("list_agents", "lead [running] — root agent")?.kind, "list_agents");
  assert.equal(parseSubagentStatusChips("archive_subagents", textArchived)?.kind, "archive_subagents");
  assert.equal(parseSubagentStatusChips("bash", textArchived), null);

  // Fail closed
  assert.equal(parseArchiveSubagentsOutput(textArchived, true), null);
  assert.equal(parseArchiveSubagentsOutput("not an archive report"), null);
  assert.equal(parseArchiveSubagentsOutput(JSON.stringify({ scope: "invalid" })), null);

  // Activation & stop-reason helpers
  assert.deepEqual(parseSubagentActivation({ kind: "activation", name: "worker-1" }), { kind: "activation", name: "worker-1" });
  assert.deepEqual(parseSubagentActivation(undefined, "started subagent worker-2"), { kind: "activation", name: "worker-2" });
  assert.equal(parseSubagentActivation(undefined, "plain final answer"), null);
  assert.equal(mapSubagentStopReason({ kind: "completed" }), "completed");
  assert.equal(mapSubagentStopReason("aborted"), "canceled");
  assert.equal(mapSubagentStopReason("max-tokens"), "failed");
  assert.equal(mapSubagentStopReason(undefined), undefined);
});

test("cold reopen closes killed/empty async subagent metadata as canceled while live-joined keeps running", async () => {
  const buildRootEvents = () => [
    { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } },
    {
      type: "tool/call",
      seq: 2,
      time: 1010,
      data: { callId: "c-mid", name: "subagent", arguments: { name: "mid-worker", description: "Killed mid-turn", prompt: "Work mid" } },
    },
    {
      type: "subagent/catalog",
      seq: 3,
      data: { version: 3, childId: "child-mid", mode: "continuable", label: "Killed mid-turn", name: "mid-worker" },
    },
    {
      type: "tool/result",
      seq: 4,
      time: 1050,
      data: { toolCallId: "c-mid", meta: { kind: "activation", name: "mid-worker" }, message: { content: [{ type: "text", text: "started subagent mid-worker" }] } },
    },
    {
      type: "tool/call",
      seq: 5,
      time: 1060,
      data: { callId: "c-empty", name: "subagent", arguments: { name: "empty-worker", description: "Never started", prompt: "Work empty" } },
    },
    {
      type: "subagent/catalog",
      seq: 6,
      data: { version: 3, childId: "child-empty", mode: "continuable", label: "Never started", name: "empty-worker" },
    },
    {
      type: "tool/result",
      seq: 7,
      time: 1090,
      data: { toolCallId: "c-empty", meta: { kind: "activation", name: "empty-worker" }, message: { content: [{ type: "text", text: "started subagent empty-worker" }] } },
    },
    { type: "turn/end", seq: 8, time: 1100, data: { turn: 1, reason: { kind: "completed" } } },
  ];

  const runScenario = async (reused) => {
    const histories = new Map([
      ["root-reopen", { available: true, inheritedEventCount: 0, events: buildRootEvents() }],
      [
        "child-mid",
        {
          available: true,
          inheritedEventCount: 0,
          events: [
            { type: "turn/start", seq: 0, time: 1060, data: { turn: 1 } },
            {
              type: "assistant/message",
              seq: 1,
              time: 1500,
              data: { turn: 1, step: 1, usage: { outputTokens: 75 }, message: { content: [{ type: "text", text: "Partial work" }] } },
            },
          ],
        },
      ],
      ["child-empty", { available: true, inheritedEventCount: 0, events: [] }],
    ]);
    const fakeProcess = {
      async start() {},
      async shutdown() {},
      async attachSession() {},
      async closeSession() {},
      async usage() { return { available: false }; },
      async history(sid) { return histories.get(sid); },
    };
    const emitted = [];
    const session = new DshSession({
      sessionId: "root-reopen",
      cwd: "/work",
      env: {},
      route: { provider: "fixture", model: "alpha" },
      mode: "build",
      modes: [],
      models: [],
      thinkingOptions: [],
      subsession: true,
      emit: (event) => emitted.push(event),
      log() {},
      acquireProcess: async () => ({ process: fakeProcess, reused }),
      releaseProcess: () => {},
    });
    await session.open();
    await session.replayHistory();
    await session.close();
    const completedByCallId = (callId) =>
      emitted
        .filter((e) => e.type === "timeline.item" && e.item?.type === "tool_call" && e.item?.callId === callId && e.item?.status === "completed")
        .at(-1)?.item?.metadata?.[DSH_SUBAGENT_METADATA_KEY];
    return { mid: completedByCallId("c-mid"), empty: completedByCallId("c-empty") };
  };

  // Cold reopen (`reused: false`): both mid-turn killed and empty never-started children must close as canceled
  const cold = await runScenario(false);
  assert.equal(cold.mid.status, "canceled");
  assert.equal(cold.mid.steps, 1);
  assert.equal(cold.mid.outputTokens, 75);
  assert.equal("durationMs" in cold.mid, false);
  assert.equal(cold.empty.status, "canceled");
  assert.equal("steps" in cold.empty, false);
  assert.equal("outputTokens" in cold.empty, false);

  // Live-joined (`reused: true`): mid-turn child in the still-running shared process stays running
  const liveJoined = await runScenario(true);
  assert.equal(liveJoined.mid.status, "running");
  assert.equal(liveJoined.mid.steps, 1);
  assert.equal(liveJoined.mid.outputTokens, 75);
});

test("overlapping replay and live assistant/message for the same (turn, step) does not double-count outputTokens", () => {
  const duplicateEvent = {
    type: "assistant/message",
    seq: 2,
    time: 2000,
    data: {
      turn: 1,
      step: 1,
      usage: { outputTokens: 256 },
      message: { content: [{ type: "text", text: "Step 1 answer" }] },
    },
  };

  // 1. DshChildSession: replay() followed by buffered live event() for the same (turn, step)
  const child = new DshChildSession({
    id: "root:sub:overlap-1",
    nativeId: "overlap-1",
    subsession: true,
    cwd: "/work",
    closed: () => false,
    emit() {},
    log() {},
    resolvePermission() {},
  });
  child.replay(
    [
      { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } },
      duplicateEvent,
    ],
    0,
    true,
  );
  // Buffered live frame for the exact same (turn: 1, step: 1) arrives immediately after replay
  child.event(duplicateEvent);
  // Genuine next step (turn: 1, step: 2) adds cleanly
  child.event({
    type: "assistant/message",
    seq: 3,
    time: 3000,
    data: {
      turn: 1,
      step: 2,
      usage: { outputTokens: 144 },
      message: { content: [{ type: "text", text: "Step 2 answer" }] },
    },
  });
  child.event({ type: "turn/end", seq: 4, time: 3500, data: { turn: 1, reason: { kind: "completed" } } });

  assert.deepEqual(child.telemetry(), {
    status: "completed",
    report: "Step 2 answer",
    steps: 2,
    durationMs: 2500,
    outputTokens: 400,
  });

  // 2. Pure extractor symmetry: duplicate (turn, step) in an event stream is idempotent
  const extracted = extractSubagentTelemetryFromEvents([
    { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } },
    duplicateEvent,
    duplicateEvent,
    { type: "turn/end", seq: 3, time: 2500, data: { turn: 1, reason: { kind: "completed" } } },
  ]);
  assert.deepEqual(extracted, {
    status: "completed",
    report: "Step 1 answer",
    steps: 1,
    durationMs: 1500,
    outputTokens: 256,
  });
});

test("DshSession pushes cross-turn subagent completions over subscribeSubagentCards without duplicating timeline tool_call", async () => {
  let handlers;
  const fakeProcess = {
    async start() {},
    async shutdown() {},
    async attachSession(_sid, h) { handlers = h; },
    async closeSession() {},
    async usage() { return { available: false }; },
    async history() { return { available: true, events: [], inheritedEventCount: 0 }; },
    async subagents() { return { available: true, subagents: [] }; },
  };
  const emitted = [];
  const session = new DshSession({
    sessionId: "root-cross-turn",
    cwd: "/work",
    env: { PASEO_AGENT_ID: "agent-cross-1" },
    route: { provider: "fixture", model: "alpha" },
    mode: "build",
    modes: [],
    models: [],
    thinkingOptions: [],
    subsession: true,
    emit: (event) => emitted.push(event),
    log() {},
    acquireProcess: async () => ({ process: fakeProcess, reused: false }),
    releaseProcess: () => {},
  });

  await session.open();
  session.markRootReady();

  const pushed = [];
  const unsub = session.subscribeSubagentCards((cards) => {
    pushed.push(cards);
  });

  // Turn 1 spawns async subagent, then Turn 1 finishes before child completes.
  handlers.onStatus("running", "root-cross-turn");
  handlers.onEvent({
    sessionId: "root-cross-turn",
    event: {
      type: "tool/call",
      seq: 1,
      time: 1000,
      data: {
        callId: "call-async-1",
        name: "subagent",
        arguments: { name: "scout-async", description: "后台核查接口", prompt: "检查全部导出" },
      },
    },
  });
  handlers.onEvent({
    sessionId: "root-cross-turn",
    event: {
      type: "tool/result",
      seq: 2,
      time: 1060,
      data: {
        toolCallId: "call-async-1",
        meta: { kind: "activation", name: "scout-async" },
        message: { content: [{ type: "text", text: "started subagent scout-async" }] },
      },
    },
  });
  // Catalog arrives live AFTER tool/result -> binds childId and updates card
  handlers.onEvent({
    sessionId: "root-cross-turn",
    event: {
      type: "subagent/catalog",
      seq: 3,
      data: {
        version: 3,
        childId: "child-async-1",
        mode: "continuable",
        label: "后台核查接口",
        name: "scout-async",
      },
    },
  });
  handlers.onChildOpened({
    sessionId: "child-async-1",
    parentSessionId: "root-cross-turn",
    mode: "continuable",
    label: "后台核查接口",
  });
  handlers.onEvent({
    sessionId: "root-cross-turn",
    event: { type: "turn/end", seq: 4, data: { turn: 1, reason: { kind: "completed" } } },
  });
  handlers.onStatus("idle", "root-cross-turn");

  const toolRowsBefore = emitted.filter(
    (e) => e.type === "timeline.item" && e.sessionId === "root-cross-turn" && e.item?.callId === "call-async-1",
  ).length;
  assert.equal(session.subagentCardsSnapshot()["call-async-1"]?.status, "running");

  // Child finishes AFTER Turn 1 ended (root is idle): subscription MUST receive completed card!
  handlers.onEvent({
    sessionId: "child-async-1",
    event: { type: "turn/start", seq: 1, time: 2000, data: { turn: 1 } },
  });
  handlers.onEvent({
    sessionId: "child-async-1",
    event: {
      type: "assistant/message",
      seq: 2,
      time: 3200,
      data: {
        turn: 1,
        step: 1,
        usage: { outputTokens: 180 },
        message: { content: [{ type: "text", text: "全部导出核查完成。" }] },
      },
    },
  });
  handlers.onEvent({
    sessionId: "child-async-1",
    event: { type: "turn/end", seq: 3, time: 4500, data: { turn: 1, reason: { kind: "completed" } } },
  });

  const latestPushed = pushed.at(-1)?.["call-async-1"];
  assert.deepEqual(latestPushed, {
    kind: "subagent",
    status: "completed",
    role: "scout-async",
    title: "后台核查接口",
    task: "检查全部导出",
    report: "全部导出核查完成。",
    childSessionId: "child-async-1",
    mode: "continuable",
    steps: 1,
    durationMs: 2500,
    outputTokens: 180,
  });
  assert.deepEqual(session.subagentCardsSnapshot()["call-async-1"], latestPushed);

  const toolRowsAfter = emitted.filter(
    (e) => e.type === "timeline.item" && e.sessionId === "root-cross-turn" && e.item?.callId === "call-async-1",
  ).length;
  assert.equal(toolRowsAfter, toolRowsBefore, "cross-turn live completion must never duplicate timeline tool_call");

  unsub();
  await session.close();
});

test("reopened-while-running subagent settles live over subscribeSubagentCards after mergeSubagentState", async () => {
  let handlers;
  const histories = new Map([
    [
      "root-reopen-live",
      {
        available: true,
        inheritedEventCount: 0,
        events: [
          { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } },
          {
            type: "tool/call",
            seq: 2,
            time: 1010,
            data: { callId: "call-live-reopen", name: "subagent", arguments: { name: "runner-1", description: "持续运行任务", prompt: "继续检查" } },
          },
          {
            type: "subagent/catalog",
            seq: 3,
            data: { version: 3, childId: "child-live-reopen", mode: "continuable", label: "持续运行任务", name: "runner-1" },
          },
          {
            type: "tool/result",
            seq: 4,
            time: 1050,
            data: { toolCallId: "call-live-reopen", meta: { kind: "activation", name: "runner-1" }, message: { content: [{ type: "text", text: "started subagent runner-1" }] } },
          },
          { type: "turn/end", seq: 5, time: 1100, data: { turn: 1, reason: { kind: "completed" } } },
        ],
      },
    ],
    [
      "child-live-reopen",
      {
        available: true,
        inheritedEventCount: 0,
        events: [{ type: "turn/start", seq: 0, time: 1060, data: { turn: 1 } }],
      },
    ],
  ]);
  const fakeProcess = {
    async start() {},
    async shutdown() {},
    async attachSession(_sid, h) { handlers = h; },
    async closeSession() {},
    async usage() { return { available: false }; },
    async history(sid) { return histories.get(sid); },
    async subagents() { return { available: true, subagents: [] }; },
  };
  const session = new DshSession({
    sessionId: "root-reopen-live",
    cwd: "/work",
    env: { PASEO_AGENT_ID: "agent-reopen-live" },
    route: { provider: "fixture", model: "alpha" },
    mode: "build",
    modes: [],
    models: [],
    thinkingOptions: [],
    subsession: true,
    emit() {},
    log() {},
    acquireProcess: async () => ({ process: fakeProcess, reused: true }),
    releaseProcess: () => {},
  });

  await session.open();
  await session.replayHistory();
  session.markRootReady();

  assert.equal(session.subagentCardsSnapshot()["call-live-reopen"]?.status, "running");

  const pushed = [];
  const unsub = session.subscribeSubagentCards((cards) => pushed.push(cards));

  // Later parent receives subagent-settled for the replayed running call
  handlers.onEvent({
    sessionId: "root-reopen-live",
    event: {
      type: "user/message",
      seq: 6,
      data: {
        source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: "child-live-reopen" },
        content: [
          { type: "text", text: "Background subagent runner-1 finished." },
          { type: "text", text: "Its closing message:" },
          { type: "text", text: "重开后完成报告。" },
        ],
      },
    },
  });

  assert.equal(pushed.at(-1)?.["call-live-reopen"]?.status, "completed");
  assert.equal(pushed.at(-1)?.["call-live-reopen"]?.report, "重开后完成报告。");
  assert.equal(session.subagentCardsSnapshot()["call-live-reopen"]?.status, "completed");

  unsub();
  await session.close();
});

test("DshChildSession.status('idle') without turn/end closes telemetry as completed and notifies parent", () => {
  const reports = [];
  const child = new DshChildSession({
    id: "root:sub:idle-only",
    nativeId: "idle-only",
    subsession: true,
    cwd: "/work",
    closed: () => false,
    emit() {},
    log() {},
    resolvePermission() {},
    onTelemetry: (nativeId, telemetry) => reports.push({ nativeId, telemetry }),
  });

  child.status("running");
  child.event({
    type: "assistant/message",
    time: 2000,
    data: { turn: 1, step: 1, usage: { outputTokens: 55 }, message: { content: [{ type: "text", text: "Done via status idle" }] } },
  });
  child.status("idle");

  assert.equal(child.telemetry().status, "completed");
  assert.equal(child.telemetry().report, "Done via status idle");
  assert.equal(reports.at(-1)?.telemetry.status, "completed");
});

test("client/subagent-live shares one subscription per agent, merges settled updates, keeps LRU cache on remount, and aborts on settle", () => {
  const Module = require("node:module");
  const path = require("node:path");
  const liveModPath = require.resolve("../client/subagent-live.ts");
  const listeners = new Set();
  const effectCleanups = [];
  const reactStub = {
    useSyncExternalStore(subscribe, getSnapshot) {
      const unsub = subscribe(() => {});
      listeners.add(unsub);
      return getSnapshot();
    },
    useEffect(effect) {
      const cleanup = effect();
      if (typeof cleanup === "function") effectCleanups.push(cleanup);
    },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "react") return reactStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  let liveMod;
  try {
    delete require.cache[liveModPath];
    liveMod = require(liveModPath);
  } finally {
    Module._load = originalLoad;
  }

  const subscriptions = [];
  const fakeClient = {
    subscribe(_def, input, onEvent, options) {
      const record = { input, onEvent, signal: options.signal, aborted: false };
      options.signal.addEventListener("abort", () => { record.aborted = true; });
      subscriptions.push(record);
      return { ready: Promise.resolve(), close() {} };
    },
  };

  liveMod.resetSubagentLiveStoreForTests();
  const unbind = liveMod.bindSubagentLiveClient(fakeClient);
  try {
    const initialA = { kind: "subagent", status: "running", role: "scout-a", title: "任务 A", task: "细节 A" };
    const initialB = { kind: "subagent", status: "running", role: "scout-b", title: "任务 B", task: "细节 B" };

    // Two running cards on the same agent share ONE subscription
    const rA1 = liveMod.useLiveSubagentCard("agent-1", "call-a", initialA);
    const rB1 = liveMod.useLiveSubagentCard("agent-1", "call-b", initialB);
    assert.equal(rA1.status, "running");
    assert.equal(rB1.status, "running");
    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0].aborted, false);

    // Server pushes live completion for call-a (without repeating task) -> task preserved, status flipped
    subscriptions[0].onEvent({
      cards: {
        "call-a": { kind: "subagent", status: "completed", role: "scout-a", title: "任务 A", report: "报告 A", steps: 2, durationMs: 3100, outputTokens: 240 },
      },
    });
    const rA2 = liveMod.useLiveSubagentCard("agent-1", "call-a", initialA);
    assert.equal(rA2.status, "completed");
    assert.equal(rA2.task, "细节 A");
    assert.equal(rA2.report, "报告 A");
    assert.equal(rA2.steps, 2);

    // Unmount both running effects -> subscription aborts cleanly, cache stays warm for scroll remount
    while (effectCleanups.length > 0) effectCleanups.pop()();
    assert.equal(subscriptions[0].aborted, true);

    // Remount call-a with stale initial "running" -> reads settled state from cache with ZERO new subscription!
    const rA3 = liveMod.useLiveSubagentCard("agent-1", "call-a", initialA);
    assert.equal(rA3.status, "completed");
    assert.equal(rA3.report, "报告 A");
    assert.equal(subscriptions.length, 1);

    // Settled initial snapshot is never overwritten by older cache
    const settledInitial = { kind: "subagent", status: "completed", role: "scout-a", title: "任务 A", report: "重放终版", steps: 5 };
    const rA4 = liveMod.useLiveSubagentCard("agent-1", "call-a", settledInitial);
    assert.equal(rA4.report, "重放终版");
    assert.equal(rA4.steps, 5);
  } finally {
    for (const unsub of listeners) unsub();
    unbind();
    liveMod.resetSubagentLiveStoreForTests();
    delete require.cache[liveModPath];
  }
});
