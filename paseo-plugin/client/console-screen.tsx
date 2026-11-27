/**
 * Unified 4-tab Console screen (`Usage` / `Antigravity` / `Plugins` / `Settings`).
 *
 * - Wrapped in `PluginsBoundary` so render errors never abort a release app.
 * - Top header pairs the DeepSeek whale `Avatar` with a responsive
 *   `SegmentedControl` on wide layouts, and omits the redundant title row on
 *   compact mobile where Paseo's native navigation bar already renders the title.
 * - Supports bidirectional CLI auto-detection via `capabilities`:
 *   - `usage` when `dshVisible || antigravityVisible`
 *   - `antigravity` only when `antigravityVisible`
 *   - `plugins` only when `dshVisible`
 *   - `settings` always visible (default when neither CLI is detected)
 * - Supports `initialTab`, URL `params.tab`, and live `requestConsoleTab()` so
 *   external navigation (Settings, Command Center, Quota footer) opens directly
 *   on the requested tab even if the screen is already mounted.
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
import type { CapabilitiesSnapshot } from "../shared/capabilities";
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
import { PluginsBoundary, PluginsFailedCard, formatBoundaryError, report } from "./dsh-plugins-guard";
import { DshPluginsContent } from "./dsh-plugins-page";
import type { Locale } from "./locale";
import { useCurrentLocale, useLocaleText } from "./use-locale";

/** Screen and sidebar contribution id for the unified Console. */
export const CONSOLE_SCREEN_ID = "dsh-console";

export type ConsoleTabId = "usage" | "antigravity" | "plugins" | "settings";

const VALID_TABS = new Set<string>(["usage", "antigravity", "plugins", "settings"]);

/** Parse a route param or external tab hint into a valid `ConsoleTabId`. */
export function parseConsoleTab(value: unknown): ConsoleTabId | undefined {
  if (typeof value !== "string") return undefined;
  return VALID_TABS.has(value) ? (value as ConsoleTabId) : undefined;
}

/**
 * Compute visible console tabs from detected host capabilities.
 *
 * When `capabilities` is still loading (`undefined`), defaults safely to the
 * DSH baseline (`usage`, `plugins`, `settings`) so the console never flashes
 * broken Antigravity UI before host detection resolves.
 */
export function visibleConsoleTabs(capabilities?: CapabilitiesSnapshot): ConsoleTabId[] {
  const dshVisible = capabilities ? capabilities.dshVisible : true;
  const antigravityVisible = capabilities ? capabilities.antigravityVisible : false;
  const tabs: ConsoleTabId[] = [];
  if (dshVisible || antigravityVisible) tabs.push("usage");
  if (antigravityVisible) tabs.push("antigravity");
  if (dshVisible) tabs.push("plugins");
  tabs.push("settings");
  return tabs;
}

/** Default console tab for a given host capability snapshot. */
export function defaultConsoleTab(capabilities?: CapabilitiesSnapshot): ConsoleTabId {
  const tabs = visibleConsoleTabs(capabilities);
  return tabs[0] ?? "settings";
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
  /** Plugin client context used by Usage analytics, Pricing dialog, and Tab 4 pricing prefs. */
  readonly client?: PluginClientContext;
  /** Live host CLI/data capability snapshot driving tab visibility and usage source defaults. */
  readonly capabilities?: CapabilitiesSnapshot;
  /** Route params supplied by `addScreen`; optional so `addSettingsScreen` can mount directly. */
  readonly params?: PluginScreenParams;
  /** Default tab when `params?.tab` does not specify one (default derived from `capabilities`). */
  readonly initialTab?: ConsoleTabId;
  /**
   * Whether this instance listens to live `requestConsoleTab()` navigation pushes
   * (default `true` for the primary console screen; set `false` when embedded inside
   * Paseo Settings so it stays independent).
   */
  readonly subscribeTabRequests?: boolean;
  /** Drop-in slot for `ConsoleUsageTab`. */
  readonly renderUsage?: (context: ConsoleTabRenderContext) => ReactNode;
  /** Drop-in slot for `AntigravityTab`. */
  readonly renderAntigravity?: (context: ConsoleTabRenderContext) => ReactNode;
  /** Drop-in slot for `DshPluginsContent`. */
  readonly renderPlugins?: (context: ConsoleTabRenderContext) => ReactNode;
  /** Dual-currency & pricing modal integration props forwarded to Settings tab. */
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
  capabilities,
  theme,
  host,
  layout,
  navigation,
  params,
  initialTab,
  subscribeTabRequests = true,
  renderUsage,
  renderAntigravity,
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

  const dshVisible = capabilities ? capabilities.dshVisible : true;
  const antigravityVisible = capabilities ? capabilities.antigravityVisible : false;
  const visibleTabs = useMemo(() => visibleConsoleTabs(capabilities), [capabilities]);
  const fallbackTab = visibleTabs[0] ?? "settings";
  const resolvedInitialTab = initialTab ?? fallbackTab;

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
    return paramTab ?? resolvedInitialTab;
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

  // Once capabilities have resolved, coerce an unavailable tab to the first
  // visible tab (e.g. `"settings"` when neither CLI is installed, or `"usage"`
  // if `"plugins"` was requested on an Antigravity-only host).
  useEffect(() => {
    if (capabilities === undefined) return;
    if (!visibleTabs.includes(activeTab)) {
      setActiveTab(fallbackTab);
    }
  }, [capabilities, visibleTabs, activeTab, fallbackTab]);

  const effectiveTab: ConsoleTabId =
    capabilities !== undefined && !visibleTabs.includes(activeTab) ? fallbackTab : activeTab;

  const compact = layout.compact || (width > 0 && width < 560);
  const narrowHeader = compact || (width > 0 && width < 680);
  const horizontalPadding = compact ? space.lg : space.xxl;
  const contentWidth = width > 0 ? Math.min(Math.max(width - horizontalPadding * 2, 0), 980) : 0;

  const allTabOptions: ReadonlyArray<{ value: ConsoleTabId; label: string; icon: string }> = [
    { value: "usage", label: copy.tabs.usage, icon: "Activity" },
    { value: "antigravity", label: copy.tabs.antigravity, icon: "Sparkles" },
    { value: "plugins", label: copy.tabs.plugins, icon: "Puzzle" },
    { value: "settings", label: copy.tabs.settings, icon: "Wrench" },
  ];
  const tabOptions = allTabOptions.filter((option) => visibleTabs.includes(option.value));

  const tabContext: ConsoleTabRenderContext = {
    theme,
    colors,
    host,
    layout,
    navigation,
    compact,
    width: contentWidth,
    locale,
    activeTab: effectiveTab,
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
      {/* Fixed responsive console header + SegmentedControl */}
      <View
        style={{
          paddingHorizontal: horizontalPadding,
          paddingTop: compact ? space.xs + 2 : space.lg,
          paddingBottom: compact ? space.sm + 2 : space.lg,
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
            gap: compact ? 0 : space.lg,
          }}
        >
          {compact ? null : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, flex: narrowHeader ? undefined : 1, minWidth: 0 }}>
              <Avatar
                colors={colors}
                label="DSH"
                logo={DEEPSEEK_MARK_SVG}
                size={42}
              />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text
                  accessibilityRole="header"
                  numberOfLines={1}
                  style={{
                    ...font.title,
                    color: colors.foreground,
                  }}
                >
                  {copy.title}
                </Text>
                <Muted colors={colors} small numberOfLines={1}>
                  {copy.subtitle}
                </Muted>
              </View>
            </View>
          )}

          <SegmentedControl<ConsoleTabId>
            colors={colors}
            value={effectiveTab}
            options={tabOptions}
            onChange={setActiveTab}
            size={compact ? "sm" : "md"}
            variant="accent"
            fullWidth={narrowHeader}
            testID="dsh-console-tabs"
          />
        </View>
      </View>

      <Divider colors={colors} />

      {/* Active tab body — single HostScrollView shared by all tabs */}
      <HostScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: compact ? space.md : space.xl,
          paddingBottom: compact ? space.xl : horizontalPadding,
          alignItems: "center",
        }}
      >
        <View style={{ width: contentWidth || "100%", maxWidth: 980 }}>
          {effectiveTab === "usage" ? (
            renderUsage ? (
              renderUsage(tabContext)
            ) : client ? (
              <ConsoleUsageTab
                client={client}
                colors={colors}
                capabilities={capabilities}
                displayCurrency={effectiveDisplayCurrency}
                pricingRevision={pricingRevision}
                onCurrencyChange={handleUsageCurrencyChange}
                onOpenPricing={openPricingModal}
              />
            ) : (
              <UsagePlaceholder colors={colors} compact={compact} />
            )
          ) : effectiveTab === "antigravity" ? (
            renderAntigravity ? (
              renderAntigravity(tabContext)
            ) : (
              <Card colors={colors} style={{ padding: compact ? space.lg : space.xl }}>
                <Muted colors={colors}>{copy.antigravityUnavailable}</Muted>
              </Card>
            )
          ) : effectiveTab === "plugins" ? (
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
              dshVisible={dshVisible}
              antigravityVisible={antigravityVisible}
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

/** Unified 4-tab Console screen wrapped in `PluginsBoundary`. */
export function DshConsoleScreen(props: DshConsoleScreenProps) {
  const copy = useLocaleText().console;
  return (
    <PluginsBoundary
      fallback={(error) => (
        <PluginsFailedCard
          message={copy.renderFailed}
          detail={formatBoundaryError(error)}
          detailColor={props.theme.colors.foregroundMuted}
          color={props.theme.colors.statusDanger}
          background={props.theme.colors.surface0}
        />
      )}
    >
      <DshConsoleBody {...props} />
    </PluginsBoundary>
  );
}
