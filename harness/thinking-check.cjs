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
 *   npx tsc client/thinking-text.ts \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/thinking-check.cjs .dbg/
 *   cd .dbg && node thinking-check.cjs
 */
"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  advanceEm,
  firstLine,
  latestCompletedParagraphFirstLine,
  reasoningPreview,
  streamingTail,
} = require("./client/thinking-text.js");

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
  // Asserted at the source because it is a wiring property, and this repo asserts
  // pure modules and constant tables rather than React components.
  const source = readFileSync(join(__dirname, "..", "client", "inline-thinking.tsx"), "utf8");
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
  check(
    "and the collapsed line previews the item's own text",
    /reasoningPreview\(\s*text\s*,/.test(code),
    (code.match(/reasoningPreview\([^)]*\)/g) ?? []).join(" | ") || "(no call found)",
  );
  check(
    "and `growing` is derived from that same text",
    /useGrowing\(\s*text\s*,/.test(code),
    (code.match(/useGrowing\([^)]*\)/g) ?? []).join(" | ") || "(no call found)",
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
  // The window is worthless if the component neither measures its box nor prefers
  // the tail while the thought is still growing.
  const code = readFileSync(join(__dirname, "..", "client", "inline-thinking.tsx"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  check("the row measures the preview box", /onLayout=\{[^}]*layout\.width/.test(code));
  check(
    "and shows the tail while growing, dsh's rule otherwise",
    /growing && boxWidth > 0\s*\?\s*streamingTail\(\s*text\s*,\s*boxWidth\s*,/.test(code),
    (code.match(/streamingTail\([^)]*\)/g) ?? []).join(" | ") || "(no call found)",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
