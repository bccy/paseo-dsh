/**
 * Cross-platform motion primitives for the enhanced thinking-row styles.
 *
 * Platform split (matching `./row-entrance` and `./row-status-icon`):
 * - **Web**: injects one `<style id="dsh-paseo-thinking-motion">` stylesheet
 *   keyed by `[data-testid]`, honouring `prefers-reduced-motion: reduce`.
 * - **Native**: runs `Animated` loops / timings strictly on the native driver
 *   (`useNativeDriver: true`), cleaning up every animation on prop change or
 *   unmount.
 * - **Offline harnesses**: guards `Platform` / `Animated` / `Easing` with
 *   optional chaining so minimal stubs render deterministically without throwing.
 *
 * Every colour comes from the caller's Paseo theme tokens — zero hardcoded hex
 * colours live in this module or its injected stylesheet.
 *
 * @module dsh-paseo/client/thinking-motion
 */
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, View, type StyleProp, type ViewStyle } from "react-native";
import { withAlpha } from "./tokens";

export const THINKING_RAIL_BREATHE_TEST_ID = "dsh-thinking-rail-breathe";
export const THINKING_DOT_BREATHE_TEST_ID = "dsh-thinking-dot-breathe";
export const THINKING_PROGRESS_BAR_TEST_ID = "dsh-thinking-progress-bar";
export const THINKING_SUBTITLE_SWAP_TEST_ID = "dsh-thinking-subtitle-swap";

export const RAIL_BREATHE_MS = 2200;
export const DOT_BREATHE_MS = 1100;
export const PROGRESS_GLIDE_MS = 1450;
export const SUBTITLE_SWAP_MS = 240;

const STYLE_ID = "dsh-paseo-thinking-motion";

interface WebStyleElement {
  id: string;
  textContent: string;
}
interface WebDocument {
  getElementById(id: string): unknown;
  createElement(tag: string): WebStyleElement;
  head: { appendChild(node: WebStyleElement): void } | null;
}

const THINKING_MOTION_CSS = `
[data-testid="${THINKING_RAIL_BREATHE_TEST_ID}"] {
  animation: dsh-thinking-rail-breathe ${RAIL_BREATHE_MS}ms ease-in-out infinite;
  will-change: opacity;
}

@keyframes dsh-thinking-rail-breathe {
  0%, 100% { opacity: 0.28; }
  50% { opacity: 0.9; }
}

[data-testid="${THINKING_DOT_BREATHE_TEST_ID}"] {
  animation: dsh-thinking-dot-breathe ${DOT_BREATHE_MS}ms ease-in-out infinite;
  will-change: opacity, transform;
}

@keyframes dsh-thinking-dot-breathe {
  0%, 100% { opacity: 0.35; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.15); }
}

[data-testid="${THINKING_PROGRESS_BAR_TEST_ID}"] {
  animation: dsh-thinking-progress-glide ${PROGRESS_GLIDE_MS}ms ease-in-out infinite;
  will-change: transform;
}

@keyframes dsh-thinking-progress-glide {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(300%); }
}

[data-testid="${THINKING_SUBTITLE_SWAP_TEST_ID}"] {
  animation: dsh-thinking-subtitle-swap ${SUBTITLE_SWAP_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
  will-change: opacity, transform;
}

@keyframes dsh-thinking-subtitle-swap {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  [data-testid="${THINKING_RAIL_BREATHE_TEST_ID}"],
  [data-testid="${THINKING_DOT_BREATHE_TEST_ID}"],
  [data-testid="${THINKING_PROGRESS_BAR_TEST_ID}"],
  [data-testid="${THINKING_SUBTITLE_SWAP_TEST_ID}"] {
    animation: none !important;
    will-change: auto !important;
  }
}
`;

function isWebPlatform(): boolean {
  return Platform?.OS === "web";
}

function webDocument(): WebDocument | null {
  return (globalThis as { document?: WebDocument }).document ?? null;
}

/** Inject the thinking-motion stylesheet once on Web. No-op off Web. */
export function ensureThinkingMotionStyles(): void {
  if (!isWebPlatform()) return;
  const doc = webDocument();
  if (doc === null || doc.head === null || doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = THINKING_MOTION_CSS;
  doc.head.appendChild(style);
}

function hasNativeAnimatedLoop(): boolean {
  return (
    !isWebPlatform() &&
    typeof Animated?.View !== "undefined" &&
    typeof Animated?.Value === "function" &&
    typeof Animated?.timing === "function" &&
    typeof Animated?.loop === "function"
  );
}

function hasNativeAnimatedTiming(): boolean {
  return (
    !isWebPlatform() &&
    typeof Animated?.View !== "undefined" &&
    typeof Animated?.Value === "function" &&
    typeof Animated?.timing === "function"
  );
}

/**
 * 2px left rail container whose rail bar breathes in `accentColor` while active
 * and settles into `idleColor` (`colors.border`) once complete.
 *
 * Animating an explicit left bar's `opacity` instead of `borderLeftColor` keeps
 * the animation on the native driver (`useNativeDriver: true`) and avoids any
 * hardcoded RGBA colour in CSS.
 */
export function BreathingRail({
  active,
  accentColor,
  idleColor,
  marginLeft = 7,
  paddingLeft = 12,
  railWidth = 2,
  children,
}: {
  active: boolean;
  accentColor: string;
  idleColor: string;
  marginLeft?: number;
  paddingLeft?: number;
  railWidth?: number;
  children: ReactNode;
}): ReactElement {
  const web = isWebPlatform();
  const canNative = active && hasNativeAnimatedLoop() && typeof Animated?.sequence === "function";
  const progressRef = useRef<InstanceType<typeof Animated.Value> | null>(null);
  if (canNative && progressRef.current === null) {
    progressRef.current = new Animated.Value(0);
  }

  useEffect(() => {
    if (web && active) {
      ensureThinkingMotionStyles();
      return;
    }
    if (!canNative || progressRef.current === null) return;
    const progress = progressRef.current;
    progress.setValue(0);
    const ease =
      typeof Easing?.inOut === "function" && Easing?.sin !== undefined
        ? Easing.inOut(Easing.sin)
        : undefined;
    const half = Math.round(RAIL_BREATHE_MS / 2);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: half,
          ...(ease !== undefined ? { easing: ease } : {}),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: half,
          ...(ease !== undefined ? { easing: ease } : {}),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [web, active, canNative]);

  const railPosition: ViewStyle = {
    position: "absolute",
    left: 0,
    top: 2,
    bottom: 2,
    width: railWidth,
    borderRadius: railWidth / 2,
    backgroundColor: active ? accentColor : idleColor,
  };

  let railBar: ReactElement;
  if (!active) {
    railBar = <View pointerEvents="none" style={railPosition} />;
  } else if (web) {
    railBar = <View testID={THINKING_RAIL_BREATHE_TEST_ID} pointerEvents="none" style={railPosition} />;
  } else if (canNative && progressRef.current !== null) {
    const AnimatedView = Animated.View;
    const opacity = progressRef.current.interpolate({
      inputRange: [0, 1],
      outputRange: [0.28, 0.9],
    });
    railBar = <AnimatedView pointerEvents="none" style={[railPosition, { opacity }]} />;
  } else {
    railBar = <View pointerEvents="none" style={[railPosition, { opacity: 0.72 }]} />;
  }

  return (
    <View style={{ position: "relative", marginLeft, paddingLeft }}>
      {railBar}
      {children}
    </View>
  );
}

/** Compact breathing status / streaming cursor dot in `color` (`colors.accent`). */
export function BreathingDot({
  color,
  size = 5,
  active = true,
  style,
}: {
  color: string;
  size?: number;
  active?: boolean;
  style?: StyleProp<ViewStyle>;
}): ReactElement {
  const web = isWebPlatform();
  const canNative = active && hasNativeAnimatedLoop() && typeof Animated?.sequence === "function";
  const progressRef = useRef<InstanceType<typeof Animated.Value> | null>(null);
  if (canNative && progressRef.current === null) {
    progressRef.current = new Animated.Value(0);
  }

  useEffect(() => {
    if (web && active) {
      ensureThinkingMotionStyles();
      return;
    }
    if (!canNative || progressRef.current === null) return;
    const progress = progressRef.current;
    progress.setValue(0);
    const half = Math.round(DOT_BREATHE_MS / 2);
    const ease =
      typeof Easing?.inOut === "function" && Easing?.sin !== undefined
        ? Easing.inOut(Easing.sin)
        : undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: half,
          ...(ease !== undefined ? { easing: ease } : {}),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: half,
          ...(ease !== undefined ? { easing: ease } : {}),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [web, active, canNative]);

  const dotStyle: ViewStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: color,
  };

  if (!active) {
    return <View pointerEvents="none" style={[dotStyle, style]} />;
  }
  if (web) {
    return <View testID={THINKING_DOT_BREATHE_TEST_ID} pointerEvents="none" style={[dotStyle, style]} />;
  }
  if (canNative && progressRef.current !== null) {
    const AnimatedView = Animated.View;
    const opacity = progressRef.current.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] });
    const scale = progressRef.current.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.15] });
    return (
      <AnimatedView
        pointerEvents="none"
        style={[dotStyle, style, { opacity, transform: [{ scale }] }]}
      />
    );
  }
  return <View pointerEvents="none" style={[dotStyle, style]} />;
}

/** Thin indeterminate gliding bar used under the Soft Capsule header while running. */
export function GlideProgressBar({
  accentColor,
  trackColor,
}: {
  accentColor: string;
  trackColor: string;
}): ReactElement {
  const web = isWebPlatform();
  const [trackWidth, setTrackWidth] = useState(0);
  const canNative = !web && trackWidth > 0 && hasNativeAnimatedLoop();
  const progressRef = useRef<InstanceType<typeof Animated.Value> | null>(null);
  if (canNative && progressRef.current === null) {
    progressRef.current = new Animated.Value(0);
  }

  useEffect(() => {
    if (web) {
      ensureThinkingMotionStyles();
      return;
    }
    if (!canNative || progressRef.current === null) return;
    const progress = progressRef.current;
    progress.setValue(0);
    const ease =
      typeof Easing?.inOut === "function" && Easing?.quad !== undefined
        ? Easing.inOut(Easing.quad)
        : undefined;
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: PROGRESS_GLIDE_MS,
        ...(ease !== undefined ? { easing: ease } : {}),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [web, canNative, trackWidth]);

  const barWidth = trackWidth > 0 ? Math.max(36, Math.round(trackWidth * 0.36)) : 0;

  return (
    <View
      pointerEvents="none"
      onLayout={(event) => {
        const w = event?.nativeEvent?.layout?.width ?? 0;
        if (w > 0 && w !== trackWidth) setTrackWidth(w);
      }}
      style={{
        height: 2,
        backgroundColor: withAlpha(trackColor, 0.45),
        overflow: "hidden",
        position: "relative",
      }}
    >
      {web ? (
        <View
          testID={THINKING_PROGRESS_BAR_TEST_ID}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: "36%",
            backgroundColor: accentColor,
            borderRadius: 1,
          }}
        />
      ) : canNative && progressRef.current !== null ? (
        <Animated.View
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: barWidth,
            backgroundColor: accentColor,
            borderRadius: 1,
            transform: [
              {
                translateX: progressRef.current.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-barWidth, trackWidth],
                }),
              },
            ],
          }}
        />
      ) : (
        <View
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: "36%",
            backgroundColor: accentColor,
            opacity: 0.7,
          }}
        />
      )}
    </View>
  );
}

/**
 * Subtle upward fade-in whenever `slideKey` changes while `active` is true
 * (used by Plan B Silk Subtitle for calm paragraph-level swaps).
 */
export function SilkSubtitleSlide({
  slideKey,
  active,
  style,
  children,
}: {
  slideKey: string;
  active: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}): ReactElement {
  const web = isWebPlatform();
  const canNative = active && hasNativeAnimatedTiming() && typeof Animated?.parallel === "function";
  const opacityRef = useRef<InstanceType<typeof Animated.Value> | null>(null);
  const translateRef = useRef<InstanceType<typeof Animated.Value> | null>(null);
  if (canNative) {
    if (opacityRef.current === null) opacityRef.current = new Animated.Value(1);
    if (translateRef.current === null) translateRef.current = new Animated.Value(0);
  }

  useEffect(() => {
    if (web && active) {
      ensureThinkingMotionStyles();
      return;
    }
    if (!canNative || opacityRef.current === null || translateRef.current === null) return;
    opacityRef.current.setValue(0);
    translateRef.current.setValue(6);
    const ease =
      typeof Easing?.out === "function" && Easing?.cubic !== undefined
        ? Easing.out(Easing.cubic)
        : undefined;
    const anim = Animated.parallel([
      Animated.timing(opacityRef.current, {
        toValue: 1,
        duration: SUBTITLE_SWAP_MS,
        ...(ease !== undefined ? { easing: ease } : {}),
        useNativeDriver: true,
      }),
      Animated.timing(translateRef.current, {
        toValue: 0,
        duration: SUBTITLE_SWAP_MS,
        ...(ease !== undefined ? { easing: ease } : {}),
        useNativeDriver: true,
      }),
    ]);
    anim.start();
    return () => {
      anim.stop();
    };
  }, [web, active, canNative, slideKey]);

  if (!active) {
    return <View style={style}>{children}</View>;
  }
  if (web) {
    return (
      <View key={slideKey} testID={THINKING_SUBTITLE_SWAP_TEST_ID} style={style}>
        {children}
      </View>
    );
  }
  if (canNative && opacityRef.current !== null && translateRef.current !== null) {
    return (
      <Animated.View
        style={[
          style,
          {
            opacity: opacityRef.current,
            transform: [{ translateY: translateRef.current }],
          },
        ]}
      >
        {children}
      </Animated.View>
    );
  }
  return <View style={style}>{children}</View>;
}

/**
 * Zero-dependency 3-band stepped top fade veil for streaming peek windows.
 *
 * Works identically on iOS, Android, and Web without pulling in a gradient
 * package or relying on CSS-only `linear-gradient`.
 */
export function SteppedFadeVeil({
  backgroundColor,
  height = 18,
}: {
  backgroundColor: string;
  height?: number;
}): ReactElement {
  const band = Math.max(2, Math.round(height / 3));
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: band * 3,
      }}
    >
      <View style={{ height: band, backgroundColor: withAlpha(backgroundColor, 0.92) }} />
      <View style={{ height: band, backgroundColor: withAlpha(backgroundColor, 0.52) }} />
      <View style={{ height: band, backgroundColor: withAlpha(backgroundColor, 0.16) }} />
    </View>
  );
}
