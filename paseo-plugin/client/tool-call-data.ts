/**
 * Normalize a Paseo tool-call timeline item into JSON-safe render data.
 *
 * Kept free of React and React Native imports so it can be exercised by the
 * offline harness without a host runtime. Every label it produces comes from
 * `./locale`, read at call time rather than baked in at import, so a locale the
 * host relays later takes effect on the next row instead of never.
 *
 * @module dsh-paseo/client/tool-call-data
 */
import { currentLocale, localeText } from "./locale";

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
}

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
  noResults: string;
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
    noResults: "No results found",
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

/** `meta.diffs`, or null when any entry is not the documented shape. */
function parseDiffs(raw: unknown): MetaDiff[] | null {
  if (!Array.isArray(raw)) return null;
  const diffs: MetaDiff[] = [];
  for (const diff of raw) {
    if (
      !isRecord(diff) ||
      typeof diff.path !== "string" ||
      typeof diff.oldText !== "string" ||
      typeof diff.newText !== "string"
    ) {
      return null;
    }
    diffs.push({ path: diff.path, oldText: diff.oldText, newText: diff.newText });
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
};

/**
 * Human label for a tool call, falling back to its raw name.
 *
 * Read through `localeText()` on every call: the tables live in `./locale`, one
 * per language, and a locale relayed after import must apply to the next row.
 */
export function toolLabel(name: string): string {
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
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}${localeText().truncated}` : text;
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
 * the labels in `./locale` are those titles. Without this a row reads
 * `mcp__paseo__delete_heartbeat {"id":"…"}` — the wire name, which is the one
 * thing about it a reader cannot use. A name we do not know still falls back to
 * the wire name, so a tool added upstream shows up rather than disappearing.
 */
const PASEO_MCP_PREFIX = "mcp__paseo__";

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
  // Copy is read here, once per call, rather than at module load: a locale the
  // host relays later must reach the next row, not only the ones after a reload.
  const copy = localeText();
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
    case "plan":
      primary = copy.planTitle;
      body = str(detail, "text");
      bodyLabel = copy.bodyLabels.plan;
      break;
    case "plain_text":
      // A `/command` row: `label` is the line that ran, `text` is what it
      // printed. Taking only the label threw the output away, so a slash
      // command looked like it did nothing.
      primary = str(detail, "label") || str(detail, "text");
      body = primary === str(detail, "text") ? "" : str(detail, "text");
      bodyLabel = copy.bodyLabels.output;
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
    bodyLabel = copy.bodyLabels.result;
    code = true;
  }

  // DSH's own block for this call, then the structured card for it. Each parser
  // returns null for anything that is not the documented shape, and null keeps
  // the plain-text body above — a recognisable row, never a blank card.
  const kind = blockKind(type, str(detail, "toolName") || item.name);
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

  const headline = truncate(
    detailHeadline !== "" ? detailHeadline : description === "" ? "" : primary,
  );
  const structured = search !== null || read !== null || diffBlock !== null || web !== null;

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
    headline,
    body: diffBlock !== null ? body : truncate(body),
    bodyLabel,
    diff,
    code,
    failed,
    // Whether the expanded block has anything to show. A row whose only content
    // is its title still expands — the title wraps to its full width — but must
    // not draw an empty code surface. A structured card counts even when the
    // plain text is empty: the card is the content.
    titled: description !== "",
    hasDetail: headline !== "" || body !== "" || structured,
    kind,
    search,
    read,
    diffBlock,
    web,
  };
}
