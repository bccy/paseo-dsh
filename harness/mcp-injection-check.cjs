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

// The scenario has to be switchable **after** the child is spawned, and a spawned
// child's environment is frozen. That is not a detail of this script: the plugin
// keeps ONE shared `dsh` child for the whole connection, so by the time the
// `mcp-late` case below runs, the child has been alive for a dozen opens and
// `process.env.DSH_FAKE_MODE = ...` cannot reach it. Measured: setting the env var
// alone left the child in `live`, the `mcp/set` frame was accepted, and the session
// reported ready — the assertion failed for a reason that had nothing to do with
// the plugin.
//
// `DSH_FAKE_MODE_FILE` is the fake bridge's escape hatch: it re-reads the mode from
// this file on every access, so writing it retargets the running child. The env var
// stays set for the case where a *new* child is spawned (a fresh connection), and
// both channels are kept in agreement by `setMode` below.
const MODE_FILE = path.join(scratch, "fake-dsh-mode");
process.env.DSH_FAKE_MODE_FILE = MODE_FILE;
fs.writeFileSync(MODE_FILE, "live\n");

/** Point the long-lived fake child at a new scenario, on both channels. */
function setMode(value) {
  process.env.DSH_FAKE_MODE = value;
  fs.writeFileSync(MODE_FILE, `${value}\n`);
}

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

  // ---- COLD POOL: a refused open must not spawn a child first -------------
  //
  // This has to run **first**, before any session opens: the claim is that a
  // refused open never spawns, and once one session has been opened the pool is
  // warm and `acquireProcess()` reuses the existing child — so no spawn happens
  // for *any* reason and the assertion passes without testing anything. That is
  // exactly how the previous version of this block was written (it sat after six
  // opens and pinned `newPids.length === 0` on a warm pool), which is why it could
  // never fail.
  //
  // The observable is `initialize`: `DshProcess.start()` sends it, and nothing
  // else does — the catalog/list probes are built with `initializeRoute: false`
  // precisely so they never pin a route, so their pids appear in the frame log
  // without an `initialize`. A zero count here therefore means no session-carrying
  // child was ever started.
  {
    const pidsBefore = new Set(frames().map((frame) => frame.pid));
    const coldSession = `mcp-cold-${Date.now()}`;
    await conn.send({
      type: "session.open",
      requestId: `open-${coldSession}`,
      sessionId: coldSession,
      config: {
        cwd: process.cwd(),
        mode: "build",
        mcpServers: { legacy: { type: "sse", url: "http://127.0.0.1:9999/sse" } },
      },
    });
    const coldFailure = await until(
      (e) => e.type === "request.failed" && e.requestId === `open-${coldSession}`,
      "cold-pool sse request.failed",
    );
    await sleep(600);
    const after = frames();
    const coldInitializes = after.filter((frame) => frame.method === "initialize");
    const coldCarriers = [...new Set(
      after
        .filter((frame) => frame.method === "initialize" || frame.method === "session/prompt")
        .map((frame) => frame.pid),
    )];
    check(
      "a refused open on a COLD pool fails loudly and names the server",
      /legacy/.test(coldFailure.error?.message ?? "") && /sse/i.test(coldFailure.error?.message ?? ""),
      coldFailure.error?.message,
    );
    check(
      "…without spawning a DSH child first (cold pool)",
      coldInitializes.length === 0 && coldCarriers.length === 0,
      `${String(coldInitializes.length)} initialize frame(s), carrier pids [${coldCarriers.join(",")}], `
        + `${String([...new Set(after.map((frame) => frame.pid))].filter((pid) => !pidsBefore.has(pid)).length)} new pid(s) (probes only)`,
    );
    check(
      "…and the refused session emitted no mcp frame of its own",
      mcpFramesFor(coldSession).length === 0,
      `${String(mcpFramesFor(coldSession).length)} frame(s)`,
    );
    // The positive control for the observation itself: the next open *does* start a
    // child, so "zero initialize frames" above cannot be "this script never sees
    // initialize frames at all".
    const controlSession = `mcp-cold-control-${Date.now()}`;
    await open(controlSession, { github: { type: "stdio", command: "npx", args: ["-y", "server-github"] } });
    const warmInitializes = frames().filter((frame) => frame.method === "initialize");
    check(
      "…while the next accepted open does start one (positive control)",
      warmInitializes.length > 0 && coldInitializes.length === 0,
      `${String(warmInitializes.length)} initialize frame(s) after the accepted open`,
    );
  }

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

  // ---- a USER's stdio server named `server_browser` stays native ----------
  //
  // This is the reverse of what this block used to assert, and the reversal is
  // the fix. The whitelist exists for **this plugin's own** browser bridge: it is
  // wide (25 tools, ~20 KB of schema in every request) and rarely called, so
  // proxying it trades a capability nobody misses for a schema nobody wants. None
  // of that reasoning applies to a server a user configured, and the old check
  // keyed on the name alone — so a user's own `server_browser` (a real case:
  // `command: npx, args: ["-y", "@playwright/mcp@latest"]`) was silently proxied,
  // demoting its full tool surface to three-step discovery. The provenance is the
  // discriminator now, and this is the assertion that pins it.
  const userBrowserSession = `mcp-user-browser-${Date.now()}`;
  const userBrowserEntries = await open(userBrowserSession, {
    server_browser: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      env: { PASEO_SERVER_BROWSER_RUNTIME: "/x/runtime" },
    },
  });
  const userBrowserNative = nativeEntries(userBrowserEntries);
  check(
    "a USER's stdio server named server_browser is mounted natively, not proxied",
    gatewayEntry(userBrowserEntries) === undefined &&
      userBrowserNative.length === 1 &&
      userBrowserNative[0]?.config?.serverName === "server_browser" &&
      userBrowserNative[0]?.config?.command === "npx" &&
      JSON.stringify(userBrowserNative[0]?.config?.args) === JSON.stringify(["-y", "@playwright/mcp@latest"]),
    `gateway=${JSON.stringify(Object.keys(gatewayServers(userBrowserEntries)))} `
      + `native=${JSON.stringify(userBrowserNative.map((entry) => entry?.config?.serverName))}`,
  );
  check(
    "…and it keeps its env",
    userBrowserNative[0]?.config?.env?.PASEO_SERVER_BROWSER_RUNTIME === "/x/runtime",
    `env=${JSON.stringify(userBrowserNative[0]?.config?.env)}`,
  );

  // ---- the plugin's OWN browser bridge is still proxied ------------------
  //
  // The positive half, and the one that keeps the fix from over-shooting: with a
  // real bridge on disk, `browserMcpServer()` injects `server_browser` itself and
  // that entry must go to the gateway exactly as before. Built by materializing
  // the three things it looks for — the bridge script, a Paseo workspace registry
  // that maps this cwd to one live workspace, and the workspace's data directory —
  // so this exercises the real resolution rather than a stubbed answer.
  const browserTree = path.join(scratch, "browser-plugin");
  const browserHome = path.join(scratch, "browser-paseo-home");
  const workspaceId = "ws-check-1";
  fs.mkdirSync(path.join(browserTree, workspaceId), { recursive: true });
  fs.writeFileSync(path.join(browserTree, "mcp-bridge.mjs"), "// stand-in bridge\n");
  fs.mkdirSync(path.join(browserHome, "projects"), { recursive: true });
  fs.writeFileSync(
    path.join(browserHome, "projects", "workspaces.json"),
    JSON.stringify([{ workspaceId, cwd: process.cwd(), archivedAt: null }]),
  );
  const savedBrowserEnv = {
    data: process.env.PASEO_SERVER_BROWSER_DATA,
    home: process.env.PASEO_HOME,
  };
  process.env.PASEO_SERVER_BROWSER_DATA = browserTree;
  process.env.PASEO_HOME = browserHome;
  let ownBrowserEntries;
  try {
    ownBrowserEntries = await open(`mcp-own-browser-${Date.now()}`, undefined);
  } finally {
    if (savedBrowserEnv.data === undefined) delete process.env.PASEO_SERVER_BROWSER_DATA;
    else process.env.PASEO_SERVER_BROWSER_DATA = savedBrowserEnv.data;
    if (savedBrowserEnv.home === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = savedBrowserEnv.home;
  }
  const ownBrowserServers = gatewayServers(ownBrowserEntries);
  const ownBrowserServer = ownBrowserServers.server_browser;
  check(
    "the plugin's own injected browser bridge is still proxied by the gateway",
    Object.keys(ownBrowserServers).join(",") === "server_browser" &&
      nativeEntries(ownBrowserEntries).length === 0 &&
      ownBrowserServer?.command === process.execPath &&
      Array.isArray(ownBrowserServer?.args) &&
      String(ownBrowserServer.args[0]).endsWith("mcp-bridge.mjs"),
    `gateway=[${Object.keys(ownBrowserServers).join(",")}] `
      + `native=${String(nativeEntries(ownBrowserEntries).length)} `
      + `args=${JSON.stringify(ownBrowserServer?.args ?? null)}`,
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
  const tripleNativeNames = tripleNative.map((entry) => entry?.config?.serverName).sort();
  // Both user stdio servers stay native — including the one whose name happens to
  // be on the whitelist, because it did not come from `browserMcpServer()`. Only
  // the HTTP server is proxied. This is the bidirectional form: "the named one is
  // proxied *because it is ours*" and "an identically named one that is not ours
  // is not" have to hold at the same time, which neither single-server case can
  // show.
  check(
    "HTTP is proxied while BOTH user stdio servers — including the whitelisted name — stay native",
    tripleServers.sort().join(",") === "paseo" &&
      tripleNativeNames.join(",") === "github,server_browser",
    `proxied=[${tripleServers.join(",")}] native=[${tripleNativeNames.join(",")}]`,
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
  // construction and could not fail.
  //
  // The **spawn** half of this claim now lives in the cold-pool block at the top of
  // this file, and that is the only place it can live: `open()` calls
  // `acquireProcess()` (`paseo-plugin/server/session.ts`) before `attachSession`
  // validates the MCP entries, so a refused open *used to* spawn a `dsh` child and
  // reject it afterwards. Measured before the fix: cold pool → `initialize` from a
  // new pid, child retired ~4 s later; warm pool (six sessions already open) → no
  // new pid, because `acquireProcess()` reuses the existing child. The old
  // assertion here was written against the warm pool, so it held for *any*
  // implementation — including the one it claimed to guard against. The provider
  // now validates the entries before acquiring, which is what the cold-pool case
  // pins.
  //
  // What remains here is the half that holds in either pool state: the refused
  // session never reached the child, and the child serving every other session is
  // still exactly the one pid that was already there.
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

  // ---- a dotted name is fine for the gateway, refused for a native mount ---
  //
  // `MCP_SERVER_NAME` (`^[A-Za-z0-9_-]{1,32}$`) is DSH's tool-name namespace rule,
  // and it only applies where DSH actually builds a tool namespace — the native
  // `dsh-mcp-client` path, whose tools are `mcp__<serverName>__<tool>`. A server on
  // the gateway never becomes a namespace (its tools are addressed by string
  // through `mcp_call_tool`), and the gateway's own `Config` is a dict that accepts
  // any key. Applying the rule to everything meant a user with `com.acme.tools`
  // configured as HTTP could not open the session **at all** — the throw happens
  // during `attachSession`, so Paseo's own 61 tools were lost too.
  const dotHttpSession = `mcp-dot-http-${Date.now()}`;
  const dotHttpEntries = await open(dotHttpSession, {
    "com.acme.tools": { type: "http", url: "http://127.0.0.1:6767/mcp" },
  });
  check(
    "a dotted name is accepted for an HTTP server and reaches the gateway",
    gatewayServers(dotHttpEntries)["com.acme.tools"]?.url === "http://127.0.0.1:6767/mcp",
    JSON.stringify(gatewayServers(dotHttpEntries)),
  );
  // The other half, and the reason the rule was not simply deleted: a dotted name
  // still cannot be a native tool namespace. Refused by name, at open.
  const dotStdioSession = `mcp-dot-stdio-${Date.now()}`;
  await conn.send({
    type: "session.open",
    requestId: `open-${dotStdioSession}`,
    sessionId: dotStdioSession,
    config: {
      cwd: process.cwd(),
      mode: "build",
      mcpServers: { "com.acme.tools": { type: "stdio", command: "npx", args: ["-y", "server-github"] } },
    },
  });
  const dotStdioFailure = await until(
    (e) => e.type === "request.failed" && e.requestId === `open-${dotStdioSession}`,
    "dotted stdio request.failed",
  );
  check(
    "…but the same dotted name is still refused for a native stdio mount, by name",
    /com\.acme\.tools/.test(dotStdioFailure.error?.message ?? "")
      && /serverName/i.test(dotStdioFailure.error?.message ?? ""),
    dotStdioFailure.error?.message,
  );

  // ---- an unknown transport type is refused, and never echoes credentials ---
  //
  // `type` used to be the fall-through default: anything that was not `stdio` or
  // `sse` was proxied as Streamable HTTP. So `type: "htpp"` opened the session
  // successfully and the failure surfaced at the first tool call, where the
  // gateway's own `Config` error quoted the entry — `headers` and all. These three
  // cases pin the refusal, the naming, and the absence of a leak.
  for (const [label, server] of [
    ["a misspelled type", { type: "htpp", url: "http://127.0.0.1:7000/mcp" }],
    ["a missing type", { url: "http://127.0.0.1:7000/mcp" }],
    [
      "a stdio-shaped entry with an unknown type",
      { type: "websocket", command: "npx", args: ["-y", "server-github"], env: { SECRET: "s3cr3t" } },
    ],
  ]) {
    const sessionId = `mcp-badtype-${label.replace(/\W+/g, "-")}-${Date.now()}`;
    await conn.send({
      type: "session.open",
      requestId: `open-${sessionId}`,
      sessionId,
      config: {
        cwd: process.cwd(),
        mode: "build",
        mcpServers: { weird: { ...server, headers: { Authorization: "Bearer SECRET-TOKEN-ABCDEF" } } },
      },
    });
    const failure = await until(
      (e) => e.type === "request.failed" && e.requestId === `open-${sessionId}`,
      `${label} request.failed`,
    );
    const message = failure.error?.message ?? "";
    check(
      `${label} is refused loudly and names the server`,
      /weird/.test(message) && /transport/i.test(message),
      message,
    );
    check(
      `…and the message leaks no credential (${label})`,
      !message.includes("SECRET-TOKEN") && !message.includes("s3cr3t"),
      message,
    );
    check(
      `…and no mcp frame was sent for it (${label})`,
      mcpFramesFor(sessionId).length === 0,
      `${String(mcpFramesFor(sessionId).length)} frame(s)`,
    );
  }

  // ---- `__proto__` cannot make a server vanish ---------------------------
  //
  // `proxied[name] = …` with `name === "__proto__"` used to hit the prototype
  // setter instead of creating an own property, so the server disappeared from
  // `Object.keys` — no stderr, no failure, nothing to debug. The choice made here
  // is to refuse it by name: silently dropping a configured server is exactly the
  // failure mode this translation layer exists to prevent, and a server called
  // `__proto__` is not a case worth supporting. Both halves are pinned: the
  // refusal is loud, and the map cannot be poisoned even if the guard were removed
  // (it is `Object.create(null)`).
  const protoSession = `mcp-proto-${Date.now()}`;
  await conn.send({
    type: "session.open",
    requestId: `open-${protoSession}`,
    sessionId: protoSession,
    config: {
      cwd: process.cwd(),
      mode: "build",
      mcpServers: JSON.parse('{"__proto__": {"type": "http", "url": "http://127.0.0.1:7000/mcp"}}'),
    },
  });
  const protoFailure = await until(
    (e) => e.type === "request.failed" && e.requestId === `open-${protoSession}`,
    "__proto__ request.failed",
  );
  check(
    "a server named __proto__ is refused by name instead of vanishing",
    /__proto__/.test(protoFailure.error?.message ?? ""),
    protoFailure.error?.message,
  );

  // ---- the browser fail-open says so on the timeline ---------------------
  //
  // `browserMcpServer()` returns `undefined` rather than throwing when the browser
  // bridge cannot be mounted (a throw would take Paseo's own tools down with it),
  // and the reason only ever reached stderr — the daemon's log, which the user
  // never reads. The provider now turns the same answer into an open warning.
  //
  // **But only when the browser plugin is actually installed.** "The bridge file is
  // not there" means this deployment has no Server Browser plugin at all, and
  // warning about it on every session would be noise: the user is not missing a
  // broken capability, they never had it, and there is nothing for them to act on.
  // The three cases below are exactly that distinction, and the first one is the
  // regression this section exists for: the first version returned a gap for every
  // failure, so a machine without the plugin warned on every single open.
  const browserNoticeOf = (list) => list.filter((event) => /浏览器/.test(event.notice?.title ?? ""));
  {
    // (1) No plugin at all → stderr only, no timeline warning.
    const gapData = path.join(scratch, "definitely-not-a-browser-plugin");
    const saved = process.env.PASEO_SERVER_BROWSER_DATA;
    process.env.PASEO_SERVER_BROWSER_DATA = gapData;
    let gapNotices;
    try {
      const gapSession = `mcp-browser-gap-${Date.now()}`;
      const mark = events.length;
      await open(gapSession, undefined);
      await sleep(300);
      gapNotices = events
        .slice(mark)
        .filter((event) => event.type === "session.notice" && event.sessionId === gapSession);
    } finally {
      if (saved === undefined) delete process.env.PASEO_SERVER_BROWSER_DATA;
      else process.env.PASEO_SERVER_BROWSER_DATA = saved;
    }
    check(
      "no browser plugin at all produces NO timeline warning (it would be noise on every open)",
      browserNoticeOf(gapNotices).length === 0,
      browserNoticeOf(gapNotices).map((event) => `${event.notice?.title} — ${event.notice?.description}`).join(" | ")
        || "(no browser notice)",
    );

    // (2) The plugin IS installed but this session cannot use it → warn, with the
    // reason. The tree below has a real `mcp-bridge.mjs`, and a workspace registry
    // that maps a *different* directory, so the bridge exists and the mapping
    // fails. This is the case the warning is for: the capability should be there
    // and is not.
    const unmappedTree = path.join(scratch, "browser-unmapped");
    const unmappedHome = path.join(scratch, "browser-unmapped-home");
    fs.mkdirSync(path.join(unmappedTree, "ws-other"), { recursive: true });
    fs.writeFileSync(path.join(unmappedTree, "mcp-bridge.mjs"), "// stand-in bridge\n");
    fs.mkdirSync(path.join(unmappedHome, "projects"), { recursive: true });
    fs.writeFileSync(
      path.join(unmappedHome, "projects", "workspaces.json"),
      JSON.stringify([{ workspaceId: "ws-other", cwd: path.join(scratch, "somewhere-else"), archivedAt: null }]),
    );
    const savedUnmapped = { data: process.env.PASEO_SERVER_BROWSER_DATA, home: process.env.PASEO_HOME };
    process.env.PASEO_SERVER_BROWSER_DATA = unmappedTree;
    process.env.PASEO_HOME = unmappedHome;
    let unmappedNotices;
    try {
      const unmappedSession = `mcp-browser-unmapped-${Date.now()}`;
      const mark = events.length;
      await open(unmappedSession, undefined);
      await sleep(300);
      unmappedNotices = events
        .slice(mark)
        .filter((event) => event.type === "session.notice" && event.sessionId === unmappedSession);
    } finally {
      if (savedUnmapped.data === undefined) delete process.env.PASEO_SERVER_BROWSER_DATA;
      else process.env.PASEO_SERVER_BROWSER_DATA = savedUnmapped.data;
      if (savedUnmapped.home === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = savedUnmapped.home;
    }
    const unmappedNotice = browserNoticeOf(unmappedNotices)[0];
    check(
      "an installed-but-unusable browser bridge DOES warn, and names the reason",
      unmappedNotice !== undefined
        && unmappedNotice.notice?.severity === "warning"
        && /工作区/.test(unmappedNotice.notice?.description ?? ""),
      unmappedNotice === undefined
        ? `notices: ${JSON.stringify(unmappedNotices.map((event) => event.notice?.title))}`
        : `${unmappedNotice.notice?.title} — ${unmappedNotice.notice?.description}`,
    );

    // The control: with a working bridge the warning must be absent. Without this,
    // an unconditional warning would satisfy the assertion above.
    const workingTree = path.join(scratch, "browser-working");
    const workingHome = path.join(scratch, "browser-working-home");
    const workingId = "ws-working-1";
    fs.mkdirSync(path.join(workingTree, workingId), { recursive: true });
    fs.writeFileSync(path.join(workingTree, "mcp-bridge.mjs"), "// stand-in bridge\n");
    fs.mkdirSync(path.join(workingHome, "projects"), { recursive: true });
    fs.writeFileSync(
      path.join(workingHome, "projects", "workspaces.json"),
      JSON.stringify([{ workspaceId: workingId, cwd: process.cwd(), archivedAt: null }]),
    );
    const savedEnv = {
      data: process.env.PASEO_SERVER_BROWSER_DATA,
      home: process.env.PASEO_HOME,
    };
    process.env.PASEO_SERVER_BROWSER_DATA = workingTree;
    process.env.PASEO_HOME = workingHome;
    let workingNotices;
    try {
      const workingSession = `mcp-browser-ok-${Date.now()}`;
      const mark = events.length;
      await open(workingSession, undefined);
      await sleep(300);
      workingNotices = events
        .slice(mark)
        .filter((event) => event.type === "session.notice" && event.sessionId === workingSession);
    } finally {
      if (savedEnv.data === undefined) delete process.env.PASEO_SERVER_BROWSER_DATA;
      else process.env.PASEO_SERVER_BROWSER_DATA = savedEnv.data;
      if (savedEnv.home === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = savedEnv.home;
    }
    check(
      "…and a fully working browser bridge produces no warning either (control)",
      browserNoticeOf(workingNotices).length === 0,
      `notices: ${JSON.stringify(workingNotices.map((event) => event.notice?.title))}`,
    );
  }

  // ---- a late `paseo/mcp/set` is a failed session preparation ------------
  //
  // The real bridge throws when `paseo/mcp/set` arrives after the session's agent
  // exists: the entries cannot be mounted into a live agent scope, and answering
  // `mounted: false` instead would be a promise it cannot keep. The plugin used to
  // turn that answer into one stderr line, which meant "this session has no MCP
  // tools for its whole life" was a log entry the user never sees. A throw now
  // fails the session preparation — the open reports `request.failed` instead of
  // reporting ready with a broken tool surface.
  //
  // `mcp-late` mode is the caller's assertion that the agent already exists; the
  // stand-in has no agents, so it cannot observe that itself. See the fake bridge's
  // mode comment.
  {
    setMode("mcp-late");
    let lateEvents;
    const lateSession = `mcp-late-${Date.now()}`;
    try {
      const mark = events.length;
      await conn.send({
        type: "session.open",
        requestId: `open-${lateSession}`,
        sessionId: lateSession,
        config: {
          cwd: process.cwd(),
          mode: "build",
          mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "server-github"] } },
        },
      });
      // Either shape is loud; silence is what must not happen.
      await sleep(1500);
      lateEvents = events.slice(mark);
    } finally {
      setMode("live");
    }
    const ready = lateEvents.find(
      (event) => event.type === "session.ready" && event.sessionId === lateSession,
    );
    const failed = lateEvents.find(
      (event) => event.type === "request.failed" && event.requestId === `open-${lateSession}`,
    );
    check(
      "a late paseo/mcp/set fails the session preparation loudly",
      ready === undefined && failed !== undefined,
      failed === undefined
        ? `no request.failed (session.ready=${String(ready !== undefined)})`
        : `request.failed: ${failed.error?.message}`,
    );
    check(
      "…and the failure names the bridge's reason, not a generic error",
      /agent was created/i.test(failed?.error?.message ?? ""),
      failed?.error?.message ?? "(no message)",
    );
  }

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
