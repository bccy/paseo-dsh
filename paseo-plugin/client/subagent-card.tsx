/**
 * Lightweight expandable subagent cards (`subagent` / `subagent_fork`) and
 * single-line status chips (`list_agents` / `archive_subagents`) for the Paseo
 * timeline.
 *
 * Lives in its own module rather than inline in `./tool-call`:
 * - `harness/style-check.cjs` enforces that every JSX `color=` / `tintColor=`
 *   prop in `tool-call.tsx` references `iconColor` so regular tool rows keep
 *   one unified state-color rule.
 * - Subagent cards carry semantic status tints (running ring, completed,
 *   failed, canceled) and soft-tinted status count `Badge`s, so isolating them
 *   here mirrors `./team-card.tsx` and keeps regular 24px tool rows untouched.
 *
 * Design invariants:
 * - **In-place expansion only**: never creates a custom subagent panel and
 *   never calls non-existent navigation APIs.
 * - **Facts only**: renders `steps · duration · output tokens` strictly for
 *   observed fields present on `DshSubagentMetadata`; missing numbers are
 *   omitted, never fabricated.
 * - **Platform-neutral & Hermes-safe**: zero browser-only APIs, zero third-party
 *   runtime deps, bilingual (`zh-CN` / `en`) via `useCurrentLocale()`, and safe
 *   guarded clipboard copy via Paseo's `copyText`.
 *
 * @module dsh-paseo/client/subagent-card
 */
import { Icon, ScrollView, copyText } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { parseSubagentActivation, type SubagentStatus } from "../shared/subagent-card";
import { duration, integer, tokens } from "./console-format";
import {
  font,
  radius,
  space,
  tabular,
  tint,
  toneColor,
  type Colors,
  type Tone,
} from "./console-theme";
import { Badge, Expandable } from "./console-ui";
import type { Locale } from "./locale";
import { SCROLL_BOX_TEST_ID } from "./row-entrance";
import { StatusRingMark } from "./status-ring";
import { useLiveSubagentCard } from "./subagent-live";
import type { SubagentCardData, SubagentStatusChipsData } from "./tool-call-data";
import { useCurrentLocale } from "./use-locale";

/** Deterministic testID hooks for offline assertions. */
export const SUBAGENT_CARD_TEST_ID = "dsh-subagent-card";
export const SUBAGENT_CARD_ICON_TEST_ID = "dsh-subagent-card-icon";
export const SUBAGENT_CARD_BODY_TEST_ID = "dsh-subagent-card-body";
export const SUBAGENT_CHIPS_TEST_ID = "dsh-subagent-status-chips";

/** Theme palette subset required by subagent card and chip views. */
export type SubagentCardColors = Pick<
  Colors,
  | "surface0"
  | "surface1"
  | "border"
  | "foreground"
  | "foregroundMuted"
  | "accent"
  | "statusSuccess"
  | "statusWarning"
  | "statusDanger"
>;

interface SubagentCopy {
  defaultTitle: string;
  defaultForkTitle: string;
  forkTag: string;
  statuses: Record<SubagentStatus, string>;
  expand: string;
  collapse: string;
  showMore: string;
  showLess: string;
  taskLabel: string;
  reportLabel: string;
  outputLabel: string;
  errorLabel: string;
  copy: string;
  copied: string;
  runningNoReport: string;
  steps: (count: number) => string;
  outputTokens: (formatted: string) => string;
  chips: {
    running: (count: number) => string;
    inactive: (count: number) => string;
    completed: (count: number) => string;
    failed: (count: number) => string;
    canceled: (count: number) => string;
    archived: (count: number) => string;
    diagnostic: (count: number) => string;
    other: (count: number) => string;
    leadOnly: string;
    noSubagents: string;
    archivedCount: (count: number) => string;
    wouldArchiveCount: (count: number) => string;
    runningSkipped: (count: number) => string;
    alreadyArchived: (count: number) => string;
    nothingToArchive: string;
  };
}

const SUBAGENT_COPY: Record<Locale, SubagentCopy> = {
  "zh-CN": {
    defaultTitle: "子智能体",
    defaultForkTitle: "子智能体分支",
    forkTag: "分支",
    statuses: {
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      canceled: "已取消",
    },
    expand: "展开",
    collapse: "收起",
    showMore: "展开全文",
    showLess: "收起全文",
    taskLabel: "任务",
    reportLabel: "最终报告",
    outputLabel: "输出",
    errorLabel: "错误",
    copy: "复制",
    copied: "已复制",
    runningNoReport: "子智能体正在运行，尚未产生最终报告…",
    steps: (count) => `${integer(count, "zh-CN")} 步`,
    outputTokens: (formatted) => `${formatted} 输出`,
    chips: {
      running: (count) => `${integer(count, "zh-CN")} 运行中`,
      inactive: (count) => `${integer(count, "zh-CN")} 空闲`,
      completed: (count) => `${integer(count, "zh-CN")} 已完成`,
      failed: (count) => `${integer(count, "zh-CN")} 失败`,
      canceled: (count) => `${integer(count, "zh-CN")} 已取消`,
      archived: (count) => `${integer(count, "zh-CN")} 已归档`,
      diagnostic: (count) => `${integer(count, "zh-CN")} 异常`,
      other: (count) => `${integer(count, "zh-CN")} 其他`,
      leadOnly: "仅主会话",
      noSubagents: "无子智能体",
      archivedCount: (count) => `已归档 ${integer(count, "zh-CN")} 个`,
      wouldArchiveCount: (count) => `将归档 ${integer(count, "zh-CN")} 个`,
      runningSkipped: (count) => `跳过 ${integer(count, "zh-CN")} 运行中`,
      alreadyArchived: (count) => `均已归档 (${integer(count, "zh-CN")})`,
      nothingToArchive: "无可归档",
    },
  },
  en: {
    defaultTitle: "Subagent",
    defaultForkTitle: "Forked subagent",
    forkTag: "fork",
    statuses: {
      running: "Running",
      completed: "Done",
      failed: "Failed",
      canceled: "Canceled",
    },
    expand: "Expand",
    collapse: "Collapse",
    showMore: "Show more",
    showLess: "Show less",
    taskLabel: "Task",
    reportLabel: "Final report",
    outputLabel: "Output",
    errorLabel: "Error",
    copy: "Copy",
    copied: "Copied",
    runningNoReport: "Subagent is running — waiting for final report…",
    steps: (count) => `${integer(count, "en")} ${count === 1 ? "step" : "steps"}`,
    outputTokens: (formatted) => `${formatted} out`,
    chips: {
      running: (count) => `${integer(count, "en")} running`,
      inactive: (count) => `${integer(count, "en")} idle`,
      completed: (count) => `${integer(count, "en")} done`,
      failed: (count) => `${integer(count, "en")} failed`,
      canceled: (count) => `${integer(count, "en")} canceled`,
      archived: (count) => `${integer(count, "en")} archived`,
      diagnostic: (count) => `${integer(count, "en")} ${count === 1 ? "issue" : "issues"}`,
      other: (count) => `${integer(count, "en")} other`,
      leadOnly: "Lead only",
      noSubagents: "No subagents",
      archivedCount: (count) => `Archived ${integer(count, "en")}`,
      wouldArchiveCount: (count) => `Would archive ${integer(count, "en")}`,
      runningSkipped: (count) => `${integer(count, "en")} running skipped`,
      alreadyArchived: (count) => `${integer(count, "en")} already archived`,
      nothingToArchive: "Nothing to archive",
    },
  },
};

const STATUS_TONE: Record<SubagentStatus, Tone> = {
  running: "accent",
  completed: "success",
  failed: "danger",
  canceled: "neutral",
};

const SETTLED_STATUS_ICON: Record<Exclude<SubagentStatus, "running">, string> = {
  completed: "CircleCheck",
  failed: "CircleAlert",
  canceled: "CircleSlash",
};

const EXPANDABLE_TASK_HEIGHT = 108;

/** Generic ASCII placeholder slugs that should never display verbatim as a card title. */
const GENERIC_SUBAGENT_SLUGS = new Set([
  "default",
  "general",
  "general-purpose",
  "subagent",
  "sub_agent",
  "subagent_fork",
  "assistant",
  "agent",
]);

/** Localized display labels for common built-in English subagent role/preset slugs. */
const BUILTIN_ROLE_LABELS: Record<Locale, Readonly<Record<string, string>>> = {
  "zh-CN": {
    explore: "探索子智能体",
    explorer: "探索子智能体",
    plan: "规划子智能体",
    planner: "规划子智能体",
    code: "编码子智能体",
    coder: "编码子智能体",
    research: "调研子智能体",
    researcher: "调研子智能体",
    review: "审查子智能体",
    reviewer: "审查子智能体",
    search: "检索子智能体",
    searcher: "检索子智能体",
    analyst: "分析子智能体",
    worker: "执行子智能体",
    scout: "探查子智能体",
  },
  en: {
    explore: "Explore subagent",
    explorer: "Explore subagent",
    plan: "Plan subagent",
    planner: "Plan subagent",
    code: "Code subagent",
    coder: "Code subagent",
    research: "Research subagent",
    researcher: "Research subagent",
    review: "Review subagent",
    reviewer: "Review subagent",
    search: "Search subagent",
    searcher: "Search subagent",
    analyst: "Analyst subagent",
    worker: "Worker subagent",
    scout: "Scout subagent",
  },
};

/**
 * Resolve the primary display title and muted secondary metadata caption for a
 * subagent card.
 *
 * DSH requires ASCII identifiers for `name` / `agent_preset` (e.g.
 * `"host-api-scout"`, `"agent-1"`, `"default"`) while storing the human-readable
 * localized label in `args.description` / `subagent/catalog.label` (`title`).
 * Prefer `title` first so cards show the user's language by default; localize
 * generic or built-in English slugs when no explicit `title` was supplied.
 */
export function resolveSubagentDisplayTitle(
  subagent: Pick<SubagentCardData, "kind" | "title" | "role" | "preset" | "model">,
  locale: Locale,
): { primaryTitle: string; secondaryLabel: string } {
  const copy = SUBAGENT_COPY[locale];
  const isFork = subagent.kind === "subagent_fork";
  const defaultTitle = isFork ? copy.defaultForkTitle : copy.defaultTitle;
  const trimmedTitle = subagent.title?.trim() ?? "";
  const trimmedRole = subagent.role?.trim() ?? "";
  const roleKey = trimmedRole.toLowerCase();

  let primaryTitle: string;
  let roleConsumedAsPrimary = false;
  if (trimmedTitle !== "") {
    primaryTitle = trimmedTitle;
  } else if (trimmedRole === "" || GENERIC_SUBAGENT_SLUGS.has(roleKey)) {
    primaryTitle = defaultTitle;
    roleConsumedAsPrimary = true;
  } else {
    const autoIdMatch = /^agent-(\d+)$/i.exec(trimmedRole);
    if (autoIdMatch !== null) {
      primaryTitle = `${defaultTitle} #${autoIdMatch[1]}`;
      roleConsumedAsPrimary = true;
    } else {
      const localizedBuiltIn = BUILTIN_ROLE_LABELS[locale][roleKey];
      if (localizedBuiltIn !== undefined) {
        primaryTitle = localizedBuiltIn;
        roleConsumedAsPrimary = true;
      } else {
        primaryTitle = trimmedRole;
        roleConsumedAsPrimary = true;
      }
    }
  }

  const parts: string[] = [];
  const seen = new Set<string>([primaryTitle.trim().toLowerCase()]);
  if (roleConsumedAsPrimary && roleKey !== "") {
    seen.add(roleKey);
  }
  const pushUnique = (raw: string | undefined, skipGeneric = false) => {
    if (raw === undefined) return;
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const key = trimmed.toLowerCase();
    if (skipGeneric && GENERIC_SUBAGENT_SLUGS.has(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(trimmed);
  };

  const roleIsAutoId = /^agent-\d+$/i.test(trimmedRole);
  if (!roleConsumedAsPrimary && !roleIsAutoId) {
    pushUnique(trimmedRole, true);
  }
  pushUnique(subagent.preset, true);
  pushUnique(subagent.model, false);
  if (parts.length === 0 && isFork && primaryTitle !== copy.defaultForkTitle) {
    pushUnique(copy.forkTag);
  }

  return {
    primaryTitle,
    secondaryLabel: parts.join(" · "),
  };
}

/**
 * Safe clipboard helper over Paseo's `copyText`.
 *
 * Uses zero browser-only globals (`navigator.clipboard` / `document.execCommand`)
 * so native iOS/Android/Hermes runtimes and minimal offline test stubs never
 * crash. Returns `false` if clipboard access is unavailable or rejected.
 */
export function safeCopyText(text: string): Promise<boolean> {
  if (typeof copyText !== "function") return Promise.resolve(false);
  try {
    return Promise.resolve(copyText(text)).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Format observed subagent execution facts (`steps · duration · output tokens`).
 *
 * Pure helper exported for direct offline verification: omits every unmeasured
 * metric and never fabricates placeholder zeroes.
 */
export function subagentFactParts(
  subagent: Pick<SubagentCardData, "steps" | "durationMs" | "outputTokens">,
  locale: Locale,
): string[] {
  const copy = SUBAGENT_COPY[locale];
  const parts: string[] = [];
  if (typeof subagent.steps === "number" && Number.isFinite(subagent.steps)) {
    parts.push(copy.steps(subagent.steps));
  }
  if (typeof subagent.durationMs === "number" && Number.isFinite(subagent.durationMs)) {
    const formatted = duration(subagent.durationMs, locale);
    if (formatted !== "") parts.push(formatted);
  }
  if (typeof subagent.outputTokens === "number" && Number.isFinite(subagent.outputTokens)) {
    parts.push(copy.outputTokens(tokens(subagent.outputTokens)));
  }
  return parts;
}

/** One compact inline status chip descriptor rendered by {@link SubagentStatusChips}. */
export interface StatusChipItem {
  readonly key: string;
  readonly label: string;
  readonly tone: Tone;
  readonly dot?: boolean;
  readonly icon?: string;
}

/**
 * Convert a parsed `list_agents` or `archive_subagents` summary into localized
 * status-chip descriptors.
 */
export function subagentStatusChipItems(
  chips: SubagentStatusChipsData,
  locale: Locale,
  options?: { hasSummary?: boolean },
): StatusChipItem[] {
  const copy = SUBAGENT_COPY[locale].chips;
  if (chips.kind === "list_agents") {
    const { counts, leadOnly } = chips.list;
    const items: StatusChipItem[] = [];
    if (counts.running > 0) {
      items.push({ key: "running", label: copy.running(counts.running), tone: "accent", dot: true });
    }
    if (counts.failed > 0) {
      items.push({ key: "failed", label: copy.failed(counts.failed), tone: "danger", icon: "CircleAlert" });
    }
    if (counts.diagnostic > 0) {
      items.push({ key: "diagnostic", label: copy.diagnostic(counts.diagnostic), tone: "warning", icon: "TriangleAlert" });
    }
    if (counts.completed > 0) {
      items.push({ key: "completed", label: copy.completed(counts.completed), tone: "success", icon: "CircleCheck" });
    }
    if (counts.inactive > 0) {
      items.push({ key: "inactive", label: copy.inactive(counts.inactive), tone: "neutral", dot: true });
    }
    if (counts.canceled > 0) {
      items.push({ key: "canceled", label: copy.canceled(counts.canceled), tone: "neutral", icon: "CircleSlash" });
    }
    if (counts.archived > 0) {
      items.push({ key: "archived", label: copy.archived(counts.archived), tone: "neutral", icon: "Archive" });
    }
    if (counts.other > 0) {
      items.push({ key: "other", label: copy.other(counts.other), tone: "neutral" });
    }
    if (items.length === 0 && options?.hasSummary !== true) {
      items.push({
        key: leadOnly ? "lead-only" : "empty",
        label: leadOnly ? copy.leadOnly : copy.noSubagents,
        tone: "neutral",
      });
    }
    return items;
  }

  const { archive } = chips;
  const items: StatusChipItem[] = [];
  if (archive.archived > 0) {
    items.push({
      key: archive.dryRun ? "would-archive" : "archived",
      label: archive.dryRun
        ? copy.wouldArchiveCount(archive.archived)
        : copy.archivedCount(archive.archived),
      tone: archive.dryRun ? "accent" : "success",
      icon: "Archive",
    });
  }
  if (archive.running > 0) {
    items.push({
      key: "running-skipped",
      label: copy.runningSkipped(archive.running),
      tone: "warning",
      dot: true,
    });
  }
  if (archive.failed > 0) {
    items.push({
      key: "failed",
      label: copy.failed(archive.failed),
      tone: "danger",
      icon: "CircleAlert",
    });
  }
  if (items.length === 0) {
    if (archive.alreadyArchived > 0) {
      items.push({
        key: "already-archived",
        label: copy.alreadyArchived(archive.alreadyArchived),
        tone: "neutral",
      });
    } else {
      items.push({
        key: "nothing",
        label: copy.nothingToArchive,
        tone: "neutral",
      });
    }
  }
  return items;
}

function CopyChipButton({
  text,
  copyLabel,
  copiedLabel,
  colors,
}: {
  text: string;
  copyLabel: string;
  copiedLabel: string;
  colors: SubagentCardColors;
}) {
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const handleCopy = useCallback(
    (event?: { stopPropagation?: () => void }) => {
      event?.stopPropagation?.();
      if (copied) return;
      void safeCopyText(text).then((ok) => {
        if (!ok || !mountedRef.current) return;
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          if (mountedRef.current) setCopied(false);
        }, 1200);
      });
    },
    [copied, text],
  );

  const label = copied ? copiedLabel : copyLabel;
  const ink = copied ? colors.statusSuccess : colors.foregroundMuted;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={handleCopy}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 6,
        height: 22,
        borderRadius: radius.sm,
        backgroundColor:
          (state as { hovered?: boolean }).hovered || state.pressed
            ? tint(colors.foreground, 0.07)
            : "transparent",
      })}
    >
      <Icon name={copied ? "Check" : "Copy"} size={12} color={ink} />
      <Text style={{ ...font.caption, fontWeight: "500", color: ink }}>{label}</Text>
    </Pressable>
  );
}

export interface SubagentCardProps {
  subagent: SubagentCardData;
  /** Paseo agent id used for event-driven cross-turn live updates while running. */
  agentId?: string;
  /** Tool call id matching `subagent` / `subagent_fork` in the server session. */
  callId?: string;
  colors: SubagentCardColors;
  hairline?: number;
  expandedMaxHeight?: number;
  compact?: boolean;
  /** Controlled expanded state; omit for uncontrolled internal state. */
  expanded?: boolean;
  onToggle?: () => void;
  /** Raw failure text from `ToolCallData.error`, if any. */
  error?: string;
  /** Localized short failure reason from `ToolCallData.errorShort`, if any. */
  errorShort?: string;
  /** Localized failure hint from `ToolCallData.errorHint`, if any. */
  errorHint?: string;
  errorCode?: string;
  errorName?: string;
  /** Fallback raw log/output from `ToolCallData.body` for pre-upgrade rows. */
  fallbackBody?: string;
}

/**
 * Compact expandable timeline card for `subagent` and `subagent_fork`.
 */
export function SubagentCard({
  subagent,
  agentId,
  callId,
  colors,
  hairline = 1,
  expandedMaxHeight = 260,
  compact = false,
  expanded: controlledExpanded,
  onToggle,
  error = "",
  errorShort = "",
  errorHint = "",
  errorCode = "",
  errorName,
  fallbackBody = "",
}: SubagentCardProps) {
  const locale = useCurrentLocale();
  const copy = SUBAGENT_COPY[locale];
  const liveSubagent = useLiveSubagentCard(agentId, callId, subagent);
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(false);
  const expanded = controlledExpanded ?? uncontrolledExpanded;

  const toggle = useCallback(() => {
    if (onToggle !== undefined) {
      onToggle();
    } else {
      setUncontrolledExpanded((value) => !value);
    }
  }, [onToggle]);

  const isFork = liveSubagent.kind === "subagent_fork";
  const statusTone = STATUS_TONE[liveSubagent.status];
  const statusColor = toneColor(colors, statusTone);
  const statusLabel = copy.statuses[liveSubagent.status];
  const statusIcon: string | ReactNode =
    liveSubagent.status === "running"
      ? <StatusRingMark size={12} ring={10} color={statusColor} />
      : SETTLED_STATUS_ICON[liveSubagent.status];

  const { primaryTitle, secondaryLabel } = useMemo(
    () => resolveSubagentDisplayTitle(liveSubagent, locale),
    [
      liveSubagent.kind,
      liveSubagent.title,
      liveSubagent.role,
      liveSubagent.preset,
      liveSubagent.model,
      locale,
    ],
  );

  const trimmedTitle = liveSubagent.title?.trim() ?? "";
  const trimmedTask = liveSubagent.task?.trim() ?? "";
  const showTitleInPreview =
    trimmedTitle !== "" && trimmedTitle !== primaryTitle.trim();

  // Collapsed 2-line task summary: avoids repeating primaryTitle while surfacing
  // both short title and prompt opening when available.
  const taskPreview = useMemo(() => {
    if (showTitleInPreview && trimmedTask !== "") {
      return trimmedTask.startsWith(trimmedTitle)
        ? trimmedTask
        : `${trimmedTitle}\n${trimmedTask}`;
    }
    if (trimmedTask !== "") return trimmedTask;
    if (showTitleInPreview) return trimmedTitle;
    return "";
  }, [showTitleInPreview, trimmedTitle, trimmedTask]);

  // Never show an async `"started subagent <name>"` activation ack as a report.
  const cleanFallbackBody = useMemo(() => {
    const trimmed = fallbackBody.trim();
    if (trimmed === "") return "";
    if (parseSubagentActivation(undefined, trimmed) !== null) return "";
    if (error.trim() !== "" && trimmed === error.trim()) return "";
    return fallbackBody;
  }, [fallbackBody, error]);

  const reportText =
    liveSubagent.report !== undefined && liveSubagent.report.trim() !== ""
      ? liveSubagent.report
      : cleanFallbackBody;
  const hasExplicitReport =
    liveSubagent.report !== undefined && liveSubagent.report.trim() !== "";
  const fullTaskText =
    trimmedTask !== "" ? (liveSubagent.task ?? trimmedTask) : showTitleInPreview ? trimmedTitle : "";

  const trimmedError = error.trim();
  const errorFirstLine = trimmedError === "" ? "" : trimmedError.split("\n")[0] ?? "";
  const errorPreview =
    liveSubagent.status === "failed"
      ? errorShort !== ""
        ? errorShort
        : errorFirstLine
      : "";
  const hasErrorBlock = trimmedError !== "" || errorHint !== "" || errorCode !== "";

  const factLine = useMemo(
    () => subagentFactParts(liveSubagent, locale).join(" · "),
    [liveSubagent.steps, liveSubagent.durationMs, liveSubagent.outputTokens, locale],
  );

  const canExpand =
    fullTaskText !== "" ||
    reportText !== "" ||
    hasErrorBlock ||
    liveSubagent.status === "running";

  const cardAccessibilityLabel = [
    primaryTitle,
    secondaryLabel,
    statusLabel,
    factLine,
  ]
    .filter(Boolean)
    .join(" · ");

  const padX = compact ? space.sm + 2 : space.md;
  const padY = space.sm + 2;

  return (
    <View
      testID={SUBAGENT_CARD_TEST_ID}
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
        accessibilityLabel={cardAccessibilityLabel}
        accessibilityState={{ expanded: canExpand ? expanded : undefined }}
        disabled={!canExpand}
        onPress={() => {
          if (canExpand) toggle();
        }}
        style={(pressState) => ({
          flexDirection: "row",
          alignItems: "flex-start",
          gap: space.sm + 2,
          paddingHorizontal: padX,
          paddingVertical: padY,
          backgroundColor:
            canExpand &&
            ((pressState as { hovered?: boolean }).hovered || pressState.pressed)
              ? tint(colors.foreground, 0.04)
              : "transparent",
        })}
      >
        <View
          testID={SUBAGENT_CARD_ICON_TEST_ID}
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
          <Icon
            name={isFork ? "GitFork" : "Bot"}
            size={15}
            color={statusColor}
          />
        </View>

        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "baseline",
                gap: 6,
                flex: 1,
                minWidth: 0,
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  ...font.small,
                  fontWeight: "600",
                  color: colors.foreground,
                  flexShrink: 1,
                }}
              >
                {primaryTitle}
              </Text>
              {secondaryLabel !== "" ? (
                <Text
                  numberOfLines={1}
                  style={{
                    ...font.caption,
                    color: colors.foregroundMuted,
                    flexShrink: 2,
                  }}
                >
                  {secondaryLabel}
                </Text>
              ) : null}
            </View>
            <Badge
              colors={colors}
              tone={statusTone}
              icon={statusIcon}
              label={statusLabel}
              style={{ flexShrink: 0 }}
            />
          </View>

          {!expanded && taskPreview !== "" ? (
            <Text
              numberOfLines={2}
              style={{ ...font.caption, color: colors.foregroundMuted }}
            >
              {taskPreview}
            </Text>
          ) : expanded && showTitleInPreview && trimmedTask !== "" ? (
            <Text
              numberOfLines={1}
              style={{ ...font.caption, color: colors.foregroundMuted }}
            >
              {trimmedTitle}
            </Text>
          ) : null}

          {!expanded && errorPreview !== "" ? (
            <Text
              numberOfLines={1}
              style={{ ...font.caption, color: colors.statusDanger }}
            >
              {errorPreview}
            </Text>
          ) : null}

          {factLine !== "" || canExpand ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.sm,
                marginTop: 1,
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  ...font.caption,
                  ...tabular,
                  color: colors.foregroundMuted,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {factLine}
              </Text>
              {canExpand ? (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 2,
                    flexShrink: 0,
                  }}
                >
                  <Text
                    style={{
                      ...font.caption,
                      fontWeight: "500",
                      color: colors.accent,
                    }}
                  >
                    {expanded ? copy.collapse : copy.expand}
                  </Text>
                  <Icon
                    name={expanded ? "ChevronUp" : "ChevronDown"}
                    size={13}
                    color={colors.accent}
                  />
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </Pressable>

      {expanded && canExpand ? (
        <View
          testID={SUBAGENT_CARD_BODY_TEST_ID}
          style={{
            borderTopWidth: hairline,
            borderTopColor: colors.border,
            paddingHorizontal: padX,
            paddingVertical: padY,
            gap: space.sm + 2,
          }}
        >
          {hasErrorBlock ? (
            <View
              style={{
                borderRadius: radius.md,
                padding: space.sm,
                backgroundColor: tint(colors.statusDanger, 0.08),
                gap: 4,
              }}
            >
              <Text style={{ ...font.overline, color: colors.statusDanger }}>
                {copy.errorLabel}
              </Text>
              {errorHint !== "" || errorCode !== "" ? (
                <Text style={{ ...font.caption, color: colors.foregroundMuted }} selectable>
                  {[
                    errorHint,
                    errorCode !== ""
                      ? `${errorCode}${errorName ? ` (${errorName})` : ""}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join("  ")}
                </Text>
              ) : null}
              {trimmedError !== "" ? (
                <Text
                  selectable
                  style={{ ...font.caption, lineHeight: 18, color: colors.statusDanger }}
                >
                  {trimmedError}
                </Text>
              ) : null}
            </View>
          ) : null}

          {fullTaskText !== "" ? (
            <View style={{ gap: 4 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: space.sm,
                }}
              >
                <Text style={{ ...font.overline, color: colors.foregroundMuted }}>
                  {copy.taskLabel}
                </Text>
                <CopyChipButton
                  text={fullTaskText}
                  copyLabel={copy.copy}
                  copiedLabel={copy.copied}
                  colors={colors}
                />
              </View>
              <Expandable
                colors={colors}
                height={EXPANDABLE_TASK_HEIGHT}
                background={colors.surface1}
                expandLabel={copy.showMore}
                collapseLabel={copy.showLess}
              >
                <Text
                  selectable
                  style={{ ...font.caption, lineHeight: 18, color: colors.foreground }}
                >
                  {fullTaskText}
                </Text>
              </Expandable>
            </View>
          ) : null}

          {reportText !== "" ? (
            <View style={{ gap: 4 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: space.sm,
                }}
              >
                <Text style={{ ...font.overline, color: colors.foregroundMuted }}>
                  {hasExplicitReport ? copy.reportLabel : copy.outputLabel}
                </Text>
                <CopyChipButton
                  text={reportText}
                  copyLabel={copy.copy}
                  copiedLabel={copy.copied}
                  colors={colors}
                />
              </View>
              <ScrollView
                style={{ maxHeight: expandedMaxHeight }}
                nestedScrollEnabled
                testID={SCROLL_BOX_TEST_ID}
              >
                <Text
                  selectable
                  style={{ ...font.caption, lineHeight: 18, color: colors.foreground }}
                >
                  {reportText}
                </Text>
              </ScrollView>
            </View>
          ) : liveSubagent.status === "running" ? (
            <Text style={{ ...font.caption, color: colors.foregroundMuted }}>
              {copy.runningNoReport}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export interface SubagentStatusChipsProps {
  chips: SubagentStatusChipsData;
  colors: SubagentCardColors;
  /** True when the tool head already prints a non-empty summary string. */
  hasSummary?: boolean;
  /** Narrow mobile viewport hint: caps visible chips cleanly to keep one line. */
  compact?: boolean;
}

/**
 * Inline status-count `Badge` strip rendered on the right of a single-line
 * `list_agents` or `archive_subagents` tool row.
 */
export function SubagentStatusChips({
  chips,
  colors,
  hasSummary = false,
  compact = false,
}: SubagentStatusChipsProps) {
  const locale = useCurrentLocale();
  const items = useMemo(
    () => subagentStatusChipItems(chips, locale, { hasSummary }),
    [chips, locale, hasSummary],
  );

  if (items.length === 0) return null;

  const maxVisible = compact ? 3 : items.length;
  const visible = items.slice(0, maxVisible);
  const overflow = items.length - visible.length;

  return (
    <View
      testID={SUBAGENT_CHIPS_TEST_ID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: compact ? 3 : 4,
        flexShrink: 0,
        marginLeft: "auto",
      }}
    >
      {visible.map((chip) => (
        <Badge
          key={chip.key}
          colors={colors}
          tone={chip.tone}
          dot={chip.dot}
          icon={chip.icon}
          label={chip.label}
          style={{ height: 18, paddingHorizontal: 6, gap: 4 }}
        />
      ))}
      {overflow > 0 ? (
        <Badge
          colors={colors}
          tone="neutral"
          label={`+${overflow}`}
          style={{ height: 18, paddingHorizontal: 6 }}
        />
      ) : null}
    </View>
  );
}
