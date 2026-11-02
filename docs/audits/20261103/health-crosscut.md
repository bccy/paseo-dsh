# 全量代码健康度审查（2026-11-03）— health-crosscut lane

- 审查基线：`0c82df5`（工作区只有未跟踪的 `V1.txt` / `v1.txt`，未改动）
- 审查模式：**按缺陷模式横切全仓**，不按文件归属；fresh context，独立审查，不采信其他 lane 或提交信息
- 证据纪律：全程只读。未改产品代码/文档/harness，未做 git 写操作，未跑真实 daemon / 真实 `~/.dsh` profile / 真实模型，未装包。
  标【实测】的条目有可复现探针与 exit code；探针只在 `/tmp/hc/` 下。
- 对照：`docs/FULL-AUDIT-20261102.md` §4.2、§10.1；`docs/FIELD-NOTES.md`（静默降级 / 失败要响亮类别）；`docs/AGENTS.md` 硬性约束表

---

## 1. 范围与方法

### 1.1 扫描面

| 区域 | 文件 |
|---|---|
| 桥（`dsh-bridge/lib/`） | 19 个模块，重点 `server.js`(4026)、`file-snapshots.js`(1122)、`transport.js`(374)、`mcp-*`(1698)、`file-mutation-gate.js`(186)、`revert.js`(159)、`paseo-system-envelope.js`(235) |
| 插件服务端（`paseo-plugin/server/`） | `session.ts`(3549)、`dsh-process.ts`(3093)、`provider.ts`(2111)、`timeline.ts`(1400)、`frame-reader.ts`(289)、`rewind-notice-append.ts`(416)、`bootstrap.ts`(237) 等全部 |
| 客户端（`paseo-plugin/client/`） | `jobs-pill.tsx`、`jobs-polling.ts`、`rewind-notice-live.ts`、`rewind-notice.tsx`、`newest.ts`、`tool-call-data.ts`、`jobs-popover-layout.ts` 等全部 |
| 共享契约（`paseo-plugin/shared/`） | `jobs.ts`、`rewind-notice.ts`、`provider.ts` |
| 可选宿主补丁（`local-patches/`） | `apply-rewind-history-truncation.mjs`(2866)、`startup-patch-hook.cjs`(324)、`check-rewind-patch.mjs` |

### 1.2 用的 grep / 脚本模式（可复现）

| 模式 | 命令要点 | 目的 |
|---|---|---|
| 静默吞错 | `/tmp/hc/scan2.mjs`：按 `{`/`}` 配平提取每个 `catch` 体，命中体既无 `warn/error/throw/reject/fail/stderr/console/onLog/emit/report/log` 也无语句者输出 | 找"catch 了但什么都不说" |
| 空/兜底 catch | 同上，`inner.trim()===''` | 空 catch |
| 定时器 | `grep -n "setInterval\|setTimeout\|clearInterval\|clearTimeout"` 全扫描面，逐处看 `unref` 与清理点 | 资源泄漏 |
| 全局表 | `grep -n "^const .* = new Map\|^const .* = new Set\|^let .* = new Map"` | 模块级状态是否随会话/连接清理 |
| 静默降级 | `grep -n "?? \[\]"`、`switch/case` 的 `default:` 分支、`=== undefined) return`、`available: false` 与空列表混用 | 能力/数据源一致性 |
| 错误身份 | `grep -n "message.includes(\|message.startsWith(\|isPermissionDeniedError\|isNotInitializedError"` | 跨进程错误分类是否靠散文 |
| 跨边界错误形状 | 桥 `handleRequest` 的 throw → `transport` 回执 → 插件 `#request` 拒绝链 | 错误码/原因是否丢失 |
| 资源所有权 | `grep -n "process.on\|AbortController\|subscription.release\|dispose()"` | 监听器/订阅在 close/error 路径的释放 |
| 实测探针 | `/tmp/hc/probe-snapshot-catchall.mjs`（离线，只用 `/tmp` 临时目录） | 验证 HC-01 |

### 1.3 证据等级口径

- 【实测】：可复现命令 + exit code / 输出片段（本次仅 HC-01）
- 【源码推断】：逐行读代码 + 调用链核对，未跑真实环境
- 【文档】：仓库文档/历史审查记录所述，未独立复验

---

## 2. 健康度评分

**3.9 / 5**（本 lane 关注面：失败语义、静默降级、资源、并发、路径身份、协议形状）

理由：

1. **上轮 HC-01（分帧双实现漂移）确已修好且被钉住**：两端默认上限都是 256 MiB，且 `harness/frame-reader-check.mjs:506`、`harness/transport-frame-check.mjs:422` 各自把 256 MiB 钉死——不是"两边都写了 256"这种口头一致。这属于罕见的"修完还加了防漂移门"的正面案例。
2. **失败要响亮的覆盖面比上轮明显扩大**：未知 `ProviderInput` 已发 `request.failed`（`provider.ts:1216-1229`），未知 prompt 内容块抛错（`session.ts:3416-3420`、`renderPromptAttachmentAsText`），桥 `handleRequest` 的 `default:` 抛错（`server.js:3320-3321`），MCP 目录读不出时抛错而不是缓存空目录（`mcp-stdio.js:418-419`），撤回报告改走 `timeline.append` 并带"失败即 stderr + notice 兜底"（`rewind-notice-append.ts:42-46,156-172`）。
3. **但"未落账即静默"这条最贵的路径还剩一个缺口**（HC-01）：文件快照的三条未落账分支里，有一条会让撤回回执**主动宣称"没有改动文件"**，且代码注释三处断言"回执会说明"——与事实相反。这是本轮唯一 P2。
4. 剩下的两条 P3（HC-02/03）是**契约层**问题：跨进程错误身份仍靠英文散文（transport 明明能带 `error.data` 却全用 `-32603`），以及客户端单例覆盖旧实例不释放的写法。都不影响当前功能，但会在下一次改文案/重复装载时静默变质。
5. 并发/资源面**没有发现新问题**：池引用计数（`provider.ts:813-877`）、open 双身份占位（`:1371-1395`）、写入票据随会话关闭释放（`server.js:3685-3697`）、MCP stdio 子进程 SIGTERM→SIGKILL 升级（`mcp-stdio.js:449-469`）、`withDeadline` 的迟到句柄回收（`server.js:129-171`）都经逐行核对成立。

无 P0/P1。按上轮定级口径（P1=会话可用性/恢复正确性，P2=功能/数据/契约，P3=显示/可维护性），本 lane 结论：**当前 HEAD 没有阻断性缺陷，HC-01 是本轮唯一值得排进修复轮的问题**。

---

## 3. 发现列表

### HC-01 ｜ P2 ｜ 快照"未落账"分支让撤回把"没恢复"报成"没改动"（BF-03 修复不完整）

- **模式类别**：静默降级（失败要响亮的反面）· 恢复正确性
- **级别**：P2（与上轮 BF-03 同口径；触发条件是快照基础设施故障，不是日常路径）
- **证据等级**：【实测】+【源码推断】
- **归属**：基线已有。catch-all 自 `f5ecf0b`（文件回退改为写前备份）就存在；`6394809` 的 BF-03 修复新增了 `#recordSkippedCapture` 覆盖 `capture()` 内部的 `skip` 分支（stat/read/大小/非常规文件），但未覆盖 catch-all 与 `captureFileBeforeTool` 的前置 `return`。

**位置列表**

| # | 位置 | 角色 |
|---|---|---|
| 1 | `dsh-bridge/lib/file-snapshots.js:543-548` | `capture()` 的 catch-all：`this.pending.delete(key); return { ok: false, ... }` —— **不调 `#recordSkippedCapture`，不写 journal** |
| 2 | `dsh-bridge/lib/file-snapshots.js:564-573` | 对照：`#recordSkippedCapture` 才会进 journal（BF-03 修好的那条路） |
| 3 | `dsh-bridge/lib/file-snapshots.js:805-880` | `planRestore`：没有 journal 行 ⇒ `actions: []` 且 `unrecoverable: []`（"无可恢复"与"没有改动"不可区分） |
| 4 | `dsh-bridge/lib/server.js:2429-2433` | `captureFileBeforeTool` 对 `ok:false` **只写 stderr**（`[bridge] file snapshot failed for ...`），daemon 侧 stderr 用户看不见 |
| 5 | `dsh-bridge/lib/server.js:2393-2415` | 前置 `return`：`session===undefined`、`callId===undefined`、`rawPath===undefined`（`mutationPathOf` 认不出参数形状）、`anchorSeq===undefined`（root 分支**连日志都没有**）、`cwd===undefined` —— 全部不进 `capture()`，因此连 `ok:false` 都没有 |
| 6 | `dsh-bridge/lib/server.js:2798-2810`、`:2841-2851` | 桥回执：`filePlan` 为空数组时返回 `files: {restored:[],deleted:[],skipped:[],unrecoverable:[],...}` |
| 7 | `paseo-plugin/shared/rewind-notice.ts:190-204` | `rewindSuccessText`：`files` 存在且计数为 `{0,0}` ⇒ `bothNoFiles` / `filesNoFiles` = "这条消息之后没有改动文件，无需恢复" |
| 8 | `dsh-bridge/lib/file-snapshots.js:471-474`、`dsh-bridge/lib/server.js:2176-2178`、`:2204-2206` | 三处注释断言 "a skipped file simply will not be restored (and the bridge says so in the receipt)" / "a missing restore is already reported through the receipt" —— **对 1/5 这些分支不成立**，是错误不变量 |

**触发条件**

- 任一快照基础设施失败：`#nextCaptureSequence` 读 journal 失败、`mkdir(objects)`/`writeFile(objects)` 失败（磁盘满、快照根权限）、`#captureIdentity` 非 ENOENT 抛错 → 命中 #1；
- 或前置条件不满足：DSH 参数形状变化使 `mutationPathOf` 认不出路径、`workingDirectory.ensure()` 抛错、root 会话在无人类消息的回合里编辑文件 → 命中 #5。

**实测（/tmp/hc/probe-snapshot-catchall.mjs，node 直跑，exit 0）**

```
capture result = {"ok":false,"error":"EACCES: permission denied, mkdir '.../snap-root/sess'"}
planRestore = {"actions":[],"unrecoverable":[],"skippedLines":0}
warns = []
journal exists = false
--- 对照组（BF-03 已修的 skip 路径）---
skip-path capture = {"ok":true,"skipped":"larger than 4 bytes"}
skip-path planRestore = {"actions":[],"unrecoverable":[{"path":".../a.txt","reason":"larger than 4 bytes"}]}
```

第一组：快照根不可写 → `ok:false` → 工具照常改了文件 → `planRestore` **既无动作也无 unrecoverable** → 回执为空数组 → 插件文案断言"这条消息之后没有改动文件"。第二组说明 BF-03 那条路是好的，缺口恰在 catch-all。

**影响面**：`both` / `files` 撤回。用户以为文件回到了目标消息的状态，实际至少一个被工具改过的文件仍是新内容，且**时间线明确告诉他"没有改动文件"**。journal 里没有任何"该路径曾改动但未捕获"的记录，因此重试撤回同样无效（回执仍为空），也没有人工恢复材料（无 rescue 副本）。属于"静默数据不一致"，与 FIELD-NOTES 第 57c 条点名的"本仓库最贵的那类静默降级"同源。

**建议修法（最小）**：把 catch-all 改成"记录一次未捕获"——`capture()` 的 catch 里用与 `#recordSkippedCapture` 相同的路径落一条 `skip` 行（失败时至少 stderr + 让回执里出现 `unrecoverable`）；前置 `return` 分支在能拿到 owner/callId/path 时同样落 skip（拿不到时至少打日志，并删掉那三处"回执会说明"的错误注释）。回归用例：把 `/tmp/hc/probe-snapshot-catchall.mjs` 的第一组固化进 `harness/file-snapshot-check.mjs`。

---

### HC-02 ｜ P3（触发时 P2）｜ 跨进程错误身份靠英文散文，而 transport 已能承载结构化 `error.data`

- **模式类别**：失败要响亮 / 错误信息与可诊断性 · 契约形状
- **级别**：P3（可维护性/契约；当前文案两边一致，所以**现在不误判**；任何一侧改措辞即静默改变行为，届时为 P2）
- **证据等级**：【源码推断】
- **归属**：基线已有。其中 `bridge_too_old`（`:455-472`）与 `registry_missing` 两条分类器是 `6394809` 修复轮新增，`#isNotInitializedError`（`:2106-2109`）更早（`e5dcb92`）——同一轮修复把两个新的文案分类器写进了同一份协议。

**位置列表**

| # | 位置 | 匹配的散文 | 误判后果 |
|---|---|---|---|
| 1 | `paseo-plugin/server/dsh-process.ts:1981` + `:430-433` | `"unknown paseo bridge method:"`（桥 `server.js:3320-3321`） | 不再识别为 `bridge_too_old`（终态）→ jobs 药丸 4s→30s 无限轮询 |
| 2 | `paseo-plugin/server/dsh-process.ts:2106-2109` | `"is not initialized for session"`（桥 `server.js:1184-1186`） | 不再自愈重发 `initialize` → 会话每次提问都失败，直到关掉重开 |
| 3 | `paseo-plugin/server/dsh-process.ts:455-472` | `"this DSH runtime composes no job registry"`（桥 `server.js:3102`） | 终态判定失效，退化为瞬时轮询 |
| 4 | `paseo-plugin/client/jobs-popover-layout.ts:404-428` | `"Session is not authorized for"`（宿主文案，兜底） | 有 `access_denied` code 优先，仅 code 缺失时才靠文案——**这条是正确写法的反例** |
| 5 | 通道本身 | `dsh-bridge/lib/transport.js:353-357`：所有请求错误一律 `{code: -32603, message}`，**不带 `data`**；而 `:43-50` 的 `JsonRpcResponseError` 与 `:366-372` 的 reject **已经原样保留 `code` 与 `data`** | 结构化通道已存在却完全未用 |

**触发条件**：桥或宿主任一处的英文措辞变化（拼写修正、本地化、重构句子），且没有对应测试同时改两边。上轮 HC-02 的教训正是"用户可见路径只进 stderr"；这次是它的近亲——**语义只进散文**。

**影响面**：三条分类器都已在注释里承认"没有 code 通道"，但把"必须加 code"说成了"协议只有 message"。事实是 `transport` 层的 `error.data` 已通，桥只需在 `handleRequest` 的 catch 里附 `data: { code: "bridge_too_old" | "not_initialized" | "registry_missing" }`，插件读 `(error as {data?: {code?: string}}).data?.code` 即可，不新增协议、不改宿主。client→daemon 方向的 `access_denied` 就是同一模式的既有成功案例。

**建议修法（最小）**：给 3 条桥侧错误加 `data.code`，分类器改成"code 优先、文案兜底"（保留现有字符串作为兼容），并在 harness 里钉住 code 与文案的对应关系。风险低、改动局部。

---

### HC-03 ｜ P3 ｜ 客户端模块级单例"覆盖旧实例但不 dispose"（rewind monitor）

- **模式类别**：资源泄漏 · 单例/全局表生命周期
- **级别**：P3（需要宿主重复装载 client bundle 且不调上一份 cleanup 才会触发）
- **证据等级**：【源码推断】
- **归属**：新引入（`13951ad` 起的 rewind-notice 特性）

**位置**：`paseo-plugin/client/rewind-notice-live.ts:267`（`let active: RewindLiveMonitor | null = null`）、`:276-290`（`startRewindLiveMonitor`：`active = monitor` **直接覆盖**，没有 `if (active !== null) active.dispose()`）、`:203-211`（`dispose()` 才会释放订阅）。

**触发条件**：同一页面内 client bundle 被再次求值（插件热重载 / 宿主重新装载插件），而上一份贡献的 cleanup 未被调用（或调用顺序晚于新装载）。

**影响面**：旧 monitor 持有的最多 `MAX_WATCHED_AGENTS=16` 个 agent timeline 订阅 + 1 个 agent directory 订阅变成**不可达且无法释放**——`active` 已指向新实例，`activeRewindLiveMonitor()` 取不到旧实例，没有任何路径能再 dispose 它。每个订阅都是一条 daemon 侧订阅 + 回调闭包，泄漏量随重载次数线性增长。功能上不会错（新实例照常工作），所以属于"越用越漏"的慢性问题。

**建议修法（一行）**：`startRewindLiveMonitor` 开头 `if (active !== null) active.dispose();`，或在 `dispose` 前比较并保留旧实例的释放句柄。同一模式在 `jobs-pill.tsx` 的 `lifetime`/`poller` 上是正确的（cleanup 显式 `poller.dispose()`），可作为参照。

---

### 附：同源观察（不单列为发现，供修复轮参考）

1. **`withJobsErrorCode` 的"其余全是瞬时"兜底**（`dsh-process.ts:462-472`）：`registry_missing` 之外一律 `rpc_failed`。永久性失败（`unknown or not-yet-created session`、`is not initialized`）会以 4s→30s 退避无限轮询。影响小（药丸显示错误、有退避），但与 `bridge_too_old` 的终态处理不对称，且同样依赖文案（HC-02 #3）。
2. **jobs 药丸的"未授权/终态"只写客户端 console**（`jobs-pill.tsx:585-604` + `jobs-polling.ts:342-351`）：两种失败都走 `removeAgent()` 把药丸**整个移除**，解释只在 bundle 的 `console.error`（用户不可见）。对比：`available:false`（registry 读失败）反而会**显示**药丸并在 popover 里给出原因（`jobs-polling.ts:145-150`）。同为"读不到"，一个是可见错误、一个是无声消失——这是本轮"失败要响亮"在客户端侧唯一的不对称。触发需要 `plugin.rpc.invoke` 缺 `daemon.manage`，正常安装下罕见，故未单列。
3. **`tombstones` 无界**（`jobs-polling.ts:267,441`，唯一清空点 `:406` 在 `applySnapshot`）：两次目录快照之间被移除的 agent 会各留一个 id 字符串，长生命周期客户端里随 agent 开关缓慢增长。量级很小，记录在案。

---

## 4. 阴性结论（已核查确认合规的模式）

以下都是本轮**逐个读过调用链后确认没有缺陷**的项，写下来避免下一轮重复投入：

1. **分帧双实现（上轮 HC-01）**：`dsh-bridge/lib/transport.js:33` 与 `paseo-plugin/server/frame-reader.ts:74` 同为 256 MiB；算法（只扫新 chunk、数组累积、超限整帧丢弃到下一个换行）逐行同构；两端各自被 `transport-frame-check.mjs:422` / `frame-reader-check.mjs:506` 钉住默认值。**已修，且防漂移门存在**。
2. **定时器**：扫描面内所有 `setTimeout`/`setInterval` 都有对应 `clear*`，长生命周期定时器均 `unref()`（`dsh-process.ts:2420,2450,2488,2942`；`session.ts:938,976`；`provider.ts:835`；`rewind-notice-append.ts:227,285,306`；`jobs-pill.tsx:614-618`）。唯一未 `unref` 的 `session.ts:976` 是 75ms 合并窗，不影响进程退出（插件进程常驻）。
3. **全局表**：`CONNECTIONS`（provider.ts:2046）随 `close()` 注销；`catalogCache` 为 4 槽 LRU + 5 分钟 TTL；`rows`（newest.ts:74）有 `MAX_AGENTS=200` 上限；`REPORTED_MISSING_SERVICES`（server.js:247）按服务名去重、数量有限；`fileMutationTickets`/`snapshotOwners`/`fileSnapshots.pending` 均随 `session/close` 清理（server.js:3685-3697，上轮 PP 类 P2 已修）。`RewindLiveMonitor.#subscriptions` 由 `dispose()` 清空。
4. **订阅随 abort 释放**：`jobs-pill.tsx:512,631` 的 `lifetime.signal` 交给 `agents.list`，`@getpaseo/client` 的 `owned.js:166-169` 在 signal abort 时 release——cleanup 里的 `lifetime.abort()` 确实释放了目录订阅，不是只清了本地状态。
5. **open 事务占位**（上轮 S01）：`provider.ts:1371-1395` 双身份 claim 在第一个 await 前同步占位，`finally` 无条件释放；`:1199-1203`/`:1410-1424` 的 close 使在飞 open 失效；`#open` 失败路径删 session 且 `close({park:false})`，不会留下"每次重试多一个进程"。
6. **能力声明 vs 数据源**：`modes` 单源（`session.ts:186-195,382-384,545-549,743-744`，catalog 与 `session.config` 用同一数组；上轮 S02/S03/S04 已修，本轮复核 `configure()` 确实"先收运行时就绪、再提交字段"（`session.ts:1717-1743`））；`CAPABILITIES`（provider.ts:59-110）里没有 `session.can_stop_runtime`，与"不实现该输入"一致（宿主只在声明后才发）；`paseo/plan/set` 在 plan 未挂载时**抛错**而不是假装成功（`server.js:1291`）。
7. **桥入口等 profile 装载**（FIELD-NOTES 39b）：`dsh-bridge/lib/index.js:141-151` 对**每个**方法 `await ctx.get('loader')?.await()`，不再只有 `initialize`。
8. **transport 关闭是终态**：`transport.js:142-150` 置 `#closed`、摘监听、拒绝全部 pending；`#write` 的 try/catch 不会让死 stdout 带走进程；`#onError`/`#onEnd` 都 `#failPending`。
9. **MCP stdio 子进程回收**：`mcp-stdio.js:449-469` 先关 stdin，`DISPOSE_GRACE_MS` 后 SIGTERM、再 `KILL_GRACE_MS` 后 SIGKILL，且 `#fail()` 先把在飞请求全部拒绝；网关在 `ctx.effect` 卸载时对全部 client `dispose()`（`mcp-gateway.js:446`）。
10. **文件恢复不因单路径失败中断**：`file-snapshots.js:902-965` 每个 action 独立 try/catch 进 `failed`，`restore()` 本身不抛；`planRestore` 重规划失败走 `files.error` 回执而不是整单失败（`server.js:2775-2795`）。
11. **撤回报告的送达顺序**：`provider.ts:1042,1055` 在发 revert **之前** `await delivery.ready` 建好订阅；canary 在 `request.completed` **之前**发（`host-contract-sim` 的机制）；`rewind-notice-append.ts:367-395` 在 replacement 事件后才 append，超时路径带一次 `verifyAfterTimeout` 重贴。宿主侧核对：`.tmp-test/migreview/r1-paseo015-evidence/pk/server-0.14.0/extracted/dist/server/server/agent/agent-manager.js:2396-2412` 对 `mode !== "files"` **无条件** dispatch `timeline_replacement`，所以等待不会在未打补丁的宿主上白等。
12. **`startup-patch-hook.cjs` 的路径/身份**：`argv[1]` basename 白名单、`NODE_OPTIONS` 剥离（含 `--require=<path>` 形式、`pathResolve` 归一）、日志按行数截断、失败软着陆——未发现路径穿越或递归。

---

## 5. 未验证项

1. **HC-01 的端到端表现**未在真实 daemon 上复现（只到 `planRestore` 层 + 源码链路）。插件文案断言"没有改动文件"是从 `rewindSuccessText` 直接读出的，未跑一次真实撤回。
2. **HC-01 的触发频率**未测：快照根不可写/磁盘满是外部条件，未做故障注入统计。
3. **HC-03 的泄漏**未在真实插件热重载下观测（需要宿主重复装载 client bundle，属于真机项）。
4. **宿主补丁路径**（`local-patches` 生效/不生效两种宿主）未跑；本 lane 只读了补丁脚本与宿主源码。
5. **真实模型回合、真实 `~/.dsh` profile、真实 UI 渲染**均未验证（本 lane 禁跑）。
6. `str_replace_editor` 三个写命令与 `view`/未知命令分支的**运行时**行为未单独构造（FIELD-NOTES 57c 已注明该 harness 缺口仍存在，与本轮 HC-01 是同一片区域，建议一起补）。

---

## 6. 跨 lane 提示

1. **给 bridge-files / fix-verify 两条 lane**：HC-01 的位置 1 与位置 5 是同一片代码的两个缺口。`6394809` 的 BF-03 修复只补了 `#recordSkippedCapture` 一条路；若某 lane 已把 BF-03 判为"fixed"，请按"部分修复"复核——catch-all 与前置 `return` 仍会让回执撒谎。
2. **给 plugin-process / bridge-server-core**：HC-02 的通道在 `transport.js:43-50,353-357`。给错误加 `data.code` 是跨两端的改动，若某 lane 已在改 `handleRequest` 的错误回执，请合并成一处，避免两边各加一套。
3. **给 client-misc / client-jobs**：HC-03 的 `active` 单例与 `jobs-pill` 的 `lifetime` 是同一模式的正确/错误两个样本；附条 2 的"未授权/终态 → 药丸无声消失"与 `available:false` 的可见错误是同一产品语义的两种处理，若 client-jobs lane 认为后者是产品决定，前者至少应有一致的可见出口。
4. **给 verify-runner**：HC-01 的探针可直接固化为 `harness/file-snapshot-check.mjs` 用例（只依赖 `/tmp` 临时目录与 `FileSnapshots` 导出，纯离线、不写仓库）。HC-02 建议加一条"code 与文案对应关系"的离线断言，防止下一轮再漂。
