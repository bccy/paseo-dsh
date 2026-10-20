/**
 * One Paseo agent session backed by one `dsh --profile paseo` process.
 *
 * The session translates between Paseo's provider vocabulary (models, modes,
 * thinking options, permission cards) and the bridge's JSON-RPC surface.
 *
 * @module dsh-paseo/server/session
 */
import type {
  ProviderConfigChanges,
  ProviderConfigState,
  ProviderContent,
  ProviderEvent,
  ProviderMode,
  ProviderModel,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderPrompt,
  ProviderSetting,
  ProviderThinkingOption,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "./dsh-process";
import {
  DshProcess,
  type DshAnswer,
  type DshChildOpened,
  type DshMcpServer,
  type DshPermissionPreset,
  type DshProcessHandlers,
  type DshQuestion,
  type DshQuestionRequest,
  type DshRevertResult,
  type DshRoute,
  type DshUsage,
} from "./dsh-process";
import { TimelineBuilder } from "./timeline";

/**
 * The durable event time as the provider timestamp for a replayed row.
 *
 * Paseo stamps each `timeline.item` with its own arrival time when the provider
 * omits `timestamp` — correct while live, catastrophic for a replay: every
 * historical row would be stamped at reopen time. The client derives each
 * turn's "worked for" duration from its rows' timestamps (last item minus the
 * turn's user message), so a reload/rewind reopen collapsed every earlier
 * turn's displayed duration to 0. The stored DSH event time is the only source
 * that survives.
 */
function replayTimestamp(event: { time?: unknown }): string | undefined {
  return typeof event.time === "number" && Number.isFinite(event.time)
    ? new Date(event.time).toISOString()
    : undefined;
}
import { UI, commandCopy, presetLabel, skillDescription } from "./locale";

/**
 * Modes Paseo offers in the composer. `plan` drives DSH's plan-mode service.
 *
 * The ids are wire values and stay stable across locales; only the label and
 * description are localized.
 */
export function modes(): ProviderMode[] {
  return UI.modes.map((mode) => ({ id: mode.id, label: mode.label, description: mode.description }));
}

/** Bounded cap on child notices held until the root is ready or their parent appears. */
const CHILD_BUFFER_LIMIT = 2000;

/**
 * Held events for one label-less child before it is opened without a title.
 *
 * Paseo renders a child whose title never arrived as "加载中…" forever: children
 * have no configuration channel (`DshChildSession.configState` throws), so the
 * title carried by the single `session.opened` is the only one they can ever
 * have. A child's durable label lives in its own `subagent/descriptor`, so a
 * notice that arrives without one is held until that descriptor lands — but
 * only this long, because a provider that never sends one must still have its
 * earliest output delivered rather than dropped.
 */
const CHILD_LABEL_WAIT_EVENTS = 40;

export interface DshSessionOptions {
  sessionId: string;
  /**
   * DSH's own session id. Equal to {@link sessionId} for a Paseo-created
   * session; different when a session is imported, where Paseo mints a new id
   * but DSH keeps the native one.
   */
  dshSessionId?: string;
  cwd: string;
  env: Record<string, string>;
  /**
   * Paseo's stable agent id for this session (from `config.env.PASEO_AGENT_ID`).
   *
   * Native child provider ids are scoped by it. A plugin reload mints a new
   * root provider session id for the *same* agent, while Paseo's
   * provider-subagent store keys rows by `parentAgentId + subagentId` and only
   * clears them on an agent reload — so scoping children by the root provider
   * id made every plugin reload replay the same children under fresh ids and
   * show each one twice. Scoping by the agent id keeps ids stable across
   * reloads, and two agents resuming the same native child still get distinct
   * ids (they also get distinct `parentAgentId`s, so neither row collides).
   */
  agentId?: string;
  /**
   * MCP servers Paseo attached to this session. Forwarded verbatim: the process
   * turns them into the `--patch` overlay DSH reads at boot, which is the only
   * point DSH accepts them.
   */
  mcpServers?: Readonly<Record<string, DshMcpServer>>;
  route: DshRoute;
  mode: string;
  /** Models Paseo can switch to for this session, from the cached catalog. */
  models: ProviderModel[];
  /** Thinking options the catalog advertises. */
  thinkingOptions: ProviderThinkingOption[];
  /**
   * Whether Paseo negotiated `session.subsession` for this connection. When
   * false the host cannot accept a provider-owned child at all, so this session
   * must not emit any child opened/event (and must not fail the parent either).
   */
  subsession: boolean;
  emit(event: ProviderEvent): void;
  log(line: string): void;
  /**
   * Adopt a parked, idle process for this native session id instead of spawning.
   *
   * Used by the rewrite refresh path: the daemon's "reload agent" closes the
   * provider session and reopens it with persistence, and a cold spawn is the
   * slow half of that refresh. A miss (undefined) cold-starts as before.
   */
  takeParked?(dshSessionId: string, expected: { cwd: string; routeKey: string }): DshProcess | undefined;
  /**
   * Offer this session's idle process for reuse instead of shutting it down.
   *
   * @returns whether the caller accepted it; a false answer falls back to a
   *   protocol shutdown.
   */
  parkProcess?(process: DshProcess, meta: { sessionId: string; dshSessionId: string; cwd: string; routeKey: string }): boolean;
}

/**
 * The durable creation label of a `subagent/descriptor` event, when it has one.
 *
 * This is the same field the bridge reads to title a child; reading it here too
 * is what lets a held notice open with a real title.
 */
function subagentLabel(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const label = data.label;
  return typeof label === "string" && label !== "" ? label : undefined;
}

/** The first durable creation label in a replayed child's own history. */
function labelFromHistory(
  events: Array<{ type: string; data?: unknown }>,
): string | undefined {
  for (const event of events) {
    if (event.type !== "subagent/descriptor") continue;
    const label = subagentLabel(event.data);
    if (label !== undefined) return label;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The `/name args` line a command runs as, and the line the transcript echoes.
 *
 * One builder for both, so the row the user reads is always the command that ran.
 */
function slashLine(name: string, args: string): string {
  return args.trim() === "" ? `/${name}` : `/${name} ${args}`;
}

/** Concatenate the text blocks of a DSH message's content. */
function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
}

/**
 * The text one user row carries for a DSH message's content blocks.
 *
 * {@link textBlocks} alone is not enough: a prompt may carry only an image
 * (Paseo sends pictures with no text at all), and a replay that skipped every
 * text-less message dropped the user's turn — and with it the row's revert
 * token — on each reopen. A block with no text is named by its kind instead, so
 * the row says what it was rather than nothing, and the live row is built by
 * this same function so a reopened conversation looks like the live one.
 *
 * Only the block *kind* is stated: the bytes cannot ride a Paseo user_message
 * row (the protocol has no attachment field), and a path here would put a
 * host-local path into the transcript.
 */
function messageRowText(content: unknown): string {
  const text = textBlocks(content);
  if (text !== "") return text;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "" || type === "text") continue;
    parts.push(`[${type}]`);
  }
  return parts.join(" ");
}

/**
 * Whether a prompt's DSH source kind is the human's own turn.
 *
 * `sourceKind` is the DSH `source.kind` of the user message the bridge appended
 * (`DshProcess.prompt`'s reply carries it). Paseo wraps everything it says on its
 * own behalf — a schedule fire, a notify-on-finish notice — in a
 * `<paseo-system>` envelope, and the bridge records those prompts under a
 * non-`user` kind so the transcript does not attribute the host's own notice to
 * the human (see `dsh-bridge/lib/paseo-system-envelope.js`). Live rows and the
 * replay filter must agree, so a non-`user` kind gets no user row.
 *
 * A missing kind (an older bridge) keeps the previous behaviour: treat the
 * prompt as the human's own and emit the row, rather than silently drop a real
 * turn.
 */
function isUserSource(sourceKind: string | undefined): boolean {
  return sourceKind === undefined || sourceKind === "user";
}

/** Resolve Paseo's catalog id (`provider/model`) back into a DSH route. */
export function parseRoute(model: string | undefined, fallback: DshRoute): DshRoute {
  if (model === undefined || model === "") return fallback;
  const slash = model.indexOf("/");
  if (slash <= 0) return { ...fallback, model };
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/**
 * The identity a parked process is reused under.
 *
 * Only provider+model are pinned at process boot (`initialize`); the thinking
 * effort is applied by `session.configure` after the session opens, so it must
 * NOT take part in reuse: a reload reopens the session before that configure
 * runs, and including the effort here made every reload look like a route change
 * and kill a perfectly reusable child (measured +2.2s of cold start).
 */
function routeKeyOf(route: DshRoute): string {
  return `${route.provider}/${route.model}`;
}

export class DshSession {
  readonly id: string;
  /** DSH's session id (see {@link DshSessionOptions.dshSessionId}). */
  readonly #dshSessionId: string;
  readonly #options: DshSessionOptions;
  readonly #timeline = new TimelineBuilder({ warn: (line) => this.#options.log(line) });
  #process: DshProcess | undefined;
  #route: DshRoute;
  #mode: string;
  #thinkingOption: string | undefined;
  #turnId: string | null = null;
  /**
   * How DSH ended the turn that is currently open, from its own `turn/end`.
   *
   * The root's terminal `session.turn` is emitted when the agent goes idle, so
   * without this the state would be a guess — and the guess was always
   * `completed`. A turn the user stopped then reached Paseo as a *finished* one:
   * Paseo's `turn_completed` branch never resolves the pending permissions an
   * interruption abandons, and the UI cannot tell "stopped" from "done". The
   * state is read from DSH's reason instead, exactly as {@link DshChildSession}
   * already does for a subagent and as Paseo's own adapters report a canceled
   * turn. `null` means no `turn/end` has been seen for this turn, which is the
   * status-only ending the idle fallback still closes as `completed`.
   */
  #turnEndState: { state: "completed" | "canceled" | "failed"; error?: string } | null = null;
  #replaySeq = 0;
  /**
   * Whether this session adopted a parked `dsh` process (what the rewind
   * refresh's close/reopen does) instead of cold-starting one.
   *
   * An adopted process never stopped: its running child agents kept running
   * while this provider session was closed, so a child's open turn is live
   * evidence even though the bridge announced that child to the *previous*
   * provider session and will not announce it again. A cold start keeps the old
   * rule — a child log that stops inside a turn with no live channel is a killed
   * child and closes as canceled (see `replaySubagents`).
   */
  #adoptedParkedProcess = false;
  /**
   * Pending question cards keyed by permission id, remembering which session
   * (root or a native subagent child) asked so the resolution is attributed
   * back to the same session.
   */
  #pendingPermissions = new Map<string, { sessionId: string; resolve: (response: ProviderPermissionResponse) => void }>();
  /** Native subagent child sessions, keyed by DSH's own child session id. */
  #children = new Map<string, DshChildSession>();
  /** The same children, keyed by the root-scoped Paseo provider id they emit. */
  #childByProviderId = new Map<string, DshChildSession>();
  /** Whether Paseo negotiated `session.subsession`; gates every child emission. */
  readonly #subsession: boolean;
  /** Set once the root has emitted `session.ready`; children are gated on it. */
  #rootReady = false;
  /** Child opened notices held until the root is ready or their parent appears. */
  #pendingOpened: DshChildOpened[] = [];
  /** Child events and statuses held until the root is ready. */
  #pendingChildEvents: Array<
    | { kind: "event"; sessionId: string; event: { type: string; [key: string]: unknown } }
    | { kind: "status"; sessionId: string; status: string }
  > = [];
  /**
   * Children whose stored history is being replayed (read + open + replay).
   *
   * Their frames can arrive during the history round trip, before the child view
   * exists. Dropping one there loses a terminal `turn/end` (or `tool/result`) and
   * leaves an adopted mid-turn child running forever, so they are buffered and
   * delivered right after the replay; `#flushPendingChildren` routes them.
   */
  #replayPending = new Set<string>();
  /**
   * True while {@link replaySubagents} awaits the child listing.
   *
   * `#replayPending` cannot be filled before that RPC returns (the ids are its
   * payload), and a child already running in an adopted parked process is never
   * announced again by the bridge — so a frame arriving inside that one await
   * window has no child view, no held notice and no replay entry, and would be
   * classified as a ghost and dropped. A `turn/end` lost there leaves the child
   * row running after a rewind reload (the failure FIELD-NOTES 61/62 fixed on the
   * other side of the same window). Frames are therefore held for the length of
   * the RPC and routed by the ordinary flush once the listing is in.
   */
  #childReplayWindow = false;
  #childBufferWarned = false;
  /** Guards {@link #flushPendingChildren} against re-entrant invocation. */
  #flushing = false;
  /**
   * Slash-menu entries by name, tagging why each exists.
   *
   * The name is the one DSH registered: Paseo's command contract has no separate
   * display name, so a command is localized in its description, never its name.
   */
  #commandKinds = new Map<string, "command" | "skill">();
  /** Current DSH permission preset key, and the switchable ones. */
  #permission: string | null = null;
  #permissionPresets: DshPermissionPreset[] = [];
  /** Current agent preset (persona + capabilities), and the switchable ones. */
  #preset: string | null = null;
  #presetOptions: Array<{ label: string; value: string }> = [];
  /**
   * Last usage snapshot published to Paseo. Paseo replaces its whole usage
   * record on every `session.usage`, so token counts and context occupancy must
   * always travel together; this is the complete picture they are merged into.
   */
  #lastUsage: ProviderUsage | undefined;
  /** Newest issued occupancy poll; a slower older response must not win. */
  #usageGeneration = 0;
  #usageRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: DshSessionOptions) {
    this.id = options.sessionId;
    this.#dshSessionId = options.dshSessionId ?? options.sessionId;
    this.#options = options;
    this.#route = options.route;
    this.#mode = options.mode === "plan" ? "plan" : "build";
    this.#thinkingOption = options.route.reasoningEffort;
    this.#subsession = options.subsession === true;
  }

  /**
   * The callbacks a DSH process reports to. Extracted so a parked process can be
   * re-pointed at a new session without respawning (see {@link DshSessionOptions}).
   *
   * @returns the handler set for one process.
   */
  #processHandlers(): DshProcessHandlers {
    return {
      onEvent: (payload) => this.#onSessionEvent(payload),
      onStatus: (status, sessionId) => this.#onStatus(status, sessionId),
      onQuestion: (request, sessionId) => this.#onQuestion(request, sessionId),
      onChildOpened: (payload) => this.#onChildOpened(payload),
      onLog: (line) => this.#options.log(line),
      onExit: (code, signal) => {
        if (this.#closed) return;
        this.#closed = true;
        clearTimeout(this.#usageRefreshTimer);
        this.#options.emit({
          type: "session.runtime_failed",
          sessionId: this.id,
          error: { message: `DeepSeek Harness exited (code ${code ?? "null"}, signal ${signal ?? "none"})` },
        });
      },
      onProtocolError: (message) => this.#options.log(`protocol: ${message}`),
    };
  }

  /** Adopt a parked process or spawn one, pin the route, reconcile the mode. */
  async open(): Promise<void> {
    const expected = { cwd: this.#options.cwd, routeKey: routeKeyOf(this.#route) };
    const offered = this.#options.takeParked?.(this.#dshSessionId, expected);
    // `take` checks `running`, but the child can exit between that check and the
    // moment its handlers are re-pointed. A dead adoption would produce a session
    // that never answers; cold-start instead (the pool entry is already gone).
    const adopted = offered !== undefined && offered.running ? offered : undefined;
    this.#adoptedParkedProcess = adopted !== undefined;
    if (offered !== undefined && adopted === undefined) {
      this.#options.log(`parked process for ${this.#dshSessionId} exited before adoption; cold-starting`);
      offered.kill();
    }
    let process: DshProcess;
    if (adopted !== undefined) {
      // The child kept running across the provider-session close; re-point its
      // events at this session and skip the spawn + profile load entirely.
      process = adopted;
      process.setHandlers(this.#processHandlers());
    } else {
      process = new DshProcess({
        cwd: this.#options.cwd,
        route: this.#route,
        sessionId: this.#dshSessionId,
        env: this.#options.env,
        mcpServers: this.#options.mcpServers,
        ...this.#processHandlers(),
      });
    }
    this.#process = process;
    await process.start();
    // A parked child may still be in plan mode from its previous session; the
    // reopen's mode is authoritative, so reconcile both directions. A freshly
    // spawned child starts in build, so only a plan open needs the extra write.
    // A profile that composes no plan-mode service must not fail the whole open
    // here: the conversation is usable in build mode and the log says why the
    // toggle could not be applied.
    if (adopted !== undefined || this.#mode === "plan") {
      try {
        await process.setPlan(this.#mode === "plan");
      } catch (error) {
        this.#options.log(
          `plan mode could not be reconciled on open (${this.#mode}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** The committed configuration Paseo renders in the composer. */
  configState(): ProviderConfigState {
    const settings: ProviderSetting[] = [];
    // The agent preset is a creation-time persona + capability set. Paseo still
    // renders it as a normal select, but DSH locks the choice once the session's
    // first turn starts, so switching it later is rejected and snaps back.
    if (this.#presetOptions.length > 0) {
      settings.push({
        type: "select",
        id: "preset",
        label: UI.settings.preset.label,
        description: UI.settings.preset.description,
        value: this.#preset,
        options: this.#presetOptions,
      });
    }
    // Surface DSH's permission presets as a composer control, so switching
    // between sandboxed and full access doesn't require typing /permission.
    //
    // The label is the preset's own configured `name`, never its key: a
    // deployment that renames presets (including into another language) must see
    // its label, while `value` stays the key `/permission` accepts. DSH's
    // per-preset `description` is not carried here because Paseo's select
    // options have no description slot — it stays on the bridge response for a
    // future UI that can show it.
    if (this.#permissionPresets.length > 0) {
      settings.push({
        type: "select",
        id: "permission",
        label: UI.settings.permission.label,
        description: UI.settings.permission.description,
        value: this.#permission,
        options: this.#permissionPresets.map((preset) => ({
          label: preset.name,
          value: preset.value,
        })),
      });
    }
    const thinkingOptions = this.#thinking();
    return {
      model: `${this.#route.provider}/${this.#route.model}`,
      mode: this.#mode,
      ...(this.#thinkingOption === undefined ? {} : { thinkingOption: this.#thinkingOption }),
      models: this.#models(),
      modes: modes(),
      thinkingOptions,
      settings,
    };
  }

  #models(): ProviderModel[] {
    return this.#options.models;
  }

  /**
   * The current model's own thinking options. Reporting a global fallback made
   * the composer offer efforts the model cannot serve, and every dropped choice
   * snapped the selector back to off.
   */
  #thinking(): ProviderThinkingOption[] {
    const id = `${this.#route.provider}/${this.#route.model}`;
    return this.#options.models.find((entry) => entry.id === id)?.thinkingOptions ?? [];
  }

  /** Thinking-effort ids the current model actually declares; empty means none. */
  #supportedEfforts(): string[] {
    return this.#thinking().map((option) => option.id);
  }

  /**
   * Publish the session's `/` menu: DSH's registered human commands plus every
   * user-invocable skill.
   *
   * Both appear in the composer's slash menu, but they run differently, so the
   * kind is remembered for {@link prompt}: a command executes in the runtime, a
   * skill rides a `/name` user message.
   */
  async loadCommands(): Promise<void> {
    const commands = await this.#require().commands();
    this.#commandKinds.clear();
    const advertised = commands.map((command) => {
      this.#commandKinds.set(command.name, command.kind);
      // A skill keeps its name — that token is what DSH injects from a `/name`
      // line — and only its menu description is localized.
      if (command.kind !== "command") {
        return {
          name: command.name,
          description: skillDescription(command.name, command.description),
          ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
        };
      }
      return commandCopy(command.name, {
        description: command.description,
        ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
      });
    });
    this.#options.emit({
      type: "session.commands",
      sessionId: this.id,
      commands: advertised,
    });
  }

  /** Read the current permission preset and the switchable ones, for the composer. */
  async loadPermission(): Promise<void> {
    const permission = await this.#require().permission();
    if (!permission.available) return;
    this.#permission = permission.current;
    this.#permissionPresets = permission.presets;
  }

  /**
   * Rewind to just before one user message.
   *
   * The token is opaque to Paseo: it hands back the `revertToken` our timeline
   * row carried. The bridge owns the translation and the refusal cases (row no
   * longer visible, worktree dirty), so this only forwards.
   */
  async revert(
    token: unknown,
    scope: "conversation" | "files" | "both",
  ): Promise<DshRevertResult | undefined> {
    const result = await this.#require().revert(token, scope);
    // A rewind removes the turn that asked the question, so any card still waiting
    // belongs to a conversation that no longer exists. Left pending, the daemon
    // keeps showing it and a later click answers a question nobody is waiting for
    // — the same failure a steer used to have.
    this.#clearPendingPermissions("The conversation was rewound past this question, so it is no longer waiting for an answer.");
    return result;
  }

  /**
   * Read the agent presets the profile declares, for the composer. Optional: a
   * profile that mounts no preset registry simply gets no Preset control.
   */
  async loadPresets(): Promise<void> {
    const info = await this.#require().presets();
    if (!info.available) return;
    this.#preset = info.current ?? info.default;
    this.#presetOptions = info.presets.map((preset) => ({
      value: preset.id,
      // DSH reports the id; the display name comes from DSH's own wording for its
      // built-in presets (locale.ts), so the app names them like the web UI does.
      label: presetLabel(preset.id, preset.name),
    }));
  }

  /**
   * Refresh the context-occupancy half of the usage readout from the runtime.
   *
   * DSH measures occupancy on demand by replaying the session log through its
   * token meter, so it is polled where it can change: a session open or resume,
   * the end of a turn, a model switch, and a compaction. Only the newest
   * in-flight poll may publish, so a slow answer from a previous model — or one
   * arriving after the session closed — can never overwrite fresher numbers.
   * Unknown fields are omitted: the composer shows what the runtime actually
   * knows rather than a fabricated window.
   */
  async refreshUsage(): Promise<void> {
    if (this.#closed) return;
    clearTimeout(this.#usageRefreshTimer);
    this.#usageRefreshTimer = undefined;
    const process = this.#process;
    if (process === undefined) return;
    const generation = ++this.#usageGeneration;
    let snapshot: DshUsage;
    try {
      snapshot = await process.usage();
    } catch (error) {
      if (this.#closed || generation !== this.#usageGeneration) return;
      this.#options.log(`usage query failed: ${messageOf(error)}`);
      snapshot = { available: false };
    }
    if (this.#closed || generation !== this.#usageGeneration) return;
    const patch: ProviderUsage = {
      ...(snapshot.available && typeof snapshot.contextWindow === "number" && Number.isSafeInteger(snapshot.contextWindow) && snapshot.contextWindow > 0
        ? { contextWindowMaxTokens: snapshot.contextWindow }
        : {}),
      ...(snapshot.available && typeof snapshot.usedTokens === "number" && Number.isSafeInteger(snapshot.usedTokens) && snapshot.usedTokens >= 0
        ? { contextWindowUsedTokens: snapshot.usedTokens }
        : {}),
    };
    // This is a complete context snapshot: absence clears a formerly known
    // value instead of retaining another model's capacity or a stale numerator.
    this.#emitUsage(patch, true);
  }

  /** Coalesce step/tool updates without measuring on every streamed token. */
  #queueUsageRefresh(): void {
    if (this.#closed) return;
    this.#usageGeneration += 1;
    if (this.#usageRefreshTimer !== undefined) return;
    this.#usageRefreshTimer = setTimeout(() => {
      this.#usageRefreshTimer = undefined;
      void this.refreshUsage();
    }, 75);
  }

  /**
   * Replay a stored session's conversation into the Paseo timeline.
   *
   * Paseo asks for this (`history: "replay"`) when it reopens a session — after
   * a restart, or when importing a native DSH session. DSH's resume restores the
   * model's context but never re-emits the events, so without this the reopened
   * session would show an empty conversation. Only real user turns are replayed
   * as user messages; DSH's injected context (skill catalogs, runtime snapshots,
   * approval notices) carries a different `source.kind` and is skipped.
   */
  async replayHistory(): Promise<void> {
    const { events, available, error } = await this.#require().history();
    // A failed read is not an empty session. Returning silently here is what
    // made "the replay timed out" look exactly like "there was nothing to
    // replay": the user saw a blank conversation and no reason for it.
    if (!available) {
      const reason = error ?? "unknown error";
      this.#options.log(`paseo-dsh: session history could not be read: ${reason}`);
      // An empty replay would look exactly like an empty conversation. Surface
      // the failure in the timeline of the session that just opened.
      this.#options.emit({
        type: "session.notice",
        sessionId: this.id,
        notice: {
          id: `history-${String(Date.now())}`,
          severity: "warning",
          title: "会话历史读取失败",
          description: `重放历史时读不到会话日志：${reason}`,
        },
      });
      return;
    }
    if (events.length === 0) return;
    const builder = new TimelineBuilder({ warn: (line) => this.#options.log(line) });
    let lastTimestamp: string | undefined;
    for (const event of events) {
      const data = isRecord(event.data) ? event.data : {};
      const seq = typeof event.seq === "number" ? event.seq : this.#replaySeq++;
      const timestamp = replayTimestamp(event);
      if (timestamp !== undefined) lastTimestamp = timestamp;
      if (event.type === "user/message") {
        const source = isRecord(data.source) ? data.source : {};
        if (source.kind !== "user") continue;
        // `messageRowText`, not `textBlocks`: a prompt that carried only an
        // image has no text block, and skipping it made the user's turn (and its
        // revert token) disappear on every reopen. A genuinely empty message —
        // no blocks at all — still has no row.
        const text = messageRowText(data.content);
        if (text === "") continue;
        this.#options.emit({
          type: "timeline.item",
          sessionId: this.id,
          ...(timestamp === undefined ? {} : { timestamp }),
          item: {
            type: "user_message",
            id: `user:history:${seq}`,
            text,
            clientMessageId: `history:${seq}`,
            // The DSH event carries the message id the bridge returned, which is
            // exactly the token a live row would carry — so a replayed
            // conversation is rewindable to the same places.
            ...(typeof data.id === "string" ? { revertToken: { messageId: data.id } } : {}),
          },
        });
        continue;
      }
      const itemTimestamp = timestamp ?? lastTimestamp;
      for (const item of builder.consume({ type: event.type, seq, data })) {
        this.#options.emit({
          type: "timeline.item",
          sessionId: this.id,
          ...(itemTimestamp === undefined ? {} : { timestamp: itemTimestamp }),
          item,
        });
      }
    }
    // A tool whose `tool/result` never arrived needs the same treatment for the
    // same reason, and the root replay used to skip it while the child replay
    // (`child.replay`) did not. The rows come from a *local* builder, so the live
    // builder never learns they exist and no later `turn/end` can close them:
    // a session whose process was killed mid-tool opened with a row that pulsed
    // for the rest of the session and again on every reopen. Idempotent — a log
    // that did reach its `turn/end` has nothing left running.
    for (const item of builder.settleRunningTools()) {
      this.#options.emit({
        type: "timeline.item",
        sessionId: this.id,
        ...(lastTimestamp === undefined ? {} : { timestamp: lastTimestamp }),
        item,
      });
    }
    // A compaction the killed process never closed would otherwise pulse
    // forever: the replay just emitted its `loading` marker and no completion
    // will ever arrive. Replay runs during open, when no compaction of this
    // session can be in flight here — a compaction is driven by a turn or a
    // command, and neither is running yet — so whatever is still loading is a
    // bracket the log never finished. The settle reports that it invented the
    // close.
    for (const item of builder.settleLoadingCompactions()) {
      this.#options.emit({
        type: "timeline.item",
        sessionId: this.id,
        ...(lastTimestamp === undefined ? {} : { timestamp: lastTimestamp }),
        item,
      });
    }
  }

  /**
   * Rebuild the native subagent tree of a reopened session.
   *
   * Read-only and non-creating: DSH's durable catalog lists reachable children
   * (fork-inherited facts excluded) without loading or resuming any agent, and
   * each child's stored log is replayed into its own view. Children are opened
   * in pre-order so a nested child's parent view exists first. A child's own
   * suffix (past its fork-inherited prefix) is replayed, and its last `turn/end`
   * restores the terminal status, so a finished child is never stuck "running".
   * A suffix with *no* terminal at all (a killed child) is closed as canceled
   * instead of being announced as running — see {@link DshChildSession.replay}.
   * Live children that appear after this are handled by {@link #onChildOpened}.
   */
  async replaySubagents(): Promise<void> {
    if (this.#closed || !this.#subsession) return;
    const process = this.#process;
    if (process === undefined) return;
    let listing: {
      available: boolean;
      subagents: Array<{
        sessionId: string;
        parentSessionId: string;
        mode?: string;
        label?: string;
        /** Archived in DSH's own registry: replaying it would resurrect it. */
        archived?: boolean;
      }>;
      diagnostics?: unknown[];
      error?: { message: string };
    };
    // Hold every child frame for the one RPC below: the ids that belong to a
    // replay are not known until it returns, and a frame dropped in this window
    // can be a terminal (see `#childReplayWindow`).
    this.#childReplayWindow = true;
    try {
      listing = await process.subagents();
    } catch (error) {
      this.#options.log(`subagent enumeration failed: ${messageOf(error)}`);
      return;
    } finally {
      // The gap between this and the `#replayPending` assignment below is
      // synchronous, so no frame can be misclassified in between.
      this.#childReplayWindow = false;
    }
    if (!listing.available) {
      // No subagent service composed: an honest empty tree, never a silent
      // "no children" claim. A mounted-but-failed read carries `error`.
      if (listing.error !== undefined) {
        this.#options.log(`subagent enumeration unavailable: ${listing.error.message}`);
      }
      return;
    }
    for (const diagnostic of listing.diagnostics ?? []) {
      this.#options.log(`subagent catalog diagnostic: ${JSON.stringify(diagnostic).slice(0, 200)}`);
    }
    // Frames for these children are buffered (not dropped) while their history
    // round trip runs; each child is released right after its replay so the
    // stored history is emitted before any live continuation.
    this.#replayPending = new Set(
      listing.subagents.filter((subagent) => subagent.archived !== true).map((subagent) => subagent.sessionId),
    );
    try {
      for (const row of listing.subagents) {
        if (this.#closed) return;
        // An archived child stays archived: DSH holds that state, Paseo drops what
        // the provider stops reporting, and re-announcing it is precisely what
        // made "archive all" look like it did nothing after a restart.
        if (row.archived === true) continue;
        let history: {
          events: Array<{ type: string; seq?: number; time?: number; data: unknown }>;
          inheritedEventCount: number;
          /** False when the log exists but could not be read. */
          available: boolean;
          error?: string;
        };
        try {
          history = await process.history(row.sessionId);
        } catch (error) {
          this.#options.log(`subagent history failed for ${row.sessionId}: ${messageOf(error)}`);
          this.#replayPending.delete(row.sessionId);
          continue;
        }
        if (this.#closed) return;
        if (history.available === false) {
          // Never replay an unreadable log as "no history": that would guess the
          // child's state (canceled on a cold start, running when adopted). Skip
          // it and say so instead of pretending the child is empty.
          this.#options.log(
            `subagent ${row.sessionId}: history unavailable (${history.error ?? "unknown error"}); skipped`,
          );
          this.#noticeChildHistoryUnavailable(row.sessionId, history.error);
          this.#replayPending.delete(row.sessionId);
          this.#dropBufferedChild(row.sessionId);
          continue;
        }
        // The proof that a child's open turn is still real is live evidence: the
        // bridge announced that child, or streamed its frames, in this process —
        // or this session adopted the SAME parked process that hosted the child
        // (the rewind refresh's close/reopen). Adopting keeps a running child
        // running, so its open turn is live even though the new provider session
        // never saw the announcement. Cold starts keep the strict rule: nothing is
        // live in a process that just booted, DSH's `listDescendants` never loads
        // or resumes a child agent, and a stored log that simply stops inside a
        // turn is exactly what a killed child leaves behind. Sampled here, after
        // the history read, so no await can interleave between the check and the
        // replay that consumes it.
        const announcedLive = this.#children.has(row.sessionId) || this.#adoptedParkedProcess;
        // A one-shot child has no label in the durable catalog — DSH only requires
        // one for a continuable child — but the child's own `subagent/descriptor`
        // carries its creation label. Read it from the history *before* opening:
        // a child has no configuration channel, so the title it is opened with is
        // the only one it can ever have, and opening without one leaves Paseo
        // showing "加载中…" forever.
        const label = row.label ?? labelFromHistory(history.events);
        const child = this.#openChildNow({
          sessionId: row.sessionId,
          parentSessionId: row.parentSessionId,
          ...(row.mode === undefined ? {} : { mode: row.mode }),
          ...(label === undefined ? {} : { label }),
        });
        if (child === undefined) {
          this.#options.log(`subagent ${row.sessionId} has an unresolved parent ${row.parentSessionId}`);
          this.#replayPending.delete(row.sessionId);
          continue;
        }
        child.replay(
          history.events,
          history.inheritedEventCount,
          announcedLive,
          this.#hasBufferedTerminal(row.sessionId),
        );
        // The stored history is in: release the frames held during the round trip
        // (their child view now exists) and stop buffering for this child.
        this.#replayPending.delete(row.sessionId);
        this.#flushPendingChildren();
      }
    } finally {
      this.#replayPending.clear();
    }
  }

  /** Report a child whose stored log could not be read (never guess its state). */
  #noticeChildHistoryUnavailable(nativeId: string, error?: string): void {
    this.#options.emit({
      type: "session.notice",
      sessionId: this.id,
      notice: {
        id: `subagent-history-${nativeId}-${String(Date.now())}`,
        severity: "warning",
        title: "子代理历史读取失败",
        description: `子代理 ${nativeId} 的历史未能读取，已跳过重放（${error ?? "未知原因"}）。`,
      },
    });
  }

  /** Drop held frames of a child that will not be opened. */
  #dropBufferedChild(nativeId: string): void {
    this.#pendingOpened = this.#pendingOpened.filter((payload) => payload.sessionId !== nativeId);
    this.#pendingChildEvents = this.#pendingChildEvents.filter((item) => item.sessionId !== nativeId);
  }

  /** Whether this child's terminal already arrived and is held for delivery. */
  #hasBufferedTerminal(nativeId: string): boolean {
    for (const item of this.#pendingChildEvents) {
      if (item.sessionId !== nativeId || item.kind !== "event") continue;
      if (item.event.type === "turn/end") return true;
    }
    return false;
  }

  /** Accept one prompt and start its turn. */
  async prompt(prompt: ProviderPrompt): Promise<void> {
    const process = this.#require();

    // A slash-menu pick arrives as a command, not a message. DSH commands and
    // skills share the menu but not the execution path, so branch on the kind
    // the catalog recorded rather than on the name.
    if (prompt.input.type === "command") {
      const args = prompt.input.arguments ?? "";

      if (this.#commandKinds.get(prompt.input.name) === "command") {
        await this.#runCommand(prompt.clientMessageId, prompt.input.name, args);
        return;
      }

      // A skill (or an unrecognized name): hand DSH the bare `/name` line. Its
      // skill tool injects a user-invocable skill from exactly that token.
      const line = slashLine(prompt.input.name, args);
      const issuedTurn = this.#openTurnId(prompt.clientMessageId, prompt.delivery);
      let reply: { messageId?: string; sourceKind?: string };
      try {
        reply = await process.prompt(line, [{ type: "text", text: line }], prompt.delivery);
      } catch (error) {
        if (issuedTurn) this.#turnId = null;
        this.#emitPromptFailed(prompt.clientMessageId, error);
        return;
      }
      // One row, emitted once it carries its revert token: splitting the row into
      // "shown now, token later" left a window where the rewind button appeared
      // on a row the daemon could not map to a provider token.
      //
      // Emitted only for the human's own source kind, the same rule the replay
      // filter applies — see {@link isUserSource}.
      if (isUserSource(reply.sourceKind)) {
        this.#emitUserMessage(
          prompt.clientMessageId,
          line,
          reply.messageId === undefined ? undefined : { messageId: reply.messageId },
        );
      }
      if (prompt.clearPendingPermissions === true) this.#clearPendingPermissionsForSteer();
      this.#emitPromptAccepted(prompt.clientMessageId, prompt.delivery);
      return;
    }

    // Paseo and the bridge already agree on the text/image block shape, so the
    // blocks ride through untouched. They used to be collapsed to a text label,
    // which silently discarded every non-text attachment.
    //
    // The translation can fail: Paseo's `ProviderContent` is wider than DSH's
    // block set (`uploaded_file`, `review`, `forge_*`, `github_*` all ride in on
    // the same prompt, and only `image` is gated by a capability bit). A throw
    // here used to escape `prompt()` entirely and land in the connection's
    // fallback catch, which reports `session.runtime_failed` — terminal for the
    // daemon: it rejects the pending prompt, drops the session and spawns a fresh
    // `dsh` for the same native id, while the old process and this DshSession
    // stayed behind. One unsupported block killed the conversation. A prompt that
    // cannot be translated is a failed *prompt*, which is what this now says.
    let blocks: Array<Record<string, unknown>>;
    try {
      blocks = prompt.input.content.map(toDshContent);
    } catch (error) {
      this.#emitPromptFailed(prompt.clientMessageId, error);
      return;
    }
    // The row's own text: the text blocks when there are any, otherwise the
    // kinds of the blocks that have no text (an image-only prompt). The live row
    // and the replayed row are built by the same rule, so a reopened
    // conversation shows the same messages the live one did.
    const label = messageRowText(blocks);

    const issuedTurn = this.#openTurnId(prompt.clientMessageId, prompt.delivery);
    let reply: { messageId?: string; sourceKind?: string };
    try {
      reply = await process.prompt(label, blocks.length === 0 ? undefined : blocks, prompt.delivery);
    } catch (error) {
      if (issuedTurn) this.#turnId = null;
      this.#emitPromptFailed(prompt.clientMessageId, error);
      return;
    }
    // One row, emitted once it carries its revert token: splitting the row into
    // "shown now, token later" left a window where the rewind button appeared on
    // a row the daemon could not map to a provider token.
    //
    // Paseo's own prompts — a schedule fire, a notify-on-finish notice — arrive
    // wrapped in a `<paseo-system>` envelope and the bridge records them under a
    // non-`user` source kind, because they are the host talking to the agent, not
    // the human. Emitting the row anyway printed the envelope XML as if the user
    // had typed it, and the replay filter then dropped the same message on the
    // next reopen (see `replayHistory`). The rule is the same on both sides now.
    if (isUserSource(reply.sourceKind)) {
      this.#emitUserMessage(
        prompt.clientMessageId,
        label,
        reply.messageId === undefined ? undefined : { messageId: reply.messageId },
      );
    }

    if (prompt.clearPendingPermissions === true) this.#clearPendingPermissionsForSteer();
    this.#emitPromptAccepted(prompt.clientMessageId, prompt.delivery);
  }

  /**
   * Run one registered command for a prompt.
   *
   * A command answers with its own timeline items instead of a model turn, so
   * this settles the prompt result itself and never opens a turn. The transcript
   * echoes the same line the runtime ran, built from the registered name.
   */
  async #runCommand(clientMessageId: string, name: string, args: string): Promise<void> {
    this.#emitUserMessage(clientMessageId, slashLine(name, args));
    try {
      const result = await this.#require().runCommand(name, args);
      if (result.kind === "error") throw new Error(result.text ?? `/${name} failed`);
    } catch (error) {
      this.#emitPromptFailed(clientMessageId, error);
      return;
    }
    this.#options.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId,
      result: { type: "completed" },
    });
  }

  #emitUserMessage(clientMessageId: string, text: string, token?: { messageId: string }): void {
    this.#options.emit({
      type: "timeline.item",
      sessionId: this.id,
      // `revertToken` is opaque to Paseo: it caches it per row and hands it back
      // when the user rewinds from that row (provider capability
      // `session.revert.*`). The prompt path emits this row once, after the
      // bridge named the DSH message, so the token is always present; command
      // rows carry none because DSH has no user/message for them.
      item: {
        type: "user_message",
        id: `user:${clientMessageId}`,
        text,
        clientMessageId,
        ...(token === undefined ? {} : { revertToken: token }),
      },
    });
  }

  #emitPromptFailed(clientMessageId: string, error: unknown): void {
    this.#options.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId,
      result: { type: "failed", error: { message: messageOf(error) } },
    });
  }

  /**
   * Issue the id for the turn a prompt is about to open, before the bridge is
   * asked to start it.
   *
   * Paseo binds `activeForegroundTurnId` to the turn id the *first* prompt
   * result names (`startPendingForegroundTurn` → `openActiveTurn`), and it
   * suppresses the provider's own later `session.turn started` for that turn.
   * Only a steer that repeats that exact id is admitted.
   *
   * In real DSH the running status arrives first: `agent.followup()` enters the
   * running phase synchronously and the bridge writes that notification before
   * the prompt reply, so {@link #onStatus} has already set `#turnId` by the time
   * {@link #emitPromptAccepted} runs. Issuing the id here makes the two values
   * equal by construction instead of depending on that cross-process ordering —
   * defensive today, and the anchor the regression pins.
   *
   * A steer never opens a turn and must never move the id it steers, so it is
   * left alone here.
   *
   * @returns whether the id was issued here, so the caller can clear it again
   * when the prompt fails to start a turn.
   */
  #openTurnId(clientMessageId: string, delivery: "auto" | "steer"): boolean {
    if (delivery === "steer" || this.#turnId !== null) return false;
    this.#turnId = `turn:${clientMessageId}`;
    // The id is issued before the bridge starts the turn, so no `turn/end` can
    // belong to it yet; the previous turn's state must not leak into it.
    this.#turnEndState = null;
    return true;
  }

  /**
   * Report one accepted prompt back to Paseo.
   *
   * A steer lands inside the turn that is already running, and Paseo's daemon
   * counts it as delivered only when the provider answers `steer` naming the
   * exact turn being steered (`PluginProviderSession.steerActiveTurn` requires
   * `result.type === "steer" && result.turnId === expectedTurnId`). That
   * expected id is the one this plugin returned for the prompt that started the
   * turn, so it is the only value that can satisfy the match. Answering `turn`
   * made every steer read as unavailable; the daemon then falls back to
   * `replaceAdmittedForegroundTurn`, which cancels the running turn and re-sends
   * the message — so the same text is injected once as a steer and then a second
   * time as the replacement turn's prompt.
   *
   * `#turnId` is that id: {@link prompt} issues it through {@link #openTurnId}
   * before the bridge starts the turn, and {@link #onStatus} reuses it when the
   * running status arrives. With no turn running there is nothing to steer, so
   * the honest answer is still `turn`: reporting `steer` there would claim a turn
   * that does not exist.
   */
  #emitPromptAccepted(clientMessageId: string, delivery: "auto" | "steer"): void {
    if (delivery === "steer" && this.#turnId !== null) {
      this.#options.emit({
        type: "session.prompt_result",
        sessionId: this.id,
        clientMessageId,
        result: { type: "steer", turnId: this.#turnId },
      });
      return;
    }
    // A steer with no running turn, or a turn-opening prompt whose id was not
    // pre-issued: fall back to a fresh id of its own.
    const turnId = this.#turnId ?? `turn:${clientMessageId}`;
    this.#options.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId,
      result: { type: "turn", turnId },
    });
  }

  /** Apply a composer change: model, mode, thinking option or settings. */
  async configure(changes: ProviderConfigChanges): Promise<void> {
    const process = this.#require();
    // A route change invalidates any occupancy poll still in flight: its answer
    // describes the previous model's capacity and must not overwrite the new
    // one's. `refreshUsage` below issues the replacement poll.
    if (changes.model !== undefined && changes.model !== null) {
      this.#usageGeneration += 1;
      this.#emitUsage({}, true);
    }

    if (changes.model !== undefined && changes.model !== null) {
      const next = parseRoute(changes.model, this.#route);
      const applied = await process.setConfig({
        provider: next.provider,
        model: next.model,
        reasoningEffort: next.reasoningEffort ?? null,
      });
      this.#route = {
        provider: applied.provider,
        model: applied.model,
        ...(applied.reasoningEffort === null ? {} : { reasoningEffort: applied.reasoningEffort }),
      };
    }

    if (changes.thinkingOption !== undefined) {
      const requested =
        changes.thinkingOption === null || changes.thinkingOption === "" ? undefined : changes.thinkingOption;
      // The runtime rejects a whole turn when handed an effort the model does not
      // declare, and Paseo can carry a stale selection across a model switch.
      // Serve only what this model advertises and drop anything else.
      const supported = this.#supportedEfforts();
      const effort = requested !== undefined && supported.includes(requested) ? requested : undefined;
      if (requested !== undefined && effort === undefined) {
        this.#options.log(
          `ignoring unsupported thinking option "${requested}" for ${this.#route.provider}/${this.#route.model}`,
        );
      }
      this.#thinkingOption = effort;
      const applied = await process.setConfig({
        provider: this.#route.provider,
        model: this.#route.model,
        reasoningEffort: effort ?? null,
      });
      this.#route = {
        provider: applied.provider,
        model: applied.model,
        ...(applied.reasoningEffort === null ? {} : { reasoningEffort: applied.reasoningEffort }),
      };
    }

    if (changes.mode !== undefined && changes.mode !== null) {
      this.#mode = changes.mode === "plan" ? "plan" : "build";
      await process.setPlan(this.#mode === "plan");
    }

    const requestedPermission = changes.settings?.["permission"];
    if (
      typeof requestedPermission === "string" &&
      requestedPermission !== "" &&
      requestedPermission !== this.#permission
    ) {
      // Switch the preset through DSH's projection API rather than its
      // `/permission` command: both own the sandbox mode and approval policy, but
      // only the command appends `command/run`/`command/done`, which Paseo would
      // show as a row the user never typed.
      const applied = await process.setPermission(requestedPermission);
      this.#permission = applied.current ?? requestedPermission;
    }

    const requestedPreset = changes.settings?.["preset"];
    if (
      typeof requestedPreset === "string" &&
      requestedPreset !== "" &&
      requestedPreset !== this.#preset
    ) {
      // A preset is a creation-time choice; DSH refuses the change once the
      // session's first turn has started. On refusal keep the real value and log
      // it — the caller re-emits config, so the composer snaps back.
      try {
        const applied = await process.setConfig({ preset: requestedPreset });
        this.#preset = applied.preset ?? requestedPreset;
      } catch (error) {
        this.#options.log(`preset change rejected: ${messageOf(error)}`);
      }
    }

    // A model switch changes the capacity and a mode switch does not, but both
    // end with the composer asking for a current readout; one refresh covers it.
    void this.refreshUsage();
  }

  /** Answer a pending question card. */
  resolvePermission(permissionId: string, response: ProviderPermissionResponse): void {
    const entry = this.#pendingPermissions.get(permissionId);
    if (entry === undefined) return;
    this.#pendingPermissions.delete(permissionId);
    // Attribute the resolution to the session that asked: a native subagent's
    // card must resolve on the child, not the parent.
    this.#options.emit({ type: "session.permission_resolved", sessionId: entry.sessionId, permissionId });
    entry.resolve(response);
  }

  /**
   * Answer every card this session is still blocked on, because the user typed a
   * message instead of clicking one.
   *
   * Paseo's own adapters do exactly this when a steer carries
   * `clearPendingPermissions` (`clearPendingPermissionsForSteer` in its Codex and
   * pi agents): deny with one fixed sentence, since the user's message is the
   * answer that follows. The daemon sends the flag on every steer; ignoring it
   * left the request in the daemon's `pendingPermissions` map forever — the card
   * stays pending in the UI and in `getPendingPermissions()`, which is also what
   * an agent reload restores — while the promise held here never settled, so a
   * later click answered a question nobody was waiting for.
   */
  #clearPendingPermissions(message: string): void {
    for (const permissionId of [...this.#pendingPermissions.keys()]) {
      this.resolvePermission(permissionId, { behavior: "deny", message });
    }
  }

  #clearPendingPermissionsForSteer(): void {
    this.#clearPendingPermissions("The user answered with a message instead of approving. Their message follows.");
  }

  /**
   * Cancel the running turn. The session and its history survive, so the
   * conversation stays continuable — killing the process stranded it instead.
   */
  async interrupt(): Promise<void> {
    await this.#require().cancel();
    // A cancelled turn's pending question cards can never be answered: DSH aborts
    // the question with the turn, and the bridge drops its pending request without
    // telling this process, so a later click would answer nobody. Deny them here —
    // the same resolution the daemon applies when it interrupts a run — which also
    // releases the promise this session holds for each card instead of keeping it
    // until the session closes.
    this.#clearPendingPermissions("The turn was interrupted, so this question is no longer waiting for an answer.");
  }

  /**
   * Release the process.
   *
   * An idle process is offered to the caller's park callback first: a rewind's
   * refresh closes and immediately reopens this session, and handing the running
   * child to the reopened session removes the cold start from that path. A
   * running turn, a missing callback, or a refusal falls back to shutdown.
   *
   * @param options - `park: false` forces a shutdown (provider teardown).
   */
  async close(options: { park?: boolean } = {}): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#usageRefreshTimer);
    const process = this.#process;
    this.#process = undefined;
    if (process === undefined) return;
    const park = options.park !== false
      && this.#turnId === null
      && process.running
      && this.#options.parkProcess?.(process, {
        sessionId: this.id,
        dshSessionId: this.#dshSessionId,
        cwd: this.#options.cwd,
        routeKey: routeKeyOf(this.#route),
      }) === true;
    if (park) return;
    await process.shutdown();
  }

  #require(): DshProcess {
    if (this.#process === undefined || this.#closed) {
      throw new Error(`session ${this.id} is not open`);
    }
    return this.#process;
  }

  #onStatus(status: string, sessionId: string): void {
    if (this.#closed) return;
    // A native subagent child runs in the same process; its lifecycle must not
    // move the parent's turn state.
    const sid = sessionId === "" ? this.#dshSessionId : sessionId;
    if (sid !== this.#dshSessionId) {
      if (!this.#subsession) return;
      const child = this.#children.get(sid);
      if (child !== undefined) {
        child.status(status);
        return;
      }
      // Not open yet: hold the status while its history replay is in flight (the
      // replay-time mirror of the `#rootReady` gate below), or while the child
      // listing that names those replays is still being read.
      if (this.#childReplayWindow || this.#replayPending.has(sid)) {
        this.#bufferChildEvent({ kind: "status", sessionId: sid, status });
        return;
      }
      // Not open yet: hold the status if the root is still opening, or if this
      // child is already a known-but-unparented notice. Otherwise it is a ghost.
      if (!this.#rootReady || this.#isPendingChild(sid)) {
        this.#bufferChildEvent({ kind: "status", sessionId: sid, status });
        return;
      }
      this.#options.log(`ignoring status for unknown subagent session ${sid}`);
      return;
    }
    if (status === "running") {
      const turnId = this.#turnId ?? `turn:${Date.now()}`;
      this.#turnId = turnId;
      // A new turn has no `turn/end` yet; a stale state from the previous one
      // must not colour its terminal event.
      this.#turnEndState = null;
      this.#options.emit({ type: "session.turn", sessionId: this.id, turnId, state: "started" });
      return;
    }
    if (this.#turnId !== null) {
      const turnId = this.#turnId;
      const ended = this.#turnEndState;
      const state = ended?.state ?? "completed";
      this.#turnId = null;
      this.#turnEndState = null;
      this.#options.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId,
        state,
        ...(ended?.error === undefined ? {} : { error: { message: ended.error } }),
      });
      // The turn's request reported fresh provider usage; refresh the occupancy
      // now so the readout is current even when no further turn arrives.
      void this.refreshUsage();
    }
  }

  /** The Paseo provider id a child of `parentNativeId` is parented under. */
  #parentScopedId(parentNativeId: string): string | undefined {
    if (parentNativeId === this.#dshSessionId) return this.id;
    return this.#children.get(parentNativeId)?.id;
  }

  /** The child view for one root-scoped Paseo provider id, if it is known. */
  child(sessionId: string): DshChildSession | undefined {
    return this.#childByProviderId.get(sessionId);
  }

  /** This session's own DSH id, which is what DSH's registry knows it by. */
  get dshId(): string {
    return this.#dshSessionId;
  }

  /**
   * Whether this root's DSH process is the one holding that DSH session.
   *
   * Either it is the root itself, or a native child of it — children are keyed
   * by their DSH session id. Used to route an archive to the process that can
   * actually stop the work, not merely record the archive.
   */
  holdsDshSession(dshSessionId: string): boolean {
    return this.#dshSessionId === dshSessionId || this.#children.has(dshSessionId);
  }

  /**
   * Archive or unarchive one DSH session in this root's DSH process.
   *
   * The plugin keeps no archive flag of its own: DSH has the concept, and
   * Paseo's adapters translate their archive action into the provider's native
   * one. DSH's registry is process-global, so any open root can carry the
   * request — which is what lets a native child, which has no process of its
   * own, be archived. An unknown or refusing registry throws, so a click that
   * cannot be honoured reports a failure instead of a false success.
   */
  async archiveDshSession(dshSessionId: string, archived: boolean): Promise<void> {
    const result = await this.#require().setArchived(dshSessionId, archived);
    if (!result.available) {
      throw new Error(result.error?.message ?? `${archived ? "archive" : "unarchive"} failed`);
    }
  }

  /** Create and open a native child whose parent is already known. */
  #openChildNow(payload: DshChildOpened): DshChildSession | undefined {
    const existing = this.#children.get(payload.sessionId);
    if (existing !== undefined) {
      if (!existing.opened) {
        const parentScoped = this.#parentScopedId(payload.parentSessionId);
        if (parentScoped !== undefined) existing.open(parentScoped);
      }
      return existing;
    }
    const parentScoped = this.#parentScopedId(payload.parentSessionId);
    if (parentScoped === undefined) return undefined;
    const child = new DshChildSession({
      // Scoped by Paseo's stable agent id, not by the root provider session id:
      // a plugin reload re-mints the latter for the same agent, and Paseo keys
      // its provider-subagent rows by `parentAgentId + subagentId` without
      // clearing them on a plugin reload — a root-id scope therefore replayed
      // every child under a fresh id and duplicated the whole subagent list.
      //
      // Without a Paseo agent id (probes, tests) the scope comes from the DSH
      // session id: that is the durable identity a reopen keeps, while the
      // provider session id is minted fresh on every open. Scoping a reopen by
      // the provider session id minted a second full set of rows — the same
      // child then appears twice in Paseo, once per generation.
      id: `${this.#options.agentId ?? this.#dshSessionId}:sub:${payload.sessionId}`,
      nativeId: payload.sessionId,
      subsession: this.#subsession,
      cwd: payload.cwd ?? this.#options.cwd,
      ...(payload.label === undefined ? {} : { title: payload.label }),
      closed: () => this.#closed,
      emit: (event) => this.#options.emit(event),
      log: (line) => this.#options.log(line),
      resolvePermission: (permissionId, response) => this.resolvePermission(permissionId, response),
    });
    this.#children.set(payload.sessionId, child);
    this.#childByProviderId.set(child.id, child);
    child.open(parentScoped);
    return child;
  }

  #onChildOpened(payload: DshChildOpened): void {
    if (this.#closed) return;
    if (!this.#subsession) {
      if (!this.#childBufferWarned) {
        this.#childBufferWarned = true;
        this.#options.log("Paseo did not negotiate session.subsession; ignoring native subagent children");
      }
      return;
    }
    if (typeof payload.sessionId !== "string" || payload.sessionId === "") return;
    if (typeof payload.parentSessionId !== "string" || payload.parentSessionId === "") {
      this.#options.log(`ignoring child opened with no parent: ${payload.sessionId}`);
      return;
    }
    if (this.#children.has(payload.sessionId)) return;
    // The parent edge may not exist yet: the root may still be opening, or a
    // nested child may precede its parent. Hold it (bounded) instead of dropping
    // the child's earliest output. A notice with no label is held the same way,
    // so the one title this child will ever have is its real one.
    if (
      !this.#rootReady ||
      this.#parentScopedId(payload.parentSessionId) === undefined ||
      (payload.label === undefined && !this.#labelWaitExceeded(payload.sessionId))
    ) {
      this.#bufferOpened(payload);
      return;
    }
    this.#openChildNow(payload);
    // Registering this child may have resolved the parent edge of a grandchild
    // held earlier, so release whatever is now resolvable — not only on the
    // first rootReady flush.
    this.#flushPendingChildren();
  }

  /** Whether a native child is a known notice whose parent has not arrived yet. */
  #isPendingChild(nativeId: string): boolean {
    return this.#pendingOpened.some((payload) => payload.sessionId === nativeId);
  }

  /** Mark the root ready and release every child held on that gate. */
  markRootReady(): void {
    if (this.#rootReady) return;
    this.#rootReady = true;
    this.#flushPendingChildren();
  }

  #bufferOpened(payload: DshChildOpened): void {
    // The same notice may be re-delivered while its parent is still missing;
    // keep the first (ordering preserved) instead of queuing a duplicate open.
    if (this.#pendingOpened.some((held) => held.sessionId === payload.sessionId)) return;
    this.#trimChildBuffer();
    this.#pendingOpened.push(payload);
  }

  /** How many events are already waiting for one held child. */
  #heldEventCount(nativeId: string): number {
    let count = 0;
    for (const item of this.#pendingChildEvents) if (item.sessionId === nativeId) count += 1;
    return count;
  }

  /** Whether a label-less child has waited long enough to be opened without one. */
  #labelWaitExceeded(nativeId: string): boolean {
    return this.#heldEventCount(nativeId) >= CHILD_LABEL_WAIT_EVENTS;
  }

  /** Attach a late label to a held notice and try to open it. */
  #completeHeldChild(nativeId: string, label: string): void {
    const held = this.#pendingOpened.find((payload) => payload.sessionId === nativeId);
    if (held === undefined) return;
    held.label = label;
    this.#flushPendingChildren();
  }

  #bufferChildEvent(item: { kind: "event"; sessionId: string; event: { type: string; [key: string]: unknown } } | { kind: "status"; sessionId: string; status: string }): void {
    this.#trimChildBuffer();
    this.#pendingChildEvents.push(item);
    // A label-less notice is held so the child still opens with its real title,
    // but the wait has to be re-evaluated as its frames accumulate. The check in
    // `#onChildOpened` can never fire: the bridge does not forward a child's
    // frames before that child's `child-opened`, so the count is always 0 there.
    // Without this the fallback was dead code and a provider that never sent a
    // descriptor left the child unopened — its output buffered, then dropped at
    // CHILD_BUFFER_LIMIT, with nothing said.
    this.#openIfLabelWaitExceeded(item.sessionId);
  }

  /** Open a held, label-less child once it has waited long enough for one. */
  #openIfLabelWaitExceeded(nativeId: string): void {
    const held = this.#pendingOpened.find((payload) => payload.sessionId === nativeId);
    if (held === undefined || held.label !== undefined) return;
    if (!this.#labelWaitExceeded(nativeId)) return;
    this.#options.log(
      `subagent ${nativeId} held ${CHILD_LABEL_WAIT_EVENTS} frames with no label; opening it untitled`,
    );
    this.#flushPendingChildren();
  }

  /** Keep the held-child buffer bounded, dropping the oldest on overflow. */
  #trimChildBuffer(): void {
    if (this.#pendingOpened.length + this.#pendingChildEvents.length < CHILD_BUFFER_LIMIT) return;
    if (!this.#childBufferWarned) {
      this.#childBufferWarned = true;
      this.#options.log(`subagent buffer full (${CHILD_BUFFER_LIMIT}); dropping the oldest held child notice`);
    }
    if (this.#pendingChildEvents.length > 0) this.#pendingChildEvents.shift();
    else this.#pendingOpened.shift();
  }

  /**
   * Open every held child whose parent is now known (multi-pass, so a nested
   * child follows its parent), then route the held events whose child is now
   * open. Anything still waiting on an unresolved parent — a deeper descendant
   * of a notice that never arrived — stays buffered instead of being cleared
   * and lost. Re-entrancy is guarded so a nested open cannot flush recursively.
   */
  #flushPendingChildren(): void {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      let progress = true;
      while (progress && this.#pendingOpened.length > 0) {
        progress = false;
        const remaining: DshChildOpened[] = [];
        for (const payload of this.#pendingOpened) {
          // The root gate applies here too: a held notice must never be opened
          // before `session.ready`, which is the same promise `#onChildOpened`
          // makes. Without it a child whose descriptor arrived early could be
          // announced ahead of its own root.
          if (!this.#rootReady || this.#parentScopedId(payload.parentSessionId) === undefined) {
            remaining.push(payload);
          } else {
            this.#openChildNow(payload);
            progress = true;
          }
        }
        this.#pendingOpened = remaining;
      }
      if (this.#pendingChildEvents.length > 0) {
        const held = this.#pendingChildEvents;
        this.#pendingChildEvents = [];
        const stillHeld: typeof held = [];
        for (const item of held) {
          const child = this.#children.get(item.sessionId);
          if (child === undefined) {
            // Its parent notice has not arrived; keep it for the next flush.
            stillHeld.push(item);
            continue;
          }
          if (item.kind === "event") child.event(item.event);
          else child.status(item.status);
        }
        this.#pendingChildEvents = stillHeld;
      }
      if (this.#pendingOpened.length > 0) {
        this.#options.log(`held ${this.#pendingOpened.length} child opened notice(s) with an unresolved parent`);
      }
    } finally {
      this.#flushing = false;
    }
  }

  #routeChildEvent(sessionId: string, event: { type: string; [key: string]: unknown }): void {
    const child = this.#children.get(sessionId);
    if (child === undefined) {
      this.#options.log(`ignoring event for unknown subagent session ${sessionId}`);
      return;
    }
    child.event(event);
  }

  #onSessionEvent(payload: { sessionId?: string; event: { type: string; [key: string]: unknown } }): void {
    if (this.#closed) return;
    const sid = typeof payload.sessionId === "string" && payload.sessionId !== "" ? payload.sessionId : this.#dshSessionId;
    if (sid !== this.#dshSessionId) {
      if (!this.#subsession) return;
      if (this.#children.has(sid)) {
        // A child's message, tool call, or turn event belongs to the child view,
        // never the parent timeline.
        this.#routeChildEvent(sid, payload.event);
        return;
      }
      // A held notice is waiting for this child's own durable label: the
      // descriptor is where it lives, and it is the last chance to open the
      // child with a real title rather than a permanent "加载中…".
      if (this.#isPendingChild(sid) && payload.event.type === "subagent/descriptor") {
        const label = subagentLabel(payload.event.data);
        if (label !== undefined) this.#completeHeldChild(sid, label);
        // Opening the child may have just resolved its parent edge. The
        // `#children` check above ran before that, so this frame belongs to the
        // view now — falling through would drop it and log it as an unknown
        // session, which is exactly the kind of line that misleads a later
        // investigation.
        if (this.#children.has(sid)) {
          this.#routeChildEvent(sid, payload.event);
          return;
        }
      }
      // A child whose history replay is in flight can emit frames during that
      // await window; hold them for the replayed child instead of dropping. The
      // same holds while the child listing itself is being read.
      if (this.#childReplayWindow || this.#replayPending.has(sid)) {
        this.#bufferChildEvent({ kind: "event", sessionId: sid, event: payload.event });
        return;
      }
      // A known child whose parent notice has not arrived yet (a grandchild can
      // precede its parent) keeps its earliest output buffered rather than
      // dropped. Only a truly unknown id is a ghost: reported, never misattributed.
      if (!this.#rootReady || this.#isPendingChild(sid)) {
        this.#bufferChildEvent({ kind: "event", sessionId: sid, event: payload.event });
        return;
      }
      this.#options.log(`ignoring event for unknown subagent session ${sid}`);
      return;
    }
    const event = payload.event;
    // DSH says how the turn ended; the root's terminal `session.turn` is emitted
    // when the agent goes idle, so the reason has to be remembered here or a
    // stopped turn would reach Paseo as a finished one. `aborted` is what
    // `agent.cancel({kind:'user'})` records, and `canceled` is the state Paseo's
    // own adapters report for an interruption (`turn_canceled`), so a user's stop
    // is no longer indistinguishable from a normal finish. Every other reason
    // keeps the previous reading, so nothing about a completed or capped turn
    // changes here.
    if (event.type === "turn/end") {
      const data = isRecord(event.data) ? event.data : {};
      const kind = isRecord(data.reason) ? data.reason.kind : undefined;
      // `aborted`/`abandoned` is the turn being stopped; `completed` is the only
      // clean finish. Everything else DSH can say — `error`, `blocked`,
      // `max-tokens`, `interrupted`, `forked` — is a *failure*, and reading it as
      // `completed` was not cosmetic: the daemon's `turn_completed` branch never
      // resolves the permissions an abandoned turn leaves behind, so a card from
      // a turn that died stayed pending forever, and the UI could not tell a
      // stopped or failed turn from a finished one.
      const state =
        kind === "aborted" || kind === "abandoned"
          ? "canceled"
          : kind === undefined || kind === "completed"
            ? "completed"
            : "failed";
      // A failed turn's own message is what the user needs to read: it is the
      // text the daemon renders in its system-error row and the text this
      // plugin's timeline error item carries. The generic sentence stays as the
      // fallback for failure kinds that carry no error payload (`blocked`,
      // `max-tokens`, `interrupted`).
      const reason = isRecord(data.reason) ? data.reason : undefined;
      const failure = isRecord(reason?.error) ? reason.error : undefined;
      const failureMessage = failure === undefined ? undefined : failure["message"];
      this.#turnEndState =
        state === "failed"
          ? {
              state,
              error:
                typeof failureMessage === "string" && failureMessage !== ""
                  ? failureMessage
                  : `the turn ended with ${String(kind)}`,
            }
          : { state };
    }
    // The model can leave plan mode on its own, for example by submitting a plan
    // for approval. Mirror that into the composer's mode selection so the toggle
    // never disagrees with the runtime.
    if (event.type === "plan/mode") {
      const data = isRecord(event.data) ? event.data : {};
      const next = data.active === true ? "plan" : "build";
      if (next !== this.#mode) {
        this.#mode = next;
        this.#options.emit({ type: "session.config", sessionId: this.id, config: this.configState() });
      }
      return;
    }
    // DSH reports token accounting on the assistant message and nowhere else, so
    // without this the composer's usage readout never had anything to show.
    // `#emitUsage` merges it with the context occupancy already known, because
    // Paseo replaces its whole usage record per event.
    if (event.type === "assistant/message") {
      const data = isRecord(event.data) ? event.data : {};
      if (isRecord(data.usage)) this.#emitUsage(providerUsage(data.usage));
    }
    if (["assistant/message", "assistant/attempt", "tool/result", "step/end", "request/context", "request/header"].includes(event.type)) {
      this.#queueUsageRefresh();
    }
    // A compaction rewrites the surface, so the next request's prompt shrinks.
    // Refresh here so the occupancy readout drops without waiting for a turn.
    if (event.type === "compaction/end") void this.refreshUsage();
    for (const item of this.#timeline.consume(event)) {
      this.#options.emit({ type: "timeline.item", sessionId: this.id, item });
    }
  }

  /**
   * Replace one half of the usage snapshot and publish the whole thing.
   *
   * Paseo replaces its entire usage record on every `session.usage`, so a patch
   * carrying only token counts would erase the context fields, and a patch
   * carrying only occupancy would erase the counts. Merging here keeps one
   * complete, mutually consistent picture on the composer.
   */
  #emitUsage(patch: ProviderUsage, replaceContext = false): void {
    if (this.#closed) return;
    const merged: ProviderUsage = { ...this.#lastUsage };
    if (replaceContext) {
      delete merged.contextWindowMaxTokens;
      delete merged.contextWindowUsedTokens;
    } else {
      // Message usage describes this step, not a delta. An omitted cache bucket
      // must not keep the previous step's count.
      delete merged.inputTokens;
      delete merged.cachedInputTokens;
      delete merged.outputTokens;
      delete merged.totalCostUsd;
    }
    Object.assign(merged, patch);
    this.#lastUsage = merged;
    this.#options.emit({
      type: "session.usage",
      sessionId: this.id,
      ...(this.#turnId === null ? {} : { turnId: this.#turnId }),
      usage: merged,
    });
  }

  /**
   * Turn one DSH question request into a single Paseo permission card. Paseo's
   * shared picker steps through every entry of `input.questions` and submits all
   * answers together, so splitting questions across cards forced one submission
   * each. Its own providers bundle them the same way.
   */
  async #onQuestion(request: DshQuestionRequest, sessionId: string): Promise<DshAnswer> {
    const target = this.#parentScopedId(sessionId === "" ? this.#dshSessionId : sessionId) ?? this.id;
    // One answer key per question: Paseo collects `updatedInput.answers` keyed by
    // these headers, while DSH does not require a header to be unique — see
    // {@link uniqueHeaders}.
    const headers = uniqueHeaders(request.questions);
    const planIndex = request.questions.findIndex((question) => question.intent?.kind === "plan-review");
    const response =
      planIndex < 0
        ? await this.#askQuestions(target, request, headers)
        : await this.#reviewPlan(target, request, request.questions[planIndex] as DshQuestion);

    const answers = request.questions.map((question, index) => {
      if (index === planIndex) {
        return {
          id: question.id,
          selected: planAnswer(question, response),
          // A dismissed plan review carries the user's own words; DSH's plan tool
          // reads them as `custom` and hands them to the model as feedback.
          ...(response.behavior === "deny" && response.message !== undefined
            ? { custom: response.message }
            : {}),
        };
      }
      // `selectAnswer` already splits the answer into DSH's two channels: chosen
      // labels in `selected`, the picker's "Other" text in `custom`.
      return { id: question.id, ...selectAnswer(question, headers[index] as string, response) };
    });

    return { answers };
  }

  /** One card carrying every question, answered in a single submission. */
  #askQuestions(
    sessionId: string,
    request: DshQuestionRequest,
    headers: string[],
  ): Promise<ProviderPermissionResponse> {
    const permission: ProviderPermissionRequest = {
      // Session-scoped so a parent and a child that share a tool-call id never
      // collide in the pending map, and the resolution returns to the asker.
      id: `${sessionId}:${request.callId ?? "question"}`,
      name: "ask_user_question",
      kind: "question",
      title: request.questions.length === 1 ? (headers[0] as string) : UI.questionsTitle,
      input: {
        questions: request.questions.map((question, index) => ({
          question: question.question,
          header: headers[index] as string,
          options: (question.options ?? []).map((option) => ({
            label: option.label,
            ...(typeof option.description === "string" && option.description.length > 0
              ? { description: option.description }
              : {}),
          })),
          ...(question.multiSelect === true ? { multiSelect: true } : {}),
          allowOther: true,
        })),
      } as unknown as Readonly<Record<string, JsonValue>>,
    };

    return this.#openCard(sessionId, permission);
  }

  /**
   * Plan review, shaped exactly like Paseo's own Codex plan approval: the plan
   * rides in `input.plan` and two buttons decide it. The plan itself is also
   * emitted as a timeline `plan` item so it stays readable before the choice.
   */
  #reviewPlan(
    sessionId: string,
    request: DshQuestionRequest,
    question: DshQuestion,
  ): Promise<ProviderPermissionResponse> {
    const permission: ProviderPermissionRequest = {
      id: `${sessionId}:${request.callId ?? "question"}:${question.id}`,
      name: "exit_plan_mode",
      kind: "plan",
      title: UI.planCard.title,
      description: UI.planCard.description,
      input: {
        plan: typeof question.detail === "string" ? question.detail : "",
        ...(question.intent === undefined ? {} : { intent: question.intent }),
      } as unknown as Readonly<Record<string, JsonValue>>,
      actions: [
        {
          id: "dismiss",
          label: UI.planCard.dismiss,
          behavior: "deny",
          variant: "danger",
          intent: "dismiss",
        },
        {
          id: "implement",
          label: UI.planCard.implement,
          behavior: "allow",
          variant: "primary",
          intent: "implement",
        },
      ],
    };

    return this.#openCard(sessionId, permission);
  }

  #openCard(sessionId: string, permission: ProviderPermissionRequest): Promise<ProviderPermissionResponse> {
    return new Promise<ProviderPermissionResponse>((resolve) => {
      this.#pendingPermissions.set(permission.id, { sessionId, resolve });
      this.#options.emit({ type: "session.permission", sessionId, request: permission });
    });
  }
}

interface DshChildSessionOptions {
  /** Root-scoped Paseo provider id this child is emitted under. */
  id: string;
  /** DSH's own child session id, used to route the child's events. */
  nativeId: string;
  /** Whether the connection negotiated `session.subsession`. */
  subsession: boolean;
  cwd: string;
  title?: string;
  closed(): boolean;
  emit(event: ProviderEvent): void;
  log(line: string): void;
  resolvePermission(permissionId: string, response: ProviderPermissionResponse): void;
}

/**
 * A read-only view of one native subagent child session.
 *
 * The child runs inside the root's own DSH process; this view owns no process
 * and creates none. It maps the child's events onto Paseo's provider-subsession
 * surface (`restoration: "parent"`): its own timeline, turn state, and usage,
 * all addressed by the child's root-scoped provider id so nothing lands on the
 * parent.
 *
 * Paseo's plugin-provider child channel (`acceptChildEvent`) consumes only
 * `timeline.item`, terminal `session.turn`, and `session.runtime_failed` /
 * `session.closed`; a child's `session.turn started` and `session.usage` are
 * therefore ignored by the current host. They are still emitted with the
 * correct child identity rather than dropped or misattributed.
 */
export class DshChildSession {
  readonly id: string;
  readonly nativeId: string;
  readonly #options: DshChildSessionOptions;
  readonly #timeline = new TimelineBuilder({ warn: (line) => this.#options.log(line) });
  #turnId: string | null = null;
  #turnEnded = false;
  #lastUsage: ProviderUsage | undefined;
  #opened = false;
  /**
   * Whether the live channel has carried a frame for this child.
   *
   * Set by {@link event} / {@link status}, which only ever receive frames the
   * bridge pushed for a child it is hosting. It is the positive half of the
   * replay rule: a stored log that stops inside a turn is a killed child unless
   * this child is demonstrably live here.
   */
  #observedLive = false;

  /**
   * Child sessions are a read-only projection: they have no process of their own
   * to rewind, and Paseo only offers the button on the root conversation anyway.
   * Failing loudly keeps a mis-gated button from looking like a silent no-op.
   */
  async revert(_token: unknown, _scope: "conversation" | "files" | "both"): Promise<void> {
    throw new Error("子会话不支持撤回");
  }

  constructor(options: DshChildSessionOptions) {
    this.id = options.id;
    this.nativeId = options.nativeId;
    this.#options = options;
  }

  get opened(): boolean {
    return this.#opened;
  }

  /** Announce the child to Paseo as a provider-owned subsession. Idempotent. */
  open(parentSessionId: string): void {
    if (this.#opened || this.#options.closed()) return;
    this.#opened = true;
    this.#options.emit({
      type: "session.opened",
      sessionId: this.id,
      parentSessionId,
      // Read-only, but it must still advertise `session.subsession`: Paseo
      // refuses to attach a child whose parent did not negotiate it, so a
      // grandchild under this read-only child needs it too. No prompt/configure
      // capability is offered, so Paseo cannot drive the child.
      capabilities: this.#options.subsession ? ["session.subsession"] : [],
      restoration: "parent",
      cwd: this.#options.cwd,
      // Paseo addresses an archive request by persistence handle, not by session
      // id (its opencode adapter archives through the provider's native handle
      // for the same reason). Without one a subagent cannot be archived at all:
      // the click would be a Paseo-local mark that the next replay undoes.
      persistence: { version: 1, data: { sessionId: this.#options.nativeId } },
      ...(this.#options.title === undefined ? {} : { title: this.#options.title }),
    });
  }

  /** Fold one native child session event into this child's timeline. */
  event(event: { type: string; [key: string]: unknown }): void {
    if (this.#options.closed()) return;
    this.#observedLive = true;
    // The real turn terminal comes from `turn/end`, not from an idle status:
    // a failed, aborted, or token-capped turn must not read as completed.
    if (event.type === "turn/end") {
      const data = isRecord(event.data) ? event.data : {};
      this.#endTurn(childTurnState(data.reason));
    } else if (event.type === "turn/start") {
      this.#turnEnded = false;
    }
    if (event.type === "assistant/message") {
      const data = isRecord(event.data) ? event.data : {};
      if (isRecord(data.usage)) {
        this.#lastUsage = providerUsage(data.usage);
        this.#options.emit({
          type: "session.usage",
          sessionId: this.id,
          ...(this.#turnId === null ? {} : { turnId: this.#turnId }),
          usage: this.#lastUsage,
        });
      }
    }
    for (const item of this.#timeline.consume(event)) {
      this.#options.emit({ type: "timeline.item", sessionId: this.id, item });
    }
  }

  /** Mirror the child's own agent lifecycle into its turn state. */
  status(status: string): void {
    if (this.#options.closed()) return;
    this.#observedLive = true;
    if (status === "running") {
      if (this.#turnId === null) {
        this.#turnId = `turn:${Date.now()}`;
        this.#turnEnded = false;
      }
      this.#options.emit({ type: "session.turn", sessionId: this.id, turnId: this.#turnId, state: "started" });
      return;
    }
    // Idle with no explicit `turn/end` observed: close the turn as completed
    // rather than leaving the child stuck "running" forever.
    if (this.#turnId !== null && !this.#turnEnded) this.#endTurn("completed");
  }

  #endTurn(state: "completed" | "canceled" | "failed"): void {
    const turnId = this.#turnId ?? `turn:${Date.now()}`;
    this.#turnId = null;
    this.#turnEnded = true;
    this.#options.emit({ type: "session.turn", sessionId: this.id, turnId, state });
  }

  /**
   * Replay a stored child log into this child's timeline, once, on reopen.
   *
   * Only events in the child's own suffix (past any fork-inherited prefix) are
   * replayed, so a forked child does not re-show its parent's conversation or a
   * sibling's tool work as its own. The last `turn/end` in the own suffix
   * restores the terminal status.
   *
   * A suffix that carries *no* terminal — the last bracket is a `turn/start`, or
   * the log never closed a turn at all — is not evidence of life. A child that
   * is still running writes the same tail (a live agent between two steps ends
   * on `step/start`), so the shape alone cannot tell the two apart, and DSH
   * appends no "the process died" fact. The live channel is the only proof, so
   * `live` (the bridge announced this child in this process) and
   * {@link #observedLive} gate the decision: with no such proof the turn is
   * closed as `canceled`, exactly the status Paseo's own adapters give an
   * interrupted turn, instead of leaving the row pulsing forever — Paseo's
   * default on attach is "running" and its host only consumes a *terminal*
   * `session.turn`.
   *
   * @param live - positive live-channel evidence for this child, from the caller
   *   that read the durable catalog.
   * @param terminalBuffered - the child's `turn/end` already arrived and is held
   *   in the replay buffer (it landed during the history read). The replayed
   *   suffix still ends inside the turn, but closing it as canceled would emit a
   *   spurious terminal right before the real one; the buffered terminal is the
   *   live proof, exactly like `live`.
   */
  replay(
    events: Array<{ type: string; seq?: number; time?: number; data: unknown }>,
    inheritedEventCount = 0,
    live = false,
    terminalBuffered = false,
  ): void {
    if (this.#options.closed()) return;
    let fallbackSeq = 0;
    let lastTurnEnd: "completed" | "canceled" | "failed" | undefined;
    let turnOpen = false;
    let sawTurn = false;
    let lastTimestamp: string | undefined;
    for (const event of events) {
      const seq = typeof event.seq === "number" ? event.seq : fallbackSeq++;
      if (seq < inheritedEventCount) continue;
      const data = isRecord(event.data) ? event.data : {};
      const timestamp = replayTimestamp(event);
      if (timestamp !== undefined) lastTimestamp = timestamp;
      if (event.type === "turn/start") {
        turnOpen = true;
        sawTurn = true;
      } else if (event.type === "turn/end") {
        turnOpen = false;
        sawTurn = true;
        lastTurnEnd = childTurnState(data.reason);
      }
      if (event.type === "user/message") {
        const source = isRecord(data.source) ? data.source : {};
        if (source.kind !== "user") continue;
        // `messageRowText`, not `textBlocks`: a prompt that carried only an
        // image has no text block, and skipping it made the user's turn (and its
        // revert token) disappear on every reopen. A genuinely empty message —
        // no blocks at all — still has no row.
        const text = messageRowText(data.content);
        if (text === "") continue;
        this.#options.emit({
          type: "timeline.item",
          sessionId: this.id,
          ...(timestamp === undefined ? {} : { timestamp }),
          item: {
            type: "user_message",
            id: `user:history:${seq}`,
            text,
            clientMessageId: `history:${seq}`,
            // The DSH event carries the message id the bridge returned, which is
            // exactly the token a live row would carry — so a replayed
            // conversation is rewindable to the same places.
            ...(typeof data.id === "string" ? { revertToken: { messageId: data.id } } : {}),
          },
        });
        continue;
      }
      const itemTimestamp = timestamp ?? lastTimestamp;
      for (const item of this.#timeline.consume({ type: event.type, seq, data })) {
        this.#options.emit({
          type: "timeline.item",
          sessionId: this.id,
          ...(itemTimestamp === undefined ? {} : { timestamp: itemTimestamp }),
          item,
        });
      }
    }
    // The stored log's own terminal: only the terminal is emitted, so a failed
    // or cancelled child is never shown as completed.
    if (!turnOpen && lastTurnEnd !== undefined) {
      this.#endReplayedTurn(lastTurnEnd);
      return;
    }
    // Nothing in the suffix closes the turn (an open last turn, or no turn at
    // all). Only positive live evidence may leave that as "running" — Paseo's
    // default on attach; without it the child is closed as canceled rather than
    // announced as something still running.
    if (turnOpen || !sawTurn) {
      // Adopting the parked process proves the OPEN TURN is still real: that
      // process never stopped. It does not prove a child with no recorded turn
      // was ever running — that shape is a child created but never started (or a
      // dead one), so only the live channel may keep it running. A terminal that
      // arrived during the replay window is equally positive evidence.
      if (((live || terminalBuffered) && turnOpen) || this.#observedLive) return;
      this.#options.log(
        `subagent ${this.nativeId}: stored history ends with no turn terminal ` +
          `(${turnOpen ? "the last turn was never closed" : "no turn was ever recorded"}); ` +
          "closing it as canceled",
      );
      // The rows of a tool whose `tool/result` can never arrive would pulse
      // forever too, so they are settled with the same status `turn/end` gives
      // an aborted turn.
      for (const item of this.#timeline.settleRunningTools()) {
        this.#options.emit({ type: "timeline.item", sessionId: this.id, item });
      }
      // A compaction marker the log left in `loading` pulses for the same
      // reason and is closed the same way (there is no canceled compaction).
      for (const item of this.#timeline.settleLoadingCompactions()) {
        this.#options.emit({ type: "timeline.item", sessionId: this.id, item });
      }
      this.#endReplayedTurn("canceled");
    }
  }

  /** Emit the single terminal `session.turn` a replay restores. */
  #endReplayedTurn(state: "completed" | "canceled" | "failed"): void {
    this.#turnId = null;
    this.#turnEnded = true;
    this.#options.emit({
      type: "session.turn",
      sessionId: this.id,
      turnId: `replay:${this.id}`,
      state,
    });
  }

  // --- read-only surface: a child is never driven from Paseo ---

  /** A child is a read-only view; a prompt fails loudly instead of vanishing. */
  async prompt(prompt: ProviderPrompt): Promise<void> {
    this.#options.emit({
      type: "session.prompt_result",
      sessionId: this.id,
      clientMessageId: prompt.clientMessageId,
      result: {
        type: "failed",
        error: { message: "subagent sessions are read-only in Paseo; send work from the parent session" },
      },
    });
  }

  configState(): ProviderConfigState {
    throw new Error("subagent sessions have no configuration");
  }

  async configure(): Promise<void> {
    throw new Error("subagent sessions are read-only");
  }

  async interrupt(): Promise<void> {
    throw new Error("subagent sessions are read-only");
  }

  /** Resolution routes to the owning root, which attributes it by permission id. */
  resolvePermission(permissionId: string, response: ProviderPermissionResponse): void {
    this.#options.resolvePermission(permissionId, response);
  }

  async close(): Promise<void> {
    // `restoration: "parent"` children are removed by Paseo, which sends no
    // session.close; a read-only view owns nothing to release.
  }
}

/**
 * Translate one Paseo content block into the shape the bridge hands DSH.
 *
 * DSH's prompt content is `text` and `image` only, while Paseo's
 * `ProviderContent` is wider: an uploaded file, a review, a forge change
 * request/issue. Paseo's own providers (Claude, Codex, …) render those to a
 * text block and hand that text to the agent — uploaded files are never copied,
 * the absolute path on disk is the payload — so this mirrors that mapping
 * instead of rejecting the prompt. The rendered text is
 * {@link renderPromptAttachmentAsText}, byte-for-byte Paseo's own format.
 *
 * A block with no DSH counterpart and no Paseo rendering fails loudly rather
 * than being dropped: the model would otherwise receive a prompt silently
 * missing its evidence.
 */
export function toDshContent(block: ProviderContent): Record<string, unknown> {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") return { type: "image", data: block.data, mimeType: block.mimeType };
  return { type: "text", text: renderPromptAttachmentAsText(block) };
}

/**
 * How Paseo brands one git forge in prompt text.
 *
 * Ported from `@getPaseo/protocol/forge-manifest` (the declarative half the
 * daemon's renderer reads). @getpaseo/server is not a runtime dependency of this
 * plugin, so the table is copied rather than imported.
 */
interface ForgePresentation {
  displayName: string | undefined;
  changeRequestAbbrev: string;
  changeRequestNumberPrefix: string;
  issueNumberPrefix: string;
}

const FORGE_PRESENTATIONS: Readonly<Record<string, ForgePresentation>> = {
  github: { displayName: "GitHub", changeRequestAbbrev: "PR", changeRequestNumberPrefix: "#", issueNumberPrefix: "#" },
  gitlab: { displayName: "GitLab", changeRequestAbbrev: "MR", changeRequestNumberPrefix: "!", issueNumberPrefix: "#" },
  gitea: { displayName: "Gitea", changeRequestAbbrev: "PR", changeRequestNumberPrefix: "#", issueNumberPrefix: "#" },
  forgejo: { displayName: "Forgejo", changeRequestAbbrev: "PR", changeRequestNumberPrefix: "#", issueNumberPrefix: "#" },
  codeberg: { displayName: "Codeberg", changeRequestAbbrev: "PR", changeRequestNumberPrefix: "#", issueNumberPrefix: "#" },
};

/**
 * A forge id's presentation, or Paseo's neutral shape for an id this build does
 * not know (a self-hosted forge a newer daemon reports). Every neutral field is
 * named exactly like `getForgeDefinitionOrNeutral`'s, quirks included.
 */
function forgePresentation(forge: string | undefined): ForgePresentation {
  return FORGE_PRESENTATIONS[forge as string] ?? {
    displayName: forge,
    changeRequestAbbrev: "PR",
    changeRequestNumberPrefix: "#",
    issueNumberPrefix: "#",
  };
}

/** The per-line diff markers of a review attachment. */
const REVIEW_LINE_MARKERS = { add: "+", remove: "-", context: " " } as const;

/** One review context line number, left-padded; an absent side renders `-`. */
function padLineNumber(lineNumber: number | null): string {
  return (lineNumber?.toString() ?? "-").padStart(2);
}

interface ChangeRequestFields {
  forge: string | undefined;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
  baseRefName?: string | null;
  headRefName?: string | null;
}

/** A forge change request, exactly as Paseo's own renderer writes it. */
function renderChangeRequestAttachment(input: ChangeRequestFields): string {
  const forge = forgePresentation(input.forge);
  const lines = [
    `${forge.displayName} ${forge.changeRequestAbbrev} ${forge.changeRequestNumberPrefix}${input.number}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) lines.push(`Project: ${input.projectPath}`);
  if (input.baseRefName) lines.push(`Base: ${input.baseRefName}`);
  if (input.headRefName) lines.push(`Head: ${input.headRefName}`);
  if (input.body) lines.push("", input.body);
  return lines.join("\n");
}

/** A forge issue, exactly as Paseo's own renderer writes it. */
function renderIssueAttachment(input: {
  forge: string | undefined;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
}): string {
  const forge = forgePresentation(input.forge);
  const lines = [`${forge.displayName} Issue ${forge.issueNumberPrefix}${input.number}: ${input.title}`, input.url];
  if (input.projectPath) lines.push(`Project: ${input.projectPath}`);
  if (input.body) lines.push("", input.body);
  return lines.join("\n");
}

/** A code review with its surrounding diff lines, as Paseo's renderer writes it. */
function renderReviewAttachment(attachment: Extract<ProviderContent, { type: "review" }>): string {
  const lines = [`Paseo review attachment (${attachment.mode})`, `CWD: ${attachment.cwd}`];
  if (attachment.baseRef) lines.push(`Base: ${attachment.baseRef}`);
  attachment.comments.forEach((comment, index) => {
    lines.push(
      "",
      `Comment ${index + 1}: ${comment.filePath}:${comment.side}:${comment.lineNumber}`,
      comment.body,
      comment.context.hunkHeader,
    );
    const target = comment.context.targetLine;
    for (const line of comment.context.lines) {
      const isTarget =
        line.oldLineNumber === target.oldLineNumber &&
        line.newLineNumber === target.newLineNumber &&
        line.type === target.type &&
        line.content === target.content;
      const prefix = isTarget ? "> " : "  ";
      lines.push(
        `${prefix}${padLineNumber(line.oldLineNumber)} ${padLineNumber(line.newLineNumber)} ${REVIEW_LINE_MARKERS[line.type]}${line.content}`,
      );
    }
  });
  return lines.join("\n");
}

/**
 * Render one Paseo attachment block as the text its own providers send to the
 * model.
 *
 * Ported line-for-line from `@getpaseo/server@0.12.0`
 * (`dist/server/server/agent/prompt-attachments.js`, `renderPromptAttachmentAsText`),
 * including the legacy `github_pr`/`github_issue` wire kinds. Text and image
 * blocks never reach this function: they have native DSH counterparts. An
 * unknown type throws — Paseo's protocol may grow a block this build cannot
 * translate, and a prompt silently missing an attachment is worse than a failed
 * prompt.
 */
export function renderPromptAttachmentAsText(block: ProviderContent): string {
  switch (block.type) {
    case "forge_change_request":
      return renderChangeRequestAttachment({
        forge: block.forge,
        number: block.number,
        title: block.title,
        url: block.url,
        body: block.body,
        projectPath: block.projectPath,
        baseRefName: block.baseRefName,
        headRefName: block.headRefName,
      });
    // COMPAT(githubAttachmentKinds): legacy wire kinds for older clients and
    // daemons, same window Paseo's own renderer keeps them.
    case "github_pr":
      return renderChangeRequestAttachment({
        forge: "github",
        number: block.number,
        title: block.title,
        url: block.url,
        body: block.body,
        baseRefName: block.baseRefName,
        headRefName: block.headRefName,
      });
    case "forge_issue":
      return renderIssueAttachment({
        forge: block.forge,
        number: block.number,
        title: block.title,
        url: block.url,
        body: block.body,
        projectPath: block.projectPath,
      });
    case "github_issue":
      return renderIssueAttachment({
        forge: "github",
        number: block.number,
        title: block.title,
        url: block.url,
        body: block.body,
      });
    case "text":
      return block.text;
    case "review":
      return renderReviewAttachment(block);
    case "uploaded_file":
      // The file already sits on disk at this absolute path — Paseo does not
      // inline or copy it, so the path is the whole attachment.
      return [
        `Uploaded file: ${block.fileName}`,
        `Path: ${block.path}`,
        `MIME: ${block.mimeType}`,
        `Size: ${block.size} bytes`,
      ].join("\n");
    default: {
      // The protocol is wider than this build's union at runtime. Report the
      // wire type so the failure names the block the daemon sent.
      const unknown = block as { type?: unknown };
      throw new Error(`unsupported prompt content type "${String(unknown.type)}"`);
    }
  }
}

/**
 * Map DSH's per-step token accounting onto Paseo's usage fields.
 *
 * DSH attaches usage to the assistant message because it keeps no separate usage
 * record, so this is the only place the numbers exist to forward.
 */
function providerUsage(raw: Record<string, unknown>): ProviderUsage {
  return {
    ...(typeof raw.inputTokens === "number" ? { inputTokens: raw.inputTokens } : {}),
    ...(typeof raw.cacheReadTokens === "number" ? { cachedInputTokens: raw.cacheReadTokens } : {}),
    ...(typeof raw.outputTokens === "number" ? { outputTokens: raw.outputTokens } : {}),
  };
}

/**
 * Map a DSH `turn/end` reason to a Paseo subagent terminal status. Only an
 * explicit `completed` reads as completed; a cancelled, failed, blocked,
 * token-capped, or crash-orphaned turn must not.
 */
function childTurnState(reason: unknown): "completed" | "canceled" | "failed" {
  const kind = isRecord(reason) ? reason.kind : undefined;
  if (kind === "completed") return "completed";
  if (kind === "aborted") return "canceled";
  return "failed";
}

/**
 * Answer key Paseo's shared question UI returns under `updatedInput.answers`.
 * Questions without a header still need a distinct key, so the position is used.
 */
function headerOf(question: DshQuestion, index: number): string {
  if (typeof question.header === "string" && question.header.trim().length > 0) return question.header;
  if (typeof question.id === "string" && question.id.trim().length > 0) return question.id;
  return `Question ${index + 1}`;
}

/**
 * One distinct answer key per question of a card.
 *
 * Paseo's shared picker collects the whole batch into
 * `updatedInput.answers`, keyed by the question's `header` (its own
 * `buildQuestionFormAnswers`), and this plugin sends that same string as the
 * card's question key. DSH only requires a question `id` to be unique, so a model
 * may give two questions the same header; both would then share one answer slot
 * and the second selection would silently overwrite the first. The header is
 * generated on this side of the protocol, so duplicates are made unique here
 * rather than losing an answer. A later duplicate gets a ` (n)` suffix; the loop
 * also covers a model header that already looks like one.
 */
function uniqueHeaders(questions: readonly DshQuestion[]): string[] {
  const used = new Set<string>();
  return questions.map((question, index) => {
    const base = headerOf(question, index);
    let header = base;
    let suffix = 1;
    while (used.has(header)) {
      suffix += 1;
      header = `${base} (${suffix})`;
    }
    used.add(header);
    return header;
  });
}

/**
 * Recover one question's answer from a permission response.
 *
 * Paseo answers through `updatedInput.answers[<header>]` — a string, comma-joined
 * when multi-select — so `selectedActionId` is only a fallback for button-style
 * resolutions. A string that matches none of the question's option labels is the
 * picker's "Other" free text rather than a chosen label: DSH's answer item has a
 * separate `custom` field for exactly that, so it travels there instead of being
 * reported as an option label the model never offered.
 *
 * Multi-select stays one list: the picker joins labels (and an "Other" entry,
 * when present) into the same comma-separated string, and Paseo's own adapters
 * split it the same way, so there is no reliable boundary to recover.
 */
function selectAnswer(
  question: DshQuestion,
  header: string,
  response: ProviderPermissionResponse,
): { selected: string[]; custom?: string } {
  if (response.behavior === "deny") {
    return {
      selected: [],
      ...(response.message === undefined ? {} : { custom: response.message }),
    };
  }
  const answers = isRecord(response.updatedInput) ? response.updatedInput["answers"] : undefined;
  const raw = isRecord(answers) ? answers[header] : undefined;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const answer = raw.trim();
    if (question.multiSelect === true) {
      return {
        selected: answer
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      };
    }
    const match = (question.options ?? []).find((option) => option.label === answer);
    return match === undefined ? { selected: [], custom: answer } : { selected: [match.label] };
  }
  const options = question.options ?? [];
  const index = Number(response.selectedActionId);
  const label = Number.isInteger(index) ? options[index]?.label : undefined;
  return { selected: label === undefined ? [] : [label] };
}

/**
 * Decide a plan review. Only the `implement` button approves; anything else —
 * including a dismissal — names the non-approval option so the model is told to
 * revise the plan rather than to start implementing it.
 */
function planAnswer(question: DshQuestion, response: ProviderPermissionResponse): string[] {
  const { selected } = selectAnswer(question, headerOf(question, 0), response);
  if (selected.length > 0) return selected;
  const approve = question.intent?.approve;
  if (response.behavior === "allow" && response.selectedActionId === "implement") {
    return approve === undefined ? [] : [approve];
  }
  const keep = (question.options ?? []).find((option) => option.label !== approve)?.label;
  return keep === undefined ? [] : [keep];
}
