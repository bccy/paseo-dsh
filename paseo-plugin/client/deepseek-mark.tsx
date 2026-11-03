/**
 * The DeepSeek mark, drawn inside the goal popover's first line.
 *
 * The popover is an ordinary React Native tree rendered by the host, so the only
 * way to draw the plugin's own vector is the host UI kit's `Icon` with the
 * `{svg}` form (`PluginIcon = string | {svg} | ComponentType`; the host renders
 * an inline SVG through `SvgXml` and tints it with `currentColor`). The SVG text
 * lives in `./deepseek-mark-svg` so the offline harness can assert the document
 * without importing React.
 *
 * The mark is **brand blue**, not theme-following: the source icon fills its path
 * with `#4d6bfe` and the host only recolours `currentColor` paths, so the mark
 * keeps the DeepSeek identity in both light and dark themes. At 16px it is
 * legible on both surfaces; a foreground-coloured mark would lose the brand for
 * no contrast gain.
 *
 * @module dsh-paseo/client/deepseek-mark
 */
import { Icon } from "@getpaseo/plugin/client/ui";
import { DEEPSEEK_MARK_SVG } from "./deepseek-mark-svg";

/**
 * The DeepSeek whale mark at one square size.
 *
 * @param size - edge length in points; the goal popover passes
 *   16 so the mark matches the host's 16px icon slot (`task-list-row.tsx:15-25`).
 */
export function DeepSeekMark({ size }: { size: number }) {
  return <Icon icon={{ svg: DEEPSEEK_MARK_SVG }} size={size} />;
}
