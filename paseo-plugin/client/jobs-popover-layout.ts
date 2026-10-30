/**
 * The geometry of the jobs popover's rows, copied from the host's composer track
 * rows.
 *
 * A plugin bundle cannot import host internals — its externals are exactly
 * `react`, `react-native`, `react/jsx-runtime`, `zod`, `@getpaseo/plugin` and
 * `@tanstack/react-query` — and the plugin theme carries no `spacing`,
 * `borderRadius` or `fontSize`. So the look is reproduced by copying numbers, and
 * this module is where they live.
 *
 * It has no imports at all, which is what lets the harness compile it alone and
 * `require` it with plain `node`.
 *
 * @module dsh-paseo/client/jobs-popover-layout
 */

/* -------------------------------------------------------------------------- */
/* The row                                                                    */
/* -------------------------------------------------------------------------- */

/** Between a row's mark and its text. = host `spacing[2]`. */
export const ROW_GAP = 8;

/**
 * The row's horizontal inset, inside its own fill. = host `spacing[2]`.
 *
 * Not 12: the 12 that reads like a row inset belongs to the *page*, and the row
 * insets 8 from its own margin.
 */
export const ROW_PADDING_HORIZONTAL = 8;

/** The row's vertical padding: taller under a finger. = host `spacing[2]` / `spacing[1]`. */
export const ROW_PADDING_VERTICAL_COMPACT = 8;
export const ROW_PADDING_VERTICAL_WIDE = 4;

/** The gutter that keeps a row's fill off the panel edge. = host `spacing[1]`. */
export const ROW_MARGIN_HORIZONTAL = 4;

/** = host `borderRadius.md`. */
export const ROW_BORDER_RADIUS = 6;

/** The height floor, so a taller mark cannot resize the row. = host `MENU_ITEM_HEIGHT.xs` / 32. */
export const ROW_MIN_HEIGHT_COMPACT = 40;
export const ROW_MIN_HEIGHT_WIDE = 32;

/* -------------------------------------------------------------------------- */
/* The row's mark                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The box every row's mark sits in. = the host's 14px icon slot.
 *
 * Fixed rather than sized to the glyph, which is the host's own choice for these
 * rows: it puts a settled dot and a running ring on the same text rail.
 */
export const MARK_BOX = 14;

/** A settled job's dot. = host `STATUS_INDICATOR_FILLED_DOT_SIZE`. */
export const MARK_DOT_SIZE = 6;

/* -------------------------------------------------------------------------- */
/* The row's text                                                             */
/* -------------------------------------------------------------------------- */

/** = host `fontSize.base`. */
export const TITLE_FONT_SIZE = 14;

/** = host `fontSize.sm`. */
export const FACTS_FONT_SIZE = 12;

/** Which of the two vertical paddings and height floors a row uses. */
export interface RowDensity {
  readonly compact: boolean;
}

/** The row's own box, as a plain style object (no React Native import needed). */
export interface RowBox {
  readonly flexDirection: "row";
  readonly alignItems: "center";
  readonly gap: number;
  readonly minHeight: number;
  readonly marginHorizontal: number;
  readonly paddingHorizontal: number;
  readonly paddingVertical: number;
  readonly borderRadius: number;
}

/**
 * One row's box, and the note's: every field is a constant above, so the harness
 * can assert the assembled result rather than the pieces.
 */
export function rowBox(density: RowDensity): RowBox {
  return {
    flexDirection: "row",
    alignItems: "center",
    gap: ROW_GAP,
    minHeight: density.compact ? ROW_MIN_HEIGHT_COMPACT : ROW_MIN_HEIGHT_WIDE,
    marginHorizontal: ROW_MARGIN_HORIZONTAL,
    paddingHorizontal: ROW_PADDING_HORIZONTAL,
    paddingVertical: density.compact ? ROW_PADDING_VERTICAL_COMPACT : ROW_PADDING_VERTICAL_WIDE,
    borderRadius: ROW_BORDER_RADIUS,
  };
}

/**
 * The title-over-facts column.
 *
 * `flexBasis: "auto"` is the load-bearing field: a zero basis contributes nothing
 * to the row's intrinsic width, so the panel measures itself at its floor and
 * truncates every label at once. `minWidth: 0` is what lets the ellipsis appear.
 * No `gap` — the host declares none, so adding one would make every row taller.
 */
export interface RowTextColumn {
  readonly flexGrow: 1;
  readonly flexShrink: 1;
  readonly flexBasis: "auto";
  readonly minWidth: 0;
}

export function rowTextColumn(): RowTextColumn {
  return { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 };
}

/** The page's own rhythm, which the popover does **not** re-apply. = host `MENU_ROW_GAP`. */
export const PAGE_GAP = 0;

/** = host `MenuPage`'s `paddingVertical: spacing[1]`; the harness reads it as the expected first-row inset. */
export const PAGE_PADDING_VERTICAL = 4;

/* -------------------------------------------------------------------------- */
/* The host's popover wrapper, and the inset it forces                         */
/* -------------------------------------------------------------------------- */

/**
 * The padding `PluginPopoverContent` puts around every plugin popover body.
 * = host `spacing[3]`.
 *
 * This is the one layer a host track panel does not have, and the reason the body
 * has to cancel it: without the cancel a row lands 12 further in than the
 * subagent panel's.
 */
export const POPOVER_HOST_PADDING = 12;

/** The margin that cancels {@link POPOVER_HOST_PADDING}, on all four sides. */
export const POPOVER_CANCEL_MARGIN = -POPOVER_HOST_PADDING;

/**
 * The body's own vertical page padding: zero.
 *
 * `MenuPage` already wraps the body in `paddingVertical: spacing[1]`, and adding
 * it again is what put the first row 8 from the top instead of 4.
 */
export const POPOVER_PAGE_PADDING_VERTICAL = 0;

/** The root body's box: the cancel margin, and nothing else. */
export interface PopoverRootBox {
  readonly margin: number;
  readonly paddingVertical: number;
  readonly gap: number;
}

/**
 * The box of the popover's root node.
 *
 * The one place the cancel is written down, so the harness can assert the
 * *composition* rather than the constant alone — which is what the first version
 * of it missed.
 */
export function popoverRootBox(): PopoverRootBox {
  return {
    margin: POPOVER_CANCEL_MARGIN,
    paddingVertical: POPOVER_PAGE_PADDING_VERTICAL,
    gap: PAGE_GAP,
  };
}

/* -------------------------------------------------------------------------- */
/* The row's mark, per job status                                             */
/* -------------------------------------------------------------------------- */

/**
 * The job statuses DSH's `JobView` can carry, as a closed union.
 *
 * A copy rather than an import, because this module must stay import-free.
 * `harness/jobs-popover-check.cjs` reads `JOB_STATUSES` out of `shared/jobs.ts`
 * and asserts this table covers exactly those names, so the copy cannot drift
 * unnoticed.
 */
export type JobStatus = "running" | "stopping" | "completed" | "killed" | "failed";

/**
 * The plugin theme tokens a settled mark may use — the nearest the theme gets to
 * the host's `statusDot*` band, which it does not expose at all.
 */
export type MarkColorToken = "border" | "statusDanger";

/**
 * One status's mark.
 *
 * A union rather than `{ kind, color: token | null }`: a ring has no colour of its
 * own (the spinner holds the running blue), so making `color` absent is what stops
 * a call site from reading a plausible-looking `undefined`.
 */
export type StatusMark =
  | { readonly kind: "ring" }
  | { readonly kind: "dot"; readonly color: MarkColorToken };

/**
 * The status → mark table, from the host's own state semantics.
 *
 * A finished row is the host's `done` bucket with `showDoneAsInactive`, i.e. the
 * `border` grey — not a success green, which is a state this pill cannot have.
 *
 * Two calls worth stating: `stopping` is still live, so it keeps the ring rather
 * than claiming the job settled; and `killed` is the inactive dot, not the danger
 * colour, because a job the user stopped did not fail.
 */
const STATUS_MARKS: Readonly<Record<JobStatus, StatusMark>> = Object.freeze({
  running: { kind: "ring" },
  stopping: { kind: "ring" },
  completed: { kind: "dot", color: "border" },
  killed: { kind: "dot", color: "border" },
  failed: { kind: "dot", color: "statusDanger" },
} satisfies Record<JobStatus, StatusMark>);

/**
 * The mark for one status.
 *
 * Total over {@link JobStatus}: a status DSH adds later fails the Zod parse on the
 * wire rather than falling through to a made-up colour.
 */
export function statusMark(status: JobStatus): StatusMark {
  return STATUS_MARKS[status];
}

/* -------------------------------------------------------------------------- */
/* The running ring's colour                                                  */
/* -------------------------------------------------------------------------- */

/** The host's `statusDotRunning`, light theme. */
export const RING_COLOR_LIGHT = "#268ae0";

/** The host's `statusDotRunning`, dark theme — shared by all six dark palettes. */
export const RING_COLOR_DARK = "#5caaf6";

/**
 * The relative luminance of `#rrggbb`, in 0…1, per WCAG 2.x.
 *
 * Not a channel average: that calls `#268ae0` "light" (0.523) when its relative
 * luminance is 0.240, which would pick the wrong branch for the very colours this
 * file compares.
 *
 * Returns `undefined` for anything it cannot parse, rather than guessing.
 */
export function relativeLuminance(hex: string): number | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return undefined;
  const digits = match[1];
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : digits;
  const channel = (offset: number): number => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * The luminance above which a surface counts as a light one.
 *
 * Safe because the host's palettes are far from it: the light theme is `#ffffff`
 * (1.0) and the six dark ones run 0 … 0.025. The harness classifies every
 * `surface0` the host declares, so a future palette near this line is a red check
 * rather than a ring in the wrong blue.
 */
export const LIGHT_SURFACE_LUMINANCE = 0.5;

/**
 * Which of the host's two running blues a surface wants.
 *
 * The plugin theme exposes no `statusDot*` token, so the running blue has to come
 * from the host's two literals; `surface0` is what picks between them. Both call
 * sites go through here so the pill's icon and the panel's mark cannot disagree.
 *
 * A missing or unparseable surface returns the light colour — the host's default
 * appearance — rather than throwing: a mark in the wrong blue is cosmetic, a
 * thrown renderer is an empty panel.
 */
export function ringColorFor(surface: string | undefined): string {
  if (surface === undefined) return RING_COLOR_LIGHT;
  const luminance = relativeLuminance(surface);
  if (luminance === undefined) return RING_COLOR_LIGHT;
  return luminance > LIGHT_SURFACE_LUMINANCE ? RING_COLOR_LIGHT : RING_COLOR_DARK;
}

/* -------------------------------------------------------------------------- */
/* Recognising a permission refusal                                           */
/* -------------------------------------------------------------------------- */

/** The `rpc_error` code the daemon emits for a refused request. */
export const ACCESS_DENIED_CODE = "access_denied";

/** The prefix of the same refusal's message, for a daemon that omits the code. */
export const NOT_AUTHORIZED_PREFIX = "Session is not authorized for";

/**
 * Whether a rejected `client.rpc(...)` was the daemon **refusing the call**, as
 * opposed to the runtime failing to answer it.
 *
 * The error is a `DaemonRpcError`, which is not exported from `@getpaseo/plugin`,
 * so this cannot be an `instanceof` — it reads `code` off the object, with the
 * message prefix as a fallback for a daemon that omits it.
 *
 * Both strings are the host's, copied from the one place that produces them
 * (`server/session.ts`'s `rpc_error` branch). Everything else returns false, so a
 * transient failure keeps its own message and keeps polling — the wrong answer
 * here would either hide the pill for everyone with a flaky daemon or leave an
 * undismissable error on screen forever.
 */
export function isPermissionDeniedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (Reflect.get(error, "code") === ACCESS_DENIED_CODE) return true;
  const message = error instanceof Error ? error.message : "";
  return message.includes(NOT_AUTHORIZED_PREFIX);
}
