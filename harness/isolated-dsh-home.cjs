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
 *   3. copy the bridge the plugin provisions beside the profiles
 *      (`$DSH_HOME_SOURCE/profiles/node_modules/dsh-paseo-bridge`) when the
 *      source has it. It lives outside the profile directory, so a profile-only
 *      clone has no bridge at all — and the scripts that start `dsh --profile`
 *      on the clone without running bootstrap first (`route-test`,
 *      `stream-probe`, `tools`, `catalog`, `probe`, `rewind-e2e`,
 *      `rewind-merge-e2e`) would boot a profile DSH composes without the bridge
 *      layer (it only prints `skipping profile bundle "dsh-paseo-bridge"`). The
 *      copy is dereferenced on purpose: a symlink would let the clone write
 *      back into the user's live home. A source without the anchor (a
 *      pre-migration install, or a home that never ran the plugin) keeps the
 *      old behaviour;
 *   4. symlink the credential files (never read or copy their bytes), so the
 *      route can authenticate while the secret stays in the user's own file;
 *   5. sandbox the options in that profile that escape the clone: a fixed
 *      listener port and a data directory under the user's own home. A real
 *      profile commonly pins `webserver` to one host:port for bookmarkable URLs
 *      (a real one commonly pins something like `127.0.0.1:44209`); a second DSH starting on the
 *      same port dies with `EADDRINUSE`, which every script here reads as a
 *      runtime failure. And `dsh-memory`'s `dataDir` often points at the live
 *      store — a clone that keeps it opens a second writer on the user's real
 *      database. See {@link sandboxClonedProfile}.
 *   6. optionally switch whole profile rows **off in the clone** (`disable`),
 *      for a check whose verdict must not depend on a third-party plugin the
 *      user happens to have installed. Only the clone is touched; a real home is
 *      never modified. See {@link sandboxClonedProfile}.
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

/**
 * The bridge bundle `bootstrap.ts` provisions beside the profiles.
 *
 * It must be listed here because it is no longer inside the profile directory:
 * cloning only `profiles/<name>` leaves the clone without a bridge, and a
 * `dsh --profile` boot on it silently composes without the bridge layer.
 */
const SHARED_BRIDGE_NAME = "dsh-paseo-bridge";

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
 * Normalise a `disable` list: unique, trimmed, non-empty ids.
 *
 * @param {unknown} disable
 * @returns {string[]}
 */
function normalizeIds(disable) {
  if (!Array.isArray(disable)) return [];
  const ids = [];
  for (const id of disable) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed !== "" && ids.includes(trimmed) === false) ids.push(trimmed);
  }
  return ids;
}

/**
 * Point the cloned profile's listener port and memory directory at the clone,
 * and switch the rows named by `disable` off — only inside this clone.
 *
 * Only the options that actually escape a throwaway home are rewritten, and
 * only inside this clone — the source profile is never touched (the clone is a
 * copy, and this runs on the copy). Both are matched by their entry id first, so
 * a `port:` under some other entry is left alone.
 *
 *   `- id: webserver`   `config.port: 4242` → `0`   (the OS picks a free port)
 *   `- id: dsh-memory`  `config.dataDir: /home/…/memory-paseo` → `<clone>/memory-paseo`
 *
 * `disable` is the way out of a structural problem rather than a config leak: a
 * check that measures the bridge must not fail because the *user's* profile
 * ships some third-party plugin whose behaviour is out of that check's scope.
 * The id is a profile row id, not a package name, so nothing here is specific to
 * one vendor's plugin; a caller passes the rows it needs off, and the row is
 * disabled by the same mechanism DSH itself uses in a patch file
 * (`disabled: true` under `- id: …`).
 *
 *   `- id: dsh-memory` (no `disabled:`) → `disabled: true` inserted after the id
 *   `- id: dsh-memory` `disabled: false` → rewritten to `true`
 *   an id with no block-style `- id: <id>` row → reported as `absent`
 *
 * Absence is not a failure: a profile without that plugin has nothing to
 * disable, and a caller that asks for it should still run. The three lists are
 * returned so the caller can print exactly what happened to the clone.
 *
 * The rewrite is line-scoped YAML editing on purpose — this helper is loaded by
 * `require()` from compiled scratch trees where the profile parser the doctor
 * resolves (`yaml` / `js-yaml`) is not guaranteed to be reachable. Only
 * block-style top-level rows are addressable (`- id: <id>` at column 0), which
 * is what DSH's own patch files use; flow style (`- {id: x}`) is out of scope
 * and is reported as `absent`.
 *
 * @param dir - the cloned profile directory.
 * @param home - the throwaway DSH home that was just created.
 * @param {string[]} [disable] - profile row ids to switch off in this clone.
 * @returns {{sandboxed: string[], disabled: string[], absent: string[]}}
 *   `sandboxed`: the option paths it rewrote, e.g. `["webserver.port", "dsh-memory.dataDir"]`;
 *   `disabled`: the row ids that are off in the clone now (rewritten or already off);
 *   `absent`: the requested ids that have no addressable row in the clone.
 */
function sandboxClonedProfile(dir, home, disable = []) {
  const patchPath = path.join(dir, "cordis.patch.yml");
  let text;
  try {
    text = fs.readFileSync(patchPath, "utf8");
  } catch {
    return { sandboxed: [], disabled: [], absent: normalizeIds(disable) }; // no patch file: nothing to rewrite
  }
  const wanted = normalizeIds(disable);
  const lines = text.split("\n");
  // Top-level list rows, as `[start, end)` line spans. A row that is not an
  // `id:` line (`- insert:` and friends) is still a boundary but not addressable.
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^- /.test(lines[index]) === false) continue;
    const item = /^- id:\s*(.+?)\s*$/.exec(lines[index]);
    rows.push({
      id: item === null ? undefined : item[1].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, ""),
      start: index,
      end: lines.length,
    });
  }
  for (let index = 0; index + 1 < rows.length; index += 1) rows[index].end = rows[index + 1].start;

  const out = [];
  const sandboxed = [];
  const disabled = [];
  const absent = [];
  let cursor = 0;
  for (const row of rows) {
    while (cursor < row.start) out.push(lines[cursor++]);
    const body = lines.slice(row.start, row.end);
    cursor = row.end;
    const rewritten = [];
    for (const line of body) {
      if (row.id === "webserver") {
        const port = /^(\s+port:\s*)(\d+)\s*(#.*)?$/.exec(line);
        if (port !== null && Number(port[2]) !== 0) {
          rewritten.push(`${port[1]}0${port[3] === undefined ? "" : ` ${port[3]}`}`);
          sandboxed.push("webserver.port");
          continue;
        }
      }
      if (row.id === "dsh-memory") {
        const dataDir = /^(\s+dataDir:\s*)(\S+)\s*$/.exec(line);
        if (dataDir !== null) {
          const own = path.join(home, "memory-paseo");
          if (path.resolve(dataDir[2]) !== path.resolve(own)) {
            rewritten.push(`${dataDir[1]}${own}`);
            sandboxed.push("dsh-memory.dataDir");
            continue;
          }
        }
      }
      rewritten.push(line);
    }
    if (row.id !== undefined && wanted.includes(row.id)) {
      // Entry-level keys sit at two spaces under a `- id:` line (the shape DSH's
      // own patch files use); a deeper `disabled:` belongs to `config` and is
      // left alone.
      const at = rewritten.findIndex((line, index) => index > 0 && /^ {2}disabled:/.test(line));
      if (at < 0) {
        rewritten.splice(1, 0, "  disabled: true");
      } else {
        const comment = /^ {2}disabled:\s*[^#\n]*?(#.*)?$/.exec(rewritten[at]);
        rewritten[at] = `  disabled: true${comment?.[1] === undefined ? "" : ` ${comment[1]}`}`;
      }
      if (disabled.includes(row.id) === false) disabled.push(row.id);
    }
    out.push(...rewritten);
  }
  while (cursor < lines.length) out.push(lines[cursor++]);
  for (const id of wanted) {
    if (disabled.includes(id) === false && absent.includes(id) === false) absent.push(id);
  }
  const next = out.join("\n");
  if (next === text) return { sandboxed, disabled, absent };
  fs.writeFileSync(patchPath, next);
  return { sandboxed, disabled, absent };
}

/**
 * Prepare the DSH home this run will use.
 *
 * `disable` only ever applies to the throwaway clone. A `DSH_HOME` the caller
 * prepared is theirs to shape, and the live `~/.dsh` (or `--allow-real-profile`)
 * must never be modified by a diagnostic — in both modes the requested ids are
 * returned as `disableRequested` and nothing is written, so a caller can say so
 * out loud instead of silently measuring a profile that still has the plugin.
 *
 * @param {{script: string, profile?: string, argv?: string[], env?: NodeJS.ProcessEnv, disable?: string[]}} options
 * @returns {{mode: 'explicit'|'real'|'isolated', home: string, profile: string, cleanup: () => void, sandboxed?: string[], disabled?: string[], absent?: string[], disableRequested?: string[]}}
 */
function prepareDshHome({ script, profile, argv = process.argv.slice(2), env = process.env, disable = [] }) {
  const profileName = env.DSH_PASEO_PROFILE ?? profile ?? "paseo";
  const explicit = env.DSH_HOME;
  const disableRequested = normalizeIds(disable);
  if (explicit !== undefined && explicit.trim() !== "") {
    return {
      mode: "explicit",
      home: path.resolve(explicit),
      profile: profileName,
      cleanup() {},
      disableRequested,
    };
  }
  const allowReal = argv.includes("--allow-real-profile") || env.PASEO_ALLOW_REAL_DSH_HOME === "1";
  if (allowReal) {
    return {
      mode: "real",
      home: path.join(os.homedir(), ".dsh"),
      profile: profileName,
      cleanup() {},
      disableRequested,
    };
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
  // The clone must not compete with the live DSH for a pinned port, nor write
  // the live memory store, nor keep a third-party plugin the caller needs out of
  // the measurement. See {@link sandboxClonedProfile}.
  const sandbox = sandboxClonedProfile(path.join(home, "profiles", profileName), home, disableRequested);
  // The bridge is outside the profile directory (see SHARED_BRIDGE_NAME). Copy
  // it only when the source has it: a pre-migration home keeps it inside the
  // profile and a never-provisioned home has none, and inventing one would make
  // the clone lie about what DSH would compose. `dereference: true` here on
  // purpose: if the source anchor is a symlink (install.sh creates one), a
  // copied symlink would point back at the checkout and the clone's writes would
  // land in the live home.
  const sourceBridge = path.join(source, "profiles", "node_modules", SHARED_BRIDGE_NAME);
  if (fs.existsSync(path.join(sourceBridge, "package.json"))) {
    try {
      fs.cpSync(sourceBridge, path.join(home, "profiles", "node_modules", SHARED_BRIDGE_NAME), {
        recursive: true,
        dereference: true,
        force: true,
      });
    } catch (error) {
      removeTree(home);
      throw new Error(`could not copy the shared-anchor bridge into the private DSH_HOME: ${error.message}`);
    }
  }
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
  return {
    mode: "isolated",
    home,
    profile: profileName,
    cleanup,
    sandboxed: sandbox.sandboxed,
    disabled: sandbox.disabled,
    absent: sandbox.absent,
    disableRequested,
  };
}

/** Print the first lines that tell the operator which home is in play. */
function announceDshHome(result) {
  const label =
    result.mode === "real"
      ? "REAL ~/.dsh (--allow-real-profile: this run may write sessions and the live profile)"
      : result.mode === "explicit"
        ? "explicit DSH_HOME (caller prepared)"
        : "isolated (throwaway clone; the live ~/.dsh is read-only)";
  const sandboxed =
    result.sandboxed === undefined || result.sandboxed.length === 0
      ? ""
      : `; sandboxed ${result.sandboxed.join(", ")}`;
  console.log(`DSH home: ${label} — ${result.home} (profile ${result.profile}${sandboxed})`);
  // Say what was switched off, not just what was redirected: a check's verdict
  // now depends on which rows are live, so the run has to state that up front.
  const disabled = Array.isArray(result.disabled) ? result.disabled : [];
  if (disabled.length > 0) {
    console.log(`profile rows disabled in the clone (never in the live profile): ${disabled.join(", ")}`);
  }
  const absent = Array.isArray(result.absent) ? result.absent : [];
  if (absent.length > 0) {
    console.log(
      `no block-style "- id: <id>" row for ${absent.join(", ")} in the cloned profile — nothing to disable, not a failure`,
    );
  }
  const requested = Array.isArray(result.disableRequested) ? result.disableRequested : [];
  if (requested.length > 0 && result.mode !== "isolated") {
    console.log(
      `asked to disable ${requested.join(", ")}, but this run does not use a clone — the rows were left alone`,
    );
  }
}

module.exports = { announceDshHome, prepareDshHome, sourceHome };
