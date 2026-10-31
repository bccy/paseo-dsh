# 服务端审查：provider / process / session / timeline

审查基线：`9298c28`，2026-10-31。范围：`paseo-plugin/server/`、`index.server.ts`、`shared/`。未修改产品代码、Git 状态、配置或 live profile，未运行真实模型、安装、重启、发布或外部业务请求。验证只使用主编排提供的临时 checkout 编译产物，以及私有临时 `DSH_HOME` / `PASEO_HOME`。

## 1. 结论与证据强度

主体的 direct provider + DSH profile bridge 边界合理：能保持 Paseo 原生会话/权限/UI，又不 fork 两边。当前实现的主要问题已从“有没有事件映射”转到**多套生命周期、配置状态、身份、回放缓存之间的一致性**。不建议为了修这些问题换一套传输或重写插件。

建议本轮纳入：**P1 1 项、P2 6 项、P3 1 项**。前 7 项在编译后的真实插件上复现；第 8 项是已安装 DSH 与 Paseo CLI 源码形成的静态闭环，未执行会产生副作用的 CLI 命令。P1 的判据是“对外已 ready 的会话实际不能接收任何 prompt”，不是“存在一个并发窗口”本身。

- `reproductions/server-race-wire.cjs` / `.log`：真实 provider + 真实 DshProcess + stdio 假桥，只有假桥的 `paseo/commands` 响应增加 300ms 延迟；正常 sibling 前后两回合完成作为对照。
- `the S02 observations in reproduction-results.json` / `.log`：mode 能力目录与 session.config 比较、初步配置/并发验证。最终并发证据以 `race-wire` 为准。
- `reproductions/server-config.cjs` / `.log`：真实 DshSession + 有实际状态的传输替身；支持的 mode/effort 先正常往返，再验证失败/换模型分支。
- `reproductions/server-lifecycle.cjs` / `.log`：真实 DshSession，普通两回合工具统计、子会话 title 与进程退出扇出。

上述脚本断言的是**缺陷仍存在**，脚本 exit 0 表示复现成功，不能作为“插件回归全绿”计数。

## 2. 已确认问题

### S01 / P1：并发 open 先销毁在飞实例，再拒绝自己；被销毁实例还能发布 ready

**位置**：`provider.ts:1129-1150` 的 holder 查找/关闭；`1186-1191` 才检查/占用 `#opening`；`1419` 只检查连接未关闭；`1451-1465` 发布 opened/config/ready。

**触发条件**：一个 native DSH session 正在打开，已放进 `#sessions`，但 `loadCommands` 等异步初始化尚未结束。第二个 open 使用不同 provider session id、同一个 persistence sessionId。该形状就是重新加载/导入时会使用的身份组合；需要两个请求重叠，正常串行重开不受影响。

**真实协议复现**：假桥在第一实例的 `paseo/commands` 请求到达后延迟回包 300ms。此时提交第二个 open，得到：

1. 第二个 open 把第一实例当成既有 holder，调用 `holder.close()` 并删除其 `#sessions` 条目，发 `session.closed(first)`。
2. 第二个 open 才发现第一事务仍占用 `#opening`，发 `request.failed(second, another open ... in flight)`。
3. 第一实例收到迟到的 commands 回包；后续 `loadPermission()` 因已关闭而失败，但该错误仅成为 warning。
4. `#assertConnected()` 通过（连接确实没关），第一事务继续发 `session.opened/ready(first)`。
5. 向 first 提问得到 `session.runtime_failed: unknown session`。

对照：同池另一 native session 在竞态前后各成功完成一回合，表明没有靠破坏进程或全局传输制造假阳性。

**历史关系**：10-25 的并发修复/`concurrent-open-check` 主要钉住同 provider id 的 `replaced` 分支；本问题在**不同 provider id 的 holder 分支**，守卫尚未涵盖它。`holder.close` 从 10-20 已存在，不是 P003 新增。

**最小修法**：在任何可能关闭 holder 的动作之前，同步获取 native session 的 opening claim；把 holder 接管也放进该事务的 try/finally。发布 ready 前检查 `#sessions.get(sessionId) === session` 且实例仍 open。`session.close` 应使进行中的 open 事务失效，不能只删除 map。还需约束相同 provider id、不同 native id 的交错，不只锁 native key。

**门禁**：扩展 `concurrent-open-check` 覆盖不同 provider id/同 persistence、close-during-open、同 provider id/不同 persistence。要求失败者不关闭成功者；至多一个 ready；ready 的实例能 prompt；sibling 始终可用；claim 归零；后续串行重开成功。不要只断言存在 request.failed。

### S02 / P2：catalog 禁用 Plan 后，session.config 又把 Plan 加回来

**位置**：`provider.ts:276-293` 按 `raw.planMode` 过滤 catalog；`session.ts:595-642` 尤其 `638` 无条件 `modes: modes()`。后者 `modes()` 恒含 build/plan。

**复现**：仓库假桥本来就返回 `planMode: false`。真实 provider 输出 `catalog.modes=[build]`，打开后的 `session.config.modes=[build,plan]`。已安装 `@getpaseo/server@0.14.0` 的 `plugin-provider.js:1197-1204` 确认 `translateConfig` 会把该数组发布成 `availableModes`，因此不是仅仅闲置的数据字段。

**影响**：profile 因 web-app 关闭 plan-mode 时，draft 阶段消失的选项在打开会话后再次出现；选择后失败。与“数据源不存在则不声明能力”的约束冲突。

**历史关系**：10-20 修了 catalog 侧，漏了 session 配置侧；不是与历史“有意隐藏 Plan”冲突，而是未把该决定贯穿到 session。

**最小修法**：把同一份经过过滤的 availableModes 传入 DshSession，所有 configState/事件使用它；对 profile 能力改变定义缓存失效，不要另写一份推断。

**门禁**：同一假桥 `planMode=false/true` 两组对照；catalog、初次 config、configure 后 config 三处列表一致。false 时 explicit plan 应明确失败，不能静默变 build。

### S03 / P2：mode 请求失败后，本地状态仍被提交成新值

**位置**：`session.ts:1518-1520` 先写 `#mode`，再 await `process.setPlan()`；思考档位同类写序在 `1505-1506`。

**复现**：真实 DshSession 在支持 mode 的传输替身上先完成 build→plan→build（对照）；随后模拟 `setPlan` 拒绝。configure Promise 确实 reject，但后端实际状态仍为 false，`configState().mode` 已成为 plan。

**影响**：当前 request.failed 看似“选择未成功”，下一次任何 session.config 事件却会发布错误值；后续逻辑也使用了未确认状态。不能只靠客户端回弹补救。

**最小修法**：请求参数与 committed state 分离，等成功回执后提交；失败保持旧值。多字段 configure 若部分成功，应回读并发布真实已提交状态，明确失败的字段，避免把跨 RPC 更新当原子事务。未知 mode 应拒绝而不是归一到 build。

**门禁**：成功与失败的 mode/effort 各一组；失败前后 configState 相同；多字段请求在第二步失败后能说明第一步的实际提交结果。

### S04 / P2：只换模型时，思考档位显示沿用旧模型

**位置**：`session.ts:1478-1490` 更新 `#route`，但 `#thinkingOption` 只在另外的 `changes.thinkingOption` 分支更新；`636` 仍向宿主发旧值。

**复现**：fixture/a 支持 high，先成功设置 high；只切到无 thinkingOptions 的 fixture/b。真实 DshSession 向替身提交 `reasoningEffort:null`，后端已清除；`configState` 却为 `model=fixture/b, thinkingOption=high, thinkingOptions=[]`。

**影响**：界面/runtimeInfo 与实际模型请求不一致；还可能把该旧值带入后续配置/重开。

**最小修法**：成功 model 回执同时更新 route 和 thinkingOption，尽量从唯一 committed route 派生配置而不是并存两份 effort 状态。是否保留共同支持的旧 effort 是产品选择，但必须与实际提交值一致。

**门禁**：有推理→无推理、两模型共同支持、默认 effort 不同、model+effort 同时提交；每次 `configState.thinkingOption` 与后端回执一致。

### S05 / P2：正常第二回合的工具统计累计了上一回合

**位置**：`session.ts:1417-1423` 在发 prompt 前预置 `#turnId`；`1686-1692` 只有 `#turnId===null` 才清工具计数/耗时/lastStats；`2302-2322` 累计工具结果。

**复现**：通过真实 `DshSession.prompt()` 连续发两个普通 auto prompt，每回合恰好 1 次 tool/call/result。第二回合的 stats row 报 `toolCalls=2`。第一回合正确为 1。

**根因**：正常 prompt 预置 turnId 是保证 steer 回执正确的必要逻辑，但新增 stats 初始化把“turnId 已预置”错当成“仍在旧回合”。这两套语义组合后 reset 分支对常见路径不执行。

**影响**：工具次数/耗时失真；在新回合第一条 assistant/message 前，迟到 usage 更新还可能改上一回合的 lastStats。

**历史关系**：stats reset 来自 `e3bf0f7`（10-30 吸收上游）；原本的 turn-id 预置早已存在。典型的集成契约缺口。

**最小修法**：将“开始一个真实新回合”的一次性初始化收敛到统一入口，与“为将来回合预留 id”分开；覆盖 auto prompt、自主后续回合、steer 和重复 running 通知。不能简单每次 running 都清，因为同回合可能重复通知。

**门禁**：两个真实 prompt 回合各一工具，统计1/1；steer仍累计在同回合；重复running不清已计数；新回合不修改上一回合stats；取消/失败路径不遗留计时器。

### S06 / P2：共享进程退出把已完成的历史子代理改成失败

**位置**：`session.ts:519-525` 对所有已见 child 调 `fail()`；`2705-2716` 不检查 child 是否已经 terminal，就发 runtime_failed。

**复现**：真实 DshSession 接收 child 的 `running→turn/end completed`，确认已发 completed。随后调用相同进程 exit handler，child 又收到 `session.runtime_failed`。已安装 Paseo `plugin-provider.js:1250-1278` 确认 runtime_failed 无条件 upsert 为 failed，覆盖之前终态。

**影响**：一个正在做其他任务的共享进程崩溃，会改写所有已完成的子代理卡片状态。真实历史“已完成”被运行时退出事实覆盖。

**历史关系**：来自 10-29 `0cbf0f5` 的 child-crash 修复；当时只验中途崩溃，没有“已完成 sibling 仍保持完成”的负向边界。

**最小修法**：给 child 明确的运行/终态状态；只为尚未结束的子代理发 runtime_failed。保留“子先于根”的退出顺序；不要退回完全不通知子代理。cold replay 已完成/失败/取消都应保留原终态。

**门禁**：同一根下同时有 running/completed/canceled/failed 四种 child；崩溃仅把 running 收为 failed，其他保持；根仍失败；同一退出不得重复发终态。

### S07 / P3：另一个子代理的到来可绕过 label 等待条件

**位置**：`session.ts:1889-1902` 将无 label child 放入 pending；`1987-2005` 的 flush 只检查 rootReady 与 parent 是否能解析，漏了 label/40-frame 条件；`1828-1862` 现有 child 不再更新 title。

**复现**：root ready 后先通知无 label child A（正确保持未打开）；再通知有 label child B。B 引发 flush，把 A 无标题打开，A 没有收到任何 40-frame 等待预算。之后 descriptor 到来也不会修正已开的标题。

**影响**：并行子代理时可能出现永久“加载中…”/无标题，而单个 label-late 测试正常。

**最小修法**：统一 canOpenChild 条件，让直接路径和 flush 使用同一判据；缺 label 时仍等 descriptor 或预算到期。对于预算到期要明确可见 fallback title；不要悄悄永久无标题。

**门禁**：A缺label+B有label、rootReady批量flush、grandchild先到、descriptor晚到、预算到期、无更多事件时的有界降级。

### S08 / P2 候选（静态闭环）：共享环境使第二会话的 Paseo CLI 身份沿用第一个 agent

**位置**：`provider.ts:569-643` 首次 spawn 使用首会话 env；`683-699` 特意忽略 `PASEO_AGENT_ID` / `PASEO_AGENT_CWD` 差异；`dsh-process.ts:1401-1410` 把该 env 传给 DSH。

**跨项目证据**：

1. 本插件没有按 session 重新注入上述两个变量到 DSH 的 shell 子进程。
2. 已安装 DSH rc.5 `@deepseek-ai/dsh-subprocess/lib/index.js:50-56` 的 `scrubbedParentEnv()` 只删敏感键名和 `DSH_*`，保留 `PASEO_AGENT_ID`。`dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js:694-701` 的 childEnv 基于该函数，再叠加调用 env。
3. Paseo CLI 源码 `commands/heartbeat/index.ts:35-40` 的 requireCallerAgentId、`commands/schedule/shared.ts:125-135` 的 self target、`commands/agent/send.ts:202` 的 sourceAgentId 都读 ambient PASEO_AGENT_ID；`utils/caller-agent.ts` 同样如此。 已核对安装的 0.14.0 dist：`dist/commands/heartbeat/index.js:15-18`、`dist/commands/schedule/shared.js:94`、`dist/commands/agent/send.js:143`、`dist/utils/caller-agent.js:5` 行为相同；已装 DSH 的 @deepseek-ai 包中没有针对这两个变量的修正实现。

**触发条件**：会话 B 加入由 A 打开的池；B 用 bash/terminal 执行依赖默认调用者的 Paseo CLI 命令，而不是走带 B 身份的 MCP server。CLI 会把 A 当 self/source。此项未创建 heartbeat、未发送 agent 消息；不声称已观察到线上误派发。

**历史关系**：进程级 env 差异本来是已知有意边界，但把这两个键当作无害噪声略去遗漏了它们的真实消费者。它们不只是显示上下文。

**建议**：优先补会话级 shell 调用者身份注入；暂时无法做到时避免向共享子进程传入错误默认身份，并让依赖 self 的操作明确失败。若改成 env 分池，必须同时处理 DSH 全局 archive registry 的进程间一致性，不能孤立地把 pool key 改为 env hash。MCP 路径身份独立，不应因此重复注入或削弱它。

**门禁**：两个假 agent/不同 cwd 同池，分别通过只读 CLI caller 解析器或 echo fixture 取身份；B绝不读到A；MCP仍为各自身份；自配环境差异被明确处理。先用 stub CLI 验证，不能拿真实 heartbeat/create/send 做验收探针。

## 3. 与桥审查的交叉结论

桥审查另已复现 queued plan=false 不实际覆盖 resume 后的 plan projection。插件顺序可确认：`DshSession.open()` 在 attach/initialize 后立即 `setPlan(false)`；真正 materialize 是 provider 后续 `loadCommands()`；之后没有再次 setPlan(false)。因此这是可达的跨层缺陷，不应以“插件稍后会同步一次”驳回。详见 `bridge.md` 和 `bridge-extra-repro.mjs`，本报告不重复计数。

## 4. 全模块覆盖与未确认风险

| 范围 | 已审查内容 | 结论/后续 |
|---|---|---|
| `index.server.ts` | provision/注册provider/jobs RPC/cleanup | 注册链清晰；provision失败仅日志仍注册是既有可用性选择，建议纳入doctor/启动health暴露 |
| `server/bootstrap.ts` | profile名/home解析、用户文件保留、内嵌桥替换 | 替换先rm旧桥再逐文件写，非原子；失败会留半份桥。是可证明的设计风险，未模拟本机磁盘故障。建议临时代际目录+校验+原子切换+失败保留旧版 |
| `server/bridge-assets.ts` | 作为生成资产检查来源/路径契约，不逐字符读base64 | 主编排资产新鲜度2/2；建议把生成清单与协议版本/DSH适配版本一并固化 |
| `server/provider.ts` | 全部open/close/pool/ref/catalog/archive/revert/jobs | S01/S02/S08；归档始终优先写活进程是正确方向，不能为env分池破坏它 |
| `server/dsh-process.ts` | 全部会话RPC、路由、orphan队列、MCP翻译/浏览器发现、反向审批/问题、进程生命周期/分帧 | 一会话错误不终止整池已有处理；需要统一协议schema/结构化错误，减少字符串判因；`#closeTasks` 注释称可跨10s超时继续等待，实际#sendClose捕获超时后完成并删除，桥端teardown guard才是后续等待的实质保障 |
| `server/session.ts` | 全部配置、prompt/steer、主/子回放、权限、stats、附件翻译 | S01-S07；RPC拒绝的history错误与available=false两条路径提示不一致，需补“history RPC超时”的可见错误用例；当前未列单独P项 |
| `server/timeline.ts` | 所有映射、attempt后缀、工具缓存、meta、compaction/command状态机 | 现有常用事件映射较完整；#items/#toolInputs/#attempts以及ActivityTimeline runs随长会话增长，没有字节预算/生命周期退场；建议先采样heap再裁剪完成行与历史输入，保留跨回合晚到工具结果所需最小状态 |
| `server/activity-timeline.ts` | workflow/goal schema守卫、幂等start、settle | 未发现可直接确认的新协议缺陷；需增加背景workflow跨回合/重开边界实测，不把turn/end等同workflow结束 |
| `server/first-token.ts` | DSH first-token移植、compact run重建 | 复用语义方向正确；应增加与受支持DSH版的行为差分检查，不仅检查符号存在 |
| `server/frame-reader.ts` | 所有分帧/报错/溢出代码 | 线性扫描与有界未结束帧正确方向；256Mi code units不是总内存预算，orphan桶数量和整帧JSON解析峰值还需系统限界 |
| `server/locale.ts` | env优先级、中英文标签、runtime值保留 | wire值未本地化正确；P003审批文案和canary的locale仍不完全统一，交客户端报告合并处理 |
| `server/rewind-canary.ts` | 文案唯一性/时序机制 | 当前可解释降级合理；不应为省一次点击引入跨插件reload循环 |
| `server/json-value.ts` | 本地结构类型与旧宿主安装边界 | 合理兼容适配，不能简单恢复对protocol的运行依赖 |
| `shared/jobs.ts` | Zod状态、job字段、RPC可用性、live判断 | 对未知job状态会失败而非伪装空列表是正确；`available`与error关系可用判别联合表达以缩小无效状态 |
| `shared/provider.ts` | 单一provider id | 正确避免两端常量漂移 |

### 说明与未计入缺陷的判断

- 未把“原生Paseo工具不注入”当作没有工具：MCP通道存在，native-tool contract属于宿主缺口。
- 未把归档全局单进程语义、env不同的已知告警、子provider只读或审批root-only直接当新缺陷；S08是识别出忽略键的实际错误消费者。
- 没有靠当前47个回归的通过证明上述场景正确；大多数现有测试缺少跨路径组合和成功状态的反向对照。
- 没有真机iOS/Android截图验收、没有新真实模型回合、没有load测试/堆快照；不能据本报告声称已验证线上表现或最大容量。

## 5. 优化方向（按依赖排序）

1. **先统一会话事务和状态权威**：native/provider双身份的open事务、close失效、commit-before-publish、回执后提交配置、capability由同一data source派生。上述S01-S04应先于“拆大文件”。
2. **给桥协议加版本与结构化结果**：中间协议虽然自有，也应有显式version/features与请求/响应校验，特别是 jobs、permissions、plan、projections。未知字段/能力不可伪装成功；not-initialized重试应匹配结构化错误码，不靠错误文案子串。
3. **收敛重复状态**：route.reasoningEffort与#thinkingOption、预留turnId与真正回合开始、live/replay的child终态，分别以清晰的authority和generation管理。目标是减少难以组合验证的独立缓存，而不是按行数机械拆分。
4. **保持direct provider，降低DSH内部API散落**：将DSH版本差异收敛在bridge adapter；Paseo contract的移植部分保持与支持版的差分检查。不要同时维护两个live streaming channel。
5. **性能先量后改**：长会话history帧分段/背压、per-session处理预算、最大在飞RPC/字节数、timeline完成项退场；指标至少含打开耗时、首delta延迟、IPC字节、replay峰值RSS、孤儿桶数量。单个frame 256Mi上限不足以约束整个连接。
6. **池策略不能独立于身份和registry**：保留单池作为默认可用配置；先修Paseo caller identity，明确哪些env可按session投影，哪些需要隔离。需要多池时应同时设计archive state权威、跨进程写入同步、同native session唯一owner，先有协议再换pool key。
7. **部署改为可校验的代际产物**：bootstrap准备完整桥代际并校验hash，切换失败保留上一版；健康检查明确分“已安装”“协议兼容”“真回合通过”，不能一个doctor绿灯代表全链路可用。
8. **测试从单分支扩到组合边界**：inflight holder×close、catalog×session.config、正常prompt预留id×stats、completed child×进程退出、两个label时序；这类边界比继续增大正向fixture数量更有收益。
