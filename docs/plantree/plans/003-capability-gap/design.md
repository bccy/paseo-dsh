# P003 实现设计

基线：DSH 0.2.1-rc.5、Paseo 0.14.0。原设计的错误及裁决见 [review.md](review.md)。

## workflow 与 goal

`server/activity-timeline.ts` 由真实 `TimelineBuilder.consume()` 调用，产出既有的 `tool_call` + `plain_text`，不扩展宿主协议。字段取自 DSH 的 workflow/goal 契约；桥 `image-host-path.js` 的历史白名单同时保留这五类持久事件。

| 事件 | 状态规则 |
| --- | --- |
| `tool-workflow/run-start` | 按 runId 建行，重复 start 不清空成员或终态 |
| `tool-workflow/agent-start` | 按成员 seq 记录 label、phase、childId |
| `tool-workflow/agent-end` | 更新相同 seq 的 completed / failed / cancelled |
| `tool-workflow/run-end` | completed → completed，cancelled → canceled，error → failed |
| `goal/change` | version 1 全量快照覆盖；clear 使用 cleared 引用，固定 `goal:current` 行 |

workflow 以自己的 run-end 为终态依据，后台 job 可以在父回合结束后继续更新；只有已终止进程的残缺历史重放才收为 canceled。goal 的 active / paused / blocked / complete 是持久目标状态，行本身是已提交的快照，不能被工具运行态收尾取消。未知载荷进入可见 error 行并记录诊断。每个 session 使用独立 builder，身份由宿主按 session 隔离。

## 工具级审批

入口是 `approval/request` waterfall，`approval/asked` 与 `approval/decided` 是 DSH 自己写的审计事实。`lib/approval.js` 在 root context 注册，非本桥归属的会话调用 `next()`，不截走其他适配器的请求。

桥反向请求 `paseo/permission` 携带 sessionId、独立 requestId、toolName 和可选 callId/reason。插件检查真实会话归属和已协商的 permission 能力，发 Paseo 原生 `kind: "tool"` 卡片，actions 只有 Reject / Allow once。响应映射为 DSH 的 `rejected` / `allowed-once`，不构造“永久批准”策略。

桥组合回合 AbortSignal 与五分钟审批期限；取消发 `paseo/permission-cancelled`，用 sessionId + requestId 定位。插件恰好撤销一张卡，反向 RPC 返回明确错误；超时额外发 warning notice。晚到的批准不再命中等待者。连接退出与 session detach 也释放等待者。DSH 将不可用回答收为 `unavailable`，原生 `never` 策略在调用 answerer 之前拒绝。

这里没有与卡片一一对应的宿主 requestId，不能伪造一个 `request.failed` 给宿主；明确失败落在反向 JSON-RPC，UI 落在 resolved + timeout notice。原计划的字面要求据此修正。当前宿主的只读子会话通道不接审批卡，子会话请求明确失败且保持未批准，不冒充根会话决策。

## 会话级 systemPrompt

链路为 `ProviderSessionConfig.systemPrompt` → `DshSession` → `DshProcess` 的逐会话 initialize → 桥的 `sessionSystemPrompts`。

桥复用 DSH create/resume 的 `setup(agentCtx, agent)`，在真正的 agent scope 调 `SystemPrompt.section()`，不是自行创建另一个 scope。独立 section 放在 deployment persona suffix 后，`interpolate: false` 保留 `{{literal}}`，不覆盖 profile 人设。

初始化省略或清空字符串会移除上一任的自定义内容；已有 live agent 则立即替换对应注册。每个 session 保存精确 disposer，关闭、创建失败和 shutdown 时释放。非字符串或缺失服务明确报错。配置由 Paseo 每次 open 下发，不另写入 profile 或凭据文件。

## 通用投影读取

`paseo/projections { sessionId, keys?: string[] }` 只读现有会话，优先调用 `sessionController.projections()`。基础 profile 没有 controller 时复用它底层的 `sessions` / `sessionProjections` / `sessionPersistence` / `sessionQuery`；观察句柄在 finally 释放，不 create/resume agent。

结果保留上游三种语义：

- `{ kind: "sequenced", asOfSeq, values }` 是带日志序号的完整读取。
- `{ kind: "migration-required", values }` 仅是迁移前缓存提示，不伪造 asOfSeq。
- `null` 表示会话不存在。

不复用 contextPressure 缓存。显式 keys 必须存在，否则点名 unknown or unavailable；省略 keys 返回所有已注册投影。

**可用键取决于 profile 组合**：基础 profile 有 tokenUsage；sessionStats 来自 `dsh-session-stats`，agentPreset 来自 `dsh-agent-preset-registry`。读取接口不强行改变部署的 preset 或挂载 web-app。真机检查分别覆盖基础 profile 的缺键报错，以及显式挂载原生组件后的真实统计、preset、选择键与冷读取。
