# 撤回提示链（plugin-rewind-notice）审查 — 2026-11-03

- 审查基线：`0c82df5`（工作区仅未跟踪 `V1.txt`/`v1.txt` 与 `docs/audits/20261103/`，未改动）
- 审查方式：fresh 上下文、独立只读审查；不采信其它 lane 与本仓提交信息的结论，每条判断由本轮自己读码/复跑得出
- 范围（逐行通读，非抽样）：`paseo-plugin/server/rewind-notice-append.ts`(416)、`server/rewind-canary.ts`(65)、`client/rewind-notice-data.ts`(71)、`client/rewind-notice-live.ts`(295)、`client/rewind-notice.tsx`(82)、`shared/rewind-notice.ts`(254)；相关接线 diff：`index.client.tsx`、`index.server.ts`、`server/locale.ts`、`server/provider.ts`（`git diff e7472be..HEAD`，+1334/−23）
- 对照：`docs/REWIND.md` 全文（尤其「刷新：宿主 history 截断 + canary 自证」「完成提示」两节与四条约束）、根 `AGENTS.md` 的「撤回（rewind）」节、`docs/FULL-AUDIT-20261102.md` §3.1/§10.1、`docs/FIELD-NOTES.md` 第 78/79 条
- 协议/宿主对照：已装 `@getpaseo/{client,plugin,protocol}@0.14.0` 的 d.ts 与实现，以及 `~/apps/paseo`（Paseo 0.14.0 源码，`packages/server`/`packages/app`）的 `plugin-provider.ts`、`agent-manager.ts`、`agent-run-state.ts`、`timeline-projection.ts`、`plugin-process.ts`、`plugins/timeline/*`
- 禁项遵守：未改产品代码/文档/harness，未做 git 写，未起真实 daemon/模型，未读写真实 `~/.dsh` profile，未装包；除本报告外未写任何 tracked 文件（`.dbg-p17-delivery`/`.dbg-host-contract` 为 harness 自建 gitignored 编译产物）
- 证据等级：**实测**＝本机可复跑命令 + exit code/输出片段；**源码推断**＝读实现与调用链得出；**文档/类型依据**＝已装 d.ts 或官方源码；**未验证**＝未取得运行证据，单列第 5 节

## 1. 本轮复跑的检查

| # | 命令（工作目录 = 仓库根，除注明外） | exit | 结果 |
|---|---|---:|---|
| 1 | `cd paseo-plugin && npx tsc --noEmit` | 0 | 类型门干净 |
| 2 | `node harness/rewind-notice-check.cjs` | 0 | **63/63 passed**（文案两语、计数、legacy 识别、胶囊 live 判定状态机、目录 watch 上限、接线与「无 before(session_open)」） |
| 3 | `node harness/rewind-notice-delivery-check.mjs` | 0 | **30/30 passed**（真实 `AgentManager`/`PluginAgentClientRegistry`/`appendTimelineItem`；normal 场景 + 5s 慢重建 + 300ms 超时降级子进程） |
| 4 | `node harness/host-contract-sim.mjs` | 0 | **7/7 passed**（已装宿主为**补丁版**：canary 回执前被截、回执后存活；文案与 `translateNotice` 逐字一致） |
| 5 | `node harness/revert-check.mjs` | 0 | **120/120 passed**（含 canary 源码顺序、files scope 无 canary） |
| 6 | `cd paseo-plugin/.dbg-p17-delivery && node session-request-check.cjs` | 0 | **52/52 passed**（provider 的 `session.revert` 分支：回执、canary 与 files/both 作用域、部分失败文案、`files.error`） |

（#2–#6 的判据有效性不是照单全收：第 3 节 RN-07/RN-06 记录了其中两处「判据比声称的弱」与「fixture 形状与真实桥不一致」。）

## 2. 健康度评分

| 维度 | 评分（1-5） | 说明 |
|---|---:|---|
| 正确性 | 4 | 主机制在**真实宿主代码**上双向复现（`timeline.append` 绕过 run lock、replacement 之后落行、行不进 provider history、固定行 id 折叠）；剩余两条静默丢行路径都只在窄窗口（RN-01/RN-02） |
| 健壮性 | 3 | 降级路径有界且会记日志，但订阅只在 `revert` 抛错时释放（RN-05）、超时复核只做一次（RN-02）、ready 失败被记成「超时」（RN-04） |
| 可维护性 | 4 | 注释极详尽，但存在注释强于实现/与实现漂移（RN-04、RN-08、RN-09），legacy 识别与文案表是两份手维护信息 |
| 契约一致性 | 4 | 逐条对照已装 0.14 类型/实现：`session.revert` 入参、`timeline.append`、`PaseoAgentTimelineEvent`（`timeline`/`replacement`/`error`/`subscription_restored`）、`refetch` 页 `entries[].item`、renderer `kind+version` 精确匹配、`PluginHandlerContext`/`useToast`/`rpc` 全部成立；仅 `files === undefined` 的兜底语义在 files/both 上是假声明（RN-06） |
| 性能 | 4 | 每次 conversation/both 撤回最多多等 1s 订阅 ready（通常远小于）；timers 全部 `unref`；客户端最多 16 条订阅 + 64 条记录；无轮询 |
| 安全 | 4 | 报告行只渲染纯文本，无 HTML/eval；无凭据/路径外泄；插件行内容受宿主 `limitAgentTimelineItemContent` 与 `assertPluginTimelineDataSize` 限制 |
| 测试覆盖 | 3 | 6 门共 275 条断言全绿；但运行期 canary 顺序、飞行中句柄捕获、>11.5s 重建、真实 both 回执形状四处无覆盖（RN-01/RN-02/RN-06/RN-07） |

**总分：26 / 35（约 3.7 / 5）**

**一句话总评：** 本轮把「撤回完成报告」从「猜 300ms 延迟的 notice」换成「等 `timeline.replacement` 后 `timeline.append`」是方向正确且被真实宿主代码证明的修复，没有 P0/P1/P2；剩余问题集中在两条窄窗口静默丢行、异常/超时路径的收尾、以及测试判据与文档结论的口径偏差，属「可发布、维护批次清理」。

## 3. 发现列表

本轮无 P0/P1/P2，全部为 P3（显示/可维护性/窄窗口健壮性）。「归属」说明是否本轮 `e7472be..HEAD` 引入。

| ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| RN-01 | P3 | `server/rewind-notice-append.ts:344-346`、`:367-395`；`server/provider.ts:1040-1045` | `beginRewindReport` 时 `paseo` 句柄尚未捕获（插件进程启动后、首个 hook/RPC 之前），但句柄在 revert 飞行期间被并发回调（如 jobs pill 的 `jobs.list` 轮询、客户端 arm RPC）捕获 | 源码推断 + 测试缺口（`delivery-check.mjs:458-501`（场景 0）的句柄捕获发生在 `manager.rewind` **完成之后**，未覆盖飞行中捕获） | 新引入（8091777） | `#watch` 只在构造时按「当时是否有句柄」决定建不建；`#deliver` 见 `#watch === null` 就置 `replaced = true` 直接 append、**不等待也不复核**。conversation/both 撤回时该 append 可能早于宿主 force-hydrate，行被重建抹掉且无任何日志（静默丢报告）——正是本功能要消除的失败类型。窗口极窄，故 P3；若按「功能缺失」口径可上调 P2 |
| RN-02 | P3 | `server/rewind-notice-append.ts:225-246`、`:79-87`、`:394` | replacement 未在 timeout（默认 10s）内到达，且宿主的重建在 timeout+1.5s **之后**才完成（超大会话的 slow hydrate / replacement 迟到） | 源码推断；`delivery-check.mjs:607-641` 的慢宿主只建模到 5s hydrate（< 10s timeout），未覆盖 >11.5s | 新引入 | 超时路径 append 后只做**一次** 1.5s 复核；复核时重建尚未完成 → 复核看到行还在 → 不再补发 → 重建随后抹掉它，无第二次检查、无日志。注释宣称「降级显式且有界」，但 verify 之后无界。可复现性依赖极长会话，P3 |
| RN-03 | P3 | `server/rewind-notice-append.ts:182-199`、`:239`；`client/rewind-notice-live.ts:189-195`；`client/rewind-notice.tsx:49-60` | RN-02 的补发路径（`verifyAfterTimeout` 重 append） | 源码推断 | 新引入 | 每次 append 生成新 `noticeId`；补发会被 live monitor 记成新到达，行组件 `data` 变化触发 effect 重跑、`take()` 命中 → 10s 内**第二次 toast**（同一撤回弹两次胶囊） |
| RN-04 | P3 | `server/rewind-notice-append.ts:291-305` 与 `:385-391` | 订阅 establishment 失败（权限/断连） | 源码推断 | 新引入 | 失败分支先打出真实原因并 `settle(false)`，随后 `#deliver` **立刻**再打一条 `sent no timeline replacement within ${10000}ms`——把订阅失败误报成「等满 10s 超时」，且时间戳证明没等（诊断误导，排障会去查宿主 replacement 而真因是订阅） |
| RN-05 | P3 | `server/provider.ts:1057-1065`；`server/rewind-notice-append.ts:398-401` | `session.revert` 成功之后、`deliver()` 之前抛错（canary 构造/文案/回执字段访问异常等） | 源码推断 | 新引入 | 只有 revert 抛错才 `delivery.cancel()`；此窗口抛错则订阅与 10s timer 都不释放（timer 只 settle promise、不 release），订阅常驻到插件进程退出，报告丢失。实际概率极低（后续代码几乎不会抛），故 P3 |
| RN-06 | P3 | `shared/rewind-notice.ts:190-204`；`harness/fake-dsh-bridge.mjs:1010`；`harness/session-request-check.cjs`（both 断言）、`harness/rewind-notice-delivery-check.mjs:590` | 桥对 `files`/`both` 撤回的成功回执**缺少 `files` 半**（协议形状漂移/桥比插件旧） | 源码推断（对照 `dsh-bridge/lib/server.js:2798-2856`：`files`/`both` 成功回执里 `files` 恒存在——restore 结果或空计划对象；只有 conversation 恒无） | 新引入 | `rewindSuccessText` 把 `files === undefined` 一律解释为「这条消息之后没有改动文件」；对 files/both 这是**假声明**，而同一函数对「files 在但数组读不出」却退回不带数字的句子——同一类形状异常给了两种口径，违背模块自己写的「绝不编数字」。harness 的 fake 桥默认回执正是无 `files`，于是集成断言把该假声明锁定成期望值，掩盖真实 both 回执（带计数）形状 |
| RN-07 | P3 | `harness/rewind-notice-delivery-check.mjs:35` vs `:596-601`；`harness/revert-check.mjs:273-283` | 有人改动 canary 的发出位置 | 实测（本轮读判据并复跑：30/30、120/120） | 测试体系（本轮重写） | delivery-check 头部声称断言「canary 仍先于回执发出」，实际只断言「发出过 ≥1 条 canary」；运行期顺序只由 revert-check 对 `provider.ts` 的**源码字符串位置**覆盖（`body.search(rewindCanaryNotice\()` < `body.search('type: "request.completed"')`），`host-contract-sim` 是假 connection 手工摆顺序。把 canary 移进 helper 或条件分支（源码字面位置仍在回执前）时，没有任何检查能发现 |
| RN-08 | P3 | `docs/REWIND.md:196-202`；`docs/FIELD-NOTES.md:2727-2745` | 维护者据文档判断 canary 是否还有用 | 源码推断 + 实测（delivery-check 运行中 daemon timeline store 出现多条 `撤回已生效`） | 基线文档（canary 本身 bf093a7，本轮未改该结论） | 文档称 canary 交付在真实 daemon 上「不成立……时间线里根本看不到它」。live 投递确实被 run lock 吞掉，但 canary 会进入宿主 `PluginAgentSession.history`（`plugin-provider.publish` → `history.push`），stock 宿主在撤回后的 `forceHydrateTimelineFromProvider` 会把它**重放进时间线**；补丁宿主上它被 `truncateHistoryFrom` 截掉才是「看不到」的**正确**行为。实测印证：delivery-check 里 truncate 成功的那个真实 messageId 撤回（#1）无 canary 行，truncate 失败（假 token）的后续撤回（#2、#3）之后 daemon timeline store 里出现对应 `撤回已生效` 通知行（`describeRows` 输出被 260 字符截断，但 #1 在 #2 之前缺失即为截断生效的旁证）。该结论会误导「canary 无效可删/可改」的后续决策 |
| RN-09 | P3 | `server/rewind-canary.ts:47-50`；`server/provider.ts:507` | 维护者依据注释理解 `#seq` 语义 | 源码推断 | 基线已有 | 注释称 `#seq` 是「the provider connection's own counter, so the text is unique per session」并暗示「a later auto-reload would look for」它；实际是**连接级**计数，连接重建（daemon 重启/插件 reload）后从 0 重计，文案可重复；目前也不存在按该文案查找的 auto-reload |

## 4. 阴性结论（本轮判定成立、不报为问题）

1. **canary 顺序满足硬约束**（`provider.ts:1093-1102`：canary 在 `request.completed` 之前；`scope === "files"` 不发）。源码顺序门（revert-check）与宿主行为门（host-contract-sim，已装宿主为补丁版）双向通过；回执之后发的对照在补丁宿主上存活，证明「顺序即机制」而非风格偏好。
2. **完成报告不再走 notice**：`session.notice` 在 rewind run lock 期间被 `enqueueSessionEvent` 压进 `stagedEvents`、`clearRun` 丢弃（`agent-run-state.js:62-69,132`）；`timeline.append` → `appendTimelineItem` 直接 `recordTimeline` + `dispatchStream`（`agent-manager.js:1784-1800`），不经 staging。delivery-check 在真实宿主代码上证明 notice 被丢、plugin 行存活。
3. **落行时机正确**：conversation/both 在宿主 `hydrateTimelineFromProvider({force:true})` 之后、`settleForegroundRun` 之前派发 `timeline_replacement`（`agent-manager.js:2401-2429`）；插件在发撤回请求**前**订阅并等 `ready`，收到 replacement 再 append。delivery-check 的 normal/slow-host 场景断言 append 时间戳 ≥ replacement（+0ms / +5003ms 重建）。
4. **行不进 provider history、后续重建不复活**：delivery-check 直接断言 `session.history` 无 plugin 行；两次 conversation 撤回后 timeline store 仍只有 1 条报告行且是新的 `noticeId`。
5. **固定行 id 折叠成立**：daemon 侧 `timeline-projection.ts:160-165`（`mergeIdentityEntries` case "plugin"）+ 客户端 `types/stream.ts:1264-1289`（`appendPluginTimelineItem` 按 `${pluginId}/${id}` 折叠）与 Paseo 0.14.0 源码一致，不是自造契约。
6. **files scope 不发 canary、但发自己的完成报告**：`provider.ts:1093` 条件 + `shared/rewind-notice.ts:144-146`；session-request-check 断言 files 回执带计数时 0 条 canary。
7. **协议形状全部对得上**：`ProviderInput` 的 `session.revert` = `{sessionId, token, scope: "conversation"|"files"|"both"}`；`PaseoAgentTimelineHandle.append` 的 `Omit<PluginTimelineItem,"pluginId">`（pluginId 由宿主按 plugin 客户端 id 盖章）；订阅事件四型；`refetch` 页 `entries[].item`；renderer 按 `kind+version` 精确匹配（`plugins/timeline/view.tsx:53`）。均无自造字段。
8. **能力位与数据源一致**：`session.revert.files` 已随 88adebb 的桥实现一起声明；宿主 `supportsRewindFiles: supports("session.revert.files")`、`revertFiles → revert(messageId,"files")` 全链对得上；没有「声明了却丢弃」。
9. **句柄捕获路径安全**：`index.server.ts` 只用 `on(...)` 钩子 + `jobs.list` RPC + 新增 arm RPC，**未**注册 `before("agent.session.open")`（不会触发宿主 `invalidatePluginSessions`）；hook 名逐个对照 `PluginLifecycleEvents` 均存在；cleanup 全部返回并被调用。`PASEO_AGENT_ID` 由宿主 `agent-manager.ts:5567` 对每个 interactive 会话注入，`agentId === ""` 只是防御分支。
10. **客户端胶囊按 live 事件判定成立**：monitor 的 `timeline.subscribe` 回调按 `noticeId` 记录、行组件消费一次；replay/refetch 无记录 → 不弹（rewind-notice-check 的状态机断言 20+ 条全过）；`active` 单例是 per-bundle（app 每次 `runPluginClientBundle` 都 `eval` 出独立模块作用域，`plugins/registry.ts:115`），多 host 不会串。
11. **多客户端**：daemon 的 `subscribeAgentTimelines` 每次请求新增独立 owner（`session.ts:1342-1350`），不会顶掉 app UI 自己的时间线订阅；报告行是 daemon 侧广播，每个客户端各自判定胶囊。
12. **资源清理**：replacement watch 的两个 timer 均 `unref`；正常/失败/取消路径都会 `release`（除 RN-05 的窄异常窗口）；客户端 `dispose` 释放订阅、目录观察与记录表。
13. **RN 未单列的两处「非问题」**：`pending` 队列按 agentId 覆盖——因为行 id 固定、后一条本就替换前一条，最终可见状态与两条都 append 相同；`conversation` scope 的 `files` 恒为 undefined，走 `copy.conversation` 不涉及 RN-06。

## 5. 未验证项

1. **真实 daemon / 真实模型回合 / 真机 UI**：按任务书未起 daemon、未用真实 `~/.dsh`、未开浏览器；「补丁宿主上 canary 一闪而过」「stock 宿主上 canary 经重建留在底部」两条真实端到端表现未在真机取证（RN-08 的 stock 半是源码推断 + harness 模型）。
2. **`host-contract-sim` 的 stock 半**：只跑了已装（补丁版）宿主 7/7；stock 半需要 `npm pack @getpaseo/server` 解包 + 包装目录（脚本头注释），本轮未装包，未跑。
3. **多客户端/多 host 的真实 app 行为**：只做了源码与单测级推断，未在 app 里同时开两个客户端验证胶囊与目录订阅。
4. **超长会话（hydrate > 11.5s）与 RN-01 的飞行中捕获**：未构造真实触发；两条均标源码推断 + 测试缺口，未实测复现。
5. **`DSH_PASEO_REWIND_REPLACEMENT_TIMEOUT_MS` 的生产语义**：这是给 harness 的降级开关，生产环境若被外部设置会改变行为；未验证是否有部署脚本会设它。

## 6. 跨 lane 提示

- **bridge / bridge-files lane**：真实桥的 `files`/`both` 成功回执里 `files` 恒存在（`dsh-bridge/lib/server.js:2798-2856`），但 `harness/fake-dsh-bridge.mjs:1010` 的默认回执不带 `files`；插件侧 RN-06 的假声明只在形状漂移时暴露，若桥 lane 后续改回执形状，请同步插件兜底与两个 harness 的 fixture。
- **docs lane**：`docs/REWIND.md:196-202` 与 `docs/FIELD-NOTES.md:78` 的「canary 交付不成立」结论建议按 RN-08 修正（live 路径被吞 ≠ 整条链无效；stock 宿主靠 provider history 重放交付，补丁宿主按设计不显示）。
- **harness lane**：RN-07（delivery-check 声称的运行期 canary 顺序未断言）与 RN-06（fake 桥 both 回执形状）属判据层面欠账；另 `session-request-check.cjs` 的完成报告断言全部走的是「无 `PASEO_AGENT_ID` → provider notice fallback」路径，与真实 append 路径不同层，报告里已按此说明，不算错，但覆盖边界应写清。
- **client-toolcall lane**：胶囊已不再依赖 `client/newest.ts` 的 bulk/fresh 规则（该文件仍服务工具行脉冲）；两 lane 在 `index.client.tsx` 的 transformer 注册顺序上无冲突（本 lane 的 notification transformer 只对 legacy 撤回文案生效）。
