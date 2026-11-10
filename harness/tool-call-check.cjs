/**
 * Offline assertions for the DSH tool-row mapping.
 *
 * The mapping decides *what* the timeline shows (icon, command, path, diff,
 * output). A wrong mapping is silent in the UI: a missing command or a generic
 * icon just looks like a different tool call. So the checks live at the data
 * layer, matching this repo's rule that the UI is not a trustworthy oracle.
 *
 * Two head-line rules are pinned here because the UI cannot show either one as
 * wrong: a `plain_text` row's `label` and `text` are *not* interchangeable (an
 * empty label is a value — a `/compact` with no arguments — and the old
 * `|| text` fallback turned its output into the summary), and the head's
 * `summary` is dropped when it repeats `label`, because `label · summary` would
 * otherwise print the same sentence twice (`/compact · /compact`,
 * 「更新任务清单 · 更新任务清单」).
 *
 * Run (from paseo-plugin):
 *   npx tsc client/tool-call-data.ts client/tokens.ts client/paseo-mark.ts \
 *     --outDir .dbg --rootDir . --module node16 --moduleResolution node16 \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/tool-call-check.cjs .dbg/
 *   cd .dbg && node tool-call-check.cjs
 *
 * `--module node16` is required, not cosmetic: `client/tool-call-data.ts` reads
 * the 0.12 `AgentMessage` type from the protocol package's ESM declarations, and
 * node16 is the resolution mode that honours its `exports` map while still
 * emitting CommonJS for this harness to `require`. The source carries the
 * matching `resolution-mode` attribute.
 *
 * Only the pure modules are compiled: the React renderer imports the host
 * runtime, which plain `node` resolution cannot see. `tokens.ts` and
 * `paseo-mark.ts` come along because `diffStat()` and the Paseo-mark fallback
 * are exactly the claims being checked (this script requires both directly, and
 * `tsc` only emits modules it was handed or that are imported transitively).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Locate a repo source file from wherever this check runs. The documented
 * compile step copies the check into `paseo-plugin/.dbg` (one level below
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

const {
  allBlockCopy,
  blockCopy,
  contentLines,
  diffHunks,
  diffOps,
  linkLabel,
  toolCallData,
  toolIcon,
  toolLabel,
  parseTeamResult,
} = require("./client/tool-call-data.js");
const { diffStat } = require("./client/tokens.js");
const { allText, localeText, setLocale } = require("./client/locale.js");
const { labelFor, rosterFromMetadata } = require("./client/team-roster.js");

/**
 * Load a sibling harness module from wherever this check runs.
 *
 * The documented compile step copies this file into `paseo-plugin/.dbg`, where
 * `require("./source-shape.cjs")` would not resolve — the module lives in
 * `harness/`. Walking up finds it whether the check runs in place or from a
 * build dir under `paseo-plugin/`.
 */
function requireHarnessModule(name) {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, "harness", name);
    if (fs.existsSync(candidate)) return require(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find harness/${name} above ${__dirname}`);
}

const {
  attributeOf,
  callArguments,
  codeOnly,
  elementsWithAttributes,
  functionBody,
  mentions,
} = requireHarnessModule("source-shape.cjs");

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
 * The top-level field names of the `dsh-tool` renderer's zod schema.
 *
 * The renderer is a `.tsx` entry point that imports React Native, so it cannot
 * be `require`d under plain node — its schema is read from the source text
 * instead. The scan is brace-depth aware so a nested object field (a future
 * `meta` shape, say) does not leak its own keys into the set.
 */
function bracedBody(source, from) {
  const open = source.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  return "";
}

/** Top-level keys of an object-literal body (a nested bracket run is skipped). */
function objectLiteralKeys(body) {
  const keys = [];
  let nested = 0;
  for (const line of body.split("\n")) {
    const match = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
    if (nested === 0 && match !== null) keys.push(match[1]);
    for (const character of line) {
      if (character === "{" || character === "(" || character === "[") nested += 1;
      else if (character === "}" || character === ")" || character === "]") nested -= 1;
    }
  }
  return keys;
}

function dshToolSchemaKeys(source) {
  const marker = source.indexOf('kind: "dsh-tool"');
  if (marker < 0) return [];
  const at = source.indexOf("z.object(", marker);
  if (at < 0) return [];
  return objectLiteralKeys(bracedBody(source, at));
}

/**
 * The generic card's inner schema: the `fields` object's keys, one entry's keys,
 * and every `z.enum([…])` member list inside it.
 *
 * Read from `index.client.tsx` source for the same reason as the top-level scan
 * (the renderer imports React Native), and compared against the *data layer's
 * runtime shapes*: an inner key or enum member the schema omits is stripped
 * before the row sees it, and nothing errors.
 */
function dshFieldsSchema(source) {
  const marker = source.indexOf('kind: "dsh-tool"');
  if (marker < 0) return undefined;
  // The goal card has its own `fields: z.array(...)` earlier in the same schema,
  // so the generic card is the one declared as an *object* (`fields: z.object(`).
  const at = source.slice(marker).search(/fields:\s*z\s*\.\s*object\(/u);
  if (at < 0) return undefined;
  const fieldsBody = bracedBody(source, marker + at);
  if (fieldsBody === "") return undefined;
  const argsAt = fieldsBody.indexOf("args: z.array(");
  const entryBody = argsAt < 0 ? "" : bracedBody(fieldsBody, argsAt);
  const kinds = [...fieldsBody.matchAll(/z\.enum\(\[([^\]]*)\]\)/gu)].map((match) =>
    match[1]
      .split(",")
      .map((part) => part.trim().replace(/^"|"$/gu, ""))
      .filter((part) => part !== ""),
  );
  return { fields: objectLiteralKeys(fieldsBody), entry: objectLiteralKeys(entryBody), kinds };
}

console.log("icons (must match Paseo's own mapping)");
{
  const cases = [
    ["bash", { type: "shell" }, "SquareTerminal"],
    ["read", { type: "read" }, "Eye"],
    ["edit", { type: "edit" }, "Pencil"],
    ["write", { type: "write" }, "Pencil"],
    ["grep", { type: "search" }, "Search"],
    // DSH draws web_fetch through its own WebRow with IconBrowseOutlineRegular
    // (the read variant's glyph), not the generic search magnifier.
    ["web_fetch", { type: "fetch" }, "Eye"],
    ["subagent", { type: "sub_agent" }, "Bot"],
    ["exit_plan_mode", { type: "plan" }, "Brain"],
    ["mystery", { type: "unknown" }, "Wrench"],
    ["mystery", undefined, "Wrench"],
  ];
  for (const [name, detail, expected] of cases) {
    equal(`${name} -> ${expected}`, toolIcon(name, detail), expected);
  }
  equal(
    "plain_text honours its own icon key",
    toolIcon("todo_write", { type: "plain_text", icon: "sparkles" }),
    "Sparkles",
  );
  equal(
    "plain_text falls back to a wrench",
    toolIcon("todo_write", { type: "plain_text", icon: "not_a_real_icon" }),
    "Wrench",
  );
}

console.log("shell");
{
  const shell = toolCallData(
    { name: "bash", status: "completed", detail: { type: "shell", command: "npm test", output: "ok\nok2" } },
    "complete",
  );
  equal("summary is the command", shell.summary, "npm test");
  equal("body is the output", shell.body, "ok\nok2");
  equal("label", shell.label, "运行命令");
  equal("icon", shell.icon, "SquareTerminal");
  check("not a diff", shell.diff === false);
}

console.log("edit");
{
  const withDiff = toolCallData(
    { name: "edit", status: "completed", detail: { type: "edit", filePath: "/a.ts", unifiedDiff: "@@\n-old\n+new" } },
    "complete",
  );
  equal("summary is the path", withDiff.summary, "/a.ts");
  check("marks a diff", withDiff.diff === true);
  equal("keeps the unified diff", withDiff.body, "@@\n-old\n+new");

  const withoutDiff = toolCallData(
    { name: "edit", status: "completed", detail: { type: "edit", filePath: "/b.ts", oldString: "x", newString: "y" } },
    "complete",
  );
  equal("synthesizes a diff", withoutDiff.body, "- x\n+ y");

  const multiLine = toolCallData(
    { name: "edit", status: "completed", detail: { type: "edit", filePath: "/e.ts", oldString: "a\nb", newString: "c\nd" } },
    "complete",
  );
  equal("prefixes every diff line", multiLine.body, "- a\n- b\n+ c\n+ d");
}

console.log("read and write");
{
  const read = toolCallData(
    { name: "read", status: "completed", detail: { type: "read", filePath: "/c.ts", content: "body" } },
    "complete",
  );
  equal("read summary is the path", read.summary, "/c.ts");
  equal("read body is the content", read.body, "body");

  const write = toolCallData(
    { name: "write", status: "completed", detail: { type: "write", filePath: "/d.ts", content: "x" } },
    "complete",
  );
  equal("write summary is the path", write.summary, "/d.ts");
  check("write is shown as a diff", write.diff === true);
}

console.log("code flag (source-code bodies get a code surface)");
{
  const read = toolCallData({ name: "read", status: "completed", detail: { type: "read", filePath: "/c.ts", content: "x" } }, "complete");
  const edit = toolCallData({ name: "edit", status: "completed", detail: { type: "edit", filePath: "/e.ts", oldString: "a", newString: "b" } }, "complete");
  const search = toolCallData({ name: "grep", status: "completed", detail: { type: "search", query: "q", content: "x" } }, "complete");
  const shell = toolCallData({ name: "bash", status: "completed", detail: { type: "shell", command: "ls", output: "x" } }, "complete");
  const fetch = toolCallData({ name: "web_fetch", status: "completed", detail: { type: "fetch", url: "https://x", result: "y" } }, "complete");
  check("read body is code", read.code === true);
  check("edit body is code", edit.code === true);
  check("search body is code", search.code === true);
  check("shell output is not code", shell.code === false);
  check("fetch response is not code", fetch.code === false);
}

console.log("status");
{
  const failed = toolCallData({ name: "bash", status: "failed", detail: { type: "shell", command: "x" } }, "complete");
  check("failure is flagged", failed.failed === true);
  equal("failure status kept", failed.status, "failed");

  const weird = toolCallData({ name: "bash", status: "mystery", detail: { type: "shell", command: "x" } }, "complete");
  equal("unknown status falls back to completed", weird.status, "completed");
}

console.log("a failure carries its reason");
{
  // The daemon puts `error: { message }` on a failed tool_call
  // (`server/timeline.ts`). It is the *only* copy of the reason for a tool whose
  // detail carries what was requested instead of what went wrong (write/edit),
  // and for a tool whose output was empty. The mapper used to accept `error`
  // and never read it, so every failure was just a red icon: the block below
  // showed the planned write, or nothing at all.
  const reason = "AUDIT_ERROR_PERMISSION_DENIED";
  const failedWrite = toolCallData(
    {
      name: "write",
      status: "failed",
      detail: { type: "write", filePath: "/x.txt", content: "REQUESTED" },
      error: { message: reason },
    },
    "complete",
  );
  equal("a failed write keeps its reason", failedWrite.error, reason);
  equal("…while the block still shows what was requested", failedWrite.body, "REQUESTED");
  check("…and the row now has something to expand", failedWrite.hasDetail === true);

  const failedEdit = toolCallData(
    {
      name: "edit",
      status: "failed",
      detail: { type: "edit", filePath: "/x.ts", oldString: "a", newString: "b" },
      error: { message: reason },
    },
    "complete",
  );
  equal("a failed edit keeps its reason", failedEdit.error, reason);

  const refused = "connect ECONNREFUSED 127.0.0.1:9";
  const failedMcp = toolCallData(
    {
      name: "mcp__paseo__list_hosts",
      status: "failed",
      detail: { type: "unknown", input: {} },
      error: { message: refused },
    },
    "complete",
  );
  equal("a failed MCP call keeps its reason", failedMcp.error, refused);
  equal("…even with no output half of its own", failedMcp.body, "");
  check(
    "…so the reason is the only content the expansion has",
    failedMcp.hasDetail === true,
  );

  const failedShell = toolCallData(
    {
      name: "bash",
      status: "failed",
      detail: { type: "shell", command: "false", output: "line one\nline two" },
      error: { message: "line one\nline two" },
    },
    "complete",
  );
  equal("a failed shell's reason is its output", failedShell.error, "line one\nline two");
  check(
    "multi-line reasons are kept whole",
    // `?? ""` keeps the check reporting a missing field instead of throwing
    // one: a crashed harness hides every assertion after it.
    (failedShell.error ?? "").split("\n").length === 2,
    JSON.stringify(failedShell.error),
  );

  const success = toolCallData(
    { name: "mcp__paseo__list_hosts", status: "completed", detail: { type: "unknown", input: {} }, error: null },
    "complete",
  );
  equal("a successful row has no reason", success.error, "");
  check("…and gains no expansion for one", success.hasDetail === false);

  const dirty = toolCallData(
    {
      name: "bash",
      status: "completed",
      detail: { type: "shell", command: "x", output: "" },
      error: { message: "SHOULD_NOT_BE_READ" },
    },
    "complete",
  );
  equal("an error on a non-failed row is ignored", dirty.error, "");

  // The reason lives on the top-level item, never in `detail`: reading it out of
  // the payload would invent a carrier the protocol does not define.
  const detailCarrier = toolCallData(
    {
      name: "write",
      status: "completed",
      detail: { type: "write", filePath: "/x.txt", content: "REQUESTED", error: { message: "WRONG_CARRIER" } },
    },
    "complete",
  );
  equal("the detail is not an error carrier", detailCarrier.error, "");

  // Unreadable shapes fail closed — no made-up reason, no crash.
  const malformed = [
    ["a plain string", "just a message"],
    ["a message that is not a string", { message: 42 }],
    ["an empty object", {}],
    ["null", null],
  ];
  for (const [shape, error] of malformed) {
    const row = toolCallData(
      { name: "bash", status: "failed", detail: { type: "shell", command: "x" }, error },
      "complete",
    );
    equal(`an unreadable error (${shape}) yields no reason`, row.error, "");
  }
}

console.log("limits");
{
  // DSH's TerminalBlock renders the whole output inside a 224px scroll window
  // and copies the whole of it, so the terminal body must not be cut: the tail
  // of a build log is usually where the failure is, and a cap would also
  // shorten what the copy control hands the user.
  const output = "y".repeat(7000);
  const huge = toolCallData(
    { name: "bash", status: "completed", detail: { type: "shell", command: "x", output } },
    "complete",
  );
  equal("the terminal body is the whole output", huge.body, output);
  check(
    "…without a truncation marker",
    !huge.body.includes(localeText().truncated),
    huge.body.slice(-20),
  );

  // CT-01: the generic code surface renders its body inside DSH's 260px
  // `.bodyScroll` window and copies the whole of it, so it must not be capped
  // either. These are the cases the audit measured — an MCP `unknown` call and
  // the read/fetch/plan/plain_text/sub_agent rows whose `presentationMeta` did
  // not parse — plus an agent message, which is the same surface.
  const marker = localeText().truncated;
  const genericCases = [
    [
      "MCP unknown",
      { name: "mcp__x__y", status: "completed", detail: { type: "unknown", input: {}, output: "z".repeat(7000) } },
    ],
    [
      "read without meta",
      { name: "read", status: "completed", detail: { type: "read", filePath: "/a.ts", content: "r".repeat(7000) } },
    ],
    [
      "fetch without meta",
      { name: "web_fetch", status: "completed", detail: { type: "fetch", url: "https://x", result: "f".repeat(7000) } },
    ],
    [
      "plan",
      { name: "update_plan", status: "completed", detail: { type: "plan", text: "p".repeat(7000) } },
    ],
    [
      "plain_text",
      { name: "x", status: "completed", detail: { type: "plain_text", label: "run", text: "t".repeat(7000) } },
    ],
    [
      "sub_agent log",
      { name: "subagent", status: "completed", detail: { type: "sub_agent", log: "s".repeat(7000) } },
    ],
    [
      "agent message",
      {
        name: "agent_message",
        status: "completed",
        detail: { type: "plain_text", label: "", text: "" },
        agentMessage: { event: "finished", sender: { id: "a" }, text: "m".repeat(7000) },
      },
    ],
  ];
  for (const [label, item] of genericCases) {
    const row = toolCallData(item, "complete");
    equal(`the generic body is whole (${label})`, row.body.length, 7000);
    check(`…and carries no truncation marker (${label})`, !row.body.includes(marker));
  }

  // The one body still capped is the legacy plain-text diff fallback: that card
  // draws one row per line with no scroll region and no copy control, so an
  // uncapped body would mount an unbounded row tree. It must not split an
  // astral character in half either (a lone high surrogate renders as `�`).
  const legacy = toolCallData(
    { name: "write", status: "completed", detail: { type: "write", filePath: "/x.ts", content: "z".repeat(7000) } },
    "complete",
  );
  equal("the legacy diff fallback is still capped", legacy.body, `${"z".repeat(6000)}${marker}`);

  const straddled = `${"a".repeat(5999)}\u{1F600}tail`;
  const cut = toolCallData(
    { name: "write", status: "completed", detail: { type: "write", filePath: "/x.ts", content: straddled } },
    "complete",
  );
  equal(
    "a cut inside a surrogate pair steps back to the pair boundary",
    cut.body,
    `${"a".repeat(5999)}${marker}`,
  );
  check("…so no lone surrogate is left in the body", !/[\uD800-\uDBFF]/.test(cut.body));

  // The control: a pair that ends exactly at the cut is kept whole.
  const aligned = `${"a".repeat(5998)}\u{1F600}tail`;
  const kept = toolCallData(
    { name: "write", status: "completed", detail: { type: "write", filePath: "/x.ts", content: aligned } },
    "complete",
  );
  equal(
    "a pair that lands on the boundary is kept",
    kept.body,
    `${"a".repeat(5998)}\u{1F600}${marker}`,
  );
}

console.log("labels");
{
  equal("known tool label", toolLabel("bash"), "运行命令");
  equal("unknown tool keeps its name", toolLabel("frobnicate"), "frobnicate");
}

console.log("the description is the row's label");
{
  // DSH's bash tool requires a model-written `description` on every call and its
  // own UI titles the row with it ("List DSH checkout root"), not with the
  // command. The plugin carries it on the item's provider metadata because the
  // `shell` detail has no field for it.
  const described = toolCallData(
    {
      name: "bash",
      status: "completed",
      detail: { type: "shell", command: "pwd; ls -d /tmp", output: "/tmp" },
      metadata: { description: "List DSH checkout root" },
    },
    "complete",
  );
  equal("the description is the label", described.summary, "List DSH checkout root");
  equal("the command moves to the expanded headline", described.headline, "pwd; ls -d /tmp");
  equal("the output is still the body", described.body, "/tmp");

  const plain = toolCallData(
    { name: "bash", status: "completed", detail: { type: "shell", command: "pwd", output: "/tmp" } },
    "complete",
  );
  equal("without a description the command is the label", plain.summary, "pwd");
  // The head is always one line, so the command itself lives in the block —
  // that is where a multi-line command becomes readable.
  equal("and the block leads with the command", plain.headline, "pwd");
  equal(
    "even when the head is showing a description instead",
    described.headline,
    "pwd; ls -d /tmp",
  );

  const empty = toolCallData(
    {
      name: "bash",
      status: "completed",
      detail: { type: "shell", command: "pwd", output: "" },
      metadata: { description: "" },
    },
    "complete",
  );
  equal("an empty description is ignored", empty.summary, "pwd");
}

console.log("provider-native tools (every MCP call)");
{
  // Paseo has no detail shape for these, so the row owns both halves. Without
  // the output an expanded row showed exactly what it already showed collapsed
  // — which reads as "this row will not expand".
  const mcp = toolCallData(
    {
      name: "mcp__paseo__create_heartbeat",
      status: "completed",
      detail: {
        type: "unknown",
        input: { cron: "* * * *", maxRuns: 2 },
        output: { id: "abc", status: "active" },
      },
    },
    "complete",
  );
  equal("the head names the call with its first short argument", mcp.summary, "cron: * * * *");
  // L1: the payload is split into card entries instead of one pretty-printed
  // blob, and the structured result moves out of the body — the card is its
  // rendering. The copy control keeps the complete JSON, so nothing is lost.
  equal("the arguments become card entries, in payload order", mcp.fields.args, [
    { kind: "fact", label: "cron", value: "* * * *" },
    { kind: "fact", label: "maxRuns", value: "2" },
  ]);
  equal("a structured result becomes card entries too", mcp.fields.result, [
    { kind: "fact", label: "id", value: "abc" },
    { kind: "fact", label: "status", value: "active" },
  ]);
  equal("…and leaves the body", mcp.body, "");
  equal(
    "…while the copy control keeps the complete result JSON",
    mcp.fields.copyText,
    '{\n  "id": "abc",\n  "status": "active"\n}',
  );
  equal("the block has no separate lead (the card carries the arguments)", mcp.headline, "");
  equal("and rendered as code", mcp.code, true);
  equal("the row still expands", mcp.hasDetail, true);

  const text = toolCallData(
    {
      name: "mcp__paseo__browser_list_tabs",
      status: "completed",
      detail: { type: "unknown", input: {}, output: "No Paseo browser tabs are open." },
    },
    "complete",
  );
  equal("a string result is kept verbatim", text.body, "No Paseo browser tabs are open.");
  equal("an argument-less call is labelled by its tool name alone", text.summary, "");
  equal("…and draws no generic card (nothing to split)", text.fields, null);

  const silent = toolCallData(
    { name: "mcp__x__y", status: "running", detail: { type: "unknown", input: { a: 1 } } },
    "streaming",
  );
  equal("a running call has no body yet", silent.body, "");
  // A number is not a short *string*, so it never becomes the head's summary;
  // the card still carries it.
  equal("its title is left to the tool name", silent.summary, "");
  equal("and its block already has the arguments", silent.fields.args, [
    { kind: "fact", label: "a", value: "1" },
  ]);
  equal("so it has something to reveal", silent.hasDetail, true);

  // A description on an MCP call still titles the row; the block now carries the
  // arguments as entries rather than as a second, pretty-printed copy.
  const described = toolCallData(
    {
      name: "mcp__x__y",
      status: "completed",
      detail: { type: "unknown", input: { description: "Do the thing", a: 1 }, output: "ok" },
      metadata: { description: "Do the thing" },
    },
    "complete",
  );
  equal("the title is the description", described.summary, "Do the thing");
  equal("the block carries the arguments as entries", described.fields.args, [
    { kind: "fact", label: "description", value: "Do the thing" },
    { kind: "fact", label: "a", value: "1" },
  ]);
  equal("…and no pretty-printed lead above them", described.headline, "");

  const arrayInput = toolCallData(
    { name: "mcp__x__z", status: "completed", detail: { type: "unknown", input: [1, 2], output: "" } },
    "complete",
  );
  equal("an array argument is kept, as one unlabelled JSON entry", arrayInput.fields.args, [
    { kind: "json", label: "", value: "[\n  1,\n  2\n]" },
  ]);
  equal("…and names no summary (it has no string field)", arrayInput.summary, "");

  const cyclic = {};
  cyclic.self = cyclic;
  const broken = toolCallData(
    { name: "mcp__x__w", status: "completed", detail: { type: "unknown", input: cyclic } },
    "complete",
  );
  equal("an unserializable payload is reported, not swallowed", broken.fields.args, [
    { kind: "json", label: "self", value: "<unserializable>" },
  ]);
}

console.log("rows without a detail shape: the generic fields card (L1)");
{
  const row = (name, input, output, extra = {}) =>
    toolCallData(
      { name, status: "completed", detail: { type: "unknown", input, output }, error: null, ...extra },
      "complete",
    );

  // A long multi-line string (`send_message`'s `message`) keeps its real
  // newlines: the old rendering pretty-printed the *enclosing* object, so every
  // newline inside the value arrived as a literal backslash-n and the message
  // was one escaped wall of text on a phone.
  const message = "第一行\n第二行\n\n第四行";
  const sent = row("mcp__paseo__send_agent_prompt", { to: "lead", message }, "Message sent.");
  equal("a multi-line value becomes a text entry", sent.fields.args, [
    { kind: "fact", label: "to", value: "lead" },
    { kind: "text", label: "message", value: message },
  ]);
  const text = sent.fields.args.find((entry) => entry.label === "message");
  check("…with real newlines", text !== undefined && text.value.split("\n").length === 4);
  check(
    "…and no literal backslash-n left in it",
    text !== undefined && !text.value.includes("\\n"),
    JSON.stringify(text?.value),
  );
  equal("…and the plain-text result stays the body, verbatim", sent.body, "Message sent.");

  // Short scalars pack into facts rows, one per value, in the payload's order.
  // An empty string is a value here too — the tool was called with it.
  const scalars = row("mcp__x__scalars", { name: "x", count: 2, ready: true, note: "" }, "");
  equal("short scalars become facts, in payload order", scalars.fields.args, [
    { kind: "fact", label: "name", value: "x" },
    { kind: "fact", label: "count", value: "2" },
    { kind: "fact", label: "ready", value: "true" },
    { kind: "fact", label: "note", value: "" },
  ]);

  // A value that is itself a structure keeps the JSON code surface.
  const nested = row("mcp__x__nested", { where: { a: 1, b: [2] } }, "");
  equal("a nested object becomes a JSON entry", nested.fields.args, [
    { kind: "json", label: "where", value: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}' },
  ]);

  // The head is the first short single-line string argument as `key: value`; the
  // whole JSON blob never reaches the one-line head again.
  const summary = row("mcp__x__summary", { count: 1, to: "lead", message }, "");
  equal("the summary is the first short string argument", summary.summary, "to: lead");
  check("…with no JSON in it", !summary.summary.includes("{"), summary.summary);
  const argumentless = row("mcp__x__none", {}, "ok");
  equal("an argument-less call has no summary of its own", argumentless.summary, "");
  equal("…and draws no generic card", argumentless.fields, null);

  // A tool with its own card keeps that card's documented fallback: a result the
  // parser rejects stays verbatim in the body, and only the arguments become
  // entries (the head no longer prints the argument JSON).
  const unreadable = JSON.stringify({ goal: { id: "g", phase: "archived" } });
  const goalFallback = row("get_goal", { action: "get" }, unreadable);
  equal("a goal result the card cannot read keeps its body", goalFallback.body, unreadable);
  check(
    "…and only its arguments become entries",
    goalFallback.fields !== null &&
      goalFallback.fields.args.length === 1 &&
      goalFallback.fields.result.length === 0,
    JSON.stringify(goalFallback.fields),
  );

  // A result that is a JSON *string* is parsed and split like an object result;
  // the copy control still carries the original string, byte for byte.
  const jsonOutput = '{"status":"active","count":2}';
  const parsed = row("mcp__x__json", {}, jsonOutput);
  equal("a JSON-string result is split into entries", parsed.fields.result, [
    { kind: "fact", label: "status", value: "active" },
    { kind: "fact", label: "count", value: "2" },
  ]);
  equal("…the body no longer holds the JSON", parsed.body, "");
  equal("…and the copy text is the original string", parsed.fields.copyText, jsonOutput);
  // A string that does not parse (or parses to a scalar) stays plain text: only
  // a structure is worth a card.
  const unparseable = row("mcp__x__text", {}, "not json {");
  equal("a result that is not JSON keeps the plain body", unparseable.body, "not json {");
  equal("…and offers no card of its own", unparseable.fields, null);
  const scalarOutput = row("mcp__x__scalar", {}, "42");
  equal("a scalar-looking result stays text", scalarOutput.body, "42");
  equal("…and is not a card", scalarOutput.fields, null);

  // The structured cards keep their priority: when one parses, no generic card.
  const goalRow = row("get_goal", {}, JSON.stringify({ goal: null, activation: "armed" }));
  check("the goal card wins over the generic card", goalRow.goal !== null && goalRow.fields === null);
  const teamRow = row("team_task_list", {}, JSON.stringify({ tasks: [] }));
  check("the team card wins too", teamRow.team !== null && teamRow.fields === null);
  const messageRow = toolCallData(
    {
      name: "agent_message",
      status: "completed",
      detail: { type: "plain_text", label: "", text: "hi" },
      agentMessage: { event: "message", sender: { id: "a" }, text: "hi" },
    },
    "complete",
  );
  check("an agent message stays prose (no generic card)", messageRow.fields === null);

  // A failed call still shows what it was asked to do; its result is the error
  // text in the body, exactly as before.
  const failedRow = toolCallData(
    {
      name: "mcp__x__fail",
      status: "failed",
      detail: { type: "unknown", input: { to: "lead" }, output: "boom" },
      error: { message: "boom" },
    },
    "complete",
  );
  check(
    "a failed call keeps its arguments as entries",
    failedRow.fields !== null && failedRow.fields.args[0].label === "to",
    JSON.stringify(failedRow.fields?.args ?? null),
  );
  equal("…and its error text as the body", failedRow.body, "boom");
}

console.log("high-frequency tools get their own cards (L2)");
{
  setLocale("zh-CN");
  const row = (name, input, output, extra = {}) =>
    toolCallData(
      { name, status: "completed", detail: { type: "unknown", input, output }, error: null, ...extra },
      "complete",
    );
  const failedRow = (name, input, output, message) =>
    toolCallData(
      { name, status: "failed", detail: { type: "unknown", input, output }, error: { message } },
      "complete",
    );

  // --- send_message: one name, two implementations (survey §5) --------------
  // Fixture from the survey's real samples (`stats-detail-top.txt`), de-identified.
  const teamSend = row(
    "send_message",
    { target: "ban-mechanism-researcher", message: "进度催收：已过约 20 分钟。请**立即收口**…\n\n优先只要这三条…" },
    '{"sent":true}',
  );
  equal("send_message (team): the head is the recipient", teamSend.summary, "ban-mechanism-researcher");
  equal("…the message is a prose entry, newlines intact", teamSend.fields.args, [
    { kind: "text", label: "消息", value: "进度催收：已过约 20 分钟。请**立即收口**…\n\n优先只要这三条…" },
  ]);
  equal("…the JSON result becomes a receipt, not entries", teamSend.fields.receipt, "已发送");
  equal("…with no result entries left", teamSend.fields.result, []);
  equal("…and no body repeating it", teamSend.body, "");
  equal("…while the copy control keeps the original output", teamSend.fields.copyText, '{"sent":true}');

  // F8: an empty message is a value, not a paragraph — no empty text entry.
  const emptyMessage = row("send_message", { target: "lead", message: "" }, '{"sent":true}');
  equal("send_message: an empty message draws no empty entry", emptyMessage.fields.args, []);
  equal("…the receipt still answers", emptyMessage.fields.receipt, "已发送");

  const oldSend = row(
    "send_message",
    { target: "lead", message: "x" },
    '{"messageId":"team-message-eb227a23","status":"queued"}',
  );
  equal("send_message (old team shape): the status joins the receipt", oldSend.fields.receipt, "已发送 · queued");

  const subSend = row(
    "send_message",
    { agent_id: "851a7c1e-e899-4a4e-9b3f-000000000000", message: "steer" },
    "message delivered to agent 851a7c1e-e899-4a4e-9b3f-000000000000",
  );
  equal("send_message (subagent-control): the head is the agent id", subSend.summary, "851a7c1e-e899-4a4e-9b3f-000000000000");
  equal("…its rendered sentence is the receipt", subSend.fields.receipt, "已投递");
  equal("…the sentence does not stay in the body", subSend.body, "");
  equal("…and the copy control keeps it", subSend.fields.copyText, "message delivered to agent 851a7c1e-e899-4a4e-9b3f-000000000000");

  // A result neither implementation documents falls back to L1 — no guessing.
  const oddSend = row("send_message", { target: "lead", message: "x" }, "not json");
  equal("send_message: an undocumented result keeps L1's summary", oddSend.summary, "target: lead");
  equal("…L1's body", oddSend.body, "not json");
  equal("…and no receipt is invented", oddSend.fields.receipt, "");

  // --- interrupt_agent: the same two implementations ------------------------
  const teamInterrupt = row("interrupt_agent", { target: "ban-mechanism-researcher" }, '{"previousStatus":"running"}');
  equal("interrupt_agent (team): the head is the target", teamInterrupt.summary, "ban-mechanism-researcher");
  equal("…the receipt quotes the status it replaced", teamInterrupt.fields.receipt, "已中断（原 running）");
  equal("…and the copy control keeps the output", teamInterrupt.fields.copyText, '{"previousStatus":"running"}');
  const subInterrupt = row("interrupt_agent", { agent_id: "abc-123" }, "interrupt requested for agent abc-123");
  equal("interrupt_agent (subagent-control): receipt", subInterrupt.fields.receipt, "已请求中断");
  equal("…the head is the agent id", subInterrupt.summary, "abc-123");
  const oddInterrupt = row("interrupt_agent", { target: "x" }, "done");
  equal("interrupt_agent: an undocumented result keeps L1", oddInterrupt.summary, "target: x");
  equal("…and no receipt", oddInterrupt.fields.receipt, "");

  // --- team roster: per-item metadata, never process state ------------------
  // The zero state must be the old output, field for field: no roster on the
  // item means the wire target exactly as before this card existed.
  equal("roster: an unknown target stays the target", labelFor(undefined, "roster-never-seen"), "roster-never-seen");
  equal("roster: an empty target is never rendered blank", labelFor(undefined, ""), "—");

  // Two items naming the same target with different rosters: the old global
  // `Map` could leak A's description into B (two sessions, one member name).
  // Each item now carries its own, and nothing is shared between rows.
  const rosterA = { metadata: { teamRoster: { "roster-member": "审查支付" } } };
  const rosterB = { metadata: { teamRoster: { "roster-member": "审查结算" } } };
  const sendA = row("send_message", { target: "roster-member", message: "x" }, '{"sent":true}', rosterA);
  equal("send_message: item A's roster names its own member", sendA.summary, "审查支付");
  const sendB = row("send_message", { target: "roster-member", message: "x" }, '{"sent":true}', rosterB);
  equal("send_message: item B's roster is not contaminated by item A", sendB.summary, "审查结算");
  const noRoster = row("send_message", { target: "roster-member", message: "x" }, '{"sent":true}');
  equal("send_message: an item with no roster falls back to the target", noRoster.summary, "roster-member");

  const rosterInterrupt = row("interrupt_agent", { target: "roster-member" }, '{"previousStatus":"running"}', rosterA);
  equal("interrupt_agent: the item's roster names the head", rosterInterrupt.summary, "审查支付");

  // The reopen case this design exists for: the item carries the roster, and
  // the rendered range has no preceding `spawn_teammate` / `list_agents` row.
  const reopened = row("send_message", { target: "roster-reopened", message: "m" }, '{"sent":true}', {
    metadata: { teamRoster: { "roster-reopened": "重开会话后的成员" } },
  });
  equal("reopen: a roster-bearing item labels without any spawn/list row", reopened.summary, "重开会话后的成员");

  // Empty/whitespace descriptions are not labels, and one dirty entry must not
  // throw away the well-formed entries beside it.
  check(
    "roster: a malformed metadata value yields no roster",
    rosterFromMetadata({ teamRoster: { "roster-empty": "   ", "roster-bad": 3 } }) === undefined,
    JSON.stringify(rosterFromMetadata({ teamRoster: { "roster-empty": "   ", "roster-bad": 3 } })),
  );
  equal(
    "roster: whitespace falls back to the target",
    labelFor(rosterFromMetadata({ teamRoster: { "roster-empty": "   " } }), "roster-empty"),
    "roster-empty",
  );
  const shallowRoster = rosterFromMetadata({ teamRoster: { "roster-ok": "有效说明", "roster-empty": "" } });
  equal("roster: a dirty sibling does not discard a valid entry", labelFor(shallowRoster, "roster-ok"), "有效说明");

  // No write path remains: a spawn row names its own subject, but a later item
  // with no roster metadata must still render the target.
  const rosterSpawn = row(
    "spawn_teammate",
    { name: "roster-spawned", prompt: "p", description: "被生成的成员" },
    '{"member":{"target":"roster-spawned","role":"teammate","status":"running"}}',
  );
  equal("spawn_teammate: its own row keeps the description subject", rosterSpawn.summary, "被生成的成员");
  equal(
    "send_message: no spawn row leaks a roster into a later item",
    row("send_message", { target: "roster-spawned", message: "m" }, '{"sent":true}').summary,
    "roster-spawned",
  );

  // --- spawn_teammate -------------------------------------------------------
  const spawn = row(
    "spawn_teammate",
    {
      description: "terminal 输出区无卡壳变体",
      name: "terminal-bare",
      context: "fork",
      prompt: "你是 paseo-dsh 仓库的实现队友…\n\n工作区：<workspace>",
    },
    '{"member":{"target":"policy-researcher","role":"teammate","status":"running","description":"取证 Anthropic 官方支持地区与使用政策原文","provider":"spawn","context":"fresh","model":"deepseek-flash","diagnostics":[]}}',
  );
  equal("spawn_teammate: the head is the description, fork marked", spawn.summary, "terminal 输出区无卡壳变体 · 继承上下文");
  equal("…description is a fact (localized label) and the prompt prose", spawn.fields.args, [
    { kind: "fact", label: "说明", value: "terminal 输出区无卡壳变体" },
    { kind: "text", label: "提示词", value: "你是 paseo-dsh 仓库的实现队友…\n\n工作区：<workspace>" },
  ]);
  equal("…the member's status and model make the receipt", spawn.fields.receipt, "已创建 · running · deepseek-flash");
  const freshSpawn = row(
    "spawn_teammate",
    { name: "x", prompt: "p", context: "fresh" },
    '{"member":{"target":"x","role":"teammate","status":"provisioning"}}',
  );
  equal("spawn_teammate: fresh is not marked", freshSpawn.summary, "x");
  equal("…a member without a model keeps a two-part receipt", freshSpawn.fields.receipt, "已创建 · provisioning");
  const oddSpawn = row("spawn_teammate", { name: "x", prompt: "p" }, '{"member":{"target":"x"}}');
  equal("spawn_teammate: a member without a status falls back to L1", oddSpawn.fields.receipt, "");
  check(
    "…keeping L1's argument entries",
    oddSpawn.fields.args.some((entry) => entry.label === "name"),
    JSON.stringify(oddSpawn.fields.args),
  );

  // F4: a mapped card's summary wins over the generic `description` rule (a
  // bash row is titled by the model's description; a mapped row already named
  // its subject). Both rows carry `metadata.description`, as the server does.
  // `spawn_teammate` deliberately maps its subject to the description (the
  // localized, reader-facing half) and keeps the name as the fallback.
  const describedSpawn = row(
    "spawn_teammate",
    { name: "terminal-bare", prompt: "p", description: "terminal 输出区无卡壳变体" },
    '{"member":{"target":"x","role":"teammate","status":"running"}}',
    { metadata: { description: "terminal 输出区无卡壳变体" } },
  );
  equal("a mapped summary beats metadata.description", describedSpawn.summary, "terminal 输出区无卡壳变体");
  // `run_code`'s mapping summary is the input's own description, which the server
  // also copies into metadata; the values are made to differ here only so the
  // priority itself is observable (a real call sends the same string twice).
  const describedCode = row(
    "run_code",
    { code: "x", description: "查找来源" },
    "out",
    { metadata: { description: "另一个描述" } },
  );
  equal("run_code: the mapped description wins over metadata.description", describedCode.summary, "查找来源");

  // --- wait_agent -----------------------------------------------------------
  const waited = row("wait_agent", { timeout_ms: 180000 }, '{"timedOut":true}');
  equal("wait_agent: the head is the duration", waited.summary, "3 分钟");
  equal("…the receipt says how it ended", waited.fields.receipt, "超时");
  const progressed = row("wait_agent", { timeout_ms: 90000 }, '{"timedOut":false}');
  equal("wait_agent: 90s stays seconds", progressed.summary, "90 秒");
  equal("…and the other outcome", progressed.fields.receipt, "有变化");
  equal("wait_agent: the default is DSH's 30s", row("wait_agent", {}, '{"timedOut":false}').summary, "30 秒");
  const stalled = row(
    "wait_agent",
    { timeout_ms: 30000 },
    '{"timedOut":true,"noProgress":{"reason":"no-active-peer","message":"No other Team member is running or provisioning."}}',
  );
  equal("wait_agent: the known reason is translated into the receipt", stalled.fields.receipt, "超时 · 无可等待的成员");
  equal("…and its message is prose", stalled.fields.result, [
    { kind: "text", label: "", value: "No other Team member is running or provisioning." },
  ]);
  const oddReason = row(
    "wait_agent",
    { timeout_ms: 30000 },
    '{"timedOut":false,"noProgress":{"reason":"new-reason","message":"m"}}',
  );
  equal("wait_agent: an unknown reason stays verbatim", oddReason.fields.receipt, "有变化 · new-reason");
  const oddWait = row("wait_agent", { timeout_ms: 180000 }, "not json");
  // L1 only summarizes short *strings*, and this call's only argument is a
  // number — so the fallback head is the label alone, and the body keeps the text.
  equal("wait_agent: a result that is not the documented shape keeps L1", oddWait.summary, "");
  equal("…with the raw text as body", oddWait.body, "not json");
  equal("…and no receipt", oddWait.fields.receipt, "");

  // --- list_agents ----------------------------------------------------------
  const membersJson = JSON.stringify([
    { target: "lead", role: "lead", status: "running", model: "deepseek-flash", diagnostics: [] },
    { target: "reviewer", role: "teammate", status: "inactive", description: "只读审查", diagnostics: [] },
  ]);
  const list = row("list_agents", {}, membersJson);
  equal("list_agents: the Lead is not counted", list.summary, "1 名成员");
  equal("…one prose line per member, the Lead's role not repeated", list.fields.result, [
    { kind: "text", label: "", value: "lead · running\nreviewer · teammate · inactive · 只读审查" },
  ]);
  // Counted on `role === "teammate"` (the team pill's rule): a role DSH adds
  // later is listed but is not a teammate, and must not be counted as one.
  const otherRole = row(
    "list_agents",
    {},
    JSON.stringify([
      { target: "lead", role: "lead", status: "running", diagnostics: [] },
      { target: "observer", role: "observer", status: "running", diagnostics: [] },
    ]),
  );
  equal("list_agents: a role that is not a teammate is not counted", otherRole.summary, "仅主会话");
  equal(
    "…but it is still listed",
    otherRole.fields.result[0].value,
    "lead · running\nobserver · running",
  );
  equal("…and the copy control keeps the whole array", list.fields.copyText, membersJson);
  const leadOnly = row("list_agents", {}, JSON.stringify([{ target: "lead", role: "lead", status: "running", diagnostics: [] }]));
  equal("list_agents: only the Lead reads as such", leadOnly.summary, "仅主会话");
  equal("…and its row names it once", leadOnly.fields.result[0].value, "lead · running");
  const emptyList = row("list_agents", {}, "[]");
  equal("list_agents: an empty array reads 无成员", emptyList.summary, "无成员");
  equal("…and draws no card", emptyList.fields, null);
  const legacyList = row("list_agents", {}, "(no subagents)");
  equal("list_agents: the old plain text stays L1's body", legacyList.body, "(no subagents)");
  equal("…with no member lines", legacyList.fields, null);

  // --- job_output / job_kill ------------------------------------------------
  const jobOut = row(
    "job_output",
    { job_id: "bash-3eeee62adb424e3b", timeout_ms: 420000, wait: true },
    "=== 1. 阿里云内网源（杭州同区）===\naliyun-mirror: 0 B/s  size=0\n[status: completed, exit code: 0]",
  );
  equal("job_output: the head is the job id without a task title", jobOut.summary, "bash-3eeee62adb424e3b");
  // F1/F8: the call's own knobs stay visible — they explain the log below, and
  // the keys are words a reader can parse, not DSH's wire names.
  equal("…the wait knobs are kept as facts", jobOut.fields.args, [
    { kind: "fact", label: "等待", value: "true" },
    { kind: "fact", label: "超时（毫秒）", value: "420000" },
  ]);
  equal("…the status line is the receipt", jobOut.fields.receipt, "已完成 · 退出码 0");
  equal("…the log stays the body, status line stripped", jobOut.body, "=== 1. 阿里云内网源（杭州同区）===\naliyun-mirror: 0 B/s  size=0");
  equal(
    "…and the copy control keeps the whole output",
    jobOut.fields.copyText,
    "=== 1. 阿里云内网源（杭州同区）===\naliyun-mirror: 0 B/s  size=0\n[status: completed, exit code: 0]",
  );
  equal("job_output: a running job reads 运行中", row("job_output", { job_id: "bash-5" }, "(no new output)\n[status: running]").fields.receipt, "运行中");
  equal("job_output: an unknown detail stays verbatim", row("job_output", { job_id: "bash-6" }, "log\n[status: failed, max-tokens]").fields.receipt, "失败 · max-tokens");
  // The status line is a receipt, not a precondition for the card: a log that
  // simply stops (a corrupt ring, an older tool shape) still draws it, and the
  // head is the job id — never DSH's `job_id: ` wire key in the reader's face.
  const oddJob = row("job_output", { job_id: "bash-7" }, "no status line");
  equal("job_output: a log without the status line keeps the card", oddJob.summary, "bash-7");
  check("…and never the wire key", !oddJob.summary.startsWith("job_id: "));
  // Nothing to mount: no title, no knobs, no receipt — the head is the id and
  // the log is the body, so an empty card would be the same row twice.
  equal("…with no card to mount", oddJob.fields, null);
  equal("…and the whole log as body", oddJob.body, "no status line");

  // B: the background job's own one-line description is the row's title, and
  // the id moves into the card (the bridge resolves it from DSH's registry).
  const titledJob = row(
    "job_output",
    { job_id: "bash-9", timeout_ms: 420000, wait: true },
    "log\n[status: running]",
    { metadata: { jobTitle: "查看构建是否已开跑" } },
  );
  equal("job_output: the task's own words title the head", titledJob.summary, "查看构建是否已开跑");
  equal("…the job id moves into the card first", titledJob.fields.args[0], { kind: "fact", label: "编号", value: "bash-9" });
  equal("…then the knobs in words", titledJob.fields.args.slice(1), [
    { kind: "fact", label: "等待", value: "true" },
    { kind: "fact", label: "超时（毫秒）", value: "420000" },
  ]);
  // P2-1: a failed read is the most common shape after a plugin reload — the
  // job the row names no longer exists — and it used to fall to the generic card,
  // which printed DSH's wire keys (`job_id: bash-7`). A failure still gets the
  // Chinese labels, but never a success receipt.
  const failedJob = toolCallData(
    {
      name: "job_output",
      status: "failed",
      detail: { type: "unknown", input: { job_id: "bash-12", wait: true }, output: "Error: job bash-12 not found" },
      error: { message: "Error: job bash-12 not found" },
    },
    "complete",
  );
  equal("job_output: a failed read keeps the bare id as its head", failedJob.summary, "bash-12");
  check("…never the wire key", !failedJob.summary.startsWith("job_id: "));
  equal("…its knobs still read in Chinese", failedJob.fields.args, [{ kind: "fact", label: "等待", value: "true" }]);
  equal("…no success receipt is invented", failedJob.fields.receipt, "");
  equal("…and the DSH error text stays the body", failedJob.body, "Error: job bash-12 not found");
  const failedTitled = toolCallData(
    {
      name: "job_output",
      status: "failed",
      detail: { type: "unknown", input: { job_id: "bash-13" }, output: "Error: job bash-13 not found" },
      error: { message: "Error: job bash-13 not found" },
      metadata: { jobTitle: "查看构建是否已开跑" },
    },
    "complete",
  );
  equal("job_output: a failed read still uses the task title", failedTitled.summary, "查看构建是否已开跑");
  equal("…with the id in the card", failedTitled.fields.args[0], { kind: "fact", label: "编号", value: "bash-13" });

  // P1: a `job_output` row exists **before** any result arrives (the call is
  // blocking for up to 600 s), and a canceled row never gets one at all. Those
  // shapes used to return null and fall to L1, which printed `job_id: bash-20`
  // while the real title was already sitting in metadata.
  const runningJob = toolCallData(
    {
      name: "job_output",
      status: "running",
      detail: { type: "unknown", input: { job_id: "bash-20", wait: true, timeout_ms: 30000 } },
      metadata: { jobTitle: "查看构建是否已开跑" },
    },
    "complete",
  );
  equal("job_output: a running row already shows the task title", runningJob.summary, "查看构建是否已开跑");
  check("…never the wire key", !runningJob.summary.startsWith("job_id: "));
  equal("…with the id and the knobs in Chinese", runningJob.fields?.args, [
    { kind: "fact", label: "编号", value: "bash-20" },
    { kind: "fact", label: "等待", value: "true" },
    { kind: "fact", label: "超时（毫秒）", value: "30000" },
  ]);
  equal("…and no receipt before there is a status", runningJob.fields?.receipt, "");
  const canceledJob = toolCallData(
    { name: "job_output", status: "canceled", detail: { type: "unknown", input: { job_id: "bash-21" } }, metadata: { jobTitle: "查看构建是否已开跑" } },
    "complete",
  );
  equal("job_output: a canceled row keeps the title", canceledJob.summary, "查看构建是否已开跑");
  equal("…with the bare id in the card", canceledJob.fields?.args, [{ kind: "fact", label: "编号", value: "bash-21" }]);
  const emptyFailed = toolCallData(
    {
      name: "job_output",
      status: "failed",
      detail: { type: "unknown", input: { job_id: "bash-22" }, output: "" },
      error: { message: "job bash-22 not found" },
    },
    "complete",
  );
  equal("job_output: a failed row with an empty output keeps the bare id", emptyFailed.summary, "bash-22");
  equal("…and shows DSH's error, not an empty body", emptyFailed.body, "job bash-22 not found");
  // Nothing besides the head and the error to draw — the empty-card rule still
  // applies, and the row keeps the Chinese head and DSH's error text.
  equal("…mounted as no empty card", emptyFailed.fields, null);
  const nullOutput = toolCallData(
    { name: "job_output", status: "completed", detail: { type: "unknown", input: { job_id: "bash-23" }, output: null } },
    "complete",
  );
  equal("job_output: a null output keeps the bare id", nullOutput.summary, "bash-23");
  check("…never the wire key", !nullOutput.summary.startsWith("job_id: "));

  const titledNoStatus = row(
    "job_output",
    { job_id: "bash-10" },
    "still building",
    { metadata: { jobTitle: "查看构建是否已开跑" } },
  );
  equal("job_output: a title also survives a missing status line", titledNoStatus.summary, "查看构建是否已开跑");
  equal("…with the log intact", titledNoStatus.body, "still building");
  const kill = row("job_kill", { job_id: "bash-5", reason: "与当前问题无关，已不需要" }, "requested cancellation of job bash-5");
  equal("job_kill: the head is the job id", kill.summary, "bash-5");
  equal("…the one-line output becomes a receipt", kill.fields.receipt, "已请求取消");
  equal("…the body is cleared", kill.body, "");
  equal("…and the copy control keeps the original line", kill.fields.copyText, "requested cancellation of job bash-5");
  // F1: the model's reason was silently dropped by the first cut of this card.
  equal("…the reason is kept as a fact", kill.fields.args, [
    { kind: "fact", label: "reason", value: "与当前问题无关，已不需要" },
  ]);
  const longReason = "这条长说明会被 L1 的规则判成正文：它超过了六十个字符的单行上限，所以不该挤成一行事实条目；用户写的理由通常是一句解释，而不是一个短标识符，因此它应当原样换行显示。";
  equal(
    "job_kill: a long reason becomes prose, not a clipped fact",
    row("job_kill", { job_id: "bash-8", reason: longReason }, "requested cancellation of job bash-8").fields.args,
    [{ kind: "text", label: "reason", value: longReason }],
  );
  equal(
    "job_kill: a call without a reason keeps no entry",
    row("job_kill", { job_id: "bash-9" }, "requested cancellation of job bash-9").fields.args,
    [],
  );
  const oddKill = row("job_kill", { job_id: "bash-5" }, "something else");
  equal("job_kill: an undocumented output keeps L1", oddKill.body, "something else");

  // --- mcp_call_tool --------------------------------------------------------
  const proxied = row(
    "mcp_call_tool",
    { arguments: { limit: 5, filter: { url: "https://example.test" } }, server: "server_browser", tool: "browser_network_requests" },
    '{"success":true,"status":"ok"}',
  );
  equal("mcp_call_tool: the head is server/tool", proxied.summary, "server_browser/browser_network_requests");
  equal("…the arguments are entries, not one blob", proxied.fields.args, [
    { kind: "fact", label: "limit", value: "5" },
    { kind: "json", label: "filter", value: '{\n  "url": "https://example.test"\n}' },
  ]);
  equal("…the proxied result is left to L1", proxied.fields.result, [
    { kind: "fact", label: "success", value: "true" },
    { kind: "fact", label: "status", value: "ok" },
  ]);
  equal("…and its copy control keeps the result", proxied.fields.copyText, '{"success":true,"status":"ok"}');
  equal("mcp_call_tool: a call without a server keeps L1", row("mcp_call_tool", { tool: "x", arguments: {} }, "text").summary, "tool: x");

  // --- read_image -----------------------------------------------------------
  const image = row(
    "read_image",
    { file_path: "/tmp/render-research/preview/_thumb.png" },
    "<path>/tmp/render-research/preview/_thumb.png</path>\n<type>image</type>\n<content>\nimage/png image, 1600x1000 px, 947372 bytes\n</content>",
  );
  equal("read_image: the head is the basename", image.summary, "_thumb.png");
  equal("…the full path is still a fact", image.fields.args, [
    { kind: "fact", label: "file_path", value: "/tmp/render-research/preview/_thumb.png" },
  ]);
  check(
    "…and the card draws no image of its own",
    !(image.fields.args ?? []).some((entry) => entry.kind === "json"),
    JSON.stringify(image.fields.args),
  );
  equal("read_image: a call without a path keeps L1", row("read_image", {}, "<path>x</path>").summary, "");

  // --- run_code -------------------------------------------------------------
  const code = row(
    "run_code",
    {
      code: 'const g = await tools.grep({ pattern: "dbg-full" });\nconsole.log(g);',
      description: "查找 .dbg-full 的构建来源",
    },
    "[]",
  );
  equal("run_code: the head is the description", code.summary, "查找 .dbg-full 的构建来源");
  equal("…the program is a code entry, not prose", code.fields.args, [
    { kind: "code", label: "代码", value: 'const g = await tools.grep({ pattern: "dbg-full" });\nconsole.log(g);' },
  ]);
  equal("run_code: a call without code keeps L1", row("run_code", { description: "d" }, "out").summary, "description: d");

  // --- failure rows never become success receipts --------------------------
  const failedSend = failedRow(
    "send_message",
    { target: "2acfb6a9-773a-4396-9c96-56d549986419", message: "m" },
    'Error: active teammate "2acfb6a9-773a-4396-9c96-56d549986419" not found',
    'active teammate "2acfb6a9-773a-4396-9c96-56d549986419" not found',
  );
  equal("a failed send_message has no success receipt", failedSend.fields.receipt, "");
  equal("…keeps L1's argument entries", failedSend.fields.args[0].label, "target");
  equal("…and its error text is the body", failedSend.body, 'Error: active teammate "2acfb6a9-773a-4396-9c96-56d549986419" not found');
  const failedWait = failedRow("wait_agent", { timeout_ms: 30000 }, "Error: wait_agent aborted: { kind: 'user' }", "wait_agent aborted");
  equal("a failed wait_agent has no receipt either", failedWait.fields.receipt, "");
  equal("…and its error is kept verbatim", failedWait.error, "wait_agent aborted");

  // F2: the mappers' `failed` guard is the only thing between a failed row and a
  // *success* receipt. These feed a failure the exact output shape its successful
  // mapper expects — the row must keep L1 and show no receipt at all.
  const shapedSend = failedRow("send_message", { target: "lead", message: "m" }, '{"sent":true}', "send failed");
  equal("a failed send_message with a success-shaped output shows no receipt", shapedSend.fields.receipt, "");
  equal("…its head is not the recipient", shapedSend.summary, "target: lead");
  equal("…and the success-shaped JSON stays L1 entries", shapedSend.fields.result, [
    { kind: "fact", label: "sent", value: "true" },
  ]);
  const shapedWait = failedRow("wait_agent", { timeout_ms: 180000 }, '{"timedOut":false}', "wait aborted");
  equal("a failed wait_agent with a success-shaped output shows no receipt", shapedWait.fields.receipt, "");
  equal("…its head is not the duration", shapedWait.summary, "");
  const shapedKill = failedRow("job_kill", { job_id: "bash-5", reason: "r" }, "requested cancellation of job bash-5", "kill failed");
  equal("a failed job_kill with its success sentence shows no receipt", shapedKill.fields.receipt, "");
  equal("…and the sentence stays the body", shapedKill.body, "requested cancellation of job bash-5");

  // --- 2026-11-07: the 17 tools that were still wire names -------------------
  // Every mapper below gets a normal-shape assertion and at least one
  // shape-mismatch assertion that must fall back to L1 (no invented summary,
  // no invented receipt), the same contract as the ten cards above.

  // memory_update: the real data path is the tool's rendered Chinese sentence,
  // not a JSON object — the memory tools carry no presentationMeta, so Paseo
  // hands `message.content` text to `detail.output`.
  const UPDATE_SENTENCE = "已修订记忆,新版本 rec-2(旧版 rec-1 已退场可恢复)";
  const memUpdate = row(
    "memory_update",
    { record_id: "rec-1", content: "修订后的完整内容", scene: "work" },
    UPDATE_SENTENCE,
  );
  equal("memory_update: the head is the record id", memUpdate.summary, "rec-1");
  equal("…the content is prose under the id fact", memUpdate.fields.args, [
    { kind: "fact", label: "编号", value: "rec-1" },
    { kind: "text", label: "内容", value: "修订后的完整内容" },
  ]);
  equal("…the receipt names the new version", memUpdate.fields.receipt, "已修订 · 新版本 rec-2");
  equal("…the sentence is not repeated in the body", memUpdate.body, "");
  equal("…and the copy control keeps the rendered sentence", memUpdate.fields.copyText, UPDATE_SENTENCE);
  const memUpdateTrimmed = row("memory_update", { record_id: "rec-1", content: "x" }, `\n  ${UPDATE_SENTENCE}  \n`);
  equal("memory_update: surrounding whitespace is tolerated", memUpdateTrimmed.fields.receipt, "已修订 · 新版本 rec-2");
  const memUpdateNotice = row(
    "memory_update",
    { record_id: "rec-1", content: "x" },
    "记录 rec-1 不存在,未修订(可先用 memory_search 定位 id)",
  );
  equal("memory_update: a notice sentence keeps L1", memUpdateNotice.summary, "record_id: rec-1");
  equal("…and invents no receipt", memUpdateNotice.fields.receipt, "");
  const memUpdateCustom = row("memory_update", { record_id: "rec-1", content: "x" }, `${UPDATE_SENTENCE} 额外说明`);
  equal("memory_update: a custom sentence keeps L1", memUpdateCustom.summary, "record_id: rec-1");
  equal("…and invents no receipt", memUpdateCustom.fields.receipt, "");
  const memUpdateJson = row("memory_update", { record_id: "rec-1", content: "x" }, '{"id":"rec-2","retired_id":"rec-1"}');
  equal("memory_update: a JSON object is not the real shape and keeps L1", memUpdateJson.summary, "record_id: rec-1");
  equal("…with no receipt", memUpdateJson.fields.receipt, "");

  // memory_migrate_relation: from -> new target in the head, render sentence receipt.
  const MIGRATE_SENTENCE = "关系已迁移:1 条旧边闭合,1 条新边 active;源记录 carrier-1";
  const memMigrate = row(
    "memory_migrate_relation",
    {
      from_node_id: "node-a",
      relation: "works_at",
      old_to_node_id: "node-b",
      new_to_node_id: "node-c",
      source_record_ids: ["rec-1", "rec-2"],
    },
    MIGRATE_SENTENCE,
  );
  equal("memory_migrate_relation: the head is from -> new target · relation", memMigrate.summary, "node-a → node-c · works_at");
  equal("…relation, the old target and the sources are entries", memMigrate.fields.args, [
    { kind: "fact", label: "关系", value: "works_at" },
    { kind: "fact", label: "目标", value: "node-b" },
    { kind: "json", label: "记录", value: '[\n  "rec-1",\n  "rec-2"\n]' },
  ]);
  equal("…the receipt counts the edges", memMigrate.fields.receipt, "已迁移 · 闭合 1 条旧边 · 新增 1 条新边");
  equal("…the sentence is not repeated in the body", memMigrate.body, "");
  equal("…and the copy keeps the rendered sentence", memMigrate.fields.copyText, MIGRATE_SENTENCE);
  const memMigrateOdd = row(
    "memory_migrate_relation",
    { from_node_id: "node-a", relation: "works_at", old_to_node_id: "node-b" },
    MIGRATE_SENTENCE,
  );
  equal("memory_migrate_relation: a missing new target keeps L1", memMigrateOdd.summary, "from_node_id: node-a");
  equal("…with no receipt", memMigrateOdd.fields.receipt, "");
  const memMigrateNotice = row(
    "memory_migrate_relation",
    {
      from_node_id: "node-a",
      relation: "works_at",
      old_to_node_id: "node-b",
      new_to_node_id: "node-c",
      source_record_ids: ["rec-1"],
    },
    "三节点中有不存在的(先用 memory_search_graph 取 id)",
  );
  equal("memory_migrate_relation: a notice sentence keeps L1", memMigrateNotice.summary, "from_node_id: node-a");
  equal("…with no receipt", memMigrateNotice.fields.receipt, "");
  const memMigrateCustom = row(
    "memory_migrate_relation",
    {
      from_node_id: "node-a",
      relation: "works_at",
      old_to_node_id: "node-b",
      new_to_node_id: "node-c",
      source_record_ids: ["rec-1"],
    },
    `${MIGRATE_SENTENCE}。`,
  );
  equal("memory_migrate_relation: a custom sentence keeps L1", memMigrateCustom.summary, "from_node_id: node-a");
  equal("…with no receipt", memMigrateCustom.fields.receipt, "");

  // memory_reproject: how many records and how many jobs, from the rendered sentence.
  const REPROJECT_SENTENCE = "已入队 2 个重投作业";
  const memReproject = row("memory_reproject", { record_ids: ["rec-1", "rec-2"] }, REPROJECT_SENTENCE);
  equal("memory_reproject: the head counts the records", memReproject.summary, "2 条记录");
  equal("…the ids are one JSON entry", memReproject.fields.args, [
    { kind: "json", label: "记录", value: '[\n  "rec-1",\n  "rec-2"\n]' },
  ]);
  equal("…the receipt counts the queued jobs", memReproject.fields.receipt, "已入队 2 个作业");
  equal("…the sentence is not repeated in the body", memReproject.body, "");
  equal("…and the copy keeps the rendered sentence", memReproject.fields.copyText, REPROJECT_SENTENCE);
  equal(
    "…and the skipped clause joins it",
    row("memory_reproject", { record_ids: ["rec-1"] }, "已入队 0 个重投作业(跳过不存在 1 条)").fields.receipt,
    "已入队 0 个作业 · 跳过 1 条",
  );
  const memReprojectRefusal = row(
    "memory_reproject",
    { record_ids: ["rec-1"] },
    '{"queued":0,"job_ids":[],"skipped_ids":[],"notice":"图谱写面未接线"}',
  );
  equal("memory_reproject: the documented refusal object keeps L1", memReprojectRefusal.summary, "notice: 图谱写面未接线");
  equal("…and never reads as a zero-job success", memReprojectRefusal.fields.receipt, "");
  const memReprojectNotice = row("memory_reproject", { record_ids: ["rec-1"] }, "图谱写面未接线(runner 未装配),无法入队。");
  equal("memory_reproject: a notice sentence keeps L1", memReprojectNotice.summary, "");
  equal("…with no receipt", memReprojectNotice.fields.receipt, "");
  const memReprojectCustom = row("memory_reproject", { record_ids: ["rec-1"] }, "已入队 2 个重投作业，请稍候");
  equal("memory_reproject: a custom sentence keeps L1", memReprojectCustom.summary, "");
  equal("…with no receipt", memReprojectCustom.fields.receipt, "");

  // plugin_manager: list entries are visible, no-argument lists keep a card.
  const PLUGIN_LIST_JSON = '{"entries":[{"id":"a","name":"Plug A"},{"id":"b","name":"Plug B"}],"total":2,"nextOffset":null}';
  const pluginList = row("plugin_manager", { action: "list_plugins", limit: 25 }, PLUGIN_LIST_JSON);
  equal("plugin_manager: a list names the action and the total", pluginList.summary, "列出插件 · 共 2 条");
  equal("…paging knobs stay facts", pluginList.fields.args, [{ kind: "fact", label: "limit", value: "25" }]);
  equal("…the total and every entry are visible result entries", pluginList.fields.result, [
    { kind: "fact", label: "记录", value: "2" },
    { kind: "json", label: "", value: '{\n  "id": "a",\n  "name": "Plug A"\n}' },
    { kind: "json", label: "", value: '{\n  "id": "b",\n  "name": "Plug B"\n}' },
  ]);
  equal("…and the copy keeps the full JSON", pluginList.fields.copyText, PLUGIN_LIST_JSON);
  const pluginListNoArgs = row("plugin_manager", { action: "list_bundles" }, '{"entries":[],"total":0,"nextOffset":null}');
  equal("plugin_manager: an argument-less list keeps a card", pluginListNoArgs.summary, "列出插件包 · 共 0 条");
  check("…with a non-null fields card", pluginListNoArgs.fields !== null, JSON.stringify(pluginListNoArgs.fields));
  equal("…the empty total is still visible", pluginListNoArgs.fields.result, [
    { kind: "fact", label: "记录", value: "0" },
  ]);
  equal(
    "…and its copy control keeps the full JSON",
    pluginListNoArgs.fields.copyText,
    '{"entries":[],"total":0,"nextOffset":null}',
  );
  const pluginExemptionsJson = '{"runtimeVersion":"1.2.3","exemptions":[{"target":"pkg@1.0.0","enabled":true}]}';
  const pluginExemptions = row("plugin_manager", { action: "list_version_exemptions" }, pluginExemptionsJson);
  equal("plugin_manager: version exemptions are a card", pluginExemptions.summary, "查看版本豁免");
  check(
    "…its record keys are visible",
    (pluginExemptions.fields.result ?? []).some((entry) => entry.label === "runtimeVersion"),
    JSON.stringify(pluginExemptions.fields.result),
  );
  equal("…and its copy control keeps the full JSON", pluginExemptions.fields.copyText, pluginExemptionsJson);
  const pluginSet = row("plugin_manager", { action: "set_plugin", target: "paseo-dsh", enabled: false }, '{"application":"restart-required","nextStep":"restart"}');
  equal("plugin_manager: the head is the action and target", pluginSet.summary, "启用或停用插件 · paseo-dsh");
  equal("…the application word is the receipt", pluginSet.fields.receipt, "需重启生效");
  equal("…enabled stays a fact", pluginSet.fields.args, [
    { kind: "fact", label: "目标", value: "paseo-dsh" },
    { kind: "fact", label: "enabled", value: "false" },
  ]);
  const pluginOdd = row("plugin_manager", { action: "list_plugins" }, "not json");
  equal("plugin_manager: an undocumented list result keeps L1", pluginOdd.summary, "action: list_plugins");
  equal("…with no receipt", pluginOdd.fields.receipt, "");
  const pluginUnknownAction = row("plugin_manager", { action: "delete_everything" }, '{"application":"applied"}');
  equal("plugin_manager: an unknown action keeps L1", pluginUnknownAction.summary, "action: delete_everything");
  equal("…with no receipt", pluginUnknownAction.fields.receipt, "");

  // schedule_view: a task's documented fields, or not_found.
  const scheduleJson = JSON.stringify({
    id: "task-1",
    title: "每日报告",
    prompt: "生成今天的报告",
    scheduledAt: "2026-11-08T01:00:00Z",
    scheduledAtLocal: "2026-11-08 09:00",
    target: { kind: "session", sessionId: "sess-1" },
    status: "active",
    kind: "rrule",
    rrule: "DTSTART;TZID=Asia/Shanghai:20261108T090000\nRRULE:FREQ=DAILY",
    updatedAt: "2026-11-07T00:00:00Z",
  });
  const scheduleView = row("schedule_view", { id: "task-1" }, scheduleJson);
  equal("schedule_view: the head is the task title", scheduleView.summary, "每日报告");
  equal("…status, next run, rule, prompt and target are entries", scheduleView.fields.result, [
    { kind: "fact", label: "状态", value: "进行中" },
    { kind: "fact", label: "下次触发", value: "2026-11-08 09:00" },
    { kind: "text", label: "调度规则", value: "rrule · DTSTART;TZID=Asia/Shanghai:20261108T090000\nRRULE:FREQ=DAILY" },
    { kind: "text", label: "提示词", value: "生成今天的报告" },
    { kind: "json", label: "目标", value: '{\n  "kind": "session",\n  "sessionId": "sess-1"\n}' },
  ]);
  equal("…and the copy keeps the whole task JSON", scheduleView.fields.copyText, scheduleJson);
  const scheduleMissing = row("schedule_view", { id: "task-1" }, '{"id":"task-1","code":"schedule_not_found"}');
  equal("schedule_view: not_found is a receipt", scheduleMissing.fields.receipt, "未找到该任务");
  const scheduleViewOdd = row("schedule_view", { id: "task-1" }, "not json");
  equal("schedule_view: an undocumented result keeps L1", scheduleViewOdd.summary, "id: task-1");
  equal("…with no receipt", scheduleViewOdd.fields.receipt, "");

  // schedule_edit: update and delete are different documented results.
  const scheduleEdit = row("schedule_edit", { id: "task-1", action: "delete" }, '{"id":"task-1","deleted":true}');
  equal("schedule_edit: delete names the task", scheduleEdit.summary, "task-1");
  equal("…with the action as a fact", scheduleEdit.fields.args, [
    { kind: "fact", label: "编号", value: "task-1" },
    { kind: "fact", label: "动作", value: "删除" },
  ]);
  equal("…and a deleted receipt", scheduleEdit.fields.receipt, "已删除");
  const scheduleUpdated = row("schedule_edit", { id: "task-1", action: "update", title: "新标题" }, scheduleJson);
  equal("schedule_edit: an update names the task title", scheduleUpdated.summary, "每日报告");
  equal("…and says updated", scheduleUpdated.fields.receipt, "已更新");
  check("…while the task fields stay visible", (scheduleUpdated.fields.result ?? []).length > 0);
  const scheduleEditOdd = row("schedule_edit", { id: "task-1", action: "update", title: "x" }, "not json");
  equal("schedule_edit: an undocumented result keeps L1", scheduleEditOdd.summary, "id: task-1");
  equal("…with no receipt", scheduleEditOdd.fields.receipt, "");

  // remote_list_hosts: argument-less discovery.
  const remoteHosts = row("remote_list_hosts", {}, '{"hosts":[]}');
  equal("remote_list_hosts: the head names the list", remoteHosts.summary, "全部远程主机");
  equal("…and the copy keeps the list JSON", remoteHosts.fields.copyText, '{"hosts":[]}');
  const remoteHostsOdd = row("remote_list_hosts", { unexpected: "x" }, "not json");
  equal("remote_list_hosts: an unexpected argument keeps L1", remoteHostsOdd.summary, "unexpected: x");

  // remote_list_workspaces / remote_list_sessions / remote_read_session.
  const remoteWorkspaces = row("remote_list_workspaces", { hostId: "host-1" }, '{"workspaces":[]}');
  equal("remote_list_workspaces: the head is the host", remoteWorkspaces.summary, "host-1");
  equal("…the host is a fact", remoteWorkspaces.fields.args, [{ kind: "fact", label: "主机", value: "host-1" }]);
  equal("…and the copy keeps the list JSON", remoteWorkspaces.fields.copyText, '{"workspaces":[]}');
  equal(
    "remote_list_workspaces: a non-string host keeps L1",
    row("remote_list_workspaces", { hostId: 3, label: "x" }, "not json").summary,
    "label: x",
  );
  const remoteSessions = row("remote_list_sessions", { hostId: "host-1", backend: "harness", workspaceId: "ws-1" }, '{"sessions":[]}');
  equal("remote_list_sessions: the head is host/workspace", remoteSessions.summary, "host-1 / ws-1");
  equal("…and the copy keeps the list JSON", remoteSessions.fields.copyText, '{"sessions":[]}');
  equal(
    "remote_list_sessions: a missing workspace keeps L1",
    row("remote_list_sessions", { hostId: "host-1", backend: "harness" }, "not json").summary,
    "hostId: host-1",
  );
  const remoteRead = row(
    "remote_read_session",
    { hostId: "host-1", backend: "harness", workspaceId: "ws-1", sessionId: "sess-1", maxMessages: 10 },
    '{"messages":[]}',
  );
  equal("remote_read_session: the head is the session", remoteRead.summary, "sess-1");
  equal("…host/workspace/session and the bound are facts", remoteRead.fields.args, [
    { kind: "fact", label: "主机", value: "host-1" },
    { kind: "fact", label: "工作区", value: "ws-1" },
    { kind: "fact", label: "会话", value: "sess-1" },
    { kind: "fact", label: "maxMessages", value: "10" },
  ]);
  equal("…and the copy keeps the history JSON", remoteRead.fields.copyText, '{"messages":[]}');
  equal(
    "remote_read_session: a missing session keeps L1",
    row("remote_read_session", { hostId: "host-1", backend: "harness", workspaceId: "ws-1" }, "not json").summary,
    "hostId: host-1",
  );

  // remote_create_session / remote_send_message / remote_interrupt_session:
  // the documented receipt field gates the card.
  const remoteCreate = row(
    "remote_create_session",
    { hostId: "host-1", backend: "harness", workspaceId: "ws-1", operationId: "op-1" },
    '{"sessionId":"sess-9"}',
  );
  equal("remote_create_session: the head is the workspace", remoteCreate.summary, "ws-1");
  equal("…the session id is the receipt", remoteCreate.fields.receipt, "已创建 · sess-9");
  equal(
    "remote_create_session: a receipt without sessionId keeps L1",
    row("remote_create_session", { hostId: "host-1", backend: "harness", workspaceId: "ws-1", operationId: "op-1" }, '{"accepted":true}').summary,
    "hostId: host-1",
  );
  const remoteSend = row(
    "remote_send_message",
    { hostId: "host-1", backend: "harness", workspaceId: "ws-1", sessionId: "sess-1", operationId: "op-1", message: "跑一下测试" },
    '{"accepted":true}',
  );
  equal("remote_send_message: the head is the session", remoteSend.summary, "sess-1");
  equal("…the message is prose", remoteSend.fields.args.at(-1), { kind: "text", label: "消息", value: "跑一下测试" });
  equal("…and accepted is the receipt", remoteSend.fields.receipt, "已发送（排队）");
  equal(
    "remote_send_message: a non-accepted output keeps L1",
    row("remote_send_message", { hostId: "host-1", backend: "harness", workspaceId: "ws-1", sessionId: "sess-1", operationId: "op-1", message: "x" }, '{"accepted":false}').summary,
    "hostId: host-1",
  );
  const remoteInterrupt = row(
    "remote_interrupt_session",
    { hostId: "host-1", backend: "harness", workspaceId: "ws-1", sessionId: "sess-1", operationId: "op-1" },
    '{"accepted":true}',
  );
  equal("remote_interrupt_session: the head is the session", remoteInterrupt.summary, "sess-1");
  equal("…the receipt is the stop request", remoteInterrupt.fields.receipt, "已请求中断");
  equal(
    "remote_interrupt_session: a non-accepted output keeps L1",
    row("remote_interrupt_session", { hostId: "host-1", backend: "harness", workspaceId: "ws-1", sessionId: "sess-1", operationId: "op-1" }, "not json").summary,
    "hostId: host-1",
  );

  // remote_wait_sessions: the target count in the head.
  const remoteWait = row(
    "remote_wait_sessions",
    {
      targets: [
        { hostId: "host-1", backend: "harness", workspaceId: "ws-1", sessionId: "sess-1" },
        { hostId: "host-1", backend: "harness", workspaceId: "ws-1", sessionId: "sess-2" },
      ],
      timeoutMs: 30000,
    },
    '{"timedOut":false}',
  );
  equal("remote_wait_sessions: the head counts the sessions", remoteWait.summary, "2 个会话");
  equal("…the targets are one JSON entry plus the timeout", remoteWait.fields.args, [
    { kind: "json", label: "目标会话", value: '[\n  {\n    "hostId": "host-1",\n    "backend": "harness",\n    "workspaceId": "ws-1",\n    "sessionId": "sess-1"\n  },\n  {\n    "hostId": "host-1",\n    "backend": "harness",\n    "workspaceId": "ws-1",\n    "sessionId": "sess-2"\n  }\n]' },
    { kind: "fact", label: "超时", value: "30000" },
  ]);
  equal(
    "remote_wait_sessions: an empty target list keeps L1",
    row("remote_wait_sessions", { targets: [] }, "not json").fields.args[0].label,
    "targets",
  );

  // remote_download_file / remote_upload_file: the documented path/bytes receipts.
  const remoteDownload = row(
    "remote_download_file",
    { hostId: "host-1", backend: "harness", workspaceId: "ws-1", sessionId: "sess-1", path: "docs/report.pdf" },
    '{"localPath":"/home/user/Downloads/report.pdf","bytes":1024}',
  );
  equal("remote_download_file: the head is the basename", remoteDownload.summary, "report.pdf");
  equal("…the local path is a fact", remoteDownload.fields.args, [
    { kind: "fact", label: "主机", value: "host-1" },
    { kind: "fact", label: "工作区", value: "ws-1" },
    { kind: "fact", label: "会话", value: "sess-1" },
    { kind: "fact", label: "路径", value: "docs/report.pdf" },
  ]);
  equal("…the bytes are the receipt", remoteDownload.fields.receipt, "已下载 · 1024 字节");
  equal(
    "remote_download_file: a result without localPath/bytes keeps L1",
    row("remote_download_file", { hostId: "host-1", backend: "harness", workspaceId: "ws-1", sessionId: "sess-1", path: "a.txt" }, '{"path":"a.txt"}').summary,
    "hostId: host-1",
  );
  const remoteUpload = row(
    "remote_upload_file",
    { hostId: "host-1", backend: "harness", workspaceId: "ws-1", sessionId: "sess-1", operationId: "op-1", localPath: "/tmp/a.txt" },
    '{"path":"/remote/ws/a.txt","bytes":2048}',
  );
  equal("remote_upload_file: the head is the local basename", remoteUpload.summary, "a.txt");
  equal("…the remote path and bytes are the receipt", remoteUpload.fields.receipt, "已上传 · /remote/ws/a.txt · 2048 字节");
  equal(
    "remote_upload_file: a result without bytes keeps L1",
    row("remote_upload_file", { hostId: "host-1", backend: "harness", workspaceId: "ws-1", sessionId: "sess-1", operationId: "op-1", localPath: "/tmp/a.txt" }, '{"path":"/remote/a.txt"}').summary,
    "hostId: host-1",
  );

  // remote_get_operation: the operation id in the head, receipt left to L1.
  const remoteOperation = row("remote_get_operation", { operationId: "op-1" }, '{"operationId":"op-1","status":"accepted"}');
  equal("remote_get_operation: the head is the operation id", remoteOperation.summary, "op-1");
  equal("…and it is a fact", remoteOperation.fields.args, [{ kind: "fact", label: "操作", value: "op-1" }]);
  equal(
    "remote_get_operation: a result without operationId keeps L1",
    row("remote_get_operation", { operationId: "op-1" }, '{"status":"accepted"}').summary,
    "operationId: op-1",
  );

  // A failed call never reaches any of the new mappers either.
  const failedMemUpdate = failedRow("memory_update", { record_id: "rec-1", content: "x" }, "已修订记忆,新版本 rec-2(旧版 rec-1 已退场可恢复)", "memory update failed");
  equal("a failed memory_update has no success receipt", failedMemUpdate.fields.receipt, "");
  equal("…and its head returns to L1", failedMemUpdate.summary, "record_id: rec-1");
  const failedPlugin = failedRow("plugin_manager", { action: "set_plugin", target: "x", enabled: true }, '{"application":"applied"}', "plugin manager failed");
  equal("a failed plugin_manager has no application receipt", failedPlugin.fields.receipt, "");
  equal("…and its head returns to L1", failedPlugin.summary, "action: set_plugin");
  const failedRemote = failedRow("remote_create_session", { hostId: "h", backend: "harness", workspaceId: "w", operationId: "o" }, '{"sessionId":"s"}', "remote create failed");
  equal("a failed remote_create_session has no creation receipt", failedRemote.fields.receipt, "");
  equal("…and its head returns to L1", failedRemote.summary, "hostId: h");

  // --- skill: the model-facing frame, parsed down to a card ----------------
  // The fixtures are `renderSkillContent()`'s own output, rebuilt line for line
  // from `dsh-skill/lib/index.js:57-81`: the opening tag with its escaped name
  // attribute, `<skill_resources>` with one hint line plus one English
  // instruction line, a blank line, then `<skill_instructions>` and the body.
  // Nothing else is in the text — `tool/result` carries no structured value, so
  // this string is all the client ever sees.
  const skillFrame = (name, hint, body) =>
    [
      `<skill_content name="${name}">`,
      "<skill_resources>",
      ...hint,
      "</skill_resources>",
      "",
      "<skill_instructions>",
      body,
      "</skill_instructions>",
      "</skill_content>",
    ].join("\n");
  const FRAME_WORDS = /<\/?skill_(content|resources|instructions)|Base directory for this skill|Base URL for this skill|Resources for this skill|Resolve (relative paths|relative URLs)/u;
  const skillBody = "# 主会话编排\n\n派发前先加载 `dsh-orchestration`，再按单元清单派 teammate。\n\n- 单元 1：实现\n- 单元 2：审查\n";

  // directory: the provider's base directory, no provider name in the text.
  const directoryText = skillFrame(
    "dsh-orchestration",
    [
      "Base directory for this skill: /home/runner/.dsh/skills/dsh-orchestration",
      "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
    ],
    skillBody,
  );
  const directoryRow = row("skill", { name: "dsh-orchestration" }, directoryText);
  equal("skill (directory): the head is the body's own level-1 title", directoryRow.summary, "主会话编排");
  equal("…the call's name argument is not repeated as a fact", directoryRow.fields?.args, []);
  equal("…the wire name is still a fact, so /name calls keep it", directoryRow.fields?.result, [
    { kind: "fact", label: "名称", value: "dsh-orchestration" },
    { kind: "fact", label: "位置", value: "/home/runner/.dsh/skills/dsh-orchestration" },
    { kind: "text", label: "指令", value: skillBody },
  ]);
  check("…the location is a fact, so it sits beside its label", directoryRow.fields?.result?.[1]?.kind === "fact");
  check("…the generic 「结果」caption is switched off", directoryRow.fields?.hideResultCaption === true);
  equal("…the English frame is not put in the body as well", directoryRow.body, "");
  equal("…the copy control keeps the complete original output", directoryRow.fields?.copyText, directoryText);
  check(
    "…no frame line survives in the card's entries",
    !FRAME_WORDS.test(JSON.stringify(directoryRow.fields?.result ?? null)),
    JSON.stringify(directoryRow.fields?.result ?? null).slice(0, 200),
  );
  check("…and the row still expands onto the card", directoryRow.hasDetail === true);

  // url: same shape, the base URL instead of a directory.
  const urlText = skillFrame(
    "remote-skill",
    [
      "Base URL for this skill: https://skills.example.test/remote-skill",
      "Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.",
    ],
    "Fetch the reference page before answering.\n",
  );
  const urlRow = row("skill", { name: "remote-skill" }, urlText);
  equal("skill (url): the URL is the location fact", urlRow.fields?.result?.[1], {
    kind: "fact",
    label: "位置",
    value: "https://skills.example.test/remote-skill",
  });
  equal("…a body with no level-1 heading falls back to the wire name", urlRow.summary, "remote-skill");

  // opaque: a provider-described resource base, still no provider name.
  const opaqueText = skillFrame(
    "office-skills",
    ["Resources for this skill: the templates ship inside the plugin bundle.", "Load referenced resources only as needed."],
    "Use the bundled templates.",
  );
  const opaqueRow = row("skill", { name: "office-skills" }, opaqueText);
  equal("skill (opaque description): the description is the location", opaqueRow.fields?.result, [
    { kind: "fact", label: "名称", value: "office-skills" },
    { kind: "fact", label: "位置", value: "the templates ship inside the plugin bundle." },
    { kind: "text", label: "指令", value: "Use the bundled templates." },
  ]);

  // provider-managed: the one hint that names a provider, and no location at all.
  const managedText = skillFrame(
    "paseo-upstream",
    ['Resources for this skill are managed by provider "paseo-plugin-bundle".', "Load referenced resources only as needed."],
    "Upstream instructions.\n",
  );
  const managedRow = row("skill", { name: "paseo-upstream" }, managedText);
  equal("skill (provider-managed): the head falls back to the wire name", managedRow.summary, "paseo-upstream");
  equal("…the provider is a fact, and no location is invented", managedRow.fields?.result, [
    { kind: "fact", label: "名称", value: "paseo-upstream" },
    { kind: "fact", label: "提供方", value: "paseo-plugin-bundle" },
    { kind: "text", label: "指令", value: "Upstream instructions.\n" },
  ]);
  check("…this card hides the caption too", managedRow.fields?.hideResultCaption === true);
  equal("…the copy control keeps the frame too", managedRow.fields?.copyText, managedText);
  check(
    "…no frame line survives in this card either",
    !FRAME_WORDS.test(JSON.stringify(managedRow.fields?.result ?? null)),
    JSON.stringify(managedRow.fields?.result ?? null),
  );

  // The name attribute and the hint prose are escaped by DSH; the card decodes
  // them, and the copy control still hands over the escaped original.
  const escapedText = skillFrame(
    "a&amp;b",
    ["Base directory for this skill: /skills/a&amp;b &lt;test&gt;", "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed."],
    "body",
  );
  const escapedRow = row("skill", { name: "a&b" }, escapedText);
  equal("skill: the escaped name decodes for the head", escapedRow.summary, "a&b");
  equal("…and the decoded name is the 名称 fact", escapedRow.fields?.result?.[0], { kind: "fact", label: "名称", value: "a&b" });
  equal("…so does the escaped location", escapedRow.fields?.result?.[1]?.value, "/skills/a&b <test>");
  equal("…while copy keeps the escaped bytes", escapedRow.fields?.copyText, escapedText);

  // A frame with no instruction body is not this shape: L1's generic card keeps
  // the whole text (never a blank card, never a lost byte).
  const noInstructions = [
    '<skill_content name="broken-skill">',
    "<skill_resources>",
    "Base directory for this skill: /tmp/skills/broken-skill",
    "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
    "</skill_resources>",
    "",
    "</skill_content>",
  ].join("\n");
  const brokenRow = row("skill", { name: "broken-skill" }, noInstructions);
  equal("skill: a frame without instructions keeps L1's summary", brokenRow.summary, "name: broken-skill");
  equal("…L1's argument entry comes back", brokenRow.fields?.args, [{ kind: "fact", label: "name", value: "broken-skill" }]);
  equal("…no result entry is invented", brokenRow.fields?.result, []);
  equal("…the whole text stays in the body", brokenRow.body, noInstructions);
  check("…and it is a card, not an empty row", brokenRow.hasDetail === true);
  check(
    "…the skill card's 名称 fact does not survive the fallback",
    !JSON.stringify(brokenRow.fields ?? null).includes("名称"),
    JSON.stringify(brokenRow.fields ?? null),
  );
  check("…and the caption flag is back to the default", brokenRow.fields?.hideResultCaption === false);

  // A different frame — an unknown hint line — is refused the same way.
  const oddHint = skillFrame("odd-hint", ["Skills live somewhere the client does not parse.", "Load referenced resources only as needed."], "body");
  const oddHintRow = row("skill", { name: "odd-hint" }, oddHint);
  equal("skill: an unknown hint line keeps L1", oddHintRow.summary, "name: odd-hint");
  equal("…with the text still in the body", oddHintRow.body, oddHint);

  // The resources block is two lines — the hint plus the note DSH writes with
  // it. An unknown note is a shape this card does not know.
  const oddNote = skillFrame(
    "odd-note",
    ["Base directory for this skill: /tmp/skills/odd-note", "Something the renderer never writes."],
    "body",
  );
  const oddNoteRow = row("skill", { name: "odd-note" }, oddNote);
  equal("skill: an unknown resource note keeps L1", oddNoteRow.summary, "name: odd-note");
  equal("…with the text still in the body", oddNoteRow.body, oddNote);

  // Nor does a third line: the renderer emits exactly two, so three is not it.
  const threeLines = skillFrame(
    "three-lines",
    ["Base directory for this skill: /tmp/skills/three-lines", "Load referenced resources only as needed.", "An extra line the renderer never writes."],
    "body",
  );
  const threeLinesRow = row("skill", { name: "three-lines" }, threeLines);
  equal("skill: a three-line resource block keeps L1", threeLinesRow.summary, "name: three-lines");
  equal("…with the text still in the body", threeLinesRow.body, threeLines);

  // Only a real level-1 heading titles the card: `## …` is not one, and neither
  // is a `# ` line with nothing after it.
  const secondLevelText = skillFrame(
    "second-level",
    ["Resources for this skill: a body that starts at level two.", "Load referenced resources only as needed."],
    "## 二级标题\n正文",
  );
  equal(
    "skill: a level-2 heading is not the card's title",
    row("skill", { name: "second-level" }, secondLevelText).summary,
    "second-level",
  );
  const emptyHeadingText = skillFrame(
    "empty-heading",
    ["Resources for this skill: a body with an empty level-1 heading.", "Load referenced resources only as needed."],
    "# \n正文",
  );
  equal(
    "skill: an empty level-1 heading falls back to the wire name",
    row("skill", { name: "empty-heading" }, emptyHeadingText).summary,
    "empty-heading",
  );

  // A fenced code block is body, not document structure: `# 安装依赖` inside
  // ```` ```bash ```` is a shell comment, and the title is the first `# ` line
  // after the fence closes.
  const fencedThenTitle = skillFrame(
    "fenced-then-title",
    ["Resources for this skill: a body that opens with a code fence.", "Load referenced resources only as needed."],
    "```bash\n# 安装依赖\nnpm install\n```\n\n# 真标题\n正文",
  );
  equal(
    "skill: a `# ` line inside a code fence is not the title",
    row("skill", { name: "fenced-then-title" }, fencedThenTitle).summary,
    "真标题",
  );
  const fencedOnly = skillFrame(
    "fenced-only",
    ["Resources for this skill: a body whose only `# ` lines are inside a fence.", "Load referenced resources only as needed."],
    "```bash\n# 只有围栏内的标题\n```\n\n正文",
  );
  equal(
    "skill: a heading only inside a code fence falls back to the wire name",
    row("skill", { name: "fenced-only" }, fencedOnly).summary,
    "fenced-only",
  );

  // The flag is a skill-card opt-out only: every other card keeps its caption.
  equal(
    "skill: other cards keep the caption flag at its default",
    row("probe_tool", { a: 1 }, "").fields?.hideResultCaption,
    false,
  );

  // A non-text output is not this shape either: the mapper declines, L1 splits it.
  const objectOutput = toolCallData(
    { name: "skill", status: "completed", detail: { type: "unknown", input: { name: "obj" }, output: { name: "obj" } }, error: null },
    "complete",
  );
  equal("skill: an object output keeps L1's entries", objectOutput.fields?.result, [{ kind: "fact", label: "name", value: "obj" }]);

  // A failed call never reaches the mapper: the failure text stays verbatim.
  const failedSkill = failedRow(
    "skill",
    { name: "missing-skill" },
    'skill "missing-skill" is unknown or no longer available',
    'skill "missing-skill" is unknown or no longer available',
  );
  equal("skill: a failed call has no card and no receipt", failedSkill.fields?.receipt, "");
  equal("…and keeps DSH's failure sentence", failedSkill.body, 'skill "missing-skill" is unknown or no longer available');

  // --- the copy comes from the same locale tables --------------------------
  const en = allText().en.toolCards;
  const zh = allText()["zh-CN"].toolCards;
  equal("both languages ship the L2 card copy", Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(en)) {
    const leaf = en[key];
    const other = zh[key];
    if (typeof leaf === "function") {
      check(`toolCards.${key} is a formatter in both languages`, typeof other === "function");
    } else if (typeof leaf === "object") {
      equal(`toolCards.${key} keys match`, Object.keys(leaf).sort(), Object.keys(other).sort());
    } else {
      check(`toolCards.${key} is set in both languages`, typeof other === "string" && other !== "" && leaf !== "", JSON.stringify([leaf, other]));
    }
  }
  setLocale("en");
  const englishSend = row("send_message", { target: "lead", message: "m" }, '{"sent":true}');
  equal("English: the receipt is translated", englishSend.fields.receipt, "Sent");
  equal("English: the message label too", englishSend.fields.args[0].label, "Message");
  const englishSkill = row("skill", { name: "dsh-orchestration" }, directoryText);
  equal("English: the skill card labels", englishSkill.fields?.result?.map((entry) => entry.label), ["Name", "Location", "Instructions"]);
  equal("English: the card title is the body's own heading", englishSkill.summary, "主会话编排");
  // The provider-managed form names a provider and no location: in English the
  // labels must be English too, and the values stay verbatim.
  const englishManaged = row("skill", { name: "paseo-upstream" }, managedText);
  equal(
    "English: the provider-managed skill card labels",
    englishManaged.fields?.result?.map((entry) => entry.label),
    ["Name", "Provider", "Instructions"],
  );
  equal(
    "…and its values are not translated",
    englishManaged.fields?.result?.map((entry) => entry.value),
    ["paseo-upstream", "paseo-plugin-bundle", "Upstream instructions.\n"],
  );
  setLocale("zh-CN");
}

console.log("a row only expands onto something");
{
  // Regression: every expansion went into a code surface, so a row whose only
  // content is its title drew an empty grey bar. `hasDetail` is the data-layer
  // answer to "is there anything to reveal", which is why it lives here.
  //
  // The head reads `label · summary`. When the second half repeats the first it
  // is not a title, it is the same line printed twice — `/compact · /compact`
  // was the reported symptom, and Chinese `todo_write` / `ask_user_question`
  // repeat their own labels the same way.
  const titleOnly = toolCallData(
    { name: "todo_write", status: "completed", detail: { type: "plain_text", label: "更新任务", text: "" } },
    "complete",
  );
  equal("a title-only row reveals nothing", titleOnly.hasDetail, false);
  equal("and is still labelled", titleOnly.summary, "更新任务");

  const todo = toolCallData(
    {
      name: "todo_write",
      status: "completed",
      detail: { type: "plain_text", label: toolLabel("todo_write"), icon: "sparkles" },
    },
    "complete",
  );
  equal("todo_write: the summary does not repeat the label", todo.summary, "");

  const question = toolCallData(
    {
      name: "ask_user_question",
      status: "completed",
      detail: { type: "plain_text", label: toolLabel("ask_user_question"), icon: "sparkles" },
    },
    "complete",
  );
  equal("ask_user_question: the summary does not repeat the label", question.summary, "");

  // A `/command` row: the plugin puts the command in `name` and its *arguments*
  // in `label`, because the head already carries the command as the label. An
  // argument-less `/compact` therefore has an empty second half — which the old
  // `|| text` fallback misread as "no label" and answered by promoting the
  // command's output into the summary, losing it from the block.
  const command = toolCallData(
    {
      name: "/goal",
      status: "completed",
      detail: { type: "plain_text", label: "", text: "No goal is currently set.", icon: "square_terminal" },
    },
    "complete",
  );
  equal("an argument-less slash command has no summary of its own", command.summary, "");
  equal("and no block headline either (the label is the whole head)", command.headline, "");
  equal("but its output is the body, not dropped", command.body, "No goal is currently set.");
  equal("so it has something to reveal", command.hasDetail, true);

  const withArgs = toolCallData(
    {
      name: "/goal",
      status: "completed",
      detail: { type: "plain_text", label: "ship the renderer", text: "goal set", icon: "square_terminal" },
    },
    "complete",
  );
  equal("a slash command with arguments shows them as the summary", withArgs.summary, "ship the renderer");
  equal("and its output is still the body", withArgs.body, "goal set");

  const withDetail = toolCallData(
    {
      name: "mcp__paseo__list_workspaces",
      status: "completed",
      detail: { type: "unknown", input: {}, output: { workspaces: [] } },
    },
    "complete",
  );
  for (const [label, data] of [
    ["result row", withDetail],
    ["title-only row", titleOnly],
    ["slash command", command],
  ]) {
    equal(
      `${label}: hasDetail agrees with the block's content`,
      data.hasDetail,
      data.headline !== "" || data.body !== "" || data.fields !== null,
    );
  }
}

console.log("DSH's own tools are not anonymous");
{
  // They arrive with an `unknown` detail — exactly like an MCP call — so without
  // a name mapping both rendered as `wrench <raw_name>` and the two were
  // indistinguishable. DSH titles them through `tool.title.*`; these are those
  // names in Chinese.
  equal("update_goal has a label", toolLabel("update_goal"), "更新目标");
  equal("and its own icon", toolIcon("update_goal", { type: "unknown" }), "Target");
  // `run_code` is DSH's PTC transport: `TOOL_VARIANTS.run_code = "code"`, so its
  // title is `tool.title.code` (代码 / Code) and its icon is that variant's
  // `IconCodeOutlineRegular`. It was the one DSH tool with neither, and rendered
  // as the wire name `run_code` next to the MCP wrench.
  equal("run_code has a label", toolLabel("run_code"), "代码");
  equal("and DSH's `code` variant icon", toolIcon("run_code", { type: "unknown" }), "Code");
  equal("and keeps it with no detail at all", toolIcon("run_code", undefined), "Code");
  // `cordis_define` is the one cordis tool whose keyed DSH row
  // (`dsh-client-ui-cordis`) uses the code glyph rather than the plugin glyph.
  equal(
    "cordis_define draws the code glyph, not the wrench",
    toolIcon("cordis_define", { type: "unknown" }),
    "Code",
  );
  // `present` has a keyed DSH row of its own (`dsh-client-ui-deliverables`,
  // 交付文件 / "Present files"); its `IconDeliverDocRegular` has no Lucide
  // counterpart, so `FileOutput` is the documented semantic stand-in.
  equal("present has the deliverable icon", toolIcon("present", { type: "unknown" }), "FileOutput");
  equal("get_goal too", toolIcon("get_goal", undefined), "Target");
  equal("create_goal too", toolLabel("create_goal"), "创建目标");
  equal("a schedule tool", toolIcon("schedule_create", { type: "unknown" }), "CalendarClock");
  equal("a terminal tool", toolIcon("terminal_read", { type: "unknown" }), "SquareTerminal");
  equal("a background job", toolIcon("job_output", { type: "unknown" }), "Timer");
  equal("a plugin tool", toolIcon("cordis_run", { type: "unknown" }), "Plug");
  equal("a session tool", toolLabel("session_search"), "搜索会话");
  equal("reading an image", toolLabel("read_image"), "读取图片");

  // Paseo's own MCP tools carry an English `title` in its registry; these are
  // those titles in Chinese, so a row is not labelled with the wire name.
  equal("a Paseo MCP tool gets a Chinese label", toolLabel("mcp__paseo__delete_heartbeat"), "删除心跳");
  equal("and its own icon", toolIcon("mcp__paseo__delete_heartbeat", { type: "unknown" }), "HeartPulse");
  equal("a browser tool too", toolLabel("mcp__paseo__browser_list_tabs"), "列出浏览器标签页");
  equal("listing workspaces too", toolLabel("mcp__paseo__list_workspaces"), "列出工作区");

  // The four browser tools whose action has a standard glyph rather than the
  // page glyph the rest of the family shares. They used to have no entry at all,
  // so each fell to the wrench and then to Paseo's mark; 0.12's official catalog
  // gives every one of them a label (`harness/locale-check.cjs` compares those),
  // and these four now draw their own action glyph.
  const browserActionGlyphs = [
    ["browser_back", "后退", "ArrowLeft"],
    ["browser_forward", "前进", "ArrowRight"],
    ["browser_hover", "悬停元素", "MousePointer"],
    ["browser_reload", "刷新页面", "RotateCw"],
  ];
  for (const [bare, label, glyph] of browserActionGlyphs) {
    equal(`${bare} is labelled`, toolLabel(`mcp__paseo__${bare}`), label);
    equal(`${bare} draws its own glyph`, toolIcon(`mcp__paseo__${bare}`, { type: "unknown" }), glyph);
    const row = toolCallData(
      { name: `mcp__paseo__${bare}`, status: "completed", detail: { type: "unknown" } },
      "complete",
    );
    check(`${bare} no longer asks for Paseo's mark`, row.icon === glyph && row.paseoMark === false, row.icon);
    check(`${bare} no longer prints its wire name`, row.label !== `mcp__paseo__${bare}`, row.label);
  }
  // The bridge's MCP gateway exposes three meta tools; a proxied call carries
  // the real Paseo tool in its input. The row should keep the underlying tool's
  // icon/label, not the generic meta one.
  const gatewayDetail = { type: "unknown", input: { server: "paseo", tool: "delete_heartbeat" } };
  equal("a gateway call borrows the proxied tool's icon", toolIcon("mcp_call_tool", gatewayDetail), "HeartPulse");
  equal("and its Chinese label", toolLabel("mcp_call_tool", gatewayDetail), "删除心跳");
  equal(
    "the gateway row falls back to its own label for an unknown target",
    toolLabel("mcp_call_tool", { type: "unknown", input: { server: "paseo", tool: "not_a_paseo_tool" } }),
    "调用 MCP 工具",
  );
  equal(
    "another server's proxied call keeps the meta icon",
    toolIcon("mcp_call_tool", { type: "unknown", input: { server: "other", tool: "delete_heartbeat" } }),
    "Play",
  );
  equal("a gateway call with no detail keeps the meta icon", toolIcon("mcp_call_tool", undefined), "Play");
  const gatewayRow = toolCallData(
    {
      name: "mcp_call_tool",
      status: "completed",
      detail: { type: "unknown", input: { server: "paseo", tool: "create_heartbeat" }, output: { ok: true } },
    },
    "complete",
  );
  check("the rendered gateway row borrows the proxied icon", gatewayRow.icon === "HeartPulse", gatewayRow.icon);
  check("and its label", gatewayRow.label === "创建心跳", gatewayRow.label);

  // Anything we do not know keeps its wire name rather than losing its identity.
  equal(
    "an unknown Paseo tool falls back to the wire name",
    toolLabel("mcp__paseo__not_a_tool"),
    "mcp__paseo__not_a_tool",
  );
  equal(
    "another server's tool keeps its wire name",
    toolLabel("mcp__github__create_issue"),
    "mcp__github__create_issue",
  );
  equal(
    "and the wrench",
    toolIcon("mcp__github__create_issue", { type: "unknown" }),
    "Wrench",
  );

  // An unknown Paseo tool would draw the wrench; the row asks for Paseo's own mark
  // instead (`paseoMark`). A tool we do have a glyph for keeps it — Paseo's own UI
  // gives every one of its tools the same mark, which is coarser than this row.
  const unknownPaseo = toolCallData(
    { name: "mcp__paseo__not_a_tool", status: "completed", detail: { type: "unknown" } },
    "complete",
  );
  equal("an unknown Paseo tool still falls back to the wrench glyph", unknownPaseo.icon, "Wrench");
  check("…but is flagged for Paseo's own mark", unknownPaseo.paseoMark === true);
  check(
    "a mapped Paseo tool keeps its glyph and asks for no mark",
    unknownPaseo.paseoMark === true &&
      toolCallData(
        { name: "mcp__paseo__browser_list_tabs", status: "completed", detail: { type: "unknown" } },
        "complete",
      ).paseoMark === false,
  );
  check(
    "another server's unknown tool is not Paseo's",
    toolCallData({ name: "mcp__github__create_issue", status: "completed", detail: { type: "unknown" } }, "complete")
      .paseoMark === false,
  );
  // Paseo accepts four spellings of its own tool names; all of them must reach the
  // mark, not just the `mcp__paseo__` one this used to key on.
  for (const name of [
    "mcp__paseo__brand_new",
    "mcp__paseo_browser__brand_new",
    "paseo.brand_new",
    "paseo_browser.brand_new",
  ]) {
    check(
      `a Paseo tool spelled "${name}" gets the mark`,
      toolCallData({ name, status: "completed", detail: { type: "unknown" } }, "complete").paseoMark === true,
    );
  }
  // …and Paseo's own exception: a tool whose leaf is `speak` is never one of its
  // own, so an unmapped one must not borrow the mark.
  check(
    "a speak tool is not counted as Paseo's own",
    toolCallData({ name: "mcp__paseo__foo_speak", status: "completed", detail: { type: "unknown" } }, "complete")
      .paseoMark === false,
  );

  // A typed detail still wins: the name map only fills the `unknown` gap.
  equal("a typed detail keeps its own icon", toolIcon("bash", { type: "shell" }), "SquareTerminal");
}

console.log("the goal timeline rows draw the goal tools' own glyph");
{
  // `server/activity-timeline.ts` draws both goal rows as `plain_text` with **no**
  // `icon` key. The old shape sent `icon: "sparkles"`, which the protocol carries
  // verbatim — so the goal state row rendered Sparkles while the goal *tools* and
  // the composer's goal pill rendered Target. A plain_text row that names no glyph
  // now borrows the tool's own (the second gap the name map fills, after
  // `unknown`), which is what puts all three on the same symbol.
  setLocale("zh-CN");
  // The state row is the plugin's own `goal_state`, not the model's `get_goal`:
  // borrowing that name also borrowed its title, so the row read 「查看目标」 like
  // a real call. Same glyph, its own title.
  const stateRow = {
    name: "goal_state",
    status: "completed",
    detail: { type: "plain_text", label: "进行中 · 目标", text: "进行中 · 目标" },
  };
  equal("the goal state row draws Target", toolIcon(stateRow.name, stateRow.detail), "Target");
  equal("and its rendered data agrees", toolCallData(stateRow, "complete").icon, "Target");
  equal("the goal state row is titled 目标状态", toolCallData(stateRow, "complete").label, "目标状态");
  equal(
    "which is not the model's get_goal title",
    toolCallData({ name: "get_goal", status: "completed", detail: { type: "unknown", input: {}, output: null } }, "complete").label,
    "查看目标",
  );

  const roundRow = {
    name: "goal_round",
    status: "completed",
    detail: { type: "plain_text", label: "第 2 轮" },
    metadata: { locale: "zh-CN" },
  };
  equal("the goal round row draws Target", toolIcon(roundRow.name, roundRow.detail), "Target");
  const roundData = toolCallData(roundRow, "complete");
  equal("the goal round row's rendered glyph", roundData.icon, "Target");
  equal("its label comes from the client table", roundData.label, "目标续跑");
  equal("its summary is the round", roundData.summary, "第 2 轮");
  equal("it has no body to expand", roundData.hasDetail, false);
  equal("and it is a completed row, not a running tool", roundData.status, "completed");

  // The name map only fills the icon-less gap. Every other `plain_text` producer
  // sends an icon key and must keep its own glyph — a bare name lookup would turn
  // the workflow row into a wrench and the `/command` row into a terminal glyph
  // chosen by name rather than by the protocol.
  equal(
    "a workflow row keeps its protocol glyph",
    toolIcon("workflow", { type: "plain_text", icon: "bot" }),
    "Bot",
  );
  equal(
    "a /command row keeps its terminal glyph",
    toolIcon("/goal", { type: "plain_text", icon: "square_terminal" }),
    "SquareTerminal",
  );
  equal(
    "a todo row keeps its sparkles",
    toolIcon("todo_write", { type: "plain_text", icon: "sparkles" }),
    "Sparkles",
  );
  // A name with no entry keeps the generic plain_text glyph rather than a guess.
  equal(
    "an unmapped icon-less plain_text row stays on the wrench",
    toolIcon("not_a_tool", { type: "plain_text" }),
    "Wrench",
  );
  setLocale(undefined);
}

console.log("the title is not repeated when the block carries it");
{
  const described = toolCallData(
    {
      name: "bash",
      status: "completed",
      detail: { type: "shell", command: "pwd", output: "/tmp" },
      metadata: { description: "List DSH checkout root" },
    },
    "complete",
  );
  equal("a described row is titled", described.titled, true);

  const bare = toolCallData(
    {
      name: "update_goal",
      status: "completed",
      detail: { type: "unknown", input: { action: "complete" }, output: "ok" },
    },
    "complete",
  );
  equal("a description-less row is not", bare.titled, false);
  // L1: the title names the call's own argument, and the block carries the same
  // subject as a facts entry — not as a second, pretty-printed JSON copy.
  equal("its title names the call's own argument", bare.summary, "action: complete");
  equal("and the block carries the same subject as an entry", bare.fields.args, [
    { kind: "fact", label: "action", value: "complete" },
  ]);
  equal("…with no pretty-printed lead above it", bare.headline, "");
}

console.log("the block kind is explicit (DSH's own dispatch)");
{
  // The renderer used to guess "this is a shell row" from the absence of a diff
  // and a code flag plus the body caption. `kind` replaces that guess, so a row
  // that changes shape without changing caption can no longer pick the wrong
  // block — and a caption that changes language cannot either.
  const cases = [
    ["bash", { type: "shell", command: "ls" }, "terminal"],
    ["pwsh", { type: "shell", command: "ls" }, "terminal"],
    ["read", { type: "read", filePath: "/a.ts" }, "read"],
    ["edit", { type: "edit", filePath: "/a.ts" }, "diff"],
    ["write", { type: "write", filePath: "/a.ts" }, "diff"],
    ["grep", { type: "search", toolName: "grep", query: "x" }, "search"],
    ["glob", { type: "search", toolName: "glob", query: "x" }, "search"],
    ["web_search", { type: "search", toolName: "web_search", query: "x" }, "web"],
    ["web_fetch", { type: "fetch", url: "https://x" }, "web"],
    ["subagent", { type: "sub_agent" }, "generic"],
    ["exit_plan_mode", { type: "plan" }, "generic"],
    ["todo_write", { type: "plain_text" }, "generic"],
    ["mcp__paseo__list_workspaces", { type: "unknown", input: {} }, "generic"],
  ];
  for (const [name, detail, expected] of cases) {
    equal(
      `${name} -> ${expected}`,
      toolCallData({ name, status: "completed", detail }, "complete").kind,
      expected,
    );
  }
  // An older item may not carry `toolName`; the item's own name answers then.
  equal(
    "a search detail with no toolName is still a file search",
    toolCallData(
      { name: "grep", status: "completed", detail: { type: "search", query: "x" } },
      "complete",
    ).kind,
    "search",
  );
  // The old guess required a non-empty command; the explicit field does not.
  equal(
    "a shell row with no command is still the terminal block",
    toolCallData(
      { name: "bash", status: "completed", detail: { type: "shell", command: "", output: "boom" } },
      "complete",
    ).kind,
    "terminal",
  );
}

console.log("grep: matches grouped by file, with the tool's own totals");
{
  const files = [
    {
      path: "client/newest.ts",
      matches: [
        { lineNumber: 42, line: "  const handle = persistence.handle;" },
        { lineNumber: 88, line: "  if (handle === undefined) return;" },
      ],
    },
    {
      path: "server/session.ts",
      matches: [{ lineNumber: 563, line: "  // persistence handle names a DSH session" }],
    },
  ];
  const grep = toolCallData(
    {
      name: "grep",
      status: "completed",
      detail: {
        type: "search",
        toolName: "grep",
        query: "handle",
        content: "raw result text",
      },
      metadata: {
        presentationMeta: { shape: "matches", total: 12, truncated: true, files }
      },
    },
    "complete",
  );
  check("the grep card exists at all", grep.search !== null);
  equal("kind", grep.kind, "search");
  equal("shape", grep.search?.shape, "matches");
  equal("one group per file", grep.search?.files.length, 2);
  equal("the first group's path", grep.search?.files[0].path, "client/newest.ts");
  equal("the first group's count", grep.search?.files[0].count, 2);
  equal("the second group's count", grep.search?.files[1].count, 1);
  equal("a match keeps its line number", grep.search?.files[0].matches[0].lineNumber, 42);
  equal("and its line", grep.search?.files[0].matches[0].line, "  const handle = persistence.handle;");
  equal("shown is the retained match count, not the folded row count", grep.search?.shown, 3);
  equal("total is the pre-cap count", grep.search?.total, 12);
  equal("truncated survives", grep.search?.truncated, true);
  equal(
    "the copy text is DSH's (path, then `line: text`, blank line between files)",
    grep.search?.text,
    "client/newest.ts\n42:   const handle = persistence.handle;\n88:   if (handle === undefined) return;\n\nserver/session.ts\n563:   // persistence handle names a DSH session",
  );
  equal(
    "the banner reads shown / total / files",
    blockCopy().matchesSummary(
      grep.search?.shown,
      grep.search?.total,
      grep.search?.files.length,
      grep.search?.truncated,
    ),
    "显示 3 / 共 12 处匹配 · 2 个文件",
  );

  const whole = toolCallData(
    {
      name: "grep",
      status: "completed",
      detail: {
        type: "search",
        toolName: "grep",
        query: "handle",
        content: "raw",
      },
      metadata: {
        presentationMeta: { shape: "matches", total: 3, truncated: false, files }
      },
    },
    "complete",
  );
  equal("an untruncated banner drops the total clause", whole.search?.truncated, false);
  equal(
    "and reads as a plain count",
    blockCopy().matchesSummary(3, 3, 2, false),
    "3 处匹配 · 2 个文件",
  );

  const emptyGroup = toolCallData(
    {
      name: "grep",
      status: "completed",
      detail: {
        type: "search",
        toolName: "grep",
        query: "nothing",
        content: "raw",
      },
      metadata: {
        presentationMeta: { shape: "matches", total: 0, truncated: false, files: [{ path: "a.ts", matches: [] }] }
      },
    },
    "complete",
  );
  equal("a file group with no matches is still a group", emptyGroup.search?.files[0].count, 0);
  equal("and shown is zero", emptyGroup.search?.shown, 0);
}

console.log("glob: a flat path list");
{
  const glob = toolCallData(
    {
      name: "glob",
      status: "completed",
      detail: {
        type: "search",
        toolName: "glob",
        query: "**/*.ts",
      },
      metadata: {
        presentationMeta: { shape: "paths", paths: ["a.ts", "b/c.ts"], total: 9, truncated: true }
      },
    },
    "complete",
  );
  check("the glob card exists at all", glob.search !== null);
  equal("kind", glob.kind, "search");
  equal("shape", glob.search?.shape, "paths");
  equal("the paths", JSON.stringify(glob.search?.paths), '["a.ts","b/c.ts"]');
  equal("shown is the path count", glob.search?.shown, 2);
  equal("total is the pre-cap count", glob.search?.total, 9);
  equal("the copy text is one path per line", glob.search?.text, "a.ts\nb/c.ts");
  equal("the truncated banner", blockCopy().pathsSummary(2, 9, true), "显示 2 / 共 9 个路径");
  equal("the plain banner", blockCopy().pathsSummary(2, 2, false), "2 个路径");
}

console.log("an unrecognized meta falls back to the plain text row");
{
  // `失败要响亮`: a shape the parser does not know must not produce a blank card.
  // The row keeps the kind it dispatches to (so the block is still the right
  // one) but carries no structured payload, and the renderer draws the body it
  // drew before this phase.
  const cases = [
    ["grep without a total", { type: "search", toolName: "grep", content: "raw" }, { shape: "matches", files: [] }],
    [
      "grep with a non-numeric line number",
      { type: "search", toolName: "grep", content: "raw" },
      { shape: "matches", total: 1, files: [{ path: "a", matches: [{ lineNumber: "42", line: "x" }] }] },
    ],
    ["grep with an unknown shape", { type: "search", toolName: "grep", content: "raw" }, { shape: "lines", total: 1 }],
    ["glob with a non-string path", { type: "search", toolName: "glob", content: "raw" }, { shape: "paths", paths: [1], total: 1 }],
    ["read without lines", { type: "read", filePath: "/a.ts", content: "raw" }, { totalLines: 3, lang: "typescript" }],
    ["read with an incomplete line", { type: "read", filePath: "/a.ts", content: "raw" }, { totalLines: 3, lines: [{ number: 1 }] }],
    ["write with an incomplete diff", { type: "write", filePath: "/a.ts", content: "raw" }, { operation: "update", diffs: [{ path: "/a.ts", oldText: "a" }] }],
    ["edit with diffs that are not a list", { type: "edit", filePath: "/a.ts", unifiedDiff: "@@\n-a\n+b" }, { diffs: "nope" }, "@@\n-a\n+b"],
    ["web_search with a non-array sources", { type: "search", toolName: "web_search", content: "raw" }, { sources: {}, truncated: false }],
    ["web_fetch without a status code", { type: "fetch", url: "https://x", result: "raw" }, { url: "https://x", truncated: false }],
    ["a non-object meta", { type: "read", filePath: "/a.ts", content: "raw" }, "nope"],
  ];
  for (const [label, detail, meta, expectedBody] of cases) {
    const data = toolCallData(
      { name: "grep", status: "completed", detail, metadata: { presentationMeta: meta } },
      "complete",
    );
    const payload = data.search ?? data.read ?? data.diffBlock ?? data.web;
    check(`${label}: the structured payload is refused`, payload === null, JSON.stringify(payload));
    check(
      `${label}: the plain body survives`,
      data.body === (expectedBody ?? "raw"),
      JSON.stringify(data.body),
    );
    check(`${label}: and the row still expands`, data.hasDetail === true);
  }

  // No meta at all is the normal case for a failed tool and for `bash`.
  const noMeta = toolCallData(
    { name: "read", status: "completed", detail: { type: "read", filePath: "/a.ts", content: "raw" } },
    "complete",
  );
  check("no meta: no read card", noMeta.read === null);
  equal("but the content is still the body", noMeta.body, "raw");
  equal("and the kind is still read", noMeta.kind, "read");

  // Where the meta is read from, stated both ways. The plugin subprocess parses
  // every outgoing event with `ProviderEventSchema.parse`, whose
  // `toolCallDetailSchema` members are all `.strip()` — a `detail.meta` is
  // deleted before the client ever sees it, which is why the field lives on the
  // item's `metadata`. `timeline-check.cjs` runs that parse for real.
  const readMeta = {
    path: "client/newest.ts",
    offset: 41,
    lang: "typescript",
    totalLines: 120,
    lines: [{ number: 41, text: "export function noteRender(agentId, at) {" }],
  };
  const onDetail = toolCallData(
    {
      name: "read",
      status: "completed",
      detail: { type: "read", filePath: "/abs/a.ts", content: "raw", meta: readMeta },
    },
    "complete",
  );
  check(
    "a detail-level meta is ignored (the schema strips it in transit)",
    onDetail.read === null,
    JSON.stringify(onDetail.read),
  );
  const onMetadata = toolCallData(
    {
      name: "read",
      status: "completed",
      detail: { type: "read", filePath: "/abs/a.ts", content: "raw" },
      metadata: { locale: "zh-CN", presentationMeta: readMeta },
    },
    "complete",
  );
  check(
    "the item's metadata is where the card reads it from",
    onMetadata.read !== null && onMetadata.read.lang === "typescript",
    JSON.stringify(onMetadata.read),
  );
  check(
    "and the rest of the metadata is untouched by it",
    onMetadata.read.path === "client/newest.ts",
    JSON.stringify(onMetadata.read),
  );
}

console.log("read: numbered lines and the language");
{
  const read = toolCallData(
    {
      name: "read",
      status: "completed",
      detail: {
        type: "read",
        filePath: "/abs/a.ts",
        content: "raw",
      },
      metadata: {
        presentationMeta: {
          path: "client/newest.ts",
          offset: 41,
          lang: "typescript",
          totalLines: 120,
          lines: [
            { number: 41, text: "export function noteRender(agentId, at) {" },
            { number: 42, text: "  const handle = persistence.handle;" },
          ],
        }
      },
    },
    "complete",
  );
  check("the read card exists at all", read.read !== null);
  equal("kind", read.kind, "read");
  equal("the card's path is the meta's own", read.read?.path, "client/newest.ts");
  equal("the language", read.read?.lang, "typescript");
  equal("the line count", read.read?.lines.length, 2);
  equal("the first number", read.read?.lines[0].number, 41);
  equal("the first text", read.read?.lines[0].text, "export function noteRender(agentId, at) {");
  equal("the file's total", read.read?.totalLines, 120);
  check("the card is windowed (DSH shows `显示 X / Y 行`)", read.read?.lines.length < read.read?.totalLines);
  equal(
    "the copy text is the lines",
    read.read?.text,
    "export function noteRender(agentId, at) {\n  const handle = persistence.handle;",
  );
  equal("the window copy", blockCopy().window(2, 120), "显示 2 / 120 行");

  const noPath = toolCallData(
    {
      name: "read",
      status: "completed",
      detail: { type: "read", filePath: "/abs/a.ts", content: "raw" },
      metadata: { presentationMeta: { totalLines: 1, lines: [{ number: 1, text: "x" }] } },
    },
    "complete",
  );
  equal("without meta.path the protocol path is used", noPath.read?.path, "/abs/a.ts");
  equal("a missing lang is empty, not fabricated", noPath.read?.lang, "");
}

console.log("edit: a real hunk diff from meta.diffs");
{
  const edit = toolCallData(
    {
      name: "edit",
      status: "completed",
      detail: {
        type: "edit",
        filePath: "/a.ts",
      },
      metadata: {
        presentationMeta: { diffs: [{ path: "/a.ts", oldText: "a\nb\nc\nd", newText: "a\nb\nX\nd" }] }
      },
    },
    "complete",
  );
  check("the edit card exists at all", edit.diffBlock !== null);
  equal("kind", edit.kind, "diff");
  equal("operation is empty for an edit", edit.diffBlock?.operation, "");
  equal("the card's path", edit.diffBlock?.path, "/a.ts");
  equal(
    "rows: a hunk header, then context/remove/add with DSH's own line ordering",
    JSON.stringify(edit.diffBlock?.rows),
    JSON.stringify([
      { kind: "hunk", text: "@@ -1,4 +1,4 @@" },
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
      { kind: "del", text: "c" },
      { kind: "add", text: "X" },
      { kind: "context", text: "d" },
    ]),
  );
  equal(
    "the body is a unified diff",
    edit.body,
    "--- /a.ts\n+++ /a.ts\n@@ -1,4 +1,4 @@\n a\n b\n-c\n+X\n d",
  );
  equal("the +A -R stat reads straight off that body", JSON.stringify(diffStat(edit)), '{"added":1,"removed":1}');

  const oldLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const newLines = [...oldLines];
  newLines[0] = "zero";
  newLines[19] = "nineteen";
  const multi = toolCallData(
    {
      name: "edit",
      status: "completed",
      detail: {
        type: "edit",
        filePath: "/a.ts",
      },
      metadata: {
        presentationMeta: { diffs: [{ path: "/a.ts", oldText: oldLines.join("\n"), newText: newLines.join("\n") }] }
      },
    },
    "complete",
  );
  const hunks = multi.diffBlock?.rows.filter((row) => row.kind === "hunk").map((row) => row.text);
  equal("two distant changes make two hunks", JSON.stringify(hunks), '["@@ -1,4 +1,4 @@","@@ -17,4 +17,4 @@"]');
  check(
    "each hunk keeps exactly three context lines at its inner edge",
    multi.diffBlock?.rows.filter((row) => row.kind === "context").length === 3 + 3,
    String(multi.diffBlock?.rows.filter((row) => row.kind === "context").length),
  );
  equal("and the stat counts both", JSON.stringify(diffStat(multi)), '{"added":2,"removed":2}');

  const twoFiles = toolCallData(
    {
      name: "edit",
      status: "completed",
      detail: {
        type: "edit",
        filePath: "/a.ts",
      },
      metadata: {
        presentationMeta: {
          diffs: [
            { path: "/a.ts", oldText: "a", newText: "b" },
            { path: "/b.ts", oldText: "c", newText: "d" },
          ],
        }
      },
    },
    "complete",
  );
  equal(
    "a second file gets its own path row",
    JSON.stringify(twoFiles.diffBlock?.rows.filter((row) => row.kind === "path").map((row) => row.text)),
    '["/a.ts","/b.ts"]',
  );
  check(
    "and the body names both",
    twoFiles.body.includes("--- /a.ts") && twoFiles.body.includes("+++ /b.ts"),
    twoFiles.body,
  );

  const sameFileTwice = toolCallData(
    {
      name: "edit",
      status: "completed",
      detail: {
        type: "edit",
        filePath: "/a.ts",
      },
      metadata: {
        presentationMeta: {
          diffs: [
            { path: "/a.ts", oldText: "a", newText: "b" },
            { path: "/a.ts", oldText: "c", newText: "d" },
          ],
        }
      },
    },
    "complete",
  );
  check(
    "two hunks of one file are separated by DSH's gap row, not a second path row",
    sameFileTwice.diffBlock?.rows.some((row) => row.kind === "gap" && row.text === "⋯") &&
      !sameFileTwice.diffBlock?.rows.some((row) => row.kind === "path"),
  );
}

console.log("write: create and update are told apart");
{
  const created = toolCallData(
    {
      name: "write",
      status: "completed",
      detail: {
        type: "write",
        filePath: "/new.ts",
        content: "one\ntwo\n",
      },
      metadata: {
        presentationMeta: { operation: "create", diffs: [] }
      },
    },
    "complete",
  );
  check("the create card exists at all (a write with empty diffs uses its content)", created.diffBlock !== null);
  equal("kind", created.kind, "diff");
  equal("operation", created.diffBlock?.operation, "create");
  equal(
    "a create is all additions (DSH's argument-derived whole-file diff)",
    JSON.stringify(created.diffBlock?.rows),
    JSON.stringify([
      { kind: "hunk", text: "@@ -0,0 +1,2 @@" },
      { kind: "add", text: "one" },
      { kind: "add", text: "two" },
    ]),
  );
  equal("the body", created.body, "--- /new.ts\n+++ /new.ts\n@@ -0,0 +1,2 @@\n+one\n+two");
  equal("the stat is +2 -0, so the row's suffix now appears", JSON.stringify(diffStat(created)), '{"added":2,"removed":0}');
  equal("the create label", blockCopy().create, "新建");

  const updated = toolCallData(
    {
      name: "write",
      status: "completed",
      detail: {
        type: "write",
        filePath: "/a.ts",
        content: "a\nc",
      },
      metadata: {
        presentationMeta: { operation: "update", diffs: [{ path: "/a.ts", oldText: "a\nb", newText: "a\nc" }] }
      },
    },
    "complete",
  );
  equal("operation", updated.diffBlock?.operation, "update");
  equal("the body", updated.body, "--- /a.ts\n+++ /a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c");
  equal("the stat", JSON.stringify(diffStat(updated)), '{"added":1,"removed":1}');
  equal("the update label", blockCopy().update, "更新");
}

console.log("web: citations and the fetch status");
{
  const search = toolCallData(
    {
      name: "web_search",
      status: "completed",
      detail: {
        type: "search",
        toolName: "web_search",
        query: "paseo plugin api",
      },
      metadata: {
        presentationMeta: {
          truncated: true,
          sources: [
            { url: "https://docs.example/a", title: "Paseo Plugin API" },
            { url: "https://docs.example/b" },
          ],
        }
      },
    },
    "complete",
  );
  check("the web search card exists at all", search.web !== null);
  equal("kind", search.kind, "web");
  equal("shape", search.web?.shape, "search");
  equal("one entry per source", search.web?.sources.length, 2);
  equal("the title is the link text", search.web?.sources[0].label, "Paseo Plugin API");
  equal("an untitled source falls back to its hostname", search.web?.sources[1].label, "docs.example");
  equal("truncated survives", search.web?.truncated, true);
  // DSH has two empty-state keys, not one: `search.noResults` (无结果 /
  // "No results") for the grep/glob card and `web.noResults` (未找到结果 /
  // "No results found") for this one. The single shared string this used to read
  // was the web wording in English and the search wording in Chinese — wrong on
  // both sides at once.
  equal("the web empty state (DSH web.noResults)", blockCopy().webNoResults, "未找到结果");
  equal("the search empty state is a different string (DSH search.noResults)", blockCopy().noResults, "无结果");
  check(
    "and the two are not the same string in either language",
    allBlockCopy().en.noResults !== allBlockCopy().en.webNoResults &&
      allBlockCopy()["zh-CN"].noResults !== allBlockCopy()["zh-CN"].webNoResults,
    JSON.stringify([
      allBlockCopy().en.noResults,
      allBlockCopy().en.webNoResults,
      allBlockCopy()["zh-CN"].noResults,
      allBlockCopy()["zh-CN"].webNoResults,
    ]),
  );
  equal("the truncation note", blockCopy().sourcesTruncated, "来源列表已截断");

  // The current DSH build sends only url/title (72 sources sampled, 0 with a
  // snippet). Optional fields are carried when present and left empty when not,
  // so a newer tool's snippet shows up rather than being invented or dropped.
  const rich = toolCallData(
    {
      name: "web_search",
      status: "completed",
      detail: {
        type: "search",
        toolName: "web_search",
        query: "q",
      },
      metadata: {
        presentationMeta: {
          truncated: false,
          answer: "The answer.",
          sources: [{ url: "https://a.example", title: "A", snippet: "snip", publishedAt: "2026-03-02" }],
        }
      },
    },
    "complete",
  );
  equal("an answer survives", rich.web?.answer, "The answer.");
  equal("a snippet survives", rich.web?.sources[0].snippet, "snip");
  equal("and a date survives", rich.web?.sources[0].publishedAt, "2026-03-02");
  equal("a source without one has an empty snippet, not a fabricated one", search.web?.sources[0].snippet, "");
  equal("and an empty date", search.web?.sources[0].publishedAt, "");
  equal("and no answer", search.web?.answer, "");

  const fetch = toolCallData(
    {
      name: "web_fetch",
      status: "completed",
      detail: {
        type: "fetch",
        url: "https://x/y",
        result: "raw",
      },
      metadata: {
        presentationMeta: { url: "https://x/y", statusCode: 200, truncated: true }
      },
    },
    "complete",
  );
  check("the fetch card exists at all", fetch.web !== null);
  equal("kind", fetch.kind, "web");
  equal("shape", fetch.web?.shape, "fetch");
  equal("the final url (after redirects)", fetch.web?.url, "https://x/y");
  equal("the status code", fetch.web?.statusCode, 200);
  equal("the http label", blockCopy().http, "HTTP");
  equal("the content note", blockCopy().contentTruncated, "内容已截断");
  equal("a fetch card has no sources", fetch.web?.sources.length, 0);
}

console.log("link labels (DSH's linkLabel)");
{
  equal("a title wins", linkLabel("https://x/y", "T"), "T");
  equal("the hostname is the fallback", linkLabel("https://docs.example/a?b=1", ""), "docs.example");
  equal("a port is dropped", linkLabel("http://localhost:8080/x", ""), "localhost");
  equal("credentials are dropped", linkLabel("https://user:pw@x.example/y", ""), "x.example");
  equal("a non-URL keeps its text", linkLabel("not a url", ""), "not a url");
}

console.log("the hunk builder's own rules");
{
  equal("contentLines drops one trailing newline", JSON.stringify(contentLines("a\nb\n")), '["a","b"]');
  equal("an interior blank line survives", JSON.stringify(contentLines("a\n\nb")), '["a","","b"]');
  equal("empty text is no lines", JSON.stringify(contentLines("")), "[]");
  equal(
    "the edit script keeps the lines both sides share as context",
    JSON.stringify(diffOps("a\nb\nc", "a\nX\nc").map((op) => `${op.kind}:${op.text}`)),
    '["context:a","del:b","add:X","context:c"]',
  );
  equal(
    "a whole-file create is additions only",
    JSON.stringify(diffOps("", "one\ntwo").map((op) => `${op.kind}:${op.text}`)),
    '["add:one","add:two"]',
  );
  equal("no changes is no hunks", diffHunks(diffOps("a\nb", "a\nb")).length, 0);

  const one = toolCallData(
    {
      name: "edit",
      status: "completed",
      detail: { type: "edit", filePath: "/a.ts" },
      metadata: { presentationMeta: { diffs: [{ path: "/a.ts", oldText: "a", newText: "b" }] } },
    },
    "complete",
  );
  equal(
    "a one-line hunk elides the `,1` the way unified diffs do",
    one.diffBlock?.rows[0].text,
    "@@ -1 +1 @@",
  );
}

console.log("the block copy is localized and complete");
{
  equal("zh copy", blockCopy().copy, "复制");
  equal("zh copied", blockCopy().copied, "复制成功");
  equal("zh collapse", blockCopy().collapse, "收起");
  equal("zh expandRest", blockCopy().expandRest(3), "… 其余 3 行");
  equal("zh expandAria", blockCopy().expandAria(3), "展开其余 3 行");
  equal("zh collapseAria", blockCopy().collapseAria, "收起内容");
  equal("zh matches", blockCopy().matchesSummary(12, 12, 3, false), "12 处匹配 · 3 个文件");
  equal(
    "zh matches truncated",
    blockCopy().matchesSummary(3, 12, 3, true),
    "显示 3 / 共 12 处匹配 · 3 个文件",
  );
  equal("zh search empty state", blockCopy().noResults, "无结果");
  equal("zh web empty state", blockCopy().webNoResults, "未找到结果");

  setLocale("en");
  equal("en copy", blockCopy().copy, "Copy");
  equal("en expandRest", blockCopy().expandRest(3), "… 3 more lines");
  equal("en matches", blockCopy().matchesSummary(12, 12, 3, false), "12 matches · 3 files");
  equal(
    "en matches truncated",
    blockCopy().matchesSummary(3, 12, 3, true),
    "Showing 3 of 12 matches · 3 files",
  );
  equal("en search empty state", blockCopy().noResults, "No results");
  equal("en web empty state", blockCopy().webNoResults, "No results found");
  equal("en paths truncated", blockCopy().pathsSummary(2, 9, true), "Showing 2 of 9 paths");
  equal("en window", blockCopy().window(2, 120), "Showing 2 of 120 lines");
  equal("en content note", blockCopy().contentTruncated, "Content truncated");
  setLocale(undefined);

  const tables = allBlockCopy();
  equal(
    "both locales define the same block-copy keys",
    Object.keys(tables.en).sort(),
    Object.keys(tables["zh-CN"]).sort(),
  );
  equal("and the client is back to zh-CN", blockCopy().copy, "复制");
}

console.log("the meta key is the same on both sides of the plugin");
{
  // The server half and the client half are separate builds and neither can
  // import the other's constant, so the one thing they must agree on is the
  // string. A rename on one side would leave every structured block silently
  // falling back to plain text — the exact failure this phase exists to avoid.
  const readKey = (file, label) => {
    check(`${label} is readable`, file !== undefined, `looked above ${__dirname}`);
    if (file === undefined) return null;
    const match = /PRESENTATION_META_KEY[^=]*=\s*"([^"]+)"/.exec(fs.readFileSync(file, "utf8"));
    check(`${label} declares the key as a literal`, match !== null);
    return match === null ? null : match[1];
  };
  const serverKey = readKey(findRepoFile("server/timeline.ts"), "server/timeline.ts");
  const clientKey = readKey(findRepoFile("client/tool-call-data.ts"), "client/tool-call-data.ts");
  equal("both halves name the same metadata key", clientKey, serverKey);
  equal("and it is the one the tests feed in", serverKey, "presentationMeta");
}

console.log("the tool transformer adopts the item's locale before it maps");
{
  // The relay is one line in `index.client.tsx`, and the file cannot be
  // `require`d offline (it pulls in the renderers, which import the host
  // runtime). So the wiring is read out of the source, and the *behaviour* of
  // the two functions it calls is asserted in `locale-check.cjs`
  // ("a tool row adopts the locale its item carries"). Together they cover the
  // line: remove it and this fails, break what it calls and that fails.
  const sourcePath = findRepoFile("index.client.tsx");
  check("index.client.tsx is readable", sourcePath !== undefined, path.join(__dirname, "index.client.tsx"));
  const source = sourcePath === undefined ? "" : fs.readFileSync(sourcePath, "utf8");

  // The relay is "setLocale receives localeFromMetadata(item.metadata)", read as
  // a call graph rather than as its spelling: the old regex pinned the exact
  // nesting `setLocale(localeFromMetadata(item.metadata))`, so binding the inner
  // call to a local first (an equivalent refactor) failed while the locale still
  // reached setLocale. What matters is that both calls happen, in that order,
  // and that the inner one reads `item.metadata`.
  const setLocaleArgs = callArguments(source, "setLocale");
  const localeFromMetadataArgs = callArguments(source, "localeFromMetadata");
  // `setLocale(localeFromMetadata(item.metadata))` may also be written by hoisting
  // the inner call into a local (`const relayed = localeFromMetadata(...);
  // setLocale(relayed)`) — same wiring, different shape. So the claim is: some
  // `setLocale` argument is fed by `localeFromMetadata`, either directly or
  // through an identifier assigned from it.
  const hoisted = [];
  for (const args of localeFromMetadataArgs) {
    // `const relayed = localeFromMetadata(...)` — capture the binding name.
    const at = source.indexOf(`localeFromMetadata(${args}`);
    if (at < 0) continue;
    const before = source.slice(Math.max(0, at - 120), at);
    const binding = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
    if (binding !== null) hoisted.push(binding[1]);
  }
  const relayArgs = setLocaleArgs.filter(
    (args) => mentions(args, "localeFromMetadata") || hoisted.some((name) => mentions(args, name)),
  );
  check(
    "the transformer relays metadata.locale with setLocale(localeFromMetadata(...))",
    relayArgs.length > 0,
    `${setLocaleArgs.map((args) => `setLocale(${args.trim()})`).join(" | ") || "(no setLocale call)"}`
      + (hoisted.length === 0 ? "" : ` (hoisted via ${hoisted.join(", ")})`),
  );
  check(
    "…and that relay reads the item's own metadata",
    localeFromMetadataArgs.some((args) => mentions(args, "metadata")),
    localeFromMetadataArgs.map((args) => `localeFromMetadata(${args.trim()})`).join(" | ") || "(no call)",
  );

  // Position claims are about the *order of the calls in the source*, so they are
  // read from the parsed call sites rather than from `String.indexOf` over a
  // possibly-reflowed literal.
  const toolTransformer = source.indexOf('id: "dsh-inline-tool"');
  const thinkingTransformer = source.indexOf('id: "dsh-inline-thinking"');
  const callSite = (name) => {
    const pattern = new RegExp(`(^|[^\\w$])${name}\\s*\\(`, "g");
    const match = pattern.exec(source);
    return match === null ? -1 : match.index;
  };
  const relay = relayArgs.length > 0 ? callSite("setLocale") : -1;
  const mapping = callSite("toolCallData");
  check(
    "and it sits inside the tool transformer",
    toolTransformer >= 0 && relay > toolTransformer,
    `transformer at ${toolTransformer}, relay at ${relay}`,
  );
  check(
    "before the item is mapped",
    relay >= 0 && mapping > relay,
    `relay at ${relay}, toolCallData at ${mapping}`,
  );
  check(
    "the reasoning transformer is left alone (its item has no metadata to relay)",
    thinkingTransformer >= 0 && toolTransformer > thinkingTransformer && !/setLocale/.test(source.slice(thinkingTransformer, toolTransformer)),
  );
}

console.log("the renderer's schema and ToolCallData cannot drift apart");
{
  // The client half hands the renderer `{ ...toolCallData(item, phase) }`, and
  // Paseo validates that payload against the zod schema registered next to it.
  // A field added to only one side is invisible: the extra key is stripped
  // before the component sees it, or the component quietly stops receiving it.
  // Nothing errors in either case, so the two key sets are asserted here — at
  // the data layer, where this repo's rules say silent failures must be caught.
  const sourcePath = findRepoFile("index.client.tsx");
  check(
    "index.client.tsx is readable",
    sourcePath !== undefined,
    `looked above ${__dirname}`,
  );

  const schemaKeys = sourcePath === undefined ? [] : dshToolSchemaKeys(fs.readFileSync(sourcePath, "utf8"));
  check("the dsh-tool renderer's schema was found", schemaKeys.length > 0, JSON.stringify(schemaKeys));

  const dataKeys = Object.keys(
    toolCallData(
      { name: "bash", status: "completed", detail: { type: "shell", command: "ls" } },
      "complete",
    ),
  );
  equal(
    "the schema's field set matches ToolCallData exactly",
    [...schemaKeys].sort(),
    [...dataKeys].sort(),
  );

  // F5: the generic card's inner shape, compared against the data layer's own
  // runtime shapes. A key or enum member the schema omits is stripped before the
  // row sees it, and nothing errors — so the sets are pinned, not sampled.
  const schemaSource = sourcePath === undefined ? "" : fs.readFileSync(sourcePath, "utf8");
  const inner = schemaSource === "" ? undefined : dshFieldsSchema(schemaSource);
  check(
    "the generic card's inner schema was found",
    inner !== undefined && inner.fields.length > 0 && inner.entry.length > 0,
    JSON.stringify(inner),
  );
  const innerSample = toolCallData(
    {
      name: "mcp__x__inner",
      status: "completed",
      detail: { type: "unknown", input: { a: 1, o: { b: 2 }, t: "x\ny" }, output: "" },
    },
    "complete",
  ).fields;
  equal(
    "the fields object declares exactly ToolFieldsData's keys",
    [...(inner?.fields ?? [])].sort(),
    Object.keys(innerSample).sort(),
  );
  equal(
    "…and one entry declares exactly ToolFieldEntry's keys",
    [...(inner?.entry ?? [])].sort(),
    Object.keys(innerSample.args[0]).sort(),
  );
  // Every kind the data layer can produce, derived by producing it: an enum the
  // schema declares but nothing emits (or one it omits) fails here.
  const producedKinds = new Set();
  for (const detail of [
    { type: "unknown", input: { a: 1 }, output: "" },
    { type: "unknown", input: { t: "x\ny" }, output: "" },
    { type: "unknown", input: { o: { b: 2 } }, output: "" },
  ]) {
    const produced = toolCallData({ name: "mcp__x__kind", status: "completed", detail }, "complete").fields;
    for (const entry of produced.args) producedKinds.add(entry.kind);
  }
  const codeRow = toolCallData(
    { name: "run_code", status: "completed", detail: { type: "unknown", input: { code: "x" }, output: "y" } },
    "complete",
  );
  for (const entry of codeRow.fields.args) producedKinds.add(entry.kind);
  const kindsSorted = [...producedKinds].sort();
  equal("the data layer produces all four entry kinds", kindsSorted, ["code", "fact", "json", "text"]);
  equal(
    "…and both halves' kind enums are exactly that set",
    (inner?.kinds ?? []).map((members) => [...members].sort()),
    [kindsSorted, kindsSorted],
  );
}

console.log("the renderer reads the state the data layer now carries");
{
  // Three fixes end at the component, and a component that never reads its
  // input is indistinguishable from a data layer that never produced it. This
  // file imports React Native, so plain `node` cannot `require` it; the wiring
  // is read out of the source while the data-layer sections above assert what
  // the mapper produces. Comments are stripped first — a doc comment that names
  // the field must not satisfy the check.
  const sourcePath = findRepoFile("client/tool-call.tsx");
  check("tool-call.tsx is readable", sourcePath !== undefined, `looked above ${__dirname}`);
  const rendered = sourcePath === undefined ? "" : fs.readFileSync(sourcePath, "utf8");
  // Comments are stripped **before** the body is located: the JSX reader's
  // brace matcher does not skip comments, and a prose comment inside this
  // component contains an apostrophe (`row's`), which it would take for the
  // start of a string and run past the body. Stripping first removes the
  // apostrophes and keeps the claim about code, not commentary.
  const component = functionBody(codeOnly(rendered), "InlineToolCall") ?? "";
  check("the row component was found", component.length > 0, "InlineToolCall body is missing");

  // C1: the head shows why the call failed, in the summary slot DSH uses
  // (`.errorSummary`), and the expansion carries the whole reason.
  check("the row reads the failure reason", mentions(component, "error"), "no `error` read in the component");
  const summaryElements = elementsWithAttributes(component, ["style", "numberOfLines"]);
  check(
    "the head's summary slot turns red for a failure",
    summaryElements.some((element) => {
      const style = attributeOf(element, "style").value;
      return mentions(style, "summary") && mentions(style, "summaryError");
    }),
    summaryElements.map((element) => attributeOf(element, "style").value.trim()).join(" | "),
  );
  check(
    "and the expansion draws the reason as its own text",
    elementsWithAttributes(component, ["style"]).some((element) =>
      mentions(attributeOf(element, "style").value, "errorText"),
    ),
    "no element styled with errorText",
  );

  // CT-02: the terminal card scrolls its output in DSH's capped window and
  // hands the copy control the whole string rather than the visible part.
  const terminalScroll = elementsWithAttributes(component, ["style", "contentContainerStyle"]).filter(
    (element) => element.tag === "ScrollView" && mentions(attributeOf(element, "style").value, "terminalOutput"),
  );
  check(
    "the terminal output sits in a capped scroll region",
    terminalScroll.length === 1,
    `${terminalScroll.length} matching ScrollView element(s)`,
  );
  const terminalCopy = elementsWithAttributes(component, ["text"]).filter(
    (element) => element.tag === "CopyControl" && mentions(attributeOf(element, "text").value, "body"),
  );
  check(
    "…and its copy control gets the whole output",
    terminalCopy.length === 1,
    `${terminalCopy.length} matching CopyControl element(s)`,
  );

  // CT-01: the generic code surface (any row without a structured card — MCP
  // `unknown`, a plan, a `/command`'s output, a read/fetch whose meta did not
  // parse) scrolls the whole body in DSH's 260px window and hands the whole of
  // it to a copy control. The ScrollView names `codeScroll`; `buildStyles` is
  // what binds that name to `CODE_MAX_HEIGHT`, the token that had no consumer.
  const codeScroll = elementsWithAttributes(component, ["style", "contentContainerStyle"]).filter(
    (element) => element.tag === "ScrollView" && mentions(attributeOf(element, "style").value, "codeScroll"),
  );
  check(
    "the generic code surface sits in a capped scroll region",
    codeScroll.length === 1,
    `${codeScroll.length} matching ScrollView element(s)`,
  );
  check(
    "…whose content keeps the code surface's padding",
    codeScroll.length === 1 &&
      mentions(attributeOf(codeScroll[0], "contentContainerStyle").value, "code"),
  );
  const genericCopy = elementsWithAttributes(component, ["text"]).filter(
    (element) => element.tag === "CardHead" && mentions(attributeOf(element, "text").value, "body"),
  );
  check(
    "…and the card head's copy control gets the whole body",
    genericCopy.length === 1,
    `${genericCopy.length} matching CardHead element(s)`,
  );
  check(
    "…without inventing a language tag or title DSH's toolbar would carry",
    genericCopy.length === 1 &&
      attributeOf(genericCopy[0], "lang").value === "" &&
      attributeOf(genericCopy[0], "title").value === "",
  );
  const stylesBody = functionBody(codeOnly(rendered), "buildStyles") ?? "";
  check("buildStyles was found", stylesBody.length > 0, "buildStyles body is missing");
  check(
    "and the scroll window is DSH's 260px token, not a second literal",
    mentions(stylesBody, "CODE_MAX_HEIGHT") && /maxHeight\s*:\s*CODE_MAX_HEIGHT/.test(stylesBody),
    "buildStyles does not bind maxHeight to CODE_MAX_HEIGHT",
  );

  // L1: a row with no detail shape draws the generic fields card instead of one
  // pretty-printed JSON blob. The card is wired from `data.fields`, its prose is
  // drawn as text (re-serializing is what produced the literal `\n`), a nested
  // value keeps the code surface, the facts row wraps on a phone, and the copy
  // control gets `copyText` — the complete JSON — not the flattened display.
  check("the row draws the generic fields card", mentions(component, "fields"), "no `fields` read in the component");
  const fieldsView = functionBody(codeOnly(rendered), "ToolFieldsView") ?? "";
  check("the fields card component was found", fieldsView.length > 0, "ToolFieldsView body is missing");
  check(
    "…whose copy control gets the complete result JSON",
    elementsWithAttributes(fieldsView, ["text"]).filter(
      (element) => element.tag === "CardHead" && mentions(attributeOf(element, "text").value, "copyText"),
    ).length === 1,
    "no CardHead wired to copyText",
  );
  check(
    "…prose drawn as text, never re-serialized",
    elementsWithAttributes(fieldsView, ["style"]).some((element) =>
      mentions(attributeOf(element, "style").value, "fieldText"),
    ) &&
      !mentions(fieldsView, "stringifyValue") &&
      !mentions(fieldsView, "JSON.stringify"),
    "no fieldText element, or the value is re-serialized in the view",
  );
  const fieldScrolls = elementsWithAttributes(fieldsView, ["style"]).filter(
    (element) =>
      element.tag === "ScrollView" &&
      mentions(attributeOf(element, "style").value, "fieldBodyScroll"),
  );
  check(
    "…a nested value keeps the code surface",
    fieldScrolls.some((element) => {
      const content = attributeOf(element, "contentContainerStyle");
      return content !== undefined && mentions(content.value, "code");
    }),
    `${fieldScrolls.length} scroll(s)`,
  );
  check(
    "…and a long prose value is bounded too (scroll, never truncate)",
    fieldScrolls.length === 2 &&
      fieldScrolls.some((element) => attributeOf(element, "contentContainerStyle") === undefined),
    `${fieldScrolls.length} scroll(s)`,
  );
  check(
    "…and the facts row wraps on a narrow screen",
    mentions(stylesBody, "fieldFacts") && /flexWrap\s*:\s*"wrap"/.test(stylesBody),
    "buildStyles does not bind a wrapping fieldFacts row",
  );
  check(
    "…and the L2 receipt is drawn in its own quiet line",
    mentions(fieldsView, "receipt") && mentions(stylesBody, "fieldReceipt"),
    "no receipt line in ToolFieldsView / buildStyles",
  );
  // The 「结果」caption is opt-out, and the data layer producing the flag is not
  // the same fact as the view honouring it: a caption drawn anyway looks exactly
  // like a card that never asked for the opt-out, so no data assertion above can
  // see it. The `result-caption` push must sit inside the
  // `data.hideResultCaption !== true` guard, and the element must exist nowhere
  // else — a second copy outside the guard would undo the opt-out.
  const guardAt = fieldsView.indexOf("data.hideResultCaption !== true");
  const guardBody = guardAt < 0 ? "" : bracedBody(fieldsView, guardAt);
  check(
    "…and the 「结果」caption push sits inside the card's opt-out guard",
    guardAt >= 0 && mentions(guardBody, "result-caption") && mentions(guardBody, "push"),
    guardBody === "" ? "no hideResultCaption guard in ToolFieldsView" : guardBody.slice(0, 160),
  );
  check(
    "…with no second caption element that could bypass it",
    (fieldsView.match(/result-caption/gu) ?? []).length === 1,
    `${(fieldsView.match(/result-caption/gu) ?? []).length} occurrence(s) in ToolFieldsView`,
  );
}

console.log("Paseo's own mark");
{
  const { PASEO_MARK_ICON } = require("./client/paseo-mark.js");
  check("is a PNG data URI", PASEO_MARK_ICON.startsWith("data:image/png;base64,"));
  const bytes = Buffer.from(PASEO_MARK_ICON.slice("data:image/png;base64,".length), "base64");
  // Read the header rather than trusting the file: a truncated paste would still
  // start with the magic but decode to a broken image.
  equal("decodes to a PNG", bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  equal("IHDR says 64 wide", bytes.readUInt32BE(16), 64);
  equal("IHDR says 64 tall", bytes.readUInt32BE(20), 64);
  check("and the payload is not empty", bytes.length > 500, `${bytes.length} bytes`);
}

console.log("the bridge's own MCP gateway tools");
{
  // These three are ours (`dsh-bridge/lib/mcp-gateway.js`). They declare only a
  // name and a description — no `title`, no `presentationMeta` — so without an
  // entry here the row printed the wire name (`mcp_tool_schema`) over raw JSON
  // and drew the wrench.
  equal("list tools label", toolLabel("mcp_list_tools"), "列出 MCP 工具");
  equal("list tools icon", toolIcon("mcp_list_tools", { type: "unknown" }), "Server");
  equal("tool schema label", toolLabel("mcp_tool_schema"), "查看 MCP 工具参数");
  equal("tool schema icon", toolIcon("mcp_tool_schema", { type: "unknown" }), "FileJson");
  equal("call tool label", toolLabel("mcp_call_tool"), "调用 MCP 工具");
  equal("call tool icon", toolIcon("mcp_call_tool", { type: "unknown" }), "Play");
}

console.log("a forked subagent is not a spawned one");
{
  // `subagent_fork` comes from the subagent service's `fork` provider and DSH
  // ships no row title for it, so both halves are ours; without them the row
  // printed `subagent_fork` over raw JSON with the wrench.
  equal("fork label", toolLabel("subagent_fork"), "派生子智能体分支");
  equal("fork icon", toolIcon("subagent_fork", { type: "unknown" }), "GitFork");
  check(
    "and it is not the same row as a plain subagent",
    toolLabel("subagent_fork") !== toolLabel("subagent") &&
      toolIcon("subagent_fork", { type: "unknown" }) !== toolIcon("subagent", { type: "unknown" }),
  );
}

console.log("team task tools: field cards, raw JSON fallback, translated refusals (T3)");
{
  setLocale("zh-CN");
  // Fictional data in DSH's exact `TeamTaskView` shape (TASK_VIEW_SCHEMA).
  const view = (over = {}) => ({
    id: "task-2",
    revision: 3,
    subject: "独立审查：修复的正确性与证据",
    description: "只读审查 task-1 的产出。\n\n必查项：A. 改动落点。B. 回退路径。",
    status: "completed",
    blockedBy: ["task-1"],
    writeScopes: [],
    ownerName: "reviewer",
    ready: false,
    writeScopeWarnings: [],
    ...over,
  });
  const row = (name, input, output, extra = {}) =>
    toolCallData({ name, status: "completed", detail: { type: "unknown", input, output }, error: null, ...extra }, "complete");

  const get = row("team_task_get", { task_id: "task-2" }, JSON.stringify(view()));
  check("team_task_get gets a card", get.team !== null && get.team.kind === "task", JSON.stringify(get.team));
  equal("…the summary is the subject, not the JSON", get.summary, "独立审查：修复的正确性与证据");
  equal("…the raw body is gone", get.body, "");
  check("…and it is not a code surface", get.code === false);
  equal("…fields in the card's order", get.team?.tasks[0].fields.map((f) => f.label), ["状态", "负责人", "依赖", "修订"]);
  equal("…status word", get.team?.tasks[0].fields[0].value, "已完成");
  equal("…the description travels whole", get.team?.tasks[0].description, view().description);
  equal("…mark", get.team?.tasks[0].mark, "done");
  check("…the row still expands", get.hasDetail === true);

  const create = row("team_task_create", { subject: "x", description: "y", blocked_by: ["task-1"] }, JSON.stringify(view({ id: "task-3", revision: 1, status: "pending", ownerName: undefined, writeScopes: ["src/a.ts", "src/b/"], writeScopeWarnings: ["write scopes overlap with task-1"] })));
  equal("team_task_create: unowned reads 未分配", create.team?.tasks[0].fields[1], { label: "负责人", value: "未分配" });
  equal("…a pending task that is not ready is 等待依赖", create.team?.tasks[0].fields[0].value, "等待依赖");
  equal("…scopes one per line", create.team?.tasks[0].fields.find((f) => f.label === "写入范围")?.value, "src/a.ts\nsrc/b/");
  equal("…the overlap warning is translated and tinted", create.team?.tasks[0].fields.find((f) => f.label === "提醒"), { label: "提醒", value: "写入范围与 task-1 重叠", tone: "warning" });

  const update = row("team_task_update", { task_id: "task-2", expected_revision: 1, action: "claim" }, JSON.stringify(view({ status: "in_progress", revision: 2 })));
  equal("team_task_update names its action", update.team?.caption, "动作 认领 · task-2");
  const unknownAction = row("team_task_update", { task_id: "task-2", expected_revision: 1, action: "frobnicate" }, JSON.stringify(view({ status: "in_progress" })));
  equal("…an action DSH adds later is shown verbatim", unknownAction.team?.caption, "动作 frobnicate · task-2");

  const list = row("team_task_list", { status: "completed" }, JSON.stringify({ tasks: [view({ id: "task-1", blockedBy: [] }), view()] }));
  check("team_task_list gets a list card", list.team?.kind === "list" && list.team.tasks.length === 2, JSON.stringify(list.team?.kind));
  equal("…its caption counts and names the filter", list.team?.caption, "2 个任务 · 筛选 状态=已完成");
  equal("…the head summary is that caption, not `{\"status\":\"completed\"}`", list.summary, "2 个任务 · 筛选 状态=已完成");
  const paged = row("team_task_list", {}, JSON.stringify({ tasks: [view()], nextCursor: 50 }));
  check("…nextCursor marks more", paged.team?.more === true);
  const ownerFilter = row("team_task_list", { owner: "unowned", ready: true }, JSON.stringify({ tasks: [] }));
  equal("…owner/ready filters in words", ownerFilter.team?.caption, "0 个任务 · 筛选 负责人=未分配，可开始");

  // The fallback: anything that is not DSH's exact shape gets no card. The team
  // tools keep that card's documented fallback — the raw output in the body (L1
  // only claims the results of tools with no card of their own, see
  // `buildFields`) — so the assertion is "the output survives whole".
  for (const [what, output] of [
    ["not JSON", "task created"],
    ["an extra key (DSH's schema is additionalProperties:false)", JSON.stringify({ ...view(), extra: 1 })],
    ["a missing key", JSON.stringify({ ...view(), ready: undefined })],
    ["a deleted task", JSON.stringify(view({ status: "deleted" }))],
    ["a list with one bad task", JSON.stringify({ tasks: [view(), { id: "task-9" }] })],
    ["a list with an unknown key", JSON.stringify({ tasks: [], total: 0 })],
  ]) {
    const name = what.startsWith("a list") ? "team_task_list" : "team_task_get";
    const raw = row(name, { task_id: "task-2" }, output);
    check(`${what}: no card`, raw.team === null, JSON.stringify(raw.team));
    check(
      `${what}: the output survives whole`,
      raw.body === output || raw.fields?.copyText === output,
      `body=${JSON.stringify(raw.body.slice(0, 80))} copy=${JSON.stringify(raw.fields?.copyText.slice(0, 80) ?? null)}`,
    );
  }
  equal("parseTeamResult ignores other tools", parseTeamResult("create_goal", {}, JSON.stringify(view())), null);

  // A failed team tool: DSH's sentence in Chinese first, DSH's own words kept.
  const failedRow = (message) =>
    toolCallData({ name: "team_task_create", status: "failed", detail: { type: "unknown", input: { subject: "x" }, output: message }, error: { message } }, "complete");
  const scope = failedRow('Error: invalid workspace-relative write scope "../outside/a.ts"');
  check("a failed call never gets a card", scope.team === null);
  equal("…the head reads Chinese", scope.errorShort, '写入范围不是工作区内的相对路径："../outside/a.ts"');
  equal("…the expansion opens with the Chinese line", scope.errorHint, '写入范围不是工作区内的相对路径："../outside/a.ts"');
  equal("…and keeps DSH's verbatim error", scope.error, 'Error: invalid workspace-relative write scope "../outside/a.ts"');
  const stale = failedRow('stale team task "task-2" revision 1; current revision is 3');
  equal("a stale revision refusal", stale.errorShort, "任务 task-2 已被改动（预期修订 1，当前 3），请重新读取后再试。");
  const unknown = failedRow("Error: something DSH says later");
  equal("an unknown refusal is not translated (head keeps DSH's first line)", unknown.errorShort, "");
  equal("…no hint invented", unknown.errorHint, "");
  equal("…the verbatim error stays", unknown.error, "Error: something DSH says later");
  const otherTool = toolCallData({ name: "bash", status: "failed", detail: { type: "unknown", output: "No goal to clear." }, error: { message: 'team task "task-1" not found' } }, "complete");
  equal("a non-team tool's error is never run through the team table", otherTool.errorShort, "");
  setLocale("en");
  const en = failedRow('team task "task-1" not found');
  equal("English: no translation, DSH's words", en.errorShort, "");
  const enCard = row("team_task_get", {}, JSON.stringify(view()));
  equal("English card labels", enCard.team?.tasks[0].fields.map((f) => f.label), ["Status", "Owner", "Blocked by", "Revision"]);
  setLocale(undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
