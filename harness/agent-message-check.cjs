/**
 * Offline assertions for the 0.12 agent-to-agent message row.
 *
 * Paseo 0.12 projects an agent message into the timeline as a tool call:
 * `name: "agent_message"`, a `plain_text` detail holding the text, and — the
 * part older rows ignore — an `agentMessage` field with the event, the sender
 * and the authoritative text (`@getpaseo/protocol`'s `projectAgentMessage`).
 * Without this mapping the head reads the wire name `agent_message`, and the
 * event and sender are lost; that looks like a broken tool call rather than a
 * message from another agent, which is exactly the kind of silent degradation
 * this repo asserts against.
 *
 * The head is asserted as `label · summary`: the event ("Agent finished") then
 * the sender, which is the shape the protocol's own display model produces
 * (`buildAgentMessageDisplay`: `displayName` = event, `summary` = sender). The
 * English event labels are compared against that model instead of a hand-copied
 * list, so a reworded catalog there fails here; the Chinese labels, the sender
 * fallbacks and every degradation path are pinned by hand.
 *
 * One degradation is a host defect, not a payload one: Paseo 0.12's app rebuilds
 * tool-call items before handing them to a plugin transformer and drops
 * `agentMessage` (`projectPluginTimelineItems`; FIELD-NOTES #64). The transformer
 * then returns `undefined` and leaves the row to Paseo's own renderer rather than
 * faking a message out of the `plain_text` echo. That branch lives in
 * `index.client.tsx`, which cannot be `require`d offline, so it is asserted from
 * its source text — condition included, exercised against the three item shapes.
 *
 * Run (from paseo-plugin):
 *   npx tsc client/tool-call-data.ts client/tokens.ts client/paseo-mark.ts \
 *     --outDir .dbg-am --rootDir . --module node16 --moduleResolution node16 \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg-am/package.json
 *   cp ../harness/agent-message-check.cjs .dbg-am/
 *   cd .dbg-am && node agent-message-check.cjs
 *
 * `--module node16` is load-bearing, not cosmetic: the item type comes from the
 * protocol package's ESM declaration file, and node16 is the resolution mode
 * that both honours its `exports` map and still emits CommonJS for this harness
 * to `require`. The source carries the matching `resolution-mode` attribute.
 *
 * Only pure modules are compiled: the React renderer imports the host runtime,
 * which plain `node` resolution cannot see. `index.client.tsx` is therefore read
 * as source, the same way `tool-call-check.cjs` checks its wiring.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Locate a repo source file from wherever this check runs. The documented
 * compile step copies the check into `paseo-plugin/.dbg-am` (one level below
 * `paseo-plugin`), but a scratch build dir such as `.tmp-test/<name>` sits one
 * level deeper; walking up finds the source either way instead of failing on
 * `__dirname/..`.
 */
function findRepoFile(relative, levels = 4) {
  let dir = __dirname;
  for (let i = 0; i < levels; i += 1) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const { AGENT_MESSAGE_EVENTS, allText, setLocale } = require("./client/locale.js");
const { toolCallData } = require("./client/tool-call-data.js");

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function equal(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

/**
 * The protocol's own model, loaded for comparison only.
 *
 * `@getpaseo/protocol` is ESM; Node >= 20.19 can `require` it from this CJS
 * harness (the same way `locale-check.cjs` loads the official catalog). A
 * missing module is a failed assertion, not a crash: the compare blocks below
 * skip when it is absent, and the check that loads it has already failed.
 */
let protocolPresentation = null;
try {
  protocolPresentation = require("@getpaseo/protocol/paseo-tool-presentation/index");
} catch (error) {
  console.log(`  (could not load the protocol presentation model: ${error.message})`);
}
const buildAgentMessageDisplay =
  protocolPresentation === null ? undefined : protocolPresentation.buildAgentMessageDisplay;

/** The exact shape 0.12's daemon hands the client (`projectAgentMessage`). */
function agentRow(agentMessage, detail) {
  return {
    name: "agent_message",
    status: "completed",
    error: null,
    // The echo the daemon adds for clients that predate `agentMessage`.
    detail: detail ?? { type: "plain_text", text: "", icon: "bot" },
    agentMessage,
  };
}

/**
 * The Chinese event labels, pinned by hand.
 *
 * English is not pinned here: it is compared against the protocol's own
 * `displayName`, which is the contract this row must follow.
 */
const ZH_EVENT_LABELS = {
  message: "收到消息",
  finished: "智能体已完成",
  errored: "智能体出错",
  "permission-required": "智能体需要授权",
  closed: "智能体已关闭",
};

console.log("the 0.12 projection draws a semantic row, not the wire name");
{
  setLocale(undefined); // the client default (zh-CN)
  const row = toolCallData(
    agentRow(
      { event: "finished", sender: { id: "agent-123", title: "Reviewer" }, text: "Please review the diff." },
      { type: "plain_text", text: "Please review the diff.", icon: "bot" },
    ),
    "complete",
  );
  equal("the head is the event", row.label, "智能体已完成");
  check("…not the wire name", row.label !== "agent_message", row.label);
  equal("the sender is the head's second half", row.summary, "Reviewer");
  equal("the message text is the body", row.body, "Please review the diff.");
  equal("the body caption is the message caption", row.bodyLabel, "消息");
  equal("the daemon's bot hint becomes the glyph", row.icon, "Bot");
  equal("the row draws the generic prose block", row.kind, "generic");
  equal("no structured card can claim it", [row.search, row.read, row.diffBlock, row.web], [null, null, null, null]);
  equal("it is not a diff or a code body", [row.diff, row.code], [false, false]);
  equal("its title is not the block's subject", row.titled, true);
  equal("so there is something to reveal", row.hasDetail, true);
  equal("it is not a failure", row.failed, false);
  equal("the wire name is kept as the row's identity", row.name, "agent_message");
  check("it draws no Paseo mark (the glyph is a bot)", row.paseoMark === false);

  // The renderer's zod schema and `ToolCallData` are asserted equal in
  // `tool-call-check.cjs`; this makes sure the agent-message path did not have
  // to grow a field to work.
  const baseline = toolCallData(
    { name: "bash", status: "completed", detail: { type: "shell", command: "ls", output: "x" } },
    "complete",
  );
  equal("the row's field set is the renderer's, unchanged", Object.keys(row).sort(), Object.keys(baseline).sort());
}

console.log("the five events are labelled from the protocol's own model");
{
  check(
    "the protocol's agent-message presentation is loadable",
    typeof buildAgentMessageDisplay === "function",
    protocolPresentation === null ? "require failed" : typeof buildAgentMessageDisplay,
  );
  equal(
    "the row ships exactly the protocol's five events",
    [...AGENT_MESSAGE_EVENTS].sort(),
    ["closed", "errored", "finished", "message", "permission-required"],
  );

  const en = allText().en.agentMessageEvents;
  const zh = allText()["zh-CN"].agentMessageEvents;
  equal("both languages ship the same event keys", Object.keys(en).sort(), Object.keys(zh).sort());
  equal(
    "every event has a value in both languages",
    Object.keys(en).filter((event) => en[event].trim() === "" || zh[event].trim() === ""),
    [],
  );

  for (const event of AGENT_MESSAGE_EVENTS) {
    const message = { event, sender: { id: "sender-1", title: "Sender" }, text: "hello" };
    const display =
      typeof buildAgentMessageDisplay === "function"
        ? buildAgentMessageDisplay({ event, sender: { id: "sender-1", title: "Sender" }, text: "hello" })
        : undefined;

    setLocale("en");
    const english = toolCallData(agentRow(message), "complete");
    if (display !== undefined) {
      equal(`${event} (en): the protocol's display name`, english.label, display.displayName);
      equal(`${event} (en): the protocol's summary (the sender)`, english.summary, display.summary);
    }
    equal(`${event} (en): the table agrees`, allText().en.agentMessageEvents[event], english.label);

    setLocale("zh-CN");
    const chinese = toolCallData(agentRow(message), "complete");
    equal(`${event} (zh): a pinned Chinese label`, chinese.label, ZH_EVENT_LABELS[event]);
    if (display !== undefined) {
      check(
        `${event} (zh) is translated, not copied from English`,
        chinese.label !== display.displayName,
        chinese.label,
      );
    }
  }
  setLocale(undefined);
}

console.log("the sender half degrades gracefully");
{
  setLocale("en");
  const titled = toolCallData(
    agentRow({ event: "finished", sender: { id: "agent-123", title: "Reviewer" }, text: "t" }),
    "complete",
  );
  equal("a sender title wins", titled.summary, "Reviewer");

  const untitled = toolCallData(
    agentRow({ event: "finished", sender: { id: "agent-123" }, text: "t" }),
    "complete",
  );
  equal("without a title the sender's id is shown", untitled.summary, "agent-123");
  equal("and the event still titles the row", untitled.label, "Agent finished");

  const blankTitle = toolCallData(
    agentRow({ event: "finished", sender: { id: "agent-123", title: "   " }, text: "t" }),
    "complete",
  );
  equal("a blank title is not a title", blankTitle.summary, "agent-123");

  const noSender = toolCallData(agentRow({ event: "message", text: "t" }), "complete");
  equal("a message without a sender has no second half", noSender.summary, "");
  equal("but still names the event", noSender.label, "Message received");

  const echoLess = toolCallData(
    agentRow({ event: "closed", sender: { id: "a" }, text: "the body" }, { type: "plain_text", icon: "bot" }),
    "complete",
  );
  equal("text is authoritative even with an empty echo", echoLess.body, "the body");

  const textMissing = toolCallData(
    agentRow({ event: "errored", sender: { id: "a" } }, { type: "plain_text", text: "echo only", icon: "bot" }),
    "complete",
  );
  equal("a payload without text keeps the echo", textMissing.body, "echo only");

  const differing = toolCallData(
    agentRow(
      { event: "message", sender: { id: "a" }, text: "authoritative" },
      { type: "plain_text", text: "stale echo", icon: "bot" },
    ),
    "complete",
  );
  equal("the semantic text wins over a differing echo", differing.body, "authoritative");

  const verbatim = toolCallData(
    agentRow({ event: "message", sender: { id: "a" }, text: "line 1\n<paseo-system>x</paseo-system>" }),
    "complete",
  );
  equal("the text is kept verbatim (no trimming, unescaping or XML parsing)", verbatim.body, "line 1\n<paseo-system>x</paseo-system>");
  setLocale(undefined);
}

console.log("a malformed or missing agentMessage degrades instead of throwing");
{
  setLocale(undefined); // zh-CN
  const echo = { type: "plain_text", text: "legacy echo", icon: "bot" };
  const cases = [
    // An item from a pre-0.12 daemon has no `agentMessage` at all: the plain_text
    // path it had before must be exactly what it was.
    [undefined, "agent_message", "legacy echo"],
    [null, "agent_message", "legacy echo"],
    ["not-an-object", "agent_message", "legacy echo"],
    [7, "agent_message", "legacy echo"],
    [[], "agent_message", "legacy echo"],
    [{}, "agent_message", "legacy echo"],
    // A semantic half that arrives with an event we do not know: a generic
    // heading, never the wire name and never a throw.
    [{ event: "bogus" }, "智能体消息", "legacy echo"],
    [{ sender: { id: "agent-9" } }, "智能体消息", "legacy echo"],
    // Nothing usable in it at all: back to the pre-0.12 row.
    [{ text: 42 }, "agent_message", "legacy echo"],
  ];
  for (const [agentMessage, expectedLabel, expectedBody] of cases) {
    const item = agentRow(agentMessage, echo);
    let row = null;
    let thrown = null;
    try {
      row = toolCallData(item, "complete");
    } catch (error) {
      thrown = error;
    }
    check(`agentMessage=${JSON.stringify(agentMessage)} does not throw`, thrown === null, String(thrown));
    if (row === null) continue;
    equal(`agentMessage=${JSON.stringify(agentMessage)}: the head degrades`, row.label, expectedLabel);
    equal(`agentMessage=${JSON.stringify(agentMessage)}: the echo is still the body`, row.body, expectedBody);
    check(`agentMessage=${JSON.stringify(agentMessage)}: it still expands`, row.hasDetail === true);
  }

  // The sender-only payload above is a real message with a missing event: it
  // must still show the sender it has.
  const senderOnly = toolCallData(agentRow({ sender: { id: "agent-9" } }, echo), "complete");
  equal("a sender without an event is still shown", senderOnly.summary, "agent-9");
  equal("and it asks for the generic heading", senderOnly.label, "智能体消息");

  // The daemon always sends `detail.icon: "bot"`, but a payload without that
  // hint must not fall to the wrench: it is still an agent's row.
  const noHint = toolCallData({
    name: "agent_message",
    status: "completed",
    detail: {},
    agentMessage: { event: "finished", sender: { id: "a" }, text: "t" },
  }, "complete");
  equal("a missing bot hint still draws the bot glyph, not the wrench", noHint.icon, "Bot");

  // A detail shape from another daemon (not the documented plain_text echo) is
  // prose too: the tool JSON must not become the message body.
  const oddDetail = toolCallData({
    name: "agent_message",
    status: "completed",
    detail: { type: "unknown", input: { raw: true }, output: { ok: true } },
    agentMessage: { event: "message", sender: { id: "a" }, text: "prose, not JSON" },
  }, "complete");
  equal("an oversized/odd detail shape cannot replace the message", oddDetail.body, "prose, not JSON");
  equal("and the row stays the generic block", oddDetail.kind, "generic");
  equal("no card is invented from that detail", [oddDetail.search, oddDetail.read, oddDetail.diffBlock, oddDetail.web], [null, null, null, null]);
}

console.log("status and size");
{
  setLocale(undefined);
  const failedRow = toolCallData({
    name: "agent_message",
    status: "failed",
    detail: { type: "plain_text", text: "t", icon: "bot" },
    agentMessage: { event: "errored", sender: { id: "a" }, text: "t" },
  }, "complete");
  equal("a failed message row is flagged", failedRow.failed, true);
  equal("…and keeps its semantic head", failedRow.label, "智能体出错");

  const huge = toolCallData(
    agentRow({ event: "message", sender: { id: "a" }, text: "y".repeat(7000) }),
    "complete",
  );
  check(
    "a huge message is truncated with the localized marker",
    huge.body.endsWith(allText()["zh-CN"].truncated) && huge.body.length < 7000,
    `${huge.body.length} chars`,
  );
  setLocale("en");
  equal(
    "and the English marker after a locale relay",
    toolCallData(agentRow({ event: "message", sender: { id: "a" }, text: "y".repeat(7000) }), "complete").body.endsWith(
      allText().en.truncated,
    ),
    true,
  );
  setLocale(undefined);
}

console.log("the transformer hands an agent message without agentMessage back to Paseo");
{
  // Two halves of one contract live in `index.client.tsx`, which imports the
  // renderers (and through them the host runtime) and therefore cannot be
  // `require`d here:
  //
  // 1. A row that *is* mapped forwards the whole item, so `agentMessage` travels
  //    with it. Picking fields would silently drop the semantic half.
  // 2. A row with `name === "agent_message"` but no `agentMessage` returns
  //    `undefined`. That keeps the source item and lets Paseo's own renderer
  //    draw it from the field it already holds; mapping it instead would print
  //    the wire name over the plain_text echo. This is the 0.12 app boundary:
  //    `projectPluginTimelineItems` rebuilds the item with only
  //    callId/name/status/error/detail/metadata (see FIELD-NOTES #64).
  //
  // The transformer cannot run offline, so the guard is checked in two parts:
  // its condition is extracted and exercised against the three item shapes, and
  // the source is asserted to `return undefined` in that branch, before any
  // mapping, without reading the plain_text payload.
  const sourcePath = findRepoFile("index.client.tsx");
  check("index.client.tsx is readable", sourcePath !== undefined, path.join(__dirname, "index.client.tsx"));
  const source = sourcePath === undefined ? "" : fs.readFileSync(sourcePath, "utf8");

  const toolTransformer = source.indexOf('id: "dsh-inline-tool"');
  check("the tool transformer was found", toolTransformer >= 0);
  const rendererAfter = source.indexOf("client.addTimelineRenderer", toolTransformer);
  const transformer =
    toolTransformer < 0 ? "" : source.slice(toolTransformer, rendererAfter < 0 ? undefined : rendererAfter);

  check(
    "the transformer calls toolCallData(item, phase) with the item itself",
    /toolCallData\(\s*item\s*,\s*phase\s*\)/.test(transformer),
  );
  check(
    "it does not build a picked literal (which would drop agentMessage)",
    !/toolCallData\(\s*\{/.test(transformer),
  );

  const guard =
    /if \(\s*(item\.name === "agent_message"\s*&&\s*item\.agentMessage === undefined)\s*\)\s*\{\s*return undefined;\s*\}/.exec(
      transformer,
    );
  check("the missing-agentMessage guard exists", guard !== null);
  if (guard !== null) {
    const guardAt = transformer.indexOf(guard[0]);
    const mappingAt = transformer.indexOf("toolCallData(item, phase)");
    check(
      "the guard returns undefined instead of mapping a legacy row",
      guardAt >= 0 && mappingAt > guardAt,
      `guard at ${guardAt}, mapping at ${mappingAt}`,
    );

    // The condition itself, run against the three shapes: the message row with
    // the field dropped (the app boundary), the same row with the field present
    // (a future host that forwards it), and an unrelated tool call.
    const holds = new Function("item", `return (${guard[1]});`);
    const legacy = {
      name: "agent_message",
      status: "completed",
      detail: { type: "plain_text", text: "raw echo", icon: "bot" },
    };
    equal("no agentMessage: the guard fires (source item kept for Paseo's renderer)", holds(legacy), true);
    equal(
      "…even when the field is present but undefined",
      holds({ ...legacy, agentMessage: undefined }),
      true,
    );
    equal(
      "with agentMessage: the guard does not fire (the semantic row is built)",
      holds({ ...legacy, agentMessage: { event: "finished", sender: { id: "a" }, text: "t" } }),
      false,
    );
    equal(
      "another tool call is unaffected",
      holds({ name: "bash", status: "completed", detail: { type: "shell", command: "ls" } }),
      false,
    );
  }

  // The fallback must not fabricate the message from the echo: this repo reads a
  // document field only from the field the protocol defines as its carrier. Read
  // the code with its comments stripped — the comments above *name* what must not
  // be parsed, and that is not the failure mode.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check(
    "the fallback does not parse the plain_text payload",
    !/detail\s*\.\s*text/.test(code) && !/plain_text/.test(code),
    "code still references detail.text or plain_text",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
