/**
 * Offline check for the bridge's revert-token translation.
 *
 * Paseo hands back whatever `revertToken` our timeline row carried and expects
 * the provider to rewind to just before that message. Two properties make this
 * dangerous to get wrong, and both are asserted here:
 *
 * 1. **The anchor list must be `dsh-rewind`'s own.** We pass our ordinal to its
 *    `/rewind <n>`, so a list that differs by even one row rewinds to the wrong
 *    message — silently. The rule is mirrored from `isRewindAnchorEvent`.
 * 2. **Counting must happen over DSH's visible surface.** A compaction and an
 *    earlier rewind both leave their events on disk while removing them from
 *    `session.surface.nodes`.
 *
 * Pure-module check: no DSH profile, no daemon, no model.
 *
 * Usage: node harness/revert-check.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  anchorText,
  dirtyWorkspaceError,
  isRewindAnchor,
  restoresFiles,
  revertOrdinal,
  rewindLine,
  rewindMode,
  tokenMessageId,
  visibleAnchorSeqs,
} from '../dsh-bridge/lib/revert.js';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

/** A real user message event. */
const user = (id) => ({ type: 'user/message', data: { id, source: { kind: 'user' }, content: [{ type: 'text', text: id }] } });
/** A Paseo system envelope: a user-role event that is NOT a rewind anchor. */
const envelope = () => ({ type: 'user/message', data: { id: 'env', source: { kind: 'paseo' }, content: [{ type: 'text', text: '⏰' }] } });
/** `dsh-rewind`'s own unrewind anchor (the restored original bubble). */
const pluginAnchor = (text) => ({ type: 'user/message', data: { id: `a-${text}`, source: { kind: 'plugin', plugin: 'dsh-rewind' }, content: [{ type: 'text', text }] } });
/** dsh-rewind's marker line: a user-role event that is explicitly not an anchor. */
const marker = (text) => ({ type: 'user/message', data: { id: `m-${text}`, source: { kind: 'plugin', plugin: 'dsh-rewind' }, content: [{ type: 'text', text }] } });
/** A visible assistant message event. */
const assistant = () => ({ type: 'assistant/message', data: { source: { kind: 'model' } } });

console.log('anchor rule (mirrors dsh-rewind-plugin@0.15.3, byte for byte)');
{
  const user = (id) => ({ type: 'user/message', data: { id, source: { kind: 'user' }, content: [{ type: 'text', text: id }] } });
  check('a user message is an anchor', isRewindAnchor(user('u1')) === true);
  check('a Paseo envelope is not', isRewindAnchor({ type: 'user/message', data: { id: 'env', source: { kind: 'paseo' }, content: [] } }) === false);
  check('a plugin bubble is not (0.15.x dropped them)', isRewindAnchor({ type: 'user/message', data: { id: 'p', source: { kind: 'plugin', plugin: 'dsh-rewind' }, content: [{ type: 'text', text: '原话' }] } }) === false);
  check('an assistant message is not', isRewindAnchor({ type: 'assistant/message', data: {} }) === false);
  check('undefined is not', isRewindAnchor(undefined) === false);
  check('text is still readable', anchorText(user('u1')) === 'u1', anchorText(user('u1')));
}

console.log('visible anchors');
{
  const events = {
    1: { type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [] } },
    2: { type: 'assistant/message', data: {} },
    3: { type: 'user/message', data: { id: 'env', source: { kind: 'paseo' }, content: [] } },
    4: { type: 'user/message', data: { id: 'u2', source: { kind: 'user' }, content: [] } },
    5: { type: 'user/message', data: { id: 'p', source: { kind: 'plugin', plugin: 'dsh-rewind' }, content: [{ type: 'text', text: 'x' }] } },
  };
  check(
    'only source.kind=user messages count',
    JSON.stringify(visibleAnchorSeqs([1, 2, 3, 4, 5], (seq) => events[seq])) === JSON.stringify([1, 4]),
    JSON.stringify(visibleAnchorSeqs([1, 2, 3, 4, 5], (seq) => events[seq])),
  );
  check('surface order is preserved', JSON.stringify(visibleAnchorSeqs([4, 1], (seq) => events[seq])) === JSON.stringify([4, 1]));
  check('a node with no event is skipped', visibleAnchorSeqs([1, 99], (seq) => events[seq]).length === 1);
}

console.log('token validation');
{
  check('a string id is accepted', tokenMessageId({ messageId: 'abc' }) === 'abc');
  check('an empty id is refused', tokenMessageId({ messageId: '' }) === undefined);
  check('a number is refused', tokenMessageId({ messageId: 7 }) === undefined);
  check('null is refused', tokenMessageId(null) === undefined);
  check('a bare string is refused', tokenMessageId('abc') === undefined);
}

console.log('ordinal numbering (1 = newest)');
{
  const events = { 1: user('u1'), 2: assistant(), 3: user('u2'), 4: assistant(), 5: user('u3') };
  const nodes = [1, 2, 3, 4, 5];
  const newest = revertOrdinal(nodes, (seq) => events[seq], { messageId: 'u3' });
  check('the newest is 1', newest.ok === true && newest.n === 1, JSON.stringify(newest));
  const middle = revertOrdinal(nodes, (seq) => events[seq], { messageId: 'u2' });
  check('the middle is 2', middle.ok === true && middle.n === 2, JSON.stringify(middle));
  const oldest = revertOrdinal(nodes, (seq) => events[seq], { messageId: 'u1' });
  check('the oldest is 3', oldest.ok === true && oldest.n === 3, JSON.stringify(oldest));
  check('the total is reported', oldest.ok === true && oldest.total === 3);
  check('the resolved seq rides along', middle.ok === true && middle.seq === 3, JSON.stringify(middle));
}

console.log('surface awareness (the whole point)');
{
  // A compaction removed 1..5 from the surface; only u4 is still rewindable.
  const events = { 1: user('u1'), 3: user('u2'), 5: user('u3'), 7: user('u4') };
  const nodes = [7];
  const visible = revertOrdinal(nodes, (seq) => events[seq], { messageId: 'u4' });
  check('a still-visible message counts from the surface only', visible.ok === true && visible.n === 1 && visible.total === 1, JSON.stringify(visible));
  const gone = revertOrdinal(nodes, (seq) => events[seq], { messageId: 'u2' });
  check('a compacted-away message is refused', gone.ok === false, JSON.stringify(gone));
  check('and the refusal names it', gone.ok === false && gone.reason.includes('u2'), gone.ok === false ? gone.reason : '');
}

console.log('bad tokens fail instead of guessing');
{
  const events = { 1: user('u1') };
  const nodes = [1];
  check('unknown id is refused', revertOrdinal(nodes, (seq) => events[seq], { messageId: 'nope' }).ok === false);
  check('malformed token is refused', revertOrdinal(nodes, (seq) => events[seq], { messageId: 1 }).ok === false);
  check('missing token is refused', revertOrdinal(nodes, (seq) => events[seq], {}).ok === false);
}

console.log('scope mapping (dsh-rewind-plugin@0.15.3: /rewind @<seq> chat|both)');
{
  check('conversation maps to chat', rewindMode('conversation') === 'chat');
  check('both maps to both', rewindMode('both') === 'both');
  check('files has no mode at all', rewindMode('files') === undefined);
  check('both touches the worktree', restoresFiles('both') === true);
  check('files touches the worktree', restoresFiles('files') === true);
  check('conversation does not', restoresFiles('conversation') === false);
  check('the line targets a seq, not an ordinal', rewindLine(42, 'both') === '/rewind @42 both', rewindLine(42, 'both'));
  check('chat rewinds only the conversation', rewindLine(7, 'conversation') === '/rewind @7 chat', rewindLine(7, 'conversation'));
  check('files has no line', rewindLine(7, 'files') === undefined);
  let threw = false;
  try { rewindLine(-1, 'both'); } catch { threw = true; }
  check('an invalid seq cannot become a line', threw);
}

console.log('dirty-worktree refusal');
{
  check('one file is named', dirtyWorkspaceError([' M a.txt']).includes('a.txt'));
  check('the count is stated for many files', dirtyWorkspaceError([' M a', ' M b', ' M c', ' M d']).includes('4 处'));
  check('it says the revert was abandoned', dirtyWorkspaceError([' M a']).includes('放弃撤回'));
  check('it says what to do', dirtyWorkspaceError([' M a']).includes('stash'));
}

console.log('wiring (the pure module is useless if nothing calls it)');
{
  // Wiring assertions read the components' sources: the helper can be perfect
  // while nothing on either end is connected, and that failure looks exactly
  // like "the feature works" until the button is clicked.
  const read = (relative) => readFileSync(join(import.meta.dirname, '..', relative), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  const provider = read('paseo-plugin/server/provider.ts');
  for (const capability of ['session.revert.both', 'session.revert.conversation']) {
    check(`provider declares ${capability}`, provider.includes(`"${capability}"`));
  }
  // The installed plugin has no files-only mode, so advertising this one would
  // put a menu entry in front of a backend that cannot honour it.
  check('provider does NOT declare session.revert.files', provider.includes('"session.revert.files"') === false);
  check(
    'provider dispatches session.revert to the session',
    /case "session\.revert":/.test(provider) && /\.revert\(input\.token,\s*input\.scope\)/.test(provider),
  );

  const session = read('paseo-plugin/server/session.ts');
  check(
    'the live row carries a revert token once the bridge names the message',
    /#emitUserMessage\(prompt\.clientMessageId, label, \{ messageId \}\)/.test(session),
  );
  check(
    'the replayed row carries the same token',
    /revertToken: \{ messageId: data\.id \}/.test(session),
  );
  check(
    'a rewind settles any question card still waiting for an answer',
    /#clearPendingPermissions\("The conversation was rewound past this question/.test(session),
    'pending question cards would outlive the turn that asked them',
  );
  check('both replay sites are wired', (session.match(/revertToken: \{ messageId: data\.id \}/g) ?? []).length === 2);

  const process = read('paseo-plugin/server/dsh-process.ts');
  check('the plugin reaches the bridge', process.includes('"paseo/revert"'));
  check('and forwards the scope', /revert\(token: unknown, scope: "conversation" \| "files" \| "both"\)/.test(process));

  const bridge = read('dsh-bridge/lib/server.js');
  check(
    'the bridge serves paseo/revert',
    /case 'paseo\/revert':/.test(bridge) && /return this\.revert\(params\)/.test(bridge),
  );
  check('and refuses a dirty worktree', /dirtyWorkspaceError\(worktree\.dirty\)/.test(bridge));
  check('and refuses outside a git repository', /不是 git 仓库/.test(bridge));
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
