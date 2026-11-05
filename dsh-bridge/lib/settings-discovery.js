/**
 * Project DSH's runtime settings forms into the one shape Paseo's composer can
 * show without inventing a protocol: a single boolean toggle per plugin.
 *
 * DSH's `settings.describe()` reports every *active* plugin entry whose Config
 * schema declares at least one `.volatile()` node, as a projected form
 * (`{ns, schema, value, revision, …}`). That surface is far too wide for a
 * composer menu: the local profile alone exposes ~21 namespaces / ~87 fields,
 * most of them deployment internals (model routes, secret API keys, dict-shaped
 * provider trees) and one third-party memory plugin with 37 fields.
 *
 * The scope chosen by the user is deliberately narrow and mechanical:
 *
 * - **Third-party only** — the entry's module specifier does not start with
 *   `@deepseek-ai/` and is a real package specifier. `cordis:*`-style runtime
 *   specifiers and relative paths have no package locale and are not user
 *   plugins, so they are excluded too.
 * - **Exactly one field, and that field is a boolean** — the whole volatile form
 *   must project to `{<key>: boolean}`. Anything else (dicts, enums, numbers,
 *   multi-field forms) is not a "simple switch" and stays out of the menu.
 *
 * Everything here is pure: no ctx, no services, no I/O. `server.js` supplies the
 * descriptors and the entry/title lookups; `harness/settings-bridge-check.mjs`
 * and `harness/settings-passthrough-check.cjs` exercise the same functions the
 * production path uses, so a filter bug cannot pass by being re-implemented in
 * the test.
 *
 * ## Display titles are dictionaries, not strings
 *
 * DSH's plugin inventory reads each package's `locale/*.json` dictionaries and
 * reports `meta.title` as a language map (`{en: "Unrestricted mode", zh:
 * "破限模式"}`). The bridge passes that map through untouched: language is a
 * *display* concern, and this process is the wrong place to decide it. The
 * bridge's own environment is merged when the first session opens, so it can
 * differ from the plugin host's; resolving here would let one menu mix Chinese
 * and English labels. The plugin resolves it with the same `LOCALE` it uses for
 * every other composer string (`paseo-plugin/server/session.ts`).
 *
 * ## Wire format (why `server.js` rehydrates)
 *
 * `describe()` serializes each form with schemastery's `toJSON()`, which emits a
 * **reference document** — `{uid: <number>, refs: {"<uid>": {type, meta, dict:
 * {"<field>": <uid>}, …}}}` — not a plain `{type, dict}` tree. The first version
 * of this module read the plain shape off the wire object, so `.type` was
 * undefined and every real profile produced zero toggles (silent no-op, not an
 * error). `server.js` now rebuilds the live node with `new Schema(row.schema)`
 * exactly like DSH's own settings UI does, and this module reads live nodes and
 * plain JSON through the same property accessors. Passing the raw `{uid, refs}`
 * document here still yields nothing: rehydration belongs to the caller that
 * owns the schema library, which keeps this module dependency-free.
 *
 * @module dsh-paseo-bridge/settings-discovery
 */

/** Module-specifier prefix owned by the DSH distribution itself. */
export const OFFICIAL_MODULE_PREFIX = '@deepseek-ai/';

/**
 * Whether a configured module specifier names a real package.
 *
 * `entry.options.name` is whatever the profile patch wrote: normally a package
 * name (`dsh-unrestricted`, `@scope/name`) or a package subpath, but the Loader
 * also accepts runtime/relative specifiers (`cordis:group`, `node:fs`,
 * `./local-plugin.js`). Those have no package locale and are not user-installed
 * plugins, so they are not candidates for a composer row.
 *
 * npm package names cannot contain `:`, so a colon is a reliable marker for a
 * protocol-prefixed specifier. Leading `.` or `/` marks a path specifier.
 *
 * @param moduleName - the entry's configured module specifier.
 * @returns true when the specifier names a package.
 */
export function isPackageSpecifier(moduleName) {
  if (typeof moduleName !== 'string') return false;
  const specifier = moduleName.trim();
  if (specifier === '') return false;
  if (specifier.includes(':')) return false;
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  return true;
}

/**
 * Whether an entry's module specifier is a third-party plugin.
 *
 * Anything outside the official scope is third-party by this repository's
 * definition; a missing name cannot be classified, so it is excluded rather
 * than guessed at.
 *
 * @param moduleName - the entry's configured module specifier.
 * @returns true when the entry is third-party.
 */
export function isThirdPartyModule(moduleName) {
  return (
    isPackageSpecifier(moduleName)
    && !moduleName.trim().startsWith(OFFICIAL_MODULE_PREFIX)
  );
}

/**
 * Normalize an inventory title into the language dictionary the plugin picks
 * from, or undefined when there is nothing usable.
 *
 * `meta.title` from DSH is already a dictionary. A plain string (older plugin
 * metadata, fixtures) is normalized to `{en: <string>}` so the plugin only ever
 * handles one shape. Entries are trimmed and non-string values dropped.
 *
 * @param title - `meta.title` from one inventory entry.
 * @returns `{<lang>: string}` with at least one non-empty value, or undefined.
 */
export function pluginTitleDictionary(title) {
  const usable = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
  if (typeof title === 'string') {
    const value = usable(title);
    return value === undefined ? undefined : { en: value };
  }
  if (title === null || typeof title !== 'object' || Array.isArray(title)) return undefined;
  const dictionary = {};
  for (const [language, value] of Object.entries(title)) {
    const text = usable(value);
    if (text !== undefined) dictionary[language] = text;
  }
  return Object.keys(dictionary).length === 0 ? undefined : dictionary;
}

/**
 * Match one inventory entry id to a settings namespace.
 *
 * The loader prefixes entries that come from an `include:` row
 * (`include:unrestricted` for a plugin mounted through an Include), while the
 * settings namespace is the configured entry id (`unrestricted`). Accept an
 * exact match or a match of the id's last `:`-separated segment; the first is
 * preferred so an id that genuinely contains a colon still wins over a
 * coincidental tail.
 *
 * @param entryId - `pluginInventory.list()` entry id.
 * @param ns - the settings namespace (profile entry id).
 * @returns true when this entry supplies the namespace's title.
 */
export function inventoryEntryMatchesNamespace(entryId, ns) {
  if (typeof entryId !== 'string' || entryId === '') return false;
  if (typeof ns !== 'string' || ns === '') return false;
  if (entryId === ns) return true;
  const segments = entryId.split(':');
  return segments.length > 1 && segments[segments.length - 1] === ns;
}

/**
 * The single boolean field a volatile form projects to, or undefined.
 *
 * Accepts **both** shapes this bridge may hold:
 *
 * - a **live schemastery node**, which is what `server.js` passes after
 *   rehydrating the wire schema with `new Schema(row.schema)` — nodes are
 *   functions carrying `.type` / `.dict` / `.meta` accessors, and nested fields
 *   are live nodes too (`typeof field === "function"`, not `"object"`);
 * - **plain JSON** (`{type: "object", dict: {<field>: {type, meta}}}`), which is
 *   what the offline fixtures use and what a future bridge could pass if DSH
 *   ever emits plain forms.
 *
 * Reading properties uniformly (never `typeof x === "object"`) is what makes
 * both work: the first implementation required plain objects, so on a real
 * runtime — where the wire schema is `{uid, refs}` and even a rehydrated field
 * is a function — it returned undefined for every entry and the menu was empty.
 *
 * A whole-schema `.volatile()` on a bare boolean (form type `boolean`, no
 * `dict`) has no field path a Paseo toggle could name, so it is not selected.
 *
 * The schema's own `meta.description` is deliberately **not** carried: the
 * composer row's description is the provider's generic "global switch" copy
 * (`locale.ts`), which must be identical for every plugin and must not depend on
 * a plugin's localization. The previous implementation read a non-existent
 * `field.description` and never used it — removed rather than kept as dead code.
 *
 * @param formSchema - live schemastery node or plain form JSON.
 * @returns `{path}` for the single boolean field, or undefined.
 */
export function simpleToggleField(formSchema) {
  const isNode = (value) =>
    value !== null && (typeof value === 'object' || typeof value === 'function');
  if (!isNode(formSchema)) return undefined;
  if (formSchema.type !== 'object') return undefined;
  const dict = formSchema.dict;
  if (!isNode(dict)) return undefined;
  const keys = Object.keys(dict);
  if (keys.length !== 1) return undefined;
  const key = keys[0];
  const field = dict[key];
  if (!isNode(field) || field.type !== 'boolean') return undefined;
  return { path: [key] };
}

/**
 * Read one projected form value by path.
 *
 * @param value - the row's `value` (already projected to volatile fields only).
 * @param path - field path from {@link simpleToggleField}.
 * @returns the value, or undefined when the projection omitted it.
 */
export function formFieldValue(value, path) {
  let node = value;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

/**
 * Select the simple third-party toggles out of `settings.describe()` output.
 *
 * Rows are returned in describe() order (Loader order), which keeps the menu
 * stable across sessions. A row whose projected value is not a boolean is
 * skipped rather than defaulted: `describe()` omits an unset field from
 * `value`, and inventing `false` would show a switch state the runtime never
 * committed. A row whose revision is not a non-negative integer is skipped too:
 * the revision is the write precondition, and a made-up 0 would let a stale
 * click overwrite another writer's value.
 *
 * @param options - descriptors plus the per-namespace lookups.
 * @param options.descriptors - rows from `settings.describe({redactSecrets:true})`.
 * @param options.moduleNameOf - `ns` -> configured module specifier.
 * @param options.titleOf - `ns` -> inventory title (language dictionary), optional.
 * @returns items `{ns, moduleName, title?, field:{path, value, revision}}`.
 */
export function simpleToggleItems({ descriptors, moduleNameOf, titleOf } = {}) {
  if (!Array.isArray(descriptors)) return [];
  const items = [];
  for (const row of descriptors) {
    if (row === null || typeof row !== 'object') continue;
    const ns = typeof row.ns === 'string' ? row.ns : undefined;
    if (ns === undefined || ns === '') continue;
    const moduleName = typeof moduleNameOf === 'function' ? moduleNameOf(ns) : undefined;
    if (!isThirdPartyModule(moduleName)) continue;
    const toggle = simpleToggleField(row.schema);
    if (toggle === undefined) continue;
    const value = formFieldValue(row.value, toggle.path);
    if (typeof value !== 'boolean') continue;
    if (!Number.isInteger(row.revision) || row.revision < 0) continue;
    const title = pluginTitleDictionary(typeof titleOf === 'function' ? titleOf(ns) : undefined);
    items.push({
      ns,
      moduleName,
      ...(title === undefined ? {} : { title }),
      field: {
        path: toggle.path,
        value,
        revision: row.revision,
      },
    });
  }
  return items;
}
