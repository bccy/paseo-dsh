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
import { localeFromMetadata, setLocale } from "./client/locale";
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
    transform: ({ item, phase }) => {
      // The server half resolved the daemon's locale and put it on this item's
      // `metadata` (`server/timeline.ts`: every tool-call item carries it, not
      // just the first — React never re-renders a row that already transformed,
      // so a hint on one row only would be a hint nobody sees). Adopt it here,
      // before mapping, because every lookup below reads the locale at call
      // time.
      //
      // Only a tool-call item can carry this hint: `metadata` is the protocol's
      // one free-form passthrough, and the reasoning and assistant schemas are
      // `.strip()`ed with no such field. So a session that opens with thinking
      // text or an assistant message renders those rows in the client's default
      // (`zh-CN`) until the first tool call arrives, and rows already on screen
      // keep the locale they were built with. That is a protocol limit, not a
      // bug — there is nowhere on those items to put the hint.
      setLocale(localeFromMetadata(item.metadata));
      // Paseo 0.12's app rebuilds every tool-call item before it hands it to a
      // plugin transformer, copying only `callId`/`name`/`status`/`error`/
      // `detail`/`metadata` (`projectPluginTimelineItems` in the app bundle) —
      // the `agentMessage` field the daemon's own projection adds is dropped on
      // the way. A row that reaches us without it cannot be rendered
      // semantically, and mapping what is left would print the wire name
      // `agent_message` over the raw `plain_text` echo (the exact regression this
      // phase exists to fix). Parsing `detail.text` to fake the message back is
      // not an option: this repo does not read payloads out of a field the
      // protocol does not define as the carrier.
      //
      // Returning `undefined` keeps the *source* item, so Paseo's own renderer
      // draws the row from the fields it already holds (its `agentMessage`), with
      // its official event labels. Remove this branch once the host forwards
      // `agentMessage` to plugins: the mapping below then runs everywhere, and
      // `harness/agent-message-check.cjs` pins both halves of that contract.
      if (item.name === "agent_message" && item.agentMessage === undefined) {
        return undefined;
      }
      return {
        items: [
          {
            type: "plugin",
            kind: "dsh-tool",
            version: 1,
            // The item is forwarded whole, never field-picked: 0.12 projects an
            // agent-to-agent message as a tool call whose meaning lives on
            // `item.agentMessage` (the `plain_text` detail beside it is only an
            // echo), and `toolCallData` reads it from there. Picking `name` /
            // `detail` / `metadata` here would drop that half silently.
            data: { ...toolCallData(item, phase) },
          },
        ],
      };
    },
  });

  client.addTimelineRenderer({
    kind: "dsh-tool",
    version: 1,
    // The schema's top-level key set is asserted against `ToolCallData` by
    // `harness/tool-call-check.cjs`: Paseo strips a key the schema does not
    // declare, and the component then silently loses a block.
    schema: z.object({
      name: z.string(),
      label: z.string(),
      icon: z.string(),
      // Paseo's own mark instead of the Lucide glyph (see `ToolCallData`).
      paseoMark: z.boolean(),
      status: z.enum(["running", "completed", "failed", "canceled"]),
      phase: z.enum(["streaming", "complete"]),
      summary: z.string(),
      headline: z.string(),
      body: z.string(),
      bodyLabel: z.string(),
      diff: z.boolean(),
      code: z.boolean(),
      failed: z.boolean(),
      titled: z.boolean(),
      hasDetail: z.boolean(),
      // DSH's block dispatch: terminal/diff/read/image/search/web/details. The
      // image block is a later phase; `read_image` lands in `generic` for now.
      kind: z.enum(["terminal", "diff", "read", "search", "web", "generic"]),
      search: z
        .object({
          shape: z.enum(["matches", "paths"]),
          files: z.array(
            z.object({
              path: z.string(),
              matches: z.array(z.object({ lineNumber: z.number(), line: z.string() })),
              count: z.number(),
            }),
          ),
          paths: z.array(z.string()),
          shown: z.number(),
          total: z.number(),
          truncated: z.boolean(),
          text: z.string(),
        })
        .nullable(),
      read: z
        .object({
          path: z.string(),
          lang: z.string(),
          lines: z.array(z.object({ number: z.number(), text: z.string() })),
          totalLines: z.number(),
          text: z.string(),
        })
        .nullable(),
      diffBlock: z
        .object({
          rows: z.array(
            z.object({
              kind: z.enum(["path", "hunk", "gap", "add", "del", "context"]),
              text: z.string(),
            }),
          ),
          body: z.string(),
          operation: z.enum(["create", "update", ""]),
          path: z.string(),
        })
        .nullable(),
      web: z
        .object({
          shape: z.enum(["search", "fetch"]),
          sources: z.array(
            z.object({
              url: z.string(),
              title: z.string(),
              label: z.string(),
              snippet: z.string(),
              publishedAt: z.string(),
            }),
          ),
          answer: z.string(),
          url: z.string(),
          statusCode: z.number().nullable(),
          truncated: z.boolean(),
        })
        .nullable(),
    }),
    Component: InlineToolCall,
  });

  return () => {};
}
