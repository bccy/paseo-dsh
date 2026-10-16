# 实战缺陷记录

这份文件是开发过程中**真实发生过**的问题清单，按发现顺序排列。每一条都写清了
症状、根因和修法。

它比 [ADOPTION.md](./ADOPTION.md) 更啰嗦——ADOPTION 把教训按主题归纳，这里保留
时间顺序和当时的错误判断。**如果你正在接自己的运行时，这份清单可以当检查表用。**

前 11 条来自界面反馈驱动的迭代，接下来 4 条来自一次针对"未完成实现"的专项审计，
最后 1 条来自"重载一个正在运行的会话"这条平时不会走的路径。

---

## 第一轮：基础契约

### 1. 会话事件信封解包

**症状**：时间线上只有用户消息，助手回复、推理、工具调用全部丢失。

**根因**：线上事件结构是 `{type, seq, time, data}`，载荷在 `data` 里，我按平铺结构读了。

**修法**：所有处理器统一从 `event.data` 取载荷。

### 2. draft features 会话

**症状**：每次改配置都报 `unknown or not-yet-created session: <id>`。

**根因**：Paseo 会调 `createSession` **只为读 composer 特性，从不 prompt**。我的
`plan/*` 和 `config/set` 依赖"agent 已存在"。

**修法**：配置类操作改为记录**待生效意图**（`pendingPlanMode`、路由、思考档位），
agent 创建时再应用。

### 3. sessionId 冲突

**症状**：Paseo 刷新/重连后用同一 id 重开会话，agent 直接报废。

**根因**：DSH 会持久化会话，同 id 再创建时回 `already exists`。

**修法**：捕获该错误后转为 `ctx.agents.resume`，历史与可用性都保住。

### 4. 无效思考档位

**症状**：切到模型不支持的档位会让**整个回合失败**。

**根因**：运行时对不支持的档位是硬拒绝，不是忽略。

**修法**：按 catalog 校验后再下发；不支持的档位忽略并记日志。

---

## 第二轮：协议错配（因为自造形状）

这一轮最贵。第一轮修复时我自创了不少协议形状，反而把 Paseo 自带的能力弄坏了。
最终全部改为**照抄 Paseo 自己的 Codex / Claude 适配器**。

### 5. 选项答非所问

**症状**：提问时选 A，结果给了个 B。

**根因**：Paseo 的共享提问 UI 通过 `updatedInput.answers[question.header]` 回答案
（字符串，多选用逗号连接）。我只读 `selectedActionId`，取不到就回退到第一个选项。

**修法**：按 `header` 取值，给缺失 `header` 的问题补答案键，`selectedActionId` 仅作兜底。

### 6. 每个问题都要提交一次

**症状**：3 个问题要点 3 次提交；期望是步进式、一次提交。

**根因**：我把每个问题拆成了独立卡片。Paseo 的设计是**一张卡片装多个问题**：
`input.questions` 数组配步进式选择器。

**修法**：整批问题合成一张卡片、一次提交。

### 7. 看不到计划就被要求批准

**症状**：直接弹出同意/拒绝，看不到计划内容。

**根因**：我自作聪明把计划从时间线里删了，只留审批卡。

**修法**：Paseo 的 Codex 适配器是**两个东西一起发**——时间线上一条
`detail: { type: "plan", text }` 的可读计划卡片，加一张审批卡片。照做。

### 8. 计划卡片形状自造

**症状**：计划卡片文案怪异，出现重复选项。

**根因**：计划该放 `input.plan`，我放了 `description`；按钮自己造了一套。

**修法**：按钮用 `Dismiss(deny, danger, dismiss)` + `Implement(allow, primary, implement)`，
与 Codex 的 `buildPlanPermissionActions()` 完全一致。提问卡**不要**带 `actions`。

### 9. 思考档位被弹回 off

**症状**：选好档位，一批准计划就变回 off。

**根因**：我给「不支持推理的模型」造了一个全局兜底 `off/low/high/max`，于是不支持
推理的模型也显示选择器；选中后校验又判定不支持而丢弃，Paseo 便把选择器弹回 off。

**修法**：`configState()` 只报**当前模型自己声明**的档位，没有就整个不显示；
provider 级默认值改成**所有模型都支持的交集**而不是并集。

### 10. 不支持插话 steer

**症状**：界面上根本没有插话入口。

**根因**：`prompt.steer` 是 Paseo 的能力位，我压根没声明。

**修法**：声明它并通过 `negotiateProviderCapabilities` 协商；`delivery: "steer"` 走
`agent.steer()`（注入当前回合），而不是 `followup()`（排在下一个回合）。

> 同一类错误后来又犯了两次：漏声明 `prompt.image` 让图片根本发不出去（见第 16 条），
> 漏声明 `prompt.command` 让 `/` 菜单一个命令、一个技能都不显示。**能力位是开关，
> 不是"锦上添花"**——漏了它功能整个消失，且不报任何错。声明完还要真的把数据补上：
> 命令目录走 `session.commands` 事件，缺了它菜单照样是空的。

### 11. 终止后对话就废了

**症状**：终止一次之后，再发消息就"续不上"了。

**根因**：`interrupt()` 直接 `kill()` 掉了子进程——**杀进程 = 会话报废**。我当时还在
注释里自我辩解"桥接没有取消方法，结束进程是诚实的选择"。

**修法**：新增 bridge 的 `session/cancel` → `agent.cancel({ kind: "user" })`，
只取消当前回合，会话与历史保留。

> **教训**：注释里开始给自己找理由（"诚实的选项"、"暂时只能这样"）就是信号。
> 这类地方几乎总是可以在上游找到正确的接口。

---

## 第三轮：能力声明与模型配置

### 12. 模型明明能推理，DSH 说不行

**症状**：某条中转路由上的模型没有任何思考档位可选；显式传 `reasoningEffort` 直接报
`does not support reasoning effort "high"`。

**根因**：**DSH 内置目录里这条路由没有推理元数据**，不是模型能力缺失。实测该网关：

- 基线响应就带 `reasoning_content`，`usage` 里有 `reasoning_tokens`（本来就在推理）
- 接受 `reasoning_effort`，且各档会真实改变推理 token 预算
- 但拒绝 `reasoning_effort: "off"`（`unknown variant`）

**修法**：在 profile 里声明 `reasoningEfforts`。

### 13. 声明推理后每个回合 422

**症状**：加上 `reasoningEfforts` 后，每个回合都失败：
`422 messages[0].role: unknown variant 'developer'`。

**根因**：一旦声明了推理能力，pi-ai 会改用 OpenAI 推理模型的 `developer` 角色承载
系统提示，而 DeepSeek 网关只认 `system`。

**修法**：同时设 `compat.supportsDeveloperRole: false`。**这两处必须成对出现**。

### 14. 没有 max 档位

**症状**：加上了档位声明，但只有 low/medium/high，没有 max。

**根因**：DSH 对 `xhigh`/`max` 的处理和五个基础档位不同——**缺键即视为不支持**，
而不是取默认值。

**修法**：显式列出 `max: max`。这一条现在由 `npx paseo-dsh probe`（仓库里是
`tools/probe-provider.mjs`，同一实现）自动覆盖。

---

## 第四轮：专项审计发现的静默降级

这一轮针对"未完成实现"做了一次专项检查。标记类注释（TODO/FIXME）一个都没有，
但**结构性的漏**藏得很深——靠关键字找不到，必须做交叉核对。

### 15. `session.usage` 从未发出

**症状**：用量读数永远是空的。

**根因**：DSH 把 token 记账挂在 `assistant/message` 事件上（它没有独立的用量记录），
我从没转发过 `session.usage`。

**修法**：在会话事件处理里映射并转发。字段对应关系：
`inputTokens` → `inputTokens`，`cacheReadTokens` → `cachedInputTokens`，
`outputTokens` → `outputTokens`。

### 16. 非文本内容块被静默丢弃（图片：三层，修了三次才通）

**症状**：发图片时，图片凭空消失，模型还煞有介事地回答了一个纯文本问题。

**根因（第一层）**：bridge 和 `DshProcess` **都已经支持** content blocks（含 attachment
store），只有最上层把它们映射成空字符串并传了 `undefined`——典型的"管线铺好但没接线"。

**修法（第一层）**：原样透传；遇到没有对应类型的块**抛错**而不是跳过。

**但这一层修完图片仍然不通**——因为它其实断了三层，每层都不报错：

| 层 | 症状 | 根因 | 修法 |
|----|------|------|------|
| Paseo 插件 | 带图 prompt 被直接拒绝：`Provider does not support prompt.image` | `CAPABILITIES` 里漏了 `prompt.image`，`negotiateProviderCapabilities` 把它过滤掉了 | 在 `CAPABILITIES` 里声明 `prompt.image` |
| DSH 请求投影 | 图片到了 DSH，但模型收到的是 `[image omitted because this model accepts text only; ...]` 占位文本 | 路由没声明图片模态，默认按 `[text]` 投影，图片被换成文字 | profile 里 `defaultInput: [text, image]` 或模型条目 `input: [text, image]` |
| bridge 附件入库 | 报错 `Declared image type does not match its bytes.` | Paseo 按**文件名后缀**判定 `mimeType`；一张 JPEG 存成 `.png` 就会以 `image/png` 声明 JPEG 字节，DSH 校验声明与字节后拒绝 | bridge 按**魔数嗅探**真实类型，不信任声明的 `mimeType` |

**教训**：一条"数据丢失"路径往往横跨多个组件，**每个组件都认为自己的上游/下游会处理**。
第一层修好时模型能"看到"附件已存在的证据（占位文本），但真正的像素仍被下一层丢掉。
判断图片是否真的通了，不能看"有没有报错"，要看模型描述的内容是否只有图片里才有。
`harness/plugin-check.cjs` 现在会断言 `prompt.image` 被声明，正是为了钉住第二层。

### 17. `sessions` 处理器硬编码返回 `[]`

**症状**：无（因为 `session.list` 能力没声明，Paseo 不会问）。

**根因**：桩代码。真被调到就是在撒谎——明明有会话却报空列表。

**修法**：删除该死代码；未知输入类型统一走下面第 18 条的失败分支。

### 18. 未知请求被报成"成功"

**症状**：无（同上，静默）。

**根因**：`send()` 的 `switch` `default` 分支发的是 `request.completed`。任何没实现的
输入类型都会被当成正常完成。

**修法**：改发 `request.failed` 并点名类型。

> **教训**：`default:` 分支里"当作成功处理"是静默降级的经典形态。
> 它和第 11 条的 `kill()` 属于同一类错误——**看起来能用，实际在骗人**。

---

## 第五轮：重载后会话不可恢复

### 19. 插件重载 / daemon 重启后，正在跑的会话挂掉且无法恢复

**症状**：改了插件或重启 daemon 之后，原本在跑的 agent 报
`[System Error] Provider connection closed`；继续对话则报
`Invalid plugin provider persistence handle`，再也接不上。

根因有**两层**，缺一层都修不好：

| 层 | 症状 | 根因 | 修法 |
|----|------|------|------|
| Paseo ↔ 插件 | 重开时报 `Invalid plugin provider persistence handle` | 插件从没在 `session.opened` 里给 `persistence`，Paseo 的 `describePersistence()` 返回 null，退化成 `{provider, sessionId:<裸id>}`；重开时它自己的 `decodePersistenceId` 要求 `sessionId` 以 `plugin:` 开头，于是解码失败 | 声明 `session.persistence` 能力，并在 `session.opened` 里带 `persistence: {version, data}` |
| 插件内部（bridge） | 即便拿到合法 handle，resume 也会抛 `cannot get property "sessions" without inject` | resume 分支里用了 `this.ctx.sessions`——cordis 里**没 inject 的服务必须用 `ctx.get()` 访问**，直接取属性会抛 | 改成 `this.ctx.get('sessions')` / `this.ctx.get('sessionProjections')` |

**判定标准**：DSH 会持久化会话（jsonl），所以只要能重开、且 `sessionId` 一致，
`ctx.agents.resume` 就能把历史接回来。可以这样自测：起一个 dsh→让它记住一个词→杀掉
进程→再起一个→用同一个 `sessionId` 问它那个词。答得出，说明恢复链路是通的。

> **教训**：`Provider connection closed` 只是"重载杀进程"的表象，真正让人接不上的是
> **能力位没声明 + 一个 inject 违规**。两个都不会在正常使用中报错，只有"重载一个活着的
> 会话"这条路径才会把两者同时暴露出来——所以**重载测试要单独做**，别指望日常冒烟能覆盖。

---

## 第六轮：上下文占用读数

### 20. 上下文占用（context window）永远是空的

**症状**：Paseo 的用量读数只有 token 数字，没有上下文窗口与占用百分比；按本次需求，
provider 显示名同步简化为 `DeepSeek Harness`，保留 Provider ID。

**根因有两层**：

| 层 | 根因 |
|----|------|
| 数据从未转发 | `session.usage` 只在 `assistant/message` 上取 `data.usage` 的 input/cache/output，从未带 `contextWindowMaxTokens` / `contextWindowUsedTokens`；而 Paseo 的占用读数**只认这两项**。DSH 自己有一整套回放式计量（`ctx.tokenMeter` 与 `sessionProjections.contextPressure`），但桥从没把它暴露出来。 |
| 语义容易搞错 | DSH 的 `TokenUsage.inputTokens` 是**未缓存**输入，缓存读写在独立桶里（`uncachedInputTokens` 与 `cacheReadTokens` 互斥）。累计计费用量不等于当前上下文；既不能只算未缓存输入，也不能把缓存桶重复相加。 |

**修法**：

- 桥新增 `paseo/usage`：读 `sessionProjections.snapshot(session, ['contextPressure'])` 的
  **客户端视图**——同路由时以 `projectedTokens ?? pressureTokens` 作为已用量，
  与 DSH 自己的上下文计**同源**。容量由 `llm.resolveModelInfo()` 按**当前路由**解析；
  选中路由与日志不同时，用 DSH `tokenMeter.measure()` 重新计量。缺数据即**省略**，
  不把旧路由容量当兜底、不硬编码窗口大小。
- 插件分别替换 token 统计和上下文统计，再合成完整 `lastUsage` 快照发送。Paseo 每次
  **整体替换** `lastUsage`，只发一半会抹掉另一半；新快照的未知字段必须清除旧值。
- 刷新点：会话打开/恢复（含 history skip，恢复后无需新回合即可显示）、步骤和工具完成、回合结束、
  `compaction/end`（压缩后占用应立即下降）、`configure`（切模型）。用递增 generation
  丢弃过期的异步响应，会话关闭后不再发事件。相邻步骤事件合并触发，不逐 token 扫历史。

**判定标准**：一次真实回合结束后，`session.usage` 应同时带 `inputTokens` 等数字与
`contextWindowUsedTokens` / `contextWindowMaxTokens`。`harness/plugin-check.cjs` 检查真实回合与
无新回合恢复；`harness/context-usage-check.cjs` 检查合并、旧响应、缺数据和关闭时序。
超窗或错误状态允许原始占用超过容量，不能为了比例正常而截断真实值。

---

## 第七轮：原生子代理可见性

### 21. DSH 原生子代理在 Paseo 里完全看不见

**症状**：DSH 能起子代理，父会话里也能看到 `subagent` 工具卡，但 Paseo 的子代理列表
是空的——没有独立子会话、没有子状态、没有子工具过程。

**根因有两层**：

| 层 | 根因 | 修法 |
|----|------|------|
| 能力位 | `CAPABILITIES` 缺 `session.subsession`，Paseo 会丢弃所有 provider 发起的子 `session.opened`（`runtime.js` 在父会话未协商该能力时直接判定连接失败） | 声明 `session.subsession`，并在子会话用 `restoration: "parent"` 打开 |
| 会话归属 | 插件按“一进程一会话”处理：`DshProcess` 的 `session.status` 丢掉 `sessionId`，`DshSession` 把所有事件一律以根会话 id 发出 | 桥透传原生 `sessionId` 并按 `session.header.origin === 'subagent'` 立即登记子会话；插件按 `sessionId` 路由到子视图，子状态/用量/时间线不再落到父级 |

**修法要点**：
- 桥新增 `session.child-opened`（来自子会话自己的 header：`origin:'subagent'` +
  `parentSession`，权威且即时；父日志的 `subagent/catalog` 作为兜底），并新增只读的
  `paseo/subagents`（`subagents.listDescendants`，排除 fork 继承事实，不加载/恢复子 agent）。
- 插件把子会话映射成 Paseo 原生 provider 子会话：`restoration:"parent"`、
  `parentSessionId` 指向父的 Paseo 会话 id（根）或子 id（嵌套）、能力位为空（只读视图）。
- 一个根进程仍是唯一所有者，子视图不拥有新进程；恢复（`history:"replay"`）时按
  `paseo/subagents` 的前序重建树并回放各自历史，不创建真实子 agent。

**第二轮修复（独立审查阻断项）**：
- **嵌套必须继续声明能力**：只读子会话也必须声明 `session.subsession`，否则它下面的孙级会
  触发 Paseo `runtime.js` 的父能力检查，**整条连接失败**。子能力只保留这一位，不含
  prompt/configure（仍是只读）。
- **协商门控**：把协商结果传给 `DshSession`；宿主没给 `session.subsession` 时不发任何子事件，
  父会话保持健康，而不是断连。
- **终态来自 `turn/end`**：子会话的 `turn/end` reason 决定终态——`completed`→completed，
  `aborted`→canceled，其余（error/max-tokens/blocked/interrupted）→failed；`agent/status idle`
  只在没有 `turn/end` 时兜底为 completed。恢复时按子日志最后一个 `turn/end` 还原终态，避免
  已完成/失败的孩子永远停在 running。
- **恢复覆盖 skip 与 replay**：每次 `session.open` 都重建子树；子历史按 `handle.inheritedEventCount`
  只回放**own-suffix**，fork 继承的父对话/兄弟工具过程不会被当成孩子的新消息。
- **父子身份隔离**：子 provider id 采用 root-scoped 形式（`<rootPaseoId>:sub:<nativeChildId>`），
  两个根观察同一 native 子会话不再冲突；权限卡 id 也带会话前缀，父子同 `toolCallId` 不串。
- **父未就绪先缓冲**：root `session.ready` 之前、或嵌套子先于其父到达时，子 opened/事件/状态
  进入有界缓冲，root ready 后按序释放；不丢弃最早输出，也不提前于父 opened 发送。
- **label 补齐**：桥先登记子会话身份但不立即 open，等子自己的 `subagent/descriptor`（或父
  catalog）拿到 label 后再首次 `session.child-opened`（宿主只在首次 attachChild 抓 title）；
  缓冲有上限，溢出则无标题打开，绝不丢输出。
- **列举失败要诚实**：`paseo/subagents` 在服务缺失时返回 `available:false`、读取失败时带
  `error`、不可读分支进 `diagnostics`，绝不返回 `available:true` 的空数组假装成功。

**第三轮修复（root 已 ready 后的孙级乱序）**：
- root 已 ready 时，孙级 `session.child-opened` 可能先于父 child-opened 到达：此时该子只进
  `#pendingOpened`，其后续 event/status 会被误判成 ghost 丢弃；父随后 opened 也不再触发
  flush，孙级卡住且最早输出丢失。修法是：event/status 遇到“已知但父未到”的子时也进有界缓冲
  （`#isPendingChild`），每次新父成功注册后都 flush，而不只在首次 `markRootReady`；
  flush 只释放已能解析父边的子树与事件，仍未解析父的 held 事件保留（不清空），并用
  `#flushing` 防重入、`#bufferOpened` 去重防重复 opened。完全未知的 ghost 仍只记诊断、不落父。
- 回归：`harness/fake-dsh-bridge.mjs` 新增 `nested` 模式（root ready 后，great→grand→parent
  逐层先于其父通知，且孙级最早消息/状态先到）；`harness/subagent-check.cjs` 断言父先 opened、
  孙/曾孙按序 opened、最早输出各保留且只一次、宿主父能力门控通过、ghost 仍被丢弃。

**宿主限制（Paseo 0.11.2，未改核心，不伪造）**：
`agent/plugin-provider.js` 的 `acceptChildEvent` 只消费子会话的 `timeline.item`、终态
`session.turn`、`session.runtime_failed`/`session.closed`；**忽略** `session.turn started`、
`session.usage`、`session.permission`。因此：
- 子卡首次打开即 `running`，可续接子代理**二次运行**的 `started` 不会把卡片状态恢复成运行中
  （终态仍会更新）；这不是插件能修的，需要 Paseo 核心补丁。
- 给子会话发 `session.permission` 并不能让 Paseo 出现审批 UI。桥的 `owns()` 仍只覆盖根会话，
  子会话的问题**不转发**给 Paseo（避免挂起或误归属父会话），保持 DSH 自身的子代理审批语义。
- 插件仍以正确的子 `sessionId` 发出 started/usage/permission 事件（不丢弃、不冒充父级），
  只是当前宿主会忽略它们。

**判定标准**：`harness/subagent-check.cjs` 用脚本化假 `dsh` 断言能力位、父子归属、
多子混排、未知子不误归属、子只读拒绝、恢复去重、**Paseo 父能力门控**、**无 subsession 保持
父健康**、**父未就绪缓冲**、**同 toolId 权限隔离**、**turn/end 终态**、**skip/replay 重建**、
**fork own-suffix**、**两个根同 native 不冲突**——全程不启动真实子代理。

---

## 第八轮：运行中插话打断前台子代理

### 22. 运行中发消息会打断正在等待前台子代理的回合

**症状**：在 Paseo 里给一个**正在运行、正等待前台子代理**的 DSH 父会话发消息，父回合会被
取消，前台子代理随之被 abort。同样的操作在 DSH 自身里不会打断——消息以插话（steer）方式
进入当前回合。

**根因**：插件把插话的回执**谎报**成了新回合。Paseo App 默认 `sendBehavior: "steer"`，运行中
发消息走 daemon 的 `steerOrReplaceActiveTurn`：它要求插件回 `result.type === "steer"` 且
`turnId === expectedTurnId` 才算 accepted，而 `expectedTurnId` 是开启该回合时**首次
`session.prompt_result`** 报的 turnId（`agent-manager.js` 的
`startPendingForegroundTurn → openActiveTurn`；provider 自己随后的 `session.turn started`
在前台回合上会被 `onStreamTurnStarted` 抑制）。本仓库 `#emitPromptAccepted` 无论 `delivery`
是什么都回 `{type:"turn"}`，于是每次 steer 都被判 `unavailable`，daemon 随即
`replaceAdmittedForegroundTurn` → `cancelAgentRunBefore` → 插件 `interrupt()` → 桥
`session/cancel` → DSH `agent.cancel({kind:'user'})`：当前回合被取消，绑在该回合 abort signal
上的前台子代理被中止。附带后果是同一段文本先被 `agent.steer()` 注入一次、又被替换回合作为
prompt 重发一次。

**修法**：
- `delivery === "steer"` 且确有运行中的回合（`#turnId !== null`）时，回
  `{type:"steer", turnId: this.#turnId}`；其它情况维持 `{type:"turn"}`（无运行回合时不谎报
  steer）。steer 路径不触发任何 cancel/interrupt。命令路径（`{type:"completed"}`）不变。
- 顺带消掉一个 turnId 竞态：`prompt()` 在**开启新回合**时（`delivery !== "steer"` 且
  `#turnId === null`）先预发 `#turnId = \`turn:${clientMessageId}\``，让**首次 prompt_result**
  与随后 `session.turn started` 的 turnId 按构造相等——daemon 绑的是前者，steer 必须重复它。
  真实 DSH 下 running 状态本就先于 prompt 回复到达，预发是**防御性**的、不依赖该跨进程时序，
  同时兼作回归锚点。prompt 启动失败时把预发的 id 复位为 null，避免留下幽灵回合 id。

**判定标准**：`harness/steer-check.cjs`（17 项）用脚本化假 `dsh` 断言：运行中 steer 被准入且
`turnId` 与 `session.turn started` 一致、steer 不产生任何 `session/cancel`、消息只投递一次
（无重复 user_message、无重复回合）、无运行回合时 steer 如实回 `turn`、父 steer 不影响子会话
终态、失败后 id 复位且下一次回合仍一致、命令仍回 `completed`。假桥新增 `steer`（真实时序：
running status 先于 prompt 回复）与 `late`（合成的防御性反序，非真实 DSH 时序）两个模式，以及
`failonce`（首个 prompt 被拒）。真实 daemon 的 before/after 验证（重载插件后给等待前台子代理
的会话发消息，观察子代理是否继续跑完）由主会话在部署后进行，本仓库不做。

**已知窄边界（未修，均比原行为更窄）**：

| 项 | 说明 |
|----|------|
| 失败复位可能丢掉已开回合的 id | `prompt()` 失败时只在**本次调用预发过 id**（`issuedTurn`）的情况下把 `#turnId` 复位为 null。只有桥在 `followup()` 之前就抛错（尚未进入 running）时，复位才是安全的；若失败发生在 DSH 已同步进入 running、插件已发出 `session.turn started` 之后，复位会丢掉这个仍然存活回合的 id，之后 idle 不再发 `session.turn completed`。daemon 侧仍能靠 `turn_failed` 收敛，只是语义变脏。属本轮新增逻辑的窄边界，未改行为，如实记录。 |
| 无回合 steer 回 `turn` 会在宿主侧留一个悬空 id | 无运行回合时 steer 回 `{type:"turn", turnId}`，`@getpaseo/server` 的 `plugin-provider.js` `accept()` 会把 `turn` 结果的 turnId 加进 `activeTurnIds`，而该回合不存在、永远没有终态事件把它移除，仅在该连接 `connectionClosed` 时可能多报一次 `session.runtime_failed`。这是宿主行为；原实现**所有** steer 都回 `turn`，所以本轮是收窄而非新增。 |

---

## 第九轮：Paseo 注入的工具全部缺席

### 23. Paseo 注入的 MCP 工具一个都没到 DSH

**症状**：无。会话照常开、照常答，只是模型手里没有 `mcp__paseo__*` 工具——不能
`create_workspace`、不能 `send_agent_prompt`、不能 `respond_to_permission`。同一个 Paseo 里的
opencode 会话有这些工具，插件接入的 DSH 会话没有。

**根因**：Paseo 对**插件 provider** 的能力写死了 `supportsNativePaseoTools: false`
（`@getpaseo/server` `agent/plugin-provider.js`），所以它拿不到 opencode 那种原生工具通道
（opencode / opencode-v2 / omp 走 Paseo 自己塞进 opencode 的 `bridge-plugin.bundle.mjs` 加本地
HTTP bridge；此时 Paseo 用 `resolveProviderLaunchConfig → stripInternalPaseoMcpServer` 把内部
`paseo` MCP server 从 launch config 里剥掉，避免重复注册）。插件 provider 唯一被给的通道就是
`session.open` 的 `config.mcpServers`，其中含 Paseo 注入的
`{ type: "http", url: "<daemon>/mcp/agents?callerAgentId=<agentId>" }`。

而本仓库插件从 `provider.ts#open` 到 `session.ts` 再到 `dsh-process.ts` **完全没有读这个字段**，
也没有读 `config.toolPolicy`。Paseo 以为递到了，DSH 以为上游没配，全程零报错——与第 15/16/17/18
条同一类静默降级。

**修法**：

- `provider.ts#open` 把 `config.mcpServers` 传给 `DshSession`；`session.ts` 原样透传给
  `DshProcess`；`dsh-process.ts` 在 spawn 前翻译成一份 **per-session `--patch` overlay**，
  命令行加 `--patch <file>`。DSH 只在启动时接受 MCP server（`dsh-mcp-client` 是 profile 条目），
  而注入的 URL 带 `callerAgentId`，所以 overlay 不能放进共享 profile。
- 映射：`stdio` → `stdio`（`command`/`args`/`env`）；`http` → `streamable-http`
  （`url`/`headers`）；`sse` **响亮失败并点名 server**（`dsh-mcp-client` 只有 stdio 与 Streamable
  HTTP，降级试连会报一个语义不准的错）；`alwaysLoad` 忽略（加载提示，不是能力）。
- 每条都带 `failOnStartupError: true`：连不上时 DSH 打印 `warning: 1 entry did not activate`
  加具体错误（子进程 stderr 已被插件转发），进程照常启动——响亮，但不把会话搞挂。
- patch 文件含 MCP auth token，写进 `mkdtempSync` 的 0700 目录、文件 0600，进程
  `exit` / `error` / `kill` 时整目录删除。

**判定标准**：`harness/mcp-injection-check.cjs`（8 项）用脚本化假 `dsh` 断言：`http` server 变成
`--patch` 且映射为 `streamable-http`（url/headers 原样）、`failOnStartupError` 为真、`stdio`
server 保留 command/args/env、无 `mcpServers` 时**不**加 `--patch`、`sse` 回 `request.failed`
并点名 server 且不 spawn 进程、patch 文件随进程一起消失。假桥新增 `DSH_FAKE_ARGV`（记录自身
argv 与 patch 内容），因为没有任何 bridge 帧能反映启动参数。

**未做**：`config.toolPolicy.preapproved` 不转发。它要求运行时预授权指定的 MCP 工具，而 DSH
没有这个概念（由它自己的 permission preset 决定）；硬造一个等价物等于自造协议形状。

---

## 第十轮：权限档位的显示名

### 24. 权限档位只能显示原始 key，配了显示名也不生效

**症状**：Paseo 的 Permissions 面板列出 `read-only` / `workspace-write` /
`danger-full-access`。DSH 的 `dsh-permission-presets` 本来就支持给每个档位配
`name` / `description` 当显示名，但配了也不显示。

**根因**：桥把显示名截断了。`dsh-bridge/lib/server.js` 的 `paseo/permission` 返回
`presets: [...service.names]`——`names` 只有表键；DSH 的
`PermissionPresetService.catalog()` 才带 `PresetOption { value, name, description }`。
插件于是只能拿 key 当 label（`session.ts` 的 `label: name, value: name`），而面板标题
和选项标签其实都是它自己传的字符串——它有能力呈现，只是手里没有显示名。

**修法**：

- 桥改用 `service.catalog().options`，每个档位返回 `{ value, name, description? }`；
- 插件用 `name` 当 label、`value` 当值——`value` 仍是 `/permission` 接受的表键，所以
  改标签不影响行为，部署自定义的档位也自动生效；
- 显示名由部署在自己的 profile 里声明，插件不硬编码任何语言。
- 面板标题 `Permissions` 保持英文：它没有任何 DSH 配置能覆盖，写死中文会把这层语言
  偏好塞进一个给所有人用的插件。

**判定标准**：`harness/plugin-check.cjs` 新增一项，断言 permission 的每个 option 同时
带非空 `label` 与 `value`。桥若退回只返回 key，`preset.name` 会是 `undefined`，这一项
立刻红。profile 配好显示名后，该项输出
`只读=read-only, 工作区可写=workspace-write, 完全访问=danger-full-access`。

**已知取舍**：DSH 的 per-preset `description` 桥会带出来，但 Paseo 的
`ProviderSetting` select 选项没有 description 槽（只有 `{label, value}`），所以描述暂时
到不了界面；桥保留它是为了将来有位置显示时不必再改协议。

---

## 第十一轮：整步快照导致"半天不出、突然一大批"

### 25. 助手文本不流式：模型一步结束才整段出现

**症状**：界面长时间没有任何内容，然后一个模型步的全部输出（推理 + 正文 + 工具行）
一次性出现。真实会话日志统计：`step/start` 到 `assistant/message` 的静默间隔中位数
9.1s、p90 20.2s，占回合墙钟的 68%。

**根因有两层**：

| 层 | 根因 |
|----|------|
| 数据源粒度 | DSH 的**持久**事件 `assistant/message` 只在 step settle 时 append 一次，携带整步内容；逐 chunk 的过程在进程内以 `agent/assistant-stream` 瞬时帧发出，从不进会话日志。 |
| 桥没有订阅瞬时帧 | 桥只订阅 `session/event` 和 `agent/status`，所以中间过程在 DSH 进程里就被丢掉了。插件只能拿到整步快照，无法自行"变出"流式。 |

而 Paseo 侧**本来就支持增量**：`@getpaseo/server` 的 `plugin-provider.js`
`mapTimelineItem` 对同 id 的 `assistant_message`/`reasoning` 做前缀差分，Paseo 自己的
Antigravity provider 就是这么发的（`id` 与 `messageId` 同值、文本单调增长）。桥没订阅
瞬时帧，等于声明了流式却没有数据源——正是本仓库最忌讳的"能力声明与数据源不一致"。

**修法**：

- 桥订阅 `agent/assistant-stream`（`{global: true}`：它是 agent 作用域事件），用
  `@deepseek-ai/dsh-llm` 导出的 `BlockAssembler` 把 chunk 折成 text/reasoning，按
  **100ms** 节流，用 `session.event` 信封发一个桥自有类型 `paseo/assistant-delta`
  （`{turn, step, text, reasoning}`，都是全量快照）。复用 `session.event` 是为了让插件
  已有的根/子会话路由和 held-child 缓冲原样生效。
- 插件 `timeline.ts` 把该类型折成稳定 id 的 `timeline.item`（`assistant:${turn}:${step}` /
  `reasoning:${turn}:${step}`），并且 **`messageId` 必须等于该 id**。Paseo 的合并要求
  相邻行的 `turnId` 相同、`messageId` 一致；此前持久项用的是 DSH 的 `message.id`，与增量
  项的 id 不同，会让最终消息另起一行、文本重复。
- 节流必须放桥侧：每个 token 一个 JSON-RPC 帧会把 stdio 打爆。终态持久事件覆盖尾差
  （通常差值为空，Paseo 直接丢弃，不会重复）。
- **Paseo 只合并"相邻"的同类行**，所以流式最容易被两个细节切成碎片，两个都要防：
  1. 一帧里 reasoning 和 text 同时增长时，插件会交替发两种 item，同类行不再相邻。
     桥因此**只发送本次变化的那一半**（未变的半边省略），让每一半的行保持连续。
  2. durable `assistant/message` 在最后一个 chunk 之后才 append；若节流把尾巴压住了，
     durable 会带来一个 Paseo 没见过的差值，落在正文行之后又把回答切开。桥在转发
     durable 之前先**强制刷出**实时快照，使 durable 的差值恒为空。
  这两点都是"日志看着对、界面被切成多条消息"的静默错误，只有按 Paseo 的合并规则投影
  才能断言（`plugin-check.cjs` 新增了该项）。

**判定标准**：

- `harness/stream-probe.mjs`（真实 `dsh --profile paseo`）：一步内应出现多个
  `paseo/assistant-delta`，文本前缀单调增长，durable 消息被最后一个快照覆盖，首个
  delta 远早于 settle，且按 Paseo 规则投影后每种类型只有一行。
- `harness/assistant-stream-check.cjs`（假桥，离线）：断言同一 `turn:step` 的
  `assistant_message` 出现多次、前缀增长、`id === messageId`、持久项不另起一行。
- `harness/plugin-check.cjs`（真实回合）：`live streaming does not fragment an assistant
  step across rows`——每个 `messageId` 投影后恰好一行。

**已知限制**：Paseo 的时间线是 append-only，没有"撤回"。一次在**已经流出一部分文本后**
才失败重试的 attempt，其已发出的前缀会留在界面上（桥在每次 `start` 重置组装器，不会把
两次 attempt 混成一份，但无法收回已经发出去的帧）。仅影响流式途中失败重试的罕见路径。

---

---

## 第十二轮：客户端渲染（思考行与工具行）

Paseo 的 provider 协议只负责把时间线项送到 App，**长什么样由 App 决定**。插件能改的只有
两处：`addTimelineTransformer` + `addTimelineRenderer` 替换单个内置项。这一轮给插件加了
客户端入口（`index.client.tsx` + `client/`），只替换推理行和工具行，不动 Paseo 本体。

### 26. 推理行要像 dsh web：单行滚动 + 点击展开，且不能抖动

**症状**：第一版按 `phase === "streaming"` 决定展开/收起，结果思考过程中行会反复开合，
思考完才停下。

**根因**：宿主的 `phase` 不是"还在流式"的可靠信号。宿主对 thought 的判定是
`"thought"===kind && "loading"===status`（宿主 bundle 里
`I = ("assistant_message"===kind && "streaming"===c) || ("thought"===kind && "loading"===status) || ... ? "streaming" : "complete"`），
而 chunk 一落定 status 就在 loading/ready 之间翻，于是 `phase` 抖。

**修法**：不看 `phase`，看 `useRevealedText` **返回文本有没有变长**。变长就 latch 成
"流式中"；只有在"文本不再变长 **且** 宿主报 complete"时才落定。折叠态是标签和滚动行
**同一行**（`思考中… <当前行>`），点击才展开全文，右侧不加箭头。

### 27. 工具行要保留 Paseo 自己的图标和单行形状，展开才给格式

**症状**：第一版把工具行整个换成自定义的圆点 + 纯文本，图标没了；展开的 diff 是一整片
没有颜色；短输出还默认展开，跟推理行的单行风格不一致。

**根因**：替换 timeline item 就是**整项替换**，Paseo 原生的工具图标、单行摘要、展开里的
代码高亮全都会丢。要"看起来还是原来的"，就得自己复刻。

**修法**：
- 图标照抄宿主的映射（`resolveToolCallIconName`）：`shell → SquareTerminal`、
  `read → Eye`、`edit/write → Pencil`、`search/fetch → Search`、`sub_agent → Bot`、
  `plan → Brain`、`plain_text` 用它自己的 `icon` 键、其余 `Wrench`，再用插件 SDK 的
  `Icon`（Lucide 名）画出来。映射表在 `client/tool-call-data.ts`，有 harness 断言。
- 折叠态跟推理行一样是**单行**（`numberOfLines={1}`），点击才展开。
- 展开态跟推理行的展开一致：**纯文本、无外框**，等宽 + diff 行着色。
- diff 的每一行都要带 `+`/`-` 前缀。DSH 的 `edit` 只给 `old_string`/`new_string`，
  早期实现只给整体加一次前缀，多行替换只有第一行有色，看着像没着色。

### 28. 已知限制：`read_image` 的图片无法内联显示

DSH 的 `read_image` 返回的是**附件引用**（`{path, image:{attachmentId, mediaType, ...}}`），
不是内联图片数据；而 Paseo 的工具详情联合类型里没有图片变体
（`shell/read/edit/write/search/fetch/worktree_setup/sub_agent/plain_text/plan/unknown`）。
插件渲染器只能拿到文本，`timeline.ts` 的 `textOf` 也只抽 text 块。所以工具行里直接画图
需要 Paseo 侧新增图片型 tool detail，或允许插件时间线行携带附件——本仓库不改全局包。
现阶段图片只能通过 Paseo 的文件预览打开路径查看。

### 29. 替换内置行会丢掉"运行中"的流光，要自己补

**症状**：把思考行和工具行换成插件渲染后，运行中的流光动画没了，界面变得"死"。

**根因**：Paseo 的流光在宿主 App 里（web 端是 `background-clip:text` 的渐变 keyframes，
原生端是 Reanimated + SVG 渐变遮罩），而插件 SDK 只导出 `Icon/Modal/useToast/
useRevealedText/ScrollView/FlatList/copyText/TextInput`，**没有暴露任何 shimmer/spinner**。

**修法（当前）**：`client/text-shimmer.tsx` —— **web 用 DSH 的 CSS 扫光，原生用等价几何重建**，
详见第 32 条。下面这段透明度脉冲是**历史**，已被扫光取代（`client/shimmer.ts` 已删除）：

> 曾经用普通 React state 驱动整行 opacity（模块级 `setInterval` 按余弦推给订阅者）。它在
> 两端都能跑，但观感只是"忽明忽暗"，用户明确要 DSH 那种**扫光**。

**关键：触发的条件是"位置"而不是"状态"**（见第 29c 条）。思考行仍是"文本还在变长"，
工具行是 `useRowPulse()`——**在客户端**算出来的"我是不是最新那一行、且刚提交过"。
服务端标不出来（见 29c 里那条失败的尝试）。扫光与脉冲共用这个判据（`shouldPulse()`）。

**早期试过的扫光**（叠一条高光从左到右平移）被否掉了：没有真正的渐变时它就是一块硬边色块
划过，用户评价**还不如脉冲**。**这个结论后来被第 32 条推翻**——问题不在"扫光"，在于当时只是
平移一个纯色块，既没有 mask 也没有反向位移。

### 29b. 脉冲实现踩过的四个坑

**一、`Animated.loop` 在 RN Web 上只跑一段就停**

实测：web 上 `Animated.loop(Animated.sequence([...]))` 跑完一段就停，运行行的内联
`style.opacity` 会冻结在 0.37 / 0.63 / 0.88 之类的中间值。排除项：无头 Chromium 里
`requestAnimationFrame` 是**正常 60fps**（`frames: 60 / 1000ms`），不是 rAF 节流；单段
`Animated.timing` 会动，停住的是循环；`useNativeDriver: true/false` 都不影响；手动用完成
回调链式 `Animated.timing` 也一样。

**二、`Animated.Value.setValue()` 在原生上不推更新**

改成 `setInterval` + `setValue` 后 web 上正常循环了（实测运行行 0.379 → 0.499 → 0.948），
但用户在 App（原生）上仍然看不到闪。`setValue` 在 web 会更新 DOM 的内联 style，却没有把
更新推到原生 view。**结论：两端都可靠的做法是用 state 重渲染，不要依赖 `Animated`。**

**三、共享值必须"只发给正在运行的行"**

为了让重挂载不重置，值曾经是模块级共享。但 `useShimmer(active)` 如果**无条件返回共享值**，
所有历史行都会绑到同一个值上，于是**整屏的命令行和思考行一起闪**。用户原话："整个所有的
命令工具和思考都在闪"。修法是空闲行恒为 1，只有 active 行订阅。实测两条 active 行在动
（0.373 / 0.48），5 条历史行恒为 1。

**四、僵尸 running 行会一直闪**

被中断的工具调用（比如正在 `paseo plugin reload` 时插件把自己重启了）永远等不到
`tool/result`，在时间线里就一直是 `running`，于是永远脉冲。这不是脉冲的 bug，是"工具没有
终态"的固有现象；要根治得让插件在会话恢复时把未完成的工具标记为 canceled。

### 29c. 短命令不会闪：脉冲要看"位置"，不能看"状态"

**症状**：长命令会闪，短命令（`echo`、`ls` 这种）永远不闪。用户的原话是"直接把最后一条去
闪烁就行了，而不是说一定要看它的什么状态不状态的"。

**根因**：`dsh-agent-loop` 在执行**开始**时就 append `tool/call`，执行完 append
`tool/result`。短命令这两条几乎在同一个 tick 里到达客户端，渲染器根本观察不到
`status === "running"`，按状态触发的脉冲自然一次都不跑。

**为什么不能直接"取最后一条"**：插件时间线渲染器的 props 只有
`theme / host / layout / agentId / item / timestamp`——**看不到自己在列表里的位置**，也没有
isLast/index。位置只能在客户端自己算（见下），服务端标了也传不过来。

**修法（最终采用，纯客户端）**：`client/newest.ts` 的 `useRowPulse(agentId, timestamp)` 回答
"我是不是最新那一行、且刚提交过"，`shouldPulse()` 把工具状态和它合起来。脉冲条件是：

```
newest && (status === "running" || fresh)
```

**`running` 也必须挂在 `newest` 下面**：被中断的工具调用（插件在工具执行中途重启，永远等不到
`tool/result`）在 daemon 的存储里会一直是 `running`，而它再也不会是最新行——不加这道门它就会
闪到会话结束。服务端会在下一个 `turn/end` 和每次回放时把它们收成 `canceled`，但**已经存进
daemon 的 item 不会被追溯改写**（实测：重载后旧僵尸行仍在闪），所以客户端也要能自保。

**五个坑，每一个都对应一次真实故障**（子代理审核后又修了一轮）：

- **`timestamp` 不是 item 自己的时间。** Paseo 的投影在合并同一个 tool_call 时把行的时间戳
  换成**最后一次快照**的时间，而插件服务端根本不发 timestamp，daemon 用记录时刻补
  （`agent-timeline-store.js` 的 `?? new Date()`）。所以**回放出来的历史行也带着"现在"的
  时间戳**，跟实时活动一模一样——任何基于时间的判据都分不出历史和实时。于是改用
  **提交批次**区分：400ms 内提交 ≥5 行就是历史加载，整批不闪（`BULK_*`）。人手动敲两条命令
  不会触发。
- **`fresh` 必须用客户端自己的时钟。** 早先写成 `Date.now() - timestamp`：item 的 timestamp
  来自 daemon 的钟，`Date.now()` 来自手机的钟，**手机快几秒，刚到的新行就被判成旧的**，
  短命令又完全不闪。现在窗口从"本客户端**提交**这一行的时刻"起算。
- **渲染 ≠ 提交。** React 可能丢弃一次渲染（并发/offscreen 预渲染），所以"第一次看到"记在
  **effect 里**（提交之后）。写在渲染期的话，被丢弃的那次渲染会把窗口用掉，等它真正提交时
  已经过期 → 又是不闪。取最大值那部分写在渲染期是安全的（幂等）。
- **首批渲染谁都不能自称最新。** 最大值初值为空时若返回 `newest: true`，回放时每一行首渲染
  都会自称最新 → **整屏一起闪**（用户吐槽过的症状）。没有先验值时一律返回 false；并且本批次
  的最大值要**等这一批渲染结束**（微任务）再合并，否则同一批里后面的行会看到前面行刚写的值。
- **"不再是最后一行"能自愈**：正在闪的行每 50ms 重渲染一次，顺便重新求值，一旦有更新的行
  提交过就立刻停。不需要服务端推任何东西。

**配套的服务端修复**：`TimelineBuilder` 现在记住仍 `running` 的工具，`turn/end`（**任何
reason，包括 `aborted`**）时把它们收成 `canceled`。被中断的工具永远等不到 `tool/result`，
而客户端对 `running` 行不加窗口，不收尾就是**永久脉冲**（live 和每次回放都闪）。同一处还修了
"重复 `tool/call` 把已完成的行重置回 running 并清空输出"。

**验证**：`harness/newest-check.cjs` 29/29（位置、批次、窗口、交接、回放、时钟、真实脉冲判据）；
`harness/timeline-check.cjs` 16/16（工具生命周期、重复调用、中断收尾、回放）；
`harness/tool-call-check.cjs` 37/37；`harness/plugin-check.cjs` 27/27；`npx tsc --noEmit` 干净。

**试过但不可行的方案（重要教训）**：先试的是服务端方案——`TimelineBuilder.#put()` 给最新行打
`metadata.current`，新行出现时清掉旧行的标记，`turn/end` 清空。协议层是对的
（`harness/plugin-check.cjs` 的断言全部通过），但**客户端不会把"只有 `metadata` 变化"的 item
重新折进去**：历史回放时每一行都被短暂标过 `current`，之后就一直保持 `C`，实测 web UI 上十几
行同时是 `C` 且全部卡在 0.35。**"位置"这个信息传不过来，只能在客户端算。**

**已知缺口（未修）**：插件客户端没有 locale 来源，`tool-call-data.ts` 的工具名（`命令`/`读取`/
`编辑`…）和思考行的 `思考中…`/`已思考` 都是硬编码中文，英文系统下也显示中文。服务端的
`locale.ts` 只覆盖菜单文案。要修得给客户端一条 locale 通道（RPC 或在渲染数据里带上）。

diff 行按 GitHub 的做法：浅绿/浅红底（低 alpha，深色主题也不刺眼）、`+`/`-` 标记单独
上色、代码正文用 **muted 前景色**（用 `foreground` 会"太白"）。**不要**给每行加左侧亮色
条——那会在行首形成一块更亮的区域，用户明确不喜欢。

思考行还有一个点，**一度做反了**：折叠态曾经显示**最后一行**（当时的理由是"用户正在读的结尾"）。
用户指出应**以 DSH 为准**，而 DSH 的 `ReasoningRow` 是：

```js
const summaryText = running ? latestCompletedParagraphFirstLine(text) : firstLine(text);
```

即**结束后显示第一行**，运行中显示"最后一个首行已被换行终结的段落"的首行（按段落推进，
不是逐 token 抖动）；标签恒为 `思考`（`message.think`），**不会**变成 `已思考`——DSH 的
`已思考` 属于它"整轮过程"折叠摘要，是另一个元素。现按 DSH 原样移植到 `client/thinking-text.ts`，
断言见 `harness/thinking-check.cjs`。

### 30. 展开态：往下铺满、不裁剪、不卡顿

**症状一**：工具行的命令超宽时折叠态有省略号，点开后跟那条被截断的命令对不上；而且展开的
命令挤在图标和标签旁边换行，宽度不够。

**根因**：摘要和图标/标签同处一个 row，`numberOfLines={1}` 又写死，展开后要么仍是一行
省略号，要么在剩余宽度里窄窄地折行。

**修法**：折叠态头部保持单行摘要；**展开时头部不再显示摘要**，把完整命令 + 输出/diff 作为
**独立块放在行下方**（`marginLeft` 对齐、占满整行宽度）。这样既不重复已经显示过的内容，
也不会有省略号，跟思考行的展开方式一致。另外，**没有输出的命令也要可展开**
（`canExpand = hasBody || summary !== ""`）——`cat > file` 这类命令 stdout 为空，早期实现
直接不给展开，命令就永远截断。

**症状二**：思考内容很长时，点开再关闭，界面会空白一小会儿才恢复；用户还要求**展开时不能
省略前面的内容**，且**展开块里不要内层滚动**（内层滚动会吞掉点击，导致关不掉）。

**根因**：展开态把 `revealed`（逐帧 pacing 的文本）塞进一个 `Text`；推理可能有几万字，
每一帧都在重渲染这一大块，挂载/卸载时卡住 JS 线程。而只渲染尾部又违背"前面不能省略"。

**修法**：
- 展开态渲染**原始 `text`**，不是 `revealed`：`text` 只在 delta 到达时变，不会逐帧重渲染。
- **不要**加内层 `ScrollView`（试过：它吞掉点击，展开后关不掉）。
- **整个块（含展开的正文）都包在同一个 `Pressable` 里**，点哪里都能收起；展开的 `Text`
  去掉 `selectable`，否则长按选择会和点击打架。
- 展开时停掉流光（`useShimmer(growing && !open)`）。

**补充**：
- 思考行前面用**思考图标**（Lucide `Brain`，跟 Paseo 原生 thinking 行一致），不是竖线。
- 流光的半周期从 650ms 放慢到 1100ms——650ms 看起来像"闪烁"，用户要求慢一点。
- 工具行的标签文字从 `foreground` 改成 `foregroundMuted`（用户反馈"太白"）。
- `toolCallData` 多一个 `code` 标志：`read/write/edit/search` 的正文是源码，展开时套一层
  柔和代码底（`rgba(127,127,127,0.10)`，无边框）；`shell/fetch/sub_agent/...` 的正文不是
  源码，保持普通文本。

**判定标准**：
- `npx tsc --noEmit` 干净（`tsconfig.json` 已加 `jsx`，并 `include **/*.tsx`）。
- `harness/tool-call-check.cjs`（纯逻辑，离线）：图标映射、单行摘要、diff 每行前缀、
  截断、状态回退。运行方式见文件头。
- 宿主编译器 `compilePlugin({client, server})` 能产出 client bundle。
- 真实 Paseo web UI 截图：思考行单行、工具行原生图标 + 单行、展开无外框且 diff 有
  红/绿底 + 色条、运行中行有脉冲。

**注意**：`paseo plugin reload` 会重启插件进程，连带杀掉它派生的 `dsh` 子进程——也就是
正在改代码的那个 agent。改完客户端代码要重载时，先把要做的验证/文档做完，或用一个
一次性 heartbeat 在重载后把自己唤醒。

### 31. 工具行的标题用 DSH 的 `description`，不是原始命令

**症状**：DSH 原版界面里命令行显示的是 `运行命令 · List DSH checkout root` 这种**人写的描述**，
Paseo 这边却是 `命令 pwd; ls -d /home/yywl/.dsh 2>/dev/null && ...` 一长串原始命令。

**根因**：`dsh-tool-bash` 的入参里**必带 `description`**（`validateBashArgs` 里
`args.description.trim().length === 0` 直接抛错），DSH 的 UI 拿它当标题；插件这边把
`input.description` 丢掉了，客户端只能拿 `detail.command` 当摘要。

**坑：协议里没有它的位置。** Paseo 的 `shell` detail 只有 `command / cwd / output / exitCode`，
而仓库硬性约束是"不要自造协议形状"。所以描述走 **item 的 `metadata`**——那是 provider 自己的
袋子（`ProviderToolCallItem.metadata?: Record<string, JsonValue>`），daemon 的
`mapTimelineItem` 对 tool_call 返回 `withoutIdentity`，`metadata` 会原样带到客户端。

**实现**：`server/timeline.ts` 的 `toolMetadata(input)` 在 `tool/call` 和 `tool/result` 两条
路径上挂 `{ description }`；`client/tool-call-data.ts` 读 `item.metadata.description`，产出

- `summary` = 描述（没有描述时退回命令/路径/查询）；
- `headline` = 工具自己的主体（命令），**仅在两者不同时非空**，展开时显示在输出上方，避免
  重复折叠态已经给过的信息。

DSH 原版那行还有 `● yywl`（执行者）和"复制"按钮，我们没有跟进——那是它的宿主 chrome，
不是这行信息本身。

**验证**：`harness/timeline-check.cjs`（描述确实挂在 metadata 上、结果行仍带着、没描述就不加）、
`harness/tool-call-check.cjs`（描述 → `summary`，命令 → `headline`，空描述忽略）。

### 32. 扫光：web 复用 DSH 的 CSS，原生用等价几何重建

**要求**：用户要的是 **DSH web 那种扫光**（`运行命令 · List DSH checkout root` 上有一道亮光
扫过），而且**必须在 App（iOS）上跑**，不是网页版。

**DSH 的实现**（`@deepseek-ai/dsh-client-ui-primitives` 的 `TextShimmer.module.css`，原样抄下来）：

```
.sweep      { mask-image: linear-gradient(105deg, transparent 0%, black 40% 60%, transparent 100%);
              transform: translateX(-100%); animation: dsh-row-shimmer-sweep ... }
.highlight  { transform: translateX(100%);  animation: dsh-row-shimmer-highlight ... }
@keyframes dsh-row-shimmer-sweep     { 0%{translateX(-100%)} 66.6667%,100%{translateX(100%)} }
@keyframes dsh-row-shimmer-highlight { 0%{translateX(100%)}  66.6667%,100%{translateX(-100%)} }
/* 1.5s / delay .3s / steps(48,end) / infinite；配色 color-mix(neutral-00 45%, transparent) */
```

关键不是"渐变背景"，而是**两层反向位移**：`.sweep` 往右、`.highlight` 往左，两者相加为 0，
所以**副本字形一动不动，动的只有 mask**。早期那版"平移一个纯色块"之所以难看，就是缺了这两点。

**web**：`client/shimmer-css.ts` 把上面那段 CSS **原样**注入（类名换成 `[data-testid]` 选择器，
RN 会内联设置的地方补 `!important`），`client/text-shimmer.tsx` 按 DSH 的 DOM 结构渲染。
唯一的改动是 DSH 用 `::after { content: attr(data-shimmer-text) }` 把装饰副本挡在无障碍树外，
我们直接渲染它并标 `aria-hidden`。

**原生（App）**：RN 既没有 `mask-image` 也没有渐变，所以 `client/sweep-native.tsx` **重建同样的
几何**：把 mask 切成 `SWEEP_BANDS = 8` 条等宽带，每条的 alpha 取 DSH 那条渐变曲线在带中点的
采样（`client/sweep-geometry.ts` 的 `sweepProfile`）；每条带是一个 `overflow: hidden` 的裁剪
窗口，整排一起 `translateX`（= DSH 的 `.sweep`），窗口里的副本**反向平移同样的距离**
（= DSH 的 `.highlight`），于是副本仍然不动。一个 `Animated.Value` 同时驱动两者，
`useNativeDriver` 跑 UI 线程，扫动期间不产生任何 React 重渲染。

**实测**（在 web 上用 `localStorage.setItem("dsh-sweep","native")` 强制走原生那条路径，
直接读 DOM，因为两条实现不共享任何原语）：

```
bands 8, bandW 97.5 (= 780/8), 8 条带 left 依次相差 97.5（无缝平铺）
alpha [0.156, 0.469, 0.781, 1, 1, 0.781, 0.469, 0.156]   ← 正是 sweepProfile((i+0.5)/8)
counterX 全部 = -sweepX                                    ← 副本字形完全不动
transform 序列 780 → -468 → -131 → 207 → 572 → 780 → 780   ← 1.5s 一个周期，末段保持
```

**验证**：`harness/sweep-check.cjs` 25/25（mask 曲线的四个停点、阶梯对称性与平铺、1.5s/0.3s/
2-3 行程、`steps(48)` 量化）。**iOS 上无法本地运行**（这台机器是 Linux，没有模拟器），
原生那条路径只能靠上面的结构断言 + 用户在真机上看；两条路径的几何常量是同一份，
所以 web 上量到的数字就是原生用的数字。

### 33. 展开态的三个代表性问题

**一、展开后中文标题会消失**

第 31 条把折叠态的摘要换成了模型写的 `description`（常常是中文）。但更早那条"展开后不要重复
已经显示过的内容"的规则还写着 `!expanded &&`，于是**一展开，整行就没有名字了**——用户原话
"有些时候会有命令展开的时候不要隐藏中文标题"。

修法：摘要**始终渲染**，只是折叠时 `numberOfLines={1}`、展开时放宽到 4 行（换行而不是截断，
没有 description 的长命令因此也能读全）。展开块里的 `headline` 是**命令本身**，头部是**描述**，
两者不同，所以不违反"不重复"。

**二、只有 read/write/search 有代码格式**

`code` 标志只在这几类工具上为 true，于是 shell 的输出是裸文本，视觉上和编辑行的 diff 完全
不是一个体系。修法：**所有展开内容都进同一个 `styles.codeBlock`**（浅灰底 + 圆角，没有硬边框
——那个是被用户否掉的），里面先一行 headline（工具主体）再是 body（输出/diff）。原来按
`code`/`diff` 分支的三套渲染合并成两套（diff 逐行着色 / 其余代码文本）。

**三、MCP 工具行"展不开"**

MCP 调用的详情是 `{type:"unknown", input, output}`（`toolDetail` 的 default 分支）。而
`toolCallData` 的 default 分支只把 `input` 塞进了 `primary`，**`output` 从来没进 `body`**：
折叠态显示入参、展开后还是只显示入参，看起来就是"点了没反应"。

修法：`type === "unknown"` 时

- `body` = 美化缩进后的 `output`（对象用 `JSON.stringify(v, null, 2)`，一行 JSON 在代码块里
  没法读）；
- `headline` = 美化后的 `input`；
- `summary` = **紧凑单行**的 `input` —— 折叠态只有一行，美化后的首行只会是 `{`，等于没有标题；
- `code = true`；
- 空入参（`{}`）不再当标题，那一行只显示工具名。

**实测**（真实 Paseo web UI，点击后读 DOM）：MCP 行展开前 `h:30`、文本
`mcp__paseo__list_workspaces|{}`，展开后 `h:787`、文本里出现 `workspaces_count=4` 与缩进过的
`workspaces` 数组；命令行展开后文本是 `命令|展开 MCP 行并前后对比|cd /tmp && cat > ...`
（**中文描述还在**，后接命令与输出），且行内命中一个背景为 `rgba(127, 127, 127, 0.1)` 的代码表面。

**验证**：`harness/tool-call-check.cjs` 83/83。除了 unknown 分支（紧凑标题 / 精确的美化 body /
美化 headline / 字符串结果原样 / 空入参不出现在标题 / running 时无 body），还补了三条本轮
审核揪出来的用例：**带 description 的 MCP 调用 headline 仍必须美化**（否则退回几千字符的一行）、
**`/命令` 的 `text` 必须进 body**（否则输出永远不显示）、**不可序列化入参报占位串而不是静默消失**。

**审核后的补充修正**（同一轮内）：

- `hasDetail` 上提到 `ToolCallData`：展开块只在**真有内容**时画代码表面。之前 `canExpand` 只看
  summary，于是 `todo_write`/`ask_user_question`/`/命令` 这类"只有标题"的行点开会得到一条
  约 10px 高的空灰条——这是本轮直接引入的回归。同时它成了可离线断言的数据层不变量。
- 展开态**去掉 4 行上限**（改回不限行）：没有 description 的长命令只存在于 `summary`，
  4 行上限会让它永远读不全，和本节上面那句承诺不符。
- `stringifyValue` 对 `JSON.stringify` 返回 `undefined`（函数/Symbol）与抛错（BigInt/循环引用）
  都返回 `<unserializable>`，不再返回 `""` 让 payload 静默消失，也不再让 `truncate(undefined)` 抛错。
- `emptyInput` 收窄为"非数组的空对象"。
- 块内 headline 加 `selectable`（那是最值得复制的一行）；删掉已成死代码的 `styles.bodyText`；
  修正 `code` 字段的注释（现在所有展开都走代码表面，渲染层不再读它）。

### 34. DSH 原生工具被当成 MCP 渲染；展开时标题被挤成一列

**一、原生工具和 MCP 工具长得一模一样**

服务端 `toolDetail` 只显式处理 13 个名字（`bash`/`pwsh`/`read`/`write`/`edit`/`grep`/`glob`/
`web_search`/`web_fetch`/`todo_write`/`ask_user_question`/`exit_plan_mode`/`subagent`），其余全部
落到 `default` → `{type:"unknown"}`。于是 **DSH 自己的工具**（`get_goal`/`update_goal`/
`schedule_*`/`job_*`/`terminal_*`/`session_*`/`cordis_*`…）和**真正的 MCP 调用**走同一条渲染
路径：通用扳手 + 原始工具名 + 原始 JSON，用户根本分不出哪个是哪个。

DSH 的客户端里有一张权威表（`dsh-client-ui-tool` 的 `tool.title.*` 映射，共 51 个工具），按它
给原生工具补了中文名与图标（goal 家族 → `Target`，schedule → `CalendarClock`，job → `Timer`，
terminal → `SquareTerminal`，session → `History`，cordis → `Plug`…）。名字映射**只在 detail 是
`unknown` 时生效**，typed detail（shell/read/edit…）本来就有更准的图标；MCP 调用不在这张表里，
所以仍然是原始名字 + 扳手 —— 这正是我们要的区分。

**二、展开时标题被挤成一条窄列**

头部是 flex row：`[图标][标签][摘要]`。标签很长（`mcp__paseo__create_heartbeat`）而摘要又是
一长串 JSON 时，摘要只分到很窄的宽度，于是**一个字符一行地竖着排下来**，看起来像坏了
（用户："点开会并行显示"）。

**第一版修法是错的**：把展开时的文本容器从 row 换成 column（标签一行、摘要另起一行）。这样确实
不再竖排，但**有 description 的行也被拆成两行**——中文标题离开了它命名的那个标签，用户立刻
指出来："中文的标题也被换到第二行了"。

**真正的根因是展开时取消了 `numberOfLines` 上限**：宽度窄 + 不限行 = 竖排。所以：

- 头部**永远一行**（`numberOfLines={1}` 恒定），撤回 column，标题回到标签旁边；
- 展开时只在**摘要不是标题**（没有 description）且**块里已经有同样内容**时把它省掉，避免
  紧凑 JSON 与块里的美化 JSON 重复。判据是数据字段 `titled`，可离线断言；
- 为了让"省掉摘要"不丢信息，**块一律以工具主体开头**：shell 的 `detailHeadline` 设成命令
  （以前只有 `unknown` 有），于是多行命令在块里读得全；有 description 时块也仍然以命令开头
  （headline 优先取 `detailHeadline`，不再被 description 顶掉——顺带修掉了审核第 2 条）。

**验证**：`harness/tool-call-check.cjs` 89/89（新增 18 条：原生工具的标签/图标、typed detail 不被
名字映射覆盖、`titled` 的两种取值、"块已承载时标题是主体"、shell 的块一律以命令开头；
MCP 部分见第 36 条）。

### 35. 思考行的折叠预览：以 DSH 为准

用户："这个'已思考'的显示好像是用的结尾的，你看一下 DSH 本身思考结束以后显示的是什么，以 dsh 为准。"

DSH 的 `ReasoningRow`（`dsh-client-ui-chat`）里就一行：

```js
const summaryText = running ? latestCompletedParagraphFirstLine(text) : firstLine(text);
const summary = summaryText.replaceAll("**", "");
```

- **结束后**：`firstLine(text)` —— **第一行**。我们以前显示最后一行，做反了。
- **运行中**：`latestCompletedParagraphFirstLine(text)` —— 取**最后一个"首行已被换行终结"的段落**
  的首行，所以预览按段落推进，不会每个 token 抖一次。注意它取的是最后一个满足条件的段落，
  不一定是最末段落（末段首行还没换行就不算）。
- **标签恒为 `思考`**（`message.think`）。DSH 里那个 `已思考`（`message.turnProcess.thoughtForAWhile`）
  属于"整轮过程"折叠摘要，跟这一行不是同一个元素，所以这里不再在结束时改成 `已思考`。
- 两个函数**逐字移植**到 `client/thinking-text.ts`（纯函数），`**` 也照 DSH 剥掉。

**验证**：`harness/thinking-check.cjs` 17/17 —— 首行取值、空串/无换行/以换行开头、段落的四种
边界（未终结的末段不算、空行与缩进空行分段、`\r\n`）、`**` 剥离，以及一条直接钉住回归的断言
"结束后返回第一行、且绝不返回尾行"。

### 36. Paseo 自己的 MCP 工具也配中文名

第 34 条给 DSH 原生工具补了名字/图标，但 MCP 那半边还是原始线名：一行读作
`mcp__paseo__delete_heartbeat {"id":"…"}` —— 用户能看到的只有线名，而线名恰恰是它身上
唯一没法用的信息。用户："这些能不能改成显示成中文的？"

**Paseo 的 MCP 工具自带英文 `title`**，在它自己的注册表里（`server/agent/tools/paseo-tools.js`
与 `server/browser-tools/tools.js`，共 **58 个**：40 个主工具 + 18 个 browser 工具），例如
`registerTool("delete_heartbeat", { title: "Delete heartbeat", … })`。按这张表逐个译成中文，
并配图标（heartbeat → `HeartPulse`，workspace → `FolderOpen`，schedule → `CalendarClock`，
browser → `Globe`…）。

**兜底**：认不出的名字仍然显示线名（`mcp__paseo__not_a_tool` 就还是它自己，别的 server 的
`mcp__github__create_issue` 也一样）—— 上游新增工具时会以线名出现，而不是消失。

**验证**：`harness/tool-call-check.cjs` 89/89，其中 MCP 部分断言了 `delete_heartbeat` →
`删除心跳` + `HeartPulse`、browser 工具、以及两条兜底（未知 Paseo 工具、别的 server）。

### 37. 子会话标题：为什么会出现「加载中…」

用户在 App 的 **Subagent 面板**里看到同一个 subagent 出现两条：一条 `加载中…`、一条真标题，
而且"打开加载中的是可以正常显示的"。

**机制**（Paseo 侧）：面板由 daemon 的 `ProviderSubagentStore` 喂（`agent.provider_subagents.list`），
条目按 `(parentAgentId, event.id)` 记账，`title` 是 **sticky** 的（`agent-manager.js` /
`provider-subagents/store.js`）。**标题为空时 App 就渲染成 `加载中…`**（这个字符串在 App 自己
的包里，Paseo 的 daemon dist 里搜不到）。

**机制**（我们侧）：子会话的标题只能随**那一条** `session.opened` 发出——`DshChildSession` 的
`configState()` 是直接抛错的（"subagent sessions have no configuration"），子会话**没有**配置
通道，所以**发出去时没有标题，就永远不会有**。

**两个确凿的洞**（都在代码里）：

1. `dsh-bridge/lib/server.js` 的 `CHILD_BUFFER_CAP = 500`：一个子会话在被压住 500 帧后仍拿不到
   label，就**无标题打开**。500 帧在一个回合内是很容易到的（子会话的每种事件都算一帧）。
2. 更致命的是**晚到的 label 会被丢掉**：桥的 `openChild()` 有 `if (child.opened) return`，
   插件的 `#openChildNow()` 对已存在的子会话直接 early return，两处都只在"尚未打开"时采纳
   label。于是**一旦无标题打开，就永久是 `加载中…`**。

**修法**：插件的 `#onChildOpened()` 现在把**没有 label 的通知先压住**（复用已有的
`#pendingOpened` / `#bufferChildEvent` / `#flushPendingChildren` 机制），并在这个子会话自己的
`subagent/descriptor` 事件（持久 label 就在那里）到达时补上 label 再打开——所以那条
`session.opened` 带的是真标题。兜底仍在：某个子会话压了 `CHILD_LABEL_WAIT_EVENTS = 40` 个事件
还没等到 label，就按老办法无标题打开，绝不丢输出。

**第二个来源：重放路径**（同一症状的另一半）。`replaySubagents()` 用的是持久 catalog 的
`row.label`，而 **one-shot 子会话在 catalog 里根本没有 label** —— DSH 只对 `continuable` 强制要求
label（`catalogFact()` 的校验：`mode === "continuable" && typeof label !== "string"` 即非法）。
所以每次重开session，重放都会把 one-shot 子会话**无标题**打开一遍。修法：**先读该子会话自己的
历史**，从它的 `subagent/descriptor` 里取 label，再打开（顺序调换，代价只是本来就要发的
`paseo/history`）。

**还有一个不是我们能修的**：每次 `paseo plugin reload` 之后，插件内存清零，重开 session 时会把
每个子会话**重新播报**一遍 `session.opened`，而 App 的 Subagent 面板**不会**把上一次的条目去掉，
于是列表随着重载次数线性增长（用户观察到 4 → 14）。面板里有「归档已完成的 subagent」可以清。
要根治得让 daemon 按 provider session id 去重，那不在本仓库范围内。

**验证**：`harness/subagent-check.cjs` **41/41**。假桥新增 `label-late` 模式（先发无 label 的
`session.child-opened`，再由 `subagent/descriptor` 补 label），断言三条：**标题等于 `Late L`**、
**只打开一次**、**压住的输出仍然到齐**；replay 场景里 child-B 也改成真实的 one-shot 形状
（catalog 无 label、label 只在它自己的 descriptor 里），断言重放后标题仍是 `Nested B`。
原有的 37 条（父子次序、held 子树、replay、error、steer）全部保持通过。实机侧另有 `harness/subagent-live.mjs`（4/4，一次 `child-opened`、
label 正确、子会话有自己的时间线）。

### 38. 归档：能力没声明 = 用户的操作被静默吞掉

现象链：在 App 里归档一个会话/子代理 → 界面报「归档成功」→ 重启 Paseo 后它**还在**；在 DSH
里看也**没有**归档。三个独立缺陷叠在一起：

1. **能力没声明**。`PROVIDER_CAPABILITIES` 里有 `session.archive`/`session.unarchive`，但插件的
   `CAPABILITIES` 没声明它们 → Paseo 把归档当**本地标记**处理 → 请求根本不会发给我们。这是
   本仓库反复出现的那一类错误：**声明的能力决定 UI 长什么样，也决定对方的意图能不能到达我们**。
2. **子会话不可寻址**。Paseo 的归档请求按 **persistence 句柄**寻址（它的 opencode 适配器
   `setNativeSessionArchived(handle, archivedAt)` 同样按 provider 原生句柄归档），而子会话是
   `restoration:"parent"`、**不带句柄** → 「归档子代理」永远到不了我们这里。
3. **重放复活**。`replaySubagents()` 每次 `session.open` 都把每个持久子会话重新播报一遍
   `session.opened`；Paseo 会丢掉 provider 不再报告的条目，而我们照报不误 → 归档被撤销。

**语义参照**：DSH 的归档是一等概念（`ctx.workspaceRegistry.archiveSession(sessionId,
{stopActivity})` / `unarchiveSession(sessionId)` / `archivedSessionIds`，活跃会话必须
`stopActivity`，否则 `WorkspaceActiveSessionError`）；Paseo 的语义是**照抄 provider**，不自己
维护状态。所以正确做法是把 Paseo 的归档**落到 DSH 的原生归档**，而不是发明一个本地标志。

**修法**：

- 能力清单加 `session.archive` / `session.unarchive`；桥新增 `paseo/archive` /
  `paseo/unarchive`，经 `ctx.get('workspaceRegistry')` 转调 DSH；失败返回 `available:false`
  + 原因，**绝不把没做的事报成成功**。
- 子会话 `open()` 带上 `persistence: {version:1, data:{sessionId:<nativeId>}}`，从此可寻址。
- 子会话在 DSH 里跑在**根的进程**里、自己没有进程，而 DSH 的 registry 是**进程全局**的 →
  `archiveDshSession(dshSessionId, archived)` 由任意一个打开的根代为转发。
- `paseo/subagents` 附带每个子会话的 DSH 归档状态（读 `archivedSessionIds`），
  `replaySubagents()` 跳过已归档的 → 归档重启后依然成立。

**导入列表**：Paseo 的 `ProviderSessionSummary`（persistence/cwd/title/description/updatedAt）
**没有** archived 字段，所以"告诉 Paseo 某个会话已归档"这条路不存在。唯一的杠杆是**不把它列进
导入列表**——这也正是 DSH 自己的默认视图（"隐藏已归档"）。桥的 `listSessions` 因此按
`archivedSessionIds` 过滤；读不到 registry 时**不过滤**，而不是静默给出空列表。

**验证**：`harness/subagent-check.cjs` **42/42**（假桥的 replay 列表加了一条 `archived: true`
的子会话，断言"已归档的子会话不被重放播报"）；`tsc --noEmit` 干净；其余离线套件
89/29/19/25/17 全绿；内嵌桥按硬性约束重新生成。

### 39. 归档（续）：第 38 条只验证了假桥，真机上两个洞都没堵上

第 38 条交付后用户在真机复测：在 App 里归档 → 界面**报成功** → 打开还在；再次点「取消归档」
则直接失败。daemon 日志把两个洞都摊开了：

```
Archiving agent 8b6d26de-...
Failed to archive native session (best-effort)          # 归档：Paseo 吞掉了失败
...
cannot unarchive 6d0a20ce-...: no DSH session is open   # 取消归档：我们自己的报错
```

1. **`paseo` profile 根本没有 workspace registry**。`@deepseek-ai/dsh-workspace`（提供
   `ctx.get('workspaceRegistry')`）只在 `dsh-web-app` bundle 里挂载；`dsh-base` 与桥的
   bundle 都没有。于是 `applyArchived()` 每次都返回 `this DSH runtime composes no workspace
   registry`，`listSessions` 的归档过滤和 `replaySubagents` 的归档跳过也全都读不到状态。
   第 38 条的"归档链路生效"只被**假桥**证明过——假桥凭空应答 `available:true`，把真实运行
   时缺服务这件事整个掩盖了。教训升级：**假桥不是协议层**，凡是"某能力是否真的存在"必须
   在真 `dsh --profile paseo` 上跑一次。
2. **归档一个没有打开的会话被硬拒**。provider 的 `#setArchived()` 只在 `#sessions`（已打开的
   Paseo 会话）里找一个进程代为转发；而 Paseo 归档一个会话时会**先把这个会话的 DSH 进程
   关掉**，所以"归档会话自身"这次操作必然走到"没有进程可借"，抛出 `no DSH session is open`。
   取消归档同理。
3. **成功路径不发回执**。`session.archive`/`session.unarchive` 成功时既不 `request.completed`
   也不 `request.failed`；Paseo 的 `runtime.archive()` 等的是 `complete()` 的回复，所以真修好
   服务之后，点击会一直悬着。之前从未走到过成功路径，这个洞才没暴露。

**修法**：

- 桥的 bundle patch 插入 `@deepseek-ai/dsh-workspace`（与 web bundle 同一行）。DSH 的归档集
  于是成为真正的持久状态，导入过滤与子会话重放跳过也真正生效。
- 没有已打开会话时，用**一次性 probe 进程**执行（与 catalog/sessions 探测同一套
  `probeProcess`）。DSH 的归档集在 `$DSH_HOME/storages` 的全局域，`unarchiveSession` 不做
  存在性检查，`archiveSession` 查的是全局 session persistence，所以 probe 在哪个 cwd 都能
  代劳；被 registry 拒绝（未知会话、活跃会话、缺服务）依旧抛错，绝不报假成功。
- 成功路径补 `request.completed`。

**验证**：真机 `dsh --profile paseo`（补丁已写进 profile，**不带** `--patch`）跑归档往返：
`archive -> {available:true}`，此时导入列表不含该会话；`unarchive -> {available:true}`，列表
恢复。从无关 cwd（`/tmp`）起进程同样成立。`harness/subagent-check.cjs` **48/48**（新增 6 条：
句柄可寻址、有会话时归档/取消归档都有回执、无会话时经 probe 仍能往返、未知 id 必须响亮失败）；
`mcp-injection-check` 8/8、`steer-check` 17/17、`assistant-stream-check` 7/7；`tsc --noEmit`
干净；内嵌桥已重生成。

#### 39b. 同一个症状的第三个洞：桥只在 `initialize` 上等 profile 装载

上面三条修完、插件重载之后，用户复测**仍然**报 `this DSH runtime composes no workspace
registry`。真机二分复现：只要先发 `initialize` 再发 `paseo/archive` 就成功，把
`paseo/archive` 作为**第一帧**发就 100% 失败。

根因在桥的入口 `transport.onRequest`：它原本只对 `initialize` 做
`await ctx.get('loader')?.await()`，其它方法直接进 `server.handleRequest`。而插件的
catalog/sessions/archive 探测是 `initializeRoute: false` 起的——**刻意不发 `initialize`**
（发了会创建 agent），于是 `paseo/archive` 在 `@deepseek-ai/dsh-workspace` 挂载完成之前
就被处理，`ctx.get('workspaceRegistry')` 自然是 `undefined`。

这也解释了为什么第 38/39 条的其它探测"看起来正常"：`paseo/sessions` 读不到 registry 时
按设计**不过滤**（静默降级成"没归档"），`paseo/catalog` 根本不碰 registry，所以只有归档
这条把竞态暴露成硬失败。

**修法**：`transport.onRequest` 对**每个**方法都先 `await ctx.get('loader')?.await()`
（幂等），任何请求都不再从"半装好的 runtime"里取服务。

**验证**：新增 `harness/archive-registry-check.mjs`——真 `dsh --profile <p>`、**第一帧**
就是 `paseo/archive`（不存在的 id，应当被 registry 拒绝并报出该 id，而不是报
`composes no workspace registry`），再发一次 `paseo/unarchive`（不存在的 id 是幂等 no-op，
返回 `available:true` 且不写任何状态）。修复前 0/2，修复后 2/2。

---

## 已知限制（未修，有意为之）

| 项 | 说明 |
|----|------|
| `assistant/attempt` 被丢弃 | 该事件承载失败/重试/取消的尝试，所以**重试的持久记录在界面上不可见**。但流式上线后，一次"已经流出一部分才失败重试"的 attempt，其已发出的前缀会留在时间线上（Paseo 时间线 append-only，无法撤回，见第 25 条）。`AssistantStreamRecord` 没有错误变体，无法可靠区分"失败重试"和"用户主动取消"，所以持久记录仍不加，乱加会在每次取消时刷噪音。 |
| 时间线只映射 13 种会话事件里的 4 种 | 其余多数是有意丢弃：`developer/message`、`system/message` 是系统提示，`request/header`、`request/context` 是内部记账。流式另走桥自有的瞬时类型 `paseo/assistant-delta`，不进会话日志。 |
| 可续接子代理二次运行的状态不回到 running | Paseo 0.11.2 的 provider 子通道忽略子会话的 `session.turn started`、`session.usage`、`session.permission`。子卡首次打开即为 running，终态（completed/failed）仍会更新，但再次运行的 started 不会恢复运行中状态。需 Paseo 核心补丁，本仓库不改全局包。 |
| 子代理审批不在 Paseo 出现 | 同上：子会话的 permission 事件被宿主忽略。桥只把根会话的问题转发给 Paseo，子会话问题保留 DSH 自身的子代理审批语义，避免挂起或误归属父会话。 |
| 子代理运行中状态/用量/审批需 Paseo 核心补丁 | 精确方案：`@getpaseo/server` 的 `agent/plugin-provider.js` `acceptChildEvent`（本机 0.11.2 行 1217-1248）需额外消费子 `session.turn started`（恢复 running）、`session.usage`（子用量）、`session.permission`（子审批卡），并把子 permission 经会话 id 路由到子代理视图。本仓库不改全局包；插件侧已按正确子身份发出这些事件，补丁落地即生效。 |

## 关于"哪条路由能用"

这份记录里刻意不提任何具体的 provider、模型或端点——**你的路由和模型完全由你的
profile 决定**。同一个缺陷在不同人那里会表现成不一样的症状，所以照抄别人的路由表
没有意义，用 `npx paseo-dsh probe` 测自己的才是正路。
