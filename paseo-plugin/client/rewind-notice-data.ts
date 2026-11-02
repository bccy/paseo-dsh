/**
 * The client half's contract for the rewind report row.
 *
 * Paseo's provider bridge turns a `session.notice` into a `notification`
 * timeline item (`translateNotice` in the host's `plugin-provider.js`) and drops
 * the notice's own id on the way. A plugin timeline transformer can still take
 * that row over — `projectPluginTimelineItems` routes `notification` items
 * through the same transform as every other `AgentTimelineItem` — but the text
 * is the only handle it gets. `shared/rewind-notice.ts` is therefore the single
 * source both halves read for recognition.
 *
 * This module is deliberately free of React and of the host runtime: the
 * offline check compiles it to CommonJS and drives it directly, so the gate and
 * the transform are exercised as real code rather than as a regex over source.
 *
 * @module dsh-paseo/client/rewind-notice-data
 */
import { z } from "zod";
import {
  rewindNoticeHeadline,
  rewindNoticeTone,
  type RewindTone,
} from "../shared/rewind-notice";

/** Timeline renderer kind registered for the rewind report row. */
export const REWIND_NOTICE_KIND = "dsh-rewind-notice";
/** Row schema version; bump when `RewindNoticeData` changes incompatibly. */
export const REWIND_NOTICE_VERSION = 1;

/** Data one transformed rewind row carries. */
export interface RewindNoticeData {
  /** The host-joined notice text (`title\n description`), shown verbatim. */
  message: string;
  /** `success` paints the row green and raises a success capsule. */
  tone: RewindTone;
  /** Lets the value satisfy the protocol's JSON-object contract. */
  [key: string]: string;
}

/** Runtime schema for {@link RewindNoticeData}. */
export const rewindNoticeSchema = z.object({
  message: z.string(),
  tone: z.enum(["success", "warning"]),
});

/**
 * Map one host notification to the plugin row this client draws.
 *
 * Returns `undefined` for every notification that is not a rewind report, which
 * keeps Paseo's own renderer for the canary, open warnings and other providers'
 * notices. That fallback is deliberate: taking over only what this plugin
 * understands is the same rule the tool-row transformer follows.
 */
export function rewindNoticeItem(message: string): {
  kind: string;
  version: number;
  data: RewindNoticeData;
} | undefined {
  const tone = rewindNoticeTone(message);
  if (tone === undefined) return undefined;
  return { kind: REWIND_NOTICE_KIND, version: REWIND_NOTICE_VERSION, data: { message, tone } };
}

/**
 * How long after its own timestamp a notice may still raise a capsule.
 *
 * A live notice arrives in the same tick as its timeline row, so its timestamp
 * is effectively "now". A replayed or scrolled-back row keeps the timestamp it
 * was first recorded with, and cannot honestly be called a live arrival. The
 * gate already refuses replayed commit bursts via `client/newest`'s judgement;
 * this window is the second line of defence for a short history where a
 * single-row first paint is indistinguishable from live activity (the same
 * ambiguity `newest.ts` documents).
 */
export const REWIND_TOAST_MAX_AGE_MS = 6_000;

/** Input to one capsule decision. */
export interface RewindToastInput {
  agentId: string;
  /** The row's timestamp, as the host forwards it (Date/string/number). */
  timestamp: Date | string | number;
  /** The full host-joined notice text; it identifies the notice. */
  message: string;
  /** `useRowPulse`'s `fresh`: this row committed now, outside a replay burst. */
  fresh: boolean;
  /** The caller's clock, injected so the check can drive it deterministically. */
  now: number;
}

/** Milliseconds of one timestamp, or `undefined` when it is not a date. */
function timeOf(timestamp: Date | string | number): number | undefined {
  const at = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  return Number.isFinite(at) ? at : undefined;
}

/**
 * The one-shot capsule gate.
 *
 * Three refusals, each covering a different way the same notice could be shown
 * twice:
 *
 * - `fresh === false` — the row was part of a replay/commit batch, or belongs to
 *   a historical timeline that has just been painted; the pulse rule already
 *   decided it is not live activity.
 * - the timestamp is older than {@link REWIND_TOAST_MAX_AGE_MS} — a history row
 *   that happens to paint first (a short session, a scroll into unloaded rows)
 *   is not a live arrival even when the batch rule cannot see it.
 * - the composite key was seen before — scrolling remounts the row, React may
 *   re-run effects, and a reconnect can redeliver. The host drops `notice.id`,
 *   so the identity available to a renderer is exactly this row: the agent, its
 *   recorded timestamp and the text.
 *
 * Kept as a class (rather than a module-level Set) so the check can create fresh
 * instances and the component owns exactly one for the bundle's lifetime.
 */
export class RewindToastGate {
  private readonly seen = new Set<string>();
  private readonly limit: number;

  /**
   * @param limit - cap on remembered keys. One entry per shown capsule, so a
   *   session that rewinds hundreds of times does not grow the set forever.
   */
  constructor(limit = 200) {
    this.limit = Math.max(1, limit);
  }

  /** Whether this row should raise a capsule now; remembers the ones it allows. */
  shouldToast(input: RewindToastInput): boolean {
    if (!input.fresh) return false;
    const at = timeOf(input.timestamp);
    if (at === undefined) return false;
    if (Math.abs(input.now - at) > REWIND_TOAST_MAX_AGE_MS) return false;
    const key = `${input.agentId}\u0000${String(at)}\u0000${input.message}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.limit) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}

/**
 * The capsule text for a rewind row.
 *
 * A success sentence is already one line; a failure row carries the detail on
 * its following lines and the capsule repeats only the headline, so it stays a
 * toast rather than a paragraph.
 */
export function rewindToastMessage(data: RewindNoticeData): string {
  return rewindNoticeHeadline(data.message);
}
