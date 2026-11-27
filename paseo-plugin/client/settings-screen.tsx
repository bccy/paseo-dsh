import * as React from "react";
import {
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import type {
  PluginClientContext,
  PluginGlobalCommandContext,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import * as PaseoUi from "@getpaseo/plugin/client/ui";
import type {
  SettingsRowProps,
  SettingsSelectProps,
} from "@getpaseo/plugin/client/ui";
import {
  LANGUAGE_DEFAULTS,
  TIMELINE_STYLE_DEFAULTS,
  TIMELINE_STYLE_KEYS,
  languageSettings,
  timelineStyleSettings,
  type LanguageChoice,
  type TimelineStyleKey,
  type TimelineStyleValues,
} from "../shared/settings";
import { PluginsBoundary, PluginsFailedCard, report } from "./dsh-plugins-guard";
import { SlidersIcon } from "./dsh-plugins-icon";
import {
  getLanguageOverride,
  localeText,
  setLanguageOverride,
  subscribeLocale,
  type DisplaySettingsText,
  type TimelinePresetKey,
} from "./locale";
import { useLocaleText } from "./use-locale";

/** The display settings screen id, shared by every entry point that opens it. */
export const DISPLAY_SETTINGS_ID = "timeline-style";

/** Subset of Paseo's theme colors needed by settings surfaces (compatible with Paseo >=0.16.0). */
export type SettingsThemeColors = Pick<
  PluginSurfaceProps["theme"]["colors"],
  | "surface0"
  | "surface1"
  | "border"
  | "foreground"
  | "foregroundMuted"
  | "accent"
  | "accentForeground"
  | "statusDanger"
>;

/** Bounds mirrored from `shared/settings.ts` for client-side validation messages. */
export const TIMELINE_STYLE_FIELD_BOUNDS: Record<
  TimelineStyleKey,
  { readonly min: number; readonly max: number }
> = {
  rowMarginY: { min: -16, max: 24 },
  toolRowPaddingY: { min: 0, max: 12 },
  toolRowMinHeight: { min: 12, max: 64 },
  toolRowGap: { min: 0, max: 24 },
  expandedMaxHeight: { min: 120, max: 640 },
  commandMaxHeightRatio: { min: 0.1, max: 0.6 },
  commandMinHeight: { min: 60, max: 360 },
};

/**
 * One-tap timeline spacing presets (Compact / Default / Relaxed).
 *
 * `default` mirrors `TIMELINE_STYLE_DEFAULTS` (`shared/settings.ts` v6) verbatim.
 */
export const TIMELINE_STYLE_PRESETS: Readonly<Record<TimelinePresetKey, TimelineStyleValues>> = {
  compact: {
    rowMarginY: -6,
    toolRowPaddingY: 0,
    toolRowMinHeight: 20,
    toolRowGap: 4,
    expandedMaxHeight: 200,
    commandMaxHeightRatio: 0.2,
    commandMinHeight: 120,
  },
  default: TIMELINE_STYLE_DEFAULTS,
  relaxed: {
    rowMarginY: 4,
    toolRowPaddingY: 3,
    toolRowMinHeight: 30,
    toolRowGap: 8,
    expandedMaxHeight: 340,
    commandMaxHeightRatio: 0.32,
    commandMinHeight: 180,
  },
};

export const TIMELINE_PRESET_KEYS: readonly TimelinePresetKey[] = [
  "compact",
  "default",
  "relaxed",
];

export const LANGUAGE_OPTIONS: readonly {
  readonly value: LanguageChoice;
  readonly labelKey: keyof Pick<DisplaySettingsText["language"], "auto" | "en" | "zhCN">;
}[] = [
  { value: "auto", labelKey: "auto" },
  { value: "en", labelKey: "en" },
  { value: "zh-CN", labelKey: "zhCN" },
];

export type TimelineFeedbackState =
  | { kind: "saved" }
  | { kind: "reset" }
  | { kind: "validationError"; message: string }
  | { kind: "fallbackError"; action: "save" | "reset" };

function numbersMatch(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

/** Return which quick preset matches `values`, or `null` when custom spacing is active. */
export function matchTimelineStylePreset(values: TimelineStyleValues): TimelinePresetKey | null {
  for (const presetKey of TIMELINE_PRESET_KEYS) {
    const preset = TIMELINE_STYLE_PRESETS[presetKey];
    let matches = true;
    for (const key of TIMELINE_STYLE_KEYS) {
      if (!numbersMatch(values[key], preset[key])) {
        matches = false;
        break;
      }
    }
    if (matches) return presetKey;
  }
  return null;
}

export function keyboardTypeFor(
  key: TimelineStyleKey,
): "default" | "numbers-and-punctuation" | "decimal-pad" | "numeric" {
  if (Platform.OS === "web") return "default";
  if (key === "rowMarginY") return "numbers-and-punctuation";
  if (key === "commandMaxHeightRatio") return "decimal-pad";
  return "numeric";
}

export function guardAsync(label: string, run: () => Promise<void>): void {
  void Promise.resolve()
    .then(run)
    .catch((error) => {
      report(label, error);
    });
}

function isHostComponent(value: unknown): boolean {
  return typeof value === "function" || (typeof value === "object" && value !== null);
}

/**
 * Pure React Native / Hermes-safe opacity tint helper matching `console-theme.ts#tint`
 * without importing `Platform.select` (kept lightweight for minimal headless test stubs).
 */
function tintColor(color: string, alpha: number): string {
  const value = color.trim();
  const safeAlpha = Number.isFinite(alpha) ? alpha : 1;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)?.[1];
  if (hex) {
    const full =
      hex.length === 3 || hex.length === 4
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;
    if (full.length === 6 || full.length === 8) {
      const base = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
      const combined = Math.round(Math.max(0, Math.min(1, base * safeAlpha)) * 10_000) / 10_000;
      return `rgba(${parseInt(full.slice(0, 2), 16)}, ${parseInt(full.slice(2, 4), 16)}, ${parseInt(full.slice(4, 6), 16)}, ${combined})`;
    }
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)?.[1];
  if (rgb) {
    const tokens = rgb.split(/[\s,/]+/).filter(Boolean);
    if (tokens.length >= 3) {
      const r = Number(tokens[0]);
      const g = Number(tokens[1]);
      const b = Number(tokens[2]);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        const rawBase = tokens[3];
        const base =
          rawBase === undefined
            ? 1
            : rawBase.endsWith("%")
              ? (Number(rawBase.slice(0, -1)) || 100) / 100
              : Number.isFinite(Number(rawBase))
                ? Number(rawBase)
                : 1;
        const combined = Math.round(Math.max(0, Math.min(1, base * safeAlpha)) * 10_000) / 10_000;
        return `rgba(${Math.max(0, Math.min(255, Math.round(r)))}, ${Math.max(0, Math.min(255, Math.round(g)))}, ${Math.max(0, Math.min(255, Math.round(b)))}, ${combined})`;
      }
    }
  }
  return color;
}

const uiExports = PaseoUi as Record<string, unknown>;

/**
 * Host `TextInput` from `@getpaseo/plugin/client/ui` (always present in Paseo >=0.16.0
 * and stubbed in offline harness tests).
 */
export const HostTextInput = PaseoUi.TextInput;

const REACT_FRAGMENT_SYMBOL =
  typeof Symbol === "function" ? Symbol.for("react.fragment") : undefined;

let cachedFragmentType: unknown;
let resolvedFragmentType = false;

function getFragmentType(): unknown {
  if (!resolvedFragmentType) {
    resolvedFragmentType = true;
    cachedFragmentType = (<></>).type;
  }
  return cachedFragmentType;
}

function isFragmentElement(node: unknown): node is { props?: { children?: ReactNode } } {
  if (typeof node !== "object" || node === null) return false;
  const type = (node as { type?: unknown }).type;
  if (type === undefined || type === null) return false;
  const jsxFragment = getFragmentType();
  return (
    (jsxFragment !== undefined && type === jsxFragment) ||
    (React.Fragment !== undefined && type === React.Fragment) ||
    type === "Fragment" ||
    (REACT_FRAGMENT_SYMBOL !== undefined && type === REACT_FRAGMENT_SYMBOL)
  );
}

/**
 * Flatten top-level and nested React Fragments / arrays into direct row children
 * so Paseo's native `SettingsCard` (`React.Children.toArray`) sees every row
 * individually and renders its native `rowBorder` divider between rows.
 */
export function flattenSettingsCardChildren(
  node: ReactNode,
  out: ReactNode[] = [],
): ReactNode[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      flattenSettingsCardChildren(item, out);
    }
    return out;
  }
  if (isFragmentElement(node)) {
    flattenSettingsCardChildren(node.props?.children, out);
    return out;
  }
  out.push(node);
  return out;
}

/**
 * Render Paseo's native `SettingsCard` when exported by the host (>=0.17 / 0.16.x),
 * falling back to a matching React Native `View` container on older hosts or minimal mocks.
 */
export function renderHostSettingsCard(
  colors: SettingsThemeColors,
  children: ReactNode,
  testID?: string,
): ReactNode {
  const rows = flattenSettingsCardChildren(children);
  const CardComp = uiExports["SettingsCard"] as
    | ComponentType<{ children?: ReactNode; testID?: string }>
    | undefined;
  if (isHostComponent(CardComp) && CardComp) {
    if (typeof React.createElement === "function") {
      return React.createElement(CardComp, testID !== undefined ? { testID } : null, ...rows);
    }
    return (
      <CardComp testID={testID}>
        {rows.length === 0 ? null : rows.length === 1 ? rows[0] : rows}
      </CardComp>
    );
  }
  const dividerColor = tintColor(colors.border, 0.7);
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: colors.surface1,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      {rows.map((row, index) => (
        <View
          key={index}
          style={
            index > 0 ? { borderTopWidth: 1, borderTopColor: dividerColor } : undefined
          }
        >
          {row}
        </View>
      ))}
    </View>
  );
}

export interface GuardedSettingsRowOptions extends SettingsRowProps {
  compact?: boolean;
  /** Lay label and control side-by-side when falling back without host SettingsRow. */
  inline?: boolean;
}

/**
 * Render Paseo's native `SettingsRow` when exported by the host, falling back to a clean
 * responsive React Native row on older hosts or minimal test mocks.
 */
export function renderHostSettingsRow(
  colors: SettingsThemeColors,
  { label, hint, error, children, testID, compact = false, inline = false }: GuardedSettingsRowOptions,
): ReactNode {
  const RowComp = uiExports["SettingsRow"] as ComponentType<SettingsRowProps> | undefined;
  if (isHostComponent(RowComp) && RowComp) {
    return (
      <RowComp label={label} hint={hint} error={error} testID={testID}>
        {children}
      </RowComp>
    );
  }
  const sideBySide = inline;
  return (
    <View
      testID={testID}
      style={{
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: compact ? 12 : 14,
        gap: 6,
      }}
    >
      <View
        style={{
          flexDirection: sideBySide ? "row" : "column",
          alignItems: sideBySide ? "center" : "stretch",
          justifyContent: sideBySide ? "space-between" : "flex-start",
          gap: sideBySide ? 12 : 8,
        }}
      >
        <View style={{ flex: sideBySide ? 1 : undefined, minWidth: 0, gap: 2 }}>
          <Text
            style={{
              color: colors.foreground,
              fontSize: compact ? 13 : 14,
              lineHeight: compact ? 18 : 20,
              fontWeight: "600",
            }}
          >
            {label}
          </Text>
          {hint ? (
            <Text
              style={{
                color: colors.foregroundMuted,
                fontSize: compact ? 12 : 12.5,
                lineHeight: compact ? 16 : 17,
              }}
            >
              {hint}
            </Text>
          ) : null}
        </View>
        {sideBySide && children !== undefined && children !== null ? (
          <View style={{ flexShrink: 0 }}>{children}</View>
        ) : (
          children ?? null
        )}
      </View>
      {error ? (
        <Text style={{ color: colors.statusDanger, fontSize: compact ? 12 : 13 }}>{error}</Text>
      ) : null}
    </View>
  );
}

export interface GuardedSettingsSelectOptions<Value extends string>
  extends SettingsSelectProps<Value> {
  compact?: boolean;
}

/**
 * Render Paseo's native `SettingsSelect` when exported by the host, falling back to a
 * horizontal pill-button selector on older hosts or test harnesses that omit `SettingsSelect`.
 */
export function renderHostSettingsSelect<Value extends string>(
  colors: SettingsThemeColors,
  {
    label,
    hint,
    error,
    value,
    options,
    onValueChange,
    disabled = false,
    testID,
    compact = false,
  }: GuardedSettingsSelectOptions<Value>,
): ReactNode {
  const SelectComp = uiExports["SettingsSelect"] as
    | ((props: SettingsSelectProps<Value>) => ReactNode)
    | undefined;
  if (isHostComponent(SelectComp) && SelectComp) {
    return (
      <SelectComp
        label={label}
        hint={hint}
        error={error}
        value={value}
        options={options}
        onValueChange={onValueChange}
        disabled={disabled}
        testID={testID}
      />
    );
  }
  return renderHostSettingsRow(colors, {
    label,
    hint,
    error,
    compact,
    testID,
    children: (
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled }}
              accessibilityLabel={option.label}
              disabled={disabled}
              onPress={() => onValueChange(option.value)}
              style={{
                borderWidth: 1,
                borderColor: selected ? colors.accent : colors.border,
                borderRadius: 8,
                paddingHorizontal: 14,
                paddingVertical: compact ? 8 : 9,
                backgroundColor: selected ? colors.accent : colors.surface1,
                opacity: disabled ? 0.6 : 1,
              }}
            >
              <Text
                style={{
                  color: selected ? colors.accentForeground : colors.foreground,
                  fontSize: compact ? 12.5 : 13,
                  fontWeight: "600",
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    ),
  });
}

export interface LanguageSettingsController {
  readonly status: "loading" | "error" | "invalid" | "ready";
  readonly saving: boolean;
  readonly error: string | null;
  readonly saveError: string | null;
  readonly currentLanguage: LanguageChoice;
  readonly disabled: boolean;
  readonly failed: boolean;
  readonly chooseLanguage: (choice: LanguageChoice) => Promise<void>;
  readonly clearFailed: () => void;
}

/**
 * Shared language override state & persistence controller with synchronous double-tap
 * lock (`languageInFlightRef`) and rollback on rejected/false saves.
 */
export function useLanguageSettingsController(): LanguageSettingsController {
  const language = useSettings(languageSettings);
  const [pickedLanguage, setPickedLanguage] = useState<LanguageChoice | null>(null);
  const [failed, setFailed] = useState(false);
  // Synchronous in-flight lock closes the rapid double-tap window before the
  // host hook flips `saving: true` on the next render, preventing duplicate
  // writes against the same revision.
  const languageInFlightRef = useRef(false);

  const currentLanguage: LanguageChoice =
    pickedLanguage
    ?? (language.status === "ready" ? language.values.language : LANGUAGE_DEFAULTS.language);

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
    setFailed(false);
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
      setFailed(true);
    }
  };

  return {
    status: language.status,
    saving: language.saving,
    error: language.status === "error" || language.status === "invalid" ? language.error : null,
    saveError: language.saveError,
    currentLanguage,
    disabled: language.status !== "ready" || language.saving,
    failed,
    chooseLanguage,
    clearFailed: () => setFailed(false),
  };
}

export interface TimelineStyleController {
  readonly status: "loading" | "error" | "invalid" | "ready";
  readonly saving: boolean;
  readonly error: string | null;
  readonly saveError: string | null;
  readonly current: TimelineStyleValues;
  readonly activePreset: TimelinePresetKey | null;
  readonly hasDraft: boolean;
  readonly canSave: boolean;
  readonly canReset: boolean;
  readonly feedback: TimelineFeedbackState | null;
  readonly textOf: (key: TimelineStyleKey) => string;
  readonly edit: (key: TimelineStyleKey, value: string) => void;
  readonly save: () => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly applyPreset: (presetKey: TimelinePresetKey) => Promise<void>;
  readonly clearFeedback: () => void;
}

/**
 * Shared timeline style state, preset matching, numeric validation, and persistence
 * controller with synchronous double-tap lock (`styleInFlightRef`).
 */
export function useTimelineStyleController(text: DisplaySettingsText): TimelineStyleController {
  const settings = useSettings(timelineStyleSettings);
  const [draft, setDraft] = useState<Partial<Record<TimelineStyleKey, string>>>({});
  const [feedback, setFeedback] = useState<TimelineFeedbackState | null>(null);
  // Synchronous in-flight lock closes the rapid double-tap window before the
  // host hook flips `saving: true` on the next render, preventing duplicate
  // writes against the same revision.
  const styleInFlightRef = useRef(false);

  const current: TimelineStyleValues =
    settings.status === "ready" ? settings.values : TIMELINE_STYLE_DEFAULTS;
  const canSave = settings.status === "ready" && !settings.saving;
  const canReset =
    (settings.status === "ready" || settings.status === "invalid") && !settings.saving;

  const textOf = (key: TimelineStyleKey): string => draft[key] ?? String(current[key]);

  const effectiveValues = useMemo<TimelineStyleValues>(() => {
    const merged: TimelineStyleValues = { ...current };
    for (const key of TIMELINE_STYLE_KEYS) {
      const raw = draft[key];
      if (raw === undefined) continue;
      const trimmed = raw.trim();
      if (trimmed === "") return { ...current, [key]: Number.NaN };
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return { ...current, [key]: Number.NaN };
      merged[key] = parsed;
    }
    return merged;
  }, [current, draft]);

  const activePreset = matchTimelineStylePreset(effectiveValues);
  const hasDraft = Object.keys(draft).length > 0;

  const edit = (key: TimelineStyleKey, value: string) => {
    if (settings.saving) return;
    setDraft((previous) => ({ ...previous, [key]: value }));
    setFeedback(null);
  };

  const persistValues = async (
    values: TimelineStyleValues,
    successKind: "saved" | "reset",
    action: "save" | "reset",
    logLabel: string,
  ) => {
    if (settings.status !== "ready" || settings.saving || styleInFlightRef.current) return;
    const parsed = timelineStyleSettings.schema.safeParse(values);
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
      report(logLabel, error);
      saved = false;
    } finally {
      styleInFlightRef.current = false;
    }
    if (saved) {
      setDraft({});
      setFeedback({ kind: successKind });
    } else {
      setFeedback({ kind: "fallbackError", action });
    }
  };

  const save = async () => {
    if (settings.status !== "ready" || settings.saving || styleInFlightRef.current) return;
    const candidate: TimelineStyleValues = { ...current };
    for (const key of TIMELINE_STYLE_KEYS) {
      const raw = textOf(key).trim();
      const value = raw === "" ? Number.NaN : Number(raw);
      const fieldCopy = text.fields[key];
      if (!Number.isFinite(value)) {
        setFeedback({ kind: "validationError", message: text.invalidNumber(fieldCopy.label) });
        return;
      }
      const bounds = TIMELINE_STYLE_FIELD_BOUNDS[key];
      if (value < bounds.min || value > bounds.max) {
        setFeedback({
          kind: "validationError",
          message: text.outOfRange(fieldCopy.label, bounds.min, bounds.max),
        });
        return;
      }
      candidate[key] = value;
    }
    await persistValues(candidate, "saved", "save", "timeline style save");
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
      setFeedback({ kind: "reset" });
    } else {
      setFeedback({ kind: "fallbackError", action: "reset" });
    }
  };

  const applyPreset = async (presetKey: TimelinePresetKey) => {
    if (presetKey === "default" && settings.status === "invalid") {
      await reset();
      return;
    }
    await persistValues(
      TIMELINE_STYLE_PRESETS[presetKey],
      "saved",
      "save",
      `timeline preset ${presetKey}`,
    );
  };

  return {
    status: settings.status,
    saving: settings.saving,
    error: settings.status === "error" || settings.status === "invalid" ? settings.error : null,
    saveError: settings.saveError,
    current,
    activePreset,
    hasDraft,
    canSave,
    canReset,
    feedback,
    textOf,
    edit,
    save,
    reset,
    applyPreset,
    clearFeedback: () => setFeedback(null),
  };
}

/**
 * Standalone numeric editor for timeline row spacing and command drawer height, plus plugin
 * language override. Uses host-native `SettingsCard` / `SettingsRow` / `SettingsSelect` when
 * provided by Paseo and falls back gracefully on older hosts / headless unit tests.
 */
export function TimelineSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const text = useLocaleText().settings;
  const styleCtrl = useTimelineStyleController(text);
  const langCtrl = useLanguageSettingsController();

  const compact = layout.compact;
  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: compact ? 12 : 14 },
      title: { color: colors.foreground, fontSize: compact ? 16 : 18, fontWeight: "600" as const },
      intro: {
        color: colors.foregroundMuted,
        fontSize: compact ? 13 : 14,
        lineHeight: compact ? 19 : 21,
      },
      input: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: compact ? 7 : 8,
        color: colors.foreground,
        backgroundColor: colors.surface0,
        fontSize: compact ? 13 : 14,
        minWidth: 84,
        textAlign: "right" as const,
      },
      presetRow: {
        flexDirection: "row" as const,
        flexWrap: compact ? ("nowrap" as const) : ("wrap" as const),
        gap: 8,
        ...(compact ? { width: "100%" as const } : { flexShrink: 0 }),
      },
      presetStackedRow: {
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: compact ? 12 : 14,
        gap: 10,
      },
      presetStackedHeader: { gap: 3 },
      presetStackedLabel: {
        color: colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      presetStackedHint: {
        color: colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 17,
      },
      presetButton: {
        ...(compact ? { flex: 1, minWidth: 0, alignItems: "center" as const } : { flexShrink: 0 }),
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: compact ? 7 : 8,
        backgroundColor: colors.surface0,
      },
      presetButtonSelected: {
        borderColor: colors.accent,
        backgroundColor: colors.accent,
      },
      presetLabel: {
        color: colors.foreground,
        fontSize: compact ? 12.5 : 13,
        fontWeight: "600" as const,
      },
      presetLabelSelected: {
        color: colors.accentForeground,
      },
      actions: { flexDirection: "row" as const, gap: 10, marginTop: 4 },
      button: {
        paddingHorizontal: 16,
        paddingVertical: compact ? 9 : 10,
        borderRadius: 8,
        backgroundColor: colors.accent,
      },
      buttonDisabled: {
        opacity: 0.6,
      },
      secondary: {
        backgroundColor: colors.surface1,
        borderWidth: 1,
        borderColor: colors.border,
      },
      buttonText: {
        color: colors.accentForeground,
        fontWeight: "600" as const,
        fontSize: compact ? 13 : 14,
      },
      secondaryText: {
        color: colors.foreground,
        fontWeight: "600" as const,
        fontSize: compact ? 13 : 14,
      },
      notice: { color: colors.foregroundMuted, fontSize: compact ? 12 : 13 },
      errorText: { color: colors.statusDanger, fontSize: compact ? 12 : 13 },
    }),
    [colors, compact],
  );

  const languageSelectOptions = useMemo(
    () =>
      LANGUAGE_OPTIONS.map((option) => ({
        value: option.value,
        label: text.language[option.labelKey],
      })),
    [text.language],
  );

  const saveErrorMessage = styleCtrl.saveError ?? langCtrl.saveError;
  const effectiveFeedback: TimelineFeedbackState | null =
    styleCtrl.feedback ?? (langCtrl.failed ? { kind: "fallbackError", action: "save" } : null);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{text.title}</Text>
      <Text style={styles.intro}>{text.intro}</Text>

      {renderHostSettingsCard(
        colors,
        renderHostSettingsSelect(colors, {
          label: text.language.label,
          hint: text.language.hint,
          value: langCtrl.currentLanguage,
          options: languageSelectOptions,
          disabled: langCtrl.disabled,
          compact,
          onValueChange: (choice) => {
            styleCtrl.clearFeedback();
            guardAsync("language save", () => langCtrl.chooseLanguage(choice));
          },
        }),
      )}

      {renderHostSettingsCard(
        colors,
        <>
          {compact ? (
            <View style={styles.presetStackedRow}>
              <View style={styles.presetStackedHeader}>
                <Text style={styles.presetStackedLabel}>{text.presets.label}</Text>
                <Text style={styles.presetStackedHint}>
                  {styleCtrl.activePreset === null ? text.presets.custom : text.presets.hint}
                </Text>
              </View>
              <View style={styles.presetRow}>
                {TIMELINE_PRESET_KEYS.map((presetKey) => {
                  const selected = styleCtrl.activePreset === presetKey;
                  const presetLabel = text.presets[presetKey];
                  return (
                    <Pressable
                      key={`preset-${presetKey}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled: !styleCtrl.canSave }}
                      accessibilityLabel={presetLabel}
                      disabled={!styleCtrl.canSave}
                      onPress={() => {
                        langCtrl.clearFailed();
                        guardAsync(`timeline preset ${presetKey}`, () =>
                          styleCtrl.applyPreset(presetKey),
                        );
                      }}
                      style={[
                        styles.presetButton,
                        selected ? styles.presetButtonSelected : null,
                        styleCtrl.canSave ? null : styles.buttonDisabled,
                      ]}
                    >
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.presetLabel,
                          selected ? styles.presetLabelSelected : null,
                        ]}
                      >
                        {presetLabel}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : (
            renderHostSettingsRow(colors, {
              label: text.presets.label,
              hint: styleCtrl.activePreset === null ? text.presets.custom : text.presets.hint,
              compact,
              inline: true,
              children: (
                <View style={styles.presetRow}>
                  {TIMELINE_PRESET_KEYS.map((presetKey) => {
                    const selected = styleCtrl.activePreset === presetKey;
                    const presetLabel = text.presets[presetKey];
                    return (
                      <Pressable
                        key={`preset-${presetKey}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected, disabled: !styleCtrl.canSave }}
                        accessibilityLabel={presetLabel}
                        disabled={!styleCtrl.canSave}
                        onPress={() => {
                          langCtrl.clearFailed();
                          guardAsync(`timeline preset ${presetKey}`, () =>
                            styleCtrl.applyPreset(presetKey),
                          );
                        }}
                        style={[
                          styles.presetButton,
                          selected ? styles.presetButtonSelected : null,
                          styleCtrl.canSave ? null : styles.buttonDisabled,
                        ]}
                      >
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.presetLabel,
                            selected ? styles.presetLabelSelected : null,
                          ]}
                        >
                          {presetLabel}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ),
            })
          )}

          {TIMELINE_STYLE_KEYS.map((key) => {
            const fieldCopy = text.fields[key];
            return renderHostSettingsRow(colors, {
              label: fieldCopy.label,
              hint: fieldCopy.hint,
              compact,
              inline: true,
              children: (
                <HostTextInput
                  value={styleCtrl.textOf(key)}
                  editable={!styleCtrl.saving}
                  onChangeText={(value: string) => {
                    langCtrl.clearFailed();
                    styleCtrl.edit(key, value);
                  }}
                  keyboardType={keyboardTypeFor(key)}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel={fieldCopy.label}
                  style={styles.input}
                />
              ),
            });
          })}
        </>,
      )}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text.save}
          disabled={!styleCtrl.canSave}
          onPress={() => {
            langCtrl.clearFailed();
            guardAsync("settings save", styleCtrl.save);
          }}
          style={[styles.button, styleCtrl.canSave ? null : styles.buttonDisabled]}
        >
          <Text style={styles.buttonText}>{styleCtrl.saving ? text.saving : text.save}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text.reset}
          disabled={!styleCtrl.canReset}
          onPress={() => {
            langCtrl.clearFailed();
            guardAsync("settings reset", styleCtrl.reset);
          }}
          style={[styles.button, styles.secondary, styleCtrl.canReset ? null : styles.buttonDisabled]}
        >
          <Text style={styles.secondaryText}>{text.reset}</Text>
        </Pressable>
      </View>

      {styleCtrl.status === "loading" || langCtrl.status === "loading" ? (
        <Text style={styles.notice}>{text.loading}</Text>
      ) : null}
      {styleCtrl.error !== null ? <Text style={styles.errorText}>{styleCtrl.error}</Text> : null}
      {langCtrl.error !== null ? <Text style={styles.errorText}>{langCtrl.error}</Text> : null}
      {saveErrorMessage === null ? null : (
        <Text style={styles.errorText}>{saveErrorMessage}</Text>
      )}
      {effectiveFeedback === null ? null : effectiveFeedback.kind === "saved" ? (
        <Text style={styles.notice}>{text.saved}</Text>
      ) : effectiveFeedback.kind === "reset" ? (
        <Text style={styles.notice}>{text.resetDone}</Text>
      ) : effectiveFeedback.kind === "validationError" ? (
        <Text style={styles.errorText}>{effectiveFeedback.message}</Text>
      ) : saveErrorMessage === null ? (
        <Text style={styles.errorText}>
          {effectiveFeedback.action === "reset" ? text.resetFailed : text.saveFailed}
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

/**
 * Register a host contribution whose title refreshes live whenever the active locale
 * changes (for example after persisted language settings finish loading asynchronously).
 */
export function registerWithLiveTitle(
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
      report(label, error);
    }
  });
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    remove();
  };
}

/**
 * Register the Display settings screen under the plugin's host settings.
 *
 * Accepts an optional `Component` override so the unified console can mount directly on its
 * Settings tab when opened from Paseo Settings while keeping `DISPLAY_SETTINGS_ID` and live
 * title updates intact.
 */
export function contributeTimelineSettings(
  client: PluginClientContext,
  Component: ComponentType<PluginSurfaceProps> = GuardedTimelineSettingsScreen,
): () => void {
  return registerWithLiveTitle(
    "timeline settings title refresh",
    () => localeText().settings.title,
    (title) =>
      client.addSettingsScreen({
        id: DISPLAY_SETTINGS_ID,
        title,
        icon: SlidersIcon,
        Component,
      }),
  );
}

/**
 * Reach the Display settings from the Command Center without navigating
 * Settings → Plugins → DeepSeek Harness.
 */
export function contributeDisplaySettingsCommand(
  client: PluginClientContext,
  onOpen?: (command: PluginGlobalCommandContext) => void | Promise<void>,
): () => void {
  return registerWithLiveTitle(
    "display settings command title refresh",
    () => localeText().settings.command,
    (title) =>
      client.addCommandCenterItem({
        id: "dsh-display-settings",
        title,
        icon: SlidersIcon,
        keywords: [
          "DSH",
          "console",
          "display",
          "timeline",
          "spacing",
          "language",
          "settings",
          "doctor",
          "控制台",
          "显示",
          "时间线",
          "行间距",
          "语言",
          "设置",
          "诊断",
        ],
        context: "global",
        onSelect: (command) => {
          void Promise.resolve()
            .then(() =>
              onOpen ? onOpen(command) : command.openSettings(DISPLAY_SETTINGS_ID),
            )
            .catch((error) => {
              report("open display settings", error);
            });
        },
      }),
  );
}
