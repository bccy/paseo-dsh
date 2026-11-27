import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Platform } from "react-native";

export type Colors = PluginSurfaceProps["theme"]["colors"];

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;
export const radius = { sm: 6, md: 8, lg: 12, xl: 16, pill: 999 } as const;
export const font = {
  title: { fontSize: 22, lineHeight: 28, fontWeight: "600" as const },
  heading: { fontSize: 15, lineHeight: 20, fontWeight: "600" as const },
  body: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  overline: { fontSize: 11, lineHeight: 14, fontWeight: "600" as const, letterSpacing: 0.4 },
};

export const mono = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

/** Numbers that line up in columns. */
export const tabular = { fontVariant: ["tabular-nums" as const] };

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
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), alpha];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)?.[1];
  if (rgb) {
    const parts = rgb.split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return [parts[0]!, parts[1]!, parts[2]!, Number.isFinite(parts[3]) ? parts[3]! : 1];
    }
  }
  return null;
}

/** A theme color at the given opacity, for tinted backgrounds that work in light and dark themes. */
export function tint(color: string, alpha: number): string {
  const parsed = channels(color);
  if (!parsed) return color;
  const [red, green, blue, base] = parsed;
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, base * alpha))})`;
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export function toneColor(colors: Colors, tone: Tone): string {
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

/** Color for a remaining-quota fraction: plenty, getting low, nearly out. Meters carry severity in the fill. */
export function remainingTone(fraction: number | null): Tone {
  if (fraction === null) return "neutral";
  if (fraction >= 0.5) return "accent";
  if (fraction >= 0.2) return "warning";
  return "danger";
}
