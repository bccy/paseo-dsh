/**
 * Display localization for the composer, the approval cards and the timeline.
 *
 * Only the copy Paseo *renders* is translated. Every value that crosses a wire
 * keeps the spelling it had before: mode ids, permission preset keys, model and
 * thinking-effort ids, and — most importantly — command names. A slash command
 * keeps the name DSH registered (`/goal`), because Paseo's command contract has
 * no display-name field: the `name` in `session.commands` is both what the menu
 * shows and what Paseo sends back, so translating it would put a name on the
 * wire that DSH's ASCII-only slash parser (`[a-z][a-z0-9_-]*`) cannot parse.
 * Commands are localized in their description and argument hint instead.
 *
 * The locale follows `DSH_PASEO_LANG` when set, otherwise the daemon's own
 * `LC_ALL` / `LC_MESSAGES` / `LANG`, and falls back to English. The `en` tables
 * carry DSH's own wording verbatim, and anything a table does not know about
 * (a command this plugin has never seen, an effort id a provider invents) passes
 * through untouched rather than being guessed at.
 *
 * @module dsh-paseo/server/locale
 */

export type Locale = "en" | "zh-CN";

/**
 * Resolve the display locale.
 *
 * `DSH_PASEO_LANG` is an explicit override and wins outright — including when it
 * asks for English on a Chinese host, which is the only way to opt a machine out
 * of its own locale. Without it the first set of `LC_ALL`, `LC_MESSAGES`, `LANG`
 * decides, matching how the rest of the toolchain reads the environment.
 */
export function resolveLocale(env: Record<string, string | undefined> = process.env): Locale {
  const explicit = env.DSH_PASEO_LANG?.trim().toLowerCase();
  if (explicit !== undefined && explicit !== "") return explicit.startsWith("zh") ? "zh-CN" : "en";

  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
    const value = env[key]?.trim().toLowerCase();
    if (value !== undefined && value !== "") return value.startsWith("zh") ? "zh-CN" : "en";
  }
  return "en";
}

/** The locale this process renders in; the environment cannot change mid-run. */
export const LOCALE: Locale = resolveLocale();

/** One composer mode. The `id` is the wire value and is never localized. */
export interface ModeCopy {
  id: string;
  label: string;
  description: string;
}

/** The copy that is not tied to a single command or effort id. */
export interface UiCopy {
  modes: readonly ModeCopy[];
  settings: {
    preset: { label: string; description: string };
    permission: { label: string; description: string };
  };
  /** Title of a card carrying more than one question. */
  questionsTitle: string;
  planCard: {
    title: string;
    description: string;
    dismiss: string;
    implement: string;
  };
  /**
   * Titles for the two tools this half draws as a `plain_text` row.
   *
   * Both are DSH's own wording verbatim, from the `TOOL_TITLE_KEYS` table in
   * `@deepseek-ai/dsh-client-ui-tool`: `todo_write` → `todo.rowTitle`,
   * `ask_user_question` → `ask.rowTitle`. Everything else in DSH's `tool.title.*`
   * table belongs to rows the *client* half draws, and lives in
   * `client/locale.ts`.
   */
  toolLabels: {
    updateTasks: string;
    askedUser: string;
  };
}

const UI_COPY: Record<Locale, UiCopy> = {
  en: {
    modes: [
      { id: "build", label: "Build", description: "Investigate and implement changes directly." },
      {
        id: "plan",
        label: "Plan",
        description: "Investigate, then submit a plan for approval before implementing.",
      },
    ],
    settings: {
      preset: {
        label: "Preset",
        description: "DSH agent preset — persona and capabilities. Fixed once the session starts.",
      },
      permission: {
        label: "Permissions",
        description: "DSH sandbox + approval preset for this session.",
      },
    },
    questionsTitle: "Questions",
    planCard: {
      title: "Plan",
      description: "Review the proposed plan before implementation starts.",
      dismiss: "Dismiss",
      implement: "Implement",
    },
    toolLabels: {
      updateTasks: "Update to-do list",
      askedUser: "Ask question",
    },
  },
  "zh-CN": {
    modes: [
      { id: "build", label: "构建", description: "直接调查并实施改动。" },
      { id: "plan", label: "计划", description: "先调查，提交计划待批准后再实施。" },
    ],
    settings: {
      preset: {
        label: "预设",
        description: "DSH agent 预设——人设与能力集合。会话开始后不可更改。",
      },
      permission: {
        label: "权限",
        description: "本次会话的 DSH 沙箱与审批预设。",
      },
    },
    questionsTitle: "问题",
    planCard: {
      title: "计划",
      description: "实施开始前，请先审阅这份计划。",
      dismiss: "放弃",
      implement: "实施",
    },
    toolLabels: {
      updateTasks: "更新任务清单",
      askedUser: "提问",
    },
  },
};

/** The copy for the resolved locale. */
export const UI: UiCopy = UI_COPY[LOCALE];

/** One command's menu copy. The name is the runtime's own and never translated. */
export interface CommandCopy {
  name: string;
  description: string;
  argumentHint?: string;
}

/**
 * Localized copy for the slash commands this profile mounts.
 *
 * Keyed by the command's real (runtime) name, which is also the name the menu
 * shows and the name DSH receives. A command missing here keeps the runtime's
 * own description, so a profile that mounts extra commands — or a DSH version
 * that adds one — shows them unchanged instead of silently disappearing.
 *
 * Control words inside an argument hint (`clear`, `pause`, `resume`, `edit`,
 * `off`) stay in English: they are the syntax the command actually accepts, not
 * copy.
 */
const COMMAND_COPY: Record<Locale, Readonly<Record<string, Omit<CommandCopy, "name">>>> = {
  en: {},
  "zh-CN": {
    goal: {
      description: "设置或查看长任务的目标",
      argumentHint: "[<目标>|clear|edit <目标>|pause|resume]",
    },
    compact: { description: "压缩较早的对话历史" },
    feedback: { description: "记录对本次会话的反馈", argumentHint: "<文本>" },
    permission: { description: "切换权限预设（沙箱模式 + 审批策略）", argumentHint: "<预设>" },
    plan: { description: "进入或退出计划模式", argumentHint: "[off|消息]" },
  },
};

/**
 * The menu entry to advertise for one runtime command.
 *
 * The name always rides through untouched — see the module note: Paseo has one
 * name for both display and dispatch. Only the description and hint are localized.
 *
 * @param realName - the name DSH registered, and the only name the runtime accepts.
 * @param fallback - the runtime's own description and hint, used verbatim when
 * the locale has no entry.
 */
export function commandCopy(
  realName: string,
  fallback: { description: string; argumentHint?: string },
): CommandCopy {
  const copy = COMMAND_COPY[LOCALE][realName];
  if (copy === undefined) {
    return {
      name: realName,
      description: fallback.description,
      ...(fallback.argumentHint === undefined ? {} : { argumentHint: fallback.argumentHint }),
    };
  }
  return {
    name: realName,
    description: copy.description,
    ...(copy.argumentHint === undefined ? {} : { argumentHint: copy.argumentHint }),
  };
}

/**
 * Menu descriptions for the skills Paseo ships into `~/.agents/skills`.
 *
 * Display-only, and the only place a skill is ever localized: the name is the
 * token DSH injects from a `/name` line, and the description the model reads
 * when it picks a skill must stay the author's. That is also why the files
 * themselves are not the place to do this — Paseo manages them (each skill
 * directory carries a `.paseo-managed-files.json` with the file's hash, and its
 * sync rewrites a file whose content differs), so an edit there is reverted.
 *
 * A skill with no entry keeps its own description, so a user-installed skill
 * shows unchanged.
 */
const SKILL_COPY: Record<Locale, Readonly<Record<string, string>>> = {
  en: {},
  "zh-CN": {
    paseo: "用 MCP 或 CLI 管理 Paseo：项目、工作区、agent、定时任务、心跳",
    "paseo-advisor": "找个 agent 当顾问，对当前任务给第二意见",
    "paseo-committee": "组两人委员会，退一步做根因分析并给出方案",
    "paseo-handoff": "把当前任务连上下文交接给另一个 agent",
    "paseo-help": "回答 Paseo 产品与 App 的问题：配置、连接、provider、日志、排障",
    "paseo-plugin": "开发和管理本地 Paseo 插件：贡献点、生命周期钩子、RPC、发布",
  },
};

/** The menu description for one skill: localized when known, the author's otherwise. */
export function skillDescription(name: string, fallback: string): string {
  return SKILL_COPY[LOCALE][name] ?? fallback;
}

/**
 * Thinking-effort labels, keyed by the effort id the provider declares.
 *
 * DSH derives its English label by capitalizing the level, so there is nothing
 * to pass through but that label; an id with no entry keeps it.
 */
const EFFORT_COPY: Record<Locale, Readonly<Record<string, string>>> = {
  en: {},
  "zh-CN": {
    off: "关闭",
    minimal: "最低",
    low: "低",
    medium: "中",
    high: "高",
    max: "最高",
  },
};

/** The display label for one thinking-effort id. */
export function effortLabel(id: string, fallback: string): string {
  return EFFORT_COPY[LOCALE][id] ?? fallback;
}
