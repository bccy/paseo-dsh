/**
 * Offline check: per-session Paseo identity reaches only the session it belongs to.
 *
 * The shared `dsh` child cannot carry `PASEO_AGENT_ID` / `PASEO_AGENT_CWD` /
 * `PASEO_WORKSPACE_ID` in its process environment — every session would see the
 * first session's values. The bridge therefore stores the identity each
 * `initialize` frame carries, keyed by DSH session id, and exposes it two ways
 * this file pins without a model or a daemon:
 *
 *   1. **`identityEnvForExecution`** (the `ctx.shellEnv` resolver) answers the
 *      executing session's own `DSH_PASEO_*` values; a session with no row
 *      answers `{}` (never another session's values), and a native subagent
 *      inherits its nearest ancestor's identity through the `children` parent
 *      edges — including a nested grandchild.
 *   2. **The `BASH_ENV` hook** `identity-env.ts` writes maps those per-execution
 *      `DSH_PASEO_*` facts to the real `PASEO_*` names every `bash -c` sees. It
 *      exports nothing at all when no identity is present (unset, not empty),
 *      only the fields that are present when some are, and sources a user
 *      BASH_ENV last so the user's own behaviour is preserved. It always exits
 *      successfully.
 *
 * It also pins the protocol edge: `initialize` refuses an identity without a
 * session id, and a re-initialize without identity clears the old row.
 *
 * Pure offline: the bridge server is loaded against this machine's DSH install
 * (same resolve hook as `bridge-server-check.mjs`); the plugin is compiled to a
 * private directory for `identity-env.js`; bash runs a generated hook only.
 *
 * Usage: node harness/identity-env-check.mjs [compiled-plugin-dir]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = import.meta.dirname;

const DEFAULT_DSH_PACKAGES =
  `${homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`;
const dshPackages = process.env.DSH_PACKAGES_DIR ?? DEFAULT_DSH_PACKAGES;
const dshRoot = process.env.DSH_INSTALL_DIR ?? resolve(dshPackages, "..", "..");
const dshAnchor = join(dshRoot, "package.json");

const { register } = await import("node:module");
register(`data:text/javascript,${encodeURIComponent(
  `import { createRequire } from 'node:module';
   import { pathToFileURL } from 'node:url';
   const require = createRequire(${JSON.stringify(dshAnchor)});
   export async function resolve(specifier, context, next) {
     if (specifier.startsWith('@deepseek-ai/')) {
       try {
         return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
       } catch {
         /* not a package this install ships: let Node report it */
       }
     }
     return next(specifier, context);
   }`,
)}`);

const serverPath = join(here, "..", "dsh-bridge/lib/server.js");
let PaseoHarnessServer;
try {
  ({ PaseoHarnessServer } = await import(pathToFileURL(serverPath).href));
} catch (error) {
  console.error(`could not load ${serverPath} offline: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const { resolvePluginBuild } = require("./plugin-build.cjs");
const buildDir = resolvePluginBuild(process.argv[2], ".dbg-identity-env");
const identityEnv = require(join(buildDir, "server/identity-env.js"));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

/** A server with just the services `initialize` reaches for. */
function makeServer() {
  const ctx = {
    get(name) {
      if (name === "llm") {
        return {
          listProviders: () => [{ id: "test-provider" }],
          resolveCallConfig: async () => ({}),
        };
      }
      return undefined;
    },
    on() {
      return () => {};
    },
    agents: { get: () => undefined },
  };
  const transport = {
    notify() {},
    write() {},
    flush: async () => {},
    request: async () => ({}),
  };
  return new PaseoHarnessServer(ctx, transport, {});
}

const executionFor = (sessionId) => ({
  agent: { session: { header: { id: sessionId } } },
});

const agentA = { agentId: "agent-a", agentCwd: "/workspace/a", workspaceId: "wks-a" };
const agentB = { agentId: "agent-b", agentCwd: "/workspace/b", workspaceId: "wks-b" };

console.log("\nper-session identity table (bridge side)\n");
{
  const server = makeServer();
  await server.initialize({ cwd: "/workspace/a", provider: "test-provider", model: "test-model", sessionId: "sess-a", identity: agentA });
  await server.initialize({ cwd: "/workspace/b", provider: "test-provider", model: "test-model", sessionId: "sess-b", identity: agentB });

  const envA = server.identityEnvForExecution(executionFor("sess-a"));
  const envB = server.identityEnvForExecution(executionFor("sess-b"));
  check(
    "two sessions get their own agent id / cwd / workspace id",
    envA.DSH_PASEO_AGENT_ID === "agent-a"
      && envA.DSH_PASEO_AGENT_CWD === "/workspace/a"
      && envA.DSH_PASEO_WORKSPACE_ID === "wks-a"
      && envB.DSH_PASEO_AGENT_ID === "agent-b"
      && envB.DSH_PASEO_AGENT_CWD === "/workspace/b"
      && envB.DSH_PASEO_WORKSPACE_ID === "wks-b",
    `A=${JSON.stringify(envA)} B=${JSON.stringify(envB)}`,
  );
  check(
    "the two sessions' identities are actually different (not a shared row)",
    JSON.stringify(envA) !== JSON.stringify(envB),
    `A=${JSON.stringify(envA)} B=${JSON.stringify(envB)}`,
  );

  const unknown = server.identityEnvForExecution(executionFor("sess-unknown"));
  check(
    "an unknown session resolves to an empty object, not the first session's values",
    Object.keys(unknown).length === 0,
    JSON.stringify(unknown),
  );
  const noAgent = server.identityEnvForExecution({});
  check("an execution with no agent resolves to an empty object", Object.keys(noAgent).length === 0, JSON.stringify(noAgent));

  // A native subagent session is never `initialize`d by the plugin; the parent
  // edge in `children` is the only link back to an identity.
  server.children.set("child-a", { parentId: "sess-a", opened: true, buffered: [] });
  server.children.set("grandchild-a", { parentId: "child-a", opened: true, buffered: [] });
  const childEnv = server.identityEnvForExecution(executionFor("child-a"));
  check(
    "a subagent session inherits its parent's identity",
    JSON.stringify(childEnv) === JSON.stringify(envA),
    JSON.stringify(childEnv),
  );
  const grandchildEnv = server.identityEnvForExecution(executionFor("grandchild-a"));
  check(
    "a nested subagent walks up to the nearest ancestor with a row",
    JSON.stringify(grandchildEnv) === JSON.stringify(envA),
    JSON.stringify(grandchildEnv),
  );
  server.children.set("orphan-child", { parentId: "sess-unknown", opened: true, buffered: [] });
  check(
    "a child of an unknown parent gets nothing (no process default)",
    Object.keys(server.identityEnvForExecution(executionFor("orphan-child"))).length === 0,
    JSON.stringify(server.identityEnvForExecution(executionFor("orphan-child"))),
  );

  // Re-open without identity must clear the old row, exactly like systemPrompt.
  await server.initialize({ cwd: "/workspace/a", provider: "test-provider", model: "test-model", sessionId: "sess-a", identity: undefined });
  check(
    "re-initializing without identity clears the old row",
    Object.keys(server.identityEnvForExecution(executionFor("sess-a"))).length === 0,
    JSON.stringify(server.identityEnvForExecution(executionFor("sess-a"))),
  );
}

{
  const server = makeServer();
  let threw = false;
  try {
    await server.initialize({
      cwd: "/workspace/a",
      provider: "test-provider",
      model: "test-model",
      identity: agentA,
    });
  } catch (error) {
    threw = error instanceof Error && /identity requires sessionId/.test(error.message);
  }
  check("process-level initialize refuses an identity (no session to key it to)", threw);
}

console.log("\nBASH_ENV hook (plugin side)\n");
{
  const scratch = mkdtempSync(join(tmpdir(), "dsh-identity-env-check-"));
  const home = join(scratch, "dsh-home");
  try {
    const script = identityEnv.ensureIdentityBashEnvScript({ DSH_HOME: home });
    check(
      "the hook is written under $DSH_HOME, not /tmp",
      script.startsWith(home) && readFileSync(script, "utf8").includes("DSH_PASEO_AGENT_ID"),
      script,
    );
    check(
      "the hook file is not world-readable",
      (readFileSync(script, "utf8").length > 0) && (require("node:fs").statSync(script).mode & 0o077) === 0,
      `mode=${(require("node:fs").statSync(script).mode & 0o777).toString(8)}`,
    );

    // stdin is /dev/null, not a pipe: bash treats a pipe on fd 0 as an
    // interactive-ish startup and skips BASH_ENV (measured on bash 5.2), while
    // DSH's bash executor starts commands with stdin ignored. Production is the
    // latter; the check must model it.
    const runHook = (env, command) => spawnSync("bash", ["-c", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, BASH_ENV: script, ...env },
    });

    const noIdentity = runHook({}, 'printf "%s|%s|%s" "${PASEO_AGENT_ID-<unset>}" "${PASEO_AGENT_CWD-<unset>}" "${PASEO_WORKSPACE_ID-<unset>}"');
    check(
      "with no DSH_PASEO_* the hook exports NOTHING (unset, not empty)",
      noIdentity.status === 0 && noIdentity.stdout === "<unset>|<unset>|<unset>",
      `status=${String(noIdentity.status)} stdout=${JSON.stringify(noIdentity.stdout)}`,
    );

    const partial = runHook(
      { DSH_PASEO_AGENT_ID: "agent-a" },
      'printf "%s|%s|%s" "${PASEO_AGENT_ID-<unset>}" "${PASEO_AGENT_CWD-<unset>}" "${PASEO_WORKSPACE_ID-<unset>}"',
    );
    check(
      "only the identity fields that are present are exported",
      partial.status === 0 && partial.stdout === "agent-a|<unset>|<unset>",
      `status=${String(partial.status)} stdout=${JSON.stringify(partial.stdout)}`,
    );

    const full = runHook(
      {
        DSH_PASEO_AGENT_ID: "agent-a",
        DSH_PASEO_AGENT_CWD: "/workspace/a",
        DSH_PASEO_WORKSPACE_ID: "wks-a",
      },
      'printf "%s|%s|%s" "$PASEO_AGENT_ID" "$PASEO_AGENT_CWD" "$PASEO_WORKSPACE_ID"',
    );
    check(
      "a full identity maps to the real PASEO_* names",
      full.status === 0 && full.stdout === "agent-a|/workspace/a|wks-a",
      `status=${String(full.status)} stdout=${JSON.stringify(full.stdout)}`,
    );

    // An unrelated failing command must still run: sourcing BASH_ENV must not
    // abort the shell (`set +e` semantics).
    const continues = runHook({}, "false; echo after");
    check(
      "a failed command after the hook still runs (shell not aborted)",
      continues.status === 0 && continues.stdout.trim() === "after",
      `status=${String(continues.status)} stdout=${JSON.stringify(continues.stdout)}`,
    );

    // The user's pre-existing BASH_ENV is sourced last, so its behaviour wins.
    const original = join(scratch, "user-bash-env.sh");
    writeFileSync(original, "export PASEO_ORIGINAL_HOOK=kept\nexport PASEO_AGENT_ID=user-value\n");
    const preserving = identityEnv.ensureIdentityBashEnvScript({ DSH_HOME: home, BASH_ENV: original });
    const preserved = spawnSync("bash", ["-c", 'printf "%s|%s" "$PASEO_ORIGINAL_HOOK" "$PASEO_AGENT_ID"'], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        BASH_ENV: preserving,
        DSH_PASEO_AGENT_ID: "agent-a",
      },
    });
    check(
      "a pre-existing user BASH_ENV is preserved and sourced last",
      preserved.status === 0 && preserved.stdout === "kept|user-value",
      `status=${String(preserved.status)} stdout=${JSON.stringify(preserved.stdout)}`,
    );
    check(
      "two different user BASH_ENV values get two hook files (no write race)",
      preserving !== script,
      `${script} vs ${preserving}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
