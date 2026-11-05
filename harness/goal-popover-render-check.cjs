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

// The container (`makeGoalPopover`) reads the agent's status through the plugin
// SDK's `useAgent`, a host hook; this stand-in answers "idle", which is all the
// panel's close/stay behaviour needs.
const clientStub = path.join(work, "client-stub.ts");
fs.writeFileSync(clientStub, "export function useAgent() { return \"idle\"; }\n");

const entry = path.join(work, "entry.tsx");
fs.writeFileSync(
  entry,
  `export { GoalPopoverBody } from ${JSON.stringify(path.join(pluginRoot, "client/goal-popover.tsx"))};
export { allText } from ${JSON.stringify(path.join(pluginRoot, "client/locale.ts"))};
export { makeGoalPopover, makeGoalIcon, makeGoalJobsPopover } from ${JSON.stringify(path.join(pluginRoot, "client/goal-pill.tsx"))};
export { makeJobsPopover } from ${JSON.stringify(path.join(pluginRoot, "client/jobs-pill.tsx"))};
export { createGoalJobsSlot } from ${JSON.stringify(path.join(pluginRoot, "client/goal-jobs-slot.ts"))};
export { CornerRingIcon } from ${JSON.stringify(path.join(pluginRoot, "client/corner-ring.tsx"))};
export { JobsPillIcon } from ${JSON.stringify(path.join(pluginRoot, "client/jobs-spinner.tsx"))};
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
const {
  GoalPopoverBody,
  allText,
  makeGoalPopover,
  makeGoalIcon,
  makeGoalJobsPopover,
  makeJobsPopover,
  createGoalJobsSlot,
  CornerRingIcon,
  JobsPillIcon,
  createRoot,
  createElement,
  flushSync,
} = bundled;
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
  id: "goal-1",
  revision: 1,
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
  // The pill's own name is only 「目标」 (UI-v7), so the row speaks the state
  // first, then its action.
  const row = byLabel(container, "目标进行中，编辑目标");
  assert("the objective row is a button named 目标进行中，编辑目标", row !== undefined);
  check("…with the button role", row?.getAttribute("role"), "button");
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

console.log("\nthe clear page holds the view page's row in place (UI-v9 direction B)");
{
  for (const compact of [true, false]) {
    const where = compact ? "phone" : "wide";
    const { container } = render({ mode: "confirm", compact });
    const buttons = [...container.querySelectorAll('[role="button"]')];
    check(`the ${where} clear page has exactly two buttons`, buttons.length, 2);
    const red = byLabel(container, "清除目标");
    const size = compact ? 32 : 24;
    const style = red?.getAttribute("style") ?? "";
    assert(`the ${where} red button is ${size}px round`, new RegExp(`width:\\s*${size}px`).test(style) && new RegExp(`height:\\s*${size}px`).test(style), style);
    assert(`the ${where} red button is filled statusDanger`, /background-color:\s*rgb\(157, 67, 59\)/.test(style), style);
    assert(`the ${where} red button carries the trash glyph`, red?.querySelector('[data-icon="Trash2"]') !== null);
    const cancel = byLabel(container, "取消");
    const cancelStyle = cancel?.getAttribute("style") ?? "";
    assert(`the ${where} 取消 is quiet (transparent)`, !/background-color:\s*rgb\(157, 67, 59\)/.test(cancelStyle) && !/background-color:\s*rgb\(32, 116, 74\)/.test(cancelStyle), cancelStyle);
    const cancelText = [...cancel.querySelectorAll("div,span")].find((node) => (node.textContent ?? "").trim() === "取消");
    assert(`the ${where} 取消 text is muted`, /color:\s*rgb\(113, 113, 122\)/.test(cancelText?.getAttribute("style") ?? ""), cancelText?.outerHTML);
    // The objective row: whale, one truncated line, facts — not a button.
    const rowNode = byLabel(container, `目标进行中，${baseGoal.objective}`);
    assert(`the ${where} clear page shows which goal (row named by state + objective)`, rowNode !== undefined);
    assert(`…and the row is not a button`, rowNode?.getAttribute("role") !== "button");
    assert(`the ${where} clear page draws the whale`, container.querySelector('[data-icon="svg"]') !== null);
    assert(`the ${where} clear page has no running ring`, container.querySelector('[role="progressbar"]') === null);
    assert(`the ${where} clear page draws the facts`, container.textContent.includes("进行中 · 第 3 轮 · 预算 10"));
    const objective = [...container.querySelectorAll("div,span")].find((node) => (node.textContent ?? "").trim() === baseGoal.objective);
    const classes = objective?.getAttribute("class") ?? "";
    assert(`the ${where} objective is one truncated line`, /whiteSpace/.test(classes) && /textOverflow/.test(classes), classes);
    // The hint comes after the row (below it), not above.
    const html = container.innerHTML;
    assert(`the ${where} hint sits below the row`, html.indexOf(baseGoal.objective) < html.indexOf("清除后目标不再续跑"));
  }
}

console.log("\nthe red button ignores a press for the first 400ms (double-click guard)");
const armChecks = (async () => {
  const { container, calls } = render({ mode: "confirm" });
  const red = byLabel(container, "清除目标");
  const style = red.getAttribute("style") ?? "";
  assert("the fresh red button is faded", /opacity:\s*0\.35/.test(style), style);
  assert("the fresh red button is shrunk", /scale\(0\.86\)/.test(style), style);
  check("the fresh red button says it is disabled", red.getAttribute("aria-disabled"), "true");
  click(red);
  check("a press in the first 400ms does not clear", calls.confirmClear, 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  click(byLabel(container, "清除目标"));
  check("…nor at 200ms", calls.confirmClear, 0);
  // 取消 is live from the first frame.
  click(byLabel(container, "取消"));
  check("取消 works at once", calls.cancelClear, 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const armed = byLabel(container, "清除目标");
  const armedStyle = armed.getAttribute("style") ?? "";
  assert("after 400ms the red button is opaque", !/opacity:\s*0\.35/.test(armedStyle), armedStyle);
  assert("…and full size", /scale\(1\)/.test(armedStyle), armedStyle);
  assert("…and no longer disabled", armed.getAttribute("aria-disabled") !== "true");
  click(armed);
  check("after 400ms the press clears", calls.confirmClear, 1);

  // Busy: the red button spins and is inert; 取消 stays live (interaction unchanged).
  const busy = render({ mode: "confirm", busy: true });
  await new Promise((resolve) => setTimeout(resolve, 450));
  const busyRed = byLabel(busy.container, "清除目标");
  assert("a busy red button shows the spinner", busyRed.querySelector('[role="progressbar"]') !== null, busyRed.innerHTML);
  click(busyRed);
  check("a busy red button does not clear again", busy.calls.confirmClear, 0);
  click(byLabel(busy.container, "取消"));
  check("取消 still works while busy", busy.calls.cancelClear, 1);
})();

console.log("\nthe objective row names every non-complete state");
{
  const named = (over) => [...render({ goal: { ...baseGoal, ...over } }).container.querySelectorAll('[role="button"][aria-label]')]
    .map((node) => node.getAttribute("aria-label"))
    .find((label) => label.endsWith("编辑目标"));
  check("a disarmed row says 目标未在续跑", named({ activation: "disarmed" }), "目标未在续跑，编辑目标");
  check("a paused row says 目标已暂停", named({ phase: "paused" }), "目标已暂停，编辑目标");
  check(
    "a blocked row says 目标受阻",
    named({ phase: "blocked", blockedReason: { code: "x", message: "y" } }),
    "目标受阻，编辑目标",
  );
}

console.log("\nthe complete page is read-only, with only clear (UI-v7)");
{
  const done = { ...baseGoal, phase: "complete", activation: "disarmed", currentTask: undefined };
  const { container, calls } = render({ goal: done });
  // Exactly one button, and it is clear: no pause/resume, no editable row.
  const buttons = [...container.querySelectorAll('[role="button"]')];
  check("the complete page has exactly one button", buttons.length, 1);
  check("…and it is 清除目标", buttons[0]?.getAttribute("aria-label"), "清除目标");
  assert("there is no pause button", byLabel(container, "暂停目标") === undefined);
  assert("there is no resume button", byLabel(container, "继续目标") === undefined);
  // The row is not pressable: clicking it opens no editor.
  const row = byLabel(container, `目标已完成，${baseGoal.objective}`);
  assert("the row's name says 目标已完成 and the objective", row !== undefined);
  assert("the row is not a button", row?.getAttribute("role") !== "button", row?.getAttribute("role"));
  click(row);
  check("clicking the row opens no editor", calls.beginEdit, 0);
  // One truncated line, the same rule as the other states.
  const objective = [...container.querySelectorAll("div,span")].find(
    (node) => (node.textContent ?? "").trim() === baseGoal.objective,
  );
  const classes = objective?.getAttribute("class") ?? "";
  const style = objective?.getAttribute("style") ?? "";
  assert(
    "the objective is one truncated line",
    objective !== undefined && ((/whiteSpace/.test(classes) && /textOverflow/.test(classes)) || /white-space:\s*nowrap/.test(style)),
    `${style} | ${classes}`,
  );
  assert("the facts say 已完成", container.textContent.includes("已完成 · 第 3 轮 · 预算 10"));
  assert("the hint points at the closing message", container.textContent.includes("完成总结见会话最后一条助手消息"));
  assert("there is no running ring", container.querySelector('[role="progressbar"]') === null);
  click(byLabel(container, "清除目标"));
  check("clear opens the confirmation", calls.beginClear, 1);

  const confirm = render({ goal: done, mode: "confirm" }).container;
  assert(
    "the complete clear page has its own sentence",
    confirm.textContent.includes("清除后 /goal 将查不到这个目标，无法撤销"),
    confirm.textContent,
  );
  assert("…not the active goal's sentence", !confirm.textContent.includes("清除后目标不再续跑"));
  const active = render({ mode: "confirm" }).container;
  assert("an active goal's clear page keeps its sentence", active.textContent.includes("清除后目标不再续跑，无法撤销"));
}

console.log("\nthe clear page's red appears only there");
{
  const { container } = render({ mode: "confirm" });
  assert("the clear page shows the hint", container.textContent.includes("清除后目标不再续跑，无法撤销"));
  assert("the clear page has red", container.innerHTML.includes("rgb(157, 67, 59)"));
  const view = render().container;
  assert("the view page has no red", !view.innerHTML.includes("rgb(157, 67, 59)"));
}

console.log("\ncontrol errors are shown in Chinese, DSH's sentence kept (UI-v9)");
{
  const known = render({ mode: "confirm", error: "No goal to clear." }).container;
  assert("「No goal to clear.」 is shown in Chinese", known.textContent.includes("没有可清除的目标。"), known.textContent);
  assert("…with DSH's sentence kept under it", known.textContent.includes("No goal to clear."), known.textContent);
  const alert = known.querySelector('[role="alert"]');
  assert("…as one alert named by both", alert?.getAttribute("aria-label") === "没有可清除的目标。 No goal to clear.", alert?.getAttribute("aria-label"));
  const zhLine = [...known.querySelectorAll('[dir="auto"]')].find((node) => (node.textContent ?? "").trim() === "没有可清除的目标。");
  assert("…the Chinese line is red", /color:\s*rgb\(157, 67, 59\)/.test(zhLine?.getAttribute("style") ?? ""), zhLine?.outerHTML);
  const original = [...known.querySelectorAll('[dir="auto"]')].find((node) => (node.textContent ?? "").trim() === "No goal to clear.");
  assert("…the original is muted", /color:\s*rgb\(113, 113, 122\)/.test(original?.getAttribute("style") ?? ""), original?.outerHTML);

  const unknown = "Goal store is read-only (EROFS).";
  const raw = render({ mode: "confirm", error: unknown }).container;
  assert("an unknown sentence is shown verbatim", raw.textContent.includes(unknown), raw.textContent);
  assert("…not replaced by a generic line", !raw.textContent.includes("目标命令执行失败"), raw.textContent);
  check("…and drawn once", raw.textContent.split(unknown).length - 1, 1);
  const unknownLine = [...raw.querySelectorAll('[dir="auto"]')].find((node) => (node.textContent ?? "").trim() === unknown);
  assert("…in red", /color:\s*rgb\(157, 67, 59\)/.test(unknownLine?.getAttribute("style") ?? ""), unknownLine?.outerHTML);

  // The same display on the view page and the edit page.
  const view = render({ error: "The goal command is not valid for the current state. Run /goal to view available commands." }).container;
  assert("the view page translates a pause/resume refusal", view.textContent.includes("目标当前的状态不允许这个操作"), view.textContent);
  const edit = render({ mode: "edit", draft: "x", error: "Goal editing requires a replacement objective." }).container;
  assert("the edit page translates a save refusal", edit.textContent.includes("编辑目标需要填写新的目标内容。"), edit.textContent);
  const done = { ...baseGoal, phase: "complete", activation: "disarmed", currentTask: undefined };
  const completeView = render({ goal: done, error: "No goal to clear." }).container;
  assert("the complete page translates too", completeView.textContent.includes("没有可清除的目标。"), completeView.textContent);
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

/* The real container (UI-v8): leaving the editor closes the panel ----------- */

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * Mount `makeGoalPopover`'s component — the real container with its RPC and
 * mode state — against a fake client. `close` is the host's own close, spied.
 */
function mountContainer(answer) {
  const spies = { close: 0, refresh: 0, rpc: [], closed: [] };
  const store = new Map([["agent-1", { goal: baseGoal, available: true, listeners: new Set() }]]);
  const client = {
    rpc: async (_definition, input) => {
      spies.rpc.push(input);
      return answer;
    },
  };
  const Popover = makeGoalPopover(
    client,
    store,
    "agent-1",
    async () => {
      spies.refresh += 1;
    },
    (goal) => spies.closed.push(goal),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(Popover, {
        theme,
        layout: { compact: false, platform: "web" },
        host: { id: "h", label: "h" },
        context: "agent",
        workspaceId: "w",
        agentId: "agent-1",
        close: () => {
          spies.close += 1;
        },
      }),
    );
  });
  return { container, root, spies };
}

function openEditor(container) {
  click(byLabel(container, "目标进行中，编辑目标"));
}

/** Type into the edit field the way a browser does: set the value, fire `input`. */
function typeInto(input, value) {
  flushSync(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function containerChecks() {
  console.log("\nthe real container: leaving the editor closes the panel (UI-v8)");

  {
    const { container, root, spies } = mountContainer({ ok: true, message: "ok" });
    openEditor(container);
    assert("the row opens the editor", field(container) !== null);
    click(byLabel(container, "取消"));
    check("the editor's 取消 calls close() once", spies.close, 1);
    check("…and sends no command", spies.rpc.length, 0);
    // The host unmounts closed content; that must not mark an active goal seen.
    flushSync(() => root.unmount());
    check("closing reports the goal it showed", spies.closed.length, 1);
    check("…which is not complete, so nothing is marked seen", spies.closed[0]?.phase, "active");
  }

  {
    const { container, spies } = mountContainer({ ok: true, message: "ok" });
    openEditor(container);
    keydown(field(container), "Escape");
    check("Escape in the editor calls close() once", spies.close, 1);
  }

  {
    const { container, spies } = mountContainer({ ok: true, message: "Goal updated" });
    openEditor(container);
    typeInto(field(container), `${baseGoal.objective}（已改）`);
    click(byLabel(container, "保存目标"));
    await settle();
    await settle();
    check("a save sends one edit", spies.rpc.length, 1);
    check("…with the new objective", spies.rpc[0]?.objective, `${baseGoal.objective}（已改）`);
    check("a successful save calls close() once", spies.close, 1);
    check("…and still asks for a fresh read", spies.refresh, 1);
  }

  {
    const { container, spies } = mountContainer({ ok: false, error: "The goal command is not valid for the current state." });
    openEditor(container);
    typeInto(field(container), `${baseGoal.objective}（已改）`);
    click(byLabel(container, "保存目标"));
    await settle();
    await settle();
    check("a refused save does not close", spies.close, 0);
    assert("…it stays in the editor", field(container) !== null);
    check("…keeping the draft", field(container)?.value, `${baseGoal.objective}（已改）`);
    assert("…and shows DSH's sentence", container.textContent.includes("The goal command is not valid"), container.textContent);
  }

  {
    // The real container: a refused clear stays on the confirmation, in Chinese.
    const { container, spies } = mountContainer({ ok: false, error: "No goal to clear." });
    click(byLabel(container, "清除目标"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    click(byLabel(container, "清除目标"));
    await settle();
    await settle();
    check("the armed red button sends one clear", spies.rpc.length, 1);
    check("…as action clear", spies.rpc[0]?.action, "clear");
    check("a refused clear does not close", spies.close, 0);
    assert("…stays on the confirmation", container.textContent.includes("清除后目标不再续跑"));
    assert("…and shows the refusal in Chinese", container.textContent.includes("没有可清除的目标。"), container.textContent);
  }

  {
    // A double click on the view page's trash: the second press lands on the
    // red button in the same place, and must not clear.
    const { container, spies } = mountContainer({ ok: true, message: "Goal cleared." });
    click(byLabel(container, "清除目标"));
    click(byLabel(container, "清除目标"));
    await settle();
    check("a double click on the trash sends no clear", spies.rpc.length, 0);
    assert("…and leaves the confirmation open", container.textContent.includes("清除后目标不再续跑"));
  }

  {
    const { container, spies } = mountContainer({ ok: true, message: "ok" });
    click(byLabel(container, "清除目标"));
    assert("the clear button opens the confirmation", container.textContent.includes("清除后目标不再续跑"));
    click(byLabel(container, "取消"));
    check("the clear page's 取消 does not close", spies.close, 0);
    assert("…it returns to the main page", byLabel(container, "目标进行中，编辑目标") !== undefined);
    assert("…and leaves the confirmation", !container.textContent.includes("清除后目标不再续跑"));
  }
}

/* The goal/jobs slot's one panel (T10b) ------------------------------------ */

/**
 * Mount the real slot panel (`makeGoalJobsPopover`) over the real coordinator,
 * the real goal container and the real jobs body. The fake registration
 * records every `update`; `close` is the host's own close, spied.
 */
function mountSlot({ goal = baseGoal, jobs = [], goalAttention = false } = {}) {
  const spies = { close: 0, updates: [], rpc: [] };
  const goalStore = new Map([["agent-1", { goal, available: true, listeners: new Set() }]]);
  const jobsStore = new Map([["agent-1", { jobs, available: true, listeners: new Set() }]]);
  const client = {
    rpc: async (_definition, input) => {
      spies.rpc.push(input);
      return { ok: true, message: "ok" };
    },
  };
  let slot;
  slot = createGoalJobsSlot({
    addComposerPill: (contribution) => {
      spies.contribution = contribution;
      return { update: (patch) => spies.updates.push(patch), remove: () => {} };
    },
    makeContent: (agentId) => makeGoalJobsPopover(slot, agentId),
  });
  const agent = { id: "agent-1", workspaceId: "w" };
  slot.attach("goal", agent, { Content: makeGoalPopover(client, goalStore, "agent-1", async () => {}, () => {}), icon: "GoalIcon", title: "目标" });
  slot.attach("jobs", agent, { Content: makeJobsPopover(jobsStore, "agent-1"), icon: "JobsIcon", title: "后台任务" });
  const liveCount = jobs.filter((job) => job.status === "running" || job.status === "stopping").length;
  const presentGoal = (g, attention) =>
    slot.presentGoal("agent-1", { visible: g !== null, attention, goal: g, label: "目标", title: "目标", icon: "GoalIcon" });
  const presentJobs = (count) =>
    slot.presentJobs("agent-1", { visible: count > 0, live: count > 0, label: count > 0 ? `${count} 个后台` : "后台任务", title: "后台任务", icon: "JobsIcon" });
  presentGoal(goal, goalAttention);
  presentJobs(liveCount);
  const Panel = spies.contribution.button.behavior.Content;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(Panel, {
        theme,
        layout: { compact: true, platform: "web" },
        host: { id: "h", label: "h" },
        context: "agent",
        workspaceId: "w",
        agentId: "agent-1",
        close: () => {
          spies.close += 1;
        },
      }),
    );
  });
  const rerender = (fn) => flushSync(fn);
  return { container, root, spies, slot, presentGoal, presentJobs, goalStore, jobsStore, rerender };
}

const runningJob = { id: "job-1", kind: "bash", label: "sleep 600", status: "running", startedAt: 0, description: "运行完整测试套件" };

async function slotChecks() {
  console.log("\nthe goal/jobs slot's one panel (T10b)");
  {
    // Armed goal + a running job: the trigger shows the jobs, the panel opens
    // on the jobs view with the goal switch row on top.
    const { container, spies, presentJobs, presentGoal, rerender } = mountSlot({ jobs: [runningJob] });
    check("one behavior for the whole slot, registered once", spies.contribution.button.behavior.kind, "popover");
    assert("the panel opens on the jobs view (what the trigger shows)", container.querySelector('[data-testid="goal-jobs-view-jobs"]') !== null);
    assert("…listing the job", container.textContent.includes("运行完整测试套件"));
    const goalRow = container.querySelector('[data-testid="goal-jobs-switch-goal"]');
    assert("the jobs view's top row switches to the goal", goalRow !== null);
    assert("…drawing the whale", goalRow?.querySelector('[data-icon="svg"]') !== null);
    assert("…the objective on one line", (goalRow?.textContent ?? "").includes(baseGoal.objective));
    assert("…and the goal's state line", (goalRow?.textContent ?? "").includes("进行中 · 第 3 轮 · 预算 10"));
    check("…named by state then objective", goalRow?.getAttribute("aria-label"), `目标进行中，${baseGoal.objective}`);
    const updatesBefore = spies.updates.length;
    click(goalRow);
    assert("pressing it switches the panel to the goal view in place", container.querySelector('[data-testid="goal-jobs-view-goal"]') !== null);
    assert("…the real goal panel is drawn", byLabel(container, "目标进行中，编辑目标") !== undefined);
    check("switching views does not close the panel", spies.close, 0);
    check("switching views sends no registration update", spies.updates.length, updatesBefore);
    const jobsRow = container.querySelector('[data-testid="goal-jobs-switch-jobs"]');
    assert("the goal view's top row switches back to the jobs", jobsRow !== null);
    check("…as the way back, naming 「N 个后台」", jobsRow?.getAttribute("aria-label"), "返回，1 个后台");
    assert("…with the terminal glyph and its corner ring", jobsRow?.querySelector('[data-icon="SquareTerminal"]') !== null && jobsRow?.querySelector('[data-testid="pill-corner-ring"]') !== null);
    click(jobsRow);
    assert("…and pressing it returns to the jobs view", container.querySelector('[data-testid="goal-jobs-view-jobs"]') !== null);

    // A flip while the panel is open: the goal blocks. The trigger moves; the
    // view stays; nothing closes and no behavior is sent.
    rerender(() => presentGoal({ ...baseGoal, phase: "blocked" }, true));
    check("the goal blocking while open does not close the panel", spies.close, 0);
    assert("…and does not move the view", container.querySelector('[data-testid="goal-jobs-view-jobs"]') !== null);
    check("…the trigger flipped to the goal", spies.updates.at(-1)?.label, "目标");
    check("no update ever carried a behavior", spies.updates.every((patch) => !("behavior" in patch)), true);
    // The jobs finish while their view is open: the view falls back to the goal.
    rerender(() => presentJobs(0));
    assert("the jobs finishing while their view is open falls back to the goal view", container.querySelector('[data-testid="goal-jobs-view-goal"]') !== null);
    assert("…with no switch row left (nothing else to show)", container.querySelector('[data-testid^="goal-jobs-switch-"]') === null);
    check("…and still no close", spies.close, 0);
    check("…and no visibility change (the goal still holds the slot)", spies.updates.at(-1)?.visible, undefined);
  }
  {
    // A goal that needs the user opens on the goal view, with the jobs row on top.
    const { container, spies } = mountSlot({ goal: { ...baseGoal, phase: "blocked" }, goalAttention: true, jobs: [runningJob] });
    assert("a blocked goal beside running jobs opens on the goal view", container.querySelector('[data-testid="goal-jobs-view-goal"]') !== null);
    const jobsRow = container.querySelector('[data-testid="goal-jobs-switch-jobs"]');
    check("…its top row opens the jobs, named 「1 个后台」", jobsRow?.getAttribute("aria-label"), "1 个后台");
    // The goal panel's own close() behaviour is intact inside the slot.
    click(byLabel(container, "目标受阻，编辑目标"));
    assert("the goal editor opens inside the slot", field(container) !== null);
    click(byLabel(container, "取消"));
    check("the editor's 取消 still closes the panel (UI-v8)", spies.close, 1);
  }
  {
    // Only the goal: no switch row, the goal body alone.
    const { container } = mountSlot({ jobs: [] });
    assert("only a goal: the goal view, no switch row", container.querySelector('[data-testid="goal-jobs-view-goal"]') !== null && container.querySelector('[data-testid^="goal-jobs-switch-"]') === null);
  }

  console.log("\npill icons keep their glyph; the ring sits on the corner (T10b)");
  {
    const mount = (element) => {
      const c = document.createElement("div");
      document.body.appendChild(c);
      flushSync(() => createRoot(c).render(element));
      return c;
    };
    for (const name of ["Users", "Target", "SquareTerminal"]) {
      const running = mount(React.createElement(CornerRingIcon, { name, size: 14, color: "#71717a", running: true, theme }));
      check(`${name} running: the glyph is still drawn`, running.querySelectorAll(`[data-icon="${name}"]`).length, 1);
      check(`${name} running: one corner ring`, running.querySelectorAll('[data-testid="pill-corner-ring"]').length, 1);
      const ring = running.querySelector('[data-testid="pill-corner-ring"]');
      const style = ring?.getAttribute("style") ?? "";
      assert(`${name}: the ring frame is 9px at the bottom-right, inside the 16px box`, /width:\s*9px/.test(style) && /right:\s*-1px/.test(style) && /bottom:\s*-1px/.test(style), style);
      const idle = mount(React.createElement(CornerRingIcon, { name, size: 14, color: "#71717a", running: false, theme }));
      check(`${name} idle: the glyph`, idle.querySelectorAll(`[data-icon="${name}"]`).length, 1);
      check(`${name} idle: no ring`, idle.querySelectorAll('[data-testid="pill-corner-ring"]').length, 0);
    }
    // The icon component's own frame is exactly `size`, ring or no ring: the
    // host gives every plugin icon a 16px box and an 8px gap to the label, so a
    // frame wider than `size` would add a gap of our own. The ring is
    // absolutely placed.
    for (const running of [true, false]) {
      for (const size of [14, 16]) {
        const box = mount(React.createElement(CornerRingIcon, { name: "Users", size, color: "#71717a", running, theme })).firstElementChild;
        const style = box?.getAttribute("style") ?? "";
        assert(`CornerRingIcon frame is ${size}×${size} (running=${running})`, new RegExp(`width:\\s*${size}px`).test(style) && new RegExp(`height:\\s*${size}px`).test(style) && !/padding|margin/.test(style), style);
      }
    }
    const ringed = mount(React.createElement(CornerRingIcon, { name: "Users", size: 14, color: "#71717a", running: true, theme }));
    assert("the corner ring is out of flow (cannot widen the frame)", /position:\s*absolute/.test(ringed.querySelector('[data-testid="pill-corner-ring"]')?.getAttribute("style") ?? ""));
    const jobsFrame = mount(React.createElement(JobsPillIcon, { size: 14, color: "#71717a", theme })).firstElementChild;
    assert("the jobs trigger icon frame is 14×14", /width:\s*14px/.test(jobsFrame?.getAttribute("style") ?? "") && /height:\s*14px/.test(jobsFrame?.getAttribute("style") ?? ""), jobsFrame?.getAttribute("style"));
    const jobs = mount(React.createElement(JobsPillIcon, { size: 14, color: "#71717a", theme }));
    check("the jobs trigger icon is the terminal glyph", jobs.querySelectorAll('[data-icon="SquareTerminal"]').length, 1);
    check("…with the corner ring", jobs.querySelectorAll('[data-testid="pill-corner-ring"]').length, 1);
    // The real goal trigger glyph: running keeps the Target under the ring.
    // (`useAgent` is stubbed to "idle" here, so the running state is driven
    // through CornerRingIcon above; this mounts the real component idle.)
    const store = new Map([["agent-1", { goal: { ...baseGoal, phase: "paused" }, available: true, listeners: new Set() }]]);
    const GoalIcon = makeGoalIcon(store, "agent-1");
    const goalIcon = mount(React.createElement(GoalIcon, { size: 14, color: "#71717a", theme, context: "agent", workspaceId: "w", agentId: "agent-1", host: { id: "h", label: "h" }, layout: { compact: true, platform: "web" } }));
    check("the goal trigger draws the Target", goalIcon.querySelectorAll('[data-icon="Target"]').length, 1);
    const goalFrame = goalIcon.firstElementChild?.getAttribute("style") ?? "";
    assert("…in a 14×14 frame", /width:\s*14px/.test(goalFrame) && /height:\s*14px/.test(goalFrame), goalFrame);
  }
}

armChecks
  .then(() => containerChecks())
  .then(() => slotChecks())
  .catch((error) => {
    failures += 1;
    console.error(`  FAIL the container checks threw: ${error instanceof Error ? error.stack : String(error)}`);
  })
  .then(() => {
    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
      console.error(`${failures} FAILED`);
      process.exit(1);
    }
    console.log("OK");
    process.exit(0);
  });
