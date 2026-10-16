/**
 * Offline assertions for the client's display locale and its label tables.
 *
 * Two things here are invisible in the UI and therefore need assertions rather
 * than eyeballing:
 *
 * 1. **Locale resolution.** The client half cannot read the daemon's
 *    environment, so `client/locale.ts` writes the server's chain down as a pure
 *    function and keeps its own default. A wrong precedence (`LANG` winning over
 *    `DSH_PASEO_LANG`, `LC_ALL` losing to `LANG`) would look like "the setting
 *    does nothing" — the exact failure this file exists to catch.
 * 2. **Table coverage.** A tool name missing from the label table renders as its
 *    wire name next to a generic wrench, which looks like a working row and is
 *    the reason this repo keeps finding the same bug. The newly covered names
 *    are asserted by name, and every table entry is asserted to have a value in
 *    *both* languages — an English column that is a copy of the Chinese one is
 *    indistinguishable from a translated one until someone switches.
 *
 * Icon names are Lucide exports of the host bundle, not strings this repo can
 * resolve offline. They were checked against the installed Paseo web bundle with
 * `grep -o ',"<Name>",{enumerable:!0,get:' <web-ui>/index-*.js` (the lucide-react
 * re-export list), so what is asserted here is that each new name *has* an icon,
 * not that the host can draw it.
 *
 * Run (from paseo-plugin):
 *   npx tsc client/locale.ts client/tool-call-data.ts \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/locale-check.cjs .dbg/
 *   cd .dbg && node locale-check.cjs
 *
 * Only pure modules are compiled: the React renderers import the host runtime,
 * which plain `node` resolution cannot see.
 */
"use strict";

const { allText, currentLocale, localeFromMetadata, resolveLocale, setLocale } = require("./client/locale.js");
const { toolCallData, toolIcon, toolLabel } = require("./client/tool-call-data.js");

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition === true) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label} — ${detail === undefined ? String(condition) : detail}`);
  }
}

function equal(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

/** The languages this plugin ships, so a third one cannot slip in unnoticed. */
const LOCALES = ["en", "zh-CN"];

console.log("locale resolution (the server's chain, over an env the caller supplies)");
{
  equal(
    "DSH_PASEO_LANG beats a Chinese LC_ALL and LANG",
    resolveLocale({ DSH_PASEO_LANG: "en", LC_ALL: "zh_CN.UTF-8", LANG: "zh_CN.UTF-8" }),
    "en",
  );
  equal(
    "DSH_PASEO_LANG picks Chinese on an English host",
    resolveLocale({ DSH_PASEO_LANG: "zh", LANG: "en_US.UTF-8" }),
    "zh-CN",
  );
  equal(
    "a blank DSH_PASEO_LANG is not an override",
    resolveLocale({ DSH_PASEO_LANG: "   ", LANG: "en_US.UTF-8" }),
    "en",
  );
  equal(
    "LC_ALL beats LANG",
    resolveLocale({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }),
    "zh-CN",
  );
  equal(
    "LC_MESSAGES beats LANG",
    resolveLocale({ LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }),
    "zh-CN",
  );
  equal("LANG decides when nothing else is set", resolveLocale({ LANG: "zh_CN.UTF-8" }), "zh-CN");
  equal("a POSIX LANG falls through to English", resolveLocale({ LANG: "C" }), "en");
  equal("zh-Hans-CN is Chinese", resolveLocale({ DSH_PASEO_LANG: "zh-Hans-CN" }), "zh-CN");
  equal(
    "an empty environment takes the client default",
    resolveLocale({}),
    "zh-CN",
  );
  // The chain itself is the server's; only the last resort differs, because the
  // client has no environment of its own to read. Passing the server's fallback
  // is what proves those two statements at once.
  equal(
    "the same chain with the server's fallback is English",
    resolveLocale({}, "en"),
    "en",
  );
}

console.log("the locale in effect, and the relay that sets it");
{
  equal("nothing relayed yet means the client default", currentLocale(), "zh-CN");
  setLocale("en");
  equal("a relayed locale is adopted", currentLocale(), "en");
  setLocale("zh-CN");
  equal("and can be switched back", currentLocale(), "zh-CN");
  setLocale("  ");
  equal("a blank relay clears instead of switching to English", currentLocale(), "zh-CN");
  setLocale("en");
  setLocale(undefined);
  equal("undefined clears the relay", currentLocale(), "zh-CN");
  setLocale(7);
  equal("a non-string relay clears rather than switching", currentLocale(), "zh-CN");

  equal("the protocol's metadata can carry it", localeFromMetadata({ locale: "en" }), "en");
  equal("zh-CN travels too", localeFromMetadata({ locale: "zh-CN" }), "zh-CN");
  equal(
    "metadata without a locale says nothing",
    localeFromMetadata({ description: "List DSH checkout root" }),
    undefined,
  );
  equal("null metadata says nothing", localeFromMetadata(null), undefined);
  equal("a non-string locale says nothing", localeFromMetadata({ locale: 7 }), undefined);
  equal("a non-object metadata says nothing", localeFromMetadata("locale=en"), undefined);
}

console.log("the two tables carry the same keys");
{
  const en = allText().en;
  const zh = allText()["zh-CN"];

  equal("both languages are shipped, under the ids the server uses", Object.keys(allText()).sort(), [...LOCALES].sort());
  equal("top-level keys match", Object.keys(en).sort(), Object.keys(zh).sort());

  for (const table of ["toolLabels", "paseoMcpLabels", "bodyLabels"]) {
    equal(`${table} keys match`, Object.keys(en[table]).sort(), Object.keys(zh[table]).sort());
    equal(`${table} is not empty`, Object.keys(en[table]).length > 0, true);
    for (const locale of LOCALES) {
      const empty = Object.entries(allText()[locale][table]).filter(
        ([, value]) => typeof value !== "string" || value.trim() === "",
      );
      equal(`${table} has a value for every key in ${locale}`, empty.length, 0);
    }
  }

  const scalarKeys = Object.keys(en).filter((key) => typeof en[key] === "string");
  check("every non-table key has a value in both languages", scalarKeys.length > 0, String(scalarKeys.length));
  for (const key of scalarKeys) {
    check(
      `${key} is set in both languages`,
      typeof zh[key] === "string" && zh[key] !== "" && en[key] !== "",
      JSON.stringify([en[key], zh[key]]),
    );
  }
}

console.log("the tools that used to render as wire names + a wrench");
{
  // DSH titles the first seven through `tool.title.*` (their copy is DSH's own),
  // `skill` through `dsh-client-ui-skill`'s `row.title`, and the MCP-resource
  // three have no DSH title at all — theirs is the short form of the tool's own
  // registered description. What matters is that none of the eleven is anonymous.
  const covered = [
    "lsp",
    "spawn_teammate",
    "team_task_create",
    "team_task_get",
    "team_task_list",
    "team_task_update",
    "wait_agent",
    "skill",
    "list_mcp_resources",
    "read_mcp_resource",
    "list_mcp_resource_templates",
  ];

  const previous = currentLocale();
  for (const name of covered) {
    const labels = {};
    for (const locale of LOCALES) {
      setLocale(locale);
      labels[locale] = toolLabel(name);
      check(
        `${name} has a label in ${locale} rather than its wire name`,
        labels[locale] !== name && labels[locale].trim() !== "",
        labels[locale],
      );
      const icon = toolIcon(name, { type: "unknown" });
      check(`${name} has an icon (${locale} run)`, icon !== "Wrench" && icon !== "", icon);
    }
    // A table whose English column was copied from the Chinese one would pass
    // every "has a value" check above and still be untranslated.
    check(
      `${name} reads differently in English and Chinese`,
      labels.en !== labels["zh-CN"],
      `${labels.en} vs ${labels["zh-CN"]}`,
    );

    // The icon must also win over the typed-detail fallback the same way, i.e.
    // these names are looked up even when the host sends no detail at all.
    const noDetail = toolIcon(name, undefined);
    check(`${name} keeps its icon with no detail at all`, noDetail !== "Wrench", noDetail);
  }
  setLocale(previous);
}

console.log("the DSH titles, verbatim (its English table is not regular)");
{
  // Every pair below was read out of the installed DSH bundle: the tool's own
  // row title key (`TOOL_TITLE_KEYS` / `VARIANT_TITLE_KEYS` in
  // `dsh-client-ui-tool`, the `SEARCH_TITLE_KEYS` and `WEB_TITLE_KEYS` used by
  // the search and web rows) resolved against `dsh-client-ui-conversation`'s
  // zh/en tables. They are pinned by hand because the harness is offline and
  // cannot read that bundle, and because DSH's English column is *not* a tidy
  // translation of the Chinese one: `bash` is "Bash" but `pwsh` is "Pwsh",
  // `grep`/`glob` are "Grep"/"Glob" while `web_search` is plain "Search".
  // A later "consistency fix" is exactly what this catches.
  const cases = [
    // `run_code` is DSH's PTC transport, and it has no `TOOL_TITLE_KEYS` entry
    // of its own: `TOOL_VARIANTS.run_code = "code"` routes it to the `code`
    // variant's title, `tool.title.code`. Without a label here the row showed
    // the wire name `run_code`, which is the silent degradation this file is
    // for.
    ["run_code", "代码", "Code"],
    ["bash", "运行命令", "Bash"],
    ["pwsh", "运行命令", "Pwsh"],
    ["grep", "搜索文件内容", "Grep"],
    ["glob", "查找文件", "Glob"],
    ["web_search", "网页搜索", "Search"],
    ["web_fetch", "网页获取", "Fetch"],
    ["todo_write", "更新任务清单", "Update to-do list"],
    ["subagent", "创建子智能体", "Create subagent"],
    ["list_agents", "查看子智能体", "List subagents"],
    ["send_message", "发送消息", "Send message"],
    ["interrupt_agent", "中断智能体", "Interrupt agent"],
    ["list_subagent_models", "查看可用模型", "List models"],
    ["job_list", "查看后台任务", "List background jobs"],
    ["job_output", "读取任务输出", "Read job output"],
    ["job_kill", "取消后台任务", "Cancel background job"],
    ["terminal_open", "创建终端", "Open terminal"],
    ["terminal_list", "查看终端", "List terminals"],
    ["workflow", "运行工作流", "Run workflow"],
    ["ralph", "运行循环工作流", "Run ralph loop"],
    ["schedule_list", "查看定时任务", "List reminders"],
    ["schedule_update", "修改定时任务", "Update reminder"],
    ["session_event_read", "读取事件", "Read event"],
    ["session_event_search", "搜索事件", "Search events"],
    ["session_event_trace", "追踪事件", "Trace event"],
    ["cordis_run", "运行 Cordis 插件", "Run Cordis Plugin"],
    ["cordis_stop", "停止 Cordis 插件", "Stop Cordis Plugin"],
    ["cordis_undefine", "移除 Cordis 插件", "Remove Cordis Plugin"],
    ["cordis_package_inspect", "查询 Cordis 环境", "Query Cordis environment"],
    ["cordis_runtime_inspect", "查询 Cordis 环境", "Query Cordis environment"],
    ["cordis_inspect_list", "检查提供方", "Inspect providers"],
    ["cordis_inspect_self", "检查动态插件", "Inspect plugins"],
    // `skill` is the trap this list exists for: it is not in DSH's
    // TOOL_TITLE_KEYS at all (its own package, `dsh-client-ui-skill`, titles the
    // row), so a mechanical resolution silently falls back to the generic row's
    // 工具调用 / Tool call. It was wrong here once already.
    ["skill", "加载技能", "Skill"],
  ];
  for (const [name, zh, en] of cases) {
    setLocale("zh-CN");
    equal(`${name} (zh)`, toolLabel(name), zh);
    setLocale("en");
    equal(`${name} (en)`, toolLabel(name), en);
  }
  setLocale(undefined);
}

console.log("a tool row adopts the locale its item carries");
{
  // The transformer calls `setLocale(localeFromMetadata(item.metadata))` before
  // it maps the item (asserted against the source in `tool-call-check.cjs`); the
  // data-layer half of that contract is what runs here. `metadata` is the only
  // free-form passthrough the protocol has, and only a tool-call item carries
  // one — the reasoning and assistant schemas have no `metadata` field — so a
  // session that opens with thinking text renders that row in the default until
  // the first tool call arrives. That is a protocol limit, not a bug.
  const item = {
    name: "bash",
    status: "completed",
    detail: { type: "shell", command: "ls", output: "x" },
    metadata: { locale: "en" },
  };
  setLocale(undefined);
  equal("with no relay the default stands", currentLocale(), "zh-CN");
  equal("so the row is Chinese", toolCallData(item, "complete").label, "运行命令");

  setLocale(localeFromMetadata(item.metadata));
  equal("the item's locale is adopted", currentLocale(), "en");
  equal("and the row follows", toolCallData(item, "complete").label, "Bash");

  setLocale(localeFromMetadata({ locale: "zh-CN" }));
  equal("the other direction too", toolCallData(item, "complete").label, "运行命令");

  setLocale(localeFromMetadata({}));
  equal("an item with no locale clears the relay", currentLocale(), "zh-CN");
  equal("back to the default row", toolCallData(item, "complete").label, "运行命令");

  setLocale(localeFromMetadata("not-an-object"));
  equal("an unreadable hint does not guess", currentLocale(), "zh-CN");
}

console.log("row copy follows the locale, not the import");
{
  const shell = { name: "bash", status: "completed", detail: { type: "shell", command: "npm test", output: "ok" } };
  const plan = { name: "exit_plan_mode", status: "completed", detail: { type: "plan", text: "- step" } };
  const mcp = { name: "mcp__paseo__delete_heartbeat", status: "completed", detail: { type: "unknown", input: { id: "x" }, output: "ok" } };

  setLocale("zh-CN");
  equal("a shell row is labelled in Chinese", toolCallData(shell, "complete").label, "运行命令");
  equal("its block caption too", toolCallData(shell, "complete").bodyLabel, "输出");
  equal("a plan row leads with the Chinese title", toolCallData(plan, "complete").summary, "计划");
  equal("a Paseo MCP row is labelled in Chinese", toolCallData(mcp, "complete").label, "删除心跳");

  setLocale("en");
  equal("the same row is labelled in English once the locale is relayed", toolCallData(shell, "complete").label, "Bash");
  equal("and so is the block caption", toolCallData(shell, "complete").bodyLabel, "Output");
  equal("the plan row follows", toolCallData(plan, "complete").summary, "Plan");
  equal("the Paseo MCP row follows", toolCallData(mcp, "complete").label, "Delete heartbeat");

  const huge = { name: "bash", status: "completed", detail: { type: "shell", command: "x", output: "y".repeat(7000) } };
  check(
    "the truncation marker is localized",
    toolCallData(huge, "complete").body.endsWith(allText().en.truncated),
    JSON.stringify(toolCallData(huge, "complete").body.slice(-20)),
  );
  setLocale("zh-CN");
  check(
    "and Chinese again after switching back",
    toolCallData(huge, "complete").body.endsWith(allText()["zh-CN"].truncated),
    JSON.stringify(toolCallData(huge, "complete").body.slice(-20)),
  );

  equal("an unknown tool still keeps its wire name", toolLabel("frobnicate"), "frobnicate");
  setLocale("en");
  equal("in English too", toolLabel("frobnicate"), "frobnicate");
  setLocale(undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
