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
 *      实现体是旧版且**可原地重建**（`state: stale-body`）
 *   2  需要人工介入：锚点失配 / 文件处于半打补丁状态 / `host-fields-changed` /
 *      `upstream-history-shape-changed` / `revert-signature-changed` /
 *      `stale-body-unrebuildable`（后四者表示 apply 也会拒绝，不是“可自动打”）
 *   3  目标文件不存在 → paseo 可能没装，或安装路径变了
 *   4  上游已自行修好撤回（revert() 里自己截断 history）→ **补丁该退休了**，
 *      按 UPGRADE.md 第 5 节删掉，别让它继续滞留并刷假告警
 *
 * ⚠️ `1` 覆盖两种情形（"没打，可打" 与 "打了但是旧体"），二者的处置相同（跑 apply），
 *    但原因不同。**要区分请看 `state`，不要只看 exit code**：
 *    `state: patchable` vs `state: stale-body`。
 *    `--json` 里同样有 `state` 字段。
 *
 * ⚠️ `stale-body` 与 `stale-body-unrebuildable` 是**两个不同结论**：前者 apply 会原地
 *    重建，后者 apply 会 fail closed（例如 revert() 尾部有本补丁块之外的语句，
 *    `stale-patch-call-region-foreign`）。判定与 apply 共用同一个只读函数
 *    （`planRewindRebuild`），不是按“stale 就该重跑 apply”猜的。
 *
 * ⚠️ exit code 是 rewind 与姊妹补丁（`turnId`）合并后的结论（`combinedExitCode`）：
 *    rewind 非 0 时就是 rewind 的码；rewind 健康而 `turnId` 缺失/陈旧/半打时取它的严重度。
 *    `--json` 的 `code` 仍只代表 rewind，`exitCode` + `siblingsAllOk` 才是整机结论。
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
  MARKER,
  TARGET,
  TURNID_MARKER,
  TURNID_TARGET,
  countOccurrences,
  describeRevertSignature,
  detectUpstreamSelfFix,
  hostFieldShapes,
  matchAll,
  planRewindRebuild,
  revertSignature,
  rewindPatchStaleness,
  turnIdStaleness,
  upstreamHistoryObjectShape,
} from "./apply-rewind-history-truncation.mjs";

const HOME_DIR = process.env.REWIND_PATCH_HOME ?? dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = join(HOME_DIR, "rewind-patch.status.json");
const APPLY_SCRIPT = join(HOME_DIR, "apply-rewind-history-truncation.mjs");

const JSON_OUTPUT = process.argv.includes("--json");

const md5 = (text) => createHash("md5").update(text).digest("hex");

/**
 * The sibling targets that live in the same install as the rewind patch.
 * Reported here because this script is the human-facing health check: reporting
 * only rewind made the whole install look healthy while the other target was
 * missing, which is precisely the silent degradation this project keeps having
 * to dig out of logs.
 *
 * `turnId` is the only sibling left. It used to be `childRunning` too, but that
 * patch was retired once upstream getpaseo/paseo#8080 fixed the defect; a
 * checker that kept listing it would report a missing target on every healthy
 * install.
 *
 * These never change the exit code — rewind's verdict owns that, and callers
 * (UPGRADE.md, the startup hook notes) branch on it.  They are printed and
 * carried in `--json` so a reader cannot miss them.
 */
function siblingTargets() {
  const describeSibling = (label, file, marker, staleness, rebuildPlanner) => {
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
      // The sibling line must not promise "run apply to rebuild" for a body apply
      // will refuse — same LP-02 residual as the main verdict, same plan function.
      if (rebuildPlanner !== undefined) {
        const plan = rebuildPlanner(source);
        if (!plan.ok) {
          return {
            label,
            ok: false,
            state: "stale-body-unrebuildable",
            markerCount: markers,
            detail: `markers 2/2 but the body is old and apply cannot rebuild it (${plan.reason}) — reinstall @getpaseo/cli`,
          };
        }
      }
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
    describeSibling("rewind", TARGET, MARKER, rewindPatchStaleness, planRewindRebuild),
    describeSibling("turnId", TURNID_TARGET, TURNID_MARKER, turnIdStaleness),
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

  // The same #7675 guard `applyRewindPatch()` runs on BOTH paths, before it
  // looks at markers. Without it this checker calls the file "patched" /
  // "patchable" while apply is guaranteed to refuse — the upgrade-time silent
  // degradation LP-02 records. Checked here rather than in the `markers === 0`
  // branch only, because apply checks it on an already-patched file too.
  const historyShape = upstreamHistoryObjectShape(source);
  if (historyShape !== null) {
    return {
      ...base,
      code: 2,
      state: "upstream-history-shape-changed",
      ok: false,
      autoPatchable: false,
      upstreamHistoryShape: historyShape,
      summary: `上游把 PluginAgentSession.history 换成了对象（命中 \`${historyShape}\`，即 #7675 形状）：`
        + "注入的 truncateHistoryFrom() 会变成运行期 no-op（撤回看起来成功、时间线却保留被撤内容），"
        + "apply 会以 upstream-history-shape-changed 拒绝。",
      hint: "按 UPGRADE.md 第 5/6 节改写或退役这个补丁；不要直接跑 apply，它不会写文件。",
    };
  }

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
    // "stale" answers "is the body old"; it does **not** answer "would apply
    // rebuild it".  LP-02 residual: for a body apply must refuse (measured: a
    // foreign statement in `revert()`'s tail => `stale-patch-call-region-foreign`)
    // this branch used to say `autoPatchable: true` + "run apply to rebuild", and
    // the operator's next command exited 3 with nothing written.  The plan below
    // is the exact read-only code apply runs, so the two cannot disagree.
    const plan = planRewindRebuild(source);
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
          + "文件会保持原样（不会误删 revert() 里的其它语句），但旧体的已知缺陷仍在："
          + '同一会话里的第二次撤回会报 "No provider revert token for message …"。',
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
      summary: `补丁标记齐全但实现体是旧版（${stale.detail}）。撤回仍能用，但同一会话里的第二次撤回会报 `
        + '"No provider revert token for message …"。',
      hint: `跑 node ${APPLY_SCRIPT} 原地重建（不需要干净基线：只替换本补丁自己的方法体与 CALL，其它内容不动）。`,
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

  // The `revert()` signature is part of the contract too (LP-01): the injected
  // CALL reads `messageId` and `scope` by name.  Both anchors can still match
  // after a rename (`ANCHOR_B_RE` only spells out the call body), so without this
  // branch the checker says "patchable" for a file apply must refuse — and if
  // apply did write it, every rewind would throw ReferenceError inside the host.
  if (revertSignature(source) === null) {
    return {
      ...base,
      code: 2,
      state: "revert-signature-changed",
      ok: false,
      autoPatchable: false,
      revertSignatureFound: describeRevertSignature(source),
      summary: `补丁不在位，但 revert() 的签名已不是注入 CALL 依赖的形状：`
        + `期望 \`async revert(messageId, scope)\`，实际 ${describeRevertSignature(source)}。`
        + "CALL 按名字读这两个参数，apply 会以 revert-signature-changed 拒绝；"
        + "强行打上会让每次 conversation/both 撤回在宿主里抛 "
        + "`ReferenceError: messageId is not defined`（桥已撤回、时间线不刷新）。",
      hint: "按上游新参数名改写 CALL 与 revertSignature() 门禁后再跑 apply；不要直接跑 apply，它不会写文件。",
    };
  }

  // The fields the injected body dereferences, checked only on a clean file —
  // on a patched one the injected body itself contains these strings, so the
  // gate would always pass (same reasoning as `applyRewindPatch()`). Apply runs
  // it before it writes; without it here this branch says "patchable" for a
  // file apply will reject with host-fields-changed.
  const hostFields = hostFieldShapes(source);
  if (!hostFields.ok) {
    return {
      ...base,
      code: 2,
      state: "host-fields-changed",
      ok: false,
      autoPatchable: false,
      hostField: hostFields.field,
      hostFieldMissing: hostFields.missing,
      summary: `补丁不在位，但注入体依赖的字段已不是上游现在用的形状：${hostFields.field} 缺少 `
        + `${hostFields.missing.map((shape) => `\`${shape}\``).join(", ")}。apply 会以 host-fields-changed 拒绝，`
        + "强行打上会让每次撤回抛 TypeError，所以这里不能报“可自动打”。",
      hint: "上游重构了 translation cache / token 字段：按新形状改写 METHOD 与 hostFieldShapes 检查后再跑 apply。",
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

function humanReport(result, exitCode) {
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
  lines.push("[rewind-patch] 姊妹补丁（缺失会把 exit code 拉高，见下）:");
  for (const sibling of result.siblings) {
    lines.push(`  ${sibling.ok ? "OK  " : "FAIL"} ${sibling.label}: ${sibling.detail}`);
  }
  const brokenSiblings = result.siblings.filter((s) => !s.ok);
  if (brokenSiblings.length > 0) {
    lines.push(
      `  ↑ ${brokenSiblings.map((s) => s.label).join(", ")} 不在位：跑 node ${APPLY_SCRIPT} 可自动补上。`
      + "（turnId 缺失只影响「重开会话后长对话是否折叠轮次」，不影响撤回。）",
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
  // The printed exit code must be the one the process actually returns, or the
  // human view and the machine view disagree about the same run.
  lines.push(
    exitCode === result.code
      ? `[rewind-patch] exit ${exitCode}`
      : `[rewind-patch] exit ${exitCode} (rewind 自身 exit ${result.code}；被姊妹补丁拉高)`,
  );
  return lines.join("\n");
}

const result = { ...inspect(), siblings: siblingTargets() };

/**
 * Exit code for the whole install, not just rewind.
 *
 * This used to be rewind's verdict alone, with the siblings printed but
 * deliberately kept out of the exit code.  That made the one machine-readable
 * answer ("is this install healthy") say `0` for an install whose `turnId`
 * patch had been wiped — and `UPGRADE.md` tells the reader to branch on the
 * exit code, so the manual's own judgement was wrong.  A checker that cannot
 * go red for a missing patch is the false green this file exists to prevent.
 *
 * Precedence, so the existing meanings stay intact where they matter:
 *   1. rewind's own verdict wins whenever it is non-zero.  In particular `4`
 *      ("upstream fixed it, retire the patch") must keep reaching the caller
 *      unchanged — it is an instruction, not a failure.
 *   2. otherwise a broken sibling contributes its own severity, mapped onto the
 *      same scale: not-patched / stale-body => 1 (apply fixes it),
 *      stale-body-unrebuildable / half-patched => 2 (needs a human),
 *      target-missing => 3.
 *   3. all healthy => 0.
 *
 * `code` in `--json` stays rewind's verdict; the combined answer is
 * `exitCode` (+ `siblingsAllOk`), so an existing consumer that branches on
 * `code` keeps its old behaviour and can opt into the wider one.
 */
function combinedExitCode(rewindCode, siblings) {
  if (rewindCode !== 0) return rewindCode;
  const severity = {
    "not-patched": 1,
    "stale-body": 1,
    // A stale body apply cannot rebuild needs a reinstall, not another apply run:
    // same severity as half-patched (human action), not 1 ("apply will fix it").
    "stale-body-unrebuildable": 2,
    "half-patched": 2,
    "target-missing": 3,
  };
  let worst = 0;
  for (const sibling of siblings) {
    if (sibling.ok) continue;
    worst = Math.max(worst, severity[sibling.state] ?? 2);
  }
  return worst;
}

const exitCode = combinedExitCode(result.code, result.siblings);

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
    upstreamHistoryShape: result.upstreamHistoryShape ?? null,
    hostField: result.hostField ?? null,
    hostFieldMissing: result.hostFieldMissing ?? null,
    // LP-01 / LP-02 residual: name the shape that blocked the patch, so a
    // machine consumer can tell "apply will refuse" from "apply will rebuild".
    revertSignatureFound: result.revertSignatureFound ?? null,
    rebuildBlockedReason: result.rebuildBlockedReason ?? null,
    rebuildBlockedDetail: result.rebuildBlockedDetail ?? null,
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
    // The combined answer. `code` above is rewind's verdict only, kept for
    // backwards compatibility; this is what the process actually exits with.
    exitCode,
    exitCodeFrom: exitCode === result.code ? "rewind" : "sibling",
  }, null, 2)}\n`);
} else {
  process.stdout.write(`${humanReport(result, exitCode)}\n`);
}

process.exit(exitCode);
