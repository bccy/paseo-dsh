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
 * always documented by hand (see the headers of `plugin-check.cjs` /
 * `parked-sessions-check.cjs`), so this module just automates it:
 *
 *   - the output **must** live inside the repo (`paseo-plugin/<dir>`), because
 *     `node` resolves `@getpaseo/plugin` and friends by walking up to
 *     `paseo-plugin/node_modules`. A build under `/tmp` cannot see them and every
 *     `require` of the compiled output dies with MODULE_NOT_FOUND.
 *   - type errors are expected and ignored: `--moduleResolution node` cannot
 *     resolve the protocol package's ESM declarations. The emitted JS is what
 *     runs, exactly as in the documented manual steps.
 *   - the result is reused while it is newer than every source file, so a check
 *     run twice in a row pays the ~3s compile once.
 *
 * Callers pass the directory *name* (relative to `paseo-plugin`) so parallel
 * work never shares a build tree; the contract's rule is one private dir per
 * task, deleted when the task ends.
 */

"use strict";

const { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_DIR = resolve(__dirname, "..", "paseo-plugin");

/** Every source file whose change should invalidate a build. */
function sourceFiles() {
  const files = [];
  for (const dir of ["server", "client"]) {
    const abs = join(PLUGIN_DIR, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (/\.tsx?$/.test(name)) files.push(join(abs, name));
    }
  }
  return files;
}

/** Whether `outDir` already holds a build newer than every source file. */
function isFresh(outDir) {
  const marker = join(outDir, "server", "session.js");
  if (!existsSync(marker)) return false;
  const builtAt = statSync(marker).mtimeMs;
  return sourceFiles().every((file) => statSync(file).mtimeMs <= builtAt);
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
  if (options.force !== true && isFresh(outDir)) {
    if (options.quiet !== true) {
      process.stderr.write(`[harness] reusing plugin build at paseo-plugin/${dir}\n`);
    }
    return outDir;
  }
  rmSync(outDir, { recursive: true, force: true });

  const tsc = join(PLUGIN_DIR, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) {
    throw new Error(
      `typescript is not installed at ${tsc}; run \`npm install\` in paseo-plugin first`,
    );
  }
  if (options.quiet !== true) {
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
  if (result.status !== 0 && !existsSync(join(outDir, "server", "session.js"))) {
    throw new Error(
      `plugin compile produced no output (exit ${String(result.status)}):\n`
        + `${(result.stderr ?? "").split("\n").slice(-15).join("\n")}`,
    );
  }
  // The compiled tree is CommonJS even though `paseo-plugin/package.json` may
  // not say so; without this marker `node` treats the `.js` files as ESM.
  writeFileSync(join(outDir, "package.json"), '{"type":"commonjs"}\n');
  return outDir;
}

/**
 * The build directory a harness script should use.
 *
 * `PASEO_PLUGIN_BUILD` lets a caller (or the Lead) point every check at one
 * build instead of paying for a private copy each time; it must be a path
 * inside `paseo-plugin` for the same `node_modules` reason.
 */
function buildDirFromEnv() {
  const configured = process.env.PASEO_PLUGIN_BUILD;
  return configured === undefined || configured === "" ? undefined : resolve(configured);
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
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  const fromEnv = buildDirFromEnv();
  if (fromEnv !== undefined) return fromEnv;
  return buildPlugin({ dir });
}

module.exports = { buildDirFromEnv, buildPlugin, isFresh, resolvePluginBuild, sourceFiles, PLUGIN_DIR };
