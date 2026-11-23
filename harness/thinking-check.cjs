/**
 * Offline assertions for the collapsed reasoning preview.
 *
 * The row used to preview the *last* line of the thought — the one it happened
 * to end on. DSH previews the *first* line once settled, and the first line of
 * the latest completed paragraph while streaming. That difference is invisible
 * in a unit test of the component but obvious to a reader, so the rule lives in
 * a pure module (`client/thinking-text.ts`) and is asserted here.
 *
 * Run (from paseo-plugin):
 *   npx tsc client/thinking-text.ts client/inline-thinking.tsx \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --jsx react-jsx --skipLibCheck --noCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/thinking-check.cjs .dbg/
 *   cd .dbg && node thinking-check.cjs
 *
 * `inline-thinking.tsx` comes along for the state-transition check at the end:
 * it executes the real component with a minimal hooks dispatcher (the artifact
 * is what runs, not a copy of the logic). `--noCheck` is required for the
 * emit, not to skip this repo's type gate: that component's
 * `@getpaseo/plugin/client` type import only resolves under the project's own
 * `moduleResolution: Bundler` (`paseo-plugin/tsconfig.json`), so the plain
 * `tsc --noEmit` is the type check and this command only needs to emit JS.
 */
"use strict";

const { readFileSync, existsSync } = require("node:fs");
const { dirname, join } = require("node:path");
const {
  advanceEm,
  firstLine,
  formatThinkingDuration,
  latestCompletedParagraphFirstLine,
  parseInlineRuns,
  parseThinkingSections,
  reasoningPreview,
  streamingTail,
  thinkingHeadline,
  thinkingPeekTail,
} = require("./client/thinking-text.js");

/**
 * Load a sibling harness module from wherever this check runs.
 *
 * The documented compile step copies this file into `paseo-plugin/.dbg`, so a
 * plain `require("./source-shape.cjs")` would not resolve there — the module
 * lives in `harness/`, which is a different directory. Walking up from
 * `__dirname` finds the repo's `harness/` directory in both cases (run in place
 * from `harness/`, or copied into a build dir under `paseo-plugin/`).
 */
function requireHarnessModule(name) {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "harness", name);
    if (existsSync(candidate)) return require(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find harness/${name} above ${__dirname}`);
}

const { attributeOf, callArguments, elementWithAttributes, elementsWithAttributes, mentions, splitArguments } =
  requireHarnessModule("source-shape.cjs");

/**
 * Locate a repo source file from wherever this check runs. The documented
 * compile step copies the check into `paseo-plugin/.dbg` (one level below
 * `paseo-plugin`), but a scratch build dir such as `.tmp-test/<name>` sits one
 * level deeper; walking up finds the source either way instead of failing on
 * `__dirname/..`.
 */
function findRepoFile(relative, levels = 4) {
  let dir = __dirname;
  for (let i = 0; i < levels; i += 1) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const INLINE_THINKING_SOURCE = findRepoFile("client/inline-thinking.tsx");
if (INLINE_THINKING_SOURCE === undefined) {
  console.error(`could not find paseo-plugin/client/inline-thinking.tsx above ${__dirname}`);
  process.exit(1);
}

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

console.log("firstLine");
{
  check("everything before the first newline", firstLine("one\ntwo\nthree") === "one");
  check("the whole string when there is no newline", firstLine("only") === "only");
  check("an empty string stays empty", firstLine("") === "");
  check("a leading newline yields empty", firstLine("\nsecond") === "");
}

console.log("latestCompletedParagraphFirstLine");
{
  // A paragraph counts once its first line is terminated by a newline, so the
  // preview advances a paragraph at a time rather than on every token — and it
  // takes the *last* such paragraph, whether or not it is the final one.
  check(
    "the first line of the last paragraph whose first line ended",
    latestCompletedParagraphFirstLine("p1 first\np1 second\n\np2 first\np2 second") === "p2 first",
  );
  check(
    "an unterminated final paragraph does not win",
    latestCompletedParagraphFirstLine("p1 first\np1 second\n\np2 first\n") === "p2 first",
  );
  check(
    "a single unterminated paragraph has nothing yet",
    latestCompletedParagraphFirstLine("still typing") === "",
  );
  check(
    "a single terminated line is the summary",
    latestCompletedParagraphFirstLine("done\n") === "done",
  );
  check(
    "blank-line runs separate paragraphs",
    latestCompletedParagraphFirstLine("a\n\n\n\nb\n") === "b",
  );
  check(
    "carriage returns are understood",
    latestCompletedParagraphFirstLine("a\r\n\r\nb\r\n") === "b",
  );
  check(
    "indented blank lines separate too",
    latestCompletedParagraphFirstLine("a\n \t \nb\n") === "b",
  );
  check("empty input yields empty", latestCompletedParagraphFirstLine("") === "");
}

console.log("the preview the row actually shows");
{
  // The regression this file exists for: settled must preview the beginning.
  check(
    "settled previews the first line, not the last",
    reasoningPreview("first line\nmiddle\nlast line", false) === "first line",
  );
  check(
    "streaming previews the latest completed paragraph",
    reasoningPreview("p1 first\np1 rest\n\np2 first\np2 rest\n", true) === "p2 first",
  );
  check(
    "a settled single-line thought is itself",
    reasoningPreview("just one line", false) === "just one line",
  );
  check(
    "emphasis markers are stripped",
    reasoningPreview("**bold** start\nrest", false) === "bold start",
  );
  check(
    "the settled preview never returns the tail",
    reasoningPreview("alpha\nbeta\ngamma", false) !== "gamma",
  );
}

console.log("the preview is computed from the text as it arrives");
{
  // The collapsed row used to read `useRevealedText(text, phase)` — a host hook
  // that re-plays the reasoning at a rate it owns (its signature takes no speed).
  // The expanded view always read the raw text, so the two disagreed: expanding
  // looked fast, collapsing trailed. dsh web runs the preview rule over the live
  // text, which is what this asserts.
  //
  // Asserted from the source because it is a wiring property inside a React
  // component, which plain `node` cannot `require`. The claim is "some call in
  // this module passes `text`", read through a real argument scan rather than a
  // whitespace-sensitive regex: `reasoningPreview(\n  text,\n  growing,\n)` is
  // the same wiring as the one-line form and used to fail here.
  const source = readFileSync(INLINE_THINKING_SOURCE, "utf8");
  // Comment lines are dropped first: the module header explains the hook by name.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  check(
    "the row no longer paces its text through useRevealedText",
    !/^\s*import[^\n]*useRevealedText/m.test(code) && !/\buseRevealedText\s*\(/.test(code),
    `${(code.match(/useRevealedText/g) ?? []).length} reference(s) in the code`,
  );
  const callArgs = (name) => callArguments(code, name);
  const previewArgs = callArgs("reasoningPreview");
  check(
    "and the collapsed line previews the item's own text",
    previewArgs.some((args) => mentions(args, "text")),
    previewArgs.map((args) => `reasoningPreview(${args.trim()})`).join(" | ") || "(no call found)",
  );
  const growingArgs = callArgs("useGrowing");
  check(
    "and `growing` is derived from that same text",
    growingArgs.some((args) => mentions(args, "text")),
    growingArgs.map((args) => `useGrowing(${args.trim()})`).join(" | ") || "(no call found)",
  );
}

console.log("the tail window the collapsed line shows while streaming");
{
  // The window is measured in ems, not characters: counting every character as
  // one em left an all-Latin tail at ~58% of the line and a mixed one at ~65%,
  // which read as "the line got shorter".
  check("CJK is one em wide", advanceEm("中") === 1, String(advanceEm("中")));
  check("and Latin is about half", advanceEm("a") === 0.55, String(advanceEm("a")));

  const ems = (text) => [...text].reduce((sum, ch) => sum + advanceEm(ch), 0);
  const budget = 250 / 13;

  check("no width yields no text", streamingTail("abc", 0, 13) === "", JSON.stringify(streamingTail("abc", 0, 13)));
  check("no font size yields no text", streamingTail("abc", 250, 0) === "", JSON.stringify(streamingTail("abc", 250, 0)));
  check(
    "a short thought is shown whole, unmarked",
    streamingTail("短句", 250, 13) === "短句",
    streamingTail("短句", 250, 13),
  );

  const cjk = streamingTail("这是一段很长的中文推理内容用来测试尾部窗口的填充效果", 250, 13);
  const latin = streamingTail("this is a long english reasoning snippet used to test fill", 250, 13);
  const mixed = streamingTail("这里 mixed 中文 and English 混排 test 内容再加长一点点", 250, 13);
  check("an over-long thought is marked as still arriving", cjk.endsWith("…"), cjk);
  for (const [name, window] of [["CJK", cjk], ["latin", latin], ["mixed", mixed]]) {
    const fill = ems(window) / budget;
    check(
      `a ${name} tail fills the line${name === "CJK" ? "" : " even though the glyphs are narrow"}`,
      fill > 0.85 && fill <= 1.02,
      `${(fill * 100).toFixed(0)}% of the budget`,
    );
  }
  check(
    "the window never overflows the line",
    ems(streamingTail("x".repeat(500), 250, 13)) <= budget + 0.01,
    String(ems(streamingTail("x".repeat(500), 250, 13))),
  );
  check(
    "newlines are flattened so the window stays one line",
    streamingTail("aaa\nbbb\nccc", 500, 13) === "aaa bbb ccc",
    JSON.stringify(streamingTail("aaa\nbbb\nccc", 500, 13)),
  );
  check(
    "emphasis markers are stripped here too",
    streamingTail("**bold** 结尾", 500, 13) === "bold 结尾",
    streamingTail("**bold** 结尾", 500, 13),
  );
}

console.log("the row wires the window in");
{
  // The window is worthless if the component neither measures a usable width nor
  // prefers the tail while the thought is still growing.
  //
  // The width must NOT be taken from the line itself: the sweep container is
  // content-sized, so a `flex: 1` child inside it reports its own content width
  // and the window collapses — the desktop client showed two characters. It has
  // to come from the row and the label, which are definite on every platform.
  //
  // These claims are about **which element carries which attributes**, not about
  // how the element is formatted. They used to be whitespace regexes
  // (`/style=\{styles\.row\}\s*\n\s*onLayout=\{/`), which failed on a reordered
  // prop list or a wrapped line while the component was still correct. The JSX
  // reader in `harness/source-shape.cjs` parses the opening element, so order
  // and line breaks no longer matter.
  const source = readFileSync(INLINE_THINKING_SOURCE, "utf8");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  // The measured row: it carries the row style *and* an onLayout handler.
  const row = elementWithAttributes(code, ["style", "onLayout"]);
  const rowStyle = row === undefined ? "" : attributeOf(row, "style").value;
  const rowLayout = row === undefined ? "" : attributeOf(row, "onLayout").value;
  check(
    "the row measures itself, not the line inside the content-sized sweep",
    row !== undefined && mentions(rowStyle, "row") && rowLayout.includes("setRowWidth"),
    row === undefined ? "row measurement is missing" : `tag ${row.tag}, style ${rowStyle.trim()}`,
  );

  // The label is the second measured element: it subtracts its own width.
  const label = elementsWithAttributes(code, ["style", "onLayout"]).find((element) =>
    mentions(attributeOf(element, "onLayout").value, "setLabelWidth"),
  );
  check(
    "and measures the label it has to subtract",
    label !== undefined && mentions(attributeOf(label, "style").value, "label"),
    label === undefined ? "label measurement is missing" : `tag ${label.tag}`,
  );

  // The derivation subtracts the icon and both head gaps from the row width.
  const lineWidth = callArguments(code, "Math.max");
  check(
    "and derives the line width from both",
    lineWidth.some((args) => {
      const parts = splitArguments(args);
      const expression = parts.join(",");
      return mentions(expression, "rowWidth")
        && mentions(expression, "labelWidth")
        && mentions(expression, "THINK_ICON_SIZE")
        && (mentions(expression, "ROW_HEAD_GAP") || mentions(expression, "toolRowGap"));
    }),
    lineWidth.map((args) => `Math.max(${args.trim()})`).join(" | ") || "lineWidth derivation is missing",
  );

  // While growing, the tail window wins over dsh's settled rule. Asserted as a
  // conditional expression that calls both, rather than as its exact spelling.
  const tailCalls = callArguments(code, "streamingTail");
  const previewCalls = callArguments(code, "reasoningPreview");
  check(
    "and shows the tail while growing, dsh's rule otherwise",
    tailCalls.some((args) => {
      const parts = splitArguments(args).map((part) => part.trim());
      return parts.length >= 2 && mentions(parts[0], "text") && mentions(parts[1], "lineWidth");
    }) && previewCalls.some((args) => {
      const parts = splitArguments(args).map((part) => part.trim());
      return parts.length >= 2 && mentions(parts[0], "text") && mentions(parts[1], "growing");
    }),
    tailCalls.map((args) => `streamingTail(${args.trim()})`).join(" | ") || "(no call found)",
  );

  // The preview line must never measure itself: a measured line would feed its
  // own content width back into the window. Asserted over the parsed elements,
  // so `numberOfLines={1}` and `onLayout` on the same element fail regardless of
  // the order they appear in.
  const selfMeasured = elementsWithAttributes(code, ["numberOfLines", "onLayout"]);
  check(
    "the preview line never measures itself",
    selfMeasured.length === 0,
    selfMeasured.length === 0 ? "" : `measured line at ${selfMeasured.map((element) => element.tag).join(", ")}`,
  );
}

console.log("the row settles when the last frame both grows and completes");
{
  // Two opposite failures live here:
  //
  //  * The host usually delivers a thought's last chunk and `complete` in the
  //    same update. The row latches on growth — that is how it keeps scrolling
  //    while chunks arrive — and the old order returned on growth before
  //    reading `phase`, so that frame left the latch on. Nothing re-ran the
  //    effect afterwards (the next render carries the same `[text, phase]`), so
  //    the sweep and the tail preview kept running until an unrelated phase
  //    flip or unmount.
  //  * `phase` is not a reliable terminal signal: the host derives it from a
  //    status that flips loading/ready as chunks settle
  //    (`docs/FIELD-NOTES.md` #26), so settling on a single complete frame
  //    makes the sweep stop and restart mid-thought. The fix settles only
  //    after `complete` has held for a short window, and any further frame
  //    cancels that window.
  //
  // The claims are state transitions across renders and a timer, which neither
  // a pure function nor a source scan can see, so this executes the **real
  // compiled component** with a minimal hooks dispatcher and a fake clock.
  // Offline and deterministic; it is not a native UI test.
  const componentPath = join(__dirname, "client", "inline-thinking.js");
  if (!existsSync(componentPath)) {
    console.error(
      `missing ${componentPath} — compile client/inline-thinking.tsx too (see the run step at the top of this file)`,
    );
    process.exit(1);
  }
  const Module = require("node:module");

  // Fake clock: the settle window is the only timer the component schedules,
  // and the defect was that nothing ever fired to clear the latch.
  let timers = new Map();
  let nextTimerId = 0;
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (callback) => {
    nextTimerId += 1;
    timers.set(nextTimerId, callback);
    return nextTimerId;
  };
  global.clearTimeout = (id) => {
    timers.delete(id);
  };

  // The hook slots live across passes, so `useState` holds its value the way
  // React would; `cursor` restarts every pass because the hook order is fixed.
  let slots = [];
  let cursor = 0;
  let effects = [];
  let changed = false;
  let lastText = "";
  let lastPhase = "complete";
  const sameDeps = (a, b) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (next) => {
          const value = typeof next === "function" ? next(slots[index]) : next;
          if (!Object.is(value, slots[index])) {
            slots[index] = value;
            changed = true;
          }
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const slot = slots[index];
      if (slot !== undefined && sameDeps(slot.deps, deps)) return;
      // The previous cleanup runs before the new effect, as React does.
      slots[index] = { deps, cleanup: slot === undefined ? undefined : slot.cleanup };
      effects.push({ index, effect });
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!(index in slots) || !sameDeps(slots[index].deps, deps)) {
        slots[index] = { deps, value: factory() };
      }
      return slots[index].value;
    },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!(index in slots) || !sameDeps(slots[index].deps, deps)) {
        slots[index] = { deps, value: fn };
      }
      return slots[index].value;
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
  };

  let styleSettingsValues = {
    rowMarginY: 0,
    toolRowPaddingY: 0,
    toolRowMinHeight: 24,
    toolRowGap: 6,
    commandMaxHeightRatio: 0.25,
    commandMinHeight: 150,
  };
  const FULL_COLORS = {
    surface0: "#09090b",
    surface1: "#141418",
    surface2: "#1c1c22",
    border: "#27272a",
    foreground: "#fafafa",
    foregroundMuted: "#a1a1aa",
    accent: "#60a5fa",
    statusSuccess: "#4ade80",
    statusWarning: "#facc15",
    statusDanger: "#f87171",
  };
  let copiedPayloads = [];

  // Stand-ins for the host modules only; `./thinking-text`, `./thinking-styles`,
  // `./thinking-motion`, `./tokens`, `./row-entrance`, `./newest`, and `./locale`
  // are the real compiled modules.
  const stubs = {
    react: () => hooks,
    "react/jsx-runtime": () => ({
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
      Fragment: "Fragment",
    }),
    "react-native": () => ({
      Image: "Image",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      StyleSheet: { hairlineWidth: 0.5 },
      Text: "Text",
      View: "View",
    }),
    "@getpaseo/plugin": () => ({
      defineSettings: (config) => config,
    }),
    "@getpaseo/plugin/client": () => ({
      useSettings: () => ({ status: "ready", values: styleSettingsValues }),
    }),
    "@getpaseo/plugin/client/react-native": () => ({
      copyText: (value) => {
        copiedPayloads.push(value);
        return Promise.resolve();
      },
    }),
    "./text-shimmer": () => ({ TextShimmer: "TextShimmer" }),
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    const stub = stubs[request];
    if (stub !== undefined) return stub();
    return originalLoad.call(this, request, parent, isMain);
  };
  let InlineThinking;
  try {
    ({ InlineThinking } = require(componentPath));
  } finally {
    // Scoped to the load: the component resolves its module graph at require
    // time, so nothing below needs the stubs.
    Module._load = originalLoad;
  }

  /** The sweep's `active` prop, found through the rendered tree. */
  function findShimmerActive(node) {
    if (node === null || typeof node !== "object") return null;
    if (node.type === "TextShimmer") return node.props.active;
    const children = node.props === undefined ? undefined : node.props.children;
    for (const child of Array.isArray(children) ? children : [children]) {
      const answer = findShimmerActive(child);
      if (answer !== null) return answer;
    }
    return null;
  }

  /** One render pass, plus every effect whose deps changed after it. */
  function renderOnce(text, phase) {
    changed = false;
    effects = [];
    cursor = 0;
    const tree = InlineThinking({
      theme: {
        colors: FULL_COLORS,
      },
      layout: { compact: false },
      item: { data: { text, phase } },
    });
    for (const { index, effect } of effects) {
      const slot = slots[index];
      if (typeof slot.cleanup === "function") slot.cleanup();
      const cleanup = effect();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
    return tree;
  }

  function renderToStable(text, phase) {
    let tree = renderOnce(text, phase);
    let passes = 0;
    while (changed && ++passes < 10) tree = renderOnce(text, phase);
    return tree;
  }

  /** What the sweep does after one host frame, without advancing the clock. */
  function update(text, phase) {
    lastText = text;
    lastPhase = phase;
    return findShimmerActive(renderToStable(text, phase));
  }

  /** Advance past the settle window — no host frame is involved. */
  function settle() {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
    return findShimmerActive(renderToStable(lastText, lastPhase));
  }

  /** What React does on unmount: run every effect's cleanup. */
  function unmount() {
    for (const slot of slots) {
      if (slot !== null && typeof slot === "object" && typeof slot.cleanup === "function") {
        slot.cleanup();
        slot.cleanup = undefined;
      }
    }
    return timers.size;
  }

  // One component instance throughout: each `update` is the next frame of the
  // same row, exactly how a thought arrives.
  check("a thought that is still arriving scrolls", update("a", "streaming") === true);
  check("growth while streaming keeps it scrolling", update("ab", "streaming") === true);

  // A single complete frame — the shape a flickering status produces — must
  // not stop the sweep; it only starts the window.
  check("a single complete frame does not settle a growing row", update("ab", "complete") === true);
  check("…it only starts the settle window", timers.size === 1, `${timers.size} timer(s)`);

  // The next chunk cancels the window — the anti-shudder half.
  check("a following chunk keeps it scrolling", update("abc", "streaming") === true);
  check("…and cancels the pending settle", timers.size === 0, `${timers.size} timer(s)`);

  // The defect: the final frame carries both the last chunk and `complete`.
  check(
    "the frame that both grows and completes starts the window",
    update("abcd", "complete") === true,
  );
  check("…and then settles without another host frame", settle() === false);
  check("a settled thought stays settled", update("abcd", "complete") === false);

  // Positive control for the no-growth shape: `complete` with the text
  // unchanged settles through the same window.
  check("growth latches it on again", update("abcde", "streaming") === true);
  check("a complete phase with no new text holds the window", update("abcde", "complete") === true);
  check("…then settles", settle() === false);

  // Cleanup: the window must not outlive its row.
  check(
    "a pending settle window is armed",
    update("abcdef", "complete") === true && timers.size === 1,
    `${timers.size} timer(s)`,
  );
  check("unmount clears the pending window", unmount() === 0, `${timers.size} timer(s)`);

  console.log("expanded body renders in a bounded sibling ScrollView");
  {
    // Reset hooks for a fresh component instance.
    slots = [];
    cursor = 0;
    effects = [];
    changed = false;

    function findNode(node, predicate) {
      if (node === null || typeof node !== "object") return null;
      if (predicate(node)) return node;
      const children = node.props === undefined ? undefined : node.props.children;
      for (const child of Array.isArray(children) ? children : [children]) {
        const hit = findNode(child, predicate);
        if (hit !== null) return hit;
      }
      return null;
    }

    function childArray(node) {
      const c = node?.props?.children;
      return Array.isArray(c) ? c.filter(Boolean) : c ? [c] : [];
    }

    const longThought = "first line\nsecond line\nthird line";
    const collapsedTree = renderToStable(longThought, "complete");
    const rootViewCollapsed = findNode(collapsedTree, (n) => n.type === "View" && n.props?.style?.gap !== undefined);
    const pressableCollapsed = findNode(rootViewCollapsed, (n) => n.type === "Pressable");
    check(
      "collapsed state renders head Pressable without ScrollView",
      pressableCollapsed !== null && findNode(collapsedTree, (n) => n.type === "ScrollView") === null,
    );

    // Clicking the head toggles open.
    pressableCollapsed.props.onPress();
    const expandedTree = renderToStable(longThought, "complete");
    const rootView = findNode(expandedTree, (n) => n.type === "View" && n.props?.style?.gap !== undefined);
    const rootChildren = childArray(rootView);
    const headSibling = rootChildren.find((n) => n.type === "Pressable");
    const bodySibling = rootChildren.find((n) => n.type === "ScrollView");

    check(
      "head Pressable and expanded ScrollView are siblings under root View",
      headSibling !== undefined && bodySibling !== undefined,
    );
    check(
      "ScrollView is not nested inside Pressable",
      findNode(headSibling, (n) => n.type === "ScrollView") === null,
    );
    check(
      "expanded ScrollView enables nestedScrollEnabled and carries scroll-box testID",
      bodySibling?.props?.nestedScrollEnabled === true &&
        bodySibling?.props?.testID === "dsh-scroll-box",
    );
    check(
      "expanded ScrollView defaults maxHeight to 260 when setting is absent",
      bodySibling?.props?.style?.maxHeight === 260,
      String(bodySibling?.props?.style?.maxHeight),
    );
    const bodyText = findNode(bodySibling, (n) => n.type === "Text");
    check(
      "expanded body renders selectable raw text",
      bodyText?.props?.selectable === true && bodyText?.props?.children === longThought,
    );

    // When settings provide `expandedMaxHeight`, the ScrollView adopts it.
    styleSettingsValues = { ...styleSettingsValues, expandedMaxHeight: 340 };
    const resizedTree = renderToStable(longThought, "complete");
    const resizedScroll = findNode(resizedTree, (n) => n.type === "ScrollView");
    check(
      "expanded ScrollView respects style.expandedMaxHeight when present",
      resizedScroll?.props?.style?.maxHeight === 340,
      String(resizedScroll?.props?.style?.maxHeight),
    );

    // Clicking head again collapses the body.
    const headToClose = findNode(resizedTree, (n) => n.type === "Pressable");
    headToClose.props.onPress();
    const recollapsedTree = renderToStable(longThought, "complete");
    check(
      "second head press collapses ScrollView",
      findNode(recollapsedTree, (n) => n.type === "ScrollView") === null,
    );

    // Re-expand and verify tapping inside the expanded ScrollView closes it.
    findNode(recollapsedTree, (n) => n.type === "Pressable").props.onPress();
    const reopenedTree = renderToStable(longThought, "complete");
    const reopenedScroll = findNode(reopenedTree, (n) => n.type === "ScrollView");
    const innerScrollPressable = findNode(reopenedScroll, (n) => n.type === "Pressable");
    check(
      "expanded ScrollView wraps its content in an inner tap-to-collapse Pressable",
      innerScrollPressable !== null && typeof innerScrollPressable.props?.onPress === "function",
    );
    innerScrollPressable.props.onPress();
    const collapsedViaBodyTree = renderToStable(longThought, "complete");
    check(
      "tapping inside expanded ScrollView collapses the thinking row",
      findNode(collapsedViaBodyTree, (n) => n.type === "ScrollView") === null,
    );

    // RowEntrance itself renders cleanly even with the minimal react-native stub
    // (no Platform, Animated, or Easing).
    const RowEntranceFn = expandedTree.type;
    check("InlineThinking wraps output in RowEntrance", typeof RowEntranceFn === "function");
    slots = [];
    cursor = 0;
    effects = [];
    changed = false;
    const entranceOut = RowEntranceFn(expandedTree.props);
    check(
      "RowEntrance falls back to plain View cleanly under minimal RN stub",
      entranceOut?.type === "View" && entranceOut?.props?.children === expandedTree.props.children,
    );

    unmount();
  }

  console.log("InlineThinking participates in newest first-pass batching & uses EXPANDED_MAX_HEIGHT_DEFAULT");
  {
    const {
      resetNewestForTests,
      shouldEnterLive,
    } = require(join(dirname(componentPath), "newest.js"));
    const { EXPANDED_MAX_HEIGHT_DEFAULT } = require(join(dirname(componentPath), "..", "shared", "settings.js"));

    const source = readFileSync(INLINE_THINKING_SOURCE, "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    check(
      "inline-thinking.tsx imports EXPANDED_MAX_HEIGHT_DEFAULT instead of hardcoding 260",
      /\bEXPANDED_MAX_HEIGHT_DEFAULT\b/.test(code) && !/:\s*260\b/.test(code),
    );
    check(
      "EXPANDED_MAX_HEIGHT_DEFAULT equals 260",
      EXPANDED_MAX_HEIGHT_DEFAULT === 260,
      String(EXPANDED_MAX_HEIGHT_DEFAULT),
    );

    const noTsAgent = "thinking-no-timestamp";
    resetNewestForTests(noTsAgent);
    slots = [];
    cursor = 0;
    effects = [];
    changed = false;
    InlineThinking({
      theme: {
        colors: { foreground: "#ffffff", foregroundMuted: "#888888", surface0: "#000000" },
      },
      layout: { compact: false },
      agentId: noTsAgent,
      item: { data: { text: "no ts", phase: "complete" } },
    });
    const baseTs = Date.UTC(2026, 0, 1, 0, 0, 0);
    check(
      "InlineThinking without timestamp does not pollute newest pending batch",
      shouldEnterLive(noTsAgent, baseTs, true, "k-no-ts", baseTs) === true,
    );
    resetNewestForTests(noTsAgent);

    const batchAgent = "thinking-first-pass-batch";
    resetNewestForTests(batchAgent);
    // Render two distinct thinking rows in the same pass: both call noteRender,
    // making pending.fresh.size === 2 so liveHint is suppressed as a replay batch.
    slots = [];
    cursor = 0;
    effects = [];
    changed = false;
    InlineThinking({
      theme: {
        colors: { foreground: "#ffffff", foregroundMuted: "#888888", surface0: "#000000" },
      },
      layout: { compact: false },
      agentId: batchAgent,
      timestamp: baseTs,
      item: { data: { text: "first", phase: "complete" } },
    });
    slots = [];
    cursor = 0;
    effects = [];
    changed = false;
    const secondTree = InlineThinking({
      theme: {
        colors: { foreground: "#ffffff", foregroundMuted: "#888888", surface0: "#000000" },
      },
      layout: { compact: false },
      agentId: batchAgent,
      timestamp: baseTs + 1000,
      item: { data: { text: "second", phase: "streaming" } },
    });
    check(
      "two InlineThinking rows in the first pass trigger multi-row pending suppression",
      shouldEnterLive(batchAgent, baseTs + 2000, true, "k-batch", baseTs + 2000) === false,
    );

    // Verify RowEntrance commit effect marks the row animated via markRowAnimated
    const RowEntranceFn = secondTree.type;
    const strictAgent = "thinking-strict-entrance";
    resetNewestForTests(strictAgent);
    slots = [];
    cursor = 0;
    effects = [];
    changed = false;
    const strictProps = {
      agentId: strictAgent,
      timestamp: baseTs + 500,
      rowKey: "thinking-strict-1",
      liveHint: true,
      children: null,
    };
    RowEntranceFn(strictProps);
    check(
      "before RowEntrance commit effect runs, shouldEnterLive remains true (StrictMode safe)",
      shouldEnterLive(strictAgent, baseTs + 500, true, "thinking-strict-1", baseTs + 500) === true,
    );
    for (const { index, effect } of effects) {
      const cleanup = effect();
      slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
    check(
      "after RowEntrance commit effect runs, same rowKey is marked animated",
      shouldEnterLive(strictAgent, baseTs + 500, true, "thinking-strict-1", baseTs + 500) === false,
    );
    unmount();
    resetNewestForTests(batchAgent);
    resetNewestForTests(strictAgent);
  }

  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
}

console.log("pure parsers for enhanced thinking-row styles");
{
  const structured = "**定位根因**\n先读 `inline-thinking.tsx` 和 **tokens.ts**。\n\n**收敛方案**\n统一用主题 token。";
  const sections = parseThinkingSections(structured);
  check("parseThinkingSections splits explicit bold headings", sections.length === 2);
  check(
    "explicit headings preserve title and body",
    sections[0]?.explicitTitle === true &&
      sections[0]?.title === "定位根因" &&
      sections[0]?.body === "先读 `inline-thinking.tsx` 和 **tokens.ts**。",
    JSON.stringify(sections[0]),
  );
  const plainSections = parseThinkingSections("这是一段很长很长很长很长很长很长没有小标题的思考段落内容\r\n第二行");
  check(
    "implicit paragraph truncates title cleanly by code points without stripping body",
    plainSections.length === 1 &&
      plainSections[0].explicitTitle === false &&
      plainSections[0].title.endsWith("…") &&
      plainSections[0].body.includes("第二行"),
    JSON.stringify(plainSections[0]),
  );
  check("whitespace-only thought parses to empty sections", parseThinkingSections("  \n\n  ").length === 0);

  const runs = parseInlineRuns("读 `tokens.ts` 与 **主题色** 和未闭合 `tail");
  check(
    "parseInlineRuns extracts code, bold, and leaves unclosed delimiters intact",
    runs.length === 5 &&
      runs[0].kind === "text" &&
      runs[1].kind === "code" &&
      runs[1].text === "tokens.ts" &&
      runs[3].kind === "bold" &&
      runs[3].text === "主题色" &&
      runs[4].kind === "text" &&
      runs[4].text.includes("`tail"),
    JSON.stringify(runs),
  );
  const crossLine = parseInlineRuns("`no\nwrap` **also\nno**");
  check(
    "parseInlineRuns never spans across newlines",
    crossLine.every((r) => r.kind === "text") && crossLine.map((r) => r.text).join("") === "`no\nwrap` **also\nno**",
  );

  check("thinkingHeadline settled returns first non-empty line without **", thinkingHeadline(structured, false) === "定位根因");
  check("thinkingHeadline running returns latest explicit heading", thinkingHeadline(structured, true) === "收敛方案");
  check(
    "thinkingHeadline running splits latest clause for plain paragraph",
    thinkingHeadline("第一句。第二句，检查边界；第三句准备落码", true) === "第三句准备落码",
  );
  check("thinkingHeadline returns empty string on blank input", thinkingHeadline("  \n ", true) === "");

  check("thinkingPeekTail keeps short text whole", thinkingPeekTail("短句 **测试**", 20) === "短句 测试");
  const emojiTail = thinkingPeekTail("开始分析 🚀🔥🎯 结论完成", 6);
  check(
    "thinkingPeekTail slices by Unicode code points (no broken surrogate pairs)",
    emojiTail.startsWith("…") && emojiTail.isWellFormed() && emojiTail.includes("🎯"),
    emojiTail,
  );
  check("thinkingPeekTail returns empty on non-positive maxChars", thinkingPeekTail("abc", 0) === "");

  check("formatThinkingDuration suppresses sub-100ms and non-finite values", formatThinkingDuration(0) === "" && formatThinkingDuration(99) === "" && formatThinkingDuration(Number.NaN) === "");
  check("formatThinkingDuration formats seconds to 1 decimal", formatThinkingDuration(2340) === "2.3s");
  check("formatThinkingDuration formats minutes and seconds", formatThinkingDuration(72_400) === "1m 12s");
}

console.log("all 5 enhanced thinking styles execute end-to-end (rail, silk, capsule, stepper, editorial)");
{
  const Module = require("node:module");
  const componentPath = join(__dirname, "client", "inline-thinking.js");
  const COLORS = {
    surface0: "#09090b",
    surface1: "#141418",
    surface2: "#1c1c22",
    border: "#27272a",
    foreground: "#fafafa",
    foregroundMuted: "#a1a1aa",
    accent: "#60a5fa",
    statusSuccess: "#4ade80",
    statusWarning: "#facc15",
    statusDanger: "#f87171",
  };

  function createTreeHarness(rnOverrides = {}) {
    const instances = new Map();
    let currentKey = "root";
    let currentCursor = 0;
    let pendingEffects = [];
    let styleSetting = {
      rowMarginY: 0,
      toolRowPaddingY: 0,
      toolRowMinHeight: 24,
      toolRowGap: 6,
      expandedMaxHeight: 280,
      commandMaxHeightRatio: 0.25,
      commandMinHeight: 150,
      thinkingStyle: "rail",
    };
    const copied = [];
    const sameDeps = (a, b) =>
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    function bucket() {
      if (!instances.has(currentKey)) instances.set(currentKey, { slots: [] });
      return instances.get(currentKey);
    }
    const hooks = {
      useState(init) {
        const b = bucket();
        const i = currentCursor++;
        if (!(i in b.slots)) b.slots[i] = typeof init === "function" ? init() : init;
        return [
          b.slots[i],
          (next) => {
            const val = typeof next === "function" ? next(b.slots[i]) : next;
            b.slots[i] = val;
          },
        ];
      },
      useRef(init) {
        const b = bucket();
        const i = currentCursor++;
        if (!(i in b.slots)) b.slots[i] = { current: init };
        return b.slots[i];
      },
      useEffect(fn, deps) {
        const b = bucket();
        const i = currentCursor++;
        const prev = b.slots[i];
        if (prev !== undefined && sameDeps(prev.deps, deps)) return;
        b.slots[i] = { deps, cleanup: prev?.cleanup };
        pendingEffects.push({ bucket: b, index: i, fn });
      },
      useLayoutEffect(fn, deps) {
        const b = bucket();
        const i = currentCursor++;
        const prev = b.slots[i];
        if (prev !== undefined && sameDeps(prev.deps, deps)) return;
        b.slots[i] = { deps, cleanup: prev?.cleanup };
        pendingEffects.push({ bucket: b, index: i, fn });
      },
      useMemo(fn, deps) {
        const b = bucket();
        const i = currentCursor++;
        const prev = b.slots[i];
        if (prev === undefined || !sameDeps(prev.deps, deps)) {
          b.slots[i] = { deps, value: fn() };
        }
        return b.slots[i].value;
      },
      useCallback(fn, deps) {
        const b = bucket();
        const i = currentCursor++;
        const prev = b.slots[i];
        if (prev === undefined || !sameDeps(prev.deps, deps)) {
          b.slots[i] = { deps, value: fn };
        }
        return b.slots[i].value;
      },
      useSyncExternalStore(_sub, snap) {
        return snap();
      },
    };

    const rnStub = {
      Platform: { OS: "web" },
      Image: "Image",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      StyleSheet: { hairlineWidth: 0.5 },
      Text: "Text",
      View: "View",
      ...rnOverrides,
    };

    const stubs = {
      react: () => hooks,
      "react/jsx-runtime": () => ({
        jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
        jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
        Fragment: "Fragment",
      }),
      "react-native": () => rnStub,
      "@getpaseo/plugin": () => ({ defineSettings: (cfg) => cfg }),
      "@getpaseo/plugin/client": () => ({
        useSettings: () => ({ status: "ready", values: styleSetting }),
      }),
      "@getpaseo/plugin/client/react-native": () => ({
        copyText: (val) => {
          copied.push(val);
          return Promise.resolve();
        },
      }),
    };

    const originalLoad = Module._load;
    const savedCache = new Map();
    for (const k of Object.keys(require.cache)) {
      if (k.includes("/client/")) {
        savedCache.set(k, require.cache[k]);
        delete require.cache[k];
      }
    }
    Module._load = function load(req, parent, isMain) {
      if (stubs[req] !== undefined) return stubs[req]();
      return originalLoad.call(this, req, parent, isMain);
    };
    let InlineThinkingMod;
    try {
      InlineThinkingMod = require(componentPath);
    } finally {
      Module._load = originalLoad;
      for (const k of Object.keys(require.cache)) {
        if (k.includes("/client/") && !savedCache.has(k)) delete require.cache[k];
      }
      for (const [k, v] of savedCache) require.cache[k] = v;
    }

    function expand(node, path = "root") {
      if (node === null || node === undefined || typeof node !== "object") return node;
      if (Array.isArray(node)) return node.map((child, idx) => expand(child, `${path}[${idx}]`));
      if (typeof node.type === "function") {
        const key = `${path}:${node.type.name || "anon"}${node.key !== undefined ? `#${String(node.key)}` : ""}`;
        const prevKey = currentKey;
        const prevCursor = currentCursor;
        currentKey = key;
        currentCursor = 0;
        let out;
        try {
          out = node.type(node.props);
        } finally {
          currentKey = prevKey;
          currentCursor = prevCursor;
        }
        return expand(out, key);
      }
      const nextProps = { ...node.props };
      if (nextProps.children !== undefined) {
        if (typeof nextProps.children === "function") {
          nextProps.children = expand(nextProps.children(null), `${path}.fn`);
        } else {
          nextProps.children = expand(nextProps.children, `${path}.c`);
        }
      }
      return { ...node, props: nextProps };
    }

    function flushEffects() {
      const batch = pendingEffects;
      pendingEffects = [];
      for (const item of batch) {
        if (typeof item.bucket.slots[item.index]?.cleanup === "function") {
          item.bucket.slots[item.index].cleanup();
        }
        const cleanup = item.fn();
        item.bucket.slots[item.index].cleanup = typeof cleanup === "function" ? cleanup : undefined;
      }
    }

    function render(props) {
      pendingEffects = [];
      const tree = expand({ type: InlineThinkingMod.InlineThinking, props });
      flushEffects();
      return tree;
    }

    function unmountAll() {
      for (const b of instances.values()) {
        for (const s of b.slots) {
          if (s && typeof s.cleanup === "function") {
            s.cleanup();
            s.cleanup = undefined;
          }
        }
      }
      instances.clear();
    }

    return {
      render,
      unmountAll,
      copied,
      setStyle(patch) {
        styleSetting = { ...styleSetting, ...patch };
      },
    };
  }

  function findAll(node, pred, acc = []) {
    if (node === null || node === undefined || typeof node !== "object") return acc;
    if (Array.isArray(node)) {
      for (const c of node) findAll(c, pred, acc);
      return acc;
    }
    if (pred(node)) acc.push(node);
    const ch = node.props?.children;
    if (ch !== undefined) findAll(ch, pred, acc);
    return acc;
  }

  function collectText(node) {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (node === null || node === undefined || typeof node !== "object") return "";
    if (Array.isArray(node)) return node.map(collectText).join("");
    return collectText(node.props?.children);
  }

  const sampleThought = "**第一步：分析代码**\n读取 `inline-thinking.tsx` 并核对 **TokenColors**。\n\n**第二步：设计方案**\n保留经典基线并加入 5 套样式。";

  // 1. Breathing Rail (A)
  {
    const h = createTreeHarness();
    h.setStyle({ thinkingStyle: "rail", expandedMaxHeight: 310 });
    const runningTree = h.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "streaming" } },
    });
    check(
      "rail running mounts style container, breathing rail, and peek window",
      findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-style-rail").length === 1 &&
        findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-rail-breathe").length === 1 &&
        findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-peek").length === 1,
    );
    const headBtn = findAll(runningTree, (n) => n.type === "Pressable")[0];
    headBtn.props.onPress();
    const expandedTree = h.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "complete" } },
    });
    const scroll = findAll(expandedTree, (n) => n.type === "ScrollView")[0];
    check(
      "rail expanded mounts bounded ScrollView with expandedMaxHeight and structured headings",
      scroll?.props?.testID === "dsh-scroll-box" &&
        scroll?.props?.style?.maxHeight === 310 &&
        collectText(scroll).includes("第一步：分析代码"),
    );
    h.unmountAll();
  }

  // 2. Silk Subtitle (B)
  {
    const h = createTreeHarness();
    h.setStyle({ thinkingStyle: "silk" });
    const runningTree = h.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "streaming" } },
    });
    check(
      "silk running stays strictly single-line (no peek box or ScrollView)",
      findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-style-silk").length === 1 &&
        findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-peek").length === 0 &&
        findAll(runningTree, (n) => n.type === "ScrollView").length === 0,
    );
    const headBtn = findAll(runningTree, (n) => n.type === "Pressable")[0];
    headBtn.props.onPress();
    const expandedTree = h.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "complete" } },
    });
    const copyBtn = findAll(expandedTree, (n) => n.props?.testID === "dsh-thinking-copy")[0];
    copyBtn?.props?.onPress();
    check(
      "silk expanded toolbar Copy button calls copyText with raw thought",
      copyBtn !== undefined && h.copied.length === 1 && h.copied[0] === sampleThought,
    );
    h.unmountAll();
  }

  // 3. Soft Capsule (C)
  {
    const h = createTreeHarness();
    h.setStyle({ thinkingStyle: "capsule" });
    const runningTree = h.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "streaming" } },
    });
    const runningBadge = findAll(runningTree, (n) => n.props?.testID === "dsh-row-badge-running")[0];
    check(
      "capsule running mounts gliding progress bar, peek window, and surface1 badge backdrop",
      findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-style-capsule").length === 1 &&
        findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-progress-bar").length === 1 &&
        findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-peek").length === 1 &&
        runningBadge !== undefined,
    );
    const settledTree = h.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "complete" } },
    });
    const headBtn = findAll(settledTree, (n) => n.type === "Pressable")[0];
    headBtn.props.onPress();
    const expandedTree = h.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "complete" } },
    });
    check(
      "capsule expanded renders bounded ScrollView inside surface1 container",
      findAll(expandedTree, (n) => n.type === "ScrollView" && n.props?.testID === "dsh-scroll-box").length === 1,
    );
    h.unmountAll();
  }

  // 4. Stepper Timeline (D)
  {
    const h = createTreeHarness();
    h.setStyle({ thinkingStyle: "stepper" });
    const runningTree = h.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "streaming" } },
    });
    check(
      "stepper running shows step timeline while streaming",
      findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-style-stepper").length === 1 &&
        findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-steps").length === 1,
    );
    // Fresh settled instance: historic complete row collapses steps and never fabricates 0.0s duration.
    const hSettled = createTreeHarness();
    hSettled.setStyle({ thinkingStyle: "stepper" });
    const historicTree = hSettled.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "complete" } },
    });
    check(
      "stepper historic settled row starts collapsed with honest step count (no fake 0.0s)",
      findAll(historicTree, (n) => n.props?.testID === "dsh-thinking-steps").length === 0 &&
        !collectText(historicTree).includes("0.0s"),
    );
    const headBtn = findAll(historicTree, (n) => n.type === "Pressable")[0];
    headBtn.props.onPress();
    const expandedTree = hSettled.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "complete" } },
    });
    check(
      "stepper expanded wraps steps inside bounded ScrollView",
      findAll(expandedTree, (n) => n.type === "ScrollView" && n.props?.testID === "dsh-scroll-box").length === 1 &&
        findAll(expandedTree, (n) => n.props?.testID === "dsh-thinking-steps").length === 1,
    );
    h.unmountAll();
    hSettled.unmountAll();
  }

  // 5. Editorial Marginalia (E)
  {
    const h = createTreeHarness();
    h.setStyle({ thinkingStyle: "editorial" });
    const runningTree = h.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "streaming" } },
    });
    check(
      "editorial running mounts style container and 2-line peek",
      findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-style-editorial").length === 1 &&
        findAll(runningTree, (n) => n.props?.testID === "dsh-thinking-peek").length === 1,
    );
    const headBtn = findAll(runningTree, (n) => n.type === "Pressable")[0];
    headBtn.props.onPress();
    const expandedTree = h.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "complete" } },
    });
    check(
      "editorial expanded renders dashed quote border and bounded ScrollView",
      findAll(expandedTree, (n) => n.props?.style?.borderStyle === "dashed").length >= 1 &&
        findAll(expandedTree, (n) => n.type === "ScrollView" && n.props?.testID === "dsh-scroll-box").length === 1,
    );
    h.unmountAll();
  }

  // 6. Native Animated loop cleanup across BreathingRail & BreathingDot
  {
    let starts = 0;
    const activeAnims = new Set();
    const makeAnim = () => {
      const token = {
        start: () => {
          starts += 1;
          activeAnims.add(token);
        },
        stop: () => {
          activeAnims.delete(token);
        },
      };
      return token;
    };
    class FakeAnimatedValue {
      constructor(v) {
        this._v = v;
      }
      setValue(v) {
        this._v = v;
      }
      interpolate() {
        return this._v;
      }
    }
    const hNative = createTreeHarness({
      Platform: { OS: "ios" },
      Easing: { linear: "linear", sin: "sin", quad: "quad", cubic: "cubic", inOut: (x) => x, out: (x) => x },
      Animated: {
        Value: FakeAnimatedValue,
        View: "Animated.View",
        delay: () => makeAnim(),
        timing: () => makeAnim(),
        sequence: () => makeAnim(),
        parallel: () => makeAnim(),
        loop: () => makeAnim(),
      },
    });
    hNative.setStyle({ thinkingStyle: "rail" });
    const nativeTree = hNative.render({
      theme: { colors: COLORS },
      layout: { compact: false },
      item: { data: { text: sampleThought, phase: "streaming" } },
    });
    const animatedViews = findAll(nativeTree, (n) => n.type === "Animated.View").length;
    const activeWhileMounted = activeAnims.size;
    hNative.unmountAll();
    check(
      "Native rail starts Animated loops and stops every loop cleanly on unmount",
      animatedViews >= 3 && starts >= 3 && activeWhileMounted >= 3 && activeAnims.size === 0,
      `animatedViews=${animatedViews}, starts=${starts}, activeWhileMounted=${activeWhileMounted}, leaked=${activeAnims.size}`,
    );
  }

  // 7. Zero hardcoded colors in thinking-styles.tsx and thinking-motion.tsx
  {
    const stylesSrcPath = findRepoFile("client/thinking-styles.tsx");
    const motionSrcPath = findRepoFile("client/thinking-motion.tsx");
    const colorPattern = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;
    for (const [label, srcPath] of [
      ["thinking-styles.tsx", stylesSrcPath],
      ["thinking-motion.tsx", motionSrcPath],
    ]) {
      check(`located ${label} for colour audit`, srcPath !== undefined);
      if (srcPath !== undefined) {
        const code = readFileSync(srcPath, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join("\n");
        check(
          `${label} contains no hardcoded hex/rgb/hsl colours`,
          !colorPattern.test(code),
        );
      }
    }
  }

  // 8. Display settings screen renders all 6 thinking styles and saves selection immediately
  {
    const settingsPath = join(__dirname, "client", "settings-screen.js");
    check("compiled client/settings-screen.js exists", existsSync(settingsPath));
    if (existsSync(settingsPath)) {
      const savedCalls = [];
      let currentStyleValues = {
        rowMarginY: 0,
        toolRowPaddingY: 0,
        toolRowMinHeight: 24,
        toolRowGap: 6,
        expandedMaxHeight: 260,
        commandMaxHeightRatio: 0.25,
        commandMinHeight: 150,
        thinkingStyle: "classic",
      };
      const screenSlots = [];
      let screenCursor = 0;
      const screenHooks = {
        Component: class Component {},
        useState(init) {
          const i = screenCursor++;
          if (!(i in screenSlots)) screenSlots[i] = typeof init === "function" ? init() : init;
          return [
            screenSlots[i],
            (next) => {
              screenSlots[i] = typeof next === "function" ? next(screenSlots[i]) : next;
            },
          ];
        },
        useMemo(fn) {
          return fn();
        },
        useSyncExternalStore(_sub, snap) {
          return snap();
        },
      };
      const screenStubs = {
        react: () => screenHooks,
        "react/jsx-runtime": () => ({
          jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
          jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
          Fragment: "Fragment",
        }),
        "react-native": () => ({
          Platform: { OS: "web" },
          Pressable: "Pressable",
          ScrollView: "ScrollView",
          Text: "Text",
          View: "View",
        }),
        "@getpaseo/plugin": () => ({ defineSettings: (cfg) => cfg }),
        "@getpaseo/plugin/client": () => ({
          useSettings: (def) => {
            if (def?.id === "language") {
              return {
                status: "ready",
                values: { language: "auto" },
                revision: 1,
                saving: false,
                saveError: null,
                save: async () => true,
                reset: async () => true,
              };
            }
            return {
              status: "ready",
              values: currentStyleValues,
              revision: 7,
              saving: false,
              saveError: null,
              save: async (data, rev) => {
                savedCalls.push({ data, rev });
                currentStyleValues = data;
                return true;
              },
              reset: async () => true,
            };
          },
        }),
        "@getpaseo/plugin/client/ui": () => ({ TextInput: "TextInput" }),
      };
      const origLoad = Module._load;
      const savedCache = new Map();
      for (const k of Object.keys(require.cache)) {
        if (k.includes("/client/settings-screen")) {
          savedCache.set(k, require.cache[k]);
          delete require.cache[k];
        }
      }
      Module._load = function load(req, parent, isMain) {
        if (screenStubs[req] !== undefined) return screenStubs[req]();
        return origLoad.call(this, req, parent, isMain);
      };
      let TimelineSettingsScreen;
      try {
        ({ TimelineSettingsScreen } = require(settingsPath));
      } finally {
        Module._load = origLoad;
        for (const k of Object.keys(require.cache)) {
          if (k.includes("/client/settings-screen") && !savedCache.has(k)) delete require.cache[k];
        }
        for (const [k, v] of savedCache) require.cache[k] = v;
      }

      const renderScreen = () => {
        screenCursor = 0;
        return TimelineSettingsScreen({
          theme: {
            colors: {
              ...COLORS,
              accentForeground: "#ffffff",
            },
          },
          layout: { compact: false },
        });
      };
      const screenTree = renderScreen();
      const pressables = findAll(screenTree, (n) => n.type === "Pressable");
      const styleKeys = ["classic", "rail", "silk", "capsule", "stepper", "editorial"];
      const styleButtons = pressables.filter((n) => styleKeys.includes(n.key));
      check(
        "Display settings renders all 6 thinkingStyle buttons with classic initially selected",
        styleButtons.length === 6 &&
          styleButtons.find((b) => b.key === "classic")?.props?.accessibilityState?.selected === true &&
          styleButtons.find((b) => b.key === "rail")?.props?.accessibilityState?.selected === false,
        `found ${styleButtons.length} button(s)`,
      );

      const railButton = styleButtons.find((b) => b.key === "rail");
      railButton?.props?.onPress();
      Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => {
          check(
            "tapping Breathing Rail saves thinkingStyle='rail' with current revision",
            savedCalls.length === 1 &&
              savedCalls[0].data.thinkingStyle === "rail" &&
              savedCalls[0].rev === 7,
            JSON.stringify(savedCalls),
          );
          const afterSelectTree = renderScreen();
          const resetBtn = findAll(afterSelectTree, (n) => n.type === "Pressable").find(
            (n) => n.props?.accessibilityLabel === "恢复默认" || n.props?.accessibilityLabel === "Restore defaults",
          );
          resetBtn?.props?.onPress();
          return Promise.resolve().then(() => Promise.resolve());
        })
        .then(() => {
          check(
            "tapping Restore defaults resets thinkingStyle back to 'classic'",
            savedCalls.length === 2 && savedCalls[1].data.thinkingStyle === "classic",
            JSON.stringify(savedCalls[1]),
          );
          console.log(`\n${passed} passed, ${failed} failed`);
          process.exit(failed === 0 ? 0 : 1);
        })
        .catch((err) => {
          console.error(err);
          process.exit(1);
        });
      return;
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
