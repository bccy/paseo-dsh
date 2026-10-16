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
  SWEEP_BANDS,
  SWEEP_CYCLE_MS,
  SWEEP_DELAY_MS,
  SWEEP_TRAVEL_FRACTION,
  bandAlpha,
  bandLeft,
  bandWidth,
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
}

interface Box {
  width: number;
  height: number;
}

export function SweepNative({
  children,
  active,
  contentStyle,
  highlightColor,
}: SweepNativeProps) {
  const [box, setBox] = useState<Box | null>(null);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: SWEEP_CYCLE_MS * SWEEP_TRAVEL_FRACTION,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.delay(SWEEP_CYCLE_MS * (1 - SWEEP_TRAVEL_FRACTION)),
      ]),
    );
    // DSH's `animation-delay: 0.3s`, which also keeps every row in step.
    const start = setTimeout(() => loop.start(), SWEEP_DELAY_MS);
    return () => {
      clearTimeout(start);
      loop.stop();
      progress.setValue(0);
    };
  }, [active, progress]);

  const width = box?.width ?? 0;
  const height = box?.height ?? 0;
  const sweepX = progress.interpolate({ inputRange: [0, 1], outputRange: [-width, width] });
  const counterX = progress.interpolate({ inputRange: [0, 1], outputRange: [width, -width] });
  const bands = Array.from({ length: SWEEP_BANDS }, (_, index) => index);

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
      {children(null)}
      {active && box !== null && width > 0 ? (
        // `pointer-events: none` in DSH's stylesheet: the row stays tappable.
        <View style={StyleSheet.absoluteFill} pointerEvents="none" aria-hidden>
          {bands.map((index) => (
            <Animated.View
              key={index}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: bandLeft(index) * width,
                width: bandWidth() * width,
                overflow: "hidden",
                transform: [{ translateX: sweepX }],
              }}
            >
              <Animated.View
                style={{
                  position: "absolute",
                  top: 0,
                  left: -bandLeft(index) * width,
                  width,
                  height,
                  opacity: bandAlpha(index),
                  transform: [{ translateX: counterX }],
                }}
              >
                <View style={[contentStyle, { width, height }]}>
                  {children(highlightColor)}
                </View>
              </Animated.View>
            </Animated.View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
