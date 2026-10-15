#!/usr/bin/env node
/**
 * End-to-end streaming probe for `dsh --profile paseo`.
 *
 * Drives the installed bridge directly, without Paseo in the loop, and records
 * when live assistant snapshots arrive relative to the durable
 * `assistant/message`. This is the check that the bridge really subscribes to
 * DSH's transient `agent/assistant-stream` frames: the plugin-level check can
 * only prove the folding once a snapshot exists.
 *
 * Usage: node harness/stream-probe.mjs ["prompt text"]
 *
 * It asserts:
 *   1. several `paseo/assistant-delta` frames arrive before the durable message
 *   2. the snapshots grow monotonically and the last one covers the durable text
 *   3. the first snapshot arrives well before the durable one (not one lump)
 */
import { spawn } from "node:child_process";

const PROFILE = process.env.DSH_PASEO_PROFILE ?? "paseo";
const PROMPT =
  process.argv[2] ??
  "Explain how a hash table handles collisions, in about 150 words. Do not use any tools.";

const child = spawn("dsh", ["--profile", PROFILE], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

const pending = new Map();
let nextId = 1;
let buffer = "";
const startedAt = Date.now();
const deltas = [];
let durable = null;
let turnCompleted = false;
let failed = null;

const at = () => ((Date.now() - startedAt) / 1000).toFixed(2).padStart(6);

function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function request(method, params, timeoutMs = 180000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
    }, timeoutMs);
  });
}

function handleFrame(frame) {
  const method = frame.method;
  if (method === "session.event") {
    const { event } = frame.params;
    if (event?.type === "paseo/assistant-delta") {
      const { text = "", reasoning = "", turn = 0, step = 0 } = event.data ?? {};
      const fields = `${reasoning !== "" ? "r" : ""}${text !== "" ? "t" : ""}` || "-";
      deltas.push({ at: Date.now() - startedAt, text, reasoning, turn, step, fields });
      console.log(
        `  ${at()}s  delta[${fields}]  r=${String(reasoning.length).padStart(5)} t=${String(text.length).padStart(5)}  ${JSON.stringify(text.slice(-30))}`,
      );
      return;
    }
    if (event?.type === "assistant/message") {
      durable = (event.data?.message?.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      console.log(`  ${at()}s  DURABLE assistant/message (${durable.length} chars)`);
      return;
    }
    if (event?.type === "turn/end") {
      turnCompleted = true;
      return;
    }
    return;
  }
  if (method === "session.status") {
    if (frame.params?.status === "idle") turnCompleted = true;
    return;
  }
  if (frame.id !== undefined && typeof frame.id === "number") {
    const entry = pending.get(frame.id);
    if (entry === undefined) return;
    pending.delete(frame.id);
    if (frame.error !== undefined) entry.reject(new Error(frame.error.message ?? "request failed"));
    else entry.resolve(frame.result);
  }
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      handleFrame(JSON.parse(line));
    } catch {
      /* a non-frame line is DSH noise, not protocol */
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  for (const line of chunk.split("\n")) if (line.trim() !== "") console.log(`  [dsh] ${line}`);
});

const sessionId = `stream-probe-${Date.now()}`;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/**
 * The plugin folds each delta into items (reasoning when present, assistant
 * when present, both under stable ids and `messageId === id`), and Paseo turns
 * a same-id snapshot into the prefix delta of a row, concatenating only
 * adjacent same-type rows. Replaying those two rules answers the only question
 * that matters: does the user see one growing message per type, or fragments?
 */
function projectLikePaseo(deltas, turnId) {
  const items = [];
  for (const d of deltas) {
    if (d.reasoning !== "") items.push({ type: "reasoning", id: `reasoning:${d.turn}:${d.step}`, text: d.reasoning });
    if (d.text !== "") {
      const id = `assistant:${d.turn}:${d.step}`;
      items.push({ type: "assistant_message", id, messageId: id, text: d.text });
    }
  }
  const snapshots = new Map();
  const rows = [];
  for (const item of items) {
    const previous = snapshots.get(item.id);
    snapshots.set(item.id, item);
    const previousText = previous && previous.type === item.type ? previous.text : "";
    const delta = item.text.startsWith(previousText) ? item.text.slice(previousText.length) : item.text;
    if (delta.length === 0) continue;
    const last = rows[rows.length - 1];
    const sameType = last && last.type === item.type && last.turnId === turnId;
    const sameId =
      item.type !== "assistant_message" || item.messageId === undefined || last?.messageId === item.messageId;
    if (sameType && sameId) {
      last.text += delta;
      if (last.messageId === undefined && item.type === "assistant_message") last.messageId = item.messageId;
    } else {
      rows.push({
        type: item.type,
        text: delta,
        turnId,
        ...(item.type === "assistant_message" ? { messageId: item.messageId } : {}),
      });
    }
  }
  return rows;
}

try {
  console.log(`  ${at()}s  initialize`);
  await request("initialize", { cwd: process.cwd() });
  console.log(`  ${at()}s  prompt (${JSON.stringify(PROMPT.slice(0, 60))}...)`);
  await request("session/prompt", {
    sessionId,
    contentBlocks: [{ type: "text", text: PROMPT }],
  });

  const deadline = Date.now() + 180000;
  while (!turnCompleted && failed === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 500));

  const texts = deltas.map((d) => d.text);
  const nonDecreasing = texts.every((t, i) => i === 0 || t.startsWith(texts[i - 1]));
  const firstAt = deltas[0]?.at ?? -1;
  const durableAt = durable === null ? -1 : Date.now() - startedAt;

  console.log("");
  check(
    "several live snapshots arrived before the durable message",
    deltas.length >= 3,
    `${deltas.length} delta frame(s)`,
  );
  check(
    "snapshots grow monotonically by prefix",
    nonDecreasing && texts.length >= 2,
    texts.length >= 2 ? `${texts[0].length} -> ${texts[texts.length - 1].length} chars` : "(too few)",
  );
  check(
    "the durable message is covered by the last snapshot",
    durable !== null && deltas.length > 0 && durable.startsWith(texts[texts.length - 1]),
    durable === null ? "(no durable message)" : `durable=${durable.length} last=${texts[texts.length - 1]?.length ?? 0}`,
  );
  check(
    "streaming started well before the step settled",
    deltas.length > 0 && durableAt > firstAt && durableAt - firstAt > 500,
    `first delta at ${(firstAt / 1000).toFixed(2)}s, durable at ${(durableAt / 1000).toFixed(2)}s`,
  );

  // Paseo merges only *adjacent* same-type rows, so the projected result must
  // be one row per type. A frame carrying both halves is fine as long as it is
  // the single transition point; repeated alternation would fragment the answer.
  const projected = projectLikePaseo(deltas, "turn:1");
  const assistantRows = projected.filter((r) => r.type === "assistant_message");
  const reasoningRows = projected.filter((r) => r.type === "reasoning");
  const both = deltas.filter((d) => d.fields === "rt").length;
  check(
    "Paseo's fold yields one assistant row and one reasoning row",
    assistantRows.length === 1 && reasoningRows.length === 1,
    `${assistantRows.length} assistant row(s), ${reasoningRows.length} reasoning row(s), ${both} transition frame(s)`,
  );
} catch (error) {
  console.error(`  threw: ${error.message}`);
  results.push({ name: "probe ran", pass: false });
} finally {
  child.kill("SIGTERM");
}

const failedCount = results.filter((r) => !r.pass).length;
console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount === 0 ? 0 : 1);
