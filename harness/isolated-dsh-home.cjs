/**
 * One-time DSH_HOME for the real-profile / real-model harness scripts.
 *
 * Those scripts used to inherit the live `~/.dsh`: `plugin-check` rewrote the
 * installed profile's embedded bridge, and `route-test` / `tools` / `stream-probe`
 * / the rewind e2e probes appended sessions, journals and frame logs to the
 * user's own session store. Running a diagnostic must not mutate the thing it is
 * diagnosing.
 *
 * The default is now a throwaway clone:
 *
 *   1. `mkdtemp()` a private home;
 *   2. copy the source profile (`$DSH_HOME_SOURCE/profiles/<name>`, default
 *      `~/.dsh/profiles/paseo`) into it — the profile is configuration, not
 *      state, and `plugin-check`'s `ensurePaseoProfile()` then rewrites the
 *      bridge **inside the copy**;
 *   3. symlink the credential files (never read or copy their bytes), so the
 *      route can authenticate while the secret stays in the user's own file.
 *
 * Ways to choose a home, in order:
 *
 *   DSH_HOME=<dir>            use that prepared tree as-is (the caller owns it);
 *   --allow-real-profile      use the live home; prints a warning banner;
 *   (default)                 create the private clone described above.
 *
 * The helper is CommonJS on purpose: `plugin-check.cjs` is compiled into
 * `paseo-plugin/.dbg` and loaded with `require()`, while the `.mjs` probes use
 * `createRequire(import.meta.url)`.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** The home the clone is built from (never written). */
function sourceHome(env = process.env) {
  const configured = env.DSH_HOME_SOURCE;
  return configured !== undefined && configured.trim() !== ""
    ? path.resolve(configured)
    : path.join(os.homedir(), ".dsh");
}

/** Remove a directory the caller owns, ignoring best-effort failures. */
function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp tree is not a test failure */
  }
}

/**
 * Prepare the DSH home this run will use.
 *
 * @param {{script: string, profile?: string, argv?: string[], env?: NodeJS.ProcessEnv}} options
 * @returns {{mode: 'explicit'|'real'|'isolated', home: string, profile: string, cleanup: () => void}}
 */
function prepareDshHome({ script, profile, argv = process.argv.slice(2), env = process.env }) {
  const profileName = env.DSH_PASEO_PROFILE ?? profile ?? "paseo";
  const explicit = env.DSH_HOME;
  if (explicit !== undefined && explicit.trim() !== "") {
    return { mode: "explicit", home: path.resolve(explicit), profile: profileName, cleanup() {} };
  }
  const allowReal = argv.includes("--allow-real-profile") || env.PASEO_ALLOW_REAL_DSH_HOME === "1";
  if (allowReal) {
    return { mode: "real", home: path.join(os.homedir(), ".dsh"), profile: profileName, cleanup() {} };
  }

  const source = sourceHome(env);
  const sourceProfile = path.join(source, "profiles", profileName);
  if (!fs.existsSync(sourceProfile)) {
    throw new Error(
      `no DSH profile "${profileName}" at ${sourceProfile}; ` +
        `set DSH_PASEO_PROFILE, prepare DSH_HOME yourself, or pass --allow-real-profile`,
    );
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${script}-`));
  fs.mkdirSync(path.join(home, "profiles"), { recursive: true });
  fs.cpSync(sourceProfile, path.join(home, "profiles", profileName), {
    recursive: true,
    dereference: false,
    force: true,
  });
  for (const name of [".credentials.yaml", ".credentials.yml", "credentials.json"]) {
    const from = path.join(source, name);
    if (!fs.existsSync(from)) continue;
    try {
      fs.symlinkSync(from, path.join(home, name));
    } catch (error) {
      removeTree(home);
      throw new Error(`could not link ${name} into the private DSH_HOME: ${error.message}`);
    }
  }
  process.env.DSH_HOME = home;
  const cleanup = () => removeTree(home);
  process.on("exit", cleanup);
  return { mode: "isolated", home, profile: profileName, cleanup };
}

/** Print the one line that tells the operator which home is in play. */
function announceDshHome(result) {
  const label =
    result.mode === "real"
      ? "REAL ~/.dsh (--allow-real-profile: this run may write sessions and the live profile)"
      : result.mode === "explicit"
        ? "explicit DSH_HOME (caller prepared)"
        : "isolated (throwaway clone; the live ~/.dsh is read-only)";
  console.log(`DSH home: ${label} — ${result.home} (profile ${result.profile})`);
}

module.exports = { announceDshHome, prepareDshHome, sourceHome };
