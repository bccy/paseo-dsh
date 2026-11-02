# plugin-process lane：`paseo-plugin/server/dsh-process.ts` 全量审查（2026-11-03）

- 审查对象：`paseo-plugin/server/dsh-process.ts`（3093 行，基线 HEAD `0c82df5`，工作区仅有未跟踪 `V1.txt`/`v1.txt`）
- 审查方式：全文逐行读审；对照 `provider.ts` / `session.ts` / `dsh-bridge/lib/server.js` / `dsh-bridge/lib/transport.js` / `frame-reader.ts` 追调用链；自建假桥探针（`/tmp/pp-probe/`）复跑修复点与失败路径；复跑 6 个既有离线 harness。
- 只读边界：未改产品代码/文档/harness，无 git 写操作，未跑真实模型、未写真实 `~/.dsh` profile。**一处探针事故如实记录于 §5.1**。
- 基线对照：`docs/FULL-AUDIT-20261102.md` §10.1 `p5a-plugin-process`（PP-01、PP-02、HC-01）、§4.1；`docs/AGENTS.md`「MCP 注入与 gateway」；`docs/FIELD-NOTES.md` #70。
- 核查的修复轮：`6394809`（声称修 PP-01/PP-02/HC-01）。`git diff 2f71225..HEAD -- dsh-process.ts` 为 +289/−12。

## 1. 范围与方法

范围：`dsh-process.ts` 全文——子进程 spawn/退出、stdio JSON-RPC 客户端、请求/通知分派、出站背压与队列、MCP 注入（gateway HTTP、白名单 stdio、非白名单原生、legacy SSE 拒绝）、取消与关闭竞态、环境变量、错误传播、资源清理、初始化握手。逐行通读，不抽样。

证据分级：【实测】有可复现命令/探针 + exit code 或输出片段；【源码推断】读码得出、未构造运行；【文档】来自仓库文档。探针与命令：

| 探针/检查 | 命令 | 结果 |
|---|---|---|
| PP-01 修复（close 落在 prompt prepare 窗口） | `node /tmp/pp-probe/probe-pp01.mjs` | exit 0，5/5 PASS（红/绿对照） |
| PP-02 背压与在飞上限 | `node /tmp/pp-probe/probe-backpressure.mjs` | exit 0，10/10 PASS |
| PP-03 `#awaitClose` / 35s 分支 | `node /tmp/pp-probe/probe-awaitclose.mjs` | exit 0，6/6 PASS（含 10s 超时场景） |
| spawn 失败路径 | `node /tmp/pp-probe/probe-spawn-failure.mjs` | exit 1（2 项 FAIL = 2 条发现） |
| 畸形响应 / orphan | `node /tmp/pp-probe/scenario.mjs m1/m2/m3` | 各 exit 0（3 条发现） |
| MCP 翻译防护 | `node /tmp/pp-probe/mcp-units.mjs` | exit 0，8/8 PASS |
| 既有 harness（`PASEO_PLUGIN_BUILD=paseo-plugin/.dbg-review-L5`） | `frame-reader-check` 32/32、`transport-frame-check` 26/26、`process-crash-check` 13/13、`multi-session-check` 40/40、`open-degrade-check` 8/8、`child-crash-check` 14/14、`concurrent-open-check` 15/15、`mcp-injection-check` 40/40 | 全 exit 0 |

编译产物只落到 gitignored 的 `paseo-plugin/.dbg-review-L5`（任务结束后已删除）。

## 2. 健康度评分：**4 / 5**

| 维度 | 分 | 理由 |
|---|---|---|
| 正确性 | 4 | PP-01 的 ghost turn 已被实测阻断（close 落在自愈窗口时线上只有 1 个 `session/prompt`）；残留的是 close 后仍重发 `initialize`/`paseo/mcp/set` 的桥表泄漏（PPR-01）。其余会话级方法仍无存活校验（PPR-02，可达性未证）。`#awaitClose` 的 35s 承诺仍是死代码（PPR-03）。 |
| 健壮性 | 4 | 出站背压、队列预算、在飞请求上限实测全部生效，drain 恢复与顺序保持正确；缺口在边界：流已销毁时队列永久冻结（PPR-04）、spawn 失败后 `running` 仍为 true（PPR-05）、畸形响应可悬挂请求（PPR-08）。 |
| 可维护性 | 3 | 注释信息量很大且多数与实现一致，但仍有 3 处「注释比实现强」：35s 双层等待（PPR-03）、`mounted:false` 合法回执（PPR-15）、`setHandlers`（PPR-14）。 |
| 契约一致性 | 4 | `DshJobs.error.code` 的 `bridge_too_old`/`registry_missing` 终态语义实现正确；MCP 翻译的拒绝消息不引用凭据。缺口：`jobs()` 在畸形 `result` 下抛 TypeError 而非 `available:false`（PPR-06），`usage()` 无形状校验（PPR-07）。 |
| 性能 | 4 | 入站分帧线性且有 256 MiB 上限，出站有 64 MiB 队列预算 + 256 在飞上限；单帧超过预算时会被永久拒绝（PPR-11，默认阈值远高于真实帧）。 |
| 安全 | 4 | MCP 名称/`__proto__`/未知 transport/legacy SSE 防护实测全部在位且不泄 env/args/headers；`#send` 在队列满时丢响应帧属可用性面（PPR-12）。 |
| 测试覆盖 | 4 | 崩溃/多会话/分帧/MCP/并发 open 都有回归且全绿；缺「流已销毁」「畸形响应」「orphan 随退出清理」「35s 分支」的判据。 |

**一句总评**：修复轮对 PP-01（ghost turn）与 PP-02（出站无背压）的核心修复**经实测成立**，本轮没有 P0/P1；剩余 18 条 P3 集中在修复的边界条件、既有死机制与畸形输入，建议成组收口而不是逐条单修。

## 3. 发现列表

格式：`ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要`

| ID | 级别 | file:line | 触发条件 | 证据 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| PPR-01 | P3 | `dsh-process.ts:2016-2018`、`:2045`、`:2056`、`:1685-1687` | close 落在 `prompt()` 的 `#ensureSessionReady()` await 窗口内（已证可达路径：prompt 自愈重发 initialize） | 【实测】探针 red 场景 wire 顺序 `initialize` → `session/close` → `paseo/mcp/set`；prompt 被拒、无第二个 prompt 帧 | 修复轮新形态（基线是「close 后发 prompt」；现在 prompt 被拦但 prepare 的两帧仍发出） | `#assertStillAttached` 只护住 prompt 的**最后一帧**；`#prepareSession` 已先发出 `initialize` + `paseo/mcp/set`。桥侧为已关闭 id 重新写 `initializedSessions`/`sessionCwd`/`sessionRoutes`/`pendingMcpServers`，再无 owner 会 close 它们。无功能影响（重开会被覆盖），共享进程长跑下是缓慢表增长。 |
| PPR-02 | P3 | `:1872-1898`、`:1910-1932`、`:1946-1968`、`:2121-2152`、`:2159-2230`、`:2284-2314`、`:2346-2399` | 同上窗口，但调用的是 prompt 以外的会话级方法 | 【源码推断】未构造出可达路径（见下） | 基线已有（PP-01 的同类，修复只覆盖 prompt） | 除 `prompt()` 外，所有会话级方法（commands/runCommand/permission/usage/jobs/setPermission/revert/cancel/plan/config/presets/subagents/history）在 `#ensureSessionReady` 之后**没有存活复检**。若帧在 close 之后到达，桥侧除 `usage` 外都会 `getOrCreateSession`（`server.js:3714`）→ resume 并重建 agent，重新拿写租约，且无 owner 会 close。**可达性未证**：日常调用时 readyTask 已兑现（微任务窗口，close 是宏任务插不进去）；只有 prepare 未兑现（attach 未完成 / prepare 失败）才可达，而 `session.ts` 的 `#require()`/`#closed` 守卫与 open 事务把那些窗口挡住了。故定 P3 并列为「同修复缺口的另一半」。 |
| PPR-03 | P3 | `:1430-1464`、`:1405-1418`、`:1487-1503`、`:377-388` | close 的 receipt 超过 `SESSION_CLOSE_TIMEOUT_MS`（10s） | 【实测】B1：close pending 时 attach 等待 600ms（机制在 10s 窗口内有效）；B2：close 10.0s 超时后 attach 2ms 不等；B1/B2 均未出现 "still waiting for its receipt" 日志 | 基线已有（PP-03 未修） | `#sendClose` 自己 catch 掉超时并正常 resolve，`closeSession` 的 `finally` 随即删除 `#closeTasks`，所以 pending 最长 10s；`CLOSE_PENDING_TIMEOUT_MS = 35s` 的 race 永远由 pending 赢，**该分支不可达**。注释承诺的「两层等待」实际只剩桥侧 `#awaitTeardown`（30s）。 |
| PPR-04 | P3 | `:2558-2587`、`:2532-2547`、`:1560-1564` | 子进程 spawn 失败或 stdin 已 destroyed 后仍对该 `DshProcess` 发请求 | 【实测】`spawn EACCES` 后 `start()` reject，随后 `catalog()` 1.5s 未 settle（挂到 120s 超时） | 修复轮新形态（背压引入 `#awaitingDrain` 状态机） | `#pumpWrites` 对 `write()` 返回 `false` 只等 `drain`。流已 destroyed 时 `write()` **返回 false 且不抛**（实测），`drain` 永不发生 → 出站队列永久冻结，队列里所有请求挂到各自超时；注释「Callers turn that into a rejection/report; nothing is dropped silently」只对同步抛错成立。 |
| PPR-05 | P3 | `:1565-1569`、`:1260-1263` | `spawn` 失败（EACCES/ENOENT） | 【实测】`proc.running === true` 在 `start()` reject 之后 | 基线已有 | `child.on("error")` 只做 `#failAll` + `onProtocolError` + `#markExited`，**不置 `#closed`**（注释「the child may still be running」对 spawn 失败不成立：`exit` 事件不会再触发）。`running` 对 pool/调用方报告「可用」，后续请求按 PPR-04 挂超时。生产路径上 provider 会 kill 并丢弃该 child（上轮 PP-08 已核），影响受限。 |
| PPR-06 | P3 | `:466-473`、`:1946-1968` | 桥返回 `{ result: null }`（畸形/异版本桥） | 【实测】`jobs()` 抛 `TypeError: Cannot read properties of undefined (reading 'available')` | **修复轮新引入**（`withJobsErrorCode` 是 6394809 新增） | `withJobsErrorCode(result)` 直接读 `result.available`；契约要求失败走 `{available:false,error}`，实际是 TypeError 从 `jobs()` 抛出。`jobs()` 的 catch 只处理 `unknown bridge method`，所以调用方看到的是 TypeError 而非「读不到」。 |
| PPR-07 | P3 | `:1928-1933`、`:180-186` | 桥返回 `{ result: null }` | 【实测】`usage()` 返回 `null` | 基线已有（PP-13 未修） | 无形状校验。`session.ts` 的 `refreshUsage()` 在 try 外读 `snapshot.available`（`session.ts:866-880`），会 TypeError 并从 `void refreshUsage()` 逃逸成 unhandled rejection（跨 lane）。 |
| PPR-08 | P3 | `:2891-2898`、`:2670-2681` | 响应帧 `error: null` | 【实测】1.2s 未 settle；日志 `dispatching a bridge frame failed: Cannot read properties of null (reading 'message')` | 基线已有（PP-06 未修） | `error !== undefined` 对 `null` 成立，读 `error.message` 抛 TypeError；pending 条目已在 `:2894` 删除且未 settle → 请求只能等自己的超时（最长 120s）。 |
| PPR-09 | P3 | `:2998-3040` vs `:3062-3082` | 一个 `void` 返回槽被赋成 `async` handler，且帧走 replay 路径 | 【源码推断】未实测（探针环境未稳定，见 §5.2） | 基线已有（PP-05 未修） | live 路径的 `#deliverLive` 明确对 thenable 做 `.catch`，`#replayOrphans` 只有同步 `try/catch`；async handler 的 rejection 会成为 unhandled rejection，Node 默认终止这个**共享**插件进程。 |
| PPR-10 | P3 | `:3084-3092`、`:1814-1834`、`:2931-2982` | 子进程退出时 `#orphanFrames`/`#orphanTimers` 非空 | 【源码推断】`#failAll`/`#exitAll` 都不清理两者；5s 后 timer 对已死进程打 "no ancestor announced it within the hold window" | 基线已有（PP-04 未修） | 误导日志 + 定时器/桶在对象存活期间保留；桶数量本身也没有全局上限（单桶 1024）。 |
| PPR-11 | P3 | `:2537-2543` | 单个出站帧的 `String#length` 超过 `maxOutboundQueueBytes`（默认 64 MiB） | 【实测】小预算下 100 KB 帧被拒，消息 `bound 204800`；单帧超预算走同一分支 | **修复轮新引入**（基线无此上限，帧可直接交给流） | 预算检查 `queued + text.length > max` 对单帧同样生效：一个 >64 MiB 的 prompt 附件帧**永远无法发送**，每次重试都失败，且错误信息是「queue is full」（实际是帧本身超限）。触发门槛取决于 Paseo 附件上限（未验证）。 |
| PPR-12 | P3 | `:2611-2617` | 出站队列满时发送 `paseo/question`/`paseo/permission` 的 **response** 帧 | 【源码推断】 | 修复轮新形态 | `#send` 的 catch 只 `onProtocolError`，响应帧被丢弃；桥侧等待该响应的 question/permission 会挂住（直到桥侧自己的超时/取消）。请求类帧走 `#request` 会 reject，不受影响。 |
| PPR-13 | P3 | `:1762-1778` | 反复 attach/detach 根会话（其自身曾是别人的 child） | 【源码推断】`#forgetChildrenOf` 只删 `id !== root` 的边 | 基线已有（PP-12 未修） | 根自己的父边与「announce 过但从未 attach 的 child」的边从不清理，`#childParent` 单调增长；旧父边可能把仍到达的帧路由到旧父级（`#rootOf` 先查 attached 可规避多数场景）。 |
| PPR-14 | P3 | `:1280-1296` | 任何未来调用 `setHandlers()` 的代码 | 【源码推断】全仓生产代码无调用（`session.ts:607` 明确写 must not be used） | 基线已有（PP-09 未修） | parked-pool 时代接口；无条件重设 `#options.sessionId` 的 handler，若该 id 是共享进程哨兵会把非会话 id 挂回 handler 表。 |
| PPR-15 | P3 | `:1704-1722` | 桥在 session 的 agent 已存在时收到 `paseo/mcp/set` | 【源码推断】对照 `server.js:3340-3395`：当前桥**抛错**，成功回执只有 `{mounted:true}` | 基线已有（PP-11 未修） | 注释把 `{mounted:false}` 当合法返回、`#mcpSent` 仍在抛错前不会置位；真实行为是 late set 让整个 attach/open 失败（响亮），但注释与实现不一致。 |
| PPR-16 | P3 | `:1511-1515`、`:843-888` | 每次 spawn（含共享进程的哨兵会话） | 【实测】探针每个 `DshProcess` 一条 stderr `no browser MCP server: cwd … maps to no single live Paseo workspace` | 基线已有（PP-10 未修） | `#start` 对 construction session（可能是 `POOL_PLACEHOLDER_SESSION_ID`）也执行 `#mcpEntriesFor`，触发同步读 `workspaces.json` + stderr；这些条目对哨兵永远不会被使用。 |
| PPR-17 | P3 | `:1506-1509` | `start()` 首次失败后再次调用 | 【实测】第二次 `start()` 返回同一个 rejected promise（spawn EACCES 场景） | 基线已有（PP-08 未修） | `#initializeTask ??=` 永久 memoize；失败后不可重试，公开 API 未说明。provider 失败即 kill/丢弃，影响受限。 |
| PPR-18 | P3 | `:2040-2057` | prompt 自愈与另一个并发调用共享同一 `#readyTasks` 条目 | 【源码推断】 | 基线已有 | catch 里无条件 `#readyTasks.delete(sessionId)`：若并发调用者正 await 同一 task，新的 `#ensureSessionReady` 会再建一个 task，可能重复发 `initialize`/`mcp/set`（幂等，但多一轮 I/O 与日志）。 |

### 修复轮核查结论（PP-01 / PP-02 / HC-01）

- **PP-01（ghost turn）：修复成立，但不完整。** 红/绿对照实测：自愈路径确实会发第二个 `session/prompt`（绿），close 落在窗口内时 prompt 被拒且线上只有 1 个 prompt 帧（红）。`#assertStillAttached` 的同步位置正确——从 assert 到 `#writeFrame` 之间没有 await，所以 close 只能产生「prompt → close」的安全顺序。残留：prepare 自身发出的 `initialize`/`mcp/set` 仍在 close 之后（PPR-01），其余会话级方法无同类守卫（PPR-02）。
- **PP-02（出站无背压）：修复成立。** 实测：队列预算触发拒绝并点名 bound；drain 后队列按调用顺序排空（`idsAscending`）；拒绝的帧从未进入管道；在飞请求上限按 `maxPendingRequests` 精确拒绝。缺口：流已销毁时队列冻结（PPR-04）、单帧超预算永久拒绝（PPR-11）、响应帧被丢（PPR-12）。
- **HC-01（分帧双实现漂移）：已收敛。** `dsh-bridge/lib/transport.js:16-38` 现在与 `paseo-plugin/server/frame-reader.ts:63-74` 同为 256 MiB，两处注释互相指名并说明被离线检查钉住；`transport-frame-check` 26/26、`frame-reader-check` 32/32 通过。

## 4. 阴性结论（核查通过，不作为缺陷）

1. **PP-01 的 ghost turn 阻断**：实测（见上）。
2. **PP-02 的背压/在飞上限**：实测（见上）。
3. **HC-01 两端上限一致**：源码对照 + 两个离线检查全绿。
4. **MCP 注入翻译防护**：8 项单元测试全过——stdio 非法 `serverName` 拒绝、http 点号名放行、legacy SSE 按名字拒绝、未知/缺失 transport 拒绝、`__proto__` 自有键拒绝、拒绝消息不含 env/args/headers；`mcp-injection-check` 40/40（含 HTTP→gateway、白名单 stdio→gateway、非白名单 stdio→原生 `failOnStartupError`、legacy SSE 拒绝、`mcp-late` 响亮失败）。
5. **死子进程大帧（FIELD-NOTES #70）**：`child.stdin.on("error")` 监听在位，`process-crash-check` 13/13（无 uncaughtException、请求及时失败、失败可见、正对照健康）。
6. **多会话路由与 close 清理**：`multi-session-check` 40/40（含 orphan 清理、环境差异警告、子会话终态）。
7. **open 降级 / 子会话崩溃 / 并发 open**：8/8、14/14、15/15 全绿。
8. **退出扇出与 exactly-once**：`#exitAll` 跳过构造 session 的 `onExit` 并统一走 `#reportExit` 的 latch，异常被捕获；`#approvalRequests` 在 exit 时全部 abort。
9. **占位 id 不泄漏**：`#prepareProcess` 的 `initialize` 不带 sessionId；探针 wire 中未出现哨兵 id。
10. **背压顺序**：单一 FIFO 保持跨会话调用顺序（实测 `idsAscending`），`#awaitingDrain` 保证同一时刻最多一个 drain 监听。
11. **`#request` 写失败立即 reject**：预算/序列化失败路径会删除 pending 并 reject（实测队列拒绝）。

## 5. 未验证项

### 5.1 探针事故（必须知会）

`probe-start-failure` 的第一版把 `DSH_BINARY` 指向一个**不存在的路径**，而 `resolveBinary()`（`dsh-process.ts:549-555`）对不存在的绝对路径会回退到 `"dsh"`，于是**短暂启动了一个真实的 `dsh --profile paseo`**（已随 `kill()` 结束；该 child 只完成了 profile 加载与 `paseo/catalog`，未带 sessionId、未创建会话、未跑模型）。检查后没有残留 dsh 进程（`pgrep -af "dsh --profile"` 只剩用户自己 daemon 的 plugin-process 子进程），`~/.dsh/sessions` 下也没有本探针新建的会话目录。后续探针改用「存在但不可执行」的文件模拟 spawn 失败。这条回退行为本身也说明 `resolveBinary()` 的静默回退会把「配错的 DSH_BINARY」变成「跑另一个二进制」。

### 5.2 未验证项清单

- PPR-02 的非 prompt 可达路径：未构造出（推理上被 `session.ts` 的 `#closed`/`#require` 与 open 事务挡住），**未实测**。
- PPR-09（replay 路径 async handler rejection）与 PPR-10（orphan 桶随退出不清理）：源码推断成立，但探针在子进程退出时自身收到 unhandled rejection（`#failAll` 的 error 被一个探针未 catch 的 promise 接收），未能稳定产出实测输出，**未实测**。
- PPR-11 的真实触发门槛：未查 Paseo 侧附件大小上限，>64 MiB 出站帧是否可达**未验证**。
- PPR-12（队列满丢 response 帧）未构造实测。
- 以上全部在**假桥**上验证；真实 `dsh --profile paseo` 的行为未跑（按审查边界禁止）。
- 未跑 `plugin-check`/`route-test`/`stream-probe` 等耗 token 或需真实 profile 的脚本。

## 6. 跨 lane 提示

1. **bridge lane**：`closedSessions` 闸门只覆盖 `usage`（`dsh-bridge/lib/server.js:2962`），其余会话级方法都走 `getOrCreateSession`（`server.js:3714-3745`）→ 会 resume 已关闭的会话并重建 agent（重新拿写租约）。插件侧只有 prompt 有存活守卫（PPR-02），建议桥侧把闸门提到 `getOrCreateSession` 入口，或在协议层给「已关闭 id」一个明确错误码。
2. **bridge lane**：桥侧出站（bridge → 插件）没有背压/预算；插件侧入站有 256 MiB 上限。大 history 帧仍是单帧无总量约束。
3. **session lane**：`refreshUsage()`（`session.ts:857-880`）在 `snapshot` 为 `null`/`undefined`（畸形桥，PPR-07）时读 `.available` 抛 TypeError，从 `void refreshUsage()` 逃逸成 unhandled rejection。建议在 `dsh-process.usage()` 做形状校验，或在 session 侧兜底。
4. **provider lane**：close→open 的等待实际只剩桥侧 `#awaitTeardown`（30s）；插件侧 `CLOSE_PENDING_TIMEOUT_MS=35s` 不可达（PPR-03）。若 provider 依赖「插件侧也会等」来避免首回合写租约冲突，需要重新评估。
5. **harness lane**：缺四类判据——(a) close 落在 prompt prepare 窗口时**只允许一个** prompt 帧（本轮已用 /tmp 探针覆盖，可提升为仓库回归）；(b) 流已 destroyed 后请求应立即失败而不是挂 120s；(c) 畸形响应（`error:null`、`result:null`）不得悬挂/TypeError；(d) `#awaitClose` 的 35s 分支不可达（若决定保留注释承诺，需要一个判据）。
