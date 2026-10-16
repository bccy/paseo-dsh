/**
 * A cross-platform "running" pulse for plugin-rendered timeline rows.
 *
 * Paseo's own loading rows shimmer, but that lives in the host app and is not
 * exposed to plugins (`@getpaseo/plugin` exports no spinner or shimmer
 * primitive). So the plugin drives the row's opacity itself.
 *
 * The opacity is plain React state, not an `Animated.Value`. Every
 * `Animated`-based version failed on at least one client:
 *
 * - `Animated.loop` / `Animated.timing` run one leg and stop under React Native
 *   Web, freezing the row at the dim end.
 * - `setValue` on an `Animated.Value` updates the DOM on web but did not reach
 *   the native view on the app, so the app showed no pulse at all.
 *
 * A 20 fps state tick is cheap (only running rows subscribe) and behaves the
 * same on web, desktop and mobile. One module-level timer drives every
 * subscriber, so there is exactly one interval no matter how many rows run.
 *
 * @module dsh-paseo/client/shimmer
 */
import { useEffect, useState } from "react";

const MIN = 0.35;
const MAX = 1;
const STEP_MS = 50;
const PERIOD_MS = 2200;

type Subscriber = (opacity: number) => void;

const subscribers = new Set<Subscriber>();
let timer: ReturnType<typeof setInterval> | null = null;
let elapsed = 0;

function opacityAt(ms: number): number {
  const phase = (ms / PERIOD_MS) * Math.PI * 2;
  return (MIN + MAX) / 2 + ((MAX - MIN) / 2) * Math.cos(phase);
}

function tick(): void {
  elapsed = (elapsed + STEP_MS) % PERIOD_MS;
  const opacity = opacityAt(elapsed);
  for (const notify of subscribers) notify(opacity);
}

function subscribe(notify: Subscriber): () => void {
  subscribers.add(notify);
  if (timer === null) {
    elapsed = 0;
    notify(MAX);
    timer = setInterval(tick, STEP_MS);
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current pulse opacity while `active`; constant 1 otherwise. */
export function useShimmer(active: boolean): number {
  const [opacity, setOpacity] = useState(MAX);
  useEffect(() => {
    if (!active) {
      setOpacity(MAX);
      return;
    }
    return subscribe(setOpacity);
  }, [active]);
  return opacity;
}
