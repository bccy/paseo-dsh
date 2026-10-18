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
import { DshProcess, type DshCatalog, type DshRevertResult } from "./dsh-process";
import { DshChildSession, DshSession, modes, parseRoute } from "./session";
import { ParkedSessions } from "./parked-sessions";
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
 * Last-resort route. The DSH profile's `agent-default-model` is the real source
 * of truth and is read from every catalog; this only backs a profile that
 * composes no default at all, so it deliberately names nothing anyone runs.
 */
const FALLBACK_ROUTE = { provider: "unset", model: "unset" };
const CATALOG_TTL_MS = 5 * 60 * 1000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The DSH profile that must exist for this provider to work. */
function profileName(): string {
  return process.env.DSH_PASEO_PROFILE ?? "paseo";
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
      ...(model.description === undefined ? {} : {}),
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

  return {
    models,
    thinkingOptions,
    fallbackRoute:
      raw.defaultProvider !== undefined && raw.defaultModel !== undefined
        ? { provider: raw.defaultProvider, model: raw.defaultModel }
        : FALLBACK_ROUTE,
    defaults: {
      models,
      modes: modes(),
      thinkingOptions,
      ...(defaultModel === undefined ? {} : { defaultModel }),
      defaultMode: "build",
      ...(raw.defaultReasoningEffort === undefined || raw.defaultReasoningEffort === null
        ? {}
        : { defaultThinkingOption: raw.defaultReasoningEffort }),
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
  #display: DisplayCatalog | undefined;
  #paseoBinary: string | undefined;
  #closed = false;
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
    // Provider teardown is not a reload: shut the sessions down and kill the
    // parked children instead of keeping them alive for a reopen that will not
    // happen on this connection.
    await Promise.allSettled(sessions.map((session) => session.close({ park: false })));
    this.#parked.stop();
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
            description: `${failedFiles.map((entry) => entry.path).join("、")} 恢复失败；恢复前的原内容已备份到 ${result?.files?.rescueDir ?? "(未知目录)"}。`,
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
        this.#reverting.delete(input.sessionId);
        this.#sessions.delete(input.sessionId);
        this.#agentIds.delete(input.sessionId);
        // Park an idle child: the daemon closes this session right before a
        // rewind refresh reopens it with the same persistence.
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
   * the daemon's rewind settle (measured: rewind start → complete ≈ 52ms), so a
   * long timer only adds latency to the user-visible refresh.
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
      // Safety net: a reload that never reaches `session.close` must not leave
      // the session permanently prompt-blocked. The normal close clears the flag
      // far earlier; this only fires when the refresh path died silently.
      const safety = setTimeout(() => {
        if (this.#reverting.delete(sessionId)) {
          process.stderr.write(
            `[${PROVIDER_ID}] rewind reload did not close session ${sessionId} in 15s; prompts allowed again\n`,
          );
        }
      }, 15_000);
      safety.unref();
    }, 50);
    timer.unref();
  }

  async #open(input: Extract<ProviderInput, { type: "session.open" }>): Promise<void> {
    const { sessionId, config } = input;
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

    // The daemon injects the Paseo agent id into the provider session env; the
    // post-rewind refresh needs it because `paseo agent reload` takes the agent
    // id, and no plugin API maps a provider session to one.
    const agentId = typeof config.env?.["PASEO_AGENT_ID"] === "string"
      ? config.env["PASEO_AGENT_ID"].trim()
      : "";
    if (agentId !== "") this.#agentIds.set(sessionId, agentId);

    const route = parseRoute(config.model, display.fallbackRoute);
    const session = new DshSession({
      sessionId,
      dshSessionId,
      cwd: config.cwd,
      env: config.env ?? {},
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
      takeParked: (dshSessionId, expected) => this.#parked.take(dshSessionId, expected)?.process,
      parkProcess: (process, meta) => this.#parked.park({
        process,
        sessionId: meta.sessionId,
        dshSessionId: meta.dshSessionId,
        cwd: meta.cwd,
        routeKey: meta.routeKey,
      }),
    });
    this.#sessions.set(sessionId, session);

    try {
      await session.open();
    } catch (error) {
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
    // moment the session is usable. A command catalog is an enhancement, never a
    // precondition: a discovery failure logs and leaves the menu empty rather
    // than failing the whole open.
    try {
      await session.loadCommands();
      await session.loadPermission();
      await session.loadPresets();
    } catch (error) {
      process.stderr.write(`[${PROVIDER_ID}] command catalog failed: ${messageOf(error)}\n`);
    }

    // Permission applies to the live agent (it runs `/permission`), so it must
    // wait until one exists.
    const permission = settings["permission"];
    if (typeof permission === "string" && permission !== "") {
      try {
        await session.configure({ settings: { permission } });
      } catch (error) {
        process.stderr.write(`[${PROVIDER_ID}] permission "${permission}" rejected: ${messageOf(error)}\n`);
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
    // Deliver what the previous session could not: a deferred file-restore
    // failure, or "the timeline was not refreshed". Emitted here — after the
    // session is usable and while the daemon is still collecting this session's
    // history — the notice is part of the rebuilt timeline instead of a row of
    // the old epoch that the reload discards.
    this.#flushDeferredNotices(sessionId, dshSessionId);
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
    // DSH's registry is process-global, so a session that is already open can
    // carry the request — which is what lets a native child, with no process of
    // its own, be archived through its root. But the archive *record* and the
    // act of stopping live work are different things: the record lands on disk,
    // while stopping happens in the process that owns the session. So the root
    // actually holding this id goes first, and every other root is only a
    // fallback. When nothing is open (the state after Paseo archived the last
    // session), fall back to a throwaway runtime: the archive set lives in DSH's
    // home, not in this process.
    const ordered = [...this.#sessions.values()].sort(
      (a, b) => Number(b.holdsDshSession(dshSessionId)) - Number(a.holdsDshSession(dshSessionId)),
    );
    const reasons: string[] = [];
    for (const session of ordered) {
      try {
        await session.archiveDshSession(dshSessionId, archived);
        return;
      } catch (error) {
        // A rescued failure still means this process did not do it, so it is
        // reported rather than swallowed; the reasons are also what the caller
        // sees if every attempt fails.
        reasons.push(messageOf(error));
        process.stderr.write(
          `[${PROVIDER_ID}] ${archived ? "archive" : "unarchive"} via ${session.dshId} failed: ${messageOf(error)}\n`,
        );
      }
    }
    try {
      await applyArchivedStandalone(dshSessionId, archived);
    } catch (error) {
      reasons.push(messageOf(error));
      throw new Error(
        `cannot ${archived ? "archive" : "unarchive"} ${dshSessionId}: ${reasons.join("; ")}`,
      );
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

  #emit(event: ProviderEvent): void {
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

export { profileName };

/**
 * Resolve the Paseo agent id that owns one provider session.
 *
 * Paseo hands the provider a session id, but `paseo agent reload` takes the
 * *agent* id, and the plugin API exposes no mapping — `PaseoApi.agents` is
 * list/ref/create/subscribe and the list payload has no session id. The daemon's
 * own agent record does carry both: `~/.paseo/agents/<workspace>/<agentId>.json`
 * stores `persistence.sessionId` (a JSON string that embeds the provider session
 * id). Scanning those small files is cheap enough for a rewind, which is rare.
 *
 * A missing or unreadable store is not an error: it means "cannot refresh", and
 * the caller says so rather than failing the rewind that already happened.
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
