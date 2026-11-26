# 推送前审查 — 后续待修项

> 本文件记录用户口头提出、**不属于** 27 个待推送提交审查结论的待修项，避免丢失。
> 记录时间：2026-11-26（用户报）。状态：待修。

## F-01 目标 pill 不实时显示运行动画

**用户描述**：现在的目标 pill 不能实时显示运行动画，点开（popover）才能看到运行中。**这个要修。**

**状态**：待修（审查收尾后处理；不影响本次推送审查结论）

**初步线索（未验证，仅定位入口）**：
- `paseo-plugin/client/goal-pill.tsx:16-17` 注释称 pill 只消费 `goal.snapshot` 订阅；`:95` 注释「The trigger's glyph and the popover re-render from this set when a poll lands」——glyph 靠轮询落地后重渲染。
- `paseo-plugin/client/goal-polling.ts` 轮询间隔为数秒（`goal-pill.tsx:455` 注释「A poll answers every few seconds」）。
- `paseo-plugin/client/goal-running.ts` 的 `useGoalRunningMark`（`goal-pill.tsx:67` 引入）提供运行中标记，需确认其数据源是否只在 popover 打开时推进。
- 服务端推送链路：`paseo-plugin/index.server.ts:213-215`（`goalSnapshot` → `goalFeed.subscribe`）。
- 待定位问题：运行动画/状态依赖的数据源在 pill 未展开时是由轮询驱动、订阅驱动，还是因 popover 打开产生的额外重渲染才更新；是本次 27 个提交引入还是既有缺陷（用户说的是「现在的」行为，需先做基线对比）。

**疑似根因方向（待验证）**：
1. 运行状态来自低频轮询（数秒一次）或仅在打开 popover 时触发的快照拉取，pill 自身的订阅不覆盖「运行中」这个维度；
2. `useGoalRunningMark` 的订阅/事件源只在 popover 挂载时建立；
3. pill 状态更新被 `useMemo`/浅比较短路，只有 popover 打开带来的父级重渲染才显示。

**验收标准（待与用户确认）**：不打开 popover 时，目标进入/离开运行中后 pill 应在可接受延迟内（事件驱动或 ≤1s 级）显示运行动画/状态。
