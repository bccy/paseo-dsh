# bridge-misc：桥其余模块健康度审查（2026-11-03）

- 审查基线：`0c82df5`（main）。修复轮 `6394809` 已在基线内；本轮核查它对本 lane 文件（`child-anchors.js`、`image-host-path.js`、`transport.js`）的改动是否落地、是否引入新问题。
- 工作区状态：只有未跟踪的 `V1.txt`/`v1.txt`（非本 lane 产物，未触碰）与 `docs/audits/20261103/`（本轮各 lane 输出）。本报告是**唯一**由本 lane 写入的仓库文件。
- 环境：DSH `0.2.1-rc.5`（`~/.npm-global/lib/node_modules/@deepseek-ai/dsh`）、Node `v22.23.1`、Paseo `0.14.0`（沿用 11-02 基线环境，本轮未重装/未升级）。
- 证据纪律：只读审查。未启动真实模型回合、未连真实 daemon、未写真实 `~/.dsh` profile、未装包、未做 git 写操作。所有探针在 `/tmp/bridge-misc-probe/` 下，只写该目录与私有 `TMPDIR`。

## 1. 范围与方法

### 1.1 逐行通读的文件（共 1551 行）

| 文件 | 行数 | 本 lane 关注点 |
|---|---|---|
| `dsh-bridge/lib/index.js` | 193 | 入口装配、每请求 `loader.await`、工具生命周期钩子、question/approval 转发、shutdown/退出顺序 |
| `dsh-bridge/lib/transport.js` | 374 | 入站 NDJSON 分帧/溢出上限、出站写、server→client 请求关联与 abort、close/flush |
| `dsh-bridge/lib/child-anchors.js` | 175 | 父子锚点记录、BR-03 派发者继承、跨 root 隔离与清理 |
| `dsh-bridge/lib/delegated-cancel.js` | 43 | 撤回时中断被撤回子任务的选择策略与失败回执 |
| `dsh-bridge/lib/subagent-archive.js` | 201 | `archive_subagents` 工具：dryRun、running 跳过、逐 id 失败回执、scope=all |
| `dsh-bridge/lib/archived-lineage.js` | 40 | DSH 归档血缘规则的纯移植 |
| `dsh-bridge/lib/session-projections.js` | 43 | controller / live / persistence / sessionQuery 四条读路径 |
| `dsh-bridge/lib/image-host-path.js` | 482 | 图片 `hostPath` 注入、副本 staging 目录身份校验（BR-08）、重放投影白名单 |

### 1.2 对照的文档与外部实现

- `docs/FULL-AUDIT-20261102.md` §3.2（BR-03/BR-08 原发现）、§10.1（p1b/p3 修复包）、§4.2。
- `docs/FIELD-NOTES.md`：第 28 条（图片 hostPath 三段史）、第 39c 条（归档血缘）、第 60 条（父子归并/锚点）、第 65 条（归档集跨进程失效）、第 70 条（一进程多会话的放大效应，含「写往共享资源的每一次异步失败都必须有监听器」）。
- 根 `AGENTS.md` 的硬性约束（失败要响亮、取消是取消回合、能力与数据源一致、撤回的四条约束）。
- DSH 0.2.1-rc.5 源码（只读）：`dsh-session/lib/index.js`（`session/event` 的 commit/dispatch）、`dsh-agent-loop/lib/index.js`（`steer`/`inbox`/`user/message` 追加时机）、`dsh-user-questions/lib/index.js`、`dsh-agent/lib/index.js`（`agents.get` 键语义）、`dsh-subagent/lib/index.js`（`listDescendants` 行形状、`interrupt` 的 no-op 语义）、`dsh-workspace/lib/index.js`（`archiveSession`/`archivedSessionIds`/`listStoredHeaders`）、`dsh-api-session-controller/lib/index.js`（`underArchivedSession`）、`dsh-session-projection/lib/index.js`（`snapshot` 返回形状）。
- 插件侧消费方（用于核对重放白名单与锚点语义）：`paseo-plugin/server/timeline.ts`、`activity-timeline.ts`、`session.ts`（`replayHistory`/`replaySubagents`/`DshChildSession.replay`/`replayRowSource`）、`dsh-process.ts`（出站队列上限、stdout 读取、`shutdown` 超时）。

### 1.3 实际执行（全部重跑，不采信他人结论）

| 命令 | 结果 |
|---|---|
| `node harness/transport-frame-check.mjs` | 26 passed / 0 failed，exit 0 |
| `node harness/image-host-path-check.mjs` | 46/46，exit 0 |
| `node harness/archived-lineage-check.mjs` | 12/12，exit 0 |
| `node harness/rewind-merge-check.mjs` | 54/54，exit 0 |
| `node harness/bridge-entry-check.mjs` | 13/13，exit 0 |
| `node harness/bridge-assets-check.mjs` | 2/2，exit 0（内嵌桥与源码一致，21 个文件） |
| `node harness/fake-bridge-multi-check.mjs` | 23/23，exit 0 |
| `node harness/bridge-server-check.mjs` | 64/64，exit 0 |
| `/tmp/bridge-misc-probe/transport-probe.mjs` | 26/26，exit 0 |
| `/tmp/bridge-misc-probe/image-probe.mjs` | 16/16，exit 0 |
| `/tmp/bridge-misc-probe/anchors-probe.mjs` | 26/26，exit 0 |
| `/tmp/bridge-misc-probe/server-anchors-probe.mjs` | 18/18，exit 0（用模块解析钩子驱动**真实** `server.js`） |
| `/tmp/bridge-misc-probe/projections-probe.mjs` | 17/17，exit 0 |
| `/tmp/bridge-misc-probe/archive-tool-probe.mjs` | 18/18，exit 0（驱动真实 `subagent-archive.js`） |
| `/tmp/bridge-misc-probe/lineage-probe.mjs` | 9/9，exit 0（桥规则 vs DSH 官方规则逐例对照） |
| `/tmp/bridge-misc-probe/epipe-probe.mjs` | 复现：stdout 读端关闭 → 未捕获异常，子进程 exitCode=1 |

`server-anchors-probe.mjs` 与 `archive-tool-probe.mjs` 的加载方式复用 `harness/bridge-server-check.mjs` 的模块解析钩子（把 `@deepseek-ai/*` 指到本机 DSH 安装），因此驱动的是真实模块而不是抄写实现。

## 2. 健康度评分

**4 / 5（良好）。**

理由：

1. 上一轮本 lane 的两条 P2（BR-03 孙任务锚点、BR-08 图片 staging 归属）在 `6394809` 中**确已修复**，本轮用独立探针复跑旧攻击与旧反例，全部被挡住/纠正（见 §4）。
2. 本轮**没有新增 P0/P1/P2**。修复轮新增的代码（入站帧上限、副本目录归属校验、`recordDelegatedTurn`）逐段审查未发现正常路径回归；`bridge-assets` 新鲜度、入口接线、多会话协议层均绿。
3. 剩余 15 条全部是 P3：文档/注释与实现的承诺不一致（4 条）、失败路径的可见性与退出语义（3 条）、跨进程/跨调用者的契约缺口（2 条）、性能与资源边界（1 条）、测试覆盖缺口（1 条）、JSON-RPC 一致性（1 条）、TOCTOU 边界（1 条）、归档语义残余（2 条）。
4. 扣分点不是「有 bug」，而是**本 lane 的模块大量依赖「注释即契约」**：注释比实现强的地方（BR-08 的归属校验、`#write` 的死 stdout、`ported verbatim`、`delete(root)` 的 unscoped 清理）都被本轮逐条核对并登记，属于可维护性风险而非功能失效。

分维度：正确性 4.5/5、健壮性 3.5/5、可维护性 3.5/5、契约一致性 4/5、性能 3.5/5。

## 3. 发现列表

级别口径：P0=数据丢失/安全灾难；P1=会话可用性/恢复正确性；P2=功能/数据/契约；P3=显示/可维护性。归属均为**基线已有**（本 lane 三个文件的修复轮改动已单独核查，未发现新引入缺陷）。

| ID | 级别 | file:line | 触发条件 | 证据等级 | 摘要 |
|---|---|---|---|---|---|
| BX-01 | P3 | `transport.js:213-220` | 对端（插件进程）事件循环长时间停顿，而桥继续写大帧/高频帧 | **实测**（32 MiB 入队、1 次 `_write` 调用） | 出站 `output.write()` 返回值被忽略，无 drain/无字节预算；入站已封顶 256 MiB，出站没有对应上限 |
| BX-02 | P3 | `transport.js:213-220`、`index.js:69` | stdout 读端关闭（插件进程死/重启）且仍有字节排在管道里 | **实测**（子进程 exitCode=1，stderr 为 Unhandled 'error' event） | 同步 try/catch 覆盖不到异步 `'error'`；注释「a dead stdout surface must not take the runtime down」不成立；与 FIELD-NOTES 第 70 条判据冲突 |
| BX-03 | P3 | `transport.js:331`、`:352-358` | 对端发送 `id: null` 的请求，或调用不存在的方法 | **实测** + 源码 | `id:null` 被当通知丢弃、永不应答（JSON-RPC 2.0 语义要求应答）；所有错误统一 `-32603`，method-not-found 不用 `-32601`。当前 peer 契约（每帧铸 id、按 message 前缀判错）不受影响 |
| BX-04 | P3 | `server.js:2092-2100`；`child-anchors.js:96-115` | 孙任务的直接派发者 session 不 live（或 header 缺 `parentSession`/血缘成环） | **实测**（探针：锚点不记录，stderr 0 行） | fail-open 正确，但「派发者不 live」在 `rootSessionFor` 返回 undefined 时**静默返回**，没有文档承诺的诊断；`lineage-unresolved` 原因在 server 路径不可达 |
| BX-05 | P3 | `child-anchors.js:154-164`；`server.js:3489-3493` | `closeSession` 清理锚点 | **实测**（`delete('rootA')` 后 unscoped 锚点仍在） | server 注释称 `delete(root)` 会清「未命名 root 的 unscoped 锚点」，实现只删 `rootSessionId === root` 的项；生产路径总带 root，仅内存残留 + 注释失真 |
| BX-06 | P3 | `delegated-cancel.js:22-42`；`server.js:2514-2536` | 未来调用者按 JSDoc 传 `ChildAnchors`；或 interrupt 对非 resident/closing activation 的 no-op | **实测** + 源码对照（DSH `dsh-subagent` interrupt） | JSDoc 参数类型写成 `ChildAnchors`，按文档直接调用会扫描并取消**所有 root** 的子任务；生产用闭包绑定 root（安全）。另外 no-op interrupt 仍计入 `signalled` 并打印「interrupted N delegated agent(s)」，是失败/无事发生的假成功回执 |
| BX-07 | P3 | `archived-lineage.js:1-8`、`:27-39` | 归档 root；中间 child 已不 live；孙会话仍 live | **源码对照**（探针 9/9 展示分歧） | 头注释称「ported verbatim」不成立：DSH 遇到第一个非 live 祖先时只查该祖先 id（`archived.includes(parentSession)`），桥沿持久 header 走完整链。分歧场景下桥判 archived=true（隐藏/跳过重放），DSH 门禁判 false（仍允许运行） |
| BX-08 | P3 | `subagent-archive.js:156-173`、`:175-199` | child 处于 `idle` 但 inbox 仍有排队消息（或运行在另一个 DSH 进程） | **源码推断** + 探针 | 跳过条件只有 `Agent.status === 'running'`；idle-with-queued-work 会被 `stopActivity:true` 归档，报告只有 `archived`，没有「排队工作被丢弃」字段 |
| BX-09 | P3 | `subagent-archive.js:124`、`:147-154` | `scope='all'`，root 已归档而子会话不在 `archivedSessionIds` | **实测**（探针：子会话被列为 pending 并逐个写入） | `alreadyArchived` 只按 exact id 判断，不套 `underArchivedSession` 血缘；单独 unarchive root 后子会话仍因自己的归档位隐藏（与 DSH「恢复根即恢复整棵树」不一致） |
| BX-10 | P3 | `subagent-archive.js:180-188` | `scope='all'` 归档到另一个 DSH 进程仍 live 的子会话 | **源码推断**（FIELD-NOTES 第 65 条同类机制） | 归档集写入磁盘，但别的进程内存里的 `archivedSessionIds` 不会失效；那个进程里的 child 继续运行/继续被重放，工具却报 archived。本工具没有 `ParkedSessions.discard` 那类能力 |
| BX-11 | P3 | `index.js:132-139`、`:150-157`、`:186-191`；`server.js:3227-3266` | `performShutdown()` 有任一 teardown 失败（dispose 抛错/适配器 fiber 抛错） | **源码推断** | `handleRequest('shutdown')` reject 后 `setImmediate(disposeAndExit)` 不调度 → 桥不自行退出，插件侧 5s 超时后 SIGTERM 兜底；同一原因下 effect cleanup 会跳过 `transport.close()` |
| BX-12 | P3 | `index.js:132-139` | 收到 `shutdown` 后 dispose 期间仍产生 `session.event` 通知 | **源码推断** | 顺序是「flush → dispose → process.exit」：dispose 期间写出的帧在 flush 屏障之后，`process.exit` 不等待 stdout 异步排空，这些帧可能丢失（shutdown 回执本身在屏障前，安全）。改成「dispose → flush → exit」不损失任何保证 |
| BX-13 | P3 | `session-projections.js:16-24` | 会话恰在第二次 `live()` 检查之后、`observeSession` 返回之前 attach | **实测**（探针：返回 stored `asOfSeq:2`，live 已存在） | 恢复期 TOCTOU：该窗口内返回的是存储快照而非 live 投影；下一次轮询自愈，影响为一次读陈旧 |
| BX-14 | P3 | `image-host-path.js:111-135`、`:192-230`；调用点 `server.js:613/721/1848` | 图片热路径（live `session.event` 与 `paseo/history` 重放） | **源码推断**（未测耗时） | 全部同步 FS（`mkdirSync`/`lstatSync`/`chmodSync`/`statSync`/`copyFileSync`/`renameSync`）跑在服务所有会话的共享事件循环上；副本缓存无清理/无上限，每张看过的图永久留在 `tmpdir` |
| BX-15 | P3 | `harness/` 现状 | 回归 | **实测**（grep + 现有检查跑绿） | 三处测试空洞：(a) `archive_subagents` 无行为测试（仓内只有 `mcp-gateway-guard-check` 的注册/拒绝对照）；(b) `transport` 的 server→client 请求方向（request/abort/close/response 关联）无离线检查（`transport-frame-check` 只测入站）；(c) `server.js` 的 `observeDelegatedTurn`/`snapshotAnchorFor` 接线无测试（`rewind-merge-check` 只测纯模块） |

### 3.1 BX-01 出站无背压（实测）

`transport.js:213-220`：

```js
#write(frame) {
  if (this.#closed) return;
  try { void this.#output.write(`${JSON.stringify(frame)}\n`); } catch { /* ... */ }
}
```

探针用一个 `highWaterMark: 16`、`_write` 从不回调的 `Writable` 当 output，连续 `notify()` 32 个 1 MiB 帧：

```text
writableLength=33556576 bytes, _write calls=1
```

即：32 MiB 全部进了 Node 的写缓冲，`_write` 只被调用一次，`#write` 对返回 `false` 完全无感、没有 `drain` 处理、也没有字节预算。入站方向在 `6394809` 已加了 256 MiB 上限（`DEFAULT_MAX_PENDING_BYTES`），出站没有对称机制；插件侧对桥 stdin 的写已有 `DEFAULT_MAX_OUTBOUND_QUEUE_BYTES = 64 MiB` 的 FIFO 泵（`dsh-process.ts:415,2532-2600`）。触发需要「插件事件循环停顿 + 桥继续写大帧/高频帧」，因此本轮定 P3 而非 P1/P2；若真机出现停顿实测，应升级。修法方向：`#write` 观察返回值、维护待写队列与字节上限（超限时对 `notify` 报错/对 `request` reject），或至少把 `session.event` 的大帧改成可失败的有界路径。

### 3.2 BX-02 stdout 异步 EPIPE（实测）

`epipe-probe.mjs` 起一个子进程加载真实 `transport.js`、以 `process.stdin/stdout` 构造传输层，父进程读到第一批字节后销毁自己的读端（模拟插件进程消失/重启而桥仍在写）：

```text
{"exitCode":1,"signal":null,"stderr":["node:events:497","      throw er; // Unhandled 'error' event"]}
```

`#write` 的 `try/catch` 只能接住同步抛出；管道断开是异步 `'error'` 事件，没有监听器就是 uncaught exception。注释「a dead stdout surface must not take the runtime down」与 FIELD-NOTES 第 70 条的判据（「写往共享资源的每一次异步失败都必须有监听器」）都要求补一个 `process.stdout.on('error', ...)`（或 `output.on('error')`）并把它转成 pending 请求的 reject / 一次 stderr 报告。插件侧同类问题（写向死子进程的 stdin）已有修复与 `process-crash-check`，桥侧没有对应检查。影响面：对端已死时进程以未捕获异常退出而非干净退出（exit code 1），会污染插件侧「子进程异常退出」的判据；对端仍活时无法触发（插件不会主动关 stdout），故定 P3。

### 3.3 BX-03 JSON-RPC 一致性（实测 + 源码）

- `hasId = frame.id !== undefined && frame.id !== null`（`:331`）：`id: null` 的请求被归入通知分支（`:333-341`），**静默丢弃、永不应答**。JSON-RPC 2.0 允许 `id: null` 请求并应回 `id: null` 的响应；当前 peer（插件 `DshProcess` 每帧铸 id）不会发，属契约边界。
- 所有错误统一 `-32603`（`:352-358`），包括「unknown paseo bridge method」；插件按 message 前缀匹配（`dsh-process.ts` 的 `UNKNOWN_BRIDGE_METHOD_PREFIX`），因此当前无功能影响，但错误码语义不符 2.0。
- 探针同时确认：通知不应答、无 handler 时报错、并发请求乱序完成、`request()` 的 abort/close/迟到响应、`input end` 失败 pending、flush 屏障、空行/`\r`/UTF-8 跨 chunk/溢出恢复等行为均正确（26/26）。

### 3.4 BX-04 派发者不 live 时的静默 fail-open（实测）

`server.js:2092` 在 `rootSessionFor(session)` 返回 undefined 时直接 `return`，不写诊断。而 `rootSessionFor` 在「任一祖先不 live / 缺 `parentSession` / 血缘成环」时都返回 undefined——所以 `:2095-2100` 的「dispatcher is not a live session」分支在真实调用路径里**不可达**（`rootSessionFor` 已同步确认整条链 live，随后再取直接父必然存在）。探针实测：孙任务派发者不 live → 锚点不记录、stderr 0 行；而派发者 live 但未观测到锚点时，能正确打印 `dispatcher-anchor-unknown`。`child-anchors.js` 文档说「unresolved lineage ... records nothing and returns the reason」，server 文档说「leaves a diagnostic」——两者在这一分支都没兑现。影响：桥重启/父会话被关等场景下，子任务编辑不被跟踪、撤回不会取消它，且没有任何日志可查（fail-open 本身是正确的，缺的是可见性）。

### 3.5 BX-05 `delete(root)` 与 unscoped 锚点（实测）

`server.js:3489-3493` 的注释：

> Root-scoped anchors of this session, plus any unscoped ones a caller recorded without naming a root (those can only belong to a single-session process, and that process is closing this session).

`ChildAnchors.delete(root)` 只删 `entry.rootSessionId === root` 的项；`record(childId, seq)` 不传 root 时写入 `rootSessionId: undefined`，永远不被 `delete(root)` 清掉。探针：`record('childA',10,'rootA'); record('unscoped',15); delete('rootA')` → 返回 1，`anchorFor('unscoped') === 15`。生产 `observeDelegatedTurn` 总传 root，所以只造成「注释失真 + 长命进程里少量内存残留」；但注释承诺的行为是未来调用者的陷阱。

### 3.6 BX-06 取消策略模块的契约缺口（实测 + 源码）

- `delegated-cancel.js:22-28` 的 JSDoc 把 `anchors` 声明为 `import('./child-anchors.js').ChildAnchors`；而 `child-anchors.js:117-129` 明确写「production paths must pass it（root），omitted means every session in the process」。探针按 JSDoc 传真实 `ChildAnchors`、`target=1`：`interrupted=["childA","childB"]` —— 一次撤回会取消两个 root 的子任务。生产 `server.js:2514-2523` 用 `{ withdrawnSince: (seq) => childAnchors.withdrawnSince(seq, rootSessionId) }` 闭包绑定 root，是安全的；风险只在（未来）按文档调用者。修法：把参数类型改成 `{withdrawnSince(seq): string[]}`（与 server 的用法一致），或直接接收 root。
- `delegated-cancel.js:29-42` 把每个 `interrupt(childId)` 都计入 `signalled`。DSH 的 `subagents.interrupt` 对「没有 activation / activation 正在 closing」是**同步 no-op**（`dsh-subagent/lib/index.js` 对应分支直接 return），于是 `server.js:2535` 会打印「interrupted N delegated agent(s)」，而实际一个都没被中断。功能不受影响（join 逻辑按 id 走），但运维日志是假成功；与仓库「失败要响亮」的判据相反。修法：让 `interrupt` 返回是否真的发出，或至少把日志改成「signalled N」。

### 3.7 BX-07 「ported verbatim」不成立（源码对照）

DSH 官方（`dsh-api-session-controller/lib/index.js:2528-2541`，本机 0.2.1-rc.5）：

```js
const parent = ctx.sessions.get(header.parentSession);
if (parent === void 0) return archived.includes(header.parentSession);
header = parent.header;
```

桥（`archived-lineage.js:31-38`）在 `headers`（持久层）里继续向上走完整链。探针按 DSH 源码重写官方规则并逐例对照：

- 全链 live：两规则一致（root/child 归档 → 孙归档；fork 不继承；环路终止）。
- **分歧**：归档 root、中间 child 已不 live、孙仍 live → 桥 `true`，DSH `false`。桥因此把孙标记 archived（`paseo/subagents` 的 archived 标记 → 重放跳过；`listSessions` 导入过滤 → 隐藏），而 DSH 的 `agent/pre-step` 门禁会**允许**它继续跑。语义上桥更符合「归档根 = 归档整棵树」的意图，但与 DSH 运行时门禁不一致；`harness/archived-lineage-check.mjs` 的判据是「与 DSH 逐字等价」，当前该判据名不副实。修法二选一：改注释/判据措辞为「有意更强的持久链判定」，或在 `dsh-api-session-controller` 提供官方入口后改回复用。

### 3.8 BX-08/BX-09/BX-10 `archive_subagents` 的三处残余

- **BX-08 idle-with-queued-work**：`subagent-archive.js:167-173` 只用 `agents.get(id)?.status === 'running'` 跳过。DSH 的 `AgentStatus` 只有 `idle|running`；`idle` 时 `inbox.nextTurn`/`nextStep` 仍可能有排队消息（`send` 的 wakeup 是同步唤醒，窗口很窄，但不是零）。这类 child 会被 `archiveSession(id,{stopActivity:true})` 归档，排队工作随后被归档门禁 blocked，工具报告只有 `archived`，没有「丢弃了排队工作」的字段。探针确认报告键为 `[scope,dryRun,total,archived,alreadyArchived,running,failed]`。建议：用 DSH 的 `listDescendants` 行里现成的 `activity`（live/inactive）与 `inbox` 状态共同判定，或在输出里显式列出 `skippedQueued`。
- **BX-09 血缘缺失**：`alreadyArchived` 只按 exact id 判断（`:124`、`:147-154`）。探针：`archived=['root']`、headers 含 root 与 child(root) → `scope='all'` 仍把 child 列为 pending 并写独立归档位；之后用户单独 unarchive root，child 仍因自己的归档位隐藏。与 `archived-lineage.js` 的血缘语义不一致。
- **BX-10 跨进程归档集**：工具在进程 A 里写归档集；若目标子会话 live 在进程 B，B 的内存 `archivedSessionIds` 不失效（FIELD-NOTES 第 65 条已记录该机制，插件侧当时用 `ParkedSessions.discard` 收口）。本工具无法触及别的进程，`scope='all'` 会报 archived 而那个 child 继续运行/被重放。属已知限制的新写入方，建议至少在工具文档/输出里提示「跨进程不保证立即生效」，或对 `scope='all'` 缩小到本进程可确认 inactive 的会话。

### 3.9 BX-11/BX-12 shutdown/退出路径（源码推断）

- `performShutdown()` 在 `records.map(dispose)` / 适配器 fiber dispose 有任一失败时抛出（单条抛原错误，多条抛 `AggregateError`）。`index.js:150-156` 的 `await server.handleRequest('shutdown')` 因此 reject，`setImmediate(disposeAndExit)` 永不调度：桥不退出，靠插件 `shutdown()` 的 5s 超时后 `kill()`（SIGTERM，4s 后 SIGKILL）兜底。同时 effect cleanup（`:186-191`）的 `await server.shutdown()` 也会抛，`transport.close()` 被跳过。属于「teardown 失败时进程不干净退出」，无正常路径影响。
- `disposeAndExit` 的顺序是 `flush → rootFiber.dispose → process.exit`。dispose 会触发 agent 拆除，期间的 `session.event` 通知写在 flush 屏障之后；`process.exit` 不等待 stdout 异步排空，这些帧可能丢失。shutdown 回执本身在屏障之前（transport 在 handler 返回后同步写响应，setImmediate 才调度退出），所以回执安全。改成 `dispose → flush → exit` 不会损失任何东西（回执在流里更早）。

### 3.10 BX-13 恢复期 TOCTOU（实测）

`session-projections.js:16-24` 的 live 双检覆盖了「stat 期间 attach」；但第二次 `live()` 返回 undefined 之后、`query.observeSession()` 返回之前，会话仍可能 attach，此时返回的是存储快照。探针让 `sessions.get` 前两次返回 undefined、第三次返回 live session，得到 `{"kind":"sequenced","asOfSeq":2,"values":{"stored":true}}`，而 live 投影的 `asOfSeq` 是 99。影响：一次读陈旧（Paseo 下一次轮询自愈）。11-02 审查的 p1b 已把「恢复期 TOCTOU 边界」列为暂缓项，本轮确认仍在。

### 3.11 BX-14 图片热路径的同步 FS 与缓存生命周期（源码推断，未测耗时）

`withImageHostPaths` 在 **live `session/event`**（`server.js:613`）、**held child frame flush**（`:721`）和 **`paseo/history` 重放**（`:1848`）三处被调用；每个图片块都走 `ensureCopyDirectory()`（`mkdirSync`+`lstatSync`，必要时 `chmodSync`+再 `lstatSync`）与 `copyBeside()`（`statSync`+可能的 `copyFileSync`+`renameSync`）。这些同步调用跑在服务所有会话的共享事件循环上，与 FIELD-NOTES 第 70 条记录的「13 MiB 帧阻塞 2.2 s」是同一个进程模型。另外副本缓存无清理/无上限：用户看过的每张图都永久留在 `tmpdir()/paseo-dsh-attachments-<uid>`（依赖 OS tmp 清理）。上一轮 BM-10 已记录，本轮文件未改，仍成立；建议：缓存目录按 mtime/大小做 LRU，或至少把 `ensureCopyDirectory` 的校验结果在进程内缓存（目录身份不会变，除非被替换——可缓存 stat 的 dev+ino+mode+uid 并在复用前复核）。

### 3.12 BX-15 测试覆盖缺口（实测 grep + 跑绿）

- `archive_subagents`：`grep -rn registerSubagentArchiveTool harness/` 只命中 `mcp-gateway-guard-check.mjs`（断言工具名被注册、不能被当 MCP 目标），没有任何用例驱动 `scope`/`dryRun`/`running`/`failed`/`alreadyArchived` 分支。本轮自写探针（18/18）显示当前行为正确，但仓内无回归——修过的问题（运行中子代理被归档）静默复发时没有门禁。
- `transport` 的 server→client 请求方向：`transport-frame-check.mjs` 只用 `onRequest` 测入站（grep 无 `transport.request`/`paseo/question`）；abort、close、迟到响应、id 关联没有离线断言，只有耗 token 的 `probe.mjs` 走真机。
- `server.js` 的 `observeDelegatedTurn`/`snapshotAnchorFor` 接线：`rewind-merge-check.mjs` 只测 `child-anchors.js`/`snapshot-owners.js`/`file-snapshots.js` 纯模块；把 server 改回「对孙任务取 root 最新消息」不会让任何现有检查变红（模块 API 未变）。本轮 `server-anchors-probe.mjs`（18/18）补上了这个接线验证，但它在 `/tmp`，不在仓内门禁里。

## 4. 阴性结论（已核查，不再怀疑）

1. **BR-08（图片 staging 归属）已修复。** 独立探针（16/16，私有 `TMPDIR`）复跑上一轮的三类攻击：预置 cache 目录为符号链接 → 拒绝并回退 store 路径、victim 未被写；预置目录 0777 → 修复为 0700 后正常复制；预置同尺寸 target 符号链接 → 不复用、`rename` 原子替换、victim 不变；旧可预测 staging 名（`<target>.<pid>.tmp`）的符号链接 → 不再被跟随。`COPYFILE_EXCL` + 随机 staging 名 + `lstat` 复用判定 + uid/mode 校验均按注释生效。残余只有「同 uid 预置同尺寸普通文件会被复用」——注释已把它列为边界（0700 目录挡住了其他 uid），本探针复现并确认属有意边界。
2. **BR-03（孙任务锚点）已修复，且是 server 侧接线级别的修复。** `server-anchors-probe.mjs` 用真实 `server.js` 驱动：child `turn/start` 记 root 最新人类消息 10；root 之后收到无关消息 20；grandchild `turn/start` 继承 10（不是 20）；`snapshotAnchorFor(child/grand)` 都是 10；撤回 20 不中断任何子任务、撤回 10 中断 child+grand；派发者不 live / 锚点未观测都 fail-open 且不猜 root 最新；跨 root 隔离（rootA 的撤回不影响 rootB 的子任务）。`rewind-merge-check` 54/54 与模块级用例一致。
3. **入站分帧与溢出上限正确。** `transport-frame-check` 26/26 + 独立探针：20 MiB 帧逐字节还原、增量扫描比旧实现快 254×、溢出只报一次、被丢弃帧的终止符被消费（不会粘到下一帧）、UTF-8 跨 chunk/跨溢出恢复、空白行/`\r`/尾部残行语义与旧实现一致；默认上限与插件侧同为 256 MiB。
4. **重放投影白名单与消费方一致。** `REPLAYED_EVENT_TYPES`（17 类）逐项对照：`TimelineBuilder.consume`（`timeline.ts:816-846`）、`ActivityTimeline.consume`（`goal/change` + 4 个 `tool-workflow/*`）、`replayHistory`（`user/message`/`turn/start`/`turn/end`）、`DshChildSession.replay`（同上 + `subagent/descriptor` 经 `labelFromHistory`）——无遗漏、无多余。`system/message` 被丢弃是安全的：`history()` 的调用顺序确为 `historyEvents(ctx, visibleEvents(...))`（`server.js:1848`），折叠先跑；`plan/mode` 不在重放消费方里（mode 由 open options 决定）。
5. **`session-projections.js` 四条读路径与文档一致**（17/17）：controller 优先并收到 signal；live 用 `sessionProjections.snapshot`；存储会话走 `sessionQuery.observeSession` 且 `[Symbol.dispose]` 必调；`migration-required` 带缓存值；`SESSION_QUERY_SESSION_NOT_FOUND → null`；corrupt 等错误响亮抛出；signal 已 abort 时不碰后端。「live session 但缺 `sessionProjections` 服务」会抛错而非回退——已核对 DSH agent-loop 构造时直接使用 `ctx.sessionProjections`，因此 live 会话不可能缺该服务，不是可达缺陷。
6. **`archive_subagents` 的主行为正确**（18/18 探针）：schema 默认 `dryRun:true`/`scope:'session'`；dryRun 不写；running 跳过；逐 id 失败进 `failed` 不冒充 archived；`scope='all'` 只取 `origin:'subagent'` 且有 `parentSession` 的 stored header；缺 workspace registry 时点名报错。
7. **`index.js` 入口接线正确**（`bridge-entry-check` 13/13）：两个 `tools/execute` 监听器的顺序与释放路径（begin→capture→next；post-execute commit+finish；tools/result drop+finish；失败路径 drop+finish）；每个请求先 `loader.await()`（FIELD-NOTES 39b 的正确修法）；question/approval 按 `server.owns` 过滤；`bridge-assets` 与源码一致（21 个文件）。
8. **多会话协议层无串台**（`fake-bridge-multi-check` 23/23）：一个桥进程带多个会话时答案/事件/回合号各自归属，`initialize` 不带 session id 不绑定会话。
9. **`agents.get(id)` 的键语义**核对为「shared agent/session id」（`dsh-agent/lib/index.js:593-597`），`settleDelegatedWork`/`subagent-archive` 用 session id 查询正确。
10. **`cancelWithdrawnDelegations` 在 `files` scope 也执行是有意行为**：`revert()` 的注释明确「All file-restoring scopes ... cancel/join the delegated turns this rewind covers」——文件恢复前必须停掉会继续写文件的子任务，不属误取消。

## 5. 未验证项

1. 真实 `dsh --profile` / 真实 daemon / 真实模型回合：全部未跑（本轮约定离线）。BR-03 的端到端「真机撤回 + 孙任务」与 `rewind-merge-e2e` 未复跑。
2. 图片副本被 Paseo 宿主真正读成图片（扩展名判定之后的渲染）未验证；只验证了路径与字节。
3. 多用户/多 uid 的攻击面未验证：本机单 uid，无法构造「另一个本地用户预置目录」；目录 uid 校验分支只用私有 `TMPDIR` 模拟了 symlink/0777/文件占位。
4. 出站背压的 OOM 边界未做压力实测（BX-01 只证明「无上限」这一事实）；插件事件循环停顿的时长/频率未测。
5. stdout EPIPE 在「插件仍活着但关闭 stdout」场景不可构造（插件不会主动关），BX-02 的触发条件按「对端已死」记录。
6. BX-08/BX-10 的跨进程归档只按 DSH 源码与 FIELD-NOTES 第 65 条推断，未起两个真实 DSH 进程验证。
7. `interrupt` 的 no-op 分支未在真实 subagent 上触发（只按 DSH 源码记录）。
8. 平台差异（macOS/Windows 的 `rename` 覆盖、`process.getuid` 缺失、`tmpdir` 语义）未验证。

## 6. 跨 lane 提示

1. **plugin-process（PP/出站预算）**：桥 → 插件的方向没有背压（BX-01）；插件侧 `#consume` 对每个帧 `void this.#dispatch(frame)`，`#dispatch` 是 async——桥大量连续通知 + 插件处理变慢时，插件自己的在飞帧也没有上限。两个方向都应给预算；桥侧入站已封顶，插件侧出站已封顶（64 MiB），只剩「桥出站 / 插件入站」这一对。
2. **plugin-process（EPIPE）**：`process-crash-check` 只覆盖插件写向死子进程的 stdin；建议补一条对称用例：桥进程 stdout 读端关闭 → 桥不应以 uncaught exception 退出（或至少以确定的方式退出并让插件可判）。
3. **plugin-session（重放白名单耦合）**：`REPLAYED_EVENT_TYPES` 是桥侧白名单，插件新增消费事件类型时不会自动同步；`image-host-path-check` 里「whitelist 恰好 17 类」的断言是硬编码列表，不是从消费方推导。新增任何重放消费的事件类型时，两侧必须同一提交改。
4. **plugin-provider / plugin-session（归档）**：BX-09/BX-10 与 FIELD-NOTES 第 65 条的跨进程归档集失效是同一类；`archive_subagents` 是新写入方，插件侧 `#setArchived` 的 `ParkedSessions.discard` 收口没有覆盖它。
5. **server-core / rewind lane**：`ChildAnchors.delete` 的注释承诺（BX-05）、`observeDelegatedTurn` 的静默 fail-open（BX-04）在 `server.js`；`delegated-cancel` 的 JSDoc/假成功日志（BX-06）在取消策略模块。若 server 侧把 `delete(root)` 改成也清 unscoped，注意 `deleteChild` 已在 close 路径覆盖「自己的锚点」。
6. **harness lane**：BX-15 的三处缺口建议登记进 `docs/HARNESS.md` 与 CI 清单：`archive_subagents` 行为测试（可用本轮探针思路 + 假 registry，纯离线）、`transport` 双向用例（把本轮 transport-probe 的 request/abort/close 用例并进 `transport-frame-check` 或新文件）、`observeDelegatedTurn` 接线（可并入 `bridge-server-check.mjs` 的 recording context，纯离线、依赖本机 DSH 安装）。
