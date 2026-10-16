/**
 * Offline assertions for `TimelineBuilder`'s tool-call state machine.
 *
 * The builder turns DSH session events into Paseo timeline items, and every
 * branch here was once silently wrong in a way the UI cannot show:
 *
 * - A tool call that never gets a result (an aborted turn takes the process with
 *   it) stayed `running` forever. The client pulses a running row with no time
 *   window, so that row blinked for the rest of the session and on every replay.
 * - A repeated `tool/call` rebuilt the row from its input alone, which reset a
 *   finished tool to `running` and dropped the output it already carried.
 * - `tool/result` → `data.meta` (DSH's `presentationMeta`) was never read, so
 *   every structured row was rendered from the lossy result text. The meta
 *   pass-through and the protocol fields it fills are asserted here, as are the
 *   nine detail branches that had no assertion at all.
 *
 * `harness/plugin-check.cjs` drives the plugin end to end; this drives the
 * builder directly, which is the only way to stage those orderings.
 *
 * Run (from paseo-plugin):
 *   npx tsc server/timeline.ts \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/timeline-check.cjs .dbg/
 *   cd .dbg && node timeline-check.cjs
 *
 * The `@getpaseo/plugin/server/provider` type errors tsc prints under
 * `--moduleResolution node` are expected; the emitted JavaScript is what runs.
 */
"use strict";

const { TimelineBuilder } = require("./server/timeline.js");

let passed = 0;
let failed = 0;

/** Every warning the builders reported, so "loud" can be asserted, not assumed. */
const warnings = [];

function check(label, condition, detail) {
  if (condition === true) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label} — ${detail === undefined ? String(condition) : detail}`);
  }
}

const call = (builder, callId = "c1", command = "ls") =>
  builder.consume({ type: "tool/call", seq: 1, data: { callId, name: "bash", arguments: { command } } });
const result = (builder, callId = "c1", output = "file.txt") =>
  builder.consume({
    type: "tool/result",
    seq: 2,
    data: { toolCallId: callId, message: { content: [{ type: "text", text: output }] } },
  });
const turnEnd = (builder, reason) =>
  builder.consume({ type: "turn/end", seq: 3, data: { turn: 1, reason } });

/** One tool call followed by its result, returning the tool-call snapshot. */
function runTool(name, args, output, meta) {
  const builder = new TimelineBuilder({ warn: (line) => warnings.push(line) });
  builder.consume({ type: "tool/call", seq: 1, data: { callId: "t1", name, arguments: args } });
  const items = builder.consume({
    type: "tool/result",
    seq: 2,
    data: {
      toolCallId: "t1",
      message: { content: [{ type: "text", text: output }] },
      ...(meta === undefined ? {} : { meta }),
    },
  });
  // `todo_write` also emits Paseo's native todo item first.
  return items.find((item) => item.type === "tool_call");
}

console.log("tool call lifecycle");
{
  const builder = new TimelineBuilder();
  const started = call(builder);
  check("a tool call starts running", started[0]?.status === "running", JSON.stringify(started[0]));

  const finished = result(builder);
  check("a result completes it", finished[0]?.status === "completed");
  check(
    "and carries the output",
    finished[0]?.detail?.output === "file.txt",
    JSON.stringify(finished[0]?.detail),
  );
}

console.log("a repeated tool/call must not undo a finished row");
{
  const builder = new TimelineBuilder();
  call(builder);
  result(builder, "c1", "kept");
  const again = call(builder);
  check("no item is emitted", again.length === 0, JSON.stringify(again));
  check(
    "the finished row still carries its output",
    builder.consume({ type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } }).length === 0,
  );
  const reread = call(builder, "c2");
  check("a different call still starts", reread[0]?.status === "running");
}

console.log("a repeated tool/call while running");
{
  const builder = new TimelineBuilder();
  call(builder);
  const again = call(builder);
  check("it stays running", again[0]?.status === "running");
  const out = turnEnd(builder, { kind: "aborted" });
  check("and is still cancellable", out[0]?.status === "canceled");
}

console.log("an interrupted turn closes out what never finished");
{
  // DSH cancels a turn with `reason.kind === "aborted"`, and the in-flight tool
  // never gets a result.
  const builder = new TimelineBuilder();
  call(builder);
  const out = turnEnd(builder, { kind: "aborted" });
  check("the running tool becomes canceled", out[0]?.status === "canceled", JSON.stringify(out[0]));
  check("and stops being running", out[0]?.error === null);
}

console.log("turn end variants");
{
  const clean = new TimelineBuilder();
  call(clean);
  result(clean);
  check(
    "a completed turn emits nothing",
    turnEnd(clean, { kind: "completed" }).length === 0,
  );

  const nothingRunning = new TimelineBuilder();
  check(
    "an aborted turn with no running tool emits nothing",
    turnEnd(nothingRunning, { kind: "aborted" }).length === 0,
  );

  const failed = new TimelineBuilder();
  call(failed);
  const out = turnEnd(failed, { kind: "error", error: { message: "boom" } });
  check("an errored turn cancels the tool too", out[0]?.status === "canceled");
  check("and reports the error", out[1]?.type === "error" && out[1]?.message === "boom", JSON.stringify(out[1]));

  const noReason = new TimelineBuilder();
  call(noReason);
  check(
    "a turn end with no reason still cancels",
    turnEnd(noReason, undefined)[0]?.status === "canceled",
  );
}

console.log("replay of an interrupted session");
{
  // Replaying the same event log must reach the same terminal state, or opening
  // the session again revives the forever-pulsing row.
  const builder = new TimelineBuilder();
  call(builder, "c9");
  turnEnd(builder, { kind: "aborted" });
  const replayed = new TimelineBuilder();
  call(replayed, "c9");
  const out = turnEnd(replayed, { kind: "aborted" });
  check("replay reaches canceled too", out[0]?.status === "canceled");
}

console.log("the description rides on provider metadata");
{
  // Paseo's `shell` detail has no field for DSH's model-written description, so
  // it travels on the item's provider-owned `metadata`. The client reads it back
  // to title the row the way DSH's own UI does.
  const builder = new TimelineBuilder();
  const started = builder.consume({
    type: "tool/call",
    seq: 1,
    data: {
      callId: "d1",
      name: "bash",
      arguments: { command: "pwd", description: "List DSH checkout root" },
    },
  });
  check(
    "a described call carries it",
    started[0]?.metadata?.description === "List DSH checkout root",
    JSON.stringify(started[0]?.metadata),
  );
  const done = builder.consume({
    type: "tool/result",
    seq: 2,
    data: { toolCallId: "d1", message: { content: [{ type: "text", text: "/tmp" }] } },
  });
  check(
    "and the finished row still carries it",
    done[0]?.metadata?.description === "List DSH checkout root",
    JSON.stringify(done[0]?.metadata),
  );

  const bare = new TimelineBuilder();
  const plain = bare.consume({
    type: "tool/call",
    seq: 1,
    data: { callId: "d2", name: "bash", arguments: { command: "pwd" } },
  });
  check("a call with no description adds no metadata", plain[0]?.metadata === undefined);
}

console.log("every detail branch carries what it claims");
{
  // These branches had no assertion at all, so a renamed or dropped field
  // changed what the row renders without failing anything.
  const read = runTool("read", { file_path: "/repo/src/app.ts", offset: 2, limit: 5 }, "content").detail;
  check("read: type", read.type === "read");
  check("read: path", read.filePath === "/repo/src/app.ts");
  check("read: content is the result text", read.content === "content");
  check("read: window from the arguments", read.offset === 2 && read.limit === 5);

  const write = runTool("write", { file_path: "/repo/src/new.ts", content: "hello" }, "Created").detail;
  check("write: type", write.type === "write");
  check("write: path", write.filePath === "/repo/src/new.ts");
  check("write: content", write.content === "hello");

  const edit = runTool("edit", { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" }, "Edited").detail;
  check("edit: type", edit.type === "edit");
  check("edit: path", edit.filePath === "/repo/src/app.ts");
  check("edit: replacement", edit.oldString === "a" && edit.newString === "b");

  const search = runTool("grep", { pattern: "needle" }, "hit").detail;
  check("search: type", search.type === "search");
  check("search: query from pattern", search.query === "needle");
  check("search: toolName", search.toolName === "grep");
  check("search: content", search.content === "hit");

  const fetch = runTool("web_fetch", { url: "https://example.com" }, "body").detail;
  check("fetch: type", fetch.type === "fetch");
  check("fetch: url", fetch.url === "https://example.com");
  check("fetch: result", fetch.result === "body");

  const plain = runTool("todo_write", { todos: [{ content: "Task", status: "pending" }] }, "ok").detail;
  check("plain_text: type", plain.type === "plain_text");
  check("plain_text: label", plain.label === "更新任务");
  check("plain_text: icon key", plain.icon === "sparkles");

  const plan = runTool("exit_plan_mode", { plan: "## Plan" }, "ok").detail;
  check("plan: type", plan.type === "plan");
  check("plan: text", plan.text === "## Plan");

  const sub = runTool("subagent", { description: "Explore" }, "log text").detail;
  check("sub_agent: type", sub.type === "sub_agent");
  check("sub_agent: description", sub.description === "Explore");
  check("sub_agent: log", sub.log === "log text");

  const unknown = runTool("mcp__x__y", { a: 1 }, "result text").detail;
  check("unknown: type", unknown.type === "unknown");
  check("unknown: input", JSON.stringify(unknown.input) === '{"a":1}', JSON.stringify(unknown.input));
  check("unknown: output", unknown.output === "result text");
}

console.log("DSH's presentationMeta reaches the detail");
{
  // The bridge forwards `tool/result` verbatim, `data.meta` included; the server
  // used to take `textOf(message.content)` and throw the rest away. Every
  // structured row in the plan — line numbers, hunk diffs, grouped matches, web
  // sources — hangs on this pass-through.
  const read = runTool("read", { file_path: "/repo/src/app.ts" }, "1: const a = 1;", {
    path: "/repo/src/app.ts",
    offset: 1,
    lines: [{ number: 1, text: "const a = 1;" }],
    totalLines: 40,
    lang: "typescript",
  }).detail;
  check("read: meta is verbatim", read.meta?.lines?.[0]?.text === "const a = 1;", JSON.stringify(read.meta));
  check("read: the protocol offset is filled", read.offset === 1);
  check("read: lang is kept (no protocol field for it)", read.meta.lang === "typescript");

  const edit = runTool("edit", { file_path: "app.ts" }, "Edited", {
    diffs: [{ path: "app.ts", oldText: "a", newText: "b" }],
  }).detail;
  check("edit: hunk diffs are kept", edit.meta.diffs[0].newText === "b", JSON.stringify(edit.meta));

  const warningsBeforeWrite = warnings.length;
  const write = runTool("write", { file_path: "new.ts" }, "Created", { operation: "create", diffs: [] }).detail;
  check("write: the operation is kept", write.meta.operation === "create");
  check(
    "write: an empty diff list is a valid create, not a mismatch",
    warnings.length === warningsBeforeWrite,
    JSON.stringify(warnings.slice(warningsBeforeWrite)),
  );

  const grep = runTool("grep", { pattern: "needle" }, "app.ts:3:hit", {
    shape: "matches",
    files: [
      { path: "app.ts", matches: [{ lineNumber: 3, line: "hit" }] },
      { path: "b.ts", matches: [{ lineNumber: 9, line: "hit2" }, { lineNumber: 10, line: "hit3" }] },
    ],
    truncated: true,
    total: 90,
  }).detail;
  check("grep: filePaths are filled", JSON.stringify(grep.filePaths) === '["app.ts","b.ts"]', JSON.stringify(grep.filePaths));
  check("grep: numFiles is filled", grep.numFiles === 2);
  check("grep: numMatches counts what the groups hold", grep.numMatches === 3);
  check("grep: mode is filled", grep.mode === "content");
  check("grep: truncated is filled", grep.truncated === true);
  check("grep: the pre-cap total stays in meta", grep.meta.total === 90);

  const glob = runTool("glob", { pattern: "**/*.ts" }, "a.ts", {
    shape: "paths",
    paths: ["a.ts", "b.ts"],
    truncated: false,
    total: 2,
  }).detail;
  check("glob: filePaths are filled", JSON.stringify(glob.filePaths) === '["a.ts","b.ts"]', JSON.stringify(glob.filePaths));
  check("glob: numFiles is filled", glob.numFiles === 2);
  check("glob: mode is filled", glob.mode === "files_with_matches");
  check("glob: truncated is filled", glob.truncated === false);

  const web = runTool("web_search", { queries: ["one", "two"] }, "sources", {
    sources: [{ url: "https://a.example", title: "A" }, { url: "https://b.example" }],
    truncated: false,
  }).detail;
  check(
    "web_search: webResults are filled, an untitled source falls back to its URL",
    JSON.stringify(web.webResults) ===
      '[{"title":"A","url":"https://a.example"},{"title":"https://b.example","url":"https://b.example"}]',
    JSON.stringify(web.webResults),
  );
  check("web_search: truncated is filled", web.truncated === false);
  check("web_search: the raw sources stay in meta", web.meta.sources[0].title === "A");

  const fetched = runTool("web_fetch", { url: "https://start.example" }, "body", {
    url: "https://final.example",
    statusCode: 200,
    truncated: true,
  }).detail;
  check("web_fetch: the final URL comes from meta", fetched.url === "https://final.example");
  check("web_fetch: the status code is filled", fetched.code === 200);
  check("web_fetch: truncation is kept (no protocol field for it)", fetched.meta.truncated === true);

  const image = runTool("read_image", { file_path: "/tmp/shot.png" }, "image/png 100x100", {
    path: "/tmp/shot.png",
  }).detail;
  check("read_image: stays an unknown detail", image.type === "unknown");
  check("read_image: its path is kept", image.meta.path === "/tmp/shot.png");

  const bash = runTool("bash", { command: "ls" }, "file.txt").detail;
  check("bash: no meta to pass through", !("meta" in bash), JSON.stringify(bash));
  check("bash: and still no exit code (DSH declares none)", bash.exitCode === undefined);
}

console.log("an unrecognized meta shape is reported, not swallowed");
{
  const before = warnings.length;
  const read = runTool("read", { file_path: "a.ts" }, "1: const a = 1;", {
    lines: "not-an-array",
    totalLines: 3,
  }).detail;
  check("a mismatched shape warns", warnings.length === before + 1, JSON.stringify(warnings.slice(before)));
  check("the warning names the tool", warnings[before].includes("read"), warnings[before]);
  check("the row keeps the plain result text", read.content === "1: const a = 1;");
  check("and the raw meta still travels for a human", read.meta.lines === "not-an-array");

  const beforeScalar = warnings.length;
  const scalar = runTool("bash", { command: "ls" }, "out", "not-an-object").detail;
  check(
    "a non-object meta warns too",
    warnings.length === beforeScalar + 1,
    JSON.stringify(warnings.slice(beforeScalar)),
  );
  check("and is not attached as a detail field", !("meta" in scalar));

  const beforeWrite = warnings.length;
  const badWrite = runTool("write", { file_path: "new.ts" }, "Created", {
    operation: "create",
    diffs: [{ path: "new.ts", oldText: 1, newText: "b" }],
  }).detail;
  check(
    "a malformed diff entry warns",
    warnings.length === beforeWrite + 1,
    JSON.stringify(warnings.slice(beforeWrite)),
  );
  check("and the raw meta is still there", badWrite.meta.diffs[0].oldText === 1);

  const beforeAbsent = warnings.length;
  const absent = runTool("bash", { command: "ls" }, "out").detail;
  check(
    "an absent meta is the normal case, not a mismatch",
    warnings.length === beforeAbsent && !("meta" in absent),
    JSON.stringify(warnings.slice(beforeAbsent)),
  );
}

console.log("web_search's query list");
{
  // DSH's `web_search` takes `queries: string[]`; the server only read string
  // fields, so every real call produced a row with an empty query.
  check(
    "an array of queries joins with the separator DSH uses",
    runTool("web_search", { queries: ["a", "b"] }, "x").detail.query === "a, b",
  );
  check(
    "a multi-line query contributes its first line",
    runTool("web_search", { queries: ["first\nsecond", "third"] }, "x").detail.query === "first, third",
  );
  check(
    "a plain string query keeps working",
    runTool("web_search", { query: "solo" }, "x").detail.query === "solo",
  );
  check(
    "pattern still wins over the other candidates",
    runTool("grep", { pattern: "p", query: "q" }, "x").detail.query === "p",
  );
  check(
    "an empty list falls through to the next candidate",
    runTool("web_search", { queries: [] }, "x").detail.query === "",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
