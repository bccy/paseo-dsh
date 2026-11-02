/**
 * The client half's contract for the rewind report row.
 *
 * The server appends a **plugin** timeline row (`paseo.agents.ref(id).timeline
 * .append`) instead of a `session.notice`: a notice sent from the rewind branch
 * is dropped while the host holds the rewind's run lock, which is why the row
 * used to be delivered behind a guessed delay and could vanish. The plugin row
 * carries its copy and a `noticeId`, and the client draws it with the renderer
 * registered under {@link REWIND_NOTICE_KIND}.
 *
 * This module also owns the **legacy** half: notices the old implementation
 * wrote into the provider history (a `session.notice` per rewind) are replayed
 * by every conversation rebuild. They are recognised here from the same copy
 * table the server emits and removed by the transformer — see
 * `isLegacyRewindNotice`.
 *
 * Kept free of React and of the host runtime: the offline check compiles it to
 * CommonJS and drives it directly.
 *
 * @module dsh-paseo/client/rewind-notice-data
 */
import {
  rewindNoticeHeadline,
  rewindNoticeTone,
  rewindNoticePayloadSchema,
  type RewindNoticePayload,
} from "../shared/rewind-notice";

export {
  REWIND_NOTICE_ITEM_ID,
  REWIND_NOTICE_KIND,
  REWIND_NOTICE_VERSION,
  rewindNoticePayloadSchema,
} from "../shared/rewind-notice";

/** Data one appended rewind row carries (the shared payload shape). */
export type RewindNoticeData = RewindNoticePayload;

/** Runtime schema for {@link RewindNoticeData}. */
export const rewindNoticeSchema = rewindNoticePayloadSchema;

/**
 * Whether a host `notification` item is a rewind report from the **old**
 * delivery path.
 *
 * The current implementation never emits one: a report is a plugin row. But
 * notices written into the provider history by the previous 300 ms-delay
 * implementation are rebuilt into the timeline by every conversation rewind
 * (the host replays the provider's whole history), and they used to stack up
 * there. Recognising them from the copy table — the same table the server
 * builds the text from — lets the transformer remove them, so a session that
 * predates this change stops showing stale "rewound" lines.
 *
 * The rewind **canary** must not match: it is a different notice with a
 * different job (it warns that the timeline may be stale), and the copy table
 * deliberately does not contain its wording.
 */
export function isLegacyRewindNotice(message: string): boolean {
  return rewindNoticeTone(message) !== undefined;
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
