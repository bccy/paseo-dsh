# F-01 goal pill 动画不同步 — 根因调查

状态: completed

## 根因（一句话）
team pill 的「运行中」是**被推送数据里的一等字段**（`teamPillIcon` 从 `team.snapshot` 的 `members[].running` 算出 `"running"`，再靠 `registration.update({icon})` 换图标组件，运行环随 RunningIcon 挂载）；goal pill 是仓库里**唯一**绕开数据层、在图标组件里用宿主 `useAgent(...).status` 旁路读运行状态的 pill——goal 快照本身没有 running 字段，注册去重也不比较图标（`goal-pill.tsx:458-464`），所以运行动画完全依赖宿主 hook 在 composer 图标里的活性；这条链路一旦不实时，pill 就只能在打开 popover 时由 phase 驱动的文字徽标「看到运行中」。

## team pill 的既有做法（可复用点，file:line）
- 运行位来自推送数据：`client/team-polling.ts:169-173` `teamPillIcon(team)`——`failed` > `complete` > `running`（任一 teammate `running === true`）> `idle`；数据是 `team.snapshot` 订阅（`client/team-pill.tsx:255-270`），服务端 `index.server.ts` team feed + `server/pill-feed.ts:50,56`（4s+jitter、仅变化才推）。
- 表达方式：4 个**模块级稳定图标组件** `client/team-pill.tsx:85-98`（`RunningIcon` 的 `running` 硬编码 true，`CornerRingIcon` 挂上角环），`:213` 的 `present` 比较 `visible/icon/label/title` 后 `:225` `entry.registration.update({icon: ICONS[icon]})`——**只在真变化时换图标**，注释 `:19-22/:212-219` 明说这样环不会每次轮询重启。
- 动画本体与 goal 完全相同：`client/corner-ring.tsx:64-77` → `client/status-ring.tsx:98-123`（Web Animations API，`useLayoutEffect` 里 `startTime=0` 共享时间线，首帧前已开始，原生走 `Animated.loop`）。**不涉及 CSS 注入**：`client/shimmer-css.ts` 只被文字行用（`text-shimmer.tsx`、`row-entrance.tsx`、`row-status-icon.tsx`、`console-theme.ts`、`tokens.ts`），pills 没有任何动态样式注入。
- 覆盖：`harness/team-pill-check.cjs:302-317` 钉住 `teamPillIcon` 真值表（含 running 环）；`harness/pill-contribution-check.cjs` 走真实 contribution + 录制 host 验证 update 语义。

## 数据流与断点（file:line）
- goal 的运行判定：`client/goal-pill.tsx:156-161` → `client/goal-running.tsx:29-63` → `client/goal-polling.ts:531-536`，必须 `active+armed` **且** `agentStatus==="running"`（idle 仅 1.5s hold，`:501`）。pill 常态外观对 `active+armed` 是 muted `Target`（`goal-polling.ts:174,88-104`），唯一动画是 9px 角环，只随 `useAgent` 的 running 出现。
- 数据层没有运行位：`shared/goal.ts` 的 `GoalState` 只有 phase/activation/rounds 等，没有"执行中"；pill 的 goal 订阅只推 goal 快照（`goal-pill.tsx:503-515`；`index.server.ts:213-215`、`server/pill-feed.ts:50,56`），与 popover 开不开无关，popover 打开也无 RPC/刷新副作用（`:239-250`，`goal-popover.tsx` 无 mount RPC）。
- 状态其实已经到达 goal pill：agent 目录订阅的 upsert 会带 `status` 并调用 `updateAgent`（`client/agent-subscriptions.ts:159-160`、`register()` 内 `host.updateAgent(agent)`），但 goal 明确丢弃（`goal-pill.tsx:573-581` 只处理 seen，注释还强调 status 不是 seen 信号）。
- 注册去重不含图标：`goal-pill.tsx:458-464` 只比 `visible/label/title`——即使数据层有了 running，也**没有通道**把它换成图标（对比 team `:225`）。
- popover 的「运行中」是另一信号：`goal-popover.tsx:130-136` `goalPillTone` 对 active+armed 直接返回 running，`:138-167` 的 `GoalStatusRow` 徽标用 `goalStateName` 印「目标进行中」（文字规则 `goal-polling.ts:215-221`），与 agent 是否在跑无关。
- 文档与实现不符：`docs/GOAL.md:199` 称 agent 状态来自 pill 已有的 `agents.list({subscribe})` 快照/upsert 且只用于运行环——实现早已改成 `useAgent` 旁路（`goal-running.tsx:6,17`），这正是该 pill 与 team 模式脱节的痕迹。
- 门禁盲区：`harness/goal-popover-render-check.cjs:99` 把 `useAgent` 钉死 `"idle"`（`:1273-1279` 只挂 idle 图标）；`harness/pill-contribution-check.cjs:20` 把 `useAgent` 桩成 `undefined`。goal 的运行环接线在两条离线门禁里都是零覆盖（team 的等价路径有断言）。

## 归属（本次引入 / 既有）+ 依据
**既有缺陷**，非 27 个待推送提交引入：27 提交范围内 `goal-pill.tsx`/`goal-running.tsx`/`goal-polling.ts`/`agent-subscriptions.ts`/`server/pill-feed.ts` 的 diff 为空（`git diff --stat origin/main..HEAD -- …`）；运行环初版在 bb1b3e0（2026-11-03，`useAgent` 当时就有），`goal-running.tsx` 末次改动 2ec8112 均已在 origin/main 历史。27 提交里只有 95398a5 改了 `goal-popover.tsx`（+286/−112），新增的「目标进行中」状态徽标让 pill 与 popover 的差异第一次显眼。

## 最小修法（复用 team 模式，含 file:line）
推荐（不改服务端）：把运行位搬进 goal 的数据层，让它像 team 一样由 contribution 层决定图标。
1. `client/goal-pill.tsx:88-97` `AgentGoal` 增加 `agentStatus?: GoalAgentStatus`；`addAgent`（`:528-572`）用 `agent.status` 播种。
2. `client/goal-pill.tsx:573-581` `updateAgent`：目录 upsert 的 `status` 变化时写 store 并通知 listeners（复用 `publish`，无需等下一次 goal feed），顺带 `present` 保持可见性语义不变。
3. `client/goal-pill.tsx:140-178` 图标：从 store listener 拿 `agentStatus` 传给 `useGoalRunningMark`（`goal-running.tsx` 只剩 hold 逻辑；删掉 `:17,65-66` 的 `useAgent` 引用与再导出）。
4. `client/goal-pill.tsx:222-250,306-307` popover 同样从 store 取 status——与图标同源，恢复"鲸鱼与 pill 一起转"的原始设计（`:304-305` 注释）。
5. 若想完全照 team：`registration.update({icon: <GoalRunningIcon/…>})` 换图标（`team-pill.tsx:225` 模式）并在更新前按 `visible/icon/label/title` 去重（`team-pill.tsx:222-225`）；goal 的 5 种 tone×running 组合用 store 驱动重绘更简单，二者都以"数据层→contribution→图标"为准。
6. 文档：更正 `docs/GOAL.md:199` 与运行环段（`:116,125-132`）。

## 首帧注入时序（按 team 结论：不适用 CSS 方案，但要防重挂载）
team 与 goal 的环都走 `StatusRingMark` 的 WAAPI（`status-ring.tsx:112-123`，`useLayoutEffect` + `startTime=0`），不存在"effect 里注入 CSS 导致首帧无动画"的坑；真正要防的是**每次轮询都换图标/重挂载导致动画重启**——team 用 `:220-225` 的去重挡住。goal 若改为 store 驱动，`running` 布尔未变时 React 保持 `StatusRingMark` 挂载，不会重启；若改图标切换方案，必须照 `:220-225` 去重。

## 验收方法（可自动化优先）
- 离线：`harness/goal-popover-render-check.cjs` 去掉 `:99` 的 `useAgent` 桩，改为直接构造带 `agentStatus` 的 goal store：断言 active+armed + `running` → `[data-testid="pill-corner-ring"]` 出现、`idle` → 消失、paused/disarmed/complete → 不出现；并在脚本里模拟一次 status-only 变化，断言环不重启（沿用 team 的"不重启"口径）。
- 离线（2）：`harness/pill-contribution-check.cjs` 增一条：goal 已 active+armed 时做一次 `status`-only 的目录 upsert，断言 contribution 层产生了 repaint（update 或 store 通知），当前实现会失败——这就是本缺陷的判别用例。
- 真机：新会话建目标后**不打开 popover**，pill 连续转环；/goal pause → 环停；重开会话（disarmed）→ 不转；打开 popover 不改变 pill。**需真机**。

## 风险
- 不加轮询：复用已有 agents.list 订阅 push（4s 级）+ goal feed，无新 timer。改为 store 驱动后与 team 同构，副作用面最小。
- 动画闪烁：遵守 team 的去重（`team-pill.tsx:222-225`）即可；state 驱动重绘不会重挂载环。
- 其他 pill 不受影响：`useGoalRunningMark`/`goalRunningMark` 仅 goal-pill 调用；team/jobs 图标逻辑不共享。服务端不需要改（若以后想把"执行中"也放进 goal 契约，才需要 bridge/feed 变更）。
- 语义：环仍按 agent 真实执行态转（不改成"armed 就转"），只是把数据源从宿主 hook 换成 pill 已有的 upsert——与 team 一致，不引入新的静默降级。

## 未验证项
1. （高）Paseo 侧 agent 状态在 DSH goal 轮次期间是否真的变 `running` 并经 `useAgent` 到达 pill：host 0.17.4 源码支持自治回合（`~/apps/paseo-sync-0174/packages/server/src/server/agent/agent-manager.ts:5788-5828` 置 lifecycle=running+emitState），插件把桥的 `session.status` 翻成 `session.turn started`（`paseo-plugin/server/session.ts:3185-3239`；桥 `dsh-bridge/lib/server.js:962-966`），但真机未测、离线门禁把 `useAgent` 钉死。无论结论如何，改用 team 式数据层来源都能修好 pill（且能顺带证明/证伪该链路）。
2. （中）「打开 popover 才看到」是否部分来自宿主父级重渲染：打开 popover 会改 `pluginButtonStore` 的 `entry.open` 使 composer pill 树重渲染一次，可能让卡住的 `useAgent` 读数补刷。属现象解释，未离线复现。
3. （低）报障环境版本：daemon 日志 0.17.3→0.17.4，11-25 05:28 有"旧桥不答 paseo/jobs、须 reload"记录（11:22 重写 24 个桥文件），不能排除当时跑过旧桥。

status: completed
