/**
 * Zero-dependency client bridge & per-agent cache for Antigravity `run_command`
 * `toolSummary` lookup (`antigravity.tool_summaries` RPC).
 *
 * Kept free of `@getpaseo/plugin`, `zod`, and `@tanstack/react-query` so
 * `client/tool-call.tsx` keeps running under `harness/tool-call-check.cjs`'s
 * minimal React stub without requiring `react.createContext`.
 *
 * @module dsh-paseo/client/antigravity/tool-summaries
 */
import { useEffect, useRef, useState } from "react";

export interface AntigravityToolSummaries {
  byCommand: Record<string, string>;
  prefixes: Array<{ prefix: string; summary: string }>;
}

export type AntigravityToolSummariesReader = (agentId: string) => Promise<AntigravityToolSummaries>;

interface AgentCacheEntry {
  data: AntigravityToolSummaries | null;
  fetchedAt: number;
  inflight: Promise<void> | null;
  listeners: Set<() => void>;
  runningWatchers: number;
  pollTimer: ReturnType<typeof setInterval> | null;
}

const STALE_MS = 1_500;
const RUNNING_POLL_MS = 1_500;
const SETTLED_RETRY_MS = 1_500;
const MAX_AGENT_ENTRIES = 40;

let activeReader: AntigravityToolSummariesReader | null = null;
const readerListeners = new Set<() => void>();
const agentCache = new Map<string, AgentCacheEntry>();

function notifyReaderListeners(): void {
  for (const listener of Array.from(readerListeners)) listener();
}

function clearAgentCache(): void {
  for (const entry of agentCache.values()) {
    if (entry.pollTimer !== null) {
      clearInterval(entry.pollTimer);
      entry.pollTimer = null;
    }
    entry.runningWatchers = 0;
  }
  agentCache.clear();
}

export function registerAntigravityToolSummariesReader(reader: AntigravityToolSummariesReader): () => void {
  activeReader = reader;
  notifyReaderListeners();
  return () => {
    if (activeReader === reader) {
      activeReader = null;
      clearAgentCache();
      notifyReaderListeners();
    }
  };
}

function getEntry(agentId: string): AgentCacheEntry {
  let entry = agentCache.get(agentId);
  if (entry) {
    // Refresh LRU recency so active agents stay at the tail.
    agentCache.delete(agentId);
    agentCache.set(agentId, entry);
    return entry;
  }
  entry = {
    data: null,
    fetchedAt: 0,
    inflight: null,
    listeners: new Set(),
    runningWatchers: 0,
    pollTimer: null,
  };
  agentCache.set(agentId, entry);
  if (agentCache.size > MAX_AGENT_ENTRIES) {
    for (const [candidateId, candidate] of agentCache) {
      if (agentCache.size <= MAX_AGENT_ENTRIES) break;
      if (candidateId === agentId) continue;
      if (candidate.listeners.size > 0 || candidate.runningWatchers > 0) continue;
      if (candidate.pollTimer !== null) {
        clearInterval(candidate.pollTimer);
        candidate.pollTimer = null;
      }
      agentCache.delete(candidateId);
    }
  }
  return entry;
}

function fetchSummaries(agentId: string, force = false): void {
  const reader = activeReader;
  if (!reader) return;
  const entry = getEntry(agentId);
  if (entry.inflight) return;
  if (!force && entry.fetchedAt > 0 && Date.now() - entry.fetchedAt < STALE_MS) return;

  entry.inflight = reader(agentId)
    .then((data) => {
      if (activeReader !== reader) return;
      entry.data = data;
      entry.fetchedAt = Date.now();
      for (const listener of Array.from(entry.listeners)) listener();
    })
    .catch(() => {
      if (activeReader !== reader) return;
      entry.fetchedAt = Date.now();
    })
    .finally(() => {
      entry.inflight = null;
    });
}

function retainRunningPoll(agentId: string): () => void {
  const entry = getEntry(agentId);
  entry.runningWatchers += 1;
  if (entry.pollTimer === null) {
    entry.pollTimer = setInterval(() => fetchSummaries(agentId, false), RUNNING_POLL_MS);
  }
  return () => {
    entry.runningWatchers = Math.max(0, entry.runningWatchers - 1);
    if (entry.runningWatchers === 0 && entry.pollTimer !== null) {
      clearInterval(entry.pollTimer);
      entry.pollTimer = null;
    }
  };
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function matchSummary(summaries: AntigravityToolSummaries | null, command: string): string {
  if (!summaries) return "";
  const norm = normalizeCommand(command);
  if (!norm) return "";
  if (Object.prototype.hasOwnProperty.call(summaries.byCommand, norm)) {
    return summaries.byCommand[norm] ?? "";
  }
  let best = "";
  let bestLen = 0;
  for (const item of summaries.prefixes) {
    const p = item.prefix;
    if (p.length < 16) continue;
    if ((norm.startsWith(p) || p.startsWith(norm)) && p.length >= bestLen) {
      best = item.summary;
      bestLen = p.length;
    }
  }
  return best;
}

/**
 * Returns the model-written `toolSummary` for an Antigravity `run_command` row,
 * sharing one per-agent RPC fetch across every row in the session.
 * Returns `""` immediately when `enabled` is false or no live reader is registered.
 */
export function useAntigravityCommandSummary(
  agentId: string | undefined,
  command: string,
  status: string,
  rowKey: string,
  enabled: boolean,
): string {
  const eligible = enabled && typeof agentId === "string" && agentId !== "" && command !== "";
  const active = eligible && activeReader !== null;
  const [, setTick] = useState(0);
  const fetchedPhaseRef = useRef<string | null>(null);
  const retriedPhaseRef = useRef<string | null>(null);

  const cachedData = active ? (agentCache.get(agentId)?.data ?? null) : null;
  const summary = active ? matchSummary(cachedData, command) : "";

  useEffect(() => {
    if (!eligible) return undefined;
    const onReaderChange = () => setTick((n) => n + 1);
    readerListeners.add(onReaderChange);
    return () => {
      readerListeners.delete(onReaderChange);
    };
  }, [eligible]);

  useEffect(() => {
    if (!active) return undefined;
    const entry = getEntry(agentId);
    const onUpdate = () => setTick((n) => n + 1);
    entry.listeners.add(onUpdate);
    return () => {
      entry.listeners.delete(onUpdate);
    };
  }, [active, agentId]);

  useEffect(() => {
    if (!active) {
      fetchedPhaseRef.current = null;
      retriedPhaseRef.current = null;
      return undefined;
    }
    if (summary !== "") return undefined;
    const phaseKey = `${rowKey}:${status}`;
    if (fetchedPhaseRef.current !== phaseKey) {
      fetchedPhaseRef.current = phaseKey;
      fetchSummaries(agentId, false);
    }
    if (status === "running") {
      return retainRunningPoll(agentId);
    }
    if (retriedPhaseRef.current !== phaseKey) {
      retriedPhaseRef.current = phaseKey;
      const timer = setTimeout(() => fetchSummaries(agentId, false), SETTLED_RETRY_MS);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [active, agentId, command, status, rowKey, summary]);

  return summary;
}
