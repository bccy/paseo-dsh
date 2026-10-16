/**
 * Client-side contributions for the DeepSeek Harness provider.
 *
 * Paseo's stock timeline draws reasoning as a collapsed tool-like row labelled
 * "Thinking". dsh web instead shows a thought as one line that keeps scrolling
 * while the model thinks and expands only when clicked; this entry point
 * replaces that row.
 *
 * Tool calls keep Paseo's own icon and single-line shape, but get a formatted
 * expanded view: a code block for output and coloured lines for an edit diff.
 * Without this, expanding an edit showed a flat block with no structure.
 *
 * The plugin's server half still owns the provider; this half only changes how
 * the already-delivered timeline items are drawn.
 *
 * @module dsh-paseo/index.client
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { InlineThinking } from "./client/inline-thinking";
import { InlineToolCall } from "./client/tool-call";
import { toolCallData } from "./client/tool-call-data";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "dsh-inline-thinking",
    query: { itemType: "reasoning" },
    transform: ({ item, phase }) => ({
      items: [
        {
          type: "plugin",
          kind: "dsh-thinking",
          version: 1,
          data: { text: item.text, phase },
        },
      ],
    }),
  });

  client.addTimelineRenderer({
    kind: "dsh-thinking",
    version: 1,
    schema: z.object({ text: z.string(), phase: z.enum(["streaming", "complete"]) }),
    Component: InlineThinking,
  });

  client.addTimelineTransformer({
    id: "dsh-inline-tool",
    query: { itemType: "tool_call" },
    transform: ({ item, phase }) => ({
      items: [
        {
          type: "plugin",
          kind: "dsh-tool",
          version: 1,
          data: { ...toolCallData(item, phase) },
        },
      ],
    }),
  });

  client.addTimelineRenderer({
    kind: "dsh-tool",
    version: 1,
    schema: z.object({
      name: z.string(),
      label: z.string(),
      icon: z.string(),
      status: z.enum(["running", "completed", "failed", "canceled"]),
      phase: z.enum(["streaming", "complete"]),
      summary: z.string(),
      headline: z.string(),
      body: z.string(),
      bodyLabel: z.string(),
      diff: z.boolean(),
      code: z.boolean(),
      failed: z.boolean(),
    }),
    Component: InlineToolCall,
  });

  return () => {};
}
