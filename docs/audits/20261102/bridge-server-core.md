# dsh-bridge/lib/server.js 前半审查（请求分派 / 会话生命周期 / 权限 / plan / MCP / usage）

- 代码基线：`2f71225`（main，工作区干净）；上一轮全量基线 `9298c28`（报告 `docs/FULL-AUDIT-20261031.md`）。
- 本机运行环境：DSH `0.2.1-rc.5`、Paseo `0.14.0`、Node 22.23.1。
- 只读完成：未改生产代码、未做 git 写操作、未起真实模型回合、未写真实 `~/.dsh` profile、未碰生产 daemon。唯一写入是本文件。

## 1. 结论

**本区域无 P0/P1 阻断性健康问题。** 请求分派完整（24 个 `case` 均调到原型上存在的方法，实测），会话主状态机的失败路径整体是「响亮」的，plan/catalog 在桥内是同一数据源。共登记 **4 个 P2 + 12 个 P3**；其中 P2 全部是**基线已有、本轮仍未修复**的问题，本次 `9298c28..HEAD` 新增的 291 行里新引入 2 个 P3（文件写入票据未随 close 清理、jobs-pill 注释与实现不符）。

## 2. 范围与分界（按文件实际结构，非行号硬切）

任务书写的「前半 1–1800 行含请求分派/生命周期/权限/MCP/usage」与当前文件实际结构不符：文件前 1806 行是构造器 + 事件转发 + `initialize/prompt/cancel/plan/config/presets/sessions/history/subagents/commands/runCommand`；`handleRequest` 在 2944，`setMcpServers` 在 3021，`permission/set` 在 2554，`usage` 在 2634，会话开/关在 3104–3636。按任务书点名的重点，本次覆盖：

- `1–1806` 逐行全量（含所有会话状态表、assistant-stream 转发、initialize/prompt/plan/config/presets/命令目录）；
- `2944–3103`（`handleRequest` 分派表 + `setMcpServers`）；
- `2554–2757`（`permission`/`setPermission`/`usage`）；
- `3104–3636`（`closeSession`、teardown 协调、`#forgetSessionState`、`getOrCreateSession`/`createSession`）；
- `2808–2893`（`catalog`，capability 数据源一致性）。

`revert` 主体（2366–2542）、文件快照/写入闸门（2023–2347）、`jobs`/`projections` 细节属于 task-2/task-3 的分配范围，本报告只在与上述会话状态收尾交叉处点到。

## 3. 方法、已执行检查与证据等级

1. `node harness/bridge-server-check.mjs` → **34/34 PASS，exit 0**（实测）。覆盖：`usage()` 关闭闸门（不复活）、归档状态读取失败点名、`paseo/permission/set` 真的到达 service、以及 `handleRequest` 全部 `case` 调用的方法都在原型上（24 case / 24 method）。
2. 用 `bridge-server-check.mjs` 同款 module resolve hook 加载**真实 `PaseoHarnessServer` 类**，只替换 `ctx` 服务、transport 与 `createSession` 桩，跑合成状态探针（无文件写入、无 profile、无模型）。下文标「实测」的条目即由此得到，探针只断言桥自身的状态与返回值。
3. 逐条对照本机已安装 DSH `0.2.1-rc.5` 的 `.d.ts`/`lib`：`SessionHeader`（无 `updatedAt`）、`AgentSetup` 签名、`PlanModeController.get/set`、`SessionPersistence.open(..., options.signal)`、`SessionHandle.read(offset,length)`、`Agent.runMaintenance` 语义、各 `ctx.get(...)` 服务名与方法名——本区域使用的服务/方法**全部存在且签名一致**。
4. 对照已安装 Paseo `@getpaseo/server@0.14.0` 的宿主消费代码（`agent-manager.js`、`import-sessions.js`、`plugin-provider.js`）核对 `paseo/sessions` 的字段与过滤契约。

## 4. 发现清单

| ID | 严重度 | 位置 | 触发条件 | 证据 | 归属 |
|---|---|---|---|---|---|
| CORE-01 | P2 | `server.js:3606-3614`；`server.js:1115-1123` | 持久会话日志里 plan=true，重开时 Paseo 选 build：`planSet(false)` 先入队，`loadCommands` 之后才建 agent，建 agent 时只应用 `wanted===true`，false 被丢弃 | 实测（探针 `setCalls=[]`、`pendingLeft=false`）+ 基线复现记录 | 基线已有，未修复（BR-05） |
| CORE-02 | P2 | `server.js:1516-1517`、`:1535-1536` | 导入/会话搜索带 `query` 或 `cwd`：桥在返回前用「session id 包含 query / cwd 字符串全等」预过滤，宿主随后才用 title/preview/cwd basename 匹配、并用 realpath 判 cwd，被桥丢掉的候选无法恢复 | 实测（探针：2 条候选、query=标题词 → 返回 0）+ 宿主源码 | 基线已有 |
| CORE-03 | P2 | `server.js:1089-1093`、`:3394` | 冷会话首个 prompt 的 `agents.create/resume` 在飞时用户点停止：`cancel` 走 `requireSession` 直接抛 `unknown or not-yet-created session`；prompt 侧不受影响，创建完成后仍会 `followup` 开回合 | 实测（探针拿到该报错）+ 源码推断（插件 `dsh-process.ts:2007-2012` 无重试/无等待） | 基线已有 |
| CORE-04 | P2 | `server.js:99-107`、`:1560-1561`、`:1603` | 持久化 `open`/`read` 超过 10–15 s（日志损坏、慢盘、session 正被写）：`withTimeout` 只是 Promise.race，底层操作不取消；超时返回后若 open 最终成功，句柄没有任何人 close（`handle?.close()` 在 `handle` 仍为 undefined 时执行） | 源码推断（`SessionPersistence.open` 明确支持 `options.signal`，桥未传；`SessionHandle` 只能显式 close） | 基线已有 |
| CORE-05 | P3 | `server.js:3343-3357`（清理表）vs `:2079-2144`（票据） | close 时仍有已准入的 tracked 文件写执行（或 `tools/result` 因 dispose 未再送达）：`#forgetSessionState` 清了 `snapshotOwners`/pending，**没有清 `fileMutationTickets`**，票据永不 release；该 root 的下一次 rewind `freeze` 会等满 15 s 超时失败 | 实测（探针：close 后 ticket 仍在、release 未调用） | **新引入**（本周期 fileMutationGate，2f71225） |
| CORE-06 | P3 | `server.js:3188-3230` | close 与同 id 的 `createSession` 在飞并发：close 先 `sessionCreations.delete` 再 `await creating`，teardown 尚未登记（`#trackTeardown` 在创建 settle 之后才调用）；空窗内新的 `getOrCreateSession` 会立刻发起第二个创建，绕过 teardown 等待，去争同一会话的写租约 | 实测（状态探针：`creations=false`、`teardown=false`、第二次创建已启动） | 基线已有 |
| CORE-07 | P3 | `server.js:966-980` | 两个 `initialize` 首次并发、且该 provider 只由 `options.adapters` 提供（不在 `llm.listProviders()`）：`hasAdapterFor` 与 `llmFibers.has` 是 check-then-act，`await import`/`ctx.plugin` 之间的窗口会让两个 fiber 都加载，后写覆盖前写，先加载的 fiber 永不 dispose | 实测（探针：`fibersCreated=2, fibersKept=1`） | 基线已有（插件串行化 `#initializeTask`，正常路径不可达，仅直接客户端） |
| CORE-08 | P3 | `server.js:3021-3060` | `paseo/mcp/set` 缺 `sessionId`（或值为 undefined）：`String(undefined)` 成 `"undefined"`，entries 入队到该键并回 `{accepted:true, mounted:true}`——对畸形输入报成功 | 实测（探针：`mounted:true`，`pendingKeys=["undefined"]`） | 基线已有 |
| CORE-09 | P3 | `server.js:1144-1221` vs `:983-988` | `paseo/config/set` 的 live/queued 两条路径都把 `provider/model` 直接写进选择与路由于，从不做 `llm.resolveCallConfig` 校验；而 `initialize` 是校验后才落表。模型/路由在下发后从 profile 消失时，配置请求报成功、下一回合才失败 | 实测（探针：`ghost-provider/ghost-model` 被接受并回成功） | 基线已有 |
| CORE-10 | P3 | `server.js:186-194`、`:405-408`、`:2746-2754` | 维护者按注释理解生命周期会错：注释称 jobs 描述表「Dropped at turn/end」「只有 turn/end 会清空」，实际全文件没有任何 `turn/end` 处理，只有 close 时 `#forgetSessionState` 删除；`jobs()` 的 JSDoc 还描述了一段「读时间线、只对不像命令的 label 做」的逻辑，实现是按命令文本精确查 `toolDescriptions` | 实测（grep：`toolDescriptions.delete` 仅 3338；无 `turn/end` case） | **新引入**（jobs-pill，d523941） |
| CORE-11 | P3 | `server.js:1767-1777`、`:2849-2862`、`:2689-2691`、`:2722-2724` | 可选读取失败静默丢能力：`skills.list` 抛错 → 空目录；catalog 里单个 provider 的 `listModels`/`resolveModelInfo` 抛错 → 该 provider 模型消失；usage 的 `contextPressure`/`resolveModelInfo` 抛错 → 字段缺失。都没有 stderr，和同文件归档读取「失败必报」的策略不一致 | 源码推断 | 基线已有 |
| CORE-12 | P3 | `server.js:2867-2872` | profile 无可用模型（含完全没有 provider 的 profile）时，每次 `paseo/catalog` 都固定跑满 3 s（200 ms × 轮询），且插件侧 catalog 请求超时 60 s，不会被判失败 | 源码推断 | 基线已有 |
| CORE-13 | P3 | `server.js:1551-1556` | `paseo/sessions` 的 `updatedAt` 用 `header.createdAt` 顶替：DSH `SessionHeader` 只有 `createdAt`（已核对 d.ts），宿主把它当 `lastActivityAt` 做「since」过滤与排序，创建很早但最近活跃的会话会被判成很旧、甚至被 since 过滤掉 | 实测（探针：`updatedAt` === createdAt）+ 宿主源码 | 基线已有 |
| CORE-14 | P3 | `server.js:1437-1491`、`:1697-1712`、`:1505-1510` | `#sessionHeaders`（`persistence.list()`）、`subagents.listDescendants()`、`listSessions` 的 `persistence.list()` 都不带 `signal`/超时：存储挂起时请求会一直占着共享进程（插件侧 60 s 后才 request.failed），桥内无收敛 | 源码推断（DSH 这些 API 均支持 `signal`） | 基线已有 |
| CORE-15 | P3 | `server.js:3325-3334` vs `:3088-3097` | 契约边界：close 刻意保留 `initializedSessions`/`sessionRoutes`（可为同进程 resume 服务），但清掉 `sessionSystemPrompts` 与 `pendingMcpServers`。一个跳过一次 `initialize` 直接 prompt 的客户端会拿到「已初始化」判定却丢掉 systemPrompt/MCP 队列（插件当前每次 attach 都重发 initialize，故正常路径不触发） | 源码推断 | 基线已有 |
| CORE-16 | P3 | `server.js:3156`、`:3325-3327`、`:3246` | `closeSession` 在 `try/catch` 之外调用 `#forgetSessionState`，后者会执行 `systemPrompt` disposer；若 disposer 抛错，close 会在清表与 dispose agent 之前中断 → 写租约未释放（disposer 是否真的会抛未验证） | 源码推断 | 基线已有 |

### 4.1 关键 P2 详述

**CORE-01（BR-05）**：`pendingPlanMode` 的消费只对 `true` 生效：

```js
// server.js:3609-3614
if (this.pendingPlanMode.has(sessionId)) {
  const wanted = this.pendingPlanMode.get(sessionId) === true;
  this.pendingPlanMode.delete(sessionId);
  const planMode = this.ctx.get('planMode');
  if (wanted && planMode !== undefined) planMode.set(handle.agent, true);
}
```

`false` 意图被 delete 后没有任何写入，而 DSH 的 plan 投影从日志恢复 `active:true`。插件 `open()` 的顺序（`session.ts:623` attach 后 `setPlan`，`provider.ts:1448` `loadCommands` 才建 agent）保证这时 intent 一定先入队、再被丢弃。基线 `docs/audits/20261031/bridge.md:75-83` 已复现并给出修法方向；当前 HEAD 代码未动。**用户可见**：重开会话选 build，plan 仍生效。

**CORE-02**：桥把宿主契约做成了更窄的预过滤：

```js
// server.js:1535-1536
if (cwdFilter !== undefined && snapshot.header.cwd !== cwdFilter) continue;
if (query !== undefined && !id.toLowerCase().includes(query)) continue;
```

宿主实际在拿到列表后再过滤（`agent-manager.js:4110-4116` 匹配 `title/firstPromptPreview/lastPromptPreview/cwd basename`；`import-sessions.js:54-58` 用 realpath 匹配 cwd）。provider 侧更窄的过滤是**有损**的：宿主无法把被丢掉的候选再找回来。`query` 只搜 id 意味着按标题/预览搜导入会话基本搜不到；`cwd` 字符串全等在 workspace 路径经符号链接/尾斜杠差异时会先被砍掉。修法建议：桥忽略 `query`（只保留 `limit` 作为扫描上限，query 时宿主会传 500），或至少按「全标题/预览」预过滤并把 cwd 交给宿主；若坚持预过滤，判据必须是宿主的超集。

**CORE-03**：`cancel` 用 `requireSession`（不存在就抛），而 agent 创建在 `getOrCreateSession` 里异步进行、完成前不在 `sessions` 表：

```js
// server.js:3360-3365
requireSession(sessionId) { const rec = this.sessions.get(sessionId);
  if (rec === undefined) throw new Error(`unknown or not-yet-created session: ${sessionId}`); ... }
```

冷会话首问的创建窗口包含 `agents.create/resume` + MCP 挂载（可能数百 ms～秒级），Paseo 的停止按钮在这段时间内调用会得到一个失败回执；而 prompt 请求自己会继续走完创建并 `followup`，回合照常开始。建议：cancel 若发现创建在飞，等待该创建后取消（或先记一个 cancel 意图供 `prompt` 在 `followup` 前消费），至少不要返回误导性的「取消成功」。**Paseo 侧如何展示该失败未真机验证。**

**CORE-04**：`withTimeout` 不取消也不善后：

```js
// server.js:1560-1561
handle = await withTimeout(persistence.open(id, 'read'), 10000, 'opening session summary');
const result = await withTimeout(handle.read(0, 200), 10000, 'reading session summary');
```

超时后 `handle` 仍是 undefined，`finally` 里的 `handle?.close()` 什么也不做；若 open 后来成功，返回的句柄无主。`SessionPersistence.open` 的 `options.signal` 是公开契约（`dsh-session-persistence/lib/types/index.d.ts:126` 与 `SessionPersistenceOpenOptions`），桥没传。`listSessions` 一次会对 40 个候选并发 open（`server.js:1544`），慢盘/损坏日志下可能连续泄漏句柄，属于共享进程级资源风险。修法：`open(id,'read',{signal: AbortSignal.timeout(...)})`，并对「超时后才 resolve」的句柄补一次 close。

### 4.2 新引入项说明（CORE-05 / CORE-10）

- CORE-05：`FileMutationGate` 的 ticket 是本周期新增（`fileMutationTickets`，`:2079-2144`），但 `#forgetSessionState` 的「close 必须清的全部表」清单没有同步到它。对比同一函数对 `snapshotOwners` 与 `fileSnapshots.pending` 的显式清理（`:3343-3357`），这是明显的遗漏，而不是有意保留。后果路径（票据残留 → 该 root 的 rewind freeze 等满 15 s 失败）取决于 `tools/result` 是否一定能在 close 后送达，未能真机验证，故记 P3；但清理成本极低，建议直接补。
- CORE-10：注释声称的 `turn/end` 清理与「timeline read」都不存在。功能本身有 per-session 上限（200）兜底，不构成数据错误；但违反仓库自己「注释不得比实现强」的约束，且会让后来者按错误生命周期推理。

## 5. 有意偏差 / 不登记为缺陷

- **plan/config 的「排队意图」设计**（`pendingPlanMode`/`pendingPresets`/`sessionRoutes` 的 queued 路径）是 FIELD-NOTES #2 明确要求的行为，不因「agent 不存在时不能直接 set」而登记；CORE-01 的缺陷是 false 分支没兑现，不是排队本身。
- **`commands`/`permission`/`usage` 会 materialize agent**：注释明确为「composer 读特性必须」且 `usage` 有 `closedSessions` 闸门；实测闸门成立，不登记为缺陷。
- **`usage` 关闭闸门只保护 usage**：`prompt/commands/permission` 仍可在 close 后创建 agent，但插件在 detach 后必定重发 `initialize`，且桥刻意保留 `initializedSessions` 以支持同进程 resume——属于设计选择，见 CORE-15 的契约边界描述。
- **MCP 动态 import 的 `MODULE_NOT_FOUND` 风险**：作者注释已明确标注「unverified on a real machine」并禁止硬编码路径（`server.js:3457-3464`）；基线相同，本报告不重复登记为新缺陷，列为未验证项。
- **`paseo/jobs` 的 caller 只是 owner 过滤、不是鉴权**：方法注释已写明仅因唯一调用方传自己的 `#dshSessionId` 才安全；bridge 侧无独立鉴权意图，不登记。
- **`#sessionSummary` 读失败静默省略标题**：有意（注释说明「读不了的会话仍可导入」），不登记。
- **`paseo/projections` 当前无插件消费者**：P003 计划内能力，仅 harness/p003-* 使用；接口实现本身不在本报告裁决范围。

## 6. 已验证成立（正向结论，交付对账用）

- `handleRequest` 24 个 `case` → 24 个原型方法全部存在；`paseo/permission/set` 真的调用 `permissionPresets.set` 并返回 `{current}`（`bridge-server-check` 实测）。
- `usage()` 对已关闭会话返回 `{available:false}` 且不创建 agent；重新 initialize 过的会话、恢复会话首次查询仍会创建（实测）。
- 归档状态两类读取的失败/缺失语义区分正确（缺服务每进程一行、抛错每次都报，实测）。
- 本区域使用的 DSH 服务名与方法签名（`sessionProjections.stateOf/snapshot`、`skills.list`、`workingDirectory.ensure/get`、`sessions.list/flush`、`persistence.list/open/read`、`planMode.get/set`、`permissionPresets.current/catalog/set`、`agentPresets.list/resolve/mount/select/defaultId`、`llm.listProviders/listModels/resolveModelInfo/resolveCallConfig`、`tokenMeter.measure`、`subagents.listDescendants`、`workspaceRegistry.archive/unarchive/archivedSessionIds`）**全部与已装 rc.5 一致**。
- 桥内 plan/capability 数据源一致：`catalog.planMode` 与 `planGet.available` 同取 `ctx.get('planMode') !== undefined`；缺失时 `planSet` 响亮抛错。
- `revert` 期间新 prompt 不会被吞进撤回窗口：`Agent.runMaintenance` 契约保证唤醒输入留在 inbox（已核对 dsh-agent 类型注释），本报告不把「撤回 barrier」算作缺陷。

## 7. 健康度评分（本区域）

| 维度 | 分数 (1-5) | 依据 |
|---|---|---|
| 正确性 | 3 | 主状态机与分派完整；BR-05、listSessions 过滤、cancel 竞态是明确的用户可见行为错误 |
| 健壮性 | 3 | 失败路径多数响亮（归档/usage/permission/set 均有断言）；但 withTimeout 泄漏、目录读取无超时、可选读取静默降级 |
| 可维护性 | 3 | 注释密度与解释质量高于平均，但文件 3636 行、revert 内多层嵌套；本周期注释已出现「比实现强」的漂移 |
| 契约一致性 | 4 | 24/24 分派、服务 API 与已装 DSH 一一对齐、plan/catalog 单源；扣分在 listSessions 与 configSet 校验不对称 |
| 性能 | 3 | 无 O(n²)/大帧问题；catalog 固定 3 s 空转、listSessions 全量 list + 40 并发 open、subagents 每次全量 list 是结构性成本 |
| 安全 | 4 | 本区域无越权面；systemPrompt `interpolate:false`、MCP 插件名来自固定常量、错误不泄凭据；仅「关闭会话后仍可能被材料化」属资源而非权限问题 |
| 测试覆盖 | 3 | dispatch/usage/permission/archive/jobs 有真实类断言；close↔create、cancel↔create、listSessions 过滤、票据清理、超时句柄均无回归 |

**一句话总评**：请求分派与会话主状态机在当前 HEAD 上是完整、可读、失败方向大体正确的；问题集中在「排队意图的 false 分支」「对宿主契约的有损预过滤」「超时/关闭路径的资源与状态收尾」三类局部缺陷，无阻断性健康问题。

## 8. Top 问题与建议优先级

1. **CORE-01（BR-05，P2）**：对 queued plan 意图做 true/false 对称应用，并处理 `planMode.set` 的 non-committed outcome / 异常；回归：持久 plan=true + 以 build 打开后 `plan/get.active===false`。
2. **CORE-02（P2）**：`paseo/sessions` 不要用比宿主更窄的 query/cwd 预过滤（建议忽略 query、cwd 交宿主 realpath 匹配；query 时保留宿主传的 500 上限）。回归：标题匹配 query 必须返回该会话；symlink 等价 cwd 必须返回。
3. **CORE-03（P2）**：cancel 在 agent 创建在飞时不得报「unknown session」并把待发 prompt 放行；需要 cancel 意图与 `prompt` 的 `followup` 之间的显式顺序。
4. **CORE-04（P2）**：`persistence.open` 传 `signal`，并给超时后迟到的句柄补 close；补一条「open 超时后迟到成功不得泄漏句柄」的纯模块回归（可仿 `bridge-server-check` 的桩）。
5. **本周期收尾（P3，成本低建议顺手做）**：CORE-05 `#forgetSessionState` 清 `fileMutationTickets` 前缀并调用 release；CORE-10 修正 jobs-pill 注释或实现 turn/end 清理与「label 形态判断」。

其余 P3 按「静默降级/无超时读取（CORE-11、CORE-14）→ 假成功输入校验（CORE-08）→ 配置校验对称性（CORE-09）→ 数据语义（CORE-13）→ 文档漂移（CORE-15/16）」的顺序处理即可。

## 9. 未验证项与边界

- CORE-03 的 Paseo UI 表现（失败 toast / 停止无效的可见形态）未真机复现，只证明了桥会这样答复。
- CORE-04 的泄漏未做 FD/句柄计数实测（`withTimeout` 超时需真实慢存储或 10 s 等待，未构造；结论来自 Promise.race 语义 + 句柄契约）。
- CORE-06 的真实失败形态（「already owned by an active write handle」或关闭后仍活）需要 `agents.create/resume` 在同一 id 上交错，未真机复现；仅证明状态窗口存在。
- CORE-07 经插件路径不可达（`DshProcess.#initializeTask` 串行化、进程级 initialize 先于所有会话 attach），只对直接客户端成立。
- CORE-11 的「静默」按源码判定；`skills.list`/`resolveModelInfo` 在真实 profile 下的失败频率未测量。
- CORE-15/CORE-16 的触发路径（跳过 initialize 的客户端、systemPrompt disposer 抛错）未构造。
- MCP live mount 的 `MODULE_NOT_FOUND` 风险仍是作者注释里的「未验证」项，本报告未改变其状态。
- 未测量大目录（数千会话）下 `listSessions`/`subagents` 的实际耗时与内存。
