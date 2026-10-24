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
 * sandbox. Only the route, credential and bridge verdicts are read.
 *
 * Usage: node harness/doctor-check.mjs
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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

rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
