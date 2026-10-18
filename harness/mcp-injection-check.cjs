/**
 * Regression: the MCP servers Paseo injects must actually reach DSH.
 *
 * Paseo's plugin-provider contract hands the provider `config.mcpServers` —
 * including its own `paseo` HTTP server, whose URL carries this agent's id —
 * because a plugin provider can never take the native-tools path opencode uses
 * (`supportsNativePaseoTools` is hard-coded `false` for plugins). DSH accepts
 * MCP servers only at boot, through a `--patch` overlay, so the plugin has to
 * turn that map into one. Dropping it — which is what used to happen — left the
 * model with no `mcp__paseo__*` tools and produced no error anywhere.
 *
 * Streamable-HTTP servers are proxied by the bridge's own MCP gateway
 * (`dsh-paseo-bridge/mcp-gateway`): one row for the whole server map, three
 * meta-tools instead of one schema per tool. stdio servers still mount the
 * stock client, and an unsupported transport is still refused by name.
 *
 * This drives the real plugin against a scripted fake `dsh`
 * (`harness/fake-dsh-bridge.mjs`), which records its own launcher arguments and
 * the patch file it was pointed at (`DSH_FAKE_ARGV`). That is the only place the
 * injection is observable: no bridge frame mentions MCP.
 *
 * Compile the plugin first (tsc type errors under `--moduleResolution node` are
 * expected; the emitted JS is what runs):
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/mcp-injection-check.cjs ../harness/fake-dsh-bridge.mjs .dbg/
 *   cd .dbg && node mcp-injection-check.cjs
 *   rm -rf ../.dbg
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fakeBridge = path.join(__dirname, "fake-dsh-bridge.mjs");
fs.chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "live";

const plugin = require("./index.server.js").default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
let registration;

plugin({
  handle() {},
  registerProvider(r) {
    registration = r;
  },
  registerSettings() {},
  on() {},
  before() {},
});

async function until(predicate, label, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** Read a fake-bridge argv record, waiting briefly for the child to write it. */
async function readRecord(file, ms = 5000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        /* still being written */
      }
    }
    await sleep(50);
  }
  return undefined;
}

/** Parse every mounted entry out of a recorded patch file, in patch order. */
function allEntries(record) {
  if (record === undefined || typeof record.patch !== "string") return [];
  try {
    return (JSON.parse(record.patch)?.[0]?.insert ?? []);
  } catch {
    return [];
  }
}

/** Parse the first mounted entry out of a recorded patch file. */
function firstEntry(record) {
  if (record === undefined || typeof record.patch !== "string") return undefined;
  try {
    return JSON.parse(record.patch)?.[0]?.insert?.[0];
  } catch {
    return undefined;
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mcp-check-"));

(async () => {
  const conn = await registration.connect({
    capabilities: ["prompt.message", "session.persistence", "session.list", "permission"],
  });
  conn.onEvent((event) => events.push(event));

  // ---- an HTTP server becomes a --patch overlay --------------------------
  const httpProbe = path.join(scratch, "http.json");
  const httpSession = `mcp-http-${Date.now()}`;
  await conn.send({
    type: "session.open",
    requestId: "open-http",
    sessionId: httpSession,
    config: {
      cwd: process.cwd(),
      mode: "build",
      env: { DSH_FAKE_ARGV: httpProbe },
      mcpServers: {
        paseo: {
          type: "http",
          url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=check",
          headers: { Authorization: "Bearer check-token" },
        },
      },
    },
  });
  await until((e) => e.type === "session.ready" && e.sessionId === httpSession, "http session ready");

  const httpRecord = await readRecord(httpProbe);
  check(
    "an injected MCP server reaches DSH as --patch",
    httpRecord !== undefined && httpRecord.argv.includes("--patch"),
    httpRecord ? `argv=[${httpRecord.argv.join(" ")}]` : "(fake bridge recorded no argv)",
  );

  const httpEntry = firstEntry(httpRecord);
  const gatewayServer = httpEntry?.config?.servers?.paseo;
  check(
    "the http server is proxied by the bridge gateway with its URL and headers",
    httpEntry?.id === "paseo-mcp-gateway" &&
      httpEntry?.name === "dsh-paseo-bridge/mcp-gateway" &&
      gatewayServer?.url === "http://127.0.0.1:6767/mcp/agents?callerAgentId=check" &&
      gatewayServer?.headers?.Authorization === "Bearer check-token",
    httpEntry ? JSON.stringify(httpEntry) : "(no patch content)",
  );
  check(
    "the gateway row declares the tool registry it registers into",
    JSON.stringify(httpEntry?.inject) === JSON.stringify(["tools"]),
    `inject=${JSON.stringify(httpEntry?.inject)}`,
  );

  // ---- a stdio server keeps its command, args and env --------------------
  const stdioProbe = path.join(scratch, "stdio.json");
  const stdioSession = `mcp-stdio-${Date.now()}`;
  await conn.send({
    type: "session.open",
    requestId: "open-stdio",
    sessionId: stdioSession,
    config: {
      cwd: process.cwd(),
      mode: "build",
      env: { DSH_FAKE_ARGV: stdioProbe },
      mcpServers: {
        github: { type: "stdio", command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: "t" } },
      },
    },
  });
  await until((e) => e.type === "session.ready" && e.sessionId === stdioSession, "stdio session ready");
  const stdioEntry = firstEntry(await readRecord(stdioProbe));
  check(
    "a stdio server keeps its command, args and env",
    stdioEntry?.config?.transport === "stdio" &&
      stdioEntry?.config?.command === "npx" &&
      JSON.stringify(stdioEntry?.config?.args) === JSON.stringify(["-y", "server-github"]) &&
      stdioEntry?.config?.env?.GITHUB_TOKEN === "t",
    stdioEntry ? JSON.stringify(stdioEntry.config) : "(no patch content)",
  );

  // ---- a mixed session keeps stdio native and coalesces HTTP into one row ----
  const mixedProbe = path.join(scratch, "mixed.json");
  const mixedSession = `mcp-mixed-${Date.now()}`;
  await conn.send({
    type: "session.open",
    requestId: "open-mixed",
    sessionId: mixedSession,
    config: {
      cwd: process.cwd(),
      mode: "build",
      env: { DSH_FAKE_ARGV: mixedProbe },
      mcpServers: {
        paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=mixed" },
        github: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
      },
    },
  });
  await until((e) => e.type === "session.ready" && e.sessionId === mixedSession, "mixed session ready");
  const mixedEntries = allEntries(await readRecord(mixedProbe));
  const mixedGateway = mixedEntries.find((entry) => entry?.id === "paseo-mcp-gateway");
  const mixedStdio = mixedEntries.find((entry) => entry?.config?.transport === "stdio");
  check(
    "a mixed session mounts stdio natively and proxies HTTP through one gateway row",
    mixedEntries.length === 2 &&
      Object.keys(mixedGateway?.config?.servers ?? {}).join(",") === "paseo" &&
      mixedStdio?.config?.command === "npx" &&
      mixedGateway?.config?.servers?.github === undefined,
    `entries=${JSON.stringify(mixedEntries.map((entry) => entry?.id ?? entry?.config?.serverName))}`,
  );

  // ---- no servers means no overlay --------------------------------------
  const noneProbe = path.join(scratch, "none.json");
  const noneSession = `mcp-none-${Date.now()}`;
  await conn.send({
    type: "session.open",
    requestId: "open-none",
    sessionId: noneSession,
    config: { cwd: process.cwd(), mode: "build", env: { DSH_FAKE_ARGV: noneProbe } },
  });
  await until((e) => e.type === "session.ready" && e.sessionId === noneSession, "no-mcp session ready");
  const noneRecord = await readRecord(noneProbe);
  check(
    "a session without MCP servers spawns without --patch",
    noneRecord !== undefined && !noneRecord.argv.includes("--patch"),
    noneRecord ? `argv=[${noneRecord.argv.join(" ")}]` : "(fake bridge recorded no argv)",
  );

  // ---- an SSE server is refused by name, not silently dropped -----------
  const sseProbe = path.join(scratch, "sse.json");
  const sseSession = `mcp-sse-${Date.now()}`;
  await conn.send({
    type: "session.open",
    requestId: "open-sse",
    sessionId: sseSession,
    config: {
      cwd: process.cwd(),
      mode: "build",
      env: { DSH_FAKE_ARGV: sseProbe },
      mcpServers: { legacy: { type: "sse", url: "http://127.0.0.1:9999/sse" } },
    },
  });
  const sseFailure = await until(
    (e) => e.type === "request.failed" && e.requestId === "open-sse",
    "sse request.failed",
  );
  check(
    "an unsupported sse server fails loudly and names the server",
    /legacy/.test(sseFailure.error?.message ?? "") && /sse/i.test(sseFailure.error?.message ?? ""),
    sseFailure.error?.message,
  );
  await sleep(300);
  check(
    "a refused server never spawns a DSH process",
    !fs.existsSync(sseProbe),
    fs.existsSync(sseProbe) ? "a process was spawned anyway" : "no process spawned",
  );

  // ---- the overlay lives exactly as long as the process ------------------
  // An idle session is *parked* on close (the rewind refresh reuses the child),
  // so `session.close` alone must not remove the overlay: the process is still
  // alive. Provider teardown shuts the parked child down for real, and only then
  // may the patch file disappear.
  await conn.send({ type: "session.close", sessionId: httpSession, requestId: "close-http" });
  await until((e) => e.type === "session.closed" && e.sessionId === httpSession, "http session closed");
  await sleep(300);
  check(
    "an idle session keeps its process (and its overlay) after session.close",
    httpRecord?.patchPath !== undefined && fs.existsSync(httpRecord.patchPath),
    httpRecord?.patchPath ?? "(no patch path recorded)",
  );

  await conn.close();
  let patchRemoved = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (httpRecord?.patchPath === undefined || !fs.existsSync(httpRecord.patchPath)) {
      patchRemoved = true;
      break;
    }
    await sleep(50);
  }
  check(
    "provider teardown removes the patch file with its process",
    httpRecord?.patchPath !== undefined && patchRemoved,
    httpRecord?.patchPath ?? "(no patch path recorded)",
  );
  fs.rmSync(scratch, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(1);
});
