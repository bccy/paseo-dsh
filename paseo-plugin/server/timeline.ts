/**
 * DSH session events -> Paseo timeline items.
 *
 * DSH publishes complete message snapshots (`assistant/message`, `tool/call`,
 * `tool/result`) rather than text deltas, and Paseo derives its own live delta
 * from a stable item id. Re-emitting an id therefore updates a row in place.
 *
 * @module dsh-paseo/server/timeline
 */
import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "./dsh-process";
import { LOCALE, UI } from "./locale";

/**
 * Command names `dsh-rewind` registers for the rewind button.
 *
 * The provider runs them itself; the user never types them, so their rows are
 * dropped from the timeline (see `#commandDone`).
 */
const REWIND_COMMAND_NAMES = new Set(["rewind", "undo"]);


interface DshEvent {
  type: string;
  seq?: number;
  [key: string]: unknown;
}

/**
 * The bridge's transient assistant-snapshot event type.
 *
 * DSH's durable `assistant/message` only exists once a step settles, so the
 * bridge subscribes to DSH's per-chunk `agent/assistant-stream` frames, folds
 * them into a growing snapshot, and forwards it under this type over the same
 * `session.event` envelope. It is a middle-layer frame: never appended to a
 * session log, never seen by history replay.
 */
const ASSISTANT_DELTA_EVENT = "paseo/assistant-delta";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { value: raw };
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

/*
 * Paseo's markdown-image source rules, ported verbatim from the host's own
 * provider-image-output.js (`renderProviderImageOutputAsAssistantMarkdown`).
 *
 * A provider draws a picture by emitting an `assistant_message` whose text is a
 * markdown image; the host then fetches the bytes itself over its file RPC. The
 * source has to be a URI it understands: an absolute path becomes `file://` plus
 * the path with **each segment** `encodeURIComponent`-ed — a space in a
 * directory name would otherwise split the destination — and Windows paths get
 * their drive/UNC forms. Keeping these byte-for-byte equivalent to the host is
 * the whole point: this is a copy of an existing shape, not a new one.
 */

/** Escape an image's alt text the way the host does (`\` and `]`). */
function escapeMarkdownImageAlt(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

/** Percent-encode a path segment by segment, leaving the separators alone. */
function encodeFilePath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** The `file:` URI for a Windows path (drive letter or UNC share), or undefined. */
function windowsFileUri(value: string): string | undefined {
  const isWindowsNetworkPath = value.startsWith("\\\\");
  let normalizedPath = value.replace(/\\/g, "/");
  if (/^\/\/\?\/UNC\//i.test(normalizedPath)) {
    normalizedPath = `//${normalizedPath.slice(8)}`;
  } else if (/^\/\/\?\/[A-Za-z]:\//.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice(4);
  }
  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    const drive = normalizedPath.slice(0, 2);
    return `file:///${drive}${encodeFilePath(normalizedPath.slice(2))}`;
  }
  if (isWindowsNetworkPath && normalizedPath.startsWith("//")) {
    return `file:${encodeFilePath(normalizedPath)}`;
  }
  return undefined;
}

/** An absolute host path as a markdown image source (`file://` + encoding). */
function markdownImageSource(value: string): string {
  const windowsUri = windowsFileUri(value);
  if (windowsUri !== undefined) return windowsUri;
  if (value.startsWith("/")) return `file://${encodeFilePath(value)}`;
  return value;
}

/** As {@link markdownImageSource}, plus the host's `)` escaping for markdown. */
function escapeMarkdownImageSource(value: string): string {
  return markdownImageSource(value).replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

/**
 * One picture row per image block the bridge stamped with a `hostPath`.
 *
 * The bridge appends `hostPath` — the attachment's durable absolute path — to
 * each `{type:"image", attachment}` block of a `tool/result` (see
 * `dsh-bridge/lib/image-host-path.js`); a block without one produces no row at
 * all, so the tool result's own text stays the only trace of it rather than an
 * empty picture with no source.
 *
 * `alt` is the attachment's own file name, run through the host's escaping rule,
 * falling back to `Image` when DSH recorded none.
 *
 * The id is derived from the call and the block's position **on purpose**:
 * Paseo folds a snapshot into the row it already has only while the id (and
 * `messageId`) match, so replaying the same log emits the same id and the same
 * text — which the host drops as an empty delta. That dedup is accepted
 * behaviour, never a reason to randomize the id (`mapTimelineItem`:
 * `text.startsWith(previousText) ? slice : text`, and an empty delta returns
 * null).
 */
function imageRows(callId: string, content: unknown): Array<{ id: string; text: string }> {
  if (!Array.isArray(content)) return [];
  const rows: Array<{ id: string; text: string }> = [];
  content.forEach((block, index) => {
    if (!isRecord(block) || block.type !== "image") return;
    const hostPath = stringField(block, "hostPath");
    if (hostPath === undefined) return;
    const attachment = isRecord(block.attachment) ? block.attachment : {};
    const alt = escapeMarkdownImageAlt(stringField(attachment, "name") ?? "Image");
    rows.push({
      id: `image:${callId}:${index}`,
      text: `![${alt}](${escapeMarkdownImageSource(hostPath)})`,
    });
  });
  return rows;
}

/**
 * The questions an `ask_user_question` call asked, and the answers it settled
 * with.
 *
 * Paseo's own Codex adapter writes both into this row's text, and the questions
 * are the only durable record there is: the permission card is transient and is
 * never replayed, so without this a reopened session could not say what was
 * asked or what was chosen. The answers are the result's JSON body —
 * `{"answers":[{"id","selected","custom"}]}`, the shape DSH's own
 * `user-questions` package reads back.
 */
function askedAndAnswered(input: Record<string, unknown>, output: string | undefined): string {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const asked = questions
    .map((question) => {
      if (!isRecord(question)) return "";
      const head = stringField(question, "header") ?? stringField(question, "id") ?? "";
      const prompt = stringField(question, "question") ?? "";
      const labels = Array.isArray(question.options)
        ? question.options
            .map((option) => (isRecord(option) ? stringField(option, "label") : undefined))
            .filter((label): label is string => label !== undefined)
        : [];
      const lines = [head === "" ? prompt : `${head}: ${prompt}`];
      if (labels.length > 0) lines.push(`Options: ${labels.join(", ")}`);
      return lines.join("\n");
    })
    .filter((text) => text !== "")
    .join("\n\n")
    .trim();
  const answers = answerLines(output);
  if (asked === "") return answers ?? "";
  return answers === undefined ? asked : `${asked}\n\nAnswers:\n${answers}`;
}

/** `id: selected, …` lines from an answer batch, when the result carried one. */
function answerLines(output: string | undefined): string | undefined {
  if (output === undefined || output === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.answers)) return undefined;
  const lines = parsed.answers
    .map((answer) => {
      if (!isRecord(answer)) return "";
      const id = stringField(answer, "id") ?? "";
      const selected = Array.isArray(answer.selected)
        ? answer.selected.filter((value): value is string => typeof value === "string")
        : [];
      const custom = stringField(answer, "custom");
      const values = custom === undefined ? selected : [...selected, custom];
      return `${id}: ${values.join(", ")}`;
    })
    .filter((line) => line !== "");
  return lines.length === 0 ? undefined : lines.join("\n");
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Paseo's tool detail, as the protocol defines it.
 *
 * DSH's `presentationMeta` (`tool/result` → `data.meta`) is the only copy of the
 * structured result there is: numbered `read` lines, hunk-level diffs, matches
 * grouped by file, web sources, the `write` operation. It does **not** ride on
 * this detail. The plugin subprocess runs every outgoing event through
 * `ProviderEventSchema.parse(...)` (`@getpaseo/plugin/dist/server/provider.js`),
 * and `toolCallDetailSchema`'s members are all `.strip()` — an unknown `detail.meta`
 * is deleted at that boundary, silently. It travels on the item's own
 * `metadata` instead (see {@link toolMetadata}), which is a `jsonObjectSchema`
 * and survives the parse. The protocol fields that *do* exist are filled here as
 * well — see {@link withPresentationMeta} — so Paseo's stock `read`/`search`/
 * `fetch` rendering keeps working off the same result.
 */
export type ToolDetail = ProviderToolCallDetail;

/** One member of {@link ToolDetail}, for filling its protocol fields in place. */
type ToolDetailOf<T extends ProviderToolCallDetail["type"]> = Extract<
  ProviderToolCallDetail,
  { type: T }
>;

/**
 * The `metadata` key DSH's raw result meta travels under.
 *
 * A literal rather than a shared import: the server half and the client half are
 * compiled and shipped separately (the client bundle is platform-neutral and
 * cannot import this file), so the one thing they must agree on is the string.
 * `harness/tool-call-check.cjs` reads both sources and asserts they match.
 */
export const PRESENTATION_META_KEY = "presentationMeta";

/** `meta.lines` of a DSH `read` result, or undefined for any other shape. */
function metaLines(meta: Record<string, unknown>): Array<{ number: number; text: string }> | undefined {
  if (!Array.isArray(meta.lines)) return undefined;
  const lines: Array<{ number: number; text: string }> = [];
  for (const line of meta.lines) {
    if (!isRecord(line) || typeof line.number !== "number" || typeof line.text !== "string") {
      return undefined;
    }
    lines.push({ number: line.number, text: line.text });
  }
  return lines;
}

/** `meta.files` of a DSH `grep` result: matched lines grouped by file. */
function metaMatchFiles(
  meta: Record<string, unknown>,
): Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }> | undefined {
  if (!Array.isArray(meta.files)) return undefined;
  const files: Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }> = [];
  for (const file of meta.files) {
    if (!isRecord(file) || typeof file.path !== "string" || !Array.isArray(file.matches)) return undefined;
    const matches: Array<{ lineNumber: number; line: string }> = [];
    for (const match of file.matches) {
      if (!isRecord(match) || typeof match.lineNumber !== "number" || typeof match.line !== "string") {
        return undefined;
      }
      matches.push({ lineNumber: match.lineNumber, line: match.line });
    }
    files.push({ path: file.path, matches });
  }
  return files;
}

/**
 * `meta.diffs` of a DSH `edit`/`write` result: hunk-level replacements with
 * context. `write` sends `[]` for a create, which is a valid list.
 */
function metaDiffs(
  meta: Record<string, unknown>,
): Array<{ path: string; oldText: string; newText: string }> | undefined {
  if (!Array.isArray(meta.diffs)) return undefined;
  const diffs: Array<{ path: string; oldText: string; newText: string }> = [];
  for (const diff of meta.diffs) {
    if (
      !isRecord(diff) ||
      typeof diff.path !== "string" ||
      typeof diff.oldText !== "string" ||
      typeof diff.newText !== "string"
    ) {
      return undefined;
    }
    diffs.push({ path: diff.path, oldText: diff.oldText, newText: diff.newText });
  }
  return diffs;
}

/**
 * `meta.sources` of a DSH `web_search` result as Paseo's `webResults`.
 *
 * DSH's source title is optional; Paseo's `webResults` requires one, and an
 * empty link text would read as a broken row, so an untitled source falls back
 * to its URL. The source itself still rides in `meta` untouched.
 */
function metaSources(meta: Record<string, unknown>): Array<{ title: string; url: string }> | undefined {
  if (!Array.isArray(meta.sources)) return undefined;
  const sources: Array<{ title: string; url: string }> = [];
  for (const source of meta.sources) {
    if (!isRecord(source) || typeof source.url !== "string") return undefined;
    const title = stringField(source, "title") ?? source.url;
    sources.push({ title, url: source.url });
  }
  return sources;
}

/**
 * Fold DSH's `presentationMeta` into a tool detail.
 *
 * Two halves, in this order:
 *   1. Fill the protocol fields Paseo already defines for this kind of result —
 *      `offset`, `filePaths`, `numFiles`, `numMatches`, `truncated`, `mode`,
 *      `webResults`, `code` — so the stock row keeps rendering.
 *   2. Hand the raw meta back, for `metadata.presentationMeta` to carry: line
 *      numbers and `lang`, hunk diffs, grouped matches, sources' snippets are
 *      all things the closed detail union cannot express.
 *
 * It deliberately does **not** return the meta on the detail: `detail.meta` is
 * stripped by `ProviderEventSchema.parse` before the event leaves this process
 * (see {@link ToolDetail}), so a field written there never reaches the client.
 *
 * A meta whose shape does not match its tool is *reported*, never swallowed:
 * the row keeps the plain result text and loses only structure it never had. An
 * absent meta is the normal case for a failed tool and for DSH's `bash`, which
 * declares no `presentationMeta` at all — that is not a mismatch. The verbatim
 * meta still travels even when a shape did not match, so the client half — which
 * owns the fallback — is the one that decides.
 */
function withPresentationMeta(
  detail: ToolDetail,
  name: string,
  meta: unknown,
  warn: (line: string) => void,
): { detail: ToolDetail; presentationMeta: JsonValue | undefined } {
  if (meta === undefined || meta === null) return { detail, presentationMeta: undefined };
  if (!isRecord(meta)) {
    warn(`meta: ${name} returned a non-object presentation meta (${typeof meta}); kept the plain result text`);
    return { detail, presentationMeta: undefined };
  }
  const out: ToolDetail = { ...detail };
  const unmatched = (expected: string): void => {
    warn(`meta: ${name} returned an unrecognized presentation meta (expected ${expected}); kept the plain result text`);
  };
  switch (detail.type) {
    case "read": {
      // {path, offset, lines:[{number,text}], totalLines, lang?}
      if (metaLines(meta) === undefined || typeof meta.totalLines !== "number") {
        unmatched("path/offset/lines[]/totalLines");
        break;
      }
      const read = out as ToolDetailOf<"read">;
      if (typeof meta.offset === "number") read.offset = meta.offset;
      break;
    }
    case "edit": {
      // {diffs:[{path, oldText, newText}]} — hunk-level, with context lines.
      if (metaDiffs(meta) === undefined) unmatched("diffs[]");
      break;
    }
    case "write": {
      // {operation:"create"|"update", diffs:[{path, oldText, newText}]}
      // A create carries `diffs: []` — an empty list is a valid create, not a
      // mismatched shape.
      const operation = meta.operation;
      if ((operation !== "create" && operation !== "update") || metaDiffs(meta) === undefined) {
        unmatched("operation/diffs[]");
      }
      break;
    }
    case "search": {
      const search = out as ToolDetailOf<"search">;
      if (detail.toolName === "web_search") {
        // {sources:[{url, title?}], truncated, answer?}
        const sources = metaSources(meta);
        if (sources === undefined || typeof meta.truncated !== "boolean") {
          unmatched("sources[]/truncated");
          break;
        }
        if (sources.length > 0) search.webResults = sources;
        search.truncated = meta.truncated;
        break;
      }
      if (meta.shape === "matches") {
        // grep: {shape:"matches", files:[{path,matches:[{lineNumber,line}]}], truncated, total}
        // `total` counts every parsed match; the groups hold what survived the
        // inline and meta caps, which is what `numMatches` reports.
        const files = metaMatchFiles(meta);
        if (files === undefined || typeof meta.total !== "number") {
          unmatched('shape:"matches"/files[]/total');
          break;
        }
        if (files.length > 0) search.filePaths = files.map((file) => file.path);
        search.numFiles = files.length;
        search.numMatches = files.reduce((sum, file) => sum + file.matches.length, 0);
        search.mode = "content";
        if (typeof meta.truncated === "boolean") search.truncated = meta.truncated;
        break;
      }
      if (meta.shape === "paths") {
        // glob: {shape:"paths", paths:[...], truncated, total}
        if (!isStringArray(meta.paths) || typeof meta.total !== "number") {
          unmatched('shape:"paths"/paths[]/total');
          break;
        }
        if (meta.paths.length > 0) search.filePaths = meta.paths;
        search.numFiles = meta.paths.length;
        search.mode = "files_with_matches";
        if (typeof meta.truncated === "boolean") search.truncated = meta.truncated;
        break;
      }
      unmatched('shape:"matches"|"paths"');
      break;
    }
    case "fetch": {
      // {url, statusCode, truncated} — `url` is the final URL after redirects.
      if (typeof meta.url !== "string" || typeof meta.statusCode !== "number") {
        unmatched("url/statusCode");
        break;
      }
      const fetch = out as ToolDetailOf<"fetch">;
      fetch.url = meta.url;
      fetch.code = meta.statusCode;
      break;
    }
    case "unknown": {
      // `read_image` is the only DSH tool that lands here carrying a meta: {path}.
      if (name === "read_image" && typeof meta.path !== "string") unmatched("path");
      break;
    }
    default:
      // `shell` (DSH's bash declares no `presentationMeta`), `plan`,
      // `plain_text`, `sub_agent`: no protocol field to fill. The raw meta still
      // rides along on the item's metadata for a renderer that knows what to do
      // with it.
      break;
  }
  return { detail: out, presentationMeta: meta as JsonValue };
}

/**
 * Provider metadata for one tool call.
 *
 * Three entries, and every tool-call item carries the first two:
 *
 * - `description`: DSH's bash tool requires a model-written description on every
 *   call, and DSH's own UI titles the row with it rather than with the command.
 *   Paseo's `shell` detail has no field for it, so it rides here, and the client
 *   reads it back in `toolCallData`.
 * - `locale`: the language this process resolved (`server/locale.ts`). The
 *   client half cannot resolve one for itself — the bundle is compiled for a
 *   `neutral` platform with no `define`, so `process.env` is unreachable, and
 *   the host app's own i18n is not a plugin export. `metadata` is the protocol's
 *   one free-form provider-owned passthrough, so the resolved locale travels on
 *   every row rather than being asked for again.
 * - `presentationMeta`: DSH's raw `data.meta`, verbatim, on the completed row
 *   only. It cannot live on `detail` (the schema strips unknown detail fields —
 *   see {@link ToolDetail}); `metadata` is a `jsonObjectSchema` and crosses the
 *   process boundary intact. The client half validates the shape and falls back
 *   to the plain result text when it does not match.
 *
 * Every item, not just the first: the client adopts the locale while
 * transforming a row, and React never re-renders a row that already
 * transformed. A session whose only row arrived before the hint would keep the
 * client's default for good, which is why a bare `{ locale }` is a *complete*
 * metadata rather than something the caller may skip.
 */
function toolMetadata(
  input: Record<string, unknown>,
  presentationMeta?: JsonValue,
): Record<string, JsonValue> {
  const description = stringField(input, "description");
  return {
    ...(description === undefined || description === "" ? {} : { description }),
    locale: LOCALE,
    ...(presentationMeta === undefined ? {} : { [PRESENTATION_META_KEY]: presentationMeta }),
  };
}

/**
 * The locale hint on its own, for a tool-call item that has no arguments to read
 * a description from (a `/command` row) and no result meta yet.
 */
function localeMetadata(): Record<string, JsonValue> {
  return { locale: LOCALE };
}

/**
 * The query list DSH's `web_search` takes (`queries: string[]`, 1..N merged).
 *
 * DSH titles its own search card with `args.queries.join(", ")`. Paseo's search
 * detail has a single-line `query`, so each query contributes its first line and
 * the parts join with that same separator. Returns undefined for anything that
 * is not a non-empty array of non-empty strings, so the caller can fall through
 * to its other candidate fields.
 */
function queryList(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parts = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.split("\n")[0].trim())
    .filter((item) => item !== "");
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * Map one DSH tool call onto the richest Paseo tool detail available.
 *
 * Built from the call's arguments and its rendered result text only; DSH's
 * structured result metadata is folded in separately by
 * {@link withPresentationMeta}, because it belongs to the result event rather
 * than to the call.
 */
function toolDetail(name: string, input: Record<string, unknown>, output?: string): ToolDetail {
  const filePath = stringField(input, "file_path") ?? stringField(input, "filePath");
  switch (name) {
    case "bash":
    case "pwsh": {
      const command = stringField(input, "command") ?? "";
      // `exitCode` is in the protocol, but DSH cannot fill it today: its bash
      // tool declares no `presentationMeta` (0 of 1836 real bash results carry
      // one) and no DSH tool takes an `exit_code` argument, so the read below
      // never matches. Kept for a provider/tool that does report one — do not
      // mistake it for a working data source.
      const exitCode = typeof input.exit_code === "number" ? input.exit_code : undefined;
      return {
        type: "shell",
        command,
        ...(stringField(input, "cwd") === undefined ? {} : { cwd: stringField(input, "cwd") as string }),
        ...(output === undefined ? {} : { output }),
        ...(exitCode === undefined ? {} : { exitCode }),
      };
    }
    case "read":
      return {
        type: "read",
        filePath: filePath ?? "",
        ...(output === undefined ? {} : { content: output }),
        ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      };
    case "write":
      return {
        type: "write",
        filePath: filePath ?? "",
        ...(typeof input.content === "string" ? { content: input.content } : {}),
      };
    case "edit":
      return {
        type: "edit",
        filePath: filePath ?? "",
        ...(typeof input.old_string === "string" ? { oldString: input.old_string } : {}),
        ...(typeof input.new_string === "string" ? { newString: input.new_string } : {}),
      };
    case "grep":
    case "glob":
    case "web_search":
      return {
        type: "search",
        // `pattern` stays first: it is what grep/glob carry. `web_search` has no
        // string query at all — DSH passes `queries: string[]` — which is why
        // this row used to come out with an empty query.
        query:
          stringField(input, "pattern") ??
          stringField(input, "query") ??
          queryList(input.queries) ??
          stringField(input, "path") ??
          "",
        toolName: name === "web_search" ? "web_search" : name,
        ...(output === undefined ? {} : { content: output }),
      };
    case "web_fetch":
      return {
        type: "fetch",
        url: stringField(input, "url") ?? "",
        ...(output === undefined ? {} : { result: output }),
      };
    case "todo_write":
      return { type: "plain_text", label: UI.toolLabels.updateTasks, icon: "sparkles" };
    case "ask_user_question":
      // Paseo's own Codex adapter fills this row's text with the prompts *and*
      // the answers (`mapCodexQuestionRequestToToolCall`). Without them the row
      // expands onto nothing, and — because the permission card is transient and
      // never replayed — a reopened session could not say what was asked or what
      // was chosen. Both halves are already in hand: the questions ride on the
      // call's arguments, the answers are the result's JSON body.
      return {
        type: "plain_text",
        label: UI.toolLabels.askedUser,
        icon: "sparkles",
        text: askedAndAnswered(input, output),
      };
    case "exit_plan_mode":
      // Paseo renders this as the readable plan card, and its own Codex adapter
      // emits the same item next to the approval buttons. The plan has to be
      // visible *before* the choice, so this is the copy that carries it.
      return { type: "plan", text: stringField(input, "plan") ?? "" };
    case "subagent":
      return {
        type: "sub_agent",
        ...(stringField(input, "description") === undefined
          ? {}
          : { description: stringField(input, "description") as string }),
        log: output ?? "",
      };
    case "worktree_setup":
      // Paseo's protocol *does* have a typed `worktree_setup` detail (its Codex
      // provider emits one), and this is the one place that must not emit it.
      //
      // The client half replaces the drawing of every tool row, and its
      // `toolCallData` switch has no case for that type: an unhandled type falls
      // to a `default` that leaves the summary, headline and body empty, while
      // the raw-argument fallback is gated on `type === "unknown"`. So a typed
      // `worktree_setup` renders as an icon over nothing — measured
      // `{summary:"",headline:"",body:"",hasDetail:false}`. Folding it into
      // `unknown` is what keeps the row readable, and it costs nothing: DSH has
      // no such tool (it is not among the 62 tool names real sessions carry), so
      // this branch only has to hold the invariant "no detail type the client
      // cannot draw". Whatever `presentationMeta` DSH sends still rides along
      // on the item's `metadata.presentationMeta` via
      // {@link withPresentationMeta} — a shape it does not recognize warns
      // rather than throwing — so a client that learns the typed shape later has
      // the raw result to read.
      return {
        type: "unknown",
        input: input as unknown as JsonValue,
        output: (output ?? null) as JsonValue,
      };
    default:
      return {
        type: "unknown",
        input: input as unknown as JsonValue,
        output: (output ?? null) as JsonValue,
      };
  }
}

/** Extract `todo_write` items into Paseo's native todo row. */
function todoItems(input: Record<string, unknown>): Array<{ text: string; completed: boolean }> | null {
  const raw = input.todos;
  if (!Array.isArray(raw)) return null;
  const items = raw
    .filter(isRecord)
    .map((todo) => ({
      text:
        stringField(todo, "content") ?? stringField(todo, "text") ?? stringField(todo, "activeForm") ?? "",
      completed: todo.status === "completed",
    }))
    .filter((todo) => todo.text !== "");
  return items.length === 0 ? null : items;
}

export class TimelineBuilder {
  #items = new Map<string, ProviderTimelineItem>();
  #toolNames = new Map<string, string>();
  #toolInputs = new Map<string, Record<string, unknown>>();
  /** commandId -> the command that ran, so `command/done` can title its own row. */
  #commands = new Map<string, { name: string; args: string }>();
  /**
   * Where an unrecognized `presentationMeta` is reported.
   *
   * The plugin passes its session log here; the bare default still prints, so a
   * shape that stops matching is never silent just because a caller forgot.
   */
  readonly #warn: (line: string) => void;
  /**
   * Tool calls that are still running.
   *
   * A turn that ends with entries here means no `tool/result` is coming — an
   * aborted turn takes the process with it. Left alone the row stays `running`
   * forever, and the client pulses a running row without any window, so it
   * blinks for the rest of the session's life and on every replay.
   */
  #runningTools = new Set<string>();
  /**
   * `compactionId`s whose completed marker is already out.
   *
   * The bracket is `start` (Paseo `loading`) → `summary` (completed) → `end`.
   * Only the summary draws the completed state; an `end` for an id that already
   * got it is dropped, and the entry is removed together with it, which keeps a
   * replay of the same log byte-for-byte repeatable. **A second `completed` for
   * the same bracket is the one thing that must never happen** — see
   * {@link #compaction}.
   */
  #summarizedCompactions = new Set<string>();

  /**
   * `compactionId` -> trigger for markers still in Paseo's `loading` state.
   *
   * A log that stops on `compaction/start` (the process was killed mid-way)
   * would otherwise leave a row that pulses forever — Paseo's client pulses a
   * loading marker with no time window. {@link settleLoadingCompactions} closes
   * those, the same way {@link settleRunningTools} closes a tool whose result
   * never arrived. The trigger is kept beside the id so the settling row carries
   * the same reading the loading one did.
   */
  #loadingCompactions = new Map<string, "manual" | "auto">();

  /**
   * `commandId`s a compaction took over.
   *
   * A `/compact` writes both a `command/*` bracket and a `compaction/*` one, and
   * the compaction marker *is* that command's row: showing the command as well
   * prints two rows for one action. The link is DSH's own
   * (`compaction.sourceCommandId === command.commandId`), never the command name
   * — see {@link #commandDone}.
   */
  #compactionCommands = new Set<string>();

  constructor(options: { warn?: (line: string) => void } = {}) {
    this.#warn = options.warn ?? ((line) => console.warn(line));
  }

  /**
   * Fold one DSH session event into zero or more complete Paseo item snapshots.
   *
   * The wire envelope is `{ type, seq, time, data }`, so every handler reads the
   * `data` payload rather than the envelope itself.
   */
  consume(event: DshEvent): ProviderTimelineItem[] {
    const data = isRecord(event.data) ? event.data : {};
    // The bridge's own transient frame, not a DSH durable event: a growing
    // snapshot of the step in flight, carrying the same turn/step the durable
    // `assistant/message` will, so both fold into the same item id.
    if (event.type === ASSISTANT_DELTA_EVENT) return this.#assistantDelta(data);
    switch (event.type) {
      case "assistant/message":
        return this.#assistantMessage(data);
      case "tool/call":
        return this.#toolCall(data);
      case "tool/result":
        return this.#toolResult(data);
      case "command/run":
        return this.#commandRun(data);
      case "command/done":
        return this.#commandDone(data);
      // DSH's open bracket. Paseo's marker has a real `loading` state, and the
      // host merges the completed copy into it in place — see `#compaction`.
      case "compaction/start":
        return this.#compaction(data, "start");
      // Both close the compaction: `compaction/summary` once the summary is
      // durable (the replacement `user/message` follows it), `compaction/end` as
      // the closing marker. Whichever arrives is enough, so a log that stops
      // between the two still gets its completed row.
      case "compaction/summary":
        return this.#compaction(data, "summary");
      case "compaction/end":
        return this.#compaction(data, "end");
      case "turn/end":
        return this.#turnEnd(data);
      default:
        return [];
    }
  }

  /**
   * Close every tool call still running because no `turn/end` will ever arrive.
   *
   * The same closure {@link #turnEnd} performs, exposed for a replay whose
   * stored log simply stops: a killed process leaves a running tool row behind,
   * and Paseo's client pulses a running row with no time window, so without this
   * it blinks for the rest of the session and on every reopen. Idempotent — a
   * closed row leaves the running set.
   */
  settleRunningTools(): ProviderTimelineItem[] {
    return this.#cancelRunningTools();
  }

  /**
   * Close compaction markers a replay left in Paseo's `loading` state.
   *
   * The same replay problem {@link settleRunningTools} solves: a process killed
   * between `compaction/start` and its close leaves a marker that never flips,
   * and Paseo's client pulses a loading marker with no time window. The protocol
   * has no "canceled" compaction, so the honest-looking single row is the
   * completed one — and this is reported, because the compaction really did not
   * finish. Idempotent: a settled id leaves the set.
   *
   * Only ever called for a replayed log whose owner is gone; a compaction still
   * in flight in this process has not emitted its start yet at replay time.
   */
  settleLoadingCompactions(): ProviderTimelineItem[] {
    const out: ProviderTimelineItem[] = [];
    for (const [compactionId, trigger] of [...this.#loadingCompactions]) {
      this.#loadingCompactions.delete(compactionId);
      this.#warn(
        `compaction: the replayed log ends with ${compactionId} still loading ` +
          `(the process was killed mid-compaction?); closing the marker as completed ` +
          `so the row does not pulse forever`,
      );
      out.push(...this.#put(this.#compactionItem(compactionId, "completed", trigger)));
    }
    return out;
  }

  #put(item: ProviderTimelineItem): ProviderTimelineItem[] {
    if (item.type === "tool_call") {
      if (item.status === "running") this.#runningTools.add(item.callId);
      else this.#runningTools.delete(item.callId);
    }
    this.#items.set(item.id, item);
    return [item];
  }

  #assistantMessage(data: Record<string, unknown>): ProviderTimelineItem[] {
    const message = isRecord(data.message) ? data.message : undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return [];
    const turn = typeof data.turn === "number" ? data.turn : 0;
    const step = typeof data.step === "number" ? data.step : 0;
    const out: ProviderTimelineItem[] = [];

    const reasoning = content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "reasoning")
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter((text) => text !== "")
      .join("\n");
    if (reasoning !== "") {
      out.push(
        ...this.#put({
          type: "reasoning",
          id: `reasoning:${turn}:${step}`,
          text: reasoning,
        }),
      );
    }

    const text = textOf(content);
    if (text !== "") {
      // `messageId` is the item id, never DSH's per-message uuid: Paseo folds
      // the live snapshots and this durable copy into one growing row only
      // while `messageId` is identical across them.
      const id = `assistant:${turn}:${step}`;
      out.push(...this.#put({ type: "assistant_message", id, messageId: id, text }));
    }

    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool-call") continue;
      const callId = stringField(block, "id") ?? `tool:${turn}:${step}`;
      const name = stringField(block, "name") ?? "tool";
      const input = parseArguments(block.arguments);
      this.#toolNames.set(callId, name);
      this.#toolInputs.set(callId, input);
      out.push(...this.#emitToolCall(callId, name, input, "running"));
    }
    return out;
  }

  /**
   * Fold one live snapshot from the bridge's transient assistant stream.
   *
   * The bridge assembles DSH's per-chunk frames into a growing step snapshot
   * and sends it before the durable `assistant/message` exists. The ids match
   * the durable items exactly and `messageId` equals the assistant id, because
   * Paseo turns a same-id snapshot into the prefix delta of one growing row
   * only while those agree — a differing `messageId` would start a second row
   * and duplicate the text once the durable copy arrives.
   */
  #assistantDelta(data: Record<string, unknown>): ProviderTimelineItem[] {
    const turn = typeof data.turn === "number" ? data.turn : undefined;
    const step = typeof data.step === "number" ? data.step : undefined;
    if (turn === undefined || step === undefined) return [];

    const out: ProviderTimelineItem[] = [];
    const reasoning = typeof data.reasoning === "string" ? data.reasoning : "";
    if (reasoning !== "") {
      out.push(...this.#put({ type: "reasoning", id: `reasoning:${turn}:${step}`, text: reasoning }));
    }
    const text = typeof data.text === "string" ? data.text : "";
    if (text !== "") {
      const id = `assistant:${turn}:${step}`;
      out.push(...this.#put({ type: "assistant_message", id, messageId: id, text }));
    }
    return out;
  }

  #toolCall(data: Record<string, unknown>): ProviderTimelineItem[] {
    const callId = stringField(data, "callId");
    if (callId === undefined) return [];
    const name = stringField(data, "name") ?? "tool";
    const input = parseArguments(data.arguments);
    this.#toolNames.set(callId, name);
    this.#toolInputs.set(callId, input);
    // Always "running": `#emitToolCall` ignores a repeat for a row that already
    // reached a terminal state, so this cannot undo a finished tool.
    return this.#emitToolCall(callId, name, input, "running");
  }

  #toolResult(data: Record<string, unknown>): ProviderTimelineItem[] {
    const message = isRecord(data.message) ? data.message : undefined;
    const callId = stringField(data, "toolCallId") ?? (message === undefined ? undefined : stringField(message, "toolCallId"));
    if (callId === undefined) return [];
    const name = this.#toolNames.get(callId) ?? "tool";
    const input = this.#toolInputs.get(callId) ?? {};
    const output = message === undefined ? "" : textOf(message.content);
    const failed = message?.isError === true;
    // DSH attaches the tool's `presentationMeta` to the result event itself
    // (`data.meta`), next to the message. It is the only copy of the structured
    // result there is: `message.content` is already the rendered text. It ends up
    // on the item's `metadata`, not on the detail — the detail schema strips
    // unknown fields at this process's boundary (see {@link ToolDetail}).
    const { detail, presentationMeta } = withPresentationMeta(
      toolDetail(name, input, output === "" ? undefined : output),
      name,
      data.meta,
      this.#warn,
    );

    const out: ProviderTimelineItem[] = [];
    if (name === "todo_write" && !failed) {
      const items = todoItems(input);
      if (items !== null) {
        out.push(...this.#put({ type: "todo", id: `todo:${callId}`, items }));
      }
    }
    out.push(
      ...this.#put({
        type: "tool_call",
        id: `tool:${callId}`,
        callId,
        name,
        detail,
        metadata: toolMetadata(input, presentationMeta),
        ...(failed
          ? { status: "failed" as const, error: { message: output || "tool failed" } }
          : { status: "completed" as const, error: null }),
      }),
    );
    // A picture is not a tool row: Paseo's detail union has no image field, and
    // its markdown renderer is the one surface that can draw bytes fetched over
    // file RPC. So each stamped image block becomes its own assistant message,
    // right after the row that produced it.
    for (const row of imageRows(callId, message?.content)) {
      out.push(...this.#put({ type: "assistant_message", id: row.id, messageId: row.id, text: row.text }));
    }
    return out;
  }

  /**
   * A slash command the human ran in the composer.
   *
   * DSH records the command in the session log, so the row is durable and
   * replays on reopen like every other item. The command's own output only
   * exists on `command/done`, so the row is written once there and `command/run`
   * only remembers the name and arguments that shape it. Without this the
   * composer runs the command, DSH answers, and the answer is thrown away — a
   * command that looks like it did nothing.
   *
   * A command a compaction took over (`/compact`) is the exception: the
   * compaction marker is that command's row, so {@link #commandDone} drops it.
   */
  #commandRun(data: Record<string, unknown>): ProviderTimelineItem[] {
    const commandId = stringField(data, "commandId");
    const name = stringField(data, "name");
    if (commandId === undefined || name === undefined) return [];
    // The arguments typed after the command name (`/goal ship it`). DSH records
    // them beside the name, and they are the one part of the line the row's head
    // does not already show: the head reads `label · summary` with the command
    // itself as the label.
    const args = typeof data.args === "string" ? data.args.trim() : "";
    this.#commands.set(commandId, { name, args });
    return [];
  }

  #commandDone(data: Record<string, unknown>): ProviderTimelineItem[] {
    const commandId = stringField(data, "commandId");
    if (commandId === undefined) return [];
    const command = this.#commands.get(commandId);
    const name = command?.name ?? "command";
    this.#commands.delete(commandId);
    const text = typeof data.text === "string" ? data.text : "";
    const failed = data.kind === "error";
    // A `/compact` writes two brackets for one action: this `command/*` one and
    // the `compaction/*` one. The compaction marker *is* the row — showing both
    // printed the command and the marker for the same keystroke — so a successful
    // command a compaction claimed is dropped. The link is DSH's own ids
    // (`compaction.sourceCommandId === command.commandId`), not the command name:
    // a renamed or aliased compact command still maps.
    //
    // A failed one is *not* dropped: Paseo's marker has no failure state, so the
    // failed row is the only place the error can be read. Fail loud.
    if (!failed && this.#compactionCommands.has(commandId)) return [];
    // A rewind is executed by this provider on the user's behalf — the button
    // runs `dsh-rewind`'s `/rewind @<seq> chat|both` — so the row would be the
    // only trace of an implementation detail the user never typed. Drop the
    // successful one; a failed rewind keeps its row because Paseo's marker has no
    // failure state and the row is where the error can be read.
    if (!failed && REWIND_COMMAND_NAMES.has(name)) return [];
    const line = `/${name}`;
    return this.#put({
      type: "tool_call",
      id: `command:${commandId}`,
      callId: commandId,
      name: line,
      // `label` is the **second half** of the row's head, not the row's title:
      // the head already reads `label · summary` with the command itself as the
      // first half. Putting `/${name}` here printed the command twice
      // (`/compact · /compact`). The arguments are the only part of the line the
      // head does not already show, so `/compact` (no arguments) leaves the
      // second half empty and `/goal <target>` shows the target.
      detail: { type: "plain_text", label: command?.args ?? "", text, icon: "square_terminal" },
      // A `/command` row goes through the client's tool-call transformer like any
      // other, so it carries the locale hint too: a session whose first row is
      // `/compact` must not be the one that misses it.
      metadata: localeMetadata(),
      ...(failed
        ? { status: "failed" as const, error: { message: text === "" ? "command failed" : text } }
        : { status: "completed" as const, error: null }),
    });
  }

  /**
   * DSH's compaction lifecycle -> Paseo's own `compaction` marker.
   *
   * DSH compacts the model-visible history under a durable open/close bracket
   * (`compaction/start` … `compaction/summary` + `compaction/end`), and none of
   * those events reaches the surface: DSH's web UI draws its marker from the
   * replacement `user/message` checkpoint the summary is paired with. Paseo has
   * the marker as a first-class item (`{type:"compaction", status, trigger}`,
   * which its own omp/pi adapters emit), so the bracket maps onto it.
   *
   * **Two items per `compactionId`: `loading` at the start, then exactly one
   * `completed`.** The host merges them itself. Its web bundle's compaction
   * reducer (decompiled from
   * `@getpaseo/server/dist/server/web-ui/.../index-*.js`) does, on a `completed`
   * payload:
   *
   * ```js
   * const at = rows.findIndex((row) => row.kind === "compaction" && row.status === "loading");
   * if (at >= 0) {
   *   const merged = { ...rows[at], status: "completed", trigger, preTokens };
   *   return [...rows.slice(0, at), merged, ...rows.slice(at + 1)]; // in place
   * }
   * // no loading row anywhere -> append a new one
   * return [...rows, { kind: "compaction", …, status, trigger, preTokens }];
   * ```
   *
   * So the search is over the whole table, by `kind` + `status` — never by id,
   * and never by adjacency — and a `completed` with no loading row left is
   * **appended**. That last line is what printed a compaction twice: emitting
   * both the summary and the closing `end` as `completed` merged the first one
   * into the loading row and appended the second. Hence the invariant this
   * method exists to keep: **never two `completed` items for one bracket**. The
   * summary draws it and the `end` is dropped; an `end` that arrives with no
   * summary (DSH failed it, or the log is missing the summary) draws it instead.
   *
   * A provider item cannot be updated by a later item of its own — the daemon's
   * `mapTimelineItem` hands every non-message item on as `withoutIdentity` — but
   * that is beside the point here: the merge happens on the host's own reducer,
   * keyed by `kind`/`status`, so a stable id is not what makes this work.
   *
   * `trigger` is DSH's own distinction and is exact, not inferred from timing.
   * Two signals agree on it and either is enough: `compactNow` (the `/compact`
   * command) stamps `sourceCommandId`, and it is the only path that runs with
   * `owner: null` — a standalone transaction between turns — while the
   * token-meter-driven path calls `compactSurfaceRegion` with
   * `owner: "current-turn"` and no command id.
   *
   * `preTokens` is deliberately left unset. Paseo fills it from the provider's
   * *tokens before compaction* (`omp`'s mapper reads `tokensBefore`); DSH's
   * `compaction/summary` reports `shadowedTokenCount`, the estimated size of the
   * range that was replaced. Similar numbers, different quantity — a label
   * reading "~Nk tokens" off it would be a quiet lie, and DSH has nothing that
   * answers the question Paseo is asking.
   *
   * `compaction/prune` is not mapped either: it is the shadow price of a
   * model-free tool-result prune, it carries no `compactionId`, and the event it
   * precedes is a `tool/result` replacement rather than a compaction checkpoint —
   * DSH's own UI shows no marker for it.
   */
  #compaction(
    data: Record<string, unknown>,
    phase: "start" | "summary" | "end",
  ): ProviderTimelineItem[] {
    const compactionId = stringField(data, "compactionId");
    if (compactionId === undefined) return [];
    // A failed compaction is closed with `error` on its `compaction/end` (the
    // summary event never lands). Paseo's marker has only `loading`/`completed`,
    // exactly as its own omp mapper notes ("every end event clears loading"), so
    // the marker cannot carry the failure. It does not have to: DSH's error
    // travels to the turn or the command that owned the compaction, and this
    // builder already renders both (`turn/end` -> an `error` item,
    // `command/done` kind "error" -> a failed `/compact` row). What would be
    // silent is losing it entirely, so it is also reported here.
    const error = stringField(data, "error");
    if (error !== undefined) {
      this.#warn(
        `compaction: DSH ended ${compactionId} with an error (${error}); the marker is cleared, ` +
          `and the failure itself is on the turn or command that owned the compaction`,
      );
    }
    const sourceCommandId = stringField(data, "sourceCommandId");
    if (sourceCommandId !== undefined) this.#compactionCommands.add(sourceCommandId);
    // `turn === null` is DSH's structural marker for a manual transaction; a
    // missing `turn` is a malformed event, not a manual one.
    const trigger = sourceCommandId !== undefined || data.turn === null ? "manual" : "auto";

    if (phase === "start") {
      this.#loadingCompactions.set(compactionId, trigger);
      return this.#put(this.#compactionItem(compactionId, "loading", trigger));
    }
    if (phase === "summary") {
      // The summary is the completed state; its `end` must not draw a second.
      this.#summarizedCompactions.add(compactionId);
      this.#loadingCompactions.delete(compactionId);
      return this.#put(this.#compactionItem(compactionId, "completed", trigger));
    }
    // phase === "end": dropped when the summary already completed this bracket,
    // and forgotten at the same time so replaying the same log emits exactly the
    // same items again.
    if (this.#summarizedCompactions.delete(compactionId)) return [];
    this.#loadingCompactions.delete(compactionId);
    return this.#put(this.#compactionItem(compactionId, "completed", trigger));
  }

  /** One compaction marker payload; `id` is shared by the two states on purpose. */
  #compactionItem(
    compactionId: string,
    status: "loading" | "completed",
    trigger: "manual" | "auto",
  ): ProviderTimelineItem {
    return { type: "compaction", id: `compaction:${compactionId}`, status, trigger };
  }

  #turnEnd(data: Record<string, unknown>): ProviderTimelineItem[] {
    // Any reason, not just failure: a turn that ends with a tool still running
    // will never see its `tool/result`. DSH cancels turns with
    // `reason.kind === "aborted"`, which used to fall through here and leave the
    // row `running` forever — the client pulses a running row unconditionally.
    const out = this.#cancelRunningTools();
    const reason = isRecord(data.reason) ? data.reason : undefined;
    if (reason?.kind !== "error" && reason?.kind !== "failed") return out;
    const error = isRecord(reason.error) ? reason.error : undefined;
    const message =
      (error === undefined ? undefined : stringField(error, "message")) ?? "The turn failed.";
    const turn = typeof data.turn === "number" ? data.turn : 0;
    out.push(...this.#put({ type: "error", id: `error:${turn}`, message }));
    return out;
  }

  /** Close out tool calls whose result never arrived. */
  #cancelRunningTools(): ProviderTimelineItem[] {
    const out: ProviderTimelineItem[] = [];
    for (const callId of [...this.#runningTools]) {
      const previous = this.#items.get(`tool:${callId}`);
      if (previous === undefined || previous.type !== "tool_call") continue;
      out.push(...this.#put({ ...previous, status: "canceled" as const, error: null }));
    }
    return out;
  }

  #emitToolCall(
    callId: string,
    name: string,
    input: Record<string, unknown>,
    status: "running" | "completed" | "failed" | "canceled",
  ): ProviderTimelineItem[] {
    const previous = this.#items.get(`tool:${callId}`);
    if (
      previous !== undefined &&
      previous.type === "tool_call" &&
      previous.status !== "running"
    ) {
      // A duplicate or replayed `tool/call` for a tool that already finished.
      // Rebuilding the row would reset it to running and, because the detail is
      // rebuilt from the input alone, drop the output it already carries.
      return [];
    }
    const item: ProviderTimelineItem = {
      type: "tool_call",
      id: `tool:${callId}`,
      callId,
      name,
      detail: toolDetail(name, input),
      metadata: toolMetadata(input),
      ...(status === "failed"
        ? { status: "failed" as const, error: { message: "tool failed" } }
        : { status, error: null }),
    };
    return this.#put(item);
  }
}
