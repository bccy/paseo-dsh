import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped presentation knobs for the DSH timeline rows and the tool drawer.
 *
 * Defaults preserve this fork's current `client/tokens.ts` layout rather than
 * forcing upstream's `-8` margin: users start from the existing rhythm and can
 * tighten or widen spacing explicitly from Display settings.
 */
export const timelineStyleSettings = defineSettings({
  id: "timeline-style",
  scope: "host",
  version: 5,
  migrate(values) {
    if (!isRecord(values)) return values;
    const {
      liveToolRowMarginY: _droppedLiveTool,
      liveRowMarginY,
      toolRowMarginY,
      liveReasoningRowMarginY: _droppedLiveReasoning,
      rowMarginY,
      ...rest
    } = values;
    // v1-v4 kept tool-row and streaming-row margins separate; v5 collapses them
    // into `rowMarginY`. Preserve explicit tuning in priority order, falling
    // back to this fork's default (`0`) when none was stored.
    const merged = typeof rowMarginY === "number"
      ? rowMarginY
      : typeof toolRowMarginY === "number"
        ? toolRowMarginY
        : typeof liveRowMarginY === "number"
          ? liveRowMarginY
          : 0;
    rest["rowMarginY"] = merged;
    return rest;
  },
  schema: z.object({
    rowMarginY: z.number().min(-16).max(24).default(0),
    toolRowPaddingY: z.number().min(0).max(12).default(0),
    toolRowMinHeight: z.number().min(12).max(64).default(24),
    toolRowGap: z.number().min(0).max(24).default(6),
    commandMaxHeightRatio: z.number().min(0.1).max(0.6).default(0.25),
    commandMinHeight: z.number().min(60).max(360).default(150),
  }),
});

/**
 * The language this plugin draws its own UI in. `auto` follows the relayed
 * locale (or the client default); `en` and `zh-CN` force one of the bundled
 * catalogs.
 *
 * Host-scoped on purpose: the client entry reads the stored choice once at load
 * via `settingsRpc`, and only host-scoped settings share that server-backed
 * store with `useSettings`.
 */
export const languageSettings = defineSettings({
  id: "language",
  scope: "host",
  version: 1,
  schema: z.object({
    language: z.enum(["auto", "en", "zh-CN"]).default("auto"),
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type TimelineStyleValues = z.output<typeof timelineStyleSettings.schema>;
export type TimelineStyleKey = keyof TimelineStyleValues;

export type LanguageValues = z.output<typeof languageSettings.schema>;
export type LanguageChoice = LanguageValues["language"];

export const TIMELINE_STYLE_DEFAULTS: TimelineStyleValues = {
  rowMarginY: 0,
  toolRowPaddingY: 0,
  toolRowMinHeight: 24,
  toolRowGap: 6,
  commandMaxHeightRatio: 0.25,
  commandMinHeight: 150,
};

export const LANGUAGE_DEFAULTS: LanguageValues = {
  language: "auto",
};

/**
 * Editor order for the Display settings screen. Label and hint copy lives in
 * `client/locale.ts` so the shared contract stays language-agnostic.
 */
export const TIMELINE_STYLE_KEYS = [
  "rowMarginY",
  "toolRowPaddingY",
  "toolRowMinHeight",
  "toolRowGap",
  "commandMaxHeightRatio",
  "commandMinHeight",
] as const satisfies readonly TimelineStyleKey[];

/**
 * Resolve the pixel cap for an expanded command block from the current window
 * height, falling back to `commandMinHeight` when the window height is unknown
 * or non-positive.
 */
export function resolveCommandMaxHeight(
  style: Pick<TimelineStyleValues, "commandMaxHeightRatio" | "commandMinHeight">,
  windowHeight: number,
): number {
  if (Number.isFinite(windowHeight) && windowHeight > 0) {
    return Math.max(style.commandMinHeight, Math.round(windowHeight * style.commandMaxHeightRatio));
  }
  return style.commandMinHeight;
}
