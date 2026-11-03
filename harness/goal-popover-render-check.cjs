/**
 * Offline behaviour check for the goal popover's rendered DOM.
 *
 * The design is a track panel: one pressable objective row (with two icon
 * buttons), an in-place edit page (design-opus-v4 direction C: a small Paseo
 * composer) and an in-place clear-confirmation page. A source regex cannot prove
 * that pressing the row opens the editor, that the two icon buttons do not open
 * it, that the field is pre-filled with the caret at 0, that the round ✓ is
 * inert for an empty/unchanged draft, that desktop Enter saves while Shift+Enter,
 * an IME commit and a phone Enter do not, that Escape cancels, that blur never
 * saves, or that the clear page's red row appears only there. This
 * script renders the **real** `GoalPopoverBody` through `react-native-web` into
 * jsdom and asserts exactly those behaviours.
 *
 * The bundle is built on the fly with esbuild from the **host app's**
 * `node_modules`; the host UI kit's `Icon` and `TextInput` are stood in for by a
 * tiny stub that maps `TextInput` to react-native-web's real input and `Icon` to
 * the host's own seams: `name` → the real `lucide-react` glyph, `icon={{svg}}` →
 * the inline SVG document (sized like the host's `SvgIcon`). No network, no DSH,
 * no Paseo daemon.
 *
 * Run (from anywhere):
 *   HOST_APP=/path/to/paseo node harness/goal-popover-render-check.cjs
 *
 * `HOST_APP` is the checkout that provides react/react-dom/react-native-web/
 * esbuild/jsdom/lucide-react. Without it the check cannot render, so it exits 2
 * (incomplete) rather than pretending to pass — same convention as
 * `harness/jobs-popover-check.cjs`.
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
  console.error("  HOST_APP=/path/to/paseo node harness/goal-popover-render-check.cjs");
  process.exit(2);
}
const hostModules = path.join(hostApp, "node_modules");
const work = path.join(repoRoot, "paseo-plugin", ".dbg-popover-render");
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

const entry = path.join(work, "entry.tsx");
fs.writeFileSync(
  entry,
  `export { GoalPopoverBody } from ${JSON.stringify(path.join(pluginRoot, "client/goal-popover.tsx"))};
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
const { GoalPopoverBody, allText, createRoot, createElement, flushSync } = bundled;
const React = { createElement };

// The shipped zh-CN copy, not a local copy: the disarmed hint and every label
// asserted below are the strings the plugin actually draws.
const text = allText()["zh-CN"].goal;

const theme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#fafafa",
    surface2: "#f4f4f5",
    border: "#e4e4e7",
    foreground: "#1a1a1e",
    foregroundMuted: "#71717a",
    accent: "#20744A",
    accentForeground: "#ffffff",
    statusSuccess: "#3e704a",
    statusWarning: "#7b5d39",
    statusDanger: "#9d433b",
  },
};

const baseGoal = {
  objective: "持续把 dist 目录的构建产物清理干净，并在每轮结束时追加一条变更记录到 CHANGELOG，直到 CI 全绿为止",
  phase: "active",
  activation: "armed",
  roundsStarted: 3,
  maxGoalRounds: 10,
  currentTask: "清理 node_modules 中的缓存目录",
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

/** Render one panel state; every callback is a counting spy unless overridden. */
function render(props = {}) {
  const calls = { toggle: 0, beginEdit: 0, beginClear: 0, save: 0, cancelEdit: 0, confirmClear: 0, cancelClear: 0 };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // `flushSync`, not `act`: the bundle carries its own React, and a synchronous
  // flush is the only reliable way to land the commit in jsdom here.
  flushSync(() => {
    root.render(
      React.createElement(GoalPopoverBody, {
        goal: props.goal ?? baseGoal,
        text,
        theme,
        compact: props.compact ?? false,
        running: props.running ?? false,
        mode: props.mode ?? "view",
        busy: props.busy ?? false,
        error: props.error,
        draft: props.draft ?? "",
        onToggleRunning: () => {
          calls.toggle += 1;
        },
        onBeginEdit: () => {
          calls.beginEdit += 1;
        },
        onBeginClear: () => {
          calls.beginClear += 1;
        },
        onSave: () => {
          calls.save += 1;
        },
        onCancelEdit: () => {
          calls.cancelEdit += 1;
        },
        onConfirmClear: () => {
          calls.confirmClear += 1;
        },
        onCancelClear: () => {
          calls.cancelClear += 1;
        },
        onChangeDraft: () => {},
      }),
    );
  });
  return { container, calls };
}

function byLabel(container, label) {
  return [...container.querySelectorAll("[aria-label]")].find(
    (node) => node.getAttribute("aria-label") === label,
  );
}
function click(node) {
  flushSync(() => {
    node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
function keydown(node, key, init = {}) {
  flushSync(() => {
    node.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}
function field(container) {
  return container.querySelector("input, textarea");
}

console.log("the objective row is the panel's only action target");
{
  const { container, calls } = render();
  const row = byLabel(container, "编辑目标");
  assert("the objective row is a button named 编辑目标", row !== undefined);
  // Exactly three buttons: the row itself and its two icon buttons. There is no
  // separate edit button — the design removed it, the row opens the editor.
  const buttons = [...container.querySelectorAll('[role="button"]')];
  check("the row plus its two icon buttons are the only buttons", buttons.length, 3);
  assert("the pause icon button is named 暂停目标", byLabel(container, "暂停目标") !== undefined);
  assert("the clear icon button is named 清除目标", byLabel(container, "清除目标") !== undefined);

  // The two lines: one truncated objective, one facts line.
  const objective = [...container.querySelectorAll("div,span")].find((node) =>
    (node.textContent ?? "").trim() === baseGoal.objective,
  );
  assert("the objective is drawn", objective !== undefined);
  if (objective !== undefined) {
    // `numberOfLines={1}` reaches the DOM as react-native-web's single-line
    // class (`r-whiteSpace-*` / `r-overflow-*` / `r-textOverflow-*`), not as an
    // inline style; jsdom also computes it when the injected sheet is present.
    const style = objective.getAttribute("style") ?? "";
    const classes = objective.getAttribute("class") ?? "";
    const computed = global.getComputedStyle(objective);
    assert(
      "the objective is one truncated line",
      /nowrap/.test(computed.whiteSpace ?? "") ||
        /white-space:\s*nowrap/.test(style) ||
        (/whiteSpace/.test(classes) && /textOverflow/.test(classes)),
      `${style} | ${classes}`,
    );
  }
  assert("the facts line is drawn", container.textContent.includes("进行中 · 第 3 轮 · 预算 10"));
  assert("the now line is drawn", container.textContent.includes("正在：清理 node_modules 中的缓存目录"));

  // The icon button must stop its own press. On react-native-web the nested
  // Pressable already swallows the click, so the behavioural check above cannot
  // see the difference; the call site is pinned here (code form, not a comment)
  // so removing the stopPropagation still fails.
  const popoverSource = fs.readFileSync(path.join(pluginRoot, "client/goal-popover.tsx"), "utf8");
  assert(
    "the icon button stops its own press",
    /onPress=\{\(event\) => \{\s*event\.stopPropagation\?\.\(\);/.test(popoverSource),
  );

  // The row press opens the editor; the icon buttons do not.
  click(row);
  check("pressing the row opens the editor", calls.beginEdit, 1);
  click(byLabel(container, "暂停目标"));
  check("the pause button pauses", calls.toggle, 1);
  check("the pause button does not open the editor", calls.beginEdit, 1);
  click(byLabel(container, "清除目标"));
  check("the clear button opens the confirmation", calls.beginClear, 1);
  check("the clear button does not open the editor", calls.beginEdit, 1);
}

console.log("\nthe running ring turns on the whale's corner");
{
  const running = render({ running: true }).container;
  const ring = running.querySelector('[role="progressbar"]');
  assert("a running goal draws the ring", ring !== null);
  check("the ring is labelled 目标运行中", ring?.getAttribute("aria-label"), "目标运行中");
  const idle = render({ running: false }).container;
  assert("a non-running goal draws no ring", idle.querySelector('[role="progressbar"]') === null);
}

console.log("\nthe edit page is a small composer");
{
  const { container, calls } = render({ mode: "edit", draft: baseGoal.objective });
  assert("the edit page names itself 编辑目标", container.textContent.includes("编辑目标"));
  assert("the edit page keeps the whale", container.querySelector('[data-icon="svg"]') !== null);
  const input = field(container);
  assert("the edit page renders a real multi-line field", input !== null && input.tagName === "TEXTAREA");
  check("the field is pre-filled with the full objective", input.value, baseGoal.objective);
  check("the caret starts at the beginning", input.selectionStart, 0);
  // The field grows from two lines (2 × 21 on web) and stops at six (6 × 21).
  // jsdom never lays the measuring copy out, so this is the two-line floor.
  const style = input.getAttribute("style") ?? "";
  assert("an unmeasured field is two lines tall", /(^|;)\s*height:\s*42px/.test(style), style);
  assert("the field stops growing at six lines", /max-height:\s*126px/.test(style), style);
  assert("the field uses the composer's 15px type", /font-size:\s*15px/.test(style), style);
  // The old menu-row page is gone: no 保存 row, no separator under the field.
  assert("there is no 保存 menu row", byLabel(container, "保存") === undefined);
  assert("the save button is named 保存目标", byLabel(container, "保存目标") !== undefined);
  // The now line is hidden while editing: the panel does one thing at a time.
  assert("the now line is hidden while editing", !container.textContent.includes("正在："));
  click(byLabel(container, "取消"));
  check("取消 leaves the edit page", calls.cancelEdit, 1);
}

console.log("\nthe round ✓ is inert for an empty or unchanged draft");
{
  for (const [what, draft] of [["blank", "   "], ["unchanged", baseGoal.objective]]) {
    const { container, calls } = render({ mode: "edit", draft });
    const save = byLabel(container, "保存目标");
    assert(`✓ is disabled for a ${what} draft`, save.getAttribute("aria-disabled") === "true", save.outerHTML);
    assert(`✓ is half opacity for a ${what} draft`, /opacity:\s*0\.5/.test(save.getAttribute("style") ?? ""), save.getAttribute("style"));
    click(save);
    check(`clicking ✓ on a ${what} draft submits nothing`, calls.save, 0);
    keydown(field(container), "Enter");
    check(`desktop Enter on a ${what} draft submits nothing`, calls.save, 0);
  }
  const changed = render({ mode: "edit", draft: `${baseGoal.objective}（已改）` });
  const save = byLabel(changed.container, "保存目标");
  assert("✓ is enabled for a changed draft", save.getAttribute("aria-disabled") !== "true", save.outerHTML);
  assert("an enabled ✓ is fully opaque", /opacity:\s*1(;|$)/.test(save.getAttribute("style") ?? ""), save.getAttribute("style"));
  click(save);
  check("clicking ✓ submits", changed.calls.save, 1);
}

console.log("\ndesktop keys: Enter saves, Shift+Enter and an IME commit do not, Escape cancels");
{
  const dirty = `${baseGoal.objective}（已改）`;
  const desk = render({ mode: "edit", draft: dirty });
  assert("desktop shows the Enter hint", desk.container.textContent.includes("Enter保存"));
  assert("desktop shows the Shift Enter hint", desk.container.textContent.includes("Shift Enter换行"));
  assert("desktop shows the Esc hint", desk.container.textContent.includes("Esc取消"));
  keydown(field(desk.container), "Enter", { shiftKey: true });
  check("Shift+Enter does not save", desk.calls.save, 0);
  keydown(field(desk.container), "Enter", { isComposing: true });
  check("an Enter that commits an IME candidate does not save", desk.calls.save, 0);
  keydown(field(desk.container), "Enter");
  check("desktop Enter saves", desk.calls.save, 1);
  keydown(field(desk.container), "Escape");
  check("Escape cancels", desk.calls.cancelEdit, 1);

  const phone = render({ mode: "edit", draft: dirty, compact: true });
  keydown(field(phone.container), "Enter");
  check("phone Enter is a newline, not a save", phone.calls.save, 0);
  assert("phone shows no key hints", !phone.container.textContent.includes("Enter"));
  assert("phone shows no Esc hint", !phone.container.textContent.includes("Esc"));
  assert("phone keeps the 编辑目标 header", phone.container.textContent.includes("编辑目标"));
  click(byLabel(phone.container, "保存目标"));
  check("phone ✓ saves", phone.calls.save, 1);
}

console.log("\nblur never saves");
{
  const blur = render({ mode: "edit", draft: `${baseGoal.objective}（已改）` });
  const blurred = field(blur.container);
  // React's onBlur is delegated from `focusout`; dispatching `blur` alone never
  // reaches it, which would make this check pass no matter what the component
  // does. `blur()` + focusout is the real path.
  flushSync(() => {
    blurred.focus();
    blurred.blur();
    blurred.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  });
  check("blur never saves", blur.calls.save, 0);
  check("blur never cancels either", blur.calls.cancelEdit, 0);
}

console.log("\nthe clear page follows the host's menu density");
{
  // menu-item.tsx:441's `MENU_ITEM_HEIGHT` is 40 under a finger and 28 on a
  // pointer layout.
  const confirmPhone = render({ mode: "confirm", compact: true });
  for (const label of ["清除目标", "取消"]) {
    const row = byLabel(confirmPhone.container, label);
    assert(`the phone clear page's ${label} row is the host's 40px item`, /min-height:\s*40px/.test(row?.getAttribute("style") ?? ""), row?.getAttribute("style") ?? "missing");
  }
  const confirmWide = render({ mode: "confirm", compact: false });
  for (const label of ["清除目标", "取消"]) {
    const row = byLabel(confirmWide.container, label);
    assert(`the wide clear page's ${label} row is the host's 28px item`, /min-height:\s*28px/.test(row?.getAttribute("style") ?? ""), row?.getAttribute("style") ?? "missing");
  }
}

console.log("\nthe clear page is the design's confirmation");
{
  const { container, calls } = render({ mode: "confirm" });
  assert("the clear page shows the hint", container.textContent.includes("清除后目标不再续跑，无法撤销"));
  const clearRow = byLabel(container, "清除目标");
  assert("the clear page's row is named 清除目标", clearRow !== undefined);
  // The **label** must be red (a `MenuItem destructive`), not just the glyph:
  // the colour lives on the text node, so the icon cannot satisfy this check.
  const clearLabel = [...clearRow.querySelectorAll("div,span")].find(
    (node) => (node.textContent ?? "").trim() === "清除目标",
  );
  assert(
    "the clear row's label is red",
    clearLabel !== undefined && /color:\s*rgb\(157, 67, 59\)/.test(clearLabel.getAttribute("style") ?? ""),
    clearRow.outerHTML,
  );
  assert("the clear page has a cancel row", byLabel(container, "取消") !== undefined);
  click(clearRow);
  check("the confirmation row executes the clear", calls.confirmClear, 1);
  click(byLabel(container, "取消"));
  check("cancel leaves the confirmation", calls.cancelClear, 1);
  // The red row exists only on this page: the view page has no red text.
  const view = render().container;
  assert("the view page has no red row", !view.innerHTML.includes("rgb(157, 67, 59)"));
}

console.log("\nthe disarmed and blocked pages keep the design's rows");
{
  const disarmed = render({ goal: { ...baseGoal, activation: "disarmed" } }).container;
  assert(
    "a disarmed goal shows hint B in full",
    disarmed.textContent.includes("重开会话后自动续跑会停止，点「继续」恢复"),
    disarmed.textContent,
  );
  // The facts line must agree with the pill's 目标未在续跑, not say 进行中.
  assert("a disarmed goal's facts say 未在续跑", disarmed.textContent.includes("未在续跑 · 第 3 轮 · 预算 10"));
  assert("a disarmed goal's facts do not say 进行中", !disarmed.textContent.includes("进行中"));
  const blocked = render({
    goal: { ...baseGoal, phase: "blocked", blockedReason: { code: "round-limit", message: "需要确认能否删除 dist/legacy，模型不会自行决定" } },
  }).container;
  assert("a blocked goal shows DSH's sentence", blocked.textContent.includes("需要确认能否删除 dist/legacy"));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log("OK");
process.exit(0);
