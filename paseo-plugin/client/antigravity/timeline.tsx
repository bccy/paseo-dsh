import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { FallbackEvent } from "../../shared/antigravity/contracts";
import { displayLabel } from "./labels";
import { useAntigravityTranslation } from "./messages";
import { font, space, tint } from "./theme";

/** One line in the agent's timeline: a retry, an account switch, or the end of the fallback chain. */
export function FallbackNote({ item, theme }: PluginTimelineItemProps<FallbackEvent>) {
  const { colors } = theme;
  const { t } = useAntigravityTranslation();
  const event = item.data;
  const from = displayLabel(event.from, t);
  const reason = t(`fallback.reason.${event.reason}`);
  const text =
    event.event === "switch"
      ? t("fallback.switch", { from, to: displayLabel(event.to ?? "", t), reason })
      : event.event === "retry"
        ? t("fallback.retry", { from, attempt: event.attempt, retries: event.retries })
        : t("fallback.exhausted");
  const icon = event.event === "switch" ? "ArrowLeftRight" : event.event === "retry" ? "RotateCcw" : "CircleAlert";
  const tone = event.event === "exhausted" ? colors.statusWarning : colors.foregroundMuted;
  const detail = event.message.trim();
  const showDetail = detail.length > 0 && (event.event !== "switch" || event.reason !== "quota");
  return (
    <View
      style={{
        flexDirection: "row",
        gap: space.sm,
        alignItems: "flex-start",
        paddingVertical: space.xs,
        paddingHorizontal: space.sm,
        borderRadius: 8,
        backgroundColor: event.event === "exhausted" ? tint(colors.statusWarning, 0.08) : "transparent",
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon name={icon} size={14} color={tone} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ ...font.small, color: colors.foreground }}>{text}</Text>
        {showDetail ? (
          <Text numberOfLines={2} selectable style={{ ...font.caption, color: colors.foregroundMuted }}>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
