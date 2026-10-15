/**
 * A cross-platform "running" pulse for plugin-rendered timeline rows.
 *
 * Paseo's own loading rows shimmer, but that lives in the host app and is not
 * exposed to plugins (`@getpaseo/plugin` exports no spinner or shimmer
 * primitive). What a plugin *can* do is pulse the row's opacity through React
 * Native's `Animated.Value`, which reads as the same "this is still running"
 * signal on web, desktop and mobile without any host module.
 *
 * Three details are deliberate, each one learned from a version that did not
 * animate at all:
 *
 * - The value is a module-level singleton, not one per row. The host rebuilds
 *   timeline items freely; a per-row value restarted from full opacity on every
 *   rebuild, which read as "no pulse".
 * - It is driven by a plain interval calling `setValue`, not by `Animated.loop`
 *   or `Animated.timing`. Under React Native Web both stop after one leg and
 *   leave the row frozen at the dim end.
 * - `useNativeDriver` is irrelevant here because no timing driver is involved.
 *
 * @module dsh-paseo/client/shimmer
 */
import { useEffect } from "react";
import { Animated } from "react-native";

const MIN = 0.35;
const MAX = 1;
/** 20 fps is plenty for an opacity pulse and cheap on every platform. */
const STEP_MS = 50;
const PERIOD_MS = 2200;

const shared = new Animated.Value(MAX);

let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let elapsed = 0;

function tick(): void {
  elapsed = (elapsed + STEP_MS) % PERIOD_MS;
  const phase = (elapsed / PERIOD_MS) * Math.PI * 2;
  shared.setValue((MIN + MAX) / 2 + ((MAX - MIN) / 2) * Math.cos(phase));
}

function acquire(): void {
  users += 1;
  if (timer !== null) return;
  elapsed = 0;
  tick();
  timer = setInterval(tick, STEP_MS);
}

function release(): void {
  users = Math.max(0, users - 1);
  if (users > 0 || timer === null) return;
  clearInterval(timer);
  timer = null;
  shared.setValue(MAX);
}

/** The shared animated opacity; 1 whenever nothing is running. */
export function useShimmer(active: boolean): Animated.Value {
  useEffect(() => {
    if (!active) return;
    acquire();
    return release;
  }, [active]);
  return shared;
}
