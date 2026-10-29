/**
 * `paseo-dsh doctor` — one-command self-check for a DeepSeek Harness × Paseo
 * install.
 *
 * It verifies the things that silently break a fresh install: the CLIs are
 * present, the plugin has provisioned the DSH profile (which only happens once
 * the daemon loads the plugin), the bridge is materialized, a model route is
 * actually configured, and every referenced `apiKeyEnv` has a credential. It
 * only reads; it never changes anything.
 *
 * ### What "configured" has to mean
 *
 * The check used to ask whether the words `agent-default-model` and `providers:`
 * appear. A file with `provider:` present and *empty* satisfied that, and so did
 * a file with a YAML syntax error on the next line — both reported `ok` with no
 * detail, and a fresh install that could not possibly run printed
 * "All checks passed". A route now has to name a provider and a model, and the
 * credential has to carry a value under `refs:`, or it is a failure.
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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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

/** Strip full-line comments so "route configured?" isn't fooled by the template. */
function activeLines(text) {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
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

  const bridgeDir = join(profileDir, "node_modules", "dsh-paseo-bridge");
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
  const active = activeLines(patch);

  const yaml = loadYaml();
  if (yaml === undefined) {
    report(
      "warn",
      "YAML syntax not validated",
      "no YAML parser resolves from here; only the route and credential fields below were checked",
    );
  } else {
    try {
      if (yaml.name === "js-yaml") yaml.module.load(patch);
      else yaml.module.parse(patch);
    } catch (error) {
      report("fail", "cordis.patch.yml is not valid YAML", String(error.message).split("\n")[0]);
      finish();
      return;
    }
  }

  // The template writes this as a list item's id (`- id: agent-default-model`)
  // with the route indented beneath it, not as a `key: value` pair — which is
  // what `search(/agent-default-model:/)` assumed, and so never found.
  const routeAt = active.search(/^\s*(?:-\s*)?id:\s*agent-default-model\s*$/m);
  if (routeAt === -1) {
    report(
      "fail",
      "no agent-default-model in the profile patch",
      `edit ${patchPath} (see the README install walkthrough) then restart the daemon`,
    );
  } else {
    const block = active.slice(routeAt);
    // `[ \t]` and not `\s`: `\s` matches newlines, so on an empty `provider:` it
    // consumed the line break and read the *next* line's key as the value.
    const provider = block.match(/^[ \t]*provider:[ \t]*(\S+)/m)?.[1];
    const model = block.match(/^[ \t]*model:[ \t]*(\S+)/m)?.[1];
    if (provider === undefined || model === undefined) {
      report(
        "fail",
        "model route is incomplete",
        `set both provider: and model: under agent-default-model in ${patchPath}`,
      );
    } else if (!/^[ \t]*providers:[ \t]*$/m.test(active)) {
      report("fail", "no providers: section in the profile patch", `add one under agent-default-model in ${patchPath}`);
    } else {
      report("ok", "model route configured", `default: ${provider} / ${model}`);
    }
  }

  // 4. credentials for every referenced apiKeyEnv
  const credentialPath = join(dshHome, ".credentials.yaml");
  const credentialRead = readText(credentialPath);
  if (credentialRead.error !== undefined) {
    report("fail", `cannot read ${credentialPath}`, credentialRead.error);
    finish();
    return;
  }
  const credentialText = credentialRead.text;
  // Scope to `refs:`: a key of the same name anywhere else is not a credential.
  const refsAt = credentialText.search(/^[ \t]*refs:[ \t]*$/m);
  const refsBlock = refsAt === -1 ? "" : credentialText.slice(refsAt);
  const referenced = [...active.matchAll(/apiKeyEnv:[ \t]*([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const unique = [...new Set(referenced)];
  if (unique.length === 0) {
    report("fail", "no apiKeyEnv referenced", "the route above should name the credential to use");
  } else {
    for (const name of unique) {
      // The value has to be non-empty: `NAME:` with nothing after it satisfied
      // the old "is the name in the file" test and then 401'd on every turn.
      const value = refsBlock.match(new RegExp(`^[ \\t]*${name}:[ \\t]*(\\S.*)$`, "m"))?.[1];
      if (value !== undefined) report("ok", `credential ${name} found`);
      else
        report(
          "fail",
          `credential ${name} missing`,
          `add "${name}: <your-key>" under refs: in ${credentialPath}`,
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
