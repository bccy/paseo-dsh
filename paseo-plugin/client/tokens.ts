/**
 * Shared style tokens for the DSH-shaped timeline rows.
 *
 * Every number here is copied from DSH's own stylesheet (`docs/RENDER-PLAN.md`,
 * `/tmp/dsh-blocks-2-report.md`, and `docs/preview/tool-rows-dsh-vs-proposed.png`)
 * so each block stops carrying its own idea of "13px" and "8px". The values are
 * grouped by the block they belong to; the fold counts and heights at the end
 * are here for the meta-driven blocks of the next phase, which is why they have
 * no consumer yet.
 *
 * Deliberately free of React and React Native imports, so the offline harness
 * can compile and `require` this module with plain `node`
 * (`harness/style-check.cjs`). That also means `StyleSheet.hairlineWidth` cannot
 * be read here: the renderer passes RN's device hairline into the style
 * builders, and `HAIRLINE` below is the design value DSH uses (`.5px`).
 *
 * @module dsh-paseo/client/tokens
 */

/**
 * The slice of Paseo's theme this module needs.
 *
 * Structural, so `PluginTheme["colors"]` is assignable to it without an import
 * (which would drag the host runtime into the offline harness).
 */
export interface TokenColors {
  readonly surface0: string;
  readonly surface1: string;
  readonly surface2: string;
  readonly border: string;
  readonly foreground: string;
  readonly foregroundMuted: string;
  /** The theme's link colour (DSH uses `--dsw-alias-link` for every web URL). */
  readonly accent: string;
  readonly statusSuccess: string;
  readonly statusWarning: string;
  readonly statusDanger: string;
}

/* -------------------------------------------------------------------------- */
/* Row head                                                                   */
/* -------------------------------------------------------------------------- */

/** DSH draws every collapsed tool row on a fixed 24px line. */
export const ROW_HEIGHT = 24;
/** The row's summary and title size (`--dsh-content-font-size-secondary`). */
export const ROW_FONT_SIZE = 13;
/** …and its line box: `calc(24px + var(--dsh-content-font-delta, 0px))`. */
export const ROW_LINE_HEIGHT = 24;
/**
 * No vertical padding on the row itself: the 24px line box is the whole row, so
 * two adjacent rows sit 24px apart. (`paddingVertical` used to be 3/5.)
 */
export const ROW_PADDING_VERTICAL = 0;
/** Space between the head and the expanded block (DSH's body margin-top). */
export const ROW_GAP = 3;
/** Icon -> title, DSH's `.leading { margin-right: 6px }`. */
export const ROW_HEAD_GAP = 6;
/** Left inset of the expanded block. DSH: `margin: 4px 0 4px 4px` (was 12). */
export const BODY_INDENT = 4;

/** The 2x2 rounded square between title and summary — a square, not a dot. */
export const SEP_SIZE = 2;
/** `border-radius: 1px` on a 2px box: square with its corners just taken off. */
export const SEP_RADIUS = 1;
/** `margin: 0 8px` on the separator. */
export const SEP_MARGIN = 8;

/** The `+A -R` suffix is two pixels smaller than the summary (`13px - 2px`). */
export const DIFF_STAT_FONT_SIZE = 11;
/** `margin-left: 10px` on the diff stat. */
export const DIFF_STAT_MARGIN_LEFT = 10;

/** The row's root: the fixed line box, with no padding of its own. */
export function rowRootStyle(): {
  gap: number;
  paddingVertical: number;
} {
  return { gap: ROW_GAP, paddingVertical: ROW_PADDING_VERTICAL };
}

/** The head line: icon, title, separator, summary, suffix on one 24px row. */
export function rowHeadStyle(): {
  flexDirection: "row";
  alignItems: "center";
  gap: number;
  height: number;
} {
  return {
    flexDirection: "row",
    alignItems: "center",
    gap: ROW_HEAD_GAP,
    height: ROW_HEIGHT,
  };
}

/** The row's title ("运行命令", "编辑"). */
export function rowLabelTextStyle(colors: TokenColors): {
  color: string;
  fontSize: number;
  lineHeight: number;
} {
  return { color: colors.foregroundMuted, fontSize: ROW_FONT_SIZE, lineHeight: ROW_LINE_HEIGHT };
}

/**
 * The row's summary: the UI font at 13/24, **not** monospace.
 *
 * DSH's summary inherits the UI font; Paseo's stock row sets `monospace`, which
 * is the most visible remaining difference between the two. The absence of a
 * `fontFamily` here is the decision, so it is asserted offline.
 */
export function summaryTextStyle(
  colors: TokenColors,
  status: string,
): {
  color: string;
  fontSize: number;
  lineHeight: number;
  flex: number;
  minWidth: number;
} {
  return {
    color: summaryColor(colors, status),
    fontSize: ROW_FONT_SIZE,
    lineHeight: ROW_LINE_HEIGHT,
    flex: 1,
    minWidth: 0,
  };
}

/** The 2x2 separator's box. */
export function separatorStyle(colors: TokenColors): {
  width: number;
  height: number;
  borderRadius: number;
  marginHorizontal: number;
  backgroundColor: string;
} {
  return {
    width: SEP_SIZE,
    height: SEP_SIZE,
    borderRadius: SEP_RADIUS,
    marginHorizontal: SEP_MARGIN,
    backgroundColor: colors.foregroundMuted,
  };
}

/** The `+A -R` suffix: 11px monospace, grey until a later phase colours it. */
export function diffStatTextStyle(colors: TokenColors): {
  flexShrink: number;
  marginLeft: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flexShrink: 0,
    marginLeft: DIFF_STAT_MARGIN_LEFT,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: DIFF_STAT_FONT_SIZE,
    lineHeight: ROW_LINE_HEIGHT,
    color: diffStatColor(colors),
  };
}

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

/** DSH's card radius (`--dsw-radius-lg` at this size). */
export const CARD_RADIUS = 16;
/** DSH's card border: `.5px solid var(--dsw-alias-border-l1)`. */
export const HAIRLINE = 0.5;

/**
 * The card every expanded block lives in: 16px radius, one hairline border, and
 * a card surface rather than a translucent wash over the timeline.
 *
 * `hairline` defaults to the design value; the renderer passes
 * `StyleSheet.hairlineWidth` so a 3x device gets its own thinner hairline.
 */
export function cardStyle(
  colors: TokenColors,
  hairline: number = HAIRLINE,
): {
  borderRadius: number;
  borderWidth: number;
  borderColor: string;
  backgroundColor: string;
  overflow: "hidden";
} {
  return {
    borderRadius: CARD_RADIUS,
    borderWidth: hairline,
    borderColor: colors.border,
    backgroundColor: colors.surface1,
    overflow: "hidden",
  };
}

/** A full-bleed hairline: DSH draws them at the same `.5px` as the border. */
export function dividerStyle(
  colors: TokenColors,
  hairline: number = HAIRLINE,
): {
  height: number;
  backgroundColor: string;
} {
  return { height: hairline, backgroundColor: colors.border };
}

/* -------------------------------------------------------------------------- */
/* Code surfaces                                                              */
/* -------------------------------------------------------------------------- */

/** The only family any of these blocks uses: code is monospace, prose is not. */
export const CODE_FONT_FAMILY = "monospace";
/** DSH's `--dsw-font-markdown-code-block`: 11px. */
export const CODE_FONT_SIZE = 11;
/** …at 19px of line. Diff, read and search blocks all use it. */
export const CODE_LINE_HEIGHT = 19;

/** Body padding for the text/code cards (diff lines pad themselves). */
export const CODE_PADDING_VERTICAL = 12;
export const CODE_PADDING_HORIZONTAL = 14;

/* -------------------------------------------------------------------------- */
/* Command banner and output (DSH's TerminalBlock)                            */
/* -------------------------------------------------------------------------- */

/** `.header { padding: 9px 14px }` — full width, no gutter of our own. */
export const COMMAND_PADDING_VERTICAL = 9;
export const COMMAND_PADDING_HORIZONTAL = 14;
/** `--dsw-font-markdown-code-block-small`: 11px. */
export const COMMAND_FONT_SIZE = 11;
/** ToolRow rebinds `--dsl-terminal-line-height` to 18 for the output… */
export const OUTPUT_LINE_HEIGHT = 18;
/** …but the command banner itself is 11/16. */
export const COMMAND_LINE_HEIGHT = 16;

/** `.output { padding: 12px 14px 12px 0 }`, minus DSH's 30px dot gutter. */
export const OUTPUT_PADDING_VERTICAL = 12;
export const OUTPUT_PADDING_HORIZONTAL = 14;
export const OUTPUT_FONT_SIZE = 11;
/** A long command scrolls inside its banner instead of pushing the output off. */
export const COMMAND_MAX_HEIGHT = 150;
/** `.output { max-height: 224px }` under ToolRow. */
export const OUTPUT_MAX_HEIGHT = 224;

/** The command banner's own box. */
export function commandRegionStyle(): {
  paddingVertical: number;
  paddingHorizontal: number;
} {
  return {
    paddingVertical: COMMAND_PADDING_VERTICAL,
    paddingHorizontal: COMMAND_PADDING_HORIZONTAL,
  };
}

/**
 * The command: full-contrast foreground, so it reads as the subject of the card
 * while the cwd and the status stay grey.
 */
export function commandTextStyle(colors: TokenColors): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    fontFamily: CODE_FONT_FAMILY,
    fontSize: COMMAND_FONT_SIZE,
    lineHeight: COMMAND_LINE_HEIGHT,
    color: colors.foreground,
  };
}

/** The output region's own box. */
export function outputRegionStyle(): {
  paddingVertical: number;
  paddingHorizontal: number;
} {
  return {
    paddingVertical: OUTPUT_PADDING_VERTICAL,
    paddingHorizontal: OUTPUT_PADDING_HORIZONTAL,
  };
}

/** The printed output: 11/18, foreground contrast (DSH's `.line`). */
export function outputTextStyle(colors: TokenColors): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    fontFamily: CODE_FONT_FAMILY,
    fontSize: OUTPUT_FONT_SIZE,
    lineHeight: OUTPUT_LINE_HEIGHT,
    color: colors.foreground,
  };
}

/** The box a plain text/code body sits in. */
export function codeRegionStyle(): {
  paddingVertical: number;
  paddingHorizontal: number;
} {
  return {
    paddingVertical: CODE_PADDING_VERTICAL,
    paddingHorizontal: CODE_PADDING_HORIZONTAL,
  };
}

/** Read/search/unknown bodies and the block's leading subject. */
export function codeTextStyle(colors: TokenColors): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.foreground,
  };
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

export type DiffKind = "add" | "del" | "context";

/** DSH's `box-shadow: inset 3px 0 0 …`, rebuilt as a real left border in RN. */
export const DIFF_BAR_WIDTH = 3;
/** Added/removed wash over the card: 8% on light, 12% on dark. */
export const DIFF_TINT_LIGHT = 0.08;
export const DIFF_TINT_DARK = 0.12;
/**
 * `.line { padding: 0 22px }` — DSH's own inset, not the card's body padding.
 *
 * Phase 1 trimmed this to 14 because every surface then carried its own 14px
 * body padding; the diff card now has DSH's `padding: 6px 0 20px`, so the lines
 * pad themselves to 22 and line up with the card head's own 22px left inset.
 */
export const DIFF_LINE_PADDING_HORIZONTAL = 22;
/** The `+`/`-` marker column, so a full-width body still aligns under itself. */
export const DIFF_MARKER_WIDTH = 12;

export interface DiffLineStyle {
  borderLeftWidth: number;
  borderLeftColor: string;
  backgroundColor?: string;
}

/**
 * One diff line's chrome.
 *
 * Every line carries the same 3px left border, transparent on context rows:
 * DSH's bar is an inset shadow and does not consume layout, while a real border
 * does — a context line without one would sit 3px to the left of its neighbours
 * and the hunk would read as misaligned.
 */
export function diffLineStyle(colors: TokenColors, kind: DiffKind, light: boolean): DiffLineStyle {
  const base: DiffLineStyle = { borderLeftWidth: DIFF_BAR_WIDTH, borderLeftColor: "transparent" };
  if (kind === "add") {
    return {
      ...base,
      borderLeftColor: colors.statusSuccess,
      backgroundColor: diffTint(colors.statusSuccess, light),
    };
  }
  if (kind === "del") {
    return {
      ...base,
      borderLeftColor: colors.statusDanger,
      backgroundColor: diffTint(colors.statusDanger, light),
    };
  }
  return base;
}

/** A diff line's text: semantic on add/remove, muted on context. */
export function diffTextColor(colors: TokenColors, kind: DiffKind): string {
  if (kind === "add") return colors.statusSuccess;
  if (kind === "del") return colors.statusDanger;
  return colors.foregroundMuted;
}

/** The marker column and the code text of one diff line. */
export function diffMarkerTextStyle(colors: TokenColors, kind: DiffKind): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  width: number;
  color: string;
} {
  return {
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    width: DIFF_MARKER_WIDTH,
    color: diffTextColor(colors, kind),
  };
}

export function diffBodyTextStyle(colors: TokenColors, kind: DiffKind): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  flex: number;
  minWidth: number;
  color: string;
} {
  return {
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    flex: 1,
    minWidth: 0,
    color: diffTextColor(colors, kind),
  };
}

/* -------------------------------------------------------------------------- */
/* Colour decisions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The row's leading icon is never recoloured — DSH signals a failure with the
 * summary text only, and the icon keeps its muted colour on every state.
 */
export function rowIconColor(colors: TokenColors): string {
  return colors.foregroundMuted;
}

/**
 * A failed row's summary turns red (DSH: `--dsw-alias-state-error-primary`).
 *
 * DSH also has a stopped state that paints the summary in the warning colour;
 * Paseo's tool status carries no such state yet, so only failure maps here.
 */
export function summaryColor(colors: TokenColors, status: string): string {
  return status === "failed" ? colors.statusDanger : colors.foregroundMuted;
}

/** The `+A -R` suffix stays grey until a later phase colours it on expand. */
export function diffStatColor(colors: TokenColors): string {
  return colors.foregroundMuted;
}

/** `alpha` of `color`, as `rgba(...)`. */
export function withAlpha(color: string, alpha: number): string {
  const trimmed = color.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(trimmed);
  if (hex !== null) {
    const digits = hex[1];
    const full =
      digits.length === 3 || digits.length === 4
        ? digits
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : digits;
    if (full.length !== 6 && full.length !== 8) return trimmed;
    const value = Number.parseInt(full.slice(0, 6), 16);
    return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/i.exec(trimmed);
  if (rgb !== null) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  // A colour we cannot take apart (a CSS variable, an `oklch()`, a named
  // colour) keeps the bar and the coloured text but drops the wash: painting
  // the line in the solid semantic colour would swallow the text on top of it.
  return "transparent";
}

/** The added/removed line wash for one theme. */
export function diffTint(color: string, light: boolean): string {
  return withAlpha(color, light ? DIFF_TINT_LIGHT : DIFF_TINT_DARK);
}

/**
 * Whether a colour reads as light, so the diff wash uses 8% instead of 12%.
 *
 * The same luminance rule `./shimmer-css` uses for the sweep, duplicated here
 * because that module imports React Native and this one must load in plain
 * `node`.
 */
export function isLightSurface(color: string): boolean {
  const luminance = (r: number, g: number, b: number) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const trimmed = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (hex !== null) {
    const digits = hex[1];
    const full =
      digits.length === 3
        ? digits
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : digits;
    const value = Number.parseInt(full, 16);
    return luminance((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff) > 0.5;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/i.exec(trimmed);
  if (rgb !== null) return luminance(Number(rgb[1]), Number(rgb[2]), Number(rgb[3])) > 0.5;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Diff summary                                                               */
/* -------------------------------------------------------------------------- */

export interface DiffTotals {
  readonly added: number;
  readonly removed: number;
}

/** Lines a unified diff adds or removes, ignoring `+++`/`---` file headers. */
export function diffTotals(body: string): DiffTotals {
  let added = 0;
  let removed = 0;
  for (const line of body.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * Whether a body is a real diff rather than a file's raw text.
 *
 * `write` carries the file's contents verbatim (the server reads
 * `input.content`), so counting its `-` lines would turn a Markdown bullet into
 * a deletion. A body counts as a diff when every non-empty line carries a diff
 * prefix — which is what the `edit` path produces (unified diff, or `- old` /
 * `+ new` synthesized by the data layer).
 */
export function diffShaped(body: string): boolean {
  const lines = body.split("\n").filter((line) => line !== "");
  if (lines.length === 0) return false;
  return lines.every((line) => /^[+\- @\\]/.test(line));
}

/**
 * The `+A -R` totals for a row, or null when the row shows no stat.
 *
 * DSH drops the stat on a row that settled with a cue (error/stopped) — the
 * summary has already become the error line — and only counts a real diff. A
 * `write` body of raw contents therefore yields null instead of a fabricated
 * `+0 -3`; giving `write` a real hunk diff is the next phase's job.
 */
export function diffStat(data: {
  readonly diff: boolean;
  readonly body: string;
  readonly status: string;
}): DiffTotals | null {
  if (data.status === "failed" || data.status === "canceled") return null;
  if (!data.diff) return null;
  const totals = diffTotals(data.body);
  if (totals.added + totals.removed === 0) return null;
  return diffShaped(data.body) ? totals : null;
}

/* -------------------------------------------------------------------------- */
/* Card head (DSH's `CodeToolbar`)                                            */
/* -------------------------------------------------------------------------- */

/**
 * `.header { padding: 10px 18px 8px 22px }` on DSH's code card.
 *
 * The asymmetry is DSH's own: the head lines up with the diff body's own
 * `padding: 0 22px` on the left and with its narrower right inset on the right.
 */
export const CARD_HEAD_PADDING_TOP = 10;
export const CARD_HEAD_PADDING_RIGHT = 18;
export const CARD_HEAD_PADDING_BOTTOM = 8;
export const CARD_HEAD_PADDING_LEFT = 22;
/** `.heading { gap: 12px }` between the language tag and the title. */
export const CARD_HEAD_GAP = 12;
/** `font: 11px/18px` on the whole banner; the language tag is monospace. */
export const CARD_HEAD_FONT_SIZE = 11;
export const CARD_HEAD_LINE_HEIGHT = 18;
/** `.status { margin-right: 8px }`, so the copy control is not glued to it. */
export const CARD_HEAD_STATUS_MARGIN_RIGHT = 8;
/** `.actions { gap: 4px }`. */
export const CARD_HEAD_ACTION_GAP = 4;

/** `.heading { gap: 12px; min-width: 0 }` — the language tag and the title. */
export function cardHeadHeadingStyle(): {
  flexDirection: "row";
  alignItems: "baseline";
  gap: number;
  flexShrink: number;
  minWidth: number;
} {
  return { flexDirection: "row", alignItems: "baseline", gap: CARD_HEAD_GAP, flexShrink: 1, minWidth: 0 };
}

/** `.actions { gap: 4px }` — the status and the copy control. */
export function cardHeadActionsStyle(): {
  flexDirection: "row";
  alignItems: "center";
  gap: number;
  flexShrink: number;
} {
  return { flexDirection: "row", alignItems: "center", gap: CARD_HEAD_ACTION_GAP, flexShrink: 0 };
}

/** The banner above a read/diff body: language, title, status, copy. */
export function cardHeadStyle(): {
  flexDirection: "row";
  alignItems: "center";
  justifyContent: "space-between";
  gap: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
} {
  return {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: CARD_HEAD_GAP,
    paddingTop: CARD_HEAD_PADDING_TOP,
    paddingRight: CARD_HEAD_PADDING_RIGHT,
    paddingBottom: CARD_HEAD_PADDING_BOTTOM,
    paddingLeft: CARD_HEAD_PADDING_LEFT,
  };
}

/** The language tag: `--dsw-alias-label-tertiary`, monospace, never shrunk. */
export function cardHeadLangTextStyle(colors: TokenColors): {
  flexShrink: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flexShrink: 0,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CARD_HEAD_FONT_SIZE,
    lineHeight: CARD_HEAD_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** The title (usually the path): tertiary, one line, ellipsised by the caller. */
export function cardHeadTitleTextStyle(colors: TokenColors): {
  flexShrink: number;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flexShrink: 1,
    fontSize: CARD_HEAD_FONT_SIZE,
    lineHeight: CARD_HEAD_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** The status slot DSH uses for the read card's `显示 X / Y 行`. */
export function cardHeadStatusTextStyle(colors: TokenColors): {
  flexShrink: number;
  marginRight: number;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flexShrink: 0,
    marginRight: CARD_HEAD_STATUS_MARGIN_RIGHT,
    fontSize: CARD_HEAD_FONT_SIZE,
    lineHeight: CARD_HEAD_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** The copy control: DSH's `.copyButton`, 13px secondary, no chrome of its own. */
export function cardHeadActionTextStyle(colors: TokenColors): {
  flexShrink: number;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flexShrink: 0,
    fontSize: ROW_FONT_SIZE,
    lineHeight: SEARCH_SUMMARY_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/* -------------------------------------------------------------------------- */
/* Search block (DSH's `SearchBlock`)                                         */
/* -------------------------------------------------------------------------- */

/** `.header { padding: 9px 14px; gap: 12px }` — the stats banner. */
export const SEARCH_HEAD_PADDING_VERTICAL = 9;
export const SEARCH_HEAD_PADDING_HORIZONTAL = 14;
export const SEARCH_HEAD_GAP = 12;
/** `.summary { font: var(--dsw-font-xs-13) }` = 13px/20px, one ellipsised line. */
export const SEARCH_SUMMARY_FONT_SIZE = 13;
export const SEARCH_SUMMARY_LINE_HEIGHT = 20;
/** `.body { padding: 8px 14px 12px 0 }` — right 0, so a long line scrolls flush. */
export const SEARCH_BODY_PADDING_TOP = 8;
export const SEARCH_BODY_PADDING_BOTTOM = 12;
export const SEARCH_BODY_PADDING_RIGHT = 14;
/** `--dsl-search-line-height: 22px` on every row (a `min-height`, not a line box). */
export const SEARCH_LINE_MIN_HEIGHT = 22;
/** `.line { padding-left: 14px }`. */
export const SEARCH_LINE_PADDING_LEFT = 14;
/** `.fileHeader { gap: 8px }` between a group's path and its match count. */
export const SEARCH_FILE_GAP = 8;
/** `.empty { padding: 12px 14px }`. */
export const SEARCH_EMPTY_PADDING_VERTICAL = 12;
export const SEARCH_EMPTY_PADDING_HORIZONTAL = 14;

/**
 * The stats banner: 9/14 padding, one line of 13/20 with the copy on the right.
 *
 * Unlike the code card's head (which shares the card's surface), DSH paints this
 * one on `--dsw-alias-markdown-code-block-banner`; `surface2` is the theme's
 * nearest raised surface. The card's `overflow: hidden` clips it to the corners.
 */
export function searchHeadStyle(colors: TokenColors): {
  flexDirection: "row";
  alignItems: "center";
  gap: number;
  paddingVertical: number;
  paddingHorizontal: number;
  backgroundColor: string;
} {
  return {
    flexDirection: "row",
    alignItems: "center",
    gap: SEARCH_HEAD_GAP,
    paddingVertical: SEARCH_HEAD_PADDING_VERTICAL,
    paddingHorizontal: SEARCH_HEAD_PADDING_HORIZONTAL,
    backgroundColor: colors.surface2,
  };
}

/** The statistics line: 13/20 secondary, takes the free space, one line. */
export function searchSummaryTextStyle(colors: TokenColors): {
  flex: number;
  minWidth: number;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flex: 1,
    minWidth: 0,
    fontSize: SEARCH_SUMMARY_FONT_SIZE,
    lineHeight: SEARCH_SUMMARY_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/**
 * One search row's box: a 22px slot, indented 14px.
 *
 * DSH keeps matches on one line (`white-space: pre`) and scrolls sideways; RN
 * has no `pre`, so the renderer puts these rows inside a horizontal scroll view
 * and the text is never asked to shrink (`flexShrink: 0` on the text styles).
 */
export function searchLineStyle(): {
  flexDirection: "row";
  alignItems: "flex-start";
  minHeight: number;
  paddingLeft: number;
} {
  return {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: SEARCH_LINE_MIN_HEIGHT,
    paddingLeft: SEARCH_LINE_PADDING_LEFT,
  };
}

/** The same slot for a file group's header, which sets its own side padding. */
export function searchFileHeadStyle(): {
  flexDirection: "row";
  alignItems: "flex-start";
  gap: number;
  minHeight: number;
  paddingHorizontal: number;
} {
  return {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SEARCH_FILE_GAP,
    minHeight: SEARCH_LINE_MIN_HEIGHT,
    paddingHorizontal: SEARCH_LINE_PADDING_LEFT,
  };
}

/** A match's `行号: ` prefix — 11/19 monospace, tertiary, never shrunk. */
export function searchLineNumberTextStyle(colors: TokenColors): {
  flexShrink: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flexShrink: 0,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** A match line's text — the code surface, never shrunk (it scrolls instead). */
export function searchLineTextStyle(colors: TokenColors): {
  flexShrink: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flexShrink: 0,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.foreground,
  };
}

/** A group's path: bold 600 primary, DSH's `.filePath`. */
export function searchFilePathTextStyle(colors: TokenColors): {
  flexShrink: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: "600";
  color: string;
} {
  return {
    flexShrink: 0,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    fontWeight: "600",
    color: colors.foreground,
  };
}

/** A group's match count: tertiary, DSH's `.fileCount`. */
export function searchFileCountTextStyle(colors: TokenColors): {
  flexShrink: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flexShrink: 0,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** The fold control. Same 11/19 mono, tertiary, aligned with the rows. */
export function searchExpandTextStyle(colors: TokenColors): {
  flexShrink: number;
  paddingLeft: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flexShrink: 0,
    paddingLeft: SEARCH_LINE_PADDING_LEFT,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** `.empty { padding: 12px 14px }`, tertiary. */
export function searchEmptyTextStyle(colors: TokenColors): {
  paddingVertical: number;
  paddingHorizontal: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    paddingVertical: SEARCH_EMPTY_PADDING_VERTICAL,
    paddingHorizontal: SEARCH_EMPTY_PADDING_HORIZONTAL,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/* -------------------------------------------------------------------------- */
/* Read block (DSH's `ReadBlock`)                                             */
/* -------------------------------------------------------------------------- */

/** `.body { padding: 6px 22px 20px }` on the read/diff card. */
export const READ_BODY_PADDING_TOP = 6;
export const READ_BODY_PADDING_BOTTOM = 20;
export const READ_BODY_PADDING_HORIZONTAL = 22;
/** `.gutter { margin-right: 12px }`, between the line number and the code. */
export const READ_GUTTER_MARGIN = 12;
/**
 * The gutter's width in DSH is `max(3, digits)ch` — a `ch` is the width of `0` in
 * the current font, and RN has no `ch`, so the same measure is taken here as
 * `0.6em` of the 11px code size.
 */
export const READ_GUTTER_MIN_DIGITS = 3;
export const READ_GUTTER_CHAR_WIDTH = 6.6;

/** The gutter's width for the widest line number in the block, in device px. */
export function readGutterWidth(digits: number): number {
  return Math.max(READ_GUTTER_MIN_DIGITS, digits) * READ_GUTTER_CHAR_WIDTH;
}

/** One read row: gutter + content, kept on one line. */
export function readLineStyle(): {
  flexDirection: "row";
  alignItems: "flex-start";
  minHeight: number;
} {
  return { flexDirection: "row", alignItems: "flex-start", minHeight: CODE_LINE_HEIGHT };
}

/** The line number: right-aligned, tertiary, and never selected (see renderer). */
export function readGutterTextStyle(colors: TokenColors, digits: number): {
  width: number;
  marginRight: number;
  textAlign: "right";
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    width: readGutterWidth(digits),
    marginRight: READ_GUTTER_MARGIN,
    textAlign: "right",
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** The code itself: primary contrast, never shrunk (it scrolls instead). */
export function readLineTextStyle(colors: TokenColors): {
  flexShrink: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flexShrink: 0,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.foreground,
  };
}

/** `.expand { padding-left: calc(gutter + 12px) }` — aligned with the code. */
export function readExpandTextStyle(colors: TokenColors, digits: number): {
  flexShrink: number;
  paddingLeft: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    flexShrink: 0,
    paddingLeft: readGutterWidth(digits) + READ_GUTTER_MARGIN,
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** A diff row's path header and hunk header share one muted line style. */
export function diffChromeTextStyle(colors: TokenColors): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    fontFamily: CODE_FONT_FAMILY,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** A diff row's box: the same `padding: 0 22px` and 19px line as the read block. */
export function diffRowStyle(): {
  flexDirection: "row";
  paddingHorizontal: number;
} {
  return { flexDirection: "row", paddingHorizontal: DIFF_LINE_PADDING_HORIZONTAL };
}

/** `.body { padding: 6px 0 20px }` on the diff card (the lines pad themselves). */
export function diffBodyStyle(): { paddingTop: number; paddingBottom: number } {
  return { paddingTop: READ_BODY_PADDING_TOP, paddingBottom: READ_BODY_PADDING_BOTTOM };
}

/* -------------------------------------------------------------------------- */
/* Web block (DSH's `WebBlock`)                                               */
/* -------------------------------------------------------------------------- */

/** `.block { padding: 12px 14px }` — one surface, no banner of its own. */
export const WEB_PADDING_VERTICAL = 12;
export const WEB_PADDING_HORIZONTAL = 14;
/** `.fetch { gap: 6px }` between the URL and its status row. */
export const WEB_GAP = 6;
/** `.fetchUrl { font-family: code; font-size: 13px; line-height: 19px }`. */
export const WEB_URL_FONT_SIZE = 13;
export const WEB_URL_LINE_HEIGHT = 19;
/** `.fetchMeta { gap: 12px }`, `.status { font: 13px/20px }`. */
export const WEB_META_GAP = 12;
export const WEB_STATUS_FONT_SIZE = 13;
export const WEB_STATUS_LINE_HEIGHT = 20;
/** `.sources { max-height: 320px; overflow-y: auto; gap: 10px }`. */
export const WEB_SOURCES_MAX_HEIGHT = 320;
export const WEB_SOURCE_GAP = 10;
/**
 * RN has no `<ol>` and no `value` attribute, so the reference number is drawn as
 * a column of its own. DSH reserves `2.5em` of padding for it (~32px against the
 * 13px list font); the column here is that measure, minus the gap it already has.
 */
export const WEB_SOURCE_INDEX_WIDTH = 24;
export const WEB_SOURCE_INDEX_GAP = 8;
/** `.sourceLink { font-size: 14px; line-height: 20px; font-weight: 500 }`. */
export const WEB_SOURCE_LINK_FONT_SIZE = 14;
export const WEB_SOURCE_LINK_LINE_HEIGHT = 20;
/** `.snippet { margin-top: 2px; font-size: 13px; line-height: 19px }`. */
export const WEB_SNIPPET_FONT_SIZE = 13;
export const WEB_SNIPPET_LINE_HEIGHT = 19;
export const WEB_SNIPPET_MARGIN_TOP = 2;
/** `.published { margin-top: 2px; font: 13px/20px }`, and `.truncated` too. */
export const WEB_PUBLISHED_LINE_HEIGHT = 20;

/** The card's own box: one padded surface for both web shapes. */
export function webCardBodyStyle(): {
  paddingVertical: number;
  paddingHorizontal: number;
} {
  return { paddingVertical: WEB_PADDING_VERTICAL, paddingHorizontal: WEB_PADDING_HORIZONTAL };
}

/** The fetch shape's column: URL over a status/truncation row. */
export function webFetchStyle(): {
  flexDirection: "column";
  gap: number;
} {
  return { flexDirection: "column", gap: WEB_GAP };
}

/** The fetch URL: link colour, monospace 13/19, weight 500. */
export function webUrlTextStyle(colors: TokenColors): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: "500";
  color: string;
} {
  return {
    fontFamily: CODE_FONT_FAMILY,
    fontSize: WEB_URL_FONT_SIZE,
    lineHeight: WEB_URL_LINE_HEIGHT,
    fontWeight: "500",
    color: colors.accent,
  };
}

/** The status row's `HTTP 200`: 13/20 secondary. */
export function webMetaTextStyle(colors: TokenColors): {
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    fontSize: WEB_STATUS_FONT_SIZE,
    lineHeight: WEB_STATUS_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** `.truncated { margin-top: 8px }` — zeroed inside the fetch card. */
export const WEB_TRUNCATED_MARGIN_TOP = 8;

/** The truncation notes (both shapes): 13/20 tertiary. */
export function webTruncatedTextStyle(
  colors: TokenColors,
  marginTop: number = 0,
): {
  marginTop: number;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    marginTop,
    fontSize: WEB_STATUS_FONT_SIZE,
    lineHeight: WEB_PUBLISHED_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** The scroll container the whole citation list lives in (`max-height: 320px`). */
export function webSourcesStyle(): { maxHeight: number } {
  return { maxHeight: WEB_SOURCES_MAX_HEIGHT };
}

/** One numbered reference row: the number column plus the source. */
export function webSourceRowStyle(): {
  flexDirection: "row";
  alignItems: "flex-start";
  marginBottom: number;
} {
  return { flexDirection: "row", alignItems: "flex-start", marginBottom: WEB_SOURCE_GAP };
}

/** The reference number: right-aligned in its own column, muted. */
export function webSourceIndexTextStyle(colors: TokenColors): {
  width: number;
  marginRight: number;
  textAlign: "right";
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    width: WEB_SOURCE_INDEX_WIDTH,
    marginRight: WEB_SOURCE_INDEX_GAP,
    textAlign: "right",
    fontSize: WEB_SNIPPET_FONT_SIZE,
    lineHeight: WEB_SOURCE_LINK_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** A source's title (or hostname): link colour, 14/20, weight 500. */
export function webSourceLinkTextStyle(colors: TokenColors): {
  fontSize: number;
  lineHeight: number;
  fontWeight: "500";
  color: string;
} {
  return {
    fontSize: WEB_SOURCE_LINK_FONT_SIZE,
    lineHeight: WEB_SOURCE_LINK_LINE_HEIGHT,
    fontWeight: "500",
    color: colors.accent,
  };
}

/** A source's snippet: 13/19 secondary, 2px under the title. */
export function webSnippetTextStyle(colors: TokenColors): {
  marginTop: number;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    marginTop: WEB_SNIPPET_MARGIN_TOP,
    fontSize: WEB_SNIPPET_FONT_SIZE,
    lineHeight: WEB_SNIPPET_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/** A source's date: 13/20 tertiary, 2px under the snippet. */
export function webPublishedTextStyle(colors: TokenColors): {
  marginTop: number;
  fontSize: number;
  lineHeight: number;
  color: string;
} {
  return {
    marginTop: WEB_SNIPPET_MARGIN_TOP,
    fontSize: WEB_SNIPPET_FONT_SIZE,
    lineHeight: WEB_PUBLISHED_LINE_HEIGHT,
    color: colors.foregroundMuted,
  };
}

/* -------------------------------------------------------------------------- */
/* Folding                                                                    */
/* -------------------------------------------------------------------------- */

export interface FoldWindow {
  /** Rows the cap hides. `<= 0` means the block is short enough to show whole. */
  readonly hidden: number;
  /** Whether the middle is actually folded right now. */
  readonly capped: boolean;
  /** Rows kept at the top while folded. */
  readonly headLines: number;
  /** Rows kept at the bottom while folded. */
  readonly tailLines: number;
}

/**
 * DSH's `headTailCap` (`dsh-client-ui-primitives/lib/index.js`), verbatim.
 *
 * Shared by the search, read and diff blocks and asserted offline, because the
 * numbers are invisible-but-exact: an 8-line cap shows 4 + 4, a 9-line cap shows
 * 5 + 4, and "is it folded at all" is `hidden > 0 && !expanded`.
 */
export function foldWindow(total: number, maxLines: number, expanded: boolean): FoldWindow {
  const hidden = total - maxLines;
  const headLines = Math.ceil(maxLines / 2);
  return { hidden, capped: hidden > 0 && !expanded, headLines, tailLines: maxLines - headLines };
}

/**
 * Lines a block shows before folding, per DSH's `maxLines`.
 *
 * The fold is head + "… 其余 N 行" + tail, and a diff folds 9 (head 5 + tail 4)
 * while search and read fold 8 (head 4 + tail 4).
 */
export const FOLD_LINES = { diff: 9, read: 8, search: 8 } as const;
/** DSH's TerminalBlock passes `maxLines: Infinity`. */
export const TERMINAL_MAX_LINES = Number.POSITIVE_INFINITY;
/** `.bodyScroll { max-height: 260px }` on the code-tool card. */
export const CODE_MAX_HEIGHT = 260;
