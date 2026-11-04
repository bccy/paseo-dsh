/**
 * Offline behaviour check for the team panel's rendered DOM (T3, direction B).
 *
 * Renders the **real** `TeamPanel` (and the real container `makeTeamPopover`)
 * through `react-native-web` into jsdom, with the same UI-kit stub as
 * `goal-popover-render-check.cjs` (real lucide glyphs, inline SVG). Asserts:
 * the section order (failure → roster summary → tasks), the B groups and their
 * order, the done group folded by default and opening in place, a blocked task
 * never under 可开始, **no member rows** (T5), the roster headline (T7: whale +
 * 「DeepSeek」 + 「N 名成员」 (teammates only, none → no count) + status chips — 运行中/已停止 only from `running`,
 * no chip for a zero count, failed red, chips not pill-shaped), the
 * owner's mark (the ring after a running owner, a grey 已停止 tag after an
 * owner the server saw stop, nothing when running is unknown; list and detail
 * page) and the 进行中 header's 「N 个负责人已停止」, the description clamped to two lines in the list,
 * the detail page (back row, every field, the whole description, back returns),
 * the empty board and Lead-only states, and that the panel is read-only (the
 * only buttons are task rows, the done fold and the back row).
 *
 * Run: HOST_APP=/path/to/paseo node harness/team-popover-render-check.cjs
 * Without HOST_APP it exits 2 (incomplete), like the goal/jobs render checks.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const here = __dirname;
const repoRoot = path.resolve(here, "..");
const pluginRoot = path.join(repoRoot, "paseo-plugin");
const hostApp = process.env.HOST_APP;
if (hostApp === undefined || hostApp.trim() === "") {
  console.error("INCOMPLETE: HOST_APP is not set.");
  console.error("Set it to the Paseo app checkout that provides the host node_modules, e.g.:");
  console.error("  HOST_APP=/path/to/paseo node harness/team-popover-render-check.cjs");
  process.exit(2);
}
const hostModules = path.join(hostApp, "node_modules");
const work = path.join(repoRoot, "paseo-plugin", ".dbg-team-render");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// The host's own icon seam, reproduced: `name` is a Lucide glyph (the host does
// `createElement(LucideIcons[name], { size, color })`), `{ svg }` is an inline
// SVG document sized to `size` (the host's `SvgIcon`). The stub exists only
// because the host's React Native SVG renderer cannot run in jsdom; the glyphs
// themselves are the real Lucide ones.
const stub = path.join(work, "ui-stub.tsx");
const stubSource = [
  'import { createElement } from "react";',
  'import { TextInput } from "react-native";',
  'import * as Lucide from "lucide-react";',
  'import type { ComponentType } from "react";',
  'export { TextInput };',
  'type IconProps = {',
  '  name?: string;',
  '  icon?: { svg: string } | ComponentType<{ size?: number; color?: string }>;',
  '  size?: number;',
  '  color?: string;',
  '};',
  'export function Icon({ name, icon, size = 24, color = "currentColor" }: IconProps) {',
  '  if (icon !== undefined && typeof icon === "object" && icon !== null && "svg" in icon) {',
  '    const svg = icon.svg.replace("<svg ", `<svg width="${size}" height="${size}" `);',
  '    return createElement("span", {',
  '      "data-icon": "svg",',
  '      style: { display: "inline-flex", width: size, height: size, color },',
  '      dangerouslySetInnerHTML: { __html: svg },',
  '    });',
  '  }',
  '  if (typeof name === "string") {',
  '    const glyph = (Lucide as unknown as Record<string, unknown>)[name] as',
  '      | ComponentType<{ size?: number; color?: string }>',
  '      | undefined;',
  '    if (glyph !== undefined) {',
  '      return createElement(',
  '        "span",',
  '        { "data-icon": name, style: { display: "inline-flex", color } },',
  '        createElement(glyph, { size, color }),',
  '      );',
  '    }',
  '  }',
  '  return createElement("span", { "data-icon": "missing", style: { display: "inline-flex", width: size, height: size } });',
  '}',
  '',
].join("\n");
fs.writeFileSync(stub, stubSource);

// The container (`makeGoalPopover`) reads the agent's status through the plugin
// SDK's `useAgent`, a host hook; this stand-in answers "idle", which is all the
// panel's close/stay behaviour needs.
const clientStub = path.join(work, "client-stub.ts");
fs.writeFileSync(clientStub, "export function useAgent() { return \"idle\"; }\n");

const entry = path.join(work, "entry.tsx");
fs.writeFileSync(
  entry,
  `export { TeamPanel, TeamPanelNote } from ${JSON.stringify(path.join(pluginRoot, "client/team-popover.tsx"))};
export { makeTeamPopover } from ${JSON.stringify(path.join(pluginRoot, "client/team-pill.tsx"))};
export { allText } from ${JSON.stringify(path.join(pluginRoot, "client/locale.ts"))};
export { createRoot } from "react-dom/client";
export { createElement } from "react";
export { flushSync } from "react-dom";
`,
);

const esbuild = require(path.join(hostModules, "esbuild"));
esbuild.buildSync({
  entryPoints: [entry],
  outfile: path.join(work, "bundle.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  nodePaths: [hostModules],
  // One React only: `paseo-plugin/node_modules` carries its own react (19.1.9)
  // for the plugin build, while the host app has 19.2.3. Letting the component
  // resolve its own copy would give hooks a null dispatcher, so every react
  // entry is pinned to the host's copy.
  alias: {
    react: path.join(hostModules, "react"),
    "react/jsx-runtime": path.join(hostModules, "react/jsx-runtime.js"),
    "react/jsx-dev-runtime": path.join(hostModules, "react/jsx-dev-runtime.js"),
    "react-dom": path.join(hostModules, "react-dom"),
    "react-dom/client": path.join(hostModules, "react-dom/client.js"),
    "react-native": "react-native-web",
    "@getpaseo/plugin/client/ui": stub,
    "@getpaseo/plugin/client": clientStub,
  },
  loader: { ".tsx": "tsx", ".ts": "ts" },
  logLevel: "warning",
});

const { JSDOM } = require(path.join(hostModules, "jsdom"));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
// Node 22 exposes `navigator` as a getter-only global; define it over the DOM one.
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;
// react-native-web touches browser globals at require time (StyleSheet's
// ShadowRoot check); expose the jsdom implementations on `global`.
for (const name of ["ShadowRoot", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle"]) {
  if (dom.window[name] !== undefined) global[name] = dom.window[name];
}

const bundled = require(path.join(work, "bundle.cjs"));
const { TeamPanel, TeamPanelNote, makeTeamPopover, allText, createRoot, createElement, flushSync } = bundled;
const React = { createElement };
const text = allText()["zh-CN"].team;
const theme = {
  colors: {
    surface0: "#ffffff", surface1: "#fafafa", surface2: "#f4f4f5", border: "#e4e4e7",
    foreground: "#1a1a1e", foregroundMuted: "#71717a", accent: "#20744A", accentForeground: "#ffffff",
    statusSuccess: "#3e704a", statusWarning: "#7b5d39", statusDanger: "#9d433b",
  },
};

let failures = 0;
let checks = 0;
function check(what, actual, expected) {
  checks += 1;
  if (Object.is(actual, expected)) return;
  failures += 1;
  console.error(`  FAIL ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assert(what, condition, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  FAIL ${what}${detail === undefined ? "" : `: ${detail}`}`);
}

const LEAD = { id: "root", name: "lead", role: "lead", phase: "active", running: false };
const mate = (over) => ({ role: "teammate", phase: "active", ...over });
const task = (over) => ({ revision: 1, description: "", blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [], status: "pending", ...over });
const LONG = "第一段：只读审查实现。\n第二段：逐条给结论与 file:line。\n第三段：变异抽查。\n第四段：交付报告写到编排目录。";
const BOARD = {
  members: [
    LEAD,
    mate({ id: "i", name: "reviewer", running: false, description: "只读审查" }),
    mate({ id: "u", name: "elsewhere", description: "别处的队员" }),
    mate({ id: "r", name: "fixer", running: true, description: "修复并验证" }),
  ],
  tasks: [
    task({ id: "task-1", subject: "修复选页错位", status: "completed", ownerName: "fixer" }),
    task({ id: "task-2", subject: "独立审查修复", status: "in_progress", ownerName: "reviewer", description: LONG, writeScopes: ["docs/audits/"] }),
    task({ id: "task-3", subject: "复审返工", status: "pending", ready: false, blockedBy: ["task-2"] }),
    task({ id: "task-4", subject: "整理证据", status: "pending", ready: true, writeScopes: ["docs/a/", "docs/b/"], writeScopeWarnings: ["write scopes overlap with task-2"] }),
    task({ id: "task-5", subject: "返工补丁", status: "in_progress", ownerName: "fixer", writeScopes: ["src/"] }),
  ],
};
const RING = '[role="progressbar"]';

function render(props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(React.createElement(TeamPanel, { text, theme, compact: false, ...props })));
  return { container, root };
}
function click(node) {
  flushSync(() => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })));
}
const byLabel = (container, label) => [...container.querySelectorAll("[aria-label]")].find((node) => node.getAttribute("aria-label") === label);
const byLabelStart = (container, prefix) => [...container.querySelectorAll("[aria-label]")].find((node) => (node.getAttribute("aria-label") ?? "").startsWith(prefix));
const texts = (container) => [...container.querySelectorAll('[dir="auto"]')].map((node) => (node.textContent ?? "").trim()).filter((t) => t !== "");
const order = (container, words) => {
  const all = container.textContent;
  return words.map((word) => all.indexOf(word));
};

console.log("sections and direction-B groups");
{
  const { container } = render({ team: BOARD });
  const positions = order(container, ["3 名成员", "进行中", "独立审查修复", "可开始", "整理证据", "等待依赖", "复审返工", "已完成"]);
  assert("the summary, then 进行中 → 可开始 → 等待依赖 → 已完成", positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), JSON.stringify(positions));
  assert("the done group is folded by default", !container.textContent.includes("修复选页错位"), container.textContent);
  const ready = container.textContent.slice(container.textContent.indexOf("可开始"), container.textContent.indexOf("等待依赖"));
  assert("a blocked task is not under 可开始", !ready.includes("复审返工"), ready);
  const fold = byLabel(container, "已完成, 1");
  assert("the done fold is a button with its count", fold?.getAttribute("role") === "button", fold?.outerHTML);
  check("…collapsed", fold?.getAttribute("aria-expanded"), "false");
  click(fold);
  assert("opening it shows the done task in place", container.textContent.includes("修复选页错位"));
  check("…and says so", byLabel(container, "已完成, 1")?.getAttribute("aria-expanded"), "true");
  assert("the old 共享任务 header is not drawn in B", !container.textContent.includes("共享任务"));
}

const headline = (c) => [...c.querySelectorAll('[role="heading"]')].find((n) => (n.getAttribute("aria-label") ?? "").startsWith("DeepSeek"));
const chip = (c, key) => headline(c)?.querySelector(`[data-testid="team-head-chips"] [data-testid="team-chip-${key}"]`) ?? null;
const chipKeys = (c) => [...(headline(c)?.querySelectorAll('[data-testid="team-head-chips"] [data-testid^="team-chip-"]') ?? [])].map((n) => n.getAttribute("data-testid").slice(10));

console.log("\nthe roster headline (T7): DeepSeek + N 名成员 + status chips");
{
  const { container } = render({ team: BOARD });
  const head = headline(container);
  check("the headline names DeepSeek, the count and its chips", head?.getAttribute("aria-label"), "DeepSeek，3 名成员，1 运行中，1 已停止，1/5 任务完成");
  check("…as a header", head?.getAttribute("role"), "heading");
  assert("…and is not pressable", head?.closest('[role="button"]') === null && head?.querySelector('[role="button"]') === null);
  check("…with the whale", head?.querySelectorAll('[data-icon="svg"]').length, 1);
  assert("…and the title is DeepSeek, not 团队", [...head.querySelectorAll('[dir="auto"]')].some((n) => n.textContent === "DeepSeek") && !head.textContent.includes("团队"));
  check("the chips, in order", JSON.stringify(chipKeys(container)), JSON.stringify(["running", "stopped", "done"]));
  assert("the running chip carries the host ring", chip(container, "running")?.querySelector("div div") !== null && chip(container, "running")?.textContent === "1 运行中");
  assert("the done chip carries the host check", chip(container, "done")?.querySelector('[data-icon="CircleCheck"]') !== null && chip(container, "done")?.textContent === "1/5 任务完成");
  // Not a composer pill: 18px tall, 4px corner, no border.
  const style = chip(container, "running")?.getAttribute("style") ?? "";
  assert("a chip is 18px tall with a 4px corner", /height:\s*18px/.test(style) && /border-top-left-radius:\s*4px/.test(style), style);
  assert("…and has no border", !/border-(top|left)-width:\s*[1-9]/.test(style), style);
  for (const name of ["lead", "reviewer", "elsewhere", "fixer"]) {
    assert(`no member row: ${name} is not drawn`, !texts(container).includes(name), texts(container).join("|"));
  }
  assert("no idle word anywhere", !container.textContent.includes("空闲"));
  assert("no per-member facts like 运行中 · …", !/运行中 ·/.test(container.textContent));
  // Run state missing: no 运行中 / 已停止 chip.
  const unknown = render({ team: { members: BOARD.members.map(({ running, ...rest }) => rest), tasks: BOARD.tasks } }).container;
  check("running missing: only the done chip", JSON.stringify(chipKeys(unknown)), JSON.stringify(["done"]));
  assert("…no 运行中 anywhere", !unknown.textContent.includes("运行中"), unknown.textContent);
  assert("…no 已停止 anywhere", !unknown.textContent.includes("已停止"), unknown.textContent);
  check("…and the headline reads", headline(unknown)?.getAttribute("aria-label"), "DeepSeek，3 名成员，1/5 任务完成");
  // A zero count is never a chip.
  const zero = render({ team: { members: [LEAD, mate({ id: "a", name: "a", running: true })], tasks: [task({ id: "task-1", subject: "x", status: "in_progress" })] } }).container;
  check("zero stopped, zero done: only running", JSON.stringify(chipKeys(zero)), JSON.stringify(["running"]));
  const none = render({ team: { members: [LEAD, mate({ id: "a", name: "a" })], tasks: [] } }).container;
  check("nothing to count: no chip at all", chipKeys(none).length, 0);
  // A failed member: a red chip, first.
  const failedBoard = { ...BOARD, members: [...BOARD.members, mate({ id: "f", name: "broken", phase: "failed", error: "child Session recovery failed: x" })] };
  const failed = render({ team: failedBoard }).container;
  check("a failed member: the failed chip leads", chipKeys(failed)[0], "failed");
  const red = [...(chip(failed, "failed")?.querySelectorAll('[dir="auto"]') ?? [])].find((n) => n.textContent === "1 创建失败");
  assert("…in statusDanger", /color:\s*rgb\(157, 67, 59\)/.test(red?.getAttribute("style") ?? ""), red?.outerHTML);
  assert("…on a danger tint", /background-color:\s*rgba\(157, 67, 59/.test(chip(failed, "failed")?.getAttribute("style") ?? ""), chip(failed, "failed")?.getAttribute("style"));
  assert("…and DSH's member error is not drawn as a row", !failed.textContent.includes("child Session recovery failed"));
  // The hidden measuring copies stay out of the accessibility tree.
  const hidden = [...head.querySelectorAll('[aria-hidden="true"]')].filter((n) => /opacity:\s*0/.test(n.getAttribute("style") ?? "") && /position:\s*absolute/.test(n.getAttribute("style") ?? ""));
  check("four hidden measuring copies, one per ladder level", hidden.length, 4);
  assert("…none of them inside the shown chips", hidden.every((n) => n.closest('[data-testid="team-head-chips"]') === null));
}

console.log("\nthe owner's running ring (T5)");
{
  const { container } = render({ team: BOARD });
  const rings = [...container.querySelectorAll(RING)];
  check("exactly one ring: task-5's running owner", rings.length, 1);
  const ringRow = rings[0]?.closest('[role="button"]');
  assert("…inside task-5's row", (ringRow?.getAttribute("aria-label") ?? "").startsWith("返工补丁"), ringRow?.getAttribute("aria-label"));
  const facts = rings[0]?.parentElement;
  const runs = [...(facts?.querySelectorAll('[dir="auto"]') ?? [])].map((node) => node.textContent);
  assert("…right after the owner's name", runs[0] === "task-5 · fixer" && runs[1] === " · src/", JSON.stringify(runs));
  const ringBox = rings[0];
  assert("…at the facts line's 12px", /width:\s*12px/.test(ringBox?.getAttribute("style") ?? ""), ringBox?.getAttribute("style"));
  const reviewerRow = byLabelStart(container, "独立审查修复");
  check("an idle owner's row has no ring", reviewerRow?.querySelectorAll(RING).length, 0);
  const unowned = byLabelStart(container, "整理证据");
  check("an unowned row has no ring", unowned?.querySelectorAll(RING).length, 0);
  click(byLabelStart(container, "返工补丁"));
  check("the detail page's owner field carries the ring", container.querySelectorAll(RING).length, 1);
  const owner = [...container.querySelectorAll('[dir="auto"]')].find((node) => node.textContent === "fixer");
  assert("…next to the owner's name", owner !== undefined && owner.parentElement?.querySelector(RING) !== null);
  click(byLabel(container, "返回"));
  click(byLabelStart(container, "独立审查修复"));
  check("an idle owner's detail page has no ring", container.querySelectorAll(RING).length, 0);
}

console.log("\nstopped owners (T5): 已停止 only from running:false");
{
  // reviewer is running:false and owns in-progress task-2.
  const { container } = render({ team: BOARD });
  const row = byLabelStart(container, "独立审查修复");
  assert("a stopped owner's row carries 已停止", [...row.querySelectorAll('[dir="auto"]')].some((node) => node.textContent === "已停止"), row?.textContent);
  assert("…and says so to a screen reader", (row?.getAttribute("aria-label") ?? "").endsWith("，已停止"), row?.getAttribute("aria-label"));
  check("…and no ring", row?.querySelectorAll(RING).length, 0);
  const running = byLabelStart(container, "返工补丁");
  assert("a running owner's row has no 已停止", !running.textContent.includes("已停止"));
  const doneOpen = render({ team: BOARD, initialDoneOpen: true }).container;
  const doneRow = byLabelStart(doneOpen, "修复选页错位");
  assert("a completed task never carries 已停止", doneRow !== undefined && !doneRow.textContent.includes("已停止"), doneRow?.textContent);
  const header = [...container.querySelectorAll('[role="heading"]')].find((node) => (node.textContent ?? "").startsWith("进行中"));
  check("the 进行中 header counts stopped owners", header?.textContent, "进行中2 · 1 个负责人已停止");
  // Running unknown for everyone: no 已停止 anywhere and no count.
  const unknownBoard = { members: BOARD.members.map(({ running, ...rest }) => rest), tasks: BOARD.tasks };
  const unknown = render({ team: unknownBoard }).container;
  assert("unknown running: no 已停止 anywhere", !unknown.textContent.includes("已停止"), unknown.textContent);
  assert("…and no stopped count", !unknown.textContent.includes("负责人已停止"));
  // The user's case: ten in-progress tasks whose owners all stopped.
  const ten = {
    members: [LEAD, ...Array.from({ length: 9 }, (_, i) => mate({ id: `m${i}`, name: `m${i}`, running: false }))],
    tasks: Array.from({ length: 10 }, (_, i) => task({ id: `task-${i + 1}`, subject: `审查 ${i + 1}`, status: "in_progress", ownerName: `m${i % 9}` })),
  };
  const all = render({ team: ten }).container;
  const allHeader = [...all.querySelectorAll('[role="heading"]')].find((node) => (node.textContent ?? "").startsWith("进行中"));
  check("all ten stopped: the header says so", allHeader?.textContent, "进行中10 · 10 个负责人已停止");
  check("…ten 已停止 tags", [...all.querySelectorAll('[dir="auto"]')].filter((node) => node.textContent === "已停止").length, 10);
  check("…the headline has a stopped chip and no running chip", JSON.stringify(chipKeys(all)), JSON.stringify(["stopped"]));
  assert("…and the tasks stay under 进行中 (DSH's status, not re-judged)", !all.textContent.includes("已完成"), all.textContent);
  // The detail page.
  click(byLabelStart(container, "独立审查修复"));
  const owner = [...container.querySelectorAll('[dir="auto"]')].find((node) => node.textContent === "reviewer");
  assert("the detail page's owner field carries 已停止", owner?.parentElement?.textContent === "负责人reviewer已停止", owner?.parentElement?.textContent);
}

console.log("\ntask rows: facts, warnings, two-line description");
{
  const { container } = render({ team: BOARD });
  // The facts line is runs (id · owner | ring | · trail); read the row's whole line.
  const factsOf = (prefix) => {
    const row = byLabelStart(container, prefix);
    const line = [...(row?.querySelectorAll("div") ?? [])].find((node) => node.firstElementChild?.getAttribute("dir") === "auto" && /^task-\d/.test(node.textContent ?? ""));
    return line?.textContent;
  };
  check("facts: id · owner · 已停止 · scope", factsOf("独立审查修复"), "task-2 · reviewer已停止 · docs/audits/");
  check("facts: blockers while blocked", factsOf("复审返工"), "task-3 · 未分配 · 等 task-2");
  check("facts: two scopes", factsOf("整理证据"), "task-4 · 未分配 · docs/a/ +1");
  assert("the overlap warning is translated", texts(container).includes("写入范围与 task-2 重叠"));
  const desc = [...container.querySelectorAll('[dir="auto"]')].find((node) => (node.textContent ?? "").startsWith("第一段"));
  assert("the list shows the description on joined lines", desc !== undefined && !desc.textContent.includes("\n"), desc?.textContent);
  const classes = desc?.getAttribute("class") ?? "";
  const style = desc?.getAttribute("style") ?? "";
  // react-native-web draws numberOfLines > 1 as a -webkit-box clamp (the
  // WebkitBoxOrient class); jsdom drops the -webkit-line-clamp value itself, so
  // the count is pinned in the source.
  assert("…as a multi-line clamp, not one truncated line", /WebkitBoxOrient/.test(classes) && !/whiteSpace/.test(classes), `${style} | ${classes}`);
  const popoverSource = fs.readFileSync(path.join(pluginRoot, "client/team-popover.tsx"), "utf8");
  assert("…of exactly two lines", /export const TEAM_DESCRIPTION_LINES = 2;/.test(popoverSource) && /numberOfLines=\{TEAM_DESCRIPTION_LINES\}/.test(popoverSource));
}

console.log("\nthe detail page");
{
  const { container } = render({ team: BOARD });
  const row = byLabelStart(container, "独立审查修复，进行中");
  assert("a task row is a button", row?.getAttribute("role") === "button", row?.outerHTML?.slice(0, 120));
  click(row);
  assert("the page names the task and its state in the back row", container.textContent.includes("task-2 · 进行中"));
  for (const label of ["状态", "负责人", "写入范围", "修订"]) assert(`the page shows ${label}`, texts(container).includes(label));
  assert("the page shows the whole description, newlines kept", [...container.querySelectorAll('[dir="auto"]')].some((node) => node.textContent === LONG));
  assert("the roster summary is gone while the page is open", !container.textContent.includes("名成员"));
  const back = byLabel(container, "返回");
  assert("the back row is a button", back?.getAttribute("role") === "button");
  click(back);
  assert("back returns to the list", container.textContent.includes("名成员") && container.textContent.includes("等待依赖"));
}

console.log("\nempty, Lead-only, failure, read-only");
{
  const empty = render({ team: { members: [LEAD, mate({ id: "x", name: "x", running: true })], tasks: [] } }).container;
  assert("an empty board says 暂无共享任务", empty.textContent.includes("暂无共享任务"));
  const leadOnly = render({ team: { members: [LEAD], tasks: [task({ id: "task-1", subject: "a", ready: true })] } }).container;
  assert("a Lead-only board's headline is just DeepSeek and it lists its tasks", headline(leadOnly)?.getAttribute("aria-label") === "DeepSeek" && leadOnly.textContent.includes("可开始"), headline(leadOnly)?.getAttribute("aria-label"));
  assert("…no 「0 名成员」 (nor any member count)", !leadOnly.textContent.includes("名成员"), leadOnly.textContent);
  const leadDone = render({ team: { members: [{ ...LEAD, running: true }], tasks: [task({ id: "task-1", subject: "a", status: "completed" }), task({ id: "task-2", subject: "b", ready: true })] } }).container;
  check("0 teammates with tasks: DeepSeek + the done chip only", headline(leadDone)?.getAttribute("aria-label"), "DeepSeek，1/2 任务完成");
  assert("…and the running Lead is not a 运行中 chip", !leadDone.textContent.includes("运行中"), leadDone.textContent);
  const failed = render({ team: { ...BOARD, failure: 'team task "task-3" revision is not contiguous', members: [...BOARD.members, mate({ id: "f", name: "broken", phase: "failed", error: "child Session recovery failed: x" })] } }).container;
  const alert = failed.querySelector('[role="alert"]');
  assert("the failure row comes first", alert !== null && failed.textContent.indexOf("团队记录无效") < failed.textContent.indexOf("名成员"));
  assert("…with DSH's sentence verbatim", failed.textContent.includes('团队记录无效：team task "task-3" revision is not contiguous'));
  assert("a failed member shows in the headline", chipKeys(failed).includes("failed"));
  const { container } = render({ team: BOARD });
  const buttons = [...container.querySelectorAll('[role="button"]')].map((node) => node.getAttribute("aria-label"));
  check("the only buttons are four visible task rows and the done fold", buttons.length, 5);
  assert("no member row is pressable", !buttons.some((label) => /^(lead|fixer|reviewer|elsewhere)，/.test(label ?? "")), buttons.join(" | "));
  const note = document.createElement("div");
  document.body.appendChild(note);
  flushSync(() => createRoot(note).render(React.createElement(TeamPanelNote, { theme, compact: true, message: text.noTeam })));
  assert("the note body draws its sentence", note.textContent.includes("本会话没有团队"));
}

console.log("\nthe real container reads the shared store");
{
  const listeners = new Set();
  const store = new Map([["agent-1", { team: BOARD, listeners }]]);
  const Popover = makeTeamPopover(store, "agent-1");
  const container = document.createElement("div");
  document.body.appendChild(container);
  flushSync(() => createRoot(container).render(React.createElement(Popover, { theme, layout: { compact: true, platform: "web" }, close: () => {} })));
  assert("the container draws the board", container.textContent.includes("独立审查修复"));
  check("…and subscribes for the next poll", listeners.size, 1);
  store.set("agent-1", { team: { ...BOARD, tasks: [] }, listeners });
  flushSync(() => [...listeners].forEach((listener) => listener()));
  assert("a new board redraws in place", container.textContent.includes("暂无共享任务"));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log("OK");
process.exit(0);
