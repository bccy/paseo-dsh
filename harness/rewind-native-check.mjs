/**
 * Real-machine probe for the A2 patch (native rewind for plugin providers).
 *
 * Why this exists: `harness/rewind-e2e.mjs` drives the *bridge* directly
 * (`paseo/revert`), which bypasses `agent-manager.rewind()`. The A2 patch lives
 * entirely inside `plugin-provider.revert()` + the daemon's force-hydrate that
 * follows it, so only a request that travels through the real daemon can
 * exercise it. This probe therefore talks to the daemon the way the app does:
 * `@getpaseo/client` -> `agent.rewind.request`.
 *
 * Assertions (each must be able to fail):
 *   R0  the withdrawn message id is gone from the rebuilt timeline
 *   R1  the provider session id is unchanged across the rewind
 *   R2  no `initializing`/`loading` status appears during the rewind
 *   R4  wall-clock latency of `rewindAgent`
 *   R5  a follow-up turn still works and does not see the withdrawn content
 *
 * Usage: node harness/rewind-native-check.mjs [--keep]
 * Costs a few model turns. Requires the patched daemon to be running.
 *
 * The provider and its model are **read from the daemon**, never hard-coded:
 * `REWIND_PROVIDER` / `REWIND_MODEL` override, otherwise the single ready
 * `source: "custom"` provider (that is what a plugin registration is) and the
 * model it flags `isDefault` are used. When the daemon cannot name them
 * unambiguously the probe prints the candidates and exits **2** — "could not
 * resolve a route" is not a test result and must not look like a rewind failure.
 */

import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Resolve `@getpaseo/client` from wherever the CLI is installed. A hard-coded
// home directory would break for every other machine; `PASEO_CLI_ROOT` covers
// the non-standard installs (nvm, pnpm, a checkout).
const require = createRequire(
  join(process.env.PASEO_CLI_ROOT ?? join(homedir(), ".npm-global", "lib", "node_modules", "@getpaseo", "cli"), "package.json"),
);

const { createHostClient } = require("@getpaseo/client/node");

const PASEO_HOME = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
const PORT = process.env.PASEO_PORT ?? "6767";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    fail += 1;
    process.stdout.write(`  ✗ ${name}${detail === "" ? "" : `  (${detail})`}\n`);
  }
};

function localCredential() {
  try {
    return readFileSync(join(PASEO_HOME, "local-credential"), "utf8").trim();
  } catch {
    return undefined;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a promise-returning probe until it yields a truthy value or times out. */
async function waitFor(probe, { timeoutMs = 120_000, intervalMs = 500, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

const root = mkdtempSync(join(tmpdir(), "rewind-native-"));
const keep = process.argv.includes("--keep");

const client = createHostClient(`localhost:${PORT}`, {
  clientId: `rewind-native-check-${Date.now()}`,
  clientType: "cli",
  url: `ws://127.0.0.1:${PORT}`,
  localCredential,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});

/** Status snapshots observed while the rewind is in flight (R2). */
const statuses = [];
let watching = true;
const statusWatcher = (async () => {
  while (watching) {
    try {
      const agents = await client.fetchAgents({ cwd: root });
      for (const agent of agentList(agents)) {
        if (agent.id === agentId) statuses.push(agent.status);
      }
    } catch {
      // Transient failures are not evidence of a loading state; ignore.
    }
    await sleep(200);
  }
})();

let agentId;
/** Exit code override: 2 means "the daemon could not name a route", not a failure. */
let exitCode;

try {
  await client.connect();

  process.stdout.write(`\n[1] 创建 agent（cwd=${root}）\n`);
  // `provider` is a provider **id**, not `provider/model`; the model is a
  // separate override (agent-manager rejects the combined form as "not
  // configured"). Neither is hard-coded: this repo is installed on other
  // machines, where both names differ. The provider and its default model are
  // read off the daemon, and a daemon that cannot name them is reported rather
  // than guessed at — a guessed route here fails deep inside a model turn, long
  // after the probe looked like it started.
  const route = await resolveRoute(client);
  process.stdout.write(`    provider=${route.provider}  model=${route.model}\n`);
  const created = await client.createAgent({
    cwd: root,
    provider: route.provider,
    model: route.model,
    initialPrompt: "记住暗号是 ALPHA。只回复“好”。",
  });
  agentId = created.agentId ?? created.id;
  check("agent 创建成功", typeof agentId === "string" && agentId.length > 0, String(agentId));
  process.stdout.write(`    agentId=${agentId}\n`);

  process.stdout.write("\n[2] 等待第一回合结束，记录 session id（R1 基线）\n");
  await waitFor(async () => {
    const me = await findAgent(client, agentId);
    return me && me.status !== "running" ? me : null;
  }, { label: "turn 1 idle" });

  const sessionIdBefore = await readProviderSessionId(client, agentId);
  process.stdout.write(`    sessionId(before)=${String(sessionIdBefore)}\n`);

  process.stdout.write("\n[3] 第二回合：改暗号为 BETA\n");
  await client.sendAgentMessage(agentId, "把暗号改成 BETA。只回复“好”。");
  await waitFor(async () => {
    const me = await findAgent(client, agentId);
    return me && me.status !== "running" ? me : null;
  }, { label: "turn 2 idle" });

  const timelineBefore = await client.fetchAgentTimeline(agentId, { direction: "tail" });
  const userRowsBefore = collectUserRows(timelineBefore);
  check("撤回前有 2 条用户消息", userRowsBefore.length === 2, String(userRowsBefore.length));

  const target = userRowsBefore[userRowsBefore.length - 1];
  process.stdout.write(`\n[4] 撤回第二条（messageId=${String(target.messageId)}）\n`);

  const startedAt = Date.now();
  const receipt = await client.rewindAgent(agentId, target.messageId, "conversation");
  const elapsedMs = Date.now() - startedAt;

  check("撤回回执 ok", receipt?.ok === true, JSON.stringify(receipt));
  process.stdout.write(`    R4 回执延迟 = ${elapsedMs} ms\n`);

  // **Do not try to sample "before the reload" by fetching the timeline.**
  // Measured: `fetch_agent_timeline` takes ~900 ms p50 (up to 11 s), while the
  // plugin's `paseo agent reload` lands ~680 ms after the receipt. A fetch
  // started right after the receipt therefore finishes *after* the reload and
  // reports the reload's result — that is exactly how the first version of this
  // probe produced a false green. Attribution has to come from the daemon log
  // instead: the A2 truncation leaves no reload behind, so "did a reload happen
  // for this agent, and when relative to the receipt" is the discriminator.
  await sleep(2500);
  const reloadAt = await findReloadAfterRewind(agentId);
  process.stdout.write(
    `    reload 记录: ${reloadAt === null ? "无" : `${String(reloadAt)} ms 后`}\n`,
  );

  process.stdout.write("\n[5] R0：被撤消息必须从时间线消失\n");
  const timelineAfter = await client.fetchAgentTimeline(agentId, { direction: "tail" });
  const userRowsAfter = collectUserRows(timelineAfter);
  // The daemon re-keys the row it is asked to withdraw: the request carries the
  // bare uuid from `clientMessageId`, while the stored row's `messageId` is
  // `user:<uuid>` (that is what the plugin's `revertToken` names). Match on
  // `clientMessageId` too, otherwise a successful rewind looks like a miss.
  const sameRow = (row) =>
    row.messageId === target.messageId
    || row.clientMessageId === target.messageId
    || row.messageId === `user:${String(target.messageId)}`;
  const stillThere = userRowsAfter.some(sameRow);
  check("被撤的 messageId 已不在时间线", !stillThere, `仍存在: ${String(target.messageId)}`);
  // Do not assert an absolute count: later steps append rows of their own, and an
  // absolute number would fail for a reason unrelated to the rewind. Assert the
  // one thing the rewind promises — that row is gone — plus that the rows before
  // it survived.
  check(
    "撤回点之前的用户消息仍然保留",
    userRowsAfter.some((row) => row.clientMessageId === userRowsBefore[0]?.clientMessageId),
    `${String(userRowsAfter.length)} 条`,
  );

  process.stdout.write("\n[6] R1：provider session id 必须不变\n");
  const sessionIdAfter = await readProviderSessionId(client, agentId);
  process.stdout.write(`    sessionId(after)=${String(sessionIdAfter)}\n`);
  check(
    "session id 撤回前后一致",
    sessionIdBefore !== undefined && sessionIdBefore === sessionIdAfter,
    `${String(sessionIdBefore)} -> ${String(sessionIdAfter)}`,
  );

  process.stdout.write("\n[7] R2：撤回期间不得出现 loading/initializing\n");
  watching = false;
  await statusWatcher;
  const unique = [...new Set(statuses)];
  process.stdout.write(`    观察到的状态序列（去重）: ${unique.join(", ") || "(空)"}\n`);
  check(
    "未出现 loading/initializing",
    !statuses.some((status) => status === "loading" || status === "initializing"),
    unique.join(","),
  );

  process.stdout.write("\n[8] R5：撤回后继续对话，且模型看不到被撤内容\n");
  await client.sendAgentMessage(agentId, "现在的暗号是什么？只回复暗号本身。");
  const answer = await waitFor(async () => {
    const me = await findAgent(client, agentId);
    if (!me || me.status === "running") return null;
    const timeline = await client.fetchAgentTimeline(agentId, { direction: "tail" });
    const texts = collectAssistantTexts(timeline);
    return texts.length > 0 ? texts[texts.length - 1] : null;
  }, { label: "turn 3 answer" });

  process.stdout.write(`    回答: ${String(answer).slice(0, 80)}\n`);
  check("撤回后仍能继续对话", typeof answer === "string" && answer.length > 0);
  check("模型回答 ALPHA（看不到被撤的 BETA）", /ALPHA/i.test(answer), String(answer).slice(0, 60));
} catch (error) {
  if (error instanceof RouteUnresolvedError) {
    // Not a test result: no route means nothing was measured.
    process.stdout.write(`  ✗ 无法确定要测的 provider/model：${error.message}\n`);
    exitCode = 2;
  } else {
    fail += 1;
    process.stdout.write(`  ✗ 探针异常: ${error instanceof Error ? error.message : String(error)}\n`);
  }
} finally {
  watching = false;
  try {
    if (agentId !== undefined && !keep) await client.deleteAgent?.(agentId);
  } catch {
    // Deleting is best-effort; a leftover probe agent is not a test failure.
  }
  try {
    await client.close?.();
  } catch {
    // ignore
  }
  if (!keep) rmSync(root, { recursive: true, force: true });
  process.stdout.write(`\n结果：${pass} 通过, ${fail} 失败\n`);
  process.exit(exitCode ?? (fail === 0 ? 0 : 1));
}

/**
 * Ask the daemon log whether a `paseo agent reload` happened for this agent
 * after its rewind. Reads the user journal; returns the delay in ms, or null.
 *
 * This is the only reliable discriminator between "A2 truncated the history"
 * and "the plugin's reload rebuilt the timeline": both make the withdrawn row
 * disappear, but only the latter emits a "Refreshing agent" line.
 */
async function findReloadAfterRewind(agentId) {
  const { execFileSync } = await import("node:child_process");
  let raw = "";
  try {
    raw = execFileSync(
      "journalctl",
      ["--user", "-u", "paseo", "--since", "-3 min", "--no-pager", "-o", "cat"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return null;
  }
  let rewindAt = null;
  let reloadAt = null;
  for (const line of raw.split("\n")) {
    if (!line.includes(agentId)) continue;
    const start = line.indexOf("{");
    if (start < 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    const message = String(parsed.message ?? "");
    const time = Number(parsed.time ?? 0);
    if (message.includes("agent.rewind.complete")) rewindAt = time;
    if (message.includes("Refreshing agent")) reloadAt = time;
  }
  if (rewindAt === null || reloadAt === null) return reloadAt === null ? null : 0;
  return reloadAt - rewindAt;
}

/** `fetchAgentTimeline()` answers `{ entries: [{ provider, item, seqStart, ... }] }`. */
function timelineItems(timeline) {
  return (timeline?.entries ?? []).map((entry) => entry?.item).filter(Boolean);
}

function collectUserRows(timeline) {
  return timelineItems(timeline)
    .filter((item) => item.type === "user_message")
    .map((item) => ({
      messageId: item.messageId ?? item.id,
      clientMessageId: item.clientMessageId,
      text: item.text,
    }));
}

function collectAssistantTexts(timeline) {
  return timelineItems(timeline)
    .filter((item) => item.type === "assistant_message")
    .map((item) => item.text)
    .filter((text) => typeof text === "string" && text.trim() !== "");
}

/** `fetchAgents()` answers `{ entries: [{ agent, project }] }`, not a bare list. */
function agentList(payload) {
  return (payload?.entries ?? []).map((entry) => entry.agent).filter(Boolean);
}

async function findAgent(client, agentId) {
  const payload = await client.fetchAgents({ cwd: root });
  return agentList(payload).find((agent) => agent.id === agentId);
}

/**
 * The provider session id the daemon reports. For a plugin provider it is
 * `plugin:{"version":1,"data":{"sessionId":"<dsh session>"}}`; unwrap it so the
 * assertion compares the real DSH session rather than the envelope.
 */
function unwrapSessionId(raw) {
  if (typeof raw !== "string") return raw;
  if (!raw.startsWith("plugin:")) return raw;
  try {
    const parsed = JSON.parse(raw.slice("plugin:".length));
    return parsed?.data?.sessionId ?? raw;
  } catch {
    return raw;
  }
}

async function readProviderSessionId(client, agentId) {
  const me = await findAgent(client, agentId);
  return unwrapSessionId(me?.runtimeInfo?.sessionId);
}

/**
 * Raised when the daemon cannot name a provider/model for this probe.
 *
 * Distinct from a failed assertion: nothing was measured, so the script must not
 * report "0 passed, 1 failed" as if the rewind had been tested and broken.
 */
class RouteUnresolvedError extends Error {}

/** Abort with the "cannot resolve the route" exit code (2) and a reason. */
function unresolved(message) {
  throw new RouteUnresolvedError(message);
}

/**
 * The provider/model this probe creates its agent on.
 *
 * Neither name may be hard-coded: this repository is installed on other machines,
 * where both differ, and the DSH provider id is a plugin identity rather than a
 * protocol constant. The daemon already knows both — a plugin-registered provider
 * is the `source: "custom"` entry in its providers snapshot (the host's
 * `provider-snapshot-manager.js` marks every `pluginProviders` id that way), and
 * that provider's default model is the one `listProviderModels` flags
 * `isDefault` — the same entry the daemon's own `resolveDefaultModelId` would
 * pick for a create request that named no model.
 *
 * Anything ambiguous ends the run with exit 2 and the candidates instead of a
 * guess: a wrong route fails deep inside the first model turn, long after the
 * probe looked like it had started, and reads as a rewind failure.
 */
async function resolveRoute(client) {
  const provider = await resolveProvider(client);
  const model = await resolveModel(client, provider);
  return { provider, model };
}

/** The plugin provider to probe: `REWIND_PROVIDER`, else the only ready one. */
async function resolveProvider(client) {
  const configured = process.env.REWIND_PROVIDER;
  if (configured !== undefined && configured !== "") return configured;

  // Bounded wait, not a guess: the snapshot is warmed asynchronously at daemon
  // start, and a plugin provider that is still `loading` has not been ruled out.
  const deadline = Date.now() + 20_000;
  let entries = [];
  for (;;) {
    let snapshot;
    try {
      snapshot = await client.getProvidersSnapshot();
    } catch (error) {
      unresolved(
        `读取 daemon 的 provider 快照失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    entries = snapshot?.entries ?? [];
    const ready = entries.filter(
      (entry) => entry.source === "custom" && entry.status === "ready" && entry.enabled !== false,
    );
    if (ready.length === 1) return ready[0].provider;
    if (ready.length > 1) {
      unresolved(
        `daemon 报告 ${String(ready.length)} 个可用的自定义 provider（${ready
          .map((entry) => entry.provider)
          .join(", ")}），无法确定要测哪一个；设 REWIND_PROVIDER 指定`,
      );
    }
    if (Date.now() > deadline) {
      const custom = entries.filter((entry) => entry.source === "custom");
      const described = (custom.length > 0 ? custom : entries).map(
        (entry) => `${entry.provider}=${String(entry.status)}${entry.enabled === false ? "(disabled)" : ""}`,
      );
      unresolved(
        custom.length > 0
          ? `daemon 的自定义 provider 都不 ready（${described.join(", ")}）；设 REWIND_PROVIDER 指定`
          : `daemon 没有报告任何自定义 provider（provider 快照：${described.join(", ") || "空"}）；`
            + "paseo-dsh 插件没装或没启用？可设 REWIND_PROVIDER 指定",
      );
    }
    await sleep(500);
  }
}

/** The provider's default model: `REWIND_MODEL`, else the one marked default. */
async function resolveModel(client, provider) {
  const configured = process.env.REWIND_MODEL;
  if (configured !== undefined && configured !== "") return configured;

  let payload;
  try {
    payload = await client.listProviderModels(provider, { cwd: root });
  } catch (error) {
    unresolved(
      `读取 provider '${provider}' 的模型列表失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof payload?.error === "string" && payload.error !== "") {
    unresolved(`daemon 拒绝列出 provider '${provider}' 的模型：${payload.error}`);
  }
  const models = payload?.models ?? [];
  const defaults = models.filter((model) => model.isDefault === true);
  if (defaults.length === 1) return defaults[0].id;
  const ids = models.map((model) => model.id).join(", ") || "空";
  unresolved(
    defaults.length === 0
      ? `provider '${provider}' 没有标出默认模型（可选：${ids}）；设 REWIND_MODEL 指定`
      : `provider '${provider}' 标了 ${String(defaults.length)} 个默认模型（${defaults
          .map((model) => model.id)
          .join(", ")}）；设 REWIND_MODEL 指定`,
  );
}
