/**
 * Environment & Route Overview + On-Demand Full Doctor Diagnostics section
 * for Tab 3 ("Settings") of the unified DSH Console.
 *
 * - Mounts fast: calls `dsh.diagnostics.overview` (`diagnosticsOverviewRpc`)
 *   automatically on mount (read-only file inspection + lightweight version
 *   cache; never spawns slow subprocesses).
 * - On-demand full doctor: calls `dsh.diagnostics.run-doctor`
 *   (`diagnosticsRunDoctorRpc`) only when explicitly triggered by the user,
 *   guarded by a synchronous UI single-flight lock against duplicate taps.
 * - Host-native `SettingsCard` / `SettingsRow` on Paseo >= 0.17 with graceful
 *   fallback to `Card` + responsive rows on older hosts (< 0.17).
 * - Pure React Native + Paseo plugin UI kit: zero new dependencies, zero
 *   browser-only APIs, Hermes-safe, dark/light theme adaptive, narrow-screen
 *   responsive, and fully bilingual (`zh-CN` / `en`) via `useCurrentLocale()`.
 *
 * @module dsh-paseo/client/console-diagnostics
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as PaseoUi from "@getpaseo/plugin/client/ui";
import type { SettingsRowProps } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import {
  diagnosticsOverviewRpc,
  diagnosticsRunDoctorRpc,
  type BridgeStatus,
  type CredentialsStatus,
  type DiagnosticsOverview,
  type DoctorCheckCategory,
  type DoctorCheckItem,
  type DoctorCheckLevel,
  type DoctorReport,
  type RedactedProviderInfo,
  type RouteStatus,
} from "../shared/diagnostics";
import { clockTime, duration, integer } from "./console-format";
import { font, mono, radius, space, tabular, tint, toneColor, type Colors, type Tone } from "./console-theme";
import { Badge, Button, Callout, Card, Divider, Muted } from "./console-ui";
import { report } from "./dsh-plugins-guard";
import type { Locale } from "./locale";
import { useCurrentLocale } from "./use-locale";

export interface ConsoleDiagnosticsSectionProps {
  client: PluginClientContext;
  colors: Colors;
  /** Optional layout hint; when omitted, narrow screens (<560px) are detected via `onLayout`. */
  compact?: boolean;
  testID?: string;
}

const COMPACT_BREAKPOINT = 560;
const INITIAL_VISIBLE_PROVIDERS = 3;
const INITIAL_VISIBLE_MODELS = 4;

interface DiagnosticsCopy {
  readonly overviewTitle: string;
  readonly overviewSubtitle: string;
  readonly refreshOverview: string;
  readonly refreshing: string;
  readonly updatedAt: (time: string) => string;
  readonly loadingOverview: string;
  readonly overviewFailedTitle: string;
  readonly overviewFailedFallback: string;
  readonly retry: string;
  readonly statusHealthy: string;
  readonly statusAttention: string;
  readonly dshCliLabel: string;
  readonly dshNotFound: string;
  readonly dshVersionUnknown: string;
  readonly dshMinVersionError: (min: string) => string;
  readonly pluginVersionTag: (version: string) => string;
  readonly profileLabel: string;
  readonly profileEnvTag: string;
  readonly profileMissing: string;
  readonly profileInvalid: string;
  readonly profileReady: string;
  readonly bundleCount: (count: string) => string;
  readonly bridgeLabel: string;
  readonly bridgeStatus: Readonly<Record<BridgeStatus, string>>;
  readonly bridgeFilesCount: (present: string, expected: string) => string;
  readonly bridgeMissingFiles: (names: string, extraCount: number) => string;
  readonly routeLabel: string;
  readonly routeStatus: Readonly<Record<RouteStatus, string>>;
  readonly routeReasoning: (effort: string) => string;
  readonly providersLabel: string;
  readonly providersNone: string;
  readonly providersSummary: (providers: string, models: string) => string;
  readonly defaultTag: string;
  readonly providerNoModels: string;
  readonly providerKeyReady: (refName: string) => string;
  readonly providerKeyMissing: (refName: string) => string;
  readonly providerKeyRef: (refName: string) => string;
  readonly showMoreModels: (count: string) => string;
  readonly showFewerModels: string;
  readonly showAllProviders: (count: string) => string;
  readonly showFewerProviders: string;
  readonly credentialsLabel: string;
  readonly credentialsStatus: Readonly<Record<CredentialsStatus, string>>;
  readonly credentialsMode: (mode: string) => string;
  readonly credentialsOwnerOnly: string;
  readonly credentialsGroupOtherReadable: string;
  readonly credentialsRefsProgress: (ready: string, total: string) => string;
  readonly credentialsLegacyNote: string;
  readonly providerDetailsHeading: string;
  readonly credentialRefsHeading: string;
  readonly doctorTitle: string;
  readonly doctorSubtitleIdle: string;
  readonly doctorRunSummary: (time: string, elapsed: string) => string;
  readonly doctorSharedRunNote: string;
  readonly runFullDiagnostics: string;
  readonly runningDiagnostics: string;
  readonly doctorRunningHint: string;
  readonly doctorIdleHint: string;
  readonly levelLabel: Readonly<Record<DoctorCheckLevel, string>>;
  readonly categoryLabel: Readonly<Record<DoctorCheckCategory, string>>;
  readonly summaryOk: (count: string) => string;
  readonly summaryWarn: (count: string) => string;
  readonly summaryFail: (count: string) => string;
  readonly summaryTimedOut: string;
  readonly doctorAllPassedTitle: (total: string) => string;
  readonly doctorAllPassedBody: string;
  readonly doctorWarnTitle: (count: string) => string;
  readonly doctorWarnBody: string;
  readonly doctorFailTitle: (count: string) => string;
  readonly doctorTimeoutTitle: string;
  readonly doctorErrorTitle: string;
  readonly doctorRpcErrorFallback: string;
  readonly doctorRemediationIntro: string;
  readonly doctorTimeoutFallbackHint: (profile: string) => string;
  readonly doctorRpcFallbackHint: string;
  readonly recheck: string;
}

const COPY: Readonly<Record<Locale, DiagnosticsCopy>> = {
  en: {
    overviewTitle: "Environment & Route Overview",
    overviewSubtitle: "Instant read-only snapshot of your local DSH installation",
    refreshOverview: "Refresh",
    refreshing: "Refreshing...",
    updatedAt: (time) => `Updated ${time}`,
    loadingOverview: "Loading environment overview...",
    overviewFailedTitle: "Could not load environment overview",
    overviewFailedFallback: "The diagnostics overview request failed.",
    retry: "Retry",
    statusHealthy: "Ready",
    statusAttention: "Needs attention",
    dshCliLabel: "DSH CLI",
    dshNotFound: "Not found",
    dshVersionUnknown: "Version unknown",
    dshMinVersionError: (min) => `Requires DSH >= ${min}`,
    pluginVersionTag: (version) => `Plugin v${version}`,
    profileLabel: "DSH Profile",
    profileEnvTag: "from DSH_PASEO_PROFILE",
    profileMissing: "Missing",
    profileInvalid: "Invalid",
    profileReady: "Ready",
    bundleCount: (count) => `${count} bundles`,
    bridgeLabel: "Bridge Bundle",
    bridgeStatus: {
      provisioned: "OK · Provisioned",
      shadowed: "Warn · Shadowed",
      incomplete: "Fail · Incomplete",
      missing: "Fail · Missing",
      unverified: "Fail · Unverified",
    },
    bridgeFilesCount: (present, expected) => `${present}/${expected} files`,
    bridgeMissingFiles: (names, extra) =>
      extra > 0 ? `Missing: ${names} (+${extra} more)` : `Missing: ${names}`,
    routeLabel: "Default Route",
    routeStatus: {
      configured: "Configured",
      "missing-patch": "Missing patch",
      "invalid-yaml": "Invalid YAML",
      "invalid-patch": "Invalid patch",
      "missing-default": "No default route",
      disabled: "Route disabled",
      incomplete: "Incomplete route",
      "unknown-provider": "Unknown provider",
      unverified: "Unverified",
    },
    routeReasoning: (effort) => `Reasoning: ${effort}`,
    providersLabel: "Providers & Models",
    providersNone: "None configured",
    providersSummary: (providers, models) => `${providers} providers · ${models} models`,
    defaultTag: "Default",
    providerNoModels: "No models listed",
    providerKeyReady: (refName) => `Key ref ${refName} ready`,
    providerKeyMissing: (refName) => `Key ref ${refName} missing`,
    providerKeyRef: (refName) => `Key ref ${refName}`,
    showMoreModels: (count) => `+${count} more`,
    showFewerModels: "Show less",
    showAllProviders: (count) => `Show all ${count} providers`,
    showFewerProviders: "Show fewer",
    credentialsLabel: "Credentials",
    credentialsStatus: {
      ready: "Ready",
      "no-refs-needed": "No refs needed",
      unverified: "Unverified",
      "missing-file": "Missing file",
      unreadable: "Unreadable",
      "bad-permissions": "Bad permissions",
      "invalid-yaml": "Invalid YAML",
      "invalid-contract": "Invalid format",
      "missing-refs": "Missing keys",
    },
    credentialsMode: (mode) => `mode ${mode}`,
    credentialsOwnerOnly: "owner-only",
    credentialsGroupOtherReadable: "readable by others (run chmod 600)",
    credentialsRefsProgress: (ready, total) => `${ready}/${total} refs ready`,
    credentialsLegacyNote: "Legacy flat layout (auto-migrated on next DSH start)",
    providerDetailsHeading: "Configured providers (redacted)",
    credentialRefsHeading: "Referenced credential keys",
    doctorTitle: "Full Doctor Diagnostics",
    doctorSubtitleIdle: "Runs CLI, plugin, profile composition, and credential checks on demand",
    doctorRunSummary: (time, elapsed) => `Checked at ${time} (${elapsed})`,
    doctorSharedRunNote: "joined in-flight run",
    runFullDiagnostics: "Run Full Diagnostics",
    runningDiagnostics: "Running...",
    doctorRunningHint: "Running full diagnostics including DSH config composition (up to 20s)...",
    doctorIdleHint:
      "Click \"Run Full Diagnostics\" to verify CLI versions, Paseo plugin status, DSH profile composition (--dump-config), and credential refs.",
    levelLabel: {
      ok: "OK",
      warn: "WARN",
      fail: "FAIL",
    },
    categoryLabel: {
      cli: "CLI",
      plugin: "Plugin",
      profile: "Profile",
      bridge: "Bridge",
      route: "Route",
      composition: "Composition",
      credentials: "Credentials",
    },
    summaryOk: (count) => `${count} passed`,
    summaryWarn: (count) => `${count} warnings`,
    summaryFail: (count) => `${count} failed`,
    summaryTimedOut: "Timed out",
    doctorAllPassedTitle: (total) => `All ${total} checks passed`,
    doctorAllPassedBody: "Your DSH environment, bridge bundle, model route, and credentials are ready.",
    doctorWarnTitle: (count) => `${count} non-blocking warning(s)`,
    doctorWarnBody: "No blocking issues were found, but review the warnings above before relying on this setup.",
    doctorFailTitle: (count) => `Found ${count} blocking issue(s)`,
    doctorTimeoutTitle: "Full diagnostics timed out",
    doctorErrorTitle: "Full diagnostics could not complete",
    doctorRpcErrorFallback: "The doctor RPC request failed or timed out.",
    doctorRemediationIntro: "Recommended steps to resolve:",
    doctorTimeoutFallbackHint: (profile) =>
      `Run "dsh --profile ${profile} --dump-config" in a terminal to see why composition stalled, then re-check.`,
    doctorRpcFallbackHint:
      'Confirm the Paseo daemon is running and dsh-paseo is enabled, or run "node <plugin-dir>/bin/paseo-dsh.mjs doctor" in a terminal.',
    recheck: "Re-check",
  },
  "zh-CN": {
    overviewTitle: "环境与路由概览",
    overviewSubtitle: "只读实时快照，不启动耗时子进程",
    refreshOverview: "刷新",
    refreshing: "刷新中...",
    updatedAt: (time) => `更新于 ${time}`,
    loadingOverview: "正在读取环境概览...",
    overviewFailedTitle: "无法读取环境概览",
    overviewFailedFallback: "环境概览请求失败。",
    retry: "重试",
    statusHealthy: "就绪",
    statusAttention: "需关注",
    dshCliLabel: "DSH CLI",
    dshNotFound: "未找到",
    dshVersionUnknown: "版本未知",
    dshMinVersionError: (min) => `需要 DSH >= ${min}`,
    pluginVersionTag: (version) => `插件 v${version}`,
    profileLabel: "DSH 配置 (Profile)",
    profileEnvTag: "来自 DSH_PASEO_PROFILE",
    profileMissing: "缺失",
    profileInvalid: "异常",
    profileReady: "就绪",
    bundleCount: (count) => `${count} 个扩展包`,
    bridgeLabel: "桥接包状态",
    bridgeStatus: {
      provisioned: "正常 · 已就绪",
      shadowed: "警告 · 旧副本遮蔽",
      incomplete: "失败 · 文件不完整",
      missing: "失败 · 缺失",
      unverified: "失败 · 未校验",
    },
    bridgeFilesCount: (present, expected) => `${present}/${expected} 个文件`,
    bridgeMissingFiles: (names, extra) =>
      extra > 0 ? `缺少：${names}（另缺 ${extra} 项）` : `缺少：${names}`,
    routeLabel: "默认模型路由",
    routeStatus: {
      configured: "已配置",
      "missing-patch": "缺少补丁文件",
      "invalid-yaml": "YAML 语法错误",
      "invalid-patch": "补丁格式无效",
      "missing-default": "未设默认路由",
      disabled: "路由已禁用",
      incomplete: "路由不完整",
      "unknown-provider": "提供方未定义",
      unverified: "未校验",
    },
    routeReasoning: (effort) => `思考档位：${effort}`,
    providersLabel: "提供方与模型",
    providersNone: "未配置",
    providersSummary: (providers, models) => `${providers} 个提供方 · ${models} 个模型`,
    defaultTag: "默认",
    providerNoModels: "未列出模型",
    providerKeyReady: (refName) => `密钥引用 ${refName} 已就绪`,
    providerKeyMissing: (refName) => `缺少密钥引用 ${refName}`,
    providerKeyRef: (refName) => `密钥引用 ${refName}`,
    showMoreModels: (count) => `+${count} 个更多`,
    showFewerModels: "收起",
    showAllProviders: (count) => `展开全部 ${count} 个提供方`,
    showFewerProviders: "收起",
    credentialsLabel: "凭据文件与引用",
    credentialsStatus: {
      ready: "就绪",
      "no-refs-needed": "无需引用",
      unverified: "未校验",
      "missing-file": "文件缺失",
      unreadable: "无法读取",
      "bad-permissions": "权限过宽",
      "invalid-yaml": "YAML 无效",
      "invalid-contract": "格式不符",
      "missing-refs": "缺少密钥",
    },
    credentialsMode: (mode) => `权限 ${mode}`,
    credentialsOwnerOnly: "仅当前用户可读",
    credentialsGroupOtherReadable: "其他用户可读（需 chmod 600）",
    credentialsRefsProgress: (ready, total) => `${ready}/${total} 项引用就绪`,
    credentialsLegacyNote: "旧版扁平格式（下次启动 DSH 时自动迁移）",
    providerDetailsHeading: "已配置提供方（脱敏摘要）",
    credentialRefsHeading: "已引用的凭据键名",
    doctorTitle: "完整 Doctor 诊断",
    doctorSubtitleIdle: "按需检查 CLI、插件状态、配置组合与凭据完整性",
    doctorRunSummary: (time, elapsed) => `检查于 ${time}（耗时 ${elapsed}）`,
    doctorSharedRunNote: "复用进行中的检查",
    runFullDiagnostics: "运行完整诊断",
    runningDiagnostics: "诊断中...",
    doctorRunningHint: "正在执行完整诊断（含 DSH 配置组合检查，最长约 20 秒）...",
    doctorIdleHint:
      "点击「运行完整诊断」按需验证 CLI 版本、Paseo 插件状态、DSH 配置组合（--dump-config）与凭据引用。",
    levelLabel: {
      ok: "通过",
      warn: "警告",
      fail: "失败",
    },
    categoryLabel: {
      cli: "CLI",
      plugin: "插件",
      profile: "配置",
      bridge: "桥接",
      route: "路由",
      composition: "组合",
      credentials: "凭据",
    },
    summaryOk: (count) => `${count} 项通过`,
    summaryWarn: (count) => `${count} 项警告`,
    summaryFail: (count) => `${count} 项失败`,
    summaryTimedOut: "已超时",
    doctorAllPassedTitle: (total) => `全部 ${total} 项检查通过`,
    doctorAllPassedBody: "当前 DSH 环境、桥接包、默认路由与凭据均已就绪。",
    doctorWarnTitle: (count) => `发现 ${count} 项非阻塞警告`,
    doctorWarnBody: "未发现阻塞问题，但建议先确认上述警告项再投入使用。",
    doctorFailTitle: (count) => `发现 ${count} 项阻塞问题`,
    doctorTimeoutTitle: "完整诊断超时",
    doctorErrorTitle: "完整诊断未能完成",
    doctorRpcErrorFallback: "诊断请求失败或超时。",
    doctorRemediationIntro: "建议按以下步骤修复：",
    doctorTimeoutFallbackHint: (profile) =>
      `请在终端运行 "dsh --profile ${profile} --dump-config" 排查卡住原因，修复后重新检查。`,
    doctorRpcFallbackHint:
      '请确认 Paseo daemon 正在运行且 dsh-paseo 已启用，或在终端运行 "node <plugin-dir>/bin/paseo-dsh.mjs doctor" 查看完整输出。',
    recheck: "重新检查",
  },
};

function isHostComponent(value: unknown): boolean {
  return typeof value === "function" || (typeof value === "object" && value !== null);
}

const paseoUiExports = PaseoUi as Record<string, unknown>;

function HostSettingsCard({
  colors,
  children,
  testID,
}: {
  colors: Colors;
  children: ReactNode;
  testID?: string;
}) {
  const SettingsCardComp = paseoUiExports["SettingsCard"] as
    | ComponentType<{ children: ReactNode; testID?: string }>
    | undefined;
  if (isHostComponent(SettingsCardComp) && SettingsCardComp) {
    return <SettingsCardComp testID={testID}>{children}</SettingsCardComp>;
  }
  return (
    <Card colors={colors} testID={testID} style={{ padding: space.lg, gap: space.md }}>
      {children}
    </Card>
  );
}

function HostSettingsRow({
  colors,
  label,
  hint,
  error,
  compact,
  children,
  testID,
}: SettingsRowProps & {
  colors: Colors;
  compact: boolean;
}) {
  const SettingsRowComp = paseoUiExports["SettingsRow"] as ComponentType<SettingsRowProps> | undefined;
  if (isHostComponent(SettingsRowComp) && SettingsRowComp) {
    return (
      <SettingsRowComp label={label} hint={hint} error={error} testID={testID}>
        {children}
      </SettingsRowComp>
    );
  }
  return (
    <View testID={testID} style={{ gap: space.xs }}>
      <View
        style={{
          flexDirection: compact ? "column" : "row",
          alignItems: compact ? "flex-start" : "center",
          justifyContent: "space-between",
          gap: space.sm,
        }}
      >
        <View style={{ flex: compact ? undefined : 1, minWidth: 0, gap: space.xxs }}>
          <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>{label}</Text>
          {hint ? (
            <Muted colors={colors} small>
              {hint}
            </Muted>
          ) : null}
        </View>
        {children ? (
          <View
            style={{
              flexShrink: compact ? 1 : 0,
              maxWidth: compact ? "100%" : "58%",
              alignItems: compact ? "flex-start" : "flex-end",
            }}
          >
            {children}
          </View>
        ) : null}
      </View>
      {error ? (
        <Text style={{ ...font.caption, color: colors.statusDanger }}>{error}</Text>
      ) : null}
    </View>
  );
}

function formatVersionBadge(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d+\.\d+/.test(trimmed)) return `v${trimmed}`;
  return trimmed;
}

function bridgeStatusTone(status: BridgeStatus): Tone {
  switch (status) {
    case "provisioned":
      return "success";
    case "shadowed":
      return "warning";
    default:
      return "danger";
  }
}

function routeStatusTone(status: RouteStatus): Tone {
  if (status === "configured") return "success";
  if (status === "unverified") return "warning";
  return "danger";
}

function credentialsStatusTone(status: CredentialsStatus): Tone {
  if (status === "ready") return "success";
  if (status === "no-refs-needed") return "neutral";
  if (status === "unverified") return "warning";
  return "danger";
}

function checkLevelTone(level: DoctorCheckLevel): Tone {
  if (level === "ok") return "success";
  if (level === "warn") return "warning";
  return "danger";
}

function errorMessageOf(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const trimmed = error.message.trim();
    if (trimmed !== "") return trimmed;
  } else if (typeof error === "string" && error.trim() !== "") {
    return error.trim();
  }
  return fallback;
}

function collectRemediationSteps(
  doctorReport: DoctorReport | null,
  doctorError: string | null,
  profileName: string | undefined,
  copy: DiagnosticsCopy,
): string[] {
  const steps: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (raw: string | undefined) => {
    if (!raw) return;
    const cleaned = raw.trim();
    if (cleaned === "" || seen.has(cleaned)) return;
    seen.add(cleaned);
    steps.push(cleaned);
  };

  if (doctorReport) {
    for (const item of doctorReport.checks) {
      if (item.level !== "fail") continue;
      pushUnique(item.fixHint ?? item.detail ?? item.label);
    }
    if (doctorReport.timedOut && steps.length === 0) {
      pushUnique(copy.doctorTimeoutFallbackHint(doctorReport.profile || profileName || "paseo"));
    }
    if (doctorReport.error && steps.length === 0) {
      pushUnique(doctorReport.error);
      pushUnique(copy.doctorRpcFallbackHint);
    }
  }

  if (doctorError) {
    pushUnique(doctorError);
    pushUnique(copy.doctorRpcFallbackHint);
  }

  if (steps.length === 0) {
    pushUnique(copy.doctorRpcFallbackHint);
  }

  return steps;
}

function ProviderSummaryItem({
  provider,
  colors,
  copy,
  locale,
}: {
  provider: RedactedProviderInfo;
  colors: Colors;
  copy: DiagnosticsCopy;
  locale: Locale;
}) {
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const title =
    provider.displayName && provider.displayName !== provider.id
      ? `${provider.displayName} (${provider.id})`
      : provider.id;

  const metaParts: string[] = [];
  if (provider.api) metaParts.push(provider.api);
  if (provider.baseUrlHost) metaParts.push(provider.baseUrlHost);

  const visibleModels = modelsExpanded
    ? provider.models
    : provider.models.slice(0, INITIAL_VISIBLE_MODELS);
  const hiddenModelCount = Math.max(0, provider.models.length - visibleModels.length);

  return (
    <View
      style={{
        gap: space.xs,
        padding: space.sm,
        borderRadius: radius.md,
        backgroundColor: tint(colors.foreground, 0.035),
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.xs,
        }}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs, flex: 1, minWidth: 0 }}>
          <Text
            style={{
              ...font.small,
              fontWeight: "600",
              color: colors.foreground,
            }}
          >
            {title}
          </Text>
          {provider.isDefault ? (
            <Badge colors={colors} tone="accent" label={copy.defaultTag} />
          ) : null}
        </View>
        {provider.apiKeyEnv ? (
          <Badge
            colors={colors}
            dot
            tone={
              provider.credentialReady === true
                ? "success"
                : provider.credentialReady === false
                  ? "danger"
                  : "neutral"
            }
            label={
              provider.credentialReady === true
                ? copy.providerKeyReady(provider.apiKeyEnv)
                : provider.credentialReady === false
                  ? copy.providerKeyMissing(provider.apiKeyEnv)
                  : copy.providerKeyRef(provider.apiKeyEnv)
            }
          />
        ) : null}
      </View>

      {metaParts.length > 0 ? (
        <Muted colors={colors} small style={{ fontFamily: mono }}>
          {metaParts.join(" · ")}
        </Muted>
      ) : null}

      {provider.models.length === 0 ? (
        <Muted colors={colors} small>
          {copy.providerNoModels}
        </Muted>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
          {visibleModels.map((model) => (
            <View
              key={model.id}
              style={{
                paddingHorizontal: space.sm,
                paddingVertical: space.xxs,
                borderRadius: radius.sm,
                backgroundColor: tint(colors.foreground, 0.05),
              }}
            >
              <Text
                selectable
                style={{
                  ...font.caption,
                  fontFamily: mono,
                  color: colors.foregroundMuted,
                }}
              >
                {model.id}
              </Text>
            </View>
          ))}
          {hiddenModelCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setModelsExpanded(true)}
              style={{ paddingHorizontal: space.xs, paddingVertical: space.xxs }}
            >
              <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>
                {copy.showMoreModels(integer(hiddenModelCount, locale))}
              </Text>
            </Pressable>
          ) : provider.models.length > INITIAL_VISIBLE_MODELS && modelsExpanded ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setModelsExpanded(false)}
              style={{ paddingHorizontal: space.xs, paddingVertical: space.xxs }}
            >
              <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>
                {copy.showFewerModels}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

function DoctorCheckRow({
  item,
  colors,
  copy,
  compact,
}: {
  item: DoctorCheckItem;
  colors: Colors;
  copy: DiagnosticsCopy;
  compact: boolean;
}) {
  const tone = checkLevelTone(item.level);
  const badgeLabel = copy.levelLabel[item.level];
  const categoryName = copy.categoryLabel[item.category];

  return (
    <View style={{ gap: space.xs, paddingVertical: space.xs }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: space.sm,
        }}
      >
        <Badge
          colors={colors}
          tone={tone}
          dot
          label={badgeLabel}
          style={{ marginTop: 1 }}
        />
        <View style={{ flex: 1, minWidth: 0, gap: space.xxs }}>
          <View
            style={{
              flexDirection: compact ? "column" : "row",
              alignItems: compact ? "flex-start" : "baseline",
              justifyContent: "space-between",
              gap: compact ? space.xxs : space.sm,
            }}
          >
            <Text
              selectable
              style={{
                ...font.small,
                fontWeight: "500",
                color: colors.foreground,
                flex: compact ? undefined : 1,
              }}
            >
              {item.label}
            </Text>
            <Text
              style={{
                ...font.overline,
                color: colors.foregroundMuted,
              }}
            >
              {categoryName}
            </Text>
          </View>
          {item.detail ? (
            <Text
              selectable
              style={{
                ...font.caption,
                color: item.level === "fail" ? colors.foreground : colors.foregroundMuted,
              }}
            >
              {item.detail}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * Self-contained Environment Overview + On-Demand Full Doctor diagnostics
 * section for the DSH Console Settings tab.
 */
export function ConsoleDiagnosticsSection({
  client,
  colors,
  compact,
  testID,
}: ConsoleDiagnosticsSectionProps) {
  const locale = useCurrentLocale();
  const copy = COPY[locale];

  const [containerWidth, setContainerWidth] = useState(0);
  const [overview, setOverview] = useState<DiagnosticsOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewRefreshing, setOverviewRefreshing] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [providersExpanded, setProvidersExpanded] = useState(false);

  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [doctorError, setDoctorError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const overviewInFlightRef = useRef(false);
  const overviewRequestIdRef = useRef(0);
  const doctorInFlightRef = useRef(false);
  const fallbackCopyRef = useRef(copy);
  fallbackCopyRef.current = copy;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchOverview = useCallback(
    async (options?: { refreshVersion?: boolean; silent?: boolean; force?: boolean }) => {
      const refreshVersion = options?.refreshVersion === true;
      const silent = options?.silent === true;
      const force = options?.force === true;
      if (overviewInFlightRef.current && !force) return;

      overviewInFlightRef.current = true;
      const requestId = overviewRequestIdRef.current + 1;
      overviewRequestIdRef.current = requestId;

      if (!silent) {
        setOverviewRefreshing(true);
        setOverviewError(null);
      }

      try {
        const result = await client.rpc(
          diagnosticsOverviewRpc,
          refreshVersion ? { refreshVersion: true } : {},
        );
        if (!mountedRef.current || requestId !== overviewRequestIdRef.current) return;
        setOverview(result);
        setOverviewError(null);
      } catch (error) {
        report("diagnostics overview", error);
        if (!mountedRef.current || requestId !== overviewRequestIdRef.current) return;
        if (!silent) {
          setOverviewError(errorMessageOf(error, fallbackCopyRef.current.overviewFailedFallback));
        }
      } finally {
        if (requestId === overviewRequestIdRef.current) {
          overviewInFlightRef.current = false;
          if (mountedRef.current) {
            setOverviewLoading(false);
            if (!silent) setOverviewRefreshing(false);
          }
        }
      }
    },
    [client],
  );

  useEffect(() => {
    void fetchOverview({ refreshVersion: false, silent: false, force: true });
  }, [fetchOverview]);

  const handleRefreshOverview = useCallback(() => {
    void fetchOverview({ refreshVersion: true, silent: false });
  }, [fetchOverview]);

  const handleRunDoctor = useCallback(async () => {
    if (doctorInFlightRef.current) return;
    doctorInFlightRef.current = true;
    setDoctorRunning(true);
    setDoctorError(null);

    try {
      const result = await client.rpc(diagnosticsRunDoctorRpc, {});
      if (!mountedRef.current) return;
      setDoctorReport(result);
      setDoctorError(null);
      // Quietly refresh the fast overview so fixes verified by Doctor reflect above.
      void fetchOverview({ refreshVersion: false, silent: true });
    } catch (error) {
      report("diagnostics run-doctor", error);
      if (!mountedRef.current) return;
      setDoctorReport(null);
      setDoctorError(errorMessageOf(error, fallbackCopyRef.current.doctorRpcErrorFallback));
    } finally {
      doctorInFlightRef.current = false;
      if (mountedRef.current) {
        setDoctorRunning(false);
      }
    }
  }, [client, fetchOverview]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setContainerWidth((prev) => (Math.abs(prev - nextWidth) < 2 ? prev : nextWidth));
  }, []);

  const isCompact = Boolean(compact) || (containerWidth > 0 && containerWidth < COMPACT_BREAKPOINT);

  const sortedProviders = useMemo(() => {
    if (!overview) return [];
    return [...overview.providers].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }, [overview]);

  const totalModelCount = useMemo(
    () => sortedProviders.reduce((sum, provider) => sum + provider.models.length, 0),
    [sortedProviders],
  );

  const visibleProviders = providersExpanded
    ? sortedProviders
    : sortedProviders.slice(0, INITIAL_VISIBLE_PROVIDERS);
  const hiddenProviderCount = Math.max(0, sortedProviders.length - visibleProviders.length);

  const failingChecksCount = useMemo(() => {
    if (!doctorReport) return 0;
    const fromChecks = doctorReport.checks.filter((item) => item.level === "fail").length;
    return Math.max(doctorReport.summary.fail, fromChecks);
  }, [doctorReport]);

  const hasDoctorFailure =
    doctorError !== null ||
    (doctorReport !== null &&
      (!doctorReport.ok ||
        doctorReport.timedOut ||
        doctorReport.error !== undefined ||
        doctorReport.summary.blocking ||
        failingChecksCount > 0));

  const remediationSteps = useMemo(
    () =>
      hasDoctorFailure
        ? collectRemediationSteps(doctorReport, doctorError, overview?.profile.name, copy)
        : [],
    [hasDoctorFailure, doctorReport, doctorError, overview?.profile.name, copy],
  );

  const dshHint = useMemo(() => {
    if (!overview) return undefined;
    const parts: string[] = [];
    parts.push(overview.dsh.resolvedPath ?? overview.dsh.configuredBinary);
    if (overview.pluginVersion) {
      parts.push(copy.pluginVersionTag(overview.pluginVersion));
    }
    return parts.join(" · ");
  }, [overview, copy]);

  const dshError = useMemo(() => {
    if (!overview) return undefined;
    if (overview.dsh.error) return overview.dsh.error;
    if (overview.dsh.versionOk === false) {
      return copy.dshMinVersionError(overview.dsh.minimumVersion);
    }
    return undefined;
  }, [overview, copy]);

  const profileHint = useMemo(() => {
    if (!overview) return undefined;
    const parts = [overview.profile.displayDir];
    if (overview.profile.fromEnv) parts.push(copy.profileEnvTag);
    if (overview.profile.bundles.length > 0) {
      parts.push(copy.bundleCount(integer(overview.profile.bundles.length, locale)));
    }
    return parts.join(" · ");
  }, [overview, copy, locale]);

  const bridgeHint = useMemo(() => {
    if (!overview) return undefined;
    const parts: string[] = [];
    if (overview.bridge.displayActiveDir) {
      parts.push(overview.bridge.displayActiveDir);
    }
    if (overview.bridge.expectedFiles > 0) {
      parts.push(
        copy.bridgeFilesCount(
          integer(overview.bridge.presentFiles, locale),
          integer(overview.bridge.expectedFiles, locale),
        ),
      );
    }
    if (overview.bridge.missingFiles.length > 0) {
      const preview = overview.bridge.missingFiles.slice(0, 3).join(", ");
      const extra = Math.max(0, overview.bridge.missingFiles.length - 3);
      parts.push(copy.bridgeMissingFiles(preview, extra));
    }
    if (overview.bridge.status === "shadowed" && overview.bridge.issue) {
      parts.push(overview.bridge.issue);
    }
    return parts.join(" · ");
  }, [overview, copy, locale]);

  const routeHint = useMemo(() => {
    if (!overview) return undefined;
    const parts = [overview.route.displayPatchPath];
    if (overview.route.reasoningEffort) {
      parts.push(copy.routeReasoning(overview.route.reasoningEffort));
    }
    return parts.join(" · ");
  }, [overview, copy]);

  const credentialsHint = useMemo(() => {
    if (!overview) return undefined;
    const cred = overview.credentials;
    const parts: string[] = [cred.displayPath];
    if (cred.mode) {
      const permLabel =
        cred.ownerOnly === true
          ? `${copy.credentialsMode(cred.mode)} (${copy.credentialsOwnerOnly})`
          : cred.ownerOnly === false
            ? `${copy.credentialsMode(cred.mode)} (${copy.credentialsGroupOtherReadable})`
            : copy.credentialsMode(cred.mode);
      parts.push(permLabel);
    }
    if (cred.referencedRefs.length > 0) {
      const readyCount = cred.referencedRefs.filter((ref) => ref.present).length;
      parts.push(
        copy.credentialsRefsProgress(
          integer(readyCount, locale),
          integer(cred.referencedRefs.length, locale),
        ),
      );
    }
    if (cred.legacyFlatLayout) {
      parts.push(copy.credentialsLegacyNote);
    }
    return parts.join(" · ");
  }, [overview, copy, locale]);

  const credentialsError = useMemo(() => {
    if (!overview) return undefined;
    const cred = overview.credentials;
    if (cred.status === "ready" || cred.status === "no-refs-needed" || cred.status === "unverified") {
      return undefined;
    }
    return cred.contractIssues[0] ?? cred.fixHint;
  }, [overview]);

  const updatedTimeLabel = useMemo(() => {
    if (!overview) return null;
    const clock = clockTime(overview.collectedAt, locale, false);
    return clock ? copy.updatedAt(clock) : null;
  }, [overview, locale, copy]);

  const doctorMetaLabel = useMemo(() => {
    if (!doctorReport) return copy.doctorSubtitleIdle;
    const time = clockTime(doctorReport.ranAt, locale, true);
    const elapsed = duration(doctorReport.durationMs, locale);
    const base = copy.doctorRunSummary(time, elapsed || "0ms");
    return doctorReport.sharedInFlight ? `${base} · ${copy.doctorSharedRunNote}` : base;
  }, [doctorReport, locale, copy]);

  const dangerCalloutTitle = useMemo(() => {
    if (doctorError) return copy.doctorErrorTitle;
    if (doctorReport?.timedOut) return copy.doctorTimeoutTitle;
    if (failingChecksCount > 0) {
      return copy.doctorFailTitle(integer(failingChecksCount, locale));
    }
    return copy.doctorErrorTitle;
  }, [doctorError, doctorReport?.timedOut, failingChecksCount, copy, locale]);

  return (
    <View testID={testID} onLayout={handleLayout} style={{ gap: space.lg }}>
      {/* Instant read-only Environment & Route Overview */}
      <View style={{ gap: space.sm }}>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <View style={{ flex: 1, minWidth: 160, gap: space.xxs }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
              <Text accessibilityRole="header" style={{ ...font.heading, color: colors.foreground }}>
                {copy.overviewTitle}
              </Text>
              {overview ? (
                <Badge
                  colors={colors}
                  dot
                  tone={overview.hasIssues ? "warning" : "success"}
                  label={overview.hasIssues ? copy.statusAttention : copy.statusHealthy}
                />
              ) : null}
            </View>
            <Muted colors={colors} small>
              {updatedTimeLabel ?? copy.overviewSubtitle}
            </Muted>
          </View>
          <Button
            colors={colors}
            variant="ghost"
            size="sm"
            icon="RefreshCw"
            label={isCompact ? undefined : overviewRefreshing ? copy.refreshing : copy.refreshOverview}
            accessibilityLabel={copy.refreshOverview}
            loading={overviewRefreshing && overview !== null}
            disabled={overviewLoading && overview === null}
            onPress={handleRefreshOverview}
          />
        </View>

        {overviewError ? (
          <Callout
            colors={colors}
            tone="danger"
            title={copy.overviewFailedTitle}
            testID="dsh-diagnostics-overview-error"
            action={
              <Button
                colors={colors}
                variant="danger"
                size="sm"
                icon="RefreshCw"
                label={copy.retry}
                loading={overviewRefreshing}
                onPress={handleRefreshOverview}
              />
            }
          >
            <Text selectable style={{ ...font.caption, color: colors.foreground }}>
              {overviewError}
            </Text>
          </Callout>
        ) : null}

        {overviewLoading && overview === null ? (
          <Card colors={colors} testID="dsh-diagnostics-overview-card" style={{ padding: space.lg }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Muted colors={colors}>{copy.loadingOverview}</Muted>
            </View>
          </Card>
        ) : null}

        {overview ? (
          <View style={{ gap: space.sm, opacity: overviewRefreshing ? 0.65 : 1 }}>
            <HostSettingsCard colors={colors} testID="dsh-diagnostics-overview-card">
              {/* 1. DSH CLI */}
              <HostSettingsRow
                colors={colors}
                compact={isCompact}
                label={copy.dshCliLabel}
                hint={dshHint}
                error={dshError}
              >
                <Badge
                  colors={colors}
                  dot
                  tone={
                    overview.dsh.error || overview.dsh.versionOk === false
                      ? "danger"
                      : overview.dsh.version
                        ? "success"
                        : "warning"
                  }
                  label={
                    overview.dsh.error
                      ? copy.dshNotFound
                      : overview.dsh.version
                        ? formatVersionBadge(overview.dsh.version)
                        : copy.dshVersionUnknown
                  }
                />
              </HostSettingsRow>

              {/* 2. Profile */}
              <HostSettingsRow
                colors={colors}
                compact={isCompact}
                label={copy.profileLabel}
                hint={profileHint}
                error={overview.profile.issue}
              >
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
                  <Text
                    selectable
                    style={{
                      ...font.small,
                      fontFamily: mono,
                      fontWeight: "500",
                      color: colors.foreground,
                    }}
                  >
                    {overview.profile.name}
                  </Text>
                  <Badge
                    colors={colors}
                    dot
                    tone={
                      overview.profile.exists &&
                      overview.profile.manifestValid &&
                      overview.profile.loadsBridgeBundle
                        ? "success"
                        : "danger"
                    }
                    label={
                      !overview.profile.exists
                        ? copy.profileMissing
                        : overview.profile.manifestValid && overview.profile.loadsBridgeBundle
                          ? copy.profileReady
                          : copy.profileInvalid
                    }
                  />
                </View>
              </HostSettingsRow>

              {/* 3. Bridge Status */}
              <HostSettingsRow
                colors={colors}
                compact={isCompact}
                label={copy.bridgeLabel}
                hint={bridgeHint}
                error={
                  overview.bridge.status === "incomplete" ||
                  overview.bridge.status === "missing" ||
                  overview.bridge.status === "unverified"
                    ? overview.bridge.issue
                    : undefined
                }
              >
                <Badge
                  colors={colors}
                  dot
                  tone={bridgeStatusTone(overview.bridge.status)}
                  label={copy.bridgeStatus[overview.bridge.status]}
                />
              </HostSettingsRow>

              {/* 4. Default Route */}
              <HostSettingsRow
                colors={colors}
                compact={isCompact}
                label={copy.routeLabel}
                hint={routeHint}
                error={
                  overview.route.status !== "configured" && overview.route.status !== "unverified"
                    ? overview.route.issue
                    : undefined
                }
              >
                {overview.route.status === "configured" &&
                overview.route.provider &&
                overview.route.model ? (
                  <Text
                    selectable
                    numberOfLines={2}
                    style={{
                      ...font.small,
                      fontFamily: mono,
                      fontWeight: "500",
                      color: colors.foreground,
                      textAlign: isCompact ? "left" : "right",
                      flexShrink: 1,
                    }}
                  >
                    {overview.route.provider} / {overview.route.model}
                  </Text>
                ) : (
                  <Badge
                    colors={colors}
                    dot
                    tone={routeStatusTone(overview.route.status)}
                    label={copy.routeStatus[overview.route.status]}
                  />
                )}
              </HostSettingsRow>

              {/* 5. Redacted Providers & Models summary */}
              <HostSettingsRow
                colors={colors}
                compact={isCompact}
                label={copy.providersLabel}
              >
                <Badge
                  colors={colors}
                  tone={sortedProviders.length > 0 ? "neutral" : "warning"}
                  label={
                    sortedProviders.length > 0
                      ? copy.providersSummary(
                          integer(sortedProviders.length, locale),
                          integer(totalModelCount, locale),
                        )
                      : copy.providersNone
                  }
                />
              </HostSettingsRow>

              {/* 6. Credentials readiness & file permissions */}
              <HostSettingsRow
                colors={colors}
                compact={isCompact}
                label={copy.credentialsLabel}
                hint={credentialsHint}
                error={credentialsError}
              >
                <Badge
                  colors={colors}
                  dot
                  tone={credentialsStatusTone(overview.credentials.status)}
                  label={copy.credentialsStatus[overview.credentials.status]}
                />
              </HostSettingsRow>
            </HostSettingsCard>

            {/* Redacted provider/model breakdown & credential ref readiness chips */}
            {visibleProviders.length > 0 || overview.credentials.referencedRefs.length > 0 ? (
              <Card
                colors={colors}
                testID="dsh-diagnostics-providers-card"
                style={{ padding: space.md, gap: space.sm }}
              >
                {visibleProviders.length > 0 ? (
                  <View style={{ gap: space.sm }}>
                    <Text style={{ ...font.overline, color: colors.foregroundMuted }}>
                      {copy.providerDetailsHeading}
                    </Text>
                    {visibleProviders.map((provider) => (
                      <ProviderSummaryItem
                        key={provider.id}
                        provider={provider}
                        colors={colors}
                        copy={copy}
                        locale={locale}
                      />
                    ))}
                    {hiddenProviderCount > 0 ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setProvidersExpanded(true)}
                        style={{ alignSelf: "flex-start", paddingVertical: space.xxs }}
                      >
                        <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>
                          {copy.showAllProviders(integer(sortedProviders.length, locale))}
                        </Text>
                      </Pressable>
                    ) : sortedProviders.length > INITIAL_VISIBLE_PROVIDERS && providersExpanded ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setProvidersExpanded(false)}
                        style={{ alignSelf: "flex-start", paddingVertical: space.xxs }}
                      >
                        <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>
                          {copy.showFewerProviders}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}

                {visibleProviders.length > 0 && overview.credentials.referencedRefs.length > 0 ? (
                  <Divider colors={colors} />
                ) : null}

                {overview.credentials.referencedRefs.length > 0 ? (
                  <View style={{ gap: space.xs }}>
                    <Text style={{ ...font.overline, color: colors.foregroundMuted }}>
                      {copy.credentialRefsHeading}
                    </Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                      {overview.credentials.referencedRefs.map((ref) => (
                        <Badge
                          key={ref.name}
                          colors={colors}
                          dot
                          tone={ref.present ? "success" : "danger"}
                          label={ref.name}
                        />
                      ))}
                    </View>
                  </View>
                ) : null}
              </Card>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* On-demand Full Doctor Diagnostics */}
      <Card
        colors={colors}
        testID="dsh-diagnostics-doctor-card"
        style={{ padding: space.lg, gap: space.md }}
      >
        <View
          style={{
            flexDirection: isCompact ? "column" : "row",
            alignItems: isCompact ? "flex-start" : "center",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <View style={{ flex: isCompact ? undefined : 1, minWidth: 0, gap: space.xxs }}>
            <Text accessibilityRole="header" style={{ ...font.heading, color: colors.foreground }}>
              {copy.doctorTitle}
            </Text>
            <Muted colors={colors} small style={tabular}>
              {doctorMetaLabel}
            </Muted>
          </View>
          <Button
            colors={colors}
            variant={overview?.hasIssues ? "primary" : "secondary"}
            size="sm"
            icon="ShieldCheck"
            label={doctorRunning ? copy.runningDiagnostics : copy.runFullDiagnostics}
            loading={doctorRunning}
            disabled={doctorRunning}
            onPress={() => void handleRunDoctor()}
            testID="dsh-diagnostics-run-doctor-btn"
          />
        </View>

        {doctorRunning ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              paddingVertical: space.xs,
            }}
          >
            <ActivityIndicator size="small" color={colors.accent} />
            <Muted colors={colors} small style={{ flex: 1 }}>
              {copy.doctorRunningHint}
            </Muted>
          </View>
        ) : !doctorReport && !doctorError ? (
          <Muted colors={colors} small>
            {copy.doctorIdleHint}
          </Muted>
        ) : null}

        {doctorReport ? (
          <View style={{ gap: space.md, opacity: doctorRunning ? 0.6 : 1 }}>
            {/* Summary badges */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
              <Badge
                colors={colors}
                dot
                tone="success"
                label={copy.summaryOk(integer(doctorReport.summary.ok, locale))}
              />
              {doctorReport.summary.warn > 0 ? (
                <Badge
                  colors={colors}
                  dot
                  tone="warning"
                  label={copy.summaryWarn(integer(doctorReport.summary.warn, locale))}
                />
              ) : null}
              {failingChecksCount > 0 ? (
                <Badge
                  colors={colors}
                  dot
                  tone="danger"
                  label={copy.summaryFail(integer(failingChecksCount, locale))}
                />
              ) : null}
              {doctorReport.timedOut ? (
                <Badge colors={colors} dot tone="danger" label={copy.summaryTimedOut} />
              ) : null}
            </View>

            {/* Doctor check rows */}
            {doctorReport.checks.length > 0 ? (
              <View style={{ gap: space.xs }}>
                <Divider colors={colors} />
                {doctorReport.checks.map((item, index) => (
                  <View key={`${item.id}-${index}`}>
                    {index > 0 ? (
                      <Divider
                        colors={colors}
                        style={{ backgroundColor: tint(colors.border, 0.55), marginBottom: space.xs }}
                      />
                    ) : null}
                    <DoctorCheckRow item={item} colors={colors} copy={copy} compact={isCompact} />
                  </View>
                ))}
              </View>
            ) : null}

            {/* Non-failure outcome banner */}
            {!hasDoctorFailure && doctorReport.summary.warn > 0 ? (
              <Callout
                colors={colors}
                tone="warning"
                title={copy.doctorWarnTitle(integer(doctorReport.summary.warn, locale))}
                action={
                  <Button
                    colors={colors}
                    variant="secondary"
                    size="sm"
                    icon="RefreshCw"
                    label={copy.recheck}
                    loading={doctorRunning}
                    disabled={doctorRunning}
                    onPress={() => void handleRunDoctor()}
                  />
                }
              >
                <Muted colors={colors} small>
                  {copy.doctorWarnBody}
                </Muted>
              </Callout>
            ) : !hasDoctorFailure && doctorReport.summary.total > 0 ? (
              <Callout
                colors={colors}
                tone="success"
                title={copy.doctorAllPassedTitle(integer(doctorReport.summary.total, locale))}
              >
                <Muted colors={colors} small>
                  {copy.doctorAllPassedBody}
                </Muted>
              </Callout>
            ) : null}
          </View>
        ) : null}

        {/* Bottom remediation Callout when ANY fail item exists or doctor RPC errored/timed out */}
        {hasDoctorFailure ? (
          <Callout
            colors={colors}
            tone="danger"
            title={dangerCalloutTitle}
            testID="dsh-diagnostics-failure-callout"
            action={
              <Button
                colors={colors}
                variant="danger"
                size="sm"
                icon="RefreshCw"
                label={copy.recheck}
                loading={doctorRunning}
                disabled={doctorRunning}
                onPress={() => void handleRunDoctor()}
                testID="dsh-diagnostics-recheck-btn"
              />
            }
          >
            {remediationSteps.length > 0 ? (
              <View style={{ gap: space.xs }}>
                <Text style={{ ...font.caption, fontWeight: "500", color: colors.foreground }}>
                  {copy.doctorRemediationIntro}
                </Text>
                {remediationSteps.map((step, index) => (
                  <View
                    key={`${index}-${step.slice(0, 24)}`}
                    style={{ flexDirection: "row", alignItems: "flex-start", gap: space.xs }}
                  >
                    <Text
                      style={{
                        ...font.caption,
                        ...tabular,
                        fontWeight: "600",
                        color: toneColor(colors, "danger"),
                      }}
                    >
                      {index + 1}.
                    </Text>
                    <Text
                      selectable
                      style={{
                        ...font.caption,
                        color: colors.foreground,
                        flex: 1,
                      }}
                    >
                      {step}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </Callout>
        ) : null}
      </Card>
    </View>
  );
}
