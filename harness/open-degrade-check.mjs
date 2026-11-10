/**
 * Open-time degradations that used to be stderr-only must be visible.
 *
 * The failures pinned here all share one shape: the session still opens (that
 * is the right call — a blank conversation is better than a refused one), but
 * the user is told why something they asked for did not happen. Before this
 * check, the only trace was a line on the daemon's stderr, which the user never
 * sees:
 *
 *   1. `paseo/history` rejects (timeout / transport / dead child). The reopened
 *      conversation is blank. `replayHistory()` must emit the same
 *      「会话历史读取失败」 notice it already emits for `{available:false}`.
 *   2. DSH refuses a stale/disabled preset without an error reply: the applied
 *      preset stays the old one. The provider must read the value back from
 *      `paseo/presets` and put 「预设未应用」 on the timeline.
 *   3. `paseo/plan/set` rejects while opening. The mode is not reconciled; the
 *      session must still open but say 「Plan 模式未能同步」.
 *   4. `paseo/subagents` answers `{available:false, error}`. The reopened tree
 *      is empty for a reason, so it must say 「子代理列表读取失败」 (a profile
 *      with no subagent service has no error and stays silent).
 *
 * Asserted at the protocol layer (the plugin's own emitted events), not through
 * the UI: a missing notice renders as an ordinary blank conversation and would
 * never fail a visual check.
 *
 * Uses the scripted fake `dsh` and a throwaway `DSH_HOME`; no profile, model or
 * daemon is touched. Each scenario gets its own provider connection (and
 * therefore its own fake child) so `DSH_FAKE_MODE` is fixed at spawn time.
 *
 * Run:
 *   node harness/open-degrade-check.mjs [compiled-plugin-dir]
 *
 * (compiles into `paseo-plugin/.dbg-p5b-open-degrade` unless a build directory
 * is passed)
 */
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { resolvePluginBuild } = require("./plugin-build.cjs");

const fakeBridge = join(here, "fake-dsh-bridge.mjs");
if (!existsSync(fakeBridge)) {
  console.error(`fake bridge missing at ${fakeBridge}`);
  process.exit(2);
}
chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-open-degrade-check-"));
process.on("exit", () => {
  try {
    rmSync(process.env.DSH_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const buildDir = resolvePluginBuild(process.argv[2], ".dbg-p5b-open-degrade");
const plugin = require(join(buildDir, "index.server.js")).default;

let registration;
plugin({
  handle() {},
  registerProvider(r) {
    registration = r;
  },
  registerSettings() {},
  on() {},
  before() {},
});
if (registration === undefined) {
  console.error("the plugin did not register a provider");
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition === true) {
    passed += 1;
    console.log(`  PASS  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(list, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = list.find(predicate);
      if (found !== undefined) return resolve(found);
      if (Date.now() > deadline) {
        return reject(new Error(`timed out; saw ${list.map((event) => event.type).join(", ") || "(nothing)"}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

/**
 * Open one provider session in `mode` and return the events until `settleMs`
 * after `session.ready`. The extra wait is for `replaySubagents()`, which the
 * provider starts with `void` after ready.
 */
async function openInMode(mode, options = {}) {
  process.env.DSH_FAKE_MODE = mode;
  const conn = await registration.connect({ capabilities: ["prompt.message", "session.subsession"] });
  const events = [];
  conn.onEvent((event) => events.push(event));
  const sessionId = `degrade-${mode}-${String(Date.now())}`;
  await conn.send({
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    config: {
      cwd: options.cwd ?? process.cwd(),
      mode: options.mode ?? "build",
      ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
    },
    history: options.history ?? "skip",
  });
  try {
    await waitFor(events, (event) => event.type === "session.ready" && event.sessionId === sessionId);
    await sleep(options.settleMs ?? 400);
    return { conn, events, sessionId };
  } catch (error) {
    const failures = events
      .filter((event) => event.type === "request.failed" || event.type === "session.runtime_failed")
      .map((event) => event.error?.message ?? event.type);
    throw new Error(`open failed: ${failures.join(" | ") || error.message}`);
  }
}

const noticesOf = (events, title) =>
  events.filter((event) => event.type === "session.notice" && event.notice?.title === title);

console.log("open-time degradations are visible on the timeline");
{
  const { conn, events } = await openInMode("history-error", { history: "replay" });
  const notices = noticesOf(events, "会话历史读取失败");
  check(
    "a rejecting paseo/history becomes a 会话历史读取失败 notice",
    notices.length === 1,
    `${String(notices.length)} notice(s); all: ${JSON.stringify(events.filter((e) => e.type === "session.notice").map((e) => e.notice?.title))}`,
  );
  check(
    "…and the notice carries the runtime's reason",
    /paseo\/history transport failed/.test(notices[0]?.notice?.description ?? ""),
    notices[0]?.notice?.description ?? "(missing)",
  );
  await conn.close();
}

{
  const { conn, events } = await openInMode("preset-reject", {
    providerOptions: { preset: "chosen-pet" },
  });
  const notices = noticesOf(events, "预设未应用");
  check(
    "a silently refused preset becomes a 预设未应用 notice",
    notices.length === 1,
    `${String(notices.length)} notice(s); all: ${JSON.stringify(events.filter((e) => e.type === "session.notice").map((e) => e.notice?.title))}`,
  );
  check(
    "…and names the requested and the actual preset",
    /chosen-pet/.test(notices[0]?.notice?.description ?? "")
      && /default-pet/.test(notices[0]?.notice?.description ?? ""),
    notices[0]?.notice?.description ?? "(missing)",
  );
  await conn.close();
}

{
  // The catalog is cached per cwd for five minutes, and only a profile that
  // *advertises* Plan ever reconciles it — so this scenario needs its own cwd
  // before the fake bridge's `planMode: true` reaches the open.
  const planCwd = mkdtempSync(join(tmpdir(), "degrade-plan-error-"));
  const { conn, events } = await openInMode("plan-error", { mode: "plan", cwd: planCwd });
  const notices = noticesOf(events, "Plan 模式未能同步");
  check(
    "a rejecting paseo/plan/set becomes a Plan 模式未能同步 notice",
    notices.length === 1,
    `${String(notices.length)} notice(s); all: ${JSON.stringify(events.filter((e) => e.type === "session.notice").map((e) => e.notice?.title))}`,
  );
  check(
    "…and the session is still usable (ready was published)",
    events.some((event) => event.type === "session.ready"),
  );
  await conn.close();
  rmSync(planCwd, { recursive: true, force: true });
}

{
  const { conn, events } = await openInMode("error");
  const notices = noticesOf(events, "子代理列表读取失败");
  check(
    "a failed subagent catalog read becomes a 子代理列表读取失败 notice",
    notices.length === 1,
    `${String(notices.length)} notice(s); all: ${JSON.stringify(events.filter((e) => e.type === "session.notice").map((e) => e.notice?.title))}`,
  );
  check(
    "…with the runtime's message",
    /subagent catalog exploded/.test(notices[0]?.notice?.description ?? ""),
    notices[0]?.notice?.description ?? "(missing)",
  );
  await conn.close();
}

console.log(`\n${String(passed)} passed, ${String(failed)} failed`);
if (failed > 0) process.exit(1);
