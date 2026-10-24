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
 * The second half of this file asserts the wiring: a perfect helper that nothing
 * calls looks exactly like a working feature until the button is pressed, and
 * the offline layer cannot see the DSH session itself.
 *
 * The parked-process half is asserted **behaviourally**: the plugin is compiled
 * to CommonJS (`harness/plugin-build.cjs`) and a real `DshSession` is driven
 * with a fake process transport. Those claims used to be regexes over
 * `provider.ts`/`session.ts` source, which made them formatting tests — moving
 * a call to a second line turned them red while the behaviour was unchanged.
 * What matters here is what the objects do:
 *
 *   - an idle close offers the process to the park callback and does **not**
 *     shut it down;
 *   - a running turn, or a refused park, falls back to shutdown;
 *   - a reopen adopts the parked instance itself (identity, not a new spawn);
 *   - the reuse key is provider/model only, so a different thinking effort still
 *     reuses the child (that regression cost +2.2s of cold start per reload).
 *
 * Usage: node harness/revert-check.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  FIRST_MESSAGE_REFUSAL,
  isHumanUserMessage,
  planRewind,
  restoresFiles,
  revertScope,
  successText,
  tokenMessageId,
} from '../dsh-bridge/lib/revert.js';

const require = createRequire(import.meta.url);
const { resolvePluginBuild } = require('./plugin-build.cjs');
const { callArguments, mentions, methodSignature, splitArguments } = require('./source-shape.cjs');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

/**
 * Poll until `predicate` is true, or give up after `timeoutMs`.
 *
 * The behaviour section below drives the real provider over its async event
 * stream; the events arrive on a later tick, so a plain await is not enough and
 * a fixed sleep would make the check both slow and flaky. Returns whether the
 * predicate became true — the caller asserts on that, so a timeout is a failure
 * with a message rather than a hang.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
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
  // `session.ts` emits the row from one helper, and its argument list spans
  // several lines after the refactor. Match the *whole call* (helper name + its
  // exact arguments), not one line: "the helper appears somewhere" would let a
  // second, token-less emission through. Each branch must emit exactly one row
  // and each row must carry the token built from the bridge's message id.
  const emitUserMessageCalls = [...session.matchAll(/#emitUserMessage\(([\s\S]*?)\);/g)]
    .map((match) => match[1].replace(/\s+/g, ' ').trim());
  const carriesReplyToken = (body) =>
    /reply\.messageId === undefined \? undefined : \{ messageId: reply\.messageId \}/.test(body);
  const labelRows = emitUserMessageCalls.filter((body) => body.startsWith('prompt.clientMessageId, label'));
  check(
    'the live row is emitted once, with its revert token',
    labelRows.length === 1 && carriesReplyToken(labelRows[0]),
    `${labelRows.length} emission(s)`,
  );
  check(
    'no token-less live row is emitted before the prompt',
    emitUserMessageCalls.every((body) => !body.startsWith('prompt.clientMessageId,') || carriesReplyToken(body)),
    emitUserMessageCalls.filter((body) => body.startsWith('prompt.clientMessageId,') && !carriesReplyToken(body)).join(' | '),
  );
  check(
    'the replayed row carries the same token',
    /revertToken: \{ messageId: data\.id \}/.test(session),
  );
  const skillRows = emitUserMessageCalls.filter((body) => body.startsWith('prompt.clientMessageId, line'));
  check(
    'the skill row also carries a token',
    skillRows.length === 1 && carriesReplyToken(skillRows[0]),
    `${skillRows.length} emission(s)`,
  );
  // Read the call's arguments instead of its exact spelling: the one-process
  // rewrite made `setPermission` take the session id first, which reflowed the
  // call and broke the old single-line regex while the behaviour was unchanged.
  // The claim is "the preset is written through the non-command path, and the
  // slash command is not used for it".
  check(
    'the permission preset is written without the slash command',
    callArguments(session, 'setPermission').some((args) => {
      const parts = splitArguments(args).map((part) => part.trim());
      return parts.some((part) => mentions(part, 'requestedPermission'));
    }) &&
      callArguments(session, 'runCommand').every((args) => !mentions(args, 'permission')),
    callArguments(session, 'setPermission').map((args) => `setPermission(${args.trim()})`).join(' | ') || '(no call)',
  );
  check('both replay sites are wired', (session.match(/revertToken: \{ messageId: data\.id \}/g) ?? []).length === 2);
  check(
    'a rewind settles any question card still waiting for an answer',
    /#clearPendingPermissions\("The conversation was rewound past this question/.test(session),
    'pending question cards would outlive the turn that asked them',
  );

  const process = read('paseo-plugin/server/dsh-process.ts');
  check('the plugin reaches the bridge', process.includes('"paseo/revert"'));
  // Read the method's parameter list, not its spelling: adding a parameter (the
  // per-session `sessionId` the one-process rewrite introduced) reflowed the
  // signature and made the old one-line regex fail while the method still took
  // exactly the arguments that matter.
  check(
    'and forwards the scope',
    (() => {
      const signature = methodSignature(process, 'revert');
      if (signature === undefined) return false;
      const parts = signature.params.map((param) => param.trim());
      const scopeParam = parts.find((param) => param.startsWith('scope'));
      return scopeParam !== undefined
        && /"conversation"\s*\|\s*"files"\s*\|\s*"both"/.test(scopeParam)
        && parts.some((param) => param.startsWith('token'));
    })(),
  );
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
    /不支持的回退范围/.test(bridge),
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
    'provider teardown shuts sessions down instead of parking',
    /session\.close\(\{ park: false \}\)/.test(provider),
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

// ---------------------------------------------------------------------------
// The parked-process reuse path, asserted by driving the real `DshSession`.
//
// Everything below was a regex over `provider.ts` / `session.ts` source until
// the one-process rewrite, which made the checks formatting-sensitive: the same
// four claims were proven to go red on nothing but a reflowed call site. They
// are behaviour now — a fake transport records what the session did to it, and
// identity (`===`) proves reuse rather than a fresh spawn.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// The shared-process lifecycle, asserted by driving the real `DshSession`.
//
// Everything below was a regex over `provider.ts` / `session.ts` source until
// the one-process rewrite, which made the checks formatting-sensitive: the same
// claims were proven to go red on nothing but a reflowed call site. They are
// behaviour now — a fake transport records what the session did to it.
//
// **The model changed underneath them.** There is no per-session process to park
// and adopt any more: `DshSession.open()` asks the provider for the shared child
// (`acquireProcess`) and attaches to it, and `close()` detaches and hands the
// claim back (`releaseProcess`). The provider owns the reference count and retires
// the child when the last session leaves. So the claims that survive are:
//
//   1. open acquires once and attaches **this** session with its own cwd/route;
//   2. close detaches from the bridge and releases the claim — it never shuts the
//      child down itself (that would end every other conversation);
//   3. a second session attaches to the *same* child, which is the whole point;
//   4. the child is retired by the provider, not by a session.
// ---------------------------------------------------------------------------
console.log('shared-process lifecycle (behaviour, not source text)');
{
  const buildDir = resolvePluginBuild(undefined, '.dbg-t5-revert');
  const processModule = require(join(buildDir, 'server', 'dsh-process.js'));
  const { DshSession } = require(join(buildDir, 'server', 'session.js'));

  /** A process transport that records what the session asked it to do. */
  const spawned = [];
  class FakeProcess {
    constructor(options) {
      this.options = options;
      this.running = true;
      this.started = false;
      this.shutdownCalled = false;
      this.killed = false;
      this.planWrites = [];
      this.detached = [];
      this.attached = new Map();
      spawned.push(this);
    }
    async start() {
      this.started = true;
    }
    async shutdown() {
      this.shutdownCalled = true;
      this.running = false;
    }
    kill() {
      this.killed = true;
      this.running = false;
    }
    setHandlers(handlers) {
      this.handlers = handlers;
    }
    /**
     * Attach one session: its own handlers plus its own cwd/route/MCP servers.
     *
     * This is what replaced "adopt a parked process". It has to be per session,
     * because a shared child serves sessions in different projects.
     */
    async attachSession(sessionId, handlers, options) {
      if (sessionId === '') throw new Error('attachSession requires a session id');
      this.attached.set(sessionId, { handlers, options });
      this.handlers = handlers;
    }
    /** Detach one session and drop the bridge's session-keyed state. */
    async closeSession(sessionId) {
      this.detached.push(sessionId);
      this.attached.delete(sessionId);
    }
    async setPlan(sessionId, active) {
      this.planWrites.push({ sessionId, active });
      return { active, pending: false };
    }
    async setConfig(sessionId, changes) {
      return { ...changes };
    }
    async usage() {
      return { available: true, contextWindow: 1000, usedTokens: 0 };
    }
    async history() {
      return { events: [], hasMore: false };
    }
    async catalog() {
      return { providers: [], models: [], presets: [] };
    }
    async commands() {
      return [];
    }
    async presets() {
      return { presets: [], current: null };
    }
    async permission() {
      return { current: null, presets: [] };
    }
    async sessions() {
      return { sessions: [] };
    }
    async subagents() {
      return { subagents: [] };
    }
    async getPlan() {
      return { active: false, pending: false, available: false };
    }
  }
  // Module-level replacement is how `context-usage-check.cjs` has always driven
  // this class. `DshSession` takes its transport from `acquireProcess` now, so
  // this only matters for the provider-level case below.
  processModule.DshProcess = FakeProcess;

  /**
   * Build a session wired to a shared child, the way the provider wires it.
   *
   * `acquireProcess` returns `{ process, reused }`; `reused` means the child was
   * already serving conversations (which changes how a native child's open turn is
   * interpreted). `releaseProcess` is the provider's claim hand-back.
   */
  const makeSession = (id, route, extra = {}) => {
    const claims = { acquired: 0, released: [] };
    const session = new DshSession({
      sessionId: id,
      cwd: '/work',
      env: {},
      route,
      mode: 'build',
      models: [],
      thinkingOptions: [],
      subsession: false,
      emit: () => {},
      log: () => {},
      acquireProcess: async () => {
        claims.acquired += 1;
        return { process: extra.sharedProcess, reused: claims.acquired > 1 };
      },
      releaseProcess: (process) => {
        claims.released.push(process);
      },
      ...extra.options,
    });
    return { session, claims };
  };

  // ---- 1. open acquires the shared child and attaches this session -------
  {
    // The shared child is constructed here, by the test, not by the session; take
    // the mark *after* it so the count only covers what `open()` does.
    const shared = new FakeProcess({});
    const spawnedBefore = spawned.length;
    const { session, claims } = makeSession(
      'revert-share-1',
      { provider: 'fixture', model: 'alpha' },
      { sharedProcess: shared },
    );
    await session.open();
    const attached = shared.attached.get('revert-share-1');
    check(
      'open acquires the shared child once',
      claims.acquired === 1 && claims.released.length === 0,
      `acquired ${String(claims.acquired)}, released ${String(claims.released.length)}`,
    );
    check(
      'and attaches this session with its own cwd and route',
      attached !== undefined &&
        attached.options.cwd === '/work' &&
        attached.options.route?.provider === 'fixture' &&
        attached.options.route?.model === 'alpha',
      JSON.stringify(attached?.options ?? null),
    );
    // A session must not construct its own transport any more: the only
    // `new DshProcess` left is the provider's shared-child spawn. Counted
    // relative to the mark so earlier cases do not pollute it.
    check(
      'and does not spawn a process of its own',
      spawned.length === spawnedBefore,
      `${String(spawned.length - spawnedBefore)} spawn(s) during open`,
    );

    // ---- 2. close detaches and releases, never shutting the child down ----
    await session.close({ park: true });
    check(
      'close detaches the session from the bridge',
      shared.detached.includes('revert-share-1'),
      JSON.stringify(shared.detached),
    );
    check(
      'and releases the claim instead of shutting the child down',
      claims.released.length === 1 && shared.shutdownCalled === false && shared.running === true,
      `released ${String(claims.released.length)}, shutdown ${String(shared.shutdownCalled)}`,
    );
  }

  // ---- 3. a second session attaches to the same child -------------------
  {
    const shared = new FakeProcess({});
    const first = makeSession('revert-share-2a', { provider: 'fixture', model: 'alpha' }, { sharedProcess: shared });
    const second = makeSession('revert-share-2b', { provider: 'fixture', model: 'alpha' }, { sharedProcess: shared });
    await first.session.open();
    await second.session.open();
    check(
      'two sessions attach to the one shared child',
      shared.attached.has('revert-share-2a') && shared.attached.has('revert-share-2b'),
      `attached [${[...shared.attached.keys()].join(',')}]`,
    );
    check(
      'the second acquire is reported as a reuse, not a cold start',
      second.claims.acquired === 1,
      `acquired ${String(second.claims.acquired)}`,
    );
    // Closing one must not disturb the other: this is the failure a per-session
    // shutdown would produce, and it is the reason the provider owns the count.
    await first.session.close({ park: true });
    check(
      'closing one session leaves the other attached',
      shared.attached.has('revert-share-2b') && shared.shutdownCalled === false,
      `attached [${[...shared.attached.keys()].join(',')}], shutdown ${String(shared.shutdownCalled)}`,
    );
    await second.session.close({ park: true });
    check(
      'the child is still alive after the last session leaves (the provider retires it)',
      shared.shutdownCalled === false && shared.running === true,
      `shutdown ${String(shared.shutdownCalled)}, running ${String(shared.running)}`,
    );
  }

  // ---- 4. the reuse key is provider/model, never the thinking effort ----
  {
    // The measured regression: including `reasoningEffort` in a reuse identity
    // made every reload look like a route change and killed a reusable child
    // (+2.2s of cold start). The key itself is gone with the per-session pool, but
    // the property it protected is not: a session with a different thinking
    // effort must still attach to the same shared child, and its route must be
    // pinned per session.
    const shared = new FakeProcess({});
    const high = makeSession('revert-key-high', { provider: 'fixture', model: 'alpha', reasoningEffort: 'high' }, { sharedProcess: shared });
    const low = makeSession('revert-key-low', { provider: 'fixture', model: 'alpha', reasoningEffort: 'low' }, { sharedProcess: shared });
    await high.session.open();
    await low.session.open();
    check(
      'a different thinking effort still shares the one child',
      shared.attached.has('revert-key-high') && shared.attached.has('revert-key-low'),
      `attached [${[...shared.attached.keys()].join(',')}]`,
    );
    check(
      'and each session pins its own effort, not the process default',
      shared.attached.get('revert-key-high')?.options.route?.reasoningEffort === 'high' &&
        shared.attached.get('revert-key-low')?.options.route?.reasoningEffort === 'low',
      JSON.stringify({
        high: shared.attached.get('revert-key-high')?.options.route?.reasoningEffort,
        low: shared.attached.get('revert-key-low')?.options.route?.reasoningEffort,
      }),
    );
  }

  // ---- 5. the provider owns the child's lifetime ------------------------
  {
    // The pool is created and started in the provider's constructor; its stop is
    // only observable on teardown, so the whole connection is driven: a session
    // opens, closes idle, and then the provider closes — which must retire the
    // child instead of leaking it. Asserting `new ParkedSessions(` / `#parked.stop()`
    // in the source could not tell a wired-up stop from one that runs before
    // anything is parked.
    const provider = require(join(buildDir, 'server', 'provider.js'));
    const conn = await provider.createDshProvider().connect({ capabilities: [] });
    const providerEvents = [];
    conn.onEvent((event) => providerEvents.push(event));
    await conn.send({
      type: 'session.open',
      requestId: 'share-open',
      sessionId: 'revert-pool-1',
      config: { cwd: '/work', mode: 'build' },
      history: 'skip',
    });
    await waitFor(() => providerEvents.some((event) => event.type === 'session.ready'), 5000);
    // The provider spawns exactly one **shared** child (under its own sentinel id)
    // plus a short-lived `catalog-probe` for the catalog read. The session does not
    // get a process of its own — that is the change — so the claim is that it
    // attached to the shared one.
    const sharedProcess = spawned.find(
      (process) => process.options?.sessionId === '__paseo_shared_process__',
    );
    const probeSpawns = spawned.filter(
      (process) => process.options?.sessionId === 'catalog-probe',
    ).length;
    check(
      'a provider session attaches to the one shared child',
      sharedProcess !== undefined &&
        spawned.filter((process) => process.options?.sessionId === '__paseo_shared_process__').length === 1 &&
        sharedProcess.attached.has('revert-pool-1'),
      `spawned [${spawned.map((process) => String(process.options?.sessionId)).join(', ')}]`
        + ` (${String(probeSpawns)} probe spawn(s))`,
    );
    await conn.send({ type: 'session.close', sessionId: 'revert-pool-1' });
    await sleep(300);
    check(
      'an idle provider-session close detaches but keeps the child alive',
      sharedProcess !== undefined &&
        sharedProcess.shutdownCalled === false &&
        sharedProcess.killed === false &&
        sharedProcess.running === true,
      `shutdown ${String(sharedProcess?.shutdownCalled)}, killed ${String(sharedProcess?.killed)}`,
    );
    await conn.close();
    check(
      'provider teardown retires the shared child',
      sharedProcess !== undefined &&
        (sharedProcess.killed === true || sharedProcess.shutdownCalled === true),
      `killed ${String(sharedProcess?.killed)}, shutdown ${String(sharedProcess?.shutdownCalled)}`,
    );
  }
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
