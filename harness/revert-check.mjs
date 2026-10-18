/**
 * Offline check for the bridge's revert planning and its wiring.
 *
 * Paseo hands back whatever `revertToken` our timeline row carried and expects
 * the provider to rewind to just before that message. The dangerous decisions
 * live in `dsh-bridge/lib/revert.js` as pure functions, so they are asserted
 * here without a DSH profile:
 *
 * 1. **Which rows are rewind targets.** Only `user/message` with
 *    `data.source.kind === "user"` — injected user-role messages (Paseo
 *    envelopes, compaction checkpoints, plugin markers) must never resolve.
 * 2. **Ranges come from the visible surface.** `session.surface.nodes`, not the
 *    raw event log, so a compacted or already-rewound message is refused.
 *
 * The second half of this file asserts the wiring by reading sources: a perfect
 * helper that nothing calls looks exactly like a working feature until the
 * button is pressed, and the offline layer cannot see the DSH session itself.
 *
 * Usage: node harness/revert-check.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIRST_MESSAGE_REFUSAL,
  isHumanUserMessage,
  planRewind,
  restoresFiles,
  revertScope,
  successText,
  tokenMessageId,
} from '../dsh-bridge/lib/revert.js';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

/** A real user message event. */
const user = (id) => ({ type: 'user/message', data: { id, source: { kind: 'user' }, content: [{ type: 'text', text: id }] } });
/** A Paseo system envelope: a user-role event that is NOT a rewind target. */
const envelope = () => ({ type: 'user/message', data: { id: 'env', source: { kind: 'paseo' }, content: [{ type: 'text', text: '⏰' }] } });
/** A compaction checkpoint: a user-role event that replaced history. */
const checkpoint = () => ({ type: 'user/message', data: { id: 'cp', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'summary' }] } });
/** A visible assistant message event. */
const assistant = (id = 'a') => ({ type: 'assistant/message', data: { id, source: { kind: 'model' } } });
/** The replacement event this bridge appends: an empty system message. */
const rewindMarker = () => ({ type: 'system/message', data: { message: { id: 'mark', role: 'system', content: [], source: { kind: 'system-prompt' } } } });

console.log('human user message predicate');
{
  check('a user message is a target', isHumanUserMessage(user('u1')) === true);
  check('a Paseo envelope is not', isHumanUserMessage(envelope()) === false);
  check('a compaction checkpoint is not', isHumanUserMessage(checkpoint()) === false);
  check('an assistant message is not', isHumanUserMessage(assistant()) === false);
  check('the bridge marker is not', isHumanUserMessage(rewindMarker()) === false);
  check('undefined is not', isHumanUserMessage(undefined) === false);
}

console.log('token validation');
{
  check('a string id is accepted', tokenMessageId({ messageId: 'abc' }) === 'abc');
  check('an empty id is refused', tokenMessageId({ messageId: '' }) === undefined);
  check('a number is refused', tokenMessageId({ messageId: 7 }) === undefined);
  check('null is refused', tokenMessageId(null) === undefined);
  check('a bare string is refused', tokenMessageId('abc') === undefined);
}

console.log('range planning (target and everything after it)');
{
  const events = { 1: user('u1'), 2: assistant(), 3: user('u2'), 4: assistant(), 5: user('u3') };
  const nodes = [1, 2, 3, 4, 5];
  const newest = planRewind(nodes, (seq) => events[seq], { messageId: 'u3' });
  check('the newest target resolves', newest.ok === true);
  check('and its range starts at the target itself', newest.ok === true && newest.targetSeq === 5, newest.ok === true ? String(newest.targetSeq) : newest.reason);
  check('and covers everything after it', newest.ok === true && JSON.stringify(newest.shadowed) === JSON.stringify([5]), newest.ok === true ? JSON.stringify(newest.shadowed) : newest.reason);
  const oldest = planRewind(nodes, (seq) => events[seq], { messageId: 'u1' });
  check(
    'the first human message is refused (rewinding it would empty the conversation)',
    oldest.ok === false && oldest.reason === FIRST_MESSAGE_REFUSAL,
    oldest.ok === false ? oldest.reason : 'resolved',
  );
  const middle = planRewind(nodes, (seq) => events[seq], { messageId: 'u2' });
  check('a middle target shadows itself and the tail', middle.ok === true && JSON.stringify(middle.shadowed) === JSON.stringify([3, 4, 5]), JSON.stringify(middle));
}

console.log('the first message refusal is about position, not token shape');
{
  const nodes = [0, 1, 3, 5];
  const events = {
    0: { type: 'system/message', data: { message: { content: [] } } },
    1: { type: 'user/message', data: { source: { kind: 'user' }, id: 'u1' } },
    3: { type: 'assistant/message', data: { message: { content: [] } } },
    5: { type: 'user/message', data: { source: { kind: 'user' }, id: 'u2' } },
  };
  const first = planRewind(nodes, (seq) => events[seq], { messageId: 'u1' });
  check('the first human message is refused', first.ok === false && first.reason === FIRST_MESSAGE_REFUSAL);
  check(
    'the refusal is the short toast text',
    FIRST_MESSAGE_REFUSAL === '首条消息禁止撤回',
    FIRST_MESSAGE_REFUSAL,
  );
  const second = planRewind(nodes, (seq) => events[seq], { messageId: 'u2' });
  check('the second message is still rewindable', second.ok === true && JSON.stringify(second.shadowed) === JSON.stringify([5]), JSON.stringify(second));
}

console.log('injected user-role messages are never targets');
{
  const events = { 1: user('u1'), 2: envelope(), 3: checkpoint(), 4: assistant() };
  const nodes = [1, 2, 3, 4];
  check('a Paseo envelope is refused', planRewind(nodes, (seq) => events[seq], { messageId: 'env' }).ok === false);
  check('a compaction checkpoint is refused', planRewind(nodes, (seq) => events[seq], { messageId: 'cp' }).ok === false);
}

console.log('surface awareness (the whole point)');
{
  // A compaction removed 1..3 from the surface; u4 is now the *first* visible
  // human message, and rewinding it would empty the visible conversation.
  const events = { 1: user('u1'), 3: user('u2'), 5: user('u3'), 7: user('u4') };
  const nodes = [7];
  const visibleFirst = planRewind(nodes, (seq) => events[seq], { messageId: 'u4' });
  check(
    'the first visible message after a compaction is still refused',
    visibleFirst.ok === false && visibleFirst.reason === FIRST_MESSAGE_REFUSAL,
    visibleFirst.ok === false ? visibleFirst.reason : 'resolved',
  );
  const gone = planRewind(nodes, (seq) => events[seq], { messageId: 'u2' });
  check('a compacted-away message is refused', gone.ok === false);
  check('and the refusal names it', gone.ok === false && gone.reason.includes('u2'), gone.ok === false ? gone.reason : '');
}

console.log('bad tokens fail instead of guessing');
{
  const events = { 1: user('u1') };
  const nodes = [1];
  check('unknown id is refused', planRewind(nodes, (seq) => events[seq], { messageId: 'nope' }).ok === false);
  check('malformed token is refused', planRewind(nodes, (seq) => events[seq], { messageId: 1 }).ok === false);
  check('missing token is refused', planRewind(nodes, (seq) => events[seq], {}).ok === false);
  check('undefined token is refused', planRewind(nodes, (seq) => events[seq], undefined).ok === false);
}

console.log('scope handling (only the advertised scopes)');
{
  check('conversation is accepted', revertScope('conversation') === 'conversation');
  check('both is accepted', revertScope('both') === 'both');
  check('files is refused (never advertised)', revertScope('files') === undefined);
  check('an unknown scope is refused', revertScope('everything') === undefined);
  check('both restores files', restoresFiles('both') === true);
  check('conversation does not', restoresFiles('conversation') === false);
}

console.log('replacement marker shape (durable v4 log constraints)');
{
  const bridge = readFileSync(join(import.meta.dirname, '..', 'dsh-bridge/lib/server.js'), 'utf8');
  const surfaceModule = readFileSync(join(import.meta.dirname, '..', 'dsh-bridge/lib/surface.js'), 'utf8');
  check(
    'the marker is a user/message (system messages require an open turn in v4)',
    /createUserMessage\(\{\s*content: \[\{ type: 'text', text: '\(empty message\)' \}\],\s*source: \{ kind: 'paseo-rewind' \},\s*\}\)/.test(bridge),
  );
  check(
    'and it is appended as user/message with the replacement intent',
    /session\.append\(\s*'user\/message',\s*marker,\s*\{\s*surfaceOp: \{ op: 'replace'/.test(bridge),
  );
  check(
    'the replay fold identifies the marker by its durable source kind',
    /REWIND_MARKER_SOURCE_KIND = 'paseo-rewind'/.test(surfaceModule) && /isRewindMarker\(event\)/.test(surfaceModule),
  );
  check('no system-message marker is left in the bridge', /createSystemMessage\(''\)/.test(bridge) === false);
}

console.log('replay timestamps (per-turn "worked for" durations survive a reopen)');
{
  const session = readFileSync(join(import.meta.dirname, '..', 'paseo-plugin/server/session.ts'), 'utf8');
  check(
    'a replayed row gets the stored DSH event time as its provider timestamp',
    /function replayTimestamp\(event: \{ time\?: unknown \}\)/.test(session)
      && /new Date\(event\.time\)\.toISOString\(\)/.test(session),
  );
  check(
    'both replay paths pass it on every item (user row and builder rows)',
    (session.match(/\.\.\.\(timestamp === undefined \? \{\} : \{ timestamp \}\)/g) ?? []).length >= 2
      && (session.match(/\.\.\.\(itemTimestamp === undefined \? \{\} : \{ timestamp: itemTimestamp \}\)/g) ?? []).length >= 2,
  );
  check(
    'the synthesized settling rows fall back to the last stored time',
    (session.match(/lastTimestamp === undefined \? \{\} : \{ timestamp: lastTimestamp \}/g) ?? []).length >= 2,
  );
}

console.log('a successful rewind shows a transient "working" notice');
{
  const provider = readFileSync(join(import.meta.dirname, '..', 'paseo-plugin/server/provider.ts'), 'utf8');
  const caseStart = provider.indexOf('case "session.revert"');
  const noticeIndex = provider.indexOf('"正在回退，请稍候"', caseStart);
  const completedIndex = provider.indexOf('request.completed', caseStart);
  const refreshIndex = provider.indexOf('this.#refreshAgent(input.sessionId)', caseStart);
  check(
    'the notice is emitted after the revert succeeded and before the reload',
    caseStart !== -1 && completedIndex !== -1 && noticeIndex !== -1 && refreshIndex !== -1
      && completedIndex < noticeIndex && noticeIndex < refreshIndex,
  );
  check(
    'and it is an info notice with the short working text',
    /this\.#notice\(input\.sessionId, "info", "正在回退，请稍候"\)/.test(provider),
  );
}

console.log('post-reload notices and the rewind prompt gate');
{
  const provider = readFileSync(join(import.meta.dirname, '..', 'paseo-plugin/server/provider.ts'), 'utf8');
  check(
    'the provider keeps a provider-session -> DSH-session key after the session closes',
    /readonly #dshIds = new Map<string, string>\("\)?;?/.test(provider.replace(/\s+/g, ' ')) || /#dshIds = new Map<string, string>/.test(provider),
  );
  check(
    'a file restore failure is deferred until the reopened session (not lost in the old epoch)',
    /this\.#deferNotice\(input\.sessionId, \{\s*severity: "error",\s*title: "文件回退未完成"/.test(provider),
  );
  check(
    'deferred notices are flushed right after session.ready of the reopened session',
    provider.indexOf('this.#flushDeferredNotices(sessionId, dshSessionId);') > provider.indexOf('type: "session.ready"'),
  );
  check(
    'a prompt arriving during the rewind is refused with a readable reason',
    /if \(this\.#reverting\.has\(input\.sessionId\)\)/.test(provider)
      && /正在回退，请稍候/.test(provider),
  );
  check(
    'the rewind flag is released on a refused rewind, on close, and on every refresh failure',
    (provider.match(/this\.#reverting\.delete\(input\.sessionId\)|this\.#reverting\.delete\(sessionId\)/g) ?? []).length >= 5,
  );
  const bridge = readFileSync(join(import.meta.dirname, '..', 'dsh-bridge/lib/server.js'), 'utf8');
  check(
    'a history read failure is reported as unavailable, not as an empty conversation',
    /history read failed for \$\{params\.sessionId\}[\s\S]{0,400}?return unavailableHistory\(error\)/.test(bridge),
  );
  const session = readFileSync(join(import.meta.dirname, '..', 'paseo-plugin/server/session.ts'), 'utf8');
  check(
    'the plugin surfaces an unreadable history as a timeline warning',
    /title: "会话历史读取失败"/.test(session),
  );
}

console.log('the first-message refusal does not interrupt a running turn');
{
  const bridge = readFileSync(join(import.meta.dirname, '..', 'dsh-bridge/lib/server.js'), 'utf8');
  const preliminary = bridge.indexOf('const preliminary = planRewind(');
  const settle = bridge.indexOf('await this.settleAgentForRevert(agent)');
  check(
    'the bridge plans (and may refuse) before it settles the agent',
    preliminary !== -1 && settle !== -1 && preliminary < settle,
  );
}

console.log('receipt');
{
  check('the receipt names the withdrawn seq', successText(42) === 'Withdrawn seq 42 and everything after it', successText(42));
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
  check('provider does NOT declare session.revert.files', provider.includes('"session.revert.files"') === false);
  check(
    'provider dispatches session.revert to the session',
    /case "session\.revert":/.test(provider) && /\.revert\(input\.token,\s*input\.scope\)/.test(provider),
  );
  check(
    'provider records the daemon-injected agent id',
    /PASEO_AGENT_ID/.test(provider) && /#agentIds\.set\(sessionId, agentId\)/.test(provider),
  );
  check(
    'provider answers the rewind before scheduling the refresh',
    (() => {
      const caseStart = provider.indexOf('case "session.revert":');
      const completed = provider.indexOf('this.#emit({ type: "request.completed", requestId: input.requestId });', caseStart);
      const refresh = provider.indexOf('this.#refreshAgent(input.sessionId);', caseStart);
      return caseStart !== -1 && completed !== -1 && refresh !== -1 && completed < refresh;
    })(),
  );
  check(
    'provider resolves the paseo binary explicitly',
    /#resolvePaseoBinary\(\)/.test(provider) && /PASEO_BIN/.test(provider),
  );
  check(
    'provider surfaces a failed file restore as a (deferred) timeline notice',
    /#deferNotice\(input\.sessionId, \{\s*severity: "error",\s*title: "文件回退未完成"/.test(provider),
  );
  check(
    'provider warns when the auto-refresh did not run',
    /时间线未自动刷新/.test(provider),
  );

  const session = read('paseo-plugin/server/session.ts');
  check(
    'the live row is emitted once, with its revert token',
    /#emitUserMessage\(prompt\.clientMessageId, label, messageId === undefined \? undefined : \{ messageId \}\)/.test(session),
  );
  check(
    'no token-less live row is emitted before the prompt',
    session.indexOf('#emitUserMessage(prompt.clientMessageId, label)') === -1,
  );
  check(
    'the replayed row carries the same token',
    /revertToken: \{ messageId: data\.id \}/.test(session),
  );
  check(
    'the skill row also carries a token',
    /#emitUserMessage\(prompt\.clientMessageId, line, messageId === undefined \? undefined : \{ messageId \}\)/.test(session),
  );
  check(
    'the permission preset is written without the slash command',
    /process\.setPermission\(requestedPermission\)/.test(session) && /runCommand\("permission"/.test(session) === false,
  );
  check('both replay sites are wired', (session.match(/revertToken: \{ messageId: data\.id \}/g) ?? []).length === 2);
  check(
    'a rewind settles any question card still waiting for an answer',
    /#clearPendingPermissions\("The conversation was rewound past this question/.test(session),
    'pending question cards would outlive the turn that asked them',
  );

  const process = read('paseo-plugin/server/dsh-process.ts');
  check('the plugin reaches the bridge', process.includes('"paseo/revert"'));
  check('and forwards the scope', /revert\(token: unknown, scope: "conversation" \| "files" \| "both"\)/.test(process));
  check('the permission switch is its own bridge call', /"paseo\/permission\/set"/.test(process));
  check('the revert receipt type carries the file outcome', /interface DshRevertFiles[\s\S]{0,200}failed: Array<\{ path: string; error: string \}>/.test(process));

  const bridge = read('dsh-bridge/lib/server.js');
  check('the bridge serves paseo/revert', /case 'paseo\/revert':/.test(bridge) && /return this\.revert\(params\)/.test(bridge));
  check('the bridge serves the non-command permission write', /case 'paseo\/permission\/set':/.test(bridge) && /service\.set\(/.test(bridge));
  check('the bridge resolves the token against the visible surface', /planRewind\(session\.surface\.nodes/.test(bridge));
  check(
    'the bridge appends the durable user/message replacement marker',
    /session\.append\(\s*'user\/message',\s*marker/.test(bridge),
  );
  check(
    'the replacement carries sourceEventSeqs for every shadowed node',
    /sourceEventSeqs: \[\.\.\.shadowed\]/.test(bridge),
  );
  check(
    'the bridge settles the agent before replacing (cancel -> idle -> steering)',
    /agent\.cancel\(\{ kind: 'user' \}, \{ keepInbox: true \}\)/.test(bridge)
      && /agent\.whenIdle\(\)/.test(bridge)
      && /agent\.inbox\.nextStep/.test(bridge),
  );
  check(
    'the bridge refuses unknown scopes instead of widening them',
    /unsupported revert scope/.test(bridge),
  );
  check(
    'the old assistant/message placeholder is gone',
    /append\(\s*'assistant\/message'[\s\S]{0,120}surfaceOp/.test(bridge) === false,
  );

  // File layer: editing-tool write-ahead snapshots wired around the rewind.
  check('the bridge owns a FileSnapshots store', /new FileSnapshots\(/.test(bridge));
  const planIndex = bridge.indexOf('planRestore(');
  const appendIndex = bridge.indexOf("session.append(\n        'user/message',\n        marker,");
  const restoreIndex = bridge.indexOf('fileSnapshots.restore(');
  check(
    'files are planned before the log write and restored after it',
    planIndex !== -1 && appendIndex !== -1 && restoreIndex !== -1 && planIndex < appendIndex && appendIndex < restoreIndex,
    `plan ${planIndex}, append ${appendIndex}, restore ${restoreIndex}`,
  );
  check(
    'the receipt carries the file outcome',
    /files === undefined \? \{\} : \{ files \}/.test(bridge),
  );

  const bridgeEntry = read('dsh-bridge/lib/index.js');
  check(
    'the bridge entry observes tools/execute for before-capture',
    /scope\.on\('tools\/execute'[\s\S]{0,160}captureFileBeforeTool/.test(bridgeEntry),
  );
  check(
    'and tools/post-execute for the successful commit',
    /scope\.on\('tools\/post-execute'[\s\S]{0,160}commitFileTool/.test(bridgeEntry),
  );
  check(
    'and tools/result to drop failed/cancelled captures',
    /scope\.on\('tools\/result'[\s\S]{0,120}dropFileTool/.test(bridgeEntry),
  );

  check(
    'the session parks an idle process instead of killing it',
    /session\??\.close\(\{ park: true \}\)/.test(provider),
  );
  check(
    'the provider owns and stops the parked-process pool',
    /new ParkedSessions\(/.test(provider) && /#parked\.stop\(\)/.test(provider),
  );
  const idleParkReturn = read('paseo-plugin/server/session.ts');
  const sessionRaw = readFileSync(join(import.meta.dirname, '..', 'paseo-plugin/server/session.ts'), 'utf8');
  check(
    'a running turn or a refused park falls back to shutdown',
    /this\.#turnId === null/.test(idleParkReturn) && /await process\.shutdown\(\);/.test(idleParkReturn),
  );
  check(
    'provider teardown shuts sessions down instead of parking',
    /session\.close\(\{ park: false \}\)/.test(provider),
  );
  check(
    'the reopened session adopts the parked process',
    /takeParked: \(dshSessionId, expected\) => this\.#parked\.take/.test(provider),
  );
  // Reuse identity must be the boot-time route only: the thinking effort is
  // applied by session.configure after open, so including it made every reload
  // look like a route change and killed a reusable child (+2.2s measured).
  const routeKeyBody = /function routeKeyOf\([\s\S]{0,200}?\n}/.exec(sessionRaw)?.[0] ?? '';
  check(
    'the parked route key excludes the thinking effort',
    /return `\$\{route\.provider\}\/\$\{route\.model\}`;/.test(routeKeyBody)
      && /reasoningEffort/.test(routeKeyBody) === false,
    routeKeyBody.split('\n').find((line) => line.includes('return')) ?? '',
  );
  const refreshDelay = Number((provider.match(/\}, (\d+)\);\s*timer\.unref\(\)/) ?? [])[1]);
  check(
    'the refresh trigger is short (the CLI spawn itself covers the settle window)',
    Number.isFinite(refreshDelay) && refreshDelay <= 200,
    `${refreshDelay}ms`,
  );

  const timeline = read('paseo-plugin/server/timeline.ts');
  const timelineRaw = readFileSync(join(import.meta.dirname, '..', 'paseo-plugin/server/timeline.ts'), 'utf8');
  check(
    'internal command rows are filtered only as legacy cleanup',
    /LEGACY_INTERNAL_COMMANDS/.test(timeline) && /legacy/.test(timelineRaw),
  );

  const snapshotsModule = read('dsh-bridge/lib/file-snapshots.js');
  check('the file layer tracks the write/edit tools', /'write', 'edit'/.test(snapshotsModule));
  check('before-content is captured into content-addressed objects', /createHash\('sha256'\)/.test(snapshotsModule));
  check('current content is rescued before a restore overwrites it', /#rescue\(/.test(snapshotsModule) && /rescueDir/.test(snapshotsModule));
  check('a failed journal line never invalidates earlier snapshots', /skippedLines/.test(snapshotsModule));
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
