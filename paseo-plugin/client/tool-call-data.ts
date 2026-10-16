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
  /** Body is source code (read/write/edit/search), so render it as code. */
  code: boolean;
  failed: boolean;
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
  subagent: "子代理",
};

/** Human label for a tool call, falling back to its raw name. */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
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
  if (normalized === "thinking" && (detail === undefined || detail.type === "unknown")) return "Brain";
  if (normalized === "speak") return "MicVocal";
  if (normalized === "task") return "Bot";
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

  switch (type) {
    case "shell":
      primary = str(detail, "command");
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
      primary = str(detail, "label") || str(detail, "text");
      break;
    default:
      primary = "";
      body = "";
      break;
  }

  if (primary === "" && type === "unknown") {
    try {
      primary = JSON.stringify(detail.input ?? "");
    } catch {
      primary = "";
    }
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
    headline: truncate(description === "" ? "" : primary),
    body: truncate(body),
    bodyLabel,
    diff,
    code,
    failed,
  };
}
