#!/usr/bin/env node
/**
 * LOCAL PATCH (paseo-dsh) — keep the turn id when replaying provider history.
 *
 * WHY THIS FILE KEEPS THE OLD NAME
 * --------------------------------
 * It used to patch two things: (1) `plugin-provider.js` — truncate the
 * translated `this.history` inside `revert()`, so the force-hydrate that
 * follows the reply reads a shortened history (Paseo issue #4667); and
 * (2) `agent-manager.js` — keep the `turnId` on the two history-replay paths.
 *
 * The rewind half is RETIRED. Paseo 0.15.0 fixes #4667 natively (upstream
 * PR #8368): `PluginAgentSession.revert()` now closes the provider session and
 * reopens it with the negotiated persistence handle, so the replayed history is
 * already the rewound one. The array the old patch truncated no longer exists
 * either (PR #7675 replaced `this.history` with `PluginSessionHistory`, which
 * has no truncate operation), so the old patch refuses to apply to 0.15 by
 * design — it would be a runtime no-op. Keeping a target that must never apply
 * would only put a permanent failure into the daemon's start-up path.
 *
 * Rollback to Paseo 0.14.0 degrades to "rewind works, but the timeline only
 * refreshes after Reload agent / reopening the session" (the canary tells the
 * user). That is documented and accepted in `UPGRADE.md` §7 — 0.14 is not
 * patched any more.
 *
 * The file name is kept because the deployed systemd `ExecStartPre` and the
 * `NODE_OPTIONS` startup hook point at this exact path; renaming it would
 * touch every install for no functional gain.
 *
 * WHAT THE REMAINING PATCH FIXES
 * ------------------------------
 * `agent-manager.js` has two history-replay paths
 * (`forceHydrateTimelineFromLegacyProviderHistory`,
 * `primeTimelineFromLegacyProviderHistory`). Both record replayed items with
 * `recordTimeline(agent.id, event.item, event.timestamp ? { timestamp } :
 * undefined)` — dropping the `turnId` the replayed event already carries.
 * `recordTimeline` accepts `options.turnId` and the live path passes it, so a
 * reopened long conversation loses its turn grouping: the app cannot fold the
 * turns and shows every replayed step as its own block. Paseo 0.15.0 still has
 * this defect (both call sites are unchanged), so the patch is still needed.
 *
 * IDEMPOTENT — run it before every daemon start (`ExecStartPre`).
 * Fails closed: missing target, half-patched file, ambiguous or missing anchor,
 * or a post-write syntax failure => exit 1, with the backup restored.
 *
 * Usage: node apply-rewind-history-truncation.mjs [--check] [--revert]
 *
 * Exit codes (the authoritative table is also in UPGRADE.md §2):
 *   apply (default) / --revert:
 *     0  patched, already patched, stale body rebuilt in place / reverted
 *     1  any failure — nothing is left half-written; the status file names why
 *   --check (read-only, writes nothing):
 *     0  patched and the injected body is current
 *     1  not patched but patchable, or a stale body apply can rebuild in place
 *     2  needs a human: half-patched, anchor mismatch, or a stale body apply
 *        cannot rebuild (reinstall @getpaseo/cli, then re-run)
 *     3  target file missing (paseo not installed, or the install path moved)
 *
 * Env (test-only; both default to the directory this script lives in):
 *   REWIND_PATCH_TURNID_TARGET  path to agent-manager.js to operate on
 *   REWIND_PATCH_HOME           where backups + rewind-patch.status.json go
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Where `@getpaseo/server` actually lives on this machine.
 *
 * The daemon loads its code from the *installed* package, not from any repo
 * checkout, so the patch has to find that install. Rather than hard-code one
 * machine's path, resolve it from the `paseo` executable: the CLI package
 * carries `@getpaseo/server` in its own `node_modules`, and the executable's
 * realpath points straight at it. `PASEO_CLI_ROOT` overrides the search for
 * unusual layouts (a global prefix not on PATH, a pnpm store, a test fixture).
 *
 * Returns null when neither works — callers then fail with a message that says
 * how to point at the install.
 */
function resolvePaseoCliRoot() {
  const fromEnv = process.env.PASEO_CLI_ROOT;
  if (typeof fromEnv === "string" && fromEnv !== "" && existsSync(fromEnv)) return fromEnv;
  // The `paseo` on PATH is a symlink into the CLI package; its realpath ends in
  // `.../@getpaseo/cli/bin/paseo`, so the package root is three levels up.
  for (const name of ["paseo", "paseo.cmd", "paseo.ps1"]) {
    const found = whichSync(name);
    if (found === null) continue;
    let real;
    try {
      real = realpathSync(found);
    } catch {
      continue;
    }
    // .../@getpaseo/cli/bin/paseo -> .../@getpaseo/cli
    const candidate = dirname(dirname(real));
    if (existsSync(join(candidate, "node_modules", "@getpaseo", "server"))) return candidate;
  }
  return null;
}

/**
 * Minimal `which`: walk PATH ourselves instead of shelling out, so this works
 * the same on every platform and cannot be fooled by a shell alias.
 *
 * @param {string} name
 * @returns {string | null}
 */
function whichSync(name) {
  const pathValue = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  for (const dir of pathValue.split(separator)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

const PASEO_CLI_ROOT = resolvePaseoCliRoot();
const AGENT_DIR = PASEO_CLI_ROOT === null
  ? null
  : join(PASEO_CLI_ROOT, "node_modules", "@getpaseo", "server", "dist", "server", "server", "agent");

/**
 * The one file this script patches: Paseo's `agent-manager.js`, whose two
 * history-replay paths drop the `turnId` the events already carry.
 *
 * `REWIND_PATCH_TURNID_TARGET` exists so a self-test can point at a scratch
 * copy (the env var name is historical — see the header; `REWIND_PATCH_HOME`
 * likewise names where backups/status go).
 */
const TURNID_TARGET =
  process.env.REWIND_PATCH_TURNID_TARGET
  ?? (AGENT_DIR === null ? "" : join(AGENT_DIR, "agent-manager.js"));

const HOME_DIR = process.env.REWIND_PATCH_HOME ?? dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = HOME_DIR;
// Kept under the historical name: the startup hook, the checker and the
// deployed drop-ins already agree on it, and the machine's current file is
// read by the next run. Renaming it would leave a stale twin behind on every
// install for no functional gain.
const STATUS_FILE = join(HOME_DIR, "rewind-patch.status.json");

/**
 * This patch's own marker.
 *
 * The two patches used to live in different files and each file's marker count
 * decided "is this file clean / patched / half-patched". Only the turnId marker
 * remains, but the same rule applies to it.
 */
const TURNID_MARKER = "LOCAL PATCH (paseo-dsh): keep the turn id on replay";

/**
 * The exact call both replay paths make, spelled out in full so it is specific
 * on its own. It occurs **twice** in a clean file — once in
 * `forceHydrateTimelineFromLegacyProviderHistory`, once in
 * `primeTimelineFromLegacyProviderHistory` — and each must match exactly once.
 * Capture group 1 = the call's indentation, reused for the replacement.
 *
 * `[ \t]*$` per line and `\r?\n` keep it whitespace-elastic: a reformat still
 * patches, only a real rewrite fails. Measured identical in the 0.14.0 and
 * 0.15.0 dist trees (the two replay sites did not change between those
 * releases), so one anchor serves both.
 */
const TURNID_CALL_RE =
  /^([ \t]*)const row = this\.recordTimeline\(agent\.id, event\.item, event\.timestamp \? \{ timestamp: event\.timestamp \} : undefined\);[ \t]*$/gm;

/**
 * The line that follows each occurrence, used to prove the two matches are the
 * two replay paths and not two copies of the same one.
 *
 * `forceHydrate…` is followed by `if (broadcastTimeline) {`; `primeTimeline…`
 * is followed by `if (deferredBroadcast) {`. The two are asserted *in order*:
 * force-hydrate precedes prime in the file, so a reordered or duplicated pair
 * fails loudly instead of patching the wrong sites.
 */
const TURNID_CONTEXTS = ["if (broadcastTimeline) {", "if (deferredBroadcast) {"];

/**
 * Build the patched call.
 *
 * The timestamp ternary is kept verbatim (just moved into the object literal) so
 * the patched line still reads like the original, and `turnId` is added only
 * when the event has one: `recordTimeline` treats `options?.turnId` as absent
 * when it is `undefined`, so spreading unconditionally would be equivalent — but
 * keeping the guard means a history event without an id keeps producing a row
 * without one, which is what the live path does too.
 *
 * @param {string} indent - the call's own indentation in this file.
 * @returns {string} the replacement block, without a trailing newline.
 */
function turnIdCall(indent) {
  return [
    `${indent}// ${TURNID_MARKER} — the replay already has it;`,
    `${indent}// the timeline-store row needs it for the app to fold turns after a reopen.`,
    `${indent}const row = this.recordTimeline(agent.id, event.item, {`,
    `${indent}    ...(event.timestamp ? { timestamp: event.timestamp } : {}),`,
    `${indent}    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),`,
    `${indent}});`,
  ].join("\n");
}

function md5(text) {
  return createHash("md5").update(text).digest("hex");
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Fresh scan every call — `matchAll` clones the regex, but be explicit. */
function matchAll(regex, text) {
  regex.lastIndex = 0;
  return [...text.matchAll(regex)];
}

/**
 * Scratch dir for the ESM syntax check.  Removed on exit.
 */
let checkDir = null;

function cleanupCheckDir() {
  if (checkDir === null) return;
  try {
    rmSync(checkDir, { recursive: true, force: true });
  } catch {
    /* best effort — it lives under os.tmpdir() */
  }
  checkDir = null;
}
process.on("exit", cleanupCheckDir);

/**
 * Syntax-check a file **as ESM**.
 *
 * `node --check <file>.js` is worthless here: Node picks the module system from
 * the extension, so a `.js` file whose nearest package.json has no
 * `"type": "module"` is treated as CommonJS and a syntax error inside ESM-only
 * syntax goes unreported.  Measured on node v22.23.1 with identical bytes:
 * `.js` => exit 0, `.mjs` => exit 1 (SyntaxError).  agent-manager.js is ESM, so
 * the old check silently passed everything — including a broken patch.
 *
 * Copy to a scratch `.mjs` and check that instead (~30 ms for 130 KB).
 *
 * Throws on failure so callers can roll back; never calls `process.exit`, or the
 * rollback would be unreachable.
 *
 * Two distinct failure modes, deliberately distinguished by `.code`:
 *   - `SYNTAX_CHECK_UNAVAILABLE` — the *checker* could not run (EACCES/ENOSPC on
 *     the scratch dir, node missing).  Nothing is known about the content, and
 *     the cause is environmental, so callers must not report "the patch has a
 *     syntax error" — that sends the reader hunting in the wrong file.
 *   - `SYNTAX_CHECK_FAILED` — the checker ran and rejected the content.
 */
class SyntaxCheckUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "SyntaxCheckUnavailable";
    this.code = "SYNTAX_CHECK_UNAVAILABLE";
  }
}

function ensureCheckDir() {
  if (checkDir !== null) return;
  try {
    checkDir = mkdtempSync(join(tmpdir(), "rewind-patch-check-"));
  } catch (error) {
    throw new SyntaxCheckUnavailable(
      `could not create a scratch dir to verify the patch (${error.code ?? "error"}: ${error.message}). `
      + "This is an environment problem (tmpdir permissions / disk), not a patch problem.",
    );
  }
}

/**
 * Run `node --check` on a scratch `.mjs` copy and classify the outcome.
 *
 * @param {string} copy - path to the scratch file.
 * @param {string} displayName - what to print in diagnostics (never the scratch path).
 */
function runNodeCheck(copy, displayName) {
  try {
    execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" });
  } catch (error) {
    // Spawn failure (node missing) is not a verdict on the content.
    if (error.code === "ENOENT" || error.code === "EACCES") {
      throw new SyntaxCheckUnavailable(
        `could not run ${process.execPath} --check (${error.code}: ${error.message}).`,
      );
    }
    const detail = (error.stderr?.toString() ?? error.message)
      .split(copy)
      .join(displayName) // report the real path, not the scratch copy
      .trim();
    const verdict = new Error(`ESM syntax check failed on ${displayName}: ${detail}`);
    verdict.code = "SYNTAX_CHECK_FAILED";
    throw verdict;
  }
}

function syntaxCheck(file) {
  ensureCheckDir();
  const copy = join(checkDir, `${basename(file).replace(/[^\w.-]/g, "_")}.mjs`);
  try {
    copyFileSync(file, copy);
  } catch (error) {
    throw new SyntaxCheckUnavailable(
      `could not copy ${file} into the scratch dir (${error.code ?? "error"}: ${error.message}). `
      + "This is an environment problem, not a patch problem.",
    );
  }
  runNodeCheck(copy, file);
}

let inlineCheckCount = 0;

/**
 * Syntax-check content that is not on disk yet (the in-memory stale rebuild).
 *
 * The read-only rebuild plan has to answer "would this rebuilt body parse?"
 * *before* `--check` promises a rebuild — otherwise a checker can promise a
 * rebuild that apply refuses (LP-02). The scratch file lives in tmpdir and is
 * removed immediately; the target is never touched.
 *
 * @param {string} source - candidate file content.
 */
function syntaxCheckSource(source) {
  ensureCheckDir();
  inlineCheckCount += 1;
  const copy = join(checkDir, `inline-${process.pid}-${inlineCheckCount}.mjs`);
  try {
    writeFileSync(copy, source, "utf8");
  } catch (error) {
    throw new SyntaxCheckUnavailable(
      `could not write a scratch copy to verify the rebuilt body (${error.code ?? "error"}: ${error.message}).`,
    );
  }
  try {
    runNodeCheck(copy, "<in-memory turnId rebuild>");
  } finally {
    try {
      unlinkSync(copy);
    } catch {
      /* the whole checkDir is removed on exit */
    }
  }
}

/**
 * Write `content` to `target` **atomically**: write a sibling temp file, fsync
 * nothing (the daemon reads it right after), then `renameSync` over the target.
 *
 * Why this exists: the previous code did `writeFileSync(TARGET, patched)` and
 * only then checked syntax.  A write that fails partway (ENOSPC, EDQUOT, a kill)
 * leaves a *truncated* file behind — the write is not atomic — and the recovery
 * path was unreachable, so the daemon came up against a half-written module
 * while `status.json` still said `ok: true`.
 *
 * `renameSync` within one directory is atomic on every POSIX filesystem: readers
 * (including a concurrent `ExecStartPre` or the daemon) see either the old file
 * or the new one, never a prefix of the new one.  A failure before the rename
 * leaves the original untouched.
 */
function atomicWrite(target, content) {
  const temporary = join(dirname(target), `.${basename(target)}.rewind-patch.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, target);
  } catch (error) {
    // Leave no debris; the original target was never touched.
    try {
      unlinkSync(temporary);
    } catch {
      /* already gone or never created */
    }
    throw error;
  }
}

/** Trimmed, comment-free, blank-free lines — the unit `turnIdStaleness` compares. */
function codeLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) => !line.startsWith("*") && !line.startsWith("/*") && !line.startsWith("//"));
}

function turnIdStaleness(source) {
  // Locate each patched replay call by its own marker comment, not by the
  // pre-patch shape.  `TURNID_CALL_RE` matches the *original* one-line call, which
  // by definition no longer exists once the patch is applied — using it here made
  // every correctly patched file read as stale (measured: `matched 0 time(s)` on a
  // good file), which is the opposite failure of the one this check exists for.
  const lines = source.split("\n");
  const regions = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes(TURNID_MARKER)) continue;
    const indent = /^[ \t]*/u.exec(lines[index])[0];
    // The replacement is exactly `turnIdCall(indent)`'s lines: two marker
    // comments, then `const row = …` through `});`.
    const expected = codeLines(turnIdCall(indent));
    // Collect the candidate region: from this line to the first `});` at the same
    // indentation.
    // Exact indentation, not `startsWith`: a deeper `});` (e.g. the one closing
    // `dispatchStream(...)` inside the replay loop) also starts with this
    // indent, and accepting it would stretch the region past its own call.
    const closeIndex = lines.findIndex(
      (line, at) => at > index && line.trim() === "});" && /^[ \t]*/u.exec(line)[0] === indent,
    );
    if (closeIndex === -1) {
      return { current: false, detail: `the turnId region starting at line ${String(index + 1)} has no closing \`});\`` };
    }
    const actual = codeLines(lines.slice(index, closeIndex + 1).join("\n"));
    if (actual.join("\n") !== expected.join("\n")) {
      return {
        current: false,
        detail: `the turnId region starting at line ${String(index + 1)} does not match turnIdCall() (older or edited body)`,
      };
    }
    regions.push({ index, closeIndex });
    index = closeIndex;
  }
  if (regions.length !== 2) {
    return { current: false, detail: `found ${String(regions.length)} turnId region(s), expected 2` };
  }
  return { current: true, detail: "both turnId regions match turnIdCall()" };
}

/**
 * Read-only plan for rebuilding a stale turnId body, shared by `apply` and
 * `--check`.
 *
 * The stale path is not "re-apply from a clean baseline": it replaces each
 * marker-led region in place.  That makes two things checkable *before* writing:
 *
 *   1. each region must actually be a replay call — exactly one
 *      `const row = this.recordTimeline(agent.id, event.item…` line between the
 *      marker and the region's closing `});`.  Without this, a stale body whose
 *      closing brace moved (or an edited region) would make the "nearest `});`
 *      at the same indent" heuristic swallow unrelated statements, and the
 *      rebuild would delete them (the L1 defect class, one layer down);
 *   2. the rebuilt file must parse — checked in memory through a scratch file.
 *
 * `--check` must answer the same question `apply` will.  The LP-02 lesson is
 * exactly this: a checker that promises a rebuild apply refuses is a false
 * green.  Both call this function, and apply writes `plan.rebuilt` verbatim, so
 * the two cannot disagree.
 *
 * @param {string} source - an already-patched file.
 * @returns {{ok: true, rebuilt: string, regions: Array<{index: number, closeIndex: number}>} | {ok: false, reason: string, detail: string}}
 */
function turnIdRebuildPlan(source) {
  const lines = source.split("\n");
  const regions = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes(TURNID_MARKER)) continue;
    const indent = /^[ \t]*/u.exec(lines[index])[0];
    // Exact indentation, not `startsWith`: a deeper `});` (e.g. the one closing
    // `dispatchStream(...)` inside the replay loop) also starts with this
    // indent, and accepting it would stretch the region past its own call.
    const closeIndex = lines.findIndex(
      (line, at) => at > index && line.trim() === "});" && /^[ \t]*/u.exec(line)[0] === indent,
    );
    if (closeIndex === -1) {
      return {
        ok: false,
        reason: "turnid-stale-anchor-mismatch",
        detail: `the turnId region starting at line ${String(index + 1)} has no closing \`});\``,
      };
    }
    // Structural guard: the region must be one replay call, not a runaway span.
    const regionCode = codeLines(lines.slice(index, closeIndex + 1).join("\n"));
    const callLines = regionCode.filter((line) => line.includes("this.recordTimeline(agent.id, event.item"));
    if (callLines.length !== 1) {
      return {
        ok: false,
        reason: "turnid-stale-anchor-mismatch",
        detail: `the turnId region starting at line ${String(index + 1)} contains `
          + `${String(callLines.length)} replay call(s), expected exactly 1`,
      };
    }
    regions.push({ index, closeIndex });
    index = closeIndex;
  }
  if (regions.length !== 2) {
    return {
      ok: false,
      reason: "turnid-stale-anchor-mismatch",
      detail: `found ${String(regions.length)} turnId region(s), expected exactly 2`,
    };
  }
  const rebuiltLines = source.split("\n");
  for (const region of [...regions].reverse()) {
    const indent = /^[ \t]*/u.exec(rebuiltLines[region.index])[0];
    rebuiltLines.splice(region.index, region.closeIndex - region.index + 1, ...turnIdCall(indent).split("\n"));
  }
  const rebuilt = rebuiltLines.join("\n");
  if (countOccurrences(rebuilt, TURNID_MARKER) !== 2) {
    return {
      ok: false,
      reason: "turnid-stale-rebuild-marker-wrong",
      detail: `the rebuild produced ${String(countOccurrences(rebuilt, TURNID_MARKER))} marker(s), expected 2`,
    };
  }
  try {
    syntaxCheckSource(rebuilt);
  } catch (error) {
    return {
      ok: false,
      reason: error.code === "SYNTAX_CHECK_UNAVAILABLE" ? "turnid-syntax-check-unavailable" : "turnid-stale-rebuild-unparsable",
      detail: error.message,
    };
  }
  return { ok: true, rebuilt, regions };
}

/**
 * `@getpaseo/cli` version, for the status file only.  Walk up from the target so
 * a non-default install layout still resolves; fall back to the global path.
 * Returns null when nothing readable is found — never throws.
 */
function readPaseoVersion() {
  const fromPackage = (dir) => {
    const pkg = join(dir, "package.json");
    if (!existsSync(pkg)) return null;
    try {
      const parsed = JSON.parse(readFileSync(pkg, "utf8"));
      return parsed.name === "@getpaseo/cli" ? (parsed.version ?? null) : null;
    } catch {
      return null;
    }
  };

  let dir = dirname(TURNID_TARGET);
  for (let depth = 0; depth < 10; depth += 1) {
    const version = fromPackage(dir);
    if (version !== null) return version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return PASEO_CLI_ROOT === null ? null : fromPackage(PASEO_CLI_ROOT);
}

function writeStatus(payload) {
  try {
    writeFileSync(STATUS_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    // Never let diagnostics mask the real failure.
    process.stderr.write(`[rewind-patch] WARNING: could not write ${STATUS_FILE}: ${error.message}\n`);
  }
}

function statusPayload({ ok, reason, message, targetMd5 = null, extra = {} }) {
  return {
    ok,
    at: new Date().toISOString(),
    reason,
    target: TURNID_TARGET,
    targetMd5,
    paseoVersion: readPaseoVersion(),
    message,
    ...extra,
  };
}

/**
 * Record the failure, say it loudly on stderr, exit 1.
 *
 * The status file is written first: the startup hook only keeps one log line,
 * so the status file is what a later `check-rewind-patch.mjs` run (and a human)
 * actually sees.
 */
function die(reason, message, { targetMd5 = null, extra = {} } = {}) {
  writeStatus(statusPayload({ ok: false, reason, message, targetMd5, extra }));
  process.stderr.write(`[rewind-patch] FATAL: ${message}\n`);
  process.exit(1);
}

function succeed({ reason, message, targetMd5, extra = {} }) {
  writeStatus(statusPayload({ ok: true, reason, message, targetMd5, extra }));
}

/**
 * Best-effort record of a failure that escaped `main()` entirely.
 *
 * This is the outermost net.  Without it, any unexpected throw (a code bug, an
 * errno nobody anticipated) exits with a stack trace and *no* status file — so
 * `check-rewind-patch.mjs` keeps reporting whatever the last run said, which is
 * how a broken install looks healthy.
 *
 * Kept dependency-free on purpose: it may run when the filesystem is the thing
 * that is broken, so everything in here is wrapped.
 */
function recordUnhandled(error) {
  let targetMd5 = null;
  try {
    targetMd5 = existsSync(TURNID_TARGET) ? md5(readFileSync(TURNID_TARGET, "utf8")) : null;
  } catch {
    /* unreadable target is part of what we are reporting */
  }
  try {
    writeStatus({
      ok: false,
      at: new Date().toISOString(),
      reason: "unhandled",
      target: TURNID_TARGET,
      targetMd5,
      paseoVersion: null,
      message: `补丁脚本异常终止（未预期错误，非锚点/上游问题）：${error?.message ?? error}。`
        + "turnId 补丁状态未知，请人工确认目标文件是否完整。",
      errorName: error?.name ?? null,
      errorCode: error?.code ?? null,
      errorMessage: String(error?.message ?? error),
      errorStack: String(error?.stack ?? "").split("\n").slice(0, 6),
    });
  } catch {
    /* nothing more we can do */
  }
  try {
    process.stderr.write(`[rewind-patch] FATAL: unexpected error: ${error?.stack ?? error}\n`);
  } catch {
    /* stderr gone too */
  }
  process.exit(1);
}

function turnIdBackupPath(sourceMd5) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  return join(BACKUP_DIR, `${basename(TURNID_TARGET)}.orig-turnid-${timestamp}-${sourceMd5.slice(0, 8)}`);
}

/** Newest turnId backup, or null. Sorted by name — the name carries the timestamp. */
function latestTurnIdBackup() {
  let candidates;
  try {
    candidates = readdirSync(BACKUP_DIR).filter((name) =>
      name.startsWith(`${basename(TURNID_TARGET)}.orig-turnid-`),
    );
  } catch {
    return null;
  }
  candidates.sort();
  return candidates.length > 0 ? join(BACKUP_DIR, candidates[candidates.length - 1]) : null;
}

/**
 * Apply the turnId patch to `TURNID_TARGET`. Idempotent.
 *
 * The three states are refused rather than guessed at: 0 markers = clean,
 * 2 = patched, anything else means someone/something wrote half of it.
 */
function applyTurnIdPatch() {
  if (!existsSync(TURNID_TARGET)) {
    die("turnid-target-missing", `target not found: ${TURNID_TARGET}`, {
      extra: { turnIdTarget: TURNID_TARGET },
    });
  }

  const source = readFileSync(TURNID_TARGET, "utf8");
  const current = md5(source);
  const markers = countOccurrences(source, TURNID_MARKER);

  if (markers === 2) {
    // Markers prove presence, not currency.
    const stale = turnIdStaleness(source);
    if (stale.current) {
      succeed({
        reason: "turnid-already-patched",
        targetMd5: current,
        message: "turnId 补丁已在位（幂等命中），无需动作。重开会话可正常折叠轮次。",
        extra: { turnIdTarget: TURNID_TARGET, turnIdMarkers: markers, patchBody: "current" },
      });
      process.stdout.write(`[rewind-patch] turnId: already patched (md5 ${current}), nothing to do\n`);
      return;
    }
    process.stdout.write(`[rewind-patch] turnId: patch body is STALE (${stale.detail}) — rebuilding\n`);
    // Rebuild in place.  The plan does the whole job in memory — region
    // detection, structural guard, rebuild, marker count and an in-memory syntax
    // check — so a failure here leaves the file untouched and `--check` can
    // answer the same question with the same code.
    const plan = turnIdRebuildPlan(source);
    if (!plan.ok) {
      die(
        plan.reason,
        `the turnId patch body is stale but cannot be rebuilt: ${plan.detail}. `
        + "Nothing was written; reinstall @getpaseo/cli to get a clean file.",
        { targetMd5: current, extra: { patchBody: "stale" } },
      );
    }
    const rebuilt = plan.rebuilt;
    // A prestale snapshot is rollback material for the same upgrade that
    // deletes the dist tree, so it goes to BACKUP_DIR like every other backup.
    const rebuiltBackup = join(
      BACKUP_DIR,
      `${basename(TURNID_TARGET)}.prestale-turnid-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${current.slice(0, 8)}`,
    );
    copyFileSync(TURNID_TARGET, rebuiltBackup);
    try {
      atomicWrite(TURNID_TARGET, rebuilt);
    } catch (error) {
      const intact = existsSync(TURNID_TARGET) && md5(readFileSync(TURNID_TARGET, "utf8")) === current;
      die(
        "turnid-stale-rebuild-write-failed",
        `could not write the rebuilt turnId body (${error.code ?? "error"}: ${error.message}). `
        + (intact ? `The file is untouched (md5 still ${current}).` : `Restore it from ${rebuiltBackup}.`),
        { targetMd5: intact ? current : null, extra: { backup: rebuiltBackup, patchBody: "stale" } },
      );
    }
    try {
      syntaxCheck(TURNID_TARGET);
    } catch (error) {
      let restored = null;
      try {
        atomicWrite(TURNID_TARGET, source);
        restored = md5(readFileSync(TURNID_TARGET, "utf8"));
      } catch {
        /* reported below */
      }
      die(
        "turnid-stale-rebuild-unparsable",
        `rebuilt turnId body does not parse (${error.message}); `
        + (restored === current ? "restored the previous content" : `RESTORE FAILED — restore from ${rebuiltBackup}`),
        { targetMd5: restored, extra: { backup: rebuiltBackup, patchBody: "stale" } },
      );
    }
    const rebuiltMd5 = md5(rebuilt);
    succeed({
      reason: "turnid-patched-from-stale",
      targetMd5: rebuiltMd5,
      message: "turnId 补丁体是旧版，已在原地重建。重开会话可正常折叠轮次。",
      extra: {
        turnIdTarget: TURNID_TARGET,
        upstreamMd5: current,
        patchedMd5: rebuiltMd5,
        backup: rebuiltBackup,
        turnIdMarkers: 2,
        patchBody: "rebuilt-from-stale",
      },
    });
    process.stdout.write(
      `[rewind-patch] turnId: stale body rebuilt in place, md5 ${current} -> ${rebuiltMd5}\n`
      + `[rewind-patch] turnId: backup: ${rebuiltBackup}\n`,
    );
    return;
  }

  if (markers !== 0) {
    die(
      "turnid-partially-patched",
      `found ${markers} "${TURNID_MARKER}" marker(s) in ${TURNID_TARGET}, expected 0 (clean) or 2 (patched).\n`
      + "  The file is in an unknown half-patched state. Restore it (reinstall @getpaseo/cli, or copy\n"
      + "  the agent-manager.js.orig-turnid-* backup over it), then run this script again.",
      { targetMd5: current, extra: { turnIdTarget: TURNID_TARGET, turnIdMarkers: markers } },
    );
  }

  const matches = matchAll(TURNID_CALL_RE, source);
  if (matches.length !== 2) {
    die(
      "turnid-anchor-mismatch",
      `unexpected upstream shape in ${TURNID_TARGET}: the replay recordTimeline call matched `
      + `${matches.length} time(s), expected exactly 2 (forceHydrate + primeTimeline).\n`
      + "  Re-check TURNID_CALL_RE against the current file. Until then a reopened session keeps no\n"
      + "  turn ids, so long conversations will not fold after a restart (no data loss).",
      {
        targetMd5: current,
        extra: { turnIdTarget: TURNID_TARGET, turnIdMatches: matches.length },
      },
    );
  }

  // Prove each match is the path we think it is, in the order we expect.
  // `recordTimeline` is called from three places in this file; only these two
  // take `event.item` with the timestamp ternary, and only they are followed by
  // these two lines. A reorder or a duplicated site must fail loudly.
  for (const [index, expected] of TURNID_CONTEXTS.entries()) {
    const match = matches[index];
    const after = source.slice(match.index + match[0].length, match.index + match[0].length + 400);
    if (!after.includes(expected)) {
      die(
        "turnid-anchor-context-mismatch",
        `replay call #${index + 1} in ${TURNID_TARGET} is not followed by \`${expected}\`.\n`
        + "  The two occurrences may have been reordered or a third one added. Refusing to guess.",
        {
          targetMd5: current,
          extra: { turnIdTarget: TURNID_TARGET, turnIdContext: index + 1 },
        },
      );
    }
  }

  // Replace from the last occurrence backwards so earlier indices stay valid.
  let patched = source;
  for (const match of [...matches].reverse()) {
    patched = patched.slice(0, match.index) + turnIdCall(match[1]) + patched.slice(match.index + match[0].length);
  }

  const patchedMarkers = countOccurrences(patched, TURNID_MARKER);
  if (patchedMarkers !== 2) {
    die(
      "turnid-marker-count-wrong",
      `expected 2 "${TURNID_MARKER}" markers after patching ${TURNID_TARGET}, found ${patchedMarkers}`,
      { targetMd5: current, extra: { turnIdTarget: TURNID_TARGET, turnIdMarkers: patchedMarkers } },
    );
  }

  const backup = turnIdBackupPath(current);
  copyFileSync(TURNID_TARGET, backup);

  try {
    atomicWrite(TURNID_TARGET, patched);
  } catch (error) {
    const stillIntact = existsSync(TURNID_TARGET) && md5(readFileSync(TURNID_TARGET, "utf8")) === current;
    die(
      "turnid-write-failed",
      `could not write the patched ${TURNID_TARGET} (${error.code ?? "error"}: ${error.message}).\n`
      + (stillIntact
        ? `  It is untouched (md5 still ${current}); the backup at ${backup} was not needed.`
        : `  It DOES NOT match the pre-patch content (expected ${current}) — restore it from ${backup}.`),
      {
        targetMd5: stillIntact ? current : null,
        extra: { turnIdTarget: TURNID_TARGET, backup, prePatchMd5: current, targetIntact: stillIntact },
      },
    );
  }

  try {
    syntaxCheck(TURNID_TARGET);
  } catch (error) {
    const checkUnavailable = error.code === "SYNTAX_CHECK_UNAVAILABLE";
    let rolledBack = null;
    let rollbackError = null;
    try {
      atomicWrite(TURNID_TARGET, source);
      rolledBack = md5(readFileSync(TURNID_TARGET, "utf8"));
    } catch (rollbackFailure) {
      rollbackError = `${rollbackFailure.code ?? "error"}: ${rollbackFailure.message}`;
    }
    const restoredCleanly = rolledBack !== null && rolledBack === current;
    die(
      checkUnavailable ? "turnid-syntax-check-unavailable" : "turnid-syntax-check-failed",
      (checkUnavailable
        ? `could not verify the patched ${TURNID_TARGET}: ${error.message}`
        : `patched ${TURNID_TARGET} does not parse; `
          + `${restoredCleanly ? "restored the pre-patch content" : "RESTORE FAILED"}.\n  ${error.message}`)
      + (rollbackError === null
        ? `\n  Target md5 ${rolledBack}${restoredCleanly ? " (identical to pre-patch)" : ` (DIFFERS from pre-patch ${current})`}.`
        : `\n  COULD NOT restore the pre-patch content (${rollbackError}).`
          + `\n  ${TURNID_TARGET} may hold unverified patched content. Expected md5 ${current}; backup is ${backup}.`),
      {
        targetMd5: rolledBack,
        extra: {
          turnIdTarget: TURNID_TARGET,
          backup,
          prePatchMd5: current,
          restoredCleanly,
          rollbackSucceeded: rollbackError === null,
          patchedCandidateMd5: md5(patched),
        },
      },
    );
  }

  const patchedMd5 = md5(patched);
  succeed({
    reason: "turnid-patched",
    targetMd5: patchedMd5,
    message: "turnId 补丁已打上：两处重放路径现在会把已有的 turnId 传给 timeline store。"
      + "重开会话后长对话可正常折叠轮次。",
    extra: {
      turnIdTarget: TURNID_TARGET,
      upstreamMd5: current,
      patchedMd5,
      backup,
      turnIdMarkers: 2,
    },
  });
  process.stdout.write(
    `[rewind-patch] turnId: applied 2 replay call sites\n`
    + `[rewind-patch] turnId: backup: ${backup}\n`
    + `[rewind-patch] turnId: md5 ${current} -> ${patchedMd5}\n`
    + "[rewind-patch] turnId: ESM syntax ok\n",
  );
}

/**
 * Revert the turnId patch. Idempotent, and refuses to restore a backup that is
 * itself patched or does not parse.
 */
function revertTurnIdPatch() {
  if (!existsSync(TURNID_TARGET)) {
    die("turnid-target-missing", `target not found: ${TURNID_TARGET}`, {
      extra: { turnIdTarget: TURNID_TARGET },
    });
  }

  const original = readFileSync(TURNID_TARGET, "utf8");
  const current = md5(original);
  const markers = countOccurrences(original, TURNID_MARKER);

  // Safe right after an upgrade: a freshly installed file carries no marker, and
  // restoring an older backup over it would silently downgrade the module.
  if (markers === 0) {
    succeed({
      reason: "turnid-revert-noop",
      targetMd5: current,
      message: "turnId 目标文件本来就没有补丁标记，无需回滚（已幂等跳过，未覆盖任何备份）。",
      extra: { turnIdTarget: TURNID_TARGET, turnIdMarkers: markers },
    });
    process.stdout.write(
      `[rewind-patch] turnId: nothing to revert: ${TURNID_TARGET} carries no patch marker (md5 ${current})\n`,
    );
    return;
  }

  if (markers !== 2) {
    die(
      "turnid-partially-patched",
      `found ${markers} "${TURNID_MARKER}" marker(s) in ${TURNID_TARGET}, expected 0 (clean) or 2 (patched); `
      + "refusing to guess.",
      { targetMd5: current, extra: { turnIdTarget: TURNID_TARGET, turnIdMarkers: markers } },
    );
  }

  const backup = latestTurnIdBackup();
  if (backup === null) {
    die(
      "turnid-no-backup",
      `no timestamped backup to restore (looked for ${basename(TURNID_TARGET)}.orig-turnid-* next to it)`,
      { targetMd5: current, extra: { turnIdTarget: TURNID_TARGET } },
    );
  }

  const backupSource = readFileSync(backup, "utf8");
  const backupMarkers = countOccurrences(backupSource, TURNID_MARKER);
  if (backupMarkers !== 0) {
    die(
      "turnid-backup-is-patched",
      `backup ${backup} itself carries ${backupMarkers} patch marker(s); it is not a clean baseline. Refusing to restore.`,
      { targetMd5: current, extra: { turnIdTarget: TURNID_TARGET, backup } },
    );
  }

  // Validate the backup BEFORE touching the live file.
  try {
    syntaxCheck(backup);
  } catch (error) {
    if (error.code === "SYNTAX_CHECK_UNAVAILABLE") {
      die("turnid-syntax-check-unavailable", `cannot verify backup ${backup}: ${error.message}`, {
        targetMd5: current,
        extra: { turnIdTarget: TURNID_TARGET, backup },
      });
    }
    die("turnid-backup-unparsable", `backup ${backup} does not parse: ${error.message}`, {
      targetMd5: current,
      extra: { turnIdTarget: TURNID_TARGET, backup },
    });
  }

  const undo = (reason, message, extra = {}) => {
    let rolledBack = null;
    let rollbackError = null;
    try {
      atomicWrite(TURNID_TARGET, original);
      rolledBack = md5(readFileSync(TURNID_TARGET, "utf8"));
    } catch (error) {
      rollbackError = `${error.code ?? "error"}: ${error.message}`;
    }
    const restoredCleanly = rolledBack !== null && rolledBack === current;
    die(
      reason,
      `${message}\n`
      + (rollbackError === null
        ? `  Restored the pre-revert content (md5 back to ${rolledBack}${restoredCleanly ? "" : `, DIFFERS from ${current}`}).`
        : `  COULD NOT restore the pre-revert content (${rollbackError}).\n`
          + `  ${TURNID_TARGET} may now hold the backup instead of the patched content. Expected md5 ${current}.`),
      {
        targetMd5: rolledBack,
        extra: {
          turnIdTarget: TURNID_TARGET,
          backup,
          rollbackSucceeded: rollbackError === null,
          restoredCleanly,
          ...extra,
        },
      },
    );
  };

  try {
    atomicWrite(TURNID_TARGET, backupSource);
  } catch (error) {
    undo("turnid-revert-write-failed", `could not restore ${backup} over the target (${error.code ?? "error"}: ${error.message}).`, {
      phase: "copy",
    });
  }

  const restoredSource = readFileSync(TURNID_TARGET, "utf8");
  const restored = md5(restoredSource);
  const restoredMarkers = countOccurrences(restoredSource, TURNID_MARKER);

  if (restoredMarkers !== 0) {
    undo("turnid-revert-verify-failed", `after restoring ${backup} the target still carries ${restoredMarkers} marker(s)`, {
      restoredMarkers,
    });
  }
  try {
    syntaxCheck(TURNID_TARGET);
  } catch (error) {
    undo("turnid-revert-verify-failed", `restored target does not parse: ${error.message}`);
  }

  succeed({
    reason: "turnid-reverted",
    targetMd5: restored,
    message: `已从备份 ${basename(backup)} 回滚 turnId 补丁。重开会话后长对话将不再折叠轮次（不影响数据）。`,
    extra: {
      turnIdTarget: TURNID_TARGET,
      backup,
      restoredMd5: restored,
      preRevertMd5: current,
    },
  });
  process.stdout.write(
    `[rewind-patch] turnId: reverted from ${backup}\n`
    + `[rewind-patch] turnId: md5 ${current} -> ${restored}\n`
    + "[rewind-patch] turnId: restored tree is unpatched (0 markers), ESM syntax ok\n",
  );
}

/**
 * `--check`: read the target and report, writing nothing.
 *
 * Exit 0 only when the patch is in place *and* the injected body is current.
 * The `patchable` / `stale-body` states mean "run apply" (exit 1); the rest
 * need a human (exit 2) or mean paseo is not installed where expected (exit 3).
 * The read-only plan is the same code apply runs, so this mode cannot promise
 * a rebuild apply would refuse.
 *
 * @returns {number} process exit code.
 */
function checkTurnId() {
  const report = (result) => {
    process.stdout.write(
      `[rewind-patch] turnId: ${result.ok ? "OK" : "FAILED"} — ${result.detail}\n`,
    );
    return result.ok ? 0 : result.code;
  };

  if (!existsSync(TURNID_TARGET)) {
    process.stderr.write(`[rewind-patch] check: target missing: ${TURNID_TARGET}\n`);
    return report({
      ok: false,
      code: 3,
      detail: `target missing: ${TURNID_TARGET}`,
    });
  }

  const source = readFileSync(TURNID_TARGET, "utf8");
  const current = md5(source);
  const markers = countOccurrences(source, TURNID_MARKER);

  if (markers === 2) {
    const stale = turnIdStaleness(source);
    if (stale.current) {
      return report({
        ok: true,
        code: 0,
        detail: `patched (2/2 markers, md5 ${current}), body current`,
      });
    }
    const plan = turnIdRebuildPlan(source);
    if (!plan.ok) {
      process.stderr.write(
        `[rewind-patch] check: the stale turnId body cannot be rebuilt (${plan.reason}: ${plan.detail})\n`,
      );
      return report({
        ok: false,
        code: 2,
        detail: `STALE PATCH BODY (${stale.detail}; md5 ${current}) — apply will refuse to rebuild it: `
          + `${plan.reason} (${plan.detail}); reinstall @getpaseo/cli then re-run`,
      });
    }
    return report({
      ok: false,
      code: 1,
      detail: `STALE PATCH BODY (${stale.detail}; md5 ${current}) — re-run without --check to rebuild in place`,
    });
  }

  if (markers !== 0) {
    process.stderr.write(`[rewind-patch] check: half-patched target (${markers} marker(s))\n`);
    return report({
      ok: false,
      code: 2,
      detail: `HALF-PATCHED (${String(markers)}/2 markers, md5 ${current}) — restore from backup`,
    });
  }

  // Clean file. Only promise a patch when apply's own anchor+context gates
  // would pass — otherwise a checker saying "run apply to fix it" sends the
  // operator into a guaranteed failure.
  const matches = matchAll(TURNID_CALL_RE, source);
  if (matches.length !== 2) {
    process.stderr.write(
      `[rewind-patch] check: replay call matched ${matches.length} time(s), expected 2\n`,
    );
    return report({
      ok: false,
      code: 2,
      detail: `NOT patched (0/2 markers, md5 ${current}) — anchor mismatch: the replay recordTimeline `
        + `call matched ${matches.length} time(s), expected exactly 2 (forceHydrate + primeTimeline)`,
    });
  }
  for (const [index, expected] of TURNID_CONTEXTS.entries()) {
    const match = matches[index];
    const after = source.slice(match.index + match[0].length, match.index + match[0].length + 400);
    if (!after.includes(expected)) {
      process.stderr.write(`[rewind-patch] check: replay call #${index + 1} has the wrong context\n`);
      return report({
        ok: false,
        code: 2,
        detail: `NOT patched (0/2 markers, md5 ${current}) — anchor context mismatch: replay call `
          + `#${index + 1} is not followed by \`${expected}\``,
      });
    }
  }
  return report({
    ok: false,
    code: 1,
    detail: `NOT patched (0/2 markers, md5 ${current}) — both replay call sites found, apply will patch them`,
  });
}

/**
 * Entry point.
 *
 * `--check` answers "is the patch in place" without writing anything.
 * `--revert` restores the pre-patch file from the newest backup.
 */
function main() {
  if (process.argv.includes("--check")) {
    process.exitCode = checkTurnId();
    return;
  }
  if (process.argv.includes("--revert")) {
    revertTurnIdPatch();
    return;
  }
  applyTurnIdPatch();
}

export {
  STATUS_FILE,
  TURNID_CALL_RE,
  TURNID_CONTEXTS,
  TURNID_MARKER,
  TURNID_TARGET,
  countOccurrences,
  matchAll,
  md5,
  turnIdRebuildPlan,
  turnIdStaleness,
};

// Only run when invoked as a script — `check-rewind-patch.mjs` imports the
// anchors from here and must not trigger a patch as a side effect.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // Outermost net.  The target handlers call `die()` for every failure they know
  // about; this catches the ones they do not, so an unexpected throw still leaves
  // a status file behind instead of a bare stack trace.  Without it,
  // `check-rewind-patch.mjs` would keep showing the previous run's `ok: true`.
  try {
    main();
  } catch (error) {
    recordUnhandled(error);
  }
}
