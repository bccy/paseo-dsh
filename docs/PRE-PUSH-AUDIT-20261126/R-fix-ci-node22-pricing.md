# R CI 修复复审（pricing.test Node 22）
状态: pass

## 判定
修复成立：仅在 test 17 开头加 1 个 ref'd `setInterval` 活动句柄 + `t.after` 清理（+10/-0），模拟真实 daemon 保持事件循环；生产 `server/pricing.ts:341/:647` 的 `.unref()` 未动（文件未修改），未降断言强度。

## 独立验证
1. diff 仅 `paseo-plugin/test/pricing.test.cjs` +10/-0；测试数 25=25、`assert.` 416=416（对比 HEAD），无 skip/only/force-exit；`server/pricing.ts`、`server/diagnostics.ts` 均未改。
2. Node 22（v22.23.5）`node --test test/pricing.test.cjs`：25/25 pass、0 cancelled、exit 0，复跑 2 次均绿；Node 24（v24.22.2）：25/25、0 cancelled、exit 0。
3. 独立变异（/tmp 镜像用 `git show HEAD:` 原版去掉 keepAlive，工作区零改动，sha256 `a993cd85…` 前后一致）：Node 22 exit 1、pass 16 / cancelled 9，test 17–25 全部 not ok —— 与 CI 症状（pass 16 / cancelled 9）逐项吻合，根因点确为 test 17。
4. 隔离验证（HEAD 原版，Node 22，`--test-name-pattern`）：test 17 单独 cancelled(1) exit 1；test 18（15ms auto-sync 场景，内部有 ref'd `setTimeout(60)` 等待）单独 pass exit 0 —— 实现者「test 18 无需改」成立；test 19–25 单独 7/7 pass exit 0 —— 无其他仅靠 unref timer 的挂起点。
5. 清理验证（/tmp 探针）：泄漏 ref'd interval 使 Node 22 `--test` 挂住（timeout 124），t.after 清理则 exit 0；失败/超时路径 t.after 均执行（同任务链 diagnostics 复审已实测）。本文件实跑 exit 0 即证明无 interval 泄漏。
6. CI 配置：`offline-checks.yml` node-version: 22、timeout-minutes: 20；本文件已登记 `harness/offline-checks.cjs:54`。

## 问题（若有）
P3-1（建议，不阻断，非本次修复引入）：keepAlive 使事件循环全程活跃；若生产 sync 超时 timer 回归不触发，test 17 会从 Node 22 原先的快速 cancelled 退化为一直挂起，仅由 CI `timeout-minutes: 20` 兜底。建议给该 test 加 `{ timeout: 10000 }` 边界（当前完整文件仅 ~1.2s，余量充足）。修复本身未发现问题。

## 未验证项
- CI 实际 Node 22.x 小版本未定（本地 v22.23.5；工作流 `node-version: 22` 浮动最新），同大版本内变异/修复已闭合。
- 未跑全量 `node harness/offline-checks.cjs`（按约束由 Lead 并行执行）；多测试文件共享同一 runner 进程时的事件循环交互未覆盖。
