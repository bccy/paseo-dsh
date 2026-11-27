import type { QuotaBucket, QuotaGroup } from "../../shared/antigravity/contracts";

export interface GeminiQuotaPair {
  readonly fiveHour: QuotaBucket | null;
  readonly weekly: QuotaBucket | null;
}

function geminiGroup(groups: readonly QuotaGroup[]): QuotaGroup | null {
  return groups.find((group) => /gemini/i.test(group.name) && !/argon/i.test(group.name)) ?? null;
}

function activeBucketFor(group: QuotaGroup | null, window: string): QuotaBucket | null {
  return (
    group?.buckets.find((bucket) => bucket.window.trim().toLowerCase() === window && !bucket.disabled) ??
    null
  );
}

/**
 * Extracts only the Gemini quota group's active 5-hour and weekly buckets.
 * Returns `null` when no Gemini group or neither window is available.
 */
export function extractGeminiQuota(
  groups: readonly QuotaGroup[] | null | undefined,
): GeminiQuotaPair | null {
  if (!groups || groups.length === 0) return null;
  const group = geminiGroup(groups);
  if (!group) return null;
  const fiveHour = activeBucketFor(group, "5h");
  const weekly = activeBucketFor(group, "weekly");
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly };
}
