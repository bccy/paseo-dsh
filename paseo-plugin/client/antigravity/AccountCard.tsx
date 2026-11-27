import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { Platform, Pressable, Text, View } from "react-native";
import type { AccountSummary, QuotaBucket, QuotaGroup } from "../../shared/antigravity/contracts";
import { percent, relative, upper } from "./format";
import { displayLabel } from "./labels";
import { antigravityLogoSvg } from "./logo";
import { useAntigravityTranslation } from "./messages";
import { font, radius, remainingTone, space, tabular, tint, toneColor, type Colors, type Tone } from "./theme";
import { Avatar, Badge, Bar, Button, Callout, Card, Divider, hueFor, IconButton, Muted } from "./ui";

export type CardAction =
  | "refresh"
  | "rename"
  | "makeDefault"
  | "moveUp"
  | "moveDown"
  | "toggleFallback"
  | "clearCooldown"
  | "orchestratorOverride"
  | "recoverFiles"
  | "manageAgents"
  | "signIn"
  | "signOut"
  | "remove";

function statusTone(account: AccountSummary): Tone {
  if (!account.usable) return "warning";
  switch (account.status) {
    case "signed-in":
      return "success";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

type KnownWindow = "weekly" | "5h" | "daily" | "monthly";

function windowName(bucket: QuotaBucket, siblings: readonly QuotaBucket[], named: (key: KnownWindow) => string): string {
  const key = bucket.window.trim().toLowerCase();
  const known = key === "weekly" || key === "5h" || key === "daily" || key === "monthly";
  const base = known ? named(key) : bucket.window;
  // Two buckets with the same period in one group (rare): tell them apart by name.
  const same = siblings.filter((other) => other.window.trim().toLowerCase() === key).length;
  return same > 1 ? `${base} · ${bucket.name}` : base;
}

function Meter({
  colors,
  bucket,
  label,
  now,
  locale,
}: {
  colors: Colors;
  bucket: QuotaBucket | null;
  label: string;
  now: number;
  locale: string;
}) {
  const { t } = useAntigravityTranslation();
  // An empty slot keeps a lone meter at half width, so groups line up across cards.
  if (!bucket) return <View style={{ flex: 1 }} />;
  const fraction = bucket.remainingFraction;
  const tone = bucket.disabled ? "neutral" : remainingTone(fraction);
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
        <Text numberOfLines={1} style={{ ...font.small, color: colors.foregroundMuted, flex: 1 }}>
          {label}
        </Text>
        <Text
          style={{
            ...font.small,
            ...tabular,
            fontWeight: "600",
            color: bucket.disabled
              ? colors.foregroundMuted
              : tone === "warning" || tone === "danger"
                ? toneColor(colors, tone)
                : colors.foreground,
          }}
        >
          {bucket.disabled ? t("off") : fraction === null ? "—" : percent(fraction, locale)}
        </Text>
      </View>
      <Bar colors={colors} fraction={bucket.disabled ? 0 : (fraction ?? 0)} tone={tone} height={5} />
      {/* Always one line tall, so cards with and without reset times line up. */}
      <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
        {bucket.resetTime && !bucket.disabled ? t("resets", { time: relative(bucket.resetTime, now, locale) }) : "\u00a0"}
      </Text>
    </View>
  );
}

function localizeQuotaGroupName(name: string, locale: string): string {
  if (!locale.toLowerCase().startsWith("zh")) return upper(name, locale);
  const normalized = name.trim().toLowerCase();
  if (normalized === "gemini models") return "Gemini 模型";
  if (normalized === "claude and gpt models") return "Claude 与 GPT 模型";
  if (normalized.endsWith(" models")) {
    return `${name.trim().slice(0, -7)} 模型`;
  }
  return name;
}

function QuotaGroupView({
  colors,
  group,
  now,
  locale,
  compact,
}: {
  colors: Colors;
  group: QuotaGroup;
  now: number;
  locale: string;
  compact: boolean;
}) {
  const { t: translate } = useAntigravityTranslation();
  const t = (key: KnownWindow) => translate(`window.${key}`);
  // Two meters per row: the usual pair is weekly and 5-hour.
  const rows: Array<[QuotaBucket, QuotaBucket | null]> = [];
  for (let index = 0; index < group.buckets.length; index += 2) {
    rows.push([group.buckets[index]!, group.buckets[index + 1] ?? null]);
  }
  return (
    <View style={{ gap: space.sm }}>
      <Text numberOfLines={1} style={{ ...font.overline, color: colors.foregroundMuted }}>
        {localizeQuotaGroupName(group.name, locale)}
      </Text>
      {rows.map(([left, right]) => (
        <View key={left.id} style={{ flexDirection: "row", gap: compact ? space.lg : space.xl }}>
          <Meter colors={colors} bucket={left} label={windowName(left, group.buckets, t)} now={now} locale={locale} />
          <Meter colors={colors} bucket={right} label={right ? windowName(right, group.buckets, t) : ""} now={now} locale={locale} />
        </View>
      ))}
    </View>
  );
}

function Menu({
  colors,
  title,
  useModal,
  items,
  onClose,
  onSelect,
}: {
  colors: Colors;
  title: string;
  useModal: boolean;
  items: Array<{ id: CardAction; label: string; icon: string; danger?: boolean }>;
  onClose(): void;
  onSelect(action: CardAction): void;
}) {
  if (useModal) {
    return (
      <Modal open title={title} onOpenChange={(open) => { if (!open) onClose(); }}>
        <Modal.Content>
          <View style={{ gap: 2 }}>
            {items.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="menuitem"
                onPress={() => onSelect(item.id)}
                style={(state) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.md,
                  paddingHorizontal: space.md,
                  minHeight: 42,
                  borderRadius: radius.md,
                  backgroundColor: state.pressed ? tint(colors.foreground, 0.08) : "transparent",
                })}
              >
                <Icon name={item.icon} size={17} color={item.danger ? colors.statusDanger : colors.foregroundMuted} />
                <Text style={{ ...font.body, color: item.danger ? colors.statusDanger : colors.foreground, flex: 1 }}>
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Modal.Content>
      </Modal>
    );
  }
  return (
    <Card
      colors={colors}
      elevated
      style={{ position: "absolute", top: 44, right: space.md, minWidth: 220, padding: space.xs, zIndex: 20, backgroundColor: colors.surface0 }}
    >
      {items.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="menuitem"
          onPress={() => onSelect(item.id)}
          style={(state) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm + 2,
            paddingHorizontal: space.md,
            height: 34,
            borderRadius: radius.sm,
            backgroundColor:
              state.pressed || (state as { hovered?: boolean }).hovered ? tint(colors.foreground, 0.07) : "transparent",
          })}
        >
          <Icon name={item.icon} size={15} color={item.danger ? colors.statusDanger : colors.foregroundMuted} />
          <Text style={{ ...font.small, color: item.danger ? colors.statusDanger : colors.foreground }}>{item.label}</Text>
        </Pressable>
      ))}
    </Card>
  );
}

export function AccountCard({
  account,
  colors,
  count,
  now,
  busy,
  compact,
  canMoveUp,
  canMoveDown,
  menuOpen,
  onToggleMenu,
  onAction,
}: {
  account: AccountSummary;
  colors: Colors;
  count: number | undefined;
  now: number;
  busy: CardAction | null;
  compact: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  menuOpen: boolean;
  onToggleMenu(): void;
  onAction(action: CardAction): void;
}) {
  const { t, locale } = useAntigravityTranslation();
  const isProfile = account.kind === "profile";
  const signedIn = account.status === "signed-in";
  const tone = statusTone(account);
  const statusLabel = account.usable ? t(`status.${account.status}`) : t("callout.unusableTitle");
  const name = displayLabel(account.label, t, account.kind);
  const justChecked = account.checkedAt !== null && now - Date.parse(account.checkedAt) < 45_000;
  const activeCooldowns = account.cooldowns.filter((item) => Date.parse(item.until) > now);

  const menuItems: Array<{ id: CardAction; label: string; icon: string; danger?: boolean }> = [
    { id: "rename", label: t("action.rename"), icon: "PenLine" },
  ];
  if (!account.isDefaultForNewAgents && account.usable) {
    menuItems.push({ id: "makeDefault", label: t("action.makeDefault"), icon: "Star" });
  }
  if (canMoveUp) menuItems.push({ id: "moveUp", label: t("action.moveUp"), icon: "ArrowUp" });
  if (canMoveDown) menuItems.push({ id: "moveDown", label: t("action.moveDown"), icon: "ArrowDown" });
  menuItems.push({
    id: "toggleFallback",
    label: account.fallbackEnabled ? t("action.disableFallback") : t("action.enableFallback"),
    icon: account.fallbackEnabled ? "ShieldOff" : "ShieldCheck",
  });
  if (activeCooldowns.length > 0) {
    menuItems.push({ id: "clearCooldown", label: t("action.clearCooldown"), icon: "Play" });
  }
  if (count !== undefined && count > 0) {
    menuItems.push({ id: "manageAgents", label: t("action.manageAgents"), icon: "Bot" });
  }
  if (isProfile) {
    menuItems.push({ id: "orchestratorOverride", label: t("action.orchestratorOverride"), icon: "Workflow" });
    menuItems.push({ id: "recoverFiles", label: t("action.recoverFiles"), icon: "FolderInput" });
    if (signedIn) menuItems.push({ id: "signIn", label: t("action.signInAgain"), icon: "LogIn" });
    if (account.status !== "signed-out") menuItems.push({ id: "signOut", label: t("action.signOut"), icon: "LogOut" });
    menuItems.push({ id: "remove", label: t("action.remove"), icon: "Trash2", danger: true });
  }

  const useModalMenu = compact || Platform.OS !== "web";
  return (
    <Card colors={colors} style={{ flexGrow: 1, zIndex: menuOpen && !useModalMenu ? 30 : 0, overflow: "visible" }}>
      <View style={{ flexGrow: 1, padding: space.lg, gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Avatar
            colors={colors}
            label={name}
            logo={isProfile ? undefined : antigravityLogoSvg(`card-${account.id}`)}
            hue={isProfile ? hueFor(account.id) : undefined}
          />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, height: 24 }}>
              <Text numberOfLines={1} style={{ ...font.heading, color: colors.foreground, flexShrink: 1 }}>
                {name}
              </Text>
              {account.isDefaultForNewAgents ? (
                <Badge colors={colors} label={t("badgeDefault")} tone="accent" icon="Star" />
              ) : null}
            </View>
            <Text numberOfLines={1} selectable style={{ ...font.small, color: colors.foregroundMuted }}>
              {(isProfile && account.status === "signed-out" ? null : account.email) ?? t(`kind.${account.kind}`)}
            </Text>
          </View>
          <IconButton colors={colors} icon="Ellipsis" label={t("action.more")} active={menuOpen} onPress={onToggleMenu} />
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2 }}>
          <Badge colors={colors} label={statusLabel} tone={tone} dot />
          {account.plan ? <Badge colors={colors} label={account.plan} icon="Sparkles" /> : null}
          <Badge colors={colors} label={t(`kind.${account.kind}`)} icon={isProfile ? "UserRound" : "KeyRound"} />
          {!account.fallbackEnabled ? <Badge colors={colors} label={t("badgeNoFallback")} icon="ShieldOff" /> : null}
          {account.orchestratorOverride ? (
            <Pressable accessibilityRole="button" onPress={() => onAction("orchestratorOverride")}>
              <Badge colors={colors} label={t("badgeCustomOrchestrator")} tone="accent" icon="Workflow" />
            </Pressable>
          ) : null}
          {count !== undefined ? (
            <Pressable
              accessibilityRole="button"
              disabled={count === 0}
              onPress={() => onAction("manageAgents")}
            >
              <Badge colors={colors} label={t("agents", { count })} tone={count > 0 ? "accent" : "neutral"} icon="Bot" />
            </Pressable>
          ) : null}
        </View>

        {activeCooldowns.length > 0 ? (
          <Callout
            colors={colors}
            tone="warning"
            icon="Clock"
            title={activeCooldowns
              .map((entry) =>
                t("badgeCooldown", {
                  pool: t(`cooldownPool.${entry.pool}`),
                  time: relative(entry.until, now, locale),
                }),
              )
              .join(" · ")}
            action={
              <Button
                colors={colors}
                size="sm"
                variant="secondary"
                icon="Play"
                label={t("clearCooldown")}
                loading={busy === "clearCooldown"}
                disabled={busy !== null}
                onPress={() => onAction("clearCooldown")}
              />
            }
          />
        ) : null}

        {!account.usable ? (
          <Callout colors={colors} tone="warning" icon="ShieldAlert" title={t("callout.unusableTitle")}>
            {account.statusDetail ? <Muted colors={colors}>{account.statusDetail}</Muted> : null}
          </Callout>
        ) : account.status === "signed-out" ? (
          <Callout
            colors={colors}
            tone="neutral"
            icon="LogIn"
            title={t("callout.signedOutTitle")}
            action={
              isProfile ? (
                <Button colors={colors} variant="primary" size="sm" icon="LogIn" label={t("action.signIn")} onPress={() => onAction("signIn")} />
              ) : undefined
            }
          >
            {isProfile ? null : <Muted colors={colors}>{t("callout.systemSignedOutBody")}</Muted>}
          </Callout>
        ) : account.status === "error" ? (
          <Callout colors={colors} tone="danger" icon="CircleAlert" title={t("callout.errorTitle")}>
            {account.statusDetail ? <Muted colors={colors}>{account.statusDetail}</Muted> : null}
          </Callout>
        ) : null}

        {signedIn && account.quota ? (
          <>
            <Divider colors={colors} />
            {account.quota.length === 0 ? (
              <Muted colors={colors}>{t("noQuota")}</Muted>
            ) : (
              <View style={{ gap: space.lg }}>
                {account.quota.map((group) => (
                  <QuotaGroupView key={group.name} colors={colors} group={group} now={now} locale={locale} compact={compact} />
                ))}
              </View>
            )}
          </>
        ) : null}

        {/* Auto margin pins the footer to the bottom of an equal-height card without an extra gap. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: "auto", paddingTop: space.xs }}>
          <View style={{ flex: 1 }}>
            <Muted colors={colors} small>
              {justChecked
                ? t("checkedJustNow")
                : account.checkedAt
                  ? t("checked", { time: relative(account.checkedAt, now, locale) })
                  : t("neverChecked")}
            </Muted>
          </View>
          <IconButton
            colors={colors}
            icon="RefreshCw"
            label={t("action.refresh")}
            loading={busy === "refresh"}
            disabled={busy !== null}
            onPress={() => onAction("refresh")}
          />
        </View>
      </View>
      {menuOpen ? (
        <Menu
          colors={colors}
          title={name}
          useModal={useModalMenu}
          items={menuItems}
          onClose={onToggleMenu}
          onSelect={onAction}
        />
      ) : null}
    </Card>
  );
}
