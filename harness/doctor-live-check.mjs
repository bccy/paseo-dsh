/**
 * Real-DSH check for the doctor rows that judge DSH's own contracts.
 *
 * `harness/doctor-check.mjs` is hermetic: its `dsh` stand-in answers
 * `--dump-config` from a marker comment, so it pins the doctor's handling of a
 * verdict but not that the verdict is the one DSH reaches. The three layers
 * fixed after the 2026-11-03 audit (DLV-01/02/03) are exactly contracts only
 * DSH can judge:
 *
 *   - a loader patch entry whose `name` does not match the composed row is
 *     skipped with a warning by `applyEntryPatches()`, and the boot continues on
 *     the base default route (`dsh-app-boot`);
 *   - a profile directory without `package.json` makes DSH report the profile
 *     does not exist, and one whose `dsh.profile.bundles` omits
 *     `dsh-paseo-bridge` boots without the bridge;
 *   - `dsh-credentials-local` refuses a credentials document without
 *     `version: 1`, readable beyond its owner, or naming a ref outside
 *     `/^[A-Za-z_][A-Za-z0-9_]*$/`, before reading a single value.
 *
 * This file drives the real `paseo-dsh doctor` CLI against a throwaway
 * `DSH_HOME` and the real `dsh` on PATH, and asserts its verdict and exit code
 * for one healthy install and each defect. Each scenario is also composed with
 * `dsh --profile <p> --dump-config` — the same composition the doctor reads —
 * so the fixture is proven to be what the case claims: the healthy route is in
 * the composed tree, the skipped patch is not, and the bridge rows appear only
 * when the bundle is declared. The credentials cases are cross-checked against
 * DSH's own `parseCredentialsDocument()` / `renderFlatLayoutMigration()`, and
 * the doctor's repair advice is applied to show it produces a document DSH
 * accepts.
 *
 * Requirements: a real `dsh` (>= 0.2.1) on PATH, Node >= 22.18 for the
 * credentials module's import chain. No model turn, no daemon, no network, and
 * no real `~/.dsh` — every home is a `mkdtemp()` tree. **Not part of the CI
 * gate**: CI has no DSH install, so the composition cannot run there.
 *
 * Usage: node harness/doctor-live-check.mjs
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const DOCTOR = join(REPO, "paseo-plugin", "bin", "paseo-dsh.mjs");
const BRIDGE_SOURCE = join(REPO, "dsh-bridge");
const PROFILE = "doctor-live";
const WORK = mkdtempSync(join(tmpdir(), "doctor-live-check-"));
const STUB_BIN = join(WORK, "bin");

/** A patch in the shape the plugin's template documents, with names DSH knows. */
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
  "- id: agent-default-model",
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  "  config:",
  "    provider: my-gateway",
  "    model: my-model",
  "",
].join("\n");

const VALID_CREDENTIALS = ["version: 1", "refs:", "  MY_GATEWAY_KEY: a-secret-value", ""].join("\n");

const VALID_PROFILE_MANIFEST = {
  name: `dsh-profile-${PROFILE}`,
  private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-paseo-bridge"] } },
};

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

/** Absolute path of the real `dsh` this check drives, or `undefined`. */
function findDsh() {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry === "") continue;
    const candidate = join(entry, "dsh");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A `paseo` stand-in so the CLI rows describe the fixture, not the host.
 *
 * The doctor resolves `paseo` from PATH (or /Applications on macOS, which this
 * stand-in cannot override — the header of `doctor-check.mjs` documents the
 * same limit). A host whose real Paseo has no plugin installed would otherwise
 * fail the healthy install on a row this check does not govern.
 */
function stubPaseo() {
  mkdirSync(STUB_BIN, { recursive: true });
  const path = join(STUB_BIN, "paseo");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "0.14.0"; exit 0; fi',
      'if [ "$1" = "plugin" ] && [ "$2" = "ls" ]; then printf "dsh-paseo  0.2.16  running\\n"; exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

/** One throwaway DSH home with the bridge materialized the way the plugin does. */
function makeHome({ patch = VALID_ROUTE, credentials = VALID_CREDENTIALS, manifest = VALID_PROFILE_MANIFEST } = {}) {
  const home = mkdtempSync(join(WORK, "home-"));
  const profileDir = join(home, "profiles", PROFILE);
  mkdirSync(join(profileDir, "node_modules"), { recursive: true });
  // The plugin writes its own copy of the bridge; a copy keeps the worktree out
  // of the sandbox entirely.
  cpSync(BRIDGE_SOURCE, join(profileDir, "node_modules", "dsh-paseo-bridge"), { recursive: true });
  if (manifest !== null) writeFileSync(join(profileDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(profileDir, "cordis.patch.yml"), patch);
  if (credentials !== null) {
    const credentialPath = join(home, ".credentials.yaml");
    writeFileSync(credentialPath, credentials);
    chmodSync(credentialPath, 0o600);
  }
  return home;
}

/** Run the real doctor CLI against one home, exactly as an operator would. */
function doctor(home) {
  const result = spawnSync(process.execPath, [DOCTOR, "doctor"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PASEO_PROFILE: PROFILE,
      PATH: [STUB_BIN, process.env.PATH ?? ""].filter((entry) => entry !== "").join(delimiter),
    },
    timeout: 60_000,
  });
  return { status: result.status, out: stripAnsi(result.stdout ?? ""), err: result.stderr ?? "" };
}

/** Compose one home with DSH's own dump — the independent evidence per case. */
function dump(home) {
  const result = spawnSync(DSH, ["--profile", PROFILE, "--dump-config"], {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: home },
    timeout: 60_000,
  });
  return { status: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

/** The composed `agent-default-model` row, which is what the route actually is. */
function composedDefaultModel(dumpText) {
  const lines = dumpText.split("\n");
  const at = lines.findIndex((entry) => /^- id: agent-default-model$/.test(entry));
  if (at === -1) return undefined;
  const block = [lines[at]];
  for (let index = at + 1; index < lines.length; index += 1) {
    if (/^- /.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block.join("\n");
}

/**
 * The credentials parser DSH boots with, resolved from the dsh installation.
 *
 * The doctor's rules for DLV-01 were read out of this module
 * (`parseCredentialsDocument` / `renderFlatLayoutMigration`); cross-checking
 * against the same implementation is what keeps the doctor's copy of the
 * contract honest. Resolved by package name from the dsh package root, so a
 * moved file inside the install still resolves.
 */
async function loadCredentialParser() {
  const root = dirname(realpathSync(DSH));
  let anchor;
  for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      anchor = join(dir, "package.json");
      break;
    }
  }
  if (anchor === undefined) throw new Error(`cannot find the dsh package root above ${DSH}`);
  const resolved = createRequire(anchor).resolve("@deepseek-ai/dsh-credentials-local");
  return await import(pathToFileURL(resolved).href);
}

const DSH = findDsh();
if (DSH === undefined) {
  console.error("doctor-live-check: no `dsh` on PATH; this check needs a real DeepSeek Harness install");
  process.exit(1);
}
stubPaseo();

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

// ---- 1. a healthy install is green, and DSH composes the route it claims ---
{
  const home = makeHome();
  const run = doctor(home);
  check(
    "a complete install is accepted by the real doctor CLI",
    run.status === 0 && run.out.includes("All checks passed"),
    run.out.trim().split("\n").at(-1),
  );
  check(
    "and it reports the bridge bundle, the applied patch and the credential",
    run.out.includes("profile loads the dsh-paseo-bridge bundle") &&
      run.out.includes("profile patch applied by DSH") &&
      run.out.includes("credential MY_GATEWAY_KEY found"),
    run.out.trim().split("\n").filter((line) => line.includes("profile ") || line.includes("credential")).join(" | "),
  );
  // The fixture has to be genuinely composable, or the green above could come
  // from the doctor never looking: DSH's own dump must carry the route.
  const composed = dump(home);
  const route = composedDefaultModel(composed.out);
  check(
    "and DSH's own dump carries the configured route",
    composed.status === 0 &&
      route !== undefined &&
      route.includes("provider: my-gateway") &&
      route.includes("model: my-model"),
    route === undefined ? "(no agent-default-model in the dump)" : route.split("\n").slice(-4).join(" | "),
  );
  check(
    "and the bridge bundle is in the composed tree",
    composed.out.includes("id: paseo-bridge"),
    composed.out.includes("id: paseo-bridge") ? "paseo-bridge present" : "(no paseo-bridge entry)",
  );
}

// ---- 2. DLV-02: a patch entry DSH skips is red, and the route is not applied -
{
  const home = makeHome({
    patch: VALID_ROUTE.replace(
      'name: "@deepseek-ai/dsh-agent-default-model"',
      'name: "@deepseek-ai/dsh-agent-default-model-TYPO"',
    ),
  });
  const composed = dump(home);
  check(
    "DSH really warns about the name mismatch",
    composed.status === 0 && composed.err.includes("patch: name mismatch") && composed.err.includes("skipping"),
    composed.err.trim().split("\n").find((line) => line.includes("name mismatch")) ?? "(no warning)",
  );
  const route = composedDefaultModel(composed.out);
  check(
    "and the composed route is the base default, not the configured one",
    route !== undefined && route.includes("provider: deepseek-official") && !route.includes("my-gateway"),
    route === undefined ? "(no agent-default-model in the dump)" : route.split("\n").slice(-3).join(" | "),
  );
  const run = doctor(home);
  check(
    "so the doctor is red and names the skipped entry",
    run.status === 1 && run.out.includes("DSH skipped a patch entry"),
    run.out.trim().split("\n").find((line) => line.includes("DSH skipped")) ?? `exit ${run.status}`,
  );
  check(
    "and it quotes DSH's own warning",
    run.out.includes("patch: name mismatch for \"agent-default-model\""),
    run.out.trim().split("\n").find((line) => line.includes("name mismatch")) ?? "(no warning)",
  );
}

// ---- 3. DLV-03: the profile must be a package DSH can load ------------------
{
  const home = makeHome({ manifest: null });
  const composed = dump(home);
  check(
    "DSH really reports the profile as not existing",
    composed.status === 1 && /profile "doctor-live" does not exist/.test(composed.err),
    composed.err.trim().split("\n").find((line) => line.includes("does not exist")) ?? `exit ${composed.status}`,
  );
  const run = doctor(home);
  check(
    "so the doctor is red and names the missing package.json",
    run.status === 1 && run.out.includes("has no package.json"),
    run.out.trim().split("\n").find((line) => line.includes("package.json")) ?? `exit ${run.status}`,
  );
}

{
  const home = makeHome({
    manifest: {
      name: `dsh-profile-${PROFILE}`,
      private: true,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
    },
  });
  const composed = dump(home);
  check(
    "DSH really boots this profile without the bridge bundle",
    composed.status === 0 && !composed.out.includes("id: paseo-bridge"),
    composed.out.includes("id: paseo-bridge") ? "paseo-bridge unexpectedly present" : "no paseo-bridge entry",
  );
  const run = doctor(home);
  check(
    "so the doctor is red and names the missing bundle",
    run.status === 1 && run.out.includes("does not load the bridge bundle"),
    run.out.trim().split("\n").find((line) => line.includes("bridge bundle")) ?? `exit ${run.status}`,
  );
}

// ---- 4. DLV-01: the credentials contract DSH enforces -----------------------
{
  const credentials = await loadCredentialParser();
  const unversioned = ["refs:", "  MY_GATEWAY_KEY: a-secret-value", ""].join("\n");
  const home = makeHome({ credentials: unversioned });

  let refused;
  try {
    credentials.parseCredentialsDocument(unversioned, join(home, ".credentials.yaml"));
    refused = undefined;
  } catch (error) {
    refused = error.message;
  }
  check(
    "DSH's own parser refuses a document without version: 1",
    refused !== undefined && refused.includes("pre-release flat layout"),
    refused ?? "(parsed without an error)",
  );

  const run = doctor(home);
  check(
    "so the doctor is red and names the missing version",
    run.status === 1 && run.out.includes("credentials document has no version: 1"),
    run.out.trim().split("\n").find((line) => line.includes("version")) ?? `exit ${run.status}`,
  );

  // The repair the doctor prints is "version: 1 + nest under refs:"; applying it
  // must produce a document DSH accepts, or the advice is a dead end.
  const repaired = ["version: 1", "refs:", "  MY_GATEWAY_KEY: a-secret-value", ""].join("\n");
  let repairError;
  try {
    credentials.parseCredentialsDocument(repaired, join(home, ".credentials.yaml"));
    repairError = undefined;
  } catch (error) {
    repairError = error.message;
  }
  check(
    "and the repair it recommends is accepted by that parser",
    repairError === undefined,
    repairError ?? "version: 1 + refs: parses",
  );

  // The pre-release flat layout is not a defect: DSH migrates it in place.
  const flat = "MY_GATEWAY_KEY: a-secret-value\n";
  const migrated = credentials.renderFlatLayoutMigration(flat);
  let flatError;
  try {
    credentials.parseCredentialsDocument(migrated ?? flat, join(home, ".credentials.yaml"));
    flatError = undefined;
  } catch (error) {
    flatError = error.message;
  }
  check(
    "and the flat layout DSH migrates parses after the migration",
    migrated !== undefined && flatError === undefined,
    migrated === undefined ? "(not recognized as the flat layout)" : flatError ?? "migrates and parses",
  );
}

// ---- 5. DLV-01: a ref name outside the grammar is refused by DSH -----------
{
  const credentials = await loadCredentialParser();
  const badName = ["version: 1", "refs:", "  MY.GATEWAY_KEY: a-secret-value", ""].join("\n");
  let refused;
  try {
    credentials.parseCredentialsDocument(badName, "/tmp/doctor-live-check.credentials.yaml");
    refused = undefined;
  } catch (error) {
    refused = error.message;
  }
  check(
    "DSH's own parser refuses a ref name outside the grammar",
    refused !== undefined && refused.includes("must match"),
    refused ?? "(parsed without an error)",
  );
  const run = doctor(makeHome({ credentials: badName }));
  check(
    "so the doctor is red and names the invalid ref",
    run.status === 1 && run.out.includes('credentials ref "MY.GATEWAY_KEY" is not a valid name'),
    run.out.trim().split("\n").find((line) => line.includes("not a valid name")) ?? `exit ${run.status}`,
  );
}

rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
