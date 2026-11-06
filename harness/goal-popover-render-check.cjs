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
export { makeGoalPopover, makeGoalIcon, contributeGoalPill } from ${JSON.stringify(path.join(pluginRoot, "client/goal-pill.tsx"))};
export { SEEN_CLOSE_CONFIRM_MS } from ${JSON.stringify(path.join(pluginRoot, "client/seen-close-gate.ts"))};
export { contributeJobsPill } from ${JSON.stringify(path.join(pluginRoot, "client/jobs-pill.tsx"))};
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
  SEEN_CLOSE_CONFIRM_MS,
  contributeGoalPill,
  contributeJobsPill,
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mount `makeGoalPopover`'s component — the real container with its RPC and
 * mode state — against a fake client. `close` is the host's own close, spied.
 */
function containerProps(spies) {
  return {
    theme,
    layout: { compact: false, platform: "web" },
    host: { id: "h", label: "h" },
    context: "agent",
    workspaceId: "w",
    agentId: "agent-1",
    close: () => {
      spies.close += 1;
    },
  };
}

function mountContainer(answer, goal = baseGoal) {
  const spies = { close: 0, refresh: 0, rpc: [], closed: [] };
  const store = new Map([["agent-1", { goal, available: true, listeners: new Set() }]]);
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
    root.render(React.createElement(Popover, containerProps(spies)));
  });
  return { container, root, spies, Popover };
}

/**
 * A fresh root for the **same** container component: what the host does when its
 * surface remounts the body (its own open-time remount). The gate lives in the
 * container's closure, so a new root is exactly what the host hands it.
 */
function remountContainer(Popover, spies) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(React.createElement(Popover, containerProps(spies))));
  return { container, root };
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
    // A close is confirmed, not read off one unmount (`./seen-close-gate`): the
    // report lands only after the window, so a host remount can never fake it.
    flushSync(() => root.unmount());
    check("a close is not reported before the confirmation window elapses", spies.closed.length, 0);
    await sleep(SEEN_CLOSE_CONFIRM_MS + 80);
    check("closing reports the goal it showed", spies.closed.length, 1);
    check("…which is not complete, so nothing is marked seen", spies.closed[0]?.phase, "active");
  }

  {
    // The desktop completed-goal pill used to vanish on open: the host unmounts
    // and remounts the body once when the surface's position lands
    // (`menu-overlay.tsx:350`), and that unmount was read as the user closing it.
    const done = { ...baseGoal, phase: "complete", activation: "disarmed", currentTask: undefined };
    const first = mountContainer({ ok: true, message: "ok" }, done);
    flushSync(() => first.root.unmount()); // the measuring unmount
    const second = remountContainer(first.Popover, first.spies); // the placed render
    await sleep(SEEN_CLOSE_CONFIRM_MS + 80);
    check("the host's open-time remount is not a close", first.spies.closed.length, 0);
    flushSync(() => second.root.unmount()); // the user really closes the panel
    check("…a real close is not reported before the window elapses", first.spies.closed.length, 0);
    await sleep(SEEN_CLOSE_CONFIRM_MS + 80);
    check("a real close reports the goal it showed, exactly once", first.spies.closed.length, 1);
    check("…with the completed goal", first.spies.closed[0]?.phase, "complete");
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

/* The goal and the jobs are two separate pills ---------------------------- */

const runningJob = { id: "job-1", kind: "bash", label: "sleep 600", status: "running", startedAt: 0, description: "运行完整测试套件" };

/**
 * The real `contributeGoalPill` and `contributeJobsPill` over a fake host: the
 * fake `addComposerPill` records every registration and its `update`s, the
 * fake RPCs answer the scripted scene, and the agent directory delivers one
 * agent. The pollers' own timers run, sped up 100× for this section only.
 *
 * The shared goal/jobs slot (one registration per agent, a coordinator and an
 * in-panel view switch) was withdrawn on 2026-11-05; these checks pin that
 * each half is its own pill again, with its own popover, and that the two
 * kept changes hold: the jobs trigger says 「后台」 in every state, and its
 * live icon is the terminal glyph with the corner ring.
 */
async function separatePillChecks() {
  console.log("\nthe goal and the jobs are two separate composer pills");
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delayMs, ...rest) => realSetTimeout(callback, Math.ceil((delayMs ?? 0) / 100), ...rest);
  const pause = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
  // Wait until the pollers have delivered what the scene now says (or 3s).
  // Fixed pauses raced the backoff after an unreadable answer (8s base, 80ms
  // here); a condition that never holds still fails its check below.
  const until = async (condition) => {
    for (let waited = 0; waited < 3000 && !condition(); waited += 10) await pause(10);
  };
  const regs = [];
  const scene = { goal: baseGoal, jobs: { available: true, jobs: [runningJob] } };
  const agent = { id: "agent-1", workspaceId: "w", status: "idle" };
  const client = {
    rpc: async (definition) => {
      if (definition.name === "goal.current") return { available: true, goal: scene.goal };
      if (definition.name === "jobs.list") return scene.jobs;
      return { ok: true, message: "ok" };
    },
    addComposerPill: (contribution) => {
      const reg = { contribution, updates: [], removed: 0 };
      reg.update = (patch) => reg.updates.push(patch);
      reg.remove = () => {
        reg.removed += 1;
      };
      regs.push(reg);
      return reg;
    },
    paseo: {
      agents: {
        list: async (options) =>
          options?.subscribe !== undefined
            ? { subscription: { subscribe: (handler) => handler.snapshot({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }) } }
            : { entries: [], pageInfo: { hasMore: false, nextCursor: null } },
      },
    },
  };
  const cleanups = [contributeJobsPill(client), contributeGoalPill(client)];
  try {
    await until(() => regs.length >= 2 && regs.every((reg) => reg.updates.some((patch) => patch.visible === true)));
    const byId = (id) => regs.filter((reg) => reg.contribution.id === id);
    const merged = (reg) => {
      const out = { ...reg.contribution.button };
      for (const patch of reg.updates) Object.assign(out, patch);
      return out;
    };
    check("one agent gets exactly two registrations", regs.length, 2);
    check("…one is the goal pill (dsh-goal)", byId("dsh-goal").length, 1);
    check("…the other is the jobs pill (dsh-jobs)", byId("dsh-jobs").length, 1);
    const goalReg = byId("dsh-goal")[0];
    const jobsReg = byId("dsh-jobs")[0];
    if (goalReg === undefined || jobsReg === undefined) throw new Error("a pill was not registered");
    check("both are for the agent", `${goalReg.contribution.agentId}|${jobsReg.contribution.agentId}`, "agent-1|agent-1");
    assert("each opens its own popover", goalReg.contribution.button.behavior.kind === "popover" && jobsReg.contribution.button.behavior.kind === "popover" && goalReg.contribution.button.behavior.Content !== jobsReg.contribution.button.behavior.Content);
    check("no update ever carries a behavior", [...goalReg.updates, ...jobsReg.updates].some((patch) => "behavior" in patch), false);

    // Both present: both visible side by side.
    check("goal + running job: the goal pill is visible", merged(goalReg).visible, true);
    check("…labelled 目标", merged(goalReg).label, "目标");
    check("goal + running job: the jobs pill is visible too", merged(jobsReg).visible, true);
    check("…labelled exactly 后台 (no count)", merged(jobsReg).label, "后台");
    check("…titled 后台任务", merged(jobsReg).title, "后台任务");
    check("…its live icon is the terminal glyph with the corner ring", merged(jobsReg).icon, JobsPillIcon);
    check("…registered with that icon from the start (no static flash)", jobsReg.contribution.button.icon, JobsPillIcon);

    // Three running: still 「后台」, no count anywhere on the trigger.
    scene.jobs = { available: true, jobs: [runningJob, { ...runningJob, id: "job-2" }, { ...runningJob, id: "job-3", status: "stopping" }] };
    // The label does not change, so this answer sends no update to wait on;
    // give the pollers several periods (40ms each here) to deliver it.
    await pause(200);
    check("three live jobs: the jobs label is still 后台", merged(jobsReg).label, "后台");
    check("…no jobs patch ever carried a digit in its label", jobsReg.updates.some((patch) => typeof patch.label === "string" && /\d/.test(patch.label)), false);

    // The jobs finish: only the jobs pill hides; the goal pill is untouched.
    const goalUpdatesBefore = goalReg.updates.length;
    scene.jobs = { available: true, jobs: [{ ...runningJob, status: "completed" }] };
    await until(() => merged(jobsReg).visible === false);
    check("the jobs finishing hides the jobs pill", merged(jobsReg).visible, false);
    check("…and sends the goal pill nothing", goalReg.updates.length, goalUpdatesBefore);
    check("…which stays visible", merged(goalReg).visible, true);

    // An unreadable registry: visible (the popover explains), static terminal glyph, still 「后台」.
    scene.jobs = { available: false, jobs: [], error: "registry offline" };
    await until(() => merged(jobsReg).visible === true);
    check("an unreadable registry shows the jobs pill", merged(jobsReg).visible, true);
    check("…with the static terminal glyph", merged(jobsReg).icon, "SquareTerminal");
    check("…labelled 后台", merged(jobsReg).label, "后台");

    // The goal clears while jobs run: only the goal pill hides.
    scene.jobs = { available: true, jobs: [runningJob] };
    scene.goal = null;
    await until(() => merged(goalReg).visible === false && merged(jobsReg).icon === JobsPillIcon);
    check("the goal clearing hides the goal pill", merged(goalReg).visible, false);
    check("…while the jobs pill stays", merged(jobsReg).visible, true);
    check("…with the ringed icon back", merged(jobsReg).icon, JobsPillIcon);

    const mountContent = (reg) => {
      const Content = reg.contribution.button.behavior.Content;
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      flushSync(() => {
        root.render(
          React.createElement(Content, {
            theme,
            layout: { compact: true, platform: "web" },
            host: { id: "h", label: "h" },
            context: "agent",
            workspaceId: "w",
            agentId: "agent-1",
            close: () => {},
          }),
        );
      });
      return { container, root };
    };
    // The jobs popover is the jobs list alone.
    {
      const { container, root } = mountContent(jobsReg);
      assert("the jobs popover lists the job", container.textContent.includes("运行完整测试套件"));
      assert("…and draws no goal row", !container.textContent.includes(baseGoal.objective) && container.querySelector('[data-icon="svg"]') === null);
      flushSync(() => root.unmount());
    }

    // A completed goal: shown once, and closing its own popover marks it seen.
    scene.goal = { ...baseGoal, phase: "complete", activation: "disarmed" };
    await until(() => merged(goalReg).visible === true);
    check("a completed goal shows the goal pill once more", merged(goalReg).visible, true);
    {
      const { container, root } = mountContent(goalReg);
      assert("the goal popover is the goal panel alone", container.textContent.includes(baseGoal.objective) && !container.textContent.includes("运行完整测试套件"));
      flushSync(() => root.unmount());
      check("…the hide is not immediate (a host remount must not fake a close)", merged(goalReg).visible, true);
      await sleep(SEEN_CLOSE_CONFIRM_MS + 80);
    }
    check("closing the goal popover marks the completed goal seen (the pill hides)", merged(goalReg).visible, false);
    check("…the jobs pill is unaffected", merged(jobsReg).visible, true);
  } finally {
    for (const cleanup of cleanups) cleanup();
    global.setTimeout = realSetTimeout;
  }
  check("disposing removes both registrations", regs.map((reg) => reg.removed).join(","), "1,1");
}

function iconChecks() {
  console.log("\npill icons keep their glyph; the ring sits on the corner");
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
    // The glyph's horizontal centre inside the host's icon box. The host
    // draws a composer pill's icon at size 14 in a 16px box that centres its
    // child (Paseo 0.15.0 \`plugins/buttons/view.tsx\` ButtonIcon + styles.icon);
    // read both numbers from the host source, then place our frame and glyph by
    // their own styles. Any margin/left/transform on the frame, or a frame wider
    // than the glyph, moves the glyph off the box centre.
    {
      const hostView = fs.readFileSync(path.join(hostApp, "packages/app/src/plugins/buttons/view.tsx"), "utf8");
      const box = /icon:\s*\{\s*width:\s*(\d+),\s*height:\s*\d+,\s*alignItems:\s*"center",\s*justifyContent:\s*"center"/.exec(hostView);
      const composerSize = /placement === "composer" \? (\d+) : \d+/.exec(hostView);
      assert("host: the plugin icon box is a centring box of fixed width", box !== null);
      assert("host: composer icons are drawn at a fixed size", composerSize !== null);
      const boxW = Number(box?.[1] ?? NaN);
      const size = Number(composerSize?.[1] ?? NaN);
      const px = (style, prop) => {
        const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`).exec(style);
        return m === null ? 0 : Number(m[1]);
      };
      for (const [what, element] of [
        ["team running (Users + ring)", React.createElement(CornerRingIcon, { name: "Users", size, color: "#71717a", running: true, theme })],
        ["team idle (Users)", React.createElement(CornerRingIcon, { name: "Users", size, color: "#71717a", running: false, theme })],
        ["goal (Target)", React.createElement(CornerRingIcon, { name: "Target", size, color: "#71717a", running: false, theme })],
        ["jobs (SquareTerminal + ring)", React.createElement(JobsPillIcon, { size, color: "#71717a", theme })],
      ]) {
        const host = mount(element);
        const frame = host.firstElementChild;
        const fs_ = frame?.getAttribute("style") ?? "";
        const frameW = px(fs_, "width");
        // The box centres the frame; our own offsets then move it.
        const frameLeft = (boxW - frameW) / 2 + px(fs_, "margin-left") - px(fs_, "margin-right") + px(fs_, "left") - px(fs_, "right");
        const transformed = /transform|translate/.test(fs_);
        const glyph = frame?.querySelector("svg");
        const glyphW = Number(glyph?.getAttribute("width") ?? NaN);
        // The glyph sits at the frame's left edge (the Icon wrapper adds no offset).
        const wrap = glyph?.parentElement?.getAttribute("style") ?? "";
        const glyphLeft = frameLeft + px(wrap, "margin-left") + px(wrap, "left") + px(wrap, "padding-left");
        const offset = glyphLeft + glyphW / 2 - boxW / 2;
        assert(`${what}: glyph centre within 0.5px of the host icon box centre (offset ${offset.toFixed(2)}px)`,
          Number.isFinite(offset) && Math.abs(offset) <= 0.5 && !transformed, `frame=${fs_} glyph=${glyphW}`);
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
  .then(() => separatePillChecks())
  .then(() => iconChecks())
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
