/**
 * Offline check for the bridge's Paseo system-envelope translation.
 *
 * Paseo wraps host-injected notifications in a `<paseo-system>` envelope and
 * declares the intent in its own `formatSystemNotificationPrompt`: the prompt is
 * "system-injected context — not a user turn". The bridge translates that
 * envelope into `source: { kind: 'paseo' }` (see
 * `dsh-bridge/lib/paseo-system-envelope.js`), so consumers that discriminate on
 * `source.kind` — memory capture, the timeline projection — stop recording and
 * rendering the host's own reminder as user input.
 *
 * `@getpaseo/server@0.12.0` sends two forms
 * (`dist/server/server/agent/agent-messages/index.js`):
 *   - the attribute-free legacy form, still used by schedule fires;
 *   - the versioned form, which names the sender: `agent-message` and
 *     `agent-notification` are other agents talking to this one, while
 *     `user-message` is Paseo quoting a human prompt that itself looked like an
 *     envelope (it must stay a user turn).
 *
 * The translation must stay exact in both directions:
 *   - miss an envelope, and the reminder is captured as a user message again;
 *   - over-match, and a user who quotes the marker loses their own prompt.
 *
 * This is a pure-module check: no DSH profile, no daemon, no model. The rest of
 * the bridge imports profile-only packages, which is why the rule lives in its
 * own dependency-free module.
 *
 * Usage: node harness/paseo-system-envelope-check.mjs
 */
import {
  isPaseoSystemEnvelope,
  parsePaseoSystemEnvelope,
  promptSource,
} from '../dsh-bridge/lib/paseo-system-envelope.js';

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const text = (value) => [{ type: 'text', text: value }];

// The shape Paseo actually sends, per `formatSystemNotificationPrompt`.
const envelope = (body) => `<paseo-system>\n${body}\n</paseo-system>`;

// The versioned shape `formatAgentMessage` emits, attribute order included.
const versioned = ({ kind, agentId, messageId = 'msg-1', title, event, body = '正文' }) =>
  [
    `<paseo-system version="1" kind="${kind}"`,
    agentId === undefined ? '' : ` source-agent-id="${agentId}"`,
    ` message-id="${messageId}"`,
    title === undefined ? '' : ` source-agent-title="${title}"`,
    event === undefined ? '' : ` event="${event}"`,
    `>\n${body}\n</paseo-system>`,
  ].join('');

// ---------------------------------------------------------------------------
// Legacy form — behavior must stay exactly as before the 0.12 fix.
// ---------------------------------------------------------------------------

check(
  'schedule fire → producer kind paseo',
  promptSource(text(envelope('Schedule fired (id=abc). 只回复：收到 1。'))).kind === 'paseo',
  JSON.stringify(promptSource(text(envelope('Schedule fired (id=abc).')))),
);

check(
  'multi-line body stays one envelope',
  promptSource(text(envelope('第一行\n第二行\n\n第三行'))).kind === 'paseo',
  'body spanning newlines',
);

check(
  'empty body is still an envelope',
  isPaseoSystemEnvelope('<paseo-system>\n\n</paseo-system>'),
  'Paseo renders an empty reason as an empty line',
);

check(
  'legacy envelope parses as injected context',
  (() => {
    const parsed = parsePaseoSystemEnvelope(envelope('Schedule fired (id=abc).'));
    return (
      parsed !== null &&
      parsed.form === 'legacy' &&
      parsed.systemInjected === true &&
      parsed.body === 'Schedule fired (id=abc).'
    );
  })(),
  JSON.stringify(parsePaseoSystemEnvelope(envelope('Schedule fired (id=abc).'))),
);

check(
  'authored prompt stays user',
  promptSource(text('帮我看看这个 bug')).kind === 'user',
  JSON.stringify(promptSource(text('帮我看看这个 bug'))),
);

check(
  'a user quoting the marker is still an authored prompt',
  promptSource(text('这个 <paseo-system> 标签是干什么的？')).kind === 'user',
  'marker inside a longer prompt',
);

check(
  'envelope with no leading newline is not an envelope',
  promptSource(text('<paseo-system>body</paseo-system>')).kind === 'user',
  'Paseo always emits the newline; loosening would invent a shape',
);

check(
  'envelope with no trailing newline is not an envelope',
  promptSource(text('<paseo-system>\nbody</paseo-system>')).kind === 'user',
  'closing tag must sit on its own line',
);

check(
  'empty content is a user turn',
  promptSource([]).kind === 'user' && promptSource(undefined).kind === 'user',
  'no blocks, no producer claim',
);

check(
  'non-text blocks alone are a user turn',
  promptSource([{ type: 'image', attachment: 'a' }]).kind === 'user',
  'the envelope is text framing',
);

check(
  'a text envelope next to an image is still a producer notice',
  promptSource([{ type: 'image', attachment: 'a' }, ...text(envelope('notice'))]).kind === 'paseo',
  'only text blocks take part',
);

check(
  'an envelope split across text blocks stays recognized',
  promptSource([{ type: 'text', text: '<paseo-system>\nbody' }, { type: 'text', text: '</paseo-system>' }]).kind ===
    'paseo',
  'blocks are joined before matching',
);

// ---------------------------------------------------------------------------
// Versioned form — the 0.12 defect: attribute-bearing envelopes were `user`.
// ---------------------------------------------------------------------------

check(
  'versioned agent-message → producer kind paseo',
  promptSource(text(versioned({ kind: 'agent-message', agentId: 'agent-7' }))).kind === 'paseo',
  JSON.stringify(promptSource(text(versioned({ kind: 'agent-message', agentId: 'agent-7' })))),
);

check(
  'versioned agent-notification → producer kind paseo',
  promptSource(text(versioned({ kind: 'agent-notification', agentId: 'agent-7', event: 'finished' }))).kind ===
    'paseo',
  JSON.stringify(
    promptSource(text(versioned({ kind: 'agent-notification', agentId: 'agent-7', event: 'finished' }))),
  ),
);

check(
  'versioned user-message stays a user turn',
  promptSource(text(versioned({ kind: 'user-message', body: '帮我看看这个 bug' }))).kind === 'user',
  'Paseo quotes a human prompt that looked like an envelope; the body is still the user text',
);

check(
  'versioned agent-message parses out sender fields',
  (() => {
    const parsed = parsePaseoSystemEnvelope(
      versioned({ kind: 'agent-message', agentId: 'agent-7', messageId: 'msg-42', title: '修 bug', body: '已完成。' }),
    );
    return (
      parsed !== null &&
      parsed.form === 'versioned' &&
      parsed.version === '1' &&
      parsed.kind === 'agent-message' &&
      parsed.messageId === 'msg-42' &&
      parsed.sourceAgentId === 'agent-7' &&
      parsed.sourceAgentTitle === '修 bug' &&
      parsed.event === undefined &&
      parsed.body === '已完成。' &&
      parsed.systemInjected === true
    );
  })(),
  JSON.stringify(
    parsePaseoSystemEnvelope(
      versioned({ kind: 'agent-message', agentId: 'agent-7', messageId: 'msg-42', title: '修 bug', body: '已完成。' }),
    ),
  ),
);

check(
  'versioned agent-notification parses out event',
  (() => {
    const parsed = parsePaseoSystemEnvelope(
      versioned({ kind: 'agent-notification', agentId: 'agent-7', event: 'permission-required' }),
    );
    return (
      parsed !== null &&
      parsed.kind === 'agent-notification' &&
      parsed.event === 'permission-required' &&
      parsed.sourceAgentId === 'agent-7' &&
      parsed.systemInjected === true
    );
  })(),
  JSON.stringify(
    parsePaseoSystemEnvelope(versioned({ kind: 'agent-notification', agentId: 'agent-7', event: 'permission-required' })),
  ),
);

check(
  'versioned user-message parses as authored text',
  (() => {
    const parsed = parsePaseoSystemEnvelope(versioned({ kind: 'user-message', body: '原文' }));
    return (
      parsed !== null &&
      parsed.kind === 'user-message' &&
      parsed.body === '原文' &&
      parsed.systemInjected === false &&
      parsed.sourceAgentId === undefined
    );
  })(),
  JSON.stringify(parsePaseoSystemEnvelope(versioned({ kind: 'user-message', body: '原文' }))),
);

check(
  'versioned attributes are XML-unescaped',
  (() => {
    const parsed = parsePaseoSystemEnvelope(
      versioned({
        kind: 'agent-message',
        agentId: 'agent&amp;7',
        messageId: 'msg&quot;1',
        title: 'A &lt;title&gt;',
        body: 'a &lt; b &amp;&amp; c',
      }),
    );
    return (
      parsed !== null &&
      parsed.sourceAgentId === 'agent&7' &&
      parsed.messageId === 'msg"1' &&
      parsed.sourceAgentTitle === 'A <title>' &&
      parsed.body === 'a < b && c'
    );
  })(),
  JSON.stringify(
    parsePaseoSystemEnvelope(
      versioned({
        kind: 'agent-message',
        agentId: 'agent&amp;7',
        messageId: 'msg&quot;1',
        title: 'A &lt;title&gt;',
        body: 'a &lt; b &amp;&amp; c',
      }),
    ),
  ),
);

check(
  'isPaseoSystemEnvelope accepts both system-injected forms',
  isPaseoSystemEnvelope(envelope('notice')) &&
    isPaseoSystemEnvelope(versioned({ kind: 'agent-message', agentId: 'agent-7' })) &&
    isPaseoSystemEnvelope(versioned({ kind: 'agent-notification', agentId: 'agent-7', event: 'finished' })),
  'legacy and versioned agent messages are both host-injected',
);

check(
  'a quoted user-message wrapper is a Paseo envelope, not system-injected',
  parsePaseoSystemEnvelope(versioned({ kind: 'user-message' })) !== null &&
    isPaseoSystemEnvelope(versioned({ kind: 'user-message' })) === false,
  'a caller gating on the predicate must not skip the user turn the wrapper quotes',
);

check(
  'a versioned envelope split across text blocks stays recognized',
  promptSource([
    { type: 'text', text: '<paseo-system version="1" kind="agent-message" source-agent-id="agent-7"' },
    { type: 'text', text: 'message-id="msg-1">\nbody\n</paseo-system>' },
  ]).kind === 'paseo',
  'blocks are joined before matching',
);

// ---------------------------------------------------------------------------
// Recognition must mirror upstream parsing: what Paseo would not call an
// envelope stays a user turn here too (over-matching loses a real prompt).
// ---------------------------------------------------------------------------

check(
  'a versioned-looking wrapper in a longer prompt stays user',
  promptSource(text(`请解释这行：${versioned({ kind: 'agent-message', agentId: 'agent-7' })}`)).kind === 'user',
  'the whole message must be the envelope',
);

check(
  'a differently named versioned tag is not an envelope',
  promptSource(text('<paseo-notice version="1" kind="agent-message" source-agent-id="a" message-id="m">\nbody\n</paseo-notice>'))
    .kind === 'user',
  'only the paseo-system tag is Paseo',
);

check(
  'a version other than 1 is not an envelope',
  promptSource(
    text('<paseo-system version="2" kind="agent-message" source-agent-id="a" message-id="m">\nbody\n</paseo-system>'),
  ).kind === 'user',
  'upstream parseAgentMessage requires version="1"',
);

check(
  'a versioned envelope without message-id is not an envelope',
  promptSource(text('<paseo-system version="1" kind="agent-message" source-agent-id="a">\nbody\n</paseo-system>')).kind ===
    'user',
  'upstream returns null without a message id',
);

check(
  'a versioned agent message without sender id is not an envelope',
  promptSource(text('<paseo-system version="1" kind="agent-message" message-id="m">\nbody\n</paseo-system>')).kind ===
    'user',
  'sourceSchema requires a non-empty agentId',
);

check(
  'a versioned notification with an unknown event is not an envelope',
  promptSource(
    text('<paseo-system version="1" kind="agent-notification" source-agent-id="a" message-id="m" event="bogus">\nbody\n</paseo-system>'),
  ).kind === 'user',
  'sourceSchema accepts a fixed event enum',
);

check(
  'a versioned envelope with an unknown kind is not an envelope',
  promptSource(text('<paseo-system version="1" kind="mystery" source-agent-id="a" message-id="m">\nbody\n</paseo-system>'))
    .kind === 'user',
  'only the three kinds Paseo emits are recognized',
);

check(
  'a versioned envelope with a duplicate attribute is not an envelope',
  promptSource(
    text('<paseo-system version="1" version="1" kind="agent-message" source-agent-id="a" message-id="m">\nbody\n</paseo-system>'),
  ).kind === 'user',
  'duplicate attributes are ambiguous provenance',
);

check(
  'a versioned envelope with raw markup in the body is not an envelope',
  promptSource(text('<paseo-system version="1" kind="agent-message" source-agent-id="a" message-id="m">\n<b>hi</b>\n</paseo-system>'))
    .kind === 'user',
  'upstream unescapeXml rejects raw markup',
);

check(
  'a versioned user-message carrying a sender id is not an envelope',
  promptSource(
    text('<paseo-system version="1" kind="user-message" source-agent-id="a" message-id="m">\nbody\n</paseo-system>'),
  ).kind === 'user',
  'upstream rejects a user-message that claims a sender',
);

check(
  'isPaseoSystemEnvelope rejects non-strings',
  isPaseoSystemEnvelope(undefined) === false &&
    isPaseoSystemEnvelope(42) === false &&
    parsePaseoSystemEnvelope(undefined) === null,
  'defensive for untyped JSON-RPC input',
);

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${result.name}${result.pass ? '' : ` — ${result.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
