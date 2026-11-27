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
import { useEffect, useRef, useState } from "react";
import {
  hasRecentLiveActivity,
  markAgentLiveActivity,
  resetRowCascadeForTests,
} from "./row-cascade";

/** Maximum number of simultaneous `liveHint: true` rows allowed as a parallel live burst. */
const MAX_LIVE_PARALLEL_BURST = 12;

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
}

/** One render pass's running maximum, plus the rows it painted for the first time. */
interface PendingPass {
  at: number;
  /** Distinct timestamps of first-paint calls in this pass; null once none are new. */
  fresh: Set<number> | null;
  /** Distinct row identities supplied by callers for StrictMode-safe deduplication. */
  freshIdentities: Set<unknown> | null;
  /** Count of fresh first-paint calls without an explicit identity (legacy compatibility). */
  anonymousFreshCount: number;
}

/** Per-agent render/commit batch tracker for entrance & stream-reveal gating. */
interface MountBatch {
  /** Distinct row keys attempting a first mount in the current render pass. */
  keys: Set<string>;
  /** True only while every candidate registered in this pass carried `liveHint === true`. */
  allLiveHint: boolean;
  /** Once the first commit effect runs, freeze batch classification & decisions. */
  sealed: boolean;
  /** Whether this render/commit pass mounted >= 2 fresh rows (a history/bulk batch). */
  isBatch: boolean;
  /** Whether this commit pass is a genuine live parallel burst (e.g. parallel running tools). */
  isLiveBurst: boolean;
  /** Cached entrance decision per row key so RowEntrance & useInkStreamReveal agree. */
  decisions: Map<string, boolean>;
  /** Last render-candidate timestamp (ms) so abandoned uncommitted renders age out. */
  updatedAt: number;
}

const rows = new Map<string, AgentRows>();
/** Active newest-row listeners per agent so a newer commit immediately stops the previous row's shimmer. */
const pulseListeners = new Map<string, Set<() => void>>();
/** The current render pass per agent, folded in afterwards. */
const pending = new Map<string, PendingPass>();
/** Per-agent mount batch state for entrance/reveal commit-phase coordination. */
const mountBatches = new Map<string, MountBatch>();
/** Per-agent bounded set of row keys that have already played an entrance animation. */
const animatedKeys = new Map<string, Set<string>>();
let flushScheduled = false;
let seqCounter = 0;
/**
 * Agents are few, but the map is keyed by an id that outlives a session, so it
 * is capped rather than trusted to stay small. Insertion order is first-seen
 * order, because an existing entry is never re-set.
 */
const MAX_AGENTS = 200;
/** Per-agent cap on remembered animated row keys (evicts oldest first). */
const MAX_ANIMATED_KEYS = 500;

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

/**
 * Normalize a timeline row timestamp to epoch milliseconds, returning `0` when
 * the input is missing or cannot be parsed into a finite number.
 */
export function normalizeRowTimestamp(timestamp: Date | string | number | undefined): number {
  if (timestamp === undefined) return 0;
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
  };
  rows.set(agentId, created);
  return created;
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // A promise job, not `queueMicrotask`: available on every RN runtime.
  Promise.resolve().then(flush);
}

function passFreshCount(pass: PendingPass | undefined): number {
  if (pass === undefined) return 0;
  return Math.max(
    pass.fresh?.size ?? 0,
    (pass.freshIdentities?.size ?? 0) + pass.anonymousFreshCount,
  );
}

function pendingFreshCount(agentId: string, now = Date.now()): number {
  const fromPass = passFreshCount(pending.get(agentId));
  const batch = mountBatches.get(agentId);
  const fromMounts =
    batch !== undefined && (batch.sealed || now - batch.updatedAt < BULK_WINDOW_MS)
      ? batch.keys.size
      : 0;
  return Math.max(fromPass, fromMounts);
}

/** Fold this render pass's maxima into the state the next pass will read. */
function flush(): void {
  flushScheduled = false;
  const now = Date.now();
  for (const [agentId, pass] of pending) {
    const state = stateOf(agentId);
    if (pass.at > state.at) state.at = pass.at;
    const freshRows = passFreshCount(pass);
    if (freshRows === 0) continue;
    // Any single render pass that paints two or more fresh rows at once is a
    // batch (initial history load, session switch, or bulk replay) — even on an
    // agent that has already settled its first pass, and even when replayed
    // rows share the exact same millisecond timestamp. A single row is left
    // alone so live activity can still pulse and enter smoothly.
    if (freshRows >= 2) {
      state.replayUntil = Math.max(state.replayUntil, now + BULK_WINDOW_MS);
    }
  }
  pending.clear();
  // Only retire mount batches that have already committed (`sealed`) or aged out
  // after an abandoned render. Unsealed batches stay alive across microtask yields
  // so React concurrent render slices that yield before commit still coalesce into
  // one batch decision.
  for (const [agentId, batch] of mountBatches) {
    if (batch.sealed || now - batch.updatedAt >= BULK_WINDOW_MS) {
      mountBatches.delete(agentId);
      continue;
    }
    if (batch.keys.size >= 2 && !batch.allLiveHint) {
      const state = stateOf(agentId);
      state.replayUntil = Math.max(state.replayUntil, now + BULK_WINDOW_MS);
    }
  }
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
export function noteRender(
  agentId: string,
  at: number,
  firstPaint = true,
  identity?: unknown,
): boolean {
  const known = rows.get(agentId)?.at;
  const newest = known !== undefined && at >= known;
  // On an unseen agent every firstPaint row is new; once the agent has a known
  // watermark, only strictly newer timestamps count via `noteRender` so
  // callers without commit state (e.g. re-rendered existing rows) do not turn a
  // normal re-render into a replay batch. Component-level multi-row mounts at
  // any timestamp are separately caught by `noteMountCandidate` / `commitMountEntrance`.
  const countsAsFresh = firstPaint && (known === undefined || at > known);
  const queued = pending.get(agentId);
  if (queued === undefined) {
    pending.set(agentId, {
      at,
      fresh: countsAsFresh ? new Set([at]) : null,
      freshIdentities: countsAsFresh && identity !== undefined ? new Set([identity]) : null,
      anonymousFreshCount: countsAsFresh && identity === undefined ? 1 : 0,
    });
  } else {
    if (at > queued.at) queued.at = at;
    if (countsAsFresh) {
      (queued.fresh ??= new Set<number>()).add(at);
      if (identity !== undefined) {
        (queued.freshIdentities ??= new Set<unknown>()).add(identity);
      } else {
        queued.anonymousFreshCount += 1;
      }
    }
  }
  scheduleFlush();
  return newest;
}

function notifyPulseListeners(agentId: string): void {
  const listeners = pulseListeners.get(agentId);
  if (listeners === undefined || listeners.size === 0) return;
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

function subscribePulseHandover(agentId: string, listener: () => void): () => void {
  let listeners = pulseListeners.get(agentId);
  if (listeners === undefined) {
    listeners = new Set();
    pulseListeners.set(agentId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = pulseListeners.get(agentId);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) pulseListeners.delete(agentId);
  };
}

/**
 * Hand off the active row pulse when a non-pulsing live row (such as a
 * streaming assistant reply or turn stats footer) starts below the last
 * tool/thinking row, so the row above immediately stops shimmering.
 */
export function yieldRowPulse(agentId: string | undefined): void {
  if (agentId === undefined || agentId === "") return;
  const state = rows.get(agentId);
  if (state === undefined) return;
  seqCounter += 1;
  state.seq = seqCounter;
  notifyPulseListeners(agentId);
}

/**
 * Claim exclusive pulse ownership for a live streaming row that manages its
 * own active state (e.g. `InlineThinking`). Returns true while this row still
 * holds the latest `seq` for `agentId`, and flips to false the instant any
 * newer tool row, thinking row, or assistant reply commits below it.
 */
export function useIsPulseOwner(agentId: string | undefined, active: boolean): boolean {
  const claimedSeqRef = useRef<number | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!active || agentId === undefined || agentId === "") {
      claimedSeqRef.current = null;
      return;
    }
    const state = stateOf(agentId);
    seqCounter += 1;
    const mySeq = seqCounter;
    state.seq = mySeq;
    claimedSeqRef.current = mySeq;
    notifyPulseListeners(agentId);
    const unsub = subscribePulseHandover(agentId, () => {
      if (rows.get(agentId)?.seq !== mySeq) {
        setTick((n) => (n + 1) & 0x7fffffff);
      }
    });
    return () => {
      unsub();
    };
  }, [agentId, active]);

  if (!active) return false;
  if (agentId === undefined || agentId === "") return true;
  const mySeq = claimedSeqRef.current;
  if (mySeq === null) return true;
  const currentSeq = rows.get(agentId)?.seq;
  return currentSeq === undefined || currentSeq === mySeq;
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
  notifyPulseListeners(agentId);
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

function rememberAnimatedKey(agentId: string, key: string): void {
  let set = animatedKeys.get(agentId);
  if (set === undefined) {
    if (animatedKeys.size >= MAX_AGENTS) {
      const oldestAgent = animatedKeys.keys().next().value;
      if (oldestAgent !== undefined) animatedKeys.delete(oldestAgent);
    }
    set = new Set<string>();
    animatedKeys.set(agentId, set);
  }
  if (set.has(key)) return;
  if (set.size >= MAX_ANIMATED_KEYS) {
    const oldestKey = set.values().next().value;
    if (oldestKey !== undefined) set.delete(oldestKey);
  }
  set.add(key);
}

function rowAnimationKey(at: number, rowKey?: string): string {
  return rowKey !== undefined && rowKey !== "" ? rowKey : String(at);
}

/**
 * Record that a timeline row has committed so later remounts (e.g. after
 * virtual-list recycling) do not replay the entrance animation.
 */
export function markRowAnimated(agentId: string, at: number, rowKey?: string): void {
  if (agentId === "") return;
  rememberAnimatedKey(agentId, rowAnimationKey(at, rowKey));
}

/**
 * Register a mounting row in the current render pass so commit-phase entrance
 * checks (`commitMountEntrance`) can detect multi-row batch mounts before any
 * row activates entrance or ink-stream animations.
 *
 * Strictly idempotent per row key (safe under React 18 StrictMode double
 * renders and shared across `RowEntrance` + `useInkStreamReveal` on the same
 * row). Does not mutate `rows` or `animatedKeys`.
 */
export function noteMountCandidate(
  agentId: string,
  at: number,
  rowKey?: string,
  now = Date.now(),
  liveHint?: boolean,
): void {
  if (agentId === "") return;
  const key = rowAnimationKey(at, rowKey);
  if (animatedKeys.get(agentId)?.has(key)) return;
  let batch = mountBatches.get(agentId);
  if (batch === undefined || batch.sealed || now - batch.updatedAt >= BULK_WINDOW_MS) {
    batch = {
      keys: new Set<string>(),
      allLiveHint: liveHint === true,
      sealed: false,
      isBatch: false,
      isLiveBurst: false,
      decisions: new Map<string, boolean>(),
      updatedAt: now,
    };
    mountBatches.set(agentId, batch);
  } else {
    batch.updatedAt = now;
    if (liveHint !== true) batch.allLiveHint = false;
  }
  batch.keys.add(key);
  scheduleFlush();
}

/**
 * Commit-phase entrance gate called from `useLayoutEffect` (or `useEffect`
 * fallback in minimal stubs) by `RowEntrance` and `useInkStreamReveal`.
 *
 * Seals the current render pass's mount batch on first commit, suppressing
 * every row (and extending `replayUntil`) when >= 2 fresh rows mounted in the
 * same pass — EXCEPT when `allowLiveBurst` is enabled and every row in a small
 * active-session pass carries `liveHint === true` (genuine parallel tool calls
 * launched together in one turn, which should cascade smoothly rather than
 * popping in un-animated).
 *
 * Caches the per-key decision for the duration of the sealed commit so both
 * `RowEntrance` and `useInkStreamReveal` on the same row agree even though
 * child layout effects commit before parent layout effects, while still marking
 * the row animated so any subsequent remount renders statically.
 */
export function commitMountEntrance(
  agentId: string,
  at: number,
  liveHint = false,
  rowKey?: string,
  now = Date.now(),
  allowLiveBurst = false,
): boolean {
  if (agentId === "") return false;
  const key = rowAnimationKey(at, rowKey);
  let batch = mountBatches.get(agentId);
  if (batch === undefined) {
    batch = {
      keys: new Set<string>([key]),
      allLiveHint: liveHint === true,
      sealed: false,
      isBatch: false,
      isLiveBurst: false,
      decisions: new Map<string, boolean>(),
      updatedAt: now,
    };
    mountBatches.set(agentId, batch);
  }

  if (!batch.sealed) {
    batch.sealed = true;
    const passFresh = passFreshCount(pending.get(agentId));
    const existingState = rows.get(agentId);
    const inReplayCooldown = existingState !== undefined && now < existingState.replayUntil;
    const sessionActive = existingState !== undefined || hasRecentLiveActivity(agentId, now);
    const multiRow = batch.keys.size >= 2 || passFresh >= 2;
    const liveParallel =
      allowLiveBurst &&
      liveHint === true &&
      batch.allLiveHint &&
      !inReplayCooldown &&
      sessionActive &&
      batch.keys.size <= MAX_LIVE_PARALLEL_BURST &&
      passFresh <= MAX_LIVE_PARALLEL_BURST;

    batch.isLiveBurst = liveParallel;
    batch.isBatch = multiRow && !liveParallel;
    if (batch.isBatch) {
      const state = stateOf(agentId);
      state.replayUntil = Math.max(state.replayUntil, now + BULK_WINDOW_MS);
    }
    // Retire the sealed batch in the post-commit microtask once every row in
    // this commit phase has read its cached decision.
    scheduleFlush();
  }

  const cached = batch.decisions.get(key);
  if (cached !== undefined) return cached;

  let decision: boolean;
  if (batch.isBatch) {
    decision = false;
  } else if (batch.isLiveBurst) {
    const alreadyAnimated = animatedKeys.get(agentId)?.has(key) === true;
    const existingState = rows.get(agentId);
    const staleTimestamp = existingState !== undefined && at < existingState.at;
    decision = !alreadyAnimated && !staleTimestamp;
  } else {
    decision = shouldEnterLive(agentId, at, liveHint, rowKey, now);
  }

  batch.decisions.set(key, decision);
  rememberAnimatedKey(agentId, key);
  if (decision) {
    markAgentLiveActivity(agentId, now);
  }
  return decision;
}

/**
 * Pure read-only check for whether a mounting timeline row arrived live and
 * should play a one-shot entrance animation.
 *
 * Replayed history rows, bulk-load bursts, older rows remounting after
 * virtual-list recycling, and rows whose key has already committed via
 * {@link markRowAnimated} all return `false` so only genuine live arrivals
 * animate. Deliberately side-effect free so React 18 StrictMode double-invoked
 * `useState` initializers and discarded concurrent renders always observe the
 * same result.
 */
export function shouldEnterLive(
  agentId: string,
  at: number,
  liveHint = false,
  rowKey?: string,
  now = Date.now(),
): boolean {
  if (agentId === "") return false;
  const key = rowAnimationKey(at, rowKey);
  if (animatedKeys.get(agentId)?.has(key)) return false;

  const state = rows.get(agentId);
  if (state !== undefined) {
    if (now < state.replayUntil) return false;
    if (pendingFreshCount(agentId, now) >= 2) return false;
    if (state.recent.filter((t) => now - t < BULK_WINDOW_MS).length >= BULK_MIN_ROWS - 1) {
      return false;
    }
    if (at < state.at) return false;
    return true;
  }

  // Session has not settled its first render pass yet: only allow a live row
  // (e.g. a brand-new session's first streaming thought or running tool) when
  // no multi-row history pass is queued. Deliberately avoids touching `rows` so
  // `noteRender`'s first-pass `known === undefined` invariant stays intact.
  if (liveHint === true && pendingFreshCount(agentId, now) <= 1) {
    return true;
  }
  return false;
}

/** Number of active pulse-handover listeners registered for `agentId` (for offline tests). */
export function pulseListenerCountForTests(agentId: string): number {
  return pulseListeners.get(agentId)?.size ?? 0;
}

/** Clear per-agent (or all) module state. Intended for offline tests. */
export function resetNewestForTests(agentId?: string): void {
  resetRowCascadeForTests(agentId);
  if (agentId === undefined) {
    rows.clear();
    pulseListeners.clear();
    pending.clear();
    mountBatches.clear();
    animatedKeys.clear();
    flushScheduled = false;
    seqCounter = 0;
    return;
  }
  rows.delete(agentId);
  pulseListeners.delete(agentId);
  pending.delete(agentId);
  mountBatches.delete(agentId);
  animatedKeys.delete(agentId);
}

/**
 * The pulse for one timeline row.
 *
 * `newest` is read during render (safe: a running maximum); `fresh` needs the
 * commit, so it is set from an effect and costs one extra render.
 *
 * Subscribes while active so the moment a newer row commits (or an assistant
 * reply begins streaming below via `yieldRowPulse`), this row wakes immediately
 * and yields the shimmer — never leaving two rows shimmering together.
 */
export function useRowPulse(
  agentId: string,
  timestamp: Date | string | number,
  rowKey?: string,
): RowPulse {
  const at = normalizeRowTimestamp(timestamp);
  const instanceTokenRef = useRef<object | null>(null);
  if (instanceTokenRef.current === null) instanceTokenRef.current = {};
  const identity = rowKey !== undefined && rowKey !== "" ? rowKey : instanceTokenRef.current;

  // Freeze this row's birth timestamp per `(agentId, identity)` so when Paseo
  // updates an older slow tool's `timestamp` upon completion, the older row
  // never bumps `state.at` or re-commits `noteCommit` to steal shimmer away
  // from the genuinely newest row at the bottom of the timeline.
  const birthRef = useRef<{ agentId: string; identity: unknown; at: number } | null>(null);
  if (
    birthRef.current === null ||
    birthRef.current.agentId !== agentId ||
    birthRef.current.identity !== identity
  ) {
    birthRef.current = { agentId, identity, at };
  }
  const birthAt = birthRef.current.at;

  const [commit, setCommit] = useState<Commit | null>(null);
  const rawNewest = noteRender(agentId, birthAt, commit === null, identity);
  const [, setTick] = useState(0);
  useEffect(() => {
    const currentAt = rows.get(agentId)?.at;
    // A scroll-back remount of an older historical row (`birthAt < currentAt`)
    // must never claim `seq` or steal the active shimmer from the newest row.
    if (currentAt !== undefined && birthAt < currentAt) return;
    setCommit(noteCommit(agentId, Date.now()));
  }, [agentId, identity]);
  const currentSeq = rows.get(agentId)?.seq;
  const superseded = commit !== null && currentSeq !== undefined && currentSeq !== commit.seq;
  const newest = rawNewest && !superseded;
  const fresh = commit !== null && isPulsing(agentId, commit, Date.now());
  useEffect(() => {
    if (!newest && !fresh) return;
    const mySeq = commit?.seq;
    return subscribePulseHandover(agentId, () => {
      if (mySeq === undefined || rows.get(agentId)?.seq !== mySeq) {
        setTick((n) => (n + 1) & 0x7fffffff);
      }
    });
  }, [agentId, newest, fresh, commit?.seq]);
  useEffect(() => {
    if (commit === null || !fresh) return;
    const remaining = pulseRemainingMs(commit, Date.now());
    if (remaining <= 0) return;
    // One frame past the window, so the re-render reads an expired window.
    const timer = setTimeout(() => setTick((n) => (n + 1) & 0x7fffffff), remaining + 16);
    return () => clearTimeout(timer);
  }, [commit, fresh]);
  return { newest, fresh };
}
