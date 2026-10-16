/**
 * Offline assertions for the DSH tool-row mapping.
 *
 * The mapping decides *what* the timeline shows (icon, command, path, diff,
 * output). A wrong mapping is silent in the UI: a missing command or a generic
 * icon just looks like a different tool call. So the checks live at the data
 * layer, matching this repo's rule that the UI is not a trustworthy oracle.
 *
 * Run (from paseo-plugin):
 *   npx tsc client/tool-call-data.ts client/tokens.ts \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/tool-call-check.cjs .dbg/
 *   cd .dbg && node tool-call-check.cjs
 *
 * Only the pure modules are compiled: the React renderer imports the host
 * runtime, which plain `node` resolution cannot see. `tokens.ts` comes along
 * because `diffStat()` reading the generated diff body is exactly the claim
 * being checked.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

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
} = require("./client/tool-call-data.js");
const { diffStat } = require("./client/tokens.js");
const { setLocale } = require("./client/locale.js");

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
function dshToolSchemaKeys(source) {
  const marker = source.indexOf('kind: "dsh-tool"');
  if (marker < 0) return [];
  const at = source.indexOf("z.object(", marker);
  if (at < 0) return [];
  const open = source.indexOf("{", at);
  if (open < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && (depth -= 1) === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  const keys = [];
  let nested = 0;
  for (const line of source.slice(open + 1, end).split("\n")) {
    const match = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
    if (nested === 0 && match !== null) keys.push(match[1]);
    for (const character of line) {
      if (character === "{" || character === "(" || character === "[") nested += 1;
      else if (character === "}" || character === ")" || character === "]") nested -= 1;
    }
  }
  return keys;
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

console.log("limits");
{
  const huge = toolCallData(
    { name: "bash", status: "completed", detail: { type: "shell", command: "x", output: "y".repeat(7000) } },
    "complete",
  );
  check("huge output is truncated", huge.body.includes("已截断") && huge.body.length < 7000);
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
  equal("the arguments are the row's title, on one line", mcp.summary, '{"cron":"* * * *","maxRuns":2}');
  check("the result is the body", mcp.body.includes('"status": "active"'), mcp.body);
  equal(
    "structured results are pretty-printed",
    mcp.body,
    '{\n  "id": "abc",\n  "status": "active"\n}',
  );
  check("and so are the arguments in the block", mcp.headline.includes("\n"), JSON.stringify(mcp.headline));
  equal("and rendered as code", mcp.code, true);

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

  const silent = toolCallData(
    { name: "mcp__x__y", status: "running", detail: { type: "unknown", input: { a: 1 } } },
    "streaming",
  );
  equal("a running call has no body yet", silent.body, "");
  equal("its title is still the arguments", silent.summary, '{"a":1}');
  check("and its block already has them", silent.headline.includes("\n"), JSON.stringify(silent.headline));
  equal("so it has something to reveal", silent.hasDetail, true);

  // A description on an MCP call must not push the block back to the compact
  // one-line JSON: the pretty form is the whole point of the block.
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
  check(
    "the block still leads with pretty arguments",
    described.headline.includes("\n"),
    JSON.stringify(described.headline),
  );

  const arrayInput = toolCallData(
    { name: "mcp__x__z", status: "completed", detail: { type: "unknown", input: [1, 2], output: "" } },
    "complete",
  );
  equal("an array argument is kept", arrayInput.summary, "[1,2]");

  const cyclic = {};
  cyclic.self = cyclic;
  const broken = toolCallData(
    { name: "mcp__x__w", status: "completed", detail: { type: "unknown", input: cyclic } },
    "complete",
  );
  equal("an unserializable payload is reported, not swallowed", broken.summary, "<unserializable>");
}

console.log("a row only expands onto something");
{
  // Regression: every expansion went into a code surface, so a row whose only
  // content is its title drew an empty grey bar. `hasDetail` is the data-layer
  // answer to "is there anything to reveal", which is why it lives here.
  const titleOnly = toolCallData(
    { name: "todo_write", status: "completed", detail: { type: "plain_text", label: "更新任务", text: "" } },
    "complete",
  );
  equal("a title-only row reveals nothing", titleOnly.hasDetail, false);
  equal("and is still labelled", titleOnly.summary, "更新任务");

  const command = toolCallData(
    {
      name: "goal",
      status: "completed",
      detail: { type: "plain_text", label: "/goal", text: "No goal is currently set." },
    },
    "complete",
  );
  equal("a slash command is labelled by the line that ran", command.summary, "/goal");
  equal("and its output is the body, not dropped", command.body, "No goal is currently set.");
  equal("so it has something to reveal", command.hasDetail, true);

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
      data.headline !== "" || data.body !== "",
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

  // A typed detail still wins: the name map only fills the `unknown` gap.
  equal("a typed detail keeps its own icon", toolIcon("bash", { type: "shell" }), "SquareTerminal");
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
  equal("its title is the subject", bare.summary, '{"action":"complete"}');
  check("and the block carries the same subject in full", bare.headline.includes("\n"), JSON.stringify(bare.headline));
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
  const readKey = (candidates, label) => {
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    check(`${label} is readable`, file !== undefined, candidates.join(", "));
    if (file === undefined) return null;
    const match = /PRESENTATION_META_KEY[^=]*=\s*"([^"]+)"/.exec(fs.readFileSync(file, "utf8"));
    check(`${label} declares the key as a literal`, match !== null);
    return match === null ? null : match[1];
  };
  const serverKey = readKey(
    [path.join(__dirname, "..", "server", "timeline.ts"), path.join(__dirname, "server", "timeline.ts")],
    "server/timeline.ts",
  );
  const clientKey = readKey(
    [
      path.join(__dirname, "..", "client", "tool-call-data.ts"),
      path.join(__dirname, "client", "tool-call-data.ts"),
    ],
    "client/tool-call-data.ts",
  );
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
  const candidates = [
    path.join(__dirname, "..", "index.client.tsx"),
    path.join(__dirname, "index.client.tsx"),
  ];
  const sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
  check("index.client.tsx is readable", sourcePath !== undefined, candidates.join(", "));
  const source = sourcePath === undefined ? "" : fs.readFileSync(sourcePath, "utf8");

  const relay = source.search(/setLocale\(localeFromMetadata\(item\.metadata\)\)/);
  check(
    "the transformer relays metadata.locale with setLocale(localeFromMetadata(...))",
    relay >= 0,
  );
  const toolTransformer = source.indexOf('id: "dsh-inline-tool"');
  const thinkingTransformer = source.indexOf('id: "dsh-inline-thinking"');
  const mapping = source.indexOf("toolCallData(item, phase)", relay < 0 ? 0 : relay);
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
  const candidates = [
    path.join(__dirname, "..", "index.client.tsx"),
    path.join(__dirname, "index.client.tsx"),
  ];
  const sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
  check(
    "index.client.tsx is readable",
    sourcePath !== undefined,
    `looked in ${candidates.join(", ")}`,
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
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
