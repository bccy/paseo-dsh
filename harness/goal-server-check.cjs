/**
 * Plugin-level regression for the goal pill's two RPCs, driven over the scripted
 * fake bridge: `goal.current` (read + failure grading) and `goal.control` (the
 * `/goal` command path, including DSH's refusal shape).
 *
 * The bridge method itself (`paseo/goal`) is package A's contract (DESIGN §1.1);
 * this file asserts the plugin's half of it against the same fake the other
 * provider checks use, so a drift in the mapping is found offline instead of on
 * a real daemon:
 *
 *   1. **No session is not an error.** An agent this process holds no DSH
 *      session for answers `available: true, goal: null` — an accurate "it has
 *      no goal", the same rule `readAgentJobs` follows. Reporting a failure
 *      there would put an error pill on every agent before its first prompt.
 *   2. **The view is reduced, not passed through.** The bridge answers DSH's
 *      whole `GoalView`; the RPC carries exactly the fields the pill draws.
 *      `id`/`revision`/timestamps must not leak: they are compare-and-set
 *      plumbing the client cannot act on, and a client that compared revisions
 *      would be inventing a protocol Paseo does not have.
 *   3. **The failure grading is the jobs pill's.** `bridge_too_old` (the bridge
 *      does not implement `paseo/goal`) and `goal_unavailable` (the runtime
 *      composes no goal service) are terminal; a not-yet-created session and a
 *      transport failure are transient. The terminal codes are what make the
 *      pill hide instead of retrying forever.
 *   4. **Control goes through the command registry.** `pause`/`resume`/`clear`/
 *      `edit <objective>` reach the bridge as `paseo/command/run` with
 *      `name: "goal"` and DSH's own argument grammar — the path the P3 probe
 *      proved works while a turn is running, unlike a hand-typed `/goal` which
 *      the host steers into the model as text.
 *   5. **A refusal is not a success.** DSH's `{kind: "error", text}` becomes
 *      `ok: false` carrying that sentence verbatim; an empty `edit` objective is
 *      refused before any frame is sent.
 *   6. **The two halves agree on the missing-service sentence.** The bridge's
 *      "this DSH runtime composes no goal service" and the plugin's constant are
 *      one contract carried as an error *message*; before any session is driven,
 *      this file reads both sources (plus the fake bridge's copy) and asserts the
 *      three strings are equal. A reworded bridge would otherwise downgrade a
 *      terminal condition to a retried `rpc_failed`, with every other check
 *      still green.
 *
 * Compile the plugin first (type errors under `--moduleResolution node` are
 * expected; the emitted JS is what runs):
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/goal-server-check.cjs ../harness/fake-dsh-bridge.mjs .dbg/
 *   cd .dbg && node goal-server-check.cjs
 *   rm -rf ../.dbg
 */
"use strict";

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
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-goal-check-"));
const FRAME_LOG = path.join(process.env.DSH_HOME, "frames.jsonl");
process.env.DSH_FAKE_LOG = FRAME_LOG;
// The two scripted answers. The fake bridge re-reads both files on every
// request, so a check can steer them while the shared child stays alive.
const GOAL_FILE = path.join(process.env.DSH_HOME, "goal.json");
const COMMAND_FILE = path.join(process.env.DSH_HOME, "command.json");
process.env.DSH_FAKE_GOAL_FILE = GOAL_FILE;
process.env.DSH_FAKE_COMMAND_FILE = COMMAND_FILE;
function script(file, value) {
  if (value === undefined) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best-effort */
    }
    return;
  }
  fs.writeFileSync(file, JSON.stringify(value));
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
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Every `paseo/command/run` frame the fake `dsh` has received so far. */
function commandFrames() {
  if (!fs.existsSync(FRAME_LOG)) return [];
  return fs
    .readFileSync(FRAME_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((frame) => frame.method === "paseo/command/run");
}

/** Every `paseo/goal` frame the fake `dsh` has received so far. */
function goalFrames() {
  if (!fs.existsSync(FRAME_LOG)) return [];
  return fs
    .readFileSync(FRAME_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((frame) => frame.method === "paseo/goal");
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

/**
 * The repository root, read from source.
 *
 * This script runs from `paseo-plugin/.dbg/` (the compiled plugin), so `../..`
 * is the worktree. The cross-layer assertions below read the **sources** of the
 * bridge, the plugin and the fake bridge — not the compiled copies — because the
 * sentence under test is a hand-written string in each, and a compiled copy
 * could have been produced before the edit that matters.
 */
const sourceRoot = path.resolve(__dirname, "..", "..");
function readRepo(relative) {
  return fs.readFileSync(path.join(sourceRoot, relative), "utf8");
}

/**
 * The bridge's "this profile composes no goal service" sentence, from `goal()`.
 *
 * Scoped to the method body (`async goal(params)` … `async catalog()`) so a
 * matching sentence somewhere else in the bridge cannot satisfy this check: the
 * plugin grades `goal_unavailable` by exactly the text `goal()` throws.
 */
function bridgeMissingServiceSentence() {
  const source = readRepo("dsh-bridge/lib/server.js");
  const start = source.indexOf("async goal(params)");
  const end = start < 0 ? -1 : source.indexOf("async catalog()", start);
  if (start < 0 || end <= start) return undefined;
  const body = source.slice(start, end);
  return /throw new Error\('([^']*composes no goal service[^']*)'\)/.exec(body)?.[1];
}

/** The plugin's copy of that sentence (`server/dsh-process.ts`). */
function pluginMissingServiceConstant() {
  return /const GOAL_SERVICE_MISSING_MESSAGE = "([^"]+)";/.exec(
    readRepo("paseo-plugin/server/dsh-process.ts"),
  )?.[1];
}

/** The fake bridge's copy (`harness/fake-dsh-bridge.mjs`). */
function fakeMissingServiceConstant() {
  return /const GOAL_SERVICE_MISSING_MESSAGE = "([^"]+)";/.exec(
    readRepo("harness/fake-dsh-bridge.mjs"),
  )?.[1];
}

/** The goal the bridge reports; every field is here so the reduction is provable. */
const VIEW = {
  id: "goal-1",
  revision: 7,
  objective: "ship the goal pill",
  phase: "active",
  maxGoalRounds: 10,
  roundsStarted: 3,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  activation: "armed",
};

(async () => {
  // ---- 0. the cross-package contract, before anything is driven ----------
  // "This profile composes no goal service" travels as an error **message**
  // across the package boundary: the bridge throws it, the plugin matches it to
  // turn on the terminal `goal_unavailable` code. Nothing else pins the two
  // strings together, so a reworded bridge would silently downgrade a terminal
  // condition to a retried `rpc_failed`. Read both sources and compare them —
  // this is the assertion that makes the contract a check instead of a comment.
  const bridgeSentence = bridgeMissingServiceSentence();
  check(
    "the bridge's missing-service sentence is readable in goal()",
    typeof bridgeSentence === "string" && bridgeSentence.length > 0,
    String(bridgeSentence),
  );
  const pluginConstant = pluginMissingServiceConstant();
  check(
    "the plugin's GOAL_SERVICE_MISSING_MESSAGE is readable",
    typeof pluginConstant === "string" && pluginConstant.length > 0,
    String(pluginConstant),
  );
  check(
    "the plugin's terminal grading matches the bridge sentence verbatim",
    pluginConstant === bridgeSentence,
    `${JSON.stringify(pluginConstant)} vs bridge ${JSON.stringify(bridgeSentence)}`,
  );
  const fakeConstant = fakeMissingServiceConstant();
  check(
    "the fake bridge's copy matches the bridge sentence too",
    fakeConstant === bridgeSentence,
    `${JSON.stringify(fakeConstant)} vs bridge ${JSON.stringify(bridgeSentence)}`,
  );

  const conn = await registration.connect({ capabilities: ["prompt.message"] });
  conn.onEvent((event) => events.push(event));

  // The two RPCs have to exist before anything else matters: a pill that polls
  // a name the server never registered gets a "no such RPC" error, which the
  // client would have to present as an unreadable goal forever.
  check("the plugin registers goal.current", handlers.has("goal.current"));
  check("the plugin registers goal.control", handlers.has("goal.control"));

  // An agent with no open session. `capture` needs a Paseo handle object; this
  // check drives the RPC handlers directly, so an empty stand-in is enough (no
  // rewind report is pending).
  const context = { paseo: {} };
  const read = (agentId) => handlers.get("goal.current")({ agentId }, context);
  const control = (input) => handlers.get("goal.control")(input, context);

  const beforeSession = await read("agent-with-no-session");
  check(
    "an agent with no open session answers no goal (not an error)",
    beforeSession.available === true && beforeSession.goal === null,
    JSON.stringify(beforeSession),
  );
  const noSessionControl = await control({ agentId: "agent-with-no-session", action: "pause" });
  check(
    "controlling an agent with no open session fails loudly",
    noSessionControl.ok === false && typeof noSessionControl.error === "string",
    JSON.stringify(noSessionControl),
  );

  // ---- the open session ---------------------------------------------------
  const agentId = "goal-check-agent";
  const sessionId = `goal-check-${Date.now()}`;
  await conn.send({
    type: "session.open",
    sessionId,
    config: {
      cwd: process.cwd(),
      mode: "build",
      env: { PASEO_AGENT_ID: agentId },
    },
  });
  await until((e) => e.type === "session.ready" && e.sessionId === sessionId, "session ready");

  // ---- 1. a live goal, reduced to what the pill draws ---------------------
  script(GOAL_FILE, { goal: VIEW });
  const live = await read(agentId);
  check("a live goal reads as available", live.available === true, JSON.stringify(live));
  const reduced = live.goal ?? {};
  check(
    "the goal carries the five drawn fields",
    reduced.objective === VIEW.objective
      && reduced.phase === "active"
      && reduced.activation === "armed"
      && reduced.roundsStarted === 3
      && reduced.maxGoalRounds === 10,
    JSON.stringify(reduced),
  );
  check(
    "compare-and-set plumbing does not leak to the client",
    !("id" in reduced) && !("revision" in reduced) && !("createdAt" in reduced) && !("updatedAt" in reduced),
    JSON.stringify(reduced),
  );
  const goalFrame = goalFrames().at(-1);
  check(
    "the read names the session and no other key",
    goalFrame !== undefined
      && goalFrame.params?.sessionId === sessionId
      && Object.keys(goalFrame.params ?? {}).length === 1,
    JSON.stringify(goalFrame?.params),
  );

  // ---- 2. a blocked goal keeps its reason --------------------------------
  script(GOAL_FILE, {
    goal: {
      ...VIEW,
      phase: "blocked",
      activation: "disarmed",
      blockedReason: { code: "round-limit", message: "Goal reached its configured limit of 10 rounds." },
    },
  });
  const blocked = await read(agentId);
  check(
    "a blocked goal carries its machine code and sentence",
    blocked.goal?.blockedReason?.code === "round-limit"
      && blocked.goal?.blockedReason?.message === "Goal reached its configured limit of 10 rounds.",
    JSON.stringify(blocked.goal),
  );

  // ---- 3. no goal is a real answer ---------------------------------------
  script(GOAL_FILE, { goal: null });
  const cleared = await read(agentId);
  check(
    "a cleared goal answers null (not a failure)",
    cleared.available === true && cleared.goal === null,
    JSON.stringify(cleared),
  );

  // ---- 4. the failure grading --------------------------------------------
  // `missingService` makes the fake throw the bridge's own sentence, read above
  // out of `dsh-bridge/lib/server.js` — the same text the plugin matches.
  script(GOAL_FILE, { missingService: true });
  const unavailable = await read(agentId);
  check(
    "a runtime with no goal service is terminal goal_unavailable",
    unavailable.available === false && unavailable.error?.code === "goal_unavailable",
    JSON.stringify(unavailable),
  );
  check(
    "…and its message is the bridge's sentence verbatim",
    unavailable.error?.message === bridgeSentence,
    JSON.stringify(unavailable.error),
  );

  script(GOAL_FILE, { throw: `unknown or not-yet-created session: ${sessionId}` });
  const notYet = await read(agentId);
  check(
    "a not-yet-created session is transient session_missing",
    notYet.available === false && notYet.error?.code === "session_missing",
    JSON.stringify(notYet),
  );

  script(GOAL_FILE, { throw: "the transport died mid-read" });
  const transport = await read(agentId);
  check(
    "an unrecognised read failure stays transient rpc_failed",
    transport.available === false && transport.error?.code === "rpc_failed",
    JSON.stringify(transport),
  );

  script(GOAL_FILE, { unknownMethod: true });
  const tooOld = await read(agentId);
  check(
    "a bridge without paseo/goal is terminal bridge_too_old",
    tooOld.available === false && tooOld.error?.code === "bridge_too_old",
    JSON.stringify(tooOld),
  );
  script(GOAL_FILE, undefined);

  // ---- 5. control goes through the command registry ----------------------
  script(COMMAND_FILE, { kind: "success", text: "Goal paused\nStatus: paused" });
  const paused = await control({ agentId, action: "pause" });
  check(
    "pause succeeds and carries the command's own output",
    paused.ok === true && paused.message === "Goal paused\nStatus: paused",
    JSON.stringify(paused),
  );
  let frame = commandFrames().at(-1);
  check(
    "pause reaches the bridge as /goal pause",
    frame?.params?.name === "goal" && frame?.params?.arguments === "pause",
    JSON.stringify(frame?.params),
  );
  check("…for the open session", frame?.params?.sessionId === sessionId, JSON.stringify(frame?.params));

  script(COMMAND_FILE, { kind: "success", text: "Goal resumed" });
  const resumed = await control({ agentId, action: "resume" });
  check("resume succeeds", resumed.ok === true, JSON.stringify(resumed));
  frame = commandFrames().at(-1);
  check("resume reaches the bridge as /goal resume", frame?.params?.arguments === "resume", JSON.stringify(frame?.params));

  script(COMMAND_FILE, { kind: "success", text: "Goal cleared." });
  const clearedControl = await control({ agentId, action: "clear" });
  check("clear succeeds", clearedControl.ok === true, JSON.stringify(clearedControl));
  frame = commandFrames().at(-1);
  check("clear reaches the bridge as /goal clear", frame?.params?.arguments === "clear", JSON.stringify(frame?.params));

  script(COMMAND_FILE, { kind: "success", text: "Goal updated" });
  const edited = await control({ agentId, action: "edit", objective: "  make it faster  " });
  check("edit succeeds", edited.ok === true, JSON.stringify(edited));
  frame = commandFrames().at(-1);
  check(
    "edit reaches the bridge with DSH's grammar and a trimmed objective",
    frame?.params?.arguments === "edit make it faster",
    JSON.stringify(frame?.params),
  );

  // ---- 6. a refusal is not a success -------------------------------------
  const refusal = "The goal command is not valid for the current state. Run /goal to view available commands.";
  script(COMMAND_FILE, { kind: "error", text: refusal });
  const refused = await control({ agentId, action: "resume" });
  check(
    "a refused command answers ok:false with DSH's sentence verbatim",
    refused.ok === false && refused.error === refusal,
    JSON.stringify(refused),
  );

  // ---- 7. an empty edit is refused before any frame ----------------------
  const framesBeforeEmptyEdit = commandFrames().length;
  const emptyEdit = await control({ agentId, action: "edit", objective: "   " });
  check(
    "an empty edit is refused with an explanation",
    emptyEdit.ok === false && typeof emptyEdit.error === "string" && emptyEdit.error.length > 0,
    JSON.stringify(emptyEdit),
  );
  check(
    "…and no command reaches the runtime",
    commandFrames().length === framesBeforeEmptyEdit,
    `${commandFrames().length - framesBeforeEmptyEdit} frame(s) sent`,
  );

  script(COMMAND_FILE, undefined);
  script(GOAL_FILE, undefined);

  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`${failed.length} FAILED`);
    // The shared `dsh` child keeps the event loop alive (its stdin pipe is
    // open), so a plain `process.exitCode = 1` would leave a failed run hanging
    // instead of reporting red. Exit explicitly on both paths.
    process.exit(1);
  }
  console.log("OK");
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
