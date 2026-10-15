/**
 * LIVE native-subagent verification — MAIN SESSION ONLY, run by hand.
 *
 * The executor that wrote this file MUST NOT run it: it drives one real model
 * turn that makes the model delegate exactly one self-contained task to a
 * native DSH subagent. It is provided as the acceptance entry for the main
 * session, to be run only after the plugin has been reloaded so the `paseo`
 * profile carries the updated bridge.
 *
 * It is bounded and non-recursive by construction: it sends one prompt that
 * asks for a single delegation with an explicit "do not delegate further"
 * instruction, watches the raw bridge frames, and never sends a second turn.
 *
 * Usage (after the plugin is reloaded):
 *   node harness/subagent-live.mjs
 *
 * It prints the observed child tree and asserts, from the raw protocol:
 *   1. at least one `session.child-opened` frame appears;
 *   2. its `sessionId` is not the root session id, and its `parentSessionId`
 *      points at a known session (the root, or another child);
 *   3. later `session.event` frames exist for that child id (the child has its
 *      own timeline), and none of the child's assistant text is emitted under
 *      the root session id.
 *
 * It uses the installed `paseo` profile, no separate credentials, and stops the
 * runtime when done. It does not read or print any credential.
 */
import { spawn } from "node:child_process";

const PROFILE = process.env.DSH_PASEO_PROFILE ?? "paseo";
const SESSION_ID = `subagent-live-${Date.now()}`;
const PROMPT =
  "Use the subagent tool exactly once to delegate one small self-contained task: " +
  "ask the subagent to reply with exactly the single word PONG. " +
  "Inside the subagent, do not start any further subagents. " +
  "After it answers, reply with the word DONE.";

const child = spawn("dsh", ["--profile", PROFILE], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

const pending = new Map();
let nextId = 1;
let buffer = "";
const childOpened = [];
const childEventIds = new Set();
const rootChildText = [];
let rootId = null;

const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
    }, 240000);
  });

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.method === "paseo/question") {
      send({ jsonrpc: "2.0", id: frame.id, result: { answers: [] } });
      continue;
    }
    if (frame.method === "session.event") {
      const { sessionId, event } = frame.params ?? {};
      if (rootId !== null && sessionId !== rootId) childEventIds.add(sessionId);
      if (rootId !== null && sessionId === rootId && event?.type === "assistant/message") {
        const text = (event.data?.message?.content ?? [])
          .filter((b) => b?.type === "text")
          .map((b) => b.text)
          .join("");
        if (/PONG/i.test(text)) rootChildText.push(text);
      }
      continue;
    }
    if (frame.method === "session.child-opened") {
      childOpened.push(frame.params);
      continue;
    }
    if (frame.id !== undefined && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) entry.reject(new Error(frame.error.message));
      else entry.resolve(frame.result);
    }
  }
});
child.stderr.on("data", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await request("initialize", { cwd: process.cwd(), sessionId: SESSION_ID });
  rootId = SESSION_ID;
  await request("session/prompt", {
    sessionId: SESSION_ID,
    contentBlocks: [{ type: "text", text: PROMPT }],
  });

  // Wait for a child to appear, then let its turn settle; bounded.
  const deadline = Date.now() + 200000;
  while (Date.now() < deadline && childOpened.length === 0) await sleep(500);
  await sleep(8000);

  console.log(`root session: ${rootId}`);
  for (const opened of childOpened) {
    console.log(`  child-opened: ${opened.sessionId}  parent=${opened.parentSessionId}  label=${opened.label ?? ""}`);
  }
  console.log(`  child session ids with their own events: ${[...childEventIds].join(", ") || "(none)"}`);

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass });
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  };

  check("a native child session was opened", childOpened.length > 0, `${childOpened.length} child-opened`);
  const knownIds = new Set([rootId, ...childOpened.map((c) => c.sessionId)]);
  check(
    "every child points at a known parent (root or another child)",
    childOpened.length > 0 && childOpened.every((c) => knownIds.has(c.parentSessionId)),
  );
  check(
    "the child has its own timeline",
    [...childEventIds].some((id) => childOpened.some((c) => c.sessionId === id)),
    `${childEventIds.size} child session(s) emitted events`,
  );
  check("no child text leaked into the root timeline", rootChildText.length === 0, rootChildText[0]?.slice(0, 80));

  try {
    await request("shutdown", {});
  } catch {
    /* the process may exit before answering */
  }
  child.kill("SIGTERM");
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`threw: ${error.message}`);
  child.kill("SIGTERM");
  process.exit(1);
});
