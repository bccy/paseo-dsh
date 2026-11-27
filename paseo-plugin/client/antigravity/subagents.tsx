import {
  useAgent,
  useRpc,
  type PluginButtonContentProps,
  type PluginClientContext,
  type PluginScreenProps,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { Icon, Markdown, ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
  type ScrollView as NativeScrollView,
} from "react-native";
import {
  extractSwarmBriefLabel,
  isAntigravityProvider,
  listSubagentsRpc,
  subagentArtifactRpc,
  subagentDetailRpc,
  type SubagentArtifactInfo,
  type SubagentCard,
  type SubagentCheck,
  type SubagentState,
  type SubagentSummary,
  type TranscriptEntry,
} from "../../shared/antigravity/contracts";
import {
  estimateRequestCost,
  resolveEffectiveRates,
  resolvePricingKey as resolveAntigravityPricingKey,
  type AntigravityModelRates,
} from "../../shared/antigravity/pricing-defaults";
import {
  calculateCallCost,
  convertCurrency,
  pricingGetRpc,
  type Currency,
  type PricingState,
} from "../../shared/pricing";
import { Badge } from "../console-ui";
import { toolLabel } from "../tool-call-data";
import {
  CHEVRON_BOX,
  FACTS_FONT_SIZE,
  MARK_BOX,
  MARK_DOT_SIZE,
  TITLE_FONT_SIZE,
  chevronColorToken,
  chevronRotation,
  popoverRootBox,
  ringColorFor,
  rowActiveFill,
  rowBox,
  rowTextColumn,
} from "../jobs-popover-layout";
import {
  POPOVER_DETAIL_TITLE_LINE,
  POPOVER_DETAIL_TITLE_SIZE,
  PopoverHairline,
  PopoverPill,
  PopoverSectionHeader,
  type PopoverPillTone,
  type PopoverTheme,
} from "../popover-ui";
import { StatusRingMark } from "../status-ring";
import { SUBAGENTS_ARCHIVED_METADATA_KEY } from "../../shared/pill-metadata";
import { clockTime, duration, money, tokens, upper } from "./format";
import { antigravityLogoSvg } from "./logo";
import { errorMessage, useAntigravityTranslation } from "./messages";
import {
  createSubagentsArchiveStore,
  isSubagentArchived,
  partitionSubagents,
  type SubagentsArchiveStore,
} from "./subagentsArchive";
import { font, mono, radius, space, tabular, tint, toneColor, type Colors, type Tone } from "./theme";

export const SUBAGENT_PANEL_ID = "subagents";
export const SUBAGENT_SCREEN_ID = "antigravity-subagents";

type ShownState = SubagentState | "starting";
type ListFilter = "all" | "running" | "failed" | "archived";
type ActivityFilter = "all" | "tools" | "errors";
type HoverState = PressableStateCallbackType & { hovered?: boolean };

function useMessages() {
  return useAntigravityTranslation();
}
type Translate = ReturnType<typeof useMessages>["t"];

const STATE_TONE: Record<ShownState, Tone> = {
  running: "accent",
  starting: "accent",
  done: "success",
  stopped: "neutral",
  failed: "danger",
  idle: "warning",
};

const STATE_ICON: Record<ShownState, string> = {
  running: "CircleDot",
  starting: "CircleDashed",
  done: "CircleCheck",
  stopped: "CircleSlash",
  failed: "CircleAlert",
  idle: "Hourglass",
};

/** Which subagent a panel should show when it opens, per agent. */
const requested = new Map<string, string>();

export function useSubagents(agentId: string, enabled = true) {
  const list = useRpc(listSubagentsRpc);
  return useQuery({
    queryKey: ["antigravity-accounts", "subagents", agentId],
    queryFn: () => list({ agentId }),
    enabled,
    staleTime: 1000,
    refetchInterval: (query) =>
      query.state.data?.subagents.some((subagent) => subagent.state === "running") ? 3000 : 15000,
  });
}

function useUnifiedPricing() {
  const read = useRpc(pricingGetRpc);
  return useQuery({
    queryKey: ["dsh-paseo", "pricing"],
    queryFn: () => read({}),
    staleTime: 60_000,
  });
}

function toolIcon(name: string): string {
  if (/command|terminal|shell/.test(name)) return "SquareTerminal";
  if (/edit|write|replace|create/.test(name)) return "FilePen";
  if (/read|view/.test(name)) return "FileText";
  if (/grep|find|search_(code|files)/.test(name)) return "Search";
  if (/web|url|browser|fetch|search/.test(name)) return "Globe";
  if (name === "send_message") return "Send";
  if (/subagent/.test(name)) return "Bot";
  if (/list_dir|directory/.test(name)) return "FolderOpen";
  return "Wrench";
}

function since(start: string | null, end: string | null, locale: string): string | null {
  return duration(start, end, locale);
}

function clock(at: string | null, locale: string): string {
  if (!at) return "";
  return clockTime(at, locale, true);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function shownState(summary: SubagentSummary | undefined, status: SubagentCard["status"]): ShownState {
  if (summary) return summary.state;
  if (status === "failed") return "failed";
  if (status === "canceled") return "stopped";
  return "starting";
}

function statusBadgeIcon(state: ShownState, color: string): string | ReactNode {
  if (state === "running" || state === "starting") {
    return <StatusRingMark size={12} ring={10} color={color} />;
  }
  return STATE_ICON[state];
}

function estimateSubagentCost(
  summary: SubagentSummary,
  pricing: PricingState | undefined,
): { cost: number; currency: Currency } | null {
  if (!summary.model) return null;
  const total = summary.inputTokens + summary.cachedTokens + summary.outputTokens;
  if (total <= 0) return null;

  const at = summary.startedAt ? Date.parse(summary.startedAt) : Date.now();
  const effectiveAt = Number.isFinite(at) ? at : Date.now();

  // Prefer the unified dual-currency pricing store when loaded.
  if (pricing) {
    const priced = calculateCallCost(
      {
        model: summary.model,
        tokens: {
          input: summary.inputTokens,
          cached: summary.cachedTokens,
          output: summary.outputTokens,
        },
        at: effectiveAt,
      },
      {
        displayCurrency: pricing.displayCurrency,
        usdToCnyRate: pricing.usdToCnyRate,
        overrides: pricing.overrides,
      },
    );
    if (priced.priced && priced.cost !== null) {
      return { cost: priced.cost, currency: priced.displayCurrency };
    }
  }

  // Fallback to Antigravity's built-in reference rates (converted if displayCurrency is CNY).
  const key = resolveAntigravityPricingKey(summary.model, summary.model);
  const rates = resolveEffectiveRates(key, effectiveAt, {});
  if (!rates) return null;
  const baseRates: AntigravityModelRates = { input: rates.input, cached: rates.cached, output: rates.output };
  const usdCost = estimateRequestCost(
    { input: summary.inputTokens, cached: summary.cachedTokens, output: summary.outputTokens },
    baseRates,
  );
  if (pricing && pricing.displayCurrency === "CNY") {
    return {
      cost: convertCurrency(usdCost, "USD", "CNY", pricing.usdToCnyRate),
      currency: "CNY",
    };
  }
  return { cost: usdCost, currency: "USD" };
}

/** "86 steps · 9m · 50K out · ~$0.18" */
function metaLine(
  summary: SubagentSummary,
  t: Translate,
  locale: string,
  pricing?: PricingState,
): string {
  const parts = [t("subagents.steps", { count: summary.steps })];
  const end =
    summary.reportedAt && summary.updatedAt
      ? Date.parse(summary.reportedAt) >= Date.parse(summary.updatedAt)
        ? summary.reportedAt
        : summary.updatedAt
      : (summary.reportedAt ?? summary.updatedAt);
  const took = since(summary.startedAt, end, locale);
  if (took) parts.push(took);
  if (summary.outputTokens) parts.push(t("subagents.output", { value: tokens(summary.outputTokens) }));
  const est = estimateSubagentCost(summary, pricing);
  if (est !== null) parts.push(`~${money(est.cost, est.currency, locale)}`);
  return parts.join(" · ");
}

const SWARM_ACTION_LABELS_ZH: ReadonlyMap<string, string> = new Map([
  ["add", "添加成员"],
  ["kill", "停止成员"],
  ["kill_all", "停止全部"],
  ["status", "查看状态"],
  ["title", "设置主题"],
  ["model", "切换模型"],
  ["models", "查看模型"],
  ["list", "查看列表"],
]);

const SWARM_ROLE_LABELS_ZH: ReadonlyMap<string, string> = new Map([
  ["monitor", "监工"],
  ["verifier", "复审员"],
  ["reviewer", "复审员"],
  ["auditor", "审查员"],
  ["audit", "审查员"],
  ["researcher", "调研员"],
  ["research", "调研员"],
  ["implementer", "实现员"],
  ["builder", "实现员"],
  ["coder", "实现员"],
  ["developer", "开发员"],
  ["fixer", "修复员"],
  ["tester", "测试员"],
  ["qa", "测试员"],
  ["planner", "规划员"],
  ["writer", "文档员"],
  ["docs", "文档员"],
  ["worker", "蜂群成员"],
  ["coordinator", "协调者"],
]);

function localizeSwarmRosterName(name: string | null | undefined, locale: string): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (!locale.toLowerCase().startsWith("zh")) return trimmed;
  const lower = trimmed.toLowerCase();
  const exact = SWARM_ROLE_LABELS_ZH.get(lower);
  if (exact) return exact;
  const numbered = /^([a-z][a-z0-9_-]*?)[-_](\d+)$/.exec(lower);
  if (numbered) {
    const base = SWARM_ROLE_LABELS_ZH.get(numbered[1]!);
    if (base) return `${base} ${numbered[2]}`;
  }
  return trimmed;
}

function displaySubagentName(
  subagent: Pick<SubagentSummary, "id" | "role" | "displayName" | "type" | "origin">,
  t: Translate,
  locale: string,
): string {
  const custom = subagent.displayName?.trim();
  if (custom) return custom;
  if (subagent.origin === "swarm" && subagent.role) {
    return localizeSwarmRosterName(subagent.role, locale) ?? subagent.role;
  }
  const typeLabel = subagentTypeLabel(subagent.type, t);
  return subagent.role ?? typeLabel ?? subagent.id.slice(0, 8);
}

function localizeActivity(activity: string | null, locale: string): string | null {
  if (!activity) return null;
  const sep = " · ";
  const idx = activity.indexOf(sep);
  if (idx === -1) return toolLabel(activity);
  const head = activity.slice(0, idx);
  const rawTail = activity.slice(idx + sep.length);
  const mappedTail =
    locale.toLowerCase().startsWith("zh") && (head === "swarm" || head === "manage_subagents")
      ? SWARM_ACTION_LABELS_ZH.get(rawTail.toLowerCase())
      : undefined;
  const tail = mappedTail ?? rawTail;
  return `${toolLabel(head)}${sep}${tail}`;
}

const KNOWN_SUBAGENT_TYPES = new Set(["research", "self", "image-generator", "worker", "monitor", "swarm"]);

function subagentTypeLabel(type: string | null | undefined, t: Translate): string | null {
  if (!type) return null;
  const normalized = type.trim().toLowerCase();
  if (KNOWN_SUBAGENT_TYPES.has(normalized)) {
    return t(`subagents.type.${normalized}`);
  }
  return type;
}

function activityLine(summary: SubagentSummary | undefined, t: Translate, locale: string): string | null {
  if (!summary) return null;
  if (summary.state === "running" && summary.phase === "thinking") return t("subagents.thinking");
  return localizeActivity(summary.activity, locale);
}

function transcriptToMarkdown(
  summary: SubagentSummary,
  entries: readonly TranscriptEntry[],
  report: string | null,
  t: Translate,
  locale: string,
): string {
  const lines: string[] = [
    `# ${displaySubagentName(summary, t, locale)}`,
    "",
    `- **ID**: \`${summary.id}\``,
    `- **${t("subagents.markdown.state")}**: ${t(`subagents.state.${summary.state}`)}`,
    summary.model ? `- **${t("subagents.markdown.model")}**: ${summary.model}` : "",
    `- **${t("subagents.markdown.tokens")}**: ${summary.inputTokens} ${t("subagents.tokens.input")} / ${summary.cachedTokens} ${t("subagents.tokens.cached")} / ${summary.outputTokens} ${t("subagents.tokens.output")}`,
    "",
  ].filter(Boolean);
  if (report) {
    lines.push(`## ${t("subagents.markdown.report")}`, "", report, "");
  }
  lines.push(`## ${t("subagents.markdown.transcript")}`, "");
  for (const entry of entries) {
    const stamp = entry.at ? `[${entry.at}] ` : "";
    lines.push(`### ${stamp}${t("subagents.markdown.step", { index: entry.index })}`);
    if (entry.text) lines.push("", entry.text);
    for (const tool of entry.tools) {
      const label = toolLabel(tool.name);
      lines.push(`- \`${label}\` ${tool.summary}${tool.failed ? ` (${t("subagents.markdown.failed")})` : ""}`);
      if (tool.output) lines.push("```", tool.output, "```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

function FilterChip({
  colors,
  label,
  active,
  onPress,
}: {
  colors: Colors;
  label: string;
  active: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        paddingHorizontal: space.sm,
        height: 24,
        borderRadius: radius.pill,
        justifyContent: "center",
        backgroundColor: active ? tint(colors.accent, 0.16) : tint(colors.foreground, 0.06),
      }}
    >
      <Text style={{ ...font.caption, fontWeight: "500", color: active ? colors.accent : colors.foregroundMuted }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function createSubagentViews(
  client: PluginClientContext,
  subagentsArchive?: SubagentsArchiveStore,
) {
  const archiveStore =
    subagentsArchive ??
    createSubagentsArchiveStore({
      write: (agentId, raw) =>
        client.paseo.agents.ref(agentId).setMetadata({ [SUBAGENTS_ARCHIVED_METADATA_KEY]: raw }),
      onError: (message, error) => {
        console.warn(`[dsh-paseo:antigravity] ${message}: ${error instanceof Error ? error.message : String(error)}`);
      },
    });

  function useArchivedSubagents(agentId: string): ReadonlySet<string> {
    const metadata = useAgent(agentId, (snapshot) => snapshot.metadata);
    useEffect(() => {
      if (agentId) archiveStore.observe(agentId, metadata);
    }, [agentId, metadata]);
    return useSyncExternalStore(archiveStore.subscribe, () => archiveStore.get(agentId));
  }

  function open(agentId: string, _workspaceId?: string | null, subagentId?: string) {
    if (!agentId) return;
    if (subagentId) requested.set(agentId, subagentId);
    else requested.delete(agentId);
    client.openScreen({
      screenId: SUBAGENT_SCREEN_ID,
      params: {
        agentId,
        ...(subagentId ? { subagentId } : {}),
      },
    });
  }

  function insertIntoComposer(agentId: string, text: string): boolean {
    const composers = client.composers({ agentId });
    const composer = composers[0];
    if (!composer) return false;
    composer.insertText(text);
    void composer.focus().catch(() => undefined);
    return true;
  }

  // ---- Timeline: the row of an `invoke_subagent` / `swarm` add call ----------------------------

  function SubagentCardRow({ agentId, item, theme }: PluginTimelineItemProps<SubagentCard>) {
    const { colors } = theme;
    const { t, locale } = useAntigravityTranslation();
    const toast = useToast();
    const readDetail = useRpc(subagentDetailRpc);
    const query = useSubagents(agentId);
    const pricing = useUnifiedPricing();
    const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
    const [expanded, setExpanded] = useState(false);
    const card = item.data;
    const summary = useMemo(() => {
      const subagents = query.data?.subagents;
      if (!subagents?.length) return undefined;
      if (card.id) {
        return subagents.find((subagent) => subagent.id === card.id);
      }
      const taskPrefix = card.task.replace(/…$/, "").trim().slice(0, 80);
      return subagents.find((subagent) => {
        if (card.origin && subagent.origin && subagent.origin !== card.origin) return false;
        if (card.role && subagent.role && subagent.role !== card.role) return false;
        const bothSwarm = card.origin === "swarm" && subagent.origin === "swarm";
        if (!bothSwarm && card.type && subagent.type && subagent.type !== card.type) return false;
        const candidateTask = subagent.task.trim();
        if (!taskPrefix || !candidateTask) return Boolean(card.role && subagent.role === card.role);
        return (
          candidateTask.startsWith(taskPrefix) ||
          taskPrefix.startsWith(candidateTask.slice(0, 80))
        );
      });
    }, [query.data?.subagents, card.id, card.origin, card.role, card.type, card.task]);
    const state = shownState(summary, card.status);
    const statusTone = STATE_TONE[state];
    const statusColor = toneColor(colors, statusTone);
    const activity = activityLine(summary, t, locale);
    const thinking = summary?.state === "running" && summary.phase === "thinking";
    const resolvedRole = summary?.role ?? card.role ?? null;
    const isSwarm = summary?.origin === "swarm" || card.origin === "swarm";
    const typeLabel = subagentTypeLabel(summary?.type ?? card.type, t);
    const title = summary
      ? displaySubagentName(summary, t, locale)
      : (isSwarm ? extractSwarmBriefLabel(card.task) ?? localizeSwarmRosterName(card.role, locale) : card.role) ??
        typeLabel ??
        t("subagents.title");
    const targetId = summary?.id || card.id || undefined;

    const detailQuery = useQuery({
      queryKey: ["antigravity-accounts", "subagent", agentId, targetId],
      queryFn: () => readDetail({ agentId, subagentId: targetId! }),
      enabled: expanded && Boolean(targetId),
      staleTime: 1000,
      refetchInterval: expanded && state === "running" ? 3000 : false,
    });
    const detail = detailQuery.data;
    const fullTask = detail?.entries.find((entry) => entry.kind === "task")?.text || summary?.task || card.task;
    const reportText = detail?.report?.trim() ?? "";

    return (
      <View
        style={{
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface1,
          overflow: "hidden",
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title} · ${t(`subagents.state.${state}`)}`}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((prev) => !prev)}
          style={(pressState) => ({
            flexDirection: "row",
            alignItems: "flex-start",
            gap: space.sm + 2,
            paddingHorizontal: space.md,
            paddingVertical: space.sm + 2,
            backgroundColor: (pressState as { hovered?: boolean }).hovered || pressState.pressed
              ? tint(colors.foreground, 0.04)
              : "transparent",
          })}
        >
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: radius.md,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: tint(statusColor, 0.13),
              flexShrink: 0,
            }}
          >
            <Icon name="Bot" size={15} color={statusColor} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: colors.foreground, flexShrink: 1 }}>
                  {title}
                </Text>
                {isSwarm ? (
                  <Badge colors={colors} label={t("subagents.swarmTag")} tone="neutral" style={{ flexShrink: 0 }} />
                ) : typeLabel && resolvedRole ? (
                  <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted, flexShrink: 2 }}>
                    {typeLabel}
                  </Text>
                ) : null}
              </View>
              <Badge
                colors={colors}
                tone={statusTone}
                icon={statusBadgeIcon(state, statusColor)}
                label={t(`subagents.state.${state}`)}
                style={{ flexShrink: 0 }}
              />
            </View>
            {!expanded && card.task ? (
              <Text numberOfLines={2} style={{ ...font.caption, color: colors.foregroundMuted }}>
                {card.task}
              </Text>
            ) : null}
            {activity ? (
              <Text
                numberOfLines={1}
                style={
                  thinking
                    ? { ...font.caption, color: colors.foregroundMuted, fontStyle: "italic" }
                    : { ...font.caption, color: colors.foreground, fontFamily: mono }
                }
              >
                {activity}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: 2 }}>
              <Text numberOfLines={1} style={{ ...font.caption, ...tabular, color: colors.foregroundMuted, flex: 1 }}>
                {summary ? metaLine(summary, t, locale, pricing.data) : ""}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <Text style={{ ...font.caption, fontWeight: "500", color: colors.foregroundMuted }}>
                  {expanded ? t("subagents.less") : t("subagents.more")}
                </Text>
                <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={13} color={colors.foregroundMuted} />
              </View>
            </View>
          </View>
        </Pressable>

        {expanded ? (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: tint(colors.border, 0.7),
              paddingHorizontal: space.md,
              paddingVertical: space.sm + 2,
              gap: space.sm + 2,
            }}
          >
            {fullTask ? (
              <View style={{ gap: 4 }}>
                <Text style={{ ...font.caption, fontWeight: "600", color: colors.foregroundMuted }}>
                  {t("subagents.task")}
                </Text>
                <Expandable colors={colors} height={108} background={colors.surface1} t={t}>
                  <Text selectable style={{ ...font.caption, color: colors.foreground, lineHeight: 18 }}>
                    {fullTask}
                  </Text>
                </Expandable>
              </View>
            ) : null}

            {detailQuery.isLoading && !detail ? (
              <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("loading")}</Text>
            ) : detailQuery.error && !detail ? (
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                <Text selectable style={{ ...font.caption, color: colors.statusDanger, flex: 1 }}>
                  {errorMessage(detailQuery.error)}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("retry")}
                  onPress={(event) => {
                    (event as { stopPropagation?: () => void })?.stopPropagation?.();
                    void detailQuery.refetch();
                  }}
                  style={{ paddingHorizontal: space.xs + 2, paddingVertical: 2 }}
                >
                  <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>{t("retry")}</Text>
                </Pressable>
              </View>
            ) : reportText ? (
              <View style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={{ ...font.caption, fontWeight: "600", color: colors.foregroundMuted }}>
                    {t("subagents.report")}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("subagents.copy")}
                    onPress={(event) => {
                      (event as { stopPropagation?: () => void })?.stopPropagation?.();
                      void copyText(reportText).then(() => toast.show(t("subagents.copied"), { durationMs: 2500 }));
                    }}
                    style={(pressState) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                      paddingHorizontal: 6,
                      height: 22,
                      borderRadius: radius.sm,
                      backgroundColor: (pressState as { hovered?: boolean }).hovered || pressState.pressed
                        ? tint(colors.foreground, 0.07)
                        : "transparent",
                    })}
                  >
                    <Icon name="Copy" size={12} color={colors.foregroundMuted} />
                    <Text style={{ ...font.caption, fontWeight: "500", color: colors.foregroundMuted }}>
                      {t("subagents.copy")}
                    </Text>
                  </Pressable>
                </View>
                <Expandable colors={colors} height={220} background={colors.surface1} t={t}>
                  <Markdown>{reportText}</Markdown>
                </Expandable>
              </View>
            ) : state === "running" || state === "starting" ? (
              <Text style={{ ...font.caption, color: colors.foregroundMuted, fontStyle: "italic" }}>
                {t("subagents.runningNoReport")}
              </Text>
            ) : null}

            {workspaceId ? (
              <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("subagents.openInTab")}
                  onPress={(event) => {
                    (event as { stopPropagation?: () => void })?.stopPropagation?.();
                    open(agentId, workspaceId, targetId);
                  }}
                  style={(pressState) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingHorizontal: 8,
                    height: 24,
                    borderRadius: radius.sm,
                    backgroundColor: (pressState as { hovered?: boolean }).hovered || pressState.pressed
                      ? tint(colors.accent, 0.14)
                      : tint(colors.accent, 0.08),
                  })}
                >
                  <Icon name="PanelRightOpen" size={12} color={colors.accent} />
                  <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>
                    {t("subagents.openInTab")}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  // ---- Timeline: the row of a `manage_subagents` / `swarm` control call ------------------------

  function SubagentCheckRow({ agentId, item, theme }: PluginTimelineItemProps<SubagentCheck>) {
    const { colors } = theme;
    const { t, locale } = useAntigravityTranslation();
    const check = item.data;
    const killed = check.action === "kill" || check.action === "kill_all" || check.action === "swarm:kill";
    const isSwarm = check.action.startsWith("swarm:");
    const showNames = killed || check.action === "swarm:model";
    const subagentsQuery = useSubagents(agentId, showNames && isSwarm);
    const swarmDisplayByKey = useMemo(() => {
      const map = new Map<string, string>();
      for (const s of subagentsQuery.data?.subagents ?? []) {
        const label = displaySubagentName(s, t, locale);
        map.set(s.id, label);
        if (s.role) map.set(s.role, label);
      }
      return map;
    }, [subagentsQuery.data?.subagents, t, locale]);
    const title =
      check.action === "kill_all"
        ? check.states.length > 0
          ? t("subagents.check.killAllCount", { count: check.states.length })
          : t("subagents.check.killAll")
        : check.action === "kill"
          ? t("subagents.check.kill", { count: check.states.length })
          : check.action === "list"
            ? t("subagents.check.list")
            : check.action === "swarm:status"
              ? t("subagents.check.swarmStatus")
              : check.action === "swarm:kill"
                ? t("subagents.check.swarmKill", { count: Math.max(1, check.states.length) })
                : check.action === "swarm:title"
                  ? t("subagents.check.swarmTitle")
                  : check.action === "swarm:model"
                    ? t("subagents.check.swarmModel")
                    : isSwarm
                      ? t("subagents.check.swarmOther", { action: check.action.slice("swarm:".length) })
                      : t("subagents.check.other", { action: check.action });
    const iconName = killed
      ? "OctagonX"
      : check.action === "swarm:title"
        ? "Tag"
        : check.action === "swarm:model"
          ? "Cpu"
          : "ListChecks";
    const counts = new Map<string, number>();
    if (!showNames) for (const entry of check.states) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
    const chips = [...counts].map(([state, count]) => {
      const known = (["running", "done", "stopped", "failed", "idle"] as const).find((value) => value === state);
      const label = known ? t(`subagents.state.${known}`) : state;
      return { raw: state, state: known ?? "idle", text: `${count} ${label}` };
    });
    const names = showNames
      ? check.states
          .map((entry) => {
            if (isSwarm) {
              return (
                swarmDisplayByKey.get(entry.id) ??
                (entry.role ? swarmDisplayByKey.get(entry.role) : undefined) ??
                localizeSwarmRosterName(entry.role, locale) ??
                (entry.id.startsWith("#") ? "" : entry.id.slice(0, 8))
              );
            }
            return entry.role ?? (entry.id.startsWith("#") ? "" : entry.id.slice(0, 8));
          })
          .filter(Boolean)
          .join(" · ")
      : "";
    const checkTitle = check.title?.trim() ?? "";
    return (
      <View
        accessible
        accessibilityLabel={checkTitle ? `${title} · ${checkTitle}` : title}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          paddingVertical: space.xs,
          paddingHorizontal: 1,
        }}
      >
        <Icon name={iconName} size={12} color={colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ ...font.small, color: colors.foregroundMuted }}>
          {title}
        </Text>
        {checkTitle ? (
          <Text numberOfLines={1} style={{ ...font.small, color: colors.foreground, flexShrink: 1 }}>
            {checkTitle}
          </Text>
        ) : null}
        {names ? (
          <Text numberOfLines={1} style={{ ...font.small, color: colors.foreground, flexShrink: 1 }}>
            {names}
          </Text>
        ) : null}
        {chips.map((chip) => (
          <Text
            key={chip.raw}
            numberOfLines={1}
            style={{ ...font.caption, ...tabular, color: toneColor(colors, STATE_TONE[chip.state as ShownState]) }}
          >
            {chip.text}
          </Text>
        ))}
      </View>
    );
  }

  // ---- Popover: DSH-style frameless composer popover -------------------------------------------

  function makePopover(
    agentId: string,
    workspaceId: string | null | undefined,
  ): ComponentType<PluginButtonContentProps> {
    function SubagentsPopover({ theme, layout, close }: PluginButtonContentProps) {
      const { t, locale } = useAntigravityTranslation();
      const query = useSubagents(agentId);
      const pricing = useUnifiedPricing();
      const archived = useArchivedSubagents(agentId);
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const [settledOpen, setSettledOpen] = useState<boolean | undefined>(undefined);
      const compact = layout.compact;
      const subagents = query.data?.subagents ?? [];
      const { active, archivedList, live, settled } = useMemo(
        () => partitionSubagents(subagents, archived),
        [subagents, archived],
      );
      const selected = selectedId ? subagents.find((subagent) => subagent.id === selectedId) : undefined;
      const failedCount = active.filter((subagent) => subagent.state === "failed").length;
      const doneCount = active.filter((subagent) => subagent.state === "done").length;
      const headlineTitle = query.data?.swarmTitle?.trim() || t("subagents.title");
      const expanded = settledOpen ?? live.length === 0;
      const root = { ...popoverRootBox(), paddingBottom: 6 };

      const handleOpenInTab = (subagentId?: string) => {
        close();
        open(agentId, workspaceId, subagentId);
      };

      const handleArchiveFinished = () => {
        if (settled.length === 0) return;
        archiveStore.archive(
          agentId,
          settled.map((subagent) => subagent.id),
        );
        if (live.length === 0) {
          close();
        }
      };

      if (selected) {
        const selectedArchived = isSubagentArchived(selected, archived);
        return (
          <PopoverSubagentDetail
            theme={theme}
            compact={compact}
            agentId={agentId}
            summary={selected}
            pricing={pricing.data}
            archived={selectedArchived}
            onBack={() => setSelectedId(null)}
            onOpenInTab={workspaceId ? () => handleOpenInTab(selected.id) : undefined}
            onToggleArchive={
              selected.state !== "running"
                ? () => {
                    if (selectedArchived) {
                      archiveStore.unarchive(agentId, selected.id);
                    } else {
                      archiveStore.archive(agentId, [selected.id]);
                      if (active.length <= 1) close();
                      else setSelectedId(null);
                    }
                  }
                : undefined
            }
            onInsertReport={(text) => {
              const ok = insertIntoComposer(agentId, text);
              if (ok) close();
              return ok;
            }}
          />
        );
      }

      const renderRow = (subagent: SubagentSummary) => (
        <PopoverSubagentRow
          key={subagent.id}
          subagent={subagent}
          theme={theme}
          compact={compact}
          t={t}
          locale={locale}
          pricing={pricing.data}
          onPress={() => setSelectedId(subagent.id)}
        />
      );

      return (
        <View style={root}>
          <View
            accessible
            accessibilityRole="header"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 12,
              paddingTop: 10,
              paddingBottom: 8,
            }}
          >
            <Icon icon={{ svg: antigravityLogoSvg("popover") }} size={16} color={theme.colors.foregroundMuted} />
            <Text
              numberOfLines={1}
              style={{
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                fontSize: TITLE_FONT_SIZE,
                fontWeight: "600",
                color: theme.colors.foreground,
              }}
            >
              {headlineTitle}
            </Text>
            {live.length > 0 || failedCount > 0 || doneCount > 0 ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
                {live.length > 0 ? (
                  <PopoverPill
                    theme={theme}
                    label={t("subagents.chipRunning", { count: live.length })}
                    tone="running"
                    compact
                    leading={
                      <View style={{ width: 12, height: 12, alignItems: "center", justifyContent: "center" }}>
                        <StatusRingMark size={12} color={ringColorFor(theme.colors.surface0)} />
                      </View>
                    }
                  />
                ) : null}
                {failedCount > 0 ? (
                  <PopoverPill
                    theme={theme}
                    label={t("subagents.chipFailed", { count: failedCount })}
                    tone="danger"
                    compact
                    leading={
                      <View style={{ width: 12, height: 12, alignItems: "center", justifyContent: "center" }}>
                        <View
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            backgroundColor: theme.colors.statusDanger,
                          }}
                        />
                      </View>
                    }
                  />
                ) : null}
                {doneCount > 0 ? (
                  <PopoverPill
                    theme={theme}
                    label={t("subagents.chipDone", { count: doneCount })}
                    tone="success"
                    compact
                    leading={
                      <View style={{ width: 12, height: 12, alignItems: "center", justifyContent: "center" }}>
                        <Icon name="CircleCheck" size={12} color={theme.colors.statusSuccess} />
                      </View>
                    }
                  />
                ) : null}
              </View>
            ) : null}
          </View>

          <PopoverHairline theme={theme} marginVertical={2} />

          {query.isLoading && !query.data ? (
            <View style={rowBox({ compact })}>
              <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
                {t("loading")}
              </Text>
            </View>
          ) : query.error && !query.data ? (
            <View style={[rowBox({ compact }), { justifyContent: "space-between", gap: 8 }]}>
              <Text selectable style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.statusDanger, flex: 1 }}>
                {errorMessage(query.error)}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("retry")}
                onPress={() => void query.refetch()}
                style={{ paddingHorizontal: 6, paddingVertical: 2 }}
              >
                <Text style={{ fontSize: FACTS_FONT_SIZE, fontWeight: "500", color: theme.colors.accent }}>
                  {t("retry")}
                </Text>
              </Pressable>
            </View>
          ) : subagents.length === 0 ? (
            <View style={rowBox({ compact })}>
              <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
                {t("subagents.empty")}
              </Text>
            </View>
          ) : active.length === 0 ? (
            <View style={rowBox({ compact })}>
              <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
                {t("subagents.allArchived")}
              </Text>
            </View>
          ) : (
            <>
              {live.length > 0 ? (
                <View>
                  <PopoverSectionHeader
                    theme={theme}
                    label={t("subagents.runningSection")}
                    count={live.length}
                    paddingTop={6}
                  />
                  {live.map(renderRow)}
                </View>
              ) : null}

              {live.length > 0 && settled.length > 0 ? <PopoverHairline theme={theme} marginVertical={4} /> : null}

              {settled.length > 0 ? (
                <View>
                  <SettledSectionHeader
                    theme={theme}
                    label={t("subagents.settledSection")}
                    count={settled.length}
                    expanded={expanded}
                    compact={compact}
                    onToggle={() => setSettledOpen(!expanded)}
                  />
                  {expanded ? settled.map(renderRow) : null}
                </View>
              ) : null}
            </>
          )}

          <PopoverHairline theme={theme} marginVertical={4} />

          {settled.length > 0 ? (
            <Pressable
              onPress={handleArchiveFinished}
              accessibilityRole="button"
              accessibilityLabel={t("subagents.archiveFinishedCount", { count: settled.length })}
              style={({ hovered = false, pressed }: HoverState) => {
                const fill = rowActiveFill(hovered, pressed);
                return [rowBox({ compact }), fill === undefined ? undefined : { backgroundColor: theme.colors[fill] }];
              }}
            >
              {({ hovered = false, pressed }: HoverState) => (
                <>
                  <View style={{ width: MARK_BOX, height: MARK_BOX, alignItems: "center", justifyContent: "center" }}>
                    <Icon
                      name="Archive"
                      size={MARK_BOX}
                      color={theme.colors[chevronColorToken(hovered, pressed)]}
                    />
                  </View>
                  <Text
                    numberOfLines={1}
                    style={{
                      ...rowTextColumn(),
                      fontSize: TITLE_FONT_SIZE,
                      fontWeight: "500",
                      color: theme.colors.foreground,
                    }}
                  >
                    {t("subagents.archiveFinishedCount", { count: settled.length })}
                  </Text>
                </>
              )}
            </Pressable>
          ) : null}

          <Pressable
            onPress={() => handleOpenInTab()}
            accessibilityRole="button"
            accessibilityLabel={t("subagents.openPanel")}
            style={({ hovered = false, pressed }: HoverState) => {
              const fill = rowActiveFill(hovered, pressed);
              return [rowBox({ compact }), fill === undefined ? undefined : { backgroundColor: theme.colors[fill] }];
            }}
          >
            {({ hovered = false, pressed }: HoverState) => (
              <>
                <View style={{ width: MARK_BOX, height: MARK_BOX, alignItems: "center", justifyContent: "center" }}>
                  <Icon
                    name="PanelRightOpen"
                    size={MARK_BOX}
                    color={theme.colors[chevronColorToken(hovered, pressed)]}
                  />
                </View>
                <Text
                  numberOfLines={1}
                  style={{
                    ...rowTextColumn(),
                    fontSize: TITLE_FONT_SIZE,
                    fontWeight: "500",
                    color: theme.colors.foreground,
                  }}
                >
                  {t("subagents.openPanel")}
                </Text>
                {archivedList.length > 0 ? (
                  <Text
                    numberOfLines={1}
                    style={{
                      ...tabular,
                      fontSize: FACTS_FONT_SIZE,
                      color: theme.colors.foregroundMuted,
                      flexShrink: 0,
                    }}
                  >
                    {t("subagents.archivedCount", { count: archivedList.length })}
                  </Text>
                ) : null}
                <View style={{ width: CHEVRON_BOX, height: CHEVRON_BOX, alignItems: "center", justifyContent: "center" }}>
                  <Icon
                    name="ChevronRight"
                    size={CHEVRON_BOX}
                    color={theme.colors[chevronColorToken(hovered, pressed)]}
                  />
                </View>
              </>
            )}
          </Pressable>
        </View>
      );
    }

    return SubagentsPopover;
  }

  // ---- Full-view screen (pushes onto Paseo's screen stack; never creates a Workspace tab) -----

  function SubagentsScreen({ theme, layout, host, navigation, params }: PluginScreenProps) {
    const { colors } = theme;
    const { t } = useAntigravityTranslation();
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    const paramSubagentId = typeof params.subagentId === "string" && params.subagentId ? params.subagentId : null;
    const agent = useAgent(agentId, (snapshot) => ({ provider: snapshot.provider, title: snapshot.title }));
    const antigravity = Boolean(agentId) && isAntigravityProvider(agent?.provider);
    const query = useSubagents(agentId, antigravity);
    const archived = useArchivedSubagents(agentId);
    const list = query.data?.subagents ?? [];
    const { active, archivedList, live, settled } = useMemo(
      () => partitionSubagents(list, archived),
      [list, archived],
    );
    const swarmTitle = query.data?.swarmTitle?.trim() || null;
    const [selected, setSelected] = useState<string | null>(() => {
      if (!agentId) return null;
      return requested.get(agentId) ?? paramSubagentId;
    });
    const [filter, setFilter] = useState<ListFilter>("all");
    const [search, setSearch] = useState("");
    const backToAgent =
      agentId && typeof navigation?.openAgent === "function"
        ? () => navigation.openAgent({ agentId, serverId: host.id })
        : undefined;

    useEffect(() => {
      const wanted = agentId ? requested.get(agentId) : undefined;
      if (wanted) {
        requested.delete(agentId);
        setSelected(wanted);
      } else {
        setSelected(paramSubagentId);
      }
      setFilter("all");
      setSearch("");
    }, [agentId, paramSubagentId]);

    const effectiveFilter: ListFilter =
      filter === "archived" && archivedList.length === 0
        ? "all"
        : filter === "all" && active.length === 0 && archivedList.length > 0
          ? "archived"
          : filter;

    const filtered = useMemo(() => {
      const q = search.trim().toLowerCase();
      const base = effectiveFilter === "archived" ? archivedList : active;
      return base.filter((subagent) => {
        if (effectiveFilter === "running" && subagent.state !== "running") return false;
        if (effectiveFilter === "failed" && subagent.state !== "failed") return false;
        if (!q) return true;
        return (
          (subagent.displayName ?? "").toLowerCase().includes(q) ||
          (subagent.role ?? "").toLowerCase().includes(q) ||
          (subagent.type ?? "").toLowerCase().includes(q) ||
          (subagentTypeLabel(subagent.type, t) ?? "").toLowerCase().includes(q) ||
          subagent.task.toLowerCase().includes(q)
        );
      });
    }, [active, archivedList, effectiveFilter, search, t]);

    const current =
      filtered.find((subagent) => subagent.id === selected) ??
      list.find((subagent) => subagent.id === selected) ??
      (layout.compact ? undefined : filtered[0] ?? active[0] ?? list[0]);
    const running = live.length;
    const failedCount = active.filter((subagent) => subagent.state === "failed").length;

    const backFab = backToAgent ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("subagents.backToAgent")}
        onPress={backToAgent}
        style={(pressState) => ({
          position: "absolute",
          right: space.lg,
          bottom: layout.compact ? space.xl : space.lg,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          height: 38,
          paddingHorizontal: 14,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor:
            (pressState as { hovered?: boolean }).hovered || pressState.pressed
              ? colors.surface2
              : colors.surface1,
          shadowColor: "#000",
          shadowOpacity: 0.16,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 3 },
          elevation: 4,
        })}
      >
        <Icon name="MessageSquare" size={14} color={colors.accent} />
        <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>
          {t("subagents.backToAgent")}
        </Text>
      </Pressable>
    ) : null;

    if (!antigravity) {
      return (
        <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
          <Empty colors={colors} icon="Bot" text={t("subagents.notAntigravity")} />
          {backFab}
        </View>
      );
    }
    if (query.isLoading && !query.data) {
      return (
        <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
          <Empty colors={colors} icon="LoaderCircle" text="" />
          {backFab}
        </View>
      );
    }
    if (query.error && !query.data) {
      return (
        <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.xl }}>
            <Icon name="CircleAlert" size={22} color={colors.statusDanger} />
            <Text selectable style={{ ...font.small, color: colors.statusDanger, textAlign: "center" }}>
              {errorMessage(query.error)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("retry")}
              onPress={() => void query.refetch()}
              style={{
                marginTop: space.xs,
                paddingHorizontal: space.md,
                paddingVertical: space.xs + 2,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface1,
              }}
            >
              <Text style={{ ...font.small, fontWeight: "500", color: colors.accent }}>{t("retry")}</Text>
            </Pressable>
          </View>
          {backFab}
        </View>
      );
    }
    if (!list.length) {
      return (
        <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
          <Empty colors={colors} icon="Bot" text={t("subagents.empty")} />
          {backFab}
        </View>
      );
    }

    const header = (
      <View style={{ gap: space.sm, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, paddingHorizontal: space.xs }}>
          <Text numberOfLines={1} style={{ ...font.heading, color: colors.foreground, flexShrink: 1 }}>
            {swarmTitle ?? t("subagents.title")}
          </Text>
          <Text style={{ ...font.small, ...tabular, color: colors.foregroundMuted, flexShrink: 0 }}>
            {running
              ? t("subagents.summary", { total: active.length, running })
              : t("subagents.summaryIdle", { total: active.length })}
          </Text>
        </View>
        {list.length > 1 || archivedList.length > 0 || settled.length > 0 ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}>
              <FilterChip
                colors={colors}
                label={archivedList.length > 0 ? `${t("subagents.filter.all")} (${active.length})` : t("subagents.filter.all")}
                active={effectiveFilter === "all"}
                onPress={() => setFilter("all")}
              />
              {running > 0 ? (
                <FilterChip
                  colors={colors}
                  label={`${t("subagents.filter.running")} (${running})`}
                  active={effectiveFilter === "running"}
                  onPress={() => setFilter("running")}
                />
              ) : null}
              {failedCount > 0 ? (
                <FilterChip
                  colors={colors}
                  label={`${t("subagents.filter.failed")} (${failedCount})`}
                  active={effectiveFilter === "failed"}
                  onPress={() => setFilter("failed")}
                />
              ) : null}
              {archivedList.length > 0 ? (
                <FilterChip
                  colors={colors}
                  label={`${t("subagents.filter.archived")} (${archivedList.length})`}
                  active={effectiveFilter === "archived"}
                  onPress={() => setFilter("archived")}
                />
              ) : null}
              {settled.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("subagents.archiveFinished")}
                  onPress={() =>
                    archiveStore.archive(
                      agentId,
                      settled.map((subagent) => subagent.id),
                    )
                  }
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    minHeight: 28,
                    paddingHorizontal: space.sm,
                    borderRadius: radius.pill,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: colors.surface1,
                  }}
                >
                  <Icon name="Archive" size={12} color={colors.foregroundMuted} />
                  <Text style={{ ...font.caption, fontWeight: "500", color: colors.foregroundMuted }}>
                    {t("subagents.archiveFinished")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {list.length > 1 ? (
              <TextInput
                accessibilityLabel={t("subagents.searchPlaceholder")}
                value={search}
                onChangeText={setSearch}
                placeholder={t("subagents.searchPlaceholder")}
                placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
                style={{
                  ...font.caption,
                  color: colors.foreground,
                  backgroundColor: colors.surface1,
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: radius.md,
                  paddingHorizontal: space.sm + 2,
                  paddingVertical: space.xs + 2,
                }}
              />
            ) : null}
          </>
        ) : null}
      </View>
    );

    const rows = (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 72, gap: 2 }}>
        {filtered.length === 0 ? (
          <View style={{ padding: space.lg, alignItems: "center" }}>
            <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("subagents.noMatches")}</Text>
          </View>
        ) : (
          filtered.map((subagent) => (
            <ListRow
              key={subagent.id}
              colors={colors}
              subagent={subagent}
              parent={list.find((other) => other.id === subagent.parentId)}
              active={!layout.compact && current?.id === subagent.id}
              onPress={() => setSelected(subagent.id)}
              t={t}
            />
          ))
        )}
      </ScrollView>
    );

    const currentArchived = current ? isSubagentArchived(current, archived) : false;
    const toggleCurrentArchive =
      current && current.state !== "running"
        ? () => {
            if (currentArchived) {
              archiveStore.unarchive(agentId, current.id);
            } else {
              archiveStore.archive(agentId, [current.id]);
            }
          }
        : undefined;

    if (layout.compact) {
      if (current) {
        return (
          <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setSelected(null)}
              style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.sm }}
            >
              <Icon name="ChevronLeft" size={16} color={colors.accent} />
              <Text style={{ ...font.small, color: colors.accent }}>{t("subagents.back")}</Text>
            </Pressable>
            <Detail
              key={current.id}
              colors={colors}
              agentId={agentId}
              summary={current}
              compact
              archived={currentArchived}
              onToggleArchive={toggleCurrentArchive}
              onInsertReport={(text) => insertIntoComposer(agentId, text)}
            />
            {backFab}
          </View>
        );
      }
      return (
        <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
          {header}
          {rows}
          {backFab}
        </View>
      );
    }

    return (
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.surface0 }}>
        <View style={{ width: 300, borderRightWidth: 1, borderRightColor: colors.border }}>
          {header}
          {rows}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {current ? (
            <Detail
              key={current.id}
              colors={colors}
              agentId={agentId}
              summary={current}
              compact={false}
              archived={currentArchived}
              onToggleArchive={toggleCurrentArchive}
              onInsertReport={(text) => insertIntoComposer(agentId, text)}
            />
          ) : (
            <Empty colors={colors} icon="MousePointerClick" text={t("subagents.pick")} />
          )}
        </View>
        {backFab}
      </View>
    );
  }

  return { SubagentCardRow, SubagentCheckRow, SubagentsPanel: SubagentsScreen, SubagentsScreen, open, makePopover };
}

function PopoverSubagentMark({ state, theme }: { state: SubagentState; theme: PopoverTheme }) {
  const box = { width: MARK_BOX, height: MARK_BOX, alignItems: "center", justifyContent: "center" } as const;
  if (state === "running") {
    return (
      <View style={box}>
        <StatusRingMark size={MARK_BOX} color={ringColorFor(theme.colors.surface0)} />
      </View>
    );
  }
  if (state === "done") {
    return (
      <View style={box}>
        <Icon name="CircleCheck" size={13} color={theme.colors.statusSuccess} />
      </View>
    );
  }
  if (state === "failed") {
    return (
      <View style={box}>
        <Icon name="CircleAlert" size={13} color={theme.colors.statusDanger} />
      </View>
    );
  }
  const dotColor = state === "idle" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  return (
    <View style={box}>
      <View
        style={{
          width: MARK_DOT_SIZE,
          height: MARK_DOT_SIZE,
          borderRadius: MARK_DOT_SIZE / 2,
          backgroundColor: dotColor,
        }}
      />
    </View>
  );
}

function PopoverSubagentRow({
  subagent,
  theme,
  compact,
  t,
  locale,
  pricing,
  onPress,
}: {
  subagent: SubagentSummary;
  theme: PopoverTheme;
  compact: boolean;
  t: Translate;
  locale: string;
  pricing: PricingState | undefined;
  onPress: () => void;
}) {
  const isRunning = subagent.state === "running";
  const isSwarm = subagent.origin === "swarm";
  const typeLabel = subagentTypeLabel(subagent.type, t);
  const title = displaySubagentName(subagent, t, locale);
  const activity = activityLine(subagent, t, locale);
  const thinking = isRunning && subagent.phase === "thinking";
  const fact = isRunning && activity ? activity : metaLine(subagent, t, locale, pricing);
  const isToolActivity = isRunning && Boolean(activity) && !thinking;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title} · ${t(`subagents.state.${subagent.state}`)}`}
      style={({ hovered = false, pressed }: HoverState) => {
        const fill = rowActiveFill(hovered, pressed);
        return [rowBox({ compact }), fill === undefined ? undefined : { backgroundColor: theme.colors[fill] }];
      }}
    >
      {({ hovered = false, pressed }: HoverState) => (
        <>
          <PopoverSubagentMark state={subagent.state} theme={theme} />
          <View style={rowTextColumn()}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{
                  fontSize: TITLE_FONT_SIZE,
                  lineHeight: 20,
                  fontWeight: isRunning ? "500" : "400",
                  color: theme.colors.foreground,
                  flexShrink: 1,
                }}
              >
                {title}
              </Text>
              {isSwarm ? (
                <PopoverPill theme={theme} label={t("subagents.swarmTag")} tone="neutral" compact />
              ) : typeLabel && subagent.role ? (
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: 11,
                    lineHeight: 16,
                    color: theme.colors.foregroundMuted,
                    flexShrink: 2,
                  }}
                >
                  {typeLabel}
                </Text>
              ) : null}
            </View>
            <Text
              numberOfLines={1}
              style={{
                fontSize: FACTS_FONT_SIZE,
                lineHeight: 16,
                color: theme.colors.foregroundMuted,
                ...tabular,
                ...(thinking ? { fontStyle: "italic" as const } : isToolActivity ? { fontFamily: mono } : null),
              }}
            >
              {fact}
            </Text>
          </View>
          <View style={{ width: CHEVRON_BOX, height: CHEVRON_BOX, alignItems: "center", justifyContent: "center" }}>
            <Icon
              name="ChevronRight"
              size={CHEVRON_BOX}
              color={theme.colors[chevronColorToken(hovered, pressed)]}
            />
          </View>
        </>
      )}
    </Pressable>
  );
}

function SettledSectionHeader({
  theme,
  label,
  count,
  expanded,
  compact,
  onToggle,
}: {
  theme: PopoverTheme;
  label: string;
  count: number;
  expanded: boolean;
  compact: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${String(count)}`}
      accessibilityState={{ expanded }}
      {...(Platform.OS === "web" ? { "aria-expanded": expanded } : null)}
      style={({ hovered = false, pressed }: HoverState) => {
        const fill = rowActiveFill(hovered, pressed);
        return [rowBox({ compact }), fill === undefined ? undefined : { backgroundColor: theme.colors[fill] }];
      }}
    >
      {({ hovered = false, pressed }: HoverState) => (
        <>
          <Text numberOfLines={1} style={{ ...rowTextColumn(), fontSize: TITLE_FONT_SIZE, color: theme.colors.foreground }}>
            {label}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              ...tabular,
              flexShrink: 2,
              minWidth: 0,
              fontSize: FACTS_FONT_SIZE,
              color: theme.colors.foregroundMuted,
            }}
          >
            {String(count)}
          </Text>
          <View
            style={{
              width: CHEVRON_BOX,
              height: CHEVRON_BOX,
              alignItems: "center",
              justifyContent: "center",
              transform: chevronRotation(expanded),
            }}
          >
            <Icon
              name="ChevronRight"
              size={CHEVRON_BOX}
              color={theme.colors[chevronColorToken(hovered, pressed)]}
            />
          </View>
        </>
      )}
    </Pressable>
  );
}

function Empty({ colors, icon, text }: { colors: Colors; icon: string; text: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, backgroundColor: colors.surface0 }}>
      <Icon name={icon} size={22} color={colors.foregroundMuted} />
      {text ? <Text style={{ ...font.small, color: colors.foregroundMuted }}>{text}</Text> : null}
    </View>
  );
}

function ListRow({
  colors,
  subagent,
  parent,
  active,
  onPress,
  t,
}: {
  colors: Colors;
  subagent: SubagentSummary;
  parent: SubagentSummary | undefined;
  active: boolean;
  onPress(): void;
  t: Translate;
}) {
  const { locale } = useAntigravityTranslation();
  const pricing = useUnifiedPricing();
  const color = toneColor(colors, STATE_TONE[subagent.state]);
  const activity = activityLine(subagent, t, locale);
  const isSwarm = subagent.origin === "swarm";
  const typeLabel = subagentTypeLabel(subagent.type, t);
  const displayName = displaySubagentName(subagent, t, locale);
  const parentDisplayName = parent ? displaySubagentName(parent, t, locale) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={(pressState) => ({
        flexDirection: "row",
        gap: space.sm,
        paddingVertical: space.sm,
        paddingRight: space.sm,
        paddingLeft: space.sm + (subagent.depth - 1) * space.lg,
        borderRadius: radius.md,
        backgroundColor: active
          ? tint(colors.accent, 0.1)
          : (pressState as { hovered?: boolean }).hovered || pressState.pressed
            ? tint(colors.foreground, 0.05)
            : "transparent",
      })}
    >
      <View style={{ paddingTop: 3 }}>
        {subagent.state === "running" ? (
          <StatusRingMark size={14} ring={12} color={ringColorFor(colors.surface0)} />
        ) : (
          <Icon name={STATE_ICON[subagent.state]} size={14} color={color} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: colors.foreground, flexShrink: 1 }}>
            {displayName}
          </Text>
          {isSwarm ? (
            <Badge colors={colors} label={t("subagents.swarmTag")} tone="neutral" style={{ flexShrink: 0 }} />
          ) : typeLabel && subagent.role ? (
            <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
              {typeLabel}
            </Text>
          ) : null}
        </View>
        {parent && parentDisplayName ? (
          <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
            {t("subagents.nested", { role: parentDisplayName })}
          </Text>
        ) : null}
        {activity ? (
          <Text
            numberOfLines={1}
            style={{
              ...font.caption,
              color: colors.foregroundMuted,
              ...(subagent.state === "running" && subagent.phase === "thinking" ? { fontStyle: "italic" as const } : { fontFamily: mono }),
            }}
          >
            {activity}
          </Text>
        ) : null}
        <Text numberOfLines={1} style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
          {metaLine(subagent, t, locale, pricing.data)}
        </Text>
      </View>
    </Pressable>
  );
}

function ArtifactPreview({
  colors,
  agentId,
  subagentId,
  artifact,
  t,
}: {
  colors: Colors;
  agentId: string;
  subagentId: string;
  artifact: SubagentArtifactInfo;
  t: Translate;
}) {
  const readArtifact = useRpc(subagentArtifactRpc);
  const query = useQuery({
    queryKey: ["antigravity-accounts", "subagent-artifact", agentId, subagentId, artifact.path],
    queryFn: () => readArtifact({ agentId, subagentId, path: artifact.path }),
    staleTime: 10_000,
  });

  if (query.isLoading) {
    return <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("subagents.artifactLoading")}</Text>;
  }
  if (query.error) {
    return <Text style={{ ...font.caption, color: colors.statusDanger }}>{errorMessage(query.error)}</Text>;
  }
  const data = query.data;
  if (!data) return null;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        backgroundColor: colors.surface1,
        padding: space.md,
        gap: space.sm,
      }}
    >
      {data.truncated ? (
        <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("subagents.artifactTruncated")}</Text>
      ) : null}
      {data.isMarkdown ? (
        <Expandable colors={colors} height={360} background={colors.surface1} t={t}>
          <Markdown>{data.content}</Markdown>
        </Expandable>
      ) : (
        <Expandable colors={colors} height={280} background={colors.surface1} t={t}>
          <Text selectable style={{ fontSize: 12, lineHeight: 17, fontFamily: mono, color: colors.foreground }}>
            {data.content}
          </Text>
        </Expandable>
      )}
    </View>
  );
}

function Detail({
  colors,
  agentId,
  summary,
  compact,
  archived,
  onToggleArchive,
  onInsertReport,
}: {
  colors: Colors;
  agentId: string;
  summary: SubagentSummary;
  compact: boolean;
  archived?: boolean;
  onToggleArchive?: () => void;
  onInsertReport(text: string): boolean;
}) {
  const { t, locale } = useAntigravityTranslation();
  const toast = useToast();
  const read = useRpc(subagentDetailRpc);
  const pricing = useUnifiedPricing();
  const scrollRef = useRef<NativeScrollView | null>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [activitySearch, setActivitySearch] = useState("");
  const [follow, setFollow] = useState(false);
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["antigravity-accounts", "subagent", agentId, summary.id],
    queryFn: () => read({ agentId, subagentId: summary.id }),
    staleTime: 1000,
    refetchInterval: summary.state === "running" ? 3000 : false,
  });
  const detail = query.data;
  const entries = detail?.entries ?? [];
  const artifacts = detail?.artifacts ?? [];
  const task = entries.find((entry) => entry.kind === "task");
  const rawActivity = entries.filter((entry) => entry.kind !== "task");

  const activity = useMemo(() => {
    const q = activitySearch.trim().toLowerCase();
    return rawActivity.filter((entry) => {
      if (activityFilter === "tools" && entry.tools.length === 0) return false;
      if (
        activityFilter === "errors" &&
        entry.kind !== "error" &&
        !entry.tools.some((tool) => tool.failed)
      ) {
        return false;
      }
      if (!q) return true;
      if ((entry.text ?? "").toLowerCase().includes(q)) return true;
      if ((entry.thinking ?? "").toLowerCase().includes(q)) return true;
      return entry.tools.some(
        (tool) =>
          tool.name.toLowerCase().includes(q) ||
          tool.summary.toLowerCase().includes(q) ||
          (tool.output ?? "").toLowerCase().includes(q),
      );
    });
  }, [rawActivity, activityFilter, activitySearch]);

  useEffect(() => {
    if (follow && summary.state === "running") {
      scrollRef.current?.scrollToEnd({ animated: true });
    }
  }, [follow, summary.state, activity.length]);

  const pad = compact ? space.lg : space.xxl;
  const end =
    summary.reportedAt && summary.updatedAt
      ? Date.parse(summary.reportedAt) >= Date.parse(summary.updatedAt)
        ? summary.reportedAt
        : summary.updatedAt
      : (summary.reportedAt ?? summary.updatedAt);
  const took = since(summary.startedAt, end, locale);
  const est = estimateSubagentCost(summary, pricing.data);
  const facts = [
    summary.model,
    t("subagents.steps", { count: summary.steps }),
    t("subagents.calls", { count: summary.tools }),
    took,
    est !== null ? `~${money(est.cost, est.currency, locale)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const typeLabel = subagentTypeLabel(summary.type, t);
  const title = displaySubagentName(summary, t, locale);

  return (
    <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: pad, paddingBottom: pad + 56, gap: space.xl }}>
      <View style={{ gap: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Text style={{ ...font.title, color: colors.foreground }}>{title}</Text>
          {summary.origin === "swarm" ? (
            <Badge colors={colors} label={t("subagents.swarmTag")} tone="neutral" />
          ) : typeLabel && summary.role ? (
            <Badge colors={colors} label={typeLabel} />
          ) : null}
          <Badge
            colors={colors}
            label={t(`subagents.state.${summary.state}`)}
            tone={STATE_TONE[summary.state]}
            icon={statusBadgeIcon(summary.state, toneColor(colors, STATE_TONE[summary.state]))}
          />
          <View style={{ flex: 1 }} />
          {onToggleArchive ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={archived ? t("subagents.unarchive") : t("subagents.archive")}
              onPress={onToggleArchive}
              style={{ flexDirection: "row", alignItems: "center", gap: 4, padding: space.xs }}
            >
              <Icon
                name={archived ? "Undo2" : "Archive"}
                size={14}
                color={archived ? colors.accent : colors.foregroundMuted}
              />
              <Text style={{ ...font.caption, color: archived ? colors.accent : colors.foregroundMuted }}>
                {archived ? t("subagents.unarchive") : t("subagents.archive")}
              </Text>
            </Pressable>
          ) : null}
          {entries.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("subagents.copyTranscript")}
              onPress={() => {
                const md = transcriptToMarkdown(summary, entries, detail?.report ?? null, t, locale);
                void copyText(md).then(() => toast.show(t("subagents.transcriptCopied"), { durationMs: 2500 }));
              }}
              style={{ flexDirection: "row", alignItems: "center", gap: 4, padding: space.xs }}
            >
              <Icon name="FileDown" size={14} color={colors.foregroundMuted} />
              <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("subagents.copyTranscript")}</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={{ ...font.small, ...tabular, color: colors.foregroundMuted }}>{facts}</Text>
        <TokenBar colors={colors} summary={summary} t={t} />
      </View>

      {query.error && !detail ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: tint(colors.statusDanger, 0.1),
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flex: 1 }}>
            <Icon name="CircleAlert" size={15} color={colors.statusDanger} />
            <Text selectable style={{ ...font.small, color: colors.statusDanger, flex: 1 }}>
              {errorMessage(query.error)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("retry")}
            onPress={() => void query.refetch()}
            style={{ paddingHorizontal: space.sm, paddingVertical: space.xs }}
          >
            <Text style={{ ...font.small, fontWeight: "500", color: colors.accent }}>{t("retry")}</Text>
          </Pressable>
        </View>
      ) : null}

      {task?.text ? (
        <Section colors={colors} title={t("subagents.task")}>
          <Expandable colors={colors} height={6 * font.small.lineHeight} background={colors.surface0} t={t}>
            <Text selectable style={{ ...font.small, color: colors.foreground }}>
              {task.text}
            </Text>
          </Expandable>
        </Section>
      ) : null}

      {detail?.report ? (
        <Section
          colors={colors}
          title={t("subagents.report")}
          trailing={
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("subagents.insertReport")}
                onPress={() => {
                  const ok = onInsertReport(detail.report ?? "");
                  toast.show(ok ? t("subagents.insertedReport") : t("subagents.composerUnavailable"), { durationMs: 2500 });
                }}
                style={{ flexDirection: "row", alignItems: "center", gap: 4, padding: space.xs }}
              >
                <Icon name="CornerDownLeft" size={14} color={colors.accent} />
                <Text style={{ ...font.caption, color: colors.accent }}>{t("subagents.insertReport")}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("subagents.copy")}
                onPress={() => {
                  void copyText(detail.report ?? "").then(() => toast.show(t("subagents.copied"), { durationMs: 2500 }));
                }}
                style={{ padding: space.xs }}
              >
                <Icon name="Copy" size={14} color={colors.foregroundMuted} />
              </Pressable>
            </View>
          }
        >
          <View
            style={{
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius.lg,
              backgroundColor: colors.surface1,
              paddingHorizontal: space.lg,
              paddingVertical: space.sm,
            }}
          >
            <Expandable colors={colors} height={320} background={colors.surface1} t={t}>
              <Markdown>{detail.report}</Markdown>
            </Expandable>
          </View>
        </Section>
      ) : null}

      {artifacts.length > 0 ? (
        <Section colors={colors} title={`${t("subagents.artifacts")} (${artifacts.length})`}>
          <View style={{ gap: space.xs }}>
            {artifacts.map((artifact) => {
              const expanded = openArtifact === artifact.path;
              return (
                <View key={artifact.path} style={{ gap: space.xs }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    onPress={() => setOpenArtifact(expanded ? null : artifact.path)}
                    style={(pressState) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.sm,
                      paddingVertical: space.xs + 2,
                      paddingHorizontal: space.sm,
                      borderRadius: radius.md,
                      borderWidth: 1,
                      borderColor: expanded ? tint(colors.accent, 0.4) : colors.border,
                      backgroundColor: (pressState as { hovered?: boolean }).hovered
                        ? tint(colors.foreground, 0.04)
                        : colors.surface1,
                    })}
                  >
                    <Icon name={artifact.isMarkdown ? "FileText" : "File"} size={14} color={expanded ? colors.accent : colors.foregroundMuted} />
                    <Text numberOfLines={1} style={{ ...font.small, fontFamily: mono, color: colors.foreground, flex: 1 }}>
                      {artifact.path}
                    </Text>
                    <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                      {formatBytes(artifact.size)}
                    </Text>
                    <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
                  </Pressable>
                  {expanded ? (
                    <ArtifactPreview colors={colors} agentId={agentId} subagentId={summary.id} artifact={artifact} t={t} />
                  ) : null}
                </View>
              );
            })}
          </View>
        </Section>
      ) : null}

      {rawActivity.length ? (
        <Section
          colors={colors}
          title={t("subagents.activity")}
          trailing={
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
              {summary.state === "running" ? (
                <FilterChip colors={colors} label={t("subagents.follow")} active={follow} onPress={() => setFollow(!follow)} />
              ) : null}
              <Pressable
                accessibilityRole="button"
                onPress={() => scrollRef.current?.scrollToEnd({ animated: true })}
                style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: space.xs, height: 24 }}
              >
                <Icon name="ArrowDown" size={12} color={colors.accent} />
                <Text style={{ ...font.caption, color: colors.accent }}>{t("subagents.jumpBottom")}</Text>
              </Pressable>
            </View>
          }
        >
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
            <FilterChip
              colors={colors}
              label={t("subagents.activityFilter.all")}
              active={activityFilter === "all"}
              onPress={() => setActivityFilter("all")}
            />
            <FilterChip
              colors={colors}
              label={t("subagents.activityFilter.tools")}
              active={activityFilter === "tools"}
              onPress={() => setActivityFilter("tools")}
            />
            <FilterChip
              colors={colors}
              label={t("subagents.activityFilter.errors")}
              active={activityFilter === "errors"}
              onPress={() => setActivityFilter("errors")}
            />
            <TextInput
              accessibilityLabel={t("subagents.activitySearch")}
              value={activitySearch}
              onChangeText={setActivitySearch}
              placeholder={t("subagents.activitySearch")}
              placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
              style={{
                ...font.caption,
                flex: 1,
                minWidth: 140,
                color: colors.foreground,
                backgroundColor: colors.surface1,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.md,
                paddingHorizontal: space.sm,
                paddingVertical: 4,
              }}
            />
          </View>
          {detail?.truncated ? (
            <Text style={{ ...font.caption, color: colors.foregroundMuted }}>
              {t("subagents.truncated", { count: rawActivity.length })}
            </Text>
          ) : null}
          {activity.length === 0 ? (
            <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("subagents.noMatches")}</Text>
          ) : (
            <View style={{ gap: space.md }}>
              {activity.map((entry) => (
                <EntryRow key={entry.index} colors={colors} entry={entry} t={t} locale={locale} />
              ))}
            </View>
          )}
        </Section>
      ) : null}
    </ScrollView>
  );
}

/** One stacked bar of where the subagent's tokens went: cache hits, new input, output. */
function TokenBar({ colors, summary, t }: { colors: Colors; summary: SubagentSummary; t: Translate }) {
  const total = summary.cachedTokens + summary.inputTokens + summary.outputTokens;
  if (!total) return null;
  const parts = [
    { key: "cached", value: summary.cachedTokens, color: tint(colors.accent, 0.35) },
    { key: "input", value: summary.inputTokens, color: colors.accent },
    { key: "output", value: summary.outputTokens, color: colors.statusSuccess },
  ] as const;
  return (
    <View style={{ gap: space.xs, maxWidth: 520 }}>
      <View style={{ flexDirection: "row", height: 6, borderRadius: 3, overflow: "hidden", gap: 2 }}>
        {parts.map((part) =>
          part.value ? <View key={part.key} style={{ flex: part.value / total, backgroundColor: part.color }} /> : null,
        )}
      </View>
      <View style={{ flexDirection: "row", gap: space.lg, flexWrap: "wrap" }}>
        {parts.map((part) => (
          <View key={part.key} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: part.color }} />
            <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
              {t(`subagents.tokens.${part.key}`)} {tokens(part.value)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function Section({
  colors,
  title,
  trailing,
  children,
}: {
  colors: Colors;
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ ...font.overline, color: colors.foregroundMuted }}>{upper(title)}</Text>
        <View style={{ flex: 1 }} />
        {trailing}
      </View>
      {children}
    </View>
  );
}

/** Clips long content to a height with a fade and a toggle. */
function Expandable({
  colors,
  height,
  background,
  t,
  children,
}: {
  colors: Colors;
  /** Clipped height; a multiple of the content's line height keeps the cut between lines. */
  height: number;
  background: string;
  t: Translate;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const fade = [0.2, 0.45, 0.7, 0.88, 1];
  return (
    <View>
      <View style={{ maxHeight: open ? undefined : height, overflow: "hidden" }}>
        <View
          onLayout={(event) => {
            setOverflows(event.nativeEvent.layout.height > height + 1);
          }}
        >
          {children}
        </View>
        {overflows && !open ? (
          <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
            {fade.map((alpha) => (
              <View key={alpha} style={{ height: 6, backgroundColor: tint(background, alpha) }} />
            ))}
          </View>
        ) : null}
      </View>
      {overflows ? (
        <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} style={{ paddingTop: space.xs, alignSelf: "flex-start" }}>
          <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>{open ? t("subagents.less") : t("subagents.more")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function EntryRow({ colors, entry, t, locale }: { colors: Colors; entry: TranscriptEntry; t: Translate; locale: string }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const time = clock(entry.at, locale);
  return (
    <View style={{ flexDirection: "row", gap: space.md }}>
      <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted, width: 58, paddingTop: 1 }}>{time}</Text>
      <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
        {entry.kind === "message" ? (
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Icon name="MessageSquare" size={13} color={colors.foregroundMuted} />
            <Text selectable numberOfLines={4} style={{ ...font.small, color: colors.foreground, flex: 1 }}>
              {entry.text}
            </Text>
          </View>
        ) : null}
        {entry.kind === "error" ? (
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Icon name="CircleAlert" size={13} color={colors.statusDanger} />
            <Text selectable style={{ ...font.small, color: colors.statusDanger, flex: 1 }}>
              {entry.text}
            </Text>
          </View>
        ) : null}
        {entry.thinking ? (
          <Pressable accessibilityRole="button" onPress={() => setThinkingOpen(!thinkingOpen)}>
            <Text
              numberOfLines={thinkingOpen ? undefined : 2}
              style={{ ...font.caption, color: colors.foregroundMuted, fontStyle: "italic" }}
            >
              {entry.thinking}
            </Text>
          </Pressable>
        ) : null}
        {entry.kind === "response" && entry.text ? (
          <Text selectable style={{ ...font.small, color: colors.foreground }}>
            {entry.text}
          </Text>
        ) : null}
        {entry.tools.map((tool, index) => (
          <ToolRow key={index} colors={colors} tool={tool} t={t} />
        ))}
      </View>
    </View>
  );
}

function ToolRow({ colors, tool, t }: { colors: Colors; tool: TranscriptEntry["tools"][number]; t: Translate }) {
  const [open, setOpen] = useState(false);
  const color = tool.failed ? colors.statusDanger : colors.foregroundMuted;
  const icon = useMemo(() => toolIcon(tool.name), [tool.name]);
  return (
    <View style={{ gap: space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: !tool.output }}
        disabled={!tool.output}
        onPress={() => setOpen(!open)}
        style={(pressState) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingVertical: 3,
          paddingHorizontal: space.sm,
          marginHorizontal: -space.sm,
          borderRadius: radius.sm,
          backgroundColor: (pressState as { hovered?: boolean }).hovered && tool.output ? tint(colors.foreground, 0.05) : "transparent",
        })}
      >
        <Icon name={tool.failed ? "CircleAlert" : icon} size={13} color={color} />
        <Text numberOfLines={1} style={{ ...font.caption, fontFamily: mono, color: colors.foreground }}>
          {toolLabel(tool.name)}
        </Text>
        <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted, flex: 1 }}>
          {tool.summary}
        </Text>
        {tool.output ? <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={colors.foregroundMuted} /> : null}
      </Pressable>
      {open && tool.output ? (
        <View
          accessibilityLabel={t("subagents.toolOutput")}
          style={{
            borderRadius: radius.md,
            backgroundColor: tint(colors.foreground, 0.04),
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
          }}
        >
          <Text selectable style={{ fontSize: 12, lineHeight: 17, fontFamily: mono, color: colors.foreground }}>
            {tool.output}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function popoverStatePillTone(state: SubagentState): PopoverPillTone {
  switch (state) {
    case "running":
      return "running";
    case "done":
      return "success";
    case "failed":
      return "danger";
    case "idle":
      return "warning";
    case "stopped":
      return "neutral";
  }
}

/**
 * In-place subagent detail view rendered directly inside the composer popover
 * (matching DSH `team-popover.tsx`'s `TaskDetail`), so inspecting a subagent
 * never opens a new Paseo tab unless the user explicitly taps "Open in tab".
 */
function PopoverSubagentDetail({
  theme,
  compact,
  agentId,
  summary,
  pricing,
  archived,
  onBack,
  onOpenInTab,
  onToggleArchive,
  onInsertReport,
}: {
  theme: PopoverTheme;
  compact: boolean;
  agentId: string;
  summary: SubagentSummary;
  pricing?: PricingState;
  archived?: boolean;
  onBack: () => void;
  onOpenInTab?: () => void;
  onToggleArchive?: () => void;
  onInsertReport: (text: string) => boolean;
}) {
  const { colors } = theme;
  const { t, locale } = useAntigravityTranslation();
  const toast = useToast();
  const read = useRpc(subagentDetailRpc);
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["antigravity-accounts", "subagent", agentId, summary.id],
    queryFn: () => read({ agentId, subagentId: summary.id }),
    staleTime: 1000,
    refetchInterval: summary.state === "running" ? 3000 : false,
  });
  const detail = query.data;
  const entries = detail?.entries ?? [];
  const artifacts = detail?.artifacts ?? [];
  const taskText = entries.find((entry) => entry.kind === "task")?.text || summary.task;
  const rawActivity = entries.filter((entry) => entry.kind !== "task");
  const recentActivity = rawActivity.slice(-20);
  const reportText = detail?.report?.trim() ?? "";

  const end =
    summary.reportedAt && summary.updatedAt
      ? Date.parse(summary.reportedAt) >= Date.parse(summary.updatedAt)
        ? summary.reportedAt
        : summary.updatedAt
      : (summary.reportedAt ?? summary.updatedAt);
  const took = since(summary.startedAt, end, locale);
  const est = estimateSubagentCost(summary, pricing);
  const facts = [
    summary.model,
    t("subagents.steps", { count: summary.steps }),
    t("subagents.calls", { count: summary.tools }),
    took,
    est !== null ? `~${money(est.cost, est.currency, locale)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const typeLabel = subagentTypeLabel(summary.type, t);
  const title = displaySubagentName(summary, t, locale);
  const pillTone = popoverStatePillTone(summary.state);
  const pillLeading =
    summary.state === "running" ? (
      <View style={{ width: 12, height: 12, alignItems: "center", justifyContent: "center" }}>
        <StatusRingMark size={12} ring={10} color={ringColorFor(theme.colors.surface0)} />
      </View>
    ) : (
      <View style={{ width: 12, height: 12, alignItems: "center", justifyContent: "center" }}>
        <Icon name={STATE_ICON[summary.state]} size={11} color={toneColor(colors, STATE_TONE[summary.state])} />
      </View>
    );

  return (
    <View style={{ ...popoverRootBox(), paddingBottom: 12 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingHorizontal: 4,
          paddingTop: 4,
          paddingBottom: 2,
        }}
      >
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t("subagents.back")}
          style={({ hovered = false, pressed }: HoverState) => {
            const fill = rowActiveFill(hovered, pressed);
            return [
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                minHeight: compact ? 36 : 28,
                paddingLeft: 4,
                paddingRight: 10,
                paddingVertical: compact ? 6 : 4,
                borderRadius: 6,
              },
              fill === undefined ? undefined : { backgroundColor: theme.colors[fill] },
            ];
          }}
        >
          {({ hovered = false, pressed }: HoverState) => (
            <>
              <Icon name="ChevronLeft" size={16} color={theme.colors[chevronColorToken(hovered, pressed)]} />
              <Text
                numberOfLines={1}
                style={{ fontSize: 13, fontWeight: "500", color: theme.colors[chevronColorToken(hovered, pressed)] }}
              >
                {t("subagents.back")}
              </Text>
            </>
          )}
        </Pressable>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          {onToggleArchive ? (
            <Pressable
              onPress={onToggleArchive}
              accessibilityRole="button"
              accessibilityLabel={archived ? t("subagents.unarchive") : t("subagents.archive")}
              style={({ hovered = false, pressed }: HoverState) => {
                const fill = rowActiveFill(hovered, pressed);
                return [
                  {
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    minHeight: compact ? 36 : 28,
                    paddingHorizontal: 8,
                    paddingVertical: compact ? 6 : 4,
                    borderRadius: 6,
                  },
                  fill === undefined ? undefined : { backgroundColor: theme.colors[fill] },
                ];
              }}
            >
              <Icon
                name={archived ? "Undo2" : "Archive"}
                size={13}
                color={archived ? colors.accent : colors.foregroundMuted}
              />
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 12,
                  fontWeight: "500",
                  color: archived ? colors.accent : colors.foregroundMuted,
                }}
              >
                {archived ? t("subagents.unarchive") : t("subagents.archive")}
              </Text>
            </Pressable>
          ) : null}

          {onOpenInTab ? (
            <Pressable
              onPress={onOpenInTab}
              accessibilityRole="button"
              accessibilityLabel={t("subagents.openInTab")}
              style={({ hovered = false, pressed }: HoverState) => {
                const fill = rowActiveFill(hovered, pressed);
                return [
                  {
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    minHeight: compact ? 36 : 28,
                    paddingHorizontal: 8,
                    paddingVertical: compact ? 6 : 4,
                    borderRadius: 6,
                  },
                  fill === undefined ? undefined : { backgroundColor: theme.colors[fill] },
                ];
              }}
            >
              <Icon name="PanelRightOpen" size={13} color={colors.accent} />
              <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "500", color: colors.accent }}>
                {t("subagents.openInTab")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={{ paddingHorizontal: 12, paddingTop: 6, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          <Text
            selectable
            style={{
              fontSize: POPOVER_DETAIL_TITLE_SIZE,
              lineHeight: POPOVER_DETAIL_TITLE_LINE,
              fontWeight: "600",
              color: colors.foreground,
              flexShrink: 1,
            }}
          >
            {title}
          </Text>
          {summary.origin === "swarm" ? (
            <PopoverPill theme={theme} label={t("subagents.swarmTag")} tone="neutral" compact />
          ) : typeLabel && summary.role ? (
            <PopoverPill theme={theme} label={typeLabel} tone="neutral" compact />
          ) : null}
          <PopoverPill
            theme={theme}
            label={t(`subagents.state.${summary.state}`)}
            tone={pillTone}
            leading={pillLeading}
            compact
          />
        </View>
        {facts ? (
          <Text style={{ fontSize: FACTS_FONT_SIZE, lineHeight: 16, ...tabular, color: colors.foregroundMuted }}>
            {facts}
          </Text>
        ) : null}
        <TokenBar colors={colors} summary={summary} t={t} />
      </View>

      {taskText ? (
        <>
          <PopoverHairline theme={theme} inset={12} marginVertical={10} />
          <View style={{ paddingHorizontal: 12, gap: 6 }}>
            <Text style={{ fontSize: 11.5, lineHeight: 16, fontWeight: "600", color: colors.foregroundMuted }}>
              {t("subagents.task")}
            </Text>
            <Expandable colors={colors} height={96} background={colors.surface0} t={t}>
              <Text selectable style={{ ...font.small, color: colors.foreground }}>
                {taskText}
              </Text>
            </Expandable>
          </View>
        </>
      ) : null}

      {query.isLoading && !detail ? (
        <>
          <PopoverHairline theme={theme} inset={12} marginVertical={10} />
          <View style={{ paddingHorizontal: 12 }}>
            <Text style={{ fontSize: FACTS_FONT_SIZE, color: colors.foregroundMuted }}>{t("loading")}</Text>
          </View>
        </>
      ) : query.error && !detail ? (
        <>
          <PopoverHairline theme={theme} inset={12} marginVertical={10} />
          <View style={{ paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text selectable style={{ fontSize: FACTS_FONT_SIZE, color: colors.statusDanger, flex: 1 }}>
              {errorMessage(query.error)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("retry")}
              onPress={() => void query.refetch()}
              style={{ paddingHorizontal: 6, paddingVertical: 2 }}
            >
              <Text style={{ fontSize: FACTS_FONT_SIZE, fontWeight: "500", color: colors.accent }}>{t("retry")}</Text>
            </Pressable>
          </View>
        </>
      ) : reportText ? (
        <>
          <PopoverHairline theme={theme} inset={12} marginVertical={10} />
          <View style={{ paddingHorizontal: 12, gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <Text style={{ fontSize: 11.5, lineHeight: 16, fontWeight: "600", color: colors.foregroundMuted }}>
                {t("subagents.report")}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("subagents.insertReport")}
                  onPress={() => {
                    const ok = onInsertReport(reportText);
                    toast.show(ok ? t("subagents.insertedReport") : t("subagents.composerUnavailable"), { durationMs: 2500 });
                  }}
                  style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2 }}
                >
                  <Icon name="CornerDownLeft" size={13} color={colors.accent} />
                  <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>
                    {t("subagents.insertReport")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("subagents.copy")}
                  onPress={() => {
                    void copyText(reportText).then(() => toast.show(t("subagents.copied"), { durationMs: 2500 }));
                  }}
                  style={{ padding: 2 }}
                >
                  <Icon name="Copy" size={13} color={colors.foregroundMuted} />
                </Pressable>
              </View>
            </View>
            <Expandable colors={colors} height={240} background={colors.surface0} t={t}>
              <Markdown>{reportText}</Markdown>
            </Expandable>
          </View>
        </>
      ) : summary.state === "running" ? (
        <>
          <PopoverHairline theme={theme} inset={12} marginVertical={10} />
          <View style={{ paddingHorizontal: 12 }}>
            <Text style={{ ...font.caption, color: colors.foregroundMuted, fontStyle: "italic" }}>
              {t("subagents.runningNoReport")}
            </Text>
          </View>
        </>
      ) : null}

      {artifacts.length > 0 ? (
        <>
          <PopoverHairline theme={theme} inset={12} marginVertical={10} />
          <View style={{ paddingHorizontal: 12, gap: 6 }}>
            <Text style={{ fontSize: 11.5, lineHeight: 16, fontWeight: "600", color: colors.foregroundMuted }}>
              {`${t("subagents.artifacts")} (${artifacts.length})`}
            </Text>
            {artifacts.map((artifact) => {
              const isOpen = openArtifact === artifact.path;
              return (
                <View key={artifact.path} style={{ gap: space.xs }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isOpen }}
                    onPress={() => setOpenArtifact(isOpen ? null : artifact.path)}
                    style={({ hovered = false, pressed }: HoverState) => {
                      const fill = rowActiveFill(hovered, pressed);
                      return [
                        {
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 6,
                          paddingVertical: 4,
                          paddingHorizontal: 6,
                          marginHorizontal: -6,
                          borderRadius: 6,
                        },
                        fill === undefined ? undefined : { backgroundColor: theme.colors[fill] },
                      ];
                    }}
                  >
                    <Icon
                      name={artifact.isMarkdown ? "FileText" : "File"}
                      size={13}
                      color={isOpen ? colors.accent : colors.foregroundMuted}
                    />
                    <Text numberOfLines={1} style={{ ...font.caption, fontFamily: mono, color: colors.foreground, flex: 1 }}>
                      {artifact.path}
                    </Text>
                    <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                      {formatBytes(artifact.size)}
                    </Text>
                    <Icon name={isOpen ? "ChevronDown" : "ChevronRight"} size={13} color={colors.foregroundMuted} />
                  </Pressable>
                  {isOpen ? (
                    <ArtifactPreview colors={colors} agentId={agentId} subagentId={summary.id} artifact={artifact} t={t} />
                  ) : null}
                </View>
              );
            })}
          </View>
        </>
      ) : null}

      {recentActivity.length > 0 ? (
        <>
          <PopoverHairline theme={theme} inset={12} marginVertical={10} />
          <View style={{ paddingHorizontal: 12, gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <Text style={{ fontSize: 11.5, lineHeight: 16, fontWeight: "600", color: colors.foregroundMuted }}>
                {t("subagents.activity")}
              </Text>
              {rawActivity.length > recentActivity.length ? (
                <Text style={{ ...font.caption, color: colors.foregroundMuted }}>
                  {t("subagents.truncated", { count: recentActivity.length })}
                </Text>
              ) : null}
            </View>
            <View style={{ gap: space.sm }}>
              {recentActivity.map((entry) => (
                <EntryRow key={entry.index} colors={colors} entry={entry} t={t} locale={locale} />
              ))}
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}
