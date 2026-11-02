# bridge-server-core：`dsh-bridge/lib/server.js` 非撤回核心（2026-11-03 全量审查）

- 代码基线：`0c82df5`（main，工作区干净；仅有未跟踪的 `V1.txt`/`v1.txt` 与团队审计目录 `docs/audits/20261103/`）。
- 上一轮全量：`docs/FULL-AUDIT-20261102.md`（基线 `2f71225`，报告分区 `docs/audits/20261102/bridge-server-core.md`）。
- 只读完成：未改产品代码/文档/harness，未做 git 写操作，未跑真实模型回合、真实 daemon、真实 `~/.dsh` profile，未装包。
  唯一写入是本文件；临时探针在 gitignored 的 `.dbg-bsc/probe.mjs`。
- 撤回链路（`revert` 主体、文件快照/闸门实现）归 `bridge-server-rewind` / `bridge-files` lane，本报告只在与会话状态收尾交叉处点到。

## 1. 范围与方法

### 1.1 逐行通读

- `dsh-bridge/lib/server.js`（4026 行）**全量通读**，重点逐行覆盖非撤回部分：
  请求分派 `handleRequest`（:3270-3323）、`initialize`（:1050-1152）、`prompt`/`cancel`（:1171-1267）、
  plan get/set（:1269-1307）、`configSet`/presets（:1318-1547）、`listSessions`/`history`（:1679-1861）、
  `subagents`/`commands`/`runCommand`（:1906-2015）、`permission`/`setPermission`（:2880-2919）、
  `usage`/统计（:2960-3051）、`jobs`（:3084-3131）、`catalog`（:3134-3219）、`shutdown`（:3222-3267）、
  `setMcpServers`（:3347-3387）、`closeSession`/teardown/`#forgetSessionState`/`getOrCreateSession`/
  `createSession`（:3430-4026）；`#trimSessionRouteTables`（:925-1003）、`withDeadline`（:131-170）等辅助。
- 交叉阅读（只用于核对契约/接线，不重复审）：`dsh-bridge/lib/index.js`（工具生命周期接线、请求并发模型）、
  `transport.js` 的 `#dispatchLine`/`#handleIncomingRequest`（请求**并发**处理，无串行化）、
  `file-mutation-gate.js`（release 幂等语义）、`snapshot-owners.js`、`file-snapshots.js` 的 `beginOwner`/`pending` 语义。
- 已装依赖源码核对：DSH `0.2.1-rc.5` 的 `dsh-session-persistence` 类型（`open(id, access, {signal})`、
  `read(offset?, length?, {signal})` 均存在）与 `dsh-session-persistence-jsonl` 实现（signal 在开工前检查、
  `length` 默认 `MAX_SAFE_INTEGER`）、`dsh-plan-mode` 的 `set()` 返回值语义（committed/queued/cancelled/noop）、
  `dsh-agent` 的 `installModelSelection`（读 `selection.current`/`assembled`，直接改字段有效）；
  宿主 `@getpaseo/server@0.14.0` 的 `import-sessions.js`（query 时 `listingLimit = IMPORT_SESSION_SEARCH_SCAN_LIMIT = 500`，
  之后用 realpath matcher 过滤 cwd）、`agent-manager.listImportableSessions`（query 匹配 title/preview/cwd basename）、
  `utils/path.js` 的 `createRealpathAwarePathMatcher`（original + realpath 变体 + 词法归一）。
- 文档对照：`docs/FULL-AUDIT-20261102.md`（§3.2、§10.1 p2-bridge-core、§10.4）、`docs/audits/20261102/bridge-server-core.md`、
  `docs/FIELD-NOTES.md`（#62、#67-77，尤其 #70 共享进程失败面、#72/#73 cwd 预过滤）、`docs/HARNESS.md` 的桥检查登记、
  仓库 `AGENTS.md` 硬性约束（失败响亮、不自造形状、能力与数据源一致、取消是取消回合）。

### 1.2 实跑命令（当前 HEAD `0c82df5`，全部只读/离线）

| 命令 | 结果 |
|---|---|
| `node harness/bridge-server-check.mjs` | **64/64 PASS，exit 0**（含 listSessions 6 条、queued plan 11 条、cancel 6 条、持久化 deadline/迟到句柄 7 条） |
| `node harness/bridge-entry-check.mjs` | **13/13 PASS，exit 0**（tools/execute→beginFileMutation→capture 顺序、commit/finish/drop） |
| `node harness/fake-bridge-multi-check.mjs` | **23/23 PASS，exit 0**（一进程多会话协议层隔离） |
| `node .dbg-bsc/probe.mjs`（自建，驱动真实 `PaseoHarnessServer` 类） | **14/14 PASS，exit 0**（见 §3 各条与 §4） |
| `git log/diff 2f71225..HEAD -- dsh-bridge/lib/server.js` | 只读比对：只有 `6394809`（修复轮）与 `88adebb`（files scope）动过本文件 |

旁证：`docs/audits/20261103/verify-runner.md` 在同 HEAD 独立实跑了同样三个 harness 且 exit 0（其全量 66 项通过），与本地结果一致。
自建探针与 `bridge-server-check.mjs` 用同一套模块解析钩子（`@deepseek-ai/*` → 本机 DSH 安装），无 profile、无模型、无子进程。

## 2. 健康度评分

**3.5 / 5（本区域）**——上一轮本 lane 的 4 条 P2（CORE-01/02/03/04）全部真修且带可红回归，本区域当前**没有 P0/P1/P2**
未决项；扣分集中在 3 条新/旧 P3：`paseo/sessions` 去掉 query 预过滤后无并发上限（新引入）、
`closedSessions` 陈旧标记破坏 route 表驱逐记账（基线）、close↔creation 竞态窗口的收尾未做身份保护（基线 CORE-06 的延伸）。

| 维度 | 分 | 依据 |
|---|---|---|
| 正确性 | 4 | 分派/会话主状态机完整；queued plan 双向应用、cancel-during-creation、listSessions 过滤、持久化超时四条 P2 均已修；剩余为低频竞态与 500 上限边界 |
| 健壮性 | 3 | 失败路径整体响亮（usage 闸门、archive 读取点名、MCP 乱序拒绝、close 失败只写 stderr 但状态已清）；仍有 CORE-11 类可选读取静默降级与 CORE-14 无 signal/超时读取 |
| 可维护性 | 4 | 注释密度与解释质量高，本轮修掉的注释强于实现（CORE-10）已对齐；文件 4026 行、`revert` 内多层嵌套是固有成本 |
| 契约一致性 | 4 | 24/24 分派、DSH 服务/方法签名与已装 rc.5 对齐、plan/catalog 单源；扣分在 `setMcpServers` 缺 sessionId 报成功、`configSet` 不校验路由（均基线 P3） |
| 性能 | 3 | 无 O(n²)；`catalog` 固定最多 3 s 轮询、`listSessions` 在 query 路径最多 500 个并发 open、`subagents` 每次全量 list 是结构性成本 |
| 安全 | 4 | 本区域无越权面；systemPrompt `interpolate:false`、MCP 插件名来自固定常量、错误不泄凭据 |
| 测试覆盖 | 4 | `bridge-server-check` 已把本轮 5 条修复全部固化为可红回归（64 条，含负向对照）；仍缺 close↔creation 窗口、trim 驱逐记账、500 并发的回归 |

## 3. 发现列表

> 级别口径：P0=数据丢失/安全灾难；P1=会话可用性/恢复正确性；P2=功能/数据/契约；P3=显示/可维护性/低频健壮性。
> 归属：`新引入` = `e7472be..HEAD` 或本轮修复轮 `6394809` 引入；`基线` = `2f71225` 及更早已存在。
> 本轮非撤回区域**没有发现 P0/P1/P2**；下表 3 条均为 P3。

| ID | 级别 | 位置 | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| BSC-01 | P3 | `server.js:1690-1704`、`:1731-1735`、`:1739-1790`；插件 `provider.ts:288-297`；宿主 `import-sessions.js`（`IMPORT_SESSION_SEARCH_SCAN_LIMIT=500`） | Paseo 导入对话框输入搜索词（query）且有 >500 条会话：宿主向 provider 要 `limit=500`，桥不再按 id 预过滤，对最多 500 条候选**同时** `persistence.open`+`read` 取标题/预览 | 实测（探针 A1/A2/A3） | 新引入（修复轮 `6394809`，CORE-02 修法的副作用） | 单次搜索最多 **500 个持久化句柄并发打开**（无 query 时对照 40）。每行失败被 `#sessionSummary` 的 `catch {}` 静默吞掉，最坏表现为搜索结果缺标题/预览而无任何提示。该请求跑在插件为导入列表起的**短命 probe 进程**（`provider.ts` `listDshSessions` → `probeProcess`）里，不直接影响共享会话进程，故定 P3；建议加一个有界并发（如 8-16）或把 summary 读取改成按需。 |
| BSC-02 | P3 | `server.js:925-1003`（`#trimSessionRouteTables`）、`:3507-3508`（close 给后代也写 `closedSessions`）、`:989-994`（陈旧标记只在第二轮驱逐后才 prune） | 进程内累计 >500 个 route 行（长时间共享进程正常可达），且 `closedSessions` 里存在**没有 route 行**的陈旧标记（关闭带子代理的根会话时，`closeSession` 会给每个后代 id 都写一个，后代从不 `initialize`）：第一轮驱逐预算被这些标记的空删除消耗，第二轮转而驱逐仍 OPEN 的会话 | 实测（探针 C0-C3：`open-old` 被逐、`closed-row` 仍在，日志把这次驱逐标成 `OPEN (unclosed)` 并点名） | 基线 | 驱逐偏好（只回收 closed 行）被陈旧标记破坏：明明有可回收的 closed 行，却把一个未关闭会话的 route/cwd/initialized 行丢掉（该会话下一次 prompt 会收到一次 "not initialized"，插件按既有自愈逻辑重发 initialize，所以不是数据错误）。同时日志把责任说反（"OPEN (unclosed)… must initialize again"）。修法：pass1 只对真正删掉行的 key 计数，或先 prune `closedSessions` 中无 route 行的标记再算 excess。 |
| BSC-03 | P3 | `server.js:3514-3556`（close 先 `sessionCreations.delete` 再 `await creating`，teardown 记录在 creation settle 之后才登记）、`:3714-3745`（`getOrCreateSession` 的 `creation.then` 收尾非身份保护） | `session/close` 与同 id 的 in-flight `createSession` 并发（关闭冷会话时 agent 正在创建），且窗口内又来一个会 materialize agent 的请求（`paseo/commands`/`permission`/`prompt` 等）：`#awaitTeardown` 此时没有记录，第二个创建被发起；旧 creation 成功结算会删掉新 creation 的记录（级联第三次创建），失败 creation 的收尾还会调用同 sessionId 的 `systemPromptDisposers` | 实测（探针 E1 `createCalls=2`、E2 `createCalls=3`、E3 disposer 被拆）+ 源码推断（真实 DSH 的 disposer 交叉拆除时序未真机复现） | 基线（上轮分区报告 CORE-06，未进主报告、未修） | 与上轮结论一致：绕过 teardown 等待去争同一会话写租约，结果是第二个创建以 "already owned by an active write handle" 响亮失败（不是静默双 agent），但 `creation.then` 的两个收尾 handler 没有身份判断：旧 creation settle 会误删新 creation 的登记，失败 creation 会 dispose 可能属于另一个活 agent 的 `systemPrompt` section。当前由插件侧 PP-01 修复（close 后拒发 prompt）把主路径堵住，故低频。修法：creation 收尾 handler 改成身份保护（`if (this.sessionCreations.get(id) === creation)`），disposer 清理同样按身份。 |

### 3.1 上轮修复核查（`FULL-AUDIT-20261102.md` §10.1 p2-bridge-core）

> 范围说明：`§3.2` 的 18 条里，落在 `server.js` 非撤回区域的只有 `BR-05`（= CORE-01，见下，已修）；
> `BR-03` 的桥侧改动（`observeDelegatedTurn`/`snapshotAnchorFor`，`server.js:2069-2136`）属撤回/锚点链路，
> 按分工归 `bridge-server-rewind` 判定；`S02-S08` 是插件 `session.ts`，不属本 lane。

| 条目 | 当前状态 | 证据 |
|---|---|---|
| CORE-01 / BR-05（queued plan=false 被丢弃） | **已修** | `server.js:3955-4002`：先应用后发布、true/false 双向、`planMode.set` 抛错/未挂载时 `disposeUnpublished` 后响亮抛错、意图保留待重试；`bridge-server-check` queued plan 11/11 PASS（含 false 生效、true 仍生效、跨会话不泄漏、失败不发布 ready、失败不丢意图）。 |
| CORE-02（`paseo/sessions` 预过滤比宿主窄） | **已修** | `server.js:1690-1704` 不再按 id 过滤 query；`:187-215` + `:1722-1727` cwd 判据改为宿主 realpath matcher 的超集（字符串相等或两侧 realpath 相等，失败退回 `path.resolve`），且在截断前过滤；`bridge-server-check` 6/6 PASS + 自建探针 B1（candidate 是 symlink、filter 是真实路径的相反方向也命中）。副作用见 BSC-01。 |
| CORE-03（创建中 cancel 抛 unknown session） | **已修** | `server.js:1188-1217` 在第一个 await 前登记 delivery、`:1243-1267` cancel 标记 delivery 而不是直接抛错、`:1206-1212` 在 followup 开回合后应用 stop；`bridge-server-check` 6/6 PASS（冷会话 cancel 被接受、followup 前不投递、followup 后 cancel、无会话时仍响亮失败）。 |
| CORE-04（`withTimeout` 只 race 不取消、迟到句柄泄漏） | **已修** | `server.js:131-170` `withDeadline`（传 `AbortSignal` + `onLate` 关闭迟到句柄，超时 marker 保留）；`:1751-1761`/`:1803-1811`/`:1826-1833` 三处替换；已核对已装 DSH `dsh-session-persistence` 的 `open`/`read` 均接受 `signal`（类型 + jsonl 实现）。`bridge-server-check` 7/7 PASS（summary/history 均传 signal、迟到句柄各关闭一次、history 超时响亮 unavailable）。 |
| CORE-10（jobs 注释强于实现） | **已修** | `server.js:291-297`、`:520-528`、`:3072-3080` 的注释已改为"会话关闭时清理"与"按命令文本查 per-session 表"，不再声称存在 `turn/end` 清理或 timeline read；全文 grep 无残留 `turn/end` 生命周期断言。 |

### 3.2 上轮分区报告（`docs/audits/20261102/bridge-server-core.md`）其余条目现状

上轮该分区报告的 16 条里，CORE-01..05、CORE-10 已修（CORE-05 = RW-01，本轮探针 D1-D3 复核：close 会释放本 root 与后代票据、不碰别的 root；`gate.enter` 中等待的票据被 retire 后 `release` 恰好一次且 `beginFileMutation` 响亮抛错）。其余 **9 条 P3 仍未修**，本轮逐条核对仍在（均为基线，未计入本轮发现计数）：

| 上轮 ID | 现状（当前行号） |
|---|---|
| CORE-06 | → 本轮 BSC-03 |
| CORE-07（`initialize` 并发 adapter 的 check-then-act） | 仍在：`server.js:1085-1099`（`hasAdapterFor` 与 `llmFibers.has` 之间无串行化）；仅对跳过插件串行化的直接客户端可达 |
| CORE-08（`paseo/mcp/set` 缺 sessionId 报成功） | 仍在：`server.js:3348` `String(params.sessionId)` → 键 `"undefined"`，仍返回 `{mounted:true}` |
| CORE-09（`config/set` 不校验路由） | 仍在：`server.js:1318-1395` live/queued 两条路径都直接写 selection/route；只有 `initialize` 走 `resolveCallConfig`（`:1102-1107`） |
| CORE-11（可选读取静默降级） | 仍在：`skills.list` catch→`[]`（:1983-1986）、catalog 单 provider/reasoning catch（:3175-3177、:3186-3188）、usage 的 `#contextPressure`/`#measuredTokens`/`#routeContextWindow` catch（:3011-3051） |
| CORE-12（无模型 profile 每次 catalog 空转 3 s） | 仍在：`server.js:3194-3198` |
| CORE-13（`updatedAt` 用 `createdAt` 顶替） | 仍在：`server.js:1745-1747`（宿主把它当 `lastActivityAt` 排序/过滤） |
| CORE-14（`list`/`listDescendants` 无 signal/超时） | 仍在：`server.js:1631`、`:1654`、`:1684`、`:1921`（已装 DSH 的 `list`/`listDescendants` 支持 signal 但桥未传） |
| CORE-15（close 保留 initialized/route、清 systemPrompt/MCP 的契约边界） | 仍在：`:3414-3422` vs `:3651-3660`；正常插件路径每次 attach 都重发 initialize，不触发 |
| CORE-16（`#forgetSessionState` 在 close 的 try/catch 之外，disposer 抛错会中断收尾） | 仍在：`:3482` 与 `:3652`；disposer 是否真会抛未验证 |

## 4. 阴性结论（已核查、不作为缺陷）

- **请求分派完整**：`handleRequest` 24 个 `case` 全部调到原型上存在的方法（`bridge-server-check` 扫描断言 PASS）；无 `TODO/FIXME/XXX/HACK` 残留。
- **usage 关闭闸门成立**：已关闭会话返回 `{available:false}` 且不创建 agent；重新 initialize 过的会话、恢复会话首次查询仍会创建（这是闸门必须保留的行为，64 条检查覆盖）。
- **`paseo/permission/set` 真的到达服务**：写 preset 并回读 `{current}`，且会 materialize 会话（上轮 3047948 删除方法后遗留 case 的形状有结构性回归网）。
- **plan 单源与失败响亮**：`planGet.available` 与 `catalog.planMode` 同取 `ctx.get('planMode') !== undefined`；未挂载时 `planSet` 抛错；queued 意图在创建失败时保留、在成功时双向应用并删除。
- **MCP 乱序被响亮拒绝**：`paseo/mcp/set` 在 agent 已存在/正在创建时抛错而不是回 `mounted:false` 静默降级（`server.js:3369-3385`）；空 entries 有语义并覆盖旧队列。
- **close/teardown 链路**：close 先清桥表再 dispose；dispose 期间登记 `teardowns`，同 id 重开在 `getOrCreateSession` 里 `#awaitTeardown` 有界等待（30 s，超时打日志后仍尝试）；close 与 creation 竞态有第二次清理（身份保护）。探针 E1/E2 证明窗口仍在，但正常插件路径被 PP-01 堵住。
- **RW-01/CORE-05 修复成立**：close 释放本 root 与后代票据、不碰别的 root；`gate.enter` 中等待的票据被 close retire 后，`beginFileMutation` 在放行时检测身份、`release` 恰好一次并抛 "retired before admission"（探针 D1-D3）。`FileMutationGate.release` 本身幂等（闭包 `released` 标志），不存在双 release 递减。
- **持久化超时不再泄漏句柄**：`withDeadline` 的 `onLate` 关闭迟到 open 句柄；`#sessionSummary` 超时仍列出该行（只缺 summary），`history` 超时返回 `available:false` 而不是空历史。
- **`paseo/sessions` 的 cwd 判据是宿主超集**：字符串相等 / 两侧 realpath 相等 / 词法回退，两个方向（candidate 或 filter 是 symlink）都命中；不同 cwd 在截断前被排除（宿主 limit 挤压问题已修）。
- **共享进程多会话隔离**：`fake-bridge-multi-check` 23/23；桥内 route/cwd/systemPrompt/MCP/plan 意图均按 sessionId 隔离，`#trimSessionRouteTables` 对未关闭会话有 keep/保护（BSC-02 是 500 上限边界，不是日常串台）。
- **探针运行期间无 unhandled rejection / 未捕获异常**（14/14 正常退出；E3 的故意拒绝已先挂 handler，属探针自身需要，不是产品行为）。

## 5. 未验证项

1. **BSC-01 的真实规模**：探针用 600 条合成快照 + 2 ms 延迟测并发数；真实 store 的句柄数/FD 上限、慢盘下是否触发 EMFILE、失败时用户是否可见（`#sessionSummary` 吞错 → 只缺标题）未在真实 `~/.dsh` 上复现（本 lane 禁真实 profile）。影响的进程是短命 probe，未测其 60 s 请求超时与宿主 90 s 超时的实际竞态。
2. **BSC-03 的 disposer 交叉拆除**：E3 只证明 handler 会调用同 sessionId 的 disposer；真实 DSH 下「C_new 失败 handler 落在 C_old setup 装好 disposer 之后、C_old 发布之前」的时序未构造（需要真实 `agents.create/resume` 与写租约）。E1/E2（第二次/第三次创建）是实测。
3. **BSC-02 的触发规模**：探针构造了 1 个陈旧标记 + 1 条 closed 行 + 1 条 open 行；真实长期进程里标记累积速度（关闭带子代理的根会话）与是否真的走到第二轮驱逐未测。
4. **close 释放票据的副作用（跨 lane）**：见 §6，需 rewind lane 判定。
5. 真实模型回合、真实 daemon 撤回、真机 Paseo UI 表现（含 `paseo/sessions` 搜索结果、关闭后重开首回合）均未执行；`rewind` 主体、文件快照/闸门实现按分工未审。
6. CORE-14 的「存储挂起时请求一直占着共享进程」只按源码判定，未构造慢存储。

## 6. 跨 lane 提示

- **bridge-server-rewind**：`#forgetSessionState`（`server.js:3675-3689`）在 close 时**强制释放**本 root 与后代的 `fileMutationTickets`。RW-01 的收益是"不再让下一次撤回 freeze 等满 15 s"，代价是：若关闭根会话时仍有一个**后代（native subagent）的 tracked 写入在飞**，该写入的 gate 租约被提前释放；随后立刻重开同一会话并撤回，`freeze` 不再等待该写入，恢复计划可能漏掉它（正是 gate 要闭合的缝）。是否可接受（close 后子代理是否已被 DSH 中断、窗口多宽）需 rewind lane 结合 `handle.dispose` 语义判定；本 lane 未构造该场景。
- **bridge-server-rewind（2）**：`#forgetSessionState` 还会删 `revertInflight` 标记（基线已有，`:3666-3669`）；若 close 与 rewind 并发，同一会话在旧 rewind 未结束时可能允许新 rewind。请结合 close 与 revert 的实际调用时序复核。
- **fix-verify-bridge（task-19）**：本报告 §3.1 已独立复核 p2-bridge-core 的 5 条（fixed 结论一致），若该 lane 也复跑同一批，可交叉比对；本报告额外给出 CORE-02 修法的副作用 BSC-01。
- **bridge-files**：close 根会话时 `#forgetSessionState` 只清 `<root>:` 前缀的 `snapshotOwners` 与 `fileSnapshots.pending`（`:3690-3698`），**后代前缀**（`<childId>:`）的 pending 快照不清；若后代工具在 dispose 后不再走到 `post-execute`/`result`，内存中的 pending 文件内容会留到进程结束。属低频泄漏，请该 lane 判定是否值得随 close 一并清。
- **plugin-process**：BSC-01 的 500 并发 open 发生在 `provider.ts` `listDshSessions` 起的短命 probe 进程，不落在共享 `dsh` 子进程；若该 lane 发现其它路径也调 `paseo/sessions`（当前 grep 只有这一处），需重新评估严重度。
- **health-crosscut**：`closedSessions` 的陈旧标记增长（BSC-02）是「每会话表未随 close 对称清理」的又一实例；同类可参照 `#forgetSessionState` 的"单一清理清单"约定，把 `closedSessions` 的无表行标记纳入 prune。
