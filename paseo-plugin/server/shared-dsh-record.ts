/**
 * The shared `dsh` child outlives the plugin process that spawned it, briefly.
 *
 * Paseo's host stops a plugin process with a **2 s** soft budget and then SIGTERMs
 * it (`@getpaseo/server` `plugins/runtime.js`: `SOFT_SHUTDOWN_TIMEOUT_MS = 2000`,
 * `stopPlugin`), while this plugin's own teardown is bounded by
 * `SESSION_CLOSE_TIMEOUT_MS` (10 s, `dsh-process.ts`) + `RELEASE_TIMEOUT_MS`
 * (5 s, `provider.ts`). A reload can therefore land while the old plugin process
 * is still inside `close()`, killed before its `#shutdownPool()` ever reached the
 * shared child. The child is then orphaned — DSH's `exitOnStdinEnd` makes it exit
 * on the closed stdin pipe, but only after the running agents are disposed, and
 * DSH's profile-level `webserver` keeps the profile's **fixed** listener port
 * bound for that whole window.
 *
 * A successor spawned into that window dies at profile boot with
 * `listen EADDRINUSE … webserver (required)`, which the user sees as "the first
 * session open after a reload fails, and works seconds later".
 *
 * The pool's in-process accounting cannot see this: the orphan's owner is a
 * different OS process. So the owner records the child in `$DSH_HOME/paseo/`
 * (not `/tmp`: it must survive the plugin process and be per-DSH-home), and a
 * spawn first waits — **bounded** — for that recorded child to exit.
 *
 * Three rules keep the record from becoming a lock or a lie:
 *
 * 1. **A record is only trusted when it provably names a live `dsh` of this
 *    profile.** `pid` alone is not identity: pids are reused. The record carries
 *    the process's own start identity (Linux `/proc/<pid>/stat` field 22, macOS
 *    `ps -o lstart=`) and its command line, and a pid whose identity disagrees is
 *    a reused pid, not our child.
 * 2. **Timing out is a loud failure, never a silent kill.** The wait never
 *    signals a process it does not own: the recorded pid may belong to another
 *    user's or another home's daemon. The caller turns the result into an error
 *    naming the pid, and the user decides.
 * 3. **Clearing is pid-guarded.** A successor that spawned its own child owns the
 *    same path, so an old owner waking up must not delete the successor's record.
 *
 * @module dsh-paso/server/shared-dsh-record
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Subdirectory of `$DSH_HOME` this plugin owns (`bootstrap.ts` writes the profile elsewhere). */
const STATE_DIR = "paseo";

/** File-name stem of the record, under {@link STATE_DIR}; the profile name is appended. */
const RECORD_FILE_STEM = "shared-dsh";

/** Format version of the record; a record of another version is read as unknown. */
const RECORD_VERSION = 1;

/**
 * How long a spawn waits for the previous plugin process's shared child to exit.
 *
 * Bounded on purpose: a successor must not hang forever behind a wedged child.
 * 10 s covers DSH's own bounded teardown by a wide margin (measured: an idle
 * child is gone ~230 ms after SIGTERM/EOF; a child with live agents is bound by
 * the same 10 s `SESSION_CLOSE_TIMEOUT_MS` the plugin uses per session) while
 * still being finite. Override with `DSH_PASEO_SHARED_DSH_WAIT_MS`; a value that
 * is not a positive integer is ignored (a bad override must not disable the
 * wait by accident).
 */
export const SHARED_DSH_WAIT_MS = 10_000;

/** Poll interval while waiting; short enough that a fast exit costs no visible time. */
const WAIT_POLL_MS = 100;

/**
 * How long a **verified orphan** gets to exit on its own before it is signalled.
 *
 * The common reload case is a child finishing its in-flight turns after stdin EOF
 * (measured 2.29 s), so most reloads never reach the signal path at all: wait a
 * little, then get out of the way. Signalling earlier would turn a clean
 * shutdown into a kill in the user's daemon log.
 */
export const RECLAIM_SELF_EXIT_MS = 3_000;

/**
 * How long SIGTERM gets before SIGKILL.
 *
 * SIGTERM is DSH's own exit path (`exitOnStdinEnd` → `disposeAndExit(0)`): the
 * sessions flush their logs on the way out, which is what keeps the reclaimed
 * conversation readable afterwards. Killing harder first would leave the
 * successor with logs whose write lease was never released.
 */
export const RECLAIM_TERM_WAIT_MS = 2_000;

/** How long SIGKILL gets to be reaped; only a process stuck in the kernel survives it. */
export const RECLAIM_KILL_WAIT_MS = 3_000;

/**
 * What one probe of a pid observed.
 *
 * `alive` is the existence answer; `identity` and `commandLine` are best-effort
 * (a permission failure on `/proc/<pid>/cmdline` must not read as "process
 * gone"). `identity` is opaque to callers and only ever compared for equality.
 */
export interface ProcessObservation {
  alive: boolean;
  identity?: string;
  commandLine?: readonly string[];
}

/** How the module looks at another pid; injectable so a check can fake pid reuse. */
export interface ProcessProbe {
  inspect(pid: number): ProcessObservation;
}

/** The on-disk record of the shared child one plugin process spawned. */
export interface SharedDshRecord {
  version: number;
  pid: number;
  /** The child's start identity at spawn time (see {@link ProcessObservation.identity}). */
  identity: string;
  /** The command line's first element, as spawned (used to recognise the process). */
  command: string;
  /** `$DSH_HOME` the child was spawned against. */
  home: string;
  /** DSH profile name the child serves (`--profile <name>`). */
  profile: string;
  /** Pid of the plugin process that spawned it (diagnostics only, never trusted). */
  ownerPid: number;
}

/**
 * Make a profile name safe as one path segment.
 *
 * Profile names are directory names under `profiles/`, so they are already
 * filesystem-friendly, but the record file is created by this plugin and must not
 * be steerable into another directory by a name like `../../x`. Anything outside
 * `[A-Za-z0-9._-]` becomes `_`; a name that sanitizes to nothing (or to `.`/`..`)
 * becomes `default`.
 *
 * @param profile - the DSH profile name.
 */
export function recordFileProfile(profile: string): string {
  const cleaned = profile.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\..*/, "_").slice(0, 64);
  return cleaned === "" || cleaned === "_" ? "default" : cleaned;
}

/**
 * Absolute path of the record file for one DSH home **and profile**.
 *
 * The profile belongs in the file name: two profiles under one `$DSH_HOME` are two
 * independent DSH runtimes (their own bundles, sessions and listener ports), so a
 * record written for one is not a claim the other may wait on or reclaim —
 * `reclaimPreviousSharedDsh` treats a record whose profile does not match as
 * foreign (no wait, no signal).
 *
 * `home` must already be resolved the way `bootstrap.dshHome()` resolves it; the
 * two must agree or two plugin processes would wait on different files and the
 * race would come back.
 *
 * @param home - absolute `$DSH_HOME`.
 * @param profile - the DSH profile this record is about.
 */
export function sharedDshRecordPath(home: string, profile: string): string {
  return join(home, STATE_DIR, `${RECORD_FILE_STEM}.${recordFileProfile(profile)}.json`);
}

/** The wait bound in force, honouring a valid `DSH_PASEO_SHARED_DSH_WAIT_MS` override. */
export function sharedDshWaitMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env["DSH_PASEO_SHARED_DSH_WAIT_MS"];
  if (raw === undefined || raw.trim() === "") return SHARED_DSH_WAIT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : SHARED_DSH_WAIT_MS;
}

/**
 * Read one record, tolerating every kind of damage.
 *
 * A missing file, a partial write, another format version or a record missing a
 * field all answer `undefined` — "no claim", which is the state a spawn proceeds
 * from. Refusing to spawn because a diagnostics file is corrupt would turn a
 * harmless leftover into a permanent startup failure.
 *
 * @param path - record path from {@link sharedDshRecordPath}.
 */
export function readSharedDshRecord(path: string): SharedDshRecord | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Partial<SharedDshRecord>;
  if (record.version !== RECORD_VERSION) return undefined;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return undefined;
  if (typeof record.identity !== "string" || record.identity === "") return undefined;
  if (typeof record.command !== "string") return undefined;
  if (typeof record.home !== "string" || typeof record.profile !== "string") return undefined;
  return {
    version: RECORD_VERSION,
    pid: record.pid,
    identity: record.identity,
    command: record.command,
    home: record.home,
    profile: record.profile,
    ownerPid: typeof record.ownerPid === "number" ? record.ownerPid : 0,
  };
}

/**
 * Write the record atomically (temp file + rename in the same directory).
 *
 * Synchronous by contract: this runs from `DshProcess`'s spawn callback, in the
 * same tick as the `spawn()` that produced the pid. A record written after
 * `start()` resolved would leave exactly the window this module exists to close
 * — the child is listening, the record does not say so yet.
 *
 * The format version is stamped here, so callers cannot write a record of a
 * version this module would refuse to read back.
 *
 * @param path - record path.
 * @param record - the child to record (without the format version).
 * @returns whether the file could be written; a failure is reported, never thrown,
 *   because losing the record must not fail the open that is already succeeding.
 */
export function writeSharedDshRecord(
  path: string,
  record: Omit<SharedDshRecord, "version">,
): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* reported through the return value below */
  }
  const temp = `${path}.${String(process.pid)}.tmp`;
  try {
    const stamped: SharedDshRecord = { version: RECORD_VERSION, ...record };
    writeFileSync(temp, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
    renameSync(temp, path);
    return true;
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}

/**
 * Remove the record **only if it still names `pid`**.
 *
 * The pid guard is the whole point: two plugin processes share one path, and an
 * old owner that finally reaped its child must not delete the record of the
 * child the new owner is serving.
 *
 * @param path - record path.
 * @param pid - the pid whose record may be removed.
 * @returns whether a record was removed.
 */
export function clearSharedDshRecord(path: string, pid: number): boolean {
  const record = readSharedDshRecord(path);
  if (record === undefined || record.pid !== pid) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** `execFileSync` that answers `undefined` instead of throwing. */
function runQuietly(command: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

/**
 * Linux `/proc` inspection.
 *
 * `stat`'s 22nd field is `starttime` in clock ticks since boot: stable for the
 * life of the process, different for a reused pid, and readable without any
 * extra dependency (`/proc/<pid>/stat` is world-readable).
 */
function observeLinux(pid: number): ProcessObservation | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  } catch (error) {
    // ENOENT is "not running"; EPERM (another user's pid) means it *is* running
    // but we cannot identify it — which must not read as "gone".
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { alive: false };
    return { alive: true };
  }
  // The comm field is parenthesised and may contain spaces: split after the last ')'.
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  const starttime = fields[19];
  let commandLine: string[] | undefined;
  try {
    commandLine = readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").split("\0").filter((part) => part !== "");
  } catch {
    commandLine = undefined;
  }
  return {
    alive: true,
    ...(starttime === undefined ? {} : { identity: `linux:${starttime}` }),
    ...(commandLine === undefined ? {} : { commandLine }),
  };
}

/** POSIX `ps` inspection, used where `/proc` does not exist (macOS, BSDs). */
function observePs(pid: number): ProcessObservation {
  const text = runQuietly("ps", ["-p", String(pid), "-o", "lstart=,command="]);
  if (text === undefined || text.trim() === "") return { alive: false };
  const trimmed = text.trim();
  // `lstart` is always five space-separated fields: "Thu Nov 13 10:41:02 2025".
  const parts = trimmed.split(/\s+/);
  if (parts.length < 6) return { alive: true, commandLine: trimmed.split(" ") };
  const identity = `ps:${parts.slice(0, 5).join(" ")}`;
  return { alive: true, identity, commandLine: trimmed.split(/\s+/).slice(5) };
}

/** True when `pid` exists (signal 0), including when we may not signal it. */
function existsBySignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The real probe: `/proc` first, `ps` second, `kill(pid, 0)` as the existence
 * fallback when neither can identify the process.
 */
export function systemProcessProbe(): ProcessProbe {
  return {
    inspect(pid: number): ProcessObservation {
      const observed = process.platform === "linux" ? observeLinux(pid) : observePs(pid);
      if (observed !== undefined) return observed;
      return { alive: existsBySignal(pid) };
    },
  };
}

/**
 * Does the observed process look like the `dsh` this record names?
 *
 * Two independent facts have to agree:
 *
 * 1. the start identity (the authoritative pid-reuse check — pids are recycled,
 *    start times are not), and
 * 2. when the command line is readable, that it is a `--profile <record.profile>`
 *    invocation.
 *
 * The executable's *name* is deliberately not compared: the real `dsh` is a
 * shebang script, so the kernel reports `node /path/to/dsh …` (and a test
 * harness reports `bash wrapper.sh …`). Comparing the first argv element would
 * read every real child as foreign and turn the wait off exactly where it is
 * needed. The profile flag is what distinguishes "our profile's dsh" from an
 * unrelated process, and the identity distinguishes a reused pid from our child.
 * An unreadable command line (permission) is not evidence against: the identity
 * already pinned the process.
 */
export type RecordedChildMatch = "match" | "mismatch" | "unknown";

/**
 * Does the observed process look like the `dsh` this record names?
 *
 * Three answers, not two: **`unknown` is a real outcome.** When neither the start
 * identity nor the command line can be read (another user's proc on Linux, a
 * platform without `/proc`, a `ps` that failed), there is no evidence either way —
 * and the difference between "not ours" and "cannot tell" decides whether the
 * successor may signal the pid. Treating `unknown` as `match` would let this
 * module kill a process it cannot identify; treating it as `mismatch` would make a
 * live child's record look dead and let a second `dsh` spawn beside it. So the
 * callers: wait on `unknown`, never signal it, and report it as unverified.
 */
export function classifyRecordedChild(
  record: SharedDshRecord,
  observed: ProcessObservation,
): RecordedChildMatch {
  const identityKnown = observed.identity !== undefined;
  const identityMatches = identityKnown && observed.identity === record.identity;
  const commandLine = observed.commandLine;
  const commandKnown = commandLine !== undefined && commandLine.length > 0;
  let profileMatches: boolean | undefined;
  if (commandKnown) {
    const profileIndex = commandLine.indexOf("--profile");
    profileMatches = profileIndex !== -1 && commandLine[profileIndex + 1] === record.profile;
  }
  // Any known field that disagrees is proof this is not our child.
  if (identityKnown && !identityMatches) return "mismatch";
  if (profileMatches === false) return "mismatch";
  if (identityMatches || profileMatches === true) return "match";
  return "unknown";
}

/** Sleep helper kept out of the wait loop so a check can drive it directly. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a spawn does about the previous plugin process's child. */
export type ReclaimResult =
  | { state: "absent" }
  | { state: "gone"; pid: number }
  | { state: "reused"; pid: number; reason: string }
  /** The record names a child of **another** profile: not ours to wait for or signal. */
  | { state: "foreign"; pid: number; profile: string }
  /** It exited without being signalled (the common reload case). */
  | { state: "waited"; pid: number; waitedMs: number }
  /** SIGTERM did it: DSH's own exit path, so the session logs were flushed. */
  | { state: "terminated"; pid: number; waitedMs: number }
  /** SIGKILL did it; DSH did not flush the logs on the way out. */
  | { state: "killed"; pid: number; waitedMs: number }
  /** Still alive at the end. `ownerAlive`/`verified` say why nothing was signalled. */
  | { state: "timed-out"; pid: number; waitedMs: number; ownerAlive: boolean; verified: boolean };

/**
 * Take back a verified orphan: wait for it, then SIGTERM, then SIGKILL.
 *
 * This is what keeps a reload from costing the user a ten-second stall. The old
 * plugin process is stopped on a 2 s host budget (see the module header), so its
 * child is usually already on its way out when the successor starts: the first
 * window ({@link RECLAIM_SELF_EXIT_MS}) catches that case and the open proceeds
 * without ever signalling anything. Only a child that outlives it is signalled,
 * in the order that lets DSH flush its session logs:
 *
 *   1. wait {@link RECLAIM_SELF_EXIT_MS} for a self exit;
 *   2. SIGTERM — DSH's `exitOnStdinEnd`/`disposeAndExit` path, which is what
 *      releases the session logs' write leases cleanly; wait {@link RECLAIM_TERM_WAIT_MS};
 *   3. SIGKILL; wait {@link RECLAIM_KILL_WAIT_MS};
 *   4. still there → `timed-out`, and the caller fails loudly with the pid.
 *
 * **Only a verified orphan is signalled.** Verified means all of: the record
 * names a live pid whose start identity matches, whose command line is this
 * profile's `--profile` invocation, whose `home`/`profile` are the ones being
 * opened, and whose **owner plugin process is gone**. A record whose owner is
 * still alive belongs to another live connection of this process (or to this
 * process's own retiring child): that child is the pool's to close, not the
 * successor's to kill, so it is only waited for — and the same holds when the
 * identity cannot be confirmed at all. Signalling a pid that is not provably ours
 * is the one thing this module never does.
 *
 * Every step writes one log line naming the pid and the level it reached, so a
 * reload that had to signal the old child is visible in the daemon log instead of
 * looking like a slow start.
 *
 * @param options.path - record path.
 * @param options.home - the `$DSH_HOME` this spawn is for (must equal the record's).
 * @param options.profile - the profile this spawn is for (must equal the record's).
 * @param options.probe - process probe (injected by the checks).
 * @param options.waitMs - bound for the wait-only paths (owner alive / unverified).
 * @param options.selfPid - this plugin process; a record it owns is never signalled.
 * @param options.signal - signal sender (injected by the checks).
 * @param options.sleep - sleep function (injected by the checks).
 * @param options.log - one stderr line per step.
 */
export async function reclaimPreviousSharedDsh(options: {
  path: string;
  home: string;
  profile: string;
  probe: ProcessProbe;
  waitMs: number;
  selfPid?: number;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<ReclaimResult> {
  const { path, home, profile, probe, waitMs } = options;
  const pause = options.sleep ?? sleep;
  const log = options.log ?? ((line: string): void => { process.stderr.write(`${line}\n`); });
  const send = options.signal ?? ((pid: number, signal: NodeJS.Signals): void => {
    process.kill(pid, signal);
  });
  const selfPid = options.selfPid ?? process.pid;

  const initial = readSharedDshRecord(path);
  if (initial === undefined) return { state: "absent" };
  // A record is about one profile. Another profile's child is a different DSH
  // runtime (own bundles, own sessions, own port): not a claim on this spawn.
  if (initial.profile !== profile) {
    return { state: "foreign", pid: initial.pid, profile: initial.profile };
  }
  const first = probe.inspect(initial.pid);
  if (!first.alive) return { state: "gone", pid: initial.pid };
  const firstMatch = classifyRecordedChild(initial, first);
  if (firstMatch === "mismatch") {
    clearSharedDshRecord(path, initial.pid);
    return { state: "reused", pid: initial.pid, reason: describeMismatch(initial, first) };
  }

  // "unknown" cannot be confirmed as ours, so it is never signalled (only waited
  // for) — see {@link classifyRecordedChild}.
  const ownerPid = initial.ownerPid;
  // A record written by this very process describes a child this process owns: the
  // pool closes it (and has already waited for it), so it is never signalled here —
  // that is the "same plugin process, retiring child" case. An owner pid that is
  // still running is the same story one process over.
  const ownerAlive = ownerPid === selfPid || (ownerPid > 0 && probe.inspect(ownerPid).alive);
  const verified = !ownerAlive && initial.home === home && firstMatch === "match";

  /** Wait up to `ms` for the recorded child to be gone; `true` when it is. */
  const waitGone = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    for (;;) {
      const record = readSharedDshRecord(path);
      // Cleared, or a successor owns the path now: either way this pid is not ours
      // to wait for any more.
      if (record === undefined || record.pid !== initial.pid) return true;
      const observed = probe.inspect(initial.pid);
      if (!observed.alive) {
        clearSharedDshRecord(path, initial.pid);
        return true;
      }
      if (classifyRecordedChild(record, observed) === "mismatch") {
        // The pid now belongs to something else: the child is gone and the record
        // is stale. `unknown` keeps the wait going instead — an unreadable identity
        // is not evidence that the child exited.
        clearSharedDshRecord(path, initial.pid);
        return true;
      }
      if (Date.now() >= until) return false;
      await pause(WAIT_POLL_MS);
    }
  };

  const startedAt = Date.now();
  if (!verified) {
    // Owner alive (a sibling connection's child, or this process's own retiring
    // child) or the record is not provably ours: wait, never signal.
    if (await waitGone(waitMs)) return { state: "waited", pid: initial.pid, waitedMs: Date.now() - startedAt };
    return {
      state: "timed-out",
      pid: initial.pid,
      waitedMs: Date.now() - startedAt,
      ownerAlive,
      verified: false,
    };
  }

  if (await waitGone(RECLAIM_SELF_EXIT_MS)) {
    return { state: "waited", pid: initial.pid, waitedMs: Date.now() - startedAt };
  }

  // Re-verified immediately before each signal: the pid may have exited and been
  // reused while the wait ran, and a reused pid is not ours to signal.
  const beforeTerm = probe.inspect(initial.pid);
  if (!beforeTerm.alive) {
    clearSharedDshRecord(path, initial.pid);
    return { state: "waited", pid: initial.pid, waitedMs: Date.now() - startedAt };
  }
  const beforeTermMatch = classifyRecordedChild(initial, beforeTerm);
  if (beforeTermMatch === "mismatch") {
    clearSharedDshRecord(path, initial.pid);
    return { state: "reused", pid: initial.pid, reason: describeMismatch(initial, beforeTerm) };
  }
  if (beforeTermMatch === "unknown") {
    // No evidence either way about the process the pid now names: report it as
    // unverified instead of signalling it (the caller fails loudly with the pid).
    return {
      state: "timed-out",
      pid: initial.pid,
      waitedMs: Date.now() - startedAt,
      ownerAlive: false,
      verified: false,
    };
  }
  log(
    `[dsh-paseo] the previous plugin process is gone (owner pid ${String(ownerPid)}); its shared dsh `
      + `(pid ${String(initial.pid)}) is still running after ${String(Date.now() - startedAt)} ms — `
      + "sending SIGTERM so DSH can flush its session logs",
  );
  send(initial.pid, "SIGTERM");
  const termAt = Date.now();
  if (await waitGone(RECLAIM_TERM_WAIT_MS)) {
    log(
      `[dsh-paseo] the shared dsh (pid ${String(initial.pid)}) exited ${String(Date.now() - termAt)} ms after SIGTERM`
        + " — its own shutdown path ran, so the new child can take the port",
    );
    return { state: "terminated", pid: initial.pid, waitedMs: Date.now() - startedAt };
  }
  const beforeKill = probe.inspect(initial.pid);
  if (!beforeKill.alive) {
    clearSharedDshRecord(path, initial.pid);
    return { state: "terminated", pid: initial.pid, waitedMs: Date.now() - startedAt };
  }
  const beforeKillMatch = classifyRecordedChild(initial, beforeKill);
  if (beforeKillMatch === "mismatch") {
    clearSharedDshRecord(path, initial.pid);
    return { state: "reused", pid: initial.pid, reason: describeMismatch(initial, beforeKill) };
  }
  if (beforeKillMatch === "unknown") {
    // No evidence either way about the process the pid now names: report it as
    // unverified instead of signalling it (the caller fails loudly with the pid).
    return {
      state: "timed-out",
      pid: initial.pid,
      waitedMs: Date.now() - startedAt,
      ownerAlive: false,
      verified: false,
    };
  }
  log(
    `[dsh-paseo] the shared dsh (pid ${String(initial.pid)}) ignored SIGTERM for `
      + `${String(Date.now() - termAt)} ms — sending SIGKILL (its session logs may need a replay)`,
  );
  send(initial.pid, "SIGKILL");
  const killAt = Date.now();
  if (await waitGone(RECLAIM_KILL_WAIT_MS)) {
    log(
      `[dsh-paseo] the shared dsh (pid ${String(initial.pid)}) exited ${String(Date.now() - killAt)} ms after SIGKILL`,
    );
    return { state: "killed", pid: initial.pid, waitedMs: Date.now() - startedAt };
  }
  return { state: "timed-out", pid: initial.pid, waitedMs: Date.now() - startedAt, ownerAlive: false, verified: true };
}


/** One sentence naming why a live pid is not the recorded child (for the log). */
function describeMismatch(record: SharedDshRecord, observed: ProcessObservation): string {
  if (observed.identity !== undefined && observed.identity !== record.identity) {
    return `the pid now has start identity ${observed.identity} (recorded ${record.identity})`;
  }
  const commandLine = observed.commandLine;
  if (commandLine !== undefined) return `the pid now runs ${commandLine.join(" ").slice(0, 160)}`;
  return "the pid no longer matches the recorded command line";
}

/**
 * The message a spawn fails with when the previous child would not go away.
 *
 * Loud by contract: it names the pid, the profile, how long it waited, and what
 * the user can do about it. It also says what this plugin did **not** do, because
 * that is the surprising part: a child whose owner is still alive (another live
 * or still-retiring connection of this process) is never signalled by the
 * successor, and neither is a pid whose identity could not be confirmed.
 *
 * @param options - the record, the wait outcome, and why nothing was signalled.
 */
export function sharedDshStillRunningMessage(options: {
  record: SharedDshRecord;
  waitedMs: number;
  ownerAlive?: boolean;
  verified?: boolean;
}): string {
  const { record, waitedMs, ownerAlive = false, verified = true } = options;
  const why = ownerAlive
    ? `it is still owned by a running plugin process (pid ${String(record.ownerPid)}), so this open did not signal it`
    : verified
      ? "it did not exit on its own, and SIGTERM then SIGKILL did not reclaim it"
      : "its record could not be confirmed as this DSH home's child, so this open only waited";
  return (
    `the shared dsh from the previous plugin process is still running and holds the `
    + `"${record.profile}" profile's listener port (pid ${String(record.pid)}, started ${record.identity}); `
    + `waited ${String(waitedMs)} ms for it to exit before spawning another one, and ${why}. `
    + `Refusing to start a second dsh beside it: two DSH processes on one profile race each other `
    + `for the session logs and the fixed web port. Wait for that process to finish (or stop it with `
    + `\`kill ${String(record.pid)}\` after checking it is this DSH home's) and reopen the session.`
  );
}
