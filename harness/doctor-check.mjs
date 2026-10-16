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
 *
 * The CLI and plugin rows are not asserted: they describe the host, not the
 * sandbox. Only the route and credential verdicts are read.
 *
 * Usage: node harness/doctor-check.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../paseo-plugin/lib/doctor.mjs";

const WORK = mkdtempSync(join(tmpdir(), "doctor-check-"));
const PROFILE = "doctor-check";
process.env.DSH_PASEO_PROFILE = PROFILE;

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
function install({ patch, credentials }) {
  const home = mkdtempSync(join(WORK, "home-"));
  const profileDir = join(home, "profiles", PROFILE);
  mkdirSync(join(profileDir, "node_modules", "dsh-paseo-bridge", "lib"), { recursive: true });
  writeFileSync(join(profileDir, "node_modules", "dsh-paseo-bridge", "lib", "index.js"), "");
  writeFileSync(join(profileDir, "cordis.patch.yml"), patch);
  if (credentials !== undefined) writeFileSync(join(home, ".credentials.yaml"), credentials);
  process.env.DSH_HOME = home;
}

/** Run the doctor with stdout captured; returns what it said and the exit it set. */
function doctor() {
  const chunks = [];
  const realOut = process.stdout.write;
  process.stdout.write = (chunk) => (chunks.push(String(chunk)), true);
  process.exitCode = 0;
  try {
    runDoctor();
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

rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
