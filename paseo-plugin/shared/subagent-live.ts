/**
 * Live cross-turn update subscription for `subagent` / `subagent_fork` timeline
 * cards.
 *
 * Why a subscription instead of re-emitting `tool_call` items across turns:
 * Paseo's `timeline-projection.js` merges `tool_call` updates in place ONLY
 * while `existing.turnId === entry.turnId`. In DSH 0.2.2+, async subagents
 * return an activation receipt (`"started subagent <name>"`) inside Turn 1 and
 * settle minutes later after Turn 1 has already ended (or in Turn 2). Re-emitting
 * `tool_call` across turns would duplicate the row at the bottom of the
 * timeline, while dropping the update left live cards stuck on `"running"`
 * until the session was reopened.
 *
 * This subscription pushes only changed `callId -> DshSubagentMetadata` entries
 * from the active `DshSession` (zero polling timer; opened by `<SubagentCard>`
 * only while a card is `"running"` and released immediately once settled).
 *
 * @module dsh-paseo/shared/subagent-live
 */
import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { SUBAGENT_MODES, SUBAGENT_STATUSES, SUBAGENT_TOOL_NAMES } from "./subagent-card";

export const dshSubagentMetadataSchema = z.object({
  kind: z.enum(SUBAGENT_TOOL_NAMES),
  status: z.enum(SUBAGENT_STATUSES),
  role: z.string().optional(),
  title: z.string().optional(),
  task: z.string().optional(),
  report: z.string().optional(),
  childSessionId: z.string().optional(),
  mode: z.enum(SUBAGENT_MODES).optional(),
  preset: z.string().optional(),
  model: z.string().optional(),
  steps: z.number().optional(),
  durationMs: z.number().optional(),
  outputTokens: z.number().optional(),
});

export const subagentLiveEventSchema = z.object({
  cards: z.record(z.string(), dshSubagentMetadataSchema),
});

export type SubagentLiveEvent = z.infer<typeof subagentLiveEventSchema>;

export const subagentLiveSnapshot = defineSubscription({
  name: "dsh.subagent.live",
  input: z.object({ agentId: z.string().min(1) }),
  event: subagentLiveEventSchema,
});
