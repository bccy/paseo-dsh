import type {
  PluginButtonContentProps,
  PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { StepEntry, StepsCard } from "../../shared/antigravity/contracts";
import { tabular } from "../console-theme";
import {
  CHEVRON_BOX,
  FACTS_FONT_SIZE,
  TITLE_FONT_SIZE,
  chevronColorToken,
  chevronRotation,
  popoverRootBox,
  ringColorFor,
  rowActiveFill,
  rowBox,
} from "../jobs-popover-layout";
import {
  PopoverHairline,
  PopoverPill,
  type PopoverTheme,
} from "../popover-ui";
import { createSeenCloseGate } from "../seen-close-gate";
import { StatusRingMark } from "../status-ring";
import { useAntigravityTranslation } from "./messages";
import {
  summarizeSteps,
  windowSteps,
  type StepsStore,
} from "./stepsModel";

type HoverState = PressableStateCallbackType & { hovered?: boolean };

const WINDOW_LIMIT = 7;

function extraMutedColor(theme: PopoverTheme): string {
  return (theme.colors as Record<string, string>).foregroundExtraMuted ?? theme.colors.foregroundMuted;
}

function StepStatusMark({
  status,
  theme,
  size = 15,
}: {
  status: StepEntry["status"];
  theme: PopoverTheme;
  size?: number;
}) {
  const { colors } = theme;
  const muted = extraMutedColor(theme);
  if (status === "done") {
    return <Icon name="CircleCheck" size={size} color={colors.statusSuccess} />;
  }
  if (status === "in_progress") {
    return <StatusRingMark size={size} ring={Math.max(10, size - 2)} color={ringColorFor(colors.surface0)} />;
  }
  if (status === "failed") {
    return <Icon name="CircleX" size={size} color={colors.statusDanger} />;
  }
  if (status === "skipped") {
    return <Icon name="CircleSlash" size={size} color={muted} />;
  }
  return <Icon name="Circle" size={size} color={muted} />;
}

function StepItemRow({
  step,
  theme,
  compact,
  inPopover,
  skippedLabel,
  failedLabel,
}: {
  step: StepEntry;
  theme: PopoverTheme;
  compact: boolean;
  inPopover: boolean;
  skippedLabel: string;
  failedLabel: string;
}) {
  const { colors } = theme;
  const muted = extraMutedColor(theme);
  const textColor =
    step.status === "in_progress"
      ? colors.foreground
      : step.status === "failed"
        ? colors.statusDanger
        : step.status === "done" || step.status === "skipped"
          ? muted
          : colors.foregroundMuted;
  const struck = step.status === "done" || step.status === "skipped";

  return (
    <View
      style={
        inPopover
          ? {
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 8,
              paddingHorizontal: 12,
              paddingVertical: compact ? 7 : 5,
            }
          : {
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 8,
            }
      }
    >
      <View style={{ width: 16, height: 19, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <StepStatusMark status={step.status} theme={theme} size={15} />
      </View>
      <Text
        selectable
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: inPopover ? TITLE_FONT_SIZE : 13,
          lineHeight: 19,
          fontWeight: step.status === "in_progress" || step.status === "failed" ? "500" : "400",
          color: textColor,
          textDecorationLine: struck ? "line-through" : "none",
        }}
      >
        {step.title}
      </Text>
      {step.status === "skipped" ? (
        <PopoverPill theme={theme} label={skippedLabel} tone="neutral" compact />
      ) : step.status === "failed" ? (
        <PopoverPill theme={theme} label={failedLabel} tone="danger" compact />
      ) : null}
    </View>
  );
}

export function createStepsViews(store: StepsStore) {
  function StepsTimelineRow({ agentId, item, theme, timestamp }: PluginTimelineItemProps<StepsCard>) {
    const { t } = useAntigravityTranslation();
    const [expanded, setExpanded] = useState(false);
    const [isLatest, setIsLatest] = useState(() => store.isLatestCall(agentId, item.data.callId));
    const { colors } = theme;
    const steps = item.data.steps;
    const timestampMs = timestamp instanceof Date ? timestamp.getTime() : 0;

    useEffect(() => {
      store.observe(agentId, item.data.callId, steps, timestampMs);
      setIsLatest(store.isLatestCall(agentId, item.data.callId));
    }, [agentId, item.data.callId, steps, timestampMs]);

    useEffect(() => {
      return store.subscribe((changedAgentId) => {
        if (changedAgentId === agentId) {
          setIsLatest(store.isLatestCall(agentId, item.data.callId));
        }
      });
    }, [agentId, item.data.callId]);

    const summary = summarizeSteps(steps);
    let headline: string;
    if (summary.allDone) {
      headline = t("tasks.allDone");
    } else if (summary.inProgress.length === 1) {
      headline = summary.inProgress[0]!.title;
    } else if (summary.inProgress.length > 1) {
      headline = t("tasks.runningMore", {
        title: summary.inProgress[0]!.title,
        count: summary.inProgress.length,
      });
    } else if (summary.failed > 0) {
      headline = t("tasks.failedCount", { count: summary.failed });
    } else {
      headline = t("tasks.planned", { count: summary.total });
    }

    const headIcon = summary.allDone ? (
      <Icon name="CircleCheck" size={14} color={colors.statusSuccess} />
    ) : summary.failed > 0 ? (
      <Icon name="CircleX" size={14} color={colors.statusDanger} />
    ) : summary.inProgress.length > 0 && isLatest ? (
      <StatusRingMark size={14} ring={12} color={ringColorFor(colors.surface0)} />
    ) : (
      <Icon name="ListChecks" size={14} color={colors.foregroundMuted} />
    );

    const muted = extraMutedColor(theme);

    return (
      <View style={{ gap: 6 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${t("tasks.title")} ${summary.done}/${summary.total} ${headline}`}
          onPress={() => setExpanded((prev) => !prev)}
          style={({ hovered = false, pressed }: HoverState) => {
            const fill = rowActiveFill(hovered, pressed);
            return [
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                paddingVertical: 3,
                paddingHorizontal: 4,
                marginHorizontal: -4,
                borderRadius: 6,
              },
              fill === undefined ? undefined : { backgroundColor: colors[fill] },
            ];
          }}
        >
          {({ hovered = false, pressed }: HoverState) => (
            <>
              <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {headIcon}
              </View>
              <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "500", color: colors.foreground }}>
                {t("tasks.title")}
              </Text>
              <Text style={{ fontSize: 12, ...tabular, color: colors.foregroundMuted }}>
                {`${summary.done}/${summary.total}`}
              </Text>
              <Text style={{ fontSize: 13, color: muted }}>·</Text>
              <Text numberOfLines={1} style={{ fontSize: 13, color: colors.foregroundMuted, flex: 1, minWidth: 0 }}>
                {headline}
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
                <Icon name="ChevronRight" size={13} color={colors[chevronColorToken(hovered, pressed)]} />
              </View>
            </>
          )}
        </Pressable>

        {expanded ? (
          <View
            style={{
              marginLeft: 6,
              paddingLeft: 12,
              paddingVertical: 3,
              borderLeftWidth: 1.5,
              borderColor: colors.border,
              gap: 6,
            }}
          >
            {steps.map((step, index) => (
              <StepItemRow
                key={`${index}:${step.title}`}
                step={step}
                theme={theme}
                compact={false}
                inPopover={false}
                skippedLabel={t("tasks.statusSkipped")}
                failedLabel={t("tasks.statusFailed")}
              />
            ))}
          </View>
        ) : null}
      </View>
    );
  }

  function makePopover(
    agentId: string,
    onClosed: (steps: readonly StepEntry[] | null) => void,
    onOpen?: () => void,
  ): ComponentType<PluginButtonContentProps> {
    const gate = createSeenCloseGate<readonly StepEntry[] | null>({
      onClosed,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });

    function StepsPopover({ theme, layout }: PluginButtonContentProps) {
      const { t } = useAntigravityTranslation();
      const [snapshot, setSnapshot] = useState(() => store.getLatest(agentId));
      const [showAll, setShowAll] = useState(false);
      const shownRef = useRef<readonly StepEntry[] | null>(snapshot?.steps ?? null);
      shownRef.current = snapshot?.steps ?? null;

      useEffect(() => {
        gate.mounted();
        onOpen?.();
        return () => {
          gate.unmounted(shownRef.current);
        };
      }, []);

      useEffect(() => {
        setSnapshot(store.getLatest(agentId));
        return store.subscribe((changedAgentId) => {
          if (changedAgentId === agentId) {
            setSnapshot(store.getLatest(agentId));
          }
        });
      }, []);

      const { colors } = theme;
      const compact = layout.compact;
      const root = { ...popoverRootBox(), paddingBottom: 8 };
      const steps = snapshot?.steps ?? [];

      if (steps.length === 0) {
        return (
          <View style={root}>
            <View style={rowBox({ compact })}>
              <Text style={{ fontSize: FACTS_FONT_SIZE, color: colors.foregroundMuted }}>
                {t("tasks.empty")}
              </Text>
            </View>
          </View>
        );
      }

      const summary = summarizeSteps(steps);
      const hasOverflow = steps.length > WINDOW_LIMIT;
      const focused = hasOverflow && !showAll ? windowSteps(steps, WINDOW_LIMIT) : { earlier: 0, slice: steps, more: 0 };
      const progressPct = Math.round(
        Math.max(summary.progressFraction * 100, summary.inProgress.length > 0 ? 8 : 0),
      );
      const progressColor = summary.allDone
        ? colors.statusSuccess
        : summary.failed > 0
          ? colors.statusDanger
          : ringColorFor(colors.surface0);

      return (
        <View style={root}>
          <View
            accessible
            accessibilityRole="header"
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              paddingHorizontal: 12,
              paddingTop: compact ? 2 : 10,
              paddingBottom: 8,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 7, flexShrink: 1, minWidth: 0 }}>
              <Icon name="ListChecks" size={15} color={colors.foregroundMuted} />
              <Text
                numberOfLines={1}
                style={{
                  fontSize: compact ? FACTS_FONT_SIZE : TITLE_FONT_SIZE,
                  fontWeight: compact ? "500" : "600",
                  color: compact ? colors.foregroundMuted : colors.foreground,
                  flexShrink: 1,
                }}
              >
                {compact ? t("tasks.totalCount", { count: summary.total }) : t("tasks.title")}
              </Text>
            </View>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                flexShrink: 0,
                flexWrap: "wrap",
                justifyContent: "flex-end",
              }}
            >
              {summary.inProgress.length > 0 ? (
                <PopoverPill
                  theme={theme}
                  label={t("tasks.chipRunning", { count: summary.inProgress.length })}
                  tone="running"
                  compact
                />
              ) : null}
              {summary.failed > 0 ? (
                <PopoverPill
                  theme={theme}
                  label={t("tasks.chipFailed", { count: summary.failed })}
                  tone="danger"
                  compact
                />
              ) : null}
              {summary.skipped > 0 ? (
                <PopoverPill
                  theme={theme}
                  label={t("tasks.chipSkipped", { count: summary.skipped })}
                  tone="neutral"
                  compact
                />
              ) : null}
              <PopoverPill
                theme={theme}
                label={t("tasks.chipDone", { done: summary.done, total: summary.total })}
                tone={summary.allDone ? "success" : "neutral"}
                compact
              />
            </View>
          </View>

          <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            <View
              style={{
                height: 3,
                borderRadius: 999,
                backgroundColor: colors.surface2,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  height: 3,
                  borderRadius: 999,
                  width: `${progressPct}%`,
                  backgroundColor: progressColor,
                }}
              />
            </View>
          </View>

          <PopoverHairline theme={theme} marginVertical={2} />

          <View style={{ paddingVertical: 4 }}>
            {focused.earlier > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setShowAll(true)}
                style={({ hovered = false, pressed }: HoverState) => {
                  const fill = rowActiveFill(hovered, pressed);
                  return [rowBox({ compact }), fill === undefined ? undefined : { backgroundColor: colors[fill] }];
                }}
              >
                <Text style={{ fontSize: FACTS_FONT_SIZE, color: colors.foregroundMuted }}>
                  {`⋮  ${t("tasks.earlierMore", { count: focused.earlier })}`}
                </Text>
              </Pressable>
            ) : null}

            {focused.slice.map((step, index) => (
              <StepItemRow
                key={`${focused.earlier + index}:${step.title}`}
                step={step}
                theme={theme}
                compact={compact}
                inPopover
                skippedLabel={t("tasks.statusSkipped")}
                failedLabel={t("tasks.statusFailed")}
              />
            ))}

            {focused.more > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setShowAll(true)}
                style={({ hovered = false, pressed }: HoverState) => {
                  const fill = rowActiveFill(hovered, pressed);
                  return [rowBox({ compact }), fill === undefined ? undefined : { backgroundColor: colors[fill] }];
                }}
              >
                <Text style={{ fontSize: FACTS_FONT_SIZE, color: colors.foregroundMuted }}>
                  {`⋮  ${t("tasks.laterMore", { count: focused.more })}`}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {summary.allDone || hasOverflow ? (
            <>
              <PopoverHairline theme={theme} marginVertical={2} />
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  paddingHorizontal: 12,
                  paddingTop: 6,
                }}
              >
                <Text style={{ fontSize: FACTS_FONT_SIZE, color: extraMutedColor(theme), flex: 1 }}>
                  {summary.allDone
                    ? t("tasks.allDoneHint")
                    : showAll
                      ? t("tasks.expandedHint", { count: steps.length })
                      : t("tasks.windowHint")}
                </Text>
                {hasOverflow ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setShowAll((prev) => !prev)}
                    style={{ paddingHorizontal: 4, paddingVertical: 2 }}
                  >
                    <Text style={{ fontSize: FACTS_FONT_SIZE, fontWeight: "500", color: colors.accent }}>
                      {showAll ? t("tasks.collapseWindow") : t("tasks.showAll")}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </>
          ) : null}
        </View>
      );
    }

    return StepsPopover;
  }

  return { StepsTimelineRow, makePopover };
}
