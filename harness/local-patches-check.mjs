/**
 * Offline checks for `local-patches/` (the optional Paseo host patch).
 *
 * The scripts under `local-patches/` rewrite an installed
 * `@getpaseo/server` dist tree, so their regressions cannot use the real
 * install. This check drives the real apply/check scripts in subprocesses with
 * `REWIND_PATCH_TURNID_TARGET` / `REWIND_PATCH_HOME` pointed at scratch
 * fixtures, and asserts the machine-readable status file and the process exit
 * code — the layer the startup hook and `check-rewind-patch.mjs` branch on.
 *
 * What is covered (the rewind target was retired with Paseo 0.15.0, so only the
 * turnId patch remains):
 *
 *   1. The 0.15-shaped fixture patches: both replay call sites rewritten, backup
 *      written to REWIND_PATCH_HOME, `node --check`-clean output, status says
 *      `turnid-patched`.
 *   2. Idempotence: a second apply is `turnid-already-patched` and leaves the
 *      bytes untouched.
 *   3. The 0.14-shaped fixture (same anchor text; verified byte-identical in the
 *      real 0.14.0 and 0.15.0 dist trees) patches too, and a 2-space reformat of
 *      it still patches (whitespace-elastic anchor).
 *   4. `--check` / the checker on a clean file: exit 1 / `patchable`, and the
 *      message names the two call sites instead of a bare "not patched".
 *   5. Half-patched, anchor-mismatch and anchor-context-mismatch files fail
 *      closed: apply exits 1, leaves the file byte-identical, the status names
 *      the reason, and the checker exits 2 (never "run apply to fix it").
 *   6. A stale body is rebuilt in place: checker says `stale-body` (exit 1),
 *      apply says `turnid-patched-from-stale` and the rebuilt file is exactly the
 *      current body; the prestale snapshot lands in REWIND_PATCH_HOME.
 *   7. A stale body whose region would swallow unrelated code is
 *      `stale-body-unrebuildable` in the checker (exit 2, apply refuses) — and
 *      apply actually refuses on the same file (agreement, not a promise). This
 *      is the LP-02 lesson one layer down.
 *   8. MUTATION WITNESS: a patched body that drops `turnId` from the replay call
 *      (markers 2/2, so a marker-count-only check is green on it) must be
 *      reported as `stale-body`, not `patched`. The regression is reproduced by
 *      the old predicate in the same block.
 *   9. `--revert` restores the pre-patch bytes and is idempotent; a missing
 *      target is exit 1 from apply / exit 3 from the checker.
 *
 * No installed `@getpaseo/server` is read or written: every target is a fixture
 * under the system temp directory, and only the scripts' own logic plus their
 * `--check` read paths run against them.
 *
 * Usage: node harness/local-patches-check.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPLY = join(HERE, "..", "local-patches", "apply-rewind-history-truncation.mjs");
const CHECKER = join(HERE, "..", "local-patches", "check-rewind-patch.mjs");

const WORK = mkdtempSync(join(tmpdir(), "local-patches-check-"));
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

// ── fixture text ────────────────────────────────────────────────────────────
//
// The replay call line is copied verbatim from the 0.15.0 dist
// (`agent-manager.js:3120` / `:3175`); the 0.14.0 dist carries the exact same
// line (`:3094` / `:3149`), which is why one anchor serves both versions. The
// two surrounding context lines (`if (broadcastTimeline) {` /
// `if (deferredBroadcast) {`) are what proves each match is the right path, in
// the right order.
const REPLAY_CALL =
  "            const row = this.recordTimeline(agent.id, event.item, event.timestamp ? { timestamp: event.timestamp } : undefined);";
const CONTEXTS = ["            if (broadcastTimeline) {", "            if (deferredBroadcast) {"];

const MARKER_LINE =
  "            // LOCAL PATCH (paseo-dsh): keep the turn id on replay — the replay already has it;";
const COMMENT_LINE = "            // the timeline-store row needs it for the app to fold turns after a reopen.";

const BODY_CURRENT = [
  MARKER_LINE,
  COMMENT_LINE,
  "            const row = this.recordTimeline(agent.id, event.item, {",
  "                ...(event.timestamp ? { timestamp: event.timestamp } : {}),",
  "                ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),",
  "            });",
];
const BODY_DROPPED_TURNID = [
  MARKER_LINE,
  COMMENT_LINE,
  "            const row = this.recordTimeline(agent.id, event.item, {",
  "                ...(event.timestamp ? { timestamp: event.timestamp } : {}),",
  "            });",
];
const BODY_OLD = [
  "            // LOCAL PATCH (paseo-dsh): keep the turn id on replay — OLDER BODY",
  "            const row = this.recordTimeline(agent.id, event.item, {",
  "                ...(event.timestamp ? { timestamp: event.timestamp } : {}),",
  "            });",
];
// Current body, but its region would not close where a stale rebuild expects it
// to — the rebuild would swallow the following statements. Must fail closed.
const BODY_UNREBUILDABLE = [
  MARKER_LINE,
  COMMENT_LINE,
  "            const row = this.recordTimeline(agent.id, event.item, {",
  "                ...(event.timestamp ? { timestamp: event.timestamp } : {}),",
  "                ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),",
  "            this.upstreamCleanupAfterReplay();",
];

/** Map the fixture's 4-space-per-level indentation onto the requested unit. */
const reindent = (line, unit) => {
  const leading = /^ */.exec(line)[0].length;
  return unit.repeat(leading / 4) + line.slice(leading);
};

/**
 * Build an agent-manager.js fixture.
 *
 * @param {object} [options]
 * @param {string} [options.indent] - indentation unit (4 spaces default).
 * @param {Array<"clean"|"current"|"dropped-turnid"|"old"|"unrebuildable">} [options.sites]
 *   - one entry per replay path (2 = forceHydrate + primeTimeline).
 * @param {boolean} [options.renameContext] - break the context proof of site #1.
 * @returns {string}
 */
function agentManagerSource({ indent = "    ", sites = ["clean", "clean"], renameContext = false } = {}) {
  const lines = [];
  lines.push("// Fixture shaped after the Paseo 0.15.0 dist (agent-manager.js replay paths).");
  lines.push("class AgentManagerFixture {");
  for (const [index, kind] of sites.entries()) {
    const method = index === 0 ? "forceHydrateTimelineFromLegacyProviderHistory" : "primeTimelineFromLegacyProviderHistory";
    const arg = index === 0 ? "broadcastTimeline" : "deferredBroadcast";
    const context = renameContext && index === 0 ? "            if (broadcastTimeline && extra) {" : CONTEXTS[index];
    const body = (() => {
      if (kind === "clean") return [REPLAY_CALL];
      if (kind === "current") return BODY_CURRENT;
      if (kind === "dropped-turnid") return BODY_DROPPED_TURNID;
      if (kind === "old") return BODY_OLD;
      if (kind === "unrebuildable") return BODY_UNREBUILDABLE;
      throw new Error(`unknown fixture site kind: ${kind}`);
    })();
    lines.push(`    ${method}(agent, ${arg}) {`);
    lines.push("        for (const event of agent.session.streamHistory()) {");
    lines.push(...body);
    lines.push(context);
    lines.push("            }");
    lines.push("        }");
    lines.push("    }");
  }
  lines.push("}");
  lines.push("");
  return lines.map((line) => reindent(line, indent)).join("\n");
}

/** One scratch target + its own status/backup home. */
let fixtureCount = 0;
function fixture(source) {
  fixtureCount += 1;
  const target = join(WORK, `agent-manager-${String(fixtureCount)}.js`);
  const home = join(WORK, `home-${String(fixtureCount)}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(target, source);
  return { target, home };
}

function runScript(script, target, home, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      REWIND_PATCH_TURNID_TARGET: target,
      REWIND_PATCH_HOME: home,
    },
  });
}

function statusOf(home) {
  return JSON.parse(readFileSync(join(home, "rewind-patch.status.json"), "utf8"));
}

function jsonOf(run) {
  try {
    return JSON.parse(run.stdout);
  } catch {
    return undefined;
  }
}

/** A clean 0.15-shaped fixture that has just been patched by the real apply. */
function patchedFixture() {
  const state = fixture(agentManagerSource());
  const run = runScript(APPLY, state.target, state.home);
  if (run.status !== 0) throw new Error(`fixture setup failed: apply exit ${run.status}: ${run.stderr}`);
  return state;
}

// ---- 1. the 0.15-shaped fixture patches ----------------------------------
{
  const state = fixture(agentManagerSource());
  const before = readFileSync(state.target, "utf8");
  const run = runScript(APPLY, state.target, state.home);
  const after = readFileSync(state.target, "utf8");
  const status = statusOf(state.home);
  check("0.15-shaped fixture: apply exits 0", run.status === 0, `exit=${run.status} ${run.stderr.trim().split("\n").at(-1) ?? ""}`);
  check("and reports both replay call sites patched", status.reason === "turnid-patched" && status.ok === true, `reason=${status.reason}`);
  check("and the file actually changed", after !== before && after.includes("event.turnId !== undefined"), "turnId spread missing");
  check("and the target parses (apply's own ESM syntax check ran)", run.stdout.includes("ESM syntax ok"), run.stdout.trim().split("\n").at(-1));
  check("and both marker comments are present", (after.match(/LOCAL PATCH \(paseo-dsh\): keep the turn id on replay/g) ?? []).length === 2);
  check("and the backup landed in REWIND_PATCH_HOME, not next to the target", typeof status.backup === "string" && dirname(status.backup) === state.home, `backup=${status.backup}`);
  check("and the backup holds the pre-patch bytes", readFileSync(status.backup, "utf8") === before);
  check("and the status records the upstream/patched md5 pair", typeof status.upstreamMd5 === "string" && typeof status.patchedMd5 === "string" && status.upstreamMd5 !== status.patchedMd5);
}

// ---- 2. idempotence ------------------------------------------------------
{
  const state = patchedFixture();
  const first = readFileSync(state.target, "utf8");
  const run = runScript(APPLY, state.target, state.home);
  const after = readFileSync(state.target, "utf8");
  const status = statusOf(state.home);
  check("second apply: exits 0", run.status === 0, `exit=${run.status}`);
  check("and is an idempotent no-op (`turnid-already-patched`)", status.reason === "turnid-already-patched" && status.ok === true, `reason=${status.reason}`);
  check("and leaves the bytes untouched", after === first);
}

// ---- 3. 0.14 shape + reformat still patch --------------------------------
{
  // The 0.14.0 dist carries the same replay call text, so this is the same
  // fixture — the point of the second run is the whitespace-elastic anchor:
  // a 2-space reformat must still patch (no md5 gate, no fixed indent).
  const twoSpace = fixture(agentManagerSource({ indent: "  " }));
  const run = runScript(APPLY, twoSpace.target, twoSpace.home);
  const after = readFileSync(twoSpace.target, "utf8");
  check("a 2-space reformat (0.14/0.15 anchor text) still patches", run.status === 0 && after.includes("event.turnId !== undefined"), `exit=${run.status}`);
  check("and the injected body still lands inside the 2-space method (turnId present)", after.includes("event.turnId !== undefined") && after.includes("\n  }\n}"), "turnId missing");
}

// ---- 4. clean file: checker/--check say "patchable", not "patched" -------
{
  const state = fixture(agentManagerSource());
  const run = runScript(CHECKER, state.target, state.home, ["--json"]);
  const parsed = jsonOf(run);
  check("checker on a clean file: exit 1 / `patchable`", run.status === 1 && parsed?.state === "patchable" && parsed?.code === 1 && parsed?.autoPatchable === true, `state=${parsed?.state} code=${parsed?.code}`);
  check("and it says both replay call sites were found", parsed?.summary?.includes("两处重放调用") === true, parsed?.summary);

  const applyCheck = runScript(APPLY, state.target, state.home, ["--check"]);
  check("apply --check on a clean file: exit 1 and names the patchable call sites", applyCheck.status === 1 && applyCheck.stdout.includes("NOT patched") && applyCheck.stdout.includes("both replay call sites found"), applyCheck.stdout.trim().split("\n")[0]);
}

// ---- 5. fail-closed states ----------------------------------------------
{
  const half = fixture(agentManagerSource({ sites: ["current", "current"] }).replace(`${MARKER_LINE}\n`, ""));
  const before = readFileSync(half.target, "utf8");
  const applyRun = runScript(APPLY, half.target, half.home);
  const status = statusOf(half.home);
  check("half-patched: apply exits 1 and names `turnid-partially-patched`", applyRun.status === 1 && status.reason === "turnid-partially-patched", `reason=${status.reason}`);
  check("and leaves the file byte-identical", readFileSync(half.target, "utf8") === before);
  const checkRun = runScript(CHECKER, half.target, half.home, ["--json"]);
  const parsed = jsonOf(checkRun);
  check("and the checker exits 2 / `partially-patched`", checkRun.status === 2 && parsed?.state === "partially-patched", `state=${parsed?.state}`);
}

{
  const single = fixture(agentManagerSource({ sites: ["clean", "clean"] }).replace(REPLAY_CALL, "            const row = this.recordTimeline(agent.id, event.item);"));
  const before = readFileSync(single.target, "utf8");
  const applyRun = runScript(APPLY, single.target, single.home);
  const status = statusOf(single.home);
  check("anchor mismatch: apply exits 1 and names `turnid-anchor-mismatch`", applyRun.status === 1 && status.reason === "turnid-anchor-mismatch", `reason=${status.reason}`);
  check("and leaves the file byte-identical", readFileSync(single.target, "utf8") === before);
  const parsed = jsonOf(runScript(CHECKER, single.target, single.home, ["--json"]));
  check("and the checker exits 2 / `anchor-mismatch`", parsed?.state === "anchor-mismatch" && parsed?.turnIdMatches === 1, `state=${parsed?.state} matches=${parsed?.turnIdMatches}`);
}

{
  const renamed = fixture(agentManagerSource({ renameContext: true }));
  const before = readFileSync(renamed.target, "utf8");
  const applyRun = runScript(APPLY, renamed.target, renamed.home);
  const status = statusOf(renamed.home);
  check("context mismatch: apply exits 1 and names `turnid-anchor-context-mismatch`", applyRun.status === 1 && status.reason === "turnid-anchor-context-mismatch", `reason=${status.reason}`);
  check("and leaves the file byte-identical", readFileSync(renamed.target, "utf8") === before);
  const parsed = jsonOf(runScript(CHECKER, renamed.target, renamed.home, ["--json"]));
  check("and the checker exits 2 / `anchor-context-mismatch`", parsed?.state === "anchor-context-mismatch" && parsed?.turnIdContext === 1, `state=${parsed?.state} context=${parsed?.turnIdContext}`);
}

// ---- 6. stale body is rebuilt in place ----------------------------------
{
  const state = fixture(agentManagerSource({ sites: ["old", "old"] }));
  const stale = readFileSync(state.target, "utf8");
  const checkRun = runScript(CHECKER, state.target, state.home, ["--json"]);
  const parsed = jsonOf(checkRun);
  check("stale body: checker exits 1 / `stale-body` / autoPatchable", checkRun.status === 1 && parsed?.state === "stale-body" && parsed?.autoPatchable === true, `state=${parsed?.state}`);
  const applyCheck = runScript(APPLY, state.target, state.home, ["--check"]);
  check("and apply --check offers the in-place rebuild", applyCheck.status === 1 && applyCheck.stdout.includes("re-run without --check to rebuild"), applyCheck.stdout.trim().split("\n")[0]);
  const applyRun = runScript(APPLY, state.target, state.home);
  const status = statusOf(state.home);
  const rebuilt = readFileSync(state.target, "utf8");
  check("apply rebuilds the stale body in place", applyRun.status === 0 && status.reason === "turnid-patched-from-stale" && status.ok === true, `reason=${status.reason} exit=${applyRun.status}`);
  check("and the rebuilt file is the current body (byte-equal to a fresh patch)", rebuilt === readFileSync(patchedFixture().target, "utf8"));
  check("and a prestale snapshot was written to REWIND_PATCH_HOME", typeof status.backup === "string" && dirname(status.backup) === state.home && status.backup.includes("prestale"), `backup=${status.backup}`);
  check("and the prestale snapshot holds the stale bytes", readFileSync(status.backup, "utf8") === stale);
  const after = jsonOf(runScript(CHECKER, state.target, state.home, ["--json"]));
  check("and the checker now reports `patched`", after?.state === "patched" && after?.code === 0, `state=${after?.state}`);
}

// ---- 7. unrebuildable stale body: checker and apply agree ----------------
{
  const state = fixture(agentManagerSource({ sites: ["unrebuildable", "current"] }));
  const before = readFileSync(state.target, "utf8");
  const checkRun = runScript(CHECKER, state.target, state.home, ["--json"]);
  const parsed = jsonOf(checkRun);
  check(
    "unrebuildable stale body: checker exits 2 / `stale-body-unrebuildable`",
    checkRun.status === 2 && parsed?.state === "stale-body-unrebuildable" && parsed?.autoPatchable === false,
    `state=${parsed?.state}`,
  );
  check("and names the blocking reason the apply path would report", parsed?.rebuildBlockedReason === "turnid-stale-anchor-mismatch", `reason=${parsed?.rebuildBlockedReason}`);
  const applyCheck = runScript(APPLY, state.target, state.home, ["--check"]);
  check("and apply --check says apply will refuse instead of promising a rebuild", applyCheck.status === 2 && applyCheck.stdout.includes("apply will refuse to rebuild"), applyCheck.stdout.trim().split("\n")[0]);
  const applyRun = runScript(APPLY, state.target, state.home);
  const status = statusOf(state.home);
  check("and apply actually refuses on the same file (agreement, not a promise)", applyRun.status === 1 && status.ok === false && status.reason === "turnid-stale-anchor-mismatch", `reason=${status.reason} exit=${applyRun.status}`);
  check("and the file is byte-identical", readFileSync(state.target, "utf8") === before);
}

// ---- 8. MUTATION WITNESS: markers 2/2 but the replay drops turnId --------
{
  // This is the shape a mutated apply script produces when `turnIdCall()` loses
  // `turnId` (the regression this check exists to catch): the marker count is
  // still 2, so a marker-only judgement — the old predicate — calls it healthy.
  const state = fixture(agentManagerSource({ sites: ["dropped-turnid", "dropped-turnid"] }));
  const source = readFileSync(state.target, "utf8");
  const markerCount = (source.match(/LOCAL PATCH \(paseo-dsh\): keep the turn id on replay/g) ?? []).length;
  const oldPredicateSaysPatched = markerCount === 2;
  check("witness: a patched body that drops turnId still has 2/2 markers", markerCount === 2 && oldPredicateSaysPatched, `markers=${markerCount}`);
  const run = runScript(CHECKER, state.target, state.home, ["--json"]);
  const parsed = jsonOf(run);
  check(
    "MUTATION: the checker reports `stale-body`, not `patched` (a marker-only check is green here)",
    run.status === 1 && parsed?.state === "stale-body" && parsed?.patchBody === "stale",
    `state=${parsed?.state} code=${parsed?.code}`,
  );
  const applyRun = runScript(APPLY, state.target, state.home);
  const status = statusOf(state.home);
  const repaired = readFileSync(state.target, "utf8");
  check(
    "and apply repairs it to the current body (turnId restored)",
    applyRun.status === 0 && status.reason === "turnid-patched-from-stale" && repaired.includes("event.turnId !== undefined"),
    `reason=${status.reason}`,
  );
  const after = jsonOf(runScript(CHECKER, state.target, state.home, ["--json"]));
  check("and the checker is green only after the repair", after?.state === "patched" && after?.code === 0, `state=${after?.state}`);
}

// ---- 9. --revert + missing target ---------------------------------------
{
  const state = fixture(agentManagerSource());
  const clean = readFileSync(state.target, "utf8");
  const applyRun = runScript(APPLY, state.target, state.home);
  const revertRun = runScript(APPLY, state.target, state.home, ["--revert"]);
  const status = statusOf(state.home);
  check("--revert: exits 0 and restores the pre-patch bytes", applyRun.status === 0 && revertRun.status === 0 && status.reason === "turnid-reverted" && readFileSync(state.target, "utf8") === clean, `reason=${status.reason}`);
  const second = runScript(APPLY, state.target, state.home, ["--revert"]);
  check("and a second --revert is an idempotent no-op", second.status === 0 && statusOf(state.home).reason === "turnid-revert-noop", `reason=${statusOf(state.home).reason}`);
}

{
  const missing = join(WORK, "no-such-agent-manager.js");
  const home = join(WORK, "home-missing");
  mkdirSync(home, { recursive: true });
  const applyRun = runScript(APPLY, missing, home);
  const status = statusOf(home);
  check("missing target: apply exits 1 / `turnid-target-missing`", applyRun.status === 1 && status.reason === "turnid-target-missing", `reason=${status.reason}`);
  const checkRun = runScript(CHECKER, missing, home, ["--json"]);
  check("and the checker exits 3 / `target-missing`", checkRun.status === 3 && jsonOf(checkRun)?.state === "target-missing", `exit=${checkRun.status}`);
}

rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
