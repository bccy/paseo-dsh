/**
 * Unified 3-tab DSH Console screen (`Usage` / `Plugins` / `Settings`).
 *
 * - Wrapped in `PluginsBoundary` so render errors never abort a release app.
 * - Top header pairs the DeepSeek whale `Avatar` with a responsive 3-tab
 *   `SegmentedControl` (inline on wide layouts, stacked full-width on compact).
 * - Supports `initialTab`, URL `params.tab`, and live `requestConsoleTab()` so
 *   Paseo Settings & Command Center open directly on Tab 3 (`settings`) even if
 *   the screen is already mounted on another tab.
 *
 * @module dsh-paseo/client/console-screen
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollView as RnScrollView, Text, View } from "react-native";
import type {
  PluginClientContext,
  PluginScreenParams,
  PluginScreenProps,
} from "@getpaseo/plugin/client";
import * as PaseoUi from "@getpaseo/plugin/client/ui";
import {
  DEFAULT_USD_TO_CNY_RATE,
  pricingGetRpc,
  pricingUpdateRpc,
  type Currency,
  type PricingState,
} from "../shared/pricing";
import { PricingDialog } from "./console-pricing";
import {
  ConsoleSettingsTab,
  type ConsoleSettingsEnvironmentProps,
  type PricingPreferencesSlot,
} from "./console-settings";
import { font, radius, space, tint, type Colors } from "./console-theme";
import { Avatar, Badge, Card, Divider, Muted, SegmentedControl } from "./console-ui";
import { ConsoleUsageTab } from "./console-usage";
import { DEEPSEEK_MARK_SVG } from "./deepseek-mark-svg";
import { PluginsBoundary, PluginsFailedCard, report } from "./dsh-plugins-guard";
import { DshPluginsContent } from "./dsh-plugins-page";
import type { Locale } from "./locale";
import { useCurrentLocale, useLocaleText } from "./use-locale";

/** Screen and sidebar contribution id for the unified DSH Console. */
export const CONSOLE_SCREEN_ID = "dsh-console";

export type ConsoleTabId = "usage" | "plugins" | "settings";

const VALID_TABS = new Set<string>(["usage", "plugins", "settings"]);

/** Parse a route param or external tab hint into a valid `ConsoleTabId`. */
export function parseConsoleTab(value: unknown): ConsoleTabId | undefined {
  if (typeof value !== "string") return undefined;
  return VALID_TABS.has(value) ? (value as ConsoleTabId) : undefined;
}

interface PendingTabRequest {
  readonly tab: ConsoleTabId;
  readonly seq: number;
}

let pendingTabRequest: PendingTabRequest | null = null;
let tabRequestSeq = 0;
const tabRequestListeners = new Set<() => void>();

/**
 * Request that the unified console switch to `tab`.
 *
 * If the primary console screen is already mounted, it switches immediately;
 * otherwise the request is held until the screen mounts (helpful if a host does
 * not preserve `openScreen` params).
 */
export function requestConsoleTab(tab: ConsoleTabId): number {
  tabRequestSeq += 1;
  pendingTabRequest = { tab, seq: tabRequestSeq };
  for (const listener of Array.from(tabRequestListeners)) {
    listener();
  }
  return tabRequestSeq;
}

function consumePendingConsoleTab(): PendingTabRequest | null {
  const current = pendingTabRequest;
  pendingTabRequest = null;
  return current;
}

function subscribeConsoleTabRequests(listener: () => void): () => void {
  tabRequestListeners.add(listener);
  return () => {
    tabRequestListeners.delete(listener);
  };
}

const uiExports = PaseoUi as Record<string, unknown>;
const HostScrollView =
  typeof uiExports["ScrollView"] === "function"
  || (typeof uiExports["ScrollView"] === "object" && uiExports["ScrollView"] !== null)
    ? PaseoUi.ScrollView
    : RnScrollView;

export interface ConsoleTabRenderContext {
  readonly theme: PluginScreenProps["theme"];
  readonly colors: Colors;
  readonly host: PluginScreenProps["host"];
  readonly layout: PluginScreenProps["layout"];
  readonly navigation: PluginScreenProps["navigation"];
  readonly compact: boolean;
  readonly width: number;
  readonly locale: Locale;
  readonly activeTab: ConsoleTabId;
  readonly setActiveTab: (tab: ConsoleTabId) => void;
}

export interface DshConsoleScreenProps
  extends Omit<PluginScreenProps, "params">,
    ConsoleSettingsEnvironmentProps {
  /** Plugin client context used by Usage analytics, Pricing dialog, and Tab 3 pricing prefs. */
  readonly client?: PluginClientContext;
  /** Route params supplied by `addScreen`; optional so `addSettingsScreen` can mount directly. */
  readonly params?: PluginScreenParams;
  /** Default tab when `params?.tab` does not specify one (default `"usage"`). */
  readonly initialTab?: ConsoleTabId;
  /**
   * Whether this instance listens to live `requestConsoleTab()` navigation pushes
   * (default `true` for the primary console screen; set `false` when embedded inside
   * Paseo Settings so it stays independent).
   */
  readonly subscribeTabRequests?: boolean;
  /** Phase 3 drop-in slot for `ConsoleUsageTab`. */
  readonly renderUsage?: (context: ConsoleTabRenderContext) => ReactNode;
  /** Integrator drop-in slot for `DshPluginsContent` once `plugins-polish` merges. */
  readonly renderPlugins?: (context: ConsoleTabRenderContext) => ReactNode;
  /** Phase 3 dual-currency & pricing modal integration props forwarded to Tab 3. */
  readonly pricing?: PricingPreferencesSlot;
}

function UsagePlaceholder({ colors, compact }: { colors: Colors; compact: boolean }) {
  const copy = useLocaleText().console.usagePlaceholder;
  const highlights = [
    { key: "heatmap", icon: "Activity", text: copy.highlights.heatmap },
    { key: "metrics", icon: "Gauge", text: copy.highlights.metrics },
    { key: "pricing", icon: "DollarSign", text: copy.highlights.pricing },
  ] as const;

  return (
    <Card colors={colors} style={{ padding: compact ? space.lg : space.xl, gap: space.md }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
        }}
      >
        <Text style={{ ...font.heading, color: colors.foreground }}>{copy.title}</Text>
        <Badge colors={colors} tone="accent" dot label={copy.badge} />
      </View>
      <Muted colors={colors}>{copy.description}</Muted>
      <Divider colors={colors} />
      <View style={{ gap: space.sm }}>
        {highlights.map((item) => (
          <View
            key={item.key}
            style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}
          >
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: radius.sm,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: tint(colors.accent, 0.12),
              }}
            >
              <PaseoUi.Icon name={item.icon} size={13} color={colors.accent} />
            </View>
            <Text style={{ ...font.small, color: colors.foreground, flex: 1 }}>{item.text}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

function DshConsoleBody({
  client,
  theme,
  host,
  layout,
  navigation,
  params,
  initialTab = "usage",
  subscribeTabRequests = true,
  renderUsage,
  renderPlugins,
  environment,
  renderEnvironment,
  pricing,
}: DshConsoleScreenProps) {
  const { colors } = theme;
  const copy = useLocaleText().console;
  const locale = useCurrentLocale();
  const [width, setWidth] = useState(0);

  // Shared dual-currency & pricing modal state across Tab 1 (Usage) and Tab 3 (Settings).
  const mountedRef = useRef(true);
  const pricingSeqRef = useRef(0);
  const [pricingState, setPricingState] = useState<PricingState | null>(null);
  const [currencyOverride, setCurrencyOverride] = useState<Currency | undefined>(undefined);
  const [pricingSaving, setPricingSaving] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingRevision, setPricingRevision] = useState(0);
  const [pricingModalOpen, setPricingModalOpen] = useState(false);
  const [pricingFocusModel, setPricingFocusModel] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!client) return;
    const seq = ++pricingSeqRef.current;
    void client
      .rpc(pricingGetRpc, {})
      .then((state) => {
        if (!mountedRef.current || seq !== pricingSeqRef.current) return;
        setPricingState(state);
        setCurrencyOverride(undefined);
        setPricingError(null);
      })
      .catch((error) => {
        report("pricing get", error);
      });
  }, [client]);

  const openPricingModal = useCallback((focusModel?: string | null) => {
    setPricingFocusModel(focusModel ?? null);
    setPricingModalOpen(true);
  }, []);

  const closePricingModal = useCallback(() => {
    setPricingModalOpen(false);
    setPricingFocusModel(null);
  }, []);

  const handleUsageCurrencyChange = useCallback((next: Currency) => {
    pricingSeqRef.current += 1;
    setCurrencyOverride(next);
    setPricingState((prev) => (prev ? { ...prev, displayCurrency: next } : prev));
    setPricingError(null);
  }, []);

  const handlePricingDialogUpdated = useCallback((next: PricingState) => {
    pricingSeqRef.current += 1;
    setPricingState(next);
    setCurrencyOverride(undefined);
    setPricingError(null);
    setPricingRevision((rev) => rev + 1);
  }, []);

  const handleSettingsCurrencyChange = useCallback(
    async (next: Currency) => {
      if (!client) return;
      const seq = ++pricingSeqRef.current;
      setPricingSaving(true);
      setPricingError(null);
      try {
        const updated = await client.rpc(pricingUpdateRpc, { displayCurrency: next });
        if (!mountedRef.current || seq !== pricingSeqRef.current) return;
        setPricingState(updated);
        setCurrencyOverride(undefined);
        setPricingRevision((rev) => rev + 1);
      } catch (error) {
        if (mountedRef.current && seq === pricingSeqRef.current) {
          setPricingError(error instanceof Error ? error.message : String(error));
        }
        throw error;
      } finally {
        if (mountedRef.current) setPricingSaving(false);
      }
    },
    [client],
  );

  const handleSettingsExchangeRateChange = useCallback(
    async (rate: number) => {
      if (!client) return;
      const seq = ++pricingSeqRef.current;
      setPricingSaving(true);
      setPricingError(null);
      try {
        const updated = await client.rpc(pricingUpdateRpc, { usdToCnyRate: rate });
        if (!mountedRef.current || seq !== pricingSeqRef.current) return;
        setPricingState(updated);
        setCurrencyOverride(undefined);
        setPricingRevision((rev) => rev + 1);
      } catch (error) {
        if (mountedRef.current && seq === pricingSeqRef.current) {
          setPricingError(error instanceof Error ? error.message : String(error));
        }
        throw error;
      } finally {
        if (mountedRef.current) setPricingSaving(false);
      }
    },
    [client],
  );

  const effectiveDisplayCurrency = currencyOverride ?? pricingState?.displayCurrency;
  const resolvedPricingSlot = useMemo<PricingPreferencesSlot | undefined>(() => {
    if (pricing) return pricing;
    if (!client) return undefined;
    return {
      currency: effectiveDisplayCurrency ?? "USD",
      usdToCnyRate: pricingState?.usdToCnyRate ?? DEFAULT_USD_TO_CNY_RATE,
      hasCustomOverrides: pricingState?.hasCustomOverrides ?? false,
      saving: pricingSaving,
      error: pricingError,
      onChangeCurrency: handleSettingsCurrencyChange,
      onChangeExchangeRate: handleSettingsExchangeRateChange,
      onOpenPricingModal: () => openPricingModal(null),
    };
  }, [
    pricing,
    client,
    effectiveDisplayCurrency,
    pricingState?.usdToCnyRate,
    pricingState?.hasCustomOverrides,
    pricingSaving,
    pricingError,
    handleSettingsCurrencyChange,
    handleSettingsExchangeRateChange,
    openPricingModal,
  ]);

  const paramTab = parseConsoleTab(params?.tab);
  const lastParamTabRef = useRef<ConsoleTabId | undefined>(paramTab);
  const lastConsumedSeqRef = useRef(0);

  const [activeTab, setActiveTab] = useState<ConsoleTabId>(() => {
    if (subscribeTabRequests) {
      const pending = consumePendingConsoleTab();
      if (pending) {
        lastConsumedSeqRef.current = pending.seq;
        return paramTab ?? pending.tab;
      }
    }
    return paramTab ?? initialTab;
  });

  useEffect(() => {
    if (paramTab !== undefined && paramTab !== lastParamTabRef.current) {
      lastParamTabRef.current = paramTab;
      setActiveTab(paramTab);
    } else if (paramTab === undefined) {
      lastParamTabRef.current = undefined;
    }
  }, [paramTab]);

  useEffect(() => {
    if (!subscribeTabRequests) return;
    const consumeIfNewer = () => {
      const pending = consumePendingConsoleTab();
      if (pending && pending.seq > lastConsumedSeqRef.current) {
        lastConsumedSeqRef.current = pending.seq;
        setActiveTab(pending.tab);
      }
    };
    consumeIfNewer();
    return subscribeConsoleTabRequests(consumeIfNewer);
  }, [subscribeTabRequests]);

  const compact = layout.compact || (width > 0 && width < 560);
  const narrowHeader = compact || (width > 0 && width < 680);
  const horizontalPadding = compact ? space.lg : space.xxl;
  const contentWidth = width > 0 ? Math.min(Math.max(width - horizontalPadding * 2, 0), 980) : 0;

  const tabOptions = [
    { value: "usage" as const, label: copy.tabs.usage, icon: "Activity" },
    { value: "plugins" as const, label: copy.tabs.plugins, icon: "Puzzle" },
    { value: "settings" as const, label: copy.tabs.settings, icon: "Wrench" },
  ];

  const tabContext: ConsoleTabRenderContext = {
    theme,
    colors,
    host,
    layout,
    navigation,
    compact,
    width: contentWidth,
    locale,
    activeTab,
    setActiveTab,
  };

  return (
    <View
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      onLayout={(event) => {
        const nextWidth = event.nativeEvent.layout.width;
        setWidth((prev) => (Math.abs(prev - nextWidth) < 1 ? prev : nextWidth));
      }}
    >
      {/* Fixed responsive console header + 3-tab SegmentedControl */}
      <View
        style={{
          paddingHorizontal: horizontalPadding,
          paddingVertical: compact ? space.md : space.lg,
          alignItems: "center",
        }}
      >
        <View
          style={{
            width: contentWidth || "100%",
            maxWidth: 980,
            flexDirection: narrowHeader ? "column" : "row",
            alignItems: narrowHeader ? "stretch" : "center",
            justifyContent: "space-between",
            gap: compact ? space.md : space.lg,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, flex: narrowHeader ? undefined : 1, minWidth: 0 }}>
            <Avatar
              colors={colors}
              label="DSH"
              logo={DEEPSEEK_MARK_SVG}
              size={compact ? 36 : 42}
            />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text
                accessibilityRole="header"
                numberOfLines={1}
                style={{
                  ...font.title,
                  fontSize: compact ? 18 : font.title.fontSize,
                  lineHeight: compact ? 24 : font.title.lineHeight,
                  color: colors.foreground,
                }}
              >
                {copy.title}
              </Text>
              {compact ? null : (
                <Muted colors={colors} small numberOfLines={1}>
                  {copy.subtitle}
                </Muted>
              )}
            </View>
          </View>

          <SegmentedControl<ConsoleTabId>
            colors={colors}
            value={activeTab}
            options={tabOptions}
            onChange={setActiveTab}
            size={compact ? "sm" : "md"}
            fullWidth={narrowHeader}
            testID="dsh-console-tabs"
          />
        </View>
      </View>

      <Divider colors={colors} />

      {/* Active tab body — single HostScrollView shared by all 3 tabs */}
      <HostScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: horizontalPadding,
          alignItems: "center",
        }}
      >
        <View style={{ width: contentWidth || "100%", maxWidth: 980 }}>
          {activeTab === "usage" ? (
            renderUsage ? (
              renderUsage(tabContext)
            ) : client ? (
              <ConsoleUsageTab
                client={client}
                colors={colors}
                displayCurrency={effectiveDisplayCurrency}
                pricingRevision={pricingRevision}
                onCurrencyChange={handleUsageCurrencyChange}
                onOpenPricing={openPricingModal}
              />
            ) : (
              <UsagePlaceholder colors={colors} compact={compact} />
            )
          ) : activeTab === "plugins" ? (
            renderPlugins ? (
              renderPlugins(tabContext)
            ) : (
              <DshPluginsContent
                colors={colors}
                host={host}
                layout={layout}
                embedded
              />
            )
          ) : (
            <ConsoleSettingsTab
              colors={colors}
              host={host}
              compact={compact}
              environment={environment}
              renderEnvironment={renderEnvironment}
              pricing={resolvedPricingSlot}
            />
          )}
        </View>
      </HostScrollView>

      {client ? (
        <PricingDialog
          visible={pricingModalOpen}
          onClose={closePricingModal}
          client={client}
          colors={colors}
          focusModel={pricingFocusModel}
          onUpdated={handlePricingDialogUpdated}
        />
      ) : null}
    </View>
  );
}

/** Unified 3-tab DSH Console screen wrapped in `PluginsBoundary`. */
export function DshConsoleScreen(props: DshConsoleScreenProps) {
  const copy = useLocaleText().console;
  return (
    <PluginsBoundary
      fallback={(
        <PluginsFailedCard
          message={copy.renderFailed}
          color={props.theme.colors.statusDanger}
          background={props.theme.colors.surface0}
        />
      )}
    >
      <DshConsoleBody {...props} />
    </PluginsBoundary>
  );
}
