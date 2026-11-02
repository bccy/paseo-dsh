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
 * A **live** fallback notice reports the same outcome and therefore carries the
 * same title, so it would match that filter as well. The server marks its
 * description with {@link REWIND_FALLBACK_MARKERS}; a notice carrying the marker
 * is a degraded delivery that must stay visible, not a replayed legacy row.
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
 * Marker lines the server puts on a degraded fallback notice's description.
 *
 * The fallback reports the same outcome as a legacy row, so the copy alone
 * cannot tell them apart; the marker is what keeps a live fallback visible. The
 * canonical strings live in `server/rewind-notice-append` (a server module the
 * client bundle cannot import), and `harness/rewind-notice-check.cjs` asserts
 * the two copies are identical — a drift here would silently hide the failure
 * report again.
 */
export const REWIND_FALLBACK_MARKERS: Readonly<Record<"en" | "zh-CN", string>> = Object.freeze({
  en: "Degraded delivery: the report row could not be written to the timeline; this notice may not persist",
  "zh-CN": "降级送达：报告行未能写入时间线，这条提示可能不会保留",
});

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
 * A notice carrying one of {@link REWIND_FALLBACK_MARKERS} is **not** legacy:
 * it is the live degraded fallback for a report that could not be appended, and
 * removing it would hide a real (if degraded) report. The canary must not match
 * either: it is a different notice with a different job (it warns that the
 * timeline may be stale), and the copy table deliberately does not contain its
 * wording.
 */
export function isLegacyRewindNotice(message: string): boolean {
  if (Object.values(REWIND_FALLBACK_MARKERS).some((marker) => message.includes(marker))) return false;
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
