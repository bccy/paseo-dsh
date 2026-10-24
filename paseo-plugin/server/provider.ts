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
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
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
import { DshProcess, type DshCatalog, type DshRevertResult, type DshRoute } from "./dsh-process";
import { DshChildSession, DshSession, modes, parseRoute } from "./session";
import { ParkedSessions, RELEASE_TIMEOUT_MS } from "./parked-sessions";
import { effortLabel } from "./locale";

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
  // implements exactly two scopes: conversation only, and conversation + the
  // files the agent's editing tools touched. Paseo's menu offers the intersection
  // of these bits and its own UI.
  "session.revert.both",
  "session.revert.conversation",
  // NOT `session.revert.files`: the bridge has no files-only rewind (the file
  // rollback is part of `both`); advertising a capability the backend cannot
  // honour is worse than a missing menu entry.
  "permission",
] as const;

/** Provider id registered with Paseo; distinct from the ACP `deepseek-harness` entry. */
export const PROVIDER_ID = "deepseek-harness-native";

/** A notice kept until the provider session it belongs to is reopened. */
interface DeferredNotice {
  severity: "info" | "warning" | "error";
  title: string;
  description?: string;
}

/** Cap on queued notices per DSH session, so a failing refresh cannot grow forever. */
const MAX_DEFERRED_NOTICES = 20;

/**
 * Cap on retained provider-session → DSH-session id mappings.
 *
 * `session.close` keeps the mapping on purpose (a notice deferred for the closed
 * session still has to reach the reopened timeline), and every reload mints a new
 * provider session id for the same DSH session, so a long-lived daemon would
 * otherwise accumulate one entry per reload forever. Old entries only serve
 * notices for long-closed sessions; past the cap the oldest is dropped and the
 * drop is logged rather than growing without bound.
 */
const MAX_DSH_ID_MAPPINGS = 500;

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
 * A rewind's reload closes the provider session and reopens it immediately; the
 * grace period is what keeps that from becoming a cold CLI boot (measured
 * 1.5–2.7 s). It matches the pool's session-lock release bound
 * (`RELEASE_TIMEOUT_MS` in `parked-sessions.ts`) so the two agree about when a
 * child is genuinely idle.
 */
const POOL_RELEASE_GRACE_MS = 5_000;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

let catalogCache: { at: number; cwd: string; value: DisplayCatalog } | undefined;

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

/** Read the runtime catalog through a short-lived process and cache it. */
async function loadCatalog(cwd: string): Promise<DisplayCatalog> {
  if (catalogCache !== undefined && catalogCache.cwd === cwd && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.value;
  }
  const probe = probeProcess(cwd, "catalog-probe");
  try {
    await probe.start();
    const raw: DshCatalog = await probe.catalog();
    const value = toDisplayCatalog(raw);
    catalogCache = { at: Date.now(), cwd, value };
    return value;
  } finally {
    probe.kill();
  }
}

/** List DSH's importable sessions through a short-lived process. */
async function listDshSessions(
  cwd: string,
  options: { query?: string; limit?: number },
): Promise<Array<{ sessionId: string; cwd?: string; title?: string; createdAt?: number }>> {
  const probe = probeProcess(cwd, "sessions-probe");
  try {
    await probe.start();
    return await probe.sessions({
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
   * provider session id -> Paseo agent id. The daemon hands the provider the
   * agent id in `config.env.PASEO_AGENT_ID` (documented lifecycle order: it is
   * set after the session_open hooks and before the provider session opens), and
   * the post-rewind refresh needs the *agent* id, which no plugin API maps.
   */
  readonly #agentIds = new Map<string, string>();
  /**
   * provider session id -> DSH native session id. Kept across `session.close`
   * on purpose: the rewind reload closes this provider session and reopens a
   * new one for the same DSH session, and notices produced in that window must
   * find their way to the reopened timeline.
   */
  readonly #dshIds = new Map<string, string>();
  /** Notices waiting for their DSH session to be reopened, keyed by DSH session id. */
  readonly #deferredNotices = new Map<string, DeferredNotice[]>();
  /** Provider sessions whose rewind is in flight: prompts are refused until the reload. */
  readonly #reverting = new Set<string>();
  /**
   * DSH session ids with an `#open` transaction in flight.
   *
   * Two concurrent opens for one DSH session would both pass the holder check and
   * spawn a process, while only one can own the session log's write lock. The entry
   * is released when the open transaction ends (not when the session closes).
   */
  readonly #opening = new Set<string>();
  #display: DisplayCatalog | undefined;
  #paseoBinary: string | undefined;
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
   * expires: a rewind's reload closes and immediately reopens the session, and
   * killing the child on the close would turn that fast path back into a cold
   * start (measured at 1.5–2.7 s of CLI boot). The timer matches the pool's
   * session-lock release bound so the two never disagree about when a child is
   * really gone.
   */
  readonly #poolClaims = new Map<DshProcess, number>();
  #poolReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Idle DSH processes kept across a provider-session close. The rewind refresh
   * closes and immediately reopens the session; adopting the parked child turns
   * that cold start into a replay, which is what makes the timeline update in
   * about a second instead of three to four.
   */
  readonly #parked = new ParkedSessions({
    log: (line) => process.stderr.write(`[${PROVIDER_ID}] ${line}\n`),
  });

  constructor(capabilities: readonly string[]) {
    this.capabilities = capabilities;
    this.#parked.start();
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
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
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#agentIds.clear();
    this.#dshIds.clear();
    this.#deferredNotices.clear();
    this.#reverting.clear();
    this.#opening.clear();
    // Provider teardown is not a reload: shut the sessions down and kill the
    // parked children instead of keeping them alive for a reopen that will not
    // happen on this connection.
    await Promise.allSettled(sessions.map((session) => session.close({ park: false })));
    this.#parked.stop();
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
   * The spawn uses the **first caller's** cwd/route/env as the process defaults.
   * That is deliberate and mostly harmless: every session sends its own cwd and
   * route in `initialize` (`attachSession`), so those defaults only cover a
   * request that names no session. **The environment is the exception**: it is
   * applied once at spawn and DSH exposes no channel to change it per session,
   * so a later session's `config.env` cannot be honoured. That divergence is
   * not swallowed — {@link #warnEnvDiffers} reports every key that differs.
   *
   * @param options - what to spawn with, when a spawn is needed.
   * @returns the live shared child and whether it was already serving sessions.
   */
  async #acquirePoolProcess(options: {
    cwd: string;
    route: DshRoute;
    env: Record<string, string>;
  }): Promise<{ process: DshProcess; reused: boolean }> {
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
      this.#warnEnvDiffers(options.env);
      return { process: existing, reused: true };
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
      this.#warnEnvDiffers(options.env);
      // Somebody else's spawn: by the time this returns the child has another
      // session attached to it (or is about to), so this caller is joining.
      return { process: shared, reused: true };
    }
    const spawnTask = (async (): Promise<DshProcess> => {
      // A placeholder id, not a real conversation: `DshProcess` attaches its
      // constructor id at construction, and `start()` initializes that id. The
      // point of that initialize is to compose the LLM adapters and validate the
      // route once per process; each real session then initializes its own id
      // through `attachSession`, and the bridge answers `routeFor` per session
      // (`server.js:648-668`), so the placeholder never sees a prompt.
      const child = new DshProcess({
        cwd: options.cwd,
        route: options.route,
        sessionId: POOL_PLACEHOLDER_SESSION_ID,
        env: options.env,
        // MCP servers are per session now (`paseo/mcp/set`), so the process
        // default stays empty; `attachSession` carries each session's own map.
        onEvent: () => {},
        onStatus: () => {},
        onQuestion: async () => ({ answers: [] }),
        onChildOpened: () => {},
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
      // Freshly spawned by this very call: the caller is not joining anything.
      return { process: started, reused: false };
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
    // **One hold per claim, no exceptions.** The claim is the provider's own
    // accounting; the hold is what `ParkedSessions` consults before it kills or
    // drops the shared child (park / sweep / discard / evict). It is released in
    // exactly two places — `#releasePoolProcess` for a returned claim and
    // `#dropPoolClaims` when the child itself is gone — so the two counters can
    // never drift apart. (Before this wiring `#holds` stayed 0, which made every
    // one of those guards a dead branch.)
    this.#parked.hold();
  }

  /**
   * Forget every claim on one child and release the matching holds.
   *
   * Used only where the child itself is going away (it exited on its own, or
   * `#shutdownPoolNow` is retiring it): the sessions that held those claims are
   * dead with it, and `DshProcess` has already reported that to each of them
   * (`#exitAll` / `onExit`). Their later `close()` returns early (the session is
   * already marked closed) and would never return the claim itself, so keeping
   * the numbers would leave `#holds` above zero forever — the guards would go
   * dead again, now permanently. Each dropped claim releases exactly the one
   * hold {@link #addPoolClaim} took.
   *
   * @param process - the child whose claims become void.
   */
  #dropPoolClaims(process: DshProcess): void {
    const held = this.#poolClaims.get(process) ?? 0;
    if (held <= 0) return;
    this.#poolClaims.delete(process);
    for (let index = 0; index < held; index += 1) this.#parked.release();
  }

  /**
   * Report a per-session `config.env` the shared child cannot apply.
   *
   * The environment is handed to `DshProcess` at spawn only; `attachSession`
   * carries cwd/route/MCP servers and has no env channel (adding one is a
   * `dsh-process.ts` change, out of this file's scope). So when a session joins
   * a child spawned with a different environment, its values are silently inert
   * unless this says so. `PASEO_AGENT_ID` is excluded because the daemon sets it
   * per open by design and the provider reads it into `#agentIds` — it is not
   * addressed to DSH.
   *
   * @param env - the joining session's `config.env`.
   */
  #warnEnvDiffers(env: Record<string, string>): void {
    const spawned = this.#poolEnv;
    if (spawned === undefined) return;
    const differing: string[] = [];
    for (const key of new Set([...Object.keys(spawned), ...Object.keys(env)])) {
      if (key === "PASEO_AGENT_ID") continue;
      if (spawned[key] !== env[key]) differing.push(key);
    }
    if (differing.length === 0) return;
    process.stderr.write(
      `[${PROVIDER_ID}] session env differs from the shared process's spawn env (${differing.join(", ")}): `
        + "the environment is process-wide, so the values the first session opened with stay in effect — these are NOT applied\n",
    );
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
   * The shutdown is **delayed** on purpose. A rewind's reload closes the provider
   * session and reopens it a few milliseconds later; killing the child on the
   * close would turn that into a cold CLI boot (1.5–2.7 s) and lose the parked
   * fast path entirely. The delay is the same bound the pool uses for a session
   * log's write lock, so a reopen inside the window reuses the child and one
   * outside it starts clean.
   *
   * @param process - the child the caller was using; an unknown one is ignored.
   */
  #releasePoolProcess(process: DshProcess): void {
    const held = this.#poolClaims.get(process) ?? 0;
    if (held <= 0) return;
    // The pair of the hold `#addPoolClaim` took; see the comment there for the
    // full contract (exactly one release per returned claim, and none for a
    // claim `#dropPoolClaims` already voided).
    this.#parked.release();
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
      // the meantime (the rewind's close-then-open does exactly that).
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
    // owned by an active write handle" — the same bound `ParkedSessions.quiesce`
    // exists for. A timeout is reported, not thrown: the open that follows will
    // surface the lock conflict itself if there is one.
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

  async #dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        return this.#catalog(input.requestId, input.cwd);
      case "sessions":
        return this.#listSessions(input);
      case "session.open":
        return this.#open(input);
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
        // The rewind's automatic reload runs after `session.revert` answered and
        // closes this provider session. A prompt accepted in that window races
        // the close: it can be cancelled by the reload, interleave with the
        // surface replacement, or append after the frozen replacement range.
        // Refuse it with a readable reason instead of losing it silently.
        if (this.#reverting.has(input.sessionId)) {
          this.#emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "failed", error: { message: "正在回退，请稍候" } },
          });
          return;
        }
        return this.#require(input.sessionId).prompt(input.prompt);
      }
      case "session.permission":
        this.#require(input.sessionId).resolvePermission(input.permissionId, input.response);
        return;
      case "session.configure": {
        const session = this.#require(input.sessionId);
        await session.configure(input.changes);
        this.#emit({ type: "session.config", sessionId: input.sessionId, config: session.configState() });
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.revert": {
        // A second rewind while the first one is refreshing would fail inside the
        // bridge, and its catch would clear the FIRST rewind's prompt gate while
        // the rebuild is still running. Refuse it without touching the gate.
        if (this.#reverting.has(input.sessionId)) {
          this.#emit({
            type: "request.failed",
            requestId: input.requestId,
            error: { message: "该会话已有撤回正在进行，请稍候" },
          });
          return;
        }
        const session = this.#require(input.sessionId);
        // From here until `session.close` the timeline is being rebuilt: prompts
        // are refused (see the `session.prompt` gate) so none is lost or left
        // outside the replacement range. A refused rewind must release the flag
        // immediately — nothing changes in that case.
        this.#reverting.add(input.sessionId);
        let result: DshRevertResult | undefined;
        try {
          // Child sessions throw before returning; the root session returns the bridge receipt.
          result = (await session.revert(input.token, input.scope)) as DshRevertResult | undefined;
        } catch (error) {
          this.#reverting.delete(input.sessionId);
          throw error;
        }
        // Answer first, refresh second, and never await the refresh: the daemon's
        // rewind holds a pending run until this request resolves, while the
        // refresh it would trigger closes this very provider session
        // (`reloadAgentSession` cancels in-flight runs) — awaiting it here
        // deadlocks the two. The 50 ms timer plus the CLI's own boot time keeps
        // the reply ahead of the restart.
        this.#emit({ type: "request.completed", requestId: input.requestId });
        // The daemon only rebuilds the timeline after the reload below, and the
        // click itself gives no feedback while that takes a second or so. A
        // notice is the one channel this provider has for a transient "working"
        // row: it lands after the revert succeeded (a refused or failed revert
        // never reaches here), and the rebuild that follows drops it with the
        // rest of the old timeline epoch. If the reload fails it stays next to
        // the "timeline was not refreshed" warning, which is honest.
        this.#notice(input.sessionId, "info", "正在回退，请稍候");
        const failedFiles = result?.files?.failed ?? [];
        if (failedFiles.length > 0) {
          // The conversation rewind succeeded; only some files did not. Defer
          // the notice until the reload opens the new session: emitted now, the
          // epoch rebuild would discard it and the user would never learn the
          // file side failed.
          this.#deferNotice(input.sessionId, {
            severity: "error",
            title: "文件回退未完成",
            // The rescue copy is the content the restore was about to replace
            // (already including the agent's edits), NOT the pre-edit state. The
            // pre-edit backups stay in the journal because the bridge skips
            // prune/trim/GC after a failure, so a second rewind retries them.
            description: `${failedFiles.map((entry) => entry.path).join("、")} 恢复失败；撤回前备份已保留（可重试撤回），被替换的当前内容已另存到 ${result?.files?.rescueDir ?? "(未知目录)"}。`,
          });
        }
        // Replaying `PluginProviderSession.streamHistory` cannot drop rows (the
        // buffer only grows and the plugin contract has no removal event), so the
        // timeline keeps the withdrawn messages until Paseo refreshes the agent.
        // Paseo's own docs define that refresh as "close the provider session and
        // open it again" — which replays the bridge's surface-folded history — and
        // the provider cannot trigger it through the SDK, so ask the daemon for it
        // below.
        this.#refreshAgent(input.sessionId);
        return;
      }
      case "session.interrupt": {
        await this.#require(input.sessionId).interrupt();
        this.#emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.close": {
        const session = this.#sessions.get(input.sessionId);
        // Keep the rewind gate: the daemon closes this session right before the
        // reload reopens it, and a prompt sent in that window must still get a
        // readable refusal (it would otherwise surface as `runtime_failed`).
        // The gate is released when `#open` reports the new session ready, by a
        // refresh-failure path, or by the 15s safety timer.
        this.#sessions.delete(input.sessionId);
        this.#agentIds.delete(input.sessionId);
        // Park an idle child: the daemon closes this session right before a
        // rewind refresh reopens it with the same persistence. `park` has **no
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
    const display = await loadCatalog(cwd ?? process.cwd());
    this.#display = display;
    this.#emit({ type: "catalog", requestId, catalog: display.defaults });
  }

  /** List DSH's stored sessions so Paseo can offer to import them. */
  async #listSessions(input: Extract<ProviderInput, { type: "sessions" }>): Promise<void> {
    const cwd = input.cwd ?? process.cwd();
    let sessions: Array<{ sessionId: string; cwd?: string; title?: string; preview?: string; updatedAt?: string }>;
    try {
      sessions = await listDshSessions(cwd, {
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
   * failed). A notice for a provider session that has already been closed is
   * **deferred** to the next session opened for the same DSH session, because
   * the rewind reload closes this provider session and the old timeline epoch
   * (including any notice in it) is discarded when it comes back. Dropping it
   * silently is what made a failed file restore invisible.
   *
   * @param sessionId - provider session the notice belongs to.
   * @param severity - provider notice severity.
   * @param title - one-line headline.
   * @param description - optional detail.
   */
  #notice(sessionId: string, severity: "info" | "warning" | "error", title: string, description?: string): void {
    if (this.#sessions.has(sessionId)) {
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
      return;
    }
    this.#deferNotice(sessionId, { severity, title, ...(description === undefined ? {} : { description }) });
  }

  /**
   * Queue a notice for the next session opened on the same DSH session.
   *
   * Used by the rewind path for outcomes that only become true after the
   * reload: a file restore failure, or a refresh failure. Queueing (rather than
   * emitting into the current epoch) is required because `reloadAgentSession`
   * discards the committed timeline and rebuilds it from the reopened
   * provider session's replay — anything emitted before that is gone.
   *
   * @param sessionId - provider session id the caller knows (may already be closed).
   * @param notice - notice payload.
   */
  #deferNotice(sessionId: string, notice: DeferredNotice): void {
    const dshSessionId = this.#dshIds.get(sessionId);
    if (dshSessionId === undefined) {
      process.stderr.write(
        `[${PROVIDER_ID}] dropping notice "${notice.title}": no DSH session is known for ${sessionId}\n`,
      );
      return;
    }
    const queue = this.#deferredNotices.get(dshSessionId) ?? [];
    queue.push(notice);
    if (queue.length > MAX_DEFERRED_NOTICES) {
      const dropped = queue.splice(0, queue.length - MAX_DEFERRED_NOTICES);
      process.stderr.write(
        `[${PROVIDER_ID}] dropping ${String(dropped.length)} old deferred notice(s) for ${dshSessionId}\n`,
      );
    }
    this.#deferredNotices.set(dshSessionId, queue);
    process.stderr.write(
      `[${PROVIDER_ID}] deferred notice "${notice.title}" until session ${dshSessionId} reopens\n`,
    );
  }

  /**
   * Deliver notices queued while the provider session was closed.
   *
   * Called from `#open` after `session.ready` — before the daemon builds the new
   * timeline from this session's replayed history — so the notice becomes a row
   * of the rebuilt epoch and survives on screen.
   *
   * @param sessionId - provider session that just opened.
   * @param dshSessionId - its DSH session id (the reload key).
   */
  #flushDeferredNotices(sessionId: string, dshSessionId: string): void {
    const queue = this.#deferredNotices.get(dshSessionId);
    if (queue === undefined || queue.length === 0) return;
    this.#deferredNotices.delete(dshSessionId);
    for (const notice of queue) {
      this.#emit({
        type: "session.notice",
        sessionId,
        notice: {
          id: `rewind-${String(Date.now())}-${String(Math.trunc(Math.random() * 1e6))}`,
          ...notice,
        },
      });
    }
  }

  /**
   * Resolve the `paseo` executable once: an explicit `PASEO_BIN` wins, else
   * `which` (a daemon may not carry the npm-global bin directory on PATH), else
   * the bare name so the failure is reported by spawn's error event.
   *
   * @returns the binary to spawn.
   */
  #resolvePaseoBinary(): string {
    if (this.#paseoBinary !== undefined) return this.#paseoBinary;
    const configured = process.env["PASEO_BIN"]?.trim();
    if (configured !== undefined && configured !== "") {
      this.#paseoBinary = configured;
      return configured;
    }
    try {
      const found = execFileSync("which", ["paseo"], { encoding: "utf8" }).trim();
      if (found !== "") {
        this.#paseoBinary = found;
        return found;
      }
    } catch {
      /* fall through to the bare name */
    }
    this.#paseoBinary = "paseo";
    return "paseo";
  }

  /**
   * Ask Paseo to refresh one agent, the way `paseo agent reload <id>` does.
   *
   * Why this exists at all: Paseo's plugin-provider adapter keeps an
   * append-only translated history and `revert()` cannot truncate it, while the
   * daemon rehydrates the timeline from exactly that history after a rewind
   * (upstream issue #4667, still open). The documented refresh semantics —
   * "close the current provider session and open it again with persistence" —
   * is the only way to make the timeline reflect the rewind, and the plugin SDK
   * exposes no call for it. Spawning the shipped CLI hits the daemon's own
   * `refresh_agent_request` path.
   *
   * The small delay is deliberate: the caller answers `session.revert` first
   * (the daemon holds a pending run until it is answered, and the refresh cancels
   * in-flight runs). It is kept short on purpose — spawning the CLI itself costs
   * ~500ms of node boot before the request even leaves, which comfortably covers
   * the daemon's rewind settle. Measured on the live daemon (agent 10c14347,
   * 8302-event session): rewind start → complete **2035ms**, not the ~52ms this
   * comment used to claim — that window spans the bridge's own `revert()` plus
   * the daemon's forced full-timeline rebuild (`hydrateTimelineFromProvider` with
   * `force: true`), so a long timer only adds latency to the user-visible refresh.
   *
   * Failures are reported to the user via a notice and the plugin log; the
   * rewind itself has already succeeded.
   *
   * @param sessionId - provider session whose agent should be reloaded.
   */
  #refreshAgent(sessionId: string): void {
    const timer = setTimeout(() => {
      // The provider can be torn down between the rewind and this timer; do not
      // spawn a CLI reload for a connection that no longer exists.
      if (this.#closed) return;
      const agentId = this.#agentIds.get(sessionId) ?? findPaseoAgentId(sessionId);
      if (agentId === undefined) {
        process.stderr.write(
          `[${PROVIDER_ID}] agent reload skipped: no agent record carries session ${sessionId}\n`,
        );
        this.#reverting.delete(sessionId);
        this.#notice(sessionId, "warning", "时间线未自动刷新", "撤回已完成，但未找到该会话对应的 agent；请手动执行 Reload agent。");
        return;
      }
      const binary = this.#resolvePaseoBinary();
      try {
        const child = spawn(binary, ["agent", "reload", agentId], {
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
        });
        // `spawn` reports a missing binary as an event, not a throw: without this
        // listener the refresh failed silently and the rewind looked applied only
        // to the conversation (that cost a whole debug round).
        child.on("error", (error) => {
          process.stderr.write(`[${PROVIDER_ID}] agent reload spawn failed (${binary}): ${messageOf(error)}\n`);
          // No reload will close the session: the conversation is usable again,
          // so stop refusing prompts and report through whatever channel exists.
          this.#reverting.delete(sessionId);
          this.#notice(sessionId, "warning", "时间线未自动刷新", "自动 Reload agent 启动失败；撤回已完成，请手动执行 Reload agent。");
        });
        let stderrText = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderrText += chunk;
        });
        child.on("exit", (code) => {
          const trimmed = stderrText.trim();
          process.stderr.write(
            `[${PROVIDER_ID}] agent reload ${agentId} exited ${String(code)}${trimmed === "" ? "" : `: ${trimmed.slice(0, 400)}`}\n`,
          );
          if (code !== 0) {
            this.#reverting.delete(sessionId);
            // If the old session is already closed this is queued and delivered
            // by the next session opened for the same DSH session.
            this.#notice(sessionId, "warning", "时间线未自动刷新", "自动 Reload agent 未成功；撤回已完成，请手动执行 Reload agent。");
          }
        });
        child.unref();
      } catch (error) {
        process.stderr.write(`[${PROVIDER_ID}] refreshing the agent after a rewind: ${messageOf(error)}\n`);
        this.#reverting.delete(sessionId);
        this.#notice(sessionId, "warning", "时间线未自动刷新", "自动 Reload agent 失败；撤回已完成，请手动执行 Reload agent。");
      }
      // Safety net: a reload that never reaches the reopen must not leave the
      // session permanently prompt-blocked. The reload's reopen clears the flag
      // (`#releaseRevertingFor`, keyed by DSH session id); this only fires when the
      // refresh path died silently, so the wording says that instead of claiming a
      // close that did happen.
      const safety = setTimeout(() => {
        if (this.#reverting.delete(sessionId)) {
          process.stderr.write(
            `[${PROVIDER_ID}] rewind reload did not reopen session ${sessionId} in 15s; prompts allowed again\n`,
          );
        }
      }, 15_000);
      safety.unref();
    }, 50);
    timer.unref();
  }

  async #open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const { sessionId, config } = input;
    // `send()` guards only at its entry. An open still running when the
    // connection is torn down would otherwise go on to spawn/attach and emit
    // `session.opened` / `session.ready` on a connection the daemon has already
    // dropped. The second check inside the transaction covers a teardown that
    // lands while the open is in flight.
    this.#assertConnected();
    const display = this.#display ?? (await loadCatalog(config.cwd));
    this.#display = display;

    // DSH's session id: the Paseo-minted one normally, but the native id when
    // Paseo reopens an imported session under a fresh agent id.
    const nativeId = input.persistence?.data;
    const dshSessionId =
      isRecord(nativeId) && typeof nativeId["sessionId"] === "string" ? nativeId["sessionId"] : sessionId;
    // Remember the reload key for this provider session: notices produced by the
    // rewind path after this session closes are queued under the DSH id and
    // delivered when the reload opens the next provider session for it.
    this.#dshIds.set(sessionId, dshSessionId);
    if (this.#dshIds.size > MAX_DSH_ID_MAPPINGS) {
      const excess = this.#dshIds.size - MAX_DSH_ID_MAPPINGS;
      let dropped = 0;
      for (const key of this.#dshIds.keys()) {
        if (dropped >= excess) break;
        this.#dshIds.delete(key);
        dropped += 1;
      }
      process.stderr.write(
        `[${PROVIDER_ID}] dropped ${String(dropped)} oldest provider→DSH session id mapping(s) (cap ${String(MAX_DSH_ID_MAPPINGS)})\n`,
      );
    }

    // The daemon injects the Paseo agent id into the provider session env; the
    // post-rewind refresh needs it because `paseo agent reload` takes the agent
    // id, and no plugin API maps a provider session to one.
    const agentId = typeof config.env?.["PASEO_AGENT_ID"] === "string"
      ? config.env["PASEO_AGENT_ID"].trim()
      : "";
    if (agentId !== "") this.#agentIds.set(sessionId, agentId);

    const route = parseRoute(config.model, display.fallbackRoute);

    // One DSH session can be materialized by one process only: its log carries a
    // kernel write lock (`SessionWriteLease` in
    // `@deepseek-ai/dsh-session-persistence-jsonl`), so a second live owner fails
    // every session-scoped request with "already owned by an active write handle".
    // Paseo normally closes the previous provider session before opening the next
    // one (that is what the rewind's reload does), so a holder here is an anomaly;
    // leaving both alive makes both unusable, and this provider used to report the
    // new one ready with an empty `/` menu. Resolve it the way the reload does:
    // close the session that already holds this DSH session first — an idle child
    // is parked and adopted by the open below, so nothing is killed unnecessarily.
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
      this.#sessions.delete(holder.id);
      this.#agentIds.delete(holder.id);
      // Tell the daemon the session it still believes is open is gone: silence
      // would leave prompts routed at a provider session this connection no longer
      // owns, surfacing later as an unexplained `runtime_failed`.
      this.#emit({ type: "session.closed", sessionId: holder.id });
    }

    // A parked child that cannot be reused may still be dying: TTL expiry, capacity
    // eviction or a route change killed it, and the session log's write lock is
    // released only when the OS reaps the process. Spawning the next process into
    // that window makes every session-scoped request fail with "already owned by an
    // active write handle". Wait (bounded) for the old owner before spawning; a
    // timeout is logged by the pool and the open proceeds, which is no worse than
    // the previous behavior. `routeKey` is the same identity `DshSession.open()`
    // uses to reuse a parked child (`routeKeyOf` in session.ts): provider + model,
    // never the effort.
    await this.#parked.quiesce(dshSessionId, {
      cwd: config.cwd,
      routeKey: `${route.provider}/${route.model}`,
    });

    // Paseo fills `config.systemPrompt` from the agent's own system prompt and the
    // daemon's `appendSystemPrompt` (`mapSessionConfig` in `@getpaseo/server`'s
    // `plugin-provider.js`). This provider has **no channel** for it: the bridge's
    // `initialize` carries cwd/route/effort only, and the profile's `system-prompt`
    // row is static. Silently ignoring it would let a user believe their
    // instructions reached the model, so it is reported loudly (stderr now, plus a
    // timeline notice once the session is ready) and never faked. The complete fix
    // needs a bridge-level per-session prompt section; until that exists this stays
    // explicitly unsupported.
    const unsupportedSystemPrompt =
      typeof config.systemPrompt === "string" && config.systemPrompt.trim() !== ""
        ? config.systemPrompt
        : undefined;
    if (unsupportedSystemPrompt !== undefined) {
      process.stderr.write(
        `[${PROVIDER_ID}] session ${sessionId}: Paseo supplied a ${String(unsupportedSystemPrompt.length)}-character system prompt, but this provider has no channel for it — it will NOT be applied\n`,
      );
    }

    /** Warnings collected during the open, emitted after `session.ready` so Paseo has the session. */
    const openWarnings: DeferredNotice[] = [];

    // The concurrent counterpart of the holder check above: two opens for one DSH
    // session must not interleave (both would pass the check and spawn a process,
    // and only one can own the log's write lock). There is no await between this
    // check and the insert, so it is atomic; the entry is released when the open
    // transaction ends, not when the session closes.
    if (this.#opening.has(dshSessionId)) {
      throw new Error(
        `cannot open ${sessionId}: another open for DSH session ${dshSessionId} is already in flight`,
      );
    }

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

    const session = new DshSession({
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
      acquireProcess: () => this.#acquirePoolProcess({ cwd: config.cwd, route, env: config.env ?? {} }),
      releaseProcess: (process) => {
        this.#releasePoolProcess(process);
      },
    });
    this.#sessions.set(sessionId, session);

    try {
      // Registered inside the try so no throw can leave the marker behind: an
      // entry that outlives its open would block every later open of this DSH
      // session. There is no await between the guard above and this insert, so the
      // check-and-set is still atomic.
      this.#opening.add(dshSessionId);
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
      const preset = settings["preset"];
      if (typeof preset === "string" && preset !== "") {
        try {
          await session.configure({ settings: { preset } });
        } catch (error) {
          process.stderr.write(`[${PROVIDER_ID}] preset "${preset}" rejected: ${messageOf(error)}\n`);
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
      } catch (error) {
        const message = messageOf(error);
        process.stderr.write(`[${PROVIDER_ID}] command catalog failed: ${message}\n`);
        openWarnings.push({
          severity: "warning",
          title: "命令目录加载失败",
          description: `DSH 未返回命令/权限目录：${message}。斜杠菜单与权限选择器可能不可用。`,
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
          process.stderr.write(`[${PROVIDER_ID}] history replay failed: ${messageOf(error)}\n`);
        }
      }
      // The materialization window is over: another open for this DSH session may
      // start (it would see this session as the holder and take it over), so the
      // in-flight marker must not outlive it.
      this.#opening.delete(dshSessionId);
      // The connection can be torn down while this open runs (`close()` does not
      // wait for opens in flight). Everything from here to the `session.opened`
      // emit is synchronous, so one check covers the whole publish step: a dead
      // connection must not announce a session it cannot serve, and the claim
      // this session holds has to be returned (the catch below closes it).
      this.#assertConnected();
    } catch (error) {
      // The gate is keyed by DSH session id: the host mints a fresh provider
      // session id for every open, so the id that was gated is not the one this
      // call is opening.
      this.#releaseRevertingFor(dshSessionId);
      this.#opening.delete(dshSessionId);
      // The daemon drops its own maps and rethrows on a failed open
      // (`PluginProvider.openSession`'s catch never sends `session.close`), so
      // this entry — and the `dsh` process `open()` has already spawned — would
      // otherwise live as long as the connection does. Every retry arrives under
      // a fresh session id, so they accumulate rather than replace each other.
      this.#sessions.delete(sessionId);
      this.#agentIds.delete(sessionId);
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
    this.#emit({ type: "session.config", sessionId, config: session.configState() });
    this.#emit({ type: "session.ready", requestId: input.requestId, sessionId });
    // The reload's reopen is complete: prompts are safe again. (A prompt sent
    // during close→reopen was refused by the `session.prompt` gate; the gate
    // must stay armed until here, not until `session.close`.) Release by DSH
    // session id: the host reopened this DSH session under a **new** provider
    // session id, so releasing only `sessionId` left the old id gated until the
    // 15 s safety timer and printed a misleading "reload did not close" warning
    // after every successful rewind.
    this.#releaseRevertingFor(dshSessionId);
    // Deliver what the previous session could not: a deferred file-restore
    // failure, or "the timeline was not refreshed". Emitted here — after the
    // session is usable and while the daemon is still collecting this session's
    // history — the notice is part of the rebuilt timeline instead of a row of
    // the old epoch that the reload discards.
    this.#flushDeferredNotices(sessionId, dshSessionId);
    // Report what this open degraded: a system prompt this provider cannot carry,
    // a command catalog that failed to load, or a permission preset that was not
    // applied. All three were previously either stderr-only or silent.
    if (unsupportedSystemPrompt !== undefined) {
      this.#notice(
        sessionId,
        "warning",
        "自定义 system prompt 未生效",
        "Paseo 为该会话配置了 system prompt，但本插件目前没有把它交给 DSH 的通道（需要桥提供会话级 prompt section）。该指令未生效；请改用 AGENTS.md 或 profile 配置。",
      );
    }
    for (const warning of openWarnings) {
      this.#notice(sessionId, warning.severity, warning.title, warning.description);
    }
    // The root is open: release any child the bridge reported during the open,
    // so a child is never emitted before its parent.
    session.markRootReady();
    // A reopened session resumes DSH's stored context without a turn, so ask the
    // runtime for its occupancy now; otherwise the readout stays empty until the
    // next prompt even though the runtime already knows the numbers.
    void session.refreshUsage();
    // Rebuild the native subagent tree on every open (a fresh `skip` or a reopen
    // `replay`). It reads DSH's durable catalog and child logs; it never creates
    // an agent, and a fresh session simply has none.
    void session.replaySubagents();
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
    //   child, so the old `#parked.discard` here would have killed every other
    //   open conversation along with it. The `discard` calls are gone; the tiers
    //   below only ever *add* a carrier.
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

  /**
   * Release the rewind prompt gate for every provider session of one DSH session.
   *
   * A provider session id is minted by the host on **every** open (`resumeSession`
   * included), so after the reload's reopen the gate sits under the previous id.
   * Releasing by DSH session id is what lets the reopen clear it; the 15 s safety
   * timer in `#refreshAgent` stays as a backstop for a refresh that never reports.
   *
   * @param dshSessionId - DSH session id the gate was armed for.
   */
  #releaseRevertingFor(dshSessionId: string): void {
    for (const [providerId, mapped] of this.#dshIds) {
      if (mapped === dshSessionId) this.#reverting.delete(providerId);
    }
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

/** The provider registration Paseo installs for `dsh --profile paseo`. */
export function createDshProvider(): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: "DeepSeek Harness",
    icon: "icon.svg",
    async connect(request) {
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      return new DshConnection(capabilities);
    },
  };
}

/**
 * Resolve the Paseo agent id that owns one provider session.
 *
 * Paseo hands the provider a session id, but `paseo agent reload` takes the
 * *agent* id, and the plugin API exposes no mapping — `PaseoApi.agents` is
 * list/ref/create/subscribe and the list payload has no session id.
 *
 * The authoritative mapping is `config.env.PASEO_AGENT_ID`, which the daemon sets
 * on every open (`#agentIds`). This scan of `~/.paseo/agents/<workspace>/<agentId>.json`
 * is only a fallback, and a deliberately limited one: the record stores the plugin
 * persistence handle, whose `data.sessionId` is the **DSH** session id — equal to
 * the provider session id only for a session that was never reopened (a reload
 * mints a new provider session id). So it can rescue a fresh session, not a
 * reopened one; there is no honest way to map the latter from the records. A
 * missing or unreadable store is not an error: it means "cannot refresh", and the
 * caller reports that rather than failing the rewind that already happened.
 *
 * @param sessionId - the provider session id Paseo opened this session with.
 * @returns the owning agent id, or undefined when no record claims that session.
 */
function findPaseoAgentId(sessionId: string): string | undefined {
  const root = join(homedir(), ".paseo", "agents");
  let workspaces: string[];
  try {
    workspaces = readdirSync(root);
  } catch {
    return undefined;
  }
  const matches: string[] = [];
  for (const workspace of workspaces) {
    const dir = join(root, workspace);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = readFileSync(join(dir, file), "utf8");
      } catch {
        continue;
      }
      // Cheap pre-filter before parsing: most records do not mention this session.
      if (!raw.includes(sessionId)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isRecord(parsed) || typeof parsed["id"] !== "string" || parsed["id"] === "") continue;
      // Exact claim only: a substring match could pick an agent whose record
      // merely mentions this session id (a child, an archive copy). Reloading the
      // wrong agent is worse than not reloading at all.
      const claimed = claimedSessionIds(parsed);
      if (!claimed.includes(sessionId)) continue;
      if (!matches.includes(parsed["id"])) matches.push(parsed["id"]);
    }
  }
  if (matches.length > 1) {
    process.stderr.write(
      `[${PROVIDER_ID}] cannot map session ${sessionId} to one agent (${matches.length} records claim it); skipping automatic reload\n`,
    );
    return undefined;
  }
  return matches[0];
}

/**
 * Session ids one stored agent record claims through its persistence handle.
 *
 * The daemon's registry stores the provider handle as a JSON string
 * (`plugin:{"version":1,"data":{"sessionId":"…"}}`); runtimeInfo carries the
 * same handle. Parsing it is the exact match the substring scan was missing.
 *
 * @param record - parsed agent record.
 * @returns every DSH session id the record claims.
 */
function claimedSessionIds(record: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const values: unknown[] = [];
  const persistence = record["persistence"];
  if (typeof persistence === "string") values.push(persistence);
  else if (isRecord(persistence)) values.push(persistence["sessionId"]);
  const runtime = record["runtimeInfo"];
  if (isRecord(runtime)) values.push(runtime["sessionId"]);
  for (const value of values) {
    if (typeof value !== "string" || value === "") continue;
    if (value.startsWith("plugin:")) {
      try {
        const parsed = JSON.parse(value.slice("plugin:".length)) as { data?: { sessionId?: unknown } };
        if (typeof parsed.data?.sessionId === "string") ids.push(parsed.data.sessionId);
      } catch {
        // Not a plugin persistence handle; ignore instead of guessing.
      }
    } else {
      ids.push(value);
    }
  }
  return ids;
}
