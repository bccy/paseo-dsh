import fs from "node:fs/promises";
import path from "node:path";
import {
  SYSTEM_ACCOUNT_ID,
  type AccountCooldown,
  type AccountSummary,
  type AccountsState,
  type FallbackSettings,
  type OrchestratorChoice,
  type QuotaGroup,
  type SavedFiles,
} from "../../shared/antigravity/contracts";
import { agyVersion, probeAccount, readAccountEmail, readPlan, type AccountPlan } from "./agy";
import { dataDir, displayPath, profileHome, resolveAgy } from "./paths";
import {
  deleteSignIn,
  ensureProfile,
  recoverSavedFiles,
  recoveryFolder,
  removeProfile,
  savedFiles,
  scanAfterSignIn,
} from "./profile";
import { SignInManager } from "./signin";
import { AccountStore, orderedAccountIds, type StoredAccount } from "./store";

const statusFile = () => path.join(dataDir(), "status.json");

interface RuntimeStatus {
  status: AccountSummary["status"];
  statusDetail: string | null;
  checkedAt: string | null;
  quota: QuotaGroup[] | null;
  /** The plan agy reported, and when it was last asked. */
  plan: AccountPlan | null;
  planCheckedAt: string | null;
}

const UNKNOWN: RuntimeStatus = {
  status: "unknown",
  statusDetail: null,
  checkedAt: null,
  quota: null,
  plan: null,
  planCheckedAt: null,
};

/** Plans rarely change: ask again after this long, or sooner while none is known. */
const PLAN_MAX_AGE_MS = 6 * 60 * 60_000;
const PLAN_RETRY_MS = 30 * 60_000;

export interface StatusUpdateEvent {
  accountId: string;
  status: AccountSummary["status"];
  quota: QuotaGroup[] | null;
  signedInChanged: boolean;
}

/** Owns the account list, sign-in state, and change notifications. */
export class AccountService {
  readonly store = new AccountStore();
  readonly signIns = new SignInManager();
  private readonly runtime = new Map<string, RuntimeStatus>();
  private readonly probing = new Map<string, { epoch: number; task: Promise<void> }>();
  private readonly epochs = new Map<string, number>();
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly statusListeners = new Set<(event: StatusUpdateEvent) => void>();
  private cooldownProvider: (accountId: string) => AccountCooldown[] = () => [];
  /** Starts from the clock so it keeps increasing across daemon and plugin restarts. */
  private revision = Date.now();
  private agyPath: string | null = null;
  private agyVersionValue: string | null = null;
  private agyChecked = false;

  private initialized: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private statusWriting: Promise<void> = Promise.resolve();
  private statusWriteSeq = 0;

  /** Loads the account list and the last known statuses, so a restart shows quota at once. */
  init(): Promise<void> {
    this.initialized ??= (async () => {
      await this.store.load();
      try {
        const raw = JSON.parse(await fs.readFile(statusFile(), "utf8")) as Record<string, RuntimeStatus>;
        for (const [id, status] of Object.entries(raw)) {
          // Older caches have no plan fields.
          if (id === SYSTEM_ACCOUNT_ID || this.store.get(id)) this.runtime.set(id, { ...UNKNOWN, ...status });
        }
      } catch {
        // No cache yet.
      }
    })();
    return this.initialized;
  }

  private bumpEpoch(accountId: string): number {
    const next = (this.epochs.get(accountId) ?? 0) + 1;
    this.epochs.set(accountId, next);
    return next;
  }

  private epochOf(accountId: string): number {
    return this.epochs.get(accountId) ?? 0;
  }

  private exists(accountId: string): boolean {
    return accountId === SYSTEM_ACCOUNT_ID || Boolean(this.store.get(accountId));
  }

  private saveStatuses(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const body = JSON.stringify(Object.fromEntries(this.runtime), null, 1);
      const file = statusFile();
      const seq = ++this.statusWriteSeq;
      const temp = `${file}.${process.pid}.${Date.now()}.${seq}.tmp`;
      this.statusWriting = this.statusWriting
        .then(async () => {
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fs.writeFile(temp, body, { mode: 0o600 });
          await fs.rename(temp, file);
        })
        .catch(async (error: unknown) => {
          await fs.rm(temp, { force: true }).catch(() => undefined);
          console.error("dsh-paseo/antigravity: could not save statuses", error);
        });
    }, 1000);
  }

  setCooldownProvider(provider: (accountId: string) => AccountCooldown[]): void {
    this.cooldownProvider = provider;
  }

  onChange(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatusUpdated(listener: (event: StatusUpdateEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  currentRevision(): number {
    return this.revision;
  }

  /** Publishes a revision bump (e.g. when a cooldown is set or cleared). */
  notifyChange(): void {
    this.changed();
  }

  private changed(): void {
    this.revision += 1;
    this.saveStatuses();
    for (const listener of this.listeners) {
      try {
        listener(this.revision);
      } catch (error) {
        console.error("dsh-paseo/antigravity: change listener failed", error);
      }
    }
  }

  private emitStatus(event: StatusUpdateEvent): void {
    for (const listener of this.statusListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("dsh-paseo/antigravity: status listener failed", error);
      }
    }
  }

  async agy(force = false): Promise<string | null> {
    if (!this.agyChecked || force || !this.agyPath) {
      const previous = this.agyPath;
      this.agyPath = await resolveAgy();
      this.agyChecked = true;
      if (this.agyPath && (this.agyPath !== previous || !this.agyVersionValue)) {
        this.agyVersionValue = await agyVersion(this.agyPath).catch(() => null);
      }
    }
    return this.agyPath;
  }

  async requireAgy(): Promise<string> {
    const agy = await this.agy();
    if (!agy) throw new Error("agy was not found on this host. Install the Antigravity CLI first.");
    return agy;
  }

  /** Throws unless the id names an existing account. */
  requireAccount(accountId: string): StoredAccount | null {
    if (accountId === SYSTEM_ACCOUNT_ID) return null;
    const account = this.store.get(accountId);
    if (!account) throw new Error("That Antigravity account no longer exists.");
    return account;
  }

  requireProfileAccount(accountId: string): StoredAccount {
    const account = this.requireAccount(accountId);
    if (!account) throw new Error("The system sign-in is managed by agy itself.");
    return account;
  }

  labelOf(accountId: string): string {
    if (accountId === SYSTEM_ACCOUNT_ID) return this.store.snapshot().systemLabel;
    return this.store.get(accountId)?.label ?? accountId;
  }

  /** Snapshot map of account id -> display label (including the system sign-in). */
  accountLabels(): Record<string, string> {
    const data = this.store.snapshot();
    const labels: Record<string, string> = {
      [SYSTEM_ACCOUNT_ID]: data.systemLabel,
    };
    for (const account of data.accounts) {
      labels[account.id] = account.label;
    }
    return labels;
  }

  /** Ensures a profile account's HOME and settings.json (with any per-account Orchestrator override). */
  async ensureAccountProfile(accountId: string): Promise<string | null> {
    if (accountId === SYSTEM_ACCOUNT_ID) return null;
    const account = this.store.get(accountId);
    if (!account) return null;
    return ensureProfile(accountId, account.orchestrator);
  }

  /** Re-syncs settings.json into every existing profile (e.g. after global Orchestrator settings change). */
  async syncAllProfiles(): Promise<void> {
    const accounts = this.store.snapshot().accounts;
    await Promise.all(
      accounts.map((account) =>
        ensureProfile(account.id, account.orchestrator).catch((error: unknown) => {
          console.error(`dsh-paseo/antigravity: could not sync settings for ${account.id}`, error);
        }),
      ),
    );
  }

  /** Re-checks sign-in and quota for one account. Concurrent calls of the same epoch share one probe. */
  refreshOne(accountId: string, options?: { forcePlan?: boolean }): Promise<void> {
    const epoch = this.epochOf(accountId);
    const running = this.probing.get(accountId);
    if (running && running.epoch === epoch && !options?.forcePlan) return running.task;
    const task = (async () => {
      if (!this.exists(accountId)) return;
      const agy = await this.agy();
      const checkedAt = new Date().toISOString();
      const previous = this.runtime.get(accountId) ?? UNKNOWN;
      if (!agy) {
        if (!this.exists(accountId) || this.epochOf(accountId) !== epoch) return;
        this.runtime.set(accountId, {
          ...previous,
          status: "error",
          statusDetail: "agy was not found on this host",
          checkedAt,
          quota: null,
        });
        return;
      }
      if (accountId !== SYSTEM_ACCOUNT_ID) {
        if (!this.exists(accountId) || this.epochOf(accountId) !== epoch) return;
        await this.ensureAccountProfile(accountId);
      }
      const result = await probeAccount(agy, accountId);
      if (!this.exists(accountId) || this.epochOf(accountId) !== epoch) return;
      const email = result.kind === "signed-in" ? await readAccountEmail(accountId) : null;
      const knownEmail =
        accountId === SYSTEM_ACCOUNT_ID ? this.store.snapshot().systemEmail : (this.store.get(accountId)?.email ?? null);
      let { plan, planCheckedAt } = previous;
      if (result.kind === "signed-out") {
        plan = null;
        planCheckedAt = null;
      } else if (result.kind === "signed-in") {
        // Another Google account signed in here: the old plan no longer applies.
        const otherAccount = email !== null && knownEmail !== null && email !== knownEmail;
        const age = planCheckedAt ? Date.now() - Date.parse(planCheckedAt) : Infinity;
        const shouldCheckPlan =
          otherAccount ||
          (options?.forcePlan && !plan) ||
          age > (plan ? PLAN_MAX_AGE_MS : PLAN_RETRY_MS);
        if (shouldCheckPlan) {
          const read = await readPlan(agy, accountId).catch(() => null);
          if (!this.exists(accountId) || this.epochOf(accountId) !== epoch) return;
          if (read) {
            plan = read;
            planCheckedAt = new Date().toISOString();
          } else {
            plan = otherAccount ? null : plan;
            // When the user explicitly refreshed and plan is still missing, do not lock out another manual retry.
            planCheckedAt = options?.forcePlan && !plan ? null : new Date().toISOString();
          }
        }
      }
      if (!this.exists(accountId) || this.epochOf(accountId) !== epoch) return;
      const nextStatus: RuntimeStatus = {
        status: result.kind,
        statusDetail: result.kind === "signed-in" ? null : result.detail,
        checkedAt,
        quota: result.kind === "signed-in" ? result.quota : null,
        plan,
        planCheckedAt,
      };
      this.runtime.set(accountId, nextStatus);
      if (result.kind === "signed-in" && email && email !== knownEmail) {
        await this.store.update((data) => {
          if (accountId === SYSTEM_ACCOUNT_ID) data.systemEmail = email;
          else {
            const account = data.accounts.find((entry) => entry.id === accountId);
            if (account) account.email = email;
          }
        });
      } else if (result.kind === "signed-out" && accountId !== SYSTEM_ACCOUNT_ID && knownEmail !== null) {
        await this.store.update((data) => {
          const account = data.accounts.find((entry) => entry.id === accountId);
          if (account) account.email = null;
        });
      }
      this.emitStatus({
        accountId,
        status: result.kind,
        quota: nextStatus.quota,
        signedInChanged: previous.status !== result.kind,
      });
    })()
      .catch((error: unknown) => {
        if (!this.exists(accountId) || this.epochOf(accountId) !== epoch) return;
        this.runtime.set(accountId, {
          ...(this.runtime.get(accountId) ?? UNKNOWN),
          status: "error",
          statusDetail: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
          quota: null,
        });
      })
      .finally(() => {
        if (this.probing.get(accountId)?.task === task) this.probing.delete(accountId);
        if (this.exists(accountId)) this.changed();
      });
    this.probing.set(accountId, { epoch, task });
    return task;
  }

  async refreshAll(options?: { forcePlan?: boolean }): Promise<void> {
    await this.agy(true);
    const ids = orderedAccountIds(this.store.snapshot());
    await Promise.all(ids.map((id) => this.refreshOne(id, options)));
  }

  /** Last known status without probing. */
  knownStatus(accountId: string): AccountSummary["status"] {
    return this.runtime.get(accountId)?.status ?? "unknown";
  }

  /** Last known quota, probing first when nothing is known yet. */
  async quotaFor(accountId: string, maxAgeMs: number): Promise<RuntimeStatus> {
    const current = this.runtime.get(accountId);
    const age = current?.checkedAt ? Date.now() - Date.parse(current.checkedAt) : Infinity;
    if (!current || age > maxAgeMs) await this.refreshOne(accountId);
    return this.runtime.get(accountId) ?? UNKNOWN;
  }

  async state(): Promise<AccountsState> {
    const agy = await this.agy();
    const data = this.store.snapshot();
    const problems: string[] = [];
    if (!agy) problems.push("agy was not found on this host. Install the Antigravity CLI, then refresh.");
    const defaultExists =
      data.defaultAccountId === SYSTEM_ACCOUNT_ID ||
      data.accounts.some((account) => account.id === data.defaultAccountId);
    const defaultAccountId = defaultExists ? data.defaultAccountId : SYSTEM_ACCOUNT_ID;
    const byId = new Map<string, AccountSummary>();

    const system = this.runtime.get(SYSTEM_ACCOUNT_ID) ?? UNKNOWN;
    byId.set(SYSTEM_ACCOUNT_ID, {
      id: SYSTEM_ACCOUNT_ID,
      label: data.systemLabel,
      kind: "system",
      isDefaultForNewAgents: defaultAccountId === SYSTEM_ACCOUNT_ID,
      status: system.status,
      email: data.systemEmail,
      plan: system.plan?.name ?? null,
      statusDetail: system.statusDetail,
      checkedAt: system.checkedAt,
      quota: system.quota,
      createdAt: null,
      usable: true,
      fallbackEnabled: data.systemFallbackEnabled,
      cooldowns: this.cooldownProvider(SYSTEM_ACCOUNT_ID),
      orchestratorOverride: null,
    });

    for (const account of data.accounts) {
      const status = this.runtime.get(account.id) ?? UNKNOWN;
      byId.set(account.id, {
        id: account.id,
        label: account.label,
        kind: "profile",
        isDefaultForNewAgents: defaultAccountId === account.id,
        status: status.status,
        email: status.status === "signed-out" ? null : account.email,
        plan: status.plan?.name ?? null,
        statusDetail: account.unsafeDetail ?? status.statusDetail,
        checkedAt: status.checkedAt,
        quota: status.quota,
        createdAt: account.createdAt,
        usable: account.unsafeDetail === null,
        fallbackEnabled: account.fallbackEnabled,
        cooldowns: this.cooldownProvider(account.id),
        orchestratorOverride: account.orchestrator,
      });
    }

    const accounts = orderedAccountIds(data)
      .map((id) => byId.get(id))
      .filter((entry): entry is AccountSummary => Boolean(entry));

    return {
      accounts,
      defaultAccountId,
      agyPath: agy,
      agyVersion: this.agyVersionValue,
      problems,
      fallback: data.fallback,
      revision: this.revision,
    };
  }

  fallbackSettings(): FallbackSettings {
    return this.store.snapshot().fallback;
  }

  async setFallback(patch: Partial<FallbackSettings>): Promise<void> {
    await this.store.update((data) => {
      data.fallback = { ...data.fallback, ...patch };
    });
    this.changed();
  }

  /** Whether the sign-in file agy wrote for a profile account is still there (true when none was recorded). */
  async hasSignInFile(accountId: string): Promise<boolean> {
    const account = this.store.get(accountId);
    const recorded = account?.credentialFiles.find((file) => /oauth-token|token\.json|auth/i.test(file));
    if (!recorded) return true;
    return fs
      .stat(path.join(profileHome(accountId), recorded))
      .then(() => true)
      .catch(() => false);
  }

  /** Last known quota groups, without probing. */
  knownQuota(accountId: string): QuotaGroup[] | null {
    return this.runtime.get(accountId)?.quota ?? null;
  }

  async create(label: string): Promise<AccountSummary> {
    const id = this.store.newAccountId();
    await this.store.update((data) => {
      data.accounts.push({
        id,
        label,
        createdAt: new Date().toISOString(),
        email: null,
        credentialFiles: [],
        unsafeDetail: null,
        fallbackEnabled: true,
        orchestrator: null,
      });
      const order = orderedAccountIds(data);
      if (!order.includes(id)) order.push(id);
      data.order = order;
    });
    await this.ensureAccountProfile(id);
    this.runtime.set(id, { ...UNKNOWN, status: "signed-out", statusDetail: "Not signed in yet" });
    this.changed();
    const created = (await this.state()).accounts.find((account) => account.id === id);
    if (!created) throw new Error("The new account could not be read back.");
    return created;
  }

  async rename(accountId: string, label: string): Promise<void> {
    this.requireAccount(accountId);
    await this.store.update((data) => {
      if (accountId === SYSTEM_ACCOUNT_ID) data.systemLabel = label;
      else {
        const account = data.accounts.find((entry) => entry.id === accountId);
        if (account) account.label = label;
      }
    });
    this.changed();
  }

  async move(accountId: string, direction: "up" | "down"): Promise<void> {
    this.requireAccount(accountId);
    await this.store.update((data) => {
      const order = orderedAccountIds(data);
      const index = order.indexOf(accountId);
      if (index < 0) return;
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= order.length) return;
      const swapped = order[target]!;
      order[target] = order[index]!;
      order[index] = swapped;
      data.order = order;
    });
    this.changed();
  }

  async setAccountOptions(
    accountId: string,
    patch: { fallbackEnabled?: boolean; orchestratorOverride?: OrchestratorChoice | null },
  ): Promise<void> {
    this.requireAccount(accountId);
    if (accountId === SYSTEM_ACCOUNT_ID && patch.orchestratorOverride !== undefined) {
      throw new Error("The system account uses the global Orchestrator setting.");
    }
    await this.store.update((data) => {
      if (accountId === SYSTEM_ACCOUNT_ID) {
        if (patch.fallbackEnabled !== undefined) data.systemFallbackEnabled = patch.fallbackEnabled;
        return;
      }
      const entry = data.accounts.find((candidate) => candidate.id === accountId);
      if (!entry) return;
      if (patch.fallbackEnabled !== undefined) entry.fallbackEnabled = patch.fallbackEnabled;
      if (patch.orchestratorOverride !== undefined) entry.orchestrator = patch.orchestratorOverride;
    });
    if (accountId !== SYSTEM_ACCOUNT_ID && patch.orchestratorOverride !== undefined) {
      await this.ensureAccountProfile(accountId);
    }
    this.changed();
  }

  async setDefault(accountId: string): Promise<void> {
    const account = this.requireAccount(accountId);
    if (account?.unsafeDetail) throw new Error(account.unsafeDetail);
    await this.store.update((data) => {
      data.defaultAccountId = accountId;
    });
    this.changed();
  }

  /** What removing or recovering a profile account would move out of its home folder, and to where. */
  async savedFiles(accountId: string): Promise<SavedFiles> {
    const account = this.requireProfileAccount(accountId);
    return {
      items: await savedFiles(accountId),
      folder: displayPath(await recoveryFolder(account.label)),
    };
  }

  /** Recovers files agents saved in a profile HOME into ~/Antigravity Console without deleting the account. */
  async recoverSavedFiles(accountId: string): Promise<SavedFiles | null> {
    const account = this.requireProfileAccount(accountId);
    const preserved = await recoverSavedFiles(accountId, account.label);
    return preserved
      ? {
          items: preserved.items,
          folder: displayPath(preserved.folder),
          ...(preserved.copied.length ? { copied: preserved.copied } : {}),
        }
      : null;
  }

  /** Removes a profile account. Returns where its saved files went, or null when it had none. */
  async remove(accountId: string): Promise<SavedFiles | null> {
    const account = this.requireProfileAccount(accountId);
    this.bumpEpoch(accountId);
    this.probing.delete(accountId);
    this.signIns.cancelForAccount(accountId);
    const preserved = await removeProfile(accountId, account.label);
    await this.store.update((data) => {
      data.accounts = data.accounts.filter((entry) => entry.id !== accountId);
      data.order = data.order.filter((id) => id !== accountId);
      if (data.defaultAccountId === accountId) data.defaultAccountId = SYSTEM_ACCOUNT_ID;
    });
    this.runtime.delete(accountId);
    this.changed();
    return preserved ? { items: preserved.items, folder: displayPath(preserved.folder) } : null;
  }

  async signOut(accountId: string): Promise<void> {
    const account = this.requireProfileAccount(accountId);
    this.bumpEpoch(accountId);
    this.probing.delete(accountId);
    await deleteSignIn(accountId, account.credentialFiles);
    await this.store.update((data) => {
      const entry = data.accounts.find((candidate) => candidate.id === accountId);
      if (entry) {
        entry.credentialFiles = [];
        entry.email = null;
        entry.unsafeDetail = null;
      }
    });
    this.runtime.set(accountId, { ...UNKNOWN, status: "signed-out", statusDetail: "Signed out" });
    this.emitStatus({ accountId, status: "signed-out", quota: null, signedInChanged: true });
    this.changed();
    await this.refreshOne(accountId);
  }

  async startSignIn(accountId: string): Promise<{ loginId: string; url: string; expiresAt: string }> {
    this.requireProfileAccount(accountId);
    const agy = await this.requireAgy();
    await this.ensureAccountProfile(accountId);
    return this.signIns.start(agy, accountId);
  }

  /** Completes a sign-in, verifies it, and checks that it stayed inside the profile. */
  async submitSignIn(loginId: string, code: string): Promise<void> {
    const accountId = this.signIns.accountOf(loginId);
    if (!accountId) throw new Error("This sign-in expired or was cancelled. Start again.");
    const systemEmailBefore = this.store.snapshot().systemEmail;
    const outcome = await this.signIns.submit(loginId, code);
    const scan = await scanAfterSignIn(accountId, outcome.submittedAt);
    this.bumpEpoch(accountId);
    this.probing.delete(accountId);
    await this.refreshOne(accountId, { forcePlan: true });
    const status = this.runtime.get(accountId);
    let unsafeDetail: string | null = null;
    if (scan.leaked.length > 0) {
      unsafeDetail =
        `agy stored this sign-in outside the account's profile (${scan.leaked.join(", ")}). ` +
        "The plugin will not launch this account so it cannot overwrite the system sign-in.";
      console.error(`dsh-paseo/antigravity: sign-in for ${accountId} wrote ${scan.leaked.join(", ")}`);
    }
    await this.store.update((data) => {
      const entry = data.accounts.find((candidate) => candidate.id === accountId);
      if (!entry) return;
      if (scan.own.length > 0) entry.credentialFiles = scan.own;
      entry.unsafeDetail = unsafeDetail;
    });
    // A sign-in that changed the system account's identity means the keyring was written.
    if (status?.status === "signed-in" && systemEmailBefore) {
      await this.refreshOne(SYSTEM_ACCOUNT_ID);
      const systemEmailAfter = this.store.snapshot().systemEmail;
      const accountEmail = this.store.get(accountId)?.email ?? null;
      if (
        accountEmail &&
        systemEmailAfter &&
        systemEmailAfter !== systemEmailBefore &&
        systemEmailAfter === accountEmail
      ) {
        await this.store.update((data) => {
          const entry = data.accounts.find((candidate) => candidate.id === accountId);
          if (entry) {
            entry.unsafeDetail =
              "This sign-in replaced the system sign-in as well. Sign in to the system account again with agy, then remove this account.";
          }
        });
      }
    }
    this.changed();
    if (status?.status !== "signed-in") {
      const detail = status?.statusDetail ?? "agy did not confirm the sign-in";
      throw new Error(
        outcome.exitedCleanly
          ? `agy accepted the code but the account still is not signed in: ${detail}`
          : `agy did not finish the sign-in: ${detail}`,
      );
    }
  }

  cancelSignIn(loginId: string): void {
    this.signIns.cancel(loginId);
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.signIns.cancelAll();
    this.listeners.clear();
    this.statusListeners.clear();
  }
}
