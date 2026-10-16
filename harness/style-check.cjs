/**
 * Offline assertions for the shared row-style token table.
 *
 * Phase 1 moved every number of the tool row into `client/tokens.ts` because
 * "looks like DSH" is a table of values, and a drifted value is invisible in a
 * screenshot: 13px instead of 14, a dot instead of a 2x2 square, a wash at 20%
 * instead of 8% all still render, they just stop matching. So the table itself
 * is asserted here, in the same spirit as `sweep-check.cjs` asserting the
 * sweep's geometry. The React components are deliberately not asserted.
 *
 * Run (from paseo-plugin):
 *   npx tsc client/tokens.ts \
 *     --outDir .dbg --rootDir . --module commonjs --moduleResolution node \
 *     --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/style-check.cjs .dbg/
 *   cd .dbg && node style-check.cjs
 */
"use strict";

const {
  BODY_INDENT,
  CARD_RADIUS,
  CODE_FONT_FAMILY,
  CODE_FONT_SIZE,
  CODE_LINE_HEIGHT,
  CODE_MAX_HEIGHT,
  COMMAND_FONT_SIZE,
  COMMAND_LINE_HEIGHT,
  COMMAND_PADDING_HORIZONTAL,
  COMMAND_PADDING_VERTICAL,
  DIFF_BAR_WIDTH,
  DIFF_LINE_PADDING_HORIZONTAL,
  DIFF_STAT_FONT_SIZE,
  DIFF_STAT_MARGIN_LEFT,
  DIFF_TINT_DARK,
  DIFF_TINT_LIGHT,
  FOLD_LINES,
  HAIRLINE,
  OUTPUT_FONT_SIZE,
  OUTPUT_LINE_HEIGHT,
  OUTPUT_PADDING_HORIZONTAL,
  OUTPUT_PADDING_VERTICAL,
  ROW_FONT_SIZE,
  ROW_HEAD_GAP,
  ROW_HEIGHT,
  ROW_LINE_HEIGHT,
  SEP_MARGIN,
  SEP_RADIUS,
  SEP_SIZE,
  TERMINAL_MAX_LINES,
  cardStyle,
  codeRegionStyle,
  codeTextStyle,
  commandRegionStyle,
  commandTextStyle,
  diffBodyTextStyle,
  diffLineStyle,
  diffMarkerTextStyle,
  diffShaped,
  diffStat,
  diffStatTextStyle,
  diffTextColor,
  diffTint,
  diffTotals,
  dividerStyle,
  isCommandBlock,
  isLightSurface,
  outputRegionStyle,
  outputTextStyle,
  rowHeadStyle,
  rowIconColor,
  rowLabelTextStyle,
  rowRootStyle,
  separatorStyle,
  summaryColor,
  summaryTextStyle,
  withAlpha,
} = require("./client/tokens.js");

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

function equal(label, actual, expected) {
  check(label, actual === expected, `got ${JSON.stringify(actual)}`);
}

/** Paseo's own palette, at the values the preview uses. */
const COLORS = {
  surface0: "#101011",
  surface1: "#1c1c1f",
  surface2: "#26262a",
  border: "#2e2e33",
  foreground: "#fafafa",
  foregroundMuted: "#a1a1aa",
  statusSuccess: "#6cb17b",
  statusWarning: "#d8b47b",
  statusDanger: "#d8847b",
};

console.log("the row head is a fixed 24px line");
{
  equal("row height", ROW_HEIGHT, 24);
  equal("row font size", ROW_FONT_SIZE, 13);
  equal("row line height", ROW_LINE_HEIGHT, 24);
  equal("no vertical padding left on the row", rowRootStyle().paddingVertical, 0);
  equal("the head line is exactly the row height", rowHeadStyle().height, 24);
  equal("icon to title gap", ROW_HEAD_GAP, 6);
  equal("expanded body indent", BODY_INDENT, 4);
  check("the body indent is not the old 12", BODY_INDENT !== 12, `got ${BODY_INDENT}`);
}

console.log("the summary is the UI font, not code");
{
  const summary = summaryTextStyle(COLORS, "completed");
  check("no font family on the summary", !("fontFamily" in summary), JSON.stringify(summary));
  equal("summary size", summary.fontSize, 13);
  equal("summary line height", summary.lineHeight, 24);
  equal("summary takes the free space", summary.flex, 1);
  equal("monospace is the code family", CODE_FONT_FAMILY, "monospace");
  check(
    "and only code surfaces use it",
    codeTextStyle(COLORS).fontFamily === "monospace" &&
      !("fontFamily" in rowLabelTextStyle(COLORS)),
  );
}

console.log("title and summary are split by a 2x2 square");
{
  const sep = separatorStyle(COLORS);
  equal("separator size (w)", SEP_SIZE, 2);
  equal("separator size (h)", sep.height, 2);
  equal("separator width in the row", sep.width, 2);
  equal("separator radius", SEP_RADIUS, 1);
  check(
    "drawn as its own 2x2 box (DSH's `.sep`), not a text glyph",
    "width" in sep && "height" in sep && !("fontSize" in sep),
  );
  equal("separator margin", SEP_MARGIN, 8);
  equal("separator margin is symmetric", sep.marginHorizontal, 8);
  equal("separator colour", sep.backgroundColor, COLORS.foregroundMuted);
}

console.log("the diff stat suffix");
{
  const stat = diffStatTextStyle(COLORS);
  equal("stat size (13 - 2)", DIFF_STAT_FONT_SIZE, 11);
  equal("stat left margin", DIFF_STAT_MARGIN_LEFT, 10);
  equal("stat is monospace", stat.fontFamily, CODE_FONT_FAMILY);
  equal("stat sits on the row line", stat.lineHeight, ROW_LINE_HEIGHT);
  equal("and is grey until expanded colouring lands", stat.color, COLORS.foregroundMuted);
}

console.log("the command banner and the output region are split");
{
  equal("banner padding V", COMMAND_PADDING_VERTICAL, 9);
  equal("banner padding H", COMMAND_PADDING_HORIZONTAL, 14);
  equal("command size", COMMAND_FONT_SIZE, 11);
  equal("command line height", COMMAND_LINE_HEIGHT, 16);
  equal("command region", JSON.stringify(commandRegionStyle()), JSON.stringify({ paddingVertical: 9, paddingHorizontal: 14 }));
  const command = commandTextStyle(COLORS);
  equal("command size in the style", command.fontSize, 11);
  equal("command line height in the style", command.lineHeight, 16);
  equal("command uses the high-contrast foreground", command.color, COLORS.foreground);
  equal("command is monospace", command.fontFamily, CODE_FONT_FAMILY);

  equal("output padding V", OUTPUT_PADDING_VERTICAL, 12);
  equal("output padding H", OUTPUT_PADDING_HORIZONTAL, 14);
  equal("output size", OUTPUT_FONT_SIZE, 11);
  equal("output line height", OUTPUT_LINE_HEIGHT, 18);
  equal("output region", JSON.stringify(outputRegionStyle()), JSON.stringify({ paddingVertical: 12, paddingHorizontal: 14 }));
  const output = outputTextStyle(COLORS);
  equal("output size in the style", output.fontSize, 11);
  equal("output line height in the style", output.lineHeight, 18);
  equal("output keeps foreground contrast", output.color, COLORS.foreground);

  equal("code size", CODE_FONT_SIZE, 11);
  equal("code line height", CODE_LINE_HEIGHT, 19);
  equal("code region", JSON.stringify(codeRegionStyle()), JSON.stringify({ paddingVertical: 12, paddingHorizontal: 14 }));
  check("the command line is tighter than the output", COMMAND_LINE_HEIGHT < OUTPUT_LINE_HEIGHT);
}

console.log("which block is a command block");
{
  const shell = { diff: false, code: false, headline: "pnpm lint", bodyLabel: "输出" };
  check("a shell row", isCommandBlock(shell) === true);
  check(
    "a slash-command row (same shape)",
    isCommandBlock({ ...shell, headline: "/compact" }) === true,
  );
  check(
    "web_fetch is not (its body label is 响应)",
    isCommandBlock({ diff: false, code: false, headline: "https://x", bodyLabel: "响应" }) === false,
  );
  check(
    "sub_agent is not (日志)",
    isCommandBlock({ diff: false, code: false, headline: "look", bodyLabel: "日志" }) === false,
  );
  check(
    "read is not (内容, and it is code)",
    isCommandBlock({ diff: false, code: true, headline: "a.ts", bodyLabel: "内容" }) === false,
  );
  check(
    "a diff row is not",
    isCommandBlock({ diff: true, code: true, headline: "", bodyLabel: "改动" }) === false,
  );
  check(
    "a row with no command is not",
    isCommandBlock({ ...shell, headline: "" }) === false,
  );
  check(
    "the caption is a parameter, so a localized tree keeps the split",
    isCommandBlock({ ...shell, bodyLabel: "Output" }, ["Output"]) === true,
  );
  check(
    "and a caption that does not match is not a command block",
    isCommandBlock(shell, ["Output"]) === false,
  );
}

console.log("diff lines: 3px bar, 8% (12% dark) wash");
{
  equal("bar width", DIFF_BAR_WIDTH, 3);
  equal("light wash", DIFF_TINT_LIGHT, 0.08);
  equal("dark wash", DIFF_TINT_DARK, 0.12);
  equal("light tint value", diffTint(COLORS.statusSuccess, true), "rgba(108, 177, 123, 0.08)");
  equal("dark tint value", diffTint(COLORS.statusSuccess, false), "rgba(108, 177, 123, 0.12)");

  const add = diffLineStyle(COLORS, "add", false);
  equal("added bar is solid success", add.borderLeftColor, COLORS.statusSuccess);
  equal("added bar width", add.borderLeftWidth, 3);
  equal("added wash", add.backgroundColor, "rgba(108, 177, 123, 0.12)");

  const del = diffLineStyle(COLORS, "del", false);
  equal("removed bar is solid danger", del.borderLeftColor, COLORS.statusDanger);
  equal("removed wash", del.backgroundColor, "rgba(216, 132, 123, 0.12)");

  const context = diffLineStyle(COLORS, "context", false);
  equal("context keeps the marker column's width", context.borderLeftWidth, DIFF_BAR_WIDTH);
  equal("but draws no bar", context.borderLeftColor, "transparent");
  check("and no wash", context.backgroundColor === undefined, String(context.backgroundColor));

  equal("added text is semantic", diffTextColor(COLORS, "add"), COLORS.statusSuccess);
  equal("removed text is semantic", diffTextColor(COLORS, "del"), COLORS.statusDanger);
  equal("context text is muted", diffTextColor(COLORS, "context"), COLORS.foregroundMuted);
  equal("diff line padding H", DIFF_LINE_PADDING_HORIZONTAL, 14);

  const marker = diffMarkerTextStyle(COLORS, "add");
  const body = diffBodyTextStyle(COLORS, "add");
  equal("marker is monospace at code size", marker.fontSize, CODE_FONT_SIZE);
  equal("marker aligns to one column width", marker.width, 12);
  equal("diff body text is monospace", body.fontFamily, CODE_FONT_FAMILY);
  equal("diff body text takes the rest of the line", body.flex, 1);
}

console.log("the card");
{
  equal("card radius", CARD_RADIUS, 16);
  equal("hairline design value", HAIRLINE, 0.5);
  const card = cardStyle(COLORS);
  equal("radius in the style", card.borderRadius, 16);
  equal("border is one hairline", card.borderWidth, 0.5);
  equal("border colour is the theme's", card.borderColor, COLORS.border);
  equal("card surface", card.backgroundColor, COLORS.surface1);
  equal("the card clips its own corners", card.overflow, "hidden");
  equal("RN's device hairline passes through", cardStyle(COLORS, 0.33).borderWidth, 0.33);
  equal("divider is the same hairline", dividerStyle(COLORS).height, 0.5);
  equal("divider colour", dividerStyle(COLORS).backgroundColor, COLORS.border);
}

console.log("light or dark decides the wash");
{
  check("white is light", isLightSurface("#ffffff") === true);
  check("a dark card is not", isLightSurface(COLORS.surface1) === false);
  check("rgb() is understood too", isLightSurface("rgb(28, 28, 31)") === false);
  check("and a light rgb()", isLightSurface("rgb(250, 250, 250)") === true);
  check("an unknown format is treated as dark", isLightSurface("var(--x)") === false);
  check(
    "the two themes really differ",
    diffTint(COLORS.statusDanger, true) !== diffTint(COLORS.statusDanger, false),
  );
}

console.log("translucent tints");
{
  equal("6-digit hex", withAlpha("#6cb17b", 0.12), "rgba(108, 177, 123, 0.12)");
  equal("3-digit hex", withAlpha("#abc", 0.08), "rgba(170, 187, 204, 0.08)");
  equal("rgb()", withAlpha("rgb(10, 20, 30)", 0.5), "rgba(10, 20, 30, 0.5)");
  equal("rgba() replaces its alpha", withAlpha("rgba(10,20,30,0.9)", 0.5), "rgba(10, 20, 30, 0.5)");
  equal("8-digit hex drops its own alpha", withAlpha("#0a141eff", 0.5), "rgba(10, 20, 30, 0.5)");
  equal(
    "an unparseable colour drops the wash rather than the text",
    withAlpha("var(--x)", 0.5),
    "transparent",
  );
}

console.log("diff totals");
{
  equal("adds and removes", JSON.stringify(diffTotals("@@\n-old\n+new\n keep")), '{"added":1,"removed":1}');
  equal("file headers do not count", JSON.stringify(diffTotals("+++ b/x\n--- a/x\n+one")), '{"added":1,"removed":0}');
  equal("an empty body counts nothing", JSON.stringify(diffTotals("")), '{"added":0,"removed":0}');

  check("a unified diff is diff-shaped", diffShaped("@@ -1 +1 @@\n-a\n+b\n c") === true);
  check(
    "a synthesized diff is diff-shaped",
    diffShaped("- a\n- b\n+ c") === true,
  );
  check("raw file contents are not", diffShaped("const styles = {\n  gap: 3,\n};") === false);
  check("nor is a markdown file", diffShaped("# Title\n\n- bullet\n- bullet") === false);
  check("an empty body is not", diffShaped("") === false);
}

console.log("the +A -R suffix is only shown when it is true");
{
  const edit = { diff: true, body: "@@\n-old\n+new\n+more", status: "completed" };
  equal("edit totals", JSON.stringify(diffStat(edit)), '{"added":2,"removed":1}');
  check(
    "a failed row hides the stat",
    diffStat({ ...edit, status: "failed" }) === null,
  );
  check(
    "a canceled row hides the stat",
    diffStat({ ...edit, status: "canceled" }) === null,
  );
  check(
    "a write of raw contents fabricates nothing",
    diffStat({ diff: true, body: "# Title\n\n- bullet", status: "completed" }) === null,
  );
  check(
    "no +0 -0",
    diffStat({ diff: true, body: "@@\n context\n context", status: "completed" }) === null,
  );
  check(
    "a non-diff row has no stat",
    diffStat({ diff: false, body: "@@\n-a\n+b", status: "completed" }) === null,
  );
}

console.log("state colours");
{
  equal("a failure reddens the summary", summaryColor(COLORS, "failed"), COLORS.statusDanger);
  equal("a completed row stays muted", summaryColor(COLORS, "completed"), COLORS.foregroundMuted);
  equal("a running row stays muted", summaryColor(COLORS, "running"), COLORS.foregroundMuted);
  equal(
    "the summary style follows the state",
    summaryTextStyle(COLORS, "failed").color,
    COLORS.statusDanger,
  );
  equal(
    "the icon never changes colour (DSH's behaviour)",
    rowIconColor(COLORS),
    COLORS.foregroundMuted,
  );
}

console.log("folding and caps for the next phase");
{
  equal("diff folds 9 lines", FOLD_LINES.diff, 9);
  equal("read folds 8", FOLD_LINES.read, 8);
  equal("search folds 8", FOLD_LINES.search, 8);
  equal("a diff fold is head 5 + tail 4", FOLD_LINES.diff, 5 + 4);
  equal("search folds head 4 + tail 4", FOLD_LINES.search, 4 + 4);
  equal("terminal never folds", TERMINAL_MAX_LINES, Number.POSITIVE_INFINITY);
  equal("the code card caps at 260px", CODE_MAX_HEIGHT, 260);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
