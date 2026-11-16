# Paseo 0.16.0 适配矩阵（2026-11-16）

依据：[0.16.0 Release](https://github.com/getpaseo/paseo/releases/tag/v0.16.0)、
[插件参考](https://paseo.sh/docs/plugins/reference)、npm 发布的
`@getpaseo/{plugin,protocol,client,server}` beta.1 / beta.2 / 0.16.0 逐文件差异，
以及本仓 `5e2de2d` 的适配前基线。本表记录完整范围、取舍与验收条件；不将未发布 main
当成正式版契约，也不把“待真机”写成通过。
分类：**必改** = 不改就漏官方能力或契约；**新增** = 新功能实现；**宿主自动** = 升级宿主即得，只需验收；
**不适用** = 已评估，DSH 没有对应数据或会重复宿主功能（附理由，不是漏项）；**阻塞** = 没有公开接口。

## A. 插件 API / 契约

| # | 官方变更 | 适配前实现 | 分类 | 要做什么 | 验收 |
|---|---|---|---|---|---|
| A1 | `addWorkspaceRowBadgeItem` + `WorkspaceRowBadge`（#7645，0.16.0 正式版才有） | 无 | **新增（用户要求）** | 见 C 节设计；下限改成 `>=0.16.0`（paseo-plugin.json requirements、peerDependencies）；运行时仍然要先判断 `typeof client.addWorkspaceRowBadgeItem === "function"`（文档原话："Apps older than this API have no addWorkspaceRowBadgeItem"。App 版本和 host 版本可以不一致，下限只约束 host） | 离线：聚合函数单测（每种状态 → 徽标、空 → null、多 agent 优先级）；缺少该 API 的假 client 不抛错；真机：桌面 + 手机侧栏截图，Show 菜单能关掉徽标 |
| A2 | agent 快照新增 `background`、`backgroundWork.count`（#9362） | `PillAgent` 不带这两个字段 | **必改（透传）** | 把 `background` 透传进 PillAgent；**pill 不做过滤**（理由：background 在创建时固定；徽标要用这些 agent 的订阅数据；它们的 composer 不挂载时 pill 注册本身无害）。`backgroundWork.count` 统计的是宿主自己的后台 shell/monitor，**不等于 DSH jobs**，不能拿来替代 jobs feed，也不显示在 DSH UI 上 | 单测：background agent 照常注册订阅，并计入徽标（只算运行态，不触发警示色，见 C 节）；真机确认插件目录快照里是否出现 background agent（记录事实即可） |
| A3 | `background_work` provider 事件 / 停止入口 | jobs pill 和 jobs.stop RPC 自己实现 | **阻塞** | direct-provider SDK 没有公开这个事件，不伪造；保留现有实现，在 docs 写明原因 | grep 0.16.0 `@getpaseo/plugin/dist/server/provider.d.ts` 里没有 background_work，记进 docs |
| A4 | 删除 `agent.turn.after.timeline`（breaking） | 不读这个字段 | 无影响 | 无 | tsc 用 0.16.0 类型通过 |
| A5 | 正式 `server.addHook`；`server.on/before` 旧名弃用，2027-04-30 后移除 | `index.server.ts:100` 用 `server.on` 注册 6 个旧事件名，只为了捕获 `context.paseo` | **必改（下限 >=0.16.0 后没有理由再用旧名）** | 改成 `addHook`，新名：agent.create.after、agent.turn.before、agent.turn.after、agent.permission.before、agent.permission.after、agent.archive.after。保持原有六个 hook，不因完整映射表而额外注册 close.after。**不得**注册 agent.open.before / agent.create.before（open.before 就是 session_open，会触发全局 reload） | 离线：假 server 断言注册的是新名、不含 open.before/create.before、handler 能捕获 paseo、cleanup 全部释放；变异：换回 `server.on` 或漏掉一个名字时测试变红 |
| A6 | `timeline.refetch({wholeTurns})` | 撤回提示按 noticeId 查 tail 20 | 不适用（已有共识） | 不改。只有"读取刚结束的那个回合的内容"才用它，而且要按 turnId 过滤；插件现在没有这类功能 | 无 |
| A7 | 插件时间线 kind 格式校验（#7677） | `dsh-rewind-notice`、`dsh-stream-stats` 都合规 | 宿主自动 | 加一条离线断言：所有 kind 常量都满足 `^[a-z][a-z0-9-]*$`，防止以后新增的 kind 不合规 | 离线判据必须拒绝大写 kind；变异结果另行记录 |
| A8 | review 附件 `mode:"all"`（#9590） | 渲染里直接插入 mode，已经能用 | 只补测试 | 补 all 的测试，并过 0.16.0 的 schema | 测试先红后绿（例如临时把 all 映射为 throw） |
| A9 | 子代理关闭时保留 canceled/failed（#8563） | 插件本来就发 session.turn canceled/failed | 宿主自动 | `subagent-check` 验证插件发出的失败/取消回合状态；`stable-host-child-check` 另以真实宿主类验证这些终态之后再 close 仍保持终态，后者需要宿主安装、不进 portable CI | 真机：取消一个 DSH 子代理，子代理轨道显示 canceled，不是 completed |
| A10 | replace/Stop 串行化（#9537，agent-manager replaceRunInForegroundLane） | steer 走插件自己的回执 | 宿主自动 | 不复制宿主的队列 | steer-check；真机：运行中插话、发替换消息、Stop 立刻生效、冷启动时 Stop |
| A11 | 完成通知取当前回合的回复（#9793，按 turnId 分段） | DSH 目标驱动的自主回合会带 live turnId | 宿主自动（**和我们直接相关**：goal 的自主回合） | 无 | 真机：goal 自主跑完一轮后，完成通知显示的是这一轮的回复 |
| A12 | 插件渲染最终回复时 Collapse turns 的修复（#8811） | 我们用 timeline transformer/renderer | 宿主自动 | 无 | 真机：折叠回合后最后的回复正常；**重放丢 turnId（#8053）仍未修**，docs 更新到 0.16.0（agent-manager.js:3508,3563） |
| A13 | 新开 runtime 不会被 idle sweep 误清（#8857） | shared-dsh 孤儿回收保留 | 宿主自动 | 不删 profile gate / shared-dsh-record | 真机：reload 后打开旧会话，等过一次 sweep 周期仍然能用 |
| A14 | 插件订阅 + 二进制 payload（#8527） | 三个 pill 已经用订阅 | 已承接 | 修关闭 upsert 释放、重连 metadata 更新和迟到 feed 清理（分别验收） | 关闭、重连、旧请求迟到三个反例 |
| A15 | `PASEO_WORKSPACE_ID` 注入环境（#8939） | `identity-env.ts:42,96` 已映射 | 已承接 | 无 | identity-env-check |
| A16 | ACP usage 合并（#9396） | 不走 ACP；session.ts 自己维护完整 usage 记录 | 不适用 | 无 | 无 |
| A17 | 主题 token 新增（sidebar*、surface3/4…） | 插件不贡献主题 | 不适用 | 无（`tokens.ts` 用的是宿主 theme 的已有字段） | 无 |

## B. 客户端扩展点（0.16 周期内引入，beta.1 起就有）

| # | 能力 | DSH 该不该提供 | 结论 |
|---|---|---|---|
| B1 | `addComposerItem` / `useComposer`（controls、草稿、附件、设置） | 模型、思考档位、模式、权限预设已经通过 provider controls/providerOptions 由宿主原生画出；再加 composer item 就是**重复控件**，两处设置还可能互相打架 | 不适用。唯一可能的候选是"插入 /goal 模板"这类 Action，但 slash 菜单已经有 /goal，**不做**。理由写进 docs/ADOPTION |
| B2 | `addAttachmentSource` | DSH 没有自己的附件来源（图片/文件走宿主原生附件，`session.ts` 翻译） | 不适用 |
| B3 | `addNewWorkspaceItem` / 工作区 metadata | 新建工作区时，DSH 没有需要预先选的东西（profile/路由由 provider 读取） | 不适用。如果用户想在新建工作区时就选 DSH profile/预设，那是新功能，需要单独决定 |
| B4 | `addSidebarView` | 替换整个侧栏属于产品范围扩大，和 DSH provider 职责无关 | 不适用 |
| B5 | 组件化设置页（Settings cog/tabs，#8675） | 插件没有设置页（配置在 DSH profile） | 不适用 |
| B6 | 插件 gallery / registry（#9752） | 收录属于发布；须等用户真实环境测试通过并明确确认 | 交付元数据继续维护；不在测试完成前发布或提交目录收录 |
| B7 | composer pill 上箭头（#8673） | 宿主自动画 | 宿主自动；真机看三个 pill |

B 节的功能已按数据来源逐项评估。宿主已有的模型、思考、权限、草稿与附件交互继续由原生接口承接；没有 DSH 数据源的扩展点不注册占位控件。

## C. 工作区徽标最小完整设计

**数据来源：复用现有三个 pill 的订阅，不新增 RPC，也不新增按 agent 的轮询。**
- 三个 pill 模块（goal/team/jobs）的 `createAgentSubscriptions` 已经对每个 DSH agent（有 workspaceId、未关闭）开着订阅，answer 由 `publishState` 交给 pill。
- 新增一个客户端模块 `client/workspace-status.ts`：纯 store，`Map<agentId, {workspaceId, goal?, team?, jobs?}>`，提供 `subscribe/getSnapshot`（给 useSyncExternalStore）。三个 pill 在 `publishState` / `removeAgent` 时顺带写入或删除自己那一份（观察器不拥有额外读取；仅在成功发布后提交去重签名）。agent 的 workspaceId 从 `PillAgent` 拿。
- 徽标组件按 `workspaceId` 用 selector 读出聚合结果，用浅比较避免每行都重渲染。

**每个工作区最多三个徽标，按类别各一个，只显示有意义的状态：**

| 类别 | 显示条件 | 图标 / 文字 | tone |
|---|---|---|---|
| 目标 | 有 agent 的目标在运行 | 目标图标 + "目标" | info |
| 目标 | 暂停 / 需要恢复（重开后 disarm）/ 受阻 / 读取失败 | 同上 | warning（受阻和读取失败用 danger） |
| 目标 | 完成且**未读**（复用 seen 判定，和 pill 一致） | 对勾 | success |
| 团队 | 有队员在跑 | 人形 + "团队" | info；团队记录出错时 danger |
| 后台 | 有运行中的 DSH job（只看运行中，和 jobs pill 的"只做 live 指示"一致；文字只写"后台"） | 后台图标 + "后台"；数量仅放在 accessibilityLabel | info |

- 多个 agent 同类时取最高优先级：danger > warning > success > info；accessibilityLabel 写出数量（例如"2 个目标运行中"）。
- background agent：只计入 info（运行态），不贡献 warning/success（官方语义是"不吸引注意"）。
  三个 pill 的目录订阅和后续分页都显式传 `filter: { includeBackground: true }`，否则宿主默认不返回这些 agent。
- 未建立会话（`session_missing`）和明确未挂载的服务不生成警示徽标；RPC 读取失败保留错误语义，并与执行失败使用不同的无障碍文案。
- 目标 active + armed 在自主回合间短暂 idle 时仍保持 info，与 composer pill 的目标状态一致；paused/disarmed 为 warning，blocked 为 danger。
- 什么都没有就返回 `null`（文档：不留空隙）。
- 文案走 `locale.ts`（中英）；图标复用现有 DeepSeek/目标/团队/后台图标。
- 本轮徽标按用户确认的完整适配范围实现；后台 composer pill 保持原有 live-only 语义。

**生命周期 / 边界**
- 每个 host 一个插件客户端实例，徽标只渲染本 host 的工作区（文档）。
- 订阅断开或终止（terminal）时，该 agent 的条目删除，徽标不保留过期状态。重连间隙徽标会短暂消失，composer pill 则按既有策略保留最后内容；订阅重建后的首个相同答案也会恢复徽标。
- 依赖 R2（关闭时释放订阅）：不修的话，关闭的 agent 会让徽标一直亮着 → R2 是徽标的前置。

**验收**
1. 离线：聚合纯函数表驱动测试（上表每行 + 优先级 + background 只计 info + 删除后消失）；store 在 removeAgent 后清掉条目；缺少 API 时不注册。变异：去掉 removeAgent 里的清理 → "关闭后徽标消失"用例变红。
2. 读次数：徽标挂载前后，服务端 pill-feed 的 read 次数不变（假 feed 计数断言）。
3. 真机：多工作区、多 agent；goal 跑 / 完成 / 打开关闭面板后变化；后台 job 开始和结束；桌面 + 手机侧栏截图；Show 菜单开关。

## D. 版本与文档
- `requirements.paseo` 和 peer 改成 `>=0.16.0`；三个 SDK 精确 0.16.0；docs 写明：0.16.0 是因为徽标 API 和 addHook 迁移，不是旧 beta 跑不了。
- README/ADOPTION/REWIND：0.16.0 仍有 #8053（agent-manager.js:3508,3563）；doctor 的"只读"文案（G3）一并修。
- 徽标真机验收要求 App 和宿主具备 0.16.0 对应 API；源码适配与离线检查不会自动升级或重启用户环境。


## E. 验证入口和边界

- `node harness/offline-checks.cjs`：portable CI 唯一入口；`--list` 列清单。只需仓库 npm 依赖，
  不要求已安装 DSH/Paseo，不运行模型、不接 daemon。含严格 `tsc --noEmit`、编译新鲜度和假桥验证。
- `node harness/stable-host-child-check.mjs`：以 `PASEO_CLI_ROOT` 定位真实宿主类，
  验证子代理 canceled/failed/completed 后 close 保持终态；不进 portable CI。
- `node harness/rewind-notice-delivery-check.mjs`：真实宿主类 + 假桥，验证时间线重建与提示投递；
  同样依赖宿主安装且不进 portable CI。
- `node harness/workspace-badges-check.cjs`：徽标聚合、background 语义、生命周期和注册降级；
  具体运行契约以脚本头部与 [HARNESS](HARNESS.md) 为准。

真机仍需单列桌面/手机、深浅主题、Show 菜单、goal 自动回合、后台任务和 Stop/replace。
离线结果不能证明这些视觉及进程交互已通过，最终结果以对应日志和用户验收为准。
