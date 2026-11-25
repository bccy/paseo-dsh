/**
 * Ref-counted client subscription store for live `subagent` / `subagent_fork`
 * timeline card updates.
 *
 * Design invariants:
 * - **Zero polling**: receives server-pushed deltas over `subagentLiveSnapshot`
 *   only while at least one mounted `<SubagentCard>` for `agentId` is still
 *   `"running"`.
 * - **Shared per agent**: N running subagent cards in the same session share
 *   one host subscription; releasing the last running card aborts it immediately.
 * - **Scroll-safe cache**: settled cards remain cached in a bounded LRU map
 *   (`MAX_CACHED_AGENTS`) so virtualized timeline rows that scroll off-screen
 *   and remount keep their settled status/report/metrics instead of reverting
 *   to the initial `"running"` snapshot.
 * - **Graceful offline/0.16 fallback**: returns `initial` untouched when no
 *   client is bound or `client.subscribe` is unavailable.
 *
 * @module dsh-paseo/client/subagent-live
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useSyncExternalStore } from "react";
import type { DshSubagentMetadata } from "../shared/subagent-card";
import { subagentLiveSnapshot, type SubagentLiveEvent } from "../shared/subagent-live";
import type { SubagentCardData } from "./tool-call-data";

const MAX_CACHED_AGENTS = 32;
const MAX_CACHED_CARDS_PER_AGENT = 128;

interface AgentLiveEntry {
  readonly agentId: string;
  readonly cards: Map<string, SubagentCardData>;
  refs: number;
  controller: AbortController | null;
}

let boundClient: PluginClientContext | null = null;
let storeRevision = 0;
const entries = new Map<string, AgentLiveEntry>();
const listeners = new Set<() => void>();

function notify(): void {
  storeRevision += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* isolate React subscriber errors */
    }
  }
}

function getOrCreateEntry(agentId: string): AgentLiveEntry {
  const existing = entries.get(agentId);
  if (existing !== undefined) {
    // Refresh insertion order for LRU eviction.
    entries.delete(agentId);
    entries.set(agentId, existing);
    return existing;
  }
  const created: AgentLiveEntry = {
    agentId,
    cards: new Map(),
    refs: 0,
    controller: null,
  };
  entries.set(agentId, created);
  if (entries.size > MAX_CACHED_AGENTS) {
    for (const [key, candidate] of entries) {
      if (candidate.refs === 0 && candidate.controller === null) {
        entries.delete(key);
        if (entries.size <= MAX_CACHED_AGENTS) break;
      }
    }
  }
  return created;
}

function stopSubscription(entry: AgentLiveEntry): void {
  const controller = entry.controller;
  if (controller === null) return;
  entry.controller = null;
  controller.abort();
}

function applyIncomingCards(entry: AgentLiveEntry, event: SubagentLiveEvent): void {
  let changed = false;
  for (const [callId, raw] of Object.entries(event.cards)) {
    if (callId === "") continue;
    const next: SubagentCardData = { ...(raw as DshSubagentMetadata) };
    const prev = entry.cards.get(callId);
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(next)) continue;
    entry.cards.set(callId, next);
    if (entry.cards.size > MAX_CACHED_CARDS_PER_AGENT) {
      const oldest = entry.cards.keys().next().value;
      if (oldest !== undefined) entry.cards.delete(oldest);
    }
    changed = true;
  }
  if (changed) notify();
}

function startSubscription(entry: AgentLiveEntry): void {
  if (entry.controller !== null || entry.refs <= 0) return;
  const client = boundClient;
  if (client === null || typeof client.subscribe !== "function") return;
  const controller = new AbortController();
  entry.controller = controller;
  try {
    const handle = client.subscribe(
      subagentLiveSnapshot,
      { agentId: entry.agentId },
      (event) => {
        if (controller.signal.aborted || entry.controller !== controller) return;
        applyIncomingCards(entry, event);
      },
      {
        signal: controller.signal,
        onClosed: () => {
          if (entry.controller === controller) {
            entry.controller = null;
          }
        },
      },
    );
    void handle.ready.catch(() => {
      if (entry.controller === controller) {
        entry.controller = null;
      }
    });
  } catch {
    if (entry.controller === controller) {
      entry.controller = null;
    }
  }
}

function retain(agentId: string): () => void {
  const entry = getOrCreateEntry(agentId);
  entry.refs += 1;
  startSubscription(entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      stopSubscription(entry);
    }
  };
}

/**
 * Bind the plugin client context once during `index.client.tsx` startup.
 * Returns a cleanup function that closes every active live subscription.
 */
export function bindSubagentLiveClient(client: PluginClientContext): () => void {
  boundClient = client;
  for (const entry of entries.values()) {
    if (entry.refs > 0) startSubscription(entry);
  }
  return () => {
    if (boundClient === client) boundClient = null;
    for (const entry of entries.values()) {
      stopSubscription(entry);
    }
    entries.clear();
  };
}

/** Clear cached live cards and subscriptions (for deterministic offline tests). */
export function resetSubagentLiveStoreForTests(): void {
  boundClient = null;
  for (const entry of entries.values()) {
    stopSubscription(entry);
  }
  entries.clear();
  storeRevision = 0;
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getRevision(): number {
  return storeRevision;
}

/**
 * Subscribe to live server updates for a single `subagent` / `subagent_fork`
 * timeline card while it is `"running"`, merging settled status, report, and
 * observed metrics in place without duplicating the timeline row.
 */
export function useLiveSubagentCard(
  agentId: string | undefined,
  callId: string | undefined,
  initial: SubagentCardData,
): SubagentCardData {
  // Re-render when the store receives a new card snapshot.
  useSyncExternalStore(subscribeStore, getRevision, getRevision);

  const normalizedAgentId = typeof agentId === "string" && agentId !== "" ? agentId : undefined;
  const normalizedCallId = typeof callId === "string" && callId !== "" ? callId : undefined;
  const cached =
    normalizedAgentId !== undefined && normalizedCallId !== undefined
      ? entries.get(normalizedAgentId)?.cards.get(normalizedCallId)
      : undefined;

  // Prefer the cached live snapshot whenever the timeline item's own snapshot
  // is still `"running"` (the exact live cross-turn case where Paseo's frozen
  // Turn-1 row cannot be merged across turns). Once `initial` itself is already
  // settled (e.g. replayed or same-turn settled), `initial` is authoritative.
  const effective: SubagentCardData =
    cached !== undefined && initial.status === "running"
      ? {
          ...initial,
          ...cached,
          // Never erase task/title/role that were already present on `initial`.
          ...(cached.role === undefined && initial.role !== undefined ? { role: initial.role } : {}),
          ...(cached.title === undefined && initial.title !== undefined ? { title: initial.title } : {}),
          ...(cached.task === undefined && initial.task !== undefined ? { task: initial.task } : {}),
        }
      : initial;

  const needsLive =
    normalizedAgentId !== undefined &&
    normalizedCallId !== undefined &&
    effective.status === "running";

  useEffect(() => {
    if (!needsLive || normalizedAgentId === undefined) return;
    return retain(normalizedAgentId);
  }, [needsLive, normalizedAgentId]);

  return effective;
}
