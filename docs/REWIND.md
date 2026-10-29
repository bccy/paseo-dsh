# 撤回（Rewind）

Paseo 在每条用户消息下方提供一个撤回按钮；点开是「此操作无法撤销」+ 回退范围。
OpenCode / Codex provider 有这个按钮，DSH provider 原本没有——本文记录它现在是怎么接的、
为什么这么接、以及哪些前提不能破。

**实现路线：自研（不安装任何 DSH 撤回插件）。** 对话回退是一条约 30 行的表面替换事件；
文件回退是编辑工具级的写前备份；时间线刷新靠**宿主侧本地补丁**截断 history（native rewind），
没打补丁时撤回照样生效、界面不刷新，由一条 canary 通知告诉用户怎么刷新。
历史上曾复用 `dsh-rewind-plugin`（方案 A），已废止，仓库不再依赖它。

## 契约（来自 Paseo，不是我们编的）

| 事实 | 位置 |
|---|---|
| 撤回是 provider 能力位 | `@getpaseo/plugin/dist/server/provider.d.ts` 的 `PROVIDER_CAPABILITIES`：`session.revert.both` / `.conversation` / `.files` |
| 请求形状 | 同文件：`{ type:"session.revert", requestId, sessionId, token, scope }` |
| 令牌来源 | 时间线项的 `revertToken`（`ProviderTimelineIdentity`）；Paseo 按行缓存，点击时原样回传 |
| 按钮显示条件 | `plugin-provider.js`：`supportsRewindBoth/Conversation/Files` 由能力位算出 |
| 宿主刷新语义 | `public-docs/plugins/providers`：Paseo 用「关闭当前 provider 会话并带 persistence 重开」刷新 agent，没有单独的 reload 操作 |

所以"加一个按钮"需要三处同时成立：**声明能力位**、**行上带令牌**、**处理请求**。

## 实现（自研）

```
Paseo 撤回按钮
  → provider.ts      声明 session.revert.both / .conversation；分发 session.revert
  → DshSession.revert(token, scope) → DshProcess.revert
  → 桥 paseo/revert { sessionId, token, scope }
  → dsh-bridge/lib/revert.js：令牌 → 锚点 user/message 的 seq → 表面节点区间
  → 可选：file-snapshots.js 恢复该消息之后被编辑工具改过的文件
  → session.append('user/message', marker, { surfaceOp:{op:'replace',startSeq,endSeq}, sourceEventSeqs })
  → await sessions.flush(session)（保证回执前落盘）
  → 回执成功；daemon 在回执前已把 `this.history` 截断到被撤行（LOCAL PATCH），无需 reload
```

### 对话回退：一条表面替换

撤回 = 向 DSH 会话**追加**一条替换事件，把「目标消息（含）→ 当前可见面尾部」整段遮蔽。
日志只追加、不删除；模型上下文由 `surface.nodes` 推导，所以下一次请求自然看不到被撤内容。

标记事件是 `user/message`，`source.kind = "paseo-rewind"`：

- **为什么不是 `system/message`**：DSH 会话日志 v4 格式要求 `system`/`developer`/`assistant`
  消息必须处于**打开的 turn+step** 内；撤回发生在 agent 空闲时，追加系统消息会让整份日志被
  判定 corrupt（`history` 读回空、重开会话丢失全部历史）。`user/message` 没有这个约束。
- **为什么 source 不是 `user`**：非 user 源让它同时满足四件事——不会被当作撤回锚点、
  Paseo 重放会跳过它（不显示成用户气泡）、记忆插件不采集、`storage` 侧不需要 turn 归属。
- **代价**：`deriveEventMessage` 会把它投影成一条 `(empty message)` 用户消息，模型上下文里
  多一轮无内容用户消息（与 `dsh-rewind-plugin` 的做法一致，实测无副作用）。
- `surfaceOp` 必须恰好 `op`/`startSeq`/`endSeq` 三键，两端必须是**当前 surface.nodes 里的
  seq**（不能用日志 seq）；`sourceEventSeqs` 必须覆盖全部被遮蔽节点，否则 `append` 抛错。
- 追加前必须使 agent **空闲**（`settleAgentForRevert`，`dsh-bridge/lib/server.js:1205-1216`）：
  `cancel` 当前回合 → **同步**丢弃两条收件箱队列 `nextStep` + `nextTurn` → `await
  whenIdle(15s)` → 会话级 inflight 互斥。清队列必须在第一个 `await` 之前：取消是异步收敛的，
  晚一步驱动就可能领走排队回合。**排队回合不在撤回范围内，但必须一起丢**——只清 steering
  （`nextStep`）时，排队的 follow-up 回合（`nextTurn`）会在被取消回合落 idle 的瞬间把驱动
  叫醒，`whenIdle()` 于是还要等一整个额外回合：撤回可能卡到 15s 上限，在**已经取消用户回合
  之后**才失败；而这些消息尚未进入 surface，按构造就在目标之后，丢弃与撤回范围一致。否则
  撤回后仍在产生的事件会追加到替换节点之后，被撤内容"复活"。
- 撤回成功后必须 `sessions.flush(session)`：宿主在回执后立刻读日志重建时间线，缓冲未落盘的
  标记会让重放仍带着被撤行。flush 失败（或 profile 没有 session store）时整个撤回直接失败：
  **不做文件回退、也不取消子代理**——否则会出现「对话仍带被撤行、文件已回滚」的不可见错位。

### 重放折叠：只折撤回缝

桥的 `history()` 是 Paseo 重开会话时重建时间线的数据源，必须折叠撤回缝。规则：

- 只折叠 `source.kind === "paseo-rewind"` 的替换事件，遮蔽 `[startSeq, seamSeq-1]`
  （含被撤回合的 `step/end`、`turn/end`、`command/*` 等尾随日志事件）。
- **compaction 的 replace 不折叠**：DSH 的 surface 是模型可见面，不是人类转写；把 compaction
  也折掉会让重开的会话丢掉压缩前的全部对话（实测 205 条用户消息剩 60 条）。

### 文件回退：编辑工具级写前备份

只撤「智能体用编辑工具改过的文件」，不碰用户自己的改动，也不要求 git/干净工作区：

- 桥通过 DSH 原生钩子 `ctx.inject(['fs'])` 监听 `tools/execute` / `tools/post-execute` /
  `tools/result`：`write`/`edit` 执行前读旧内容，成功后按锚点记一行 journal；失败/中断丢弃。
- **子代理编辑归并到根会话**：工具跑在原生子会话里时，沿 `header.parentSession` 上溯到
  根会话（`dsh-bridge/lib/snapshot-owners.js`），快照写进**根会话**的 journal/objects。
  pending 键用「执行会话 id + callId」而不是 owner 键：父/子可能撞同一个 provider 铸的
  callId，pending 是进程内的瞬时状态，键错了会静默覆盖掉一方、让它不进 journal。
- **捕获顺序与提交顺序分开记**：父子并行编辑同一路径时，journal 行按 commit 顺序追加，
  可能和 capture 顺序相反；每行记进程内单调的 `captureSeq`，恢复时按 `captureSeq` 取
  「目标之后最早一次捕获前的状态」，不再被 commit 顺序误导（旧行没有该字段，按旧文件序）。
- **锚点 = 派发/续接该子代理回合的根人类消息**：子会话每次 `turn/start` 时记录
  「根会话当时最新人类消息 seq」（`dsh-bridge/lib/child-anchors.js`），文件快照优先用它；
  根会话自己的编辑仍取执行时的最新人类消息。进程没观察到某个子代理的派发回合（如桥冷启动
  前它已在跑）时，该子代理的编辑**不记 journal**（stderr 一行跳过）——这才是 fail-open 的
  含义：宁可不恢复，也不把它错记到别的回合。这样后台子代理跨轮写文件不会被归到下一轮。
- 相对路径按**工作目录服务**的当前目录解析（`ctx.get('workingDirectory').get(session)`；
  `cd` 与子代理的 `cwd` 参数都生效，服务不可用时才回退 `header.cwd`），与 `write`/`edit`
  的解析方式一致——`header.cwd` 只是会话最初的项目目录，不是工具执行时的目录。
- 根目录 `~/.dsh/paseo-rewind/<sessionId>/`：`journal.jsonl` + `objects/`（内容寻址）+
  `rescue/`（恢复前当前内容的备份）。
- 撤回 `both` 时：读 journal，取每个路径「目标消息及之后最早一次**捕获**前的状态」——新建的
  文件删除，被改的写回，未被编辑工具动过的不碰；覆盖前把当前内容存入 rescue。
- **恢复失败不清理**：只要有一个路径恢复失败，就不做 prune/trim/GC——失败路径的撤回前备份
  和 journal 行是唯一重试材料，删掉会让下一次撤回静默漏恢复。失败路径与 rescue 目录写
  stderr / 回执，插件在新时间线里提示（提示文字明确 rescue 是当前内容、备份仍在 journal）。
- **journal 是本地状态，但恢复会按它写/删路径**：`readJournal` 只接受绝对路径与 64 位十六
  进制内容哈希（或显式 `null`）；`restore` 用 `lstat`，符号链接、目录、socket 一律跳过、
  绝不跟随。`backup` 不再能 `..` 穿越 objects 目录。
- **撤回范围内的子代理被中断**：`targetSeq` 及其之后被撤回，锚 `>= targetSeq` 的子代理
  （派发回合被撤）通过 DSH `subagents.interrupt(childId, {kind:'ancestor', agent})` 中止；
  锚更早的继续运行。`interrupt` 是 fire-and-return：调用后最多等 3s（`waitForChildren`，
  超时记 stderr）再动文件，减少「恢复后子代理又写几笔」的窗口；锚未知时不取消（保守）。
- **重开时活着的子代理保持 running**：撤回后的刷新会关 provider 会话再带 persistence 重开；
  会话 join 的仍是**同一个共享 dsh 进程**（进程按引用计数回收，关一个会话不会退掉它），插件
  重放子代理时把「历史停在 turn 中途」视为仍在运行，不再误标 canceled（冷启动仍按被杀处理）。
  **只对 `turnOpen` 生效**：进程里「从未开始过 turn」的子会话没有活证据，仍按 canceled 收尾
  （进程连续不等于这个 child 还活着）。
- **重放窗口缓冲 + 历史不可读**：`replaySubagents()` 在 listing 之后、每个子代理历史读完
  之前，把该 child 的实时帧缓冲起来，重放完成后立刻派发（否则 history 往返期间到达的
  `turn/end` 会被当未知 child 丢掉，adopted 子代理永久 running）；若缓冲里已有
  `turn/end`，重放不再先发一个 canceled 终态。`history.available === false` 时跳过该
  child 并弹 `session.notice`（「子代理历史读取失败」），不再把不可读当空历史。
- **追踪哪些工具**：`write`/`edit` 用 `file_path`；`str_replace_editor` 用 `path`，且只认
  `create`/`str_replace`/`insert` 三个写命令——`view` 是读，未知命令同样不算写（把一次读记成
  "宣告该文件最新状态的编辑"，撤回会去重写一个根本没被改过的文件）。名字级过滤是
  `isTrackedTool`，参数级判断在 `mutationPathOf`（`dsh-bridge/lib/file-snapshots.js:69-78,
  116-142`）；该工具由一等公民包 `@deepseek-ai/dsh-tool-str-replace-editor` 提供，base/web
  bundle 默认不挂载，部署挂上就生效。
- 不跟踪：bash/pwsh 等命令产生的改动、用户或外部进程直接改的文件、符号链接目标、> 8 MiB
  文件。子代理编辑属于归并而不是跳过；只有上溯失败（父会话不 live、header 缺
  `parentSession`、血缘成环）时才退化为不跟踪，stderr 记一行跳过日志。

### 刷新：宿主 history 截断（本地补丁）+ canary 自证

Paseo 的插件 provider 适配层把翻译后的时间线事件放进一个**只追加**的内存数组
（`PluginAgentSession.history`），撤回只把请求转给插件、不动该数组；宿主撤回后
`rewind()` 会 `hydrateTimelineFromProvider({force:true})` 强制从它重建时间线，于是旧行复活。
这是上游已知缺陷（getpaseo/paseo issue #4667，open，p2；修复 PR #4668 关闭未合并；
0.11.2/0.11.4/0.12 beta 均未修）。插件协议也没有"删除/替换时间线"事件。

**打过本地补丁时**，`revert()` 里会把 `this.history` 截断到被撤行：

```
撤回成功 → daemon 在 revert() 内先 truncateHistoryFrom(messageId)，再回 request.completed
→ 宿主 await 的正是这条回执，随后的 force-hydrate 读到的是已经变短的 history
→ 客户端重建时间线（旧行消失），无 reload、无新 provider session id、不取消子代理
```

**没打补丁时**撤回仍然生效（对话、文件、模型上下文都回退了），只是界面不刷新——旧行留在
屏幕上，直到执行 Reload agent 或重开会话。插件在**自己进程里**看不出对面是哪种宿主（没有
"会截断 history"这个能力位），所以它用一条通知**自证**：

```
撤回成功 → 插件发 info「撤回已生效」（HH:MM:SS · #seq + 一句"若此提示一直停留…执行
           Reload agent 或重开会话"）
         → 插件再发 request.completed
```

- **打过补丁的宿主**：这条通知在回执之前就已进入那个只追加的数组，所以随被撤行一起被截掉——
  用户最多看到它一闪而过（小会话 14–30 ms 不可见，大会话约 8k 事件时最多约 2 s，恰好充当
  进度提示）。它不进 DSH 日志，重开会话后不存在。
- **原版宿主**：通知留在时间线底部，明确告诉用户界面是旧的、该怎么刷新。

**顺序就是机制本身。** 放到 `request.completed` 之后，补丁宿主上也会留下来，变成
「时间线没刷新」的**误报**（在宿主真实代码上双向复现过，见
`harness/host-contract-sim.mjs`）。所以 `provider.ts` 的 `session.revert` 分支里，通知必须
在回执之前发出；`scope: "files"` 的撤回不动对话，没有可刷新之物，不发通知。

- **补丁路径**：`~/.paseo/local-patches/apply-rewind-history-truncation.mjs`，目标是 daemon 实际加载的
  `@getpaseo/server/dist/server/server/agent/plugin-provider.js`（不是仓库 checkout——那里没有构建产物，
  打上去看着成功却什么也没改）。
- **md5 只记录、不判定**：基线 `BASE_MD5`（npm `@getpaseo/server@0.13.0`，与 registry tarball
  逐字节核对过）现在只作为「当前文件离基线多远」的参考信息打印。判定靠**结构锚点**：两个
  插入点（`publish(event)` 的方法体、`revert()` 尾部那个 `await this.bridge.revert({…})` 调用）
  各须**恰好命中 1 次**，且插入的方法体与 `revert()` 里的调用逐行与脚本内的 `METHOD`/`CALL`
  一致（存量安装的体可能是旧版，只数 marker 会永远报 `already-patched`）。
  锚点失配（0 次或多于 1 次）或宿主形状变了才 `exit 1`——见下一条。用 md5 当门禁曾经意味着
  「上游动到文件里任意一个字节 → 拒绝打补丁 → 带 `ExecStartPre` 时 daemon 起不来」，所以
  判定改成锚点自适配（脚本头部注释里写着这段来历）。
- **fail closed 的几处前置断言**（都在写文件之前）：宿主字段形状不对（注入体要读
  `this.history` / `this.timelineSnapshots` / `this.revertTokens`，上游改名或重构就
  `host-fields-changed`）、上游 #7675 形状（`new PluginSessionHistory(` / `this.history.read(`
  一旦出现，注入体就成了运行时 no-op → `upstream-history-shape-changed`，exit 1 且不写文件）、
  半打补丁（marker 既不是 0 也不是 2）。上游自己修好 #4667 时检测为
  `upstream-fixed-retire-patch`（apply 不打并报出原因；`check-rewind-patch.mjs` 对此 exit 4，该删补丁）。
- **截断键是 `messageId`**：`mapTimelineItem()` 把它同时写进翻译后的 `user_message` 行和
  `revertTokens`，而 `history` 存的是投影前的行，所以 id 逐字可用。找不到锚点或有歧义即 exit 1
  （fail closed，不做"看起来成功"的截断）。
- **幂等 + `ExecStartPre`**：补丁在每次 daemon 启动前重打，所以 daemon 升级或重装 `@getpaseo/cli`
  都不会把补丁悄悄带走。上游修了 #4667 之后可删掉补丁与 `ExecStartPre` 行。
- **不再有 reload 旁路，也不再有停放会话池**：一次撤回是同步的，没有"关会话再带 persistence
  重开"这一步，因此不需要 `paseo agent reload`、不需要 50ms 延迟、不需要按 DSH 原生 session id
  接管旧进程。共享子进程仍只有一个（`provider.ts` 的进程池，`DshConnection.#pooled`），但它
  服务的是**所有会话**，与撤回无关。

### 权限预设：非命令写入

`/permission` 命令会留下 `command/run`/`command/done`，时间线上多一条用户没输入过的行。
改为调用 DSH 的投影 API：

```js
this.ctx.get('permissionPresets').set(session, name);
```

只 append `permission/preset` + `sandbox/mode` + `approval/policy`，无命令事件。已知偏差：
命令路径会额外注入一条「审批策略已变更」提示，本路径没有；会话头的预设控件仍显示当前值。

## 行为约定与边界

- 能力位只声明 `session.revert.both` 与 `session.revert.conversation`；**不声明 `files`**
  （没有"只回文件"语义；该模式 daemon 也不重建时间线）。
- 撤回**不可撤销**：不实现 `/unrewind`（Paseo 菜单本身就这么写）。
- 撤回是**同步**的：`session.revert` 在桥里完成（截断 history + 落盘）后回执，宿主随即重建
  时间线。没有 reload 窗口，因此**没有**「正在回退，请稍候」通知、没有 prompt 门禁、没有
  15s 安全超时——这些机制随 reload 旁路一起删除了。
  **唯一的提示是那条「撤回已生效」canary**，它不是"未刷新告警"而是自证机制：在补丁宿主上它
  随被撤行一起被截掉（一闪而过），在原版宿主上它留下来并告诉用户执行 Reload agent 或重开会话
  （见上一节）。它必须在 `request.completed` 之前发出，顺序不能换。
  并发的第二次撤回由桥的 `revertInflight` 守卫拒绝（`request.failed`，不是静默）。
- **当前可见对话的第一条消息不支持撤回**：撤掉它等于清空整个对话，而 Paseo 客户端对"重建后
  空对话"的 live 刷新不可靠（旧行会留在屏幕上，再点旧行报 `No provider revert token`）。
  桥在动手前就拒绝并返回可读原因（「首条消息禁止撤回」），**不改日志、不打断运行中的回合、
  不触发刷新**；后续消息照常撤回。
  菜单仍会显示：Paseo 的撤回按钮按 provider 能力位渲染，不按行隐藏（token 缺失只在点击时报错），
  按行隐藏需要上游新增"该行可撤回"的契约。
- 子会话（DSH 原生 child）不支持撤回：只读投影，没有自己的进程。
- 文件回退失败时对话仍然已经撤回：回执带 `files.failed`；**撤回前备份保留**（journal 不
  清理，重试撤回会再次恢复）。提示行即时以 `session.notice` 出现在**当前**时间线里
  （没有 epoch 重建，不会被吞掉）。注意 rescue 目录里是**被替换前的当前内容**（已含智能体
  改动），不是撤回前状态，别拿它当预编辑恢复材料。
- 时间线折叠后仍会保留压缩前的完整对话（撤回只影响它自己那段）。
- 记忆插件可能仍召回被撤内容（模型"记得"）——已知缺口，不在本次范围。
- 由于首条被拒绝，本实现不会再产生"空对话"；历史上已被旧版本撤空的会话，重开时就是一个
  没有消息的空对话（不再额外插入提示行）。
- **子代理编辑已归并到根会话（2026-10-19 起）**：父会话 `both` 撤回会回退子代理在目标消息
  之后用 `write`/`edit` 改过的文件（含孙级；锚 = **派发/续接该子代理回合**的根人类消息）。
  这与 `dsh-rewind`/Claude Code checkpoint 的「子代理编辑不恢复」不同，是本项目的有意扩展；
  上溯失败（父会话不 live、header 缺 `parentSession`、血缘成环）时退化为旧行为（不跟踪）。
  真机验收见 FIELD-NOTES 第 59/60/61/62 条。
- **子代理取消的边界**：撤回覆盖派发回合时，桥用 `subagents.interrupt` 中止该子代理；调用后
  最多等 3s（`waitForChildren`，超时记 stderr）再执行文件恢复，但 `interrupt` 仍是
  fire-and-return，子代理可能在这之后才观察到信号并再写几笔；锚未知（桥冷启动前已在跑的
  子代理）时不取消（保守）；续接子代理在新 `turn/start` 刷新锚。若撤回时子代理仍有未记录的
  写入发生在恢复之后，该文件会按旧锚留待更早的撤回点，可能再也撤不掉。
- **rescue 副本不在界面提示**：撤回恢复/删除一个文件前会把**当时（已含智能体改动）的内容**
  复制到 `~/.dsh/paseo-rewind/<sessionId>/rescue/`，回执与插件日志都带路径，但 UI 只在
  `files.failed` 时提示。文件名带时间戳、按次独立；它不是撤回前状态——撤回前状态在 journal
  的 objects 里（恢复失败时保留）。若你在撤回前手动改过该文件，"改动被覆盖"需要自己到
  rescue 目录找回。
- **注册的 slash 命令行不可撤回**：命令行没有对应的 DSH `user/message`，因此没有可回退锚点；
  Paseo 的撤回菜单按 provider 能力位渲染，无法按行隐藏，点击会得到"没有撤回令牌"的错误。
  按行隐藏/禁用需要上游契约。
- **文件对象回收**：journal 先按语义裁剪（删掉「最早可撤回人类消息」之前的锚点，未来撤回
  永远选不到它们），再以 1000 个锚点为硬上限——超限会**记 stderr 警告**并丢弃最旧的可达
  锚点，之后撤回更早消息时这部分文件不再恢复（已知限制，不是静默）。撤回后按 journal 的
  引用集清理未引用的 `objects/`；带 pending 的捕获与 5 分钟内的新对象不回收（防止与仍在跑
  的子代理竞态）。rescue 副本按次独立（不会互相覆盖）。
- **重建后的首轮工作时长不含 provider/DSH 冷启动**：live 首轮从用户提交起算（含进程启动），
  但 DSH 日志里的 `user/message` 是进程启动完成后才写入的；重放只能用日志时间，所以首轮
  时长会少掉启动段（例如 live 5s → 重建后 2s）。后续回合不受影响，也没有可靠的持久化
  提交时刻可以还原（Paseo 未把提交时间传给 provider）——已知数据缺口。

## 验证

```bash
# 纯函数 + 接线（不需要 daemon）
node harness/revert-check.mjs        # 令牌/区间/前置/回执/文件层/canary 顺序/共享进程接线
node harness/surface-check.mjs       # 只折撤回缝、compaction 保留、尾随事件
node harness/file-snapshot-check.mjs # 写前备份/新建删除/多工具/救援/上限
node harness/rewind-merge-check.mjs  # 父子归并：子/孙编辑落根会话 journal、断链 fail-open、取消策略
node harness/revert-shape-probe.mjs  # 真实 DSH Session：旧写法必抛、新写法通过、marker 不进上下文
node harness/replay-fidelity-probe.mjs <session.v4.jsonl.zstd>  # 真实日志重放保真

# 宿主契约：直接 import 宿主真实的 plugin-provider.js（只读），双向断言 canary 在补丁版
# 被截掉、在原版存活；回执之后发的在两种宿主上都存活（证明"顺序即机制"）
node harness/host-contract-sim.mjs [host-agent-dir] [compiled-plugin-dir]

# 端到端（真 dsh --profile paseo，3 个真实模型回合；会消耗少量 token）
node harness/rewind-e2e.mjs
# 断言：成功回执、文件删除、history 折叠成 1 条用户消息、无 command/run、
#       模型仍知道 ALPHA、不再知道 BETA
node harness/rewind-merge-e2e.mjs    # 父写 + 子代理写 → both 撤回 → 两个文件都删除、子会话无 journal

# 插件层（先按 plugin-check.cjs 头部步骤编译到 .dbg）
# 复制进 .dbg 后运行：子会话生命周期（adopted 只认中途 turn、重放窗口缓冲、历史不可读）
cd paseo-plugin/.dbg && node subagent-check.cjs
```

真机验收（新会话，能力位只对新会话生效）：发两条消息 → 撤回第二条 → 消息行消失、无
`/rewind` 行/回合页脚、文件回到消息前、模型不知道被撤内容；重开会话后仍正确。
**补丁在位时**那条「撤回已生效」提示最多一闪而过；**补丁不在位时**它必须留在底部并说明怎么
刷新，执行 Reload agent 后被撤消息与提示一起消失——这两种宿主都要各验一次。
父会话派子代理改的文件同样随 `both` 撤回回退（归并到根会话，见 FIELD-NOTES 第 59/60/61/62 条）；
撤回覆盖派发回合时该子代理被中断，锚更早的子代理继续运行且重开后保持 running；
`interrupt` 的 fire-and-return 边界见上文「已知限制」。

## 回滚

- 代码：`git revert` 撤回相关提交（或切回 `main` 重载插件）。
- 运行时：`git checkout main` → 重新生成内嵌桥（`node paseo-plugin/scripts/generate-bridge-assets.mjs`）
  → `paseo plugin reload dsh-paseo`。
- 外部状态：`~/.dsh/paseo-rewind/`（journal/objects/rescue）可直接清理，丢失的只是文件回退能力；
  旧实现残留（`~/.dsh/rewind-ledger`、`~/.dsh/rewind-git`、`~/.dsh/rewind-snapshots`）已不再读取。
- profile 备份：`~/.dsh/backups/paseo-profile-before-rewind-*.tgz`、`profile-bridge-before-file-layer-*.tgz`。
