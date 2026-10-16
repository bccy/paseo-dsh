/**
 * Normalize a Paseo tool-call timeline item into JSON-safe render data.
 *
 * Kept free of React and React Native imports so it can be exercised by the
 * offline harness without a host runtime.
 *
 * @module dsh-paseo/client/tool-call-data
 */
export interface ToolCallData {
  name: string;
  label: string;
  /** Lucide icon name, chosen to match Paseo's own tool-call icon. */
  icon: string;
  status: "running" | "completed" | "failed" | "canceled";
  phase: "streaming" | "complete";
  /** The row's one-line label: the tool's description when it has one. */
  summary: string;
  /**
   * What the expanded block shows first: the tool's own subject (the command,
   * the path, the query). Empty when it would just repeat `summary`.
   */
  headline: string;
  body: string;
  bodyLabel: string;
  diff: boolean;
  /**
   * The body is source code. Every expansion renders in the same code surface
   * now, so nothing branches on this any more; it stays part of the contract as
   * a hint about the payload's nature.
   */
  code: boolean;
  failed: boolean;
  /**
   * Whether the row's title is a description rather than the tool's own subject.
   *
   * When it is not, the title *is* the subject, and the expanded block carries
   * that same subject in its full form — so the head drops the line instead of
   * printing a compact copy next to a pretty one.
   */
  titled: boolean;
  /**
   * Whether expanding reveals anything beyond the title.
   *
   * A row whose only content is its title is still expandable — the title then
   * wraps to its full width — but must not draw an empty code surface. Computed
   * here rather than in the renderer so it can be asserted offline.
   */
  hasDetail: boolean;
}

type ToolDetail = Record<string, unknown>;

const BODY_LIMIT = 6000;

const TOOL_LABELS: Record<string, string> = {
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
  // DSH's own tools. Its UI titles these through `tool.title.*`; these are the
  // same names in Chinese, so a DSH tool row reads as a DSH tool rather than as
  // an anonymous `wrench <raw_name>` — which is what every MCP-shaped row looks
  // like too, and the two are not the same thing.
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
};

/**
 * Icons for DSH's own tools, which arrive with an `unknown` detail.
 *
 * Without this every one of them fell through to the wrench — the same glyph
 * MCP tools get — so a goal update and an MCP call were indistinguishable.
 */
const TOOL_NAME_ICONS: Record<string, string> = {
  create_goal: "Target",
  get_goal: "Target",
  update_goal: "Target",
  read_image: "Image",
  todo_write: "ListChecks",
  ask_user_question: "MessageCircleQuestion",
  exit_plan_mode: "ClipboardCheck",
  subagent: "Bot",
  list_agents: "Bot",
  send_message: "Bot",
  interrupt_agent: "Bot",
  list_subagent_models: "Bot",
  job_list: "Timer",
  job_output: "Timer",
  job_kill: "Timer",
  terminal_open: "SquareTerminal",
  terminal_read: "SquareTerminal",
  terminal_list: "SquareTerminal",
  terminal_signal: "SquareTerminal",
  terminal_close: "SquareTerminal",
  schedule_create: "CalendarClock",
  schedule_list: "CalendarClock",
  schedule_update: "CalendarClock",
  schedule_delete: "CalendarClock",
  workflow: "Workflow",
  ralph: "Repeat",
  session_search: "History",
  session_trace: "History",
  session_event_read: "History",
  session_event_search: "History",
  session_event_trace: "History",
  cordis_run: "Plug",
  cordis_stop: "Plug",
  cordis_undefine: "Plug",
  cordis_package_inspect: "Plug",
  cordis_runtime_inspect: "Plug",
  cordis_inspect_list: "Plug",
  cordis_inspect_query: "Plug",
  cordis_inspect_self: "Plug",
};

/** Human label for a tool call, falling back to its raw name. */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? paseoMcpLabel(name) ?? name;
}

/**
 * Paseo's own detail-type -> icon table, copied from the host so a plugin row
 * keeps the icon the user already recognises instead of a generic glyph.
 */
const DETAIL_ICONS: Record<string, string> = {
  shell: "SquareTerminal",
  read: "Eye",
  edit: "Pencil",
  write: "Pencil",
  search: "Search",
  fetch: "Search",
  worktree_setup: "SquareTerminal",
  sub_agent: "Bot",
  plain_text: "Wrench",
  plan: "Brain",
  unknown: "Wrench",
};

/** Protocol icon keys (used by `plain_text` details) -> Lucide names. */
const PLAIN_ICONS: Record<string, string> = {
  wrench: "Wrench",
  square_terminal: "SquareTerminal",
  eye: "Eye",
  pencil: "Pencil",
  search: "Search",
  bot: "Bot",
  sparkles: "Sparkles",
  brain: "Brain",
  mic_vocal: "MicVocal",
};

/** Choose the same icon Paseo's stock row would. */
export function toolIcon(name: string, detail: ToolDetail | undefined): string {
  const normalized = name.trim().toLowerCase();
  if (detail !== undefined && detail.type === "plain_text" && typeof detail.icon === "string") {
    return PLAIN_ICONS[detail.icon] ?? "Wrench";
  }
  if (normalized === "thinking" && (detail === undefined || detail.type === "unknown")) return "Sparkle";
  if (normalized === "speak") return "MicVocal";
  if (normalized === "task") return "Bot";
  // Only for `unknown` details: a typed detail (shell/read/edit/…) already
  // carries a better icon than the tool's name would suggest.
  const named = TOOL_NAME_ICONS[normalized] ?? paseoMcpIcon(name);
  if (named !== undefined && (detail === undefined || detail.type === "unknown")) return named;
  if (detail !== undefined && typeof detail.type === "string") {
    return DETAIL_ICONS[detail.type] ?? "Wrench";
  }
  return "Wrench";
}

function str(source: ToolDetail, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function truncate(text: string): string {
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}\n…（已截断）` : text;
}

/**
 * Render a JSON-ish value as display text.
 *
 * `pretty` is for the expanded block: an MCP payload arrives as structured JSON
 * and one long line of it is unreadable in a code surface. The row's one-line
 * title must stay compact — pretty-printed JSON starts with `{`, which is all a
 * clipped single line would ever show.
 */
function stringifyValue(value: unknown, pretty = false): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    // `JSON.stringify` returns `undefined` (not a string) for a function or a
    // symbol, and throws on a cycle or a BigInt. Returning "" for either made
    // the whole payload vanish silently, so say so instead.
    const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
    return typeof text === "string" ? text : "<unserializable>";
  } catch {
    return "<unserializable>";
  }
}


/**
 * Paseo's own MCP tools, keyed by the part after `mcp__paseo__`.
 *
 * Paseo ships 58 of them and each carries an English `title` in its own
 * registry (`server/agent/tools/paseo-tools.js` and `browser-tools/tools.js`);
 * these are those titles in Chinese. Without this a row reads
 * `mcp__paseo__delete_heartbeat {"id":"…"}` — the wire name, which is the one
 * thing about it a reader cannot use. A name we do not know still falls back to
 * the wire name, so a tool added upstream shows up rather than disappearing.
 */
const PASEO_MCP_PREFIX = "mcp__paseo__";

const PASEO_MCP_LABELS: Record<string, string> = {
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
};

/** The same tools by icon. */
const PASEO_MCP_ICONS: Record<string, string> = {
  speak: "Volume2",
  create_workspace: "FolderInput",
  list_workspaces: "FolderOpen",
  archive_workspace: "FolderOpen",
  rename_workspace: "FolderOpen",
  create_agent: "Bot",
  send_agent_prompt: "Bot",
  get_agent_status: "Bot",
  list_agents: "Bot",
  cancel_agent: "Bot",
  archive_agent: "Bot",
  kill_agent: "Bot",
  update_agent: "Bot",
  set_agent_mode: "Bot",
  get_agent_activity: "Activity",
  list_workspace_scripts: "ScrollText",
  start_workspace_script: "Play",
  stop_workspace_script: "Power",
  list_terminals: "SquareTerminal",
  create_terminal: "SquareTerminal",
  kill_terminal: "SquareTerminal",
  capture_terminal: "SquareTerminal",
  send_terminal_keys: "SquareTerminal",
  create_schedule: "CalendarClock",
  create_heartbeat: "HeartPulse",
  delete_heartbeat: "HeartPulse",
  list_schedules: "CalendarClock",
  inspect_schedule: "CalendarClock",
  pause_schedule: "Pause",
  resume_schedule: "RotateCw",
  delete_schedule: "Trash2",
  update_schedule: "CalendarClock",
  schedule_logs: "ScrollText",
  run_schedule_once: "Play",
  list_providers: "Cpu",
  list_models: "Cpu",
  list_profiles: "UserCog",
  inspect_provider: "Cpu",
  list_pending_permissions: "ShieldCheck",
  respond_to_permission: "ShieldCheck",
  browser_list_tabs: "Globe",
  browser_new_tab: "Globe",
  browser_close_tab: "Globe",
  browser_snapshot: "Globe",
  browser_screenshot: "Globe",
  browser_navigate: "Globe",
  browser_click: "Globe",
  browser_fill: "Globe",
  browser_type: "Globe",
  browser_keypress: "Globe",
  browser_select: "Globe",
  browser_drag: "Globe",
  browser_scroll: "Globe",
  browser_resize: "Globe",
  browser_upload: "Globe",
  browser_wait: "Globe",
  browser_logs: "Globe",
  browser_evaluate: "Globe",
};

/** The bare Paseo tool name behind an MCP wire name, or undefined. */
function paseoMcpName(name: string): string | undefined {
  const normalized = name.trim().toLowerCase();
  return normalized.startsWith(PASEO_MCP_PREFIX)
    ? normalized.slice(PASEO_MCP_PREFIX.length)
    : undefined;
}

/** The Chinese label for a Paseo MCP tool, or undefined if we do not know it. */
export function paseoMcpLabel(name: string): string | undefined {
  const bare = paseoMcpName(name);
  return bare === undefined ? undefined : PASEO_MCP_LABELS[bare];
}

/** The icon for a Paseo MCP tool, or undefined if we do not know it. */
export function paseoMcpIcon(name: string): string | undefined {
  const bare = paseoMcpName(name);
  return bare === undefined ? undefined : PASEO_MCP_ICONS[bare];
}

/** Normalize one Paseo tool-call item into JSON-safe render data. */
export function toolCallData(
  item: {
    name: string;
    status: string;
    detail: unknown;
    error?: unknown;
    metadata?: unknown;
  },
  phase: "streaming" | "complete",
): ToolCallData {
  const detail = (item.detail ?? {}) as ToolDetail;
  const metadata = (item.metadata ?? {}) as ToolDetail;
  const type = str(detail, "type");
  const failed = item.status === "failed";
  // DSH's bash tool requires a model-written `description` for every call and
  // its own UI titles the row with it ("List DSH checkout root"), not with the
  // command. The plugin carries it on the item's provider metadata because the
  // shell detail has no field for it.
  const description = str(metadata, "description");
  // The tool's own subject. It becomes the row's label only when there is no
  // description, and is what the expanded block shows.
  let primary = "";
  let body = "";
  let bodyLabel = "输出";
  let diff = false;
  let code = false;
  /** Block-only first line, for rows whose title is something else. */
  let detailHeadline = "";

  switch (type) {
    case "shell":
      primary = str(detail, "command");
      // The head keeps one line, so a multi-line command is only ever readable
      // in the block — lead it with the command the way DSH's own row does.
      detailHeadline = primary;
      body = str(detail, "output");
      bodyLabel = "输出";
      break;
    case "read":
      primary = str(detail, "filePath");
      body = str(detail, "content");
      bodyLabel = "内容";
      code = true;
      break;
    case "write":
      primary = str(detail, "filePath");
      body = str(detail, "content");
      bodyLabel = "写入内容";
      diff = true;
      code = true;
      break;
    case "edit":
      primary = str(detail, "filePath");
      body = str(detail, "unifiedDiff");
      if (body === "") {
        const oldText = str(detail, "oldString");
        const newText = str(detail, "newString");
        // Prefix every line, not just the first: a multi-line replacement must
        // colour each removed and added line, or the diff reads as plain text.
        const removed = oldText === "" ? [] : oldText.split("\n").map((line) => `- ${line}`);
        const added = newText === "" ? [] : newText.split("\n").map((line) => `+ ${line}`);
        body = [...removed, ...added].join("\n");
      }
      bodyLabel = "改动";
      diff = true;
      code = true;
      break;
    case "search":
      primary = str(detail, "query");
      body = str(detail, "content");
      bodyLabel = "结果";
      code = true;
      break;
    case "fetch":
      primary = str(detail, "url");
      body = str(detail, "result");
      bodyLabel = "响应";
      break;
    case "sub_agent":
      primary = str(detail, "description") || str(detail, "subAgentType");
      body = str(detail, "log");
      bodyLabel = "日志";
      break;
    case "plan":
      primary = "计划";
      body = str(detail, "text");
      bodyLabel = "计划";
      break;
    case "plain_text":
      // A `/command` row: `label` is the line that ran, `text` is what it
      // printed. Taking only the label threw the output away, so a slash
      // command looked like it did nothing.
      primary = str(detail, "label") || str(detail, "text");
      body = primary === str(detail, "text") ? "" : str(detail, "text");
      bodyLabel = "输出";
      break;
    default:
      primary = "";
      body = "";
      break;
  }

  if (type === "unknown") {
    // Provider-native tools land here — every MCP call, and anything else Paseo
    // has no detail shape for. The row has to carry both halves itself: the
    // arguments it was called with, and whatever came back. Without the output
    // an expanded row showed exactly what it already showed collapsed, which
    // reads as "this row will not expand".
    // An argument-less call (`list_workspaces`) would otherwise label itself
    // `{}` and open onto another `{}`; the tool's own name is already the label.
    const input = detail.input;
    const emptyInput =
      input === null ||
      input === undefined ||
      (typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0);
    if (primary === "" && !emptyInput) primary = stringifyValue(input);
    detailHeadline = emptyInput ? "" : stringifyValue(input, true);
    body = stringifyValue(detail.output, true);
    bodyLabel = "结果";
    code = true;
  }

  return {
    name: item.name,
    label: toolLabel(item.name),
    icon: toolIcon(item.name, detail),
    status: (["running", "completed", "failed", "canceled"] as const).includes(
      item.status as ToolCallData["status"],
    )
      ? (item.status as ToolCallData["status"])
      : "completed",
    phase,
    summary: truncate(description === "" ? primary : description),
    // A block-specific lead (the pretty arguments of an `unknown` row, the
    // command of a shell row) always wins: a description must not push the block
    // back to the compact one-line form. Otherwise the block leads with the
    // subject only when the head is showing something else — the description.
    headline: truncate(
      detailHeadline !== "" ? detailHeadline : description === "" ? "" : primary,
    ),
    body: truncate(body),
    bodyLabel,
    diff,
    code,
    failed,
    // Whether the expanded block has anything to show. A row whose only content
    // is its title still expands — the title wraps to its full width — but must
    // not draw an empty code surface.
    titled: description !== "",
    hasDetail: truncate(detailHeadline !== "" ? detailHeadline : description === "" ? "" : primary) !== "" || body !== "",
  };
}
