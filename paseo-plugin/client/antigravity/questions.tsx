import {
  useAgent,
  useComposers,
  usePaseo,
  type PluginSurfaceProps,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { Icon, Markdown, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { isAntigravityProvider, type AskQuestionCard, type AskQuestionEntry } from "../../shared/antigravity/contracts";
import { errorMessage, useAntigravityTranslation } from "./messages";
import {
  SKIPPED_REPLY,
  buildSubmission,
  formatQuestionEcho,
  isQuestionAnswered,
  normalizeEchoText,
  parseOption,
  resolutionFromToolOutput,
  resolutionFromUserReply,
  type QuestionResolution,
} from "./questionModel";
import { font, radius, space, tint, type Colors } from "./theme";
import { Badge, Card } from "./ui";

type PressState = { pressed: boolean; hovered?: boolean };
type Layout = PluginSurfaceProps["layout"];

/** Optimistic client-side memory of answers submitted from this session so the card settles immediately. */
const submittedByKey = new Map<string, QuestionResolution>();

function rememberSubmitted(key: string, resolution: QuestionResolution) {
  submittedByKey.delete(key);
  submittedByKey.set(key, resolution);
  if (submittedByKey.size > 200) {
    const oldest = submittedByKey.keys().next().value;
    if (oldest) submittedByKey.delete(oldest);
  }
}

function isQuestionEchoMessage(text: string, echoSignature: string, allowPrefix: boolean): boolean {
  if (!echoSignature) return false;
  const normalized = normalizeEchoText(text);
  if (!normalized) return false;
  if (normalized === echoSignature) return true;
  return allowPrefix && echoSignature.startsWith(normalized);
}

function SelectionIndicator({
  colors,
  selected,
  multiSelect,
}: {
  colors: Colors;
  selected: boolean;
  multiSelect: boolean;
}) {
  const borderColor = selected ? colors.accent : tint(colors.foreground, 0.3);
  const backgroundColor = selected && multiSelect ? colors.accent : "transparent";
  return (
    <View
      style={{
        width: 18,
        height: 18,
        marginTop: 1,
        borderRadius: multiSelect ? radius.sm - 1 : radius.pill,
        borderWidth: 1.5,
        borderColor,
        backgroundColor,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {selected && multiSelect ? (
        <Icon name="Check" size={12} color={colors.accentForeground} />
      ) : selected && !multiSelect ? (
        <View style={{ width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.accent }} />
      ) : null}
    </View>
  );
}

function SettledQuestionCard({
  colors,
  questions,
  resolution,
}: {
  colors: Colors;
  questions: readonly AskQuestionEntry[];
  resolution: Exclude<QuestionResolution, { state: "pending" } | { state: "loading" }>;
}) {
  const { t } = useAntigravityTranslation();
  const skipped = resolution.state === "skipped";
  const answered = resolution.state === "answered";
  const icon = skipped ? "CircleSlash" : answered ? "CircleCheck" : "CircleHelp";
  const iconColor = skipped
    ? colors.foregroundMuted
    : answered
      ? colors.statusSuccess
      : colors.foregroundMuted;

  return (
    <Card colors={colors} style={{ paddingVertical: space.sm + 2, paddingHorizontal: space.md, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, flex: 1 }}>
          <Icon name={icon} size={15} color={iconColor} />
          <Text numberOfLines={1} style={{ ...font.caption, fontWeight: "600", color: colors.foregroundMuted, flex: 1 }}>
            {skipped
              ? t("questions.skipped")
              : answered
                ? t("questions.answered")
                : t("questions.title", { count: questions.length })}
          </Text>
        </View>
      </View>

      <View style={{ gap: space.sm }}>
        {questions.map((entry, idx) => {
          const answer = resolution.state === "answered" ? resolution.perQuestion[idx] : null;
          return (
            <View key={`${idx}:${entry.question}`} style={{ gap: 3 }}>
              <Text style={{ ...font.small, color: colors.foreground, fontWeight: "500" }}>
                {questions.length > 1 ? `${idx + 1}. ${entry.question}` : entry.question}
              </Text>
              {answer ? (
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, paddingLeft: 2 }}>
                  <View style={{ paddingTop: 3 }}>
                    <Icon name="CornerDownRight" size={12} color={colors.accent} />
                  </View>
                  <Text selectable style={{ ...font.small, color: colors.foregroundMuted, flex: 1 }}>
                    {answer}
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })}
        {resolution.state === "answered" && resolution.fallbackText ? (
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, paddingLeft: 2 }}>
            <View style={{ paddingTop: 3 }}>
              <Icon name="CornerDownRight" size={12} color={colors.accent} />
            </View>
            <Text selectable style={{ ...font.small, color: colors.foregroundMuted, flex: 1 }}>
              {resolution.fallbackText}
            </Text>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function PendingQuestionForm({
  agentId,
  cacheKey,
  colors,
  layout,
  questions,
  onResolved,
}: {
  agentId: string;
  cacheKey: string;
  colors: Colors;
  layout: Layout;
  questions: readonly AskQuestionEntry[];
  onResolved(next: QuestionResolution): void;
}) {
  const { t } = useAntigravityTranslation();
  const paseo = usePaseo();
  const toast = useToast();
  const composers = useComposers({ agentId });

  const [activeIndex, setActiveIndex] = useState(0);
  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [customTexts, setCustomTexts] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState<"submit" | "skip" | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const safeIndex = Math.min(activeIndex, questions.length - 1);
  const current = questions[safeIndex]!;
  const currentSelected = selections[safeIndex] ?? new Set<number>();
  const currentCustom = customTexts[safeIndex] ?? "";
  const parsedOptions = current.options.map(parseOption);

  const currentAnswered = isQuestionAnswered(current, selections[safeIndex], customTexts[safeIndex]);
  const allAnswered = questions.every((entry, idx) =>
    isQuestionAnswered(entry, selections[idx], customTexts[idx]),
  );
  const isLast = safeIndex === questions.length - 1;
  const busy = submitting !== null;

  function toggleOption(qIndex: number, optIndex: number, multiSelect: boolean) {
    setSubmitError(null);
    setSelections((prev) => {
      const nextSet = new Set(prev[qIndex] ?? []);
      if (multiSelect) {
        if (nextSet.has(optIndex)) nextSet.delete(optIndex);
        else nextSet.add(optIndex);
      } else if (nextSet.has(optIndex)) {
        nextSet.clear();
      } else {
        nextSet.clear();
        nextSet.add(optIndex);
      }
      return { ...prev, [qIndex]: nextSet };
    });
    if (!multiSelect) {
      setCustomTexts((prev) => {
        if (!prev[qIndex]) return prev;
        const copy = { ...prev };
        delete copy[qIndex];
        return copy;
      });
    }
  }

  function changeCustomText(qIndex: number, value: string, multiSelect: boolean) {
    setSubmitError(null);
    setCustomTexts((prev) => ({ ...prev, [qIndex]: value }));
    if (!multiSelect && value.trim().length > 0) {
      setSelections((prev) => {
        const cur = prev[qIndex];
        if (!cur || cur.size === 0) return prev;
        return { ...prev, [qIndex]: new Set() };
      });
    }
  }

  async function submitAnswer() {
    if (inFlightRef.current || busy || !allAnswered) return;
    const { wireText, perQuestionDisplay } = buildSubmission(questions, selections, customTexts);
    if (!wireText.trim()) return;
    inFlightRef.current = true;
    setSubmitting("submit");
    setSubmitError(null);
    try {
      await paseo.agents.ref(agentId).send(wireText, { activeTurnBehavior: "steer" });
      const next: QuestionResolution = {
        state: "answered",
        perQuestion: perQuestionDisplay,
        fallbackText: null,
      };
      rememberSubmitted(cacheKey, next);
      onResolved(next);
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      inFlightRef.current = false;
      setSubmitting(null);
    }
  }

  async function skipQuestion() {
    if (inFlightRef.current || busy) return;
    inFlightRef.current = true;
    setSubmitting("skip");
    setSubmitError(null);
    try {
      await paseo.agents.ref(agentId).send(SKIPPED_REPLY, { activeTurnBehavior: "steer" });
      const next: QuestionResolution = { state: "skipped" };
      rememberSubmitted(cacheKey, next);
      onResolved(next);
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      inFlightRef.current = false;
      setSubmitting(null);
    }
  }

  function handlePrimaryAction() {
    if (inFlightRef.current || busy) return;
    if (!isLast) {
      if (!currentAnswered) return;
      const nextUnanswered = questions.findIndex(
        (entry, idx) => idx > safeIndex && !isQuestionAnswered(entry, selections[idx], customTexts[idx]),
      );
      setActiveIndex(nextUnanswered >= 0 ? nextUnanswered : Math.min(safeIndex + 1, questions.length - 1));
      return;
    }
    void submitAnswer();
  }

  function insertIntoComposer() {
    const composer = composers[0];
    if (!composer) {
      toast.error(t("subagents.composerUnavailable"));
      return;
    }
    const { wireText } = buildSubmission(questions, selections, customTexts);
    if (!wireText.trim()) return;
    const existing = composer.prompt.trim();
    composer.setPrompt(existing ? `${existing}\n\n${wireText}` : wireText);
    void composer.focus().catch(() => undefined);
    toast.show(t("questions.insertedComposer"), { variant: "success" });
  }

  const primaryDisabled = busy || (isLast ? !allAnswered : !currentAnswered);
  const primaryLabel = isLast ? t("questions.submit") : t("questions.next");

  return (
    <Card colors={colors} style={{ padding: space.md, gap: space.md }}>
      {questions.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs + 2 }}>
          {questions.map((entry, idx) => {
            const active = idx === safeIndex;
            const answered = isQuestionAnswered(entry, selections[idx], customTexts[idx]);
            return (
              <Pressable
                key={`${idx}:${entry.question}`}
                accessibilityRole="tab"
                accessibilityLabel={t("questions.stepLabel", { current: idx + 1, total: questions.length })}
                accessibilityState={{ selected: active, disabled: busy }}
                disabled={busy}
                onPress={() => setActiveIndex(idx)}
                style={(state) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  minHeight: 28,
                  paddingHorizontal: space.sm + 2,
                  paddingVertical: space.xs,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: active ? colors.foregroundMuted : colors.border,
                  backgroundColor:
                    active || (state as PressState).hovered || (state as PressState).pressed
                      ? colors.surface2
                      : colors.surface1,
                })}
              >
                {answered ? (
                  <Icon name="Check" size={12} color={active ? colors.foreground : colors.statusSuccess} />
                ) : null}
                <Text
                  numberOfLines={1}
                  style={{
                    ...font.caption,
                    fontWeight: active ? "600" : "500",
                    color: active ? colors.foreground : colors.foregroundMuted,
                  }}
                >
                  {t("questions.tab", { index: idx + 1 })}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={{ gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="CircleHelp" size={14} color={colors.accent} />
            <Text style={{ ...font.caption, fontWeight: "600", color: colors.foregroundMuted }}>
              {questions.length > 1
                ? t("questions.stepLabel", { current: safeIndex + 1, total: questions.length })
                : t("questions.heading")}
            </Text>
          </View>
          {current.multiSelect ? (
            <Badge colors={colors} tone="accent" label={t("questions.multiSelect")} />
          ) : null}
        </View>
        <View style={{ paddingHorizontal: 2 }}>
          <Markdown>{current.question}</Markdown>
        </View>
      </View>

      {parsedOptions.length > 0 ? (
        <View
          accessibilityRole={current.multiSelect ? undefined : "radiogroup"}
          accessibilityLabel={current.question}
          style={{ gap: space.xs }}
        >
          {parsedOptions.map((option, optIdx) => {
            const selected = currentSelected.has(optIdx);
            return (
              <Pressable
                key={`${optIdx}:${option.raw}`}
                accessibilityRole={current.multiSelect ? "checkbox" : "radio"}
                accessibilityLabel={option.raw}
                accessibilityState={{ checked: selected, disabled: busy }}
                disabled={busy}
                onPress={() => toggleOption(safeIndex, optIdx, current.multiSelect)}
                style={(state) => ({
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: space.sm + 2,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm + 2,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: selected ? tint(colors.accent, 0.55) : colors.border,
                  backgroundColor: selected
                    ? tint(colors.accent, 0.1)
                    : (state as PressState).hovered || (state as PressState).pressed
                      ? colors.surface2
                      : colors.surface0,
                  opacity: (state as PressState).pressed && !busy ? 0.88 : 1,
                })}
              >
                <SelectionIndicator colors={colors} selected={selected} multiSelect={current.multiSelect} />
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                    {option.recommended ? (
                      <Badge colors={colors} tone="accent" label={t("questions.recommended")} />
                    ) : null}
                    <Text
                      style={{
                        ...font.body,
                        color: selected ? colors.foreground : tint(colors.foreground, 0.88),
                        fontWeight: selected ? "500" : "400",
                        flexShrink: 1,
                      }}
                    >
                      {option.label}
                    </Text>
                  </View>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <TextInput
        key={`other-${safeIndex}`}
        value={currentCustom}
        editable={!busy}
        onChangeText={(value) => changeCustomText(safeIndex, value, current.multiSelect)}
        onSubmitEditing={handlePrimaryAction}
        accessibilityLabel={
          parsedOptions.length > 0 ? t("questions.otherPlaceholder") : t("questions.answerPlaceholder")
        }
        placeholder={
          parsedOptions.length > 0 ? t("questions.otherPlaceholder") : t("questions.answerPlaceholder")
        }
        placeholderTextColor={colors.foregroundMuted}
        style={{
          borderWidth: 1,
          borderColor: currentCustom.trim().length > 0 ? colors.accent : colors.border,
          borderRadius: radius.md,
          backgroundColor: colors.surface2,
          color: colors.foreground,
          paddingHorizontal: space.md,
          paddingVertical: space.sm + 2,
          ...font.body,
        }}
      />

      {submitError ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            paddingHorizontal: space.sm + 2,
            paddingVertical: space.xs + 2,
            borderRadius: radius.md,
            backgroundColor: tint(colors.statusDanger, 0.1),
          }}
        >
          <Icon name="CircleAlert" size={14} color={colors.statusDanger} />
          <Text selectable style={{ ...font.caption, color: colors.statusDanger, flex: 1 }}>
            {submitError}
          </Text>
        </View>
      ) : null}

      <View
        style={{
          flexDirection: layout.compact ? "column" : "row",
          alignItems: layout.compact ? "stretch" : "center",
          justifyContent: "space-between",
          gap: space.sm,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: space.sm,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("questions.skip")}
            accessibilityState={{ disabled: busy, busy: submitting === "skip" }}
            disabled={busy}
            onPress={() => void skipQuestion()}
            style={(state) => ({
              height: 34,
              paddingHorizontal: space.md,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor:
                !busy && ((state as PressState).hovered || (state as PressState).pressed)
                  ? colors.surface2
                  : colors.surface1,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              opacity: busy && submitting !== "skip" ? 0.5 : 1,
            })}
          >
            {submitting === "skip" ? (
              <ActivityIndicator size="small" color={colors.foregroundMuted} />
            ) : (
              <Icon name="X" size={14} color={colors.foregroundMuted} />
            )}
            <Text style={{ ...font.small, fontWeight: "500", color: colors.foregroundMuted }}>
              {t("questions.skip")}
            </Text>
          </Pressable>

          {allAnswered && composers.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("questions.editInComposer")}
              disabled={busy}
              onPress={insertIntoComposer}
              style={(state) => ({
                height: 34,
                paddingHorizontal: space.md,
                borderRadius: radius.md,
                backgroundColor:
                  !busy && ((state as PressState).hovered || (state as PressState).pressed)
                    ? tint(colors.foreground, 0.06)
                    : "transparent",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                opacity: busy ? 0.5 : 1,
              })}
            >
              <Icon name="PenLine" size={14} color={colors.foregroundMuted} />
              <Text style={{ ...font.small, fontWeight: "500", color: colors.foregroundMuted }}>
                {t("questions.editInComposer")}
              </Text>
            </Pressable>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={primaryLabel}
          accessibilityState={{ disabled: primaryDisabled, busy: submitting === "submit" }}
          disabled={primaryDisabled}
          onPress={handlePrimaryAction}
          style={(state) => ({
            height: 34,
            paddingHorizontal: space.lg,
            borderRadius: radius.md,
            backgroundColor: colors.accent,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            opacity: primaryDisabled ? 0.45 : (state as PressState).pressed ? 0.88 : 1,
          })}
        >
          {submitting === "submit" ? (
            <ActivityIndicator size="small" color={colors.accentForeground} />
          ) : (
            <Icon name={isLast ? "Check" : "ArrowRight"} size={14} color={colors.accentForeground} />
          )}
          <Text style={{ ...font.small, fontWeight: "600", color: colors.accentForeground }}>
            {primaryLabel}
          </Text>
        </Pressable>
      </View>
    </Card>
  );
}

export function AskQuestionRow({ agentId, item, theme, layout, timestamp }: PluginTimelineItemProps<AskQuestionCard>) {
  const { colors } = theme;
  const paseo = usePaseo();
  const { callId, questions, output, status: callStatus } = item.data;
  const cacheKey = `${agentId}:${callId}`;

  const agentState = useAgent(
    agentId,
    (agent) => `${agent.provider}|${agent.status}|${agent.lastActivityAt}`,
  );
  const [provider = "", agentStatus = "", lastActivityAt = ""] = (agentState ?? "").split("|");
  const antigravity = !provider || isAntigravityProvider(provider);

  const [trackedKey, setTrackedKey] = useState(cacheKey);
  const [localResolution, setLocalResolution] = useState<QuestionResolution | null>(
    () => submittedByKey.get(cacheKey) ?? null,
  );
  if (trackedKey !== cacheKey) {
    setTrackedKey(cacheKey);
    setLocalResolution(submittedByKey.get(cacheKey) ?? null);
  }

  const outputResolution = useMemo(() => resolutionFromToolOutput(questions, output), [questions, output]);
  const echoSignature = useMemo(() => formatQuestionEcho(questions), [questions]);

  const effectiveResolution = trackedKey === cacheKey ? localResolution : (submittedByKey.get(cacheKey) ?? null);
  const needsTimelineCheck =
    antigravity &&
    !effectiveResolution &&
    !outputResolution &&
    callStatus !== "failed" &&
    callStatus !== "canceled";

  const allowStreamingEcho = agentStatus === "running" || callStatus === "running";

  const timelineQuery = useQuery({
    queryKey: ["antigravity-accounts", "ask-question", agentId],
    queryFn: () => paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 40 }),
    enabled: needsTimelineCheck,
    placeholderData: (previous) => previous,
    staleTime: 1000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const idx = data.entries.findIndex(
        (entry) => entry.item.type === "tool_call" && entry.item.callId === callId,
      );
      if (idx < 0) return data.hasOlder ? false : 3000;
      for (let cursor = idx + 1; cursor < data.entries.length; cursor += 1) {
        const next = data.entries[cursor]!.item;
        if (next.type === "user_message") return false;
        if (next.type === "assistant_message" && isQuestionEchoMessage(next.text, echoSignature, allowStreamingEcho)) {
          continue;
        }
        if (callStatus !== "running" && (next.type === "tool_call" || next.type === "reasoning" || next.type === "assistant_message")) {
          return false;
        }
      }
      return agentStatus === "closed" ? false : 3000;
    },
  });

  const { refetch: refetchTimeline } = timelineQuery;
  useEffect(() => {
    if (needsTimelineCheck && lastActivityAt) {
      void refetchTimeline();
    }
  }, [needsTimelineCheck, lastActivityAt, refetchTimeline]);

  const resolved: QuestionResolution = useMemo(() => {
    if (effectiveResolution) return effectiveResolution;
    if (outputResolution) return outputResolution;
    if (!antigravity) return { state: "settled" };
    if (callStatus === "failed" || callStatus === "canceled") return { state: "settled" };
    if (agentStatus === "closed") return { state: "settled" };

    const data = timelineQuery.data;
    if (!data) {
      // If the agent already had much later activity, avoid flashing an interactive form while the tail loads.
      const itemTime = timestamp.getTime();
      const latestTime = lastActivityAt ? Date.parse(lastActivityAt) : NaN;
      const hasLaterActivity =
        Number.isFinite(itemTime) && Number.isFinite(latestTime) && latestTime - itemTime > 12_000;
      if (hasLaterActivity) {
        return timelineQuery.isError ? { state: "settled" } : { state: "loading" };
      }
      return { state: "pending" };
    }

    const entries = data.entries;
    const index = entries.findIndex(
      (entry) => entry.item.type === "tool_call" && entry.item.callId === callId,
    );
    if (index < 0) {
      return data.hasOlder ? { state: "settled" } : { state: "pending" };
    }

    for (let cursor = index + 1; cursor < entries.length; cursor += 1) {
      const next = entries[cursor]!.item;
      if (next.type === "user_message") {
        return resolutionFromUserReply(questions, next.text);
      }
      if (next.type === "assistant_message" && isQuestionEchoMessage(next.text, echoSignature, allowStreamingEcho)) {
        continue;
      }
      if (callStatus !== "running" && (next.type === "tool_call" || next.type === "reasoning" || next.type === "assistant_message")) {
        return { state: "settled" };
      }
    }
    return { state: "pending" };
  }, [
    effectiveResolution,
    outputResolution,
    antigravity,
    callStatus,
    agentStatus,
    allowStreamingEcho,
    timelineQuery.data,
    timelineQuery.isError,
    timestamp,
    lastActivityAt,
    callId,
    questions,
    echoSignature,
  ]);

  if (questions.length === 0) return null;

  if (resolved.state === "loading") {
    return (
      <Card colors={colors} style={{ paddingVertical: space.sm + 2, paddingHorizontal: space.md, gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <ActivityIndicator size="small" color={colors.foregroundMuted} />
          <Text numberOfLines={1} style={{ ...font.small, color: colors.foreground, flex: 1 }}>
            {questions[0]!.question}
          </Text>
        </View>
      </Card>
    );
  }

  if (resolved.state !== "pending") {
    return <SettledQuestionCard colors={colors} questions={questions} resolution={resolved} />;
  }

  return (
    <PendingQuestionForm
      key={cacheKey}
      agentId={agentId}
      cacheKey={cacheKey}
      colors={colors}
      layout={layout}
      questions={questions}
      onResolved={setLocalResolution}
    />
  );
}
