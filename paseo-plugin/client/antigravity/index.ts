import {
  useTranslation,
  type PluginClientContext,
  type PluginSidebarItemProps,
  type PluginWorkspaceRowBadgeItemProps,
} from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { createElement, useSyncExternalStore, type ComponentType } from "react";
import {
  ASK_QUESTION_TIMELINE_KIND,
  FALLBACK_TIMELINE_KIND,
  SUBAGENT_LIST_TIMELINE_KIND,
  SUBAGENT_TIMELINE_KIND,
  askQuestionCardSchema,
  fallbackEventSchema,
  refreshAccountsRpc,
  subagentCardSchema,
  subagentCheckSchema,
} from "../../shared/antigravity/contracts";
import { AntigravityTabContent, type AntigravityTabProps } from "./AntigravityTab";
import { observeAgents, type AgentObservation } from "./agents";
import { ComposerAccount } from "./composer";
import { errorMessage, messages } from "./messages";
import { AskQuestionRow } from "./questions";
import { QuotaSidebarItem } from "./sidebar";
import { SUBAGENT_PANEL_ID, createSubagentViews } from "./subagents";
import { FallbackNote } from "./timeline";
import {
  createAntigravityTimelineTransforms,
  type AntigravityTimelineTransforms,
} from "./transform";

export type { AntigravityTabProps } from "./AntigravityTab";
export type { AgentObservation, ObservedAgent } from "./agents";
export type {
  AntigravityTimelineTransforms,
  AssistantMessageTimelineItem,
  ToolCallTimelineItem,
} from "./transform";
export { AntigravityTabContent } from "./AntigravityTab";
export { antigravityLogo, antigravityLogoSvg, antigravityMark } from "./logo";
export { QuotaSidebarItem, type QuotaSidebarItemOptions, type QuotaSidebarItemProps } from "./sidebar";
export { SUBAGENT_PANEL_ID } from "./subagents";
export { createAntigravityTimelineTransforms } from "./transform";

export interface ContributeAntigravityClientOptions {
  /** Unified console screen id that hosts the `"antigravity"` tab. */
  readonly consoleScreenId: string;
  /** Called before `openScreen({ screenId, params: { tab: "antigravity" } })` to switch an already-mounted console. */
  readonly onOpenAntigravityTab?: () => void;
  /** Initial visibility for the sidebar footer quota bar before capabilities resolve (default `false`). */
  readonly initialVisible?: boolean;
  /** Optional external reactive visibility getter (paired with `subscribeVisibility`). */
  readonly isVisible?: () => boolean;
  /** Optional external reactive visibility subscriber (paired with `isVisible`). */
  readonly subscribeVisibility?: (listener: () => void) => () => void;
}

export interface AntigravityClientHandle {
  readonly dispose: () => void;
  readonly observation: AgentObservation;
  readonly AntigravityTab: ComponentType<AntigravityTabProps>;
  readonly transformToolCall: AntigravityTimelineTransforms["transformToolCall"];
  /** Updates sidebar footer visibility reactively once `capabilitiesGetRpc` resolves. */
  readonly setVisible: (visible: boolean) => void;
}

/**
 * Registers Antigravity's client-side contributions inside `dsh-paseo`:
 * - Timeline renderers (`antigravity-fallback`, `antigravity-subagent`,
 *   `antigravity-subagents-check`, `antigravity-ask-question`)
 * - `assistant_message` echo-suppression transformer for `ask_question`
 * - Draft/New-workspace composer account selector (`account`)
 * - Subagents agent panel (`subagents`)
 * - Running subagents workspace row badge (`running-subagents`)
 * - Refresh Antigravity quotas command center item (`refresh-quotas`)
 * - Conditional Sidebar Footer quota bar (hidden when `!visible`)
 *
 * Returns `{ dispose, observation, AntigravityTab, transformToolCall, setVisible }`
 * so `index.client.tsx` can embed `AntigravityTab` in the unified Console and run
 * `transformToolCall` deterministically before `dsh-inline-tool`.
 */
export function contributeAntigravityClient(
  client: PluginClientContext,
  opts: ContributeAntigravityClientOptions,
): AntigravityClientHandle {
  const onOpenAntigravity = opts.onOpenAntigravityTab ?? (() => undefined);

  let internalVisible = opts.initialVisible ?? false;
  const visibilityListeners = new Set<() => void>();
  const getVisible = opts.isVisible ?? (() => internalVisible);
  const subscribeVisible =
    opts.subscribeVisibility ??
    ((listener: () => void) => {
      visibilityListeners.add(listener);
      return () => {
        visibilityListeners.delete(listener);
      };
    });

  function setVisible(next: boolean) {
    if (internalVisible === next) return;
    internalVisible = next;
    visibilityListeners.forEach((listener) => listener());
  }

  const subagents = createSubagentViews(client);
  const observation = observeAgents(client, subagents.open, {
    consoleScreenId: opts.consoleScreenId,
    onOpenAntigravityTab: onOpenAntigravity,
  });
  const transforms = createAntigravityTimelineTransforms();

  function AntigravityTab(props: AntigravityTabProps) {
    observation.useNotifications();
    return createElement(AntigravityTabContent, { ...props, observation });
  }

  function Sidebar(props: PluginSidebarItemProps) {
    observation.useNotifications();
    const visible = useSyncExternalStore(subscribeVisible, getVisible);
    return createElement(QuotaSidebarItem, {
      ...props,
      consoleScreenId: opts.consoleScreenId,
      onOpenAntigravity,
      visible,
    });
  }

  function Composer() {
    observation.useNotifications();
    return createElement(ComposerAccount);
  }

  function SubagentsWorkspaceBadge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
    const { t } = useTranslation(messages);
    const byWorkspace = useSyncExternalStore(observation.subscribe, observation.workspaceRunningSubagents);
    const running = byWorkspace.get(workspaceId) ?? 0;
    if (!running) return null;
    return createElement(WorkspaceRowBadge, {
      icon: "Bot",
      tone: "info",
      label: t("subagents.workspaceBadge", { count: running }),
    });
  }

  const cleanups = [
    client.addSidebarFooterItem({
      id: "antigravity-quota",
      title: messages.message("title"),
      Component: Sidebar,
    }),
    client.addWorkspaceRowBadgeItem({
      id: "running-subagents",
      title: messages.message("subagents.title"),
      icon: "Bot",
      Component: SubagentsWorkspaceBadge,
    }),
    client.addCommandCenterItem({
      id: "refresh-quotas",
      title: messages.message("commandRefresh"),
      icon: "RefreshCw",
      context: "global",
      onSelect: async ({ rpc }) => {
        try {
          await rpc(refreshAccountsRpc, {});
          observation.notify(client.i18n.t(messages, "commandRefreshed"));
        } catch (error) {
          observation.notify(errorMessage(error));
        }
      },
    }),
    client.addComposerItem({ id: "account", Component: Composer }),
    client.addTimelineRenderer({
      kind: FALLBACK_TIMELINE_KIND,
      version: 1,
      schema: fallbackEventSchema,
      Component: FallbackNote,
    }),
    client.addTimelineRenderer({
      kind: SUBAGENT_TIMELINE_KIND,
      version: 1,
      schema: subagentCardSchema,
      Component: subagents.SubagentCardRow,
    }),
    client.addTimelineRenderer({
      kind: SUBAGENT_LIST_TIMELINE_KIND,
      version: 1,
      schema: subagentCheckSchema,
      Component: subagents.SubagentCheckRow,
    }),
    client.addTimelineRenderer({
      kind: ASK_QUESTION_TIMELINE_KIND,
      version: 1,
      schema: askQuestionCardSchema,
      Component: AskQuestionRow,
    }),
    transforms.registerEchoTransform(client),
    client.addAgentPanel({
      id: SUBAGENT_PANEL_ID,
      title: messages.message("subagents.title"),
      icon: "Bot",
      Component: subagents.SubagentsPanel,
    }),
  ];

  function dispose() {
    observation.stop();
    visibilityListeners.clear();
    for (const remove of cleanups) {
      void remove();
    }
  }

  return {
    dispose,
    observation,
    AntigravityTab,
    transformToolCall: transforms.transformToolCall,
    setVisible,
  };
}
