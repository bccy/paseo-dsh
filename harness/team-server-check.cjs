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
 *   6. **The rc.3 generation (`dsh-agent-team`)**: `{enabled, tasks}` parses too; its
 *      roster costs a `paseo/subagents` read (the bridge lists every stored
 *      session header), so the read is **gated on a drawable board** — no read
 *      for `enabled: false` or an empty task list, exactly one for a visible
 *      board, and none when `tasks` is malformed (the union reports the shape);
 *      its roster is the Lead's **continuable direct children** from
 *      `paseo/subagents` (one-shot and grandchild rows excluded, a row without
 *      `name` falling back to its session id, no invented `phase`), `running`
 *      overlays the ones this process hosts, and `enabled: false` is a real
 *      answer (not an error). A failed catalog read is a transient
 *      `rpc_failed`, never an empty roster.
 *   7. **A hybrid shape is neither generation**: `{members, enabled, tasks}` is
 *      `rpc_failed`. The two wire shapes are a strict union, not a loosened
 *      object.
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
const SUBAGENTS_FILE = path.join(process.env.DSH_HOME, "subagents.json");
process.env.DSH_FAKE_SUBAGENTS_FILE = SUBAGENTS_FILE;
function script(value) {
  if (value === undefined) fs.rmSync(PROJECTIONS_FILE, { force: true });
  else fs.writeFileSync(PROJECTIONS_FILE, JSON.stringify(value));
}
/** The scripted `paseo/subagents` answer; `undefined` clears it. */
function catalog(value) {
  if (value === undefined) fs.rmSync(SUBAGENTS_FILE, { force: true });
  else fs.writeFileSync(SUBAGENTS_FILE, JSON.stringify(value));
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

function framesOf(method) {
  if (!fs.existsSync(FRAME_LOG)) return [];
  return fs
    .readFileSync(FRAME_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((frame) => frame.method === method);
}
function projectionFrames() {
  return framesOf("paseo/projections");
}
/** Every `paseo/subagents` request the plugin sent, for the read-gate checks. */
function subagentFrames() {
  return framesOf("paseo/subagents");
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
  // The third case, and the one the user's real rc.3 profile hits: the
  // `agent-team` **service failed to load** (rc.3 rejects the old profile's
  // `maxMembers` with TEAM_INVALID_CONFIG, so the projection is never
  // registered). The bridge answers the same unknown-key sentence as a profile
  // with no bundle at all, so the grading must stay the terminal
  // `team_unavailable` — a transient `rpc_failed` would make the pill retry a
  // condition that cannot change until the profile is fixed.
  const absentProjection = await read(agentId);
  check(
    "a failed agent-team service (projection absent) is the same terminal team_unavailable",
    absentProjection.available === false && absentProjection.error?.code === "team_unavailable"
      && absentProjection.team === null,
    JSON.stringify(absentProjection),
  );
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

  console.log("\nthe rc.3 generation: enabled plus a subagent-catalog roster");
  // The rc.3 wire view has no roster (`dsh-agent-team`'s projection defers to
  // `subagentCatalog`); the plugin derives it from the Lead's continuable direct
  // children and overlays the running state of the ones it hosts.
  const rc3Board = (enabled) => ({
    enabled,
    tasks: board(rootId).tasks,
  });
  catalog({
    available: true,
    subagents: [
      { sessionId: "team-child-R", parentSessionId: rootId, mode: "continuable", label: "Running R", name: "fixer" },
      { sessionId: "team-child-I", parentSessionId: rootId, mode: "continuable", label: "Idle I", name: "reviewer" },
      { sessionId: "team-child-X", parentSessionId: rootId, mode: "continuable", label: "Elsewhere X", name: "elsewhere" },
      { sessionId: "team-child-O", parentSessionId: rootId, mode: "one-shot", label: "One shot" },
      { sessionId: "team-child-N", parentSessionId: rootId, mode: "continuable", label: "Unnamed" },
      { sessionId: "team-child-G", parentSessionId: "team-child-R", mode: "continuable", label: "Grand", name: "grand" },
    ],
  });
  script(sequenced(rc3Board(true)));
  const rc3 = await read(agentId);
  check("the rc.3 shape is available with enabled: true", rc3.available === true && rc3.team?.enabled === true, JSON.stringify(rc3).slice(0, 300));
  const rc3Members = Object.fromEntries((rc3.team?.members ?? []).map((m) => [m.name, m]));
  check(
    "the roster is the Lead's continuable direct children (one-shot and grandchild excluded)",
    Object.keys(rc3Members).sort().join(",") === ["elsewhere", "fixer", "reviewer", "team-child-N"].sort().join(","),
    JSON.stringify(Object.keys(rc3Members)),
  );
  check("a catalog row without a name falls back to its session id", rc3Members["team-child-N"]?.role === "teammate", JSON.stringify(rc3Members["team-child-N"]));
  check("…and keeps DSH's creation label as its description", rc3Members["team-child-N"]?.description === "Unnamed", JSON.stringify(rc3Members["team-child-N"]));
  check("no phase is invented for a current subagent", Object.values(rc3Members).every((m) => !("phase" in m)), JSON.stringify(Object.values(rc3Members)));
  check("a hosted teammate mid-turn is running: true", rc3Members.fixer?.running === true, JSON.stringify(rc3Members.fixer));
  check("a hosted teammate whose turn ended is running: false", rc3Members.reviewer?.running === false, JSON.stringify(rc3Members.reviewer));
  check("a teammate this process does not host carries no running key", rc3Members.elsewhere !== undefined && !("running" in rc3Members.elsewhere), JSON.stringify(rc3Members.elsewhere));
  check(
    "the task board still arrives verbatim",
    rc3.team?.tasks?.length === 2 && rc3.team.tasks[0].writeScopeWarnings.length === 0,
    JSON.stringify(rc3.team?.tasks),
  );

  script(sequenced(rc3Board(false)));
  const disabled = await read(agentId);
  check(
    "enabled: false is a real answer; the roster is left empty because nothing is drawn",
    disabled.available === true && disabled.team?.enabled === false && (disabled.team?.members?.length ?? 0) === 0
      && disabled.error === undefined,
    JSON.stringify(disabled).slice(0, 300),
  );

  // A visible board is the only case that reads the catalog, so put one back
  // before testing how a failed read is graded.
  script(sequenced(rc3Board(true)));
  catalog({ available: false, error: { message: "subagent catalog exploded" } });
  const noCatalog = await read(agentId);
  check(
    "a failed catalog read is rpc_failed, never an empty roster",
    noCatalog.available === false && noCatalog.error?.code === "rpc_failed" && noCatalog.team === null
      && /subagent catalog exploded/.test(noCatalog.error?.message ?? ""),
    JSON.stringify(noCatalog),
  );
  catalog({ throw: "catalog transport exploded" });
  const thrownCatalog = await read(agentId);
  check(
    "a throwing catalog read is rpc_failed with its words",
    thrownCatalog.available === false && thrownCatalog.error?.code === "rpc_failed"
      && /catalog transport exploded/.test(thrownCatalog.error?.message ?? ""),
    JSON.stringify(thrownCatalog),
  );
  catalog(undefined);
  script(sequenced({ members: [{ id: rootId, name: "lead", role: "lead", phase: "active" }], enabled: true, tasks: [] }));
  const hybrid = await read(agentId);
  check(
    "a hybrid {members, enabled} is neither generation",
    hybrid.available === false && hybrid.error?.code === "rpc_failed" && /expected shape/.test(hybrid.error?.message ?? ""),
    JSON.stringify(hybrid),
  );
  script(sequenced({ tasks: [] }));
  const noMarker = await read(agentId);
  check(
    "a projection with neither marker is rpc_failed too",
    noMarker.available === false && noMarker.error?.code === "rpc_failed",
    JSON.stringify(noMarker),
  );

  console.log("\nthe catalog read is gated on a drawable board");
  // A throwing catalog is the proof that no read happened: one call would turn
  // the answer into a transient rpc_failed. The gate must not pay the bridge's
  // `persistence.list()` (every stored session header) for a board nobody draws.
  const forbiddenCatalog = { throw: "the subagent catalog must not be read for a hidden board" };
  catalog(forbiddenCatalog);
  script(sequenced(rc3Board(false)));
  const gatedDisabled = await read(agentId);
  check(
    "enabled: false → no paseo/subagents read, empty roster",
    gatedDisabled.available === true && gatedDisabled.team?.enabled === false
      && Array.isArray(gatedDisabled.team?.members) && gatedDisabled.team.members.length === 0
      && gatedDisabled.error === undefined,
    JSON.stringify(gatedDisabled).slice(0, 300),
  );
  script(sequenced({ enabled: true, tasks: [] }));
  const gatedEmpty = await read(agentId);
  check(
    "enabled: true with no task → no read, empty roster",
    gatedEmpty.available === true && gatedEmpty.team?.enabled === true
      && Array.isArray(gatedEmpty.team?.members) && gatedEmpty.team.members.length === 0
      && gatedEmpty.error === undefined,
    JSON.stringify(gatedEmpty).slice(0, 300),
  );
  // Drawable: exactly one read, and the roster is built from it.
  catalog({
    available: true,
    subagents: [
      { sessionId: "team-child-R", parentSessionId: rootId, mode: "continuable", label: "Running R", name: "fixer" },
      { sessionId: "team-child-I", parentSessionId: rootId, mode: "continuable", label: "Idle I", name: "reviewer" },
    ],
  });
  script(sequenced(rc3Board(true)));
  const readsBefore = subagentFrames().length;
  const gatedVisible = await read(agentId);
  const readsAfter = subagentFrames().length;
  check(
    "enabled: true with tasks → exactly one paseo/subagents read",
    readsAfter - readsBefore === 1,
    `${String(readsBefore)} → ${String(readsAfter)}`,
  );
  check(
    "…and the board's roster comes from it",
    gatedVisible.available === true && (gatedVisible.team?.members?.length ?? 0) === 2,
    JSON.stringify(gatedVisible).slice(0, 300),
  );
  // A malformed `tasks` is not drawable either: no read, and the provider's
  // union is what reports the shape failure (not the catalog).
  catalog(forbiddenCatalog);
  script(sequenced({ enabled: true, tasks: "not-an-array" }));
  const malformedTasks = await read(agentId);
  check(
    "a malformed tasks field → no read and the projection's shape error",
    malformedTasks.available === false && malformedTasks.error?.code === "rpc_failed"
      && /expected shape/.test(malformedTasks.error?.message ?? "")
      && !/must not be read/.test(malformedTasks.error?.message ?? ""),
    JSON.stringify(malformedTasks).slice(0, 300),
  );
  catalog(undefined);

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
