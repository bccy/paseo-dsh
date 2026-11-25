/**
 * Shared design tokens and color helpers for the DSH console and upgraded
 * timeline cards.
 *
 * Pure React Native + Paseo theme contract (`Colors` matches
 * `PluginTheme["colors"]` on Paseo >= 0.16.0). Zero browser-only APIs and zero
 * runtime dependencies beyond React Native.
 *
 * @module dsh-paseo/client/console-theme
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Platform, type TextStyle } from "react-native";

/** Theme color palette supplied by Paseo (`PluginTheme["colors"]`). */
export type Colors = PluginSurfaceProps["theme"]["colors"];

/** Semantic tone mapped onto Paseo's status/accent tokens. */
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/** Subset of `Colors` required to resolve semantic tones (compatible with `TokenColors`). */
export type ToneColors = Pick<
  Colors,
  "accent" | "statusSuccess" | "statusWarning" | "statusDanger" | "foregroundMuted"
>;

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  pill: 999,
} as const;

export const font = {
  title: { fontSize: 22, lineHeight: 28, fontWeight: "600" as const },
  heading: { fontSize: 15, lineHeight: 20, fontWeight: "600" as const },
  body: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  overline: { fontSize: 11, lineHeight: 14, fontWeight: "600" as const, letterSpacing: 0.4 },
};

/**
 * Platform-specific monospace stack.
 *
 * Resolved through `Platform.OS` rather than `Platform.select` so importing this
 * module at load time stays safe in headless harness stubs, which only expose
 * `Platform.OS` (same convention as `shimmer-css.ts#SHIMMER_SUPPORTED`).
 */
export const mono: string =
  Platform.OS === "ios"
    ? "Menlo"
    : Platform.OS === "android"
      ? "monospace"
      : "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * Tabular numerals style for tables, counters, and aligned metrics.
 *
 * Kept as a mutable array (`("tabular-nums")[]`) because React Native's
 * `TextStyle["fontVariant"]` is mutable and rejects `readonly` tuples.
 */
export const tabular: { fontVariant: ("tabular-nums")[] } = {
  fontVariant: ["tabular-nums"],
} satisfies Pick<TextStyle, "fontVariant">;

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const trimmed = raw.trim();
  if (trimmed.endsWith("%")) {
    const pct = Number(trimmed.slice(0, -1));
    return Number.isFinite(pct) ? pct / 100 : 1;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : 1;
}

function channels(color: string): [number, number, number, number] | null {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)?.[1];
  if (hex) {
    const full =
      hex.length === 3 || hex.length === 4
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;
    if (full.length !== 6 && full.length !== 8) return null;
    const alpha = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      alpha,
    ];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)?.[1];
  if (rgb) {
    const tokens = rgb.split(/[\s,/]+/).filter(Boolean);
    if (tokens.length >= 3) {
      const r = Number(tokens[0]);
      const g = Number(tokens[1]);
      const b = Number(tokens[2]);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return [
          Math.max(0, Math.min(255, Math.round(r))),
          Math.max(0, Math.min(255, Math.round(g))),
          Math.max(0, Math.min(255, Math.round(b))),
          Math.max(0, Math.min(1, parseAlpha(tokens[3]))),
        ];
      }
    }
  }
  return null;
}

/**
 * Apply an opacity multiplier to a hex/rgb/rgba theme color so translucent
 * fills stay balanced in both light and dark themes.
 */
export function tint(color: string, alpha: number): string {
  const parsed = channels(color);
  if (!parsed) return color;
  const safeAlpha = Number.isFinite(alpha) ? alpha : 1;
  const [red, green, blue, base] = parsed;
  const combined = Math.max(0, Math.min(1, base * safeAlpha));
  const rounded = Math.round(combined * 10_000) / 10_000;
  return `rgba(${red}, ${green}, ${blue}, ${rounded})`;
}

/** Resolve a semantic tone to its theme color. */
export function toneColor(colors: ToneColors, tone: Tone): string {
  switch (tone) {
    case "accent":
      return colors.accent;
    case "success":
      return colors.statusSuccess;
    case "warning":
      return colors.statusWarning;
    case "danger":
      return colors.statusDanger;
    default:
      return colors.foregroundMuted;
  }
}

/** Severity tone for a used-capacity fraction (`<0.6` accent, `<0.85` warning, `>=0.85` danger). */
export function usedTone(fraction: number | null | undefined): Tone {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "neutral";
  if (fraction < 0.6) return "accent";
  if (fraction < 0.85) return "warning";
  return "danger";
}
