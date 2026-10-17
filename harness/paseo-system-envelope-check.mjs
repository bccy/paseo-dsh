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
import { isPaseoSystemEnvelope, promptSource } from '../dsh-bridge/lib/paseo-system-envelope.js';

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const text = (value) => [{ type: 'text', text: value }];

// The shape Paseo actually sends, per `formatSystemNotificationPrompt`.
const envelope = (body) => `<paseo-system>\n${body}\n</paseo-system>`;

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
  promptSource([{ type: 'text', text: '<paseo-system>\nbody' }, { type: 'text', text: '</paseo-system>' }]).kind === 'paseo',
  'blocks are joined before matching',
);

check(
  'isPaseoSystemEnvelope rejects non-strings',
  isPaseoSystemEnvelope(undefined) === false && isPaseoSystemEnvelope(42) === false,
  'defensive for untyped JSON-RPC input',
);

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${result.name}${result.pass ? '' : ` — ${result.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
