/**
 * Offline regression for the plugin build-freshness judgement.
 *
 * Every harness in this directory rides on `harness/plugin-build.cjs`: it decides
 * whether an existing compile output may be reused or must be rebuilt. That makes
 * it the most dangerous place to regress — a judgement that goes green on stale
 * bytes makes *every other check* pass for the wrong reason, and nothing about the
 * output looks different. The judgement used to be exactly that bad: the source
 * list walked `server/` and `client/` only, so the two root-level entry points
 * (`index.server.ts`, which registers the provider, and `index.client.tsx`) could
 * change without invalidating anything, and freshness compared a single marker
 * file's mtime instead of the source set.
 *
 * The rewrite (a tsconfig-derived source set plus a build stamp) was verified by
 * hand, one experiment at a time, and none of that verification was in the repo.
 * This script is that verification, in a form that fails when someone weakens the
 * judgement again. Each scenario is asserted **both ways**: build a state, assert
 * the verdict, restore, assert the verdict is fresh again. A judgement that is
 * stuck on either answer therefore fails, not just one that is too permissive.
 *
 * What is pinned:
 *
 *   1. a just-built tree is fresh, and the source set covers the root-level entry
 *      points (the original defect, and the reason this file exists)
 *   2. a source newer than the build is stale and the reason **names that file**,
 *      both by touching the file and by rewinding its stamp entry (bit-exactly
 *      restorable)
 *   3. the same for the root-level `index.server.ts` specifically, blaming only it
 *   4. a missing compiled `.js` is stale (`missing compiled output`)
 *   5. a `.js` left over from a source that no longer exists is stale
 *   6. a missing `package.json` marker is stale
 *   7. a missing stamp is stale — fail closed, never trust an unstamped tree
 *   8. a source file added after the build is stale (the source *set* matters)
 *   9. an empty source set is stale, not vacuously fresh
 *  10. `PASEO_PLUGIN_BUILD` announces the bypass on every run and still warns when
 *      the external tree disagrees with the sources
 *  11. the verdict is wired to the reuse decision: `buildPlugin()` rebuilds a tree
 *      whose output is missing and reuses a fresh one
 *
 * Everything runs against a private copy of `paseo-plugin` in a scratch directory
 * under the OS temp dir, together with a private copy of the module under test, so
 * the repo is never written to: touching mtimes, adding and deleting sources, and
 * deleting build outputs all happen in the copy. `node_modules` is shared by
 * symlink (read-only use: `tsc` and the plugin's dependencies). Nothing here
 * `require`s the compiled output — only its metadata is inspected — so the rule
 * that callers' build trees must live inside `paseo-plugin` does not apply.
 *
 * Because the module is loaded from the copy made next to this file, the same
 * script can be pointed at a deliberately weakened copy of `plugin-build.cjs` to
 * prove the assertions actually bite: drop both files into a scratch
 * `harness/`, copy `paseo-plugin` beside them, and run it. That is how the
 * mutation checks in the task report were produced; no override hook exists, so a
 * run can never silently judge a different module than the one beside it.
 *
 * Usage:
 *   node harness/plugin-build-check.mjs
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const here = import.meta.dirname ?? new URL('.', import.meta.url).pathname;

/** The real plugin tree this script was shipped next to (read only). */
const sourcePlugin = resolve(here, '..', 'paseo-plugin');

let passed = 0;
let failed = 0;
function check(name, pass, detail) {
  if (pass) {
    passed += 1;
    console.log(`  PASS  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
  }
}
function group(title) {
  console.log(`\n${title}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'paseo-plugin-build-check-'));
const pluginDir = join(scratch, 'paseo-plugin');
const harnessDir = join(scratch, 'harness');
let cleanedUp = false;

/**
 * Remove the scratch tree without ever following the shared `node_modules` link.
 *
 * `rmSync(recursive)` unlinks symlinks rather than descending into them, but the
 * link is removed explicitly first so that a future edit to this cleanup cannot
 * turn into `rm -rf` over the repo's dependency tree.
 */
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  rmSync(join(pluginDir, 'node_modules'), { force: true });
  rmSync(scratch, { recursive: true, force: true });
}

let build;
let outDir;
let buildDirName;

try {
  // ------------------------------------------------------------------ fixture
  // The copy is what makes every mutation below legal: sources, mtimes and build
  // outputs are all edited here, never in the repo.
  mkdirSync(harnessDir, { recursive: true });
  cpSync(sourcePlugin, pluginDir, {
    recursive: true,
    preserveTimestamps: true,
    filter: (src) => {
      const name = basename(src);
      // Dependencies are shared read-only by symlink below; other agents' build
      // trees are neither needed nor ours to copy.
      return name !== 'node_modules' && !name.startsWith('.dbg');
    },
  });
  symlinkSync(join(sourcePlugin, 'node_modules'), join(pluginDir, 'node_modules'), 'dir');
  cpSync(join(here, 'plugin-build.cjs'), join(harnessDir, 'plugin-build.cjs'));
  build = require(join(harnessDir, 'plugin-build.cjs'));

  console.log(`plugin:   ${sourcePlugin}`);
  console.log(`scratch:  ${scratch}`);
  if (build.PLUGIN_DIR !== pluginDir) {
    throw new Error(`module under test resolved PLUGIN_DIR to ${build.PLUGIN_DIR}, expected ${pluginDir}`);
  }

  const tsc = join(pluginDir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    console.error(`typescript is not installed at ${tsc}; run \`npm install\` in paseo-plugin`);
    cleanup();
    process.exit(2);
  }

  // One real build, outside the plugin copy so the tree stays pristine.
  buildDirName = relative(pluginDir, join(scratch, 'build'));
  const startedAt = Date.now();
  outDir = build.buildPlugin({ dir: buildDirName, quiet: true });
  const buildMs = Date.now() - startedAt;

  const STAMP = build.STAMP_NAME;
  const stampPath = join(outDir, STAMP);

  /** posix path of `abs` relative to the plugin copy — the stamp's key form. */
  const relSource = (abs) => relative(pluginDir, abs).split(sep).join('/');
  /** Does any reason mention `fragment`? */
  const reasonMentions = (state, fragment) => state.reasons.some((r) => r.includes(fragment));
  /** The reason line about mtimes, which must name the file it is about. */
  const modifiedReason = (state, rel) =>
    state.reasons.some((r) => r.startsWith('source modified since build:') && r.includes(rel));
  /** Files blamed by the mtime reason, in order. */
  const blamed = (state) =>
    state.reasons
      .filter((r) => r.startsWith('source modified since build:'))
      .flatMap((r) => r.slice('source modified since build:'.length).split(', ').map((s) => s.trim()));

  /**
   * Re-record the stamp from the tree's current mtimes — exactly what a rebuild
   * would have written. This is how a touched source is "restored" without paying
   * for another `tsc` run; `version` and `tsc` are carried over so this helper
   * cannot paper over a format change.
   *
   * Both halves are re-recorded: the sources and the compiler inputs. A helper
   * that restored only the sources would leave a scenario that edits
   * `tsconfig.json` stuck on stale, and the "restore -> fresh" half of that
   * assertion would pass for the wrong reason.
   */
  function restamp() {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    const sources = {};
    for (const file of build.sourceFiles()) sources[relSource(file)] = statSync(file).mtimeMs;
    const config = {};
    for (const file of build.configInputs()) config[relSource(file)] = statSync(file).mtimeMs;
    writeFileSync(stampPath, `${JSON.stringify({ ...stamp, sources, config }, null, 2)}\n`);
  }

  /** Push a file's mtime into the future so it is provably newer than the build. */
  function touchFuture(abs) {
    const when = new Date(Date.now() + 10_000);
    utimesSync(abs, when, when);
  }

  /** Run `fn` while capturing everything it writes to stderr. */
  function captureStderr(fn) {
    const chunks = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      return { value: fn(), text: chunks.join('') };
    } finally {
      process.stderr.write = original;
    }
  }

  // ------------------------------------------- 1. a just-built tree is fresh
  group('1. just-built tree');
  const sources = build.sourceFiles();
  const sourceRels = sources.map(relSource);
  const rootEntries = readdirSync(pluginDir).filter(
    (name) => /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name),
  );

  const fresh = build.freshness(outDir);
  check('freshness() reports fresh', fresh.fresh === true, `built in ${buildMs} ms`);
  check('no reasons are carried on a fresh tree', fresh.reasons.length === 0, JSON.stringify(fresh.reasons));
  check('isFresh() agrees with freshness()', build.isFresh(outDir) === true);

  // The regression that started all of this: the two root-level entry points must
  // be part of the source set, or changing them invalidates nothing.
  check('source set is non-empty', sourceRels.length > 0, `${sourceRels.length} sources`);
  for (const entry of ['index.server.ts', 'index.client.tsx']) {
    check(`source set covers root-level ${entry}`, sourceRels.includes(entry));
  }
  const uncoveredRoots = rootEntries.filter((name) => !sourceRels.includes(name));
  check(
    'no root-level source is missing from the source set',
    uncoveredRoots.length === 0,
    uncoveredRoots.length === 0 ? `${rootEntries.length} root sources` : uncoveredRoots.join(', '),
  );
  // The stamp is the authority the judgement reads, so it must record the same set.
  const stampedRels = Object.keys(JSON.parse(readFileSync(stampPath, 'utf8')).sources ?? {}).sort();
  check(
    'stamp records exactly the current source set',
    JSON.stringify(stampedRels) === JSON.stringify([...sourceRels].sort()),
    `${stampedRels.length} stamped / ${sourceRels.length} current`,
  );

  // --------------------------------- 2. a source newer than the build is stale
  group('2. source newer than the build');
  {
    // 2a: rewind a stamp entry. This is the bit-exactly reversible half: the stamp
    // is JSON, so the original bytes can be put back and the verdict must recover.
    const rel = 'server/session.ts';
    const originalText = readFileSync(stampPath, 'utf8');
    const stamp = JSON.parse(originalText);
    stamp.sources[rel] = stamp.sources[rel] - 1_000;
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
    const rewound = build.freshness(outDir);
    check('an mtime disagreement is stale', rewound.fresh === false);
    check('the reason names the rewound file', modifiedReason(rewound, rel), rewound.reasons.join(' | '));
    check('only that file is blamed', blamed(rewound).join(',') === rel, blamed(rewound).join(', '));

    writeFileSync(stampPath, originalText);
    check('restoring the stamp bytes is bit-exact', readFileSync(stampPath, 'utf8') === originalText);
    check('restoring the stamp returns to fresh', build.freshness(outDir).fresh === true);
  }
  {
    // 2b: touch a real source file, which is the shape of the reported bug.
    const rel = 'server/timeline.ts';
    const abs = join(pluginDir, rel);
    const before = statSync(abs).mtimeMs;
    touchFuture(abs);
    const touched = statSync(abs).mtimeMs;
    check('the mtime actually moved', touched !== before, `${before} -> ${touched}`);
    const stale = build.freshness(outDir);
    check('a touched source is stale', stale.fresh === false);
    check('the reason names the touched file', modifiedReason(stale, rel), stale.reasons.join(' | '));
    check('isFresh() agrees', build.isFresh(outDir) === false);

    restamp();
    check('re-recording the stamp returns to fresh', build.freshness(outDir).fresh === true);
  }

  // --------------------------------- 3. the root-level entry point is tracked
  group('3. root-level entry point (the original defect)');
  {
    const rel = 'index.server.ts';
    const abs = join(pluginDir, rel);
    const before = statSync(abs).mtimeMs;
    touchFuture(abs);
    check('the mtime actually moved', statSync(abs).mtimeMs !== before);
    const stale = build.freshness(outDir);
    check('a newer index.server.ts invalidates the build', stale.fresh === false);
    check('the reason names index.server.ts', modifiedReason(stale, rel), stale.reasons.join(' | '));
    // The defect was that this file alone could change silently, so the verdict
    // must be about it and not about some other file that happened to drift.
    check('no other file is blamed', blamed(stale).join(',') === rel, blamed(stale).join(', '));

    restamp();
    check('re-recording the stamp returns to fresh', build.freshness(outDir).fresh === true);
  }

  // -------------------------------------------- 4. a compiled output is missing
  group('4. incomplete output');
  {
    const rel = 'server/timeline.js';
    const abs = join(outDir, rel);
    const bytes = readFileSync(abs);
    rmSync(abs);
    const stale = build.freshness(outDir);
    check('a missing .js invalidates the build', stale.fresh === false);
    check('the reason says "missing compiled output"', reasonMentions(stale, 'missing compiled output'));
    check('the reason names the missing file', reasonMentions(stale, rel), stale.reasons.join(' | '));

    writeFileSync(abs, bytes);
    check('restoring the file returns to fresh', build.freshness(outDir).fresh === true);
  }

  // ----------------------------- 5. a compiled output with no source behind it
  group('5. output left over from a removed source');
  {
    const rel = 'server/removed-module.js';
    const abs = join(outDir, rel);
    writeFileSync(abs, '"use strict";\n');
    const stale = build.freshness(outDir);
    check('a stray .js invalidates the build', stale.fresh === false);
    check('the reason says the output has no source', reasonMentions(stale, 'compiled output with no source'));
    check('the reason names the stray file', reasonMentions(stale, rel), stale.reasons.join(' | '));

    rmSync(abs);
    check('removing the stray file returns to fresh', build.freshness(outDir).fresh === true);
  }

  // ------------------------------------------------- 6. the package.json marker
  group('6. missing package.json marker');
  {
    const abs = join(outDir, 'package.json');
    const bytes = readFileSync(abs);
    rmSync(abs);
    const stale = build.freshness(outDir);
    check('a missing package.json invalidates the build', stale.fresh === false);
    check('the reason says the marker is missing', reasonMentions(stale, 'missing package.json marker'));

    writeFileSync(abs, bytes);
    check('restoring the marker returns to fresh', build.freshness(outDir).fresh === true);
  }

  // ------------------------------------------- 7. no stamp: fail closed
  group('7. missing build stamp (fail closed)');
  {
    const bytes = readFileSync(stampPath, 'utf8');
    rmSync(stampPath);
    const stale = build.freshness(outDir);
    check('an unstamped tree is stale, never trusted', stale.fresh === false);
    check(`the reason says there is no ${STAMP}`, reasonMentions(stale, `no ${STAMP}`), stale.reasons.join(' | '));

    writeFileSync(stampPath, bytes);
    check('restoring the stamp returns to fresh', build.freshness(outDir).fresh === true);
  }

  // --------------------------------------- 8. a source added since the build
  group('8. source added since the build');
  {
    const rel = 'server/added-source.ts';
    const abs = join(pluginDir, rel);
    writeFileSync(abs, 'export const added = 1;\n');
    const stale = build.freshness(outDir);
    check('an added source invalidates the build', stale.fresh === false);
    check('the reason says a source was added', reasonMentions(stale, 'source added since build'));
    check('the reason names the added file', reasonMentions(stale, rel), stale.reasons.join(' | '));

    rmSync(abs);
    check('removing the source returns to fresh', build.freshness(outDir).fresh === true);
  }

  // -------------------------------------------- 9. an empty source set is stale
  group('9. empty source set (fail closed)');
  {
    const state = build.freshness(outDir, []);
    check('an empty source set is stale, not vacuously fresh', state.fresh === false);
    check('the reason says no sources were found', reasonMentions(state, 'no TypeScript sources found'), state.reasons.join(' | '));
    check('the positive control with the real source set is fresh', build.freshness(outDir, build.sourceFiles()).fresh === true);
  }

  // --------------------------------------------- 10. the PASEO_PLUGIN_BUILD bypass
  group('10. PASEO_PLUGIN_BUILD bypass is announced');
  {
    const previous = process.env.PASEO_PLUGIN_BUILD;
    try {
      process.env.PASEO_PLUGIN_BUILD = '';
      const empty = captureStderr(() => build.buildDirFromEnv());
      check('an empty variable means "not configured"', empty.value === undefined && empty.text === '');

      delete process.env.PASEO_PLUGIN_BUILD;
      const unset = captureStderr(() => build.buildDirFromEnv());
      check('an unset variable means "not configured"', unset.value === undefined && unset.text === '');

      process.env.PASEO_PLUGIN_BUILD = outDir;
      const freshBypass = captureStderr(() => build.buildDirFromEnv());
      check(
        'the bypass is announced even when the tree is fresh',
        freshBypass.text.includes('trusting external build, freshness not enforced'),
        freshBypass.text.trim(),
      );
      check('the fresh external tree draws no warning', !freshBypass.text.includes('may not match the sources'));
      check('the configured directory is returned', freshBypass.value === resolve(outDir));

      const staleTree = join(scratch, 'external-stale');
      mkdirSync(staleTree, { recursive: true });
      process.env.PASEO_PLUGIN_BUILD = staleTree;
      const staleBypass = captureStderr(() => build.buildDirFromEnv());
      check(
        'the bypass is still announced for a stale tree',
        staleBypass.text.includes('trusting external build, freshness not enforced'),
      );
      check('a disagreeing external tree is called out', staleBypass.text.includes('may not match the sources'), staleBypass.text.trim());
      check('a stale external tree is still used (only the silence is removed)', staleBypass.value === resolve(staleTree));
    } finally {
      if (previous === undefined) delete process.env.PASEO_PLUGIN_BUILD;
      else process.env.PASEO_PLUGIN_BUILD = previous;
    }
  }

  // ------------------------------------------ 12. a source removed since the build
  // Scenario 5 covers a stray `.js` (an output whose source is gone). This is the
  // other half, and the one that was uncovered: the source *and* its output both
  // gone. Without the `removed` predicate `freshness()` returned
  // `{fresh: true, reasons: []}` here, so every harness downstream ran green on a
  // tree missing a module. Mutation M1 in the review report is this predicate
  // deleted, and it stayed green before this scenario existed.
  group('12. source removed since the build');
  {
    const rel = 'server/timeline.ts';
    const abs = join(pluginDir, rel);
    const source = readFileSync(abs);

    const compiledAbs = join(outDir, rel.replace(/\.ts$/, '.js'));
    const compiled = readFileSync(compiledAbs);
    rmSync(abs);
    rmSync(compiledAbs);
    const stale = build.freshness(outDir);
    check('a removed source invalidates the build', stale.fresh === false);
    check('the reason says a source was removed', reasonMentions(stale, 'source removed since build'), stale.reasons.join(' | '));
    check('the reason names the removed file', reasonMentions(stale, `source removed since build: ${rel}`), stale.reasons.join(' | '));
    // The output being gone must not be the thing that made it stale: that is
    // scenario 4, and it would hide a deleted `removed` predicate.
    check('and the verdict does not rest on the missing output alone', reasonMentions(stale, 'source removed since build'));

    // Restore the bytes, then re-record the stamp. `utimesSync` cannot put an
    // mtime back bit-exactly (`mtimeMs` is a float, `Date` holds milliseconds), and
    // an off-by-a-fraction restore made this assertion flaky — it passed and failed
    // on consecutive runs of the same tree. The other scenarios restore the same
    // way (2b, 3, 15); what this scenario asserts is the *removal* verdict, and
    // "back to fresh" only guards against a verdict stuck on stale.
    writeFileSync(abs, source);
    writeFileSync(compiledAbs, compiled);
    restamp();
    check('restoring the source returns to fresh', build.freshness(outDir).fresh === true, JSON.stringify(build.freshness(outDir).reasons));
  }

  // --------------------------------------- 13. the stamp's own format version
  // `STAMP_VERSION` exists so a stamp written by an older layout cannot be read as
  // a current one. Nothing pinned that comparison: setting it to never trigger
  // left every check green (mutation M8), so raising the version in the future
  // would silently keep trusting old stamps.
  group('13. stamp format version');
  {
    const originalText = readFileSync(stampPath, 'utf8');
    const stamp = JSON.parse(originalText);
    stamp.version = build.STAMP_VERSION - 1;
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
    const stale = build.freshness(outDir);
    check('a stamp from an older format is stale', stale.fresh === false);
    check(
      'the reason names both versions',
      reasonMentions(stale, `!= ${build.STAMP_VERSION}`) && reasonMentions(stale, String(build.STAMP_VERSION - 1)),
      stale.reasons.join(' | '),
    );

    writeFileSync(stampPath, originalText);
    check('restoring the stamp returns to fresh', build.freshness(outDir).fresh === true);
  }

  // ------------------------- 13b. a current-version stamp with no `config` field
  // The upgrade path, and the one a version bump alone does not cover: a stamp
  // written by the previous layout can claim the current version (if someone
  // bumps `STAMP_VERSION` without the version gate noticing, or hand-edits a
  // stamp) and still say nothing about the compiler inputs. Assuming equality
  // there is exactly the silent-trust failure this module exists to prevent, so
  // it must be stale with a reason of its own.
  group('13b. stamp without compiler inputs (fail closed)');
  {
    const originalText = readFileSync(stampPath, 'utf8');
    const stamp = JSON.parse(originalText);
    check('the real stamp carries a config block', stamp.config !== null && typeof stamp.config === 'object');
    delete stamp.config;
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
    const stale = build.freshness(outDir);
    check('a stamp with no compiler inputs is stale, never trusted', stale.fresh === false);
    check(
      'the reason says the compiler inputs are not recorded',
      reasonMentions(stale, 'no compiler inputs recorded'),
      stale.reasons.join(' | '),
    );

    writeFileSync(stampPath, originalText);
    check('restoring the stamp returns to fresh', build.freshness(outDir).fresh === true);
  }
  // A newer `tsc` can emit different bytes from the same sources. The comparison
  // was there but unpinned (mutation M7 deleted it and everything stayed green).
  group('14. TypeScript version changed since the build');
  {
    const originalText = readFileSync(stampPath, 'utf8');
    const stamp = JSON.parse(originalText);
    const installed = JSON.parse(
      readFileSync(join(pluginDir, 'node_modules', 'typescript', 'package.json'), 'utf8'),
    ).version;
    // The control: the stamp the build really wrote must agree with the installed
    // compiler, or the stale verdict below could come from a pre-existing mismatch.
    check('the build stamped the installed compiler version', stamp.tsc === installed, `${stamp.tsc} vs ${installed}`);

    stamp.tsc = '0.0.0';
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
    const stale = build.freshness(outDir);
    check('a different compiler version is stale', stale.fresh === false);
    check(
      'the reason says typescript changed',
      reasonMentions(stale, 'typescript changed since build') && reasonMentions(stale, '0.0.0'),
      stale.reasons.join(' | '),
    );

    writeFileSync(stampPath, originalText);
    check('restoring the stamp returns to fresh', build.freshness(outDir).fresh === true);
  }

  // -------------------------------- 15. the files that decide how sources compile
  // `sourceFiles()` comes from `tsconfig.json`, but the config itself was not an
  // input: changing `target` (or a `@getpaseo/*` devDependency) left the existing
  // tree fresh and every harness ran on bytes compiled with the old settings.
  group('15. compiler inputs (tsconfig.json, package.json)');
  {
    const tsconfigPath = join(pluginDir, 'tsconfig.json');
    const packagePath = join(pluginDir, 'package.json');
    const configRels = build.configInputs().map(relSource);
    check(
      'both compiler inputs are tracked',
      configRels.includes('tsconfig.json') && configRels.includes('package.json'),
      configRels.join(', '),
    );
    check(
      'the stamp records them',
      (() => {
        const recorded = JSON.parse(readFileSync(stampPath, 'utf8')).config ?? {};
        return configRels.every((rel) => rel in recorded);
      })(),
      JSON.stringify(Object.keys(JSON.parse(readFileSync(stampPath, 'utf8')).config ?? {})),
    );

    // 15a: a real `compilerOptions` edit, restored byte-exactly.
    const tsconfigText = readFileSync(tsconfigPath, 'utf8');
    const before = /"target"\s*:\s*"([^"]+)"/.exec(tsconfigText)?.[1];
    check('tsconfig.json states a target to edit', before !== undefined, before ?? '(no target)');
    const edited = tsconfigText.replace(/"target"\s*:\s*"[^"]+"/, '"target": "ES5"');
    check('the edit actually changes the file', edited !== tsconfigText);
    writeFileSync(tsconfigPath, edited);
    touchFuture(tsconfigPath);
    const stale = build.freshness(outDir);
    check('a changed tsconfig.json invalidates the build', stale.fresh === false, JSON.stringify(stale.reasons));
    check('the reason names tsconfig.json', reasonMentions(stale, 'tsconfig.json'), stale.reasons.join(' | '));
    check('and says a compiler input changed', reasonMentions(stale, 'compiler input changed since build'), stale.reasons.join(' | '));

    writeFileSync(tsconfigPath, tsconfigText);
    restamp();
    check('restoring tsconfig.json returns to fresh', build.freshness(outDir).fresh === true, JSON.stringify(build.freshness(outDir).reasons));

    // 15b: the dependency declaration, which changes the types the emitted JS was
    // checked against without changing any source byte.
    const packageText = readFileSync(packagePath, 'utf8');
    writeFileSync(packagePath, packageText.replace(/"typescript":\s*"[^"]+"/, '"typescript": "0.0.0"'));
    touchFuture(packagePath);
    const staleDeps = build.freshness(outDir);
    check('a changed package.json invalidates the build', staleDeps.fresh === false, JSON.stringify(staleDeps.reasons));
    check('the reason names package.json', reasonMentions(staleDeps, 'package.json'), staleDeps.reasons.join(' | '));

    writeFileSync(packagePath, packageText);
    restamp();
    check('restoring package.json returns to fresh', build.freshness(outDir).fresh === true, JSON.stringify(build.freshness(outDir).reasons));
  }

  // ----------------------------- 11. the verdict is wired to the reuse decision
  // Last, because it rebuilds and therefore rewrites the stamp.
  group('11. buildPlugin() obeys the verdict');
  {
    const rel = 'server/locale.js';
    const abs = join(outDir, rel);
    rmSync(abs);
    const rebuild = captureStderr(() => build.buildPlugin({ dir: buildDirName, quiet: false }));
    check('a tree with a missing output is rebuilt', existsSync(abs) && build.freshness(outDir).fresh === true);
    check('the rebuild log names the reason', rebuild.text.includes('missing compiled output'), rebuild.text.trim().split('\n')[0]);
    check('the rebuild returns the same directory', rebuild.value === outDir);

    const reuse = captureStderr(() => build.buildPlugin({ dir: buildDirName, quiet: false }));
    check('a fresh tree is reused instead of rebuilt', reuse.text.includes('reusing plugin build'), reuse.text.trim());
    check('reuse returns the same directory', reuse.value === outDir);
  }
} catch (error) {
  failed += 1;
  console.error(`\n  ERROR  ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  cleanup();
}

group('cleanup');
check('the scratch directory was removed', !existsSync(scratch), scratch);
check(
  'the repo\'s dependency tree was not touched',
  existsSync(join(sourcePlugin, 'node_modules', 'typescript', 'bin', 'tsc')),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
