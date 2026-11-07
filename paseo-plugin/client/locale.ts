/**
 * Display localization for the timeline rows this plugin draws itself.
 *
 * The server half resolves its locale from the daemon's environment
 * (`server/locale.ts`: `DSH_PASEO_LANG`, else `LC_ALL` / `LC_MESSAGES` / `LANG`,
 * else English). This half **cannot** do that, and the reason is structural, not
 * an oversight:
 *
 * - Paseo compiles `index.client.tsx` in the daemon and ships the bundle to the
 *   app, where it is evaluated (React Native or the web UI). `DSH_PASEO_LANG`
 *   belongs to the daemon process; the bundle never carries it.
 * - The client build is esbuild `platform: "neutral"`, with no `define`, and
 *   Paseo's compiler rejects any non-server import of a node builtin — so
 *   `process.env` is neither inlined at build time nor reachable at run time
 *   (`process` there is the app's, and React Native only ever sets `NODE_ENV`).
 * - The plugin client API has no locale service: `PluginClientContext` offers
 *   theme, `layout.platform`, timeline contributions and RPC, and `layout` is
 *   `{ compact, platform }` — nothing about language. The host app does have its
 *   own i18n (Settings → General → Language), but it is not a plugin export, and
 *   the compiler's allow-list (`@getpaseo/plugin*`, react, react-native, zod)
 *   keeps a plugin from importing it.
 *
 * So the policy is written here as a pure function over an environment the
 * caller supplies — identical to the server's chain, asserted by
 * `harness/locale-check.cjs` — and the *client* default stays `zh-CN`, which is
 * what these rows have always rendered. Two consequences worth stating plainly:
 *
 * 1. Today, `DSH_PASEO_LANG=en` localizes the server's copy and not these rows.
 *    That is a known limitation, not a silent one.
 * 2. The moment a host relays the resolved locale, `setLocale()` adopts it and
 *    every lookup below follows live. A host need not change the protocol to do
 *    that: a tool-call item already carries a free-form `metadata` passthrough
 *    (`ToolCallBase.metadata`), and `localeFromMetadata()` reads a `locale` key
 *    from it — see its note for the one-line wiring.
 *
 * Copy provenance, so nothing here is invented:
 *
 * - `toolLabels` for DSH's own tools: DSH's `tool.title.*` strings, taken from
 *   `@deepseek-ai/dsh-client-ui-conversation` (`TOOL_TITLE_KEYS` lives in
 *   `dsh-client-ui-tool`). `skill` comes from `dsh-client-ui-skill`'s own
 *   `row.title`. The three MCP-resource tools have no DSH title at all — DSH
 *   renders them as a generic row — so their labels are the short form of the
 *   tool's own registered description in `dsh-mcp-resources`.
 * - `paseoMcpLabels`: the English label is the official `PASEO_TOOL_CATALOG`
 *   entry from `@getpaseo/protocol@0.12.0`, verbatim; the Chinese column is a
 *   translation of that label. `harness/locale-check.cjs` compares the English
 *   column against the catalog, so a "nicer" wording here is a test failure,
 *   not an improvement. `speak` is the one tool outside the catalog (Paseo's
 *   own `isPaseoToolName` exempts it too), kept because a daemon can still send
 *   it.
 * - `agentMessageEvents` / `agentMessageFallback`: the five headings of 0.12's
 *   agent-to-agent message rows, taken from the protocol's own
 *   `buildAgentMessageDisplay` (`EVENT_LABELS`: "Message received", "Agent
 *   finished", "Agent errored", "Agent needs permission", "Agent closed"), plus
 *   the generic heading a row whose event is unknown or missing degrades to.
 * - `bodyLabels`: block captions. The current renderer does not draw them
 *   (`bodyLabel` is a contract field the row never reads), so they are carried
 *   for completeness only.
 *
 * @module dsh-paseo/client/locale
 */

export type Locale = "en" | "zh-CN";

/**
 * The event a 0.12 agent-to-agent message row reports.
 *
 * The five values are the protocol's own `AgentMessage.event` enum
 * (`@getpaseo/protocol`'s `agent-message`). Written out here rather than
 * imported so this module stays a pure copy table; a value the protocol adds
 * later degrades to `agentMessageFallback` instead of rendering nothing.
 */
export type AgentMessageEvent = "message" | "finished" | "errored" | "permission-required" | "closed";

/** Every event the row can label, in the protocol's own order. */
export const AGENT_MESSAGE_EVENTS: readonly AgentMessageEvent[] = Object.freeze([
  "message",
  "finished",
  "errored",
  "permission-required",
  "closed",
]);

/**
 * The locale these rows render in until something tells the client otherwise.
 *
 * Not `en`: the client has no environment to read, and Chinese is what a tool
 * row has always shown here, so defaulting to English would change the UI for
 * everyone in the name of a setting nobody can reach yet.
 */
export const DEFAULT_LOCALE: Locale = "zh-CN";

/** One block caption, keyed by the payload it introduces rather than by tool. */
export interface BodyLabels {
  output: string;
  content: string;
  writeContent: string;
  diff: string;
  result: string;
  response: string;
  log: string;
  plan: string;
  /** An agent-to-agent message's own text (0.12's `agent_message` row). */
  message: string;
}

/** Everything the client renders that is language-dependent. */
export interface UiText {
  /** Row label per DSH tool name (`tool.title.*`), falling back to the wire name. */
  toolLabels: Record<string, string>;
  /** Row label per Paseo MCP tool, keyed by the bare name after `mcp__paseo__`. */
  paseoMcpLabels: Record<string, string>;
  /** Head label of an agent-to-agent message row, per protocol event. */
  agentMessageEvents: Record<AgentMessageEvent, string>;
  /** Head label when that row's event is unknown or missing. */
  agentMessageFallback: string;
  /** Captions for an expanded block. */
  bodyLabels: BodyLabels;
  /** Label of a reasoning row. DSH titles every one of them `思考`. */
  thinking: string;
  /** Screen-reader label of the collapsed reasoning row (it opens on tap). */
  expandThinking: string;
  /** Screen-reader label of the expanded reasoning row. */
  collapseThinking: string;
  /** Title of an `exit_plan_mode` row, before its plan text. */
  planTitle: string;
  /** Appended to a body cut at the client's size limit. */
  truncated: string;
  /** Copy for the goal tools' timeline rows (result card and refusals). */
  goalCard: GoalCardText;
  /** Copy for the composer's background-jobs pill and its popover. */
  jobs: JobsText;
  /** Copy for the composer's goal pill and its popover. */
  goal: GoalText;
  /** Copy for the composer's team pill, its panel and the team_task_* cards (T3). */
  team: TeamText;
  /** Copy for the tool-specific timeline cards (L2). */
  toolCards: ToolCardsText;
}

/**
 * The team pill, panel and task cards (T3, design T2 direction B).
 *
 * The roster is one headline (T7): whale + 「DeepSeek」 + 「N 名成员」 and status
 * chips. 运行中 / 已停止 chips are drawn only when the server half sent
 * `running` for someone — a member without it is unknown, and calling it
 * running or stopped would be the silent degradation the server overlay
 * exists to prevent.
 */
export interface TeamText {
  /** Pill label **and** title (= sheet header): the noun, in every state. */
  title: string;
  /** The headline's teammate count (the Lead — the main session — is not counted). */
  memberCount: (n: number) => string;
  /**
   * The roster headline (T7): the name next to the whale, and the status chips'
   * words, full and short (the narrow-width ladder's second level).
   */
  head: {
    title: string;
    words: { failed: string; running: string; stopped: string; done: string };
    short: { failed: string; running: string; stopped: string; done: string };
  };
  /** The grey tag after an owner the server saw stop (`running === false`) on an unfinished task. */
  ownerStopped: string;
  /** The 进行中 header's trailing note, only drawn when n > 0. */
  stoppedOwners: (n: number) => string;
  /** Task group / mark names: in progress, ready, waiting on blockers, done. */
  marks: { doing: string; ready: string; blocked: string; done: string };
  unowned: string;
  /** `task-3、task-4` → 「等 task-3、task-4」. */
  blockedBy: (ids: string) => string;
  /** Joins blocker ids. */
  listSeparator: string;
  /** Shown in the task section when the board is empty. */
  noTasks: string;
  /** DSH's terminal projection failure, verbatim inside. */
  failure: (message: string) => string;
  /** DSH's advisory overlap sentence in this language, or `undefined` to show it verbatim. */
  translateWarning: (raw: string) => string | undefined;
  /** A team tool's failure sentence in this language, or `undefined` to show it verbatim. */
  translateToolError: (raw: string) => string | undefined;
  /** Before the first read lands, or after the board went away. */
  noTeam: string;
  /** The read failed (transient, kept until the next good poll). */
  unavailable: string;
  /** The detail page's back row (accessibility name). */
  back: string;
  /** Detail page section headers and field labels; also the timeline card's. */
  fields: {
    id: string;
    status: string;
    owner: string;
    blockedBy: string;
    writeScopes: string;
    warnings: string;
    revision: string;
    description: string;
  };
  /** The timeline card's list caption and filter words. */
  card: {
    count: (n: number) => string;
    filter: string;
    unownedFilter: string;
    readyFilter: string;
    notReadyFilter: string;
    more: string;
    /** The quiet toggle under a clamped description, and its other half. */
    expand: string;
    collapse: string;
    action: string;
    actions: Record<string, string>;
  };
}

/**
 * The tool-specific timeline cards (L2): the words their heads and receipts are
 * made of.
 *
 * A card's *shape* is decided in `./tool-call-data`; only the language-dependent
 * halves live here, exactly like `goalCard`/`team`. A DSH value the receipt
 * quotes (a status word, an exit code, a model id) stays verbatim: translating
 * the words around it must never invent a value DSH did not send.
 */
export interface ToolCardsText {
  /** Entry labels for the wire keys a reader should not have to parse. */
  labels: {
    message: string;
    prompt: string;
    code: string;
    description: string;
    id: string;
    host: string;
    workspace: string;
    session: string;
    operation: string;
    path: string;
    name: string;
    target: string;
    relation: string;
    action: string;
    status: string;
    record: string;
    records: string;
    content: string;
    nextRun: string;
    rule: string;
    targets: string;
    timeout: string;
  };
  /** `send_message` receipts: the team shape, its old shape, and the subagent-control shape. */
  sent: string;
  sentWithStatus: (status: string) => string;
  delivered: string;
  /** `interrupt_agent` receipts: the team shape (with the status it replaced) and the subagent-control shape. */
  interrupted: (previousStatus: string) => string;
  interruptRequested: string;
  /** `spawn_teammate`: the fork marker after the name, and the creation receipt. */
  inheritsContext: string;
  created: (status: string, model: string) => string;
  /** `wait_agent`: the duration in the head, and the two outcomes. */
  waitSeconds: (n: number) => string;
  waitMinutes: (n: number) => string;
  timedOut: string;
  progressed: string;
  /** DSH's `noProgress.reason` known values; an unknown one stays verbatim. */
  noActivePeer: string;
  /** `list_agents`: the head when there is no teammate to count. */
  leadOnly: string;
  noMembers: string;
  /** `job_output` status words, keyed by DSH's `JobStatus`. */
  jobStatuses: Record<string, string>;
  exitCode: (code: string) => string;
  /** `job_kill`'s receipt. */
  cancellationRequested: string;
  /** `memory_update`'s receipt: the id of the version that replaced the old one. */
  memoryUpdated: (id: string) => string;
  /** `memory_migrate_relation`'s receipt: old edges closed, new edges written. */
  memoryMigrated: (closed: number, opened: number) => string;
  /** `memory_reproject`'s receipt: jobs queued, ids that were not in L1 skipped. */
  memoryQueued: (queued: number, skipped: number) => string;
  /** `memory_reproject`'s head: how many records the call named. */
  recordCount: (n: number) => string;
  /** `plugin_manager`: the per-action words and the `application` outcome words. */
  pluginActions: Record<string, string>;
  pluginListed: (total: number) => string;
  pluginApplications: Record<string, string>;
  /** `schedule_view` / `schedule_edit`: the durable status words and the receipts. */
  scheduleStatuses: Record<string, string>;
  scheduleActions: Record<string, string>;
  scheduleUpdated: string;
  scheduleDeleted: string;
  scheduleNotFound: string;
  scheduleConflict: string;
  /** `remote_*`: the argument-less host list's head and the operation receipts. */
  remoteAllHosts: string;
  remoteCreated: (sessionId: string) => string;
  remoteDownloaded: (bytes: number) => string;
  remoteUploaded: (path: string, bytes: number) => string;
  remoteSent: string;
  remoteTargets: (n: number) => string;
}

/**
 * The composer's background-jobs pill.
 *
 * The pill is a **live indicator**: it shows while running/stopping jobs exist
 * and hides once nothing is working. Its label is the bare noun
 * {@link JobsText.pillLabel} in every visible state (user decision 2026-11-05):
 * no count phrase at all. There is deliberately no idle label — settled
 * history belongs to the popover, not to the composer's trigger.
 */
export interface JobsText {
  /** The composer pill's label, in every visible state: no count, no status. */
  pillLabel: string;
  /** The button's title (tooltip, accessibility name, phone sheet header). */
  title: string;
  /** One row's status word, per DSH job status. */
  statuses: Record<string, string>;
  /** Popover line when every job it lists has already settled. */
  allSettled: string;
  /**
   * The folded section's header that hides finished rows.
   *
   * DSH's own job list does the same thing (`settledExpanded = settledOpen ??
   * liveRows.length === 0`): while something is still running, the finished rows
   * fold into one line and the list stays about what is happening now.
   *
   * **No count, and one string for both states.** The count is a row-trailing
   * value, not part of the sentence — the host's own panel rows put it in the
   * muted slot at the end of the row
   * (`packages/app/src/subagents/track.tsx`'s `rowTrailing`,
   * `packages/app/src/components/settings/row-header.tsx`'s `summary`) rather than
   * spelling "3 finished". And the wording must not change when the section
   * opens: only the chevron rotates (the host's `docs/design.md` §12), so a
   * second string for the open state would read as a different group.
   */
  settledLabel: string;
  /** Popover line when the runtime could not read the registry — never "none". */
  unavailable: string;
}

/**
 * The goal tools' rows in the timeline (`create_goal` / `get_goal` /
 * `update_goal`), not the composer pill.
 *
 * `status`/`rounds`/`reason`/`empty` and `phases` are DSH's own card copy
 * (`dsh-client-ui-conversation`'s `detail.state` / `detail.goal.*`), so a
 * result reads the same here as in DSH's web UI.
 *
 * `refusals` is keyed by DSH's structured failure code (`HarnessError.code` on
 * the `tool/result`, `dsh-tool-goal`). `short` replaces the red half of the row
 * head; `hint` opens the expanded block. DSH's verbatim text is never replaced,
 * only preceded. A code missing from this table keeps the verbatim head.
 */
export interface GoalCardText {
  status: string;
  rounds: string;
  reason: string;
  empty: string;
  phases: Record<"active" | "disarmed" | "paused" | "blocked" | "complete", string>;
  refusals: Record<string, { short: string; hint: string }>;
}

/**
 * The composer's goal pill.
 *
 * The pill is a **state indicator**, not a live counter like the jobs pill: it
 * stays visible while a goal exists, because the whole point is that the user
 * can pause/resume/clear it — and, since UI-v7, once more after it completes,
 * until the user has seen it. Five states are told apart (DESIGN §2 + UI-v7):
 * auto-continuing, active-but-not-continuing, paused, blocked, complete. The
 * pill's own strings are the noun in every state; the state is the glyph's, and
 * the panel's first row speaks it in full ({@link running} … {@link complete}).
 *
 * `statuses` is keyed by DSH's durable `GoalPhase` plus one non-phase word,
 * `disarmed` (the facts word for `active + disarmed`), and
 * `harness/locale-check.cjs` asserts the table covers exactly the phases
 * `shared/goal.ts` declares plus `disarmed`, so a phase DSH adds later cannot
 * fall through to a raw English word.
 */
export interface GoalText {
  /**
   * The pill's label **and** title in every state: the neutral noun
   * 「目标」/「Goal」. The host uses the title as the accessibility name, desktop
   * tooltip and phone sheet header (`buttons/view.tsx`), so all three read the
   * noun (UI-v7). The state is carried by the glyph, and spelled out in full by
   * the state names below on the panel's first row.
   */
  title: string;
  /**
   * The full state name while the goal is auto-continuing: the accessibility
   * label of the panel's objective row. Drawn nowhere.
   *
   * Deliberately carries **no round fraction**: the round budget is not a
   * completion percentage, and `目标 3/10` reads as "30% done". The budget is a
   * sentence in the popover ({@link rounds}).
   */
  running: string;
  /** The full state name when the goal is active but this process will not continue it. */
  notRunning: string;
  /** The full state name when the goal is paused. */
  paused: string;
  /** The full state name when the goal is blocked. */
  blocked: string;
  /** The full state name when the goal is complete (UI-v7). */
  complete: string;
  /**
   * The completed panel's one-line hint. DSH has no summary field (survey §3):
   * the closing summary is the model's last assistant message, so the panel
   * points there instead of inventing one.
   */
  completeHint: string;
  /**
   * The panel's objective row's accessibility name: the state in full, then
   * what the row is (its action, or the objective when it has none). With the
   * pill's own name fixed to the noun, this is where the state is spoken.
   */
  rowLabel: (state: string, rest: string) => string;
  /** The facts line's first word, per durable phase, plus `disarmed`. */
  statuses: Record<string, string>;
  /**
   * The popover's round line: the round budget as a sentence.
   *
   * `第 N 轮 · 预算 M`, never `N/M`: the cap is a budget DSH may raise while the
   * goal runs, not a completion target (default 256), so a fraction would be
   * read as progress the runtime cannot know.
   */
  rounds: (started: number, max: number) => string;
  /**
   * The "now" line's prefix: `正在：` / `Now: `.
   *
   * The prefix is drawn muted and the todo text in `foreground`, the way the
   * host's task rows separate a label from its value; absent todo means the line
   * is not drawn at all.
   */
  currentTaskPrefix: string;
  /**
   * The one-line explanation for `active + disarmed`.
   *
   * Without it the pill says "not running" and the user has no idea why, or
   * what the 继续 button does. DESIGN §2 fixes the meaning; the wording here is
   * the explanation of that state.
   */
  disarmedHint: string;
  /**
   * The clear page's hint: what clearing means before the user confirms it.
   *
   * The design's rule is "destructive is a colour, not a click": the red row
   * appears only after the user has asked to clear, and this line says what that
   * asks for.
   */
  clearHint: string;
  /**
   * The clear page's hint for a **completed** goal. Clearing one does not stop
   * anything; what it loses is the record `/goal` can still show, so that is
   * what the sentence says.
   */
  completeClearHint: string;
  /**
   * The row-end icon buttons and the edit/clear pages' labels.
   *
   * The icon buttons are unlabelled on screen (a pause glyph and a trash glyph),
   * so these strings are their accessibility names — the only place a screen
   * reader can tell the two buttons apart.
   */
  actions: {
    /** Accessibility name of the pause icon button (goal is auto-continuing). */
    pauseTarget: string;
    /** Accessibility name of the continue icon button (goal is not continuing). */
    resumeTarget: string;
    /** Accessibility name of the objective row, which opens the editor. */
    edit: string;
    /** Accessibility name of the trash icon button and the clear page's red row. */
    clearTarget: string;
    /** The clear page's cancel row. */
    cancel: string;
  };
  /**
   * The edit page (design-opus-v4 direction C: a small Paseo composer).
   *
   * `enterKey` / `shiftEnterKey` / `escKey` are key names drawn in the host's
   * shortcut chips and stay as the keyboard prints them; the words after them
   * are translated.
   */
  editor: {
    /** The edit page's header next to the whale. */
    title: string;
    /** Accessibility name of the round ✓ button. */
    save: string;
    /** The quiet text button left of ✓. */
    cancel: string;
    escKey: string;
    /** Header hint after the Esc chip (desktop only). */
    escHint: string;
    enterKey: string;
    /** Footer hint after the Enter chip (desktop only). */
    enterHint: string;
    shiftEnterKey: string;
    /** Footer hint after the Shift Enter chip (desktop only). */
    shiftEnterHint: string;
  };
  /** Placeholder of the edit field. */
  editPlaceholder: string;
  /** Accessibility name of the running ring on the whale. */
  runningA11y: string;
  /** Shown while one control action is in flight. */
  busy: string;
  /** Fallback when a control action failed without the runtime's own sentence. */
  controlFailed: string;
  /**
   * A goal-control refusal in this language, or `undefined` to show the raw
   * sentence as it came.
   *
   * The sentences are `@deepseek-ai/dsh-command-goal`'s (`lib/index.js`) and the
   * plugin server's own (`server/session.ts` / `server/provider.ts` /
   * `shared/goal.ts`), matched whole — a sentence with a variable (an action, a
   * phase) is translated only when the variable is one this table names, never
   * half-translated. English answers `undefined` for everything: the runtime
   * already speaks it. **An unknown sentence must come back `undefined`** so the
   * panel shows it verbatim (FIELD-NOTES "silent degradation"); read it through
   * {@link goalControlErrorDisplay}, which also keeps the original.
   */
  translateControlError: (raw: string) => string | undefined;
  /** Popover line when the goal could not be read at all. */
  unavailable: string;
  /** Popover line when the goal was cleared while the panel was open. */
  noGoal: string;
}

/** `/goal`'s usage line (`dsh-command-goal`'s `USAGE`), which DSH appends to some refusals. */
const GOAL_USAGE = /(?:\s*Usage: \/goal \[[^\]]*\])?\s*$/u.source;

/** The `/goal <action>` words the panel sends, in Chinese. */
const GOAL_ACTION_ZH: Record<string, string> = { edit: "编辑", pause: "暂停", resume: "继续", clear: "清除" };

/** DSH's `phaseLabel` words, in Chinese. */
const GOAL_PHASE_ZH: Record<string, string> = { active: "进行中", paused: "已暂停", blocked: "受阻", complete: "已完成" };

/**
 * The known refusals, each matched against the **whole** trimmed sentence.
 * DSH sources: `dsh-command-goal/lib/index.js` (`missingGoal`, the
 * `invalid-edit` / `create` / attachment branches, the `GoalError` catch, the
 * `clear` answer). Plugin sources: `shared/goal.ts` `goalCommandArguments`,
 * `server/session.ts` `controlGoal`, `server/provider.ts` `controlAgentGoal`.
 */
const GOAL_REFUSALS_ZH: ReadonlyArray<readonly [RegExp, (match: RegExpMatchArray) => string | undefined]> = [
  [
    new RegExp(`^No goal is currently set; /goal (\\w+) requires one\\.${GOAL_USAGE}`, "u"),
    (m) => {
      const action = GOAL_ACTION_ZH[m[1] ?? ""];
      return action === undefined ? undefined : `当前没有目标，无法${action}。`;
    },
  ],
  [new RegExp(`^No goal is currently set\\.${GOAL_USAGE}`, "u"), () => "当前没有目标。"],
  [new RegExp(`^Goal editing requires a replacement objective\\.${GOAL_USAGE}`, "u"), () => "编辑目标需要填写新的目标内容。"],
  [
    /^A goal is already (\w+)\. Use \/goal edit <objective> to change it or \/goal clear before replacing it\.$/u,
    (m) => {
      const phase = GOAL_PHASE_ZH[m[1] ?? ""];
      return phase === undefined ? undefined : `已有一个${phase}的目标。要修改它请编辑目标，要换新目标请先清除。`;
    },
  ],
  [
    /^The goal command is not valid for the current state\. Run \/goal to view available commands\.$/u,
    () => "目标当前的状态不允许这个操作（可发送 /goal 查看可用命令）。",
  ],
  [/^Attachments only accompany a goal objective: .*$/u, () => "附件只能随目标内容一起提交。"],
  [/^No goal to clear\.$/u, () => "没有可清除的目标。"],
  [/^Goal cleared\.$/u, () => "目标已清除。"],
  [/^this session is closed; reopen it before controlling its goal$/u, () => "会话已关闭，请重新打开会话后再操作目标。"],
  [/^the goal command was rejected$/u, () => "目标命令被拒绝。"],
  [
    /^no DSH session is open for this agent; send it a message first, then control its goal$/u,
    () => "这个 agent 还没有打开的 DSH 会话，请先给它发一条消息，再操作目标。",
  ],
];

/** One refusal in Chinese, or `undefined` when it is not a known sentence. */
function translateGoalRefusalZh(raw: string): string | undefined {
  const sentence = raw.trim();
  for (const [pattern, render] of GOAL_REFUSALS_ZH) {
    const match = sentence.match(pattern);
    if (match !== null) return render(match);
  }
  return undefined;
}

/** What the panel draws for one control error. */
export interface GoalControlErrorDisplay {
  /** The line drawn in `statusDanger`: the translation, or the raw sentence. */
  readonly message: string;
  /** DSH's own sentence, drawn muted under a translation; absent when `message` already is it. */
  readonly original?: string;
}

/**
 * A control error as the panel shows it: translated when the locale knows the
 * sentence, with the original kept beside it; verbatim otherwise.
 */
export function goalControlErrorDisplay(raw: string, text: GoalText): GoalControlErrorDisplay {
  const translated = text.translateControlError(raw);
  if (translated === undefined || translated === raw) return { message: raw };
  return { message: translated, original: raw.trim() };
}

/**
 * DSH agent-team refusals in Chinese, each matched against the whole trimmed
 * sentence. Sources: `dsh-experimental-agent-team/lib/index.js` (TeamError /
 * TeamTaskGraphError throws) and `dsh-experimental-tool-agent-team/lib/index.js`
 * (list cursor/limit). Tool results arrive as `Error: <message>`; the prefix is
 * optional. An unknown sentence returns `undefined` and is shown verbatim.
 */
const TEAM_REFUSALS_ZH: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => string]> = [
  [/^team task "([^"]+)" not found$/u, (m) => `找不到团队任务 ${m[1]}。`],
  [/^blocker task "([^"]+)" not found$/u, (m) => `找不到依赖任务 ${m[1]}。`],
  [/^stale team task "([^"]+)" revision (\d+); current revision is (\d+)$/u, (m) => `任务 ${m[1]} 已被改动（预期修订 ${m[2]}，当前 ${m[3]}），请重新读取后再试。`],
  [/^team task "([^"]+)" is deleted$/u, (m) => `任务 ${m[1]} 已删除。`],
  [/^team task "([^"]+)" is owned by another member$/u, (m) => `任务 ${m[1]} 已由其他成员认领。`],
  [/^team task "([^"]+)" is not ready to claim$/u, (m) => `任务 ${m[1]} 的依赖未完成，还不能认领。`],
  [/^team task "([^"]+)" is blocked$/u, (m) => `任务 ${m[1]} 被依赖阻塞。`],
  [/^team task "([^"]+)" still blocks "([^"]+)"$/u, (m) => `任务 ${m[1]} 仍被 ${m[2]} 依赖，不能删除。`],
  [/^team task "([^"]+)" cannot block itself$/u, (m) => `任务 ${m[1]} 不能依赖自己。`],
  [/^a team task cannot block itself$/u, () => "任务不能依赖自己。"],
  [/^duplicate blocker "([^"]+)"$/u, (m) => `依赖 ${m[1]} 重复。`],
  [/^task dependency cycle includes "([^"]+)"$/u, (m) => `任务依赖成环（含 ${m[1]}）。`],
  [/^team task "([^"]+)" repeats blocker "([^"]+)"$/u, (m) => `任务 ${m[1]} 重复依赖 ${m[2]}。`],
  [/^blocker task "([^"]+)" for "([^"]+)" is missing or deleted$/u, (m) => `任务 ${m[2]} 的依赖 ${m[1]} 不存在或已删除。`],
  [/^Team task limit (\d+) reached$/u, (m) => `团队任务数已达上限 ${m[1]}。`],
  [/^Team task id space exhausted$/u, () => "团队任务编号已用尽。"],
  [/^task mutation requires its owner or Team Lead$/u, () => "只有任务负责人或队长能改这个任务。"],
  [/^only an in-progress task can be released$/u, () => "只有进行中的任务能放弃认领。"],
  [/^task edit requires subject, description, or write_scopes$/u, () => "编辑任务需要提供标题、说明或写入范围。"],
  [/^set_dependencies requires blocked_by$/u, () => "修改依赖需要提供 blocked_by。"],
  [/^only an in-progress task can complete$/u, () => "只有进行中的任务能标记完成。"],
  [/^only a completed task can reopen$/u, () => "只有已完成的任务能重新打开。"],
  [/^only the Team Lead can reassign tasks$/u, () => "只有队长能改派任务。"],
  [/^only a pending or in-progress task can be reassigned$/u, () => "只有待处理或进行中的任务能改派。"],
  [/^invalid workspace-relative write scope (".*")$/u, (m) => `写入范围不是工作区内的相对路径：${m[1]}`],
  [/^(\w+) must be non-empty$/u, (m) => `${m[1]} 不能为空。`],
  [/^(\w+) exceeds (\d+) characters$/u, (m) => `${m[1]} 超过 ${m[2]} 个字符。`],
  [/^teammate name "([^"]+)" was already used in this Team$/u, (m) => `队员名 ${m[1]} 在本团队已用过。`],
  [/^Team member limit (\d+) reached$/u, (m) => `团队成员数已达上限 ${m[1]}。`],
  [/^teammate name must be lower-kebab-case, at most 64 characters, and not "lead"$/u, () => "队员名必须是小写短横线格式、不超过 64 个字符，且不能是 lead。"],
  [/^active teammate "([^"]+)" not found$/u, (m) => `找不到在岗队员 ${m[1]}。`],
  [/^agent "([^"]+)" is not a member of an active Agent Team$/u, (m) => `agent ${m[1]} 不是在岗团队的成员。`],
  [/^only the Team Lead can create teammates$/u, () => "只有队长能创建队员。"],
  [/^Agent Teams service is disposing$/u, () => "团队服务正在关闭。"],
  [/^Agent Teams service disposed$/u, () => "团队服务已关闭。"],
  [/^Agent Teams runtime disposal exceeded (\d+)ms$/u, (m) => `团队服务关闭超时（${m[1]} 毫秒）。`],
  [/^cursor must be a non-negative safe integer$/u, () => "cursor 必须是非负整数。"],
  [/^limit must be an integer from 1 through 100$/u, () => "limit 必须是 1 到 100 的整数。"],
];

/** One team refusal in Chinese, or `undefined` when it is not a known sentence. */
function translateTeamRefusalZh(raw: string): string | undefined {
  const sentence = raw.trim().replace(/^Error:\s*/u, "");
  for (const [pattern, render] of TEAM_REFUSALS_ZH) {
    const match = sentence.match(pattern);
    if (match !== null) return render(match);
  }
  return undefined;
}

/** DSH's overlap warning (`projectTaskView`), in Chinese; anything else verbatim. */
function translateTeamWarningZh(raw: string): string | undefined {
  const match = /^write scopes overlap with (\S+)$/u.exec(raw.trim());
  return match === null ? undefined : `写入范围与 ${match[1]} 重叠`;
}

/** What a team tool's failure shows: the translation with DSH's words kept, or DSH's words alone. */
export function teamToolErrorDisplay(raw: string, text: TeamText): { message: string; original?: string } {
  const translated = text.translateToolError(raw);
  if (translated === undefined || translated === raw) return { message: raw };
  return { message: translated, original: raw.trim() };
}

const TEXT: Record<Locale, UiText> = {
  en: {
    toolLabels: {
      bash: "Bash",
      pwsh: "Pwsh",
      read: "Read",
      write: "Write",
      edit: "Edit",
      grep: "Grep",
      glob: "Glob",
      web_search: "Search",
      web_fetch: "Fetch",
      todo_write: "Update to-do list",
      ask_user_question: "Ask question",
      exit_plan_mode: "Plan",
      subagent: "Create subagent",
      subagent_fork: "Fork a subagent",
      // DSH's own tools. Its UI titles these through `tool.title.*`; a row that
      // fell through to the wire name + wrench was indistinguishable from an
      // MCP call, which is a different thing entirely.
      //
      // `run_code` has no key of its own in DSH: it is the PTC transport, whose
      // variant is `code` (`TOOL_VARIANTS.run_code = "code"` in
      // `dsh-client-ui-tool`), so its title is `tool.title.code` — 代码 / Code.
      // It was the one DSH tool missing here, and it fell back to the wire name.
      run_code: "Code",
      create_goal: "Create goal",
      get_goal: "View goal",
      update_goal: "Update goal",
      // Not a tool DSH registers: the name of the row this plugin draws for an
      // automatic goal round (`server/activity-timeline.ts`). The round number is
      // that row's summary half and comes from the server's own copy table, so the
      // whole line reads `Goal round · 3`.
      goal_round: "Goal round",
      // Not a DSH tool either: the plugin's own goal state row
      // (`server/activity-timeline.ts`), drawn after every `goal/change`. It used
      // to borrow `get_goal`, which titled it "View goal" like the model's call.
      goal_state: "Goal status",
      read_image: "Read image",
      schedule_create: "Create reminder",
      schedule_list: "List reminders",
      schedule_update: "Update reminder",
      schedule_delete: "Delete reminder",
      list_agents: "List subagents",
      send_message: "Send message",
      interrupt_agent: "Interrupt agent",
      list_subagent_models: "List models",
      job_list: "List background jobs",
      job_output: "Read job output",
      job_kill: "Cancel background job",
      terminal_open: "Open terminal",
      terminal_read: "Read terminal",
      terminal_list: "List terminals",
      terminal_send: "Send terminal input",
      terminal_signal: "Signal terminal",
      terminal_close: "Close terminal",
      workflow: "Run workflow",
      ralph: "Run ralph loop",
      session_search: "Search sessions",
      session_trace: "Trace session",
      session_event_read: "Read event",
      session_event_search: "Search events",
      session_event_trace: "Trace event",
      present: "Present files",
      // Rows Paseo's own daemon appends to the agent timeline when a
      // worktree-isolated workspace is created (`worktree-bootstrap.js`). They
      // are not DSH tools, but they arrive as `tool_call` items like any other.
      paseo_worktree_setup: "Prepare worktree",
      paseo_worktree_terminals: "Start worktree terminals",
      cordis_define: "Register Cordis Plugin",
      cordis_run: "Run Cordis Plugin",
      cordis_stop: "Stop Cordis Plugin",
      cordis_undefine: "Remove Cordis Plugin",
      cordis_package_inspect: "Query Cordis environment",
      cordis_runtime_inspect: "Query Cordis environment",
      cordis_inspect_list: "Inspect providers",
      cordis_inspect_query: "Query runtime",
      cordis_inspect_self: "Inspect plugins",
      // Tools a different profile mounts (`ralph`/`plugin-manager` are disabled
      // in the paseo profile's base, the team tools need the agent-team bundle).
      lsp: "Query code symbols",
      spawn_teammate: "Create teammate",
      team_task_create: "Create team task",
      team_task_get: "Read team task",
      team_task_list: "List team tasks",
      team_task_update: "Update team task",
      wait_agent: "Wait for subagent",
      skill: "Skill",
      list_mcp_resources: "List MCP resources",
      read_mcp_resource: "Read MCP resource",
      list_mcp_resource_templates: "List MCP resource templates",
      mcp_list_tools: "List MCP tools",
      mcp_tool_schema: "Show MCP tool schema",
      mcp_call_tool: "Call MCP tool",
      // The bridge's own archive tool (`dsh-bridge/lib/subagent-archive.js`):
      // our tool, but it arrives as an `unknown` detail, so without a label the
      // row printed the wire name next to a wrench.
      archive_subagents: "Archive subagents",
      // The profile's own plugins register tools DSH has no `tool.title.*` for.
      // Without an entry each row printed its wire name next to the wrench — the
      // phone screenshot that reopened this was `memory_search`. Provenance:
      // `dsh-prime-memory` registers the 22 `memory_*` tools and
      // `conversation_search` (`dist/tools/index.js`); DSH's
      // `dsh-tool-working-directory` registers `working_directory`. Every name
      // here also appears in a real `request/header` tool list on this machine —
      // the scan and the gap list live in `docs/research/table-labels.md`.
      memory_search: "Search memory",
      memory_search_graph: "Search memory graph",
      memory_expand_graph_node: "Expand graph node",
      memory_add: "Add memory",
      memory_import: "Import memory",
      memory_delete: "Delete memory",
      memory_conflicts: "List memory conflicts",
      memory_conflicts_rejected: "List rejected conflict decisions",
      memory_resolve_conflict: "Resolve memory conflict",
      memory_receipts: "Read memory receipts",
      memory_read_scene: "Read memory scene",
      memory_room_admin: "Manage memory rooms",
      memory_room_review: "Review orphan memories",
      memory_ruminate: "Run memory distillation",
      memory_ruminate_cancel: "Cancel memory distillation",
      memory_ruminate_status: "Check distillation status",
      memory_slot_list: "List memory slots",
      memory_slot_write: "Write memory slot",
      memory_slot_close: "Close memory slot",
      conversation_search: "Search conversations",
      working_directory: "Show or change working directory",
      // The 17 rows added 2026-11-07: tools that were still printing their wire
      // name next to the wrench. `dsh-prime-memory` registers the three
      // `memory_*` write tools; `dsh-plugin-manager` registers `plugin_manager`;
      // `dsh-tool-schedule` adds the `edit`/`view` pair beside the four older
      // ones; the `remote_*` family is the Remote-host session tool set that
      // reaches the model through the profile's tool list (its real
      // `request/header` definitions are recorded in
      // `docs/research/table-labels.md`). Every English label names the action,
      // not the wire spelling.
      memory_update: "Update memory",
      memory_migrate_relation: "Migrate memory relation",
      memory_reproject: "Rebuild memory projection",
      plugin_manager: "Manage plugins",
      schedule_edit: "Edit scheduled task",
      schedule_view: "View scheduled task",
      remote_list_hosts: "List remote hosts",
      remote_list_workspaces: "List remote workspaces",
      remote_list_sessions: "List remote sessions",
      remote_read_session: "Read remote session",
      remote_create_session: "Create remote session",
      remote_send_message: "Send remote message",
      remote_interrupt_session: "Interrupt remote session",
      remote_wait_sessions: "Wait for remote sessions",
      remote_download_file: "Download remote file",
      remote_upload_file: "Upload remote file",
      remote_get_operation: "Read remote operation",
      // The placeholder a tool row carries when the wire never named its tool.
      // The server no longer invents such a row (`server/timeline.ts` skips a
      // name-less call and drops a result with no call), so this only catches a
      // row from an older build or another producer — where a readable label
      // beats printing the literal `tool` next to a wrench.
      tool: "Tool call",
    },
    paseoMcpLabels: {
      speak: "Speak",
      create_workspace: "Create workspace",
      list_hosts: "List hosts",
      list_workspaces: "List workspaces",
      archive_workspace: "Archive workspace",
      rename_workspace: "Rename workspace",
      create_agent: "Create agent",
      send_agent_prompt: "Send message",
      get_agent_status: "Check agent",
      list_agents: "List agents",
      cancel_agent: "Cancel agent",
      archive_agent: "Archive agent",
      kill_agent: "Kill agent",
      update_agent: "Update agent",
      set_agent_mode: "Set agent mode",
      get_agent_activity: "Read agent activity",
      list_workspace_scripts: "List scripts",
      start_workspace_script: "Start script",
      stop_workspace_script: "Stop script",
      list_terminals: "List terminals",
      create_terminal: "Create terminal",
      kill_terminal: "Kill terminal",
      capture_terminal: "Read terminal",
      send_terminal_keys: "Send keys",
      create_schedule: "Create schedule",
      create_heartbeat: "Create heartbeat",
      delete_heartbeat: "Delete heartbeat",
      list_schedules: "List schedules",
      inspect_schedule: "Inspect schedule",
      pause_schedule: "Pause schedule",
      resume_schedule: "Resume schedule",
      delete_schedule: "Delete schedule",
      update_schedule: "Update schedule",
      schedule_logs: "Read schedule logs",
      run_schedule_once: "Run schedule",
      list_providers: "List providers",
      list_models: "List models",
      list_profiles: "List profiles",
      inspect_provider: "Inspect provider",
      list_pending_permissions: "List permissions",
      respond_to_permission: "Respond to permission",
      browser_list_tabs: "List browser tabs",
      browser_new_tab: "Open browser tab",
      browser_close_tab: "Close browser tab",
      browser_snapshot: "Snapshot page",
      browser_screenshot: "Take screenshot",
      browser_navigate: "Navigate",
      browser_back: "Go back",
      browser_forward: "Go forward",
      browser_reload: "Reload page",
      browser_click: "Click element",
      browser_fill: "Fill field",
      browser_hover: "Hover element",
      browser_type: "Type text",
      browser_keypress: "Press key",
      browser_select: "Select option",
      browser_drag: "Drag element",
      browser_scroll: "Scroll page",
      browser_resize: "Resize browser",
      browser_upload: "Upload files",
      browser_wait: "Wait for page",
      browser_logs: "Read browser logs",
      browser_evaluate: "Run JavaScript",
    },
    agentMessageEvents: {
      message: "Message received",
      finished: "Agent finished",
      errored: "Agent errored",
      "permission-required": "Agent needs permission",
      closed: "Agent closed",
    },
    agentMessageFallback: "Agent message",
    bodyLabels: {
      output: "Output",
      content: "Content",
      writeContent: "Written content",
      diff: "Changes",
      result: "Result",
      response: "Response",
      log: "Log",
      plan: "Plan",
      message: "Message",
    },
    thinking: "Thinking",
    expandThinking: "Expand thinking",
    collapseThinking: "Collapse thinking",
    planTitle: "Plan",
    truncated: "\n… (truncated)",
    goalCard: {
      status: "Status",
      rounds: "Rounds",
      reason: "Blocker",
      empty: "No goal",
      phases: {
        active: "Active",
        disarmed: "Awaiting continuation",
        paused: "Paused",
        blocked: "Blocked",
        complete: "Completed",
      },
      refusals: {
        GOAL_TOOL_AUTHORITY_REQUIRED: {
          short: "Rejected: automatic rounds cannot create or change a goal",
          hint: "The model may only create or change a goal in a turn the user typed; automatic rounds cannot. The goal itself is unchanged.",
        },
        GOAL_TOOL_INVALID_UPDATE: {
          short: "Rejected: invalid argument combination",
          hint: "The model passed arguments this action does not take. DSH rejected the call; the goal is unchanged.",
        },
        GOAL_TOOL_RESUME_PAUSED: {
          short: "Rejected: only the user can resume a paused goal",
          hint: "A paused goal can only be resumed by the user. The goal is unchanged.",
        },
        GOAL_TOOL_BLOCK_THRESHOLD: {
          short: "Rejected: too early to mark the goal blocked",
          hint: "DSH requires several consecutive rounds before a goal may be marked blocked. The goal is unchanged.",
        },
      },
    },
    jobs: {
      // The pill says only "Background" in every state (user 2026-11-05); the
      // ring on the icon says it is working, the popover says how many.
      pillLabel: "Background",
      title: "Background tasks",
      statuses: {
        running: "Running",
        stopping: "Stopping",
        completed: "Done",
        killed: "Canceled",
        failed: "Failed",
      },
      allSettled: "All background tasks have finished.",
      settledLabel: "Finished",
      unavailable: "Could not read this session's background tasks.",
    },
    goal: {
      title: "Goal",
      running: "Goal running",
      notRunning: "Goal not running",
      paused: "Goal paused",
      blocked: "Goal blocked",
      complete: "Goal complete",
      completeHint: "The summary is in the session's last assistant message.",
      rowLabel: (state, rest) => `${state}, ${rest}`,
      statuses: {
        active: "Active",
        paused: "Paused",
        blocked: "Blocked",
        complete: "Complete",
        /** The facts word for `active + disarmed`, which is not a phase. */
        disarmed: "Not continuing",
      },
      rounds: (started, max) => `Round ${String(started)} · budget ${String(max)}`,
      currentTaskPrefix: "Now: ",
      disarmedHint: "Auto-continue stops when the session is reopened. Press Resume to continue.",
      clearHint: "Clearing stops the goal for good; this cannot be undone.",
      completeClearHint: "After clearing, /goal will no longer show this goal; this cannot be undone.",
      actions: {
        pauseTarget: "Pause goal",
        resumeTarget: "Resume goal",
        edit: "Edit goal",
        clearTarget: "Clear goal",
        cancel: "Cancel",
      },
      editor: {
        title: "Edit goal",
        save: "Save goal",
        cancel: "Cancel",
        escKey: "Esc",
        escHint: "to cancel",
        enterKey: "Enter",
        enterHint: "Save",
        shiftEnterKey: "Shift Enter",
        shiftEnterHint: "New line",
      },
      editPlaceholder: "New objective",
      runningA11y: "Goal running",
      busy: "Working…",
      controlFailed: "The goal command failed.",
      translateControlError: () => undefined,
      unavailable: "Could not read this session's goal.",
      noGoal: "No goal is set.",
    },
    team: {
      title: "Team",
      memberCount: (n) => `${String(n)} member${n === 1 ? "" : "s"}`,
      head: {
        title: "DeepSeek",
        words: { failed: "failed to start", running: "running", stopped: "stopped", done: "tasks done" },
        short: { failed: "failed", running: "run", stopped: "stop", done: "done" },
      },
      ownerStopped: "Stopped",
      stoppedOwners: (n) => `${String(n)} owner${n === 1 ? "" : "s"} stopped`,
      marks: { doing: "In progress", ready: "Ready", blocked: "Waiting", done: "Done" },
      unowned: "Unassigned",
      blockedBy: (ids) => `after ${ids}`,
      listSeparator: ", ",
      noTasks: "No shared tasks yet",
      failure: (message) => `Invalid team record: ${message}`,
      translateWarning: () => undefined,
      translateToolError: () => undefined,
      noTeam: "No team in this session.",
      unavailable: "Could not read this session's team.",
      back: "Back",
      fields: {
        id: "ID",
        status: "Status",
        owner: "Owner",
        blockedBy: "Blocked by",
        writeScopes: "Write scopes",
        warnings: "Warnings",
        revision: "Revision",
        description: "Details",
      },
      card: {
        count: (n) => `${String(n)} task${n === 1 ? "" : "s"}`,
        filter: "Filter",
        unownedFilter: "unassigned",
        readyFilter: "ready",
        notReadyFilter: "waiting",
        more: "More tasks; the model can page through them",
        expand: "More",
        collapse: "Less",
        action: "Action",
        actions: {
          claim: "Claim", release: "Release", edit: "Edit", set_dependencies: "Set blockers",
          complete: "Complete", reopen: "Reopen", reassign: "Reassign", delete: "Delete",
        },
      },
    },
    toolCards: {
      labels: {
        message: "Message",
        prompt: "Prompt",
        code: "Code",
        description: "Description",
        id: "ID",
        host: "Host",
        workspace: "Workspace",
        session: "Session",
        operation: "Operation",
        path: "Path",
        name: "Name",
        target: "Target",
        relation: "Relation",
        action: "Action",
        status: "Status",
        record: "Record",
        records: "Records",
        content: "Content",
        nextRun: "Next run",
        rule: "Schedule",
        targets: "Targets",
        timeout: "Timeout",
      },
      sent: "Sent",
      sentWithStatus: (status) => `Sent · ${status}`,
      delivered: "Delivered",
      interrupted: (previousStatus) => `Interrupted (was ${previousStatus})`,
      interruptRequested: "Interrupt requested",
      inheritsContext: "inherits context",
      created: (status, model) => (model === "" ? `Created · ${status}` : `Created · ${status} · ${model}`),
      waitSeconds: (n) => `${String(n)}s`,
      waitMinutes: (n) => `${String(n)}m`,
      timedOut: "Timed out",
      progressed: "Changed",
      noActivePeer: "No member to wait for",
      leadOnly: "Lead only",
      noMembers: "No members",
      jobStatuses: {
        running: "Running",
        stopping: "Stopping",
        completed: "Completed",
        killed: "Cancelled",
        failed: "Failed",
      },
      exitCode: (code) => `exit code ${code}`,
      cancellationRequested: "Cancellation requested",
      memoryUpdated: (id) => `Updated · new version ${id}`,
      memoryMigrated: (closed, opened) => `Migrated · closed ${String(closed)} old · opened ${String(opened)} new`,
      memoryQueued: (queued, skipped) =>
        skipped === 0 ? `Queued ${String(queued)} job(s)` : `Queued ${String(queued)} job(s) · skipped ${String(skipped)}`,
      recordCount: (n) => `${String(n)} record(s)`,
      pluginActions: {
        list_plugins: "List plugins",
        list_bundles: "List bundles",
        set_plugin: "Enable or disable plugin",
        set_bundle: "Enable or disable bundle",
        install_bundle: "Install bundle",
        remove_bundle: "Remove bundle",
        list_version_exemptions: "List version exemptions",
        set_version_exemption: "Set version exemption",
      },
      pluginListed: (total) => `${String(total)} entries`,
      pluginApplications: {
        applied: "Applied",
        cancelled: "Cancelled",
        overridden: "Saved (overridden)",
        "restart-required": "Restart required",
        failed: "Failed",
      },
      scheduleStatuses: {
        active: "Active",
        paused: "Paused",
        ended: "Ended",
      },
      scheduleActions: {
        update: "Update",
        delete: "Delete",
      },
      scheduleUpdated: "Updated",
      scheduleDeleted: "Deleted",
      scheduleNotFound: "Task not found",
      scheduleConflict: "Task changed; nothing written",
      remoteAllHosts: "All remote hosts",
      remoteCreated: (sessionId) => `Created · ${sessionId}`,
      remoteDownloaded: (bytes) => `Downloaded · ${String(bytes)} bytes`,
      remoteUploaded: (path, bytes) => `Uploaded · ${path} · ${String(bytes)} bytes`,
      remoteSent: "Sent (queued)",
      remoteTargets: (n) => `${String(n)} session(s)`,
    },
  },
  "zh-CN": {
    toolLabels: {
      bash: "运行命令",
      pwsh: "运行命令",
      read: "读取",
      write: "写入",
      edit: "编辑",
      grep: "搜索文件内容",
      glob: "查找文件",
      web_search: "网页搜索",
      web_fetch: "网页获取",
      todo_write: "更新任务清单",
      ask_user_question: "提问",
      exit_plan_mode: "计划",
      subagent: "创建子智能体",
      subagent_fork: "派生子智能体分支",
      // DSH 的 `tool.title.code`（`run_code` 是 PTC 传输，变体是 `code`）。
      run_code: "代码",
      create_goal: "创建目标",
      get_goal: "查看目标",
      update_goal: "更新目标",
      // 不是 DSH 注册的工具：本插件为自动续跑轮次画的那一行的名字
      // （`server/activity-timeline.ts`）。轮数是该行的 summary 半，由服务端
      // 自己的文案表给出，整行读作「目标续跑 · 第 3 轮」。
      goal_round: "目标续跑",
      // 也不是 DSH 的工具：插件在每次 `goal/change` 后画的状态行。以前借用
      // `get_goal` 的名字，标题成了「查看目标」，与模型真实的调用同名。
      goal_state: "目标状态",
      read_image: "读取图片",
      schedule_create: "创建定时任务",
      schedule_list: "查看定时任务",
      schedule_update: "修改定时任务",
      schedule_delete: "删除定时任务",
      list_agents: "查看子智能体",
      send_message: "发送消息",
      interrupt_agent: "中断智能体",
      list_subagent_models: "查看可用模型",
      job_list: "查看后台任务",
      job_output: "读取任务输出",
      job_kill: "取消后台任务",
      terminal_open: "创建终端",
      terminal_read: "读取终端",
      terminal_list: "查看终端",
      terminal_send: "发送终端输入",
      terminal_signal: "发送终端信号",
      terminal_close: "关闭终端",
      workflow: "运行工作流",
      ralph: "运行循环工作流",
      session_search: "搜索会话",
      session_trace: "追踪会话",
      session_event_read: "读取事件",
      session_event_search: "搜索事件",
      session_event_trace: "追踪事件",
      present: "交付文件",
      paseo_worktree_setup: "准备 worktree",
      paseo_worktree_terminals: "初始化 worktree 终端",
      cordis_define: "注册 Cordis 插件",
      cordis_run: "运行 Cordis 插件",
      cordis_stop: "停止 Cordis 插件",
      cordis_undefine: "移除 Cordis 插件",
      cordis_package_inspect: "查询 Cordis 环境",
      cordis_runtime_inspect: "查询 Cordis 环境",
      cordis_inspect_list: "检查提供方",
      cordis_inspect_query: "查询运行时",
      cordis_inspect_self: "检查动态插件",
      lsp: "查询代码符号",
      spawn_teammate: "创建队友",
      team_task_create: "创建团队任务",
      team_task_get: "读取团队任务",
      team_task_list: "查看团队任务",
      team_task_update: "更新团队任务",
      wait_agent: "等待子智能体",
      skill: "加载技能",
      list_mcp_resources: "列出 MCP 资源",
      read_mcp_resource: "读取 MCP 资源",
      list_mcp_resource_templates: "列出 MCP 资源模板",
      mcp_list_tools: "列出 MCP 工具",
      mcp_tool_schema: "查看 MCP 工具参数",
      mcp_call_tool: "调用 MCP 工具",
      archive_subagents: "归档子智能体",
      // profile 自带插件注册的工具，DSH 没有给它们 `tool.title.*`：缺表项时行头会印
      // wire name 加兜底扳手（用户手机截图就是 `memory_search`）。来源：
      // `dsh-prime-memory` 注册 22 个 `memory_*` 与 `conversation_search`
      //（`dist/tools/index.js`）、DSH 的 `dsh-tool-working-directory` 注册
      // `working_directory`；这些名字也都出现在本机真实的 `request/header` 工具表里
      //（采集与缺口清单见 `docs/research/table-labels.md`）。
      memory_search: "搜索记忆",
      memory_search_graph: "搜索记忆图谱",
      memory_expand_graph_node: "展开图谱节点",
      memory_add: "添加记忆",
      memory_import: "导入记忆",
      memory_delete: "删除记忆",
      memory_conflicts: "列出记忆冲突",
      memory_conflicts_rejected: "列出被丢弃的冲突决策",
      memory_resolve_conflict: "裁决记忆冲突",
      memory_receipts: "查看记忆决策凭证",
      memory_read_scene: "读取记忆场景",
      memory_room_admin: "管理记忆分类",
      memory_room_review: "复查孤立记忆",
      memory_ruminate: "触发记忆反刍",
      memory_ruminate_cancel: "取消记忆反刍",
      memory_ruminate_status: "查看反刍状态",
      memory_slot_list: "列出记忆槽位",
      memory_slot_write: "写入记忆槽位",
      memory_slot_close: "关闭记忆槽位",
      conversation_search: "搜索对话记录",
      working_directory: "查看或切换工作目录",
      // 2026-11-07 补齐的 17 个工具：此前它们在时间流里印 wire name 加扳手。
      // memory 三个写工具来自 `dsh-prime-memory`；`plugin_manager` 来自
      // `dsh-plugin-manager`；schedule 的 edit/view 与四个旧工具同属
      // `dsh-tool-schedule`；remote_* 是 Remote 主机会话工具集（真实
      // `request/header` 定义已记录在 `docs/research/table-labels.md`）。
      memory_update: "修订记忆",
      memory_migrate_relation: "迁移记忆关系",
      memory_reproject: "重建记忆投影",
      plugin_manager: "管理插件",
      schedule_edit: "修改定时任务",
      schedule_view: "查看定时任务详情",
      remote_list_hosts: "列出远程主机",
      remote_list_workspaces: "列出远程工作区",
      remote_list_sessions: "列出远程会话",
      remote_read_session: "读取远程会话",
      remote_create_session: "创建远程会话",
      remote_send_message: "发送远程消息",
      remote_interrupt_session: "中断远程会话",
      remote_wait_sessions: "等待远程会话",
      remote_download_file: "下载远程文件",
      remote_upload_file: "上传远程文件",
      remote_get_operation: "查看远程操作回执",
      // 工具行在 wire 上没拿到名字时的占位名。服务端已不再造这种行
      //（`server/timeline.ts` 跳过无名调用、丢弃没有调用的结果），这里只为
      // 旧版本/其它生产者发来的行兜底：可读标签胜过把字面量 `tool` 摆在扳手旁。
      tool: "工具调用",
    },
    paseoMcpLabels: {
      speak: "朗读",
      create_workspace: "创建工作区",
      list_hosts: "列出主机",
      list_workspaces: "列出工作区",
      archive_workspace: "归档工作区",
      rename_workspace: "重命名工作区",
      create_agent: "创建 agent",
      send_agent_prompt: "发送消息",
      get_agent_status: "查看 agent 状态",
      list_agents: "列出 agent",
      cancel_agent: "取消 agent",
      archive_agent: "归档 agent",
      kill_agent: "终止 agent",
      update_agent: "更新 agent",
      set_agent_mode: "切换 agent 模式",
      get_agent_activity: "查看 agent 活动",
      list_workspace_scripts: "列出脚本",
      start_workspace_script: "启动脚本",
      stop_workspace_script: "停止脚本",
      list_terminals: "列出终端",
      create_terminal: "创建终端",
      kill_terminal: "关闭终端",
      capture_terminal: "读取终端",
      send_terminal_keys: "发送按键",
      create_schedule: "创建定时任务",
      create_heartbeat: "创建心跳",
      delete_heartbeat: "删除心跳",
      list_schedules: "列出定时任务",
      inspect_schedule: "查看定时任务",
      pause_schedule: "暂停定时任务",
      resume_schedule: "恢复定时任务",
      delete_schedule: "删除定时任务",
      update_schedule: "更新定时任务",
      schedule_logs: "读取定时任务日志",
      run_schedule_once: "立即运行定时任务",
      list_providers: "列出 provider",
      list_models: "列出模型",
      list_profiles: "列出配置档",
      inspect_provider: "查看 provider",
      list_pending_permissions: "列出待审批请求",
      respond_to_permission: "响应审批请求",
      browser_list_tabs: "列出浏览器标签页",
      browser_new_tab: "打开浏览器标签页",
      browser_close_tab: "关闭浏览器标签页",
      browser_snapshot: "页面快照",
      browser_screenshot: "页面截图",
      browser_navigate: "导航",
      browser_back: "后退",
      browser_forward: "前进",
      browser_reload: "刷新页面",
      browser_click: "点击元素",
      browser_fill: "填写输入框",
      browser_hover: "悬停元素",
      browser_type: "输入文本",
      browser_keypress: "按下按键",
      browser_select: "选择选项",
      browser_drag: "拖拽元素",
      browser_scroll: "滚动页面",
      browser_resize: "调整浏览器窗口",
      browser_upload: "上传文件",
      browser_wait: "等待页面",
      browser_logs: "读取浏览器日志",
      browser_evaluate: "执行 JavaScript",
    },
    agentMessageEvents: {
      message: "收到消息",
      finished: "智能体已完成",
      errored: "智能体出错",
      "permission-required": "智能体需要授权",
      closed: "智能体已关闭",
    },
    agentMessageFallback: "智能体消息",
    bodyLabels: {
      output: "输出",
      content: "内容",
      writeContent: "写入内容",
      diff: "改动",
      result: "结果",
      response: "响应",
      log: "日志",
      plan: "计划",
      message: "消息",
    },
    thinking: "思考",
    expandThinking: "展开思考",
    collapseThinking: "收起思考",
    planTitle: "计划",
    truncated: "\n…（已截断）",
    goalCard: {
      status: "状态",
      rounds: "执行轮次",
      reason: "受阻原因",
      empty: "没有目标",
      phases: {
        active: "进行中",
        disarmed: "等待继续",
        paused: "已暂停",
        blocked: "受阻",
        complete: "已完成",
      },
      refusals: {
        GOAL_TOOL_AUTHORITY_REQUIRED: {
          short: "已拒绝：续跑轮不能创建或修改目标",
          hint: "模型只能在用户亲自发消息的回合里创建或修改目标，自动续跑轮不行。目标本身没有变化。",
        },
        GOAL_TOOL_INVALID_UPDATE: {
          short: "已拒绝：参数组合不合法",
          hint: "模型给这个动作传了它不接受的参数，DSH 拒绝了这次调用，目标没有变化。",
        },
        GOAL_TOOL_RESUME_PAUSED: {
          short: "已拒绝：只有用户能继续已暂停的目标",
          hint: "已暂停的目标只能由用户继续。目标没有变化。",
        },
        GOAL_TOOL_BLOCK_THRESHOLD: {
          short: "已拒绝：轮数不够，不能标记受阻",
          hint: "DSH 要求先连续跑够轮数才能把目标标记为受阻。目标没有变化。",
        },
      },
    },
    jobs: {
      // pill 上任何状态都只写「后台」（用户 2026-11-05）：图标上的转环说明在跑，数量在面板里。
      pillLabel: "后台",
      title: "后台任务",
      statuses: {
        running: "运行中",
        stopping: "正在停止",
        completed: "已完成",
        killed: "已取消",
        failed: "失败",
      },
      allSettled: "后台任务都已结束。",
      // 只有一句：收起/展开变的只有箭头，改文案会让「展开」看起来像换了分组。
      // 数量不放这里 —— 它挂在行尾那个弱化槽里（宿主 rowTrailing 的位置）。
      settledLabel: "已完成",
      unavailable: "读不到本会话的后台任务。",
    },
    goal: {
      title: "目标",
      running: "目标进行中",
      notRunning: "目标未在续跑",
      paused: "目标已暂停",
      blocked: "目标受阻",
      complete: "目标已完成",
      completeHint: "完成总结见会话最后一条助手消息",
      rowLabel: (state, rest) => `${state}，${rest}`,
      statuses: {
        active: "进行中",
        paused: "已暂停",
        blocked: "受阻",
        complete: "已完成",
        /** `active + disarmed` 的 facts 词，不是 phase。 */
        disarmed: "未在续跑",
      },
      // 预算不是完成度：不写 N/M 分数形态，避免被读成进度。
      rounds: (started, max) => `第 ${String(started)} 轮 · 预算 ${String(max)}`,
      currentTaskPrefix: "正在：",
      // design-opus-v4 §1 的提示文案 B：说清原因，也说清「继续」按钮是解法。
      disarmedHint: "重开会话后自动续跑会停止，点「继续」恢复",
      clearHint: "清除后目标不再续跑，无法撤销",
      completeClearHint: "清除后 /goal 将查不到这个目标，无法撤销",
      actions: {
        pauseTarget: "暂停目标",
        resumeTarget: "继续目标",
        edit: "编辑目标",
        clearTarget: "清除目标",
        cancel: "取消",
      },
      editor: {
        title: "编辑目标",
        save: "保存目标",
        cancel: "取消",
        escKey: "Esc",
        escHint: "取消",
        enterKey: "Enter",
        enterHint: "保存",
        shiftEnterKey: "Shift Enter",
        shiftEnterHint: "换行",
      },
      editPlaceholder: "新的目标内容",
      runningA11y: "目标运行中",
      busy: "处理中…",
      controlFailed: "目标命令执行失败。",
      translateControlError: (raw) => translateGoalRefusalZh(raw),
      unavailable: "读不到本会话的目标。",
      noGoal: "当前没有目标。",
    },
    team: {
      title: "团队",
      memberCount: (n) => `${String(n)} 名成员`,
      head: {
        title: "DeepSeek",
        words: { failed: "创建失败", running: "运行中", stopped: "已停止", done: "任务完成" },
        short: { failed: "失败", running: "运行", stopped: "停止", done: "完成" },
      },
      ownerStopped: "已停止",
      stoppedOwners: (n) => `${String(n)} 个负责人已停止`,
      marks: { doing: "进行中", ready: "可开始", blocked: "等待依赖", done: "已完成" },
      unowned: "未分配",
      blockedBy: (ids) => `等 ${ids}`,
      listSeparator: "、",
      noTasks: "暂无共享任务",
      failure: (message) => `团队记录无效：${message}`,
      translateWarning: (raw) => translateTeamWarningZh(raw),
      translateToolError: (raw) => translateTeamRefusalZh(raw),
      noTeam: "本会话没有团队。",
      unavailable: "读不到本会话的团队。",
      back: "返回",
      fields: {
        id: "编号",
        status: "状态",
        owner: "负责人",
        blockedBy: "依赖",
        writeScopes: "写入范围",
        warnings: "提醒",
        revision: "修订",
        description: "说明",
      },
      card: {
        count: (n) => `${String(n)} 个任务`,
        filter: "筛选",
        unownedFilter: "未分配",
        readyFilter: "可开始",
        notReadyFilter: "等待依赖",
        more: "还有更多任务，模型可翻页查看",
        expand: "展开",
        collapse: "收起",
        action: "动作",
        actions: {
          claim: "认领", release: "放弃认领", edit: "编辑", set_dependencies: "改依赖",
          complete: "完成", reopen: "重新打开", reassign: "改派", delete: "删除",
        },
      },
    },
    toolCards: {
      labels: {
        message: "消息",
        prompt: "提示词",
        code: "代码",
        description: "说明",
        id: "编号",
        host: "主机",
        workspace: "工作区",
        session: "会话",
        operation: "操作",
        path: "路径",
        name: "名称",
        target: "目标",
        relation: "关系",
        action: "动作",
        status: "状态",
        record: "记录",
        records: "记录",
        content: "内容",
        nextRun: "下次触发",
        rule: "调度规则",
        targets: "目标会话",
        timeout: "超时",
      },
      sent: "已发送",
      sentWithStatus: (status) => `已发送 · ${status}`,
      delivered: "已投递",
      interrupted: (previousStatus) => `已中断（原 ${previousStatus}）`,
      interruptRequested: "已请求中断",
      inheritsContext: "继承上下文",
      created: (status, model) => (model === "" ? `已创建 · ${status}` : `已创建 · ${status} · ${model}`),
      waitSeconds: (n) => `${String(n)} 秒`,
      waitMinutes: (n) => `${String(n)} 分钟`,
      timedOut: "超时",
      progressed: "有变化",
      noActivePeer: "无可等待的成员",
      leadOnly: "仅主会话",
      noMembers: "无成员",
      jobStatuses: {
        running: "运行中",
        stopping: "停止中",
        completed: "已完成",
        killed: "已取消",
        failed: "失败",
      },
      exitCode: (code) => `退出码 ${code}`,
      cancellationRequested: "已请求取消",
      memoryUpdated: (id) => `已修订 · 新版本 ${id}`,
      memoryMigrated: (closed, opened) => `已迁移 · 闭合 ${String(closed)} 条旧边 · 新增 ${String(opened)} 条新边`,
      memoryQueued: (queued, skipped) =>
        skipped === 0 ? `已入队 ${String(queued)} 个作业` : `已入队 ${String(queued)} 个作业 · 跳过 ${String(skipped)} 条`,
      recordCount: (n) => `${String(n)} 条记录`,
      pluginActions: {
        list_plugins: "列出插件",
        list_bundles: "列出插件包",
        set_plugin: "启用或停用插件",
        set_bundle: "启用或停用插件包",
        install_bundle: "安装插件包",
        remove_bundle: "移除插件包",
        list_version_exemptions: "查看版本豁免",
        set_version_exemption: "设置版本豁免",
      },
      pluginListed: (total) => `共 ${String(total)} 条`,
      pluginApplications: {
        applied: "已应用",
        cancelled: "已取消",
        overridden: "已保存（被上层覆盖）",
        "restart-required": "需重启生效",
        failed: "失败",
      },
      scheduleStatuses: {
        active: "进行中",
        paused: "已暂停",
        ended: "已结束",
      },
      scheduleActions: {
        update: "更新",
        delete: "删除",
      },
      scheduleUpdated: "已更新",
      scheduleDeleted: "已删除",
      scheduleNotFound: "未找到该任务",
      scheduleConflict: "任务已变更，未改动",
      remoteAllHosts: "全部远程主机",
      remoteCreated: (sessionId) => `已创建 · ${sessionId}`,
      remoteDownloaded: (bytes) => `已下载 · ${String(bytes)} 字节`,
      remoteUploaded: (path, bytes) => `已上传 · ${path} · ${String(bytes)} 字节`,
      remoteSent: "已发送（排队）",
      remoteTargets: (n) => `${String(n)} 个会话`,
    },
  },
};

/**
 * The locale behind a language tag, or `undefined` when there is none.
 *
 * The rule is the server's: anything starting with `zh` is Simplified Chinese,
 * everything else is English. It is deliberately coarse — this plugin ships two
 * tables, and guessing a third language from a tag it cannot serve would only
 * produce a half-translated row.
 */
export function normalizeLocale(value: unknown): Locale | undefined {
  if (typeof value !== "string") return undefined;
  const tag = value.trim().toLowerCase();
  if (tag === "") return undefined;
  return tag.startsWith("zh") ? "zh-CN" : "en";
}

/**
 * Resolve a display locale from an environment, exactly as the server does:
 * `DSH_PASEO_LANG` wins outright, then the first set of `LC_ALL`,
 * `LC_MESSAGES`, `LANG`.
 *
 * @param env - the environment to read. Defaults to empty: the client has no
 * environment of its own (see the module note), so a caller that *does* have one
 * — the server, or a test — passes it in.
 * @param fallback - the locale when nothing is set. Defaults to the client's
 * own `zh-CN`; the server chain passes `"en"`, which is why the fallback is a
 * parameter rather than a constant.
 */
export function resolveLocale(
  env: Record<string, string | undefined> = {},
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  return (
    normalizeLocale(env.DSH_PASEO_LANG) ??
    normalizeLocale(env.LC_ALL) ??
    normalizeLocale(env.LC_MESSAGES) ??
    normalizeLocale(env.LANG) ??
    fallback
  );
}

/** The locale a host has relayed, if any. Unset means "nobody told us". */
let relayed: Locale | undefined;

/**
 * Adopt a host-supplied display locale.
 *
 * Passing something empty or unrecognizable clears the relay rather than
 * guessing, so an unreadable hint degrades to the documented default instead of
 * silently switching the UI to English.
 */
export function setLocale(value: unknown): void {
  relayed = normalizeLocale(value);
}

/** The locale the client renders in right now. */
export function currentLocale(): Locale {
  return relayed ?? DEFAULT_LOCALE;
}

/** The copy for the current locale. Read it per render, never hoist it. */
export function localeText(): UiText {
  return TEXT[currentLocale()];
}

/**
 * The head label of an agent-to-agent message row.
 *
 * `event` is the protocol's `AgentMessage.event`, but it is typed `string` here
 * on purpose: history from an older or newer daemon can carry a value this
 * table does not know, and the row must degrade to a generic heading rather
 * than show nothing (or throw). Read through `localeText()` per call, like the
 * rest of this module.
 */
export function agentMessageLabel(event: unknown): string {
  const text = localeText();
  if (typeof event === "string") {
    const known = (text.agentMessageEvents as Record<string, string>)[event];
    if (known !== undefined) return known;
  }
  return text.agentMessageFallback;
}

/** Every locale's copy. Exported so the harness can compare the tables. */
export function allText(): Record<Locale, UiText> {
  return TEXT;
}

/**
 * The locale a host relayed through a timeline item's `metadata`.
 *
 * `ToolCallBase.metadata` is the one free-form passthrough the protocol already
 * carries from the provider's server half to this client half — the plugin uses
 * it today to carry bash's `description`. Relaying a locale through it needs no
 * protocol change: the server adds `metadata: { locale }` to any one tool item,
 * and the client transformer calls `setLocale(localeFromMetadata(item.metadata))`
 * *before* it maps the item. Until that happens this returns `undefined` and the
 * default stands.
 */
export function localeFromMetadata(metadata: unknown): Locale | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  return normalizeLocale((metadata as { locale?: unknown }).locale);
}
