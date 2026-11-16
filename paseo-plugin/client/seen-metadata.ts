/**
 * The "seen" state behind the team and goal pills, kept on the agent itself
 * (0.16 port, 2026-11-11).
 *
 * Both pills hide a finished state only after the user opened its panel and
 * `./seen-close-gate` confirmed the close. That fact has to outlive the client
 * bundle — an app restart re-runs it, and a plugin reload reloads it — or a
 * finished board/answer shows once more.
 *
 * **Where it now lives.** Paseo 0.16 gives plugins `PluginAgentSnapshot.metadata`:
 * a durable per-agent JSON record, persisted by the daemon with the agent itself
 * and delivered on the agent-directory subscription the pills already hold. The
 * signature therefore sits **beside the agent it describes** under a namespaced
 * key (`../shared/pill-metadata`). That replaces the earlier host-scoped settings
 * document, and with it four mechanisms that existed only because one host-level
 * file was shared by every agent and every device:
 *
 * - the 64-entry cap (one agent holds exactly one signature),
 * - the `invalid`-document repair (`reset`), since there is no plugin-owned
 *   envelope to version or corrupt,
 * - the read/write conflict protocol (`conflict` → re-read → merge), since a
 *   metadata patch is per key and last write wins,
 * - the startup hydrate + `ready()` publish gate, since the value arrives with
 *   the agent before the pill is first presented.
 *
 * **What did not change:** only a confirmed close writes; a poll/answer never
 * does. A failed write is reported once and the in-memory answer stays correct
 * for this session (the finished state still hides now, it just shows once more
 * after a reload). Removal of a pill does **not** clear the remembered value: the
 * signature names the exact finished state the user closed, so it cannot hide a
 * state the user has not been shown, and clearing it on every reconnect only made
 * an already-read finished state reappear (docs/GOAL.md, 2026-11-09).
 *
 * The host is injected (write + error sink), so the harness drives it with no
 * host at all.
 *
 * @module dsh-paseo/client/seen-metadata
 */
import { seenFromMetadata } from "../shared/pill-metadata";

/** What the pill supplies: the metadata write and its own error sink. */
export interface SeenMetadataIo {
  /**
   * Store one signature on the agent (`{ [key]: signature }`).
   *
   * Rejects when the host refuses the write (a daemon without the
   * `entityMetadata` feature answers "Update the host to use metadata.").
   */
  write(agentId: string, signature: string): Promise<void>;
  /** One console line per controller lifetime — a failing host must not spam. */
  onError(message: string, error?: unknown): void;
}

/** The surface a pill uses. */
export interface SeenMetadataStore {
  /**
   * Take the signature from one agent snapshot's metadata.
   *
   * @returns whether the remembered answer changed (the pill then re-presents).
   */
  observe(agent: { readonly id: string; readonly metadata?: Readonly<Record<string, unknown>> }): boolean;
  /** Representative local-first key; use `hasSeen` to test a particular state. */
  get(agentId: string): string | undefined;
  /** Whether this exact state was closed locally or arrived as stored metadata. */
  hasSeen(agentId: string, signature: string): boolean;
  /** Remember one confirmed close: in memory now, on the agent right after. Never rejects. */
  remember(agentId: string, signature: string): void;
  /** Await every scheduled write (tests and teardown only). */
  flush(): Promise<void>;
  /** Stop writing; the in-memory answer is dropped. */
  dispose(): void;
}

/**
 * Create the store for one pill.
 *
 * Writes are chained in call order so two rapid closes on different agents
 * cannot interleave their patches; a failed write never blocks the next one.
 */
export function createSeenMetadataStore(io: SeenMetadataIo, key: string): SeenMetadataStore {
  /** What the last agent snapshot said, per agent. */
  const stored = new Map<string, string>();
  /**
   * Confirmed closes whose metadata write has not been echoed back yet.
   *
   * The daemon echoes the write as an `agent_update`, but a disconnect can lose
   * that echo even after the write succeeded. This local fact and a different
   * stored signature are both evidence of a confirmed close; neither has a
   * sequence number that could justify discarding the other.
   */
  const pending = new Map<string, string>();
  let disposed = false;
  let reported = false;
  let writes: Promise<void> = Promise.resolve();

  const report = (message: string, error?: unknown): void => {
    if (reported) return;
    reported = true;
    try {
      io.onError(message, error);
    } catch {
      /* a logging sink that throws must not break the pill */
    }
  };

  const persist = async (agentId: string, signature: string): Promise<void> => {
    if (disposed) return;
    try {
      await io.write(agentId, signature);
    } catch (error) {
      report(
        `could not store the "seen" signature on agent ${agentId}; it stays in memory for this session`,
        error,
      );
      return;
    }
    // The write landed. The value is not dropped from `pending` here: the
    // snapshot echo is what proves the daemon stored it, and dropping early
    // would let a stale snapshot (one read before the write) hide it again.
  };

  const enqueueWrite = (agentId: string, signature: string): void => {
    writes = writes.then(() => persist(agentId, signature)).catch(() => undefined);
  };
  // Bounded to the current local and stored keys, not a history of every close.
  // A later snapshot may replace the stored key; metadata carries no ordering
  // token with which to reconstruct arbitrary out-of-order remote history.
  const candidates = (agentId: string): string => JSON.stringify(
    [...new Set([pending.get(agentId), stored.get(agentId)].filter(value => value !== undefined))].sort(),
  );

  return {
    observe(agent): boolean {
      if (disposed) return false;
      const seen = seenFromMetadata(agent.metadata, key);
      // Compare the effective candidates, not the priority of one slot. The
      // echo moving the same key from pending to stored remains a no-op; a new
      // remote key must notify the pill even while another local echo is lost.
      const before = candidates(agent.id);
      if (seen === undefined) stored.delete(agent.id);
      else stored.set(agent.id, seen);
      if (seen !== undefined && pending.get(agent.id) === seen) pending.delete(agent.id);
      return before !== candidates(agent.id);
    },
    get(agentId: string): string | undefined {
      return pending.get(agentId) ?? stored.get(agentId);
    },
    hasSeen(agentId: string, signature: string): boolean {
      return pending.get(agentId) === signature || stored.get(agentId) === signature;
    },
    remember(agentId: string, signature: string): void {
      if (agentId === "" || signature === "" || disposed) return;
      if (pending.get(agentId) === signature) return;
      pending.set(agentId, signature);
      enqueueWrite(agentId, signature);
    },
    async flush(): Promise<void> {
      let current = writes;
      await current;
      while (current !== writes) {
        current = writes;
        await current;
      }
    },
    dispose(): void {
      disposed = true;
      pending.clear();
    },
  };
}
