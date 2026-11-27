/**
 * Shared RPC contract for host capability detection across DSH (`dsh`) and
 * Antigravity (`agy`).
 *
 * Kept strictly runtime-neutral (`@getpaseo/plugin` + `zod` only; zero `node:*`
 * imports, Hermes/React Native safe) so both the daemon server and client UI
 * validate against one source of truth.
 *
 * @module dsh-paseo/shared/capabilities
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const CAPABILITIES_GET_METHOD = "dsh.capabilities.get" as const;

export const capabilitiesSnapshotSchema = z.object({
  dshInstalled: z.boolean(),
  hasDshSessions: z.boolean(),
  dshVisible: z.boolean(),
  agyInstalled: z.boolean(),
  hasAntigravityData: z.boolean(),
  hasAntigravityAccounts: z.boolean(),
  antigravityVisible: z.boolean(),
});

export type CapabilitiesSnapshot = z.infer<typeof capabilitiesSnapshotSchema>;

export interface CapabilitiesPresenceInput {
  dshInstalled: boolean;
  hasDshSessions: boolean;
  agyInstalled: boolean;
  hasAntigravityData: boolean;
  hasAntigravityAccounts: boolean;
}

/**
 * Derives visibility flags from raw DSH and Antigravity presence signals:
 * - `dshVisible = dshInstalled || hasDshSessions`
 * - `antigravityVisible = agyInstalled || hasAntigravityData || hasAntigravityAccounts`
 */
export function buildCapabilitiesSnapshot(
  input: CapabilitiesPresenceInput,
): CapabilitiesSnapshot {
  return {
    dshInstalled: input.dshInstalled,
    hasDshSessions: input.hasDshSessions,
    dshVisible: input.dshInstalled || input.hasDshSessions,
    agyInstalled: input.agyInstalled,
    hasAntigravityData: input.hasAntigravityData,
    hasAntigravityAccounts: input.hasAntigravityAccounts,
    antigravityVisible:
      input.agyInstalled || input.hasAntigravityData || input.hasAntigravityAccounts,
  };
}

export const capabilitiesGetRpc = defineRpc({
  name: CAPABILITIES_GET_METHOD,
  input: z.object({}).strict(),
  output: capabilitiesSnapshotSchema,
});
