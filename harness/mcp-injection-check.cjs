/**
 * Regression: the MCP servers Paseo injects must actually reach DSH.
 *
 * Paseo's plugin-provider contract hands the provider `config.mcpServers` —
 * including its own `paseo` HTTP server, whose URL carries this agent's id —
 * because a plugin provider can never take the native-tools path opencode uses
 * (`supportsNativePaseoTools` is hard-coded `false` for plugins). Dropping it
 * leaves the model with no `mcp__paseo__*` tools and produces no error anywhere.
 *
 * **The channel changed with one-process-multi-session.** It used to be a
 * process-wide `--patch` file written at spawn (`prepareMcpPatch`), because DSH
 * accepted MCP servers only at boot. Now several sessions share one `dsh` child,
 * so a process-wide overlay cannot express "this session's servers": the plugin
 * sends a **per-session `paseo/mcp/set { sessionId, entries }`** frame instead,
 * and the bridge mounts them at that session's agent scope
 * (`docs/IMPL-CONTRACT.md` §1.5).
 *
 * So the observable is no longer argv. It is the frame the fake `dsh` records in
 * `DSH_FAKE_LOG`. The shapes below were **dumped from a real run**, not guessed:
 *
 *   entries: [
 *     { name: "@deepseek-ai/dsh-mcp-client",         // a native stdio mount
 *       config: { serverName, transport: "stdio", command, args, env,
 *                 failOnStartupError: true } },
 *     { name: "./mcp-gateway.js",                    // the gateway row
 *       config: { servers: { <name>: { url, headers } | { command, args, env } } } },
 *   ]
 *
 * Note `name` (a module specifier), **not** `id`/`inject` — the patch form had
 * those, the frame form does not. An assertion on `id === "paseo-mcp-gateway"` or
 * `inject === ["tools"]` would be asserting a shape that no longer exists. The
 * gateway module registers its three meta-tools when it activates, so the
 * registry is implied by the row's presence rather than by a field.
 *
 * One environmental hazard: `browserMcpServer()` adds `server_browser` by
 * reading `~/.local/share/paseo-server-browser` — this machine's real browser
 * plugin. Left alone it injects a server the test never asked for, which would
 * make every assertion depend on the developer's machine (and did: an unisolated
 * run showed `server_browser` in a session that configured nothing).
 * `PASEO_SERVER_BROWSER_DATA` points at a throwaway directory so that row is
 * absent, and the whitelist cases supply their own entry explicitly.
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

// Never touch the user's live profile: loading the plugin calls
// `ensurePaseoProfile()`, which rewrites `$DSH_HOME/profiles/<name>/
// node_modules/dsh-paseo-bridge` from the bridge embedded in the plugin. The
// fake `dsh` needs no profile, so point DSH_HOME at a throwaway tree.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mcp-check-"));

// Keep this machine's Server Browser plugin out of the picture: the provider adds
// `server_browser` whenever it can find the browser plugin's data directory, and
// a machine-dependent extra entry would make every count below unstable.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mcp-check-"));
process.env.PASEO_SERVER_BROWSER_DATA = path.join(scratch, "no-browser-plugin");

// The fake bridge appends every frame it receives (method + params + pid) to
// `DSH_FAKE_LOG`. That is now the only place the injection is observable: no argv
// carries it, and the bridge answers the frame without echoing it back.
const frameLog = path.join(scratch, "frames.jsonl");
process.env.DSH_FAKE_LOG = frameLog;

process.on("exit", () => {
  for (const dir of [process.env.DSH_HOME, scratch]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

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

/** Every frame the fake bridge has recorded so far. */
function frames() {
  if (!fs.existsSync(frameLog)) return [];
  return fs
    .readFileSync(frameLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * The `paseo/mcp/set` frames recorded for one session, in arrival order.
 *
 * A session may get more than one (a reopen re-sends it), so callers read the
 * last one — that is the one the bridge will mount.
 */
function mcpFramesFor(sessionId) {
  return frames().filter(
    (frame) => frame.method === "paseo/mcp/set" && frame.params?.sessionId === sessionId,
  );
}

/** The entries of the last `paseo/mcp/set` sent for a session. */
function entriesFor(sessionId) {
  return mcpFramesFor(sessionId).at(-1)?.params?.entries ?? [];
}

const GATEWAY_MODULE = "./mcp-gateway.js";
const NATIVE_MODULE = "@deepseek-ai/dsh-mcp-client";
/** The gateway row among some entries (the module specifier is the discriminator). */
function gatewayEntry(entries) {
  return entries.find((entry) => entry?.name === GATEWAY_MODULE);
}
/** The native stdio rows among some entries. */
function nativeEntries(entries) {
  return entries.filter((entry) => entry?.name === NATIVE_MODULE);
}
/** The servers map the gateway row carries. */
function gatewayServers(entries) {
  return gatewayEntry(entries)?.config?.servers ?? {};
}

(async () => {
  const conn = await registration.connect({
    capabilities: ["prompt.message", "session.persistence", "session.list", "permission"],
  });
  conn.onEvent((event) => events.push(event));

  /** Open a session with these MCP servers and resolve with its frame's entries. */
  async function open(sessionId, mcpServers) {
    await conn.send({
      type: "session.open",
      requestId: `open-${sessionId}`,
      sessionId,
      config: {
        cwd: process.cwd(),
        mode: "build",
        ...(mcpServers === undefined ? {} : { mcpServers }),
      },
    });
    await until((e) => e.type === "session.ready" && e.sessionId === sessionId, `${sessionId} ready`);
    // The frame is sent during the open, but the fake bridge appends it
    // asynchronously; give the write a moment before reading the log.
    await sleep(150);
    return entriesFor(sessionId);
  }

  // ---- an HTTP server becomes a gateway row ------------------------------
  const httpSession = `mcp-http-${Date.now()}`;
  const httpEntries = await open(httpSession, {
    paseo: {
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=check",
      headers: { Authorization: "Bearer check-token" },
    },
  });
  check(
    "an injected MCP server reaches DSH as a per-session paseo/mcp/set frame",
    mcpFramesFor(httpSession).length >= 1,
    `${String(mcpFramesFor(httpSession).length)} frame(s) for ${httpSession}`,
  );
  const httpGateway = gatewayEntry(httpEntries);
  const httpServer = gatewayServers(httpEntries).paseo;
  check(
    "the http server is proxied by the bridge gateway with its URL and headers",
    httpGateway !== undefined &&
      httpServer?.url === "http://127.0.0.1:6767/mcp/agents?callerAgentId=check" &&
      httpServer?.headers?.Authorization === "Bearer check-token",
    JSON.stringify(httpGateway ?? null),
  );
  check(
    "and the http server is not also mounted natively",
    nativeEntries(httpEntries).length === 0 &&
      !httpEntries.some((entry) => entry?.config?.transport === "stdio"),
    JSON.stringify(httpEntries.map((entry) => entry?.name)),
  );

  // ---- a stdio server keeps its command, args and env --------------------
  const stdioSession = `mcp-stdio-${Date.now()}`;
  const stdioEntries = await open(stdioSession, {
    github: {
      type: "stdio",
      command: "npx",
      args: ["-y", "server-github"],
      env: { GITHUB_TOKEN: "t" },
    },
  });
  const stdioNative = nativeEntries(stdioEntries);
  check(
    "a stdio server keeps its command, args and env",
    stdioNative.length === 1 &&
      stdioNative[0]?.config?.transport === "stdio" &&
      stdioNative[0]?.config?.serverName === "github" &&
      stdioNative[0]?.config?.command === "npx" &&
      JSON.stringify(stdioNative[0]?.config?.args) === JSON.stringify(["-y", "server-github"]) &&
      stdioNative[0]?.config?.env?.GITHUB_TOKEN === "t",
    JSON.stringify(stdioNative[0]?.config ?? null),
  );
  check(
    "and a non-whitelisted stdio server gets no gateway row",
    gatewayEntry(stdioEntries) === undefined,
    JSON.stringify(stdioEntries.map((entry) => entry?.name)),
  );

  // ---- a whitelisted stdio server is proxied by the gateway --------------
  // Proxying is a capability trade (the tools become reachable only through the
  // three meta-tools), so it is opt-in by name rather than applied to every
  // stdio server. `server_browser` is the only entry today: its bridge is wide
  // (25 tools, ~20 KB of schema in every request) and rarely called.
  const browserSession = `mcp-browser-${Date.now()}`;
  const browserEntries = await open(browserSession, {
    server_browser: {
      type: "stdio",
      command: process.execPath,
      args: ["/x/mcp-bridge.mjs", "/x/session.json"],
      env: { PASEO_SERVER_BROWSER_RUNTIME: "/x/runtime" },
    },
  });
  const browserServers = gatewayServers(browserEntries);
  const browserServer = browserServers.server_browser;
  check(
    "a whitelisted stdio server is proxied by the gateway, not mounted natively",
    Object.keys(browserServers).join(",") === "server_browser" &&
      nativeEntries(browserEntries).length === 0 &&
      browserServer?.command === process.execPath &&
      JSON.stringify(browserServer?.args) === JSON.stringify(["/x/mcp-bridge.mjs", "/x/session.json"]),
    `gateway servers=[${Object.keys(browserServers).join(",")}] native=${String(nativeEntries(browserEntries).length)}`,
  );
  check(
    "a proxied stdio server keeps its env",
    browserServer?.env?.PASEO_SERVER_BROWSER_RUNTIME === "/x/runtime",
    `env=${JSON.stringify(browserServer?.env)}`,
  );

  // ---- a mixed session keeps stdio native and coalesces HTTP into one row ----
  const mixedSession = `mcp-mixed-${Date.now()}`;
  const mixedEntries = await open(mixedSession, {
    paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=mixed" },
    github: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
  });
  const mixedServers = gatewayServers(mixedEntries);
  const mixedNative = nativeEntries(mixedEntries);
  check(
    "a mixed session mounts stdio natively and proxies HTTP through one gateway row",
    Object.keys(mixedServers).join(",") === "paseo" &&
      mixedNative.length === 1 &&
      mixedNative[0]?.config?.serverName === "github" &&
      mixedServers.github === undefined,
    `gateway=[${Object.keys(mixedServers).join(",")}] native=[${mixedNative.map((entry) => entry?.config?.serverName).join(",")}]`,
  );

  // ---- all three at once: HTTP + whitelisted stdio + user stdio ----------
  // The three-way case is where a whitelist regression hides: a change that
  // proxies every stdio server still passes the single-server cases above (the
  // whitelisted one looks right) and still passes the mixed two-way case (no
  // user stdio next to a proxy candidate). Here both must hold simultaneously —
  // the **bidirectional** whitelist assertion `docs/` asks for: the named server
  // is proxied *and* the unnamed one is not.
  const tripleSession = `mcp-triple-${Date.now()}`;
  const tripleEntries = await open(tripleSession, {
    paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=triple" },
    server_browser: { type: "stdio", command: "node", args: ["/x/mcp-bridge.mjs", "/x/session.json"] },
    github: {
      type: "stdio",
      command: "npx",
      args: ["-y", "server-github"],
      env: { GITHUB_TOKEN: "t" },
    },
  });
  const tripleServers = Object.keys(gatewayServers(tripleEntries));
  const tripleNative = nativeEntries(tripleEntries);
  check(
    "http and whitelisted stdio share one gateway row while user stdio stays native",
    tripleServers.sort().join(",") === "paseo,server_browser" &&
      tripleNative.length === 1 &&
      tripleNative[0]?.config?.serverName === "github" &&
      tripleNative[0]?.config?.command === "npx",
    `proxied=[${tripleServers.join(",")}] native=[${tripleNative.map((entry) => entry?.config?.serverName).join(",")}]`,
  );

  // ---- no servers still sends an empty list -----------------------------
  // An empty `entries` is not "nothing to do": it is how the bridge is told this
  // session has none, so a re-attach that dropped servers cannot inherit the
  // previous ones. The old `--patch` form expressed this by writing no file; the
  // frame form must send the frame.
  const noneSession = `mcp-none-${Date.now()}`;
  const noneEntries = await open(noneSession, undefined);
  check(
    "a session without MCP servers still sends paseo/mcp/set with an empty list",
    mcpFramesFor(noneSession).length >= 1 && noneEntries.length === 0,
    `${String(mcpFramesFor(noneSession).length)} frame(s), entries=${JSON.stringify(noneEntries)}`,
  );

  // ---- an SSE server is refused by name, not silently dropped -----------
  //
  // The assertion that used to live here was `mcpFramesFor(sseSession).length === 0`:
  // a session refused at open can never emit `paseo/mcp/set`, so it was true by
  // construction and could not fail. The real risk is the **process**: `open()`
  // calls `acquireProcess()` (`paseo-plugin/server/session.ts:444`) before
  // `attachSession` validates the MCP entries (`paseo-plugin/server/dsh-process.ts:786`),
  // so a refused server can spawn a `dsh` child and only then be rejected. The
  // observable is therefore the frame log's **pid**, and its `initialize` frame —
  // the only proof that a new child process ran.
  //
  // Measured (and it is why this block is written the way it is): with a *cold*
  // pool the refused open does spawn a child (`initialize` from a new pid) and the
  // provider retires it ~4 s later; with the **warm** pool this script has by now
  // (six sessions already opened on this connection), no new pid appears at all.
  // Both facts are pinned below: no new child, and — as the guard that keeps the
  // first assertion honest — the child that serves every other session is still
  // exactly the one pid that was already there.
  const pidsBeforeSse = new Set(frames().map((frame) => frame.pid));
  const initializesBeforeSse = frames().filter((frame) => frame.method === "initialize").length;
  const sseSession = `mcp-sse-${Date.now()}`;
  await conn.send({
    type: "session.open",
    requestId: `open-${sseSession}`,
    sessionId: sseSession,
    config: {
      cwd: process.cwd(),
      mode: "build",
      mcpServers: { legacy: { type: "sse", url: "http://127.0.0.1:9999/sse" } },
    },
  });
  const sseFailure = await until(
    (e) => e.type === "request.failed" && e.requestId === `open-${sseSession}`,
    "sse request.failed",
  );
  check(
    "an unsupported sse server fails loudly and names the server",
    /legacy/.test(sseFailure.error?.message ?? "") && /sse/i.test(sseFailure.error?.message ?? ""),
    sseFailure.error?.message,
  );
  await sleep(800);
  const framesAfterSse = frames();
  const newPids = [...new Set(framesAfterSse.map((frame) => frame.pid))]
    .filter((pid) => !pidsBeforeSse.has(pid));
  const newInitializes = framesAfterSse.filter(
    (frame) => frame.method === "initialize" && !pidsBeforeSse.has(frame.pid),
  );
  check(
    "a refused server spawns no DSH child process",
    newPids.length === 0 && newInitializes.length === 0,
    newPids.length === 0
      ? `no new pid (${String(pidsBeforeSse.size)} child process(es) unchanged, ${String(framesAfterSse.filter((f) => f.method === "initialize").length - initializesBeforeSse)} new initialize frame(s))`
      : `new pids [${newPids.join(",")}] — ${newInitializes.map((frame) => `initialize#${frame.pid}`).join(",") || "no initialize"}`,
  );
  // The positive half: the warm child this script has been using must still be
  // the only session carrier. A refused open that silently replaced or retired it
  // would be invisible to the assertion above.
  const carriersAfterSse = [...new Set(
    framesAfterSse
      .filter((frame) => frame.method === "initialize" || frame.method === "session/prompt")
      .map((frame) => frame.pid),
  )];
  check(
    "…and every session still runs on the one child it started with",
    carriersAfterSse.length === 1 && pidsBeforeSse.has(carriersAfterSse[0]),
    `carrier pids [${carriersAfterSse.join(",")}], before [${[...pidsBeforeSse].join(",")}]`,
  );
  check(
    "…and the refused session emitted no mcp frame of its own",
    mcpFramesFor(sseSession).length === 0,
    `${String(mcpFramesFor(sseSession).length)} frame(s) for the refused session`,
  );
  // The pool-state-independent half of the claim. The pid assertion above only
  // fires while the pool is cold; this one fires in either state, because it asks
  // whether the child was ever made to *serve* the refused session. `attachSession`
  // performs the MCP validation after `start()` and before
  // `#ensureSessionReady` (`dsh-process.ts:779-790`), so a reordering that
  // initialized the session before rejecting it would show up as an `initialize`
  // (or any session-scoped frame) naming the refused id.
  const framesForRefusedSession = frames().filter(
    (frame) => frame.params?.sessionId === sseSession,
  );
  const servingFrames = framesForRefusedSession.filter(
    (frame) => frame.method === "initialize" || frame.method === "paseo/mcp/set" || frame.method === "session/prompt",
  );
  check(
    "…and no child was ever initialized for the refused session",
    servingFrames.length === 0,
    servingFrames.length === 0
      ? `0 serving frame(s) (frames naming the session: ${String(framesForRefusedSession.length)} — ${framesForRefusedSession.map((frame) => frame.method).join(",") || "none"})`
      : servingFrames.map((frame) => `${frame.method}#${frame.pid}`).join(","),
  );

  // ---- the frame is per-session state, so a reopen re-sends it ----------
  // The bridge consumes the queue when the session's agent is created, and a
  // reopen creates a new agent. The old `--patch` equivalent was "the patch file
  // outlives the close"; there is no file now, so the claim is that the frame is
  // re-sent for the reopened session.
  const reopenSession = httpSession;
  const beforeClose = mcpFramesFor(reopenSession).length;
  await conn.send({ type: "session.close", sessionId: reopenSession, requestId: "close-http" });
  await until((e) => e.type === "session.closed" && e.sessionId === reopenSession, "http session closed");
  await sleep(300);
  check(
    "closing an idle session sends no extra frame (a close is not a re-attach)",
    mcpFramesFor(reopenSession).length === beforeClose,
    `${String(beforeClose)} -> ${String(mcpFramesFor(reopenSession).length)}`,
  );
  await conn.send({
    type: "session.open",
    requestId: "reopen-http",
    sessionId: reopenSession,
    config: {
      cwd: process.cwd(),
      mode: "build",
      mcpServers: {
        paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=check" },
      },
    },
    persistence: { version: 1, data: { sessionId: reopenSession } },
    history: "skip",
  });
  await until((e) => e.type === "session.ready" && e.sessionId === reopenSession, "http session reopened");
  await sleep(250);
  const reopenedEntries = entriesFor(reopenSession);
  check(
    "a reopen re-sends paseo/mcp/set for that session",
    mcpFramesFor(reopenSession).length > beforeClose &&
      gatewayServers(reopenedEntries).paseo?.url === "http://127.0.0.1:6767/mcp/agents?callerAgentId=check",
    `${String(beforeClose)} -> ${String(mcpFramesFor(reopenSession).length)} frame(s)`,
  );

  // ---- every session's frame went to the one shared child ----------------
  // This is what makes the per-session frame necessary in the first place, and it
  // replaces the old "teardown removes the patch file": there is no file, and the
  // child is the only footprint. Two pids here would mean the plugin still spawns
  // a process per session, in which case a process-wide overlay would have been
  // sufficient and this whole path would be pointless.
  const injectedPids = new Set(
    frames()
      .filter((frame) => frame.method === "paseo/mcp/set")
      .map((frame) => frame.pid),
  );
  check(
    "every session's MCP frame went to one shared child",
    injectedPids.size === 1,
    `pids ${[...injectedPids].join(", ") || "(none)"}`,
  );

  await conn.close();

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(2);
});
