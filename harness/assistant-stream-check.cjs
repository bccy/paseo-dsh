/**
 * Plugin-level regression for live assistant streaming.
 *
 * DSH only publishes a durable `assistant/message` once a step settles, so the
 * bridge folds DSH's per-chunk `agent/assistant-stream` frames into growing
 * snapshots and forwards them as `paseo/assistant-delta` session events. This
 * check drives the real Paseo plugin over the bridge protocol with a scripted
 * fake `dsh` (`harness/fake-dsh-bridge.mjs`, `DSH_FAKE_MODE=stream`) and asserts
 * the plugin's half of the contract:
 *
 *   1. a step produces several growing assistant snapshots, not one lump
 *   2. every snapshot keeps the same item id and `messageId`, because Paseo
 *      folds a same-id snapshot into the prefix delta of one row only while
 *      `messageId` is identical — a differing one starts a second row and
 *      duplicates the text once the durable copy arrives
 *   3. the durable `assistant/message` lands on that same id and only extends it
 *   4. reasoning streams under its own stable id the same way
 *   5. replaying Paseo's own two rules (prefix delta + adjacent same-type merge)
 *      over what was emitted yields exactly one row per type, so the user sees
 *      one growing message and not a fragmented answer
 *
 * Compile the plugin first (tsc type errors under `--moduleResolution node` are
 * expected; the emitted JS is what runs):
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/assistant-stream-check.cjs ../harness/fake-dsh-bridge.mjs .dbg/
 *   cd .dbg && node assistant-stream-check.cjs
 *   rm -rf ../.dbg
 */
const fs = require("node:fs");
const path = require("node:path");

const fakeBridge = path.join(__dirname, "fake-dsh-bridge.mjs");
fs.chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "stream";

const plugin = require("./index.server.js").default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
let registration;

plugin({
  handle() {},
  registerProvider(r) {
    registration = r;
  },
  registerSettings() {},
  on() {},
  before() {},
});

async function until(predicate, label, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const items = (type, id) =>
  events
    .filter((e) => e.type === "timeline.item" && e.item?.type === type && (id === undefined || e.item.id === id))
    .map((e) => e.item);

/** Whether each snapshot is a prefix-extension of the previous one. */
function nonDecreasingByPrefix(texts) {
  for (let i = 1; i < texts.length; i += 1) {
    if (!texts[i].startsWith(texts[i - 1])) return false;
  }
  return true;
}

/** How many snapshots actually grew (an equal re-send is allowed, see below). */
function growthSteps(texts) {
  let steps = 0;
  for (let i = 1; i < texts.length; i += 1) {
    if (texts[i] !== texts[i - 1]) steps += 1;
  }
  return steps;
}

/**
 * Replays the two Paseo-side rules this contract depends on, taken from
 * `@getpaseo/server`: `plugin-provider.js` `mapTimelineItem` turns a snapshot
 * into the prefix delta (and drops an empty one), and `timeline-projection.js`
 * concatenates adjacent same-type rows of one turn. The result must be one row
 * per type — a fragmented answer means the plugin emitted interleaved types.
 */
function projectLikePaseo(emitted, turnId) {
  const snapshots = new Map();
  const rows = [];
  for (const item of emitted) {
    const previous = snapshots.get(item.id);
    snapshots.set(item.id, item);
    const previousText = previous && previous.type === item.type ? previous.text : "";
    const delta = item.text.startsWith(previousText) ? item.text.slice(previousText.length) : item.text;
    if (delta.length === 0) continue;
    const last = rows[rows.length - 1];
    // Same-type, same-turn adjacency, plus Paseo's assistant messageId guard:
    // two different messageIds never merge even when adjacent.
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

(async () => {
  const conn = await registration.connect({
    capabilities: ["prompt.message", "session.configure", "session.persistence", "session.list", "permission"],
  });
  conn.onEvent((event) => events.push(event));

  const sessionId = `stream-${Date.now()}`;
  await conn.send({ type: "session.open", sessionId, config: { cwd: process.cwd(), mode: "build" } });
  await until((e) => e.type === "session.ready" && e.sessionId === sessionId, "session.ready");

  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: { clientMessageId: "p-stream", input: { type: "message", content: [{ type: "text", text: "go" }] } },
  });
  await until((e) => e.type === "session.turn" && e.state === "completed", "turn completed");
  await sleep(300);

  // ---- 1. the step streamed as several growing snapshots ------------------
  // An equal final snapshot is expected, not a bug: the durable copy repeats
  // the last partial so it can fill any tail the throttle had not yet sent,
  // and Paseo drops the empty delta. So require prefix-monotonic text plus at
  // least two real growth steps.
  const assistant = items("assistant_message", "assistant:1:1");
  const assistantTexts = assistant.map((i) => i.text);
  // Every assistant item in the session, not just the ones under the id we
  // expect. Filtering by id is exactly what hid a durable message that opened a
  // second one: the audit renamed the durable id to `assistant:1:1:durable` and
  // this file still reported 7/7, even though the user would see the answer
  // twice — the regression the header says it exists to catch.
  const assistantIds = [...new Set(items("assistant_message").map((i) => i.id))];
  check(
    "one step emits several growing assistant snapshots (not one lump)",
    assistant.length >= 2 && nonDecreasingByPrefix(assistantTexts) && growthSteps(assistantTexts) >= 2,
    assistant.length ? `${assistant.length} snapshot(s): ${assistantTexts.map((t) => JSON.stringify(t)).join(" -> ")}` : "(none)",
  );

  // ---- 2. the Paseo merge invariant: id == messageId, stable across all ----
  check(
    "every assistant snapshot keeps id == messageId (Paseo folds, never duplicates)",
    assistant.length > 0 && assistant.every((i) => i.messageId === i.id),
    assistant.map((i) => `id=${i.id} messageId=${i.messageId}`).join(", ") || "(none)",
  );

  // ---- 3. the durable settlement extends the same id, no second copy ------
  check(
    "durable assistant/message lands on the same id and only extends it",
    assistantIds.length === 1 && assistant.length >= 2 && assistant[assistant.length - 1].text === "Hello world",
    `ids=${assistantIds.join(", ") || "(none)"} final=${JSON.stringify(assistant[assistant.length - 1]?.text ?? null)}`,
  );

  // ---- 4. reasoning streams under its own stable id ----------------------
  const reasoning = items("reasoning", "reasoning:1:1");
  check(
    "reasoning streams under one stable id, growing by prefix",
    reasoning.length >= 2 && nonDecreasingByPrefix(reasoning.map((i) => i.text)),
    reasoning.length ? `${reasoning.length} snapshot(s): ${reasoning.map((i) => JSON.stringify(i.text)).join(" -> ")}` : "(none)",
  );

  // ---- 5. Paseo's own fold yields one row per type, not fragments ---------
  // This is the invariant the whole feature exists for: a user must see one
  // growing message, not N little messages. The plugin cannot assert this alone
  // (Paseo does the folding), so replay Paseo's two rules over what was emitted.
  // Every assistant/reasoning item, whatever id it carried: whitelisting the two
  // expected ids kept a second one out of the projection, so the fold looked
  // clean while the user saw the answer twice.
  const emitted = events
    .filter(
      (e) =>
        e.type === "timeline.item" &&
        (e.item?.type === "assistant_message" || e.item?.type === "reasoning"),
    )
    .map((e) => e.item);
  const projected = projectLikePaseo(emitted, "turn:1");
  const assistantRows = projected.filter((r) => r.type === "assistant_message");
  const reasoningRows = projected.filter((r) => r.type === "reasoning");
  check(
    "Paseo's fold yields exactly one assistant row (no fragmented answer)",
    assistantRows.length === 1 && assistantRows[0].text === "Hello world",
    `${assistantRows.length} row(s): ${JSON.stringify(assistantRows.map((r) => r.text))}`,
  );
  check(
    "Paseo's fold yields exactly one reasoning row",
    reasoningRows.length === 1 && reasoningRows[0].text === "thinking",
    `${reasoningRows.length} row(s): ${JSON.stringify(reasoningRows.map((r) => r.text))}`,
  );

  const failed = events.filter((e) => e.type === "request.failed" || e.type === "session.runtime_failed");
  check("streaming produced no failure event", failed.length === 0, failed.length ? JSON.stringify(failed[0]).slice(0, 160) : "");

  await conn.close();

  const failedCount = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
  process.exit(failedCount === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(1);
});
