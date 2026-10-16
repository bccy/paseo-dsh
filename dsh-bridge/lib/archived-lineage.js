/**
 * DSH's archive-lineage rule, ported verbatim from the session controller's
 * `underArchivedSession` (see `@deepseek-ai/dsh-api-session-controller`).
 *
 * An archived Session, or a subagent descendant of one, must not run a model
 * step until it is restored. Lineage follows the durable header fields through
 * `origin: 'subagent'` Sessions only: a fork of an archived Session is an
 * independent conversation and never inherits the archive.
 *
 * This lives in its own dependency-free module because the rest of the bridge
 * imports profile-only packages (`@deepseek-ai/dsh-llm`, `dsh-agent`, …) that
 * no harness process outside a DSH profile can resolve. Keeping the rule pure
 * is what lets `harness/archived-lineage-check.mjs` exercise it directly.
 *
 * @module dsh-paseo-bridge/archived-lineage
 */

/**
 * Whether one Session is archived, directly or through a subagent ancestor.
 *
 * @param headers - session id -> durable header (`id`, `origin`, `parentSession`).
 *   A missing header ends the walk: the id itself was already checked.
 * @param archivedIds - the registry-global archive set (iterable or Set).
 * @param sessionId - the Session to classify.
 * @returns whether an archived Session owns this one.
 */
export function underArchivedSession(headers, archivedIds, sessionId) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds);
  const visited = new Set();
  let current = sessionId === undefined || sessionId === null ? '' : String(sessionId);
  while (current !== '' && !visited.has(current)) {
    if (archived.has(current)) return true;
    visited.add(current);
    const header = headers.get(current);
    if (header === undefined) return false;
    if (header.origin !== 'subagent' || header.parentSession === undefined) return false;
    current = String(header.parentSession);
  }
  return false;
}
