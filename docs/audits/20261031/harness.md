# harness 全量入口与判据审查（2026-10-31）

基线 `9298c28`。已清点 `harness/` 全部 **68 个文件**，逐入口检查依赖、执行边界、环境、文件/进程副作用、判据构成与清理。完整矩阵见 `harness-inventory.csv`（68 行，已程序比对目录，无漏项）。大表格样式/locale 断言归为数据契约覆盖，未把数百条常量逐一重新验算。主编已审的 `plugin-build.cjs`、`dsh-api-contract-check.mjs`、CI、`p003-live-support.mjs` 不重复裁决。

**本文件不是“68 个测试全绿”的声明。** 主编本轮跑的 47 个离线/假桥/宿主模块脚本与真实模型/daemon 脚本严格分开。这里未调用模型，未启动真实 `tools.mjs`、`route-test.mjs`、profile 或 daemon。新增仅 4 项原判据的纯离线反例。

## 结论

测试体系已经能捕获许多协议形状、错误码与生命周期回归；最明显的强项是负向用例、部分变异验证、真实编译产物、死进程/多会话测试、原生宿主模块 canary 验证。问题不是简单的“测试太少”，而是**通过的断言与其宣称证明的结论之间仍有空隙**：

1. 某些“真实回合”探针只判断任何文本或关键字，没有证明目标回合成功、附件抵达或模型切换真正生效。
2. 同一个状态可以被多层模拟，却缺跨进程持久状态、后台子写入与回滚事务这些组合；新增 BR-01/BR-02 正好落在缝隙。
3. 测试种类只写在 531 行 AGENTS 和各脚本头部，缺可执行的分层清单。一个 glob 或只看 exit 0 很容易把诊断、跳过、真实模型和离线门混成一类。
4. 入口周边重复实现 NDJSON、轮询和清理；即便产品协议已修，诊断脚本仍会保留旧协议与旧计时器。

## T01 · P2 · route-test 可把失败标为 WORKS，所有失败仍正常退出

- 位置：`harness/route-test.mjs:118`、`:124`、`:134-140`；计时器另见 `:55-61`。
- `verdict = result.text ? 'WORKS ' : 'FAILS '` 忽略已经收集到的 `result.failure`，没有等待匹配的 `turn/end completed`。模型流出前缀后失败仍打印 WORKS。所有路由返回 FAILS 时也没有非零 exit。
- 固定等 25 秒后 kill 会把慢但正常的回合当失败，也可能把未完成但已出前缀的回合当成功；每个 90 秒 RPC 定时器既不清除也不 unref，结果打印完可能继续占用事件循环。
- 纯离线反例：提取**原脚本最后一段 loop**，用完成的 RPC 观测值替代真实模型：`text="partial answer", failure="fatal turn error"` 输出 `WORKS ... err=fatal turn error`；`text="", failure="fatal turn error"` 输出 FAILS，但控制流 exitCode 仍 0。
- 修法：结果应显式分 `completed/failed/canceled/timeout/unknown`，按 sessionId+turnId/本次事件边界等待终态；诊断可继续逐路由收集，最后按失败数/不确定数返回非零。RPC timer 在结算时清除；支持预算但不靠“睡够就 kill”推断成功。
- 门禁：流出文本后失败、无文本正常终态、超时、取消、stderr-only 崩溃、未知目录、全失败/部分失败的退出码；不调用真实模型也能覆盖判据。

## T02 · P2 · tools.mjs 仍用旧 initialize 形状，当前桥必拒绝后续 prompt

- 位置：`harness/tools.mjs:73`（只传 cwd）对比 `:76-77`（prompt 带 SESSION_ID）；副作用 `:10-18`、计时器 `:25-33`。
- 多会话桥要求 `initialize` 与 `session/prompt` 使用相同 sessionId。这个诊断入口没有随 `probe.mjs` 等一起迁移；它不能再完成宣称的工具可见性回合。
- 纯离线反例：从原脚本提取 initialize 调用，得到 `{cwd:"/tmp"}`；将它传给真实桥 `initialize`（无模型/持久化 recording service），再调用该会话 prompt，真实桥拒绝：`not initialized for session ...`。
- 附带问题：入口启动即创建 `harness/frames.jsonl`，默认继承真实 profile/env；每个 180 秒 RPC timer 不清除、不 unref，失败也可能迟迟不退出。这是**真实 profile 诊断工具**，不能放进离线 glob。
- 修法：移到统一 probe transport，session identity 在 helper 创建时一次生成并用于全链；默认输出到私有 evidence 目录；计时器与退出一并治理。
- 门禁：在 fake peer 上执行入口的协议序列（不跑真实模型），要求 initialize/sessionId 匹配；显式配置未知方法时报错；失败后无存活 timer/子进程。

## T03 · P2 · plugin-check 先过滤助手行再验邻接，碎片判据会假绿

- 位置：`harness/plugin-check.cjs:464-479`，折叠 helper 在 `:89` 起。
- 注释要验证“reasoning 插在助手快照之间导致碎片”，输入却先过滤为**只有 assistant_message**，把造成不邻接的 reasoning/tool/plugin 行删掉，再调用折叠器。
- 纯离线反例：使用原 `projectTimelineLikePaseo`，序列 `assistant A → reasoning THINK → assistant AB` 完整输入得到两条 assistant 行；经过原判据的 assistant-only 过滤只得到一条 AB，因此判据通过。
- 修法：保留完整时间线顺序与真实 turn/session 归属，先走宿主真实投影或版本固定的契约 oracle，再按目标 messageId 计数。不能在测试前删除可能打断邻接的行。
- 门禁：reasoning、tool、plugin stats、重试 attempt 各自插在快照间；同类型不同 id；跨 turn/session；durable 第二 id。`assistant-stream-check.cjs:211-225` 已比这条更好（保留 reasoning），应统一为同一全事件序列 oracle，而非复制又漂移。

## T04 · P2 · 图片抵达证据能被提示词要求的 IMAGE-SEEN 自我满足

- 位置：`harness/plugin-check.cjs:359-360`、`:487-509`。
- 输入提示要求模型回复 `IMAGE-SEEN`；断言从非 user 行收集文本并匹配 `/image|图片|.../i`。删除 user 回显只堵住了第一层自我满足；模型按文本指令回复 IMAGE-SEEN 本身依旧通过。
- 纯离线反例：使用原正则，零 image block 的合成 assistant 回复 `IMAGE-SEEN` 返回 true。
- 限定：这证明**这条判据不能证明附件抵达**，不宣称真实模型在任意删图变异下整套 plugin-check 必通过；本轮未跑模型变异。
- 修法：协议层检查下游真实请求/attachment admission 的图片块与 ref；对 text-only route 检查可结构化辨识的明确降级事实，不能匹配模型复述的泛词。视觉行为验收使用提示文本没有提供答案的随机图案/颜色，但它应是独立真机项，不替代协议证据。
- 门禁：删图变异必须让协议断言变红；仅保留提示词时不能过；mime 与 bytes 不一致、text-only route、attachment admission 失败分别有明确结果。

## 4 个反例的复跑

```bash
python3 docs/audits/20261031/reproductions/run.py --case harness
```

该脚本只提取原判据/请求语句做 VM 演算，T02 另调用真实 bridge 的无模型逻辑；结果为 `test-results.json`。exit 0 表示反例被确认，不是产品修复通过。

## 执行边界与副作用审查

逐文件内容以 CSV 为准；以下是运行器必须保留的分类：

| 类别 | 代表入口 | 应如何计数/执行 |
| --- | --- | --- |
| 纯模块/编译模块 | timeline、tool-call、locale、surface、sweep | 离线；编译树新鲜度必须可信；表格断言不声称真机渲染已验 |
| 真实模块 + 合成服务 | bridge-server、p003-bridge、context-usage、replay-turn | 离线；能证明真实方法的分支，不能证明 mock 后面的真实 DSH/宿主 |
| 假 DSH stdio | subagent、steer、multi-session、crash、permission、injection | 私有 DSH_HOME；通过真实插件传输，但 DSH agent/persistence 的语义仍未经过 |
| Loopback MCP | mcp-http、mcp-stdio、gateway-*、probe-check | 无外部服务；仍会起进程/端口和写临时图片，不等于零副作用 |
| 真实宿主模块 | host-contract-sim、jobs-popover 的 HOST_APP 半边 | 无 daemon/model；要求记录宿主源码 hash/version；原版和补丁版分别统计 |
| 真实 profile 的目录/registry | catalog、archive-registry | 无模型回合意图，但会装载真实 profile；自定义插件 startup 行为不受“只发只读 RPC”保证 |
| 真实 profile/模型 | probe、tools、route-test、stream-probe、subagent-live、rewind-e2e、rewind-merge-e2e、plugin-check | 不进离线集合；可能写持久会话、journal、原始 frame；plugin-check 还会重写 profile 内嵌桥 |
| 私有 profile/真实模型 | p003-live-check、p003-approval-preflight | 不是离线；复制现有凭据到私有 profile，需清理与独立 token 预算/授权范围 |
| 真实 daemon/模型 | rewind-native-check | 真宿主请求链，创建 agent/回合/撤回；不是前述 bridge e2e 的替代别名 |
| 读取真实会话日志 | session-calls、replay-fidelity-probe | 只读但涉及用户内容；无输入/不可解码/未覆盖场景应单独报 incomplete |
| 基础设施 | plugin-build、source-shape、fake-dsh-bridge、p003-live-support | 不计作“通过了一个测试”；它们决定其他测试是否可信 |

### 已存在的好做法应保留

- 假 DSH 主测试明确设一次性 DSH_HOME 和 scripted DSH_BINARY；crash 类只杀自己生成的 pid。
- 多会话/并发 open 既断言失败方，也断言幸存会话仍能继续；这比只看 error 字符串强。
- p003-permission 使用真实 DshProcess + DshSession，身份/晚答/取消卡/断进程不只是 object-level mock。
- jobs-popover 缺 HOST_APP 返回 2（incomplete），而不是把半次检查当全过。
- frame-reader / transport-frame 使用旧实现 oracle 和随机分块，既检查正确性又防平方级扫描。
- 表格/locale 的逐项覆盖有合理价值；不应为了减少断言数量直接删掉。

### 残余风险和需要澄清的门禁（未另算 T05+）

- `replay-fidelity-probe.mjs:80-82` 无日志时 SKIP exit 0；有日志但无目标时也跳过合成 rewind 一半。运行器应根据结构化 coverage 判断 complete，不只依据 exit。
- `probe.mjs:141-143` 没收到问题只打印 `!!`，后续配置读取可成功，最终仍 exit 0。它是诊断，不应被解释为“提问卡链路通过”。
- `plugin-check.cjs:244-260` 选择 danger-full-access，等待谓词没有本次 mark/requestId，可能命中打开时已有的相同配置；image 回合完成等待 `:366` 也未按 imageMsgId 过滤。建议统一阶段游标/turn identity，而不是继续逐条补 untilSince。
- `rewind-native-check.mjs:135-148` 等 `status !== running` 可能在发送请求后、回合实际启动前就命中 idle；`:223-228` 可读到上一条 assistant。真正端到端应记录 send 对应的回合/用户消息并等待它的终态和后续 assistant。
- `session-calls.mjs:140-151` 按 tool name 收集整份日志最后一个 schema，再用于所有历史 call；同一会话升级/工具重配后，它不一定是当次调用见过的 schema。应按 turn/step/request/header 时序绑定；缺 schema 或不可解析参数应返回 incomplete，而不是把没审到的调用从 invalid 计数里消失。
- `image-host-path-check` 使用真实 UID temp cache（测试 digest），`mcp-gateway-guard-check` 写出的 image temp dir 没有整体 finally 清理。设置 DSH_HOME 不覆盖 TMPDIR；统一 runner 应在首次 import 前隔离全部 temp root。
- 多个真实探针各自实现 pending Map/JSON parse/catch continue/kill；协议失效时诊断可能把错误帧直接吞掉，最后只剩 timeout。应以测试身份使用同一个严格传输 helper，不能拿静默忽略当稳定性。
- `source-shape.cjs` 已比格式正则好，但仍是 463 行定制子集解析器。项目本来已有 TypeScript，适合逐步用 TypeScript AST 实现相同查询接口；对解析失败返回明确 incomplete/fail，保留格式扰动和删接线的正反用例。

## 可执行的精简方案

### H1：一份机器可读测试清单，运行器 fail closed

以本次 CSV 为初版，转为仓库维护的 `harness/manifest.*`：每项列 mode、area、required versions、needsBuild、needsHost、needsProfile、usesModel、mutatesProfile、writesState、timeout、evidenceType。入口只允许显式选择集合：offline、fake、real-profile、real-daemon，默认绝不运行后两类。

结果统一为 `{status:pass|fail|incomplete|skipped, cases, assertions, testedVersion, sourceHash, artifacts}`。exit 0 且 0 cases、不满足所需场景、缺 HOST_APP、无日志等都不算 release pass。**不把 helper 或表格一行当端到端覆盖数量。**

### H2：集中 transport、阶段等待和资源清理

- 各 raw bridge 探针复用一个严格 JSON-RPC client：先分 request/notification/response，JSON 错误可见，pending 有 timeout/abort/exit drain，结算清 timer。
- `expectTurn` 必须接 sessionId + clientMessageId/turnId + event start cursor；终态成功、失败、取消分开；禁止用“有文本/不是running”代替成功。
- 每个 suite 在独立 Node 进程运行；统一创建私有 DSH_HOME/PASEO_HOME/TMPDIR，剥离真实 `DSH_BINARY`、调试日志路径和有副作用启动钩子，所需 package 路径只读传入。不能在同一个进程里并行改 `process.env`。
- 保留主编已审的构建新鲜度逻辑；一次冻结构建供多个独立进程读取，资源目录分开。清理使用 exact-owned handles/dirs 与 finally，不能按 `/tmp` 前缀全局清扫。

### H3：减少重复 fixture，实现更多跨层负向门

- 把 fake-dsh-bridge 的协议字段与场景 fixtures 独立；严格默认，不让测试通过 opt-out 成为常态。
- 补一组真实 bridge + synthetic DSH service 的“事务/持久状态”测试：重启后的 capture 顺序、child 写入跨 rewind 边界、plan false resume、signal/structured content。它们不耗 token，收益远大于再添一组静态源码正则。
- 统一全事件序列的宿主投影 oracle，固定真实宿主版本并记录 fork 偏差；不要先过滤想忽略的行。跨版本升级门让实际 host module 对同一 fixture 执行，而非无版本地复制函数。
- 大型 style/locale/tool 表保留为数据 fixture，行为和失败路径另分组；只减少重复 harness scaffolding，不删有产品依据的断言。

### H4：少量但强的真实验收矩阵

固定私有 base+bridge profile，外部 route/credentials 以受控方式传入；每次真实验收只挑关键交互：实际换模型后检查 DSH request/header、图片块/attachment admission、取消期间 MCP、父子后台写入与撤回、冷重开、真实宿主的 history/turnId。真实模型、真实 daemon、iOS/Android UI 各自记录，任何一层的绿不替代另一层。

## alpha installModelSelection 独立核实

主编下载的真实 `0.2.2-alpha.2` npm 包已复核，结论与主编一致：

| rc.5 | alpha.2 | 对当前桥的影响 |
| --- | --- | --- |
| `dsh-agent/lib/index.js:166` 的 `installModelSelection(ctx, selection)` 注册 assemble/request/pre-step，并从 selection.current/assembled 改实际请求 | alpha `lib/index.js:231` / `types/model-selection.d.ts:56` 为 `installModelSelection(ctx)`，只装 pre-step 模型切换提示 | 现桥 `server.js:3184` 的第二参会被 JS 忽略；`:1148` 修改 selection.current 不再驱动实际请求 |
| selection ref 是调用方拥有的路由控制器 | alpha `AgentModel.current()/select()` 与持久 modelSelection projection 是实际控制；ACP session 用 `handle.agent.model` | 升级必须移植官方 ACP 的当前控制路径，并用 request/header 验证 provider/model/effort，不能只看 config 回执 |

这证明“符号存在 + typeof function + doctor 全绿”不足以放行升级。**不是说 sessionProjections.snapshot 已变 async**：主编已比对 alpha d.ts，它仍同步，先前候选已撤回。该函数的语义迁移是已核源码事实；本轮没有把混装 alpha 运行在 live profile 上。
