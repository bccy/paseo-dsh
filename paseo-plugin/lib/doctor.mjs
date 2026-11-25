/**
 * `paseo-dsh doctor` — one-command self-check CLI for a DeepSeek Harness × Paseo
 * install.
 *
 * Thin CLI wrapper over the shared pure core in `../server/doctor-core.mjs`
 * (which is statically imported and inlined by Paseo's server bundler in
 * `server/diagnostics.ts`). Re-exports every core helper so existing CLI and
 * harness callers remain 100% compatible.
 *
 * Security invariant: raw `.credentials.yaml` contents, secret values, and
 * YAML parser error snippets for `.credentials.yaml` are NEVER returned or
 * printed by any function in this module.
 *
 * @module paseo-dsh/lib/doctor
 */
import { runDoctorChecks } from "../server/doctor-core.mjs";

export * from "../server/doctor-core.mjs";

const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

let stdoutEpipeInstalled = false;
function installStdoutEpipeGuard() {
  if (stdoutEpipeInstalled) return;
  stdoutEpipeInstalled = true;
  // `doctor | head -1` closes stdout early. Unhandled, that dies with an
  // `'error'` event and exit code 1 — which is exactly the code that means
  // "blocking issue", so a consumer cannot tell a crash from a diagnosis.
  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

/**
 * Render a `runDoctorChecks()` report to stdout/stderr with the exact CLI
 * layout and exit codes expected by `paseo-dsh doctor` and `harness/doctor-check.mjs`.
 */
export function runDoctor(options) {
  installStdoutEpipeGuard();
  const report = runDoctorChecks(options);
  if (report.fatalError !== undefined) {
    process.stderr.write(`${report.fatalError}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n${DIM}paseo-dsh doctor  (plugin ${report.pluginVersion})${RESET}\n`);
  process.stdout.write(
    `${DIM}profile "${report.profile}" (${report.profileFromEnv ? "DSH_PASEO_PROFILE" : "default; the daemon must use the same value"})${RESET}\n\n`,
  );

  for (const item of report.checks) {
    const tag =
      item.level === "ok" ? `${GREEN}ok  ${RESET}` : item.level === "warn" ? `${YELLOW}warn${RESET}` : `${RED}fail${RESET}`;
    process.stdout.write(`  [${tag}] ${item.label}${item.detail ? `\n         ${DIM}${item.detail}${RESET}` : ""}\n`);
  }

  const fails = report.summary.fail;
  const warns = report.summary.warn;
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
