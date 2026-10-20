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
      // `dsh-prime-memory` registers the 19 `memory_*` tools and
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
      // `dsh-prime-memory` 注册 19 个 `memory_*` 与 `conversation_search`
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
      // 工具行在 wire 上没拿到名字时的占位名。服务端已不再造这种行
      //（`server/timeline.ts` 跳过无名调用、丢弃没有调用的结果），这里只为
      // 旧版本/其它生产者发来的行兜底：可读标签胜过把字面量 `tool` 摆在扳手旁。
      tool: "工具调用",
    },
    paseoMcpLabels: {
      speak: "朗读",
      create_workspace: "创建工作区",
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
