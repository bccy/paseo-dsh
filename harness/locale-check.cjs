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

console.log("row copy follows the locale, not the import");
{
  const shell = { name: "bash", status: "completed", detail: { type: "shell", command: "npm test", output: "ok" } };
  const plan = { name: "exit_plan_mode", status: "completed", detail: { type: "plan", text: "- step" } };
  const mcp = { name: "mcp__paseo__delete_heartbeat", status: "completed", detail: { type: "unknown", input: { id: "x" }, output: "ok" } };

  setLocale("zh-CN");
  equal("a shell row is labelled in Chinese", toolCallData(shell, "complete").label, "命令");
  equal("its block caption too", toolCallData(shell, "complete").bodyLabel, "输出");
  equal("a plan row leads with the Chinese title", toolCallData(plan, "complete").summary, "计划");
  equal("a Paseo MCP row is labelled in Chinese", toolCallData(mcp, "complete").label, "删除心跳");

  setLocale("en");
  equal("the same row is labelled in English once the locale is relayed", toolCallData(shell, "complete").label, "Command");
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
