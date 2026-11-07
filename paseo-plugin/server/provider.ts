/**
 * The Paseo provider that drives DeepSeek Harness through the `paseo` DSH profile.
 *
 * One Paseo session maps onto one `dsh --profile paseo` process, because DSH
 * pins the working directory and initial route at `initialize`. The provider
 * reports DSH's real catalog — providers, models and each model's adapter-owned
 * reasoning efforts — so the composer offers only what the runtime can serve.
 *
 * @module dsh-paseo/server/provider
 */
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  negotiateProviderCapabilities,
  type ProviderCatalog,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderModel,
  type ProviderRegistration,
  type ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import {
  browserMcpGap,
  DshProcess,
  stableProcessCwd,
  validateMcpServers,
  type DshCatalog,
  type DshGoalView,
  type DshJob,
  type DshRevertResult,
  type DshRoute,
  type DshSettingsList,
} from "./dsh-process";
import {
  DSH_SETTINGS_ID_PREFIX,
  DshChildSession,
  DshSession,
  dshSettingBooleanValue,
  modes,
  parseRoute,
} from "./session";
import { rewindCanaryNotice } from "./rewind-canary";
import { beginRewindReport, fallbackNoticeDescription, type RewindReportFallback } from "./rewind-notice-append";
import { effortLabel, LOCALE, UI } from "./locale";
import { rewindSuccessText, type RewindTone } from "../shared/rewind-notice";
import type { GoalAction, GoalErrorCode, GoalState } from "../shared/goal";
import type { JobErrorCode } from "../shared/jobs";
import { teamViewSchema, type TeamErrorCode, type TeamView } from "../shared/team";
import { PROVIDER_ID } from "../shared/provider";

/**
 * The bridge's rewind receipt also carries fields the host-neutral wire type
 * predates:
 *
 * - `unrecoverable`: paths that changed after the target but whose pre-image
 *   could not be captured (too large, not a regular file, read failure);
 * - `error`: the file restore never ran because the post-durability re-plan
 *   failed, so there is no per-path outcome to report (and no rescue directory
 *   to point at).
 *
 * `DshRevertResult` is the stable wire shape other consumers share, so the extra
 * (optional) fields are narrowed here, at their single consumer. A bridge that
 * predates them omits both, which this reads as "no such condition".
 */
type RevertFilesReceipt = NonNullable<DshRevertResult["files"]> & {
  unrecoverable?: Array<{ path: string; reason: string }>;
  error?: string;
};

const CAPABILITIES = [
  "prompt.message",
  // Without this Paseo refuses to send any prompt carrying an image, so an
  // attached picture never reaches the bridge (the same class of silent loss as
  // an un-declared `prompt.steer`). The bridge already admits image blocks into
  // DSH's attachment store; declaring the capability is what makes Paseo use it.
  "prompt.image",
  // The `/` menu is capability-gated too: without `prompt.command` Paseo never
  // asks for DSH's commands, so its registered commands and user-invocable
  // skills are invisible.
  "prompt.command",
  "prompt.steer",
  "session.configure",
  // Without a persistence handle Paseo falls back to a raw session id that its
  // own decoder rejects on reopen, so a session orphaned by a plugin reload or
  // daemon restart can never be resumed ("Invalid plugin provider persistence
  // handle"). Declaring the capability and emitting a handle in `session.opened`
  // lets Paseo reopen the session, which DSH then resumes by id.
  "session.persistence",
  // Archiving is a first-class DSH concept (`workspaceRegistry.archiveSession`),
  // and Paseo maps its archive action onto a provider's native archive rather
  // than keeping a private flag — its opencode adapter's `setNativeSessionArchived`
  // is the reference. Without these two declared, Paseo archives locally, the
  // request never reaches us, and DSH silently never learns about it.
  "session.archive",
  "session.unarchive",
  // Advertises that DSH sessions can be enumerated and imported ("Import
  // session" lists providers that support this). Implemented over the session
  // log below.
  "session.list",
  // DSH's native subagents run as child sessions inside the root's own process.
  // Without this Paseo drops every provider-initiated child `session.opened`
  // (the daemon fails the connection when a parent did not negotiate it), so
  // the whole subagent tree is invisible. Declaring it is what makes Paseo
  // accept and display the children this provider opens.
  "session.subsession",
  // The rewind button under each message is capability-gated: Paseo only shows it
  // when the provider declares which scopes it can revert, and it hands the
  // request back with the `revertToken` our timeline row carried. This bridge
  // implements all three scopes: conversation only, conversation + the files the
  // agent's editing tools touched, and files only (restores the working tree and
  // deliberately leaves the conversation — and therefore the timeline — alone).
  // Paseo's menu offers the intersection of these bits and its own UI.
  "session.revert.both",
  "session.revert.conversation",
  "session.revert.files",
  "permission",
] as const;

/** Provider id registered with Paseo; distinct from the ACP `deepseek-harness` entry. */
export { PROVIDER_ID };

/**
 * One warning collected during an open and reported on the timeline once the
 * session is ready.
 */
interface OpenWarning {
  severity: "info" | "warning" | "error";
  title: string;
  description?: string;
}

/**
 * Last-resort route. The DSH profile's `agent-default-model` is the real source
 * of truth and is read from every catalog; this only backs a profile that
 * composes no default at all, so it deliberately names nothing anyone runs.
 */
const FALLBACK_ROUTE = { provider: "unset", model: "unset" };
const CATALOG_TTL_MS = 5 * 60 * 1000;
/**
 * How long the shared child survives its last release.
 *
 * Paseo closes a provider session and reopens it with the same persistence on a
 * refresh (and a daemon restart does the same); the grace period is what keeps
 * that from becoming a cold CLI boot (measured 1.5–2.7 s). It deliberately
 * equals {@link RELEASE_TIMEOUT_MS}, the bound teardown waits for the child to
 * exit: both answer "when is a child really gone", and two different numbers
 * would let a reopen land while the old child still holds the log's write lock.
 */
const POOL_RELEASE_GRACE_MS = 5_000;
/**
 * Upper bound on waiting for a retired child to release a session log.
 *
 * A DSH session log carries a kernel write lock (`SessionWriteLease` in
 * `@deepseek-ai/dsh-session-persistence-jsonl`) that outlives SIGTERM until the
 * OS reaps the process. A successor spawned before that fails to materialize the
 * session with "already owned by an active write handle", so this is the bound
 * teardown waits before letting the next open proceed.
 *
 * A timeout is reported rather than thrown: the open that follows surfaces the
 * lock conflict itself if there is one, and failing the teardown over a slow
 * reap would be a worse answer than a logged warning.
 */
const RELEASE_TIMEOUT_MS = 5_000;
/**
 * The session id the shared child is constructed with.
 *
 * `DshProcess` attaches its constructor id and `start()` initializes it, which is
 * what composes the LLM adapters and validates the route once per process. This
 * id is never prompted: every real session initializes its own id through
 * `attachSession`, and the bridge resolves cwd/route per session id
 * (`dsh-bridge/lib/server.js:648-668`). It is deliberately not a valid session id
 * shape so a leak into the bridge's tables is recognisable in a log.
 */
const POOL_PLACEHOLDER_SESSION_ID = "__paseo_shared_process__";

/**
 * Total budget for the native-subagent tree replay that runs before readiness.
 *
 * The replay must finish before `session.ready` so the host's hydrate snapshot
 * carries the replayed tree (that ordering is what keeps a reload from losing
 * the parent's provider-subagent rows). But it reads one child log per child
 * through the bridge, and every bridge request is itself bounded at 60 s: a
 * wedged bridge would otherwise hold the open for 60 + 60N seconds before the
 * conversation could even appear. This budget keeps both: a replay that settles
 * in time is awaited exactly as before, and one that does not is published past
 * immediately (the pre-fix open latency, bounded) while the replay keeps running
 * in the background — rows then arrive as their frames do, i.e. the pre-fix
 * behaviour. Normal replays are millisecond-scale local log reads, so the budget
 * only ever fires on an unhealthy bridge.
 */
const SUBAGENT_REPLAY_READY_BUDGET_MS = 4_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Await `work` for at most `ms`, reporting whether it settled inside the window.
 *
 * Expiry does **not** cancel `work`: the caller keeps it running in the
 * background and must own its continuation (including its rejection). The timer
 * is unref'd so a pending budget can never keep the process alive.
 *
 * @param work - promise whose settlement (value or throw) ends the wait.
 * @param ms - bounded wait in milliseconds.
 * @returns whether the work settled within the budget.
 */
function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    const settle = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    work.then(settle, settle);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * How many per-cwd catalogs the cache keeps.
 *
 * A single slot keyed by cwd meant two workspaces used alternately missed on
 * every request: each miss boots a whole `dsh` probe (1.5–2.7 s measured), so
 * the model picker paid a cold start every time the user switched projects. A
 * small LRU keeps the handful of workspaces a session actually alternates
 * between warm while staying bounded (a desktop user rarely has more than a few
 * open at once).
 */
const CATALOG_CACHE_LIMIT = 4;
/** One cached catalog, tagged with the cwd it belongs to and when it was read. */
interface CatalogCacheEntry {
  at: number;
  value: DisplayCatalog;
}
const catalogCache = new Map<string, CatalogCacheEntry>();

/**
 * Read a still-fresh catalog for `cwd` and mark it most recently used.
 *
 * @param cwd - workspace the catalog describes; the cache is keyed by it.
 * @returns the cached catalog, or undefined when missing/expired.
 */
function cachedCatalog(cwd: string): DisplayCatalog | undefined {
  const entry = catalogCache.get(cwd);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.at >= CATALOG_TTL_MS) {
    catalogCache.delete(cwd);
    return undefined;
  }
  // Re-inserting keeps the eviction order honest: LRU, not FIFO.
  catalogCache.delete(cwd);
  catalogCache.set(cwd, entry);
  return entry.value;
}

/**
 * Publish one freshly probed catalog and evict the least recently used entry.
 *
 * @param cwd - workspace the catalog was read for.
 * @param value - the display catalog to cache.
 */
function cacheCatalog(cwd: string, value: DisplayCatalog): void {
  catalogCache.delete(cwd);
  catalogCache.set(cwd, { at: Date.now(), value });
  while (catalogCache.size > CATALOG_CACHE_LIMIT) {
    const oldest = catalogCache.keys().next().value;
    if (oldest === undefined) return;
    catalogCache.delete(oldest);
  }
}

interface DisplayCatalog {
  models: ProviderModel[];
  thinkingOptions: ProviderThinkingOption[];
  /** The profile's configured default route, used when a session names none. */
  fallbackRoute: { provider: string; model: string };
  defaults: ProviderCatalog;
}

/**
 * A throwaway runtime used for reads and one-shot registry writes.
 *
 * It never sends `initialize`, so it creates no agent and no session log: it
 * boots the profile's services, answers one request, and is killed. The archive
 * set and the session store are global (a home-level storage domain and the
 * session root), so a probe run in any directory sees them.
 */
function probeProcess(cwd: string, sessionId: string): DshProcess {
  return new DshProcess({
    cwd,
    sessionId,
    route: FALLBACK_ROUTE,
    initializeRoute: false,
    onEvent: () => {},
    onStatus: () => {},
    onQuestion: async () => ({ answers: [] }),
    onLog: () => {},
    onExit: () => {},
    onProtocolError: () => {},
  });
}

/** Read the runtime catalog through a short-lived process and cache it by cwd. */
async function loadCatalog(cwd: string): Promise<DisplayCatalog> {
  const cached = cachedCatalog(cwd);
  if (cached !== undefined) return cached;
  const probe = probeProcess(cwd, "catalog-probe");
  try {
    await probe.start();
    const raw: DshCatalog = await probe.catalog();
    const value = toDisplayCatalog(raw);
    cacheCatalog(cwd, value);
    return value;
  } finally {
    probe.kill();
  }
}

/**
 * List DSH's importable sessions through a short-lived process.
 *
 * `probeCwd` only decides where the probe boots. The filter is separate and
 * optional: the bridge applies `cwd` as a realpath-aware superset filter
 * **before** it truncates to the limit, so forwarding the host's workspace is
 * what keeps another workspace's sessions from pushing this one's rows out of
 * the import list. Omitting it (the host sent no cwd) means "no filter", which
 * is why the field is only added when present.
 *
 * @param probeCwd - working directory for the throwaway probe process.
 * @param options - `cwd` filter plus the host's query/limit.
 */
async function listDshSessions(
  probeCwd: string,
  options: { cwd?: string; query?: string; limit?: number },
): Promise<Array<{ sessionId: string; cwd?: string; title?: string; createdAt?: number }>> {
  const probe = probeProcess(probeCwd, "sessions-probe");
  try {
    await probe.start();
    return await probe.sessions({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  } finally {
    probe.kill();
  }
}

/**
 * Apply one archive change through a throwaway runtime.
 *
 * This is the fallback for the archive Paseo performs on a session that is not
 * open — including the session itself, whose DSH process Paseo closes as part
 * of archiving it. Requiring a live process there meant the most common archive
 * click could never be honoured. DSH's archive set is a global storage domain,
 * and `unarchiveSession` needs no live session at all, so the probe can carry
 * it; a refusal (unknown session, active session, absent registry) still
 * throws, so a click that does nothing is never reported as success.
 */
async function applyArchivedStandalone(dshSessionId: string, archived: boolean): Promise<void> {
  const probe = probeProcess(process.cwd(), "archive-probe");
  try {
    await probe.start();
    const result = await probe.setArchived(dshSessionId, archived);
    if (!result.available) {
      throw new Error(result.error?.message ?? `${archived ? "archive" : "unarchive"} failed`);
    }
  } finally {
    probe.kill();
  }
}

function toDisplayCatalog(raw: DshCatalog): DisplayCatalog {
  const providerName = new Map(raw.providers.map((entry) => [entry.id, entry.name]));
  const models: ProviderModel[] = raw.models.map((model) => {
    const thinkingOptions = (model.reasoning?.efforts ?? []).map((effort) => ({
      id: effort.id,
      label: effortLabel(effort.id, effort.name),
      ...(effort.description === undefined ? {} : { description: effort.description }),
    }));
    return {
      // `provider/model` survives the round trip because DSH model ids carry no slash.
      id: `${model.provider}/${model.id}`,
      label: model.name,
      description: providerName.get(model.provider) ?? model.provider,
      ...(model.reasoning?.defaultEffort === undefined || thinkingOptions.length === 0
        ? {}
        : {
            defaultThinkingOptionId: thinkingOptions.some((option) => option.id === model.reasoning?.defaultEffort)
              ? model.reasoning.defaultEffort
              : thinkingOptions[0]?.id,
          }),
      ...(thinkingOptions.length === 0 ? {} : { thinkingOptions }),
    };
  });

  // Provider-wide options, so they must be ones *every* model declares. A union
  // offered the composer efforts some models cannot serve, and every dropped
  // choice snapped the selector back to off. Models keep their own list, so the
  // ones that do reason still show their real levels.
  const thinkingOptions: ProviderThinkingOption[] = (models[0]?.thinkingOptions ?? []).filter((option) =>
    models.every((model) => (model.thinkingOptions ?? []).some((entry) => entry.id === option.id)),
  );

  const defaultModel =
    raw.defaultProvider !== undefined && raw.defaultModel !== undefined
      ? `${raw.defaultProvider}/${raw.defaultModel}`
      : models[0]?.id;

  // A mode the runtime does not compose must not be advertised: Paseo renders the
  // selector from this list, and a pick the backend cannot apply is dropped (the
  // plan-mode switch then fails on `paseo/plan/set`). The bridge reports the truth
  // in `planMode`; an older bridge omits it, so absence keeps the previous list
  // rather than hiding a working mode.
  const providerModes = modes();
  const advertisedModes =
    raw.planMode === false ? providerModes.filter((mode) => mode.id !== "plan") : providerModes;

  // The provider-wide default has to be one of the provider-wide options. The
  // daemon applies `defaultThinkingOption` to every model that carries no default
  // of its own (`mapModel` in `@getpaseo/server`), so an effort outside the
  // intersection advertises a default some model cannot serve; the configure path
  // then drops it, which is a choice the user is shown and loses.
  const defaultThinkingOption =
    raw.defaultReasoningEffort !== undefined &&
    raw.defaultReasoningEffort !== null &&
    thinkingOptions.some((option) => option.id === raw.defaultReasoningEffort)
      ? raw.defaultReasoningEffort
      : undefined;

  return {
    models,
    thinkingOptions,
    fallbackRoute:
      raw.defaultProvider !== undefined && raw.defaultModel !== undefined
        ? { provider: raw.defaultProvider, model: raw.defaultModel }
        : FALLBACK_ROUTE,
    defaults: {
      models,
      modes: advertisedModes,
      thinkingOptions,
      ...(defaultModel === undefined ? {} : { defaultModel }),
      defaultMode: "build",
      ...(defaultThinkingOption === undefined ? {} : { defaultThinkingOption }),
    },
  };
}

class DshConnection implements ProviderConnection {
  readonly version = 1;
  readonly capabilities: readonly string[];
  readonly #listeners = new Set<(event: ProviderEvent) => void>();
  readonly #sessions = new Map<string, DshSession>();
  /**
   * DSH session ids with an `#open` transaction in flight.
   *
   * Two concurrent opens for one DSH session would both pass the holder check and
   * spawn a process, while only one can own the session log's write lock. The entry
   * is released when the open transaction ends (not when the session closes).
   */
  readonly #opening = new Set<string>();
  /**
   * Provider session ids with an open in flight, and whether that open was
   * invalidated by a close.
   *
   * A provider id is an identity too, not just a lookup key: Paseo reopens an
   * imported session under a fresh agent id, so the same provider id can be
   * rebound to a different native session. The claim has to cover both, and it
   * has to be taken in the same synchronous turn as the check — see
   * {@link #openTransaction}.
   */
  readonly #openingProviders = new Map<string, { nativeId: string; closed: boolean }>();
  #display: DisplayCatalog | undefined;
  #closed = false;
  /**
   * The one DeepSeek Harness process this connection shares between its sessions.
   *
   * Every session uses the same child. DSH itself takes the working directory and
   * the route **per session** (`initialize` carries a `sessionId`, the bridge
   * stores them per session, and `dsh-working-directory` resolves a session's cwd
   * as a projection — the runtime never calls `process.chdir`), so a single child
   * serves sessions in different workspaces exactly as DSH's own Web UI does
   * (`dsh-api-session-controller/lib/index.js:511`'s `createAgent(sessionId, cwd, …)`
   * takes the cwd as a per-session argument). MCP servers moved to a per-session
   * frame (`paseo/mcp/set`), so nothing that used to be process-wide is left to
   * justify one child per session.
   *
   * `#poolKey` is a **constant**: the key must be immutable for the process's
   * whole life, and every candidate derived from a session (cwd, route, the
   * per-agent `PASEO_AGENT_ID` in `config.env`) is either per-session or differs
   * per open. Including one of those would make the pool spawn a fresh child per
   * session while still being called a pool.
   */
  #pooled: DshProcess | undefined;
  /** In-flight spawn, so concurrent acquires share one child instead of racing. */
  #poolSpawn: Promise<DshProcess> | undefined;
  /**
   * In-flight pool shutdown, so an acquire cannot spawn beside a child that is
   * still being retired.
   *
   * `close()` and the idle grace timer can both shut the pool down, and the
   * shutdown itself is slow (a `shutdown` frame, then SIGTERM, then up to
   * {@link RELEASE_TIMEOUT_MS} for the OS to reap the child). Without this
   * marker the field `#pooled` is cleared at the *start* of that window, so an
   * open arriving inside it spawns a second child: two DSH processes with two
   * `archivedSessionIds` snapshots, racing each other for the session logs'
   * write locks. Kept as a promise (not a boolean) so an acquire can wait for
   * the retirement it collided with instead of failing its open.
   */
  #poolShutdown: Promise<void> | undefined;
  /**
   * The env the current child was spawned with.
   *
   * The environment is process-wide (`DshProcessOptions.env` is applied at
   * spawn) and a later session's `config.env` has no channel to it, so this is
   * only kept to *report* a divergence loudly instead of dropping it in silence
   * (see {@link #warnEnvDiffers}).
   */
  #poolEnv: Record<string, string> | undefined;
  /**
   * Outstanding claims, counted **per child instance**.
   *
   * This has to be keyed by the child, not a single number, because a child can
   * be retired and replaced while sessions still hold a claim on the old one.
   * The first version of this pool kept one counter and released it like this:
   *
   *     if (this.#pooled !== process) return;   // stale child -> bail out
   *     this.#poolRefs -= 1;
   *
   * That bail-out leaked a claim for every session holding the *old* child: the
   * counter never reached zero, so the child was never retired, and the next open
   * spawned yet another one. Measured on the fake bridge: 6 replacements and a
   * stuck `refs=1` after every session had closed. A session's claim must be
   * returnable no matter which child it was taken against.
   *
   * A child is retired when its own count reaches zero **and** the grace timer
   * expires: Paseo's refresh closes and immediately reopens the session, and
   * killing the child on the close would turn that fast path back into a cold
   * start (measured at 1.5–2.7 s of CLI boot). The timer matches the pool's
   * session-lock release bound so the two never disagree about when a child is
   * really gone.
   */
  readonly #poolClaims = new Map<DshProcess, number>();
  #poolReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * This connection's rewind counter, used to keep canary notices distinct.
   *
   * Two rewinds in one session each leave a notice behind on a host that cannot
   * truncate the rebuilt timeline, and a timestamp alone is not unique (two
   * clicks can land in the same second), so the counter is what makes the text
   * identifiable — see {@link rewindCanaryNotice}.
   */
  #rewindSeq = 0;

  constructor(capabilities: readonly string[]) {
    this.capabilities = capabilities;
  }

  /**
   * Outstanding claims on the shared child, as a read-only total.
   *
   * The claim count is the provider's own accounting, and the only way to prove
   * the pairing holds (one claim taken per open, returned per close) without
   * reaching into the provider's private state from a test. A harness used to
   * count `ParkedSessions.hold()` calls instead, but those were empty method
   * shells whose only observable behaviour *was* the instrumentation — which
   * proved the shell was called, not that a claim was balanced.
   *
   * Summed into a plain number, so a caller cannot mutate the accounting: there
   * is no map to hand out and no reference back into this provider. The sum
   * covers every child because a child can be retired and replaced while sessions
   * still hold claims on the old one (see {@link #poolClaims}).
   *
   * @returns the total number of claims this connection currently holds.
   */
  get poolClaimCount(): number {
    let total = 0;
    for (const count of this.#poolClaims.values()) total += count;
    return total;
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The open session serving one Paseo agent, if this connection has it.
   *
   * The pill asks by agent id while a provider session id is minted per open, so
   * the mapping has to be looked up. A child session is not a candidate: its jobs
   * belong to its own DSH session, and the pill is drawn for the composer's agent.
   *
   * @param agentId - Paseo's agent id (`config.env.PASEO_AGENT_ID`).
   * @returns the root session for that agent, or undefined when none is open.
   */
  sessionForAgent(agentId: string): DshSession | undefined {
    if (agentId === "") return undefined;
    for (const session of this.#sessions.values()) {
      if (session.paseoAgentId === agentId) return session;
    }
    return undefined;
  }

  async send(input: ProviderInput): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#dispatch(input);
    } catch (error) {
      const message = messageOf(error);
      if ("requestId" in input && typeof input.requestId === "string") {
        this.#emit({ type: "request.failed", requestId: input.requestId, error: { message } });
      } else if ("sessionId" in input && typeof input.sessionId === "string") {
        this.#emit({ type: "session.runtime_failed", sessionId: input.sessionId, error: { message } });
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    // Deregister before the awaits below: `readAgentJobs` must never walk a
    // connection that is tearing down, and a close that throws partway through
    // would otherwise leave it registered for the life of the process.
    CONNECTIONS.delete(this);
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#opening.clear();
    // Provider teardown is not a reload: shut the sessions down and retire the
    // shared child instead of keeping it alive for a reopen that will not happen
    // on this connection.
    await Promise.allSettled(sessions.map((session) => session.close({ park: false })));
    // Teardown owns the shared child: no grace period, no reuse. The sessions
    // above released their references, but the process must not outlive the
    // connection that spawned it (a daemon reload would otherwise leave an
    // orphan holding every session log's write lock).
    await this.#shutdownPool();
  }

  /**
   * The shared child if it is alive, else undefined.
   *
   * "Alive" is checked rather than assumed: the child can exit on its own (a
   * crash, an OOM kill, a `shutdown` frame) between two requests, and handing a
   * dead process to a caller produces a session that never answers instead of a
   * spawn.
   */
  #livePoolProcess(): DshProcess | undefined {
    const pooled = this.#pooled;
    if (pooled === undefined) return undefined;
    if (pooled.running) return pooled;
    // A child that died is not reusable, and leaving it in the field would make
    // `#acquirePoolProcess` believe a spawn already happened. Its claims go with
    // it: the sessions holding them are dead too (`DshProcess` reports that per
    // session through `#exitAll`), so keeping the counts would only make a future
    // child inherit a debt it never took on.
    this.#pooled = undefined;
    this.#poolEnv = undefined;
    this.#dropPoolClaims(pooled);
    return undefined;
  }

  /**
   * Get the shared child, spawning it if this connection has none.
   *
   * The returned process is started (its `start()` completed), so the caller can
   * attach a session to it immediately. Concurrent callers share one spawn: two
   * sessions opening at the same instant must not each create a child, because
   * the second one would then be an unreferenced process holding the same
   * session logs' write locks — the exact "two owners" state `#sessionHolding`
   * exists to prevent.
   *
   * `reused` tells the caller whether it **joined** a child that was already
   * serving other sessions. That is not cosmetic: a session joining a live child
   * shares its runtime, so a native subagent child that the previous provider
   * session never saw announced can still be running there. Reporting `reused`
   * lets the session tell "still live" apart from "killed", instead of either
   * resurrecting a dead child or cancelling a live one.
   *
   * The spawn uses the **first caller's** route/env as the process defaults.
   * That is deliberate and mostly harmless: every session sends its own cwd and
   * route in `initialize` (`attachSession`), so those defaults only cover a
   * request that names no session. **The cwd is the exception, and it is not a
   * session's**: the child is spawned in {@link stableProcessCwd}, a directory no
   * workspace owns. Anchoring the process to the first caller's workspace turned
   * `/proc/<pid>/cwd` into `(deleted)` as soon as that workspace was removed, and
   * then every session's bash calls failed with `spawn systemd-run ENOENT`
   * (FIELD-NOTES 91) — session cwd is unaffected because it travels per session.
   * **The environment is the other exception**: it is applied once at spawn and
   * DSH exposes no channel to change it per session, so a later session's
   * `config.env` cannot be honoured. That divergence is not swallowed —
   * {@link #warnEnvDiffers} reports every key that differs, and the keys are
   * handed back so the open can also put them on the timeline.
   *
   * @param options - the route/env to spawn with, when a spawn is needed.
   * @returns the live shared child, whether it was already serving sessions, and
   *   the env keys this session asked for that the child will not apply.
   */
  async #acquirePoolProcess(options: {
    route: DshRoute;
    env: Record<string, string>;
  }): Promise<{ process: DshProcess; reused: boolean; envDiffering: string[] }> {
    // `send()` guards only at its entry; an open that is already past it when
    // the connection is torn down must not spawn a child nobody owns.
    if (this.#closed) throw new Error("the provider connection is closed");
    // A shutdown still owns the child it is retiring. Wait for it (the shutdown
    // in turn waits for the child to exit) before deciding to spawn.
    await this.#awaitPoolShutdown();
    if (this.#closed) throw new Error("the provider connection is closed");
    const existing = this.#livePoolProcess();
    if (existing !== undefined) {
      this.#addPoolClaim(existing);
      this.#cancelPoolRelease();
      return { process: existing, reused: true, envDiffering: this.#warnEnvDiffers(options.env) };
    }
    const inFlight = this.#poolSpawn;
    if (inFlight !== undefined) {
      const shared = await inFlight;
      // The connection can be closed while this join awaits somebody else's
      // spawn. The claim is taken only after this check, so a close in that
      // window leaves nothing outstanding.
      if (this.#closed) throw new Error("the provider connection is closed");
      this.#addPoolClaim(shared);
      this.#cancelPoolRelease();
      // Somebody else's spawn: by the time this returns the child has another
      // session attached to it (or is about to), so this caller is joining.
      return { process: shared, reused: true, envDiffering: this.#warnEnvDiffers(options.env) };
    }
    const spawnTask = (async (): Promise<DshProcess> => {
      // A placeholder id, not a real conversation: `DshProcess` attaches its
      // constructor id at construction, and `start()` initializes that id. The
      // point of that initialize is to compose the LLM adapters and validate the
      // route once per process; each real session then initializes its own id
      // through `attachSession`, and the bridge answers `routeFor` per session
      // (`server.js:648-668`), so the placeholder never sees a prompt.
      const child = new DshProcess({
        // Not a session's cwd: this child outlives the session that spawned it,
        // and a workspace removed while it lives would leave the process cwd
        // dangling (`(deleted)`), breaking every session's bash. See
        // {@link stableProcessCwd}.
        cwd: stableProcessCwd(),
        route: options.route,
        sessionId: POOL_PLACEHOLDER_SESSION_ID,
        env: options.env,
        // MCP servers are per session now (`paseo/mcp/set`), so the process
        // default stays empty; `attachSession` carries each session's own map.
        onEvent: () => {},
        onStatus: () => {},
        onQuestion: async () => ({ answers: [] }),
        onChildOpened: () => {},
        // Settings are the profile's, not a session's: the bridge forwards one
        // process-level notification and this provider fans it out to every open
        // conversation (see `#onSettingsChanged`). A handler scoped to a single
        // session would leave the other sessions showing a stale switch.
        onSettingsChanged: (ns) => {
          this.#onSettingsChanged(ns);
        },
        onLog: (line) => process.stderr.write(`[${PROVIDER_ID}] ${line}\n`),
        onExit: (code, signal) => this.#onPoolExit(child, code, signal),
        onProtocolError: (message) => {
          process.stderr.write(`[${PROVIDER_ID}] protocol: ${message}\n`);
        },
      });
      try {
        await child.start();
      } catch (error) {
        // A child that never came up must not be left in the field: the next
        // acquire has to try again instead of reusing a corpse.
        child.kill();
        throw error;
      }
      return child;
    })();
    this.#poolSpawn = spawnTask;
    try {
      const started = await spawnTask;
      // Re-checked **after** the spawn: a `close()` that ran while `start()`
      // was in flight has already shut the pool down (there was no child to
      // wait for yet), so publishing this one would resurrect a process on a
      // dead connection. Its claim would never be released, no grace timer
      // would be armed, and the orphan would keep holding the session logs'
      // write locks. Kill it here — teardown no longer knows it exists.
      if (this.#closed) {
        started.kill();
        throw new Error("the provider connection is closed");
      }
      this.#pooled = started;
      this.#poolEnv = { ...options.env };
      this.#addPoolClaim(started);
      // Freshly spawned by this very call: the caller is not joining anything, so
      // its env is the one the child was born with and nothing can differ.
      return { process: started, reused: false, envDiffering: [] };
    } finally {
      // Cleared on failure too, so a retry spawns again rather than awaiting a
      // rejection nobody kept.
      if (this.#poolSpawn === spawnTask) this.#poolSpawn = undefined;
    }
  }

  /**
   * Record one claim on a child.
   *
   * Kept separate from {@link #releasePoolProcess} so both the join path and the
   * spawn path book the claim the same way; a claim taken by one and released by
   * the other is exactly the asymmetry that leaked before.
   *
   * @param process - the child the claim is against.
   */
  #addPoolClaim(process: DshProcess): void {
    this.#poolClaims.set(process, (this.#poolClaims.get(process) ?? 0) + 1);
  }

  /**
   * Forget every claim on one child.
   *
   * Used only where the child itself is going away (it exited on its own, or
   * `#shutdownPoolNow` is retiring it): the sessions that held those claims are
   * dead with it, and `DshProcess` has already reported that to each of them
   * (`#exitAll` / `onExit`). Their later `close()` returns early (the session is
   * already marked closed) and would never return the claim itself, so keeping
   * the numbers would leave the count above zero forever.
   *
   * @param process - the child whose claims become void.
   */
  #dropPoolClaims(process: DshProcess): void {
    this.#poolClaims.delete(process);
  }

  /**
   * Report a per-session `config.env` the shared child cannot apply.
   *
   * The environment is handed to `DshProcess` at spawn only; `attachSession`
   * carries cwd/route/MCP servers and has no env channel (adding one is a
   * `dsh-process.ts` change, out of this file's scope). So when a session joins
   * a child spawned with a different environment, its values are silently inert
   * unless this says so.
   *
   * Two keys are excluded because the daemon injects them **per agent**, not per
   * DSH process: `PASEO_AGENT_ID` and `PASEO_AGENT_CWD` (`agent-manager.js`
   * writes both into every open's env). They always differ between two agents,
   * so counting them would make every second session of a connection look like a
   * broken environment and bury the keys the user actually configured.
   *
   * The keys are reported, never the values: an env can hold a token, and the
   * stderr line is the one thing a user pastes into an issue.
   *
   * @param env - the joining session's `config.env`.
   * @returns the differing key names, in a stable order, or an empty array.
   */
  #warnEnvDiffers(env: Record<string, string>): string[] {
    const spawned = this.#poolEnv;
    if (spawned === undefined) return [];
    const differing: string[] = [];
    for (const key of new Set([...Object.keys(spawned), ...Object.keys(env)])) {
      if (key === "PASEO_AGENT_ID" || key === "PASEO_AGENT_CWD") continue;
      if (spawned[key] !== env[key]) differing.push(key);
    }
    if (differing.length === 0) return [];
    process.stderr.write(
      `[${PROVIDER_ID}] session env differs from the shared process's spawn env (${differing.join(", ")}): `
        + "the environment is process-wide, so the values the first session opened with stay in effect — these are NOT applied\n",
    );
    return differing;
  }

  /**
   * Drop one reference to the shared child, shutting it down when the last one goes.
   *
   * The claim is returned **against the child it was taken on**, never against
   * whatever `#pooled` happens to point at now. A session that opened onto a
   * child which has since been retired and replaced still owes exactly one claim
   * on the *old* child, and bailing out because `#pooled !== process` would leave
   * that claim outstanding forever — the counter would never reach zero, no child
   * would ever retire, and each open would spawn another one.
   *
   * The shutdown is **delayed** on purpose. Paseo's refresh closes the provider
   * session and reopens it a few milliseconds later; killing the child on the
   * close would turn that into a cold CLI boot (1.5–2.7 s) and lose the reuse
   * fast path entirely. The delay is the same bound teardown uses for a session
   * log's write lock, so a reopen inside the window reuses the child and one
   * outside it starts clean.
   *
   * @param process - the child the caller was using; an unknown one is ignored.
   */
  #releasePoolProcess(process: DshProcess): void {
    const held = this.#poolClaims.get(process) ?? 0;
    if (held <= 0) return;
    if (held === 1) this.#poolClaims.delete(process);
    else this.#poolClaims.set(process, held - 1);
    // A child that is no longer the pooled one has nothing left to schedule: its
    // remaining claims (if any) are still outstanding, and the pool already moved
    // on. Only the current child can be retired by this path.
    if (this.#pooled !== process) return;
    if (this.#claimsOf(process) > 0) return;
    this.#cancelPoolRelease();
    const timer = setTimeout(() => {
      this.#poolReleaseTimer = undefined;
      // Re-checked inside the timer: a session may have joined the same child in
      // the meantime (Paseo's close-then-reopen does exactly that).
      if (this.#pooled !== process) return;
      if (this.#claimsOf(process) > 0) return;
      void this.#shutdownPool();
    }, POOL_RELEASE_GRACE_MS);
    timer.unref?.();
    this.#poolReleaseTimer = timer;
  }

  /** Outstanding claims on one child; zero for a child the pool never handed out. */
  #claimsOf(process: DshProcess): number {
    return this.#poolClaims.get(process) ?? 0;
  }

  /** Cancel a pending idle shutdown (a new session took the child again). */
  #cancelPoolRelease(): void {
    if (this.#poolReleaseTimer === undefined) return;
    clearTimeout(this.#poolReleaseTimer);
    this.#poolReleaseTimer = undefined;
  }

  /**
   * Shut the shared child down for real and forget it.
   *
   * Called on provider teardown and by the idle grace timer. Serialized because
   * both can fire for the same child (a `close()` landing inside the grace
   * timer's shutdown): a second run would otherwise see `#pooled === undefined`
   * and report teardown as complete while the first is still sending SIGTERM,
   * letting the next acquire spawn a second child beside the dying one.
   *
   * @returns when this shutdown — including any earlier one it waited for — and
   *   the child's actual exit have completed.
   */
  #shutdownPool(): Promise<void> {
    const previous = this.#poolShutdown;
    const task = (async (): Promise<void> => {
      await previous?.catch(() => undefined);
      await this.#shutdownPoolNow();
    })();
    this.#poolShutdown = task;
    // Cleared after completion (settled either way) so `#awaitPoolShutdown`
    // cannot spin on a promise that will never change, and a later shutdown
    // starts from a clean slate.
    const clear = (): void => {
      if (this.#poolShutdown === task) this.#poolShutdown = undefined;
    };
    void task.then(clear, clear);
    return task;
  }

  /**
   * Wait until no pool shutdown is in flight.
   *
   * The loop re-reads the field because one wait can end just as another
   * shutdown begins (a teardown racing the grace timer); exiting on the first
   * resolution would let the caller spawn beside the new retirement.
   */
  async #awaitPoolShutdown(): Promise<void> {
    while (true) {
      const shutdown = this.#poolShutdown;
      if (shutdown === undefined) return;
      await shutdown.catch(() => undefined);
    }
  }

  /** One shutdown pass; see {@link #shutdownPool}. */
  async #shutdownPoolNow(): Promise<void> {
    this.#cancelPoolRelease();
    // An in-flight spawn is part of the pool. Clearing only the field (the old
    // behaviour) let `start()` finish afterwards and publish a child on a
    // connection that was already gone: nothing held its claim, no grace timer
    // was armed, and the orphan kept the session logs' write locks. Wait for the
    // spawn, then make sure its child is dead — the acquire path may have
    // already killed it (it re-checks `#closed` after its own await), in which
    // case `kill()` is idempotent.
    const spawn = this.#poolSpawn;
    this.#poolSpawn = undefined;
    if (spawn !== undefined) {
      try {
        const spawned = await spawn;
        // The acquire path publishes the child itself. Anything not published
        // is an orphan of this teardown and has no owner left to kill it.
        if (this.#pooled !== spawned) spawned.kill();
      } catch {
        // The spawn failed and killed its own child; nothing to retire.
      }
    }
    const pooled = this.#pooled;
    this.#pooled = undefined;
    this.#poolEnv = undefined;
    if (pooled === undefined) return;
    // Only this child's claims are dropped. Other children can still have
    // outstanding claims (a session that opened onto a child which was later
    // replaced); clearing the whole map would make those claims unreleasable and
    // is exactly the "reset the accounting" shortcut that hid the leak before.
    this.#dropPoolClaims(pooled);
    await pooled.shutdown();
    // `shutdown()` returns after the frame reply and SIGTERM, but the session
    // logs' kernel write locks are released only once the OS reaps the child. A
    // spawn into that window fails every session-scoped request with "already
    // owned by an active write handle" — which is why this waits, bounded, for the
    // reap. A timeout is reported, not thrown: the open that follows will surface
    // the lock conflict itself if there is one.
    const exited = await pooled.waitForExit(RELEASE_TIMEOUT_MS);
    if (!exited) {
      process.stderr.write(
        `[${PROVIDER_ID}] the shared DeepSeek Harness process did not exit within ${String(RELEASE_TIMEOUT_MS)}ms of its shutdown; the next open may race its session log lock\n`,
      );
    }
  }

  /**
   * The shared child exited on its own.
   *
   * Every session that was attached to it is dead, and `DshProcess` already
   * reports that per session (`#exitAll` → each session's `onExit`, which emits
   * `session.runtime_failed`). What is left is the pool's own bookkeeping: drop
   * the corpse so the next open spawns a fresh child instead of reusing a dead
   * one, and clear the reference count so that spawn starts from zero.
   */
  #onPoolExit(child: DshProcess, code: number | null, signal: string | null): void {
    if (this.#pooled !== child) return;
    process.stderr.write(
      `[${PROVIDER_ID}] the shared DeepSeek Harness process exited (code ${code ?? "null"}, signal ${signal ?? "none"}); `
        + "the next session open will spawn a new one\n",
    );
    this.#pooled = undefined;
    this.#poolSpawn = undefined;
    this.#poolEnv = undefined;
    // The child is gone, so every claim on it is void: the sessions that held
    // them are dead too (each was told through `#exitAll`). Dropping only this
    // child's entry keeps any older child's claims intact for their own release.
    this.#dropPoolClaims(child);
    this.#cancelPoolRelease();
  }

  /**
   * One DSH settings document changed; republish the composer for every open
   * conversation.
   *
   * The switch value lives in the DSH profile, which one child serves for the
   * whole connection, so a change is process-wide by construction. The bridge
   * only names the namespace; each session re-reads the authoritative value and
   * the provider republishes `session.config` only for sessions whose projected
   * settings actually changed — re-emitting on every notification would make the
   * composer flicker for sessions that share the same value.
   *
   * Failures are logged, never thrown: this runs off a notification, and a dead
   * or closing session must not turn a settings refresh into an unhandled
   * rejection.
   *
   * @param ns - the profile entry id whose settings document changed.
   */
  #onSettingsChanged(ns: string): void {
    void this.#refreshSettings(ns);
  }

  /**
   * Re-read the DSH switches once and republish the sessions whose value changed.
   *
   * The settings document belongs to the profile, and one child serves every
   * conversation, so the authoritative read is connection-wide: reading it once
   * and fanning the projection out keeps a notification from costing one
   * `describe()` (a real configuration composition) per open session.
   *
   * The read goes through the first open session that still answers, not
   * `sessions[0]` unconditionally. A session can be mid-close or its shared
   * process can be gone; every other open session reads the same profile-wide
   * document, so falling through to the next one keeps the change from being
   * dropped for every conversation (the narrow window this guards against is
   * exactly when an external writer changed the switch). Only when every open
   * session fails is that a real read failure worth a stderr line.
   *
   * @param ns - the changed namespace, for the log line only.
   */
  async #refreshSettings(ns: string): Promise<void> {
    const sessions = [...this.#sessions.values()].filter(
      (session): session is DshSession => session instanceof DshSession,
    );
    if (sessions.length === 0) return;
    let list: DshSettingsList | undefined;
    let lastError: unknown;
    for (const session of sessions) {
      try {
        list = await session.readDshSettings();
        break;
      } catch (error) {
        // Try the next still-open session; it shares the same profile document.
        lastError = error;
      }
    }
    if (list === undefined) {
      process.stderr.write(
        `[${PROVIDER_ID}] re-reading DSH settings after "${ns}" failed for every open session: `
          + `${messageOf(lastError)}\n`,
      );
      return;
    }
    for (const session of sessions) {
      // The session may have closed while the read was in flight.
      if (this.#sessions.get(session.id) !== session) continue;
      if (!session.applyDshSettings(list)) continue;
      this.#emit({ type: "session.config", sessionId: session.id, config: session.configState() });
    }
  }

  async #dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        return this.#catalog(input.requestId, input.cwd);
      case "sessions":
        return this.#listSessions(input);
      case "session.open":
        return this.#openTransaction(input);
      case "session.archive":
      case "session.unarchive": {
        const archived = input.type === "session.archive";
        await this.#setArchived(input.persistence, archived);
        // Paseo awaits `complete()` for this request and resolves it only on a
        // request reply, so a silent success would hang the archive click
        // forever. Failures are emitted by `send()`'s catch; this is the
        // success half that makes the round trip observable at all.
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.prompt": {
        return this.#require(input.sessionId).prompt(input.prompt);
      }
      case "session.permission":
        this.#require(input.sessionId).resolvePermission(input.permissionId, input.response);
        return;
      case "session.configure": {
        const session = this.#require(input.sessionId);
        try {
          await session.configure(input.changes);
        } catch (error) {
          // A configure carries several fields and can be refused part-way (the
          // model switch applied, then a locked preset was rejected). The session
          // commits each field only after the runtime confirms it, so by the time
          // the request fails the committed state may already differ from the
          // composer's optimistic view. Publish that state before reporting the
          // failure: otherwise the last `session.config` the host saw describes
          // values the runtime never accepted, and nothing corrects it until the
          // next successful configure or reopen.
          this.#emit({ type: "session.config", sessionId: input.sessionId, config: session.configState() });
          throw error;
        }
        this.#emit({ type: "session.config", sessionId: input.sessionId, config: session.configState() });
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.revert": {
        const session = this.#require(input.sessionId);
        // The report row is addressed by Paseo's **agent** id: a plugin reload
        // mints a new provider session id for the same agent, and the daemon's
        // timeline is keyed by agent. A root session always carries it; a child
        // session throws inside `revert()` before returning. A missing id is a
        // shape this provider does not expect, so it is reported loudly and the
        // report takes the provider-notice path instead of being guessed at.
        const agentId = session instanceof DshSession ? session.paseoAgentId ?? "" : "";
        if (agentId === "") {
          process.stderr.write(
            `[${PROVIDER_ID}] rewind of provider session ${input.sessionId} carries no PASEO_AGENT_ID; `
              + "the completion report cannot be appended to the timeline and will be sent as a provider "
              + "notice, which the rewind run lock may drop\n",
          );
        }
        // Arm the report **before** the revert. Conversation and `both` rewinds
        // rebuild the timeline inside the host and dispatch
        // `agent.timeline.replacement` after the receipt; a subscription
        // established after that event would miss it and the appended row would
        // be wiped by the rebuild (see server/rewind-notice-append).
        const delivery = agentId === ""
          ? null
          : beginRewindReport(agentId, input.scope, this.#reportFallback(input.sessionId));
        /** Deliver one report through the append path, or the notice fallback. */
        const deliver = (message: string, tone: RewindTone): void => {
          if (delivery === null) {
            this.#reportFallback(input.sessionId)({ agentId, scope: input.scope, tone, message });
            return;
          }
          delivery.deliver({ message, tone });
        };
        // The subscription is acknowledged before the revert is sent, so the
        // replacement event cannot be dispatched into the gap. Bounded: a host
        // that never acknowledges must not hold the rewind hostage (the report
        // then waits out its own timeout and appends anyway).
        if (delivery !== null) await delivery.ready;
        // Child sessions throw before returning; the root session returns the bridge receipt.
        // Concurrency is the bridge's job: it already refuses a second rewind on the
        // same session with "该会话已有撤回正在进行" (`dsh-bridge/lib/server.js` revertInflight).
        let result: DshRevertResult | undefined;
        try {
          result = (await session.revert(input.token, input.scope)) as DshRevertResult | undefined;
        } catch (error) {
          // Nothing to report: release the timeline subscription the delivery
          // opened before the revert.
          delivery?.cancel();
          throw error;
        }
        // The rewind itself needs no refresh: the daemon rebuilds the timeline from
        // `PluginProviderSession.streamHistory()` right after this reply. Whether the
        // withdrawn rows actually disappear depends on the host, though, and the
        // provider cannot tell which host it is talking to (it runs in its own
        // process; there is no capability bit for "truncates history").
        //
        // So the canary goes out **before** the receipt, and the order is the whole
        // mechanism:
        //
        // - A host that truncates (the local patch, or upstream once it does) cuts
        //   the buffer at the rewound row inside the microtask that resolves the
        //   receipt. Events share one ordered IPC channel, so a notice sent first is
        //   already in that buffer and gets cut with the withdrawn rows — it flashes
        //   past and is gone, which is correct: there is nothing to warn about.
        // - A host that does not truncate keeps the withdrawn rows, so the notice
        //   survives, sits at the bottom of the timeline, and tells the user the
        //   screen is stale and how to refresh.
        //
        // Emitting it *after* the receipt inverts that: the truncation has already
        // happened, so the notice survives on the patched host too — the exact false
        // "your timeline is stale" warning this is meant to avoid (reproduced on the
        // real host code, `harness/host-contract-sim.mjs`).
        //
        // A `files`-only rewind leaves the conversation alone, so there is nothing
        // for the user to reload and no canary.
        if (input.scope !== "files") {
          this.#rewindSeq += 1;
          const canary = rewindCanaryNotice({
            at: new Date(),
            seq: this.#rewindSeq,
            files: input.scope === "both",
          });
          this.#notice(input.sessionId, "info", canary.title, canary.description);
        }
        this.#emit({ type: "request.completed", requestId: input.requestId });
        const files = result?.files as RevertFilesReceipt | undefined;
        const failedFiles = files?.failed ?? [];
        const skippedFiles = files?.skipped ?? [];
        const unrecoverable = files?.unrecoverable ?? [];
        // The bridge sends `error` instead of per-path outcomes when the file
        // restore was aborted before it could run (the post-durability re-plan
        // failed). Treat a non-empty one as its own failure kind: the paths above
        // are empty in that shape, and the receipt's `rescueDir` is empty too, so
        // the failed-path wording must not be reused.
        const planError = typeof files?.error === "string" && files.error !== "" ? files.error : undefined;
        if (
          planError !== undefined
          || failedFiles.length > 0
          || skippedFiles.length > 0
          || unrecoverable.length > 0
        ) {
          // The conversation rewind succeeded; only some files did not. This is a
          // real failure report, so it is appended as a warning row on the
          // timeline — the one channel the rewind's run lock cannot swallow (see
          // `server/rewind-notice-append`).
          //
          // `skipped` must be part of this condition. It used to be invisible: a
          // path the restore refused to touch (now a symlink/directory, or whose
          // parent was replaced) still produced the plain success notice while
          // the file stayed modified. A capture that could never be taken (too
          // large, not a regular file, read error) is just as unrestored and now
          // reaches the same list through `unrecoverable`; there is no backup to
          // retry with, so the wording must not promise one for it.
          const parts: string[] = [];
          // Verbatim, as its own part: the bridge's text names both the cause and
          // where the journal is, and rewriting it here would drift from the half
          // that actually knows what failed.
          if (planError !== undefined) parts.push(planError);
          if (failedFiles.length > 0) {
            parts.push(`${failedFiles.map((entry) => entry.path).join("、")} 恢复失败（撤回前备份已保留，可重试撤回）`);
          }
          // The bridge folds `unrecoverable` paths into `skipped` for consumers
          // that only know the older field; they are reported once here, with the
          // reason, rather than again as generic skipped paths.
          const unrecoverablePaths = new Set(unrecoverable.map((entry) => entry.path));
          const skippedOnly = skippedFiles.filter((file) => !unrecoverablePaths.has(file));
          if (skippedOnly.length > 0) {
            parts.push(`${skippedOnly.join("、")} 未能恢复（路径已变化，撤回前备份已保留）`);
          }
          if (unrecoverable.length > 0) {
            parts.push(
              `${unrecoverable.map((entry) => `${entry.path}（${entry.reason}）`).join("、")} 未能快照，无法恢复`,
            );
          }
          // No rescue directory is claimed when the restore never ran: there is
          // nothing in it, and the `error` shape deliberately sends `rescueDir`
          // empty. The bridge's own text already names the journal.
          const rescueDir = files?.rescueDir ?? "(未知目录)";
          const tail = planError !== undefined
            ? ""
            : `${
              failedFiles.length > 0
                ? `被替换的当前内容已另存到 ${rescueDir}。`
                : `journal 与 rescue 目录：${rescueDir}。`
            }`;
          deliver(
            tail === "" ? `文件回退未完成\n${parts.join("；")}` : `文件回退未完成\n${parts.join("；")}。${tail}`,
            "warning",
          );
          // A partial rewind gets exactly one report: the failure above. A
          // success line next to it would read as "the conversation is fine and
          // the files are fine", which is the one thing this outcome is not.
          return;
        }
        // The success report is appended as a plugin timeline row, never as a
        // provider notice: the host holds a foreground run lock for the whole
        // rewind and drops every provider event sent while it is pending, which
        // is why the old notice was queued behind a guessed delay and was lost
        // on a real 1128 ms rewind. `timeline.append` bypasses that lock, and
        // the row is not part of the provider history a rebuild replays, so it
        // cannot reappear as a stale line on a later rewind. The canary above is
        // different copy with a different job (it says the timeline may be stale
        // and how to refresh); mixing the two would break its meaning.
        //
        // Counts come from the bridge receipt's own `files.restored` /
        // `files.deleted` arrays (`RevertFilesReceipt`). When the receipt has no
        // file half, the copy says nothing changed; when it has one but the
        // arrays cannot be read, `rewindSuccessText` falls back to a sentence
        // without a number rather than inventing one.
        deliver(rewindSuccessText(UI.rewind, input.scope, files), "success");
        return;
      }
      case "session.interrupt": {
        await this.#require(input.sessionId).interrupt();
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.close": {
        // Invalidate an open still in flight for this provider id: the daemon
        // asked for the session to be gone, so the open must not go on to
        // publish readiness for it (or re-create it) after this point.
        const opening = this.#openingProviders.get(input.sessionId);
        if (opening !== undefined) opening.closed = true;
        const session = this.#sessions.get(input.sessionId);
        // The daemon can close this session and immediately reopen it on the same
        // persistence handle, so a prompt landing in that window must still get a
        // readable refusal — otherwise it surfaces as `runtime_failed`.
        this.#sessions.delete(input.sessionId);
        // Park an idle child: the daemon closes this session right before a
        // refresh reopens it with the same persistence. `park` has **no
        // effect** under one shared process (`DshSession.close` never parks a
        // child it does not own); the flag is kept for the session API and must
        // not be read as "this child survives the close".
        await session?.close({ park: true });
        this.#emit({ type: "session.closed", sessionId: input.sessionId });
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      default: {
        // Every `ProviderInput` variant is handled above, so this is a net for an
        // SDK upgrade that adds one: reporting `request.completed` here would make
        // an unimplemented request indistinguishable from a finished one, so the
        // cast is only to keep the net compiling while the union is exhaustive.
        const unhandled = input as { requestId?: string; type: string };
        this.#emit({
          type: "request.failed",
          requestId: unhandled.requestId ?? "",
          error: { message: `unsupported provider input "${unhandled.type}"` },
        });
        return;
      }
    }
  }

  async #catalog(requestId: string, cwd: string | undefined): Promise<void> {
    try {
      const display = await loadCatalog(cwd ?? process.cwd());
      this.#display = display;
      this.#emit({ type: "catalog", requestId, catalog: display.defaults });
    } catch (error) {
      // A failed probe must still answer the request. Leaving it unanswered
      // made Paseo wait out its 60s timeout and report "did not answer
      // paseo/catalog" instead of the real cause — typically `dsh` missing
      // from PATH after a node version switch.
      this.#emit({
        type: "request.failed",
        requestId,
        error: { message: messageOf(error) },
      });
    }
  }

  /** List DSH's stored sessions so Paseo can offer to import them. */
  async #listSessions(input: Extract<ProviderInput, { type: "sessions" }>): Promise<void> {
    const cwd = input.cwd ?? process.cwd();
    let sessions: Array<{ sessionId: string; cwd?: string; title?: string; preview?: string; updatedAt?: string }>;
    try {
      sessions = await listDshSessions(cwd, {
        // The host's cwd is both where the probe boots and what the bridge must
        // filter by. Only the first half used to be wired, so the import list
        // was unfiltered: with 20-odd stored sessions the current workspace's
        // rows were pushed out by other workspaces' rows.
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    } catch (error) {
      this.#emit({ type: "request.failed", requestId: input.requestId, error: { message: messageOf(error) } });
      return;
    }
    this.#emit({
      type: "sessions",
      requestId: input.requestId,
      sessions: sessions.map((session) => ({
        persistence: { version: 1, data: { sessionId: session.sessionId } },
        cwd: session.cwd ?? cwd,
        ...(session.title === undefined ? {} : { title: session.title }),
        // A short first-message preview, so rows with the same title still differ.
        ...(session.preview === undefined ? {} : { description: session.preview }),
        ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
      })),
    });
  }

  /**
   * Emit one provider notice, which Paseo renders as a timeline notification.
   *
   * Notices are the only channel a provider has for telling the user about a
   * partial outcome (e.g. the conversation was rewound but one file restore
   * failed) or a divergence it cannot fix (a per-session env the shared process
   * cannot apply).
   *
   * Whether a notice **survives** depends on where it is emitted, and the rewind
   * branch depends on exactly that: a host that truncates its history buffer at
   * the rewound row drops everything in it before the receipt resolves, which is
   * what makes the rewind canary disappear on a refreshed timeline (see the
   * `session.revert` branch). That is only the first of two windows a rewind
   * opens: the host also holds a foreground run lock until the whole rewind
   * settles and drops every provider event sent while it is pending, so a
   * rewind's completion report is **not** a notice at all — it is appended as a
   * plugin timeline row (see `./rewind-notice-append`). A notice from this
   * module is either the canary (sent before the receipt on purpose) or the
   * best-effort fallback used when an append fails.
   *
   * A notice for a session this connection no longer tracks has nowhere to go:
   * it is logged rather than queued, because there is no reopen to deliver it to
   * (the daemon mints a fresh provider session id per open).
   *
   * @param sessionId - provider session the notice belongs to.
   * @param severity - provider notice severity.
   * @param title - one-line headline.
   * @param description - optional detail.
   */
  #notice(sessionId: string, severity: "info" | "warning" | "error", title: string, description?: string): void {
    if (!this.#sessions.has(sessionId)) {
      process.stderr.write(`[${PROVIDER_ID}] dropping notice "${title}": ${sessionId} is not an open session\n`);
      return;
    }
    this.#emit({
      type: "session.notice",
      sessionId,
      notice: {
        id: `rewind-${String(Date.now())}-${String(Math.trunc(Math.random() * 1e6))}`,
        severity,
        title,
        ...(description === undefined ? {} : { description }),
      },
    });
  }

  /**
   * The fallback used when a report cannot be appended to the timeline.
   *
   * A provider notice sent from the rewind branch is dropped while the host
   * holds the rewind's run lock (see the `session.revert` branch), so this is a
   * best-effort second path, not a second guarantee: the append is what makes
   * the report deterministic. It exists so an append failure is never silent.
   *
   * The notice's title is the report's own copy — the same text the client's
   * legacy-row filter removes from a rebuilt timeline — so the description
   * carries the degraded-delivery marker (`fallbackNoticeDescription`). Without
   * it the client would hide this fallback too and the failure would be
   * invisible again.
   */
  #reportFallback(sessionId: string): RewindReportFallback {
    return (report) => {
      const [title = "", ...detail] = report.message.split("\n");
      this.#notice(
        sessionId,
        report.tone === "warning" ? "warning" : "info",
        title,
        fallbackNoticeDescription(LOCALE, detail.join("\n")),
      );
    };
  }

  /**
   * Claim both identities an open transaction owns, before its first await.
   *
   * The `#opening` guard alone was not enough, for two reasons that are both
   * about *when* the claim is taken relative to the work it protects:
   *
   * 1. It was taken after `loadCatalog()` and after the holder teardown below,
   *    and both await. A second open for the same DSH session could pass the
   *    check in that window, finish first, and then the first one — waking up —
   *    overwrote its `#sessions` entry, failed `attachSession` with "already
   *    attached", and its catch deleted the *winner's* entry and bridge session.
   *    Paseo had been told the winner was ready, yet every prompt on it failed
   *    with "unknown session".
   * 2. It only covered the native DSH id. Paseo reopens an imported session
   *    under a fresh agent id, so the same **provider** id can be rebound to a
   *    different native session while an open for it is still running; the
   *    rebinding open then owns an id whose first open is about to publish.
   *
   * Claiming both ids in the same synchronous turn as the checks turns the loser
   * into a loud refusal, which is the honest answer: Paseo mints a fresh
   * provider session id per open, so two concurrent opens are a caller bug, not
   * a reload. The claims are released when the transaction ends (success or
   * failure), not when the session closes.
   */
  async #openTransaction(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const data = input.persistence?.data;
    const nativeId = isRecord(data) && typeof data["sessionId"] === "string"
      ? data["sessionId"] : input.sessionId;
    if (this.#opening.has(nativeId)) {
      throw new Error(
        `cannot open ${input.sessionId}: another open for DSH session ${nativeId} is already in flight`,
      );
    }
    if (this.#openingProviders.has(input.sessionId)) {
      throw new Error(
        `cannot open ${input.sessionId}: another open for this provider session is already in flight`,
      );
    }
    const opening = { nativeId, closed: false };
    this.#opening.add(nativeId);
    this.#openingProviders.set(input.sessionId, opening);
    try {
      await this.#open(input, opening);
    } finally {
      // Retain both claims through failure cleanup: a closing old instance must
      // never dispose a new instance that reused the same native identity.
      this.#opening.delete(nativeId);
      if (this.#openingProviders.get(input.sessionId) === opening) {
        this.#openingProviders.delete(input.sessionId);
      }
    }
  }

  /**
   * Throw when the open transaction that is about to publish no longer owns what
   * it is publishing for.
   *
   * Three things can invalidate it, and all three are silent without this check:
   * the connection was torn down, the provider session was closed while the open
   * was running, or a later open took over the same provider id.
   *
   * `session` is passed only once the instance exists. Its test is the
   * `#sessions` identity, not a closed flag on the instance: `session.close`
   * deletes the map entry **before** it awaits the instance's own teardown, so
   * "no longer the tracked instance" is already true for the whole close, and
   * it also covers a later open having replaced the entry.
   *
   * @param sessionId - provider session this open is publishing for.
   * @param opening - the claim `#openTransaction` took.
   * @param session - the instance, once constructed.
   */
  #assertOpening(
    sessionId: string,
    opening: { nativeId: string; closed: boolean },
    session?: DshSession,
  ): void {
    this.#assertConnected();
    if (opening.closed || this.#openingProviders.get(sessionId) !== opening
      || (session !== undefined && this.#sessions.get(sessionId) !== session)) {
      throw new Error(`session ${sessionId} was closed while it was opening`);
    }
  }

  async #open(
    input: Extract<ProviderInput, { type: "session.open" }>,
    opening: { nativeId: string; closed: boolean },
  ): Promise<void> {
    const { sessionId, config } = input;
    // `send()` guards only at its entry. An open still running when the
    // connection is torn down would otherwise go on to spawn/attach and emit
    // `session.opened` / `session.ready` on a connection the daemon has already
    // dropped. The second check inside the transaction covers a teardown that
    // lands while the open is in flight.
    this.#assertConnected();
    const display = this.#display ?? (await loadCatalog(config.cwd));
    this.#display = display;
    // The catalog load awaits, so the claim taken by `#openTransaction` is
    // re-checked before anything is torn down or spawned on its behalf.
    this.#assertOpening(sessionId, opening);

    // DSH's session id: the Paseo-minted one normally, but the native id when
    // Paseo reopens an imported session under a fresh agent id. Resolved by
    // `#openTransaction` because the claim is keyed by it.
    const dshSessionId = opening.nativeId;

    // The daemon injects the Paseo agent id into the provider session env. It
    // scopes native child ids so a reload upserts the same Paseo rows instead of
    // duplicating the subagent tree (see `DshSessionOptions.agentId`).
    const agentId = typeof config.env?.["PASEO_AGENT_ID"] === "string"
      ? config.env["PASEO_AGENT_ID"].trim()
      : "";

    const route = parseRoute(config.model, display.fallbackRoute);

    // One DSH session can be materialized by one process only: its log carries a
    // kernel write lock (`SessionWriteLease` in
    // `@deepseek-ai/dsh-session-persistence-jsonl`), so a second live owner fails
    // every session-scoped request with "already owned by an active write handle".
    // Paseo normally closes the previous provider session before opening the next
    // one (that is what its refresh does), so a holder here is an anomaly;
    // leaving both alive makes both unusable, and this provider used to report the
    // new one ready with an empty `/` menu. Resolve it the same way: close the
    // session that already holds this DSH session first — its claim on the shared
    // child is returned and the open below re-takes one, so nothing is killed
    // unnecessarily.
    // If that close fails the open fails loudly: guessing would leave an unknown
    // number of owners.
    const holder = this.#sessionHolding(dshSessionId, sessionId);
    if (holder !== undefined) {
      process.stderr.write(
        `[${PROVIDER_ID}] DSH session ${dshSessionId} is already held by provider session ${holder.id}; closing it before opening ${sessionId}\n`,
      );
      try {
        // Close first, forget after: if the close throws, the session stays tracked
        // (its own `close()` is idempotent, so a retry takes the same path) instead
        // of leaving an untracked live process that still owns the session log.
        // `park: true` is a no-op under one shared process (see `session.close`).
        await holder.close({ park: true });
      } catch (error) {
        throw new Error(
          `cannot open ${sessionId}: DSH session ${dshSessionId} is held by provider session ${holder.id} and `
            + `closing it failed (${messageOf(error)})`,
        );
      }
      // Forget after the close, and only if the entry is still this holder. The
      // close awaits, so a later open can have replaced `#sessions[holder.id]`
      // in the meantime; deleting by key alone would then drop *that* session's
      // entry — the "one open destroys another" shape this transaction exists to
      // remove. The claim taken by `#openTransaction` is what makes the window
      // unreachable today; the guard keeps it that way if the order changes.
      if (this.#sessions.get(holder.id) === holder) {
        this.#sessions.delete(holder.id);
        // Tell the daemon the session it still believes is open is gone: silence
        // would leave prompts routed at a provider session this connection no
        // longer owns, surfacing later as an unexplained `runtime_failed`.
        this.#emit({ type: "session.closed", sessionId: holder.id });
      }
    }
    // The holder teardown awaits, so the transaction must still own both ids
    // before it goes on to spawn and publish for them.
    this.#assertOpening(sessionId, opening);

    // Validate this session's MCP servers **before** anything is spawned for it.
    //
    // `attachSession` is where a server DSH cannot mount is rejected, and it runs
    // after `acquireProcess()` — so on a cold pool a refused open had already
    // spawned a `dsh` child and validated its route before being rejected, then
    // retired it ~4 s later. The child is not leaked, but the work is pointless
    // and the guard that was supposed to prove "no spawn happens" was written
    // against the warm pool, where no spawn happens for any reason, so it could
    // never fail. Same translation function as the mount, so the two verdicts
    // cannot disagree.
    validateMcpServers(config.mcpServers);

    /** Warnings collected during the open, emitted after `session.ready` so Paseo has the session. */
    const openWarnings: OpenWarning[] = [];

    // The concurrent counterpart of the holder check above, and the reason both
    // ids are claimed in `#openTransaction` before this method's first await:
    // two opens for one DSH session must not interleave, and neither may one
    // provider id be rebound to a second native session mid-open. Nothing here
    // re-claims either identity.

    // Declared outside the transaction because the catch has to close it: the
    // claim is taken before the instance exists, so a throw in between (an
    // option the constructor rejects) must still release it — otherwise every
    // later open of this DSH session is refused for the connection's life.
    let session: DshSession | undefined;

    try {
      // A provider session id is supposed to be minted fresh for every open, and
      // Paseo does that on the reload path. The provider must not leak when it is
      // not: `#sessions` is a map, so a second `session.open` for an id it already
      // tracks would **overwrite** the entry, and the replaced `DshSession` would
      // keep its claim on the shared child with nothing left to release it — the
      // pool would never reach zero and never retire its child.
      //
      // `#sessionHolding` above cannot catch this: it looks for the same *DSH*
      // session id under a **different** provider session id, and here both ids are
      // the same. Measured before this close was added: a fake-bridge run opened
      // one root four times under a single provider session id, left three orphaned
      // `DshSession` claims behind, and the shared child never retired.
      //
      // Closing the stale instance first makes a repeated open idempotent instead of
      // a leak. `close()` is idempotent on its own, returns the claim, and never
      // shuts the shared child down — so a sibling conversation running in it is
      // unaffected.
      const replaced = this.#sessions.get(sessionId);
      if (replaced !== undefined) {
        process.stderr.write(
          `[${PROVIDER_ID}] session ${sessionId} is being opened again; closing the previous instance first `
            + "so its claim on the shared process is returned\n",
        );
        this.#sessions.delete(sessionId);
        try {
          await replaced.close({ park: false });
        } catch (error) {
          // Not fatal: the stale instance is gone from the map either way and the
          // new open is what the caller asked for. Say so rather than swallowing it
          // — a failed close is exactly where a claim would leak.
          process.stderr.write(
            `[${PROVIDER_ID}] closing the replaced session ${sessionId}: ${messageOf(error)}\n`,
          );
        }
      }

      // The replaced instance's close awaits, so re-check the transaction's
      // claim before constructing and registering a new instance under it.
      this.#assertOpening(sessionId, opening);
      session = new DshSession({
        systemPrompt: config.systemPrompt,
        // Paseo's own name for this agent, forwarded so DSH's session list shows
        // the same name (see `DshSessionOptions.title`). Paseo supplies it on
        // both a fresh open and a reopen from its stored agent config, so a
        // restored conversation keeps its name instead of showing as untitled.
        ...(config.title === undefined ? {} : { title: config.title }),
        permission: this.capabilities.includes("permission"),
        sessionId,
        dshSessionId,
        cwd: config.cwd,
        env: config.env ?? {},
        // Stable across the provider-session re-mints a reload performs; native
        // child ids are scoped by it so a reload upserts the same Paseo rows
        // instead of adding a duplicate set (see `DshSessionOptions.agentId`).
        ...(agentId === "" ? {} : { agentId }),
        // Paseo injects its own `paseo` MCP server here for every provider that
        // declares `supportsMcpServers` (plugin providers always do, and cannot
        // take the native-tools path opencode uses). Dropping this map is what
        // left the model with no `mcp__paseo__*` tools while nothing errored.
        //
        // `config.toolPolicy.preapproved` is intentionally not forwarded: it asks
        // the runtime to pre-approve named MCP tools, and DSH has no such concept
        // — its own permission preset decides. Inventing an equivalent here would
        // be exactly the self-invented protocol shape this repo forbids.
        mcpServers: config.mcpServers,
        route,
        mode: config.mode ?? "build",
        // The catalog's mode list is the single capability source: it was already
        // filtered by the bridge's `planMode` (see `toDisplayCatalog`), and the
        // session republishes it verbatim in `session.config`. Deriving the list
        // again inside the session made a hidden Plan reappear as an available
        // mode as soon as the session opened.
        modes: display.defaults.modes,
        models: display.models,
        thinkingOptions: display.thinkingOptions,
        // Only offer child subsessions when Paseo negotiated the capability; when
        // it did not, the host cannot accept a child and the session must stay
        // root-only rather than fail the whole connection.
        subsession: this.capabilities.includes("session.subsession"),
        emit: (event) => this.#emit(event),
        log: (line) => {
          process.stderr.write(`[${PROVIDER_ID}] ${line}\n`);
        },
        // Every session joins the one shared child; the pool owns its lifetime and
        // its reference count. A session never spawns, parks or shuts a process
        // down — with one child serving every conversation, any of those by a
        // single session would take the others with it.
        acquireProcess: async () => {
          const acquired = await this.#acquirePoolProcess({
            route,
            env: config.env ?? {},
          });
          // The env keys this session asked for that the shared child cannot
          // apply. Reported on stderr by `#warnEnvDiffers` and collected here for
          // the timeline, because stderr is a channel the user never sees and
          // "my FOO=bar was ignored" otherwise has no symptom at all.
          if (acquired.envDiffering.length > 0) {
            openWarnings.push({
              severity: "warning",
              title: "会话环境变量未生效",
              // Key names only. An env value can be a token, and a timeline notice
              // is both rendered in the UI and persisted in the client's store.
              //
              // The wording covers **both** directions of the difference, because
              // `#warnEnvDiffers` scans the union of the two key sets: a key this
              // session set that the child was not spawned with (its value is not
              // in effect), and a key the child was spawned with that this session
              // does not set (the first session's value is still in effect — the
              // opposite surprise). Saying only "沿用首个会话打开时的值" describes
              // the second case and is wrong for the first.
              description:
                `${acquired.envDiffering.join("、")} 与共享 DSH 进程启动时的环境不同；`
                + "环境是进程级的，本会话请求的值没有生效——该进程仍按首个会话打开时的环境运行"
                + "（本会话设置的键未生效，本会话未设置的键沿用首个会话的值）。",
            });
          }
          return acquired;
        },
        releaseProcess: (process) => {
          this.#releasePoolProcess(process);
        },
      });
      this.#sessions.set(sessionId, session);

      // The claim was taken before this `try` (see above) — deliberately, because
      // the awaits in between made "check then claim" non-atomic. Nothing here
      // re-claims it.
      await session.open();
      // Post-open initialisation is part of the open transaction: the daemon
      // drops its maps on a failed open (`PluginProvider.openSession`'s catch
      // never sends `session.close`), so a throwing configure or catalog load
      // would otherwise leak this session's maps and its `dsh` process — every
      // retry arrives under a fresh session id, so they accumulate rather than
      // replace each other.
      if (config.thinkingOption !== undefined) {
        await session.configure({ thinkingOption: config.thinkingOption });
      }

      const settings = config.settings ?? {};
      // The agent preset is a creation-time choice: apply it BEFORE the agent is
      // created (loadCommands creates it) so the session is born under the chosen
      // preset. DSH locks the preset after the session's first turn, so applying it
      // after `session.ready` would already be too late — the pick would snap back
      // to the profile default.
      const presetSetting = settings["preset"];
      const requestedPreset =
        typeof presetSetting === "string" && presetSetting !== "" ? presetSetting : undefined;
      if (requestedPreset !== undefined) {
        try {
          await session.configure({ settings: { preset: requestedPreset } });
        } catch (error) {
          process.stderr.write(`[${PROVIDER_ID}] preset "${requestedPreset}" rejected: ${messageOf(error)}\n`);
        }
      }

      // Advertise the `/` menu before `session.ready` so the composer has it the
      // moment the session is usable. A command catalog is an enhancement in the
      // sense that its absence must not fail the whole open — but a *throw* here
      // is a real failure (an empty catalog is `available`/`[]`, not an error),
      // and this request is what materializes the DSH session
      // (`getOrCreateSession` in the bridge). Swallowing it silently left the
      // composer without the `/` menu and the permission select while the session
      // reported ready, so the failure becomes a timeline warning below.
      try {
        await session.loadCommands();
        await session.loadPermission();
        await session.loadPresets();
        // Simple third-party DSH switches: global to the profile, so the value
        // read here is the runtime's truth, not Paseo's persisted per-agent copy.
        await session.loadDshSettings();
        // `session.configure()` intentionally keeps the real value when DSH
        // refuses a preset (the composer re-emits config and snaps back), so the
        // only reliable way to tell "applied" from "silently refused" is to read
        // the value `loadPresets()` just fetched from the runtime. Without this
        // warning the user got a different persona than the one they picked and
        // no explanation anywhere in the UI.
        if (requestedPreset !== undefined) {
          const appliedPreset = session
            .configState()
            .settings.find((setting) => setting.id === "preset")?.value;
          if (appliedPreset !== requestedPreset) {
            openWarnings.push({
              severity: "warning",
              title: "预设未应用",
              description: appliedPreset === undefined
                ? `Paseo 选择的预设「${requestedPreset}」未生效，且当前 profile 没有可读的预设目录，无法确认实际预设；本会话按 profile 的默认设置运行。`
                : `Paseo 选择的预设「${requestedPreset}」未生效（当前实际预设为「${appliedPreset}」）；本会话按实际预设运行。`,
            });
          }
        }
        // Paseo sends every setting it persisted for this agent on open. A
        // `dsh:` switch is global to the DSH profile, so that stored value is the
        // host's memory, not the runtime's truth. Two shapes, deliberately
        // different:
        //  - a fresh open (the create panel put the user's picks into the new
        //    agent's featureValues): park them and write before the first prompt.
        //    Writing on open would be wrong — Paseo also opens a throwaway
        //    session to refresh the draft menu, and a write there would make
        //    "open the create panel" change a global switch;
        //  - a resumed session: never write. The runtime value wins silently,
        //    with one daemon-stderr line; a timeline warning on every reopen
        //    would be noise the user cannot dismiss, and writing would let a
        //    reopened agent override another conversation's choice.
        const requestedDsh = Object.entries(settings).filter(([id]) =>
          id.startsWith(DSH_SETTINGS_ID_PREFIX)
        );
        if (input.persistence === undefined) {
          session.stagePendingDshSettings(settings);
        } else if (requestedDsh.length > 0) {
          const actual = session.dshSettingValues();
          // The stored value is the composer's select value (`"on"`/`"off"`) for
          // agents saved after that projection, and a boolean for older ones;
          // compare booleans so neither shape produces a false "stale" line.
          const stale = requestedDsh.flatMap(([id, value]) => {
            const normalized = dshSettingBooleanValue(value);
            if (normalized === undefined) {
              // "Failure must be loud": a persisted value this build cannot read
              // is only reachable through a protocol bug or a hand-edited agent
              // record, and dropping it silently is the shape this repository
              // keeps removing. One daemon-stderr line is the whole report —
              // there is no timeline notice on resume by design (see above).
              process.stderr.write(
                `[${PROVIDER_ID}] ignoring DSH switch "${id}" from Paseo's stored settings: `
                  + `value ${JSON.stringify(value)} is not "on"/"off" or a boolean\n`,
              );
              return [];
            }
            return actual.has(id) && actual.get(id) !== normalized
              ? [{ id, stored: normalized, runtime: actual.get(id) }]
              : [];
          });
          if (stale.length > 0) {
            process.stderr.write(
              `[${PROVIDER_ID}] DSH switch(es) differ from Paseo's stored value — keeping the runtime value: `
                + `${stale.map((entry) => `${entry.id} (stored ${String(entry.stored)}, runtime ${String(entry.runtime)})`).join(", ")}; `
                + "the switch is global to the DSH profile and is not written back on resume\n",
            );
          }
        }
      } catch (error) {
        const message = messageOf(error);
        process.stderr.write(`[${PROVIDER_ID}] command catalog failed: ${message}\n`);
        openWarnings.push({
          severity: "warning",
          title: "命令目录加载失败",
          description: `DSH 未返回命令/权限目录：${message}。斜杠菜单与权限选择器可能不可用。`,
        });
      }

      // The browser MCP server is fail-open: `browserMcpServer()` returns
      // `undefined` rather than throwing when it cannot locate the bridge, because
      // a throw there would take Paseo's own 61 tools down with it. The cost of
      // that choice is a session that quietly has no browser tools — the log line
      // is on the daemon's stderr, which the user never sees. Say it on the
      // timeline instead, with the reason, so "the agent can't drive the browser"
      // is an explained state rather than a mystery. Checked *after* the agent
      // exists: this warning is emitted with the other `openWarnings`, all of
      // which need a live session to attach to.
      const browserGap = browserMcpGap(config.cwd);
      if (browserGap !== undefined) {
        openWarnings.push({
          severity: "warning",
          title: "本会话没有浏览器工具",
          description: `${browserGap}。浏览器 MCP 服务器未挂载，本次会话无法直接操作共享浏览器；其余工具不受影响。`,
        });
      }

      // Permission applies to the live agent (it runs `/permission`), so it must
      // wait until one exists.
      const permission = settings["permission"];
      if (typeof permission === "string" && permission !== "") {
        try {
          await session.configure({ settings: { permission } });
        } catch (error) {
          const message = messageOf(error);
          process.stderr.write(`[${PROVIDER_ID}] permission "${permission}" rejected: ${message}\n`);
          // The chosen preset owns the sandbox mode and the approval policy; a
          // silent failure would leave the session on the profile default, which
          // can be broader than what the user picked. Say it on the timeline.
          openWarnings.push({
            severity: "warning",
            title: "权限预设未应用",
            description: `Paseo 选择的权限预设「${permission}」未生效（${message}）；本会话仍使用 profile 的默认权限。`,
          });
        }
      }

      // Paseo asks for `replay` when it reopens a session (restart or import).
      // DSH's resume restores context but re-emits no events, so replay the stored
      // conversation into the timeline or the reopened session shows as empty.
      if (input.history === "replay") {
        try {
          await session.replayHistory();
        } catch (error) {
          const message = messageOf(error);
          process.stderr.write(`[${PROVIDER_ID}] history replay failed: ${message}\n`);
          // `replayHistory` reports its own known failures as notices; this is
          // the last-resort channel for an unexpected throw, and it must still
          // be user-visible rather than leaving a blank reopened conversation.
          openWarnings.push({
            severity: "warning",
            title: "会话历史重放失败",
            description: `重放会话历史时出错（${message}）；当前对话可能是空白或不完整的。`,
          });
        }
      }
      // The claim has to survive the whole publish step, which is no longer
      // synchronous: it spans the bounded subagent-replay await and is re-checked
      // on the far side of it (after a close that landed meanwhile). It replaces
      // the old "release `#opening` then `#assertConnected`" pair for two reasons:
      // the claims must be held through publication (a close that lands during
      // the open has to invalidate it, not merely race it), and a torn-down
      // connection must not announce a session it cannot serve. The catch below
      // closes the instance.
      this.#assertOpening(sessionId, opening, session);
    } catch (error) {
      // The daemon drops its own maps and rethrows on a failed open
      // (`PluginProvider.openSession`'s catch never sends `session.close`), so
      // this entry — and the `dsh` process `open()` has already spawned — would
      // otherwise live as long as the connection does. Every retry arrives under
      // a fresh session id, so they accumulate rather than replace each other.
      //
      // The deletion is guarded by identity, not by key alone. The claim taken by
      // `#openTransaction` already makes a concurrent open for this provider id
      // impossible, so this guard is belt-and-braces against a future reorder:
      // unguarded, a catch that lands after a later open replaced the entry would
      // delete *that* session's record — the very "one open destroys another
      // session" failure this change removes.
      if (session !== undefined && this.#sessions.get(sessionId) === session) {
        this.#sessions.delete(sessionId);
      }
      if (session === undefined) throw error;
      try {
        // A failed open is not a reload: shut the child down rather than park it.
        await session.close({ park: false });
      } catch (closeError) {
        // Best-effort: the entry is gone either way, but say so rather than
        // leaving a live process and no trace of why.
        process.stderr.write(
          `[${PROVIDER_ID}] closing a session whose open failed: ${messageOf(closeError)}\n`,
        );
      }
      throw error;
    }

    this.#emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId,
      capabilities: [...this.capabilities],
      restoration: "core",
      cwd: config.cwd,
      // Reopen key: DSH persists the session under this exact id, so a plugin
      // reload or daemon restart resumes it. `data.sessionId` is DSH's id, which
      // stays the native one when an imported session is reopened.
      persistence: { version: 1, data: { sessionId: dshSessionId } },
      ...(config.title === undefined ? {} : { title: config.title }),
    });
    // `#emit` calls the listeners synchronously, and the daemon's `session.opened`
    // handler can reenter this connection (`session.close` is the one that does).
    // A close submitted from that handler has already marked the claim closed, so
    // re-check before publishing readiness: the host must not be told a session is
    // ready after it asked for it to be gone.
    this.#assertOpening(sessionId, opening, session);
    this.#emit({ type: "session.config", sessionId, config: session.configState() });
    this.#assertOpening(sessionId, opening, session);
    // Rebuild the native subagent tree on every open (a fresh `skip` or a reopen
    // `replay`) **before** readiness is published. It reads DSH's durable catalog
    // and child logs; it never creates an agent, and a fresh session simply has
    // none. The ordering is the fix for a reload losing rows: the daemon replays
    // this provider session's history right after `session.ready` resolves
    // (`agent-manager.js` deletes a parent's provider-subagent rows and re-applies
    // them from `streamHistory()`), and history can only contain the child events
    // that were emitted before it was read. Fire-and-forget after ready left the
    // replayed tree outside that snapshot — and the same applies to a running
    // child's only chance of showing as running.
    //
    // Bounded, because the replay reads one child log per child and every bridge
    // request can stall: waiting forever would delay `session.ready` (and the
    // whole conversation) behind a wedged bridge. Past the budget readiness is
    // published anyway and the replay finishes in the background — rows then
    // arrive as their frames do, i.e. the pre-fix behaviour, with the worst case
    // now bounded here instead of by the per-child transport timeout.
    const replay = session.replaySubagents().catch((error: unknown) => {
      const message = messageOf(error);
      process.stderr.write(`[${PROVIDER_ID}] subagent tree replay failed: ${message}\n`);
      // `replaySubagents` reports its own per-child failures as notices; this is
      // the last-resort channel for an unexpected throw. Readiness must still be
      // published, or an unreadable subagent catalog would make a conversation
      // that is otherwise fine impossible to open — but say so, because the
      // subagent rows may be missing or stale for the rest of this generation.
      // A failure that lands after the budget expired is stderr-only: readiness
      // is already published and the warning list has been flushed.
      openWarnings.push({
        severity: "warning",
        title: "子代理列表重放失败",
        description: `重开会话时未能重建子代理列表（${message}）；本会话可能看不到正在运行的子代理。`,
      });
    });
    if (!(await settlesWithin(replay, SUBAGENT_REPLAY_READY_BUDGET_MS))) {
      process.stderr.write(
        `[${PROVIDER_ID}] subagent tree replay exceeded ${String(SUBAGENT_REPLAY_READY_BUDGET_MS)}ms; `
          + "publishing the open now and finishing the replay in the background "
          + "(subagent rows may appear late for this session)\n",
      );
    }
    this.#assertOpening(sessionId, opening, session);
    // The root is open: release any child the bridge reported during the open,
    // so a child is never emitted before its parent. Released before readiness on
    // purpose — held child frames then land in this session's history alongside
    // the replayed tree, which is the snapshot the daemon hydrates from.
    session.markRootReady();
    this.#emit({ type: "session.ready", requestId: input.requestId, sessionId });
    // Same reentrancy window as above, but this one must **not** throw: readiness
    // was already published, so a close that came from that very emit has to end
    // the open quietly instead of turning into a `request.failed` after the host
    // was told the session is ready. Nothing is left running: `session.close`
    // removed the entry and tore the instance down before it awaited.
    if (this.#sessions.get(sessionId) !== session) return;
    for (const warning of openWarnings) {
      this.#notice(sessionId, warning.severity, warning.title, warning.description);
    }
    // A reopened session resumes DSH's stored context without a turn, so ask the
    // runtime for its occupancy now; otherwise the readout stays empty until the
    // next prompt even though the runtime already knows the numbers.
    //
    // The poll alone is not enough. The host subscribes to this session's events
    // at the *end* of its own registration (`agent-manager.js:2704`), so a
    // `session.usage` emitted before that reaches an empty listener set, and its
    // replay only projects `timeline`/`provider_subagent` (`:3066`) — a dropped
    // `usage_updated` never comes back. A reopen is exactly when that hurts:
    // `resumeAgentFromPersistence` starts the agent with no cached usage. So
    // re-publish the polled answer across the subscription window.
    void session.refreshUsage().then(() => session.publishUsageAfterOpen());
  }

  /**
   * Archive or unarchive the DSH session a persistence handle names.
   *
   * Paseo's archive request carries the handle this plugin minted in
   * `session.opened`, so it resolves to the DSH session id the registry knows.
   * A handle we cannot resolve fails loudly: reporting success for an archive
   * that did nothing is exactly the bug this replaces.
   */
  async #setArchived(persistence: unknown, archived: boolean): Promise<void> {
    const data = isRecord(persistence) ? persistence["data"] : undefined;
    const dshSessionId =
      isRecord(data) && typeof data["sessionId"] === "string" ? data["sessionId"] : "";
    if (dshSessionId === "") {
      throw new Error(
        `cannot ${archived ? "archive" : "unarchive"}: the persistence handle names no DSH session`,
      );
    }
    const verb = archived ? "archive" : "unarchive";
    const reasons: string[] = [];
    const note = (via: string, error: unknown): void => {
      reasons.push(messageOf(error));
      process.stderr.write(`[${PROVIDER_ID}] ${verb} via ${via} failed: ${messageOf(error)}\n`);
    };
    // **The write must land in the process that answers the gate.** DSH's
    // `archived-session-gate` reads `workspaceRegistry.archivedSessionIds` from
    // the memory of the process that runs the step (`archived-session-gate.js`
    // `underArchivedSession`), while `setState` writes the medium *and* that same
    // memory (`dsh-workspace/lib/index.js:938-941`). There is no cross-process
    // invalidation — no reload hook, no `domain/changed` across processes (it is
    // a local `ctx.emit`), and the set is written whole (`[...state.archivedSessionIds, id]`),
    // so a process carrying a snapshot from its own start silently drops another
    // process's change. Consequences:
    //
    // - Writing from a process that does NOT own the session leaves the owner
    //   stale: every later turn of that session is rejected as `blocked` with no
    //   model request, which Paseo shows as "the turn ended with blocked".
    // - Therefore the owner carries the write, and **nothing is ever killed to
    //   make that true.** Under one-process-multi-session every session shares one
    //   child, so the old "discard the parked process" step here would have killed
    //   every other open conversation along with it. The discard calls are gone;
    //   the tiers below only ever *add* a carrier.
    //
    // Tier 1 — the open session that holds this DSH session (the root itself, or
    // its native child, which has no process of its own).
    const ordered = [...this.#sessions.values()].sort(
      (a, b) => Number(b.holdsDshSession(dshSessionId)) - Number(a.holdsDshSession(dshSessionId)),
    );
    const holder = ordered.find((session) => session.holdsDshSession(dshSessionId));
    if (holder !== undefined) {
      try {
        await holder.archiveDshSession(dshSessionId, archived);
        return;
      } catch (error) {
        // A rescued failure still means this process did not do it, so it is
        // reported rather than swallowed; the reasons are also what the caller
        // sees if every attempt fails.
        note(holder.dshId, error);
      }
    }
    // Tier 2 — any other open root. DSH's registry is process-global, so a root
    // that already has a process can carry the request for a session it does not
    // hold. This is what lets a native child be archived through its root, and
    // what honours the common "Paseo closed it, then archived it" order.
    for (const session of ordered) {
      if (session === holder) continue;
      try {
        await session.archiveDshSession(dshSessionId, archived);
        return;
      } catch (error) {
        note(session.dshId, error);
      }
    }
    // Tier 3 — the shared pool process, even when no provider session is attached
    // to it right now (every session closed but the delayed shutdown has not run
    // yet). `DshProcess.setArchived` does not require the session to be attached:
    // the bridge's `applyArchived` handler uses the process-wide
    // `workspaceRegistry` (see `paseo/archive` in `dsh-bridge/lib/server.js`),
    // and that request is not gated on `initialize` (only `prompt` is — same
    // file, the `initialize` check in its request dispatcher). Using the pool
    // here is what keeps the write inside the one process that answers the gate.
    // (Symbol names, not line numbers: `server.js` changes far more often than
    // this comment and the numbers had already drifted.)
    const pooled = this.#livePoolProcess();
    if (pooled !== undefined) {
      try {
        const result = await pooled.setArchived(dshSessionId, archived);
        if (!result.available) throw new Error(result.error?.message ?? `${verb} failed`);
        return;
      } catch (error) {
        note("the shared process", error);
      }
    }
    // Tier 4 — a throwaway runtime, only when **no live process can carry it**.
    // That is the only case where writing outside the pool is safe: the next
    // spawn reads the archive set from DSH's storage (`dsh-workspace/lib/index.js:379-384`,
    // `Service.init`), so it cannot inherit a stale snapshot. A live pool makes
    // this tier unreachable on purpose — a probe write while the pool was alive
    // would desync the very process that answers the gate, and the fallback for
    // *that* used to be killing it (which is exactly what this rewrite forbids).
    if (pooled !== undefined) {
      throw new Error(
        `cannot ${verb} ${dshSessionId}: the shared DeepSeek Harness process refused it (${reasons.join("; ")}); `
          + "it was not retried in a throwaway runtime because that would leave the shared process on a stale archive set",
      );
    }
    try {
      await applyArchivedStandalone(dshSessionId, archived);
    } catch (error) {
      reasons.push(messageOf(error));
      throw new Error(`cannot ${verb} ${dshSessionId}: ${reasons.join("; ")}`);
    }
  }

  /**
   * The open session that already owns one DSH session, if any.
   *
   * One DSH session may only be materialized by one process (its log carries a
   * kernel write lock); two owners would make both unusable. Excludes the provider
   * session currently being opened.
   *
   * @param dshSessionId - DSH native session id.
   * @param except - provider session id to ignore (the one being opened).
   * @returns the owning session, or undefined when there is none.
   */
  #sessionHolding(dshSessionId: string, except: string): DshSession | undefined {
    for (const session of this.#sessions.values()) {
      if (session.id !== except && session.dshId === dshSessionId) return session;
    }
    return undefined;
  }

  #require(sessionId: string): DshSession | DshChildSession {
    const session = this.#sessions.get(sessionId);
    if (session !== undefined) return session;
    // A native subagent child lives inside its root's process; the root owns it
    // and routes operations to the child view by the child's own session id.
    for (const root of this.#sessions.values()) {
      const child = root.child(sessionId);
      if (child !== undefined) return child;
    }
    throw new Error(`unknown session: ${sessionId}`);
  }

  /** Throw when this connection was torn down; see `#open` and `#emit`. */
  #assertConnected(): void {
    if (this.#closed) throw new Error("the provider connection is closed");
  }

  #emit(event: ProviderEvent): void {
    // A torn-down connection has no listener left worth waking, and an open that
    // raced `close()` must not publish `session.opened` / `session.ready` after
    // the daemon dropped this connection (it would land as an unknown session).
    if (this.#closed) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        process.stderr.write(`[${PROVIDER_ID}] listener failed: ${messageOf(error)}\n`);
      }
    }
  }
}

/**
 * The provider connections this process has open, so a plugin RPC can reach one.
 *
 * A handler is registered once at plugin load, but the connection a session
 * belongs to is created later by `provider.connect`, and there is no channel from
 * the handler's context to it — so the connection registers itself here.
 *
 * A `Set` rather than a single field: nothing in the SDK promises one connection
 * at a time, and overwriting a single field would answer from the wrong daemon
 * with a count that looks plausible.
 */
const CONNECTIONS = new Set<DshConnection>();

/**
 * Read one agent's background jobs through whichever connection serves it.
 *
 * "No connection / no session" is not an error — see the note on the final
 * `return`. A session that *is* open reports its own read failure instead of an
 * empty list, which is what keeps an unreadable registry from being drawn as "no
 * background jobs".
 *
 * @param agentId - Paseo's agent id, as the pill knows it.
 */
export async function readAgentJobs(agentId: string): Promise<{
  available: boolean;
  jobs: DshJob[];
  error?: { message: string; code?: JobErrorCode };
}> {
  for (const connection of CONNECTIONS) {
    const session = connection.sessionForAgent(agentId);
    if (session === undefined) continue;
    const result = await session.jobs();
    if (!result.available) {
      return {
        available: false,
        jobs: [],
        error: {
          message: result.error?.message ?? "the DSH runtime could not list this session's jobs",
          ...(result.error?.code === undefined ? {} : { code: result.error.code }),
        },
      };
    }
    return { available: true, jobs: result.jobs ?? [] };
  }
  // No connection serves this agent — i.e. this process holds no DSH session for
  // it, so the agent has no DSH-side job to report. **This is an accurate empty
  // answer, not a failed read**, which is why it is `available: true`.
  //
  // Do not "fix" this to `available: false` by reading `shared/jobs.ts`'s
  // contract literally: there, `available: false` means "the registry could not
  // be read", and the pill renders that as a visible error. Reporting it here
  // would leave an error pill sitting on every agent whose session has not been
  // opened yet — the common state before the first prompt — which is noise about
  // a condition the user cannot act on. The distinction the contract draws is
  // between "we looked and found none" and "we could not look"; this branch is
  // the former.
  return { available: true, jobs: [] };
}

/**
 * One goal as the shared contract carries it.
 *
 * The bridge answers DSH's whole `GoalView`; the pill needs the five fields it
 * draws, the blocker, and `id`/`revision` — the key a completed goal's "seen"
 * state is remembered under (see `shared/goal.ts`). The timestamps stay behind.
 * Copied field by field rather than spread, so a field the bridge adds later
 * cannot leak into the RPC answer by accident.
 */
function goalStateOf(view: DshGoalView): GoalState {
  return {
    id: view.id,
    revision: view.revision,
    objective: view.objective,
    phase: view.phase,
    activation: view.activation,
    roundsStarted: view.roundsStarted,
    maxGoalRounds: view.maxGoalRounds,
    ...(view.blockedReason === undefined
      ? {}
      : { blockedReason: { code: view.blockedReason.code, message: view.blockedReason.message } }),
  };
}

/**
 * Agents whose `todos` read already failed and was logged once.
 *
 * The goal pill polls every four seconds, so an unlatched stderr line per poll
 * would bury the log (the same reason the bridge latches its own warnings). A
 * later success does not clear the entry: the line explains why the "now" line
 * may be missing, and once the read recovers there is nothing left to explain.
 */
const CURRENT_TASK_WARNED = new Set<string>();

/**
 * Read one agent's current goal through whichever connection serves it.
 *
 * "No connection / no session" is not an error — same rule as
 * {@link readAgentJobs}: this process holds no DSH session for the agent, so it
 * has no goal to report. **This is an accurate empty answer, not a failed
 * read**, which is why it is `available: true` with a `null` goal. The pill is
 * hidden for that answer, which is right: an agent whose session has not been
 * opened has no goal to show, and an error pill there would be noise about a
 * condition the user cannot act on.
 *
 * A session that *is* open reports its own read failure instead of `null`,
 * which is what keeps an unreadable goal from being drawn as "no goal".
 *
 * The optional `currentTask` comes from a **second, best-effort read** of DSH's
 * `todos` projection, and only when there is a goal to draw (a null goal is a
 * hidden pill, so the read would be wasted). Its failure never fails the goal:
 * the projection being absent, null or unreadable all mean "no now line", and
 * the goal read is what the pill depends on.
 *
 * @param agentId - Paseo's agent id, as the pill knows it.
 */
export async function readAgentGoal(agentId: string): Promise<{
  available: boolean;
  goal: GoalState | null;
  error?: { message: string; code?: GoalErrorCode };
}> {
  for (const connection of CONNECTIONS) {
    const session = connection.sessionForAgent(agentId);
    if (session === undefined) continue;
    const result = await session.goal();
    if (!result.available) {
      return {
        available: false,
        goal: null,
        error: {
          message: result.error?.message ?? "the DSH runtime could not read this session's goal",
          ...(result.error?.code === undefined ? {} : { code: result.error.code }),
        },
      };
    }
    if (result.goal === undefined || result.goal === null) {
      return { available: true, goal: null };
    }
    const state = goalStateOf(result.goal);
    const task = await session.currentTask();
    if (task.kind === "unavailable" && !CURRENT_TASK_WARNED.has(agentId)) {
      CURRENT_TASK_WARNED.add(agentId);
      process.stderr.write(
        `[${PROVIDER_ID}] goal pill: reading the todo projection failed for ${agentId} `
          + `(the "now" line will be missing): ${task.message}\n`,
      );
    }
    return {
      available: true,
      goal: task.kind === "task" ? { ...state, currentTask: task.task } : state,
    };
  }
  return { available: true, goal: null };
}

/**
 * Read one agent's team board (T3), the way {@link readAgentGoal} reads a goal.
 *
 * The board is DSH's `agentTeam` wire view plus the session's own `running`
 * overlay (`DshSession.team`). It is parsed here with the shared schema: an
 * answer that is not DSH's shape is a transient `rpc_failed` with the Zod
 * reason, never a silently emptied board. No session for the agent in this
 * process is an accurate `team: null` (the goal/jobs rule).
 *
 * @param agentId - Paseo's agent id, as the pill knows it.
 */
export async function readAgentTeam(agentId: string): Promise<{
  available: boolean;
  team: TeamView | null;
  error?: { message: string; code?: TeamErrorCode };
}> {
  for (const connection of CONNECTIONS) {
    const session = connection.sessionForAgent(agentId);
    if (session === undefined) continue;
    const result = await session.team();
    if (!result.available) {
      return {
        available: false,
        team: null,
        error: {
          message: result.error?.message ?? "the DSH runtime could not read this session's team",
          ...(result.error?.code === undefined ? {} : { code: result.error.code }),
        },
      };
    }
    if (result.team === undefined || result.team === null) return { available: true, team: null };
    const parsed = teamViewSchema.safeParse(result.team);
    if (!parsed.success) {
      return {
        available: false,
        team: null,
        error: { message: `the agentTeam projection is not the expected shape: ${parsed.error.message}`, code: "rpc_failed" },
      };
    }
    return { available: true, team: parsed.data };
  }
  return { available: true, team: null };
}

/**
 * Run one `/goal` control action for the agent's open session.
 *
 * The command path itself is `DshSession.controlGoal`'s (bridge
 * `paseo/command/run`); this function only finds the session, exactly like the
 * jobs read. An agent with no open session cannot be controlled: the command
 * needs a live DSH agent, and inventing a "queued" answer would claim an action
 * that never ran. The failure is a value, not a throw, because the popover shows
 * it in place.
 *
 * @param agentId - Paseo's agent id, as the pill knows it.
 * @param action - one of `pause` / `resume` / `clear` / `edit`.
 * @param objective - the replacement objective, required by `edit`.
 */
export async function controlAgentGoal(
  agentId: string,
  action: GoalAction,
  objective?: string,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  for (const connection of CONNECTIONS) {
    const session = connection.sessionForAgent(agentId);
    if (session === undefined) continue;
    return await session.controlGoal(action, objective);
  }
  return {
    ok: false,
    error: "no DSH session is open for this agent; send it a message first, then control its goal",
  };
}

/** The provider registration Paseo installs for `dsh --profile paseo`. */
export function createDshProvider(): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: "DeepSeek Harness",
    icon: "icon.svg",
    async connect(request) {
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      const connection = new DshConnection(capabilities);
      // Registered here rather than in the constructor so a connection that is
      // never handed to the daemon cannot be observed; `close()` deregisters it,
      // which is what keeps a reload from leaving dead connections behind for
      // `readAgentJobs` to walk on every pill poll.
      CONNECTIONS.add(connection);
      return connection;
    },
  };
}
