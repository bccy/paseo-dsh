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
  reasoningPreview,
  streamingTail,
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
  const roots = [__dirname, process.cwd()];
  for (const start of roots) {
    let dir = start;
    for (let i = 0; i < 6; i += 1) {
      const candidate = join(dir, "harness", name);
      if (existsSync(candidate)) return require(candidate);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(`could not find harness/${name} above ${__dirname} or ${process.cwd()}`);
}

const { attributeOf, callArguments, elementWithAttributes, elementsWithAttributes, mentions, splitArguments } =
  requireHarnessModule("source-shape.cjs");

/**
 * Locate a repo source file from wherever this check runs. The documented
 * compile step copies the check into `paseo-plugin/.dbg` (one level below
 * `paseo-plugin`), while an isolated temp build dir (e.g. `/tmp/...`) relies on
 * `process.cwd()` being inside the repo; walking up from both finds the source
 * either way instead of failing on `__dirname/..`.
 */
function findRepoFile(relative, levels = 5) {
  const roots = [__dirname, process.cwd()];
  for (const start of roots) {
    let dir = start;
    for (let i = 0; i < levels; i += 1) {
      for (const candidate of [join(dir, relative), join(dir, "paseo-plugin", relative)]) {
        if (existsSync(candidate)) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
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

console.log("formatThinkingDuration: tenths under 1m, whole minutes and seconds from 1m up");
{
  check("0ms renders empty (no noisy 0.0s)", formatThinkingDuration(0) === "");
  check("99ms renders empty", formatThinkingDuration(99) === "");
  check("negative renders empty", formatThinkingDuration(-200) === "");
  check(
    "NaN and +/-Infinity render empty",
    formatThinkingDuration(Number.NaN) === "" &&
      formatThinkingDuration(Number.POSITIVE_INFINITY) === "" &&
      formatThinkingDuration(Number.NEGATIVE_INFINITY) === "",
  );
  check("100ms formats as 0.1s", formatThinkingDuration(100) === "0.1s", formatThinkingDuration(100));
  check("1240ms formats as 1.2s", formatThinkingDuration(1240) === "1.2s", formatThinkingDuration(1240));
  check("1250ms rounds up to 1.3s", formatThinkingDuration(1250) === "1.3s", formatThinkingDuration(1250));
  check("59949ms stays 59.9s", formatThinkingDuration(59949) === "59.9s", formatThinkingDuration(59949));
  check("59950ms rolls cleanly to 1m 0s (never 60.0s)", formatThinkingDuration(59950) === "1m 0s", formatThinkingDuration(59950));
  check("60949ms stays 1m 0s at whole-second boundary", formatThinkingDuration(60949) === "1m 0s", formatThinkingDuration(60949));
  check("60950ms advances cleanly to 1m 1s", formatThinkingDuration(60950) === "1m 1s", formatThinkingDuration(60950));
  check("61200ms formats as 1m 1s", formatThinkingDuration(61200) === "1m 1s", formatThinkingDuration(61200));
  check("125000ms formats as 2m 5s", formatThinkingDuration(125000) === "2m 5s", formatThinkingDuration(125000));
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

  // Fake clock: records real delay and dueAt for setTimeout and setInterval,
  // advancing monotonic time step-by-step and firing only due callbacks.
  // `wallOffset` lets wall-clock rollback tests shift `Date.now()` independently
  // of monotonic timer scheduling.
  const realDateNow = Date.now;
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;

  let monoNow = 1_700_000_000_000;
  let wallOffset = 0;
  let timers = new Map();
  let nextTimerId = 0;
  let intervals = new Map();
  let nextIntervalId = 0;

  Date.now = () => monoNow + wallOffset;
  global.setTimeout = (callback, delay = 0) => {
    const ms = Math.max(0, Number(delay) || 0);
    nextTimerId += 1;
    timers.set(nextTimerId, { callback, delay: ms, dueAt: monoNow + ms });
    return nextTimerId;
  };
  global.clearTimeout = (id) => {
    timers.delete(id);
  };
  global.setInterval = (callback, delay = 0) => {
    const ms = Math.max(1, Number(delay) || 1);
    nextIntervalId += 1;
    intervals.set(nextIntervalId, { callback, delay: ms, dueAt: monoNow + ms });
    return nextIntervalId;
  };
  global.clearInterval = (id) => {
    intervals.delete(id);
  };

  function advanceClock(ms) {
    if (ms < 0) throw new Error(`advanceClock expects non-negative ms, got ${ms}`);
    const target = monoNow + ms;
    while (true) {
      let nextKind = null;
      let nextId = null;
      let nextDue = Number.POSITIVE_INFINITY;
      for (const [id, entry] of timers.entries()) {
        if (entry.dueAt <= target && entry.dueAt < nextDue) {
          nextKind = "timeout";
          nextId = id;
          nextDue = entry.dueAt;
        }
      }
      for (const [id, entry] of intervals.entries()) {
        if (entry.dueAt <= target && entry.dueAt < nextDue) {
          nextKind = "interval";
          nextId = id;
          nextDue = entry.dueAt;
        }
      }
      if (nextKind === null) break;
      monoNow = nextDue;
      if (nextKind === "timeout") {
        const entry = timers.get(nextId);
        timers.delete(nextId);
        if (entry !== undefined) entry.callback();
      } else {
        const entry = intervals.get(nextId);
        if (entry !== undefined) {
          entry.dueAt = monoNow + entry.delay;
          entry.callback();
        }
      }
    }
    monoNow = target;
  }

  function shiftWallClock(deltaMs) {
    wallOffset += deltaMs;
  }

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

  // Stand-ins for the host modules only; `./thinking-text`, `./tokens`,
  // `./row-entrance`, `./newest`, and `./locale` are the real compiled modules.
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
      Text: "Text",
      View: "View",
    }),
    "@getpaseo/plugin": () => ({
      defineSettings: (config) => config,
    }),
    "@getpaseo/plugin/client": () => ({
      useSettings: () => ({ status: "ready", values: styleSettingsValues }),
    }),
    "./text-shimmer": () => ({ TextShimmer: "TextShimmer" }),
  };
  const inkStreamCalls = [];
  const noteRenderCalls = [];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (parent && parent.filename === componentPath) {
      if (request === "./row-entrance") {
        const real = originalLoad.call(this, request, parent, isMain);
        return {
          ...real,
          useInkStreamReveal(options) {
            inkStreamCalls.push(options);
            return real.useInkStreamReveal(options);
          },
        };
      }
      if (request === "./newest") {
        const real = originalLoad.call(this, request, parent, isMain);
        return {
          ...real,
          noteRender(...args) {
            noteRenderCalls.push(args);
            return real.noteRender(...args);
          },
        };
      }
    }
    const stub = stubs[request];
    if (stub !== undefined) return stub();
    return originalLoad.call(this, request, parent, isMain);
  };
  let InlineThinking;
  let THINKING_DURATION_TEST_ID;
  let resetThinkingDurationsForTests;
  try {
    ({
      InlineThinking,
      THINKING_DURATION_TEST_ID,
      resetThinkingDurationsForTests,
    } = require(componentPath));
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
        colors: { foreground: "#ffffff", foregroundMuted: "#888888", surface0: "#000000" },
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

  /** Advance past the 300ms settle window — no host frame is involved. */
  function settle() {
    advanceClock(300);
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
  // Explicit 300ms settle-window boundary: +250ms & +299ms must NOT settle yet, +300ms settles.
  advanceClock(250);
  check(
    "at +250ms inside the 300ms settle window, row is still scrolling and timer remains pending",
    timers.size === 1 && findShimmerActive(renderToStable(lastText, lastPhase)) === true,
    `timers=${timers.size}`,
  );
  advanceClock(49);
  check(
    "at +299ms (1ms before 300ms settle window), row is still scrolling and timer remains pending",
    timers.size === 1 && findShimmerActive(renderToStable(lastText, lastPhase)) === true,
    `timers=${timers.size}`,
  );
  advanceClock(1);
  check(
    "…and at +300ms settles without another host frame",
    timers.size === 0 && findShimmerActive(renderToStable(lastText, lastPhase)) === false,
    `timers=${timers.size}`,
  );
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

  console.log("right-aligned thinking duration ticks live, freezes on settle, and survives remount");
  {
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

    function resetHooks() {
      slots = [];
      cursor = 0;
      effects = [];
      changed = false;
      timers.clear();
      intervals.clear();
    }

    function renderRow(props, onBeforeEffects) {
      let tree;
      let passes = 0;
      do {
        changed = false;
        effects = [];
        cursor = 0;
        tree = InlineThinking({
          theme: {
            colors: { foreground: "#ffffff", foregroundMuted: "#888888", surface0: "#000000" },
          },
          layout: { compact: false },
          ...props,
        });
        if (typeof onBeforeEffects === "function") onBeforeEffects(tree);
        for (const { index, effect } of effects) {
          const slot = slots[index];
          if (typeof slot.cleanup === "function") slot.cleanup();
          const cleanup = effect();
          slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
        }
        passes += 1;
      } while (changed && passes < 10);
      return tree;
    }

    try {
      resetThinkingDurationsForTests();

      // 1. Historic / replayed thought: mounts complete and never grows -> no timer, no badge.
      resetHooks();
      const historicTree = renderRow({
        agentId: "dur-agent",
        timestamp: 1_700_000_001_000,
        item: { data: { text: "already finished thought", phase: "complete" } },
      });
      check(
        "historic completed row starts no duration interval",
        intervals.size === 0,
        `${intervals.size} interval(s)`,
      );
      check(
        "historic completed row does not render a duration badge",
        findNode(historicTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null,
      );
      unmount();

      // 2. Live streaming thought: respects 100ms interval cadence & 300ms settle window,
      // stays visible when expanded, freezes on settle, and resumes monotonically if reopened.
      resetHooks();
      const liveTs = 1_700_000_002_000;
      const t0Tree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: "starting", phase: "streaming" } },
      });
      check(
        "live streaming row starts one duration interval",
        intervals.size === 1,
        `${intervals.size} interval(s)`,
      );
      check(
        "at 0ms elapsed, no noisy 0.0s duration is rendered",
        findNode(t0Tree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null,
      );

      // Explicit 100ms cadence boundary: +50ms must NOT fire the interval, +100ms fires -> 0.1s.
      advanceClock(50);
      const t50Tree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: "starting", phase: "streaming" } },
      });
      check(
        "at +50ms before 100ms interval dueAt, duration has not ticked yet",
        findNode(t50Tree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null,
        `text=${findNode(t50Tree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      advanceClock(50);
      const t100Tree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: "starting", phase: "streaming" } },
      });
      check(
        "at +100ms when 100ms interval fires, duration ticks to 0.1s",
        findNode(t100Tree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "0.1s",
        `text=${findNode(t100Tree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );

      advanceClock(1150);
      const t1Tree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: "starting to reason through the layout", phase: "streaming" } },
      });
      const durNode1 = findNode(t1Tree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID);
      check(
        "after 1250ms tick, right-side duration shows 1.3s with tabular-nums and theme color",
        durNode1?.props?.children === "1.3s" &&
          durNode1?.props?.style?.color === "#888888" &&
          Array.isArray(durNode1?.props?.style?.fontVariant) &&
          durNode1.props.style.fontVariant.includes("tabular-nums"),
        JSON.stringify({ text: durNode1?.props?.children, style: durNode1?.props?.style }),
      );

      const headPressable = findNode(t1Tree, (n) => n.type === "Pressable");
      const headChildren = childArray(headPressable);
      const mainIndex = headChildren.findIndex((c) => findNode(c, (n) => n.type === "TextShimmer") !== null);
      const durIndex = headChildren.findIndex((c) => findNode(c, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) !== null);
      const labelStyle = findNode(
        findNode(t1Tree, (n) => n.type === "TextShimmer").props.children(null),
        (n) => n.type === "Text" && typeof n.props?.onLayout === "function",
      )?.props?.style;
      const flatLabelStyle = Array.isArray(labelStyle) ? Object.assign({}, ...labelStyle.filter(Boolean)) : labelStyle;
      check(
        "duration sits on the right of the TextShimmer main slot with web-safe overflow guards",
        mainIndex >= 0 &&
          durIndex > mainIndex &&
          headChildren[mainIndex]?.props?.style?.flex === 1 &&
          headChildren[mainIndex]?.props?.style?.minWidth === 0 &&
          headChildren[durIndex]?.props?.style?.flexShrink === 0 &&
          durNode1?.props?.numberOfLines === 1 &&
          flatLabelStyle?.flexShrink === 0,
        JSON.stringify({
          mainIndex,
          durIndex,
          mainStyle: headChildren[mainIndex]?.props?.style,
          durBoxStyle: headChildren[durIndex]?.props?.style,
          durLines: durNode1?.props?.numberOfLines,
          labelShrink: flatLabelStyle?.flexShrink,
        }),
      );

      // Expanding the row keeps the duration visible on the head row.
      headPressable.props.onPress();
      const expandedDurTree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: "starting to reason through the layout", phase: "streaming" } },
      });
      check(
        "duration remains visible on the right when the thought is expanded",
        findNode(expandedDurTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.3s",
      );

      // Width budget: reporting durationBox width narrows streamingTail's budget.
      headPressable.props.onPress(); // collapse again
      const longStreaming =
        "starting to reason through the layout abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      const measuredTree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: longStreaming, phase: "streaming" } },
      });
      const headForMeasure = findNode(measuredTree, (n) => n.type === "Pressable");
      headForMeasure.props.onLayout({ nativeEvent: { layout: { width: 220 } } });
      const shimmerForMeasure = findNode(measuredTree, (n) => n.type === "TextShimmer");
      const shimmerChildrenBefore = shimmerForMeasure.props.children(null);
      const labelNode = findNode(shimmerChildrenBefore, (n) => n.type === "Text" && typeof n.props?.onLayout === "function");
      labelNode.props.onLayout({ nativeEvent: { layout: { width: 26 } } });
      const treeBeforeDurWidth = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: longStreaming, phase: "streaming" } },
      });
      const lineBeforeDurWidth = findNode(
        findNode(treeBeforeDurWidth, (n) => n.type === "TextShimmer").props.children(null),
        (n) => n.type === "Text" && n.props?.numberOfLines === 1,
      )?.props?.children;

      const durBoxNode = childArray(findNode(treeBeforeDurWidth, (n) => n.type === "Pressable")).find(
        (c) => findNode(c, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) !== null,
      );
      durBoxNode.props.onLayout({ nativeEvent: { layout: { width: 38 } } });
      const treeAfterDurWidth = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: longStreaming, phase: "streaming" } },
      });
      const lineAfterDurWidth = findNode(
        findNode(treeAfterDurWidth, (n) => n.type === "TextShimmer").props.children(null),
        (n) => n.type === "Text" && n.props?.numberOfLines === 1,
      )?.props?.children;
      check(
        "duration width is subtracted from streamingTail line width budget",
        typeof lineBeforeDurWidth === "string" &&
          typeof lineAfterDurWidth === "string" &&
          lineAfterDurWidth.length < lineBeforeDurWidth.length,
        `before=${String(lineBeforeDurWidth).length} after=${String(lineAfterDurWidth).length}`,
      );

      // Final chunk arrives at 2400ms total; advancing wall clock by SETTLE_WINDOW_MS (300ms)
      // must hold until +300ms and still freeze at 2.4s (not 2.7s).
      advanceClock(1150);
      renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: `${longStreaming}!`, phase: "complete" } },
      });
      advanceClock(250);
      const settlingMidTree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: `${longStreaming}!`, phase: "complete" } },
      });
      check(
        "at +250ms into settle window, row has not settled yet and stays at 2.4s with 0 intervals",
        timers.size === 1 &&
          intervals.size === 0 &&
          findShimmerActive(settlingMidTree) === true &&
          findNode(settlingMidTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "2.4s",
        `timers=${timers.size}, intervals=${intervals.size}, active=${findShimmerActive(settlingMidTree)}, text=${findNode(settlingMidTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      advanceClock(49);
      const settling299Tree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: `${longStreaming}!`, phase: "complete" } },
      });
      check(
        "at +299ms into settle window, row still has not settled and holds 2.4s",
        timers.size === 1 &&
          intervals.size === 0 &&
          findShimmerActive(settling299Tree) === true &&
          findNode(settling299Tree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "2.4s",
        `timers=${timers.size}, intervals=${intervals.size}, active=${findShimmerActive(settling299Tree)}, text=${findNode(settling299Tree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      advanceClock(1);
      const settledTree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: `${longStreaming}!`, phase: "complete" } },
      });
      check(
        "settling at +300ms clears the duration interval and freezes at 2.4s without adding the 300ms settle window",
        timers.size === 0 &&
          intervals.size === 0 &&
          findShimmerActive(settledTree) === false &&
          findNode(settledTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "2.4s",
        `timers=${timers.size}, intervals=${intervals.size}, active=${findShimmerActive(settledTree)}, text=${findNode(settledTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );

      // Further wall-clock advance while still mounted does not change the frozen duration.
      advanceClock(600_000);
      const stillFrozenTree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: `${longStreaming}!`, phase: "complete" } },
      });
      check(
        "frozen duration stays 2.4s after 10m idle wall-clock advance",
        intervals.size === 0 &&
          findNode(stillFrozenTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "2.4s",
      );

      // Resuming streaming on the same key after a >300ms settle pause must continue
      // accumulating from 2.4s without resetting to 0 or adding the 10m idle pause.
      const resumedSameKeyTree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: `${longStreaming}! (resumed)`, phase: "streaming" } },
      });
      check(
        "resuming streaming on same key after 10m settle restarts interval at 2.4s without counting idle gap",
        intervals.size === 1 &&
          findNode(resumedSameKeyTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "2.4s",
        `intervals=${intervals.size}, text=${findNode(resumedSameKeyTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      advanceClock(500);
      const resumedTickTree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: `${longStreaming}! (resumed) more`, phase: "streaming" } },
      });
      check(
        "resumed stream advances monotonically from 2.4s to 2.9s after 500ms",
        intervals.size === 1 &&
          findNode(resumedTickTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "2.9s",
        `intervals=${intervals.size}, text=${findNode(resumedTickTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: `${longStreaming}! (resumed) more`, phase: "complete" } },
      });
      advanceClock(300);
      const resettledTree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: `${longStreaming}! (resumed) more`, phase: "complete" } },
      });
      check(
        "re-settling after resumed stream freezes at new cumulative 2.9s",
        intervals.size === 0 &&
          findNode(resettledTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "2.9s",
        `intervals=${intervals.size}, text=${findNode(resettledTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      // 3. Remounting the same row (virtual-list recycle) 10 minutes later preserves 2.9s.
      resetHooks();
      advanceClock(600_000);
      const remountedTree = renderRow({
        agentId: "dur-agent",
        timestamp: liveTs,
        item: { data: { text: `${longStreaming}! (resumed) more`, phase: "complete" } },
      });
      check(
        "remounting settled row preserves cached 2.9s without inflating or starting intervals",
        intervals.size === 0 &&
          findNode(remountedTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "2.9s",
        `intervals=${intervals.size}, text=${findNode(remountedTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      // 3b. Resuming streaming after a >300ms settle pause WITH a host timestamp advance
      // migrates the cached elapsed time to the new key and continues cleanly.
      resetHooks();
      const pauseShiftTs1 = 1_700_000_002_500;
      const pauseShiftTs2 = 1_700_000_062_500;
      renderRow({
        agentId: "dur-agent",
        timestamp: pauseShiftTs1,
        item: { data: { text: "phase one", phase: "streaming" } },
      });
      advanceClock(1400);
      renderRow({
        agentId: "dur-agent",
        timestamp: pauseShiftTs1,
        item: { data: { text: "phase one done", phase: "complete" } },
      });
      advanceClock(300);
      renderRow({
        agentId: "dur-agent",
        timestamp: pauseShiftTs1,
        item: { data: { text: "phase one done", phase: "complete" } },
      });
      advanceClock(60_000); // 60s pause after settle
      const shiftedResumeTree = renderRow({
        agentId: "dur-agent",
        timestamp: pauseShiftTs2,
        item: { data: { text: "phase one done -> phase two", phase: "streaming" } },
      });
      check(
        "resuming after settle with host timestamp advance carries 1.4s without resetting or adding 60s pause",
        intervals.size === 1 &&
          findNode(shiftedResumeTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.4s",
        `intervals=${intervals.size}, text=${findNode(shiftedResumeTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      advanceClock(400);
      renderRow({
        agentId: "dur-agent",
        timestamp: pauseShiftTs2,
        item: { data: { text: "phase one done -> phase two end", phase: "complete" } },
      });
      advanceClock(300);
      const shiftedResettledTree = renderRow({
        agentId: "dur-agent",
        timestamp: pauseShiftTs2,
        item: { data: { text: "phase one done -> phase two end", phase: "complete" } },
      });
      check(
        "re-settling after timestamp-shifted resume freezes at 1.8s on the migrated key",
        intervals.size === 0 &&
          findNode(shiftedResettledTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.8s",
        `intervals=${intervals.size}, text=${findNode(shiftedResettledTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();
      resetHooks();
      const shiftedRemountTree = renderRow({
        agentId: "dur-agent",
        timestamp: pauseShiftTs2,
        item: { data: { text: "phase one done -> phase two end", phase: "complete" } },
      });
      check(
        "remounting migrated key after post-settle resume preserves 1.8s",
        intervals.size === 0 &&
          findNode(shiftedRemountTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.8s",
        `intervals=${intervals.size}, text=${findNode(shiftedRemountTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      // 4. Unmounting mid-stream flushes segment & clears interval; remounting 5 minutes later
      // as streaming continues from 1.5s -> 1.6s (never jumps to 5m 1s), and remounting as
      // complete keeps 1.5s with 0 intervals.
      resetHooks();
      const midStreamTs = 1_700_000_003_000;
      renderRow({
        agentId: "dur-agent",
        timestamp: midStreamTs,
        item: { data: { text: "mid", phase: "streaming" } },
      });
      advanceClock(1500);
      renderRow({
        agentId: "dur-agent",
        timestamp: midStreamTs,
        item: { data: { text: "mid stream", phase: "streaming" } },
      });
      unmount();
      check("unmounting mid-stream clears the interval", intervals.size === 0, `${intervals.size}`);

      advanceClock(300_000); // 5 minutes unmounted
      resetHooks();
      const remountStreamingTree = renderRow({
        agentId: "dur-agent",
        timestamp: midStreamTs,
        item: { data: { text: "mid stream still going", phase: "streaming" } },
      });
      check(
        "remounting mid-stream row 5m later as streaming resumes at 1.5s (not 5m 1s)",
        intervals.size === 1 &&
          findNode(remountStreamingTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.5s",
        `intervals=${intervals.size}, text=${findNode(remountStreamingTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      advanceClock(100);
      const remountStreamingNextTree = renderRow({
        agentId: "dur-agent",
        timestamp: midStreamTs,
        item: { data: { text: "mid stream still going", phase: "streaming" } },
      });
      check(
        "after +100ms on remounted streaming row, duration advances from 1.5s to 1.6s",
        intervals.size === 1 &&
          findNode(remountStreamingNextTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.6s",
        `intervals=${intervals.size}, text=${findNode(remountStreamingNextTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      // 4b. Unmounting mid-stream and remounting 5 minutes later as complete keeps 1.5s & 0 intervals.
      resetHooks();
      const midCompleteTs = 1_700_000_003_500;
      renderRow({
        agentId: "dur-agent",
        timestamp: midCompleteTs,
        item: { data: { text: "mid-c", phase: "streaming" } },
      });
      advanceClock(1500);
      renderRow({
        agentId: "dur-agent",
        timestamp: midCompleteTs,
        item: { data: { text: "mid-c stream", phase: "streaming" } },
      });
      unmount();
      advanceClock(300_000);
      resetHooks();
      const remountMidTree = renderRow({
        agentId: "dur-agent",
        timestamp: midCompleteTs,
        item: { data: { text: "mid-c stream done", phase: "complete" } },
      });
      check(
        "remounting mid-stream row as complete keeps last observed 1.5s without adding unmounted gap",
        intervals.size === 0 &&
          findNode(remountMidTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.5s",
        `intervals=${intervals.size}, text=${findNode(remountMidTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );

      // 4c. Same-millisecond collision isolation: unrelated thoughts sharing the exact same
      // timestamp (same host/agent or across hosts) never reuse each other's cached duration.
      unmount();
      resetHooks();
      const collideTs = 1_700_000_003_800;
      renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "collide-agent",
        timestamp: collideTs,
        item: { data: { text: "alpha plan", phase: "streaming" } },
      });
      advanceClock(1200);
      renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "collide-agent",
        timestamp: collideTs,
        item: { data: { text: "alpha plan finalized", phase: "complete" } },
      });
      advanceClock(300);
      const alphaSettled = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "collide-agent",
        timestamp: collideTs,
        item: { data: { text: "alpha plan finalized", phase: "complete" } },
      });
      check(
        "same-ms primary thought settles at 1.2s",
        findNode(alphaSettled, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.2s",
      );
      unmount();

      resetHooks();
      const unrelatedHistoricSameMs = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "collide-agent",
        timestamp: collideTs,
        item: { data: { text: "beta unrelated history", phase: "complete" } },
      });
      check(
        "unrelated completed thought at the exact same millisecond does not reuse primary 1.2s badge",
        intervals.size === 0 &&
          findNode(unrelatedHistoricSameMs, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null,
        `text=${findNode(unrelatedHistoricSameMs, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      resetHooks();
      renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "collide-agent",
        timestamp: collideTs,
        item: { data: { text: "gamma fresh stream", phase: "streaming" } },
      });
      advanceClock(600);
      renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "collide-agent",
        timestamp: collideTs,
        item: { data: { text: "gamma fresh stream done", phase: "complete" } },
      });
      advanceClock(300);
      const gammaSettled = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "collide-agent",
        timestamp: collideTs,
        item: { data: { text: "gamma fresh stream done", phase: "complete" } },
      });
      check(
        "unrelated streaming thought at the exact same millisecond gets its own 0.6s slot",
        intervals.size === 0 &&
          findNode(gammaSettled, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "0.6s",
        `text=${findNode(gammaSettled, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      resetHooks();
      const alphaRemount = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "collide-agent",
        timestamp: collideTs,
        item: { data: { text: "alpha plan finalized", phase: "complete" } },
      });
      unmount();
      resetHooks();
      const gammaRemount = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "collide-agent",
        timestamp: collideTs,
        item: { data: { text: "gamma fresh stream done", phase: "complete" } },
      });
      unmount();
      resetHooks();
      const otherHostSameText = renderRow({
        host: { id: "host-b", label: "Host B" },
        agentId: "collide-agent",
        timestamp: collideTs,
        item: { data: { text: "alpha plan finalized", phase: "complete" } },
      });
      check(
        "remounting colliding thoughts preserves 1.2s and 0.6s independently, and different host.id is isolated",
        findNode(alphaRemount, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.2s" &&
          findNode(gammaRemount, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "0.6s" &&
          findNode(otherHostSameText, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null,
        JSON.stringify({
          alpha: findNode(alphaRemount, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children,
          gamma: findNode(gammaRemount, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children,
          otherHost: findNode(otherHostSameText, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children,
        }),
      );
      unmount();

      // 4d. Same-millisecond prefix collision isolation: a settled thought ("Analyze") must NOT
      // lend its cached duration to another completed thought sharing the same prefix
      // ("Analyze further") at the exact same millisecond, while exact-match remount and
      // streaming continuation still hit the original slot.
      resetHooks();
      const prefixTs = 1_700_000_003_900;
      renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "prefix-collide-agent",
        timestamp: prefixTs,
        item: { data: { text: "Analyze", phase: "streaming" } },
      });
      advanceClock(600);
      renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "prefix-collide-agent",
        timestamp: prefixTs,
        item: { data: { text: "Analyze", phase: "complete" } },
      });
      advanceClock(300);
      const analyzeSettled = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "prefix-collide-agent",
        timestamp: prefixTs,
        item: { data: { text: "Analyze", phase: "complete" } },
      });
      check(
        "same-ms prefix-collision baseline thought settles at 0.6s",
        intervals.size === 0 &&
          findNode(analyzeSettled, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "0.6s",
        `text=${findNode(analyzeSettled, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      resetHooks();
      const prefixCompletedOther = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "prefix-collide-agent",
        timestamp: prefixTs,
        item: { data: { text: "Analyze further", phase: "complete" } },
      });
      check(
        "another completed thought sharing the same prefix at the exact same ms does not inherit 0.6s",
        intervals.size === 0 &&
          findNode(prefixCompletedOther, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null,
        `text=${findNode(prefixCompletedOther, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      resetHooks();
      const analyzeExactRemount = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "prefix-collide-agent",
        timestamp: prefixTs,
        item: { data: { text: "Analyze", phase: "complete" } },
      });
      check(
        "exact-match remount of original settled thought still retains 0.6s",
        intervals.size === 0 &&
          findNode(analyzeExactRemount, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "0.6s",
        `text=${findNode(analyzeExactRemount, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      resetHooks();
      const analyzeStreamingResume = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "prefix-collide-agent",
        timestamp: prefixTs,
        item: { data: { text: "Analyze further", phase: "streaming" } },
      });
      advanceClock(400);
      const analyzeStreamingTick = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "prefix-collide-agent",
        timestamp: prefixTs,
        item: { data: { text: "Analyze further", phase: "streaming" } },
      });
      check(
        "settled thought resuming in streaming mode with appended prefix continues cleanly from 0.6s to 1.0s",
        intervals.size === 1 &&
          findNode(analyzeStreamingResume, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "0.6s" &&
          findNode(analyzeStreamingTick, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.0s",
        JSON.stringify({
          resume: findNode(analyzeStreamingResume, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children,
          tick: findNode(analyzeStreamingTick, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children,
          intervals: intervals.size,
        }),
      );
      unmount();

      // 5. In-place key recycling (same mounted instance switches to a historic row without unmounting)
      // must not leak the previous row's elapsed time or segment into the new key.
      resetHooks();
      renderRow({
        agentId: "dur-agent",
        timestamp: midCompleteTs,
        item: { data: { text: "mid-c stream done", phase: "complete" } },
      });
      const recycledHistoricTree = renderRow({
        agentId: "dur-agent",
        timestamp: 1_700_000_004_000,
        item: { data: { text: "unrelated historic row", phase: "complete" } },
      });
      check(
        "in-place key switch to an unseen historic row clears duration without leaking previous row",
        intervals.size === 0 &&
          findNode(recycledHistoricTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null,
        `intervals=${intervals.size}, text=${findNode(recycledHistoricTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      // 6. Actively streaming row recycled in-place to a shorter historic row clears interval & duration immediately.
      resetHooks();
      renderRow({
        agentId: "dur-agent",
        timestamp: 1_700_000_005_000,
        item: { data: { text: "currently streaming long reasoning text", phase: "streaming" } },
      });
      advanceClock(800);
      const switchedFromStreamingTree = renderRow({
        agentId: "dur-agent",
        timestamp: 1_700_000_000_500,
        item: { data: { text: "short old", phase: "complete" } },
      });
      check(
        "in-place switch from active streaming row to shorter historic row stops interval and clears badge",
        intervals.size === 0 &&
          findNode(switchedFromStreamingTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null,
        `intervals=${intervals.size}, text=${findNode(switchedFromStreamingTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      // 6b. In-place key switch from active streaming row ("short", 0.5s) to a longer unrelated
      // historic row must flush "short" back to the old key (never polluting old key with the new
      // row's text), so remounting the old row preserves 0.5s and a new same-ms stream does not inherit it.
      resetHooks();
      const cleanOldTs = 1_700_000_005_500;
      const cleanNewTs = 1_700_000_000_800;
      renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "recycle-clean-agent",
        timestamp: cleanOldTs,
        item: { data: { text: "short", phase: "streaming" } },
      });
      advanceClock(500);
      const beforeRecycleTree = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "recycle-clean-agent",
        timestamp: cleanOldTs,
        item: { data: { text: "short", phase: "streaming" } },
      });
      check(
        "streaming row accumulates 0.5s before in-place recycle to longer unrelated row",
        intervals.size === 1 &&
          findNode(beforeRecycleTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "0.5s",
        `text=${findNode(beforeRecycleTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      const afterRecycleTree = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "recycle-clean-agent",
        timestamp: cleanNewTs,
        item: { data: { text: "very long unrelated historic thought", phase: "complete" } },
      });
      check(
        "in-place recycle onto longer unrelated historic row clears interval and badge",
        intervals.size === 0 &&
          findNode(afterRecycleTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null,
        `intervals=${intervals.size}, text=${findNode(afterRecycleTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      resetHooks();
      const remountedShortTree = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "recycle-clean-agent",
        timestamp: cleanOldTs,
        item: { data: { text: "short", phase: "complete" } },
      });
      check(
        "remounting original short row after in-place recycle retains 0.5s without text pollution",
        intervals.size === 0 &&
          findNode(remountedShortTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "0.5s",
        `text=${findNode(remountedShortTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      resetHooks();
      const sameMsUnrelatedStreamTree = renderRow({
        host: { id: "host-a", label: "Host A" },
        agentId: "recycle-clean-agent",
        timestamp: cleanOldTs,
        item: { data: { text: "very long unrelated historic thought", phase: "streaming" } },
      });
      check(
        "new same-ms streaming row with recycled text does not inherit original short row's 0.5s",
        intervals.size === 1 &&
          findNode(sameMsUnrelatedStreamTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null,
        `text=${findNode(sameMsUnrelatedStreamTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      // 7. Host merge-timestamp advance during live streaming and final complete frame
      // carries the same thought's timer forward and migrates cache to the final timestamp.
      resetHooks();
      const driftTs1 = 1_700_000_006_000;
      const driftTs2 = 1_700_000_007_000;
      const driftTs3 = 1_700_000_008_000;
      renderRow({
        agentId: "dur-agent",
        timestamp: driftTs1,
        item: { data: { text: "step 1", phase: "streaming" } },
      });
      advanceClock(1200);
      const driftMidTree = renderRow({
        agentId: "dur-agent",
        timestamp: driftTs2,
        item: { data: { text: "step 1 -> step 2", phase: "streaming" } },
      });
      check(
        "host timestamp advance mid-stream preserves running duration without resetting to 0",
        intervals.size === 1 &&
          findNode(driftMidTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.2s",
        `intervals=${intervals.size}, text=${findNode(driftMidTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      advanceClock(600);
      renderRow({
        agentId: "dur-agent",
        timestamp: driftTs3,
        item: { data: { text: "step 1 -> step 2 -> done", phase: "complete" } },
      });
      advanceClock(300);
      const driftSettledTree = renderRow({
        agentId: "dur-agent",
        timestamp: driftTs3,
        item: { data: { text: "step 1 -> step 2 -> done", phase: "complete" } },
      });
      check(
        "host timestamp advance on final complete frame freezes at cumulative 1.8s",
        intervals.size === 0 &&
          findNode(driftSettledTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.8s",
        `intervals=${intervals.size}, text=${findNode(driftSettledTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      resetHooks();
      const driftRemountTree = renderRow({
        agentId: "dur-agent",
        timestamp: driftTs3,
        item: { data: { text: "step 1 -> step 2 -> done", phase: "complete" } },
      });
      check(
        "remounting with final drifted timestamp preserves migrated 1.8s duration",
        findNode(driftRemountTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.8s",
      );
      unmount();

      // 8. Ultra-short (<100ms) thought does not cross 100ms during the 300ms settle window.
      resetHooks();
      const shortTs = 1_700_000_009_000;
      renderRow({
        agentId: "dur-agent",
        timestamp: shortTs,
        item: { data: { text: "ok", phase: "streaming" } },
      });
      advanceClock(50);
      renderRow({
        agentId: "dur-agent",
        timestamp: shortTs,
        item: { data: { text: "ok!", phase: "complete" } },
      });
      advanceClock(300);
      const shortSettledTree = renderRow({
        agentId: "dur-agent",
        timestamp: shortTs,
        item: { data: { text: "ok!", phase: "complete" } },
      });
      check(
        "ultra-short 50ms thought stays hidden after 300ms settle window (never flashes 0.3s)",
        intervals.size === 0 &&
          findNode(shortSettledTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null,
        `text=${findNode(shortSettledTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      unmount();

      // 9. System clock rollback during streaming preserves monotonicity.
      resetHooks();
      const rollbackTs = 1_700_000_010_000;
      renderRow({
        agentId: "dur-agent",
        timestamp: rollbackTs,
        item: { data: { text: "clock", phase: "streaming" } },
      });
      advanceClock(1500);
      shiftWallClock(-5000); // wall clock jumps backward before segmentStartedAt
      advanceClock(100);
      const rollbackTree = renderRow({
        agentId: "dur-agent",
        timestamp: rollbackTs,
        item: { data: { text: "clock rollback", phase: "streaming" } },
      });
      check(
        "wall-clock rollback keeps elapsed duration strictly monotonic at 1.5s",
        findNode(rollbackTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "1.5s",
        `text=${findNode(rollbackTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children}`,
      );
      shiftWallClock(5000);
      unmount();

      // 10. MAX_DURATION_RECORDS (500) eviction boundary: 501st row evicts the oldest entry.
      resetThinkingDurationsForTests();
      const baseEvictTs = 1_700_001_000_000;
      for (let i = 0; i < 501; i++) {
        resetHooks();
        renderRow({
          agentId: "evict-agent",
          timestamp: baseEvictTs + i * 1000,
          item: { data: { text: `row-${i}`, phase: "streaming" } },
        });
        advanceClock(500);
        unmount();
      }
      resetHooks();
      const evictedOldestTree = renderRow({
        agentId: "evict-agent",
        timestamp: baseEvictTs,
        item: { data: { text: "row-0", phase: "complete" } },
      });
      unmount();
      resetHooks();
      const retainedNewestTree = renderRow({
        agentId: "evict-agent",
        timestamp: baseEvictTs + 500 * 1000,
        item: { data: { text: "row-500", phase: "complete" } },
      });
      check(
        "duration cache evicts oldest entry beyond MAX_DURATION_RECORDS (500) while retaining newest",
        findNode(evictedOldestTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID) === null &&
          findNode(retainedNewestTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "0.5s",
        JSON.stringify({
          oldest: findNode(evictedOldestTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children,
          newest: findNode(retainedNewestTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children,
        }),
      );
      unmount();

      console.log("expanded ScrollView defaults to bottom and smartly follows live updates");
      {
        const scrollCalls = [];
        const attachScrollRef = (tree) => {
          const scroll = findNode(tree, (n) => n.type === "ScrollView");
          if (scroll && scroll.props?.ref) {
            scroll.props.ref.current = {
              scrollToEnd(opts) {
                scrollCalls.push(opts);
              },
            };
          }
          return scroll;
        };
        const renderWithScrollRef = (props) => renderRow(props, attachScrollRef);

        // 1. Opening a completed long thought jumps to the bottom in useEffect as soon
        // as the ref commits, AND survives out-of-order onContentSizeChange -> onScroll(y=0) -> onLayout.
        scrollCalls.length = 0;
        resetHooks();
        const histTs = 1_700_002_000_000;
        const closedHist = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: histTs,
          item: { data: { text: "line1\n".repeat(40), phase: "complete" } },
        });
        findNode(closedHist, (n) => n.type === "Pressable").props.onPress();
        const openHist = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: histTs,
          item: { data: { text: "line1\n".repeat(40), phase: "complete" } },
        });
        const histScroll = findNode(openHist, (n) => n.type === "ScrollView");
        check(
          "expanded ScrollView wires ref, scrollEventThrottle, onContentSizeChange, onScroll and momentum hooks",
          histScroll !== null &&
            histScroll.props?.ref !== undefined &&
            histScroll.props?.scrollEventThrottle === 16 &&
            typeof histScroll.props?.onContentSizeChange === "function" &&
            typeof histScroll.props?.onScroll === "function" &&
            typeof histScroll.props?.onMomentumScrollBegin === "function" &&
            typeof histScroll.props?.onMomentumScrollEnd === "function",
        );
        check(
          "opening a completed thought invokes scrollToEnd in mount effect once ref commits",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          JSON.stringify(scrollCalls),
        );
        // Out-of-order mount sequence: onContentSizeChange fires BEFORE spurious onScroll(y=0) and onLayout.
        scrollCalls.length = 0;
        histScroll.props.onContentSizeChange(320, 1000);
        histScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 0 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 1000 },
          },
        });
        scrollCalls.length = 0;
        histScroll.props.onLayout({ nativeEvent: { layout: { height: 260 } } });
        check(
          "opening a completed thought scrolls to the bottom without animation even after out-of-order onScroll(y=0)",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          JSON.stringify(scrollCalls),
        );
        unmount();

        // 2. Short thought that starts below expandedMaxHeight and later overflows
        // stays sticky when the first non-bottom onScroll(y=0) arrives.
        scrollCalls.length = 0;
        resetHooks();
        const shortFlowTs = 1_700_002_005_000;
        const shortClosed = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: shortFlowTs,
          item: { data: { text: "short", phase: "streaming" } },
        });
        findNode(shortClosed, (n) => n.type === "Pressable").props.onPress();
        const shortOpen = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: shortFlowTs,
          item: { data: { text: "short", phase: "streaming" } },
        });
        const shortScroll = findNode(shortOpen, (n) => n.type === "ScrollView");
        shortScroll.props.onContentSizeChange(320, 40); // fits inside 260px, no onScroll yet
        shortScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 0 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 400 },
          },
        });
        scrollCalls.length = 0;
        shortScroll.props.onContentSizeChange(320, 500);
        check(
          "short thought overflowing past expandedMaxHeight keeps following to bottom",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          JSON.stringify(scrollCalls),
        );
        unmount();

        // 3. Streaming thought follows updates without duplicate pre-layout scrollToEnd,
        // tolerates consecutive growth-lag & downward intermediate onScroll frames,
        // pauses on user upward scroll (and stays paused across timestamp drift),
        // resumes when scrolled back to bottom, guards Native drag/fling windows,
        // tolerates iOS bottom overscroll bounce, and resets on re-open or in-place row switch.
        scrollCalls.length = 0;
        resetHooks();
        const streamTs1 = 1_700_002_010_000;
        const streamTs2 = 1_700_002_011_000;
        const streamClosed = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: streamTs1,
          item: { data: { text: "chunk-1", phase: "streaming" } },
        });
        findNode(streamClosed, (n) => n.type === "Pressable").props.onPress();
        let streamTree = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: streamTs1,
          item: { data: { text: "chunk-1", phase: "streaming" } },
        });
        let streamScroll = findNode(streamTree, (n) => n.type === "ScrollView");
        streamScroll.props.onLayout({ nativeEvent: { layout: { height: 260 } } });
        streamScroll.props.onContentSizeChange(320, 400);
        // Scroll lands at bottom (y=140, viewport=260, content=400).
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 140 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 400 },
          },
        });
        scrollCalls.length = 0;

        // Streaming text update does not fire duplicate pre-layout scrollToEnd in useEffect.
        streamTree = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: streamTs1,
          item: { data: { text: "chunk-1\nchunk-2", phase: "streaming" } },
        });
        streamScroll = findNode(streamTree, (n) => n.type === "ScrollView");
        check(
          "streaming text update waits for layout/onContentSizeChange instead of firing duplicate effect scrollToEnd",
          scrollCalls.length === 0,
          `pre-layout calls=${scrollCalls.length}`,
        );

        // Consecutive growth-lag and downward intermediate onScroll frames must NOT disengage auto-follow.
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 140 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 480 },
          },
        });
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 180 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 480 },
          },
        });
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 180 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 480 },
          },
        });
        streamScroll.props.onContentSizeChange(320, 560);
        check(
          "live growth while at bottom keeps auto-scrolling to end despite consecutive lag and intermediate frames",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          `calls=${scrollCalls.length}`,
        );
        // Land at new bottom (y=300), then simulate iOS overscroll bounce (300 -> 330 -> 300).
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 300 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 560 },
          },
        });
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 330 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 560 },
          },
        });
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 300 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 560 },
          },
        });
        scrollCalls.length = 0;
        streamScroll.props.onContentSizeChange(320, 600);
        check(
          "iOS bottom overscroll bounce back to edge stays sticky",
          scrollCalls.length === 1,
          `calls=${scrollCalls.length}`,
        );
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 340 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 600 },
          },
        });

        // User scrolls up manually (Web wheel / scrollbar to y=120).
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 120 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 600 },
          },
        });
        scrollCalls.length = 0;

        // Next chunk arrives AND host merge advances timestamp -> must NOT yank user back to bottom.
        streamTree = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: streamTs2,
          item: { data: { text: "chunk-1\nchunk-2\nchunk-3", phase: "streaming" } },
        });
        streamScroll = findNode(streamTree, (n) => n.type === "ScrollView");
        streamScroll.props.onContentSizeChange(320, 680);
        check(
          "manual upward scroll pauses auto-follow even across new chunks and merge-timestamp advance",
          scrollCalls.length === 0,
          `unexpected scrollToEnd calls=${scrollCalls.length}`,
        );

        // User scrolls back down near the bottom (distance = 10px <= 24px threshold) -> resumes follow.
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 410 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 680 },
          },
        });
        scrollCalls.length = 0;
        streamTree = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: streamTs2,
          item: { data: { text: "chunk-1\nchunk-2\nchunk-3\nchunk-4", phase: "streaming" } },
        });
        streamScroll = findNode(streamTree, (n) => n.type === "ScrollView");
        streamScroll.props.onContentSizeChange(320, 740);
        check(
          "scrolling back near bottom resumes live auto-follow",
          scrollCalls.length === 1,
          `calls=${scrollCalls.length}`,
        );
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 480 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 740 },
          },
        });

        // Native drag in progress (even inside 24px threshold) and short upward fling window must never yank back.
        scrollCalls.length = 0;
        streamScroll.props.onScrollBeginDrag();
        streamScroll.props.onContentSizeChange(320, 780); // chunk during active touch hold
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 470 }, // moved up 10px, still within 24px of 480 (50px of 780)
            layoutMeasurement: { height: 260 },
            contentSize: { height: 740 },
          },
        });
        streamScroll.props.onScrollEndDrag();
        streamScroll.props.onContentSizeChange(320, 820); // chunk between endDrag and momentumBegin
        streamScroll.props.onMomentumScrollBegin();
        streamScroll.props.onContentSizeChange(320, 860); // chunk during momentum coasting
        streamScroll.props.onMomentumScrollEnd();
        check(
          "native drag hold, short upward fling inside 24px threshold, and momentum window pause auto-follow",
          scrollCalls.length === 0,
          `unexpected calls=${scrollCalls.length}`,
        );

        // Repeated small (-1px) Web wheel upward scrolls disengage stickToBottom cleanly.
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 600 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 860 },
          },
        });
        for (let step = 1; step <= 40; step += 1) {
          streamScroll.props.onScroll({
            nativeEvent: {
              contentOffset: { y: 600 - step },
              layoutMeasurement: { height: 260 },
              contentSize: { height: 860 },
            },
          });
        }
        scrollCalls.length = 0;
        streamScroll.props.onContentSizeChange(320, 920);
        check(
          "40 consecutive -1px upward wheel scrolls disengage stick-to-bottom",
          scrollCalls.length === 0,
          `unexpected scrollToEnd calls=${scrollCalls.length}`,
        );

        // Scrolling back to bottom resumes sticky state, and pending follow requests skipped
        // during native drag or momentum while still at the bottom flush when gestures end.
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 660 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 920 },
          },
        });
        scrollCalls.length = 0;
        streamScroll.props.onScrollBeginDrag();
        streamScroll.props.onContentSizeChange(320, 980);
        check(
          "content growth during active native drag hold defers scrollToEnd",
          scrollCalls.length === 0,
          `unexpected calls=${scrollCalls.length}`,
        );
        streamScroll.props.onScrollEndDrag({
          nativeEvent: {
            velocity: { y: 0 },
            contentOffset: { y: 660 },
            targetContentOffset: { y: 660 },
          },
        });
        check(
          "ending native drag while still sticky flushes the deferred scrollToEnd",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          JSON.stringify(scrollCalls),
        );

        // Parameterless onScrollEndDrag() (e.g. Android or synthetic callers without velocity)
        // defers flush to a 0ms macrotask so an immediate momentumBegin can still cancel it.
        scrollCalls.length = 0;
        streamScroll.props.onScrollBeginDrag();
        streamScroll.props.onContentSizeChange(320, 1000);
        streamScroll.props.onScrollEndDrag();
        check(
          "parameterless onScrollEndDrag defers flush past synchronous turn",
          scrollCalls.length === 0,
          `unexpected sync calls=${scrollCalls.length}`,
        );
        advanceClock(0);
        check(
          "parameterless onScrollEndDrag with no momentum flushes on 0ms macrotask",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          JSON.stringify(scrollCalls),
        );

        // Real iOS ordering: onScrollBeginDrag -> onContentSizeChange -> onScrollEndDrag(velocity) ->
        // onMomentumScrollBegin -> onMomentumScrollEnd must not yank before momentum finishes.
        scrollCalls.length = 0;
        streamScroll.props.onScrollBeginDrag();
        streamScroll.props.onContentSizeChange(320, 1020);
        streamScroll.props.onScrollEndDrag({
          nativeEvent: {
            velocity: { y: -0.8 },
            contentOffset: { y: 660 },
            targetContentOffset: { y: 740 },
          },
        });
        check(
          "iOS endDrag with momentum velocity does not yank before onMomentumScrollBegin",
          scrollCalls.length === 0,
          `unexpected calls=${scrollCalls.length}`,
        );
        advanceClock(50);
        check(
          "iOS endDrag stays deferred within 120ms momentum handoff window",
          scrollCalls.length === 0,
          `unexpected calls=${scrollCalls.length}`,
        );
        streamScroll.props.onMomentumScrollBegin();
        advanceClock(200);
        check(
          "once iOS momentum begins, timer is cancelled and flush waits for momentumEnd",
          scrollCalls.length === 0,
          `unexpected calls=${scrollCalls.length}`,
        );
        streamScroll.props.onMomentumScrollEnd();
        check(
          "iOS momentumEnd flushes deferred scrollToEnd once",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          JSON.stringify(scrollCalls),
        );

        // Parameterless endDrag -> momentumBegin -> momentumEnd ordering also cancels 0ms timer cleanly.
        scrollCalls.length = 0;
        streamScroll.props.onScrollBeginDrag();
        streamScroll.props.onContentSizeChange(320, 1030);
        streamScroll.props.onScrollEndDrag();
        check(
          "parameterless endDrag before momentumBegin does not scroll prematurely",
          scrollCalls.length === 0,
          `unexpected calls=${scrollCalls.length}`,
        );
        streamScroll.props.onMomentumScrollBegin();
        advanceClock(50);
        check(
          "momentumBegin cancels parameterless endDrag 0ms timer",
          scrollCalls.length === 0,
          `unexpected calls=${scrollCalls.length}`,
        );
        streamScroll.props.onMomentumScrollEnd();
        check(
          "parameterless endDrag -> momentumBegin -> momentumEnd flushes once at momentumEnd",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          JSON.stringify(scrollCalls),
        );

        // Drag hold + content growth + stationary onScroll (y unchanged) stays sticky and flushes on stationary endDrag.
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 770 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 1030 },
          },
        });
        scrollCalls.length = 0;
        streamScroll.props.onScrollBeginDrag();
        streamScroll.props.onContentSizeChange(320, 1110);
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 770 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 1110 },
          },
        });
        streamScroll.props.onScrollEndDrag({
          nativeEvent: {
            velocity: { y: 0 },
            contentOffset: { y: 770 },
            targetContentOffset: { y: 770 },
          },
        });
        check(
          "content growth with stationary y during drag hold stays sticky and flushes on endDrag",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          JSON.stringify(scrollCalls),
        );

        // Drag hold + content growth + genuine upward drag disengages stickiness (0 scrollToEnd after endDrag).
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 850 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 1110 },
          },
        });
        scrollCalls.length = 0;
        streamScroll.props.onScrollBeginDrag();
        streamScroll.props.onContentSizeChange(320, 1180);
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 800 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 1180 },
          },
        });
        streamScroll.props.onScrollEndDrag({
          nativeEvent: {
            velocity: { y: 0 },
            contentOffset: { y: 800 },
            targetContentOffset: { y: 800 },
          },
        });
        check(
          "genuine upward drag while content grows disengages stickiness and never yanks on endDrag",
          scrollCalls.length === 0,
          `unexpected calls=${scrollCalls.length}`,
        );

        // iOS bottom overscroll bounce (y=635 > maxReachableY=600) with concurrent content growth
        // (contentH 860 -> 940, bounce settles to y=620) must remain sticky and follow subsequent growth.
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 600 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 860 },
          },
        });
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 635 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 860 },
          },
        });
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 620 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 940 },
          },
        });
        scrollCalls.length = 0;
        streamScroll.props.onContentSizeChange(320, 1000);
        check(
          "iOS bottom overscroll bounce during concurrent content growth remains sticky",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          JSON.stringify(scrollCalls),
        );

        // Reset back to bottom before the overlapping drag+momentum test below.
        streamScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 740 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 1000 },
          },
        });

        // Same deferred flush across overlapping drag + momentum coasting at the bottom.
        scrollCalls.length = 0;
        streamScroll.props.onScrollBeginDrag();
        streamScroll.props.onMomentumScrollBegin();
        streamScroll.props.onContentSizeChange(320, 1040);
        streamScroll.props.onScrollEndDrag();
        check(
          "deferred scrollToEnd waits until momentum also finishes",
          scrollCalls.length === 0,
          `unexpected calls=${scrollCalls.length}`,
        );
        streamScroll.props.onMomentumScrollEnd();
        check(
          "ending momentum while still sticky flushes the deferred scrollToEnd",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          JSON.stringify(scrollCalls),
        );

        // Virtual-list in-place key switch to a different row while open resets stick-to-bottom and jumps to end.
        scrollCalls.length = 0;
        const switchedOpenTree = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: 1_700_002_099_000,
          item: { data: { text: "another historic row\n".repeat(20), phase: "complete" } },
        });
        const switchedScroll = findNode(switchedOpenTree, (n) => n.type === "ScrollView");
        check(
          "in-place key switch while expanded resets stick-to-bottom and scrolls new row to end",
          scrollCalls.length === 1 && scrollCalls[0]?.animated === false,
          JSON.stringify(scrollCalls),
        );
        // Scroll up on the new row, then collapse and re-expand to verify re-open resets to bottom.
        switchedScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 300 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 560 },
          },
        });
        switchedScroll.props.onScroll({
          nativeEvent: {
            contentOffset: { y: 80 },
            layoutMeasurement: { height: 260 },
            contentSize: { height: 560 },
          },
        });
        findNode(switchedOpenTree, (n) => n.type === "Pressable").props.onPress(); // collapse
        const collapsedAgain = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: 1_700_002_099_000,
          item: { data: { text: "another historic row\n".repeat(20), phase: "complete" } },
        });
        scrollCalls.length = 0;
        findNode(collapsedAgain, (n) => n.type === "Pressable").props.onPress(); // re-open
        const reopened = renderWithScrollRef({
          agentId: "scroll-agent",
          timestamp: 1_700_002_099_000,
          item: { data: { text: "another historic row\n".repeat(20), phase: "complete" } },
        });
        const reopenedScroll = findNode(reopened, (n) => n.type === "ScrollView");
        reopenedScroll.props.onContentSizeChange(320, 560);
        check(
          "re-expanding after collapsing resets stick-to-bottom and jumps to the bottom",
          scrollCalls.length === 2 && scrollCalls.every((c) => c?.animated === false),
          JSON.stringify(scrollCalls),
        );
        unmount();
      }

      console.log("terminal phase drops ink-stream liveHint immediately & committed updates pass firstPaint=false");
      {
        const { resetNewestForTests } = require(join(dirname(componentPath), "newest.js"));

        // 11. Terminal phase (`streaming` -> `complete`) immediately drops `useInkStreamReveal`'s
        // `liveHint` to `false` without waiting for the 300ms `growing` debounce, while
        // RowStatusIcon, TextShimmer, and thinking duration still obey the 300ms debounce.
        resetHooks();
        inkStreamCalls.length = 0;
        const revealTs = 1_700_003_000_000;
        const streamingRevealTree = renderRow({
          agentId: "reveal-agent",
          timestamp: revealTs,
          item: { data: { text: "reasoning step one", phase: "streaming" } },
        });
        advanceClock(400);
        const streamingRevealTickTree = renderRow({
          agentId: "reveal-agent",
          timestamp: revealTs,
          item: { data: { text: "reasoning step one", phase: "streaming" } },
        });
        const streamingLiveHint = inkStreamCalls[inkStreamCalls.length - 1]?.liveHint;
        const streamingIconStatus = findNode(
          streamingRevealTickTree,
          (n) => typeof n.type === "function" && n.type.name === "RowStatusIcon",
        )?.props?.status;
        check(
          "while streaming, useInkStreamReveal receives liveHint=true and RowStatusIcon is running",
          streamingLiveHint === true &&
            streamingIconStatus === "running" &&
            findShimmerActive(streamingRevealTree) === true,
          JSON.stringify({ liveHint: streamingLiveHint, iconStatus: streamingIconStatus }),
        );

        inkStreamCalls.length = 0;
        const completeImmediateTree = renderRow({
          agentId: "reveal-agent",
          timestamp: revealTs,
          item: { data: { text: "reasoning step one done", phase: "complete" } },
        });
        const completeLiveHint = inkStreamCalls[inkStreamCalls.length - 1]?.liveHint;
        const completeImmediateIconStatus = findNode(
          completeImmediateTree,
          (n) => typeof n.type === "function" && n.type.name === "RowStatusIcon",
        )?.props?.status;
        check(
          "transitioning to phase=complete immediately passes liveHint=false to useInkStreamReveal while icon/shimmer/duration hold 300ms debounce",
          completeLiveHint === false &&
            completeImmediateIconStatus === "running" &&
            findShimmerActive(completeImmediateTree) === true &&
            findNode(completeImmediateTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children === "0.4s",
          JSON.stringify({
            liveHint: completeLiveHint,
            iconStatus: completeImmediateIconStatus,
            shimmer: findShimmerActive(completeImmediateTree),
            duration: findNode(completeImmediateTree, (n) => n.props?.testID === THINKING_DURATION_TEST_ID)?.props?.children,
          }),
        );
        advanceClock(299);
        const complete299Tree = renderRow({
          agentId: "reveal-agent",
          timestamp: revealTs,
          item: { data: { text: "reasoning step one done", phase: "complete" } },
        });
        advanceClock(1);
        const complete300Tree = renderRow({
          agentId: "reveal-agent",
          timestamp: revealTs,
          item: { data: { text: "reasoning step one done", phase: "complete" } },
        });
        check(
          "RowStatusIcon stays running at +299ms and flips to completed at +300ms",
          findNode(complete299Tree, (n) => typeof n.type === "function" && n.type.name === "RowStatusIcon")?.props?.status === "running" &&
            findNode(complete300Tree, (n) => typeof n.type === "function" && n.type.name === "RowStatusIcon")?.props?.status === "completed",
          JSON.stringify({
            at299: findNode(complete299Tree, (n) => typeof n.type === "function" && n.type.name === "RowStatusIcon")?.props?.status,
            at300: findNode(complete300Tree, (n) => typeof n.type === "function" && n.type.name === "RowStatusIcon")?.props?.status,
          }),
        );
        unmount();

        // 11b. Terminal phase (`streaming` -> `complete`) must immediately switch the collapsed
        // summary from `streamingTail` to completed `firstLine` without waiting for the 300ms
        // `growing` debounce — and an unmeasured (`lineWidth === 0`) short single-line thought
        // must never render an empty summary on its terminal first frame.
        const readCollapsedPreview = (tree) => {
          const shimmer = findNode(tree, (n) => n.type === "TextShimmer");
          const content =
            typeof shimmer?.props?.children === "function" ? shimmer.props.children(null) : tree;
          const node = findNode(content, (n) => n.type === "Text" && n.props?.numberOfLines === 1);
          const raw = node?.props?.children;
          return Array.isArray(raw) ? raw.join("") : String(raw ?? "");
        };
        resetHooks();
        const summaryTs = 1_700_003_005_000;
        const multiLineThought =
          "First summary line\nmiddle reasoning paragraph\nfinal streaming tail tokens that should vanish immediately on complete";
        const measuredStreamingTree = renderRow({
          agentId: "summary-snap-agent",
          timestamp: summaryTs,
          item: { data: { text: multiLineThought, phase: "streaming" } },
        });
        const headForSnap = findNode(measuredStreamingTree, (n) => n.type === "Pressable");
        headForSnap.props.onLayout({ nativeEvent: { layout: { width: 220 } } });
        const shimmerForSnap = findNode(measuredStreamingTree, (n) => n.type === "TextShimmer");
        const labelForSnap = findNode(
          shimmerForSnap.props.children(null),
          (n) => n.type === "Text" && typeof n.props?.onLayout === "function",
        );
        labelForSnap.props.onLayout({ nativeEvent: { layout: { width: 26 } } });
        const streamingWithWidthTree = renderRow({
          agentId: "summary-snap-agent",
          timestamp: summaryTs,
          item: { data: { text: multiLineThought, phase: "streaming" } },
        });
        const streamingPreviewText = readCollapsedPreview(streamingWithWidthTree);
        const completeImmediateSnapTree = renderRow({
          agentId: "summary-snap-agent",
          timestamp: summaryTs,
          item: { data: { text: multiLineThought, phase: "complete" } },
        });
        const completeImmediatePreviewText = readCollapsedPreview(completeImmediateSnapTree);
        const completeImmediateIcon = findNode(
          completeImmediateSnapTree,
          (n) => typeof n.type === "function" && n.type.name === "RowStatusIcon",
        )?.props?.status;
        check(
          "collapsed summary snaps from streaming tail to completed first line immediately on phase=complete while icon still holds 300ms debounce",
          streamingPreviewText !== "First summary line" &&
            streamingPreviewText.includes("complete") &&
            completeImmediatePreviewText === "First summary line" &&
            completeImmediateIcon === "running",
          JSON.stringify({
            streamingPreviewText,
            completeImmediatePreviewText,
            completeImmediateIcon,
          }),
        );
        unmount();

        resetHooks();
        renderRow({
          agentId: "summary-unmeasured-agent",
          timestamp: summaryTs + 1000,
          item: { data: { text: "Short unmeasured thought", phase: "streaming" } },
        });
        const unmeasuredCompleteTree = renderRow({
          agentId: "summary-unmeasured-agent",
          timestamp: summaryTs + 1000,
          item: { data: { text: "Short unmeasured thought", phase: "complete" } },
        });
        const unmeasuredCompletePreview = readCollapsedPreview(unmeasuredCompleteTree);
        check(
          "unmeasured short thought renders full first line immediately on terminal first frame (never empty)",
          unmeasuredCompletePreview === "Short unmeasured thought",
          JSON.stringify({ unmeasuredCompletePreview }),
        );
        unmount();

        // 11c. Scroll follow regressions: multi-frame iOS bottom overscroll bounce stays sticky
        //      and Web near-bottom upward scroll inside the 24px threshold does not re-stick.
        resetHooks();
        const scrollTs = 1_700_003_008_000;
        const scrollTree0 = renderRow({
          agentId: "scroll-reg-agent",
          timestamp: scrollTs,
          item: { data: { text: "streaming body", phase: "streaming" } },
        });
        const scrollHead = findNode(scrollTree0, (n) => n.type === "Pressable");
        scrollHead.props.onPress(); // expand
        const scrollTree1 = renderRow({
          agentId: "scroll-reg-agent",
          timestamp: scrollTs,
          item: { data: { text: "streaming body expanded", phase: "streaming" } },
        });
        const sv = findNode(scrollTree1, (n) => n.type === "ScrollView");
        let scrollToEndCalls = 0;
        sv.props.ref.current = { scrollToEnd: () => { scrollToEndCalls += 1; } };
        // Land at bottom (contentH=860, viewport=260, maxReachableY=600).
        sv.props.onScroll({ nativeEvent: { contentOffset: { y: 600 }, layoutMeasurement: { height: 260 }, contentSize: { height: 860 } } });
        // Multi-frame iOS bottom overscroll bounce (600 -> 635 -> 620 -> 600) with concurrent growth (860 -> 940 -> 960).
        sv.props.onScroll({ nativeEvent: { contentOffset: { y: 635 }, layoutMeasurement: { height: 260 }, contentSize: { height: 860 } } });
        sv.props.onScroll({ nativeEvent: { contentOffset: { y: 620 }, layoutMeasurement: { height: 260 }, contentSize: { height: 940 } } });
        sv.props.onScroll({ nativeEvent: { contentOffset: { y: 605 }, layoutMeasurement: { height: 260 }, contentSize: { height: 960 } } });
        scrollToEndCalls = 0;
        sv.props.onContentSizeChange(300, 1000);
        const stayedStickyAfterMultiFrameBounce = scrollToEndCalls === 1;

        // Now land at bottom (y=740, contentH=1000, viewport=260), then scroll up 10px (inside 24px threshold)
        // and settle 2px further up without moving down -> must disengage and NOT re-stick.
        sv.props.onScroll({ nativeEvent: { contentOffset: { y: 740 }, layoutMeasurement: { height: 260 }, contentSize: { height: 1000 } } });
        sv.props.onScroll({ nativeEvent: { contentOffset: { y: 730 }, layoutMeasurement: { height: 260 }, contentSize: { height: 1000 } } });
        sv.props.onScroll({ nativeEvent: { contentOffset: { y: 729.5 }, layoutMeasurement: { height: 260 }, contentSize: { height: 1000 } } });
        scrollToEndCalls = 0;
        sv.props.onContentSizeChange(300, 1080);
        const stayedDisengagedOnNearBottomUpScroll = scrollToEndCalls === 0;
        check(
          "multi-frame iOS bottom overscroll bounce stays sticky while near-bottom upward scroll stays disengaged",
          stayedStickyAfterMultiFrameBounce && stayedDisengagedOnNearBottomUpScroll,
          JSON.stringify({ stayedStickyAfterMultiFrameBounce, stayedDisengagedOnNearBottomUpScroll }),
        );
        unmount();

        // 12. Existing thinking row updating its timestamp after initial commit must pass
        // `firstPaint=false` to `noteRender` (alongside a stable 4th-arg identity).
        resetHooks();
        resetNewestForTests("fp-agent");
        noteRenderCalls.length = 0;
        const fpTs1 = 1_700_003_010_000;
        const fpTs2 = 1_700_003_011_000;
        renderRow({
          agentId: "fp-agent",
          timestamp: fpTs1,
          item: { data: { text: "step 1", phase: "streaming" } },
        });
        const firstMountCall = noteRenderCalls[0];
        check(
          "initial mount passes firstPaint=true and non-empty 4th-arg identity to noteRender",
          Array.isArray(firstMountCall) &&
            firstMountCall[0] === "fp-agent" &&
            firstMountCall[1] === fpTs1 &&
            firstMountCall[2] === true &&
            firstMountCall.length >= 4 &&
            firstMountCall[3] !== undefined &&
            firstMountCall[3] !== null,
          JSON.stringify(firstMountCall),
        );

        noteRenderCalls.length = 0;
        renderRow({
          agentId: "fp-agent",
          timestamp: fpTs2,
          item: { data: { text: "step 1 -> step 2", phase: "streaming" } },
        });
        check(
          "subsequent timestamp update on committed thinking row passes firstPaint=false to noteRender",
          noteRenderCalls.length > 0 &&
            noteRenderCalls.every(
              (call) =>
                call[0] === "fp-agent" &&
                call[1] === fpTs2 &&
                call[2] === false &&
                call.length >= 4 &&
                call[3] !== undefined &&
                call[3] !== null,
            ),
          JSON.stringify(noteRenderCalls),
        );
        unmount();
        resetNewestForTests("fp-agent");
      }
    } finally {
      Date.now = realDateNow;
      resetThinkingDurationsForTests();
    }
  }

  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
