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
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import {
  SWEEP_ACTIVE_BASE_OPACITY,
  SWEEP_BEAMS,
  SWEEP_DELAY_MS,
  SWEEP_PEAK_OPACITY_DARK,
  SWEEP_PERIOD_MS,
  concentricBeamLayers,
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

interface ConveyorLayer {
  readonly key: string;
  readonly leftFraction: number;
  readonly widthFraction: number;
  readonly alpha: number;
}

function buildConveyorLayers(peakOpacity: number): ConveyorLayer[] {
  const ringLayers = concentricBeamLayers(peakOpacity);
  const out: ConveyorLayer[] = [];
  const periodFraction = 1 / SWEEP_BEAMS;
  // 4 repeating periods (beam indices -1, 0, 1, 2 across [-1/3, 1]) so shifting
  // right by exactly +1/3 of row width wraps pixel-for-pixel seamlessly.
  for (let beam = -1; beam < SWEEP_BEAMS; beam += 1) {
    for (let ringIdx = 0; ringIdx < ringLayers.length; ringIdx += 1) {
      const ring = ringLayers[ringIdx]!;
      if (ring.alpha <= 0.005) continue;
      out.push({
        key: `${beam}:${ringIdx}`,
        leftFraction: beam * periodFraction + ring.leftInPeriod * periodFraction,
        widthFraction: ring.widthInPeriod * periodFraction,
        alpha: ring.alpha,
      });
    }
  }
  return out;
}

export function SweepNative({
  children,
  active,
  contentStyle,
  highlightColor,
  peakOpacity = SWEEP_PEAK_OPACITY_DARK,
}: SweepNativeProps) {
  const [box, setBox] = useState<Box | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const conveyorLayers = useMemo(() => buildConveyorLayers(peakOpacity), [peakOpacity]);

  useEffect(() => {
    if (!active) return;
    // Wrap in Animated.sequence with an explicit 0ms reset to 0: on iOS RN
    // (`useNativeDriver: true`), looping a bare `Animated.timing` can stop
    // after the first iteration instead of wrapping cleanly back to 0.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: SWEEP_PERIOD_MS,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
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
          {conveyorLayers.map((layer) => {
            const layerLeft = layer.leftFraction * width;
            return (
              <Animated.View
                key={layer.key}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: layerLeft,
                  width: layer.widthFraction * width,
                  overflow: "hidden",
                  transform: [{ translateX: sweepX }],
                }}
              >
                <Animated.View
                  style={{
                    position: "absolute",
                    top: 0,
                    left: -layerLeft,
                    width,
                    height,
                    opacity: layer.alpha,
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
