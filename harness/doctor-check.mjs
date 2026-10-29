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
 *   1. an empty `provider:`/`model:` is a failure, not `ok`
 *   2. a missing `agent-default-model` is a failure
 *   3. a YAML syntax error is a failure
 *   4. a credential with no value is a failure
 *   5. a credential outside `refs:` is a failure
 *   6. a complete configuration is still accepted (the negative control)
 *   7. a bridge missing a lazy module is a failure, not `ok`
 *   8. a complete bridge is still accepted (the control for 7)
 *   9. an unreadable file list is a failure, not a warning with exit 0
 *  10. a YAML syntax error is a failure even when the *plugin* ships no parser,
 *      as long as the DSH install has one — the shape of every published install
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
 * MINIMUM_DSH (0.2.1); `paseo` is >= MINIMUM_PASEO (0.9.2). If doctor raises a
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
  executable(
    "dsh",
    ["#!/bin/sh", 'if [ "$1" = "--version" ]; then', '  echo "0.2.1-rc.2"', "else", "  exit 1", "fi", ""].join("\n"),
  );
  executable(
    "paseo",
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  echo "0.12.0"',
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

/** A patch shaped like the one the plugin writes: the route is a list item's id. */
const VALID_ROUTE = [
  "# profile patch",
  "- id: agent-default-model",
  "  config:",
  "    provider: my-gateway",
  "    model: my-model",
  "    reasoningEffort: high",
  "    providers:",
  "      - id: my-gateway",
  "        apiKeyEnv: MY_GATEWAY_KEY",
  "",
].join("\n");

const VALID_CREDENTIALS = ["refs:", "  MY_GATEWAY_KEY: a-secret-value", ""].join("\n");

/** Write one sandboxed install and point the doctor at it. */
function install({ patch, credentials, bridge = BRIDGE_FILES }) {
  const home = mkdtempSync(join(WORK, "home-"));
  const profileDir = join(home, "profiles", PROFILE);
  const bridgeDir = join(profileDir, "node_modules", "dsh-paseo-bridge");
  mkdirSync(join(bridgeDir, "lib"), { recursive: true });
  // A complete bridge by default: the entry alone is what the old check accepted,
  // and an install shaped like that must be a failure now (case 7).
  for (const relativePath of bridge) {
    const target = join(bridgeDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "");
  }
  writeFileSync(join(profileDir, "cordis.patch.yml"), patch);
  if (credentials !== undefined) writeFileSync(join(home, ".credentials.yaml"), credentials);
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

// ---- 2. a missing agent-default-model is a failure -----------------------
{
  install({ patch: "# nothing but comments\n", credentials: VALID_CREDENTIALS });
  const run = doctor();
  check(
    "a patch with no agent-default-model is a failure",
    run.out.includes("no agent-default-model") && run.code === 1,
    `exit ${run.code}`,
  );
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
  install({ patch: VALID_ROUTE, credentials: ["refs:", "  MY_GATEWAY_KEY:", ""].join("\n") });
  const run = doctor();
  check(
    "a credential with an empty value is a failure",
    run.out.includes("credential MY_GATEWAY_KEY missing") && run.code === 1,
    run.out.trim().split("\n").filter((l) => l.includes("credential")).join(" | "),
  );
}

// ---- 5. a same-named key outside refs: is not a credential ---------------
{
  install({ patch: VALID_ROUTE, credentials: ["something_else:", "  MY_GATEWAY_KEY: a-secret-value", ""].join("\n") });
  const run = doctor();
  check(
    "a key outside refs: does not satisfy the credential check",
    run.out.includes("credential MY_GATEWAY_KEY missing") && run.code === 1,
    run.out.trim().split("\n").filter((l) => l.includes("credential")).join(" | "),
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
  writeFileSync(fakeBin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "0.2.1-rc.2"; else exit 1; fi\n');
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

rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
