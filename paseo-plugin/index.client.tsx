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
import { settingsRpc } from "@getpaseo/plugin";
import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { DshPluginsPage } from "./client/dsh-plugins-page";
import { guardCleanup, installFatalGuard, report } from "./client/dsh-plugins-guard";
import { PluginsIcon } from "./client/dsh-plugins-icon";
import { contributeGoalPill } from "./client/goal-pill";
import { InlineThinking } from "./client/inline-thinking";
import { contributeJobsPill } from "./client/jobs-pill";
import {
  DISPLAY_SETTINGS_ID,
  contributeDisplaySettingsCommand,
  contributeTimelineSettings,
} from "./client/settings-screen";
import { contributeStreamStats } from "./client/stream-stats";
import { contributeTeamPill } from "./client/team-pill";
import { createWorkspaceStatusStore } from "./client/workspace-status";
import { contributeWorkspaceBadges } from "./client/workspace-badges";
import {
  localeFromMetadata,
  localeText,
  setLanguageOverride,
  setLocale,
} from "./client/locale";
import { RewindNotice } from "./client/rewind-notice";
import {
  isLegacyRewindNotice,
  rewindNoticeSchema,
} from "./client/rewind-notice-data";
import { startRewindLiveMonitor } from "./client/rewind-notice-live";
import { retainRowEntranceObservers } from "./client/row-entrance";
import { InlineToolCall } from "./client/tool-call";
import { toolCallData } from "./client/tool-call-data";
import {
  REWIND_NOTICE_KIND,
  REWIND_NOTICE_VERSION,
  rewindNoticeArm,
} from "./shared/rewind-notice";
import { languageSettings } from "./shared/settings";

/** The screen's id; the sidebar row opens this same id. */
const PLUGINS_SCREEN_ID = "dsh-plugins";

/**
 * The sidebar header row that opens the page.
 *
 * A component, not a host-drawn icon+surface pair: host 0.16's current API
 * (`addSidebarHeaderItem`) takes a component rendering `SidebarRow`, and the
 * deprecated `addSidebarItem({ icon, surface })` that upstream 0.2.22 used is
 * not worth adopting in a new port. The registered title is a resolved string
 * (see `contribute`), which is what the native app can render safely; the icon
 * is view-drawn for the same reason (`client/dsh-plugins-icon`).
 */
function PluginsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon={PluginsIcon}
      active={currentScreen?.screenId === PLUGINS_SCREEN_ID}
      onPress={() => openScreen({ screenId: PLUGINS_SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  // A fatal error raised while the host draws one of this plugin's
  // contributions (the sidebar row above all) reaches RN's fatal handler, and a
  // release build aborts the whole app. The guard swallows only errors that name
  // this plugin.
  //
  // Deliberately NOT wrapped in a try/catch: the existing timeline contributions
  // below have always let a refused registration fail the client entry loudly,
  // and swallowing that here would turn any of them into a silently missing row
  // (a parked test, `harness/timeline-kind-check.cjs`, pins exactly this: an
  // invalid kind must still throw). The new page's own registrations are guarded
  // individually in `buildContributions`.
  installFatalGuard();
  return buildContributions(client);
}

/**
 * Read the host's persisted language choice once at plugin load.
 *
 * Failures degrade silently to `"auto"` (relayed locale or client default) so
 * an older host or transient RPC failure never blocks client startup.
 */
function bootstrapLanguage(client: PluginClientContext): void {
  void Promise.resolve()
    .then(() => client.rpc(settingsRpc(languageSettings.id).read, {}))
    .then((state) => {
      if (state.status !== "ready") return;
      const parsed = languageSettings.schema.safeParse(state.values);
      if (parsed.success) setLanguageOverride(parsed.data.language);
    })
    .catch((error) => {
      report("language settings", error);
    });
}

function buildContributions(client: PluginClientContext): () => void {
  bootstrapLanguage(client);
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
      // Since Paseo 0.16 the app forwards `agentMessage` to plugin transformers:
      // `sourceToolCallTimelineItem` in `packages/app/src/plugins/timeline/
      // projection.ts` copies it beside `callId`/`name`/`detail`/`metadata`
      // (upstream PR #8492), and its shape is the protocol's own — `{event,
      // sender: {id, title?}, text}`. Before that the field was dropped on this
      // way, which is why this transformer used to hand `agent_message` rows back
      // to Paseo's renderer (`return undefined`) instead of printing the wire
      // name over the `plain_text` echo. That branch is gone: a 0.16 host always
      // supplies the field, so every tool call is mapped here, and
      // `harness/agent-message-check.cjs` pins that no such guard comes back.
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
      callId: z.string(),
      name: z.string(),
      label: z.string(),
      icon: z.string(),
      // Paseo's own mark instead of the Lucide glyph (see `ToolCallData`).
      paseoMark: z.boolean(),
      status: z.enum(["running", "completed", "failed", "canceled"]),
      summary: z.string(),
      headline: z.string(),
      body: z.string(),
      bodyLabel: z.string(),
      diff: z.boolean(),
      code: z.boolean(),
      failed: z.boolean(),
      // Why the call failed; empty on a successful row (see `ToolCallData`).
      error: z.string(),
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
      // The goal tools' result card (DSH's `goalDetail`); null keeps the raw body.
      goal: z
        .object({
          objective: z.string(),
          fields: z.array(z.object({ label: z.string(), value: z.string() })),
          empty: z.boolean(),
        })
        .nullable(),
      // The team task tools' card (T3); null keeps the raw JSON body. Declared
      // in full: an undeclared key is stripped on the way to the row.
      team: z
        .object({
          kind: z.enum(["task", "list"]),
          tasks: z.array(
            z.object({
              id: z.string(),
              subject: z.string(),
              mark: z.enum(["doing", "ready", "blocked", "done"]),
              fields: z.array(z.object({ label: z.string(), value: z.string(), tone: z.literal("warning").optional() })),
              description: z.string(),
            }),
          ),
          caption: z.string(),
          more: z.boolean(),
        })
        .nullable(),
      // The generic card for a row with no detail shape (every MCP call): the
      // arguments and a structured result split into readable entries, plus the
      // complete result JSON for the copy control. Declared in full for the same
      // reason as `team` — an undeclared key is stripped on the way to the row.
      fields: z
        .object({
          args: z.array(
            z.object({
              kind: z.enum(["fact", "text", "json", "code"]),
              label: z.string(),
              value: z.string(),
            }),
          ),
          result: z.array(
            z.object({
              kind: z.enum(["fact", "text", "json", "code"]),
              label: z.string(),
              value: z.string(),
            }),
          ),
          // L2's one-line compression of the result (「已发送」/「超时」), or "".
          receipt: z.string(),
          copyText: z.string(),
          // The skill card's 「结果」caption opt-out (see `ToolFieldsData`).
          hideResultCaption: z.boolean().optional(),
        })
        .nullable(),
      // DSH's failure code and, for a known one, the words drawn for it.
      errorCode: z.string(),
      errorShort: z.string(),
      errorHint: z.string(),
    }),
    Component: InlineToolCall,
  });

  // The rewind report is a plugin timeline row appended by the server half (see
  // `server/rewind-notice-append`), so it needs no transform — only a renderer.
  //
  // This transformer exists for the **old** delivery path: notices the previous
  // implementation wrote into the provider history are rebuilt into the
  // timeline by every conversation rewind and used to stack up there. The
  // report is recognised from the shared copy table and removed; every other
  // notification (the `撤回已生效` canary, open warnings, other providers'
  // notices) is left to the host's own renderer.
  client.addTimelineTransformer({
    id: "dsh-rewind-notice",
    query: { itemType: "notification" },
    transform: ({ item }) => (isLegacyRewindNotice(item.message) ? { items: [] } : undefined),
  });

  client.addTimelineRenderer({
    kind: REWIND_NOTICE_KIND,
    version: REWIND_NOTICE_VERSION,
    schema: rewindNoticeSchema,
    Component: RewindNotice,
  });

  // The stats row under an answer. Upstream's own contribution, kept whole: it
  // only registers a renderer, so it composes with the renderers above instead
  // of competing with them.
  //
  // Both contributions return a cleanup, and **both are kept**. `stream-stats`
  // returns an empty one today, which made discarding it look harmless — but
  // that is an assumption about another module's internals, and the day it grows
  // a real teardown (a timer, a subscription) this line would drop it silently.
  // Composing them costs a line and turns the assumption into code.
  //
  // The goal pill is a second composer pill beside the jobs one: the jobs pill is
  // a live counter that hides when nothing runs, while a goal has to stay visible
  // (and controllable) exactly when it is *not* running — paused, blocked, or
  // active but disarmed after a reopen. One button cannot carry both meanings.
  // The team pill is the third. The composer track scrolls horizontally
  // (host v0.15.3), so all three may be visible together and each decides its
  // own visibility — no cross-pill coordination.
  const workspaceStatus = createWorkspaceStatusStore();
  // The DSH Plugins page. `localeText()` is the fork's client half of the copy
  // tables (`client/locale.ts`): the title registered with the host is the
  // *resolved* string, because on native the host renders contribution titles
  // outside this plugin's boundaries and a message object it cannot resolve is
  // the failure mode the 0.2.22 native-safety work removed. Each registration is
  // guarded on its own: a host that rejects one (unknown icon, unsupported
  // surface) costs that entry only, never the four timeline renderers above.
  const pluginsTitle = localeText().plugins.pageTitle;
  const openDisplaySettings = () => {
    void Promise.resolve()
      .then(() => client.openSettings(DISPLAY_SETTINGS_ID))
      .catch((error) => {
        report("open display settings", error);
      });
  };
  const PluginsScreen = (props: PluginScreenProps) => (
    <DshPluginsPage {...props} openDisplaySettings={openDisplaySettings} />
  );
  const cleanups = [
    contributeStreamStats(client),
    contributeJobsPill(client, workspaceStatus.observer("jobs")),
    contributeGoalPill(client, workspaceStatus.observer("goal")),
    contributeTeamPill(client, workspaceStatus.observer("team")),
    contributeWorkspaceBadges(client, workspaceStatus),
    guardCleanup("timeline settings", () => contributeTimelineSettings(client)),
    guardCleanup("display settings command", () => contributeDisplaySettingsCommand(client)),
    guardCleanup("plugins screen", () =>
      client.addScreen({
        id: PLUGINS_SCREEN_ID,
        title: pluginsTitle,
        Component: PluginsScreen,
      })),
    guardCleanup("plugins sidebar", () =>
      client.addSidebarHeaderItem({
        id: PLUGINS_SCREEN_ID,
        title: pluginsTitle,
        Component: PluginsSidebarItem,
      })),
    () => workspaceStatus.dispose(),
    retainRowEntranceObservers(),
  ];

  // The live witness behind the capsule: a per-agent timeline subscription
  // records which report rows arrived live, so a replayed or refetched row is
  // never toasted (see `client/rewind-notice-live`). The arm RPC is sent now so
  // the server half captures the Paseo API handle before the first rewind — a
  // daemon restart leaves it without one until a hook or RPC fires.
  cleanups.push(
    startRewindLiveMonitor(client.paseo, {
      arm: () => client.rpc(rewindNoticeArm, {}),
      onError: (message, error) => {
        console.error(
          `[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    }),
  );

  // The jobs pill registers one pill and one poll timer per agent, so its
  // cleanup is the one that actually does work today; running them in order
  // keeps the renderer teardown ahead of it if that ever starts to matter.
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
