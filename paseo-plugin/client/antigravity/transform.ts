import type { PluginTimelineTransformResult } from "@getpaseo/plugin";
import type {
  PluginClientContext,
  PluginTimelineTransformerContribution,
} from "@getpaseo/plugin/client";
import {
  ASK_QUESTION_TIMELINE_KIND,
  SUBAGENT_LIST_TIMELINE_KIND,
  SUBAGENT_TIMELINE_KIND,
  type AskQuestionCard,
  type SubagentCard,
  type SubagentCheck,
} from "../../shared/antigravity/contracts";
import {
  extractToolOutput,
  formatQuestionEcho,
  normalizeEchoText,
  parseAskQuestions,
} from "./questionModel";

export type ToolCallTimelineItem = Parameters<
  PluginTimelineTransformerContribution<"tool_call">["transform"]
>[0]["item"];

export type AssistantMessageTimelineItem = Parameters<
  PluginTimelineTransformerContribution<"assistant_message">["transform"]
>[0]["item"];

export interface AntigravityTimelineTransforms {
  /**
   * Transforms Antigravity-specific tool calls (`invoke_subagent`, `manage_subagents`,
   * `swarm`, `ask_question`) BEFORE `dsh-inline-tool` runs, returning `undefined` for every other tool.
   */
  transformToolCall(item: ToolCallTimelineItem): PluginTimelineTransformResult | undefined;
  /** Suppresses `agy acp`'s duplicate plain-text question echo in assistant messages. */
  transformAssistantMessage(item: AssistantMessageTimelineItem): PluginTimelineTransformResult | undefined;
  /** Registers the `assistant_message` echo-suppression transformer on `client`. */
  registerEchoTransform(client: PluginClientContext): () => void;
  /** Clears cached question-echo signatures. */
  clear(): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** agy logs live under `<home>/.gemini/antigravity-cli/brain/<conversation>/`. */
const AGY_LOG = /[/\\]brain[/\\][0-9a-f-]{36}[/\\]/i;
const MAX_ECHO_CACHE = 200;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractChildId(output: unknown): string {
  const text = extractToolOutput(output);
  if (text) return UUID_ANYWHERE.exec(text)?.[0] ?? "";
  if (output && typeof output === "object") {
    const id = (output as { conversationId?: unknown }).conversationId;
    if (typeof id === "string" && UUID.test(id)) return id;
  }
  return "";
}

function parseJsonOutput(output: unknown): unknown {
  const text = extractToolOutput(output);
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      const objStart = text.indexOf("{");
      const arrStart = text.indexOf("[");
      const useArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart);
      const start = useArray ? arrStart : objStart;
      const end = useArray ? text.lastIndexOf("]") : text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(text.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  }
  if (output && typeof output === "object") return output;
  return null;
}

/** The JSON list `manage_subagents` prints after "You have N active subagent(s):". */
function listedStates(output: unknown): SubagentCheck["states"] {
  const text = extractToolOutput(output);
  if (!text) return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as { conversationId?: unknown; role?: unknown; state?: unknown };
      if (typeof record.conversationId !== "string") return [];
      return [
        {
          id: record.conversationId,
          role: typeof record.role === "string" ? record.role : null,
          state: typeof record.state === "string" ? normalizeState(record.state) : "idle",
        },
      ];
    });
  } catch {
    return [];
  }
}

function normalizeState(state: string): string {
  const value = state.toLowerCase();
  if (value === "running" || value === "active") return "running";
  // agy reports a subagent that ended its turn as `idle`: in a check, that is a finished one.
  if (value === "completed" || value === "done" || value === "finished" || value === "idle") return "done";
  if (value === "killed" || value === "canceled" || value === "cancelled" || value === "stopped") return "stopped";
  if (value === "failed" || value === "error") return "failed";
  return value;
}

function normalizeSwarmState(state: string): string {
  const value = state.trim().toLowerCase();
  if (value === "working" || value === "running" || value === "active") return "running";
  if (value === "waiting" || value === "idle" || value === "mentions" || value === "all") return "idle";
  if (value === "killed" || value === "stopped" || value === "canceled" || value === "cancelled") return "stopped";
  if (value === "done" || value === "completed" || value === "finished") return "done";
  if (value === "failed" || value === "error") return "failed";
  return value || "idle";
}

function extractSwarmWorkerItem(entry: unknown): { id: string; name: string | null } | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as {
    conversation_id?: unknown;
    conversationId?: unknown;
    id?: unknown;
    name?: unknown;
    role?: unknown;
  };
  const id =
    nonEmptyString(record.conversation_id) ??
    nonEmptyString(record.conversationId) ??
    nonEmptyString(record.id);
  if (!id || !UUID.test(id)) return null;
  const rawName = nonEmptyString(record.name) ?? nonEmptyString(record.role);
  const name = rawName && rawName !== "worker" && rawName !== "coordinator" ? rawName : null;
  return { id, name };
}

function parseSwarmAddOutput(output: unknown): Array<{ id: string; name: string | null }> {
  const workers: Array<{ id: string; name: string | null }> = [];
  const seen = new Set<string>();
  const push = (entry: { id: string; name: string | null } | null) => {
    if (!entry || seen.has(entry.id)) return;
    seen.add(entry.id);
    workers.push(entry);
  };

  const parsed = parseJsonOutput(output);
  if (Array.isArray(parsed)) {
    for (const item of parsed) push(extractSwarmWorkerItem(item));
  } else if (parsed && typeof parsed === "object") {
    const record = parsed as {
      workers?: unknown;
      members?: unknown;
      added?: unknown;
      results?: unknown;
    };
    push(extractSwarmWorkerItem(record));
    for (const list of [record.workers, record.members, record.added, record.results]) {
      if (Array.isArray(list)) {
        for (const item of list) push(extractSwarmWorkerItem(item));
      } else if (list && typeof list === "object") {
        for (const [memberName, memberValue] of Object.entries(list as Record<string, unknown>)) {
          if (memberName === "coordinator") continue;
          const extracted = extractSwarmWorkerItem(memberValue);
          if (extracted) push({ id: extracted.id, name: extracted.name ?? memberName });
        }
      }
    }
  }

  if (workers.length === 0) {
    const text = extractToolOutput(output);
    if (text) {
      for (const id of text.match(UUID_GLOBAL) ?? []) {
        push({ id, name: null });
      }
    }
  }

  return workers;
}

function swarmStatusStates(output: unknown): { states: SubagentCheck["states"]; title: string | null } {
  const parsed = parseJsonOutput(output);
  if (!parsed || typeof parsed !== "object") return { states: [], title: null };
  const record = parsed as { title?: unknown; members?: unknown };
  const title = nonEmptyString(record.title);
  const states: SubagentCheck["states"] = [];

  const pushEntry = (fallbackName: string | null, item: unknown) => {
    if (!item || typeof item !== "object") return;
    const member = item as {
      name?: unknown;
      role?: unknown;
      conversation_id?: unknown;
      conversationId?: unknown;
      id?: unknown;
      state?: unknown;
      status?: unknown;
      wake_mode?: unknown;
      killed?: unknown;
      phase?: unknown;
    };
    const name = nonEmptyString(member.name) ?? fallbackName;
    const role = nonEmptyString(member.role);
    if (name === "coordinator" || role === "coordinator") return;
    const id =
      nonEmptyString(member.conversation_id) ??
      nonEmptyString(member.conversationId) ??
      nonEmptyString(member.id) ??
      name;
    if (!id) return;
    let rawState = nonEmptyString(member.state) ?? nonEmptyString(member.status) ?? nonEmptyString(member.wake_mode);
    if (member.killed === true || nonEmptyString(member.phase)?.toUpperCase() === "KILLED") {
      rawState = "killed";
    }
    states.push({
      id,
      role: name ?? role,
      state: rawState ? normalizeSwarmState(rawState) : "idle",
    });
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) pushEntry(null, item);
  } else if (Array.isArray(record.members)) {
    for (const item of record.members) pushEntry(null, item);
  } else if (record.members && typeof record.members === "object") {
    for (const [memberName, memberValue] of Object.entries(record.members as Record<string, unknown>)) {
      pushEntry(memberName, memberValue);
    }
  }

  return { states, title };
}

function swarmKillStates(input: Record<string, unknown>, output: unknown): SubagentCheck["states"] {
  const parsed = parseJsonOutput(output);
  const outRecord = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { name?: unknown; conversation_id?: unknown; conversationId?: unknown; killed?: unknown })
    : null;
  const name = nonEmptyString(input.name) ?? nonEmptyString(outRecord?.name);
  const convId = nonEmptyString(outRecord?.conversation_id) ?? nonEmptyString(outRecord?.conversationId);
  if (Array.isArray(outRecord?.killed)) {
    const entries = outRecord.killed
      .map((item) => nonEmptyString(item))
      .filter((item): item is string => Boolean(item))
      .map((workerName) => ({ id: workerName, role: workerName, state: "stopped" }));
    if (entries.length > 0) return entries;
  }
  if (!name) return [];
  return [{ id: convId ?? name, role: name, state: "stopped" }];
}

/** Ids and roles a `kill` or `kill_all` call names. */
function killedStates(input: unknown, output: unknown): SubagentCheck["states"] {
  const record = (input && typeof input === "object" ? input : {}) as { ConversationIds?: unknown };
  const ids = Array.isArray(record.ConversationIds)
    ? record.ConversationIds.filter((id): id is string => typeof id === "string")
    : [];
  const text = extractToolOutput(output);
  const roles =
    text ? (/Killed roles:\s*([^\n]+)/.exec(text)?.[1] ?? "").split(/,\s*/).filter(Boolean) : [];
  const reportedCount =
    text ? Number(/killed\s+(\d+)\s+subagent/i.exec(text)?.[1] ?? 0) : 0;
  const count = Math.max(ids.length, roles.length, Number.isFinite(reportedCount) ? reportedCount : 0);
  return Array.from({ length: count }, (_, index) => ({
    id: ids[index] ?? `#${index + 1}`,
    role: roles[index] ?? null,
    state: "stopped",
  }));
}

/**
 * Antigravity's own timeline transforms:
 * - `invoke_subagent` becomes a live card of the child it started;
 * - `manage_subagents` becomes a one-line summary;
 * - `swarm` (`add`, `kill`, `status`, `title`, `model`) becomes worker cards or status/check rows;
 * - `ask_question` becomes an interactive question card (and hides agy's duplicate plain-text list).
 *
 * Exported as a factory so `index.client.tsx` can run `transformToolCall` deterministically
 * BEFORE `dsh-inline-tool` inside a single `tool_call` transformer.
 */
export function createAntigravityTimelineTransforms(): AntigravityTimelineTransforms {
  const knownQuestionEchoes = new Set<string>();

  function rememberEcho(signature: string) {
    if (!signature) return;
    knownQuestionEchoes.delete(signature);
    knownQuestionEchoes.add(signature);
    if (knownQuestionEchoes.size > MAX_ECHO_CACHE) {
      const oldest = knownQuestionEchoes.keys().next().value;
      if (oldest) knownQuestionEchoes.delete(oldest);
    }
  }

  function transformToolCall(item: ToolCallTimelineItem): PluginTimelineTransformResult | undefined {
    const status = item.status;
    if (item.name === "invoke_subagent" && item.detail.type === "sub_agent") {
      const detail = item.detail;
      const childId = detail.childSessionId && UUID.test(detail.childSessionId) ? detail.childSessionId : "";
      // Only agy's subagents: other providers have their own subagent views.
      if (childId && detail.log && !AGY_LOG.test(detail.log)) return undefined;
      const data: SubagentCard = {
        id: childId,
        type: detail.subAgentType ?? null,
        task: cut((detail.description ?? "").trim(), 600),
        status,
      };
      return { items: [{ type: "plugin", kind: SUBAGENT_TIMELINE_KIND, version: 1, data }] };
    }
    // Paseo 0.17+ runs Antigravity over generic ACP where `invoke_subagent` arrives as `unknown` with `{ Prompt, Role, TypeName }`.
    if (item.name === "invoke_subagent" && item.detail.type === "unknown") {
      const input = item.detail.input as { Prompt?: unknown; Role?: unknown; TypeName?: unknown } | null;
      if (!input || typeof input !== "object") return undefined;
      const prompt = typeof input.Prompt === "string" ? input.Prompt.trim() : "";
      const role = typeof input.Role === "string" && input.Role.trim() ? input.Role.trim() : null;
      const typeName = typeof input.TypeName === "string" && input.TypeName.trim() ? input.TypeName.trim() : null;
      if (!prompt && !role && !typeName) return undefined;
      const data: SubagentCard = {
        id: extractChildId(item.detail.output),
        role,
        type: typeName,
        task: cut(prompt, 600),
        status,
      };
      return { items: [{ type: "plugin", kind: SUBAGENT_TIMELINE_KIND, version: 1, data }] };
    }
    if (item.name === "manage_subagents" && item.detail.type === "unknown") {
      const input = item.detail.input as { Action?: unknown } | null;
      const action = typeof input?.Action === "string" ? input.Action : "";
      if (!action) return undefined;
      const states =
        action === "kill" || action === "kill_all"
          ? killedStates(item.detail.input, item.detail.output)
          : listedStates(item.detail.output);
      const data: SubagentCheck = { action, states, status };
      return { items: [{ type: "plugin", kind: SUBAGENT_LIST_TIMELINE_KIND, version: 1, data }] };
    }
    if (item.name === "swarm" && item.detail.type === "unknown") {
      const input = (item.detail.input && typeof item.detail.input === "object"
        ? item.detail.input
        : null) as Record<string, unknown> | null;
      const action = nonEmptyString(input?.action);
      if (!action || !input) return undefined;

      if (action === "add") {
        const baseName = nonEmptyString(input.name);
        const brief = typeof input.brief === "string" ? input.brief.trim() : "";
        const tasks = Array.isArray(input.tasks)
          ? input.tasks.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          : [];
        const spawned = parseSwarmAddOutput(item.detail.output);
        if (spawned.length > 0) {
          return {
            items: spawned.map((worker, index) => {
              const role =
                worker.name ?? (spawned.length > 1 && baseName ? `${baseName}-${index + 1}` : baseName);
              const sliceTask = tasks[index]?.trim();
              const taskText = sliceTask ? (brief ? `${brief} — ${sliceTask}` : sliceTask) : brief;
              const data: SubagentCard = {
                id: worker.id,
                role,
                type: "swarm",
                origin: "swarm",
                task: cut(taskText, 600),
                status,
              };
              return { type: "plugin", kind: SUBAGENT_TIMELINE_KIND, version: 1, data };
            }),
          };
        }
        const data: SubagentCard = {
          id: "",
          role: baseName,
          type: "swarm",
          origin: "swarm",
          task: cut(brief || tasks[0] || "", 600),
          status,
        };
        return { items: [{ type: "plugin", kind: SUBAGENT_TIMELINE_KIND, version: 1, data }] };
      }

      if (action === "status") {
        const { states, title } = swarmStatusStates(item.detail.output);
        const data: SubagentCheck = { action: "swarm:status", states, title, status };
        return { items: [{ type: "plugin", kind: SUBAGENT_LIST_TIMELINE_KIND, version: 1, data }] };
      }

      if (action === "kill") {
        const states = swarmKillStates(input, item.detail.output);
        const data: SubagentCheck = { action: "swarm:kill", states, title: null, status };
        return { items: [{ type: "plugin", kind: SUBAGENT_LIST_TIMELINE_KIND, version: 1, data }] };
      }

      if (action === "title") {
        const parsed = parseJsonOutput(item.detail.output);
        const outTitle =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? nonEmptyString((parsed as { title?: unknown }).title)
            : null;
        const title = nonEmptyString(input.title) ?? outTitle;
        const data: SubagentCheck = { action: "swarm:title", states: [], title, status };
        return { items: [{ type: "plugin", kind: SUBAGENT_LIST_TIMELINE_KIND, version: 1, data }] };
      }

      if (action === "model") {
        const parsed = parseJsonOutput(item.detail.output);
        const outRecord =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as { name?: unknown; model?: unknown; model_display_name?: unknown })
            : null;
        const workerName = nonEmptyString(input.name) ?? nonEmptyString(outRecord?.name);
        const model =
          nonEmptyString(outRecord?.model_display_name) ??
          nonEmptyString(input.model) ??
          nonEmptyString(outRecord?.model);
        const title = workerName && model ? `${workerName} · ${model}` : (model ?? workerName ?? null);
        const data: SubagentCheck = { action: "swarm:model", states: [], title, status };
        return { items: [{ type: "plugin", kind: SUBAGENT_LIST_TIMELINE_KIND, version: 1, data }] };
      }

      return undefined;
    }
    if (item.name === "ask_question" && item.detail.type === "unknown") {
      const questions = parseAskQuestions(item.detail.input);
      if (!questions) return undefined;
      if (questions.some((entry) => entry.options.length > 0)) {
        rememberEcho(formatQuestionEcho(questions));
      }
      const data: AskQuestionCard = {
        callId: item.callId,
        questions,
        output: extractToolOutput(item.detail.output),
        status,
      };
      return { items: [{ type: "plugin", kind: ASK_QUESTION_TIMELINE_KIND, version: 1, data }] };
    }
    return undefined;
  }

  function transformAssistantMessage(item: AssistantMessageTimelineItem): PluginTimelineTransformResult | undefined {
    if (knownQuestionEchoes.size === 0) return undefined;
    const normalized = normalizeEchoText(item.text);
    if (normalized && knownQuestionEchoes.has(normalized)) {
      return { items: [] };
    }
    return undefined;
  }

  function registerEchoTransform(client: PluginClientContext): () => void {
    const removeEchoTransform = client.addTimelineTransformer({
      id: "antigravity-ask-question-echo",
      query: { itemType: "assistant_message" },
      transform: ({ item }) => transformAssistantMessage(item),
    });
    return () => {
      void removeEchoTransform();
      knownQuestionEchoes.clear();
    };
  }

  function clear() {
    knownQuestionEchoes.clear();
  }

  return {
    transformToolCall,
    transformAssistantMessage,
    registerEchoTransform,
    clear,
  };
}
