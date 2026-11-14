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
 * This check closes that gap for the two surfaces the bridge depends on: the
 * **imports** it makes at load time, and the **service operations** it calls at
 * run time. It asserts:
 *
 *   1. **Coverage** — every `@deepseek-ai/*` package the bridge imports is listed
 *      in `EXPECTED` below. A new import added to the bridge without updating the
 *      manifest fails here, so the check cannot silently stop covering something.
 *   2. **Presence** — every symbol the manifest names is still exported by the
 *      installed package. This is what turns "upgraded, ran a real turn, saw a
 *      blank error" into "upgraded, ran this, got the symbol name".
 *   3. **Service surface** — the `ctx.<name>` services the bridge looks up at run
 *      time still declare the operations it calls (`EXPECTED_SERVICE_SURFACE`).
 *      An import check cannot see these: a service is reached through
 *      `ctx.get('jobs')` and duck-typed, so a renamed operation would be a
 *      `TypeError` in the middle of a user action, not an import failure. The
 *      check also pins the two surfaces the DSH 0.2.2-rc.2 rename broke in a way
 *      nothing else could see: the `subagents` delegated-work join
 *      (`waitForChildren` → `waitForTreeWork`, either accepted) and the
 *      `agentTeam` projection view (one of the two known generations).
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
import { join, dirname, relative } from 'node:path';
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
  // Display names for the composer's DSH setting rows. The package export is
  // used instead of the `pluginInventory` service because that service is
  // composed only by the web-app bundle, while a bare `base+bridge` profile has
  // none; `readPluginInventory(ctx)` only needs the Loader.
  'dsh-host-plugin-inventory': { named: { readPluginInventory: 'function' } },
  'dsh-cmdline': { named: { exitOnStdinEnd: 'function', parseCmdline: 'function' } },
  'dsh-tools': { named: { defineTool: 'function' } },
  'dsh-subprocess': { named: { scrubbedParentEnv: 'function' } },
  schemastery: { default: 'function' },
};

/**
 * The services the bridge reaches through `ctx.get(...)`, and the operations it
 * calls on them.
 *
 * Unlike {@link EXPECTED}, these packages are **not** imports: the bridge
 * duck-types whatever the profile composes, which is what keeps it loadable on a
 * profile with no job registry at all. The contract lives in the abstract service
 * (the package's `.d.ts`), and the shipped implementation is what actually runs,
 * so both are asserted: a rename in either place would otherwise surface as a
 * failed user action rather than as a load error.
 *
 * Scope is deliberately the operations this bridge calls. `list` and `get` are
 * the jobs read; `kill` is the one `paseo/jobs/stop` added (2026-11-11) — it is
 * DSH's own stop entry, the same one `dsh-tool-jobs`' `job_kill` uses.
 */
const EXPECTED_SERVICE_SURFACE = {
  // The bridge registers per-session Paseo identity as managed DSH_* shell
  // facts through `ctx.shellEnv.register` (the public extension point the
  // web app uses for DSH_WEB_URL). `collect` is what the bash tool calls for
  // every model shell execution; losing either method would silently remove
  // the per-session identity from bash/background/sandbox shells.
  'dsh-shell-env': {
    implementationClass: 'ShellEnvRegistry',
    prototypeOps: ['register', 'collect'],
  },
  'dsh-jobs': {
    // The abstract contract: what the `.d.ts` must still declare. Read from the
    // file the package's own `types` field names, so an upstream path move is
    // reported as "cannot read" instead of silently shrinking the check.
    abstractOps: ['list', 'get', 'kill'],
  },
  'dsh-jobs-local': {
    // The implementation the `paseo` profile actually composes: the prototype
    // must still carry the operations, or `ctx.jobs.kill` is not a function.
    implementationClass: 'LocalJobRegistry',
    prototypeOps: ['list', 'get', 'kill'],
  },
  // The rewind gives withdrawn delegated work a bounded moment to observe the
  // cancel (`settleDelegatedWork`), joining through this service when the
  // profile composes no live `agents` registry. DSH 0.2.2-rc.2 renamed that
  // join: `waitForChildren(parent)` (`dsh-subagent` ≤ 0.2.2-rc.1) became
  // `waitForTreeWork(root)` (`dsh-subagent` 0.2.2-rc.2+). The bridge accepts
  // either, so the contract is "at least one is still declared" — both missing
  // makes the settle step a logged no-op on every rewind.
  'dsh-subagent': {
    oneOfAbstractOps: ['waitForTreeWork', 'waitForChildren'],
    // 0.2.2-rc.2+ also names children: `namesOf`/`rootOf` are what the bridge
    // duck-types to tell the plugin whether a held child notice may wait for a
    // catalog name. The rc.1 generation has neither and is expected to miss them;
    // but a build that declares the newer tree wait while declaring no naming
    // method would silently turn that report off (the plugin then keeps opening
    // label-only children), so the two are asserted together.
    namesGate: { whenDeclared: 'waitForTreeWork', ops: ['namesOf', 'rootOf'] },
  },
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

// ---- 3b. the service operations the bridge calls at run time ----------------
//
// These are not imports, so section 3 cannot see them. Both halves of the job
// contract are checked: the abstract declaration (dsh-jobs) and the class the
// profile actually composes (dsh-jobs-local).

for (const [pkg, spec] of Object.entries(EXPECTED_SERVICE_SURFACE)) {
  const pkgDir = join(dshPackages, pkg);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch (error) {
    check(`${pkg} is installed for its service surface`, false, `unreadable at ${pkgDir} (${error.code ?? error.message})`);
    continue;
  }

  if (spec.abstractOps !== undefined) {
    const typesFile = join(pkgDir, manifest.types ?? manifest.main?.replace(/\.js$/, '.d.ts') ?? 'lib/index.d.ts');
    let text;
    try {
      text = readFileSync(typesFile, 'utf8');
    } catch (error) {
      check(`${pkg} type surface is readable`, false, `${typesFile} (${error.code ?? error.message})`);
      continue;
    }
    const missing = spec.abstractOps.filter((op) => !new RegExp(`abstract\\s+${op}\\s*\\(`).test(text));
    check(
      `${pkg}@${manifest.version ?? '?'} still declares ${spec.abstractOps.join(', ')}`,
      missing.length === 0,
      missing.length === 0 ? `declared in ${relative(dshPackages, typesFile)}` : `not declared: ${missing.join(', ')}`,
    );
  }

  if (spec.oneOfAbstractOps !== undefined) {
    const typesFile = join(pkgDir, manifest.types ?? manifest.main?.replace(/\.js$/, '.d.ts') ?? 'lib/index.d.ts');
    let text;
    try {
      text = readFileSync(typesFile, 'utf8');
    } catch (error) {
      check(`${pkg} type surface is readable`, false, `${typesFile} (${error.code ?? error.message})`);
      continue;
    }
    // `abstract waitForTreeWork(...)` in the abstract service class. Either name
    // satisfies the bridge's two-generation fallback; neither is a break.
    const declared = spec.oneOfAbstractOps.filter((op) => new RegExp(`\\b${op}\\s*\\(`).test(text));
    check(
      `${pkg}@${manifest.version ?? '?'} still declares one of ${spec.oneOfAbstractOps.join(', ')}`,
      declared.length > 0,
      declared.length > 0 ? `declared: ${declared.join(', ')}` : `none of them are declared`,
    );
  }

  if (spec.namesGate !== undefined) {
    const typesFile = join(pkgDir, manifest.types ?? manifest.main?.replace(/\.js$/, '.d.ts') ?? 'lib/index.d.ts');
    let text;
    try {
      text = readFileSync(typesFile, 'utf8');
    } catch (error) {
      check(`${pkg} type surface is readable for naming`, false, `${typesFile} (${error.code ?? error.message})`);
      continue;
    }
    const newerGeneration = new RegExp(`\\b${spec.namesGate.whenDeclared}\\s*\\(`).test(text);
    const naming = spec.namesGate.ops.filter((op) => new RegExp(`\\b${op}\\s*\\(`).test(text));
    check(
      `${pkg}@${manifest.version ?? '?'} declares ${spec.namesGate.ops.join(' or ')} when it declares ${spec.namesGate.whenDeclared}`,
      !newerGeneration || naming.length > 0,
      newerGeneration
        ? (naming.length > 0 ? `declared: ${naming.join(', ')}` : 'the newer tree wait is declared but no naming method is')
        : 'rc.1 generation: no naming is expected, and the bridge reports none',
    );
  }

  if (spec.implementationClass !== undefined) {
    const entry = join(pkgDir, manifest.main ?? 'lib/index.js');
    let module;
    try {
      module = await import(pathToFileURL(entry).href);
    } catch (error) {
      check(`${pkg} loads`, false, `${entry} (${error.code ?? error.message})`);
      continue;
    }
    const klass = module[spec.implementationClass];
    const missing = typeof klass !== 'function'
      ? spec.prototypeOps
      : spec.prototypeOps.filter((op) => typeof klass.prototype[op] !== 'function');
    check(
      `${pkg}@${manifest.version ?? '?'} ${spec.implementationClass} still implements ${spec.prototypeOps.join(', ')}`,
      typeof klass === 'function' && missing.length === 0,
      typeof klass !== 'function'
        ? `${spec.implementationClass} is ${typeof klass}`
        : missing.length === 0
          ? 'all implemented'
          : `missing on the prototype: ${missing.join(', ')}`,
    );
  }
}

// ---- 3c. the `agentTeam` projection is one of the two known generations ----
//
// The plugin reads this projection through `paseo/projections` and parses it with
// `paseo-plugin/shared/team.ts`'s union. The package that owns it was replaced
// wholesale (`dsh-experimental-agent-team` → `dsh-agent-team` in DSH
// 0.2.2-rc.2), and it is reached by projection **key**, never by import — so
// neither the import coverage nor the service-surface sections can see it.
// Whichever package the install ships, its `TeamProjection` must be one of the
// two generations the plugin knows. A third shape would be an accepted
// `rpc_failed` at runtime; here it fails by name, before a user opens the pill.
const TEAM_PROJECTION_PACKAGES = [
  {
    pkg: 'dsh-agent-team',
    generation: '0.2.2-rc.2+ {enabled, tasks, failure?}',
    required: ['enabled', 'tasks'],
    forbidden: ['members'],
  },
  {
    pkg: 'dsh-experimental-agent-team',
    generation: '<= 0.2.2-rc.1 {members, tasks, failure?}',
    required: ['members', 'tasks'],
    forbidden: ['enabled'],
  },
];

/** Read the `TeamProjection` interface body from one package's `.d.ts` tree. */
function teamProjectionBody(pkgDir) {
  const root = join(pkgDir, 'lib', 'types');
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.name.endsWith('.d.ts')) continue;
      const match = /interface\s+TeamProjection\s*\{([\s\S]*?)\n\}/u.exec(readFileSync(path, 'utf8'));
      if (match !== null) return match[1];
    }
  }
  return undefined;
}

{
  const shipped = TEAM_PROJECTION_PACKAGES.filter((candidate) => {
    try {
      readFileSync(join(dshPackages, candidate.pkg, 'package.json'), 'utf8');
      return true;
    } catch {
      return false;
    }
  });
  check(
    'exactly one agentTeam projection package is installed',
    shipped.length === 1,
    shipped.map((candidate) => candidate.pkg).join(', ') || 'none',
  );
  for (const candidate of shipped) {
    const body = teamProjectionBody(join(dshPackages, candidate.pkg));
    if (body === undefined) {
      check(`${candidate.pkg} type surface declares TeamProjection`, false, 'interface TeamProjection not found');
      continue;
    }
    const missing = candidate.required.filter((field) => !new RegExp(`\\b${field}\\s*:`, 'u').test(body));
    const extra = candidate.forbidden.filter((field) => new RegExp(`\\b${field}\\s*:`, 'u').test(body));
    check(
      `${candidate.pkg} TeamProjection is the ${candidate.generation} generation`,
      missing.length === 0 && extra.length === 0,
      missing.length > 0
        ? `missing: ${missing.join(', ')}`
        : extra.length > 0
          ? `unexpected: ${extra.join(', ')}`
          : undefined,
    );
  }
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
