/**
 * Which timeline row is the newest one, and whether it should still pulse.
 *
 * A plugin timeline renderer only receives its own item — `theme`, `host`,
 * `layout`, `agentId`, `item`, `timestamp` — so it cannot see its position in
 * the list. Position is what the pulse needs, though: a short command's
 * `tool/call` and `tool/result` reach the client in the same tick, so
 * `status === "running"` is never observable for it and a status-driven pulse
 * never runs. The plugin's server cannot supply the position either: a
 * re-emitted item whose only change is provider `metadata` is not folded back
 * in by the client, so a `metadata.current` marker survives forever instead of
 * clearing (measured: a dozen rows stuck `current`).
 *
 * Three facts shape the implementation:
 *
 * - **`timestamp` is not the item's own time.** Paseo's projection merges a
 *   tool call and stamps the merged row with the *last* snapshot's time, and the
 *   plugin emits no timestamp at all, so the daemon fills in the record time.
 *   A replayed history therefore arrives stamped "now", exactly like live
 *   activity. Nothing time-based can tell the two apart, so this module
 *   separates them by *commit burst* instead (see `BULK_*`).
 * - **Rendering is not committing.** A concurrent render can be discarded, so
 *   "when did this client first see the row" is recorded in an effect, after
 *   commit. Recording it during render would let a discarded render consume the
 *   window and leave the row that finally commits looking stale — the exact
 *   silent "short commands never pulse" failure this module exists to fix.
 * - **A first render has nothing to compare against.** The running maximum
 *   starts empty, so the first row of a burst would otherwise look newest and
 *   every row would pulse for a frame: the "whole screen blinks" complaint.
 *   With no prior value, no row claims the position.
 *
 * @module dsh-paseo/client/newest
 */
import { useEffect, useState } from "react";

/** How long the newest row keeps pulsing after it commits. */
export const PULSE_MS = 6000;
/**
 * Rows committing faster than this are a batch, not live activity. Replaying a
 * session emits its whole history in a burst; a human issuing two commands does
 * not.
 */
export const BULK_WINDOW_MS = 400;
/** A batch this large is a history load, and none of it should pulse. */
export const BULK_MIN_ROWS = 5;

interface AgentRows {
  /** Newest item timestamp seen so far, a running maximum. */
  at: number;
  /** Commit order of the row that committed last. */
  seq: number;
  /** When that row committed, on this client's clock. */
  seenAt: number;
  /** Recent commit times, used to recognise a batch. */
  recent: number[];
}

const rows = new Map<string, AgentRows>();
/** Running maxima seen during the current render pass, folded in afterwards. */
const pending = new Map<string, number>();
let flushScheduled = false;
let seqCounter = 0;
/**
 * Agents are few, but the map is keyed by an id that outlives a session, so it
 * is capped rather than trusted to stay small. Insertion order is first-seen
 * order, because an existing entry is never re-set.
 */
const MAX_AGENTS = 200;

export interface Commit {
  seq: number;
  seenAt: number;
  /** This commit was part of a batch, so it must not pulse. */
  bulk: boolean;
}

export interface RowPulse {
  /** This row is the newest one rendered for its agent. */
  newest: boolean;
  /** It committed recently, as the last row, outside a batch. */
  fresh: boolean;
}

function atOf(timestamp: Date | string | number): number {
  const at = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  return Number.isFinite(at) ? at : 0;
}

function stateOf(agentId: string): AgentRows {
  const existing = rows.get(agentId);
  if (existing !== undefined) return existing;
  if (rows.size >= MAX_AGENTS) {
    const oldest = rows.keys().next().value;
    if (oldest !== undefined) rows.delete(oldest);
  }
  const created: AgentRows = { at: 0, seq: 0, seenAt: 0, recent: [] };
  rows.set(agentId, created);
  return created;
}

/** Fold this render pass's maxima into the state the next pass will read. */
function flush(): void {
  flushScheduled = false;
  for (const [agentId, at] of pending) {
    const state = stateOf(agentId);
    if (at > state.at) state.at = at;
  }
  pending.clear();
}

/**
 * Render-time half: is this row the newest one known so far?
 *
 * Two rules keep a render pass from lighting up the whole list:
 *
 * - The running maximum is only folded in *after* the pass, from a microtask.
 *   Updating it as each row renders would let row 2 see row 1's value, so every
 *   row of a replayed history would answer "yes" and the whole list would blink
 *   for a frame.
 * - A row with no prior value claims nothing. On the very first pass nothing has
 *   been seen yet, so nothing is newest.
 *
 * Both updates are idempotent running maxima, so a discarded concurrent render
 * cannot corrupt them — unlike `seenAt`, which is why that one lives in an effect.
 */
export function noteRender(agentId: string, at: number): boolean {
  const known = rows.get(agentId)?.at;
  const newest = known !== undefined && at >= known;
  const queued = pending.get(agentId);
  if (queued === undefined || at > queued) pending.set(agentId, at);
  if (!flushScheduled) {
    flushScheduled = true;
    // A promise job, not `queueMicrotask`: available on every RN runtime.
    Promise.resolve().then(flush);
  }
  return newest;
}

/** Commit-time half: this row is now the last one to have committed. */
export function noteCommit(agentId: string, now: number): Commit {
  const state = stateOf(agentId);
  state.recent = state.recent.filter((at) => now - at < BULK_WINDOW_MS);
  state.recent.push(now);
  const bulk = state.recent.length >= BULK_MIN_ROWS;
  seqCounter += 1;
  state.seq = seqCounter;
  state.seenAt = now;
  return { seq: state.seq, seenAt: now, bulk };
}

/** Whether a committed row should still be pulsing, given the agent's state. */
export function isPulsing(agentId: string, commit: Commit, now: number): boolean {
  const state = rows.get(agentId);
  // The `seq` test is what makes a row stop when a newer one commits: only the
  // last commit still matches. It is also why an early row of a replayed burst
  // stops on its own, one frame after the burst is recognised.
  if (state === undefined || state.seq !== commit.seq || commit.bulk) return false;
  return now - commit.seenAt < PULSE_MS;
}

/**
 * The pulse for one timeline row.
 *
 * `newest` is read during render (safe: a running maximum); `fresh` needs the
 * commit, so it is set from an effect and costs one extra render. A row that
 * stops being the last one corrects itself, because while it pulses it
 * re-renders 20 times a second and re-evaluates.
 */
export function useRowPulse(
  agentId: string,
  timestamp: Date | string | number,
): RowPulse {
  const at = atOf(timestamp);
  const newest = noteRender(agentId, at);
  const [commit, setCommit] = useState<Commit | null>(null);
  useEffect(() => {
    setCommit(noteCommit(agentId, Date.now()));
  }, [agentId, at]);
  return {
    newest,
    fresh: commit !== null && isPulsing(agentId, commit, Date.now()),
  };
}
