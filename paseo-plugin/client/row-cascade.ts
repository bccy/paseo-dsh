/**
 * Per-agent inter-row visual continuity & cascade scheduler.
 *
 * Coordinates newly arrived live timeline rows (tool calls, thinking rows)
 * with any actively blooming `AssistantMessageBloom` above them so rows flow
 * down the screen in one continuous visual motion rather than popping in
 * abruptly beneath unfinished text:
 *
 * 1. **Upstream bloom handoff**: while an assistant reply is still softly
 *    blooming, an arriving tool row signals the reply to gently accelerate its
 *    remaining tail (`BLOOM_HANDOFF_SPEED_BOOST`) and waits a brief capped
 *    handoff beat so the tool row dissolves in right as the reply's tail lands.
 * 2. **Parallel/burst stagger**: when multiple live tool rows arrive together
 *    or back-to-back, each row claims the next rhythmic slot (`110ms` apart,
 *    hard-capped at `460ms` total wait) so they cascade smoothly instead of
 *    colliding or being suppressed to a hard pop.
 * 3. **Row-level idempotency**: `RowEntrance` and `useInkStreamReveal` on the
 *    same row share the exact cached `delayMs` for their `rowKey`, keeping the
 *    icon/container opacity dissolve and the `rgba` text bloom locked in sync.
 *
 * Kept free of React / React Native imports so offline Node harnesses can test
 * the scheduling math directly.
 *
 * @module dsh-paseo/client/row-cascade
 */

/** Stagger step (ms) between consecutive live rows entering in a burst. */
export const ROW_CASCADE_STAGGER_MS = 110;
/** Hard ceiling (ms) on any single row's cascade wait so bursts stay snappy. */
export const ROW_CASCADE_MAX_DELAY_MS = 460;
/** Maximum handoff wait (ms) for an upstream assistant bloom above the row. */
export const BLOOM_HANDOFF_MAX_DELAY_MS = 260;
/** Smooth tail acceleration applied to an assistant bloom once a successor arrives. */
export const BLOOM_HANDOFF_SPEED_BOOST = 1.85;
/** Overlap lead (ms) so the next row begins dissolving in just as the tail lands. */
const BLOOM_HANDOFF_OVERLAP_MS = 40;
/** How long a live session stays marked active for parallel-burst recognition. */
const LIVE_ACTIVITY_WINDOW_MS = 15_000;
/** How long a row's claimed cascade slot stays cached for paired hooks. */
const CLAIM_TTL_MS = 2_000;
/** Bounded agent map size. */
const MAX_AGENTS = 200;
/** Bounded per-agent claimed-row cache size. */
const MAX_CLAIMS_PER_AGENT = 64;

interface ActiveBloomState {
  finishAt: number;
  onSuccessorWaiting?: () => void;
  notified: boolean;
}

interface RowClaim {
  slotAt: number;
  claimedAt: number;
}

interface AgentCascadeState {
  lastLiveAt: number;
  nextSlotAt: number;
  activeBloom: ActiveBloomState | null;
  claims: Map<string, RowClaim>;
}

const agents = new Map<string, AgentCascadeState>();

function stateOf(agentId: string): AgentCascadeState {
  const existing = agents.get(agentId);
  if (existing !== undefined) return existing;
  if (agents.size >= MAX_AGENTS) {
    const oldest = agents.keys().next().value;
    if (oldest !== undefined) agents.delete(oldest);
  }
  const created: AgentCascadeState = {
    lastLiveAt: 0,
    nextSlotAt: 0,
    activeBloom: null,
    claims: new Map(),
  };
  agents.set(agentId, created);
  return created;
}

/** Record genuine live streaming activity for an agent (assistant reply, thinking, or live tool). */
export function markAgentLiveActivity(agentId: string | undefined, now = Date.now()): void {
  if (agentId === undefined || agentId === "") return;
  const state = stateOf(agentId);
  if (now > state.lastLiveAt) state.lastLiveAt = now;
}

/** Whether the agent has observed live streaming activity recently. */
export function hasRecentLiveActivity(agentId: string | undefined, now = Date.now()): boolean {
  if (agentId === undefined || agentId === "") return false;
  const state = agents.get(agentId);
  if (state === undefined || state.lastLiveAt <= 0) return false;
  return now - state.lastLiveAt < LIVE_ACTIVITY_WINDOW_MS;
}

/**
 * Publish an actively blooming upstream row's estimated remaining duration so
 * any arriving tool row below can gently hand off instead of popping in early.
 */
export function reportActiveBloom(
  agentId: string | undefined,
  remainingMs: number,
  onSuccessorWaiting?: () => void,
  now = Date.now(),
): void {
  if (agentId === undefined || agentId === "") return;
  const state = stateOf(agentId);
  if (now > state.lastLiveAt) state.lastLiveAt = now;
  const clampedRemaining = Math.max(0, Number.isFinite(remainingMs) ? remainingMs : 0);
  if (clampedRemaining <= 0) {
    state.activeBloom = null;
    return;
  }
  const prev = state.activeBloom;
  state.activeBloom = {
    finishAt: now + clampedRemaining,
    onSuccessorWaiting,
    notified: prev !== null && prev.onSuccessorWaiting === onSuccessorWaiting ? prev.notified : false,
  };
}

/** Clear the upstream bloom beacon once the reply settles or unmounts. */
export function clearActiveBloom(agentId: string | undefined): void {
  if (agentId === undefined || agentId === "") return;
  const state = agents.get(agentId);
  if (state !== undefined) state.activeBloom = null;
}

/**
 * Claim (or read the already-claimed) cascade start delay (ms) for one live
 * timeline row. Calling this from both `RowEntrance` and `useInkStreamReveal`
 * with the same `(agentId, rowKey)` returns the exact same phase-locked delay.
 */
export function claimCascadeDelay(
  agentId: string | undefined,
  rowKey: string,
  now = Date.now(),
  maxHandoffDelayMs = BLOOM_HANDOFF_MAX_DELAY_MS,
): number {
  if (agentId === undefined || agentId === "" || rowKey === "") return 0;
  const state = stateOf(agentId);
  if (now > state.lastLiveAt) state.lastLiveAt = now;

  // Reuse the same slot when the paired hook (`RowEntrance` / `useInkStreamReveal`)
  // on the exact same row asks within the claim TTL.
  const existing = state.claims.get(rowKey);
  if (existing !== undefined && now - existing.claimedAt < CLAIM_TTL_MS) {
    return Math.max(0, Math.round(existing.slotAt - now));
  }

  // Prune expired claims to keep the per-agent map tiny.
  if (state.claims.size >= MAX_CLAIMS_PER_AGENT) {
    for (const [k, v] of state.claims) {
      if (now - v.claimedAt >= CLAIM_TTL_MS) state.claims.delete(k);
    }
    if (state.claims.size >= MAX_CLAIMS_PER_AGENT) {
      const oldestKey = state.claims.keys().next().value;
      if (oldestKey !== undefined) state.claims.delete(oldestKey);
    }
  }

  const handoffCap = Math.max(0, maxHandoffDelayMs);
  let handoffAt = now;
  const bloom = state.activeBloom;
  if (bloom !== null) {
    const remaining = bloom.finishAt - now;
    if (remaining > 0) {
      if (!bloom.notified) {
        bloom.notified = true;
        bloom.onSuccessorWaiting?.();
      }
      const boostedRemaining = remaining / BLOOM_HANDOFF_SPEED_BOOST;
      const handoffWait = Math.min(
        handoffCap,
        Math.max(0, boostedRemaining - BLOOM_HANDOFF_OVERLAP_MS),
      );
      handoffAt = now + handoffWait;
    } else {
      state.activeBloom = null;
    }
  }

  const maxTotalWait = Math.max(ROW_CASCADE_MAX_DELAY_MS, handoffCap);
  const rawSlotAt = Math.max(now, handoffAt, state.nextSlotAt);
  const clampedSlotAt = Math.min(now + maxTotalWait, rawSlotAt);
  state.nextSlotAt = clampedSlotAt + ROW_CASCADE_STAGGER_MS;
  state.claims.set(rowKey, { slotAt: clampedSlotAt, claimedAt: now });
  return Math.max(0, Math.round(clampedSlotAt - now));
}

/** Clear cascade state for one agent or all agents (for offline tests). */
export function resetRowCascadeForTests(agentId?: string): void {
  if (agentId === undefined) {
    agents.clear();
    return;
  }
  agents.delete(agentId);
}
