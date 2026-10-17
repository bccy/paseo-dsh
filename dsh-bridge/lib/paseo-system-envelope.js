/**
 * Paseo's host-injected notifications, translated into a DSH message source.
 *
 * Paseo wraps everything it says on its own behalf — a schedule fire, a chat
 * mention, a notify-on-finish notice — in a `<paseo-system>` envelope and
 * documents the intent in `formatSystemNotificationPrompt`: the receiving agent
 * must recognize the prompt as *system-injected context, not a user turn*
 * (`isSystemInjectedEnvelope` is Paseo's own predicate, and its server consults
 * it when building agent state).
 *
 * The bridge is the last hop that can honor that declaration. DSH's vocabulary
 * carries a `source.kind` on every user-role message, and every consumer
 * discriminates on it: memory capture skips non-`user` kinds outright, and the
 * timeline projection reports them as injected context instead of a user
 * bubble. Passing the envelope through as `{ kind: 'user' }` therefore records
 * the host talking to itself as if the user had typed it, and renders the
 * host's own reminder as a user message.
 *
 * DSH's scheduler declares its reminders the same way
 * (`source: { kind: "schedule" }`), so `paseo` is the producer kind this bridge
 * claims for the host's notices.
 *
 * Pure module on purpose: the rest of the bridge imports profile-only packages,
 * and this rule needs to be checkable offline (`harness/paseo-system-envelope-check.mjs`).
 */

/**
 * Paseo's envelope, exactly as its own `SYSTEM_ENVELOPE_PATTERN` declares it:
 * the whole message, an opening tag, one newline, the body, one newline, and a
 * closing tag. Mirrored rather than loosened — a user who merely mentions the
 * marker inside a longer prompt is still an authored turn.
 */
export const PASEO_SYSTEM_ENVELOPE = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

/** Whether `text` is exactly one Paseo system envelope. */
export function isPaseoSystemEnvelope(text) {
  return typeof text === 'string' && PASEO_SYSTEM_ENVELOPE.test(text);
}

/**
 * The `source` for one prompt: the producer kind Paseo claimed when it wrapped
 * the body, or `user` for anything the user authored.
 *
 * Only text blocks take part — the envelope is Paseo's text framing, and a
 * prompt carrying an image is a user turn by construction. Blocks span the
 * envelope only if Paseo ever splits it, so joining first keeps that case
 * recognized instead of silently downgrading it.
 */
export function promptSource(content) {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  return isPaseoSystemEnvelope(text) ? { kind: 'paseo' } : { kind: 'user' };
}
