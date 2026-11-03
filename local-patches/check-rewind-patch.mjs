#!/usr/bin/env node
/**
 * check-rewind-patch.mjs — 「turnId 补丁现在到底能不能用」的实时体检。
 *
 * 与 apply-rewind-history-truncation.mjs 的分工：
 *   - apply 负责**改文件**（ExecStartPre / 启动钩子每次启动前跑）
 *   - 本脚本只**读**，回答「现在是什么状态、要不要动手」，不写目标文件
 *
 * 它不信任状态文件：状态文件可能是上一次启动留下的，而目标文件可能已经被
 * `npm i -g @getpaseo/cli` 换掉了。所以判定一律以**真实文件内容**为准，
 * 状态文件只作为「上次 ExecStartPre 成功还是失败」的附加上下文打印。
 *
 * 历史：本脚本以前还检查 rewind（`plugin-provider.js` 的 history 截断补丁）。
 * 那个 target 已随 Paseo 0.15.0 原生修好 #4667（上游 PR #8368）而退休——
 * 0.15 的 `PluginSessionHistory` 连 `truncateHistoryFrom` 依赖的数组语义都没有，
 * 旧补丁只能 fail closed。现在只剩 turnId 一个 target；文件名保留是因为
 * 部署接线（systemd ExecStartPre / NODE_OPTIONS 钩子）与文档都指向它。
 *
 * 用法: node check-rewind-patch.mjs [--json]
 *
 * exit code（权威表也在 UPGRADE.md §2）:
 *   0  补丁在位（MARKER 计数 == 2 且实现体是最新的）→ 重开会话可正常折叠轮次
 *   1  需要跑一次 apply：未打补丁但锚点与上下文都能自动打，**或**标记齐全但
 *      实现体是旧版且**可原地重建**（`state: stale-body`）
 *   2  需要人工介入：锚点失配 / 上下文失配 / 文件处于半打补丁状态 /
 *      `stale-body-unrebuildable`（apply 也会拒绝，不是“可自动打”）
 *   3  目标文件不存在 → paseo 可能没装，或安装路径变了
 *
 * ⚠️ `1` 覆盖两种情形（"没打，可打" 与 "打了但是旧体"），二者的处置相同（跑
 *    apply），但原因不同。**要区分请看 `state`，不要只看 exit code**：
 *    `state: patchable` vs `state: stale-body`。`--json` 里同样有 `state`。
 *
 * ⚠️ `stale-body` 与 `stale-body-unrebuildable` 是**两个不同结论**：前者 apply
 *    会原地重建，后者 apply 会 fail closed（标记区域缺 `});`，或区域数不是 2）。
 *    判定与 apply 共用同一个只读函数（`turnIdRebuildPlan`），不是按“stale 就该
 *    重跑 apply”猜的。
 *
 * 注：md5 只作为「文件当前指纹」打印与记录，**不参与判定**。上游改一个无关字节
 *     不该被当成故障 —— 那是 apply 的锚点自适配要处理的事。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
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
} from "./apply-rewind-history-truncation.mjs";

// The apply script is the checker's sibling — deriving it from this file (not
// from REWIND_PATCH_HOME, which only means "where backups/status go") keeps the
// hint text and --json.applyScript correct for a custom patch home.
const APPLY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "apply-rewind-history-truncation.mjs");

const JSON_OUTPUT = process.argv.includes("--json");

function readStatus() {
  if (!existsSync(STATUS_FILE)) {
    return { present: false, raw: null, error: null };
  }
  try {
    return { present: true, raw: JSON.parse(readFileSync(STATUS_FILE, "utf8")), error: null };
  } catch (error) {
    return { present: true, raw: null, error: error.message };
  }
}

/** Pure inspection — never writes the target. */
function inspect() {
  const status = readStatus();

  if (!existsSync(TURNID_TARGET)) {
    return {
      code: 3,
      state: "target-missing",
      ok: false,
      target: TURNID_TARGET,
      targetMd5: null,
      markerCount: null,
      autoPatchable: false,
      summary: "目标文件不存在：paseo 可能没安装，或安装路径变了。"
        + "turnId 补丁不可用（不影响撤回本身，只是重开会话后长对话不折叠轮次）。",
      hint: `确认 ${TURNID_TARGET} 是否存在；若 paseo 装在别处，设 PASEO_CLI_ROOT 或 REWIND_PATCH_TURNID_TARGET。`,
      status,
    };
  }

  const source = readFileSync(TURNID_TARGET, "utf8");
  const targetMd5 = md5(source);
  const markers = countOccurrences(source, TURNID_MARKER);
  const base = {
    target: TURNID_TARGET,
    targetMd5,
    markerCount: markers,
    status,
  };

  if (markers === 2) {
    // Markers prove *presence*, not *currency*: the injected body is part of the
    // apply script, so a file can carry an older body with the same 2 markers.
    // Reporting `code: 0` for that would be the exact false green this script
    // exists to prevent — a body that drops `turnId` is functionally unpatched.
    const stale = turnIdStaleness(source);
    if (stale.current) {
      return {
        ...base,
        code: 0,
        state: "patched",
        ok: true,
        autoPatchable: false,
        patchBody: "current",
        summary: "补丁在位且实现体是最新的：重开会话后长对话仍能折叠轮次。",
        hint: "无需动作。",
      };
    }
    // "stale" answers "is the body old"; it does **not** answer "would apply
    // rebuild it".  The plan below is the exact read-only code apply runs, so
    // the two cannot disagree (LP-02 lesson).
    const plan = turnIdRebuildPlan(source);
    if (!plan.ok) {
      return {
        ...base,
        code: 2,
        state: "stale-body-unrebuildable",
        ok: false,
        autoPatchable: false,
        patchBody: "stale",
        staleDetail: stale.detail,
        rebuildBlockedReason: plan.reason,
        rebuildBlockedDetail: plan.detail,
        summary: `补丁标记齐全，但实现体是旧版且 apply 无法原地重建（${plan.reason}：${plan.detail}）。`
          + "文件会保持原样，但重开会话后的回合折叠仍不可用。",
        hint: "重装 @getpaseo/cli（恢复干净文件）后重跑 apply。"
          + "不要只跑 apply —— 它会 fail closed，什么都不写。",
      };
    }
    return {
      ...base,
      code: 1,
      state: "stale-body",
      ok: false,
      autoPatchable: true,
      patchBody: "stale",
      staleDetail: stale.detail,
      summary: `补丁标记齐全但实现体是旧版（${stale.detail}）：重开会话后回合折叠仍不可用。`,
      hint: `跑 node ${APPLY_SCRIPT} 原地重建（不需要干净基线：只替换本补丁自己的标记区域，其它内容不动）。`,
    };
  }

  if (markers !== 0) {
    return {
      ...base,
      code: 2,
      state: "partially-patched",
      ok: false,
      autoPatchable: false,
      summary: `文件处于半打补丁状态（MARKER 计数 ${markers}，既不是 0 也不是 2）。turnId 补丁状态未知。`,
      hint: "重装 @getpaseo/cli，或用 ~/.paseo/local-patches/ 下的 agent-manager.js.orig-turnid-* 备份覆盖后重跑 apply。",
    };
  }

  // Clean file. Only promise a patch when apply's own anchor+context gates would
  // pass — otherwise "run apply to fix it" sends the operator into a guaranteed
  // failure (LP-02).
  const matches = matchAll(TURNID_CALL_RE, source);
  if (matches.length !== 2) {
    return {
      ...base,
      code: 2,
      state: "anchor-mismatch",
      ok: false,
      autoPatchable: false,
      turnIdMatches: matches.length,
      summary: `补丁不在位，且重放调用锚点失配：命中 ${matches.length} 次（需恰好 2 次，`
        + "分别位于 forceHydrate 与 primeTimeline 两条重放路径）。"
        + "turnId 补丁无法自动打上，重开会话后长对话不折叠轮次（不丢数据）。",
      hint: "上游改动了重放调用。若新版已经把 turnId 传给 recordTimeline（grep 该调用附近有 "
        + "`turnId`），说明上游自己修好了，按 UPGRADE.md §5 删补丁；否则核对 "
        + `${APPLY_SCRIPT} 里的 TURNID_CALL_RE：grep 当前文件里的 `
        + "`this.recordTimeline(agent.id, event.item` 与 `event.timestamp ?`，按新形状改正则后重跑。",
    };
  }
  for (const [index, expected] of TURNID_CONTEXTS.entries()) {
    const match = matches[index];
    const after = source.slice(match.index + match[0].length, match.index + match[0].length + 400);
    if (!after.includes(expected)) {
      return {
        ...base,
        code: 2,
        state: "anchor-context-mismatch",
        ok: false,
        autoPatchable: false,
        turnIdContext: index + 1,
        summary: `补丁不在位，且第 ${index + 1} 处重放调用的后续代码不是预期的 \`${expected}\`：`
          + "两处调用可能被调换顺序或新增了第三处，apply 会拒绝猜位置。",
        hint: `核对 ${APPLY_SCRIPT} 里的 TURNID_CONTEXTS 与当前文件的两条重放路径，按新顺序/形状改写后重跑。`,
      };
    }
  }
  return {
    ...base,
    code: 1,
    state: "patchable",
    ok: true,
    autoPatchable: true,
    summary: "补丁不在位，但两处重放调用都命中且上下文正确 —— 可以自动打上。",
    hint: `跑 node ${APPLY_SCRIPT} 即可（daemon 下次启动时 ExecStartPre 也会自动打）。`,
  };
}

function humanReport(result, exitCode) {
  const lines = [];
  lines.push(`[rewind-patch] target: ${result.target}`);
  if (result.targetMd5 !== null) {
    lines.push(`[rewind-patch] md5: ${result.targetMd5}`);
    lines.push(`[rewind-patch] marker: ${result.markerCount}/2`);
  }
  lines.push("");
  lines.push(`[rewind-patch] state: ${result.state}`);
  lines.push(`[rewind-patch] ${result.summary}`);
  lines.push(`[rewind-patch] 建议: ${result.hint}`);

  lines.push("");
  lines.push("[rewind-patch] 上次 ExecStartPre 记录:");
  if (!result.status.present) {
    lines.push(`  (无 ${STATUS_FILE}，说明补丁脚本自安装后从未运行过)`);
  } else if (result.status.error !== null) {
    lines.push(`  (状态文件存在但读不出来: ${result.status.error})`);
  } else {
    const raw = result.status.raw;
    lines.push(`  ok=${raw.ok}  reason=${raw.reason}  at=${raw.at}`);
    if (raw.paseoVersion) lines.push(`  paseoVersion=${raw.paseoVersion}`);
    if (raw.upstreamMd5) lines.push(`  upstreamMd5=${raw.upstreamMd5}`);
    if (raw.backup) lines.push(`  backup=${raw.backup}`);
    if (raw.message) lines.push(`  message=${raw.message}`);
  }
  lines.push("");
  // The printed exit code must be the one the process actually returns.
  lines.push(`[rewind-patch] exit ${exitCode}`);
  return lines.join("\n");
}

const result = inspect();
// `ok` answers "is the patch in place and healthy"; the exit code is the
// documented action signal (0 patched / 1 run apply / 2 human / 3 missing).
// `patchable` is `ok: true` (apply will fix it) yet exits 1 — keep them separate.
const exitCode = result.code;

if (JSON_OUTPUT) {
  // Keep the shape stable: callers should branch on `code` / `state`, not prose.
  const { status, ...rest } = result;
  process.stdout.write(`${JSON.stringify({
    code: result.code,
    state: result.state,
    ok: result.ok,
    target: result.target,
    targetMd5: result.targetMd5,
    markerCount: result.markerCount,
    autoPatchable: result.autoPatchable,
    patchBody: result.patchBody ?? null,
    staleDetail: result.staleDetail ?? null,
    turnIdMatches: result.turnIdMatches ?? null,
    turnIdContext: result.turnIdContext ?? null,
    // LP-02 residual: name the shape that blocked the rebuild, so a machine
    // consumer can tell "apply will rebuild" from "apply will refuse".
    rebuildBlockedReason: result.rebuildBlockedReason ?? null,
    rebuildBlockedDetail: result.rebuildBlockedDetail ?? null,
    summary: result.summary,
    hint: result.hint,
    applyScript: APPLY_SCRIPT,
    lastRun: status.present ? (status.raw ?? { error: status.error }) : null,
    exitCode,
  }, null, 2)}\n`);
} else {
  process.stdout.write(`${humanReport(result, exitCode)}\n`);
}

process.exit(exitCode);
