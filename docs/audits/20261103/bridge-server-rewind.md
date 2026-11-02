# dsh-bridge 撤回链路（server.js revert / revert.js）只读审查

- 仓库：`~/apps/paseo-dsh`，基线 HEAD `0c82df5`（2026-11-02 21:37 +0800），main；工作区仅 `V1.txt` / `v1.txt` 未跟踪（未动），`docs/audits/20261103/` 为本轮审查输出目录。
- 环境：Node v22.23.1；本机 DSH `0.2.1-rc.5`（`~/.npm-global/lib/node_modules/@deepseek-ai/dsh`）；Paseo 宿主 `@getpaseo/server@0.14.0`（随 `@getpaseo/cli` 安装，仅只读核对行为）。
- 审查方式：fresh 上下文、独立只读。逐个通读 `dsh-bridge/lib/server.js` 的撤回链路（`revert` 2636-2868、`settleAgentForRevert` 2017-2046、`beginFileMutation`/`finishFileMutation`/`ownsFileMutation` 2300-2375、`cancelWithdrawnDelegations` 2484-2539、`settleDelegatedWork` 2541-2588、`minRewindableAnchor` 2590-2609、`#forgetSessionState` 3639-3699、`closeSession` 3430-3560、`prompt`/`cancel` 1171-1267、`handleRequest` 3274-3320、`createSession`/`resumeSetup` 3800-3940）与 `dsh-bridge/lib/revert.js` 全文；对照 `docs/REWIND.md`（§契约、§实现、§只回文件、§刷新、§行为约定）、`docs/FULL-AUDIT-20261102.md` §3.2/§4.1/§10.1、`docs/AGENTS.md` 撤回四条约束、`docs/PLAN-REWIND-NATIVE.md` §8.1 K3/§560。
- 为判断撤回接缝，另读（不单独出结论，归属其他 lane）：`file-mutation-gate.js` 全文、`file-snapshots.js` 的 `capture/commit/planRestore/restore/prune/trim/collectGarbage/beginOwner` 段、`child-anchors.js`、`delegated-cancel.js`、`snapshot-owners.js`、`dsh-bridge/lib/index.js` 的工具钩子、`paseo-plugin/server/provider.ts` 的 `session.revert` 分支与 `session.ts` 的 `revert` 透传、宿主 `agent-manager.js` / `plugin-provider.js` 的 `rewind` 实现、DSH `dsh-agent-loop/lib/index.js` 的 agent/inbox 内部实现。
- 改动范围核对：`e7472be..HEAD` 中只有 **88adebb** 改过 `server.js` / `revert.js`（新增 `files` scope）；13951ad/aa72484/8091777 只改插件提示层，未动桥源码；`node harness/bridge-assets-check.mjs` **2/2 PASS**，内嵌桥与源码一致，因此本报告的桥结论即发布产物结论。
- 证据纪律：标【实测】的均有可复现命令/探针与 exit code 或输出片段；探针只写 `/tmp`，不写产品代码/文档/harness，不跑真实 daemon/profile/模型，不执行 git 写操作。

## 1. 范围与方法

### 1.1 复核：`6394809`（p1a-rewind-txn）五条修复在当前 HEAD 上成立

| 条目 | 判定 | 证据 |
|---|---|---|
| RW-01 / CORE-05（`fileMutationTickets` 不在 `#forgetSessionState` 清理清单） | **已修复，成立** | `server.js:3675-3689` 按「键前缀 = 被关会话」或「`ticket.root` = 被关根」删除并 `release()`；`beginFileMutation:2324-2336` 在 `enter` 解析后按身份复核（被退休的票 release 后抛错，不会放行）。`node harness/rewind-transaction-check.mjs` 用例 7「closing a session drops its file-mutation tickets and releases the gate lease」通过【实测，17/17 exit 0】 |
| RW-02（撤回对所有 scope 强依赖 `agent.runMaintenance`） | **已修复，成立** | `server.js:2673-2675` 改为 `restores && typeof agent.runMaintenance !== 'function'` 才拒绝，且位于 `settleAgentForRevert`（2676）之前；conversation-only 走 `applyRewind(undefined)`（2863）不经过 `runMaintenance`。用例 8 双向断言通过【实测】 |
| BF-04（conversation-only 也无条件先拿文件闸门） | **已修复，成立** | `server.js:2678` `restores ? await freeze : undefined`；`finally`（2857-2861）只释放已取得的闸门。用例「a conversation-only rewind does not freeze the file gate」通过【实测】 |
| RW-04（闸门 × `waitForChildren` 互等，每次多等满 3s） | **已修复，成立** | `settleDelegatedWork:2560-2582` 改为按 `cancelWithdrawnDelegations` 返回的 child id 用 `agents.get(childId).whenIdle()` 逐个 join，不再 `subagents.waitForChildren(agent)`；只有拿不到 `agents.get` 才退回旧路径（见 BSR-05）。用例 9/10 断言「被保留、卡在闸门上的 child 不再造成 3s 互等」「join 按身份、不走全子等待」【实测】 |
| RW-05（第二次 `planRestore` 失败把 journal 路径塞进 `files.failed`） | **已修复，成立** | `server.js:2772-2796` 改为独立 `files.error` 通道：`failed`/`skipped`/`rescue` 全空、`rescueDir: ''`、文案点名「文件恢复计划失败，未执行任何恢复」并给出 journal 重试材料；插件侧 `provider.ts:1104-1170` 按 `files.error` 走 warning 行、不承诺 rescue。用例 10 与我的探针 [3] 双向验证【实测】 |

同轮（p1b）与本 lane 相接的两条也复核为成立：**BR-03/BM-02**（孙任务锚继承直接派发者）——`child-anchors.js:96-125` `recordDelegatedTurn` + `server.js:2087-2116` 接线，代码与 `docs/REWIND.md:94-98` 一致；**BF-03**（部分成功回执响亮）——桥把 `unrecoverable` 折进 `skipped`（`server.js:2798-2810`）且 `failed/skipped` 非空时跳过 prune/trim/GC（2811-2822），插件 `provider.ts:1104-1170` 已消费 `failed/skipped/unrecoverable/error` 四类。

### 1.2 本轮新增（88adebb）：`files` scope 的桥侧实现

`revert.js`：`revertScope` 接受 `files`（128-131），`restoresFiles('files')` 为真（139-141），`successText(seq,'files')` 返回「Restored files to seq N」（155-158）。
`server.js`：`rewindsConversation = scope !== 'files'`（2651）把「追加替换标记 + `sessions.flush`」（2701-2752）与「prune/trim/GC」（2823-2840）都关进该条件；`files` 与 `both` 共用 settle、freeze、取消/等待被撤子代理、二次 plan、restore 与 `files` 回执（2676-2864）。

逐条核对 `docs/REWIND.md:146-163` 的 files-only 声明：不 append / 不 flush / 不折叠时间线 / 不发 canary（桥侧无 canary，插件 `provider.ts:1093` 跳过）、不 prune/trim/GC、重复 files-only 幂等、files-only 后 `both` 取目标消息自己的 pre-image —— 代码与用例 13/14（`harness/rewind-transaction-check.mjs:692-788`）一致，我用独立探针复核了 journal 语义（见 3.2 阴性结论）。

## 2. 健康度评分（1–5，仅本区域）

| 维度 | 分 | 依据 |
|---|---|---|
| 正确性 | 4 | 撤回事务顺序（settle → freeze/排空 → 追加+flush → 取消/等待被撤子代理 → 重规划 → restore → 有条件清理）自洽；p1a 五条修复全部成立；files-only 的对话零改动、journal 保留、pre-image 选择均经用例与独立探针复核。扣分：files-only 在首条消息下被错误拒绝（BSR-01，唯一 P2） |
| 健壮性 | 4 | 失败路径响亮（缺 `runMaintenance`、flush 失败/无持久化参与者、二次 plan 失败、restore 部分失败、闸门超时均抛或回执+stderr）；闸门在 finally 释放、失败保留 journal 重试材料、close 清票。扣分：files-only 计划失败的回执文案与 `files.error` 自相矛盾（BSR-02） |
| 契约一致性 | 3 | files-only 复用了为「对话被撤」设计的 settle 语义（排队输入一并丢弃，BSR-03）；桥↔宿主的 prompt/revert 串行化依赖宿主的 run 锁而桥自身无守卫（BSR-04，文档未记）；conversation 撤回仍硬依赖无契约门的 agent 内部形状（BSR-06） |
| 可维护性 | 4 | 撤回段注释密度高且大部分与实现一致（含失败语义与「为什么不是 X」）；`rewindsConversation` 一处条件化比复制整段好。扣分：`revert` 已长到 230 行嵌套闭包，新 scope 靠注释区分，首条拒绝规则未随 scope 收敛（BSR-01 的根因之一） |
| 测试覆盖 | 4 | `revert-check` 120/120、`rewind-transaction-check` 17/17（含 files-only 用例 11-14）、`file-mutation-gate-check` 6/6、`bridge-assets-check` 2/2 全绿【实测】。缺口：files-only + 首条消息、计划失败文案、排队输入、prompt/revert 交错均无用例（正是本轮 P2/P3 落点） |
| 性能 | 4 | 撤回路径无 O(n²)；闸门正常路径 O(1)；settle 上限 3s、freeze 上限 15s 都有界。扣分：BSR-05 的 fallback 会把旧的 3s 全子等待带回来（当前 DSH 不可达）；files-only 从不 trim/GC（BSR-08） |
| 安全 | 4 | 撤回本身不扩大攻击面：恢复层（路径身份/符号链接/`..` 校验）在 `file-snapshots.js`（另一 lane 深审），桥只把 journal 绝对路径写进回执（本机用户私有目录，非凭据）；`files` scope 不新增外部输入面 |
| **综合** | **3.9** | 撤回事务是这块代码里最成熟的一段：上一轮两个 P1 的修法在源码与 17 项事务用例下站得住，files-only 的主干语义（不动对话、保留 journal、取消被撤子代理）实现正确。剩余问题集中在**新 scope 与旧产品规则的接缝**（首条消息拒绝、回执文案、排队输入）和**跨层契约的隐式依赖**（宿主串行化、agent 内部形状），没有 P0/P1。 |

## 3. 发现列表

严重度口径：P0 数据丢失/安全灾难；P1 会话可用性/恢复正确性；P2 功能/数据/契约；P3 显示/可维护性/窄触发。归属：**新引入** = 88adebb（本轮唯一改桥的提交）；**基线已有** = 该问题在 88adebb 之前即存在。

| ID | 级别 | file:line | 触发条件 | 证据等级 | 归属 | 摘要 |
|---|---|---|---|---|---|---|
| BSR-01 | **P2** | `dsh-bridge/lib/revert.js:109-110`；`dsh-bridge/lib/server.js:2662-2663` | `scope:"files"` 且撤回令牌指向**当前可见对话的第一条人类消息**（Paseo 撤回菜单按能力位渲染、不按行隐藏，因此该行可点） | 【实测】`/tmp/bsr-probe-20261103.mjs` 场景 1；对照用例与文档 | **新引入**（88adebb 新增 files scope，未重审 `planRewind` 的首条规则） | files-only 本不动对话、不会清空会话，却仍被「首条消息禁止撤回」拒绝；用户拿到的理由与操作不符，且「只回退文件」在首条消息下不可用。应先按 scope 决定是否套用首条规则（或至少在 files scope 下改文案/支持） |
| BSR-02 | P3 | `dsh-bridge/lib/server.js:2785`（`text: successText(resolved.targetSeq, scope)`）、`:2854` | `scope:"files"` 且第二次 `planRestore` 抛错（journal 歧义/IO 错误），即回执带 `files.error`、`files.restored` 为空 | 【实测】探针场景 3：`text="Restored files to seq 10"` + `files.error` 非空 + `restored=0` | **新引入** | 回执正文声称「已恢复文件」，与同一回执里的 `files.error`（未执行任何恢复）矛盾。插件按 `files.error` 发 warning、不会误报给用户，但回执本身（日志/其它消费方/后续 e2e 断言）不可信；`files` 分支应改用「未执行」文案 |
| BSR-03 | P3 | `dsh-bridge/lib/server.js:2038`（`settleAgentForRevert` 丢两条收件箱）、调用点 `:2676` | `scope:"files"` 且撤回时 agent 非 idle、收件箱有排队输入（`nextStep`/`nextTurn`） | 【实测】探针场景 2：撤回后两条队列均空、`surface` 仍为 `[0,10,20]`（对话未动）；【源码】宿主在 rewind 前会先取消在飞 run（见 BSR-04 证据），因此现网流程中该队列通常已被宿主清空 | **新引入**（files scope 让这段为「对话被撤」设计的语义落到了「对话不动」的场景） | files-only 不撤回任何消息，却把用户排队中的后续输入一并丢弃（`inbox.remove` 只留「被取消」的 splice 事件，没有用户可见回执）；`docs/REWIND.md:153` 只说「取消运行中的根回合」，未说明排队输入也会丢。建议 files-only 不丢 `nextTurn`（或至少文档化+回执提示） |
| BSR-04 | P3 | `dsh-bridge/lib/server.js:2636-2868`（全段无 prompt 互斥）；对照 `revertInflight:2653-2656` | 非宿主调用方（或未来宿主版本）在 `paseo/revert` 在飞时并发投递 `session/prompt` | 【实测】探针场景 4：freeze 排空期间投递的 prompt 被折进替换范围（`sourceEventSeqs=[10,20,30]`、surface 变为 `[0,1000]`），其回合从未被 settle；【源码】宿主 0.14.0 侧已核实串行化：`agent-manager.js:2398-2401` rewind 先 `cancelAgentRunBefore` 再 `createPendingRun`，`streamAgent` 在 `runs.hasRun` 时抛 `already has an active run`（`:1883`、`hasInFlightRun:502-509`） | **基线已有**（`docs/PLAN-REWIND-NATIVE.md:560` 已列为未验证推断，本轮核实） | 桥没有「撤回进行中拒绝 prompt」的守卫，`revertInflight` 只挡第二次撤回；「追加前 agent 必须空闲」这一文档不变量当前由宿主 run 锁隐式保证。宿主 0.14.0 下**不可达**（无现网影响），但这是未写进文档的跨层契约：宿主若把 prompt 排进 pending run 之后投递，被撤内容会「复活」/新 prompt 被吞。建议桥侧加 guard 或把该依赖写进 REWIND.md |
| BSR-05 | P3 | `dsh-bridge/lib/server.js:2574-2577` | `ctx.get('agents')` 缺失或 `agents.get` 不是函数（DSH 改 API 形状），且撤回覆盖了被撤子代理 | 【源码】该分支回退到 `subagents.waitForChildren(agent)`（= 等**全部**子孙 idle），重新引入上一轮 RW-04 的「被保留子代理卡在闸门上 → 确定性多等 3s」；当前 DSH `ctx.agents.get` 存在（`assertLiveAgent:3708-3712`、`dsh-subagent/lib/index.js:1261` 都在用），不可达 | **基线已有**（`2f71225` 的修复保留了 fallback；本轮未清） | 修复只覆盖主路径，fallback 是旧行为；`agents.get` 一旦改名会静默退回 3s 全子等待并打误导日志。建议 fallback 也按 child id 过滤，或直接抛可读错误 |
| BSR-06 | P3 | `dsh-bridge/lib/server.js:2033-2046`（`agent.cancel(cause,{keepInbox})`、`agent.inbox.nextStep/nextTurn/remove`、`agent.whenIdle`）；对照 `harness/factory-ownership-order-check.mjs:301-311` | DSH 升级后这些 agent 内部形状改名/移除 | 【源码】`dsh-agent-loop/lib/index.js:815`（cancel 第二参）、`:145`（inbox.remove）、`:870`（whenIdle）均为无稳定性承诺的内部实现；`dsh-api-contract-check` 只查 import，`factory-ownership-order-check` 只钉了 `runMaintenance` 存在性 | **基线已有**（RW-02 同类风险；上轮修复只条件化了 `runMaintenance`） | conversation 撤回现在完全不依赖 `runMaintenance`，但仍 100% 依赖上述 agent 内部方法；一次改名会让**所有 scope** 的撤回以 TypeError 失败（响亮但无指引）。建议把这三项加入 `factory-ownership-order-check` 的存在性断言（与 `runMaintenance` 同法） |
| BSR-07 | P3 | `dsh-bridge/lib/server.js:2676`（先 settle）→ `:2691-2695`（首次 `planRestore` 才读 journal） | `scope:"both"/"files"` 且 journal 首次读取即抛错（旧行歧义/IO 错误） | 【实测】探针场景 5：`cancelled=true` 之后请求才失败 | **基线已有** | journal 不可读本可在取消用户回合之前用一次廉价预读发现（与 `planRewind` 预检同理），现在会先取消正在跑的回合再失败；用户重试仍是同一错误。P3 级（journal 损坏罕见、失败响亮），修法：settle 前加一次 `readJournal` 探针 |
| BSR-08 | P3 | `dsh-bridge/lib/server.js:2823-2840`（prune/trim/GC 只在 `rewindsConversation` 分支） | 用户只使用 files-only 撤回，长期不触发 conversation/both 撤回 | 【源码】`prune` 语义上必须跳过（对话仍在，pre-image 还要用）；但 `trim` 的语义边界（`minRewindableAnchor` = 第二老可见人类消息）在 files-only 下**没有变化**，未被 trim 的不可达条目及其 `objects/` 会一直累积，`MAX_ANCHORS` 硬上限在这条路径上永不生效 | **新引入**（files scope） | 纯资源问题：files-only 用户越常用、journal/objects 越大，且 docs 只写了「不 prune」没写「也不 trim/GC」。建议 files-only 在 restore 后跑 `trim(minRewindableAnchor)` + `collectGarbage`（不 prune），或文档明确「files-only 不回收，直到一次 conversation 撤回」 |

> 上表 `file:line` 均为当前 HEAD `0c82df5` 行号。

### 3.1 逐条细节

**BSR-01（P2，新引入）files-only 在首条消息下被「首条消息禁止撤回」拒绝。**
`revert()` 对所有 scope 先做 `planRewind` 预检（`server.js:2662-2663`），而 `planRewind` 在目标等于第一条可见人类消息时无条件返回 `FIRST_MESSAGE_REFUSAL`（`revert.js:109-110`）。这条产品规则的依据是「撤掉它等于清空整个对话，Paseo 客户端对重建后空对话的 live 刷新不可靠」（`revert.js:103-108`、`docs/REWIND.md:324-329`）——**只对 conversation/both 成立**；`files` 不 append、不 flush、不重建时间线（`server.js:2701-2752` 的条件化已证明这一点），`planRestore(targetSeq)` 对首条消息的语义（恢复该消息之后所有编辑工具改动）完全定义良好。
实测（`node /tmp/bsr-probe-20261103.mjs`，驱动真实 `PaseoHarnessServer.revert`，私有临时目录、无 profile/daemon）：

```
[1] files-only rewind under the FIRST human message
  PASS  files-only under the first message is refused  — 首条消息禁止撤回
  PASS  the refusal reason is the conversation-emptying one  — 首条消息禁止撤回
  PASS  the refusal happens before any side effect (no cancel / no append / no flush)
  PASS  the same files-only rewind under message 2 restores the file
        — {"kind":"success","text":"Restored files to seq 10","files":{"restored":[".../root-1-file"],...}}
```

可达性：Paseo 的撤回菜单按 provider 能力位渲染、不按行隐藏（`docs/REWIND.md:328-329` 记录的是 conversation 场景，但同一机制对 files 生效；宿主 `plugin-provider.js:1405` `supportsRewindFiles` 决定菜单项），因此首条消息行上点「只回退文件」就会拿到这条错误。文档 files-only 节（146-163）没有这条限制，行为与文档不一致。
影响：一个已声明的能力位在合法输入上不可用，且错误原因误导用户（用户没有要求撤回消息）。**这是本 lane 唯一 P2**。

**BSR-02（P3，新引入）files-only 计划失败的回执正文与 `files.error` 矛盾。**
二次 `planRestore` 抛错时，两条 scope 走同一个返回（`server.js:2783-2795`），正文用 `successText(targetSeq, scope)`：`both` 得到「Withdrawn seq N…」（真实——对话已撤），`files` 得到「Restored files to seq N」（**未恢复任何文件**）。实测：

```
[3] plan-failure receipt text for files-only vs both
  PASS  files-only plan failure returns files.error
  PASS  files-only plan failure restores nothing
  PASS  but its text still claims the files were restored  — text="Restored files to seq 10"
  PASS  both text only claims the withdrawal (which did happen)
```

插件侧不会误报（`provider.ts:1112-1170` 先看 `files.error` 并 `return`，不发成功行），所以这是回执/日志/契约层的不诚实，不是用户可见误报。修法：该分支对 `files` 用「文件恢复计划失败，未执行任何恢复」类文案（或干脆把 `text` 按 `files.error` 生成）。

**BSR-03（P3，新引入）files-only 丢弃不在撤回范围内的排队输入。**
`settleAgentForRevert`（`server.js:2033-2046`）对所有 scope 都执行「cancel + 同步移除 `inbox.nextStep` 与 `inbox.nextTurn`」，其文档理由（`:2026-2032`、`docs/REWIND.md:55-62`）是「排队回合尚未进入 surface，按构造就在目标之后，丢弃与撤回范围一致」——这只对 conversation/both 成立。files-only 不撤任何消息，排队回合既不在目标之后、也没有被撤回，却同样被丢。
实测：

```
[2] files-only rewind drops queued follow-ups it does NOT withdraw
  PASS  the files-only rewind succeeds
  PASS  the running turn is cancelled (documented)
  PASS  both queued inbox lists are emptied  — nextStep=0 nextTurn=0
  PASS  the conversation surface is unchanged (nothing was withdrawn)  — [0,10,20]
```

现网可达性要诚实标注：宿主 `rewind()` 在 `hasInFlightRun` 时会先 `cancelAgentRunBefore`（`agent-manager.js:2398-2401`），而 provider `session.interrupt` → 桥 `session/cancel` → `agent.cancel({kind:'user'})`（`server.js:1265`，不带 `keepInbox`）会先清空收件箱；因此**经 Paseo 的正常路径上这段 drop 通常已是 no-op**。但桥的契约本身不自洽（files-only 声称「不动对话」却丢输入），若宿主行为变化/别的调用方直接调 `paseo/revert` 就会静默丢用户输入；文档也未写。P3。

**BSR-04（P3，基线已有）桥无 prompt/revert 互斥，靠宿主 run 锁兜底。**
`paseo/revert` 与 `session/prompt` 在 transport 层是并发处理的（`transport.js:317` `void this.#handleFrame(frame)`，`345-359` 逐帧独立 await），而 `revert()` 只挡第二次撤回（`revertInflight:2653-2656`），不挡 prompt。我在 freeze 排空窗口内投递一条 prompt（等价于 DSH 的 `agent.followup` 追加 `user/message` 并开回合），实测撤回照常成功，但：

```
[4] a prompt delivered inside the rewind window is folded into the replacement
  PASS  the rewind still reports success
  PASS  the prompt that arrived mid-rewind was withdrawn with the target range  — [0,1000]
  PASS  the replacement range covered the mid-rewind message  — [10,20,30]
  PASS  the turn opened by that prompt was never settled (still running)  — running
```

即「追加前 agent 必须空闲、之后不得再有事件落在替换节点之后」这条不变量被破坏（用户新 prompt 被折进替换区间，其回合继续跑）。**当前宿主不可达**：`@getpaseo/server@0.14.0` 的 `AgentManager.rewind` 先取消在飞 run 再 `createPendingRun`（`agent-manager.js:2398-2401`），而 `streamAgent` 在 `runs.hasRun(agentId)` 时直接抛 `Agent … already has an active run`（`:1883`，`hasInFlightRun` 见 `:502-509`），所以撤回 pending 期间 prompt 根本到不了 provider。`docs/PLAN-REWIND-NATIVE.md:560` 把这条列为「未验证」——本轮核实为「宿主兜底、桥自身无守卫」，建议写进 REWIND.md 的跨层依赖清单，或桥侧加 `revertInflight` 式 prompt 拒绝（更响亮）。

**BSR-05（P3，基线已有）`settleDelegatedWork` 的 fallback 保留旧的全子等待。**
主路径（`server.js:2566-2573`）已按 child id join；但 `agents` 服务缺失/`agents.get` 不是函数时走 `subagents.waitForChildren(agent)`（`:2574-2577`），这是上一轮 RW-04 的原始形态：等**全部**子孙 idle，包括锚更早、按设计继续运行且可能正卡在本次 freeze 上的子代理 → 确定性多等 3s + 误导日志。当前 DSH 0.2.1-rc.5 的 `ctx.agents.get` 是既有服务（`server.js:3709` 自己就在用），故不可达；属于 DSH 升级后的静默退化点。建议 fallback 也按 childIds 过滤（拿不到 agent 就只等 signalled 的 id），或直接抛「无法按身份 join 被撤子代理」的可读错误。

**BSR-06（P3，基线已有）conversation 撤回仍硬依赖无契约门的 agent 内部形状。**
p1a 把 `runMaintenance` 条件化后，conversation 撤回不再依赖它；但 `settleAgentForRevert` 仍无条件使用 `agent.status`、`agent.cancel(cause, {keepInbox})`、`agent.inbox.nextStep/nextTurn`、`inbox.remove(id)`、`agent.whenIdle()`。这些在 DSH 里是 `dsh-agent-loop/lib/index.js:815/145/870` 的内部实现，没有稳定性承诺；`harness/dsh-api-contract-check.mjs` 只核对 import，`harness/factory-ownership-order-check.mjs:301-311` 只钉了 `runMaintenance` 存在性。一次改名会让**所有**撤回在 settle 处 TypeError（响亮但无指引）。与上一轮 RW-02 同类，建议把这三项补进同一个存在性断言（成本几行，收益是把「升级即全撤回不可用」提前到 CI）。

**BSR-07（P3，基线已有）journal 首次读取失败发生在取消用户回合之后。**
`revert` 的顺序是 settle（`2676`）→ `runMaintenance`/freeze → 首次 `planRestore`（`2691`）。若 journal 在首次读取即抛错（`planRestore` 的旧行歧义 fail-closed、`readJournal` IO 错误），用户正在跑的回合已经被取消，然后请求以通用错误失败；重试仍会失败。实测：

```
[5] files-only with a running turn: journal plan failure after the cancel
  PASS  the first (pre-log) plan failure fails the request  — cannot prove file snapshot capture order for /x; journal and backups retained
  PASS  the user turn was already cancelled before the failure
```

修法：settle 之前做一次只读 `readJournal` 探针（不需要准确 plan，只为把「journal 不可用」提前到取消之前）。

**BSR-08（P3，新引入）files-only 路径永不 trim/GC，不可达条目与 objects 累积。**
`prune` 在 files-only 下必须跳过（对话仍在，pre-image 仍被后续撤回需要，`docs/REWIND.md:158-163`）；但 `trim`（`file-snapshots.js:1042-1069`，按 `minRewindableAnchor` 裁掉未来撤回永远选不到的锚点）与 `collectGarbage`（`:1085-1121`）也一并被跳过。`minRewindableAnchor`（`server.js:2603-2609`）只依赖可见人类消息，files-only 不改变 surface，因此「第二老可见人类消息之前」的条目在 files-only 下同样不可达——本可安全回收。后果纯资源：只做 files-only 的用户，journal 行数与 `objects/` 随编辑次数单调增长，`MAX_ANCHORS=1000` 的硬上限在这条路径上永不生效。建议 restore 成功后对 files-only 跑 `trim(minRewindableAnchor)` + `collectGarbage`（不 prune），或在 REWIND.md 明确「files-only 不回收，等一次 conversation 撤回」。

## 4. 阴性结论（本轮核实为「无问题/已修好」的项）

1. **p1a 五条修复全部成立**（见 1.1），且在 `rewind-transaction-check` 17/17 中逐条有回归；没有发现修复轮引入的撤回正常路径新回归。
2. **`files` scope 不动对话**：不 append、不 flush、不依赖 `sessions` 服务（用例 11 断言 `appended=false`、`flushCalls=0`、无 session store 也成功；探针场景 2 复核 surface 保持 `[0,10,20]`）。
3. **files-only 的 journal 语义正确**：不 prune（用例 13/14 断言 journal 行数保持），重复 files-only 幂等（同一 pre-image），files-only 后对更晚消息做 `both` 仍取目标消息自己的 pre-image（用例 14 断言 v1→v2→v0 序列）；我按 `planRestore` 的「anchorSeq ≥ target 的最早 capture」规则独立推演了「files-only 后再 both 更早/更晚/同一消息」三种情形，结论与用例一致。
4. **回执诚实性（部分失败）**：`failed/skipped/unrecoverable` 非空时保留 journal 与 rescue、不 prune/trim/GC；`files.error` 与逐文件失败分离；插件按四类字段发 warning、不编数字、不承诺不存在的 rescue。BSR-02 只影响 `text` 字段，不影响用户可见提示。
5. **闸门生命周期**：`freeze` 的所有失败路径都 `release()`（`file-mutation-gate.js:179-184`），`applyRewind` 的 `finally` 释放已取得的闸门（`server.js:2857-2861`），close 释放票与租约（`#forgetSessionState:3675-3689`）；`file-mutation-gate-check` 6/6 与事务用例 6/7 覆盖。
6. **canary 顺序机制（桥侧底座）**：桥在 `sessions.flush` 成功后才返回回执（`server.js:2739-2752`），transport 在 handler 解析后才写响应（`transport.js:350-358`）；插件侧在收到回执后、`request.completed` **之前**发 canary（`provider.ts:1093-1101`），`files` scope 不发（`:1093`）——与 `docs/AGENTS.md` 第四条、`docs/REWIND.md:165-208` 一致；`revert-check` 用源码顺序断言把这条钉住（`harness/revert-check.mjs:259-296`）。canary 在真实 daemon 上被 rewind run lock 吞掉的交付层问题属已知（FIELD-NOTES 78、`docs/REWIND.md:196-203`），不是本轮改动引入。
7. **宿主 `files` 语义与文档一致**：`@getpaseo/server@0.14.0` 的 `agent-manager.js:2405-2412` 对 `mode==="files"` 跳过 force-hydrate，`plugin-provider.js:1302` 只在 `scope !== "files"` 时截断 history；桥的 `files` 分支与宿主两侧对齐，无「回执后仍刷新/截断」的错位。
8. **内嵌桥新鲜度**：`node harness/bridge-assets-check.mjs` 2/2 PASS（21 个桥文件逐字节一致），88adebb 的桥改动已进入发布产物。
9. **`revertInflight` 语义**：按会话排他、`finally` 释放、close 时清理（`server.js:2653-2656`、`2865-2867`、`3666-3669`）；第二次撤回是 `request.failed` 而非静默（`docs/REWIND.md:323`）。
10. **首条消息拒绝本身（conversation/both）**：预检在 `settleAgentForRevert` 之前（`server.js:2662` vs `2676`），不改日志、不打断回合——`revert-check` 有专门的接线断言；问题只在它被无差别套用到 files（BSR-01）。

## 5. 未验证项

1. **真实 daemon/真实模型/真机 UI 全部未跑**（任务约束禁止）：files-only 在真实 Paseo 客户端上的菜单、toast、时间线表现，以及 `files-only` 首条消息拒绝的真实用户路径，均为源码/宿主代码推断。
2. **宿主版本差异**：只核对了本机 `@getpaseo/server@0.14.0`；更早/更新版本的 run 锁与 `mode` 透传未验证（BSR-04 的「当前不可达」仅对 0.14.0 成立）。
3. **`planRestore` 旧行歧义 fail-closed 的真实频率**（BSR-07 的触发面）：需要跨版本升级的真实 journal，未构造；探针是用人工抛错模拟。
4. **BSR-03 的现网可达性**：宿主预取消使排队输入通常已空；「取消超时后仍 running 的回合带排队输入」这一窄窗口未在真实宿主上复现（需要真实 daemon 与可注入的慢取消）。
5. **`files-only` 大量重复撤回后的 journal/objects 实际增长量**（BSR-08）：只做了静态推演，未做长跑压测。
6. **DSH `0.2.2-alpha` 的 agent/inbox 形状**未验证（本机只装 0.2.1-rc.5）；BSR-06 的「改名即全撤回 TypeError」是推断而非实测。
7. 未运行：`harness/rewind-e2e.mjs`、`rewind-merge-e2e.mjs`、`rewind-native-check.mjs`、`factory-ownership-order-check.mjs`、`host-contract-sim.mjs`、`local-patches-check.mjs`（分别属真机/耗 token、其它 lane 或需 daemon；其中 `host-contract-sim` 只与 canary 交付层相关，非本 lane 文件）。
8. 真实 `session.revert.files` 端到端（Paseo UI → 宿主 → 插件 → 桥）未跑，只有宿主源码核对。

## 6. 跨 lane 提示

1. **plugin-provider / rewind-notice lane**：`provider.ts:1104-1170` 对 `files.error` 的处理依赖桥回执的 `text` 吗？我确认它只用 `files.error` + 四个数组、且 `return` 后不发成功行——所以 BSR-02 的桥文案目前不会造成用户可见误报；但若后续有 lane 让 completion 行引用 `result.text`，BSR-02 会立刻变成用户可见的假话。
2. **client lane（撤回胶囊/提示行）**：`files` scope 的 completion 报告走「回执后直接 append」（`docs/REWIND.md:225-231`、`server/rewind-notice-append.ts` 对 `scope === "files"` 不订阅 replacement），与桥的「files 不 append 日志」一致；若 client 侧对 `kind: dsh-rewind-notice` 行做任何「必须有替换事件」的假设，会漏掉 files 行。
3. **file-snapshots lane**：BSR-08 的修法需要 `trim`/`collectGarbage` 在 files-only 后被调用；`minRewindableAnchor` 是 `server.js` 的，`trim` 的语义边界在 `file-snapshots.js:1022-1069`——两边约定「files-only 只 trim+GC、不 prune」即可，不需要改 `planRestore`。
4. **bridge-core lane（prompt/cancel 区域）**：BSR-04 若要在桥侧加守卫，落点在 `prompt()`（`server.js:1171-1217`）读 `revertInflight` 并返回可读拒绝；`revertInflight` 的注释（`:441-447`）目前只描述「第二次撤回」，加 guard 时一并改注释。注意 `session/cancel` 在撤回期间不应被拒（宿主 rewind 前的取消要走这条路）。
5. **harness lane**：本 lane 建议补的用例（files-only + 首条消息、计划失败文案、files-only 不丢 `nextTurn`、prompt/revert 交错）都可直接加进 `harness/rewind-transaction-check.mjs` 的 fixture（它已能驱动真实 `PaseoHarnessServer` + 真实 `FileSnapshots`）；`factory-ownership-order-check.mjs:301-311` 适合加 `cancel/inbox.remove/whenIdle` 存在性断言（BSR-06）。
6. **docs lane**：`docs/REWIND.md` files-only 节（146-163）缺两条现状：首条消息被拒（BSR-01 的产品决定待定）、排队输入会被丢弃（BSR-03）；§行为约定（311-338）可补「prompt 与撤回的串行化由宿主 run 锁保证，桥自身无守卫」（BSR-04）。

---

### 附：本报告使用的实测命令与结果

```bash
node harness/revert-check.mjs            # 120 passed, 0 failed; exit 0
node harness/rewind-transaction-check.mjs # 17/17 passed; exit 0
node harness/file-mutation-gate-check.mjs # 6/6 passed; exit 0
node harness/bridge-assets-check.mjs      # 2/2 passed; exit 0
node /tmp/bsr-probe-20261103.mjs                   # 自建探针（5 组场景）: ALL CHECKS PASSED; exit 0
```

`/tmp/bsr-probe-20261103.mjs` 复用 `harness/rewind-transaction-check.mjs` 的模块解析钩子，构造真实 `PaseoHarnessServer` + 真实 `FileSnapshots` + 记录型 ctx（无 profile/daemon/模型），场景：1) files-only 首条消息拒绝 + 第二条成功对照；2) files-only 丢排队输入但 surface 不变；3) files-only/both 计划失败回执文案对比；4) freeze 窗口内投递 prompt 被折进替换范围；5) journal 首读失败发生在取消回合之后。
