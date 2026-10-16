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
  CARD_HEAD_ACTION_GAP,
  CARD_HEAD_FONT_SIZE,
  CARD_HEAD_GAP,
  CARD_HEAD_LINE_HEIGHT,
  CARD_HEAD_PADDING_BOTTOM,
  CARD_HEAD_PADDING_LEFT,
  CARD_HEAD_PADDING_RIGHT,
  CARD_HEAD_PADDING_TOP,
  CARD_HEAD_STATUS_MARGIN_RIGHT,
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
  READ_BODY_PADDING_BOTTOM,
  READ_BODY_PADDING_HORIZONTAL,
  READ_BODY_PADDING_TOP,
  READ_GUTTER_CHAR_WIDTH,
  READ_GUTTER_MARGIN,
  READ_GUTTER_MIN_DIGITS,
  ROW_FONT_SIZE,
  ROW_HEAD_GAP,
  ROW_HEIGHT,
  ROW_LINE_HEIGHT,
  SEARCH_BODY_PADDING_BOTTOM,
  SEARCH_BODY_PADDING_RIGHT,
  SEARCH_BODY_PADDING_TOP,
  SEARCH_EMPTY_PADDING_HORIZONTAL,
  SEARCH_EMPTY_PADDING_VERTICAL,
  SEARCH_FILE_GAP,
  SEARCH_HEAD_GAP,
  SEARCH_HEAD_PADDING_HORIZONTAL,
  SEARCH_HEAD_PADDING_VERTICAL,
  SEARCH_LINE_MIN_HEIGHT,
  SEARCH_LINE_PADDING_LEFT,
  SEARCH_SUMMARY_FONT_SIZE,
  SEARCH_SUMMARY_LINE_HEIGHT,
  SEP_MARGIN,
  SEP_RADIUS,
  SEP_SIZE,
  TERMINAL_MAX_LINES,
  WEB_GAP,
  WEB_META_GAP,
  WEB_PADDING_HORIZONTAL,
  WEB_PADDING_VERTICAL,
  WEB_PUBLISHED_LINE_HEIGHT,
  WEB_SNIPPET_FONT_SIZE,
  WEB_SNIPPET_LINE_HEIGHT,
  WEB_SNIPPET_MARGIN_TOP,
  WEB_SOURCE_GAP,
  WEB_SOURCE_INDEX_GAP,
  WEB_SOURCE_INDEX_WIDTH,
  WEB_SOURCE_LINK_FONT_SIZE,
  WEB_SOURCE_LINK_LINE_HEIGHT,
  WEB_SOURCES_MAX_HEIGHT,
  WEB_STATUS_FONT_SIZE,
  WEB_STATUS_LINE_HEIGHT,
  WEB_TRUNCATED_MARGIN_TOP,
  WEB_URL_FONT_SIZE,
  WEB_URL_LINE_HEIGHT,
  cardHeadActionTextStyle,
  cardHeadActionsStyle,
  cardHeadHeadingStyle,
  cardHeadLangTextStyle,
  cardHeadStatusTextStyle,
  cardHeadStyle,
  cardHeadTitleTextStyle,
  cardStyle,
  codeRegionStyle,
  codeTextStyle,
  commandRegionStyle,
  commandTextStyle,
  diffBodyStyle,
  diffBodyTextStyle,
  diffChromeTextStyle,
  diffLineStyle,
  diffMarkerTextStyle,
  diffRowStyle,
  diffShaped,
  diffStat,
  diffStatTextStyle,
  diffTextColor,
  diffTint,
  diffTotals,
  dividerStyle,
  foldWindow,
  isLightSurface,
  outputRegionStyle,
  outputTextStyle,
  readExpandTextStyle,
  readGutterTextStyle,
  readGutterWidth,
  readLineStyle,
  readLineTextStyle,
  rowHeadStyle,
  rowIconColor,
  rowLabelTextStyle,
  rowRootStyle,
  searchEmptyTextStyle,
  searchExpandTextStyle,
  searchFileCountTextStyle,
  searchFileHeadStyle,
  searchFilePathTextStyle,
  searchHeadStyle,
  searchLineNumberTextStyle,
  searchLineStyle,
  searchLineTextStyle,
  searchSummaryTextStyle,
  separatorStyle,
  summaryColor,
  summaryTextStyle,
  webCardBodyStyle,
  webFetchStyle,
  webMetaTextStyle,
  webPublishedTextStyle,
  webSnippetTextStyle,
  webSourceIndexTextStyle,
  webSourceLinkTextStyle,
  webSourceRowStyle,
  webSourcesStyle,
  webTruncatedTextStyle,
  webUrlTextStyle,
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
  accent: "#8ba4ff",
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

console.log("folding: DSH's headTailCap, shared by search, read and diff");
{
  // The old "is this a command block" guess lived here; it is gone. Which block
  // a row draws is now an explicit field on ToolCallData (`kind`), asserted in
  // tool-call-check.cjs where the data layer is available. What stays in this
  // file is the arithmetic the fold is made of.
  const eight = foldWindow(20, FOLD_LINES.search, false);
  equal("an 8-line cap hides 12 of 20", eight.hidden, 12);
  check("and is capped", eight.capped === true);
  equal("head is ceil(8/2)", eight.headLines, 4);
  equal("tail is the rest", eight.tailLines, 4);
  check("head + tail is the cap", eight.headLines + eight.tailLines === FOLD_LINES.search);

  const nine = foldWindow(20, FOLD_LINES.diff, false);
  equal("a 9-line cap keeps 5 at the head", nine.headLines, 5);
  equal("and 4 at the tail", nine.tailLines, 4);

  const short = foldWindow(8, FOLD_LINES.search, false);
  check("exactly the cap is not folded", short.hidden === 0 && short.capped === false);
  check("and shows nothing as hidden", short.hidden === 0);

  const expanded = foldWindow(20, FOLD_LINES.search, true);
  equal("expanding keeps the same hidden count (the button still needs it)", expanded.hidden, 12);
  check("but stops capping", expanded.capped === false);

  const tail = foldWindow(9, FOLD_LINES.search, true);
  check("an expanded block past the cap is never capped", tail.capped === false);
}

console.log("the card head (DSH's CodeToolbar)");
{
  equal("head padding top", CARD_HEAD_PADDING_TOP, 10);
  equal("head padding right", CARD_HEAD_PADDING_RIGHT, 18);
  equal("head padding bottom", CARD_HEAD_PADDING_BOTTOM, 8);
  equal("head padding left (aligns with the diff body)", CARD_HEAD_PADDING_LEFT, 22);
  equal("heading gap", CARD_HEAD_GAP, 12);
  equal("head font size", CARD_HEAD_FONT_SIZE, 11);
  equal("head line height", CARD_HEAD_LINE_HEIGHT, 18);
  equal("status keeps 8px off the copy control", CARD_HEAD_STATUS_MARGIN_RIGHT, 8);
  equal("actions gap", CARD_HEAD_ACTION_GAP, 4);

  const head = cardHeadStyle();
  equal("head is one row", head.flexDirection, "row");
  equal("status and copy sit at the far end", head.justifyContent, "space-between");
  equal("head padding", JSON.stringify([head.paddingTop, head.paddingRight, head.paddingBottom, head.paddingLeft]), "[10,18,8,22]");
  equal("heading aligns its baseline", cardHeadHeadingStyle().alignItems, "baseline");
  check("and may shrink", cardHeadHeadingStyle().flexShrink === 1);
  check("while the actions never do", cardHeadActionsStyle().flexShrink === 0);

  const lang = cardHeadLangTextStyle(COLORS);
  equal("the language tag is monospace", lang.fontFamily, CODE_FONT_FAMILY);
  equal("at the head size", lang.fontSize, CARD_HEAD_FONT_SIZE);
  equal("and never shrinks", lang.flexShrink, 0);
  equal("the title is muted", cardHeadTitleTextStyle(COLORS).color, COLORS.foregroundMuted);
  equal("the status is muted", cardHeadStatusTextStyle(COLORS).color, COLORS.foregroundMuted);
  equal("the copy control is 13px", cardHeadActionTextStyle(COLORS).fontSize, ROW_FONT_SIZE);
}

console.log("the search card");
{
  equal("header padding V", SEARCH_HEAD_PADDING_VERTICAL, 9);
  equal("header padding H", SEARCH_HEAD_PADDING_HORIZONTAL, 14);
  equal("header gap", SEARCH_HEAD_GAP, 12);
  equal("summary size", SEARCH_SUMMARY_FONT_SIZE, 13);
  equal("summary line height", SEARCH_SUMMARY_LINE_HEIGHT, 20);
  equal("body padding top", SEARCH_BODY_PADDING_TOP, 8);
  equal("body padding bottom", SEARCH_BODY_PADDING_BOTTOM, 12);
  equal("body pads right 0 + our 14 (DSH scrolls to the edge)", SEARCH_BODY_PADDING_RIGHT, 14);
  equal("row slot", SEARCH_LINE_MIN_HEIGHT, 22);
  equal("row indent", SEARCH_LINE_PADDING_LEFT, 14);
  equal("file header gap", SEARCH_FILE_GAP, 8);
  equal("empty state padding", JSON.stringify([SEARCH_EMPTY_PADDING_VERTICAL, SEARCH_EMPTY_PADDING_HORIZONTAL]), "[12,14]");

  const head = searchHeadStyle(COLORS);
  equal("header is one row", head.flexDirection, "row");
  equal("header padding", JSON.stringify([head.paddingVertical, head.paddingHorizontal]), "[9,14]");
  equal("the banner sits on its own surface (DSH's banner token)", head.backgroundColor, COLORS.surface2);
  const summary = searchSummaryTextStyle(COLORS);
  equal("the stats line takes the free space", summary.flex, 1);
  check("and can shrink", summary.minWidth === 0);
  check("the code font is not the stats font", !("fontFamily" in summary));

  const line = searchLineStyle();
  equal("a row is 22px tall", line.minHeight, SEARCH_LINE_MIN_HEIGHT);
  equal("a row is indented 14", line.paddingLeft, SEARCH_LINE_PADDING_LEFT);
  equal("a file header carries its own padding", searchFileHeadStyle().paddingHorizontal, 14);
  equal("the file path is bold", searchFilePathTextStyle(COLORS).fontWeight, "600");
  equal("the file path is primary", searchFilePathTextStyle(COLORS).color, COLORS.foreground);
  equal("the count is muted", searchFileCountTextStyle(COLORS).color, COLORS.foregroundMuted);
  equal("the line number is muted", searchLineNumberTextStyle(COLORS).color, COLORS.foregroundMuted);
  equal("the match text is primary", searchLineTextStyle(COLORS).color, COLORS.foreground);
  check("nothing shrinks: the row scrolls sideways instead", searchLineTextStyle(COLORS).flexShrink === 0 && searchLineNumberTextStyle(COLORS).flexShrink === 0);
  equal("the fold control aligns with the rows", searchExpandTextStyle(COLORS).paddingLeft, SEARCH_LINE_PADDING_LEFT);
  equal("the empty state is muted", searchEmptyTextStyle(COLORS).color, COLORS.foregroundMuted);
}

console.log("the read card");
{
  equal("body padding top", READ_BODY_PADDING_TOP, 6);
  equal("body padding bottom", READ_BODY_PADDING_BOTTOM, 20);
  equal("body padding H", READ_BODY_PADDING_HORIZONTAL, 22);
  equal("gutter margin", READ_GUTTER_MARGIN, 12);
  equal("gutter holds at least three digits (DSH's max(3, digits)ch)", READ_GUTTER_MIN_DIGITS, 3);
  equal("a `ch` at the 11px code size", READ_GUTTER_CHAR_WIDTH, 6.6);
  equal("two digits still get the three-digit gutter", readGutterWidth(2), 3 * 6.6);
  equal("five digits widen it", readGutterWidth(5), 5 * 6.6);

  const gutter = readGutterTextStyle(COLORS, 3);
  equal("the number is right-aligned", gutter.textAlign, "right");
  equal("and muted", gutter.color, COLORS.foregroundMuted);
  equal("the code takes the rest without shrinking", readLineTextStyle(COLORS).flexShrink, 0);
  equal("a read row is one code line tall", readLineStyle().minHeight, CODE_LINE_HEIGHT);
  equal(
    "the fold control starts where the code starts",
    readExpandTextStyle(COLORS, 3).paddingLeft,
    readGutterWidth(3) + READ_GUTTER_MARGIN,
  );
}

console.log("the diff card's chrome");
{
  equal("a row pads 22 (DSH's `.line { padding: 0 22px }`)", diffRowStyle().paddingHorizontal, 22);
  equal("the body pads 6 / 20", JSON.stringify(diffBodyStyle()), JSON.stringify({ paddingTop: 6, paddingBottom: 20 }));
  equal("path and hunk headers are muted", diffChromeTextStyle(COLORS).color, COLORS.foregroundMuted);
  equal("and monospace", diffChromeTextStyle(COLORS).fontFamily, CODE_FONT_FAMILY);
  equal(
    "a hunk header keeps the same left border as the changed lines",
    diffLineStyle(COLORS, "context", true).borderLeftWidth,
    DIFF_BAR_WIDTH,
  );
}

console.log("the web card");
{
  equal("padding V", WEB_PADDING_VERTICAL, 12);
  equal("padding H", WEB_PADDING_HORIZONTAL, 14);
  equal("fetch gap", WEB_GAP, 6);
  equal("url size", WEB_URL_FONT_SIZE, 13);
  equal("url line height", WEB_URL_LINE_HEIGHT, 19);
  equal("meta gap", WEB_META_GAP, 12);
  equal("status size", WEB_STATUS_FONT_SIZE, 13);
  equal("status line height", WEB_STATUS_LINE_HEIGHT, 20);
  equal("the list caps at 320px", WEB_SOURCES_MAX_HEIGHT, 320);
  equal("sources gap", WEB_SOURCE_GAP, 10);
  equal("the reference number column", WEB_SOURCE_INDEX_WIDTH, 24);
  equal("with its own gap", WEB_SOURCE_INDEX_GAP, 8);
  equal("link size", WEB_SOURCE_LINK_FONT_SIZE, 14);
  equal("link line height", WEB_SOURCE_LINK_LINE_HEIGHT, 20);
  equal("snippet size", WEB_SNIPPET_FONT_SIZE, 13);
  equal("snippet line height", WEB_SNIPPET_LINE_HEIGHT, 19);
  equal("snippet sits 2px under the title", WEB_SNIPPET_MARGIN_TOP, 2);
  equal("published line height", WEB_PUBLISHED_LINE_HEIGHT, 20);
  equal("the search card's truncation note keeps DSH's 8px", WEB_TRUNCATED_MARGIN_TOP, 8);

  equal("the card body is one padded surface", JSON.stringify(webCardBodyStyle()), JSON.stringify({ paddingVertical: 12, paddingHorizontal: 14 }));
  equal("the fetch shape is a column", webFetchStyle().flexDirection, "column");
  equal("with the gap", webFetchStyle().gap, WEB_GAP);
  equal("the URL uses the theme's link colour", webUrlTextStyle(COLORS).color, COLORS.accent);
  equal("and the code font", webUrlTextStyle(COLORS).fontFamily, CODE_FONT_FAMILY);
  equal("at weight 500", webUrlTextStyle(COLORS).fontWeight, "500");
  equal("a source link is the link colour", webSourceLinkTextStyle(COLORS).color, COLORS.accent);
  equal("a source link is 14px", webSourceLinkTextStyle(COLORS).fontSize, 14);
  equal("the status line is muted", webMetaTextStyle(COLORS).color, COLORS.foregroundMuted);
  equal("the number column is right-aligned", webSourceIndexTextStyle(COLORS).textAlign, "right");
  equal("the number column is muted", webSourceIndexTextStyle(COLORS).color, COLORS.foregroundMuted);
  equal("a source row is a row", webSourceRowStyle().flexDirection, "row");
  equal("and carries the list gap", webSourceRowStyle().marginBottom, WEB_SOURCE_GAP);
  equal("the scroller caps its height", webSourcesStyle().maxHeight, 320);
  equal("a snippet is muted", webSnippetTextStyle(COLORS).color, COLORS.foregroundMuted);
  equal("a date is muted", webPublishedTextStyle(COLORS).color, COLORS.foregroundMuted);
  equal("the fetch truncation note has no top margin (DSH zeroes it there)", webTruncatedTextStyle(COLORS).marginTop, 0);
  equal("the search one keeps it", webTruncatedTextStyle(COLORS, WEB_TRUNCATED_MARGIN_TOP).marginTop, 8);
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
  equal("diff line padding H", DIFF_LINE_PADDING_HORIZONTAL, 22);
  equal(
    "the diff body's lines line up with the card head",
    DIFF_LINE_PADDING_HORIZONTAL,
    cardHeadStyle().paddingLeft,
  );

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
