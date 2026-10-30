/**
 * The jobs pill's icon, and a job row's live mark: the host's running status
 * ring, reproduced.
 *
 * **Why a component and not an icon name.** `PluginIcon` is `string | { svg } |
 * ComponentType<PluginIconProps>`, and a rotating mark cannot be any of the
 * serialisable forms — they are static data. So the pill hands the host a
 * component and draws the ring itself.
 *
 * **The geometry is the host's status ring**, three layers as
 * `components/status-ring/frame.tsx` builds them: a track at 0.3 opacity, a
 * rotating quarter at 0.9, and the solid centre dot. Every number is the host's
 * (`STATUS_RING_SIZE` 12, stroke 1.5, dot 6, period 900 ms), and the ring is not
 * scaled by `size` — a fixed 12px ring in the 14px box *is* the host's frame.
 *
 * **The colour comes from `ringColorFor`**, not from the `color` prop: the host
 * passes every plugin icon `foregroundMuted`, which would paint the ring grey.
 * The plugin theme exposes no `statusDot*`, so the surface decides between the
 * host's two running blues — see `jobs-popover-layout`.
 *
 * **Why the animation is split by platform in one file.** `Animated.loop` can run
 * one segment and stop on React Native Web (`docs/FIELD-NOTES.md` §29b), while the
 * Web fix does not reach a native view. So Web uses the Web Animations API and
 * native uses `Animated.loop`. The branch is a runtime `Platform.OS` check rather
 * than a `.web.tsx` sibling because the host compiles this bundle at
 * `platform: "neutral"`, where esbuild never resolves `.web.*` — a platform file
 * would ship the native implementation to the web app and report nothing.
 *
 * @module dsh-paseo/client/jobs-spinner
 */
import type { PluginHostProps, PluginIconProps } from "@getpaseo/plugin/client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Animated, Easing, Platform, View } from "react-native";
import { ringColorFor } from "./jobs-popover-layout";

/** `STATUS_RING_SIZE`: the ring's outer diameter. Fixed, see the module note. */
const RING_SIZE = 12;

/** `STATUS_RING_STROKE`. */
const STROKE = 1.5;

/** `STATUS_INDICATOR_FILLED_DOT_SIZE`. */
const CENTER_DOT_SIZE = 6;

/** `STATUS_RING_PERIOD_MS`: every ring in the host turns on this same period. */
const PERIOD_MS = 900;

/** `STATUS_RING_TRACK_OPACITY`: low enough that the quarter is the moving part. */
const TRACK_OPACITY = 0.3;

/** `STATUS_RING_HEAD_OPACITY`: held off full so it is not a second ring. */
const HEAD_OPACITY = 0.9;

/** Just enough of a DOM element to run a Web Animation, without the DOM lib. */
interface WebAnimatedElement {
  animate(
    keyframes: { transform: readonly string[] },
    timing: { duration: number; easing: string; iterations: number },
  ): { startTime: number | null; cancel(): void };
}

/**
 * Whether a ref value can animate itself.
 *
 * `Platform.OS` is not the test on its own: on native the ref is a host instance
 * with no `animate` method, and a ref can be null. Asking the object keeps the two
 * paths from being chosen by a flag that could disagree with the ref.
 */
function isWebAnimatedElement(value: unknown): value is WebAnimatedElement {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "animate") === "function"
  );
}

/** The host's `STATUS_RING_KEYFRAMES` / `STATUS_RING_TIMING`, verbatim. */
const WEB_KEYFRAMES = { transform: ["rotate(0deg)", "rotate(360deg)"] } as const;
const WEB_TIMING = {
  duration: PERIOD_MS,
  easing: "linear",
  iterations: Number.POSITIVE_INFINITY,
} as const;

/** The arc's geometry: a rounded box whose one coloured edge is a 90° arc. */
const ARC_STYLE = {
  position: "absolute",
  width: RING_SIZE,
  height: RING_SIZE,
  borderRadius: RING_SIZE / 2,
  borderWidth: STROKE,
  borderColor: "transparent",
  opacity: HEAD_OPACITY,
} as const;

/**
 * The rotating quarter.
 *
 * Web: the Web Animations API with `startTime = 0`, so every ring shares one
 * timeline and one mounted mid-turn is already in phase. `useLayoutEffect` because
 * the ref must be animated before paint, or the arc shows at 0° for a frame.
 *
 * Native: `Animated.loop` on the native driver, so the rotation never re-renders.
 * Both paths stop on unmount.
 */
function RotatingArc({ color }: { color: string }) {
  const webRef = useRef<unknown>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const isWeb = Platform.OS === "web";

  useLayoutEffect(() => {
    if (!isWeb) return;
    const element = webRef.current;
    if (!isWebAnimatedElement(element)) return;
    const animation = element.animate(WEB_KEYFRAMES, WEB_TIMING);
    // One shared timeline: a ring that mounts mid-flight lands in step with the
    // rings already turning.
    animation.startTime = 0;
    return () => {
      animation.cancel();
    };
  }, [isWeb]);

  useEffect(() => {
    if (isWeb) return;
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: PERIOD_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    // Same cleanup as `sweep-native.tsx`: stop the loop so the animation object does not
    // outlive the component, and reset so a remount starts from 0°.
    return () => {
      loop.stop();
      progress.setValue(0);
    };
  }, [isWeb, progress]);

  if (isWeb) {
    return (
      <View
        ref={(instance) => {
          webRef.current = instance;
        }}
        style={{ ...ARC_STYLE, borderTopColor: color }}
      />
    );
  }

  const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View
      style={[{ ...ARC_STYLE, borderTopColor: color }, { transform: [{ rotate }] }]}
    />
  );
}

/**
 * A running ring, in the pill's icon slot and in a job row's mark slot.
 *
 * Takes `size` from `PluginIconProps` and `theme` from `PluginHostProps` — the host
 * passes both to a component icon, and the popover body passes them from its own
 * props. `theme` is optional because the two call sites differ; a missing one falls
 * back to the light ring.
 *
 * The `color` the host passes is ignored: it is always `foregroundMuted`, which
 * would paint the ring grey. The colour comes from
 * {@link ringColorFor}`(theme.colors.surface0)`.
 */
export function JobsSpinner({ size, theme }: PluginIconProps & Partial<PluginHostProps>) {
  const color = ringColorFor(theme?.colors.surface0);
  // The ring is a fixed 12px mark; `size` decides the box around it. The larger wins
  // so the ring can never be clipped, and at the composer's 14 this reproduces the
  // host's 14px frame exactly.
  const box = Math.max(size, RING_SIZE);
  return (
    <View style={{ width: box, height: box, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          position: "absolute",
          width: RING_SIZE,
          height: RING_SIZE,
          borderRadius: RING_SIZE / 2,
          borderWidth: STROKE,
          borderColor: color,
          opacity: TRACK_OPACITY,
        }}
      />
      <RotatingArc color={color} />
      {/*
        The solid centre, the host's third layer (`status-ring/frame.tsx`'s
        `centerDot`). Without it the mark reads as a hole punched in the pill rather
        than as the host's running indicator, which is the whole point of copying it.
      */}
      <View
        style={{
          position: "absolute",
          width: CENTER_DOT_SIZE,
          height: CENTER_DOT_SIZE,
          borderRadius: CENTER_DOT_SIZE / 2,
          backgroundColor: color,
        }}
      />
    </View>
  );
}
