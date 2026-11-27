/**
 * Paseo 0.18+ plugin push-notification dispatcher for unattended events
 * (Antigravity automatic account fallback, account exhaustion, and unexpected
 * sign-out detected by background probes).
 *
 * Gracefully degrades to a no-op on Paseo 0.17.x hosts where
 * `server.notifications` is absent, and swallows transient transport errors so
 * notification delivery never interrupts core agent or account flows.
 *
 * @module dsh-paseo/server/notifications
 */
import type { PluginNotifications, PluginNotificationSendInput, PluginNotificationSendResult } from "@getpaseo/plugin/server";
import type { FailureReason } from "../shared/antigravity/contracts";
import type { JobKind } from "../shared/dsh-plugins-api";
import type { GoalAnswer, GoalPhase } from "../shared/goal";

export const CONSOLE_SCREEN_ID = "dsh-console";

export type NotificationLocale = "zh-CN" | "en";

export interface DshPluginJobNoticeInput {
  readonly jobId: string;
  readonly kind: Exclude<JobKind, "check">;
  readonly ok: boolean;
  readonly target?: string;
  readonly errorDetail?: string;
}

export interface DshGoalNoticeInput {
  readonly agentId: string;
  readonly goalId: string;
  readonly revision: number;
  readonly phase: "complete" | "blocked";
  readonly objective: string;
  readonly blockedMessage?: string;
}

export interface PluginNotificationsDispatcher {
  readonly enabled: boolean;
  notifyFallbackSwitch(input: {
    readonly agentId: string;
    readonly from: string;
    readonly to: string;
    readonly reason: FailureReason;
  }): Promise<PluginNotificationSendResult | null>;
  notifyFallbackExhausted(input: {
    readonly agentId: string;
    readonly from: string;
    readonly reason: FailureReason;
  }): Promise<PluginNotificationSendResult | null>;
  notifyAccountSignedOut(input: {
    readonly accountId: string;
    readonly label: string;
  }): Promise<PluginNotificationSendResult | null>;
  notifyDshGoal(input: DshGoalNoticeInput): Promise<PluginNotificationSendResult | null>;
  notifyDshPluginJob(input: DshPluginJobNoticeInput): Promise<PluginNotificationSendResult | null>;
}

const REASON_LABELS: Record<NotificationLocale, Record<FailureReason, string>> = {
  "zh-CN": {
    quota: "额度用完",
    auth: "登录失效",
    transient: "连续出错",
    error: "连续出错",
  },
  en: {
    quota: "quota exhausted",
    auth: "sign-in expired",
    transient: "repeated errors",
    error: "repeated errors",
  },
};

export function resolveNotificationLocale(
  override?: NotificationLocale,
  env: Readonly<Record<string, string | undefined>> = process.env,
): NotificationLocale {
  if (override === "zh-CN" || override === "en") return override;
  const raw = (env["LC_ALL"] ?? env["LC_MESSAGES"] ?? env["LANG"] ?? "").toLowerCase();
  if (raw.startsWith("en")) return "en";
  return "zh-CN";
}

export function formatFallbackSwitchNotification(
  input: {
    readonly agentId: string;
    readonly from: string;
    readonly to: string;
    readonly reason: FailureReason;
  },
  locale: NotificationLocale = "zh-CN",
): PluginNotificationSendInput {
  const reasonText = REASON_LABELS[locale][input.reason];
  if (locale === "en") {
    return {
      title: "Antigravity switched account",
      body: `“${input.from}” (${reasonText}) — switched to “${input.to}” and continued.`,
      key: `ag-fallback-switch:${input.agentId}:${input.to}`,
      open: { type: "agent", agentId: input.agentId },
      data: { kind: "fallback-switch", agentId: input.agentId },
    };
  }
  return {
    title: "Antigravity 已自动切换账号",
    body: `「${input.from}」${reasonText}，已切换到「${input.to}」并继续对话`,
    key: `ag-fallback-switch:${input.agentId}:${input.to}`,
    open: { type: "agent", agentId: input.agentId },
    data: { kind: "fallback-switch", agentId: input.agentId },
  };
}

export function formatFallbackExhaustedNotification(
  input: {
    readonly agentId: string;
    readonly from: string;
    readonly reason: FailureReason;
  },
  locale: NotificationLocale = "zh-CN",
): PluginNotificationSendInput {
  const reasonText = REASON_LABELS[locale][input.reason];
  if (locale === "en") {
    return {
      title: "Antigravity accounts exhausted",
      body: `“${input.from}” (${reasonText}). No backup account can take over; auto-switch stopped.`,
      key: `ag-fallback-exhausted:${input.agentId}`,
      open: { type: "agent", agentId: input.agentId },
      data: { kind: "fallback-exhausted", agentId: input.agentId },
    };
  }
  return {
    title: "Antigravity 账号不可用",
    body: `「${input.from}」${reasonText}，没有可接手的备用账号，自动切换已停止`,
    key: `ag-fallback-exhausted:${input.agentId}`,
    open: { type: "agent", agentId: input.agentId },
    data: { kind: "fallback-exhausted", agentId: input.agentId },
  };
}

export function formatAccountSignedOutNotification(
  input: {
    readonly accountId: string;
    readonly label: string;
  },
  locale: NotificationLocale = "zh-CN",
): PluginNotificationSendInput {
  if (locale === "en") {
    return {
      title: "Antigravity sign-in expired",
      body: `“${input.label}” is signed out. Tap to sign in again in Antigravity Console.`,
      key: `ag-account-signed-out:${input.accountId}`,
      open: { type: "screen", screenId: CONSOLE_SCREEN_ID, params: { tab: "antigravity" } },
      data: { kind: "account-signed-out", accountId: input.accountId },
    };
  }
  return {
    title: "Antigravity 账号登录已失效",
    body: `「${input.label}」登录已失效，点击前往控制台重新登录`,
    key: `ag-account-signed-out:${input.accountId}`,
    open: { type: "screen", screenId: CONSOLE_SCREEN_ID, params: { tab: "antigravity" } },
    data: { kind: "account-signed-out", accountId: input.accountId },
  };
}

function clipNoticeText(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function formatDshGoalNotification(
  input: DshGoalNoticeInput,
  locale: NotificationLocale = "zh-CN",
): PluginNotificationSendInput {
  const summary = clipNoticeText(
    input.phase === "blocked" && input.blockedMessage ? input.blockedMessage : input.objective,
    120,
  );
  const key = `dsh-goal-${input.phase}:${input.agentId}:${input.goalId}:${input.revision}`;
  const open = { type: "agent" as const, agentId: input.agentId };
  const data = { kind: "dsh-goal", agentId: input.agentId, phase: input.phase };
  if (locale === "en") {
    return {
      title: input.phase === "complete" ? "DSH goal completed" : "DSH goal blocked",
      body: summary || (input.phase === "complete" ? "The goal finished." : "Action needed to continue."),
      key,
      open,
      data,
    };
  }
  return {
    title: input.phase === "complete" ? "DSH 目标已完成" : "DSH 目标受阻，需要介入",
    body: summary || (input.phase === "complete" ? "当前目标已全部完成" : "目标已暂停等待你的处理"),
    key,
    open,
    data,
  };
}

const PLUGIN_JOB_LABELS: Record<NotificationLocale, Record<Exclude<JobKind, "check">, string>> = {
  "zh-CN": {
    install: "安装",
    remove: "卸载",
    update: "更新",
    "update-all": "批量更新",
  },
  en: {
    install: "install",
    remove: "removal",
    update: "update",
    "update-all": "batch update",
  },
};

export function formatDshPluginJobNotification(
  input: DshPluginJobNoticeInput,
  locale: NotificationLocale = "zh-CN",
): PluginNotificationSendInput {
  const action = PLUGIN_JOB_LABELS[locale][input.kind];
  const target = input.target?.trim();
  const key = `dsh-plugin-job:${input.jobId}`;
  const open = { type: "screen" as const, screenId: CONSOLE_SCREEN_ID, params: { tab: "plugins" } };
  const data = { kind: "dsh-plugin-job", jobId: input.jobId };
  if (locale === "en") {
    const subject = target ? `DSH plugin ${target}` : "DSH plugins";
    return {
      title: input.ok ? `DSH plugin ${action} finished` : `DSH plugin ${action} failed`,
      body: input.ok
        ? `${subject} ${action} succeeded.`
        : clipNoticeText(input.errorDetail || `${subject} ${action} failed.`, 120),
      key,
      open,
      data,
    };
  }
  const subject = target ? `「${target}」` : "DSH 插件";
  return {
    title: input.ok ? `DSH 插件${action}完成` : `DSH 插件${action}失败`,
    body: input.ok
      ? `${subject}${action}已完成，点击查看详情`
      : clipNoticeText(input.errorDetail || `${subject}${action}失败，请前往控制台查看日志`, 120),
    key,
    open,
    data,
  };
}

/**
 * Observes live `GoalAnswer` reads per agent and emits a notification strictly
 * on a live `active -> complete | blocked` transition, never on initial load
 * or session reopen.
 */
export function createGoalNotificationObserver(
  notifications: Pick<PluginNotificationsDispatcher, "notifyDshGoal">,
): {
  observe(agentId: string, answer: GoalAnswer): void;
  forget(agentId: string): void;
} {
  const seen = new Map<string, { id: string; phase: GoalPhase; revision: number }>();
  return {
    observe(agentId, answer) {
      if (!answer.available) return;
      const goal = answer.goal;
      if (!goal) {
        seen.delete(agentId);
        return;
      }
      const prev = seen.get(agentId);
      seen.set(agentId, { id: goal.id, phase: goal.phase, revision: goal.revision });
      if (!prev || prev.id !== goal.id) return;
      if (prev.phase !== "active") return;
      if (goal.phase === "complete" || goal.phase === "blocked") {
        void notifications.notifyDshGoal({
          agentId,
          goalId: goal.id,
          revision: goal.revision,
          phase: goal.phase,
          objective: goal.objective,
          blockedMessage: goal.blockedReason?.message,
        });
      }
    },
    forget(agentId) {
      seen.delete(agentId);
    },
  };
}

export function createNotificationDispatcher(
  notifications?: PluginNotifications,
  options?: { readonly locale?: NotificationLocale },
): PluginNotificationsDispatcher {
  const api = notifications && typeof notifications.send === "function" ? notifications : undefined;
  const getLocale = () => resolveNotificationLocale(options?.locale);

  async function sendSafe(payload: PluginNotificationSendInput): Promise<PluginNotificationSendResult | null> {
    if (!api) return null;
    try {
      return await api.send(payload);
    } catch (error) {
      console.warn(
        `[dsh-paseo] notification send failed (${payload.key ?? payload.title}): `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  return {
    enabled: Boolean(api),
    notifyFallbackSwitch: (input) => sendSafe(formatFallbackSwitchNotification(input, getLocale())),
    notifyFallbackExhausted: (input) => sendSafe(formatFallbackExhaustedNotification(input, getLocale())),
    notifyAccountSignedOut: (input) => sendSafe(formatAccountSignedOutNotification(input, getLocale())),
    notifyDshGoal: (input) => sendSafe(formatDshGoalNotification(input, getLocale())),
    notifyDshPluginJob: (input) => sendSafe(formatDshPluginJobNotification(input, getLocale())),
  };
}
