/**
 * The goal pill's host-scoped "seen" document (UI-v7 persistence, 2026-11-08).
 *
 * `{ seen: { [agentId]: goalSeenKey } }`: for each agent, the `id:revision` of
 * the completed goal whose panel the user opened and then really closed. Paseo
 * keeps the document on the host
 * (`~/.paseo/plugin-settings/<pluginId>/goal-pill-seen.json` via
 * `PluginSettingsStore`), so an app restart, a plugin reload or even a daemon
 * restart no longer forgets it and a completed goal cannot show once more.
 * `client/goal-pill.tsx` hydrates it through `client/seen-persistence` and
 * writes it only on a confirmed panel close.
 *
 * The definition is built by a function, not at import time: the client bundle
 * needs only the id from this module, and running the host's `defineSettings`
 * while the bundle loads would tie every pill's contribution to a settings API
 * that older Paseos do not have.
 *
 * The schema normalises every document into a map instead of failing: a
 * missing, old or corrupt value reads as an empty map — the pre-persistence
 * behaviour of showing the goal once more — never as `invalid`, which would
 * hide every closed goal in the document.
 *
 * @module dsh-paseo/shared/goal-seen-settings
 */
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { SEEN_SETTINGS_VERSION, seenDocumentOf } from "./seen-settings";

/** The settings id `settingsRpc(id)` uses on the client. */
export const GOAL_SEEN_SETTINGS_ID = "goal-pill-seen";

/** The definition the server half registers (host scope is the only scope Paseo supports). */
export function defineGoalSeenSettings() {
  return defineSettings({
    id: GOAL_SEEN_SETTINGS_ID,
    scope: "host",
    version: SEEN_SETTINGS_VERSION,
    schema: z.unknown().transform((value) => seenDocumentOf(value)),
  });
}