/**
 * Offline check of the team pill's server half (T3): `team.read` over the fake
 * bridge, no DSH, no model.
 *
 * What it proves:
 *   1. **The RPC exists and reads the right projection**: one
 *      `paseo/projections {sessionId, keys:["agentTeam"]}` frame per read.
 *   2. **Empty is not an error**: no session for the agent, no stored log
 *      (`null`), a `migration-required` snapshot and an absent key all answer
 *      `available: true, team: null`.
 *   3. **The grading follows goal's**: no `projections` method → terminal
 *      `bridge_too_old`; the bridge's unknown-key sentence → terminal
 *      `team_unavailable` (and that sentence is pinned to the bridge source);
 *      an unknown session → transient `session_missing`; any other throw →
 *      `rpc_failed`; a board that is not DSH's shape → `rpc_failed` with the
 *      parse reason, never an emptied board.
 *   4. **Running is the session's own knowledge, and only when it has it**: the
 *      Lead's `running` follows the root's turn; a teammate hosted live gets
 *      `running: true` while its turn is open and `false` once it went idle; a
 *      teammate this process never saw gets **no** `running` key.
 *   5. **DSH's fields arrive untouched**: ownerName, ready, blockedBy,
 *      writeScopes, writeScopeWarnings, failure, a member's error.
 *
 * Compile the plugin first (type errors under `--moduleResolution node` are
 * expected; the emitted JS is what runs):
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/team-server-check.cjs ../harness/fake-dsh-bridge.mjs .dbg/
 *   cd .dbg && node team-server-check.cjs
 *   rm -rf ../.dbg
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fakeBridge = path.join(__dirname, "fake-dsh-bridge.mjs");
fs.chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
// A throwaway DSH_HOME: loading the plugin rewrites the profile's bridge.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-check-"));
const MODE_FILE = path.join(process.env.DSH_HOME, "fake-dsh-mode");
fs.writeFileSync(MODE_FILE, "team\n");
process.env.DSH_FAKE_MODE = "team";
process.env.DSH_FAKE_MODE_FILE = MODE_FILE;
const FRAME_LOG = path.join(process.env.DSH_HOME, "frames.jsonl");
process.env.DSH_FAKE_LOG = FRAME_LOG;
const PROJECTIONS_FILE = path.join(process.env.DSH_HOME, "projections.json");
process.env.DSH_FAKE_PROJECTIONS_FILE = PROJECTIONS_FILE;
function script(value) {
  if (value === undefined) fs.rmSync(PROJECTIONS_FILE, { force: true });
  else fs.writeFileSync(PROJECTIONS_FILE, JSON.stringify(value));
}
process.on("exit", () => {
  try {
    fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const plugin = require("./index.server.js").default;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const events = [];
const handlers = new Map();
let registration;
plugin({
  handle(contract, handler) {
    handlers.set(contract.name, handler);
  },
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
    await sleep(60);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function projectionFrames() {
  if (!fs.existsSync(FRAME_LOG)) return [];
  return fs
    .readFileSync(FRAME_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((frame) => frame.method === "paseo/projections");
}

let passed = 0;
let failed = 0;
const check = (name, pass, detail) => {
  if (pass) passed += 1;
  else failed += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${pass || detail === undefined ? "" : `  — ${detail}`}`);
};

/** A fictional board in DSH's wire shape (`buildTeamProjection`). */
function board(rootId) {
  return {
    members: [
      { id: rootId, name: "lead", role: "lead", phase: "active" },
      { id: "team-child-R", name: "fixer", role: "teammate", phase: "active" },
      { id: "team-child-I", name: "reviewer", role: "teammate", phase: "active" },
      { id: "team-child-X", name: "elsewhere", role: "teammate", phase: "active" },
      { id: "team-child-F", name: "broken", role: "teammate", phase: "failed", error: "child Session recovery failed: store is read-only" },
    ],
    tasks: [
      { id: "task-1", revision: 2, subject: "fix it", description: "fix the thing", status: "in_progress", blockedBy: [], writeScopes: ["src/a.ts"], ownerName: "fixer", ready: false, writeScopeWarnings: [] },
      { id: "task-2", revision: 1, subject: "review it", description: "", status: "pending", blockedBy: ["task-1"], writeScopes: ["src/"], ready: false, writeScopeWarnings: ["write scopes overlap with task-1"] },
    ],
  };
}
const sequenced = (team) => ({ kind: "sequenced", asOfSeq: 9, values: { agentTeam: team } });

/** The bridge's unknown-key sentence, read from `dsh-bridge/lib/server.js`'s `projections()`. */
function bridgeUnknownKeyPrefix() {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "dsh-bridge", "lib", "server.js"), "utf8");
  const start = source.indexOf("async projections(params)");
  const body = start < 0 ? "" : source.slice(start, start + 1500);
  return /throw new Error\(`(unknown or unavailable projection key:) \$\{key\}`\)/.exec(body)?.[1];
}

(async () => {
  console.log("contract");
  check("the plugin serves the team subscription", handlers.has("team.snapshot"));
  check("the polling RPC is gone", !handlers.has("team.read"));
  const pluginPrefix = /const UNKNOWN_PROJECTION_KEY_PREFIX = "([^"]+)";/.exec(
    fs.readFileSync(path.resolve(__dirname, "..", "..", "paseo-plugin", "server", "dsh-process.ts"), "utf8"),
  )?.[1];
  check("the plugin's unknown-key prefix is the bridge's verbatim", pluginPrefix !== undefined && pluginPrefix === bridgeUnknownKeyPrefix(), `${pluginPrefix} vs ${bridgeUnknownKeyPrefix()}`);

  const context = { paseo: {} };
  /**
   * Drive the real subscription handler and return its first pushed snapshot
   * (`server/pill-feed` starts a read and pushes the answer; aborting releases
   * the subscription and its timer).
   */
  const read = (agentId) =>
    new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        reject(new Error("the team feed pushed no snapshot"));
      }, 10_000);
      handlers.get("team.snapshot")(
        { agentId },
        {
          paseo: {},
          signal: controller.signal,
          push: (event) => {
            clearTimeout(timer);
            controller.abort();
            resolve(event);
          },
        },
      );
    });
  const none = await read("agent-with-no-session");
  check("an agent with no session answers team: null, available", none.available === true && none.team === null, JSON.stringify(none));

  const conn = await registration.connect({
    capabilities: ["prompt.message", "session.configure", "session.persistence", "session.list", "session.subsession", "permission"],
  });
  conn.onEvent((event) => events.push(event));
  const agentId = "team-check-agent";
  const sessionId = `team-check-${Date.now()}`;
  await conn.send({ type: "session.open", sessionId, config: { cwd: process.cwd(), mode: "build", env: { PASEO_AGENT_ID: agentId } } });
  await until((e) => e.type === "session.ready" && e.sessionId === sessionId, "session ready");
  // The DSH session id the fake bridge serves this root under (the projection's lead id).
  const rootId = (() => {
    const frame = fs
      .readFileSync(FRAME_LOG, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line))
      .find((f) => f.method === "session/create" || f.method === "session/open" || f.method === "initialize");
    return frame?.params?.sessionId ?? sessionId;
  })();

  console.log("\nempty answers are not errors");
  script(undefined);
  const nullSnap = await read(agentId);
  check("no stored log (null snapshot) → team: null", nullSnap.available === true && nullSnap.team === null, JSON.stringify(nullSnap));
  const frame = projectionFrames().at(-1);
  check(
    "the read asks for exactly the agentTeam projection",
    frame !== undefined && Array.isArray(frame.params?.keys) && frame.params.keys.length === 1 && frame.params.keys[0] === "agentTeam",
    JSON.stringify(frame?.params),
  );
  script({ kind: "migration-required", values: { agentTeam: board(rootId) } });
  const migrating = await read(agentId);
  check("migration-required (cached hints) → team: null", migrating.available === true && migrating.team === null, JSON.stringify(migrating));
  script({ kind: "sequenced", asOfSeq: 1, values: {} });
  const absent = await read(agentId);
  check("a snapshot without the key → team: null", absent.available === true && absent.team === null, JSON.stringify(absent));

  console.log("\nfailure grading");
  script({ unknownMethod: true });
  const old = await read(agentId);
  check("a bridge without paseo/projections → terminal bridge_too_old", old.available === false && old.error?.code === "bridge_too_old", JSON.stringify(old));
  script({ throw: "unknown or unavailable projection key: agentTeam" });
  const noBundle = await read(agentId);
  check("no agent-team bundle → terminal team_unavailable (not 'no team')", noBundle.available === false && noBundle.error?.code === "team_unavailable" && noBundle.team === null, JSON.stringify(noBundle));
  script({ throw: `unknown or not-yet-created session: ${rootId}` });
  const missing = await read(agentId);
  check("an unknown session → transient session_missing", missing.available === false && missing.error?.code === "session_missing", JSON.stringify(missing));
  script({ throw: "projection fold exploded" });
  const broken = await read(agentId);
  check("any other throw → rpc_failed with DSH's words", broken.available === false && broken.error?.code === "rpc_failed" && /projection fold exploded/.test(broken.error?.message ?? ""), JSON.stringify(broken));
  script(sequenced({ members: [{ id: "x", name: "lead", role: "lead", phase: "active" }], tasks: [{ id: "task-1", status: "archived" }] }));
  const shape = await read(agentId);
  check("a board that is not DSH's shape → rpc_failed, never an empty board", shape.available === false && shape.error?.code === "rpc_failed" && shape.team === null && /expected shape/.test(shape.error?.message ?? ""), JSON.stringify(shape));

  console.log("\nthe board, before any child is hosted");
  script(sequenced(board(rootId)));
  const cold = await read(agentId);
  check("a board reads as available", cold.available === true && cold.team !== null, JSON.stringify(cold).slice(0, 200));
  const coldMembers = Object.fromEntries((cold.team?.members ?? []).map((m) => [m.name, m]));
  check("an idle root's Lead is running: false", coldMembers.lead?.running === false, JSON.stringify(coldMembers.lead));
  check("an unseen teammate carries no running key", coldMembers.fixer !== undefined && !("running" in coldMembers.fixer), JSON.stringify(coldMembers.fixer));
  const t2 = cold.team?.tasks?.find((t) => t.id === "task-2");
  check(
    "DSH's task fields arrive verbatim",
    t2 !== undefined && t2.ready === false && t2.blockedBy[0] === "task-1" && t2.writeScopes[0] === "src/" && t2.writeScopeWarnings[0] === "write scopes overlap with task-1" && !("ownerName" in t2),
    JSON.stringify(t2),
  );
  check("a failed member keeps DSH's error", coldMembers.broken?.phase === "failed" && /store is read-only/.test(coldMembers.broken?.error ?? ""), JSON.stringify(coldMembers.broken));
  script(sequenced({ ...board(rootId), failure: 'team task "task-3" revision is not contiguous' }));
  const failure = await read(agentId);
  check("the projection failure arrives verbatim", failure.team?.failure === 'team task "task-3" revision is not contiguous', JSON.stringify(failure.team?.failure));

  console.log("\nrunning comes from the sessions this process hosts");
  await conn.send({ type: "session.prompt", sessionId, prompt: { clientMessageId: "p1", input: { type: "message", content: [{ type: "text", text: "go" }] } } });
  await until((e) => e.type === "session.opened" && /team-child-I$/.test(e.sessionId ?? ""), "child I opened");
  await until((e) => e.type === "session.turn" && /team-child-I$/.test(e.sessionId ?? "") && e.state === "completed", "child I idle");
  script(sequenced(board(rootId)));
  const live = await read(agentId);
  const liveMembers = Object.fromEntries((live.team?.members ?? []).map((m) => [m.name, m]));
  check("a hosted teammate mid-turn is running: true", liveMembers.fixer?.running === true, JSON.stringify(liveMembers.fixer));
  check("a hosted teammate whose turn ended is running: false", liveMembers.reviewer?.running === false, JSON.stringify(liveMembers.reviewer));
  check("a teammate this process does not host still carries no running key", liveMembers.elsewhere !== undefined && !("running" in liveMembers.elsewhere), JSON.stringify(liveMembers.elsewhere));
  check("a failed member is not given a running state it cannot have", !("running" in (liveMembers.broken ?? {})), JSON.stringify(liveMembers.broken));

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
