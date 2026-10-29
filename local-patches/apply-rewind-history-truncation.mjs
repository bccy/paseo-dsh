#!/usr/bin/env node
/**
 * LOCAL PATCH (paseo-dsh) — native rewind for plugin providers.
 *
 * WHY
 * ---
 * Paseo's rewind works by rebuilding the timeline from the provider's
 * `streamHistory()` right after `session.revert` resolves
 * (`agent-manager.js` `rewind()` awaits `invokeRewindCapability`, then calls
 * `hydrateTimelineFromProvider({force:true})`).  For built-in providers that
 * generator re-reads the real backend, so the rebuilt timeline is shorter.
 *
 * For a plugin provider, `PluginAgentSession.streamHistory()` just replays
 * `this.history` — an array that only ever grew, because the plugin contract
 * has no removal event.  A rewind therefore kept showing the withdrawn turns
 * until the whole agent was reloaded.  That forced the plugin to spawn
 * `paseo agent reload` (≈2 s, new provider session id, loading state, running
 * provider subagents cancelled) plus a parked-process pool to hide the restart.
 *
 * WHAT
 * ----
 * Truncate `this.history` at the rewound row, inside `revert()`, *before* the
 * reply goes out.  `agent-manager.rewind()` is awaiting that reply, so the
 * force-hydrate that follows reads the already-shortened history.  No new
 * provider event, no race, no client change.
 *
 * The cut is keyed on `messageId`: `mapTimelineItem()` stores the same value on
 * the translated `user_message` row that it registers in `revertTokens`, and
 * `history` holds pre-projection rows, so the id survives verbatim.
 *
 * SELF-ADAPTING ANCHORS (why md5 is NOT a gate any more)
 * -----------------------------------------------------
 * The insertion points are found by two *pattern* anchors, not by trusting a
 * known baseline md5.  Each anchor spells out a complete method body, so it is
 * specific enough on its own; a unique match already proves we are editing the
 * right place.  Gating on `md5 === BASE_MD5` only meant "any upstream release
 * that touches any byte of this 55 KB file makes the patch refuse to apply" —
 * which, with `ExecStartPre` in front of the daemon, used to mean the daemon
 * could not boot at all.
 *
 * Both anchors are whitespace-elastic (`[ \t]*` per line, `\r?\n` tolerant) and
 * capture their own indentation, which is reused when inserting.  So a prettier
 * pass, an `.editorconfig` change or a 2-space/tab rebuild still gets patched
 * automatically at the next daemon start.  Only a real change to the two
 * insertion sites fails — and that failure is loud: exit 1, a machine-readable
 * status file, and the systemd drop-in's `-` prefix so the daemon still boots.
 *
 * IDEMPOTENT — run it before every daemon start (`ExecStartPre`).
 * Fails closed: missing target, half-patched file, ambiguous or missing anchor,
 * or a post-write syntax failure => exit 1, with the backup restored.
 *
 * Usage: node apply-rewind-history-truncation.mjs [--revert]
 *
 * Env (test-only; both default to the directory this script lives in):
 *   REWIND_PATCH_TARGET  path to plugin-provider.js to operate on
 *   REWIND_PATCH_HOME    where backups + rewind-patch.status.json are written
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
 * Falls back to `<npm global root>/@getpaseo/cli` when the executable cannot be
 * resolved, and returns null when neither works — callers then fail with a
 * message that says how to point at the install.
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
 * The one file the daemon actually loads for the provider contract.
 *
 * `REWIND_PATCH_TARGET` exists so a self-test can point at a scratch copy.
 */
const TARGET =
  process.env.REWIND_PATCH_TARGET
  ?? (AGENT_DIR === null ? "" : join(AGENT_DIR, "plugin-provider.js"));

/**
 * The *second* file this script patches: Paseo's `agent-manager.js`, whose two
 * history-replay paths drop the `turnId` the events already carry.
 *
 * Why this lives in the same script as the rewind patch rather than a second
 * one: both patches exist for the same product defect (Paseo's rewind / replay
 * path), both are wiped by the same `npm i -g @getpaseo/cli`, both are
 * re-applied by the same `ExecStartPre` + startup hook, and both need the same
 * soft-failure policy. Two scripts would mean two status files, two hook
 * invocations, and an install that can come up with one patch silently missing
 * while the other's status file still says `ok: true`.
 *
 * `REWIND_PATCH_TURNID_TARGET` mirrors `REWIND_PATCH_TARGET` for the self-test.
 */
const TURNID_TARGET =
  process.env.REWIND_PATCH_TURNID_TARGET
  ?? (AGENT_DIR === null ? "" : join(AGENT_DIR, "agent-manager.js"));

/**
 * Reference md5 of npm @getpaseo/server@0.13.0, verified byte-for-byte against
 * the registry tarball.
 *
 * NOT a gate. It is only recorded in the status file / logs so a human can see
 * how far the on-disk file has drifted from the version this patch was written
 * against. A different value here is expected and harmless as long as the two
 * anchors below still match exactly once.
 */
const BASE_MD5 = "408f99fcaa8cf8a760a3646d788be774";

const MARKER = "LOCAL PATCH (paseo-dsh)";

const HOME_DIR = process.env.REWIND_PATCH_HOME ?? dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = HOME_DIR;
const STATUS_FILE = join(HOME_DIR, "rewind-patch.status.json");

/** The method inserted just before `publish(event) {` (4-space base indent). */
const METHOD = `    /**
     * LOCAL PATCH (paseo-dsh): drop the withdrawn tail of the translated history
     * *and* the translation state that branch registered.
     *
     * The daemon rebuilds the timeline right after this session's \`revert()\`
     * resolves, and that rebuild reads exactly this array through
     * \`streamHistory()\`.  This buffer only ever grew — the plugin contract has
     * no removal event — so a rewind kept showing the withdrawn turns until the
     * whole agent was reloaded.
     *
     * Truncating the array alone is not enough.  \`mapTimelineItem()\` keeps one
     * \`timelineSnapshots\` entry per provider item id and emits each text as a
     * *diff* against it (\`text.startsWith(previousText)\`), and it also fills
     * \`revertTokens\` for the same ids.  The translated rows in \`history\` carry
     * no provider id (only user/assistant keep a \`messageId\`), so the entries of
     * the discarded branch cannot be picked out afterwards — and leaving them
     * behind makes a replacement prompt that reuses a discarded id diff against
     * a branch that no longer exists (the reused id emits \` revised\` instead of
     * \`Reply B revised\`).
     *
     * The two maps are NOT treated alike.  \`timelineSnapshots\` is a pure
     * translation cache — \`streamHistory()\` never re-runs the translation, and
     * the only effect of clearing it is that the next item with a seen id is
     * emitted in full instead of as a delta, which is what a rewritten branch
     * needs.  \`revertTokens\` is NOT a pure cache: it is the lookup table the
     * *next* \`revert()\` reads, and it is never refilled.  Clearing it wholesale
     * made every rewind after the first one throw "No provider revert token for
     * message …".  So it is cleared per id, only for the branch being withdrawn;
     * messages still on screen keep their tokens.
     *
     * @param {string} messageId - provider message id the rewind targets.
     * @returns {boolean} whether a row matched (false leaves history untouched).
     */
    truncateHistoryFrom(messageId) {
        let cut = -1;
        for (let index = this.history.length - 1; index >= 0; index -= 1) {
            const event = this.history[index];
            if (event.type !== "timeline")
                continue;
            const item = event.item;
            const id = item.type === "user_message" || item.type === "assistant_message"
                ? (item.messageId ?? undefined)
                : undefined;
            if (id !== messageId)
                continue;
            cut = index;
            break;
        }
        if (cut === -1)
            return false;
        // Collect the provider item ids the discarded branch registered *before*
        // dropping it: dropping after the fact cannot see them (the translated
        // rows carry no provider id), which is why the snapshot cache has to be
        // cleared wholesale.
        const discardedIds = new Set();
        for (let index = cut; index < this.history.length; index += 1) {
            const event = this.history[index];
            if (event.type !== "timeline")
                continue;
            if (typeof event.item.id === "string")
                discardedIds.add(event.item.id);
            if (typeof event.item.messageId === "string")
                discardedIds.add(event.item.messageId);
        }
        this.history.length = cut;
        this.timelineSnapshots.clear();
        // NEVER clear revertTokens wholesale: it is not a pure translation
        // cache, it is the lookup revert() reads on the *next* rewind.  The
        // contract has no removal event and streamHistory() never re-runs the
        // translation, so a cleared map is never refilled — every rewind after
        // the first one then throws "No provider revert token for message".
        // Only the entries of the branch that was just withdrawn are dropped;
        // messages still on screen keep their tokens.
        for (const id of discardedIds)
            this.revertTokens.delete(id);
        return true;
    }
`;

/** Indentation the blocks above are written with (0.13.0 dist = 4 spaces/level). */
const METHOD_BASE_INDENT = "    ";
const CALL_BASE_INDENT = "        ";

/**
 * Anchor A: the whole `publish(event)` method that follows `revert()` in the
 * class body.  The three-statement body is what makes this unique — the file
 * has a *second* `publish(event) {` earlier (a different, unrelated method), so
 * matching on the signature alone would be ambiguous.
 *
 * Capture group 1 = the indentation of the method, reused for insertion.
 */
const ANCHOR_A_RE =
  /^([ \t]*)publish\(event\)[ \t]*\{\r?\n[ \t]*this\.history\.push\(event\);\r?\n[ \t]*this\.emit\(event\);\r?\n[ \t]*\}[ \t]*\r?$/gm;

/**
 * Anchor B: the tail of `revert()` — the whole `bridge.revert({...})` call plus
 * the method's closing brace.  Capture group 1 = indentation of the `await`.
 */
const ANCHOR_B_RE =
  /^([ \t]*)await this\.bridge\.revert\(\{\r?\n[ \t]*type: "session\.revert",\r?\n[ \t]*requestId: randomUUID\(\),\r?\n[ \t]*sessionId: this\.bridge\.providerId,\r?\n[ \t]*token,\r?\n[ \t]*scope,\r?\n[ \t]*\}\);\r?\n[ \t]*\}[ \t]*\r?$/gm;

/** Inserted just before the closing brace of `revert()` (8-space base indent). */
const CALL = `        // LOCAL PATCH (paseo-dsh): the force-hydrate that follows this reply reads
        // \`streamHistory()\`, i.e. \`this.history\`.  Shorten it now so the rebuilt
        // timeline drops the withdrawn turns without a reload.
        //
        // Conversation-affecting scopes only.  A \`files\` rewind restores the working
        // tree and deliberately leaves the conversation alone — the daemon skips the
        // force-hydrate for it (\`agent-manager\`: \`if (mode !== "files")\`) — so
        // truncating here would drop rows nobody asked to remove, and the next
        // \`streamHistory()\` would rebuild a timeline missing turns still on screen.
        if (scope !== "files" && !this.truncateHistoryFrom(messageId)) {
            process.stderr.write(\`[plugin-provider] rewind \${messageId}: no history row carries this id; \`
                + "the timeline keeps the withdrawn turns until the agent is reloaded\\n");
        }
`;

// ───────────────────────────────────────────────────────────────────────────
// Patch 2 — keep the turn id when replaying provider history (agent-manager.js)
// ───────────────────────────────────────────────────────────────────────────

/**
 * This patch's own marker. Distinct from `MARKER` on purpose: the two patches
 * live in different files, and each file's marker count is what decides "is
 * this file clean / patched / half-patched". Sharing one string would make a
 * half-applied turnId patch look like a half-applied rewind patch.
 */
const TURNID_MARKER = "LOCAL PATCH (paseo-dsh): keep the turn id on replay";

/**
 * The exact call both replay paths make, spelled out in full so it is specific
 * on its own. It occurs **twice** in a clean file — once in
 * `forceHydrateTimelineFromLegacyProviderHistory`, once in
 * `primeTimelineFromLegacyProviderHistory` — and each must match exactly once.
 * Capture group 1 = the call's indentation, reused for the replacement.
 *
 * `[ \t]*$` per line and `\r?\n` keep it whitespace-elastic, exactly like the
 * rewind anchors: a reformat still patches, only a real rewrite fails.
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
 * Infer the file's indentation unit from an anchor match.
 *
 * The dist ships 4 spaces, but a prettier pass with `tabWidth: 2` or
 * `useTabs: true` changes that, and inserting 4-space code into a 2-space file
 * parses fine yet looks broken.  Counting indentation widths across the file is
 * unreliable (a 2-space file's 2nd level looks exactly like a 4-space file's
 * 1st), so derive it from the anchor itself: the match's first line is the
 * method signature and its second line is one level deeper, so the difference
 * *is* the unit.
 */
function detectIndentUnit(anchorMatchText) {
  const indentOf = (line) => /^[ \t]*/.exec(line)[0];
  const lines = anchorMatchText.split(/\r?\n/);
  const outer = indentOf(lines[0]);
  for (const line of lines.slice(1)) {
    const inner = indentOf(line);
    if (inner.length > outer.length && inner.startsWith(outer)) {
      return inner.slice(outer.length);
    }
  }
  return "    "; // unreachable for a well-formed anchor; keeps the mapping total
}

/**
 * Re-anchor a fixed-indent block onto the indentation actually found in the file.
 *
 * `baseIndent` is the block's own indentation (4 spaces for METHOD, 8 for CALL)
 * and the blocks themselves are always written at 4 spaces per level.  Each line
 * is therefore converted by whole levels: `relative / 4` levels of `unit`, plus
 * any sub-level remainder as literal spaces — which is exactly what a javadoc
 * continuation line (`base + one space`) needs, including when `unit` is a tab.
 */
function reindent(block, baseIndent, targetIndent, unit) {
  const BLOCK_UNIT_WIDTH = 4;
  const base = baseIndent.length;
  return block
    .split("\n")
    .map((line) => {
      const leading = /^[ \t]*/.exec(line)[0];
      if (leading.length < base) return line;
      const rest = line.slice(leading.length);
      const relative = leading.length - base;
      const levels = Math.floor(relative / BLOCK_UNIT_WIDTH);
      const remainder = relative % BLOCK_UNIT_WIDTH;
      return targetIndent + unit.repeat(levels) + " ".repeat(remainder) + rest;
    })
    .join("\n");
}

function normaliseEol(text, crlf) {
  return crlf ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
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
 * `.js` => exit 0, `.mjs` => exit 1 (SyntaxError).  plugin-provider.js is ESM
 * (it opens with `import { randomUUID } from "node:crypto";`), so the old check
 * silently passed everything — including a broken patch.
 *
 * Copy to a scratch `.mjs` and check that instead (~30 ms for 55 KB).
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

function syntaxCheck(file) {
  if (checkDir === null) {
    try {
      checkDir = mkdtempSync(join(tmpdir(), "rewind-patch-check-"));
    } catch (error) {
      throw new SyntaxCheckUnavailable(
        `could not create a scratch dir to verify ${file} (${error.code ?? "error"}: ${error.message}). `
        + "This is an environment problem (tmpdir permissions / disk), not a patch problem.",
      );
    }
  }
  const copy = join(checkDir, `${basename(file).replace(/[^\w.-]/g, "_")}.mjs`);
  try {
    copyFileSync(file, copy);
  } catch (error) {
    throw new SyntaxCheckUnavailable(
      `could not copy ${file} into the scratch dir (${error.code ?? "error"}: ${error.message}). `
      + "This is an environment problem, not a patch problem.",
    );
  }
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
      .join(file) // report the real path, not the scratch copy
      .trim();
    const verdict = new Error(`ESM syntax check failed on ${file}: ${detail}`);
    verdict.code = "SYNTAX_CHECK_FAILED";
    throw verdict;
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

/**
 * Detect whether upstream has fixed #4667 by itself — i.e. `revert()` already
 * shortens `this.history` — so this patch is redundant and should be retired
 * rather than re-applied on every start.
 *
 * Why it matters: the patch would keep applying silently, `check-rewind-patch`
 * would keep saying "normal", and every rewind would log a *false*
 * `no history row carries this id` warning (the injected call finds that
 * upstream already dropped the row).  Nothing corrupts the data — the remaining
 * history is identical either way — but a permanently lying warning plus a patch
 * nobody knows to delete is exactly the "silent degradation" this whole exercise
 * is meant to avoid.
 *
 * Scope — deliberately narrow, and documented because it is a real limitation:
 *   - Only inspects the body of `revert()`.  Scanning the whole file would hit
 *     `this.history = []` in the constructor/`reset()` and report every upstream
 *     version as "fixed".
 *   - Only recognises "upstream mutates this.history inside revert()"
 *     (`=`, `.length =`, `.splice(`, `.pop(`).  If upstream instead emits a new
 *     event type, or fixes `streamHistory()` rather than `revert()`, this check
 *     reports "not fixed" and the patch is applied — which stays correct, just
 *     not retired automatically.
 *   - Callers must pass a marker-free file (the patch's own inserted call would
 *     otherwise match).  `main()` only calls this on the `markers === 0` path.
 */
const HISTORY_MUTATION_RE = /this\.history\s*=|this\.history\.length\s*=|this\.history\.splice\(|this\.history\.pop\(/g;

function detectUpstreamSelfFix(source) {
  // Bound `revert()` by its own signature and the next method signature at the
  // same-or-shallower indentation.  The dist writes methods at 4 spaces, but the
  // anchor work above already accepts 2 spaces and tabs, so stay flexible.
  const signature = /^([ \t]*)async revert\(messageId, scope\)[ \t]*\{[ \t]*\r?$/m.exec(source);
  if (signature === null) return { fixed: false, hits: 0, sites: [] };

  const indent = signature[1];
  const bodyStart = signature.index + signature[0].length;
  // Next sibling method: same indentation, `name(...) {`.
  const siblingRe = new RegExp(`^${indent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z_$#][\\w$]*\\(`, "gm");
  siblingRe.lastIndex = bodyStart;
  const sibling = siblingRe.exec(source);
  const body = source.slice(bodyStart, sibling === null ? source.length : sibling.index);

  HISTORY_MUTATION_RE.lastIndex = 0;
  const matches = [...body.matchAll(HISTORY_MUTATION_RE)];
  const sites = matches.map((match) => {
    const lineStart = body.lastIndexOf("\n", match.index) + 1;
    const lineEnd = body.indexOf("\n", match.index);
    return body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd).trim();
  });

  return { fixed: matches.length > 0, hits: matches.length, sites: [...new Set(sites)] };
}

function latestBackup() {
  let candidates;
  try {
    // Only *clean upstream* backups are usable as a baseline.  `prestale` snapshots
    // hold the file as it was while still carrying this patch's markers, so they
    // must never be picked — and although they no longer start with `.orig-`,
    // excluding them by name as well keeps the rule explicit instead of relying
    // on a naming convention that a future edit could quietly change.
    candidates = readdirSync(BACKUP_DIR).filter(
      (name) => name.startsWith("plugin-provider.js.orig-") && !name.includes(".prestale-"),
    );
  } catch {
    return null;
  }
  candidates.sort();
  return candidates.length > 0 ? join(BACKUP_DIR, candidates[candidates.length - 1]) : null;
}

/**
 * The backup the *current* patch was built from, recorded by the last successful
 * apply.  Preferred over `latestBackup()`: after an upgrade the newest backup on
 * disk may belong to a previous upstream version, and restoring that would
 * silently downgrade the file.
 */
function backupFromStatus() {
  let status;
  try {
    status = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
  } catch {
    return null;
  }
  // All three reasons mean "this file was built from that backup".  The third,
  // `already-patched`, is the idempotent steady state: every daemon start
  // rewrites the status file through it, so excluding it made this lookup return
  // null almost always (see the comment on the already-patched branch).
  const usable = ["patched", "patched-on-new-upstream", "already-patched"];
  // The rewind verdict can live at the top level (the historical layout) or under
  // `patches.rewind` (the combined layout, when a sibling target failed and the
  // top-level reason came from it).  Either location counts.
  const reason = usable.includes(status?.reason)
    ? status.reason
    : (usable.includes(status?.patches?.rewind?.reason) ? status.patches.rewind.reason : null);
  if (reason === null) return null;
  // Likewise the value itself: top-level `backup` first, `patches.rewind.backup`
  // as the fallback.
  for (const candidate of [status?.backup, status?.patches?.rewind?.backup]) {
    if (typeof candidate === "string" && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Best known "backup this build came from", preferring the recorded one.
 *
 * Used by the idempotent branch so it can carry the value forward instead of
 * erasing it.  `latestBackup()` is only a fallback for the very first run after
 * the recorded one was deleted.
 */
function recordedBackup() {
  return backupFromStatus() ?? latestBackup();
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

  let dir = dirname(TARGET);
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

/**
 * Best-effort record of a failure that escaped `main()`/`revert()` entirely.
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
    targetMd5 = existsSync(TARGET) ? md5(readFileSync(TARGET, "utf8")) : null;
  } catch {
    /* unreadable target is part of what we are reporting */
  }
  try {
    writeStatus({
      ok: false,
      at: new Date().toISOString(),
      reason: "unhandled",
      target: TARGET,
      targetMd5,
      baseMd5: BASE_MD5,
      paseoVersion: null,
      message: `补丁脚本异常终止（未预期错误，非锚点/上游问题）：${error?.message ?? error}。`
        + "撤回功能状态未知，请人工确认目标文件是否完整。",
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

function statusPayload({ ok, reason, message, targetMd5 = null, extra = {} }) {
  return {
    ok,
    at: new Date().toISOString(),
    reason,
    target: TARGET,
    targetMd5,
    baseMd5: BASE_MD5,
    paseoVersion: readPaseoVersion(),
    message,
    ...extra,
  };
}

/**
 * A target's own failure, carried out of its handler instead of exiting.
 *
 * Why this indirection exists: this script now patches **two** files, and the
 * failure policy is soft *per file* — one file's broken anchor must not stop the
 * other from being patched.  The original code ended every failure with
 * `process.exit(1)` inside `die()`, which is exactly right for a single target
 * and exactly wrong for two: the first failure would abort before the second
 * file was even read.
 *
 * So `die()` records the failure and *throws* this when a run context is active,
 * and the per-target runner catches it.  Every existing rollback (`undo()`, the
 * post-write restore) still runs first — it sits above the `die()` call — so the
 * recovery ordering is unchanged.  Standalone (no context) `die()` keeps the old
 * exit-immediately behaviour, which is what a human running it by hand expects.
 */
class PatchFailure extends Error {
  constructor(reason, message, { targetMd5 = null, extra = {} } = {}) {
    super(message);
    this.name = "PatchFailure";
    this.reason = reason;
    this.targetMd5 = targetMd5;
    this.extra = extra;
  }
}

/**
 * The active per-target collector, or `null` when running standalone.
 *
 * `{ failures: [], successes: [] }` — `die()` pushes to `failures` and throws,
 * `succeed()` pushes to `successes` and returns so the caller's own stdout
 * write still runs.
 */
let runContext = null;

/**
 * Record the failure, say it loudly on stderr, exit 1.
 *
 * With a run context active it throws {@link PatchFailure} instead of exiting,
 * so the sibling target still gets its turn (see the class comment).
 */
function die(reason, message, { targetMd5 = null, extra = {} } = {}) {
  if (runContext !== null) {
    runContext.failures.push({ reason, message, targetMd5, extra });
    process.stderr.write(`[rewind-patch] FATAL: ${message}\n`);
    throw new PatchFailure(reason, message, { targetMd5, extra });
  }
  writeStatus(statusPayload({ ok: false, reason, message, targetMd5, extra }));
  process.stderr.write(`[rewind-patch] FATAL: ${message}\n`);
  process.exit(1);
}

function succeed({ reason, message, targetMd5, extra = {} }) {
  if (runContext !== null) {
    runContext.successes.push({ reason, message, targetMd5, extra });
    return;
  }
  writeStatus(statusPayload({ ok: true, reason, message, targetMd5, extra }));
}

function revertRewindPatch() {
  if (!existsSync(TARGET)) {
    die("target-missing", `target not found: ${TARGET}`);
  }

  const original = readFileSync(TARGET, "utf8");
  const current = md5(original);
  const markers = countOccurrences(original, MARKER);

  // Idempotent no-op.  This guard is what makes `--revert` safe right after an
  // upgrade: a freshly installed upstream file carries no marker, so we must not
  // overwrite it with some older backup.
  if (markers === 0) {
    succeed({
      reason: "revert-noop",
      targetMd5: current,
      message: "目标文件本来就没有补丁标记，无需回滚（已幂等跳过，未覆盖任何备份）。",
      extra: { markers },
    });
    process.stdout.write(
      `[rewind-patch] nothing to revert: ${TARGET} carries no patch marker (md5 ${current})\n`,
    );
    return;
  }

  if (markers !== 2) {
    die(
      "partially-patched",
      `found ${markers} "${MARKER}" marker(s), expected 0 (clean) or 2 (patched); refusing to guess.`,
      { targetMd5: current, extra: { markers } },
    );
  }

  const backup = backupFromStatus() ?? latestBackup();
  if (backup === null) {
    die("no-backup", `no timestamped backup to restore (looked for plugin-provider.js.orig-* in ${BACKUP_DIR})`, {
      targetMd5: current,
    });
  }

  const backupSource = readFileSync(backup, "utf8");
  const backupMarkers = countOccurrences(backupSource, MARKER);
  if (backupMarkers !== 0) {
    die(
      "backup-is-patched",
      `backup ${backup} itself carries ${backupMarkers} patch marker(s); it is not a clean baseline. Refusing to restore.`,
      { targetMd5: current, extra: { backup } },
    );
  }

  // Validate the backup BEFORE touching the live file, so a bad backup cannot
  // destroy a working (patched) install.
  try {
    syntaxCheck(backup);
  } catch (error) {
    if (error.code === "SYNTAX_CHECK_UNAVAILABLE") {
      die("syntax-check-unavailable", `cannot verify backup ${backup}: ${error.message}`, {
        targetMd5: current,
        extra: { backup },
      });
    }
    die("backup-unparsable", `backup ${backup} does not parse: ${error.message}`, {
      targetMd5: current,
      extra: { backup },
    });
  }

  /**
   * Put the pre-revert (patched) content back and die.
   *
   * Declared *before* the restore below, because the restore is the very step
   * most likely to fail (ENOSPC / EDQUOT / a read-only remount) and the old
   * ordering left this function undefined at that moment — so the failure that
   * most needed recovery was the one that could not reach it.
   *
   * The write here is atomic and independently guarded: if the filesystem is
   * broken enough that we cannot write, we still record a status file rather
   * than dying with a stack trace and no trace of what happened.
   */
  const undo = (reason, message, extra = {}) => {
    let rolledBack = null;
    let rollbackError = null;
    try {
      atomicWrite(TARGET, original);
      rolledBack = md5(readFileSync(TARGET, "utf8"));
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
          + `  ${TARGET} may now hold the backup instead of the patched content. Expected md5 ${current}.`),
      {
        targetMd5: rolledBack,
        extra: { backup, rollbackSucceeded: rollbackError === null, restoredCleanly, ...extra },
      },
    );
  };

  // Atomic write: either the whole clean backup lands, or the patched file stays.
  try {
    atomicWrite(TARGET, backupSource);
  } catch (error) {
    undo(
      "revert-write-failed",
      `could not restore ${backup} over the target (${error.code ?? "error"}: ${error.message}).`,
      { phase: "copy" },
    );
  }

  const restoredSource = readFileSync(TARGET, "utf8");
  const restored = md5(restoredSource);
  const restoredMarkers = countOccurrences(restoredSource, MARKER);

  if (restoredMarkers !== 0) {
    undo("revert-verify-failed", `after restoring ${backup} the target still carries ${restoredMarkers} marker(s)`, {
      restoredMarkers,
    });
  }
  try {
    syntaxCheck(TARGET);
  } catch (error) {
    undo("revert-verify-failed", `restored target does not parse: ${error.message}`);
  }

  const matchesBaseline = restored === BASE_MD5;
  succeed({
    reason: "reverted",
    targetMd5: restored,
    message: matchesBaseline
      ? `已从备份 ${basename(backup)} 回滚，内容与已知基线 ${BASE_MD5} 一致。撤回功能恢复为降级状态（时间线不自动刷新）。`
      : `已从备份 ${basename(backup)} 回滚（该上游版本 md5 ${restored}，与已知基线 ${BASE_MD5} 不同，属正常）。撤回功能恢复为降级状态。`,
    extra: {
      backup,
      restoredMd5: restored,
      matchesKnownBaseline: matchesBaseline,
      preRevertMd5: current,
    },
  });
  process.stdout.write(
    `[rewind-patch] reverted from ${backup}\n`
    + `[rewind-patch] md5 ${current} -> ${restored}\n`
    + "[rewind-patch] restored tree is unpatched (0 markers), ESM syntax ok\n",
  );
}

/**
 * Is the rewind patch body currently in `source` the same one this script would
 * write today?
 *
 * `applyRewindPatch()` used to treat "2 markers" as proof the patch was current.
 * That holds for *presence* but not for *content*: the injected method is part
 * of this script, so fixing a bug inside it leaves every already-patched install
 * carrying the old body with the same marker count — and the corrected body
 * never lands, because apply reports "already patched" and returns.
 *
 * That is exactly what happened with `revertTokens`: the first version cleared
 * the map wholesale, which made every rewind after the first one throw
 * "No provider revert token for message …" (the map is never refilled —
 * `streamHistory()` does not re-run the translation). The corrected body deletes
 * only the tokens of the withdrawn branch.
 *
 * Comparison is on the method's **code lines only**: comments and blank lines
 * are dropped and each surviving line is trimmed before comparing.  So a
 * reformat, a re-indent, or a comment edit does not read as stale (those must
 * not trigger a rebuild on every start), while a real change to the body does.
 *
 * @param {string} source - the file as it is on disk (markers already counted 2).
 * @returns {{current: boolean, detail: string}}
 */
function rewindPatchStaleness(source) {
  const expectedLines = codeLines(METHOD);

  // Locate the on-disk method without relying on its indentation: from the
  // signature back to the nearest `/**`, forward to the first `}` that closes
  // it at the signature's own indentation.  Indentation-agnostic on purpose —
  // a re-indented file must compare equal, not read as stale.
  const signature = /^([ \t]*)truncateHistoryFrom\(messageId\)[ \t]*\{[ \t]*\r?$/mu.exec(source);
  if (signature === null) {
    return { current: false, detail: "truncateHistoryFrom(messageId) was not found" };
  }
  const indent = signature[1];
  // Find the opening brace by *searching for it*, never by taking the end of the
  // signature match.
  //
  // The signature regex ends with `[ \t]*\r?$`, so on a CRLF file the matched
  // text includes the `\r` and "one past the match" lands on that `\r`, not on
  // `{`.  `matchClosingBrace()` then sees a non-`{` at the given index and
  // returns -1, which reads as "no matching closing brace" -> the file is judged
  // stale on every single run.  Measured: a correctly patched CRLF file reported
  // `patched-on-new-upstream` forever (reset + rebuild + a new backup each run)
  // while the identical LF file reported `already-patched` on the second run.
  const openBrace = signature.index + signature[0].indexOf("{");
  const close = matchClosingBrace(source, openBrace);
  if (close === -1) {
    return { current: false, detail: "truncateHistoryFrom() has no matching closing brace" };
  }
  const actual = source.slice(signature.index, close + 1);
  const actualLines = codeLines(actual);

  if (actualLines.join("\n") !== expectedLines.join("\n")) {
    // Name the difference so a human can see it in the log without a diff.
    const actualHasClear = /this\.revertTokens\.clear\(\)/u.test(actual);
    const expectedHasClear = /this\.revertTokens\.clear\(\)/u.test(METHOD);
    let detail = "body differs from METHOD";
    if (actualHasClear && !expectedHasClear) {
      detail = "on-disk body clears revertTokens wholesale (breaks the 2nd rewind); METHOD deletes only the withdrawn branch";
    }
    return { current: false, detail };
  }

  // The method body is only HALF of this patch: `revert()` also has to call it.
  //
  // Comparing METHOD alone was a real defect, not a theoretical one.  A file
  // whose `CALL` had been downgraded to an older form (say, one that truncates
  // on a `files` scope too, or drops the `no history row carries this id`
  // warning) still has exactly 2 markers and an unchanged METHOD — so every
  // staleness check said "current", `apply` reported `already-patched`, and the
  // corrected CALL could never reach an existing install.  That is the same
  // failure the METHOD comparison exists to prevent, one level down: the script's
  // own README already states the rule ("幂等不能只看 marker 数 … 修好的体永远进不去"),
  // and the CALL was simply left out of it.
  //
  // Worse, deleting the CALL entirely (leaving only the two marker comments)
  // produced a file that still parsed, still had 2 markers, and still reported
  // "patched / body current" — while `revert()` no longer called anything, i.e.
  // the patch was inert and both checkers were green.
  const callStale = rewindCallStaleness(source);
  if (!callStale.current) return { current: false, detail: callStale.detail };

  return { current: true, detail: "body matches METHOD and CALL is present in revert()" };
}

/**
 * Is the call this patch inserts into `revert()` still there, in its current form?
 *
 * Located from ANCHOR_B's *shape* — the `await this.bridge.revert({...});` block
 * plus the method's closing brace — because that is the only stable thing left
 * in a patched file (the pristine anchor no longer matches once the call has been
 * inserted between the `});` and the `}`).
 *
 * The check is deliberately "the expected code lines are a subsequence of the
 * actual ones" rather than an exact match:
 *   - the injected block sits inside `revert()`, whose other statements are
 *     upstream's and may legitimately change;
 *   - comments and indentation are already normalised away by `codeLines()`.
 * An exact match would report stale on every unrelated upstream edit inside
 * `revert()` and trigger a pointless rebuild on every start.
 *
 * A missing or downgraded call is what actually breaks the feature, and both
 * show up as "one of these lines is gone".
 *
 * @param {string} source - file on disk (markers already counted 2).
 * @returns {{current: boolean, detail: string}}
 */
function rewindCallStaleness(source) {
  const tail = /^([ \t]*)await this\.bridge\.revert\(\{[\s\S]*?^\1\}[ \t]*\r?$/mu.exec(source);
  if (tail === null) {
    return {
      current: false,
      detail: "the `await this.bridge.revert({…});` tail of revert() was not found, so the inserted CALL cannot be located",
    };
  }
  // Everything from the `await` back to the start of `revert()`'s body, so the
  // search covers the whole method and not just its last two statements.
  const signature = /^([ \t]*)async revert\(messageId, scope\)[ \t]*\{[ \t]*\r?$/mu.exec(source);
  const from = signature === null ? tail.index : Math.min(signature.index, tail.index);
  const region = codeLines(source.slice(from, tail.index + tail[0].length));

  // The lines that make the patch do something.  `truncateHistoryFrom(messageId)`
  // alone is not enough: the method definition above `revert()` contains that
  // same substring, so a file with only the method and no call would pass.
  const required = [
    'if (scope !== "files" && !this.truncateHistoryFrom(messageId)) {',
    "process.stderr.write(`[plugin-provider] rewind ${messageId}: no history row carries this id; `",
  ];
  const missing = required.filter((line) => !region.includes(line));
  if (missing.length === 0) return { current: true, detail: "CALL present in revert()" };

  // Distinguish "deleted" from "downgraded", because the fix differs: a deleted
  // call is rebuilt by re-applying, a downgraded one needs the anchors re-checked.
  const hasAnyCall = region.some((line) => line.includes("this.truncateHistoryFrom(messageId)"));
  return {
    current: false,
    detail: hasAnyCall
      ? "revert() calls truncateHistoryFrom() in an older/edited form (missing the scope guard or the warning)"
      : "revert() never calls truncateHistoryFrom() — the patch body is present but inert",
  };
}

/**
 * The *code* lines of a block, normalised for comparison.
 *
 * Comments, blank lines and indentation are dropped: staleness is about
 * semantics, so a reformat or a comment edit must not read as "the body changed"
 * (that would trigger a rebuild on every start).  Shared by both staleness
 * checks on purpose — two copies of this rule would drift, and then two targets
 * would disagree about what "the same body" means.
 *
 * @param {string} text
 * @returns {string[]}
 */
function codeLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) => !line.startsWith("*") && !line.startsWith("/*") && !line.startsWith("//"));
}

/**
 * Index of the `}` that closes the brace at `openIndex`, or -1.
 *
 * Skips over string literals, template literals and comments so a brace inside
 * any of them cannot throw the count off.  Deliberately minimal — the only
 * caller compares one method body — but it must not be fooled by the `}` that
 * appears inside the very strings this method compares.
 *
 * @param {string} text - whole file.
 * @param {number} openIndex - index of the opening `{`.
 * @returns {number} index of the matching `}`, or -1 when unbalanced.
 */
function matchClosingBrace(text, openIndex) {
  if (text[openIndex] !== "{") return -1;
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      if (newline === -1) return -1;
      index = newline;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) return -1;
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") { index += 2; continue; }
        if (text[index] === quote) break;
        index += 1;
      }
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Replace the stale rewind patch **in place**, without touching anything else in
 * the file.
 *
 * What has to change is exactly two things: the `truncateHistoryFrom()` method
 * (doc comment + body) and the call the patch inserts inside `revert()`.  Both
 * are located by their own anchors, so this works on a file that also carries an
 * upstream edit or any other local change — none of it is read, compared or
 * rewritten.
 *
 * This replaces the earlier "restore a clean backup, then re-apply" design, which
 * needed a "is this backup the same upstream version?" judgement for a whole-file
 * replacement.  Every version of that judgement had a blind spot (the first one
 * stripped the rewind patch and compared, which is wrong whenever any other local
 * change is also present — i.e. the normal state), and getting it wrong replaces
 * a module with a different version.  Editing in place removes the question.
 *
 * Whole-operation-in-memory: the caller writes only after this returns a string,
 * so a failure leaves the file byte-identical.
 *
 * @param {string} source - the file currently on disk (markers present).
 * @returns {string | null} the rebuilt content, or null after recording why not.
 */
function rebuildRewindInPlace(source) {
  const signature = /^([ \t]*)truncateHistoryFrom\(messageId\)[ \t]*\{[ \t]*\r?$/mu.exec(source);
  if (signature === null) {
    process.stderr.write(
      "[rewind-patch] WARNING: the stale rewind body has no truncateHistoryFrom() method to replace.\n"
      + "  Nothing was written. Reinstall @getpaseo/cli to get a clean file.\n",
    );
    succeed({
      reason: "stale-patch-method-missing",
      targetMd5: md5(readFileSync(TARGET, "utf8")),
      message: "撤回补丁体是旧版，但文件里找不到可替换的 truncateHistoryFrom()，已保持原文件不动。"
        + "重装 @getpaseo/cli 后重跑本脚本即可修复。",
      extra: { patchBody: "stale", staleDetail: "truncateHistoryFrom() not found" },
    });
    process.stdout.write("[rewind-patch] rewind: stale-patch-method-missing (file untouched)\n");
    return null;
  }

  const indent = signature[1];
  const openBrace = signature.index + signature[0].indexOf("{");
  const close = matchClosingBrace(source, openBrace);
  if (close === -1) {
    process.stderr.write(
      "[rewind-patch] WARNING: cannot find the end of the stale truncateHistoryFrom() method.\n"
      + "  Nothing was written. Reinstall @getpaseo/cli to get a clean file.\n",
    );
    succeed({
      reason: "stale-patch-method-unterminated",
      targetMd5: md5(readFileSync(TARGET, "utf8")),
      message: "撤回补丁体是旧版，但方法体没有闭合，已保持原文件不动。重装 @getpaseo/cli 后重跑。",
      extra: { patchBody: "stale", staleDetail: "truncateHistoryFrom() has no matching brace" },
    });
    process.stdout.write("[rewind-patch] rewind: stale-patch-method-unterminated (file untouched)\n");
    return null;
  }

  // The replacement starts at the method's own doc comment, if there is one
  // immediately above it.  Walk back line by line while the lines are comment
  // lines, so a `/` inside the body can never be mistaken for the start.
  let blockStart = signature.index;
  {
    const lines = source.slice(0, signature.index).split("\n");
    let index = lines.length - 1;
    // `lines[last]` is the text before the signature on its own line (indent).
    while (index >= 0) {
      const line = lines[index];
      const trimmed = line.trim();
      if (trimmed === "" && index === lines.length - 1) {
        index -= 1;
        continue;
      }
      if (trimmed.startsWith("*") || trimmed.startsWith("/**") || trimmed.startsWith("*/")) {
        index -= 1;
        continue;
      }
      break;
    }
    // The doc block begins on the line after the last non-comment line.
    const consumed = lines.length - 1 - index;
    if (consumed > 0 && source.slice(0, signature.index).split("\n")[index + 1].trim().startsWith("/**")) {
      blockStart = lines.slice(0, index + 1).join("\n").length + 1;
    }
  }

  const unit = detectIndentUnit(source.slice(signature.index, close + 1));
  const crlf = source.includes("\r\n");
  const methodText = normaliseEol(reindent(METHOD, METHOD_BASE_INDENT, indent, unit), crlf);

  // The patch is **two** blocks: this method and the call to it inside
  // `revert()`.  Rebuilding only the method left the call at whatever older
  // form it had, reported `patched-from-stale`, and the next `--check` went red
  // again — an endless rebuild loop that never converged.  Measured before this
  // fix: downgrade the call, run apply, and the guard is still missing.
  //
  // Both edits are computed against the *original* text and applied from the
  // back, so the second one's offset stays valid.
  const callEdit = rebuildRewindCall(source, unit, crlf);
  if (callEdit === null) return null; // it already recorded why

  const edits = [
    { index: blockStart, length: close + 1 - blockStart, text: methodText },
    callEdit,
  ].sort((left, right) => right.index - left.index);

  let patched = source;
  for (const edit of edits) {
    patched = patched.slice(0, edit.index) + edit.text + patched.slice(edit.index + edit.length);
  }

  const patchedMarkers = countOccurrences(patched, MARKER);
  if (patchedMarkers !== 2) {
    process.stderr.write(
      `[rewind-patch] WARNING: replacing the stale method produced `
      + `${String(patchedMarkers)} marker(s), expected 2. Nothing was written.\n`,
    );
    succeed({
      reason: "stale-patch-rebuild-marker-wrong",
      targetMd5: md5(readFileSync(TARGET, "utf8")),
      message: "撤回补丁体是旧版，原地替换后标记数不对，已保持原文件不动。重装 @getpaseo/cli 后重跑。",
      extra: { patchBody: "stale", staleDetail: `rebuilt markers ${String(patchedMarkers)}`, markers: patchedMarkers },
    });
    process.stdout.write("[rewind-patch] rewind: stale-patch-rebuild-marker-wrong (file untouched)\n");
    return null;
  }
  return patched;
}

/**
 * Locate the region `revert()` occupies between its `bridge.revert({…})` call and
 * its closing brace — i.e. exactly where the patch's `CALL` lives.
 *
 * Why this shape: once patched, `ANCHOR_B_RE` deliberately no longer matches (the
 * inserted call sits between the `});` and the method's `}`), so a rebuild cannot
 * use it.  The anchor's *pieces* are still there, though: the `await
 * this.bridge.revert({` line, its terminating `});` line, and the method's final
 * `}` — found by brace matching, not by regex, so a string inside them cannot
 * throw it off.
 *
 * @param {string} source - file on disk.
 * @returns {{start: number, end: number, indent: string} | null} the region to
 *   overwrite (from just after the `});` line to the start of the closing `}`
 *   line), its indentation, or null when the shape is not there.
 */
function locateRewindCallRegion(source) {
  const signature = /^([ \t]*)async revert\(messageId, scope\)[ \t]*\{[ \t]*\r?$/mu.exec(source);
  if (signature === null) return null;
  const openBrace = signature.index + signature[0].indexOf("{");
  const close = matchClosingBrace(source, openBrace);
  if (close === -1) return null;

  const awaitLine = /^([ \t]*)await this\.bridge\.revert\(\{/mu.exec(source.slice(openBrace, close));
  if (awaitLine === null) return null;
  const awaitAt = openBrace + awaitLine.index;
  const indent = awaitLine[1];

  // The bridge call's own terminator: the first `});` line after the `await`.
  // Nothing inside the object literal closes a brace at that indent with `);`,
  // so the first match is the call's end.
  const callEnd = /\r?\n([ \t]*)\}\);\r?\n/u.exec(source.slice(awaitAt, close));
  if (callEnd === null) return null;
  const start = awaitAt + callEnd.index + callEnd[0].length;

  // Everything up to the line that holds the method's closing brace.
  const end = source.lastIndexOf("\n", close) + 1;
  if (end < start) return null;
  return { start, end, indent };
}

/**
 * Rebuild the `CALL` inside `revert()` in place.
 *
 * Called from the stale-rebuild path, where the method body has already been
 * decided to be older than this script — but the call is a *separate* block and
 * can be stale on its own (downgraded, or deleted down to its comments).  If the
 * method is stale and the call is current this overwrites the call with identical
 * bytes; if the call is stale it is what makes the rebuild actually land.
 *
 * @param {string} source - file on disk.
 * @param {string} unit - the file's indentation unit (from `detectIndentUnit`).
 * @param {boolean} crlf - whether the file uses CRLF.
 * @returns {{index: number, length: number, text: string} | null} the edit, or
 *   null after recording why it could not be built.
 */
function rebuildRewindCall(source, unit, crlf) {
  const region = locateRewindCallRegion(source);
  if (region === null) {
    process.stderr.write(
      "[rewind-patch] WARNING: cannot locate the body of revert() to rebuild the truncateHistoryFrom() call.\n"
      + "  Nothing was written. Reinstall @getpaseo/cli to get a clean file.\n",
    );
    succeed({
      reason: "stale-patch-call-unlocatable",
      targetMd5: md5(readFileSync(TARGET, "utf8")),
      message: "撤回补丁体是旧版，但找不到 revert() 里插入调用的位置，已保持原文件不动。"
        + "重装 @getpaseo/cli 后重跑本脚本即可修复。",
      extra: { patchBody: "stale", staleDetail: "revert() body not locatable" },
    });
    process.stdout.write("[rewind-patch] rewind: stale-patch-call-unlocatable (file untouched)\n");
    return null;
  }
  return {
    index: region.start,
    length: region.end - region.start,
    text: normaliseEol(reindent(CALL, CALL_BASE_INDENT, region.indent, unit), crlf),
  };
}

/**
 * Is the turnId patch body currently on disk the one this script would write?
 *
 * Same reasoning as the other two staleness checks: the injected call is part of
 * this script, so a marker count of 2 proves presence, not currency.  Earlier this
 * target reported `body NOT verified` and still `ok`, which meant a corrupted body
 * (`BROKEN_XYZ` with valid syntax and 2 markers) passed `--check` as
 * "all patches in place" and `apply` as "already patched" — a permanent false
 * green.  The replacement text is short and fully determined by
 * `turnIdCall(indent)`, so checking it is cheap after all.
 *
 * @param {string} source - file on disk (markers already counted 2).
 * @returns {{current: boolean, detail: string}}
 */
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
    const closeIndex = lines.findIndex(
      (line, at) => at > index && line.trim() === "});" && line.startsWith(indent),
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
 * Upstream shape #7675 would replace `this.history` — the array this whole patch
 * truncates — with something else.
 *
 * #7675 is the proposal to give `PluginAgentSession` a real history object
 * (`new PluginSessionHistory(...)`, `this.history.read(...)`) instead of a plain
 * array.  If that lands, `truncateHistoryFrom()` becomes a **runtime no-op**: the
 * injected method still parses, both markers are still there, `this.history.length
 * = cut` silently does nothing useful, and every rewind appears to succeed while
 * the timeline keeps the withdrawn turns — the exact silent degradation this
 * patch exists to remove.
 *
 * So it is checked **before** the anchors and on **both** paths (clean file and
 * already-patched file), and it fails closed: exit 1, nothing written, reason in
 * the status file.  The systemd `ExecStartPre` has a `-` prefix, so the daemon
 * still boots — only the patch stops pretending to work.
 *
 * Deliberately a substring test rather than a parse: the point is "this file no
 * longer looks like the shape I was written against", and a false positive here
 * only means a human looks at it.
 */
const UPSTREAM_HISTORY_OBJECT_SHAPES = ["new PluginSessionHistory(", "this.history.read("];

/**
 * @param {string} source - file to test.
 * @returns {string | null} the offending shape, or null when the file still uses
 *   a plain array.
 */
function upstreamHistoryObjectShape(source) {
  for (const shape of UPSTREAM_HISTORY_OBJECT_SHAPES) {
    if (source.includes(shape)) return shape;
  }
  return null;
}

/**
 * The private fields the injected `truncateHistoryFrom()` reads, and the call
 * shapes it relies on.
 *
 * The anchors prove the *insertion points* are still there.  They say nothing
 * about these three fields, which the injected body dereferences directly:
 *
 *   - `this.history`          — the array being truncated (`this.history.length = cut`);
 *   - `this.timelineSnapshots`— cleared after a truncation;
 *   - `this.revertTokens`     — pruned per id for the withdrawn branch.
 *
 * Upstream renaming or restructuring any of them leaves both anchors matching,
 * the patch applying, markers at 2/2, ESM syntax valid, `--check` reporting
 * "body current" — and then **every** rewind throws
 * `TypeError: Cannot read properties of undefined (reading 'length')`, because
 * `agent-manager.rewind()` rethrows what `revert()` throws.  A loud failure at
 * patch time is strictly better than a loud failure on every rewind.
 *
 * Only checked on a **clean** file (before the patch is written).  On an
 * already-patched file the injected body contains these very strings, so the
 * check would always pass and prove nothing.
 */
const HOST_FIELD_SHAPES = [
  // The array itself: assigned as an array literal, and pushed to.  (The patch
  // sets `.length`; an array is the only shape where that means "truncate".)
  { name: "this.history", shapes: ["this.history = []", "this.history.push("] },
  // A Map used as the translation cache, and passed to `mapTimelineItem()`
  // together with `revertTokens` — the two maps the injected body prunes.  The
  // patch calls `.clear()` on it, which is a Map method, so being a Map is the
  // property that matters; `this.timelineSnapshots.clear()` itself does *not*
  // appear in a clean file (the patch adds the only call).
  {
    name: "this.timelineSnapshots",
    shapes: ["this.timelineSnapshots = new Map()", "this.timelineSnapshots, this.revertTokens"],
  },
  // Read for a token in `revert()`, and deleted per id by the patch.  Same
  // reasoning: `.delete()`'s presence is the patch's, not the host's.
  { name: "this.revertTokens", shapes: ["this.revertTokens = new Map()", "this.revertTokens.get("] },
];

/**
 * @param {string} source - a marker-free (clean) file.
 * @returns {{ok: true} | {ok: false, field: string, missing: string[]}}
 */
function hostFieldShapes(source) {
  for (const field of HOST_FIELD_SHAPES) {
    const missing = field.shapes.filter((shape) => !source.includes(shape));
    if (missing.length > 0) return { ok: false, field: field.name, missing };
  }
  return { ok: true };
}

function applyRewindPatch() {
  if (!existsSync(TARGET)) {
    die("target-missing", `target not found: ${TARGET}`);
  }

  const source = readFileSync(TARGET, "utf8");
  const current = md5(source);
  const markers = countOccurrences(source, MARKER);

  // ── #7675 guard — runs on BOTH paths, before anything else ──────────────
  // If `this.history` is no longer a plain array, the injected body becomes a
  // runtime no-op: it parses, the markers stay at 2, `--check` says "body
  // current", and every rewind silently fails to shorten the timeline.  Fail
  // closed instead of pretending. See `UPSTREAM_HISTORY_OBJECT_SHAPES`.
  const historyShape = upstreamHistoryObjectShape(source);
  if (historyShape !== null) {
    die(
      "upstream-history-shape-changed",
      `PluginAgentSession.history is no longer an array (found \`${historyShape}\`): this is the #7675\n`
      + "  shape, where truncateHistoryFrom() would be a runtime no-op — it would still parse, still\n"
      + '  report "patched", and every rewind would silently keep the withdrawn turns on the timeline.\n'
      + "  Retire or rewrite this target before upgrading: see NOPATCH-PLAN.md section 6 / UPGRADE.md.\n"
      + "  Nothing was written.",
      {
        targetMd5: current,
        extra: { upstreamHistoryShape: historyShape, markers, patchBody: "unknown" },
      },
    );
  }

  // Idempotent success, checked before the anchors: once patched, anchor B is
  // deliberately no longer present (the call was inserted inside it).
  //
  // The marker count alone is NOT enough to call a patched file "current" — the
  // patch's own *content* can change between versions of this script (it did:
  // the first cut cleared `revertTokens` wholesale, which broke every rewind
  // after the first with "No provider revert token for message …").  A file
  // carrying the older body still has exactly 2 markers, so a marker-only check
  // reports "already patched" forever and the corrected body never reaches disk.
  //
  // So: when the markers are right, also compare the body actually on disk
  // against what this script would write now.  Equal => genuinely idempotent.
  // Different => the patch is stale; fall through and re-apply it, which is safe
  // because `truncateHistoryFrom` is a whole method replaced as one block.
  if (markers === 2) {
    const stale = rewindPatchStaleness(source);
    if (stale.current) {
      succeed({
        reason: "already-patched",
        targetMd5: current,
        message: "补丁已在位（幂等命中），无需动作。撤回功能正常。",
        // `backup` is carried on this path too, and that is not cosmetic: every
        // daemon start takes exactly this branch, so a status file written here
        // without it replaced the one the last real apply had written (which did
        // carry it).  `backupFromStatus()` then returned null in steady state, and
        // its anti-downgrade guard — "restore the baseline *this* build came
        // from, not whatever backup happens to sort last" — never fired at all.
        // The guard is what keeps `--revert` from reinstating a *previous*
        // upstream version after an upgrade.
        extra: { markers, patchBody: "current", backup: recordedBackup() ?? undefined },
      });
      process.stdout.write(`[rewind-patch] already patched (md5 ${current}), nothing to do\n`);
      return;
    }
    process.stdout.write(
      `[rewind-patch] patch body is STALE (${stale.detail}) — re-applying from the current METHOD\n`,
    );
  }

  if (markers !== 0 && markers !== 2) {
    die(
      "partially-patched",
      `found ${markers} "${MARKER}" marker(s), expected 0 (clean) or 2 (patched).\n`
      + "  The file is in an unknown half-patched state. Restore it (reinstall the package or\n"
      + "  copy a plugin-provider.js.orig-* backup over it), then run this script again.",
      { targetMd5: current, extra: { markers } },
    );
  }

  if (markers === 2) {
    // Stale body: restore the clean baseline the current patch was built from,
    // then let the normal apply path below rebuild it.  Prefer the newest
    // marker-free backup.
    //
    // Everything that can go wrong here degrades to a WARNING, not a failure,
    // and the file is left exactly as it is.  Rationale: a stale body is *old
    // but working* — its known defect is that the second rewind in a session
    // fails with "No provider revert token", not that anything crashes.  Killing
    // the target would turn a recoverable state into a hard one, and the hard
    // one cannot be undone from inside this script: with no clean baseline the
    // body cannot be rebuilt at all, so the operator would have to reinstall
    // @getpaseo/cli.  Meanwhile the sibling target (turnId) has nothing to do
    // with this and must keep running.  So: warn loudly, name the
    // exact consequence, leave the file alone, and report success-with-caveat.
    const staleWarn = (reason, detail) => {
      process.stderr.write(
        `[rewind-patch] WARNING: rewind patch body is stale but CANNOT be rebuilt — ${detail}\n`
        + "  The patch already in place still works; only the SECOND rewind in a session is affected\n"
        + "  (it fails with \"No provider revert token for message …\"). Nothing was written.\n"
        + "  To fix: reinstall @getpaseo/cli (restores a clean file), then re-run this script.\n",
      );
      succeed({
        reason,
        targetMd5: current,
        message: "撤回补丁体是旧版且无法自动重建（缺干净基线），已保持原文件不动。"
          + "撤回仍可用，但同一会话里的第二次撤回会报 \"No provider revert token\"。"
          + "重装 @getpaseo/cli 后重跑本脚本即可修复。",
        extra: { markers, patchBody: "stale", staleDetail: detail, baseline: null },
      });
      process.stdout.write(`[rewind-patch] rewind: ${reason} (file untouched)\n`);
    };

    // Rebuild **in place** — no clean baseline, no whole-file replacement.
    //
    // Earlier versions of this branch restored a clean backup over the target and
    // then re-applied.  That had two failure modes, both measured:
    //   - writing the baseline first meant a failed re-apply left the file as the
    //     bare baseline (0 markers), which `revertRewindPatch()` then reported as
    //     "nothing to revert" — the patch could not be restored at all;
    //   - choosing *which* backup to restore needs a "same upstream version?"
    //     judgement, and every heuristic for it has a blind spot (the first one
    //     compared the file with the patch stripped, which is wrong whenever
    //     another local change is also present — i.e. the normal state).
    //
    // Neither is necessary.  The stale part is exactly one method plus the call
    // inside `revert()`; both are located by their own anchors and can be
    // replaced in place.  Whatever else the file contains — the turnId patch in
    // another file, unrelated upstream edits — is untouched by construction.
    const rebuilt = rebuildRewindInPlace(source);
    if (rebuilt === null) {
      return; // `rebuildRewindInPlace()` already recorded the reason
    }
    const staleBackup = join(
      BACKUP_DIR,
      `${basename(TARGET)}.prestale-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${current.slice(0, 8)}`,
    );
    copyFileSync(TARGET, staleBackup);
    try {
      atomicWrite(TARGET, rebuilt);
    } catch (error) {
      const intact = existsSync(TARGET) && md5(readFileSync(TARGET, "utf8")) === current;
      die(
        "stale-rebuild-write-failed",
        `could not write the rebuilt rewind patch (${error.code ?? "error"}: ${error.message}).\n`
        + (intact
          ? `  The file is untouched (md5 still ${current}).`
          : `  The file DIFFERS from before (expected ${current}); restore it from ${staleBackup}.`),
        { targetMd5: intact ? current : null, extra: { backup: staleBackup, patchBody: "stale" } },
      );
    }
    try {
      syntaxCheck(TARGET);
    } catch (error) {
      let restored = null;
      try {
        atomicWrite(TARGET, source);
        restored = md5(readFileSync(TARGET, "utf8"));
      } catch {
        /* reported below */
      }
      die(
        "stale-rebuild-unparsable",
        `rebuilt rewind patch does not parse (${error.message}); `
        + `${restored === current ? "restored the previous content" : `RESTORE FAILED — restore from ${staleBackup}`}.`,
        { targetMd5: restored, extra: { backup: staleBackup, patchBody: "stale" } },
      );
    }
    const rebuiltMd5 = md5(rebuilt);
    succeed({
      reason: "patched-from-stale",
      targetMd5: rebuiltMd5,
      message: "撤回补丁体是旧版，已在原地替换为当前版本（未整文件替换，其它补丁不受影响）。撤回功能正常。",
      extra: {
        upstreamMd5: current,
        patchedMd5: rebuiltMd5,
        backup: staleBackup,
        markers: 2,
        patchBody: "rebuilt-from-stale",
      },
    });
    process.stdout.write(
      `[rewind-patch] stale body rebuilt in place, md5 ${current} -> ${rebuiltMd5}\n`
      + `[rewind-patch] pre-stale backup: ${staleBackup}\n`
      + "[rewind-patch] ESM syntax ok\n",
    );
    return;
  }

  // ── Upstream may have fixed #4667 itself ───────────────────────────────
  // Runs only on a clean (marker-free) file, which is what keeps the patch's own
  // inserted CALL text out of the count — checking a patched file would always
  // "detect" a fix and be a permanent false positive.
  const upstreamFix = detectUpstreamSelfFix(source);
  if (upstreamFix.fixed) {
    die(
      "upstream-fixed-retire-patch",
      `upstream already truncates its own history inside revert() (${upstreamFix.hits} site(s)):\n`
      + upstreamFix.sites.map((line) => `    ${line}`).join("\n")
      + "\n  #4667 looks fixed upstream, so this local patch should be RETIRED rather than re-applied:\n"
      + "  it is now redundant, and every rewind would log a false\n"
      + '  "[plugin-provider] rewind ...: no history row carries this id" warning.\n'
      + "  See UPGRADE.md section 5 for the removal steps. Nothing was written.",
      { targetMd5: current, extra: { upstreamFixHits: upstreamFix.hits, upstreamFixSites: upstreamFix.sites } },
    );
  }

  // ── Host-field precondition — fail closed BEFORE writing anything ────────
  // The anchors below only prove the insertion *points* exist.  The injected
  // body also dereferences `this.history` / `this.timelineSnapshots` /
  // `this.revertTokens`; if upstream renamed or restructured one of them, the
  // patch would apply cleanly and then throw a TypeError on every rewind.  Only
  // meaningful on a clean file (on a patched one the injected body itself
  // contains these strings).
  const hostFields = hostFieldShapes(source);
  if (!hostFields.ok) {
    die(
      "host-fields-changed",
      `the fields this patch edits are not the ones upstream now uses: ${hostFields.field} is missing\n`
      + `  ${hostFields.missing.map((shape) => `\`${shape}\``).join(", ")}\n`
      + "  The injected truncateHistoryFrom() reads this.history / this.timelineSnapshots /\n"
      + "  this.revertTokens directly, so applying the patch would make every rewind throw a TypeError.\n"
      + "  Upstream restructured the translation cache — rewrite METHOD (and this check) against the new\n"
      + "  shape. Nothing was written; rewind stays in its current state.",
      { targetMd5: current, extra: { hostField: hostFields.field, hostFieldMissing: hostFields.missing } },
    );
  }

  const aMatches = matchAll(ANCHOR_A_RE, source);
  const bMatches = matchAll(ANCHOR_B_RE, source);

  // Exactly one each: 0 = the insertion site moved/disappeared, >1 = ambiguous.
  // Neither is safe to guess at, so both fail closed.
  if (aMatches.length !== 1 || bMatches.length !== 1) {
    die(
      "anchor-mismatch",
      `unexpected upstream shape: anchor A (publish) matched ${aMatches.length} time(s), `
      + `anchor B (revert tail) matched ${bMatches.length} time(s); expected exactly 1 each.\n`
      + "  The insertion sites moved or were rewritten. Re-check ANCHOR_A_RE / ANCHOR_B_RE in this script\n"
      + "  against the current file. Until then rewind is DEGRADED: withdrawn turns stay on the timeline\n"
      + "  until the agent is reloaded (no data loss).",
      { targetMd5: current, extra: { anchorA: aMatches.length, anchorB: bMatches.length } },
    );
  }

  const crlf = source.includes("\r\n");
  const unit = detectIndentUnit(aMatches[0][0]);
  const indentA = aMatches[0][1];
  const indentB = bMatches[0][1];

  const methodText = normaliseEol(reindent(METHOD, METHOD_BASE_INDENT, indentA, unit), crlf);
  const callText = normaliseEol(reindent(CALL, CALL_BASE_INDENT, indentB, unit), crlf);

  // Insert the call just above the closing brace of revert(): the match's last
  // line is `<indent>}`, so splice right after the newline that starts it.
  const bMatchText = bMatches[0][0];
  const bLastNewline = bMatchText.lastIndexOf("\n");
  const bPatched = bLastNewline === -1
    ? callText + bMatchText
    : bMatchText.slice(0, bLastNewline + 1) + callText + bMatchText.slice(bLastNewline + 1);

  // ANCHOR_B sits *before* ANCHOR_A in this file (revert() precedes publish()),
  // so apply the later offset first and never shift the earlier one.
  const edits = [
    { index: aMatches[0].index, length: aMatches[0][0].length, text: methodText + aMatches[0][0] },
    { index: bMatches[0].index, length: bMatches[0][0].length, text: bPatched },
  ].sort((left, right) => right.index - left.index);

  let patched = source;
  for (const edit of edits) {
    patched = patched.slice(0, edit.index) + edit.text + patched.slice(edit.index + edit.length);
  }

  const patchedMarkers = countOccurrences(patched, MARKER);
  if (patchedMarkers !== 2) {
    die("marker-count-wrong", `expected 2 "${MARKER}" markers after patching, found ${patchedMarkers}`, {
      targetMd5: current,
      extra: { markers: patchedMarkers },
    });
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  // The upstream md5 in the name keeps successive upgrades distinguishable.
  const backup = join(BACKUP_DIR, `plugin-provider.js.orig-${timestamp}-${current.slice(0, 8)}`);
  copyFileSync(TARGET, backup);

  // Atomic: a failed write leaves the original file untouched, so there is
  // nothing to recover from.  (The old code wrote in place and then tried to
  // recover — a write that dies partway cannot be undone from inside.)
  try {
    atomicWrite(TARGET, patched);
  } catch (error) {
    const stillIntact = existsSync(TARGET) && md5(readFileSync(TARGET, "utf8")) === current;
    die(
      "write-failed",
      `could not write the patched file (${error.code ?? "error"}: ${error.message}).\n`
      + (stillIntact
        ? `  ${TARGET} is untouched (md5 still ${current}); the backup at ${backup} was not needed.`
        : `  ${TARGET} DOES NOT match the pre-patch content (expected ${current}) — restore it from ${backup}.`),
      {
        targetMd5: stillIntact ? current : null,
        extra: { backup, prePatchMd5: current, targetIntact: stillIntact },
      },
    );
  }

  // The one gate that must actually work: a broken patch is a broken daemon.
  // syntaxCheck() throws (it does not exit), so this rollback is reachable.
  try {
    syntaxCheck(TARGET);
  } catch (error) {
    const checkUnavailable = error.code === "SYNTAX_CHECK_UNAVAILABLE";
    // Put the clean content back.  If even that fails we must say so loudly
    // instead of pretending the file is fine.
    let rolledBack = null;
    let rollbackError = null;
    try {
      atomicWrite(TARGET, source);
      rolledBack = md5(readFileSync(TARGET, "utf8"));
    } catch (rollbackFailure) {
      rollbackError = `${rollbackFailure.code ?? "error"}: ${rollbackFailure.message}`;
    }
    const restoredCleanly = rolledBack !== null && rolledBack === current;
    die(
      checkUnavailable ? "syntax-check-unavailable" : "syntax-check-failed",
      (checkUnavailable
        ? `could not verify the patched file: ${error.message}`
        : `patched file does not parse; ${restoredCleanly ? "restored the pre-patch content" : "RESTORE FAILED"}.\n  ${error.message}`)
      + (rollbackError === null
        ? `\n  Target md5 ${rolledBack}${restoredCleanly ? " (identical to pre-patch)" : ` (DIFFERS from pre-patch ${current})`}.`
        : `\n  COULD NOT restore the pre-patch content (${rollbackError}).`
          + `\n  ${TARGET} may hold unverified patched content. Expected md5 ${current}; backup is ${backup}.`),
      {
        targetMd5: rolledBack,
        extra: {
          backup,
          prePatchMd5: current,
          restoredCleanly,
          rollbackSucceeded: rollbackError === null,
          patchedCandidateMd5: md5(patched),
        },
      },
    );
  }

  const adapted = current !== BASE_MD5;
  const patchedMd5 = md5(patched);
  succeed({
    reason: adapted ? "patched-on-new-upstream" : "patched",
    targetMd5: patchedMd5,
    message: adapted
      ? `上游文件已变化（当前 ${current}，已知基线 ${BASE_MD5}），锚点自适配后补丁已自动打上。撤回功能正常。`
        + "建议顺手看一眼上游改了什么，确认没动撤回语义。"
      : "补丁已打上（上游与已知基线一致）。撤回功能正常。",
    extra: {
      upstreamMd5: current,
      patchedMd5,
      backup,
      // `markers` is carried so the status file can report it on the success
      // path too.  Without it the top-level `markers` field was always missing,
      // which made `carry()`'s markers entry a dead branch.
      markers: 2,
      anchorA: 1,
      anchorB: 1,
      indentUnit: unit === "\t" ? "tab" : String(unit.length),
      indentAWidth: indentA.length,
      indentBWidth: indentB.length,
      adaptedToNewUpstream: adapted,
    },
  });

  process.stdout.write(
    `[rewind-patch] applied: 2 anchors (indent unit ${unit === "\t" ? "tab" : unit.length})\n`
    + `[rewind-patch] backup: ${backup}\n`
    + `[rewind-patch] md5 ${current} -> ${patchedMd5}`
    + `${adapted ? ` (upstream differs from baseline ${BASE_MD5})` : ""}\n`
    + "[rewind-patch] ESM syntax ok\n",
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Patch 2 — apply / revert the turnId patch on agent-manager.js
// ───────────────────────────────────────────────────────────────────────────

/**
 * Backups for the turnId target go in `BACKUP_DIR` (`REWIND_PATCH_HOME`), next to
 * the rewind backups, under a name this script alone uses.
 *
 * This used to be `dirname(TURNID_TARGET)` — the globally installed package's
 * dist directory — and that was a real defect, not a preference: `npm i -g
 * @getpaseo/cli@<new>` replaces `@getpaseo/server/dist` wholesale, so the backup
 * is deleted at exactly the moment it is needed (a fresh upgrade whose patch
 * broke). `--revert` then reported `turnid-no-backup` with no clean copy
 * anywhere, and the only recovery was reinstalling — which lands you back at
 * "patch missing". Two such files were sitting in the live install when this was
 * found.
 *
 * Why keeping them in the *same directory* as the rewind backups is safe: the
 * two namespaces do not intersect (`plugin-provider.js.orig-` vs
 * `agent-manager.js.orig-turnid-`), and `latestBackup()` / `latestTurnIdBackup()`
 * each filter by their own prefix, so neither lookup can see the other's files.
 * The old comment justified the separate directory with "cross-target restore is
 * impossible by construction" — that property comes from the **filename prefix**
 * (plus `revertTurnIdPatch()` refusing a backup that carries its own marker), and
 * the prefix is kept verbatim.  Directory separation was never what provided it.
 */
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
 * Apply the turnId patch to `TURNID_TARGET`. Idempotent; throws `PatchFailure`
 * (via `die()`) on any failure so the rewind target still runs.
 *
 * The three states are the same as the rewind patch's, and the middle one is
 * refused rather than guessed at: 0 markers = clean, 2 = patched, anything else
 * means someone/something wrote half of it.
 */
function applyTurnIdPatch() {
  if (!existsSync(TURNID_TARGET)) {
    die("turnid-target-missing", `target not found: ${TURNID_TARGET}`, {
      extra: { patch: "turnid", turnIdTarget: TURNID_TARGET },
    });
  }

  const source = readFileSync(TURNID_TARGET, "utf8");
  const current = md5(source);
  const markers = countOccurrences(source, TURNID_MARKER);

  if (markers === 2) {
    // Markers prove presence, not currency — same rule as the other two targets.
    const stale = turnIdStaleness(source);
    if (stale.current) {
      succeed({
        reason: "turnid-already-patched",
        targetMd5: current,
        message: "turnId 补丁已在位（幂等命中），无需动作。重开会话可正常折叠轮次。",
        extra: { patch: "turnid", turnIdTarget: TURNID_TARGET, turnIdMarkers: markers, patchBody: "current" },
      });
      process.stdout.write(`[rewind-patch] turnId: already patched (md5 ${current}), nothing to do\n`);
      return;
    }
    process.stdout.write(`[rewind-patch] turnId: patch body is STALE (${stale.detail}) — rebuilding\n`);
    // Rebuild in place: replace each matched replay call with the current form,
    // working backwards so earlier offsets stay valid.  Done entirely in memory;
    // the caller writes once below through the normal path, so a failure here
    // leaves the file untouched.
    // Rebuild by replacing each marker-led region in place.  The pre-patch shape
    // (`TURNID_CALL_RE`) cannot be used here: it no longer matches a patched file,
    // so the rebuild would report "0 sites" on exactly the file it must repair.
    const rebuiltLines = source.split("\n");
    let replacedRegions = 0;
    for (let index = 0; index < rebuiltLines.length; index += 1) {
      if (!rebuiltLines[index].includes(TURNID_MARKER)) continue;
      const indent = /^[ \t]*/u.exec(rebuiltLines[index])[0];
      const closeIndex = rebuiltLines.findIndex(
        (line, at) => at > index && line.trim() === "});" && line.startsWith(indent),
      );
      if (closeIndex === -1) {
        die(
          "turnid-stale-anchor-mismatch",
          `the turnId region starting at line ${String(index + 1)} has no closing \`});\`. Nothing was written.`,
          { targetMd5: current, extra: { patch: "turnid", patchBody: "stale" } },
        );
      }
      rebuiltLines.splice(index, closeIndex - index + 1, ...turnIdCall(indent).split("\n"));
      index += turnIdCall(indent).split("\n").length - 1;
      replacedRegions += 1;
    }
    if (replacedRegions !== 2) {
      die(
        "turnid-stale-anchor-mismatch",
        `the turnId patch body is stale but ${String(replacedRegions)} region(s) were found, expected exactly 2. `
        + "Nothing was written; reinstall @getpaseo/cli to get a clean file.",
        { targetMd5: current, extra: { patch: "turnid", turnIdRegions: replacedRegions, patchBody: "stale" } },
      );
    }
    const rebuilt = rebuiltLines.join("\n");
    if (countOccurrences(rebuilt, TURNID_MARKER) !== 2) {
      die(
        "turnid-stale-rebuild-marker-wrong",
        `rebuilding the stale turnId body produced ${String(countOccurrences(rebuilt, TURNID_MARKER))} marker(s), expected 2. `
        + "Nothing was written.",
        { targetMd5: current, extra: { patch: "turnid", patchBody: "stale" } },
      );
    }
    // Also under `BACKUP_DIR`: a prestale snapshot is rollback material for the
    // same upgrade that deletes the dist tree, so leaving it there had the same
    // defect as the main backup (see `turnIdBackupPath()`).
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
        { targetMd5: intact ? current : null, extra: { patch: "turnid", backup: rebuiltBackup, patchBody: "stale" } },
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
        { targetMd5: restored, extra: { patch: "turnid", backup: rebuiltBackup, patchBody: "stale" } },
      );
    }
    const rebuiltMd5 = md5(rebuilt);
    succeed({
      reason: "turnid-patched-from-stale",
      targetMd5: rebuiltMd5,
      message: "turnId 补丁体是旧版，已在原地重建。重开会话可正常折叠轮次。",
      extra: {
        patch: "turnid",
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
      { targetMd5: current, extra: { patch: "turnid", turnIdTarget: TURNID_TARGET, turnIdMarkers: markers } },
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
        extra: { patch: "turnid", turnIdTarget: TURNID_TARGET, turnIdMatches: matches.length },
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
          extra: { patch: "turnid", turnIdTarget: TURNID_TARGET, turnIdContext: index + 1 },
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
      { targetMd5: current, extra: { patch: "turnid", turnIdTarget: TURNID_TARGET, turnIdMarkers: patchedMarkers } },
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
        extra: { patch: "turnid", turnIdTarget: TURNID_TARGET, backup, prePatchMd5: current, targetIntact: stillIntact },
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
          patch: "turnid",
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
      patch: "turnid",
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
 * itself patched or does not parse — the same rules the rewind revert applies,
 * for the same reasons.
 */
function revertTurnIdPatch() {
  if (!existsSync(TURNID_TARGET)) {
    die("turnid-target-missing", `target not found: ${TURNID_TARGET}`, {
      extra: { patch: "turnid", turnIdTarget: TURNID_TARGET },
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
      extra: { patch: "turnid", turnIdTarget: TURNID_TARGET, turnIdMarkers: markers },
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
      { targetMd5: current, extra: { patch: "turnid", turnIdTarget: TURNID_TARGET, turnIdMarkers: markers } },
    );
  }

  const backup = latestTurnIdBackup();
  if (backup === null) {
    die(
      "turnid-no-backup",
      `no timestamped backup to restore (looked for ${basename(TURNID_TARGET)}.orig-turnid-* next to it)`,
      { targetMd5: current, extra: { patch: "turnid", turnIdTarget: TURNID_TARGET } },
    );
  }

  const backupSource = readFileSync(backup, "utf8");
  const backupMarkers = countOccurrences(backupSource, TURNID_MARKER);
  if (backupMarkers !== 0) {
    die(
      "turnid-backup-is-patched",
      `backup ${backup} itself carries ${backupMarkers} patch marker(s); it is not a clean baseline. Refusing to restore.`,
      { targetMd5: current, extra: { patch: "turnid", turnIdTarget: TURNID_TARGET, backup } },
    );
  }

  // Validate the backup BEFORE touching the live file.
  try {
    syntaxCheck(backup);
  } catch (error) {
    if (error.code === "SYNTAX_CHECK_UNAVAILABLE") {
      die("turnid-syntax-check-unavailable", `cannot verify backup ${backup}: ${error.message}`, {
        targetMd5: current,
        extra: { patch: "turnid", turnIdTarget: TURNID_TARGET, backup },
      });
    }
    die("turnid-backup-unparsable", `backup ${backup} does not parse: ${error.message}`, {
      targetMd5: current,
      extra: { patch: "turnid", turnIdTarget: TURNID_TARGET, backup },
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
          patch: "turnid",
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
      patch: "turnid",
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

// ───────────────────────────────────────────────────────────────────────────
// Runner — one target's failure must not stop the other (soft, per file)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Run one target's handler with its own failure collector.
 *
 * Returns `{ label, ok, reason, message }` and never throws: a `PatchFailure`
 * is a normal outcome here, and anything else is re-thrown so `recordUnhandled`
 * can still catch a genuine code bug.
 *
 * @param {string} label - short name used in the logs ("rewind" / "turnId").
 * @param {() => void} handler - the target's apply or revert function.
 * @returns {{label: string, ok: boolean, reason: string, message: string}}
 */
function runTarget(label, handler) {
  const previous = runContext;
  runContext = { failures: [], successes: [] };
  const collected = runContext;
  try {
    handler();
  } catch (error) {
    if (!(error instanceof PatchFailure)) {
      // A genuine code bug: restore the outer context and let `recordUnhandled`
      // report it.  Do not fold it into a per-target verdict.
      runContext = previous;
      throw error;
    }
    // Already recorded by `die()`; the throw only unwound this target.
  }
  runContext = previous;

  const failure = collected.failures.at(-1);
  if (failure !== undefined) {
    return { label, ok: false, reason: failure.reason, message: failure.message, extra: failure.extra ?? {} };
  }
  const success = collected.successes.at(-1);
  if (success === undefined) {
    // A handler that neither succeeded nor failed is a bug in this script, not a
    // patch problem — say so rather than reporting a green run.
    return {
      label,
      ok: false,
      reason: `${label}-no-outcome`,
      message: `the ${label} handler returned without recording success or failure`,
      extra: {},
    };
  }
  // `extra` must survive: `backupFromStatus()` reads `status.backup` to find the
  // baseline the current patch was built from, and that value only ever comes
  // from the handler's `succeed({ extra: { backup } })`.  Dropping it here is
  // what silently disabled that whole lookup — revert then always fell back to
  // "newest backup on disk", which is exactly the wrong file after an upgrade.
  //
  // `degraded` is lifted out of `extra` so `reportCombined()` can give it a
  // third verdict instead of printing "all patches in place" for a body it just
  // failed to rebuild.
  const extra = success.extra ?? {};
  return {
    label,
    ok: true,
    reason: success.reason,
    message: success.message,
    extra,
    degraded: extra.patchBody === "stale" || extra.degraded === true,
  };
}

/**
 * Fold the two per-target outcomes into one status file.
 *
 * The **top-level fields keep their existing meaning** — `check-rewind-patch.mjs`
 * reads `ok`, `reason`, `target`, `targetMd5`, `paseoVersion`, `message`,
 * `upstreamMd5`, `backup`, `markers`, and the `patched*` reasons, so a status
 * file written here is still readable by the current checker.  `ok` describes
 * the *rewind* target, exactly as before, and the new `turnId` block carries the
 * second target's verdict.  `allOk` is the new "everything healthy" answer.
 *
 * The reason is taken from the rewind target when it succeeded (preserving
 * `patched` / `already-patched` / `patched-on-new-upstream`, which
 * `backupFromStatus()` keys on) and is a `turnid-*` reason only when the rewind
 * target itself failed — in which case the rewind patch is not in place anyway
 * and there is no rewind backup worth restoring from.
 */
function writeCombinedStatus(results) {
  const rewind = results.find((result) => result.label === "rewind");
  const turnId = results.find((result) => result.label === "turnId");
  // `allOk` answers "is the install fully healthy".  A degraded target (patch
  // present but its body could not be brought up to date) is not healthy, even
  // though the target itself did not fail — otherwise the status file would say
  // `allOk: true` for an install whose second rewind is known to break.
  const allOk = results.every((result) => result.ok && result.degraded !== true);

  const rewindTargetMd5 = (() => {
    try {
      return existsSync(TARGET) ? md5(readFileSync(TARGET, "utf8")) : null;
    } catch {
      return null;
    }
  })();
  const turnIdTargetMd5 = (() => {
    try {
      return existsSync(TURNID_TARGET) ? md5(readFileSync(TURNID_TARGET, "utf8")) : null;
    } catch {
      return null;
    }
  })();
  const rewindBlock = {
    ok: rewind?.ok ?? false,
    reason: rewind?.reason ?? "rewind-missing",
    target: TARGET,
    targetMd5: rewindTargetMd5,
    marker: MARKER,
    message: rewind?.message ?? "撤回补丁目标未执行。",
  };

  const turnIdBlock = {
    ok: turnId?.ok ?? false,
    reason: turnId?.reason ?? "turnid-missing",
    target: TURNID_TARGET,
    targetMd5: turnIdTargetMd5,
    marker: TURNID_MARKER,
    message: turnId?.message ?? "turnId 补丁目标未执行。",
  };

  // `backup` / `upstreamMd5` / `markers` / `patchedMd5` must reach the status
  // file: `backupFromStatus()` prefers `status.backup` over the newest backup on
  // disk, precisely because after an upgrade the newest one can belong to a
  // *previous* upstream version — restoring it would downgrade the module.  If
  // these are dropped, that guard silently never fires.
  const rewindExtra = rewind?.extra ?? {};
  const carry = (block, extra) => {
    const out = { ...block };
    // `upstreamHistoryShape` / `hostField` / `hostFieldMissing` are here because
    // the task requires the *reason* to be readable from the status file, not
    // only from stderr: the startup hook logs one line and the daemon keeps
    // booting, so the status file is what a later `check-rewind-patch.mjs` run
    // (and a human) actually sees.  They were dropped by this whitelist at first
    // and the status file said `host-fields-changed` with no field name.
    for (const key of [
      "backup",
      "upstreamMd5",
      "patchedMd5",
      "markers",
      "patchBody",
      "staleDetail",
      "upstreamHistoryShape",
      "hostField",
      "hostFieldMissing",
    ]) {
      if (extra[key] !== undefined) out[key] = extra[key];
    }
    return out;
  };
  const rewindWithExtra = carry(rewindBlock, rewindExtra);

  writeStatus({
    // ── top-level: unchanged semantics, still the *rewind* verdict ──────────
    ok: rewind?.ok ?? false,
    at: new Date().toISOString(),
    reason: rewind?.ok ? rewind.reason : (rewind?.reason ?? turnId?.reason ?? "unknown"),
    target: TARGET,
    targetMd5: rewindTargetMd5,
    baseMd5: BASE_MD5,
    paseoVersion: readPaseoVersion(),
    message: rewind?.message ?? "撤回补丁目标未执行。",
    // Top-level `backup` / `markers` are read by `check-rewind-patch.mjs` and by
    // `backupFromStatus()`; keep them where they have always been.
    ...(rewindExtra.backup === undefined ? {} : { backup: rewindExtra.backup }),
    ...(rewindExtra.upstreamMd5 === undefined ? {} : { upstreamMd5: rewindExtra.upstreamMd5 }),
    ...(rewindExtra.patchedMd5 === undefined ? {} : { patchedMd5: rewindExtra.patchedMd5 }),
    ...(rewindExtra.markers === undefined ? {} : { markers: rewindExtra.markers }),
    // ── new: the second target, plus the combined answer ────────────────────
    allOk,
    patches: {
      rewind: rewindWithExtra,
      turnId: carry(turnIdBlock, turnId?.extra ?? {}),
    },
    turnId: turnIdBlock,
  });
}

/**
 * Report both outcomes and return the process exit code.
 *
 * Exit code is **0 only when both targets are healthy**. A single failing
 * target exits 1, names the target in the log, and does not prevent the other
 * from having been patched — that is the soft-failure policy, applied per file.
 *
 * @param {Array<{label: string, ok: boolean, reason: string, message: string}>} results
 * @param {"apply" | "revert"} mode - what was asked for, so the summary line does
 *   not claim "patches in place" after a successful revert.
 */
function reportCombined(results, mode) {
  const failed = results.filter((result) => !result.ok);
  // A third state: the target did not fail (nothing was written, the install
  // still works) but it is NOT healthy either — the body on disk is older than
  // this script and could not be rebuilt.  Folding this into "ok" is what made
  // the startup hook log "all patches in place" for an install whose second
  // rewind is known to break; folding it into "failed" would be wrong too,
  // because the patch that is there does work.  It gets its own line and its
  // own exit code so a log reader cannot mistake it for green.
  const degraded = results.filter((result) => result.ok && result.degraded === true);
  for (const result of results) {
    const tag = result.ok ? (result.degraded === true ? "DEGRADED" : "OK") : "FAILED";
    process.stdout.write(`[rewind-patch] ${result.label}: ${tag} (${result.reason})\n`);
  }
  const done = mode === "revert" ? "all patches reverted" : "all patches in place";
  if (failed.length === 0 && degraded.length === 0) {
    // The startup hook logs the *last* stdout line, so end on the summary.
    process.stdout.write(`[rewind-patch] ${done}: ${results.map((r) => r.label).join(" + ")}\n`);
    return 0;
  }
  if (failed.length === 0) {
    // Degraded only: the last line must NOT read as success.
    process.stdout.write(
      `[rewind-patch] DEGRADED: ${degraded.map((r) => r.label).join(", ")} — `
      + "patch present but its body is older than this script and could not be rebuilt; "
      + "reinstall @getpaseo/cli then re-run to fix\n",
    );
    return 3;
  }
  process.stderr.write(
    `[rewind-patch] FAILED target(s): ${failed.map((result) => result.label).join(", ")}\n`,
  );
  // Still end stdout on a summary line so the hook's "last line" is meaningful.
  process.stdout.write(
    `[rewind-patch] ${results.filter((r) => r.ok).map((r) => r.label).join(", ") || "none"} ok; `
    + `failed: ${failed.map((r) => r.label).join(", ")}\n`,
  );
  return 1;
}

/**
 * Entry point: run both targets independently, write one status file, exit once.
 *
 * `--check` answers "are both patches in place" without writing anything:
 * exit 0 = both, 1 = at least one missing or half-patched, and the failing
 * target is named. `--revert` reverts both, each from its own backup.
 */
function main() {
  const checking = process.argv.includes("--check");
  const reverting = process.argv.includes("--revert");

  if (checking) {
    process.exitCode = checkBothTargets();
    return;
  }

  // The two targets live in **different files** (`plugin-provider.js` for rewind,
  // `agent-manager.js` for turnId), so their order does not matter for
  // correctness or for the report — each one only ever touches its own file.
  //
  // (The third target used to be `childRunning`, which shared
  // `plugin-provider.js` with rewind and forced a specific order in both
  // directions. It is retired: upstream getpaseo/paseo#8080 fixed the defect.)
  const results = reverting
    ? [
        runTarget("rewind", revertRewindPatch),
        runTarget("turnId", revertTurnIdPatch),
      ]
    : [
        runTarget("rewind", applyRewindPatch),
        runTarget("turnId", applyTurnIdPatch),
      ];

  writeCombinedStatus(results);
  process.exitCode = reportCombined(results, reverting ? "revert" : "apply");
}

/**
 * `--check`: read both files and report, writing nothing.
 *
 * Exit 0 only when both are patched (marker counts exactly right and the file
 * present). Half-patched and missing targets both exit 1, and the message names
 * which target is at fault — that is the whole point of a check mode that
 * replaces "run apply and see".
 */
function checkBothTargets() {
  const describe = (label, file, marker, expected) => {
    if (!existsSync(file)) {
      return { label, ok: false, detail: `target missing: ${file}` };
    }
    const source = readFileSync(file, "utf8");
    const markers = countOccurrences(source, marker);
    if (markers === expected) {
      return { label, ok: true, detail: `patched (${String(markers)}/${String(expected)} markers, md5 ${md5(source)})` };
    }
    if (markers === 0) {
      return { label, ok: false, detail: `NOT patched (0/${String(expected)} markers, md5 ${md5(source)})` };
    }
    return {
      label,
      ok: false,
      detail: `HALF-PATCHED (${String(markers)}/${String(expected)} markers, md5 ${md5(source)}) — restore from backup`,
    };
  };

  // Every target that can have a stale body gets the same second question.
  // Checking markers alone reports "patched" for a file whose body is older than
  // this script — the exact false green this mode exists to prevent.  Both
  // targets are structurally identical here, so they are handled identically;
  // leaving one of them on marker-count-only was an asymmetry that made
  // `--check` and `check-rewind-patch.mjs` disagree about the same file.
  const withBodyCheck = (label, file, marker, staleness) => {
    const base = describe(label, file, marker, 2);
    if (!base.ok) return base;
    const stale = staleness(readFileSync(file, "utf8"));
    if (stale.current === true) return { ...base, detail: `${base.detail}, body current` };
    // `current: null` would mean "this target has no body check". No target is in
    // that state any more (both now compare their injected body), but the
    // branch is kept honest rather than removed: if it ever comes back it must
    // report NOT verified and must NOT count as healthy, because a corrupted body
    // was measured to pass as `body current` while `apply` also reported
    // `turnid-already-patched` — a permanent false green.
    if (stale.current === null) {
      return {
        label,
        ok: false,
        unchecked: true,
        detail: `${base.detail}, body NOT verified (${stale.detail}) — add a staleness check for this target`,
      };
    }
    return {
      label,
      ok: false,
      detail: `STALE PATCH BODY (${stale.detail}; md5 ${md5(readFileSync(file, "utf8"))}) — re-run without --check to rebuild`,
    };
  };

  const results = [
    withBodyCheck("rewind", TARGET, MARKER, rewindPatchStaleness),
    withBodyCheck("turnId", TURNID_TARGET, TURNID_MARKER, turnIdStaleness),
  ];
  for (const result of results) {
    process.stdout.write(`[rewind-patch] ${result.label}: ${result.ok ? "OK" : "FAILED"} — ${result.detail}\n`);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    process.stdout.write(`[rewind-patch] check: all patches in place (${results.map((r) => r.label).join(" + ")})\n`);
    return 0;
  }
  process.stderr.write(`[rewind-patch] check: NOT in place: ${failed.map((result) => result.label).join(", ")}\n`);
  process.stdout.write(`[rewind-patch] check: failed targets: ${failed.map((result) => result.label).join(", ")}\n`);
  return 1;
}

export {
  ANCHOR_A_RE,
  ANCHOR_B_RE,
  BASE_MD5,
  MARKER,
  STATUS_FILE,
  TARGET,
  TURNID_CALL_RE,
  TURNID_MARKER,
  TURNID_TARGET,
  countOccurrences,
  detectIndentUnit,
  detectUpstreamSelfFix,
  matchAll,
  md5,
  rewindPatchStaleness,
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
