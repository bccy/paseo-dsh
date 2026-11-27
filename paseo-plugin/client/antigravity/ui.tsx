import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { upper } from "./format";
import { font, radius, space, tint, toneColor, type Colors, type Tone } from "./theme";

type PressState = { pressed: boolean; hovered?: boolean };

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  colors,
  label,
  icon,
  onPress,
  variant = "secondary",
  size = "md",
  loading = false,
  disabled = false,
  accessibilityLabel,
}: {
  colors: Colors;
  label: string;
  icon?: string;
  onPress(): void;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const inactive = disabled || loading;
  const foreground =
    variant === "primary" ? colors.accentForeground : variant === "danger" ? colors.statusDanger : colors.foreground;
  const background = (state: PressState) => {
    const active = !inactive && (state.pressed || state.hovered);
    switch (variant) {
      case "primary":
        return colors.accent;
      case "danger":
        return tint(colors.statusDanger, active ? 0.2 : 0.1);
      case "ghost":
        return active ? tint(colors.foreground, 0.07) : "transparent";
      default:
        return active ? tint(colors.foreground, 0.06) : colors.surface1;
    }
  };
  const height = size === "sm" ? 30 : 36;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={(state) => ({
        height,
        paddingHorizontal: label ? (size === "sm" ? space.md : space.lg) : 0,
        width: label ? undefined : height,
        borderRadius: radius.md,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm - 2,
        backgroundColor: background(state as PressState),
        borderWidth: variant === "secondary" ? 1 : 0,
        borderColor: colors.border,
        opacity: disabled ? 0.45 : variant === "primary" && (state as PressState).pressed ? 0.85 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : icon ? (
        <Icon name={icon} size={size === "sm" ? 14 : 16} color={foreground} />
      ) : null}
      {label ? (
        <Text numberOfLines={1} style={{ ...(size === "sm" ? font.small : font.body), color: foreground, fontWeight: "500" }}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function IconButton({
  colors,
  icon,
  label,
  onPress,
  active = false,
  loading = false,
  disabled = false,
  tone = "neutral",
}: {
  colors: Colors;
  icon: string;
  label: string;
  onPress(): void;
  active?: boolean;
  loading?: boolean;
  disabled?: boolean;
  tone?: Tone;
}) {
  const color = tone === "neutral" ? colors.foregroundMuted : toneColor(colors, tone);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading, expanded: active }}
      disabled={disabled || loading}
      onPress={onPress}
      style={(state) => ({
        width: 32,
        height: 32,
        borderRadius: radius.md,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : 1,
        backgroundColor:
          active || (state as PressState).pressed || (state as PressState).hovered
            ? tint(colors.foreground, 0.07)
            : "transparent",
      })}
    >
      {loading ? <ActivityIndicator size="small" color={color} /> : <Icon name={icon} size={16} color={color} />}
    </Pressable>
  );
}

export function Badge({
  colors,
  label,
  tone = "neutral",
  dot = false,
  icon,
}: {
  colors: Colors;
  label: string;
  tone?: Tone;
  dot?: boolean;
  icon?: string;
}) {
  const color = toneColor(colors, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: space.sm,
        height: 22,
        borderRadius: radius.pill,
        backgroundColor: tone === "neutral" ? tint(colors.foreground, 0.06) : tint(color, 0.13),
      }}
    >
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} /> : null}
      {icon ? <Icon name={icon} size={12} color={tone === "neutral" ? colors.foregroundMuted : color} /> : null}
      <Text
        numberOfLines={1}
        style={{ ...font.caption, fontWeight: "500", color: tone === "neutral" ? colors.foregroundMuted : color }}
      >
        {label}
      </Text>
    </View>
  );
}

/** First visible character of a label (handles CJK and emoji). */
function initial(label: string): string {
  const first = Array.from(label.trim())[0] ?? "?";
  return upper(first);
}

/** A stable, readable hue per account so accounts are easy to tell apart. */
export function hueFor(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  // Skip the reds (status colors) and keep hues that read well on light and dark surfaces.
  const palette = [212, 262, 190, 152, 32, 330, 236, 172];
  return palette[hash % palette.length]!;
}

export function Avatar({
  colors,
  label,
  logo,
  hue,
  size = 40,
}: {
  colors: Colors;
  label: string;
  /** Inline SVG drawn on a neutral tile instead of an initial. */
  logo?: string;
  hue?: number;
  size?: number;
}) {
  if (logo) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.3,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface0,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Icon icon={{ svg: logo }} size={Math.round(size * 0.6)} color={colors.foreground} />
      </View>
    );
  }
  const ink = hue === undefined ? colors.accent : `hsl(${hue}, 62%, 50%)`;
  const wash = hue === undefined ? tint(colors.accent, 0.16) : `hsla(${hue}, 62%, 50%, 0.16)`;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: wash,
      }}
    >
      <Text style={{ fontSize: Math.round(size * 0.42), fontWeight: "600", color: ink }}>{initial(label)}</Text>
    </View>
  );
}

export function Bar({ colors, fraction, tone, height = 6 }: { colors: Colors; fraction: number; tone: Tone; height?: number }) {
  const width = `${Math.max(0, Math.min(1, fraction)) * 100}%` as const;
  const fill = toneColor(colors, tone);
  // The track is a light step of the fill's own color, so the state reads across the whole bar.
  const track = tone === "neutral" ? tint(colors.foreground, 0.08) : tint(fill, 0.16);
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: track, overflow: "hidden" }}>
      <View style={{ height, width, borderRadius: height / 2, backgroundColor: fill }} />
    </View>
  );
}

export function Callout({
  colors,
  tone,
  icon,
  title,
  children,
  action,
}: {
  colors: Colors;
  tone: Tone;
  icon: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const color = toneColor(colors, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        gap: space.md,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: tint(color, tone === "neutral" ? 0.07 : 0.1),
        alignItems: "flex-start",
      }}
    >
      <View style={{ paddingTop: 1 }}>
        <Icon name={icon} size={16} color={color} />
      </View>
      <View style={{ flex: 1, gap: space.xs }}>
        <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>{title}</Text>
        {children}
        {action ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs }}>{action}</View> : null}
      </View>
    </View>
  );
}

export function Card({
  colors,
  children,
  style,
  elevated = false,
}: {
  colors: Colors;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  elevated?: boolean;
}) {
  return (
    <View
      style={[
        {
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.lg,
          backgroundColor: colors.surface1,
        },
        elevated
          ? {
              shadowColor: "#000",
              shadowOpacity: 0.12,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 8 },
              elevation: 6,
            }
          : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Divider({ colors }: { colors: Colors }) {
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}

export function Muted({ colors, children, small = false }: { colors: Colors; children: ReactNode; small?: boolean }) {
  return <Text style={{ ...(small ? font.caption : font.small), color: colors.foregroundMuted }}>{children}</Text>;
}
