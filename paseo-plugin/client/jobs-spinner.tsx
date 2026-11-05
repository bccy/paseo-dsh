/**
 * The jobs pill's icon, and a job row's live mark: the host's running status
 * ring, reproduced.
 *
 * **Why a component and not an icon name.** `PluginIcon` is `string | { svg } |
 * ComponentType<PluginIconProps>`, and a rotating mark cannot be any of the
 * serialisable forms — they are static data. So the pill hands the host a
 * component and draws the ring itself.
 *
 * **The ring body is shared** (`./status-ring`'s `StatusRingMark`): the goal
 * pill and the goal panel's whale corner draw the same mark, and a second
 * hand-copied ring would drift from the host's numbers. This module keeps the
 * jobs-specific part — the colour, which comes from the theme's surface, not
 * from the `color` prop: the host passes every plugin icon `foregroundMuted`,
 * which would paint the ring grey. The plugin theme exposes no `statusDot*`, so
 * `ringColorFor` decides between the host's two running blues.
 *
 * @module dsh-paseo/client/jobs-spinner
 */
import type { PluginHostProps, PluginIconProps } from "@getpaseo/plugin/client";
import { ringColorFor } from "./jobs-popover-layout";
import { CornerRingIcon } from "./corner-ring";
import { StatusRingMark } from "./status-ring";

export { StatusRingMark } from "./status-ring";

/**
 * A running ring, in the pill's icon slot and in a job row's mark slot.
 *
 * Takes `size` from `PluginIconProps` and `theme` from `PluginHostProps` — the host
 * passes both to a component icon, and the popover body passes them from its own
 * props. `theme` is optional because the two call sites differ; a missing one falls
 * back to the light ring.
 *
 * The `color` the host passes is ignored: it is always `foregroundMuted`, which
 * would paint the ring grey. The colour comes from
 * {@link ringColorFor}`(theme.colors.surface0)`.
 */
export function JobsSpinner({ size, theme }: PluginIconProps & Partial<PluginHostProps>) {
  const color = ringColorFor(theme?.colors.surface0);
  return <StatusRingMark size={size} color={color} />;
}

/**
 * The jobs pill's live trigger icon: the terminal glyph with the running ring
 * on its corner. A job row keeps {@link JobsSpinner}; the pill no longer
 * swaps its glyph for the ring, so when the host shrinks plugin pills to their
 * icons the jobs pill stays a terminal, not one more blue ring.
 *
 * `SquareTerminal`, not the old static `ListChecks`: the pill counts background
 * shell commands, and that is the glyph the timeline gives a shell row;
 * `ListChecks` read like the host's task-list pill beside it.
 */
export function JobsPillIcon({ size, theme }: PluginIconProps & Pick<PluginHostProps, "theme">) {
  return <CornerRingIcon name="SquareTerminal" size={size} color={theme.colors.foregroundMuted} running theme={theme} />;
}
