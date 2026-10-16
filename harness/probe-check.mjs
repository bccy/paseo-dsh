/**
 * Offline check for `paseo-dsh probe`.
 *
 * The probe's output is pasted verbatim into a DSH profile ("use the fragment
 * as-is"), and its exit code is read by installers and agents. Both halves had
 * failed in ways no test could see, so this drives the real implementation
 * against a scripted local gateway and asserts:
 *
 *   1. `HTTP 200` carrying `{"error": …}` — a bad model id, a quota, a failed
 *      auth on a self-hosted gateway — is a **failure**, not "every reasoning
 *      level accepted". A 200 says nothing about the payload.
 *   2. `HTTP 200` carrying HTML (a corporate portal) is a failure too.
 *   3. A `4xx` that echoes the `Authorization` header — debug-mode proxies do
 *      this — must not put the key in stdout.
 *   4. `--api-key-env <the secret itself>`, which an agent handed "or I'll just
 *      give you the key" will produce, must not echo the secret.
 *   5. All-429 is reported as **unknown**, and must not end in the advice to
 *      declare the route non-reasoning.
 *   6. Nothing probed at all exits non-zero: `set -e` and `if ! npx … probe`
 *      read that code.
 *   7. The happy path still prints the fragment and exits 0.
 *
 * No profile, no daemon, no model: the gateway is this file's own HTTP server.
 *
 * Usage: node harness/probe-check.mjs
 */
import http from "node:http";
import { runProbe } from "../paseo-plugin/lib/probe-provider.mjs";

const KEY = "sk-probe-check-LEAKCANARY-4f2a";
const ENV_NAME = "PASEO_PROBE_CHECK_KEY";
process.env[ENV_NAME] = KEY;

/** The reply the next request gets; each case swaps it. */
let respond = () => ({ status: 200, body: { choices: [{ message: { content: "391" } }] } });

const server = http.createServer((request, reply) => {
  let raw = "";
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const scripted = respond(parsed);
    reply.writeHead(scripted.status, { "content-type": scripted.type ?? "application/json" });
    reply.end(typeof scripted.body === "string" ? scripted.body : JSON.stringify(scripted.body));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

/** Run the probe with stdout/stderr captured, and report the exit code it set. */
async function probe(args) {
  const out = [];
  const err = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  process.exitCode = 0;
  try {
    await runProbe(args, "probe-check");
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  const code = process.exitCode ?? 0;
  process.exitCode = 0;
  return { out: out.join(""), err: err.join(""), code: Number(code) };
}

const args = ["--base-url", baseUrl, "--api-key-env", ENV_NAME, "--model", "some-model"];

// ---- 1. a 200 that carries an error is a failure -------------------------
{
  respond = () => ({ status: 200, body: { error: { message: "invalid model id `some-model`" } } });
  const run = await probe(args);
  check(
    "HTTP 200 + an error body is a FAILED baseline, not an accepted probe",
    run.out.includes("baseline call .......... FAILED") && !run.out.includes("accepted"),
    JSON.stringify(run.out.trim().split("\n").slice(0, 3)),
  );
  check("and it exits non-zero (nothing was determined)", run.code === 1, `exit ${run.code}`);
  check(
    "the fragment is not printed for a route that never answered",
    !run.out.includes("profile fragment"),
  );
}

// ---- 2. a 200 that carries HTML is a failure -----------------------------
{
  respond = () => ({ status: 200, body: "<html><body>login required</body></html>", type: "text/html" });
  const run = await probe(args);
  check(
    "HTTP 200 + HTML (a portal) is a FAILED baseline",
    run.out.includes("baseline call .......... FAILED") && !run.out.includes("accepted"),
    JSON.stringify(run.out.trim().split("\n").slice(0, 3)),
  );
  check("and it exits non-zero", run.code === 1, `exit ${run.code}`);
}

// ---- 3. a gateway that echoes the Authorization header -------------------
{
  respond = () => ({
    status: 401,
    body: { error: { message: `invalid api key: Bearer ${KEY}` } },
  });
  const run = await probe(args);
  check(
    "a gateway that echoes the key in its error body cannot leak it to stdout",
    !run.out.includes(KEY) && !run.err.includes(KEY),
    run.out.trim().split("\n").slice(-2).join(" | "),
  );
  check("the failure itself is still reported", run.out.includes("baseline call .......... FAILED"));
}

// ---- 4. `--api-key-env` given the secret instead of its name -------------
{
  respond = () => ({ status: 200, body: { choices: [{ message: { content: "391" } }] } });
  const run = await probe(["--base-url", baseUrl, "--api-key-env", KEY, "--model", "some-model"]);
  check(
    "a secret passed to --api-key-env is not echoed back",
    !run.out.includes(KEY) && !run.err.includes(KEY),
    run.err.trim(),
  );
  check("and the misuse is still an error (exit 2)", run.code === 2, `exit ${run.code}`);
}

// ---- 5. throttling is not a refusal --------------------------------------
{
  // The baseline has to succeed, or the run goes fatal before it ever reaches
  // the spelling loop — which is the only place the 429 distinction matters.
  respond = (body) =>
    body?.reasoning_effort === undefined
      ? { status: 200, body: { choices: [{ message: { content: "391" } }] } }
      : { status: 429, body: { error: { message: "rate limit exceeded" } } };
  const run = await probe(args);
  check(
    "an all-429 run says `unknown`, not `rejected`",
    run.out.includes("unknown (429)") && !run.out.includes("rejected ("),
    run.out.trim().split("\n").filter((line) => line.includes("reasoning_effort"))[0],
  );
  check(
    "and it never advises declaring the route non-reasoning",
    !run.out.includes("reasoningEfforts: false"),
  );
  check(
    "and the run is inconclusive, so it exits non-zero",
    run.code === 1,
    `exit ${run.code}`,
  );
}

// ---- 6. a 4xx on the effort spellings *is* a refusal ---------------------
{
  respond = (body) =>
    body?.reasoning_effort === undefined
      ? { status: 200, body: { choices: [{ message: { content: "391" } }] } }
      : { status: 400, body: { error: { message: "unsupported reasoning_effort" } } };
  const run = await probe(args);
  check(
    "a 4xx per spelling reads as `rejected`",
    run.out.includes("rejected (400)") && !run.out.includes("unknown (400)"),
    run.out.trim().split("\n").filter((line) => line.includes("reasoning_effort"))[0],
  );
  check(
    "the refusal detail reaches the user (it used to be collected and dropped)",
    run.out.includes("unsupported reasoning_effort"),
  );
  check(
    "and the non-reasoning advice is now the right conclusion",
    run.out.includes("reasoningEfforts: false"),
  );
  check("exit 0: the route answered, it just does not reason", run.code === 0, `exit ${run.code}`);
}

// ---- 7. the happy path is unchanged --------------------------------------
{
  respond = () => ({ status: 200, body: { choices: [{ message: { content: "391", reasoning_content: "17*23=391" } }] } });
  const run = await probe(args);
  check("the baseline still reports ok", run.out.includes("baseline call .......... ok"));
  check("every spelling reads as accepted", run.out.includes("reasoning_effort=high     accepted"));
  check("and the fragment is printed for pasting", run.out.includes("reasoningEfforts:"));
  check("exit 0", run.code === 0, `exit ${run.code}`);
  check("the key never appears anywhere", !run.out.includes(KEY) && !run.err.includes(KEY));
}

server.close();

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
