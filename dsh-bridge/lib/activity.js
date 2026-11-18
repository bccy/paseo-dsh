/**
 * What a bridge runtime still runs, asked the way DSH asks before it archives
 * a session.
 *
 * Paseo releases a resumable session after an hour without activity. It sees
 * its own foreground work, but not the work DSH keeps running on its own inside
 * this process: a background shell, a running subagent, a scheduled reminder.
 * Releasing a session ends that session's agent and its native subagent
 * subtree, and that work ends with it.
 *
 * DSH already answers this question for itself. Before the workspace registry
 * archives a session it runs the `workspace/session-activity` waterfall, and
 * each composed provider reports what still runs for that session: the agent
 * registry a running turn (including one waiting for an approval or an answer),
 * the job registry the session's live jobs, the subagent runtime its running
 * descendants, the schedule plugin its active reminders. Asking the same
 * waterfall keeps this answer in step with whatever the profile composes,
 * instead of re-deriving each service's state here.
 *
 * The scope is the released session and its own subtree, not the whole process.
 * One shared process serves every Paseo root session of a connection: releasing
 * one root closes that root's agent and the children below it (the bridge's
 * close disposes the root's handle and drops its descendants' tables, and Paseo
 * cancels the child agents), while the other roots keep the process alive. A
 * job belongs to the session that started it, so an idle child that left a
 * background shell running shows up only when the child itself is asked.
 *
 * @module dsh-paseo-bridge/activity
 */

const ACTIVITY_EVENT = 'workspace/session-activity';

/**
 * Report the work that releasing `sessionId`'s runtime would end.
 *
 * Every session in scope is asked, not only `sessionId`: a job belongs to the
 * session that started it, so an idle child that left a background shell
 * running shows up only when the child itself is asked. Descendants are found
 * through the bridge's own child table (`parentOf`) and, for a child the table
 * has not learned about yet, through the live agent's durable session header.
 *
 * The query only reads. It creates no agent and touches no inbox, so a session
 * whose agent was never created simply has nothing running.
 *
 * @param {object} ctx - Root context of the bridge process.
 * @param {object} scope - What Paseo wants to release.
 * @param {string} scope.sessionId - The native DSH session id.
 * @param {(id: string) => string | undefined} [scope.parentOf] - Native parent of a child session, if known.
 * @returns {Promise<Array<{ sessionId: string, kind: string, items?: Array<{ id: string, label?: string }> }>>}
 *   One entry per reported activity family; empty only when nothing would be lost.
 */
export async function runtimeActivity(ctx, { sessionId, parentOf = () => undefined }) {
  // Without the waterfall there is no way to know what runs. Failing makes
  // Paseo keep the runtime; answering "nothing" would let it end live work.
  if (typeof ctx.waterfall !== 'function') {
    throw new Error('this DSH runtime cannot report session activity');
  }
  const live = ctx.agents?.list?.();
  if (!Array.isArray(live)) throw new Error('the DSH agent registry is unavailable');

  /** live agent id -> its session, so a child's own durable header can name its parent. */
  const liveSessions = new Map();
  for (const agent of live) {
    const session = agent?.session;
    const id = String(session?.id ?? agent?.id ?? '');
    if (id !== '') liveSessions.set(id, session);
  }
  const parentOfLive = (id) => {
    const known = parentOf(id);
    if (known !== undefined) return known;
    const header = liveSessions.get(id)?.header;
    if (header?.origin !== 'subagent' || header.parentSession === undefined) return undefined;
    return String(header.parentSession);
  };

  const ids = new Set([sessionId]);
  for (const id of liveSessions.keys()) {
    if (descendsFrom(id, sessionId, parentOfLive)) ids.add(id);
  }

  const activity = [];
  for (const id of ids) {
    const families = await ctx.waterfall(ACTIVITY_EVENT, { sessionId: id }, () => Promise.resolve([]));
    if (!Array.isArray(families)) {
      throw new Error(`${ACTIVITY_EVENT} answered session ${id} with ${typeof families}, not a list`);
    }
    for (const family of families) activity.push(entryOf(id, family));
  }
  return activity;
}

/** Whether `id` is `ancestor` or lies below it in the durable session lineage. */
function descendsFrom(id, ancestor, parentOf) {
  const seen = new Set();
  for (let current = id; current !== undefined && !seen.has(current); current = parentOf(current)) {
    if (current === ancestor) return true;
    seen.add(current);
  }
  return false;
}

/**
 * One reported family in a shape the stdio transport can carry. A family DSH
 * reports without a recognisable kind still counts as activity: dropping it
 * would turn "something runs" into "nothing runs".
 */
function entryOf(sessionId, family) {
  const kind = typeof family?.kind === 'string' && family.kind !== '' ? family.kind : 'unknown';
  const items = Array.isArray(family?.items)
    ? family.items.map((item) => ({
      id: String(item?.id ?? ''),
      ...(typeof item?.label === 'string' && item.label !== '' ? { label: item.label } : {}),
    }))
    : undefined;
  return { sessionId, kind, ...(items === undefined ? {} : { items }) };
}