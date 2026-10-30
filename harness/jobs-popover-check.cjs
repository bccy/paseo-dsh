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
};
for (const [name, expected] of Object.entries(EXPECTED)) check(name, layout[name], expected);

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

// Check the JSX consumers, not just the helpers they are meant to use.
console.log("\nUI wiring");
const pillSource = readSource("paseo-plugin/client/jobs-pill.tsx");
const spinnerSource = readSource("paseo-plugin/client/jobs-spinner.tsx");
const pillElements = shape.jsxElements(pillSource);
const attr = (element, name) => shape.attributeOf(element, name)?.value ?? "";
const calls = (expression, name) => shape.callArguments(expression, name);
check("job and note rows apply rowBox(compact)", pillElements.filter((element) =>
  element.tag === "View" && calls(attr(element, "style"), "rowBox").some((args) => shape.mentions(args, "compact"))).length, 2);
assert("the text column applies rowTextColumn", pillElements.some((element) =>
  element.tag === "View" && calls(attr(element, "style"), "rowTextColumn").length === 1));
assert("popover root is built with popoverRootBox", /const\s+root\s*=\s*popoverRootBox\(\s*\)/.test(pillSource));
check("all three popover branches apply the root box", pillElements.filter((element) =>
  element.tag === "View" && attr(element, "style").trim() === "root").length, 3);
const rows = pillElements.filter((element) => ["JobRow", "NoteLine"].includes(element.tag));
assert("rows and notes take host compact density", rows.length === 3 && rows.every((element) =>
  attr(element, "compact").replace(/\s/g, "") === "layout.compact"));
assert("rows stay read-only with no inner scroll view", !pillElements.some((element) =>
  ["Pressable", "ScrollView"].includes(element.tag)));
assert("the job mark passes its theme to JobsSpinner", pillElements.some((element) =>
  element.tag === "JobsSpinner" && attr(element, "theme").trim() === "theme"));
assert("spinner colour comes from the theme surface", calls(spinnerSource, "ringColorFor").some((args) =>
  args.replace(/\s/g, "") === "theme?.colors.surface0"));
assert("spinner arc receives that colour", shape.jsxElements(spinnerSource).some((element) =>
  element.tag === "RotatingArc" && attr(element, "color").trim() === "color"));

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
