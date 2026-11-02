/**
 * Offline checks for `local-patches/` (the optional Paseo host patch).
 *
 * The scripts under `local-patches/` rewrite an installed
 * `@getpaseo/server` dist tree, so their regressions cannot use the real
 * install. This check drives the real apply/check scripts in subprocesses with
 * `REWIND_PATCH_TARGET` / `REWIND_PATCH_TURNID_TARGET` pointed at scratch
 * fixtures, and asserts the machine-readable status file — the layer the
 * startup hook and `check-rewind-patch.mjs` actually branch on.
 *
 *   1. L1: a stale rebuild must not delete statements that live after the
 *      patch's own inserted CALL in `revert()`. The old region boundary ran
 *      from the `bridge.revert({…});` line to the method's closing brace, so an
 *      upstream cleanup or another local patch in that span was silently
 *      replaced; the result still parsed. The regression asserts the file is
 *      byte-identical and the status says `stale-patch-call-region-foreign`.
 *   2. The control: the same stale body without foreign statements is rebuilt
 *      (`patched-from-stale`), so case 1 cannot be satisfied by a script that
 *      refuses every rebuild.
 *   3. LP-02: `check-rewind-patch.mjs` must report the same runtime field gates
 *      apply runs. An upstream that keeps both anchors but renames
 *      `this.timelineSnapshots` used to read as `patchable` (exit 1, "apply
 *      will fix it") while apply always failed with `host-fields-changed`.
 *   4. LP-02: the #7675 history-object shape is `upstream-history-shape-changed`
 *      in the checker on both a clean and an already-patched file; apply refuses
 *      on both, so neither may read as patchable/patched.
 *   5. `apply --check` names the same two gates instead of a bare `NOT patched`.
 *   6. Controls: a compatible clean file is still `patchable`, and a compatible
 *      clean file still reads as "not patched" from `apply --check`.
 *
 * No installed `@getpaseo/server` is read or written: every target is a fixture
 * under the system temp directory, and only the scripts' exported logic plus
 * their `--check` read paths run against them.
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

const CALL_MARKER = "        // LOCAL PATCH (paseo-dsh): the force-hydrate that follows this reply reads";

/**
 * A source file in the shape the patch produces, but with a deliberately stale
 * method body. `tail` is inserted inside `revert()` *after* the patch's CALL —
 * the exact span the old rebuild overwrote.
 */
function stalePatchedSource({ tail = "", prefix = "" } = {}) {
  return [
    prefix,
    "class PluginAgentSession {",
    "    constructor() {",
    "        this.history = [];",
    "        this.timelineSnapshots = new Map();",
    "        this.revertTokens = new Map();",
    "    }",
    "    /**",
    "     * LOCAL PATCH (paseo-dsh): stale copy of the injected method.",
    "     */",
    "    truncateHistoryFrom(messageId) {",
    "        return false;",
    "    }",
    "    async revert(messageId, scope) {",
    "        const token = this.revertTokens.get(messageId);",
    "        await this.bridge.revert({",
    '            type: "session.revert",',
    "            requestId: randomUUID(),",
    "            sessionId: this.bridge.providerId,",
    "            token,",
    "            scope,",
    "        });",
    CALL_MARKER,
    '        if (scope !== "files" && !this.truncateHistoryFrom(messageId)) {',
    "            process.stderr.write(`[plugin-provider] rewind ${messageId}: no history row carries this id; `",
    '                + "the timeline keeps the withdrawn turns until the agent is reloaded\\n");',
    "        }",
    tail,
    "    }",
    "    publish(event) {",
    "        this.history.push(event);",
    "        this.emit(event);",
    "    }",
    "}",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * A clean (unpatched) source with both anchors and the three host fields the
 * injected body dereferences. `omitTimelineSnapshots` removes the field, which
 * is the LP-02 rename shape.
 */
function cleanSource({ omitTimelineSnapshots = false, historyObjectShape = false } = {}) {
  return [
    historyObjectShape ? "// this is what #7675 uses: new PluginSessionHistory(history)" : "",
    "class PluginAgentSession {",
    "    constructor() {",
    "        this.history = [];",
    omitTimelineSnapshots ? "" : "        this.timelineSnapshots = new Map();",
    "        this.revertTokens = new Map();",
    "    }",
    "    consume(item) {",
    omitTimelineSnapshots
      ? "        return mapTimelineItem(item, undefined, this.revertTokens);"
      : "        return mapTimelineItem(item, this.timelineSnapshots, this.revertTokens);",
    "    }",
    "    async revert(messageId, scope) {",
    "        const token = this.revertTokens.get(messageId);",
    "        await this.bridge.revert({",
    '            type: "session.revert",',
    "            requestId: randomUUID(),",
    "            sessionId: this.bridge.providerId,",
    "            token,",
    "            scope,",
    "        });",
    "    }",
    "    publish(event) {",
    "        this.history.push(event);",
    "        this.emit(event);",
    "    }",
    "}",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** One scratch target + its own status/backup home. */
let fixtureCount = 0;
function fixture(source) {
  fixtureCount += 1;
  const target = join(WORK, `plugin-provider-${String(fixtureCount)}.js`);
  const home = join(WORK, `home-${String(fixtureCount)}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(target, source);
  writeFileSync(join(WORK, `turnid-${String(fixtureCount)}.js`), "// no turnId anchors\n");
  return { target, home, turnIdTarget: join(WORK, `turnid-${String(fixtureCount)}.js`) };
}

function runScript(script, target, home, turnIdTarget, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      REWIND_PATCH_TARGET: target,
      REWIND_PATCH_TURNID_TARGET: turnIdTarget,
      REWIND_PATCH_HOME: home,
    },
  });
}

function statusOf(home) {
  return JSON.parse(readFileSync(join(home, "rewind-patch.status.json"), "utf8"));
}

// ---- 1. L1: the stale rebuild must not delete a foreign tail -------------
{
  const tail = "        this.upstreamCleanupAfterRewind();";
  const fixtureState = fixture(stalePatchedSource({ tail }));
  const before = readFileSync(fixtureState.target, "utf8");
  const run = runScript(APPLY, fixtureState.target, fixtureState.home, fixtureState.turnIdTarget, []);
  const after = readFileSync(fixtureState.target, "utf8");
  const status = statusOf(fixtureState.home);
  check(
    "a stale rebuild with a foreign statement after CALL leaves the file byte-identical",
    after === before,
    `md5changed=${after !== before}`,
  );
  check(
    "and the status names stale-patch-call-region-foreign instead of success",
    status.patches?.rewind?.reason === "stale-patch-call-region-foreign",
    `reason=${status.patches?.rewind?.reason}`,
  );
  check(
    "and the warning names the statement it would have deleted",
    run.stderr.includes("cannot be rebuilt safely") && run.stderr.includes("this.upstreamCleanupAfterRewind();"),
    run.stderr.trim().split("\n").slice(0, 3).join(" | "),
  );
  check(
    "and the unrelated tail is still present on disk",
    after.includes("this.upstreamCleanupAfterRewind();"),
  );
}

// ---- 2. control: a stale body without foreign content is rebuilt ---------
{
  const fixtureState = fixture(stalePatchedSource());
  const run = runScript(APPLY, fixtureState.target, fixtureState.home, fixtureState.turnIdTarget, []);
  const status = statusOf(fixtureState.home);
  const after = readFileSync(fixtureState.target, "utf8");
  check(
    "the control: a stale body with no foreign content is rebuilt",
    status.patches?.rewind?.reason === "patched-from-stale" && status.patches?.rewind?.ok === true,
    `reason=${status.patches?.rewind?.reason} exit=${run.status}`,
  );
  check(
    "and the rebuilt body is the current METHOD (not the stale stub)",
    after.includes("this.timelineSnapshots.clear();") && after.includes("this.revertTokens.delete(id);"),
    after.includes("this.timelineSnapshots.clear();") ? "rebuilt" : "METHOD missing",
  );
}

// ---- 3. LP-02: checker reports host-fields-changed ----------------------
{
  const fixtureState = fixture(cleanSource({ omitTimelineSnapshots: true }));
  const run = runScript(CHECKER, fixtureState.target, fixtureState.home, fixtureState.turnIdTarget, ["--json"]);
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    parsed = undefined;
  }
  check(
    "a clean file whose fields apply rejects is host-fields-changed, not patchable",
    parsed?.state === "host-fields-changed" && parsed?.code === 2 && parsed?.ok === false,
    `state=${parsed?.state} code=${parsed?.code}`,
  );
  check("and it is not autoPatchable", parsed?.autoPatchable === false);
  check("and the missing field is named", parsed?.hostField === "this.timelineSnapshots" && parsed?.hostFieldMissing?.length > 0);
}

// ---- 4. LP-02: checker reports upstream-history-shape-changed -----------
{
  const clean = fixture(cleanSource({ historyObjectShape: true }));
  const cleanRun = runScript(CHECKER, clean.target, clean.home, clean.turnIdTarget, ["--json"]);
  let cleanParsed;
  try {
    cleanParsed = JSON.parse(cleanRun.stdout);
  } catch {
    cleanParsed = undefined;
  }
  check(
    "a clean #7675-shaped file is upstream-history-shape-changed, not patchable",
    cleanParsed?.state === "upstream-history-shape-changed" && cleanParsed?.code === 2,
    `state=${cleanParsed?.state} code=${cleanParsed?.code}`,
  );

  const patched = fixture(stalePatchedSource({ prefix: "// new PluginSessionHistory(history)" }));
  const patchedRun = runScript(CHECKER, patched.target, patched.home, patched.turnIdTarget, ["--json"]);
  let patchedParsed;
  try {
    patchedParsed = JSON.parse(patchedRun.stdout);
  } catch {
    patchedParsed = undefined;
  }
  check(
    "an already-patched #7675-shaped file is upstream-history-shape-changed, not patched",
    patchedParsed?.state === "upstream-history-shape-changed" && patchedParsed?.code === 2,
    `state=${patchedParsed?.state} code=${patchedParsed?.code}`,
  );
}

// ---- 5. LP-02: apply --check names the same gates ------------------------
{
  const hostFields = fixture(cleanSource({ omitTimelineSnapshots: true }));
  const hostRun = runScript(APPLY, hostFields.target, hostFields.home, hostFields.turnIdTarget, ["--check"]);
  const hostLine = hostRun.stdout.split("\n").find((line) => line.startsWith("[rewind-patch] rewind:")) ?? "";
  check(
    "apply --check names host-fields-changed instead of a bare NOT patched",
    hostLine.includes("host-fields-changed") && !hostLine.includes("NOT patched"),
    hostLine.trim(),
  );

  const history = fixture(cleanSource({ historyObjectShape: true }));
  const historyRun = runScript(APPLY, history.target, history.home, history.turnIdTarget, ["--check"]);
  const historyLine = historyRun.stdout.split("\n").find((line) => line.startsWith("[rewind-patch] rewind:")) ?? "";
  check(
    "apply --check names upstream-history-shape-changed instead of a bare NOT patched",
    historyLine.includes("upstream-history-shape-changed") && !historyLine.includes("NOT patched"),
    historyLine.trim(),
  );
}

// ---- 6. controls: a compatible clean file is still patchable -------------
{
  const fixtureState = fixture(cleanSource());
  const checkerRun = runScript(CHECKER, fixtureState.target, fixtureState.home, fixtureState.turnIdTarget, ["--json"]);
  let parsed;
  try {
    parsed = JSON.parse(checkerRun.stdout);
  } catch {
    parsed = undefined;
  }
  check(
    "the control: a compatible clean file is still patchable (exit 1)",
    parsed?.state === "patchable" && parsed?.code === 1 && parsed?.ok === true,
    `state=${parsed?.state} code=${parsed?.code}`,
  );
  check(
    "and hostFieldShapes did not fail on it",
    parsed?.hostField === null || parsed?.hostField === undefined,
    `hostField=${parsed?.hostField}`,
  );

  const applyRun = runScript(APPLY, fixtureState.target, fixtureState.home, fixtureState.turnIdTarget, ["--check"]);
  check(
    "and apply --check still reports it as NOT patched, not as a gate failure",
    applyRun.stdout.includes("NOT patched") && !applyRun.stdout.includes("host-fields-changed"),
    applyRun.stdout.trim().split("\n")[0],
  );
}

rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
