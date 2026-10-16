/**
 * One row of text that shimmers while it is active, the way DSH's timeline does.
 *
 * Two implementations behind one API, because the platforms share no drawing
 * primitives for this:
 *
 * - **Web** reuses DSH's `TextShimmer.module.css` verbatim (`./shimmer-css`):
 *   a real copy plus a decorative copy under a `mask-image` that slides.
 * - **Native** has no mask and no gradient, so `./sweep-native` rebuilds the
 *   same geometry from clipped slices. It is the same effect — the copy stays
 *   put, the mask sweeps — with a stepped edge instead of a smooth one.
 *
 * `children` is a function because each implementation paints the decorative
 * copy differently: `null` means "the row's own colours", a colour string means
 * "this is the highlight copy".
 *
 * @module dsh-paseo/client/text-shimmer
 */
import { type ReactNode, useEffect } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import {
  SHIMMER_CONTENT,
  SHIMMER_DECORATION,
  SHIMMER_HIGHLIGHT,
  SHIMMER_ROOT,
  SHIMMER_SWEEP,
  SHIMMER_SUPPORTED,
  ensureShimmerStyles,
  isLightColor,
  setShimmerColor,
} from "./shimmer-css";
import { SweepNative } from "./sweep-native";

interface TextShimmerProps {
  /** Builds the row's text runs; see the module note about the colour. */
  children: (color: string | null) => ReactNode;
  /** Whether the sweep runs. Inactive rows render the plain text. */
  active: boolean;
  /** The flex row holding the runs, so the copy lines up run for run. */
  contentStyle?: StyleProp<ViewStyle>;
  /** The row's brighter foreground — the tint of the sweeping highlight. */
  highlightColor: string;
  /** A surface color, only used to tell a light theme from a dark one. */
  surfaceColor: string;
}

/**
 * `localStorage.setItem("dsh-sweep", "native")` renders the native slice sweep
 * on the web too.
 *
 * The two implementations share no primitives, so the only way to inspect the
 * native one without a device is to ask for it. A storage key rather than a
 * query parameter because Expo Router rewrites the URL and drops the query.
 * Purely a debugging affordance.
 */
function forceNativeSweep(): boolean {
  try {
    const storage = (globalThis as { localStorage?: { getItem(key: string): string | null } })
      .localStorage;
    return storage?.getItem("dsh-sweep") === "native";
  } catch {
    return false;
  }
}

export function TextShimmer({
  children,
  active,
  contentStyle,
  highlightColor,
  surfaceColor,
}: TextShimmerProps) {
  useEffect(() => {
    if (!SHIMMER_SUPPORTED) return;
    ensureShimmerStyles();
    // DSH mixes its highlight at 45% on dark and 30% on light.
    setShimmerColor(highlightColor, isLightColor(surfaceColor) ? 30 : 45);
  }, [highlightColor, surfaceColor]);

  if (!SHIMMER_SUPPORTED || forceNativeSweep()) {
    return (
      <SweepNative active={active} contentStyle={contentStyle} highlightColor={highlightColor}>
        {children}
      </SweepNative>
    );
  }

  return (
    <View testID={SHIMMER_ROOT}>
      <View style={contentStyle} testID={SHIMMER_CONTENT}>
        {children(null)}
      </View>
      {active ? (
        // The decorative copy is painted by CSS, so it must not be announced.
        <View testID={SHIMMER_DECORATION} aria-hidden>
          <View testID={SHIMMER_SWEEP}>
            <View style={contentStyle} testID={SHIMMER_HIGHLIGHT}>
              {children(highlightColor)}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}
