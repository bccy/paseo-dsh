import type { UsageSourceRegistration, UsageWindow } from "@getpaseo/plugin/server";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageScope,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { SYSTEM_ACCOUNT_ID, accountIdSchema, type QuotaGroup } from "../../shared/antigravity/contracts";
import type { AccountService } from "./accounts";
import { profileCliDir } from "./paths";

const input = z.object({ accountId: accountIdSchema }).strict();

/** A hash of the account's antigravity-cli directory, the identity Paseo's own reader uses too. */
function accountKey(accountId: string): string {
  return hashAccountKey(profileCliDir(accountId));
}

/** Lengths of the periods agy names, so Paseo can tell whether a quota lasts until its reset. */
const WINDOW_SECONDS: Readonly<Record<string, number>> = {
  "5h": 5 * 3600,
  daily: 86_400,
  weekly: 7 * 86_400,
  monthly: 30 * 86_400,
};

function shortWindow(window: string): string {
  const normalized = window.trim().toLowerCase();
  if (normalized === "weekly") return "wk";
  if (normalized === "daily") return "1d";
  if (normalized === "monthly") return "mo";
  return window.trim();
}

function shortGroup(name: string): string {
  return name.trim().replace(/\s+models$/i, "").trim();
}

export function quotaWindows(groups: readonly QuotaGroup[]): UsageWindow[] {
  const includeGroup = groups.length > 1;
  return groups.flatMap((group) =>
    group.buckets.flatMap((bucket) => {
      if (!bucket.disabled && bucket.remainingFraction === null) return [];
      const used = bucket.disabled || bucket.remainingFraction === null ? null : (1 - bucket.remainingFraction) * 100;
      const period = shortWindow(bucket.window);
      return [
        windowFromUsedPct({
          id: bucket.id,
          label: `${group.name} · ${bucket.name}${bucket.disabled ? " · Disabled" : ""}`,
          shortLabel: includeGroup ? `${shortGroup(group.name)} ${period}`.trim() : period,
          summary: !bucket.disabled && bucket.window.trim().toLowerCase() === "weekly",
          utilizationPct: used,
          durationSeconds: WINDOW_SECONDS[bucket.window.trim().toLowerCase()],
          resetsAt: bucket.disabled ? null : bucket.resetTime,
          tone: used === null ? "default" : toneFromUsedPct(used),
        }),
      ];
    }),
  );
}

/**
 * Lists only the accounts this plugin added, on the host-wide Usage screen. Paseo's built-in
 * Antigravity source (0.17.1 and later) reports the system sign-in there, and in an agent's
 * popover the account that agent runs on: it follows the session's ANTIGRAVITY_HOME, which the
 * launch hook sets per account. Paseo keeps one card per source and account, so reporting those
 * here as well showed each of them twice.
 */
export function createUsageSource(service: AccountService): UsageSourceRegistration {
  return {
    id: "dsh-paseo-antigravity-accounts",
    label: "Antigravity accounts",
    icon: "icon.svg",
    input,
    async discover(scope: UsageScope) {
      if (scope.kind !== "global") return [];
      await service.init();
      return service.store.snapshot().accounts.map((account) => ({
        key: accountKey(account.id),
        label: account.label,
        harness: "Antigravity",
        input: { accountId: account.id },
      }));
    },
    async fetch(value: unknown) {
      await service.init();
      const { accountId } = input.parse(value);
      if (accountId !== SYSTEM_ACCOUNT_ID && !service.store.get(accountId)) {
        throw new Error("This Antigravity account was removed.");
      }
      const status = await service.quotaFor(accountId, 60_000);
      if (status.status === "signed-in" && status.quota) {
        const windows = quotaWindows(status.quota);
        if (windows.length === 0) {
          return unavailable({ kind: "no_quota", detail: "agy reported no quota for this account" });
        }
        return {
          status: "available",
          ...(status.plan ? { planLabel: status.plan.name } : {}),
          ...(status.checkedAt ? { observedAt: status.checkedAt } : {}),
          windows,
        };
      }
      if (status.status === "signed-out") {
        return unavailable({
          kind: "no_quota",
          detail: "Not signed in. Open Antigravity accounts to sign in.",
        });
      }
      return { status: "error", error: status.statusDetail ?? "Could not read Antigravity quota" };
    },
  };
}
