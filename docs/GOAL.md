# 目标（Goal）

DSH 有一套自己的目标机制：给会话一个 objective，agent 空闲时自动续跑，直到完成、受阻或
轮数耗尽。Paseo 0.14.0 **没有原生 goal**（survey §E1：协议里没有字段、事件或能力位），所以这里既不声明
goal 能力位，也不改 Paseo 协议：**DSH 是唯一数据源，插件把状态画到 composer pill 与时间线上**，
控制经插件 RPC 代发 `/goal` 命令。

本文记录它现在怎么接、为什么这么接、以及哪些前提不能破。证据等级沿用仓库惯例：
【实测】= 真实模型回合/命令输出；【源码】= 读实现；【推断】= 由源码推演但未跑。
摸底证据记在开发期的 `goal-survey.md`（下称 survey）A–F 节，**不随仓库分发**；后文的
`FINAL-verify.md` 是收尾真机验证记录，同样不随仓库分发。摸底版本是 DSH 0.2.1-rc.5、
Paseo 0.14.0。

**实现路线：全部复用 DSH 的 goal 栈，不重写状态机。** 状态与自动续跑来自
`dsh-goal`（唯一持久状态服务 + `goal` 会话投影）与 `dsh-goal-round-driver`（同会话续跑），
人类控制来自 `dsh-command-goal`，模型工具来自 `dsh-tool-goal`，UI 是我们自己的 pill 与时间线行
（DSH Web 的 GoalBar 不适用于 Paseo）。插件不声明 goal 能力位、不新增 provider 事件、不推送
——Paseo 的 provider 事件枚举里没有 goal（survey §E2），硬造就是自造协议形状。

## 数据源（只有 DSH 的 goal）

| 数据 | 来源 | 是否持久 |
|---|---|---|
| objective / phase（`active`/`paused`/`blocked`/`complete`）/ revision / `roundsStarted` / `maxGoalRounds` / `blockedReason` | DSH 会话日志的 `goal/change` 事件（全量快照，事件溯源；`@deepseek-ai/dsh-goal/lib/types/domain.d.ts:14-32`），派生出 `goal` 会话投影 | 持久 |
| activation（`armed`/`disarmed`，续行是否启用） | live agent 的 `ctx.goals.get(agent)` → `GoalView`（`@deepseek-ai/dsh-goal/lib/index.js:611-616`） | **进程本地，不持久化** |
| 续跑轮次边界 | `user/message` + `source.kind='goal'`，带 `{goalId, revision, round}`（`@deepseek-ai/dsh-goal/lib/types/domain.d.ts:34-40`） | 持久 |
| 控制结果 | `/goal` 命令执行回执（`success` / `error` + 文案；`@deepseek-ai/dsh-command-goal/lib/index.js:100-160`） | 不持久（即时回执） |
| 当前任务（`currentTask`） | DSH 的 `todos` 会话投影（`paseo/projections {keys:['todos']}`，取 `in_progress` 项的 `content`，best-effort） | 不持久（DSH 每轮重置） |

桥侧三条读/写路径：

- `paseo/goal {sessionId}` — 读 live agent 的完整 `GoalView`（**含 activation**），
  `dsh-bridge/lib/server.js:3177-3201`（dispatch `:3359`）。`requireSession` 拿 live agent，
  经 `ctx.get('goals')` 调 `goals.get(agent) ?? null`：有目标回原样 `GoalView`，无目标回
  `{goal:null}`；**`goals` 服务未挂载抛错**（`this DSH runtime composes no goal service`），
  与「无目标」严格分开；未知会话沿用 `requireSession` 的错误，且**不物化会话**（读目标不拿
  会话日志的写租约）。
- `paseo/projections {sessionId, keys:[…]}` — 冷读持久投影（`dsh-bridge/lib/server.js:3008-3022`）。
  两个 key 用在 goal 上：`goal` 是持久 phase（**不含 activation**，
  `@deepseek-ai/dsh-goal/lib/types/types.d.ts:84-89`，所以 pill 不用它），`todos` 用来取
  「正在」行的 `in_progress` 项（`paseo-plugin/server/dsh-process.ts:2284-2340`，三态：
  有任务 / 无任务 / 真实读失败只记一次 stderr，**不拖垮 goal 读取**）。
- `paseo/command/run {sessionId, name:"goal", arguments}` — 代发 `/goal ...`
  （`dsh-bridge/lib/server.js:2002-2015` → `commands.execute`）；`goal/change` 实时与重放都由
  桥原样转发（`dsh-bridge/lib/server.js:591-619`；重放白名单
  `dsh-bridge/lib/image-host-path.js:397-418` 的 `goal/change`）。

插件侧两个 RPC（`paseo-plugin/shared/goal.ts:223-267`，Zod 两侧同源，仿 `shared/jobs.ts`；
注册在 `paseo-plugin/index.server.ts:105-124`）：

- `goal.current {agentId}` → `{available, goal: GoalState | null, error?: {message, code?}}`。
  **错误形状与 jobs 的 `{available, jobs, error?: {message, code?}}` 同形**（嵌套 error 对象 +
  可选 code）；DESIGN §1.2 的字面写法是顶层 `error`/`code`，Lead 已裁决以实现为准（验证报告 B-3）。
  `GoalState = {objective, phase, activation, roundsStarted, maxGoalRounds, blockedReason?{code,message},
  currentTask?}`——只带绘制需要的字段，`id`/`revision`/时间戳不泄漏
  （`paseo-plugin/server/provider.ts:2116-2128`）。`currentTask` 是第二次 best-effort 读
  `todos` 投影的结果，只在 goal 非空时读（`paseo-plugin/server/provider.ts:2184-2195`）。
- `goal.control {agentId, action: "pause"|"resume"|"clear"|"edit", objective?}` →
  `{ok:true, message} | {ok:false, error}`；`edit` 必须带非空 objective（客户端与服务端各拦一次，
  `paseo-plugin/shared/goal.ts:178-188`），失败把 DSH 原文透传，**不把失败报成成功**。

失败分级（`paseo-plugin/shared/goal.ts:69-99`、`paseo-plugin/server/dsh-process.ts:2177-2245`）：

| code | 含义 | 重试 |
|---|---|---|
| `bridge_too_old` | profile 的桥没有 `paseo/goal`（旧内嵌桥） | 终态：重载插件重写内嵌桥 |
| `goal_unavailable` | profile 没挂 goal 服务 | 终态：隐藏 pill，不重试 |
| `session_missing` | 会话还没建 / 正在拆 | 瞬时：继续退避轮询 |
| `rpc_failed` | 读本身失败（超时、传输、撕裂的通道） | 瞬时 |

- 缺 code 一律按瞬时处理（老服务端只发 message 时的兼容）。
- **本进程没有该 agent 的会话时答 `available:true, goal:null`**——这是准确的「没有目标」，
  不是读失败（`paseo-plugin/server/provider.ts:2145-2170`，与 jobs 先例一致）；已关闭但仍被
  持有引用的会话则答 `available:false, session_missing`（`paseo-plugin/server/session.ts:1037-1046`）。

> **DSH 侧源码依据**：`/goal edit <objective>` 内联接收替换目标，`create` 在目标
> active/paused/blocked 时会被拒绝（"A goal is already …"），命令结果只有 `success` / `error`
> 两种（`@deepseek-ai/dsh-command-goal/lib/index.js:100-160`）。面板的编辑（点目标行）必须走 `edit`
> 而不是 `create`。

## 状态、pill 与按钮

目标 pill 注册在 composer（`client.addComposerPill`，独立 id **`dsh-goal`**，与 jobs pill 并列；
**jobs pill 的语义一行不改**：只在运行中可见、只用转环、文案「N 个后台」）。`title` 固定为中性名词
「目标」/「Goal」——它同时是手机 sheet 的标题与无障碍名，完整 objective 只在 popover 正文出现
一次。注册时先 `visible:false`，第一次轮询证明有目标才显示。

**可见性**：`available && goal !== null && phase !== "complete"`。无目标 / 已完成 / 已清除 →
隐藏（与 DSH Web GoalBar 同语义：无目标、已完成与成功清除的目标一律不渲染，
`@deepseek-ai/dsh-client-ui-goal/README.zh.md:38`；survey §D3）。终态错误（桥太旧、profile 没挂
goal 栈）→ **移除 pill**，与「这个 profile 没有 goal 功能」等价，不打扰用户；瞬时错误**保持
上次状态**，不要把界面闪成「无目标」（`goalPillPresentation`，`paseo-plugin/client/goal-polling.ts`）。

| 状态 | label（zh-CN / en） | 图标 | 行尾操作 |
|---|---|---|---|
| active + armed | `目标进行中` / `Goal running` | 运行环（agent 在跑时）/ `Target`（`foregroundMuted`） | 暂停、清除；点行编辑 |
| active + disarmed | `目标未在续跑` / `Goal not running` | `Target`（`statusWarning`） | 继续、清除；点行编辑 |
| paused | `目标已暂停` / `Goal paused` | `Target`（`statusWarning`） | 继续、清除；点行编辑 |
| blocked | `目标受阻` / `Goal blocked` | `Target`（`statusDanger`） | 继续、清除；点行编辑 |

**label 不带轮数分数**：`目标 3/10` 在 160px 的按钮里会被读成完成度（上限默认 256），轮数是
**预算不是完成度**，只进 popover 的 facts 行（`goalFactsLine`）。

**运行环（v5）**：pill 图标在「目标真的在跑」时**替换**为运行环（`StatusRingMark`，与 jobs pill
同一个环：12px、900ms、`ringColorFor` 取运行蓝），否则按 tone 着色的 `Target`
（`goalIconColorToken`：normal→`foregroundMuted`、warning→`statusWarning`、error→`statusDanger`）。
运行判定是纯函数 `goalRunningMark`：`active + armed` 且 agent `running` 才转；agent 转 `idle` 后
保持 **1.5s**（`GOAL_RUNNING_HOLD_MS`）；disarmed/paused/blocked/complete、agent 非 running、或
读不到 agent 状态都不转（不猜）。`useAgent(agentId, a => a.status)` 读宿主 session store，不轮询
（`client/goal-running.tsx`）。面板里鲸鱼右下角叠同一个环（`-5`、14px 框、行底色镂空）。

**popover 面板**（`paseo-plugin/client/goal-popover.tsx`，v5 行式）：

- **目标行**：16px DeepSeek 鲸鱼（内联 SVG，品牌蓝 `#4d6bfe`，经宿主 `Icon` 的 `{svg}` 形式
  渲染，`paseo-plugin/client/deepseek-mark*.tsx`）+ 目标**单行**（`numberOfLines={1}` 截断；完整
  文本在编辑字段里）+ facts 行「进行中 · 第 N 轮 · 预算 M」/「Round N · budget M」
  （`goalFactsLine`：`active + disarmed` 时是「未在续跑」/「Not continuing」，与 pill 的
  「目标未在续跑」一致）+ 行尾**两个图标按钮**（暂停/继续、清除；桌面 20×20 / 手机 32×32，
  glyph 14/18，`goalIconButton`）。
- **点整行进入编辑**（除两个图标按钮外；图标按钮 `stopPropagation`）：行是 `ComposerTrackRow`
  形态（桌面 hover/按下填 `surface2`），a11y 名「编辑目标」。它是面板里唯一的编辑入口。
- **编辑页（原位）**：多行字段（`MenuTextField` 同框：`surface2` 底、1px 边、圆角 6）替换目标行，
  预填全文、自动聚焦、光标在开头；下方分隔线 + 「保存」「取消」两行（宿主 `MenuItem` 几何：
  手机 40 / 桌面 28，`goalMenuItem`）。回车保存、Esc 取消、**失焦不提交**；空文本与「值未变」都
  禁用保存（后者是对设计的增补，借 `rename-modal.tsx:111`）。编辑时隐藏「正在」与受阻行。
- **正在行**：`CircleDot` + 「正在：<当前 todo>」（前缀 muted、内容 foreground，单行；
  `goalCurrentTaskLine`）。
- **blocked 行**：`CircleAlert` + DSH 的 blockedReason 原文（两行内）；**disarmed 提示**：
  「重开会话后自动续跑会停止」（设计 v1 §99 的一行提示）。
- **清除确认页（原位）**：点清除图标 → 提示「清除后目标不再续跑，无法撤销」→ 分隔线 →
  红色「清除目标」行（`Trash2` + `statusDanger`）→「取消」行。红色只在此态出现（destructive 是
  颜色，不是红按钮）。
- 操作中置忙（「处理中…」/「Working…」）；成功后立即 `pollNow` 刷新（不等 4s）；失败原文显示在
  popover 里、popover 不关闭。没有目标时显示「当前没有目标。」，读不到时显示「读不到本会话的目标。」。

**为什么不做 todo 进度条**：todo 的产生侧不可靠——调查 38 个真实 DeepSeek 会话：20 个从不调
`todo_write`，9 个只写 1 次（之后不再更新），8 个写 2 次（多在结束前一次性全标完成，其中 3 个
goal 会话提前标 100% 后又跑了 43–101 分钟），只有 1 个中途逐项更新。用 todo 算完成度会长期
停在 0% 或突然 100%；可靠进度只有 goal 自己的轮次，所以轮次也只当**预算**展示，todo 只用于
「正在」一行。

- 数据每 agent 轮询 `goal.current`，节奏与 jobs **完全相同**（共用
  `paseo-plugin/client/agent-polling.ts`）：4s 基准（可见/隐藏同频）、20% 抖动封顶 2s、
  首轮 0–1s 抖动、失败退避 4→8→16→30s、终态码停表、答案签名去重（未变不 publish/update）。
  goal 侧只多一条策略：瞬时错误不发布（保持上次状态）。没有推送通道可用：provider 事件枚举里
  没有 goal（survey §F4），只能轮询。
- 文案全部进 `client/locale.ts`（zh-CN / en），`locale-check` 覆盖 goal 表。

## 运行中发消息：默认不打断目标

Paseo 的发送行为默认是 `sendBehavior: "steer"`（Paseo `packages/app/src/hooks/use-settings/storage.ts:145`），
所以目标轮次运行中给会话发消息，默认**不打断**。三种落点【实测·survey §F1】：

| 操作 | 时间线上看到什么 | goal 状态 | 之后是否续跑 |
|---|---|---|---|
| 默认发送（steer）：消息注入**当前回合的下一个 step 边界** | 新增一条人类 `user_message` 行，**不新增 turn** | 不变（无 `goal/change`；`roundsStarted` 只随轮次准入增加） | 是：该轮正常 completed，下一轮自动开始 |
| 消息进了下一回合队列（followup / 宿主走 replace 之外的排队路径） | 人类回合先跑，goal 轮次排在其后 | 不变 | 是 |
| 点停止 / 取消，或把发送方式改成 interrupt（宿主 replace = 取消当前回合 + 开新回合） | 该回合终态 `canceled`；goal 行变「已暂停」 | **持久 paused**（disarmed） | 否；必须「继续」（= `/goal resume`） |

实测细节（survey §F1）：steer 的回执 `prompt_result {type:"steer", turnId}` 的 turnId 与 goal
轮次一致，模型看到消息并回复，该轮 `completed`；取消路径下 6s 内没有新轮次，`/goal show` 是
`Status: paused / Activation: disarmed`，之后再发人类消息也不会自动续跑。**两轮之间**发的消息
与「当前轮运行中发」是同一机制：DSH 的 followup 是下一回合队列，驱动器在 idle 时先看有没有
新入队的人类工作并让行（`@deepseek-ai/dsh-goal-round-driver/lib/index.js:85,253-262`），所以人类
回合总是排在下一轮 goal 之前。

产品结论：**不阻止运行中发消息**，只需要把「停止会暂停目标」在 pill 上表达清楚（paused 状态 +
行尾「继续」图标按钮）。暂停之后用户不 resume，目标就一直停着。

pill 的按钮走**命令注册表**而不是 steer：`paseo-plugin/server/session.ts:1067-1092` 的
`controlGoal` → `dsh-process.runCommand` → 桥 `paseo/command/run` → DSH `commands.execute` →
`dsh-command-goal`。所以运行中也能暂停 / 恢复 / 清除，且不会像手打那样被宿主 steer 进模型。
**这条是源码结论**（P3 探针在运行中代发过命令，survey §F3）；真机点 pill 按钮的验收待 FINAL。

## 重开：状态保留，续跑 disarm

目标状态只存在会话日志里，重开/恢复后 objective、phase、revision、已用轮数都还在；
**activation 是进程本地状态，任何 session-start 边都会 disarm**——重开后 active goal 不会自动
续跑，必须显式 resume（`@deepseek-ai/dsh-goal/README.md:70-72,99`）。两种关闭情形【实测·survey §F5】：

| 关闭时状态 | 重开后 `/goal show` | 恢复方式 |
|---|---|---|
| 有 goal 轮次正在跑（关闭打断它） | `Status: paused / Activation: disarmed`（轮次被取消 → 驱动器持久 pause） | `/goal resume` → 起 live goal 轮次 |
| 只有人类回合在跑、goal 为 active | `Status: active / Activation: disarmed` | `/goal resume` → 起 live goal 轮次 |

这就是 pill 必须显示 activation 的原因：如果只看持久投影/时间线行，第二种情形会显示成
「进行中」，用户以为还在自动跑，其实永远不会再起轮次——**静默降级**（见 FIELD-NOTES 第 86 条）。
面板行尾的「继续」图标按钮与 `/goal resume` 等价；重开后 paused 或 active+disarmed 都应直接可用。

补充：重开时历史回合以 `turn:history:N` 重放，Paseo 宿主对 history 事件走 `fromHistory` 分支
（survey §F5 补充）；UI 侧表现未实测。

## 已知限制：运行中手打 `/goal` 会被当成普通文本

**控制必须走 pill 按钮（插件 RPC），不要依赖用户在运行中手打命令。** 原因【源码推断·survey §F1 末尾】：

- 宿主对 out-of-band 命令的拦截依赖 provider 的 `tryHandleOutOfBand`
  （Paseo `packages/server/src/server/agent/agent-prompt.ts:114`、
  `agent-manager.ts:2635-2637`），而插件 provider 没有实现该方法。
- 运行中的 steer 路径把 prompt 一律映射成普通 message
  （Paseo `plugin-provider.ts:1219-1223` 的 `input: { type: "message", content }`）；
  只有空闲路径才用 `mapPromptInput` 把 `/goal ...` 识别成 command
  （`plugin-provider.ts:1193-1198,1768-1784`）。

所以运行中手打 `/goal pause` 很可能变成一条插进当前轮次的人类消息（模型看到 "pause" 字样），
命令不执行、目标状态不变。**该结论未在 App 上实测**（survey §F7 未验证第 1 条）。已实测的是
反过来的路径：插件 RPC 代发 `/goal pause|resume|clear|<objective>` 四条全部被 DSH 接受，失败
以 `error` 回执 + 原文返回（survey §F3）。

## 时间线：状态行与续跑轮次行

现状：`goal/change` 每个快照产出一行**固定 id** `tool:goal:current` 的 `tool_call` 状态行
（`paseo-plugin/server/activity-timeline.ts:156-189`，`turn/end` 不会取消它），分发在
`paseo-plugin/server/timeline.ts:802-810`。

新增：自动续跑的每个 goal 轮次在时间线上产出一行紧凑状态行，实时与重放**同一行（同 id）**：

| 项 | 状态行（已有） | 续跑轮次行（新增） |
|---|---|---|
| id / callId | `tool:goal:current` / `goal:current` | `tool:goal:round:<goalId>:<round>` / `goal:round:<goalId>:<round>` |
| name | `goal_state`（插件自有名） | `goal_round` |
| 文本 | 行头「目标状态 · 进行中 · <目标>」/「Goal status · …」（body 在 blocked 时追加原因） | 行头「目标续跑 · 第 N 轮」/「Goal round · N」 |
| 图标 | `Target`（`goal_state` 映射） | `Target`（`goal_round` 映射） |
| 交互 | 无 | 无；不是 `user_message`、无撤回令牌 |

- 形状复用 `tool_call` + `plain_text`；轮次行 **不点名 `icon` 键**，客户端用工具名映射补图标
  （`paseo-plugin/client/tool-call-data.ts:803-813` 的 `goal_round: "Target"`，以及 `toolIcon`
  对「无 icon 键的 plain_text」走名字表的回落，`:1020-1046`）。两条 goal 行因此与 composer
  pill 同符号。
- **既有状态行的图标是可见变化**：它原来显式带 `icon: "sparkles"`，而 `plain_text.icon` 优先于
  名字映射，所以以前渲染 Sparkles；现在去掉 icon 键、统一走 name 映射变 `Target`。这是有意
  统一（FIELD-NOTES「goal 家族 → Target」），已由 `tool-call-check` 钉住。
- 文本由两半拼成：客户端 tool 表 `goal_round` =「目标续跑」/「Goal round」
  （`paseo-plugin/client/locale.ts:274,536`），服务端 `UI.goalRound(round)` =「第 N 轮」/`N`
  （`paseo-plugin/server/locale.ts:140,169`），行头是 `label · summary`。
- 判定「这是不是一轮」：`source.kind === "goal"` 且 `round` 是正整数
  （`isGoalRoundSource`，`paseo-plugin/server/activity-timeline.ts:51-54`）；`round: 0` 的
  goal 来源消息不是轮次。实时、根会话重放、子会话重放三条路径都交给同一个 builder
  （`paseo-plugin/server/session.ts:1201-1219,3190-3203`），所以重开后行逐字节相同。
- **不**渲染成 `user_message`：不能被撤回选中、不冒充人类提问；行没有 body，`<goal_round>`
  提示原文不显示。
- **状态行不借用模型工具名。** 它以前叫 `get_goal`（只为拿 Target 图标），于是标题也成了
  「查看目标」，与模型真实的 `get_goal` 调用同名，读起来像模型多查了一次目标。现在是插件
  自有名 `goal_state`，标题「目标状态」（FIELD-NOTES 第 90 条）。
- **状态行排在引起它的 `/goal` 命令行之后。** DSH 写 `command/run` → `goal/change` →
  `command/done`，命令行要到 `command/done` 才画（输出在那里），所以 `TimelineBuilder` 在命令
  括号打开期间暂存状态行，`command/done` 后放出；括号里先出了别的行则状态行先放；日志停在括号
  中间时由 `settleRunningTools` 放出。实时与重放走同一个 builder，顺序一致
  （`harness/goal-state-order-check.cjs`）。
- **「固定 id」只在同一回合内原地更新。** 宿主按 `turnId + callId` 识别 tool_call
  （`@getpaseo/app` `types/stream.ts` 的 `agentToolCallIdentity`，服务端
  `timeline-projection.ts` 的合并也要求同 `turnId`）。`/goal <目标>` 在回合外建目标、续跑轮里
  `update_goal complete`，于是时间线上是两条状态行：开头「进行中」、结尾「已完成」。

## 时间线：模型的 goal 工具行

`create_goal` / `get_goal` / `update_goal` 是 DSH 的模型工具，结果是 `JSON.stringify` 的
`{goal:{id,revision,objective,phase,roundsStarted,maxGoalRounds,blockedReason?},activation}`
（`dsh-tool-goal` 的 `GOAL_OUTPUT`）。插件照 DSH 自己的 `goalDetail` 画（`dsh-client-ui-tool`）：

- 成功：行头右半是 objective；展开是字段卡「状态 / 执行轮次」，受阻时加「受阻原因」；
  `active + disarmed` 读作「等待继续」，`{goal:null}` 读作「没有目标」。解析在客户端
  （`client/tool-call-data.ts` 的 `parseGoalResult`），服务端协议不变，重放旧会话同样生效。
- 形状不对（坏 JSON、DSH 新增的 phase、缺字段）不出卡，原始结果照旧作为 body，不吞内容。
- 失败：不出卡（DSH 也是 `isError → null`）。行仍是 failed、图标与行头仍红。服务端把 DSH 的
  `tool/result.data.error.code` 放到 `metadata.errorCode`；`client/locale.ts` 的
  `goalCard.refusals` 认识的码，行头红字换成中文短句（如「已拒绝：续跑轮不能创建或修改目标」
  「已拒绝：参数组合不合法」），展开先是一句解释 + 错误码，再是 DSH 原文与调用参数。
  不认识的码、没有码的旧数据：行头保持 DSH 原文首行。

续跑轮里出现这两类红行**不是插件问题**：`/goal` 在回合外执行，续跑轮里没有人类消息，DSH
按设计拒绝模型 `create_goal`；模型给 `update_goal complete` 抄填了当前 objective/轮数上限，
DSH 判参数非法。两者都在写入前拒绝，目标不受影响（FIELD-NOTES 第 90 条）。
- 为什么必须补这一行：goal 轮次的提示是 `user/message` + `source.kind='goal'`，而插件实时路径
  只对 `undefined|'user'` 出用户行（`paseo-plugin/server/session.ts:330,1515-1523`）——这是
  「不冒充人类提问」的正确取舍，但没有任何替代行，用户会看到一个**凭空开始的回合**
  （FIELD-NOTES 第 87 条）。

## 撤回与 goal

**结论：撤回不会改写目标本身，但撤回会先取消运行中的回合，因此运行中撤回等同于点停止：
目标暂停。** 撤回只解析 `user/message` + `source.kind="user"` 的人类消息
（`dsh-bridge/lib/revert.js:14-17,93-130`），`goal/change` 不在撤回目标里，所以目标状态不是
撤回写出来的；变化全部来自「撤回前先结算 agent」：非 idle 就 `agent.cancel({kind:'user'})`
并清队列（`dsh-bridge/lib/server.js:2033-2046`、`:2691`），被取消的 goal 轮次让驱动器把目标
**持久 pause**（与「运行中发消息」的取消路径同源）。

【实测·桥路径】FINAL 验证（开发期 `FINAL-verify.md` §6，一次性隔离 home，经桥
`paseo/revert` `scope:"conversation"`，goal 状态经 `paseo/goal` 实时读）：

| 场景 | 撤回后 goal | 续跑 | 时间线 |
|---|---|---|---|
| A：goal 运行中（active+armed，第 1 轮进行中）撤回一条人类消息 | 立刻转 `paused + disarmed`，`revision` 1→2，`roundsStarted` 保持 1（不回退）；15s 内状态不再变 | **不再续跑**，要用户点「继续」 | 运行中的轮次被 `turn/end {reason:{kind:"aborted"}}` 取消；被撤区间里的 goal 轮次消息（`source.kind='goal'`）随之撤掉，重放只剩人类消息与 `paseo-rewind` 标记 |
| B：goal 已暂停（paused+disarmed）时撤回 | 完全不变（revision 不变） | 不续跑 | 新增 `paseo-rewind` 标记，被撤的人类消息不在重放里 |

**刚插话、还没进入对话的消息**（P3 修复，`dsh-bridge/lib/server.js`）：撤回不再一律报
「已被撤回或压缩」。桥在 `prompt()` 时登记「已发给 agent、尚未在 surface 出现」的 message id，
落 surface 即清除（`:1242,1252,1298-1325`）；`revert()` 预规划失败后先查这张表
（`:2830-2845` → `#withdrawPendingUserMessage` `:1327-1392`）：

| 消息状态 | conversation / both | files |
|---|---|---|
| 仍在待发队列（direct 调用） | 从队列移除 + `success` | 拒绝：「这条消息还没有进入对话，不能作为文件恢复的锚点；如需撤销它请使用对话撤回」 |
| 已被宿主预取消、不在队列、agent idle | `success`（无需再移除） | 同上拒绝 |
| 已被 claim、正在写入（agent 仍 running） | 拒绝：「这条消息还在发送中，稍后再撤回」（保留跟踪，可重试；**绝不假成功**） | 同上拒绝 |
| 真正不在日志里（已撤回/压缩） | 原错误文案「这条消息已不在可撤回的对话中（可能已被撤回或压缩）：<id>」 | 同原 |
| 已在 surface | 既有正常撤回路径 | 既有 files 撤回路径 |

- pending 撤回**不 append 替换标记、不 flush、不取消回合**：它没有 surface 节点可替换，成功
  回执只说明「它从未进入对话」。宿主路径下消息其实已被「撤回前预取消」清空 inbox，桥只负责
  给诚实回执；direct 路径下才真的 `inbox.remove`。
- **goal × pending**：宿主预取消照旧会取消 goal 轮次并 pause（与普通撤回一致）；pending 撤回
  本身不额外取消回合（P3 真机探针实测）。这也意味着「刚插话就撤回」同样可能让目标暂停——
  原因仍是取消回合，不是 pending 撤回新增的行为。
- 证据：P3 离线 `rewind-transaction-check` 28/28 + 一次性隔离 home 真机探针 8/8
  （`P3-rewind.md`）；**App UI 上「插话后 1 秒内可点撤回」的窗口未验证**。

**方法学**：插件侧 `session.revert` 在真正撤回前要先 arm 一条时间线报告，需要真实 Paseo API
句柄（`paseo-plugin/server/rewind-notice-append.ts` 的 `api.agents.ref(...)`）；假宿主给不出，
请求在到达桥之前就失败。FINAL 按任务书允许改走**桥**路径，所以本节标【实测·桥路径】，
**Paseo App 的撤回按钮（宿主 → 插件 revert → 桥）UI 层未验证**。桥路径的这个行为符合 provider
的设计假设（撤回先结算回合），不算缺陷。

**产品含义**：撤回与「点停止」对目标的影响相同——运行中撤回会把目标暂停。pill 在撤回后
显示「目标已暂停」+「继续」；状态由既有的 `goal.current` 轮询跟上，不需要额外接线。
**不改撤回 × goal 的行为**：`goal/change` 不参与撤回是源码事实，暂停是「取消回合」的既有
语义，不是撤回新增的副作用。

未覆盖：§6 只测了「撤回取消的是 goal 轮次」与「goal 已暂停」两种；**goal 为 active+armed
但撤回取消的是人类回合**（例如人类回合在跑、goal 尚未起轮）未单独实测——按源码，驱动器只在
被取消的 goal 轮次上持久 pause，那种情形撤回后可能仍会续跑，别把本节结论外推过去。

## 验证

离线（不需要 daemon、不需要模型；断言数为本次回填时实跑值）：

| 检查 | 断言 | 依赖 | 触发 |
|---|---|---|---|
| `harness/goal-bridge-check.mjs` | 15/15 | **本机 DSH 安装**（从全局安装解析 `@deepseek-ai/*`，`DSH_PACKAGES_DIR`/`DSH_INSTALL_DIR` 可覆盖；没有就 exit 2） | 动 `dsh-bridge/lib/server.js` 的 `paseo/goal` / dispatch |
| `harness/goal-pill-check.cjs` | 175/175 | 纯模块（`tsc -p harness/goal-pill.tsconfig.json`） | 动 `client/goal-polling.ts`、`client/goal-popover.tsx`、`client/goal-pill.tsx`、`client/goal-running.tsx`、`client/agent-polling.ts`、`shared/goal.ts` 或 locale goal 表 |
| `harness/goal-popover-render-check.cjs` | 51/51 | `HOST_APP` 指向 Paseo 检出（react-native-web + jsdom 渲染真实面板）；未设置 exit 2 | 动 `client/goal-popover.tsx`、`client/deepseek-mark*.tsx` 或面板用到的 `goal-polling.ts` 规则 |
| `harness/goal-server-check.cjs` | 39/39 | 真实插件 + 假桥（一次性 `DSH_HOME`） | 动 `server/provider.ts` / `server/session.ts` 的 goal 读写、`server/dsh-process.ts` 的 goal 分级与 `currentTask`、`index.server.ts` 的 handler、桥的缺失服务文案 |
| `harness/goal-timeline-check.cjs` | 6 组 | 真实 `DshSession` + 假进程传输（`plugin-build.cjs` 自编译） | 动 `server/activity-timeline.ts` 的 goal 行、`server/session.ts` 的重放过滤、`server/locale.ts` 的 `goalRound` |

运行方式（完整步骤见 [HARNESS.md](./HARNESS.md)「目标（goal）链」）：

```bash
# 内嵌桥新鲜度：改了桥必须先跑它，再跑依赖真机的检查（否则真机跑在旧桥上假绿）
node harness/bridge-assets-check.mjs

env -u DSH_HOME node harness/goal-bridge-check.mjs
# goal-pill：cd paseo-plugin && npx tsc -p ../harness/goal-pill.tsconfig.json
#            然后在 .dbg-goal 里 node goal-pill-check.cjs
HOST_APP=/path/to/paseo node harness/goal-popover-render-check.cjs
# goal-server：cd paseo-plugin && npx tsc --noEmit false --outDir .dbg --declaration false \
#              --module commonjs --moduleResolution node（类型噪音预期），再在 .dbg 里跑
node harness/goal-timeline-check.cjs
```

既有检查同步更新：`timeline-check` **235**（goal 轮次行 +17、todo `status` +6）、
`p003-timeline-check` 9（+1）、`tool-call-check` 397（+12，两条 goal 行的图标）、
`locale-check` 358（goal 表双语言覆盖）、`jobs-poll-check` 119（+3 钉住 jobs 旧文案）、
`rewind-transaction-check` **28**（+6：pending 插话撤回的 host 流 / direct 流 / files 拒绝 /
claim 后拒绝 / 落 surface 走正常路径 / close 清理）。

真机（一次性隔离 home，`env -u DSH_HOME`，日志首行必须是 `/tmp` 克隆）：

- survey §C 已实测：建目标 → 自动续跑 → 轮数耗尽转 `blocked(round-limit)` → 重开重放状态行 →
  冷读 `paseo/projections {keys:['goal']}`。
- survey §F 已实测：运行中 steer 不打断、取消后持久 pause、插件代发四条 `/goal` 命令、
  重开后 resume 起 live 轮次、live profile（含 `dsh-web-app`）下 `/goal` 与 goal 工具可用。
- 仓库内既有 `harness/p003-live-check.mjs` 覆盖真实 goal 行快照、重开重放与冷 projection 读取。
- FINAL 验证（`FINAL-verify.md` §6，桥路径，一次性 home）已实测撤回 × goal 的两种情形，
  见「撤回与 goal」；运行中发消息、pill 按钮、重开恢复的 UI 验收仍待 FINAL 的 App 层复核。
- 本文档的回填轮**未跑真机**（未耗 token、未碰 daemon）。

## 边界（不做）

- **不声明 goal 能力位**：Paseo 的 provider 能力枚举里没有 goal（survey §E2），声明了宿主也不认。
- **不改 Paseo 协议、不推送 goal 事件**：provider 事件形状里没有 goal，只能轮询（survey §F4）。
- **不在 pill 里新建目标**：没有目标时 pill 不可见；空闲时用 `/goal <目标>` 创建（或让模型调
  `create_goal`）。
- **不拦截运行中手打的 `/goal`**：宿主 steer 路径把它当文本；正确入口是 pill。
- **不重写 goal 状态机**：CAS、revision、轮数上限、blocked 码全部由 DSH 维护，我们只读与转发。
