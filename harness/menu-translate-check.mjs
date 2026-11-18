/**
 * Offline check for automatic `/` menu translation.
 *
 * Two halves, both pure:
 *
 * 1. The bridge's `dsh-bridge/lib/menu-translate.js`: request validation, the
 *    model-answer parser (fenced JSON, unknown keys, overlong or empty lines,
 *    a non-object answer), and `runTranslate` against a fake `llm` service that
 *    records what was asked — lowest reasoning effort selected, no tools, the
 *    source text in the user message, and a non-`stop` finish thrown loudly.
 * 2. The plugin's `server/menu-translations.ts` (compiled with the shared plugin
 *    build): precedence user file > built-in > cache > original, a changed
 *    source re-translates, Chinese text is never sent, a failed or omitted name
 *    is not cached and not retried in the same process, English never
 *    translates, a corrupt user file is reported and ignored, batching at 40,
 *    and the cache survives a new instance (a plugin restart).
 *
 * No DSH, no daemon, no model. Usage: node harness/menu-translate-check.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_RESULT_CHARS,
  MAX_TRANSLATE_ITEMS,
  parseTranslateOutput,
  parseTranslateParams,
  runTranslate,
} from '../dsh-bridge/lib/menu-translate.js';

const require = createRequire(import.meta.url);
const { resolvePluginBuild } = require('./plugin-build.cjs');

let passed = 0;
let failed = 0;
function check(name, pass, detail) {
  if (pass) passed += 1;
  else failed += 1;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
}
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
async function rejects(promise) {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}

// ---- bridge: params -------------------------------------------------------
const okParams = { sessionId: 's1', locale: 'zh-CN', items: [{ name: 'a', text: ' Do A. ' }] };
check('params: a valid request parses and trims text', parseTranslateParams(okParams).items[0].text === 'Do A.');
check('params: missing sessionId is refused', throws(() => parseTranslateParams({ ...okParams, sessionId: '' })));
check('params: an unsupported locale is refused', throws(() => parseTranslateParams({ ...okParams, locale: 'en' })));
check('params: empty items are refused', throws(() => parseTranslateParams({ ...okParams, items: [] })));
check(
  `params: more than ${MAX_TRANSLATE_ITEMS} items are refused`,
  throws(() => parseTranslateParams({
    ...okParams,
    items: Array.from({ length: MAX_TRANSLATE_ITEMS + 1 }, (_, i) => ({ name: `n${i}`, text: 't' })),
  })),
);
check('params: duplicate names are refused', throws(() => parseTranslateParams({
  ...okParams, items: [{ name: 'a', text: 'x' }, { name: 'a', text: 'y' }],
})));

// ---- bridge: output parser ------------------------------------------------
const fenced = '```json\n{"a":"做 A","b":"  做\\n B ","zzz":"不该出现","c":""}\n```';
const parsed = parseTranslateOutput(fenced, ['a', 'b', 'c', 'd']);
check('output: fenced JSON is read', parsed.a === '做 A');
check('output: whitespace collapses to one line', parsed.b === '做 B', JSON.stringify(parsed.b));
check('output: keys that were not asked for are dropped', !Object.hasOwn(parsed, 'zzz'));
check('output: an empty line is dropped, not kept', !Object.hasOwn(parsed, 'c'));
check('output: a missing key stays missing (never echoes the source)', !Object.hasOwn(parsed, 'd'));
check('output: an overlong line is dropped', !Object.hasOwn(parseTranslateOutput(`{"a":"${'长'.repeat(MAX_RESULT_CHARS + 1)}"}`, ['a']), 'a'));
check('output: prose without JSON throws', throws(() => parseTranslateOutput('sorry, cannot', ['a'])));
check('output: an array answer throws', throws(() => parseTranslateOutput('[{"a":"x"}]', ['a'])));
check('output: a __proto__ key cannot pollute', (() => {
  const out = parseTranslateOutput('{"__proto__":"x","a":"y"}', ['__proto__', 'a']);
  return Object.getPrototypeOf(out) === Object.prototype && out.a === 'y';
})());

// ---- bridge: runTranslate on a fake llm ----------------------------------
class FakeAssembler {
  constructor() { this.text = ''; this._finish = { kind: 'stop' }; }
  push(chunk) {
    if (chunk.type === 'text') this.text += chunk.text;
    if (chunk.type === 'finish') this._finish = chunk.finish;
  }
  get finish() { return this._finish; }
  blocks() { return [{ type: 'reasoning', text: '{"a":"bad"}' }, { type: 'text', text: this.text }]; }
}
const createUserMessage = (input) => ({ role: 'user', ...input });
function fakeLlm(chunks) {
  const seen = {};
  return {
    seen,
    async prepareCall(config, signal, configure) {
      seen.config = config;
      seen.controls = configure({ provider: config.provider, model: config.model }, {
        reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] },
      });
      return {
        config: { ...config, ...seen.controls },
        async *stream(options) {
          seen.options = options;
          for (const chunk of chunks) yield chunk;
        },
      };
    },
  };
}
const llm = fakeLlm([{ type: 'text', text: '{"a":"做 A",' }, { type: 'text', text: '"b":"做 B"}' }]);
const answer = await runTranslate(
  llm,
  { provider: 'p', model: 'm' },
  { locale: 'zh-CN', items: [{ name: 'a', text: 'Do A' }, { name: 'b', text: 'Do B' }] },
  { BlockAssembler: FakeAssembler, createUserMessage },
);
check('run: streamed text blocks are joined and parsed', answer.a === '做 A' && answer.b === '做 B', JSON.stringify(answer));
check('run: reasoning blocks are not read as the answer', answer.a !== 'bad');
check('run: the route is the one given', llm.seen.config.provider === 'p' && llm.seen.config.model === 'm');
check('run: the lowest declared reasoning effort is selected', llm.seen.controls.reasoningEffort === 'low');
check('run: no tools are offered', llm.seen.options.tools === undefined);
check('run: the source text rides in the user message',
  JSON.parse(llm.seen.options.messages[0].content[0].text).a === 'Do A');
check('run: the system prompt names the target language', /Simplified Chinese/u.test(llm.seen.options.system));
check('run: a cancellation signal is passed', llm.seen.options.signal instanceof AbortSignal);
check('run: an error finish throws with its cause', await (async () => {
  try {
    await runTranslate(
      fakeLlm([{ type: 'finish', finish: { kind: 'error', failure: { message: 'quota' } } }]),
      { provider: 'p', model: 'm' },
      { locale: 'zh-CN', items: [{ name: 'a', text: 'x' }] },
      { BlockAssembler: FakeAssembler, createUserMessage },
    );
    return false;
  } catch (error) {
    return /quota/u.test(error.message);
  }
})());
check('run: a max-tokens finish throws', await rejects(runTranslate(
  fakeLlm([{ type: 'text', text: '{"a":"x"}' }, { type: 'finish', finish: { kind: 'max-tokens' } }]),
  { provider: 'p', model: 'm' },
  { locale: 'zh-CN', items: [{ name: 'a', text: 'x' }] },
  { BlockAssembler: FakeAssembler, createUserMessage },
)));

// ---- plugin: MenuTranslations --------------------------------------------
const buildDir = resolvePluginBuild(process.argv[2], '.dbg-menu-translate');
const { MenuTranslations, alreadyLocalized, localePaths } = require(join(buildDir, 'server', 'menu-translations.js'));

const home = mkdtempSync(join(tmpdir(), 'menu-translate-check-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
const logs = [];
const make = (locale = 'zh-CN') => new MenuTranslations({
  home,
  locale,
  log: (line) => logs.push(line),
  builtin: (name) => name === 'goal',
});
const paths = localePaths(home, 'zh-CN');

check('zh: Chinese text counts as localized', alreadyLocalized('zh-CN', '主会话编排 DSH'));
check('zh: English text does not', !alreadyLocalized('zh-CN', 'Create Word documents'));

const menu = [
  { name: 'goal', description: 'Set a goal' },
  { name: 'office-docx', description: 'Create Word documents (.docx).' },
  { name: 'shared-browser', description: '操作共享浏览器' },
  { name: 'mine', description: 'My skill' },
];
let t = make();
check('missing: built-in, already-Chinese entries are skipped',
  JSON.stringify(t.missing(menu).map((e) => e.name)) === JSON.stringify(['office-docx', 'mine']));

mkdirSync(paths.dir, { recursive: true });
writeFileSync(paths.user, JSON.stringify({ mine: '我的技能', goal: '我的目标说明' }));
check('user file: an entry is used', t.userLine('mine') === '我的技能');
check('user file: it also covers a built-in name', t.userLine('goal') === '我的目标说明');
check('missing: a user-file entry is not sent',
  JSON.stringify(t.missing(menu).map((e) => e.name)) === JSON.stringify(['office-docx']));

const calls = [];
const added = await t.translate(t.missing(menu), async (items) => {
  calls.push(items);
  return { 'office-docx': '创建 Word 文档（.docx）' };
});
check('translate: one batch, one cached line', added === 1 && calls.length === 1, `added=${added}`);
check('cache: the line is served for the same source',
  t.autoLine('office-docx', 'Create Word documents (.docx).') === '创建 Word 文档（.docx）');
check('cache: a changed source is a miss', t.autoLine('office-docx', 'Create and validate Word documents.') === undefined);
check('cache: it is on disk', JSON.parse(readFileSync(paths.cache, 'utf8')).entries['office-docx'].text === '创建 Word 文档（.docx）');
check('cache: a new instance (plugin restart) reads it',
  make().autoLine('office-docx', 'Create Word documents (.docx).') === '创建 Word 文档（.docx）');
check('missing: a cached entry is not sent again', make().missing(menu).length === 0);

// Failures: logged, not cached, not retried in this process.
t = make();
const fresh = [{ name: 'x', description: 'Do X' }, { name: 'y', description: 'Do Y' }];
let runs = 0;
const none = await t.translate(t.missing(fresh), async () => {
  runs += 1;
  throw new Error('route has no key');
});
check('failure: nothing cached', none === 0 && t.autoLine('x', 'Do X') === undefined);
check('failure: the cause is logged', logs.some((line) => /route has no key/u.test(line) && /x, y/u.test(line)));
check('failure: not retried in the same process', t.missing(fresh).length === 0 && runs === 1);
check('failure: a restart retries', make().missing(fresh).length === 2);

t = make();
await t.translate(t.missing(fresh), async () => ({ x: '做 X' }));
check('omitted: the missing name is not cached', t.autoLine('y', 'Do Y') === undefined && t.autoLine('x', 'Do X') === '做 X');
check('omitted: it is logged', logs.some((line) => /returned nothing for y/u.test(line)));
check('omitted: not retried in the same process', t.missing(fresh).length === 0);

// Batching.
t = make();
const many = Array.from({ length: 85 }, (_, i) => ({ name: `s${i}`, description: `Skill ${i}` }));
const sizes = [];
await t.translate(t.missing(many), async (items) => {
  sizes.push(items.length);
  return Object.fromEntries(items.map((item) => [item.name, `技能 ${item.name}`]));
});
check('batch: split at 40', JSON.stringify(sizes) === '[40,40,5]', JSON.stringify(sizes));

// Concurrent opens: the second sees the first in flight and sends nothing.
t = make();
const twin = [{ name: 'twin', description: 'Twin' }];
let release;
const gate = new Promise((resolve) => { release = resolve; });
const first = t.translate(t.missing(twin), async () => {
  await gate;
  return { twin: '双胞胎' };
});
check('in flight: a second open sends nothing', t.missing(twin).length === 0);
release();
await first;

// English and a corrupt user file.
check('en: never translates', make('en').missing(menu).length === 0);
writeFileSync(paths.user, '{ not json');
logs.length = 0;
t = make();
check('user file: corrupt is ignored', t.userLine('mine') === undefined);
check('user file: corrupt is logged', logs.some((line) => /not valid JSON/u.test(line)));

console.log(`\n  ${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
