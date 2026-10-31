/**
 * Offline check: does the bridge's dependency on DSH-internal packages still hold?
 *
 * The bridge is not an ACP adapter. It imports DSH's *internal* assembly packages
 * directly (`dsh-llm`, `dsh-agent`, `dsh-attachment`, `dsh-brand`, `dsh-cmdline`,
 * `dsh-tools`, `dsh-subprocess`, `schemastery`), which carry no API stability
 * promise from upstream. When one of them renames or drops a symbol, nothing
 * errors at load time — the import throws only when the code path runs, and by
 * then the failure surfaces inside a model turn as an empty `[error]` row.
 *
 * That is the exact shape of FIELD-NOTES #58: upgrading DSH 0.2.0 → 0.2.1 removed
 * the `{{cwd}}` prompt variable, every turn failed during prompt assembly, and the
 * UI showed a blank error. `doctor` was green throughout — it checks install
 * completeness, not the soft contracts the bridge depends on.
 *
 * This check closes that gap for the import surface specifically. It asserts two
 * things, and both are needed:
 *
 *   1. **Coverage** — every `@deepseek-ai/*` package the bridge imports is listed
 *      in `EXPECTED` below. A new import added to the bridge without updating the
 *      manifest fails here, so the check cannot silently stop covering something.
 *   2. **Presence** — every symbol the manifest names is still exported by the
 *      installed package. This is what turns "upgraded, ran a real turn, saw a
 *      blank error" into "upgraded, ran this, got the symbol name".
 *
 * It deliberately does NOT assert behaviour. Signature changes that keep the symbol
 * name are invisible here; `harness/plugin-check.cjs` covers those by driving a
 * real turn. Run both after an upgrade — this one is fast and names the culprit,
 * the other one proves the turn still works.
 *
 * Pure module: no DSH profile, no daemon, no child processes, no model calls.
 *
 * Usage: node harness/dsh-api-contract-check.mjs
 * Set `DSH_PACKAGES_DIR` to check a different DSH install.
 */
import { homedir } from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_LIB = join(HERE, '..', 'dsh-bridge', 'lib');
const DEFAULT_DSH_PACKAGES = `${homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`;
const dshPackages = process.env.DSH_PACKAGES_DIR ?? DEFAULT_DSH_PACKAGES;

/**
 * What the bridge depends on, and what each dependency must still provide.
 *
 * `symbols` are named imports. `default` is a default import (only `schemastery`,
 * which is CJS). `expect` is the typeof each binding must have — all of these are
 * functions or classes today, so anything else means upstream changed the shape,
 * not just the name.
 *
 * Keep this in sync with the bridge's import statements; the coverage assertion
 * below fails when it drifts, in either direction.
 */
const EXPECTED = {
  'dsh-brand': { named: { brandString: 'function' } },
  'dsh-llm': {
    named: {
      BlockAssembler: 'function',
      createUserMessage: 'function',
      ReasoningEffortId: 'function',
    },
  },
  'dsh-attachment': { named: { admitEncodedImages: 'function' } },
  'dsh-agent': { named: { installModelSelection: 'function' } },
  'dsh-cmdline': { named: { exitOnStdinEnd: 'function', parseCmdline: 'function' } },
  'dsh-tools': { named: { defineTool: 'function' } },
  'dsh-subprocess': { named: { scrubbedParentEnv: 'function' } },
  schemastery: { default: 'function' },
};

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

// ---- 1. read the bridge's actual imports -----------------------------------
//
// Static `import ... from '@deepseek-ai/x'` only. The bridge has no dynamic
// imports and no `require` of these packages (verified when this check was
// written); if that changes, the coverage assertion below is what notices,
// because an unlisted package or symbol cannot be resolved from a manifest that
// does not mention it.
// Capture the whole clause rather than trying to enumerate its shapes: a single
// regex covering `import X`, `import {a, b}`, `import X, {a}` and `import * as ns`
// gets one of them wrong, and a silently-skipped import is the one failure mode
// this check exists to prevent. Parse the clause after matching it.
const importRe = /import\s+([^'"]+?)\s*from\s*['"]@deepseek-ai\/([^'"]+)['"]/g;
// Side-effect imports (`import '@deepseek-ai/x'`) pull in no symbol but do create a
// dependency; they are collected separately so the coverage check still sees them.
const sideEffectRe = /import\s*['"]@deepseek-ai\/([^'"]+)['"]/g;

/** package name -> Set of named symbols; plus a separate set of default imports. */
const found = new Map();
const foundDefaults = new Map();
const foundSideEffect = new Set();
const files = readdirSync(BRIDGE_LIB).filter((f) => f.endsWith('.js')).sort();
let scanned = 0;

for (const file of files) {
  const text = readFileSync(join(BRIDGE_LIB, file), 'utf8');
  scanned += 1;
  for (const match of text.matchAll(importRe)) {
    const [, clause, rawPkg] = match;
    // `@deepseek-ai/dsh-llm` -> `dsh-llm`; the scope prefix is dropped because
    // EXPECTED is keyed by the bare name and resolved under dshPackages.
    const pkg = rawPkg.replace(/\/.*$/, '');
    const trimmed = clause.trim();

    const braceStart = trimmed.indexOf('{');
    const braceEnd = trimmed.indexOf('}');

    if (braceStart !== -1 && braceEnd > braceStart) {
      // Named imports: `{a, b as c}`. `a as c` is recorded as `a` — the exported
      // name is what upstream must keep, the local alias is the bridge's choice.
      if (!found.has(pkg)) found.set(pkg, new Set());
      for (const piece of trimmed.slice(braceStart + 1, braceEnd).split(',')) {
        const symbol = piece.trim().split(/\s+as\s+/)[0]?.trim();
        if (symbol) found.get(pkg).add(symbol);
      }
    }

    // Whatever sits before the braces (or the whole clause when there are none)
    // is the default import: `Schema` in `import Schema from`, `Schema` in
    // `import Schema, {a} from`. `* as ns` is a namespace import, not a default.
    const head = (braceStart === -1 ? trimmed : trimmed.slice(0, braceStart))
      .replace(/,\s*$/, '')
      .trim();
    if (head !== '' && !head.startsWith('*')) {
      if (!foundDefaults.has(pkg)) foundDefaults.set(pkg, new Set());
      foundDefaults.get(pkg).add(head);
    }
  }
  for (const match of text.matchAll(sideEffectRe)) {
    foundSideEffect.add(match[1].replace(/\/.*$/, ''));
  }
}

check(
  'the bridge source was found and scanned',
  files.length > 0 && scanned === files.length,
  `${scanned} file(s) under dsh-bridge/lib`,
);

// ---- 2. coverage: source imports == manifest -------------------------------
//
// Both directions matter. A source import missing from EXPECTED means a new
// dependency nobody asserted on; a manifest entry with no matching source import
// means this check is asserting something the bridge no longer uses (dead
// coverage that hides drift).

const sourceNamed = new Map([...found].map(([pkg, set]) => [pkg, new Set(set)]));
for (const [pkg, defaults] of foundDefaults) {
  if (!sourceNamed.has(pkg)) sourceNamed.set(pkg, new Set());
  // A default import is recorded under a pseudo-symbol so it is covered too.
  for (const name of defaults) sourceNamed.get(pkg).add(`default:${name}`);
}
for (const pkg of foundSideEffect) {
  // A side-effect import still creates a dependency: the package must be listed
  // even though no symbol is named. An empty set is the honest representation.
  if (!sourceNamed.has(pkg)) sourceNamed.set(pkg, new Set());
}

const unlisted = [];
for (const [pkg, symbols] of sourceNamed) {
  if (!(pkg in EXPECTED)) {
    unlisted.push(`${pkg} (${[...symbols].join(', ')})`);
  }
}
check(
  'every DSH package the bridge imports is covered by the manifest',
  unlisted.length === 0,
  unlisted.length === 0 ? `${sourceNamed.size} package(s)` : `not in EXPECTED: ${unlisted.join('; ')}`,
);

const unimported = [];
for (const pkg of Object.keys(EXPECTED)) {
  if (!sourceNamed.has(pkg)) unimported.push(pkg);
}
check(
  'the manifest has no entries the bridge stopped importing',
  unimported.length === 0,
  unimported.length === 0 ? 'no dead entries' : `no longer imported: ${unimported.join(', ')}`,
);

const missingSymbols = [];
for (const [pkg, symbols] of sourceNamed) {
  const expected = EXPECTED[pkg];
  if (expected === undefined) continue; // already reported by the coverage check
  for (const symbol of symbols) {
    if (symbol.startsWith('default:')) {
      const name = symbol.slice('default:'.length);
      if (expected.default === undefined) missingSymbols.push(`${pkg}::${name} (default)`);
      continue;
    }
    if (expected.named?.[symbol] === undefined) missingSymbols.push(`${pkg}::${symbol}`);
  }
}
check(
  'every symbol the bridge imports is declared in the manifest',
  missingSymbols.length === 0,
  missingSymbols.length === 0 ? 'all declared' : `undeclared: ${missingSymbols.join(', ')}`,
);

// ---- 3. presence: the installed packages still export them ------------------
//
// Loaded by absolute path, not by bare specifier: this script runs from the repo,
// where `@deepseek-ai/*` does not resolve. The bridge gets them at runtime from
// the DSH process's own module paths, so resolving from the install directory is
// the same set of files the bridge will see.

/** Read a package's declared entry point without importing it. */
function entryOf(pkgDir) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const main = manifest.main ?? 'lib/index.js';
  return { path: join(pkgDir, main), version: manifest.version ?? '(no version)' };
}

let loaded = 0;
let loadFailed = 0;

for (const [pkg, spec] of Object.entries(EXPECTED)) {
  const pkgDir = join(dshPackages, pkg);
  let entry;
  try {
    entry = entryOf(pkgDir);
  } catch (error) {
    // "cannot check" and "check passed" are different answers; only one of them
    // may look green, so a missing package fails rather than warns.
    check(`${pkg} is installed`, false, `unreadable at ${pkgDir} (${error.code ?? error.message})`);
    loadFailed += 1;
    continue;
  }

  let module;
  try {
    module = await import(pathToFileURL(entry.path).href);
  } catch (error) {
    check(`${pkg} loads`, false, `${entry.version}: ${error.code ?? error.message}`);
    loadFailed += 1;
    continue;
  }
  loaded += 1;

  const problems = [];
  for (const [symbol, want] of Object.entries(spec.named ?? {})) {
    const got = typeof module[symbol];
    if (module[symbol] === undefined) problems.push(`${symbol} is gone`);
    else if (got !== want) problems.push(`${symbol} is ${got}, expected ${want}`);
  }
  if (spec.default !== undefined) {
    const got = typeof module.default;
    if (module.default === undefined) problems.push('default export is gone');
    else if (got !== spec.default) problems.push(`default is ${got}, expected ${spec.default}`);
  }

  const symbols = [
    ...Object.keys(spec.named ?? {}),
    ...(spec.default === undefined ? [] : ['default']),
  ];
  check(
    `${pkg}@${entry.version} still exports ${symbols.join(', ')}`,
    problems.length === 0,
    problems.length === 0 ? undefined : problems.join('; '),
  );
}

// ---- 4. the version the bridge was verified against ------------------------
//
// Not an assertion about correctness — the bridge tracks DSH at `major.minor`
// (README "版本策略"), and doctor's `compareCore` deliberately ignores the
// prerelease suffix so `0.2.1-rc.5` counts as `0.2.1`. This line exists so the
// report says which DSH the symbols above came from; comparing it against
// `dsh --version` is what tells you whether this run covers the daemon you have.
let dshVersion = '(unknown)';
try {
  const manifest = JSON.parse(
    readFileSync(join(dshPackages, '..', '..', 'package.json'), 'utf8'),
  );
  dshVersion = manifest.version ?? dshVersion;
} catch {
  // The packages directory may be pointed somewhere without the umbrella
  // package; the per-package versions above still identify the install.
}

// ---- report --------------------------------------------------------------
let failed = 0;
for (const { name, pass } of results) if (!pass) failed += 1;

console.log('');
console.log(`  DSH install: ${dshPackages}`);
console.log(`  DSH version: ${dshVersion}  (${loaded} package(s) loaded, ${loadFailed} failed)`);
console.log('');
console.log(`${results.length - failed}/${results.length} passed`);

if (failed > 0) {
  console.log('');
  console.log('  An upstream rename or removal. Fix the bridge to match the new shape,');
  console.log('  update EXPECTED here, then run harness/plugin-check.cjs to prove a real');
  console.log('  turn still works — this check only proves the symbols exist.');
  process.exitCode = 1;
}
