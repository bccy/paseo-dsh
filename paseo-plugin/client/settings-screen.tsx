import { useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import {
  LANGUAGE_DEFAULTS,
  THINKING_STYLE_CHOICES,
  THINKING_STYLE_DEFAULT,
  TIMELINE_STYLE_DEFAULTS,
  TIMELINE_STYLE_KEYS,
  isThinkingStyleChoice,
  languageSettings,
  timelineStyleSettings,
  type LanguageChoice,
  type ThinkingStyleChoice,
  type TimelineStyleNumericKey,
  type TimelineStyleValues,
} from "../shared/settings";
import { PluginsBoundary, PluginsFailedCard, report } from "./dsh-plugins-guard";
import { SlidersIcon } from "./dsh-plugins-icon";
import {
  getLanguageOverride,
  localeText,
  setLanguageOverride,
  type DisplaySettingsText,
} from "./locale";
import { useLocaleText } from "./use-locale";

/** The display settings screen id, shared by every entry point that opens it. */
export const DISPLAY_SETTINGS_ID = "timeline-style";

const FIELD_BOUNDS: Record<TimelineStyleNumericKey, { readonly min: number; readonly max: number }> = {
  rowMarginY: { min: -16, max: 24 },
  toolRowPaddingY: { min: 0, max: 12 },
  toolRowMinHeight: { min: 12, max: 64 },
  toolRowGap: { min: 0, max: 24 },
  expandedMaxHeight: { min: 120, max: 640 },
  commandMaxHeightRatio: { min: 0.1, max: 0.6 },
  commandMinHeight: { min: 60, max: 360 },
};

const LANGUAGE_OPTIONS: readonly {
  readonly value: LanguageChoice;
  readonly labelKey: keyof Pick<DisplaySettingsText["language"], "auto" | "en" | "zhCN">;
}[] = [
  { value: "auto", labelKey: "auto" },
  { value: "en", labelKey: "en" },
  { value: "zh-CN", labelKey: "zhCN" },
];

type FeedbackState =
  | { kind: "saved" }
  | { kind: "reset" }
  | { kind: "validationError"; message: string }
  | { kind: "fallbackError"; action: "save" | "reset" };

function keyboardTypeFor(
  key: TimelineStyleNumericKey,
): "default" | "numbers-and-punctuation" | "decimal-pad" | "numeric" {
  if (Platform.OS === "web") return "default";
  if (key === "rowMarginY") return "numbers-and-punctuation";
  if (key === "commandMaxHeightRatio") return "decimal-pad";
  return "numeric";
}

function guardAsync(label: string, run: () => Promise<void>): void {
  void Promise.resolve()
    .then(run)
    .catch((error) => {
      report(label, error);
    });
}

/** Numeric editor for timeline row spacing and command drawer height, plus plugin language override and thinking style. */
export function TimelineSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const text = useLocaleText().settings;
  const settings = useSettings(timelineStyleSettings);
  const language = useSettings(languageSettings);
  const [draft, setDraft] = useState<Partial<Record<TimelineStyleNumericKey, string>>>({});
  const [pickedLanguage, setPickedLanguage] = useState<LanguageChoice | null>(null);
  const [pickedThinkingStyle, setPickedThinkingStyle] = useState<ThinkingStyleChoice | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  // Synchronous in-flight locks close the rapid double-tap window before the
  // host hook flips `saving: true` on the next render, preventing duplicate
  // writes against the same revision.
  const styleInFlightRef = useRef(false);
  const languageInFlightRef = useRef(false);

  const current: TimelineStyleValues =
    settings.status === "ready" ? settings.values : TIMELINE_STYLE_DEFAULTS;
  const savedThinkingStyle: ThinkingStyleChoice = isThinkingStyleChoice(current.thinkingStyle)
    ? current.thinkingStyle
    : THINKING_STYLE_DEFAULT;
  const currentThinkingStyle: ThinkingStyleChoice = pickedThinkingStyle ?? savedThinkingStyle;
  const currentLanguage: LanguageChoice =
    pickedLanguage
    ?? (language.status === "ready" ? language.values.language : LANGUAGE_DEFAULTS.language);
  const compact = layout.compact;
  const canSave = settings.status === "ready" && !settings.saving;
  const canReset = (settings.status === "ready" || settings.status === "invalid") && !settings.saving;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: compact ? 12 : 14 },
      title: { color: theme.colors.foreground, fontSize: compact ? 16 : 18, fontWeight: "600" as const },
      intro: { color: theme.colors.foregroundMuted, fontSize: compact ? 13 : 14, lineHeight: compact ? 19 : 21 },
      field: { gap: 5 },
      label: { color: theme.colors.foreground, fontSize: compact ? 13 : 14, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 12.5, lineHeight: 17 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: compact ? 9 : 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        fontSize: compact ? 13 : 14,
      },
      languageRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      languageButton: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: compact ? 8 : 9,
        backgroundColor: theme.colors.surface1,
      },
      languageButtonSelected: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
      languageButtonDisabled: {
        opacity: 0.6,
      },
      languageLabel: { color: theme.colors.foreground, fontSize: compact ? 12.5 : 13, fontWeight: "600" as const },
      languageLabelSelected: { color: theme.colors.accentForeground },
      thinkingStyleDesc: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface1,
      },
      thinkingStyleDescText: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 12 : 12.5,
        lineHeight: 18,
      },
      actions: { flexDirection: "row" as const, gap: 10, marginTop: 4 },
      button: {
        paddingHorizontal: 16,
        paddingVertical: compact ? 9 : 10,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonDisabled: {
        opacity: 0.6,
      },
      secondary: {
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonText: { color: theme.colors.accentForeground, fontWeight: "600" as const, fontSize: compact ? 13 : 14 },
      secondaryText: { color: theme.colors.foreground, fontWeight: "600" as const, fontSize: compact ? 13 : 14 },
      notice: { color: theme.colors.foregroundMuted, fontSize: compact ? 12 : 13 },
      errorText: { color: theme.colors.statusDanger, fontSize: compact ? 12 : 13 },
    }),
    [theme, compact],
  );

  const textOf = (key: TimelineStyleNumericKey): string => draft[key] ?? String(current[key]);
  const edit = (key: TimelineStyleNumericKey, value: string) => {
    if (settings.saving) return;
    setDraft((previous) => ({ ...previous, [key]: value }));
    setFeedback(null);
  };

  const save = async () => {
    if (settings.status !== "ready" || settings.saving || styleInFlightRef.current) return;
    const candidate: TimelineStyleValues = { ...current, thinkingStyle: currentThinkingStyle };
    for (const key of TIMELINE_STYLE_KEYS) {
      const raw = textOf(key).trim();
      const value = raw === "" ? Number.NaN : Number(raw);
      const fieldCopy = text.fields[key];
      if (!Number.isFinite(value)) {
        setFeedback({ kind: "validationError", message: text.invalidNumber(fieldCopy.label) });
        return;
      }
      const bounds = FIELD_BOUNDS[key];
      if (value < bounds.min || value > bounds.max) {
        setFeedback({
          kind: "validationError",
          message: text.outOfRange(fieldCopy.label, bounds.min, bounds.max),
        });
        return;
      }
      candidate[key] = value;
    }
    const parsed = timelineStyleSettings.schema.safeParse(candidate);
    if (!parsed.success) {
      setFeedback({
        kind: "validationError",
        message: parsed.error.issues[0]?.message ?? text.saveFailed,
      });
      return;
    }
    styleInFlightRef.current = true;
    setFeedback(null);
    let saved = false;
    try {
      saved = await settings.save(parsed.data, settings.revision);
    } catch (error) {
      report("timeline style save", error);
      saved = false;
    } finally {
      styleInFlightRef.current = false;
    }
    if (saved) {
      setDraft({});
      setPickedThinkingStyle(null);
      setFeedback({ kind: "saved" });
    } else {
      setFeedback({ kind: "fallbackError", action: "save" });
    }
  };

  const reset = async () => {
    if (settings.saving || styleInFlightRef.current) return;
    if (settings.status !== "ready" && settings.status !== "invalid") return;
    styleInFlightRef.current = true;
    let saved = false;
    setFeedback(null);
    try {
      if (settings.status === "ready") {
        saved = await settings.save(TIMELINE_STYLE_DEFAULTS, settings.revision);
      } else {
        saved = await settings.reset();
      }
    } catch (error) {
      report("timeline style reset", error);
      saved = false;
    } finally {
      styleInFlightRef.current = false;
    }
    if (saved) {
      setDraft({});
      setPickedThinkingStyle(null);
      setFeedback({ kind: "reset" });
    } else {
      setFeedback({ kind: "fallbackError", action: "reset" });
    }
  };

  const chooseThinkingStyle = async (choice: ThinkingStyleChoice) => {
    if (
      settings.status !== "ready"
      || settings.saving
      || styleInFlightRef.current
      || choice === currentThinkingStyle
    ) {
      return;
    }
    const previousPicked = pickedThinkingStyle;
    const parsed = timelineStyleSettings.schema.safeParse({
      ...current,
      thinkingStyle: choice,
    });
    if (!parsed.success) {
      setFeedback({
        kind: "validationError",
        message: parsed.error.issues[0]?.message ?? text.saveFailed,
      });
      return;
    }
    styleInFlightRef.current = true;
    setPickedThinkingStyle(choice);
    setFeedback(null);
    let saved = false;
    try {
      saved = await settings.save(parsed.data, settings.revision);
    } catch (error) {
      report("thinking style save", error);
      saved = false;
    } finally {
      styleInFlightRef.current = false;
    }
    if (saved) {
      setPickedThinkingStyle(null);
      setFeedback({ kind: "saved" });
    } else {
      setPickedThinkingStyle(previousPicked);
      setFeedback({ kind: "fallbackError", action: "save" });
    }
  };

  const chooseLanguage = async (choice: LanguageChoice) => {
    if (
      language.status !== "ready"
      || language.saving
      || languageInFlightRef.current
      || choice === currentLanguage
    ) {
      return;
    }
    languageInFlightRef.current = true;
    const previousOverride = getLanguageOverride();
    const previousPicked = pickedLanguage;
    setPickedLanguage(choice);
    setLanguageOverride(choice);
    setFeedback(null);
    let saved = false;
    try {
      saved = await language.save({ language: choice }, language.revision);
    } catch (error) {
      report("language save", error);
      saved = false;
    } finally {
      languageInFlightRef.current = false;
    }
    if (saved) {
      setPickedLanguage(null);
    } else {
      setPickedLanguage(previousPicked);
      setLanguageOverride(previousOverride);
      setFeedback({ kind: "fallbackError", action: "save" });
    }
  };

  const languageDisabled = language.status !== "ready" || language.saving;
  const saveErrorMessage = settings.saveError ?? language.saveError;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{text.title}</Text>
      <Text style={styles.intro}>{text.intro}</Text>

      <View style={styles.field}>
        <Text style={styles.label}>{text.language.label}</Text>
        <View style={styles.languageRow}>
          {LANGUAGE_OPTIONS.map((option) => {
            const selected = currentLanguage === option.value;
            const optionLabel = text.language[option.labelKey];
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={optionLabel}
                disabled={languageDisabled}
                onPress={() => guardAsync("language save", () => chooseLanguage(option.value))}
                style={[
                  styles.languageButton,
                  selected ? styles.languageButtonSelected : null,
                  languageDisabled ? styles.languageButtonDisabled : null,
                ]}
              >
                <Text style={[styles.languageLabel, selected ? styles.languageLabelSelected : null]}>
                  {optionLabel}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>{text.language.hint}</Text>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{text.thinkingStyle.label}</Text>
        <View style={styles.languageRow}>
          {THINKING_STYLE_CHOICES.map((choice) => {
            const selected = currentThinkingStyle === choice;
            const optionCopy = text.thinkingStyle.options[choice];
            return (
              <Pressable
                key={choice}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={optionCopy.label}
                disabled={!canSave}
                onPress={() => guardAsync("thinking style save", () => chooseThinkingStyle(choice))}
                style={[
                  styles.languageButton,
                  selected ? styles.languageButtonSelected : null,
                  !canSave ? styles.languageButtonDisabled : null,
                ]}
              >
                <Text style={[styles.languageLabel, selected ? styles.languageLabelSelected : null]}>
                  {optionCopy.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.thinkingStyleDesc}>
          <Text style={styles.thinkingStyleDescText}>
            {text.thinkingStyle.options[currentThinkingStyle].description}
          </Text>
        </View>
        <Text style={styles.hint}>{text.thinkingStyle.hint}</Text>
      </View>

      {TIMELINE_STYLE_KEYS.map((key) => {
        const fieldCopy = text.fields[key];
        return (
          <View key={key} style={styles.field}>
            <Text style={styles.label}>{fieldCopy.label}</Text>
            <TextInput
              value={textOf(key)}
              editable={!settings.saving}
              onChangeText={(value: string) => edit(key, value)}
              keyboardType={keyboardTypeFor(key)}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={fieldCopy.label}
              style={styles.input}
            />
            <Text style={styles.hint}>{fieldCopy.hint}</Text>
          </View>
        );
      })}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text.save}
          disabled={!canSave}
          onPress={() => guardAsync("settings save", save)}
          style={[styles.button, canSave ? null : styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>{settings.saving ? text.saving : text.save}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text.reset}
          disabled={!canReset}
          onPress={() => guardAsync("settings reset", reset)}
          style={[styles.button, styles.secondary, canReset ? null : styles.buttonDisabled]}
        >
          <Text style={styles.secondaryText}>{text.reset}</Text>
        </Pressable>
      </View>

      {settings.status === "loading" || language.status === "loading" ? (
        <Text style={styles.notice}>{text.loading}</Text>
      ) : null}
      {settings.status === "error" || settings.status === "invalid" ? (
        <Text style={styles.errorText}>{settings.error}</Text>
      ) : null}
      {language.status === "error" || language.status === "invalid" ? (
        <Text style={styles.errorText}>{language.error}</Text>
      ) : null}
      {saveErrorMessage === null ? null : (
        <Text style={styles.errorText}>{saveErrorMessage}</Text>
      )}
      {feedback === null ? null : feedback.kind === "saved" ? (
        <Text style={styles.notice}>{text.saved}</Text>
      ) : feedback.kind === "reset" ? (
        <Text style={styles.notice}>{text.resetDone}</Text>
      ) : feedback.kind === "validationError" ? (
        <Text style={styles.errorText}>{feedback.message}</Text>
      ) : saveErrorMessage === null ? (
        <Text style={styles.errorText}>
          {feedback.action === "reset" ? text.resetFailed : text.saveFailed}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function GuardedTimelineSettingsScreen(props: PluginSurfaceProps) {
  const text = useLocaleText().settings;
  return (
    <PluginsBoundary
      fallback={(
        <PluginsFailedCard
          message={text.renderFailed}
          color={props.theme.colors.statusDanger}
          background={props.theme.colors.surface0}
        />
      )}
    >
      <TimelineSettingsScreen {...props} />
    </PluginsBoundary>
  );
}

/** Register the Display settings screen under the plugin's host settings. */
export function contributeTimelineSettings(client: PluginClientContext): () => void {
  return client.addSettingsScreen({
    id: DISPLAY_SETTINGS_ID,
    title: localeText().settings.title,
    icon: SlidersIcon,
    Component: GuardedTimelineSettingsScreen,
  });
}

/**
 * Reach the Display settings from the Command Center without navigating
 * Settings → Plugins → DeepSeek Harness.
 */
export function contributeDisplaySettingsCommand(client: PluginClientContext): () => void {
  return client.addCommandCenterItem({
    id: "dsh-display-settings",
    title: localeText().settings.command,
    icon: SlidersIcon,
    keywords: ["DSH", "display", "timeline", "spacing", "language", "thinking", "reasoning", "显示", "时间线", "行间距", "语言", "思考", "样式"],
    context: "global",
    onSelect: (command) => {
      void Promise.resolve()
        .then(() => command.openSettings(DISPLAY_SETTINGS_ID))
        .catch((error) => {
          report("open display settings", error);
        });
    },
  });
}
