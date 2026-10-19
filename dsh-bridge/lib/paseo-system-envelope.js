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
 * ## Two envelope forms reach this bridge
 *
 * Both come from `@getpaseo/server@0.12.0`
 * (`dist/server/server/agent/agent-messages/index.js`):
 *
 * - **Legacy, attribute-free** — `<paseo-system>\n…\n</paseo-system>`
 *   (`formatSystemNotificationPrompt`). Schedule fires still use this form, and
 *   0.11 history still contains it. Host-injected → `paseo`.
 * - **Versioned** — `<paseo-system version="1" kind="…" message-id="…" …>`
 *   (`formatAgentMessage`), which names the sender:
 *   - `kind="agent-message"` / `kind="agent-notification"` — another agent
 *     talking to this one (chat mention, notify-on-finish). Host-injected
 *     context, not a user turn → `paseo`. These are the messages 0.12 started
 *     sending, and the attribute-free pattern above silently missed them.
 *   - `kind="user-message"` — Paseo *quoting* a human prompt that itself looked
 *     like an envelope (`prepareAgentMessage` re-wraps it so the provenance
 *     survives provider history). The body is still the user's own text →
 *     `user`. Claiming `paseo` here would drop a real user turn from memory
 *     capture and from the rewind anchors.
 *
 * ## Why recognition mirrors upstream parsing instead of "tag has attributes"
 *
 * Paseo's own projection (`projectAgentMessage`) treats a versioned wrapper it
 * cannot parse — wrong `version`, missing `message-id`, unknown `kind`, a body
 * that still contains raw markup — as an ordinary user message, and only a
 * well-formed one becomes system-injected context. Mirroring that rule keeps
 * both sides agreeing on the same prompt: a user who types something that
 * merely resembles an envelope stays an authored turn, while anything the
 * daemon's own generator emits is recognized. The attribute parser, the
 * `version === "1"` gate, the XML unescaping and the per-kind validation below
 * are a dependency-free port of `parseAgentMessage` from that same 0.12 file.
 *
 * Pure module on purpose: the rest of the bridge imports profile-only packages,
 * and this rule needs to be checkable offline (`harness/paseo-system-envelope-check.mjs`).
 */

/**
 * The attribute-free envelope, exactly as Paseo's own `SYSTEM_ENVELOPE_PATTERN`
 * declares it: the whole message, an opening tag, one newline, the body, one
 * newline, and a closing tag. Mirrored rather than loosened — a user who merely
 * mentions the marker inside a longer prompt is still an authored turn.
 */
export const PASEO_SYSTEM_ENVELOPE = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

/**
 * The versioned envelope, exactly as Paseo's `parseAgentMessage` matches it: at
 * least one `name="value"` attribute, then the same newline framing. Kept as a
 * separate pattern so the legacy predicate above stays byte-for-byte upstream's.
 */
export const PASEO_VERSIONED_ENVELOPE = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n([\s\S]*)\n<\/paseo-system>$/;

/** The fixed delimiters of the legacy envelope, for slicing its body out. */
const LEGACY_OPEN = '<paseo-system>\n';
const LEGACY_CLOSE = '\n</paseo-system>';

/** `event` values Paseo's `agent-notification` source schema accepts. */
const AGENT_NOTIFICATION_EVENTS = new Set(['finished', 'errored', 'permission-required', 'closed']);

/**
 * Paseo's XML unescaping, ported: a value that still contains raw markup, or an
 * entity outside the five Paseo escapes, is not one of Paseo's envelopes.
 *
 * @param {string} value
 * @returns {string | null}
 */
function unescapeXml(value) {
  if (/[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return null;
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      default:
        return "'";
    }
  });
}

/**
 * The `source` Paseo's versioned envelope names, validated the way its own
 * `sourceSchema` does: a non-empty agent id always, an accepted `event` for a
 * notification, and a title that is non-empty when present.
 *
 * @param {Map<string, string>} attributes
 * @returns {{kind: string, agentId: string, event?: string, title?: string} | null}
 */
function agentMessageSource(attributes) {
  const kind = attributes.get('kind');
  const agentId = attributes.get('source-agent-id');
  const title = attributes.get('source-agent-title');
  const event = attributes.get('event');
  if (typeof agentId !== 'string' || agentId === '') return null;
  if (title === '') return null; // `z.string().min(1).optional()` rejects an empty title
  const named = title === undefined ? {} : { title };
  if (kind === 'agent-message') return { kind, agentId, ...named };
  if (kind !== 'agent-notification') return null;
  if (!AGENT_NOTIFICATION_EVENTS.has(event)) return null;
  return { kind, agentId, event, ...named };
}

/**
 * Recognize and decode one Paseo system envelope.
 *
 * Returns `null` for anything Paseo would not call an envelope — including a
 * versioned wrapper Paseo's own parser rejects, which both sides must keep
 * treating as ordinary user text.
 *
 * @param {unknown} text
 * @returns {{
 *   form: 'legacy' | 'versioned',
 *   body: string,
 *   systemInjected: boolean,
 *   version?: string,
 *   kind?: string,
 *   messageId?: string,
 *   sourceAgentId?: string,
 *   sourceAgentTitle?: string,
 *   event?: string,
 * } | null}
 */
export function parsePaseoSystemEnvelope(text) {
  if (typeof text !== 'string') return null;

  const versioned = PASEO_VERSIONED_ENVELOPE.exec(text);
  if (versioned !== null) {
    const attributes = new Map();
    for (const match of versioned[1].matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
      const value = unescapeXml(match[2]);
      // A duplicate attribute is ambiguous provenance, not a last-write-wins.
      if (value === null || attributes.has(match[1])) return null;
      attributes.set(match[1], value);
    }
    if (attributes.get('version') !== '1') return null;
    const messageId = attributes.get('message-id');
    const body = unescapeXml(versioned[2]);
    if (messageId === undefined || messageId === '' || body === null) return null;
    if (attributes.get('kind') === 'user-message') {
      if (attributes.has('source-agent-id') || attributes.has('event')) return null;
      return { form: 'versioned', version: '1', kind: 'user-message', messageId, body, systemInjected: false };
    }
    const source = agentMessageSource(attributes);
    if (source === null) return null;
    return {
      form: 'versioned',
      version: '1',
      kind: source.kind,
      messageId,
      body,
      systemInjected: true,
      sourceAgentId: source.agentId,
      ...(source.title === undefined ? {} : { sourceAgentTitle: source.title }),
      ...(source.event === undefined ? {} : { event: source.event }),
    };
  }

  if (PASEO_SYSTEM_ENVELOPE.test(text)) {
    return {
      form: 'legacy',
      body: text.slice(LEGACY_OPEN.length, text.length - LEGACY_CLOSE.length),
      systemInjected: true,
    };
  }
  return null;
}

/**
 * Whether `text` is exactly one Paseo envelope that declares system-injected
 * context, in either form.
 *
 * A versioned `kind="user-message"` wrapper is a Paseo envelope too — the
 * decoder reports it — but it quotes the user's own text, so it is not one of
 * these; answering `true` for it would let a caller that gates on this
 * predicate skip a real user turn.
 */
export function isPaseoSystemEnvelope(text) {
  const parsed = parsePaseoSystemEnvelope(text);
  return parsed !== null && parsed.systemInjected;
}

/**
 * The `source` for one prompt: the producer kind Paseo claimed when it wrapped
 * the body, or `user` for anything the user authored.
 *
 * Only text blocks take part — the envelope is Paseo's text framing, and a
 * prompt carrying an image is a user turn by construction. Blocks span the
 * envelope only if Paseo ever splits it, so joining first keeps that case
 * recognized instead of silently downgrading it.
 *
 * Every host-injected envelope claims the one `paseo` kind. The parsed
 * attributes (sender id, message id, event) are available through
 * {@link parsePaseoSystemEnvelope} for any consumer that needs to tell an agent
 * message from a schedule fire, but they do not become separate source kinds:
 * DSH's source sum type is merge-extensible, yet the consumers that matter
 * (memory capture, the session replay, the rewind anchors) only discriminate
 * `user` from everything else, so a new kind would be an invented shape with no
 * reader. The message body rides through untouched — Paseo wrapped it so the
 * receiving agent sees the framing, and unwrapping it here would lose exactly
 * the provenance the envelope exists to carry.
 */
export function promptSource(content) {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  const envelope = parsePaseoSystemEnvelope(text);
  return envelope !== null && envelope.systemInjected ? { kind: 'paseo' } : { kind: 'user' };
}
