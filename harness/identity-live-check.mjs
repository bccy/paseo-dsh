/**
 * Live check: two Paseo agents sharing one `dsh` child see THEIR OWN identity.
 *
 * This is the behaviour no offline check can prove: the plugin spawns one real
 * `dsh --profile paseo`, the bridge serves two sessions with different
 * `PASEO_AGENT_ID` / `PASEO_WORKSPACE_ID`, and a real model runs `bash` inside
 * each. Only the whole chain — plugin `config.env` -> `initialize` -> bridge
 * identity table -> `ctx.shellEnv` `DSH_PASEO_*` -> `BASH_ENV` -> `PASEO_*` —
 * makes the echoed values correct, and a shared process showing the first
 * session's values is exactly the defect this pins.
 *
 * Scenarios (each one model turn; a different DSH session unless noted):
 *   1. session A (identity A): `printf 'ID_A|%s|%s' "$PASEO_AGENT_ID" "$PASEO_WORKSPACE_ID"`
 *      -> `ID_A|agent-live-a|wks-live-a`;
 *   2. session B (identity B): the same with B's values, in the SAME shared child,
 *      and the two outputs must differ;
 *   3. session A: the command with `run_in_background: true`, then `job_output`
 *      -> `ID_BG|agent-live-a`;
 *   4. session B: the command under the sandbox tool (`sandbox_permissions:
 *      workspace-write`), when the profile composes one -> `ID_SB|agent-live-b`;
 *   5. session C (no identity): `printf 'ID_N|%s' "${PASEO_AGENT_ID-<unset>}"`
 *      -> `ID_N|<unset>` (the negative: never another session's value).
 *
 * The bash tool result is read from the session's timeline rows: the output must
 * appear verbatim, so an answer the model merely repeats from the prompt cannot
 * satisfy it (the prompt contains the *format*, not the resolved values).
 *
 * **Costs five model turns** and needs a working model route. A throwaway clone
 * of the live profile is used (`isolated-dsh-home.cjs`), so nothing is written
 * to the user's profile/session store. Run:
 *
 *   env -u DSH_HOME node harness/identity-live-check.mjs
 *
 * `PASEO_CHECK_MODEL=provider/model` selects a model (same variable the
 * plugin-check accepts); unset uses the profile's fallback route.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { announceDshHome, prepareDshHome } = require("./isolated-dsh-home.cjs");
const { resolvePluginBuild } = require("./plugin-build.cjs");

// DSH's bash tool runs inside the sandbox, whose `/tmp` is a tmpfs: a file
// written under a `/tmp` DSH_HOME is simply not visible there, and `bash`
// silently skips an unreadable BASH_ENV. The live clone must therefore live
// under the user's home (the production `~/.dsh` is already there; only this
// throwaway clone needs the move). See envparity E6.
const scratchParent = join(homedir(), ".cache");
mkdirSync(scratchParent, { recursive: true });
const scratchRoot = mkdtempSync(join(scratchParent, "dsh-identity-live-"));
process.env.TMPDIR = scratchRoot;

let runMode;
try {
  runMode = prepareDshHome({
    script: "identity-live-check",
    profile: process.env.DSH_PASEO_PROFILE ?? "paseo",
    argv: process.argv.slice(2),
  });
} catch (error) {
  console.error(`identity-live-check: ${error.message}`);
  process.exit(2);
}
announceDshHome(runMode);

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-identity-live");
const plugin = require(join(buildDir, "index.server.js")).default;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const events = [];
let registration;
plugin({
  handle() {},
  registerProvider(providerRegistration) {
    registration = providerRegistration;
  },
  registerSettings() {},
  on() {},
  before() {},
});

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

async function until(predicate, label, ms = 180000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.find(predicate);
    if (hit !== undefined) return hit;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Every timeline row the session produced after `mark`. */
const rowsSince = (mark, sessionId) => events
  .slice(mark)
  .filter((event) => event.type === "timeline.item" && event.sessionId === sessionId)
  .map((event) => JSON.stringify(event.item));

/** The tool_call rows only: what the check needs to read when an assertion fails. */
const toolRowsSince = (mark, sessionId) => events
  .slice(mark)
  .filter((event) => event.type === "timeline.item" && event.sessionId === sessionId
    && event.item?.type === "tool_call")
  .map((event) => JSON.stringify(event.item));

/** The first row (either side, tool output or answer) containing `text`. */
const rowWith = (mark, sessionId, text) => rowsSince(mark, sessionId).find((row) => row.includes(text));

const root = mkdtempSync(join(tmpdir(), "identity-live-work-"));
const cwdA = join(root, "workspace-a");
const cwdB = join(root, "workspace-b");
const cwdC = join(root, "workspace-c");
for (const dir of [cwdA, cwdB, cwdC]) require("node:fs").mkdirSync(dir, { recursive: true });

const identityA = {
  PASEO_AGENT_ID: "agent-live-a",
  PASEO_AGENT_CWD: cwdA,
  PASEO_WORKSPACE_ID: "wks-live-a",
};
const identityB = {
  PASEO_AGENT_ID: "agent-live-b",
  PASEO_AGENT_CWD: cwdB,
  PASEO_WORKSPACE_ID: "wks-live-b",
};

(async () => {
  const conn = await registration.connect({ capabilities: ["prompt.message", "permission"] });
  conn.onEvent((event) => {
    events.push(event);
    // Tool calls raise an approval card; the check is the user here. Allowing
    // once is what the real UI's primary action does, and a denied call would
    // leave the bash row empty and the assertion meaningless.
    if (event.type === "session.permission" && event.request?.id !== undefined) {
      void conn.send({
        type: "session.permission",
        sessionId: event.sessionId,
        permissionId: event.request.id,
        response: { behavior: "allow" },
      }).catch(() => {});
    }
  });

  async function open(sessionId, cwd, env) {
    const mark = events.length;
    await conn.send({
      type: "session.open",
      requestId: `open-${sessionId}`,
      sessionId,
      config: {
        cwd,
        mode: "build",
        env,
        ...(process.env.PASEO_CHECK_MODEL === undefined ? {} : { model: process.env.PASEO_CHECK_MODEL }),
      },
      history: "skip",
    });
    await until(
      (event) => event.type === "session.ready" && event.sessionId === sessionId,
      `session.ready for ${sessionId}`,
    );
    return mark;
  }

  /** Ask for one bash command and wait for the turn to end. */
  async function runPrompt(sessionId, clientMessageId, text) {
    const mark = events.length;
    await conn.send({
      type: "session.prompt",
      sessionId,
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text }] },
      },
    });
    await until(
      (event) => event.type === "session.turn" && event.sessionId === sessionId
        && event.state === "completed" && event.turnId === `turn:${clientMessageId}`,
      `turn ${clientMessageId} completed`,
    );
    await sleep(1200);
    return mark;
  }

  const sessionA = `identity-live-a-${Date.now()}`;
  const sessionB = `identity-live-b-${Date.now()}`;
  const sessionC = `identity-live-c-${Date.now()}`;

  await open(sessionA, cwdA, identityA);
  await open(sessionB, cwdB, identityB);
  await open(sessionC, cwdC, {});
  check("three sessions open on one provider connection", true, "A, B and C ready");

  // 1. session A: its own identity.
  const markA = await runPrompt(
    sessionA,
    "identity-a",
    'Run exactly this with the bash tool (one call, no edits): printf \'ID_A|%s|%s\' "$PASEO_AGENT_ID" "$PASEO_WORKSPACE_ID"'
      + "\nThen reply with only the command's stdout.",
  );
  check(
    "session A's bash sees session A's agent id and workspace id",
    rowWith(markA, sessionA, "ID_A|agent-live-a|wks-live-a") !== undefined,
    toolRowsSince(markA, sessionA).join("\n").slice(0, 2000),
  );

  // 2. session B: in the same shared child, its own — and different — identity.
  const markB = await runPrompt(
    sessionB,
    "identity-b",
    'Run exactly this with the bash tool (one call, no edits): printf \'ID_B|%s|%s\' "$PASEO_AGENT_ID" "$PASEO_WORKSPACE_ID"'
      + "\nThen reply with only the command's stdout.",
  );
  const rowB = rowWith(markB, sessionB, "ID_B|agent-live-b|wks-live-b");
  check(
    "session B's bash sees session B's (different) agent id and workspace id",
    rowB !== undefined,
    toolRowsSince(markB, sessionB).join("\n").slice(0, 2000),
  );
  check(
    "the two sessions' echoed identities differ (not the first session's value)",
    rowB !== undefined
      && rowWith(markA, sessionA, "ID_A|agent-live-a|wks-live-a") !== undefined
      && !rowB.includes("agent-live-a"),
    rowB === undefined ? "(session B produced no matching row)" : "B did not echo A's values",
  );

  // 3. background job: the same BASH_ENV hook applies to the job's `bash -c`.
  const markBg = await runPrompt(
    sessionA,
    "identity-bg",
    'Use the bash tool with run_in_background: true to run exactly: printf \'ID_BG|%s\' "$PASEO_AGENT_ID"'
      + "\nThen read that job's output with the job_output tool and reply with only the output.",
  );
  check(
    "a background job sees the same session's agent id",
    rowWith(markBg, sessionA, "ID_BG|agent-live-a") !== undefined,
    toolRowsSince(markBg, sessionA).join("\n").slice(0, 2000),
  );

  // 4. sandbox mode: bwrap does not clear env, so the hook still applies.
  const markSandbox = await runPrompt(
    sessionB,
    "identity-sandbox",
    'Use the bash tool with sandbox_permissions "workspace-write" and a one-line justification to run exactly: printf \'ID_SB|%s\' "$PASEO_AGENT_ID"'
      + "\nThen reply with only the command's stdout.",
  );
  const sandboxRow = rowWith(markSandbox, sessionB, "ID_SB|agent-live-b");
  check(
    "a sandboxed bash sees the session's agent id",
    sandboxRow !== undefined,
    sandboxRow === undefined
      ? `no matching row (profile may not compose a sandbox tool): ${toolRowsSince(markSandbox, sessionB).join("\n").slice(0, 2000)}`
      : "ID_SB|agent-live-b present",
  );

  // 5. negative: no identity -> nothing exported (unset, not another value).
  const markC = await runPrompt(
    sessionC,
    "identity-none",
    'Run exactly this with the bash tool (one call, no edits): printf \'ID_N|%s\' "${PASEO_AGENT_ID-<unset>}"'
      + "\nThen reply with only the command's stdout.",
  );
  check(
    "a session without identity exports nothing (never another session's value)",
    rowWith(markC, sessionC, "ID_N|<unset>") !== undefined
      && !rowWith(markC, sessionC, "ID_N|agent-live-"),
    toolRowsSince(markC, sessionC).join("\n").slice(0, 2000),
  );

  await conn.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(scratchRoot, { recursive: true, force: true });

  const failed = results.filter((result) => !result.pass).length;
  console.log(`\n  ${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (error) => {
  console.error(`identity-live-check: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  process.exit(1);
});
