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
 * - `paseoMcpLabels`: Paseo's English `title` for each MCP tool, in Chinese
 *   (that table's existing convention) and back in English beside it.
 * - `bodyLabels`: block captions. The current renderer does not draw them
 *   (`bodyLabel` is a contract field the row never reads), so they are carried
 *   for completeness only.
 *
 * @module dsh-paseo/client/locale
 */

export type Locale = "en" | "zh-CN";

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
}

/** Everything the client renders that is language-dependent. */
export interface UiText {
  /** Row label per DSH tool name (`tool.title.*`), falling back to the wire name. */
  toolLabels: Record<string, string>;
  /** Row label per Paseo MCP tool, keyed by the bare name after `mcp__paseo__`. */
  paseoMcpLabels: Record<string, string>;
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
      bash: "Command",
      pwsh: "Command",
      read: "Read",
      write: "Write",
      edit: "Edit",
      grep: "Search",
      glob: "Find files",
      web_search: "Web search",
      web_fetch: "Fetch page",
      todo_write: "Update tasks",
      ask_user_question: "Ask question",
      exit_plan_mode: "Plan",
      subagent: "Subagent",
      // DSH's own tools. Its UI titles these through `tool.title.*`; a row that
      // fell through to the wire name + wrench was indistinguishable from an
      // MCP call, which is a different thing entirely.
      create_goal: "Create goal",
      get_goal: "View goal",
      update_goal: "Update goal",
      read_image: "Read image",
      schedule_create: "Create reminder",
      schedule_list: "List reminders",
      schedule_update: "Update reminder",
      schedule_delete: "Delete reminder",
      list_agents: "List agents",
      send_message: "Message an agent",
      interrupt_agent: "Interrupt an agent",
      list_subagent_models: "List subagent models",
      job_list: "List background jobs",
      job_output: "Read job output",
      job_kill: "Cancel background job",
      terminal_open: "Open terminal",
      terminal_read: "Read terminal",
      terminal_list: "List terminals",
      terminal_signal: "Signal terminal",
      terminal_close: "Close terminal",
      workflow: "Run workflow",
      ralph: "Run ralph loop",
      session_search: "Search sessions",
      session_trace: "Trace session",
      session_event_read: "Read event",
      session_event_search: "Search events",
      session_event_trace: "Trace event",
      cordis_run: "Run Cordis plugin",
      cordis_stop: "Stop Cordis plugin",
      cordis_undefine: "Unload Cordis plugin",
      cordis_package_inspect: "Inspect plugin package",
      cordis_runtime_inspect: "Inspect runtime",
      cordis_inspect_list: "List providers",
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
    },
    paseoMcpLabels: {
      speak: "Speak",
      create_workspace: "Create workspace",
      list_workspaces: "List workspaces",
      archive_workspace: "Archive workspace",
      rename_workspace: "Rename workspace",
      create_agent: "Create agent",
      send_agent_prompt: "Send an agent a task",
      get_agent_status: "Get agent status",
      list_agents: "List agents",
      cancel_agent: "Cancel the agent's turn",
      archive_agent: "Archive agent",
      kill_agent: "Terminate agent session",
      update_agent: "Update agent",
      set_agent_mode: "Set agent mode",
      get_agent_activity: "Read agent activity",
      list_workspace_scripts: "List workspace scripts",
      start_workspace_script: "Start workspace script",
      stop_workspace_script: "Stop workspace script",
      list_terminals: "List terminals",
      create_terminal: "Create terminal",
      kill_terminal: "Close terminal",
      capture_terminal: "Read terminal output",
      send_terminal_keys: "Send terminal keys",
      create_schedule: "Create reminder",
      create_heartbeat: "Create heartbeat",
      delete_heartbeat: "Delete heartbeat",
      list_schedules: "List reminders",
      inspect_schedule: "Inspect reminder",
      pause_schedule: "Pause reminder",
      resume_schedule: "Resume reminder",
      delete_schedule: "Delete reminder",
      update_schedule: "Update reminder",
      schedule_logs: "Reminder logs",
      run_schedule_once: "Run reminder once",
      list_providers: "List providers",
      list_models: "List models",
      list_profiles: "List agent profiles",
      inspect_provider: "Inspect provider",
      list_pending_permissions: "List pending permissions",
      respond_to_permission: "Respond to a permission request",
      browser_list_tabs: "List browser tabs",
      browser_new_tab: "Open a browser tab",
      browser_close_tab: "Close browser tab",
      browser_snapshot: "Read page structure",
      browser_screenshot: "Screenshot the page",
      browser_navigate: "Open a URL",
      browser_click: "Click a page element",
      browser_fill: "Fill a page element",
      browser_type: "Type text",
      browser_keypress: "Send a key",
      browser_select: "Select a dropdown option",
      browser_drag: "Drag a page element",
      browser_scroll: "Scroll the page",
      browser_resize: "Resize the viewport",
      browser_upload: "Upload a file",
      browser_wait: "Wait for a page condition",
      browser_logs: "Read page logs",
      browser_evaluate: "Run a page script",
    },
    bodyLabels: {
      output: "Output",
      content: "Content",
      writeContent: "Written content",
      diff: "Changes",
      result: "Result",
      response: "Response",
      log: "Log",
      plan: "Plan",
    },
    thinking: "Thinking",
    expandThinking: "Expand thinking",
    collapseThinking: "Collapse thinking",
    planTitle: "Plan",
    truncated: "\n… (truncated)",
  },
  "zh-CN": {
    toolLabels: {
      bash: "命令",
      pwsh: "命令",
      read: "读取",
      write: "写入",
      edit: "编辑",
      grep: "搜索",
      glob: "查找文件",
      web_search: "联网搜索",
      web_fetch: "抓取网页",
      todo_write: "更新任务",
      ask_user_question: "提问",
      exit_plan_mode: "计划",
      subagent: "子智能体",
      create_goal: "创建目标",
      get_goal: "查看目标",
      update_goal: "更新目标",
      read_image: "读取图片",
      schedule_create: "创建定时任务",
      schedule_list: "列出定时任务",
      schedule_update: "更新定时任务",
      schedule_delete: "删除定时任务",
      list_agents: "列出 agent",
      send_message: "给 agent 发消息",
      interrupt_agent: "打断 agent",
      list_subagent_models: "列出子智能体模型",
      job_list: "列出后台任务",
      job_output: "读取后台任务",
      job_kill: "终止后台任务",
      terminal_open: "打开终端",
      terminal_read: "读取终端",
      terminal_list: "列出终端",
      terminal_signal: "发送终端信号",
      terminal_close: "关闭终端",
      workflow: "工作流",
      ralph: "循环执行",
      session_search: "搜索会话",
      session_trace: "追踪会话",
      session_event_read: "读取会话事件",
      session_event_search: "搜索会话事件",
      session_event_trace: "追踪会话事件",
      cordis_run: "启动插件",
      cordis_stop: "停止插件",
      cordis_undefine: "卸载插件",
      cordis_package_inspect: "检查插件包",
      cordis_runtime_inspect: "检查运行时",
      cordis_inspect_list: "列出 provider",
      cordis_inspect_query: "查询运行时",
      cordis_inspect_self: "检查插件",
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
    },
    paseoMcpLabels: {
      speak: "朗读",
      create_workspace: "创建工作区",
      list_workspaces: "列出工作区",
      archive_workspace: "归档工作区",
      rename_workspace: "重命名工作区",
      create_agent: "创建 agent",
      send_agent_prompt: "给 agent 发任务",
      get_agent_status: "查看 agent 状态",
      list_agents: "列出 agent",
      cancel_agent: "取消 agent 当前回合",
      archive_agent: "归档 agent",
      kill_agent: "终止 agent 会话",
      update_agent: "更新 agent",
      set_agent_mode: "切换 agent 模式",
      get_agent_activity: "查看 agent 活动",
      list_workspace_scripts: "列出工作区脚本",
      start_workspace_script: "启动工作区脚本",
      stop_workspace_script: "停止工作区脚本",
      list_terminals: "列出终端",
      create_terminal: "创建终端",
      kill_terminal: "关闭终端",
      capture_terminal: "读取终端输出",
      send_terminal_keys: "向终端发送按键",
      create_schedule: "创建定时任务",
      create_heartbeat: "创建心跳",
      delete_heartbeat: "删除心跳",
      list_schedules: "列出定时任务",
      inspect_schedule: "查看定时任务",
      pause_schedule: "暂停定时任务",
      resume_schedule: "恢复定时任务",
      delete_schedule: "删除定时任务",
      update_schedule: "更新定时任务",
      schedule_logs: "定时任务日志",
      run_schedule_once: "立即运行一次定时任务",
      list_providers: "列出 provider",
      list_models: "列出模型",
      list_profiles: "列出 agent 配置档",
      inspect_provider: "查看 provider",
      list_pending_permissions: "列出待审批请求",
      respond_to_permission: "响应审批请求",
      browser_list_tabs: "列出浏览器标签页",
      browser_new_tab: "新建浏览器标签页",
      browser_close_tab: "关闭浏览器标签页",
      browser_snapshot: "读取页面结构",
      browser_screenshot: "页面截图",
      browser_navigate: "打开网址",
      browser_click: "点击页面元素",
      browser_fill: "填写页面元素",
      browser_type: "输入文本",
      browser_keypress: "发送按键",
      browser_select: "选择下拉项",
      browser_drag: "拖拽页面元素",
      browser_scroll: "滚动页面",
      browser_resize: "调整视口大小",
      browser_upload: "上传文件",
      browser_wait: "等待页面条件",
      browser_logs: "读取页面日志",
      browser_evaluate: "执行页面脚本",
    },
    bodyLabels: {
      output: "输出",
      content: "内容",
      writeContent: "写入内容",
      diff: "改动",
      result: "结果",
      response: "响应",
      log: "日志",
      plan: "计划",
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
