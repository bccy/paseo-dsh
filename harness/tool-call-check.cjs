/**
 * Offline assertions for the DSH tool-row mapping.
 *
 * The mapping decides *what* the timeline shows (icon, command, path, diff,
 * output). A wrong mapping is silent in the UI: a missing command or a generic
 * icon just looks like a different tool call. So the checks live at the data
 * layer, matching this repo's rule that the UI is not a trustworthy oracle.
 *
 * Run (from paseo-plugin):
 *   npx tsc client/tool-call-data.ts \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/tool-call-check.cjs .dbg/
 *   cd .dbg && node tool-call-check.cjs
 *
 * Only the pure module is compiled: the React renderer imports the host
 * runtime, which plain `node` resolution cannot see.
 */
"use strict";

const { toolCallData, toolIcon, toolLabel } = require("./client/tool-call-data.js");

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

console.log("icons (must match Paseo's own mapping)");
{
  const cases = [
    ["bash", { type: "shell" }, "SquareTerminal"],
    ["read", { type: "read" }, "Eye"],
    ["edit", { type: "edit" }, "Pencil"],
    ["write", { type: "write" }, "Pencil"],
    ["grep", { type: "search" }, "Search"],
    ["web_fetch", { type: "fetch" }, "Search"],
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
  equal("label", shell.label, "命令");
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
  equal("known tool label", toolLabel("bash"), "命令");
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
  equal("and nothing is repeated when expanded", plain.headline, "");

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
  check("structured results are pretty-printed", mcp.body.includes("\n"), JSON.stringify(mcp.body));
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
  equal("but is still expandable by its title", silent.summary, '{"a":1}');
  check("and its block already has the arguments", silent.headline.includes("\n"), JSON.stringify(silent.headline));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
