/**
 * Plugin-level regression for image tool results.
 *
 * DSH's `read_image` returns an image content block
 * (`{type:"image", attachment:{…}}`) beside its rendered text. That block used
 * to be dropped on the floor: `textOf()` keeps only text blocks, and Paseo's
 * tool detail union has no image field, so the picture was invisible while the
 * row looked fine. The bridge now appends each attachment's durable absolute
 * path (`hostPath`), and the plugin turns a stamped block into its own
 * `assistant_message` whose text is a markdown image — the one shape Paseo's
 * renderer draws bytes from over its file RPC.
 *
 * This check drives the real Paseo plugin over the bridge protocol with a
 * scripted fake `dsh` (`harness/fake-dsh-bridge.mjs`, `DSH_FAKE_MODE=image`) and
 * asserts:
 *
 *   1. exactly one markdown-image `assistant_message` is emitted, with a stable
 *      id and `messageId`, for the one block the bridge stamped
 *   2. its text is `![alt](file://…)`, with the path encoded segment by segment
 *      and the alt taken from the attachment's own file name
 *   3. a block with no `hostPath` (a reference the attachment store could not
 *      resolve) produces no row at all — the tool row is still there, so the
 *      result was consumed, not skipped
 *   4. the row survives `ProviderEventSchema.parse`, the boundary every outgoing
 *      event crosses in the plugin subprocess
 *   5. reopening with `history: "replay"` rebuilds the same row from the stored
 *      log, with the same id and text
 *
 * Compile the plugin first (tsc type errors under `--moduleResolution node` are
 * expected; the emitted JS is what runs):
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/image-check.cjs ../harness/fake-dsh-bridge.mjs .dbg/
 *   cd .dbg && node image-check.cjs
 *   rm -rf ../.dbg
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fakeBridge = path.join(__dirname, "fake-dsh-bridge.mjs");
fs.chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "image";

// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which rewrites `$DSH_HOME/profiles/<name>/
// node_modules/dsh-paseo-bridge` from the bridge embedded in the plugin. The
// fake `dsh` needs no profile, so point DSH_HOME at a throwaway tree.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-image-check-"));
process.on("exit", () => {
  try {
    fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const plugin = require("./index.server.js").default;
/** The schema the plugin subprocess parses every outgoing event with. */
const { ProviderEventSchema } = require("@getpaseo/plugin/server/provider");

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

async function untilSince(start, predicate, label, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.slice(start).find(predicate);
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

/** Every emitted item of one type, in order. */
const items = (type) =>
  events.filter((e) => e.type === "timeline.item" && e.item?.type === type).map((e) => e.item);

/** The plugin's picture rows: assistant messages whose id carries the call. */
const imageItems = () =>
  items("assistant_message").filter((item) => String(item.id).startsWith("image:"));

/** The expected markdown for the fake bridge's stamped image (`img-1`). */
const EXPECTED_TEXT = "![paseo-01.png](file:///tmp/paseo%20dir/01%20image.png)";

(async () => {
  const conn = await registration.connect({
    capabilities: ["prompt.message", "session.configure", "session.persistence", "session.list"],
  });
  conn.onEvent((event) => events.push(event));

  const sessionId = `image-${Date.now()}`;
  await conn.send({ type: "session.open", sessionId, config: { cwd: process.cwd(), mode: "build" } });
  await until((e) => e.type === "session.ready" && e.sessionId === sessionId, "session.ready");

  const promptMark = events.length;
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: { clientMessageId: "p-image", input: { type: "message", content: [{ type: "text", text: "look at this picture" }] } },
  });
  await untilSince(promptMark, (e) => e.type === "session.turn" && e.state === "completed", "turn completed");
  await sleep(300);

  // ---- 1. exactly one picture row, from the one stamped block -------------
  const images = imageItems();
  check(
    "a stamped image block yields exactly one assistant_message",
    images.length === 1,
    images.length ? `${images.length}: ${images.map((i) => i.id).join(", ")}` : "(none)",
  );
  const image = images[0];
  check(
    "its id is derived from the call and the block position (stable across replays)",
    image !== undefined && image.id === "image:img-1:1" && image.messageId === image.id,
    image === undefined ? "(none)" : `id=${image.id} messageId=${image.messageId}`,
  );

  // ---- 2. the markdown the host's file-RPC renderer reads -----------------
  check(
    "its text is a markdown image with the path encoded segment by segment",
    image?.text === EXPECTED_TEXT,
    JSON.stringify(image?.text ?? null),
  );

  // ---- 3. an unresolvable block produces no row ---------------------------
  // The row is emitted `running` from `tool/call` and then settled by its
  // `tool/result`; the last emission is the state the user ends up seeing.
  const img2Rows = items("tool_call").filter((row) => row.callId === "img-2");
  const img2 = img2Rows[img2Rows.length - 1];
  check(
    "the unstamped result is still consumed as a tool row (nothing was skipped)",
    img2 !== undefined && img2.status === "completed",
    JSON.stringify(img2Rows.map((row) => row.status)),
  );
  check(
    "a block with no hostPath yields no picture row (and no empty line)",
    !items("assistant_message").some((item) => String(item.id).startsWith("image:img-2")),
    items("assistant_message")
      .map((item) => item.id)
      .join(", ") || "(no assistant items)",
  );

  // ---- 4. it survives the process boundary the plugin parses every event at
  const parsed = ProviderEventSchema.parse({ type: "timeline.item", sessionId, item: image });
  check(
    "the picture row survives ProviderEventSchema.parse intact",
    parsed.item.type === "assistant_message" &&
      parsed.item.id === "image:img-1:1" &&
      parsed.item.messageId === "image:img-1:1" &&
      parsed.item.text === EXPECTED_TEXT,
    JSON.stringify(parsed.item),
  );

  // ---- 5. the replay path rebuilds the same row ---------------------------
  await conn.send({ type: "session.close", sessionId });
  await until((e) => e.type === "session.closed" && e.sessionId === sessionId, "session.closed");
  const replayMark = events.length;
  await conn.send({
    type: "session.open",
    requestId: "reopen",
    sessionId,
    config: { cwd: process.cwd(), mode: "build" },
    persistence: { version: 1, data: { sessionId } },
    history: "replay",
  });
  await untilSince(replayMark, (e) => e.type === "session.ready" && e.sessionId === sessionId, "reopened ready");
  await sleep(300);
  const replayedImages = events
    .slice(replayMark)
    .filter((e) => e.type === "timeline.item" && e.item?.type === "assistant_message" && String(e.item.id).startsWith("image:"))
    .map((e) => e.item);
  check(
    "reopening with history:replay rebuilds the picture row from the log",
    replayedImages.length === 1 &&
      replayedImages[0].id === "image:img-1:1" &&
      replayedImages[0].text === EXPECTED_TEXT,
    replayedImages.length ? JSON.stringify(replayedImages[0]) : "(none)",
  );

  const failed = events.filter((e) => e.type === "request.failed" || e.type === "session.runtime_failed");
  check("the image turn produced no failure event", failed.length === 0, failed.length ? JSON.stringify(failed[0]).slice(0, 160) : "");

  await conn.close();

  const failedCount = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
  process.exit(failedCount === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(1);
});
