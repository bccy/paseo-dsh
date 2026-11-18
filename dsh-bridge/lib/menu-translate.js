/**
 * One-shot translation of `/` menu descriptions (`paseo/translate`).
 *
 * The plugin localizes the descriptions of commands and skills it has a table
 * entry for; everything else — a skill the user installs next week, a command a
 * new DSH version adds — would stay in its author's language. This asks the
 * session's own model route to translate those few lines once; the plugin caches
 * the answer on disk, so each description is paid for one time.
 *
 * The call goes through DSH's `llm.prepareCall` → `call.stream`, the same path
 * DSH's own session-title generator uses for an auxiliary model call
 * (`@deepseek-ai/dsh-session-title-llm`'s `executeSessionTitleLlm`). Reused on
 * purpose instead of opening a hidden session: a session would be persisted
 * under `~/.dsh/sessions`, show up in Paseo's import list, and carry the whole
 * agent system prompt (tools, AGENTS.md) for a request that needs none of it.
 * Nothing here is appended to any session log. Boundary of the reuse: only
 * `prepareCall(config, signal, configure)`, the prepared `config`/`stream`, and
 * `BlockAssembler`/`createUserMessage` from `@deepseek-ai/dsh-llm`, which
 * `server.js` already imports for turns and hands in here, so this module stays
 * dependency-free and loads offline (`harness/menu-translate-check.mjs`).
 *
 * Failures are loud: a route that cannot be resolved, a non-`stop` finish, or an
 * answer that is not a JSON object throws, and the plugin logs it and keeps the
 * original text. A name the model left out is simply absent from the answer —
 * never filled with the source text, which would be cached as a "translation".
 *
 * @module dsh-paseo-bridge/menu-translate
 */
/** Upper bound on items per request; the plugin batches below it. */
export const MAX_TRANSLATE_ITEMS = 40;
/** Source text is cut here: a menu needs the first sentence, not a manual. */
export const MAX_SOURCE_CHARS = 600;
/**
 * A translated line longer than this is not a menu description; it is dropped.
 * Generous on purpose: the menu ellipsizes a long line anyway, and a dropped
 * line is re-requested on every plugin restart, so only a runaway answer is cut.
 */
export const MAX_RESULT_CHARS = 300;
/** Output budget for one batch (40 short lines plus reasoning headroom). */
const MAX_OUTPUT_TOKENS = 4096;
/** Whole-call deadline. */
const TIMEOUT_MS = 60_000;

/** Target-language wording for the system prompt, keyed by the plugin's locale ids. */
const LANGUAGES = { 'zh-CN': 'Simplified Chinese (简体中文)' };

/**
 * Validate and normalize the request.
 *
 * @param {unknown} params
 * @returns {{sessionId: string, locale: string, items: {name: string, text: string}[]}}
 */
export function parseTranslateParams(params) {
  if (typeof params !== 'object' || params === null) throw new TypeError('paseo/translate requires params');
  const { sessionId, locale, items } = /** @type {Record<string, unknown>} */ (params);
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new TypeError('paseo/translate requires sessionId');
  }
  if (typeof locale !== 'string' || !Object.hasOwn(LANGUAGES, locale)) {
    throw new TypeError(`paseo/translate: unsupported locale ${JSON.stringify(locale)}`);
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_TRANSLATE_ITEMS) {
    throw new TypeError(`paseo/translate items must be 1..${MAX_TRANSLATE_ITEMS} entries`);
  }
  const seen = new Set();
  const parsed = items.map((item) => {
    const name = item?.name;
    const text = item?.text;
    if (typeof name !== 'string' || name === '' || typeof text !== 'string' || text.trim() === '') {
      throw new TypeError('paseo/translate items need a nonempty name and text');
    }
    if (seen.has(name)) throw new TypeError(`paseo/translate: duplicate item ${name}`);
    seen.add(name);
    return { name, text: text.trim().slice(0, MAX_SOURCE_CHARS) };
  });
  return { sessionId, locale, items: parsed };
}

/** The system instruction for one target language. */
export function translateSystemPrompt(locale) {
  return [
    `Translate short command-menu descriptions of an AI coding assistant into ${LANGUAGES[locale]}.`,
    'The input is a JSON object mapping a command name to its English description.',
    'Return only one JSON object with the same keys, each mapped to its translation — no Markdown, no code fence, no commentary.',
    'Each translation is ONE short line, at most 30 Chinese characters: say what the command does, and omit usage triggers ("Use when ..."), examples, tool names, and lists of sub-actions.',
    'Keep product names, file extensions, command names, and code identifiers as written (Paseo, DSH, MCP, CLI, .docx, PDF).',
    'Never call tools.',
  ].join('\n');
}

/**
 * Read the model's answer: one JSON object, optionally fenced, keys limited to
 * what was asked for, values one trimmed line within {@link MAX_RESULT_CHARS}.
 *
 * @param {string} text - the concatenated text blocks.
 * @param {string[]} names - the requested keys.
 * @returns {Record<string, string>}
 */
export function parseTranslateOutput(text, names) {
  // One optional ```json fence around the whole answer, nothing else: an
  // answer that starts with prose or an array is not the asked-for object, and
  // fishing a `{…}` out of it would read a nested value as the answer.
  const body = text.trim().replace(/^```[a-z]*\s*/iu, '').replace(/\s*```$/u, '').trim();
  if (!body.startsWith('{') || !body.endsWith('}')) {
    throw new Error('paseo/translate: the model did not answer a JSON object');
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error(`paseo/translate: the model's answer is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('paseo/translate: the model did not answer a JSON object');
  }
  const out = {};
  for (const name of names) {
    if (!Object.hasOwn(value, name)) continue;
    const raw = value[name];
    if (typeof raw !== 'string') continue;
    const line = raw.replace(/\s+/gu, ' ').trim();
    if (line === '' || line.length > MAX_RESULT_CHARS) continue;
    Object.defineProperty(out, name, { value: line, enumerable: true });
  }
  return out;
}

/** The lowest reasoning effort the model declares, like DSH's title generator. */
const lowestEffort = (model) => model.reasoning?.efforts?.[0]?.id;

/**
 * Run one translation call on a route.
 *
 * @param {{prepareCall: Function}} llm - DSH's `llm` service.
 * @param {{provider: string, model: string}} route
 * @param {{locale: string, items: {name: string, text: string}[]}} request
 * @param {{BlockAssembler: new () => any, createUserMessage: (input: object) => object}} dsh
 *   - `@deepseek-ai/dsh-llm`'s exports, passed in by `server.js`.
 * @returns {Promise<Record<string, string>>}
 */
export async function runTranslate(llm, route, request, { BlockAssembler, createUserMessage }) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const source = Object.fromEntries(request.items.map((item) => [item.name, item.text]));
  const messages = [createUserMessage({
    content: [{ type: 'text', text: JSON.stringify(source) }],
    source: { kind: 'paseo-menu-translate' },
  })];
  const call = await llm.prepareCall(
    { provider: route.provider, model: route.model, maxTokens: MAX_OUTPUT_TOKENS },
    signal,
    (controls, model) => {
      const effort = lowestEffort(model);
      return { ...controls, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
    },
  );
  const assembler = new BlockAssembler();
  for await (const chunk of call.stream({
    ...call.config,
    messages,
    system: translateSystemPrompt(request.locale),
    signal,
  })) {
    assembler.push(chunk);
  }
  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`paseo/translate: ${finish.kind}: ${finish.failure?.message ?? 'no detail'}`);
  }
  if (finish.kind !== 'stop') {
    throw new Error(`paseo/translate: the model stopped with ${finish.kind}`);
  }
  const text = assembler.blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return parseTranslateOutput(text, request.items.map((item) => item.name));
}
