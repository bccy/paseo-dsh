/**
 * DSH's row shimmer, reused as-is.
 *
 * The effect is not a gradient background: it is one masked window sliding
 * across a second copy of the text. `.sweep` and `.highlight` translate in
 * opposite directions, so the glyphs of the copy stay aligned with the real
 * text while the shared `mask-image` moves over them — the highlight is what
 * moves, not the text.
 *
 * Everything between the "verbatim" markers is copied from DSH's
 * `TextShimmer.module.css`, with two mechanical changes: classes become
 * `[data-testid]` selectors (React Native has no `className`), and `!important`
 * is added where React Native also sets the property inline. DSH paints the
 * decorative copy through `::after { content: attr(data-shimmer-text) }` to keep
 * it out of the accessibility tree; we render the copy normally and mark it
 * `aria-hidden`, which is the same thing in a normal React tree.
 *
 * @module dsh-paseo/client/shimmer-css
 */
import { Platform } from "react-native";

/** Marker values React Native renders as `data-testid`, which the CSS hooks. */
export const SHIMMER_ROOT = "dsh-shimmer-root";
export const SHIMMER_CONTENT = "dsh-shimmer-content";
export const SHIMMER_DECORATION = "dsh-shimmer-decoration";
export const SHIMMER_SWEEP = "dsh-shimmer-sweep";
export const SHIMMER_HIGHLIGHT = "dsh-shimmer-highlight";

const STYLE_ID = "dsh-paseo-text-shimmer";
const COLOR_VAR = "--dsh-paseo-shimmer";

/** Just enough DOM to inject a stylesheet, without pulling in the DOM lib. */
interface WebStyleElement {
  id: string;
  textContent: string;
}
interface WebDocument {
  getElementById(id: string): unknown;
  createElement(tag: string): WebStyleElement;
  head: { appendChild(node: WebStyleElement): void };
  documentElement: { style: { setProperty(name: string, value: string): void } };
}

const r = (name: string) => `[data-testid="${name}"]`;

const SHIMMER_CSS = `
${r(SHIMMER_ROOT)} {
  position: relative !important;
  display: inline-grid !important;
  width: max-content !important;
  max-width: 100% !important;
  min-width: 0 !important;
  vertical-align: top !important;
  color: inherit !important;
}

${r(SHIMMER_CONTENT)} {
  display: flex !important;
  align-items: center !important;
  min-width: 0 !important;
  color: inherit !important;
}

${r(SHIMMER_DECORATION)} {
  position: absolute !important;
  inset: 0 !important;
  /* The moving mask must not enlarge any ancestor's scrollable area. */
  overflow: clip !important;
  pointer-events: none !important;
  user-select: none !important;
}

${r(SHIMMER_SWEEP)} {
  position: absolute !important;
  inset: 0 !important;
  overflow: hidden !important;
  color: var(${COLOR_VAR}) !important;
  mask-image: linear-gradient(105deg, transparent 0%, black 40% 60%, transparent 100%) !important;
  -webkit-mask-image: linear-gradient(105deg, transparent 0%, black 40% 60%, transparent 100%) !important;
  transform: translateX(-100%);
  animation-name: dsh-row-shimmer-sweep;
}

/* Semantic base colors stay on the real content; the overlay supplies one tint. */
${r(SHIMMER_SWEEP)} * {
  color: inherit !important;
}

/* Opposite transforms keep every glyph aligned while their shared mask moves. */
${r(SHIMMER_HIGHLIGHT)} {
  width: 100% !important;
  height: 100% !important;
  transform: translateX(100%);
  animation-name: dsh-row-shimmer-highlight;
}

${r(SHIMMER_SWEEP)},
${r(SHIMMER_HIGHLIGHT)} {
  animation-duration: 1.5s;
  animation-delay: 0.3s;
  animation-timing-function: steps(48, end);
  animation-iteration-count: infinite;
}

@keyframes dsh-row-shimmer-sweep {
  0% { transform: translateX(-100%); }
  66.6667%, 100% { transform: translateX(100%); }
}

@keyframes dsh-row-shimmer-highlight {
  0% { transform: translateX(100%); }
  66.6667%, 100% { transform: translateX(-100%); }
}

@media (prefers-reduced-motion: reduce) {
  ${r(SHIMMER_DECORATION)} { display: none !important; }
  ${r(SHIMMER_SWEEP)},
  ${r(SHIMMER_HIGHLIGHT)} { animation: none !important; }
}
`;

/** True when the platform can run CSS at all. */
export const SHIMMER_SUPPORTED = Platform.OS === "web";

function webDocument(): WebDocument | null {
  return (globalThis as { document?: WebDocument }).document ?? null;
}

/** Inject the stylesheet once. No-op off the web. */
export function ensureShimmerStyles(): void {
  if (!SHIMMER_SUPPORTED) return;
  const doc = webDocument();
  if (doc === null || doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = SHIMMER_CSS;
  doc.head.appendChild(style);
}

/**
 * The tint that sweeps across the text.
 *
 * DSH derives it from its own palette (`color-mix(in srgb, neutral-00 45%,
 * transparent)` on dark, 30% on light). Paseo hands a plugin only resolved
 * colors, so the equivalent is a translucent version of the row's brighter
 * foreground — the same "one brighter pass over muted text". If the engine has
 * no `color-mix`, the opaque color still sweeps: the effect degrades to a
 * visible highlight rather than to nothing.
 */
export function setShimmerColor(color: string, percent: number): void {
  if (!SHIMMER_SUPPORTED) return;
  const doc = webDocument();
  if (doc === null) return;
  const mixed = `color-mix(in srgb, ${color} ${percent}%, transparent)`;
  const css = (globalThis as { CSS?: { supports?: (property: string, value: string) => boolean } })
    .CSS;
  const supported = typeof css?.supports === "function" && css.supports("color", mixed);
  doc.documentElement.style.setProperty(COLOR_VAR, supported ? mixed : color);
}

/** Whether a CSS color reads as light, so the sweep should darken instead. */
export function isLightColor(color: string): boolean {
  const luminance = (r: number, g: number, b: number) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex !== null) {
    const digits = hex[1];
    const full =
      digits.length === 3
        ? digits
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : digits;
    const value = Number.parseInt(full, 16);
    return luminance((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff) > 0.5;
  }
  const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(color);
  if (rgb !== null) return luminance(Number(rgb[1]), Number(rgb[2]), Number(rgb[3])) > 0.5;
  return false;
}
