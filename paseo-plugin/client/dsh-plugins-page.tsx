import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  PluginClientContext,
  PluginHostProps,
  PluginScreenProps,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import {
  Icon,
  Modal as HostModal,
  useToast as useHostToast,
  type ModalComponent,
  type ToastApi,
} from "@getpaseo/plugin/client/ui";
import {
  font,
  mono,
  radius,
  space,
  tabular,
  tint,
  type Colors,
} from "./console-theme";
import {
  Badge,
  Button,
  Callout,
  Card,
  Divider,
  Muted,
} from "./console-ui";
import type {
  DshPluginsFailureCode,
  DshPluginsText,
  Locale,
} from "./locale";
import { useCurrentLocale, useLocaleText } from "./use-locale";
import { PluginsBoundary, PluginsFailedCard } from "./dsh-plugins-guard";
import {
  inspectSpecRpc,
  jobStatusRpc,
  listRpc,
  setEnabledRpc,
  startJobRpc,
  type BundleInfo,
  type FailureCode,
  type InspectSpecOutput,
  type JobStatus,
  type PluginsSnapshot,
  type StartJobInput,
  type UpdateTarget,
} from "../shared/dsh-plugins-api";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];
type Styles = ReturnType<typeof createStyles>;

/** Delay between closing one native overlay/modal and opening another (iOS/Android safety). */
const MODAL_TRANSITION_MS = 180;

/** Maximum targets listed individually in the batch-update modal before summarizing the rest. */
const MAX_MODAL_TARGETS = 8;

interface UiFailure {
  code: DshPluginsFailureCode;
  detail?: string;
}

type ConfirmDialog =
  | { kind: "remove"; name: string; title?: string; version?: string }
  | { kind: "update"; name: string; title?: string; currentVersion?: string; version: string }
  | { kind: "update-all"; targets: readonly UpdateTarget[] };

interface PluginsExtraText {
  removeModalTitle: string;
  removeModalBody: (name: string) => string;
  updateModalTitle: string;
  updateModalBody: (name: string, targetVersion: string, currentVersion?: string) => string;
  updateAllModalTitle: string;
  updateAllModalBody: (count: number) => string;
  moreTargets: (count: number) => string;
  toastEnabled: (name: string) => string;
  toastDisabled: (name: string) => string;
  toastUpToDate: string;
}

const EXTRA_TEXT: Record<Locale, PluginsExtraText> = {
  "zh-CN": {
    removeModalTitle: "卸载插件",
    removeModalBody: (name) => `将从当前 DSH profile 中卸载「${name}」。`,
    updateModalTitle: "更新插件",
    updateModalBody: (name, targetVersion, currentVersion) =>
      currentVersion !== undefined && currentVersion !== ""
        ? `将「${name}」从 ${currentVersion} 更新到 ${targetVersion}。`
        : `将「${name}」更新到 ${targetVersion}。`,
    updateAllModalTitle: "批量更新插件",
    updateAllModalBody: (count) => `即将把以下 ${count} 个插件更新到最新版本：`,
    moreTargets: (count) => `其余 ${count} 项…`,
    toastEnabled: (name) => `已启用 ${name}`,
    toastDisabled: (name) => `已停用 ${name}`,
    toastUpToDate: "所有插件均为最新版本",
  },
  en: {
    removeModalTitle: "Remove plugin",
    removeModalBody: (name) => `Remove “${name}” from this DSH profile.`,
    updateModalTitle: "Update plugin",
    updateModalBody: (name, targetVersion, currentVersion) =>
      currentVersion !== undefined && currentVersion !== ""
        ? `Update “${name}” from ${currentVersion} to ${targetVersion}.`
        : `Update “${name}” to ${targetVersion}.`,
    updateAllModalTitle: "Update all plugins",
    updateAllModalBody: (count) =>
      `Update ${count} plugin${count === 1 ? "" : "s"} to the latest available versions:`,
    moreTargets: (count) => `and ${count} more…`,
    toastEnabled: (name) => `Enabled ${name}`,
    toastDisabled: (name) => `Disabled ${name}`,
    toastUpToDate: "All plugins are up to date",
  },
};

/**
 * Runtime check for Paseo's host `Modal` component (`>= 0.16.0` compatibility).
 * If an older host omits `Modal` or `Modal.Content`, confirmation falls back
 * cleanly to inline two-step buttons instead of crashing.
 */
function resolveHostModal(): ModalComponent | null {
  const candidate = HostModal as unknown;
  if (
    (typeof candidate === "function" || (typeof candidate === "object" && candidate !== null))
    && "Content" in (candidate as Record<string, unknown>)
  ) {
    const content = (candidate as { Content?: unknown }).Content;
    if (typeof content === "function" || (typeof content === "object" && content !== null)) {
      return candidate as ModalComponent;
    }
  }
  return null;
}

const NOOP_TOAST: ToastApi = {
  show() {},
  error() {},
};

/**
 * Guarded wrapper around Paseo's `useToast()` hook.
 * Calls `useHostToast` unconditionally when the runtime exports it so React's
 * hook order stays stable, and returns a no-op stub if absent or outside a
 * Toast provider.
 */
function useSafeToast(): ToastApi {
  if (typeof useHostToast !== "function") return NOOP_TOAST;
  try {
    const api = useHostToast();
    if (api && typeof api.show === "function" && typeof api.error === "function") {
      return api;
    }
  } catch {
    // Older host or test render without a toast provider.
  }
  return NOOP_TOAST;
}

function renderHostIcon(name: string, size: number, color: string) {
  if (typeof Icon !== "function" && (typeof Icon !== "object" || Icon === null)) return null;
  return <Icon name={name} size={size} color={color} />;
}

/**
 * The failure codes that cross the RPC boundary as a rejected error.
 *
 * A mutation returns its code in the output (`ok: false`), but a read or a job
 * poll rejects: Paseo carries the error's message, not a structured code, so
 * the page recovers the code by exact match. Anything else is `request-failed`
 * (transport, schema, a handler that threw before naming a code); an unknown
 * message must not be reported as a known failure.
 */
const FAILURE_CODES = new Set<string>([
  "profile-unreadable",
  "profile-invalid",
  "invalid-platform",
  "lock-timeout",
  "invalid-name",
  "protected",
  "not-installed",
  "not-a-bundle",
  "invalid-spec",
  "registry-unreadable",
  "registry-invalid",
  "already-installed",
  "not-removable",
  "not-in-dependencies",
  "invalid-version",
  "check-failed",
  "disposed",
  "busy",
  "job-missing",
  "spawn-failed",
  "command-failed",
  "request-failed",
]);

function failureOf(error: unknown): UiFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: FAILURE_CODES.has(message) ? message as FailureCode : "request-failed",
    ...(message === "" ? {} : { detail: message }),
  };
}

/**
 * Split one failure into its localized headline and optional verbatim tail.
 *
 * Raw `dsh`/pnpm output rides under the sentence only for the failures where it
 * explains something the sentence cannot (a command's exit tail, the platforms
 * a bundle lists, the raw request error); a wrong-but-plausible paragraph is
 * worse than a short sentence.
 */
function failureParts(
  text: DshPluginsText,
  failure: UiFailure,
): { headline: string; detail?: string } {
  const headline = text.errors[failure.code];
  if (
    failure.detail !== undefined
    && (failure.code === "command-failed"
      || failure.code === "check-failed"
      || failure.code === "invalid-platform"
      || failure.code === "request-failed")
  ) {
    return { headline, detail: failure.detail };
  }
  return { headline };
}

function tailLines(text: string, count: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-count).join("\n");
}

function actionOf(job: JobStatus, text: DshPluginsText): string {
  return job.kind === "install"
    ? text.job.installAction
    : job.kind === "remove"
      ? text.job.removeAction
      : job.kind === "update"
        ? text.job.updateAction
        : job.kind === "update-all"
          ? text.job.updateAllAction
          : text.job.checkAction;
}

function jobTitle(job: JobStatus, text: DshPluginsText): string {
  const action = actionOf(job, text);
  if (job.state === "running") return text.job.running(action);
  if (job.state === "failed") return text.job.failed(action);
  return text.job.succeeded(action);
}

function createStyles(colors: Colors, compact: boolean) {
  return {
    content: {
      padding: compact ? space.lg : space.xxl,
      paddingBottom: 40,
      gap: space.lg,
      width: "100%" as const,
      maxWidth: 880,
      alignSelf: "center" as const,
    },
    embeddedContent: {
      gap: space.lg,
      width: "100%" as const,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      justifyContent: "space-between" as const,
      gap: space.md,
      flexWrap: "wrap" as const,
    },
    headerText: { flex: 1, minWidth: 180, gap: space.xs },
    profileTitle: {
      ...font.heading,
      color: colors.foreground,
    },
    path: {
      ...font.caption,
      fontFamily: mono,
      color: colors.foregroundMuted,
    },
    notice: {
      ...font.caption,
      color: colors.foregroundMuted,
    },
    headerActions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: space.sm,
      flexWrap: "wrap" as const,
    },
    section: { gap: space.md - 2 },
    groupHeader: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: space.sm,
    },
    groupTitle: {
      ...font.heading,
      color: colors.foreground,
    },
    groupCountPill: {
      backgroundColor: tint(colors.foreground, 0.06),
      paddingHorizontal: space.sm,
      paddingVertical: space.xxs,
      borderRadius: radius.pill,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    groupCountText: {
      ...font.caption,
      ...tabular,
      fontWeight: "600" as const,
      color: colors.foregroundMuted,
    },
    cardBody: {
      padding: compact ? space.md : space.lg,
      gap: space.sm,
    },
    rowTop: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: space.sm,
      flexWrap: "wrap" as const,
    },
    name: {
      ...font.body,
      fontWeight: "600" as const,
      color: colors.foreground,
    },
    subtitle: {
      ...font.small,
      fontWeight: "500" as const,
      color: colors.foreground,
    },
    version: {
      ...font.caption,
      ...tabular,
      fontFamily: mono,
      color: colors.foregroundMuted,
    },
    description: {
      ...font.small,
      color: colors.foregroundMuted,
    },
    rowFooter: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: space.sm,
      flexWrap: "wrap" as const,
      marginTop: space.xxs,
    },
    rowActions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: space.sm,
      flexWrap: "wrap" as const,
    },
    disclosureButton: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: space.xs,
      paddingVertical: space.xs,
      paddingHorizontal: space.xs,
      borderRadius: radius.sm,
    },
    disclosureText: {
      ...font.caption,
      ...tabular,
      color: colors.foregroundMuted,
      fontWeight: "500" as const,
    },
    input: {
      ...font.body,
      color: colors.foreground,
      backgroundColor: colors.surface0,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.md,
      paddingHorizontal: space.md,
      paddingVertical: space.sm + 1,
      minHeight: 36,
    },
    inputRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: space.sm,
    },
    inputStack: { gap: space.sm },
    inputGrow: { flex: 1, minWidth: 0 },
    checkRow: {
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
    },
    resultRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      justifyContent: "space-between" as const,
      gap: space.sm,
    },
    resultAction: { marginLeft: "auto" as const },
    resultItem: { gap: space.xs },
    detailMono: {
      ...font.caption,
      fontFamily: mono,
      color: colors.statusDanger,
    },
    outputBox: {
      backgroundColor: tint(colors.foreground, 0.04),
      borderRadius: radius.md,
      padding: space.sm,
    },
    output: {
      ...font.caption,
      fontFamily: mono,
      color: colors.foregroundMuted,
    },
    rowTags: {
      flexDirection: "row" as const,
      gap: space.xs + 2,
      flexWrap: "wrap" as const,
    },
    tag: {
      backgroundColor: tint(colors.foreground, 0.06),
      borderRadius: radius.sm,
      paddingHorizontal: space.sm,
      paddingVertical: 3,
    },
    tagText: {
      ...font.caption,
      fontFamily: mono,
      color: colors.foregroundMuted,
    },
    infoBox: {
      backgroundColor: tint(colors.foreground, 0.04),
      borderRadius: radius.md,
      padding: space.md,
      gap: space.sm,
    },
    loadingCard: {
      padding: space.lg,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: space.md,
    },
    modalSummaryBox: {
      backgroundColor: tint(colors.foreground, 0.04),
      borderRadius: radius.md,
      padding: space.md,
      gap: space.xs,
    },
    modalActions: {
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
      alignItems: "center" as const,
      gap: space.sm,
      flexWrap: "wrap" as const,
    },
  };
}

function FailureCallout({
  colors,
  text,
  failure,
  styles,
  action,
}: {
  colors: Colors;
  text: DshPluginsText;
  failure: UiFailure;
  styles: Styles;
  action?: ReactNode;
}) {
  const parts = failureParts(text, failure);
  return (
    <Callout colors={colors} tone="danger" title={parts.headline} action={action}>
      {parts.detail === undefined ? null : (
        <Text selectable style={styles.detailMono}>{parts.detail}</Text>
      )}
    </Callout>
  );
}

function BundleRow({
  bundle,
  colors,
  text,
  styles,
  busy,
  toggleBusy,
  useModalConfirm,
  confirmRemove,
  confirmUpdate,
  onToggle,
  onRemove,
  onUpdate,
}: {
  bundle: BundleInfo;
  colors: Colors;
  text: DshPluginsText;
  styles: Styles;
  busy: boolean;
  toggleBusy: string | null;
  useModalConfirm: boolean;
  confirmRemove: string | null;
  confirmUpdate: { name: string; version: string } | null;
  onToggle: (bundle: BundleInfo) => void;
  onRemove: (bundle: BundleInfo | null) => void;
  onUpdate: (bundle: BundleInfo | null) => void;
}) {
  const isDependency = bundle.kind === "dependency";
  const canToggle = bundle.kind !== "dependency" && !bundle.protected;
  const isToggling = toggleBusy === bundle.name;
  const removePending = !useModalConfirm && confirmRemove === bundle.name;
  const updatePending = !useModalConfirm && confirmUpdate?.name === bundle.name;
  const rowBusy = busy || isToggling;
  // Disclosure only: a card lists its component ids when asked, not by default.
  // The state is render-local by design (no persistence, no RPC).
  const [rowsOpen, setRowsOpen] = useState(false);

  return (
    <Card colors={colors} style={styles.cardBody}>
      <View style={styles.rowTop}>
        <Text style={styles.name}>{bundle.name}</Text>
        {bundle.version === undefined ? null : <Text style={styles.version}>{bundle.version}</Text>}
        {bundle.official ? (
          <Badge colors={colors} tone="neutral" icon="ShieldCheck" label={text.badges.official} />
        ) : null}
        {bundle.protected ? (
          <Badge colors={colors} tone="accent" icon="Lock" label={text.badges.protected} />
        ) : null}
        {bundle.client ? (
          <Badge colors={colors} tone="warning" icon="Monitor" label={text.badges.client} />
        ) : null}
        {bundle.platformSupported ? null : (
          <Badge colors={colors} tone="danger" dot label={text.badges.platformUnsupported} />
        )}
        {bundle.installed ? null : (
          <Badge colors={colors} tone="danger" dot label={text.badges.missing} />
        )}
        {bundle.update === undefined ? null : (
          <Badge
            colors={colors}
            tone="warning"
            dot
            label={text.badges.updateAvailable(bundle.update)}
          />
        )}
      </View>

      {/* Package names stay the row's identity (the actions address them); a
          localized display title rides under it as a subtitle instead of
          replacing the name, so a third-party package remains recognizable. */}
      {bundle.title === undefined || bundle.title === ""
        ? null
        : <Text style={styles.subtitle}>{bundle.title}</Text>}
      {bundle.description === undefined || bundle.description === ""
        ? null
        : <Text style={styles.description}>{bundle.description}</Text>}

      {isDependency ? <Muted colors={colors}>{text.bundle.dependencyNote}</Muted> : null}
      {bundle.client ? <Muted colors={colors}>{text.bundle.clientNote}</Muted> : null}
      {bundle.platformSupported
        ? null
        : bundle.platformReason === undefined || bundle.platformReason === ""
          ? <Muted colors={colors}>{text.bundle.platformsUnknown}</Muted>
          : <Muted colors={colors}>{text.bundle.platforms(bundle.platformReason)}</Muted>}

      <View style={styles.rowFooter}>
        <View style={styles.rowActions}>
          {canToggle ? (
            <Switch
              accessibilityLabel={bundle.name}
              value={bundle.enabled}
              disabled={
                rowBusy
                || (!bundle.enabled && (bundle.installed === false || !bundle.platformSupported))
              }
              onValueChange={() => onToggle(bundle)}
              trackColor={{ false: colors.surface2, true: colors.accent }}
              thumbColor={bundle.enabled ? colors.accentForeground : colors.foreground}
            />
          ) : null}
          {isToggling ? <ActivityIndicator size="small" color={colors.accent} /> : null}

          {bundle.update === undefined ? null : updatePending ? (
            <>
              <Button
                colors={colors}
                size="sm"
                variant="primary"
                icon="ArrowUpCircle"
                label={text.bundle.confirmUpdate(bundle.update)}
                disabled={rowBusy}
                onPress={() => onUpdate(bundle)}
              />
              <Button
                colors={colors}
                size="sm"
                variant="ghost"
                label={text.bundle.cancel}
                disabled={rowBusy}
                onPress={() => onUpdate(null)}
              />
            </>
          ) : (
            <Button
              colors={colors}
              size="sm"
              variant="secondary"
              icon="ArrowUpCircle"
              label={text.bundle.update(bundle.update)}
              disabled={rowBusy}
              onPress={() => onUpdate(bundle)}
            />
          )}

          {bundle.removable ? (
            removePending ? (
              <>
                <Button
                  colors={colors}
                  size="sm"
                  variant="danger"
                  icon="Trash2"
                  label={text.bundle.confirmRemove}
                  disabled={rowBusy}
                  onPress={() => onRemove(bundle)}
                />
                <Button
                  colors={colors}
                  size="sm"
                  variant="ghost"
                  label={text.bundle.cancel}
                  disabled={rowBusy}
                  onPress={() => onRemove(null)}
                />
              </>
            ) : (
              <Button
                colors={colors}
                size="sm"
                variant="danger"
                icon="Trash2"
                label={text.bundle.remove}
                disabled={rowBusy}
                onPress={() => onRemove(bundle)}
              />
            )
          ) : null}
        </View>

        {/* Default-collapsed component list. The line itself is the toggle; a card
            with no rows shows nothing (a "0 components" row would be noise). */}
        {bundle.rows.length === 0 ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text.bundle.componentCount(bundle.rows.length)}
            accessibilityState={{ expanded: rowsOpen }}
            onPress={() => setRowsOpen((open) => !open)}
            style={styles.disclosureButton}
          >
            {renderHostIcon(
              rowsOpen ? "ChevronDown" : "ChevronRight",
              14,
              colors.foregroundMuted,
            )}
            <Text style={styles.disclosureText}>
              {text.bundle.componentCount(bundle.rows.length)}
            </Text>
          </Pressable>
        )}
      </View>

      {bundle.rows.length > 0 && rowsOpen ? (
        <>
          <Divider colors={colors} />
          <View style={styles.rowTags}>
            {bundle.rows.map((row) => (
              <View key={row.id} style={styles.tag}>
                <Text style={styles.tagText}>{row.id}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
    </Card>
  );
}

function ConfirmActionModal({
  ModalComponent,
  dialog,
  colors,
  text,
  extra,
  styles,
  busy,
  submitting,
  onConfirm,
  onClose,
}: {
  ModalComponent: ModalComponent;
  dialog: ConfirmDialog;
  colors: Colors;
  text: DshPluginsText;
  extra: PluginsExtraText;
  styles: Styles;
  busy: boolean;
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const locked = busy || submitting;
  const title = dialog.kind === "remove"
    ? extra.removeModalTitle
    : dialog.kind === "update"
      ? extra.updateModalTitle
      : extra.updateAllModalTitle;
  const modalIcon = dialog.kind === "remove"
    ? renderHostIcon("Trash2", 16, colors.statusDanger)
    : renderHostIcon("ArrowUpCircle", 16, colors.accent);

  const shownTargets = dialog.kind === "update-all"
    ? dialog.targets.length > MAX_MODAL_TARGETS + 1
      ? dialog.targets.slice(0, MAX_MODAL_TARGETS)
      : dialog.targets
    : [];
  const hiddenTargetCount = dialog.kind === "update-all"
    ? dialog.targets.length - shownTargets.length
    : 0;

  return (
    <ModalComponent
      open
      title={title}
      icon={modalIcon ?? undefined}
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <ModalComponent.Content>
        {dialog.kind === "remove" ? (
          <>
            <Muted colors={colors}>{extra.removeModalBody(dialog.name)}</Muted>
            <View style={styles.modalSummaryBox}>
              <View style={styles.rowTop}>
                <Text style={styles.name}>{dialog.name}</Text>
                {dialog.version === undefined ? null : (
                  <Text style={styles.version}>{dialog.version}</Text>
                )}
              </View>
              {dialog.title === undefined || dialog.title === "" || dialog.title === dialog.name ? null : (
                <Muted colors={colors} small>{dialog.title}</Muted>
              )}
            </View>
            <Muted colors={colors} small>{text.header.notice}</Muted>
            <View style={styles.modalActions}>
              <Button
                colors={colors}
                variant="ghost"
                label={text.bundle.cancel}
                disabled={submitting}
                onPress={onClose}
              />
              <Button
                colors={colors}
                variant="danger"
                icon="Trash2"
                label={text.bundle.confirmRemove}
                loading={submitting}
                disabled={locked}
                onPress={onConfirm}
              />
            </View>
          </>
        ) : dialog.kind === "update" ? (
          <>
            <Muted colors={colors}>
              {extra.updateModalBody(dialog.name, dialog.version, dialog.currentVersion)}
            </Muted>
            <View style={styles.modalSummaryBox}>
              <View style={styles.rowTop}>
                <Text style={styles.name}>{dialog.name}</Text>
                <Badge
                  colors={colors}
                  tone="warning"
                  dot
                  label={
                    dialog.currentVersion !== undefined && dialog.currentVersion !== ""
                      ? `${dialog.currentVersion} → ${dialog.version}`
                      : dialog.version
                  }
                />
              </View>
              {dialog.title === undefined || dialog.title === "" || dialog.title === dialog.name ? null : (
                <Muted colors={colors} small>{dialog.title}</Muted>
              )}
            </View>
            <Muted colors={colors} small>{text.header.notice}</Muted>
            <View style={styles.modalActions}>
              <Button
                colors={colors}
                variant="ghost"
                label={text.bundle.cancel}
                disabled={submitting}
                onPress={onClose}
              />
              <Button
                colors={colors}
                variant="primary"
                icon="ArrowUpCircle"
                label={text.bundle.confirmUpdate(dialog.version)}
                loading={submitting}
                disabled={locked}
                onPress={onConfirm}
              />
            </View>
          </>
        ) : (
          <>
            <Muted colors={colors}>{extra.updateAllModalBody(dialog.targets.length)}</Muted>
            <View style={styles.modalSummaryBox}>
              {shownTargets.map((target) => (
                <View key={target.name} style={styles.rowTop}>
                  <Text style={styles.subtitle}>{target.name}</Text>
                  <Text style={styles.version}>{target.version}</Text>
                </View>
              ))}
              {hiddenTargetCount > 0 ? (
                <Muted colors={colors} small>{extra.moreTargets(hiddenTargetCount)}</Muted>
              ) : null}
            </View>
            <Muted colors={colors} small>{text.header.notice}</Muted>
            <View style={styles.modalActions}>
              <Button
                colors={colors}
                variant="ghost"
                label={text.bundle.cancel}
                disabled={submitting}
                onPress={onClose}
              />
              <Button
                colors={colors}
                variant="primary"
                icon="ArrowUpCircle"
                label={text.job.confirmUpdateAll(dialog.targets.length)}
                loading={submitting}
                disabled={locked}
                onPress={onConfirm}
              />
            </View>
          </>
        )}
      </ModalComponent.Content>
    </ModalComponent>
  );
}

export interface DshPluginsContentProps {
  /** Theme color palette (`theme.colors`). */
  colors: ThemeColors;
  /** Host metadata (`{ id, label }`) shown in the profile subtitle when provided. */
  host?: PluginHostProps["host"];
  /** Host layout (`{ compact, platform }`); defaults to platform compact heuristics when omitted. */
  layout?: PluginHostProps["layout"];
  /**
   * Optional client handle accepted for callers that pass `PluginClientContext`.
   * RPC calls run through Paseo's `useRpc` hook (matching `DshPluginsPage`).
   */
  client?: PluginClientContext;
  /** Opens the display settings; the header shows no button without it. */
  openDisplaySettings?: () => void;
  /**
   * When true (mounted inside the 3-tab DSH console), omits the standalone
   * `ScrollView` wrapper and outer page padding so the parent console owns
   * scrolling and top-level chrome.
   */
  embedded?: boolean;
}

function DshPluginsBody({
  colors,
  host,
  layout,
  openDisplaySettings,
  embedded = false,
}: DshPluginsContentProps) {
  const compact = layout !== undefined
    ? layout.compact || layout.platform === "ios" || layout.platform === "android"
    : Platform.OS === "ios" || Platform.OS === "android";
  const uiText = useLocaleText();
  const text = uiText.plugins;
  const locale = useCurrentLocale();
  const extra = EXTRA_TEXT[locale];
  const toast = useSafeToast();
  const modalComponent = useMemo(() => resolveHostModal(), []);
  const useModalConfirm = modalComponent !== null;
  const styles = useMemo(() => createStyles(colors, compact), [colors, compact]);

  const list = useRpc(listRpc);
  const setEnabled = useRpc(setEnabledRpc);
  const inspectSpec = useRpc(inspectSpecRpc);
  const startJob = useRpc(startJobRpc);
  const jobStatus = useRpc(jobStatusRpc);

  const [snapshot, setSnapshot] = useState<PluginsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<UiFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [actionError, setActionError] = useState<UiFailure | null>(null);
  const [spec, setSpec] = useState("");
  const [inspection, setInspection] = useState<InspectSpecOutput | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [toggleBusy, setToggleBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState<{ name: string; version: string } | null>(null);
  // The batch button has the same two-step confirm fallback when host Modal is unavailable.
  const [confirmUpdateAll, setConfirmUpdateAll] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);

  // Refs keep polling callbacks fresh without restarting the 1s interval on
  // toast/locale identity changes, and guard timers against unmount races.
  const toastRef = useRef<ToastApi>(toast);
  toastRef.current = toast;
  const textRef = useRef<DshPluginsText>(text);
  textRef.current = text;
  const extraRef = useRef<PluginsExtraText>(extra);
  extraRef.current = extra;
  const dialogRef = useRef<ConfirmDialog | null>(confirmDialog);
  dialogRef.current = confirmDialog;
  const lastToastedJobIdRef = useRef<string | null>(null);
  const modalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (modalTimerRef.current !== null) {
        clearTimeout(modalTimerRef.current);
        modalTimerRef.current = null;
      }
    };
  }, []);

  const closeConfirmDialog = useCallback(() => {
    if (modalTimerRef.current !== null) {
      clearTimeout(modalTimerRef.current);
      modalTimerRef.current = null;
    }
    setConfirmDialog(null);
  }, []);

  const openConfirmDialog = useCallback((next: ConfirmDialog, fromClosingOverlay = false) => {
    if (modalTimerRef.current !== null) {
      clearTimeout(modalTimerRef.current);
      modalTimerRef.current = null;
    }
    const replacingOpenModal = dialogRef.current !== null;
    if ((fromClosingOverlay || replacingOpenModal) && Platform.OS !== "web") {
      setConfirmDialog(null);
      modalTimerRef.current = setTimeout(() => {
        modalTimerRef.current = null;
        if (mountedRef.current) setConfirmDialog(next);
      }, MODAL_TRANSITION_MS);
      return;
    }
    setConfirmDialog(next);
  }, []);

  const refresh = useCallback(async (notifyOnFailure = false): Promise<void> => {
    setRefreshing(true);
    try {
      // The locale files live on the daemon; ask for the language this page
      // renders in so the localized title/description come back resolved.
      const next = await list({ locale });
      if (!mountedRef.current) return;
      setSnapshot(next);
      const nextLoadError: UiFailure | null = next.errorCode === undefined
        ? null
        : {
          code: next.errorCode,
          ...(next.errorDetail === undefined ? {} : { detail: next.errorDetail }),
        };
      setLoadError(nextLoadError);
      if (notifyOnFailure && nextLoadError !== null) {
        toastRef.current.error(failureParts(textRef.current, nextLoadError).headline);
      }
      setJob((current) => {
        if (next.activeJobId === undefined) return current;
        if (current !== null && current.id === next.activeJobId) return current;
        return {
          id: next.activeJobId,
          kind: next.activeJobKind ?? "install",
          state: "running",
          output: "",
          startedAt: Date.now(),
        };
      });
    } catch (error) {
      if (!mountedRef.current) return;
      const failure = failureOf(error);
      setLoadError(failure);
      if (notifyOnFailure) {
        toastRef.current.error(failureParts(textRef.current, failure).headline);
      }
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [list, locale]);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  useEffect(() => {
    if (job === null || job.state !== "running") return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = async () => {
      try {
        const next = await jobStatus({ id: job.id });
        if (cancelled) return;
        setJob(next);
        if (next.state !== "running") {
          if (lastToastedJobIdRef.current !== next.id) {
            lastToastedJobIdRef.current = next.id;
            const currentText = textRef.current;
            const currentExtra = extraRef.current;
            if (next.state === "succeeded") {
              if (next.kind === "check") {
                const count = next.updates !== undefined ? Object.keys(next.updates).length : 0;
                if (count > 0) {
                  toastRef.current.show(currentText.job.updatesFound(count), { variant: "info" });
                } else {
                  toastRef.current.show(currentExtra.toastUpToDate, { variant: "success" });
                }
              } else {
                toastRef.current.show(jobTitle(next, currentText), { variant: "success" });
              }
            } else {
              const title = jobTitle(next, currentText);
              const detail = next.errorCode !== undefined
                ? currentText.errors[next.errorCode]
                : undefined;
              toastRef.current.error(detail === undefined ? title : `${title}: ${detail}`);
            }
          }
          await refresh(false);
        }
      } catch (error) {
        if (cancelled) return;
        const failure = failureOf(error);
        setActionError(failure);
        if (lastToastedJobIdRef.current !== job.id) {
          lastToastedJobIdRef.current = job.id;
          toastRef.current.error(failureParts(textRef.current, failure).headline);
        }
        setJob((current) => current === null
          ? current
          : {
            ...current,
            state: "failed",
            errorCode: failure.code === "render" ? "request-failed" : failure.code,
            errorDetail: failure.detail,
            finishedAt: Date.now(),
          });
      }
    };

    void tick();
    timer = setInterval(() => {
      void tick();
    }, 1000);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [job?.id, job?.state, jobStatus, refresh]);

  useEffect(() => {
    if (job?.state === "succeeded" && job.kind === "install") {
      setSpec("");
      setInspection(null);
    }
  }, [job?.kind, job?.state]);

  const busy = job?.state === "running" || snapshot?.busy === true;

  const beginJob = useCallback(async (input: StartJobInput): Promise<boolean> => {
    setActionError(null);
    try {
      const started = await startJob(input);
      if (!started.ok || started.id === undefined) {
        const failure: UiFailure = {
          code: started.errorCode ?? "command-failed",
          ...(started.errorDetail === undefined ? {} : { detail: started.errorDetail }),
        };
        setActionError(failure);
        toastRef.current.error(failureParts(textRef.current, failure).headline);
        return false;
      }
      setJob({
        id: started.id,
        kind: input.kind,
        state: "running",
        output: "",
        startedAt: Date.now(),
      });
      setSnapshot((current) => current === null
        ? current
        : {
          ...current,
          busy: true,
          activeJobId: started.id,
          activeJobKind: input.kind,
        });
      return true;
    } catch (error) {
      const failure = failureOf(error);
      setActionError(failure);
      toastRef.current.error(failureParts(textRef.current, failure).headline);
      return false;
    }
  }, [startJob]);

  const inspect = async (): Promise<void> => {
    const value = spec.trim();
    if (value === "") return;
    setInspecting(true);
    setActionError(null);
    setInspection(null);
    try {
      setInspection(await inspectSpec({ spec: value }));
    } catch (error) {
      const failure = failureOf(error);
      setActionError(failure);
      toast.error(failureParts(text, failure).headline);
    } finally {
      if (mountedRef.current) setInspecting(false);
    }
  };

  const install = async (): Promise<void> => {
    if (inspection === null || !inspection.ok) return;
    const started = await beginJob({ kind: "install", spec: spec.trim() });
    if (started) setInspection(null);
  };

  const toggle = async (bundle: BundleInfo): Promise<void> => {
    setToggleBusy(bundle.name);
    setActionError(null);
    try {
      const result = await setEnabled({ name: bundle.name, enabled: !bundle.enabled });
      if (!result.ok) {
        const failure: UiFailure = {
          code: result.errorCode ?? "command-failed",
          ...(result.errorDetail === undefined ? {} : { detail: result.errorDetail }),
        };
        setActionError(failure);
        toast.error(failureParts(text, failure).headline);
        return;
      }
      toast.show(
        result.enabled ? extra.toastEnabled(bundle.name) : extra.toastDisabled(bundle.name),
        { variant: "success" },
      );
      await refresh(false);
    } catch (error) {
      const failure = failureOf(error);
      setActionError(failure);
      toast.error(failureParts(text, failure).headline);
    } finally {
      if (mountedRef.current) setToggleBusy(null);
    }
  };

  const handleRemovePress = async (bundle: BundleInfo | null): Promise<void> => {
    if (bundle === null) {
      setConfirmRemove(null);
      return;
    }
    if (useModalConfirm) {
      openConfirmDialog({
        kind: "remove",
        name: bundle.name,
        title: bundle.title,
        version: bundle.version,
      });
      return;
    }
    if (confirmRemove !== bundle.name) {
      setConfirmRemove(bundle.name);
      return;
    }
    setConfirmRemove(null);
    await beginJob({ kind: "remove", name: bundle.name });
  };

  const handleUpdatePress = async (bundle: BundleInfo | null): Promise<void> => {
    if (bundle === null || bundle.update === undefined || bundle.update === "") {
      setConfirmUpdate(null);
      return;
    }
    const targetVersion = bundle.update;
    if (useModalConfirm) {
      openConfirmDialog({
        kind: "update",
        name: bundle.name,
        title: bundle.title,
        currentVersion: bundle.version,
        version: targetVersion,
      });
      return;
    }
    if (confirmUpdate?.name !== bundle.name || confirmUpdate.version !== targetVersion) {
      setConfirmUpdate({ name: bundle.name, version: targetVersion });
      return;
    }
    setConfirmUpdate(null);
    await beginJob({ kind: "update", name: bundle.name, version: targetVersion });
  };

  // A new or finished job invalidates any armed confirmation state: neither
  // inline buttons nor an open modal should survive across a refresh or re-check.
  useEffect(() => {
    setConfirmUpdateAll(false);
    setConfirmRemove(null);
    setConfirmUpdate(null);
    closeConfirmDialog();
  }, [job?.id, job?.state, closeConfirmDialog]);

  const bundles = snapshot?.bundles ?? [];

  /**
   * Update every row that currently reads updatable.
   *
   * The target list is recomputed from the snapshot in front of the user rather
   * than from `job.updates`: that map belongs to the check job, and the list is
   * what the rows show. No updatable row means no job at all.
   */
  const runUpdateAll = async (): Promise<void> => {
    const targets = bundles
      .filter((bundle) => bundle.updatable && bundle.update !== undefined)
      .map((bundle) => ({ name: bundle.name, version: bundle.update as string }));
    if (targets.length === 0) {
      setConfirmUpdateAll(false);
      return;
    }
    if (useModalConfirm) {
      openConfirmDialog({ kind: "update-all", targets });
      return;
    }
    if (!confirmUpdateAll) {
      setConfirmUpdateAll(true);
      return;
    }
    setConfirmUpdateAll(false);
    await beginJob({ kind: "update-all", targets });
  };

  const submitConfirmDialog = async (): Promise<void> => {
    const active = dialogRef.current;
    if (active === null || confirmSubmitting) return;
    setConfirmSubmitting(true);
    try {
      if (active.kind === "remove") {
        await beginJob({ kind: "remove", name: active.name });
      } else if (active.kind === "update") {
        await beginJob({ kind: "update", name: active.name, version: active.version });
      } else {
        await beginJob({ kind: "update-all", targets: [...active.targets] });
      }
      if (mountedRef.current) closeConfirmDialog();
    } finally {
      if (mountedRef.current) setConfirmSubmitting(false);
    }
  };

  const checkButton = (
    <Button
      colors={colors}
      size="md"
      variant="secondary"
      icon="Search"
      label={inspecting ? text.install.checking : text.install.check}
      loading={inspecting}
      disabled={busy || inspecting || spec.trim() === ""}
      onPress={() => {
        void inspect();
      }}
    />
  );

  const groups = [
    {
      title: text.groups.enabled,
      items: bundles.filter((bundle) => bundle.enabled && bundle.kind !== "dependency"),
    },
    {
      title: text.groups.disabled,
      items: bundles.filter((bundle) => !bundle.enabled && bundle.kind !== "dependency"),
    },
    {
      title: text.groups.dependencies,
      items: bundles.filter((bundle) => bundle.kind === "dependency"),
    },
  ].filter((group) => group.items.length > 0);

  const profileHeadline = snapshot !== null
    ? host?.label
      ? text.header.profile(snapshot.profile, host.label)
      : snapshot.profile
    : host?.label ?? text.pageTitle;

  const updateCount = job?.kind === "check" && job.updates !== undefined
    ? Object.keys(job.updates).length
    : 0;

  const body = (
    <>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.profileTitle}>{profileHeadline}</Text>
          {snapshot === null ? null : (
            <Text selectable style={styles.path}>{snapshot.displayDir}</Text>
          )}
          <Text style={styles.notice}>{text.header.notice}</Text>
        </View>
        <View style={styles.headerActions}>
          <Button
            colors={colors}
            size="sm"
            variant="secondary"
            icon="RefreshCw"
            label={refreshing ? text.header.refreshing : text.header.refresh}
            loading={refreshing}
            disabled={refreshing}
            onPress={() => {
              void refresh(true);
            }}
          />
          <Button
            colors={colors}
            size="sm"
            variant="secondary"
            icon="ArrowUpCircle"
            label={job?.kind === "check" && job.state === "running"
              ? text.header.checkingUpdates
              : text.header.checkUpdates}
            loading={job?.kind === "check" && job.state === "running"}
            disabled={busy}
            onPress={() => {
              void beginJob({ kind: "check" });
            }}
          />
          {openDisplaySettings === undefined ? null : (
            <Button
              colors={colors}
              size="sm"
              variant="ghost"
              icon="SlidersHorizontal"
              label={uiText.settings.title}
              onPress={openDisplaySettings}
            />
          )}
        </View>
      </View>

      <Divider colors={colors} />

      {loadError === null ? null : (
        <FailureCallout
          colors={colors}
          text={text}
          failure={loadError}
          styles={styles}
          action={(
            <Button
              colors={colors}
              size="sm"
              variant="secondary"
              icon="RotateCcw"
              label={text.header.retry}
              onPress={() => {
                void refresh(true);
              }}
            />
          )}
        />
      )}

      {actionError === null ? null : (
        <FailureCallout
          colors={colors}
          text={text}
          failure={actionError}
          styles={styles}
        />
      )}

      {job === null ? null : (
        <Card colors={colors} style={styles.cardBody}>
          <View style={styles.rowTop}>
            {job.state === "running" ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : null}
            <Text style={styles.name}>{jobTitle(job, text)}</Text>
            {job.state === "failed" ? (
              <Badge colors={colors} tone="danger" dot label={text.job.failedBadge} />
            ) : null}
            {job.state === "succeeded" ? (
              <Badge colors={colors} tone="success" dot label={text.job.doneBadge} />
            ) : null}
          </View>
          {job.errorCode === undefined ? null : (
            <FailureCallout
              colors={colors}
              text={text}
              failure={{
                code: job.errorCode,
                ...(job.errorDetail === undefined ? {} : { detail: job.errorDetail }),
              }}
              styles={styles}
            />
          )}
          {updateCount > 0 ? (
            <>
              <Divider colors={colors} />
              <View style={styles.resultRow}>
                <Muted colors={colors}>{text.job.updatesFound(updateCount)}</Muted>
                {/* marginLeft:"auto" right-aligns the button on the same line
                    when it fits, and on its own wrapped line when it does not. */}
                <View style={styles.resultAction}>
                  <Button
                    colors={colors}
                    size="sm"
                    variant={useModalConfirm || confirmUpdateAll ? "primary" : "secondary"}
                    icon="ArrowUpCircle"
                    label={!useModalConfirm && confirmUpdateAll
                      ? text.job.confirmUpdateAll(updateCount)
                      : text.job.updateAll}
                    disabled={busy}
                    onPress={() => {
                      void runUpdateAll();
                    }}
                  />
                </View>
              </View>
            </>
          ) : null}
          {job.updateResults === undefined || job.updateResults.length === 0 ? null : (
            <>
              <Divider colors={colors} />
              <View style={styles.section}>
                <Muted colors={colors} style={tabular}>
                  {text.job.updateResultsSummary(
                    job.updateResults.filter((outcome) => outcome.ok).length,
                    job.updateResults.filter((outcome) => !outcome.ok).length,
                  )}
                </Muted>
                {job.updateResults.map((outcome) => (
                  <View key={outcome.name} style={styles.resultItem}>
                    <View style={styles.rowTop}>
                      <Text style={styles.name}>{outcome.name}</Text>
                      <Text style={styles.version}>{outcome.version}</Text>
                      {outcome.ok ? (
                        <Badge colors={colors} tone="success" dot label={text.job.doneBadge} />
                      ) : (
                        <Badge colors={colors} tone="danger" dot label={text.job.failedBadge} />
                      )}
                    </View>
                    {outcome.ok ? null : (
                      <FailureCallout
                        colors={colors}
                        text={text}
                        failure={{
                          code: outcome.errorCode ?? "command-failed",
                          ...(outcome.errorDetail === undefined
                            ? {}
                            : { detail: outcome.errorDetail }),
                        }}
                        styles={styles}
                      />
                    )}
                  </View>
                ))}
              </View>
            </>
          )}
          {job.output === "" ? null : (
            <View style={styles.outputBox}>
              <Text selectable style={styles.output}>{tailLines(job.output, 12)}</Text>
            </View>
          )}
        </Card>
      )}

      <Card colors={colors} style={styles.cardBody}>
        <Text style={styles.groupTitle}>{text.install.title}</Text>
        <Muted colors={colors}>{text.install.hint}</Muted>
        {/* Wide: the input grows and the check button sits on its right edge.
            Compact: the button moves under the input, right-aligned. */}
        <View style={compact ? styles.inputStack : styles.inputRow}>
          <TextInput
            value={spec}
            onChangeText={(value: string) => {
              setSpec(value);
              setInspection(null);
            }}
            placeholder={text.install.placeholder}
            placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
            editable={!busy && !inspecting && !(inspection?.ok === true)}
            autoCapitalize="none"
            autoCorrect={false}
            style={compact ? styles.input : [styles.input, styles.inputGrow]}
          />
          {compact ? null : checkButton}
        </View>
        {compact ? <View style={styles.checkRow}>{checkButton}</View> : null}

        {inspection === null ? null : inspection.ok ? (
          <View style={styles.infoBox}>
            <View style={styles.rowTop}>
              <Text style={styles.name}>{inspection.name ?? text.install.unknown}</Text>
              {inspection.version === undefined ? null : (
                <Badge colors={colors} tone="accent" label={inspection.version} />
              )}
              {inspection.client ? (
                <Badge colors={colors} tone="warning" icon="Monitor" label={text.badges.client} />
              ) : null}
            </View>
            {inspection.description === undefined || inspection.description === ""
              ? null
              : <Text style={styles.description}>{inspection.description}</Text>}
            {inspection.client ? <Muted colors={colors}>{text.bundle.clientNote}</Muted> : null}
            <Callout colors={colors} tone="warning" title={text.install.trust} />
            <View style={styles.rowActions}>
              <Button
                colors={colors}
                size="sm"
                variant="primary"
                icon="Download"
                label={text.install.confirm}
                disabled={busy}
                onPress={() => {
                  void install();
                }}
              />
              <Button
                colors={colors}
                size="sm"
                variant="ghost"
                label={text.bundle.cancel}
                disabled={busy}
                onPress={() => {
                  setInspection(null);
                }}
              />
            </View>
          </View>
        ) : inspection.errorCode === "not-a-bundle" ? (
          <Callout
            colors={colors}
            tone="danger"
            title={text.install.notBundle}
            action={(
              <Button
                colors={colors}
                size="sm"
                variant="ghost"
                label={text.bundle.cancel}
                disabled={busy || inspecting}
                onPress={() => {
                  setInspection(null);
                }}
              />
            )}
          />
        ) : (
          <FailureCallout
            colors={colors}
            text={text}
            failure={{
              code: inspection.errorCode ?? "command-failed",
              ...(inspection.errorDetail === undefined
                ? {}
                : { detail: inspection.errorDetail }),
            }}
            styles={styles}
            action={(
              <Button
                colors={colors}
                size="sm"
                variant="ghost"
                label={text.bundle.cancel}
                disabled={busy || inspecting}
                onPress={() => {
                  setInspection(null);
                }}
              />
            )}
          />
        )}
      </Card>

      {snapshot === null && loadError === null ? (
        <Card colors={colors} style={styles.loadingCard}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Muted colors={colors}>{text.status.loadingProfile}</Muted>
        </Card>
      ) : null}

      {groups.map((group) => (
        <View key={group.title} style={styles.section}>
          <View style={styles.groupHeader}>
            <Text style={styles.groupTitle}>{group.title}</Text>
            <View style={styles.groupCountPill}>
              <Text style={styles.groupCountText}>{group.items.length}</Text>
            </View>
          </View>
          {group.items.map((bundle) => (
            <BundleRow
              key={bundle.name}
              bundle={bundle}
              colors={colors}
              text={text}
              styles={styles}
              busy={busy}
              toggleBusy={toggleBusy}
              useModalConfirm={useModalConfirm}
              confirmRemove={confirmRemove}
              confirmUpdate={confirmUpdate}
              onToggle={(item) => {
                void toggle(item);
              }}
              onRemove={(item) => {
                void handleRemovePress(item);
              }}
              onUpdate={(item) => {
                void handleUpdatePress(item);
              }}
            />
          ))}
        </View>
      ))}

      {modalComponent !== null && confirmDialog !== null ? (
        <ConfirmActionModal
          ModalComponent={modalComponent}
          dialog={confirmDialog}
          colors={colors}
          text={text}
          extra={extra}
          styles={styles}
          busy={busy}
          submitting={confirmSubmitting}
          onConfirm={() => {
            void submitConfirmDialog();
          }}
          onClose={closeConfirmDialog}
        />
      ) : null}
    </>
  );

  if (embedded) {
    return <View style={styles.embeddedContent}>{body}</View>;
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      contentContainerStyle={styles.content}
    >
      {body}
    </ScrollView>
  );
}

/**
 * Reusable Plugins management content mounted either standalone inside
 * `DshPluginsPage` or embedded inside the 3-tab DSH Console (`embedded: true`).
 * Wrapped in `PluginsBoundary` so a render error stays isolated to this view.
 */
export function DshPluginsContent(props: DshPluginsContentProps) {
  const text = useLocaleText().plugins;
  return (
    <PluginsBoundary
      fallback={(
        <PluginsFailedCard
          message={text.errors.render}
          color={props.colors.statusDanger}
          background={props.colors.surface0}
        />
      )}
    >
      <DshPluginsBody {...props} />
    </PluginsBoundary>
  );
}

export interface DshPluginsPageProps extends PluginScreenProps {
  /** Opens the display settings; the header shows no button without it. */
  openDisplaySettings?: () => void;
}

/**
 * The registered screen. A render error used to be fatal for the whole app:
 * release Hermes hands it to RN's fatal handler, which aborts the process. Keep
 * one malformed field or host prop from taking the sidebar and every open agent
 * down with it.
 */
export function DshPluginsPage({
  theme,
  host,
  layout,
  openDisplaySettings,
}: DshPluginsPageProps) {
  return (
    <DshPluginsContent
      colors={theme.colors}
      host={host}
      layout={layout}
      openDisplaySettings={openDisplaySettings}
      embedded={false}
    />
  );
}
