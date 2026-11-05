/**
 * A composer pill's icon with the running ring **on its corner** (T10b).
 *
 * Several pills used to swap their glyph for the same blue running ring. When
 * a crowded rail made the host shrink plugin pills to their icons, the team
 * and jobs pills became two identical rings. The glyph now always stays, and
 * a small ring sits on its bottom-right corner — the host's `StatusIcon` way
 * of marking a provider icon, and the goal panel's whale corner (`Whale` in
 * `./goal-popover`), scaled to the pill's 14px glyph:
 *
 * - a {@link PILL_CORNER_FRAME}px frame filled with the pill's own surface,
 *   so the ring knocks a {@link PILL_CORNER_KNOCKOUT}px gap out of the glyph
 *   instead of sitting on a square patch;
 * - inside it a {@link PILL_CORNER_RING}px ring (1px stroke, 3px centre).
 *
 * The host draws the icon in a 16×16 box with `overflow: hidden`
 * (`plugins/buttons/view.tsx` `styles.icon`), so the frame is placed to stay
 * inside it: with the 14px glyph centred, an offset of {@link PILL_CORNER_OFFSET}
 * puts the frame's outer edge exactly on the box edge.
 *
 * @module dsh-paseo/client/corner-ring
 */
import type { PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { ringColorFor } from "./jobs-popover-layout";
import { StatusRingMark } from "./status-ring";

/** The corner frame's edge (ring + knockout on each side). */
export const PILL_CORNER_FRAME = 9;
/** The knockout around the ring, in the pill's surface colour. */
export const PILL_CORNER_KNOCKOUT = 1.5;
/** The ring itself: frame minus the knockout on both sides. */
export const PILL_CORNER_RING = PILL_CORNER_FRAME - 2 * PILL_CORNER_KNOCKOUT;
/** Offset from the glyph's bottom-right: one pixel out, still inside the host's 16px box. */
export const PILL_CORNER_OFFSET = -1;

/** The glyph names the three pills draw under the corner ring. */
export type PillGlyph = "Users" | "Target" | "CircleCheck" | "SquareTerminal";

/**
 * The base glyph, plus the corner ring when `running`.
 *
 * `backdrop` is the pill's fill — `surface1` at rest (the host's
 * `composerPillStyles.body`); the plugin icon props carry no hover state, so
 * the knockout keeps the rest colour.
 */
export function CornerRingIcon({
  name,
  size,
  color,
  running,
  theme,
}: {
  name: PillGlyph;
  size: number;
  color: string;
  running: boolean;
  theme: PluginButtonIconProps["theme"];
}) {
  return (
    <View style={{ width: size, height: size }}>
      <Icon name={name} size={size} color={color} />
      {running ? (
        <View
          testID="pill-corner-ring"
          accessibilityRole="progressbar"
          style={{ position: "absolute", right: PILL_CORNER_OFFSET, bottom: PILL_CORNER_OFFSET, width: PILL_CORNER_FRAME, height: PILL_CORNER_FRAME }}
        >
          <StatusRingMark
            size={PILL_CORNER_FRAME}
            ring={PILL_CORNER_RING}
            color={ringColorFor(theme.colors.surface0)}
            backdrop={theme.colors.surface1}
          />
        </View>
      ) : null}
    </View>
  );
}
