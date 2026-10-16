#!/usr/bin/env node
/**
 * A scripted stand-in for `dsh --profile paseo`, driving the Paseo plugin over
 * the bridge protocol with no real DSH, no model, and no subagent.
 *
 * It speaks the newline-delimited JSON-RPC of `dsh-bridge/lib/transport.js`
 * (see `server.js`). `DSH_FAKE_MODE` selects what it emits:
 *   live     (default) after the first `session/prompt`, replay a scenario:
 *            two nested children (child-B under child-A), child-A's messages,
 *            tools, a failed `turn/end`, a stray event for an unknown session,
 *            two `paseo/question` requests sharing one callId (root + child-A),
 *            and the root's own turn
 *   early    emit a child-opened + child event right after the parent's first
 *            session request, before the plugin emits `session.ready`
 *   nested   after the root is ready, report a grandchild (and great-grandchild)
 *            *before* its parent's child-opened, with its earliest message and
 *            status first, so the plugin must hold and release the subtree
 *   replay   answer `paseo/subagents`/`paseo/history` (child-A has an inherited
 *            fork prefix) so a reopen can rebuild the tree; the listing also
 *            carries a killed child whose log stops inside a turn with no
 *            terminal, and a live child with the same shape that the bridge
 *            announces during the open, so the two can be told apart
 *   error    answer `paseo/subagents` with `available: false` and an error
 *   steer    hold one root turn open while a foreground child runs, so a steer
 *            sent into that turn can be judged against the turn id the daemon
 *            bound at prompt time; the running status is emitted *before* the
 *            prompt reply, exactly as real DSH does, so the plugin knows the
 *            turn id when it answers. A steer ends the turn and the child.
 *   late     reply to the prompt *before* opening the turn — a synthetic,
 *            defensive order, *not* what real DSH does (there the running status
 *            precedes the reply, as in `steer`); it pins that the plugin names
 *            one turn in both the prompt result and `session.turn started`
 *            regardless of that cross-process ordering
 *   failonce refuse the first prompt, then run later ones normally, so a ghost
 *            turn id left behind by the failure would be observable
 *   cancel   hold a root turn open and keep emitting its output on a timer, so a
 *            `session.interrupt` arrives while the turn is unmistakably live.
 *            `session/cancel` then ends that turn the way real DSH does for
 *            `agent.cancel({kind:'user'})` — `turn/end` with
 *            `{kind:'aborted', reason:{kind:'user'}}`, then an idle status, and
 *            no further output for the turn. A later prompt still runs, so the
 *            check can prove the process and the conversation survived
 *   stream   replay a growing `paseo/assistant-delta` stream (the bridge's
 *            transient assistant snapshot) followed by the durable
 *            `assistant/message` for the same turn/step, so the plugin's
 *            folding into one stable item id can be asserted without a model
 *   image    replay two `read_image`-shaped `tool/result`s whose messages carry
 *            `{type:"image", attachment}` content blocks: one block the bridge
 *            stamped with `hostPath`, one it could not resolve. The plugin must
 *            emit exactly one markdown-image `assistant_message` for the first
 *            and none for the second
 *
 * `DSH_FAKE_LOG` (a file path) records every request frame, so a test can assert
 * at the protocol boundary how many times a prompt was actually delivered.
 * `DSH_FAKE_ARGV` (a file path) records this process's launcher arguments and,
 * when `--patch <path>` is present, that file's content — the only way a check
 * can see what the plugin handed DSH at boot.
 *
 * @module paseo-dsh/harness/fake-dsh-bridge
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const MODE = process.env.DSH_FAKE_MODE ?? "live";
const LOG_PATH = process.env.DSH_FAKE_LOG;
const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const notify = (method, params) => out({ jsonrpc: "2.0", method, params });

/**
 * `DSH_FAKE_ARGV` (a file path) records this process's own launcher arguments
 * and, when the plugin passed `--patch <path>`, that file's content. No bridge
 * frame can show what the plugin handed DSH at boot, so a check that asserts
 * MCP injection has to read it from here.
 */
const ARGV_PATH = process.env.DSH_FAKE_ARGV;
if (ARGV_PATH !== undefined && ARGV_PATH !== "") {
  const argv = process.argv.slice(2);
  const patchIndex = argv.indexOf("--patch");
  const patchPath = patchIndex >= 0 ? argv[patchIndex + 1] : undefined;
  let patch;
  if (patchPath !== undefined) {
    try {
      patch = readFileSync(patchPath, "utf8");
    } catch (error) {
      patch = { error: String(error?.message ?? error) };
    }
  }
  writeFileSync(ARGV_PATH, JSON.stringify({ argv, patchPath, patch }, null, 2));
}

/** Append one received request to `DSH_FAKE_LOG`, when the test asked for it. */
function logFrame(method, params) {
  if (LOG_PATH === undefined || LOG_PATH === "") return;
  appendFileSync(LOG_PATH, `${JSON.stringify({ method, params })}\n`);
}

let rootId = null;
let emitted = false;
let liveChildEmitted = false;
let rootTurnOpen = false;
let promptAttempts = 0;
/** The cancel scenario's live output timer, and how many steps it has emitted. */
let cancelTicker = null;
let cancelSteps = 0;
/** Prompts seen in `cancel` mode: the first opens the turn, the rest follow it. */
let cancelPrompts = 0;

const childAEvents = () => [
  { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "child A prompt" }] } },
  { type: "assistant/message", seq: 2, data: { turn: 1, step: 1, message: { id: "am1", content: [{ type: "text", text: "child A answer" }] }, usage: { inputTokens: 11, outputTokens: 22 } } },
  { type: "tool/call", seq: 3, data: { callId: "ca-1", name: "bash", arguments: { command: "echo a" } } },
  { type: "tool/result", seq: 4, data: { toolCallId: "ca-1", message: { content: [{ type: "text", text: "a" }] } } },
  { type: "turn/end", seq: 5, data: { turn: 1, reason: { kind: "error", error: { message: "child A failed" } } } },
];
const childBEvents = () => [
  { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "bm1", content: [{ type: "text", text: "child B answer" }] } } },
  { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } },
];
/**
 * A child killed mid-turn, in the exact shape a real killed subagent leaves
 * behind: the log stops on a `step/start`, the last turn was never closed with
 * `turn/end`, and one `tool/call` never got its `tool/result`.
 *
 * The shape is deliberately identical to a *live* child caught between steps,
 * because that is the point: DSH appends no "the process died" fact, so the log
 * alone cannot tell the two apart — only the live channel can.
 */
const killedChildEvents = () => [
  { type: "subagent/descriptor", seq: 0, data: { label: "Killed K" } },
  { type: "turn/start", seq: 1, data: { turn: 1 } },
  { type: "step/start", seq: 2, data: { turn: 1, step: 1 } },
  { type: "assistant/message", seq: 3, data: { turn: 1, step: 1, message: { id: "kk1", content: [{ type: "text", text: "killed child line" }] } } },
  { type: "tool/call", seq: 4, data: { turn: 1, step: 1, callId: "ck-1", name: "bash", arguments: { command: "sleep 999" } } },
  { type: "step/end", seq: 5, data: { turn: 1, step: 1 } },
  { type: "step/start", seq: 6, data: { turn: 1, step: 2 } },
];
/** The same unterminated shape, for a child the bridge *is* hosting live. */
const liveChildEvents = () => [
  { type: "subagent/descriptor", seq: 0, data: { label: "Live M" } },
  { type: "turn/start", seq: 1, data: { turn: 1 } },
  { type: "step/start", seq: 2, data: { turn: 1, step: 1 } },
  { type: "tool/call", seq: 3, data: { turn: 1, step: 1, callId: "cm-1", name: "bash", arguments: { command: "sleep 999" } } },
  { type: "step/end", seq: 4, data: { turn: 1, step: 1 } },
  { type: "step/start", seq: 5, data: { turn: 1, step: 2 } },
];
const rootEvents = () => [
  { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "hello root" }] } },
  { type: "assistant/message", seq: 2, data: { turn: 1, step: 1, message: { id: "rm1", content: [{ type: "text", text: "root answer" }] }, usage: { inputTokens: 1, outputTokens: 2 } } },
  { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
];

/**
 * The `image` scenario: a `read_image` tool result carrying an image content
 * block, in the shape DSH writes one — a rendered text block plus
 * `{type:"image", attachment:{…}}`.
 *
 * The bridge appends `hostPath` (the attachment's durable absolute path) to a
 * block whose reference it can resolve, and the plugin turns that into an
 * `assistant_message` whose text is a markdown image. Two calls, so both halves
 * can be asserted: `img-1` is stamped, and the space in its path proves the
 * source is encoded segment by segment; `img-2` is not stamped (an attachment
 * store that could not resolve the reference) and must produce no row at all.
 */
const imageRootEvents = () => [
  { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "look at this picture" }] } },
  { type: "tool/call", seq: 2, data: { callId: "img-1", name: "read_image", arguments: { file_path: "/tmp/paseo-01.png" } } },
  {
    type: "tool/result",
    seq: 3,
    data: {
      toolCallId: "img-1",
      meta: { path: "/tmp/paseo-01.png" },
      message: {
        content: [
          { type: "text", text: "<path>/tmp/paseo-01.png</path>\n<type>image</type>\n<content>" },
          {
            type: "image",
            attachment: {
              attachmentId: "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0",
              mediaType: "image/png",
              bytes: 12344,
              width: 1600,
              height: 1000,
              name: "paseo-01.png",
            },
            hostPath: "/tmp/paseo dir/01 image.png",
          },
        ],
      },
    },
  },
  { type: "tool/call", seq: 4, data: { callId: "img-2", name: "read_image", arguments: { file_path: "/tmp/gone.png" } } },
  {
    type: "tool/result",
    seq: 5,
    data: {
      toolCallId: "img-2",
      meta: { path: "/tmp/gone.png" },
      message: {
        content: [
          { type: "text", text: "<path>/tmp/gone.png</path>\n<type>image</type>\n<content>" },
          {
            type: "image",
            attachment: {
              attachmentId: "sha256:ffffffffffffffffffffffffffffffff",
              mediaType: "image/png",
              bytes: 10,
              width: 1,
              height: 1,
              name: "gone.png",
            },
          },
        ],
      },
    },
  },
  { type: "turn/end", seq: 6, data: { turn: 1, reason: { kind: "completed" } } },
];

function question(id, sessionId, callId) {
  out({
    jsonrpc: "2.0",
    id,
    method: "paseo/question",
    params: {
      sessionId,
      callId,
      timed: false,
      questions: [{ id: "q1", question: "Pick one", header: "Pick", options: [{ label: "yes" }, { label: "no" }] }],
    },
  });
}

async function emitScenario() {
  const childA = "child-A";
  notify("session.child-opened", { sessionId: childA, parentSessionId: rootId, mode: "continuable", label: "Research A", cwd: "/tmp" });
  notify("session.event", { sessionId: childA, event: childAEvents()[0] });
  notify("session.status", { sessionId: childA, status: "running" });
  notify("session.event", { sessionId: childA, event: childAEvents()[1] });
  notify("session.event", { sessionId: childA, event: childAEvents()[2] });
  notify("session.event", { sessionId: childA, event: childAEvents()[3] });
  notify("session.event", { sessionId: childA, event: childAEvents()[4] });
  notify("session.status", { sessionId: childA, status: "idle" });
  notify("session.child-opened", { sessionId: "child-B", parentSessionId: childA, mode: "one-shot", label: "Nested B", cwd: "/tmp" });
  notify("session.event", { sessionId: "child-B", event: childBEvents()[0] });
  notify("session.event", { sessionId: "child-B", event: childBEvents()[1] });
  notify("session.event", { sessionId: "ghost-session", event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "gm1", content: [{ type: "text", text: "GHOST-SHOULD-NOT-APPEAR" }] } } } });
  // Two questions share callId Q1: one from the root, one from child-A.
  question("q-root", rootId, "Q1");
  question("q-child", childA, "Q1");
  notify("session.status", { sessionId: rootId, status: "running" });
  notify("session.event", { sessionId: rootId, event: rootEvents()[1] });
  notify("session.event", { sessionId: rootId, event: rootEvents()[2] });
  notify("session.status", { sessionId: rootId, status: "idle" });
}

async function emitNested() {
  // Every notice arrives before the parent it hangs under, deepest first, and
  // each descendant's earliest message/status precedes its own parent notice.
  notify("session.child-opened", { sessionId: "great-H", parentSessionId: "grand-G", mode: "one-shot", label: "Great H", cwd: "/tmp" });
  notify("session.event", { sessionId: "great-H", event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "gh1", content: [{ type: "text", text: "great early answer" }] } } } });
  notify("session.status", { sessionId: "great-H", status: "running" });
  notify("session.event", { sessionId: "great-H", event: { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } } });
  notify("session.child-opened", { sessionId: "grand-G", parentSessionId: "child-P", mode: "continuable", label: "Grand G", cwd: "/tmp" });
  notify("session.event", { sessionId: "grand-G", event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "gg1", content: [{ type: "text", text: "grand early answer" }] } } } });
  notify("session.status", { sessionId: "grand-G", status: "running" });
  notify("session.event", { sessionId: "grand-G", event: { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } } });
  // The unresolved-parent grandchild output must not leak into the root view.
  notify("session.event", { sessionId: "ghost-session", event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "gm1", content: [{ type: "text", text: "GHOST-SHOULD-NOT-APPEAR" }] } } } });
  notify("session.child-opened", { sessionId: "child-P", parentSessionId: rootId, mode: "continuable", label: "Parent P", cwd: "/tmp" });
  notify("session.event", { sessionId: "child-P", event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "pp1", content: [{ type: "text", text: "parent answer" }] } } } });
  notify("session.event", { sessionId: "child-P", event: { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } } });
}

/**
 * Report a child with no label, then let the child's own durable descriptor
 * supply one.
 *
 * Paseo titles a child only from the single `session.opened` it accepts, and a
 * child has no configuration channel, so a notice that arrives without a label
 * used to open a row stuck on "加载中…" forever. The descriptor is where the
 * durable label lives; the plugin has to hold the notice for it.
 */
async function emitLateLabel() {
  notify("session.child-opened", { sessionId: "child-L", parentSessionId: rootId, mode: "one-shot", cwd: "/tmp" });
  notify("session.event", { sessionId: "child-L", event: { type: "subagent/descriptor", seq: 1, data: { label: "Late L" } } });
  notify("session.event", { sessionId: "child-L", event: { type: "assistant/message", seq: 2, data: { turn: 1, step: 1, message: { id: "cl1", content: [{ type: "text", text: "late-label child answer" }] } } } });
  notify("session.event", { sessionId: "child-L", event: { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } } });
  notify("session.status", { sessionId: "child-L", status: "idle" });
}

/**
 * Report a child with no label and then never send its descriptor.
 *
 * The plugin holds a label-less notice so the child can open with its real
 * title, but a provider that never supplies one must not leave the child
 * unopened: its output would buffer and then be dropped in silence. This is the
 * shape that used to be dead code — the wait was only ever evaluated before any
 * of the child's frames existed.
 */
async function emitLabelNever() {
  notify("session.child-opened", { sessionId: "child-N", parentSessionId: rootId, mode: "one-shot", cwd: "/tmp" });
  for (let i = 1; i <= 45; i += 1) {
    notify("session.event", { sessionId: "child-N", event: { type: "assistant/message", seq: i, data: { turn: 1, step: 1, message: { id: `cn${i}`, content: [{ type: "text", text: `never-labelled line ${i}` }] } } } });
  }
  notify("session.event", { sessionId: "child-N", event: { type: "turn/end", seq: 46, data: { turn: 1, reason: { kind: "completed" } } } });
  notify("session.status", { sessionId: "child-N", status: "idle" });
}

async function emitEarly() {
  notify("session.child-opened", { sessionId: "child-E", parentSessionId: rootId, mode: "continuable", label: "Early E", cwd: "/tmp" });
  notify("session.event", { sessionId: "child-E", event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "em1", content: [{ type: "text", text: "early child answer" }] } } } });
}

/**
 * Open the foreground child the running root turn is waiting on. The root turn
 * stays open — no `turn/end`, no idle status — so a steer arriving now is the
 * only way it can finish.
 */
async function openSteerChild() {
  notify("session.child-opened", { sessionId: "child-S", parentSessionId: rootId, mode: "continuable", label: "Foreground S", cwd: "/tmp" });
  notify("session.status", { sessionId: "child-S", status: "running" });
  notify("session.event", { sessionId: "child-S", event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "cs1", content: [{ type: "text", text: "child S working" }] } } } });
}

/** End the steered root turn; the child it was waiting on finishes first. */
async function finishSteerTurn() {
  notify("session.event", { sessionId: "child-S", event: { type: "assistant/message", seq: 2, data: { turn: 1, step: 2, message: { id: "cs2", content: [{ type: "text", text: "child S answer" }] } } } });
  notify("session.event", { sessionId: "child-S", event: { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } } });
  notify("session.status", { sessionId: "child-S", status: "idle" });
  notify("session.event", { sessionId: rootId, event: { type: "assistant/message", seq: 2, data: { turn: 1, step: 2, message: { id: "rs2", content: [{ type: "text", text: "steered root answer" }] }, usage: { inputTokens: 3, outputTokens: 4 } } } });
  notify("session.event", { sessionId: rootId, event: { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } } });
  notify("session.status", { sessionId: rootId, status: "idle" });
}

/** Emit one root assistant answer and close the root turn. */
async function endRootTurn(text, reason = "completed") {
  notify("session.event", { sessionId: rootId, event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "lm1", content: [{ type: "text", text }] } } } });
  notify("session.event", { sessionId: rootId, event: { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: reason } } } });
  notify("session.status", { sessionId: rootId, status: "idle" });
}

/**
 * Open a root turn that stays open and keeps producing output.
 *
 * The point is that a cancel arrives while the turn is *demonstrably* running:
 * real DSH emits the running status synchronously inside `followup()`, before
 * the prompt reply, and the model then streams step after step. A turn that
 * merely "exists" would let a no-op cancel pass the check.
 */
async function openCancelTurn() {
  rootTurnOpen = true;
  notify("session.status", { sessionId: rootId, status: "running" });
  cancelTicker = setInterval(() => {
    if (!rootTurnOpen) return;
    cancelSteps += 1;
    notify("session.event", {
      sessionId: rootId,
      event: {
        type: "assistant/message",
        seq: cancelSteps,
        data: { turn: 1, step: cancelSteps, message: { id: `cm${cancelSteps}`, content: [{ type: "text", text: `counting ${cancelSteps}` }] } },
      },
    });
  }, 40);
}

/**
 * End the open turn the way real DSH ends a cancelled one.
 *
 * `agent.cancel({kind:'user'})` closes the turn with
 * `turn/end {kind:'aborted', reason:{kind:'user'}}` and the agent then reports
 * `idle`; both halves matter, because the plugin's terminal `session.turn` is
 * emitted on the idle status and its state is read from the reason. Nothing more
 * is written for the turn afterwards — that silence is what "the cancel stopped
 * it" means on the wire.
 */
function cancelTurn() {
  if (!rootTurnOpen) return false;
  rootTurnOpen = false;
  if (cancelTicker !== null) {
    clearInterval(cancelTicker);
    cancelTicker = null;
  }
  notify("session.event", { sessionId: rootId, event: { type: "turn/end", seq: cancelSteps + 1, data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } } });
  notify("session.status", { sessionId: rootId, status: "idle" });
  return true;
}

/** The turn after a cancel: the session is still alive and still usable. */
async function runAfterCancelTurn() {
  notify("session.status", { sessionId: rootId, status: "running" });
  notify("session.event", { sessionId: rootId, event: { type: "assistant/message", seq: 1, data: { turn: 2, step: 1, message: { id: "ac1", content: [{ type: "text", text: "still alive after cancel" }] } } } });
  notify("session.event", { sessionId: rootId, event: { type: "turn/end", seq: 2, data: { turn: 2, reason: { kind: "completed" } } } });
  notify("session.status", { sessionId: rootId, status: "idle" });
}

/**
 * Emit a scripted live assistant stream, then its durable settlement.
 *
 * `paseo/assistant-delta` is the bridge's own transient frame: what it forwards
 * after folding DSH's per-chunk `agent/assistant-stream` frames. Each snapshot
 * carries the full step text so far, exactly as the real bridge sends it. The
 * durable `assistant/message` that follows must land on the same item id and
 * add only the tail, never a second copy.
 */
async function emitStream() {
  notify("session.status", { sessionId: rootId, status: "running" });
  // Reasoning grows first, then text — the order DSH's adapters stream blocks
  // in. Each snapshot carries only the half that changed, exactly as the real
  // bridge now sends it, so each half's rows stay adjacent and Paseo can merge
  // them into one row per type.
  const frames = [
    { reasoning: "thin" },
    { reasoning: "think" },
    { reasoning: "thinking" },
    { text: "Hel" },
    { text: "Hello" },
    { text: "Hello world" },
  ];
  for (const data of frames) {
    notify("session.event", {
      sessionId: rootId,
      event: { type: "paseo/assistant-delta", data: { turn: 1, step: 1, ...data } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // The durable settlement repeats the whole step; its deltas are empty and
  // Paseo drops it, so it must not add a second row.
  notify("session.event", { sessionId: rootId, event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "sm1", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Hello world" }] } } } });
  notify("session.event", { sessionId: rootId, event: { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } } });
  notify("session.status", { sessionId: rootId, status: "idle" });
}

/**
 * Emit the `image` scenario as one root turn: a running status, the two
 * `read_image` calls and their results, then the terminal status.
 */
async function emitImage() {
  notify("session.status", { sessionId: rootId, status: "running" });
  for (const event of imageRootEvents()) {
    notify("session.event", { sessionId: rootId, event });
  }
  notify("session.status", { sessionId: rootId, status: "idle" });
}

function reply(id, result) {
  out({ jsonrpc: "2.0", id, result });
}

async function handle(method, params, id) {
  if (params && typeof params.sessionId === "string" && params.sessionId !== "" && rootId === null) {
    rootId = params.sessionId;
  }
  switch (method) {
    case "initialize":
      return { serverInfo: { name: "fake-dsh-bridge", version: "0" }, route: { provider: "fake", model: "fake" } };
    case "paseo/catalog":
      return { providers: [], models: [], planMode: false };
    case "paseo/commands": {
      // A child this bridge is *hosting* right now is announced during the open
      // (the notice precedes the reply, so it is buffered and registered before
      // the replay runs). Its stored log has the same unterminated shape as the
      // killed child below, and it must stay running: only a turn no live
      // channel vouches for may be closed by the replay.
      if (MODE === "replay" && !liveChildEmitted && rootId !== null) {
        liveChildEmitted = true;
        notify("session.child-opened", { sessionId: "child-M", parentSessionId: rootId, mode: "continuable", label: "Live M", cwd: "/tmp" });
      }
      if (MODE === "early" && !emitted) {
        emitted = true;
        setTimeout(() => { void emitEarly(); }, 0);
      }
      if (MODE === "label-late" && !emitted) {
        emitted = true;
        setTimeout(() => { void emitLateLabel(); }, 0);
      }
      if (MODE === "label-never" && !emitted) {
        emitted = true;
        setTimeout(() => { void emitLabelNever(); }, 0);
      }
      // The steer scenario advertises one registered command so the command
      // branch (a `completed` result, never a turn) stays covered.
      if (MODE === "steer") return { commands: [{ name: "goal", description: "read the goal state", kind: "command" }] };
      return { commands: [] };
    }
    case "paseo/command/run":
      return { kind: "success", text: "goal: none" };
    case "paseo/permission":
      return { available: false, current: null, presets: [] };
    case "paseo/presets":
      return { available: false, presets: [], current: null, default: null };
    case "paseo/usage":
      return { available: false };
    // DSH's native archive set. The plugin routes an archive request through an
    // open session when it has one and through a throwaway probe when it does
    // not; both paths must reach this method and both must fail loud on an id
    // the registry refuses. An id prefixed `unknown-` is the refusal.
    case "paseo/archive":
    case "paseo/unarchive": {
      const archiveSessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
      const verb = method === "paseo/archive" ? "archive" : "unarchive";
      if (archiveSessionId === "" || archiveSessionId.startsWith("unknown-")) {
        return {
          available: false,
          error: { message: `cannot ${verb} session '${archiveSessionId}': live sessions and session persistence hold no such session` },
        };
      }
      return { available: true };
    }
    case "paseo/subagents":
      if (MODE === "error") return { available: false, subagents: [], error: { message: "subagent catalog exploded" } };
      if (MODE !== "replay") return { available: true, subagents: [] };
      return {
        available: true,
        subagents: [
          { sessionId: "child-A", parentSessionId: String(params?.sessionId ?? ""), mode: "continuable", label: "Research A" },
          // A one-shot child has no label in the catalog (DSH only requires one
          // for a continuable child); its label lives in its own descriptor.
          { sessionId: "child-B", parentSessionId: "child-A", mode: "one-shot" },
          // Archived in DSH's own registry: it must not be announced again, or
          // "archive all" would be undone by the next replay.
          { sessionId: "child-Z", parentSessionId: "child-A", mode: "one-shot", archived: true },
          // Hosted live right now (announced during the open) *and* listed in
          // the durable catalog with an unterminated log: the live channel is
          // the evidence that its open turn is real.
          { sessionId: "child-M", parentSessionId: String(params?.sessionId ?? ""), mode: "continuable", label: "Live M" },
          // Killed mid-turn: in the durable catalog only, its log stops with no
          // terminal. Nothing live vouches for it, so it must not be announced
          // as running.
          { sessionId: "child-K", parentSessionId: String(params?.sessionId ?? ""), mode: "continuable", label: "Killed K" },
        ],
      };
    case "paseo/history": {
      const sid = String(params?.sessionId ?? "");
      if (sid.startsWith("killed-root-")) {
        // A root whose process was killed with a tool in flight: the log stops
        // after `tool/call`, with no `tool/result` and no `turn/end`. Those rows
        // come from the replay's own builder, so nothing else can ever close
        // them — they would pulse for the rest of the session, and again on every
        // reopen.
        return {
          available: true,
          inheritedEventCount: 0,
          events: [
            { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "run something long" }] } },
            { type: "turn/start", seq: 2, data: { turn: 1 } },
            { type: "step/start", seq: 3, data: { turn: 1, step: 1 } },
            { type: "tool/call", seq: 4, data: { turn: 1, step: 1, callId: "killed-1", name: "bash", arguments: { command: "sleep 999" } } },
          ],
        };
      }
      if (sid === "child-A") {
        // Fork-inherited prefix (seq < 2) plus the child's own suffix.
        return {
          available: true,
          inheritedEventCount: 2,
          events: [
            { type: "user/message", seq: 0, data: { source: { kind: "user" }, content: [{ type: "text", text: "INHERITED-PARENT-TEXT" }] } },
            { type: "assistant/message", seq: 1, data: { turn: 0, step: 0, message: { id: "inh", content: [{ type: "text", text: "INHERITED-PARENT-REPLY" }] } } },
            ...childAEvents(),
          ],
        };
      }
      if (sid === "child-B") {
        return {
          available: true,
          inheritedEventCount: 0,
          events: [
            { type: "subagent/descriptor", seq: 0, data: { label: "Nested B" } },
            ...childBEvents(),
          ],
        };
      }
      // Both end inside an open turn; only child-M has live evidence.
      if (sid === "child-M") return { available: true, inheritedEventCount: 0, events: liveChildEvents() };
      if (sid === "child-K") return { available: true, inheritedEventCount: 0, events: killedChildEvents() };
      // The image scenario replays the same log, so a reopen proves the picture
      // row is rebuilt from history and not only from the live turn.
      if (MODE === "image") return { available: true, inheritedEventCount: 0, events: imageRootEvents() };
      return { available: true, inheritedEventCount: 0, events: rootEvents() };
    }
    case "session/prompt":
      if (MODE === "live" && !emitted) {
        emitted = true;
        setTimeout(() => { void emitScenario(); }, 30);
      }
      if (MODE === "nested" && !emitted) {
        emitted = true;
        setTimeout(() => { void emitNested(); }, 30);
      }
      if (MODE === "stream" && !emitted) {
        emitted = true;
        setTimeout(() => { void emitStream(); }, 20);
      }
      if (MODE === "failturn" && !emitted) {
        emitted = true;
        // DSH can end a turn for reasons that are not a clean finish. The root's
        // terminal `session.turn` is emitted later, from the remembered reason,
        // so this is the only place that can say the turn failed.
        setTimeout(() => { void endRootTurn("partial answer", "error"); }, 20);
      }
      if (MODE === "image" && !emitted) {
        emitted = true;
        setTimeout(() => { void emitImage(); }, 30);
      }
      if (MODE === "steer") {
        if (params?.delivery === "steer") {
          // A steer belongs inside the turn already running: it ends that turn
          // rather than opening another one.
          if (rootTurnOpen) {
            rootTurnOpen = false;
            setTimeout(() => { void finishSteerTurn(); }, 20);
          }
        } else if (!emitted) {
          emitted = true;
          rootTurnOpen = true;
          // Real DSH opens the turn synchronously inside `followup()`, so this
          // status is written before the reply below: the plugin has the turn id
          // in hand when it answers, which is what the daemon later steers by.
          notify("session.status", { sessionId: rootId, status: "running" });
          setTimeout(() => { void openSteerChild(); }, 20);
        }
      }
      if (MODE === "late" && params?.delivery !== "steer" && !emitted) {
        emitted = true;
        // Synthetic order, *not* what DSH does: real DSH enters the running phase
        // synchronously inside `followup()` and the bridge writes the status
        // notification before the prompt reply (that is the `steer` mode's
        // order). This mode replies first on purpose, to pin the invariant
        // defensively — the plugin must name the same turn in the prompt result
        // and in the later `session.turn started` even if the status were late.
        setTimeout(() => { notify("session.status", { sessionId: rootId, status: "running" }); }, 20);
        setTimeout(() => { void endRootTurn("late answer"); }, 40);
      }
      if (MODE === "failonce") {
        promptAttempts += 1;
        // The first prompt is refused outright, so the plugin must drop the turn
        // id it issued for it instead of leaving a ghost behind.
        if (promptAttempts === 1) throw new Error("the runtime refused the prompt");
        if (params?.delivery !== "steer" && !emitted) {
          emitted = true;
          setTimeout(() => { notify("session.status", { sessionId: rootId, status: "running" }); }, 20);
          setTimeout(() => { void endRootTurn("recovered answer"); }, 40);
        }
      }
      if (MODE === "cancel" && params?.delivery !== "steer") {
        cancelPrompts += 1;
        if (cancelPrompts === 1) setTimeout(() => { void openCancelTurn(); }, 20);
        else setTimeout(() => { void runAfterCancelTurn(); }, 20);
      }
      return { messageId: "m-1" };
    case "session/cancel": {
      // The one thing this scenario exists to observe: the plugin really asked
      // the runtime to stop the turn it thinks is running.
      if (MODE === "cancel") cancelTurn();
      return { canceled: true };
    }
    case "paseo/plan/get":
      return { available: false, active: false, pending: false };
    case "paseo/plan/set":
      return { available: false, active: false, pending: false, outcome: "queued" };
    case "paseo/config/set":
      return { provider: "fake", model: "fake", reasoningEffort: null, preset: null };
    case "shutdown":
      if (cancelTicker !== null) clearInterval(cancelTicker);
      setTimeout(() => process.exit(0), 10);
      return {};
    default:
      throw new Error(`fake bridge: unknown method ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (frame.id === undefined) return; // plugin -> bridge notifications: none today
  if (typeof frame.method !== "string") return; // response to a bridge -> plugin request
  logFrame(frame.method, frame.params);
  void handle(frame.method, frame.params, frame.id).then(
    (result) => reply(frame.id, result),
    (error) => out({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: String(error?.message ?? error) } }),
  );
});
