/**
 * The persisted "seen" state behind the team and goal pills (UI-v7
 * persistence, 2026-11-08).
 *
 * Both pills hide a finished state only after the user opened its panel and
 * `./seen-close-gate` confirmed the close. That fact used to live in a plain
 * `Map` inside this client bundle, so every app restart (the bundle runs again)
 * — and every plugin reload — forgot it and a finished board/answer showed once
 * more. Paseo's plugin settings have exactly the right lifetime: one JSON
 * document per plugin on the host, surviving both an app restart and a daemon
 * restart (`~/.paseo/plugin-settings/<pluginId>/<settingsId>.json`).
 *
 * This module owns that document for one settings id, with the host injected so
 * it stays offline-testable:
 *
 * - **hydrate once at load.** The pills must not push a visibility decision
 *   before this answer (a registration starts `visible: false`), so an
 *   already-seen finished state never flashes on the composer.
 * - **write only from a confirmed close.** `remember` is called by a pill's
 *   `advanceSeen` when the seen signature actually changed — the `closed` event
 *   of the shared gate; polls never write.
 * - **degrade, never break.** A failed read (or a host without the settings RPC
 *   — older Paseo) hydrates an empty map: the pre-persistence behaviour of
 *   showing the finished state once more. A document the host refuses
 *   (`invalid`: an older version's envelope, a corrupt file) is repaired
 *   best-effort with the host's `reset` — the only write that does not re-parse
 *   the stored envelope — and falls back to the empty map if the host refuses
 *   that too. A failed write is reported once and the in-memory answer stays
 *   correct for this session.
 * - **conflict = re-read and merge once.** Another device on the same host may
 *   have written meanwhile; its other agents' entries are kept and this
 *   client's pending ones win. If the retry conflicts again, one `console.warn`
 *   names the settings id and agent ids (never the document); the entries stay
 *   pending for the next confirmed close — no polling retry.
 *
 * @module dsh-paseo/client/seen-persistence
 */
import { mergeSeenValues, seenMapOf, SEEN_SETTINGS_LIMIT } from "../shared/seen-settings";

/** What `settings.<id>.read` answers (the host's `SettingsReadResultSchema`). */
export type SeenSettingsRead =
  | { readonly status: "ready"; readonly revision: string; readonly values: unknown }
  | { readonly status: "invalid"; readonly revision: string; readonly error: string };

/** What `settings.<id>.write` answers (the host's `SettingsWriteResultSchema`). */
export type SeenSettingsWriteResult =
  | { readonly status: "saved"; readonly revision: string; readonly values: unknown }
  | { readonly status: "conflict"; readonly error: string }
  | { readonly status: "invalid"; readonly error: string };

/** The host the controller needs; the pill supplies the settings-RPC calls. */
export interface SeenSettingsIo {
  read(): Promise<SeenSettingsRead>;
  write(input: { revision: string; values: { seen: Record<string, string> } }): Promise<SeenSettingsWriteResult>;
  /**
   * Best-effort repair of a document the host refused (an older version's
   * envelope, a hand-edited file): the host's `reset` replaces the document
   * without re-parsing the stored envelope, unlike a `save`. Optional so a host
   * (or a test double) without it keeps the plain degradation.
   */
  reset?(input: { revision: string }): Promise<SeenSettingsWriteResult>;
  /** One console line per controller lifetime — a failing host must not spam. */
  onError(message: string, error?: unknown): void;
  /** One `console.warn` line for a write that stayed in conflict; never the document. */
  warn?(message: string): void;
  /** Injected so the harness can drive time; defaults to the global timers. */
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(handle: unknown): void;
}

/** Tuning for {@link createSeenPersistence}; the defaults are what the pills use. */
export interface SeenPersistenceOptions {
  /** How many entries the document keeps (the shared schema's cap). */
  limit?: number;
  /** How long a silent settings read may hold the first publish (default {@link SEEN_PERSISTENCE_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** The settings id the document lives under; used only in the conflict warning. */
  settingsId?: string;
  /** Called exactly once, after hydrate resolved (success or degrade), to re-present the pills. */
  onHydrated?: () => void;
}

/** The surface a pill uses: read the persisted fallback, remember a confirmed close. */
export interface SeenPersistence {
  /** Whether hydrate resolved; before that a pill must not publish a visibility decision. */
  ready(): boolean;
  /** Read the document once. Never rejects: a failed read degrades to an empty map. */
  hydrate(): Promise<void>;
  /** The persisted signature for one agent (pending local writes included); `undefined` when none. */
  get(agentId: string): string | undefined;
  /** Remember one agent's signature and schedule the document write. Never rejects. */
  remember(agentId: string, signature: string): void;
  /** Await hydration and every scheduled write (tests and teardown only). */
  flush(): Promise<void>;
  /** Drop pending writes; no further host calls. */
  dispose(): void;
}

/**
 * How long the pills wait for the first settings read before publishing anyway.
 *
 * The read is one plugin RPC (a few milliseconds on a healthy host); the bound
 * exists so a host that never answers cannot leave the pills silent forever —
 * timing out degrades to the old in-memory behaviour, not to a hidden pill.
 */
export const SEEN_PERSISTENCE_TIMEOUT_MS = 2000;

export function createSeenPersistence(io: SeenSettingsIo, options: SeenPersistenceOptions = {}): SeenPersistence {
  const limit = options.limit ?? SEEN_SETTINGS_LIMIT;
  const timeoutMs = options.timeoutMs ?? SEEN_PERSISTENCE_TIMEOUT_MS;
  const settingsId = options.settingsId ?? "seen";
  const setTimer = io.setTimeout ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer = io.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  /** The last document read from (or written to) the host. */
  let stored: Record<string, string> = {};
  /** Confirmed closes not yet written; they are also the freshest answer for `get`. */
  let pending = new Map<string, string>();
  /** The revision the last read/write answered; `undefined` until a read succeeds. */
  let revision: string | undefined;
  let hydrated = false;
  let disposed = false;
  let reported = false;
  let conflictWarned = false;
  let writes: Promise<void> = Promise.resolve();
  let hydration: Promise<void> | undefined;

  const report = (message: string, error?: unknown): void => {
    if (reported) return;
    reported = true;
    try {
      io.onError(message, error);
    } catch {
      /* a logging sink that throws must not break the pill */
    }
  };

  /**
   * One bounded operation; a silent host degrades instead of holding the pill
   * forever. `timeoutMessage` is reported when given — a bounded repair step
   * (the reset below) passes none, because it degrades silently.
   */
  const bounded = async <T>(work: Promise<T>, fallback: T, timeoutMessage?: string): Promise<T> => {
    let timer: unknown;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimer(() => {
        if (timeoutMessage !== undefined) report(timeoutMessage);
        resolve(fallback);
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimer(timer);
    }
  };

  /**
   * Best-effort `reset` of a document the host refused.
   *
   * The read can only *report* an `invalid` document; a `save` would re-parse
   * the stored envelope and be refused the same way on every attempt. The
   * host's `reset` is the one write that replaces the document without parsing
   * it (`PluginSettingsStore.write(…, "reset")`), so it repairs a corrupt or
   * older-version file in place. If the host has no reset (older Paseo) or
   * refuses it, the caller keeps the memory-only degradation.
   *
   * Bounded like the read: a host that never answers the reset must not hold
   * hydrate — `ready` would stay false and the pill could never show again — so
   * the shared timeout counts as a failed repair (empty map, old behaviour).
   */
  const resetDocument = async (currentRevision: string): Promise<boolean> => {
    if (io.reset === undefined) return false;
    try {
      // No timeout message: the read already degraded, and a repair that cannot
      // answer is not worth a second console line per session.
      const answer = await bounded<SeenSettingsWriteResult | null>(
        io.reset({ revision: currentRevision }),
        null,
      );
      if (answer === null || answer.status !== "saved") return false;
      revision = answer.revision;
      stored = seenMapOf((answer.values as { seen?: unknown } | null | undefined)?.["seen"]);
      return true;
    } catch {
      // Silent on purpose: the read already degraded, and one console line per
      // session about a document this host cannot repair is the noise the
      // repair exists to remove.
      return false;
    }
  };

  /** Read the document into `stored`/`revision`; `false` when it could not be read. */
  const readDocument = async (): Promise<boolean> => {
    let answer: SeenSettingsRead | null;
    try {
      answer = await bounded<SeenSettingsRead | null>(
        io.read(),
        null,
        "could not read the pills' \"seen\" settings; they stay in memory and a finished pill shows once more after a reload",
      );
    } catch (error) {
      report(
        "could not read the pills' \"seen\" settings; they stay in memory and a finished pill shows once more after a reload",
        error,
      );
      return false;
    }
    if (answer === null) return false;
    if (answer.status === "invalid") {
      // The host read the file but its schema refused it (an older version's
      // envelope, a hand-edited file). A `save` re-parses that envelope and is
      // refused again, so the document could never be repaired; `reset` is the
      // one write the host applies without parsing it. Best effort: a host that
      // has no reset (older Paseo) or refuses it keeps the memory-only fallback
      // — a finished pill then shows once more after a reload, never hidden.
      const repaired = await resetDocument(answer.revision);
      if (!repaired) {
        revision = answer.revision;
        stored = {};
      }
      return true;
    }
    revision = answer.revision;
    stored = seenMapOf((answer.values as { seen?: unknown } | null | undefined)?.["seen"]);
    return true;
  };

  const hydrate = (): Promise<void> => {
    if (hydration !== undefined) return hydration;
    hydration = (async () => {
      await readDocument();
      hydrated = true;
      if (disposed) return;
      try {
        options.onHydrated?.();
      } catch (error) {
        report("the pills' \"seen\" hydrate callback threw", error);
      }
    })();
    return hydration;
  };

  /**
   * One warning for a write that stayed in conflict after the retry.
   *
   * The pending entries are kept in memory and the next confirmed close retries;
   * this is a diagnostic only, so it names the settings id and the agent ids and
   * never the document's contents. `console.warn`, once per controller lifetime:
   * a second retry round must not turn into log noise.
   */
  const warnConflict = (): void => {
    if (conflictWarned || io.warn === undefined) {
      conflictWarned = true;
      return;
    }
    conflictWarned = true;
    const agentIds = [...pending.keys()];
    const shown = agentIds.slice(0, 3).join(",") + (agentIds.length > 3 ? `,+${String(agentIds.length - 3)}` : "");
    try {
      io.warn(
        `could not save the "seen" settings (${settingsId}) after a conflicting write from another client; ` +
          `agentId=${shown} stays in memory until the next confirmed close`,
      );
    } catch {
      /* a logging sink that throws must not break the pill */
    }
  };

  /** Write the pending entries over the stored document, once (retried once on conflict). */
  const persist = async (): Promise<void> => {
    if (disposed) return;
    let conflicted = false;
    for (let attempt = 0; attempt < 2 && !disposed; attempt += 1) {
      if (pending.size === 0) return;
      if (revision === undefined && !(await readDocument())) return;
      const updates = new Map(pending);
      const values = { seen: mergeSeenValues(stored, updates, limit) };
      let answer: SeenSettingsWriteResult;
      try {
        answer = await io.write({ revision: revision as string, values });
      } catch (error) {
        report(
          "could not save the pills' \"seen\" settings; the state stays in memory for this session",
          error,
        );
        return;
      }
      if (answer.status === "saved") {
        // The host echoes the normalised document; when its echo is not a map
        // (an older host answering oddly), trust exactly what this write sent.
        const echoed = seenMapOf((answer.values as { seen?: unknown } | null | undefined)?.["seen"]);
        stored = Object.keys(echoed).length > 0 ? echoed : values.seen;
        revision = answer.revision;
        // Only what this write carried is persisted: a `remember` that landed
        // while the write was in flight is a newer truth and stays pending.
        for (const [agentId, signature] of updates) {
          if (pending.get(agentId) === signature) pending.delete(agentId);
        }
        return;
      }
      if (answer.status === "conflict") {
        // Another client wrote meanwhile: re-read, then merge its other agents
        // with this client's pending entries and try once more. No polling
        // retry: the next confirmed close is what schedules the next write.
        conflicted = true;
        if (!(await readDocument())) return;
        continue;
      }
      report(`could not save the pills' "seen" settings (they stay in memory for this session): ${answer.error}`);
      return;
    }
    if (conflicted && pending.size > 0 && !disposed) warnConflict();
  };

  const enqueueWrite = (): void => {
    writes = writes.then(persist).catch(() => undefined);
  };

  return {
    ready: () => hydrated,
    hydrate,
    get(agentId: string): string | undefined {
      // A pending confirmed close is the freshest answer, the document the
      // fallback. There is deliberately **no per-session removal here**
      // (2026-11-09). A signature names the finished state it hides, and that
      // naming is narrower for one pill than the other: the goal pill's is
      // `goal-<uuid>:revision` (a new goal is a new uuid, so it can only be the
      // revision the user closed), while the team pill's is the all-done board's
      // `task-N:revision` set — unique within that agent's journal, but the task
      // ids are a counter, so a rewound or re-created board could in principle
      // mint the same set again. Masking the key on every removal never guarded
      // that case (it only covered removals); it just made a reconnect / retry /
      // terminal recovery show a state the user had already closed. Anything new
      // is a new signature and shows anyway, and a new confirmed close overwrites
      // this agent's entry.
      return pending.get(agentId) ?? stored[agentId];
    },
    remember(agentId: string, signature: string): void {
      if (agentId === "" || signature === "" || disposed) return;
      pending.set(agentId, signature);
      enqueueWrite();
    },
    async flush(): Promise<void> {
      await hydrate();
      let current = writes;
      await current;
      while (current !== writes) {
        current = writes;
        await current;
      }
    },
    dispose(): void {
      disposed = true;
      pending = new Map();
    },
  };
}