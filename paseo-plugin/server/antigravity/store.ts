import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  SYSTEM_ACCOUNT_ID,
  fallbackStrategySchema,
  orchestratorChoiceSchema,
} from "../../shared/antigravity/contracts";
import { storeFile } from "./paths";

const storedAccountSchema = z.object({
  id: z.string().regex(/^a[0-9a-f]{8}$/),
  label: z.string(),
  createdAt: z.string(),
  email: z.string().nullable().default(null),
  /** Sign-in files found in the profile after the last sign-in, relative to the profile HOME. */
  credentialFiles: z.array(z.string()).default([]),
  /** Set when a sign-in landed outside the profile; the account is not launched while set. */
  unsafeDetail: z.string().nullable().default(null),
  /** Whether automatic fallback may switch turns onto this account. */
  fallbackEnabled: z.boolean().default(true),
  /** Per-account Orchestrator override; null inherits the global settings.json choice. */
  orchestrator: orchestratorChoiceSchema.nullable().default(null),
});

const storeSchema = z.object({
  version: z.literal(1).default(1),
  defaultAccountId: z.string().default(SYSTEM_ACCOUNT_ID),
  systemLabel: z.string().default("System sign-in"),
  systemEmail: z.string().nullable().default(null),
  systemFallbackEnabled: z.boolean().default(true),
  /** Explicit display & fallback priority order of account ids (including "default"). */
  order: z.array(z.string()).default([]),
  accounts: z.array(storedAccountSchema).default([]),
  fallback: z
    .object({
      enabled: z.boolean().default(true),
      retries: z.number().int().min(0).max(3).default(2),
      strategy: fallbackStrategySchema.default("order"),
    })
    .default({ enabled: true, retries: 2, strategy: "order" }),
});

export type StoredAccount = z.infer<typeof storedAccountSchema>;
export type StoreData = z.infer<typeof storeSchema>;

/** Normalizes the priority order so every existing account id appears once. */
export function orderedAccountIds(data: StoreData): string[] {
  const valid = new Set<string>([SYSTEM_ACCOUNT_ID, ...data.accounts.map((account) => account.id)]);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of data.order) {
    if (valid.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  if (!seen.has(SYSTEM_ACCOUNT_ID)) {
    seen.add(SYSTEM_ACCOUNT_ID);
    result.push(SYSTEM_ACCOUNT_ID);
  }
  for (const account of data.accounts) {
    if (!seen.has(account.id)) {
      seen.add(account.id);
      result.push(account.id);
    }
  }
  return result;
}

/** Persists the account list (never credentials) in the plugin's data directory. */
export class AccountStore {
  private data: StoreData = storeSchema.parse({});
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  async load(): Promise<StoreData> {
    this.loaded ??= (async () => {
      try {
        const raw = await fs.readFile(storeFile(), "utf8");
        this.data = storeSchema.parse(JSON.parse(raw));
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "ENOENT") {
          // Keep the unreadable file for inspection and start from defaults.
          const backup = `${storeFile()}.unreadable-${Date.now()}`;
          await fs.rename(storeFile(), backup).catch(() => undefined);
          console.error(`dsh-paseo/antigravity: could not read accounts.json, moved it to ${backup}`, error);
        }
        this.data = storeSchema.parse({});
      }
    })();
    await this.loaded;
    return this.data;
  }

  snapshot(): StoreData {
    return structuredClone(this.data);
  }

  get(accountId: string): StoredAccount | undefined {
    return this.data.accounts.find((account) => account.id === accountId);
  }

  /** Applies a change and writes the file atomically. Changes are serialized. */
  async update<T>(change: (data: StoreData) => T): Promise<T> {
    await this.load();
    const run = this.writing.then(async () => {
      const draft = structuredClone(this.data);
      const result = change(draft);
      const next = storeSchema.parse(draft);
      const file = storeFile();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.${Date.now()}.${++this.writeSeq}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, file);
      this.data = next;
      return result;
    });
    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  newAccountId(): string {
    for (;;) {
      const id = `a${randomBytes(4).toString("hex")}`;
      if (!this.get(id)) return id;
    }
  }
}
