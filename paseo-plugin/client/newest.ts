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
 *   separates them by *commit burst* instead (see `BULK_*`), plus a first-pass
 *   rule for histories too small for that burst (`flush`): several rows painted
 *   for the first time in one pass is a replay, one row per pass is live.
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
  /**
   * Commits before this instant belong to a replayed history load rather than to
   * live activity (set by the first-pass rule in `flush`).
   */
  replayUntil: number;
  /** Whether a render pass that painted at least one row has been folded in. */
  sawFirstPass: boolean;
}

/** One render pass's running maximum, plus the rows it painted for the first time. */
interface PendingPass {
  at: number;
  /** Distinct timestamps of first-paint calls in this pass; null once none are new. */
  fresh: Set<number> | null;
}

const rows = new Map<string, AgentRows>();
/** The current render pass per agent, folded in afterwards. */
const pending = new Map<string, PendingPass>();
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
  /**
   * This commit belongs to a replayed history load (see `AgentRows.replayUntil`).
   * A history of fewer than `BULK_MIN_ROWS` rows is too small for `bulk` to see,
   * so without this the last row of a short session pulsed every time it was
   * reopened.
   */
  replay: boolean;
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
  const created: AgentRows = {
    at: 0,
    seq: 0,
    seenAt: 0,
    recent: [],
    replayUntil: 0,
    sawFirstPass: false,
  };
  rows.set(agentId, created);
  return created;
}

/** Fold this render pass's maxima into the state the next pass will read. */
function flush(): void {
  flushScheduled = false;
  for (const [agentId, pass] of pending) {
    const state = stateOf(agentId);
    if (pass.at > state.at) state.at = pass.at;
    const freshRows = pass.fresh?.size ?? 0;
    if (freshRows === 0) continue;
    if (!state.sawFirstPass) {
      state.sawFirstPass = true;
      // A first pass that paints several rows at once is a history load: a
      // replayed session emits its whole timeline before anything commits, while
      // a live pair arrives in two passes (the first row commits before the
      // second is even rendered). `BULK_MIN_ROWS` cannot see this case — a
      // history of fewer rows than that never reaches it — so its last row used
      // to pulse every time a short session was reopened. One row is left alone:
      // a single-row history and a live first command are the same shape.
      if (freshRows >= 2) state.replayUntil = Date.now() + BULK_WINDOW_MS;
    }
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
 * The pass also remembers which rows it painted *for the first time*
 * (`firstPaint`): several of them arriving together is what a replayed history
 * looks like, and `flush` uses that to mark the batch's commits as history. The
 * caller that has a commit state (`useRowPulse`) passes it; a caller without one
 * defaults to true, which keeps a one-row pass a one-row pass either way.
 *
 * Both updates are idempotent running maxima, so a discarded concurrent render
 * cannot corrupt them — unlike `seenAt`, which is why that one lives in an effect.
 */
export function noteRender(agentId: string, at: number, firstPaint = true): boolean {
  const known = rows.get(agentId)?.at;
  const newest = known !== undefined && at >= known;
  const queued = pending.get(agentId);
  if (queued === undefined) {
    pending.set(agentId, { at, fresh: firstPaint ? new Set([at]) : null });
  } else {
    if (at > queued.at) queued.at = at;
    if (firstPaint) (queued.fresh ??= new Set<number>()).add(at);
  }
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
  const replay = now < state.replayUntil;
  seqCounter += 1;
  state.seq = seqCounter;
  state.seenAt = now;
  return { seq: state.seq, seenAt: now, bulk, replay };
}

/** Whether a committed row should still be pulsing, given the agent's state. */
export function isPulsing(agentId: string, commit: Commit, now: number): boolean {
  const state = rows.get(agentId);
  // The `seq` test is what makes a row stop when a newer one commits: only the
  // last commit still matches. It is also why an early row of a replayed burst
  // stops on its own, one frame after the burst is recognised.
  if (state === undefined || state.seq !== commit.seq || commit.bulk || commit.replay) return false;
  return now - commit.seenAt < PULSE_MS;
}

/**
 * Whether a row should pulse: only the newest row does.
 *
 * `running` is gated on `newest` on purpose. A tool call that was interrupted
 * (the plugin restarted mid-tool, so no `tool/result` ever arrives) stays
 * `running` in the daemon's store forever, and it is never the newest row
 * again — ungated it would blink for the rest of the session. The server closes
 * those out on the next `turn/end` and on every replay, but an item already
 * stored is not rewritten retroactively, so the client has to be defensive too.
 */
export function shouldPulse(status: string, pulse: RowPulse): boolean {
  return pulse.newest && (status === "running" || pulse.fresh);
}

/** Milliseconds until this commit's pulse window closes; 0 once it has. */
export function pulseRemainingMs(commit: Commit, now: number): number {
  return Math.max(0, commit.seenAt + PULSE_MS - now);
}

/**
 * The pulse for one timeline row.
 *
 * `newest` is read during render (safe: a running maximum); `fresh` needs the
 * commit, so it is set from an effect and costs one extra render.
 *
 * Nothing else re-renders a pulsing row. The sweep animates through
 * `Animated.loop` on native and through CSS on web, and the 50ms state timer
 * that used to drive a re-render went away with the opacity pulse — so a row
 * has to schedule its own wake-up for the moment its window closes. Without it
 * a short command keeps shimmering until some unrelated timeline update happens
 * to re-render it, and a row that stops being the last one keeps its
 * `newest` claim for just as long.
 */
export function useRowPulse(
  agentId: string,
  timestamp: Date | string | number,
): RowPulse {
  const at = atOf(timestamp);
  // A row that has never committed calls this for the first time: that is what
  // `flush` counts to tell a history load (several first paints in one pass)
  // from live activity (one row per pass).
  const [commit, setCommit] = useState<Commit | null>(null);
  const newest = noteRender(agentId, at, commit === null);
  const [, setTick] = useState(0);
  useEffect(() => {
    setCommit(noteCommit(agentId, Date.now()));
  }, [agentId, at]);
  const fresh = commit !== null && isPulsing(agentId, commit, Date.now());
  useEffect(() => {
    if (commit === null) return;
    const remaining = pulseRemainingMs(commit, Date.now());
    if (remaining <= 0) return;
    // One frame past the window, so the re-render reads an expired window.
    const timer = setTimeout(() => setTick((n) => n + 1), remaining + 16);
    return () => clearTimeout(timer);
  }, [commit, fresh]);
  return { newest, fresh };
}
