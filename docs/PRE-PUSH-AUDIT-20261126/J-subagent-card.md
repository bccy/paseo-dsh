# J 子代理卡片 审查报告

状态: completed
范围: 只读全文审查 `paseo-plugin/shared/subagent-card.ts`(912)、`client/subagent-card.tsx`(1060)、`shared/subagent-live.ts`(50)、`client/subagent-live.ts`(238)、`test/subagent-card.test.cjs`(1643)；交叉核对消费面接线（`client/tool-call-data.ts`、`client/tool-call.tsx`、`index.client.tsx`）与 shared 契约的生产端（`server/timeline.ts`、`server/session.ts`、`server/provider.ts` 订阅分发）。不含 server 投递/timeline 事件形状的独立深审（归 K 块）。

## 摘要
- 结论：J 块范围内**无阻塞 push 的问题**（P0=0、P1=0）。shared schema 与 server 生产端逐字段一致（kind/status/role/title/task/report/childSessionId/mode/preset/model/steps/durationMs/outputTokens 全量：`server/timeline.ts:1457-1538`），`shared/subagent-live.ts:24-38` 与 `index.client.tsx:349-380` 为同一份字段的三个副本，未发现漂移。
- 解析容错与上游客器一致性已核：DSH 0.2.2-rc.5 实装配对 `started subagent` 回执文本 `dsh-tool-subagent/lib/index.js:425`、结算标记 `Its closing message:`/omitted/left-no-closing `dsh-subagent/lib/index.js:468-474`、`list_agents` 文本行与状态枚举 `dsh-tool-subagent-control/lib/index.js`、根名 `ROOT_AGENT_NAME="lead"` `dsh-subagent/lib/types/names.js:10`；三代 list_agents 与 archive 5 行报告解析均与生产端一致，畸形/混合形状 fail-closed 保留原文。
- 冷启动/归档降级安全：无 `metadata.dshSubagent` 时按 `detail.sub_agent`/`unknown` 观测字段回退（`shared/subagent-card.ts:549-607`），解析失败返回 null 走通用卡片，未发现崩溃路径；`failed` 状态不会被渲染成 completed（状态取自 metadata 或 `item.status`，不互相覆盖）。
- 测试有效：`cd paseo-plugin && node --test test/subagent-card.test.cjs` 实测 17/17 通过，断言打在真实 `DshSession`/`TimelineBuilder`/shared 解析器上（非复制实现）；`docs/HARNESS.md` 声明的 17 条与该文件一致。
- 卫生：五个文件无具体 provider 名/模型 id/base URL/密钥/本机真实路径；夹具只用 `fixture/alpha`、`/work`。

## 问题

| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P2 | `client/subagent-live.ts:113-134`、`:232-235` | live 订阅关闭或建立失败后无重建/无降级：`onClosed` 与 `ready` reject 只把 `entry.controller=null`，refs>0 时不再调用 `startSubscription`；而渲染期 effect 依赖 `[needsLive, agentId]`，值不变不会重跑，该卡片会一直显示「运行中」直到卸载重挂，且无任何提示。触发条件：宿主因事件 schema 校验失败 `handle()` 关闭、插件重启、`ready` 拒绝。另若宿主在重连后自动复用同一订阅通道，`:113` 的 `entry.controller !== controller` 守卫会继续丢弃事件 → 永久停更。 | `subagent-live.ts:118-133`（onClosed/ready 只置 null）；`:232-235`（effect 只依赖 needsLive/agentId）；`:113`（controller 守卫） | 关闭时在 `onClosed`/`ready.catch` 内按退避重建（或把 controller 置空后通知 store 触发 effect 重跑），并对连续失败降级为一次提示；需真机确认宿主 onClosed/重连语义（见未验证项 1） |
| P3 | `shared/subagent-card.ts:305-351`、`server/timeline.ts:1211-1224`、`client/subagent-card.tsx:666-674,881-914` | 跨回合失败子代理卡片只有「失败」徽标、无原因文本：结算解析只取 closing 文本（`:317-343`），DSH 结算首行摘要（含 “failed before it finished”/“ran out of room” 等失败原因）与 `terminal.diagnostic` 块被丢弃；server 只存 status/report，客户端错误块数据源仅失败 tool 行（跨回合 settle 行不是 failed 行）。同时有 closing 文本时 `Structured result: …` 诊断行会被并入「最终报告」（`:319`）。 | `shared/subagent-card.ts:317-343`；`server/timeline.ts:1211-1224`；`client/subagent-card.tsx:666-674`（errorPreview 仅来自 error props）、`:881-914`（错误块仅 error props） | 结算解析补出首行摘要/diagnostic，作为卡片失败原因的独立字段（不混入 report），并断言 failed 卡片可见原因文本 |
| P3 | `shared/subagent-card.ts:534-539` | `coerceStatus` 把未知/缺失 `item.status` 静默判为 `completed`（历史回退路径唯一的状态兜底）。当前 `ProviderToolCallItem.status` 联合只有 running/completed/canceled/failed（`@getpaseo/plugin` server/provider.d.ts:620-632），实际仅在持久化旧值/未来协议漂移时可达，属纵深防御缺口。 | `shared/subagent-card.ts:534-539`；`server/provider.d.ts:620-632` | 未知状态回退到中性/unknown 展示（或日志告警），不要默认成功 |
| P3 | `test/subagent-card.test.cjs:1556-1643` | 客户端 live store 测试只覆盖共享订阅/合并/LRU/abort 四项；`client/subagent-live.ts:15-17` 注释承诺的「未绑定 client 或 subscribe 不可用返回 initial」、onClosed/ready reject、重复帧去重、agentId 缺失均无断言，恰好未覆盖 P2 所列关闭路径。 | `test/subagent-card.test.cjs:1586-1594`（fakeClient 只有成功路径）、`:1622-1630` | 补上述 4 例（fake client 的 ready reject / onClosed / 不绑定 / 无 subscribe） |
| P3 | `harness/tool-call-check.cjs:5230-5300`（同提交的渲染回归，非本文件） | 卡片渲染离线检查只构造 running / completed(fork) 两个夹具，无 failed 夹具；`failed` 不得渲染成 completed 的 UI 契约没有回归断言（chip 侧有 failed 计数断言）。 | `harness/tool-call-check.cjs` Phase 4（`runningSub`/`forkSub`）；无 failed SubagentCard 渲染用例 | 增加 failed 卡片断言（CircleAlert 图标、danger 徽标、错误块文案、不出现 CircleCheck） |

## 未验证项
1. **宿主 onClosed/重连语义（P2 关键前提）**：Paseo 运行时不在仓库，`@getpaseo/plugin` 的 `PluginClientContext.subscribe` 只声明「reconnect 后 Paseo 重新订阅」（`dist/client/contracts.d.ts:216-219`），未说明是否会以同一 observer 复用通道、是否触发 onClosed。验证方法：真机起 daemon → 运行中子代理 → `paseo daemon restart`，观察卡片是否自动收尾；以及插件 reload 后同样观察。
2. **真机渲染（RN Web/Hermes）**：本轮只做静态+Node 桩判读，未在真机验证 Badge/ScrollView/长报告(260px 上限)/`Expandable` 折叠在 iOS/Android/Web 的表现。
3. **服务端订阅分发未单测**：`server/provider.ts` 的 `SUBAGENT_SUBSCRIBERS` attach/notify（冷启动无 session 时等待 `notifySubagentSession`）无对应测试，归 K 块；静态阅读未见丢帧/泄漏。
4. **渲染回归未重跑**：`harness/tool-call-check.cjs` 需编译产物（会写 `.dbg-*`），按并行约束未运行；结论来自源码阅读与 `harness/offline-checks.cjs:56` 的登记。
5. **P3 coerceStatus** 不可在本协议版本复现，仅按防御缺口记录。
