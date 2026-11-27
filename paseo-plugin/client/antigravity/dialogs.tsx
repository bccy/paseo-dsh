import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, SettingsSelect, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  RECOVERY_FOLDER_NAME,
  migrateAccountAgentsRpc,
  recoverSavedFilesRpc,
  savedFilesRpc,
  type AccountSummary,
  type SavedFiles,
} from "../../shared/antigravity/contracts";
import type { ObservedAgent } from "./agents";
import { displayLabel } from "./labels";
import { errorMessage, useAntigravityTranslation } from "./messages";
import { font, mono, radius, space, tint, type Colors } from "./theme";
import { Badge, Button, Callout, Divider, Muted } from "./ui";

export function NameDialog({
  colors,
  title,
  body,
  initial,
  confirmLabel,
  onSubmit,
  onClose,
}: {
  colors: Colors;
  title: string;
  body?: string;
  initial: string;
  confirmLabel: string;
  onSubmit(name: string): Promise<void>;
  onClose(): void;
}) {
  const { t } = useAntigravityTranslation();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = name.trim().length > 0 && name.trim() !== initial.trim();

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(name.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }

  return (
    <Modal open title={title} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        {body ? <Muted colors={colors}>{body}</Muted> : null}
        <View style={{ gap: space.xs + 2 }}>
          <Text style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>{t("dialog.name")}</Text>
          <TextInput
            accessibilityLabel={t("dialog.name")}
            autoFocus
            maxLength={40}
            value={name}
            editable={!busy}
            onChangeText={setName}
            onSubmitEditing={() => void save()}
            placeholder={t("dialog.namePlaceholder")}
            placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
            style={{
              ...font.body,
              color: colors.foreground,
              backgroundColor: colors.surface0,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.md,
              paddingHorizontal: space.md,
              paddingVertical: space.sm + 2,
            }}
          />
        </View>
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={onClose} />
          <Button colors={colors} variant="primary" label={confirmLabel} loading={busy} disabled={!valid} onPress={() => void save()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Names shown in the Remove / Recover dialog before "and N more". */
const SHOWN_FILES = 6;

function SavedList({ colors, items }: { colors: Colors; items: string[] }) {
  const { t } = useAntigravityTranslation();
  // "and 1 more" takes the same line the last name would.
  const shown = items.length > SHOWN_FILES + 1 ? items.slice(0, SHOWN_FILES) : items;
  const rest = items.length - shown.length;
  return (
    <View style={{ gap: space.xxs }}>
      {shown.map((item) => (
        <Text key={item} numberOfLines={1} style={{ ...font.caption, fontFamily: mono, color: colors.foregroundMuted }}>
          {item}
        </Text>
      ))}
      {rest > 0 ? <Muted colors={colors} small>{t("dialog.removeMore", { count: rest })}</Muted> : null}
    </View>
  );
}

export function ConfirmRemove({
  colors,
  accountId,
  label,
  onConfirm,
  onClose,
}: {
  colors: Colors;
  accountId: string;
  label: string;
  onConfirm(): Promise<void>;
  onClose(): void;
}) {
  const { t } = useAntigravityTranslation();
  const listSaved = useRpc(savedFilesRpc);
  // null while checking; "unknown" when the check failed (removal still moves the files).
  const [saved, setSaved] = useState<SavedFiles | "unknown" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    listSaved({ accountId }).then(
      (result) => live && setSaved(result),
      () => live && setSaved("unknown"),
    );
    return () => {
      live = false;
    };
  }, [accountId, listSaved]);

  return (
    <Modal open title={t("dialog.removeTitle", { label })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        <Muted colors={colors}>{t("dialog.removeBody")}</Muted>
        {/* The folder goes on a line of its own, so its spaces never split it. */}
        {saved === "unknown" ? (
          <Callout
            colors={colors}
            tone="neutral"
            icon="FolderInput"
            title={`${t("dialog.removeFilesUnknown")}\n~/${RECOVERY_FOLDER_NAME}`}
          />
        ) : saved && saved.items.length > 0 ? (
          <Callout
            colors={colors}
            tone="neutral"
            icon="FolderInput"
            title={`${t("dialog.removeFiles", { count: saved.items.length })}\n${saved.folder}`}
          >
            <SavedList colors={colors} items={saved.items} />
          </Callout>
        ) : null}
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={onClose} />
          <Button
            colors={colors}
            variant="danger"
            icon="Trash2"
            label={t("dialog.removeConfirm")}
            loading={busy}
            disabled={saved === null}
            onPress={() => {
              setBusy(true);
              setError("");
              void onConfirm().catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : String(reason));
                setBusy(false);
              });
            }}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Shows files agents created directly in a profile HOME and lets the user move them out safely. */
export function RecoverFilesDialog({
  colors,
  account,
  onClose,
}: {
  colors: Colors;
  account: AccountSummary;
  onClose(): void;
}) {
  const { t } = useAntigravityTranslation();
  const toast = useToast();
  const listSaved = useRpc(savedFilesRpc);
  const recover = useRpc(recoverSavedFilesRpc);
  const [saved, setSaved] = useState<SavedFiles | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = displayLabel(account.label, t, account.kind);

  useEffect(() => {
    let live = true;
    setLoading(true);
    listSaved({ accountId: account.id }).then(
      (result) => {
        if (!live) return;
        setSaved(result);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!live) return;
        setError(errorMessage(reason));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [account.id, listSaved]);

  async function onRecover() {
    setBusy(true);
    setError("");
    try {
      const { moved } = await recover({ accountId: account.id });
      if (moved) {
        const copiedCount = moved.copied?.length ?? 0;
        const movedCount = Math.max(0, moved.items.length - copiedCount);
        const message =
          copiedCount === 0
            ? t("dialog.removedMoved", { count: moved.items.length, folder: moved.folder })
            : movedCount === 0
              ? t("dialog.recoverCopied", { count: copiedCount, folder: moved.folder })
              : t("dialog.recoverMixed", { moved: movedCount, copied: copiedCount, folder: moved.folder });
        toast.show(message, {
          variant: "success",
          durationMs: copiedCount > 0 ? 10_000 : 8000,
        });
      }
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  return (
    <Modal open title={t("dialog.recoverTitle", { label })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        {loading ? (
          <Muted colors={colors}>{t("loading")}</Muted>
        ) : saved && saved.items.length > 0 ? (
          <>
            <Muted colors={colors}>{t("dialog.recoverBody")}</Muted>
            <Callout
              colors={colors}
              tone="neutral"
              icon="FolderInput"
              title={`${t("dialog.recoverFiles", { count: saved.items.length })}\n${saved.folder}`}
            >
              <SavedList colors={colors} items={saved.items} />
            </Callout>
          </>
        ) : !error ? (
          <Muted colors={colors}>{t("dialog.recoverEmpty")}</Muted>
        ) : null}
        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.close")} disabled={busy} onPress={onClose} />
          {saved && saved.items.length > 0 ? (
            <Button
              colors={colors}
              variant="primary"
              icon="FolderInput"
              label={t("dialog.recoverConfirm")}
              loading={busy}
              onPress={() => void onRecover()}
            />
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Lists active agents running on an account and offers one-click bulk migration to another account. */
export function AccountAgentsDialog({
  colors,
  account,
  accounts,
  agents,
  onOpenAgent,
  onClose,
}: {
  colors: Colors;
  account: AccountSummary;
  accounts: readonly AccountSummary[];
  agents: readonly ObservedAgent[];
  onOpenAgent?: (agentId: string) => void;
  onClose(): void;
}) {
  const { t } = useAntigravityTranslation();
  const toast = useToast();
  const migrate = useRpc(migrateAccountAgentsRpc);
  const label = displayLabel(account.label, t, account.kind);
  const targets = accounts.filter(
    (entry) => entry.id !== account.id && entry.usable && entry.status !== "signed-out",
  );
  const [targetId, setTargetId] = useState<string>(targets[0]?.id ?? "");
  const [mode, setMode] = useState<"after-turn" | "idle-only" | "now">("after-turn");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!targets.some((entry) => entry.id === targetId)) {
      setTargetId(targets[0]?.id ?? "");
    }
  }, [targets, targetId]);

  async function onMigrate() {
    if (!targetId || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await migrate({
        fromAccountId: account.id,
        toAccountId: targetId,
        mode,
      });
      const targetAccount = targets.find((entry) => entry.id === targetId);
      const summary = t("dialog.migrateDone", {
        label: displayLabel(result.targetLabel, t, targetAccount?.kind),
        switched: result.switched,
        scheduled: result.scheduled,
        skipped: result.skipped,
      });
      if (result.failed.length > 0) {
        setError(`${summary} ${t("dialog.migrateFailed", { count: result.failed.length })}`);
        setBusy(false);
      } else {
        toast.show(summary, { variant: "success", durationMs: 6000 });
        onClose();
      }
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  return (
    <Modal open title={t("dialog.agentsTitle", { label })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        {agents.length === 0 ? (
          <Muted colors={colors}>{t("dialog.agentsEmpty")}</Muted>
        ) : (
          <View style={{ gap: space.xs }}>
            {agents.map((member) => (
              <View
                key={member.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  paddingVertical: space.xs + 2,
                  paddingHorizontal: space.sm,
                  borderRadius: radius.md,
                  backgroundColor: colors.surface1,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              >
                <Icon name="Bot" size={14} color={member.running ? colors.accent : colors.foregroundMuted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ ...font.small, fontWeight: "500", color: colors.foreground }}>
                    {member.title?.trim() || member.id.slice(0, 12)}
                  </Text>
                  {member.model ? (
                    <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
                      {member.model}
                    </Text>
                  ) : null}
                </View>
                <Badge
                  colors={colors}
                  label={member.running ? t("dialog.agentsRunning") : t("dialog.agentsIdle")}
                  tone={member.running ? "accent" : "neutral"}
                  dot
                />
                {onOpenAgent ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("dialog.agentsOpen")}
                    onPress={() => {
                      onClose();
                      onOpenAgent(member.id);
                    }}
                    style={{ paddingHorizontal: space.sm, paddingVertical: space.xs }}
                  >
                    <Text style={{ ...font.caption, fontWeight: "600", color: colors.accent }}>
                      {t("dialog.agentsOpen")}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </View>
        )}

        {agents.length > 0 ? (
          <>
            <Divider colors={colors} />
            <Text style={{ ...font.heading, color: colors.foreground }}>{t("dialog.migrateHeading")}</Text>
            {targets.length === 0 ? (
              <Muted colors={colors}>{t("dialog.migrateNoTarget")}</Muted>
            ) : (
              <View style={{ gap: space.sm }}>
                <SettingsSelect
                  label={t("dialog.migrateTarget")}
                  value={targetId}
                  options={targets.map((entry) => ({
                    value: entry.id,
                    label: [displayLabel(entry.label, t, entry.kind), entry.plan].filter(Boolean).join(" · "),
                  }))}
                  onValueChange={setTargetId}
                  disabled={busy}
                />
                <SettingsSelect
                  label={t("dialog.migrateMode")}
                  value={mode}
                  options={[
                    { value: "after-turn", label: t("dialog.migrateModeAfterTurn") },
                    { value: "idle-only", label: t("dialog.migrateModeIdleOnly") },
                    { value: "now", label: t("dialog.migrateModeNow") },
                  ]}
                  onValueChange={(value) => setMode(value as "after-turn" | "idle-only" | "now")}
                  disabled={busy}
                />
              </View>
            )}
          </>
        ) : null}

        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}

        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.close")} disabled={busy} onPress={onClose} />
          {agents.length > 0 && targets.length > 0 ? (
            <Button
              colors={colors}
              variant="primary"
              icon="ArrowLeftRight"
              label={t("dialog.migrateAction")}
              loading={busy}
              onPress={() => void onMigrate()}
            />
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}
