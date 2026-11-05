/**
 * Offline check for the bridge's `paseo/settings/list|set` RPCs.
 *
 * `dsh-bridge/lib/server.js` imports profile-only packages, so the settings
 * surface is driven here the same way `bridge-server-check.mjs` drives the rest:
 * a module resolve hook anchors `@deepseek-ai/*` at this machine's DSH install,
 * and a recording ctx supplies the services the handlers read (`settings`,
 * `configEditor`) plus what `readPluginInventory(ctx)` needs (`loader` and the
 * optional `pluginPackages`). No profile, no daemon, no child process.
 *
 * What is pinned (each is a way the menu can be wrong):
 *
 *   1. **The filter is the production one.** `settingsList()` must project
 *      `settings.describe()` through `settings-discovery.js` — third-party +
 *      exactly one boolean field. Official entries, multi-field forms,
 *      non-boolean single fields, dict-shaped forms and rows whose projected
 *      value is missing are excluded, or the composer fills with DSH internals.
 *      A `cordis:*` runtime specifier is not a user plugin and is excluded too.
 *   2. **The title is passed through as a dictionary.** `meta.title` from the
 *      plugin inventory is a language map (`{en, zh}`); the bridge must not pick
 *      a language (the plugin's `LOCALE` is the single source), and a plugin
 *      without metadata must yield no title so the plugin falls back to the
 *      module specifier.
 *   3. **A profile without the service is an empty menu, not an error.**
 *      `{available:false, items:[]}` — an open must not fail because a
 *      non-web profile composes no settings service.
 *   4. **The write carries the revision and the exact path**, and a conflict is
 *      reported as `conflict` (not a generic failure) so the plugin can tell the
 *      user their click was superseded.
 *   5. **The answer is re-read.** The value returned is the value `describe()`
 *      reports after the write, not the requested one.
 *   6. **The RPCs are dispatched.** A `case` that names a missing method is a
 *      regression this repo already shipped once (`setPermission`); the whole
 *      switch is scanned for that shape.
 *   7. **The real inventory shape is understood.** The loader's entry id is
 *      `include:unrestricted` for a plugin mounted through an Include; the
 *      dictionary must still reach the row. The display metadata is read with
 *      `readPluginInventory(ctx)` (a package export available in every profile),
 *      not the web-app-only `pluginInventory` service.
 *   8. **The value precondition holds.** `expectedValue` refuses a stale write
 *      even when the revision still matches, and the legacy revision-only shape
 *      still works.
 *   9. **Only advertised namespaces are tracked for change notifications.**
 *      `settingsNamespaceTracked` gates `paseo/settings/changed`; a namespace
 *      that was filtered out must not wake the plugin.
 *  10. **`configEditor.configuration()` is read once per list.** It composes the
 *      whole profile configuration on every call; one call per descriptor (the
 *      first implementation) is O(namespaces) real compositions for one menu.
 *
 * Usage:
 *
 *   node harness/settings-bridge-check.mjs
 *
 * DSH packages are read from this machine's installation:
 *
 *   DSH_PACKAGES_DIR  the `@deepseek-ai` package directory to resolve from
 *                     (default: this machine's global DSH install)
 *   DSH_INSTALL_DIR   the installation root to anchor resolution at
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DSH_PACKAGES =
  `${homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`;
const dshPackages = process.env.DSH_PACKAGES_DIR ?? DEFAULT_DSH_PACKAGES;
const dshRoot = process.env.DSH_INSTALL_DIR ?? resolve(dshPackages, '..', '..');
const dshAnchor = join(dshRoot, 'package.json');
// The wire schema is a schemastery reference document; build fixtures with the
// same library the bridge rehydrates with, so the check cannot invent a shape
// the real `describe()` never emits.
const Schema = createRequire(dshAnchor)('@deepseek-ai/schemastery');

const { register } = await import('node:module');
register(`data:text/javascript,${encodeURIComponent(
  `import { createRequire } from 'node:module';
   import { pathToFileURL } from 'node:url';
   const require = createRequire(${JSON.stringify(dshAnchor)});
   export async function resolve(specifier, context, next) {
     if (specifier.startsWith('@deepseek-ai/')) {
       try {
         return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
       } catch {
         /* not a package this install ships: let Node report it */
       }
     }
     return next(specifier, context);
   }`,
)}`);

const bridgeRoot = join(import.meta.dirname, '..', 'dsh-bridge', 'lib');
let PaseoHarnessServer;
let discovery;
try {
  ({ PaseoHarnessServer } = await import(pathToFileURL(join(bridgeRoot, 'server.js')).href));
  discovery = await import(pathToFileURL(join(bridgeRoot, 'settings-discovery.js')).href);
} catch (error) {
  console.error('could not load dsh-bridge/lib offline.');
  console.error(`  DSH packages were resolved from ${dshPackages}`);
  console.error(`  (override with DSH_PACKAGES_DIR / DSH_INSTALL_DIR)`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

/**
 * Build a server whose only services are the ones a case supplies.
 *
 * An `Error` value makes the lookup throw, which is how the settings handlers'
 * own try/catch paths get exercised.
 */
function makeServer(services = {}) {
  const ctx = {
    get(name) {
      if (!(name in services)) return undefined;
      const value = services[name];
      if (value instanceof Error) throw value;
      return value;
    },
    on: () => () => {},
  };
  // Cordis exposes a service both through `ctx.get(name)` and as a property, and
  // some package functions read the property directly (`readPluginInventory`
  // iterates `ctx.loader.entries()`), so mirror the supplied services.
  for (const [name, value] of Object.entries(services)) {
    if (value instanceof Error) continue;
    ctx[name] = value;
  }
  const transport = { notify() {}, flush: async () => {}, request: async () => ({}) };
  return new PaseoHarnessServer(ctx, transport, {});
}

/** One describe() row for a volatile form, as the real service reports it. */
function row({ ns, revision = 1, value, schema }) {
  return { autoGenerate: true, ns, schema, revision, applies: 'live', value, base: value, user: {} };
}

/**
 * The exact shape `settings.describe()` puts on the wire: schemastery's
 * `toJSON()` reference document (`{uid, refs:{...}}`), NOT a plain
 * `{type, dict}` tree. The first implementation asserted plain JSON here, which
 * made the check green while every real profile produced zero toggles.
 */
const wireForm = (build) => build(Schema).toJSON();
const BOOLEAN_FORM = wireForm((schema) => schema.object({ enabled: schema.boolean().default(false) }));
const TWO_FIELD_FORM = wireForm((schema) =>
  schema.object({ enabled: schema.boolean(), allowed: schema.array(schema.string()) }));
const STRING_FORM = wireForm((schema) => schema.object({ label: schema.string() }));
const DICT_FORM = wireForm((schema) => schema.object({ providers: schema.dict(schema.object({})) }));
/** A malformed reference document: no such uid in refs. Must be skipped, not thrown. */
const BROKEN_FORM = { uid: 99, refs: {} };
/** Plain form JSON: `settings-discovery` must keep accepting it (test/future shape). */
const PLAIN_BOOLEAN_FORM = { type: 'object', dict: { enabled: { type: 'boolean', meta: { default: false } } } };

const MODULES = {
  'unrestricted': 'dsh-unrestricted',
  'memory': 'dsh-prime-memory',
  'web': '@deepseek-ai/dsh-web',
  'subagent-settings': '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
  'two-field': 'dsh-two-field',
  'string-field': 'dsh-string-field',
  'dict-field': 'dsh-dict-field',
  'no-value': 'dsh-no-value',
  'bare-boolean': 'dsh-bare-boolean',
  'cordis-row': 'cordis:group',
  'bad-revision': 'dsh-bad-revision',
};

/**
 * `configEditor` as the settings service reads it: profile entries with ids and
 * names. `configuration()` is counted: one list must compose the profile once.
 */
function configEditor() {
  const calls = { configuration: 0 };
  return {
    calls,
    configuration() {
      calls.configuration += 1;
      return Object.entries(MODULES).map(([id, name]) => ({
        entry: { options: { id, name } },
        inherited: {},
        override: {},
      }));
    },
  };
}

/**
 * A settings service over a mutable row table.
 *
 * `mutate` behaves like the real writer: it refuses a stale revision with the
 * service's own `SETTINGS_CONFLICT` code, applies the set, and bumps the
 * revision so the handler's re-read sees the committed value.
 */
function settingsService(rows) {
  const calls = { describe: [], mutate: [] };
  const service = {
    describe(options) {
      calls.describe.push(options ?? null);
      return rows.map((entry) => ({ ...entry, value: { ...entry.value } }));
    },
    async mutate(ns, ops, expectedRevision) {
      calls.mutate.push({ ns, ops: JSON.parse(JSON.stringify(ops)), expectedRevision });
      const target = rows.find((entry) => entry.ns === ns);
      if (target === undefined) throw new Error(`No configurable plugin entry "${ns}"`);
      if (target.revision !== expectedRevision) {
        const error = new Error(`settings conflict for "${ns}": expected revision ${String(expectedRevision)}`);
        error.code = 'SETTINGS_CONFLICT';
        throw error;
      }
      for (const op of ops) {
        if (op.op !== 'set') throw new Error(`unsupported op ${String(op.op)}`);
        target.value[op.path[0]] = op.value;
      }
      target.revision += 1;
      return undefined;
    },
  };
  return { calls, service };
}

/**
 * The `readPluginInventory(ctx)` inputs: a Loader with the entries and the
 * optional `pluginPackages` that resolves display metadata.
 *
 * `readPluginInventory` only skips a group row (`options.group`), reads
 * `entry.parent.tree.ctx.baseUrl` as the resolution base, and asks
 * `pluginPackages.metaOf(name, base)` for the package metadata. Nothing else is
 * needed, which is why it works in a `base+bridge` profile.
 */
function inventory(entries) {
  const baseUrl = 'file:///fake-profile/';
  return {
    loader: {
      entries: () => entries.map((entry) => ({
        id: entry.entryId,
        options: { name: entry.moduleName },
        disabled: false,
        fiber: { state: 2 },
        parent: { tree: { ctx: { baseUrl } } },
      })),
    },
    pluginPackages: {
      metaOf: (moduleName) => {
        const match = entries.find((entry) => entry.moduleName === moduleName);
        return match?.title === undefined ? undefined : { title: match.title };
      },
    },
  };
}

/** The descriptors a real profile would produce for the mixed candidate set. */
function candidateRows() {
  return [
    row({ ns: 'unrestricted', revision: 7, value: { enabled: false }, schema: BOOLEAN_FORM }),
    row({ ns: 'memory', revision: 2, value: { enabled: true }, schema: BOOLEAN_FORM }),
    row({ ns: 'web', revision: 4, value: { enabled: true }, schema: BOOLEAN_FORM }),
    row({ ns: 'subagent-settings', revision: 1, value: { enabled: false }, schema: BOOLEAN_FORM }),
    row({ ns: 'two-field', revision: 1, value: { enabled: true, allowed: [] }, schema: TWO_FIELD_FORM }),
    row({ ns: 'string-field', revision: 1, value: { label: 'x' }, schema: STRING_FORM }),
    row({ ns: 'dict-field', revision: 1, value: { providers: {} }, schema: DICT_FORM }),
    row({ ns: 'no-value', revision: 1, value: {}, schema: BOOLEAN_FORM }),
    row({ ns: 'bare-boolean', revision: 1, value: true, schema: { type: 'boolean' } }),
    row({ ns: 'cordis-row', revision: 1, value: { enabled: false }, schema: BOOLEAN_FORM }),
    row({ ns: 'bad-revision', revision: 1.5, value: { enabled: false }, schema: BOOLEAN_FORM }),
  ];
}

/** A namespace the profile composes but the settings service does not expose. */
const NO_SUCH_NS = 'not-in-describe';

console.log('bridge server: paseo/settings/list|set\n');

// ===== 1. the production filter: third-party + exactly one boolean =========
{
  const rows = candidateRows();
  const fake = settingsService(rows);
  const editor = configEditor();
  const server = makeServer({
    settings: fake.service,
    configEditor: editor,
    ...inventory([
      { entryId: 'unrestricted', moduleName: 'dsh-unrestricted', title: { en: 'Unrestricted mode', zh: '破限模式' } },
    ]),
  });
  const out = await server.handleRequest('paseo/settings/list', {});
  check(
    'only the third-party single-boolean namespaces are exposed',
    JSON.stringify(out.items.map((item) => item.ns)) === JSON.stringify(['unrestricted', 'memory']),
    JSON.stringify(out.items.map((item) => item.ns)),
  );
  check(
    'the answer reports the service as available',
    out.available === true,
    JSON.stringify(out.available),
  );
  check(
    'describe() is asked for redacted secrets (the composer must never receive them)',
    fake.calls.describe.length >= 1
      && fake.calls.describe.every((options) => options?.redactSecrets === true),
    JSON.stringify(fake.calls.describe),
  );
  check(
    'the wire schema is rehydrated, not read as plain JSON',
    // Positive control for the P0: the same reference document read directly by
    // the pure projection yields nothing, so the two items above can only come
    // from `server.js` rebuilding the node with `new Schema(...)`.
    discovery.simpleToggleField(BOOLEAN_FORM) === undefined
      && discovery.simpleToggleField(new Schema(BOOLEAN_FORM))?.path.join('.') === 'enabled',
    JSON.stringify([
      discovery.simpleToggleField(BOOLEAN_FORM),
      discovery.simpleToggleField(new Schema(BOOLEAN_FORM)),
    ]),
  );
  const unrestricted = out.items[0];
  check(
    'the toggle carries its field path, value and revision verbatim',
    JSON.stringify(unrestricted?.field) === JSON.stringify({ path: ['enabled'], value: false, revision: 7 }),
    JSON.stringify(unrestricted?.field),
  );
  check(
    'the inventory title is passed through as a language dictionary (the plugin picks the language)',
    JSON.stringify(unrestricted?.title) === JSON.stringify({ en: 'Unrestricted mode', zh: '破限模式' }),
    JSON.stringify(unrestricted?.title),
  );
  check(
    'a third-party namespace with no inventory metadata carries no title (the plugin falls back to the module name)',
    out.items[1]?.title === undefined && out.items[1]?.moduleName === 'dsh-prime-memory',
    JSON.stringify({ title: out.items[1]?.title, moduleName: out.items[1]?.moduleName }),
  );
  check(
    'official namespaces, multi-field forms, non-boolean fields, dicts, missing values, cordis: specifiers and bad revisions are excluded',
    !out.items.some((item) => ['web', 'subagent-settings', 'two-field', 'string-field', 'dict-field', 'no-value', 'bare-boolean', 'cordis-row', 'bad-revision'].includes(item.ns)),
    JSON.stringify(out.items.map((item) => item.ns)),
  );
  check(
    'configEditor.configuration() is composed once for one list, not once per descriptor',
    editor.calls.configuration === 1,
    `${String(editor.calls.configuration)} configuration() call(s) for ${String(rows.length)} row(s)`,
  );
  check(
    'namespaces last advertised are tracked for change notifications',
    server.settingsNamespaceTracked('unrestricted')
      && server.settingsNamespaceTracked('memory')
      && !server.settingsNamespaceTracked('web')
      && !server.settingsNamespaceTracked(NO_SUCH_NS),
    JSON.stringify([server.settingsNamespaceTracked('unrestricted'), server.settingsNamespaceTracked('web')]),
  );
}

// ===== 1b. a malformed wire schema is skipped, never fatal ================
{
  const rows = [
    row({ ns: 'broken', revision: 1, value: { enabled: true }, schema: BROKEN_FORM }),
    row({ ns: 'unrestricted', revision: 2, value: { enabled: false }, schema: BOOLEAN_FORM }),
  ];
  const fake = settingsService(rows);
  const server = makeServer({ settings: fake.service, configEditor: configEditor() });
  const out = await server.handleRequest('paseo/settings/list', {});
  check(
    'a row whose schema cannot be rehydrated is skipped, and the rest still lists',
    out.available === true
      && JSON.stringify(out.items.map((item) => item.ns)) === JSON.stringify(['unrestricted']),
    JSON.stringify({ available: out.available, items: out.items.map((item) => item.ns) }),
  );
}

// ===== 1c. an unavailable read forgets the last advertised namespaces ======
//
// `settingsNamespaceTracked` gates `paseo/settings/changed`: after the runtime
// can no longer answer `describe()`, a namespace advertised by the last good
// list must stop being forwarded (the composer no longer shows that row; a
// change would be pure churn). Both early returns — no settings service and a
// throwing `describe()` — must clear the set.
{
  const services = { settings: settingsService(candidateRows()).service, configEditor: configEditor() };
  const server = makeServer(services);
  await server.handleRequest('paseo/settings/list', {});
  const trackedBefore = server.settingsNamespaceTracked('unrestricted');
  delete services.settings;
  const afterRemoval = await server.handleRequest('paseo/settings/list', {});

  const throwing = settingsService(candidateRows());
  const throwingServer = makeServer({ settings: throwing.service, configEditor: configEditor() });
  await throwingServer.handleRequest('paseo/settings/list', {});
  const trackedBeforeThrow = throwingServer.settingsNamespaceTracked('unrestricted');
  throwing.service.describe = () => {
    throw new Error('scripted describe failure');
  };
  const afterThrow = await throwingServer.handleRequest('paseo/settings/list', {});

  check(
    'an unavailable settings read clears the previously advertised namespaces (both early returns)',
    trackedBefore
      && afterRemoval.available === false
      && !server.settingsNamespaceTracked('unrestricted')
      && trackedBeforeThrow
      && afterThrow.available === false
      && !throwingServer.settingsNamespaceTracked('unrestricted'),
    JSON.stringify({
      removal: {
        before: trackedBefore,
        after: server.settingsNamespaceTracked('unrestricted'),
        available: afterRemoval.available,
      },
      throwing: {
        before: trackedBeforeThrow,
        after: throwingServer.settingsNamespaceTracked('unrestricted'),
        available: afterThrow.available,
      },
    }),
  );
}

// ===== 2. no display metadata: no title, not a crash =====================
{
  const fake = settingsService(candidateRows());
  const server = makeServer({ settings: fake.service, configEditor: configEditor() });
  const out = await server.handleRequest('paseo/settings/list', {});
  check(
    'a profile with no loader/inventory still lists toggles, without titles',
    out.available === true
      && out.items[0]?.ns === 'unrestricted'
      && out.items[0]?.title === undefined
      && out.items[0]?.moduleName === 'dsh-unrestricted',
    JSON.stringify({ title: out.items[0]?.title, moduleName: out.items[0]?.moduleName }),
  );
}

// ===== 2b. real inventory shape: include: prefix + language dictionary =====
{
  const fake = settingsService(candidateRows());
  const server = makeServer({
    settings: fake.service,
    configEditor: configEditor(),
    // Exactly what the real daemon returns for a plugin mounted through an
    // Include: a prefixed entry id and a localized title dictionary.
    ...inventory([
      {
        entryId: 'include:unrestricted',
        moduleName: 'dsh-unrestricted',
        title: { en: 'Unrestricted mode', zh: '破限模式' },
      },
    ]),
  });
  const out = await server.handleRequest('paseo/settings/list', {});
  check(
    'an include:-prefixed entry supplies its title dictionary to the row',
    JSON.stringify(out.items[0]?.title) === JSON.stringify({ en: 'Unrestricted mode', zh: '破限模式' }),
    JSON.stringify(out.items[0]?.title),
  );
  check(
    '…and the bridge does not resolve the language itself (no mixed-language menu)',
    // The dictionary keeps every language; nothing was flattened to a string.
    typeof out.items[0]?.title === 'object' && Object.keys(out.items[0].title).length === 2,
    JSON.stringify(out.items[0]?.title),
  );
}

// ===== 3. no settings service: empty, not an error ========================
{
  const server = makeServer({ configEditor: configEditor() });
  const out = await server.handleRequest('paseo/settings/list', {});
  check(
    'a profile with no settings service answers {available:false, items:[]} with a reason',
    out.available === false
      && Array.isArray(out.items)
      && out.items.length === 0
      && typeof out.reason === 'string'
      && /no settings service/.test(out.reason),
    JSON.stringify(out),
  );
  const write = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['enabled'],
    value: true,
    revision: 7,
  });
  check(
    'a write against a profile with no settings service is settings_unavailable',
    write.ok === false && write.error.code === 'settings_unavailable',
    JSON.stringify(write),
  );
}

// ===== 4. a write carries the revision and re-reads the committed value ===
{
  const rows = candidateRows();
  const fake = settingsService(rows);
  const server = makeServer({
    settings: fake.service,
    configEditor: configEditor(),
    ...inventory([
      { entryId: 'unrestricted', moduleName: 'dsh-unrestricted', title: { en: 'Unrestricted mode', zh: '破限模式' } },
    ]),
  });
  await server.handleRequest('paseo/settings/list', {});
  const out = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['enabled'],
    value: true,
    revision: 7,
  });
  check(
    'the write reaches settings.mutate with the exact ns, op path and revision',
    fake.calls.mutate.length === 1
      && fake.calls.mutate[0].ns === 'unrestricted'
      && JSON.stringify(fake.calls.mutate[0].ops) === JSON.stringify([{ op: 'set', path: ['enabled'], value: true }])
      && fake.calls.mutate[0].expectedRevision === 7,
    JSON.stringify(fake.calls.mutate),
  );
  check(
    'the answer carries the re-read value and the bumped revision',
    out.ok === true && out.field.value === true && out.field.revision === 8,
    JSON.stringify(out),
  );
  check(
    'the underlying row was actually written',
    rows.find((entry) => entry.ns === 'unrestricted')?.value.enabled === true,
    JSON.stringify(rows.find((entry) => entry.ns === 'unrestricted')?.value),
  );
}

// ===== 4b. expectedValue is the value-layer precondition ==================
{
  const rows = candidateRows();
  const fake = settingsService(rows);
  const server = makeServer({ settings: fake.service, configEditor: configEditor() });
  await server.handleRequest('paseo/settings/list', {});

  const mismatch = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['enabled'],
    value: true,
    revision: 7,
    expectedValue: true, // runtime is false; the composer's value is stale
  });
  check(
    'a stale expectedValue is conflict even when the revision still matches',
    mismatch.ok === false && mismatch.error.code === 'conflict' && /changed since it was read/.test(mismatch.error.message),
    JSON.stringify(mismatch),
  );
  check(
    '…and the mismatch never reaches settings.mutate',
    fake.calls.mutate.length === 0,
    `${String(fake.calls.mutate.length)} mutate call(s)`,
  );

  const match = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['enabled'],
    value: true,
    revision: 7,
    expectedValue: false,
  });
  check(
    'a matching expectedValue writes normally',
    match.ok === true && match.field.value === true && fake.calls.mutate.length === 1,
    JSON.stringify({ answer: match, mutates: fake.calls.mutate.length }),
  );

  const invalid = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['enabled'],
    value: false,
    revision: 8,
    expectedValue: 'false',
  });
  check(
    'a non-boolean expectedValue is invalid_request',
    invalid.ok === false && invalid.error.code === 'invalid_request',
    JSON.stringify(invalid),
  );

  // The legacy shape (no expectedValue) keeps the revision precondition.
  const legacy = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['enabled'],
    value: false,
    revision: 8,
  });
  check(
    'an absent expectedValue still writes through the revision check (old plugin)',
    legacy.ok === true && legacy.field.value === false && fake.calls.mutate.length === 2,
    JSON.stringify({ answer: legacy, mutates: fake.calls.mutate.length }),
  );
}

// ===== 5. stale revision is a conflict, not a generic failure =============
{
  const fake = settingsService(candidateRows());
  const server = makeServer({ settings: fake.service, configEditor: configEditor() });
  await server.handleRequest('paseo/settings/list', {});
  const out = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['enabled'],
    value: true,
    revision: 1,
  });
  check(
    'a stale revision is reported as conflict (the plugin words it differently)',
    out.ok === false && out.error.code === 'conflict' && /conflict/i.test(out.error.message),
    JSON.stringify(out),
  );
}

// ===== 6. unknown / unexposed namespaces are not_found ====================
{
  const fake = settingsService(candidateRows());
  const server = makeServer({ settings: fake.service, configEditor: configEditor() });
  await server.handleRequest('paseo/settings/list', {});
  const official = await server.handleRequest('paseo/settings/set', {
    ns: 'web',
    path: ['enabled'],
    value: true,
    revision: 4,
  });
  check(
    'an official namespace cannot be written through this surface',
    official.ok === false && official.error.code === 'not_found',
    JSON.stringify(official),
  );
  const unknownPath = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['other'],
    value: true,
    revision: 7,
  });
  check(
    'a path other than the exposed field is not_found',
    unknownPath.ok === false && unknownPath.error.code === 'not_found',
    JSON.stringify(unknownPath),
  );
}

// ===== 7. malformed writes are invalid_request ============================
{
  const fake = settingsService(candidateRows());
  const server = makeServer({ settings: fake.service, configEditor: configEditor() });
  await server.handleRequest('paseo/settings/list', {});
  const nonBoolean = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['enabled'],
    value: 'true',
    revision: 7,
  });
  const noRevision = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['enabled'],
    value: true,
  });
  check(
    'a non-boolean value is invalid_request',
    nonBoolean.ok === false && nonBoolean.error.code === 'invalid_request',
    JSON.stringify(nonBoolean),
  );
  check(
    'a missing revision is invalid_request',
    noRevision.ok === false && noRevision.error.code === 'invalid_request',
    JSON.stringify(noRevision),
  );
  const nanRevision = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['enabled'],
    value: true,
    revision: Number.NaN,
  });
  const floatRevision = await server.handleRequest('paseo/settings/set', {
    ns: 'unrestricted',
    path: ['enabled'],
    value: true,
    revision: 1.5,
  });
  check(
    'a NaN revision is invalid_request (typeof number alone would let it through)',
    nanRevision.ok === false && nanRevision.error.code === 'invalid_request',
    JSON.stringify(nanRevision),
  );
  check(
    'a fractional revision is invalid_request (the wire revision is an integer)',
    floatRevision.ok === false && floatRevision.error.code === 'invalid_request',
    JSON.stringify(floatRevision),
  );
  check(
    'no malformed write reached the service',
    fake.calls.mutate.length === 0,
    `${String(fake.calls.mutate.length)} mutate call(s)`,
  );
}

// ===== 8. pure functions: edge shapes and selection ======================
{
  const { isThirdPartyModule, isPackageSpecifier, pluginTitleDictionary, simpleToggleField, formFieldValue } = discovery;
  check(
    'isThirdPartyModule excludes the official scope, cordis: specifiers, paths and empty names',
    isThirdPartyModule('dsh-unrestricted')
      && !isThirdPartyModule('@deepseek-ai/dsh-web')
      && !isThirdPartyModule('cordis:group')
      && !isThirdPartyModule('node:fs')
      && !isThirdPartyModule('./local-plugin.js')
      && !isThirdPartyModule('/abs/plugin.js')
      && !isThirdPartyModule('')
      && !isThirdPartyModule(undefined),
    JSON.stringify([
      isThirdPartyModule('dsh-unrestricted'),
      isThirdPartyModule('@deepseek-ai/dsh-web'),
      isThirdPartyModule('cordis:group'),
      isThirdPartyModule('./local-plugin.js'),
    ]),
  );
  check(
    'isPackageSpecifier accepts package names and subpaths, rejects runtime/path specifiers',
    isPackageSpecifier('dsh-unrestricted')
      && isPackageSpecifier('@scope/name')
      && isPackageSpecifier('@deepseek-ai/dsh-tool-subagent/model-selection-settings')
      && !isPackageSpecifier('cordis:group')
      && !isPackageSpecifier('../x.js')
      && !isPackageSpecifier(''),
    JSON.stringify([
      isPackageSpecifier('dsh-unrestricted'),
      isPackageSpecifier('cordis:group'),
      isPackageSpecifier('../x.js'),
    ]),
  );
  check(
    'pluginTitleDictionary normalizes strings to {en} and drops unusable entries',
    JSON.stringify(pluginTitleDictionary({ en: 'Unrestricted mode', zh: '破限模式' })) === JSON.stringify({ en: 'Unrestricted mode', zh: '破限模式' })
      && JSON.stringify(pluginTitleDictionary('Plain title')) === JSON.stringify({ en: 'Plain title' })
      && JSON.stringify(pluginTitleDictionary({ en: '  ', zh: '破限模式' })) === JSON.stringify({ zh: '破限模式' })
      && pluginTitleDictionary({}) === undefined
      && pluginTitleDictionary(undefined) === undefined
      && pluginTitleDictionary(['a']) === undefined,
    JSON.stringify([
      pluginTitleDictionary({ en: 'Unrestricted mode', zh: '破限模式' }),
      pluginTitleDictionary('Plain title'),
      pluginTitleDictionary({}),
    ]),
  );
  check(
    'simpleToggleField accepts a live rehydrated node and plain JSON alike',
    simpleToggleField(new Schema(BOOLEAN_FORM))?.path.join('.') === 'enabled'
      && simpleToggleField(PLAIN_BOOLEAN_FORM)?.path.join('.') === 'enabled',
    JSON.stringify([
      simpleToggleField(new Schema(BOOLEAN_FORM)),
      simpleToggleField(PLAIN_BOOLEAN_FORM),
    ]),
  );
  check(
    '…and rejects the raw wire document (rehydration belongs to the bridge, not this module)',
    simpleToggleField(BOOLEAN_FORM) === undefined,
    JSON.stringify(simpleToggleField(BOOLEAN_FORM)),
  );
  check(
    'simpleToggleField rejects multi-field, non-boolean, dict and bare-boolean forms',
    simpleToggleField(new Schema(TWO_FIELD_FORM)) === undefined
      && simpleToggleField(new Schema(STRING_FORM)) === undefined
      && simpleToggleField(new Schema(DICT_FORM)) === undefined
      && simpleToggleField({ type: 'boolean' }) === undefined
      && simpleToggleField(undefined) === undefined,
    JSON.stringify([
      simpleToggleField(new Schema(TWO_FIELD_FORM)),
      simpleToggleField({ type: 'boolean' }),
    ]),
  );
  check(
    'simpleToggleField returns only the path (the dead description read was removed)',
    JSON.stringify(Object.keys(simpleToggleField(new Schema(BOOLEAN_FORM)) ?? {})) === JSON.stringify(['path']),
    JSON.stringify(simpleToggleField(new Schema(BOOLEAN_FORM))),
  );
  check(
    'formFieldValue reads the projected value and tolerates missing paths',
    formFieldValue({ enabled: true }, ['enabled']) === true
      && formFieldValue({}, ['enabled']) === undefined
      && formFieldValue(undefined, ['enabled']) === undefined,
    JSON.stringify([formFieldValue({ enabled: true }, ['enabled']), formFieldValue({}, ['enabled'])]),
  );
  check(
    'inventoryEntryMatchesNamespace accepts an exact id or the include: tail',
    discovery.inventoryEntryMatchesNamespace('unrestricted', 'unrestricted')
      && discovery.inventoryEntryMatchesNamespace('include:unrestricted', 'unrestricted')
      && !discovery.inventoryEntryMatchesNamespace('include:other', 'unrestricted')
      && !discovery.inventoryEntryMatchesNamespace('unrestricted', 'include:unrestricted')
      && !discovery.inventoryEntryMatchesNamespace('', 'unrestricted'),
    JSON.stringify([
      discovery.inventoryEntryMatchesNamespace('include:unrestricted', 'unrestricted'),
      discovery.inventoryEntryMatchesNamespace('include:other', 'unrestricted'),
    ]),
  );
  // The production projection is the only filter; drive it directly for the
  // row-level cases (revision, title presence) the server cases cannot isolate.
  const projected = discovery.simpleToggleItems({
    descriptors: [
      { ns: 'third', schema: new Schema(BOOLEAN_FORM), value: { enabled: true }, revision: 0 },
      { ns: 'bad-rev', schema: new Schema(BOOLEAN_FORM), value: { enabled: true }, revision: 2.5 },
    ],
    moduleNameOf: (ns) => (ns === 'third' || ns === 'bad-rev' ? 'x-third' : undefined),
    titleOf: () => ({ en: 'X third', zh: '第三方' }),
  });
  check(
    'simpleToggleItems keeps revision 0 (a valid wire revision) and drops non-integers',
    JSON.stringify(projected.map((item) => item.ns)) === JSON.stringify(['third'])
      && projected[0]?.field.revision === 0,
    JSON.stringify(projected),
  );
  check(
    'simpleToggleItems carries the raw title dictionary, not a localized string',
    JSON.stringify(projected[0]?.title) === JSON.stringify({ en: 'X third', zh: '第三方' }),
    JSON.stringify(projected[0]?.title),
  );
}

// ===== 8b. the settings service API the handlers rely on =================
//
// The fake service above cannot notice an upstream rename: it implements the
// shape this bridge expects. This is the drift guard the repository's contract
// check cannot provide (it only sees static imports, and `ctx.get('settings')`
// is a service lookup).
{
  let service;
  try {
    service = await import('@deepseek-ai/dsh-settings');
  } catch (error) {
    service = undefined;
    check(
      'the dsh-settings package is loadable (the service the bridge drives)',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (service !== undefined) {
    const forms = service.SettingsForms;
    check(
      'SettingsForms still exposes describe/mutate/update/replace (the bridge calls describe+mutate)',
      typeof forms === 'function'
        && typeof forms.prototype.describe === 'function'
        && typeof forms.prototype.mutate === 'function'
        && typeof forms.prototype.update === 'function'
        && typeof forms.prototype.replace === 'function',
      JSON.stringify({
        SettingsForms: typeof forms,
        describe: typeof forms?.prototype?.describe,
        mutate: typeof forms?.prototype?.mutate,
      }),
    );
    check(
      'the service still throws SettingsConflictError (the bridge maps its stable SETTINGS_CONFLICT code)',
      typeof service.SettingsConflictError === 'function',
      typeof service.SettingsConflictError,
    );
  }
}

// ===== 9. dispatch: every case names a real method =======================
{
  const source = readFileSync(join(bridgeRoot, 'server.js'), 'utf8');
  const cases = [...source.matchAll(/case '([^']+)':\s*\n\s*return this\.(\w+)\(/g)].map((match) => ({
    method: match[1],
    handler: match[2],
  }));
  const server = makeServer({});
  const missing = cases.filter((entry) => typeof server[entry.handler] !== 'function');
  check(
    'every handleRequest case names a method that exists on the server',
    cases.length > 20 && missing.length === 0,
    missing.length === 0 ? `${String(cases.length)} cases` : JSON.stringify(missing),
  );
  check(
    'paseo/settings/list and paseo/settings/set are dispatched',
    cases.some((entry) => entry.method === 'paseo/settings/list')
      && cases.some((entry) => entry.method === 'paseo/settings/set'),
    JSON.stringify(cases.filter((entry) => entry.method.startsWith('paseo/settings')).map((entry) => entry.method)),
  );
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
if (failed.length > 0) {
  console.error(`\n${String(failed.length)} FAILED:`);
  for (const result of failed) console.error(`  - ${result.name}`);
  process.exit(1);
}
