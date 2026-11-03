/**
 * Offline behaviour check for the goal popover's rendered DOM.
 *
 * The popover is the place the user's iOS report was about: "tapping 编辑 shows
 * no edit box". A source regex cannot prove an edit box appears, that it
 * pre-fills the objective, that Save is disabled while the field is empty, that
 * clear takes two clicks, or that the panel contains no filled/bordered button
 * chrome. This script renders the **real** `GoalPopoverBody` through
 * `react-native-web` into jsdom and asserts exactly those behaviours.
 *
 * The bundle is built on the fly with esbuild (from the host's node_modules); the
 * host UI kit's `Icon` and `TextInput` are stood in for by a tiny stub that maps
 * `TextInput` to react-native-web's real input and `Icon` to an inline SVG span —
 * the same seam the preview uses. No network, no DSH, no Paseo daemon.
 *
 * Run (from paseo-plugin):
 *   cd paseo-plugin
 *   node ../harness/goal-popover-render-check.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const here = __dirname;
const repoRoot = path.resolve(here, "..");
const pluginRoot = path.join(repoRoot, "paseo-plugin");
const hostModules = "/home/yywl/apps/paseo/node_modules";
const work = path.join(repoRoot, "paseo-plugin", ".dbg-popover-render");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const stub = path.join(work, "ui-stub.tsx");
fs.writeFileSync(
  stub,
  `import { TextInput } from "react-native";
export { TextInput };
export function Icon({ name, size }: { name?: string; size?: number }) {
  return <span data-icon={name} style={{ display: "inline-flex", width: size ?? 14, height: size ?? 14 }} />;
}
`,
);

const entry = path.join(work, "entry.tsx");
fs.writeFileSync(
  entry,
  `export { GoalPopoverBody } from ${JSON.stringify(path.join(pluginRoot, "client/goal-popover.tsx"))};
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
  alias: {
    "react-native": "react-native-web",
    "@getpaseo/plugin/client/ui": stub,
  },
  loader: { ".tsx": "tsx", ".ts": "ts" },
  logLevel: "warning",
});

const { JSDOM } = require(path.join(hostModules, "jsdom"));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "http://localhost/",
});
global.window = dom.window;
global.document = dom.window.document;
// Node 22 exposes `navigator` as a getter-only global; define it over the DOM one.
Object.defineProperty(global, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
global.IS_REACT_ACT_ENVIRONMENT = true;
// react-native-web touches browser globals at require time (StyleSheet's
// ShadowRoot check); expose the jsdom implementations on `global`.
for (const name of ["ShadowRoot", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle"]) {
  if (dom.window[name] !== undefined) global[name] = dom.window[name];
}

// One React copy: the bundle carries react, react-dom and react-native-web
// together, so the renderer and the components share the same dispatcher.
const bundled = require(path.join(work, "bundle.cjs"));
const { GoalPopoverBody, createRoot, createElement, flushSync } = bundled;
const React = { createElement };

const text = {
  title: "目标",
  running: "目标进行中",
  notRunning: "目标未在续跑",
  paused: "目标已暂停",
  blocked: "目标受阻",
  statuses: { active: "进行中", paused: "已暂停", blocked: "受阻", complete: "已完成" },
  rounds: (started, max) => `第 ${String(started)} 轮 · 预算 ${String(max)}`,
  currentTask: (content) => `正在：${content}`,
  blocker: (code, message) => `受阻原因：${code} — ${message}`,
  disarmedHint: "重开会话或进程重启后，自动续跑会停止，点「继续」恢复。",
  actions: {
    pause: "暂停",
    resume: "继续",
    edit: "编辑目标",
    clear: "清除目标",
    confirmClear: "确认清除",
    save: "保存",
    cancel: "取消",
  },
  editPlaceholder: "新的目标内容",
  busy: "处理中…",
  controlFailed: "目标命令执行失败。",
  unavailable: "读不到本会话的目标。",
  noGoal: "当前没有目标。",
  footnote: "运行中发消息会插入当前轮，不打断目标；停止会暂停目标。",
};

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
  objective: "持续把 dist 目录的构建产物清理干净，并在每轮结束时追加一行构建日志",
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

function render(props) {
  // A fresh container per render: react-dom warns (and can misbehave) when a
  // second root mounts on a container that already had one.
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
        compact: false,
        busy: false,
        error: undefined,
        clearArmed: props.clearArmed ?? false,
        editing: props.editing ?? false,
        draft: props.draft ?? "",
        onAction: props.onAction ?? (() => {}),
        onChangeDraft: props.onChangeDraft ?? (() => {}),
        onSubmitEdit: props.onSubmitEdit ?? (() => {}),
        onCancelEdit: props.onCancelEdit ?? (() => {}),
        onCancelClear: props.onCancelClear ?? (() => {}),
      }),
    );
  });
  return container;
}

/** A button-ish element by visible text. */
function byText(container, label) {
  return [...container.querySelectorAll('[role="button"], button')].find(
    (node) => node.textContent.trim() === label,
  );
}

function click(node) {
  flushSync(() => {
    node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Inline styles of every role=button element. */
function buttonStyles(container) {
  return [...container.querySelectorAll('[role="button"]')].map((node) => ({
    text: node.textContent.trim(),
    style: node.getAttribute("style") ?? "",
  }));
}

console.log("the panel renders as Paseo rows (no button chrome)");
{
  const container = render({});
  const styles = buttonStyles(container);
  assert("the panel has action rows", styles.length >= 3, JSON.stringify(styles.map((row) => row.text)));
  for (const row of styles) {
    const declarations = Object.fromEntries(
      row.style
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => {
          const at = part.indexOf(":");
          return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
        }),
    );
    const borderWidth = declarations["border-width"] ?? declarations["border-top-width"];
    const fill = declarations["background-color"];
    assert(
      `row "${row.text}" has no border`,
      borderWidth === undefined || borderWidth === "0px",
      row.style,
    );
    assert(
      `row "${row.text}" has no fill`,
      fill === undefined || fill === "transparent" || fill === "rgba(0, 0, 0, 0)",
      row.style,
    );
  }
  check("the objective is drawn as one line", container.textContent.includes(baseGoal.objective), true);
  check("the status line joins phase and budget", container.textContent.includes("进行中 · 第 3 轮 · 预算 10"), true);
  check("the now line is drawn", container.textContent.includes("正在：清理 node_modules 中的缓存目录"), true);
  assert("the edit row reads 编辑目标", byText(container, "编辑目标") !== undefined);
  assert("the clear row reads 清除目标", byText(container, "清除目标") !== undefined);
}

console.log("\nopening the edit row renders a pre-filled, editable field");
{
  let editCalls = 0;
  const container = render({ onAction: (action) => { if (action === "edit") editCalls += 1; } });
  click(byText(container, "编辑目标"));
  check("tapping the edit row asks the container to open it", editCalls, 1);

  const editing = render({ editing: true, draft: baseGoal.objective });
  const input = editing.querySelector("input");
  assert("the edit row renders a real input", input !== null);
  check("the input is pre-filled with the full objective", input.value, baseGoal.objective);
  check("the input is a single-line field", input.tagName.toLowerCase() === "input", true);
  assert("the edit row has a save action", byText(editing, "保存") !== undefined);
  assert("the edit row has a cancel action", byText(editing, "取消") !== undefined);
}

console.log("\nsave calls the edit callback; an empty draft cannot be saved");
{
  let saved = 0;
  const container = render({
    editing: true,
    draft: baseGoal.objective,
    onSubmitEdit: () => { saved += 1; },
  });
  click(byText(container, "保存"));
  check("tapping save calls the edit callback", saved, 1);

  let emptySaved = 0;
  const empty = render({
    editing: true,
    draft: "   ",
    onSubmitEdit: () => { emptySaved += 1; },
  });
  const save = byText(empty, "保存");
  assert("save is disabled while the draft is blank", save.getAttribute("aria-disabled") === "true", save.outerHTML);
  click(save);
  check("clicking disabled save does not submit", emptySaved, 0);
}

console.log("\nclear takes two clicks and turns red only when armed");
{
  let clears = 0;
  const container = render({ onAction: (action) => { if (action === "clear") clears += 1; } });
  click(byText(container, "清除目标"));
  check("the first click asks the container to arm", clears, 1);
  check("the unarmed clear row is not red", !/color:\s*#9d433b|color:\s*rgb\(157, 67, 59\)/.test(container.innerHTML), true);

  let armedClears = 0;
  let cancels = 0;
  const armed = render({
    clearArmed: true,
    onAction: (action) => { if (action === "clear") armedClears += 1; },
    onCancelClear: () => { cancels += 1; },
  });
  const confirm = byText(armed, "确认清除");
  assert("the armed row reads 确认清除", confirm !== undefined);
  check("the armed row is red", /color:\s*#9d433b|color:\s*rgb\(157, 67, 59\)/.test(confirm.outerHTML), true);
  click(confirm);
  check("the second click executes the clear", armedClears, 1);
  click(byText(armed, "取消"));
  check("cancel leaves the armed state", cancels, 1);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log("OK");
process.exit(0);
