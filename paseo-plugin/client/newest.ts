/**
 * Which timeline row is the newest one, and how long it should pulse.
 *
 * A plugin timeline renderer only receives its own item — `theme`, `host`,
 * `layout`, `agentId`, `item`, `timestamp` — so it cannot see its position in
 * the list. Position is what the pulse needs, though: a short command's
 * `tool/call` and `tool/result` reach the client in the same tick, so
 * `status === "running"` is never observable for it and a status-driven pulse
 * never runs.
 *
 * So each row reports its own `timestamp` here while rendering, and the maximum
 * seen per agent is the newest row. A row that stops being newest corrects
 * itself: while it pulses it re-renders 20 times a second, re-evaluates, and
 * stops. Nothing has to be pushed from the server.
 *
 * The newest row only pulses while it is fresh, so the last row of a finished
 * turn (or of a replayed history) settles instead of blinking forever. A row
 * that is still `running` pulses regardless of age.
 *
 * @module dsh-paseo/client/newest
 */
const latest = new Map<string, number>();

/** How long the newest row keeps pulsing after it appeared. */
export const NEWEST_PULSE_MS = 2500;

function atOf(timestamp: Date | string | number): number {
  const at = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  return Number.isFinite(at) ? at : 0;
}

/** True while this row is the newest one rendered for `agentId`. */
export function isNewest(agentId: string, timestamp: Date | string | number): boolean {
  const at = atOf(timestamp);
  if (at > (latest.get(agentId) ?? 0)) latest.set(agentId, at);
  return at >= (latest.get(agentId) ?? 0);
}

/** True while a newest row is still recent enough to read as "just happened". */
export function isFresh(timestamp: Date | string | number, now: number): boolean {
  return now - atOf(timestamp) < NEWEST_PULSE_MS;
}
