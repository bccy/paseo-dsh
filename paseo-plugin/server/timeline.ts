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

/** Map one DSH tool call onto the richest Paseo tool detail available. */
function toolDetail(name: string, input: Record<string, unknown>, output?: string): ProviderToolCallDetail {
  const filePath = stringField(input, "file_path") ?? stringField(input, "filePath");
  switch (name) {
    case "bash":
    case "pwsh": {
      const command = stringField(input, "command") ?? "";
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
        query:
          stringField(input, "pattern") ??
          stringField(input, "query") ??
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
   * Tool calls that are still running.
   *
   * A turn that ends with entries here means no `tool/result` is coming — an
   * aborted turn takes the process with it. Left alone the row stays `running`
   * forever, and the client pulses a running row without any window, so it
   * blinks for the rest of the session's life and on every replay.
   */
  #runningTools = new Set<string>();

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
        detail: toolDetail(name, input, output === "" ? undefined : output),
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
      ...(status === "failed"
        ? { status: "failed" as const, error: { message: "tool failed" } }
        : { status, error: null }),
    };
    return this.#put(item);
  }
}
