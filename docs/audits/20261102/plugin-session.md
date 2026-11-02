# 审查报告：`paseo-plugin/server/session.ts`

- 审查基线：`2f71225`（main，工作区干净）；对照上一轮全量审查 `9298c28`（docs/FULL-AUDIT-20261031.md）
- 审查对象：`paseo-plugin/server/session.ts`（3357 行）逐行全量
- 上一轮针对本文件的已知项：S02（能力位不一致）、S03（配置先写后 await）、S04（effort 残留）、S05（跨回合统计）、S06（已完成子会话被 runtime_failed）、S07（label 提前打开）
- 本轮会话内 `git diff 9298c28..HEAD -- paseo-plugin/server/session.ts` 只有 `cedeaf3` 的 116 insertions / 4 deletions（全部是 usage 改动）；**下文除 S-13 外全部为基线已有**
- 证据等级：`实测` = 用编译后的真实 `DshSession`/`DshChildSession` 以假 `DshProcess` 驱动（不 spawn 进程、不连 daemon、不写 profile）；`源码` = 逐行读代码并对照桥/宿主源码；`未验证` = 未实际触发

## 1. 方法

- 全量读审 3357 行；跨文件核对了桥的 `dsh-process.ts`、`dsh-bridge/lib/{server,index,approval}.js`、已安装 `@getpaseo/server`（0.14.0）的 `plugin-provider.js`、DSH 0.2.1-rc.5 的 `dsh-session`/`dsh-agent-loop` 类型与状态机。
- 写了两组纯内存取证脚本（真实编译产物 + 假进程），复现统计串台、started 无终态、配置时序、子会话终态、label 时序、usage 补发边界；脚本与构建目录均在仓库外/`paseo-plugin/.dbg-audit-plugin-session`（gitignored，已清理）。
- 跑现有回归：`harness/context-usage-check.cjs` 15/15 PASS、`harness/replay-turn-check.cjs` 全 PASS、`harness/subagent-check.cjs` 90/90 passed（私有构建目录内运行，跑完清理复制文件）。

## 2. 发现清单

| ID | 严重度 | file:line | 触发条件 | 证据等级 | 归属 |
|---|---|---|---|---|---|
| S-01 | P2 | `session.ts:1528-1535`、`:1798-1804`、`:2286-2293` | 连续两个 prompt 回合；或回合被取消时 | 实测 | 基线已有（= S05，未修复） |
| S-02 | P2 | `session.ts:1421-1429`、`:1528-1535`、`:1805-1841` | prompt RPC 在 running 已发出后失败（RPC 超时/传输故障） | 机制实测，触发条件未验证 | 基线已有 |
| S-03 | P2 | `session.ts:1629-1632`（mode）、`:1616-1621`（effort）、`:1584-1587`（model） | 后端 setPlan/setConfig 拒绝 | 实测 | 基线已有（= S03，未修复） |
| S-04 | P2 | `session.ts:1589-1601`、`:1603-1627`、`:669-678` | 切到不声明思考档位的模型且宿主不同时发 thinkingOption | 实测 | 基线已有（= S04，未修复） |
| S-05 | P2 | `session.ts:544-570`、`:2817-2826` | 共享子进程退出时子会话已正常结束 | 实测 + 宿主源码 | 基线已有（= S06，未修复） |
| S-06 | P3 | `session.ts:2002-2009`、`:2092-2120`、`:2049-2055` | 无标题子会话 A 被另一个有标题子会话 B 触发的 flush 提前打开 | 实测 | 基线已有（= S07，未修复） |
| S-07 | P2 | `session.ts:92-94`、`:622-628`、`:669-678` | profile 未挂载 plan-mode（如叠加 web-app 时 plan 行被 disable）而宿主 config.mode=plan | 源码（未在真实 profile 实测） | 基线已有（= S02 的会话侧一半） |
| S-08 | P3 | `session.ts:2217-2240`、`:1074-1077`、`:3252-3257` | 无 reason 的 `turn/end`（旧日志/裁剪日志；DSH 0.2.1 的 live 事件恒有 kind） | 实测（父/子分支）+ 源码（live/replay） | 基线已有 |
| S-09 | P3 | `session.ts:2620-2622`、`:2630-2633` | 工具审批卡（按钮文案）与审批超时通知 | 源码 | 基线已有 |
| S-10 | P3 | `session.ts:1738-1761`、`:1708-1717` | 关闭/中断时仍挂着权限卡，或 `session/cancel` 抛错 | 源码推断；DSH 侧结算未验证 | 基线已有 |
| S-11 | P3 | `session.ts:456`、`:1980-1986`、`:2082-2090` | 同一连接先出现非 subsession 协商、后子会话缓冲溢出 | 源码 | 基线已有 |
| S-12 | P3 | `session.ts:459-465`、`:420`、`:2359-2360` | 极长会话（每回合/每步各一个元素） | 源码（量级小） | 基线已有 |
| S-13 | P3 | `session.ts:866-900`；`provider.ts:1591` | usage RPC 慢于宿主注册链；或 open 后立即 close | 机制实测（close 后路径）+ 未验证（慢 RPC） | **本次引入（cedeaf3）**，性质为已声明的概率缓解边界 |
| S-14 | P3 | `session.ts:2510`、`:2662-2675`；`dsh-bridge/lib/index.js:174-180`；宿主 `plugin-provider.js:1250-1281` | 若桥将来转发子会话的 question | 源码（当前不可达）+ FIELD-NOTES 已记录 | 已知限制，非缺陷 |

### S-01（P2）跨回合统计串台 + 取消回合改写上一回合统计行

`prompt()` 在发 RPC 前用 `#openTurnId()` 预置 `#turnId`（`:1528-1535`），而 `#onStatus("running")` 只在 `#turnId === null` 时重置 `#toolStarts`/`#turnTool`/`#lastStats`（`:1798-1804`）。预置使该分支在**每个正常回合**都被跳过：

- 实测 1：两个回合各一个工具，第 2 回合 `stream-stats:1:0` 的 `toolCalls` 为 2（应为 1）——`#turnTool.count` 跨回合累加。
- 实测 2：第 1 回合 0 个工具（stats 行 `toolCalls=0`），第 2 回合 1 个工具后被取消；`turn/end` 分支（`:2286-2293`）把**仍指向第 1 回合的 `#lastStats`** 改写为 `toolCalls=1`，同一 plugin item id 被宿主 upsert，第 1 回合已显示的统计行从 0 变成 1。
- 连带：`#toolStarts` 里未收到 `tool/result` 的 callId 同样跨回合残留。

修复方向：把「预置 id」与「新回合初始化」分开——在预置时（或首次 running 事件按「本回合是否已初始化」标志）重置工具/统计状态，保留 steer 不新开回合的语义；`#lastStats` 只允许本回合写。

### S-02（P2）prompt 失败清空回合 id，正在跑的回合失去终态

`prompt()` 的 catch 在 `issuedTurn` 为真时执行 `this.#turnId = null`（`:1426`）。真实 DSH 的 `agent.followup()` 会同步进入 running（桥先发 `session.status running`，插件注释 `:1515-1518` 也据此设计），因此若 RPC 在 running 已发出之后失败（`transport.request` 120s 超时、传输层故障），会出现：`session.turn started` 已发（`:1805-1811`），`#turnId` 被清空，随后 `onStatus("idle")` → `#completeTurn()` 因 `#turnId === null` 不发终态（`:1823-1841`）。

实测机制成立（构造 prompt 在 running 后抛错：started=1、terminal=0）。宿主侧后果：`@getpaseo/server` 的 `ProviderRuntimeSession.publish()` 把 started 的 turnId 记入 `activeTurnIds`，只有终态才删除；`connectionClosed()` 又以 `activeTurnIds.size > 0` 判定「有被中断的回合」并补发 `runtime_failed`（宿主 `plugin-provider.js:619-667`）——残留 id 会让一个实际已结束的回合被误判为中断。

修复方向：只在「started 尚未发出」时清空预置 id（记录 `#turnStarted` 或比较 id），否则保留并由后续 idle 关闭。

### S-03（P2）配置先写本地状态、后等后端

三处同一形态：

- mode（`:1629-1632`）：实测 `setPlan` 抛错后 `configState().mode === "plan"`，后端仍是 build；
- thinkingOption（`:1616-1621`）：`#thinkingOption = effort` 在 `await setConfig` 之前；
- model（`:1584-1587`）：先 `#emitUsage({}, true)` 清掉上下文占用，再 `await setConfig`；实测 `setConfig` 拒绝时最后一次 `session.usage` 已是 `{}`，且异常直接冒出 `configure`、不会走到结尾的 `refreshUsage()`（`:1667`）。

失败前提下的「后端拒绝 + 本地已改」正是上一轮 S03 的形态，未修复。修复方向：await 成功后提交本地状态；失败时回读后端真实值（`setConfig` 的返回即是权威回执）。

### S-04（P2）切模型后 `thinkingOption` 残留

model 分支用 `parseRoute()` 得到 `{provider, model}`，不含 `reasoningEffort`，于是向 `setConfig` 提交 `reasoningEffort: null`；后端 effort 被清空，但 `#thinkingOption` 没有被同步，`configState().thinkingOption` 仍报旧值（`:669-673`）。实测：`p1/m1 high` → `p2/m2`（无档位）后 `configState().thinkingOption === "high"`，而 `applied.reasoningEffort === null`。只有宿主在同一个 `configure` 里再发 `thinkingOption` 才会被纠正（`:1603-1627`）。

### S-05（P2）已完成的子会话仍被 `runtime_failed` 覆盖为 failed

`onExit` 无条件下发子会话 `fail()`（`:544-570`），`DshChildSession.fail()` 只检查根会话是否关闭、不检查子会话是否已终结（`:2817-2826`）。实测：子会话 `turn/end(completed)` → 宿主收到 `started`+`completed`；随后进程退出又收到 `session.runtime_failed`。宿主 `acceptChildEvent` 对该事件无条件 upsert `status: "failed"`（已安装 0.14.0 `plugin-provider.js:1270-1280`）——已正常结束的子代理行被改成失败。上一轮 S06 未修复。

修复方向：只终结尚未结束的子会话（例如 `#turnEnded` 为真或 `#turnId === null` 且在最后一次终态之后），保持「子先于根」的既有顺序不变。

### S-06（P3）无标题子会话被提前打开且无法更正

`#onChildOpened` 对 label 缺失的 notice 会 hold（`:2002-2009`），但 `#flushPendingChildren` 只检查 rootReady/父边、不检查 label（`:2112`），于是任何一次 flush（例如另一个带 label 的子会话到达）都会把 A 以无标题打开；`#completeHeldChild` 只对仍在 `#pendingOpened` 的 notice 生效（`:2050-2055`），之后到达的 descriptor label 无法补发（宿主只在首次 `attachChild` 时取 title）。实测：A 的 `session.opened` 无 `title`，label 事件到达后不再有第二次 opened。上一轮 S07 未修复。

### S-07（P2）plan 能力位在会话侧不落地

`configState()` 的 `modes: modes()`（`:675`）无条件返回 plan+build；`open()` 对 `setPlan` 失败只记日志并继续（`:622-628`）。当 profile 组合禁用了 plan-mode（AGENTS.md 明确记录了 `+web-app` 时 plan 行被 `disabled: true`），catalog 侧会隐藏 Plan，但 `session.config` 仍报告 availableModes 含 plan、mode 也照旧回显——这就是上一轮 S02「一份 capability source 贯穿 catalog/open/configure」未完成的一半（会话侧）。证据为源码 + 文档，未在真实 profile 上本轮实测。

### S-08（P3）live 与 replay、父与子对同一 `turn/end` 的终态口径不一致

- live root（`:2217-2240`）：`aborted`/`abandoned` → canceled；`undefined`/`completed` → completed；其余 → failed。
- replay root（`:1074-1077`）：复用 `childTurnState()`（`:3252-3257`）——只有 `completed` → completed，`aborted` → canceled，**其余（含 undefined）→ failed**。
- live child（`childTurnState`）：同 replay root。

实测同一份无 reason 的 `turn/end`：root live → `completed`，child live → `failed`。DSH 0.2.1 的 `TurnEndReasonMap` 只有 `completed/aborted/blocked/error/max-tokens/interrupted/forked`（无 `abandoned`），live 事件总有 kind，所以触发面是旧日志/裁剪日志/其他 provider；后果是同一会话重开前后终态显示可能翻转。建议抽一个共享的 reason→state 映射并让 live/replay 都走它。

### S-09（P3）审批卡与超时通知硬编码英文

`#onPermission` 的按钮文案 `"Reject"`/`"Allow once"`（`:2630-2633`）与超时 notice 的标题/正文（`:2620-2622`）直接写英文；同文件其余用户可见文案走 `UI.*`/`locale.ts`（如 `UI.planCard`、`UI.questionsTitle`）。非英文环境下这几处会混语言。

### S-10（P3）关闭/中断失败路径不结算挂起的权限卡

`close()` 不清理 `#pendingPermissions`（`:1738-1761`），`interrupt()` 的 `#clearPendingPermissions` 在 `await cancel()` 之后、且无 try/finally（`:1708-1717`）——`session/cancel` 抛错时卡片 promise 不结算。`#openCard` 的 promise 无人 resolve 时 DSH 侧是否会被桥的 `session/close` 兜底拒绝，本轮未验证（标未验证）。

### S-11（P3）一个警告标志服务两个不相关分支

`#childBufferWarned` 同时用于「Paseo 未协商 session.subsession」与「子会话缓冲溢出」（`:456`、`:1981-1985`、`:2083-2087`）。前者置位后，后者永不打印——缓冲溢出从「报一次」退化为「永不报」。建议拆成两个标志。

### S-12（P3）无界集合

`#seenTurns`/`#seenSteps` 随会话回合/步数无界增长（`:459-465`、`:2359-2360`），`#childParents` 随曾出现过的子会话无界（`:420`，注释承认）。量级小（每回合一个 number、每步一个字符串），属长期会话的内存卫生问题，非热点。

### S-13（P3）cedeaf3 的两处边界（本次唯一改动区，未发现回归）

- 补发链路是 `void session.refreshUsage().then(() => session.publishUsageAfterOpen())`（`provider.ts:1591`）：四个延迟从 usage RPC **完成**后才开始计。usage RPC 若慢于宿主注册链尾（注释自述冷启动 127ms，但 RPC 超时上限是 120s），补发窗口整体后移，仍可能全部落空——这是注释已声明的「概率缓解」，不是回退。
- close 之后 `.then` 仍会调用 `publishUsageAfterOpen()`：回调因 `#closed` 不发事件，但会新建 3 个 unref 计时器（3s 内自清）。实测确认不发事件；资源影响可忽略。
- 该改动的正向行为（不可用不发事件、不清空已知值、定时器在 close/onExit 清理）由 `harness/context-usage-check.cjs` 15 项覆盖且全绿。

### S-14（P3）子会话提问卡：当前不可达，且宿主侧仍缺消费

`#onQuestion` 的 target 解析为 `#parentScopedId(sessionId) ?? this.id`（`:2510`），若 `sessionId` 是子会话 native id，会 emit 到子会话 provider id。但桥只把**根会话**的 `user-questions/request` 转发给 Paseo（`dsh-bridge/lib/index.js:174-180` 的 `server.owns()` 过滤，子会话不在 `sessions` 表），所以该分支当前不可达（实测是人为构造的）。FIELD-NOTES「已知限制」已记录：宿主的 `acceptChildEvent` 不消费子 `session.permission`，需 Paseo 核心补丁；`#onQuestion` 的实现与 `dsh-process.ts:2444`「Root only」的同侧契约一致，不构成缺陷。

## 3. 健康度评分（1-5）

| 维度 | 评分 | 依据 |
|---|---|---|
| 正确性 | 2 | 5 个 P2 中 4 个是上轮已报未修；跨回合统计与子会话终态是用户直接可见且可复现的错 |
| 健壮性 | 3 | 失败路径多数响亮（replay 失败 notice、usage 不可用只记日志不清值、审批/命令失败回 `request.failed`）；扣分在配置先写后 await、started 无终态的窄窗、关闭/中断不清 pending |
| 可维护性 | 3 | 注释详尽且有因果记录；但存在「注释比实现强」处（S-14 的子分支、S-11 的共用标志）、单文件 3357 行承担翻译/状态机/统计/子会话四类职责 |
| 契约一致性 | 2 | S02/S03/S04 的配置回读未修；live/replay 与父/子终态映射不统一（S-08）；硬编码英文文案（S-09） |
| 性能 | 4 | 无 O(n²) 明显热点；75ms 用量合并、子会话缓冲有界、插件行按 id upsert；扣分在 `#pendingOpened` 的线性扫描（仅缓冲大时）与无界 Set（量级小） |
| 安全 | 4 | 无路径/命令/凭据处理面；审批默认 deny；question 的 `updatedInput.answers[header]` 读取有 `isRecord` + 字符串校验，`__proto__` 一类键取不到字符串 |
| 测试覆盖 | 3 | cedeaf3 有 15 项回归、重放 8 项、子会话 90 项，但 S02–S07 这些已确认缺陷没有任何回归——现有测试覆盖「实现声称的行为」，不覆盖上一轮审查定性的边界 |

## 4. 总评

**核心状态机可用、失败路径多数响亮，但「回合/统计状态的跨回合重置」与「子会话终态」两处已知 P2 仍未修，且父/子、live/replay 的终态口径与配置回读存在系统性不一致；这些是正确性问题而非可用性阻断。**

## 5. Top 问题（≤5）

1. **S-01**（P2）跨回合工具统计累加 + 取消回合改写上一回合统计行——每个多回合会话必现，修复面小。
2. **S-05**（P2）已正常完成的子代理在进程退出时被改为 failed——用户看到的终态是错的。
3. **S-03 + S-04**（P2）配置先写后 await、切模型后 effort 残留——后端拒绝/切换后 composer 显示与运行时不一致。
4. **S-02**（P2）prompt 失败清空运行中回合的 id → started 无终态，宿主 `activeTurnIds` 残留。
5. **S-07**（P2）plan 能力位未贯穿 catalog→open→configState（S02 剩余一半）。

## 6. 建议优先级

1. S-01、S-05：先修，各自配一条会红的回归（现有 harness 没有覆盖它们）。
2. S-03、S-04：合并处理（成功回执后提交 + 用回执回读 route/effort），配 `configure` 失败用例。
3. S-02：窄窗但后果持续，修法是一个标志位级别。
4. S-07：与 provider.ts 的 catalog 能力位一起改（跨 lane）。
5. S-06、S-08–S-14 作为批量 P3：S-06 修 flush 的 label 条件；S-08 抽共享映射；S-09 走 locale；其余按需。

## 7. 是否有阻断性健康问题

**没有 P0/P1。** 本文件不存在会让会话不可用、数据损坏或安全暴露的阻断项；当前 P2 均为此前已知、本轮复核仍未修复的正确性问题（显示/终态/配置一致性），不阻断主流程。

## 8. 未验证项

- S-02 的真实触发（需要桥的 `session/prompt` RPC 在 DSH 已进入 running 后超时/失败；本轮只实测了机制）。
- S-07 在真实 profile 上的表现（未启动真实 `dsh --profile` 验证 plan 被 disable 时的 catalog/config 组合）。
- S-10 的 DSH 侧兜底（`session/close` 是否会拒绝该会话挂起的 question；属于桥 lane）。
- 审批超时（`approvalTimedOut`）与宿主 `permission_resolved` 的端到端时序（需要真实 daemon/客户端，本轮未做）。
- 未运行任何真实模型回合、未重启/重载 daemon、未写 `~/.dsh` profile。

## 9. 有意偏差与已知限制（复核后仍成立，不计缺陷）

- 子会话的运行中状态/用量/审批需 Paseo 核心补丁（FIELD-NOTES「已知限制」；`acceptChildEvent` 只消费 timeline/终态/runtime_failed）。
- 非流式 route 不出 stats 行（`#streamStats` 依赖桥的瞬时 delta 帧），是「不编造时长」的有意取舍。
- `#emitStreamStats` 对 tokensPerSecond 设 3000 上限剔除突发伪值；`turn/end` 后不再重掷骰子。
- `open()` 吞掉 `setPlan` 失败并记日志（会话在 build 下仍可用），但该取舍与 catalog 的能力位不一致是 S-07 的一部分。
