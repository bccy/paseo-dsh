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
        && mentions(expression, "ROW_HEAD_GAP");
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
  };

  // Stand-ins for the host modules only; `./thinking-text`, `./tokens` and
  // `./locale` are the real compiled modules.
  const stubs = {
    react: () => hooks,
    "react/jsx-runtime": () => ({
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
      Fragment: "Fragment",
    }),
    "react-native": () => ({ Image: "Image", Pressable: "Pressable", Text: "Text", View: "View" }),
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

  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
