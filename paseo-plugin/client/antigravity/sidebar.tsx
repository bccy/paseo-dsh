import { useTranslation, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import type { QuotaBucket, QuotaGroup } from "../../shared/antigravity/contracts";
import { percent } from "./format";
import { antigravityLogoSvg } from "./logo";
import { messages } from "./messages";
import { remainingTone, tabular, tint, type Colors } from "./theme";
import { Bar } from "./ui";
import { useAccounts } from "./useAccounts";

// Geometry follows the other footer rows (host status, built-in usage summary).
const FONT_SIZE = 12;
const ICON_SIZE = 14;

export interface QuotaSidebarItemOptions {
  readonly consoleScreenId: string;
  readonly onOpenAntigravity: () => void;
  readonly visible: boolean;
}

export type QuotaSidebarItemProps = PluginSidebarItemProps & QuotaSidebarItemOptions;

/** The quota group the sidebar summarizes: Gemini when present, else the first group. */
function primaryGroup(groups: readonly QuotaGroup[]): QuotaGroup | null {
  return groups.find((group) => /gemini/i.test(group.name) && !/argon/i.test(group.name)) ?? groups[0] ?? null;
}

function bucketFor(group: QuotaGroup | null, window: string): QuotaBucket | null {
  return group?.buckets.find((bucket) => bucket.window.trim().toLowerCase() === window && !bucket.disabled) ?? null;
}

function Meter({ colors, label, bucket, locale }: { colors: Colors; label: string; bucket: QuotaBucket | null; locale: string }) {
  const fraction = bucket?.remainingFraction ?? null;
  const tone = remainingTone(fraction);
  const warn = tone === "warning" || tone === "danger";
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text style={{ fontSize: FONT_SIZE, fontWeight: "600", color: colors.foregroundMuted }}>{label}</Text>
      <View style={{ flex: 1, minWidth: 16 }}>
        <Bar colors={colors} fraction={fraction ?? 0} tone={fraction === null ? "neutral" : tone} height={6} />
      </View>
      <Text
        numberOfLines={1}
        style={{
          fontSize: FONT_SIZE,
          ...tabular,
          width: 34,
          textAlign: "right",
          color: warn ? (tone === "danger" ? colors.statusDanger : colors.statusWarning) : colors.foreground,
        }}
      >
        {fraction === null ? "—" : percent(fraction, locale)}
      </Text>
    </View>
  );
}

function QuotaSidebarItemBody({
  theme,
  currentScreen,
  openScreen,
  consoleScreenId,
  onOpenAntigravity,
}: Omit<QuotaSidebarItemProps, "visible">) {
  const { colors } = theme;
  const { t, locale } = useTranslation(messages);
  const { data } = useAccounts();
  const account = data?.accounts.find((entry) => entry.id === data.defaultAccountId);
  const group = account?.quota ? primaryGroup(account.quota) : null;
  const fiveHour = bucketFor(group, "5h");
  const weekly = bucketFor(group, "weekly");
  const hasQuota = fiveHour !== null || weekly !== null;

  // Hide cleanly when agy is not installed, there are no added profile accounts, and no quota is present.
  if (data && !data.agyPath && data.accounts.length <= 1 && !hasQuota) {
    return null;
  }

  const active =
    currentScreen?.screenId === consoleScreenId &&
    currentScreen?.params?.tab === "antigravity";
  const describe = (bucket: QuotaBucket | null) =>
    bucket?.remainingFraction === null || bucket?.remainingFraction === undefined ? "—" : percent(bucket.remainingFraction, locale);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("sidebar.label", { fiveHour: describe(fiveHour), weekly: describe(weekly) })}
      onPress={() => {
        onOpenAntigravity();
        openScreen({ screenId: consoleScreenId, params: { tab: "antigravity" } });
      }}
      style={(state) => ({
        width: "100%",
        minHeight: 28,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 8,
        backgroundColor: active
          ? colors.surface2
          : (state as { hovered?: boolean }).hovered || state.pressed
            ? tint(colors.foreground, 0.05)
            : "transparent",
      })}
    >
      <Icon icon={{ svg: antigravityLogoSvg("sidebar") }} size={ICON_SIZE} color={colors.foregroundMuted} />
      <Meter colors={colors} label="5H" bucket={fiveHour} locale={locale} />
      <Meter colors={colors} label="7D" bucket={weekly} locale={locale} />
    </Pressable>
  );
}

/** Footer row: the default account's 5-hour and weekly quota left, as meters. Hidden when `!visible`. */
export function QuotaSidebarItem(props: QuotaSidebarItemProps) {
  if (!props.visible) return null;
  return <QuotaSidebarItemBody {...props} />;
}
