import {
  useAgent,
  useRpc,
  useTranslation,
  type PluginAgentPanelProps,
  type PluginClientContext,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { Icon, Markdown, ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, type ScrollView as NativeScrollView } from "react-native";
import {
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
import { clockTime, duration, money, tokens, upper } from "./format";
import { errorMessage, messages } from "./messages";
import { font, mono, radius, space, tabular, tint, toneColor, type Colors, type Tone } from "./theme";
import { Badge } from "./ui";

export const SUBAGENT_PANEL_ID = "subagents";

type ShownState = SubagentState | "starting";
type ListFilter = "all" | "running" | "failed";
type ActivityFilter = "all" | "tools" | "errors";

function useMessages() {
  return useTranslation(messages);
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

function StateLabel({ colors, state, t }: { colors: Colors; state: ShownState; t: Translate }) {
  const color = toneColor(colors, STATE_TONE[state]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <Icon name={STATE_ICON[state]} size={13} color={color} />
      <Text numberOfLines={1} style={{ ...font.caption, fontWeight: "500", color }}>
        {t(`subagents.state.${state}`)}
      </Text>
    </View>
  );
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

function activityLine(summary: SubagentSummary | undefined, t: Translate): string | null {
  if (!summary) return null;
  if (summary.state === "running" && summary.phase === "thinking") return t("subagents.thinking");
  return summary.activity;
}

function transcriptToMarkdown(summary: SubagentSummary, entries: readonly TranscriptEntry[], report: string | null): string {
  const lines: string[] = [
    `# ${summary.role ?? summary.type ?? summary.id}`,
    "",
    `- **ID**: \`${summary.id}\``,
    `- **State**: ${summary.state}`,
    summary.model ? `- **Model**: ${summary.model}` : "",
    `- **Tokens**: ${summary.inputTokens} input / ${summary.cachedTokens} cached / ${summary.outputTokens} output`,
    "",
  ].filter(Boolean);
  if (report) {
    lines.push("## Report", "", report, "");
  }
  lines.push("## Transcript", "");
  for (const entry of entries) {
    const stamp = entry.at ? `[${entry.at}] ` : "";
    lines.push(`### ${stamp}Step ${entry.index} (${entry.kind})`);
    if (entry.text) lines.push("", entry.text);
    for (const tool of entry.tools) {
      lines.push(`- \`${tool.name}\` ${tool.summary}${tool.failed ? " (FAILED)" : ""}`);
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

export function createSubagentViews(client: PluginClientContext) {
  function open(agentId: string, workspaceId: string | null | undefined, subagentId?: string) {
    if (!workspaceId) return;
    if (subagentId) requested.set(agentId, subagentId);
    client.openPanel(SUBAGENT_PANEL_ID, { workspaceId, agentId });
  }

  function insertIntoComposer(agentId: string, text: string): boolean {
    const composers = client.composers({ agentId });
    const composer = composers[0];
    if (!composer) return false;
    composer.insertText(text);
    void composer.focus().catch(() => undefined);
    return true;
  }

  // ---- Timeline: the row of an `invoke_subagent` call ------------------------------------------

  function SubagentCardRow({ agentId, item, theme }: PluginTimelineItemProps<SubagentCard>) {
    const { colors } = theme;
    const { t, locale } = useTranslation(messages);
    const query = useSubagents(agentId);
    const pricing = useUnifiedPricing();
    const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
    const card = item.data;
    const summary = useMemo(() => {
      const subagents = query.data?.subagents;
      if (!subagents?.length) return undefined;
      if (card.id) {
        const byId = subagents.find((subagent) => subagent.id === card.id);
        if (byId) return byId;
      }
      const taskPrefix = card.task.replace(/…$/, "").trim().slice(0, 80);
      return subagents.find((subagent) => {
        if (card.role && subagent.role && subagent.role !== card.role) return false;
        if (card.type && subagent.type && subagent.type !== card.type) return false;
        if (!taskPrefix) return Boolean(card.role && subagent.role === card.role);
        const candidateTask = subagent.task.trim();
        return (
          candidateTask.startsWith(taskPrefix) ||
          (candidateTask.length > 0 && taskPrefix.startsWith(candidateTask.slice(0, 80)))
        );
      });
    }, [query.data?.subagents, card.id, card.role, card.type, card.task]);
    const state = shownState(summary, card.status);
    const activity = activityLine(summary, t);
    const thinking = summary?.state === "running" && summary.phase === "thinking";
    const resolvedRole = summary?.role ?? card.role ?? null;
    const title = resolvedRole ?? card.type ?? t("subagents.title");
    const targetId = summary?.id || card.id || undefined;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title} · ${t(`subagents.state.${state}`)}`}
        onPress={() => open(agentId, workspaceId, targetId)}
        style={(pressState) => ({
          flexDirection: "row",
          gap: space.md,
          padding: space.md,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: (pressState as { hovered?: boolean }).hovered || pressState.pressed
            ? tint(colors.foreground, 0.04)
            : colors.surface1,
        })}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: radius.md,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: tint(toneColor(colors, STATE_TONE[state]), 0.12),
          }}
        >
          <Icon name="Bot" size={17} color={toneColor(colors, STATE_TONE[state])} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: colors.foreground, flexShrink: 1 }}>
              {title}
            </Text>
            {card.type && resolvedRole ? (
              <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
                {card.type}
              </Text>
            ) : null}
            <View style={{ flex: 1 }} />
            <StateLabel colors={colors} state={state} t={t} />
          </View>
          <Text numberOfLines={2} style={{ ...font.caption, color: colors.foregroundMuted }}>
            {card.task}
          </Text>
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
            <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>{t("subagents.open")}</Text>
              <Icon name="ChevronRight" size={13} color={colors.accent} />
            </View>
          </View>
        </View>
      </Pressable>
    );
  }

  // ---- Timeline: the row of a `manage_subagents` call ------------------------------------------

  function SubagentCheckRow({ agentId, item, theme }: PluginTimelineItemProps<SubagentCheck>) {
    const { colors } = theme;
    const { t } = useTranslation(messages);
    const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
    const check = item.data;
    const killed = check.action === "kill" || check.action === "kill_all";
    const title =
      check.action === "kill_all"
        ? check.states.length > 0
          ? t("subagents.check.killAllCount", { count: check.states.length })
          : t("subagents.check.killAll")
        : check.action === "kill"
          ? t("subagents.check.kill", { count: check.states.length })
          : check.action === "list"
            ? t("subagents.check.list")
            : t("subagents.check.other", { action: check.action });
    const counts = new Map<string, number>();
    if (!killed) for (const entry of check.states) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
    const chips = [...counts].map(([state, count]) => {
      const known = (["running", "done", "stopped", "failed", "idle"] as const).find((value) => value === state);
      const label = known ? t(`subagents.state.${known}`) : state;
      return { raw: state, state: known ?? "idle", text: `${count} ${label}` };
    });
    const names = killed
      ? check.states
          .map((entry) => entry.role ?? (entry.id.startsWith("#") ? "" : entry.id.slice(0, 8)))
          .filter(Boolean)
          .join(" · ")
      : "";
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={() => open(agentId, workspaceId)}
        style={(pressState) => ({
          flexDirection: "row",
          alignItems: "center",
          // Same icon column and gap as Paseo's own tool rows, with the hover wash bleeding outside.
          gap: 9,
          paddingVertical: space.xs,
          paddingHorizontal: 7,
          marginHorizontal: -6,
          borderRadius: radius.md,
          backgroundColor: (pressState as { hovered?: boolean }).hovered ? tint(colors.foreground, 0.05) : "transparent",
        })}
      >
        <Icon name={killed ? "OctagonX" : "ListChecks"} size={12} color={colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ ...font.small, color: colors.foregroundMuted }}>
          {title}
        </Text>
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
      </Pressable>
    );
  }

  // ---- Panel ----------------------------------------------------------------------------------

  function SubagentsPanel({ theme, layout, params, revision }: PluginAgentPanelProps) {
    const { colors } = theme;
    const { t } = useTranslation(messages);
    const agentId = params.agentId;
    const agent = useAgent(agentId, (snapshot) => ({ provider: snapshot.provider, title: snapshot.title }));
    const antigravity = isAntigravityProvider(agent?.provider);
    const query = useSubagents(agentId, antigravity);
    const list = query.data?.subagents ?? [];
    const [selected, setSelected] = useState<string | null>(null);
    const [filter, setFilter] = useState<ListFilter>("all");
    const [search, setSearch] = useState("");

    useEffect(() => {
      const wanted = requested.get(agentId);
      if (wanted) {
        requested.delete(agentId);
        setSelected(wanted);
      } else {
        setSelected(null);
      }
      setFilter("all");
      setSearch("");
    }, [agentId, revision]);

    const filtered = useMemo(() => {
      const q = search.trim().toLowerCase();
      return list.filter((subagent) => {
        if (filter === "running" && subagent.state !== "running") return false;
        if (filter === "failed" && subagent.state !== "failed") return false;
        if (!q) return true;
        return (
          (subagent.role ?? "").toLowerCase().includes(q) ||
          (subagent.type ?? "").toLowerCase().includes(q) ||
          subagent.task.toLowerCase().includes(q)
        );
      });
    }, [list, filter, search]);

    const current =
      filtered.find((subagent) => subagent.id === selected) ??
      list.find((subagent) => subagent.id === selected) ??
      (layout.compact ? undefined : filtered[0] ?? list[0]);
    const running = list.filter((subagent) => subagent.state === "running").length;
    const failedCount = list.filter((subagent) => subagent.state === "failed").length;

    if (!antigravity) return <Empty colors={colors} icon="Bot" text={t("subagents.notAntigravity")} />;
    if (query.isLoading) return <Empty colors={colors} icon="LoaderCircle" text="" />;
    if (!list.length) return <Empty colors={colors} icon="Bot" text={t("subagents.empty")} />;

    const header = (
      <View style={{ gap: space.sm, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, paddingHorizontal: space.xs }}>
          <Text style={{ ...font.heading, color: colors.foreground }}>{t("subagents.title")}</Text>
          <Text style={{ ...font.small, ...tabular, color: colors.foregroundMuted }}>
            {running ? t("subagents.summary", { total: list.length, running }) : t("subagents.summaryIdle", { total: list.length })}
          </Text>
        </View>
        {list.length > 1 ? (
          <>
            <View style={{ flexDirection: "row", gap: space.xs, flexWrap: "wrap" }}>
              <FilterChip colors={colors} label={t("subagents.filter.all")} active={filter === "all"} onPress={() => setFilter("all")} />
              {running > 0 ? (
                <FilterChip
                  colors={colors}
                  label={`${t("subagents.filter.running")} (${running})`}
                  active={filter === "running"}
                  onPress={() => setFilter("running")}
                />
              ) : null}
              {failedCount > 0 ? (
                <FilterChip
                  colors={colors}
                  label={`${t("subagents.filter.failed")} (${failedCount})`}
                  active={filter === "failed"}
                  onPress={() => setFilter("failed")}
                />
              ) : null}
            </View>
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
          </>
        ) : null}
      </View>
    );

    const rows = (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: space.lg, gap: 2 }}>
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
              onInsertReport={(text) => insertIntoComposer(agentId, text)}
            />
          </View>
        );
      }
      return (
        <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
          {header}
          {rows}
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
              onInsertReport={(text) => insertIntoComposer(agentId, text)}
            />
          ) : (
            <Empty colors={colors} icon="MousePointerClick" text={t("subagents.pick")} />
          )}
        </View>
      </View>
    );
  }

  return { SubagentCardRow, SubagentCheckRow, SubagentsPanel, open };
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
  const { locale } = useTranslation(messages);
  const pricing = useUnifiedPricing();
  const color = toneColor(colors, STATE_TONE[subagent.state]);
  const activity = activityLine(subagent, t);
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
        <Icon name={STATE_ICON[subagent.state]} size={14} color={color} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: colors.foreground, flexShrink: 1 }}>
            {subagent.role ?? subagent.type ?? subagent.id.slice(0, 8)}
          </Text>
          {subagent.type && subagent.role ? (
            <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
              {subagent.type}
            </Text>
          ) : null}
        </View>
        {parent ? (
          <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
            {t("subagents.nested", { role: parent.role ?? parent.type ?? parent.id.slice(0, 8) })}
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
  onInsertReport,
}: {
  colors: Colors;
  agentId: string;
  summary: SubagentSummary;
  compact: boolean;
  onInsertReport(text: string): boolean;
}) {
  const { t, locale } = useTranslation(messages);
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

  return (
    <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: pad, gap: space.xl }}>
      <View style={{ gap: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Text style={{ ...font.title, color: colors.foreground }}>{summary.role ?? summary.type ?? summary.id.slice(0, 8)}</Text>
          {summary.type && summary.role ? <Badge colors={colors} label={summary.type} /> : null}
          <Badge colors={colors} label={t(`subagents.state.${summary.state}`)} tone={STATE_TONE[summary.state]} dot />
          <View style={{ flex: 1 }} />
          {entries.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("subagents.copyTranscript")}
              onPress={() => {
                const md = transcriptToMarkdown(summary, entries, detail?.report ?? null);
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
          {tool.name}
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
