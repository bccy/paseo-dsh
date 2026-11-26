# K 服务端 timeline/session 审查报告

状态: completed
范围: `git diff origin/main..HEAD` 中 `paseo-plugin/server/timeline.ts`（+612）、`paseo-plugin/server/session.ts`（+382）、`harness/timeline-kind-check.cjs`（±27），兼核对 `shared/subagent-card.ts`、`shared/subagent-live.ts` 契约与 DSH 0.2.2-rc.5 / @getpaseo/plugin 0.17.3 上游形状。只读审查，未跑构建/测试。

## 摘要

- **无 P0/P1**：时间线 item 形状、metadata 透传、去重、冷重开 settle 均有可验证依据。
- 事件形状对齐宿主：`toolCallBaseShape.metadata = z.record(z.string(), z.json())` 透传任意 JSON（`@getpaseo/plugin/dist/server/provider.js:128,673`），`detail` 被 `.strip()`；新点仅走 `item.metadata.dshSubagent`，未自造 detail 字段。宿主 `ProviderEventSchema.parse` 由 `test/subagent-card.test.cjs:24` 覆盖。
- 去重正确：`assistant/message` 在 DSH 事件形状中恒带 `{turn, step, usage?}`（dsh-session `SessionEventMap`），按 `${turn}:${step}` 用 Map/Set 覆盖是幂等而非丢弃真实增量；fork 继承前缀与 live 重叠均不重复计数。
- 冷重开 settle 判据**不会误 settle 活子代理**：`session.ts:2199` 的 `extracted.status===undefined && !#joinedLiveProcess && !announcedLive` 与既有 `DshChildSession.replay()` 的 cold-start 证明（`session.ts:2343-2352, 4827-4851`）同构；`reused:true` 保持 `"running"`，两分支均有测试夹具（test:1101/1430）。
- 错误路径未见新静默吞错：未知事件仍走既有 default→`[]`；预取是 best-effort 增强，权威错误仍由 `replaySubagents()` 发用户可见 notice（`session.ts:2312-2342`）。
- **harness 判据未被放宽**：`timeline-kind-check.cjs:98-100` 的「4 个 kind 精确匹配 + 无效 kind 负向变异」原样保留；改动只是跟随 client 新模块补 stub（导出名逐个核对与真实模块一致），并把过期 mock `DISPLAY_SETTINGS_ID='dsh-display'` 对齐真实值 `timeline-style`（`client/settings-screen.tsx:45`，origin/main 已是新值）。
- 提交前卫生干净：三文件 diff 无 provider/模型 id/base URL/密钥/本机路径、无 TODO/console 残留；`7ddff5c` 的 stream-stats revert 干净（`client/stream-stats.tsx` 与 origin/main 无差异，服务端 stream-stats 本批未改）。

## 问题

| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P2 | `paseo-plugin/server/session.ts:4457-4458` | 从 `subagent/descriptor` 读不存在的 `agentPreset` 字段 → 默认预设的子代理卡片「预设」副标题静默缺失（仅参数显式带 `agent_preset` 时才显示） | `if (typeof data.agentPreset === "string" …) this.#telemetryPreset = …`；DSH 0.2.2-rc.5 descriptor 字段集为 `version/mode/provider/label(+agentProvider/agentModel/agentReasoningEffort/persona/toolFilter)`，无 agentPreset（`dsh-subagent/lib/types/descriptor.js:38-52`）；预设实际写在子会话 `agent-preset/selected` 事件 | 改从 `agent-preset/selected`（own suffix）读取，或由 catalog/settlement 补；同步修正 `shared/subagent-card.ts:70` 注释声称的来源 |
| P3 | `paseo-plugin/server/timeline.ts:1170` | catalog v3 的 `mode:"external"` 被丢弃 | `data.mode === "continuable" \|\| data.mode === "one-shot" ? data.mode : prev?.mode`；上游 v3 只有 `continuable \| external`，`establishExternalCatalogChild` 写 `mode:"external"`（`dsh-subagent/lib/index.js:951-960`）。当前 client 不渲染 mode，暂无用户可见代价 | 收下 external 并扩展 `SubagentMode`（或单独标注取值为 catalog mode），避免未来 UI 加 mode 时外部子代理缺块 |
| P3 | `paseo-plugin/server/session.ts:2152-2215`（预算 :322） | 预取为每个子代理调 `process.history`，随后 `replaySubagents()` 对同一 child 再读一次；冷开最坏额外 +1.5s（`SUBAGENT_TELEMETRY_REPLAY_BUDGET_MS`） | `const history = await Promise.race([process.history(childId), …])` 与 `session.ts:2313` 的 `history = await process.history(row.sessionId)` 重复；预算注释允许部分 child 无遥测（字段省略不伪造） | 缓存本次 history 结果供 replaySubagents 复用（同一次 open 内），或改为 replay 后按需增量补齐 telemetry |
| P3 | `paseo-plugin/shared/subagent-card.ts:439`、`paseo-plugin/server/session.ts:4485` | fork 子代理 seed 的 `turn/end {kind:'forked'}` 被映射为 `failed` | `mapSubagentStopReason(data.reason) ?? "failed"`；DSH `buildForkSeed` 把 synthetic forked closers 追加在 inherited 前缀之外（`dsh-session/lib/index.js:971-979`），故会出现于 own suffix；既有 `childTurnState`（session.ts:5135）同样把 forked 归 failed，属既有行为延续 | 若 fork 子代理实际使用面存在：把 `forked` 视为「继承段边界已关闭」而非失败终态；否则至少在注释标注与既有映射的关系 |

## 未验证项

1. **宿主 `timeline-projection.js` 的同回合原地合并/跨回合追加行为**（置信度中）：仓库内无宿主源码，`@getpaseo/plugin@0.17.3` 不含 projection 实现；同回合门控（`session.ts:4053-4054`）与 `dsh.subagent.live` 订阅均基于该断言。验证：真机让子代理跨回合 settle，观察时间线是否出现重复 `tool_call` 行。
2. **Paseo `history: replay` 等待超时是否会被 1.5s 预取预算触发**（置信度中）：验证含 10+ 子代理的会话冷开计时；超时阈值需查宿主 daemon 源码/真机日志。
3. **`subagent_fork` 工具在 DSH 0.2.2-rc.5 未出现**（仅 client UI 与 prompt 文本提及）：兼容分支真实使用面未验证，相关映射以防御性代码对待。
4. **external 子代理（catalog v3 `mode:"external"`）是否会在本插件 profile 下产生**（置信度低）：需配置 external subagent provider；产生时其卡片是否缺 mode 之外还缺 child log 遥测未验证。
5. **真机卡片状态与遥测显示**（未跑真机）：`steps/durationMs/outputTokens` 来源为 child 侧 own-suffix 事件，与 Paseo UI 的最终显示未做真机对照。
6. `metaNonNegativeInt(tracked.resultMeta, "steps"/"outputTokens")` 与 `durationMs` 路径在本安装中为死路径（`dsh-tool-subagent` 的 presentationMeta 只返回 `{kind,name}`），无害的防御性代码，未列为问题。
