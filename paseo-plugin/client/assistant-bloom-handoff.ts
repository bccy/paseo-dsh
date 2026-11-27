/**
 * Two-phase handoff coordinator for `dsh-assistant-bloom`.
 *
 * Why this exists:
 * - Fast models (e.g. `deepseek-flash`) often emit `turn_completed` 200–400 ms
 *   after streaming begins, which moves the row from Paseo's `head`
 *   (`phase: "streaming"`) into `tail` (`phase: "complete"`).
 * - If our timeline transformer immediately returned `undefined` on
 *   `phase: "complete"`, Paseo would unmount `AssistantMessageBloom` mid-wave
 *   and pop 90% of the reply onto screen in one frame.
 * - Conversely, if our transformer kept the row as `kind: "plugin"` forever,
 *   Paseo's `findTurnFooterSource()` (`layout.ts:105`) would never attach the
 *   native Copy Result / Fork to New Tab / Turn Timing footer.
 *
 * Solution (100% public `PluginClientContext.addTimelineTransformer` API):
 * 1. When an assistant reply is seen with `phase === "streaming"`, mark its
 *    identity active (`active` map) and keep transforming it even after
 *    `phase` flips to `"complete"` so the full soft-mist bloom finishes.
 * 2. When `AssistantMessageBloom` finishes its wave (or skips bloom on an idle
 *    reload), it calls `release(bloomKey)`. That removes the key and invokes
 *    `onChanged()`, which removes & re-adds the transformer so Paseo re-projects
 *    that row back to native `assistant_message` + native Copy/Fork footer.
 * 3. Historical / already-complete replies (never seen streaming) always return
 *    `{ transform: false }` on frame 0 — zero bloom, native footer immediately.
 *
 * Kept strictly React/RN-free so offline unit tests can verify every branch.
 *
 * @module dsh-paseo/client/assistant-bloom-handoff
 */

export const BLOOM_HANDOFF_MAX_HOLD_MS = 18_000;
const PREFIX_MATCH_LEN = 48;
const MAX_ACTIVE_KEYS = 32;

interface ActiveBloomEntry {
  readonly key: string;
  prefix: string;
  updatedAt: number;
  completedAt: number | null;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
}

export interface BloomTransformDecision {
  readonly transform: boolean;
  readonly bloomKey?: string;
}

export interface BloomHandoffController {
  resolve(
    item: { readonly text: string; readonly messageId?: string },
    phase: "streaming" | "complete",
    now?: number,
  ): BloomTransformDecision;
  release(bloomKey: string): boolean;
  dispose(): void;
  readonly size: number;
}

export interface BloomProgressState {
  everStreamed: boolean;
  cursor: number;
  settledFloor: number;
  readonly fadedRichBlocks: Set<number>;
}

const progressByKey = new Map<string, BloomProgressState>();

export function readBloomProgress(bloomKey: string | undefined): BloomProgressState | undefined {
  if (!bloomKey) return undefined;
  return progressByKey.get(bloomKey);
}

export function writeBloomProgress(bloomKey: string | undefined, state: BloomProgressState): void {
  if (!bloomKey) return;
  progressByKey.set(bloomKey, state);
}

export function clearBloomProgress(bloomKey: string | undefined): void {
  if (!bloomKey) return;
  progressByKey.delete(bloomKey);
}

type ReleaseHandler = (bloomKey: string) => void;
const releaseHandlers = new Set<ReleaseHandler>();

export function registerBloomReleaseHandler(handler: ReleaseHandler): () => void {
  releaseHandlers.add(handler);
  return () => {
    releaseHandlers.delete(handler);
  };
}

export function releaseAssistantBloom(bloomKey: string | undefined): void {
  if (!bloomKey) return;
  progressByKey.delete(bloomKey);
  for (const handler of releaseHandlers) {
    handler(bloomKey);
  }
}

export function createBloomHandoffController(options: {
  readonly onChanged: () => void;
  readonly maxHoldMs?: number;
  readonly schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}): BloomHandoffController {
  const maxHoldMs = options.maxHoldMs ?? BLOOM_HANDOFF_MAX_HOLD_MS;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer));
  const active = new Map<string, ActiveBloomEntry>();
  let seq = 0;
  let disposed = false;

  function clearEntry(entry: ActiveBloomEntry) {
    if (entry.fallbackTimer !== null) {
      cancel(entry.fallbackTimer);
      entry.fallbackTimer = null;
    }
    active.delete(entry.key);
    progressByKey.delete(entry.key);
  }

  function pruneOverflow() {
    while (active.size > MAX_ACTIVE_KEYS) {
      const oldest = active.values().next().value;
      if (!oldest) break;
      clearEntry(oldest);
    }
  }

  function findMatchingEntry(
    item: { readonly text: string; readonly messageId?: string },
    trimmed: string,
  ): ActiveBloomEntry | undefined {
    if (item.messageId) {
      return active.get(`id:${item.messageId}`);
    }
    if (!trimmed) return undefined;
    let best: ActiveBloomEntry | undefined;
    for (const entry of active.values()) {
      if (!entry.key.startsWith("txt:")) continue;
      if (!entry.prefix) continue;
      if (trimmed.startsWith(entry.prefix) || entry.prefix.startsWith(trimmed)) {
        if (!best || entry.prefix.length > best.prefix.length) {
          best = entry;
        }
      }
    }
    return best;
  }

  function release(bloomKey: string): boolean {
    if (disposed) return false;
    const entry = active.get(bloomKey);
    if (!entry) return false;
    clearEntry(entry);
    options.onChanged();
    return true;
  }

  return {
    get size() {
      return active.size;
    },
    resolve(item, phase, now = Date.now()) {
      if (disposed) return { transform: false };
      const trimmed = item.text.trim();

      // Drop any stale completed entries that exceeded maxHoldMs without explicit release.
      for (const entry of [...active.values()]) {
        if (entry.completedAt !== null && now - entry.completedAt >= maxHoldMs) {
          clearEntry(entry);
        }
      }

      if (phase === "streaming") {
        const existing = findMatchingEntry(item, trimmed);
        if (existing) {
          if (trimmed.length >= existing.prefix.length) {
            existing.prefix = trimmed.slice(0, PREFIX_MATCH_LEN);
          }
          existing.updatedAt = now;
          if (existing.fallbackTimer !== null) {
            cancel(existing.fallbackTimer);
            existing.fallbackTimer = null;
          }
          existing.completedAt = null;
          return { transform: true, bloomKey: existing.key };
        }
        const key = item.messageId ? `id:${item.messageId}` : `txt:${++seq}`;
        const entry: ActiveBloomEntry = {
          key,
          prefix: trimmed.slice(0, PREFIX_MATCH_LEN),
          updatedAt: now,
          completedAt: null,
          fallbackTimer: null,
        };
        active.set(key, entry);
        pruneOverflow();
        return { transform: true, bloomKey: key };
      }

      // phase === "complete"
      const match = findMatchingEntry(item, trimmed);
      if (!match) return { transform: false };
      if (match.completedAt === null) {
        match.completedAt = now;
        match.fallbackTimer = schedule(() => {
          match.fallbackTimer = null;
          release(match.key);
        }, maxHoldMs);
      }
      return { transform: true, bloomKey: match.key };
    },
    release,
    dispose() {
      disposed = true;
      for (const entry of active.values()) {
        if (entry.fallbackTimer !== null) {
          cancel(entry.fallbackTimer);
          entry.fallbackTimer = null;
        }
        progressByKey.delete(entry.key);
      }
      active.clear();
    },
  };
}
