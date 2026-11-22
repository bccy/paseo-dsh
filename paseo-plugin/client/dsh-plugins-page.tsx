import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import type {
  DshPluginsFailureCode,
  DshPluginsText,
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
} from "../shared/dsh-plugins-api";

type ThemeColors = PluginScreenProps["theme"]["colors"];
type Styles = ReturnType<typeof createStyles>;

interface UiFailure {
  code: DshPluginsFailureCode;
  detail?: string;
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
 * The words for one failure.
 *
 * Raw `dsh`/pnpm output rides under the sentence only for the failures where it
 * explains something the sentence cannot (a command's exit tail, the platforms
 * a bundle lists, the raw request error); a wrong-but-plausible paragraph is
 * worse than a short sentence.
 */
function failureText(text: DshPluginsText, failure: UiFailure): string {
  const base = text.errors[failure.code];
  if (
    failure.detail !== undefined
    && (failure.code === "command-failed"
      || failure.code === "check-failed"
      || failure.code === "invalid-platform"
      || failure.code === "request-failed")
  ) {
    return `${base}\n${failure.detail}`;
  }
  return base;
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

function createStyles(colors: ThemeColors, compact: boolean) {
  return {
    content: {
      padding: compact ? 16 : 24,
      paddingBottom: 40,
      gap: 16,
      width: "100%" as const,
      maxWidth: 880,
      alignSelf: "center" as const,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      gap: 12,
      flexWrap: "wrap" as const,
    },
    headerText: { flex: 1, minWidth: 180, gap: 4 },
    muted: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    path: { color: colors.foregroundMuted, fontSize: 12 },
    notice: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    headerActions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flexWrap: "wrap" as const,
    },
    section: { gap: 10 },
    groupTitle: {
      color: colors.foreground,
      fontSize: 15,
      fontWeight: "600" as const,
    },
    card: {
      backgroundColor: colors.surface1,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: compact ? 12 : 14,
      gap: 8,
    },
    rowTop: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flexWrap: "wrap" as const,
    },
    name: { color: colors.foreground, fontSize: 14, fontWeight: "600" as const },
    subtitle: { color: colors.foreground, fontSize: 13, fontWeight: "500" as const },
    version: { color: colors.foregroundMuted, fontSize: 12 },
    description: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    badgeRow: {
      flexDirection: "row" as const,
      gap: 6,
      flexWrap: "wrap" as const,
    },
    badge: {
      backgroundColor: colors.surface2,
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    badgeText: { color: colors.foregroundMuted, fontSize: 11 },
    badgeWarn: {
      backgroundColor: colors.surface2,
      borderColor: colors.statusWarning,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    badgeWarnText: { color: colors.statusWarning, fontSize: 11 },
    badgeDanger: {
      backgroundColor: colors.surface2,
      borderColor: colors.statusDanger,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    badgeDangerText: { color: colors.statusDanger, fontSize: 11 },
    badgeSuccess: {
      backgroundColor: colors.surface2,
      borderColor: colors.statusSuccess,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    badgeSuccessText: { color: colors.statusSuccess, fontSize: 11 },
    rowActions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      flexWrap: "wrap" as const,
    },
    button: {
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: colors.surface2,
    },
    buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
    buttonDisabled: { opacity: 0.45 },
    buttonText: { color: colors.foreground, fontSize: 12, fontWeight: "500" as const },
    buttonPrimaryText: {
      color: colors.accentForeground,
      fontSize: 12,
      fontWeight: "600" as const,
    },
    input: {
      color: colors.foreground,
      backgroundColor: colors.surface2,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
    },
    inputRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    inputStack: { gap: 8 },
    inputGrow: { flex: 1 },
    checkRow: {
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
    },
    resultRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      justifyContent: "space-between" as const,
      gap: 8,
    },
    resultAction: { marginLeft: "auto" as const },
    resultItem: { gap: 4 },
    statusCard: {
      backgroundColor: colors.surface1,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      gap: 8,
    },
    errorCard: {
      backgroundColor: colors.surface1,
      borderColor: colors.statusDanger,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      gap: 8,
    },
    errorText: { color: colors.statusDanger, fontSize: 13, lineHeight: 19 },
    output: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 },
    rowTags: {
      flexDirection: "row" as const,
      gap: 6,
      flexWrap: "wrap" as const,
    },
    tag: {
      backgroundColor: colors.surface2,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    tagText: { color: colors.foregroundMuted, fontSize: 10 },
    infoBox: {
      backgroundColor: colors.surface2,
      borderRadius: 8,
      padding: 10,
      gap: 6,
    },
  };
}

function ActionButton({
  label,
  onPress,
  disabled,
  primary,
  styles,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  styles: Styles;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        primary === true ? styles.buttonPrimary : null,
        disabled === true ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={[styles.buttonText, primary === true ? styles.buttonPrimaryText : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

function Badge({
  label,
  tone = "muted",
  styles,
}: {
  label: string;
  tone?: "muted" | "warn" | "danger" | "success";
  styles: Styles;
}) {
  const badgeStyle = tone === "warn"
    ? styles.badgeWarn
    : tone === "danger"
      ? styles.badgeDanger
      : tone === "success"
        ? styles.badgeSuccess
        : styles.badge;
  const textStyle = tone === "warn"
    ? styles.badgeWarnText
    : tone === "danger"
      ? styles.badgeDangerText
      : tone === "success"
        ? styles.badgeSuccessText
        : styles.badgeText;
  return (
    <View style={badgeStyle}>
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

function BundleRow({
  bundle,
  text,
  styles,
  busy,
  toggleBusy,
  confirmRemove,
  confirmUpdate,
  onToggle,
  onRemove,
  onUpdate,
}: {
  bundle: BundleInfo;
  text: DshPluginsText;
  styles: Styles;
  busy: boolean;
  toggleBusy: string | null;
  confirmRemove: string | null;
  confirmUpdate: { name: string; version: string } | null;
  onToggle: (bundle: BundleInfo) => void;
  onRemove: (name: string) => void;
  onUpdate: (name: string, version: string) => void;
}) {
  const isDependency = bundle.kind === "dependency";
  const canToggle = bundle.kind !== "dependency" && !bundle.protected;
  const removePending = confirmRemove === bundle.name;
  const updatePending = confirmUpdate?.name === bundle.name;
  const rowBusy = busy || toggleBusy === bundle.name;
  // Disclosure only: a card lists its component ids when asked, not by default.
  // The state is render-local by design (no persistence, no RPC).
  const [rowsOpen, setRowsOpen] = useState(false);

  return (
    <View style={styles.card}>
      <View style={styles.rowTop}>
        <Text style={styles.name}>{bundle.name}</Text>
        {bundle.version === undefined ? null : <Text style={styles.version}>{bundle.version}</Text>}
        {bundle.official ? <Badge label={text.badges.official} styles={styles} /> : null}
        {bundle.protected ? <Badge label={text.badges.protected} styles={styles} /> : null}
        {bundle.client ? <Badge label={text.badges.client} tone="warn" styles={styles} /> : null}
        {bundle.platformSupported ? null : <Badge label={text.badges.platformUnsupported} tone="danger" styles={styles} />}
        {bundle.installed ? null : <Badge label={text.badges.missing} tone="danger" styles={styles} />}
        {bundle.update === undefined
          ? null
          : <Badge label={text.badges.updateAvailable(bundle.update)} tone="warn" styles={styles} />}
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

      {isDependency
        ? <Text style={styles.muted}>{text.bundle.dependencyNote}</Text>
        : null}
      {bundle.client
        ? <Text style={styles.muted}>{text.bundle.clientNote}</Text>
        : null}
      {bundle.platformSupported
        ? null
        : bundle.platformReason === undefined || bundle.platformReason === ""
          ? <Text style={styles.muted}>{text.bundle.platformsUnknown}</Text>
          : <Text style={styles.muted}>{text.bundle.platforms(bundle.platformReason)}</Text>}

      <View style={styles.rowActions}>
        {canToggle ? (
          <Switch
            value={bundle.enabled}
            disabled={rowBusy || (!bundle.enabled && (bundle.installed === false || !bundle.platformSupported))}
            onValueChange={() => onToggle(bundle)}
            trackColor={{ false: styles.button.backgroundColor, true: styles.buttonPrimary.backgroundColor }}
            thumbColor={styles.name.color}
          />
        ) : null}

        {bundle.removable ? (
          removePending ? (
            <>
              <ActionButton
                label={text.bundle.confirmRemove}
                disabled={rowBusy}
                onPress={() => onRemove(bundle.name)}
                styles={styles}
              />
              <ActionButton label={text.bundle.cancel} disabled={rowBusy} onPress={() => onRemove("")} styles={styles} />
            </>
          ) : (
            <ActionButton
              label={text.bundle.remove}
              disabled={rowBusy}
              onPress={() => onRemove(bundle.name)}
              styles={styles}
            />
          )
        ) : null}

        {bundle.update === undefined ? null : updatePending ? (
          <>
            <ActionButton
              label={text.bundle.confirmUpdate(bundle.update)}
              disabled={rowBusy}
              primary
              onPress={() => onUpdate(bundle.name, bundle.update as string)}
              styles={styles}
            />
            <ActionButton label={text.bundle.cancel} disabled={rowBusy} onPress={() => onUpdate("", "")} styles={styles} />
          </>
        ) : (
          <ActionButton
            label={text.bundle.update(bundle.update)}
            disabled={rowBusy}
            onPress={() => onUpdate(bundle.name, bundle.update as string)}
            styles={styles}
          />
        )}
      </View>

      {/* Default-collapsed component list. The line itself is the toggle; a card
          with no rows shows nothing (a "0 components" row would be noise). */}
      {bundle.rows.length === 0 ? null : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text.bundle.componentCount(bundle.rows.length)}
            onPress={() => setRowsOpen((open) => !open)}
          >
            <Text style={styles.muted}>{text.bundle.componentCount(bundle.rows.length)}</Text>
          </Pressable>
          {rowsOpen ? (
            <View style={styles.rowTags}>
              {bundle.rows.map((row) => (
                <View key={row.id} style={styles.tag}>
                  <Text style={styles.tagText}>{row.id}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function DshPluginsPageBody({ theme, host, layout, openDisplaySettings }: DshPluginsPageProps) {
  const compact = layout.compact || layout.platform === "ios" || layout.platform === "android";
  const uiText = useLocaleText();
  const text = uiText.plugins;
  const locale = useCurrentLocale();
  const styles = useMemo(() => createStyles(theme.colors, compact), [theme.colors, compact]);

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
  // The batch button has the same two-step confirm as a row's update button:
  // one press asks, the second runs. A new job clears the ask.
  const [confirmUpdateAll, setConfirmUpdateAll] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      // The locale files live on the daemon; ask for the language this page
      // renders in so the localized title/description come back resolved.
      const next = await list({ locale });
      setSnapshot(next);
      setLoadError(next.errorCode === undefined
        ? null
        : {
          code: next.errorCode,
          ...(next.errorDetail === undefined ? {} : { detail: next.errorDetail }),
        });
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
      setLoadError(failureOf(error));
    } finally {
      setRefreshing(false);
    }
  }, [list, locale]);

  useEffect(() => {
    void refresh();
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
        if (next.state !== "running") await refresh();
      } catch (error) {
        if (cancelled) return;
        const failure = failureOf(error);
        setActionError(failure);
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
        setActionError({
          code: started.errorCode ?? "command-failed",
          ...(started.errorDetail === undefined ? {} : { detail: started.errorDetail }),
        });
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
      setActionError(failureOf(error));
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
      setActionError(failureOf(error));
    } finally {
      setInspecting(false);
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
        setActionError({
          code: result.errorCode ?? "command-failed",
          ...(result.errorDetail === undefined ? {} : { detail: result.errorDetail }),
        });
        return;
      }
      await refresh();
    } catch (error) {
      setActionError(failureOf(error));
    } finally {
      setToggleBusy(null);
    }
  };

  const remove = async (name: string): Promise<void> => {
    if (name === "") {
      setConfirmRemove(null);
      return;
    }
    if (confirmRemove !== name) {
      setConfirmRemove(name);
      return;
    }
    setConfirmRemove(null);
    await beginJob({ kind: "remove", name });
  };

  const update = async (name: string, version: string): Promise<void> => {
    if (name === "" || version === "") {
      setConfirmUpdate(null);
      return;
    }
    if (confirmUpdate?.name !== name || confirmUpdate.version !== version) {
      setConfirmUpdate({ name, version });
      return;
    }
    setConfirmUpdate(null);
    await beginJob({ kind: "update", name, version });
  };

  // A new or finished job invalidates a pending "confirm update all": the
  // button must not keep an armed state across a refresh or a re-check.
  useEffect(() => {
    setConfirmUpdateAll(false);
  }, [job?.id, job?.state]);

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
    if (!confirmUpdateAll) {
      setConfirmUpdateAll(true);
      return;
    }
    setConfirmUpdateAll(false);
    await beginJob({ kind: "update-all", targets });
  };

  const bundles = snapshot?.bundles ?? [];

  const checkButton = (
    <ActionButton
      label={inspecting ? text.install.checking : text.install.check}
      disabled={busy || inspecting || spec.trim() === ""}
      onPress={() => {
        void inspect();
      }}
      styles={styles}
    />
  );
  const groups = [
    { title: text.groups.enabled, items: bundles.filter((bundle) => bundle.enabled && bundle.kind !== "dependency") },
    { title: text.groups.disabled, items: bundles.filter((bundle) => !bundle.enabled && bundle.kind !== "dependency") },
    { title: text.groups.dependencies, items: bundles.filter((bundle) => bundle.kind === "dependency") },
  ].filter((group) => group.items.length > 0);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={styles.content}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.muted}>
            {snapshot === null
              ? host.label
              : text.header.profile(snapshot.profile, host.label)}
          </Text>
          {snapshot === null ? null : <Text style={styles.path}>{snapshot.displayDir}</Text>}
          <Text style={styles.notice}>{text.header.notice}</Text>
        </View>
        <View style={styles.headerActions}>
          <ActionButton
            label={refreshing ? text.header.refreshing : text.header.refresh}
            disabled={refreshing}
            onPress={() => {
              void refresh();
            }}
            styles={styles}
          />
          <ActionButton
            label={job?.kind === "check" && job.state === "running"
              ? text.header.checkingUpdates
              : text.header.checkUpdates}
            disabled={busy}
            onPress={() => {
              void beginJob({ kind: "check" });
            }}
            styles={styles}
          />
          {openDisplaySettings === undefined ? null : (
            <ActionButton
              label={uiText.settings.title}
              onPress={openDisplaySettings}
              styles={styles}
            />
          )}
        </View>
      </View>

      {loadError === null ? null : (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{failureText(text, loadError)}</Text>
          <ActionButton
            label={text.header.retry}
            onPress={() => {
              void refresh();
            }}
            styles={styles}
          />
        </View>
      )}

      {actionError === null ? null : (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{failureText(text, actionError)}</Text>
        </View>
      )}

      {job === null ? null : (
        <View style={styles.statusCard}>
          <View style={styles.rowTop}>
            {job.state === "running" ? (
              <ActivityIndicator size="small" color={theme.colors.accent} />
            ) : null}
            <Text style={styles.name}>{jobTitle(job, text)}</Text>
            {job.state === "failed" ? <Badge label={text.job.failedBadge} tone="danger" styles={styles} /> : null}
            {job.state === "succeeded" ? <Badge label={text.job.doneBadge} tone="success" styles={styles} /> : null}
          </View>
          {job.errorCode === undefined
            ? null
            : (
              <Text style={styles.errorText}>
                {failureText(text, {
                  code: job.errorCode,
                  ...(job.errorDetail === undefined ? {} : { detail: job.errorDetail }),
                })}
              </Text>
            )}
          {job.kind === "check" && job.updates !== undefined && Object.keys(job.updates).length > 0 ? (
            <View style={styles.resultRow}>
              <Text style={styles.muted}>
                {text.job.updatesFound(Object.keys(job.updates).length)}
              </Text>
              {/* marginLeft:"auto" right-aligns the button on the same line
                  when it fits, and on its own wrapped line when it does not. */}
              <View style={styles.resultAction}>
                <ActionButton
                  label={confirmUpdateAll
                    ? text.job.confirmUpdateAll(Object.keys(job.updates).length)
                    : text.job.updateAll}
                  disabled={busy}
                  primary={confirmUpdateAll}
                  onPress={() => {
                    void runUpdateAll();
                  }}
                  styles={styles}
                />
              </View>
            </View>
          ) : null}
          {job.updateResults === undefined || job.updateResults.length === 0 ? null : (
            <View style={styles.section}>
              <Text style={styles.muted}>
                {text.job.updateResultsSummary(
                  job.updateResults.filter((outcome) => outcome.ok).length,
                  job.updateResults.filter((outcome) => !outcome.ok).length,
                )}
              </Text>
              {job.updateResults.map((outcome) => (
                <View key={outcome.name} style={styles.resultItem}>
                  <View style={styles.rowTop}>
                    <Text style={styles.name}>{outcome.name}</Text>
                    <Text style={styles.version}>{outcome.version}</Text>
                    {outcome.ok
                      ? <Badge label={text.job.doneBadge} tone="success" styles={styles} />
                      : <Badge label={text.job.failedBadge} tone="danger" styles={styles} />}
                  </View>
                  {outcome.ok ? null : (
                    <Text style={styles.errorText}>
                      {failureText(text, {
                        code: outcome.errorCode ?? "command-failed",
                        ...(outcome.errorDetail === undefined ? {} : { detail: outcome.errorDetail }),
                      })}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          )}
          {job.output === "" ? null : (
            <Text style={styles.output}>{tailLines(job.output, 12)}</Text>
          )}
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.groupTitle}>{text.install.title}</Text>
        <Text style={styles.muted}>{text.install.hint}</Text>
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
            placeholderTextColor={theme.colors.foregroundMuted}
            editable={!busy && !inspecting && !(inspection?.ok === true)}
            autoCapitalize="none"
            autoCorrect={false}
            style={compact ? styles.input : [styles.input, styles.inputGrow]}
          />
          {compact ? null : checkButton}
        </View>
        {compact ? <View style={styles.checkRow}>{checkButton}</View> : null}
        {inspection === null ? null : (
          <View style={styles.rowActions}>
            <ActionButton
              label={text.bundle.cancel}
              disabled={busy || inspecting}
              onPress={() => {
                setInspection(null);
              }}
              styles={styles}
            />
          </View>
        )}

        {inspection === null ? null : inspection.ok ? (
          <View style={styles.infoBox}>
            <Text style={styles.name}>
              {inspection.name ?? text.install.unknown}
              {inspection.version === undefined ? "" : ` ${inspection.version}`}
            </Text>
            {inspection.description === undefined || inspection.description === ""
              ? null
              : <Text style={styles.description}>{inspection.description}</Text>}
            {inspection.client
              ? <Text style={styles.muted}>{text.bundle.clientNote}</Text>
              : null}
            <Text style={styles.muted}>{text.install.trust}</Text>
            <View style={styles.rowActions}>
              <ActionButton
                label={text.install.confirm}
                primary
                disabled={busy}
                onPress={() => {
                  void install();
                }}
                styles={styles}
              />
              <ActionButton
                label={text.bundle.cancel}
                disabled={busy}
                onPress={() => {
                  setInspection(null);
                }}
                styles={styles}
              />
            </View>
          </View>
        ) : (
          <View style={styles.infoBox}>
            <Text style={styles.errorText}>
              {inspection.errorCode === "not-a-bundle"
                ? text.install.notBundle
                : failureText(text, {
                  code: inspection.errorCode ?? "command-failed",
                  ...(inspection.errorDetail === undefined ? {} : { detail: inspection.errorDetail }),
                })}
            </Text>
          </View>
        )}
      </View>

      {snapshot === null && loadError === null ? (
        <View style={styles.statusCard}>
          <ActivityIndicator size="small" color={theme.colors.accent} />
          <Text style={styles.muted}>{text.status.loadingProfile}</Text>
        </View>
      ) : null}

      {groups.map((group) => (
        <View key={group.title} style={styles.section}>
          <Text style={styles.groupTitle}>
            {group.title} · {group.items.length}
          </Text>
          {group.items.map((bundle) => (
            <BundleRow
              key={bundle.name}
              bundle={bundle}
              text={text}
              styles={styles}
              busy={busy}
              toggleBusy={toggleBusy}
              confirmRemove={confirmRemove}
              confirmUpdate={confirmUpdate}
              onToggle={(item) => {
                void toggle(item);
              }}
              onRemove={(name) => {
                void remove(name);
              }}
              onUpdate={(name, version) => {
                void update(name, version);
              }}
            />
          ))}
        </View>
      ))}
    </ScrollView>
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
export function DshPluginsPage(props: DshPluginsPageProps) {
  const text = useLocaleText().plugins;
  return (
    <PluginsBoundary
      fallback={(
        <PluginsFailedCard
          message={text.errors.render}
          color={props.theme.colors.statusDanger}
          background={props.theme.colors.surface0}
        />
      )}
    >
      <DshPluginsPageBody {...props} />
    </PluginsBoundary>
  );
}