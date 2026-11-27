/**
 * The Antigravity mark. The arch path is the one Paseo ships for its built-in provider; the
 * colors follow the Antigravity app icon: a blue body with a green, yellow, orange and red crown.
 */
const ARCH =
  "M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z";

/**
 * Generates an inline SVG with distinct `<defs>` IDs per surface so a hidden (`display: none`)
 * sidebar icon never shadows visible `<linearGradient>` / `<mask>` references on Web/Electron.
 */
export function antigravityLogoSvg(scope = "main"): string {
  const s = scope ? `-${scope}` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8.8 10.5 94 94">
<defs>
<linearGradient id="agy-body${s}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#3A78EF"/>
<stop offset="1" stop-color="#5E9DF9"/>
</linearGradient>
<linearGradient id="agy-crown${s}" x1="0.1" y1="0" x2="0.9" y2="0">
<stop offset="0" stop-color="#34A853"/>
<stop offset="0.38" stop-color="#8BC34A"/>
<stop offset="0.52" stop-color="#FBBC04"/>
<stop offset="0.72" stop-color="#F57C1F"/>
<stop offset="1" stop-color="#EA4335"/>
</linearGradient>
<linearGradient id="agy-fade${s}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0.18" stop-color="#ffffff" stop-opacity="1"/>
<stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
</linearGradient>
<mask id="agy-mask${s}" maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120">
<rect x="0" y="0" width="120" height="120" fill="url(#agy-fade${s})"/>
</mask>
</defs>
<path d="${ARCH}" fill="url(#agy-body${s})"/>
<path d="${ARCH}" fill="url(#agy-crown${s})" mask="url(#agy-mask${s})"/>
</svg>`;
}

export const antigravityLogo = antigravityLogoSvg("main");

/** Single-color mark that follows the surface's icon color. */
export const antigravityMark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8.8 10.5 94 94" fill="currentColor"><path d="${ARCH}"/></svg>`;
