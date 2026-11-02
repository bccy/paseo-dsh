# 桥侧上轮修复核查（fix-verify-bridge，2026-11-03）

- 审查对象：`main` HEAD `0c82df5`（工作区仅未跟踪的 `V1.txt`/`v1.txt`），对照 [FULL-AUDIT-20261102](../FULL-AUDIT-20261102.md) §10.1 / §3.2 / §4.1 与 [audits/20261102](../20261102/) 分区报告。
- 修复轮：`6394809`（基线 `2f71225`）。`6394809` 之后的 5 个提交（`88adebb` 起的 files-only 撤回与撤回提示）也计入「当前 HEAD 行为」，逐条核查在 HEAD 上复跑。
- 全程只读：未改产品代码/文档/harness，未做 git 写操作，未起真实 daemon/profile/模型；探针只写 `/tmp/fv-bridge/`（未入库）。
- **结论先行：§10.1 桥侧 18 组条目（22 个 ID）在当前 HEAD 全部成立为 fixed**——每条旧反例在基线 `2f71225` 副本上仍复现（18/18 红），在 HEAD 上不再复现（34 条独立断言 + 15 个仓库离线门全绿）。**没有 regressed 条目**；但发现 **CORE-02 的修法带来 1 条新 P3 副作用**（导入搜索并发打开最多 500 个持久化句柄），另有 **1 条 P2 残余**（BF-03 的「读后失败」仍静默）与 5 条 P3 残余/未验证风险，见 §3。

## 1. 方法

- **独立探针**（不采信提交信息，也不只看修复轮自带用例）：`/tmp/fv-bridge/{p1a,p1b,p2,p3,p3b,neg,bsc01,red}.mjs`，直接 import 真实模块并驱动真实对象：
  - `p1a`：真实 `PaseoHarnessServer` + 真实 `FileSnapshots` + 真实 `FileMutationGate`，recording ctx（无 profile/daemon/模型）→ RW-01/RW-02/BF-04/RW-04/RW-05。
  - `p1b`：真实 `FileSnapshots`（含「模块副本只替换 `readFile` 注入读延迟」的 BF-02 对照）+ 真实 `ChildAnchors` + 真实临时目录 symlink 攻击 → BR-04/BF-01/BF-02/BF-03/BR-03。
  - `p2`：真实 `PaseoHarnessServer` + 假持久化/假 planMode/假 subagents → CORE-01/02/03/04/10。
  - `p3`：真实 `apply()` + 真实 `McpHttpClient` 对 loopback MCP server；真实 `image-host-path` 在隔离 `TMPDIR` 子进程里跑预置 symlink/权限攻击 → BR-06/BR-07/BM-03/BR-08。
  - `p3b`：真实 `McpStdioClient` 对自写 stdio JSON-RPC server → BR-06 的 stdio 半边。
  - `neg`：4 条负向对照（合法 symlink 工作区仍能恢复、正常持久化读仍出摘要、`plan=true` 仍生效、MCP 取消后仍可用）。
- **红基线**：`git archive 2f71225 dsh-bridge/lib | tar -x -C /tmp/fv-bridge/baseline`（只读导出），同一批场景改 `PROBE_REPO` 指向基线副本，逐条断言「旧行为仍复现」→ `red.mjs` **exit 0，18/18 旧行为命中**。这样每条 fixed 都有「修前红→修后绿」双证。
- 另跑仓库既有离线门并记 exit code（见 §2 各条与 §4）；行号均为当前 HEAD。
- 证据等级：【实测】=命令 + exit code/输出；【源码】=file:line；未取证的进 §5。

## 2. 逐条状态表

状态定义：**fixed**＝旧反例在当前 HEAD 不再复现且有针对性的通过证据；**regressed**＝修复引入新问题；**still-broken**＝反例仍复现；**unverified**＝本环境无法证明。

### 2.1 p1a-rewind-txn

| 条目 | 原级别 | 当前状态 | 证据（file:line + 命令/exit code） | 备注 |
|---|---|---|---|---|
| RW-01 / CORE-05（`fileMutationTickets` 不随 close 清理） | P2/P3 | **fixed** | `server.js:3675-3689`（close 按「键前缀=被关会话」或 `ticket.root`=被关根删除并 `release()`；`:2324-2336` 在 `gate.enter` 解析后按身份复核，被退休的票 release 后抛错）；`:3430-3560` 对后代逐个 `#forgetSessionState`。【实测】`node /tmp/fv-bridge/p1a.mjs` → **exit 0，7/7**：close 后 `tickets=0、gate.size=0`，随后 `freeze(id, undefined, 300)` **0ms 成功**（旧行为是 300ms 超时失败）；后代票按 child id 键控、root close 一并释放。基线红：`red.mjs` RED「close 保留票 + 下次 freeze 超时」 | 跨 lane 残余见 §3 N5（close 强制释放租约的窗口） |
| RW-02（撤回强依赖 `runMaintenance`） | P2 | **fixed** | `server.js:2673-2675`（`restores && typeof agent.runMaintenance !== 'function'` 才在 settle 前拒绝）、`:2863-2864`（conversation 走 `applyRewind(undefined)`，`both` 才进 `runMaintenance`）。【实测】p1a：无 `runMaintenance` 的 agent 上 `conversation` 撤回成功且只 append 一次；`both` 仍响亮拒绝且文件/对话都没动。基线红：RED「conversation 撤回要求 runMaintenance」 | 仍依赖 `settleAgentForRevert` 的 agent 内部形状，见 §3 N4 |
| BF-04（conversation-only 也拿文件闸门） | P3 | **fixed** | `server.js:2678`（`restores ? await freeze : undefined`）、`:2857-2861`（finally 只释放已取得的闸门）。【实测】p1a：会话持有一张在飞 tracked 写票时，conversation 撤回 `freezeCalls=0`、耗时 **0ms** 成功。基线红：RED「conversation 撤回冻结了 tracked 写」 | — |
| RW-04（闸门 × `waitForChildren` 互等 → 每次多等 3s） | P3 | **fixed** | `server.js:2560-2588`（只 join `cancelWithdrawnDelegations` 返回的 child id，用 `agents.get(id).whenIdle()`；无 id 直接返回，不再 `waitForChildren(agent)` 等全部子孙）。【实测】p1a：被保留（锚 10 < target 20）、卡在闸门上的在飞 child 下，撤回 **4ms** 成功、`interrupted=0`、stderr 无 `did not settle` 误导行；基线红：RED 该场景实测等满 **3s** 并打误导日志 | fallback 分支仍会退回旧行为，见 §3 N3 |
| RW-05（第二次 `planRestore` 失败把 journal 路径塞进 `files.failed`） | P3 | **fixed** | `server.js:2783-2795`（独立 `files.error` 通道：`failed=[]、skipped=[]、rescue=[]、rescueDir=''`，文案点名「文件恢复计划失败，未执行任何恢复」+ journal 重试材料）；插件消费 `provider.ts:1112-1160`（`files.error` 走 warning，不承诺 rescue）。【实测】p1a：二次 plan 抛错后回执 `files.error` 为字符串、`failed=0、rescue=0`、文件未动；基线红：RED「plan 失败=per-file failed + 声称 rescueDir」 | — |

### 2.2 p1b-snapshots

| 条目 | 原级别 | 当前状态 | 证据（file:line + 命令/exit code） | 备注 |
|---|---|---|---|---|
| BR-04 / BF-01 / H-02（恢复只 lstat 末端、跟随祖先 symlink） | P2 | **fixed** | `file-snapshots.js:576-604`（捕获时记录最深已存在祖先的 `dirPath`/`dirReal`）、`:624-666`（恢复前 realpath 复核 + 逐段 lstat 组件）、`:905-908`（identity 变化→`skipped`）、`journalLine:263-279`/`readJournal:747-782`（字段校验与持久化）；H-02 覆盖：`harness/file-snapshot-check.mjs:349-...`（祖先目录被换名的用例，**69 passed / 0 failed，exit 0**）。【实测】p1b：父目录被移动并替换为指向 outside 的 symlink → outside 文件保持 `UNRELATED_OUTSIDE`、`restored=0、skipped=1`；「捕获父目录存在、其下新建组件是 symlink」同样 skipped。基线红：RED「outside 被写成 ORIGINAL 且 restored=1」 | 旧 journal（无 `dirPath`）仍只查末端，见 §3 N6；代码 `:44-57` 与 `docs/REWIND.md:115-116` 已如实记录该边界 |
| BF-02（捕获读时序：序号先于读取分配） | P2 | **fixed** | `file-snapshots.js:363-374`（按 path 串行）、`:478-548`（`capture` 在 `#serializeOnPath` 内先 stat/read、**读完后**才 `#nextCaptureSequence`）。【实测】p1b：用「只替换 `readFile` 注入 250ms 延迟」的模块副本复现父子并发读：第二次捕获被挡在第一次读之后，`planRestore` 选到的 pre-image = `ORIGINAL`、恢复成 `ORIGINAL`。基线红：RED「最早编号的捕获持有 AFTER_B」 | 跨进程写租约假设未实测，见 §5 |
| BF-03（部分成功回执不响亮 / 良性 skip 阻断清理） | P2 | **fixed（有残余）** | `file-snapshots.js:507-511,551-574`（stat/读失败/非普通文件/超限 → `skip` 行）、`:683-689`（工具成功才把 skip 落 journal）、`:798-880`（`planRestore.unrecoverable`）、`:923-930`（「待删文件已不存在」→ `alreadyAbsent` 而非 skipped）；`server.js:2769-2771`（重计划收集 `unrecoverable`）、`:2804-2810`（折进 `skipped` 且进回执）、`:2811-2822`（有 failed/skipped 才不 prune）；`provider.ts:1105-1150`（skipped/unrecoverable 用户可见）。【实测】p1b：非普通文件 → `unrecoverable[0].reason='not-a-regular-file'`；ENOENT 创建型 → `alreadyAbsent`、`skipped=[]`（不再阻断清理）。基线红：RED「skip 不留痕 + 良性 absent 记 skipped」 | **读后失败仍静默**（objects 建不了/写对象失败/父身份 realpath 失败/journal append 失败 → 无 skip 行），见 §3 N2（P2） |
| BR-03 / BM-02（孙任务锚取根最新消息而非派发消息） | P2 | **fixed** | `child-anchors.js:79-115`（`recordDelegatedTurn`：直接父=root → 根最新人类消息；否则**继承直接父的锚**，未知则 fail-open 返回 reason）、`:117-142`（按 root 过滤）；接线 `server.js:2087-2116`（`session.header.parentSession` + live parent）、`:2132-2136`（`snapshotAnchorFor` 对 delegated 只认已记录锚）。【实测】p1b：root 消息 10 派 childA，root 收到 20 后 childA 派孙任务 → 孙锚 **10**，`withdrawnSince(20)` 不含孙；root 直接派发的 childB 锚 20 且会被撤；未知派发者 fail-open 不记录。基线红：RED「无 `recordDelegatedTurn`；旧规则把孙锚成 20」 | 无法证明派发者时「不取消 + 不记快照」的 fail-open 行为变化已文档化；重启/驻留进程中途 turn 未验证（§5） |

### 2.3 p2-bridge-core

| 条目 | 原级别 | 当前状态 | 证据（file:line + 命令/exit code） | 备注 |
|---|---|---|---|---|
| CORE-01 / BR-05（queued plan=false 被丢弃） | P2 | **fixed** | `server.js:3955-4002`（先应用后发布、true/false 双向、`planMode.set` 抛错/未挂载时 `disposeUnpublished` 后响亮抛错、意图保留待重试、`queued` outcome 打日志）。【实测】p2：`planSet(active:false)` 排队后 `createSession` → `planMode.set` 实收 `active:false`，意图被消费、记录已发布；负向对照 `plan=true` 仍生效；缺 planMode 服务时创建失败、agent 被 dispose、意图保留、不发布。基线红：RED「false 意图被删且未应用（setCalls=[]）」 | — |
| CORE-02（`paseo/sessions` 预过滤比宿主窄） | P2 | **fixed** | `server.js:1690-1704`（`query` 不再预过滤，理由写在注释里）、`:1718-1729`（`cwd` 在截断前按超集判据过滤）、`:180-215`（`canonicalCwd`/`matchesCwdFilter`：字符串相等或两侧 realpath 相等，失败退回 `path.resolve`）。【实测】p2：标题 query 返回全部 3 条候选；symlink 等价 cwd 命中 2 条、其他 cwd 排除；5 条更新的 other-cwd + 1 条旧 wanted、`limit=2` 时仍返回 wanted（先过滤后截断）。基线红：RED「query 按 id 过滤返回 0；symlink cwd 被丢」 | **修法副作用：导入搜索并发打开持久化句柄**，见 §3 N1（P3，新引入） |
| CORE-03（创建中 cancel 抛 unknown session） | P2 | **fixed** | `server.js:1188-1216`（第一个 await 前登记 delivery、followup/steer 之后若被标记则 `agent.cancel`）、`:1243-1267`（cancel 标记 delivery；无会话但有待交付 prompt → `{canceled:true}`；两者都无 → 保留响亮拒绝）。【实测】p2：prompt 在创建在飞时 cancel → 回执 `{canceled:true}`；创建完成后顺序为 `followup` → `cancel`；真正未知 id 仍抛 `unknown or not-yet-created session`。基线红：RED「cancel 在创建窗口被拒绝」 | 回执先于交付的极端边界（prompt 后续失败）未复现，§5 |
| CORE-04（`withTimeout` 只 race：不取消后端、迟到句柄无人 close） | P2 | **fixed** | `server.js:106-175`（`withDeadline`：把 `AbortSignal` 传给后端、超时 abort、`onLate` 关闭迟到 open 句柄、保留 `timed out` marker）、使用点 `:1751-1761`（summary open/read）、`:1803-1833`（history open/read）。已核对本机 DSH 0.2.1-rc.5：`SessionPersistence.open` 与 `SessionHandle.read(offset,length,options.signal)` 均公开接受 `signal`（`dsh-session-persistence/lib/types/handle.d.ts:14-17,75`）。【实测】p2：把 deadline 定时器压到 0ms 后，`open` 收到的 signal **已 aborted**，25ms 后迟到的句柄被 **close 一次**；正常快路径仍返回 title/preview（neg）。基线红：RED「open 收不到 signal」 | — |
| CORE-10（jobs 注释强于实现） | P3 | **fixed（仅注释）** | `server.js:520-528`（`toolDescriptions` 改为「会话关闭时清」）、`:3072-3080`（`jobs()` 注释改为按命令文本精确查表）；全文无 `turn/end` 生命周期断言。【实测】p2 对 HEAD 源码做 grep 断言；基线红：RED「`Dropped at turn/end` 仍在」 | 无行为变化 |

### 2.4 p3-bridge-mcp

| 条目 | 原级别 | 当前状态 | 证据（file:line + 命令/exit code） | 备注 |
|---|---|---|---|---|
| BR-06（`exec.signal` 不贯穿） | P2 | **fixed** | gateway：`mcp-gateway.js:491-493,512-524`（discovery）、`:643-651`（call：发出前/结果后两次 aborted 检查，结果后检查在投影/落盘前）；HTTP：`mcp-http.js:133-219`（`AbortSignal.any` 融合调用方与超时、`fetch` 真中止、取消优先于超时分类）、`:310-346`（共享握手只拒绝本调用方等待）、`:430-547`；stdio：`mcp-stdio.js:324-374`（abort 只撤该 request 的 pending + 发 `notifications/cancelled`）、`:383-394`（共享握手不因单个调用方取消而拆）。【实测】p3：真实 gateway + loopback，在途 abort → `mcp: ... canceled`、server 观测到 socket 提前关闭（`abortedRequest=true`）、不再返回 `SIDE_EFFECT_COMPLETED`；预取消 → 请求根本不发出；取消后同一 gateway 仍可用（neg）。p3b：真实 stdio client，abort → 服务端收到 `notifications/cancelled {requestId:3}`，共享子进程继续服务后续 `echo`。基线红：RED「HTTP 取消后仍成功返回」 | HTTP 侧只做传输层 abort、不发协议级 `notifications/cancelled`（与上轮建议修法一致）；共享握手不取消是有意边界 |
| BR-07 / BM-02（`structuredContent` 丢失） | P2 | **fixed** | `mcp-gateway.js:336-372`（校验并返回 `structuredContent`）、`:602-610`（输出 schema 增加 `structuredContent`，`additionalProperties:true`）、`:625-640`（render：无文本时以 JSON 投影）、`:657-679`（成功/错误两路都保留）。【实测】p3：`{content:[],structuredContent:{answer:42}}` → `content:''` + `structuredContent={answer:42}`，render 出 `"answer":42`；文本+结构两者都保留；结构化错误保留 `browser_no_host` 原因而非 `(no message)`。基线红：RED「42 丢失、structure undefined」 | — |
| BM-03（`CallToolResult` 未校验：畸形/任务式结果变成功空内容） | P2 | **fixed** | `mcp-gateway.js:315-372`（`content` 必须数组、块形状校验、`isError` 必须布尔、`task` 结果显式拒绝、`structuredContent` 必须对象；错误点名字段与 server/tool）、`:657-671`（先校验/先判 isError，再投影/落盘）。【实测】p3：`content:"hello"` → `/invalid CallToolResult/`；`isError:"true"` → `/isError/`；`{task:{…}}` → `/task-based/`。基线红：RED「畸形结果变成功空内容」 | 严格度与原生 `dsh-mcp-client` 的 `specTypeSchemas.CallToolResult` 校验方向一致 |
| BR-08（图片 staging/target 可写穿） | P2 | **fixed** | `image-host-path.js:92-135`（缓存目录 lstat + uid + 无 group/other 位，过开则 chmod 0700，不满足即拒绝使用）、`:137-156`（复用前 `lstat` 且必须是同尺寸**普通文件**）、`:170-230`（随机 staging 名 + `COPYFILE_EXCL` + `rename` 原子落位、失败回退 store 路径）。【实测】p3（隔离 `TMPDIR` 子进程，4 个场景）：预置旧可预测 staging 名 symlink → victim 未被写、正常复制成功；预置同尺寸 target symlink → 不复用、被 rename 换成真实普通文件、victim 不变；预置 0777 缓存目录 → 修复为 0700；缓存根为 symlink → 拒绝使用、不写入。基线红：RED「staging 写穿 victim；target symlink 被当缓存复用；0777 不修」 | 同 uid 预置**同尺寸普通文件**仍会被复用（代码 `:199-205` 自认边界）；跨 uid 攻击本机无法构造（§5） |

## 3. 新发现（修复引入的问题 / 修复不彻底）

| 编号 | 级别 | 位置 | 触发与后果 | 证据等级 | 归属 |
|---|---|---|---|---|---|
| **N1** | P3 | `server.js:1690-1704,1731-1735,1739-1790`；宿主 `import-sessions.js` 的 500 扫描上限 | Paseo 导入对话框**带搜索词**且有 >500 条会话：宿主向 provider 要 `limit=500`，桥不再按 id 预过滤 → 对最多 500 条候选**同时** `persistence.open`+`read` 取标题/预览（无 query 时对照 40）。每行失败被 `#sessionSummary` 的 `catch {}` 静默吞掉，最坏是搜索结果缺标题/预览而无提示。该请求跑在插件为导入列表起的**短命 probe 进程**里，不直接影响共享会话进程，故 P3。 | 【实测】`node /tmp/fv-bridge/bsc01.mjs` → **exit 0**：`sessions=500 opens=500 maxConcurrentOpens=500`。同轮 [bridge-server-core](bridge-server-core.md) 以 BSC-01 独立登记同一副作用（结论一致） | **新引入**（`6394809` 的 CORE-02 修法副作用） |
| **N2** | P2 | `file-snapshots.js:521-548`（capture 的兜底 catch）、`:690-700`（commit 的 catch）；`server.js:2429-2433`（只写 stderr） | 工具**成功且文件已改**，但捕获/提交在**读完字节之后**失败（objects 目录建不了、对象写失败 ENOSPC/EACCES、父目录身份 realpath 失败、journal append 失败）：不产生 `skip` 行、`pending` 被删 → `planRestore` 的 `actions=[]、unrecoverable=[]` → 撤回报告成功而文件仍是改后状态；「对象已写成功但 journal 行失败」还会让该对象失去引用，之后任一成功恢复触发的 GC 可删掉唯一重试材料（GC 宽限只是延迟）。 | 【实测】`node /tmp/fv-bridge/n2.mjs` → **exit 0**：把会话目录设为 0500（读后 `mkdir objects` 报 EACCES）→ capture `{ok:false,error:"EACCES … mkdir …/objects"}`、journal `entries=0`、`planRestore {actions:0,unrecoverable:0}`、文件仍为 `MODIFIED`（撤回会报成功）；同轮 [bridge-files](bridge-files.md) 以 BF-01 用 A/B/C 三个探针独立登记同一残余（结论一致） | **上轮 BF-03 修复的残余**（读前失败已修，读后失败仍静默） |
| **N3** | P3 | `server.js:2574-2577` | `ctx.get('agents')` 缺失或 `agents.get` 不是函数时，`settleDelegatedWork` 退回 `subagents.waitForChildren(agent)`（= 等**全部**子孙 idle），重新引入 RW-04 的「被保留子代理卡在闸门上 → 确定性多等 3s + 误导日志」。当前 DSH 0.2.1-rc.5 的 `ctx.agents.get` 存在（`server.js:3708-3712` 自己就在用），不可达。 | 【源码】；同轮 [bridge-server-rewind](bridge-server-rewind.md) BSR-05 独立登记（结论一致） | 修复只覆盖主路径 |
| **N4** | P3 | `server.js:2033-2046` | `settleAgentForRevert` 仍无条件使用 `agent.status`、`agent.cancel(cause,{keepInbox})`、`agent.inbox.nextStep/nextTurn/remove`、`agent.whenIdle()`（DSH `dsh-agent-loop` 内部实现，无稳定性承诺；`dsh-api-contract-check` 只查 import）。一次改名会让**所有 scope** 的撤回在 settle 处 TypeError（响亮但无指引）——RW-02 只条件化了 `runMaintenance`。 | 【源码】；同轮 bridge-server-rewind BSR-06 独立登记（结论一致） | RW-02 的同类残余；建议把这些内部方法加入契约存在性断言 |
| **N5** | 未验证 | `server.js:3675-3689`（close 强制释放票） | RW-01 的收益（close 后不再毒化下一次 freeze）的代价：若关闭根会话时仍有一个**后代 tracked 写入在飞**，其 gate 租约被提前释放；随后立刻重开同一会话并撤回，`freeze` 不再等该写入，恢复计划可能漏掉它（正是 gate 要闭合的缝）。DSH `handle.dispose()` 是否会中断/排空后代写入未验证，窗口宽窄未知。 | 【源码】+ 未验证；同轮 bridge-server-core §6 提出同一跨 lane 问题、要求 rewind lane 判定 | 需结合 DSH dispose 语义实测后才能定性 |
| **N6** | P3 | `file-snapshots.js:44-57,624-625`；`docs/REWIND.md:115-116` | 旧 journal（修复前写入、无 `dirPath`/`dirReal`）仍只查末端 `lstat`：捕获后父目录被换名并替换为指向 outside 的 symlink，恢复仍会把 outside 文件写成旧内容并报 `restored`。代码与文档已把该边界写清（「旧 journal 没有目录身份，仍只查末端」），属**升级迁移窗口**而非新回归。 | 【实测】p1b 的 legacy 场景输出 `outside=LEGACY_ORIGINAL restored=1 skipped=0` | 上轮 BR-04 的残余（文档化边界） |
| **N7** | P3 | `image-host-path.js:199-205` | 同 uid 的本地进程可在 0700 缓存目录里预置**同尺寸普通文件**，`reusableCopy` 会按「同尺寸普通文件」复用它并让宿主读到替换后的字节（注释自认「同尺寸普通文件替换属边界之外」；其他 uid 被 0700 目录挡住）。 | 【源码】+ 本机无法构造跨 uid 攻击（uid 1000、非 root） | 上轮 BR-08 的残余（有意边界） |

**正常路径无回归**：4 条负向对照全绿（`node /tmp/fv-bridge/neg.mjs` → exit 0，4/4）；15 个仓库离线门全绿（§4），其中 `rewind-transaction-check` 17/17 新增用例 7–12 覆盖 close 清票、conversation-only 不依赖 runMaintenance/不取闸门、保留 child 不触发 3s 互等、二次 plan 失败走 `files.error`。

## 4. 阴性结论（确认修好的条目）

- **§10.1 桥侧 18 组条目（22 个 ID）全部确认修好**，且每条都有独立反例翻转证据：基线 `2f71225` 副本上 18/18 旧行为命中（`red.mjs` exit 0），HEAD 上 34 条独立断言全过（p1a 7、p1b 7、p2 6、p3 8、p3b 2、neg 4，全部 exit 0）。
- 撤回事务：RW-01/CORE-05、RW-02、BF-04、RW-04、RW-05 全部成立；事务顺序（settle → 仅文件恢复才 `runMaintenance`+freeze → 计划 → append/flush → 取消/join 被撤子代理 → 重计划 → 恢复 → 有条件 prune）与 `docs/AGENTS.md` 撤回四条约束一致（marker 形状/flush/只折本桥缝/插件侧 canary 顺序不在本 lane 写入范围，插件 lane 已复核）。
- 文件层：BR-04/BF-01/H-02（祖先 symlink 身份）、BF-02（读后定序）、BF-03（读前失败类回执与良性 absent）、BR-03/BM-02（孙任务锚继承）成立；H-02 的 harness 覆盖缺口已补（`file-snapshot-check` 祖先目录用例）。
- 桥核心：CORE-01/BR-05、CORE-02、CORE-03、CORE-04、CORE-10 成立。
- MCP：BR-06（HTTP+stdio 双传输）、BR-07/BM-02、BM-03、BR-08 成立。
- **内嵌桥不是旧代码**：`node harness/bridge-assets-check.mjs` → exit 0，2/2（`paseo-plugin/server/bridge-assets.ts` 与 HEAD `dsh-bridge/` 源码一致），修复会随插件分发。
- 仓库离线门（全部 exit 0）：`rewind-transaction-check` 17/17、`file-mutation-gate-check` 6/6、`file-snapshot-check` 69 passed/0 failed、`snapshot-lifecycle-check` 8/8、`rewind-merge-check` 54/54、`bridge-server-check` 64/64、`bridge-assets-check` 2/2、`mcp-gateway-call-check` 17/17、`mcp-http-check` 60/60、`mcp-stdio-check` 28/28、`image-host-path-check` 46/46、`mcp-gateway-guard-check` 70/70、`transport-frame-check` 26 passed/0 failed、`child-crash-check` 14/14、`factory-ownership-order-check` 6/6。

## 5. 未验证项

1. **真实环境**：未跑真实 daemon/模型/profile 的撤回（`rewind-e2e`、`rewind-merge-e2e`、`rewind-native-check`），按本 lane 约束；Paseo App 真机时间线/胶囊表现未验证（插件/客户端 lane 范围）。
2. **RW-01 的永久毒化形态**：探针直接构造「close 时仍持票」；真实 DSH 里 `tools/result` 通常会补释放，要复现永久泄漏需人为让某个执行永不结算（未做）。
3. **N5 的 close 窗口**：`handle.dispose()` 是否中断/排空后代在飞写入未验证，因此「重开+立刻撤回会漏掉该写入」只是可能，不列为 regressed。
4. **BF-02 跨进程**：修复假设 DSH 写租约保证同一 journal 只有一个 bridge 写者；双进程实测未做（只核了类型/文档与既有门）。
5. **BR-03 的 fail-open 面**：驻留进程重启后已在跑的子代理没有锚（不记快照、不取消）——行为已文档化，未构造真实 subagent 端到端；孙锚继承只在纯模块 + 接线源码层验证。
6. **BR-08 跨 uid 攻击**：本机 uid 1000 非 root，无法构造「另一用户先占目录」的场景；同 uid 同尺寸普通文件替换（N7）已知残余。Windows 上 `mode` 位语义未验证（本机 Linux）。
7. **N1 的真实规模**：合成 600 条快照 + 2ms 延迟测出 500 并发；真实 `~/.dsh` 的句柄/FD 上限、慢盘下是否 EMFILE、60s probe 超时与宿主 90s 超时的实际竞态未测。
8. **MCP 真实 server**：BR-06/07/BM-03 用 loopback 假 server 验证；真实 Paseo HTTP server / Server Browser stdio 的取消与结构化结果未真机复核。
9. `harness/session-request-check.cjs` 需要先编译插件（`require('./index.server.js')`），本 lane 未构建插件；CORE-03 已由独立探针覆盖，插件侧回执消费由插件 lane 负责。
