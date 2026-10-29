/**
 * LOCAL PATCH (paseo-dsh) — startup hook: re-apply the rewind patch on every
 * worker start, including the ones systemd never sees.
 *
 * WHY THIS EXISTS
 * ---------------
 * The rewind patch (`apply-rewind-history-truncation.mjs`) rewrites
 * `@getpaseo/server/dist/server/server/agent/plugin-provider.js` inside the
 * globally installed package, so every `npm install -g @getpaseo/cli@<new>`
 * overwrites it. Two different restart paths can follow that install:
 *
 *   1. systemd restarts the service -> `ExecStartPre` runs the patch script.
 *      Covered by `~/.config/systemd/user/paseo.service`.
 *   2. The app's own "upgrade server" button sends `daemon.update.request`.
 *      `daemon-self-updater` installs the new package and then emits a
 *      `paseo:restart` lifecycle intent; `supervisor.js` forks a new worker
 *      *inside the running process tree*. systemd never sees a restart, so
 *      `ExecStartPre` never runs and the patch silently disappears — which is
 *      exactly what happened on 2026-10-28 (upgrade 0.13.0 -> 0.13.2, patch
 *      count dropped to 0).
 *
 * This module closes path 2. It is injected through `NODE_OPTIONS=--require`
 * on the service, so it runs in the supervisor *and* in every forked worker
 * before any ESM module is evaluated. It runs the patch script synchronously
 * and then lets the process continue.
 *
 * FAILURE POLICY: soft.
 * A patch that cannot be applied must never keep the daemon from starting —
 * a missing rewind is degraded behaviour, a daemon that refuses to boot is an
 * outage. Failures are appended to `startup-patch-hook.log` next to this file
 * so a silent skip is still visible after the fact. This mirrors the
 * `10-rewind-patch-soft-fail.conf` drop-in that already makes the systemd
 * `ExecStartPre` non-blocking.
 *
 * RECURSION GUARD
 * ---------------
 * `NODE_OPTIONS` is inherited by every `node` child the daemon spawns (the
 * plugin process, terminal workers, the DSH bridge, git helpers). Running a
 * Node patch script from this hook would then load this hook again in that
 * child.
 *
 * The guard used to be an environment marker written into *this* process's
 * `process.env`, which every descendant inherited.  That stopped the recursion
 * but also stopped the one case the hook exists for: Paseo's supervisor forks
 * its worker from inside the same process tree, the worker inherited the marker,
 * and the hook returned immediately there.  Measured on the live install: the
 * daemon-run process had the marker unset while the supervisor, the daemon
 * worker and all eight node children had it set, and the hook log never once
 * contained a worker pid — i.e. the "App in-app upgrade" path the hook was
 * written for was not actually covered.
 *
 * The guard is now two independent things, neither of which leaks to unrelated
 * processes:
 *
 *   1. `running` — a module-level flag. Node caches modules per process, so a
 *      second `require` of this file inside one process is a genuine re-entry.
 *      It cannot affect any other process, because it is not an env var.
 *   2. The patch script is spawned with a `NODE_OPTIONS` that has *this* hook
 *      stripped out. That removes the only real recursion path (hook -> node
 *      patch script -> hook) at the source, instead of relying on a marker that
 *      also suppresses legitimate workers.
 *
 * `PASEO_DSH_PATCH_HOOK_ACTIVE=1` is still honoured as an explicit opt-out for
 * a caller that knows it must not patch (tests, one-off scripts), but the hook
 * never sets it itself.
 *
 * ENTRY ALLOWLIST — why the hook does NOT run in every node process
 * ----------------------------------------------------------------
 * `NODE_OPTIONS` is inherited by *every* node child the daemon spawns, so the
 * hook used to spawn a full apply on each one: the plugin process, terminal
 * workers, the DSH bridge, git helpers.  Two measured consequences:
 *
 *   1. A read-only query stopped being read-only.  `check-rewind-patch.mjs` and
 *      `apply … --check` are documented as "只读" and `UPGRADE.md` branches on
 *      their exit codes — but running either of them in a shell that inherited
 *      `NODE_OPTIONS` preloaded this hook, which patched the file first.  The
 *      checker then reported "patched / exit 0" on a file that had been clean
 *      one moment earlier.  Same command, same file: `env -u NODE_OPTIONS`
 *      said `NOT patched / exit 1`, the inherited environment said
 *      `patched / exit 0`.  Every upgrade-decision branch in `UPGRADE.md` rests
 *      on that answer.
 *   2. Cost.  Measured `node -e '0'`: 29 ms without the hook, 91/97/187 ms with
 *      it (+60…160 ms per node process), and the log grew to 1584 lines / 1082
 *      pids in two days with no rotation.
 *
 * So the hook now runs **only** where it is needed: the Paseo daemon process
 * chain.  `process.argv[1]` is already set when a preload runs, and it is the
 * absolute path of the entry module, which makes the allowlist exact:
 *
 *   - supervisor:  `…/@getpaseo/server/dist/scripts/supervisor-entrypoint.js`
 *                  (spawned by `paseo daemon run` via
 *                  `startDaemonInstance({ command: process.execPath, args: [entry] })`)
 *   - worker:      `…/@getpaseo/server/dist/server/server/daemon-worker.js`
 *                  (`supervisor.js` `fork(workerEntry, workerArgs)`), and the
 *                  packaged-Electron variant `dist/daemon/node-entrypoint-runner.js`
 *                  whose argv carries the same worker path.
 *
 * The worker case is the one the hook exists for: the app's "upgrade server"
 * button makes the supervisor fork a **new worker inside the running process
 * tree**, systemd never sees a restart, and `ExecStartPre` never runs.  A hook
 * that only matched the supervisor would miss exactly that path.
 *
 * Everything else returns immediately, before spawning anything.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve: pathResolve } = require("node:path");

const ACTIVE_ENV = "PASEO_DSH_PATCH_HOOK_ACTIVE";

// (1) Same-process re-entry. A plain variable: it dies with the process and
// cannot be inherited by anything.
let running = false;

// Explicit opt-out by the caller. Never set by this file.
if (process.env[ACTIVE_ENV] === "1") return;
if (running) return;
running = true;

const here = __dirname;
const patchScript = join(here, "apply-rewind-history-truncation.mjs");
const logPath = join(here, "startup-patch-hook.log");

/**
 * Remove `--require <thisFile>` (and `-r <thisFile>`) from a NODE_OPTIONS value.
 *
 * NODE_OPTIONS is a shell-like string; this only needs to handle the forms the
 * two drop-ins actually produce, so it is a tolerant token scan rather than a
 * full parser. Anything it does not recognise is preserved verbatim — dropping
 * an unrelated flag would change how the daemon's children run.
 *
 * @param {string | undefined} nodeOptions
 * @param {string} hookPath - absolute path of this file
 * @returns {string} the remaining options, trimmed; "" when nothing is left
 */
function stripHookFromNodeOptions(nodeOptions, hookPath) {
  if (typeof nodeOptions !== "string" || nodeOptions.trim() === "") return "";
  const tokens = nodeOptions.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [];
  const kept = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const bare = token.replace(/^["']|["']$/gu, "");
    if (bare === "--require" || bare === "-r") {
      const next = tokens[index + 1];
      const nextBare = next === undefined ? "" : next.replace(/^["']|["']$/gu, "");
      if (pathResolve(nextBare) === pathResolve(hookPath)) {
        index += 1; // drop the flag and its hook argument
        continue;
      }
      kept.push(token);
      continue;
    }
    // `--require=<path>` / `-r=<path>`: split on the first `=` and resolve the
    // value, so quotes, a relative path, a trailing slash or `..` all compare
    // equal to the hook's real path instead of failing a literal string compare.
    const eq = /^(?:--require|-r)=(.+)$/u.exec(bare);
    if (eq !== null && pathResolve(eq[1]) === pathResolve(hookPath)) continue;
    kept.push(token);
  }
  return kept.join(" ").trim();
}

/**
 * How many lines the hook log may reach before it is truncated.
 *
 * The log had no bound at all: 1584 lines / 1082 distinct pids in two days on
 * this machine, and it only grows.  Nothing prunes it, and it is written by a
 * preload that runs before any application code — so "grow forever" is not a
 * theoretical concern here.
 *
 * Truncation keeps the **newest** lines (they are the ones that explain the
 * current install) and rewrites the file in one go.  A failed rewrite is not
 * fatal: logging must never keep the daemon from starting.
 */
const LOG_MAX_LINES = 500;

function log(line) {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
    trimLog();
  } catch {
    // Logging must never be the reason a daemon fails to start.
  }
}

/**
 * Keep at most `LOG_MAX_LINES` lines, dropping the oldest.
 *
 * Reads the whole file only when it has plausibly grown past the limit, so the
 * steady-state cost stays a single `appendFileSync`.  The file is small (a few
 * hundred KB at most), and the rewrite is not atomic — a concurrent append from
 * another process during the rewrite can lose a line.  That is acceptable for a
 * diagnostic log; the alternative (locking) would put a lock in the daemon's
 * startup path for a log file.
 */
function trimLog() {
  let existing;
  try {
    existing = readFileSync(logPath, "utf8");
  } catch {
    return;
  }
  // Cheap pre-check: a line is at least ~30 bytes, so fewer bytes than
  // `LOG_MAX_LINES * 30` cannot be over the limit.
  if (existing.length < LOG_MAX_LINES * 30) return;
  const lines = existing.split("\n");
  // A trailing newline produces one empty element; keep it out of the count.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= LOG_MAX_LINES) return;
  const kept = lines.slice(lines.length - LOG_MAX_LINES);
  try {
    writeFileSync(logPath, `${kept.join("\n")}\n`);
  } catch {
    // Same rule as `log()`: never fatal.
  }
}

/**
 * The only entry modules the hook patches.
 *
 * Read from `@getpaseo/server@0.14.0-beta.2`, not guessed:
 *   - `dist/scripts/supervisor-entrypoint.js` — what `paseo daemon run` spawns
 *     (`commands/daemon/local-daemon.js` → `startDaemonInstance({command:
 *     process.execPath, args: [entry]})`);
 *   - `dist/server/server/daemon-worker.js` — what `supervisor.js` forks
 *     (`child = fork(workerEntry, workerArgs, …)`), i.e. the in-app-upgrade path;
 *   - `dist/daemon/node-entrypoint-runner.js` — the packaged-Electron variant,
 *     spawned as `node-entrypoint-runner.js node-script <worker>`, so its argv
 *     carries the worker path but argv[1] is the runner.
 *
 * @type {Set<string>}
 */
const DAEMON_ENTRY_BASENAMES = new Set([
  "supervisor-entrypoint.js",
  "daemon-worker.js",
  "node-entrypoint-runner.js",
]);

/**
 * Is this process one the hook must patch?
 *
 * `argv[1]` is the entry module's absolute path (verified on this machine for
 * both `spawn(execPath, [entry])` and `fork(entry, args)`): a `--require` preload
 * runs after Node has resolved the entry point.  `node -e` leaves it undefined,
 * which correctly reads as "not a daemon".
 *
 * Matching is by **basename**, not by full path: the install root differs
 * between a global npm prefix, a pnpm store and a packaged Electron app, and a
 * path prefix would silently stop matching after such a move — the hook would
 * then do nothing and the patch would quietly disappear on the next in-app
 * upgrade, which is the exact failure this file exists to prevent.  The three
 * basenames are specific enough (`daemon-worker.js` is not a name a random tool
 * ships).
 *
 * @param {string | undefined} entry - `process.argv[1]`
 * @returns {boolean}
 */
function isDaemonEntry(entry) {
  if (typeof entry !== "string" || entry === "") return false;
  const base = entry.replace(/\\/gu, "/").split("/").pop() ?? "";
  return DAEMON_ENTRY_BASENAMES.has(base);
}

if (!isDaemonEntry(process.argv[1])) {
  // Not the Paseo daemon chain: leave this process completely alone.  This is
  // what keeps `check-rewind-patch.mjs` / `--check` genuinely read-only, and
  // what keeps the hook off every unrelated node process the daemon spawns.
  return;
}

if (!existsSync(patchScript)) {
  log(`skipped: patch script not found at ${patchScript}`);
} else {
  // (2) Strip this hook out of the child's NODE_OPTIONS. That is the actual
  // recursion path — the patch script is a node program, and without this it
  // would load this very file again. Removing it here means the guard does not
  // have to be an inherited marker, so supervisor/worker processes are no longer
  // suppressed.
  const childNodeOptions = stripHookFromNodeOptions(process.env.NODE_OPTIONS, __filename);
  const env = { ...process.env };
  if (childNodeOptions === "") delete env.NODE_OPTIONS;
  else env.NODE_OPTIONS = childNodeOptions;
  // Belt and braces for the same-process case: the patch script never loads this
  // hook, but if some future edit reintroduces that, this marker stops it
  // re-entering. It is set on the *child's* env only, never on ours, so it cannot
  // leak into the daemon's worker tree.
  env[ACTIVE_ENV] = "1";
  const result = spawnSync(process.execPath, [patchScript], {
    env,
    encoding: "utf8",
    // The patch script finishes in well under a second; a hung child must not
    // hold the daemon's startup hostage.
    timeout: 30_000,
  });
  const code = result.status;
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (result.error !== undefined) {
    log(`failed to spawn patch script: ${result.error.message}`);
  } else if (code === 0) {
    // The script prints "already patched" / "applied" / "patched-on-new-upstream";
    // record the line so the log shows which path was taken on each start.
    log(`ok: ${stdout.split("\n").pop() ?? "(no output)"}`);
  } else if (code === 3) {
    // Exit 3 = DEGRADED, and it is deliberately distinct from a failure: the
    // patch is present and rewind still works, but its body is older than the
    // apply script and could not be rebuilt (the clean baseline backup is gone).
    // The known consequence is narrow — the SECOND rewind in a session fails
    // with "No provider revert token" — so saying "rewind will not reset" here
    // would be wrong, and saying nothing would be the silent degradation this
    // whole mechanism exists to avoid.
    log(
      `DEGRADED (exit 3) — rewind works, but the SECOND rewind in a session will fail. `
      + `Reinstall @getpaseo/cli, then restart. ${stdout.split("\n").pop() ?? ""}`,
    );
  } else {
    // Exit 2 = the script could not apply the patch safely (moved anchors,
    // half-patched file). Keep the daemon running and leave the reason here.
    log(`FAILED (exit ${code}) — rewind will not reset until this is fixed. ${stderr || stdout}`);
  }
}
