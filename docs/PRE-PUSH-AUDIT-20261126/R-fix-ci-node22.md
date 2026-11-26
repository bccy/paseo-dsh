# R CI 修复复审（diagnostics.test Node 22）
状态: pass

## 判定
修复成立：仅在测试 8 内加 1 个 ref'd `setInterval` 句柄（模拟真实挂起子进程的活动句柄）+ `t.after` 清理，最小改动；生产 `server/diagnostics.ts` 的 `.unref()` 语义未动（:432、:1035，文件未修改）。

## 独立验证
1. 工作区 diff 仅 `paseo-plugin/test/diagnostics.test.cjs` +8/-0；测试数 13=13、`assert.` 166=166（对比 HEAD），无删断言/跳测试/降强度；其余文件未改。
2. Node 22（v22.23.5，`.tmp-node22`）`node --test test/diagnostics.test.cjs`：13/13 pass、0 cancelled、exit 0，复跑 2 次均绿。
3. Node 24（v24.22.2）同文件：13/13 pass、0 cancelled、exit 0。
4. 独立变异（/tmp 镜像用 `git show HEAD:` 原版去掉 keepAlive，工作区零改动，sha256 `c3155d12…` 前后一致）：Node 22 exit 1、pass 7 / cancelled 6、目标测试 `not ok 8` `cancelledByParent`，与 CI 症状逐项吻合。
5. 清理验证（/tmp 探针）：泄漏的 ref'd interval 使 Node 22 `--test` 进程挂住（timeout 124），t.after 清理则 exit 0；断言失败与 per-test 超时路径 t.after 均执行。故本测试实跑 exit 0 即证明无 interval 泄漏，失败/超时路径也有清理。
6. 影响面：keepAlive 仅存活于测试 8 生命周期，同文件其余 12 条不受影响；测试意图保持为「模拟真实挂起子进程的活动句柄」，未规避 runner。

## 问题（若有）
P3-1（建议，不阻断，非本次修复引入的错误）：keepAlive 使事件循环全程活跃；若生产 timeout guard 回归（timer 不触发），该测试将从 Node 22 原先的快速 cancelled 退化为一直挂起，仅由 CI `timeout-minutes: 20` 兜底。建议给该 test 加 `{ timeout: 5000 }` 边界（当前 120ms 量级，余量充足）。本次修复本身未发现问题。

## 未验证项
- CI 实际 Node 22.x 小版本未定（本地 v22.23.5；`offline-checks.yml` 用 `node-version: 22` 浮动最新），同大版本内变异/修复已闭合。
- 未跑全量 `node harness/offline-checks.cjs`（按约束由 Lead 并行执行）；多测试文件共享同一 runner 进程时的事件循环交互未覆盖。
