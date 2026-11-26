# R P1-1 复审（console-theme）

状态: pass

## 判定

修复成立，可放行：`mono` 的加载期 `Platform.select` 已改为 `Platform.OS` 三分支，headless stub 下不再抛错，语义与导出契约不变，且无夹带改动。

## 独立验证

- `git diff -- paseo-plugin/client/console-theme.ts`：仅 `mono` 一块（删 `Platform.select`、改 `Platform.OS` 分支 + 注释），无其他改动。
- 根因定位：文件内顶层 RN 运行时调用只剩 `Platform.OS`（`PluginSurfaceProps`/`TextStyle` 均 `import type`，其余是纯字面量与函数定义），无其他 stub 不支持项；全仓 `grep -rn "Platform\.select" paseo-plugin/client paseo-plugin/shared` 仅命中注释，无实际调用残留。
- `node harness/pill-contribution-check.cjs` → `135 contribution checks passed`，exit 0（stub 为 `Platform: { OS: "web" }`，无 `select`；`jobs-pill`→`console-theme` 加载链被实际执行）。
- `cd paseo-plugin && npx tsc --noEmit` → exit 0。
- 反向验证：旧产物 `paseo-plugin/.dbg-offline-checks/client/console-theme.js:33` 仍含 `Platform.select`，同 stub 下加载抛 `TypeError: react_native_1.Platform.select is not a function`，与修复前门禁日志（`docs/PRE-PUSH-AUDIT-20261126/offline-full.log:1400-1405`，76/77）逐字一致；新产物 `.dbg-pill-contribution/client/console-theme.js:40` 为 `Platform.OS` 分支，加载成功。
- 语义逐平台实测（对构建产物注入 stub）：ios→`Menlo`、android→`monospace`、web/macos→`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`，与 `Platform.select` 的 ios/android/default 表等价；导出名 `mono`、类型 `string` 未变。
- 工作区状态核对：验收后 `git status --short` 仍为原有 4 个 M 文件 + docs 未跟踪目录，未产生额外写入。

## 问题（若有）

| 级别 | 位置 | 问题 | 证据 |
|---|---|---|---|
| — | — | 无 | P0/P1/P2/P3 均为 0 |

## 未验证项

- 未跑全量 `node harness/offline-checks.cjs`（任务约束：由 Lead 统一跑）；其会在重建 `.dbg-offline-checks` 后以 `PASEO_PLUGIN_BUILD` 复用本修复，重建路径为 `offline-checks.cjs`→`buildPlugin({dir:'.dbg-offline-checks'})`。
- `paseo-plugin/server/pricing.ts` 等工作区其他在途改动属他人写域，不在本单判定范围。

status: completed
