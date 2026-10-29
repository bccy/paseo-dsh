/**
 * Does this host truncate its history buffer on a rewind? Asserted on the real
 * host code, both ways.
 *
 * A rewind reaches the user through two independent pieces: the bridge rewinds
 * the DSH session, and the daemon rebuilds its timeline from
 * `PluginProviderSession.streamHistory()` — the provider's translated history
 * buffer, which the plugin contract only ever appends to. Nothing in the
 * protocol can remove a row, so a stock host keeps showing the withdrawn turns
 * until the whole agent is reloaded. The local patch adds
 * `truncateHistoryFrom(messageId)` to cut that buffer at the rewound row.
 *
 * The plugin cannot detect which one it is talking to (it runs in its own
 * process; there is no capability bit for "truncates history"). So the rewind
 * canary is a **behavioural probe**: a notice emitted *before* the receipt is
 * already in that buffer when the truncation runs, so a truncating host drops it
 * with the withdrawn rows while a stock host keeps it and shows the user how to
 * refresh. Emitted *after* the receipt it survives on both — the false "your
 * timeline is stale" warning on a host that did refresh.
 *
 * That is a claim about host code, and only host code can settle it. This script
 * imports the real `plugin-provider.js` (never writes to it), drives a fake
 * provider connection through a rewind, and asserts:
 *
 *   1. the host's own notice text equals `rewindCanaryNotice().message` — the
 *      joined form the client renders, so the plugin's wording and the host's
 *      `translateNotice` cannot drift apart;
 *   2. a canary sent **before** the receipt is cut on a patched host and kept on
 *      a stock one — whichever way the file is, the assertion flips with it, so
 *      a host that changes behaviour without changing the file is caught;
 *   3. a canary sent **after** the receipt survives on both — the order is the
 *      mechanism, and this is what makes "emit it before" a requirement rather
 *      than a preference.
 *
 * Usage:
 *   node harness/host-contract-sim.mjs [host-agent-dir] [compiled-plugin-dir]
 *
 * `host-agent-dir` defaults to the installed CLI's
 * `node_modules/@getpaseo/server/dist/server/server/agent`, resolved the same way
 * `local-patches/apply-rewind-history-truncation.mjs` does it (`PASEO_CLI_ROOT`,
 * else the realpath of the `paseo` on PATH). Only `import`ed, never modified.
 *
 * ## Running the stock half (the unpacked tarball needs a wrapper directory)
 *
 * `npm pack @getpaseo/server@<ver>` unpacks to `package/dist/...` with **no
 * `node_modules` of its own**, and `plugin-provider.js` imports `zod` and
 * `@getpaseo/plugin/server/provider`. Pointing this script straight at
 * `<unpacked>/package/dist/server/server/agent` therefore dies with
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'` — Node resolves a bare
 * specifier by walking up from the *importing file*, and there is nothing to
 * find above an extracted tarball.
 *
 * So build a one-level wrapper in a scratch directory and pass **its** dist:
 *
 *   mkdir -p /tmp/host-stock && cd /tmp/host-stock
 *   tar xzf <tarball>                       # -> package/
 *   ln -s "$PWD/package/dist" dist          # the wrapper's dist
 *   ln -s "$(npm root -g)/@getpaseo/cli/node_modules" node_modules
 *   node <repo>/harness/host-contract-sim.mjs "$PWD/dist/server/server/agent"
 *
 * Both links are needed and neither is optional: the `dist` link puts the stock
 * files under a directory that *has* a sibling `node_modules`, and the
 * `node_modules` link is where the bare specifiers resolve. The linked tree is the
 * installed CLI's, so `zod` and `@getpaseo/plugin` come from the same versions the
 * patched host runs against — which is what makes the two runs comparable. This is
 * exactly how `/tmp/paseo-dsh-review/scratch-nopatch/host-pristine` is built.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolvePluginBuild } = require("./plugin-build.cjs");

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition === true) {
    passed += 1;
    console.log(`  PASS  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  }
}

/**
 * Minimal `which`: walk PATH ourselves instead of shelling out, so this works the
 * same everywhere and cannot be fooled by a shell alias.
 */
function whichSync(name) {
  const separator = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(separator)) {
    if (dir === "") continue;
    try {
      if (readFileSync(join(dir, name)).length >= 0) return join(dir, name);
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * The installed Paseo CLI's package root.
 *
 * `PASEO_CLI_ROOT` wins so a caller can point at an unpacked copy; otherwise the
 * `paseo` on PATH is a symlink into the CLI package, whose realpath ends in
 * `.../@getpaseo/cli/bin/paseo`, so the package root is two levels up.
 */
function resolvePaseoCliRoot() {
  const fromEnv = process.env.PASEO_CLI_ROOT;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  for (const name of ["paseo", "paseo.cmd", "paseo.ps1"]) {
    const found = whichSync(name);
    if (found === null) continue;
    let real;
    try {
      real = require("node:fs").realpathSync(found);
    } catch {
      continue;
    }
    const candidate = dirname(dirname(real));
    try {
      if (readFileSync(join(candidate, "node_modules", "@getpaseo", "server", "package.json")).length > 0) {
        return candidate;
      }
    } catch {
      /* not the CLI package root */
    }
  }
  return null;
}

/** The directory holding the daemon's provider contract implementation. */
function resolveHostAgentDir() {
  const explicit = process.argv[2];
  if (typeof explicit === "string" && explicit !== "") return explicit;
  const root = resolvePaseoCliRoot();
  if (root === null) return null;
  return join(root, "node_modules", "@getpaseo", "server", "dist", "server", "server", "agent");
}

const hostDir = resolveHostAgentDir();
if (hostDir === null) {
  console.error(
    "cannot locate the Paseo host: set PASEO_CLI_ROOT, or pass the "
      + "dist/server/server/agent directory as the first argument",
  );
  process.exit(2);
}
const hostProviderFile = join(hostDir, "plugin-provider.js");
let hostSource;
try {
  hostSource = readFileSync(hostProviderFile, "utf8");
} catch (error) {
  console.error(`cannot read the host provider at ${hostProviderFile}: ${error.message}`);
  process.exit(2);
}

// The verdict comes from the file the daemon loads, which is the same file the
// patch script edits. Both directions are asserted below, so a host whose file and
// behaviour disagree fails instead of quietly reporting the file's answer.
const patched = hostSource.includes("truncateHistoryFrom");
console.log(`host: ${hostDir}`);
console.log(`      ${patched ? "truncates history on rewind (patched)" : "stock: no history truncation"}`);

// The canary's exact text, from the plugin module that defines it — a copy here
// would be a second definition that could drift from the one users see.
const buildDir = resolvePluginBuild(process.argv[3], ".dbg-host-contract");
const { rewindCanaryNotice } = require(join(buildDir, "server", "rewind-canary.js"));

const { PluginAgentClientRegistry } = await import(pathToFileURL(hostProviderFile).href);

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * A provider connection whose rewind emits the canary at the chosen point.
 *
 * `canaryBefore` is the whole variable under test: `before` emits the notice while
 * the host is still awaiting the receipt (the plugin's actual behaviour), `after`
 * emits it once the receipt has resolved (the mistake the ordering rule exists to
 * prevent).
 */
function makeConnection(capabilities, canaryBefore) {
  const listeners = new Set();
  const conn = {
    version: 1,
    capabilities,
    rootId: null,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    async send(input) {
      if (input.type === "session.open") {
        conn.rootId = input.sessionId;
        queueMicrotask(() => {
          conn.emit({
            type: "session.opened",
            requestId: input.requestId,
            sessionId: input.sessionId,
            capabilities,
            restoration: "core",
            cwd: "/tmp",
          });
          conn.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        });
        return;
      }
      if (input.type === "session.revert") {
        // The canary is built by the real module, so the text asserted against the
        // host's own translation is the one the plugin would send.
        const canary = rewindCanaryNotice({ at: new Date(2026, 0, 2, 3, 4, 5), seq: 1, files: false });
        const notice = {
          type: "session.notice",
          sessionId: input.sessionId,
          notice: { id: "canary-1", severity: "info", title: canary.title, description: canary.description },
        };
        // Same ordered channel the plugin and daemon share, one macrotask apart:
        // the host's `revert()` truncates inside the microtask that resolves the
        // receipt, so "before" means already published when that runs.
        setImmediate(() => {
          if (canaryBefore) conn.emit(notice);
          setImmediate(() => {
            conn.emit({ type: "request.completed", requestId: input.requestId });
            if (!canaryBefore) setImmediate(() => conn.emit(notice));
          });
        });
        return;
      }
      if (input.type === "session.close") {
        queueMicrotask(() => conn.emit({ type: "request.completed", requestId: input.requestId }));
        return;
      }
      if (input.type === "catalog") {
        queueMicrotask(() =>
          conn.emit({ type: "catalog", requestId: input.requestId, catalog: { models: [], modes: [] } }),
        );
        return;
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {},
  };
  return conn;
}

/**
 * Rewind one session and return what the host would rebuild the timeline from.
 *
 * @param canaryBefore - emit the canary before or after the receipt.
 * @returns the rows `streamHistory()` yields after the rewind settled.
 */
async function rewindAndReadHistory(canaryBefore) {
  const capabilities = ["prompt.message", "session.revert.conversation"];
  const conn = makeConnection(capabilities, canaryBefore);
  const registry = new PluginAgentClientRegistry({ warn() {}, info() {} });
  registry.replace([{ id: "fake", label: "Fake", connect: async () => conn }]);
  const client = registry.clients().fake;
  const session = await client.createSession({ provider: "fake", cwd: "/tmp" }, { env: {} }, {});
  const root = conn.rootId;
  // A rewindable user row plus its reply. The token is what `revert(messageId)`
  // looks up, and the row's `messageId` is what the truncation cuts at.
  conn.emit({
    type: "timeline.item",
    sessionId: root,
    item: { type: "user_message", id: "u1", text: "hi", revertToken: { messageId: "d1" } },
  });
  conn.emit({ type: "timeline.item", sessionId: root, item: { type: "assistant_message", id: "a1", text: "reply" } });
  await tick();
  await session.revertConversation({ messageId: "u1" });
  // A macrotask for the late canary to land after the receipt resolved.
  await tick();
  const history = [];
  for await (const event of session.streamHistory()) history.push(event);
  await registry.shutdown();
  return history;
}

/**
 * The timeline rows the host would rebuild from, as `type:text`.
 *
 * The raw text is kept in `text` so the canary comparison is byte-exact — the
 * newline `translateNotice` joins with is part of the contract — while `label`
 * flattens it for readable failure output.
 */
const rowsOf = (history) =>
  history
    .filter((event) => event.type === "timeline")
    .map((event) => {
      const text = String(event.item.text ?? event.item.message ?? "");
      return { type: event.item.type, text, label: `${event.item.type}:${text}`.replace(/\n/g, " | ") };
    });
const isCanaryRow = (row) => row.type === "notification" && row.text.startsWith("撤回已生效");
const describeRows = (rows) => rows.map((row) => row.label).join(" | ") || "(empty history)";

// ---------------------------------------------------------------------------
// 1. The notice text is the host's own joined form.
//
// `translateNotice` builds a notification's message as `title\ndescription`; the
// canary module exports the same join. Asserting on the host's output rather than
// on the module's input is what makes "the two agree" a fact about the host.
//
// Read off the **late** canary, which survives on every host — the early one is
// gone on a truncating host, and a check that needs a row the host just deleted
// would be asserting the absence of the thing it wants to inspect.
// ---------------------------------------------------------------------------
console.log("\nthe canary's text is what the host renders");
const beforeHistory = await rewindAndReadHistory(true);
const lateHistory = await rewindAndReadHistory(false);
const lateCanaryRows = rowsOf(lateHistory).filter(isCanaryRow);
if (lateCanaryRows.length === 0) {
  failed += 1;
  console.log("  FAIL  the host rendered no canary row  — nothing to compare the text against");
} else {
  const expected = rewindCanaryNotice({ at: new Date(2026, 0, 2, 3, 4, 5), seq: 1, files: false });
  const rendered = lateCanaryRows[0].text;
  // Byte-exact against `message`: the host joins with a newline, so a plugin that
  // put the whole thing in the title (or joined with anything else) is caught here
  // rather than showing up as a mangled notification on screen.
  check(
    "the host joins title and description exactly as the canary module does",
    rendered === expected.message,
    JSON.stringify(rendered),
  );
  check(
    "…and the rendered text names the time and the sequence number",
    /^撤回已生效\n03:04:05 · #1。/u.test(rendered),
    JSON.stringify(rendered),
  );
}

// ---------------------------------------------------------------------------
// 2. The canary's fate is the host's truncation behaviour.
//
// This is the assertion the whole design rests on. It is written against the
// file's verdict rather than "must be cut" or "must survive", so it is red if the
// host stops truncating while the patch is still in the file, and red if the file
// loses the patch while the behaviour stays.
// ---------------------------------------------------------------------------
console.log(`\na canary sent before the receipt ${patched ? "is cut with the withdrawn rows" : "survives"}`);
{
  const rows = rowsOf(beforeHistory);
  const survived = rows.filter(isCanaryRow).length === 1;
  check(
    patched ? "the canary is gone (the host truncated its history)" : "the canary is there (the host kept its history)",
    survived === !patched,
    describeRows(rows),
  );
  // The withdrawn rows are the other half: "the canary went away" is only good
  // news if the rows it warned about went away too.
  const withdrawn = rows.some((row) => row.type === "assistant_message" && row.text === "reply");
  check(
    patched ? "…along with the withdrawn reply" : "…and the withdrawn reply is still there (nothing was removed)",
    withdrawn === !patched,
    describeRows(rows),
  );
}

// ---------------------------------------------------------------------------
// 3. The order is the mechanism: sent after the receipt, it survives on both.
//
// Without this the "emit before the receipt" rule looks like style. With it, the
// rule has a failure it prevents: on a truncating host a late canary stays behind
// and tells the user to reload a timeline that was already refreshed.
// ---------------------------------------------------------------------------
console.log("\na canary sent after the receipt survives on this host too (why the order matters)");
{
  const rows = rowsOf(lateHistory);
  check(
    "the late canary is still in the history",
    rows.filter(isCanaryRow).length === 1,
    describeRows(rows),
  );
  if (patched) {
    // The point of the whole entry, stated as an assertion: on a patched host the
    // withdrawn rows are gone and the late canary is not, so the notice describes a
    // stale timeline that was in fact refreshed — the false warning the ordering
    // rule prevents.
    check(
      "…while the withdrawn reply is already gone",
      !rows.some((row) => row.type === "assistant_message" && row.text === "reply"),
      describeRows(rows),
    );
    check(
      "…so on this patched host a late canary would be a false \"timeline is stale\" warning",
      rows.filter(isCanaryRow).length === 1
        && !rows.some((row) => row.type === "assistant_message" && row.text === "reply"),
      "the withdrawn rows are gone and the canary is not — exactly the state the canary must not describe",
    );
  } else {
    // On a stock host nothing is ever removed, so a late canary is not *wrong*
    // there — it just arrives too late to be the probe. Asserted so the section
    // cannot go green on a host that behaves like the patched one.
    check(
      "…and on this stock host the withdrawn reply is still there too (nothing was removed)",
      rows.some((row) => row.type === "assistant_message" && row.text === "reply"),
      describeRows(rows),
    );
  }
}

console.log(`\n  ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log(`  ${failed} FAILED`);
  process.exit(1);
}
