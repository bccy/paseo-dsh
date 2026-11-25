/**
 * Comprehensive offline unit tests for the DSH diagnostics engine:
 *   - `lib/doctor.mjs` (`runDoctorChecks`, `runDoctorChecksAsync`, `inspectInstallFiles`, `runDoctor`)
 *   - `shared/diagnostics.ts` (Zod schemas & RPC contracts)
 *   - `server/diagnostics.ts` (`DiagnosticsService`, `registerDiagnosticsRpc`, redaction)
 *
 * Covers:
 *   1. Hard security redline: credential redaction on valid, malformed, bad-version,
 *      bad-key, and provider-config inputs (zero leaks of secrets or YAML snippets).
 *   2. File permission checks (`0644`/`0640`/`0600` on POSIX).
 *   3. Missing key detection, missing credentials file, and legacy flat layout.
 *   4. Fast read-only overview + lightweight version cache vs full doctor (`--dump-config`).
 *   5. Single-flight concurrency mutex + timeout cleanup (both hung runner and real child).
 *   6. Pure injectable `runDoctorChecks` and 100% CLI rendering/exit-code compatibility.
 *
 * Usage:
 *   node paseo-plugin/test/diagnostics.test.cjs
 *   node --test paseo-plugin/test/diagnostics.test.cjs
 */
"use strict";

require("./register-typescript.cjs");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");

const {
  DIAGNOSTICS_OVERVIEW_METHOD,
  DIAGNOSTICS_RUN_DOCTOR_METHOD,
  diagnosticsOverviewRpc,
  diagnosticsRunDoctorRpc,
  diagnosticsOverviewSchema,
  doctorReportSchema,
} = require("../shared/diagnostics.ts");
const {
  DiagnosticsService,
  redactBaseUrlHost,
  redactSecrets,
  registerDiagnosticsRpc,
} = require("../server/diagnostics.ts");
const { BRIDGE_FILES } = require("../server/bridge-assets.ts");

const DOCTOR_MJS = path.resolve(__dirname, "..", "lib", "doctor.mjs");
const BRIDGE_KEYS = Object.keys(BRIDGE_FILES);
const PROFILE = "diag-test";

let cachedDoctorMod;
async function loadDoctor() {
  if (!cachedDoctorMod) {
    cachedDoctorMod = await import(pathToFileURL(DOCTOR_MJS).href);
  }
  return cachedDoctorMod;
}

const VALID_PATCH = [
  "- id: llm-pi-ai",
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  "  config:",
  "    providers:",
  "      acme-gw:",
  "        displayName: Acme Gateway",
  "        apiKeyEnv: ACME_TEST_KEY",
  "        api: openai-completions",
  "        baseURL: https://gw.example.invalid/v1",
  "        models:",
  "          - id: acme-chat",
  "            name: Acme Chat",
  "- id: agent-default-model",
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  "  config:",
  "    provider: acme-gw",
  "    model: acme-chat",
  "    reasoningEffort: medium",
  "",
].join("\n");

const VALID_CREDS = ["version: 1", "refs:", "  ACME_TEST_KEY: top-secret-value-do-not-leak-001", ""].join("\n");

const VALID_MANIFEST = {
  name: `dsh-profile-${PROFILE}`,
  private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-paseo-bridge"] } },
};

function makeSandbox(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-dsh-diag-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const dshHome = path.join(root, "dsh-home");
  const profileDir = path.join(dshHome, "profiles", PROFILE);
  const sharedBridgeDir = path.join(dshHome, "profiles", "node_modules", "dsh-paseo-bridge");
  const localBridgeDir = path.join(profileDir, "node_modules", "dsh-paseo-bridge");

  if (opts.createProfile !== false) {
    fs.mkdirSync(profileDir, { recursive: true });
    if (opts.manifest !== null) {
      fs.writeFileSync(
        path.join(profileDir, "package.json"),
        `${JSON.stringify(opts.manifest ?? VALID_MANIFEST, null, 2)}\n`,
      );
    }
    if (opts.patch !== null) {
      fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), opts.patch ?? VALID_PATCH);
    }
  }

  const bridgeFiles = opts.bridgeFiles === undefined ? BRIDGE_KEYS : opts.bridgeFiles;
  if (bridgeFiles !== null) {
    const targetBridge = opts.bridgeLocation === "local" ? localBridgeDir : sharedBridgeDir;
    for (const rel of bridgeFiles) {
      const full = path.join(targetBridge, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "");
    }
    if (opts.shadowBridge) {
      for (const rel of bridgeFiles) {
        const full = path.join(localBridgeDir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, "");
      }
    }
  }

  const credPath = path.join(dshHome, ".credentials.yaml");
  if (opts.credentials !== null) {
    fs.mkdirSync(dshHome, { recursive: true });
    fs.writeFileSync(credPath, opts.credentials ?? VALID_CREDS);
    if (process.platform !== "win32") {
      fs.chmodSync(credPath, opts.credentialsMode ?? 0o600);
    }
  }

  return { root, dshHome, profileDir, sharedBridgeDir, localBridgeDir, credPath };
}

function makeFakePackageDsh(root, version = "0.2.2-rc.5") {
  const pkgDir = path.join(root, "fake-dsh-pkg");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh", version })}\n`,
  );
  const entry = path.join(pkgDir, "lib", "bin.js");
  fs.writeFileSync(
    entry,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi`,
      'if [ "$1" = "--profile" ] && [ "$3" = "--dump-config" ]; then exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
  );
  fs.chmodSync(entry, 0o755);
  const link = path.join(binDir, "dsh");
  fs.symlinkSync(entry, link);
  return { binDir, link, entry, pkgDir };
}

function makeFakeWrapperDsh(root, scriptBody) {
  const binDir = path.join(root, "wrapper-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "dsh");
  fs.writeFileSync(bin, `#!/bin/sh\n${scriptBody}\n`);
  fs.chmodSync(bin, 0o755);
  return { binDir, bin };
}

function makeHealthyRunner(counters = { exec: 0, dump: 0, paseo: 0 }) {
  return {
    exec(cmd, args) {
      counters.exec += 1;
      if (args.includes("--version") && String(cmd).includes("dsh")) return "0.2.2-rc.5";
      if (args.includes("--version")) {
        counters.paseo += 1;
        return "0.17.4";
      }
      if (args[0] === "plugin" && args[1] === "ls") {
        counters.paseo += 1;
        return "dsh-paseo  0.2.16  running\n";
      }
      return undefined;
    },
    dumpProfile() {
      counters.dump += 1;
      return { status: 0, stderr: "", error: undefined, timedOut: false };
    },
  };
}

function captureCliRun(runDoctorFn, options) {
  const chunks = [];
  const errChunks = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origCode = process.exitCode;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    errChunks.push(String(chunk));
    return true;
  };
  process.exitCode = 0;
  try {
    runDoctorFn(options);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = origCode;
  return { stdout: chunks.join(""), stderr: errChunks.join(""), exitCode };
}

// ---- 1. Shared RPC contract & registration ---------------------------------

test("shared RPC contracts expose exact method names and registerDiagnosticsRpc wires handlers", async (t) => {
  assert.equal(DIAGNOSTICS_OVERVIEW_METHOD, "dsh.diagnostics.overview");
  assert.equal(DIAGNOSTICS_RUN_DOCTOR_METHOD, "dsh.diagnostics.run-doctor");
  assert.equal(diagnosticsOverviewRpc.name, "dsh.diagnostics.overview");
  assert.equal(diagnosticsRunDoctorRpc.name, "dsh.diagnostics.run-doctor");

  const box = makeSandbox(t);
  const dshPkg = makeFakePackageDsh(box.root, "0.2.2-rc.5");
  const counters = { exec: 0, dump: 0, paseo: 0 };
  const service = new DiagnosticsService({
    dshHome: box.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
    checkBundledPaseo: false,
    runner: makeHealthyRunner(counters),
  });

  const handlers = new Map();
  let capturedCalls = 0;
  const fakeServer = {
    handle(contract, fn) {
      handlers.set(contract.name, { contract, fn });
    },
  };
  const dispose = registerDiagnosticsRpc(fakeServer, service, {
    onCall: () => {
      capturedCalls += 1;
    },
  });

  assert.ok(handlers.has("dsh.diagnostics.overview"));
  assert.ok(handlers.has("dsh.diagnostics.run-doctor"));

  const overview = await handlers.get("dsh.diagnostics.overview").fn({}, { paseo: {} });
  const parsedOverview = diagnosticsOverviewSchema.parse(overview);
  assert.equal(parsedOverview.hasIssues, false);
  assert.equal(parsedOverview.profile.name, PROFILE);
  assert.equal(parsedOverview.dsh.version, "0.2.2-rc.5");
  assert.equal(parsedOverview.credentials.status, "ready");

  const doctor = await handlers.get("dsh.diagnostics.run-doctor").fn({}, { paseo: {} });
  const parsedDoctor = doctorReportSchema.parse(doctor);
  assert.equal(parsedDoctor.ok, true);
  assert.equal(parsedDoctor.summary.fail, 0);
  assert.equal(capturedCalls, 2);

  dispose();
});

// ---- 2. Hard security redline: credential & secret redaction ---------------

test("credential redaction never leaks raw secrets even on malformed YAML, bad version, or bad keys", async (t) => {
  const doctorMod = await loadDoctor();

  // Case A: malformed .credentials.yaml with secret token on the broken YAML line
  {
    const secret = "sk-live-SUPER_SECRET_MALFORMED_9988776655";
    const malformedCreds = [
      "version: 1",
      "refs:",
      `  ACME_TEST_KEY: [${secret}`,
      "",
    ].join("\n");
    const box = makeSandbox(t, { credentials: malformedCreds });
    const dshPkg = makeFakePackageDsh(box.root);
    const service = new DiagnosticsService({
      dshHome: box.dshHome,
      profile: PROFILE,
      binary: dshPkg.link,
      env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
      checkBundledPaseo: false,
      runner: makeHealthyRunner(),
    });

    const overview = diagnosticsOverviewSchema.parse(await service.overview());
    assert.equal(overview.credentials.status, "invalid-yaml");
    assert.equal(overview.credentials.formatValid, false);
    assert.equal(overview.hasIssues, true);
    assert.ok(overview.credentials.fixHint, "invalid-yaml must carry an actionable fixHint");
    assert.equal(JSON.stringify(overview).includes(secret), false, "overview must never contain secret text");
    assert.equal(JSON.stringify(overview).includes("SUPER_SECRET"), false);

    const report = doctorReportSchema.parse(await service.runDoctor());
    assert.equal(report.ok, false);
    assert.equal(JSON.stringify(report).includes(secret), false, "runDoctor must never contain secret text");
    assert.equal(JSON.stringify(report).includes("SUPER_SECRET"), false);
    const yamlFail = report.checks.find((c) => c.id === "credentials-yaml");
    assert.ok(yamlFail && yamlFail.level === "fail" && yamlFail.fixHint);

    const cli = captureCliRun(doctorMod.runDoctor, {
      dshHome: box.dshHome,
      profile: PROFILE,
      binary: dshPkg.link,
      env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
      checkBundledPaseo: false,
      runner: makeHealthyRunner(),
    });
    assert.equal(cli.exitCode, 1);
    assert.equal(cli.stdout.includes(secret), false, "CLI stdout must never leak malformed credential secret");
    assert.equal(cli.stderr.includes(secret), false, "CLI stderr must never leak malformed credential secret");
    service.dispose();
  }

  // Case B: secret accidentally placed in `version:` field and as a bad ref key
  {
    const versionSecret = "SECRET_IN_VERSION_LINE_554433";
    const keySecret = "sk-key-leaked-as-refname-1122334455";
    const valueSecret = "SECRET_IN_VALUE_FIELD_776655";
    const weirdCreds = [
      `version: "${versionSecret}"`,
      "refs:",
      `  ${keySecret}: "${valueSecret}"`,
      "",
    ].join("\n");
    const box = makeSandbox(t, { credentials: weirdCreds });
    const dshPkg = makeFakePackageDsh(box.root);
    const service = new DiagnosticsService({
      dshHome: box.dshHome,
      profile: PROFILE,
      binary: dshPkg.link,
      env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
      checkBundledPaseo: false,
      runner: makeHealthyRunner(),
    });

    const overview = diagnosticsOverviewSchema.parse(await service.overview());
    const report = doctorReportSchema.parse(await service.runDoctor());
    const combined = `${JSON.stringify(overview)}\n${JSON.stringify(report)}`;
    for (const leaked of [versionSecret, keySecret, valueSecret]) {
      assert.equal(combined.includes(leaked), false, `must never leak ${leaked}`);
    }
    assert.equal(overview.credentials.status, "invalid-contract");
    assert.equal(report.ok, false);
    service.dispose();
  }

  // Case C: provider redaction in cordis.patch.yml (inline apiKey, auth headers, URL userinfo + query secret)
  {
    const inlineKey = "sk-inline-provider-key-999999";
    const headerSecret = "Bearer sk-header-secret-888888";
    const urlPass = "url-pass-secret-777777";
    const querySecret = "query-token-secret-666666";
    const credSecret = "cred-file-secret-555555";
    const richPatch = [
      "- id: llm-pi-ai",
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      "  config:",
      "    providers:",
      "      acme-gw:",
      "        displayName: Acme Gateway",
      "        apiKeyEnv: ACME_TEST_KEY",
      `        apiKey: "${inlineKey}"`,
      "        headers:",
      `          Authorization: "${headerSecret}"`,
      "        api: openai-completions",
      `        baseURL: "https://svc:${urlPass}@gw.example.invalid:8443/v1/secret-path?api_key=${querySecret}"`,
      "        models:",
      "          - id: acme-chat",
      "            name: Acme Chat",
      "- id: agent-default-model",
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      "  config:",
      "    provider: acme-gw",
      "    model: acme-chat",
      "",
    ].join("\n");
    const box = makeSandbox(t, {
      patch: richPatch,
      credentials: `version: 1\nrefs:\n  ACME_TEST_KEY: "${credSecret}"\n`,
    });
    const dshPkg = makeFakePackageDsh(box.root);
    const service = new DiagnosticsService({
      dshHome: box.dshHome,
      profile: PROFILE,
      binary: dshPkg.link,
      env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
      checkBundledPaseo: false,
      runner: makeHealthyRunner(),
    });

    const overview = diagnosticsOverviewSchema.parse(await service.overview());
    assert.equal(overview.providers.length, 1);
    assert.equal(overview.providers[0].id, "acme-gw");
    assert.equal(overview.providers[0].baseUrlHost, "https://gw.example.invalid:8443");
    assert.equal(overview.providers[0].apiKeyEnv, "ACME_TEST_KEY");
    assert.equal(overview.providers[0].credentialReady, true);
    assert.deepEqual(overview.providers[0].models, [{ id: "acme-chat", name: "Acme Chat" }]);

    const serialized = JSON.stringify(overview);
    for (const secret of [inlineKey, headerSecret, urlPass, querySecret, credSecret, "secret-path"]) {
      assert.equal(serialized.includes(secret), false, `provider overview must never leak ${secret}`);
    }
    service.dispose();
  }

  // Case D: redactSecrets & redactBaseUrlHost unit assertions
  assert.equal(redactBaseUrlHost("https://user:pass@api.example.invalid/v1?key=abc"), "https://api.example.invalid");
  assert.equal(redactBaseUrlHost("not-a-url"), undefined);
  assert.equal(redactBaseUrlHost("file:///etc/passwd"), undefined);
  const scrubbed = redactSecrets("Authorization: Bearer tok_12345 api_key=abc123 https://u:p@h.invalid/x?token=zzz");
  assert.equal(scrubbed.includes("tok_12345"), false);
  assert.equal(scrubbed.includes("abc123"), false);
  assert.equal(scrubbed.includes("u:p"), false);
  assert.equal(scrubbed.includes("zzz"), false);
});

// ---- 3. File permission checks ---------------------------------------------

test("credentials file permissions reject group/other readable modes on POSIX", async (t) => {
  if (process.platform === "win32") return;

  const box = makeSandbox(t, { credentialsMode: 0o644 });
  const dshPkg = makeFakePackageDsh(box.root);
  const service = new DiagnosticsService({
    dshHome: box.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
    checkBundledPaseo: false,
    runner: makeHealthyRunner(),
  });

  const overview = diagnosticsOverviewSchema.parse(await service.overview());
  assert.equal(overview.credentials.exists, true);
  assert.equal(overview.credentials.readable, true);
  assert.equal(overview.credentials.mode, "0644");
  assert.equal(overview.credentials.ownerOnly, false);
  assert.equal(overview.credentials.status, "bad-permissions");
  assert.equal(overview.hasIssues, true);
  assert.match(overview.credentials.fixHint ?? "", /chmod 600/);

  const report = doctorReportSchema.parse(await service.runDoctor());
  assert.equal(report.ok, false);
  const permCheck = report.checks.find((c) => c.id === "credentials-permissions");
  assert.ok(permCheck, "must emit credentials-permissions check");
  assert.equal(permCheck.level, "fail");
  assert.match(permCheck.label, /mode 644/);
  assert.match(permCheck.fixHint ?? "", /chmod 600/);

  // Fix permissions to 0600 -> both overview and doctor turn green
  fs.chmodSync(box.credPath, 0o600);
  const fixedOverview = diagnosticsOverviewSchema.parse(await service.overview());
  assert.equal(fixedOverview.credentials.mode, "0600");
  assert.equal(fixedOverview.credentials.ownerOnly, true);
  assert.equal(fixedOverview.credentials.status, "ready");
  assert.equal(fixedOverview.hasIssues, false);

  const fixedReport = doctorReportSchema.parse(await service.runDoctor());
  assert.equal(fixedReport.ok, true);
  assert.equal(fixedReport.summary.fail, 0);
  service.dispose();
});

// ---- 4. Missing key detection & legacy flat layout -------------------------

test("missing credential ref detection reports exact missing ref names and actionable fix hints", async (t) => {
  const twoProviderPatch = [
    "- id: llm-pi-ai",
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    "  config:",
    "    providers:",
    "      gw-one:",
    "        displayName: Gateway One",
    "        apiKeyEnv: FIRST_KEY",
    "        models:",
    "          - id: m1",
    "      gw-two:",
    "        displayName: Gateway Two",
    "        apiKeyEnv: SECOND_KEY",
    "        models:",
    "          - id: m2",
    "- id: agent-default-model",
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    "  config:",
    "    provider: gw-one",
    "    model: m1",
    "",
  ].join("\n");

  const box = makeSandbox(t, {
    patch: twoProviderPatch,
    credentials: "version: 1\nrefs:\n  FIRST_KEY: present-secret-value\n",
  });
  const dshPkg = makeFakePackageDsh(box.root);
  const service = new DiagnosticsService({
    dshHome: box.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
    checkBundledPaseo: false,
    runner: makeHealthyRunner(),
  });

  const overview = diagnosticsOverviewSchema.parse(await service.overview());
  assert.equal(overview.credentials.status, "missing-refs");
  assert.deepEqual(overview.credentials.missingRefs, ["SECOND_KEY"]);
  assert.deepEqual(overview.credentials.referencedRefs, [
    { name: "FIRST_KEY", present: true },
    { name: "SECOND_KEY", present: false },
  ]);
  const gwOne = overview.providers.find((p) => p.id === "gw-one");
  const gwTwo = overview.providers.find((p) => p.id === "gw-two");
  assert.equal(gwOne?.credentialReady, true);
  assert.equal(gwTwo?.credentialReady, false);
  assert.match(overview.credentials.fixHint ?? "", /SECOND_KEY/);
  assert.equal(JSON.stringify(overview).includes("present-secret-value"), false);

  const report = doctorReportSchema.parse(await service.runDoctor());
  assert.equal(report.ok, false);
  const firstCheck = report.checks.find((c) => c.id === "credential-ref-FIRST_KEY");
  const secondCheck = report.checks.find((c) => c.id === "credential-ref-SECOND_KEY");
  assert.equal(firstCheck?.level, "ok");
  assert.equal(secondCheck?.level, "fail");
  assert.match(secondCheck?.fixHint ?? "", /SECOND_KEY/);
  service.dispose();
});

test("missing credentials file and pre-release flat layout are accurately distinguished", async (t) => {
  // Missing file
  {
    const box = makeSandbox(t, { credentials: null });
    const dshPkg = makeFakePackageDsh(box.root);
    const service = new DiagnosticsService({
      dshHome: box.dshHome,
      profile: PROFILE,
      binary: dshPkg.link,
      env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
      checkBundledPaseo: false,
      runner: makeHealthyRunner(),
    });
    const overview = diagnosticsOverviewSchema.parse(await service.overview());
    assert.equal(overview.credentials.status, "missing-file");
    assert.equal(overview.credentials.exists, false);
    assert.equal(overview.hasIssues, true);
    assert.match(overview.credentials.fixHint ?? "", /chmod 600/);
    service.dispose();
  }

  // Legacy flat layout
  {
    const box = makeSandbox(t, { credentials: "ACME_TEST_KEY: legacy-secret-xyz\n" });
    const dshPkg = makeFakePackageDsh(box.root);
    const service = new DiagnosticsService({
      dshHome: box.dshHome,
      profile: PROFILE,
      binary: dshPkg.link,
      env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
      checkBundledPaseo: false,
      runner: makeHealthyRunner(),
    });
    const overview = diagnosticsOverviewSchema.parse(await service.overview());
    assert.equal(overview.credentials.legacyFlatLayout, true);
    assert.equal(overview.credentials.status, "ready");
    assert.equal(overview.hasIssues, false);
    assert.equal(JSON.stringify(overview).includes("legacy-secret-xyz"), false);
    service.dispose();
  }
});

// ---- 5. Fast overview + version cache vs full doctor -----------------------

test("fast overview avoids slow subprocesses, caches wrapper version, and full doctor runs --dump-config", async (t) => {
  // Part A: Official @deepseek-ai/dsh package layout -> 0 subprocesses even on first overview!
  {
    const box = makeSandbox(t);
    const dshPkg = makeFakePackageDsh(box.root, "0.2.2-rc.5");
    const counters = { exec: 0, dump: 0, paseo: 0 };
    const service = new DiagnosticsService({
      dshHome: box.dshHome,
      profile: PROFILE,
      binary: dshPkg.link,
      env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
      checkBundledPaseo: false,
      runner: makeHealthyRunner(counters),
    });

    const first = diagnosticsOverviewSchema.parse(await service.overview());
    assert.equal(first.dsh.version, "0.2.2-rc.5");
    assert.equal(first.dsh.versionOk, true);
    assert.equal(first.dsh.cached, false);
    assert.equal(counters.exec, 0, "package.json fast path must spawn zero subprocesses");
    assert.equal(counters.dump, 0, "overview must never run --dump-config");
    assert.equal(counters.paseo, 0, "overview must never run paseo CLI");

    const second = diagnosticsOverviewSchema.parse(await service.overview());
    assert.equal(second.dsh.version, "0.2.2-rc.5");
    assert.equal(second.dsh.cached, true);
    assert.equal(counters.exec, 0);

    // Full doctor DOES run --version, paseo, and --dump-config
    const report = doctorReportSchema.parse(await service.runDoctor());
    assert.equal(report.ok, true);
    assert.equal(counters.dump, 1, "full doctor must run --dump-config");
    assert.ok(counters.paseo >= 2, "full doctor checks paseo CLI and plugin ls");
    assert.ok(report.checks.some((c) => c.id === "profile-composition" && c.level === "ok"));
    service.dispose();
  }

  // Part B: Plain wrapper binary (no package.json) -> probes --version once and caches
  {
    const box = makeSandbox(t);
    const wrapper = makeFakeWrapperDsh(box.root, 'if [ "$1" = "--version" ]; then echo "0.2.2-wrapper"; exit 0; fi');
    let versionProbes = 0;
    const service = new DiagnosticsService({
      dshHome: box.dshHome,
      profile: PROFILE,
      binary: wrapper.bin,
      env: { PATH: wrapper.binDir, DSH_HOME: box.dshHome },
      checkBundledPaseo: false,
      runner: {
        exec(cmd, args) {
          if (args.includes("--version")) {
            versionProbes += 1;
            return "0.2.2-wrapper";
          }
          return undefined;
        },
        dumpProfile() {
          throw new Error("overview must never invoke dumpProfile");
        },
      },
    });

    const o1 = diagnosticsOverviewSchema.parse(await service.overview());
    assert.equal(o1.dsh.version, "0.2.2-wrapper");
    assert.equal(o1.dsh.cached, false);
    assert.equal(versionProbes, 1);

    const o2 = diagnosticsOverviewSchema.parse(await service.overview());
    assert.equal(o2.dsh.version, "0.2.2-wrapper");
    assert.equal(o2.dsh.cached, true);
    assert.equal(versionProbes, 1, "second overview must hit in-memory version cache");

    const o3 = diagnosticsOverviewSchema.parse(await service.overview({ refreshVersion: true }));
    assert.equal(o3.dsh.cached, false);
    assert.equal(versionProbes, 2, "refreshVersion bypasses cache");
    service.dispose();
  }
});

// ---- 6. Single-flight concurrency & timeout behavior -----------------------

test("runDoctor enforces single-flight mutex for concurrent callers", async (t) => {
  const box = makeSandbox(t);
  const dshPkg = makeFakePackageDsh(box.root);

  let dumpStarted = 0;
  let releaseDump;
  const dumpGate = new Promise((resolve) => {
    releaseDump = resolve;
  });

  const service = new DiagnosticsService({
    dshHome: box.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
    checkBundledPaseo: false,
    runner: {
      async exec(cmd, args) {
        if (args.includes("--version") && String(cmd).includes("dsh")) return "0.2.2-rc.5";
        if (args.includes("--version")) return "0.17.4";
        if (args[0] === "plugin" && args[1] === "ls") return "dsh-paseo  0.2.16  running\n";
        return undefined;
      },
      async dumpProfile() {
        dumpStarted += 1;
        await dumpGate;
        return { status: 0, stderr: "", error: undefined, timedOut: false };
      },
    },
  });

  // Launch 4 concurrent callers before the first finishes
  const p1 = service.runDoctor();
  const p2 = service.runDoctor();
  const p3 = service.runDoctor();
  const p4 = service.runDoctor();

  // Give microtasks a turn so caller 1 enters dumpProfile
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dumpStarted, 1, "concurrent callers must share exactly one in-flight doctor run");

  releaseDump();
  const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, p4]);
  for (const r of [r1, r2, r3, r4]) {
    doctorReportSchema.parse(r);
    assert.equal(r.ok, true);
  }
  assert.equal(r1.sharedInFlight, false);
  assert.equal(r2.sharedInFlight, true);
  assert.equal(r3.sharedInFlight, true);
  assert.equal(r4.sharedInFlight, true);
  assert.equal(dumpStarted, 1);

  // Subsequent call after completion starts a fresh run
  const r5 = doctorReportSchema.parse(await service.runDoctor());
  assert.equal(r5.sharedInFlight, false);
  assert.equal(dumpStarted, 2);
  service.dispose();
});

test("runDoctor times out cleanly on hung runner and releases mutex for recovery", async (t) => {
  const box = makeSandbox(t);
  const dshPkg = makeFakePackageDsh(box.root);

  let shouldHang = true;
  let signalAborted = false;

  const service = new DiagnosticsService({
    dshHome: box.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
    checkBundledPaseo: false,
    doctorTimeoutMs: 120,
    runner: {
      async exec(cmd, args) {
        if (args.includes("--version") && String(cmd).includes("dsh")) return "0.2.2-rc.5";
        if (args.includes("--version")) return "0.17.4";
        if (args[0] === "plugin" && args[1] === "ls") return "dsh-paseo  0.2.16  running\n";
        return undefined;
      },
      dumpProfile(_profile, _launcher, opts) {
        if (shouldHang) {
          opts?.signal?.addEventListener("abort", () => {
            signalAborted = true;
          });
          // Deliberately ignore abort to test the outer timeout guard too.
          return new Promise(() => {});
        }
        return Promise.resolve({ status: 0, stderr: "", error: undefined, timedOut: false });
      },
    },
  });

  const [t1, t2] = await Promise.all([service.runDoctor(), service.runDoctor()]);
  doctorReportSchema.parse(t1);
  doctorReportSchema.parse(t2);
  assert.equal(t1.ok, false);
  assert.equal(t1.timedOut, true);
  assert.equal(t1.sharedInFlight, false);
  assert.equal(t2.timedOut, true);
  assert.equal(t2.sharedInFlight, true);
  assert.equal(signalAborted, true, "AbortSignal must fire on timeout");
  assert.ok(t1.checks.some((c) => c.level === "fail" && Boolean(c.fixHint)), "timeout must include actionable fixHint");

  // Mutex must be released so the next run recovers cleanly
  shouldHang = false;
  const recovered = doctorReportSchema.parse(await service.runDoctor());
  assert.equal(recovered.ok, true);
  assert.equal(recovered.timedOut, false);
  assert.equal(recovered.sharedInFlight, false);
  service.dispose();
});

test("runDoctor kills a real hanging --dump-config subprocess within timeout", async (t) => {
  if (process.platform === "win32") return;

  const box = makeSandbox(t);
  const binDir = path.join(box.root, "hanging-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const hangingDsh = path.join(binDir, "dsh");
  fs.writeFileSync(
    hangingDsh,
    [
      `#!${process.execPath}`,
      'if (process.argv.includes("--version")) { console.log("0.2.2-rc.5"); process.exit(0); }',
      'if (process.argv.includes("--dump-config")) { setTimeout(() => process.exit(0), 30000); return; }',
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  fs.chmodSync(hangingDsh, 0o755);

  const fakePaseo = path.join(binDir, "paseo");
  fs.writeFileSync(
    fakePaseo,
    [
      `#!${process.execPath}`,
      'if (process.argv.includes("--version")) { console.log("0.17.4"); process.exit(0); }',
      'if (process.argv[2] === "plugin" && process.argv[3] === "ls") { console.log("dsh-paseo  0.2.16  running"); process.exit(0); }',
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  fs.chmodSync(fakePaseo, 0o755);

  const service = new DiagnosticsService({
    dshHome: box.dshHome,
    profile: PROFILE,
    binary: hangingDsh,
    env: { PATH: binDir, DSH_HOME: box.dshHome, PASEO_CLI: fakePaseo },
    checkBundledPaseo: false,
    doctorTimeoutMs: 250,
  });

  const started = Date.now();
  const report = doctorReportSchema.parse(await service.runDoctor());
  const elapsed = Date.now() - started;

  assert.equal(report.ok, false);
  assert.equal(report.timedOut, true);
  assert.ok(elapsed >= 200 && elapsed < 4_000, `hung subprocess should time out around 250ms, took ${elapsed}ms`);
  assert.ok(report.checks.some((c) => c.level === "fail" && Boolean(c.fixHint)));
  service.dispose();
});

// ---- 7. Pure runDoctorChecks & CLI compatibility ---------------------------

test("runDoctorChecks is pure/injectable and runDoctor CLI preserves exact output & exit codes", async (t) => {
  const doctorMod = await loadDoctor();

  // Healthy install
  const okBox = makeSandbox(t);
  const dshPkg = makeFakePackageDsh(okBox.root);
  const savedHome = process.env.DSH_HOME;
  const savedProfile = process.env.DSH_PASEO_PROFILE;

  const okReport = doctorMod.runDoctorChecks({
    dshHome: okBox.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir },
    checkBundledPaseo: false,
    runner: makeHealthyRunner(),
  });
  assert.equal(okReport.summary.fail, 0);
  assert.equal(okReport.summary.warn, 0);
  assert.equal(okReport.summary.exitCode, 0);
  assert.equal(process.env.DSH_HOME, savedHome, "runDoctorChecks must not mutate process.env");
  assert.equal(process.env.DSH_PASEO_PROFILE, savedProfile);

  const okCli = captureCliRun(doctorMod.runDoctor, {
    dshHome: okBox.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir },
    checkBundledPaseo: false,
    runner: makeHealthyRunner(),
  });
  assert.equal(okCli.exitCode, 0);
  assert.match(okCli.stdout, /paseo-dsh doctor/);
  assert.match(okCli.stdout, /All checks passed\./);
  assert.match(okCli.stdout, /model route configured/);
  assert.match(okCli.stdout, /credential ACME_TEST_KEY found/);

  // Shadowed bridge -> warning only, exit code 0
  const warnBox = makeSandbox(t, { shadowBridge: true });
  const warnCli = captureCliRun(doctorMod.runDoctor, {
    dshHome: warnBox.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir },
    checkBundledPaseo: false,
    runner: makeHealthyRunner(),
  });
  assert.equal(warnCli.exitCode, 0);
  assert.match(warnCli.stdout, /legacy bridge copy shadows the provisioned one/);
  assert.match(warnCli.stdout, /nothing blocking/);

  // Skipped patch entry -> blocking fail, exit code 1, actionable fixHint in structured report
  const skippedRunner = {
    ...makeHealthyRunner(),
    dumpProfile() {
      return {
        status: 0,
        stderr: `dsh: [${path.join(okBox.profileDir, "cordis.patch.yml")}] patch: name mismatch for "agent-default-model", skipping\n`,
        error: undefined,
        timedOut: false,
      };
    },
  };
  const failReport = doctorMod.runDoctorChecks({
    dshHome: okBox.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir },
    checkBundledPaseo: false,
    runner: skippedRunner,
  });
  assert.equal(failReport.summary.fail, 1);
  assert.equal(failReport.summary.exitCode, 1);
  const skipCheck = failReport.checks.find((c) => c.id === "profile-composition-skips");
  assert.ok(skipCheck && skipCheck.level === "fail" && skipCheck.fixHint);

  const failCli = captureCliRun(doctorMod.runDoctor, {
    dshHome: okBox.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir },
    checkBundledPaseo: false,
    runner: skippedRunner,
  });
  assert.equal(failCli.exitCode, 1);
  assert.match(failCli.stdout, /1 blocking issue\(s\)/);
  assert.match(failCli.stdout, /DSH skipped a patch entry/);
});

// ---- 8. Paseo bundled runtime regressions (zero lib/doctor.mjs lookup) -----

test("bundled DiagnosticsService runs from isolated /tmp with zero lib/doctor.mjs reachable", async (t) => {
  const { spawnSync } = require("node:child_process");
  const ts = require("typescript");

  const pluginRoot = path.resolve(__dirname, "..");
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-diag-bundled-"));
  t.after(() => fs.rmSync(isolatedRoot, { recursive: true, force: true }));

  const bundleDir = path.join(isolatedRoot, "bundle");
  const daemonCwd = path.join(isolatedRoot, "daemon-cwd");
  fs.mkdirSync(path.join(bundleDir, "server"), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, "shared"), { recursive: true });
  fs.mkdirSync(daemonCwd, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "package.json"), '{"type":"commonjs"}\n');

  const transpileToCjs = (srcRel, outRel) => {
    const srcPath = path.join(pluginRoot, srcRel);
    const { outputText } = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: srcPath,
    });
    fs.writeFileSync(path.join(bundleDir, outRel), outputText);
  };

  transpileToCjs("shared/diagnostics.ts", "shared/diagnostics.js");
  transpileToCjs("server/bridge-assets.ts", "server/bridge-assets.js");
  transpileToCjs("server/diagnostics.ts", "server/diagnostics.js");
  fs.copyFileSync(path.join(pluginRoot, "server", "dsh-command.mjs"), path.join(bundleDir, "server", "dsh-command.mjs"));
  fs.copyFileSync(path.join(pluginRoot, "server", "doctor-core.mjs"), path.join(bundleDir, "server", "doctor-core.mjs"));

  // Explicitly ensure no lib/doctor.mjs exists anywhere in the isolated tree.
  assert.equal(fs.existsSync(path.join(bundleDir, "lib", "doctor.mjs")), false);

  const box = makeSandbox(t);
  const dshPkg = makeFakePackageDsh(box.root, "0.2.2-rc.5");
  // Mirror a real @deepseek-ai/dsh install carrying its own yaml parser.
  fs.mkdirSync(path.join(dshPkg.pkgDir, "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(pluginRoot, "node_modules", "yaml"),
    path.join(dshPkg.pkgDir, "node_modules", "yaml"),
    "dir",
  );
  const fakePaseo = path.join(dshPkg.binDir, "paseo");
  fs.writeFileSync(
    fakePaseo,
    [
      `#!${process.execPath}`,
      'if (process.argv.includes("--version")) { console.log("0.17.4"); process.exit(0); }',
      'if (process.argv[2] === "plugin" && process.argv[3] === "ls") { console.log("dsh-paseo  running  yes"); process.exit(0); }',
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  fs.chmodSync(fakePaseo, 0o755);

  const runnerScript = path.join(isolatedRoot, "run-isolated.cjs");
  fs.writeFileSync(
    runnerScript,
    [
      '"use strict";',
      'const assert = require("node:assert/strict");',
      'const { diagnosticsOverviewSchema, doctorReportSchema } = require("./bundle/shared/diagnostics.js");',
      'const { DiagnosticsService, resolveDoctorModulePath } = require("./bundle/server/diagnostics.js");',
      "(async () => {",
      "  const env = { PATH: process.env.TEST_BIN_DIR, DSH_HOME: process.env.TEST_DSH_HOME, PASEO_CLI: process.env.TEST_PASEO_CLI };",
      "  assert.equal(resolveDoctorModulePath({ env, cwd: process.cwd() }), undefined, 'lib/doctor.mjs must not be reachable in isolated /tmp');",
      "  const service = new DiagnosticsService({",
      "    dshHome: process.env.TEST_DSH_HOME,",
      "    profile: process.env.TEST_PROFILE,",
      "    binary: process.env.TEST_DSH_LINK,",
      "    env,",
      "    cwd: process.cwd(),",
      "    checkBundledPaseo: false,",
      "  });",
      "  const overview = diagnosticsOverviewSchema.parse(await service.overview());",
      "  assert.equal(overview.hasIssues, false);",
      '  assert.equal(overview.route.status, "configured");',
      '  assert.equal(overview.credentials.status, "ready");',
      '  assert.equal(overview.dsh.version, "0.2.2-rc.5");',
      "  const report = doctorReportSchema.parse(await service.runDoctor());",
      "  assert.equal(report.ok, true);",
      "  assert.equal(report.summary.fail, 0);",
      "  service.dispose();",
      '  process.stdout.write(JSON.stringify({ overviewOk: !overview.hasIssues, reportOk: report.ok }) + "\\n");',
      "})().catch((err) => { console.error(err); process.exit(1); });",
      "",
    ].join("\n"),
  );

  const child = spawnSync(process.execPath, [runnerScript], {
    cwd: daemonCwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_PATH: path.join(pluginRoot, "node_modules"),
      TEST_BIN_DIR: dshPkg.binDir,
      TEST_DSH_HOME: box.dshHome,
      TEST_DSH_LINK: dshPkg.link,
      TEST_PASEO_CLI: fakePaseo,
      TEST_PROFILE: PROFILE,
    },
    timeout: 15_000,
  });

  assert.equal(
    child.status,
    0,
    `isolated /tmp DiagnosticsService failed (exit ${String(child.status)}):\nstdout: ${child.stdout}\nstderr: ${child.stderr}`,
  );
  const parsed = JSON.parse(child.stdout.trim());
  assert.deepEqual(parsed, { overviewOk: true, reportOk: true });
});

test("eval-wrapped Paseo bundle shape (import.meta.url === undefined, no __dirname) runs cleanly", async (t) => {
  const ts = require("typescript");
  const pluginRoot = path.resolve(__dirname, "..");

  const evalWrappedCjs = (source, filename, customRequire) => {
    // Mirror Paseo's compiler-build.js: esbuild format:"cjs" strips import.meta to {}
    // (so import.meta.url is undefined), and wrapCommonJsBundle wraps in
    // `(function(require) { ... })` with NO __dirname / __filename parameters.
    const sanitized = source.replace(/\bimport\.meta\.url\b/g, "undefined");
    const { outputText } = ts.transpileModule(sanitized, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        allowJs: true,
      },
      // TypeScript forces ESM output for `.mjs` filenames even under CommonJS;
      // use `.js` so transpileModule emits the CommonJS shape esbuild produces.
      fileName: filename.replace(/\.mjs$/, ".js"),
    });
    const wrapped = `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${outputText}\nreturn module.exports;\n})`;
    const factory = globalThis.eval(wrapped);
    return factory(customRequire);
  };

  const dshCommandMod = evalWrappedCjs(
    fs.readFileSync(path.join(pluginRoot, "server", "dsh-command.mjs"), "utf8"),
    "dsh-command.mjs",
    (spec) => require(spec),
  );
  const doctorCoreMod = evalWrappedCjs(
    fs.readFileSync(path.join(pluginRoot, "server", "doctor-core.mjs"), "utf8"),
    "doctor-core.mjs",
    (spec) => {
      if (spec === "./dsh-command.mjs") return dshCommandMod;
      if (spec === "yaml" || spec === "js-yaml") {
        // Simulate a Paseo host process without yaml installed so doctor-core
        // must fall back to DSH's own yaml parser cleanly.
        const err = new Error(`Cannot find module '${spec}'`);
        err.code = "MODULE_NOT_FOUND";
        throw err;
      }
      return require(spec);
    },
  );
  const sharedDiagMod = require("../shared/diagnostics.ts");
  const bridgeAssetsMod = require("../server/bridge-assets.ts");
  const bundledDiagMod = evalWrappedCjs(
    fs.readFileSync(path.join(pluginRoot, "server", "diagnostics.ts"), "utf8"),
    "diagnostics.ts",
    (spec) => {
      if (spec === "./doctor-core.mjs") return doctorCoreMod;
      if (spec === "./dsh-command.mjs") return dshCommandMod;
      if (spec === "./bridge-assets") return bridgeAssetsMod;
      if (spec === "../shared/diagnostics") return sharedDiagMod;
      if (spec.includes("lib/doctor")) {
        throw new Error(`unexpected runtime load of ${spec}`);
      }
      return require(spec);
    },
  );

  const box = makeSandbox(t);
  const dshPkg = makeFakePackageDsh(box.root, "0.2.2-rc.5");
  fs.mkdirSync(path.join(dshPkg.pkgDir, "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(pluginRoot, "node_modules", "yaml"),
    path.join(dshPkg.pkgDir, "node_modules", "yaml"),
    "dir",
  );
  const isolatedCwd = path.join(box.root, "empty-cwd");
  fs.mkdirSync(isolatedCwd, { recursive: true });

  const service = new bundledDiagMod.DiagnosticsService({
    dshHome: box.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
    cwd: isolatedCwd,
    checkBundledPaseo: false,
    runner: makeHealthyRunner(),
  });

  const overview = diagnosticsOverviewSchema.parse(await service.overview());
  assert.equal(overview.hasIssues, false);
  assert.equal(overview.route.status, "configured");
  assert.equal(overview.credentials.status, "ready");
  assert.equal(overview.pluginVersion, undefined, "missing package.json in eval bundle cleanly omits pluginVersion");

  const report = doctorReportSchema.parse(await service.runDoctor());
  assert.equal(report.ok, true);
  assert.equal(report.summary.fail, 0);
  service.dispose();
});

test("options.doctorModule and options.doctorModulePath overrides remain supported", async (t) => {
  const box = makeSandbox(t);
  const dshPkg = makeFakePackageDsh(box.root, "0.2.2-rc.5");

  // 1. In-memory options.doctorModule override
  let inspectCalls = 0;
  const realDoctor = await loadDoctor();
  const stubService = new DiagnosticsService({
    dshHome: box.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
    checkBundledPaseo: false,
    runner: makeHealthyRunner(),
    doctorModule: {
      ...realDoctor,
      inspectInstallFiles(opts) {
        inspectCalls += 1;
        return realDoctor.inspectInstallFiles(opts);
      },
    },
  });
  const stubOverview = diagnosticsOverviewSchema.parse(await stubService.overview());
  assert.equal(stubOverview.hasIssues, false);
  assert.equal(inspectCalls, 1, "options.doctorModule override must be invoked");
  stubService.dispose();

  // 2. Explicit options.doctorModulePath override pointing to an existing .mjs file
  const pathService = new DiagnosticsService({
    dshHome: box.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
    checkBundledPaseo: false,
    runner: makeHealthyRunner(),
    doctorModulePath: DOCTOR_MJS,
  });
  const pathOverview = diagnosticsOverviewSchema.parse(await pathService.overview());
  assert.equal(pathOverview.hasIssues, false);
  assert.ok(pathOverview.pluginVersion, "doctorModulePath resolves sibling package.json version");
  pathService.dispose();

  // 3. Explicit nonexistent options.doctorModulePath fails loudly instead of falling back
  const missingPath = path.join(box.root, "does-not-exist", "doctor.mjs");
  const badService = new DiagnosticsService({
    dshHome: box.dshHome,
    profile: PROFILE,
    binary: dshPkg.link,
    env: { PATH: dshPkg.binDir, DSH_HOME: box.dshHome },
    checkBundledPaseo: false,
    doctorModulePath: missingPath,
  });
  await assert.rejects(() => badService.overview(), /could not locate doctor module/);
  const badReport = doctorReportSchema.parse(await badService.runDoctor());
  assert.equal(badReport.ok, false);
  assert.match(badReport.error ?? "", /could not locate doctor module/);
  badService.dispose();
});
