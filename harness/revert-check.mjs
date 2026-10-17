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
  scopeFlag,
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

console.log('anchor rule (mirrors dsh-rewind, byte for byte)');
{
  check('a user message is an anchor', isRewindAnchor(user('u1')) === true);
  check('a Paseo envelope is not', isRewindAnchor(envelope()) === false);
  check('an assistant message is not', isRewindAnchor(assistant()) === false);
  check('a dsh-rewind plugin bubble is', isRewindAnchor(pluginAnchor('原话')) === true);
  check('an empty plugin bubble is not', isRewindAnchor(pluginAnchor('  ')) === false);
  check('the /rewind marker is not', isRewindAnchor(marker('↩ /rewind 已回退')) === false);
  check('the /vault marker is not', isRewindAnchor(marker('🔖 /vault 备份')) === false);
  check('the /unrewind marker is not', isRewindAnchor(marker('🔖 /unrewind 找回')) === false);
  check('another plugin is not', isRewindAnchor({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'other' }, content: [{ type: 'text', text: 'x' }] } }) === false);
  check('undefined is not', isRewindAnchor(undefined) === false);
  check('text is read like dsh-rewind does', anchorText(user('u1')) === 'u1', anchorText(user('u1')));
}

console.log('visible anchors');
{
  const events = { 1: user('u1'), 2: assistant(), 3: envelope(), 4: user('u2'), 5: pluginAnchor('原话') };
  check(
    'user messages and plugin anchors count, envelopes do not',
    JSON.stringify(visibleAnchorSeqs([1, 2, 3, 4, 5], events)) === JSON.stringify([1, 4, 5]),
    JSON.stringify(visibleAnchorSeqs([1, 2, 3, 4, 5], events)),
  );
  check('surface order is preserved', JSON.stringify(visibleAnchorSeqs([5, 1], events)) === JSON.stringify([5, 1]));
  check('a node with no event is skipped', visibleAnchorSeqs([1, 99], events).length === 1);
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
  const newest = revertOrdinal(nodes, events, { messageId: 'u3' });
  check('the newest is 1', newest.ok === true && newest.n === 1, JSON.stringify(newest));
  const middle = revertOrdinal(nodes, events, { messageId: 'u2' });
  check('the middle is 2', middle.ok === true && middle.n === 2, JSON.stringify(middle));
  const oldest = revertOrdinal(nodes, events, { messageId: 'u1' });
  check('the oldest is 3', oldest.ok === true && oldest.n === 3, JSON.stringify(oldest));
  check('the total is reported', oldest.ok === true && oldest.total === 3);
  check('the resolved seq rides along', middle.ok === true && middle.seq === 3, JSON.stringify(middle));
}

console.log('surface awareness (the whole point)');
{
  // A compaction removed 1..5 from the surface; only u4 is still rewindable.
  const events = { 1: user('u1'), 3: user('u2'), 5: user('u3'), 7: user('u4') };
  const nodes = [7];
  const visible = revertOrdinal(nodes, events, { messageId: 'u4' });
  check('a still-visible message counts from the surface only', visible.ok === true && visible.n === 1 && visible.total === 1, JSON.stringify(visible));
  const gone = revertOrdinal(nodes, events, { messageId: 'u2' });
  check('a compacted-away message is refused', gone.ok === false, JSON.stringify(gone));
  check('and the refusal names it', gone.ok === false && gone.reason.includes('u2'), gone.ok === false ? gone.reason : '');
}

console.log('bad tokens fail instead of guessing');
{
  const events = { 1: user('u1') };
  const nodes = [1];
  check('unknown id is refused', revertOrdinal(nodes, events, { messageId: 'nope' }).ok === false);
  check('malformed token is refused', revertOrdinal(nodes, events, { messageId: 1 }).ok === false);
  check('missing token is refused', revertOrdinal(nodes, events, {}).ok === false);
}

console.log('scope mapping');
{
  check('both sends no flag', scopeFlag('both') === '');
  check('conversation sends --conversation', scopeFlag('conversation') === ' --conversation');
  check('files sends --code', scopeFlag('files') === ' --code');
  check('both touches the worktree', restoresFiles('both') === true);
  check('files touches the worktree', restoresFiles('files') === true);
  check('conversation does not', restoresFiles('conversation') === false);
  check('the line composes', rewindLine(2, 'both') === '/rewind 2', rewindLine(2, 'both'));
  check('the line carries the flag', rewindLine(1, 'files') === '/rewind 1 --code', rewindLine(1, 'files'));
  let threw = false;
  try { rewindLine(0, 'both'); } catch { threw = true; }
  check('an invalid ordinal cannot become a line', threw);
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
  for (const capability of ['session.revert.both', 'session.revert.conversation', 'session.revert.files']) {
    check(`provider declares ${capability}`, provider.includes(`"${capability}"`));
  }
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
