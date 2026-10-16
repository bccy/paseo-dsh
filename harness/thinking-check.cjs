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

const {
  firstLine,
  latestCompletedParagraphFirstLine,
  reasoningPreview,
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
