/**
 * Compile the plugin to CommonJS so a harness script can `require` it.
 *
 * A few checks used to be written as regexes over TypeScript source because
 * the modules they talk about (`session.ts`, `provider.ts`) cannot be `require`d
 * directly: the sources are ESM with extensionless specifiers, which plain
 * `node` cannot resolve. That made the assertions formatting tests — a reflowed
 * call site failed the check while the code was still correct.
 *
 * Compiling to CommonJS is the same flow the plugin-level harness scripts have
 * always documented by hand (see the header of `plugin-check.cjs`), so this
 * module just automates it:
 *
 *   - the output **must** live inside the repo (`paseo-plugin/<dir>`), because
 *     `node` resolves `@getpaseo/plugin` and friends by walking up to
 *     `paseo-plugin/node_modules`. A build under `/tmp` cannot see them and every
 *     `require` of the compiled output dies with MODULE_NOT_FOUND.
 *   - type errors are expected and ignored: `--moduleResolution node` cannot
 *     resolve the protocol package's ESM declarations. The emitted JS is what
 *     runs, exactly as in the documented manual steps.
 *   - the result is reused only while it is **provably** a build of the current
 *     sources. A build that is older, partial, or was produced from a different
 *     source set is rebuilt. The judgement lives in `freshness()` below and is
 *     deliberately strict: a harness that tests stale bytes passes for the wrong
 *     reason, and every check in this directory rides on this one module.
 *
 * Callers pass the directory *name* (relative to `paseo-plugin`) so parallel
 * work never shares a build tree; the contract's rule is one private dir per
 * task, deleted when the task ends.
 */

"use strict";

const { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { join, relative, resolve, sep } = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_DIR = resolve(__dirname, "..", "paseo-plugin");

/**
 * Written into the build directory after a successful compile; records exactly
 * which sources (and which compiler) produced the tree.
 *
 * Bumped to 2 when `config` (tsconfig.json/package.json mtimes) joined the
 * stamp: a version-1 stamp cannot say anything about the compiler inputs, so it
 * must not be trusted for them.
 */
const STAMP_NAME = ".build-stamp.json";
const STAMP_VERSION = 2;

/** posix path of `abs` relative to `paseo-plugin` — the stamp's key form. */
function relSource(abs) {
  return relative(PLUGIN_DIR, abs).split(sep).join("/");
}

/** Where tsc emits the compiled form of a source file. */
function compiledPath(rel) {
  return rel.replace(/\.tsx?$/, ".js");
}

/** Fallback walker: every `.ts`/`.tsx` under `paseo-plugin`, minus dot dirs. */
function walkSources(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(abs, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(abs);
  }
  return out;
}

/**
 * The exact file list tsc compiles: `include` from `paseo-plugin/tsconfig.json`.
 *
 * Reading the config instead of hard-coding directories is the point: the old
 * walk covered `["server", "client"]` only, so the two root-level entry points
 * (`index.server.ts`, which registers the provider, and `index.client.tsx`) could
 * change without invalidating anything. A new directory, or a new root file, is
 * picked up here with no edit.
 *
 * @returns {string[] | undefined} absolute paths, or `undefined` when the set
 *   cannot be trusted (no tsconfig, no typescript, empty result).
 */
function tsconfigSources() {
  const configPath = join(PLUGIN_DIR, "tsconfig.json");
  if (!existsSync(configPath)) return undefined;
  let ts;
  try {
    ts = require(join(PLUGIN_DIR, "node_modules", "typescript"));
  } catch {
    return undefined;
  }
  try {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error !== undefined) return undefined;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, PLUGIN_DIR);
    const files = parsed.fileNames.filter(
      (file) => /\.tsx?$/.test(file) && !/\.d\.ts$/.test(file),
    );
    // An empty set would make every freshness predicate vacuously true.
    return files.length === 0 ? undefined : files.sort();
  } catch {
    return undefined;
  }
}

/** Every source file whose change must invalidate a build. */
function sourceFiles() {
  return tsconfigSources() ?? walkSources(PLUGIN_DIR, []).sort();
}

/**
 * Files that change what the compiler emits without being sources themselves.
 *
 * `sourceFiles()` is derived from `tsconfig.json`, so the config decides the
 * source set — but it was not part of the set. Editing `compilerOptions`
 * (`target`, `jsx`, `strict`, …) or bumping a `devDependencies` entry in
 * `paseo-plugin/package.json` (which changes the `@getpaseo/*` declarations the
 * emitted JS is typed against) therefore left an existing `.dbg-*` tree looking
 * fresh, and every harness downstream of it ran green on bytes compiled with the
 * old settings. Only `include` changes were ever noticed, because those change
 * the source set itself.
 *
 * The two files are compared with the same mtime logic as the sources and
 * recorded in the same stamp; `freshness()` keeps them out of the
 * expected-output list, because there is no `tsconfig.js` to emit.
 */
function configInputs() {
  return [join(PLUGIN_DIR, "tsconfig.json"), join(PLUGIN_DIR, "package.json")].filter((file) =>
    existsSync(file),
  );
}

/** Everything the stamp records: the sources plus the config that produced them. */
function buildInputs() {
  return [...sourceFiles(), ...configInputs()];
}

/** The compiler version the build was made with, when it can be read. */
function installedTscVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(PLUGIN_DIR, "node_modules", "typescript", "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function readStamp(outDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(outDir, STAMP_NAME), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Compiled `.js` files present under `outDir` (posix, relative, sorted). */
function compiledOutputs(outDir) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.jsx?$/.test(entry.name)) found.push(relative(outDir, abs).split(sep).join("/"));
    }
  };
  walk(outDir);
  return found.sort();
}

/**
 * Why `outDir` is — or is not — a usable build of the current sources.
 *
 * Four things must hold, and each one is a way the previous single-marker check
 * went green on bytes that were not the sources:
 *
 *   1. a stamp exists and matches this module's format;
 *   2. the source **set** is unchanged (added/removed files invalidate);
 *   3. every source file's mtime is the one recorded at build time (so a touched
 *      or reverted file invalidates even when its size did not change);
 *   4. every source still has its compiled `.js`, the `package.json` marker is
 *      there, and no `.js` is left over from a source that no longer exists.
 *   5. the files that decide *how* the sources compile (`tsconfig.json`,
 *      `package.json`) are the ones the build was made with, compared the same
 *      way — see `configInputs()`.
 *
 * `fresh === false` always carries at least one reason, so a rebuild can say
 * what changed instead of silently reusing (or silently recompiling).
 *
 * @param {string} outDir
 * @param {string[]} [sources] - pre-computed `sourceFiles()` result.
 * @returns {{ fresh: boolean, reasons: string[] }}
 */
function freshness(outDir, sources = sourceFiles()) {
  if (sources.length === 0) {
    // Fail closed: an empty set would make every check below pass for free.
    return { fresh: false, reasons: [`no TypeScript sources found under ${PLUGIN_DIR}`] };
  }

  const reasons = [];
  const stamp = readStamp(outDir);
  if (stamp === undefined) {
    reasons.push(`no ${STAMP_NAME} (build predates the stamp, or the compile was interrupted)`);
  } else if (stamp.version !== STAMP_VERSION) {
    reasons.push(`${STAMP_NAME} version ${String(stamp.version)} != ${STAMP_VERSION}`);
  } else {
    const recorded = stamp.sources !== null && typeof stamp.sources === "object" ? stamp.sources : {};
    const current = new Map();
    for (const file of sources) {
      try {
        current.set(relSource(file), statSync(file).mtimeMs);
      } catch {
        // Deleted between the listing and the stat: treat as "removed", which the
        // set comparison below already reports.
      }
    }
    const added = [...current.keys()].filter((rel) => !(rel in recorded));
    const removed = Object.keys(recorded).filter((rel) => !current.has(rel));
    const modified = [...current]
      .filter(([rel, mtime]) => rel in recorded && recorded[rel] !== mtime)
      .map(([rel]) => rel);
    if (added.length > 0) reasons.push(`source added since build: ${added.join(", ")}`);
    if (removed.length > 0) reasons.push(`source removed since build: ${removed.join(", ")}`);
    if (modified.length > 0) reasons.push(`source modified since build: ${modified.join(", ")}`);

    // The compiler inputs. A stamp without them predates this check and cannot
    // prove anything about them, so it is stale rather than assumed equal.
    const recordedConfig = stamp.config !== null && typeof stamp.config === "object" ? stamp.config : undefined;
    if (recordedConfig === undefined) {
      reasons.push(`no compiler inputs recorded in ${STAMP_NAME} (build predates config tracking)`);
    } else {
      const changedConfig = configInputs()
        .map((file) => {
          const rel = relSource(file);
          let mtime;
          try {
            mtime = statSync(file).mtimeMs;
          } catch {
            return `${rel} (now unreadable)`;
          }
          if (!(rel in recordedConfig)) return `${rel} (not in the stamp)`;
          return recordedConfig[rel] === mtime ? undefined : rel;
        })
        .filter((rel) => rel !== undefined);
      if (changedConfig.length > 0) {
        reasons.push(`compiler input changed since build: ${changedConfig.join(", ")}`);
      }
    }

    const tsc = installedTscVersion();
    if (stamp.tsc !== undefined && tsc !== undefined && stamp.tsc !== tsc) {
      reasons.push(`typescript changed since build: ${stamp.tsc} -> ${tsc}`);
    }
  }

  const expected = new Map(sources.map((file) => [compiledPath(relSource(file)), relSource(file)]));
  const missing = [...expected.keys()].filter((rel) => !existsSync(join(outDir, rel)));
  if (missing.length > 0) reasons.push(`missing compiled output: ${missing.join(", ")}`);
  if (!existsSync(join(outDir, "package.json"))) {
    reasons.push("missing package.json marker (node would load the tree as ESM)");
  }
  const stray = compiledOutputs(outDir).filter((rel) => !expected.has(rel));
  if (stray.length > 0) {
    reasons.push(`compiled output with no source (left over from an older build): ${stray.join(", ")}`);
  }

  return { fresh: reasons.length === 0, reasons };
}

/** Whether `outDir` already holds a complete, up-to-date build. */
function isFresh(outDir) {
  return freshness(outDir).fresh;
}

/**
 * Build the plugin into `paseo-plugin/<dir>` and return that absolute path.
 *
 * @param {object} [options]
 * @param {string} [options.dir] - directory name under `paseo-plugin`
 *   (default `.dbg-harness`). Use a task-private name when several agents build
 *   in parallel.
 * @param {boolean} [options.force] - rebuild even when the existing build is fresh.
 * @param {boolean} [options.quiet] - do not write progress to stderr.
 * @returns {string} absolute path of the build directory, ready to `require`.
 */
function buildPlugin(options = {}) {
  const dir = options.dir ?? ".dbg-harness";
  const outDir = join(PLUGIN_DIR, dir);
  const quiet = options.quiet === true;

  if (options.force !== true) {
    const sources = sourceFiles();
    const state = freshness(outDir, sources);
    if (state.fresh) {
      if (!quiet) {
        process.stderr.write(`[harness] reusing plugin build at paseo-plugin/${dir}\n`);
      }
      return outDir;
    }
    if (!quiet) {
      process.stderr.write(
        `[harness] rebuilding plugin build at paseo-plugin/${dir}: ${state.reasons.join("; ")}\n`,
      );
    }
  }

  const tsc = join(PLUGIN_DIR, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) {
    throw new Error(
      `typescript is not installed at ${tsc}; run \`npm install\` in paseo-plugin first`,
    );
  }

  // Snapshot before compiling. If a source changes mid-build the stamp keeps the
  // old mtime, so the next run rebuilds instead of trusting a mixed tree. The
  // compiler inputs are snapshotted here too, for the same reason: a `tsconfig`
  // edited while `tsc` runs must leave a stamp that disagrees with it.
  const snapshot = new Map(sourceFiles().map((file) => [relSource(file), statSync(file).mtimeMs]));
  const configSnapshot = new Map(
    configInputs().map((file) => [relSource(file), statSync(file).mtimeMs]),
  );

  rmSync(outDir, { recursive: true, force: true });
  if (!quiet) {
    process.stderr.write(`[harness] compiling plugin to paseo-plugin/${dir} (type errors are expected)\n`);
  }
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      "--noEmit", "false",
      "--outDir", dir,
      "--declaration", "false",
      "--module", "commonjs",
      "--moduleResolution", "node",
    ],
    { cwd: PLUGIN_DIR, encoding: "utf8", timeout: 300_000 },
  );

  const missing = [...snapshot.keys()]
    .map((rel) => compiledPath(rel))
    .filter((rel) => !existsSync(join(outDir, rel)));
  if (result.status !== 0 && missing.length > 0) {
    throw new Error(
      `plugin compile produced no usable output (exit ${String(result.status)}); `
        + `missing ${missing.join(", ")}:\n`
        + `${(result.stderr ?? "").split("\n").slice(-15).join("\n")}`,
    );
  }
  if (!quiet && missing.length > 0) {
    process.stderr.write(
      `[harness] warning: tsc exited ${String(result.status)} but emitted no output for ${missing.join(", ")}\n`,
    );
  }

  // The compiled tree is CommonJS even though `paseo-plugin/package.json` may
  // not say so; without this marker `node` treats the `.js` files as ESM.
  writeFileSync(join(outDir, "package.json"), '{"type":"commonjs"}\n');
  writeFileSync(
    join(outDir, STAMP_NAME),
    `${JSON.stringify(
      {
        version: STAMP_VERSION,
        builtAt: new Date().toISOString(),
        tsc: installedTscVersion(),
        sources: Object.fromEntries(snapshot),
        config: Object.fromEntries(configSnapshot),
      },
      null,
      2,
    )}\n`,
  );
  return outDir;
}

/**
 * The build directory a harness script should use.
 *
 * `PASEO_PLUGIN_BUILD` lets a caller (or the Lead) point every check at one
 * build instead of paying for a private copy each time; it must be a path
 * inside `paseo-plugin` for the same `node_modules` reason.
 *
 * This is the one path where freshness is **not enforced**: the tree belongs to
 * the caller, and a harness must not delete a build another agent is using.
 * That also makes it the quietest way to end up testing old bytes, so the skip
 * is announced on every run and a stamp that disagrees with the sources is
 * called out (the tree is still used — only the silence is removed).
 */
function buildDirFromEnv() {
  const configured = process.env.PASEO_PLUGIN_BUILD;
  if (configured === undefined || configured === "") return undefined;
  const outDir = resolve(configured);
  const state = freshness(outDir);
  process.stderr.write(
    `[harness] PASEO_PLUGIN_BUILD=${outDir}: trusting external build, freshness not enforced\n`,
  );
  if (!state.fresh) {
    process.stderr.write(
      `[harness] warning: external build may not match the sources (${state.reasons.join("; ")})\n`,
    );
  }
  return outDir;
}

/**
 * Resolve the compiled plugin directory for a check.
 *
 * Precedence: an explicit `argv` path, then `PASEO_PLUGIN_BUILD`, then a fresh
 * build in `paseo-plugin/<dir>`.
 *
 * @param {string | undefined} explicit - a path passed on the command line.
 * @param {string} dir - private build directory name for the auto-build case.
 * @returns {string}
 */
function resolvePluginBuild(explicit, dir) {
  if (explicit !== undefined && explicit !== "") {
    const outDir = resolve(explicit);
    process.stderr.write(
      `[harness] using build at ${outDir} from the command line, freshness not enforced\n`,
    );
    return outDir;
  }
  const fromEnv = buildDirFromEnv();
  if (fromEnv !== undefined) return fromEnv;
  return buildPlugin({ dir });
}

module.exports = {
  buildDirFromEnv,
  buildPlugin,
  buildInputs,
  configInputs,
  freshness,
  isFresh,
  resolvePluginBuild,
  sourceFiles,
  PLUGIN_DIR,
  STAMP_NAME,
  STAMP_VERSION,
};
