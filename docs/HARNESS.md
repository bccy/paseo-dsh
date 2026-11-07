# harness 离线检查清单

从 [AGENTS.md](../AGENTS.md)「改完怎么验证」拆出来的逐脚本说明：每个检查断言什么、**动了哪里必跑**。
拆出去是因为 AGENTS.md 会作为工作区指令整份注入 DSH 会话，而 DSH 的工作区指令总预算是 64 KiB，
超出时会整份丢弃更外层的 `~/.dsh/AGENTS.md`（FIELD-NOTES 第 77 条）。往这里加条目不占那份预算。

还有一组**离线**脚本，直接 require 编译产物、不需要 daemon（运行步骤写在各自头部注释里）。
下面清单里穿插的 `subagent-check.cjs` 归档用例与 `archive-registry-check.mjs` **不属于这组**：
前者是假 `dsh` 驱动的，后者要真 profile。

- `harness/timeline-check.cjs` — `TimelineBuilder` 的工具行状态机：`tool/call` → `tool/result`、
  重复 `tool/call` 不能把完成行重置回 running 或清空输出、`turn/end`（含 `aborted`）要把仍
  running 的工具收成 `canceled`。**235 条**：goal 轮次行 +17（`tool:goal:round:*` 由同一
  builder 产出、同轮幂等、不同轮 id 不同、`turn/end` 不取消它），todo `status` +6（`todoItems`
  的 status 序列 / `completed` 由同一 status 派生 / 文本 / 未知值归一 `pending`）。**动了
  `server/timeline.ts` 的 `todoItems`、`server/activity-timeline.ts` 的 goal 轮次分支或
  `server/session.ts` 的重放过滤必跑。**
- `harness/p003-timeline-check.cjs` — 真实 `TimelineBuilder` → `ProviderEventSchema` → 客户端
  渲染数据的端到端：`goal/change`（目标行）与 `tool-workflow/*`（工作流/成员行）的完整快照、
  重复 start 不抹进度、run-end 的终态口径、后台工作流跨回合保持 running、死重放按 canceled
  收尾。本轮 +1 个用例：goal 轮次行渲染成 `Target`（`view.icon === "Target"`）。**动了
  `server/activity-timeline.ts`、`server/timeline.ts` 的 activity 分支或
  `client/tool-call-data.ts` 的 workflow/goal 映射必跑。**
- `harness/newest-check.cjs` — `client/newest.ts` 的"哪一行是最新、该不该脉冲"：位置判定、
  提交批次（回放历史不闪）、窗口、交接、时钟。**动了客户端脉冲条件必跑。**
- `harness/rewind-notice-check.cjs` — 撤回完成提示的客户端半：`shared/rewind-notice.ts` 的两种
  locale 文案与计数回退（读不出计数时不得编数字）、`client/rewind-notice-data.ts` 对**旧**
  session.notice 撤回行的识别（transformer 要删掉它们，canary 不得误伤）、
  `client/rewind-notice-live.ts` 的实时监视器（live 事件弹一次、重复投递/重挂载不弹、回放/重拉
  不弹、交接窗口、目录观察的 provider/新鲜度/数量上限、失败上报、dispose 释放），以及
  `index.client.tsx` / `index.server.ts` 的接线（renderer 用 shared kind、启动监视器并调用 arm
  RPC、只注册允许的 hook、不注册 `before("agent.session.open")`）。本轮补的：兜底 notice 的
  **降级标记**（server/client 两份常量逐字相等的漂移守卫、双 locale 的「带标记可见 / 无标记仍删」）
  与 NC-03 的句柄迟到单元场景（`beginRewindReport` 后、`deliver` 前才捕获句柄 → 先建 replacement
  订阅再 append，超时后 append 有界）。**动了撤回文案、
  `shared/rewind-notice.ts`、`client/rewind-notice*.ts(x)` 或 `index.client.tsx` 的注册必跑。**
  运行：`node harness/rewind-notice-check.cjs`（自己编译到 `paseo-plugin/.dbg-p17-client`）。
- `harness/rewind-notice-delivery-check.mjs` — 撤回完成提示**能不能确定地到达时间线**：一个进程里
  接上真实宿主（`PluginAgentClientRegistry` + `AgentManager` + `agent-run-state`）与编译后的插件，
  下面垫 `fake-dsh-bridge.mjs`，并用一个**假 Paseo API** 把 `timeline.append` /
  `timeline.subscribe` / `timeline.refetch` 接到宿主自己的方法上。断言：报告作为插件行落在
  daemon 的时间线里恰好一条；conversation/`both` 的行在宿主派发
  `agent.timeline.replacement` **之后**才落（重建会删掉之前的行）；2s 快照写入 + 5s 时间线重建的
  慢宿主下同样成立；行不进 provider history，下一次撤回不会把它复活；拿不到 paseo 句柄时报告
  排队、捕获后补发；canary 仍先于回执；机制半：回执同回合发出的 `session.notice` 被宿主丢弃、
  而追加的行存活。降级路径在子进程里用
  `DSH_PASEO_REWIND_REPLACEMENT_TIMEOUT_MS` 缩短超时驱动，本轮固化成两个场景：`--degraded`
  （超时后等 4 次有界复核跑完，断言最终一行且 stderr 有 `could not be confirmed` 放弃日志）与
  `--degraded-late`（rebuild 晚于 timeout 到达 → 行被抹 → 补发、两次 append 同一 `noticeId`、
  最终恰好一行）；另有真实宿主 race 场景（begin 之后、deliver 之前才捕获句柄 → 先建订阅再
  append，绝不裸 append）。**动了 provider 的 `session.revert`
  分支、`server/rewind-notice-append.ts`、`index.server.ts` 的句柄捕获/arm RPC、降级复核/补发，
  或宿主 `agent-manager.js` 的 rewind/hydrate/staging 逻辑必跑**（运行约 40s）。运行：
  `node harness/rewind-notice-delivery-check.mjs`（自己编译到
  `paseo-plugin/.dbg-p17-delivery`；不需要 daemon、不需要模型）。
- `harness/tool-call-check.cjs` — `client/tool-call-data.ts` 的工具行映射（图标、命令、diff、
  失败原因、终端卡）与正文截断口径：**generic 卡（read/fetch 无 meta、plan、
  `/command` 输出、agent message）与结构化 diff 卡的 body 不再截断**，改由视图滚动 + 复制全量
  body（260px，`CODE_MAX_HEIGHT` 的唯一消费者）；仍会截断的只有 legacy 纯文本 diff 回落
  （6000 + 本地化标记）与 `headline`/`summary`。本轮 385 → **397** 条（团队字段卡再 +46 → 443，见文末「团队（team）链」）：
  goal 状态行（`get_goal`）与轮次行（`goal_round`）都解析出 `Target`，其余**带 icon 键**的 `plain_text`
  行图标不变，无映射的 iconless `plain_text` 仍是 `Wrench`。**动了工具行渲染必跑（含失败原因：
  错误只认顶层 `item.error.message`；终端正文全量 + 224px 纵向滚动 + 复制；goal 两行的图标/
  名字映射）。**
  - unknown 行的**通用字段卡（L1）**再 +38 → **481**（L2 起 `fields` 多一个 `receipt`，
    见下条）：`fields = {args, result, copyText}` 把
    `input`（及 output 为对象/可 parse 成对象的 JSON 字符串时的 output）拆成有序条目——
    短标量（数字/布尔/null/≤60 字符单行串）→ `fact`，多行或长串 → `text`（值保留真换行，
    **不出现字面 `\n`**），嵌套对象/数组（含顶层数组，如 `list_agents` 的成员数组）→ `json`
    （pretty JSON）；空对象 input 不出参数区；普通字符串 output 仍是 body 原文。摘要取第一个
    短的单行字符串参数（`key: value`），不再整段 JSON；结构化 output 的 body 清空、复制控件
    改拿完整结果 JSON（`copyText`，parse 自字符串时是原串、对象时是 pretty JSON）。有自己卡
    的工具（`create_goal`/`get_goal`/`update_goal`、`team_task_*`）**结果不拆**：卡解析失败仍
    保留原文 body（卡自己的回落契约），只把参数拆成条目；agentMessage 整行不出通用 fields；
    失败的 unknown 行仍出参数条目。渲染侧断言钉 `ToolFieldsView`（`data.fields` 接线、复制拿
    `copyText`、prose 不重序列化、嵌套值仍走代码面、`fieldFacts` 带 `flexWrap: "wrap"` 以便
    窄屏折行、正文与 JSON 条目同用 260px 滚动窗——滚动不截断）。
  - 高频 unknown 工具的**专门映射（L2）**再 +101 → **582**（修一轮再 +21 → **603**）：`send_message`（team `target` 版与
    subagent-control `agent_id` 版按 input 分流：team `{"sent":true}`→「已发送」、旧
    `{messageId,status}`→「已发送 · <status>」、subagent-control 文本→「已投递」）、
    `interrupt_agent`（同分流；`previousStatus`→「已中断（原 running）」）、`spawn_teammate`
    （摘要 name、`context:fork` 附「继承上下文」，description fact + prompt prose，回执
    `已创建 · status · model`）、`wait_agent`（摘要 timeout_ms→秒/分钟、缺省 30 秒；回执
    超时/有变化、`no-active-peer` 翻译、noProgress.message 作 prose）、`list_agents`（顶层数组
    →每成员一行 `target · role · status`，摘要数**排除 Lead**、仅 Lead→「仅主会话」、空数组→
    「无成员」且不出卡、旧版 `(no subagents)` 原文留在 body）、`job_output`（末行
    `[status: …]`→回执（`exit code` 翻译成退出码）、其余输出仍是代码面正文、copyText 保留完整
    原文含状态行）、`job_kill`（单行 `requested cancellation of job …`→「已请求取消」）、
    `mcp_call_tool`（摘要 `server/tool`、`arguments` 按 L1 规则拆条目、结果交 L1）、
    `read_image`（摘要 basename，不重复画图）、`run_code`（摘要 description、程序走新的 `code`
    条目=代码面）。**形状不符一律返回 null 退回 L1（不猜）**；失败行不进映射、不出成功回执；
    回执渲染为卡片底部一行弱化文案（`fieldReceipt`）。**动了 `client/tool-call-data.ts` 的
    `toolMapping` 及其后的 L2 段、`client/tool-call.tsx` 的 `ToolFieldsView`、`client/locale.ts`
    的 `toolCards` 表或 `index.client.tsx` 的 dsh-tool schema 必跑；动了 `locale.ts` 还要跑
    `locale-check`。**
    - 2026-11-07 再补 17 个工具（`memory_update` / `memory_migrate_relation` /
      `memory_reproject`、`plugin_manager`、`schedule_edit` / `schedule_view`、`remote_*` 11 个）
      的 L2 卡：每个 mapper 先校验输入必填字段，形状不符一律返回 null 退回 L1；memory 三个按
      `dsh-prime-memory` 的 render 默认中文句严格整句解析出回执（notice / 自定义句 / 任何不匹配
      都回落 L1），`plugin_manager` 按 `withNextStep` 的 `application` 出回执、list 的 entries
      逐项可见且 copyText 完整，`schedule_view/edit` 按 `TASK_SCHEMA` / `EDIT_OUTPUT_SCHEMA`
      出任务字段，`remote_*` 没有真实 `tool/call` 样本，只做输入侧 + description 明示的 receipt
      字段（`sessionId` / `localPath`+`bytes` / `path`+`bytes` / `accepted` / `operationId`），
      其余结果留给 L1。memory 成功卡把 render 句作为回执并清空 body（不重复显示），copyText
      保留原句；每个工具至少一条正常 + 一条形状不符断言，断言 603 → **732**。
- `harness/thinking-check.cjs` — 思考行折叠预览：结束后取**第一行**、运行中取最后一个首行已终结
  的段落（都是 DSH 的行为，逐字移植在 `client/thinking-text.ts`），以及折叠行在流式中的宽度
  接线（行测自己的宽度、标签测自己要减掉的那段、行宽由两者相减得出，`useRevealedText` 不许
  再接管文本节奏）。**它不断言行标题**：标题恒为 `思考` 是 `client/locale.ts` 标签表里的一个键，
  由 `harness/locale-check.cjs` 的整表遍历覆盖——改坏了标题，这个脚本不会红。
  **动了思考行显示必跑。** 运行步骤现在需要同时编译 `client/inline-thinking.tsx`
  （`--jsx react-jsx --noCheck`），见文件头。
- `harness/subagent-check.cjs` 里另有归档用例：假桥的 replay 列表带一条 `archived: true` 的
  子会话，断言它**不被重放播报**（归档重启后必须仍然成立）；还断言归档往返本身——有打开的
  会话时代为转发、**没有**打开的会话时经一次性 probe 仍能往返、以及 registry 拒绝的 id 必须
  `request.failed`。**动了 `dsh-bridge/`、`replaySubagents()` 或 provider 的归档分支必跑。**
  但假桥证明不了"真实 profile 里到底有没有 `workspaceRegistry`"：改过桥的 bundle patch 或
  桥入口后，一定要在真 `dsh --profile paseo` 上跑一次 `harness/archive-registry-check.mjs`
  ——它把 `paseo/archive` 作为**第一帧**发（不发 `initialize`，和插件的一次性 probe 同形状），
  断言请求到达了真 registry。`@deepseek-ai/dsh-workspace` 只在 web bundle 里，缺了就是
  "composes no workspace registry"；桥入口漏等 profile 装载时则是**不发 initialize 就必现**。
- `harness/archived-lineage-check.mjs` — 纯模块离线检查（无需 profile/daemon）：桥里的
  `dsh-bridge/lib/archived-lineage.js` 必须逐字等价于 DSH 的 `underArchivedSession`——自身
  或任一 `origin:"subagent"` 祖先在 `archivedSessionIds` 即算已归档，fork 不继承、环路要终止。
  **动了这个模块、`listSessions` 的归档过滤或 `paseo/subagents` 的 `archived` 判定必跑。**
- `harness/image-host-path-check.mjs` — 纯模块离线检查（无需 profile/daemon）：桥里的
  `dsh-bridge/lib/image-host-path.js` 给 `tool/result` 的每个图片块**追加** `hostPath`，原有
  字段一个不动；attachments 缺失、`imageHostPath` 抛错（无效 ref 抛 `AttachmentError`）、
  返回非字符串、或事件不是 `tool/result` → **原样返回**。`historyEvents` 把同一规则用在
  `history()` 的重放投影上（`{type, seq?, time?, data}`）。**动了这个模块、桥的三处注入点或
  `history()` 的事件投影必跑。**
- `harness/sweep-check.cjs` — 原生扫光的几何：mask 曲线的停点、阶梯 alpha 的对称性与平铺、
  1.5s/0.3s/2-3 行程、`steps(48)`。**动了 `client/sweep-*.ts` 必跑。** iOS 上跑不了，这些
  数字就是"与 DSH 一致"的唯一凭据。
- `harness/style-check.cjs` — `client/tokens.ts` 的共享样式常量表（Phase 1 把工具行每个数值
  收进这里；13 还是 14、2×2 方块还是圆点、8% 还是 20% 底纹，漂移了在截图里都照样渲染，
  所以断言表本身，React 组件刻意不断言）。**动了 `client/tokens.ts` 或行样式必跑。**
- `harness/locale-check.cjs` — 客户端显示 locale 的纯函数解析链（`DSH_PASEO_LANG` 与
  `LANG`/`LC_ALL` 的优先级）和标签表覆盖：每个工具名在**两种语言**下都要有值，英文列是
  中文列的复制也要抓出来。goal 表另有几条：`GoalText.statuses` 必须恰好覆盖
  `shared/goal.ts` 声明的四个 phase 外加 `disarmed`（`active + disarmed` 的 facts 词「未在续跑」/
  「Not continuing」；DSH 以后加 phase 时不能落到原始英文），`disarmedHint` 是文案 B 逐字
  （「重开会话后自动续跑会停止，点「继续」恢复」/「Auto-continue stops when the session is reopened.
  Press Resume to continue.」），提示里点名的按钮与 ▶ 按钮同名（「继续目标」/「Resume goal」），
  编辑页 `goal.editor` 表键齐全、键名（Esc/Enter/Shift Enter）两语一致、其余词中英不互抄，且 goal 的
  label/按钮/提示文案中英两列都不得为空或互为复制；完成态四键（`complete`「目标已完成」、`completeHint` 指向收尾消息、
  `completeClearHint`「清除后 /goal 将查不到这个目标，无法撤销」且不同于 active 的确认句、`rowLabel` 状态在前）；**控制错误中文表**（DSH/插件拒绝句逐句译文、英文原样、显示保留原文；未知句与未知变量不翻；
  读本机 `dsh-command-goal/lib/index.js` 的错误字面量逐条确认都有中文，找不到时打印 NOTE，`DSH_COMMAND_GOAL` 可覆盖路径）（实跑 762 条，含团队段与 2026-11-07 的 17 工具标签/图标段，见文末「团队（team）链」）。**动了 `client/locale.ts`、标签表或
  `shared/goal.ts` 的 phase 枚举必跑。**
- `harness/jobs-poll-check.cjs` — jobs 轮询状态机（假时钟 + 假 RPC + 假目录页，不 import
  React/host）：可见性（有 live 显示 live 数、无 live 隐藏；图标恒为转环，仅 `available:false`
  保留基线静态 mark）、间隔（可见/隐藏同为 4s、失败指数退避 8→16→30s）与抖动、首屏 `pageInfo`
  分页与过期页丢弃、终态错误码停轮询，以及**发布去重**：答案签名
  （`available`/`error`/`code`/`jobs`）未变时不 publish、首答与 `drop` 后重注册必发布、任一
  真实变化（含 available 回真、错误文案/code 变化）仍发布。**本轮 141 条**（2026-11-05 新增 22 条：`jobsPillCopy` 在运行中/停止中/混合/九个/registry 读不到五种可见状态 × 中英，pill 文字恒为「后台」/「Background」，返回值只有 `label`、不带数量）：控制器已抽到
  `client/agent-polling.ts`（jobs 与 goal 共用），`client/jobs-polling.ts` 只剩 jobs 适配器；
  多出的 3 条**逐字钉住 jobs 的旧文案**（读失败兜底句、poll 失败日志、分页上限日志）——泛化
  不得改 jobs 用户可见文案。**动了 `client/jobs-pill.tsx` / `client/jobs-polling.ts` /
  `client/agent-polling.ts` / `client/poll-sequence.ts` / `client/locale.ts` 的 jobs 表 /
  `shared/jobs.ts` 必跑；`jobs-poll.tsconfig.json` 是它的编译配置。**
- `harness/pill-deference-check.cjs` — 三颗 composer pill 的**可见性协调器**（**49 条**，`client/pill-deference.ts` 纯 TS、不 import React/host）：初始 goal=false/team=false 不阻挡；四种 goal/team 组合下 `blocksJobs` 仅在两者同时可见时为真；`report` 只在真实变化时通知（重复上报静默、无 state 时的 false 上报不创建空状态）、`forget` 清一侧且仅在该侧原为 true 时通知、两侧都 false 后 state 删除；多 agent 状态与订阅隔离；监听器抛错会 `console.error` 且不阻塞其余监听器；取消订阅、`dispose`（含二次 dispose）后状态与监听全释放且后续上报惰性。运行：`cd paseo-plugin && npx tsc -p ../harness/pill-deference.tsconfig.json`，写 `.dbg-deference/package.json` 并拷入本脚本，`cd .dbg-deference && node pill-deference-check.cjs`。**动了 `client/pill-deference.ts` 或三颗 pill 的退避接线必跑。**
- `harness/jobs-popover-check.cjs` — jobs popover 的几何、状态标记、JSX 接线与宿主主题数据（**223 条**；2026-11-05：pill 文字经 `jobsPillCopy`、源码不再出现 `liveLabel`；触发图标钉从 `JobsSpinner`/`ListChecks` 改为 `JobsPillIcon`（`SquareTerminal` + 角标环）/`SquareTerminal`；2026-11-06：源码钉改为「`presentation = jobsPillPresentation(next)` 后 `visible = presentation.visible && !deference.blocksJobs(agentId)`，`update` 发送门控后的 `visible`」）；
  `HOST_APP` 指 Paseo checkout，没有就会跑完但 exit 2。**同上触发条件必跑（需 `HOST_APP`），
  跑法见文件头注释。**
- `harness/replay-turn-check.cjs` — 重放历史的回合标识：`replayHistory()` 必须把 DSH 日志里的
  `turn/start`…`turn/end` 括号翻译成成对的 `session.turn`（started 在前、行在中间、终态在后），
  否则 Paseo 的 `currentTurnId` 在重放期间恒为 null，重开出来的每一行都没有 `turnId`，
  客户端退回「每条 user_message 起一个回合」，被拆块的提问就永远折不起来。断言：两个回合
  各被 started…终态闭合、4 条行全部落在区间内、两回合 turnId 不同、同一回合的 user 与
  assistant 行归属同一个 turnId、turnId 稳定派生自 DSH 回合号（重开可复现）。用假桥驱动
  编译后的真实 `DshSession.replayHistory()`，并逐字复刻 Paseo 的 `translateTurn`/
  `translateTimeline` 规则，所以断言打在协议层而不是界面。**动了 `server/session.ts` 的
  重放路径或 `session.turn` 的发出时机必跑。**
- `harness/context-usage-check.cjs` — 用编译后的真实 `DshSession`、只替换进程传输，断言
  上下文占用的上报边界（打开会话上报已用量与容量、回合内合并更新、压缩后下降、未知容量
  清除旧值、无效计数拒绝、切模型时迟到的旧响应不能覆盖、关闭后不再发）。参数是编译输出
  目录：`node harness/context-usage-check.cjs <dir>`。**动了 `server/dsh-process.ts` 的用量
  读取或 `DshSession` 的用量上报必跑。**
- `harness/catalog-cache-check.mjs` — catalog 缓存按 cwd 的小 LRU（不是单槽）：多工作区
  A→B→A 只起 2 个 probe（旧实现 3 个），每个 cwd 命中各自条目。**动了 `provider.ts` 的
  `loadCatalog` / catalog 缓存 / TTL 必跑。**
- `harness/open-degrade-check.mjs` — open 期降级必须用户可见：`paseo/history` 抛错、preset
  被拒、plan 对账失败（plan 模式）都要发 `session.notice`/warning，而不是只写 stderr；
  子代理枚举失败也点名。**动了 `session.ts` 的 `replayHistory`/open 降级通知、`provider.ts`
  的 `openWarnings`/preset 校验，或 `fake-dsh-bridge.mjs` 的 `history-error`/`preset-reject`/
  `plan-error` 场景必跑。**
- `harness/agent-message-check.cjs` — Paseo 0.12 的 `agent_message` 行：`agentMessage` 字段
  取用、英文标签对齐官方 display model、缺 `agentMessage` 时**交还宿主原生渲染**。
  **动了 `client/tool-call-data.ts` 的 `agent_message` 分支或 `index.client.tsx` 的
  transformer 必跑。**
- `harness/uploaded-file-check.cjs` — 附件块翻译与官方 `renderPromptAttachmentAsText` 逐字
  一致；text/image 形状不变、未知类型抛错。**动了 `server/session.ts` 的 `toDshContent` 必跑。**
- `harness/paseo-system-envelope-check.mjs` — 桥的 `<paseo-system>` 信封翻译（无属性/版本化
  两形、system 消息保持 user turn、非字符串拒绝）。**动了
  `dsh-bridge/lib/paseo-system-envelope.js` 必跑。**
- `harness/mcp-http-check.mjs` — 桥的 MCP streamable-HTTP 客户端（SSE/JSON、session id 有无、
  JSON-RPC 错误、取消路径），本地 loopback，不需要外部服务。**动了 `dsh-bridge/lib/mcp-http.js` 必跑。**
- `harness/mcp-stdio-check.mjs` — 桥的 MCP stdio 客户端（`dsh-bridge/lib/mcp-stdio.js`）：
  握手顺序（`initialize` 先于 `tools/list`、`notifications/initialized` 发出）、`tools/list`
  缓存与 `refresh`、`tools/call` 的参数、JSON-RPC error 变 reject、**stdout 混入非 JSON 行
  不能炸**（Playwright MCP 会往 stdout 打日志）、超时生效、子进程退出时在途请求被 reject
  且**后续调用立即失败**（不悬挂、不重启死进程）、`dispose` 收得掉子进程。用一个临时 .mjs
  假 server 驱动，纯离线。**动了
  `dsh-bridge/lib/mcp-stdio.js`（含取消路径）或 gateway 的 stdio 分支必跑。**
- `harness/mcp-gateway-transport-check.mjs` — gateway 的传输判定（`transportOf`）与配置
  校验：`url` → HTTP、`command` → stdio，而**两者都给、都不给、给空串、拼错键名都必须
  报错点名**。`Schema.union` 是合并式匹配、**不排他**（同时给 `url` 和 `command` 会通过
  校验并保留多余键），所以排他判据只能在 `transportOf` 里，这个脚本钉住它。纯离线，
  依赖从 DSH 安装目录按绝对路径加载（`DSH_PACKAGES_DIR` 可覆盖）。**动了 `transportOf`、
  gateway 的 `Config` 或 `clientFor` 的传输分派必跑。**
- `harness/dsh-api-contract-check.mjs` — 桥依赖的 **DSH 内部 API** 还在不在（纯离线、秒级，
  不起进程、不耗 token）。桥不是 ACP 适配器，它直接 import 八个 DSH 内部组装包
  （`dsh-llm` / `dsh-agent` / `dsh-attachment` / `dsh-brand` / `dsh-cmdline` / `dsh-tools` /
  `dsh-subprocess` / `schemastery`），这些包**没有 API 稳定性承诺**。脚本断言两件事：
  **覆盖率**（桥源码里每个 `@deepseek-ai/*` import 都必须在 `EXPECTED` 清单里，且清单里没有
  桥已不用的条目——**双向**，所以新增依赖漏登记、删了 import 留下死清单都会红）和**存在性**
  （13 个符号仍被导出、类型没变）。它查的是 FIELD-NOTES #58 那种失效：`{{cwd}}` 变量被上游
  删掉，每个回合都在提示词装配阶段抛错，界面只有一条空的 `[error]`，而 **doctor 全程是绿的**
  （doctor 只查安装完整性，查不出软契约）。**它不查行为**——签名变了但符号还在，这里不会红，
  那由 `plugin-check.cjs` 的真实回合覆盖。**它也只覆盖 import 符号，不覆盖实例方法**（如
  live agent 的 `runMaintenance`，类未导出）；升级时这里不会红，别当完整门。两个都跑才算数。
  **DSH 升版后必跑、优先于其它一切**：它最快、且失败信息直接点名哪个包的哪个符号没了。
  `DSH_PACKAGES_DIR` 可覆盖安装目录。
- `harness/bridge-assets-check.mjs` — `server/bridge-assets.ts` 必须与 `dsh-bridge/` 和
  `templates/` 逐字节一致（只读，不起进程）。**改桥后先跑它、再跑任何插件级脚本。**
- `harness/bootstrap-check.mjs` — 桥安装/替换的 verify-before-switch（**27 条**）：暂存目录逐文件
  写后**回读 size + SHA-256** 校验、失败不发布、旧代际保留、失败日志必须明确 NOT ready（不能把
  "没装成"说成 "profile ready"）；桥发布在 `$DSH_HOME/profiles/node_modules/dsh-paseo-bridge`
  （profile 的 `node_modules` 归 pnpm 管，见下一条），且旧位置的桥（真目录或 install.sh 的符号
  链接，只删链接不动 checkout）与 pnpm 停在 `.ignored/` 的副本（`dsh-paseo-bridge` /
  `_<n>`）会被迁移掉，别的包的 `.ignored` 副本与**本桥自己的 `dsh-paseo-bridge.bak-*` 备份
  保留且逐字节不变**（清理正则只认 pnpm 命名；把正则放宽成 `(?:[._].*)?` 时这条断言会红——这是
  P3-1 的回归门）。**动了 `paseo-plugin/server/bootstrap.ts` 的桥安装/替换/迁移/`.ignored`
  清理、`index.server.ts` 的 provisioning 日志、或 `bridge-assets.ts` 的 `BRIDGE_FILES` 结构必跑。**
- `harness/pnpm-bridge-check.mjs` — **pnpm 不能把桥拿走**（一次性 `mkdtemp` `DSH_HOME`，真
  `dsh` + 真 pnpm；不改真实 `~/.dsh`，不需要网络）：bootstrap 之后用真
  `dsh --profile <p> --dump-config` 断言组合里有桥层（独立 oracle，不是插件自己的路径常量）→
  跑真 `dsh plugin --profile <p> add file:<本地小包>`（pnpm 12 在 `nodeLinker: hoisted` 下把
  `<profile>/node_modules` 里未记录的目录挪进 `.ignored/`，正是这条命令让桥消失）→ 断言没有
  `.ignored/dsh-paseo-bridge*`、桥字节不变、DSH 仍组合桥层 → 再跑 `dsh plugin install` 复验 →
  模拟修前磁盘形态（profile 本地桥 + `.ignored` 副本）断言下一次 provisioning 迁移掉。**修前
  13 条红、修后 20 条绿。动了 `bootstrap.ts` 的桥位置/迁移、`doctor.mjs` 的桥位置判定、
  `pnpm-workspace.yaml` 的 linker 设置，或 DSH/pnpm 升级后必跑**（缺 `dsh` 或 pnpm 时按真实
  错误退出，不静默跳过）。
- `harness/doctor-check.mjs` — `paseo-plugin/lib/doctor.mjs` 的判定，驱动真实的 `runDoctor()`
  跑在沙箱 `DSH_HOME` 上：空 provider/model、缺 default-model、YAML 错、无值凭据、`refs:` 外
  凭据都必须 fail，完整配置仍通过（负向用例的对照）；桥缺 lazy 加载模块必须 fail 并**点名缺的
  那个模块**（以前只查 `lib/index.js` 一个入口，残缺桥照样报 provisioned、exit 0），完整桥仍
  报 provisioned（这一条是前一条的对照，防止"只会 fail"的检查也算通过）；`bridge-assets.ts`
  取不出键清单时必须 **fail 而不是 warn**——"没能检查"和"检查通过"是两个答案，只有一个可以
  exit 0（同样带可读清单的对照，免得被"什么都 fail"的 doctor 满足）。本轮补的三组契约层判据
  （用例 11/12/13）：**凭据文档契约**（缺 `version: 1`、0644、非法 `refs` 键名都必须 fail，
  旧扁平格式仍 ok 并说明会被 DSH 迁移）、**补丁能否被 DSH 应用**（补丁 `name` 写错时 dump
  告警必须让 doctor fail，干净时 ok）、**profile 就绪**（缺 `package.json`、`bundles` 不含
  `dsh-paseo-bridge` 都必须 fail，完整 profile ok）。stub `dsh` 的 `--dump-config` 用补丁里的
  marker 注释模拟 DSH 的判定，**真实组合语义由 `harness/doctor-live-check.mjs` 覆盖**。桥位置
  两处都判（用例 8b/8c）：桥在 `$DSH_HOME/profiles/node_modules`（bootstrap 现在发布的位置）也
  必须报 provisioned 并点名该路径；profile 自己的 `node_modules` 里还留着一份时，因为 DSH 先
  解析它，必须 **warn「legacy bridge copy shadows the provisioned one」** 而不是把共享那份报成
  生效。**动了 doctor 必跑。**
- `harness/probe-check.mjs` — `paseo-plugin/lib/probe-provider.mjs` 的退出码与泄密防护
  （200+error/HTML 判失败、4xx 回显 Authorization 不得泄 key、全 429 报 unknown、什么都没
  探测到必须非零）。**动了 probe 必跑。**
- `harness/session-request-check.cjs` — 两段非回合请求：`paseo/sessions` 导入列表
  （persistence handle/cwd/title/preview→description/updatedAt）与 `paseo/revert` 撤回回执。
  撤回那一半钉住：provider 声明三种撤回能力（`.both`/`.conversation`/`.files`，少一个 Paseo
  就不显示对应菜单）、成功发 `request.completed`、被拒必须 `request.failed`、**canary 恰好一条且
  出现在回执之前**（顺序即机制，见 AGENTS.md「撤回」一节）、被拒之后没有 canary、连续两次撤回的文案不同
  （序号递增）、`scope: "files"` 的撤回**不**发 canary（对话没被动过）、`scope: "both"` 的
  文案要点出文件那一半；仍然没有「正在回退，请稍候」这类刷新窗口通知。每条成功撤回还要有**恰好
  一条 completion notice**，文案按 scope 与回执 `restored`/`deleted` 数组计数，且必须在
  `request.completed` **之后**（与 canary 相反，补丁宿主会截断回执前的内容）；部分失败只发
  `文件回退未完成`，不得再发成功提示。这个脚本**直接驱动 provider 连接**、不发
  `PASEO_AGENT_ID`，所以完成报告走的是 provider 的**响亮降级**：没有 agent id 就没有可追加的
  时间线行，provider 打日志并退回 provider notice——本脚本钉的正是这条降级路径的文案/顺序/计数。
  正常路径（`timeline.append`、在 `agent.timeline.replacement` 之后落行）由
  `harness/rewind-notice-delivery-check.mjs` 覆盖。假桥 + 一次性 `DSH_HOME`。**动了 provider 的
  `session.revert`/`sessions` 分支、能力位声明、canary/完成报告的发出位置与文案、`dsh-process.ts`
  的这两个请求、或假桥对应分支必跑**；**`listDshSessions`/`#listSessions` 或 `DshProcess.sessions()`
  的 cwd 透传也算（断言出站帧 `params.cwd`）。**
- `harness/rewind-transaction-check.mjs` — 撤回事务（真实 `PaseoHarnessServer` + 真实
  `FileSnapshots` + 记录型 ctx，私临时目录，无 profile/daemon/模型）：计划在日志写入前后各算
  一次、door 挡住中途的写入、durability 失败保留文件与 journal、`runMaintenance` 缺失时在
  取消回合之前失败、闸门与票据清空；本轮补上 **files-only**：不 append 撤回标记、不 flush、
  不 prune journal、不要求 session store，但同样取消/等待被撤回子代理；以及 files-only 后重复
  幂等、对更早/更晚消息做 `both` 时 `planRestore` 仍取目标消息自己的 pre-image。
  **本轮 28 条（原 22 + 6）**：刚 steer、尚未进入 surface 的消息撤回——host 流（已被预取消
  清空 inbox → 成功且不取消回合）/ direct 流（仍在 inbox → `remove` + 成功）/ files 作用域
  拒绝（「还没有进入对话，不能作为文件恢复的锚点」）/ 已被 claim 正在写入 → 拒绝「还在发送中，
  稍后再撤回」且保留跟踪 / 落 surface 后走正常撤回 / close 清理 pending 表。**动了
  `server.js` 的 `revert` 事务、`pendingUserMessages` 跟踪、`beginFileMutation`/
  `finishFileMutation`/`ownsFileMutation` 或 `file-mutation-gate.js` 必跑。**
- `harness/plugin-build.cjs` — **不是检查，是需要编译产物的 harness 共用的构建基础设施**
  （当前调用方见 `grep -l plugin-build harness/*`；`plugin-check.cjs` 仍走自己头部注释里的
  手工 `tsc` 步骤，不在其中）。
  它决定已有的编译树能否复用（源码集合 + 构建戳），判错不会让产物看起来有任何异常，只会让
  **其它检查在陈旧或残缺的产物上假绿**——这是这里最危险的失效形态。`resolvePluginBuild()`
  自动编译到 `paseo-plugin/.dbg-*`（产物必须在仓库内，`/tmp` 下 node 向上找不到
  `paseo-plugin/node_modules`），每个调用方传自己的目录名以免并行任务共用一棵树。
  **动了它的源码集合推导、新鲜度判据或构建戳格式必跑 `harness/plugin-build-check.mjs`。**
- `harness/plugin-build-check.mjs` — `plugin-build.cjs` 新鲜度判据的回归，纯元数据（不 require
  产物、不写仓库：构造状态全在临时目录的私有副本里）。每个场景**双向断言**——构造状态断言判据、
  还原后再断言回到 fresh，所以卡在任一答案都会红，不只是判据太松会红。钉住：刚构建的树是 fresh
  且源码集合覆盖根级入口（`index.server.ts` 注册 provider、`index.client.tsx`，这正是它存在的
  原因）；源码比构建新时 stale 且报错**点名那个文件**；缺编译产物、源码已删而 `.js` 还在、缺
  `package.json`、缺构建戳、构建后新增了源码、空源码集合，全部 stale（fail closed，绝不信没有
  构建戳的树）；`PASEO_PLUGIN_BUILD` 绕行每次都要喊、外部树与源码不一致时仍告警；判据确实接在
  复用决策上（`buildPlugin()` 会重建缺产物的树、复用 fresh 的树）。**动了 `plugin-build.cjs`
  的判据必跑。** 之所以不能省：`plugin-build.cjs` 是这条链的地基，判据一松，它下游每个
  harness 都会在陈旧或残缺的产物上变绿，而红绿本身看不出区别——这个脚本是唯一能把"判据退化了"
  和"判据正常"区分开的东西。
- `harness/harness-gates-check.mjs` — harness 自己判据的回归：T01 `route-test` 按终态分
  WORKS/FAILS/TIMEOUT/CANCELED/EMPTY 且全失败必须非零、T02 `tools.mjs` initialize 与 prompt
  共用 sessionId、T03 `plugin-check` 不预过滤 assistant 行、T04 图片证据取插件发出的 prompt
  frame（模型自报的 `IMAGE-SEEN` 不再算数）、HP-08 `session-calls` 无 schema 的调用必须
  exit 2 而不是 0、HP-05 隔离 home 的默认/opt-in 行为（克隆带共享锚点的桥、且是**真拷贝不是
  符号链接**——链接会让克隆写回真实 home；源没有锚点时不得凭空造一个）。纯离线，会启动真实入口
  脚本 + 假 peer；真实 `dsh --dump-config` 的组合半在 `harness/isolated-home-bridge-check.mjs`。
  **动了 `route-test.mjs` / `tools.mjs` / `session-calls.mjs` / `plugin-check.cjs` 的判据，或
  `harness-gates.cjs` / `isolated-dsh-home.cjs` 必跑。**
- `harness/harness-gates.cjs` / `harness/isolated-dsh-home.cjs` — **不是独立检查**：前者是
  `route-test` / `tools` / `session-calls` / `plugin-check` 共用的纯判据（终态分类、退出码、
  完整时间线投影、图片块断言），后者是真实 profile/模型脚本的一次性 `DSH_HOME`（克隆源
  profile **与共享锚点的桥**——桥已不在 profile 目录里，只克隆 profile 会让这些脚本在无桥的
  克隆上起 `dsh --profile`，只打印 skipping 然后静默降级；桥是真拷贝不是符号链接，避免写回
  真实 home；源没有锚点时保持旧行为。另：凭据只做 symlink、退出清理、`--allow-real-profile`
  opt-in）。改动它们必跑 `harness/harness-gates-check.mjs` 的对应段 +
  `harness/isolated-home-bridge-check.mjs`。
- `harness/isolated-home-bridge-check.mjs` — **一次性 home 克隆必须带得上桥**（真 `dsh`，
  一次性 `mkdtemp` 源 home，不碰真实 `~/.dsh`、不耗 token）：源 home 只有共享锚点的桥（迁移后
  形态）→ `prepareDshHome` 克隆 → 断言克隆里有桥、是真目录不是符号链接、写进克隆的桥不会落到
  源 home、且 `dsh --profile <p> --dump-config` 组合出桥层且**无 skipping**（这是
  route-test / stream-probe / tools / catalog / probe / rewind-e2e / rewind-merge-e2e 这些
  「克隆后直接起 dsh、不跑 bootstrap」脚本的真实前提）；源 home 只有 profile 本地桥（迁移前
  形态）仍克隆出可用 home；源 home 完全没有桥时不得凭空造。**修前 7 passed/5 failed，修后
  12/0。动了 `harness/isolated-dsh-home.cjs` 或 `bootstrap.ts` 的桥位置必跑。**
- `harness/frame-reader-check.mjs` — 插件的 stdout 分帧器（`paseo-plugin/server/frame-reader.ts`，
  共享 `dsh` 子进程的每一帧都过它）：20 MB 帧跨数千个 16 KB chunk 逐字节还原、一个 chunk 里的多帧按序到达、
  被 chunk 边界切断的帧能重组、空行被**跳过**而不是报成解析错（两者是 `#consume` 里不同的日志
  行）、`\r\n` 解析通过且保留 `\r`、尾部残行滞留不发、chunk 正好停在换行时不留残留、畸形行报错
  后后续行仍到达，并用**旧实现的随机分块对照**证明增量扫描不是 O(n²)（旧写法每个 chunk 重切整个
  缓冲，回放大会话时慢到 7–12 s）。纯模块：只把这一个文件编到 `paseo-plugin/` 下的临时目录，
  用完删掉。**动了 `server/frame-reader.ts` 或 `#consume` 的分帧/报错分支必跑。**
- `harness/fake-bridge-multi-check.mjs` — 假桥的 `multi` 场景，**纯协议层**（只 spawn 假桥说
  JSON-RPC，不经过插件）：一个桥进程带多个 Paseo 会话时各拿自己的答案、没有事件被路由到别的
  会话、每个会话恰好一次 `turn/end` 且回合号是自己的、`initialize` 不带 session id 也不打乱
  绑定、同一会话第二次提问不重放第一个会话的场景。它是插件层 `multi-session-check.mjs` 的
  前置——桥这一层先按会话隔离了，插件里再串台才可能是插件自己的问题。
  **动了 `fake-dsh-bridge.mjs` 的 `multi` 场景或桥的会话绑定必跑。**
- `harness/multi-session-check.mjs` — 两个 Paseo 会话共用**一个** `dsh` 子进程时在**插件层**
  不串台（桥的协议层由 `fake-bridge-multi-check.mjs` 覆盖，这里走插件自己的 `#sessions`、
  子进程 id 与引用计数，只有过一遍插件才能证明这一对是干净的）：两会话各自提问并各自拿到自己的
  答案、每个时间线只含自己的消息（任何事件类型下都看不到对方的文本）、各自一次 `session.turn`
  起止、关掉一个另一个仍能提问并作答；另外还钉住**共享子进程的引用计数**（每开一个会话加一个
  claim、关一个还一个，另一个仍在跑所以进程不被回收）与**孤儿帧的清理**（一个会话关闭时它的
  帧桶与计时器一起消失，不会 5 s 后打一条误导的「no ancestor announced」，而另一个会话的桶
  仍然照常上报——正对照，免得"清理过头"也通过）。假 `dsh` + 一次性 `DSH_HOME`，自己编译到私有
  目录。**动了多会话路由、`#deliverLive`、`provider.ts` 的引用计数或 `session.ts` 的会话归属
  逻辑必跑；或 `dsh-process.ts` 的 prompt/close 时序也必跑。**
- `harness/shared-process-cwd-check.mjs` — 共享 `dsh` 子进程**自己的 cwd** 必须是不属于任何
  会话的稳定目录（FIELD-NOTES 91）：插件曾按第一个打开会话的 cwd 启动共享进程，工作区（Paseo
  worktree）被删后 `/proc/<pid>/cwd` 变 `(deleted)`，而 DSH 的 Linux scope 启动器用
  `process.cwd()` 起 `systemd-run`（`@deepseek-ai/dsh-subprocess-local` `lib/index.js:546,575`），
  于是**所有**会话的 bash 都报 `spawn systemd-run ENOENT`。假 `dsh` + 一次性 `DSH_HOME`，自己
  编译到私有目录；用一层 wrapper 记录插件**实际** spawn 出的 cwd（`pwd -P`）与 pid。钉住：spawn
  cwd 是 `stableProcessCwd()`（home，home 缺失时回落 tmp）、不是第一个/第二个会话的工作区；进程级
  `initialize` 带同一目录；两个会话各自的 `initialize` 仍带自己的工作区（会话 cwd 没有被挪到
  home）；删掉第一个会话的工作区后 spawn cwd 仍存在、同一个 pid 继续服务后续 prompt 并作答；
  `stableProcessCwd` 的现有 home / 缺失 home / 空 home 三个分支。**动了 `provider.ts` 的
  `#acquirePoolProcess` 或共享进程的 spawn cwd、或 `dsh-process.ts` 的 `stableProcessCwd` /
  `#start` 必跑。**
- `harness/concurrent-open-check.mjs` — 同一个 DSH 会话的两次并发 `session.open` 不能毁掉成功的
  那次：只有一次到达 `session.ready`；另一次**响亮失败**（`request.failed`，不是沉默）；失败方
  被 in-flight 守卫拒掉（"another open … is already in flight"），**不是** `attachSession` 的
  "already attached"——走到 attach 就是失败方的 catch 拿着胜者状态的成因；胜者仍能提问并作答
  （没有 "unknown session"，这是用户可见的那一半）；失败事务释放了守卫，之后重新 open（新
  provider session id + persistence handle，跟 reload 一样）仍然成功。冷连接复现不出这个窗口，
  需要 `replaced` 分支那几个 await 的交错，所以脚本先开一次到 ready、再并发发两次。假 `dsh` +
  一次性 `DSH_HOME`，自己编译到私有目录。**动了 `provider.ts` 的 open/close 事务或 `#opening`
  守卫必跑。**

  脚本第二部分钉住 `#opening` 单独一个守卫盖不住的另外两个窗口，都是把**第二条请求放进第一条的
  await 里**（假桥的 `DSH_FAKE_HOLD_METHOD` 让它在指定方法上停住，直到测试写释放文件——不靠
  睡等时序）：**(a)** 开事务在旧 holder 的 `close()` 里停住时，一个 `session.close` 落在同一
  provider id 上，该 open 必须**响亮失败**且**不发布** `session.opened`/`session.config`/
  `session.ready`（修复前这三条照发，界面显示已就绪而 daemon 已关掉它）；**(b)** 同一 provider
  id 在第一次 open 还没结束时被重新绑定到**另一个** native 会话（Paseo 用新 agent id 重开导入
  会话就是这形状），第二次必须被拒（"another open for this provider session is already in
  flight"），且该 provider id 只发布一次 readiness。**(a) 的 hold 在 `session/close`、(b) 的在
  `paseo/commands`**，所以它们同时覆盖"close 使进行中的 open 失效"与"provider 身份也是排他的"。
  **动了 `provider.ts` 的 `#openTransaction` / `#assertOpening` / `#openingProviders`，或假桥的
  `DSH_FAKE_HOLD_*` 必跑；open 发出的 `session.config.modes` 必须与 catalog 的 modes 全等（单源）。**
- `harness/session-state-check.cjs` — 会话状态机（真实编译 `DshSession` + 假传输，不 spawn、
  不读凭据）：`#turnId`/`#turnStarted`/统计 reset、`configure` 的提交顺序与回执回读（被拒不落
  本地值）、切模型后 `thinkingOption` 回写、`DshSessionOptions.modes` 单源、子会话 opened/label
  闸门、`DshChildSession.fail` 守卫、prompt 在 running 后失败仍有回合终态。**动了
  `server/session.ts` 的回合状态、`configure` 的提交顺序/回执回读、`DshSessionOptions.modes`、
  子会话 opened/label 闸门或 `DshChildSession.fail` 必跑。**
- `harness/mcp-gateway-guard-check.mjs` — gateway 的 `tool` 参数守卫（`resolveTargetTool`，模块
  私有，所以驱动真实的 `apply()` + `defineTool` 注册路径，用 loopback 假 server 接住本该成功的
  调用）：空串与纯空白、把网关自己的元工具名当目标（含大小写变体、零宽字符、CJK 键盘打出的全角
  写法）或把 `archive_subagents` 当目标、把整个 `mcp_call_tool` 折进另一调的 `arguments`，都必须
  **在请求发出前**被点名拒绝并说出期望形状（被拒的用例不能到达 server）；正常名放行并拿到真
  schema，padding 被 trim 后才转发（trim 是便利不是绕过）；未知但合法的名字保留自己的错误、不与
  守卫的错混成一条（两种失败不能塌成同一句话）；schema 路径与 call 路径共用守卫所以都要守，非
  字符串目标由 schema 拒绝、报错措辞要断言在 schema 上（只断言"抛了且没回显"在守卫被删后仍成立，
  等于覆盖不到那个缺陷）。纯离线，只走 loopback；`@deepseek-ai/schemastery` 与 `dsh-tools` 按
  绝对路径从 DSH 安装目录加载（`DSH_PACKAGES_DIR` 可覆盖）。**动了 gateway 的
  `resolveTargetTool` 守卫或元工具注册必跑。**
- `harness/mcp-gateway-call-check.mjs` — `mcp_call_tool` 的结果投影与取消穿透：`structuredContent`
  保留、文本为空时以 JSON 渲染、`CallToolResult` 的畸形形状（非数组 content、非布尔
  `isError`、task 结果）响亮拒绝、`exec.signal` 贯穿到 HTTP socket / stdio
  `notifications/cancelled`、取消后不投影不落盘。**动了 `dsh-bridge/lib/mcp-gateway.js` 的
  `mcp_call_tool` 结果投影或 `exec.signal` 转发必跑。**
- `harness/transport-frame-check.mjs` — 桥的**入站**分帧器（`dsh-bridge/lib/transport.js` 的
  `#onData`）：一个桥进程服务所有会话，所以这里一次 O(n²) 扫描会卡住全部会话（13 MiB 图片帧
  曾阻塞事件循环 2.2 s）。20 MiB 帧跨数千个 16 KB chunk 逐字节还原、一个 chunk 里的多帧按序
  到达、被 chunk 边界切断的帧重组、空行跳过、`\r\n` 保留 `\r`、尾部残行滞留、畸形行报错后
  后续行仍到达，并用**旧实现当 oracle** 跑随机分块（相等，不是"差不多"）+ 耗时对照。纯模块：
  `transport.js` 只 import `node:string_decoder`，所以直接 require 真实文件而不是抄一份。
  **动了 `#onData` / `#dispatchLine` 或 `#partial` 的分帧机制必跑（含未终止帧上限/溢出语义）。**
- `harness/bridge-server-check.mjs` — 桥 server 本体（`dsh-bridge/lib/server.js`）的只读路径，
  用模块解析钩子把 `@deepseek-ai/*` 映到 DSH 安装目录后**驱动真实类**（假桥只能证明协议形状，
  证明不了 server 自己的副作用）：`usage()` 不得复活已关闭的会话（`closedSessions` 闸门；
  重新 initialize 过的与恢复会话的首次查询仍必须创建）、两处归档状态读取失败要**点名原因**
  （服务缺失每进程一行、读取抛错每次一行，策略不变）、`paseo/permission/set` 必须真的到达一个
  方法上（3047948 删了 `setPermission` 却留下 `case`，权限预设从此静默不生效），以及
  **`handleRequest` 的每个 `case` 调用的方法都必须在原型上**——那正是该回归的形状，任何行为
  断言都看不出来。**依赖本机 DSH 安装，所以不进 CI**（`DSH_PACKAGES_DIR` / `DSH_INSTALL_DIR`
  可覆盖，解析失败 exit 2 并打印实际目录）。**动了 `server.js` 的请求分派或这些只读路径必跑**；
  **另外，凡动了 `server.js` 的请求分派、会话生命周期（`prompt`/`cancel`/`createSession`/
  `closeSession`）、`listSessions` 或持久化读取区段也必跑**（新增断言覆盖 queued plan 双向
  应用、query/cwd 不做窄预过滤、persistence signal/迟到句柄、冷会话创建中 cancel）。
- `harness/model-route-check.mjs` — 桥的**实时模型/思考档切换**是否真的到达 DSH（0.2.1/0.2.2
  双契约）：DSH 0.2.2 把 `installModelSelection` 改成单参（只装切换提示监听），实际路由由
  `agent.model.select()` 写入 durable `model/selection` 投影；旧桥还传第二参并只改
  `control.selection.current`，于是 `paseo/config/set` 回执成功、下一步仍跑旧模型——静默能力
  丢失（FIELD-NOTES #58 同类：doctor 全绿、功能消失）。0.2.1 仍是两参 + caller-owned ref，
  所以桥必须用 `installModelSelection.length >= 2` 在运行时分流：旧线走两参并继续依赖
  `control.selection`，新线走单参 + `agent.model.select`；live `configSet`/`initialize` 在
  `agent.model?.select` 不存在时只更新 ref（0.2.1），存在时才 select。断言：对已 live 会话
  `paseo/config/set` 必须让 recording agent 的 `model.select` 收到完整新 route（只改内存镜像
  不算通过）、`reasoningEffort:null` 以省略键清空、`maxTokens` 不进 selection 但保留在
  pinned route、`model.select` 抛错时请求必须失败且两处镜像都不更新（不假装成功）、
  `initialize` 的 live 分支经 `agent.model.select` 应用路由且在写路由表之前、`createSession`
  分流两支的源码守卫、**queued→resume**（先 `config/set` 到未物化会话、再用真实 `AgentModel`
  的旧持久 selection 触发 resume，新 route 必须覆盖旧值）、无 `agent.model` 的 0.2.1 live
  路径只更新 caller-owned ref。模块解析钩子驱动**真实** `server.js`（同 `bridge-server-check`）。
  **依赖本机 DSH 安装，所以不进 CI**（`DSH_PACKAGES_DIR` / `DSH_INSTALL_DIR` 可覆盖，解析
  失败 exit 2 并打印实际目录）。**动了 `server.js` 的 `installSelection` / `configSet` /
  `initialize` live 分支 / `createSession` 的 initial route 应用或 DSH 升版后必跑。**
- `harness/session-title-adoption-check.mjs` — Paseo 的 agent title 透传成 DSH session title
  （桥这一半）：Paseo 给自己的 agent 起名（UI 显示的就是它），经 `config.title` → 插件 → 会话的
  `initialize` 帧 → 桥记住并 `sessionTitle.rename()`。DSH 标题服务只从人类 `user` 消息派生标题，
  而 Paseo agent 的首条消息是宿主信封，所以没有透传时 DSH 会话列表显示未命名。断言：`initialize`
  带 title 后**新建分支**与 **resume 分支**都写到 live session（且是同一个 Session 对象）、重开时
  标题相同不重复 append、无 title 不写、非字符串/空串/纯空白 title 忽略而不报错、已有不同标题被
  Paseo 名字覆盖、title 按会话隔离且进程级 `initialize`（无 sessionId）不会命名任何会话、标题服务
  缺失 / `rename` 拒绝只写 stderr 且会话照常打开。模块解析钩子驱动**真实** `server.js`
  （同 `bridge-server-check`）。**依赖本机 DSH 安装，所以不进 CI**
  （`DSH_PACKAGES_DIR` / `DSH_INSTALL_DIR` 可覆盖，解析失败 exit 2 并打印实际目录）。
  **动了 `server.js` 的 `initialize`/`applySessionTitle`/`createSession`，或插件侧
  `provider.ts`/`session.ts`/`dsh-process.ts` 的 title 透传必跑。**
- `harness/bridge-entry-check.mjs` — 桥入口 `dsh-bridge/lib/index.js` 的 `startBridge` 工具
  生命周期接线（模块解析钩子把 `@deepseek-ai/*` 换成 stub，加载**真实**入口）：`tools/execute`
  → `beginFileMutation` → `captureFileBeforeTool` 的顺序、`post-execute` → commit/finish、
  `tools/result` → drop/finish、失败路径；另覆盖 `settings/document-updated` →
  `paseo/settings/changed` 的接线（已暴露 ns 转发、未暴露 ns 不转发、effect dispose 后不再
  转发）；纯离线、无需 DSH 安装。**动了 `dsh-bridge/lib/index.js` 的 `startBridge` 工具生命周期
  接线（`beginFileMutation`/`captureFileBeforeTool`/`commitFileTool`/`finishFileMutation`/
  `dropFileTool`/`rememberToolDescription`）或 settings 事件订阅必跑。**
- `harness/assistant-retry-check.cjs` — 同一 `turn/step` 内**重试**的助手文本：DSH 在已经流出
  文本后失败重试，第二个 attempt 从空快照重新增长，而 Paseo 对"不是前缀的快照"的规则是整段
  追加——旧行为把两次 attempt 的文本粘成一行，读起来像模型语无伦次。断言两次 attempt 拿到不同
  item id（首个保持历史的 `assistant:1:1`，第二个 `assistant:1:1:2`）、durable `assistant/message`
  落在**第二个** id 上（答案只出现一次）、逐字复刻宿主折叠规则后最终答案恰好一行、第一个 attempt
  的行仍独立存在、reasoning 同样带后缀。假桥 `DSH_FAKE_MODE=retry` 驱动，下面全是真实插件。
  **动了 `server/timeline.ts` 的 attempt 后缀或桥的 `paseo/assistant-delta` 载荷必跑。**
- `harness/process-crash-check.mjs` — 大帧写向一个**已经死掉**的共享子进程：`stdin.write` 的
  EPIPE 是异步 `'error'` 事件，`#send` 的 try/catch 看不到，没有监听就是 uncaught exception →
  整个插件进程退出 → 该连接上**所有**会话一起断。断言：>256 KB 的帧打给死子进程时测试进程
  没有 uncaughtException、请求**立刻**失败（远早于 120 s RPC 超时）而不是悬挂、失败可见（经
  `onProtocolError` 或 reject，绝不静默丢），并带"子进程活着时同一路径正常"的正对照。
  **动了 `dsh-process.ts` 的 `#start` / stdin 写入、`#failAll`、`#request`/`#pending` 或出站队列必跑。**
- `harness/child-crash-check.mjs` — 共享子进程在**子代理回合中途**死掉：`#exitAll` 只覆盖
  attach 过的根会话，原生子代理不在那张表里（视图在 `DshSession.#children`），而
  `DshChildSession` 原本没有任何失败通道——子代理行会永远脉冲"运行中"、它持有的提问卡永不
  结算。断言：子会话确实在回合中（正对照）、子视图收到点名**子会话 id** 的
  `session.runtime_failed`、根也收到自己的、**子先于根**（宿主把 `runtime_failed` 当该会话的
  终态，后发的会被丢）、子会话不补编一个 `session.turn` 终态。崩溃由脚本自己 `SIGKILL` 假桥
  记录的 pid 制造（不给假桥加场景）。**动了 `session.ts` 的子会话终态或 `dsh-process.ts` 的
  进程退出扇出必跑；回归同时钉住「已完成子会话不被进程退出改写为 failed」。**
- `harness/local-patches-check.mjs` — `local-patches/` 的纯离线检查（spawn 真实 apply/check
  脚本，`REWIND_PATCH_TURNID_TARGET` / `REWIND_PATCH_HOME` 全指向临时 fixture，不读写已安装
  宿主）：turnId 补丁在 0.15 形状 fixture 上打上/幂等/备份落在补丁目录；半打、锚点失配、
  上下文失配三态都 fail closed（文件 byte-identical、checker 不报「跑 apply 就好」）；stale
  体重建（重建结果必须等于干净重打，prestale 快照落在补丁目录）；stale 不可重建时 checker 与
  `apply --check` 同源判 `stale-body-unrebuildable`、apply 真的拒绝（LP-02：门禁与实现一致）；
  **变异见证**——「markers 2/2 但重放调用不带 turnId」必须被判 `stale-body` 而不是 patched
  （只数 marker 的旧判据在这份 fixture 上是绿的）；`--revert` 复原与幂等、target 缺失的
  exit 1/3。**动了 `local-patches/apply-rewind-history-truncation.mjs` 或
  `local-patches/check-rewind-patch.mjs` 必跑。**
- `harness/fake-dsh-bridge.mjs` 的**默认行为变严**：`session/prompt` 现在按会话校验
  `initialize`（文案与真桥一致），漏发 `initialize` 的插件 bug 不再在假桥上一路全绿——`f084c33`
  那个「每个会话都能打开、第一次提问必失败」的缺陷当初就是这么漏过去的。**严格是诚实默认**；
  只有刻意测 `initialize` **之下**协议层的脚本（目前仅 `fake-bridge-multi-check.mjs`）显式
  `DSH_FAKE_ALLOW_UNINITIALIZED=1` opt-out，并在自己的调用点写明理由。另有 `mcp-late` 场景：
  `paseo/mcp/set` 像真桥那样**抛错**（不是回 `mounted: false`），钉住插件把"会话已建好之后
  再设 MCP"失败成 `request.failed` 而不是静默成功。长驻子进程的场景切换用
  `DSH_FAKE_MODE_FILE`（spawn 时的环境已冻结，改 `DSH_FAKE_MODE` 对已在跑的 child 不可见）。
- `harness/source-shape.cjs` — **不是独立检查**，是几个必须读 `.tsx` 源码的检查共用的
  **TSX 结构读取器**：解析 JSX 开标签及其属性，让"这个元素自己测布局""图标按状态与可编辑性
  取色"这类只存在于 JSX 里的接线也能断言。它取代的是按格式匹配的正则——换行、属性顺序、单行
  写法都能让组件仍然正确却让正则变红，误报一次就会把后来的真回归放过去。故意不是通用解析器
  （无嵌套树、标签内注释、属性表达式里的模板字面量），读不出来就**跳过而不猜**（fail closed）。
  **动了它的 JSX/调用读取规则必跑所有 `require` 它的检查**（`grep -l source-shape harness/*`
  看当前集合，别按记忆列名单）。

## 2026-11-03 补齐的登记

下面这些脚本此前没有条目（撤回链的 12 个与 4 个假桥脚本只在 `AGENTS.md` 有一行命令，5 个
`p003-*` 两处都没有索引，`plugin-check.cjs` 与 `route-test.mjs` 只按 basename 被提及），本轮按
各自文件头注释补齐。撤回链的执行顺序另见 `AGENTS.md`「撤回（rewind）」一节；这里只写断言与
触发条件。

### 撤回链（离线）

- `harness/revert-check.mjs` — 桥的撤回规划与接线：只有 `user/message` + `source.kind="user"`
  才是撤回目标（注入的 user-role 消息永不解析）、区间取自 `session.surface.nodes`（compacted
  或已撤回的消息拒绝）、令牌解析与前置条件、回执形状、文件层、**canary 先于
  `request.completed`**、共享子进程接线；接线部分编译插件后用真实 `DshSession` + 假进程传输
  做行为断言，不是源码正则。**动了 `dsh-bridge/lib/revert.js`、`provider.ts`/`session.ts` 的
  撤回分支或 `server.js` 的 revert 事务必跑。**
- `harness/surface-check.mjs` — 重放折叠（`dsh-bridge/lib/surface.js`）：只折本桥撤回缝
  （空 `system/message` 替换，含被撤回合的尾随日志事件）、compaction 的 `user/message` 替换
  不折（折了会丢用户已读的对话）、DSH 系统提示维护不折、无法对当前 surface 解析的替换不改变
  任何东西（绝不猜）。**动了 `surface.js` 或 `replayHistory` 的折叠必跑。**
- `harness/file-snapshot-check.mjs` — 撤回的文件层（`dsh-bridge/lib/file-snapshots.js`）：写前
  状态按工具调用捕获、成功才提交；目标之后新建的文件被删、改过的恢复最早 post-target 内容、
  没动过的不碰；从未被编辑工具碰过的 bash/用户改动永不记录；`str_replace_editor` 只认写命令；
  恢复前 rescue；一条路径失败不打断其余；同一路径两次捕获按读到的字节顺序排序（含第一次读被扣住时）。
  **2026-11-07 方案 B：边界重扫 reduce/reconcile 与 114 条断言**（2026-11-07 返工：symlink
  不跟随、旧 journal 排序口径、boundary 判别力增强）：每条人类 `user/message` 对
  journal 已存在路径先 `lstat`、普通文件直接 `readFile`（`O_NOFOLLOW`）后内容比对（最新记录按
  `captureSeq`，旧行按文件序），变化则记
  `origin="boundary"`、anchor=`该消息 seq` 的 pre-image，bash/外部进程对已跟踪文件的改动因此
  进入后续撤回的 pre-image；纯 bash 未跟踪文件仍不处理；非普通文件 / 超 8 MiB / 读失败记
  `skip` → `unrecoverable`。**本轮补的失败面**：读后捕获失败（objects 建不了 / 对象写失败 /
  父身份 realpath 失败）与 journal 写不进都落 skip/unrecoverable 并进回执（不再报「这条消息
  之后没有改动文件」）；损坏对象（截断或同长度哈希不符）不写回用户文件、不产生 rescue；
  写已原子落盘后被判 `isError` 仍落 journal 行（会话关闭路径在 dispose 之后结算）；并发
  `planRestore` 等得到另一个调用者正在结算的关闭快照（R4）；`isError` 变更判定先比长度、
  长度相同才读哈希（R1）。**动了 `file-snapshots.js` 的
  capture/commit/restore/journal/GC/reconcile/trackedPaths 或 `server.js` 的关闭与回执接线必跑。**
- `harness/snapshot-lifecycle-check.mjs` — 捕获序号必须跨进程重启续数：第二个实例接着第一个
  的编号、跨该边界的撤回仍恢复原始 pre-image；并行父子捕获顺序反转仍取最早捕获；失去又拿回
  写者身份的进程重读 `beginOwner` 高水位；旧 journal（无 `captureOrderVersion`）有歧义时
  `planRestore` 拒绝而不是猜，并保留 journal 与备份作为证据。**动了 `FileSnapshots` 的序号/
  所有权或 `planRestore` 的 journal 版本判定必跑。**
- `harness/file-mutation-gate-check.mjs` — 根作用域文件写入闸门：`freeze` 排空在飞写入并挡住
  新写入、释放后按序准入且 map 归零；排队写入被 abort 后不泄漏 waiter；超时的 `freeze` 重开
  准入（否则一次慢写入会永久拒绝该会话后续编辑）；根之间互不影响；同根第二次 `freeze` 被拒
  而不是排队。**动了 `file-mutation-gate.js` 或撤回的 freeze/drain 接线必跑。**
- `harness/factory-ownership-order-check.mjs` — `beginOwner` 的接线：真实
  `PaseoHarnessServer.createSession` 必须在 factory 的 `setup` 里、第一笔捕获之前为会话续读
  journal 高水位，且序号尊重别的进程已推进的高水位（`snapshot-lifecycle-check` 只证明机制、
  证明不了桥用了它）。**依赖本机 DSH 安装，不进 CI；动了 `server.js` 的 createSession 接线或
  `FileSnapshots.beginOwner` 必跑。**
- `harness/rewind-merge-check.mjs` — 父子文件归并（`snapshot-owners.js` / `child-anchors.js` /
  journal 归属）：子与孙都解析到根、断链 fail-open、子编辑落根 journal 且子无自己的 journal、
  独立会话树不交叉、孙锚定在直接父正在跑的回合而不是根最新消息。**动了 `rootSessionFor` /
  `recordDelegatedTurn` / `observeDelegatedTurn` / `snapshotAnchorFor` 必跑。**
- `harness/revert-shape-probe.mjs` — 撤回写本身的真实 DSH 形状（纯内存离线，用本机已装
  `@deepseek-ai/dsh-session`，`DSH_SESSION_MODULE` 可覆盖路径）：空 `assistant/message` 替换
  必被拒（曾导致每次真实 append 抛错）、`system/message` + 空内容 + `sourceEventSeqs` 被接受、
  被撤回合离开 `surface.nodes`/`deriveMessages()`、marker 不进上下文、原始日志只增不删。
  **改了替换事件形状必跑。**
- `harness/replay-fidelity-probe.mjs <session.v4.jsonl.zstd>` — 用真实多帧 zstd 会话日志跑同一
  折叠：人类转写必须全部重放，本桥撤回缝只丢自己那一段；日志只读，解不开要报错、不静默当空。
  **动了 `surface.js` 的折叠或 DSH 日志形状必跑。**
- `harness/rewind-e2e.mjs` — 真 `dsh --profile paseo` 的 3 回合端到端（耗 token，默认一次性
  `DSH_HOME`）：替换写入、重放折叠、文件回退、原始日志无 `command/run`、模型只记得 ALPHA 不
  记得 BETA。**动了撤回任一层、要出包前必跑。**
- `harness/rewind-merge-e2e.mjs` — 真机父子归并（耗 token）：父写 + 子代理写 → `both` 撤回 →
  两个文件都删、根 journal 两行、子会话无 journal。**动了父子归并必跑。**
- `harness/rewind-native-check.mjs` — 经真实 daemon 的撤回（`agent.rewind.request`，耗 token，
  必须 `--allow-real-daemon`）：被撤消息消失、provider session id 不变、撤回期间无 loading、
  后续回合看不到被撤内容。它走宿主 `agent-manager.rewind()`，桥的离线脚本到不了那一层。
  **改了宿主侧撤回行为后跑，跑完人工核对真机六步。**

### 假桥驱动的插件层回归

- `harness/steer-check.cjs` — 插话回执（假桥 `DSH_FAKE_MODE=steer`）：running 状态先于 prompt
  回执（真 DSH 的顺序）；只有 prompt 结果是 `steer` 且 `turnId` 等于宿主绑定的回合才算送达，
  否则回退取消+替换（复刻宿主 `steerOrReplaceActiveTurn`）；每帧进 `DSH_FAKE_LOG`，断言打在
  协议边界。**动了 `session.ts` 的 steer 分支或 `provider.ts` 的插话转发必跑。**
- `harness/mcp-injection-check.cjs` — Paseo 注入的 MCP server 必须真的到 DSH：per-session
  `paseo/mcp/set { sessionId, entries }` 帧、HTTP 与白名单 stdio 走 gateway、非白名单 stdio
  仍原生、legacy SSE 按名字拒绝。**动了 `mcpEntries()` / gateway 分派 / `paseo/mcp/set` 必跑。**
- `harness/assistant-stream-check.cjs` — 助手文本流式（假桥 `DSH_FAKE_MODE=stream`）：一步内
  多个增长快照、同 id 且 `messageId` 相同、durable `assistant/message` 落在同一 id、
  reasoning 同样；按 Paseo 自己的两条折叠规则投影后每类恰好一行。**动了流式
  （`agent/assistant-stream` / `paseo/assistant-delta`）必跑；真实端到端另跑 `stream-probe.mjs`。**
- `harness/image-check.cjs` — 图片工具结果（假桥 `DSH_FAKE_MODE=image`）：带 `hostPath` 的图片
  块恰好多出一条 markdown `assistant_message`、路径逐段编码、无 `hostPath` 不出行、过
  `ProviderEventSchema`、`history: "replay"` 重建同一条。**动了图片块翻译必跑。**

### 真实 profile / 诊断工具

- `harness/plugin-check.cjs` — 插件层总检（驱动真实插件，无 daemon）：`session.usage` 真实
  计数与 turn id、非文本内容块到达 DSH、不支持的输入类型 `request.failed`（不是
  `request.completed`）。默认一次性 `DSH_HOME`（克隆源 profile），`--allow-real-profile` 才用
  live home；`--self-test` 只验证编译产物加载与图片块翻译。**动了插件层必跑（含真实模型回合，
  耗 token）；改判据后先跑 `--self-test`。**
- `harness/route-test.mjs` — 逐条路由跑真实回合，按终态分类 WORKS/FAILS/TIMEOUT/CANCELED/
  EMPTY（不按"有没有文本"判），全部 WORKS 才 exit 0；默认一次性 `DSH_HOME`。**动了 catalog/
  路由，或要选模型前跑（耗 token）。**
- `harness/catalog.mjs` — 用 `dsh --profile` 自己报的 catalog 列出 provider / 模型 / 每个模型
  的真实思考档位（诊断工具，读真实 profile，不起回合）。**怀疑「模型列表为空 / 档位不对」时
  先跑它。**
- `harness/probe.mjs` — 不经 Paseo、直接驱动 `dsh --profile paseo` 的 JSON-RPC 端到端：initialize
  → 提问 → 提问卡（`paseo/question`）→ `paseo/plan/get|set` → `paseo/config/set`，帧落
  `frames-probe.jsonl`。**桥单独排障、改提问卡/plan/思考档位必跑（耗 token）。**
- `harness/stream-probe.mjs` — 真实 `dsh --profile paseo` 的流式端到端：多个
  `paseo/assistant-delta` 早于 durable `assistant/message`、快照单调增长、最后一个覆盖全文、
  首帧远早于 durable；默认一次性 `DSH_HOME`。**动了流式必跑（耗 token）。**

### p003 组（真实 DSH 的 approval / projection 契约）

- `harness/p003-live-support.mjs` — **不是独立检查**：p003 组共用的一次性 `base+bridge` profile
  构造器（用你已有的 route/凭据，不写 live profile、不改已装 DSH）。
- `harness/p003-bridge-check.mjs` — 真实桥模块 + 记录型 transport：controller/live projection
  语义（结果与 `AbortSignal` 原样透传、真实 snapshot 语义、不创建 agent/不缓存）、cold read
  关闭观察、projection 失败与取消要响亮、`bridge dispatch` 的键选择与畸形/未知键拒绝、prompt
  注册与 scope、审批 waterfall（外来请求下传、自己的请求回 DSH 词表）、超时/撤回/畸形应答、
  回合取消穿透到反向请求。无 profile/模型调用。**动了 `approval.js` /
  `session-projections.js` / prompt 注册或 projection 读取必跑。**
- `harness/p003-permission-check.cjs` — 真实 `DshProcess` + `DshSession`、只把 stdio 对端换成
  脚本：权限卡的请求-回执生命周期（deny/allow 行为、resolved 计数、超时/取消的响亮失败与
  notice、重复应答、会话关闭时在飞权限卡的结算）；不起模型/daemon。**动了权限卡翻译或
  `respondToPermission` 的接线必跑。**
- `harness/p003-approval-preflight.mjs` — 真 DSH + 无害模型调用：断言 `approval/asked` →
  `approval/decided` 的真实配对与拒绝路径，且 `never` 策略绕过 answerer。**耗 token；动了审批
  接线后跑。**
- `harness/p003-live-check.mjs` — 真实插件 + 真实 DSH + 配置的模型：per-session systemPrompt
  到达模型且 A/B 隔离、取消撤回真实审批后会话仍可用、真实 workflow/goal 行快照、后台工作流
  跨回合、重开后重放同一终态、冷 projection 读取（含未知键拒绝）、所有事件过
  `ProviderEventSchema`（一次性 profile/session 状态）。**耗 token；改了 activity 投影/
  持久化/事件形状必跑。**

### 本轮新增（2026-11-03）

- `harness/doctor-live-check.mjs` — 真 `dsh` 的 doctor 契约回归（DLV-01/02/03）：一次合规安装
  + 每个缺陷（凭据缺 `version: 1` / 0644 / 非法 ref 名、补丁 `name` 写错被 DSH 跳过、profile
  缺 `package.json`、`bundles` 不含桥）都断言 doctor 的判定与退出码，并用
  `dsh --profile <p> --dump-config` 与 DSH 自己的 `parseCredentialsDocument()` 交叉验证夹具就是
  它声称的形状。**真 DSH、不耗 token、不碰 daemon、不写真实 `~/.dsh`；不进 CI**（CI 没有 DSH
  安装）。动了 doctor 的 profile/补丁/凭据检查或 DSH 升版后必跑。
- `harness/dsh-binary-check.mjs` — 显式 `DSH_BINARY` 不可用时不得静默回退到 PATH 上的 `dsh`：
  不存在的路径、不可执行的文件、目录都让 `start()` 点名失败且**不 spawn**；未设置时保持历史
  行为（`spawn("dsh")`）；有效路径逐字使用（阳性对照）。编译插件后把 `child_process.spawn`
  换成记录器，红态（回退）也不会真起 `dsh`。**动了 `resolveBinary()` 或 `DSH_BINARY` 语义必跑。**
- `harness/subagent-history-check.cjs` — 子代理 `paseo/history` **抛错**必须与
  `available:false` 对称：发「子代理历史读取失败」notice、丢掉回放窗口内为该子会话缓冲的帧
  （判据是第二次成功回放后那帧不出现；同一帧正常回放的行 `REPLAYED-H` 必须出现，否则"没出现"
  可能只是回放没跑）。真实 `DshSession` + 假 `DshProcess`，不 spawn、不连 daemon、一次性
  `DSH_HOME`。**动了 `session.ts` 的 `replaySubagents` 失败分支必跑。**

上面清单之外还有四个容易被当成同类、其实不是的：`harness/tools.mjs`（真 `dsh` 的工具目录
转储）、`harness/subagent-live.mjs`（实机子会话可见性）、`harness/fake-dsh-bridge.mjs`
（上面几个假桥脚本共用的 scripted 替身，不是独立检查脚本），以及
`harness/session-calls.mjs`——**诊断工具，不是回归**：它读 `$DSH_HOME/sessions` 下的会话
日志，把每个 `tool/call` 的参数**键**与同一会话里 `request/header` 真正下发给模型的 schema
做 diff，报出未声明的键并以 `exit 1` 结束；有调用查不到 schema（或参数不是 JSON）时
`exit 2`，不把"没检查"当干净。用来回答"我到底发出去了什么"：界面和模型读到的
转写都是渲染，不能当证据。它刻意绕开两个坑——会话日志是**多帧** zstd
（`zlib.zstdDecompressSync` 只解第一帧，会把 1.6 MB 的会话读成 172 字节的头部），以及
**绝不静默跳过**解不开的文件。用法：`node harness/session-calls.mjs --list` /
`--latest` / `--session <id>`，可再加 `--tool <name>`、`--raw`。

## 目标（goal）链（2026-11-03）

五个脚本覆盖 goal 的三层：桥的 `paseo/goal`、插件的两个 RPC 与 pill 数据层/面板渲染、时间线续跑行。
设计见 [GOAL.md](./GOAL.md)，摸底见开发期的 `goal-survey.md` A–F 节（不随仓库分发）。
断言数均为回填时实跑值。

- `harness/goal-bridge-check.mjs` — 桥的 `paseo/goal` 读取路径（真 `PaseoHarnessServer` +
  假 `goals` 服务；不 spawn `dsh`、不读 profile、不起模型），**15 条**：live agent 的
  `GoalView` 原样透传（含 `activation`）、无目标 `{goal:null}` 而不报错、`goals` 服务未挂载
  **抛带说明的错误**（插件据此判终态 `goal_unavailable`）、未知/未打开会话保留
  `requireSession` 错误且**不物化会话**、`handleRequest('paseo/goal', …)` 真的被 dispatch。
  **依赖本机 DSH 安装**：按 `bridge-server-check` 的方式从全局安装解析 `@deepseek-ai/*`
  （`DSH_PACKAGES_DIR` / `DSH_INSTALL_DIR` 可覆盖；没有 DSH 的机器 exit 2，不进 CI）。**动了
  `dsh-bridge/lib/server.js` 的 `paseo/goal` 或 dispatch 必跑；改桥后先重生成内嵌桥
  （`node paseo-plugin/scripts/generate-bridge-assets.mjs`）再跑 `bridge-assets-check.mjs`，
  否则真机检查跑在旧桥上假绿。**
- `harness/goal-pill-check.cjs` — goal pill 与行式面板的**数据层与 UI 规则**（**367 条**；2026-11-08 seen 持久化共 85 条（39 条首轮 + 34 条 P2 返工：invalid 文档 reset 修复、连续 conflict 只 warn 一次、真实 defineSettings 定义 id/scope/version 与归一、两 pill 各自引用正确 id 的源码钉 + 12 条收尾：reset 与 read 共用超时门禁（reset 挂起/抛错都不阻塞 hydrate，ready=true 空表）、reset conflict 后下次 save 自愈合并保留他 agent、conflict 重试成功 warns=0）：确认关闭把 `agentId: id:revision` 写进假 settings 文档 → 同一文档新建 controller（= app 重启）hydrate 后同签名隐藏、新 revision 可见、读失败退回可见且不抛、写失败不抛且本会话仍隐藏、conflict 重读合并保留他 agent、无声宿主超时降级、remove 后 forget 干净重加、64 上限与 sanitize；源码钉：唯一写点在 `advanceSeen` 的 confirmed-close 分支、`publishState` 与轮询模块无写、启动 hydrate、hydrate 前不 present、两个 settings 均在 index.server.ts 注册且有老宿主降级；2026-11-05：运行时图标钉改为「`CornerRingIcon` 保留底图标、不出现裸 `StatusRingMark`」，新增 8 条「目标与后台是两颗独立 pill」源码钉——goal 只注册 `dsh-goal`、jobs 只注册 `dsh-jobs`、各开各的 popover、关闭目标 popover 记完成态已读、入口各自 contribute、没有共用 slot 协调器且其模块已删；2026-11-06 新增入口源码钉：`contributeJobsPill(client, deference)` / `contributeGoalPill(client, deference)` 与唯一的 `const deference = createPillDeference()`；
  假时钟 + 假 RPC + 假目录页，不 import React/host；UI 规则都抽在 `client/goal-polling.ts` 的
  纯函数里）：契约枚举与 wire schema（`GoalState` 缺 `activation` / `id` / `revision` 必拒，时间戳仍被剥掉）、
  `goalCommandArguments` 的 DSH 语法、五态可见性/label/tone（**complete 未读可见、tone success、已读（同 `id:revision`）隐藏、
  新 id 或新 revision 重新可见、已读键只隐藏 complete**；`goalIconName` success→`CircleCheck`、余→`Target`；
  `goalIconColorToken("success")`→`statusSuccess`）、**pill 文案**（`goalPillCopy` 用真实 locale 表：五态×中英 label 与 title
  都是「目标」/「Goal」；`goalStateName` 五态完整状态名）、**完成态已读状态机**（`goalCompleteSeenStep`：完成当轮
  running→idle 不算已读、下一回合 running（发下一条消息）也不算已读、首次观察时已 idle 也不起步、关闭完成面板即已读、非 complete 面板关闭不算、
  已读键跨轮询保持、新 revision 重新观察且显示、清除留已读键、端到端：下一条消息后仍可见、关闭后隐藏）、**面板去向**（`goalPanelNext`：编辑取消/Esc→close、
  保存成功→close、保存被拒→stay、清除页取消→view、其它控制成功→view、被拒→stay）、面板行几何取宿主值（`goalTrackRow` 32/40、确认页行尾 `goalConfirmControls`（红钮 32/24、手机行尾比 view 页至多宽 8px）、防误触常量（武装 400ms、未武装 0.35/0.86、过渡短于武装、按下 0.85）、
  `goalIconButton` 20/32、鲸鱼 16、环框 14 偏移 -5）、facts 行（`goalFactsLine`：
  「进行中 · 第 N 轮 · 预算 M」，**`active + disarmed` 以「未在续跑」/「Not continuing」开头**）、
  运行环真值表（`goalRunningMark`：armed+running 才转、idle 后保持 `GOAL_RUNNING_HOLD_MS`=1500、
  disarmed/paused/blocked/complete 与读不到状态都不转、保持边界）、图标 tone→token
  （`goalIconColorToken`：`foregroundMuted`/`statusWarning`/`statusDanger`）、编辑页空草稿与
  未改动草稿都不可保存（`goalEditDraftValid`/`goalEditSubmittable`）、**编辑框（小号 composer）**
  几何（圆角 16、内边距 8/12、gap 12、距边 8、✓ 28、禁用 0.5、2–6 行）、`goalEditorType`
  （web 15/21、原生 16/22）、`goalEditorHeight` 夹取（未测量/NaN→2 行、12 行→6 行、小数向上取整）、
  `goalEditKeyAction` 真值表（桌面 Enter 保存、Shift+Enter / 组字中 Enter / 手机 Enter 都不保存、
  Esc 取消）、trigger 与面板接线（registration 走 `goalPillCopy`、静态 glyph 是 `Target`、没有填充
  按钮组件、旧 footnote 与旧「保存」菜单行已删、清除页无菜单行/分隔线、错误一律走 `ControlError`、按键走 `goalEditKeyAction`）、节奏常量与
  jobs 逐字一致（4000/30000/1000/2000）、控制器行为（答案签名去重、瞬时错误保持、终态停表、
  退避、`pollNow`、provider/workspace 过滤、closed 移除）。运行：
  `cd paseo-plugin && npx tsc -p ../harness/goal-pill.tsconfig.json`，写入
  `.dbg-goal/package.json`（`{"type":"commonjs"}`）并拷入本脚本，再在 `.dbg-goal` 里
  `node goal-pill-check.cjs`（`goal-pill.tsconfig.json` 一并编译 `client/locale.ts`，供文案断言用真实表）。**动了 `client/goal-polling.ts`、`client/goal-popover.tsx`、
  `client/goal-pill.tsx`、`client/goal-running.tsx`、`client/deepseek-mark*.tsx`、
  `client/agent-polling.ts`、`shared/goal.ts` 或 `client/locale.ts` 的 goal 表必跑；改共享轮询器时
  `jobs-poll-check.cjs` 必须同时全绿且断言数不减。动了 `client/seen-close-gate.ts` 必跑。
  动了 `client/seen-persistence.ts` / `shared/seen-settings.ts` / `shared/goal-seen-settings.ts` 必跑。**
- `harness/goal-popover-render-check.cjs` — 面板的**渲染行为**（**258 条**；2026-11-05 新增：真实 `contributeGoalPill` + `contributeJobsPill` 对假宿主——一个 agent 恰两个注册 `dsh-goal`/`dsh-jobs`、各自 popover、update 不带 behavior、两者同时可见、后台文字恒为「后台」且任何 patch 不含数字、后台跑完只隐藏后台不碰目标、registry 读不到显示静态 `SquareTerminal`、目标清除只隐藏目标、后台 popover 不画目标行、关闭完成态目标 popover 即已读、发下一条消息（agent idle→running）不隐藏未点开的完成态目标、dispose 移除两个注册；2026-11-06 新增 33 条三 pill 集成：三个真实 `contribute*` 共用一个 `createPillDeference()`——目标+团队同时可见时后台 `visible=false`，团队或目标任一隐藏后后台立即恢复（先把 jobs 轮询冻结在一次 in-flight 读，证明恢复不依赖下一次轮询）；目标 RPC 终态错误移除 goal pill 后，team 仍可见时 jobs 同样立即恢复且无新轮询（forget 接线）；deference 重绘但 presentation 未变时 `registration.update` 次数不增加（去重）；自身规则保持（settled 仍隐藏、`available:false` 自身应显示但被退避压制），cleanup 移除三个注册；`CornerRingIcon`/`JobsPillIcon`/真实目标图标：运行时底图标仍在、角环 9px 右下 -1、外框恒等于 size、角环绝对定位、四种图标 glyph 中心与宿主 16px 图标盒中心偏差 ≤0.5px）：用 esbuild 现编真实
  `GoalPopoverBody`，经 `react-native-web` 渲染进 jsdom（宿主 UI kit 的 `Icon`/`TextInput` 用小桩
  代替：lucide 真 glyph、内联 SVG、react-native-web 真输入框；文案用真实 zh-CN 表）。断言：目标行是
  面板唯一的编辑入口、两个行尾图标按钮不打开编辑、运行时鲸鱼角上出环、**编辑页是小号 composer**
  （「编辑目标」头 + 鲸鱼、真 textarea、预填全文、光标在 0、未测量时 2 行 42px、上限 126px、15px、
  没有「保存」菜单行）、✓「保存目标」对空/未改动草稿 `aria-disabled` + `opacity 0.5`，点击与回车都不提交、
  改动后可提交；**桌面** Enter 保存、Shift+Enter 与组字中 Enter 不保存、Esc 取消、显示三组按键提示；
  **手机** Enter 不保存、无按键提示、保留头部、点 ✓ 保存；**失焦既不保存也不取消**；**清除页（UI-v9 方向 B）**恰两个按钮、红钮按密度 32/24 圆形 `statusDanger` 带垃圾桶、「取消」透明灰字、
  目标行（状态+目标读屏名、非 button、鲸鱼、无环、单行、facts）在提示之上、**红钮前 400ms 不可点**（淡出+缩小+`aria-disabled`，200ms 点也无效，
  400ms 后可点；「取消」立即可点；busy 时转圈且不可点、「取消」仍可点）、红色只在该页出现、**控制错误中文化**（「No goal to clear.」
  显示中文 + 灰色原文、读屏名含两句；未知句原样红字且不出现泛化文案；view/编辑/完成页同样翻译）、**目标行读屏名先说状态**（「目标进行中/未在续跑/已暂停/受阻，编辑目标」）、
  **完成态页**（唯一按钮是清除、无暂停/继续、目标行不是 button 且点击不进编辑、单行截断、facts「已完成」、完成提示、无运行环、
  清除进确认页且用完成态确认句，active 确认句不变）、disarmed 页显示文案 B 全句且 facts 为
  「未在续跑 · 第 3 轮 · 预算 10」（不含「进行中」）、blocked 页显示原因；**真实容器**（UI-v8：`makeGoalPopover`
  + 假 RPC client，SDK 的 `useAgent` 用桩）：编辑「取消」与 Esc 各调 `close()` 一次且不发命令、保存成功调 `close()`
  一次并仍刷新、保存被拒不关且留在编辑框保留草稿并显示原文、清除确认页「取消」不关且回到主页、清除被拒留在确认页并显示中文、双击垃圾桶不发 clear、关闭后上报的目标非
  complete（不记已读）。**需要 `HOST_APP`
  指向 Paseo 检出**（提供 react/react-dom/react-native-web/esbuild/jsdom/lucide-react）：
  `HOST_APP=/path/to/paseo node harness/goal-popover-render-check.cjs`；未设置时 **exit 2**
  （incomplete，不进 CI），与 `jobs-popover-check.cjs` 同约定。**动了 `client/goal-popover.tsx`、
  `client/deepseek-mark*.tsx` 或面板用到的 `goal-polling.ts` 规则必跑；动了三 pill 的退避接线
  （`client/pill-deference.ts`、`client/jobs-pill.tsx`、`client/team-pill.tsx`、`client/goal-pill.tsx`、
  `index.client.tsx`）也必跑。**
- `harness/goal-server-check.cjs` — 插件侧两个 RPC 与 `currentTask`（**40 条**，含 4 条跨层
  断言；真实插件 + `fake-dsh-bridge.mjs`，一次性 `DSH_HOME`，不 spawn 真 `dsh`）：无会话=
  准确空答案（`available:true, goal:null`）、`GoalView` 只映射绘制字段外加 `id`/`revision`（完成态已读键，透传）、
  时间戳不泄漏、`blockedReason` 透传、四码分级（含真实桥 unknown-method 文案 →
  `bridge_too_old`）、`goal.control` 走命令注册表（`name:"goal"` + DSH 参数语法）、DSH 拒绝变
  `ok:false` 原文、空 edit 不发帧；**+8 条 `currentTask` 三态**：有 `in_progress`（合并进
  `GoalState.currentTask` 且 trim）/ 无 in_progress / `todos:null` / 投影 key 缺失 / 老桥无
  `projections` 方法 / 真实读失败（字段缺省 + 一次性 stderr，goal 读取不受影响）；跨层断言
  逐字比较「桥的缺失服务文案 / 插件常量 / 假桥常量」三方。运行：编译插件到 `.dbg`
  （`npx tsc --noEmit false --outDir .dbg --declaration false --module commonjs
  --moduleResolution node`，类型噪音预期），再 `cd .dbg && node goal-server-check.cjs`。
  **动了 `server/provider.ts` 的 goal/`currentTask` 读写、`server/session.ts` 的
  `goal()`/`currentTask()`/`controlGoal`、`server/dsh-process.ts` 的 goal 分级与
  `currentTask`、`index.server.ts` 的 goal handler 或桥的缺失服务文案必跑。**
- `harness/goal-timeline-check.cjs` — 自动续跑轮次行**实时与重放是同一行**（**6 组断言**；
  真实 `DshSession` + 假进程传输，`plugin-build.cjs` 自编译到 `.dbg-goal-timeline`）：实时
  路径出 `tool:goal:round:<goalId>:<round>`（name `goal_round`、completed、文本是 locale 的
  「第 N 轮」半段、无 body、无 revertToken）、`replayHistory()` 重放深相等的同一行且不为它出
  `user_message`、人类消息照旧重放、行落在自己的 `turn:history:<turn>` 区间、子会话实时/重放
  同样出这一行、同一轮幂等且不同轮次 id 不同。**动了 `server/activity-timeline.ts` 的 goal
  轮次行、`server/session.ts` 的 `user/message` 来源过滤（两条重放路径）或
  `server/locale.ts` 的 `goalRound` 必跑。**
- `harness/goal-tool-rows-check.cjs` — 时间线里的 goal 行（真实 `TimelineBuilder` →
  宿主 `ProviderEventSchema` → 客户端 `toolCallData`，按宿主 `turnId + callId` 合并；
  `plugin-build.cjs` 自编译到 `.dbg-goal-tool-rows`）：状态行名 `goal_state`、标题「目标状态」、
  全时间线只有模型真实的那一行叫「查看目标」；`get_goal`/`update_goal` 成功结果是 DSH
  `goalDetail` 字段卡（objective 作行头、等待继续 / 受阻原因 / 没有目标）；解析不了的结果原样
  留在 body；失败调用不出卡；`metadata.errorCode` 过宿主 schema 仍在，已知码给中文短句与解释、
  `error` 仍是 DSH 原文，未知码（含 `constructor`）不给人话。夹具复刻一次真实会话；第一个参数可
  给一份解压后的真实 `session.v4.jsonl` 另行重放（路径只在命令行上）。运行
  `node harness/goal-tool-rows-check.cjs [log]`。**动了 `server/activity-timeline.ts` 的状态行、
  `server/timeline.ts` 的 `#toolResult` metadata、`client/tool-call-data.ts` 的 goal 卡 / 失败码、
  `client/locale.ts` 的 `goalCard` / `toolLabels.goal_state` 或 `index.client.tsx` 的
  dsh-tool schema 必跑。**
- `harness/goal-state-order-check.cjs` — 目标状态行排在引起它的 `/goal` 命令行**之后**（**6 组
  断言**；真实 `DshSession` + 假进程传输，`plugin-build.cjs` 自编译到 `.dbg-goal-state-order`）：
  实时路径 `/goal` 行紧接着状态行；`replayHistory()` 的 goal 行顺序与实时逐个相同、状态行深相等；
  被 compaction 认领（命令行被丢掉）的命令里的 goal 变化仍出状态行；日志停在括号中间时
  `settleRunningTools` 放出状态行且幂等；括号未关时先出的别的行不会越过暂存的状态行；失败的命令
  也放出它。运行 `node harness/goal-state-order-check.cjs`。**动了 `server/timeline.ts` 的
  `consume` / `#heldGoalRows` / `settleRunningTools`、`#commandRun` / `#commandDone` 或
  `server/session.ts` 的重放循环必跑。**

## 团队（team）链（2026-11-04）

设计见 [TEAM.md](./TEAM.md)。三个新脚本 + 两个既有脚本的团队段；断言数为回填时实跑值。

- `harness/team-server-check.cjs` — 插件 `team.read`（**22 条**；假桥 `team` 模式 + 一次性 `DSH_HOME`）：只读 `agentTeam`
  这一个 projection key；无会话 / `null` / `migration-required` / 缺键 → `team: null`；无 `paseo/projections` → 终态
  `bridge_too_old`；未知 key → 终态 `team_unavailable`（且插件前缀与桥源码逐字一致）；未知会话 → `session_missing`；
  其它抛错与形状不符 → `rpc_failed`（不清空成空看板）；DSH 字段原样；**`running`**：空闲根的 Lead 为 false、未托管队员无此键、
  托管中队员回合未结束为 true、已结束为 false、失败成员无此键。编译同 `goal-server-check`（`.dbg` + 拷入本脚本与
  `fake-dsh-bridge.mjs`）。**动了 `server/{dsh-process,session,provider}.ts` 的 team 部分、`shared/team.ts` 或假桥 `team` 模式必跑。**
- `harness/team-pill-check.cjs` — `client/team-polling.ts` 纯规则（**266 条**；2026-11-08 seen 持久化共 85 条（39 条首轮 + 34 条 P2 返工：invalid 文档 reset 修复、连续 conflict 只 warn 一次、真实 defineSettings 定义 id/scope/version 与归一、两 pill 各自引用正确 id 的源码钉 + 12 条收尾：reset 与 read 共用超时门禁（reset 挂起/抛错都不阻塞 hydrate，ready=true 空表）、reset conflict 后下次 save 自愈合并保留他 agent、conflict 重试成功 warns=0）：确认关闭把 `agentId -> teamAllDoneKey` 写进假 settings 文档 → 同一文档新建 controller（= app 重启）hydrate 后同签名隐藏、签名变可见、读失败退回可见且不抛、写失败不抛且本会话仍隐藏、conflict 重读合并保留他 agent、无声宿主超时降级、remove 后 forget 干净重加、64 上限与 sanitize；源码钉：唯一写点在 `advanceSeen` 的 confirmed-close 分支、`publishState` 与轮询模块无写、启动 hydrate、hydrate 前不 present、两个 settings 均在 index.server.ts 注册且有老宿主降级；pill 图标改为 `Users` + 角标环（全部完成 → 绿色 `CircleCheck`）的 6 条源码钉——三种 `Users` 状态都经 `CornerRingIcon` 画 `Users`、完成态用 `CircleCheck` + `statusSuccess`、只有运行态开环、不再出现裸 `StatusRingMark`、可见性仍经 `teamPillVisible(team, seen)`、seen 接线源码钉（面板关闭是唯一写 seen 的输入；board/agent 事件不写）；2026-11-06：入口源码钉更新为 `contributeTeamPill(client, deference)` / `contributeJobsPill(client, deference)` / `contributeGoalPill(client, deference)`）：可见性（只看任务、不看队员：无任务一律隐藏——含起了队员但没建任务；有任务即可见，无论有无队员行；无看板隐藏；**全部完成只再显示一次、只有点开并关闭面板后才隐藏（不点开时发下一条消息不隐藏）**：`teamAllDoneKey` 按 id 排序的 `id:revision` 签名（顺序无关、revision 变化换签名）与 `teamCompleteSeenStep`——board 轮询不写 seen、agent 事件（含下一回合 running）no-op、面板关闭→seen、未全完成时 seen 保留）、成员标题行 chip（顺序、0 不出、运行态缺失不出运行中/已停止、计数只数队员（运行中的 Lead 不算运行中）、Lead 空闲不算已停止、四档降级顺序与选档、各档保留失败与运行中且带字）、负责人标记（运行环 / 已停止只来自 `running` true/false，缺失不标，已完成不标）与「N 个负责人已停止」计数、pill 图标
  （只有 `running:true` 才转环、failure/失败成员红、全部完成绿色 `CircleCheck`）、成员词（无 `running` 时中英都不说运行中/空闲）与排序、任务标记只认 DSH 的
  `ready`、B 分组顺序（被阻塞任务不进可开始）、facts 行、详情字段、重叠警告翻译（未知原样）、契约码、poller 适配（终态移除、
  瞬态保留上次看板）、pill 接线源码钉（label/title 是名词、无计数）。运行：`cd paseo-plugin && npx tsc -p ../harness/team-pill.tsconfig.json`，
  写 `.dbg-team/package.json` 并拷入本脚本，`cd .dbg-team && node team-pill-check.cjs`。**动了 `client/team-*.ts(x)` 必跑；动了 `client/seen-close-gate.ts` 必跑。**
  动了 `client/seen-persistence.ts` / `shared/seen-settings.ts` / `shared/team-seen-settings.ts` 必跑。**
- `harness/team-popover-render-check.cjs` — 真实 `TeamPanel` / `makeTeamPopover` 经 react-native-web 渲染进 jsdom（**93 条**）：
  分区与分组顺序、已完成默认折叠且原地展开、被阻塞任务不在可开始、不画逐个成员行、标题行（鲸鱼 +「DeepSeek」+ 队员数 + chip，0 队员不写「0 名成员」，chip 18px/4px 圆角/无边框，失败红底首位，运行态缺失只剩完成 chip，0 不出，四个隐藏量宽副本）、负责人运行环与「已停止」（列表与详情页）、进行中标题的已停止计数、10 个任务负责人全部已停止、
  facts/警告、描述两行多行截断、详情页（返回行、字段、完整描述保留换行、返回回列表）、空看板、只有 Lead、failure 首行红字、
  只读（按钮只有任务行与折叠行）、容器订阅 store 重绘、关闭时上报最后一块看板（seen 信号）。**需要 `HOST_APP`**，未设 exit 2。**动了 `client/team-popover.tsx` / `team-pill.tsx` 必跑。**
- `harness/tool-call-check.cjs` 团队段（399 → **443**）：`team_task_get/create/update/list` 字段卡、update 动作词（未知原样）、
  list 计数与筛选词、`nextCursor`；**任何形状不符都保留原始 JSON**（非 JSON、多键、少键、deleted、列表坏项、列表多键）；
  失败行不画卡，已知 DSH 原文中文进 `errorShort`/`errorHint`、原文保留在 `error`，未知句不翻、非团队工具不过团队表、英文不翻。
- `harness/locale-check.cjs` 团队段（505 → **661**，L2 的 `toolCards` 段再 +46 → **707**，2026-11-05 jobs 表：+`pillLabel` 3 条、删 `liveLabel` 并断言其不存在，净 −1 → **706**；2026-11-07 当前 **762**）：`team` 表中英键一致、非空、不互抄；成员词与分组词逐字；未知成员词不是运行中/空闲；`toolCards` 同口径（字符串叶子键集/非空/不互抄、6 个 formatter 键一致且中英不同、状态词与回执句逐字）；
  拒绝句译文表（含 `Error:` 前缀、未知原样）；**读本机 `dsh-experimental-agent-team/lib/index.js` 的每个 `TeamError` 字面量，实例化变量后确认都有中文**
  （找不到包时 NOTE，`DSH_AGENT_TEAM` 可覆盖路径）。

## DSH 配置透传链（2026-11-05）

第三方插件的简单布尔开关从 DSH 运行时透传到 Paseo 会话配置菜单（`ProviderConfigState.settings`
的 `select` 行，`on`/`off` 两个选项；桥协议仍是 boolean）。范围与语义见 README「DSH 配置透传」。
断言数为回填时实跑值。

- `harness/settings-bridge-check.mjs` — 桥的 `paseo/settings/list|set`（真 `PaseoHarnessServer` +
  假 `settings`/`configEditor`/`loader`+`pluginPackages`；不 spawn `dsh`、不读 profile、不起模型），
  **48 条**：生产过滤（第三方 + 整个 volatile form 恰好一个 boolean；官方/多字段/非 boolean/dict/
  缺值/整 schema boolean/`cordis:` specifier/非整数 revision 全部排除）、标题以语言字典原样透传
  （`meta.title` 的 `{en,zh}`，桥不选语言；无 metadata 时不出 title，由插件回落模块名）、
  `include:` 前缀 entry id 匹配、`configEditor.configuration()` 一次 list 只调一次、无 settings 服务
  → `{available:false,items:[]}` 且写请求 `settings_unavailable`、写路径带 ns/path/value/revision、
  成功后重新 describe 回读、stale revision → `conflict`、未暴露 ns/path → `not_found`、非法写 →
  `invalid_request`、`expectedValue` 与当前值不一致 → `conflict` 且 0 次 mutate、缺省时仍走 revision、
  `settingsNamespaceTracked` 只认已暴露 ns、`handleRequest` 每个 case 都有对应方法、两个 RPC 真的被
  dispatch。**依赖本机 DSH 安装**（同 `bridge-server-check` 的解析方式；`DSH_PACKAGES_DIR` /
  `DSH_INSTALL_DIR` 可覆盖，没有 DSH 的机器 exit 2）。**动了
  `dsh-bridge/lib/settings-discovery.js`、`server.js` 的 settings 段或 dispatch 必跑；改桥后先
  `node paseo-plugin/scripts/generate-bridge-assets.mjs` + `bridge-assets-check.mjs`。** 夹具用真实
  schemastery `toJSON()` 的 `{uid,refs}` 线格式（不是 plain `{type,dict}`）：原始线格式必须选不出、
  `new Schema(wire)` 必须选出——这是「真实格式下菜单静默为空」P0 的回归门；另断言 `describe()`
  收到的 options 带 `redactSecrets:true`、`revision` 必须是有限整数（NaN/浮点转红）；服务 API
  漂移门（补契约检查看不见 `ctx.get('settings')` 的盲区）：`import('@deepseek-ai/dsh-settings')`
  后 `SettingsForms.prototype.describe/mutate` 仍是函数、`SettingsConflictError` 仍存在；
  **`available:false` 早退清空已暴露 ns**（无 settings 服务与 `describe()` 抛错两条早退都要清）：
  `settingsNamespaceTracked` 在不可读之后不再为旧 ns 返回 true（否则还会为已不显示的行走
  `settings/changed` 转发）。
- `harness/settings-passthrough-check.cjs` — 插件侧（假桥 `DSH_FAKE_SETTINGS_FILE` 脚本化
  `paseo/settings/list|set`，`DSH_FAKE_SETTINGS_TRIGGER` 模拟 DSH Web 界面改同一个 profile 开关，
  `DSH_FAKE_SETTINGS_FAIL_FILE` 脚本化写失败），**64 条**：list 变成 `session.config.settings` 的
  `select` 行（id `dsh:<ns>:<path>`、label=插件显示名字典按本进程 LOCALE 选、value `on`/`off`、
  options 为纯「开启/关闭」词（设置名在行 label 上，option 不重复）、
  描述写明全局）、configure 发 `on`/`off` 时桥收到 `paseo/settings/set
  {ns,path,value(boolean),revision,expectedValue}`、回执值重新发布为 select 值、同值不写、
  **旧 agent 的 boolean 回传兼容**（同值不写、异值仍按 boolean 写、随后 select 值继续可用）、
  `paseo/settings/changed` 后**所有**打开会话都重发新值（且整个通知只 `list` 一次，不是每会话
  一次）、无 settings 服务不出行且桥给的 reason 只 log 一次（latched，第二次 open 不重复）、
  **有 settings 服务但无合格行（`{available:true,items:[]}`）同样不出行，且不误报
  「unavailable」**（两种状态原因不同）、
  冲突/不存在/无服务三种码各自的中文文案且 provider 重发真实 config、**新建面板值挂起到首次
  prompt 才写**（open 时 0 次 set、prompt 前写、回执值发布；select 值与旧 boolean 两种 pick 都
  覆盖）、**写失败出时间线 warning 且 prompt 照发**、**未 prompt 就关闭（草稿）不写**、**resume
  带旧值不写、不发 notice、daemon stderr 一行**、**resume 的 select 值与运行时一致时不误报
  divergence**、`dshSettingLabel` 中英与回落、`dshSettingSelectValue` / `dshSettingBooleanValue`
  的投影与归一化（`on`/`off`/boolean 都认，其它值拒绝）、option label 是纯 on/off 词（不拼设置
  名）、失败文案保留
  桥原文、服务端 locale 中英表（描述含「全局生效 / 影响本机所有 DSH 会话」、`on`/`off` 词条
  （开启/关闭、On/Off）、4 个错误码非空且中英不同、
  pending warning 标题、非预期值文案点明菜单只提供开启/关闭）、**子会话只读**（原生 subagent 会话
  不出 `dsh:` 行，对它 configure 被拒）、**pending 失败 warning 的本地化**（zh 下 description
  含「创建会话时选择的 DSH 全局开关未能写回」，另起一个 `DSH_PASEO_LANG=en` 子进程跑同一失败
  场景，断言 description 无任何 CJK 字符/全角标点且为英文原意——LOCALE 在模块加载时定死，英文
  文案只能这样端到端验证；同一 en 子进程还断言 select 行 option label 为
  `On`/`Off`（无 CJK）、configure 的两条失败文本无 CJK：非预期值的
  `received an unexpected value ... On/Off` 与桥拒绝的 label+分隔符+错误码文案）、**刷新读取的
  第一个会话失败不影响其它会话**（给 `DshSession.readDshSettings` 打一个只对首个会话抛错的补丁
  → 其它打开会话仍收到 `session.config` 新值；全部失败时只写一条 stderr，含
  `failed for every open session`——快速原型里 `#refreshSettings` 固定读 `sessions[0]` 会整次
  丢弃刷新）。编译同
  `mcp-injection-check`（`.dbg` + 拷入本脚本与 `fake-dsh-bridge.mjs`；也可从仓库根跑，回落到
  `paseo-plugin/.dbg/`）。**动了 `server/{dsh-process,session,provider}.ts` 的 settings 段、
  `locale.ts` 文案或假桥 settings 支持必跑。**
- `harness/plugin-check.cjs` 真机段：真实 profile 克隆（`prepareDshHome` 的一次性 `DSH_HOME`）里
  打开会话后断言 `paseo/settings/list` 的 `available:true`（唯一能证明 profile 真的组合了 settings
  服务的检查），用 select 值 `on`/`off` 把第一个第三方布尔开关写到反值 → 断言 `session.config`
  的行是 `select`、option 值为 `on`/`off` 且 option label 精确等于本进程 locale 的
  `On`/`Off`（从编译产物的 `server/locale.js` 取，不写死语言）、与重新 `describe()`
  的回执（boolean）一致 → 再开第二个会话断言同值（全局语义）→ 写回原值（隔离克隆保持干净）。
  **「本机应该有哪个开关」是显式期望，不写死插件名**（这个仓库给别人用）：设置
  `PASEO_EXPECT_DSH_TOGGLE=<ns>[,<ns>]`
  （settings namespace，如 `unrestricted`）时，list 里缺任何一个就**转红**（静默空菜单）；未设置
  时，profile 有合格行就跑写入往返、没有就打印 skip 原因（并提示该变量）。**耗 token（真实模型
  回合）**；跑前先 `bridge-assets-check.mjs`。
