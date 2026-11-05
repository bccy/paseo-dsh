# 团队（Agent Team）在 Paseo 中怎么工作

DSH 的 `dsh-experimental-agent-team` 给 Lead 会话一个团队：队员（各自是一个子会话）和一块共享任务板。
本插件把它画成 composer 上的「团队」pill 和一个只读面板，并把时间线里的 `team_task_*` 工具结果画成字段卡。
**全程只读**：桥没有团队写通道，面板不放按钮（假成功比没有按钮更糟）。

## 数据源

| 数据 | 来源 | 持久 |
|---|---|---|
| 成员、任务、failure | DSH 的 `agentTeam` session projection（wire 视图 `TeamProjection`：`{members, tasks, failure?}`，已删除任务已被 DSH 过滤），经桥已有的 `paseo/projections {sessionId, keys:["agentTeam"]}` 冷读 | 是（只写在 Lead 会话日志里） |
| 成员是否在跑（`running`） | 插件服务端自己：Lead = 根会话当前回合；队员 = 本进程托管的同 id 子会话，且已收到过它的 live 帧 | 否（运行时） |

- **桥零改动**。RPC `team.read {agentId} → {available, team, error?}`，形状照 `goal.current` / `jobs.list`（`shared/team.ts`）。
- **`running` 缺省 = 不知道**。本进程没托管到的队员（例如在别的进程里跑）不带这个键，面板写「成员」，
  既不说「运行中」也不说「空闲」。把持久的 `active` 当成运行中，就是 FIELD-NOTES 里的静默降级。
- 服务端用共享 Zod schema 校验 DSH 的形状；不是这个形状 → `rpc_failed` 带解析原因，**不会**画成空看板。
- 没有该 agent 的会话、没有存档日志（`null`）、`migration-required`（缓存提示不是精确值）→ `team: null`，
  与 goal 的「我们看了，没有」同义。

### 错误分级（沿用 goal）

| 情况 | 码 | 客户端 |
|---|---|---|
| 桥没有 `paseo/projections` | `bridge_too_old` | 终态：移除 pill，console 一行 |
| `unknown or unavailable projection key: agentTeam`（profile 没挂 agent-team bundle） | `team_unavailable` | 终态：移除 pill（=「这个 profile 没有团队功能」，不是「没有团队」） |
| `unknown or not-yet-created session` / 会话 agent 已释放 | `session_missing` | 瞬态：退避重试，保留上次看板 |
| 其它抛错、形状不符 | `rpc_failed` | 同上 |
| projection 的 `failure` | 不是错误码 | 面板首行红字（DSH 原文），pill 图标变红，不隐藏 |

## pill

- **可见**：至少一个队员（`role === "teammate"`）或有任务。不依赖 DSH 合成的 Lead 行；「只有 Lead、没有任务」= 没用过团队，不显示。
- **文字与 title 恒为「团队」/「Team」**，不带计数（title 同时是读屏名、桌面 tooltip、手机 sheet 标题）。
- **压缩成纯图标时图标偏右（2026-11-05 测量）**：宿主插件 pill 是 `composerPillStyles.body`（边框 1、左右内边距 12、gap 8）
  加 `styles.button { flexShrink: 1, minWidth: 0 }`（Paseo 0.15.0 `plugins/buttons/view.tsx:670`），内容从左排、不居中，
  宿主自带的 pill 不收缩，所以一行放不下时只有插件 pill 被压窄。被压到宽 `w` 时图标盒仍在左边 13 处，图标中心
  = 左边 + 21，pill 中心 = 左边 + w/2，偏右 `21 − w/2`：w=42 才居中；浏览器实测（宿主真实 `PluginComposerPills`）
  w=39.5 偏右 1.27、w=32 偏右 5.0、w=26 偏右 8.0；用户 iOS 截图（402pt 宽，@3x）这一格约 40.3pt 偏右约 0.7pt、团队约 31.3pt 偏右约
  5.2pt，与公式一致（当时目标与后台合用一格，该格写「1 个后台」；合并已于 2026-11-05 撤销）。收缩量按 flex-basis 分摊，
  所以 label 越短的 pill 被压得越窄：截图里那一格写「1 个后台」、团队写「团队」，团队就更窄、更偏。后台文字改成「后台」后，
  目标「目标」、后台「后台」、团队「团队」三颗插件 pill 的 label 等长、被压到同样宽，偏移一致，但不为 0（撤销合并后一行多一颗
  插件 pill，每颗会更窄，偏移按上式随之变大，这一点未重新实测）。插件的图标组件
  只画在宿主那个 16px、`overflow: hidden` 的盒子里，外框恰等于 14、在盒内居中（偏差 0，`goal-popover-render-check`
  有 ≤0.5px 断言）；往左挪最多 1px 就会被盒子裁掉，所以**剩下的偏移插件侧修不掉**，要改宿主（例如插件 composer
  pill 给 `minWidth: 42`，或内容居中）。
- **图标**：三种状态都画 `Users`（`CornerRingIcon`）：有队员 `running === true` → 灰色 `Users` 右下角叠运行环；`failure` 或有成员创建失败 → 红色 `Users`；否则灰色 `Users`。
  图标只在状态变化时 `update`，运行环不会每次轮询重启（jobs pill 的做法）。
- 轮询复用 `client/agent-polling.ts`（4s、抖动、退避到 30s、答案去重），**未改它**；jobs / goal pill 语义不变。

## 面板（设计 T2 方向 B）

自上而下：failure 红行（若有）→ 成员标题行 → 任务分组「进行中 n」「可开始 n」「等待依赖 n」→ 折叠的「已完成 n ›」。

- **成员标题行（T7，方向 2）**：不逐个画成员行（Paseo 原生「查看子智能体」已列出并可打开成员）。一行：鲸鱼 16px +「DeepSeek」（手机、桌面都只写这个）
  +「N 名成员」+ 状态 chip，依次为：红「创建失败 N」、宿主运行环「运行中 N」、灰点「已停止 N」、宿主完成勾「N/M 任务完成」。
  **只数队员，不数 Lead（主会话）**：「N 名成员」、运行中、已停止、创建失败都只看 `role === "teammate"`，是否有运行态也只看队员；
  0 个队员但有任务时不写「0 名成员」，只剩「DeepSeek」与任务完成 chip（若有）。计数为 0 不出 chip；没有队员带 `running` 时不出
  运行中/已停止 chip（未知不是运行也不是停止）；「任务完成」是看板完成数（成员没有完成态）。不可点。
  - **chip 与 composer pill 区分**：高 18px（pill 约 28）、圆角 4px（pill 全圆）、无边框、无悬停填充、无箭头；底色 surface2，失败用 danger 浅底。
  - **一行放不下**：四档同构副本隐藏排版、`onLayout` 量宽，取第一个放得下的：全称 → 短称（失败/运行/停止/完成）→ 去「已停止」
   （进行中标题已有「N 个负责人已停止」）→ 去「任务完成」（已完成分组仍有计数）。「创建失败」「运行中」永不删、永不退化成纯数字。
- **负责人标记（T5）**：任务行 facts 里负责人名字后面：`running === true` → 宿主运行环（12px）；`running === false`
  （服务端确定该成员已不在跑）→ 灰色小标签「已停止」；`running` 缺失、成员失败/准备中、不在名单、未分配 → 什么都不画。
  只标未完成任务（已完成任务的负责人空闲是正常结局）。详情页负责人字段同理。「进行中」分组标题行尾追加「· N 个负责人已停止」
  （仅 N>0，只数 `running === false`）。背景：成员按指令认领后结束会话，DSH 不会自动 release，任务停在 in_progress；
  状态与分组仍完全按 DSH，不改判、不猜「已完成」。
- **任务行**：宿主任务列表的图标（`CircleDot` 运行蓝 / `Circle` / `CircleCheck` 删除线）+ `CircleDashed`（等待依赖）；
  facts「task-N · 负责人或未分配 · 等 task-x · 写入范围」；写入范围重叠警告翻成中文（未知原样）；描述最多两行（换行压成空格）。
  分组只看 **DSH 的 `ready`**，插件不重算：pending 且 `ready:false` 一律「等待依赖」。
- **任务详情页**：点任务行进入，面板内原地换页（不是宿主二级页：0.15 的 popover 内容注册不了 `MenuSurface pages`），
  顶部是宿主 sheet 头同款返回行（18px `ChevronLeft`），下面 subject、字段（状态 / 负责人 / 依赖 / 写入范围 / 提醒 / 修订）和完整描述（保留换行、可选中）。
  返回回到列表；打开期间任务从看板消失 → 自动回列表。
- 「已完成」用 jobs 面板「已完成」同一种折叠行（行尾计数 + 转 90° 的 chevron），默认收起。
- 空看板：「暂无共享任务」；读不到 / 首次轮询前：一行说明。

## 时间线字段卡

`team_task_create` / `get` / `update` / `list` 的结果（DSH 的 `TeamTaskView`，`additionalProperties:false`）严格解析：

- 单任务卡：状态图标 + subject + `task-N`；字段 状态 / 负责人 / 依赖 / 写入范围 / 提醒 / 修订；说明两行 +「展开」。
  `update` 卡顶部「动作 认领 · task-2」（DSH 的 8 个 action 有中英词，新 action 原样显示）。
- 列表卡：「N 个任务 · 筛选 状态=已完成」，每个任务一项，`nextCursor` 时末尾「还有更多任务，模型可翻页查看」。
- **解析不了就保留原始 JSON**（多一个键、少一个键、`deleted`、非 JSON、列表里有一项坏的）。
- **失败行**：从不画卡；DSH 原文在中文环境按 `client/locale.ts` 的 `TEAM_REFUSALS_ZH`（整句匹配，`Error:` 前缀可有可无，
  来源是 agent-team 包的 `TeamError`/`TeamTaskGraphError` 句子与工具包的 cursor/limit 句子）翻成中文放在行头和展开首行，
  原文仍在展开的红字里；不认识的句子原样，不加泛化文案。范围是团队工具（`team_task_*`、`spawn_teammate`、`list_agents`、
  `wait_agent`、`send_message`、`interrupt_agent`），其它工具的错误不过这张表。
- 服务端 timeline 不动（仍是 `unknown` detail）；卡的形状在 `index.client.tsx` 的 item schema 里声明，否则会被 `.strip()` 吃掉。

## 检查

见 [HARNESS.md](./HARNESS.md)「团队（team）链」：`team-server-check`（假桥）、`team-pill-check`（纯规则）、
`team-popover-render-check`（jsdom 渲染），以及 `tool-call-check` / `locale-check` 的团队段。

## 未验证

- 真机：真实 DSH 会话里 `paseo/projections {keys:["agentTeam"]}` 的端到端返回、队员在另一个 dsh 进程时的「成员」文案、
  iOS 原生 sheet 上的详情页与滚动。
- `running` 依赖子会话的 live 帧：重开会话后、队员还没再发帧之前，队员显示「成员」（不是空闲），这是有意的。
