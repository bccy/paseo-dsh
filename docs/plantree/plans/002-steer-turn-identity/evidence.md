# 验收证据

## 独立复核（只读调研员，源码级）
结论与主会话判断一致，并补充/修正了两点：

| 事实 | 证据 |
| --- | --- |
| 协议只有 `interrupt`/`steer`；`queue` 仅是客户端本地排队 | `@getpaseo/protocol/dist/messages.js:975`；web-ui bundle `sendBehavior` 枚举与 `queueComposerMessage` |
| App（web-ui/桌面）默认 `sendBehavior:"steer"`，旧值 `interrupt` 会被一次性迁移为 `steer`；有 pendingPermission 时 `queue`→`interrupt` | bundle 默认值/schema/migration/`resolveActiveSendBehavior` |
| CLI 不带该字段 → daemon 缺省 `interrupt` | `client/dist/daemon-client.js:2118`、`daemon-client.d.ts:151`；`cli/dist/commands/agent/send.js:142` |
| daemon 缺省也是 `interrupt` | `server/dist/server/server/session.js:6172` |
| steer 被判 `unavailable` 后**必然**取消正在运行的回合 | `agent-prompt.js:5-17`、`agent-manager.js:1835/1904-1917/1788-1811/2111` |
| 插件回执判定 | `agent/plugin-provider.js:922-934`（要求 `result.type==="steer" && result.turnId===expectedTurnId`） |
| 回执来源是插件 `session.prompt_result.result` | `plugin-provider.js:467-489`、`:576-580` |
| **`expectedTurnId` 来自首次 `session.startTurn()` 返回值（= 首次 prompt_result 的 turnId），不是 `session.turn` 事件 id** | `agent-manager.js:1592-1601/1669-1670/1773-1776`、`plugin-provider.js:905-917`、`onStreamTurnStarted` 抑制 |
| DSH `steer` 不打断；`cancel` 清空 inbox 并 abort 回合信号 | `dsh-agent-loop/lib/index.js:806-821` |
| 前台子代理把回合 abort signal 作为 `exec.signal`，父级 cancel 会 `child.cancel({kind:"parent"})` | `dsh-tool-subagent/lib/index.js:559`、`dsh-subagent-in-process-driver/lib/index.js:195-201` |

复核还指出：后台子代理用独立 AbortController，父级 user-cancel 不 abort 后台任务；`continuable` 分支用 `exec.signal`，会受影响（代码判断，未实测）。

## 实现（未提交）
- `paseo-plugin/server/session.ts`：`#emitPromptAccepted(clientMessageId, delivery)`；steer 且有运行回合回 `{type:"steer", turnId:#turnId}`；新增 `#openTurnId()` 在开启新回合前预发 id，使首次 `prompt_result.turnId` 与随后 `session.turn started` 按构造一致；prompt 失败复位。
- `harness/fake-dsh-bridge.mjs`：新增 `steer` / `late` / `failonce` 模式（`late` 复刻「响应先于状态」）。
- `harness/steer-check.cjs`：17 项，在测试内重放 daemon 的 steer 准入契约（判 unavailable 会真的发 `session.interrupt` 并重发）。

## 回归结果（实现者自报，待审查确认）
- `npx tsc --noEmit`：EXIT 0。
- `harness/subagent-check.cjs`：37/37。
- `harness/context-usage-check.cjs`：8/8。
- `harness/steer-check.cjs`：17/17。

## 独立审查
进行中（reviewer `650590ce-ad8c-4910-9ee5-633f5da7cbb8`）。

## 真实 daemon「before」复现（未修复插件，3/3）
驱动 `/tmp/opencode/paseo-dsh-subagents/acceptance/steer-live.mjs`（DaemonClient → `ws://127.0.0.1:6767/ws`，createAgent → 等「父 running 且 listProviderSubagents 有 1 个 running 子代理」→ `sendAgentMessage(..., {activeTurnBehavior:"steer"})`）。

| run | 窗口 activeTurnId | steer 后 | 子代理终态 | marker 命中（实时流旧口径，见更正） |
| --- | --- | --- | --- | --- |
| before-121315（canonical） | `turn:1792037598399` | `turn:1792037601413`（换新回合） | **canceled** | **2**（跨两回合） |
| before2-121210 | `turn:1792037533083` | `turn:1792037539746` | **canceled** | **2** |
| before-121111 | `turn:1792037474320` | `turn:1792037476614` | **canceled** | 0（该次字段取错，旁证） |

三要素同时成立，即缺陷指纹：steer 未注入运行中回合（反而开了新回合）、前台子代理被打断、父回合被替换。

原始证据：`steer-live.before-121315.jsonl` / `.summary.json` / `steer-live.before.md`。

> 更正（测试员自查 + 主会话核对原始时间线）：持久化时间线中 marker 的 `user_message` 始终只有 1 条；早先报告的「出现 2 次」是实时流乐观回显与模型复述混入的计数口径错误。**「消息重复投递」不作为结论**，未经证实。before/after 的判据是 `activeTurnId` 是否变化、是否新增 `turn_started`、子代理终态。

## 本轮观察到的其它事实（未归因，另案）
- 被打断的原回合被插件上报为 `turn_completed`，没有 `turn_canceled`（`turn_canceled: []`）。
- 对这三个测试会话，`fetchProviderSubagentTimeline` 返回 0 行（`error: null`）；P001 验收时同一路径曾取到 4 行。

## 独立审查（reviewer `650590ce`，只读 max）
结论：**无阻断、无重要问题**；修复在真实调用链上成立且充分。

审查确认（源码级）：
- `expectedTurnId` 确为首次 `prompt_result` 的 turnId（`agent-manager.js:1655-1670`）。
- id 一旦失配，后果是该前台 run 永不 settle（`provider-runner.js` 按 turnId 过滤），而非「误 steer」——所以 id 一致性断言打在正确位置。
- daemon 会抑制同 id 的重复 `turn_started`（`agent-manager.js:1691-1697`、`:2959`、`:3240-3255`）。
- 真实 DSH 时序是 running 状态**先于** prompt 回复（`dsh-agent-loop` 同步 `setPhase`/`emit`；桥先写 notification 再写 reply）→ `#openTurnId` 预发属**防御性**，非必需但无害。
- 内嵌 `bridge-assets.ts` 与 `dsh-bridge/` 逐字节一致，无陈旧资源回归。
- command 路径 `{type:"completed"}` 无需 `#openTurnId`，正确；子会话事件走独立通道，不影响 P001。
- 回归可信度：删掉 steer 分支会让 steer-check 多项 FAIL；`failonce` 确实能验证失败复位。审查者声明未实际执行 harness（只读授权内），故「PASS」仍以实现者与主会话运行为准。

次要项（无阻断）：
- A：`late` 场景是合成顺序，非真实 DSH 时序；需在测试与 `#openTurnId` 注释中如实标注。
- B：`#openTurnId` 对真实 DSH 冗余（防御性），可留。
- C：prompt 失败时无条件复位 `#turnId` 存在窄边界（失败发生在已 running 之后会丢 id）。
- D：无运行回合时 steer 回 `turn` 会在 daemon 侧留下一个 `activeTurnIds` 条目（仅影响 `connectionClosed` 判断），相比原实现是收窄。
- E：按仓库 `AGENTS.md`，该缺陷需记入 `docs/FIELD-NOTES.md`。

## 部署
- 2026-10-15T04:20:01Z `paseo plugin reload dsh-paseo`；daemon 未重启（MainPID 285538 不变、NRestarts=0），profile 未改动，已安装桥与源码逐字节一致。
- 部署前备份：桥沿用既有 `dsh-paseo-bridge.bak-subsession-20261015-083955`（本轮未改桥）。

## 主会话独立复跑（部署前）
`tsc --noEmit` 0 错；`subagent-check` 37/37；`context-usage-check` 8/8；`steer-check` 17/17（含 steer 被 admit、steer 不产生 `session/cancel`、前台子代理在被 steer 的父下正常 completed、prompt_result 与 `session.turn started` 的 turnId 一致）。

## 真实 daemon 验证（after，3/3 通过）
同一驱动 `steer-live.mjs`，部署后 3 次独立运行全部符合期望：

| 观测项 | before（未修复） | after（修复后，3/3） |
| --- | --- | --- |
| steer 后父 `activeTurnId` | 变化（换新回合） | **不变** |
| 新增 `turn_started` | 有（1 个） | **无** |
| 父 `turn_completed` 次数 | 2 | **1** |
| 子代理终态 | **canceled**（约 2.7s 被 abort） | **completed**（跑完 sleep 25，约 30s） |
| `tool_call subagent` 状态 | failed | completed |
| marker `user_message` 行数 | 1 | 1（该口径不能区分，见更正） |

after 中父模型明确消费了 steer 并继续原回合（如 `There's a steer marker ... which appears to be injected`），子代理结束后父正常总结。
after 窗口 turnId 形如 `turn:steer-live-after-<tag>`（clientMessageId 型），是 `#openTurnId` 预发生效的标志；before 为 `turn:<Date.now()>` 型。

原始证据：`steer-live.after-122029/122109/122150.{jsonl,summary.json,stdout.log}`、`steer-live.after.md`。

## 用户实测归因（2026-10-15）
用户在 App 里实测后仍被打断。取证结论：**该次客户端发送的是 `interrupt`，不是 `steer`**。

- 证据：daemon 的投递回执 `~/.paseo/agent-requests/<sha256(key)>.json` 存有 `fingerprint = sha256(JSON.stringify(request))`，`request = { prompt, activeTurnBehavior }`（`@getpaseo/server/dist/server/server/message-receipts/index.js`，键递归排序）。
- 该消息（agent `15096e5e…`，文本「这次我运行中我可以给你发消息吗」）的指纹 `2857ef12…` 精确匹配 `activeTurnBehavior: "interrupt"`，与 `"steer"` 不匹配。
- 方法可靠性已用 after 测试的 steer 投递反向验证：`f5dc75cb…` 的回执指纹精确匹配 `{prompt:"STEER-LIVE-MARKER-9761840d", activeTurnBehavior:"steer"}`。
- 旁证：该会话时间线里，用户消息落在**新回合** `turn:msg_1792038418318_d5sb5pu3o`，子代理 `tool_call subagent` 状态 failed、子会话 canceled。

因此：
- 用户症状的**直接原因**是客户端设置（设置 → 通用 → 默认发送方式 = Interrupt；选项为 Interrupt / Steer / Queue，默认值本应是 Steer）。
- 插件缺陷是**第二层**：即便把设置改成 Steer，修复前也会因为 steer 回执谎报而退化回「取消并重发」，等于该设置无效。两者都需要。
- 结论修正：P002 修复对「设置=Steer」的用户有效（机器验证 3/3）；对「设置=Interrupt」的用户不改变语义（那是显式要求打断）。

## 结论
- 真实 daemon 端到端：运行中发消息不再取消父回合、不再打断前台子代理，行为与 DSH 自身一致。
- 未覆盖：App UI 真机实测（由用户确认）；多次 steer；DSH 原生路径对照。
- 未归因（另案）：`fetchProviderSubagentTimeline` 在这些测试会话返回 0 行；被打断回合被上报为 `turn_completed` 而非 `turn_canceled`。

## 「发消息不终止子代理」的第二条路径：让子代理默认后台（2026-10-15 实测）

用户不接受"必须改客户端设置"，要求"跟主会话对话不终止子代理"。核实后确认两条独立事实：

- Paseo 的 `interrupt` 是**显式取消**：`agent-prompt.js:5`（非 `steer` 不进 steer 分支）→ `replaceAgentRun` → `cancelAgentRunBefore` → `session.interrupt()`。插件在这条路径上只能转成 DSH 的取消。
- DSH 里**前台**子代理绑在父回合的 `exec.signal` 上：`dsh-tool-subagent/lib/index.js:559` 传 `signal: exec.signal`；`dsh-subagent-in-process-driver/lib/index.js:199-201` 在该信号 abort 时 `child.cancel({kind:"parent"})`。后台/continuable 子级自建 `AbortController`，不受影响。

因此与客户端设置无关的解只有一条：让子代理不挂在父回合上。配置层核实（`dsh --profile paseo --dump-config`）：

- paseo profile 的 `tool-subagent` **已经是** `backgroundMode: continuable`（继承 `dsh-base/cordis.patch.yml:375`）。
- 但 `resolveDelegationRun`（`dsh-tool-subagent/lib/index.js:355-361`）中模型传入的 `run_in_background` 优先；`enableRunInBackground: false` 反而是**强制前台**。DSH 没有"强制后台"的配置项，只能用指令影响模型的选择。

落地：写入 `~/.dsh/AGENTS.md`，经 `dsh-agent-instructions`（profile 已启用，`maxBytes: 65536`）作为 `user-global` 基线注入。

A/B 实测（真实 daemon，`deepseek-harness-native` provider、本机已配置的 route，驱动 `bg-rule-live.mjs`；在"父回合运行且子代理运行"的窗口内发送 `activeTurnBehavior: "interrupt"`）：

| run | 规则 | 提示词形态 | `subagent` 参数 | catalog mode | interrupt 后子代理 |
| --- | --- | --- | --- | --- | --- |
| A | 无 | busy（父级自己有活） | —（模型自选） | continuable | completed |
| A2 | 无 | needresult（下一步依赖结果） | `run_in_background: false` | one-shot | **canceled** |
| B | 有 | needresult（同 A2 提示词） | **省略**（→ 默认 true） | continuable | **completed** |

- A2 复现用户场景：interrupt 替换父回合（`turn:bg-rule-A2-…` → `turn:bg-rule-interrupt-A2-…`），子代理返回 `Error: subagent run was cancelled`。
- B 同提示词下模型改为后台：interrupt 同样替换了父回合，子代理继续运行，结算后另行通知父级（`turn:1792040535571`）。
- 规则确实被加载：B 的父会话中规则文本以 `source.kind="agent-instructions"`、`scope=user-global`、`path=~/.dsh/AGENTS.md` 的基线消息注入；A2 无该文本。

边界：该规则是**软约束**（影响模型选择，不是协议保证），且 A/B 各一次样本；`~/.dsh/AGENTS.md` 对该 `DSH_HOME` 下所有 profile 生效，不限于 Paseo。客户端设置（Steer/Queue）仍是"消息不取消父回合"的唯一开关，两者正交。

原始证据：`/tmp/opencode/paseo-dsh-subagents/acceptance/bg-rule.{A-norule,A2-norule-needresult,B-withrule-needresult}.{jsonl,summary.json}`。

### 改为代码级硬保证（2026-10-15 落地）

上表的 B（AGENTS.md 规则）一次通过、C（改措辞为"始终显式传 true"）第一次调用仍被模型传成 `false`，说明提示词层不稳。用户要求直接改代码，遂落到插件自身：

- 缝：`dsh-tools` 的 `register()` 文档明确 "Scoped tools shadow globals"，`dsh-agent` 的 `Agent.ctx` 是 agent 作用域；`tools/pre-execute` / `guard` 只能放行/拒绝，**改不了参数**。
- 改动：`dsh-bridge/lib/server.js` 的 `installSelection`（`ctx.agents.create` 与 `ctx.agents.resume` 共用）内，把 `subagent` / `subagent_fork` 在该 agent 作用域遮蔽，`execute` 强制 `run_in_background: true`；schema、描述、执行体全部复用原定义。不改 DSH 的包。
- 副作用（有意接受）：模型失去"同一回合内等子代理结果"的能力，改为拿 id、等结算通知后汇总。
- 内嵌桥已按仓库规矩重生成（`bridge-assets.ts`），插件已 reload，已安装桥与源码逐字节一致。

真机对照（同 `needresult` 提示词、同样在窗口内发 `interrupt`）：

| run | 机制 | 模型传入 | 实际 catalog | interrupt 后子代理 |
| --- | --- | --- | --- | --- |
| A2 | 无 | `run_in_background: false` | one-shot | **canceled** |
| B | AGENTS.md 规则 | 省略 | continuable | completed |
| C | 规则（显式 true 措辞） | `false`（规则未生效） | one-shot | **canceled** |
| D | **代码强制** | `false`（被改写） | **continuable** | **completed** |

D 的判据：模型传入 `false`，但 `subagent/catalog` 为 `continuable`、工具返回 `started subagent <id>`；interrupt 替换了父回合（`turn:bg-rule-D-forced-needresult` → `turn:bg-rule-interrupt-D-forced-needresult`），子代理仍跑完 `completed`。

原始证据：`/tmp/opencode/paseo-dsh-subagents/acceptance/bg-rule.D-forced-needresult.{jsonl,summary.json}`。
