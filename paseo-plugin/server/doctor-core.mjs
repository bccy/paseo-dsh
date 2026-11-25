/**
 * Shared pure core for `paseo-dsh doctor` and the plugin server's
 * Environment & Route Overview (`server/diagnostics.ts`).
 *
 * Lives under `paseo-plugin/server/` (following the `server/dsh-command.mjs`
 * pattern) so that:
 *   1. `server/diagnostics.ts` imports it statically and Paseo's server
 *      bundler inlines it directly into the compiled server bundle with zero
 *      runtime filesystem lookup;
 *   2. `harness/plugin-build.cjs`'s `runtimeAssets()` copies it automatically
 *      alongside compiled CommonJS server modules;
 *   3. `lib/doctor.mjs` re-exports it cleanly for the standalone CLI
 *      (`bin/paseo-dsh.mjs doctor`) and `harness/doctor-check.mjs`.
 *
 * Runtime invariants:
 *   - Zero side effects at module evaluation (no stdout/exitCode mutations, no
 *     top-level `fileURLToPath(import.meta.url)` or `createRequire(import.meta.url)`):
 *     when Paseo bundles `index.server.ts` to CommonJS, `import.meta` becomes
 *     `{}` and `import.meta.url` is `undefined`.
 *   - No top-level `await`, so Node's synchronous `require(esm)` loads it from
 *     CommonJS harness builds and `register-typescript.cjs` tests.
 *   - Security invariant: raw `.credentials.yaml` contents, secret values, and
 *     YAML parser error snippets for `.credentials.yaml` are NEVER returned by
 *     any function in this module.
 *
 * @module paseo-dsh/server/doctor-core
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshCommand } from "./dsh-command.mjs";

/**
 * This build requires Paseo >= 0.16.0 and uses the stable workspace row badge
 * API (dev/test SDK version follows `paseo-plugin/package.json`). A beta
 * whose core digits are 0.16.0 does not satisfy the package/manifest >=0.16.0
 * floor. App and daemon versions can differ; the client guards its badge API.
 */
export const MINIMUM_PASEO = "0.16.0";

/**
 * The DSH compatibility floor; the latest tracked runtime is `0.2.2-rc.3`.
 *
 * The bridge imports nine internal/runtime packages (the authoritative list is
 * in `harness/dsh-api-contract-check.mjs`), and 0.2.1 changed both
 * the prompt-variable registry and catalog materialization. An older line is a
 * blocking issue, not a warning: the plugin's version line tracks DSH only at
 * `major.minor`, which cannot tell `0.2.0` from `0.2.1`.
 */
export const MINIMUM_DSH = "0.2.1";

/** The bundle package `bootstrap.ts` writes into `dsh.profile.bundles`. */
export const BRIDGE_PACKAGE = "dsh-paseo-bridge";

/**
 * The ref-name grammar `dsh-credentials` enforces (`REF_PATTERN` in its
 * `lib/index.js`): `parseRefs()` runs every `refs:` key through it and rejects
 * the whole document on a miss, so `MY.GATEWAY_KEY` never resolves.
 */
export const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Permission bits outside the owner. `dsh-credentials-local` refuses to load a
 * credentials document carrying any of them (`assertOwnerOnly()`, before the
 * file is even read); the provider writes and replaces the file at `0600`.
 */
export const CREDENTIALS_GROUP_OTHER = 0o77;

/** How long `dsh --dump-config` may take before the composition is called unjudged. */
export const DUMP_TIMEOUT_MS = 20_000;

/** Default timeout for short version/list CLI probes in async mode. */
const CLI_PROBE_TIMEOUT_MS = 5_000;

/** Maximum captured stderr bytes from `--dump-config` in async mode. */
const MAX_DUMP_STDERR_BYTES = 256 * 1024;

/**
 * Return this module's `file:` URL when loaded directly from disk, or
 * `undefined` when inlined into a CommonJS bundle (such as Paseo's esbuild
 * plugin bundle where `import.meta.url` is `undefined`).
 */
function moduleMetaUrl() {
  try {
    const url = import.meta.url;
    return typeof url === "string" && url.startsWith("file:") ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Infer the plugin root directory from this module's on-disk location
 * (`<pluginDir>/server/doctor-core.mjs`), or `undefined` when bundled.
 */
function defaultPluginDir() {
  const url = moduleMetaUrl();
  if (url !== undefined) {
    try {
      return resolve(dirname(fileURLToPath(url)), "..");
    } catch {
      /* ignore malformed URL */
    }
  }
  return undefined;
}

/**
 * Resolve a local CommonJS `require` anchored at this module when on disk
 * (preserving isolated sandbox resolution in `harness/doctor-check.mjs`), or
 * fall back to the bundled runtime's `require` when evaluated inside Paseo's
 * CommonJS bundle.
 */
function getLocalRequire() {
  const url = moduleMetaUrl();
  if (url !== undefined) {
    try {
      return createRequire(url);
    } catch {
      /* fall through */
    }
  }
  if (typeof require === "function") {
    return require;
  }
  return undefined;
}

function expandHomePath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Resolve `$DSH_HOME` consistently with DSH and `server/bootstrap.ts`.
 *
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveDshHome(env = process.env, cwd = process.cwd()) {
  const configured = env.DSH_HOME;
  if (configured !== undefined && configured.trim() !== "") {
    return resolve(cwd, expandHomePath(configured));
  }
  return join(homedir(), ".dsh");
}

function runSync(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: opts.env,
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
    }).trim();
    // Exit 0 with nothing on stdout is not a version, and treating `""` as one
    // printed `[ok] dsh ` with the line check silently skipped.
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * Terminate a child process cleanly, escalating to SIGKILL if it ignores SIGTERM.
 * All timers are unref'd so cleanup never keeps Node alive.
 */
function killChild(child) {
  if (child.killed || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }
  }, 400);
  forceTimer.unref?.();
}

function runAsync(cmd, args, opts = {}) {
  return new Promise((resolveRun) => {
    if (opts.signal?.aborted) {
      resolveRun(undefined);
      return;
    }
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "ignore"],
        env: opts.env,
        cwd: opts.cwd,
      });
    } catch {
      resolveRun(undefined);
      return;
    }

    let settled = false;
    let out = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolveRun(value);
    };

    const onAbort = () => {
      killChild(child);
      finish(undefined);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutMs = opts.timeoutMs ?? CLI_PROBE_TIMEOUT_MS;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killChild(child);
            finish(undefined);
          }, timeoutMs)
        : undefined;
    timer?.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (out.length < 64 * 1024) out += chunk;
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(undefined);
        return;
      }
      const trimmed = out.trim();
      finish(trimmed === "" ? undefined : trimmed);
    });
  });
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

/** Whether a path exists, including a dangling symlink (`existsSync` follows links). */
function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bridge package directories DSH resolves, in DSH's own order.
 *
 * @param {string} profileDir - absolute profile directory.
 * @param {string} dshHome - absolute `$DSH_HOME`.
 * @returns {{ local: string, shared: string }}
 */
export function bridgeLocations(profileDir, dshHome) {
  return {
    local: join(profileDir, "node_modules", BRIDGE_PACKAGE),
    shared: join(dshHome, "profiles", "node_modules", BRIDGE_PACKAGE),
  };
}

/**
 * Whether the profile directory is a DSH profile package that loads the bridge.
 *
 * @param {string} profileDir - absolute profile directory.
 * @param {string} profile - profile name, for the diagnostic.
 * @returns {{ ok: true, bundles: string[] } | { ok: false, bundles: string[], label: string, detail: string, fixHint: string }}
 */
export function profileBundleVerdict(profileDir, profile) {
  const manifestPath = join(profileDir, "package.json");
  const read = readText(manifestPath);
  if (read.error !== undefined) {
    if (!existsSync(manifestPath)) {
      return {
        ok: false,
        bundles: [],
        label: `DSH profile "${profile}" has no package.json`,
        detail:
          `expected ${manifestPath}; without it DSH reports the profile does not exist. The plugin writes it when it ` +
          `provisions the profile — reinstall the plugin and restart the daemon, or create the file with ` +
          `"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "${BRIDGE_PACKAGE}"] } }.`,
        fixHint:
          `Reload the dsh-paseo plugin or create ${manifestPath} with "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "${BRIDGE_PACKAGE}"] } }, then restart the Paseo daemon.`,
      };
    }
    return {
      ok: false,
      bundles: [],
      label: `DSH profile package.json is unreadable`,
      detail: `${manifestPath}: ${read.error}; DSH cannot load a profile it cannot read.`,
      fixHint: `Check file permissions on ${manifestPath} so the Paseo daemon user can read it.`,
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(read.text);
  } catch (error) {
    return {
      ok: false,
      bundles: [],
      label: `DSH profile package.json is not valid JSON`,
      detail: `${manifestPath}: ${error instanceof Error ? error.message : String(error)}; DSH fails to boot this profile.`,
      fixHint: `Fix the JSON syntax in ${manifestPath} and restart the Paseo daemon.`,
    };
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      ok: false,
      bundles: [],
      label: `DSH profile package.json does not hold an object`,
      detail: `${manifestPath}; DSH refuses a profile manifest that is not a JSON object.`,
      fixHint: `Replace ${manifestPath} with a valid JSON object declaring "dsh.profile.bundles".`,
    };
  }
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) {
    return {
      ok: false,
      bundles: [],
      label: `DSH profile declares no bundle list`,
      detail:
        `${manifestPath} has no "dsh.profile.bundles" array, so DSH boots this profile with no bundles at all and ` +
        `the bridge is never loaded. Add "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "${BRIDGE_PACKAGE}"] } }.`,
      fixHint: `Add "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "${BRIDGE_PACKAGE}"] } } to ${manifestPath} and restart the Paseo daemon.`,
    };
  }
  const normalizedBundles = bundles.filter((entry) => typeof entry === "string");
  if (!normalizedBundles.includes(BRIDGE_PACKAGE)) {
    return {
      ok: false,
      bundles: normalizedBundles,
      label: `DSH profile does not load the bridge bundle`,
      detail:
        `"${BRIDGE_PACKAGE}" is missing from dsh.profile.bundles in ${manifestPath}; DSH boots without the bridge ` +
        `and every session waits for initialize until it times out. Add "${BRIDGE_PACKAGE}" to that list (keep the ` +
        `other entries) and restart the daemon.`,
      fixHint: `Add "${BRIDGE_PACKAGE}" to dsh.profile.bundles in ${manifestPath} and restart the Paseo daemon.`,
    };
  }
  return { ok: true, bundles: normalizedBundles };
}

/**
 * Compose the profile through DSH's own patch algorithm synchronously.
 *
 * @param {string} profile
 * @param {{ command: string, args: string[] }} launcher
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, timeoutMs?: number }} [opts]
 * @returns {{ status: number|null, stderr: string, error?: Error, timedOut?: boolean }}
 */
function dumpProfileSync(profile, launcher, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DUMP_TIMEOUT_MS;
  const result = spawnSync(launcher.command, [...launcher.args, "--profile", profile, "--dump-config"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    env: opts.env,
    cwd: opts.cwd,
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

/**
 * Compose the profile through DSH's own patch algorithm asynchronously without
 * blocking the event loop. Always discards stdout so composed config is never
 * buffered in memory.
 *
 * @param {string} profile
 * @param {{ command: string, args: string[] }} launcher
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ status: number|null, stderr: string, error?: Error, timedOut?: boolean }>}
 */
function dumpProfileAsync(profile, launcher, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DUMP_TIMEOUT_MS;
  return new Promise((resolveDump) => {
    if (opts.signal?.aborted) {
      const err = new Error("aborted");
      err.code = "ETIMEDOUT";
      resolveDump({ status: null, stderr: "", error: err, timedOut: true });
      return;
    }

    let child;
    try {
      child = spawn(launcher.command, [...launcher.args, "--profile", profile, "--dump-config"], {
        stdio: ["ignore", "ignore", "pipe"],
        env: opts.env,
        cwd: opts.cwd,
      });
    } catch (error) {
      resolveDump({
        status: null,
        stderr: "",
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: false,
      });
      return;
    }

    let settled = false;
    let stderr = "";
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolveDump(outcome);
    };

    const failTimeout = () => {
      killChild(child);
      const err = new Error(`timed out after ${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      finish({ status: null, stderr, error: err, timedOut: true });
    };

    const onAbort = () => failTimeout();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = timeoutMs > 0 ? setTimeout(failTimeout, timeoutMs) : undefined;
    timer?.unref?.();

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_DUMP_STDERR_BYTES) {
        stderr += chunk.slice(0, MAX_DUMP_STDERR_BYTES - stderr.length);
      }
    });
    child.on("error", (error) => {
      finish({ status: null, stderr, error, timedOut: false });
    });
    child.on("close", (code) => {
      finish({ status: code, stderr, error: undefined, timedOut: false });
    });
  });
}

/**
 * The composition diagnostics DSH printed, one per line.
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
 */
function dumpFailure(dumped, timeoutMs = DUMP_TIMEOUT_MS) {
  if (dumped.timedOut || dumped.error?.code === "ETIMEDOUT" || dumped.error?.name === "AbortError") {
    return `dsh --dump-config did not finish within ${Math.max(1, Math.round(timeoutMs / 1000))}s`;
  }
  if (dumped.error !== undefined) {
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
 * Whether a malformed ref key name looks like an accidentally pasted secret or
 * multi-token line rather than a benign identifier typo like `MY.GATEWAY_KEY`.
 */
function safeCredentialRefNameForDisplay(name) {
  if (
    name.length > 64 ||
    /\s/.test(name) ||
    /[:=]/.test(name) ||
    /^(?:sk|pk|ak|rk|ghp|gho|ghu|github_pat|xox[a-z]|AIza|Bearer)[-_]/i.test(name)
  ) {
    return "<redacted>";
  }
  return name;
}

/**
 * Whether a document is the pre-release flat credentials layout DSH migrates.
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
 * Security rule: NEVER include any credential value or arbitrary non-numeric
 * scalar from the document in `problems`.
 *
 * @param {unknown} document - the parsed YAML document.
 * @param {string} text - its text, for the flat-layout recognizer.
 * @param {string} path - absolute path, for the repair instructions.
 * @returns {{ refs: Record<string, unknown>, problems: { label: string, detail: string, fixHint: string }[], legacy: boolean }}
 */
export function credentialContract(document, text, path) {
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
          fixHint: `Rewrite ${path} as a YAML mapping with "version: 1" and "refs:" at the top level, with mode 0600.`,
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
        fixHint: `Add "version: 1" at the top of ${path} and place your keys under "refs:" (keep mode 0600).`,
      });
  } else if (root.version !== 1) {
    // Only echo safe numeric versions; never echo arbitrary strings/objects that could carry secret text.
    const versionDisplay = typeof root.version === "number" ? JSON.stringify(root.version) : "an invalid value";
    problems.push({
      label: `credentials document declares version ${versionDisplay}`,
      detail: `${path} must say "version: 1" (a number, unquoted); this DSH build reads version 1 only.`,
      fixHint: `Set "version: 1" (unquoted integer) at the top of ${path}.`,
    });
  }
  const section = legacy ? root : root.refs;
  if (section !== undefined && section !== null && (typeof section !== "object" || Array.isArray(section))) {
    problems.push({
      label: "credentials refs is not a mapping",
      detail: `"refs:" in ${path} must be a mapping of NAME: <key>; DSH rejects the whole document otherwise.`,
      fixHint: `Fix "refs:" in ${path} so it is a YAML key-value mapping of ENV_NAME: <key>.`,
    });
    return { refs: {}, problems, legacy };
  }
  const refs = section ?? {};
  for (const [name, value] of Object.entries(refs)) {
    const safeName = safeCredentialRefNameForDisplay(name);
    if (!CREDENTIAL_REF.test(name))
      problems.push({
        label: `credentials ref "${safeName}" is not a valid name`,
        detail:
          `DSH requires /^[A-Za-z_][A-Za-z0-9_]*$/ (no dots or dashes) for a ref name; rename it in ${path}. ` +
          `The route's apiKeyEnv has to use the same name.`,
        fixHint: `Rename the invalid ref in ${path} to match /^[A-Za-z_][A-Za-z0-9_]*$/ and update apiKeyEnv in cordis.patch.yml to match.`,
      });
    else if (typeof value !== "string" || value.length === 0)
      problems.push({
        label: `credentials ref "${safeName}" has no usable value`,
        detail: `the value for "${safeName}" in ${path} must be a non-empty string; quote it, or remove the key.`,
        fixHint: `Set a non-empty string value for "${safeName}" in ${path} (quote numeric values), or remove the unused entry.`,
      });
  }
  return { refs, problems, legacy };
}

function findPaseoSync(env, execFn, checkBundledPaseo, cwd) {
  // Prefer the app-bundled CLI: a `paseo` on PATH is often a stale npm install.
  if (env.PASEO_CLI) {
    const version = execFn(env.PASEO_CLI, ["--version"], { env, cwd, timeoutMs: CLI_PROBE_TIMEOUT_MS });
    if (version !== undefined) return { cmd: env.PASEO_CLI, version };
  }
  const bundled = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
  if (checkBundledPaseo && existsSync(bundled)) {
    const v = execFn(bundled, ["--version"], { env, cwd, timeoutMs: CLI_PROBE_TIMEOUT_MS });
    if (v !== undefined) return { cmd: bundled, version: v };
  }
  const v = execFn("paseo", ["--version"], { env, cwd, timeoutMs: CLI_PROBE_TIMEOUT_MS });
  if (v !== undefined) return { cmd: "paseo", version: v };
  return undefined;
}

async function findPaseoAsync(env, execFn, checkBundledPaseo, cwd, signal, timeoutMs) {
  if (env.PASEO_CLI) {
    const version = await execFn(env.PASEO_CLI, ["--version"], { env, cwd, signal, timeoutMs });
    if (version !== undefined) return { cmd: env.PASEO_CLI, version };
  }
  const bundled = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
  if (checkBundledPaseo && existsSync(bundled)) {
    const v = await execFn(bundled, ["--version"], { env, cwd, signal, timeoutMs });
    if (v !== undefined) return { cmd: bundled, version: v };
  }
  const v = await execFn("paseo", ["--version"], { env, cwd, signal, timeoutMs });
  if (v !== undefined) return { cmd: "paseo", version: v };
  return undefined;
}

function firstLine(v) {
  return v.split("\n").find((entry) => entry.trim() !== "") ?? v;
}

/**
 * `>= minimum`, compared component by component.
 */
export function atLeast(version, minimum) {
  const got = parseVersion(version);
  const want = parseVersion(minimum);
  if (got === undefined || want === undefined) return false;
  const core = compareCore(got, want);
  return core > 0 || (core === 0 && got.prerelease === undefined);
}

/** `major.minor.patch` plus the prerelease tag, or `undefined` when unreadable. */
export function parseVersion(value) {
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
 */
export function compareCore(a, b) {
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
 * Redact a provider baseURL to scheme + host only (strips userinfo, path, query, fragment).
 */
export function redactBaseUrlHost(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return undefined;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Extract a strictly allowlisted, secret-free summary of configured providers
 * and models from `llm-pi-ai.config.providers`.
 */
function extractRedactedProviders(providers, defaultProviderId) {
  if (providers === undefined) return { providers: [], referencedApiKeyEnvs: [] };
  const redacted = [];
  const referenced = [];
  for (const [id, rawProfile] of Object.entries(providers)) {
    if (rawProfile === null || typeof rawProfile !== "object" || Array.isArray(rawProfile)) continue;
    const displayName =
      typeof rawProfile.displayName === "string" && rawProfile.displayName.trim() !== ""
        ? rawProfile.displayName.trim()
        : undefined;
    const api = typeof rawProfile.api === "string" && rawProfile.api.trim() !== "" ? rawProfile.api.trim() : undefined;
    const apiKeyEnv =
      typeof rawProfile.apiKeyEnv === "string" && rawProfile.apiKeyEnv.trim() !== ""
        ? rawProfile.apiKeyEnv.trim()
        : undefined;
    if (apiKeyEnv !== undefined) referenced.push(apiKeyEnv);
    const baseUrlHost = redactBaseUrlHost(rawProfile.baseURL ?? rawProfile.baseUrl);
    const models = [];
    if (Array.isArray(rawProfile.models)) {
      for (const rawModel of rawProfile.models) {
        if (typeof rawModel === "string" && rawModel.trim() !== "") {
          models.push({ id: rawModel.trim() });
        } else if (rawModel !== null && typeof rawModel === "object" && !Array.isArray(rawModel)) {
          const modelId = typeof rawModel.id === "string" ? rawModel.id.trim() : "";
          if (modelId === "") continue;
          const modelName =
            typeof rawModel.name === "string" && rawModel.name.trim() !== "" ? rawModel.name.trim() : undefined;
          models.push(modelName !== undefined ? { id: modelId, name: modelName } : { id: modelId });
        }
      }
    }
    redacted.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(api === undefined ? {} : { api }),
      ...(baseUrlHost === undefined ? {} : { baseUrlHost }),
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      isDefault: defaultProviderId !== undefined && id === defaultProviderId,
      models,
    });
  }
  return { providers: redacted, referencedApiKeyEnvs: [...new Set(referenced)] };
}

/**
 * Every file the bridge package must contain, taken from the generated
 * `server/bridge-assets.ts` when running from an on-disk plugin tree.
 * Bundled server callers pass `bridgeFiles: Object.keys(BRIDGE_FILES)` directly.
 */
export function loadBridgeFileList(pluginDir) {
  const root = pluginDir ?? defaultPluginDir();
  if (root === undefined) {
    return { error: "server/bridge-assets.ts path is unavailable in bundled runtime" };
  }
  const assetsPath = join(root, "server", "bridge-assets.ts");
  const localRequire = getLocalRequire();
  if (localRequire !== undefined) {
    try {
      const assets = localRequire(assetsPath);
      const files = assets?.BRIDGE_FILES;
      if (files !== null && typeof files === "object" && Object.keys(files).length > 0) {
        return { keys: Object.keys(files) };
      }
    } catch {
      // Older Node cannot require TypeScript; the source scan below covers it.
    }
  }
  const read = readText(assetsPath);
  if (read.error !== undefined) return { error: `${assetsPath} is unreadable (${read.error})` };
  const block = /export const BRIDGE_FILES[^{]*\{([\s\S]*?)\n\};/.exec(read.text)?.[1];
  if (block === undefined) return { error: `BRIDGE_FILES not found in ${assetsPath}` };
  const keys = [...block.matchAll(/^[ \t]*("(?:[^"\\]|\\.)*"):/gm)].map((match) => JSON.parse(match[1]));
  if (keys.length === 0) return { error: `BRIDGE_FILES has no entries in ${assetsPath}` };
  return { keys };
}

function normalizeBridgeFileList(override, pluginDir) {
  if (override === undefined) return loadBridgeFileList(pluginDir);
  if (Array.isArray(override)) {
    return override.length > 0 ? { keys: [...override] } : { error: "bridge file list is empty" };
  }
  if (override !== null && typeof override === "object") {
    if (typeof override.error === "string") return { error: override.error };
    if (Array.isArray(override.keys) && override.keys.length > 0) return { keys: [...override.keys] };
  }
  return { error: "bridge file list is invalid" };
}

/**
 * Absolute path of the file that actually implements `dsh`, or `undefined`.
 */
export function whichDsh(launcher, env = process.env, platform = process.platform, cwd = process.cwd()) {
  if (launcher !== undefined && launcher.args.length > 0) {
    const entry = launcher.args[0];
    if (existsSync(entry)) return entry;
  }
  const command = launcher?.command ?? "dsh";
  if (command.includes("/") || command.includes("\\")) {
    const explicit = resolve(cwd, command);
    if (existsSync(explicit)) return explicit;
    return undefined;
  }
  const pathKey = Object.keys(env).sort().find((key) => key.toLowerCase() === "path");
  const pathValue = pathKey === undefined ? "" : (env[pathKey] ?? "");
  const pathSep = platform === "win32" ? ";" : delimiter;
  const names =
    platform === "win32"
      ? /\.[a-z0-9]+$/i.test(command)
        ? [command]
        : [`${command}.exe`, `${command}.cmd`, command]
      : [command];
  for (const entry of pathValue.split(pathSep)) {
    const cleaned = entry.replace(/^"|"$/g, "");
    if (cleaned === "") continue;
    for (const name of names) {
      const candidate = join(cleaned, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * A `require` anchored at the DSH install, or `undefined`.
 */
function dshPackageRequire(launcher, env = process.env, platform = process.platform, cwd = process.cwd()) {
  const dsh = whichDsh(launcher, env, platform, cwd);
  if (dsh === undefined) return undefined;
  try {
    let dir = dirname(realpathSync(dsh));
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, "package.json"))) return createRequire(join(dir, "package.json"));
      dir = dirname(dir);
    }
  } catch {
    // Unresolvable `dsh` is not an error here.
  }
  return undefined;
}

/**
 * Whatever YAML parser this install happens to carry, or `undefined`.
 */
export function loadYaml(launcher, env = process.env, platform = process.platform, cwd = process.cwd()) {
  const localRequire = getLocalRequire();
  if (localRequire !== undefined) {
    for (const name of ["yaml", "js-yaml"]) {
      try {
        return { name, module: localRequire(name) };
      } catch {
        // Try the next spelling; the caller reports when none resolves.
      }
    }
  }
  const fromDsh = dshPackageRequire(launcher, env, platform, cwd);
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

/**
 * Scrub accidental inline secrets from non-credential diagnostic error strings
 * (e.g. a YAML syntax error in `cordis.patch.yml`).
 */
function scrubErrorSnippet(message) {
  const line = String(message ?? "").split("\n")[0].trim();
  return line
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>")
    .replace(/\b((?:sk|pk|ak|rk|ghp|gho|ghu|github_pat|xox[a-z]|AIza)[-_])[A-Za-z0-9._-]{6,}/gi, "$1<redacted>")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)([^\s,"'\]}]+)/gi, "$1<redacted>");
}

function readPluginVersion(explicitVersion, pluginDir) {
  if (explicitVersion !== undefined) return { version: explicitVersion };
  const root = pluginDir ?? defaultPluginDir();
  if (root === undefined) {
    return { error: "cannot read the plugin's package.json: plugin directory is unavailable" };
  }
  const pluginRead = readText(join(root, "package.json"));
  if (pluginRead.error !== undefined) {
    return { error: `cannot read the plugin's package.json: ${pluginRead.error}` };
  }
  try {
    const parsed = JSON.parse(pluginRead.text);
    if (typeof parsed?.version === "string" && parsed.version !== "") {
      return { version: parsed.version };
    }
    return { error: "cannot read the plugin's package.json: missing version" };
  } catch (error) {
    return { error: `cannot read the plugin's package.json: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Pure read-only inspection of the DSH profile, bridge, `cordis.patch.yml`,
 * and `.credentials.yaml` (zero subprocesses).
 *
 * Shared by both `dsh.diagnostics.overview` and full doctor runs so the two
 * layers never drift. Never returns raw `.credentials.yaml` text, key values,
 * or YAML parser errors from `.credentials.yaml`.
 */
export function inspectInstallFiles(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const dshHome = options.dshHome ?? resolveDshHome(env, cwd);
  const profileFromEnv = options.profileFromEnv ?? (options.profile === undefined && env.DSH_PASEO_PROFILE !== undefined);
  const profile = options.profile ?? env.DSH_PASEO_PROFILE ?? "paseo";
  const profileDir = join(dshHome, "profiles", profile);
  const binary = options.binary ?? env.DSH_BINARY ?? "dsh";
  const launcher = options.launcher ?? resolveDshCommand(binary, env, cwd);
  const dshPath = whichDsh(launcher, env, platform, cwd);

  // 1. Profile directory & manifest
  const profileExists = existsSync(profileDir);
  const profileBundle = profileExists
    ? profileBundleVerdict(profileDir, profile)
    : {
        ok: false,
        bundles: [],
        label: `DSH profile "${profile}" missing`,
        detail: `expected ${profileDir}. Install the plugin and restart the daemon — the plugin creates it on load.`,
        fixHint: `Install or reload the dsh-paseo plugin and restart the Paseo daemon so it provisions ${profileDir}.`,
      };

  // 2. Bridge files
  const bridgeLocs = bridgeLocations(profileDir, dshHome);
  const localBridge = pathExists(bridgeLocs.local);
  const sharedBridge = pathExists(bridgeLocs.shared);
  const bridgeDir = localBridge ? bridgeLocs.local : bridgeLocs.shared;
  const bridgeFileList = normalizeBridgeFileList(options.bridgeFiles, options.pluginDir);
  let bridgeStatus;
  let expectedFiles = 0;
  let presentFiles = 0;
  let missingFiles = [];
  let entryExists = false;
  if (bridgeFileList.error !== undefined) {
    bridgeStatus = "unverified";
    entryExists = existsSync(join(bridgeDir, "lib", "index.js"));
  } else {
    expectedFiles = bridgeFileList.keys.length;
    missingFiles = bridgeFileList.keys.filter((relativePath) => !existsSync(join(bridgeDir, relativePath)));
    presentFiles = expectedFiles - missingFiles.length;
    if (missingFiles.length === 0) {
      bridgeStatus = localBridge && sharedBridge ? "shadowed" : "provisioned";
    } else if (!localBridge && !sharedBridge) {
      bridgeStatus = "missing";
    } else {
      bridgeStatus = "incomplete";
    }
  }
  const bridgeLocationKind =
    localBridge && sharedBridge ? "both" : localBridge ? "local" : sharedBridge ? "shared" : "none";

  // 3. YAML parser resolution (read-only, no subprocess)
  const yaml = options.yamlParser === undefined ? loadYaml(launcher, env, platform, cwd) : options.yamlParser ?? undefined;

  // 4. Model route (`cordis.patch.yml`)
  const patchPath = join(profileDir, "cordis.patch.yml");
  const patchExists = profileExists && existsSync(patchPath);
  const patchRead = patchExists ? readText(patchPath) : undefined;
  let routeStatus = "unverified";
  let defaultProvider;
  let defaultModel;
  let defaultReasoningEffort;
  let routeLabel;
  let routeDetail;
  let routeFixHint;
  let patchYamlError;
  let patchListError;
  let redactedProviders = [];
  let referencedApiKeyEnvs = [];

  if (!patchExists) {
    routeStatus = "missing-patch";
    routeLabel = "no cordis.patch.yml";
    routeDetail = `the plugin should have written one at ${patchPath}`;
    routeFixHint = `Restart the Paseo daemon to generate ${patchPath}, then configure your provider and default model.`;
  } else if (patchRead.error !== undefined) {
    routeStatus = "missing-patch";
    routeLabel = "cordis.patch.yml is unreadable";
    routeDetail = patchRead.error;
    routeFixHint = `Check file permissions on ${patchPath} so it can be read.`;
  } else if (yaml === undefined) {
    routeStatus = "unverified";
    routeLabel = "model route not verified";
    routeDetail = "no YAML parser resolves from here, so the parsed route cannot be judged";
    routeFixHint = "Ensure DeepSeek Harness (dsh) is installed so its YAML parser can validate cordis.patch.yml.";
  } else {
    let patchDocument;
    try {
      patchDocument = parseYaml(yaml, patchRead.text);
    } catch (error) {
      routeStatus = "invalid-yaml";
      patchYamlError = scrubErrorSnippet(error instanceof Error ? error.message : String(error));
      routeLabel = "cordis.patch.yml is not valid YAML";
      routeDetail = patchYamlError;
      routeFixHint = `Fix the YAML syntax error in ${patchPath} and restart the Paseo daemon.`;
    }
    if (patchYamlError === undefined) {
      const patchList = patchEntries(patchDocument);
      if (patchList.error !== undefined) {
        routeStatus = "invalid-patch";
        patchListError = patchList.error;
        routeLabel = "cordis.patch.yml is not a loader patch list";
        routeDetail = patchList.error;
        routeFixHint = `Ensure ${patchPath} is a top-level YAML list of loader patch entries (each starting with "- id:").`;
      } else {
        const entries = patchList.entries;
        const defaultEntry = entryById(entries, "agent-default-model");
        const providers = providerProfiles(entryById(entries, "llm-pi-ai"));

        if (defaultEntry === undefined) {
          routeStatus = "missing-default";
          routeLabel = "no agent-default-model in the profile patch";
          routeDetail = `edit ${patchPath} (see the README install walkthrough) then restart the daemon`;
          routeFixHint = `Add an "agent-default-model" entry with provider and model to ${patchPath}, then restart the daemon.`;
        } else if (defaultEntry.disabled === true) {
          routeStatus = "disabled";
          routeLabel = "agent-default-model is disabled";
          routeDetail = `remove \`disabled: true\` from the agent-default-model entry in ${patchPath}`;
          routeFixHint = `Remove "disabled: true" from agent-default-model in ${patchPath} and restart the daemon.`;
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
          const reasoningEffort =
            routeConfig !== null && typeof routeConfig === "object" && !Array.isArray(routeConfig)
              ? routeConfig.reasoningEffort
              : undefined;
          const providerName = typeof provider === "string" ? provider.trim() : "";
          const modelName = typeof model === "string" ? model.trim() : "";
          if (providerName !== "") defaultProvider = providerName;
          if (modelName !== "") defaultModel = modelName;
          if (typeof reasoningEffort === "string" && reasoningEffort.trim() !== "") {
            defaultReasoningEffort = reasoningEffort.trim();
          }

          if (providerName === "" || modelName === "") {
            routeStatus = "incomplete";
            routeLabel = "model route is incomplete";
            routeDetail = `set both provider: and model: under agent-default-model in ${patchPath}`;
            routeFixHint = `Set non-empty provider and model under agent-default-model.config in ${patchPath}, then restart the daemon.`;
          } else if (providers === undefined || Object.keys(providers).length === 0) {
            routeStatus = "unknown-provider";
            routeLabel = `model route references provider "${providerName}" but no providers are configured`;
            routeDetail = `add it under the llm-pi-ai entry's config.providers in ${patchPath}`;
            routeFixHint = `Configure "${providerName}" under llm-pi-ai.config.providers in ${patchPath}, then restart the daemon.`;
          } else if (!Object.prototype.hasOwnProperty.call(providers, providerName)) {
            routeStatus = "unknown-provider";
            routeLabel = `model route references unknown provider "${providerName}"`;
            routeDetail = `providers defined in ${patchPath}: ${Object.keys(providers).join(", ")}`;
            routeFixHint = `Set agent-default-model.config.provider in ${patchPath} to one of: ${Object.keys(providers).join(", ")}, or add "${providerName}" under llm-pi-ai.config.providers.`;
          } else {
            routeStatus = "configured";
            routeLabel = "model route configured";
            routeDetail = `default: ${providerName} / ${modelName}`;
          }
        }

        const extracted = extractRedactedProviders(providers, defaultProvider);
        redactedProviders = extracted.providers;
        referencedApiKeyEnvs = extracted.referencedApiKeyEnvs;
      }
    }
  }

  // 5. Credentials (`.credentials.yaml`) — NEVER expose raw contents or YAML parser errors!
  const credentialPath = join(dshHome, ".credentials.yaml");
  const credentialExists = existsSync(credentialPath);
  const credentialMode = credentialExists ? statMode(credentialPath) : undefined;
  const credentialModeBits = credentialMode !== undefined ? credentialMode & 0o777 : undefined;
  const credentialModeOctal =
    platform !== "win32" && credentialModeBits !== undefined
      ? `0${credentialModeBits.toString(8).padStart(3, "0")}`
      : undefined;
  const ownerOnly =
    platform === "win32"
      ? true
      : credentialMode !== undefined
        ? (credentialMode & CREDENTIALS_GROUP_OTHER) === 0
        : undefined;
  const credentialRead = readText(credentialPath);
  const credentialReadable = credentialRead.error === undefined;

  let credentialFormatValid;
  let credentialLegacy = false;
  let credentialContractProblems = [];
  let referencedRefs = [];
  let missingRefs = [];
  let credentialStatus;
  let credentialFixHint;

  if (!credentialExists) {
    credentialStatus = "missing-file";
    credentialFixHint = `Create ${credentialPath} with mode 0600 ("chmod 600 ${credentialPath}"), "version: 1", and your "refs:" entries.`;
  } else if (!credentialReadable) {
    credentialStatus = "unreadable";
    credentialFixHint = `Check permissions on ${credentialPath} so the current user can read it (recommended mode 0600).`;
  } else if (yaml === undefined) {
    credentialStatus = ownerOnly === false ? "bad-permissions" : "unverified";
    if (ownerOnly === false) {
      credentialFixHint = `Run "chmod 600 ${credentialPath}" — DSH refuses to start with a credentials document other users can read.`;
    }
  } else {
    let parsedCreds;
    let yamlOk = true;
    try {
      parsedCreds = parseYaml(yaml, credentialRead.text);
    } catch {
      // NEVER read or echo error.message: YAML parsers quote offending lines
      // which may contain raw API keys.
      yamlOk = false;
    }
    credentialFormatValid = yamlOk;
    if (!yamlOk) {
      credentialStatus = ownerOnly === false ? "bad-permissions" : "invalid-yaml";
      credentialFixHint =
        ownerOnly === false
          ? `Run "chmod 600 ${credentialPath}" and fix YAML syntax errors in ${credentialPath} (use "version: 1" + "refs:").`
          : `Fix YAML syntax errors in ${credentialPath} (must be a valid YAML document with "version: 1" and "refs:").`;
    } else {
      const contract = credentialContract(parsedCreds, credentialRead.text, credentialPath);
      credentialLegacy = contract.legacy;
      credentialContractProblems = contract.problems;
      if (contract.problems.length > 0) {
        credentialStatus = ownerOnly === false ? "bad-permissions" : "invalid-contract";
        credentialFixHint =
          ownerOnly === false
            ? `Run "chmod 600 ${credentialPath}" and fix the credentials document format (${contract.problems[0].label}).`
            : contract.problems[0].fixHint;
      } else {
        const refsObject = contract.refs;
        const refMap = new Map();
        for (const name of referencedApiKeyEnvs) {
          const value = refsObject[name];
          const present = typeof value === "string" && value.trim() !== "";
          refMap.set(name, present);
          referencedRefs.push({ name, present });
          if (!present) missingRefs.push(name);
        }
        // Attach boolean readiness per provider (never any secret value!)
        redactedProviders = redactedProviders.map((provider) =>
          provider.apiKeyEnv === undefined
            ? provider
            : { ...provider, credentialReady: refMap.get(provider.apiKeyEnv) === true },
        );
        const refLocation = credentialLegacy ? "at the top level" : 'under "refs:"';
        if (ownerOnly === false) {
          credentialStatus = "bad-permissions";
          credentialFixHint = `Run "chmod 600 ${credentialPath}" — DSH refuses to start with a credentials document other users can read.`;
        } else if (referencedApiKeyEnvs.length === 0) {
          credentialStatus = "no-refs-needed";
        } else if (missingRefs.length > 0) {
          credentialStatus = "missing-refs";
          credentialFixHint =
            `Add ${missingRefs.map((n) => `"${n}: <your-key>"`).join(", ")} ${refLocation} in ${credentialPath} ` +
            `(with "version: 1" and mode 0600).`;
        } else {
          credentialStatus = "ready";
        }
      }
    }
  }

  return {
    dshHome,
    profile,
    profileFromEnv,
    profileDir,
    binary,
    launcher,
    dshPath,
    platform,
    profileExists,
    profileBundle,
    bridge: {
      status: bridgeStatus,
      location: bridgeLocationKind,
      activeDir: bridgeDir,
      localDir: bridgeLocs.local,
      sharedDir: bridgeLocs.shared,
      localExists: localBridge,
      sharedExists: sharedBridge,
      shadowed: localBridge && sharedBridge,
      fileListError: bridgeFileList.error,
      entryExists,
      expectedFiles,
      presentFiles,
      missingFiles,
    },
    yamlAvailable: yaml !== undefined,
    patch: {
      path: patchPath,
      exists: patchExists,
      readError: patchRead?.error,
      yamlError: patchYamlError,
      listError: patchListError,
      status: routeStatus,
      defaultProvider,
      defaultModel,
      defaultReasoningEffort,
      label: routeLabel,
      detail: routeDetail,
      fixHint: routeFixHint,
    },
    providers: redactedProviders,
    referencedApiKeyEnvs,
    credentials: {
      path: credentialPath,
      exists: credentialExists,
      readable: credentialReadable,
      readError: credentialRead.error,
      mode: credentialMode,
      modeBits: credentialModeBits,
      modeOctal: credentialModeOctal,
      ownerOnly,
      formatValid: credentialFormatValid,
      legacy: credentialLegacy,
      contractProblems: credentialContractProblems,
      referencedRefs,
      missingRefs,
      status: credentialStatus,
      fixHint: credentialFixHint,
    },
  };
}

/**
 * Evaluate the ordered list of doctor checks from pre-gathered probes + file
 * inspection. Used identically by both `runDoctorChecks` (sync) and
 * `runDoctorChecksAsync` (async).
 */
function evaluateDoctorChecks({
  pluginVersion,
  files,
  dshVersion,
  paseo,
  paseoPluginsListed,
  dumped,
  dumpTimeoutMs,
}) {
  const checks = [];
  const add = (id, category, level, label, detail, fixHint) => {
    checks.push({
      id,
      category,
      level,
      label,
      ...(detail === undefined || detail === "" ? {} : { detail }),
      ...(fixHint === undefined || fixHint === "" ? {} : { fixHint }),
    });
  };

  const finalize = () => {
    let ok = 0;
    let warn = 0;
    let fail = 0;
    for (const item of checks) {
      if (item.level === "ok") ok += 1;
      else if (item.level === "warn") warn += 1;
      else fail += 1;
    }
    return {
      pluginVersion,
      dshHome: files.dshHome,
      profile: files.profile,
      profileFromEnv: files.profileFromEnv,
      profileDir: files.profileDir,
      binary: files.binary,
      dshPath: files.dshPath,
      dshVersion: dshVersion === undefined ? undefined : firstLine(dshVersion),
      paseoVersion: paseo?.version,
      checks,
      summary: {
        ok,
        warn,
        fail,
        total: checks.length,
        blocking: fail > 0,
        exitCode: fail > 0 ? 1 : 0,
      },
      timedOut: Boolean(dumped?.timedOut),
    };
  };

  // 1. CLIs
  if (dshVersion === undefined) {
    add(
      "dsh-cli",
      "cli",
      "fail",
      "dsh on PATH",
      "install the official DeepSeek Harness and put `dsh` on the daemon's PATH",
      `Install DeepSeek Harness (npm install -g @deepseek-ai/dsh) and ensure "dsh" is on the daemon's PATH, or set DSH_BINARY.`,
    );
  } else {
    const dshLine = firstLine(dshVersion);
    const got = parseVersion(dshLine);
    const minimum = parseVersion(MINIMUM_DSH);
    const pluginMM = typeof pluginVersion === "string" ? pluginVersion.match(/^(\d+)\.(\d+)/) : null;
    if (got === undefined) {
      add("dsh-cli", "cli", "warn", `dsh ${dshLine}`, `could not read a version; this plugin needs DSH >= ${MINIMUM_DSH}`);
    } else if (minimum !== undefined && compareCore(got, minimum) < 0) {
      add(
        "dsh-cli",
        "cli",
        "fail",
        `dsh ${dshLine}`,
        `needs DSH >= ${MINIMUM_DSH}: the bridge imports @deepseek-ai/dsh-{cmdline,brand,llm,attachment,agent}, and 0.2.1 changed prompt variables and catalog materialization`,
        `Upgrade DeepSeek Harness to >= ${MINIMUM_DSH} (npm install -g @deepseek-ai/dsh@latest) and restart the Paseo daemon.`,
      );
    } else if (pluginMM && `${got.major}.${got.minor}` !== `${pluginMM[1]}.${pluginMM[2]}`) {
      add(
        "dsh-cli",
        "cli",
        "warn",
        `dsh ${dshLine}`,
        `plugin ${pluginVersion} targets the ${pluginMM[1]}.${pluginMM[2]}.x DSH line; this line was not verified`,
      );
    } else {
      add("dsh-cli", "cli", "ok", `dsh ${dshLine}`);
    }
  }

  if (paseo === undefined) {
    const isWin = files.platform === "win32";
    add(
      "paseo-cli",
      "cli",
      isWin ? "warn" : "fail",
      isWin ? "paseo CLI version not checked" : "paseo CLI not found",
      isWin
        ? `the Windows desktop app can run without a PATH CLI; verify its version in the app (Paseo >= ${MINIMUM_PASEO})`
        : "expected `paseo` on PATH, PASEO_CLI, or /Applications/Paseo.app",
      isWin ? undefined : 'Ensure "paseo" is on PATH or set PASEO_CLI to the Paseo CLI path.',
    );
  } else if (!atLeast(paseo.version, MINIMUM_PASEO)) {
    add(
      "paseo-cli",
      "cli",
      "fail",
      `paseo ${paseo.version}`,
      `needs Paseo >= ${MINIMUM_PASEO} stable (this build uses the stable workspace badge API; 0.16.0 prerelease hosts do not satisfy this floor)`,
      `Upgrade Paseo to >= ${MINIMUM_PASEO} stable and restart the daemon.`,
    );
  } else {
    if (parseVersion(paseo.version)?.prerelease !== undefined) {
      add(
        "paseo-cli",
        "cli",
        "warn",
        `paseo ${paseo.version}`,
        "this later prerelease was not verified; run the host contract checks before adopting it",
      );
    } else {
      add("paseo-cli", "cli", "ok", `paseo ${paseo.version}`);
    }
    if (paseoPluginsListed === undefined) {
      add("paseo-plugin", "plugin", "warn", "could not list Paseo plugins", "run `paseo plugin ls` to confirm dsh-paseo is enabled");
    } else {
      const row = paseoPluginsListed.split("\n").find((entry) => entry.trimStart().startsWith("dsh-paseo"));
      if (row === undefined) {
        add(
          "paseo-plugin",
          "plugin",
          "fail",
          "dsh-paseo is not installed in Paseo",
          "install it with `paseo plugin add github:bccy/paseo-dsh:paseo-plugin` (the npm `paseo-dsh` is the upstream stable line and does not carry this branch)",
          'Install the plugin with "paseo plugin add github:bccy/paseo-dsh:paseo-plugin" and restart the daemon.',
        );
      } else if (!/\brunning\b/.test(row)) {
        add("paseo-plugin", "plugin", "warn", "dsh-paseo is installed but not running", "enable it and restart the daemon");
      } else {
        add("paseo-plugin", "plugin", "ok", "dsh-paseo plugin running");
      }
    }
  }

  // 2. Profile provisioned by the plugin
  if (!files.profileExists) {
    add(
      "profile-dir",
      "profile",
      "fail",
      `DSH profile "${files.profile}" missing`,
      `expected ${files.profileDir}. Install the plugin and restart the daemon — the plugin creates it on load.`,
      `Install or reload the dsh-paseo plugin and restart the Paseo daemon so it creates ${files.profileDir}.`,
    );
    return finalize();
  }
  add("profile-dir", "profile", "ok", `DSH profile at ${files.profileDir}`);

  if (files.profileBundle.ok) {
    add("profile-manifest", "profile", "ok", `profile loads the ${BRIDGE_PACKAGE} bundle`);
  } else {
    add(
      "profile-manifest",
      "profile",
      "fail",
      files.profileBundle.label,
      files.profileBundle.detail,
      files.profileBundle.fixHint,
    );
  }

  if (files.bridge.shadowed) {
    add(
      "bridge-shadow",
      "bridge",
      "warn",
      "a legacy bridge copy shadows the provisioned one",
      `${files.bridge.localDir} is resolved before ${files.bridge.sharedDir}, so DSH loads the legacy copy. ` +
        `Restart the Paseo daemon (the plugin moves it to the shared anchor on load) or delete ${files.bridge.localDir}.`,
      `Delete ${files.bridge.localDir} or restart the Paseo daemon so DSH loads the shared bridge.`,
    );
  }

  if (files.bridge.fileListError !== undefined) {
    add(
      "bridge-files",
      "bridge",
      "fail",
      "bridge contents not verified",
      `${files.bridge.fileListError}. The complete file list is required to judge the bridge, so this install ` +
        `cannot be called healthy; reinstall the plugin from a complete checkout, then restart the daemon.`,
      "Reinstall the dsh-paseo plugin from a complete package or checkout, then restart the Paseo daemon.",
    );
    if (!files.bridge.entryExists) {
      const entryOnly = join(files.bridge.activeDir, "lib", "index.js");
      add(
        "bridge-entry",
        "bridge",
        "fail",
        "bridge bundle missing",
        `expected ${entryOnly}; restart the daemon to let the plugin re-provision`,
        "Restart the Paseo daemon so the plugin provisions the bridge bundle.",
      );
    }
  } else if (files.bridge.missingFiles.length === 0) {
    add("bridge-files", "bridge", "ok", `bridge bundle provisioned (${files.bridge.expectedFiles} files)`, files.bridge.activeDir);
  } else {
    const missing = files.bridge.missingFiles;
    const shown = missing.slice(0, 5).join(", ");
    const more = missing.length > 5 ? ` and ${missing.length - 5} more` : "";
    add(
      "bridge-files",
      "bridge",
      "fail",
      `bridge bundle incomplete — ${missing.length} of ${files.bridge.expectedFiles} files missing`,
      `missing: ${shown}${more}. Restart the Paseo daemon so the plugin re-provisions ${files.bridge.activeDir}; ` +
        `if it persists, delete that directory and restart`,
      `Restart the Paseo daemon to re-provision ${files.bridge.activeDir}; if files remain missing, delete that directory and restart.`,
    );
  }

  // 3. Model route
  if (!files.patch.exists) {
    add("patch-file", "route", "fail", "no cordis.patch.yml", `the plugin should have written one at ${files.patch.path}`, files.patch.fixHint);
    return finalize();
  }
  if (files.patch.readError !== undefined) {
    add("patch-file", "route", "fail", "cordis.patch.yml is unreadable", files.patch.readError, files.patch.fixHint);
    return finalize();
  }
  if (!files.yamlAvailable) {
    add(
      "yaml-parser",
      "route",
      "warn",
      "YAML syntax not validated",
      "no YAML parser resolves from here; the route and credential semantics are not inspected either",
    );
    add("model-route", "route", "warn", "model route not verified", "no YAML parser resolves from here, so the parsed route cannot be judged");
    add("credentials", "credentials", "warn", "credentials not verified", "no YAML parser resolves from here, so refs: cannot be judged");
    return finalize();
  }
  if (files.patch.yamlError !== undefined) {
    add("patch-yaml", "route", "fail", "cordis.patch.yml is not valid YAML", files.patch.yamlError, files.patch.fixHint);
    return finalize();
  }
  if (files.patch.listError !== undefined) {
    add("patch-list", "route", "fail", "cordis.patch.yml is not a loader patch list", files.patch.listError, files.patch.fixHint);
    return finalize();
  }
  if (files.patch.status === "configured") {
    add("model-route", "route", "ok", files.patch.label, files.patch.detail);
  } else {
    add("model-route", "route", "fail", files.patch.label, files.patch.detail, files.patch.fixHint);
  }

  // 3b. DSH composition (`dsh --profile <p> --dump-config`)
  if (dumped !== undefined) {
    const diagnostics = dumpDiagnostics(dumped.stderr);
    const profileSkips = diagnostics.filter((entry) => entry.includes(`[${files.patch.path}]`));
    const skippedBundles = diagnostics.filter((entry) => /^dsh: skipping profile bundle "[^"]*":/.test(entry));
    const skippedBridge = skippedBundles.filter((entry) => entry.includes(`"${BRIDGE_PACKAGE}"`));
    const others = diagnostics.filter((entry) => !profileSkips.includes(entry) && !skippedBundles.includes(entry));
    const otherBundles = skippedBundles.filter((entry) => !skippedBridge.includes(entry));

    if (dumped.error !== undefined || dumped.status !== 0) {
      add(
        "profile-composition",
        "composition",
        "fail",
        `DSH cannot compose profile "${files.profile}"`,
        `${dumpFailure(dumped, dumpTimeoutMs)}. The bundle and patch layers were not composed, so DSH cannot boot this profile; ` +
          `fix that error (run \`dsh --profile ${files.profile} --dump-config\` for the full output) before anything else.`,
        `Run "dsh --profile ${files.profile} --dump-config" in a terminal to inspect and fix the composition error.`,
      );
    } else {
      if (profileSkips.length === 0 && skippedBridge.length === 0) {
        add(
          "profile-composition",
          "composition",
          "ok",
          "profile patch applied by DSH",
          `dsh --profile ${files.profile} --dump-config composed it without skipping a patch entry`,
        );
      }
      if (profileSkips.length > 0) {
        add(
          "profile-composition-skips",
          "composition",
          "fail",
          `DSH skipped ${profileSkips.length === 1 ? "a patch entry" : `${String(profileSkips.length)} patch entries`} from ${files.patch.path}`,
          `${quoteDiagnostics(profileSkips)} Fix the entry's id/name so it matches the composed row, then restart ` +
            `the daemon; \`dsh --profile ${files.profile} --dump-config\` prints the same warning and the composed result.`,
          `Fix the mismatched id/name in ${files.patch.path} so DSH applies the entry, then restart the Paseo daemon.`,
        );
      }
      if (skippedBridge.length > 0) {
        add(
          "profile-composition-bridge",
          "composition",
          "fail",
          `DSH skipped the ${BRIDGE_PACKAGE} bundle`,
          `${quoteDiagnostics(skippedBridge)} The bridge cannot answer a session unless DSH loads it; reinstall the ` +
            `plugin, then restart the daemon.`,
          "Reinstall or reload the dsh-paseo plugin so the bridge bundle is intact, then restart the Paseo daemon.",
        );
      }
      if (others.length > 0 || otherBundles.length > 0) {
        add(
          "profile-composition-warnings",
          "composition",
          "warn",
          "other profile composition warnings",
          `${quoteDiagnostics([...others, ...otherBundles])} These come from the bundle layers or the home-level ` +
            `$DSH_HOME/cordis.patch.yml, not from this profile's cordis.patch.yml; the profile still boots, but ` +
            `the affected rows are not applied.`,
        );
      }
    }
  }

  // 4. Credentials: DSH's document contract first, then every referenced apiKeyEnv
  const cred = files.credentials;
  if (cred.readError !== undefined) {
    add("credentials-file", "credentials", "fail", `cannot read ${cred.path}`, cred.readError, cred.fixHint);
    return finalize();
  }
  if (files.platform !== "win32" && cred.mode !== undefined && (cred.mode & CREDENTIALS_GROUP_OTHER) !== 0) {
    add(
      "credentials-permissions",
      "credentials",
      "fail",
      `credentials file is readable beyond its owner (mode ${(cred.mode & 0o777).toString(8)})`,
      `run "chmod 600 ${cred.path}" — DSH refuses to start with a credentials document other users can read.`,
      `Run "chmod 600 ${cred.path}" so only your OS user can read the credentials file.`,
    );
  }
  if (cred.formatValid === false) {
    // Never echo the parser's message: it can quote the offending source line,
    // and this file is where the raw credentials live.
    add(
      "credentials-yaml",
      "credentials",
      "fail",
      `${cred.path} is not valid YAML`,
      undefined,
      `Fix YAML syntax errors in ${cred.path} (must contain "version: 1" and a "refs:" mapping, with mode 0600).`,
    );
    return finalize();
  }
  for (let i = 0; i < cred.contractProblems.length; i += 1) {
    const problem = cred.contractProblems[i];
    add(`credentials-contract-${i}`, "credentials", "fail", problem.label, problem.detail, problem.fixHint);
  }
  if (cred.contractProblems.length > 0) {
    return finalize();
  }
  if (cred.legacy) {
    add(
      "credentials-legacy",
      "credentials",
      "ok",
      "credentials document uses the pre-release flat layout",
      `DSH migrates ${cred.path} to "version: 1" + "refs:" in place on its next start; no hand edit needed.`,
    );
  }

  const refLocation = cred.legacy ? "at the top level" : 'under "refs:"';
  if (files.referencedApiKeyEnvs.length === 0) {
    add(
      "credentials-refs",
      "credentials",
      "fail",
      "no apiKeyEnv referenced",
      "the route above should name the credential to use",
      `Set "apiKeyEnv" on your provider under llm-pi-ai.config.providers in ${files.patch.path}.`,
    );
  } else {
    for (const ref of cred.referencedRefs) {
      if (ref.present) {
        add(`credential-ref-${ref.name}`, "credentials", "ok", `credential ${ref.name} found`);
      } else {
        add(
          `credential-ref-${ref.name}`,
          "credentials",
          "fail",
          `credential ${ref.name} missing`,
          `add "${ref.name}: <your-key>" ${refLocation} in ${cred.path}; the document needs "version: 1" at the ` +
            `top and mode 0600 (chmod 600 ${cred.path}).`,
          `Add "${ref.name}: <your-key>" ${refLocation} in ${cred.path} (with "version: 1" and mode 0600).`,
        );
      }
    }
  }

  return finalize();
}

/**
 * Pure-style synchronous doctor check runner, usable by both CLI and offline tests.
 *
 * @param {object} [options]
 * @returns {object} structured doctor report
 */
export function runDoctorChecks(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const dumpTimeoutMs = options.dumpTimeoutMs ?? DUMP_TIMEOUT_MS;
  const checkBundledPaseo = options.checkBundledPaseo !== false;
  const execFn = options.runner?.exec ?? runSync;
  const dumpFn = options.runner?.dumpProfile ?? dumpProfileSync;

  const pkg = readPluginVersion(options.pluginVersion, options.pluginDir);
  if (pkg.error !== undefined) {
    return {
      fatalError: pkg.error,
      pluginVersion: undefined,
      dshHome: options.dshHome ?? resolveDshHome(env, cwd),
      profile: options.profile ?? env.DSH_PASEO_PROFILE ?? "paseo",
      profileFromEnv: options.profileFromEnv ?? (options.profile === undefined && env.DSH_PASEO_PROFILE !== undefined),
      profileDir: join(options.dshHome ?? resolveDshHome(env, cwd), "profiles", options.profile ?? env.DSH_PASEO_PROFILE ?? "paseo"),
      binary: options.binary ?? env.DSH_BINARY ?? "dsh",
      dshPath: undefined,
      dshVersion: undefined,
      paseoVersion: undefined,
      checks: [],
      summary: { ok: 0, warn: 0, fail: 1, total: 0, blocking: true, exitCode: 1 },
      timedOut: false,
    };
  }

  const files = inspectInstallFiles(options);
  const childEnv = { ...env, DSH_HOME: files.dshHome };

  const dshVersion = execFn(files.launcher.command, [...files.launcher.args, "--version"], {
    env: childEnv,
    cwd,
    timeoutMs: CLI_PROBE_TIMEOUT_MS,
  });

  const paseo = findPaseoSync(env, execFn, checkBundledPaseo, cwd);
  const paseoPluginsListed =
    paseo !== undefined && atLeast(paseo.version, MINIMUM_PASEO)
      ? execFn(paseo.cmd, ["plugin", "ls"], { env, cwd, timeoutMs: CLI_PROBE_TIMEOUT_MS })
      : undefined;

  const canDump =
    !options.skipDumpConfig &&
    files.profileExists &&
    files.profileBundle.ok &&
    files.patch.exists &&
    files.patch.readError === undefined &&
    files.yamlAvailable &&
    files.patch.yamlError === undefined &&
    files.patch.listError === undefined &&
    dshVersion !== undefined;

  const dumped = canDump
    ? dumpFn(files.profile, files.launcher, { env: childEnv, cwd, timeoutMs: dumpTimeoutMs })
    : undefined;

  return evaluateDoctorChecks({
    pluginVersion: pkg.version,
    files,
    dshVersion,
    paseo,
    paseoPluginsListed,
    dumped,
    dumpTimeoutMs,
  });
}

/**
 * Non-blocking async doctor check runner for the Paseo plugin server, sharing
 * 100% of validation logic with `runDoctorChecks` and the CLI.
 *
 * @param {object} [options]
 * @returns {Promise<object>} structured doctor report
 */
export async function runDoctorChecksAsync(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const totalBudgetMs = options.timeoutMs ?? options.dumpTimeoutMs ?? DUMP_TIMEOUT_MS;
  const deadline = Date.now() + totalBudgetMs;
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const signal = options.signal;
  const checkBundledPaseo = options.checkBundledPaseo !== false;
  const execFn = options.runner?.exec ?? runAsync;
  const dumpFn = options.runner?.dumpProfile ?? dumpProfileAsync;

  const pkg = readPluginVersion(options.pluginVersion, options.pluginDir);
  const files = inspectInstallFiles(options);
  const childEnv = { ...env, DSH_HOME: files.dshHome };

  const dshVersion = await execFn(files.launcher.command, [...files.launcher.args, "--version"], {
    env: childEnv,
    cwd,
    signal,
    timeoutMs: Math.min(CLI_PROBE_TIMEOUT_MS, remainingMs()),
  });

  const paseo = await findPaseoAsync(
    env,
    execFn,
    checkBundledPaseo,
    cwd,
    signal,
    Math.min(CLI_PROBE_TIMEOUT_MS, remainingMs()),
  );
  const paseoPluginsListed =
    paseo !== undefined && atLeast(paseo.version, MINIMUM_PASEO)
      ? await execFn(paseo.cmd, ["plugin", "ls"], {
          env,
          cwd,
          signal,
          timeoutMs: Math.min(CLI_PROBE_TIMEOUT_MS, remainingMs()),
        })
      : undefined;

  const canDump =
    !options.skipDumpConfig &&
    files.profileExists &&
    files.profileBundle.ok &&
    files.patch.exists &&
    files.patch.readError === undefined &&
    files.yamlAvailable &&
    files.patch.yamlError === undefined &&
    files.patch.listError === undefined &&
    dshVersion !== undefined;

  const dumpTimeoutMs = Math.min(options.dumpTimeoutMs ?? totalBudgetMs, remainingMs());
  const dumped = canDump
    ? await dumpFn(files.profile, files.launcher, {
        env: childEnv,
        cwd,
        signal,
        timeoutMs: dumpTimeoutMs,
      })
    : undefined;

  return evaluateDoctorChecks({
    pluginVersion: pkg.version,
    files,
    dshVersion,
    paseo,
    paseoPluginsListed,
    dumped,
    dumpTimeoutMs: options.dumpTimeoutMs ?? totalBudgetMs,
  });
}
