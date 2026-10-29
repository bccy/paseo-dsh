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
 *   retry    as `stream`, then a second attempt of the SAME turn/step that
 *            starts over from an empty snapshot and settles durably. DSH does
 *            this when a request fails after text has already streamed, and it
 *            is the case that used to glue both attempts' text into one row.
 *            Each attempt carries its own `attempt` value, exactly as the real
 *            bridge forwards DSH's `attemptId`; the durable copy carries none
 *            (it is a DSH event, not a stream frame)
 *   image    replay two `read_image`-shaped `tool/result`s whose messages carry
 *            `{type:"image", attachment}` content blocks: one block the bridge
 *            stamped with `hostPath`, one it could not resolve. The plugin must
 *            emit exactly one markdown-image `assistant_message` for the first
 *            and none for the second
 *   crash    exit(1) the instant a `session/prompt` arrives, without replying and
 *            without reading the rest of the frame in flight. Drives the
 *            asynchronous EPIPE on the plugin's `stdin.write` — the uncaught
 *            error that used to kill the whole daemon. `harness/process-crash-check.mjs`
 *   orphan   answer a prompt with a frame for the prompted session and one for a
 *            child of it, so a session detached in that window leaves held
 *            orphan frames behind. Drives `detachSession`'s cleanup (L1-6)
 *   mcp-late refuse `paseo/mcp/set` the way the real bridge does when the
 *            session's agent already exists (it throws; it does not answer
 *            `mounted: false`). Drives the plugin's loud-failure path (L6-6)
 *
 * `DSH_FAKE_LOG` (a file path) records every request frame, so a test can assert
 * at the protocol boundary how many times a prompt was actually delivered.
 * `DSH_FAKE_ARGV` (a file path) records this process's launcher arguments and,
 * when `--patch <path>` is present, that file's content — the only way a check
 * can see what the plugin handed DSH at boot.
 *
 * Outside the scenarios it also answers the two bridge requests the plugin makes
 * without a turn, whose shapes mirror `dsh-bridge/lib/server.js`:
 * `paseo/sessions` — the import list (`{available, sessions:[{sessionId, cwd?,
 * title?, preview?, updatedAt?}]}`), which the provider turns into persistence
 * handles for Paseo's "Import session"; `paseo/revert` — the rewind receipt
 * (`{kind:"success", text}`), where a `token.messageId` of `revert-unknown`
 * fails the way the real bridge fails an unresolvable target (a JSON-RPC error
 * the plugin surfaces as `request.failed`).
 *
 * ## The per-session `initialize` gate
 *
 * `session/prompt` refuses a session this process never saw an `initialize` for,
 * with the real bridge's wording (`server.js` `prompt()`), **by default**.
 * Without it the stand-in was more permissive than the thing it stands in for: a
 * plugin that forgot to send `initialize` with the session's own id — the bug
 * `f084c33` fixed, where every session opened and then failed its first prompt —
 * left `multi-session-check` and `concurrent-open-check` green, because the fake
 * never checked. Strict is the honest default; a script that is deliberately
 * testing the protocol layer *below* `initialize` (only
 * `fake-bridge-multi-check.mjs` today) opts out with
 * `DSH_FAKE_ALLOW_UNINITIALIZED=1`, and says so at its own call site.
 *
 * @module paseo-dsh/harness/fake-dsh-bridge
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * The scenario this process should replay, read fresh on every access.
 *
 * It used to be a module-level constant captured at start. That was correct
 * while the plugin spawned one `dsh` child per session: every `session.open`
 * started a new process, which read whatever `DSH_FAKE_MODE` the test had set
 * by then. The plugin now keeps ONE shared child for the whole connection, so
 * the child starts during the first scenario and would then replay that
 * scenario's script forever — every later `DSH_FAKE_MODE` change in the test
 * process is invisible to it, because a spawned child's environment is frozen
 * at spawn time.
 *
 * `DSH_FAKE_MODE_FILE` is the escape hatch: when the test set it, the mode is
 * re-read from that file on each access, so the parent can steer a long-lived
 * child between scenarios. Without the file the environment is still honoured,
 * which keeps every single-scenario check working unchanged.
 */
function currentMode() {
  const file = process.env.DSH_FAKE_MODE_FILE;
  if (file !== undefined && file !== "") {
    try {
      const value = readFileSync(file, "utf8").trim();
      if (value !== "") return value;
    } catch {
      /* fall through to the environment */
    }
  }
  return process.env.DSH_FAKE_MODE ?? "live";
}
/** Resolved per use — see {@link currentMode}. */
const mode = () => currentMode();
const LOG_PATH = process.env.DSH_FAKE_LOG;
const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const notify = (method, params) => out({ jsonrpc: "2.0", method, params });

/**
 * Sessions this process has been initialized for, mirroring the real bridge's
 * `initializedSessions` (`dsh-bridge/lib/server.js:381`).
 *
 * Process-wide set, session ids as keys — exactly the real shape, and exactly
 * why it matters: `initialize` without a session id pins the process defaults
 * and admits nobody, so a plugin that sends only that form gets its first prompt
 * refused here just as it would in production.
 */
const initializedSessions = new Set();

/**
 * Whether `session/prompt` still requires a per-session `initialize`.
 *
 * Strict by default (see the module comment). The opt-out exists for one class of
 * caller: a script that drives this stand-in at the raw protocol layer and
 * deliberately sends no `initialize` at all, because the property under test
 * lives below it. It is read per call, like the mode, so a long-lived child can
 * be steered.
 */
function requiresInitialize() {
  const allow = process.env.DSH_FAKE_ALLOW_UNINITIALIZED;
  return !(allow === "1" || allow === "true");
}

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

/**
 * Append one received request to `DSH_FAKE_LOG`, when the test asked for it.
 *
 * The pid is part of the record so a test can tell *which* process served a
 * request: a change routed to an already-running (parked) child must not be
 * confused with one a throwaway runtime carried.
 */
function logFrame(method, params) {
  if (LOG_PATH === undefined || LOG_PATH === "") return;
  appendFileSync(LOG_PATH, `${JSON.stringify({ pid: process.pid, method, params })}\n`);
}

/**
 * Every root session this process has been asked to drive, in first-seen order.
 *
 * One process may now carry several Paseo sessions (the plugin used to spawn a
 * `dsh` child per session; the one-process-multi-session work removes that). A
 * scripted stand-in must therefore stop treating the first session id it sees as
 * *the* root: `rootIds` records them all, and every scenario emits against the
 * session that triggered it rather than against a module-level singleton.
 *
 * `rootId` stays as "the session the scenario currently in flight is driving".
 * `handle()` sets it from the request's own `sessionId` before dispatching, so
 * the scenario bodies keep reading a plain variable instead of threading a
 * parameter through every `notify` call. It is no longer sticky across sessions:
 * a request for session B never inherits session A's id.
 */
const rootIds = [];
let rootId = null;
/**
 * Per-session scenario bookkeeping.
 *
 * These used to be module-level flags. That was correct while a process served
 * exactly one session, and silently wrong the moment two share one process: the
 * second session's first prompt would find `emitted` already true and emit
 * nothing at all, so a multi-session check would "pass" by observing silence.
 * Keying them by session id keeps each session's scenario independent.
 */
const scenarioState = new Map();
/** The state bag for `sessionId`, created on first use. */
function stateOf(sessionId) {
  let state = scenarioState.get(sessionId);
  if (state === undefined) {
    state = { emitted: false, liveChildEmitted: false, rootTurnOpen: false, promptAttempts: 0, cancelPrompts: 0, cancelSteps: 0 };
    scenarioState.set(sessionId, state);
  }
  return state;
}
/** The cancel scenario's live output timer (one process-wide ticker is enough). */
let cancelTicker = null;

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
/** A child created but never started: no turn kind of evidence at all. */
const neverStartedChildEvents = () => [
  { type: "subagent/descriptor", seq: 0, data: { label: "No turn" } },
];
/** An open turn; its terminal is emitted *while* the history read is in flight. */
const racingChildEvents = () => [
  { type: "subagent/descriptor", seq: 0, data: { label: "Racing R" } },
  { type: "turn/start", seq: 1, data: { turn: 1 } },
  { type: "step/start", seq: 2, data: { turn: 1, step: 1 } },
];
const rootEvents = () => [
  { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "hello root" }] } },
  { type: "assistant/message", seq: 2, data: { turn: 1, step: 1, message: { id: "rm1", content: [{ type: "text", text: "root answer" }] }, usage: { inputTokens: 1, outputTokens: 2 } } },
  { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
];

/**
 * Stored event times for replayed logs.
 *
 * The plugin must carry each stored event's `time` into its `timeline.item`
 * events as `timestamp`: Paseo stamps items with their arrival time when the
 * provider omits it, so without this every replayed row is stamped at reopen
 * time and each previous turn's "worked for" duration collapses to zero. The
 * fixed base + 1s spacing makes the expectation exact.
 */
const HISTORY_BASE_TIME = Date.UTC(2026, 0, 2, 3, 4, 5);
const withHistoryTimes = (events) => events.map((event, index) => (
  typeof event.time === "number" ? event : { ...event, time: HISTORY_BASE_TIME + index * 1000 }
));

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

/**
 * The `multi` scenario: drive every session this process serves, one turn each,
 * interleaved.
 *
 * This is the only mode that exercises the property the one-process-multi-session
 * change exists to create — one `dsh` child carrying several Paseo sessions at
 * once. Every other mode drives a single root, so a regression that let one
 * session's events leak into another would pass them all.
 *
 * Each session gets a distinguishable answer (`answer for <sessionId>`) and its
 * own turn, emitted in a deliberately interleaved order: all the running
 * statuses first, then each session's message, then each turn end. A plugin that
 * routed by anything other than `sessionId` would cross the answers.
 */
async function emitMultiTurn(sessionId) {
  const state = stateOf(sessionId);
  state.multiTurn = (state.multiTurn ?? 0) + 1;
  const turn = state.multiTurn;
  notify("session.status", { sessionId, status: "running" });
  notify("session.event", {
    sessionId,
    event: {
      type: "assistant/message",
      seq: 1,
      data: { turn, step: 1, message: { id: `mm-${sessionId}-${turn}`, content: [{ type: "text", text: `answer for ${sessionId}` }] } },
    },
  });
  notify("session.event", {
    sessionId,
    event: { type: "turn/end", seq: 2, data: { turn, reason: { kind: "completed" } } },
  });
  notify("session.status", { sessionId, status: "idle" });
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
  const state = stateOf(rootId);
  state.rootTurnOpen = true;
  notify("session.status", { sessionId: rootId, status: "running" });
  cancelTicker = setInterval(() => {
    if (!state.rootTurnOpen) return;
    state.cancelSteps += 1;
    notify("session.event", {
      sessionId: rootId,
      event: {
        type: "assistant/message",
        seq: state.cancelSteps,
        data: { turn: 1, step: state.cancelSteps, message: { id: `cm${state.cancelSteps}`, content: [{ type: "text", text: `counting ${state.cancelSteps}` }] } },
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
  const state = stateOf(rootId);
  if (!state.rootTurnOpen) return false;
  state.rootTurnOpen = false;
  if (cancelTicker !== null) {
    clearInterval(cancelTicker);
    cancelTicker = null;
  }
  notify("session.event", { sessionId: rootId, event: { type: "turn/end", seq: state.cancelSteps + 1, data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } } });
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
  // The real bridge measures this window from DSH's own chunk timestamps and
  // forwards it on every snapshot, which is what the stats row's first-token
  // latency and throughput are computed from. Without it here, a plugin that
  // silently dropped the timings would still look green.
  const startedAt = Date.now();
  let firstTextAt;
  let lastTextAt;
  for (const data of frames) {
    if (data.text !== undefined) {
      const at = Date.now();
      if (firstTextAt === undefined) firstTextAt = at;
      lastTextAt = at;
    }
    notify("session.event", {
      sessionId: rootId,
      event: {
        type: "paseo/assistant-delta",
        data: {
          turn: 1,
          step: 1,
          ...data,
          ...(firstTextAt === undefined ? {} : { startedAt, firstTextAt }),
          ...(lastTextAt === undefined ? {} : { lastTextAt }),
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // The durable settlement repeats the whole step; its deltas are empty and
  // Paseo drops it, so it must not add a second row.
  // DSH reports token accounting on the assistant message and nowhere else, so
  // the stats row's token figures come from here. The durable copy carries it.
  notify("session.event", { sessionId: rootId, event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "sm1", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Hello world" }] }, usage: { inputTokens: 1200, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 100 } } } });
  notify("session.event", { sessionId: rootId, event: { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } } });
  notify("session.status", { sessionId: rootId, status: "idle" });
}

/**
 * Emit the `retry` scenario: one turn/step attempted twice.
 *
 * DSH retries a request inside the same turn/step when the provider fails after
 * text has already streamed (`agent-loop` settles `assistant/attempt`, then
 * loops). Each attempt opens its own frame series and its own snapshot
 * accumulator, so attempt 2's first snapshot is a *restart* (`"The repo"`) and
 * not a prefix of attempt 1's last one (`"我先看一下仓库结构"`).
 *
 * The two attempts carry distinct `attempt` values, which is what the real
 * bridge forwards from DSH's `attemptId`. The durable `assistant/message` is a
 * DSH event and carries none — it settles the attempt that just ended, and the
 * plugin is the side that knows which id that is.
 *
 * What must come out: the attempt-1 row keeps attempt 1's text (append-only, it
 * cannot be withdrawn), the durable answer lands on the attempt-2 row, and
 * Paseo's fold shows the final answer exactly once.
 */
async function emitRetry() {
  notify("session.status", { sessionId: rootId, status: "running" });
  const attempt1 = [
    { text: "我先看一下" },
    { text: "我先看一下仓库结构" },
  ];
  for (const data of attempt1) {
    notify("session.event", {
      sessionId: rootId,
      event: { type: "paseo/assistant-delta", data: { turn: 1, step: 1, attempt: "fake-attempt-1", ...data } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Attempt 2 restarts from empty — the frame series a real retry produces.
  const attempt2 = [
    { text: "The repo has" },
    { text: "The repo has three packages" },
    { text: "The repo has three packages and a bridge" },
  ];
  for (const data of attempt2) {
    notify("session.event", {
      sessionId: rootId,
      event: { type: "paseo/assistant-delta", data: { turn: 1, step: 1, attempt: "fake-attempt-2", ...data } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // The durable settlement of the step: attempt 2's full text, no attempt field.
  notify("session.event", { sessionId: rootId, event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "sr1", content: [{ type: "text", text: "The repo has three packages and a bridge" }] } } } });
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
  // Bind the scenario to the session this request names, instead of latching
  // onto the first one forever. `initialize` carries no session id (it pins the
  // process defaults), so it leaves the binding untouched — which is exactly how
  // a shared process serves several sessions: one initialize, many session ids.
  const requested = params && typeof params.sessionId === "string" && params.sessionId !== "" ? params.sessionId : null;
  if (requested !== null) {
    if (!rootIds.includes(requested)) rootIds.push(requested);
    rootId = requested;
  }
  switch (method) {
    case "initialize":
      // `failopen` refuses the first thing the plugin asks for, so `session.open`
      // throws. The daemon then drops its own session without ever sending
      // `session.close` (`PluginProvider.openSession`'s catch), which is the path
      // that used to leave the plugin's map entry — and this process — behind.
      if (mode() === "failopen") throw new Error("the runtime refused to initialize");
      // The real bridge writes three tables when the frame names a session
      // (`server.js:918-924`) and only the process defaults when it does not.
      // Recording the id here is what makes `prompt`'s gate real; the *absence*
      // of one is the plugin bug this stand-in exists to catch.
      if (requested !== null) initializedSessions.add(requested);
      return { serverInfo: { name: "fake-dsh-bridge", version: "0" }, route: { provider: "fake", model: "fake", reasoningEffort: null } };
    case "paseo/catalog":
      // The real catalog also reports the profile's configured default route
      // (`server.js` `catalog()`), which the plugin reads for the composer's
      // initial selection; omitting them here would make a fake-driven check
      // blind to a regression in that mapping.
      return {
        providers: [],
        models: [],
        defaultProvider: "fake",
        defaultModel: "fake",
        defaultReasoningEffort: null,
        planMode: false,
      };
    case "paseo/commands": {
      // A child this bridge is *hosting* right now is announced during the open
      // (the notice precedes the reply, so it is buffered and registered before
      // the replay runs). Its stored log has the same unterminated shape as the
      // killed child below, and it must stay running: only a turn no live
      // channel vouches for may be closed by the replay.
      const state = stateOf(rootId);
      if (mode() === "replay" && !state.liveChildEmitted && rootId !== null) {
        state.liveChildEmitted = true;
        notify("session.child-opened", { sessionId: "child-M", parentSessionId: rootId, mode: "continuable", label: "Live M", cwd: "/tmp" });
      }
      if (mode() === "early" && !state.emitted) {
        state.emitted = true;
        setTimeout(() => { void emitEarly(); }, 0);
      }
      if (mode() === "label-late" && !state.emitted) {
        state.emitted = true;
        setTimeout(() => { void emitLateLabel(); }, 0);
      }
      if (mode() === "label-never" && !state.emitted) {
        state.emitted = true;
        setTimeout(() => { void emitLabelNever(); }, 0);
      }
      // The steer scenario advertises one registered command so the command
      // branch (a `completed` result, never a turn) stays covered.
      if (mode() === "steer") return { commands: [{ name: "goal", description: "read the goal state", kind: "command" }] };
      return { commands: [] };
    }
    case "paseo/command/run":
      return { kind: "success", text: "goal: none" };
    case "paseo/permission":
      return {
        available: true,
        current: "workspace-write",
        presets: [
          { value: "workspace-write", name: "Workspace write" },
          { value: "danger-full-access", name: "Full access" },
        ],
      };
    case "paseo/permission/set":
      return { current: typeof params?.preset === "string" ? params.preset : null };
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
    // The import list behind Paseo's "Import session". The real bridge filters
    // archived sessions and sorts by `createdAt`; the shape is
    // `{available, sessions:[{sessionId, cwd?, title?, preview?, updatedAt?}]}`
    // (`server.js` `listSessions()`), and the provider turns each row into a
    // persistence handle. Two rows: one fully described, one bare.
    case "paseo/sessions":
      return {
        available: true,
        sessions: [
          {
            sessionId: "stored-A",
            cwd: "/tmp/stored-project",
            title: "Stored A",
            preview: "first message of A",
            updatedAt: "2026-10-19T00:00:00.000Z",
          },
          { sessionId: "stored-B", cwd: "/tmp/stored-project" },
        ],
      };
    // The rewind receipt. The real bridge plans the range from the visible
    // surface, appends the replacement and answers `{kind:"success", text}`;
    // every failure (an unknown scope, an unresolvable token, a rewind already
    // in flight) is a thrown error, which the plugin surfaces as
    // `request.failed`. `revert-unknown` pins that failure branch.
    case "paseo/revert": {
      const token = params === undefined || params === null ? undefined : params.token;
      const messageId = token !== null && typeof token === "object" ? token.messageId : undefined;
      if (messageId === "revert-unknown") throw new Error("撤回目标无法解析：该消息不在会话表面上");
      return { kind: "success", text: "Withdrawn seq 3 and everything after it" };
    }
    case "paseo/subagents":
      if (mode() === "error") return { available: false, subagents: [], error: { message: "subagent catalog exploded" } };
      if (mode() === "replay-no-turn") {
        // A distinct id from `label-never`'s `child-N`: the two scenarios assert
        // opposite things about "a child with no turn" (one has 40 frames of
        // output and must open; the other has none and must close as canceled).
        // Reusing one id let the earlier scenario's frames be buffered and
        // replayed into the later one, so the "never started" child looked live.
        return {
          available: true,
          subagents: [{ sessionId: "child-T", parentSessionId: String(params?.sessionId ?? ""), mode: "continuable", label: "No turn" }],
        };
      }
      if (mode() === "replay-history-unavailable") {
        return {
          available: true,
          subagents: [{ sessionId: "child-U", parentSessionId: String(params?.sessionId ?? ""), mode: "continuable", label: "Unreadable U" }],
        };
      }
      if (mode() === "replay-race") {
        return {
          available: true,
          subagents: [{ sessionId: "child-R", parentSessionId: String(params?.sessionId ?? ""), mode: "continuable", label: "Racing R" }],
        };
      }
      if (mode() !== "replay") return { available: true, subagents: [] };
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
          events: withHistoryTimes([
            { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "run something long" }] } },
            { type: "turn/start", seq: 2, data: { turn: 1 } },
            { type: "step/start", seq: 3, data: { turn: 1, step: 1 } },
            { type: "tool/call", seq: 4, data: { turn: 1, step: 1, callId: "killed-1", name: "bash", arguments: { command: "sleep 999" } } },
          ]),
        };
      }
      if (sid === "child-A") {
        // Fork-inherited prefix (seq < 2) plus the child's own suffix.
        return {
          available: true,
          inheritedEventCount: 2,
          events: withHistoryTimes([
            { type: "user/message", seq: 0, data: { source: { kind: "user" }, content: [{ type: "text", text: "INHERITED-PARENT-TEXT" }] } },
            { type: "assistant/message", seq: 1, data: { turn: 0, step: 0, message: { id: "inh", content: [{ type: "text", text: "INHERITED-PARENT-REPLY" }] } } },
            ...childAEvents(),
          ]),
        };
      }
      if (sid === "child-B") {
        return {
          available: true,
          inheritedEventCount: 0,
          events: withHistoryTimes([
            { type: "subagent/descriptor", seq: 0, data: { label: "Nested B" } },
            ...childBEvents(),
          ]),
        };
      }
      // Both end inside an open turn; only child-M has live evidence.
      if (sid === "child-M") return { available: true, inheritedEventCount: 0, events: withHistoryTimes(liveChildEvents()) };
      if (sid === "child-K") return { available: true, inheritedEventCount: 0, events: withHistoryTimes(killedChildEvents()) };
      if (sid === "child-T") return { available: true, inheritedEventCount: 0, events: withHistoryTimes(neverStartedChildEvents()) };
      if (sid === "child-U") {
        // Same shape as the real bridge's `unavailableHistory()`: a failed read
        // is still a history object, so callers can rely on `events` being a
        // list instead of guessing around a missing field.
        return {
          available: false,
          inheritedEventCount: 0,
          events: [],
          error: { message: "child U history exploded" },
        };
      }
      if (sid === "child-R") {
        // The terminal races the history read: emitted BEFORE this reply, so it
        // reaches the plugin while child-R's replay is still in flight.
        notify("session.event", {
          sessionId: "child-R",
          event: { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
        });
        return { available: true, inheritedEventCount: 0, events: withHistoryTimes(racingChildEvents()) };
      }
      // The image scenario replays the same log, so a reopen proves the picture
      // row is rebuilt from history and not only from the live turn.
      if (mode() === "image") return { available: true, inheritedEventCount: 0, events: withHistoryTimes(imageRootEvents()) };
      return { available: true, inheritedEventCount: 0, events: withHistoryTimes(rootEvents()) };
    }
    case "session/prompt": {
      // The per-session gate the real bridge applies before doing any work
      // (`server.js:920-931`). Wording and the `initialize`-required substring are
      // kept verbatim: the plugin's one-shot self-heal keys on that substring
      // (`dsh-process.ts` `#isNotInitializedError`), so a stand-in that phrased it
      // differently would make a real defect look unrecoverable — and, worse, a
      // stand-in with no gate at all made a real defect invisible.
      if (requiresInitialize() && !initializedSessions.has(String(rootId ?? ""))) {
        throw new Error(
          `paseo bridge is not initialized for session ${String(rootId)}; `
            + "send `initialize` with this sessionId before prompting",
        );
      }
      // `crash` dies the moment a prompt arrives, with no reply and no output:
      // the shape a real child produces when it is OOM-killed or throws inside
      // its own bootstrap. The exit is **synchronous** on purpose — the caller
      // writes a second, large frame in the same tick, so the child is gone with
      // most of that frame still unread in the pipe. That is what makes the
      // parent's `stdin.write` fail **asynchronously** with EPIPE, which used to
      // be an uncaught exception that took the whole plugin down.
      // See `harness/process-crash-check.mjs`.
      if (mode() === "crash") {
        process.exit(1);
      }
      // `orphan` answers a prompt with frames the *plugin* cannot route: one for
      // the prompted session itself, and one for a child of it. When the session
      // is detached at that moment both are held in the orphan buffer, which is
      // the state `detachSession` has to clean up (L1-6). Harmless when the
      // session is attached — they route and the check sees normal output.
      if (mode() === "orphan") {
        const child = `orphan-child-of-${String(rootId)}`;
        notify("session.child-opened", { sessionId: child, parentSessionId: String(rootId), mode: "one-shot", cwd: "/tmp" });
        notify("session.event", { sessionId: child, event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "oc1", content: [{ type: "text", text: "held child answer" }] } } } });
        notify("session.event", { sessionId: String(rootId), event: { type: "assistant/message", seq: 2, data: { turn: 1, step: 1, message: { id: "or1", content: [{ type: "text", text: "held root answer" }] } } } });
        return { messageId: "m-orphan" };
      }
      const state = stateOf(rootId);
      if (mode() === "multi") {
        // The `multi` scenario is process-wide in what it asserts (no cross-talk
        // between sessions sharing a process) but per-session in what it emits.
        //
        // It must NOT emit the whole set on the first prompt: the plugin opens
        // sessions one at a time and prompts each as it becomes ready, so at the
        // first prompt `rootIds` holds only the sessions opened so far. Emitting
        // then would answer the first session and silently skip the rest, and a
        // check would see "B never answered" — a fake-bridge artifact, not a
        // plugin bug. Each prompt therefore answers its own session, after a
        // short delay so the two sessions' frames interleave rather than arrive
        // in prompt order.
        state.promptCount = (state.promptCount ?? 0) + 1;
        const sessionId = rootId;
        setTimeout(() => { void emitMultiTurn(sessionId); }, 30);
        return { messageId: `m-${rootId}-${state.promptCount}` };
      }
      if (mode() === "live" && !state.emitted) {
        state.emitted = true;
        setTimeout(() => { void emitScenario(); }, 30);
      }
      if (mode() === "nested" && !state.emitted) {
        state.emitted = true;
        setTimeout(() => { void emitNested(); }, 30);
      }
      if (mode() === "stream" && !state.emitted) {
        state.emitted = true;
        setTimeout(() => { void emitStream(); }, 20);
      }
      if (mode() === "retry" && !state.emitted) {
        state.emitted = true;
        setTimeout(() => { void emitRetry(); }, 20);
      }
      if (mode() === "failturn" && !state.emitted) {
        state.emitted = true;
        // DSH can end a turn for reasons that are not a clean finish. The root's
        // terminal `session.turn` is emitted later, from the remembered reason,
        // so this is the only place that can say the turn failed.
        setTimeout(() => { void endRootTurn("partial answer", "error"); }, 20);
      }
      if (mode() === "image" && !state.emitted) {
        state.emitted = true;
        setTimeout(() => { void emitImage(); }, 30);
      }
      if (mode() === "steer") {
        if (params?.delivery === "steer") {
          // A steer belongs inside the turn already running: it ends that turn
          // rather than opening another one.
          if (state.rootTurnOpen) {
            state.rootTurnOpen = false;
            setTimeout(() => { void finishSteerTurn(); }, 20);
          }
        } else if (!state.emitted) {
          state.emitted = true;
          state.rootTurnOpen = true;
          // Real DSH opens the turn synchronously inside `followup()`, so this
          // status is written before the reply below: the plugin has the turn id
          // in hand when it answers, which is what the daemon later steers by.
          notify("session.status", { sessionId: rootId, status: "running" });
          setTimeout(() => { void openSteerChild(); }, 20);
        }
      }
      if (mode() === "late" && params?.delivery !== "steer" && !state.emitted) {
        state.emitted = true;
        // Synthetic order, *not* what DSH does: real DSH enters the running phase
        // synchronously inside `followup()` and the bridge writes the status
        // notification before the prompt reply (that is the `steer` mode's
        // order). This mode replies first on purpose, to pin the invariant
        // defensively — the plugin must name the same turn in the prompt result
        // and in the later `session.turn started` even if the status were late.
        setTimeout(() => { notify("session.status", { sessionId: rootId, status: "running" }); }, 20);
        setTimeout(() => { void endRootTurn("late answer"); }, 40);
      }
      if (mode() === "failonce") {
        state.promptAttempts += 1;
        // The first prompt is refused outright, so the plugin must drop the turn
        // id it issued for it instead of leaving a ghost behind.
        if (state.promptAttempts === 1) throw new Error("the runtime refused the prompt");
        if (params?.delivery !== "steer" && !state.emitted) {
          state.emitted = true;
          setTimeout(() => { notify("session.status", { sessionId: rootId, status: "running" }); }, 20);
          setTimeout(() => { void endRootTurn("recovered answer"); }, 40);
        }
      }
      if (mode() === "cancel" && params?.delivery !== "steer") {
        state.cancelPrompts += 1;
        if (state.cancelPrompts === 1) setTimeout(() => { void openCancelTurn(); }, 20);
        else setTimeout(() => { void runAfterCancelTurn(); }, 20);
      }
      return { messageId: "m-1" };
    }
    case "session/cancel": {
      // The one thing this scenario exists to observe: the plugin really asked
      // the runtime to stop the turn it thinks is running.
      if (mode() === "cancel") cancelTurn();
      return { canceled: true };
    }
    case "paseo/plan/get":
      return { available: false, active: false, pending: false };
    case "paseo/plan/set":
      return { available: false, active: false, pending: false, outcome: "queued" };
    /**
     * Per-session MCP mount.
     *
     * The real bridge records the entries and mounts them on the agent's own
     * scope when `createSession` runs, so one process can serve several sessions
     * that each talk to a different Paseo caller. A scripted stand-in has no
     * agents, so it only has to answer — but it must answer, and it must answer
     * *before* the prompt: the plugin sends `initialize` → `paseo/mcp/set` →
     * `session/prompt`, and a bridge that threw on the middle frame would look
     * exactly like a broken plugin.
     *
     * `mounted` mirrors the real bridge's honesty: it is false when the agent
     * already existed at set time (the real one defers to the next resume and
     * says so on stderr). Here nothing is ever mounted, so false is the truthful
     * answer and the plugin's `mounted:false` logging path stays exercised.
     */
    case "paseo/mcp/set":
      // `mcp-late` reproduces the real bridge's *refusal*, not its reply: a set
      // that arrives after the session's agent exists cannot be mounted into a
      // live agent scope, and `dsh-bridge/lib/server.js` throws there rather than
      // answering `mounted: false`. The plugin used to only log that, which made
      // "this session has no MCP tools for its whole life" a stderr line the user
      // never sees. Its own handling of a throw is the thing under test
      // (`harness/mcp-injection-check.cjs`).
      //
      // The stand-in has no agents, so it cannot observe "the agent exists". The
      // mode is the caller's assertion that it does — which is the only way to
      // reach this path offline, and keeps the default mode's behavior unchanged.
      if (mode() === "mcp-late") {
        throw new Error(
          `paseo/mcp/set for session ${String(params?.sessionId)} arrived after its agent was created; `
            + "its MCP servers cannot be mounted into a live agent scope. Close and reopen the session "
            + `to mount ${Array.isArray(params?.entries) ? params.entries.length : 0} entr(y/ies) `
            + "(they are queued for the next resume).",
        );
      }
      return { accepted: true, entries: Array.isArray(params?.entries) ? params.entries.length : 0, mounted: false };
    /**
     * Close one session's bridge-side state.
     *
     * The real bridge drops ten maps and returns `{closed:false}` for an unknown
     * id (idempotent, never throws), so a caller may call it unconditionally.
     * The stand-in keeps no per-session state beyond `scenarioState`; forgetting
     * that entry here would leak across a reopen in `multi`, so it is dropped.
     */
    case "session/close": {
      const id = typeof params?.sessionId === "string" ? params.sessionId : "";
      if (id === "") return { closed: false };
      const had = scenarioState.delete(id);
      return { closed: had };
    }
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
