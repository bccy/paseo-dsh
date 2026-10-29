import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * How the answer-stats row sits under a completed turn's footer.
 *
 * The defaults are what the row was drawn against: Paseo draws that footer at
 * `STREAM_METADATA_FONT_SIZE` (13px), and 6px above the row reads as one block
 * with it. A theme plugin redraws the footer, and a reader may want a
 * different rhythm or text size, so both numbers are host settings instead of
 * constants — registered by `index.server.ts`, read by the row and by the
 * settings screen.
 */
export const streamStatsSettings = defineSettings({
  id: "stream-stats",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Space between the footer's last line and the stats row, in px. */
    gapPx: z.number().min(0).max(24).default(6),
    /** The row's text size; Paseo's own footer draws at 13. */
    fontSize: z.number().min(10).max(16).default(13),
  }),
});

export type StreamStatsSettings = z.output<typeof streamStatsSettings.schema>;

/** What the row falls back to while the settings are still loading. */
export const DEFAULT_STREAM_STATS: StreamStatsSettings = { gapPx: 6, fontSize: 13 };
