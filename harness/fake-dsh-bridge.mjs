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
 *            fork prefix) so a reopen can rebuild the tree
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
let rootTurnOpen = false;
let promptAttempts = 0;

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
const rootEvents = () => [
  { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "hello root" }] } },
  { type: "assistant/message", seq: 2, data: { turn: 1, step: 1, message: { id: "rm1", content: [{ type: "text", text: "root answer" }] }, usage: { inputTokens: 1, outputTokens: 2 } } },
  { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
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
async function endRootTurn(text) {
  notify("session.event", { sessionId: rootId, event: { type: "assistant/message", seq: 1, data: { turn: 1, step: 1, message: { id: "lm1", content: [{ type: "text", text }] } } } });
  notify("session.event", { sessionId: rootId, event: { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } } });
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
      if (MODE === "early" && !emitted) {
        emitted = true;
        setTimeout(() => { void emitEarly(); }, 0);
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
    case "paseo/subagents":
      if (MODE === "error") return { available: false, subagents: [], error: { message: "subagent catalog exploded" } };
      if (MODE !== "replay") return { available: true, subagents: [] };
      return {
        available: true,
        subagents: [
          { sessionId: "child-A", parentSessionId: String(params?.sessionId ?? ""), mode: "continuable", label: "Research A" },
          { sessionId: "child-B", parentSessionId: "child-A", mode: "one-shot", label: "Nested B" },
        ],
      };
    case "paseo/history": {
      const sid = String(params?.sessionId ?? "");
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
      if (sid === "child-B") return { available: true, inheritedEventCount: 0, events: childBEvents() };
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
      return { messageId: "m-1" };
    case "session/cancel":
      return { canceled: true };
    case "paseo/plan/get":
      return { available: false, active: false, pending: false };
    case "paseo/plan/set":
      return { available: false, active: false, pending: false, outcome: "queued" };
    case "paseo/config/set":
      return { provider: "fake", model: "fake", reasoningEffort: null, preset: null };
    case "shutdown":
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
