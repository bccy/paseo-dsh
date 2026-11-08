/**
 * The reader-facing label for a team member named by DSH's wire target.
 *
 * DSH forces a member's `name` to lower-kebab English (it validates the wire
 * name), while the member's `description` is the sentence its Lead wrote in the
 * reader's language. `send_message` / `interrupt_agent` rows carry the target as
 * their head's second half, so the description has to come from somewhere the
 * mapper can see.
 *
 * **It comes from the item's own metadata.** `server/timeline.ts` writes the
 * session's current `name → description` roster (learned from `spawn_teammate` /
 * `list_agents` rows and merged from replay) as
 * `metadata.teamRoster` on the team tool rows that consume it. There is no
 * client-side roster cache: a global `Map` keyed by name would mix two sessions that both have a
 * `reviewer`, and the timeline transformer has no agent id to scope it with
 * (`PluginTimelineTransformerContribution.transform` receives only
 * `{item, phase}`). Rows transformed from one item share nothing with rows from
 * another, so sessions cannot contaminate each other, and a reopened session's
 * rows carry the label even when the rendered range has no `spawn_teammate` or
 * `list_agents` row.
 *
 * **Degradation:** an item without the metadata (an old daemon, a row emitted
 * before any roster was known, or a profile with no team) falls back to the
 * target unchanged — exactly the pre-roster card, never a blank head.
 *
 * @module dsh-paseo/client/team-roster
 */

/** A parsed per-item roster: `target` → non-empty description. */
export type TeamRoster = ReadonlyMap<string, string>;

/** `"—"` is the only sensible label for an already-empty target; never return `""`. */
const EMPTY_TARGET_LABEL = "—";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the roster off one item's provider metadata.
 *
 * `undefined` for a missing or malformed value (and for an empty roster), which
 * callers treat as "no roster": the target is the label. Entries are validated
 * one by one — a description that is not a string or is only whitespace is
 * dropped rather than turned into a blank label. A dirty entry does not discard
 * its well-formed siblings, because the rest of the roster is still true.
 */
export function rosterFromMetadata(metadata: unknown): TeamRoster | undefined {
  if (!isRecord(metadata)) return undefined;
  const raw = metadata.teamRoster;
  if (!isRecord(raw)) return undefined;
  const roster = new Map<string, string>();
  for (const [target, description] of Object.entries(raw)) {
    if (target === "" || typeof description !== "string" || description.trim() === "") continue;
    roster.set(target, description);
  }
  return roster.size === 0 ? undefined : roster;
}

/**
 * The label for one target: the remembered description when this item's roster
 * has a non-empty one, the target itself otherwise.
 *
 * An empty target is protected explicitly: the card mappers already reject it,
 * but this helper is also the contract for any future caller, and returning `""`
 * would draw a blank second half. `"—"` is language-neutral, so no locale copy
 * enters the roster path.
 */
export function labelFor(roster: TeamRoster | undefined, target: string): string {
  if (target === "") return EMPTY_TARGET_LABEL;
  const description = roster?.get(target);
  return description === undefined || description === "" ? target : description;
}