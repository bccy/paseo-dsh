#!/usr/bin/env node
/**
 * Discover what a model route can actually do, so its capabilities can be
 * declared in a DSH profile with evidence instead of guesswork.
 *
 * DSH resolves a route's reasoning support from its model metadata. A route the
 * installed catalog knows nothing about — any self-hosted or self-configured
 * provider — reports *no* reasoning at all, and DSH then rejects every effort
 * with `UNSUPPORTED_REASONING_EFFORT`. That reads like a model limitation but is
 * usually just a missing declaration, so this probes the endpoint itself.
 *
 * It answers the two questions that decide the profile config:
 *   1. Does the route do reasoning, and which `reasoning_effort` spellings does
 *      it accept? (`off` is special: the parameter must be omitted entirely,
 *      because most gateways reject the literal string.)
 *   2. Does it accept the OpenAI reasoning-model `developer` role? If not, the
 *      profile must set `compat.supportsDeveloperRole: false`, or every turn
 *      fails with a 422 the moment reasoning is declared.
 *
 * ### The key never reaches the output
 *
 * The key is read from the named environment variable and threaded through
 * {@link redact} on the way out. That is not decoration: a debug-mode proxy or a
 * misconfigured portal echoes the `Authorization` header back in its error body,
 * and this tool's stdout is read by an install agent and then pasted into a
 * chat. `--api-key-env` is checked to *look like* a variable name before it is
 * ever echoed, because "or I'll just give you the key" is a realistic way to
 * fill that flag in with the secret itself.
 *
 * ### A 200 is not an answer
 *
 * Self-hosted gateways answer `200` with `{"error": …}` for a bad model id, a
 * quota, or a failed auth, and a corporate portal answers `200` with HTML. An
 * `ok` that only looks at `response.ok` therefore reports every reasoning level
 * as accepted and prints a fragment declaring capabilities the route does not
 * have. {@link attempt} requires `choices[0].message` to be an object.
 *
 * ### A failure to answer is not a refusal
 *
 * `400`/`404`/`422` on one `reasoning_effort` spelling is evidence about that
 * spelling. A `429`, a `5xx` or a transport error is evidence about nothing —
 * eight consecutive calls make rate limiting likely — so those are reported as
 * *unknown* rather than folded into "no spelling was accepted", which used to
 * end in advice to declare a reasoning route as non-reasoning.
 *
 * Exposed as a function so the `paseo-dsh` CLI and the repo's standalone
 * `tools/probe-provider.mjs` share one implementation.
 *
 * @module paseo-dsh/lib/probe-provider
 */
import { pathToFileURL } from "node:url";

const CANDIDATE_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** An environment variable *name*; used before echoing `--api-key-env` back. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse `--flag value` and `--flag=value` pairs into a plain object. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    if (equals !== -1) {
      out[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/** Nothing that carries the key may be printed without coming through here. */
function redact(text, apiKey) {
  let out = String(text ?? "");
  if (apiKey !== undefined && apiKey !== "") out = out.split(apiKey).join("***");
  return out;
}

/** Drop credentials a base URL carries in its userinfo before echoing it. */
function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

/** `error.message` plus undici's `cause`, which holds the DNS/TLS detail. */
function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const causeText = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
  return causeText === "" ? error.message : `${error.message} (${causeText})`;
}

function usage(program, message) {
  const text = `usage: ${program} --base-url <url> --api-key-env <ENV_VAR> --model <id> [--model <id>...]\n`;
  if (message === undefined) {
    // Help is output, so it goes to stdout: `probe --help | less` has to work.
    process.stdout.write(text);
    return;
  }
  process.stderr.write(`error: ${message}\n\n${text}`);
  process.exitCode = 2;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The message object of the first choice, if the response carried one. */
function messageOf(body) {
  const message = body?.choices?.[0]?.message;
  return typeof message === "object" && message !== null ? message : undefined;
}

function reasoningChars(message) {
  return String(message?.reasoning_content ?? message?.reasoning ?? "").length;
}

/**
 * Whether a failed attempt is evidence about *capability*.
 *
 * Only a 4xx that is not a throttle says "this route refused this request".
 * `429`, `408`, a `5xx` or a transport failure says the route never answered,
 * which must not be read as a refusal.
 */
function isVerdict(result) {
  if (result.ok) return true;
  if (result.status < 400 || result.status >= 500) return false;
  return result.status !== 429 && result.status !== 408;
}

/** One chat completion, reporting whether the endpoint accepted the request. */
async function attempt(endpoint, apiKey, body) {
  let status = 0;
  let text;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    status = response.status;
    // Read the body inside the same guard: a reset or a timeout that lands
    // after the headers still throws, and it used to escape `attempt` entirely
    // and abort every remaining model.
    text = await response.text();
  } catch (error) {
    return { ok: false, status, detail: redact(describeError(error), apiKey) };
  }

  const parsed = parseJson(text);
  if (status < 200 || status >= 300) {
    const detail = parsed?.error?.message ?? parsed?.message ?? text.slice(0, 240);
    return { ok: false, status, detail: redact(detail, apiKey) };
  }

  // HTTP 200 says nothing about the payload. See the module header.
  if (parsed === undefined || messageOf(parsed) === undefined) {
    const shape = parsed === undefined ? `non-JSON body: ${text.slice(0, 160)}` : "no choices[0].message";
    return { ok: false, status, detail: redact(shape, apiKey) };
  }
  return { ok: true, status, body: parsed };
}

async function probeModel(endpoint, apiKey, model) {
  const findings = { levels: [], developerRole: undefined, reasonsAtBaseline: undefined };

  const baseline = await attempt(endpoint, apiKey, {
    model,
    messages: [{ role: "user", content: "What is 17*23? Reply with just the number." }],
    max_tokens: 256,
  });
  if (!baseline.ok) return { ...findings, fatal: baseline };

  const baselineMessage = messageOf(baseline.body);
  findings.reasonsAtBaseline =
    baselineMessage === undefined
      ? false
      : "reasoning_content" in baselineMessage || reasoningChars(baselineMessage) > 0;

  const developer = await attempt(endpoint, apiKey, {
    model,
    messages: [
      { role: "developer", content: "You are terse." },
      { role: "user", content: "What is 17*23? Reply with just the number." },
    ],
    max_tokens: 256,
  });
  // `undefined` means "could not tell", which must not print as REJECTED: the
  // advice attached to that verdict changes the user's profile.
  findings.developerRole = developer.ok ? true : isVerdict(developer) ? false : undefined;
  findings.developerDetail = developer.ok ? undefined : developer.detail;

  for (const level of CANDIDATE_LEVELS) {
    const result = await attempt(endpoint, apiKey, {
      model,
      messages: [{ role: "user", content: "What is 17*23? Reply with just the number." }],
      max_tokens: 256,
      reasoning_effort: level,
    });
    findings.levels.push({
      level,
      ok: result.ok,
      status: result.status,
      detail: result.detail,
      verdict: isVerdict(result),
    });
  }
  return findings;
}

/** Render the profile fragment a user can paste after the probe. */
function profileSnippet(model, findings) {
  const accepted = findings.levels.filter((entry) => entry.ok).map((entry) => entry.level);
  const lines = [`          - id: ${model}`, `            name: ${model}`];
  if (accepted.length === 0) return lines.join("\n");
  lines.push("            reasoningEfforts:");
  // `off` must carry no value: omitting the parameter is what turns thinking
  // off, while the literal string is rejected by most gateways.
  lines.push("              off:");
  for (const level of accepted) lines.push(`              ${level}: ${level}`);
  return lines.join("\n");
}

/**
 * Run the probe. `argv` excludes the node/script prefix.
 * @param {string[]} argv
 * @param {string} program - Program name shown in usage/errors.
 * @returns {Promise<void>} sets a non-zero exit code when nothing probed.
 */
export async function runProbe(argv, program = "paseo-dsh probe") {
  const args = parseArgs(argv);
  if (args.help === true) {
    usage(program);
    return;
  }
  const baseUrl = typeof args["base-url"] === "string" ? args["base-url"].replace(/\/$/, "") : undefined;
  const keyEnv = typeof args["api-key-env"] === "string" ? args["api-key-env"] : undefined;
  const models = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--model" && argv[i + 1] !== undefined) models.push(argv[i + 1]);
  }
  if (baseUrl === undefined) {
    usage(program, "--base-url is required");
    return;
  }
  if (keyEnv === undefined) {
    usage(program, "--api-key-env is required");
    return;
  }
  if (!ENV_VAR_NAME.test(keyEnv)) {
    // Never echo the value: an install agent handed "or just give me the key"
    // tends to put the secret here instead of the variable's name, and this
    // message is exactly what would surface it.
    process.stderr.write("error: --api-key-env must be the *name* of an environment variable\n");
    process.exitCode = 2;
    return;
  }
  if (models.length === 0) {
    usage(program, "at least one --model is required");
    return;
  }

  const apiKey = process.env[keyEnv];
  if (apiKey === undefined || apiKey === "") {
    process.stderr.write(`error: environment variable ${keyEnv} is empty or unset\n`);
    process.exitCode = 2;
    return;
  }

  const endpoint = `${baseUrl}/chat/completions`;
  process.stdout.write(`endpoint: ${redactUrl(endpoint)}\n\n`);

  let probed = 0;
  for (const model of models) {
    process.stdout.write(`model: ${model}\n`);
    const findings = await probeModel(endpoint, apiKey, model);
    if (findings.fatal !== undefined) {
      process.stdout.write(
        `  baseline call .......... FAILED (${findings.fatal.status || "network"}) ${findings.fatal.detail}\n`,
      );
      process.stdout.write("  cannot probe further; check the base URL, key, and model id\n\n");
      continue;
    }
    // A baseline that answered only proves the route is reachable. If no
    // spelling ever earned a verdict, nothing about its reasoning was
    // determined, and an exit code of 0 would read as "probe succeeded".
    if (findings.levels.some((entry) => entry.verdict)) probed += 1;
    process.stdout.write(
      `  baseline call .......... ok (reasoning content at baseline: ${
        findings.reasonsAtBaseline ? "yes" : "no"
      })\n`,
    );
    process.stdout.write(
      `  role=developer ......... ${
        findings.developerRole === true
          ? "accepted"
          : findings.developerRole === false
            ? "REJECTED -> needs compat.supportsDeveloperRole: false"
            : `unknown (${findings.developerDetail ?? "no answer"})`
      }\n`,
    );
    for (const entry of findings.levels) {
      const verdict = entry.ok
        ? "accepted"
        : entry.verdict
          ? `rejected (${entry.status})`
          : `unknown (${entry.status || "network"})`;
      process.stdout.write(`  reasoning_effort=${entry.level.padEnd(8)} ${verdict}`);
      if (!entry.ok && entry.detail !== undefined) process.stdout.write(`  ${entry.detail}`);
      process.stdout.write("\n");
    }
    process.stdout.write("\n  profile fragment:\n\n");
    process.stdout.write(`${profileSnippet(model, findings)}\n`);
    const accepted = findings.levels.filter((entry) => entry.ok);
    const unknown = findings.levels.filter((entry) => !entry.verdict);
    if (accepted.length === 0 && unknown.length > 0) {
      // Not a conclusion. Advising a config change here is how a rate-limited
      // reasoning route got declared as a non-reasoning one.
      process.stdout.write(
        `\n  ${unknown.length} of ${findings.levels.length} spellings never got an answer `
        + "(throttling or a transport error), so this is not a result.\n"
        + "  Re-run before declaring anything about this route's reasoning support.\n",
      );
    } else if (accepted.length === 0) {
      process.stdout.write(
        "\n  no reasoning_effort spelling was accepted; declare `reasoningEfforts: false`\n"
        + "  for this model so DSH reports it as a non-reasoning route\n",
      );
    }
    process.stdout.write("\n");
  }

  if (probed === 0) {
    // The README tells the install agent to paste this snippet verbatim, and
    // `set -e` / `if ! npx paseo-dsh probe` read the exit code. Reporting a
    // successful run after every model failed is how that becomes a bad config.
    process.stderr.write("error: no model could be probed; nothing was determined\n");
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // `probe … | head -1` closes stdout early; unhandled, that dies with an
  // `'error'` event and a stack.
  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
  await runProbe(process.argv.slice(2), "node lib/probe-provider.mjs");
}
