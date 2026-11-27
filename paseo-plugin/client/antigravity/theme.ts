import type { Tone } from "../console-theme";

export {
  font,
  mono,
  radius,
  space,
  tabular,
  tint,
  toneColor,
  type Colors,
  type Tone,
  type ToneColors,
} from "../console-theme";

/** Color for a remaining-quota fraction: plenty, getting low, nearly out. Meters carry severity in the fill. */
export function remainingTone(fraction: number | null): Tone {
  if (fraction === null) return "neutral";
  if (fraction >= 0.5) return "accent";
  if (fraction >= 0.2) return "warning";
  return "danger";
}
