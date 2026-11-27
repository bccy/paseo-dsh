import { isAntigravityProvider } from "../../shared/antigravity/contracts";
import type { PaseoApi } from "./types";

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface AgentInfo {
  conversationId: string | null;
  model: string | null;
  /** The provider process is not running (closed or failed). */
  closed: boolean;
  antigravity: boolean;
  fetchedAt: number;
}

export function conversationIdFrom(persistence: unknown): string | null {
  if (!persistence) return null;
  const text = JSON.stringify(persistence);
  const named = /"conversationId"\s*:\s*"([0-9a-f-]{36})"/i.exec(text)?.[1];
  if (named) return named;
  if (typeof persistence === "object") {
    const record = persistence as { sessionId?: unknown; nativeHandle?: unknown };
    for (const candidate of [record.nativeHandle, record.sessionId]) {
      if (typeof candidate === "string" && CONVERSATION_ID.test(candidate)) return candidate;
    }
  }
  return UUID_IN_TEXT.exec(text)?.[0] ?? null;
}

/** Maps agents to their agy conversations, re-reading each agent's snapshot every 20 seconds. */
export class ContextReader {
  private readonly agents = new Map<string, AgentInfo>();

  private async info(paseo: PaseoApi, agentId: string): Promise<AgentInfo | null> {
    const cached = this.agents.get(agentId);
    if (cached && Date.now() - cached.fetchedAt < 20_000) return cached;
    const refreshed = await paseo.agents
      .ref(agentId)
      .refresh()
      .catch(() => null);
    if (!refreshed) {
      this.agents.delete(agentId);
      return null;
    }
    const agent = refreshed.agent;
    const info: AgentInfo = {
      conversationId: conversationIdFrom(agent.persistence),
      model: agent.model ?? null,
      closed: agent.status === "closed" || agent.status === "error",
      antigravity: isAntigravityProvider(agent.provider),
      fetchedAt: Date.now(),
    };
    this.agents.set(agentId, info);
    return info;
  }

  /** The agy conversation id an Antigravity agent runs, or null for non-Antigravity agents. */
  async conversationId(paseo: PaseoApi, agentId: string): Promise<string | null> {
    const info = await this.info(paseo, agentId);
    if (!info?.antigravity) return null;
    return info.conversationId;
  }

  /** The agy conversation details an Antigravity agent runs, or null for other agents. */
  async conversationOf(
    paseo: PaseoApi,
    agentId: string,
  ): Promise<{ conversationId: string | null; closed: boolean; model: string | null } | null> {
    const info = await this.info(paseo, agentId);
    if (!info?.antigravity) return null;
    return { conversationId: info.conversationId, closed: info.closed, model: info.model };
  }

  forget(agentId: string): void {
    this.agents.delete(agentId);
  }
}
