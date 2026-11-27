/**
 * Pure archive state model for Antigravity subagents and swarm workers.
 *
 * Archiving is non-destructive: on-disk Antigravity brain logs and transcripts
 * stay untouched so historical timeline cards, full-view reports, and usage
 * accounting remain intact. Only finished (`state !== "running"`) subagents can
 * be hidden from the active list and composer pill; a running worker always
 * stays visible even if its id was archived before it revived.
 *
 * Kept strictly React/RN-free so both client UI and offline unit tests can use
 * it directly.
 *
 * @module dsh-paseo/client/antigravity/subagentsArchive
 */
import { SUBAGENTS_ARCHIVED_METADATA_KEY } from "../../shared/pill-metadata";

export const MAX_ARCHIVED_SUBAGENT_IDS = 200;

const EMPTY_SET: ReadonlySet<string> = new Set();

function normalizeId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes(",")) return null;
  return trimmed;
}

export function rawArchivedSubagentsFromMetadata(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): string {
  if (!metadata) return "";
  const value = metadata[SUBAGENTS_ARCHIVED_METADATA_KEY];
  return typeof value === "string" ? value : "";
}

export function parseArchivedSubagents(raw: string): ReadonlySet<string> {
  if (!raw) return EMPTY_SET;
  const parsed = new Set<string>();
  for (const part of raw.split(",")) {
    const id = normalizeId(part);
    if (id) parsed.add(id);
  }
  return parsed.size > 0 ? parsed : EMPTY_SET;
}

export function archivedSubagentsFromMetadata(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): ReadonlySet<string> {
  return parseArchivedSubagents(rawArchivedSubagentsFromMetadata(metadata));
}

export function serializeArchivedSubagents(ids: Iterable<string>): string {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = normalizeId(raw);
    if (!id) continue;
    if (seen.has(id)) {
      const idx = ordered.indexOf(id);
      if (idx >= 0) ordered.splice(idx, 1);
    }
    seen.add(id);
    ordered.push(id);
  }
  const bounded =
    ordered.length > MAX_ARCHIVED_SUBAGENT_IDS
      ? ordered.slice(ordered.length - MAX_ARCHIVED_SUBAGENT_IDS)
      : ordered;
  return bounded.join(",");
}

export function archiveSubagentIds(
  existing: ReadonlySet<string>,
  toArchive: Iterable<string>,
): string {
  const merged: string[] = [...existing];
  for (const raw of toArchive) {
    const id = normalizeId(raw);
    if (id) merged.push(id);
  }
  return serializeArchivedSubagents(merged);
}

export function unarchiveSubagentId(
  existing: ReadonlySet<string>,
  id: string,
): string {
  const target = normalizeId(id);
  if (!target || !existing.has(target)) return serializeArchivedSubagents(existing);
  const next: string[] = [];
  for (const item of existing) {
    if (item !== target) next.push(item);
  }
  return serializeArchivedSubagents(next);
}

/**
 * Running subagents/swarm workers are never treated as archived so active work
 * can never be hidden by stale archive state (e.g. a revived swarm worker).
 */
export function isSubagentArchived(
  subagent: { readonly id: string; readonly state: string },
  archived: ReadonlySet<string>,
): boolean {
  if (subagent.state === "running") return false;
  return archived.has(subagent.id);
}

export interface PartitionedSubagents<T extends { readonly id: string; readonly state: string }> {
  readonly active: T[];
  readonly archivedList: T[];
  readonly live: T[];
  readonly settled: T[];
}

export function partitionSubagents<T extends { readonly id: string; readonly state: string }>(
  subagents: readonly T[],
  archived: ReadonlySet<string>,
): PartitionedSubagents<T> {
  const active: T[] = [];
  const archivedList: T[] = [];
  const live: T[] = [];
  const settled: T[] = [];
  for (const subagent of subagents) {
    if (isSubagentArchived(subagent, archived)) {
      archivedList.push(subagent);
      continue;
    }
    active.push(subagent);
    if (subagent.state === "running") live.push(subagent);
    else settled.push(subagent);
  }
  return { active, archivedList, live, settled };
}

export interface RawSubagentCount {
  readonly total: number;
  readonly running: number;
  readonly failed: number;
  readonly settledIds?: readonly string[];
  readonly failedIds?: readonly string[];
}

export interface EffectiveSubagentCount {
  readonly total: number;
  readonly running: number;
  readonly failed: number;
}

export function effectiveSubagentCount(
  count: RawSubagentCount | undefined,
  archived: ReadonlySet<string>,
): EffectiveSubagentCount {
  if (!count) return { total: 0, running: 0, failed: 0 };
  if (!count.settledIds) {
    return { total: count.total, running: count.running, failed: count.failed };
  }
  let visibleSettled = 0;
  for (const id of count.settledIds) {
    if (!archived.has(id)) visibleSettled += 1;
  }
  let visibleFailed = 0;
  if (count.failedIds) {
    for (const id of count.failedIds) {
      if (!archived.has(id)) visibleFailed += 1;
    }
  } else {
    visibleFailed = Math.min(count.failed, visibleSettled);
  }
  return {
    total: count.running + visibleSettled,
    running: count.running,
    failed: visibleFailed,
  };
}

export interface SubagentsArchivePersistence {
  write(agentId: string, raw: string): Promise<unknown>;
  onError?(message: string, error: unknown): void;
}

export interface SubagentsArchiveStore {
  get(agentId: string): ReadonlySet<string>;
  observe(agentId: string, metadata: Readonly<Record<string, unknown>> | null | undefined): boolean;
  archive(agentId: string, ids: Iterable<string>): string;
  unarchive(agentId: string, id: string): string;
  deleteAgent(agentId: string): void;
  subscribe(listener: () => void): () => void;
}

export function createSubagentsArchiveStore(
  persistence?: SubagentsArchivePersistence,
): SubagentsArchiveStore {
  const current = new Map<string, ReadonlySet<string>>();
  const lastRemote = new Map<string, string>();
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) listener();
  }

  function persist(agentId: string, nextRaw: string) {
    if (!persistence) return;
    void Promise.resolve()
      .then(() => persistence.write(agentId, nextRaw))
      .catch((error: unknown) => {
        persistence.onError?.(`failed to persist archived subagents for ${agentId}`, error);
      });
  }

  return {
    get(agentId) {
      return current.get(agentId) ?? EMPTY_SET;
    },
    observe(agentId, metadata) {
      const remoteRaw = rawArchivedSubagentsFromMetadata(metadata);
      if (lastRemote.get(agentId) === remoteRaw) return false;
      lastRemote.set(agentId, remoteRaw);
      const nextSet = parseArchivedSubagents(remoteRaw);
      const prevSet = current.get(agentId) ?? EMPTY_SET;
      if (
        prevSet.size === nextSet.size &&
        [...prevSet].every((id) => nextSet.has(id))
      ) {
        return false;
      }
      if (nextSet.size > 0) current.set(agentId, nextSet);
      else current.delete(agentId);
      emit();
      return true;
    },
    archive(agentId, ids) {
      const prev = current.get(agentId) ?? EMPTY_SET;
      const nextRaw = archiveSubagentIds(prev, ids);
      const prevRaw = serializeArchivedSubagents(prev);
      if (nextRaw === prevRaw) return nextRaw;
      const nextSet = parseArchivedSubagents(nextRaw);
      if (nextSet.size > 0) current.set(agentId, nextSet);
      else current.delete(agentId);
      emit();
      persist(agentId, nextRaw);
      return nextRaw;
    },
    unarchive(agentId, id) {
      const prev = current.get(agentId) ?? EMPTY_SET;
      const nextRaw = unarchiveSubagentId(prev, id);
      const prevRaw = serializeArchivedSubagents(prev);
      if (nextRaw === prevRaw) return nextRaw;
      const nextSet = parseArchivedSubagents(nextRaw);
      if (nextSet.size > 0) current.set(agentId, nextSet);
      else current.delete(agentId);
      emit();
      persist(agentId, nextRaw);
      return nextRaw;
    },
    deleteAgent(agentId) {
      const had = current.delete(agentId);
      lastRemote.delete(agentId);
      if (had) emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
