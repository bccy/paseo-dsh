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
import { UI } from "./locale";

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

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Paseo's tool detail, plus DSH's raw result metadata (`tool/result` → `data.meta`).
 *
 * Paseo's detail union is closed and has no member for what DSH publishes there:
 * numbered `read` lines, hunk-level diffs, matches grouped by file, web sources,
 * the `write` operation. Those fields are what the whole rendering plan hangs on,
 * and inventing a parallel protocol shape for them would be exactly the mistake
 * this repo keeps warning about. So the raw meta travels verbatim under `meta`:
 * Paseo's wire validator checks the fields it knows and leaves unknown ones
 * alone, and the plugin's own renderer reads a detail as a plain record.
 *
 * The protocol fields that *do* exist are filled as well — see
 * {@link withPresentationMeta} — so Paseo's stock `read`/`search`/`fetch`
 * rendering keeps working off the same result.
 */
export type ToolDetail = ProviderToolCallDetail & { meta?: JsonValue };

/** One member of {@link ToolDetail}, for filling its protocol fields in place. */
type ToolDetailOf<T extends ProviderToolCallDetail["type"]> =
  Extract<ProviderToolCallDetail, { type: T }> & { meta?: JsonValue };

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
 *   2. Keep `meta` verbatim for everything the protocol cannot express (line
 *      numbers and `lang`, hunk diffs, grouped matches, sources' snippets).
 *
 * A meta whose shape does not match its tool is *reported*, never swallowed:
 * the row keeps the plain result text and loses only structure it never had. An
 * absent meta is the normal case for a failed tool and for DSH's `bash`, which
 * declares no `presentationMeta` at all — that is not a mismatch.
 */
function withPresentationMeta(
  detail: ToolDetail,
  name: string,
  meta: unknown,
  warn: (line: string) => void,
): ToolDetail {
  if (meta === undefined || meta === null) return detail;
  if (!isRecord(meta)) {
    warn(`meta: ${name} returned a non-object presentation meta (${typeof meta}); kept the plain result text`);
    return detail;
  }
  const out: ToolDetail = { ...detail, meta: meta as JsonValue };
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
      // rides along for a renderer that knows what to do with it.
      break;
  }
  return out;
}

/**
 * Provider metadata for one tool call.
 *
 * DSH's bash tool requires a model-written `description` on every call, and
 * DSH's own UI titles the row with it rather than with the command. Paseo's
 * `shell` detail has no field for it, so it rides on the item's provider-owned
 * `metadata`, which the client reads back in `toolCallData`.
 */
function toolMetadata(input: Record<string, unknown>): Record<string, JsonValue> | undefined {
  const description = stringField(input, "description");
  return description === undefined || description === "" ? undefined : { description };
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
      return { type: "plain_text", label: UI.toolLabels.askedUser, icon: "sparkles" };
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
  /** commandId -> the command name, so `command/done` can title its own row. */
  #commands = new Map<string, string>();
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
      case "turn/end":
        return this.#turnEnd(data);
      default:
        return [];
    }
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
    // result there is: `message.content` is already the rendered text.
    const detail = withPresentationMeta(
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
        ...(toolMetadata(input) === undefined ? {} : { metadata: toolMetadata(input) as Record<string, JsonValue> }),
        ...(failed
          ? { status: "failed" as const, error: { message: output || "tool failed" } }
          : { status: "completed" as const, error: null }),
      }),
    );
    return out;
  }

  /**
   * A slash command the human ran in the composer.
   *
   * DSH records the command in the session log, so the row is durable and
   * replays on reopen like every other item. The command's own output only
   * exists on `command/done`, so the row is written once there and `command/run`
   * only remembers the name that titles it. Without this the composer runs the
   * command, DSH answers, and the answer is thrown away — a command that looks
   * like it did nothing.
   */
  #commandRun(data: Record<string, unknown>): ProviderTimelineItem[] {
    const commandId = stringField(data, "commandId");
    const name = stringField(data, "name");
    if (commandId === undefined || name === undefined) return [];
    this.#commands.set(commandId, name);
    return [];
  }

  #commandDone(data: Record<string, unknown>): ProviderTimelineItem[] {
    const commandId = stringField(data, "commandId");
    if (commandId === undefined) return [];
    const name = this.#commands.get(commandId) ?? "command";
    this.#commands.delete(commandId);
    const text = typeof data.text === "string" ? data.text : "";
    const failed = data.kind === "error";
    const line = `/${name}`;
    return this.#put({
      type: "tool_call",
      id: `command:${commandId}`,
      callId: commandId,
      name: line,
      detail: { type: "plain_text", label: line, text, icon: "square_terminal" },
      ...(failed
        ? { status: "failed" as const, error: { message: text === "" ? "command failed" : text } }
        : { status: "completed" as const, error: null }),
    });
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
      ...(toolMetadata(input) === undefined ? {} : { metadata: toolMetadata(input) as Record<string, JsonValue> }),
      ...(status === "failed"
        ? { status: "failed" as const, error: { message: "tool failed" } }
        : { status, error: null }),
    };
    return this.#put(item);
  }
}
