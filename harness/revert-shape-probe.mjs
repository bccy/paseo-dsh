/**
 * Real-DSH probe for the rewind write itself.
 *
 * The offline `revert-check.mjs` cannot prove that DSH accepts the replacement
 * event — that was exactly how the previous implementation shipped a write that
 * threw on every real append. This probe builds a real `Session` from the locally
 * installed `@deepseek-ai/dsh-session`, applies the same replacement shape the
 * bridge appends, and asserts:
 *
 * - an empty `assistant/message` replacement is rejected by DSH (the P0 that
 *   forced this redesign);
 * - the `system/message` + empty content + `sourceEventSeqs` replacement is
 *   accepted;
 * - the withdrawn turns leave `surface.nodes` and `deriveMessages()`, and the
 *   marker itself never appears in the derived context;
 * - the raw log keeps every event (append-only).
 *
 * Usage: node harness/revert-shape-probe.mjs
 * Set `DSH_SESSION_MODULE` to override the default install location.
 */
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const DEFAULT_MODULE = `${homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`;
const modulePath = process.env.DSH_SESSION_MODULE ?? DEFAULT_MODULE;
const { Session } = await import(pathToFileURL(modulePath).href);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

const system = () => ({ message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'system-prompt' } } });
const user = (id, text) => ({ id: `u-${id}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
const assistant = (id, text) => ({ message: { id: `a-${id}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } });

/** Build a two-turn session with real surface-append events. */
function makeSession() {
  const session = Session.create('rewind-shape-probe');
  session.append('system/message', system(), { surfaceOp: 'append' });
  session.append('user/message', user('1', 'one'), { surfaceOp: 'append' });
  session.append('assistant/message', assistant('1', 'reply one'), { surfaceOp: 'append' });
  session.append('user/message', user('2', 'two'), { surfaceOp: 'append' });
  session.append('assistant/message', assistant('2', 'reply two'), { surfaceOp: 'append' });
  // The log tail of a finished turn: log-only events after the last surface node.
  session.append('step/end', { turn: 1, step: 2 });
  session.append('turn/end', { turn: 1, outcome: { kind: 'completed' } });
  return session;
}

const derivedText = (session) => session.deriveMessages().map((message) => {
  const text = Array.isArray(message.content)
    ? message.content.filter((block) => block.type === 'text').map((block) => block.text).join('|')
    : '';
  return `${message.role}:${text}`;
});

console.log('the previous write shape is rejected by real DSH');
{
  const session = makeSession();
  const nodes = session.surface.nodes;
  const target = nodes[3]; // user "two"
  let error;
  try {
    session.append(
      'assistant/message',
      { message: { id: 'bad-marker', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } } },
      { surfaceOp: { op: 'replace', startSeq: target, endSeq: nodes[nodes.length - 1] } },
    );
  } catch (caught) {
    error = caught;
  }
  check('assistant/message replacement is refused', error !== undefined, error?.message);
  check('and the log was not mutated', session.seq === 7, String(session.seq));
}

console.log('the bridge replacement shape is accepted');
{
  const session = makeSession();
  const nodes = session.surface.nodes;
  const target = nodes[3];
  const shadowed = nodes.slice(3);
  const event = session.append(
    'system/message',
    { message: { id: 'rewind-marker', role: 'system', content: [], source: { kind: 'system-prompt' } } },
    {
      surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
      sourceEventSeqs: [...shadowed],
    },
  );
  check('the replacement is appended', event.seq === 7, String(event.seq));
  check('the surface shrinks to the kept nodes plus the marker', JSON.stringify(session.surface.nodes) === JSON.stringify([0, 1, 2, 7]), JSON.stringify(session.surface.nodes));
  check('the raw log keeps the withdrawn events', session.snapshotEvents().some((entry) => entry.type === 'user/message' && entry.data.id === 'u-2'));
  const derived = derivedText(session);
  check('the model no longer sees the withdrawn turn', derived.some((line) => line.includes('two') || line.includes('reply two')) === false, derived.join(' / '));
  check('the kept turns stay visible', derived.includes('user:one') && derived.includes('assistant:reply one'), derived.join(' / '));
  check('the marker never reaches the model', derived.some((line) => line.startsWith('system:') && line === 'system:') === false, derived.join(' / '));
}

console.log('a second rewind over the new surface is valid');
{
  const session = makeSession();
  const nodes = session.surface.nodes;
  const shadowed = nodes.slice(3);
  session.append('system/message', { message: { id: 'rewind-marker-1', role: 'system', content: [], source: { kind: 'system-prompt' } } }, {
    surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
    sourceEventSeqs: [...shadowed],
  });
  const again = session.surface.nodes;
  const shadowed2 = again.slice(1);
  const event = session.append('system/message', { message: { id: 'rewind-marker-2', role: 'system', content: [], source: { kind: 'system-prompt' } } }, {
    surfaceOp: { op: 'replace', startSeq: shadowed2[0], endSeq: shadowed2[shadowed2.length - 1] },
    sourceEventSeqs: [...shadowed2],
  });
  check('a second rewind appends and shrinks further', JSON.stringify(session.surface.nodes) === JSON.stringify([0, 8]) && event.seq === 8, JSON.stringify(session.surface.nodes));
  check('only the system prompt remains visible', session.deriveMessages().length === 1, JSON.stringify(derivedText(session)));
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
