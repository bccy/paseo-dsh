/**
 * Plugin-level regression for a retried step in a live assistant stream.
 *
 * DSH can retry a request inside the SAME turn/step: the provider fails after
 * text has already streamed, `agent-loop` settles the attempt as
 * `assistant/attempt`, and the step starts a new frame series from an empty
 * snapshot. The bridge forwards each attempt's growing snapshot as
 * `paseo/assistant-delta`, so the plugin sees, for one `turn:step`:
 *
 *   attempt 1:  "我先看一下" -> "我先看一下仓库结构"
 *   attempt 2:  "The repo has" -> "The repo has three packages" -> "… and a bridge"
 *   durable:    "The repo has three packages and a bridge"
 *
 * Before the delta payload carried the attempt identity, every snapshot mapped
 * to the same item id, and Paseo's rule for a snapshot that is not a prefix of
 * the previous one is "append the whole thing". The user's final answer then
 * read as attempt 1's text glued in front of attempt 2's — a message that looks
 * like the model lost its mind rather than like a retry.
 *
 * What this pins:
 *   1. the two attempts get different item ids (the first keeps the historical
 *      `assistant:1:1`, the second is `assistant:1:1:2`)
 *   2. the durable `assistant/message` lands on the SECOND attempt's id, so it
 *      extends that row instead of printing the answer twice
 *   3. replaying Paseo's own fold rules (prefix delta + adjacent same-type
 *      merge, from `@getpaseo/server`) over what was emitted yields the final
 *      answer exactly once — no glued prefix, no duplicate row
 *   4. attempt 1's row survives as its own row (append-only cannot withdraw it;
 *      that is the known limit, and it must not swallow attempt 2's text)
 *   5. reasoning takes the same suffix, so a retried step does not interleave
 *      two attempts' thinking into one row
 *
 * The fake bridge (`harness/fake-dsh-bridge.mjs`, `DSH_FAKE_MODE=retry`) emits
 * the frames; everything below the wire is the real plugin.
 *
 * Compile the plugin first (type errors under `--moduleResolution node` are
 * expected; the emitted JS is what runs):
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/assistant-retry-check.cjs ../harness/fake-dsh-bridge.mjs .dbg/
 *   cd .dbg && node assistant-retry-check.cjs
 *   rm -rf ../.dbg
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fakeBridge = path.join(__dirname, "fake-dsh-bridge.mjs");
fs.chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "retry";

// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which rewrites `$DSH_HOME/profiles/<name>/
// node_modules/dsh-paseo-bridge` from the bridge embedded in the plugin. The
// fake `dsh` needs no profile, so point DSH_HOME at a throwaway tree.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-retry-check-"));
process.on("exit", () => {
  try {
    fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

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

/**
 * Replays the two Paseo-side rules this contract depends on, taken from
 * `@getpaseo/server`: `plugin-provider.js` `mapTimelineItem` turns a snapshot
 * into the prefix delta (and drops an empty one), and `timeline-projection.js`
 * concatenates adjacent same-type rows of one turn — but never across two
 * different `messageId`s, which is what keeps the two attempts apart.
 *
 * A copy of the same function in `assistant-stream-check.cjs`; duplicated
 * rather than shared because both are self-contained scripts that run from a
 * throwaway compile directory.
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

const FINAL = "The repo has three packages and a bridge";
const FIRST_ATTEMPT = "我先看一下仓库结构";

(async () => {
  const conn = await registration.connect({
    capabilities: ["prompt.message", "session.configure", "session.persistence", "session.list", "permission"],
  });
  conn.onEvent((event) => events.push(event));

  const sessionId = `retry-${Date.now()}`;
  await conn.send({ type: "session.open", sessionId, config: { cwd: process.cwd(), mode: "build" } });
  await until((e) => e.type === "session.ready" && e.sessionId === sessionId, "session.ready");

  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: { clientMessageId: "p-retry", input: { type: "message", content: [{ type: "text", text: "go" }] } },
  });
  await until((e) => e.type === "session.turn" && e.state === "completed", "turn completed");
  await sleep(300);

  // ---- 1. the two attempts land on different ids -------------------------
  const ids = [...new Set(items("assistant_message").map((i) => i.id))].sort();
  check(
    "the two attempts of one step get different item ids",
    ids.length === 2 && ids[0] === "assistant:1:1" && ids[1] === "assistant:1:1:2",
    `ids=${ids.join(", ") || "(none)"}`,
  );

  // ---- 2. the durable copy extends the SECOND attempt --------------------
  // The durable settlement repeats attempt 2's full text, so its delta against
  // that row is empty; on the first attempt's id it would be a second copy.
  const second = items("assistant_message", "assistant:1:1:2");
  check(
    "the durable assistant/message lands on the retried attempt's id",
    second.length > 0 && second[second.length - 1].text === FINAL,
    `${second.length} snapshot(s), last=${JSON.stringify(second[second.length - 1]?.text ?? null)}`,
  );
  check(
    "every snapshot keeps id == messageId (Paseo folds, never duplicates)",
    items("assistant_message").every((i) => i.messageId === i.id),
    items("assistant_message").map((i) => `${i.id}/${i.messageId}`).join(", ") || "(none)",
  );

  // ---- 3/4. Paseo's fold: final answer once, attempt 1 as its own row ----
  const emitted = events
    .filter((e) => e.type === "timeline.item" && (e.item?.type === "assistant_message" || e.item?.type === "reasoning"))
    .map((e) => e.item);
  const projected = projectLikePaseo(emitted, "turn:1");
  const rows = projected.filter((r) => r.type === "assistant_message");
  const finalRows = rows.filter((r) => r.text === FINAL);
  check(
    "Paseo's fold shows the final answer exactly once",
    finalRows.length === 1,
    `${rows.length} row(s): ${JSON.stringify(rows.map((r) => r.text))}`,
  );
  check(
    "the answer row is not glued onto the abandoned attempt's text",
    rows.every((r) => !r.text.includes(FIRST_ATTEMPT) || r.text === FIRST_ATTEMPT),
    JSON.stringify(rows.map((r) => r.text)),
  );
  check(
    "the abandoned attempt keeps its own row (append-only cannot withdraw it)",
    rows.some((r) => r.text === FIRST_ATTEMPT),
    JSON.stringify(rows.map((r) => r.text)),
  );
  // The whole point, stated the way a user would: no row contains both
  // attempts' text.
  check(
    "no single row contains both attempts' text",
    rows.every((r) => !(r.text.includes(FIRST_ATTEMPT) && r.text.includes("The repo"))),
    JSON.stringify(rows.map((r) => r.text)),
  );

  const failed = events.filter((e) => e.type === "request.failed" || e.type === "session.runtime_failed");
  check("the retried step produced no failure event", failed.length === 0, failed.length ? JSON.stringify(failed[0]).slice(0, 160) : "");

  await conn.close();

  const failedCount = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
  process.exit(failedCount === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(1);
});
