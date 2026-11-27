/**
 * DSH's row shimmer on React Native.
 *
 * DSH does this in CSS with a masked copy of the text: `.sweep` translates one
 * way while `.highlight` counter-translates, so the glyphs never move and only
 * the mask does. React Native has neither `mask-image` nor a gradient, so the
 * mask is rebuilt from `SWEEP_BANDS` equal slices with a constant alpha each,
 * sampled from DSH's own profile (`sweep-geometry`).
 *
 * The counter-translation is what keeps the copy legible: every band is a
 * clipping window that slides, and the copy inside it slides back by exactly the
 * same amount, so the text stays put while the window passes over it. One
 * `Animated.Value` drives both, on the native driver, so nothing re-renders
 * while the sweep runs.
 *
 * @module dsh-paseo/client/sweep-native
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import {
  SWEEP_ACTIVE_BASE_OPACITY,
  SWEEP_BEAMS,
  SWEEP_DELAY_MS,
  SWEEP_PEAK_OPACITY_DARK,
  SWEEP_PERIOD_MS,
  SWEEP_SLICES_PER_BEAM,
  beamPeriodProfile,
} from "./sweep-geometry";

interface SweepNativeProps {
  /**
   * Builds the row's text runs. `null` keeps the row's own colours for the real
   * copy; a colour string paints the decorative copy that the mask reveals.
   */
  children: (color: string | null) => ReactNode;
  active: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  highlightColor: string;
  /** Peak highlight opacity in `[0, 1]` so the native sweep stays subtle. */
  peakOpacity?: number;
}

interface Box {
  width: number;
  height: number;
}

interface ConveyorSlice {
  readonly key: string;
  readonly leftFraction: number;
  readonly widthFraction: number;
  readonly alpha: number;
}

// Precompute 4 repeating periods (beam indices -1, 0, 1, 2 across [-1/3, 1]) so
// shifting right by exactly +1/3 of row width wraps pixel-for-pixel seamlessly.
const CONVEYOR_SLICES: readonly ConveyorSlice[] = (() => {
  const out: ConveyorSlice[] = [];
  const periodFraction = 1 / SWEEP_BEAMS;
  const subWidthFraction = periodFraction / SWEEP_SLICES_PER_BEAM;
  for (let beam = -1; beam < SWEEP_BEAMS; beam += 1) {
    for (let sub = 0; sub < SWEEP_SLICES_PER_BEAM; sub += 1) {
      const alpha = beamPeriodProfile((sub + 0.5) / SWEEP_SLICES_PER_BEAM);
      if (alpha <= 0.015) continue;
      out.push({
        key: `${beam}:${sub}`,
        leftFraction: beam * periodFraction + sub * subWidthFraction,
        widthFraction: subWidthFraction,
        alpha,
      });
    }
  }
  return out;
})();

export function SweepNative({
  children,
  active,
  contentStyle,
  highlightColor,
  peakOpacity = SWEEP_PEAK_OPACITY_DARK,
}: SweepNativeProps) {
  const [box, setBox] = useState<Box | null>(null);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) return;
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: SWEEP_PERIOD_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    const start = setTimeout(() => loop.start(), SWEEP_DELAY_MS);
    return () => {
      clearTimeout(start);
      loop.stop();
      progress.setValue(0);
    };
  }, [active, progress]);

  const width = box?.width ?? 0;
  const height = box?.height ?? 0;
  const periodPx = width / SWEEP_BEAMS;
  const sweepX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, periodPx] });
  const counterX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, -periodPx] });

  return (
    <View
      style={contentStyle}
      onLayout={(event) => {
        const { width: w, height: h } = event.nativeEvent.layout;
        setBox((previous) =>
          previous !== null && previous.width === w && previous.height === h
            ? previous
            : { width: w, height: h },
        );
      }}
    >
      <View style={[contentStyle, active ? { opacity: SWEEP_ACTIVE_BASE_OPACITY } : null]}>
        {children(null)}
      </View>
      {active && box !== null && width > 0 ? (
        // `overflow: "hidden"` clips the entering beam in [-periodPx, 0] and exiting beam past width.
        <View style={[StyleSheet.absoluteFill, { overflow: "hidden" }]} pointerEvents="none" aria-hidden>
          {CONVEYOR_SLICES.map((slice) => {
            const sliceLeft = slice.leftFraction * width;
            return (
              <Animated.View
                key={slice.key}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: sliceLeft,
                  width: slice.widthFraction * width,
                  overflow: "hidden",
                  transform: [{ translateX: sweepX }],
                }}
              >
                <Animated.View
                  style={{
                    position: "absolute",
                    top: 0,
                    left: -sliceLeft,
                    width,
                    height,
                    opacity: slice.alpha * peakOpacity,
                    transform: [{ translateX: counterX }],
                  }}
                >
                  <View style={[contentStyle, { width, height }]}>
                    {children(highlightColor)}
                  </View>
                </Animated.View>
              </Animated.View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
