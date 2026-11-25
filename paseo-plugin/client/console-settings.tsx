/**
 * Tab 3 ("Settings") of the unified DSH Console.
 *
 * Composes three host-native `SettingsCard` sections:
 * 1. Environment & Route Overview (ready slot for Phase 2 diagnostics + on-demand Doctor)
 * 2. General & Cost Preferences (UI language wired to `languageSettings` + currency / rate / pricing modal slot for Phase 3)
 * 3. Timeline Display Style (Quick presets: Compact / Default / Relaxed + collapsible Advanced spacing tweaks)
 *
 * @module dsh-paseo/client/console-settings
 */
import { useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { TIMELINE_STYLE_KEYS } from "../shared/settings";
import { currencySymbol, type Currency } from "./console-format";
import { font, radius, space, tabular, tint, type Colors, type Tone } from "./console-theme";
import { Badge, Button, Callout, Muted, SegmentedControl } from "./console-ui";
import type { Locale, TimelinePresetKey } from "./locale";
import {
  HostTextInput,
  LANGUAGE_OPTIONS,
  TIMELINE_PRESET_KEYS,
  guardAsync,
  keyboardTypeFor,
  renderHostSettingsCard,
  renderHostSettingsRow,
  renderHostSettingsSelect,
  useLanguageSettingsController,
  useTimelineStyleController,
} from "./settings-screen";
import { useCurrentLocale, useLocaleText } from "./use-locale";

type PressState = { pressed: boolean; hovered?: boolean };

const DEFAULT_DISPLAY_CURRENCY: Currency = "USD";
const DEFAULT_USD_TO_CNY_RATE = 7.2;

export type DiagnosticsCheckStatus = "ok" | "warn" | "fail";

export interface DiagnosticsCheckItem {
  readonly id: string;
  readonly label: string;
  readonly status: DiagnosticsCheckStatus;
  readonly summary: string;
  readonly hint?: string;
}

/**
 * Structured data contract accepted by the Environment & Route Overview card.
 * Phase 2 can either pass this object OR supply `renderEnvironment` for full custom control.
 */
export interface EnvironmentOverviewSlotData {
  readonly dshVersion?: string | null;
  readonly dshPath?: string | null;
  readonly profileName?: string | null;
  readonly profileDir?: string | null;
  readonly bridgeStatus?: string | null;
  readonly bridgeTone?: Tone;
  readonly defaultRoute?: string | null;
  readonly credentialsStatus?: string | null;
  readonly credentialsTone?: Tone;
  readonly providerCount?: number;
  readonly modelCount?: number;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly doctorRunning?: boolean;
  readonly doctorChecks?: readonly DiagnosticsCheckItem[] | null;
  readonly doctorFailureHint?: string | null;
  readonly onRunDoctor?: () => void;
}

export interface ConsoleSettingsEnvironmentProps {
  /** Custom Phase 2 renderer replacing the default Environment & Route Overview card body. */
  readonly renderEnvironment?: (context: {
    colors: Colors;
    compact: boolean;
    locale: Locale;
  }) => ReactNode;
  /** Structured overview + Doctor results rendered by the built-in card layout. */
  readonly environment?: EnvironmentOverviewSlotData;
}

/**
 * Dual-currency & model pricing callbacks/state for Phase 3 integration.
 * When omitted in Phase 1, defaults (`USD`, `7.2`) display cleanly as disabled/read-only
 * rather than silently discarding edits.
 */
export interface PricingPreferencesSlot {
  readonly currency: Currency;
  readonly usdToCnyRate: number;
  readonly hasCustomOverrides?: boolean;
  readonly saving?: boolean;
  readonly error?: string | null;
  readonly onChangeCurrency?: (currency: Currency) => void | Promise<void>;
  readonly onChangeExchangeRate?: (rate: number) => void | Promise<void>;
  readonly onOpenPricingModal?: () => void;
}

export interface ConsoleSettingsTabProps extends ConsoleSettingsEnvironmentProps {
  readonly colors: Colors;
  readonly host: PluginHostProps["host"];
  readonly compact: boolean;
  readonly pricing?: PricingPreferencesSlot;
}

function SectionHeading({
  colors,
  title,
  trailing,
}: {
  colors: Colors;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space.sm,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ ...font.heading, color: colors.foreground, flexShrink: 1 }}
      >
        {title}
      </Text>
      {trailing ?? null}
    </View>
  );
}

function checkStatusTone(status: DiagnosticsCheckStatus): Tone {
  if (status === "ok") return "success";
  if (status === "warn") return "warning";
  return "danger";
}

function EnvironmentSection({
  colors,
  host,
  compact,
  locale,
  renderEnvironment,
  environment,
}: {
  colors: Colors;
  host: PluginHostProps["host"];
  compact: boolean;
  locale: Locale;
  renderEnvironment?: ConsoleSettingsEnvironmentProps["renderEnvironment"];
  environment?: EnvironmentOverviewSlotData;
}) {
  const copy = useLocaleText().console.settingsSections.environment;

  if (renderEnvironment) {
    return <>{renderEnvironment({ colors, compact, locale })}</>;
  }

  const hasDoctorFailures =
    environment?.doctorChecks?.some((item) => item.status === "fail") ?? false;

  const statusLabelOf = (status: DiagnosticsCheckStatus): string =>
    status === "ok" ? copy.statusOk : status === "warn" ? copy.statusWarn : copy.statusFail;

  const summaryParts =
    environment && (environment.providerCount !== undefined || environment.modelCount !== undefined)
      ? copy.providersModels(environment.providerCount ?? 0, environment.modelCount ?? 0)
      : undefined;

  return (
    <View style={{ gap: space.md }}>
      <SectionHeading
        colors={colors}
        title={copy.title}
        trailing={
          environment?.onRunDoctor ? (
            <Button
              colors={colors}
              size="sm"
              variant="secondary"
              icon="RefreshCw"
              label={environment.doctorRunning ? copy.runningDoctor : copy.runDoctor}
              loading={Boolean(environment.doctorRunning)}
              onPress={environment.onRunDoctor}
            />
          ) : (
            <Badge colors={colors} tone="neutral" dot label={copy.readyBadge} />
          )
        }
      />

      {renderHostSettingsCard(
        colors,
        environment ? (
          <>
            {environment.loading ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  paddingHorizontal: compact ? space.md : space.lg,
                  paddingVertical: compact ? 12 : 14,
                }}
              >
                <ActivityIndicator size="small" color={colors.accent} />
                <Muted colors={colors}>{copy.loading}</Muted>
              </View>
            ) : null}

            {renderHostSettingsRow(colors, {
              label: copy.cliLabel,
              hint: environment.dshPath ?? undefined,
              compact,
              inline: true,
              children: (
                <Text
                  style={{
                    ...font.small,
                    ...tabular,
                    color: environment.dshVersion ? colors.foreground : colors.statusWarning,
                  }}
                >
                  {environment.dshVersion ?? copy.cliMissing}
                </Text>
              ),
            })}

            {environment.profileName || environment.profileDir
              ? renderHostSettingsRow(colors, {
                  label: copy.profileLabel,
                  hint: environment.profileDir ?? undefined,
                  compact,
                  inline: true,
                  children: (
                    <Text style={{ ...font.small, color: colors.foreground }}>
                      {environment.profileName ?? "—"}
                    </Text>
                  ),
                })
              : null}

            {environment.bridgeStatus
              ? renderHostSettingsRow(colors, {
                  label: copy.bridgeLabel,
                  compact,
                  inline: true,
                  children: (
                    <Badge
                      colors={colors}
                      tone={environment.bridgeTone ?? "neutral"}
                      dot
                      label={environment.bridgeStatus}
                    />
                  ),
                })
              : null}

            {environment.defaultRoute || summaryParts
              ? renderHostSettingsRow(colors, {
                  label: copy.routeLabel,
                  hint: summaryParts,
                  compact,
                  inline: true,
                  children: (
                    <Text style={{ ...font.small, color: colors.foreground }}>
                      {environment.defaultRoute ?? "—"}
                    </Text>
                  ),
                })
              : null}

            {environment.credentialsStatus
              ? renderHostSettingsRow(colors, {
                  label: copy.credentialsLabel,
                  compact,
                  inline: true,
                  children: (
                    <Badge
                      colors={colors}
                      tone={environment.credentialsTone ?? "neutral"}
                      dot
                      label={environment.credentialsStatus}
                    />
                  ),
                })
              : null}

            {environment.doctorChecks && environment.doctorChecks.length > 0 ? (
              <View
                style={{
                  gap: space.sm,
                  paddingHorizontal: compact ? space.md : space.lg,
                  paddingVertical: compact ? 12 : 14,
                }}
              >
                {environment.doctorChecks.map((item) => (
                  <View
                    key={item.id}
                    style={{
                      flexDirection: compact ? "column" : "row",
                      alignItems: compact ? "flex-start" : "center",
                      justifyContent: "space-between",
                      gap: space.sm,
                      paddingVertical: space.xs,
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>
                        {item.label}
                      </Text>
                      <Muted colors={colors} small>
                        {item.summary}
                      </Muted>
                      {item.hint ? (
                        <Muted colors={colors} small>
                          {item.hint}
                        </Muted>
                      ) : null}
                    </View>
                    <Badge
                      colors={colors}
                      tone={checkStatusTone(item.status)}
                      dot
                      label={statusLabelOf(item.status)}
                    />
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : (
          <>
            {renderHostSettingsRow(colors, {
              label: copy.hostLabel,
              hint: copy.description,
              compact,
              inline: true,
              children: (
                <Text style={{ ...font.small, color: colors.foreground }}>
                  {host.label || host.id}
                </Text>
              ),
            })}
            {renderHostSettingsRow(colors, {
              label: copy.placeholderTitle,
              hint: copy.placeholderHint,
              compact,
              inline: true,
              children: (
                <Badge colors={colors} tone="neutral" icon="ShieldCheck" label={copy.readyBadge} />
              ),
            })}
          </>
        ),
        "dsh-console-environment-card",
      )}

      {environment?.error ? (
        <Callout colors={colors} tone="danger" icon="CircleAlert" title={environment.error} />
      ) : null}

      {hasDoctorFailures ? (
        <Callout
          colors={colors}
          tone="danger"
          icon="TriangleAlert"
          title={copy.failCalloutTitle}
          action={
            environment?.onRunDoctor ? (
              <Button
                colors={colors}
                size="sm"
                variant="secondary"
                icon="RefreshCw"
                label={copy.recheck}
                loading={Boolean(environment.doctorRunning)}
                onPress={environment.onRunDoctor}
              />
            ) : undefined
          }
        >
          {environment?.doctorFailureHint ? (
            <Muted colors={colors}>{environment.doctorFailureHint}</Muted>
          ) : null}
        </Callout>
      ) : null}
    </View>
  );
}

function GeneralAndCostSection({
  colors,
  compact,
  pricing,
}: {
  colors: Colors;
  compact: boolean;
  pricing?: PricingPreferencesSlot;
}) {
  const allCopy = useLocaleText();
  const settingsCopy = allCopy.settings;
  const generalCopy = allCopy.console.settingsSections.general;
  const langCtrl = useLanguageSettingsController();

  const [rateDraft, setRateDraft] = useState<string | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
  const rateInFlightRef = useRef(false);

  const languageOptions = LANGUAGE_OPTIONS.map((option) => ({
    value: option.value,
    label: settingsCopy.language[option.labelKey],
  }));

  const currentCurrency: Currency = pricing?.currency ?? DEFAULT_DISPLAY_CURRENCY;
  const currencySym = currencySymbol(currentCurrency);
  const currentRate = pricing?.usdToCnyRate ?? DEFAULT_USD_TO_CNY_RATE;
  const rateText = rateDraft ?? String(currentRate);
  const pricingBusy = Boolean(pricing?.saving);
  const canChangeCurrency = Boolean(pricing?.onChangeCurrency) && !pricingBusy;
  const canChangeRate = Boolean(pricing?.onChangeExchangeRate) && !pricingBusy;
  const canOpenPricing = Boolean(pricing?.onOpenPricingModal);
  const rateDirty = rateDraft !== null && rateDraft.trim() !== String(currentRate);
  const rateErrorMessage = rateError ?? pricing?.error ?? null;
  const rowPaddingX = compact ? space.md : space.lg;
  const rowPaddingY = compact ? 12 : 14;
  const exchangeRateHint = pricing?.onChangeExchangeRate
    ? generalCopy.exchangeRateHint
    : `${generalCopy.exchangeRateHint} ${generalCopy.pricingPendingHint}`;
  const pricingHint = canOpenPricing
    ? generalCopy.pricingHint
    : `${generalCopy.pricingHint} ${generalCopy.pricingPendingHint}`;

  const applyExchangeRate = async () => {
    if (!pricing?.onChangeExchangeRate || pricingBusy || rateInFlightRef.current) return;
    const trimmed = rateText.trim();
    const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0.01 || parsed > 1000) {
      setRateError(generalCopy.exchangeRateInvalid);
      return;
    }
    rateInFlightRef.current = true;
    setRateError(null);
    try {
      await pricing.onChangeExchangeRate(parsed);
      setRateDraft(null);
    } catch (error) {
      setRateError(error instanceof Error ? error.message : settingsCopy.saveFailed);
    } finally {
      rateInFlightRef.current = false;
    }
  };

  const languageError =
    langCtrl.error
    ?? langCtrl.saveError
    ?? (langCtrl.failed ? settingsCopy.saveFailed : null);

  const exchangeRateFormula = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        flexShrink: 0,
      }}
    >
      <Text
        numberOfLines={1}
        style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}
      >
        1 USD =
      </Text>
      <HostTextInput
        value={rateText}
        editable={canChangeRate}
        onChangeText={(value: string) => {
          setRateDraft(value);
          setRateError(null);
        }}
        keyboardType={Platform.OS === "web" ? "default" : "decimal-pad"}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={generalCopy.exchangeRateLabel}
        style={{
          borderWidth: 1,
          borderColor: rateErrorMessage ? colors.statusDanger : colors.border,
          borderRadius: radius.md,
          paddingHorizontal: space.sm + 2,
          paddingVertical: 5,
          height: 30,
          width: compact ? 74 : 80,
          minWidth: compact ? 74 : 80,
          textAlign: "right",
          ...font.small,
          ...tabular,
          color: canChangeRate ? colors.foreground : colors.foregroundMuted,
          backgroundColor: colors.surface0,
          opacity: canChangeRate ? 1 : 0.65,
        }}
      />
      <Text
        numberOfLines={1}
        style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}
      >
        CNY
      </Text>
    </View>
  );

  const exchangeRateApplyButton =
    rateDirty && canChangeRate ? (
      <Button
        colors={colors}
        size="sm"
        variant="primary"
        label={generalCopy.exchangeRateApply}
        onPress={() => guardAsync("exchange rate save", applyExchangeRate)}
      />
    ) : null;

  const pricingActionButton = (
    <Button
      colors={colors}
      size="sm"
      variant="secondary"
      icon="Coins"
      label={generalCopy.pricingAction}
      disabled={!canOpenPricing || pricingBusy}
      onPress={() => pricing?.onOpenPricingModal?.()}
    />
  );

  return (
    <View style={{ gap: space.md }}>
      <SectionHeading colors={colors} title={generalCopy.title} />

      {renderHostSettingsCard(
        colors,
        <>
          {renderHostSettingsSelect(colors, {
            label: settingsCopy.language.label,
            hint: settingsCopy.language.hint,
            error: languageError,
            value: langCtrl.currentLanguage,
            options: languageOptions,
            disabled: langCtrl.disabled,
            compact,
            onValueChange: (choice) => {
              guardAsync("language save", () => langCtrl.chooseLanguage(choice));
            },
          })}

          {renderHostSettingsRow(colors, {
            label: generalCopy.currencyLabel,
            hint: pricing?.onChangeCurrency
              ? generalCopy.currencyHint
              : `${generalCopy.currencyHint} ${generalCopy.pricingPendingHint}`,
            compact,
            inline: true,
            children: (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${generalCopy.currencyLabel}: ${currentCurrency === "USD" ? generalCopy.currencyUsd : generalCopy.currencyCny}`}
                accessibilityState={{ disabled: !canChangeCurrency }}
                disabled={!canChangeCurrency}
                hitSlop={4}
                onPress={() => {
                  if (!canChangeCurrency || !pricing?.onChangeCurrency) return;
                  const next: Currency = currentCurrency === "USD" ? "CNY" : "USD";
                  guardAsync("currency update", async () => {
                    await pricing.onChangeCurrency?.(next);
                  });
                }}
                style={(state) => {
                  const active =
                    canChangeCurrency
                    && ((state as PressState).pressed || Boolean((state as PressState).hovered));
                  return {
                    height: 30,
                    paddingHorizontal: space.sm + 2,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: active ? tint(colors.foreground, 0.06) : colors.surface0,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 5,
                    flexShrink: 0,
                    opacity: canChangeCurrency ? 1 : 0.45,
                  };
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    ...font.small,
                    ...tabular,
                    fontWeight: "600",
                    color: canChangeCurrency ? colors.accent : colors.foregroundMuted,
                  }}
                >
                  {currencySym}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{
                    ...font.small,
                    ...tabular,
                    fontWeight: "600",
                    color: colors.foreground,
                  }}
                >
                  {currentCurrency}
                </Text>
                <Icon name="ArrowLeftRight" size={12} color={colors.foregroundMuted} />
              </Pressable>
            ),
          })}

          {compact ? (
            <View
              style={{
                paddingHorizontal: rowPaddingX,
                paddingVertical: rowPaddingY,
                gap: 10,
              }}
            >
              <View style={{ gap: 2 }}>
                <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>
                  {generalCopy.exchangeRateLabel}
                </Text>
                <Muted colors={colors} small>
                  {exchangeRateHint}
                </Muted>
              </View>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: space.sm,
                }}
              >
                {exchangeRateFormula}
                {exchangeRateApplyButton}
              </View>
              {rateErrorMessage ? (
                <Text style={{ ...font.caption, color: colors.statusDanger }}>
                  {rateErrorMessage}
                </Text>
              ) : null}
            </View>
          ) : (
            renderHostSettingsRow(colors, {
              label: generalCopy.exchangeRateLabel,
              hint: exchangeRateHint,
              error: rateErrorMessage,
              compact,
              inline: true,
              children: (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    gap: space.sm,
                    flexShrink: 0,
                  }}
                >
                  {exchangeRateFormula}
                  {exchangeRateApplyButton}
                </View>
              ),
            })
          )}

          {compact ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: space.md,
                paddingHorizontal: rowPaddingX,
                paddingVertical: rowPaddingY,
              }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <View
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: space.xs + 2,
                  }}
                >
                  <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>
                    {generalCopy.pricingLabel}
                  </Text>
                  {pricing?.hasCustomOverrides ? (
                    <Badge
                      colors={colors}
                      tone="accent"
                      label={generalCopy.pricingCustomBadge}
                    />
                  ) : null}
                </View>
                <Muted colors={colors} small>
                  {pricingHint}
                </Muted>
              </View>
              <View style={{ flexShrink: 0 }}>{pricingActionButton}</View>
            </View>
          ) : (
            renderHostSettingsRow(colors, {
              label: generalCopy.pricingLabel,
              hint: pricingHint,
              compact,
              inline: true,
              children: (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    gap: space.sm,
                    flexShrink: 0,
                  }}
                >
                  {pricing?.hasCustomOverrides ? (
                    <Badge
                      colors={colors}
                      tone="accent"
                      label={generalCopy.pricingCustomBadge}
                    />
                  ) : null}
                  {pricingActionButton}
                </View>
              ),
            })
          )}
        </>,
        "dsh-console-general-card",
      )}
    </View>
  );
}

function TimelineDisplaySection({
  colors,
  compact,
}: {
  colors: Colors;
  compact: boolean;
}) {
  const allCopy = useLocaleText();
  const settingsCopy = allCopy.settings;
  const sectionCopy = allCopy.console.settingsSections.timeline;
  const styleCtrl = useTimelineStyleController(settingsCopy);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const presetOptions = TIMELINE_PRESET_KEYS.map((presetKey) => ({
    value: presetKey,
    label: settingsCopy.presets[presetKey],
    disabled: !styleCtrl.canSave,
  }));

  const saveErrorMessage = styleCtrl.saveError;
  const feedback = styleCtrl.feedback;

  const statusBadge =
    feedback?.kind === "saved" ? (
      <Badge
        colors={colors}
        tone="success"
        icon="CircleCheck"
        label={settingsCopy.saved}
        testID="dsh-timeline-feedback-badge"
      />
    ) : feedback?.kind === "reset" ? (
      <Badge
        colors={colors}
        tone="success"
        icon="RotateCcw"
        label={settingsCopy.resetDone}
        testID="dsh-timeline-feedback-badge"
      />
    ) : null;

  const showHeaderStatus = !advancedOpen && statusBadge !== null;
  const showCustomBadge = styleCtrl.activePreset === null;
  const headingTrailing =
    showCustomBadge || showHeaderStatus ? (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          justifyContent: "flex-end",
          gap: space.xs,
          flexShrink: 0,
        }}
      >
        {showHeaderStatus ? statusBadge : null}
        {showCustomBadge ? (
          <Badge colors={colors} tone="accent" label={settingsCopy.presets.custom} />
        ) : null}
      </View>
    ) : null;

  const presetControl = (
    <SegmentedControl<TimelinePresetKey | "">
      colors={colors}
      value={styleCtrl.activePreset ?? ""}
      options={presetOptions}
      size="sm"
      fullWidth={compact}
      style={compact ? { width: "100%" } : undefined}
      testID="dsh-timeline-presets"
      onChange={(presetKey) => {
        if (presetKey === "") return;
        guardAsync(`timeline preset ${presetKey}`, () =>
          styleCtrl.applyPreset(presetKey),
        );
      }}
    />
  );

  return (
    <View style={{ gap: space.md }}>
      <View style={{ gap: space.xs }}>
        <SectionHeading
          colors={colors}
          title={sectionCopy.title}
          trailing={headingTrailing}
        />
        <Muted colors={colors}>{sectionCopy.intro}</Muted>
      </View>

      {renderHostSettingsCard(
        colors,
        <>
          {compact ? (
            <View
              testID="dsh-timeline-presets-row"
              style={{
                paddingHorizontal: space.md,
                paddingVertical: 12,
                gap: 10,
              }}
            >
              <View style={{ gap: 2 }}>
                <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>
                  {settingsCopy.presets.label}
                </Text>
                <Muted colors={colors} small>
                  {settingsCopy.presets.hint}
                </Muted>
              </View>
              {presetControl}
            </View>
          ) : (
            renderHostSettingsRow(colors, {
              label: settingsCopy.presets.label,
              hint: settingsCopy.presets.hint,
              compact,
              inline: true,
              testID: "dsh-timeline-presets-row",
              children: presetControl,
            })
          )}

          <Pressable
            testID="dsh-timeline-advanced-toggle"
            accessibilityRole="button"
            accessibilityState={{ expanded: advancedOpen }}
            accessibilityLabel={settingsCopy.advanced.title}
            onPress={() => setAdvancedOpen((open) => !open)}
            style={(state) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.md,
              paddingHorizontal: compact ? space.md : space.lg,
              paddingVertical: compact ? 12 : 14,
              backgroundColor:
                state.pressed || Boolean((state as PressState).hovered)
                  ? tint(colors.foreground, 0.05)
                  : "transparent",
            })}
          >
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text
                style={{
                  ...(compact ? font.small : font.body),
                  fontWeight: "600",
                  color: colors.foreground,
                }}
              >
                {settingsCopy.advanced.title}
              </Text>
              <Muted colors={colors} small>
                {settingsCopy.advanced.hint}
              </Muted>
            </View>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.xs,
                flexShrink: 0,
              }}
            >
              <Text style={{ ...font.caption, fontWeight: "500", color: colors.foregroundMuted }}>
                {advancedOpen ? settingsCopy.advanced.collapse : settingsCopy.advanced.expand}
              </Text>
              <View style={{ transform: [{ rotate: advancedOpen ? "90deg" : "0deg" }] }}>
                <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />
              </View>
            </View>
          </Pressable>

          {advancedOpen ? (
            <>
              {TIMELINE_STYLE_KEYS.map((key) => {
                const fieldCopy = settingsCopy.fields[key];
                return renderHostSettingsRow(colors, {
                  label: fieldCopy.label,
                  hint: fieldCopy.hint,
                  compact,
                  inline: true,
                  children: (
                    <HostTextInput
                      value={styleCtrl.textOf(key)}
                      editable={!styleCtrl.saving}
                      onChangeText={(value: string) => styleCtrl.edit(key, value)}
                      keyboardType={keyboardTypeFor(key)}
                      autoCapitalize="none"
                      autoCorrect={false}
                      accessibilityLabel={fieldCopy.label}
                      style={{
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: radius.md,
                        paddingHorizontal: space.sm + 2,
                        paddingVertical: compact ? 5 : 6,
                        height: compact ? 30 : 32,
                        width: compact ? 76 : 86,
                        minWidth: compact ? 76 : 86,
                        textAlign: "right",
                        ...font.small,
                        ...tabular,
                        color: colors.foreground,
                        backgroundColor: colors.surface0,
                      }}
                    />
                  ),
                });
              })}

              <View
                testID="dsh-timeline-advanced-footer"
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: space.sm,
                  paddingHorizontal: compact ? space.md : space.lg,
                  paddingVertical: compact ? 12 : 14,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 1 }}>
                  {statusBadge}
                </View>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.sm,
                    marginLeft: "auto",
                  }}
                >
                  <Button
                    colors={colors}
                    variant="secondary"
                    size="sm"
                    icon="RotateCcw"
                    label={settingsCopy.reset}
                    accessibilityLabel={settingsCopy.reset}
                    disabled={!styleCtrl.canReset}
                    onPress={() => guardAsync("settings reset", styleCtrl.reset)}
                  />
                  <Button
                    colors={colors}
                    variant="primary"
                    size="sm"
                    icon="Check"
                    label={styleCtrl.saving ? settingsCopy.saving : settingsCopy.save}
                    accessibilityLabel={settingsCopy.save}
                    loading={styleCtrl.saving}
                    disabled={!styleCtrl.canSave}
                    onPress={() => guardAsync("settings save", styleCtrl.save)}
                  />
                </View>
              </View>
            </>
          ) : null}
        </>,
        "dsh-console-timeline-card",
      )}

      {styleCtrl.status === "loading" ? (
        <Muted colors={colors}>{settingsCopy.loading}</Muted>
      ) : null}

      {styleCtrl.error !== null ? (
        <Callout colors={colors} tone="danger" icon="CircleAlert" title={styleCtrl.error} />
      ) : null}

      {saveErrorMessage !== null ? (
        <Callout colors={colors} tone="danger" icon="CircleAlert" title={saveErrorMessage} />
      ) : null}

      {feedback === null ? null : feedback.kind === "validationError" ? (
        <Callout colors={colors} tone="danger" icon="CircleAlert" title={feedback.message} />
      ) : feedback.kind === "fallbackError" && saveErrorMessage === null ? (
        <Callout
          colors={colors}
          tone="danger"
          icon="CircleAlert"
          title={feedback.action === "reset" ? settingsCopy.resetFailed : settingsCopy.saveFailed}
        />
      ) : null}
    </View>
  );
}

/** Unified Settings tab rendered inside the DSH Console. */
export function ConsoleSettingsTab({
  colors,
  host,
  compact,
  environment,
  renderEnvironment,
  pricing,
}: ConsoleSettingsTabProps) {
  const locale = useCurrentLocale();
  return (
    <View style={{ gap: compact ? space.lg : space.xl }}>
      <EnvironmentSection
        colors={colors}
        host={host}
        compact={compact}
        locale={locale}
        environment={environment}
        renderEnvironment={renderEnvironment}
      />
      <GeneralAndCostSection colors={colors} compact={compact} pricing={pricing} />
      <TimelineDisplaySection colors={colors} compact={compact} />
    </View>
  );
}
