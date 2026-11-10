/**
 * Offline check for `paseo-dsh doctor`.
 *
 * Doctor's whole job is to say whether an install can work. It used to answer
 * "yes" to configurations that cannot: `provider:` present but empty reported
 * `ok` with no detail, a credential whose value was blank counted as found, a
 * key of the right name outside `refs:` counted too, and a file with a YAML
 * syntax error still ended in "All checks passed" with exit 0 — the same exit
 * code as success, for an install that cannot start a single turn.
 *
 * This drives the real `runDoctor()` against sandboxed `DSH_HOME` trees and
 * asserts the verdicts, so the next `ok` on a broken file is a test failure:
 *
 *   1. an empty (and a quoted-empty) `provider:`/`model:` is a failure, not `ok`
 *   2. a missing `agent-default-model` is a failure; an empty `config` cannot
 *      borrow a later entry's `provider:`/`model:`
 *   3. a YAML syntax error is a failure
 *   4. a credential with no value — plain, quoted-empty or comment-only — is a
 *      failure
 *   5. a credential outside `refs:` is a failure, including one in a block after
 *      `refs:` has ended
 *   5b. a `disabled: true` agent-default-model and a route naming an undefined
 *       `llm-pi-ai` provider are failures
 *   6. a complete configuration in the real template shape (separate
 *      `llm-pi-ai` + `agent-default-model` entries) is still accepted
 *   7. a bridge missing a lazy module is a failure, not `ok`
 *   8. a complete bridge is still accepted (the control for 7); the same bridge
 *      at the shared anchor beside the profiles (where bootstrap.ts now
 *      provisions it, outside pnpm's directory) is accepted too, and a leftover
 *      profile-local copy is reported as shadowing it
 *   9. an unreadable file list is a failure, not a warning with exit 0
 *  10. a YAML syntax error is a failure even when the *plugin* ships no parser,
 *      as long as the DSH install has one — the shape of every published install
 *  11. a profile without `package.json` is a failure (DSH says the profile does
 *      not exist), and one whose `dsh.profile.bundles` omits
 *      `dsh-paseo-bridge` is a failure (DSH boots without the bridge); a list
 *      that names it is accepted
 *  12. a patch entry DSH skipped (`dsh --dump-config` prints a warning and
 *      carries on) is a failure, not `ok` on the profile patch; a dump that
 *      cannot compose the profile is a failure too, and a clean dump is accepted
 *  13. a credentials document DSH refuses — no `version: 1`, group/other
 *      permission bits, or a ref name outside its grammar — is a failure, while
 *      the pre-release flat layout it migrates in place is still accepted
 *
 * Cases 11-13 are the 2026-11-03 audit's DLV-01/02/03: the same false-green
 * shape one layer further in. `doctor` read the profile directory, the patch
 * file and `refs:` but never the contracts DSH applies to them. The `dsh`
 * stand-in answers `--dump-config` from a marker comment in the patch (see
 * `stubHostClis`) — this file is hermetic and cannot run the real composition;
 * `harness/doctor-live-check.mjs` drives the same rows against a real DSH.
 *
 * Case 10 exists because case 3 only ever passes in a development checkout. The
 * plugin declares no `dependencies` and does not ship `node_modules`, so a real
 * `paseo plugin add npm:paseo-dsh` install resolves neither `yaml` nor
 * `js-yaml` from the plugin directory. `loadYaml()` used to look there alone,
 * which meant every published install took the `[warn] YAML syntax not
 * validated` branch and then reported `nothing blocking` with exit 0 for a
 * `cordis.patch.yml` that is not YAML at all. The check now falls back to the
 * parser DSH itself carries, so the case is built as the two-directory split it
 * describes: a plugin copy with no reachable parser, and a `dsh` on PATH whose
 * package directory does have one.
 *
 * The bridge cases (7/8) exist because the check used to look for `lib/index.js`
 * alone: a bridge with the entry but without `lib/child-anchors.js`,
 * `lib/revert.js` or `lib/mcp-gateway.js` printed `[ok] bridge bundle
 * provisioned` and doctor exited 0 — the same verdict a working install gets,
 * for one where DSH prints `ERR_MODULE_NOT_FOUND` and never answers
 * `initialize`. The positive control is what keeps 7 from being satisfied by a
 * check that can only ever fail.
 *
 * The CLI and plugin rows are not asserted: they describe the host, not the
 * sandbox. They are still driven to `ok` by stub executables at the front of
 * PATH (see `stubHostClis`), because doctor fails a bare host before it reads
 * anything about the sandbox — and case 6, the negative control for the sandbox
 * checks, has to be green on a machine that never installed the tools, such as
 * a CI runner. That holds where doctor resolves the CLIs through PATH; on macOS
 * with Paseo.app installed the bundled CLI is preferred (see `stubHostClis`).
 * Only the route, credential and bridge verdicts are read.
 *
 * Usage: node harness/doctor-check.mjs
 */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDoctor } from "../paseo-plugin/lib/doctor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The bridge package's file list, walked from `dsh-bridge/` — the directory the
 * asset generator reads — instead of from `bridge-assets.ts`, which is what the
 * doctor itself reads. Taking it from the same place would let a truncated key
 * list in the doctor pass this check by agreeing with itself.
 *
 * The filter mirrors `paseo-plugin/scripts/generate-bridge-assets.mjs`; that the
 * two lists agree is `harness/bridge-assets-check.mjs`'s job.
 */
function bridgeSourceFiles() {
  const root = join(HERE, "..", "dsh-bridge");
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(root);
  return found.filter((path) => {
    const leaf = path.split("/").pop();
    return leaf === "package.json" || leaf === "cordis.patch.yml" || path.endsWith(".js");
  });
}

const BRIDGE_FILES = bridgeSourceFiles();

const WORK = mkdtempSync(join(tmpdir(), "doctor-check-"));
const PROFILE = "doctor-check";
process.env.DSH_PASEO_PROFILE = PROFILE;

/**
 * Put stub `dsh` and `paseo` executables at the front of PATH before any doctor
 * run.
 *
 * `runDoctor()` starts with the host, not the sandbox: a `dsh` that is not on
 * PATH is a `fail`, and so is a `paseo` that is neither on PATH nor in
 * /Applications. Case 6 is the negative control for the sandbox checks, so it
 * can only be green when nothing blocks — but a CI runner has installed neither
 * tool, so the control went red over rows it does not govern. That is exactly
 * what happened on 2026-10-27 in the Sync upstream gate: 20/21,
 * `FAIL with nothing blocking` — a complete sandboxed install was called
 * blocked because the runner was bare, and the merged `main` was never pushed.
 * A complete install is still complete when the host is bare, so the stubs make
 * the control judge the sandbox instead of the machine — on any host where
 * doctor resolves the CLIs through PATH.
 *
 * The exception is macOS with Paseo.app installed: `findPaseo()` (doctor.mjs)
 * tries `/Applications/Paseo.app/Contents/Resources/bin/paseo` before PATH, so
 * the stub `paseo` is never consulted there and the plugin row — hence case 6 —
 * still reflects that machine's real Paseo state. Linux, GitHub's
 * ubuntu-latest, and a bare mac are all covered by the stub.
 *
 * They answer only the probes doctor makes: `dsh --version`, `paseo --version`
 * and `paseo plugin ls`. Any other argv exits 1 with no output, so a future
 * doctor that asks a new question fails loudly instead of reading a stale stub
 * answer. Their own verdicts are not asserted — they describe the host, not the
 * sandbox, and doctor's rows for them are not read by this check.
 *
 * Keep the versions in step with doctor's constants: `dsh` reports the build
 * this repository was verified against, on the plugin's 0.2.x line and >=
 * MINIMUM_DSH (0.2.1); `paseo` is >= MINIMUM_PASEO (0.16.0). If doctor raises a
 * minimum past these, raise the stubs with it or case 6 turns red wherever the
 * stub is consulted.
 */
function stubHostClis() {
  const bin = join(WORK, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = (name, script) => {
    const path = join(bin, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  };
  // `dsh --profile <name> --dump-config` is doctor's composition check (DLV-02).
  // A real composition needs a real DSH install, so this stand-in answers from a
  // marker comment in the profile patch: the case decides what DSH "reported",
  // and the doctor's handling of that verdict is what this file pins. The real
  // warning text and the real composition are asserted by
  // `harness/doctor-live-check.mjs`.
  executable(
    "dsh",
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  echo "0.2.1-rc.2"',
      "  exit 0",
      "fi",
      'if [ "$1" = "--profile" ] && [ "$3" = "--dump-config" ]; then',
      '  patch="$DSH_HOME/profiles/$2/cordis.patch.yml"',
      '  if grep -q "DOCTOR-CHECK-DUMP-FAIL" "$patch" 2>/dev/null; then',
      '    echo "Error: dsh: failed to parse overlay $patch: unexpected end of the stream" >&2',
      "    exit 1",
      "  fi",
      '  if grep -q "DOCTOR-CHECK-PATCH-SKIPPED" "$patch" 2>/dev/null; then',
      '    echo "dsh: [$patch] patch: name mismatch for \\"agent-default-model\\" (expected \\"@deepseek-ai/dsh-agent-default-model\\", got \\"@deepseek-ai/dsh-agent-default-model-TYPO\\"), skipping" >&2',
      "  fi",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  executable(
    "paseo",
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      // Must clear the plugin's Paseo floor, which this build raised to 0.16
      // (composer options moved to `controls`/`providerOptions`).
      '  echo "0.16.0"',
      'elif [ "$1" = "plugin" ] && [ "$2" = "ls" ]; then',
      // The row doctor looks for: a line starting with `dsh-paseo` whose text
      // carries the word `running`.
      '  printf "dsh-paseo  0.2.10  running\\n"',
      "else",
      "  exit 1",
      "fi",
      "",
    ].join("\n"),
  );
  // `delimiter` is `;` on win32: the scripts cannot run there at all (Windows is
  // not a supported host), but prepending must not corrupt PATH on the way in.
  process.env.PATH = [bin, process.env.PATH ?? ""].filter((entry) => entry !== "").join(delimiter);
}
stubHostClis();

/**
 * A doctor whose `server/bridge-assets.ts` cannot yield a key list — case 9.
 *
 * Built by copying the real module and package.json into a sandbox with a
 * deliberately unusable assets file, then importing that copy. Stubbing
 * `loadBridgeFileList` would test the stub; copying the module tests the real
 * degraded path, including its exit code.
 */
const DEGRADED_PLUGIN = join(WORK, "degraded-plugin");
mkdirSync(join(DEGRADED_PLUGIN, "lib"), { recursive: true });
mkdirSync(join(DEGRADED_PLUGIN, "server"), { recursive: true });
copyFileSync(join(HERE, "..", "paseo-plugin", "lib", "doctor.mjs"), join(DEGRADED_PLUGIN, "lib", "doctor.mjs"));
copyFileSync(join(HERE, "..", "paseo-plugin", "package.json"), join(DEGRADED_PLUGIN, "package.json"));
// Valid TypeScript that simply does not export `BRIDGE_FILES`: what a truncated
// or half-written generated asset looks like to the doctor.
writeFileSync(join(DEGRADED_PLUGIN, "server", "bridge-assets.ts"), "export const NOT_BRIDGE_FILES = 1;\n");
const { runDoctor: runDegradedDoctor } = await import(
  pathToFileURL(join(DEGRADED_PLUGIN, "lib", "doctor.mjs")).href
);

/**
 * A patch shaped like the one the plugin writes, and like the schema DSH
 * actually loads: `providers` belongs to the `llm-pi-ai` entry
 * (`config.providers`, a dict keyed by route), and `agent-default-model` only
 * names the route/model it defaults to. The old control nested `providers`
 * under `agent-default-model.config`, a shape the real template never writes —
 * which is how the regex checks below stayed green on invalid files.
 */
const VALID_ROUTE = [
  "# profile patch",
  "- id: llm-pi-ai",
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  "  config:",
  "    providers:",
  "      my-gateway:",
  "        displayName: My Gateway",
  "        apiKeyEnv: MY_GATEWAY_KEY",
  "        api: openai-completions",
  "        baseURL: https://example.invalid/v1",
  "        models:",
  "          - id: my-model",
  "            name: my-model",
  "            reasoningEfforts: false",
  "- id: agent-default-model",
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  "  config:",
  "    provider: my-gateway",
  "    model: my-model",
  "    reasoningEffort: high",
  "",
].join("\n");

const VALID_CREDENTIALS = ["version: 1", "refs:", "  MY_GATEWAY_KEY: a-secret-value", ""].join("\n");

/**
 * The profile manifest the plugin writes (`profilePackageJson()` in
 * bootstrap.ts). Case 6 and every other "complete install" fixture carries it,
 * because a profile directory alone is not a profile DSH can load.
 */
const VALID_PROFILE_MANIFEST = {
  name: `dsh-profile-${PROFILE}`,
  private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-paseo-bridge"] } },
};

/**
 * Write one sandboxed install and point the doctor at it.
 *
 * `manifest` defaults to the file the plugin writes; pass `null` to leave it
 * out (the profile DSH reports as not existing) or another object to replace it.
 * The credentials file is written `0600`, the mode the DSH provider creates it
 * with; `credentialsMode` overrides it for the permission contract case.
 */
function install({
  patch,
  credentials,
  bridge = BRIDGE_FILES,
  manifest = VALID_PROFILE_MANIFEST,
  credentialsMode = 0o600,
  bridgeLocation = "local",
  shadowBridge = false,
}) {
  const home = mkdtempSync(join(WORK, "home-"));
  const profileDir = join(home, "profiles", PROFILE);
  const localBridgeDir = join(profileDir, "node_modules", "dsh-paseo-bridge");
  // `bootstrap.ts` provisions the bridge at the shared anchor beside the
  // profiles (outside the profile's pnpm-managed node_modules); a pre-migration
  // install still has it profile-locally, which DSH resolves first.
  const bridgeDir =
    bridgeLocation === "shared" ? join(home, "profiles", "node_modules", "dsh-paseo-bridge") : localBridgeDir;
  // The profile directory is no longer implied by the bridge location: at the
  // shared anchor the bridge lives beside the profiles, not inside this one.
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(join(bridgeDir, "lib"), { recursive: true });
  // A complete bridge by default: the entry alone is what the old check accepted,
  // and an install shaped like that must be a failure now (case 7).
  for (const relativePath of bridge) {
    const target = join(bridgeDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "");
  }
  if (shadowBridge) {
    for (const relativePath of bridge) {
      const target = join(localBridgeDir, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "");
    }
  }
  if (manifest !== null) writeFileSync(join(profileDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(profileDir, "cordis.patch.yml"), patch);
  if (credentials !== undefined) {
    const credentialPath = join(home, ".credentials.yaml");
    writeFileSync(credentialPath, credentials);
    chmodSync(credentialPath, credentialsMode);
  }
  process.env.DSH_HOME = home;
}

/**
 * The doctor paints its level tags (`[\u001b[33mwarn\u001b[0m]`), so an assertion
 * written against the literal `[warn]` never matches — the first version of case 9
 * did exactly that and stayed green while the row was still a warning. Levels are
 * asserted on the stripped text.
 */
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * Run the doctor with stdout captured; returns what it said and the exit it set.
 *
 * `entry` defaults to the real module and is overridden by case 9, which needs a
 * doctor whose `server/bridge-assets.ts` is unusable — the only way to reach the
 * degraded branch without breaking this repository's own assets file.
 */
function doctor(entry = runDoctor) {
  const chunks = [];
  const realOut = process.stdout.write;
  process.stdout.write = (chunk) => (chunks.push(String(chunk)), true);
  process.exitCode = 0;
  try {
    entry();
  } finally {
    process.stdout.write = realOut;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out: chunks.join(""), code: Number(code) };
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

// ---- 1. an empty provider/model is not a route ---------------------------
{
  const patch = VALID_ROUTE.replace("provider: my-gateway", "provider:").replace("model: my-model", "model:");
  install({ patch, credentials: VALID_CREDENTIALS });
  const run = doctor();
  check(
    "an empty provider:/model: is a failure, not `ok`",
    run.out.includes("model route is incomplete") && !run.out.includes("model route configured"),
    run.out.trim().split("\n").filter((l) => l.includes("model route")).join(" | ") || "(no route line)",
  );
  check("and the install exits non-zero", run.code === 1, `exit ${run.code}`);
}

// ---- 1b. quoted-empty strings are still empty ----------------------------
{
  // YAML parses `""` to an empty string. A regex looking for non-space
  // characters saw the two quote characters and called the route configured.
  const patch = VALID_ROUTE.replace("provider: my-gateway", 'provider: ""').replace("model: my-model", 'model: ""');
  install({ patch, credentials: VALID_CREDENTIALS });
  const run = doctor();
  check(
    "a quoted-empty provider:/model: is a failure, not `ok`",
    run.out.includes("model route is incomplete") && run.code === 1,
    run.out.trim().split("\n").filter((l) => l.includes("model route")).join(" | ") || "(no route line)",
  );
}

// ---- 2. a missing agent-default-model is a failure -----------------------
{
  install({ patch: "[]\n", credentials: VALID_CREDENTIALS });
  const run = doctor();
  check(
    "a patch with no agent-default-model is a failure",
    run.out.includes("no agent-default-model") && run.code === 1,
    `exit ${run.code}`,
  );
}

// ---- 2b. an empty config cannot borrow a later entry's provider/model ----
{
  // The old `active.slice(routeAt)` scan ran to EOF, so an unrelated entry
  // below the disabled/empty route supplied both values and the doctor printed
  // them as the default route.
  const patch = [
    "- id: agent-default-model",
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    "  config: {}",
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    "      other-gateway:",
    "        apiKeyEnv: MY_GATEWAY_KEY",
    "- id: some-other-route",
    "  config:",
    "    provider: other-gateway",
    "    model: other-model",
    "",
  ].join("\n");
  install({ patch, credentials: VALID_CREDENTIALS });
  const run = doctor();
  check(
    "an empty agent-default-model config is a failure even when a later entry has provider:/model:",
    run.out.includes("model route is incomplete") && !run.out.includes("default: other-gateway"),
    run.out.trim().split("\n").filter((l) => l.includes("model route") || l.includes("default:")).join(" | ") ||
      "(no route line)",
  );
  check("and the unrelated values are not reported as the default", run.code === 1, `exit ${run.code}`);
}

// ---- 3. a YAML syntax error is a failure ---------------------------------
{
  install({ patch: `${VALID_ROUTE}this is: [not, valid yaml\n`, credentials: VALID_CREDENTIALS });
  const run = doctor();
  check(
    "a YAML syntax error is a failure, not `All checks passed`",
    run.out.includes("not valid YAML") && !run.out.includes("All checks passed") && run.code === 1,
    run.out.trim().split("\n").find((l) => l.includes("YAML")) ?? `exit ${run.code}`,
  );
}

// ---- 4. a credential with no value is not a credential -------------------
{
  // DSH refuses the document (`parseRefs()`: "the value for X is empty"), so
  // the verdict is the contract row, not a `found` credential. The per-ref row
  // is covered by cases 5/5b for documents DSH would load.
  install({ patch: VALID_ROUTE, credentials: ["version: 1", "refs:", "  MY_GATEWAY_KEY:", ""].join("\n") });
  const run = doctor();
  check(
    "a credential with an empty value is a failure",
    run.out.includes('credentials ref "MY_GATEWAY_KEY" has no usable value') && run.code === 1,
    run.out.trim().split("\n").filter((l) => l.includes("credentials ref")).join(" | "),
  );
}

// ---- 4b. quoted-empty and comment-only credentials are empty ------------
{
  for (const [name, value] of [
    ["a quoted-empty credential", '  MY_GATEWAY_KEY: ""'],
    ["a comment-only credential", "  MY_GATEWAY_KEY: # no value"],
  ]) {
    install({ patch: VALID_ROUTE, credentials: ["version: 1", "refs:", value, ""].join("\n") });
    const run = doctor();
    check(
      `${name} is a failure, not a found credential`,
      run.out.includes('credentials ref "MY_GATEWAY_KEY" has no usable value') && run.code === 1,
      run.out.trim().split("\n").filter((l) => l.includes("credentials ref")).join(" | "),
    );
  }
}

// ---- 5. a same-named key outside refs: is not a credential ---------------
{
  const credentials = ["version: 1", "something_else:", "  MY_GATEWAY_KEY: a-secret-value", ""].join("\n");
  install({ patch: VALID_ROUTE, credentials });
  const run = doctor();
  check(
    "a key outside refs: does not satisfy the credential check",
    run.out.includes("credential MY_GATEWAY_KEY missing") && run.code === 1,
    run.out.trim().split("\n").filter((l) => l.includes("credential")).join(" | "),
  );
}

// ---- 5b. a credential in a block after refs: ended is not in refs: -------
{
  // The old `credentialText.slice(refsAt)` read to EOF, so a same-named key in
  // the next top-level block counted. Parsed as an object, only `refs.*`.
  const credentials = [
    "version: 1",
    "refs:",
    "  OTHER_KEY: other-value",
    "other_section:",
    "  MY_GATEWAY_KEY: a-secret-value",
    "",
  ].join("\n");
  install({ patch: VALID_ROUTE, credentials });
  const run = doctor();
  check(
    "a key after refs: ended does not satisfy the credential check",
    run.out.includes("credential MY_GATEWAY_KEY missing") && run.code === 1,
    run.out.trim().split("\n").filter((l) => l.includes("credential")).join(" | "),
  );
}

// ---- 5c. a disabled default-model is not an active route ----------------
{
  const patch = VALID_ROUTE.replace(
    '  name: "@deepseek-ai/dsh-agent-default-model"\n  config:',
    '  name: "@deepseek-ai/dsh-agent-default-model"\n  disabled: true\n  config:',
  );
  install({ patch, credentials: VALID_CREDENTIALS });
  const run = doctor();
  check(
    "a disabled agent-default-model is a failure, not `All checks passed`",
    run.out.includes("agent-default-model is disabled") && !run.out.includes("All checks passed") && run.code === 1,
    run.out.trim().split("\n").find((l) => l.includes("agent-default-model")) ?? `exit ${run.code}`,
  );
}

// ---- 5d. the route must name a provider defined by llm-pi-ai ------------
{
  const patch = VALID_ROUTE.replace("provider: my-gateway", "provider: not-configured");
  install({ patch, credentials: VALID_CREDENTIALS });
  const run = doctor();
  check(
    "a route pointing at an undefined provider is a failure",
    run.out.includes('references unknown provider "not-configured"') && run.code === 1,
    run.out.trim().split("\n").filter((l) => l.includes("provider")).join(" | ") || "(no provider line)",
  );
}

// ---- 6. a complete install is still accepted -----------------------------
{
  install({ patch: VALID_ROUTE, credentials: VALID_CREDENTIALS });
  const run = doctor();
  check(
    "a complete configuration still reports the route",
    run.out.includes("model route configured") && run.out.includes("default: my-gateway / my-model"),
    run.out.trim().split("\n").find((l) => l.includes("default:")) ?? "(none)",
  );
  check(
    "and its credential is found",
    run.out.includes("credential MY_GATEWAY_KEY found"),
  );
  check(
    "and its profile bundle list names the bridge",
    run.out.includes("profile loads the dsh-paseo-bridge bundle"),
    run.out.trim().split("\n").find((l) => l.includes("profile loads")) ?? "(no profile line)",
  );
  check(
    "and DSH's own composition applied the patch",
    run.out.includes("profile patch applied by DSH"),
    run.out.trim().split("\n").find((l) => l.includes("profile patch")) ?? "(no patch line)",
  );
  check("with nothing blocking", !run.out.includes("blocking issue"), `exit ${run.code}`);
}

// ---- 7. a bridge missing a lazy module is a failure ----------------------
{
  // The three files the old check looked for, and nothing else: this is the
  // bridge an interrupted provision leaves behind, and the one doctor called
  // `ok` while DSH died on `ERR_MODULE_NOT_FOUND`.
  const truncated = ["cordis.patch.yml", "lib/index.js", "package.json"];
  const dropped = BRIDGE_FILES.filter((path) => !truncated.includes(path));
  install({ patch: VALID_ROUTE, credentials: VALID_CREDENTIALS, bridge: truncated });
  const run = doctor();
  check(
    "a bridge without its lazy modules is a failure, not `ok`",
    run.out.includes("bridge bundle incomplete") && !run.out.includes("bridge bundle provisioned"),
    run.out.trim().split("\n").filter((l) => l.includes("bridge")).join(" | ") || "(no bridge line)",
  );
  check(
    "and it names a missing module so the user can act",
    run.out.includes("lib/child-anchors.js"),
    `dropped ${dropped.length}: ${dropped.slice(0, 3).join(", ")}…`,
  );
  check("and the install exits non-zero", run.code === 1, `exit ${run.code}`);
  check("and it does not claim everything passed", !run.out.includes("All checks passed"));
}

// ---- 8. a complete bridge is still accepted (the control for 7) ----------
{
  install({ patch: VALID_ROUTE, credentials: VALID_CREDENTIALS });
  const run = doctor();
  check(
    `a complete ${BRIDGE_FILES.length}-file bridge still reports provisioned`,
    run.out.includes(`bridge bundle provisioned (${BRIDGE_FILES.length} files)`),
    run.out.trim().split("\n").find((l) => l.includes("bridge bundle")) ?? "(no bridge line)",
  );
  check("and it is not reported incomplete", !run.out.includes("bridge bundle incomplete"));
  check("and it is not reported missing", !run.out.includes("bridge bundle missing"));
}

// ---- 8b. the bridge lives at the shared anchor beside the profiles --------
// pnpm owns `<profile>/node_modules` and moved the undeclared bridge into
// `.ignored` on every `dsh plugin` command (pnpm 12 hoisted orphan cleanup), so
// bootstrap.ts now provisions `$DSH_HOME/profiles/node_modules/dsh-paseo-bridge`.
// A doctor that only looked profile-locally would call that install incomplete.
{
  install({ patch: VALID_ROUTE, credentials: VALID_CREDENTIALS, bridgeLocation: "shared" });
  const run = doctor();
  check(
    `a complete ${BRIDGE_FILES.length}-file bridge at the shared anchor reports provisioned`,
    run.out.includes(`bridge bundle provisioned (${BRIDGE_FILES.length} files)`),
    run.out.trim().split("\n").find((l) => l.includes("bridge bundle")) ?? "(no bridge line)",
  );
  check(
    "and it names the shared anchor, not the profile-local path",
    run.out.includes(join("profiles", "node_modules", "dsh-paseo-bridge")),
    run.out.trim().split("\n").find((l) => l.includes("dsh-paseo-bridge")) ?? "(no path)",
  );
  check("and the install is not called incomplete", !run.out.includes("bridge bundle incomplete"));
}

// ---- 8c. a leftover profile-local copy shadows the provisioned one --------
// DSH resolves the profile's own node_modules first, so both copies existing
// means the stale one boots. Doctor has to name that instead of reporting the
// provisioned copy as what is live.
{
  install({ patch: VALID_ROUTE, credentials: VALID_CREDENTIALS, bridgeLocation: "shared", shadowBridge: true });
  const run = doctor();
  const plain = stripAnsi(run.out);
  check(
    "a legacy profile-local bridge copy is reported as shadowing the provisioned one",
    plain.includes("legacy bridge copy shadows the provisioned one"),
    plain.trim().split("\n").find((l) => l.includes("shadows")) ?? "(no shadow line)",
  );
  check(
    "and the shadowed shared copy is still reported provisioned",
    run.out.includes(`bridge bundle provisioned (${BRIDGE_FILES.length} files)`),
  );
  check("and a shadow is a warning, not a blocking failure", run.code === 0, `exit ${run.code}`);
}

// ---- 9. an unreadable file list is a failure, not a warning --------------
{
  // The case that used to print `[warn] bridge contents not verified`,
  // `[ok] bridge entry present` and "1 warning(s) — nothing blocking" with
  // exit 0 — on a bridge missing 15 of its 18 files. "We could not check this"
  // and "this is fine" are different answers, and only one of them may exit 0.
  install({ patch: VALID_ROUTE, credentials: VALID_CREDENTIALS, bridge: ["cordis.patch.yml", "lib/index.js", "package.json"] });
  const run = doctor(runDegradedDoctor);
  const plain = stripAnsi(run.out);
  check(
    "an unreadable file list is reported as a failure, not a warning",
    /\[fail\] bridge contents not verified/.test(plain) && !/\[warn\] bridge contents not verified/.test(plain),
    plain.trim().split("\n").filter((l) => l.includes("bridge contents")).join(" | ") || "(no line)",
  );
  check("and the install exits non-zero", run.code === 1, `exit ${run.code}`);
  check(
    "and it does not claim nothing is blocking",
    !run.out.includes("nothing blocking") && !run.out.includes("All checks passed"),
    run.out.trim().split("\n").at(-1),
  );
  check(
    "and it does not claim the entry alone makes the bridge fine",
    !run.out.includes("bridge entry present"),
    run.out.trim().split("\n").filter((l) => l.includes("bridge entry")).join(" | ") || "(no such line)",
  );
  // The control: the same incomplete bridge with a readable list is also a
  // failure, so case 9 cannot be satisfied by a doctor that fails everything.
  const control = doctor();
  check(
    "the readable-list control still names the missing files",
    control.out.includes("bridge bundle incomplete") && control.code === 1,
    control.out.trim().split("\n").filter((l) => l.includes("bridge bundle")).join(" | ") || "(no bridge line)",
  );
}

// ---- 10. a published install: no plugin parser, DSH has one --------------
// The shape `paseo plugin add npm:paseo-dsh` produces. Case 3 passes in a
// development checkout because `paseo-plugin/node_modules` is there; a published
// install ships no `node_modules` at all, so `loadYaml()` found nothing and every
// such install reported `[warn] YAML syntax not validated` + `nothing blocking`
// + exit 0 for a file that is not YAML. Built as the two-directory split: the
// plugin copy has no reachable parser, the `dsh` on PATH does.
{
  const NO_PARSER_PLUGIN = join(WORK, "no-parser-plugin");
  mkdirSync(join(NO_PARSER_PLUGIN, "lib"), { recursive: true });
  mkdirSync(join(NO_PARSER_PLUGIN, "server"), { recursive: true });
  copyFileSync(join(HERE, "..", "paseo-plugin", "lib", "doctor.mjs"), join(NO_PARSER_PLUGIN, "lib", "doctor.mjs"));
  copyFileSync(join(HERE, "..", "paseo-plugin", "package.json"), join(NO_PARSER_PLUGIN, "package.json"));
  // The real asset file, so the bridge row is green and cannot be the reason a
  // verdict below differs between the two runs.
  copyFileSync(
    join(HERE, "..", "paseo-plugin", "server", "bridge-assets.ts"),
    join(NO_PARSER_PLUGIN, "server", "bridge-assets.ts"),
  );

  // The parser `dsh` carries. Symlinked rather than copied: it is the same
  // implementation the real install would judge the file with.
  const FAKE_DSH = join(WORK, "fake-dsh");
  const fakeBin = join(FAKE_DSH, "lib", "bin.js");
  mkdirSync(join(FAKE_DSH, "lib"), { recursive: true });
  mkdirSync(join(FAKE_DSH, "node_modules"), { recursive: true });
  writeFileSync(join(FAKE_DSH, "package.json"), '{"name":"@deepseek-ai/dsh","version":"0.2.1"}\n');
  writeFileSync(
    fakeBin,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "0.2.1-rc.2"; exit 0; fi',
      // The composition check is not what this case is about; a clean dump keeps
      // the run on the parser-fallback path it was built for.
      'if [ "$1" = "--profile" ] && [ "$3" = "--dump-config" ]; then exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeBin, 0o755);
  symlinkSync(join(HERE, "..", "paseo-plugin", "node_modules", "yaml"), join(FAKE_DSH, "node_modules", "yaml"), "dir");
  // `dsh` on PATH is a symlink into the install, exactly like a global bin dir.
  const fakeDshBin = join(WORK, "fake-dsh-bin");
  mkdirSync(fakeDshBin, { recursive: true });
  symlinkSync(fakeBin, join(fakeDshBin, "dsh"));

  // Preconditions, asserted rather than assumed: a sandbox that can reach a
  // parser from the plugin copy, or cannot reach one from the DSH copy, would
  // make the two runs below agree for a reason unrelated to the fallback.
  const pluginRequire = createRequire(join(NO_PARSER_PLUGIN, "lib", "doctor.mjs"));
  const resolvesFrom = (anchor) => {
    for (const name of ["yaml", "js-yaml"]) {
      try {
        anchor(name);
        return name;
      } catch {
        // Try the next spelling.
      }
    }
    return undefined;
  };
  check(
    "the plugin copy resolves no YAML parser (the published-install shape)",
    resolvesFrom(pluginRequire) === undefined,
    resolvesFrom(pluginRequire) ?? "no parser reachable",
  );
  const dshRequire = createRequire(join(FAKE_DSH, "package.json"));
  check(
    "the stand-in DSH install does resolve one",
    resolvesFrom(dshRequire) !== undefined,
    resolvesFrom(dshRequire) ?? "none",
  );

  const { runDoctor: runNoParserDoctor } = await import(
    pathToFileURL(join(NO_PARSER_PLUGIN, "lib", "doctor.mjs")).href
  );

  const previousPath = process.env.PATH;
  try {
    process.env.PATH = [fakeDshBin, previousPath ?? ""].filter((entry) => entry !== "").join(delimiter);

    install({ patch: `${VALID_ROUTE}this is: [not, valid yaml\n`, credentials: VALID_CREDENTIALS });
    const bad = doctor(runNoParserDoctor);
    const badPlain = stripAnsi(bad.out);
    check(
      "a syntax error is a failure even when the plugin ships no parser",
      badPlain.includes("[fail] cordis.patch.yml is not valid YAML") && bad.code === 1,
      badPlain.trim().split("\n").find((l) => l.includes("YAML")) ?? `exit ${bad.code}`,
    );
    check(
      "and it does not fall back to `nothing blocking`",
      !bad.out.includes("nothing blocking") && !bad.out.includes("All checks passed"),
      bad.out.trim().split("\n").at(-1),
    );

    // The positive control: the same no-parser plugin copy must still accept a
    // valid patch, so the case cannot be satisfied by a doctor that fails on the
    // fallback alone.
    install({ patch: VALID_ROUTE, credentials: VALID_CREDENTIALS });
    const good = doctor(runNoParserDoctor);
    const goodPlain = stripAnsi(good.out);
    check(
      "a valid patch still passes with the DSH parser",
      good.code === 0 && goodPlain.includes("[ok  ] model route configured"),
      goodPlain.trim().split("\n").filter((l) => l.includes("model route")).join(" | ") || `exit ${good.code}`,
    );
    check(
      "and the syntax was actually checked, not skipped",
      !good.out.includes("YAML syntax not validated"),
      goodPlain.trim().split("\n").find((l) => l.includes("YAML")) ?? "(no YAML row)",
    );
  } finally {
    process.env.PATH = previousPath;
  }

  // Neither place has a parser: still a warning, never a failure. The published
  // install is the case the fallback was added for, but a host without a usable
  // `dsh` must not be turned into a blocking issue over a check that could not
  // run — the route and credential rows below it are still real answers.
  install({ patch: `${VALID_ROUTE}this is: [not, valid yaml\n`, credentials: VALID_CREDENTIALS });
  const noParserAtAll = doctor(runNoParserDoctor);
  const noParserPlain = stripAnsi(noParserAtAll.out);
  check(
    "with no parser anywhere the row is still a warning, not a failure",
    noParserPlain.includes("[warn] YAML syntax not validated") && !noParserPlain.includes("[fail] cordis.patch.yml is not valid YAML"),
    noParserPlain.trim().split("\n").filter((l) => l.includes("YAML")).join(" | ") || "(no YAML row)",
  );
  check(
    "and that install still exits 0 when nothing else blocks",
    noParserAtAll.code === 0,
    `exit ${noParserAtAll.code}`,
  );
}

// ---- 11. the profile must be a profile package that loads the bridge ------
// DLV-03: doctor used to check only that the profile directory exists. DSH
// resolves a profile through its `package.json` (none: "profile does not
// exist") and composes exactly `dsh.profile.bundles` (no bridge: boots without
// it), and the plugin's `writeIfAbsent()` never repairs an existing manifest.
{
  install({ patch: VALID_ROUTE, credentials: VALID_CREDENTIALS, manifest: null });
  const missing = doctor();
  check(
    "a profile without package.json is a failure",
    missing.out.includes("has no package.json") && missing.code === 1,
    missing.out.trim().split("\n").find((l) => l.includes("package.json")) ?? `exit ${missing.code}`,
  );
  check("and it does not claim everything passed", !missing.out.includes("All checks passed"));

  install({
    patch: VALID_ROUTE,
    credentials: VALID_CREDENTIALS,
    manifest: {
      name: "dsh-profile-doctor-check",
      private: true,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
    },
  });
  const noBridge = doctor();
  check(
    "a profile whose bundle list omits the bridge is a failure",
    noBridge.out.includes("does not load the bridge bundle") && noBridge.code === 1,
    noBridge.out.trim().split("\n").find((l) => l.includes("bridge bundle")) ?? `exit ${noBridge.code}`,
  );

  install({ patch: VALID_ROUTE, credentials: VALID_CREDENTIALS });
  const control = doctor();
  check(
    "the plugin's own bundle list is accepted",
    control.out.includes("profile loads the dsh-paseo-bridge bundle") && control.code === 0,
    control.out.trim().split("\n").find((l) => l.includes("profile loads")) ?? `exit ${control.code}`,
  );
}

// ---- 12. DSH must actually apply the patch, not skip it -------------------
// DLV-02: `applyEntryPatches()` matches a patch to the composed row by id and
// skips it with a warning when its `name` does not match; the boot prints that
// warning once and continues on the base default route. The stand-in `dsh`
// answers `--dump-config` from the marker comment (see `stubHostClis`), so
// these cases pin the doctor's handling of DSH's verdict, not the verdict.
{
  install({ patch: `${VALID_ROUTE}\n# DOCTOR-CHECK-PATCH-SKIPPED\n`, credentials: VALID_CREDENTIALS });
  const skipped = doctor();
  check(
    "a patch entry DSH skipped is a failure, not `ok`",
    skipped.out.includes("DSH skipped a patch entry") && skipped.code === 1,
    skipped.out.trim().split("\n").find((l) => l.includes("DSH skipped")) ?? `exit ${skipped.code}`,
  );
  check(
    "and the row quotes DSH's own warning",
    skipped.out.includes('patch: name mismatch for "agent-default-model"'),
    skipped.out.trim().split("\n").find((l) => l.includes("name mismatch")) ?? "(no warning)",
  );

  install({ patch: `${VALID_ROUTE}\n# DOCTOR-CHECK-DUMP-FAIL\n`, credentials: VALID_CREDENTIALS });
  const uncomposable = doctor();
  check(
    "a dump that cannot compose the profile is a failure",
    uncomposable.out.includes("DSH cannot compose profile") && uncomposable.code === 1,
    uncomposable.out.trim().split("\n").find((l) => l.includes("cannot compose")) ?? `exit ${uncomposable.code}`,
  );
  check(
    "and it quotes DSH's error instead of the stack",
    uncomposable.out.includes("failed to parse overlay") && !uncomposable.out.includes("    at "),
    uncomposable.out.trim().split("\n").find((l) => l.includes("failed to parse")) ?? "(no error line)",
  );

  install({ patch: VALID_ROUTE, credentials: VALID_CREDENTIALS });
  const control = doctor();
  check(
    "a clean dump is accepted",
    control.out.includes("profile patch applied by DSH") && control.code === 0,
    control.out.trim().split("\n").find((l) => l.includes("profile patch")) ?? `exit ${control.code}`,
  );
}

// ---- 13. credentials the DSH provider refuses are a failure --------------
// DLV-01: `dsh-credentials-local` refuses a document that is not `version: 1`
// (`parseCredentialsDocument`), is readable beyond its owner
// (`assertOwnerOnly`, before the file is read), or names a ref outside
// `/^[A-Za-z_][A-Za-z0-9_]*$/` (`credentialRef`). Doctor used to look only for
// a non-empty `refs.<name>` value.
{
  for (const [name, credentials, label] of [
    [
      "no version: 1",
      ["refs:", "  MY_GATEWAY_KEY: a-secret-value", ""].join("\n"),
      "credentials document has no version: 1",
    ],
    [
      "a ref name outside the DSH grammar",
      ["version: 1", "refs:", "  MY.GATEWAY_KEY: a-secret-value", ""].join("\n"),
      'credentials ref "MY.GATEWAY_KEY" is not a valid name',
    ],
    [
      "a non-string ref value",
      ["version: 1", "refs:", "  MY_GATEWAY_KEY: 12345", ""].join("\n"),
      'credentials ref "MY_GATEWAY_KEY" has no usable value',
    ],
  ]) {
    install({ patch: VALID_ROUTE, credentials });
    const run = doctor();
    check(
      `credentials with ${name} is a failure`,
      run.out.includes(label) && run.code === 1,
      run.out.trim().split("\n").find((l) => l.includes("credentials")) ?? `exit ${run.code}`,
    );
  }

  install({ patch: VALID_ROUTE, credentials: VALID_CREDENTIALS, credentialsMode: 0o644 });
  const wide = doctor();
  check(
    "a credentials file readable beyond its owner is a failure",
    wide.out.includes("readable beyond its owner (mode 644)") && wide.code === 1,
    wide.out.trim().split("\n").find((l) => l.includes("readable beyond")) ?? `exit ${wide.code}`,
  );

  // The pre-release flat layout is not a violation: DSH rewrites it as
  // `version: 1` + `refs:` in place and boots. Failing it would be a false red.
  install({ patch: VALID_ROUTE, credentials: "MY_GATEWAY_KEY: a-secret-value\n" });
  const flat = doctor();
  check(
    "the flat layout DSH migrates in place is still accepted",
    flat.out.includes("pre-release flat layout") &&
      flat.out.includes("credential MY_GATEWAY_KEY found") &&
      flat.code === 0,
    flat.out.trim().split("\n").find((l) => l.includes("flat layout")) ?? `exit ${flat.code}`,
  );
}

rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
