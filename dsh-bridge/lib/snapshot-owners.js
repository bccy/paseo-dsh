/**
 * Which session a rewind's file snapshot belongs to.
 *
 * File snapshots are grouped by the session whose journal a rewind reads: the
 * conversation a human actually rewinds. A native subagent edits files from its
 * own session, whose log a parent rewind cannot address, so its edits must be
 * attributed to the ROOT (non-subagent) ancestor — anchored to the root's newest
 * human message at execution time — or the parent's `both` rewind would leave
 * them behind.
 *
 * This module is deliberately pure (no DSH imports) so the resolution rules are
 * assertable offline; the bridge wires it to the live session store.
 *
 * Resolution fails open: a missing `parentSession`, a parent that is not live,
 * or a lineage loop returns `undefined`, which the bridge treats as "do not
 * track this edit" (the same semantics as the pre-existing subagent skip).
 *
 * @module dsh-bridge/snapshot-owners
 */

/**
 * Whether a session is a delegated (native subagent) session rather than a
 * conversation a human can rewind directly.
 *
 * DSH marks both the origin and the depth in the durable header; either one is
 * authoritative, so a session that carries only one of them is still delegated.
 *
 * @param {object} session
 * @returns {boolean}
 */
export function isDelegatedSession(session) {
  return session?.header?.origin === 'subagent' || (session?.header?.delegationDepth ?? 0) > 0;
}

/**
 * The root ancestor of `session` — the session a rewind addresses.
 *
 * @param {object} session - the session that ran the editing tool.
 * @param {(id: string) => object | undefined} getSession - live-session lookup.
 * @returns {object | undefined} the root session, or undefined when the chain
 *   cannot be resolved (missing `parentSession`, dead parent, or a loop).
 */
export function rootSessionFor(session, getSession) {
  if (session === undefined || session === null) return undefined;
  let current = session;
  const seen = new Set();
  while (isDelegatedSession(current)) {
    const parentId = current?.header?.parentSession;
    if (parentId === undefined) return undefined;
    const key = String(parentId);
    // A lineage loop would otherwise spin forever: `parentSession` comes from a
    // durable header the bridge only reads.
    if (seen.has(key)) return undefined;
    seen.add(key);
    const parent = getSession?.(parentId);
    if (parent === undefined) return undefined;
    current = parent;
  }
  return current;
}
