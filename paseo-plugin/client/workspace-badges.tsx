/** Native sidebar badges fed by the existing three pill observers, with no extra subscription. */
import type { PluginClientContext, PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useCallback, useSyncExternalStore } from "react";
import { localeText } from "./locale";
import { BADGE_PRIORITY, type WorkspaceBadgeKind, type WorkspaceBadgeState, type WorkspaceStatusStore } from "./workspace-status";

const ICONS = { goal: "Target", team: "Users", jobs: "Terminal" } as const;

/** Counts belong to the accessible description; short visible labels remain fixed. */
export function workspaceBadgePresentation(kind: WorkspaceBadgeKind, state: WorkspaceBadgeState | null) {
  if (state === null) return null;
  const text = localeText().workspaceBadge;
  return {
    icon: kind === "goal" && state.tone === "success" ? "Check" : ICONS[kind],
    label: text[kind],
    tone: state.tone,
    accessibilityLabel: `${text[kind]}: ${[
      ...(state.readFailures > 0 ? [text.count(state.readFailures, text.readFailure)] : []),
      ...BADGE_PRIORITY.flatMap((tone) => {
        const count = state.counts[tone] - (tone === "danger" ? state.readFailures : 0);
        return count > 0 ? [text.count(count, kind === "goal" && tone === "danger" ? text.blocked : text.states[tone])] : [];
      }),
    ].join(text.separator)}`,
  };
}

export function contributeWorkspaceBadges(client: PluginClientContext, store: WorkspaceStatusStore): () => void {
  if (typeof client.addWorkspaceRowBadgeItem !== "function") {
    console.warn(`[dsh-paseo] ${localeText().workspaceBadge.unavailable}`);
    return () => {};
  }
  const remove = (["goal", "team", "jobs"] as const).map((kind) => {
    function Badge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
      const subscribe = useCallback((listener: () => void) => store.subscribe(workspaceId, listener), [workspaceId]);
      const snapshot = useCallback(() => store.getSnapshot(workspaceId)[kind], [workspaceId]);
      const state = useSyncExternalStore(subscribe, snapshot, snapshot);
      const props = workspaceBadgePresentation(kind, state);
      return props === null ? null : <WorkspaceRowBadge {...props} />;
    }
    return client.addWorkspaceRowBadgeItem({ id: `dsh-${kind}`, title: localeText().workspaceBadge[kind], icon: ICONS[kind], Component: Badge });
  });
  return () => { for (const dispose of remove) dispose(); };
}
