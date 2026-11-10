/**
 * The agent-metadata keys the two finished-state pills keep their "seen"
 * signatures under (UI-v7, re-homed 2026-11-11).
 *
 * Both pills hide a finished state only after the user opened its panel and
 * `client/seen-close-gate` confirmed the close. Until Paseo 0.16 that fact lived
 * in a **host-scoped plugin settings document** (`{ seen: { [agentId]: signature
 * } }`), because a client-side `Map` was forgotten on every app restart. 0.16
 * gives plugins a better home: `PluginAgentSnapshot.metadata` is a durable
 * per-agent JSON record that the daemon persists with the agent itself, so the
 * signature now lives **beside the agent it describes** — no second document, no
 * 64-entry cap, no conflict/merge protocol between two devices writing the same
 * host-level file, and no separate read at startup: the value arrives with the
 * agent in the directory snapshot the pills already subscribe to.
 *
 * **The keys are namespaced with this plugin's provider id prefix (`dsh.`)** and
 * carry a lowerCamelCase name, so a key another plugin writes cannot collide
 * with ours. Paseo never reads a key it did not write; the value is a plain
 * string (the pill's own signature — `id:revision` for a goal, the all-done
 * board's task set for the team), never a JSON object, so an older build's or
 * another client's value is either usable as-is or ignorable.
 *
 * **The metadata is untrusted input.** Another client, an older plugin build or
 * a hand-edited agent record may have written anything under the key; both
 * helpers below accept only a non-empty string and treat everything else as
 * "nothing remembered" — the pre-persistence behaviour (the finished state shows
 * once more), never "hide every finished state forever".
 *
 * Pure by design — no zod, no host types — so the client controller
 * (`client/seen-metadata`) and the offline harness can drive it without a host.
 *
 * @module dsh-paseo/shared/pill-metadata
 */

/**
 * The goal pill's key: the `id:revision` of the completed goal whose panel the
 * user opened and then really closed.
 *
 * A new goal (a new `goal-<uuid>`) or a revision change is a new value, so it
 * shows again; the key names the exact completed revision the user closed.
 */
export const GOAL_SEEN_METADATA_KEY = "dsh.goalSeen";

/**
 * The team pill's key: the all-done board's task signature
 * (`task-N:revision`, joined), as `client/team-polling`'s `teamAllDoneKey`
 * builds it.
 */
export const TEAM_SEEN_METADATA_KEY = "dsh.teamSeen";

/** The metadata patch that stores one signature, ready for `setMetadata`. */
export function seenMetadataPatch(key: string, signature: string): Record<string, string> {
  return { [key]: signature };
}

/**
 * The signature `metadata[key]` carries, or `undefined` when there is none.
 *
 * Only a non-empty string is a signature. Anything else — a number, an object
 * from another build, `null` (which the daemon would treat as "remove the key"),
 * the empty string — reads as "nothing remembered".
 */
export function seenFromMetadata(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
  key: string,
): string | undefined {
  if (metadata === null || metadata === undefined) return undefined;
  const value = metadata[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}