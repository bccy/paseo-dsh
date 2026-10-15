# 路线图

## Done
- T201：定位根因——插件把 steer 回执谎报为 `turn`，触发 Paseo 的替换/取消回退，从而打断前台子代理。
- T202：独立复核确认根因与 daemon 契约，并修正关键点——`expectedTurnId` 来自首次 `prompt_result.turnId`（见 [验收证据](evidence.md)）。
- T203：定点修复 `session.ts`（steer 回执 + `#openTurnId` 预发 turnId）并补确定性回归；`tsc` 0 错，subagent-check 37/37、context-usage 8/8、steer-check 17/17。
- T203b：真实 daemon「before」复现成功（3/3）：steer 未注入运行中回合、前台子代理被 canceled、父回合被替换（见 [验收证据](evidence.md)）。
- T204：独立审查通过（无阻断／重要项），次要项已收尾（测试前提标注、`FIELD-NOTES` 第 22 条、窄边界备案）。
- T204b：部署——2026-10-15T04:20:01Z 重载插件，daemon 未重启，profile 未改动。
- T205：真实 daemon「after」对照 3/3 通过：`activeTurnId` 不变、无新 `turn_started`、子代理 completed、父正常消费 steer。
- T206：核实"子代理默认后台"路线——profile 已是 `backgroundMode: continuable`，DSH 无强制后台配置；改以 `~/.dsh/AGENTS.md` 指令影响模型选择。真实 daemon A/B：无规则+依赖结果的提示词 → `run_in_background: false` → interrupt 后子代理 canceled；有规则同提示词 → 省略参数（continuable）→ interrupt 后子代理 completed（见 [验收证据](evidence.md)）。
- T207：规则被证明不稳（改措辞后模型仍传 `false`），改为代码级硬保证：`dsh-bridge/lib/server.js` 在 agent 作用域遮蔽 `subagent` / `subagent_fork`，强制 `run_in_background: true`；内嵌桥重生成、插件重载。真机验证：模型传 `false` 仍被改写成 continuable，interrupt 后子代理 completed。`tsc` 0 错。

## In Progress
- 用户在 App 内实测（可在设置里保持 Interrupt，子代理现在不会被子代理之外的取消波及）。

## Next
- 按用户授权处理提交／推送／PR。
- 观察 `~/.dsh/AGENTS.md` 规则在真实使用中的稳定性（软约束）。

## Deferred
- 提交／推送／PR 更新，等待用户授权。
- 若 Paseo 客户端设置被手动改为 `interrupt`，需在设置中改回 `steer` 或 `queue`（客户端行为，不在插件范围）。
- 硬性保证"前台子代理不被父回合取消"需要改 DSH 语义（写 DSH 插件改 `resolveDelegationRun` 或前台信号绑定），当前不做。
