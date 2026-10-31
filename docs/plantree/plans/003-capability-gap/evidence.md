# P003 验收证据

状态：**完成，2026-10-31**。五项 A 档已实现并逐项验收；B 档交付三个上游问题草稿。原会话中断没有被当作完成依据，恢复后重新检查了源码、进程、失败日志与真实输出。

## 环境与范围

- DSH **0.2.1-rc.5**，Paseo **0.14.0**，Node **22.23.1**；本地源码 doctor 全绿。
- 开工基线 HEAD `2b3bb3c`，完成核对时 HEAD `87b5e6e`；原有 jobs 工作由工作区保留，本任务不回退或覆盖它。P003 实现在当前工作树，未发布产物。
- P003 模型回合使用一次性 `DSH_HOME`，只复用已配置的路由与凭据。独立 UI 使用临时 daemon home、loopback 随机端口、同一 checkout 插件，未重启正式 daemon。
- 原始输出与源码 SHA-256 清单：`/tmp/p003-verification-20261031/`；核心结论与截图保留在本目录，避免仅依赖临时日志。

## 逐项验收

| 要求 | 当前证据 | 结果 |
| --- | --- | --- |
| workflow 四事件归并，成员/阶段/终态可见 | `p003-timeline-check.cjs` 8 组；真实模型运行 workflow，记录至少 start/member/end 四类更新，单一 callId；实际 UI 展开见 Verification / UI child | 通过 |
| 后台 workflow 跨回合正确 | 真实 run_in_background：父回合结束后状态仍 running；子任务完成后由自己的 run-end 变 completed，中间没有 canceled | 通过 |
| goal 全量覆盖、清除、再建、回合结束不误取消 | timeline 检查覆盖旧目标/阻塞原因清除；真实 create_goal/update_goal 更新单行；UI 仅一条 complete 目标状态 | 通过 |
| workflow/goal 重开不丢 | 真桥 history 白名单逐字保留；真实插件 close/reopen 重建同终态；临时宿主重载插件和 agent 后界面仍各一条状态行 | 通过 |
| 审批根归属、waterfall 下传、原生审计 | `p003-bridge-check.mjs` 10 组；`p003-approval-preflight.mjs` 真 DSH asked/decided 同一 id，结果 rejected | 通过 |
| 真实批准、拒绝和取消 | `p003-live-check.mjs` 分别验证 allowed-once/rejected；取消撤卡，原会话可继续；UI 点击 Allow once 后工具返回 allowed-once | 通过 |
| 超时、晚答、并发、关闭、退出、能力协商 | `p003-permission-check.cjs` 6 组，真实 DshProcess + DshSession：反向 RPC 明确失败，卡片恰好 resolved 一次；同 callId 不串台；无 permission 能力不发卡；进程退出不留等待者 | 通过 |
| never 策略不被插件绕过 | 真 DSH 切至自带 never 权限预设后自动 rejected，零反向审批请求 | 通过 |
| systemPrompt 真正进入模型上下文 | 随机标记仅放在 A 的 systemPrompt；A 返回标记与字面 `{{p003_literal}}`，B 返回 NONE | 通过 |
| scope 与 disposer 生命周期 | 真实 agent setup 注册；桥专项覆盖替换、清空、关闭、创建失败与兄弟 scope 保留；多会话与并发 open 回归通过 | 通过 |
| projections 正确且非激活式读取 | controller 原形/AbortSignal 透传；冷读释放 observation；保留 asOfSeq 与 migration-required/null；不存在会话返回 null，缺服务/键明确失败 | 通过 |
| 真实 tokenUsage/sessionStats/agentPreset | 临时 profile 显式挂原生 stats + preset registry，关闭会话后的冷读取返回真实轮/步计数与 preset，选键读取一致；基础 profile 对未注册键明确报错 | 通过 |
| B 档问题描述 | [三个可提交草稿](upstream-issues.md) 含当前源码依据、复现、影响、建议与验收；未对外提交 | 交付 |

## 回归结果

**29 个离线或假对端脚本全部 exit 0**。计数是本次输出，不是长期固定要求。

| 检查 | 结果 |
| --- | --- |
| p003-bridge / p003-timeline / p003-permission | 10 / 8 / 6 组通过 |
| timeline / image-host-path / bridge-assets | 208 / 42 / 2 |
| archived-lineage / bridge-server / dsh-api-contract | 12 / 25 / 12 |
| subagent / multi-session / concurrent-open | 90 / 35 / 8 |
| steer / mcp-injection / session-request | 25 / 40 / 21 |
| assistant-stream / assistant-retry / image | 7 / 8 / 8 |
| uploaded-file / process-crash / child-crash | 17 / 7 / 8 |
| replay-turn / context-usage | 全部通过，exit 0 |
| revert / surface / file-snapshot / rewind-merge | 115 / 18 / 56 / 49 |
| revert-shape / host-contract-sim | 10 / 7 |

**真实运行**：

| 检查 | 结果 |
| --- | --- |
| plugin-check | **34/34**；当前源码编译产物 |
| p003-live | 全部通过，含随机提示词隔离、审批、前后台 workflow、goal、重放与冷投影 |
| p003-approval-preflight | 审批审计 + never 策略 + 基础 profile 缺键通过 |
| archive-registry-check | **2/2**，无 initialize 的首帧到达真 registry |
| rewind-e2e / rewind-merge-e2e | **12/12**、**13/13** |
| replay-fidelity-probe | 对本次真实撤回日志 **4/4**，含 3 条人类消息与 1 条撤回标记；不是空日志跳过 |
| stream-probe | **5/5**，18 次实时快照，首 delta 早于持久消息，投影各一条 assistant/reasoning |
| TypeScript / bridge 资产 / diff | `tsc --noEmit`、生成后资产逐字节比对、`git diff --check` 均通过 |

初次脚本运行中的 CJS 路径错误已按脚本头部说明改用编译目录运行；一个首条统计行的错误假设也已按 [复核补充](review.md) 修正并复跑。未将这些失败记为通过。后台 workflow 的修正后，重新跑了 timeline、子会话、重放、流式相关回归和 plugin-check / P003 真机门。

## 真实界面

使用已安装的 Paseo 0.14.0 Web UI 和实际插件，Chromium 运行于本机。验收 agent 为临时实例内的 `0122f696-c817-44e4-9e2d-5c4f02e09d31`。

- 审批卡在 1440px 桌面和 390px 窄屏显示；从 UI 点击 Allow once，工具真实回传允许结果。
- 展开“查看轮次详情”后，断言精确 workflow 状态行与 goal 状态行各 **1 条**，没有把用户提问或模型总结当作状态行证据。
- 展开 workflow 后可见 **Verification / UI child**；深色桌面和浅色窄屏均可读，pageerror 为零。
- 重载临时插件并 reload agent 后重复同样断言，历史终态仍一致。
- 临时 daemon 已正常停止，整个临时 DSH_HOME 与凭据副本已清理。

[审批卡（窄屏）](screenshots/approval-mobile.png) · [workflow 与 goal（桌面）](screenshots/workflow-goal-desktop.png) · [workflow 与 goal（窄屏）](screenshots/workflow-goal-mobile.png)

这里验证的是浏览器窄屏布局，没有宣称运行过 iOS/Android 原生客户端。生产 daemon 的插件进程没有在本任务中重载；产物发布也不在本次交付范围。

## 复跑命令

```bash
node harness/dsh-api-contract-check.mjs
node paseo-plugin/scripts/generate-bridge-assets.mjs
node harness/bridge-assets-check.mjs
(cd paseo-plugin && npx tsc --noEmit)
node harness/p003-bridge-check.mjs
node harness/p003-timeline-check.cjs
node harness/p003-permission-check.cjs
node harness/p003-approval-preflight.mjs
node harness/p003-live-check.mjs
node paseo-plugin/bin/paseo-dsh.mjs doctor
```

`dsh` 必须在 PATH。最后两个 P003 .mjs 脚本使用真实模型；默认读取已配置 profile 的路由/凭据到一次性目录，不自造模型配置。完整 plugin-check 与旧式 CJS 回归需先编译并从产物目录运行：

```bash
node -e 'require("./harness/plugin-build.cjs").resolvePluginBuild(undefined, ".dbg-p003-acceptance")'
cp harness/plugin-check.cjs paseo-plugin/.dbg-p003-acceptance/
(cd paseo-plugin/.dbg-p003-acceptance && node plugin-check.cjs)
```

其他依赖 `./index.server.js` 或 `./server/` 的旧式 CJS 脚本同样复制到产物目录，假桥检查还需复制 `harness/fake-dsh-bridge.mjs`。结束后可删除该临时编译目录。新 P003 脚本的运行步骤写在各自头部，不应直接从 harness 目录运行旧式 plugin-check。
