/**
 * A cross-platform "running" pulse for plugin-rendered timeline rows.
 *
 * Paseo's own loading rows shimmer, but that lives in the host app and is not
 * exposed to plugins (`@getpaseo/plugin` exports no spinner or shimmer
 * primitive). What a plugin *can* do is pulse the row's opacity through React
 * Native's `Animated.Value`, which reads as the same "this is still running"
 * signal on web, desktop and mobile without any host module.
 *
 * Three details are deliberate, each learned from a version that failed:
 *
 * - The cycle is a plain `setInterval` calling `setValue`, not `Animated.loop`
 *   or `Animated.timing`. Under React Native Web both run one leg and then stop,
 *   freezing the row at the dim end.
 * - The animated value is a module-level singleton, so a row that remounts (the
 *   host rebuilds timeline items freely) joins the cycle already in progress
 *   instead of restarting it from full opacity.
 * - `useShimmer` hands that singleton to a row **only while it is running**; an
 *   idle row gets a constant 1. Returning the shared value unconditionally was
 *   a real bug: every row bound to the same value, so all of history pulsed
 *   together instead of only the running row.
 *
 * @module dsh-paseo/client/shimmer
 */
import { useEffect, useState } from "react";
import { Animated } from "react-native";

const MIN = 0.35;
const MAX = 1;
/** 20 fps is plenty for an opacity pulse and cheap on every platform. */
const STEP_MS = 50;
const PERIOD_MS = 2200;

const shared = new Animated.Value(MAX);
/** Constant full opacity handed to every row that is not running. */
const IDLE = new Animated.Value(MAX);

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

/** The shared animated opacity while this row runs; constant 1 otherwise. */
export function useShimmer(active: boolean): Animated.Value {
  const [value, setValue] = useState<Animated.Value>(IDLE);
  useEffect(() => {
    if (!active) {
      setValue(IDLE);
      return;
    }
    acquire();
    setValue(shared);
    return release;
  }, [active]);
  return value;
}
