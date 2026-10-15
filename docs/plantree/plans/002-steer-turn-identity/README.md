# P002：运行中发消息打断子代理

状态：已部署并机器验收通过。用户 App 实测仍被打断，取证归因为**客户端设置为 Interrupt**（非插件路径）；插件缺陷是「即使设为 Steer 也会退化回打断」的第二层原因，已修复。另增代码级硬保证：bridge 在 agent 作用域遮蔽委派工具、强制 `run_in_background: true`，子代理不再挂在父回合上，真机验证通过。提交／推送／PR 待授权。

## 用户目标
在 Paseo 中给正在运行（等待前台子代理）的 DSH 父会话发消息时，不应打断子代理；行为应与 DSH 自身一致（消息以 steer/排队方式进入父回合）。

## 现象与根因（源码级）
- Paseo App 默认 `sendBehavior: "steer"`，运行中发消息携带 `activeTurnBehavior: "steer"`。
- daemon 走 `steerOrReplaceActiveTurn` → `PluginProviderSession.steerActiveTurn()`，要求插件回 `result.type === "steer"` 且 `result.turnId === expectedTurnId` 才算接受。
- 本仓库 `paseo-plugin/server/session.ts` 的 `#emitPromptAccepted()` 对 steer 也回 `{type:"turn", turnId}`，于是 steer 被判 `unavailable`，回退 `replaceAdmittedForegroundTurn` → `cancelAgentRunBefore` → 插件 `interrupt()` → DSH `agent.cancel({kind:'user'})`：父回合被取消，前台子代理被 abort。
- 代码路径上，同一条消息会先被 `agent.steer()` 注入、再被替换回合重发一次（源码推断，未作为实测症状；用户观察到的重复是自行连发两次，不归因于此）。

## 范围与原则
- 只改插件侧回执语义，不改 Paseo 核心、不改 DSH。
- 修复需保持既有协议回归（子会话、上下文用量、plugin-check）全绿。
- 未获授权不 commit / push，不自动部署；部署与真机验证由主会话在复审通过后进行。

## 验收
- steer 在回合运行中被判 accepted：`result.type === "steer"`，`turnId` 与 `session.turn started` 的 `turnId` 一致。
- 无运行回合时不谎报 steer；普通 prompt 仍回 `{type:"turn"}`。
- 父会话 steer 不改变子会话状态与终态；消息只投递一次。
- 独立复核确认 daemon 契约与修复一致。

## 文件
- [路线图](roadmap.md)
- [根因与设计](design.md)
- [验收证据](evidence.md)
- [P001 子代理可见性](../001-session-visibility/README.md)
- [模块基线](../../baseline/README.md)
