/**
 * The host's running status ring, as a shared plugin component.
 *
 * Extracted **verbatim** from `jobs-spinner.tsx` (the jobs pill's live mark) so
 * the goal pill and the goal panel draw the same ring instead of a second one:
 * every geometry and animation number is the host's
 * (`components/status-ring/frame.tsx`: 12px outer diameter, 1.5 stroke, 6px
 * centre dot, 0.3 track opacity, 0.9 head opacity, 900 ms linear period), and
 * the animation split is the jobs one — Web Animations API with
 * `startTime = 0` on web (every ring shares one timeline), `Animated.loop` on
 * the native driver otherwise. The extraction changes no number and no branch.
 *
 * The ring is a fixed 12px mark: `size` decides the box around it, never the
 * ring's own size. That is the host's frame — a 14px box around a 12px ring —
 * and it is why a 14px pill icon slot can hold it without clipping.
 *
 * `backdrop` is the one addition: the host's `StatusIcon` overlays a ring on the
 * corner of a provider icon and punches a 1px hole in the underlying fill
 * (`status-icon.tsx:59-70`). A caller that overlays the ring on something draws
 * that hole by passing the row's background colour; the pill's icon slot leaves
 * it undefined, which is exactly the old jobs rendering.
 *
 * @module dsh-paseo/client/status-ring
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { Animated, Easing, Platform, View } from "react-native";

/** `STATUS_RING_SIZE`: the ring's outer diameter. Fixed, see the module note. */
export const STATUS_RING_SIZE = 12;

/** `STATUS_RING_STROKE`. */
export const STATUS_RING_STROKE = 1.5;

/** `STATUS_INDICATOR_FILLED_DOT_SIZE`. */
export const STATUS_RING_CENTER_DOT_SIZE = 6;

/** `STATUS_RING_PERIOD_MS`: every ring in the host turns on this same period. */
export const STATUS_RING_PERIOD_MS = 900;

/** `STATUS_RING_TRACK_OPACITY`: low enough that the quarter is the moving part. */
export const STATUS_RING_TRACK_OPACITY = 0.3;

/** `STATUS_RING_HEAD_OPACITY`: held off full so it is not a second ring. */
export const STATUS_RING_HEAD_OPACITY = 0.9;

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
  duration: STATUS_RING_PERIOD_MS,
  easing: "linear",
  iterations: Number.POSITIVE_INFINITY,
} as const;

/** The arc's geometry: a rounded box whose one coloured edge is a 90° arc. */
const ARC_STYLE = {
  position: "absolute",
  width: STATUS_RING_SIZE,
  height: STATUS_RING_SIZE,
  borderRadius: STATUS_RING_SIZE / 2,
  borderWidth: STATUS_RING_STROKE,
  borderColor: "transparent",
  opacity: STATUS_RING_HEAD_OPACITY,
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
function RotatingArc({ color, ring = STATUS_RING_SIZE, stroke = STATUS_RING_STROKE }: { color: string; ring?: number; stroke?: number }) {
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
        duration: STATUS_RING_PERIOD_MS,
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
        style={{ ...ARC_STYLE, width: ring, height: ring, borderRadius: ring / 2, borderWidth: stroke, borderTopColor: color }}
      />
    );
  }

  const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View
      style={[{ ...ARC_STYLE, width: ring, height: ring, borderRadius: ring / 2, borderWidth: stroke, borderTopColor: color }, { transform: [{ rotate }] }]}
    />
  );
}

/**
 * A running ring: the pill's icon slot, a job row's mark slot, or the corner of
 * the goal panel's whale.
 *
 * @param size - the box around the fixed 12px ring; the larger of this and 12 wins.
 * @param color - the running colour (`statusDotRunning` equivalent, via `ringColorFor`).
 * @param backdrop - when overlaying on something, the fill colour the 1px hole
 *   punches through; undefined renders the bare ring the jobs pill always had.
 */
export function StatusRingMark({
  size,
  color,
  backdrop,
  ring = STATUS_RING_SIZE,
}: {
  size: number;
  color: string;
  backdrop?: string;
  /**
   * The ring's own diameter. Default: the host's 12px. A pill's corner mark
   * (`./corner-ring`) draws a smaller one; stroke and centre dot scale with it.
   */
  ring?: number;
}) {
  const box = Math.max(size, ring);
  const stroke = ring < STATUS_RING_SIZE ? 1 : STATUS_RING_STROKE;
  const dot = ring === STATUS_RING_SIZE ? STATUS_RING_CENTER_DOT_SIZE : Math.round(ring / 2);
  return (
    <View
      style={{
        width: box,
        height: box,
        alignItems: "center",
        justifyContent: "center",
        ...(backdrop === undefined ? {} : { backgroundColor: backdrop, borderRadius: box / 2 }),
      }}
    >
      <View
        style={{
          position: "absolute",
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          borderWidth: stroke,
          borderColor: color,
          opacity: STATUS_RING_TRACK_OPACITY,
        }}
      />
      <RotatingArc color={color} ring={ring} stroke={stroke} />
      {/*
        The solid centre, the host's third layer (`status-ring/frame.tsx`'s
        `centerDot`). Without it the mark reads as a hole punched in the pill rather
        than as the host's running indicator, which is the whole point of copying it.
      */}
      <View
        style={{
          position: "absolute",
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          backgroundColor: color,
        }}
      />
    </View>
  );
}
