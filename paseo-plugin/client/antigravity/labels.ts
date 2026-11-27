import type { AccountSummary } from "../../shared/antigravity/contracts";
import { safeLocale } from "./format";

/** The server's default name for the system sign-in; shown translated until the user renames it. */
export const DEFAULT_SYSTEM_LABEL = "System sign-in";

export function displayLabel(
  label: string,
  translate: (key: "systemName") => string,
  kind?: AccountSummary["kind"],
): string {
  if (kind === "profile") return label;
  return label === DEFAULT_SYSTEM_LABEL ? translate("systemName") : label;
}

/** Formats a list of names using locale-appropriate punctuation (e.g. `, ` in English, `、` in Chinese). */
export function joinList(items: readonly string[], locale: string): string {
  if (items.length <= 1) return items[0] ?? "";
  try {
    const ListFormat =
      typeof Intl !== "undefined"
        ? (
            Intl as {
              ListFormat?: new (
                locale: string,
                options: { style: string; type: string },
              ) => { format(list: readonly string[]): string };
            }
          ).ListFormat
        : undefined;
    if (typeof ListFormat === "function") {
      return new ListFormat(safeLocale(locale), { style: "narrow", type: "conjunction" }).format(items);
    }
  } catch {
    // Fallback below.
  }
  return items.join(safeLocale(locale).toLowerCase().startsWith("zh") ? "、" : ", ");
}
