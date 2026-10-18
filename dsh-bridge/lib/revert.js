/**
 * Translate Paseo's revert token into DSH's surface-replacement range.
 *
 * Paseo's provider contract gives every rewindable timeline row a `revertToken`
 * and hands it back verbatim when the user picks "回退对话和文件" under a
 * message. This module is the whole translation: token -> which DSH user
 * message -> which surface nodes that message and everything after it occupy.
 *
 * Two rules here are not ours to invent:
 *
 * 1. **Which rows are rewind targets.** DSH's visible surface also carries
 *    user-role messages the host injected (Paseo system envelopes, compaction
 *    checkpoints, subagent context). Those are not user turns, so a token must
 *    only resolve against `user/message` events whose `data.source.kind` is
 *    `"user"` — the same predicate `dsh-rewind-plugin` uses.
 * 2. **Ranges come from the visible surface, not the raw log.** A compaction or
 *    an earlier rewind leaves its events on disk while removing them from
 *    `session.surface.nodes`; the only writable replacement range is a pair of
 *    current surface nodes.
 *
 * Pure: a seq list plus an event reader in, a plan out, so the dangerous part
 * (which message a user asked to rewind) can be asserted offline.
 *
 * @module dsh-bridge/revert
 */

/** Event type DSH appends for a user message. */
const USER_MESSAGE = 'user/message';

/**
 * Why the first visible human message is not rewindable.
 *
 * Withdrawing it would empty the conversation, and Paseo's live client does not
 * reliably apply an emptied rebuild (stale rows stay until a reopen). The
 * product rule is therefore a flat refusal; the message stays short because it
 * is shown as a toast.
 */
export const FIRST_MESSAGE_REFUSAL = '首条消息禁止撤回';

/**
 * The DSH message id a token carries.
 *
 * Paseo round-trips the token through JSON untouched, so a string id arrives as
 * a string. Anything else is a bug on our side of the contract and must fail
 * loudly rather than rewind to a guessed row.
 *
 * @param {unknown} token
 * @returns {string | undefined}
 */
export function tokenMessageId(token) {
  if (typeof token !== 'object' || token === null) return undefined;
  const messageId = /** @type {{messageId?: unknown}} */ (token).messageId;
  return typeof messageId === 'string' && messageId !== '' ? messageId : undefined;
}

/**
 * Whether one event is a message the *user* authored.
 *
 * The surface carries injected user-role messages (Paseo system envelopes with
 * `source.kind === "paseo"`, compaction checkpoints, plugin markers). Rewinding
 * to one of those would remove a host notice rather than a user turn, so only
 * `kind === "user"` is an anchor.
 *
 * @param {unknown} event
 * @returns {boolean}
 */
export function isHumanUserMessage(event) {
  const typed = /** @type {{type?: string, data?: {source?: {kind?: string}}}} */ (event);
  return typed?.type === USER_MESSAGE && typed?.data?.source?.kind === 'user';
}

/**
 * Resolve one revert token against the current visible surface.
 *
 * The range is "this message and everything after it", which is exactly what
 * clicking rewind under a message means: the message is withdrawn together with
 * the turns it produced. The replacement's `endSeq` is the surface tail at this
 * moment; it is frozen when the replacement is appended, so a turn still running
 * would append events *after* the range and stay visible — the caller must settle
 * the agent first.
 *
 * @param {readonly number[]} nodes - `session.surface.nodes`, oldest first.
 * @param {(seq: number) => unknown} eventAt - `session.eventAt(seq)`.
 * @param {unknown} token - the `revertToken` Paseo handed back.
 * @returns {{ok: true, messageId: string, targetSeq: number, targetIndex: number, shadowed: number[]}
 *   | {ok: false, reason: string}}
 */
export function planRewind(nodes, eventAt, token) {
  const messageId = tokenMessageId(token);
  if (messageId === undefined) return { ok: false, reason: '撤回令牌无效（缺少消息 id）' };
  const targetIndex = nodes.findIndex((seq) => {
    const event = /** @type {{data?: {id?: unknown}} | undefined} */ (eventAt(seq));
    return isHumanUserMessage(event) && event?.data?.id === messageId;
  });
  if (targetIndex === -1) {
    // The row is still on screen because Paseo cached it, but it is no longer in
    // the visible surface: an earlier rewind or a compaction already removed it.
    return {
      ok: false,
      reason: `这条消息已不在可撤回的对话中（可能已被撤回或压缩）：${messageId}`,
    };
  }
  // The first human message cannot be withdrawn: doing so clears the whole
  // conversation, and Paseo's client does not reliably apply the empty rebuild
  // (it keeps the stale rows on screen until a manual refresh, and clicking one
  // then fails with "No provider revert token"). The rewind menu is offered per
  // provider capability, not per row, so the bridge refuses here with a readable
  // reason instead of emptying the session.
  const firstHumanIndex = nodes.findIndex((seq) => isHumanUserMessage(eventAt(seq)));
  if (targetIndex === firstHumanIndex) return { ok: false, reason: FIRST_MESSAGE_REFUSAL };
  const shadowed = nodes.slice(targetIndex);
  return { ok: true, messageId, targetSeq: nodes[targetIndex], targetIndex, shadowed };
}

/**
 * Normalise the scope Paseo asked for.
 *
 * Only `conversation` and `both` are advertised as provider capabilities. The
 * bridge refuses everything else instead of silently widening a file-only
 * request into a full conversation rewind (the destructive default an earlier
 * draft had).
 *
 * @param {unknown} scope
 * @returns {"conversation" | "both" | undefined}
 */
export function revertScope(scope) {
  if (scope === 'conversation' || scope === 'both') return scope;
  return undefined;
}

/**
 * Whether a scope also restores files.
 *
 * @param {"conversation" | "both"} scope
 * @returns {boolean}
 */
export function restoresFiles(scope) {
  return scope === 'both';
}

/**
 * The success receipt. It names the withdrawn seq so a probe (and a human
 * reading logs) can tell "the bridge really replaced this range" from "the
 * request was accepted and nothing happened".
 *
 * @param {number} targetSeq
 * @returns {string}
 */
export function successText(targetSeq) {
  return `Withdrawn seq ${targetSeq} and everything after it`;
}

