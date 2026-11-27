import { useRpc } from "@getpaseo/plugin/client";
import { Modal, SettingsRow, SettingsSelect, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  getOrchestratorRpc,
  setOrchestratorRpc,
  type AccountSummary,
  type ModelFamily,
  type OrchestratorState,
} from "../../shared/antigravity/contracts";
import { displayLabel, joinList } from "./labels";
import { errorMessage, useAntigravityTranslation } from "./messages";
import { font, space, type Colors } from "./theme";
import { Button, Callout, Muted } from "./ui";

const DEFAULT_VALUE = "__default__";
export const ORCHESTRATOR_QUERY_KEY = ["antigravity-accounts", "orchestrator"] as const;

/** "Gemini 4 Carbon (High)" -> "Carbon High". */
export function shortModelLabel(label: string): string {
  return label
    .replace(/^Gemini\s+4\s+/i, "")
    .replace(/^Gemini\s+/i, "")
    .replace(/^Claude\s+/i, "")
    .replace(/\s*\(([^()]+)\)\s*$/, " $1")
    .trim();
}

export interface OrchestratorPreset {
  id: "default" | "quality" | "balanced";
  planner: string | null;
  executor: string | null;
}

function pickVariant(
  families: readonly ModelFamily[],
  familyIds: readonly string[],
  efforts: readonly string[],
): string | null {
  for (const id of familyIds) {
    const family = families.find((entry) => entry.id === id);
    if (!family?.variants.length) continue;
    for (const effort of efforts) {
      const variant = family.variants.find((item) => item.id.endsWith(`-${effort}`));
      if (variant) return variant.label;
    }
    return family.variants[family.variants.length - 1]!.label;
  }
  return null;
}

/** Derives quick presets from the models the user's accounts can actually run. */
export function resolvePresets(state: OrchestratorState): OrchestratorPreset[] {
  const qualityPlanner = pickVariant(state.planners, ["gemini-4-neon", "claude-opus-5-5", "gemini-4-carbon"], ["xhigh", "max", "high"]);
  const qualityExecutor = pickVariant(state.executors, ["gemini-4-hydrogen", "claude-sonnet-5-5"], ["xhigh", "high"]);
  const balancedPlanner = pickVariant(state.planners, ["gemini-4-carbon", "gemini-4-neon", "gemini-4-argon"], ["high", "medium"]);
  const balancedExecutor = pickVariant(state.executors, ["gemini-4-hydrogen", "claude-sonnet-5-5"], ["high", "medium"]);
  const presets: OrchestratorPreset[] = [{ id: "default", planner: null, executor: null }];
  if (qualityPlanner || qualityExecutor) {
    presets.push({ id: "quality", planner: qualityPlanner, executor: qualityExecutor });
  }
  if (
    (balancedPlanner || balancedExecutor) &&
    (balancedPlanner !== qualityPlanner || balancedExecutor !== qualityExecutor)
  ) {
    presets.push({ id: "balanced", planner: balancedPlanner, executor: balancedExecutor });
  }
  return presets;
}

function options(families: readonly ModelFamily[], defaultLabel: string) {
  return [
    { value: DEFAULT_VALUE, label: defaultLabel },
    ...families.flatMap((family) => family.variants.map((variant) => ({ value: variant.label, label: variant.label }))),
  ];
}

/** Accounts among `accounts` that cannot run the family of `label`. */
function missingOn(
  label: string | null,
  families: readonly ModelFamily[],
  accounts: readonly AccountSummary[],
  t: (key: "systemName") => string,
): string[] {
  if (!label) return [];
  const family = families.find((entry) => entry.variants.some((variant) => variant.label === label));
  if (!family) return [];
  return accounts
    .filter((account) => account.usable && account.status === "signed-in" && !family.accounts.includes(account.id))
    .map((account) => displayLabel(account.label, t, account.kind));
}

/** Planner and executor rows for the console's settings card. */
export function OrchestratorRows({
  colors,
  accounts,
  onChange,
}: {
  colors: Colors;
  accounts: readonly AccountSummary[];
  onChange(state: OrchestratorState): void;
}) {
  const { t, locale } = useAntigravityTranslation();
  const toast = useToast();
  const cache = useQueryClient();
  const read = useRpc(getOrchestratorRpc);
  const save = useRpc(setOrchestratorRpc);
  const [retrying, setRetrying] = useState(false);
  const query = useQuery({ queryKey: ORCHESTRATOR_QUERY_KEY, queryFn: () => read({}), staleTime: 60_000 });
  const state = query.data;

  if (!state) return null;
  if (!state.planners.length && !state.executors.length) {
    if (!state.error) return null;
    return (
      <SettingsRow label={t("orchestrator.settingsPlanner")} hint={state.error}>
        <Button
          colors={colors}
          size="sm"
          icon="RefreshCw"
          label={t("retry")}
          loading={retrying}
          onPress={() => {
            setRetrying(true);
            void read({ refresh: true })
              .then((next) => {
                cache.setQueryData(ORCHESTRATOR_QUERY_KEY, next);
                onChange(next);
              })
              .catch((reason: unknown) => toast.error(errorMessage(reason)))
              .finally(() => setRetrying(false));
          }}
        />
      </SettingsRow>
    );
  }

  const change = (patch: { planner?: string | null; executor?: string | null }) => {
    void save(patch)
      .then(({ state: next }) => {
        cache.setQueryData(ORCHESTRATOR_QUERY_KEY, next);
        onChange(next);
        toast.show(t("orchestrator.applied.none"), { durationMs: 2500 });
      })
      .catch((reason: unknown) => toast.error(errorMessage(reason)));
  };
  const plannerMissing = missingOn(state.planner, state.planners, accounts, t);
  const executorMissing = missingOn(state.executor, state.executors, accounts, t);
  const presets = resolvePresets(state);

  return (
    <>
      {state.planners.length ? (
        <SettingsSelect
          label={t("orchestrator.settingsPlanner")}
          hint={
            plannerMissing.length
              ? t("orchestrator.missingOn", { accounts: joinList(plannerMissing, locale) })
              : undefined
          }
          value={state.planner ?? DEFAULT_VALUE}
          options={options(state.planners, t("orchestrator.default"))}
          onValueChange={(value) => change({ planner: value === DEFAULT_VALUE ? null : value })}
        />
      ) : null}
      {state.executors.length ? (
        <SettingsSelect
          label={t("orchestrator.settingsExecutor")}
          hint={
            executorMissing.length
              ? t("orchestrator.missingOn", { accounts: joinList(executorMissing, locale) })
              : undefined
          }
          value={state.executor ?? DEFAULT_VALUE}
          options={options(state.executors, t("orchestrator.default"))}
          onValueChange={(value) => change({ executor: value === DEFAULT_VALUE ? null : value })}
        />
      ) : null}
      {presets.length > 1 ? (
        <SettingsRow label={t("orchestrator.presets")}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            {presets.map((preset) => {
              const active = state.planner === preset.planner && state.executor === preset.executor;
              const labelKey =
                preset.id === "quality"
                  ? "orchestrator.presetQuality"
                  : preset.id === "balanced"
                    ? "orchestrator.presetBalanced"
                    : "orchestrator.presetDefault";
              return (
                <Button
                  key={preset.id}
                  colors={colors}
                  size="sm"
                  variant={active ? "primary" : "secondary"}
                  label={t(labelKey)}
                  onPress={() => change({ planner: preset.planner, executor: preset.executor })}
                />
              );
            })}
          </View>
        </SettingsRow>
      ) : null}
    </>
  );
}

/** Modal to configure an optional per-account Orchestrator override for a profile account. */
export function AccountOrchestratorDialog({
  colors,
  account,
  onSaved,
  onClose,
}: {
  colors: Colors;
  account: AccountSummary;
  onSaved(state: OrchestratorState): void;
  onClose(): void;
}) {
  const { t } = useAntigravityTranslation();
  const toast = useToast();
  const cache = useQueryClient();
  const read = useRpc(getOrchestratorRpc);
  const save = useRpc(setOrchestratorRpc);
  const query = useQuery({ queryKey: ORCHESTRATOR_QUERY_KEY, queryFn: () => read({}), staleTime: 60_000 });
  const state = query.data;
  const label = displayLabel(account.label, t, account.kind);

  const [mode, setMode] = useState<"inherit" | "custom">(account.orchestratorOverride ? "custom" : "inherit");
  const [planner, setPlanner] = useState<string>(account.orchestratorOverride?.planner ?? DEFAULT_VALUE);
  const [executor, setExecutor] = useState<string>(account.orchestratorOverride?.executor ?? DEFAULT_VALUE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const seededAccountRef = useRef<string | null>(account.orchestratorOverride ? account.id : null);

  useEffect(() => {
    if (account.orchestratorOverride) {
      seededAccountRef.current = account.id;
      return;
    }
    if (seededAccountRef.current === account.id) return;
    if (state && mode === "custom") {
      seededAccountRef.current = account.id;
      setPlanner(state.planner ?? DEFAULT_VALUE);
      setExecutor(state.executor ?? DEFAULT_VALUE);
    }
  }, [account.id, account.orchestratorOverride, state, mode]);

  const accountPlanners = (state?.planners ?? []).filter((family) => family.accounts.includes(account.id));
  const accountExecutors = (state?.executors ?? []).filter((family) => family.accounts.includes(account.id));
  const plannerList = accountPlanners.length ? accountPlanners : (state?.planners ?? []);
  const executorList = accountExecutors.length ? accountExecutors : (state?.executors ?? []);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await save(
        mode === "inherit"
          ? { accountId: account.id, inheritGlobal: true }
          : {
              accountId: account.id,
              planner: planner === DEFAULT_VALUE ? null : planner,
              executor: executor === DEFAULT_VALUE ? null : executor,
            },
      );
      cache.setQueryData(ORCHESTRATOR_QUERY_KEY, result.state);
      onSaved(result.state);
      toast.show(t("dialog.overrideSaved", { label }), { variant: "success" });
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }

  return (
    <Modal open title={t("dialog.overrideTitle", { label })} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          <Button
            colors={colors}
            size="sm"
            variant={mode === "inherit" ? "primary" : "secondary"}
            label={t("dialog.overrideInherit")}
            disabled={busy}
            onPress={() => setMode("inherit")}
          />
          <Button
            colors={colors}
            size="sm"
            variant={mode === "custom" ? "primary" : "secondary"}
            label={t("dialog.overrideCustom")}
            disabled={busy}
            onPress={() => setMode("custom")}
          />
        </View>

        {mode === "custom" && state ? (
          <View style={{ gap: space.sm }}>
            {plannerList.length ? (
              <SettingsSelect
                label={t("orchestrator.planner")}
                value={planner}
                options={options(plannerList, t("orchestrator.default"))}
                onValueChange={setPlanner}
                disabled={busy}
              />
            ) : null}
            {executorList.length ? (
              <SettingsSelect
                label={t("orchestrator.executor")}
                value={executor}
                options={options(executorList, t("orchestrator.default"))}
                onValueChange={setExecutor}
                disabled={busy}
              />
            ) : null}
          </View>
        ) : mode === "custom" && query.isLoading ? (
          <Muted colors={colors}>{t("loading")}</Muted>
        ) : state ? (
          <Text style={{ ...font.small, color: colors.foregroundMuted }}>
            {t("orchestrator.slashCurrent", {
              planner: state.planner ?? t("orchestrator.default"),
              executor: state.executor ?? t("orchestrator.default"),
            })}
          </Text>
        ) : null}

        {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}

        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
          <Button colors={colors} variant="ghost" label={t("dialog.cancel")} disabled={busy} onPress={onClose} />
          <Button colors={colors} variant="primary" label={t("dialog.save")} loading={busy} onPress={() => void submit()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
