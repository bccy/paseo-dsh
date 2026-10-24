/**
 * Offline check for the parked-process pool (`server/parked-sessions.ts`).
 *
 * The pool exists so a rewind's agent reload reuses the running `dsh` child
 * instead of spawning a new one. That trade has exactly four failure modes worth
 * pinning, because each one is invisible until the refresh path misbehaves:
 *
 * - a parked process must be silenced (stray frames from the closed session must
 *   not reach a session that is gone);
 * - it is only reused for the same cwd + route, otherwise a reload with a new
 *   configuration would silently serve the old one;
 * - a crashed/expired/over-cap entry must be killed, not handed out or leaked;
 * - a miss must be a miss (cold start), never a throw.
 *
 * The check drives the compiled module with a fake process, so it does not need
 * a DSH profile. Compile the plugin first (same steps as plugin-check.cjs):
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cd .dbg && node ../harness/parked-sessions-check.cjs
 *
 * Usage: node harness/parked-sessions-check.cjs [compiled-plugin-dir]
 */
const path = require("node:path");
const fs = require("node:fs");

const dir = process.argv[2] ?? path.join(__dirname, "..", "paseo-plugin", ".dbg");
const compiled = path.resolve(dir, "parked-sessions.js");
const modulePath = fs.existsSync(compiled) ? compiled : path.resolve(dir, "server", "parked-sessions.js");
if (!fs.existsSync(modulePath)) {
  console.error(`compiled plugin not found at ${modulePath}\nSee the header of this file for compile steps.`);
  process.exit(2);
}
const { ParkedSessions } = require(modulePath);

async function main() {

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

let now = 1_000;
const logs = [];
const makePool = (options = {}) => new ParkedSessions({
  ttlMs: options.ttlMs ?? 30_000,
  max: options.max ?? 3,
  now: () => now,
  log: (line) => logs.push(line),
});

function fakeProcess(name) {
  return {
    name,
    running: true,
    killed: false,
    handlers: undefined,
    setHandlers(handlers) {
      this.handlers = handlers;
    },
    kill() {
      this.killed = true;
      this.running = false;
    },
    async waitForExit() {
      this.running = false;
      return true;
    },
  };
}

const entry = (process, overrides = {}) => ({
  process,
  sessionId: "provider-1",
  dshSessionId: "dsh-1",
  cwd: "/work",
  routeKey: "p/m/max",
  ...overrides,
});

console.log("park and take");
{
  const pool = makePool();
  const child = fakeProcess("a");
  check("park accepts a live process", pool.park(entry(child)) === true);
  check("size grows", pool.size === 1);
  check("the parked process is silenced", typeof child.handlers?.onEvent === "function" && child.handlers.onEvent({}) === undefined);
  check("its questions answer an empty batch", JSON.stringify(await child.handlers.onQuestion()) === JSON.stringify({ answers: [] }));
  const taken = pool.take("dsh-1", { cwd: "/work", routeKey: "p/m/max" });
  check("take returns the process", taken?.process === child);
  check("and empties the slot", pool.size === 0 && pool.has("dsh-1") === false);
  check("a second take misses", pool.take("dsh-1", { cwd: "/work", routeKey: "p/m/max" }) === undefined);
}

console.log("a different cwd or route still reuses the one process");
{
  // This used to be "configuration mismatch kills instead of reusing", and that
  // was correct while a process carried one session's cwd and route at boot.
  // Under one-process-multi-session the process is shared by sessions in
  // different projects on different routes: DSH keeps cwd and route **per
  // session** (`dsh-working-directory`, and the route is pinned per session by
  // `DshProcess.attachSession`), so reusing the child across a mismatch is the
  // whole point — pooling by cwd would spawn one child per project, which is the
  // cost this change exists to remove.
  //
  // So the assertion is inverted on purpose, and the thing that must stay true
  // is that the child is handed over **alive** (killing it here would disconnect
  // every other session on it) and that the divergence is still *reported* — a
  // silent mismatch would hide a session that opened in the wrong project.
  const pool = makePool();
  const child = fakeProcess("b");
  pool.park(entry(child));
  const taken = pool.take("dsh-1", { cwd: "/other", routeKey: "p/m/max" });
  check("a different cwd still reuses the process", taken?.process === child, String(taken === undefined));
  check("and does not kill it", child.killed === false && child.running === true);
  check(
    "but the divergence is logged, not silent",
    logs.some((line) => line.includes("parked:take") && line.includes("/other")),
    logs.filter((line) => line.includes("parked:take")).join(" | ") || "(no parked:take line)",
  );

  const routeChild = fakeProcess("c");
  pool.park(entry(routeChild));
  const routeTaken = pool.take("dsh-1", { cwd: "/work", routeKey: "p/m/high" });
  check("a different route still reuses the process too", routeTaken?.process === routeChild, String(routeTaken === undefined));
  check("and does not kill that one either", routeChild.killed === false && routeChild.running === true);
}

console.log("a dead process is not parked or handed out");
{
  const pool = makePool();
  const dead = fakeProcess("d");
  dead.running = false;
  check("park refuses a dead process", pool.park(entry(dead)) === false);
  check("nothing was stored", pool.size === 0);
  const dying = fakeProcess("e");
  pool.park(entry(dying));
  dying.running = false;
  check("a process that died while parked is not taken", pool.take("dsh-1", { cwd: "/work", routeKey: "p/m/max" }) === undefined);
  check("and the slot is gone", pool.size === 0);
}

console.log("TTL and cap bound the pool");
{
  const pool = makePool({ ttlMs: 100 });
  const child = fakeProcess("f");
  pool.park(entry(child));
  now += 50;
  check("a fresh entry survives a sweep", pool.sweep() === 0 && pool.size === 1);
  now += 51;
  check("an expired entry is swept", pool.sweep() === 1 && pool.size === 0);
  check("and its process is killed", child.killed === true);

  // The cap used to bound a map of many parked children, one per DSH session.
  // With a single pool key there is at most one entry, so the cap can never be
  // exceeded and eviction is unreachable *by construction* — parking a second
  // process replaces the first (see the re-park case below), it does not grow the
  // pool. The invariant worth pinning is therefore "the pool never holds more
  // than one", asserted over a sequence of parks for different sessions rather
  // than through a cap that no longer has anything to bound.
  const single = makePool({ max: 2 });
  const processes = ["g", "h", "i"].map((name) => fakeProcess(name));
  for (const [index, process] of processes.entries()) {
    single.park(entry(process, { dshSessionId: `d${String(index)}` }));
    now += 1;
    check(`parking session d${String(index)} keeps the pool at one entry`, single.size === 1, `size ${String(single.size)}`);
  }
  check(
    "each park replaced the previous process instead of accumulating",
    processes[0].killed === true && processes[1].killed === true && processes[2].killed === false,
    `killed ${processes.map((process) => String(process.killed)).join(",")}`,
  );
  check(
    "replacing a parked process is logged",
    logs.some((line) => line.includes("parked:replace")),
    logs.filter((line) => line.includes("parked:")).slice(-4).join(" | "),
  );
}

console.log("a refused park fails loudly, never silently");
{
  // `park()` installs silent handlers on the child so a parked process cannot
  // spray frames at a closed session. If that install throws, the pool must not
  // pretend it parked: an earlier version swallowed the error into a log line and
  // returned success, which meant the child kept its live handlers while the
  // caller believed it was parked — and it surfaced only as "the reopen behaved
  // like a cold start" much later.
  //
  // Three things have to hold together, and the assertion requires all three:
  // the caller is told (`false`), the reason is observable (a `parked:handlers`
  // line naming the session), and the child is not leaked (killed + tracked as
  // dying so the next open waits for the log lock).
  const pool = makePool();
  const broken = fakeProcess("p");
  broken.setHandlers = () => {
    throw new Error("handlers refused");
  };
  const parked = pool.park(entry(broken));
  check("a park whose handler install throws is refused", parked === false);
  check(
    "and the refusal is observable in the log, naming the session",
    logs.some((line) => line.includes("parked:handlers dsh-1") && line.includes("handlers refused")),
    logs.filter((line) => line.includes("parked:handlers")).join(" | ") || "(no parked:handlers line)",
  );
  check(
    "and the child is killed rather than leaked",
    broken.killed === true && broken.running === false,
    `killed ${String(broken.killed)}, running ${String(broken.running)}`,
  );
  check("and nothing was stored in the pool", pool.size === 0 && pool.has("dsh-1") === false, `size ${String(pool.size)}`);
}

console.log("re-parking the same native session replaces the old child");
{
  const pool = makePool();
  const first = fakeProcess("j");
  const second = fakeProcess("k");
  pool.park(entry(first));
  pool.park(entry(second));
  check("the old process is killed", first.killed === true);
  check("the new one is kept", pool.size === 1 && pool.take("dsh-1", { cwd: "/work", routeKey: "p/m/max" })?.process === second);
}

console.log("forget on a parked process exit");
{
  const pool = makePool();
  const child = fakeProcess("l");
  pool.park(entry(child));
  child.handlers.onExit(1, null);
  check("an exited parked process is forgotten", pool.size === 0);
}

console.log("discard (archive routing)");
{
  const pool = makePool();
  const child = fakeProcess("o");
  pool.park(entry(child));
  // A parked process that did not carry an archive change must not serve the next
  // open: its in-memory archive set is stale and the gate would end every turn as
  // `blocked`. It must not be made the writer either — DSH serializes the whole
  // set, so a snapshot from its own start would drop another session's change.
  check("discard drops the entry", pool.discard("dsh-1", "unarchive was carried by another process") === true);
  check("and kills the process", child.killed === true && pool.size === 0 && pool.has("dsh-1") === false);
  check("discard on an unknown id is a miss, not an error", pool.discard("dsh-1", "again") === false);
  check("discard is logged with its reason", logs.some((line) => line.includes("parked:discard dsh-1") && line.includes("another process")));
  // The killed owner still holds the session log's write lock for a moment, so
  // the next open has to be able to wait for it (otherwise the cold start fails
  // with "already owned by an active write handle").
  check("quiesce waits for the discarded owner", (await pool.quiesce("dsh-1", { cwd: "/work", routeKey: "p/m/max" })) === true);

  // `quiesce` must not be a kill in disguise.
  //
  // The one-process rewrite turns the pool into a guard rather than an owner: a
  // shared child serves several sessions, so a `quiesce` that killed it would
  // disconnect every other session on that process. The two shapes are
  // deliberately distinguished here, because the assertion above passes either
  // way — it only claims the call resolves `true` after a discard:
  //
  //   - on a **reusable** entry (same cwd/route, still running) quiesce must
  //     leave the process alive, whatever else it does;
  //   - on an entry it *cannot* reuse, killing it is legal (nobody else holds
  //     it), which is why this case is not asserted as "never kills".
  //
  // This is the shape the Lead asked to pin after T3's change: "quiesce returns
  // with the pooled process still running".
  const reusable = makePool();
  const survivor = fakeProcess("q");
  reusable.park(entry(survivor));
  check(
    "quiesce leaves a reusable parked process running",
    (await reusable.quiesce("dsh-1", { cwd: "/work", routeKey: "p/m/max" })) === true
      && survivor.killed === false
      && survivor.running === true,
    `killed ${String(survivor.killed)}, running ${String(survivor.running)}`,
  );
  check(
    "…and keeps the entry so the open can still adopt it",
    reusable.has("dsh-1") === true && reusable.size === 1,
    `size ${String(reusable.size)}`,
  );
}

console.log("stop kills everything");
{
  const pool = makePool();
  const one = fakeProcess("m");
  const two = fakeProcess("n");
  pool.park(entry(one, { dshSessionId: "d1" }));
  pool.park(entry(two, { dshSessionId: "d2" }));
  pool.start();
  pool.stop();
  check("all parked processes are killed", one.killed === true && two.killed === true);
  check("the pool is empty", pool.size === 0);
  check("a stop is idempotent", (() => { pool.stop(); return true; })());
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("parked-sessions-check crashed:", error);
  process.exit(1);
});
