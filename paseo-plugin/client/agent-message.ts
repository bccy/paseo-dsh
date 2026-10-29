/**
 * The semantic half of a 0.12 agent-to-agent message row.
 *
 * Declared locally instead of importing `@getpaseo/protocol/agent-message`:
 * Paseo 0.11 and earlier resolve every type-only import while installing a
 * plugin, and that module does not exist in the protocol package those daemons
 * ship — the import alone made `paseo plugin add npm:paseo-dsh` fail on them,
 * which contradicts this plugin's `requirements.paseo: ">=0.9.2"`. The type is
 * structural (`AgentMessageSchema` in that package is a plain `z.object`), so a
 * local declaration is identical at compile time. Same reasoning, and the same
 * shape of note, as `server/json-value.ts`.
 *
 * Kept in its own module rather than inline in `tool-call-data.ts` because the
 * latter is compiled by harnesses that also assert on its source text; a type
 * alias in the middle of that file reads as a stray import.
 *
 * @module dsh-paseo/client/agent-message
 */

/**
 * The protocol event a row reports.
 *
 * The five values are `AgentMessageSchema.event`'s enum, verbatim.
 */
export type AgentMessageEvent = "message" | "finished" | "errored" | "permission-required" | "closed";

/** Who sent the message. Only `id` is required; the rest is enrichment. */
export interface AgentMessageSender {
  id: string;
  serverId?: string;
  title?: string;
}

/**
 * One agent-to-agent message, as the daemon projects it onto a timeline item.
 *
 * The daemon sends this beside a `plain_text` detail, which is only an echo kept
 * for clients that predate the field. The row reads this one.
 */
export interface AgentMessage {
  event: AgentMessageEvent;
  sender: AgentMessageSender;
  text: string;
}
