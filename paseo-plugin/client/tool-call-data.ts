/**
 * Normalize a Paseo tool-call timeline item into JSON-safe render data.
 *
 * Kept free of React and React Native imports so it can be exercised by the
 * offline harness without a host runtime. Every label it produces comes from
 * `./locale`, read at call time rather than baked in at import, so a locale the
 * host relays later takes effect on the next row instead of never.
 *
 * One row is not a tool call despite the wire shape: 0.12 projects an
 * agent-to-agent message as `tool_call{name:"agent_message", detail:plain_text}`
 * and puts its meaning on `item.agentMessage` (event, sender, text). That row is
 * rendered semantically here — event + sender in the head, the message in the
 * block — rather than as the raw legacy row.
 *
 * @module dsh-paseo/client/tool-call-data
 */
import type { AgentMessage } from "./agent-message";
import { agentMessageLabel, currentLocale, localeText, teamToolErrorDisplay, type ToolCardsText } from "./locale";
import { teamTaskSchema } from "../shared/team";
import { teamTaskFields, teamTaskMark, type TeamTaskMark } from "./team-polling";

/**
 * Which of DSH's expanded blocks a row draws.
 *
 * DSH dispatches its body on the call's own variant
 * (`terminalBody ?? diffBody ?? readBody ?? imageBody ?? searchBody ?? webBody ??
 * detailsBody`), and the renderer used to infer the shell case from the absence
 * of a diff and a code flag plus a body caption — a combination that only worked
 * because no other block happened to share it. The mapping is computed here,
 * once, and the renderer reads the field. `generic` is DSH's `detailsBody` (and
 * the `ioCard` fallback): MCP calls, `/` commands, plans, subagents.
 */
export type ToolBlockKind = "terminal" | "diff" | "read" | "search" | "web" | "generic";

/** One match line of a grep result. */
export type SearchMatch = {
  lineNumber: number;
  line: string;
};

/** One file group of a grep result, with its match count. */
export type SearchFile = {
  path: string;
  matches: SearchMatch[];
  count: number;
};

/**
 * The structured search card (`grep`/`glob`), from `meta.shape` plus `meta.total`.
 *
 * `shown` is DSH's `shownCount`: the retained result count, not the number of
 * rows the height cap happens to be showing, so collapsing a group or folding
 * the block never changes the banner. `total` is the pre-cap count from
 * `meta.total`, and `truncated` says the *tool* capped the result — a separate
 * fact from whether this card is folded.
 */
export type SearchBlockData = {
  shape: "matches" | "paths";
  files: SearchFile[];
  paths: string[];
  shown: number;
  total: number;
  truncated: boolean;
  /** The plain-text form the copy control writes (DSH's `copyText`). */
  text: string;
};

/** A numbered `read` result, with the language its card head names. */
export type ReadBlockData = {
  path: string;
  lang: string;
  lines: { number: number; text: string }[];
  totalLines: number;
  /** The whole result as text, for the copy control. */
  text: string;
};

/** One row of a rendered diff: chrome, a hunk header, or a changed line. */
export type DiffRow = {
  kind: "path" | "hunk" | "gap" | "add" | "del" | "context";
  /** The line without its `+ `/`- `/two-space prefix; chrome rows keep theirs. */
  text: string;
};

/**
 * The structured edit/write card, built from `meta.diffs` as real hunks.
 *
 * `body` is the same diff as a unified-diff string (`---`/`+++`, `@@`, context
 * lines), so the `+A -R` stat keeps working off `diffStat()` unchanged. `rows`
 * is what the renderer draws; it differs from `body` only in how a file change
 * is announced (a bare path row rather than the two `---`/`+++` lines) and in
 * carrying no hunk header when there is nothing to separate.
 */
export type DiffBlockData = {
  rows: DiffRow[];
  body: string;
  /** `write`'s `meta.operation`; empty for `edit`. */
  operation: "create" | "update" | "";
  /** The first changed file, for the card head. */
  path: string;
};

/** One web-search citation. */
export type WebSource = {
  url: string;
  title: string;
  /** The link text DSH would use: title, else hostname, else the raw URL. */
  label: string;
  snippet: string;
  publishedAt: string;
};

/**
 * The structured web card. `web_search` and `web_fetch` are one component with
 * two shapes in DSH; the fetch shape carries no sources and the search shape no
 * status code.
 */
export type WebBlockData = {
  shape: "search" | "fetch";
  sources: WebSource[];
  answer: string;
  url: string;
  statusCode: number | null;
  truncated: boolean;
};

export interface ToolCallData {
  name: string;
  label: string;
  /** Lucide icon name, chosen to match Paseo's own tool-call icon. */
  icon: string;
  /**
   * Draw Paseo's own mark instead of the Lucide glyph.
   *
   * True only for a Paseo-owned tool we have **no** specific glyph for — one that
   * would otherwise come out as the generic wrench. Paseo's own UI gives every
   * one of its tools a single mark (`isPaseoToolName` → `paseo` in
   * `resolveToolCallIconName`); this row prefers a specific glyph where we have
   * one and falls back to the mark rather than to a wrench.
   */
  paseoMark: boolean;
  status: "running" | "completed" | "failed" | "canceled";
  /**
   * The row's second half: the tool's description when it has one, else its own
   * subject. A 0.12 agent-to-agent message row puts its sender here
   * (`sender.title` when it has one, else `sender.id`), matching the protocol's
   * own display model.
   */
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
   * Why the call failed, from the item's own `error` field, or "" on a row that
   * did not fail.
   *
   * This is the one thing a failed row cannot derive from `detail`: a failed
   * `write`/`edit` still carries what was *requested* in its detail, and a tool
   * whose output was empty leaves no text at all. The daemon already sends
   * `error: { message }` on every failed tool_call (`server/timeline.ts`), so
   * dropping it here is what turned a failure into a red icon with nothing to
   * read. The renderer shows it as the row's summary line and in the expanded
   * block.
   */
  error: string;
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
  /** The block this row expands into. See {@link ToolBlockKind}. */
  kind: ToolBlockKind;
  /**
   * The structured search card, or null when the result carried no usable meta.
   *
   * Null is not "empty": the renderer falls back to the plain text body, which
   * is what the row showed before this phase. A blank card would be the silent
   * failure this repo keeps warning about.
   */
  search: SearchBlockData | null;
  /** The structured read card, or null when the result carried no usable meta. */
  read: ReadBlockData | null;
  /** The structured edit/write card, or null when the meta was unusable. */
  diffBlock: DiffBlockData | null;
  /** The structured web card, or null when the result carried no usable meta. */
  web: WebBlockData | null;
  /**
   * The goal tools' result card (`create_goal` / `get_goal` / `update_goal`), or
   * null. DSH's own UI never shows these results as JSON: it parses them into a
   * field card (`goalDetail`, see {@link parseGoalResult}). Null for anything
   * that is not that exact shape, which keeps the raw body.
   */
  goal: GoalBlockData | null;
  /**
   * The team task tools' card (`team_task_create` / `get` / `update` / `list`),
   * or null. Null for anything that is not DSH's exact `TeamTaskView` shape,
   * which keeps the raw JSON body (see {@link parseTeamResult}).
   */
  team: TeamBlockData | null;
  /**
   * The generic card for a row whose detail is `unknown`, or null.
   *
   * Null is "nothing to split": an argument-less call whose result was a plain
   * string keeps the raw body, exactly as before this card existed. The goal and
   * team cards win when they parse, because they are the more specific
   * rendering — drawing both would print the same result twice.
   */
  fields: ToolFieldsData | null;
  /**
   * DSH's structured failure code for a failed row (`HarnessError.code`, relayed
   * on `metadata.errorCode` by `server/timeline.ts`), or "".
   */
  errorCode: string;
  /**
   * The head's red half for a code `./locale` knows (`goalCard.refusals`), or "".
   * Empty means the head keeps DSH's verbatim first line, as before.
   */
  errorShort: string;
  /** One plain-language sentence that opens the expanded block, or "". */
  errorHint: string;
}

/**
 * One goal tool result, as DSH's `goalDetail` reads it
 * (`dsh-client-ui-tool` lib/client.js:3854-3883): the objective is the card's
 * title and the row's summary; the fields are 状态 / 执行轮次 and, when blocked,
 * 受阻原因. `empty` is DSH's `{goal: null}` → 「没有目标」.
 *
 * A type alias, not an interface: the transformer's output must be a
 * `JsonValue`, and only an alias carries the implicit index signature.
 */
/** One task as the team card draws it. A type alias so the row stays a `JsonValue`. */
export type TeamTaskCard = {
  id: string;
  subject: string;
  mark: TeamTaskMark;
  fields: Array<{ label: string; value: string; tone?: "warning" }>;
  description: string;
};

/** The team task tools' card: one task (create/get/update) or a list (list). */
export type TeamBlockData = {
  kind: "task" | "list";
  tasks: TeamTaskCard[];
  /** list: 「2 个任务 · 筛选 状态=已完成」; update: 「动作 认领 · task-2」; else "". */
  caption: string;
  /** `team_task_list` answered a `nextCursor`. */
  more: boolean;
};

export type GoalBlockData = {
  objective: string;
  fields: Array<{ label: string; value: string }>;
  empty: boolean;
};

/**
 * One entry of the generic card for a row Paseo has no detail shape for.
 *
 * Such a call's payload is opaque — `input` / `output` are whatever the tool
 * declared — and the old rendering pretty-printed the whole thing into one code
 * block, which turned every newline inside a string into a literal `\n` and a
 * long message into one escaped wall of text. Splitting the payload by its own
 * keys keeps each value in the form it can actually be read in: a short scalar
 * stays a one-line fact, prose keeps its real newlines, and a value that is
 * itself a structure keeps the JSON code surface.
 */
export type ToolFieldEntry = {
  /**
   * `code` is a source block a tool-specific card (L2) hands to the same
   * monospace surface `json` uses: `run_code`'s program is code, and drawing it
   * as prose would re-wrap it into something that cannot be read back.
   */
  kind: "fact" | "text" | "json" | "code";
  /** The payload key, or "" for a whole array value (it has no key of its own). */
  label: string;
  /** A scalar's own form, prose verbatim, pretty JSON, or the code as written. */
  value: string;
};

/**
 * The generic card for an `unknown` row (every MCP call, and DSH's own tools
 * without a typed detail), or null when the payload offers nothing to split.
 *
 * The two halves stay apart because they come from different sides of the call
 * and only the second one gets a caption; `copyText` is the complete result as
 * JSON, so the copy control still hands over every byte even though the card no
 * longer renders the result as one blob.
 */
export type ToolFieldsData = {
  args: ToolFieldEntry[];
  result: ToolFieldEntry[];
  /**
   * One localized sentence that compresses the result (L2: 「已发送」, 「超时」,
   * 「已完成 · 退出码 0」), or "". The generic card never sets it — it is the
   * tool-specific mapping's replacement for the raw result entries.
   */
  receipt: string;
  /** Complete result JSON for the copy control, or "" when `body` carries it. */
  copyText: string;
};

/* -------------------------------------------------------------------------- */
/* Block copy                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The language-dependent copy the new blocks draw.
 *
 * It lives here rather than in `./locale` because this phase owns
 * `tool-call-data.ts` and not `locale.ts`; it reads `currentLocale()` on every
 * call, exactly like `localeText()`, so a relayed locale reaches the next row.
 * Every string is DSH's own (`search.*`, `read.*`, `diff.*`, `web.*` and the
 * `copy`/`copied`/`collapse` keys from its common namespace).
 */
export interface BlockCopy {
  copy: string;
  copied: string;
  collapse: string;
  expandRest(count: number): string;
  expandAria(count: number): string;
  collapseAria: string;
  pathsSummary(shown: number, total: number, truncated: boolean): string;
  matchesSummary(shown: number, total: number, files: number, truncated: boolean): string;
  /** DSH's `search.noResults` — the grep/glob card's empty state. */
  noResults: string;
  /** DSH's `web.noResults` — the web-search card's empty state, a different string. */
  webNoResults: string;
  http: string;
  contentTruncated: string;
  sourcesTruncated: string;
  window(shown: number, total: number): string;
  create: string;
  update: string;
}

const BLOCK_COPY: Record<"en" | "zh-CN", BlockCopy> = {
  en: {
    copy: "Copy",
    copied: "Copied",
    collapse: "Collapse",
    expandRest: (count) => `… ${count} more lines`,
    expandAria: (count) => `Expand ${count} more lines`,
    collapseAria: "Collapse",
    pathsSummary: (shown, total, truncated) =>
      truncated ? `Showing ${shown} of ${total} paths` : `${shown} paths`,
    matchesSummary: (shown, total, files, truncated) =>
      truncated
        ? `Showing ${shown} of ${total} matches · ${files} files`
        : `${shown} matches · ${files} files`,
    noResults: "No results",
    webNoResults: "No results found",
    http: "HTTP",
    contentTruncated: "Content truncated",
    sourcesTruncated: "Sources truncated",
    window: (shown, total) => `Showing ${shown} of ${total} lines`,
    create: "New file",
    update: "Updated",
  },
  "zh-CN": {
    copy: "复制",
    copied: "复制成功",
    collapse: "收起",
    expandRest: (count) => `… 其余 ${count} 行`,
    expandAria: (count) => `展开其余 ${count} 行`,
    collapseAria: "收起内容",
    pathsSummary: (shown, total, truncated) =>
      truncated ? `显示 ${shown} / 共 ${total} 个路径` : `${shown} 个路径`,
    matchesSummary: (shown, total, files, truncated) =>
      truncated
        ? `显示 ${shown} / 共 ${total} 处匹配 · ${files} 个文件`
        : `${shown} 处匹配 · ${files} 个文件`,
    noResults: "无结果",
    webNoResults: "未找到结果",
    http: "HTTP",
    contentTruncated: "内容已截断",
    sourcesTruncated: "来源列表已截断",
    window: (shown, total) => `显示 ${shown} / ${total} 行`,
    create: "新建",
    update: "更新",
  },
};

/** The block copy for the locale in force right now. */
export function blockCopy(): BlockCopy {
  return BLOCK_COPY[currentLocale()];
}

/** Every locale's block copy, so the harness can assert the tables line up. */
export function allBlockCopy(): Record<"en" | "zh-CN", BlockCopy> {
  return BLOCK_COPY;
}

/* -------------------------------------------------------------------------- */
/* Reading DSH's presentation meta                                            */
/* -------------------------------------------------------------------------- */

type ToolDetail = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `metadata` key DSH's raw result meta travels under.
 *
 * Mirrors `PRESENTATION_META_KEY` in `server/timeline.ts`. It cannot be imported
 * from there: this module is compiled for plain `node` (the offline harness) and
 * bundled for React Native, and the server half is a different build.
 * `harness/tool-call-check.cjs` reads both sources and asserts the two literals
 * are equal, so a rename on one side cannot silently orphan the other.
 *
 * It is **not** on `detail`: the plugin subprocess runs every event through
 * `ProviderEventSchema.parse`, whose `toolCallDetailSchema` members are all
 * `.strip()`, so an unknown `detail.meta` is deleted before the client sees it.
 * `metadata` is a `jsonObjectSchema` and survives the parse.
 */
const PRESENTATION_META_KEY = "presentationMeta";

/**
 * DSH's raw `presentationMeta`, off the item's own `metadata`.
 *
 * The server keeps it verbatim; a shape it could not match still arrives here,
 * and anything that fails a field check below makes that parser return null,
 * which puts the row back on its plain-text rendering.
 */
function metaOf(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = metadata[PRESENTATION_META_KEY];
  return isRecord(meta) ? meta : undefined;
}

function numberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `grep`'s `meta.files`, or null for anything that is not the documented shape. */
function parseMatchFiles(raw: unknown): SearchFile[] | null {
  if (!Array.isArray(raw)) return null;
  const files: SearchFile[] = [];
  for (const file of raw) {
    if (!isRecord(file) || typeof file.path !== "string" || !Array.isArray(file.matches)) return null;
    const matches: SearchMatch[] = [];
    for (const match of file.matches) {
      if (!isRecord(match)) return null;
      const lineNumber = numberField(match, "lineNumber");
      if (lineNumber === null || typeof match.line !== "string") return null;
      matches.push({ lineNumber, line: match.line });
    }
    files.push({ path: file.path, matches, count: matches.length });
  }
  return files;
}

/** The plain-text form of a search card, byte-for-byte DSH's `copyText`. */
function searchCopyText(data: {
  shape: "matches" | "paths";
  files: SearchFile[];
  paths: string[];
}): string {
  if (data.shape === "paths") return data.paths.join("\n");
  return data.files
    .map((file) => [file.path, ...file.matches.map((match) => `${match.lineNumber}: ${match.line}`)].join("\n"))
    .join("\n\n");
}

function parseSearch(meta: Record<string, unknown>): SearchBlockData | null {
  const total = numberField(meta, "total");
  if (total === null) return null;
  const truncated = meta.truncated === true;
  if (meta.shape === "matches") {
    const files = parseMatchFiles(meta.files);
    if (files === null) return null;
    const shown = files.reduce((sum, file) => sum + file.count, 0);
    return { shape: "matches", files, paths: [], shown, total, truncated, text: searchCopyText({ shape: "matches", files, paths: [] }) };
  }
  if (meta.shape === "paths") {
    if (!Array.isArray(meta.paths) || !meta.paths.every((path) => typeof path === "string")) return null;
    const paths = [...(meta.paths as string[])];
    return { shape: "paths", files: [], paths, shown: paths.length, total, truncated, text: searchCopyText({ shape: "paths", files: [], paths }) };
  }
  return null;
}

function parseRead(detail: ToolDetail, meta: Record<string, unknown>): ReadBlockData | null {
  if (!Array.isArray(meta.lines)) return null;
  const totalLines = numberField(meta, "totalLines");
  if (totalLines === null) return null;
  const lines: Array<{ number: number; text: string }> = [];
  for (const line of meta.lines) {
    if (!isRecord(line)) return null;
    const number = numberField(line, "number");
    if (number === null || typeof line.text !== "string") return null;
    lines.push({ number, text: line.text });
  }
  const path = typeof meta.path === "string" && meta.path !== "" ? meta.path : str(detail, "filePath");
  const lang = typeof meta.lang === "string" ? meta.lang : "";
  return { path, lang, lines, totalLines, text: lines.map((line) => line.text).join("\n") };
}

function parseWeb(meta: Record<string, unknown>, shape: "search" | "fetch"): WebBlockData | null {
  const truncated = meta.truncated === true;
  if (shape === "fetch") {
    if (typeof meta.url !== "string") return null;
    const statusCode = numberField(meta, "statusCode");
    if (statusCode === null) return null;
    return { shape, sources: [], answer: "", url: meta.url, statusCode, truncated };
  }
  if (!Array.isArray(meta.sources)) return null;
  const sources: WebSource[] = [];
  for (const source of meta.sources) {
    if (!isRecord(source) || typeof source.url !== "string") return null;
    const title = typeof source.title === "string" ? source.title : "";
    sources.push({
      url: source.url,
      title,
      label: linkLabel(source.url, title),
      snippet: typeof source.snippet === "string" ? source.snippet : "",
      publishedAt: typeof source.publishedAt === "string" ? source.publishedAt : "",
    });
  }
  return {
    shape,
    sources,
    answer: typeof meta.answer === "string" ? meta.answer : "",
    url: "",
    statusCode: null,
    truncated,
  };
}

/**
 * DSH's `linkLabel`: the title, else the hostname, else the URL as given.
 *
 * A hand-rolled hostname rather than `new URL(...)`: the data layer is compiled
 * for plain `node` (the offline harness) *and* bundled for React Native, where
 * `URL` availability depends on the host's polyfills. A URL this cannot take
 * apart keeps its full text, which is what DSH does too.
 */
export function linkLabel(url: string, title: string): string {
  if (title !== "") return title;
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  if (match === null) return url;
  const authority = match[1].replace(/^[^@]*@/, "");
  const host = authority.replace(/:\d+$/, "");
  return host === "" ? url : host;
}

/* -------------------------------------------------------------------------- */
/* Turning `meta.diffs` into hunks                                            */
/* -------------------------------------------------------------------------- */

/**
 * Context lines DSH keeps around a change (`structuredPatch(..., {context: 3})`).
 */
export const DIFF_CONTEXT_LINES = 3;
/**
 * The edit-graph budget, mirroring DSH's `MAX_DIFF_EDIT_LENGTH`.
 *
 * DSH asks the `diff` package for a patch with `maxEditLength: 256` and falls
 * back to "every old line removed, every new line added" when the search would
 * cost more than that. This is a cell budget for the same reason: a whole-file
 * rewrite must not turn into an unbounded LCS table.
 */
export const MAX_DIFF_CELLS = 250_000;

/**
 * A side's content lines, with DSH's terminator rule.
 *
 * Empty text is zero lines (a create has no `oldText` side), and one trailing
 * newline terminates the last line rather than opening an empty one. An interior
 * blank line survives.
 */
export function contentLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

interface DiffOp {
  readonly kind: "context" | "del" | "add";
  readonly text: string;
}

/** Every old line removed, then every new line added (DSH's fallback patch). */
function replaceAll(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  return [
    ...oldLines.map((text): DiffOp => ({ kind: "del", text })),
    ...newLines.map((text): DiffOp => ({ kind: "add", text })),
  ];
}

/** A minimal line edit script over the two middles, or null past the budget. */
function lcsOps(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] | null {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return newLines.map((text): DiffOp => ({ kind: "add", text }));
  if (m === 0) return oldLines.map((text): DiffOp => ({ kind: "del", text }));
  if (n * m > MAX_DIFF_CELLS) return null;
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "context", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      ops.push({ kind: "del", text: oldLines[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", text: newLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: oldLines[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: newLines[j] });
    j += 1;
  }
  return ops;
}

/**
 * A line-level edit script for one hunk pair, with common prefix/suffix trimming.
 *
 * Trimming first is what keeps the LCS table small on the common case (DSH hands
 * over the changed fragment, not the whole file), and it is also what preserves
 * the surrounding context lines.
 */
export function diffOps(oldText: string, newText: string): DiffOp[] {
  const oldLines = contentLines(oldText);
  const newLines = contentLines(newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middle = lcsOps(oldMiddle, newMiddle) ?? replaceAll(oldMiddle, newMiddle);
  return [
    ...oldLines.slice(0, prefix).map((text): DiffOp => ({ kind: "context", text })),
    ...middle,
    ...oldLines.slice(oldLines.length - suffix).map((text): DiffOp => ({ kind: "context", text })),
  ];
}

/** One hunk of a diff: a slice of the op list plus its line numbers. */
interface DiffHunk {
  readonly ops: readonly DiffOp[];
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

/** `@@ -a,b +c,d @@`, with GNU's `,1` elision. */
function hunkHeader(hunk: DiffHunk): string {
  const range = (start: number, count: number): string =>
    count === 1 ? `${start}` : `${start},${count}`;
  return `@@ -${range(hunk.oldStart, hunk.oldCount)} +${range(hunk.newStart, hunk.newCount)} @@`;
}

/**
 * Group an edit script into `@@` hunks with at most `context` lines of context.
 *
 * Two change runs merge into one hunk when no more than `2 * context` equal
 * lines separate them — GNU diff's own merge rule, and what DSH's `diff`
 * dependency produces.
 */
export function diffHunks(ops: readonly DiffOp[], context: number = DIFF_CONTEXT_LINES): DiffHunk[] {
  const changes: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== "context") changes.push(index);
  });
  if (changes.length === 0) return [];
  const groups: Array<[number, number]> = [];
  let start = changes[0];
  let previous = changes[0];
  for (const index of changes.slice(1)) {
    if (index - previous <= 2 * context) {
      previous = index;
      continue;
    }
    groups.push([start, previous]);
    start = index;
    previous = index;
  }
  groups.push([start, previous]);

  const oldBefore = new Array<number>(ops.length + 1).fill(0);
  const newBefore = new Array<number>(ops.length + 1).fill(0);
  ops.forEach((op, index) => {
    oldBefore[index + 1] = oldBefore[index] + (op.kind === "add" ? 0 : 1);
    newBefore[index + 1] = newBefore[index] + (op.kind === "del" ? 0 : 1);
  });

  return groups.map(([first, last]) => {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    const oldCount = oldBefore[to + 1] - oldBefore[from];
    const newCount = newBefore[to + 1] - newBefore[from];
    return {
      ops: ops.slice(from, to + 1),
      oldStart: oldCount === 0 ? oldBefore[from] : oldBefore[from] + 1,
      oldCount,
      newStart: newCount === 0 ? newBefore[from] : newBefore[from] + 1,
      newCount,
    };
  });
}

/** A diff pair as DSH's `meta.diffs` sends it. */
interface MetaDiff {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

/**
 * One side of a diff pair as text, or `""` for a `null` side.
 *
 * DSH's `FileDiff.oldText` is `string | null` — a create has no old side — and
 * the server half normalizes `null` to `""` before it writes `meta.diffs`. This
 * accepts the raw `null` as well so a row stays readable when an older daemon or
 * a replayed reply still carries it; anything else is a malformed pair.
 */
function diffSide(value: unknown): string | null {
  if (value === null) return "";
  return typeof value === "string" ? value : null;
}

/** `meta.diffs`, or null when any entry is not the documented shape. */
function parseDiffs(raw: unknown): MetaDiff[] | null {
  if (!Array.isArray(raw)) return null;
  const diffs: MetaDiff[] = [];
  for (const diff of raw) {
    if (!isRecord(diff) || typeof diff.path !== "string") return null;
    // The server already folds `null` sides to `""`; this is tolerance for old
    // data / an older daemon's reply, not the primary contract.
    const oldText = diffSide(diff.oldText);
    const newText = diffSide(diff.newText);
    if (oldText === null || newText === null) return null;
    diffs.push({ path: diff.path, oldText, newText });
  }
  return diffs;
}

/** The body text one diff pair contributes: `---`/`+++` and its hunks. */
function diffPairBody(diff: MetaDiff): string {
  const lines: string[] = [`--- ${diff.path}`, `+++ ${diff.path}`];
  for (const hunk of diffHunks(diffOps(diff.oldText, diff.newText))) {
    lines.push(hunkHeader(hunk));
    for (const op of hunk.ops) {
      if (op.kind === "add") lines.push(`+${op.text}`);
      else if (op.kind === "del") lines.push(`-${op.text}`);
      else lines.push(` ${op.text}`);
    }
  }
  return lines.join("\n");
}

/** The rows one diff pair contributes, without its own file announcement. */
function diffPairRows(diff: MetaDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of diffHunks(diffOps(diff.oldText, diff.newText))) {
    rows.push({ kind: "hunk", text: hunkHeader(hunk) });
    for (const op of hunk.ops) {
      if (op.kind === "add") rows.push({ kind: "add", text: op.text });
      else if (op.kind === "del") rows.push({ kind: "del", text: op.text });
      else rows.push({ kind: "context", text: op.text });
    }
  }
  return rows;
}

/**
 * Build the diff card from `meta.diffs`.
 *
 * A `write` with an empty `diffs` list is DSH's create (and its "successful
 * update with empty metadata" case): DSH then falls back to the argument-derived
 * whole-file diff, so the file's contents become the added side. Returns null
 * whenever the meta is missing or malformed, which puts the row back on the
 * plain-text body the row showed before this phase.
 */
function parseDiffBlock(
  detail: ToolDetail,
  metadata: ToolDetail,
  type: string,
): DiffBlockData | null {
  const meta = metaOf(metadata);
  if (meta === undefined) return null;
  const diffs = parseDiffs(meta.diffs);
  if (diffs === null) return null;
  if (type === "write" && diffs.length === 0) {
    const content = str(detail, "content");
    if (content === "") return null;
    diffs.push({ path: str(detail, "filePath"), oldText: "", newText: content });
  }
  if (diffs.length === 0) return null;
  const distinctPaths = new Set(diffs.map((diff) => diff.path)).size;
  const rows: DiffRow[] = [];
  diffs.forEach((diff, index) => {
    if (index === 0) {
      // A single-file diff leaves the path to the card head (the preview's own
      // shape); once there are several, every group announces itself. A repeat
      // of the same path gets DSH's `⋯` instead, so two hunks of one file do
      // not read as two files.
      if (distinctPaths > 1) rows.push({ kind: "path", text: diff.path });
    } else if (diffs[index - 1].path === diff.path) {
      rows.push({ kind: "gap", text: "⋯" });
    } else {
      rows.push({ kind: "path", text: diff.path });
    }
    rows.push(...diffPairRows(diff));
  });
  if (rows.length === 0) return null;
  const operation = meta.operation === "create" || meta.operation === "update" ? meta.operation : "";
  return {
    rows,
    body: diffs.map(diffPairBody).join("\n"),
    operation,
    path: diffs[0].path,
  };
}

/** The block a detail type dispatches to, mirroring DSH's own order. */
function blockKind(type: string, toolName: string): ToolBlockKind {
  switch (type) {
    case "shell":
      return "terminal";
    case "read":
      return "read";
    case "write":
    case "edit":
      return "diff";
    case "fetch":
      return "web";
    case "search":
      // `web_search` arrives as Paseo's `search` detail (it has a query and
      // results); DSH draws it with the same component as `web_fetch`.
      return toolName === "web_search" ? "web" : "search";
    default:
      return "generic";
  }
}

/**
 * Upper bound for the plain-text body of a block that has no scroll region of
 * its own.
 *
 * Only the **legacy plain-text diff fallback** still uses it (see the return
 * statement below): that card draws one row per line and has neither a scroll
 * region nor a copy control, so an uncapped body would mount an unbounded row
 * tree. Every other body is rendered by a card that shows it whole inside a
 * capped window and copies the whole of it — DSH's `TerminalBlock` (224px) and
 * the generic code surface (`.bodyScroll`, 260px) — so capping those would hide
 * the tail and shorten what "copy" gives the user.
 */
const BODY_LIMIT = 6000;

/**
 * Icons for DSH's own tools, which arrive with an `unknown` detail.
 *
 * Without this every one of them fell through to the wrench — the same glyph
 * MCP tools get — so a goal update and an MCP call were indistinguishable.
 * Icons are language-independent, so this table stays here; the names next to it
 * live in `./locale`.
 */
const TOOL_NAME_ICONS: Record<string, string> = {
  // `run_code` is DSH's PTC transport. Its variant is `code`
  // (`TOOL_VARIANTS.run_code = "code"`), whose icon is
  // `IconCodeOutlineRegular`; without this entry the row fell to
  // `DETAIL_ICONS.unknown` and drew the MCP wrench.
  run_code: "Code",
  create_goal: "Target",
  get_goal: "Target",
  update_goal: "Target",
  // Not a tool DSH registers: the name of the row `server/activity-timeline.ts`
  // draws for one automatic goal round. It is a `plain_text` row with no protocol
  // icon key, so it borrows the tool's own glyph — the same Target as the goal
  // tools above, the goal state row and the composer's goal pill.
  goal_round: "Target",
  // The plugin's goal state row (`server/activity-timeline.ts`), same family.
  goal_state: "Target",
  read_image: "Image",
  todo_write: "ListChecks",
  ask_user_question: "MessageCircleQuestion",
  exit_plan_mode: "ClipboardCheck",
  subagent: "Bot",
  // A fork, not a spawn: the child inherits this conversation. DSH names the tool
  // itself in `standard.patch.yml` (`provider: fork`, `toolName: subagent_fork`)
  // and ships no row title for it, so the label below is ours.
  subagent_fork: "GitFork",
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
  terminal_send: "SquareTerminal",
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
  // The one cordis tool DSH does *not* draw with the plugin glyph: its keyed
  // row (`dsh-client-ui-cordis`, `CordisDefineRow`) uses
  // `IconCodeOutlineRegular` — the same glyph as the `code` variant — because
  // the call registers plugin source. Left out of the table above it drew the
  // wrench.
  cordis_define: "Code",
  // A profile other than this one's can mount these: the team tools come with
  // the agent-team bundle, `lsp` with the language-server profile, `skill` and
  // the MCP-resource tools are DSH's own. Without an entry each of them read as
  // `wrench <raw_name>`. Every name here is a Lucide export the host bundle
  // re-exports (`Node <name>` in Paseo's `lucide-react` list).
  lsp: "SearchCode",
  spawn_teammate: "UserPlus",
  team_task_create: "ListTodo",
  team_task_get: "ListTodo",
  team_task_list: "ListTodo",
  team_task_update: "ListTodo",
  wait_agent: "Hourglass",
  skill: "BookOpen",
  list_mcp_resources: "Server",
  read_mcp_resource: "FileText",
  list_mcp_resource_templates: "Server",
  // The bridge's own MCP gateway (`dsh-bridge/lib/mcp-gateway.js`): list what a
  // server exposes, read one tool's schema, then proxy a call to it.
  mcp_list_tools: "Server",
  mcp_tool_schema: "FileJson",
  mcp_call_tool: "Play",
  // The bridge's other tool (`dsh-bridge/lib/subagent-archive.js`): finish
  // native subagent child sessions in DSH's own registry. It arrives as an
  // `unknown` detail, so without this entry the row read
  // `wrench archive_subagents {"agentIds":[…]}`.
  archive_subagents: "Archive",
  // Rows Paseo's own daemon appends to the timeline (`worktree-bootstrap.js`),
  // not rows this provider emits. `paseo_worktree_setup` carries a typed
  // `worktree_setup` detail and takes its glyph from `DETAIL_ICONS`; the
  // terminals row is `unknown`, so it needs the entry.
  paseo_worktree_terminals: "SquareTerminal",
  // `present` is DSH's deliverable row (`dsh-client-ui-deliverables` registers a
  // keyed toolview for it, titled 交付文件 / "Present files"). Its own glyph is
  // `IconDeliverDocRegular` — a document over two perspective planes — which has
  // no Lucide counterpart; `FileOutput` is the nearest *meaning* (files handed
  // out of the session), the same way bash's `IconApiOutlineRegular` maps to
  // `SquareTerminal`. Without an entry the row drew the wrench.
  present: "FileOutput",
  // The memory plugin's tools (`dsh-prime-memory`), `conversation_search` and
  // DSH's working-directory tool. They arrive as provider-native `unknown`
  // details, so each row needs a name-keyed glyph or it falls to the wrench — the
  // phone screenshot that reopened this was `memory_search` with a wrench. The
  // glyphs are distinct inside the family (search / graph / node / add / …), and
  // every name is a Lucide export the host bundle re-exports (`Node <name>` in
  // Paseo's `lucide-react` list); `docs/research/table-labels.md` records the
  // scan that decided which names were missing.
  memory_search: "SearchCheck",
  memory_search_graph: "Network",
  memory_expand_graph_node: "Waypoints",
  memory_add: "Plus",
  memory_import: "Import",
  memory_delete: "Trash2",
  memory_conflicts: "Scale",
  memory_conflicts_rejected: "FileX2",
  memory_resolve_conflict: "Gavel",
  memory_receipts: "ReceiptText",
  memory_read_scene: "BookOpenText",
  memory_room_admin: "LayoutGrid",
  memory_room_review: "ClipboardList",
  memory_ruminate: "RefreshCw",
  memory_ruminate_cancel: "CircleStop",
  memory_ruminate_status: "Gauge",
  memory_slot_list: "List",
  memory_slot_write: "PenLine",
  memory_slot_close: "PackageCheck",
  conversation_search: "MessagesSquare",
  working_directory: "FolderTree",
};

/**
 * Every tool name with a keyed icon, for the coverage check in `harness/`.
 *
 * Exported because the gap it closes was invisible: an icon with no label
 * renders the row as `FileOutput  cordis_define` — the wire name, which is
 * exactly what this table exists to prevent — and neither `toolIcon` nor
 * `toolLabel` can enumerate its own keys from outside.
 */
export const TOOL_ICON_NAMES: readonly string[] = Object.freeze(Object.keys(TOOL_NAME_ICONS));

/**
 * Human label for a tool call, falling back to its raw name.
 *
 * `detail` lets a gateway meta-call borrow the label of the Paseo tool it
 * proxies: the row the user sees is `mcp_call_tool`, but
 * `{"server":"paseo","tool":"delete_heartbeat"}` in its input names the tool
 * whose own label («删除心跳») is the useful one.
 *
 * Read through `localeText()` on every call: the tables live in `./locale`, one
 * per language, and a locale relayed after import must apply to the next row.
 */
export function toolLabel(name: string, detail?: ToolDetail): string {
  const gateway = gatewayPaseoTool(name, detail);
  if (gateway !== undefined) {
    const label = paseoMcpLabel(gateway);
    if (label !== undefined) return label;
  }
  return localeText().toolLabels[name] ?? paseoMcpLabel(name) ?? name;
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

/**
 * The two web tools, which DSH draws with a row of its own (`WebRow`, in
 * `dsh-client-ui-tool`'s `toolviews/web-row.js`) instead of a generic one.
 *
 * That row dispatches on the tool name and picks `IconGlobeOutlineRegular` for
 * `web_search` and `IconBrowseOutlineRegular` for `web_fetch` — the browse glyph
 * being the one the `read` row uses. Neither is the magnifier their *detail*
 * would produce: `web_search` arrives as a `search` detail (shared with
 * grep/glob, which keep the magnifier) and `web_fetch` as a `fetch` detail. So
 * the name — not the detail — decides here, exactly as it does in DSH.
 */
const WEB_ROW_ICONS: Record<string, string> = {
  web_search: "Globe",
  web_fetch: "Eye",
};

/**
 * The wire name a tool row carries when the daemon never learned its tool.
 *
 * The server stopped inventing these rows (`server/timeline.ts` skips a
 * name-less call and drops a result with no call), so this only reaches the
 * client from an older build or another producer. Such a row still deserves a
 * readable label and Paseo's neutral glyph — the wrench `unknown`/`plain_text`
 * details already use — instead of the bare wire name, which reads like a tool
 * actually called `tool`.
 */
export const UNNAMED_TOOL = "tool";

/** Choose the same icon Paseo's stock row would. */
export function toolIcon(name: string, detail: ToolDetail | undefined): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === UNNAMED_TOOL) return "Wrench";
  if (detail !== undefined && detail.type === "plain_text" && typeof detail.icon === "string") {
    return PLAIN_ICONS[detail.icon] ?? "Wrench";
  }
  const webRow = WEB_ROW_ICONS[normalized];
  if (webRow !== undefined) return webRow;
  if (normalized === "thinking" && (detail === undefined || detail.type === "unknown")) return "Sparkle";
  if (normalized === "speak") return "MicVocal";
  if (normalized === "task") return "Bot";
  // Only for `unknown` details: a typed detail (shell/read/edit/…) already
  // carries a better icon than the tool's name would suggest. A gateway
  // meta-call borrows the proxied Paseo tool's icon when its input names one.
  const gateway = gatewayPaseoTool(name, detail);
  const named = (gateway === undefined ? undefined : paseoMcpIcon(gateway))
    ?? TOOL_NAME_ICONS[normalized]
    ?? paseoMcpIcon(name);
  // A `plain_text` row that names no protocol icon key is the second gap the name
  // map fills: the two goal timeline rows (`server/activity-timeline.ts`) are
  // exactly that shape, so they draw the goal tools' Target — the same glyph as
  // the composer's goal pill — instead of the generic wrench. Every other
  // `plain_text` producer sends an icon key and returns above, untouched.
  const iconlessPlainText =
    detail !== undefined && detail.type === "plain_text" && typeof detail.icon !== "string";
  if (named !== undefined && (detail === undefined || detail.type === "unknown" || iconlessPlainText)) {
    return named;
  }
  if (detail !== undefined && typeof detail.type === "string") {
    return DETAIL_ICONS[detail.type] ?? "Wrench";
  }
  return "Wrench";
}

function str(source: ToolDetail, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/**
 * The failure reason carried by a tool_call item's `error`, or "".
 *
 * The protocol shape is `{ message }` on a failed item and `null` on every
 * other one (`server/timeline.ts` fills `message` with the failed tool's own
 * output, else `"tool failed"`). Read defensively — history replayed from an
 * older daemon, or a payload from a newer one, can carry anything — but an
 * unreadable value yields "" rather than a made-up reason.
 */
function errorTextOf(value: unknown): string {
  if (!isRecord(value)) return "";
  const message = value.message;
  return typeof message === "string" ? message : "";
}

/**
 * Cut a body to {@link BODY_LIMIT} **without splitting a surrogate pair**.
 *
 * `slice` counts UTF-16 code units, so an astral character (an emoji, a rare
 * CJK glyph) straddling the cut leaves a lone high surrogate at the end, which
 * renders as `�` — corruption the reader cannot tell apart from the tool's own
 * output. Stepping back one unit costs at most one character and keeps the
 * text valid.
 */
function truncate(text: string): string {
  if (text.length <= BODY_LIMIT) return text;
  let end = BODY_LIMIT;
  const last = text.charCodeAt(end - 1);
  // A high surrogate at the cut is half of a pair whose low half was dropped.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${localeText().truncated}`;
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

/* -------------------------------------------------------------------------- */
/* Generic fields card (rows with no detail shape)                            */
/* -------------------------------------------------------------------------- */

/**
 * How long a single-line string may be and still read as a fact.
 *
 * A fact is meant to sit beside its key on one line of a phone-width card; past
 * this it is prose, and prose belongs in a text block that may wrap.
 */
const FIELD_FACT_MAX = 60;

/** The scalar form of a value that belongs on a facts row, or undefined. */
function factValue(value: unknown): string | undefined {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // `null` is a value, not an absence: a tool that answered `null` said so.
  if (value === null) return "null";
  if (typeof value === "string" && !value.includes("\n") && value.length <= FIELD_FACT_MAX) {
    return value;
  }
  return undefined;
}

/**
 * One payload value as a card entry.
 *
 * The three shapes are the three things a reader can do with a value: scan it as
 * a fact, read it as prose, or read it as a structure. A value JSON cannot
 * serialize at all (a cycle, a BigInt) keeps `stringifyValue`'s
 * `<unserializable>` wording rather than disappearing from the card.
 */
function fieldEntry(label: string, value: unknown): ToolFieldEntry {
  const fact = factValue(value);
  if (fact !== undefined) return { kind: "fact", label, value: fact };
  if (typeof value === "string") return { kind: "text", label, value };
  return { kind: "json", label, value: stringifyValue(value, true) };
}

/**
 * Split a payload into card entries, in the payload's own key order.
 *
 * A top-level object is split by key; anything else (an array, a bare scalar) is
 * one entry with no label — the payload *is* the value, and inventing a key for
 * it would be a name the wire never had.
 */
function fieldEntries(value: unknown): ToolFieldEntry[] {
  if (!isRecord(value)) return [fieldEntry("", value)];
  return Object.keys(value).map((key) => fieldEntry(key, value[key]));
}

/**
 * The result as a structure, or undefined when the result is not one.
 *
 * A string result is parsed only when it starts like a JSON object/array *and*
 * parses to one: a tool that answers `"42"` or a sentence stays plain text, and
 * a parse failure keeps the original string, byte for byte.
 */
function structuredResult(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a payload carries nothing to split (an argument-less call). */
function emptyPayload(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

/**
 * The row's second half for an `unknown` row: the first short single-line string
 * argument as `key: value`, else the first such result field, else "".
 *
 * The point is that the head never prints a JSON blob again: `{"to":"lead",…}`
 * clipped to one line is unreadable on a phone, while `to: lead` names the call.
 * An empty answer leaves the head to the tool's own label, which is what an
 * argument-less call should look like.
 */
function fieldSummary(input: unknown, result: unknown): string {
  for (const source of [input, result]) {
    if (!isRecord(source)) continue;
    for (const key of Object.keys(source)) {
      const item = source[key];
      if (typeof item !== "string" || item === "" || item.includes("\n")) continue;
      if (item.length > FIELD_FACT_MAX) continue;
      return `${key}: ${item}`;
    }
  }
  return "";
}

/**
 * The generic card's payload and the head summary that goes with it, or null
 * when there is nothing to split.
 *
 * `splitResult` is false for a tool whose result has a card of its own
 * (`create_goal` / `get_goal` / `update_goal` and the `team_task_*` tools): that
 * card's documented fallback is the verbatim body, so its result is left there
 * rather than claimed by this card. Its *arguments* still become entries — the
 * head no longer prints them as JSON, and a failed call has no card at all.
 */
function buildFields(
  input: unknown,
  output: unknown,
  splitResult: boolean,
): { fields: ToolFieldsData; summary: string } | null {
  const args = emptyPayload(input) ? [] : fieldEntries(input);
  const resultValue = splitResult ? structuredResult(output) : undefined;
  const result = resultValue === undefined ? [] : fieldEntries(resultValue);
  if (args.length === 0 && result.length === 0) return null;
  return {
    fields: {
      args,
      result,
      receipt: "",
      // The result half only: the arguments are already visible as entries, and
      // a plain-text result is carried by `body`, whose own card copies it.
      copyText:
        result.length === 0
          ? ""
          : typeof output === "string"
            ? output
            : stringifyValue(output, true),
    },
    summary: fieldSummary(input, resultValue),
  };
}


/* -------------------------------------------------------------------------- */
/* Tool-specific cards (L2)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a tool-specific card replaces in the generic one (L1).
 *
 * A mapping fills only the fields its tool's documented shape supports: an
 * absent field keeps L1's value, so a mapper that knows the head does not drop
 * the arguments the generic card already split. Everything emitted here is
 * derived from the wire payload or from `./locale`; a shape that does not match
 * returns null, and the row falls back to L1 instead of guessing.
 */
export type ToolMapping = {
  /** The head's second half, replacing L1's first-short-argument rule. */
  summary: string;
  args?: ToolFieldEntry[];
  result?: ToolFieldEntry[];
  receipt?: string;
  /** A replacement body (`job_output` strips its status line; a receipt-only output clears it). */
  body?: string;
  /** A replacement copy source, when the body was the only one. */
  copyText?: string;
};

/** One prose entry: the value is drawn verbatim, never re-serialized. */
function proseEntry(label: string, value: string): ToolFieldEntry {
  return { kind: "text", label, value };
}

/** A receipt-shaped output: the one line of text DSH rendered for the model. */
function receiptText(output: unknown): string {
  return typeof output === "string" ? output.trim() : "";
}

/** The last path segment, for a row whose head should not repeat a whole path. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/u).filter((part) => part !== "");
  return parts.length === 0 ? path : parts[parts.length - 1];
}

/**
 * `send_message`'s card.
 *
 * The name has two implementations with different inputs and different results
 * (survey §5): the Team tool (`target`) renders `{"sent":true}`, or the older
 * `{messageId,status}`; the subagent-control tool (`agent_id`) renders the
 * sentence `message delivered to agent <id>`. The *input* decides which one this
 * row is — the tool name is the same for both.
 */
function sendMessageCard(input: unknown, output: unknown, failed: boolean): ToolMapping | null {
  if (failed || !isRecord(input)) return null;
  const message = input.message;
  if (typeof message !== "string") return null;
  const cards = localeText().toolCards;
  // An empty message is a value, not a paragraph: it must not mount an empty
  // prose block (the head still names the recipient, the receipt still answers).
  const args = message === "" ? [] : [proseEntry(cards.labels.message, message)];
  if (typeof input.target === "string" && input.target !== "") {
    const value = structuredResult(output);
    if (!isRecord(value)) return null;
    if (value.sent === true) return { summary: input.target, args, result: [], receipt: cards.sent };
    if (typeof value.messageId === "string" && typeof value.status === "string") {
      return { summary: input.target, args, result: [], receipt: cards.sentWithStatus(value.status) };
    }
    return null;
  }
  if (typeof input.agent_id === "string" && input.agent_id !== "") {
    if (!/^message delivered to agent\b/u.test(receiptText(output))) return null;
    return {
      summary: input.agent_id,
      args,
      result: [],
      receipt: cards.delivered,
      // The sentence *is* the receipt; keeping it in the body would print the
      // same confirmation twice.
      body: "",
      copyText: typeof output === "string" ? output : "",
    };
  }
  return null;
}

/** `interrupt_agent`'s card: the same two implementations as `send_message`. */
function interruptAgentCard(input: unknown, output: unknown, failed: boolean): ToolMapping | null {
  if (failed || !isRecord(input)) return null;
  const cards = localeText().toolCards;
  if (typeof input.target === "string" && input.target !== "") {
    const value = structuredResult(output);
    if (!isRecord(value) || typeof value.previousStatus !== "string") return null;
    return { summary: input.target, args: [], result: [], receipt: cards.interrupted(value.previousStatus) };
  }
  if (typeof input.agent_id === "string" && input.agent_id !== "") {
    if (!/^interrupt requested for agent\b/u.test(receiptText(output))) return null;
    return {
      summary: input.agent_id,
      args: [],
      result: [],
      receipt: cards.interruptRequested,
      body: "",
      copyText: typeof output === "string" ? output : "",
    };
  }
  return null;
}

/**
 * `spawn_teammate`'s card: the name is the subject (`context: fork` marked), the
 * description a fact, the prompt prose, and the created member's own status and
 * model the receipt.
 */
function spawnTeammateCard(input: unknown, output: unknown, failed: boolean): ToolMapping | null {
  if (failed || !isRecord(input)) return null;
  const name = input.name;
  const prompt = input.prompt;
  if (typeof name !== "string" || name === "" || typeof prompt !== "string") return null;
  const value = structuredResult(output);
  if (!isRecord(value) || !isRecord(value.member)) return null;
  const member = value.member;
  if (typeof member.target !== "string" || typeof member.status !== "string") return null;
  const cards = localeText().toolCards;
  const args: ToolFieldEntry[] = [];
  if (typeof input.description === "string" && input.description !== "") {
    args.push({ kind: "fact", label: cards.labels.description, value: input.description });
  }
  args.push(proseEntry(cards.labels.prompt, prompt));
  return {
    summary: input.context === "fork" ? `${name} · ${cards.inheritsContext}` : name,
    args,
    result: [],
    receipt: cards.created(member.status, typeof member.model === "string" ? member.model : ""),
  };
}

/**
 * `wait_agent`'s card: the head carries the duration, the receipt says how the
 * wait ended, and the `noProgress` explanation becomes prose.
 *
 * `timeout_ms` is DSH's own default of 30 000 when omitted
 * (`dsh-experimental-tool-agent-team/lib/index.js:336`); a value outside the
 * documented range is not a shape this card knows, so it falls back to L1.
 */
function waitAgentCard(input: unknown, output: unknown, failed: boolean): ToolMapping | null {
  if (failed) return null;
  const value = structuredResult(output);
  if (!isRecord(value) || typeof value.timedOut !== "boolean") return null;
  const cards = localeText().toolCards;
  const timeout = isRecord(input) ? input.timeout_ms : undefined;
  let summary: string;
  if (timeout === undefined) {
    summary = cards.waitSeconds(30);
  } else if (typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout > 0) {
    summary =
      timeout >= 60000 && timeout % 60000 === 0
        ? cards.waitMinutes(timeout / 60000)
        : cards.waitSeconds(Math.round(timeout / 1000));
  } else {
    return null;
  }
  let receipt = value.timedOut ? cards.timedOut : cards.progressed;
  const result: ToolFieldEntry[] = [];
  if (isRecord(value.noProgress)) {
    const reason = value.noProgress.reason;
    if (typeof reason === "string") {
      // A reason this table does not know stays verbatim: DSH's words are never
      // replaced by a guessed one.
      receipt = `${receipt} · ${reason === "no-active-peer" ? cards.noActivePeer : reason}`;
    }
    const message = value.noProgress.message;
    if (typeof message === "string" && message !== "") result.push(proseEntry("", message));
  }
  return { summary, args: [], result, receipt };
}

/**
 * `list_agents`' card: one line per member instead of one JSON blob.
 *
 * The Lead is listed but not counted: it is the main session, and a row that
 * says 「3 名成员」 while the array holds four entries would be the counting
 * mistake the team pill fixed in `d28b88d` (「成员计数排除主会话」). An old daemon's
 * plain text (`(no subagents)`) is not an array, so it keeps L1's body verbatim.
 */
function listAgentsCard(output: unknown, failed: boolean): ToolMapping | null {
  if (failed) return null;
  const value = structuredResult(output);
  if (!Array.isArray(value)) return null;
  const cards = localeText().toolCards;
  const members: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (typeof item.target !== "string" || typeof item.role !== "string" || typeof item.status !== "string") {
      return null;
    }
    members.push(item);
  }
  if (members.length === 0) return { summary: cards.noMembers, args: [], result: [], receipt: "" };
  const lines = members.map((member) => {
    const target = String(member.target);
    const role = String(member.role);
    // The Lead's own row carries `target: "lead"` and `role: "lead"`; writing it
    // twice reads `lead · lead · running`, so the role is dropped when it is the
    // target's own name.
    const parts = target === role ? [target, String(member.status)] : [target, role, String(member.status)];
    if (typeof member.description === "string" && member.description !== "") parts.push(member.description);
    return parts.join(" · ");
  });
  // Counted on `role === "teammate"`, the same rule as the team pill
  // (`./team-polling`'s `teamMateCount`): the Lead is not a teammate, and a role
  // DSH adds later must not be counted as one by accident.
  const teammates = members.filter((member) => member.role === "teammate").length;
  return {
    summary: teammates === 0 ? cards.leadOnly : localeText().team.memberCount(teammates),
    args: [],
    result: [proseEntry("", lines.join("\n"))],
    receipt: "",
  };
}

/** DSH's status line: `[status: <status>]` / `[status: <status>, <detail>]` (`dsh-tool-jobs/lib/index.js:46`). */
const JOB_STATUS_LINE = /^\[status: ([a-z]+)(?:, (.+))?\]$/u;

/** `exit code: 0` in the reader's words; any other detail DSH rendered stays verbatim. */
function jobDetailText(detail: string, cards: ToolCardsText): string {
  const exit = /^exit code: (-?\d+)$/u.exec(detail.trim());
  return exit === null ? detail : cards.exitCode(exit[1]);
}

/**
 * `job_output`'s card: the trailing `[status: …]` line becomes the receipt, the
 * rest stays the log in the code surface, and the copy control still hands over
 * the complete original output (status line included).
 */
function jobOutputCard(input: unknown, output: unknown, failed: boolean): ToolMapping | null {
  if (failed || !isRecord(input)) return null;
  const jobId = input.job_id;
  if (typeof jobId !== "string" || jobId === "" || typeof output !== "string") return null;
  const lines = output.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  if (end === 0) return null;
  const match = JOB_STATUS_LINE.exec(lines[end - 1].trim());
  if (match === null) return null;
  const cards = localeText().toolCards;
  const status = cards.jobStatuses[match[1]] ?? match[1];
  const detail = match[2] === undefined ? "" : jobDetailText(match[2], cards);
  // The call's own knobs are what a reader needs to interpret the log ("was this
  // a blocking read? how long did it wait?"); the job id is already the head.
  const args: ToolFieldEntry[] = [];
  if (typeof input.wait === "boolean") args.push(fieldEntry("wait", input.wait));
  if (typeof input.timeout_ms === "number") args.push(fieldEntry("timeout_ms", input.timeout_ms));
  return {
    summary: jobId,
    args,
    result: [],
    receipt: detail === "" ? status : `${status} · ${detail}`,
    body: lines.slice(0, end - 1).join("\n").replace(/\n+$/u, ""),
    copyText: output,
  };
}

/** `job_kill`'s card: the job id is the head, DSH's one-line receipt the card. */
function jobKillCard(input: unknown, output: unknown, failed: boolean): ToolMapping | null {
  if (failed || !isRecord(input)) return null;
  const jobId = input.job_id;
  if (typeof jobId !== "string" || jobId === "") return null;
  if (!/^requested cancellation of job\b/u.test(receiptText(output))) return null;
  // The model's reason (60/62 real calls carry one) is the only explanation for
  // *why* the job was killed; L1's own rule decides fact vs prose.
  const reason = input.reason;
  return {
    summary: jobId,
    args: typeof reason === "string" && reason !== "" ? [fieldEntry("reason", reason)] : [],
    result: [],
    receipt: localeText().toolCards.cancellationRequested,
    body: "",
    copyText: typeof output === "string" ? output : "",
  };
}

/**
 * `mcp_call_tool`'s card: the proxied `server/tool` is the subject, and the
 * `arguments` object is split by L1's own rules instead of printed as one blob.
 * The result is left to L1 — the proxied server decides its shape.
 */
function mcpCallToolCard(input: unknown, failed: boolean): ToolMapping | null {
  if (failed || !isRecord(input)) return null;
  const server = input.server;
  const tool = input.tool;
  if (typeof server !== "string" || server === "" || typeof tool !== "string" || tool === "") return null;
  const argsValue = input.arguments;
  if (argsValue !== undefined && !isRecord(argsValue)) return null;
  return {
    summary: `${server}/${tool}`,
    args: isRecord(argsValue) ? fieldEntries(argsValue) : [],
  };
}

/**
 * `read_image`'s card: the head names the file. The image itself is not drawn
 * here — the plugin emits it as its own assistant message
 * (`server/timeline.ts`'s `imageRows`), so drawing it again would duplicate it.
 */
function readImageCard(input: unknown, failed: boolean): ToolMapping | null {
  if (failed || !isRecord(input) || typeof input.file_path !== "string") return null;
  const path = input.file_path.trim();
  if (path === "") return null;
  return { summary: baseName(path) };
}

/**
 * `run_code`'s card: the description titles the row and the program is a code
 * block, not prose — re-wrapping source into prose makes it unreadable.
 */
function runCodeCard(input: unknown, failed: boolean): ToolMapping | null {
  if (failed || !isRecord(input) || typeof input.code !== "string" || input.code === "") return null;
  return {
    summary: typeof input.description === "string" ? input.description : "",
    args: [{ kind: "code", label: localeText().toolCards.labels.code, value: input.code }],
  };
}

/**
 * The tool-specific card for one `unknown` row, or null to keep the generic one.
 *
 * Dispatch is by the wire tool name, and only for the names the shape survey
 * measured (survey §2/§3). A mapper returns null for anything that is not the
 * documented shape — a missing field, a different type, JSON that does not
 * parse — so the row keeps L1's generic card rather than a card drawn from a
 * guess. A failed call never reaches a mapper: a failure must not be rendered
 * as a success receipt, and the existing failure display owns those rows.
 */
function toolMapping(name: string, input: unknown, output: unknown, failed: boolean): ToolMapping | null {
  switch (name) {
    case "send_message":
      return sendMessageCard(input, output, failed);
    case "interrupt_agent":
      return interruptAgentCard(input, output, failed);
    case "spawn_teammate":
      return spawnTeammateCard(input, output, failed);
    case "wait_agent":
      return waitAgentCard(input, output, failed);
    case "list_agents":
      return listAgentsCard(output, failed);
    case "job_output":
      return jobOutputCard(input, output, failed);
    case "job_kill":
      return jobKillCard(input, output, failed);
    case "mcp_call_tool":
      return mcpCallToolCard(input, failed);
    case "read_image":
      return readImageCard(input, failed);
    case "run_code":
      return runCodeCard(input, failed);
    default:
      return null;
  }
}


/**
 * Paseo's own MCP tools, keyed by the part after `mcp__paseo__`.
 *
 * Paseo ships 58 of them and each carries an English `title` in its own
 * registry (`server/agent/tools/paseo-tools.js` and `browser-tools/tools.js`);
 * the labels in `./locale` are those titles. Without this a row reads
 * `mcp__paseo__delete_heartbeat {"id":"…"}` — the wire name, which is the one
 * thing about it a reader cannot use. A name we do not know still falls back to
 * the wire name, so a tool added upstream shows up rather than disappearing.
 */
/** The same tools by icon. */
const PASEO_MCP_ICONS: Record<string, string> = {
  speak: "Volume2",
  create_workspace: "FolderInput",
  list_hosts: "Server",
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
  // The four browser tools with a standard action glyph rather than the page
  // glyph the rest of this family shares. They had no entry at all, so each fell
  // to the wrench and then to Paseo's mark (the coarser fallback); the official
  // catalog gives them labels, and these glyphs say what the call did.
  browser_back: "ArrowLeft",
  browser_forward: "ArrowRight",
  browser_reload: "RotateCw",
  browser_hover: "MousePointer",
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

/**
 * The bare Paseo tool name behind a wire name, or undefined.
 *
 * Mirrors Paseo's own `getPaseoToolLeafName` (it ships in the daemon's web UI
 * bundle, `tools/tool-call-icons`): a Paseo tool arrives three ways —
 * `mcp__paseo__<tool>`, `mcp__paseo_<server>__<tool>`, and the dotted
 * `paseo.<tool>` / `paseo_<server>.<tool>`. Keying only on the first spelling,
 * which is what this used to do, missed the other two and drew a wrench.
 */
function paseoMcpName(name: string): string | undefined {
  const normalized = name.trim().toLowerCase();
  if (normalized.includes("__")) {
    const parts = normalized.split("__").filter((part) => part.length > 0);
    const ours =
      parts.length >= 3 && parts[0] === "mcp" && (parts[1] === "paseo" || parts[1].startsWith("paseo_"));
    return ours ? parts.slice(2).join("__") : undefined;
  }
  if (normalized.includes(".")) {
    const [first] = normalized.split(".");
    if (first !== "paseo" && !first.startsWith("paseo_")) return undefined;
    return normalized.split(".").slice(1).join(".");
  }
  return undefined;
}

/**
 * Whether a tool belongs to Paseo itself.
 *
 * The same rule as `paseoMcpName`, with Paseo's own exception: a `speak` tool is
 * never one of its own (`isPaseoToolName` excludes it there too).
 */
function isPaseoToolName(name: string): boolean {
  const tokens = name.trim().toLowerCase().match(/[a-z0-9]+/g);
  if (tokens !== null && tokens[tokens.length - 1] === "speak") return false;
  return paseoMcpName(name) !== undefined;
}

/** The label for a Paseo MCP tool in the reader's language, or undefined. */
export function paseoMcpLabel(name: string): string | undefined {
  const bare = paseoMcpName(name);
  return bare === undefined ? undefined : localeText().paseoMcpLabels[bare];
}

/** The icon for a Paseo MCP tool, or undefined if we do not know it. */
export function paseoMcpIcon(name: string): string | undefined {
  const bare = paseoMcpName(name);
  return bare === undefined ? undefined : PASEO_MCP_ICONS[bare];
}

/**
 * The Paseo MCP tool a gateway meta-call proxies, as a wire name, or undefined.
 *
 * The bridge's MCP gateway exposes `mcp_list_tools` / `mcp_tool_schema` /
 * `mcp_call_tool` instead of Paseo's ~60 tools (context budget), so the row's
 * tool name is the meta tool and the real target rides in its `arguments`.
 * Without this hop the row kept the generic meta icon/label even though the
 * mapping for the underlying tool exists. Only `mcp_call_tool` proxies a call;
 * the list and schema meta tools stay generic on purpose.
 *
 * A missing `server` means the single server Paseo injected ("paseo"); any other
 * server keeps the generic row, because its tools are not in our tables.
 */
function gatewayPaseoTool(name: string, detail: ToolDetail | undefined): string | undefined {
  if (name.trim().toLowerCase() !== "mcp_call_tool") return undefined;
  if (detail === undefined || detail.type !== "unknown") return undefined;
  const input = detail.input;
  if (!isRecord(input)) return undefined;
  const tool = typeof input.tool === "string" ? input.tool.trim() : "";
  if (tool === "") return undefined;
  const server = typeof input.server === "string" ? input.server.trim().toLowerCase() : "";
  if (server !== "" && server !== "paseo" && !server.startsWith("paseo_")) return undefined;
  return `mcp__paseo__${tool}`;
}

/** The semantic half of a 0.12 agent-to-agent message row. */
interface AgentMessageFacts {
  /** The protocol event, unvalidated: the label table decides what is known. */
  event: unknown;
  /** The sender's title when it has one, else its id, else "". */
  sender: string;
  /** The message text, or undefined when the payload carried none. */
  text: string | undefined;
}

/**
 * Read the semantic half of a 0.12 agent-to-agent message row, or undefined.
 *
 * `item.agentMessage` is the protocol's own projection
 * (`{ event, sender: { id, title? }, text }`), and it is the only place the row
 * learns who sent what: the `plain_text` detail beside it is an echo kept for
 * clients that predate the field. It is read defensively — history replayed from
 * another daemon, or a payload from a newer one, can carry anything — and an
 * object with none of the three fields returns undefined, which leaves the row
 * on the plain-text path it had before 0.12.
 */
function agentMessageOf(value: unknown): AgentMessageFacts | undefined {
  if (!isRecord(value)) return undefined;
  const sender = isRecord(value.sender) ? value.sender : undefined;
  const title = sender !== undefined && typeof sender.title === "string" ? sender.title.trim() : "";
  const id = sender !== undefined && typeof sender.id === "string" ? sender.id.trim() : "";
  const text = typeof value.text === "string" ? value.text : undefined;
  if (value.event === undefined && title === "" && id === "" && text === undefined) return undefined;
  return { event: value.event, sender: title !== "" ? title : id, text };
}

/** DSH's three goal tools, whose results share one shape (`dsh-tool-goal` GOAL_VALUE_SCHEMA). */
const GOAL_TOOLS: ReadonlySet<string> = new Set(["create_goal", "get_goal", "update_goal"]);

function goalCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parse one goal tool result into DSH's card, or return null.
 *
 * A port of `goalDetail` (`dsh-client-ui-tool` lib/client.js:3854-3883), not a
 * reimplementation of its rules: the same required fields, the same phase set,
 * `active` + `disarmed` read as 「等待继续」, and a blocked reason only when it
 * carries a message. Anything else — malformed JSON, an extra phase DSH adds
 * later, a missing count — is null, and null keeps the verbatim body. DSH does
 * the same (`detailsCardModel` falls back to raw input/output). Nothing is
 * dropped quietly: a result this cannot read still shows every byte it had.
 */
export function parseGoalResult(text: string): GoalBlockData | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const copy = localeText().goalCard;
  if (value.goal === null) return { objective: "", fields: [], empty: true };
  const goal = value.goal;
  if (
    !isRecord(goal) ||
    typeof goal.id !== "string" || goal.id === "" ||
    typeof goal.objective !== "string" || goal.objective === "" ||
    !goalCount(goal.revision) || !goalCount(goal.roundsStarted) || !goalCount(goal.maxGoalRounds)
  ) {
    return null;
  }
  const phase = goal.phase;
  if (phase !== "active" && phase !== "paused" && phase !== "blocked" && phase !== "complete") return null;
  if (value.activation !== "armed" && value.activation !== "disarmed") return null;
  const fields = [
    { label: copy.status, value: copy.phases[phase === "active" && value.activation === "disarmed" ? "disarmed" : phase] },
    { label: copy.rounds, value: `${goal.roundsStarted} / ${goal.maxGoalRounds}` },
  ];
  if (goal.blockedReason !== undefined) {
    const reason = goal.blockedReason;
    if (!isRecord(reason) || typeof reason.code !== "string" || reason.code === "" ||
      typeof reason.message !== "string" || reason.message === "") {
      return null;
    }
    fields.push({ label: copy.reason, value: reason.message });
  }
  return { objective: goal.objective, fields, empty: false };
}

const TEAM_TASK_TOOLS: ReadonlySet<string> = new Set(["team_task_create", "team_task_get", "team_task_update", "team_task_list"]);
const TEAM_TOOLS: ReadonlySet<string> = new Set([...TEAM_TASK_TOOLS, "spawn_teammate", "list_agents", "wait_agent", "send_message", "interrupt_agent"]);

function teamCard(view: unknown): TeamTaskCard | null {
  const parsed = teamTaskSchema.strict().safeParse(view);
  if (!parsed.success) return null;
  const task = parsed.data;
  const text = localeText().team;
  // The card's own revision field is in the list too: it is what the model's
  // next compare-and-set will name.
  return { id: task.id, subject: task.subject, mark: teamTaskMark(task), fields: teamTaskFields(task, text), description: task.description };
}

/**
 * Parse one team task tool's result into its card, or null to keep the raw body.
 *
 * Strict on DSH's `TASK_VIEW_SCHEMA` (`additionalProperties: false`): an extra
 * key, a missing key or a status outside the wire's three is null, and the row
 * keeps its JSON — a card drawn from a guessed shape would hide what DSH said.
 */
export function parseTeamResult(name: string, input: unknown, output: string): TeamBlockData | null {
  if (!TEAM_TASK_TOOLS.has(name)) return null;
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  const text = localeText().team;
  if (name === "team_task_list") {
    if (!isRecord(value) || !Array.isArray(value.tasks)) return null;
    const extra = Object.keys(value).filter((key) => key !== "tasks" && key !== "nextCursor");
    if (extra.length > 0 || (value.nextCursor !== undefined && typeof value.nextCursor !== "number")) return null;
    const cards = value.tasks.map(teamCard);
    if (cards.some((card) => card === null)) return null;
    const filters: string[] = [];
    if (isRecord(input)) {
      const status = input.status;
      if (status === "pending" || status === "in_progress" || status === "completed") {
        const word = status === "completed" ? text.marks.done : status === "in_progress" ? text.marks.doing : text.marks.ready;
        filters.push(`${text.fields.status}=${word}`);
      }
      if (typeof input.owner === "string") filters.push(`${text.fields.owner}=${input.owner === "unowned" ? text.card.unownedFilter : input.owner}`);
      if (typeof input.ready === "boolean") filters.push(input.ready ? text.card.readyFilter : text.card.notReadyFilter);
    }
    const caption = [text.card.count(cards.length), filters.length === 0 ? "" : `${text.card.filter} ${filters.join("，")}`]
      .filter((part) => part !== "")
      .join(" · ");
    return { kind: "list", tasks: cards as TeamTaskCard[], caption, more: typeof value.nextCursor === "number" };
  }
  const card = teamCard(value);
  if (card === null) return null;
  const action = name === "team_task_update" && isRecord(input) && typeof input.action === "string" ? input.action : "";
  const caption = action === "" ? "" : `${text.card.action} ${text.card.actions[action] ?? action} · ${card.id}`;
  return { kind: "task", tasks: [card], caption, more: false };
}

/** Normalize one Paseo tool-call item into JSON-safe render data. */
export function toolCallData(
  item: {
    name: string;
    status: string;
    detail: unknown;
    error?: unknown;
    metadata?: unknown;
    /**
     * 0.12's semantic projection of an agent-to-agent message row. The daemon
     * also sends a `plain_text` detail beside it, but that is only an echo
     * older clients understand; the sender, the event and the authoritative
     * text live here.
     */
    agentMessage?: AgentMessage;
  },
  /**
   * The host's streaming phase. Accepted for the transformer's call shape but
   * deliberately **not** carried onto the row: `phase` is not a reliable
   * "still streaming" signal (`./inline-thinking` documents why), so the row
   * derives its running state from `status` plus `./newest`'s position rule.
   * Keeping it in the signature also keeps the transformer call site and the
   * harness's source-level assertion on it unchanged.
   */
  _phase: "streaming" | "complete",
): ToolCallData {
  const detail = (item.detail ?? {}) as ToolDetail;
  const metadata = (item.metadata ?? {}) as ToolDetail;
  const type = str(detail, "type");
  const failed = item.status === "failed";
  // Only a failed row can have a reason. A successful item carries
  // `error: null`, and a dirty payload that carries one anyway must not make a
  // success look like a failure in the block below.
  const error = failed ? errorTextOf(item.error) : "";
  // Copy is read here, once per call, rather than at module load: a locale the
  // host relays later must reach the next row, not only the ones after a reload.
  const copy = localeText();
  // The semantic half of an agent-message row; undefined keeps the pre-0.12
  // plain-text path for every other call (and for a broken payload).
  const agentMessage = agentMessageOf(item.agentMessage);
  // DSH's bash tool requires a model-written `description` for every call and
  // its own UI titles the row with it ("List DSH checkout root"), not with the
  // command. The plugin carries it on the item's provider metadata because the
  // shell detail has no field for it.
  const description = str(metadata, "description");
  // The tool's own subject. It becomes the row's label only when there is no
  // description, and is what the expanded block shows.
  let primary = "";
  let body = "";
  let bodyLabel = copy.bodyLabels.output;
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
      bodyLabel = copy.bodyLabels.output;
      break;
    case "read":
      primary = str(detail, "filePath");
      body = str(detail, "content");
      bodyLabel = copy.bodyLabels.content;
      code = true;
      break;
    case "write":
      primary = str(detail, "filePath");
      body = str(detail, "content");
      bodyLabel = copy.bodyLabels.writeContent;
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
      bodyLabel = copy.bodyLabels.diff;
      diff = true;
      code = true;
      break;
    case "search":
      primary = str(detail, "query");
      body = str(detail, "content");
      bodyLabel = copy.bodyLabels.result;
      code = true;
      break;
    case "fetch":
      primary = str(detail, "url");
      body = str(detail, "result");
      bodyLabel = copy.bodyLabels.response;
      break;
    case "sub_agent":
      primary = str(detail, "description") || str(detail, "subAgentType");
      body = str(detail, "log");
      bodyLabel = copy.bodyLabels.log;
      break;
    case "worktree_setup":
      // Paseo's own daemon appends these rows to the agent timeline when a
      // worktree-isolated workspace is created (`buildSetupTimelineItem` in
      // `@getpaseo/server`'s `worktree-bootstrap.js`), for **any** provider.
      // The app runs every plugin timeline transformer over the whole timeline,
      // so the row lands here even though this provider never emits it. The
      // protocol's `worktree_setup` detail has no `input`/`output`, so the
      // `unknown` fallback below cannot carry it: without this case the row drew
      // an icon over nothing (`{summary:"",headline:"",body:"",hasDetail:false}`).
      primary = str(detail, "branchName") || str(detail, "worktreePath");
      body = str(detail, "log");
      bodyLabel = copy.bodyLabels.log;
      break;
    case "plan":
      primary = copy.planTitle;
      body = str(detail, "text");
      bodyLabel = copy.bodyLabels.plan;
      break;
    case "plain_text":
      // A `/command` row: `label` is the head's second half (the arguments the
      // command ran with) and `text` is what it printed. The old `|| text`
      // fallback derived one from the other, which is wrong in both directions:
      // an argument-less command has an empty `label`, and reading that as "no
      // label" promoted the output into the summary while the block lost it.
      // `todo_write` / `ask_user_question` carry only a label, so they are
      // unaffected — empty is a value here, not an absence.
      primary = str(detail, "label");
      body = str(detail, "text");
      bodyLabel = copy.bodyLabels.output;
      break;
    default:
      primary = "";
      body = "";
      break;
  }

  if (agentMessage !== undefined) {
    // The message's own text is authoritative whatever the echo detail says:
    // `detail.text` happens to carry the same string today, but the field 0.12
    // documents is `agentMessage.text`. A payload with no text keeps the echo,
    // which is still better than a blank row.
    if (agentMessage.text !== undefined) body = agentMessage.text;
    bodyLabel = copy.bodyLabels.message;
    // Prose, not a diff or source code — even if the detail shape would have
    // dispatched to one.
    diff = false;
    code = false;
    detailHeadline = "";
    primary = "";
  }

  if (type === "unknown" && agentMessage === undefined) {
    // Provider-native tools land here — every MCP call, and anything else Paseo
    // has no detail shape for. The row has to carry both halves itself: the
    // arguments it was called with, and whatever came back. Without the output
    // an expanded row showed exactly what it already showed collapsed, which
    // reads as "this row will not expand".
    // A message row is exempt: its text is the payload, not this JSON shape.
    //
    // The arguments are split into the generic card below rather than printed as
    // one JSON blob: pretty-printing put the *whole* payload in a code block, so
    // a string value's newlines arrived as literal `\n` and a long message was
    // one escaped wall of text on a phone. A plain-text result stays the body,
    // verbatim — a string was never escaped here, the escapes came from the
    // enclosing object.
    body = stringifyValue(detail.output);
    bodyLabel = copy.bodyLabels.result;
    code = true;
  }

  // DSH's own block for this call, then the structured card for it. Each parser
  // returns null for anything that is not the documented shape, and null keeps
  // the plain-text body above — a recognisable row, never a blank card.
  //
  // An agent message is prose: it draws the generic block whatever detail shape
  // the daemon happened to send beside it, so no structured parser can claim a
  // card it does not have.
  const kind =
    agentMessage !== undefined ? "generic" : blockKind(type, str(detail, "toolName") || item.name);
  const meta = metaOf(metadata);
  const search = kind === "search" && meta !== undefined ? parseSearch(meta) : null;
  const read = kind === "read" && meta !== undefined ? parseRead(detail, meta) : null;
  const diffBlock = kind === "diff" ? parseDiffBlock(detail, metadata, type) : null;
  const web =
    kind === "web" && meta !== undefined
      ? parseWeb(meta, type === "fetch" ? "fetch" : "search")
      : null;
  if (diffBlock !== null) {
    // A real hunk diff replaces the raw file contents (`write` used to hand the
    // whole file to the diff surface) and the protocol's flat diff alike. It is
    // a unified diff, so `diffStat()` reads its `+A -R` straight off `body`;
    // that is also why this one body is not size-capped — a truncated diff would
    // lose both the stat and the copy.
    body = diffBlock.body;
    bodyLabel = copy.bodyLabels.diff;
    diff = true;
    code = true;
  }

  // The goal tools' card. A failed call never gets one — DSH's own
  // `detailsCardModel` returns null on `isError` too — so a refusal keeps its
  // arguments and text below. A result the parser does not recognise is null and
  // keeps the raw body set above.
  const goal =
    !failed && agentMessage === undefined && type === "unknown" && GOAL_TOOLS.has(item.name) &&
    typeof detail.output === "string"
      ? parseGoalResult(detail.output)
      : null;
  if (goal !== null) {
    // DSH's row summary is the card's title (`DetailsRow`: `items[0].title ??
    // empty`): the objective, not the call's arguments as JSON.
    primary = goal.empty ? copy.goalCard.empty : goal.objective;
    detailHeadline = "";
    body = "";
    code = false;
  }
  // The team task tools' card, the goal card's rule: never on a failed row, and
  // a result the parser does not recognise keeps the raw JSON set above.
  const team =
    !failed && agentMessage === undefined && type === "unknown" && typeof detail.output === "string"
      ? parseTeamResult(item.name, detail.input, detail.output)
      : null;
  if (team !== null) {
    primary = team.kind === "list" ? team.caption : (team.tasks[0]?.subject ?? "");
    detailHeadline = "";
    body = "";
    code = false;
  }
  // The generic card for a row with no detail shape, and the head summary that
  // goes with it. Only the `unknown` rows the goal/team cards did not claim: a
  // more specific card is the right rendering, and drawing both would print the
  // same result twice.
  const generic =
    type === "unknown" && agentMessage === undefined && goal === null && team === null
      ? buildFields(
          detail.input,
          detail.output,
          // A result with its own card keeps that card's verbatim fallback; every
          // other `unknown` result is split into entries.
          !GOAL_TOOLS.has(item.name) && !TEAM_TASK_TOOLS.has(item.name),
        )
      : null;
  let fields = generic === null ? null : generic.fields;
  if (generic !== null) {
    // The head names the call with its first short string argument (`to: lead`),
    // never a clipped JSON blob; when no argument qualifies, the label stands
    // alone. A structured result left the body above — the card's entries are
    // its rendering, and the copy control still carries the whole JSON.
    primary = generic.summary;
    if (generic.fields.result.length > 0) body = "";
  }
  // L2: a tool-specific card replaces parts of the generic one. It only ever
  // claims the shapes the survey measured; a null keeps L1 exactly as it was,
  // and a failed call never reaches the mappers (a failure must not read as a
  // success receipt).
  const mapped =
    type === "unknown" && agentMessage === undefined && goal === null && team === null
      ? toolMapping(item.name, detail.input, detail.output, failed)
      : null;
  if (mapped !== null) {
    primary = mapped.summary;
    if (mapped.body !== undefined) body = mapped.body;
    const args = mapped.args ?? fields?.args ?? [];
    const result = mapped.result ?? fields?.result ?? [];
    const receipt = mapped.receipt ?? "";
    const copyText = mapped.copyText ?? fields?.copyText ?? "";
    // Nothing left to draw (an empty member list, say) drops the card instead
    // of mounting an empty one — the head already carries the answer.
    fields = args.length > 0 || result.length > 0 || receipt !== ""
      ? { args, result, receipt, copyText }
      : null;
  }
  // A failed team tool's DSH sentence, translated when known, DSH's words kept
  // after it (v9 rule); unknown sentences stay verbatim.
  const teamError = failed && TEAM_TOOLS.has(item.name) && error !== "" ? teamToolErrorDisplay(error, copy.team) : undefined;
  // Only a failed row has a code, and only a code `./locale` knows gets words.
  const errorCode = failed ? str(metadata, "errorCode") : "";
  const refusals = copy.goalCard.refusals;
  const refusal = errorCode !== "" && Object.hasOwn(refusals, errorCode) ? refusals[errorCode] : undefined;
  // A row with the generic card has no separate block lead: the card already
  // shows the arguments, and a compact copy of its first fact above the card
  // would be the same line twice.
  const headline = truncate(
    fields !== null
      ? ""
      : detailHeadline !== "" ? detailHeadline : description === "" ? "" : primary,
  );
  const structured =
    search !== null ||
    read !== null ||
    diffBlock !== null ||
    web !== null ||
    goal !== null ||
    team !== null ||
    fields !== null;
  // The daemon hints an agent-message row's glyph with `icon: "bot"`; when that
  // hint is missing the row would fall to the wrench, so a message always reads
  // as an agent's row.
  const rowIcon = toolIcon(item.name, detail);
  const icon = agentMessage !== undefined && rowIcon === "Wrench" ? "Bot" : rowIcon;
  // A Paseo-owned tool with no glyph of its own would draw the generic wrench.
  // Draw Paseo's mark there instead, so it still reads as Paseo's rather than as
  // unknown; a tool we do have a glyph for keeps it (the mark is coarser).
  const paseoMark = icon === "Wrench" && isPaseoToolName(item.name);
  // An agent-message row is titled by what happened ("Agent finished"), and the
  // sender is its second half — the protocol's own display model puts the
  // sender in the summary (`buildAgentMessageDisplay`). Its block carries the
  // message text, so the title is never a repeated subject.
  const label =
    agentMessage === undefined
      ? toolLabel(item.name, detail)
      : agentMessageLabel(agentMessage.event);
  const rawSummary = truncate(
    agentMessage !== undefined
      ? agentMessage.sender
      : mapped !== null
        ? // A mapped card's head wins over the generic `description` rule: the
          // mapper named the subject the reader wants first (a teammate's name,
          // a proxied `server/tool`), and `description` is only a fallback.
          mapped.summary
        : description === "" ? primary : description,
  );
  // The head reads `label · summary`. Two halves saying the same sentence prints
  // the same line twice — every `/command` row did (`/compact · /compact`), and
  // so do Chinese `todo_write` (「更新任务清单 · 更新任务清单」) and
  // `ask_user_question` (「提问 · 提问」). `label` is the row's identity; the
  // summary either adds something or says nothing.
  const summary = rawSummary === label ? "" : rawSummary;

  return {
    name: item.name,
    label,
    icon,
    paseoMark,
    status: (["running", "completed", "failed", "canceled"] as const).includes(
      item.status as ToolCallData["status"],
    )
      ? (item.status as ToolCallData["status"])
      : "completed",
    summary,
    // A block-specific lead (the command of a shell row) always wins: a
    // description must not push the block back to the compact one-line form.
    // Otherwise the block leads with the subject only when the head is showing
    // something else — the description. A row with the generic fields card has
    // no lead of its own (see `headline` above).
    headline,
    // The card decides whether a body is capped, not the block kind: the
    // terminal renders the whole output inside its own 224px scroll region and
    // copies that same string (DSH's `TerminalBlock`), the generic code surface
    // does the same in DSH's 260px `.bodyScroll`, and a real diff replaces the
    // raw body with rows it built itself. Truncating any of those hid the tail
    // of the output and shortened what "copy" handed the user. The one body
    // still capped is the legacy plain-text diff fallback (`diff` with no
    // `diffBlock`), whose card draws one row per line with no scroll region or
    // copy control of its own.
    body: diff && diffBlock === null ? truncate(body) : body,
    bodyLabel,
    diff,
    code,
    failed,
    error,
    // Whether the expanded block has anything to show. A row whose only content
    // is its title still expands — the title wraps to its full width — but must
    // not draw an empty code surface. A structured card counts even when the
    // plain text is empty: the card is the content. A failure reason counts
    // too: that is the only content a failed tool with an empty output has.
    titled: agentMessage !== undefined || description !== "",
    hasDetail: headline !== "" || body !== "" || structured || error !== "",
    kind,
    search,
    read,
    diffBlock,
    web,
    goal,
    team,
    fields,
    errorCode,
    errorShort: refusal?.short ?? (teamError?.original === undefined ? "" : teamError.message),
    errorHint: refusal?.hint ?? (teamError?.original === undefined ? "" : teamError.message),
  };
}
