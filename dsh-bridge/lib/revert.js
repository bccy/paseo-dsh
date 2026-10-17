/**
 * Map Paseo's revert token onto the `dsh-rewind` command line.
 *
 * Paseo's provider contract gives every rewindable timeline row a `revertToken`
 * and hands it back verbatim when the user picks "回退对话和文件" under a
 * message. This module is the whole translation: token -> which message ->
 * `dsh-rewind`'s `/rewind <n>` (1 = the latest rewindable message), plus the
 * scope flags and the refusal text for a worktree that cannot be restored.
 *
 * Two rules here are not ours to invent:
 *
 * 1. **Which messages are rewindable.** `dsh-rewind` numbers `/rewind <n>` over
 *    its own anchor list, so our count must be byte-for-byte the same list or
 *    the ordinal points at a different message — silently, which is the worst
 *    possible failure for an operation that destroys history. The rule is copied
 *    from `isRewindAnchorEvent`: every `source.kind === 'user'` message, plus
 *    `dsh-rewind`'s own non-empty plugin anchors (the bubbles `/unrewind`
 *    appends), minus its marker lines.
 * 2. **Counting happens over the visible surface.** `session.surface.nodes`, not
 *    `session.events`: a compaction and an earlier rewind both leave their events
 *    on disk while removing them from the surface.
 *
 * @module dsh-bridge/revert
 */

/** Event type DSH appends for a user message. */
const USER_MESSAGE = 'user/message';

/** The plugin whose anchors `dsh-rewind` counts alongside real user messages. */
const PLUGIN = 'dsh-rewind';

/** Marker lines `dsh-rewind` writes that are never rewind anchors. */
const MARKERS = ['↩ /rewind', '🔖 /vault', '🔖 /unrewind'];

/**
 * Plain text of a message event, the way `dsh-rewind` reads it.
 *
 * @param {{data?: {content?: unknown}} | undefined} event
 * @returns {string}
 */
export function anchorText(event) {
  const content = event?.data?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join(' ')
    .trim();
}

/**
 * Whether one surface event is a rewind anchor by `dsh-rewind`'s own rule.
 *
 * @param {{type?: string, data?: {source?: {kind?: string, plugin?: string}}} | undefined} event
 * @returns {boolean}
 */
export function isRewindAnchor(event) {
  if (event === undefined || event.type !== USER_MESSAGE) return false;
  const source = event.data?.source;
  if (source?.kind === 'user') return true;
  const text = anchorText(event);
  if (MARKERS.some((marker) => text.startsWith(marker))) return false;
  return source?.kind === 'plugin' && source.plugin === PLUGIN && text !== '';
}

/**
 * The rewindable seqs on the visible surface, oldest first.
 *
 * @param {readonly number[]} nodes - `session.surface.nodes`.
 * @param {Record<number, unknown>} events - `session.events`.
 * @returns {number[]}
 */
export function visibleAnchorSeqs(nodes, events) {
  const seqs = [];
  for (const seq of nodes) {
    if (isRewindAnchor(/** @type {{type?: string}} */ (events[seq]))) seqs.push(seq);
  }
  return seqs;
}

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
 * Translate a revert token into `dsh-rewind`'s ordinal.
 *
 * @param {readonly number[]} nodes - `session.surface.nodes`.
 * @param {Record<number, unknown>} events - `session.events`.
 * @param {unknown} token - the `revertToken` Paseo handed back.
 * @returns {{ok: true, n: number, total: number, seq: number} | {ok: false, reason: string}}
 */
export function revertOrdinal(nodes, events, token) {
  const messageId = tokenMessageId(token);
  if (messageId === undefined) return { ok: false, reason: 'revert token carries no message id' };
  const seqs = visibleAnchorSeqs(nodes, events);
  const index = seqs.findIndex((seq) => {
    const data = /** @type {{data?: {id?: unknown}}} */ (events[seq])?.data;
    return data?.id === messageId;
  });
  if (index === -1) {
    // The row is still on screen because Paseo cached it, but it is no longer in
    // the visible surface: an earlier rewind or a compaction already removed it.
    return { ok: false, reason: `message ${messageId} is not in the visible conversation` };
  }
  return { ok: true, n: seqs.length - index, total: seqs.length, seq: seqs[index] };
}

/**
 * Scope flags accepted by `dsh-rewind`'s `/rewind` (default is both).
 *
 * @param {'conversation' | 'files' | 'both'} scope
 * @returns {string} `''`, `' --conversation'`, or `' --code'`.
 */
export function scopeFlag(scope) {
  if (scope === 'conversation') return ' --conversation';
  if (scope === 'files') return ' --code';
  return '';
}

/**
 * The complete slash-command line to execute for one revert.
 *
 * @param {number} n - ordinal from {@link revertOrdinal}.
 * @param {'conversation' | 'files' | 'both'} scope
 * @returns {string}
 */
export function rewindLine(n, scope) {
  if (!Number.isInteger(n) || n < 1) throw new TypeError(`invalid rewind ordinal: ${String(n)}`);
  return `/rewind ${n}${scopeFlag(scope)}`;
}

/**
 * Whether this scope touches the worktree (and therefore needs a clean one).
 *
 * @param {'conversation' | 'files' | 'both'} scope
 * @returns {boolean}
 */
export function restoresFiles(scope) {
  return scope === 'files' || scope === 'both';
}

/**
 * Refusal text for a worktree whose files cannot be restored.
 *
 * The decision was to abandon the whole revert rather than leave the
 * conversation ahead of the files, so this is an explanation, not a warning that
 * is then worked around.
 *
 * @param {readonly string[]} entries - `git status --porcelain` lines.
 * @returns {string}
 */
export function dirtyWorkspaceError(entries) {
  const count = entries.length;
  const sample = entries.slice(0, 3).map((line) => line.trim()).join('、');
  const more = count > 3 ? ` 等 ${count} 处` : '';
  return `工作区有未提交改动（${sample}${more}），已放弃撤回：请先提交或 stash，再重试。`;
}
