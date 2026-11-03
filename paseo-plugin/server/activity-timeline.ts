/** Durable DSH workflow/goal events. Vocabulary and pairing follow dsh-tool-workflow
 * and dsh-goal 0.2.1; these are complete tool_call snapshots, not new detail types.
 *
 * A goal's automatic continuation rounds are the one thing here that arrives as a
 * `user/message` rather than a domain event: the round driver queues its prompt
 * attributed to the goal (`source: {kind: "goal", goalId, revision, round}`), so
 * it is drawn here as the same kind of compact row as the goal's own state. */
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { LOCALE, UI } from "./locale";

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

/**
 * Whether a `user/message` is DSH's automatic goal-round prompt.
 *
 * The round driver queues each continuation as a user message attributed to the
 * goal (`source: {kind: "goal", goalId, revision, round}`; `GoalMessageSource` in
 * `@deepseek-ai/dsh-goal`'s `types/domain.d.ts:33-40`), so it arrives on the same
 * event type as a human turn. Only a positive round is a continuation: the
 * driver's own predicate is `kind === "goal" && round > 0`
 * (`@deepseek-ai/dsh-goal-round-driver` lib/index.js:31-34), and a round-zero
 * attribution is some other goal-sourced message, not a round.
 *
 * Exported because both replay paths (`DshSession.replayHistory` and
 * `DshChildSession.replay`) have to route such a message to the timeline builder
 * instead of dropping it with the other non-human source kinds — the live path
 * reaches this module directly.
 */
export function isGoalRoundSource(source: Record<string, unknown>): boolean {
  const round = source.round;
  return source.kind === "goal" && typeof round === "number" && Number.isSafeInteger(round) && round > 0;
}

export class ActivityTimeline {
  #runs = new Map<string, Run>();
  #goalObjective = "";

  consume(type: string, data: Record<string, unknown>): Row | undefined {
    if (type === "goal/change") return this.#goal(data);
    if (type === "user/message") return this.#goalRound(data);
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

  /**
   * Draw one automatic goal round as a compact status row.
   *
   * Live and replay produce this from the same event through this same method,
   * so the reopened row is byte-for-byte the live one: the id is derived from
   * the durable attribution (goal id + round), never from a seq or a clock. A
   * second goal has a new id, so its rounds never collide with the first one's.
   *
   * Never a `user_message`: a continuation prompt is DSH's, not the human's — it
   * would read as a question nobody asked and Paseo would offer to rewind from
   * it. The `<goal_round>` prompt is not shown either; it is a standing
   * instruction, so the row carries no body.
   *
   * No `icon` key on purpose: a `plain_text` row that names no glyph borrows the
   * tool's own on the client (`client/tool-call-data.ts`), so this row and the
   * goal state row below draw the same Target as `get_goal` and the goal pill.
   */
  #goalRound(data: Record<string, unknown>): Row | undefined {
    const source = data.source;
    if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined;
    const goalSource = source as Record<string, unknown>;
    if (!isGoalRoundSource(goalSource)) return undefined;
    // Loud on a malformed attribution: a `kind: "goal"` round message without a
    // goal id is a bug, and the builder turns this throw into a visible error row.
    const goalId = text(goalSource, "goalId");
    const round = goalSource.round as number;
    return {
      type: "tool_call",
      id: `tool:goal:round:${goalId}:${String(round)}`,
      callId: `goal:round:${goalId}:${String(round)}`,
      name: "goal_round",
      status: "completed",
      error: null,
      detail: { type: "plain_text", label: UI.goalRound(round) },
      metadata: { locale: LOCALE },
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
    // No `icon` key: the client draws a `plain_text` row that names no glyph with
    // the tool's own (`get_goal` → Target), so the state row, the round row above
    // and the composer's goal pill share one symbol.
    return { type: "tool_call", id: "tool:goal:current", callId: "goal:current", name: "get_goal",
      status: "completed", error: null, detail: { type: "plain_text", label: summary, text: body },
      metadata: { locale: LOCALE } };
  }
}
