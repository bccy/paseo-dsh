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
/** `.line { padding: 0 22px }`, trimmed to the card's own body padding. */
export const DIFF_LINE_PADDING_HORIZONTAL = 14;
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
/* Block shapes                                                               */
/* -------------------------------------------------------------------------- */

/** The fields of `ToolCallData` a block shape is decided from. */
export interface CommandBlockShape {
  readonly diff: boolean;
  readonly code: boolean;
  readonly headline: string;
  readonly bodyLabel: string;
}

/** The payload caption the data layer uses today (`tool-call-data.ts`). */
const DEFAULT_OUTPUT_LABELS: readonly string[] = ["输出"];

/**
 * Whether a row expands into "command + divider + output".
 *
 * `ToolCallData` has no "this is a shell row" flag and this phase may not touch
 * the data layer, so the shape is recognised by what the data layer puts in it:
 * a command in `headline`, the printed result under the *output* caption, and
 * neither a diff nor a code surface. That covers the shell detail (bash/pwsh)
 * and a `/`-command row that carries a description, and it excludes `web_fetch`
 * ("响应"), `sub_agent` ("日志") and `read` ("内容") — all of which also carry a
 * headline of their own.
 *
 * The caption is passed in rather than compared to a literal, because the data
 * layer is being localized (`./locale`): the renderer hands over the current
 * locale's caption *and* the literal it uses today, so the split survives a tree
 * in which only one of the two has moved. A later phase should replace this with
 * a real field on `ToolCallData`.
 */
export function isCommandBlock(
  data: CommandBlockShape,
  outputLabels: readonly string[] = DEFAULT_OUTPUT_LABELS,
): boolean {
  return (
    !data.diff && !data.code && data.headline !== "" && outputLabels.includes(data.bodyLabel)
  );
}

/* -------------------------------------------------------------------------- */
/* Folding and caps (next phase; recorded here so they cannot drift)          */
/* -------------------------------------------------------------------------- */

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
