/**
 * End-to-end probe for the rewind against a real `dsh --profile paseo`.
 *
 * Everything else in `harness/` either pins a pure function or a fake bridge.
 * This is the one check that runs the replacement write, the replay fold and the
 * file rollback through the real runtime, which is exactly the layer where the
 * previous implementation shipped a write that threw on every append ("offline
 * green, real append broken"). It costs a few model turns and is therefore a
 * probe, not a CI regression.
 *
 * Scenario:
 *   1. turn 1: remember the secret ALPHA;
 *   2. turn 2: change the secret to BETA and create a file with `write`;
 *   3. rewind turn 2 with scope=both — the file is deleted, the conversation
 *      loses the BETA turn, and the raw log has no `command/run` event;
 *   4. re-read the history (the replay Paseo rebuilds a reopened session from)
 *      and assert the folded surface;
 *   5. turn 3: ask for the secret — the model must answer ALPHA and not BETA.
 *
 * Usage: node harness/rewind-e2e.mjs [--cwd <dir>]
 * Requires a working `dsh` on PATH and the `paseo` profile (the same one
 * `paseo-dsh doctor` checks). The session runs in a temp directory.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const cwdFlag = argv.indexOf("--cwd");
const root = cwdFlag >= 0 && argv[cwdFlag + 1] !== undefined
  ? argv[cwdFlag + 1]
  : mkdtempSync(join(tmpdir(), "rewind-e2e-"));

const child = spawn("dsh", ["--profile", process.env.DSH_PASEO_PROFILE ?? "paseo"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pending = new Map();
const events = [];
let nextId = 1;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() === "") continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (frame.id !== undefined && pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) reject(new Error(JSON.stringify(frame.error))); else resolve(frame.result);
      continue;
    }
    if (frame.method !== undefined) events.push(frame);
  }
});
const stderr = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));

function request(method, params, timeoutMs = 180000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); }
    }, timeoutMs);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForTurns(count) {
  const started = Date.now();
  while (Date.now() - started < 300000) {
    if (events.filter((frame) => frame.params?.event?.type === "turn/end").length >= count) return;
    await sleep(250);
  }
  throw new Error(`never saw turn end #${count}`);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

const sessionId = `rewind-e2e-${Date.now()}`;
const file = join(root, "rewind-probe.txt");
try {
  // No explicit route: the bridge must fall back to the profile's own default
  // (a hard-coded provider/model here would not run in someone else's profile).
  await request("initialize", { cwd: root });
  const first = await request("session/prompt", {
    sessionId,
    contentBlocks: [{ type: "text", text: "记住一个暗号：ALPHA。只回复“记住了”。" }],
  });
  await waitForTurns(1);

  const second = await request("session/prompt", {
    sessionId,
    contentBlocks: [{
      type: "text",
      text: "暗号改成 BETA；必须用 write 工具（不要用 bash）在当前目录创建 rewind-probe.txt，内容写 hello。完成后只回复“好”。",
    }],
  });
  await waitForTurns(2);
  await sleep(500);
  check("the agent created the probe file", existsSync(file), file);

  const before = await request("paseo/history", { sessionId });
  const beforeUsers = (before.events ?? []).filter(
    (event) => event.type === "user/message" && event.data?.source?.kind === "user",
  );
  check("the raw replay sees both user messages before the rewind", beforeUsers.length === 2, String(beforeUsers.length));

  const receipt = await request("paseo/revert", {
    sessionId,
    token: { messageId: second.messageId },
    scope: "both",
  }, 240000);
  check("the rewind reports success", receipt?.kind === "success", JSON.stringify(receipt).slice(0, 200));
  check("the receipt names the withdrawn seq", typeof receipt?.text === "string" && /Withdrawn seq \d+/.test(receipt.text), receipt?.text);
  check(
    "the receipt reports the deleted file",
    (receipt?.files?.deleted ?? []).some((entry) => entry.endsWith("rewind-probe.txt")),
    JSON.stringify(receipt?.files ?? null),
  );
  check("the probe file is gone", existsSync(file) === false);

  const after = await request("paseo/history", { sessionId });
  const afterEvents = after.events ?? [];
  const afterUsers = afterEvents.filter((event) => event.type === "user/message" && event.data?.source?.kind === "user");
  check("the replayed surface has one user message", afterUsers.length === 1, String(afterUsers.length));
  check(
    "and it is the first one",
    afterUsers[0]?.data?.id === first.messageId,
    JSON.stringify(afterUsers.map((event) => event.data?.id)),
  );
  check(
    "the withdrawn turn's events are not replayed",
    afterEvents.some((event) => event.data?.id === second.messageId) === false,
  );
  check(
    "and no command/run event ever landed in the log",
    (after.events ?? []).every((event) => event.type !== "command/run"),
  );

  // The actual model-context proof: the rewind must have removed BETA from what
  // the next request sees. Memory/recall cannot fake ALPHA when BETA was the
  // latest instruction and is gone.
  await request("session/prompt", {
    sessionId,
    contentBlocks: [{ type: "text", text: "现在的暗号是什么？只回复暗号本身。" }],
  });
  await waitForTurns(3);
  await sleep(1500);
  const replies = events
    .filter((frame) => frame.params?.event?.type === "assistant/message")
    .map((frame) => (frame.params.event.data?.message?.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""));
  const answer = replies.at(-1) ?? "";
  check("the model still knows ALPHA", answer.includes("ALPHA"), answer.slice(0, 120));
  check("and no longer knows BETA", answer.includes("BETA") === false, answer.slice(0, 120));
} catch (error) {
  console.log("probe failed:", error.message);
  console.log(stderr.join("").slice(-2500));
  results.push({ name: "probe", pass: false });
} finally {
  child.stdin.end();
  child.kill("SIGKILL");
  if (cwdFlag < 0) setTimeout(() => rmSync(root, { recursive: true, force: true }), 500);
  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
