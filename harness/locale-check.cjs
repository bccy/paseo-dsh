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
 * 3. **Drift from the official catalog.** Paseo 0.12 ships `PASEO_TOOL_CATALOG`
 *    in `@getpaseo/protocol` (61 tools). The plugin's English MCP column is
 *    asserted equal to those labels *verbatim* and the icon table is asserted to
 *    cover every one of them, so a hand-written "nicer" label or a forgotten new
 *    tool is a test failure instead of a row that reads differently from Paseo's
 *    own UI. `speak` is Paseo's documented exception (its own `isPaseoToolName`
 *    excludes it) and is the only entry allowed beyond the catalog.
 * 4. **Coverage of the mount, not just of the tables.** The `PASEO_TOOL_CATALOG`
 *    is Paseo's own tools; the profile also mounts DSH/plugin tools whose names
 *    no table in this repo can enumerate. A checked-in snapshot of every tool
 *    name a real `request/header` on this machine has offered the model
 *    (`docs/research/table-labels.md` has the scan) is asserted end-to-end: each
 *    one must have a label in both languages and its own glyph. This is the check
 *    that would have caught `memory_search` printing the wire name next to a
 *    wrench. Another MCP server's tools and model-invented names are asserted to
 *    keep the wire name, because that is the documented fallback — not a gap.
 *
 * Icon names are Lucide exports of the host bundle, not strings this repo can
 * resolve offline. They were checked against the installed Paseo web bundle with
 * `grep -o ',"<Name>",{enumerable:!0,get:' <web-ui>/index-*.js` (the lucide-react
 * re-export list), so what is asserted here is that each new name *has* an icon,
 * not that the host can draw it. That grep was also run for the four browser
 * action glyphs added in 0.12 (`ArrowLeft`, `ArrowRight`, `RotateCw`,
 * `MousePointer`).
 *
 * Run (from paseo-plugin):
 *   npx tsc client/locale.ts client/tool-call-data.ts \
 *     --outDir .dbg --rootDir . --module node16 --moduleResolution node16 \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/locale-check.cjs .dbg/
 *   cd .dbg && node locale-check.cjs
 *
 * `--module node16` is kept because this harness still `require`s the protocol
 * package at run time (`PASEO_TOOL_CATALOG`), and node16 is the resolution mode
 * that honours its `exports` map while emitting CommonJS. The `AgentMessage`
 * type is no longer read from that package — it is declared locally in
 * `client/agent-message.ts`, because Paseo 0.11 and earlier resolve type-only
 * imports at install time and that module does not exist there
 * (`requirements.paseo` is `>=0.9.2`).
 *
 * Only pure modules are compiled: the React renderers import the host runtime,
 * which plain `node` resolution cannot see.
 */
"use strict";

const {
  AGENT_MESSAGE_EVENTS,
  allText,
  currentLocale,
  goalControlErrorDisplay,
  teamToolErrorDisplay,
  localeFromMetadata,
  resolveLocale,
  setLocale,
} = require("./client/locale.js");
const { TOOL_ICON_NAMES, UNNAMED_TOOL, toolCallData, toolIcon, toolLabel } = require("./client/tool-call-data.js");
const fs = require("node:fs");
const path = require("node:path");

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

  for (const table of ["toolLabels", "paseoMcpLabels", "agentMessageEvents", "bodyLabels"]) {
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

console.log("the goal tools' timeline copy is covered in both languages");
{
  // `goalCard` is an object, so the scalar loop above skips it. Its tables must
  // carry the same keys in both languages and every leaf must be set: a missing
  // refusal sentence in one language would silently fall back to DSH's English.
  const en = allText().en.goalCard;
  const zh = allText()["zh-CN"].goalCard;
  equal("goalCard keys match", Object.keys(en).sort(), Object.keys(zh).sort());
  equal("goalCard.phases keys match", Object.keys(en.phases).sort(), Object.keys(zh.phases).sort());
  equal("goalCard.phases are DSH's four phases plus disarmed", Object.keys(en.phases).sort(),
    ["active", "blocked", "complete", "disarmed", "paused"]);
  equal("goalCard.refusals keys match", Object.keys(en.refusals).sort(), Object.keys(zh.refusals).sort());
  for (const [locale, table] of [["en", en], ["zh-CN", zh]]) {
    const leaves = [table.status, table.rounds, table.reason, table.empty, ...Object.values(table.phases),
      ...Object.values(table.refusals).flatMap((r) => [r.short, r.hint])];
    check(`every goalCard string is set (${locale})`, leaves.every((v) => typeof v === "string" && v.trim() !== ""), JSON.stringify(leaves));
  }
  equal("the state row's own title (zh-CN)", allText()["zh-CN"].toolLabels.goal_state, "目标状态");
  equal("the state row's own title (en)", allText().en.toolLabels.goal_state, "Goal status");
}

console.log("the jobs pill's copy is covered in both languages");
{
  // The `jobs` table is an **object**, so the `scalarKeys` loop above skips it and
  // it is not in the list of string tables either: before this block existed, the
  // whole table was unasserted. A missing `statuses` key renders as the wire name
  // (`text.statuses[job.status] ?? job.status` in `client/jobs-pill.tsx`), which is
  // exactly the silent downgrade the tables exist to prevent.
  const en = allText().en.jobs;
  const zh = allText()["zh-CN"].jobs;
  check("both languages ship a jobs table", en !== undefined && zh !== undefined);

  // Every key the interface declares must be present in both, and the two key
  // sets must match — a key added to one language only is the drift this catches.
  equal("jobs keys match", Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of ["liveLabel", "title", "statuses", "allSettled", "settledLabel", "unavailable"]) {
    check(`jobs.${key} exists in both languages`, en[key] !== undefined && zh[key] !== undefined);
  }
  // CJ-01 route 2: the pill is a live indicator and `liveLabel` is its only
  // count phrase. A stale `idleLabel` is exactly the second count shape the
  // history-visible regression added, so its absence is asserted per language.
  check("jobs has no idleLabel (en)", !("idleLabel" in en));
  check("jobs has no idleLabel (zh-CN)", !("idleLabel" in zh));
  // The count's wording is product copy: "N background" / "N 个后台", no noun.
  // Asserted verbatim, including the singular, because a pluralised "jobs" or a
  // restored "任务" would silently drift from the agreed label.
  check("jobs.liveLabel(1) is `1 background` (en)", en.liveLabel(1) === "1 background", JSON.stringify(en.liveLabel(1)));
  check("jobs.liveLabel(2) is `2 background` (en)", en.liveLabel(2) === "2 background", JSON.stringify(en.liveLabel(2)));
  check("jobs.liveLabel(1) is `1 个后台` (zh-CN)", zh.liveLabel(1) === "1 个后台", JSON.stringify(zh.liveLabel(1)));
  check("jobs.liveLabel(2) is `2 个后台` (zh-CN)", zh.liveLabel(2) === "2 个后台", JSON.stringify(zh.liveLabel(2)));
  // A function returning "" would render an empty pill; call it in both languages.
  for (const locale of LOCALES) {
    const table = allText()[locale].jobs;
    const live = table.liveLabel(2);
    check(
      `jobs.liveLabel(2) is a non-empty string in ${locale}`,
      typeof live === "string" && live.trim() !== "",
      JSON.stringify(live),
    );
  }
  for (const locale of LOCALES) {
    const table = allText()[locale].jobs;
    check(
      `jobs.settledLabel is a plain string, not a count-taking function (${locale})`,
      typeof table.settledLabel === "string" && table.settledLabel.trim() !== "",
      JSON.stringify(table.settledLabel),
    );
  }

  // The plain strings.
  for (const locale of LOCALES) {
    const table = allText()[locale].jobs;
    for (const key of ["title", "allSettled", "settledLabel", "unavailable"]) {
      check(
        `jobs.${key} is a non-empty string in ${locale}`,
        typeof table[key] === "string" && table[key].trim() !== "",
        JSON.stringify(table[key]),
      );
    }
  }

  // The English column must not be a copy of the Chinese one: a translated table
  // and a duplicated one look identical until someone switches language.
  const copied = ["title", "allSettled", "settledLabel", "unavailable"].filter((key) => en[key] === zh[key]);
  equal("the English jobs copy is not the Chinese copy", copied, []);

  // **`statuses` must cover exactly the statuses `shared/jobs.ts` declares.**
  // Read out of that file with a regex, not required: it imports zod and the
  // plugin package. A key missing here falls back to the wire name on screen.
  const sharedJobsPath =
    process.env.SHARED_JOBS ?? path.resolve(__dirname, "..", "..", "paseo-plugin", "shared", "jobs.ts");
  check("shared/jobs.ts is readable", fs.existsSync(sharedJobsPath), sharedJobsPath);
  const declaration = fs.existsSync(sharedJobsPath)
    ? /export const JOB_STATUSES = \[([^\]]*)\] as const;/.exec(fs.readFileSync(sharedJobsPath, "utf8"))
    : null;
  const statuses =
    declaration === null ? undefined : [...declaration[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check(
    "JOB_STATUSES is readable out of shared/jobs.ts",
    statuses !== undefined && statuses.length > 0,
    `no array literal in ${sharedJobsPath}`,
  );
  if (statuses !== undefined) {
    equal("jobs.statuses keys are exactly JOB_STATUSES (en)", Object.keys(en.statuses).sort(), [...statuses].sort());
    equal("jobs.statuses keys are exactly JOB_STATUSES (zh-CN)", Object.keys(zh.statuses).sort(), [...statuses].sort());
    for (const locale of LOCALES) {
      const table = allText()[locale].jobs.statuses;
      const empty = Object.entries(table).filter(
        ([, value]) => typeof value !== "string" || value.trim() === "",
      );
      equal(`jobs.statuses has a value for every key in ${locale}`, empty.length, 0);
    }
    // And the status words must actually differ between the languages, for the
    // same reason as the copy check above.
    const same = statuses.filter((status) => en.statuses[status] === zh.statuses[status]);
    equal("the English status words are not the Chinese ones", same, []);
  }
}

console.log("the goal pill's copy is covered in both languages");
{
  // Same reason as the jobs table above: `goal` is an **object**, so the
  // `scalarKeys` loop skips it. A missing entry here would render as an empty
  // pill label or a raw phase name, which is exactly the silent downgrade the
  // copy tables exist to prevent.
  const en = allText().en.goal;
  const zh = allText()["zh-CN"].goal;
  check("both languages ship a goal table", en !== undefined && zh !== undefined);

  equal("goal keys match", Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of [
    "title",
    "running",
    "notRunning",
    "paused",
    "blocked",
    "complete",
    "completeHint",
    "completeClearHint",
    "rowLabel",
    "statuses",
    "rounds",
    "currentTaskPrefix",
    "disarmedHint",
    "clearHint",
    "actions",
    "editor",
    "editPlaceholder",
    "runningA11y",
    "busy",
    "controlFailed",
    "unavailable",
    "noGoal",
  ]) {
    check(`goal.${key} exists in both languages`, en[key] !== undefined && zh[key] !== undefined);
  }

  // **The four labels, verbatim.** The whole point of the pill is that these
  // four states are told apart; a "nicer" wording that collapses `notRunning`
  // into `active` would be the silent degradation the surface was built to
  // expose.
  check("goal.running is `Goal running` (en)", en.running === "Goal running", JSON.stringify(en.running));
  check("goal.running is `目标进行中` (zh-CN)", zh.running === "目标进行中", JSON.stringify(zh.running));
  // The round budget is a sentence, never a fraction.
  check("goal.rounds(3,10) is `Round 3 · budget 10` (en)", en.rounds(3, 10) === "Round 3 · budget 10", JSON.stringify(en.rounds(3, 10)));
  check("goal.rounds(3,10) is `第 3 轮 · 预算 10` (zh-CN)", zh.rounds(3, 10) === "第 3 轮 · 预算 10", JSON.stringify(zh.rounds(3, 10)));
  check("goal.currentTaskPrefix is `Now: ` (en)", en.currentTaskPrefix === "Now: ", JSON.stringify(en.currentTaskPrefix));
  check("goal.currentTaskPrefix is `正在：` (zh-CN)", zh.currentTaskPrefix === "正在：", JSON.stringify(zh.currentTaskPrefix));
  check("goal.notRunning is `Goal not running` (en)", en.notRunning === "Goal not running", JSON.stringify(en.notRunning));
  check("goal.notRunning is `目标未在续跑` (zh-CN)", zh.notRunning === "目标未在续跑", JSON.stringify(zh.notRunning));
  check("goal.paused is `Goal paused` (en)", en.paused === "Goal paused", JSON.stringify(en.paused));
  check("goal.paused is `目标已暂停` (zh-CN)", zh.paused === "目标已暂停", JSON.stringify(zh.paused));
  check("goal.blocked is `Goal blocked` (en)", en.blocked === "Goal blocked", JSON.stringify(en.blocked));
  check("goal.blocked is `目标受阻` (zh-CN)", zh.blocked === "目标受阻", JSON.stringify(zh.blocked));
  // UI-v7: the completed state, its panel hint and its own clear sentence.
  check("goal.complete is `Goal complete` (en)", en.complete === "Goal complete", JSON.stringify(en.complete));
  check("goal.complete is `目标已完成` (zh-CN)", zh.complete === "目标已完成", JSON.stringify(zh.complete));
  check(
    "goal.completeHint points at the closing message (zh-CN)",
    zh.completeHint === "完成总结见会话最后一条助手消息",
    JSON.stringify(zh.completeHint),
  );
  check(
    "goal.completeHint points at the closing message (en)",
    en.completeHint.includes("last assistant message"),
    JSON.stringify(en.completeHint),
  );
  check(
    "goal.completeClearHint is the complete page's sentence (zh-CN)",
    zh.completeClearHint === "清除后 /goal 将查不到这个目标，无法撤销",
    JSON.stringify(zh.completeClearHint),
  );
  check(
    "goal.completeClearHint names /goal and says it is final (en)",
    en.completeClearHint.includes("/goal") && en.completeClearHint.toLowerCase().includes("cannot be undone"),
    JSON.stringify(en.completeClearHint),
  );
  check("the complete clear sentence is not the active one (zh-CN)", zh.completeClearHint !== zh.clearHint);
  // The row name: the state first, then the action.
  check("goal.rowLabel joins state and action (zh-CN)", zh.rowLabel("目标进行中", "编辑目标") === "目标进行中，编辑目标", JSON.stringify(zh.rowLabel("a", "b")));
  check("goal.rowLabel joins state and action (en)", en.rowLabel("Goal running", "Edit goal") === "Goal running, Edit goal", JSON.stringify(en.rowLabel("a", "b")));
  // `active + disarmed` is not a phase; its facts word must exist and match the
  // design's disarmed state (v1 §98).
  check("goal.statuses.disarmed is `Not continuing` (en)", en.statuses.disarmed === "Not continuing", JSON.stringify(en.statuses.disarmed));
  check("goal.statuses.disarmed is `未在续跑` (zh-CN)", zh.statuses.disarmed === "未在续跑", JSON.stringify(zh.statuses.disarmed));
  // The disarmed hint is copy B (design-opus-v4 §1): the reason and the fix,
  // verbatim in both languages. The fix names the ▶ button, so its name must be
  // the button's own (checked below).
  check(
    "goal.disarmedHint is hint B (zh-CN)",
    zh.disarmedHint === "重开会话后自动续跑会停止，点「继续」恢复",
    JSON.stringify(zh.disarmedHint),
  );
  check(
    "goal.disarmedHint is hint B (en)",
    en.disarmedHint === "Auto-continue stops when the session is reopened. Press Resume to continue.",
    JSON.stringify(en.disarmedHint),
  );
  check("the hint names the ▶ button (zh-CN)", zh.disarmedHint.includes("继续") && zh.actions.resumeTarget.startsWith("继续"));
  check("the hint names the ▶ button (en)", en.disarmedHint.includes("Resume") && en.actions.resumeTarget.startsWith("Resume"));

  // The clear page's hint is the design's sentence: clearing is final. Verbatim
  // in Chinese; English must say the same thing.
  check("goal.clearHint is the design's sentence (zh-CN)", zh.clearHint === "清除后目标不再续跑，无法撤销", JSON.stringify(zh.clearHint));
  check(
    "goal.clearHint says clearing is final (en)",
    en.clearHint.toLowerCase().includes("cannot be undone"),
    JSON.stringify(en.clearHint),
  );

  // The plain strings.
  for (const locale of LOCALES) {
    const table = allText()[locale].goal;
    for (const key of [
      "title",
      "notRunning",
      "paused",
      "blocked",
      "complete",
      "completeHint",
      "completeClearHint",
      "disarmedHint",
      "clearHint",
      "currentTaskPrefix",
      "editPlaceholder",
      "runningA11y",
      "busy",
      "controlFailed",
      "unavailable",
      "noGoal",
    ]) {
      check(
        `goal.${key} is a non-empty string in ${locale}`,
        typeof table[key] === "string" && table[key].trim() !== "",
        JSON.stringify(table[key]),
      );
    }
  }

  // The row-end icon buttons and the edit/clear pages' labels. The two icon
  // buttons carry no visible text, so these strings are their accessibility
  // names — the only way a screen reader can tell pause from clear.
  equal("goal.actions keys match", Object.keys(en.actions).sort(), Object.keys(zh.actions).sort());
  for (const locale of LOCALES) {
    const actions = allText()[locale].goal.actions;
    for (const key of ["pauseTarget", "resumeTarget", "edit", "clearTarget", "cancel"]) {
      check(
        `goal.actions.${key} is a non-empty string in ${locale}`,
        typeof actions[key] === "string" && actions[key].trim() !== "",
        JSON.stringify(actions[key]),
      );
    }
  }
  check("the edit row names the goal (en)", en.actions.edit === "Edit goal", JSON.stringify(en.actions.edit));
  check("the edit row names the goal (zh-CN)", zh.actions.edit === "编辑目标", JSON.stringify(zh.actions.edit));
  check("the clear row names the goal (en)", en.actions.clearTarget === "Clear goal", JSON.stringify(en.actions.clearTarget));
  check("the clear row names the goal (zh-CN)", zh.actions.clearTarget === "清除目标", JSON.stringify(zh.actions.clearTarget));
  check("the pause button names the goal (en)", en.actions.pauseTarget === "Pause goal", JSON.stringify(en.actions.pauseTarget));
  check("the pause button names the goal (zh-CN)", zh.actions.pauseTarget === "暂停目标", JSON.stringify(zh.actions.pauseTarget));
  check("the resume button names the goal (en)", en.actions.resumeTarget === "Resume goal", JSON.stringify(en.actions.resumeTarget));
  check("the continue button names the goal (zh-CN)", zh.actions.resumeTarget === "继续目标", JSON.stringify(zh.actions.resumeTarget));
  equal(
    "the English actions are not the Chinese actions",
    ["pauseTarget", "resumeTarget", "edit", "clearTarget", "cancel"].filter((key) => en.actions[key] === zh.actions[key]),
    [],
  );

  // The edit page (design-opus-v4 direction C). Key names stay as the keyboard
  // prints them in both languages; every other string is translated.
  equal("goal.editor keys match", Object.keys(en.editor).sort(), Object.keys(zh.editor).sort());
  const editorKeys = ["title", "save", "cancel", "escKey", "escHint", "enterKey", "enterHint", "shiftEnterKey", "shiftEnterHint"];
  equal("goal.editor has exactly the page's strings", Object.keys(zh.editor).sort(), [...editorKeys].sort());
  for (const locale of LOCALES) {
    const editor = allText()[locale].goal.editor;
    for (const key of editorKeys) {
      check(
        `goal.editor.${key} is a non-empty string in ${locale}`,
        typeof editor[key] === "string" && editor[key].trim() !== "",
        JSON.stringify(editor[key]),
      );
    }
  }
  check("the editor header is 编辑目标 (zh-CN)", zh.editor.title === "编辑目标", JSON.stringify(zh.editor.title));
  check("the ✓ button is named 保存目标 (zh-CN)", zh.editor.save === "保存目标", JSON.stringify(zh.editor.save));
  equal(
    "key names are the keyboard's in both languages",
    [en.editor.escKey, en.editor.enterKey, en.editor.shiftEnterKey],
    [zh.editor.escKey, zh.editor.enterKey, zh.editor.shiftEnterKey],
  );
  equal(
    "the English editor words are not the Chinese ones",
    ["title", "save", "cancel", "escHint", "enterHint", "shiftEnterHint"].filter((key) => en.editor[key] === zh.editor[key]),
    [],
  );

  // The English column must not be a copy of the Chinese one.
  const copied = [
    "title",
    "running",
    "notRunning",
    "paused",
    "blocked",
    "disarmedHint",
    "clearHint",
    "currentTaskPrefix",
    "editPlaceholder",
    "runningA11y",
    "busy",
    "controlFailed",
    "unavailable",
    "noGoal",
  ].filter((key) => en[key] === zh[key]);
  equal("the English goal copy is not the Chinese copy", copied, []);

  // The one function-valued entry must return real text in both languages.
  for (const locale of LOCALES) {
    const rounds = allText()[locale].goal.rounds(3, 10);
    check(`goal.rounds is a non-empty string in ${locale}`, typeof rounds === "string" && rounds.trim() !== "", JSON.stringify(rounds));
    check(`goal.rounds carries the count in ${locale}`, rounds.includes("3") && rounds.includes("10"), JSON.stringify(rounds));
  }

  // **Goal-control refusals in Chinese (UI-v9).** Every sentence DSH's
  // `dsh-command-goal` or the plugin server can answer a control with, as it is
  // written there, must have a Chinese line; English shows the raw sentence.
  const USAGE = "Usage: /goal [<objective>|clear|edit <objective>|pause|resume]";
  const REFUSALS = [
    [`No goal is currently set; /goal edit requires one. ${USAGE}`, "当前没有目标，无法编辑。"],
    [`No goal is currently set; /goal pause requires one. ${USAGE}`, "当前没有目标，无法暂停。"],
    [`No goal is currently set; /goal resume requires one. ${USAGE}`, "当前没有目标，无法继续。"],
    [`No goal is currently set.\n${USAGE}`, "当前没有目标。"],
    [`Goal editing requires a replacement objective.\n${USAGE}`, "编辑目标需要填写新的目标内容。"],
    ["Goal editing requires a replacement objective.", "编辑目标需要填写新的目标内容。"],
    ["A goal is already active. Use /goal edit <objective> to change it or /goal clear before replacing it.", "已有一个进行中的目标。要修改它请编辑目标，要换新目标请先清除。"],
    ["A goal is already paused. Use /goal edit <objective> to change it or /goal clear before replacing it.", "已有一个已暂停的目标。要修改它请编辑目标，要换新目标请先清除。"],
    ["A goal is already blocked. Use /goal edit <objective> to change it or /goal clear before replacing it.", "已有一个受阻的目标。要修改它请编辑目标，要换新目标请先清除。"],
    ["The goal command is not valid for the current state. Run /goal to view available commands.", "目标当前的状态不允许这个操作（可发送 /goal 查看可用命令）。"],
    ["Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.", "附件只能随目标内容一起提交。"],
    ["No goal to clear.", "没有可清除的目标。"],
    ["Goal cleared.", "目标已清除。"],
    ["this session is closed; reopen it before controlling its goal", "会话已关闭，请重新打开会话后再操作目标。"],
    ["the goal command was rejected", "目标命令被拒绝。"],
    ["no DSH session is open for this agent; send it a message first, then control its goal", "这个 agent 还没有打开的 DSH 会话，请先给它发一条消息，再操作目标。"],
  ];
  for (const [raw, expected] of REFUSALS) {
    check(`zh translates ${JSON.stringify(raw.slice(0, 48))}`, zh.translateControlError(raw) === expected, JSON.stringify(zh.translateControlError(raw)));
    check(`en leaves ${JSON.stringify(raw.slice(0, 48))} as is`, en.translateControlError(raw) === undefined);
    const shown = goalControlErrorDisplay(raw, zh);
    check(`zh display keeps DSH's sentence for ${JSON.stringify(raw.slice(0, 32))}`, shown.message === expected && shown.original === raw.trim(), JSON.stringify(shown));
    const enShown = goalControlErrorDisplay(raw, en);
    check(`en display is the raw sentence for ${JSON.stringify(raw.slice(0, 32))}`, enShown.message === raw && enShown.original === undefined, JSON.stringify(enShown));
  }
  // **Unknown sentences fall through verbatim** — never a generic line
  // (FIELD-NOTES "silent degradation"). That includes a known shape with a
  // variable this table does not name (no half-translation).
  for (const raw of [
    "Goal store is read-only (EROFS).",
    `No goal is currently set; /goal frobnicate requires one. ${USAGE}`,
    "A goal is already sleeping. Use /goal edit <objective> to change it or /goal clear before replacing it.",
    "No goal to clear. Extra words DSH added later.",
    "",
  ]) {
    check(`zh leaves unknown ${JSON.stringify(raw.slice(0, 40))} untranslated`, zh.translateControlError(raw) === undefined, JSON.stringify(zh.translateControlError(raw)));
    const shown = goalControlErrorDisplay(raw, zh);
    check(`…and the display is the raw sentence`, shown.message === raw && shown.original === undefined, JSON.stringify(shown));
  }
  // **Drift from the installed DSH.** Every `text:` literal in
  // `dsh-command-goal/lib/index.js` that is an error (or the clear answer) must
  // be one this table knows. Located through the global npm root, overridable
  // with DSH_COMMAND_GOAL; when absent it is reported loudly, not passed.
  {
    let lib = process.env.DSH_COMMAND_GOAL;
    if (lib === undefined) {
      try {
        const root = require("node:child_process").execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
        lib = path.join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-command-goal", "lib", "index.js");
      } catch {
        lib = undefined;
      }
    }
    if (lib === undefined || !fs.existsSync(lib)) {
      console.log(`  NOTE dsh-command-goal not found (${String(lib)}); set DSH_COMMAND_GOAL to check refusal drift`);
    } else {
      const source = fs.readFileSync(lib, "utf8");
      const literals = [...source.matchAll(/kind: "error",\s*text: (`[^`]*`|"[^"]*")/g)].map((m) => m[1]);
      literals.push(...[...source.matchAll(/text: "(No goal to clear\.|Goal cleared\.)"/g)].map((m) => JSON.stringify(m[1])));
      check("dsh-command-goal's refusals are readable", literals.length >= 6, String(literals.length));
      for (const literal of literals) {
        // Instantiate the template: ${action} → each panel action, ${phaseLabel(...)} → each phase, ${USAGE} → USAGE.
        const body = literal.slice(1, -1).replace(/\\n/g, "\n");
        const variants = body.includes("${action}")
          ? ["edit", "pause", "resume"].map((a) => body.replace("${action}", a))
          : body.includes("${phaseLabel(current.phase)}")
            ? ["active", "paused", "blocked"].map((ph) => body.replace("${phaseLabel(current.phase)}", ph))
            : [body];
        for (const variant of variants) {
          const sentence = variant.replace("${USAGE}", USAGE);
          check(`DSH refusal ${JSON.stringify(sentence.slice(0, 48))} has a Chinese line`, typeof zh.translateControlError(sentence) === "string", sentence);
        }
      }
    }
  }

  // **`statuses` must cover exactly the phases `shared/goal.ts` declares.** Read
  // out of that file with a regex, not required: it imports zod and the plugin
  // package. A key missing here falls back to the wire name on screen.
  const sharedGoalPath =
    process.env.SHARED_GOAL ?? path.resolve(__dirname, "..", "..", "paseo-plugin", "shared", "goal.ts");
  check("shared/goal.ts is readable", fs.existsSync(sharedGoalPath), sharedGoalPath);
  const declaration = fs.existsSync(sharedGoalPath)
    ? /export const GOAL_PHASES = \[([^\]]*)\] as const;/.exec(fs.readFileSync(sharedGoalPath, "utf8"))
    : null;
  const phases =
    declaration === null ? undefined : [...declaration[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check(
    "GOAL_PHASES is readable out of shared/goal.ts",
    phases !== undefined && phases.length > 0,
    `no array literal in ${sharedGoalPath}`,
  );
  if (phases !== undefined) {
    // `statuses` is the facts word table: every phase plus the `disarmed` word,
    // which is not a phase but must be selectable for `active + disarmed`.
    equal("goal.statuses keys are GOAL_PHASES plus disarmed (en)", Object.keys(en.statuses).sort(), [...phases, "disarmed"].sort());
    equal("goal.statuses keys are GOAL_PHASES plus disarmed (zh-CN)", Object.keys(zh.statuses).sort(), [...phases, "disarmed"].sort());
    const sameStatuses = phases.filter((phase) => en.statuses[phase] === zh.statuses[phase]);
    equal("the English status words are not the Chinese ones", sameStatuses, []);
  }
}

console.log("the team pill, panel and cards (T3)");
{
  const en = allText().en.team;
  const zh = allText()["zh-CN"].team;
  // Every leaf string in both languages, and none copied across.
  const leaves = (table, prefix = "") =>
    Object.entries(table).flatMap(([key, value]) =>
      typeof value === "string" ? [[`${prefix}${key}`, value]] : typeof value === "object" && value !== null ? leaves(value, `${prefix}${key}.`) : [],
    );
  const enLeaves = Object.fromEntries(leaves(en));
  const zhLeaves = Object.fromEntries(leaves(zh));
  equal("team: both languages have the same string keys", Object.keys(enLeaves).sort(), Object.keys(zhLeaves).sort());
  for (const [key, value] of Object.entries(zhLeaves)) {
    check(`team.${key} is non-empty in both`, value.trim() !== "" && (enLeaves[key] ?? "").trim() !== "");
  }
  equal("team: English is not a copy of Chinese", Object.keys(zhLeaves).filter((key) => zhLeaves[key] === enLeaves[key]), []);
  equal("team: the title is the noun (zh)", zh.title, "团队");
  equal("team: the title is the noun (en)", en.title, "Team");
  // T5: the roster is one summary line; no per-member words remain.
  equal("team: member count (zh)", zh.memberCount(10), "10 名成员");
  equal("team: running count (zh)", zh.runningCount(2), "2 个运行中");
  equal("team: failed count (zh)", zh.failedCount(1), "1 个创建失败");
  equal("team: member count (en)", [en.memberCount(1), en.memberCount(10)], ["1 member", "10 members"]);
  equal("team: running / failed (en)", [en.runningCount(2), en.failedCount(1)], ["2 running", "1 failed to start"]);
  check("team: no member-row keys remain", !("memberStates" in zh) && !("memberActive" in zh) && !("members" in zh) && !("lead" in zh), Object.keys(zh).join(","));
  equal("team: stopped tag (zh/en)", [zh.ownerStopped, en.ownerStopped], ["已停止", "Stopped"]);
  equal("team: stopped owners note (zh)", zh.stoppedOwners(10), "10 个负责人已停止");
  for (const key of ["memberCount", "runningCount", "failedCount", "stoppedOwners"]) {
    check(`team.${key}: English is not the Chinese`, en[key](3) !== zh[key](3));
  }
  equal("team: the group words", zh.marks, { doing: "进行中", ready: "可开始", blocked: "等待依赖", done: "已完成" });
  equal("team: blockers sentence (zh)", zh.blockedBy(["task-1", "task-2"].join(zh.listSeparator)), "等 task-1、task-2");
  equal("team: failure keeps DSH's sentence (zh)", zh.failure("x is invalid"), "团队记录无效：x is invalid");
  for (const key of Object.keys(zh.card.actions)) check(`team.card.actions.${key} has an English word`, typeof en.card.actions[key] === "string");
  equal("team: the action keys are DSH's eight", Object.keys(zh.card.actions).sort(), ["claim", "complete", "delete", "edit", "reassign", "release", "reopen", "set_dependencies"]);

  // Refusals: DSH's sentences, translated in zh, untouched in en, unknown verbatim.
  const REFUSALS = [
    ['team task "task-3" not found', "找不到团队任务 task-3。"],
    ['Error: team task "task-3" not found', "找不到团队任务 task-3。"],
    ['stale team task "task-2" revision 1; current revision is 3', "任务 task-2 已被改动（预期修订 1，当前 3），请重新读取后再试。"],
    ['team task "task-2" is owned by another member', "任务 task-2 已由其他成员认领。"],
    ['team task "task-2" is not ready to claim', "任务 task-2 的依赖未完成，还不能认领。"],
    ['team task "task-1" still blocks "task-2"', "任务 task-1 仍被 task-2 依赖，不能删除。"],
    ["task mutation requires its owner or Team Lead", "只有任务负责人或队长能改这个任务。"],
    ["only an in-progress task can complete", "只有进行中的任务能标记完成。"],
    ['Error: invalid workspace-relative write scope "../x"', '写入范围不是工作区内的相对路径："../x"'],
    ["subject must be non-empty", "subject 不能为空。"],
    ['teammate name "fixer" was already used in this Team', "队员名 fixer 在本团队已用过。"],
    ["limit must be an integer from 1 through 100", "limit 必须是 1 到 100 的整数。"],
  ];
  for (const [raw, expected] of REFUSALS) {
    equal(`zh translates ${JSON.stringify(raw.slice(0, 40))}`, zh.translateToolError(raw), expected);
    equal(`en leaves ${JSON.stringify(raw.slice(0, 40))}`, en.translateToolError(raw), undefined);
    const shown = teamToolErrorDisplay(raw, zh);
    check(`zh display keeps DSH's words for ${JSON.stringify(raw.slice(0, 30))}`, shown.message === expected && shown.original === raw.trim(), JSON.stringify(shown));
  }
  for (const raw of ["Error: something DSH says later", 'team task "task-1" not found, and more', ""]) {
    equal(`zh leaves unknown ${JSON.stringify(raw.slice(0, 30))}`, zh.translateToolError(raw), undefined);
    const shown = teamToolErrorDisplay(raw, zh);
    check(`…displayed verbatim`, shown.message === raw && shown.original === undefined, JSON.stringify(shown));
  }
  equal("zh overlap warning", zh.translateWarning("write scopes overlap with task-4"), "写入范围与 task-4 重叠");
  equal("en overlap warning untouched", en.translateWarning("write scopes overlap with task-4"), undefined);
  equal("unknown warning untouched", zh.translateWarning("write scopes overlap"), undefined);

  // Drift: every literal TeamError sentence in the installed agent-team package
  // must have a Chinese line (variables instantiated). NOTE when absent.
  let lib = process.env.DSH_AGENT_TEAM;
  if (lib === undefined) {
    try {
      const root = require("node:child_process").execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
      lib = path.join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-experimental-agent-team", "lib", "index.js");
    } catch {
      lib = undefined;
    }
  }
  if (lib === undefined || !fs.existsSync(lib)) {
    console.log(`  NOTE dsh-experimental-agent-team not found (${String(lib)}); set DSH_AGENT_TEAM to check refusal drift`);
  } else {
    const source = fs.readFileSync(lib, "utf8");
    // The model-facing refusals: TeamError / TeamTaskGraphError with a code.
    const literals = [...source.matchAll(/new Team(?:TaskGraph)?Error\((`[^`]*`|"(?:[^"\\]|\\.)*")/g)].map((m) => m[1]);
    check("agent-team refusals are readable", literals.length >= 20, String(literals.length));
    const sample = { id: "task-7", "request.taskId": "task-7", "current.id": "task-7", "task.id": "task-7", blockerId: "task-1", "dependent.id": "task-8",
      "request.expectedRevision": "1", "current.revision": "2", "this.maxTasks": "100", "this.maxMembers": "16", "this.disposalTimeoutMs": "5000", name: "fixer", field: "subject",
      maxLength: "200", "agent.id": "s-1", "JSON.stringify(value)": '"../x"', toolName: "team_task_get" };
    const skip = /timeoutMs|wait_agent|teammate creation aborted|unsupported task action|positive safe integer|exceeds \$\{this\.config|message itself|interrupt|provisioned teammate|teammate "\$\{/;
    for (const literal of literals) {
      const body = JSON.parse(literal.startsWith("`") ? JSON.stringify(literal.slice(1, -1)) : literal);
      if (skip.test(body)) continue;
      const sentence = body.replace(/\$\{([^}]+)\}/g, (_, expr) => sample[expr.trim()] ?? "x");
      check(`agent-team refusal ${JSON.stringify(sentence.slice(0, 50))} has a Chinese line`, typeof zh.translateToolError(sentence) === "string", sentence);
    }
  }
}

console.log("every tool that draws an icon can also name itself");
{
  // An icon with no label renders the row as `FileOutput  cordis_define` — the
  // wire name, which is the silent downgrade the label tables exist to prevent.
  // The icon table was not enumerable from here until `TOOL_ICON_NAMES` was
  // exported, so `cordis_define` and `present` sat label-less and no check saw
  // it; `tool-call-check.cjs` only asserted their glyphs.
  const en = allText().en.toolLabels;
  const zh = allText()["zh-CN"].toolLabels;
  const missing = TOOL_ICON_NAMES.filter((name) => en[name] === undefined || zh[name] === undefined).map(
    (name) => `${name} (${en[name] === undefined ? "en" : ""}${zh[name] === undefined ? "zh" : ""})`,
  );
  equal("every tool with an icon has a label in both languages", missing, []);
}

console.log("the tools this machine has really been offered are never anonymous");
{
  // Provenance (2026-10-20): every `request/header` in this machine's own
  // `~/.dsh/sessions/**/session.v4.jsonl.zstd` (multi-frame zstd) — 855 headers
  // over 655 files — carried 161 distinct tool names, and the `tool/call` events
  // in the same logs carried 96 (a subset, plus one model-invented name handled
  // below). That catalog is the "possible set": the model can only call what its
  // header lists. The list is checked in because this harness must stay offline
  // and machine-independent; `docs/research/table-labels.md` records the scan
  // commands, the before/after gap list and how to refresh this snapshot.
  //
  // Both halves of the failure are invisible in a green run: a name with no label
  // renders as its wire name, and one with no glyph draws the wrench. A phone
  // screenshot showing `memory_search · {"query":…}` next to a wrench is why this
  // check exists.
  const MOUNTED_TOOLS = [
    "archive_subagents", "ask_user_question", "bash", "conversation_search",
    "create_goal", "edit", "exit_plan_mode", "get_goal",
    "glob", "grep", "interrupt_agent", "job_kill",
    "job_list", "job_output", "list_agents", "list_mcp_resource_templates",
    "list_mcp_resources", "mcp__paseo__archive_agent", "mcp__paseo__archive_workspace", "mcp__paseo__browser_back",
    "mcp__paseo__browser_click", "mcp__paseo__browser_close_tab", "mcp__paseo__browser_drag", "mcp__paseo__browser_evaluate",
    "mcp__paseo__browser_fill", "mcp__paseo__browser_forward", "mcp__paseo__browser_hover", "mcp__paseo__browser_keypress",
    "mcp__paseo__browser_list_tabs", "mcp__paseo__browser_logs", "mcp__paseo__browser_navigate", "mcp__paseo__browser_new_tab",
    "mcp__paseo__browser_reload", "mcp__paseo__browser_resize", "mcp__paseo__browser_screenshot", "mcp__paseo__browser_scroll",
    "mcp__paseo__browser_select", "mcp__paseo__browser_snapshot", "mcp__paseo__browser_type", "mcp__paseo__browser_upload",
    "mcp__paseo__browser_wait", "mcp__paseo__cancel_agent", "mcp__paseo__capture_terminal", "mcp__paseo__create_agent",
    "mcp__paseo__create_heartbeat", "mcp__paseo__create_schedule", "mcp__paseo__create_terminal", "mcp__paseo__create_workspace",
    "mcp__paseo__delete_heartbeat", "mcp__paseo__delete_schedule", "mcp__paseo__get_agent_activity", "mcp__paseo__get_agent_status",
    "mcp__paseo__inspect_provider", "mcp__paseo__inspect_schedule", "mcp__paseo__kill_agent", "mcp__paseo__kill_terminal",
    "mcp__paseo__list_agents", "mcp__paseo__list_models", "mcp__paseo__list_pending_permissions", "mcp__paseo__list_profiles",
    "mcp__paseo__list_providers", "mcp__paseo__list_schedules", "mcp__paseo__list_terminals", "mcp__paseo__list_workspace_scripts",
    "mcp__paseo__list_workspaces", "mcp__paseo__pause_schedule", "mcp__paseo__rename_workspace", "mcp__paseo__respond_to_permission",
    "mcp__paseo__resume_schedule", "mcp__paseo__run_schedule_once", "mcp__paseo__schedule_logs", "mcp__paseo__send_agent_prompt",
    "mcp__paseo__send_terminal_keys", "mcp__paseo__set_agent_mode", "mcp__paseo__start_workspace_script", "mcp__paseo__stop_workspace_script",
    "mcp__paseo__update_agent", "mcp__paseo__update_schedule", "mcp_call_tool", "mcp_list_tools",
    "mcp_tool_schema", "memory_add", "memory_conflicts", "memory_conflicts_rejected",
    "memory_delete", "memory_expand_graph_node", "memory_import", "memory_read_scene",
    "memory_receipts", "memory_resolve_conflict", "memory_room_admin", "memory_room_review",
    "memory_ruminate", "memory_ruminate_cancel", "memory_ruminate_status", "memory_search",
    "memory_search_graph", "memory_slot_close", "memory_slot_list", "memory_slot_write",
    "present", "read", "read_image", "read_mcp_resource",
    "schedule_create", "schedule_delete", "schedule_list", "schedule_update",
    "send_message", "session_event_read", "session_event_search", "session_event_trace",
    "session_search", "session_trace", "skill", "spawn_teammate",
    "subagent", "subagent_fork", "team_task_create", "team_task_get",
    "team_task_list", "team_task_update", "terminal_close", "terminal_list",
    "terminal_open", "terminal_read", "terminal_send", "terminal_signal",
    "todo_write", "update_goal", "wait_agent", "web_fetch",
    "web_search", "workflow", "working_directory", "write",
  ];

  // Another plugin's MCP server (`mcp__server_browser__*`, the Server Browser
  // plugin's browser tools). This repo's documented behaviour for a foreign
  // server is the wire name — the plugin cannot know that server's catalog, and
  // `tool-call-check.cjs` pins the same rule for `mcp__github__create_issue`. The
  // exclusion is asserted below, not skipped, so it stays visible.
  const FOREIGN_SERVER_TOOLS = [
    "mcp__server_browser__browser_click", "mcp__server_browser__browser_console_messages", "mcp__server_browser__browser_diagnostics",
    "mcp__server_browser__browser_drag", "mcp__server_browser__browser_drop", "mcp__server_browser__browser_emulate_media",
    "mcp__server_browser__browser_evaluate", "mcp__server_browser__browser_file_upload", "mcp__server_browser__browser_fill_form",
    "mcp__server_browser__browser_find", "mcp__server_browser__browser_handle_dialog", "mcp__server_browser__browser_hover",
    "mcp__server_browser__browser_navigate", "mcp__server_browser__browser_navigate_back", "mcp__server_browser__browser_network_request",
    "mcp__server_browser__browser_network_requests", "mcp__server_browser__browser_press_key", "mcp__server_browser__browser_read_page",
    "mcp__server_browser__browser_resize", "mcp__server_browser__browser_select_option", "mcp__server_browser__browser_snapshot",
    "mcp__server_browser__browser_tabs", "mcp__server_browser__browser_take_screenshot", "mcp__server_browser__browser_type",
    "mcp__server_browser__browser_wait_for",
  ];

  // A model-invented name: DSH logged one `mcp__paseo__mcp_list_tools` call whose
  // result was `ToolNotFoundError: unknown tool` (session
  // `b9a2b365-e63e-4b88-afe2-c25cacabe5fe`, seq 4560/4561); the header's real
  // name was the gateway's `mcp_list_tools`. Mapping it would dress up a call
  // that never existed, so it keeps the wire name like any other unknown tool.
  const FABRICATED = "mcp__paseo__mcp_list_tools";

  // The detail type `server/timeline.ts`'s `toolDetail()` sends for each name;
  // everything else arrives as `unknown`. The glyph a row draws depends on this
  // shape, so the icon check has to use the same one the daemon sends.
  const TYPED_DETAILS = {
    bash: "shell",
    pwsh: "shell",
    read: "read",
    write: "write",
    edit: "edit",
    grep: "search",
    glob: "search",
    web_search: "search",
    web_fetch: "fetch",
    exit_plan_mode: "plan",
    subagent: "sub_agent",
  };
  const detailFor = (name) =>
    name === "todo_write" || name === "ask_user_question"
      ? { type: "plain_text", icon: "sparkles" }
      : TYPED_DETAILS[name] !== undefined
        ? { type: TYPED_DETAILS[name] }
        : { type: "unknown", input: {}, output: null };

  check(
    "the mounted-tool snapshot is the full scan",
    MOUNTED_TOOLS.length === 136 && FOREIGN_SERVER_TOOLS.length === 25,
    `${MOUNTED_TOOLS.length} mounted / ${FOREIGN_SERVER_TOOLS.length} foreign`,
  );

  const previous = currentLocale();
  const labelMissing = [];
  const iconMissing = [];
  const untranslated = [];
  for (const name of MOUNTED_TOOLS) {
    const labels = {};
    for (const locale of LOCALES) {
      setLocale(locale);
      labels[locale] = toolLabel(name);
      if (labels[locale] === name || labels[locale].trim() === "") {
        labelMissing.push(`${name} (${locale})`);
      }
    }
    if (labels.en === labels["zh-CN"]) untranslated.push(name);
    setLocale("zh-CN");
    const icon = toolIcon(name, detailFor(name));
    if (icon === "Wrench" || icon === "") iconMissing.push(`${name}: ${icon}`);
  }
  setLocale(previous);
  equal("every mounted tool has a label in both languages", labelMissing, []);
  equal("every mounted tool draws its own glyph (none falls to the wrench)", iconMissing, []);
  equal("no mounted tool's English label is a copy of its Chinese one", untranslated, []);

  // The memory family is the set that was missing entirely. Its glyphs must not
  // repeat inside the family (19 tools, 19 distinct glyphs), which is the part a
  // bulk "give them all a Brain" would silently get wrong.
  const memoryTools = MOUNTED_TOOLS.filter((name) => name.startsWith("memory_"));
  equal("the memory family is the plugin's 19 mounted tools", memoryTools.length, 19);
  setLocale("zh-CN");
  const memoryIcons = memoryTools.map((name) => toolIcon(name, { type: "unknown" }));
  equal(
    "the memory family's glyphs are pairwise distinct",
    [...new Set(memoryIcons)].length,
    memoryIcons.length,
  );

  // Foreign servers and invented names keep the wire name: the documented
  // fallback, asserted here so a future "helpful" mapping has to change this
  // test on purpose.
  const foreignMapped = FOREIGN_SERVER_TOOLS.filter((name) => {
    setLocale("zh-CN");
    const zh = toolLabel(name);
    setLocale("en");
    return zh !== name || toolLabel(name) !== name;
  });
  equal("another MCP server's tools keep their wire name", foreignMapped, []);
  setLocale("zh-CN");
  equal("a model-invented tool name is not dressed up", toolLabel(FABRICATED), FABRICATED);
  equal("and it keeps the neutral glyph", toolIcon(FABRICATED, { type: "unknown" }), "Wrench");
  setLocale(previous);
}

console.log("the Paseo tool table matches the official catalog (0.12)");
{
  // `@getpaseo/protocol` is ESM; Node >= 20.19 can `require` it from this CJS
  // harness. A missing module is a failed assertion, not a crash — the checks
  // below simply cannot run without it, which is exactly the state to report.
  let catalog;
  try {
    catalog = require("@getpaseo/protocol/paseo-tool-presentation/catalog").PASEO_TOOL_CATALOG;
  } catch (error) {
    console.log(`  (could not load the official catalog: ${error.message})`);
  }
  check(
    "the official catalog is loadable",
    catalog !== undefined && Object.keys(catalog).length > 0,
    catalog === undefined ? "require failed" : `${Object.keys(catalog).length} tools`,
  );

  if (catalog !== undefined) {
    const officialNames = Object.keys(catalog);
    const en = allText().en.paseoMcpLabels;
    const zh = allText()["zh-CN"].paseoMcpLabels;

    const missing = officialNames.filter(
      (name) => typeof en[name] !== "string" || typeof zh[name] !== "string",
    );
    equal("every official tool has a label in both languages", missing, []);

    // The English column is not a translation target: it is the catalog itself.
    const drifted = officialNames
      .filter((name) => en[name] !== catalog[name].label)
      .map((name) => `${name}: ${JSON.stringify(en[name])} != ${JSON.stringify(catalog[name].label)}`);
    equal("the English column is the official label, verbatim", drifted, []);

    const copied = officialNames.filter((name) => zh[name] === en[name]);
    equal("no Chinese label is a copy of the English one", copied, []);

    // Paseo's own `isPaseoToolName` exempts `speak`; the plugin's table follows
    // that, so it is the one entry allowed beyond the catalog.
    const extra = Object.keys(en)
      .filter((name) => catalog[name] === undefined)
      .sort();
    equal("speak is the only tool beyond the official catalog", extra, ["speak"]);

    // Every official tool must resolve to a glyph of its own: `Wrench` is the
    // fallback, and a row that draws it is the silent gap this file exists for.
    const iconless = [...officialNames, "speak"].filter(
      (name) => toolIcon(`mcp__paseo__${name}`, { type: "unknown" }) === "Wrench",
    );
    equal("every Paseo tool draws its own glyph (none falls to the wrench)", iconless, []);

    // The four tools 0.12 gave an action glyph instead of the family's page one.
    // `tool-call-check.cjs` pins the same four; this keeps the *coverage* claim
    // above honest for the ones that used to be missing entirely.
    const actionGlyphs = {
      browser_back: "ArrowLeft",
      browser_forward: "ArrowRight",
      browser_hover: "MousePointer",
      browser_reload: "RotateCw",
    };
    const wrongGlyph = Object.entries(actionGlyphs)
      .filter(([name, glyph]) => toolIcon(`mcp__paseo__${name}`, { type: "unknown" }) !== glyph)
      .map(([name, glyph]) => `${name}: ${toolIcon(`mcp__paseo__${name}`, { type: "unknown" })} != ${glyph}`);
    equal("the four browser action tools draw their own glyph", wrongGlyph, []);
  }
}

console.log("the agent-message headings are complete in both languages");
{
  // The row head is `event · sender`; the five event headings come from the
  // protocol's own `buildAgentMessageDisplay`, and `agent-message-check.cjs`
  // compares the English ones against that model. What is checked here is the
  // table's own shape: the protocol's five keys, a value in both languages, and
  // a real translation rather than a copied column.
  const en = allText().en.agentMessageEvents;
  const zh = allText()["zh-CN"].agentMessageEvents;
  equal(
    "the table's keys are the protocol's five events",
    Object.keys(en).sort(),
    [...AGENT_MESSAGE_EVENTS].sort(),
  );
  for (const event of AGENT_MESSAGE_EVENTS) {
    check(
      `${event} is labelled in both languages`,
      typeof en[event] === "string" &&
        en[event].trim() !== "" &&
        typeof zh[event] === "string" &&
        zh[event].trim() !== "",
      JSON.stringify([en[event], zh[event]]),
    );
    check(`${event} is translated, not copied`, en[event] !== zh[event], JSON.stringify(en[event]));
  }
  const fallbackEn = allText().en.agentMessageFallback;
  const fallbackZh = allText()["zh-CN"].agentMessageFallback;
  check(
    "an unknown event has a generic heading in both languages",
    fallbackEn.trim() !== "" && fallbackZh.trim() !== "" && fallbackEn !== fallbackZh,
    JSON.stringify([fallbackEn, fallbackZh]),
  );
  check(
    "the generic heading is not one of the five event labels",
    !AGENT_MESSAGE_EVENTS.some((event) => en[event] === fallbackEn || zh[event] === fallbackZh),
    fallbackEn,
  );
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

console.log("the goal-round row is named in both languages");
{
  // The row the plugin draws for one automatic goal round is not a DSH tool: the
  // name comes from `server/activity-timeline.ts` and is not in any DSH title
  // table, so without a label it would render as the wire name `goal_round` next
  // to a generic glyph. Only the label half lives here — the round half is the
  // server's copy table (`server/locale.ts`, `UI.goalRound`), relayed on the item
  // and asserted by `p003-timeline-check.cjs` / `goal-timeline-check.cjs`.
  setLocale("zh-CN");
  equal("goal round (zh)", toolLabel("goal_round"), "目标续跑");
  setLocale("en");
  equal("goal round (en)", toolLabel("goal_round"), "Goal round");
  // The row carries no `plain_text` icon key, so the glyph comes from the tool
  // name table — the same Target as the goal tools and the goal pill. (The
  // rendered row is pinned end to end by `harness/tool-call-check.cjs`.)
  equal(
    "goal round borrows the goal tools' Target glyph",
    toolIcon("goal_round", { type: "plain_text" }),
    "Target",
  );
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
  // A plan row's title *is* its label: `planTitle` and the `exit_plan_mode` tool
  // label are the same string in both tables, so the summary dedup
  // (`rawSummary === label ? "" : rawSummary`) drops it and the head reads
  // 「计划」once instead of「计划 · 计划」. The title still leads the expanded
  // card; `tool-call-check.cjs` asserts that half against the source.
  equal("a plan row leads with the Chinese title on its label", toolCallData(plan, "complete").label, "计划");
  equal("and its summary does not repeat it", toolCallData(plan, "complete").summary, "");
  equal("a Paseo MCP row is labelled in Chinese", toolCallData(mcp, "complete").label, "删除心跳");

  setLocale("en");
  equal("the same row is labelled in English once the locale is relayed", toolCallData(shell, "complete").label, "Bash");
  equal("and so is the block caption", toolCallData(shell, "complete").bodyLabel, "Output");
  equal("the plan row follows", toolCallData(plan, "complete").label, "Plan");
  equal("with no repeated summary", toolCallData(plan, "complete").summary, "");
  equal("the Paseo MCP row follows", toolCallData(mcp, "complete").label, "Delete heartbeat");

  // A body that is still capped: terminal (`shell`) and generic code-surface
  // bodies are deliberately not capped any more — both cards scroll and copy the
  // whole thing (CT-02/CT-01) — so the marker's locale is asserted on the legacy
  // plain-text diff fallback, the one body that keeps the cap. This case is
  // about the marker's locale, not about which kinds cap.
  const huge = { name: "write", status: "completed", detail: { type: "write", filePath: "/x.ts", content: "y".repeat(7000) } };
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

  // The literal placeholder a tool row carries when the wire never named its
  // tool. The server stopped inventing those rows (`server/timeline.ts`), so this
  // is the readable fallback for a row from an older build: a label and Paseo's
  // neutral glyph instead of the bare `tool` next to a wrench.
  setLocale("zh-CN");
  equal("the unnamed-tool placeholder is readable", toolLabel(UNNAMED_TOOL), "工具调用");
  equal("and gets the neutral glyph", toolIcon(UNNAMED_TOOL, undefined), "Wrench");
  setLocale("en");
  equal("in English too", toolLabel(UNNAMED_TOOL), "Tool call");
  equal("with the same neutral glyph", toolIcon(UNNAMED_TOOL, { type: "unknown" }), "Wrench");
  setLocale(undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
