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
  ProviderToolCallDetail,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "./dsh-process";
import {
  DshProcess,
  type DshAnswer,
  type DshChildOpened,
  type DshMcpServer,
  type DshPermissionPreset,
  type DshQuestion,
  type DshQuestionRequest,
  type DshRoute,
  type DshUsage,
} from "./dsh-process";
import { TimelineBuilder } from "./timeline";
import { UI, commandCopy } from "./locale";

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

/** Resolve Paseo's catalog id (`provider/model`) back into a DSH route. */
export function parseRoute(model: string | undefined, fallback: DshRoute): DshRoute {
  if (model === undefined || model === "") return fallback;
  const slash = model.indexOf("/");
  if (slash <= 0) return { ...fallback, model };
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

export class DshSession {
  readonly id: string;
  /** DSH's session id (see {@link DshSessionOptions.dshSessionId}). */
  readonly #dshSessionId: string;
  readonly #options: DshSessionOptions;
  readonly #timeline = new TimelineBuilder();
  #process: DshProcess | undefined;
  #route: DshRoute;
  #mode: string;
  #thinkingOption: string | undefined;
  #turnId: string | null = null;
  #replaySeq = 0;
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

  /** Spawn the process, pin the route, and reconcile the requested mode. */
  async open(): Promise<void> {
    const process = new DshProcess({
      cwd: this.#options.cwd,
      route: this.#route,
      sessionId: this.#dshSessionId,
      env: this.#options.env,
      mcpServers: this.#options.mcpServers,
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
    });
    this.#process = process;
    await process.start();
    if (this.#mode === "plan") {
      await process.setPlan(true);
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
      // A skill's name is the token DSH injects from a `/name` line and its
      // description belongs to the skill's author, so neither is localized. Only
      // a registered command has copy of ours to show.
      if (command.kind !== "command") {
        return {
          name: command.name,
          description: command.description,
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
   * Read the agent presets the profile declares, for the composer. Optional: a
   * profile that mounts no preset registry simply gets no Preset control.
   */
  async loadPresets(): Promise<void> {
    const info = await this.#require().presets();
    if (!info.available) return;
    this.#preset = info.current ?? info.default;
    this.#presetOptions = info.presets.map((preset) => ({
      value: preset.id,
      label: preset.name ?? preset.id,
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
    const { events } = await this.#require().history();
    if (events.length === 0) return;
    const builder = new TimelineBuilder();
    for (const event of events) {
      const data = isRecord(event.data) ? event.data : {};
      const seq = typeof event.seq === "number" ? event.seq : this.#replaySeq++;
      if (event.type === "user/message") {
        const source = isRecord(data.source) ? data.source : {};
        if (source.kind !== "user") continue;
        const text = textBlocks(data.content);
        if (text === "") continue;
        this.#options.emit({
          type: "timeline.item",
          sessionId: this.id,
          item: { type: "user_message", id: `user:history:${seq}`, text, clientMessageId: `history:${seq}` },
        });
        continue;
      }
      for (const item of builder.consume({ type: event.type, seq, data })) {
        this.#options.emit({ type: "timeline.item", sessionId: this.id, item });
      }
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
   * Live children that appear after this are handled by {@link #onChildOpened}.
   */
  async replaySubagents(): Promise<void> {
    if (this.#closed || !this.#subsession) return;
    const process = this.#process;
    if (process === undefined) return;
    let listing: {
      available: boolean;
      subagents: Array<{ sessionId: string; parentSessionId: string; mode?: string; label?: string }>;
      diagnostics?: unknown[];
      error?: { message: string };
    };
    try {
      listing = await process.subagents();
    } catch (error) {
      this.#options.log(`subagent enumeration failed: ${messageOf(error)}`);
      return;
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
    for (const row of listing.subagents) {
      if (this.#closed) return;
      const child = this.#openChildNow({
        sessionId: row.sessionId,
        parentSessionId: row.parentSessionId,
        ...(row.mode === undefined ? {} : { mode: row.mode }),
        ...(row.label === undefined ? {} : { label: row.label }),
      });
      if (child === undefined) {
        this.#options.log(`subagent ${row.sessionId} has an unresolved parent ${row.parentSessionId}`);
        continue;
      }
      let history: {
        events: Array<{ type: string; seq?: number; time?: number; data: unknown }>;
        inheritedEventCount: number;
      };
      try {
        history = await process.history(row.sessionId);
      } catch (error) {
        this.#options.log(`subagent history failed for ${row.sessionId}: ${messageOf(error)}`);
        continue;
      }
      if (this.#closed) return;
      child.replay(history.events, history.inheritedEventCount);
    }
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
      this.#emitUserMessage(prompt.clientMessageId, line);
      const issuedTurn = this.#openTurnId(prompt.clientMessageId, prompt.delivery);
      try {
        await process.prompt(line, [{ type: "text", text: line }], prompt.delivery);
      } catch (error) {
        if (issuedTurn) this.#turnId = null;
        this.#emitPromptFailed(prompt.clientMessageId, error);
        return;
      }
      this.#emitPromptAccepted(prompt.clientMessageId, prompt.delivery);
      return;
    }

    // Paseo and the bridge already agree on the text/image block shape, so the
    // blocks ride through untouched. They used to be collapsed to a text label,
    // which silently discarded every non-text attachment.
    const blocks = prompt.input.content.map(toDshContent);
    const label = blocks
      .map((block) => (block.type === "text" ? (block.text as string) : ""))
      .filter((text) => text !== "")
      .join("\n");

    this.#emitUserMessage(prompt.clientMessageId, label);

    const issuedTurn = this.#openTurnId(prompt.clientMessageId, prompt.delivery);
    try {
      await process.prompt(label, blocks.length === 0 ? undefined : blocks, prompt.delivery);
    } catch (error) {
      if (issuedTurn) this.#turnId = null;
      this.#emitPromptFailed(prompt.clientMessageId, error);
      return;
    }

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

  #emitUserMessage(clientMessageId: string, text: string): void {
    this.#options.emit({
      type: "timeline.item",
      sessionId: this.id,
      item: { type: "user_message", id: `user:${clientMessageId}`, text, clientMessageId },
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
      // Switch the DSH permission preset through its own `/permission` command,
      // which owns both the sandbox mode and the approval policy.
      const result = await process.runCommand("permission", requestedPermission);
      if (result.kind === "error") {
        throw new Error(result.text ?? `could not set permission preset "${requestedPermission}"`);
      }
      this.#permission = requestedPermission;
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
   * Cancel the running turn. The session and its history survive, so the
   * conversation stays continuable — killing the process stranded it instead.
   */
  async interrupt(): Promise<void> {
    await this.#require().cancel();
  }

  /** Release the process. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#usageRefreshTimer);
    await this.#process?.shutdown();
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
      this.#options.emit({ type: "session.turn", sessionId: this.id, turnId, state: "started" });
      return;
    }
    if (this.#turnId !== null) {
      const turnId = this.#turnId;
      this.#turnId = null;
      this.#options.emit({ type: "session.turn", sessionId: this.id, turnId, state: "completed" });
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
      // Root-scoped: two Paseo sessions resuming the same native child must not
      // collide in Paseo's per-provider session namespace.
      id: `${this.id}:sub:${payload.sessionId}`,
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
    // the child's earliest output.
    if (!this.#rootReady || this.#parentScopedId(payload.parentSessionId) === undefined) {
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

  #bufferChildEvent(item: { kind: "event"; sessionId: string; event: { type: string; [key: string]: unknown } } | { kind: "status"; sessionId: string; status: string }): void {
    this.#trimChildBuffer();
    this.#pendingChildEvents.push(item);
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
          if (this.#parentScopedId(payload.parentSessionId) === undefined) remaining.push(payload);
          else {
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
    const headers = request.questions.map((question, index) => headerOf(question, index));
    const planIndex = request.questions.findIndex((question) => question.intent?.kind === "plan-review");
    const response =
      planIndex < 0
        ? await this.#askQuestions(target, request, headers)
        : await this.#reviewPlan(target, request, request.questions[planIndex] as DshQuestion);

    const answers = request.questions.map((question, index) => ({
      id: question.id,
      selected:
        index === planIndex
          ? planAnswer(question, response)
          : selectAnswer(question, headers[index] as string, response),
      ...(response.behavior === "deny" && response.message !== undefined
        ? { custom: response.message }
        : {}),
    }));

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
  readonly #timeline = new TimelineBuilder();
  #turnId: string | null = null;
  #turnEnded = false;
  #lastUsage: ProviderUsage | undefined;
  #opened = false;

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
      ...(this.#options.title === undefined ? {} : { title: this.#options.title }),
    });
  }

  /** Fold one native child session event into this child's timeline. */
  event(event: { type: string; [key: string]: unknown }): void {
    if (this.#options.closed()) return;
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
   */
  replay(events: Array<{ type: string; seq?: number; time?: number; data: unknown }>, inheritedEventCount = 0): void {
    if (this.#options.closed()) return;
    let fallbackSeq = 0;
    let lastTurnEnd: "completed" | "canceled" | "failed" | undefined;
    let turnOpen = false;
    for (const event of events) {
      const seq = typeof event.seq === "number" ? event.seq : fallbackSeq++;
      if (seq < inheritedEventCount) continue;
      const data = isRecord(event.data) ? event.data : {};
      if (event.type === "turn/start") turnOpen = true;
      else if (event.type === "turn/end") {
        turnOpen = false;
        lastTurnEnd = childTurnState(data.reason);
      }
      if (event.type === "user/message") {
        const source = isRecord(data.source) ? data.source : {};
        if (source.kind !== "user") continue;
        const text = textBlocks(data.content);
        if (text === "") continue;
        this.#options.emit({
          type: "timeline.item",
          sessionId: this.id,
          item: { type: "user_message", id: `user:history:${seq}`, text, clientMessageId: `history:${seq}` },
        });
        continue;
      }
      for (const item of this.#timeline.consume({ type: event.type, seq, data })) {
        this.#options.emit({ type: "timeline.item", sessionId: this.id, item });
      }
    }
    // A closed turn restores its terminal status; an open turn stays "running"
    // (Paseo's default on attach). Only the terminal is emitted, so a failed or
    // cancelled child is never shown as completed.
    if (!turnOpen && lastTurnEnd !== undefined) {
      this.#turnId = null;
      this.#turnEnded = true;
      this.#options.emit({
        type: "session.turn",
        sessionId: this.id,
        turnId: `replay:${this.id}`,
        state: lastTurnEnd,
      });
    }
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
 * A block with no DSH counterpart fails loudly rather than being dropped: the
 * model would otherwise receive a prompt silently missing its evidence.
 */
function toDshContent(block: ProviderContent): Record<string, unknown> {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") return { type: "image", data: block.data, mimeType: block.mimeType };
  throw new Error(`unsupported prompt content type "${block.type}"`);
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
 * Recover the chosen labels from a permission response. Paseo answers through
 * `updatedInput.answers[<header>]` — a string, comma-joined when multi-select —
 * so `selectedActionId` is only a fallback for button-style resolutions.
 */
function selectAnswer(
  question: DshQuestion,
  header: string,
  response: ProviderPermissionResponse,
): string[] {
  if (response.behavior === "deny") return [];
  const answers = isRecord(response.updatedInput) ? response.updatedInput["answers"] : undefined;
  const raw = isRecord(answers) ? answers[header] : undefined;
  if (typeof raw === "string" && raw.trim().length > 0) {
    if (question.multiSelect === true) {
      return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
    return [raw.trim()];
  }
  const options = question.options ?? [];
  const index = Number(response.selectedActionId);
  const label = Number.isInteger(index) ? options[index]?.label : undefined;
  return label === undefined ? [] : [label];
}

/**
 * Decide a plan review. Only the `implement` button approves; anything else —
 * including a dismissal — names the non-approval option so the model is told to
 * revise the plan rather than to start implementing it.
 */
function planAnswer(question: DshQuestion, response: ProviderPermissionResponse): string[] {
  const picked = selectAnswer(question, headerOf(question, 0), response);
  if (picked.length > 0) return picked;
  const approve = question.intent?.approve;
  if (response.behavior === "allow" && response.selectedActionId === "implement") {
    return approve === undefined ? [] : [approve];
  }
  const keep = (question.options ?? []).find((option) => option.label !== approve)?.label;
  return keep === undefined ? [] : [keep];
}
