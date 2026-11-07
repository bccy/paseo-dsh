/**
 * The pure rules behind the pills' persisted "seen" documents (UI-v7
 * persistence, 2026-11-08).
 *
 * Both finished-state pills (team and goal) remember one signature per agent:
 * the panel the user opened and then really closed. That memory used to be a
 * client-side `Map`, so an app restart (the client bundle runs again) forgot it
 * and a finished board/answer appeared once more. It now lives in a
 * host-scoped plugin setting, one JSON document per settings id:
 * `{ seen: { [agentId]: signature } }` (`./team-seen-settings`,
 * `./goal-seen-settings`).
 *
 * The document is **untrusted**: an older build, another device or a corrupt
 * file may have written it. These helpers keep whatever is a string→string
 * entry and cap the map, so a bad document degrades to "nothing remembered"
 * (the pre-persistence behaviour: show once more) instead of producing
 * `invalid`, which would hide every finished pill forever.
 *
 * Pure by design — no zod, no host types — so the host schemas and the client
 * controller (`client/seen-persistence`) share one implementation and the
 * offline harness (`harness/team-pill-check.cjs`, `harness/goal-pill-check.cjs`)
 * can drive them without a host.
 *
 * @module dsh-paseo/shared/seen-settings
 */

/**
 * How many entries one settings document remembers.
 *
 * One entry per agent whose finished panel was closed: far more than any real
 * composer has, and a bounded document keeps every settings read and write
 * cheap. Entries are kept in insertion order and the oldest are dropped first;
 * at worst a long-forgotten agent shows one finished pill once more after a
 * reload.
 */
export const SEEN_SETTINGS_LIMIT = 64;

/** The document version both `seen` settings start with (bump with a `migrate`). */
export const SEEN_SETTINGS_VERSION = 1;

/** The valid entries of an untrusted value, in the document's own order. */
export function seenEntriesOf(value: unknown): Array<[string, string]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const entries: Array<[string, string]> = [];
  for (const [agentId, signature] of Object.entries(value as Record<string, unknown>)) {
    // agent ids and `id:revision` signatures are non-empty strings; anything
    // else is another build's noise and is dropped rather than kept.
    if (agentId === "" || typeof signature !== "string" || signature === "") continue;
    entries.push([agentId, signature]);
  }
  return entries;
}

/** The sanitised map, keeping at most `limit` newest entries. */
export function seenMapOf(value: unknown, limit: number = SEEN_SETTINGS_LIMIT): Record<string, string> {
  const entries = seenEntriesOf(value);
  const kept = entries.length > limit ? entries.slice(entries.length - limit) : entries;
  const map: Record<string, string> = {};
  for (const [agentId, signature] of kept) map[agentId] = signature;
  return map;
}

/** Drop the oldest entries until the map holds at most `limit`. */
export function capSeenMap(map: Record<string, string>, limit: number = SEEN_SETTINGS_LIMIT): Record<string, string> {
  const entries = Object.entries(map);
  if (entries.length <= limit) return { ...map };
  const kept: Record<string, string> = {};
  for (const [agentId, signature] of entries.slice(entries.length - limit)) kept[agentId] = signature;
  return kept;
}

/**
 * One settings document's value from an untrusted JSON value.
 *
 * Used as the schema's transform for both settings: any JSON value (a missing
 * file parses as `{}`) becomes `{ seen }`, so the host never answers `invalid`.
 */
export function seenDocumentOf(value: unknown, limit: number = SEEN_SETTINGS_LIMIT): { seen: Record<string, string> } {
  const document =
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  return { seen: seenMapOf(document?.["seen"], limit) };
}

/**
 * Merge this client's pending writes over a document just read from the host.
 *
 * Stored entries win for agents this client did not touch (another device may
 * have closed their panels); pending entries win for their own agents. An
 * existing key keeps its position, so the cap keeps the most recently *added*
 * agents and drops the oldest.
 */
export function mergeSeenValues(
  stored: unknown,
  pending: ReadonlyMap<string, string>,
  limit: number = SEEN_SETTINGS_LIMIT,
): Record<string, string> {
  // No cap before merging: the pending entries must be able to displace stored
  // ones even when the stored document is already at the limit.
  const merged = seenMapOf(stored, Number.MAX_SAFE_INTEGER);
  for (const [agentId, signature] of pending) {
    if (agentId === "" || signature === "") continue;
    merged[agentId] = signature;
  }
  return capSeenMap(merged, limit);
}