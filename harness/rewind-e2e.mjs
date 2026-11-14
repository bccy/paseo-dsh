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
 *   5. turn 3: ask for the secret — the model must answer ALPHA and not BETA,
 *      with the answer read from the LAST turn only and asserted non-empty
 *      first (an empty answer is a failure, not "it forgot").
 *
 * Usage: node harness/rewind-e2e.mjs [--cwd <dir>] [--with-memory]
 * Requires a working `dsh` on PATH and the `paseo` profile (the same one
 * `paseo-dsh doctor` checks). The session runs in a temp directory.
 *
 * Profile isolation: by default the probe clones the profile named by
 * DSH_PASEO_PROFILE (default `paseo`) into a throwaway DSH_HOME, so the live
 * `~/.dsh` is never written (sessions, journals and rewind state all land in the
 * copy). Pass `--allow-real-profile` to use the live home instead; an explicit
 * `DSH_HOME=<dir>` is used as-is. The first output line names the mode, the
 * second says which profile rows the clone switched off.
 *
 * Third-party plugins: this probe measures the bridge's rewind, so a plugin
 * whose state a rewind does not touch must not decide the verdict. The last two
 * turns used to be red purely because the live profile ships a memory plugin:
 * the model wrote the withdrawn secret into its memory store during the
 * withdrawn turn, the rewind withdrew the transcript but not the store, and the
 * plugin injected the secret back before turn 3 (`docs/REWIND.md`, known gap).
 * The clone therefore switches off the profile rows listed in
 * `REWIND_E2E_DISABLE_ROWS` (default `dsh-memory`; set it to an empty string to
 * disable nothing). The list holds **profile row ids**, not package names, so
 * nothing here is tied to one vendor; an id the profile does not have is
 * "nothing to disable" and is printed, not failed. The live home is never
 * modified. Pass `--with-memory` to keep those rows and observe the gap
 * instead: the answer and injection lines become observations, not pass/fail.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { announceDshHome, prepareDshHome } = require("./isolated-dsh-home.cjs");
const { lastTurnAnswer, pluginInjectedUserTexts } = require("./harness-gates.cjs");

// The two secrets are the whole assertion: ALPHA survives the rewind, BETA was
// withdrawn. Named constants so a prompt and the check that reads it back can
// never drift apart.
const SECRET_FIRST = "ALPHA";
const SECRET_WITHDRAWN = "BETA";

const argv = process.argv.slice(2);
const cwdFlag = argv.indexOf("--cwd");
const root = cwdFlag >= 0 && argv[cwdFlag + 1] !== undefined
  ? argv[cwdFlag + 1]
  : mkdtempSync(join(tmpdir(), "rewind-e2e-"));

// `--with-memory` is the explicit opt-in to measure the known gap: memory rows
// stay enabled and the two memory-sensitive judgements only print.
const withMemory = argv.includes("--with-memory");
const disableRows = withMemory
  ? []
  : (process.env.REWIND_E2E_DISABLE_ROWS ?? "dsh-memory")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");

let runMode;
try {
  runMode = prepareDshHome({
    script: "rewind-e2e",
    profile: process.env.DSH_PASEO_PROFILE ?? "paseo",
    disable: disableRows,
  });
} catch (error) {
  console.error(`rewind-e2e: ${error.message}`);
  process.exit(2);
}
announceDshHome(runMode);
if (withMemory) {
  console.log(
    "--with-memory: memory rows stay enabled in the clone; the documented known gap " +
      "(a rewind withdraws the transcript, not a memory store) may show up below as observations, " +
      "not as pass/fail",
  );
}

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
    // `unref()`: a response normally clears `pending`, but the timer would keep
    // the event loop alive for up to `timeoutMs` after the last request, so a
    // finished probe looked like a hang until its wrapper killed it.
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); }
    }, timeoutMs).unref();
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
  //
  // `sessionId` is required: `initialize` pins cwd/route FOR ONE session, and the
  // bridge refuses a prompt from a session it has never initialized. This used to
  // omit it — the pre-multi-session shape, where `initialize` configured the whole
  // process — and the shared-process bridge rejects that outright.
  await request("initialize", { cwd: root, sessionId });
  const first = await request("session/prompt", {
    sessionId,
    contentBlocks: [{ type: "text", text: `记住一个暗号：${SECRET_FIRST}。只回复“记住了”。` }],
  });
  await waitForTurns(1);

  const second = await request("session/prompt", {
    sessionId,
    contentBlocks: [{
      type: "text",
      text: `暗号改成 ${SECRET_WITHDRAWN}；必须用 write 工具（不要用 bash）在当前目录创建 rewind-probe.txt，内容写 hello。完成后只回复“好”。`,
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
  // Scoped to the last turn (see `lastTurnAnswer`): the old picker took the last
  // assistant text of the *whole* stream, so a turn that emitted only tool calls
  // would be judged on the previous turn's answer.
  const answer = lastTurnAnswer(
    events.map((frame) => frame.params?.event).filter((event) => event !== undefined),
  );

  // An empty answer is a failure, not "the model forgot BETA". Without this
  // assertion a reader that produced nothing (one real run did, from a
  // mis-indexed frame) reported "and no longer knows BETA" PASS — a fake green.
  if (withMemory) {
    console.log(`  OBSERVED  the third turn answered ${JSON.stringify(answer.slice(0, 160))}`);
  } else {
    check("the third turn produced an answer", answer.trim() !== "", JSON.stringify(answer.slice(0, 120)));
    check(`the model still knows ${SECRET_FIRST}`, answer.includes(SECRET_FIRST), answer.slice(0, 120));
    check(
      `and no longer knows ${SECRET_WITHDRAWN}`,
      answer.includes(SECRET_WITHDRAWN) === false,
      answer.slice(0, 120),
    );
  }

  // The same contract, one layer down: whatever a rewind folds away must not
  // come back through a *plugin-injected* message. A plugin writes an ordinary
  // `user/message` (source.kind `plugin:…`) before the human's; the fold only
  // covers the withdrawn turn's seq range, so an injection that quotes the
  // withdrawn text survives and reaches the model. With the memory rows off
  // there is nothing to inject; this is the assertion that fails loudly if that
  // ever stops being true, instead of leaving the answer check to catch it.
  const finalSurface = await request("paseo/history", { sessionId });
  const injected = pluginInjectedUserTexts(finalSurface.events ?? []);
  const carrying = injected.filter((row) => row.text.includes(SECRET_WITHDRAWN));
  if (withMemory) {
    console.log(
      `  OBSERVED  ${injected.length} plugin-injected row(s) in the replayed surface` +
        (carrying.length === 0 ? "" : `, ${carrying.length} carrying the withdrawn text`),
    );
    for (const row of injected) console.log(`    OBSERVED  ${row.kind} — ${row.text.replace(/\s+/g, " ").slice(0, 200)}`);
    if (carrying.length > 0) {
      console.log(
        "  KNOWN GAP  the withdrawn text is back in the model's context through a plugin injection " +
          "(docs/REWIND.md, known gap; the rewind withdraws the transcript, not the plugin's store)",
      );
    }
  } else {
    check(
      "no plugin-injected message carries the withdrawn text",
      carrying.length === 0,
      JSON.stringify(carrying.map((row) => `${row.kind}: ${row.text.slice(0, 80)}`)),
    );
  }
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
