/**
 * `paseo-dsh doctor` — one-command self-check for a DeepSeek Harness × Paseo
 * install.
 *
 * It verifies the things that silently break a fresh install: the CLIs are
 * present, the plugin has provisioned the DSH profile (which only happens once
 * the daemon loads the plugin), the bridge is materialized, a model route is
 * actually configured, and every referenced `apiKeyEnv` has a credential.
 *
 * "The file is there" is not enough for any of them, and each gap used to end
 * in `All checks passed` on an install DSH cannot run:
 *
 *   - a profile directory without `package.json` is a profile DSH says does not
 *     exist (`loadProfile()` in `dsh-app-boot`), and a `package.json` whose
 *     `dsh.profile.bundles` omits `dsh-paseo-bridge` boots a profile with no
 *     bridge at all — the plugin only writes that file when it is absent
 *     (`writeIfAbsent()` in bootstrap.ts), so an existing profile keeps a list
 *     without the bridge;
 *   - a loader patch entry is applied by *id* against the composed tree and
 *     skipped with a warning when its `name` does not match that row's
 *     (`applyEntryPatches()` in `dsh-app-boot`), so a typo leaves the base
 *     default route in place while the profile patch looks configured;
 *   - `dsh-credentials-local` refuses a credentials document that is not
 *     `version: 1`, is readable beyond its owner, or names a ref outside
 *     `/^[A-Za-z_][A-Za-z0-9_]*$/` — the plugin never sees those files, so a
 *     hand-written one can stop DSH from activating at all.
 *
 * The composition check is the one place doctor does not only read: DSH's own
 * `dsh --profile <p> --dump-config` rewrites the profile's generated
 * `cordis.yml` root file (constant content, rewritten on every boot). Nothing
 * else is written, and judging the patch with DSH's algorithm instead of a
 * second implementation is what makes the verdict the one DSH will reach.
 *
 * ### What "configured" has to mean
 *
 * The check used to ask whether the words `agent-default-model` and `providers:`
 * appear. A file with `provider:` present and *empty* satisfied that, and so did
 * a file with a YAML syntax error on the next line — both reported `ok` with no
 * detail, and a fresh install that could not possibly run printed
 * "All checks passed". The route and credential checks now read the *parsed*
 * document: the route has to name a non-empty provider/model in
 * `agent-default-model.config`, that provider has to be a key of the composed
 * `llm-pi-ai.config.providers`, and every referenced `apiKeyEnv` needs a
 * non-empty string under `.credentials.yaml`'s `refs:`.
 *
 * YAML syntax is parsed for real when a parser resolves — from the plugin's own
 * `node_modules` in a development checkout, or from the DSH install in a
 * published one (`loadYaml`). The second place is what makes this check real for
 * an install from npm: the plugin ships no `node_modules`, so the plugin-local
 * lookup alone found nothing and every such install got `[warn]` + exit 0 for a
 * patch file that was not YAML. When neither place resolves, that is **said out
 * loud** rather than assumed away, because "we could not check this" and "this
 * is fine" are different answers and only one of them is honest.
 *
 * @module paseo-dsh/lib/doctor
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

/** Paseo gained the direct-provider-plugin API in this release. */
const MINIMUM_PASEO = "0.9.2";

/**
 * The DSH version this build was verified against (`0.2.1-rc.2`, 2026-10-20).
 *
 * The bridge imports five DSH-internal packages (`@deepseek-ai/dsh-cmdline`,
 * `dsh-brand`, `dsh-llm`, `dsh-attachment`, `dsh-agent`), and 0.2.1 changed both
 * the prompt-variable registry and catalog materialization. An older line is a
 * blocking issue, not a warning: the plugin's version line tracks DSH only at
 * `major.minor`, which cannot tell `0.2.0` from `0.2.1`.
 */
const MINIMUM_DSH = "0.2.1";

/** The bundle package `bootstrap.ts` writes into `dsh.profile.bundles`. */
const BRIDGE_PACKAGE = "dsh-paseo-bridge";

/**
 * The ref-name grammar `dsh-credentials` enforces (`REF_PATTERN` in its
 * `lib/index.js`): `parseRefs()` runs every `refs:` key through it and rejects
 * the whole document on a miss, so `MY.GATEWAY_KEY` never resolves.
 */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Permission bits outside the owner. `dsh-credentials-local` refuses to load a
 * credentials document carrying any of them (`assertOwnerOnly()`, before the
 * file is even read); the provider writes and replaces the file at `0600`.
 */
const CREDENTIALS_GROUP_OTHER = 0o77;

/** How long `dsh --dump-config` may take before the composition is called unjudged. */
const DUMP_TIMEOUT_MS = 20_000;

// `doctor | head -1` closes stdout early. Unhandled, that dies with an
// `'error'` event and exit code 1 — which is exactly the code that means
// "blocking issue", so a consumer cannot tell a crash from a diagnosis.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw error;
});

let results = [];
function report(level, label, detail) {
  results.push(level);
  const tag =
    level === "ok" ? `${GREEN}ok  ${RESET}` : level === "warn" ? `${YELLOW}warn${RESET}` : `${RED}fail${RESET}`;
  process.stdout.write(`  [${tag}] ${label}${detail ? `\n         ${DIM}${detail}${RESET}` : ""}\n`);
}

function run(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // Exit 0 with nothing on stdout is not a version, and treating `""` as one
    // printed `[ok] dsh ` with the line check silently skipped.
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/** Read a file the doctor needs, reporting the reason instead of throwing. */
function readText(path) {
  try {
    return { text: readFileSync(path, "utf8") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The POSIX mode of a path, or `undefined` when it cannot be read. */
function statMode(path) {
  try {
    return statSync(path).mode;
  } catch {
    return undefined;
  }
}

/**
 * Whether the profile directory is a DSH profile package that loads the bridge.
 *
 * DSH resolves a profile by its `package.json` (`loadProfile()` in
 * `dsh-app-boot`): without one it either initializes a shipped template or
 * throws `profile "<name>" does not exist`, and with one it composes exactly
 * the bundles under `dsh.profile.bundles`. The bridge is a bundle package, not
 * a plugin the profile picks up on its own, so a list without
 * `dsh-paseo-bridge` boots a perfectly healthy DSH that never answers
 * `initialize` — while this doctor used to report the directory alone as `ok`.
 *
 * `bootstrap.ts` writes the manifest with `writeIfAbsent()`, deliberately: the
 * file belongs to the user. A profile that predates the plugin, or one the user
 * edited, keeps its own list, so "the plugin creates it on load" does not
 * repair this and the doctor has to name the exact missing entry.
 *
 * @param profileDir - absolute profile directory.
 * @param profile - profile name, for the diagnostic.
 * @returns {{ ok: true } | { ok: false, label: string, detail: string }}
 */
function profileBundleVerdict(profileDir, profile) {
  const manifestPath = join(profileDir, "package.json");
  const read = readText(manifestPath);
  if (read.error !== undefined) {
    if (!existsSync(manifestPath)) {
      return {
        ok: false,
        label: `DSH profile "${profile}" has no package.json`,
        detail:
          `expected ${manifestPath}; without it DSH reports the profile does not exist. The plugin writes it when it ` +
          `provisions the profile — reinstall the plugin and restart the daemon, or create the file with ` +
          `"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "${BRIDGE_PACKAGE}"] } }.`,
      };
    }
    return {
      ok: false,
      label: `DSH profile package.json is unreadable`,
      detail: `${manifestPath}: ${read.error}; DSH cannot load a profile it cannot read.`,
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(read.text);
  } catch (error) {
    return {
      ok: false,
      label: `DSH profile package.json is not valid JSON`,
      detail: `${manifestPath}: ${error instanceof Error ? error.message : String(error)}; DSH fails to boot this profile.`,
    };
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      ok: false,
      label: `DSH profile package.json does not hold an object`,
      detail: `${manifestPath}; DSH refuses a profile manifest that is not a JSON object.`,
    };
  }
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) {
    return {
      ok: false,
      label: `DSH profile declares no bundle list`,
      detail:
        `${manifestPath} has no "dsh.profile.bundles" array, so DSH boots this profile with no bundles at all and ` +
        `the bridge is never loaded. Add "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "${BRIDGE_PACKAGE}"] } }.`,
    };
  }
  if (!bundles.includes(BRIDGE_PACKAGE)) {
    return {
      ok: false,
      label: `DSH profile does not load the bridge bundle`,
      detail:
        `"${BRIDGE_PACKAGE}" is missing from dsh.profile.bundles in ${manifestPath}; DSH boots without the bridge ` +
        `and every session waits for initialize until it times out. Add "${BRIDGE_PACKAGE}" to that list (keep the ` +
        `other entries) and restart the daemon.`,
    };
  }
  return { ok: true };
}

/**
 * Compose the profile through DSH's own patch algorithm and report what it skipped.
 *
 * `dsh --profile <p> --dump-config` is the launcher's offline composition
 * (`runDumpConfig()` → `renderConfigDump()` in `dsh-app-boot`): it stacks the
 * bundle layers and the profile's `cordis.patch.yml` with the same
 * `applyEntryPatches()` the boot include uses. Every patch it cannot apply is a
 * warning on stderr — a `name` that does not match the composed row, an `id`
 * that matches nothing, an insert into a missing group, a bundle that failed to
 * load — and the boot itself prints those once and carries on. That is why a
 * route can look configured in the profile patch while the running profile is
 * on the base default: the patch was skipped, and only this warning says so.
 *
 * The dump is not a pure read: DSH rewrites the profile's generated
 * `cordis.yml` root file (constant content; the same write happens on every
 * boot). Nothing else is touched.
 *
 * @param profile - profile name.
 * @returns {{ status: number|null, stderr: string, error?: Error }}
 */
function dumpProfile(profile) {
  const result = spawnSync("dsh", ["--profile", profile, "--dump-config"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    timeout: DUMP_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
  };
}

/**
 * The composition diagnostics DSH printed, one per line.
 *
 * Everything the dump reports is either a skipped patch entry
 * (`dsh: [<layer>] patch: …`) or a bundle that failed to load
 * (`dsh: skipping profile bundle "…": …`); there is no benign `dsh:` line on
 * this path. They are kept verbatim so the doctor can quote DSH instead of
 * paraphrasing it.
 */
function dumpDiagnostics(stderr) {
  return stderr
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("dsh: "));
}

/** DSH's diagnostics for one detail line, quoting DSH and capping the list. */
function quoteDiagnostics(entries) {
  const shown = entries.slice(0, 3).map((entry) => entry.replace(/^dsh: /, ""));
  const more = entries.length > shown.length ? ` (+${String(entries.length - shown.length)} more)` : "";
  return `${shown.join("; ")}${more}.`;
}

/**
 * The first line of a failed dump that names the failure, without the stack.
 *
 * A failed `--dump-config` prints an uncaught error, so stderr starts with a
 * `file://…` frame and ends with `Node.js v…`; the one useful line is the
 * `Error: dsh: …` message.
 */
function dumpFailure(dumped) {
  if (dumped.error !== undefined) {
    if (dumped.error.code === "ETIMEDOUT") return `dsh --dump-config did not finish within ${DUMP_TIMEOUT_MS / 1000}s`;
    return `could not run dsh --dump-config (${dumped.error.message})`;
  }
  for (const entry of dumped.stderr.split("\n")) {
    const text = entry.trim();
    const wrapped = /^Error: (dsh: .*)$/.exec(text);
    if (wrapped !== null) return wrapped[1];
    if (text.startsWith("dsh: ")) return text;
  }
  return `dsh --dump-config exited ${String(dumped.status)} without a diagnostic`;
}

/**
 * Whether a document is the pre-release flat credentials layout DSH migrates.
 *
 * `renderFlatLayoutMigration()` in `dsh-credentials-local` recognizes exactly a
 * non-empty top-level mapping of ref names to non-empty string scalars, with no
 * `version` key and no document directives; it then rewrites the file as
 * `version: 1` + `refs:` and boots. Failing that layout here would be a false
 * red on a file DSH is about to upgrade, so the doctor accepts it too — and
 * says so, because the rewrite is about to happen.
 *
 * @param text - the document's text (directive lines are matched on it).
 * @param root - the parsed document.
 */
function isFlatLayout(text, root) {
  const keys = Object.keys(root);
  if (keys.length === 0) return false;
  if (/^(%|---|\.\.\.)/m.test(text)) return false;
  for (const key of keys) {
    if (key === "version") return false;
    if (!CREDENTIAL_REF.test(key)) return false;
    const value = root[key];
    if (typeof value !== "string" || value.length === 0) return false;
  }
  return true;
}

/**
 * Check a parsed credentials document against the contract DSH enforces.
 *
 * The reference implementation is `dsh-credentials-local/lib/index.js`:
 * `parseCredentialsDocument()` requires a non-empty document to declare
 * `version: 1` and validates `refs` with `parseRefs()` (the `credentialRef()`
 * grammar from `dsh-credentials/lib/index.js`, non-empty string values);
 * `renderFlatLayoutMigration()` is the one accepted legacy layout. A document
 * that fails any of those is refused before a single credential is read, so
 * the doctor must not report `credential … found` for one.
 *
 * The `records` section (machine-written by the Models page) is not inspected;
 * see the delivery note on the audit item.
 *
 * @param document - the parsed YAML document.
 * @param text - its text, for the flat-layout recognizer.
 * @param path - absolute path, for the repair instructions.
 * @returns {{ refs: Record<string, unknown>, problems: { label: string, detail: string }[], legacy: boolean }}
 */
function credentialContract(document, text, path) {
  const problems = [];
  const root = document === null ? {} : document;
  if (typeof root !== "object" || Array.isArray(root)) {
    return {
      refs: {},
      legacy: false,
      problems: [
        {
          label: "credentials document is not a mapping",
          detail: `${path} must hold a YAML mapping with "version: 1" and "refs:" at the top level.`,
        },
      ],
    };
  }
  const keys = Object.keys(root);
  if (keys.length === 0) return { refs: {}, problems, legacy: false };
  let legacy = false;
  if (!("version" in root)) {
    if (isFlatLayout(text, root)) legacy = true;
    else
      problems.push({
        label: "credentials document has no version: 1",
        detail:
          `${path} uses the pre-release flat layout, which DSH rejects: add "version: 1" as the first line and ` +
          `nest the existing ${String(keys.length)} ${keys.length === 1 ? "entry" : "entries"} under "refs:" ` +
          `(no value needs to change).`,
      });
  } else if (root.version !== 1) {
    problems.push({
      label: `credentials document declares version ${JSON.stringify(root.version)}`,
      detail: `${path} must say "version: 1" (a number, unquoted); this DSH build reads version 1 only.`,
    });
  }
  const section = legacy ? root : root.refs;
  if (section !== undefined && section !== null && (typeof section !== "object" || Array.isArray(section))) {
    problems.push({
      label: "credentials refs is not a mapping",
      detail: `"refs:" in ${path} must be a mapping of NAME: <key>; DSH rejects the whole document otherwise.`,
    });
    return { refs: {}, problems, legacy };
  }
  const refs = section ?? {};
  for (const [name, value] of Object.entries(refs)) {
    if (!CREDENTIAL_REF.test(name))
      problems.push({
        label: `credentials ref "${name}" is not a valid name`,
        detail:
          `DSH requires /^[A-Za-z_][A-Za-z0-9_]*$/ (no dots or dashes) for a ref name; rename it in ${path}. ` +
          `The route's apiKeyEnv has to use the same name.`,
      });
    else if (typeof value !== "string" || value.length === 0)
      problems.push({
        label: `credentials ref "${name}" has no usable value`,
        detail: `the value for "${name}" in ${path} must be a non-empty string; quote it, or remove the key.`,
      });
  }
  return { refs, problems, legacy };
}

function findPaseo() {
  // Prefer the app-bundled CLI: a `paseo` on PATH is often a stale npm install.
  const bundled = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
  if (existsSync(bundled)) {
    const v = run(bundled, ["--version"]);
    if (v !== undefined) return { cmd: bundled, version: v };
  }
  const v = run("paseo", ["--version"]);
  if (v !== undefined) return { cmd: "paseo", version: v };
  return undefined;
}

function line(v) {
  return v.split("\n").find((entry) => entry.trim() !== "") ?? v;
}

/**
 * `>= minimum`, compared component by component.
 *
 * `Number(minor) < 9` called `paseo 0.9.0` fine although the plugin API needs
 * 0.9.2, and warned about `1.0.0`.
 */
function atLeast(version, minimum) {
  const parts = (value) => String(value).match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const got = parts(version);
  const want = parts(minimum);
  if (got === undefined || want === undefined) return false;
  for (let i = 0; i < 3; i += 1) {
    if (got[i] !== want[i]) return got[i] > want[i];
  }
  return true;
}

/** `major.minor.patch` plus the prerelease tag, or `undefined` when unreadable. */
function parseVersion(value) {
  const match = String(value ?? "").match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

/**
 * Compare only `major.minor.patch`.
 *
 * A prerelease of the minimum counts as the minimum: `0.2.1-rc.2` is the build
 * this repository was verified against, and semver would otherwise rank it below
 * `0.2.1` and fail the very version the project runs on.
 */
function compareCore(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

/** Parse one YAML document with whichever parser resolved (`yaml` or `js-yaml`). */
function parseYaml(yaml, text) {
  return yaml.name === "js-yaml" ? yaml.module.load(text) : yaml.module.parse(text);
}

/**
 * The loader patch entries of `cordis.patch.yml`, or an error.
 *
 * DSH parses this file as a *top-level YAML array* of loader patch entries and
 * fails the whole profile when it is anything else, so "parsed as YAML" alone is
 * not enough: a mapping with the right words in it is still not a patch list.
 */
function patchEntries(document) {
  if (!Array.isArray(document)) return { error: "it is not a top-level YAML array of loader patch entries" };
  const entries = [];
  for (const [index, entry] of document.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: `entry ${index + 1} is not a mapping (a loader patch entry)` };
    }
    entries.push(entry);
  }
  return { entries };
}

/**
 * The patch entry with this `id`, with later same-id entries folded in.
 *
 * The profile patch is a loader patch list: each entry targets a *composed*
 * entry by id and sets fields on it. Two entries with the same id are not two
 * routes, they are two overrides — the later value wins, and `config` replaces
 * the whole config object (`applyEntryPatches()`). Folding them here means the
 * doctor judges the same route DSH will compose instead of the first fragment.
 */
function entryById(entries, id) {
  let found;
  for (const entry of entries) {
    if (entry.id !== id) continue;
    found = found === undefined ? { ...entry } : { ...found, ...entry };
  }
  return found;
}

/** The `config.providers` dict of an `llm-pi-ai` entry, or undefined. */
function providerProfiles(entry) {
  const config = entry?.config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
  const providers = config.providers;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return undefined;
  return providers;
}

/**
 * Every file the bridge package must contain, taken from the generated
 * `server/bridge-assets.ts`.
 *
 * `ensurePaseoProfile()` (bootstrap.ts) writes *all* of `BRIDGE_FILES`, and only
 * that whole set is a bridge DSH can load: `lib/index.js` imports
 * `./transport.js` and `./server.js` when it loads, and those import the rest
 * (`child-anchors`, `revert`, `mcp-gateway`, …). Looking for the entry alone is
 * how a half-written bridge used to report `ok` while DSH printed
 * `ERR_MODULE_NOT_FOUND` without exiting and the plugin sat waiting for
 * `initialize` to time out.
 *
 * The generated module is TypeScript and `runDoctor()` is synchronous — the CLI
 * calls it without awaiting — so `import()` is out. Node 22.18+ can `require()`
 * a `.ts` file; older lines throw, and the keys are read out of the generated
 * source instead. That fallback is not a guess at the format: the generator
 * emits exactly one JSON-string key per entry (scripts/generate-bridge-assets.mjs)
 * and `harness/bridge-assets-check.mjs` parses the same block the same way. If
 * neither path yields a key, the caller says so rather than assuming the bridge
 * is complete.
 */
function loadBridgeFileList() {
  const assetsPath = join(HERE, "..", "server", "bridge-assets.ts");
  try {
    const assets = require(assetsPath);
    const files = assets?.BRIDGE_FILES;
    if (files !== null && typeof files === "object" && Object.keys(files).length > 0) {
      return { keys: Object.keys(files) };
    }
  } catch {
    // Older Node cannot require TypeScript; the source scan below covers it.
  }
  const read = readText(assetsPath);
  if (read.error !== undefined) return { error: `${assetsPath} is unreadable (${read.error})` };
  const block = /export const BRIDGE_FILES[^{]*\{([\s\S]*?)\n\};/.exec(read.text)?.[1];
  if (block === undefined) return { error: `BRIDGE_FILES not found in ${assetsPath}` };
  // A key line is a JSON string followed by `:`; the base64 values that follow
  // are bare string literals joined with `+`, so they cannot match this.
  const keys = [...block.matchAll(/^[ \t]*("(?:[^"\\]|\\.)*"):/gm)].map((match) => JSON.parse(match[1]));
  if (keys.length === 0) return { error: `BRIDGE_FILES has no entries in ${assetsPath}` };
  return { keys };
}

/**
 * Absolute path of `dsh` on PATH, or `undefined`.
 *
 * `which` is not used: it is a separate process, absent on some minimal hosts,
 * and `run("dsh", …)` has already proved the CLI is startable by the time this
 * matters.
 */
function whichDsh() {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry === "") continue;
    const candidate = join(entry, "dsh");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A `require` anchored at the DSH install, or `undefined`.
 *
 * This module cannot resolve `yaml` in a real install: `paseo-plugin/package.json`
 * declares no `dependencies`, and `files` does not ship `node_modules`, so both
 * `yaml` and `js-yaml` are dev-only and absent from what
 * `paseo plugin add npm:paseo-dsh` unpacks. DSH, on the other hand, carries a
 * YAML parser for its own config — and that is the parser `cordis.patch.yml` is
 * actually read by, so judging the file with the same implementation is the more
 * faithful answer than a repo-local dev copy.
 *
 * `dsh` on PATH is a symlink into the global install, so its realpath is walked
 * up to the package root that owns it. `undefined` when `dsh` is missing or the
 * layout does not match, and the caller then says the syntax was not validated.
 */
function dshPackageRequire() {
  const dsh = whichDsh();
  if (dsh === undefined) return undefined;
  try {
    let dir = dirname(realpathSync(dsh));
    // `/…/@deepseek-ai/dsh/lib/bin.js` -> the package root; the loop tolerates a
    // differently-shaped `bin` entry or a symlink into another directory.
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, "package.json"))) return createRequire(join(dir, "package.json"));
      dir = dirname(dir);
    }
  } catch {
    // Unresolvable `dsh` is not an error here: the dsh row above already reports
    // the CLI, and the YAML row reports that the syntax went unchecked.
  }
  return undefined;
}

/**
 * Whatever YAML parser this install happens to carry, or `undefined`.
 *
 * Two places, in this order: this module's own resolution chain (what a
 * development checkout has) and then the DSH install (what a published install
 * has). Only when neither resolves is the syntax reported as unvalidated — a
 * published install used to land there every time, which turned "this patch is
 * not YAML at all" into a `[warn]` and exit 0.
 */
function loadYaml() {
  for (const name of ["yaml", "js-yaml"]) {
    try {
      return { name, module: require(name) };
    } catch {
      // Try the next spelling; the caller reports when none resolves.
    }
  }
  const fromDsh = dshPackageRequire();
  if (fromDsh === undefined) return undefined;
  for (const name of ["yaml", "js-yaml"]) {
    try {
      return { name, module: fromDsh(name), viaDsh: true };
    } catch {
      // DSH may carry only one of the two.
    }
  }
  return undefined;
}

export function runDoctor() {
  results = [];

  const pluginRead = readText(join(HERE, "..", "package.json"));
  if (pluginRead.error !== undefined) {
    process.stderr.write(`cannot read the plugin's package.json: ${pluginRead.error}\n`);
    process.exitCode = 1;
    return;
  }
  const pluginVersion = JSON.parse(pluginRead.text).version;
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profileFromEnv = process.env.DSH_PASEO_PROFILE !== undefined;
  const profile = process.env.DSH_PASEO_PROFILE ?? "paseo";
  const profileDir = join(dshHome, "profiles", profile);

  process.stdout.write(`\n${DIM}paseo-dsh doctor  (plugin ${pluginVersion})${RESET}\n`);
  process.stdout.write(
    `${DIM}profile "${profile}" (${profileFromEnv ? "DSH_PASEO_PROFILE" : "default; the daemon must use the same value"})${RESET}\n\n`,
  );

  // 1. CLIs
  const dshVersion = run("dsh", ["--version"]);
  if (dshVersion === undefined) {
    report("fail", "dsh on PATH", "install the official DeepSeek Harness and put `dsh` on the daemon's PATH");
  } else {
    const dshLine = line(dshVersion);
    const got = parseVersion(dshLine);
    const minimum = parseVersion(MINIMUM_DSH);
    const pluginMM = pluginVersion.match(/^(\d+)\.(\d+)/);
    if (got === undefined) {
      // "We could not check this" and "this is fine" are different answers; the
      // bridge imports five DSH packages, so refuse to assume.
      report("warn", `dsh ${dshLine}`, `could not read a version; this plugin needs DSH >= ${MINIMUM_DSH}`);
    } else if (minimum !== undefined && compareCore(got, minimum) < 0) {
      report(
        "fail",
        `dsh ${dshLine}`,
        `needs DSH >= ${MINIMUM_DSH}: the bridge imports @deepseek-ai/dsh-{cmdline,brand,llm,attachment,agent}, and 0.2.1 changed prompt variables and catalog materialization`,
      );
    } else if (pluginMM && `${got.major}.${got.minor}` !== `${pluginMM[1]}.${pluginMM[2]}`) {
      report(
        "warn",
        `dsh ${dshLine}`,
        `plugin ${pluginVersion} targets the ${pluginMM[1]}.${pluginMM[2]}.x DSH line; this line was not verified`,
      );
    } else {
      report("ok", `dsh ${dshLine}`);
    }
  }

  const paseo = findPaseo();
  if (paseo === undefined) {
    report("fail", "paseo CLI not found", "expected `paseo` on PATH or /Applications/Paseo.app");
  } else if (!atLeast(paseo.version, MINIMUM_PASEO)) {
    report("fail", `paseo ${paseo.version}`, `needs Paseo >= ${MINIMUM_PASEO} for the direct provider plugin API`);
  } else {
    report("ok", `paseo ${paseo.version}`);
    // The profile can exist without the plugin — `install.sh` creates one too —
    // so "profile is there" never proved the plugin is.
    const listed = run(paseo.cmd, ["plugin", "ls"]);
    if (listed === undefined) {
      report("warn", "could not list Paseo plugins", "run `paseo plugin ls` to confirm dsh-paseo is enabled");
    } else {
      const row = listed.split("\n").find((entry) => entry.trimStart().startsWith("dsh-paseo"));
      if (row === undefined) {
        report(
          "fail",
          "dsh-paseo is not installed in Paseo",
          "install it with `paseo plugin add npm:paseo-dsh`; on Paseo 0.12 npm 0.2.9 predates the 0.12 adapter, so use the repo source: `paseo plugin add github:liuxing7954/paseo-dsh:paseo-plugin`",
        );
      } else if (!/\brunning\b/.test(row)) {
        report("warn", "dsh-paseo is installed but not running", "enable it and restart the daemon");
      } else {
        report("ok", "dsh-paseo plugin running");
      }
    }
  }

  // 2. profile provisioned by the plugin
  if (!existsSync(profileDir)) {
    report(
      "fail",
      `DSH profile "${profile}" missing`,
      `expected ${profileDir}. Install the plugin and restart the daemon — the plugin creates it on load.`,
    );
    finish();
    return;
  }
  report("ok", `DSH profile at ${profileDir}`);

  // The directory alone is not a profile DSH can load, and a profile whose
  // bundle list omits the bridge boots without it. Both were `ok` before.
  const profileBundle = profileBundleVerdict(profileDir, profile);
  if (profileBundle.ok) report("ok", `profile loads the ${BRIDGE_PACKAGE} bundle`);
  else report("fail", profileBundle.label, profileBundle.detail);

  const bridgeDir = join(profileDir, "node_modules", BRIDGE_PACKAGE);
  // Every file the plugin writes, not just the entry. `lib/index.js` exists in a
  // bridge missing `lib/child-anchors.js` and still fails to load, and that is
  // exactly the case this check used to call `ok` (see loadBridgeFileList).
  const bridgeFiles = loadBridgeFileList();
  if (bridgeFiles.error !== undefined) {
    // `fail`, not `warn`: the file list is generated from the plugin's own
    // `server/bridge-assets.ts`, so a run that cannot read it is a run that
    // cannot tell a complete bridge from a half-written one. Warning here and
    // then reporting the entry alone put "1 warning(s) — nothing blocking" and
    // exit 0 on a bridge missing 15 of 18 files, which is the same verdict a
    // working install gets for one DSH cannot load. "We could not check this"
    // and "this is fine" are different answers; the YAML row above already
    // refuses to conflate them.
    report(
      "fail",
      "bridge contents not verified",
      `${bridgeFiles.error}. The complete file list is required to judge the bridge, so this install ` +
        `cannot be called healthy; reinstall the plugin from a complete checkout, then restart the daemon.`,
    );
    const entryOnly = join(bridgeDir, "lib", "index.js");
    if (!existsSync(entryOnly)) {
      report("fail", "bridge bundle missing", `expected ${entryOnly}; restart the daemon to let the plugin re-provision`);
    }
  } else {
    const missing = bridgeFiles.keys.filter((relativePath) => !existsSync(join(bridgeDir, relativePath)));
    if (missing.length === 0) {
      report("ok", `bridge bundle provisioned (${bridgeFiles.keys.length} files)`, bridgeDir);
    } else {
      // Name the files: "the bridge is incomplete" leaves the user guessing which
      // half-written file to look at, and there is no partial repair to offer —
      // the plugin rewrites the whole package or nothing.
      const shown = missing.slice(0, 5).join(", ");
      const more = missing.length > 5 ? ` and ${missing.length - 5} more` : "";
      report(
        "fail",
        `bridge bundle incomplete — ${missing.length} of ${bridgeFiles.keys.length} files missing`,
        `missing: ${shown}${more}. Restart the Paseo daemon so the plugin re-provisions ${bridgeDir}; ` +
          `if it persists, delete that directory and restart`,
      );
    }
  }

  // 3. model route
  const patchPath = join(profileDir, "cordis.patch.yml");
  if (!existsSync(patchPath)) {
    report("fail", "no cordis.patch.yml", `the plugin should have written one at ${patchPath}`);
    finish();
    return;
  }
  const patchRead = readText(patchPath);
  if (patchRead.error !== undefined) {
    report("fail", "cordis.patch.yml is unreadable", patchRead.error);
    finish();
    return;
  }
  const patch = patchRead.text;

  const yaml = loadYaml();
  if (yaml === undefined) {
    // Semantics are judged on the parsed document now, so without a parser
    // there is nothing honest to say about the route or the credentials. Say
    // that out loud instead of falling back to the text scan that produced the
    // false greens this check exists to prevent.
    report(
      "warn",
      "YAML syntax not validated",
      "no YAML parser resolves from here; the route and credential semantics are not inspected either",
    );
    report("warn", "model route not verified", "no YAML parser resolves from here, so the parsed route cannot be judged");
    report("warn", "credentials not verified", "no YAML parser resolves from here, so refs: cannot be judged");
    finish();
    return;
  }
  let patchDocument;
  try {
    patchDocument = parseYaml(yaml, patch);
  } catch (error) {
    report("fail", "cordis.patch.yml is not valid YAML", String(error.message).split("\n")[0]);
    finish();
    return;
  }

  const patchList = patchEntries(patchDocument);
  if (patchList.error !== undefined) {
    report("fail", "cordis.patch.yml is not a loader patch list", patchList.error);
    finish();
    return;
  }
  const entries = patchList.entries;
  const defaultEntry = entryById(entries, "agent-default-model");
  const providers = providerProfiles(entryById(entries, "llm-pi-ai"));

  if (defaultEntry === undefined) {
    report(
      "fail",
      "no agent-default-model in the profile patch",
      `edit ${patchPath} (see the README install walkthrough) then restart the daemon`,
    );
  } else if (defaultEntry.disabled === true) {
    // DSH composes the patch by id: `disabled: true` turns the default-model
    // service off, so the route is not merely invalid — it is not active at all.
    report(
      "fail",
      "agent-default-model is disabled",
      `remove \`disabled: true\` from the agent-default-model entry in ${patchPath}`,
    );
  } else {
    const routeConfig = defaultEntry.config;
    const provider =
      routeConfig !== null && typeof routeConfig === "object" && !Array.isArray(routeConfig)
        ? routeConfig.provider
        : undefined;
    const model =
      routeConfig !== null && typeof routeConfig === "object" && !Array.isArray(routeConfig)
        ? routeConfig.model
        : undefined;
    // Non-empty *strings* after trimming: `provider: ""` and `provider:` both
    // used to satisfy the old regex, and a number is not a route id either.
    const providerName = typeof provider === "string" ? provider.trim() : "";
    const modelName = typeof model === "string" ? model.trim() : "";
    if (providerName === "" || modelName === "") {
      report(
        "fail",
        "model route is incomplete",
        `set both provider: and model: under agent-default-model in ${patchPath}`,
      );
    } else if (providers === undefined || Object.keys(providers).length === 0) {
      report(
        "fail",
        `model route references provider "${providerName}" but no providers are configured`,
        `add it under the llm-pi-ai entry's config.providers in ${patchPath}`,
      );
    } else if (!Object.prototype.hasOwnProperty.call(providers, providerName)) {
      report(
        "fail",
        `model route references unknown provider "${providerName}"`,
        `providers defined in ${patchPath}: ${Object.keys(providers).join(", ")}`,
      );
    } else {
      report("ok", "model route configured", `default: ${providerName} / ${modelName}`);
    }
  }

  // 3b. DSH must actually apply the patch, not skip it with a warning.
  // The dump is only meaningful once the profile is a profile DSH can load
  // (a missing package.json makes it print `profile does not exist`, which the
  // row above already reports) and once the dsh CLI was found.
  if (profileBundle.ok && dshVersion !== undefined) {
    const dumped = dumpProfile(profile);
    const diagnostics = dumpDiagnostics(dumped.stderr);
    const profileSkips = diagnostics.filter((entry) => entry.includes(`[${patchPath}]`));
    const skippedBundles = diagnostics.filter((entry) => /^dsh: skipping profile bundle "[^"]*":/.test(entry));
    const skippedBridge = skippedBundles.filter((entry) => entry.includes(`"${BRIDGE_PACKAGE}"`));
    const others = diagnostics.filter((entry) => !profileSkips.includes(entry) && !skippedBundles.includes(entry));
    const otherBundles = skippedBundles.filter((entry) => !skippedBridge.includes(entry));
    if (dumped.error !== undefined || dumped.status !== 0) {
      report(
        "fail",
        `DSH cannot compose profile "${profile}"`,
        `${dumpFailure(dumped)}. The bundle and patch layers were not composed, so DSH cannot boot this profile; ` +
          `fix that error (run \`dsh --profile ${profile} --dump-config\` for the full output) before anything else.`,
      );
    } else {
      if (profileSkips.length === 0 && skippedBridge.length === 0) {
        report(
          "ok",
          "profile patch applied by DSH",
          `dsh --profile ${profile} --dump-config composed it without skipping a patch entry`,
        );
      }
      if (profileSkips.length > 0) {
        // This is the silent failure the check exists for: `name` does not match
        // the composed row (or `id` matches nothing), DSH warns once at boot and
        // continues on the base route, and the patch file still looks right.
        report(
          "fail",
          `DSH skipped ${profileSkips.length === 1 ? "a patch entry" : `${String(profileSkips.length)} patch entries`} from ${patchPath}`,
          `${quoteDiagnostics(profileSkips)} Fix the entry's id/name so it matches the composed row, then restart ` +
            `the daemon; \`dsh --profile ${profile} --dump-config\` prints the same warning and the composed result.`,
        );
      }
      if (skippedBridge.length > 0) {
        report(
          "fail",
          `DSH skipped the ${BRIDGE_PACKAGE} bundle`,
          `${quoteDiagnostics(skippedBridge)} The bridge cannot answer a session unless DSH loads it; reinstall the ` +
            `plugin, then restart the daemon.`,
        );
      }
      if (others.length > 0 || otherBundles.length > 0) {
        report(
          "warn",
          "other profile composition warnings",
          `${quoteDiagnostics([...others, ...otherBundles])} These come from the bundle layers or the home-level ` +
            `$DSH_HOME/cordis.patch.yml, not from this profile's cordis.patch.yml; the profile still boots, but ` +
            `the affected rows are not applied.`,
        );
      }
    }
  }

  // 4. credentials: DSH's document contract first, then every referenced apiKeyEnv
  const credentialPath = join(dshHome, ".credentials.yaml");
  const credentialRead = readText(credentialPath);
  if (credentialRead.error !== undefined) {
    report("fail", `cannot read ${credentialPath}`, credentialRead.error);
    finish();
    return;
  }
  // DSH refuses the document before reading a single value when other OS users
  // can read it (`assertOwnerOnly()` in dsh-credentials-local), and a
  // hand-written file carries the umask's 0644 — the whole credentials service
  // then fails to activate and every turn waits on it.
  const credentialMode = statMode(credentialPath);
  if (
    process.platform !== "win32" &&
    credentialMode !== undefined &&
    (credentialMode & CREDENTIALS_GROUP_OTHER) !== 0
  ) {
    report(
      "fail",
      `credentials file is readable beyond its owner (mode ${(credentialMode & 0o777).toString(8)})`,
      `run "chmod 600 ${credentialPath}" — DSH refuses to start with a credentials document other users can read.`,
    );
  }
  let credentialDocument;
  try {
    credentialDocument = parseYaml(yaml, credentialRead.text);
  } catch {
    // Never echo the parser's message: it can quote the offending source line,
    // and this file is where the raw credentials live.
    report("fail", `${credentialPath} is not valid YAML`);
    finish();
    return;
  }
  // Judge the parsed document against the contract DSH enforces. A document
  // DSH refuses cannot yield a "found" credential, so the per-ref rows are
  // skipped rather than contradicting the blocking issue above them.
  const contract = credentialContract(credentialDocument, credentialRead.text, credentialPath);
  for (const problem of contract.problems) report("fail", problem.label, problem.detail);
  if (contract.problems.length > 0) {
    finish();
    return;
  }
  if (contract.legacy) {
    report(
      "ok",
      "credentials document uses the pre-release flat layout",
      `DSH migrates ${credentialPath} to "version: 1" + "refs:" in place on its next start; no hand edit needed.`,
    );
  }
  // `refs:` is the only place a credential may live: a key of the same name in
  // another top-level section (or after `refs:` has ended) is not one. Parsed
  // as an object, so YAML's own scoping decides that instead of a line window.
  const refsObject = contract.refs;
  const referenced = [];
  for (const profile of Object.values(providers ?? {})) {
    if (profile === null || typeof profile !== "object" || Array.isArray(profile)) continue;
    if (typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv.trim() !== "") referenced.push(profile.apiKeyEnv.trim());
  }
  const unique = [...new Set(referenced)];
  // A flat-layout document keeps its refs at the top level until DSH migrates
  // it; naming `refs:` there would produce the document the contract row above
  // rejects.
  const refLocation = contract.legacy ? "at the top level" : 'under "refs:"';
  if (unique.length === 0) {
    report("fail", "no apiKeyEnv referenced", "the route above should name the credential to use");
  } else {
    for (const name of unique) {
      // The value has to be a non-empty string: `NAME:` with nothing after it
      // parses as null and then 401'd on every turn.
      const value = refsObject[name];
      if (typeof value === "string" && value.trim() !== "") report("ok", `credential ${name} found`);
      else
        report(
          "fail",
          `credential ${name} missing`,
          // The repair has to produce a file DSH accepts: `refs:` without
          // `version: 1`, or a 0644 file, is refused before the key is read.
          `add "${name}: <your-key>" ${refLocation} in ${credentialPath}; the document needs "version: 1" at the ` +
            `top and mode 0600 (chmod 600 ${credentialPath}).`,
        );
    }
  }

  finish();
}

function finish() {
  const fails = results.filter((r) => r === "fail").length;
  const warns = results.filter((r) => r === "warn").length;
  process.stdout.write("\n");
  if (fails > 0) {
    process.stdout.write(`${RED}${fails} blocking issue(s)${RESET}${warns ? `, ${warns} warning(s)` : ""}.\n`);
    process.exitCode = 1;
  } else if (warns > 0) {
    process.stdout.write(
      `${YELLOW}${warns} warning(s)${RESET} — nothing blocking, but fix the above before relying on it.\n`,
    );
  } else {
    process.stdout.write(`${GREEN}All checks passed.${RESET} New a session in Paseo with provider "DeepSeek Harness".\n`);
  }
}
