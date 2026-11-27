import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon, useToast, type ToastApi } from "@getpaseo/plugin/client/ui";
import { useEffect, useState, type ComponentType } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { AccountSummary, QuotaBucket } from "../../shared/antigravity/contracts";
import { tabular } from "../console-theme";
import {
  FACTS_FONT_SIZE,
  MARK_BOX,
  ROW_GAP,
  TITLE_FONT_SIZE,
  popoverRootBox,
  rowActiveFill,
  rowBox,
} from "../jobs-popover-layout";
import { PopoverHairline } from "../popover-ui";
import { extractGeminiQuota } from "./accountQuota";
import { percent } from "./format";
import { displayLabel } from "./labels";
import { useAntigravityTranslation } from "./messages";
import { remainingTone, tint, type Colors } from "./theme";
import { Bar } from "./ui";

type HoverState = PressableStateCallbackType & { hovered?: boolean };

export interface AccountPopoverSnapshot {
  readonly accounts: readonly AccountSummary[];
  readonly currentAccountId: string;
  readonly running: boolean;
}

export interface AccountPopoverOptions {
  readonly agentId: string;
  readonly read: () => AccountPopoverSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly onSwitch: (account: AccountSummary, when: "now" | "after-turn", toast?: ToastApi) => void;
  readonly onManage: () => void;
}

function extraMutedColor(colors: Colors): string {
  return (colors as Record<string, string>).foregroundExtraMuted ?? colors.foregroundMuted;
}

function InlineQuotaMeter({
  colors,
  label,
  bucket,
  locale,
}: {
  colors: Colors;
  label: string;
  bucket: QuotaBucket;
  locale: string;
}) {
  const fraction = bucket.remainingFraction;
  const tone = remainingTone(fraction);
  const valueColor =
    tone === "danger"
      ? colors.statusDanger
      : tone === "warning"
        ? colors.statusWarning
        : colors.foregroundMuted;

  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: "500", color: colors.foregroundMuted }}>
        {label}
      </Text>
      <View style={{ flex: 1, minWidth: 20 }}>
        <Bar
          colors={colors}
          fraction={fraction ?? 0}
          tone={fraction === null ? "neutral" : tone}
          height={4}
        />
      </View>
      <Text
        numberOfLines={1}
        style={{
          fontSize: 11,
          ...tabular,
          fontWeight: tone === "warning" || tone === "danger" ? "600" : "500",
          minWidth: 30,
          textAlign: "right",
          color: valueColor,
        }}
      >
        {fraction === null ? "—" : percent(fraction, locale)}
      </Text>
    </View>
  );
}

/**
 * Frameless composer popover for switching an Antigravity agent's account,
 * showing Gemini's 5-hour and weekly remaining quota bars beneath each account.
 */
export function makeAccountPopover(
  options: AccountPopoverOptions,
): ComponentType<PluginButtonContentProps> {
  return function AccountPopover({ theme, layout, close }: PluginButtonContentProps) {
    const { t, locale } = useAntigravityTranslation();
    const toast = useToast();
    const [snapshot, setSnapshot] = useState<AccountPopoverSnapshot>(() => options.read());
    const [pendingId, setPendingId] = useState<string | null>(null);
    const { colors } = theme;
    const compact = layout.compact;
    const isZh = locale.toLowerCase().startsWith("zh");
    const fiveHourLabel = isZh ? "5小时" : "5h";
    const weeklyLabel = isZh ? "每周" : "7d";

    useEffect(() => {
      setSnapshot(options.read());
      return options.subscribe(() => setSnapshot(options.read()));
    }, []);

    const root = { ...popoverRootBox(), paddingBottom: 6 };
    const muted = extraMutedColor(colors);

    return (
      <View style={root}>
        {snapshot.accounts.map((account) => {
          const selected = account.id === snapshot.currentAccountId;
          const unavailable = !account.usable || account.status === "signed-out";
          const disabled = selected || unavailable;
          const label = displayLabel(account.label, t, account.kind);
          const titleLine = [
            label,
            account.kind === "profile" && account.status === "signed-out" ? null : account.email,
            account.plan,
          ]
            .filter(Boolean)
            .join(" · ");
          const gemini = !unavailable ? extractGeminiQuota(account.quota) : null;
          const confirming = snapshot.running && pendingId === account.id && !disabled;
          const iconName = selected ? "Check" : unavailable ? "UserX" : "UserRound";
          const iconColor = selected
            ? colors.foreground
            : unavailable
              ? muted
              : colors.foregroundMuted;

          return (
            <View key={account.id}>
              <Pressable
                disabled={disabled}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled, expanded: confirming }}
                accessibilityLabel={titleLine}
                onPress={() => {
                  if (disabled) return;
                  if (snapshot.running) {
                    setPendingId((prev) => (prev === account.id ? null : account.id));
                    return;
                  }
                  close();
                  options.onSwitch(account, "now", toast);
                }}
                style={({ hovered = false, pressed }: HoverState) => {
                  const fill = !disabled ? rowActiveFill(hovered, pressed) : undefined;
                  return [
                    {
                      ...rowBox({ compact }),
                      flexDirection: "column",
                      alignItems: "stretch",
                      gap: gemini ? 5 : 0,
                      paddingVertical: compact ? (gemini ? 8 : 9) : gemini ? 6 : 5,
                      opacity: unavailable ? 0.55 : 1,
                    },
                    fill === undefined ? undefined : { backgroundColor: colors[fill] },
                  ];
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: ROW_GAP }}>
                  <View style={{ width: MARK_BOX, height: MARK_BOX, alignItems: "center", justifyContent: "center" }}>
                    <Icon name={iconName} size={MARK_BOX} color={iconColor} />
                  </View>
                  <Text
                    numberOfLines={1}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: TITLE_FONT_SIZE,
                      fontWeight: selected ? "600" : "400",
                      color: unavailable ? muted : colors.foreground,
                    }}
                  >
                    {titleLine}
                  </Text>
                </View>

                {gemini ? (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      paddingLeft: MARK_BOX + ROW_GAP,
                    }}
                  >
                    {gemini.fiveHour ? (
                      <InlineQuotaMeter
                        colors={colors}
                        label={fiveHourLabel}
                        bucket={gemini.fiveHour}
                        locale={locale}
                      />
                    ) : null}
                    {gemini.weekly ? (
                      <InlineQuotaMeter
                        colors={colors}
                        label={weeklyLabel}
                        bucket={gemini.weekly}
                        locale={locale}
                      />
                    ) : null}
                  </View>
                ) : null}
              </Pressable>

              {confirming ? (
                <View
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 6,
                    paddingLeft: 12 + MARK_BOX + ROW_GAP,
                    paddingRight: 12,
                    paddingTop: 2,
                    paddingBottom: 6,
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setPendingId(null);
                      close();
                      options.onSwitch(account, "now", toast);
                    }}
                    style={({ hovered = false, pressed }: HoverState) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 5,
                      paddingHorizontal: 10,
                      paddingVertical: compact ? 6 : 4,
                      borderRadius: 999,
                      backgroundColor:
                        hovered || pressed ? tint(colors.accent, 0.22) : tint(colors.accent, 0.14),
                    })}
                  >
                    <Icon name="Zap" size={12} color={colors.accent} />
                    <Text style={{ fontSize: FACTS_FONT_SIZE, fontWeight: "500", color: colors.accent }}>
                      {t("now")}
                    </Text>
                  </Pressable>

                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setPendingId(null);
                      close();
                      options.onSwitch(account, "after-turn", toast);
                    }}
                    style={({ hovered = false, pressed }: HoverState) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 5,
                      paddingHorizontal: 10,
                      paddingVertical: compact ? 6 : 4,
                      borderRadius: 999,
                      backgroundColor: hovered || pressed ? colors.surface2 : colors.surface1,
                    })}
                  >
                    <Icon name="Clock" size={12} color={colors.foregroundMuted} />
                    <Text style={{ fontSize: FACTS_FONT_SIZE, fontWeight: "500", color: colors.foreground }}>
                      {t("after")}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        })}

        {snapshot.accounts.length > 0 ? <PopoverHairline theme={theme} marginVertical={4} /> : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("manage")}
          onPress={() => {
            close();
            options.onManage();
          }}
          style={({ hovered = false, pressed }: HoverState) => {
            const fill = rowActiveFill(hovered, pressed);
            return [rowBox({ compact }), fill === undefined ? undefined : { backgroundColor: colors[fill] }];
          }}
        >
          <View style={{ width: MARK_BOX, height: MARK_BOX, alignItems: "center", justifyContent: "center" }}>
            <Icon name="Settings2" size={MARK_BOX} color={colors.foregroundMuted} />
          </View>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: TITLE_FONT_SIZE,
              fontWeight: "400",
              color: colors.foreground,
            }}
          >
            {t("manage")}
          </Text>
        </Pressable>
      </View>
    );
  };
}
