/**
 * Offline assertions for `TimelineBuilder`'s tool-call state machine.
 *
 * The builder turns DSH session events into Paseo timeline items, and every
 * branch here was once silently wrong in a way the UI cannot show:
 *
 * - A tool call that never gets a result (an aborted turn takes the process with
 *   it) stayed `running` forever. The client pulses a running row with no time
 *   window, so that row blinked for the rest of the session and on every replay.
 *   Both closures are asserted: `turn/end` (any reason) and `settleRunningTools`,
 *   the replay path for a log that simply stops with no terminal at all.
 * - A repeated `tool/call` rebuilt the row from its input alone, which reset a
 *   finished tool to `running` and dropped the output it already carried.
 * - `tool/result` → `data.meta` (DSH's `presentationMeta`) was never read, so
 *   every structured row was rendered from the lossy result text. The meta
 *   pass-through and the protocol fields it fills are asserted here, as are the
 *   nine detail branches that had no assertion at all. It rides on the item's
 *   `metadata`, **not** on the detail: `ProviderEventSchema.parse` strips every
 *   unknown detail field before the event leaves the plugin process, and the
 *   last section of this file runs that parse for real so the boundary cannot
 *   silently swallow the field again.
 * - DSH's `compaction/*` bracket was dropped by `consume()`, so a compaction was
 *   invisible while it ran. Paseo has a native `compaction` marker; the mapping,
 *   both triggers and the failed-close path are asserted here.
 * - A detail type the plugin's *client* cannot draw renders as an icon over
 *   nothing (`{summary:"",headline:"",body:"",hasDetail:false}`), and
 *   `worktree_setup` was the protocol type that did it. The invariant — the
 *   server only emits detail types `client/tool-call-data.ts` draws — is
 *   asserted for every branch.
 * - The resolved locale must ride on *every* tool-call item's `metadata`: the
 *   client cannot read the daemon's environment, and React never re-renders a
 *   row that already transformed, so a hint on the first row only is a hint
 *   nobody sees.
 *
 * `harness/plugin-check.cjs` drives the plugin end to end; this drives the
 * builder directly, which is the only way to stage those orderings.
 *
 * Run (from paseo-plugin):
 *   npx tsc server/timeline.ts \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   # `server/locale.ts` comes along: `timeline.js` imports it for `UI`/`LOCALE`.
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/timeline-check.cjs .dbg/
 *   cd .dbg && node timeline-check.cjs
 *
 * The `@getpaseo/plugin/server/provider` type errors tsc prints under
 * `--moduleResolution node` are expected; the emitted JavaScript is what runs.
 */
"use strict";

const { TimelineBuilder } = require("./server/timeline.js");
/** The same module the builder reads, so the relay can be compared to its source. */
const { LOCALE } = require("./server/locale.js");
/**
 * The schema the plugin subprocess parses every outgoing event with
 * (`@getpaseo/plugin/dist/server/plugin-process.js`). Imported here rather than
 * assumed: the last section feeds a real builder item through it, because the
 * one thing that must be true is that the structured meta still exists *after*
 * the process boundary.
 */
const { ProviderEventSchema } = require("@getpaseo/plugin/server/provider");

/** DSH's raw result meta, wherever the item carries it. */
function itemMeta(item) {
  return item?.metadata?.presentationMeta;
}

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

console.log("a log that simply stops closes its unfinished tools");
{
  // A killed process never appends `turn/end`, so the replay that folds its log
  // has to settle the rows whose `tool/result` can never arrive — otherwise the
  // client pulses them with no time window for the rest of the session.
  const builder = new TimelineBuilder();
  call(builder, "k1");
  const out = builder.settleRunningTools();
  check("the unfinished tool becomes canceled", out[0]?.status === "canceled" && out[0]?.error === null, JSON.stringify(out[0]));
  check("the row keeps its call id and detail", out[0]?.callId === "k1" && out[0]?.detail !== undefined);
  check("settling twice emits nothing the second time", builder.settleRunningTools().length === 0);

  const finished = new TimelineBuilder();
  call(finished, "k2");
  result(finished, "k2");
  check("a tool that already has its result is untouched", finished.settleRunningTools().length === 0);
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
  check("a call with no description still carries metadata", plain[0]?.metadata !== undefined);
  check(
    "and that metadata has no description to confuse the title",
    plain[0]?.metadata?.description === undefined,
    JSON.stringify(plain[0]?.metadata),
  );
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
  // DSH's own wording, from the `TOOL_TITLE_KEYS` table in
  // `@deepseek-ai/dsh-client-ui-tool`: `todo_write` → `todo.rowTitle`,
  // `ask_user_question` → `ask.rowTitle`. Pinned per locale because the server's
  // `toolLabels` is the only copy of it ("更新任务" without 清单, and "已询问用户"
  // for a row DSH titles "提问", were both Phase 3 audit findings), and read
  // through `LOCALE` so the assertion does not depend on this machine's `LANG`.
  const DSH_TOOL_TITLES = {
    "zh-CN": { todoWrite: "更新任务清单", askUser: "提问" },
    en: { todoWrite: "Update to-do list", askUser: "Ask question" },
  }[LOCALE];
  check("plain_text: label is DSH's todo.rowTitle", plain.label === DSH_TOOL_TITLES.todoWrite, plain.label);
  check("plain_text: icon key", plain.icon === "sparkles");

  const asked = runTool("ask_user_question", { questions: [] }, "answered").detail;
  check("ask_user_question: type", asked.type === "plain_text");
  check("ask_user_question: label is DSH's ask.rowTitle", asked.label === DSH_TOOL_TITLES.askUser, asked.label);

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

console.log("DSH's presentationMeta reaches the item's metadata");
{
  // The bridge forwards `tool/result` verbatim, `data.meta` included; the server
  // used to take `textOf(message.content)` and throw the rest away. Every
  // structured row in the plan — line numbers, hunk diffs, grouped matches, web
  // sources — hangs on this pass-through, and it has to land on `metadata`:
  // `detail` is schema-stripped at the process boundary (asserted at the end of
  // this file).
  const readItem = runTool("read", { file_path: "/repo/src/app.ts" }, "1: const a = 1;", {
    path: "/repo/src/app.ts",
    offset: 1,
    lines: [{ number: 1, text: "const a = 1;" }],
    totalLines: 40,
    lang: "typescript",
  });
  const read = readItem.detail;
  check("read: meta is verbatim", itemMeta(readItem)?.lines?.[0]?.text === "const a = 1;", JSON.stringify(itemMeta(readItem)));
  check("read: the protocol offset is filled on the detail", read.offset === 1);
  check("read: lang is kept (no protocol field for it)", itemMeta(readItem)?.lang === "typescript");
  check("read: and nothing rides on the detail itself", !("meta" in read), JSON.stringify(Object.keys(read)));

  const editItem = runTool("edit", { file_path: "app.ts" }, "Edited", {
    diffs: [{ path: "app.ts", oldText: "a", newText: "b" }],
  });
  check("edit: hunk diffs are kept", itemMeta(editItem)?.diffs?.[0]?.newText === "b", JSON.stringify(itemMeta(editItem)));

  const warningsBeforeWrite = warnings.length;
  const writeItem = runTool("write", { file_path: "new.ts" }, "Created", { operation: "create", diffs: [] });
  check("write: the operation is kept", itemMeta(writeItem)?.operation === "create");
  check("write: and it is not on the detail", !("meta" in writeItem.detail));
  check(
    "write: an empty diff list is a valid create, not a mismatch",
    warnings.length === warningsBeforeWrite,
    JSON.stringify(warnings.slice(warningsBeforeWrite)),
  );

  const grepItem = runTool("grep", { pattern: "needle" }, "app.ts:3:hit", {
    shape: "matches",
    files: [
      { path: "app.ts", matches: [{ lineNumber: 3, line: "hit" }] },
      { path: "b.ts", matches: [{ lineNumber: 9, line: "hit2" }, { lineNumber: 10, line: "hit3" }] },
    ],
    truncated: true,
    total: 90,
  });
  const grep = grepItem.detail;
  check("grep: filePaths are filled", JSON.stringify(grep.filePaths) === '["app.ts","b.ts"]', JSON.stringify(grep.filePaths));
  check("grep: numFiles is filled", grep.numFiles === 2);
  check("grep: numMatches counts what the groups hold", grep.numMatches === 3);
  check("grep: mode is filled", grep.mode === "content");
  check("grep: truncated is filled", grep.truncated === true);
  check("grep: the pre-cap total stays in the metadata", itemMeta(grepItem)?.total === 90);
  check(
    "grep: the grouped matches stay in the metadata",
    itemMeta(grepItem)?.files?.[1]?.matches?.length === 2,
    JSON.stringify(itemMeta(grepItem).files),
  );

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

  const webItem = runTool("web_search", { queries: ["one", "two"] }, "sources", {
    sources: [{ url: "https://a.example", title: "A" }, { url: "https://b.example" }],
    truncated: false,
  });
  const web = webItem.detail;
  check(
    "web_search: webResults are filled, an untitled source falls back to its URL",
    JSON.stringify(web.webResults) ===
      '[{"title":"A","url":"https://a.example"},{"title":"https://b.example","url":"https://b.example"}]',
    JSON.stringify(web.webResults),
  );
  check("web_search: truncated is filled", web.truncated === false);
  check("web_search: the raw sources stay in the metadata", itemMeta(webItem)?.sources?.[0]?.title === "A");

  const fetchedItem = runTool("web_fetch", { url: "https://start.example" }, "body", {
    url: "https://final.example",
    statusCode: 200,
    truncated: true,
  });
  const fetched = fetchedItem.detail;
  check("web_fetch: the final URL comes from meta", fetched.url === "https://final.example");
  check("web_fetch: the status code is filled", fetched.code === 200);
  check("web_fetch: truncation is kept (no protocol field for it)", itemMeta(fetchedItem)?.truncated === true);

  const imageItem = runTool("read_image", { file_path: "/tmp/shot.png" }, "image/png 100x100", {
    path: "/tmp/shot.png",
  });
  check("read_image: stays an unknown detail", imageItem.detail.type === "unknown");
  check("read_image: its path is kept", itemMeta(imageItem)?.path === "/tmp/shot.png");

  const bashItem = runTool("bash", { command: "ls" }, "file.txt");
  const bash = bashItem.detail;
  check("bash: no meta to pass through", itemMeta(bashItem) === undefined, JSON.stringify(bashItem.metadata));
  check("bash: and still no exit code (DSH declares none)", bash.exitCode === undefined);
}

console.log("an unrecognized meta shape is reported, not swallowed");
{
  const before = warnings.length;
  const readItem = runTool("read", { file_path: "a.ts" }, "1: const a = 1;", {
    lines: "not-an-array",
    totalLines: 3,
  });
  const read = readItem.detail;
  check("a mismatched shape warns", warnings.length === before + 1, JSON.stringify(warnings.slice(before)));
  check("the warning names the tool", warnings[before].includes("read"), warnings[before]);
  check("the row keeps the plain result text", read.content === "1: const a = 1;");
  check("and the raw meta still travels for a human", itemMeta(readItem)?.lines === "not-an-array");

  const beforeScalar = warnings.length;
  const scalarItem = runTool("bash", { command: "ls" }, "out", "not-an-object");
  check(
    "a non-object meta warns too",
    warnings.length === beforeScalar + 1,
    JSON.stringify(warnings.slice(beforeScalar)),
  );
  check("and is not attached as a detail field", !("meta" in scalarItem.detail));
  check("nor as an item metadata field", itemMeta(scalarItem) === undefined);

  const beforeWrite = warnings.length;
  const badWriteItem = runTool("write", { file_path: "new.ts" }, "Created", {
    operation: "create",
    diffs: [{ path: "new.ts", oldText: 1, newText: "b" }],
  });
  check(
    "a malformed diff entry warns",
    warnings.length === beforeWrite + 1,
    JSON.stringify(warnings.slice(beforeWrite)),
  );
  check("and the raw meta is still there", itemMeta(badWriteItem)?.diffs?.[0]?.oldText === 1);

  const beforeAbsent = warnings.length;
  const absentItem = runTool("bash", { command: "ls" }, "out");
  check(
    "an absent meta is the normal case, not a mismatch",
    warnings.length === beforeAbsent && !("meta" in absentItem.detail) && itemMeta(absentItem) === undefined,
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

console.log("\ncompaction is visible, exactly once (DSH's compaction/* bracket -> Paseo's marker)");
{
  // DSH brackets every compaction with `compaction/start` … `compaction/summary`
  // + `compaction/end`, and none of it reaches its own surface. `consume()` used
  // to return [] for all four types, so a compaction running for a minute looked
  // like nothing happening. Paseo has the marker as a first-class item, which is
  // what its own omp/pi adapters emit.
  //
  // **But a provider row is append-only.** The daemon's `mapTimelineItem` hands
  // non-message items on as `withoutIdentity` (it destructures `id` out) and only
  // `assistant_message`/`reasoning`/`user_message` are matched against the
  // previous emission, so a second item for the same `compactionId` is a second
  // row on screen, not an update. So the marker is emitted once, at the close,
  // and the open bracket draws nothing. Measured: replaying the repo's own long
  // session through `consume()` gave 3 items for one compaction, and the daemon's
  // activity feed for a single `/compact` listed `[Compacted]` three times.
  const builder = new TimelineBuilder({ warn: (line) => warnings.push(line) });

  const started = builder.consume({
    type: "compaction/start",
    seq: 10,
    data: { compactionId: "cmp-1", turn: 4 },
  });
  check("the open bracket draws nothing on its own", started.length === 0, JSON.stringify(started));

  const summarized = builder.consume({
    type: "compaction/summary",
    seq: 11,
    data: {
      compactionId: "cmp-1",
      turn: 4,
      summary: [{ type: "text", text: "…" }],
      shadowedRange: { start: 1, end: 9 },
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 12345,
      provider: "deepseek",
      model: "deepseek-chat",
    },
  });
  check("the summary emits exactly one item", summarized.length === 1, JSON.stringify(summarized));
  check("it is Paseo's native compaction marker", summarized[0]?.type === "compaction", summarized[0]?.type);
  check("it is the finished state", summarized[0]?.status === "completed", summarized[0]?.status);
  check(
    "id is namespaced by compactionId",
    summarized[0]?.id === "compaction:cmp-1",
    summarized[0]?.id,
  );
  check("an enclosed compaction is the automatic one", summarized[0]?.trigger === "auto", summarized[0]?.trigger);
  check(
    "preTokens is left unset (DSH has no tokens-before number)",
    summarized[0] !== undefined && !("preTokens" in summarized[0]),
    JSON.stringify(summarized[0]),
  );

  const ended = builder.consume({
    type: "compaction/end",
    seq: 12,
    data: { compactionId: "cmp-1", turn: 4 },
  });
  check("the closing bracket does not stack a second row", ended.length === 0, JSON.stringify(ended));

  // A manual `/compact` runs outside any turn and stamps the command that asked
  // for it. Both are DSH's own signals, not a guess from timing.
  const manual = builder.consume({
    type: "compaction/summary",
    seq: 13,
    data: { compactionId: "cmp-2", sourceCommandId: "cmd-7", turn: null, summary: [{ type: "text", text: "…" }] },
  });
  check("a /compact marker says manual", manual[0]?.trigger === "manual", JSON.stringify(manual[0]));
  check("a second compaction is a second marker", manual[0]?.id !== summarized[0]?.id, manual[0]?.id);

  const standalone = builder.consume({
    type: "compaction/end",
    seq: 14,
    data: { compactionId: "cmp-3", turn: null },
  });
  check(
    "turn: null alone is enough to call it manual",
    standalone[0]?.trigger === "manual",
    JSON.stringify(standalone[0]),
  );
  check(
    "a log that stops before the summary still gets its row",
    standalone.length === 1 && standalone[0]?.status === "completed",
    JSON.stringify(standalone),
  );

  // A failed compaction is closed with `error` and never gets a summary.
  const before = warnings.length;
  const failed = builder.consume({
    type: "compaction/end",
    seq: 15,
    data: { compactionId: "cmp-4", sourceCommandId: "cmd-7", turn: null, error: "summary is not smaller" },
  });
  check("a failed compaction still closes the marker", failed[0]?.status === "completed", failed[0]?.status);
  check(
    "and the failure is reported, not swallowed",
    warnings.length === before + 1 && warnings[before].includes("summary is not smaller"),
    JSON.stringify(warnings.slice(before)),
  );

  check(
    "compaction/prune is not a marker (no compactionId, and DSH draws nothing either)",
    builder.consume({
      type: "compaction/prune",
      seq: 16,
      data: { shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 40 },
    }).length === 0,
  );
  check(
    "a compaction event with no id emits nothing",
    builder.consume({ type: "compaction/summary", seq: 17, data: { turn: 4 } }).length === 0,
  );

  // The regression this block exists for: one whole bracket, one row — however
  // many events it is made of.
  const one = new TimelineBuilder({ warn: () => {} });
  const bracket = [
    { type: "compaction/start", seq: 1, data: { compactionId: "cmp-9", turn: 1 } },
    { type: "compaction/summary", seq: 2, data: { compactionId: "cmp-9", turn: 1 } },
    { type: "compaction/end", seq: 3, data: { compactionId: "cmp-9", turn: 1 } },
  ].flatMap((event) => one.consume(event));
  check(
    "one compaction bracket is exactly one row",
    bracket.length === 1 && bracket[0]?.status === "completed",
    JSON.stringify(bracket),
  );

  // …and replaying the same log twice through one builder is repeatable: the
  // summary/end handshake must not leave an id behind that swallows the second
  // pass. (A reopened session replays its whole log again.)
  const again = [
    { type: "compaction/start", seq: 1, data: { compactionId: "cmp-9", turn: 1 } },
    { type: "compaction/summary", seq: 2, data: { compactionId: "cmp-9", turn: 1 } },
    { type: "compaction/end", seq: 3, data: { compactionId: "cmp-9", turn: 1 } },
  ].flatMap((event) => one.consume(event));
  check(
    "replaying the same bracket emits it again",
    again.length === 1 && again[0]?.id === "compaction:cmp-9",
    JSON.stringify(again),
  );
}

console.log("\nthe resolved locale rides on every item the client transforms");
{
  // The client half cannot resolve a locale for itself — the bundle is built for
  // a neutral platform with no `define`, so `process.env` is unreachable. The
  // protocol's free-form `metadata` is the passthrough, and *every* tool-call
  // item has to carry it: the client adopts the locale while transforming a row,
  // and React never re-renders a row that already transformed.
  const builder = new TimelineBuilder();
  const started = builder.consume({
    type: "tool/call",
    seq: 1,
    data: { callId: "l1", name: "bash", arguments: { command: "pwd", description: "Where am I" } },
  });
  check(
    "a running call relays the locale the server resolved",
    started[0]?.metadata?.locale === LOCALE,
    JSON.stringify(started[0]?.metadata),
  );
  check(
    "alongside the description it already carried",
    started[0]?.metadata?.description === "Where am I",
    JSON.stringify(started[0]?.metadata),
  );

  const done = builder.consume({
    type: "tool/result",
    seq: 2,
    data: { toolCallId: "l1", message: { content: [{ type: "text", text: "/tmp" }] } },
  });
  check(
    "the finished row still relays it",
    done[0]?.metadata?.locale === LOCALE,
    JSON.stringify(done[0]?.metadata),
  );

  // A `/command` row goes through the same client transformer, so it needs the
  // hint too: a session whose first row is `/compact` must not be the one that
  // misses it.
  const second = new TimelineBuilder();
  second.consume({ type: "command/run", seq: 1, data: { commandId: "cmd-1", name: "compact" } });
  const command = second.consume({
    type: "command/done",
    seq: 2,
    data: { commandId: "cmd-1", kind: "success", text: "Compacted 3 history items." },
  });
  check(
    "a /command row relays it too",
    command[0]?.metadata?.locale === LOCALE,
    JSON.stringify(command[0]?.metadata),
  );

  // Canceling keeps the row it was built from, metadata included.
  const canceled = new TimelineBuilder();
  canceled.consume({
    type: "tool/call",
    seq: 1,
    data: { callId: "l2", name: "bash", arguments: { command: "sleep 9" } },
  });
  const closed = canceled.consume({ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "aborted" } } });
  check(
    "a canceled row keeps the hint",
    closed[0]?.metadata?.locale === LOCALE,
    JSON.stringify(closed[0]?.metadata),
  );
}

console.log("\nworktree_setup cannot render as an icon over nothing");
{
  // Paseo's protocol has a typed `worktree_setup` detail, but this plugin's own
  // client half replaces the drawing of *every* tool row, and its switch has no
  // case for that type: an unhandled detail type falls to a `default` that
  // leaves the summary, headline and body empty (measured
  // `{summary:"",headline:"",body:"",hasDetail:false}`), because the
  // raw-argument fallback is gated on `type === "unknown"`. So the server must
  // never emit it.
  const setup = runTool(
    "worktree_setup",
    { worktreePath: "/tmp/wt", branchName: "paseo/x", commands: [] },
    "created /tmp/wt",
  ).detail;
  check("it is not the type the client cannot draw", setup.type !== "worktree_setup", setup.type);
  check("it is the raw-argument detail instead", setup.type === "unknown", setup.type);
  check(
    "the call's arguments survive",
    JSON.stringify(setup.input) === '{"worktreePath":"/tmp/wt","branchName":"paseo/x","commands":[]}',
    JSON.stringify(setup.input),
  );
  check("so does its output", setup.output === "created /tmp/wt", JSON.stringify(setup.output));
  // Blank, in the client's own terms: every one of input/output empty. A
  // `worktree_setup` call always carries required arguments, so this holds.
  check(
    "nothing the row draws is empty",
    setup.input !== null &&
      typeof setup.input === "object" &&
      Object.keys(setup.input).length > 0 &&
      setup.output !== null &&
      setup.output !== "",
    JSON.stringify({ input: setup.input, output: setup.output }),
  );

  const withMeta = runTool(
    "worktree_setup",
    { worktreePath: "/tmp/wt" },
    "log",
    { branchName: "paseo/x" },
  );
  check(
    "a presentationMeta still rides along for a client that learns the shape",
    itemMeta(withMeta)?.branchName === "paseo/x",
    JSON.stringify(itemMeta(withMeta)),
  );
}

console.log("\nevery detail type the server can emit is one the client draws");
{
  // A copy of the `switch (type)` in `client/tool-call-data.ts`, on purpose: that
  // switch is the contract, and a provider-side type outside it is a blank row
  // waiting to happen (which is how `worktree_setup` was found). If the client
  // gains a branch, add it here; nothing else in this file has to change.
  const DRAWABLE = new Set([
    "shell",
    "read",
    "write",
    "edit",
    "search",
    "fetch",
    "sub_agent",
    "plain_text",
    "plan",
    "unknown",
  ]);
  const names = [
    "bash",
    "pwsh",
    "read",
    "write",
    "edit",
    "grep",
    "glob",
    "web_search",
    "web_fetch",
    "todo_write",
    "ask_user_question",
    "exit_plan_mode",
    "subagent",
    "worktree_setup",
    "read_image",
    "job_kill",
    "skill",
    "mcp__paseo__list_workspaces",
  ];
  for (const name of names) {
    const detail = runTool(name, { a: 1 }, "out").detail;
    check(`${name}: ${detail.type} is drawable`, DRAWABLE.has(detail.type), detail.type);
  }
}

console.log("the meta survives the plugin's own event schema");
{
  // The plugin subprocess parses every outgoing event with `ProviderEventSchema`
  // before it leaves the process, and `toolCallDetailSchema`'s members are all
  // `.strip()` — a field on `detail` that the schema does not name is deleted,
  // with no error anywhere. That is exactly how the first version of this
  // pass-through was lost: the builder attached `detail.meta`, the parse dropped
  // it, and the client rendered every structured row from the lossy text. So the
  // boundary itself is exercised here, not assumed.
  const item = runTool("read", { file_path: "/repo/src/app.ts" }, "1: const a = 1;", {
    path: "/repo/src/app.ts",
    offset: 1,
    lines: [{ number: 1, text: "const a = 1;" }],
    totalLines: 40,
    lang: "typescript",
  });
  const parsed = ProviderEventSchema.parse({ type: "timeline.item", sessionId: "s1", item });

  check(
    "the raw meta is still there after ProviderEventSchema.parse",
    parsed.item.metadata?.presentationMeta?.lines?.[0]?.text === "const a = 1;",
    JSON.stringify(parsed.item.metadata),
  );
  check(
    "the language survives too",
    parsed.item.metadata?.presentationMeta?.lang === "typescript",
    JSON.stringify(parsed.item.metadata?.presentationMeta),
  );
  check(
    "the description and locale keys are not clobbered by it",
    parsed.item.metadata?.locale === LOCALE,
    JSON.stringify(parsed.item.metadata),
  );
  check(
    "the detail arrives without a meta field",
    !("meta" in parsed.item.detail),
    JSON.stringify(Object.keys(parsed.item.detail)),
  );

  // And the pitfall itself, so a future "just put it back on the detail" change
  // fails here rather than silently on a device.
  const withDetailMeta = ProviderEventSchema.parse({
    type: "timeline.item",
    sessionId: "s1",
    item: { ...item, detail: { ...item.detail, meta: { probe: true } } },
  });
  check(
    "a detail-level meta is still stripped (why it lives on metadata)",
    !("meta" in withDetailMeta.item.detail),
    JSON.stringify(Object.keys(withDetailMeta.item.detail)),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
