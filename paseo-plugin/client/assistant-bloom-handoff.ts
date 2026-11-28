/**
 * Lightweight session-scoped live tracker for `dsh-assistant-bloom`.
 *
 * Why this exists (0-flash, 0-reflow architecture):
 * - Historical / already-complete replies (first seen with `phase === "complete"`)
 *   always return `{ transform: false }` on frame 0 so Paseo renders its native
 *   `<AssistantMessage>` directly.
 * - Replies first seen with `phase === "streaming"` are recorded in a bounded
 *   LRU map (`MAX_LIVE_BLOOM_KEYS = 48`) and stay on the same `dsh-assistant-bloom`
 *   plugin row even after `phase` transitions to `"complete"` — never
 *   unregistering/re-registering the transformer (which would invalidate
 *   Paseo's page-wide `projectionCache`) and never swapping `LegendList` item
 *   IDs (which would unmount/remount iOS `EnrichedMarkdown` and flash).
 *   On Paseo >= 0.18.1, `source: item` preserves the native Copy / Fork / Turn
 *   Timing footer automatically on this plugin row.
 * - Fallback `txt:` tracking (when a provider omits `messageId`) supports
 *   optional `agentId` scoping so concurrent agents sharing a short opening
 *   prefix never collide.
 * - A matching bounded in-memory state cache (`readLiveBloomState` /
 *   `writeLiveBloomState`) preserves revealed block indices across rare
 *   `liveHead -> history` remounts without ever resurrecting evicted keys.
 *
 * Kept strictly React/RN-free so offline Node tests can verify every branch.
 *
 * @module dsh-paseo/client/assistant-bloom-handoff
 */

export const MAX_LIVE_BLOOM_KEYS = 48;
const PREFIX_MATCH_LEN = 48;
const MAX_EVICTED_TOMBSTONES = 128;

interface TrackedBloomEntry {
  readonly key: string;
  readonly scope: string;
  prefix: string;
  completed: boolean;
}

export interface BloomTransformDecision {
  readonly transform: boolean;
  readonly bloomKey?: string;
}

export interface LiveBloomTracker {
  resolve(
    item: { readonly text: string; readonly messageId?: string; readonly agentId?: string },
    phase: "streaming" | "complete",
    agentId?: string,
  ): BloomTransformDecision;
  has(bloomKey: string): boolean;
  dispose(): void;
  readonly size: number;
}

export interface LiveBloomState {
  /** Whether this reply has ever streamed live in the current session. */
  everStreamed: boolean;
  /** Floating-point code-point cursor along the assistant reply. */
  cursor: number;
  /** Settled code-point floor so already-revealed glyphs never regress in alpha. */
  settledFloor: number;
  /** Smoothed streaming velocity (code points / sec) preserved across remounts. */
  velocity: number;
  /** Once true, the completed reply has finished blooming and swapped to `<Markdown>`. */
  unifiedSettled: boolean;
  /** Block indices that have already completed reveal. */
  readonly revealedBlocks: Set<number>;
}

const liveStateByKey = new Map<string, LiveBloomState>();
const evictedKeys = new Set<string>();

function markEvicted(bloomKey: string): void {
  liveStateByKey.delete(bloomKey);
  if (evictedKeys.has(bloomKey)) {
    evictedKeys.delete(bloomKey);
  } else if (evictedKeys.size >= MAX_EVICTED_TOMBSTONES) {
    const oldest = evictedKeys.values().next().value;
    if (oldest !== undefined) evictedKeys.delete(oldest);
  }
  evictedKeys.add(bloomKey);
}

function unmarkEvicted(bloomKey: string): void {
  evictedKeys.delete(bloomKey);
}

export function readLiveBloomState(bloomKey: string | undefined): LiveBloomState | undefined {
  if (!bloomKey || evictedKeys.has(bloomKey)) return undefined;
  return liveStateByKey.get(bloomKey);
}

/**
 * Persist lightweight in-memory bloom state for a live key.
 * Keys that were already evicted by overflow or tracker disposal are ignored
 * so late component unmounts can never resurrect ghost entries.
 */
export function writeLiveBloomState(
  bloomKey: string | undefined,
  state: LiveBloomState,
): void {
  if (!bloomKey || evictedKeys.has(bloomKey)) return;
  if (liveStateByKey.has(bloomKey)) {
    liveStateByKey.delete(bloomKey);
  } else if (liveStateByKey.size >= MAX_LIVE_BLOOM_KEYS) {
    const oldest = liveStateByKey.keys().next().value;
    if (oldest !== undefined) markEvicted(oldest);
  }
  liveStateByKey.set(bloomKey, state);
}

/** Reset module-level in-memory bloom state (offline tests only). */
export function resetLiveBloomStateForTests(): void {
  liveStateByKey.clear();
  evictedKeys.clear();
}

export function createLiveBloomTracker(options?: {
  readonly maxKeys?: number;
}): LiveBloomTracker {
  const maxKeys = Math.max(1, Math.floor(options?.maxKeys ?? MAX_LIVE_BLOOM_KEYS));
  const tracked = new Map<string, TrackedBloomEntry>();
  let seq = 0;
  let disposed = false;

  function touch(entry: TrackedBloomEntry): void {
    tracked.delete(entry.key);
    tracked.set(entry.key, entry);
  }

  function pruneOverflow(): void {
    while (tracked.size > maxKeys) {
      const oldest = tracked.values().next().value;
      if (!oldest) break;
      tracked.delete(oldest.key);
      markEvicted(oldest.key);
    }
  }

  function findMatchingEntry(
    item: { readonly text: string; readonly messageId?: string },
    trimmed: string,
    phase: "streaming" | "complete",
    scope: string,
  ): TrackedBloomEntry | undefined {
    if (item.messageId) {
      return tracked.get(`id:${item.messageId}`);
    }
    const allowEmptyAdoption = phase === "streaming";
    if (!trimmed) {
      if (!allowEmptyAdoption) return undefined;
      let latestEmpty: TrackedBloomEntry | undefined;
      for (const entry of tracked.values()) {
        if (
          entry.key.startsWith("txt:") &&
          entry.scope === scope &&
          !entry.completed &&
          entry.prefix === ""
        ) {
          latestEmpty = entry;
        }
      }
      return latestEmpty;
    }
    let best: TrackedBloomEntry | undefined;
    let fallbackEmpty: TrackedBloomEntry | undefined;
    for (const entry of tracked.values()) {
      if (!entry.key.startsWith("txt:")) continue;
      if (entry.scope !== scope) continue;
      // A new streaming reply without `messageId` must never collide with an
      // already-completed reply whose prefix happens to share the first few chars.
      if (phase === "streaming" && entry.completed) continue;
      if (!entry.prefix) {
        if (allowEmptyAdoption) fallbackEmpty = entry;
        continue;
      }
      if (trimmed.startsWith(entry.prefix) || entry.prefix.startsWith(trimmed)) {
        if (
          !best ||
          entry.prefix.length > best.prefix.length ||
          (entry.prefix.length === best.prefix.length && best.completed && !entry.completed)
        ) {
          best = entry;
        }
      }
    }
    return best ?? fallbackEmpty;
  }

  return {
    get size() {
      return tracked.size;
    },
    has(bloomKey: string): boolean {
      return !disposed && tracked.has(bloomKey) && !evictedKeys.has(bloomKey);
    },
    resolve(item, phase, explicitAgentId): BloomTransformDecision {
      if (disposed) return { transform: false };
      const trimmed = item.text.trim();
      const scope =
        typeof explicitAgentId === "string" && explicitAgentId !== ""
          ? explicitAgentId
          : typeof item.agentId === "string" && item.agentId !== ""
            ? item.agentId
            : "";

      if (phase === "streaming") {
        const existing = findMatchingEntry(item, trimmed, "streaming", scope);
        if (existing) {
          if (trimmed.length > existing.prefix.length && existing.prefix.length < PREFIX_MATCH_LEN) {
            existing.prefix = trimmed.slice(0, PREFIX_MATCH_LEN);
          }
          existing.completed = false;
          unmarkEvicted(existing.key);
          touch(existing);
          return { transform: true, bloomKey: existing.key };
        }
        const key = item.messageId
          ? `id:${item.messageId}`
          : scope !== ""
            ? `txt:${scope}:${++seq}`
            : `txt:${++seq}`;
        unmarkEvicted(key);
        const entry: TrackedBloomEntry = {
          key,
          scope,
          prefix: trimmed.slice(0, PREFIX_MATCH_LEN),
          completed: false,
        };
        tracked.set(key, entry);
        pruneOverflow();
        return { transform: true, bloomKey: key };
      }

      // phase === "complete"
      const match = findMatchingEntry(item, trimmed, "complete", scope);
      if (!match) return { transform: false };
      match.completed = true;
      if (trimmed.length > match.prefix.length && match.prefix.length < PREFIX_MATCH_LEN) {
        match.prefix = trimmed.slice(0, PREFIX_MATCH_LEN);
      }
      touch(match);
      return { transform: true, bloomKey: match.key };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const key of tracked.keys()) {
        markEvicted(key);
      }
      tracked.clear();
    },
  };
}
