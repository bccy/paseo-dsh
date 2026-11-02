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
 *   5b. baseline 200 then 401/402/403 (revoked key, exhausted quota, policy
 *      denial) is also **unknown** — not "developer role rejected"/"all levels
 *      rejected" with exit 0 and permanent-downgrade advice. A generic 400 that
 *      never names the parameter is unknown too.
 *   5b2. the same is true when the error body *does* name the dimension: a
 *      developer 401/403 and an effort 402 must still read as unknown, because
 *      the status, not the wording, decides that this is an environment
 *      failure. This is the regression for `isVerdict`'s auth/quota branch.
 *   6. Nothing probed at all exits non-zero: `set -e` and `if ! npx … probe`
 *      read that code. A 400 whose body names `reasoning_effort` (or the
 *      `developer` role) is still a real refusal, and the compatibility advice
 *      still appears.
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

// ---- 5b. auth/quota failures after a successful baseline are unknown -----
{
  // The route answered the baseline, then its key was revoked / quota ran out.
  // Every later 401/402/403 is about the environment: it must not become
  // "developer role rejected" + "all reasoning levels rejected" + exit 0 with
  // advice to permanently downgrade the profile. Reproduced against a loopback
  // gateway for all three status codes because they share the defect.
  for (const status of [401, 402, 403]) {
    respond = (body) => {
      if (body?.messages?.some((message) => message.role === "developer")) {
        return { status, body: { error: { message: "invalid api key or insufficient quota" } } };
      }
      if (body?.reasoning_effort !== undefined) {
        return { status, body: { error: { message: "insufficient quota" } } };
      }
      return { status: 200, body: { choices: [{ message: { content: "391" } }] } };
    };
    const run = await probe(args);
    check(
      `baseline 200 then ${status}: the developer role is unknown, not REJECTED`,
      run.out.includes("role=developer ......... unknown") && !run.out.includes("supportsDeveloperRole: false"),
      run.out.trim().split("\n").find((line) => line.includes("role=developer")) ?? "(no developer line)",
    );
    check(
      `baseline 200 then ${status}: no reasoning level is reported as rejected`,
      run.out.includes(`unknown (${status})`) && !run.out.includes(`rejected (${status})`),
      run.out.trim().split("\n").filter((line) => line.includes("reasoning_effort"))[0],
    );
    check(
      `baseline 200 then ${status}: no permanent downgrade advice is printed`,
      !run.out.includes("reasoningEfforts: false") && !run.out.includes("supportsDeveloperRole: false"),
    );
    check(`baseline 200 then ${status}: the run is inconclusive and exits 1`, run.code === 1, `exit ${run.code}`);
  }
}

// ---- 5b2. the 401/402/403 early return must beat a dimension-naming body --
{
  // The sole regression for `isVerdict()`'s explicit auth/quota early return.
  // The 5b fixture's error bodies name neither dimension, so deleting that
  // branch still ends in "unknown" through the dimension regexes — it never
  // exercises the branch. Here the bodies DO name the probed field, so only the
  // early return keeps an auth/quota denial from becoming a capability verdict:
  //   developer probe -> 401/403 "developer role ..."
  //   effort probe    -> 402     "reasoning_effort ..."
  for (const developerStatus of [401, 403]) {
    respond = (body) => {
      if (body?.messages?.some((message) => message.role === "developer")) {
        return {
          status: developerStatus,
          body: { error: { message: "developer role not permitted for this key" } },
        };
      }
      if (body?.reasoning_effort !== undefined) {
        return { status: 402, body: { error: { message: "reasoning_effort quota exhausted" } } };
      }
      return { status: 200, body: { choices: [{ message: { content: "391" } }] } };
    };
    const run = await probe(args);
    check(
      `baseline 200 then developer ${developerStatus} naming "developer" is unknown, not REJECTED`,
      run.out.includes("role=developer ......... unknown") && !run.out.includes("supportsDeveloperRole: false"),
      run.out.trim().split("\n").find((line) => line.includes("role=developer")) ?? "(no developer line)",
    );
    check(
      `baseline 200 then effort 402 naming "reasoning" is unknown, not rejected`,
      run.out.includes("unknown (402)") && !run.out.includes("rejected (402)"),
      run.out.trim().split("\n").filter((line) => line.includes("reasoning_effort"))[0],
    );
    check(
      `developer ${developerStatus} / effort 402: no permanent downgrade advice`,
      !run.out.includes("reasoningEfforts: false") && !run.out.includes("supportsDeveloperRole: false"),
    );
    check(
      `developer ${developerStatus} / effort 402: the run is inconclusive and exits non-zero`,
      run.code === 1,
      `exit ${run.code}`,
    );
  }
}

// ---- 5c. a generic 4xx does not name the parameter, so it is unknown -----
{
  respond = (body) => {
    if (body?.messages?.some((message) => message.role === "developer")) {
      return { status: 400, body: { error: { message: "Bad Request" } } };
    }
    if (body?.reasoning_effort !== undefined) {
      return { status: 400, body: { error: { message: "Bad Request" } } };
    }
    return { status: 200, body: { choices: [{ message: { content: "391" } }] } };
  };
  const run = await probe(args);
  check(
    "a generic 400 on the effort spellings reads as unknown, not rejected",
    run.out.includes("unknown (400)") && !run.out.includes("rejected (400)"),
    run.out.trim().split("\n").filter((line) => line.includes("reasoning_effort"))[0],
  );
  check("and it does not advise a permanent downgrade", !run.out.includes("reasoningEfforts: false"));
  check("and it exits non-zero", run.code === 1, `exit ${run.code}`);
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

// ---- 6b. a 4xx that names the developer role is a refusal ----------------
{
  respond = (body) => {
    if (body?.messages?.some((message) => message.role === "developer")) {
      return { status: 400, body: { error: { message: "role 'developer' is not supported by this model" } } };
    }
    return { status: 200, body: { choices: [{ message: { content: "391" } }] } };
  };
  const run = await probe(args);
  check(
    "a 400 that names the developer role still yields the compatibility advice",
    run.out.includes("REJECTED -> needs compat.supportsDeveloperRole: false"),
    run.out.trim().split("\n").find((line) => line.includes("role=developer")) ?? "(no developer line)",
  );
  check("and the reasoning levels still conclude normally", run.code === 0, `exit ${run.code}`);
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
