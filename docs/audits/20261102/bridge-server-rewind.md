# dsh-bridge/lib/server.js 后半只读审查（撤回 / 文件计划 / 子代理 / 归档 / history 投影）

- 仓库：`<repo>`，HEAD `2f71225`（main，工作区干净；`docs/audits/20261102/` 本身未跟踪）
- 审查方式：只读源码 + 已装 DSH 源码核对 + 纯离线检查执行；不修改任何 tracked 文件，不执行 git 写操作，不碰真实 profile / daemon / 模型回合
- 实际审查范围：`dsh-bridge/lib/server.js` **1391–3636 行**（逻辑起点 `#archivedSessionIds`：归档集读取、`#sessionHeaders`、`listSessions`、`history`、`applyArchived`、`subagents`、`observeDelegatedTurn`/快照锚、文件闸门与票、`revert`、`usage`/`projections`/`jobs`/`catalog`、`shutdown`、`handleRequest`、`setMcpServers`、`closeSession`/teardown/`#forgetSessionState`、`createSession` 的 setup/resumeSetup `beginOwner` 接线）。任务书写的是 1800–3636，但任务同时点名「子代理/归档、history/timeline 投影」，这些方法实际位于 1391–1735，因此向上延伸到该逻辑边界。
- 为判断 server.js 的接线，另读（不单独出报告）：`dsh-bridge/lib/index.js`（工具钩子，全量）、`dsh-bridge/lib/file-mutation-gate.js`（全量）、`dsh-bridge/lib/file-snapshots.js`（capture/commit/planRestore/restore/prune/trim/GC/`beginOwner` 相关段）、`dsh-bridge/lib/revert.js`、`snapshot-owners.js`、`child-anchors.js`、`delegated-cancel.js`、`surface.js`、`image-host-path.js` 的 history 投影段、`paseo-plugin/server/provider.ts` 的 revert/archive 回执消费段。
- **重叠声明**：`usage()`(2634)、`jobs()`(2758)、`catalog()`(2808)、`shutdown()`(2896)、`handleRequest()`(2944)、`closeSession()`(3104)、`createSession()`(3418) 落在本任务行号区间内，但 task-1 的任务书点名了这些区域；本报告只在与撤回/文件计划/新表清理相关处展开（RW-01/02/06），其余不重复深挖，避免与 task-1 结论冲突。`file-snapshots.js`/`file-mutation-gate.js` 的深审属 task-3/横切任务。

## 1. 结论

**这一段的核心事务是自洽的：BR-01、BR-02 两处 P1 的修复在本轮源码复核与三项检查下成立，未发现撤回正常路径的新回归。** 新问题集中在三处：新增状态表 `fileMutationTickets` 没有纳入 `closeSession` 的清理清单；`revert` 对所有 scope 无差别强依赖 DSH 内部方法 `agent.runMaintenance`（把 conversation-only 撤回也绑到无契约门的内部 API 上）；以及闸门与「等子代理静默」的交互会让每次命中在飞子代理写入的撤回确定性多等 3 秒。上一轮 BR-03（子代理锚因果）**未修，仍以 FIELD-NOTES #60 M2 的已知限制形式存在**。

无 P0/P1 阻断性健康问题；RW-01、RW-02 都是一行到几行的改动，建议在本轮修掉。

## 2. 发现总表

严重度：P0 阻断 / P1 会话可用性或数据恢复错误 / P2 明确功能、数据或验证合同问题 / P3 窄触发或显示/维护问题。证据等级：实测 / 源码 / 推断 / 未验证。

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 新引入 vs 基线已有 |
|---|---|---|---|---|---|
| RW-01 | P2 | `dsh-bridge/lib/server.js:357`、`:3325-3358`；`dsh-bridge/lib/index.js:85-116` | `session/close`（或 close/create 竞态修复）发生时，一次被跟踪的 `write`/`edit` 执行仍持有 gate 票（`tools/execute` 已 `beginFileMutation`，尚未走到 `post-execute`/`tools/result`） | 实测（`/tmp/ticket-close-probe.mjs`：close 后 tickets=1、gate 仍记该 root；随后 `freeze` 300ms 超时被拒）+ 源码 | **新引入**（`2f71225`；`#forgetSessionState` 的文档不变量要求「新表必须加进清理清单」） |
| RW-02 | P2 | `server.js:2393-2396`（调用点 `:2396`） | 每个 `paseo/revert`，**包括** `scope:"conversation"`（不需要文件恢复） | 源码（`dsh-agent-loop/lib/index.js:822-843` 有该方法）+ 推断 | **新引入**（`2f71225`） |
| RW-03 | P2 | `server.js:1872-1889`、`:1902-1906`；`child-anchors.js:26-37` | 旧 child（派发于 H1）在根已收到新消息 H2 之后启动孙任务；随后撤回 H2 | 源码 + 文档（FIELD-NOTES #60 M2 明确记为未改的已知限制） | 基线已有（上一轮 BR-03，本轮复核仍成立） |
| RW-04 | P3 | `server.js:2504-2511`、`:2126`；`provider.ts:973` | 恢复中某路径被 `restore()` 记入 `skipped`（目标变成 symlink/目录，或删除型动作发现文件已不存在） | 源码（插件全仓无任何 `files.skipped` 消费点：`grep` 无命中） | 半新：回执里的 `skipped` 基线已有；「有 skipped 就跳过 prune/trim/GC」为 `2f71225` 新引入 |
| RW-05 | P3 | `server.js:2397`（freeze）、`:2473-2474`（settle）、`:2312-2326` | 撤回时某个**未被撤回**（锚 < targetSeq）的子孙代理恰好有一次被跟踪写入在飞 | 源码（DSH：`gate.enter` 等待 `blocked` 释放；`waitForChildren` 基于 `whenIdle`） | **新引入**（闸门 `2f71225`） |
| RW-06 | P3 | `server.js:405` vs `:3338`；`:2750-2753` vs `:2786-2793` | 维护者按注释推断行为时 | 源码（`grep -n "toolDescriptions"` 全文件无 `turn/end` 清理；`jobs()` 无「label 看起来像命令」判据） | **新引入**（`d523941`） |
| RW-07 | P3 | `server.js:2475-2500`；`provider.ts:973` | 第二次 `planRestore` 抛错（会话已撤回、文件层失败） | 源码 | **新引入**（`2f71225` 的新失败路径） |
| RW-08 | P3 | `server.js:2086`；DSH `dsh-tools/lib/types/index.d.ts:40-48` | 某个 `tools/execute` 包装器对同一 `exec` 调用两次 `next()`（DSH 文档允许 retry 型包装器；当前已装 DSH 无此类包装器） | 源码 + 推断 | **新引入**（`2f71225`，未验证未来 DSH 行为） |
| RW-09 | P3 | `server.js:1554-1556`、`:1584`、`:1506`、`:1536` | 导入列表：`updatedAt` 实为 `createdAt`；`createdAt` 非数字时整表失败；`handle.close()` 无超时 | 源码 | 基线已有 |
| RW-10 | P3 | `server.js:1654-1664`、`:1697`；`:1684`、`:1698`、`:1506`、`:2555` vs `:1391-1418`、`:2763-2770` | 维护/错误路径一致性 | 源码 | 基线已有 |
| RW-11 | P3 | `server.js:3021-3022` | `paseo/mcp/set` 缺 `sessionId` 时 `String(undefined)` 变 `"undefined"`，返回 `accepted:true, mounted:true` 并把条目排进 `pendingMcpServers["undefined"]` | 源码 | 基线已有（与 task-1 区域重叠，仅备注） |
| RW-12 | P3 | `server.js:2312-2326`、`:2281-2298` | `subagents.interrupt` 对非驻留 child 静默 return（DSH `dsh-subagent/lib/index.js:1258-1263`），桥仍计入 "interrupted N delegated agent(s)" | 源码 | 基线已有 |

### 2.1 逐条细节

**RW-01（P2，新引入）`fileMutationTickets` 逃过 close 清理，泄漏即毒化该 root 的撤回。**
`2f71225` 在构造器新增 `this.fileMutationTickets`（`server.js:347-357`），但 `#forgetSessionState`（`:3325-3358`）的清理清单里没有它——而同一次提交把 `toolDescriptions` 加进了清单（`:3338`），说明清单本身是被维护的。`:3313-3324` 的自述不变量是「a table added to the server but not here survives a close」。
后果：票被释放前 gate 的 `active` 计数不归零；该 root 的下一次 `freeze`（`file-mutation-gate.js:151-190`）会等满 15 s 预算后抛 `timed out` → 撤回失败，且失败点在 `settleAgentForRevert`（已取消用户回合）之后。
实测（`/tmp/ticket-close-probe.mjs`，用与 `harness/rewind-transaction-check.mjs` 相同的模块解析钩子驱动真实 `PaseoHarnessServer`，不写 profile、不落 journal）：

```
after begin   : tickets=1 gateRoots=1 owns=true
closeSession  : closed=true tickets=1 gateRoots=1
later freeze  : REJECTED (The operation was aborted due to timeout) after 300ms
manual finish : tickets=0 gateRoots=0
```

触发可达性要诚实区分：真实 DSH 里 `handle.dispose()` 会取消回合并等工具收敛（`dsh-tools/lib/index.js:3397-3417` 的 body 不会悬空），随后 `tools/result` 仍会触发 `finishFileMutation`（它不依赖会话表），票会补释放——所以**永久毒化需要一个永不触发的 `tools/result`（未验证）**；上表探针是把「close 时仍持票」这一形态保留下来直接观察后果。这一条仍然该修：一行 `for (const key of [...this.fileMutationTickets.keys()]) if (key.startsWith(prefix)) …`，并补一条「close 后 tickets 为空」的用例（现有 `rewind-transaction-check` 只断言撤回结束后票为空）。

**RW-02（P2，新引入）`runMaintenance` 对所有撤回 scope 无差别强依赖。**
`revert()` 在 `planRewind` 预检之后无条件检查 `typeof agent.runMaintenance !== 'function'` 并抛错（`:2393-2396`），位置在 `restoresFiles(scope)` 之前。也就是说 `scope:"conversation"`（Paseo 的常用撤回）现在也要求这个 DSH 内部方法存在；而它不在 `harness/dsh-api-contract-check.mjs` 的覆盖内（该检查只比对桥源码里的 `@deepseek-ai/*` import 与导出符号，方法级契约不在其中），AGENTS.md 也明确说 DSH 内部 API 没有稳定性承诺。
两种具体后果：
1. 升级到没有/改名 `runMaintenance` 的 DSH：**全部撤回**（含不动文件的对话撤回）失败，比修复前（文件层不安全）影响面更大；失败是响亮的（好），但本可只让 `both` 失败。
2. 新增一个「settle 之后仍会失败」的点：`runMaintenance` 在 agent 非 idle 时抛 `already has active work`（`dsh-agent-loop/lib/index.js:822-824`）。`settleAgentForRevert` 之后若有压缩（也用 `runMaintenance`）或子代理完成唤醒根 agent，撤回会在已取消用户回合之后失败。窗口很窄（中间无 await），但这是 `2f71225` 新增的失败形态。
建议：`runMaintenance` 只在 `restoresFiles(scope)` 时要求（对话撤回保持原路径）；同时在 `dsh-api-contract-check` 或 `bridge-server-check` 里加一条「`rec.handle.agent.runMaintenance` 存在」的存在性断言，让升级时这里先红。

**RW-03（P2，基线已有，上一轮 BR-03 未修）子代理锚是「执行时根最新人类消息」，不是派发消息。**
`observeDelegatedTurn`（`:1872-1889`）在 child 每次 `turn/start` 记录 `latestHumanAnchor(root)`；`snapshotAnchorFor`（`:1902-1906`）优先用它。FIELD-NOTES #60 M2 已记录反例：H1 派子代理 → 用户发 H2 → 子代理在 H2 期间写文件/派生孙任务 → 撤回 H2 会回退/中断本属 H1 的工作。本轮复核**代码未变、限制仍成立**；`docs/REWIND.md` 的已知限制与代码一致，因此不属于「新引入回归」，但仍是这一区域最大的语义缺口。
同族的「fail-open 无原因码」也仍成立：`captureFileBeforeTool:2168-2170` 只写一行固定 stderr，归属失败时用户侧只剩「文件没回来」。

**RW-04（P3，半新）`skipped` 是用户看不见的半成功，且良性 skip 会永久阻断清理。**
`restore()` 的 `skipped` 混了两类事实：①目标已变成 symlink/目录（真未恢复，应与失败同报）；②删除型动作发现文件已不存在（**良性**，本应算成功）。桥把 `files.skipped` 原样放进回执并（新）因此跳过 prune/trim/GC（`:2504-2511`）；插件侧只消费 `failed`（`provider.ts:967-982`），全仓 `grep '\.skipped'` 无命中。于是：symlink 场景用户看到「撤回成功」而无任何提示；良性场景则让该会话的 journal/objects 在之后所有撤回中都不再被清理（资源回归，且旧行为是清理）。建议：把「已不存在的删除」从 skip 改成成功，把「非普通文件」并入 failed（或让插件对 skipped 发 error notice）。

**RW-05（P3，新引入）闸门 × `settleDelegatedWork`：被保留的在飞子代理写入让每次撤回确定性多等 3 s。**
`freeze` 在 `:2397` 取得独占后，未被撤掉的子代理（锚 < targetSeq，按设计继续跑）若正卡在 `gate.enter` 的 `blocked` 等待里，它的回合不可能 idle；而 `settleDelegatedWork`（`:2312-2326`，3 s 上限，用 `subagents.waitForChildren` → 内部 `whenIdle()`）要等它 idle。二者互等，只能靠超时解开，随后 stderr 打「delegated work did not settle after the rewind interrupt」——这句对「被闸门挡住」的场景是误导。触发窗口窄（撤回开始时恰好有被跟踪写在飞），影响是延迟与日志，不是正确性。

**RW-06（P3，新引入）两处「注释强于实现」。**
① `toolDescriptions` 的注释自称「Dropped at `turn/end` and capped per session」（`:405`），实际只有 `#forgetSessionState`（`:3338`）与 200 条上限（`:2048-2051`）会清，全文件无 `turn/end` 处理；表因此存活整个会话生命周期（有界，但描述失实）。
② `jobs()` 注释写「only for jobs whose label still looks like a command」（`:2750-2753`），实现对所有 label 直接查表（`:2786`），没有任何「像不像命令」判据。
这两处都不造成错误行为，但违反本仓库「注释不得比实现强」的既有要求（`AGENTS.md`/审查准则），且下一位维护者会按注释去改错地方。

**RW-07（P3，新引入）新失败路径的文案不自洽。**
第二次 `planRestore` 抛错时（`:2484-2500`），回执把 `files.failed[0].path` 设成 **journal 路径**，`rescue: []`；插件把它渲染成「<journal.jsonl> 恢复失败；撤回前备份已保留…被替换的当前内容已另存到 <rescueDir>」（`provider.ts:973`）。这一次什么都没恢复、rescue 目录也可能不存在——用户看到的「已另存」是假的。建议该分支改用独立文案或 `error` 字段区分「计划失败」与「恢复失败」。

**RW-08（P3，新引入，未验证未来 DSH）票的「重复身份」守卫与 retry 型包装器的冲突。**
`beginFileMutation` 对同 `(sessionId,callId)` 的第二张票直接抛 `duplicate file mutation call identity`（`:2086`）。DSH 明确允许 `tools/execute` 包装器做 retry/timeout/metrics（`dsh-tools/lib/types/index.d.ts:40-48`），而票的释放要等到 `post-execute`/`tools/result`，即**第一次 `next()` 返回之后**；若将来有包装器对同一 exec 再调一次 `next()`（当前已装 DSH 只有 timeout 与 checkpoint 两个包装器，均单次调用），第二次进入就会响亮失败该次工具调用。属于对未来 DSH 行为的脆弱点，不是现网 bug。

**RW-09（P3，基线已有）导入列表的三个保真/健壮问题。**
`#sessionSummary` 把 `header.createdAt` 当 `updatedAt` 输出（`:1554-1556`）——Paseo 的 `ProviderSessionSummary.updatedAt` 语义是「最后更新时间」，导入列表按「最近创建」排序；`new Date(非数字).toISOString()` 在 `try` 之外（`:1557` 起才是 try），一个坏 `createdAt` 会让整个 `paseo/sessions` 抛错；`handle.close()` 不在 `withTimeout` 内（`:1584`），一个卡住的 close 会让 `Promise.all` 挂住整个列表（open/read 都有 10 s 上限，只有 close 没有）。另外 `query` 只匹配 session id（`:1536`），不搜 title/preview。

**RW-10（P3，基线已有）归档 / 列表 / 权限读取的错误处理不一致；`subagents()` 的文档注释是孤儿。**
`#archivedSessionIds`/`#sessionHeaders`/`jobs` 对 `ctx.get(...)` 包了 try/catch 并给出可读原因，而 `listSessions:1506`、`applyArchived:1684`、`subagents:1698`、`permission:2555` 没有——同一个失败在四处呈现为「原始 RPC 错误」vs「点名原因」。`:1654-1664` 的 JSDoc 描述的是 `subagents()`，但它被 `applyArchived` 的 JSDoc+方法（`:1665-1695`）隔开，`subagents()`（`:1697`）自己没有注释；基线 `9298c28` 已如此。

**RW-11（P3，基线已有，与 task-1 重叠）`setMcpServers` 不校验 `sessionId`。**
`:3022` `String(params.sessionId)`：缺字段得到 `"undefined"`，随后 `sessions.has("undefined")`/`sessionCreations` 都为假，于是返回 `{accepted:true, mounted:true}` 并把条目排进 `pendingMcpServers["undefined"]`。畸形请求拿到了「已挂载」的成功回执——与同类方法（`revert` 走 `requireSession` 抛 unknown）不一致。

**RW-12（P3，基线已有）「interrupted N」可能高报。**
`cancelWithdrawnDelegations:2281-2298` 把 `subagents.interrupt()` 正常返回计为已中断；DSH 对非驻留 child 是静默 `return`（`dsh-subagent/lib/index.js:1258-1263`），桥的 stderr 因而可能声称中断了实际没被中断的 child。影响仅限日志可信度（真正危险的是「未知锚不取消」，那条策略是对的）。

## 3. 复核闭合：上一轮 P1 与本次重点

| 项 | 判定 | 证据（file:line / 实测） |
|---|---|---|
| BR-01 跨重启 captureSeq 单调 | **已修复**（本轮复核成立） | `file-snapshots.js:333-364` 在 journal 写队列内读高水位；`captureOrderVersion`（`:102`、`:508`）；`planRestore` 对无版本旧行按路径拒绝而非猜测（`:633-664`）；桥在 `setup`/`preset setup`/`resumeSetup` 末尾调 `beginOwner`（`server.js:3492`、`:3505`、`:3561`、`:3587`）。我独立核对了放置依据：DSH `setupAndPublish` 里 `setup?.(...)` 在 `prepared.publish(...)` 之前且被 await（`dsh-agent-loop/lib/index.js:1931-1933`），而写租约在 `createStoredSession` 阶段已持有——注释的因果成立。实测 `node harness/snapshot-lifecycle-check.mjs` → **8/8, exit 0**。 |
| BR-02 撤回漏掉在飞子任务写入 | **已修复**（本轮复核成立） | 顺序：`runMaintenance`（`:2396`）→ `freeze`（`:2397`）→ append → `sessions.flush`（`:2460`）→ 中断范围内子代理（`:2473`）→ `settleDelegatedWork`（`:2474`）→ **重新 `planRestore`**（`:2483`）→ restore → 仅无 failed/skipped 才 prune/trim/GC（`:2504-2524`）。我独立核对了闸门假设在 DSH 侧成立：`tools/execute` → `post-execute` → `tools/result` 传的是同一个 `ToolExecution`，`token` 是 registry 铸造的稳定身份（`dsh-tools/lib/types/index.d.ts:278-287`、`lib/index.js:3427`/`3506-3513`/`3600`）；工具 body 的异常被归一成 `isError` 结果而不是抛出（`dsh-tools/lib/index.js:3397-3417`），所以 `post-execute` 里的 `ownsFileMutation` 在失败路径同样可达；`commit` 在 `finishFileMutation` 之前 await（`index.js:98-109`），因此「drained ⇒ journal 已落盘」成立，`planRestore` 又额外 `settle()` 了写队列（`file-snapshots.js:609`）。实测 `node harness/rewind-transaction-check.mjs` → **7/7, exit 0**；`node harness/file-mutation-gate-check.mjs` → **6/6, exit 0**。 |
| BR-03 子代理归属锚定因果 | **未修复**（按设计保留，见 RW-03） | `server.js:1872-1889`；FIELD-NOTES #60 M2 记录为已知限制 |
| 在飞子任务写入是否纳入恢复 | **是**，但只覆盖「被跟踪的 write/edit/str_replace_editor」；bash、外部进程、绕过工具的写入仍不在范围内（设计边界，见 `file-snapshots.js:68-89`） | |
| 快照序号跨重启单调性 | **成立**，边界是「旧 journal 无法证明顺序时拒绝撤回并保留材料」而不是猜测；trim 后再重启也安全（高水位扫描保留条目，而被 trim 掉的必然更旧） | `file-snapshots.js:333-364`、`:813-864` |
| 部分失败回执诚实性 | **大体诚实、两处不足**：`failed` 会进回执并由插件发 error notice（`provider.ts:967-982`），且新代码在有 failed/skipped 时保留 journal 不 prune（`:2504-2511`）；不足见 RW-04（skipped 用户不可见、良性 skip 阻断清理）与 RW-07（新失败文案自相矛盾） | |
| 归档状态读失败处理 | **合格**：`#archivedSessionIds` 的三条路径（查服务抛错 / 服务缺失 / 读集合抛错）分别报告且策略一致（空集=全部未归档，`server.js:1391-1419`）；`#sessionHeaders` 两个来源分别报告（`:1437-1492`）；`listSessions` 读失败是 `available:false` 而非空列表（`:1509-1515`） | |
| history 投影保真 | **合格**：先 `visibleEvents` 折 surface（compaction 不折、本桥 rewind 缝折掉，`surface.js:93-131`），再 `historyEvents` 白名单投影 + 图片 hostPath（`image-host-path.js:376-406`），`seq` 不变因此 `inheritedEventCount` 的 `seq <` 前缀判定仍成立（`session.ts:2666` 消费方）；撤回标记的 `source.kind=paseo-rewind` 被插件 `replayRowSource` 跳过（`session.ts:343-352`） | |
| 并发/重入 | **合格**：`revertInflight` 按会话排他（`:2377-2380`）；`closeSession` 对 in-flight creation 有二次清理（`:3188-3230`）；`#trackTeardown`/`#awaitTeardown` 有界等待（`:3272-3311`）。缺口见 RW-01（新表未清） | |
| 失败路径是否响亮 | **大部分响亮**：`runMaintenance` 缺失（`:2393`）、flush 失败/无持久化参与者（`:2459-2466`）、第二次 plan 失败（`:2484-2500`）、restore 失败（`:2508-2511`）、gate 超时（`file-mutation-gate.js:176-188`）都抛或写 stderr；微弱处见 RW-04/07/12 | |

## 4. 未验证项与残余风险

1. **真实 DSH 下的永久票泄漏未复现**（RW-01）：探针把「close 时仍持票」这一形态保留后直接观察后果；真实路径里工具随后收敛、`tools/result` 补释放。要确认「永久毒化」需人为让某个执行永不结算，本轮未做。
2. **0.2.2-alpha 的 `AgentSetupCommit` 位置**未验证（注释声称 alpha 把 commit 移到 announce 之后；本机只装 0.2.1-rc.5，不装 alpha）。
3. 未执行任何真机/真实模型/daemon 撤回（约束禁止）；`harness/rewind-e2e.mjs`、`rewind-native-check.mjs`、`factory-ownership-order-check.mjs`、`bridge-server-check.mjs` 本轮均未跑（属 task-20/15 的验证范围）。我跑的三项与自建探针均为纯离线/私有临时目录。
4. **工具 body 已写文件、但流水线在 `post-execute` 之前失败**（`final-result` 路径，`dsh-tools/lib/index.js:3419-3426` 说明 "pipeline failures are already final"）时，`commit` 不会执行 → 该文件不进 journal，撤回不会恢复它。基线既有，`2f71225` 未改变；`execute` 钩子的 catch 还会 `dropFileTool` 丢掉 pending。触发需要 DSH 内部流水线失败，未验证实际概率。
5. `processor` 侧 `skipped` 的消费缺口（RW-04）跨到 `paseo-plugin/`，本任务只读；修法需要两边一起改，故只给出方向。

## 5. 健康度评分（1–5，仅本区域）

| 维度 | 分 | 依据 |
|---|---|---|
| 正确性 | 4 | BR-01/BR-02 的修复在源码与三项检查下成立；撤回事务顺序（冻结→排空→重规划→恢复→有条件清理）自洽；扣分项：子代理锚因果（RW-03）仍是已知语义缺口，RW-01 是状态生命周期缺口 |
| 健壮性 | 4 | 失败路径大多响亮且保留重试材料；边界与超时都有（15 s freeze / 3 s settle / 15 s flush…）；扣分项：RW-04/07 的回执保真、RW-01 的清理不变量 |
| 可维护性 | 3 | `revert` 新增包装后 `:2396-2538` 整段缩进未对齐、`try`/`finally` 嵌套靠注释理解；孤儿 JSDoc；两处注释强于实现（RW-06）；`ctx.get` 错误处理四种写法 |
| 契约一致性 | 3 | 新增对 DSH 内部方法 `runMaintenance` 的硬依赖且无契约门（RW-02）；`skipped` 字段写了没人读（RW-04）；`setMcpServers` 接受畸形请求（RW-11）；归档/列表/权限的读取失败呈现不一致（RW-10） |
| 性能 | 4 | 撤回路径没有 O(n²)；新闸门在正常路径是 O(1) 票操作；扣分项：RW-05 的确定性 3 s 等待、`subagents()` 每次读全量 session headers 的外层成本（基线，热点路径） |
| 安全 | 4 | 本段只调用 `file-snapshots.js` 的恢复层（绝对路径/哈希校验、`lstat` 不跟随符号链接在那边）；回执里出现的是本机绝对路径（本机用户的 journal），非凭据；未发现新增攻击面 |
| 测试覆盖 | 4 | `2f71225` 的四项新检查质量高（时序断言、闸门对抗用例、注释称已做过变异验证），我实跑三项全绿；缺口：close 后票清理、`runMaintenance` 缺失的契约级断言、RW-05 的交互、skipped 的用户可见性都没有用例 |
| **综合** | **3.7** | |

**一句总评**：撤回事务已经从「先定计划再等 flush」改造成「冻结—排空—重规划」，两个 P1 的修复站得住；剩下的问题不在撤回顺序，而在新增状态的生命周期、新增内部依赖的爆炸半径，以及「半成功」对用户是否可见。

**Top 问题（≤5）**
1. RW-01（P2，新）`fileMutationTickets` 未进 `#forgetSessionState` 清理清单 → 泄漏即让该 root 之后的撤回 15 s 超时失败。
2. RW-02（P2，新）`runMaintenance` 对所有 scope 强依赖 → conversation-only 撤回也被绑上无契约门的内部 API。
3. RW-03（P2，基线）子代理/孙任务锚到「执行时根最新人类消息」而非派发消息（BR-03 未修，文档化限制）。
4. RW-04（P3，半新）`skipped` 半成功用户不可见，且良性 skip 会永久阻断该会话的 prune/trim/GC。
5. RW-05（P3，新）闸门与 `waitForChildren` 互等 → 命中时每次撤回确定性多 3 s 并打误导日志。

**建议优先级**：先修 RW-01（几行 + 一条用例）与 RW-02（按 `restoresFiles(scope)` 条件化 + 契约存在性断言）；RW-04 与插件侧一起改文案/分类；RW-05 可延后（先量一次真实撤回的 3 s 命中率）；RW-03 维持文档化，按 FIELD-NOTES #60 M2 的「派发回合取锚」另设设计。RW-06/RW-07/RW-10/RW-11/RW-12 属清理项，可合并到一个文档/一致性小提交。

**是否有阻断性健康问题**：**无 P0/P1**。RW-01 与 RW-02 建议在下一个发布前修掉，但不构成对本批次修复的回退结论。
