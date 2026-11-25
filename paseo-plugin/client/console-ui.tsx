/**
 * Shared React Native UI primitives for the DSH console and upgraded timeline
 * cards.
 *
 * Built exclusively from React Native primitives + Paseo's `@getpaseo/plugin/client/ui`
 * `Icon` (which resolves Lucide icons by name or inline SVG). Zero third-party
 * dependencies and zero browser-only APIs.
 *
 * @module dsh-paseo/client/console-ui
 */
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { tokens, upper } from "./console-format";
import {
  font,
  radius,
  space,
  tabular,
  tint,
  toneColor,
  type Colors,
  type Tone,
  type ToneColors,
} from "./console-theme";

type PressState = { pressed: boolean; hovered?: boolean };

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

function renderIcon(icon: string | ReactNode | undefined, size: number, color: string): ReactNode {
  if (icon === undefined || icon === null || icon === false || icon === "") return null;
  if (typeof icon === "string") {
    return <Icon name={icon} size={size} color={color} />;
  }
  return icon;
}

export interface CardProps {
  colors: Pick<Colors, "border" | "surface1">;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  elevated?: boolean;
  testID?: string;
}

export function Card({ colors, children, style, elevated = false, testID }: CardProps) {
  return (
    <View
      testID={testID}
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

export interface BadgeProps {
  colors: ToneColors & Pick<Colors, "foreground">;
  label: string;
  tone?: Tone;
  dot?: boolean;
  /** Lucide icon name (rendered via Paseo `Icon`) or a custom ReactNode (e.g. a status ring). */
  icon?: string | ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Borderless soft-tinted status pill with optional leading dot or icon. */
export function Badge({
  colors,
  label,
  tone = "neutral",
  dot = false,
  icon,
  style,
  testID,
}: BadgeProps) {
  const color = toneColor(colors, tone);
  const ink = tone === "neutral" ? colors.foregroundMuted : color;
  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingHorizontal: space.sm,
          height: 22,
          borderRadius: radius.pill,
          backgroundColor: tone === "neutral" ? tint(colors.foreground, 0.06) : tint(color, 0.13),
        },
        style,
      ]}
    >
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} /> : null}
      {renderIcon(icon, 12, ink)}
      <Text numberOfLines={1} style={{ ...font.caption, fontWeight: "500", color: ink }}>
        {label}
      </Text>
    </View>
  );
}

export interface ButtonProps {
  colors: Colors;
  label?: string;
  /** Lucide icon name or custom icon element. */
  icon?: string | ReactNode;
  onPress(): void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Button({
  colors,
  label = "",
  icon,
  onPress,
  variant = "secondary",
  size = "md",
  loading = false,
  disabled = false,
  accessibilityLabel,
  style,
  testID,
}: ButtonProps) {
  const inactive = disabled || loading;
  const hasLabel = label.length > 0;
  const foreground =
    variant === "primary"
      ? colors.accentForeground
      : variant === "danger"
        ? colors.statusDanger
        : colors.foreground;

  const background = (state: PressState): string => {
    const active = !inactive && (state.pressed || Boolean(state.hovered));
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
  const iconSize = size === "sm" ? 14 : 16;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={(state) => [
        {
          height,
          paddingHorizontal: hasLabel ? (size === "sm" ? space.md : space.lg) : 0,
          width: hasLabel ? undefined : height,
          borderRadius: radius.md,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space.sm - 2,
          backgroundColor: background(state as PressState),
          borderWidth: variant === "secondary" ? 1 : 0,
          borderColor: colors.border,
          opacity: disabled ? 0.45 : variant === "primary" && (state as PressState).pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : (
        renderIcon(icon, iconSize, foreground)
      )}
      {hasLabel ? (
        <Text
          numberOfLines={1}
          style={{
            ...(size === "sm" ? font.small : font.body),
            color: foreground,
            fontWeight: "500",
          }}
        >
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

export interface IconButtonProps {
  colors: ToneColors & Pick<Colors, "foreground">;
  icon: string | ReactNode;
  label: string;
  onPress(): void;
  active?: boolean;
  loading?: boolean;
  disabled?: boolean;
  tone?: Tone;
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
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
  size = 32,
  style,
  testID,
}: IconButtonProps) {
  const color = tone === "neutral" ? colors.foregroundMuted : toneColor(colors, tone);
  const inactive = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading, expanded: active }}
      disabled={inactive}
      onPress={onPress}
      style={(state) => [
        {
          width: size,
          height: size,
          borderRadius: radius.md,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.4 : 1,
          backgroundColor:
            active || (!inactive && ((state as PressState).pressed || Boolean((state as PressState).hovered)))
              ? tint(colors.foreground, 0.07)
              : "transparent",
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={color} /> : renderIcon(icon, 16, color)}
    </Pressable>
  );
}

function defaultCalloutIcon(tone: Tone): string {
  switch (tone) {
    case "danger":
      return "CircleAlert";
    case "warning":
      return "TriangleAlert";
    case "success":
      return "CircleCheck";
    default:
      return "Info";
  }
}

export interface CalloutProps {
  colors: ToneColors & Pick<Colors, "foreground">;
  tone: Tone;
  /** Lucide icon name or custom icon element; defaults to a semantic icon for `tone`. */
  icon?: string | ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Callout({
  colors,
  tone,
  icon,
  title,
  children,
  action,
  style,
  testID,
}: CalloutProps) {
  const color = toneColor(colors, tone);
  const resolvedIcon = icon === undefined ? defaultCalloutIcon(tone) : icon;
  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: "row",
          gap: space.md,
          padding: space.md,
          borderRadius: radius.md,
          backgroundColor: tint(color, tone === "neutral" ? 0.07 : 0.1),
          alignItems: "flex-start",
        },
        style,
      ]}
    >
      <View style={{ paddingTop: 1 }}>{renderIcon(resolvedIcon, 16, color)}</View>
      <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
        <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>{title}</Text>
        {children}
        {action ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs }}>
            {action}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export interface BarProps {
  colors: ToneColors & Pick<Colors, "foreground">;
  /** Fill fraction in `[0, 1]`; values outside the range are clamped. */
  fraction: number;
  tone: Tone;
  height?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Single-metric progress bar whose track carries a light step of the fill tone. */
export function Bar({ colors, fraction, tone, height = 6, style, testID }: BarProps) {
  const clamped = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const width = `${clamped * 100}%` as const;
  const fill = toneColor(colors, tone);
  const track = tone === "neutral" ? tint(colors.foreground, 0.08) : tint(fill, 0.16);
  return (
    <View
      testID={testID}
      style={[
        { height, borderRadius: height / 2, backgroundColor: track, overflow: "hidden" },
        style,
      ]}
    >
      <View style={{ height, width, borderRadius: height / 2, backgroundColor: fill }} />
    </View>
  );
}

export interface TokenBarLabels {
  readonly cached: string;
  readonly input: string;
  readonly output: string;
}

export interface TokenBarProps {
  colors: Pick<Colors, "accent" | "statusSuccess" | "foregroundMuted">;
  cached: number;
  input: number;
  output: number;
  /** Legend labels; defaults to English (`"Cached"`, `"Input"`, `"Output"`). */
  labels?: TokenBarLabels;
  /** Bar thickness in px (default `6`). */
  height?: number;
  /** Show the 3-swatch legend row beneath the bar (default `true`). */
  showLegend?: boolean;
  /** Formatter for legend values (default `tokens()`). */
  formatValue?: (value: number) => string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const DEFAULT_TOKEN_BAR_LABELS: TokenBarLabels = {
  cached: "Cached",
  input: "Input",
  output: "Output",
};

/**
 * 3-segment stacked bar showing token composition:
 * cached input (`accent` at 35%), fresh input (`accent` at 100%), and output
 * (`statusSuccess`), with an optional tabular legend.
 */
export function TokenBar({
  colors,
  cached,
  input,
  output,
  labels = DEFAULT_TOKEN_BAR_LABELS,
  height = 6,
  showLegend = true,
  formatValue = tokens,
  style,
  testID,
}: TokenBarProps) {
  const safeCached = Number.isFinite(cached) && cached > 0 ? cached : 0;
  const safeInput = Number.isFinite(input) && input > 0 ? input : 0;
  const safeOutput = Number.isFinite(output) && output > 0 ? output : 0;
  const total = safeCached + safeInput + safeOutput;
  if (total <= 0) return null;

  const parts = [
    { key: "cached", label: labels.cached, value: safeCached, color: tint(colors.accent, 0.35) },
    { key: "input", label: labels.input, value: safeInput, color: colors.accent },
    { key: "output", label: labels.output, value: safeOutput, color: colors.statusSuccess },
  ] as const;

  return (
    <View testID={testID} style={[{ gap: space.xs }, style]}>
      <View
        style={{
          flexDirection: "row",
          height,
          borderRadius: height / 2,
          overflow: "hidden",
          gap: 2,
        }}
      >
        {parts.map((part) =>
          part.value > 0 ? (
            <View
              key={part.key}
              style={{ flex: part.value / total, backgroundColor: part.color }}
            />
          ) : null,
        )}
      </View>
      {showLegend ? (
        <View style={{ flexDirection: "row", gap: space.lg, flexWrap: "wrap" }}>
          {parts.map((part) => (
            <View key={part.key} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <View
                style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: part.color }}
              />
              <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                {part.label} {formatValue(part.value)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: string | ReactNode;
  readonly disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  colors: Pick<Colors, "surface0" | "border" | "foreground" | "foregroundMuted">;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange(next: T): void;
  size?: ButtonSize;
  /** Stretch options evenly across the available width. */
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SegmentedControl<T extends string>({
  colors,
  value,
  options,
  onChange,
  size = "sm",
  fullWidth = false,
  style,
  testID,
}: SegmentedControlProps<T>) {
  const height = size === "md" ? 32 : 28;
  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      style={[
        {
          flexDirection: "row",
          flexWrap: fullWidth ? "nowrap" : "wrap",
          ...(fullWidth ? { width: "100%" } : { flexShrink: 0 }),
          padding: 2,
          borderRadius: radius.md,
          backgroundColor: tint(colors.foreground, 0.06),
        },
        style,
      ]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const disabled = Boolean(option.disabled);
        const ink = selected ? colors.foreground : colors.foregroundMuted;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={(state) => ({
              ...(fullWidth ? { flex: 1, minWidth: 0 } : { flexShrink: 0 }),
              paddingHorizontal: space.md,
              height,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: space.xs,
              borderRadius: radius.sm,
              backgroundColor: selected
                ? colors.surface0
                : !disabled && Boolean((state as PressState).hovered)
                  ? tint(colors.foreground, 0.05)
                  : "transparent",
              borderWidth: 1,
              borderColor: selected ? colors.border : "transparent",
              opacity: disabled ? 0.45 : 1,
            })}
          >
            {renderIcon(option.icon, 14, ink)}
            <Text
              numberOfLines={1}
              style={{
                ...font.small,
                fontWeight: selected ? "600" : "400",
                color: ink,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const FADE_STOPS = [0.2, 0.45, 0.7, 0.88, 1] as const;

export interface ExpandableProps {
  colors: Pick<Colors, "accent">;
  /** Clipped height in px; a multiple of the content's lineHeight keeps cuts between lines. */
  height: number;
  /** Surface color behind the content, used for the 5-layer bottom fade mask. */
  background: string;
  /** Toggle label when collapsed (default `"Show more"`). */
  expandLabel?: string;
  /** Toggle label when expanded (default `"Show less"`). */
  collapseLabel?: string;
  /** Initial expanded state for uncontrolled usage (default `false`). */
  defaultOpen?: boolean;
  /** Controlled expanded state; pair with `onOpenChange`. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: ReactNode;
}

/**
 * Clips tall content to `height` with real `onLayout` overflow detection, a
 * 5-layer fade mask matching `background`, and an expand/collapse toggle shown
 * only when the content actually overflows.
 */
export function Expandable({
  colors,
  height,
  background,
  expandLabel = "Show more",
  collapseLabel = "Show less",
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  style,
  testID,
  children,
}: ExpandableProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [contentHeight, setContentHeight] = useState(0);

  const isOpen = controlledOpen ?? uncontrolledOpen;
  const overflows = contentHeight > height + 1;
  const bandHeight = Math.max(3, Math.min(6, Math.floor((height * 0.45) / FADE_STOPS.length)));

  const handleToggle = (event: GestureResponderEvent) => {
    event?.stopPropagation?.();
    const next = !isOpen;
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <View testID={testID} style={style}>
      <View style={{ maxHeight: isOpen ? undefined : height, overflow: "hidden" }}>
        <View
          onLayout={(event) => {
            const measured = event.nativeEvent.layout.height;
            setContentHeight((prev) => (Math.abs(prev - measured) < 0.5 ? prev : measured));
          }}
        >
          {children}
        </View>
        {overflows && !isOpen ? (
          <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
            {FADE_STOPS.map((alpha) => (
              <View
                key={alpha}
                style={{ height: bandHeight, backgroundColor: tint(background, alpha) }}
              />
            ))}
          </View>
        ) : null}
      </View>
      {overflows ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: isOpen }}
          hitSlop={6}
          onPress={handleToggle}
          style={{ paddingTop: space.xs, alignSelf: "flex-start" }}
        >
          <Text style={{ ...font.caption, fontWeight: "500", color: colors.accent }}>
            {isOpen ? collapseLabel : expandLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export interface DividerProps {
  colors: Pick<Colors, "border">;
  style?: StyleProp<ViewStyle>;
}

export function Divider({ colors, style }: DividerProps) {
  return <View style={[{ height: 1, backgroundColor: colors.border }, style]} />;
}

export interface MutedProps {
  colors: Pick<Colors, "foregroundMuted">;
  children: ReactNode;
  small?: boolean;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
}

export function Muted({ colors, children, small = false, numberOfLines, style }: MutedProps) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[{ ...(small ? font.caption : font.small), color: colors.foregroundMuted }, style]}
    >
      {children}
    </Text>
  );
}

/** First visible character of a label (handles CJK and surrogate pairs). */
function initial(label: string): string {
  const first = Array.from(label.trim())[0] ?? "?";
  return upper(first);
}

/** Stable readable hue derived from a seed string (skips status reds). */
export function hueFor(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const palette = [212, 262, 190, 152, 32, 330, 236, 172];
  return palette[hash % palette.length]!;
}

export interface AvatarProps {
  colors: Pick<Colors, "surface0" | "border" | "foreground" | "accent">;
  label: string;
  /** Inline SVG markup drawn on a neutral tile instead of an initial. */
  logo?: string;
  /** Lucide icon name or custom mark element drawn on a neutral tile. */
  icon?: string | ReactNode;
  hue?: number;
  size?: number;
}

export function Avatar({ colors, label, logo, icon, hue, size = 40 }: AvatarProps) {
  if (logo || icon) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.3),
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface0,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        {logo ? (
          <Icon icon={{ svg: logo }} size={Math.round(size * 0.6)} color={colors.foreground} />
        ) : (
          renderIcon(icon, Math.round(size * 0.56), colors.foreground)
        )}
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
      <Text style={{ fontSize: Math.round(size * 0.42), fontWeight: "600", color: ink }}>
        {initial(label)}
      </Text>
    </View>
  );
}
