# 插件/客户端侧上轮修复核查（fix-verify-plugin，2026-11-03）

- 核查对象：`main` HEAD `0c82df5`（工作区仅 `V1.txt`/`v1.txt` 未跟踪；本 lane 只新增本报告）
- 对照基线：`docs/FULL-AUDIT-20261102.md`（基线 `2f71225`）§10.1 的 p4/p5a/p5b/p6/p7 条目，
  条目原文见该报告 §3.2/§4.1/§4.2 与 `docs/audits/20261102/{plugin-session,plugin-process,plugin-provider,client-jobs,client-toolcall,client-misc,health-crosscut}.md`
- 方法原则：**不采信提交信息**。先 `git diff 2f71225..HEAD` 定位每条修复点，再在当前 HEAD 编译真实模块
  跑修复轮新增回归，并**把 `2f71225` 的源码单独构建后、用同一份 HEAD 检查去驱动**，取得「修前红」对照。
- 环境：Node v22.23.1、DSH 0.2.1-rc.5、Paseo 0.14.0（`HOST_APP=~/apps/paseo`）；
  `paseo-plugin` `tsc --noEmit` **exit 0**；`bridge-assets-check` **exit 0（2/2）**（内嵌桥与 `dsh-bridge/` 一致，
  HC-01 的桥侧修复确实随插件分发）。
- 未执行：真实 daemon、真实 `~/.dsh` profile、真实模型回合、装包、git 写操作。

## 1. 方法

1. **修复点定位**：`git diff 2f71225..HEAD -- <file>` 逐文件读；修复轮之后只有 `e7472be`（jobs-pill 回到
   live-only）与 `88adebb..0c82df5`（撤回提示）改过本 lane 相关文件——`session.ts`/`dsh-process.ts`/
   `bootstrap.ts`/`client/tool-call-data.ts`/`inline-thinking.tsx` 在 `6394809` 之后**零改动**，
   `provider.ts` 之后只增删了 `session.revert` 分支与能力位（与本 lane 条目无关）。
2. **当前 HEAD 实测**：把插件编译到 `paseo-plugin/.dbg-fv`（`harness/plugin-build.cjs`，CommonJS + 假传输/假桥），
   跑本 lane 相关离线回归，记录 exit code 与断言原文。
3. **修前红对照**：`git archive 2f71225 paseo-plugin` 解到 `/tmp/fv-prefix-src`（软链现有 `node_modules`），
   用 HEAD 的 `tsc` 编译到 `paseo-plugin/.dbg-fv-prefix`，再用**同一份 HEAD 检查脚本**的 `argv[2]`
   指向该构建跑一遍（`plugin-build.cjs` 会打印 "freshness not enforced"）。红日志与原始缺陷描述逐条对得上
   （见各表），所以红不是「新检查依赖了修复后才有的模块」这种伪红；CJ-03/CJ-04 等旧实现里根本没有新模块的
   条目另注明为**静态对照**。
4. 证据等级：**【实测】** = 本机命令 + exit code/输出片段；**【静态】** = 源码/`git show` 对照；
   **【未验证】** = 明确未执行。
5. 修前/修后构建产物均在 gitignored 的 `paseo-plugin/.dbg-fv*`（跑完删除）；临时探针在 `/tmp`。

## 2. 逐条状态

状态判据：**fixed** = 当前 HEAD 反例不再复现且有针对该缺陷的可复现证据（本轮统一用「修前构建红、HEAD 绿」双证）；
**regressed** = 修复引入新问题；**still-broken** = 反例仍复现/修复不彻底；**unverified** = 无法在本环境证明。

**汇总：22 条中 fixed 21、still-broken 1（CJ-02）、regressed 0、unverified 0。**

### 2.1 p4-plugin-session（7 条）

| 条目 | 原级别 | 当前状态 | 证据（file:line + 命令/exit code） | 备注 |
|---|---|---|---|---|
| S02 / S-07 / PP-01（catalog 隐藏 Plan 但 session.config 恒报） | P2 | **fixed** | `provider.ts:369-371`（`planMode===false` 过滤）、`:394`（同一数组进 catalog）、`:1600`（同一数组传会话）；`session.ts:546,553-558`（按广告位决定初始 mode）、`:662-690`（未广告不发 setPlan；被拒则回 build + notice）、`:744`（`modes: this.#modes` 原样回发）、`:1780-1794`（plan 未广告时 configure 响亮拒绝）。【实测】`node harness/session-state-check.cjs` → **exit 0，25/25**（"a persisted plan mode does not re-advertise a hidden Plan"、"open does not ask the runtime for a plan capability it does not advertise"）；`node harness/concurrent-open-check.mjs` → **exit 0，15/15**（"session.config advertises exactly the catalog's modes (one capability source)"）。修前构建：session-state **exit 1，12/25**（2 条 S02 断言红）、concurrent-open **exit 1，14/15**，红日志 `catalog=["build"], config=["build","plan"]` | 单源链路完整（catalog→open→configState→configure），且 `new DshSession(` 只有 `provider.ts:1572` 一处调用，`modes` 为必填 |
| S03（配置先提交后 await） | P2 | **fixed** | `session.ts:1719-1745`（model：await 回执后才改 route/thinkingOption、清 usage）、`:1759-1772`（effort：回执后才提交）、`:1786-1796`（mode：`setPlan` 回执后才提交，按 `active`/`pending` 判接受）；`provider.ts:1003-1013`（configure 中途失败时先补发权威 `session.config` 再抛错）。【实测】session-state-check **exit 0，25/25**（"a refused model switch keeps the previous model"、"…does not wipe the known context readout"、"a refused thinking option is not committed locally"、"a refused plan mode is not committed locally"）；修前构建 **exit 1**，这 4 条断言全红 | 失败路径不再留下「本地已改、后端未改」；configure 部分成功时宿主能拿到真实状态 |
| S04 / S-04（切模型不清 thinkingOption） | P2 | **fixed** | `session.ts:1735`（model 回执的 `reasoningEffort===null → undefined`，`:1771` 同理）。【实测】session-state-check **exit 0**（"switching to a model without efforts clears the advertised thinking option"）；修前构建 **exit 1** 该条红 | — |
| S05（预置 turnId 使统计 reset 不执行） | P2 | **fixed** | `session.ts:398`（新增 `#turnStarted`）、`:1668`（预置 id 时置 false）、`:1969-1976`（`running` 状态按 `#turnStarted` 而非 `#turnId` 重置工具/统计，并置 true）、`:2001`（`#completeTurn` 复位）。【实测】session-state-check **exit 0**（"a cancelled second turn does not rewrite the first turn's stats row"、"the third turn counts only its own tool calls"）；修前构建 **exit 1** 两条红 | `turn/end` 与 idle 两条收尾路径都复位 `#turnStarted`（`:2001`），无「下一回合不重置」的漏口 |
| S06（进程退出对已完成 child 发 runtime_failed） | P2 | **fixed** | `session.ts:3010`（`fail()` 前置守卫：`#turnEnded && #turnId===null` 直接 return；子会话新回合开始时 `:2934,2960` 复位 `#turnEnded`）。【实测】`node harness/child-crash-check.mjs` → **exit 0，14/14**（"a settled subagent is not rewritten as failed by the process exit"、"the settled children keep their completed turn in the final event stream"）；修前构建 **exit 1，13/14**，红断言列出 3 个已完成 child 被改写 | 只拦「已终态」的子会话；崩溃时仍在回合中的子会话照常收到 `runtime_failed`（同脚本正对照通过） |
| S07（flush 缺 label 条件） | P3 | **fixed** | `session.ts:2177`（`#onChildOpened` 的 label 闸门）、`:2294`（`#flushPendingChildren` 同一条件）。【实测】session-state-check **exit 0**（"the label-less child is not opened by an unrelated flush"、"the descriptor opens the held child with its real title"）；修前构建 **exit 1** 两条红 | 残余：`#labelWaitExceeded` 是「held 事件 ≥40」而非时间（`:110,2217-2219`，超限打开时打日志 `:2246-2248`），超限兜底打开后晚到的 label 仍无法补 title（`#completeHeldChild` 只对仍在 `#pendingOpened` 的 notice 生效，`:2222-2227`）——触发面窄，见 §3 N3 |
| S-02（prompt 失败清空 turnId → 已 started 回合无终态） | P2 | **fixed** | `session.ts:1496,1558`（仅 `issuedTurn && !#turnStarted` 才清 id）、`:2001`（idle/终态收尾）。【实测】session-state-check **exit 0**（"the idle status still closes the turn it opened (one terminal, same id)"、"a failed slash-skill prompt still closes the turn it started"、"a prompt that failed before starting announces no turn" 正/负对照都在）；修前构建 **exit 1** 两条红 | 未 started 的失败仍会清 id（幽灵 id 不残留），有负向对照 |

### 2.2 p5a-plugin-process（3 条）

| 条目 | 原级别 | 当前状态 | 证据（file:line + 命令/exit code） | 备注 |
|---|---|---|---|---|
| PP-01（close 与在途 prompt 竞态） | P2 | **fixed** | `dsh-process.ts:2016`（进入时记录 attach 状态）、`:2018/:2045/:2056`（等待后、自愈重试前、重发前三次 `#assertStillAttached`）、`:2087-2096`（detach 后响亮抛错，不再写 `session/prompt`）。【实测】`node harness/multi-session-check.mjs` → **exit 0，40/40**（"the close reaches the bridge before any prompt for the closed session"、"…no session/prompt for that session is sent after it was closed"、"…the prompt fails loudly instead of recreating the closed session"）；修前构建 **exit 1，38/40**，红日志帧序 `initialize, session/close, paseo/mcp/set, session/prompt` 且 prompt 被 fulfilled | 只对「进入时已 attach」的会话启用守卫，合成 id 的既有用例不受影响；桥侧重建已关闭 agent 的路径被切断 |
| PP-02（出站无背压 / #pending 无上限） | P2 | **fixed** | `dsh-process.ts:400`（pending 上限 256）、`:415`（出站队列 64 MiB）、`:1181-1183,1232-1233`（可注入上限）、`:2468-2508`（`#request` 先查 pending 上限，写帧同步失败即 reject 并清 pending）、`:2532-2600`（`#writeFrame` 预算=队列+`stdin.writableLength`；`#pumpWrites` 单 FIFO、按 `drain` 续写）、`:2414-2417,3085-3090`（kill/failAll 清队列）。【实测】`node harness/process-crash-check.mjs` → **exit 0，13/13**（"a burst past the outbound budget is refused loudly"、"…the child's stdin is not fed past its own high-water mark while it is not reading"、"a request past the pending bound is refused loudly"、"…the refused frames never reach the bridge"）；修前构建 **exit 1，9/13**，四条全红 | 顺序性由同一 FIFO 保证（同脚本断言跨会话请求顺序）；残余边界见 §3 N4（`#send` 的响应帧在队列满时只记日志） |
| HC-01（分帧双实现漂移：桥侧无上限） | P2 | **fixed** | `dsh-bridge/lib/transport.js:33`（`DEFAULT_MAX_PENDING_BYTES=256 MiB`，与 `paseo-plugin/server/frame-reader.ts` 对齐）、`:118`（可注入上限）、`:230-268`（超限整帧丢弃、含终止符、只报一次、下个 newline 恢复解析）。【实测】`node harness/transport-frame-check.mjs` → **exit 0，26/26**（"the default limit is the documented 256 MiB, same as the plugin side"、"an unterminated frame past the limit is reported exactly once"、"parsing resumes at the newline after the discarded frame"）；`node harness/frame-reader-check.mjs` → **exit 0，32/32**（插件侧 256 MiB 与溢出语义被钉住）。旧桥对照探针：`git show 2f71225:dsh-bridge/lib/transport.js` 中 `maxPendingBytes|onOverflow|DEFAULT_MAX_PENDING_BYTES` 命中 **0**，用 HEAD 检查的溢出用例驱动旧实现 **0 次上报**、`DEFAULT_MAX_PENDING_BYTES=undefined` | 内嵌桥已重生成（`bridge-assets-check` 2/2），不是「源码修了、分发还是旧桥」 |

### 2.3 p5b-plugin-provider（5 条）

| 条目 | 原级别 | 当前状态 | 证据（file:line + 命令/exit code） | 备注 |
|---|---|---|---|---|
| PP-03（bootstrap 非原子替换） | P2 | **fixed** | `bootstrap.ts:112-120`（SHA-256 校验）、`:149-200`（staging 目录逐文件写→回读 size+hash→旧代际 `rename` 让位→`renameSync` 原子发布→失败回滚旧代际→清 staging）、`index.server.ts:62-73`（成功才打 "profile … ready"，失败打 "NOT ready" + 原因）。【实测】`node harness/bootstrap-check.mjs` → **exit 0，16/16**（"a staging write failure throws / the previous generation is still in place and untouched"、"a short bridge write is detected by the size/hash verification"、"the failure log says the profile is NOT ready"、"…never claims `profile ... ready`"、"a successful provision reports the profile ready" 正对照）；修前构建 **exit 1，12/16**，4 条红 | 失败时仍注册 provider（best-effort 可用性）但日志明确 NOT ready，不再把「没装成」说成「ready」 |
| HC-02 / PP-07（用户可见路径失败只进 stderr） | P2 / P3 | **fixed** | `session.ts:1025-1040`（`#noticeHistoryUnavailable` 统一 `session.notice`）、`:1056-1069`（`paseo/history` RPC 抛错也走该通知，不再 stderr-only）、`:662-690`（plan 对账失败：仅请求过 plan 时回 build + "Plan 模式未能同步" notice）、`:1297,1308,1442-1455`（子代理枚举失败点名 notice）；`provider.ts:1673-1715`（preset 被拒 → `openWarnings` → 时间线 warning）。【实测】`node harness/open-degrade-check.mjs` → **exit 0，8 passed**（history 抛错 notice+原因、preset 被拒 notice+请求/实际值、plan 被拒 notice+会话仍 ready、子代理目录失败 notice+原因）；修前构建 **exit 1，1 passed/7 failed**（全部 0 notice） | `available:false` 与 RPC 抛错两种形状都收口到同一通知；preset 从 stderr 升级为时间线 warning（PP-07 一并覆盖） |
| HC-03（catalog 缓存单槽按 cwd 互斥） | P2 | **fixed** | `provider.ts:183`（`CATALOG_CACHE_LIMIT=4`）、`:197-230`（按 cwd 的 LRU：命中重插、超限逐出）、`:254-270`（`loadCatalog` 改用 `cachedCatalog`/`cacheCatalog`）。【实测】`node harness/catalog-cache-check.mjs` → **exit 0，2/2**（"the third request reuses the first workspace's cached catalog (2 probes, not 3)"，实测 spawned 2）；修前构建 **exit 1，1/2**，红日志 `spawned 3 catalog probe(s)` | 有界（4 个 cwd）；>4 个工作区交替仍会 miss，属设计取舍，不是缺陷 |
| PP-05（导入列表丢 cwd 过滤） | P3 | **fixed** | `provider.ts:286-300`（`listDshSessions(probeCwd, {cwd?})`，仅 host 给了 cwd 才加 filter）、`:1251-1264`（`sessions` 请求把 `input.cwd` 同时作为 probe cwd 与 bridge filter 下发）。【实测】`node harness/session-request-check.cjs`（构建目录内跑）→ **exit 0，52/52**（"a sessions request forwards the host cwd as the bridge filter" 实测 `{"cwd":"/tmp/dsh-request-check-…/host-workspace","limit":3}`；"…with no host cwd sends no cwd filter" 负对照）；修前构建 **exit 1**，该断言红（`{"limit":3}`） | 桥侧 cwd 过滤是 realpath 感知的超集预过滤（p2 桥包），插件只负责转发 |

### 2.4 p6-jobs（4 条）

| 条目 | 原级别 | 当前状态 | 证据（file:line + 命令/exit code） | 备注 |
|---|---|---|---|---|
| CJ-01（可见性 vs 完成分组不可达，按用户语义走路线 2） | P2 | **fixed** | `jobs-polling.ts:141-150`（live>0 才可见、label 只数 live、图标可读恒 spinner、`available:false` 保留静态 mark）、`jobs-pill.tsx:525-550`（presentation 唯一来源；`text.liveLabel` 唯一计数文案）、`locale.ts:136-143`（live indicator 语义注释，`idleLabel` 已删）。【实测】`node harness/jobs-poll-check.cjs` → **exit 0，100/100**（含 "the pill's presentation (live-only, ring-only)"）；`HOST_APP=~/apps/paseo node harness/jobs-popover-check.cjs` → **exit 0，218/218**（含 "the idle label is gone"、"the static mark is the explicit baseline branch"）。无修前红：2f71225 本身就是 live-only，CJ-01 是产品语义决策（`e7472be` 恢复路线 2），不是「旧行为坏、新行为好」 | 路线 2 的收尾不彻底：`jobs-pill.tsx:425-431` 的 allSettled 空态分支、`:441` 的 `settledOpen ?? live.length===0` 空闲分支、`harness/jobs-popover-check.cjs:456` 对应源码正则仍在（审查报告路线 2 要求删除）；`OVERVIEW.md:7` 仍写 "total when idle"。见 §3 N1 |
| CJ-02（轮询放大） | P2 | **still-broken（部分修复）** | 已修：`jobs-polling.ts:52-64,176-185`（失败指数退避 8→16→30s + 抖动）、`:278-287,393`（每次轮询结束再排下一次 + 首轮抖动，消除同 tick 齐发）。仍成立：`:52-55` 隐藏/可见**同为 4s**（0 live 全速，`e7472be` 把 6394809 的 `HIDDEN_POLL_MS=15_000` 恢复成 4s）；`jobs-pill.tsx:525-550` 每次轮询仍无条件 `publish()` + `registration.update()`（无变更比较）；返回体仍含全部 settled 历史与原始 command（桥侧 `liveOnly`/增量未做）。【实测】`jobs-poll-check.cjs` **exit 0，100/100**，但断言恰好钉住未修行为："a settled (hidden) pill still polls at the base interval"（`:606-620`）、"the empty answer publishes"（`:624-630`）；旧实现静态对照：`git show 2f71225:…/jobs-pill.tsx` 中 `pageInfo|nextCursor|bridge_too_old|registry_missing|backoff` 命中 **0**、`setInterval` 命中 4 | §10.3 只声明「settled 历史全量轮询」暂缓，未声明 0-live 退避与 publish 去重不做；§10.1 的 fixed 标注过宽。详见 §3 N2 |
| CJ-03（首个 snapshot 忽略 pageInfo） | P2 | **fixed** | `jobs-polling.ts:403-434`（`applySnapshot` 走 `pageInfo.hasMore/nextCursor` 翻页、`MAX_AGENT_DIRECTORY_PAGES=50` 上限、generation/tombstone 防过期页）、`jobs-pill.tsx:556-566`（`listAgentPage` 带 `page:{limit:200,cursor}` 与 abort signal）。【实测】`jobs-poll-check.cjs` **exit 0，100/100**（"agent-directory snapshot pagination" 段：翻页注册、过期页丢弃、tombstone 不被后页复活、无 nextCursor 报错）；旧实现静态对照：2f71225 `jobs-pill.tsx` 无 `pageInfo`/`nextCursor`（0 命中），snapshot 直接遍历 `entries` | >200 agent 的真实实例未构造，行为由假目录页覆盖 |
| CJ-04（终态错误无限重试） | P2 | **fixed** | `shared/jobs.ts:44-48`（`TERMINAL_JOB_ERROR_CODES = bridge_too_old / registry_missing`）、`:176-195`（`jobs.list` 输出加可选 `error.code`）、`dsh-process.ts:442-471`（`withJobsErrorCode`：unknown method→`bridge_too_old`；桥的 "composes no job registry"→`registry_missing`；其余 `rpc_failed`）、`:1949-1967`、`jobs-polling.ts:194-196,317-324`（终态码→置 terminal、停表、摘 pill、日志一次）、`:342-351`（permission 仍走终止路径）。【实测】`jobs-poll-check.cjs` **exit 0**（"the jobs error contract (terminal vs transient)"、"poll controller terminal errors"）；旧实现静态对照：2f71225 `jobs-pill.tsx` 无 `bridge_too_old|registry_missing|isTerminalJobsErrorCode`（0 命中），`dsh-process.ts` 的 `DshJobs.error` 无 `code` 字段 | 桥的 `registry_missing` 文案与插件侧常量逐字一致（`dsh-bridge/lib/server.js:3102` vs `dsh-process.ts:456`），不会因文案漂移退化为瞬态；残余见 §3 N6 |

### 2.5 p7-client（3 条）

| 条目 | 原级别 | 当前状态 | 证据（file:line + 命令/exit code） | 备注 |
|---|---|---|---|---|
| C1 / CT-01（工具失败原因丢失） | P2 | **fixed** | `tool-call-data.ts:164-175`（`ToolCallData.error`）、`:1049-1053`（`errorTextOf` 只认顶层 `error.message`）、`:1315`（仅 failed 行取 error）、`:1536-1560`（`error` 进返回合同、`hasDetail` 计入 error）；`tool-call.tsx:822-846`（head 的 summary 换错误首行、`errorBlock` 去重）、`:938-945`（展开区红色可选文本）；`index.client.tsx:134-140`（renderer schema 加 `error: z.string()`）。【实测】`node harness/tool-call-check.cjs`（构建目录内跑）→ **exit 0，365/365**（含 "a failed write/edit/MCP call keeps its reason"、"…so the reason is the only content the expansion has"、"a successful row has no reason"、"an error on a non-failed row is ignored"、"an unreadable error … yields no reason"）；修前构建 **exit 1，347/365**，13 条 error 断言 + 终端/代理对 5 条全红（`got undefined`）。独立探针（HEAD vs 2f71225 编译模块）：failed write/edit/mcp/shell 的 `error` 由 `undefined` → 真实 message，failed edit 的 `hasDetail` 由 `false` → `true`，成功行 `error=""` | 失败原因、schema、渲染三处同时接线；成功路径有负向对照 |
| C2 / CM-01（思考末帧不落定） | P2 | **fixed** | `inline-thinking.tsx:63`（`SETTLE_WINDOW_MS=300`）、`:73-87`（增长帧不再直接 `return`；`complete` 起 300ms 稳定窗，下一次依赖变化/卸载清定时器，窗口到期自行落定）。【实测】`node harness/thinking-check.cjs`（构建目录内跑）→ **exit 0，51/51**（"the row settles when the last frame both grows and completes"、"a single complete frame does not settle a growing row"、"…and then settles without another host frame"）；修前构建 **exit 1，45/51**（6 条红：grew+complete 同帧不落定、无定时器） | 保留「单帧 complete 不立即落定」的防闪烁语义，同时不依赖额外一帧 |
| CT-02（终端截断） | P2 | **fixed** | `tool-call-data.ts:776-790`（`BODY_LIMIT` 只服务无滚动区的块）、`:1544`（terminal/diff 正文不截断）、`:1040-1062`（截断不切 UTF-16 代理对）；`tokens.ts:1320-1332`（`TERMINAL_OUTPUT_MAX_HEIGHT=224` + 样式函数）；`tool-call.tsx:952-985`（terminal 正文进 224px 纵向 `ScrollView` + `CopyControl` 复制全量正文，运行中/空正文隐藏）。【实测】`tool-call-check.cjs` **exit 0，365/365**（"the terminal body is the whole output"）；`node harness/style-check.cjs` **exit 0，254/254**（"the terminal output scrolls in 224px"、"terminal never folds"）；修前构建 `tool-call-check` **exit 1**（终端正文 6007 字符、带截断标记）。独立探针：7004 字符输入 HEAD body=7004 含尾部 vs 2f71225 body=6007 丢尾；5999 个 x + 😀 截断处 2f71225 留孤立高位代理、HEAD 无 | 与 DSH `TerminalBlock`（全量 + 224px 滚动 + copyText）对齐；移动端超长正文渲染成本未验证（§10.3 已列为暂缓） |

## 3. 新发现（修复引入的问题 / 修复不彻底）

**未发现「修好 A 弄坏 B」的新回归**：本 lane 相关模块的 20 个离线回归在 HEAD 全绿（见 §4），
且 `e7472be` 之后的撤回提示改动没有触碰本 lane 的修复点。以下是修复不彻底/自洽性问题，按影响排序：

- **N1（P3）e7472be 与 CJ-01 路线 2「方向自洽、收尾不自洽」。** 代码/文案/harness 主链已回到 live-only
  （`jobs-polling.ts:141-150`、`locale.ts:136-143`、`README.md:26`、`README.en.md:29`、`paseo-plugin/README.md:123`），
  但三处没跟上：
  1. `paseo-plugin/OVERVIEW.md:7` 仍写 "A background-jobs pill reports DSH jobs (**live count while running,
     total when idle**)"——这是 `c962e7d`（文档同步轮）按 6394809 的「历史可见」写的，`e7472be` 回退代码时未回改，
     与 README 的两处 live-only 文案直接矛盾；
  2. 路线 2 要求删除的死分支仍在：`jobs-pill.tsx:425-431`（`entry.jobs.length===0` → "后台任务都已结束"）、
     `:441`（`expanded = settledOpen ?? live.length === 0` 的空闲分支）、以及钉住它的源码正则
     `harness/jobs-popover-check.cjs:456`。现被注释成「瞬态守卫」，用户可见行为无误，属死代码/测试债；
  3. `e7472be` 把 6394809 的 `HIDDEN_POLL_MS=15_000` 恢复为 4s（`jobs-polling.ts:52-55` 注释自述）。
     这对 live-only 是**必要**的（隐藏是常态，退避会让新任务最多晚 15s 出现），但等于撤销了 CJ-02 的建议①，
     §10.1 没有记录这个取舍，导致 CJ-02 的 fixed 标注失真（见 N2）。
- **N2（P2，即 CJ-02 本体）CJ-02 只修了「齐发」和「失败退避」，放大头仍在。** 0 live 时每 agent 仍每 4s
  一次 RPC（`jobs-polling.ts:52-55`），每次成功轮询仍无条件 `publish()` + `registration.update()`
  （`jobs-pill.tsx:525-550`；宿主 `PluginButtonStore.update` 无条件 replace→publish），返回体仍含全部 settled
  历史与未截断原始 command（桥侧 `liveOnly`/增量未做）。修后 harness 反而把「隐藏仍 4s」「每次答案都发布」
  写成断言（`harness/jobs-poll-check.cjs:604-632`）。建议 §10.1 把 CJ-02 改成「部分修复」，
  §10.3 补记「publish 去重未做、0-live 退避因路线 2 不做」。
- **N3（P3）S07 残余：40 事件超时后仍会永久无标题。** `#labelWaitExceeded` 按 held 事件数
  （`session.ts:110,2217-2219`）兜底；超限打开后 descriptor 才到时，`#completeHeldChild`
  （`:2222-2227`）只更新仍在 `#pendingOpened` 的 notice，宿主又只在首次 `attachChild` 取 title，
  于是该 child 永久无标题。与「无关 flush 提前打开」的原始缺陷不同，这是显式兜底路径，未实测触发。
- **N4（P3）PP-02 边界：队列满时桥发起的响应帧只记日志。** `#send`（`dsh-process.ts:2611-2616`）捕获
  `#writeFrame` 的同步抛错后只调 `onProtocolError`，不 reject 也不重试；它服务的是 tool approval /
  question 的响应帧（`:2721-2733,2787-2808`）。出站队列达 64 MiB（子进程长时间不读）时该响应会被丢弃，
  DSH 侧只能等超时。触发门槛极高，未构造实测。
- **N5（P3）HC-01 边界：超限帧对端只能等超时。** 桥侧整帧丢弃 + 只打 stderr（`transport.js:230-268`），
  没有 `request.failed` 一类回执；Paseo 侧该请求会等到 RPC 超时。相对基线的无界缓冲→OOM 是明确改进，
  但「失败要响亮」只到日志层。
- **N6（P3）CJ-04 残余：终态 entry 留在 controller Map 里。** 终态分支用 `host.removeAgent`
  而非 `remove()`（`jobs-polling.ts:317-324`），entry 仍留在 `agents` 且 `terminal=true`；之后普通
  `upsert` 命中 `existing` 直接 return（`:376-380`），无法恢复轮询（需 drop 再 add 或插件 reload）。
  内存有界（≤agent 数），无用户可见错误。
- **N7（P3 / 未验证）CT-02 的移动端成本。** terminal 正文改全量渲染（`tool-call-data.ts:1544`）
  + 224px `ScrollView`，与 DSH 一致；但一次渲染几十万字符的 `Text` 在 RN 移动端的帧率/内存未验证
  （§10.3 已把「terminal 全量正文的移动端渲染性能」列为暂缓，与此一致）。

## 4. 阴性结论（确认修好的条目）

**21 条判 fixed**：S02/S-07/PP-01、S03、S04/S-04、S05、S06、S07、S-02、PP-01(process)、PP-02、HC-01、
PP-03、HC-02/PP-07、HC-03、PP-05、CJ-01、CJ-03、CJ-04、C1、C2、CT-02。

每条的「修前红→HEAD 绿」对照见 §2 表；共同证据面：

| 检查 | HEAD 结果 | 修前构建（2f71225） |
|---|---|---|
| `session-state-check.cjs` | exit 0，**25/25** | exit 1，12/25（13 FAIL：S02/S03/S04/S05/S-02/S07） |
| `concurrent-open-check.mjs` | exit 0，**15/15** | exit 1，14/15（modes 双源） |
| `multi-session-check.mjs` | exit 0，**40/40** | exit 1，38/40（PP-01 两条） |
| `process-crash-check.mjs` | exit 0，**13/13** | exit 1，9/13（PP-02 四条） |
| `child-crash-check.mjs` | exit 0，**14/14** | exit 1，13/14（S06） |
| `open-degrade-check.mjs` | exit 0，**8/8** | exit 1，1/8（HC-02/PP-07） |
| `bootstrap-check.mjs` | exit 0，**16/16** | exit 1，12/16（PP-03） |
| `catalog-cache-check.mjs` | exit 0，**2/2** | exit 1，1/2（HC-03） |
| `session-request-check.cjs` | exit 0，**52/52** | exit 1（PP-05 cwd 断言红） |
| `transport-frame-check.mjs` | exit 0，**26/26** | 旧桥无上限（探针 0 次上报；源码 0 命中） |
| `frame-reader-check.mjs` | exit 0，**32/32** | 插件侧本来就有上限（HC-01 的另一半） |
| `jobs-poll-check.cjs` | exit 0，**100/100** | 旧实现无 controller（CJ-03/04 为静态对照） |
| `jobs-popover-check.cjs`（`HOST_APP`） | exit 0，**218/218** | 同上 |
| `tool-call-check.cjs` | exit 0，**365/365** | exit 1，347/365（C1/CT-02 18 FAIL） |
| `thinking-check.cjs` | exit 0，**51/51** | exit 1，45/51（C2 6 FAIL） |
| `style-check.cjs` | exit 0，**254/254** | —（常量表） |
| `locale-check.cjs` | exit 0，**269/269** | — |
| `context-usage-check.cjs` | exit 0，**15/15** | —（S03 改了 usage 清理时序，补跑确认无回归） |
| `replay-turn-check.cjs` | exit 0 | —（HC-02 改了 replayHistory，补跑确认无回归） |
| `tsc --noEmit`（paseo-plugin） | exit 0 | — |
| `bridge-assets-check.mjs` | exit 0，**2/2** | —（21 个桥文件逐字节一致，HC-01 修复已内嵌） |

另：修前构建的 `session-state-check` 红日志与原始缺陷逐条对应（`catalog=["build"], config=["build","plan"]`、
`REJECTED_*`/`STALE_*` 语义、`SECOND_TURN_TOOL_COUNT`、`COMPLETED_CHILD_AFTER_PROCESS_EXIT`、
`UNRELATED_CHILD_RELEASES_UNTITLED` 的同形断言），不是「新检查依赖新模块」的伪红。

## 5. 未验证项

- **真实环境层**：未启动真实 daemon、未跑真实模型回合、未写真实 `~/.dsh` profile、未做真机 UI/动画
  ——按任务约束。`jobs-popover-check` 的宿主常量对照用的是本地 Paseo checkout（`~/apps/paseo`），
  未与 daemon 运行时逐字节比对。
- **CJ-02**：RPC 频率/载荷是静态推导（未启 daemon 计数）；「多客户端相乘」未测。
- **CJ-03**：>200 agent 的分页只由假目录页覆盖，未构造真实实例。
- **CJ-01**：真机 popover 在「最后一个 job 结束」瞬间的收起行为未复验（代码层由纯函数 + 源码接线断言覆盖）。
- **S07 残余（N3）**：40 事件超时 → 无标题路径未构造实测。
- **PP-02 残余（N4）**：出站队列满时 `#send` 丢响应未构造端到端实测（只在 process-crash 的假桥上验证了
  拒绝路径与「被拒帧未到桥」）。
- **HC-01 残余（N5）**：超限帧导致对端 RPC 超时未端到端实测。
- **CT-02 残余（N7）**：移动端超长正文的渲染性能未测（与 §10.3 暂缓项一致）。
- **修前红的来源**：`2f71225` 的归档构建里不存在修复轮新增的模块（如 `client/jobs-polling.ts`），
  因此 CJ-03/CJ-04/CJ-02 的「修前」证据是静态源码对照（旧实现无对应代码），不是同脚本红跑；
  其余条目的红跑均为同一 HEAD 检查驱动旧构建。
