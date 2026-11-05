/**
 * Jobs popover parity: geometry, status marks, JSX wiring and host theme data.
 * HOST_APP must name a Paseo checkout; without it checks run but exit 2 (incomplete).
 * Exit 0 requires both halves. JSX is read through the shared source-shape helper.
 *
 * Run from paseo-plugin:
 *   npx tsc client/jobs-popover-layout.ts --outDir .dbg-jobs --rootDir . \
 *     --module commonjs --moduleResolution node --target ES2022 --skipLibCheck
 *   echo '{"type":"commonjs"}' > .dbg-jobs/package.json
 *   cp ../harness/jobs-popover-check.cjs .dbg-jobs/
 *   cd .dbg-jobs && HOST_APP=/path/to/paseo node jobs-popover-check.cjs
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const sourceRoot = path.resolve(__dirname, "..", "..");
const shape = require(path.join(sourceRoot, "harness/source-shape.cjs"));
const readSource = (relative) => shape.codeOnly(fs.readFileSync(path.join(sourceRoot, relative), "utf8"));

const layout = require("./client/jobs-popover-layout.js");

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

console.log("row geometry");

const EXPECTED = {
  ROW_GAP: 8,
  ROW_PADDING_HORIZONTAL: 8,
  ROW_PADDING_VERTICAL_COMPACT: 8,
  ROW_PADDING_VERTICAL_WIDE: 4,
  ROW_MARGIN_HORIZONTAL: 4,
  ROW_BORDER_RADIUS: 6,
  ROW_MIN_HEIGHT_COMPACT: 40,
  ROW_MIN_HEIGHT_WIDE: 32,
  MARK_BOX: 14,
  MARK_DOT_SIZE: 6,
  TITLE_FONT_SIZE: 14,
  FACTS_FONT_SIZE: 12,
  PAGE_PADDING_VERTICAL: 4,
  PAGE_GAP: 0,
  POPOVER_HOST_PADDING: 12,
  POPOVER_CANCEL_MARGIN: -12,
  POPOVER_PAGE_PADDING_VERTICAL: 0,
  // The folded section's disclosure row, and the rule above it.
  CHEVRON_BOX: 14,
  CHEVRON_ROTATION_EXPANDED: "90deg",
  ROW_ACTIVE_FILL: "surface2",
  SECTION_SEPARATOR_HEIGHT: 1,
  SECTION_SEPARATOR_MARGIN_VERTICAL: 4,
  SECTION_SEPARATOR_COLOR: "border",
};
for (const [name, expected] of Object.entries(EXPECTED)) check(name, layout[name], expected);

// The chevron's box is the same slot a row's mark uses — one rail, one number.
// Asserted as an equality rather than two literals, so a future edit that moves
// only one of them is red here.
check("the chevron box is the row mark's box", layout.CHEVRON_BOX, layout.MARK_BOX);

const wide = layout.rowBox({ compact: false });
check("rowBox(wide).gap", wide.gap, 8);
check("rowBox(wide).paddingVertical", wide.paddingVertical, 4);
check("rowBox(wide).minHeight", wide.minHeight, 32);
check("rowBox(wide).marginHorizontal", wide.marginHorizontal, 4);
check("rowBox(wide).paddingHorizontal", wide.paddingHorizontal, 8);
check("rowBox(wide).borderRadius", wide.borderRadius, 6);
const compact = layout.rowBox({ compact: true });
check("rowBox(compact).paddingVertical", compact.paddingVertical, 8);
check("rowBox(compact).minHeight", compact.minHeight, 40);

const column = layout.rowTextColumn();
check("rowTextColumn().flexGrow", column.flexGrow, 1);
check("rowTextColumn().flexBasis", column.flexBasis, "auto");
check("rowTextColumn().minWidth", column.minWidth, 0);
assert("rowTextColumn() declares no gap", !("gap" in column), Object.keys(column).join(","));

console.log("\ncomposed inset");

const root = layout.popoverRootBox();
check("popoverRootBox().margin cancels the host's padding", root.margin, -12);
check("popoverRootBox().paddingVertical", root.paddingVertical, 0);

const composedLeading =
  layout.POPOVER_HOST_PADDING + root.margin + layout.ROW_MARGIN_HORIZONTAL + layout.ROW_PADDING_HORIZONTAL;
const composedTop =
  layout.POPOVER_HOST_PADDING + root.margin + layout.PAGE_PADDING_VERTICAL + root.paddingVertical;
const subagentLeading = layout.ROW_MARGIN_HORIZONTAL + layout.ROW_PADDING_HORIZONTAL;

check("a subagent row's mark sits 12 from the content edge", subagentLeading, 12);
check("the popover composes to the subagent panel's indent", composedLeading, subagentLeading);
check("composed indent is 12 + (-12) + 4 + 8", composedLeading, 12 - 12 + 4 + 8);
check("the first row starts 4 from the top, as the subagent panel's does", composedTop, 4);
check("composed top is host 12 + cancel -12 + MenuPage 4 + body 0", composedTop, 12 - 12 + 4 + 0);
assert(
  "the body does not add the page's vertical padding a second time",
  composedTop === layout.PAGE_PADDING_VERTICAL,
  `top ${composedTop} vs MenuPage's ${layout.PAGE_PADDING_VERTICAL} — the body is padding again`,
);

console.log("\nstatus → mark");
const sharedJobsPath =
  process.env.SHARED_JOBS ?? path.resolve(__dirname, "..", "..", "paseo-plugin", "shared", "jobs.ts");

function readArrayLiteral(name) {
  if (!fs.existsSync(sharedJobsPath)) return undefined;
  const source = fs.readFileSync(sharedJobsPath, "utf8");
  const found = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(source);
  if (found === null) return undefined;
  const entries = [...found[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  return entries.length === 0 ? undefined : entries;
}

const JOB_STATUSES = readArrayLiteral("JOB_STATUSES");
const LIVE = readArrayLiteral("LIVE_JOB_STATUSES");
assert(
  "JOB_STATUSES is readable out of shared/jobs.ts (the oracle)",
  JOB_STATUSES !== undefined,
  `no array literal in ${sharedJobsPath}`,
);
assert("LIVE_JOB_STATUSES is readable out of shared/jobs.ts", LIVE !== undefined, sharedJobsPath);

const marks = {};
for (const status of JOB_STATUSES ?? []) marks[status] = layout.statusMark(status);
for (const status of JOB_STATUSES ?? []) {
  const mark = marks[status];
  if (mark === undefined) {
    assert(`${status}: the layout has a mark for it`, false, "statusMark() returned undefined");
    continue;
  }
  const live = (LIVE ?? []).includes(status);
  check(`${status}: ${live ? "live" : "settled"} → ${live ? "ring" : "dot"}`, mark.kind, live ? "ring" : "dot");
  if (live) {
    assert(
      `${status}'s ring carries no colour token of its own`,
      !Object.prototype.hasOwnProperty.call(mark, "color"),
      Object.keys(mark).join(","),
    );
  }
}
check("failed fills its dot with statusDanger", layout.statusMark("failed")?.color, "statusDanger");
check("completed fills its dot with border", layout.statusMark("completed")?.color, "border");
check("killed fills its dot with border, not danger", layout.statusMark("killed")?.color, "border");

console.log("\nthe folded section's disclosure row");

// The interaction rules are pure functions in the layout module, so they are
// asserted by calling them rather than by reading the component's JSX. A
// pattern-match on the ternary would pass for the wrong reasons; a call with each
// of the four hover/pressed combinations pins the rule itself.
check("at rest the row paints no fill", layout.rowActiveFill(false, false), undefined);
check("hover fills the row with surface2", layout.rowActiveFill(true, false), "surface2");
check("press fills the row with surface2", layout.rowActiveFill(false, true), "surface2");
check("hover and press together still fill once", layout.rowActiveFill(true, true), "surface2");
check("the fill token is the one the theme carries", layout.ROW_ACTIVE_FILL, "surface2");
check("at rest the chevron is muted", layout.chevronColorToken(false, false), "foregroundMuted");
check("hover lifts the chevron to foreground", layout.chevronColorToken(true, false), "foreground");
check("press lifts the chevron to foreground", layout.chevronColorToken(false, true), "foreground");

// The rotation is a value, so "it follows `expanded` and nothing else" is checkable:
// collapsed is no transform at all, expanded is exactly the host's 90deg.
check("a collapsed section does not rotate the chevron", layout.chevronRotation(false), undefined);
const expandedRotation = layout.chevronRotation(true);
assert(
  "an expanded section rotates the chevron 90deg, once",
  Array.isArray(expandedRotation) && expandedRotation.length === 1 &&
    expandedRotation[0].rotate === "90deg",
  JSON.stringify(expandedRotation),
);
check("the rotation is the host's", expandedRotation?.[0]?.rotate, layout.CHEVRON_ROTATION_EXPANDED);

// The rule above the folded section: both groups must have something in them.
check("no rule with nothing running", layout.sectionDivided(0, 3), false);
check("no rule with nothing settled", layout.sectionDivided(2, 0), false);
check("no rule with neither", layout.sectionDivided(0, 0), false);
check("a rule when both groups have rows", layout.sectionDivided(1, 1), true);
check("a rule with several on each side", layout.sectionDivided(4, 9), true);

// Check the JSX consumers, not just the helpers they are meant to use.
console.log("\nUI wiring");
const pillSource = readSource("paseo-plugin/client/jobs-pill.tsx");
const spinnerSource = readSource("paseo-plugin/client/jobs-spinner.tsx");
const ringSource = readSource("paseo-plugin/client/status-ring.tsx");
const pillElements = shape.jsxElements(pillSource);
const attr = (element, name) => shape.attributeOf(element, name)?.value ?? "";
const calls = (expression, name) => shape.callArguments(expression, name);
check("job and note rows apply rowBox(compact)", pillElements.filter((element) =>
  element.tag === "View" && calls(attr(element, "style"), "rowBox").some((args) => shape.mentions(args, "compact"))).length, 2);
assert("the text column applies rowTextColumn", pillElements.some((element) =>
  element.tag === "View" && calls(attr(element, "style"), "rowTextColumn").length === 1));
assert("popover root is built with popoverRootBox", /const\s+root\s*=\s*popoverRootBox\(\s*\)/.test(pillSource));
// Three branches: unreadable registry, nothing to show, and the grouped list.
// Each wraps its body in the same root box.
check("all three popover branches apply the root box", pillElements.filter((element) =>
  element.tag === "View" && attr(element, "style").trim() === "root").length, 3);
const rows = pillElements.filter((element) => ["JobRow", "NoteLine"].includes(element.tag));
// JobRow appears once for the live group and once for the expanded settled group,
// plus the two NoteLine branches — four call sites, all taking host density.
assert("rows and notes take host compact density", rows.length === 4 && rows.every((element) =>
  attr(element, "compact").replace(/\s/g, "") === "layout.compact"));
// Read-only rows, one pressable exception. A job row is never pressable (killing a
// job is the model's `job_kill` tool), and nothing here scrolls. The finished
// section's header IS pressable — DSH's own list renders it as a `button` with
// `aria-expanded` — so the rule is "no Pressable inside a row", not "no Pressable".
assert("no inner scroll view", !pillElements.some((element) => element.tag === "ScrollView"));
const pressables = pillElements.filter((element) => element.tag === "Pressable");
check("exactly one pressable element (the finished-section header)", pressables.length, 1);
const pressable = pressables[0];

// **The only `Pressable` is the folded section's header.** This used to be asserted
// with a regex over the whole file, which a `Pressable` anywhere else would also
// satisfy. There is one element now, so its own attributes are the evidence: the
// disclosure contract lives on it, and a job row still cannot reach a `Pressable`.
assert("the only pressable is the settled header",
  pressable !== undefined && shape.hasAttribute(pressable, "onPress")
    && attr(pressable, "accessibilityRole").trim() === "button",
  pressable === undefined ? "no Pressable" : JSON.stringify(pressable.attributes.map((a) => a.name)));
assert("job rows stay read-only", (() => {
  const body = shape.functionBody(pillSource, "JobRow");
  return body !== undefined && !body.includes("Pressable");
})());

// **The reader itself.** `shape.functionBody` used to return the *parameter
// object* for a destructuring signature — the first `{` after the header is the
// params, not the body — so every assertion built on it was checking
// `"{ job, theme, text, compact }"` instead of the function. That made
// "job rows stay read-only" above unfalsifiable: injecting a `Pressable` into
// `JobRow` left it green. These two pin the reader's contract directly, so a
// regression in it is a red check here rather than a silent hole in another one.
const settledBody = shape.functionBody(pillSource, "SettledHeader");
assert(
  "the body reader returns a function body, not its parameter list",
  settledBody !== undefined && settledBody.includes("<Pressable"),
  settledBody === undefined ? "undefined" : JSON.stringify(settledBody.slice(0, 60)),
);
assert(
  "the body reader stops at the right function when names share a prefix",
  (() => {
    // `SettledHeader` is a prefix-free name, so the collision case needs a pair
    // that exists: `JobRow` and `JobRows` would be it, but this file has none —
    // so assert the reader's own name boundary on a synthetic source instead.
    const probe = "function rows() {\n  return 1;\n}\nfunction rowsExtra() {\n  return 2;\n}";
    const body = shape.functionBody(probe, "rows");
    return body !== undefined && body.includes("return 1") && !body.includes("return 2");
  })(),
);

// **The disclosure row's own wiring**, all read off that one element.
assert("the header reads the section's state for its accessibility",
  shape.mentions(attr(pressable, "accessibilityState"), "expanded"));
assert("the header labels itself with the words and the count",
  shape.mentions(attr(pressable, "accessibilityLabel"), "settledLabel")
    && shape.mentions(attr(pressable, "accessibilityLabel"), "count"),
  attr(pressable, "accessibilityLabel"));
// `aria-expanded` is web-only and spread in, which is how the host writes it
// (`isWeb ? { "aria-expanded": open } : null`). React Native Web ignores
// `accessibilityState.expanded`, so without this the button's state is unreadable
// on the only platform this popover renders on.
const webProps = attr(pressable, "{...spread}");
assert("the header sets aria-expanded on web only",
  webProps.includes("aria-expanded") && webProps.includes('Platform.OS === "web"'),
  webProps);
assert("the header styles itself from its own pressable state",
  attr(pressable, "style").trim() === "rowStyle",
  attr(pressable, "style"));
// The fill rule itself is asserted as a function above; this is the wiring that
// makes it reach the screen — the callback has to read both flags, and the colour
// has to come out of the theme rather than a literal.
const fillCalls = calls(pillSource, "rowActiveFill");
assert("the row's style callback reads hover and press",
  fillCalls.length === 1
    && shape.mentions(fillCalls[0], "hovered")
    && shape.mentions(fillCalls[0], "pressed"),
  JSON.stringify(fillCalls));
assert("the row's fill is taken from the theme by token",
  /theme\.colors\[\s*active\s*\]/.test(pillSource));
assert("the disclosure row keeps the track row's box",
  calls(pillSource, "rowBox").some((args) => shape.mentions(args, "compact")));

// **The chevron is the host's icon, not a text glyph.** A glyph would look
// plausible and break the moment the host's icon font or size changes.
assert("the folded section no longer draws a text chevron",
  !pillSource.includes("▾") && !pillSource.includes("▸"));
const chevrons = pillElements.filter((element) => element.tag === "Icon");
check("exactly one host icon in the popover", chevrons.length, 1);
const chevron = chevrons[0];
assert("the chevron is the host's ChevronRight",
  chevron !== undefined && attr(chevron, "name").trim() === "ChevronRight",
  chevron === undefined ? "no Icon" : attr(chevron, "name"));
assert("the chevron is sized by the shared icon slot",
  chevron !== undefined && shape.mentions(attr(chevron, "size"), "CHEVRON_BOX"),
  chevron === undefined ? "no Icon" : attr(chevron, "size"));
assert("the chevron's colour follows the row's active state",
  chevron !== undefined && shape.mentions(attr(chevron, "color"), "chevronColorToken"),
  chevron === undefined ? "no Icon" : attr(chevron, "color"));
// The rotation rule is asserted as a value above; here it is the wiring: the
// transform has to come from that function and take `expanded`.
const rotations = calls(pillSource, "chevronRotation");
assert("the chevron's rotation is driven by `expanded` alone",
  rotations.length === 1 && shape.mentions(rotations[0], "expanded"),
  JSON.stringify(rotations));
assert("the rotation is wired into the chevron's box",
  /\btransform:\s*chevronRotation\(/.test(pillSource));

// **The label/count split.** The words are the row's title (14 / foreground); the
// number sits in the host's trailing muted slot (12 / foregroundMuted), which is
// what `rowTrailing` and `SettingsRowHeader`'s `summary` do — not "3 finished"
// spelled into one sentence.
const textsAfterHeader = pressable === undefined
  ? []
  : pillElements.filter((element) => element.tag === "Text" && element.start > pressable.start);
assert("the header draws a label and a count", textsAfterHeader.length >= 2,
  String(textsAfterHeader.length));
const [labelText, countText] = textsAfterHeader;
assert("the label is the row's title type, in foreground",
  labelText !== undefined
    && shape.mentions(attr(labelText, "style"), "TITLE_FONT_SIZE")
    && shape.mentions(attr(labelText, "style"), "foreground")
    && !shape.mentions(attr(labelText, "style"), "foregroundMuted"),
  labelText === undefined ? "no label Text" : attr(labelText, "style"));
assert("the count is the muted trailing type",
  countText !== undefined
    && shape.mentions(attr(countText, "style"), "FACTS_FONT_SIZE")
    && shape.mentions(attr(countText, "style"), "foregroundMuted"),
  countText === undefined ? "no count Text" : attr(countText, "style"));
// **The split itself: two elements, in that order, with different children.** The
// claim the design makes is "the number is not part of the sentence", and the only
// thing that can falsify it is the *shape*: a single `Text` rendering both would
// have the count inside the label's children. Reading the label's children and
// requiring the count to be absent from them is the direct check; requiring the
// two `Text`s to be distinct elements is what stops a refactor from collapsing
// them back into one line of copy.
assert("the label and the count are two different elements",
  labelText !== undefined && countText !== undefined && labelText.start !== countText.start);
assert("the count sits after the label in the row",
  labelText !== undefined && countText !== undefined && countText.start > labelText.start);
// The label's own children render `settledLabel` and never `count`; the count's
// children render `count`. `jsxElements` reports where an opening tag *ends*, so
// each span runs from its own tag to the next element's — the children in between.
// That is what "the number is not part of the sentence" means structurally, and it
// fails if the two are ever merged back into one `Text`.
const spanFrom = (element, limit) =>
  element === undefined ? "" : pillSource.slice(element.end, Math.min(limit, pillSource.length));
const labelSpan = spanFrom(labelText, countText?.start ?? pillSource.length);
const countSpan = spanFrom(countText, chevron?.start ?? pillSource.length);
assert("the label's own children render the words and not the number",
  /settledLabel/.test(labelSpan) && !/\bcount\b/.test(labelSpan),
  JSON.stringify(labelSpan.slice(0, 140)));
assert("the count's own children render the number",
  /\bcount\b/.test(countSpan),
  JSON.stringify(countSpan.slice(0, 140)));

// **The rule above the folded section.** A `View`, drawn from the shared
// constants, and only when `sectionDivided` says both groups have rows.
const separatorViews = pillElements.filter((element) =>
  element.tag === "View" && attr(element, "style").trim() === "separator");
check("the divider is a View, not a pressable", separatorViews.length, 1);
const dividedCalls = calls(pillSource, "sectionDivided");
assert("the divider's condition is the both-groups rule",
  dividedCalls.length === 1
    && shape.mentions(dividedCalls[0], "live")
    && shape.mentions(dividedCalls[0], "settled"),
  JSON.stringify(dividedCalls));
// **`divided` has to actually gate the divider.** The assertion above only proves
// `sectionDivided(...)` is *called*; it stays green when the JSX renders the
// separator unconditionally (`<View style={separator} />`) or behind `{true ? …}`
// — both were measured at 205/205 before this pair was added. So the gate is read
// structurally: walk back from the separator element to the `{` that wraps it, and
// require the expression inside to start with `divided` followed by `?` or `&&`.
// Formatting-independent: the search is over braces, so line breaks and wrapping
// cannot change the answer.
const enclosingBrace = (source, index) => {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (source[i] === "}") depth += 1;
    else if (source[i] === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
};
const separatorElement = separatorViews[0];
const gateBrace = separatorElement === undefined ? -1 : enclosingBrace(pillSource, separatorElement.start);
const gateExpression = gateBrace < 0 ? "" : pillSource.slice(gateBrace + 1, separatorElement.start).trim();
assert("the divider is rendered behind the `divided` gate",
  /^divided\s*[?&]/.test(gateExpression),
  JSON.stringify(gateExpression));
// And `divided` has to be that call's result, not merely a name that happens to be
// truthy — a `const divided = true;` would satisfy the gate above.
const popoverSourceForGate = shape.functionBody(pillSource, "makeJobsPopover") ?? "";
assert("the gate is the both-groups call's result",
  /const\s+divided\s*=\s*sectionDivided\(\s*live\.length\s*,\s*settled\.length\s*\)/.test(popoverSourceForGate),
  JSON.stringify((/const\s+divided[^;]*;/.exec(popoverSourceForGate) ?? [""])[0]));
assert("the divider takes the host separator's geometry",
  /\bheight:\s*SECTION_SEPARATOR_HEIGHT\b/.test(pillSource)
    && /\bmarginVertical:\s*SECTION_SEPARATOR_MARGIN_VERTICAL\b/.test(pillSource)
    && /theme\.colors\[\s*SECTION_SEPARATOR_COLOR\s*\]/.test(pillSource));
// The host's separator comment: "No horizontal margin … the rule still runs the
// full width of the surface". An inset rule would read as a tick between chips.
assert("the divider is not inset horizontally",
  !/marginHorizontal/.test((/const separator = \{[\s\S]*?\};/.exec(pillSource) ?? [""])[0]));
// And it has to sit *above* the header it introduces. Read inside `makeJobsPopover`,
// because that is where the order exists: `SettledHeader` is *defined* earlier in the
// file, so a file-position comparison would say nothing about the rendered order.
const popoverBody = shape.functionBody(pillSource, "makeJobsPopover") ?? "";
const separatorAt = popoverBody.indexOf("style={separator}");
const headerAt = popoverBody.indexOf("<SettledHeader");
assert("the divider precedes the folded section",
  separatorAt >= 0 && headerAt >= 0 && separatorAt < headerAt,
  `separator@${String(separatorAt)} header@${String(headerAt)}`);

assert("the job mark passes its theme to JobsSpinner", pillElements.some((element) =>
  element.tag === "JobsSpinner" && attr(element, "theme").trim() === "theme"));
assert("spinner colour comes from the theme surface", calls(spinnerSource, "ringColorFor").some((args) =>
  args.replace(/\s/g, "") === "theme?.colors.surface0"));
assert("spinner passes that colour to the shared ring", shape.jsxElements(spinnerSource).some((element) =>
  element.tag === "StatusRingMark" && attr(element, "color").trim() === "color"));
assert("the shared ring passes the colour to its arc", shape.jsxElements(ringSource).some((element) =>
  element.tag === "RotatingArc" && attr(element, "color").trim() === "color"));

// The title must be able to be the model's own words instead of the command.
// A row that silently fell back to the command would look fine — it is what the
// pill did before — so the wiring is asserted rather than eyeballed: the title
// has to come from `description` (with the command as the fallback), and the
// command has to stay visible on the facts line when it is no longer the title.
// Read as source because `jobs-pill.tsx` imports the host runtime.
assert("the row title prefers the captured description", /const\s+title\s*=\s*titled\s*\?\s*description\s*:\s*job\.label/.test(pillSource));
assert("a missing description keeps the command as the title", /const\s+titled\s*=\s*description\s*!==\s*undefined/.test(pillSource));
assert("the command stays visible when the description becomes the title", /titled\s*\?\s*job\.label\s*:\s*undefined/.test(pillSource));
assert("the title line renders the resolved title, not the raw label",
  /fontSize:\s*TITLE_FONT_SIZE[\s\S]{0,160}?\{\s*title\s*\}/.test(pillSource));

// The rows must be drawn in `orderJobs`' order, not the registry's registration
// order: a settled row above a running one is exactly the bug. The pure rule is
// asserted in `jobs-poll-check.cjs`; this is the wiring that makes it reach the
// screen, read as source because the module imports the host runtime.
assert("the popover splits rows through splitJobs", /const\s+\{\s*live,\s*settled\s*\}\s*=\s*splitJobs\(/.test(pillSource));
assert("the raw jobs array is not mapped directly", !/\{entry\.jobs\.map\(/.test(pillSource));

// The finished section: while anything is live it folds to one header, and the
// header has to be the only pressable thing in a popover whose rows are read-only.
assert("the finished section starts folded while anything runs",
  /const\s+expanded\s*=\s*settledOpen\s*\?\?\s*live\.length\s*===\s*0/.test(pillSource));
assert("a tap toggles the section from the resolved state, not a stale value",
  /setSettledOpen\(!expanded\)/.test(pillSource));
assert("the header is only drawn when there are finished rows",
  /\{settled\.length > 0 \? \(/.test(pillSource));
assert("the finished rows are drawn only when expanded",
  /\{expanded\s*\n?\s*\? settled\.map\(/.test(pillSource) || /\{expanded\s*\?\s*settled\.map\(/.test(pillSource));
assert("the live rows are drawn outside the fold", /\{live\.map\(\(job\) =>/.test(pillSource));
// No fallback branch: `jobSchema` parses `status` as `z.enum(JOB_STATUSES)`, so a
// status outside the list fails the whole RPC answer instead of reaching here, and
// `splitJobs` partitions exactly the statuses `isLiveStatus` classifies. An
// unreachable "both groups empty" branch would be dead code dressed as safety.
assert("no dead fallback for an unreachable empty split",
  !/live\.length === 0 && settled\.length === 0/.test(pillSource));

// CJ-01 (route 2): the pill is a live indicator. Visibility, icon mark and label
// key come from the pure rule in `jobs-polling.ts`; this block pins the wiring
// that makes them reach the composer. The history-visible route — an idle total
// in `idleLabel`, a visible settled-only pill with a static mark — is asserted
// absent. `jobs-poll-check.cjs` asserts the rule's behaviour.
assert("the pill's presentation comes from the shared rule",
  /const\s+presentation\s*=\s*jobsPillPresentation\(next\)/.test(pillSource));
assert("visibility is reported from that rule", /visible:\s*presentation\.visible/.test(pillSource));
assert("the live count uses the live label",
  /text\.liveLabel\(\s*presentation\.label\.count\s*\)/.test(pillSource));
assert("the idle label is gone", !/idleLabel/.test(pillSource));
assert("the old idle-total branch is gone",
  !/presentation\.label\.kind\s*===\s*"idle"/.test(pillSource));
// The static mark exists only as the baseline branch for an unreadable registry:
// one occurrence in the source, selected by the explicit `presentation.icon`
// ternary. `jobs-poll-check.cjs` proves no readable answer selects it.
// T10b: the live mark is the terminal glyph with the ring on its corner
// (`JobsPillIcon`), never the bare ring; the static baseline is the same glyph.
// SquareTerminal, not ListChecks: ListChecks is the host's own task-list pill.
assert("the static mark is the explicit baseline branch",
  /presentation\.icon\s*===\s*"spinner"\s*\?\s*JobsPillIcon\s*:\s*"SquareTerminal"/.test(pillSource));
assert("the old ListChecks mark is gone from the pill",
  !/ListChecks/.test(pillSource));
assert("the half attaches with the corner-ringed glyph, not the bare spinner",
  /icon:\s*JobsPillIcon,/.test(pillSource) && !/icon:\s*JobsSpinner/.test(pillSource));
assert("JobsPillIcon is the terminal glyph with the ring on",
  /export function JobsPillIcon[\s\S]{0,300}<CornerRingIcon name="SquareTerminal"[^>]*running theme/.test(spinnerSource));
assert("the old live-only rule is not reimplemented in the JSX",
  !/next\.available\s*\?\s*count\s*>\s*0/.test(pillSource));
assert("the old live-only counter is gone", !/liveCount\(next\.jobs\)/.test(pillSource));
// Polling policy moved out of the JSX module, so the interval constants and the
// per-agent `setInterval` are not in this file any more; the controller owns
// them (and `jobs-poll-check.cjs` drives it with a fake clock).
assert("the pill delegates polling to the controller", /createJobsPoller<Job>\(/.test(pillSource));
assert("the pill no longer creates its own intervals", !/setInterval\(/.test(pillSource));

console.log("\npermission refusal");

const refusal = Object.assign(new Error("Session is not authorized for plugin.rpc.invoke.request code=access_denied"), {
  code: "access_denied",
});
check("a coded refusal is recognised", layout.isPermissionDeniedError(refusal), true);
check(
  "the code alone is enough",
  layout.isPermissionDeniedError(Object.assign(new Error("whatever"), { code: "access_denied" })),
  true,
);
check(
  "the message alone is enough",
  layout.isPermissionDeniedError(new Error("Session is not authorized for plugin.rpc.invoke.request")),
  true,
);
for (const [what, error] of [
  ["a timeout", new Error("Request timed out")],
  ["a dead child", new Error("the dsh child exited")],
  ["an unreadable registry", new Error("the DSH runtime could not list this session's jobs")],
  ["the hosts-only permission_denied code", Object.assign(new Error("x"), { code: "permission_denied" })],
  ["a string rejection", "access_denied"],
  ["null", null],
  ["undefined", undefined],
  ["a plain object", {}],
]) {
  check(`${what} is not a refusal`, layout.isPermissionDeniedError(error), false);
}

const hostApp = process.env.HOST_APP;
const hostMissing = !hostApp;
if (hostApp === undefined || hostApp === "") {
  console.log(
    "\nhost half SKIPPED (HOST_APP unset) — this is not a pass; the plugin's\n" +
      "constants were checked against literals, not against a Paseo checkout.",
  );
} else {
  console.log(`\nhost constants from ${hostApp}`);
  const read = (relative) => shape.codeOnly(fs.readFileSync(path.join(hostApp, relative), "utf8"));

  // Run host data; stubs affect fonts/highlighting only, never surfaces or status colours.
  function loadHostData(relative) {
    const result = {};
    vm.runInNewContext(ts.transpileModule(read(relative), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      exports: result,
      require(name) {
        if (name === "react-native") return { Platform: { select: (options) => options.web ?? options.default } };
        if (name === "@getpaseo/highlight") return { lightHighlightColors: {}, darkHighlightColors: {} };
        throw new Error(`unhandled host theme dependency: ${name}`);
      },
    }, { filename: relative, timeout: 1000 });
    return result;
  }
  const host = loadHostData("packages/app/src/styles/theme.ts");
  check("host SPACING[2]", host.SPACING?.[2], 8);
  check("host SPACING[1]", host.SPACING?.[1], 4);
  check("host SPACING[3] (the popover body's padding)", host.SPACING?.[3], 12);
  check("host FONT_SIZE.base", host.FONT_SIZE?.base, 14);
  check("host FONT_SIZE.sm", host.FONT_SIZE?.sm, 12);
  check("host BORDER_RADIUS.md", host.BORDER_RADIUS?.md, 6);
  check("the mark slot matches host ICON_SIZE.sm", layout.MARK_BOX, host.ICON_SIZE?.sm);
  check("compact height matches host menu geometry", layout.ROW_MIN_HEIGHT_COMPACT,
    loadHostData("packages/app/src/components/ui/menu/menu-geometry.ts").MENU_ITEM_HEIGHT?.xs);
  check("settled dot matches host status geometry", layout.MARK_DOT_SIZE,
    loadHostData("packages/app/src/utils/status-indicator-geometry.ts").STATUS_INDICATOR_FILLED_DOT_SIZE);

  const tracks = read("packages/app/src/composer/tracks.tsx");
  assert("tracks.tsx row gaps by spacing[2]", /gap: theme\.spacing\[2\]/.test(tracks));
  assert(
    "tracks.tsx row insets 8 compact / 4 wide",
    /paddingVertical: \{ xs: theme\.spacing\[2\], md: theme\.spacing\[1\] \}/.test(tracks),
  );
  assert("tracks.tsx row margins by spacing[1]", /marginHorizontal: theme\.spacing\[1\]/.test(tracks));
  assert("tracks.tsx row floors at 32 wide", /minHeight: \{ xs: MENU_ITEM_HEIGHT\.xs, md: 32 \}/.test(tracks));

  const menuItem = read("packages/app/src/components/ui/menu/menu-item.tsx");
  assert(
    "MenuPage still pads vertically by spacing[1]",
    /page: \{\s*\n\s*paddingVertical: theme\.spacing\[1\],/.test(menuItem),
  );
  assert("the menu's page gap is still 0", /const MENU_ROW_GAP = 0;/.test(menuItem));

  // The disclosure row's geometry, against the host component it was copied from.
  // Each of these is a number the plugin now carries as a constant, so a host that
  // moves it is a red check here rather than a row that silently drifts.
  const rowHeader = read("packages/app/src/components/settings/row-header.tsx");
  check("the chevron box matches host ICON_SIZE.sm", layout.CHEVRON_BOX, host.ICON_SIZE?.sm);
  assert(
    "the host's disclosure chevron rotates 90deg",
    new RegExp(`transform:\\s*\\[\\{\\s*rotate:\\s*"${layout.CHEVRON_ROTATION_EXPANDED}"\\s*\\}\\]`).test(rowHeader),
  );
  assert(
    "the host's disclosure row lifts its chevron to foreground while hovered",
    /hoveredIconColorMapping[\s\S]{0,120}color:\s*theme\.colors\.foreground/.test(rowHeader),
  );
  assert(
    "the host's disclosure row fills with surface2 on hover",
    /hovered:\s*\{\s*\n\s*backgroundColor:\s*theme\.colors\.surface2,/.test(rowHeader),
  );
  // The plugin's single fill for hover *and* press is the host's menu-surface rule,
  // and it is a *degradation* only because the plugin theme cannot carry `surface3`.
  // Both halves are asserted: the host has the token, the plugin's theme contract
  // does not expose it. Asserting only the first half would pass even if the plugin
  // theme later gained `surface3` (making the comment wrong), so the second half is
  // what makes the claim falsifiable.
  assert(
    "the host's menu rows use surface2 for both hover and press",
    /itemHovered[\s\S]{0,400}?surface2/.test(menuItem) && /itemPressed[\s\S]{0,400}?surface2/.test(menuItem),
  );
  assert("the host theme carries a surface3 the settings page paints pressed rows with",
    typeof host.lightTheme?.colors.surface3 === "string");
  assert("the plugin theme contract exposes no surface3, which is why the pressed fill degrades",
    !/surface3/.test(read("packages/plugin/src/contracts.ts")));

  // The rule between the groups: a `MenuSeparator` is a bare View with these numbers.
  assert(
    "the host's separator is 1px tall",
    new RegExp(`separator:\\s*\\{\\s*\\n\\s*height:\\s*${layout.SECTION_SEPARATOR_HEIGHT},`).test(menuItem),
  );
  assert(
    "the host's separator margins vertically by spacing[1]",
    /separator:\s*\{[\s\S]{0,200}?marginVertical:\s*theme\.spacing\[1\],/.test(menuItem),
  );
  check(
    "the plugin's separator margin is that spacing[1] value",
    layout.SECTION_SEPARATOR_MARGIN_VERTICAL,
    host.SPACING?.[1],
  );
  assert(
    "the host's separator sets no horizontal margin",
    !/separator:\s*\{[^}]*marginHorizontal/.test(menuItem),
  );
  assert(
    "the host's separator paints borderAccent",
    /separator:\s*\{[\s\S]{0,220}?backgroundColor:\s*theme\.colors\.borderAccent,/.test(menuItem),
  );
  // The other half of the same degradation claim: the plugin theme has `border` and
  // not `borderAccent`, which is what makes `border` the nearest key rather than a
  // substitution nobody verified. Both halves asserted for the same reason as above.
  assert(
    "the plugin theme contract exposes no borderAccent, which is why the rule uses border",
    !/borderAccent/.test(read("packages/plugin/src/contracts.ts")),
  );
  assert(
    "the plugin's separator token is a key the theme actually carries",
    layout.SECTION_SEPARATOR_COLOR === "border" && typeof host.lightTheme?.colors.border === "string",
  );

  // The label/count split is the host's `rowTrailing` / `summary` shape.
  const subagentsTrack = read("packages/app/src/subagents/track.tsx");
  assert(
    "the host's trailing slot shrinks before the label and is muted",
    /rowTrailing:\s*\{[\s\S]{0,200}?flexShrink:\s*2,[\s\S]{0,120}?fontSize:\s*theme\.fontSize\.sm,[\s\S]{0,80}?color:\s*theme\.colors\.foregroundMuted,/.test(subagentsTrack),
  );
  assert(
    "the host's row label is the title type in foreground",
    /rowLabel:\s*\{[\s\S]{0,200}?fontSize:\s*theme\.fontSize\.base,[\s\S]{0,80}?color:\s*theme\.colors\.foreground,/.test(subagentsTrack),
  );
  check("the plugin's trailing count uses host FONT_SIZE.sm", layout.FACTS_FONT_SIZE, host.FONT_SIZE?.sm);
  check("the plugin's label uses host FONT_SIZE.base", layout.TITLE_FONT_SIZE, host.FONT_SIZE?.base);
  assert(
    "the host's settings row names itself `label, summary`",
    /accessibilityLabel=\{[^}]*summary\s*\?\s*`\$\{label\},\s*\$\{summary\}`/.test(rowHeader),
  );
  assert(
    "the host sets aria-expanded by hand on web, because RN Web ignores accessibilityState",
    /aria-expanded[\s\S]{0,80}:[\s\S]{0,40}null/.test(read("packages/app/src/composer/tracks.tsx")),
  );

  const popover = read("packages/app/src/plugins/popover.tsx");
  assert(
    "PluginPopoverContent still pads by spacing[3]",
    /content: \{ padding: theme\.spacing\[3\], gap: theme\.spacing\[2\] \}/.test(popover),
  );
  assert(
    "the plugin popover surface is still scrollable",
    shape.jsxElements(popover).some((element) => element.tag === "MenuSurface" &&
      attr(element, "maxHeight").trim() === "440" && shape.hasAttribute(element, "scrollable")),
  );
  assert(
    "MenuSurface still wraps its children in <MenuPage depth={0}>",
    (read("packages/app/src/components/ui/menu/menu-surface.tsx").match(/<MenuPage depth=\{0\}>\{children\}<\/MenuPage>/g) ?? [])
      .length >= 2,
  );
  const buttonsView = read("packages/app/src/plugins/buttons/view.tsx");
  assert(
    "the popover branch still wraps Content in PluginPopoverContent",
    /<PluginPopoverContent>[\s\S]{0,200}<Content \{\.\.\.view\.props\} close=\{close\} \/>/.test(buttonsView),
  );
  assert("the compact sheet's header still reads the button's title", /sheetTitle=\{button\.title\}/.test(buttonsView));

  const hostLightBlue = host.lightTheme?.colors.statusDotRunning;
  const hostDarkBlue = host.darkTheme?.colors.statusDotRunning;
  check("the plugin's light ring is the host's light running blue", layout.RING_COLOR_LIGHT.toLowerCase(), hostLightBlue);
  check("the plugin's dark ring is the host's dark running blue", layout.RING_COLOR_DARK.toLowerCase(), hostDarkBlue);
  assert(
    "the host's two running blues differ",
    hostLightBlue !== hostDarkBlue,
    `both are ${String(hostLightBlue)}`,
  );

  const palettes = (host.THEME_OPTIONS ?? []).filter((option) => option.name !== "auto");
  assert("the host exposes concrete palettes", palettes.length >= 2);
  for (const { name, theme } of palettes) {
    assert(`${name}: host surface and running colour are present`,
      typeof theme?.colors.surface0 === "string" && typeof theme?.colors.statusDotRunning === "string");
    check(
      `${name}: surface picks that host palette's running ring`,
      layout.ringColorFor(theme?.colors.surface0),
      theme?.colors.statusDotRunning,
    );
    assert(`${name}: settled mark colours exist in the host theme`, Object.values(marks).every((mark) =>
      mark !== undefined && (mark.kind === "ring" || typeof theme?.colors[mark.color] === "string")));
  }
  check("a missing theme falls back to the host's light ring", layout.ringColorFor(undefined), hostLightBlue);
  check("an unparseable surface falls back to the host's light ring", layout.ringColorFor("nope"), hostLightBlue);

  const permissions = read("packages/server/src/server/authorization/operation-permissions.ts");
  assert(
    "plugin.rpc.invoke is still a daemon.manage operation",
    /"plugin\.rpc\.invoke\.request":\s*"daemon\.manage"/.test(permissions),
  );
  const serverSession = read("packages/server/src/server/session.ts");
  assert(
    "a refused request still answers access_denied (permission_denied only for hosts.*)",
    /code:\s*msg\.type\.startsWith\("hosts\."\)\s*\?\s*"permission_denied"\s*:\s*"access_denied"/.test(serverSession),
  );
  assert(
    "the refusal message still reads `Session is not authorized for <type>`",
    /error:\s*`Session is not authorized for \$\{msg\.type\}`/.test(serverSession),
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
if (hostMissing) {
  console.error("INCOMPLETE: set HOST_APP to verify host parity");
  process.exit(2);
}
console.log("OK");
