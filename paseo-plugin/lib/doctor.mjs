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
 * YAML syntax is parsed for real when a parser resolves from here (`yaml` or
 * `js-yaml`, whichever the install brought in). When neither does, that is
 * **said out loud** rather than assumed away, because "we could not check this"
 * and "this is fine" are different answers and only one of them is honest.
 *
 * @module paseo-dsh/lib/doctor
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

/** Strip full-line comments so "route configured?" isn't fooled by the template. */
function activeLines(text) {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

/** Whatever YAML parser this install happens to carry, or `undefined`. */
function loadYaml() {
  for (const name of ["yaml", "js-yaml"]) {
    try {
      return { name, module: require(name) };
    } catch {
      // Try the next spelling; the caller reports when none resolves.
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
  const profile = process.env.DSH_PASEO_PROFILE ?? "paseo";
  const profileDir = join(dshHome, "profiles", profile);

  process.stdout.write(`\n${DIM}paseo-dsh doctor  (plugin ${pluginVersion})${RESET}\n\n`);

  // 1. CLIs
  const dshVersion = run("dsh", ["--version"]);
  if (dshVersion === undefined) {
    report("fail", "dsh on PATH", "install the official DeepSeek Harness and put `dsh` on the daemon's PATH");
  } else {
    const dshLine = line(dshVersion);
    const dshMM = dshLine.match(/(\d+)\.(\d+)/);
    const pluginMM = pluginVersion.match(/^(\d+)\.(\d+)/);
    if (dshMM && pluginMM && `${dshMM[1]}.${dshMM[2]}` !== `${pluginMM[1]}.${pluginMM[2]}`) {
      report("warn", `dsh ${dshLine}`, `plugin ${pluginVersion} targets the ${pluginMM[1]}.${pluginMM[2]}.x DSH line`);
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
        report("fail", "dsh-paseo is not installed in Paseo", "install it with `paseo plugin add npm:paseo-dsh`");
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
  // The package entry, not `server.js`: `main`/`exports` point at `lib/index.js`,
  // so that is what breaks first if the bundle is half-written.
  const bridgeEntry = join(bridgeDir, "lib", "index.js");
  if (existsSync(bridgeEntry)) {
    report("ok", "bridge bundle provisioned", bridgeDir);
  } else {
    report("fail", "bridge bundle missing", `expected ${bridgeEntry}; restart the daemon to let the plugin re-provision`);
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
