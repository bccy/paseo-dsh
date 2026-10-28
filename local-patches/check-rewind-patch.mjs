#!/usr/bin/env node
/**
 * check-rewind-patch.mjs — 「撤回补丁现在到底能不能用」的实时体检。
 *
 * 与 apply-rewind-history-truncation.mjs 的分工：
 *   - apply 负责**改文件**（ExecStartPre 每次启动前跑）
 *   - 本脚本只**读**，回答「现在是什么状态、要不要动手」，不写目标文件
 *
 * 它不信任状态文件：状态文件可能是上一次启动留下的，而目标文件可能已经被
 * `npm i -g @getpaseo/cli` 换掉了。所以判定一律以**真实文件内容**为准，
 * 状态文件只作为「上次 ExecStartPre 成功还是失败」的附加上下文打印。
 *
 * 用法: node check-rewind-patch.mjs [--json]
 *
 * exit code:
 *   0  补丁在位（MARKER 计数 == 2 且实现体是最新的）→ 撤回功能正常，无需动作
 *   1  需要跑一次 apply：未打补丁但锚点各命中 1 次（可自动打），**或**标记齐全但
 *      实现体是旧版（`state: stale-body`，需重建）
 *   2  未打补丁，且锚点失配 / 文件处于半打补丁状态 → 需人工介入，撤回已降级
 *   3  目标文件不存在 → paseo 可能没装，或安装路径变了
 *   4  上游已自行修好撤回（revert() 里自己截断 history）→ **补丁该退休了**，
 *      按 UPGRADE.md 第 5 节删掉，别让它继续滞留并刷假告警
 *
 * ⚠️ `1` 覆盖两种情形（"没打，可打" 与 "打了但是旧体"），二者的处置相同（跑 apply），
 *    但原因不同。**要区分请看 `state`，不要只看 exit code**：
 *    `state: patchable` vs `state: stale-body`。
 *    `--json` 里同样有 `state` 字段。
 *
 * ⚠️ 本脚本只判 rewind 一个 target 的 exit code；`childRunning` 的结果在
 *    `siblings` / `siblingsAllOk`（human 报告里是"同文件姊妹补丁"一节）。
 *    姊妹补丁缺失不会改变 exit code，所以**不要只看 exit code 判断整机健康**。
 *
 * 注：md5 只作为「与已知基线差多远」的参考信息打印，**不参与判定**。
 *     上游改一个无关字节不该被当成故障 —— 那是 apply 的锚点自适配要处理的事。
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANCHOR_A_RE,
  ANCHOR_B_RE,
  BASE_MD5,
  CHILDRUNNING_MARKER,
  CHILDRUNNING_TARGET,
  MARKER,
  TARGET,
  childRunningStaleness,
  countOccurrences,
  detectUpstreamSelfFix,
  matchAll,
  rewindPatchStaleness,
} from "./apply-rewind-history-truncation.mjs";

const HOME_DIR = process.env.REWIND_PATCH_HOME ?? dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = join(HOME_DIR, "rewind-patch.status.json");
const APPLY_SCRIPT = join(HOME_DIR, "apply-rewind-history-truncation.mjs");

const JSON_OUTPUT = process.argv.includes("--json");

const md5 = (text) => createHash("md5").update(text).digest("hex");

/**
 * The sibling targets that live in the same file / same install as the rewind
 * patch.  Reported here because this script is the human-facing health check:
 * reporting only rewind made the whole install look healthy while
 * `childRunning` was missing, which is precisely the silent degradation this
 * project keeps having to dig out of logs.
 *
 * These never change the exit code — rewind's verdict owns that, and callers
 * (UPGRADE.md, the startup hook notes) branch on it.  They are printed and
 * carried in `--json` so a reader cannot miss them.
 */
function siblingTargets() {
  const describeSibling = (label, file, marker, staleness) => {
    if (!existsSync(file)) {
      return { label, ok: false, state: "target-missing", markerCount: null, detail: `target missing: ${file}` };
    }
    const source = readFileSync(file, "utf8");
    const markers = countOccurrences(source, marker);
    if (markers === 0) {
      return { label, ok: false, state: "not-patched", markerCount: 0, detail: "not patched (0 markers)" };
    }
    if (markers !== 2) {
      return {
        label,
        ok: false,
        state: "half-patched",
        markerCount: markers,
        detail: `HALF-PATCHED (${String(markers)}/2 markers) — restore from backup`,
      };
    }
    const stale = staleness(source);
    if (!stale.current) {
      return {
        label,
        ok: false,
        state: "stale-body",
        markerCount: markers,
        detail: `markers 2/2 but the body is old (${stale.detail}) — run apply to rebuild`,
      };
    }
    return { label, ok: true, state: "patched", markerCount: 2, detail: "patched (2/2 markers, body current)" };
  };

  return [
    describeSibling("rewind", TARGET, MARKER, rewindPatchStaleness),
    describeSibling("childRunning", CHILDRUNNING_TARGET, CHILDRUNNING_MARKER, childRunningStaleness),
  ];
}

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

  if (!existsSync(TARGET)) {
    return {
      code: 3,
      state: "target-missing",
      ok: false,
      target: TARGET,
      targetMd5: null,
      baseMd5: BASE_MD5,
      markerCount: null,
      anchorA: null,
      anchorB: null,
      autoPatchable: false,
      summary: "目标文件不存在：paseo 可能没安装，或安装路径变了。撤回功能不可用（插件侧不受影响，只是时间线不自动刷新）。",
      hint: `确认 ${TARGET} 是否存在；若 paseo 装在别处，改 apply 脚本里的 TARGET 或设 REWIND_PATCH_TARGET。`,
      status,
    };
  }

  const source = readFileSync(TARGET, "utf8");
  const targetMd5 = md5(source);
  const markers = countOccurrences(source, MARKER);
  const anchorA = matchAll(ANCHOR_A_RE, source).length;
  const anchorB = matchAll(ANCHOR_B_RE, source).length;
  const base = {
    target: TARGET,
    targetMd5,
    baseMd5: BASE_MD5,
    matchesKnownBaseline: targetMd5 === BASE_MD5,
    markerCount: markers,
    anchorA,
    anchorB,
    status,
  };

  if (markers === 2) {
    // Markers prove *presence*, not *currency*: the injected method is part of
    // the apply script, so a file can carry an older body with the same 2
    // markers.  Reporting `code: 0` for that would be the exact false green this
    // script exists to prevent — the old body's known defect is that the second
    // rewind in a session fails with "No provider revert token".
    const stale = rewindPatchStaleness(source);
    if (stale.current) {
      return {
        ...base,
        code: 0,
        state: "patched",
        ok: true,
        autoPatchable: false,
        patchBody: "current",
        summary: "补丁在位且实现体是最新的，撤回功能正常（撤回后时间线立即刷新，不需要重开会话）。",
        hint: "无需动作。",
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
      summary: `补丁标记齐全但实现体是旧版（${stale.detail}）。撤回仍能用，但同一会话里的第二次撤回会报 `
        + '"No provider revert token for message …"。',
      hint: `跑 node ${APPLY_SCRIPT} 重建（会从最新的干净备份重打）。`
        + "若它报 stale-patch-no-baseline，说明 ~/.paseo/local-patches/ 下的 plugin-provider.js.orig-* 已被清理，"
        + "重装 @getpaseo/cli 后重跑即可。",
    };
  }

  if (markers !== 0) {
    return {
      ...base,
      code: 2,
      state: "partially-patched",
      ok: false,
      autoPatchable: false,
      summary: `文件处于半打补丁状态（MARKER 计数 ${markers}，既不是 0 也不是 2）。撤回功能状态未知。`,
      hint: "重装 @getpaseo/cli，或用 ~/.paseo/local-patches/ 下的 plugin-provider.js.orig-* 备份覆盖后重跑 apply。",
    };
  }

  // Upstream may have fixed #4667 itself.  Checked BEFORE the anchor verdict:
  // when upstream implements its own truncation, ANCHOR_B usually no longer
  // matches either, and "anchor mismatch, needs manual work" would be the wrong
  // advice — the right advice is "delete this patch".
  const upstreamFix = detectUpstreamSelfFix(source);
  if (upstreamFix.fixed) {
    return {
      ...base,
      code: 4,
      state: "upstream-fixed-retire-patch",
      ok: false,
      autoPatchable: false,
      upstreamFixHits: upstreamFix.hits,
      upstreamFixSites: upstreamFix.sites,
      summary: `上游已自行修好撤回（revert() 里已经自己截断 history，命中 ${upstreamFix.hits} 处）：`
        + `${upstreamFix.sites.join(" / ")}。这个本地补丁已经多余，应当删掉。`,
      hint: "按 UPGRADE.md 第 5 节「什么时候可以彻底删掉补丁」执行。"
        + "注意：此检测只覆盖「在 revert() 里截断 history」这一种修法；"
        + "若上游改成发新事件类型或改 streamHistory()，本项检测不到（会退回正常打补丁）。",
    };
  }

  if (anchorA === 1 && anchorB === 1) {
    const adapted = targetMd5 !== BASE_MD5;
    return {
      ...base,
      code: 1,
      state: "patchable",
      ok: true,
      autoPatchable: true,
      upstreamChanged: adapted,
      summary: adapted
        ? `补丁不在位，但上游虽已变化（md5 ${targetMd5.slice(0, 8)}，≠基线 ${BASE_MD5.slice(0, 8)}）两个锚点仍各命中 1 次 —— 可以自动打上。`
        : "补丁不在位，但上游与已知基线一致，两个锚点各命中 1 次 —— 可以自动打上。",
      hint: `跑 node ${APPLY_SCRIPT} 即可（daemon 下次启动时 ExecStartPre 也会自动打）。`,
    };
  }

  return {
    ...base,
    code: 2,
    state: "anchor-mismatch",
    ok: false,
    autoPatchable: false,
    summary: `补丁不在位，且锚点失配：anchor A 命中 ${anchorA} 次、anchor B 命中 ${anchorB} 次（各需恰好 1 次）。撤回功能已降级：撤回后时间线不刷新，重开会话才看到消息消失（不会丢数据）。`,
    hint: `上游改动了插入点。核对 ${APPLY_SCRIPT} 里的 ANCHOR_A_RE / ANCHOR_B_RE：`
      + "grep 当前文件里的 `publish(event) {` 与 `await this.bridge.revert({`，按新形状改正则后重跑。",
  };
}

function humanReport(result) {
  const lines = [];
  lines.push(`[rewind-patch] target: ${result.target}`);
  if (result.targetMd5 !== null) {
    lines.push(
      `[rewind-patch] md5: ${result.targetMd5}`
      + `${result.matchesKnownBaseline ? " (== 已知基线)" : ` (≠ 已知基线 ${BASE_MD5}，仅作参考，不参与判定)`}`,
    );
    lines.push(`[rewind-patch] marker: ${result.markerCount}/2`);
    if (result.markerCount === 0) {
      lines.push(`[rewind-patch] anchor A: ${result.anchorA}/1   anchor B: ${result.anchorB}/1`);
    }
  }
  lines.push("");
  lines.push(`[rewind-patch] state: ${result.state}`);
  lines.push(`[rewind-patch] ${result.summary}`);
  lines.push(`[rewind-patch] 建议: ${result.hint}`);

  // Siblings are printed unconditionally: this is the "is the install healthy"
  // view, and a reader must not conclude "all good" from rewind alone.
  lines.push("");
  lines.push("[rewind-patch] 同文件姊妹补丁（不影响上面的 exit code）:");
  for (const sibling of result.siblings) {
    lines.push(`  ${sibling.ok ? "OK  " : "FAIL"} ${sibling.label}: ${sibling.detail}`);
  }
  const brokenSiblings = result.siblings.filter((s) => !s.ok);
  if (brokenSiblings.length > 0) {
    lines.push(
      `  ↑ ${brokenSiblings.map((s) => s.label).join(", ")} 不在位：跑 node ${APPLY_SCRIPT} 可自动补上。`
      + "（childRunning 缺失只影响「子代理第二次派发是否显示运行中」，不影响撤回。）",
    );
  }

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
  lines.push(`[rewind-patch] exit ${result.code}`);
  return lines.join("\n");
}

const result = { ...inspect(), siblings: siblingTargets() };

if (JSON_OUTPUT) {
  // Keep the shape stable: callers should branch on `code` / `state`, not prose.
  const { status, ...rest } = result;
  process.stdout.write(`${JSON.stringify({
    code: result.code,
    state: result.state,
    ok: result.ok,
    target: result.target,
    targetMd5: result.targetMd5,
    baseMd5: result.baseMd5,
    matchesKnownBaseline: result.matchesKnownBaseline ?? null,
    markerCount: result.markerCount,
    anchorA: result.anchorA,
    anchorB: result.anchorB,
    autoPatchable: result.autoPatchable,
    upstreamFixHits: result.upstreamFixHits ?? null,
    upstreamFixSites: result.upstreamFixSites ?? null,
    summary: result.summary,
    hint: result.hint,
    applyScript: APPLY_SCRIPT,
    lastRun: status.present ? (status.raw ?? { error: status.error }) : null,
    // Never let a rewind-only `code: 0` read as "whole install healthy".
    siblings: result.siblings.map(({ label, ok, state, markerCount, detail }) => ({
      label,
      ok,
      state,
      markerCount,
      detail,
    })),
    siblingsAllOk: result.siblings.every((sibling) => sibling.ok),
  }, null, 2)}\n`);
} else {
  process.stdout.write(`${humanReport(result)}\n`);
}

process.exit(result.code);
