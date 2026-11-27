import type { StepEntry, StepStatus } from "../../shared/antigravity/contracts";

const MAX_CALLS_PER_AGENT = 64;
const VALID_STATUSES = new Set<StepStatus>(["pending", "in_progress", "done", "skipped", "failed"]);

export type StepsPillIconState = "running" | "failed" | "complete" | "idle";

export interface StepsSummary {
  readonly total: number;
  readonly done: number;
  readonly inProgress: readonly StepEntry[];
  readonly skipped: number;
  readonly failed: number;
  readonly pending: number;
  readonly settled: number;
  readonly allDone: boolean;
  readonly pillState: StepsPillIconState;
  readonly progressFraction: number;
}

export interface StepsWindow {
  readonly earlier: number;
  readonly slice: readonly StepEntry[];
  readonly more: number;
}

export interface AgentStepsSnapshot {
  readonly callId: string;
  readonly steps: readonly StepEntry[];
  readonly timestampMs: number;
  readonly seq?: number;
}

export interface TimelineStepsObservation {
  readonly callId: string;
  readonly steps: readonly StepEntry[];
  readonly timestampMs: number;
  readonly seq?: number;
}

function normalizeStepStatus(raw: unknown): StepStatus {
  if (typeof raw !== "string") return "pending";
  const value = raw.trim().toLowerCase();
  if (value === "completed") return "done";
  if (VALID_STATUSES.has(value as StepStatus)) return value as StepStatus;
  return "pending";
}

/**
 * Parses Antigravity's `update_steps` tool input (`{ steps: [{ title, status }] }`).
 * Returns `null` when the payload does not carry a non-empty checklist.
 */
export function parseUpdateSteps(input: unknown): StepEntry[] | null {
  if (!input || typeof input !== "object") return null;
  const record = input as { steps?: unknown };
  if (!Array.isArray(record.steps) || record.steps.length === 0) return null;
  const parsed: StepEntry[] = [];
  for (const raw of record.steps) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { title?: unknown; text?: unknown; label?: unknown; status?: unknown };
    const rawTitle =
      typeof entry.title === "string"
        ? entry.title
        : typeof entry.text === "string"
          ? entry.text
          : typeof entry.label === "string"
            ? entry.label
            : "";
    const title = rawTitle.trim();
    if (!title) continue;
    parsed.push({
      title,
      status: normalizeStepStatus(entry.status),
    });
  }
  return parsed.length > 0 ? parsed : null;
}

/** Summarizes counts, completion state, pill icon tone, and progress bar fill. */
export function summarizeSteps(steps: readonly StepEntry[]): StepsSummary {
  const total = steps.length;
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let pending = 0;
  const inProgress: StepEntry[] = [];
  for (const step of steps) {
    switch (step.status) {
      case "done":
        done += 1;
        break;
      case "in_progress":
        inProgress.push(step);
        break;
      case "skipped":
        skipped += 1;
        break;
      case "failed":
        failed += 1;
        break;
      default:
        pending += 1;
        break;
    }
  }
  const settled = done + skipped;
  const allDone = total > 0 && failed === 0 && inProgress.length === 0 && settled === total;
  const pillState: StepsPillIconState =
    failed > 0 ? "failed" : inProgress.length > 0 ? "running" : allDone ? "complete" : "idle";
  const progressFraction = total > 0 ? settled / total : 0;
  return {
    total,
    done,
    inProgress,
    skipped,
    failed,
    pending,
    settled,
    allDone,
    pillState,
    progressFraction,
  };
}

/**
 * Computes a focused visible slice of at most `maxVisible` steps (default 7, matching
 * Antigravity CLI) centered around the first active or failed task.
 */
export function windowSteps(steps: readonly StepEntry[], maxVisible = 7): StepsWindow {
  if (steps.length <= maxVisible) {
    return { earlier: 0, slice: steps, more: 0 };
  }
  const firstFocus = steps.findIndex((step) => step.status === "in_progress" || step.status === "failed");
  const pivot = firstFocus >= 0 ? firstFocus : steps.length - 1;
  let start = Math.max(0, pivot - 2);
  if (start + maxVisible > steps.length) start = steps.length - maxVisible;
  const end = start + maxVisible;
  return {
    earlier: start,
    slice: steps.slice(start, end),
    more: steps.length - end,
  };
}

/**
 * Durable signature for an all-done task list, used by the "seen" auto-hide gate.
 * Returns `undefined` when any task is still pending, running, or failed.
 */
export function stepsAllDoneSignature(steps: readonly StepEntry[]): string | undefined {
  if (!summarizeSteps(steps).allDone) return undefined;
  return steps.map((step) => `${step.status}:${step.title}`).join("\n");
}

/**
 * Extracts `update_steps` tool calls from Paseo's `agent.timeline.refetch()` entries.
 * Carries each entry's authoritative daemon `seq` and parsed `timestampMs`.
 */
export function extractStepsFromTimelineEntries(entries: readonly unknown[]): TimelineStepsObservation[] {
  const results: TimelineStepsObservation[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as {
      seq?: unknown;
      timestamp?: unknown;
      item?: unknown;
    };
    const item = entry.item;
    if (!item || typeof item !== "object") continue;
    const tool = item as {
      type?: unknown;
      name?: unknown;
      callId?: unknown;
      detail?: unknown;
    };
    if (tool.type !== "tool_call" || tool.name !== "update_steps") continue;
    if (typeof tool.callId !== "string" || !tool.callId) continue;
    const detail = tool.detail;
    if (!detail || typeof detail !== "object") continue;
    const unknownDetail = detail as { type?: unknown; input?: unknown };
    if (unknownDetail.type !== "unknown") continue;
    const steps = parseUpdateSteps(unknownDetail.input);
    if (!steps) continue;
    const seq = typeof entry.seq === "number" && Number.isFinite(entry.seq) ? entry.seq : undefined;
    const parsedTs =
      typeof entry.timestamp === "string"
        ? Date.parse(entry.timestamp)
        : entry.timestamp instanceof Date
          ? entry.timestamp.getTime()
          : 0;
    const timestampMs = Number.isFinite(parsedTs) ? parsedTs : 0;
    results.push({ callId: tool.callId, steps, timestampMs, seq });
  }
  return results;
}

function stepsEqual(a: readonly StepEntry[], b: readonly StepEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.status !== b[i]!.status || a[i]!.title !== b[i]!.title) return false;
  }
  return true;
}

interface StoredCall {
  readonly callId: string;
  readonly steps: readonly StepEntry[];
  readonly timestampMs: number;
  readonly seq?: number;
  readonly order: number;
}

function isNewerCall(candidate: StoredCall, current: StoredCall): boolean {
  if (candidate.seq !== undefined && current.seq !== undefined && candidate.seq !== current.seq) {
    return candidate.seq > current.seq;
  }
  if (candidate.timestampMs !== current.timestampMs) {
    return candidate.timestampMs > current.timestampMs;
  }
  if (candidate.seq !== undefined && current.seq === undefined) return true;
  if (candidate.seq === undefined && current.seq !== undefined) return false;
  return candidate.order > current.order;
}

export interface StepsStore {
  /** Records an `update_steps` call for `agentId`, keeping the chronologically newest snapshot. */
  observe(agentId: string, callId: string, steps: readonly StepEntry[], timestampMs: number, seq?: number): void;
  /** Returns the latest known snapshot for `agentId`, or `null` if none has been observed. */
  getLatest(agentId: string): AgentStepsSnapshot | null;
  /** True when `callId` is the latest observed `update_steps` call for `agentId`. */
  isLatestCall(agentId: string, callId: string): boolean;
  /** Removes all cached calls for an archived/removed agent. */
  deleteAgent(agentId: string): void;
  /** Subscribes to changes in any agent's latest snapshot. */
  subscribe(listener: (agentId: string) => void): () => void;
  /** Clears all agents and listeners. */
  clear(): void;
}

/**
 * Per-agent `update_steps` store keyed by `(agentId, callId)` and ordered by daemon `seq`
 * (when available) and `timestampMs`.
 *
 * Ordering by daemon `seq` / timestamp makes the composer pill immune to virtualized
 * scroll-up remounts and collapsed turns: remounting an older `update_steps` row never
 * overwrites a newer snapshot, while a live update or timeline hydration publishes immediately.
 */
export function createStepsStore(): StepsStore {
  const byAgent = new Map<string, Map<string, StoredCall>>();
  const latestByAgent = new Map<string, AgentStepsSnapshot>();
  const listeners = new Set<(agentId: string) => void>();
  let nextOrder = 1;

  function emit(agentId: string) {
    for (const listener of [...listeners]) {
      try {
        listener(agentId);
      } catch {
        /* one listener failure must not block others */
      }
    }
  }

  function recomputeLatest(agentId: string, calls: Map<string, StoredCall>): AgentStepsSnapshot | null {
    let winner: StoredCall | null = null;
    for (const entry of calls.values()) {
      if (!winner || isNewerCall(entry, winner)) {
        winner = entry;
      }
    }
    if (!winner) {
      latestByAgent.delete(agentId);
      return null;
    }
    const prev = latestByAgent.get(agentId);
    if (
      prev &&
      prev.callId === winner.callId &&
      prev.timestampMs === winner.timestampMs &&
      prev.seq === winner.seq &&
      stepsEqual(prev.steps, winner.steps)
    ) {
      return prev;
    }
    const next: AgentStepsSnapshot = {
      callId: winner.callId,
      steps: winner.steps,
      timestampMs: winner.timestampMs,
      ...(winner.seq !== undefined ? { seq: winner.seq } : {}),
    };
    latestByAgent.set(agentId, next);
    return next;
  }

  function observe(
    agentId: string,
    callId: string,
    steps: readonly StepEntry[],
    timestampMs: number,
    seq?: number,
  ) {
    if (!agentId || !callId || steps.length === 0) return;
    const safeTs = Number.isFinite(timestampMs) ? timestampMs : 0;
    const safeSeq = typeof seq === "number" && Number.isFinite(seq) ? seq : undefined;
    let calls = byAgent.get(agentId);
    if (!calls) {
      calls = new Map();
      byAgent.set(agentId, calls);
    }
    const existing = calls.get(callId);
    const mergedSeq = safeSeq ?? existing?.seq;
    const mergedTs = safeTs > 0 ? safeTs : (existing?.timestampMs ?? 0);
    if (
      existing &&
      existing.timestampMs === mergedTs &&
      existing.seq === mergedSeq &&
      stepsEqual(existing.steps, steps)
    ) {
      return;
    }
    calls.set(callId, {
      callId,
      steps: steps.map((step) => ({ title: step.title, status: step.status })),
      timestampMs: mergedTs,
      ...(mergedSeq !== undefined ? { seq: mergedSeq } : {}),
      order: existing ? existing.order : nextOrder++,
    });
    if (calls.size > MAX_CALLS_PER_AGENT) {
      let oldestKey: string | null = null;
      let oldestEntry: StoredCall | null = null;
      for (const [key, entry] of calls) {
        if (!oldestEntry || isNewerCall(oldestEntry, entry)) {
          oldestKey = key;
          oldestEntry = entry;
        }
      }
      if (oldestKey) calls.delete(oldestKey);
    }
    const prev = latestByAgent.get(agentId);
    const next = recomputeLatest(agentId, calls);
    if (next !== prev) emit(agentId);
  }

  return {
    observe,
    getLatest(agentId) {
      return latestByAgent.get(agentId) ?? null;
    },
    isLatestCall(agentId, callId) {
      const latest = latestByAgent.get(agentId);
      return latest ? latest.callId === callId : false;
    },
    deleteAgent(agentId) {
      const had = byAgent.delete(agentId) || latestByAgent.delete(agentId);
      if (had) emit(agentId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      byAgent.clear();
      latestByAgent.clear();
      listeners.clear();
    },
  };
}
