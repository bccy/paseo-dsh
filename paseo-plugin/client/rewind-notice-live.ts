/**
 * The client half's live witness: which rewind-report rows arrived **live**.
 *
 * The capsule must fire when a report row arrives on the live timeline stream
 * and stay silent when the same row is painted from a fetch (session reopen,
 * scroll, the replacement refetch). Rendering cannot tell those apart — a
 * fetched row is a component mount like any other — so the distinction is taken
 * from the stream itself: this monitor holds a `timeline.subscribe` observation
 * per watched agent, records every plugin row of kind `dsh-rewind-notice` that
 * arrives through it, and the row component consumes that record once. A row
 * that was never on the live stream has no record, so replay and refetch are
 * silent by construction, not by a time or render-cadence heuristic.
 *
 * **Where the subscription comes from.** A plugin cannot see which agent the
 * app has open, and a subscription established when the report row mounts is
 * too late for that row. So the watch set is assembled from the two things the
 * client half can observe:
 *
 * - the **agent directory**: agents of this provider whose session is active and
 *   that were updated recently are watched up front, which covers the usual
 *   case — a rewind follows a conversation the user just had. The set is
 *   bounded ({@link MAX_WATCHED_AGENTS}) so a large history cannot turn this
 *   into a subscription per stored agent.
 * - **the report row itself**: mounting one watches its agent, so every later
 *   rewind in that session is covered even when the agent is old or outside the
 *   bound. Only the very first rewind of a session whose agent is neither recent
 *   nor previously reported can miss the capsule; the row itself still appears.
 *
 * A subscription that fails (permissions, reconnect) is dropped and retried the
 * next time the agent is considered; the failure is logged through `onError`
 * rather than silently leaving the capsule dead.
 *
 * @module dsh-paseo/client/rewind-notice-live
 */
import type { PaseoAgentTimelineEvent, PaseoAgentTimelineSubscription, PaseoApi } from "@getpaseo/client";
import { REWIND_NOTICE_KIND } from "../shared/rewind-notice";
import { PROVIDER_ID } from "../shared/provider";

/**
 * How long after its live arrival a recorded notice may still raise a capsule.
 *
 * This is **not** a live/replay discriminator — the subscription already is
 * one. It only bounds the hand-off between the stream callback and the row's
 * React mount, so a row that the app did not paint until minutes later (the
 * user was on another screen, or the client was suspended) does not pop a
 * "just now" capsule long after the fact.
 */
export const REWIND_LIVE_HANDOFF_MS = 10_000;

/** Agents watched from the directory; row mounts may add more on top. */
export const MAX_WATCHED_AGENTS = 16;

/** Directory agents updated longer ago than this are not watched up front. */
export const WATCH_RECENT_MS = 30 * 60_000;

/** Ceiling on remembered live arrivals (one per shown capsule, roughly). */
const MAX_LIVE_RECORDS = 64;

/** One live arrival, as recorded from the timeline stream. */
export interface RewindLiveRecord {
  agentId: string;
  noticeId: string;
  /** This client's clock when the event arrived. */
  at: number;
}

export interface RewindLiveMonitorOptions {
  /** Injected clock, so the hand-off window is assertable without waiting. */
  now?: () => number;
  /** Receives every failure this monitor cannot surface any other way. */
  onError?: (message: string, error?: unknown) => void;
  /** Aborted by the plugin bundle's teardown. */
  signal?: AbortSignal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One directory agent this module needs to decide whether to watch it. */
interface WatchCandidate {
  id: string;
  updatedAt: number;
}

/**
 * Per-agent live-timeline witness for rewind-report rows.
 *
 * One instance per client bundle; `start()` establishes the directory
 * observation, `watch()` adds agents, `take()` is the row's one-shot question.
 */
export class RewindLiveMonitor {
  readonly #paseo: PaseoApi;
  readonly #now: () => number;
  readonly #onError: (message: string, error?: unknown) => void;
  readonly #subscriptions = new Map<string, () => void>();
  /** The directory observation, released on dispose. */
  #directory: { release(): Promise<void> } | undefined;
  /** `${agentId}\u0000${noticeId}` → arrival record. */
  readonly #live = new Map<string, RewindLiveRecord>();
  #disposed = false;

  constructor(paseo: PaseoApi, options: RewindLiveMonitorOptions = {}) {
    this.#paseo = paseo;
    this.#now = options.now ?? (() => Date.now());
    this.#onError = options.onError ?? (() => {});
    options.signal?.addEventListener("abort", () => this.dispose(), { once: true });
  }

  /**
   * Observe the agent directory and watch its recent, active agents.
   *
   * Resolves once the observation is installed (not when a subscription is
   * ready); a failed directory read is reported and leaves the monitor usable
   * through {@link watch} alone.
   */
  async start(): Promise<void> {
    if (this.#disposed) return;
    try {
      const result = await this.#paseo.agents.list({
        scope: "active",
        page: { limit: 50 },
        sort: [{ key: "updated_at", direction: "desc" }],
        subscribe: {},
      });
      if (this.#disposed) {
        await result.subscription.release().catch(() => undefined);
        return;
      }
      this.#directory = result.subscription;
      // The snapshot is delivered through the subscription, but the entries the
      // list call already returned are the same set — considering them now makes
      // the watch set independent of that delivery's timing.
      this.#considerDirectory(result.entries);
      result.subscription.subscribe({
        snapshot: (snapshot) => {
          this.#considerDirectory(snapshot.entries);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const payload = message.payload;
          if (payload.kind === "remove") {
            this.#unwatch(payload.agentId);
            return;
          }
          this.#considerDirectory([{ agent: payload.agent }]);
        },
        error: (error) => {
          this.#onError("the agent directory observation failed", error);
        },
      });
    } catch (error) {
      this.#onError("could not observe the agent directory; rewind capsules rely on row mounts", error);
    }
  }

  /**
   * Watch one agent's live timeline (idempotent).
   *
   * Called by the report row's mount and by the directory pass. A failed
   * subscription is logged and dropped; the next call retries.
   */
  watch(agentId: string): void {
    if (this.#disposed || agentId === "" || this.#subscriptions.has(agentId)) return;
    let subscription: PaseoAgentTimelineSubscription;
    try {
      subscription = this.#paseo.agents.ref(agentId).timeline.subscribe((event) => {
        this.#record(agentId, event);
      });
    } catch (error) {
      this.#onError(`could not subscribe to agent ${agentId}'s timeline`, error);
      return;
    }
    const established = subscription;
    this.#subscriptions.set(agentId, () => {
      void established.release().catch(() => undefined);
    });
    established.ready.catch((error: unknown) => {
      // Release and allow a retry: a subscription that never established cannot
      // deliver anything, and keeping it would block the next attempt.
      const release = this.#subscriptions.get(agentId);
      this.#subscriptions.delete(agentId);
      release?.();
      this.#onError(`agent ${agentId}'s timeline subscription failed`, error);
    });
  }

  /** Whether this exact row arrived live and may raise one capsule now. */
  take(agentId: string, noticeId: string): boolean {
    const key = `${agentId}\u0000${noticeId}`;
    const record = this.#live.get(key);
    if (record === undefined) return false;
    this.#live.delete(key);
    return this.#now() - record.at <= REWIND_LIVE_HANDOFF_MS;
  }

  /** Agents this monitor currently holds a live subscription for. */
  watchedAgents(): string[] {
    return [...this.#subscriptions.keys()];
  }

  /** Release every subscription. */
  dispose(): void {
    this.#disposed = true;
    for (const release of this.#subscriptions.values()) release();
    this.#subscriptions.clear();
    this.#live.clear();
    const directory = this.#directory;
    this.#directory = undefined;
    void directory?.release().catch(() => undefined);
  }

  /** Record one timeline event when it is our report row. */
  #record(agentId: string, message: PaseoAgentTimelineEvent): void {
    const event = message.event;
    if (event.type !== "timeline") return;
    const item = event.item;
    if (item.type !== "plugin" || item.kind !== REWIND_NOTICE_KIND) return;
    const data: unknown = item.data;
    const noticeId = typeof data === "object" && data !== null && !Array.isArray(data)
      ? Reflect.get(data, "noticeId")
      : undefined;
    if (typeof noticeId !== "string" || noticeId === "") {
      // A row without an id cannot be matched to a mount; the row still renders.
      this.#onError(`agent ${agentId} received a rewind report row with no noticeId; no capsule for it`);
      return;
    }
    const key = `${agentId}\u0000${noticeId}`;
    if (this.#live.has(key)) return;
    this.#live.set(key, { agentId, noticeId, at: this.#now() });
    if (this.#live.size > MAX_LIVE_RECORDS) {
      const oldest = this.#live.keys().next().value;
      if (oldest !== undefined) this.#live.delete(oldest);
    }
  }

  /** Watch the recent, active agents of this provider, up to the bound. */
  #considerDirectory(entries: readonly { agent: { id: string; provider: string; status: string; updatedAt: string; archivedAt?: string | null; internal?: boolean } }[]): void {
    if (this.#disposed) return;
    const candidates: WatchCandidate[] = [];
    for (const entry of entries) {
      const agent = entry.agent;
      if (agent.provider !== PROVIDER_ID || agent.internal === true) continue;
      if (agent.archivedAt !== null && agent.archivedAt !== undefined) continue;
      if (agent.status === "closed") continue;
      const updatedAt = Date.parse(agent.updatedAt);
      if (!Number.isFinite(updatedAt) || this.#now() - updatedAt > WATCH_RECENT_MS) continue;
      candidates.push({ id: agent.id, updatedAt });
    }
    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    for (const candidate of candidates) {
      if (this.#subscriptions.size >= MAX_WATCHED_AGENTS) break;
      this.watch(candidate.id);
    }
  }

  /** Drop one agent's subscription (it left the directory). */
  #unwatch(agentId: string): void {
    const release = this.#subscriptions.get(agentId);
    if (release === undefined) return;
    this.#subscriptions.delete(agentId);
    release();
  }
}

/** The monitor the current client bundle started, if any. */
let active: RewindLiveMonitor | null = null;

/**
 * Start the monitor for one client bundle and return its teardown.
 *
 * `arm` is called immediately: it is the server-side handle warm-up (see
 * `server/rewind-notice-append`), so a rewind that happens before any turn hook
 * fires can still append its report. Failures are logged, never thrown.
 */
export function startRewindLiveMonitor(
  paseo: PaseoApi,
  options: RewindLiveMonitorOptions & { arm?: () => Promise<unknown> } = {},
): () => void {
  const monitor = new RewindLiveMonitor(paseo, options);
  active = monitor;
  void options.arm?.().catch((error: unknown) => {
    options.onError?.("could not arm the server half for rewind reports", error);
  });
  void monitor.start();
  return () => {
    if (active === monitor) active = null;
    monitor.dispose();
  };
}

/** The monitor started by the current client bundle, when there is one. */
export function activeRewindLiveMonitor(): RewindLiveMonitor | null {
  return active;
}
