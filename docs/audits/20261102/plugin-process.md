# paseo-plugin/server/dsh-process.ts 全量审查

- 审查对象：`paseo-plugin/server/dsh-process.ts`（2816 行，当前 HEAD `2f71225`，工作区干净）
- 审查方式：全文逐行读审 + 对照 `provider.ts` / `session.ts` / `dsh-bridge/lib/server.js` / 已装宿主 `plugin-provider.js` 追调用链；两个独立假桥探针（源码编译产物复制到 `/tmp/pp-audit`，未写入仓库）验证关闭时序。
- 基线：`docs/FULL-AUDIT-20261031.md`（代码基线 `9298c28`）与 `docs/FIELD-NOTES.md` 第 69–71 条。
- 边界：只读；未启动真实 daemon / 真实模型回合，未写真实 `~/.dsh` profile；未运行整套 harness（由 task-20 统一执行）。本文只改本文件。

## 0. 与基线的差异（先回答“新引入”）

`git diff 9298c28..HEAD -- paseo-plugin/server/dsh-process.ts` 只有 **10 行新增**：`DshJob.description?: string` 字段及其注释（`dsh-process.ts:199-215`），无任何行为变化。

`cedeaf3`（usage 修复）只改了 `provider.ts`、`session.ts`、`harness/context-usage-check.cjs`，**没有改 `dsh-process.ts`**。本文件内所有发现均为**基线已有**；第 3 节第 7 条单独给 cedeaf3 在本文件相关链路上的核查结论。

## 1. 结论

`dsh-process.ts` 是整条链路里成熟度较高的一块：分帧已线性化且有上限，stdin 异步 EPIPE 有监听（FIELD-NOTES #70 的修复在位），进程退出扇出、多会话路由、MCP 白名单/SSE 拒绝、`__proto__` 防护都写得比较扎实。没有发现 P0/P1。

主要风险集中在两类：**关闭语义的跨层竞态**（关掉的会话仍可能收到插件发出的 `session/prompt`，桥侧会重建 agent）和**无总量预算**（出站写无背压/在飞请求无上限、orphan 缓冲只有单生产者上限）。另有几处“注释比实现强”的死机制（`#awaitClose`、`setHandlers`、`mounted:false` 分支）需要收口。

## 2. 发现清单

格式：`ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有`

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| PP-01 | P2 | `paseo-plugin/server/dsh-process.ts:1903-1911`、`:1935-1936`、`:1262-1276`、`:2314-2317`；对照 `dsh-bridge/lib/server.js:1058-1068`、`:3318-3329` | 关闭与在途请求竞态：`prompt()` 在 `await #ensureSessionReady()` 之后才写 `session/prompt`，而 `detachSession()` 只删本地 handler、`#request()` 只校验进程级 `#closed`，不校验会话是否仍被 attach。若 close 落在该 await 窗口（可复现路径：prompt 自愈期间先删 `#readyTasks` 再走真实 `initialize`/`mcp/set` I/O），帧序变成 `session/close` → `session/prompt`；桥的 `closeSession` 刻意保留 `initializedSessions`（server.js:3318-3329），`prompt` 闸门据此放行并 `getOrCreateSession` 重建 agent | 实测（/tmp 假桥探针 1：线上顺序确为 `session/close sess-A` → `session/prompt sess-A`，prompt 仍返回 messageId）+ 源码推断（桥侧重建链） | 基线已有（3a5cfc0 一进程多会话引入 `#ensureSessionReady` await；cedeaf3 未触及） |
| PP-02 | P2 | `paseo-plugin/server/dsh-process.ts:2338-2344`（`#send`）、`:2314-2336`（`#request`/`#pending`） | 出站无背压、无总量预算：`stdin.write()` 返回值被忽略，没有 `drain` 等待；`#pending` 与待写缓冲都没有条数/字节上限。图片附件/大 tool 参数让单帧到几百 KB～几十 MB，慢或半死的子进程会把 JSON 串与管道缓冲堆在内存里；所有请求共享 120s 默认超时，一个卡住的桥会让在飞请求越积越多 | 源码推断（基线报告 §4 已把“整帧/在途 RPC 无总预算”列为已知方向，未计入 P 项） | 基线已有 |
| PP-03 | P3 | `paseo-plugin/server/dsh-process.ts:1302-1309`、`:1322-1356`、`:1379-1395`（常量 `:371`、`:382`） | `#awaitClose` 实际不等待：`#sendClose` 把 `#request("session/close", …, 10s)` 的**超时异常自己 catch 掉并正常 resolve**，`closeSession` 的 `finally` 随即删除 `#closeTasks` 记录；下一次 `attachSession` 读到的 map 已空，`CLOSE_PENDING_TIMEOUT_MS = 35s` 分支不可达（连“previous close … still waiting”日志都打不出来）。真正的“等 dispose”只剩桥侧 `#trackTeardown`（30s）；超过 30s 时两侧都不再等，首回合会碰写租约 | 实测（/tmp 假桥探针 2：close 被扣住 → `closeSession` 10002ms 返回；紧接着 reopen 仅 2ms；无任何“still waiting”日志）+ 源码 | 基线已有（`FULL-AUDIT-20261031` server.md 已提示同一处，未列 P 项） |
| PP-04 | P3 | `paseo-plugin/server/dsh-process.ts:1079`、`:2658-2709`、`:1706-1726` | orphan 缓冲只有**单生产者**上限 1024（`:343`），桶数量与总内存没有全局上限；一个桥 bug/异常会为任意多个 child id 各持 1024 帧达 5s。子进程退出时 `#exitAll` 不清理 orphan 桶与定时器，5s 后会对已死进程打“no ancestor announced”误导日志 | 源码推断（基线 §4“orphan 桶数量…需系统限界”） | 基线已有 |
| PP-05 | P3 | `paseo-plugin/server/dsh-process.ts:2747-2763` vs `:2789-2808` | `#replayOrphans()` 直接调用 handler，只用同步 `try/catch`；若 handler 是 async（TS 的 `void` 返回槽允许赋 async 函数），其 rejection 会成为 unhandled rejection。live 路径 `#deliverLive` 明确对 thenable 做了兜底，replay 路径没有；Node 默认会终止这个**共享**插件进程，连带所有会话 | 源码推断 | 基线已有 |
| PP-06 | P3 | `paseo-plugin/server/dsh-process.ts:2618-2625` | 响应帧 `error: null`（畸形/异版本桥）时：`error !== undefined` 成立，随后读 `error.message` 抛 TypeError；而 pending 条目已在 `:2621` 删除且未 settle，请求只能等自己的超时（最长 120s），现场只留一条 “dispatching a bridge frame failed” 日志 | 源码推断；未构造畸形桥实测 | 基线已有 |
| PP-07 | P3 | `paseo-plugin/server/dsh-process.ts:2338-2344` | `#send` 的同步写异常只 `onProtocolError`，不 reject 对应 pending 请求；异步 EPIPE 路径有监听（`:1452-1456`），同步异常路径会把请求挂到超时。触发条件是 stream 已 destroyed/写入参数异常这类同步抛错 | 源码推断 | 基线已有 |
| PP-08 | P3 | `paseo-plugin/server/dsh-process.ts:1397-1401`、`:1457-1461` | `start()` 用 `#initializeTask ??= this.#start()` 永久 memoize；spawn/initialize 失败后同一 `DshProcess` 每次 `start()` 都返回同一个 rejected promise，没有重试或复位。当前 pool 在 `provider.ts:619-627` 失败即 kill 并丢弃该 child，影响被限制在对象误用；但公开 API 没有说明“失败后不可复用” | 源码推断 | 基线已有 |
| PP-09 | P3 | `paseo-plugin/server/dsh-process.ts:1172-1188` | `setHandlers()` 是 parked-pool 时代接口，全仓生产代码已无调用（`session.ts:607` 明确写“must not be used here”）。它无条件重设 `#options.sessionId` 的 handler（构造 id 甚至可能是共享进程哨兵），一旦未来有人复用，会把已 detach 的 id 重新挂回 handler 表 | 源码推断（全仓 grep 无生产调用） | 基线已有 |
| PP-10 | P3 | `paseo-plugin/server/dsh-process.ts:1407`、`:1617-1624`、`:761-806` | `#start()` 对 construction session（pool 的哨兵 id / 一次性 probe）也执行 `#mcpEntriesFor`，从而触发 browser MCP 解析：读 `workspaces.json`、注入 `server_browser`，并把 `[deepseek-harness-native] no browser MCP server: …` 直接写 stderr；这些条目对哨兵会话永远不会被使用。每次 spawn 一条、每次 attach 再一条（探针实测 2–3 条/进程） | 实测（探针 stderr）+ 源码 | 基线已有 |
| PP-11 | P3 | `paseo-plugin/server/dsh-process.ts:1596-1614`；对照 `dsh-bridge/lib/server.js:3045-3060` | `#sendSessionMcp` 的注释把 `{mounted:false}` 当“合法返回、下次 resume 挂载”，但当前桥在 agent 已存在/创建在飞时直接**抛错**，唯一成功回执是 `{mounted:true}`；该分支对当前桥不可达，且真实行为是 late `paseo/mcp/set` 让整个 `attachSession`/open 失败，与注释描述不一致（失败是响亮的，但语义文档漂移） | 源码对照 | 基线已有 |
| PP-12 | P3 | `paseo-plugin/server/dsh-process.ts:1055`、`:1654-1670`、`:2225-2230`、`:2496-2505` | `#childParent` 只删除被 detach 根的后代边，**不删除该根自己的父边**；也从不清理“announce 过但从未 attach 的 child”的边。长进程里这个 map 单调增长；若某 native id 以后又被当作根会话打开/关闭，旧父边可能把仍到达的帧路由到旧父级（`#rootOf` 先查 attached，仍可规避大多数场景） | 源码推断 | 基线已有 |
| PP-13 | P3 | `paseo-plugin/server/dsh-process.ts:1820-1825`、`:2314-2336`；`paseo-plugin/server/session.ts:797-812` | `usage()` 没有会话存活校验，且用默认 120s 超时（`jobs` 是 15s）；正常调用方受 `session.ts` 的 `#closed`/`#process` 守卫保护。若桥返回 `result: null`/`undefined`（畸形/异版本桥），`session.ts:809` 会在 `try` 外读 `snapshot.available` 抛 TypeError，从 `void refreshUsage()`（`provider.ts:1591`）逃逸成 unhandled rejection | 源码推断；未构造畸形桥实测 | 基线已有（cedeaf3 未改 dsh-process.ts；其改动本身未引入本项） |

### 重点说明

- **PP-01 的可达性**：日常 prompt 的 `#ensureSessionReady` 是已兑现的 promise，close 的网络消息不可能插进这个微任务窗口；真正可命中的是 **prompt 自愈路径**（桥路由表淘汰后 `#readyTasks` 被删、`#prepareSession` 走真实 `initialize`/`mcp/set` I/O，持续数毫秒），以及任何调用方在 `attachSession` 未完成时提前发 prompt 的错误用法。前置门槛是桥 `MAX_SESSION_ROUTE_ENTRIES = 500` 的溢出（`server.js:183`，只会在同进程超过 500 个未关闭会话时触发），因此按 P2 记录但标注“门槛高、后果重”：桥侧 `getOrCreateSession` 不看 `closedSessions`（只有 `usage` 看），会为已关闭 id 重建 agent、写租约与模型回合，且此后没有 owner 会再 close 它。
- **PP-03 与基线的差异**：桥侧 `#trackTeardown` 在基线 `9298c28` 已存在（`git show 9298c28:dsh-bridge/lib/server.js` 可查），所以“实际保护在桥侧”不是本轮新引入；但插件侧 `#closeTasks` 的注释与 35s 常量仍是基线遗留的死承诺，建议要么在 `closeSession` 超时后**保留**该 task 到真正 settle（并写明以桥的 30s 为上限），要么删掉 `#awaitClose`/`CLOSE_PENDING_TIMEOUT_MS` 并改注释，别让后来人以为有两层等待。
- **PP-02 的定量依据**：`#send` 一行 `this.#child?.stdin.write(...)`（`:2340`）对返回值 `false` 完全不看；`#pending` 无 `size` 检查。基线报告 §4 已把“单帧字符上限不是连接总内存限额；orphan 桶、pending RPC、整帧 JSON、历史/timeline 缓存仍需测量与背压”列为方向，本轮未做压力实测，因此不升级为 P1。

## 3. 核查通过 / 有意偏差（不作为缺陷）

1. **进程崩溃路径（FIELD-NOTES #70-1）在位**：`child.stdin.on("error")` 有监听并 `#failAll`（`:1452-1456`）；`child.on("error")` / `child.on("exit")` 都做了 fail-all + markExited；`#consume` 对 `#dispatch` 的 rejection 兜底（`:2397-2408`）。
2. **分帧与上限**：`splitFrames`/`createFrameReader` 只扫新增 chunk、残行数组累积、256 MiB 未终止帧上限（`frame-reader.ts:150-227`）；`#consume` 保留空行跳过、畸形行上报后继续（`:2385-2407`）。与 `harness/frame-reader-check.mjs` 的判据一致。
3. **占位 id 未泄漏**：`#prepareProcess()` 发 `initialize` 不带 sessionId（`:1508-1516`），桥侧只写进程默认；探针 1 的 wire 里没有出现 `__paseo_shared_process__`，每个真实会话各自 `initialize <sessionId>`。
4. **MCP 注入**：stdio 白名单只对“本插件自注入”的 `server_browser` 生效（`:867-896`、`:972-986`）；legacy SSE 按名字拒绝（`:914-922`）；未知/缺失 transport 拒绝且不引用 entry（不泄 `env`/`args`/`headers`，`:930-942`）；`__proto__` 既拒绝又用 `Object.create(null)` 兜底（`:558-569`、`:863-866`）；非白名单 stdio 保留原生 `failOnStartupError`（`:897-911`）。
5. **多会话路由**：`#rootOf` 沿 child→parent 链并带 `seen` 防环（`:1636-1646`）；不可路由的 event/status/child-opened 会进 orphan 桶、按 TTL 处理且有溢出日志；`#deliverLive` 同步 throw 与 thenable rejection 都有兜底（`:2789-2808`）。
6. **退出扇出**：`#exitAll` 对非构造会话逐个回调、异常捕获，`#reportExit` 用 `#exitReported` 保证进程级 onExit 只发一次（`:1706-1752`）；子会话先于根的终态由 `session.ts:544-570` 保证（`harness/child-crash-check.mjs` 覆盖）。
7. **usage 读取链路（cedeaf3 专项）**：`dsh-process.ts:1820-1825` 只是把 `paseo/usage` 原样透传，`available:false` 由桥的 `closedSessions` 闸门产生（`server.js:2636-2638`），`session.ts` 的新逻辑已改为“不可用不发布”；本文件没有 cedeaf3 引入的回归。唯一相关缺口是 PP-13（response 形状不校验、无会话存活校验），且并非此次引入。
8. **有意偏差**：`paseo/permission` 只服务根会话（`:2441-2464`），子会话的审批请求直接回 `-32000`；这是“宿主子会话审批通道不能显示卡片”的有意限制（FIELD-NOTES 亦记录需 Paseo 核心补丁），不是本文件新缺陷，但建议在契约文档/能力声明里明确写出，避免被误读为工具审批丢失。

## 4. 测试覆盖缺口（针对本文件）

现有 harness 覆盖了：帧分帧（`frame-reader-check`）、死子进程大帧（`process-crash-check`）、多会话路由/引用计数/close 后 orphan 清理（`multi-session-check`）、子代理崩溃（`child-crash-check`）、MCP 注入翻译（`mcp-injection-check`）。**缺**：

- `SESSION_CLOSE_TIMEOUT_MS` / `#awaitClose`：`multi-session-check` 的假桥立即回 `session/close`，覆盖不到 10s 超时 + 记录被删的死机制（PP-03）。
- orphan 的 `ORPHAN_FRAME_LIMIT` 溢出路径、`#replayOrphans` 的 replay 顺序/异常兜底（PP-04/PP-05）；`multi-session-check` 只测 close 时清理与 TTL 正对照。
- 畸形响应（`error: null`、无 result、string id）与 `#send` 同步抛错（PP-06/PP-07）。
- `#reportExit` 在“构造 id 同时作为真实会话”时的 exactly-once；`setHandlers` 行为；`usage()` 在 close 后的桥侧闸门（`context-usage-check` 用假 transport，不走 `DshProcess`）。
- 浏览器解析发生在 `#start`/placeholder 上的日志与同步 IO（PP-10）。

## 5. 健康度评分

| 维度 | 分数 | 理由 |
|---|---|---|
| 正确性 | 3 | 主路由/生命周期正确，PP-01 关闭竞态可在桥侧重建已关闭会话；PP-03 关等待机制是死代码 |
| 健壮性 | 3 | 帧有上限、EPIPE 有监听；但出站无背压、在飞请求无上限、畸形响应可悬挂、replay async 无兜底 |
| 可维护性 | 3 | 注释信息量大但多处“注释比实现强”（`#awaitClose`、`mounted:false`、parked pool 残留），`setHandlers` 为死 API |
| 契约一致性 | 3 | 与桥的 prompt/close/mcp/set 语义存在注释级偏差；子会话审批限制未在契约文档显式化 |
| 性能 | 3 | 入站分帧线性且受限；出站/orphan 无总预算；每次 attach 同步读 `workspaces.json` |
| 安全 | 4 | MCP 名称/原型/传输防护、不打印 env/args/headers 做得好；畸形帧原文整行入日志（含会话内容）属轻微面 |
| 测试覆盖 | 3 | 关键崩溃/多会话/分帧有回归；关闭超时、orphan 溢出、replay、畸形响应无覆盖 |

**一句总评**：实现成熟度中上，当前没有阻断性健康问题（无 P0/P1）；建议先把 PP-01 的会话存活复检和 PP-02 的出站/在飞预算作为本迭代 P2，其余 P3 成组收口（尤其是把注释与实现对齐、别保留看起来在双保险的 dead code）。

**Top 问题（≤5）**：

1. PP-01（P2）关闭与在途 prompt 竞态 → 桥侧重建已关闭 agent（探针已证线上顺序）。
2. PP-02（P2）出站写无背压、pending 无总量预算（大帧/慢桥内存风险）。
3. PP-03（P3）`#awaitClose` 是死机制，close 的 35s 承诺不可达，实际只剩桥侧 30s。
4. PP-04（P3）orphan 桶无全局上限、退出后定时器还会打误导日志。
5. PP-05（P3）replay 路径对 async handler 的 rejection 无兜底，可终止共享进程。

**建议优先级**：本迭代先修 PP-01、PP-02（各配一个假桥回归：close-during-heal 的帧序断言、在飞/字节上限断言）；下批次按 PP-03 → PP-04 → PP-05 → PP-06/07 → PP-08..PP-13 处理，PP-03 无论修实现还是删常量都要把 `#closeTasks` 注释改成与真实语义一致。**是否有阻断性健康问题：无。**

## 6. 未验证项

- PP-01 只实测到“插件在 close 之后仍发出 `session/prompt`”这一半；桥侧“prompt 会重建 agent”是读 `dsh-bridge/lib/server.js:1058-1068`、`:3318-3329` 与 `getOrCreateSession` 得出的源码推断，未在真实桥上跑出实际 agent/写租约。
- PP-02 未做压力/内存峰值实测（静态缺口 + 基线已知方向）。
- PP-04 未做 orphan 洪水实测。
- PP-06/PP-07/PP-13 未构造畸形桥/同步写失败实测。
- 未运行 `harness/` 套件（task-20 统一执行）；本文的探针只使用 `/tmp/pp-audit` 下的编译产物副本与假桥，不涉及仓库文件、profile 或真实模型。
