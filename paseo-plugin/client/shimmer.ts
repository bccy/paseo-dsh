/**
 * A cross-platform "running" pulse for plugin-rendered timeline rows.
 *
 * Paseo's own loading rows shimmer, but that lives in the host app and is not
 * exposed to plugins (`@getpaseo/plugin` exports no spinner or shimmer
 * primitive). What a plugin *can* do is pulse the row's opacity with React
 * Native's `Animated`, which reads as the same "this is still running" signal
 * on web, desktop and mobile without any host module.
 *
 * A moving highlight was tried and looked worse: without a real gradient it is
 * a hard-edged bar sliding across the text. The opacity pulse is subtler and
 * was the version the user preferred.
 *
 * @module dsh-paseo/client/shimmer
 */
import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";

const DIM = 0.35;
/** Slow enough to read as a pulse; the first version at 650ms read as a flicker. */
const HALF_CYCLE_MS = 1100;

/** An animated opacity that loops while `active`, and rests at 1 otherwise. */
export function useShimmer(active: boolean): Animated.Value {
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      value.stopAnimation();
      value.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: DIM,
          duration: HALF_CYCLE_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 1,
          duration: HALF_CYCLE_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, value]);
  return value;
}
