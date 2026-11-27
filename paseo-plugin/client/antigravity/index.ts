import type {
  PluginClientContext,
  PluginSidebarItemProps,
  PluginWorkspaceRowBadgeItemProps,
} from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { createElement, useSyncExternalStore, type ComponentType } from "react";
import {
  ASK_QUESTION_TIMELINE_KIND,
  FALLBACK_TIMELINE_KIND,
  STEPS_TIMELINE_KIND,
  SUBAGENT_LIST_TIMELINE_KIND,
  SUBAGENT_TIMELINE_KIND,
  askQuestionCardSchema,
  fallbackEventSchema,
  refreshAccountsRpc,
  stepsCardSchema,
  subagentCardSchema,
  subagentCheckSchema,
} from "../../shared/antigravity/contracts";
import { SUBAGENTS_ARCHIVED_METADATA_KEY } from "../../shared/pill-metadata";
import { subscribeLocale } from "../locale";
import { AntigravityTabContent, type AntigravityTabProps } from "./AntigravityTab";
import { observeAgents, type AgentObservation } from "./agents";
import { ComposerAccount } from "./composer";
import { errorMessage, translateAntigravity, useAntigravityTranslation } from "./messages";
import { AskQuestionRow } from "./questions";
import { QuotaSidebarItem } from "./sidebar";
import { createStepsViews } from "./steps";
import { createStepsStore } from "./stepsModel";
import { SUBAGENT_PANEL_ID, SUBAGENT_SCREEN_ID, createSubagentViews } from "./subagents";
import { createSubagentsArchiveStore } from "./subagentsArchive";
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
export { SUBAGENT_PANEL_ID, SUBAGENT_SCREEN_ID } from "./subagents";
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

  const translate = (key: string): string =>
    typeof translateAntigravity === "function" ? translateAntigravity(key) : key;

  function registerLiveTitle(
    label: string,
    titleOf: () => string,
    register: (title: string) => () => void,
  ): () => void {
    let currentTitle = titleOf();
    let remove = register(currentTitle);
    let disposed = false;
    const unsubscribe = subscribeLocale(() => {
      if (disposed) return;
      const nextTitle = titleOf();
      if (nextTitle === currentTitle) return;
      currentTitle = nextTitle;
      try {
        const prevRemove = remove;
        remove = () => {};
        prevRemove();
        remove = register(nextTitle);
      } catch (error) {
        console.warn(`[dsh-paseo:antigravity] ${label} failed`, error);
      }
    });
    return () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      remove();
    };
  }

  const subagentsArchive = createSubagentsArchiveStore({
    write: (agentId, raw) =>
      client.paseo.agents.ref(agentId).setMetadata({ [SUBAGENTS_ARCHIVED_METADATA_KEY]: raw }),
    onError: (message, error) => {
      console.warn(`[dsh-paseo:antigravity] ${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  const subagents = createSubagentViews(client, subagentsArchive);
  const stepsStore = createStepsStore();
  const stepsViews = createStepsViews(stepsStore);
  const observation = observeAgents(
    client,
    subagents.open,
    subagents.makePopover,
    {
      consoleScreenId: opts.consoleScreenId,
      onOpenAntigravityTab: onOpenAntigravity,
    },
    {
      store: stepsStore,
      makePopover: stepsViews.makePopover,
    },
    subagentsArchive,
  );
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
    const { t } = useAntigravityTranslation();
    const byWorkspace = useSyncExternalStore(observation.subscribe, observation.workspaceRunningSubagents);
    const running = byWorkspace.get(workspaceId) ?? 0;
    if (!running) return null;
    return createElement(WorkspaceRowBadge, {
      icon: "Bot",
      tone: "info",
      label: t("subagents.workspaceBadge"),
      accessibilityLabel: t("subagents.workspaceBadgeA11y", { count: running }),
    });
  }

  const cleanups = [
    registerLiveTitle(
      "antigravity quota sidebar title refresh",
      () => translate("title"),
      (title) =>
        client.addSidebarFooterItem({
          id: "antigravity-quota",
          title,
          Component: Sidebar,
        }),
    ),
    registerLiveTitle(
      "antigravity subagents badge title refresh",
      () => translate("subagents.title"),
      (title) =>
        client.addWorkspaceRowBadgeItem({
          id: "running-subagents",
          title,
          icon: "Bot",
          Component: SubagentsWorkspaceBadge,
        }),
    ),
    registerLiveTitle(
      "antigravity refresh quotas command title refresh",
      () => translate("commandRefresh"),
      (title) =>
        client.addCommandCenterItem({
          id: "refresh-quotas",
          title,
          icon: "RefreshCw",
          context: "global",
          onSelect: async ({ rpc }) => {
            try {
              await rpc(refreshAccountsRpc, {});
              observation.notify(translate("commandRefreshed"));
            } catch (error) {
              observation.notify(errorMessage(error));
            }
          },
        }),
    ),
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
    client.addTimelineRenderer({
      kind: STEPS_TIMELINE_KIND,
      version: 1,
      schema: stepsCardSchema,
      Component: stepsViews.StepsTimelineRow,
    }),
    transforms.registerEchoTransform(client),
    registerLiveTitle(
      "antigravity subagents screen title refresh",
      () => translate("subagents.title"),
      (title) =>
        client.addScreen({
          id: SUBAGENT_SCREEN_ID,
          title,
          Component: subagents.SubagentsScreen,
        }),
    ),
  ];

  function dispose() {
    observation.stop();
    stepsStore.clear();
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
