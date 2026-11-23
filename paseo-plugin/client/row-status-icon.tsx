/**
 * Leading status icon wrapper for timeline rows (`InlineToolCall` and
 * `InlineThinking`), implementing Plan A:
 *
 * - Keeps the row's base glyph intact (a subtle breathing pulse for running
 *   tools; a smooth rotation for running thinking petals).
 * - Overlays a knocked-out bottom-right corner badge filled with `surface0`:
 *   - `running`: Paseo's own `StatusRingMark` mini blue ring.
 *   - `completed`: a bare green checkmark (`colors.statusSuccess`).
 *   - `failed`: a compact red error disk (`colors.statusDanger`) with a cross.
 *   - `idle`: base glyph only, no badge.
 * - Plays a one-shot pop animation when a row settles from `running` into
 *   `completed` or `failed`; historic rows mount statically with no pop.
 *
 * Platform split:
 * - **Web**: injects one `<style id="dsh-paseo-row-status-icon">` sheet keyed
 *   by `[data-testid]` (matching `./shimmer-css` and `./row-entrance`),
 *   honouring `prefers-reduced-motion: reduce`.
 * - **Native**: drives base spin/pulse and badge pop on the native driver via
 *   `Animated`, cleaning up loops on status change or unmount.
 * - **Offline harnesses**: guards `Platform` / `Animated` / `Easing` with
 *   optional chaining so minimal `react-native` stubs never throw.
 *
 * @module dsh-paseo/client/row-status-icon
 */
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, Platform, View } from "react-native";
import { ringColorFor } from "./jobs-popover-layout";
import {
  CHECK_BADGE_ICON,
  ERROR_BADGE_ICON,
  FALLBACK_DANGER_COLOR,
  FALLBACK_SUCCESS_COLOR,
  ROW_BADGE_POP_MS,
  ROW_ICON_PULSE_MS,
  ROW_ICON_SPIN_MS,
  cornerBadgeMetrics,
  shouldPopRowBadge,
  type RowIconStatus,
} from "./row-status-icon-data";
import { StatusRingMark } from "./status-ring";

export {
  CHECK_BADGE_ICON,
  ERROR_BADGE_ICON,
  cornerBadgeMetrics,
  resolveRowIconStatus,
  resolveThinkingIconStatus,
  shouldPopRowBadge,
  type RowIconStatus,
} from "./row-status-icon-data";

/** `testID` hooks for CSS keyframes on Web and deterministic offline assertions. */
export const ROW_ICON_SLOT_TEST_ID = "dsh-row-icon-slot";
export const ROW_ICON_SPIN_TEST_ID = "dsh-row-icon-spin";
export const ROW_ICON_PULSE_TEST_ID = "dsh-row-icon-pulse";
export const ROW_BADGE_RUNNING_TEST_ID = "dsh-row-badge-running";
export const ROW_BADGE_COMPLETED_TEST_ID = "dsh-row-badge-completed";
export const ROW_BADGE_FAILED_TEST_ID = "dsh-row-badge-failed";
export const ROW_BADGE_POP_TEST_ID = "dsh-row-badge-pop";

const STYLE_ID = "dsh-paseo-row-status-icon";

interface WebStyleElement {
  id: string;
  textContent: string;
}
interface WebDocument {
  getElementById(id: string): unknown;
  createElement(tag: string): WebStyleElement;
  head: { appendChild(node: WebStyleElement): void } | null;
}

const ROW_STATUS_ICON_CSS = `
[data-testid="${ROW_ICON_SPIN_TEST_ID}"] {
  animation: dsh-row-icon-spin ${ROW_ICON_SPIN_MS}ms linear infinite;
  will-change: transform;
}

@keyframes dsh-row-icon-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

[data-testid="${ROW_ICON_PULSE_TEST_ID}"] {
  animation: dsh-row-icon-pulse ${ROW_ICON_PULSE_MS}ms ease-in-out infinite;
  will-change: opacity, transform;
}

@keyframes dsh-row-icon-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.68; transform: scale(0.94); }
}

[data-testid="${ROW_BADGE_POP_TEST_ID}"] {
  animation: dsh-row-badge-pop ${ROW_BADGE_POP_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  will-change: opacity, transform;
}

@keyframes dsh-row-badge-pop {
  0% { opacity: 0; transform: scale(0.45); }
  70% { opacity: 1; transform: scale(1.08); }
  100% { opacity: 1; transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  [data-testid="${ROW_ICON_SPIN_TEST_ID}"],
  [data-testid="${ROW_ICON_PULSE_TEST_ID}"],
  [data-testid="${ROW_BADGE_POP_TEST_ID}"] {
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

/** Inject the row-icon keyframes stylesheet once on Web. No-op off Web. */
export function ensureRowStatusIconStyles(): void {
  if (!isWebPlatform()) return;
  const doc = webDocument();
  if (doc === null || doc.head === null || doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = ROW_STATUS_ICON_CSS;
  doc.head.appendChild(style);
}

/** Minimal theme slice needed by `RowStatusIcon` (keeps test stubs lightweight). */
export interface RowStatusIconColors {
  readonly surface0: string;
  readonly statusSuccess?: string;
  readonly statusDanger?: string;
}

export interface RowStatusIconProps {
  status: RowIconStatus;
  size: number;
  colors: RowStatusIconColors;
  /** Smoothly rotate the base glyph while running (used for thinking petals). */
  spinBase?: boolean;
  /**
   * Surface behind the icon so the bottom-right corner badge knocks out
   * cleanly when mounted on an elevated card (e.g. `colors.surface1`).
   * Defaults to `colors.surface0`.
   */
  backdropColor?: string;
  children: ReactNode;
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

/** Animated base glyph container while `status === "running"`. */
function RunningBase({
  size,
  spin,
  children,
}: {
  size: number;
  spin: boolean;
  children: ReactNode;
}): ReactElement {
  const web = isWebPlatform();
  const canNative = hasNativeAnimatedLoop();
  const progressRef = useRef<InstanceType<typeof Animated.Value> | null>(null);
  if (canNative && progressRef.current === null) {
    progressRef.current = new Animated.Value(0);
  }

  useEffect(() => {
    if (web) {
      ensureRowStatusIconStyles();
      return;
    }
    if (!canNative || progressRef.current === null) return;
    const progress = progressRef.current;
    progress.setValue(0);

    let loop: { start(): void; stop(): void } | null = null;
    if (spin) {
      loop = Animated.loop(
        Animated.timing(progress, {
          toValue: 1,
          duration: ROW_ICON_SPIN_MS,
          ...(Easing?.linear !== undefined ? { easing: Easing.linear } : {}),
          useNativeDriver: true,
        }),
      );
    } else if (typeof Animated?.sequence === "function") {
      const half = Math.round(ROW_ICON_PULSE_MS / 2);
      const ease =
        typeof Easing?.inOut === "function" && Easing?.ease !== undefined
          ? Easing.inOut(Easing.ease)
          : undefined;
      loop = Animated.loop(
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
    }
    loop?.start();
    return () => {
      loop?.stop();
      progress.setValue(0);
    };
  }, [web, canNative, spin]);

  const baseStyle = {
    width: size,
    height: size,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  if (web) {
    return (
      <View testID={spin ? ROW_ICON_SPIN_TEST_ID : ROW_ICON_PULSE_TEST_ID} style={baseStyle}>
        {children}
      </View>
    );
  }

  if (canNative && progressRef.current !== null) {
    const AnimatedView = Animated.View;
    const progress = progressRef.current;
    if (spin) {
      const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
      return <AnimatedView style={[baseStyle, { transform: [{ rotate }] }]}>{children}</AnimatedView>;
    }
    const opacity = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.68] });
    const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.94] });
    return (
      <AnimatedView style={[baseStyle, { opacity, transform: [{ scale }] }]}>{children}</AnimatedView>
    );
  }

  return <View style={baseStyle}>{children}</View>;
}

/** One-shot pop wrapper for a freshly settled corner badge. */
function PopBadge({
  pop,
  children,
}: {
  pop: boolean;
  children: ReactNode;
}): ReactElement {
  const web = isWebPlatform();
  const canNative = pop && hasNativeAnimatedTiming();
  const progressRef = useRef<InstanceType<typeof Animated.Value> | null>(null);
  if (canNative && progressRef.current === null) {
    progressRef.current = new Animated.Value(0);
  }

  useEffect(() => {
    if (web && pop) {
      ensureRowStatusIconStyles();
      return;
    }
    if (!canNative || progressRef.current === null) return;
    const progress = progressRef.current;
    progress.setValue(0);
    const ease =
      typeof Easing?.out === "function" && Easing?.back !== undefined
        ? Easing.out(Easing.back(1.6))
        : typeof Easing?.out === "function" && Easing?.cubic !== undefined
          ? Easing.out(Easing.cubic)
          : undefined;
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: ROW_BADGE_POP_MS,
      ...(ease !== undefined ? { easing: ease } : {}),
      useNativeDriver: true,
    });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [web, pop, canNative]);

  const innerStyle = {
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  if (!pop) {
    return <View style={innerStyle}>{children}</View>;
  }

  if (web) {
    return (
      <View testID={ROW_BADGE_POP_TEST_ID} style={innerStyle}>
        {children}
      </View>
    );
  }

  if (canNative && progressRef.current !== null) {
    const AnimatedView = Animated.View;
    const progress = progressRef.current;
    const opacity = progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 1, 1] });
    const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });
    return (
      <AnimatedView style={[innerStyle, { opacity, transform: [{ scale }] }]}>{children}</AnimatedView>
    );
  }

  return <View style={innerStyle}>{children}</View>;
}

/**
 * Render a timeline row's leading icon with Plan A's animated running state
 * and bottom-right status badge (bare green checkmark on completion).
 */
export function RowStatusIcon({
  status,
  size,
  colors,
  spinBase = false,
  backdropColor,
  children,
}: RowStatusIconProps): ReactElement {
  // Track previous status in state (React's render-phase derived transition
  // pattern): StrictMode-safe, triggers zero extra flicker frames, and ensures
  // historic completed/failed rows mount statically without popping.
  const [transition, setTransition] = useState<{
    prev: RowIconStatus;
    popping: boolean;
    seq: number;
  }>(() => ({ prev: status, popping: false, seq: 0 }));

  if (transition.prev !== status) {
    const popping = shouldPopRowBadge(transition.prev, status);
    setTransition({
      prev: status,
      popping,
      seq: popping ? transition.seq + 1 : transition.seq,
    });
  }

  const metrics = cornerBadgeMetrics(size);
  const backdrop = backdropColor ?? colors.surface0;
  const successColor = colors.statusSuccess ?? FALLBACK_SUCCESS_COLOR;
  const dangerColor = colors.statusDanger ?? FALLBACK_DANGER_COLOR;

  const badgeSlotStyle = {
    position: "absolute" as const,
    right: metrics.offset,
    bottom: metrics.offset,
    width: metrics.frame,
    height: metrics.frame,
    borderRadius: metrics.frame / 2,
    backgroundColor: backdrop,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  let badge: ReactElement | null = null;
  if (status === "running") {
    badge = (
      <View
        testID={ROW_BADGE_RUNNING_TEST_ID}
        pointerEvents="none"
        style={{
          position: "absolute",
          right: metrics.offset,
          bottom: metrics.offset,
          width: metrics.frame,
          height: metrics.frame,
        }}
      >
        <StatusRingMark
          size={metrics.frame}
          ring={metrics.ring}
          color={ringColorFor(backdrop)}
          backdrop={backdrop}
        />
      </View>
    );
  } else if (status === "completed") {
    badge = (
      <View
        key={`completed:${transition.seq}`}
        testID={ROW_BADGE_COMPLETED_TEST_ID}
        pointerEvents="none"
        style={badgeSlotStyle}
      >
        <PopBadge pop={transition.popping}>
          <Image
            source={{ uri: CHECK_BADGE_ICON }}
            style={{ width: metrics.checkGlyph, height: metrics.checkGlyph }}
            tintColor={successColor}
          />
        </PopBadge>
      </View>
    );
  } else if (status === "failed") {
    badge = (
      <View
        key={`failed:${transition.seq}`}
        testID={ROW_BADGE_FAILED_TEST_ID}
        pointerEvents="none"
        style={badgeSlotStyle}
      >
        <PopBadge pop={transition.popping}>
          <View
            style={{
              width: metrics.errorDisk,
              height: metrics.errorDisk,
              borderRadius: metrics.errorDisk / 2,
              backgroundColor: dangerColor,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Image
              source={{ uri: ERROR_BADGE_ICON }}
              style={{ width: metrics.errorGlyph, height: metrics.errorGlyph }}
              tintColor={backdrop}
            />
          </View>
        </PopBadge>
      </View>
    );
  }

  return (
    <View
      testID={ROW_ICON_SLOT_TEST_ID}
      style={{
        position: "relative",
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {status === "running" ? (
        <RunningBase size={size} spin={spinBase}>
          {children}
        </RunningBase>
      ) : (
        children
      )}
      {badge}
    </View>
  );
}
