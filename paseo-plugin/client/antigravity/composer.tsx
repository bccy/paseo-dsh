import { useComposer, type PluginComposer } from "@getpaseo/plugin/client";
import { Select } from "@getpaseo/plugin/client/ui";
import { ACCOUNT_METADATA_KEY, isAntigravityProvider } from "../../shared/antigravity/contracts";
import { displayLabel } from "./labels";
import { useAntigravityTranslation } from "./messages";
import { useAccounts } from "./useAccounts";

function DraftAccount({ composer }: { composer: PluginComposer }) {
  const { data } = useAccounts();
  const { t } = useAntigravityTranslation();
  if (!data) return null;
  const selected = composer.agent.metadata[ACCOUNT_METADATA_KEY];
  const activeValue = typeof selected === "string" ? selected : data.defaultAccountId;
  // Offer usable accounts that are not known to be signed out (keep the currently selected one visible if already picked).
  const selectable = data.accounts.filter(
    (account) => account.usable && (account.status !== "signed-out" || account.id === activeValue),
  );
  const candidates = selectable.length > 0 ? selectable : data.accounts.filter((account) => account.usable);
  const options = candidates.map((account) => {
    const email = account.kind === "profile" && account.status === "signed-out" ? null : account.email;
    return {
      value: account.id,
      label: displayLabel(account.label, t, account.kind),
      description: t("composerDescription", {
        detail: [email ?? t(`kind.${account.kind}`), account.plan].filter(Boolean).join(" · "),
        status: t(`status.${account.status}`),
      }),
    };
  });
  return (
    <Select
      title={t("account")}
      icon="UserRound"
      value={activeValue}
      options={options}
      // An explicit "default" keeps the system sign-in even when another account is the default.
      onValueChange={({ value }) => composer.setMetadata({ [ACCOUNT_METADATA_KEY]: value })}
    />
  );
}

/** Account picker for drafts and the New workspace composer; running agents use the pill. */
export function ComposerAccount() {
  const composer = useComposer();
  if (composer.context === "agent" || !isAntigravityProvider(composer.agent.provider)) return null;
  return <DraftAccount composer={composer} />;
}
