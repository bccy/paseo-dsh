/** Durable DSH workflow/goal events. Vocabulary and pairing follow dsh-tool-workflow
 * and dsh-goal 0.2.1; these are complete tool_call snapshots, not new detail types. */
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { LOCALE } from "./locale";

type Row = Extract<ProviderTimelineItem, { type: "tool_call" }>;
type Member = { label: string; phase?: string; childId: string; outcome?: string };
type Run = { name: string; members: Map<number, Member>; stopReason?: string };
const zh = LOCALE === "zh-CN";
const words: Record<string, string> = zh ? {
  running: "运行中", completed: "已完成", cancelled: "已取消", error: "失败",
  failed: "失败", active: "进行中", paused: "已暂停", blocked: "受阻", complete: "已完成",
} : {};
const label = (value: string) => words[value] ?? value;
function text(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing or invalid ${key}`);
  return value;
}
function memberSeq(data: Record<string, unknown>): number {
  if (!Number.isSafeInteger(data.seq) || (data.seq as number) < 0) throw new Error("invalid member seq");
  return data.seq as number;
}
function choice(data: Record<string, unknown>, key: string, allowed: string[]): string {
  const value = text(data, key);
  if (!allowed.includes(value)) throw new Error(`unknown ${key}: ${value}`);
  return value;
}

export class ActivityTimeline {
  #runs = new Map<string, Run>();
  #goalObjective = "";

  consume(type: string, data: Record<string, unknown>): Row | undefined {
    if (type === "goal/change") return this.#goal(data);
    if (![
      "tool-workflow/run-start", "tool-workflow/agent-start",
      "tool-workflow/agent-end", "tool-workflow/run-end",
    ].includes(type)) return undefined;
    const id = text(data, "runId");
    if (type === "tool-workflow/run-start") {
      const name = text(data, "name");
      // Replayed duplicate starts must not erase members or undo a terminal.
      if (!this.#runs.has(id)) this.#runs.set(id, { name, members: new Map() });
    }
    const run = this.#runs.get(id);
    if (!run) throw new Error(`workflow ${id}: update without run-start`);
    if (type === "tool-workflow/agent-start") {
      const seq = memberSeq(data);
      const member = { label: text(data, "label"), childId: text(data, "childId"),
        ...(data.phase === undefined ? {} : { phase: text(data, "phase") }) };
      if (!run.members.has(seq)) run.members.set(seq, member);
    } else if (type === "tool-workflow/agent-end") {
      const seq = memberSeq(data);
      const member = run.members.get(seq);
      if (!member) throw new Error(`workflow ${id}: unknown member ${seq}`);
      member.outcome = choice(data, "outcome", ["completed", "failed", "cancelled"]);
    } else if (type === "tool-workflow/run-end") {
      run.stopReason = choice(data, "stopReason", ["completed", "cancelled", "error"]);
    }
    return this.#workflow(id, run);
  }

  /** A dead replay has no later run-end. A closed turn alone is not evidence:
   * background workflow jobs can continue after their launching turn ends. */
  settle(): Row[] {
    const rows: Row[] = [];
    for (const [id, run] of this.#runs) {
      if (run.stopReason !== undefined) continue;
      run.stopReason = "cancelled";
      rows.push(this.#workflow(id, run));
    }
    return rows;
  }

  #workflow(id: string, run: Run): Row {
    const state = run.stopReason ?? "running";
    const members = [...run.members.entries()].sort(([a], [b]) => a - b);
    const settled = members.filter(([, m]) => m.outcome !== undefined).length;
    const summary = `${run.name} · ${label(state)} · ${settled}/${members.length}`;
    return {
      type: "tool_call", id: `tool:workflow:${id}`, callId: `workflow:${id}`, name: "workflow",
      ...(state === "error" ? { status: "failed" as const, error: "Workflow ended with error" }
        : { status: state === "cancelled" ? "canceled" as const : state === "completed" ? "completed" as const : "running" as const, error: null }),
      detail: { type: "plain_text", label: summary, icon: "bot", text: [summary, ...members.map(([seq, m]) =>
        `${seq}. ${m.phase ? `[${m.phase}] ` : ""}${m.label} · ${label(m.outcome ?? (run.stopReason ? "cancelled" : "running"))} · ${m.childId}`,
      )].join("\n") }, metadata: { locale: LOCALE },
    };
  }

  #goal(data: Record<string, unknown>): Row {
    if (data.version !== 1) throw new Error(`unsupported goal/change version: ${String(data.version)}`);
    let summary: string;
    let body: string;
    if (data.operation === "clear") {
      if (!data.cleared || typeof data.cleared !== "object") throw new Error("goal clear missing cleared ref");
      text(data.cleared as Record<string, unknown>, "id");
      summary = zh ? "目标已清除" : "Goal cleared";
      body = [summary, this.#goalObjective].filter(Boolean).join("\n");
      this.#goalObjective = "";
    } else {
      choice(data, "operation", ["create", "edit", "pause", "resume", "complete", "block"]);
      if (!data.goal || typeof data.goal !== "object") throw new Error("goal/change missing snapshot");
      const goal = data.goal as Record<string, unknown>;
      text(goal, "id");
      const objective = text(goal, "objective");
      const phase = choice(goal, "phase", ["active", "paused", "blocked", "complete"]);
      summary = `${label(phase)} · ${objective}`;
      body = summary;
      if (phase === "blocked") {
        if (!goal.blockedReason || typeof goal.blockedReason !== "object") throw new Error("blocked goal missing reason");
        body += `\n${text(goal.blockedReason as Record<string, unknown>, "message")}`;
      }
      this.#goalObjective = objective;
    }
    // A goal phase is durable state, not an in-flight tool. turn/end must never
    // cancel an active goal. callId is session-scoped in Paseo, as is this builder.
    return { type: "tool_call", id: "tool:goal:current", callId: "goal:current", name: "get_goal",
      status: "completed", error: null, detail: { type: "plain_text", icon: "sparkles", label: summary, text: body },
      metadata: { locale: LOCALE } };
  }
}
