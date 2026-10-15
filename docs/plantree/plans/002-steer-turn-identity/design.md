# 根因与设计

## 链路（Paseo 0.11.2）
1. 客户端：默认 `sendBehavior: "steer"`（设置项 `interrupt | steer | queue`；`queue` 在客户端本地排队）。
2. daemon `agent-prompt.js`：`activeTurnBehavior === "steer"` 时走 `agentManager.steerOrReplaceActiveTurn()`，否则 `replaceAgentRun`。
3. `agent-manager.js`：`steerOrReplaceActiveTurn` 以 `expectedTurnId = activeForegroundTurnId ?? activeTurnId` 调用 `session.steerActiveTurn()`；`accepted` → 完成；`unavailable` → `replaceAdmittedForegroundTurn` → `cancelAgentRunBefore` → 取消当前回合并重发。
4. `plugin-provider.js`：`steerActiveTurn()` 调 `bridge.prompt({delivery:"steer"})`，仅当返回 `result.type === "steer" && result.turnId === expectedTurnId` 才 `accepted`。
5. `bridge.prompt()` 返回 `session.prompt_result` 事件的 `result` 字段。
6. 本仓库 `paseo-plugin/server/session.ts`：`#emitPromptAccepted()` 恒发 `{type:"turn", turnId}`。
7. `expectedTurnId` 来源：`agent.activeTurnId` ← daemon 的 `turn_started` 事件 ← 插件 `session.turn started` 的 `turnId`（即 `#turnId`）。

## 结论
steer 必然被判 `unavailable`，必然回退为取消当前回合；前台子代理因绑定父回合的 abort signal 而被取消。这解释了「Paseo 里发消息打断子代理，DSH 自身不会」。

## 修复
- `delivery === "steer"` 且 `#turnId !== null` 时回 `{type:"steer", turnId: #turnId}`。
- 否则维持 `{type:"turn", turnId}`（无运行回合时不谎报 steer）。
- steer 路径不触发任何 cancel/interrupt；命令路径 `{type:"completed"}` 不变。

## 未验证的推断
- 当前缺陷路径上同一消息会被注入一次、再被替换回合重发一次。此点为源码推断，非用户实测症状（用户观察到的重复来自自行连发两次），修复后该路径消失。
